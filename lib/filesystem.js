/**
 * Virtual filesystem backed by in-memory Map.
 * Provides host imports for Win32 file I/O APIs.
 * Files are stored as Uint8Array in memory. Directory entries tracked separately.
 */

class VirtualFS {
  constructor() {
    this.files = new Map();    // normalized path → { data: Uint8Array, attrs: number }
    this.dirs = new Set();     // normalized paths of directories
    this.handles = new Map();  // handle → { path, pos, access, data (ref to files entry) }
    this.findHandles = new Map(); // handle → { pattern, results[], index }
    this.readOnlyDrives = new Set(); // lower-case drive letters backed by immutable media
    this._nextHandle = 0xF0000001;
    // The Win16-compatible _l* APIs expose a 16-bit HFILE. Keep those handles
    // separate from the high-valued Win32/VFS handle namespace: Win9x CRTs
    // use values above 0xffff for their own heap-backed descriptor objects.
    this._nextLegacyHandle = 4;
    // MSVCRT _findfirst treats a successful Win32 search handle as a signed
    // integer and rejects negative values before checking INVALID_HANDLE_VALUE.
    // Keep this namespace positive while remaining distinct from file handles.
    this._nextFindHandle = 0x6A000001;
    this.cwd = 'C:\\';
    this._tempCounter = 1;

    // Pre-create standard directories
    this.dirs.add('c:');
    this.dirs.add('c:\\');
    this.dirs.add('c:\\windows');
    this.dirs.add('c:\\windows\\system');
    this.dirs.add('c:\\windows\\temp');
    this.dirs.add('c:\\temp');
    this.dirs.add('c:\\program files');
  }

  _normPath(p) {
    let n = p.toLowerCase().replace(/\//g, '\\');
    // Collapse . and .. components, skip empty parts (from double backslashes)
    const parts = n.split('\\');
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === '' && i > 0) continue; // skip empty parts (but keep drive root)
      if (part === '.') continue;
      if (part === '..' && out.length > 1) { out.pop(); continue; }
      out.push(part);
    }
    n = out.join('\\');
    if (n.length > 3 && n.endsWith('\\')) n = n.slice(0, -1);
    return n;
  }

  _resolvePath(p) {
    let resolved = p;
    // If relative (no drive letter), prepend CWD
    if (!/^[a-zA-Z]:/.test(resolved) && !resolved.startsWith('\\\\')) {
      if (resolved.startsWith('\\')) {
        // Root-relative path (\foo) — prepend drive letter from CWD
        resolved = this.cwd.slice(0, 2) + resolved;
      } else {
        resolved = this.cwd.replace(/\\$/, '') + '\\' + resolved;
      }
    }
    return this._normPath(resolved);
  }

  _parentDir(p) {
    // Strip trailing backslash before computing parent
    let s = (p.length > 3 && p.endsWith('\\')) ? p.slice(0, -1) : p;
    const idx = s.lastIndexOf('\\');
    if (idx <= 2) return s.slice(0, 3); // root
    return s.slice(0, idx);
  }

  _fileName(p) {
    let s = (p.length > 3 && p.endsWith('\\')) ? p.slice(0, -1) : p;
    const idx = s.lastIndexOf('\\');
    return idx >= 0 ? s.slice(idx + 1) : s;
  }

  setDriveReadOnly(drive, readOnly = true) {
    const letter = String(drive || '').replace(/:$/, '').toLowerCase();
    if (!/^[a-z]$/.test(letter)) throw new Error(`invalid drive letter: ${drive}`);
    if (readOnly) this.readOnlyDrives.add(letter);
    else this.readOnlyDrives.delete(letter);
  }

  _isReadOnlyPath(path) {
    const norm = this._resolvePath(path);
    return norm.length >= 2 && norm[1] === ':' && this.readOnlyDrives.has(norm[0]);
  }

  createFile(path, access, creation) {
    let norm = this._resolvePath(path);
    const wantsWrite = creation !== 3 || (((access >>> 0) & 0x40000000) !== 0);
    if (wantsWrite && this._isReadOnlyPath(norm)) return 0;
    let exists = this.files.has(norm);
    // Basename fallback on OPEN_EXISTING — DX games scan drive letters looking for their
    // data CD; accept a match on filename alone if the literal path misses.
    if (!exists && creation === 3) {
      const base = this._fileName(norm);
      for (const p of this.files.keys()) {
        if (this._fileName(p) === base) { norm = p; exists = true; break; }
      }
    }
    // creation: 1=CREATE_NEW, 2=CREATE_ALWAYS, 3=OPEN_EXISTING, 4=OPEN_ALWAYS, 5=TRUNCATE_EXISTING
    switch (creation) {
      case 1: // CREATE_NEW
        if (exists) return 0; // fail, ERROR_FILE_EXISTS
        this.files.set(norm, { data: new Uint8Array(0), attrs: 0x80 }); // FILE_ATTRIBUTE_NORMAL
        break;
      case 2: // CREATE_ALWAYS
        this.files.set(norm, { data: new Uint8Array(0), attrs: 0x80 });
        break;
      case 3: // OPEN_EXISTING
        if (!exists) return 0;
        break;
      case 4: // OPEN_ALWAYS
        if (!exists) this.files.set(norm, { data: new Uint8Array(0), attrs: 0x80 });
        break;
      case 5: // TRUNCATE_EXISTING
        if (!exists) return 0;
        this.files.get(norm).data = new Uint8Array(0);
        break;
      default:
        return 0;
    }
    const h = this._nextHandle;
    this._nextHandle = ((this._nextHandle + 1) & 0x7FFFFFFF) || 0xF0000001;  // wraparound
    this.handles.set(h, { path: norm, pos: 0, access });
    // Ensure parent dir exists
    this.dirs.add(this._parentDir(norm));
    return h;
  }

  createLegacyFile(path, access, creation) {
    const internal = this.createFile(path, access, creation);
    if (!internal) return 0;

    let h = this._nextLegacyHandle;
    while (h < 0xFFFF && this.handles.has(h)) h++;
    if (h >= 0xFFFF) {
      this.handles.delete(internal >>> 0);
      return 0;
    }

    const state = this.handles.get(internal >>> 0);
    this.handles.delete(internal >>> 0);
    this.handles.set(h, state);
    this._nextLegacyHandle = h + 1;
    return h;
  }

  readFile(handle, buf, nToRead) {
    handle = handle >>> 0;
    const fh = this.handles.get(handle);
    if (!fh) return { ok: false, bytesRead: 0 };
    const entry = this.files.get(fh.path);
    if (!entry) return { ok: false, bytesRead: 0 };
    const source = fh.readData || entry.data;
    const avail = Math.max(0, source.length - fh.pos);
    const toRead = Math.min(nToRead, avail);
    buf.set(source.subarray(fh.pos, fh.pos + toRead));
    fh.pos += toRead;
    return { ok: true, bytesRead: toRead };
  }

  writeFile(handle, data, nToWrite) {
    handle = handle >>> 0;
    const fh = this.handles.get(handle);
    if (!fh) return { ok: false, bytesWritten: 0 };
    if (this._isReadOnlyPath(fh.path)) return { ok: false, bytesWritten: 0 };
    let entry = this.files.get(fh.path);
    if (!entry) {
      entry = { data: new Uint8Array(0), attrs: 0x80 };
      this.files.set(fh.path, entry);
    }
    const newEnd = fh.pos + nToWrite;
    if (newEnd > entry.data.length) {
      // Grow file
      const grown = new Uint8Array(newEnd);
      grown.set(entry.data);
      entry.data = grown;
    }
    entry.data.set(data.subarray(0, nToWrite), fh.pos);
    fh.pos += nToWrite;
    return { ok: true, bytesWritten: nToWrite };
  }

  setFilePointer(handle, distance, moveMethod) {
    handle = handle >>> 0;
    const fh = this.handles.get(handle);
    if (!fh) return 0xFFFFFFFF; // INVALID_SET_FILE_POINTER
    const entry = this.files.get(fh.path);
    const size = fh.readData ? fh.readData.length : (entry ? entry.data.length : 0);
    let newPos;
    switch (moveMethod) {
      case 0: newPos = distance; break;       // FILE_BEGIN
      case 1: newPos = fh.pos + distance; break; // FILE_CURRENT
      case 2: newPos = size + distance; break;    // FILE_END
      default: return 0xFFFFFFFF;
    }
    if (newPos < 0) newPos = 0;
    fh.pos = newPos;
    return newPos;
  }

  setEndOfFile(handle) {
    handle = handle >>> 0;
    const fh = this.handles.get(handle);
    if (!fh || this._isReadOnlyPath(fh.path)) return false;
    const entry = this.files.get(fh.path);
    if (!entry) return false;
    const newSize = Math.max(0, fh.pos);
    if (newSize === entry.data.length) return true;
    const resized = new Uint8Array(newSize);
    resized.set(entry.data.subarray(0, Math.min(entry.data.length, newSize)));
    entry.data = resized;
    return true;
  }

  getFileSize(handle) {
    handle = handle >>> 0;
    const fh = this.handles.get(handle);
    if (!fh) return 0xFFFFFFFF;
    const entry = this.files.get(fh.path);
    return fh.readData ? fh.readData.length : (entry ? entry.data.length : 0);
  }

  closeHandle(handle) {
    handle = handle >>> 0;
    if (this.handles.has(handle)) {
      // Mark closed but keep in map — other threads may still reference this handle
      // (e.g., NSIS extraction thread reads from installer EXE after main thread closes it)
      this.handles.get(handle).closed = true;
      return true;
    }
    if (this.findHandles.has(handle)) {
      this.findHandles.delete(handle);
      return true;
    }
    return true; // non-file handles (events etc) — don't fail
  }

  getFileAttributes(path) {
    const norm = this._resolvePath(path);
    if (this.dirs.has(norm)) return 0x10; // FILE_ATTRIBUTE_DIRECTORY
    const entry = this.files.get(norm);
    if (entry) return (entry.attrs || 0x80) | (this._isReadOnlyPath(norm) ? 0x01 : 0);
    return 0xFFFFFFFF; // INVALID_FILE_ATTRIBUTES
  }

  setFileAttributes(path, attrs) {
    const norm = this._resolvePath(path);
    if (this._isReadOnlyPath(norm)) return false;
    const entry = this.files.get(norm);
    if (entry) { entry.attrs = attrs; return true; }
    if (this.dirs.has(norm)) return true;
    return false;
  }

  deleteFile(path) {
    const norm = this._resolvePath(path);
    if (this._isReadOnlyPath(norm)) return false;
    return this.files.delete(norm);
  }

  createDirectory(path) {
    const norm = this._resolvePath(path);
    if (this._isReadOnlyPath(norm)) return false;
    if (this.dirs.has(norm)) return false; // already exists
    this.dirs.add(norm);
    // Ensure parent exists
    this.dirs.add(this._parentDir(norm));
    return true;
  }

  removeDirectory(path) {
    const norm = this._resolvePath(path);
    if (this._isReadOnlyPath(norm)) return false;
    return this.dirs.delete(norm);
  }

  moveFile(src, dst) {
    const normSrc = this._resolvePath(src);
    const normDst = this._resolvePath(dst);
    if (this._isReadOnlyPath(normSrc) || this._isReadOnlyPath(normDst)) return false;
    const entry = this.files.get(normSrc);
    if (!entry) return false;
    this.files.set(normDst, entry);
    this.files.delete(normSrc);
    this.dirs.add(this._parentDir(normDst));
    return true;
  }

  copyFile(src, dst, failIfExists) {
    const normSrc = this._resolvePath(src);
    const normDst = this._resolvePath(dst);
    if (this._isReadOnlyPath(normDst)) return false;
    const entry = this.files.get(normSrc);
    if (!entry) return false;
    if (failIfExists && this.files.has(normDst)) return false;
    this.files.set(normDst, {
      data: new Uint8Array(entry.data),
      attrs: entry.attrs
    });
    this.dirs.add(this._parentDir(normDst));
    return true;
  }

  findFirstFile(pattern) {
    const rawPattern = String(pattern || '');
    const relativePattern =
      !/^[a-zA-Z]:/.test(rawPattern) &&
      !rawPattern.startsWith('\\\\') &&
      !rawPattern.startsWith('\\');
    const norm = this._resolvePath(pattern);
    const dir = this._parentDir(norm);
    const pat = this._fileName(norm);
    let results = [];

    // Convert glob pattern to regex
    const regex = new RegExp('^' + pat.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');

    const collect = (searchDir) => {
      const found = [];
      // Search files
      for (const [path, entry] of this.files) {
        if (this._parentDir(path) === searchDir && regex.test(this._fileName(path))) {
          found.push({ name: this._fileName(path), size: entry.data.length, attrs: entry.attrs || 0x80 });
        }
      }
      // Search subdirectories
      for (const d of this.dirs) {
        if (this._parentDir(d) === searchDir && d !== searchDir && regex.test(this._fileName(d))) {
          found.push({ name: this._fileName(d), size: 0, attrs: 0x10 }); // DIRECTORY
        }
      }
      return found;
    };

    results = collect(dir);

    // Directory-stripped wildcard fallback: some old demo/shareware layouts are
    // flat copies of media that the program searches via relative subfolders
    // (e.g. "campaign\\*.cpn"). If the requested relative directory does not
    // exist in the VFS, retry the same wildcard in the current directory.
    if (results.length === 0 && relativePattern && (pat.includes('*') || pat.includes('?')) && !this.dirs.has(dir)) {
      const cwdDir = /^[a-z]:\\$/i.test(this.cwd) ? this.cwd.toLowerCase() : this._normPath(this.cwd);
      results = collect(cwdDir);
    }

    // Host filesystem iteration order is platform-dependent and can produce
    // pathological Win32 enumerations like SC10, SC11, ... SC4, sc0, sc3.
    // Use a deterministic case-insensitive natural sort so game asset scans
    // (notably RCT's \Scenarios\*.SC4 walk) see a stable Windows-like order.
    if (results.length > 1) {
      results.sort((a, b) => (
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
      ));
    }

    // Basename fallback: DX games scan drive letters (D:\foo\file → Z:\foo\file) looking
    // for their data on whatever drive the CD is mounted as. If the literal path misses,
    // try matching just the filename anywhere in the VFS. Only for non-glob lookups.
    if (results.length === 0 && !pat.includes('*') && !pat.includes('?')) {
      for (const [path, entry] of this.files) {
        if (this._fileName(path) === pat) {
          results.push({ name: pat, size: entry.data.length, attrs: entry.attrs || 0x80 });
          break;
        }
      }
    }

    if (results.length === 0) return { handle: 0, entry: null };

    const h = (this._nextFindHandle++) | 0;
    this.findHandles.set(h, { results, index: 1 });
    return { handle: h, entry: results[0] };
  }

  findNextFile(handle) {
    const fh = this.findHandles.get(handle);
    if (!fh || fh.index >= fh.results.length) return null;
    return fh.results[fh.index++];
  }

  findClose(handle) {
    this.findHandles.delete(handle);
    return true;
  }

  getTempPath() {
    return 'C:\\WINDOWS\\TEMP\\';
  }

  getTempFileName(dir, prefix, unique) {
    if (unique) return dir.replace(/\\$/, '') + '\\' + (prefix || 'tmp') + unique.toString(16) + '.tmp';
    const name = dir.replace(/\\$/, '') + '\\' + (prefix || 'tmp') + (this._tempCounter++).toString(16) + '.tmp';
    // Create the file
    this.files.set(this._normPath(name), { data: new Uint8Array(0), attrs: 0x80 });
    return name;
  }

  getCurrentDirectory() {
    return this.cwd;
  }

  setCurrentDirectory(path) {
    const resolved = this._resolvePath(path);
    this.cwd = resolved.endsWith('\\') ? resolved : resolved + '\\';
    this.dirs.add(this._normPath(this.cwd));
    return true;
  }

  getFullPathName(path) {
    const resolved = this._resolvePath(path);
    // Return with original casing preserved (uppercase drive)
    return resolved.charAt(0).toUpperCase() + resolved.slice(1);
  }
}

/**
 * Create host imports for filesystem operations.
 * @param {object} ctx - context with getMemory(), exports
 * @returns {object} host import functions
 */
var _mu3 = typeof require !== 'undefined' ? require('./mem-utils') : (typeof window !== 'undefined' && window.memUtils || {});

// Shared "who called me?" hint for trace logs. Walks the stack looking for dwords
// that are preceded by a valid call opcode (E8/FF) and formats them compactly.
function _frameHint(ctx) {
  try {
    const e = ctx.exports;
    const esp = e.get_esp() >>> 0;
    const imageBase = e.get_image_base();
    const dv = new DataView(ctx.getMemory());
    const ra = dv.getUint32(esp - imageBase + 0x12000, true);
    let out = ` ra=0x${ra.toString(16)}`;
    if (_mu3.walkStackFrame) {
      const frames = _mu3.walkStackFrame(new Uint8Array(ctx.getMemory()), esp, imageBase);
      const f = _mu3.formatFrames(frames, 8);
      if (f) out += ' ' + f;
    }
    return out;
  } catch (_) { return ''; }
}

function expandRtfStylesheet(rtf) {
  if (typeof rtf !== 'string' || !rtf.startsWith('{\\rtf')) return rtf;
  const marker = '{\\stylesheet';
  const start = rtf.indexOf(marker);
  if (start < 0) return rtf;

  let depth = 0;
  let end = -1;
  for (let i = start; i < rtf.length; i++) {
    const ch = rtf[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end < 0) return rtf;

  const stylesheet = rtf.slice(start, end);
  const styles = new Map();
  const groupPattern = /\{\\s(\d+)([\s\S]*?);\}/g;
  let match;
  while ((match = groupPattern.exec(stylesheet))) {
    const number = Number(match[1]);
    const basedOn = /\\sbasedon(-?\d+)/.exec(match[2]);
    const controls = [];
    const controlPattern = /\\([a-z]+)(-?\d+)? ?/gi;
    let control;
    while ((control = controlPattern.exec(match[2]))) {
      const name = control[1].toLowerCase();
      if (name === 's' || name === 'sbasedon' || name === 'snext' || name === 'sautoupd') continue;
      controls.push(control[0].trimEnd());
    }
    styles.set(number, {
      basedOn: basedOn ? Number(basedOn[1]) : null,
      controls,
    });
  }
  if (!styles.size) return rtf;

  const resolved = new Map();
  const resolve = (number, visiting) => {
    if (resolved.has(number)) return resolved.get(number);
    const style = styles.get(number);
    if (!style || visiting.has(number)) return '';
    const next = new Set(visiting);
    next.add(number);
    const inherited = style.basedOn === null ? '' : resolve(style.basedOn, next);
    const value = inherited + style.controls.join('');
    resolved.set(number, value);
    return value;
  };

  const prefix = rtf.slice(0, start);
  const suffix = rtf.slice(end).replace(/\\s(\d+)(?=[\\\s{}])/g, (whole, number) => {
    const controls = resolve(Number(number), new Set());
    // A style application replaces the prior style's character properties.
    // Prefix with \plain so bold/italic/color from the previous paragraph do
    // not leak when the derived/base style omits an explicit "off" control.
    return controls ? whole + '\\plain' + controls : whole;
  });
  return prefix + stylesheet + suffix;
}

function createFilesystemImports(ctx) {
  // Reuse existing VFS if provided (e.g., for threads sharing the same filesystem)
  const vfs = ctx.vfs || new VirtualFS();

  // Expose vfs on ctx for external access (e.g., pre-populating files)
  ctx.vfs = vfs;

  const readStrA = (wasmAddr, maxLen = 260) => _mu3.readStrA(ctx.getMemory(), wasmAddr, maxLen);
  const readStrW = (wasmAddr, maxLen = 260) => _mu3.readStrW(ctx.getMemory(), wasmAddr, maxLen);
  const readStr = (wasmAddr, isWide) => isWide ? readStrW(wasmAddr) : readStrA(wasmAddr);

  const g2w = (guestAddr) => {
    const exports = ctx.exports;
    return exports ? _mu3.g2w(guestAddr, exports.get_image_base(), ctx.getMemory && ctx.getMemory()) : guestAddr;
  };

  // Bytes contiguous in linear memory from a guest address. Sparse
  // VirtualAlloc mappings are adjacent to the guest but their backings are
  // not, so a transfer that spans two of them has to be split — see g2wSpan.
  const g2wSpan = (guestAddr, max) => {
    const exports = ctx.exports;
    if (!exports || !_mu3.g2wSpan) return max;
    return _mu3.g2wSpan(guestAddr, max, exports.get_image_base(), ctx.getMemory && ctx.getMemory());
  };

  // A view over a guest range that is safe to walk linearly, plus how far it
  // reaches. Callers loop while there is more to move.
  const guestChunk = (guestAddr, remaining) => {
    const len = Math.max(1, Math.min(remaining, g2wSpan(guestAddr, remaining)));
    return { view: new Uint8Array(ctx.getMemory(), g2w(guestAddr), len), len };
  };

  const writeStrA = (guestAddr, str) => {
    const mem = new Uint8Array(ctx.getMemory());
    const wa = g2w(guestAddr);
    for (let i = 0; i < str.length; i++) mem[wa + i] = str.charCodeAt(i) & 0xFF;
    mem[wa + str.length] = 0;
    return str.length;
  };

  const _matchesBytes = (bytes, pos, pattern) => {
    if (pos + pattern.length > bytes.length) return false;
    for (let i = 0; i < pattern.length; i++) {
      if (bytes[pos + i] !== pattern[i]) return false;
    }
    return true;
  };

  const _writeAscii = (dst, pos, s) => {
    for (let i = 0; i < s.length; i++) dst[pos + i] = s.charCodeAt(i) & 0xFF;
    return pos + s.length;
  };

  const _isRtfWrite = (fh, src) => {
    if (!fh || !String(fh.path || '').endsWith('.rtf')) return false;
    const rtfHeader = [0x7B, 0x5C, 0x72, 0x74, 0x66]; // {\rtf
    if (fh.pos === 0) return _matchesBytes(src, 0, rtfHeader);
    const entry = vfs.files.get(fh.path);
    return !!entry && _matchesBytes(entry.data, 0, rtfHeader);
  };

  const _patchRichEditRtfSentinelSize = (handle, data, nToWrite) => {
    const twips = ctx._richeditLastYHeightTwips | 0;
    if (!(twips > 0 && twips < 32767)) return data;
    const halfPoints = Math.round(twips / 10);
    if (!(halfPoints > 0 && halfPoints <= 999)) return data;
    const selectionLo = Math.max(0, ctx._richeditLastSelectionLo | 0);
    const selectionHi = Math.max(selectionLo, ctx._richeditLastSelectionHi | 0);

    const src = data.subarray(0, nToWrite);
    const fh = vfs.handles.get(handle >>> 0);
    if (!_isRtfWrite(fh, src)) return data;

    const fsSentinel = [0x5C, 0x66, 0x73, 0x33, 0x32, 0x37, 0x37]; // \fs3277
    const upSentinel = [0x5C, 0x75, 0x70, 0x33, 0x32, 0x37, 0x36]; // \up3276
    let changed = false;
    const out = [];
    let bodyPos = 0;
    let inBody = false;
    let selected = false;

    const pushAscii = value => {
      for (let j = 0; j < value.length; j++) out.push(value.charCodeAt(j) & 0xFF);
    };
    const startRunIfNeeded = () => {
      if (!inBody) return;
      if (!selected && bodyPos === selectionLo) {
        pushAscii('\\fs' + halfPoints + ' ');
        selected = true;
      }
      if (selected && bodyPos === selectionHi) {
        pushAscii('\\fs20 '); // WordPad's default 10pt body size.
        selected = false;
      }
    };

    for (let i = 0; i < src.length;) {
      if (_matchesBytes(src, i, upSentinel)) {
        pushAscii('\\up0');
        i += upSentinel.length;
        changed = true;
        continue;
      }
      if (_matchesBytes(src, i, fsSentinel)) {
        pushAscii(selectionLo === 0 ? '\\fs' + halfPoints : '\\fs20');
        i += fsSentinel.length;
        if (i < src.length && src[i] === 0x20) out.push(src[i++]);
        inBody = true;
        selected = selectionLo === 0;
        changed = true;
        continue;
      }

      startRunIfNeeded();
      const byte = src[i];
      out.push(byte);
      i++;
      if (!inBody) continue;

      // RTF control words and raw line breaks are syntax, not document text.
      if (byte === 0x0D || byte === 0x0A || byte === 0) continue;
      if (byte === 0x7B || byte === 0x7D) continue; // { or }
      if (byte === 0x5C && i < src.length) {
        const next = src[i];
        if (next === 0x27 && i + 2 < src.length) { // \'hh: one ANSI char
          out.push(src[i++], src[i++], src[i++]);
          bodyPos++;
          continue;
        }
        if (next === 0x5C || next === 0x7B || next === 0x7D) {
          out.push(src[i++]);
          bodyPos++;
          continue;
        }
        while (i < src.length && ((src[i] >= 0x41 && src[i] <= 0x5A) ||
               (src[i] >= 0x61 && src[i] <= 0x7A))) out.push(src[i++]);
        if (i < src.length && (src[i] === 0x2D || (src[i] >= 0x30 && src[i] <= 0x39))) {
          if (src[i] === 0x2D) out.push(src[i++]);
          while (i < src.length && src[i] >= 0x30 && src[i] <= 0x39) out.push(src[i++]);
        }
        if (i < src.length && src[i] === 0x20) out.push(src[i++]);
        continue;
      }
      bodyPos++;
    }

    return changed ? Uint8Array.from(out) : data;
  };

  const writeStrW = (guestAddr, str) => {
    const dv = new DataView(ctx.getMemory());
    const wa = g2w(guestAddr);
    for (let i = 0; i < str.length; i++) dv.setUint16(wa + i * 2, str.charCodeAt(i), true);
    dv.setUint16(wa + str.length * 2, 0, true);
    return str.length;
  };

  const writeStr = (guestAddr, str, isWide) => isWide ? writeStrW(guestAddr, str) : writeStrA(guestAddr, str);

  const gs32 = (guestAddr, val) => {
    new DataView(ctx.getMemory()).setUint32(g2w(guestAddr), val, true);
  };

  // Fill WIN32_FIND_DATAA/W structure at guest address
  const fillFindData = (guestAddr, entry, isWide) => {
    const wa = g2w(guestAddr);
    const dv = new DataView(ctx.getMemory());
    const mem = new Uint8Array(ctx.getMemory());
    // Zero the whole structure first (ANSI=320 bytes, Wide=592 bytes)
    const size = isWide ? 592 : 320;
    for (let i = 0; i < size; i++) mem[wa + i] = 0;
    // dwFileAttributes at offset 0
    dv.setUint32(wa, entry.attrs, true);
    // ftCreationTime at offset 4 (8 bytes) — leave zero
    // ftLastAccessTime at offset 12 (8 bytes) — leave zero
    // ftLastWriteTime at offset 20 (8 bytes) — leave zero
    // nFileSizeHigh at offset 28
    dv.setUint32(wa + 28, 0, true);
    // nFileSizeLow at offset 32
    dv.setUint32(wa + 32, entry.size, true);
    // cFileName at offset 44 (ANSI: 260 bytes, Wide: 520 bytes)
    if (isWide) {
      for (let i = 0; i < entry.name.length; i++)
        dv.setUint16(wa + 44 + i * 2, entry.name.charCodeAt(i), true);
    } else {
      for (let i = 0; i < entry.name.length; i++)
        mem[wa + 44 + i] = entry.name.charCodeAt(i) & 0xFF;
    }
  };

  // File mappings: mapping handle → { fileHandle, data ref }
  const _mappings = new Map();
  let _nextMappingHandle = 0xFB000001;
  // MapViewOfFile allocations: base addr → size (for UnmapViewOfFile)
  const _mappedViews = new Map();

  // Bump allocator for file mappings — uses free WASM space above DLL table
  // These are WASM addresses; converted to guest addresses via w2g.
  const MAP_ALLOC_BASE = 0x07992400; // after 8MB PE staging + DLL metadata
  const MAP_ALLOC_END  = 0x08000000; // end of direct guest window; sparse VirtualAlloc backing starts here
  let _mapAllocPtr = MAP_ALLOC_BASE;
  const mapAlloc = (size) => {
    const aligned = (size + 0xFFF) & ~0xFFF; // page-align
    if (_mapAllocPtr + aligned > MAP_ALLOC_END) return 0;
    const ptr = _mapAllocPtr;
    _mapAllocPtr += aligned;
    return ptr; // WASM address
  };
  const w2g = () => {
    const exports = ctx.exports;
    return exports ? exports.get_image_base() - 0x12000 : 0; // imageBase - GUEST_BASE
  };

  const INVALID_HANDLE = 0xFFFFFFFF;
  const _traceFs = () => ctx.trace && ctx.trace.has('fs');

  return {
    // CreateFileA/W(path, access, shareMode, secAttr, creation, flagsAttrs, hTemplate)
    // WAT passes: pathWA, access, creation, flagsAttrs, isWide
    fs_create_file: (pathWA, access, creation, flagsAttrs, isWide) => {
      const path = readStr(pathWA, isWide);
      if (ctx.log) ctx.log(`[FS] CreateFile("${path}", access=0x${access.toString(16)}, creation=${creation})`);
      const h = vfs.createFile(path, access, creation);
      if (_traceFs()) {
        let caller = '';
        if (!path || path.length < 3) {
          caller = _frameHint(ctx);
        }
        console.log(`[fs] CreateFile("${path}", access=0x${access.toString(16)}, creation=${creation}) → ${h ? '0x'+(h>>>0).toString(16) : 'FAIL'}${caller}`);
      }
      if (!h) return INVALID_HANDLE;
      // RichEdit 2.x accepts stylesheet declarations but does not reliably
      // apply inherited style properties from Win98-era RTF. Present an
      // equivalent direct-control view to readers while leaving stored bytes
      // untouched for round-trip fidelity and other consumers.
      if (creation === 3 && String(path || '').toLowerCase().endsWith('.rtf')) {
        const fh = vfs.handles.get(h >>> 0);
        const entry = fh && vfs.files.get(fh.path);
        if (fh && entry && entry.data.length) {
          let source = '';
          for (let i = 0; i < entry.data.length; i++) source += String.fromCharCode(entry.data[i]);
          const expanded = expandRtfStylesheet(source);
          if (expanded !== source) {
            const bytes = new Uint8Array(expanded.length);
            for (let i = 0; i < expanded.length; i++) bytes[i] = expanded.charCodeAt(i) & 0xFF;
            fh.readData = bytes;
          }
        }
      }
      return h;
    },

    // _lopen/_lcreat compatibility. These APIs return a 16-bit HFILE even
    // though the backing VFS normally uses high-valued Win32 handles.
    fs_create_legacy_file: (pathWA, access, creation, flagsAttrs, isWide) => {
      const path = readStr(pathWA, isWide);
      const h = vfs.createLegacyFile(path, access, creation);
      if (_traceFs()) {
        console.log(`[fs] LegacyOpen("${path}", access=0x${access.toString(16)}, creation=${creation}) → ${h ? '0x'+h.toString(16) : 'FAIL'}`);
      }
      return h || INVALID_HANDLE;
    },

    // SearchPathA(lpPath, lpFileName, lpExtension, nBufLen, lpBuffer, lpFilePartPtr)
    //   Search current dir + optional lpPath for lpFileName [+ lpExtension].
    //   On success: writes full path into lpBuffer, returns length (excl. NUL).
    //   On failure: returns 0.
    fs_search_path: (pathWA, fileNameWA, extWA, bufLen, bufGA, filePartPtrGA, isWide) => {
      if (!fileNameWA) return 0;
      const origName = readStr(fileNameWA, isWide);
      if (!origName) return 0;
      const names = [origName];
      if (extWA && !origName.includes('.')) {
        const ext = readStr(extWA, isWide);
        if (ext) names.push(origName + (ext.startsWith('.') ? ext : ('.' + ext)));
      }
      // Apps sometimes double-append the extension (e.g. "Grad_k2.gif.gif").
      // Try stripping a duplicated trailing ".X.X" suffix as a fallback.
      const m = origName.match(/^(.+?)(\.[^.\\\/]+)\2$/);
      if (m) names.push(m[1] + m[2]);
      const candidates = [];
      const cwd = vfs.getCurrentDirectory();
      const pathStr = pathWA ? readStr(pathWA, isWide) : '';
      for (const nm of names) {
        candidates.push(nm);
        if (cwd) candidates.push(cwd.replace(/\\$/, '') + '\\' + nm);
        if (pathStr) candidates.push(pathStr.replace(/\\$/, '') + '\\' + nm);
      }
      const name = origName;
      const tryCand = (cand) => {
        const attrs = vfs.getFileAttributes(cand);
        if ((attrs >>> 0) !== 0xFFFFFFFF && (attrs & 0x10) === 0) {
          return vfs.getFullPathName(cand);
        }
        return null;
      };
      const emitHit = (full, note) => {
        if (_traceFs()) console.log(`[fs] SearchPath("${name}") → "${full}"${note ? ' ' + note : ''}`);
        if (bufGA) writeStr(bufGA, full, isWide);
        if (filePartPtrGA) {
          const lastSlash = full.lastIndexOf('\\');
          const off = (lastSlash >= 0) ? lastSlash + 1 : 0;
          gs32(filePartPtrGA, bufGA + off * (isWide ? 2 : 1));
        }
        return full.length;
      };
      for (const cand of candidates) {
        const full = tryCand(cand);
        if (full) return emitHit(full);
      }
      // Long-name → 8.3 fallback. Plus!98 screensaver .SCN files reference meshes
      // by descriptive names ("Grapple-198", "Octahedronc", "Io-half-torus") that
      // map to 8.3 files on disk (GRAPPLE.X, OCTAHEDR.X, IO-HALF.X). Try progressive
      // truncation of the basename stem, stripping trailing separators each time.
      for (const nm of names) {
        const dot = nm.lastIndexOf('.');
        if (dot <= 0) continue;
        const stem = nm.slice(0, dot);
        const ext = nm.slice(dot);
        const dirs = [''];
        if (cwd) dirs.push(cwd.replace(/\\$/, '') + '\\');
        if (pathStr) dirs.push(pathStr.replace(/\\$/, '') + '\\');
        for (let n = stem.length - 1; n >= 3; n--) {
          const trimmed = stem.slice(0, n).replace(/[-._ ]+$/, '');
          if (trimmed.length < 3) break;
          const tryName = trimmed + ext;
          for (const d of dirs) {
            const full = tryCand(d + tryName);
            if (full) return emitHit(full, `(truncated from "${nm}")`);
          }
        }
      }
      if (_traceFs()) console.log(`[fs] SearchPath("${name}") → NOT FOUND`);
      return 0;
    },

    fs_read_file: (handle, bufGA, nToRead, nReadGA) => {
      const fhDbg = (ctx._debugReadFile || (ctx.trace && ctx.trace.has && ctx.trace.has('fs'))) ? vfs.handles.get(handle >>> 0) : null;
      const posBefore = fhDbg ? fhDbg.pos : -1;
      // Read in runs that each stay inside one mapping. A single large read
      // into sparse VirtualAlloc memory used to walk past the end of its
      // mapping and overwrite whichever backing followed — Pinball (Plus! 95)
      // destroyed its own allocator's free list this way and then span
      // forever on the broken chain.
      let ok = true, bytesRead = 0, moved = 0;
      while (moved < nToRead) {
        const { view, len } = guestChunk((bufGA + moved) >>> 0, nToRead - moved);
        const r = vfs.readFile(handle, view, len);
        if (!r.ok) { ok = false; break; }
        bytesRead += r.bytesRead;
        moved += len;
        if (r.bytesRead < len) break;   // hit end of file
      }
      if (nReadGA) gs32(nReadGA, bytesRead);
      if (fhDbg) {
        console.log(`[FS] ReadFile(h=0x${(handle>>>0).toString(16)}, n=0x${nToRead.toString(16)}, read=0x${bytesRead.toString(16)}, pos=0x${posBefore.toString(16)}, path=${fhDbg.path})`);
      }
      return ok ? 1 : 0;
    },

    fs_write_file: (handle, bufGA, nToWrite, nWrittenGA) => {
      // Same mapping hazard as the read path: gather across runs rather than
      // trusting one translation to cover the whole length.
      let data;
      if (g2wSpan(bufGA, nToWrite) >= nToWrite) {
        data = new Uint8Array(ctx.getMemory(), g2w(bufGA), nToWrite);
      } else {
        data = new Uint8Array(nToWrite);
        let moved = 0;
        while (moved < nToWrite) {
          const { view, len } = guestChunk((bufGA + moved) >>> 0, nToWrite - moved);
          data.set(view, moved);
          moved += len;
        }
      }
      data = _patchRichEditRtfSentinelSize(handle, data, nToWrite);
      const { ok } = vfs.writeFile(handle, data, data.length);
      // Report the caller's source byte count even if compatibility rewriting
      // changes the stored stream length.
      if (nWrittenGA) gs32(nWrittenGA, ok ? nToWrite : 0);
      return ok ? 1 : 0;
    },

    fs_close_handle: (handle) => {
      return vfs.closeHandle(handle) ? 1 : 0;
    },

    fs_set_file_pointer: (handle, distance, moveMethod) => {
      return vfs.setFilePointer(handle, distance, moveMethod);
    },

    fs_set_end_of_file: (handle) => {
      return vfs.setEndOfFile(handle) ? 1 : 0;
    },

    fs_get_file_size: (handle) => {
      const sz = vfs.getFileSize(handle);
      if (ctx.log) ctx.log(`[FS] GetFileSize(0x${(handle>>>0).toString(16)}) → ${sz}`);
      return sz;
    },

    fs_get_file_attributes: (pathWA, isWide) => {
      const path = readStr(pathWA, isWide);
      const attrs = vfs.getFileAttributes(path);
      if (ctx.log) ctx.log(`GetFileAttributes("${path}") → 0x${(attrs>>>0).toString(16)}`);
      if (_traceFs()) {
        const ok = (attrs >>> 0) !== 0xFFFFFFFF;
        let caller = '';
        if (!ok || !path || path.length < 6 || path.startsWith('.')) {
          caller = _frameHint(ctx);
        }
        console.log(`[fs] GetFileAttributes("${path}") → ${ok ? '0x'+(attrs>>>0).toString(16) : 'INVALID'}${caller}`);
      }
      return attrs;
    },

    fs_set_file_attributes: (pathWA, attrs, isWide) => {
      const path = readStr(pathWA, isWide);
      return vfs.setFileAttributes(path, attrs) ? 1 : 0;
    },

    fs_delete_file: (pathWA, isWide) => {
      const path = readStr(pathWA, isWide);
      return vfs.deleteFile(path) ? 1 : 0;
    },

    fs_create_directory: (pathWA, isWide) => {
      const path = readStr(pathWA, isWide);
      if (ctx.log) ctx.log(`CreateDirectory("${path}")`);
      return vfs.createDirectory(path) ? 1 : 0;
    },

    fs_remove_directory: (pathWA, isWide) => {
      const path = readStr(pathWA, isWide);
      return vfs.removeDirectory(path) ? 1 : 0;
    },

    fs_move_file: (srcWA, dstWA, isWide) => {
      const src = readStr(srcWA, isWide);
      const dst = readStr(dstWA, isWide);
      return vfs.moveFile(src, dst) ? 1 : 0;
    },

    fs_copy_file: (srcWA, dstWA, failIfExists, isWide) => {
      const src = readStr(srcWA, isWide);
      const dst = readStr(dstWA, isWide);
      return vfs.copyFile(src, dst, failIfExists) ? 1 : 0;
    },

    fs_find_first_file: (patternWA, findDataGA, isWide) => {
      const pattern = readStr(patternWA, isWide);
      if (ctx.log) ctx.log(`FindFirstFile("${pattern}")`);
      const { handle, entry } = vfs.findFirstFile(pattern);
      if (!handle) {
        if (_traceFs()) console.log(`[fs] FindFirstFile("${pattern}") → FAIL`);
        return INVALID_HANDLE;
      }
      if (ctx._debugFindFile) console.log(`[FF] FindFirst("${pattern}") => "${entry.name}" size=${entry.size}`);
      if (_traceFs()) console.log(`[fs] FindFirstFile("${pattern}") → "${entry.name}" size=${entry.size}`);
      fillFindData(findDataGA, entry, isWide);
      return handle;
    },

    fs_find_next_file: (handle, findDataGA, isWide) => {
      const entry = vfs.findNextFile(handle);
      if (!entry) {
        if (_traceFs()) console.log(`[fs] FindNextFile(0x${(handle>>>0).toString(16)}) → end`);
        return 0;
      }
      if (ctx._debugFindFile) console.log(`[FF] FindNext => "${entry.name}" size=${entry.size}`);
      if (_traceFs()) console.log(`[fs] FindNextFile(0x${(handle>>>0).toString(16)}) → "${entry.name}" size=${entry.size}`);
      fillFindData(findDataGA, entry, isWide);
      return 1;
    },

    fs_find_close: (handle) => {
      return vfs.findClose(handle) ? 1 : 0;
    },

    fs_get_temp_path: (bufSize, bufGA, isWide) => {
      const p = vfs.getTempPath();
      return writeStr(bufGA, p, isWide);
    },

    fs_get_temp_file_name: (pathWA, prefixWA, unique, bufGA, isWide) => {
      const dir = readStr(pathWA, isWide);
      const prefix = prefixWA ? readStr(prefixWA, isWide) : 'tmp';
      const name = vfs.getTempFileName(dir, prefix, unique);
      writeStr(bufGA, name, isWide);
      return unique || vfs._tempCounter;
    },

    fs_get_current_directory: (bufSize, bufGA, isWide) => {
      const p = vfs.getCurrentDirectory();
      return writeStr(bufGA, p, isWide);
    },

    fs_set_current_directory: (pathWA, isWide) => {
      const path = readStr(pathWA, isWide);
      return vfs.setCurrentDirectory(path) ? 1 : 0;
    },

    fs_get_full_path_name: (fileWA, bufSize, bufGA, filePartGA, isWide) => {
      const file = readStr(fileWA, isWide);
      const full = vfs.getFullPathName(file);
      const len = writeStr(bufGA, full, isWide);
      // filePart points to filename portion within buffer
      if (filePartGA) {
        const lastSlash = full.lastIndexOf('\\');
        const filePartOffset = (lastSlash >= 0) ? lastSlash + 1 : 0;
        // filePartGA points to a DWORD that receives the pointer to filename
        const charSize = isWide ? 2 : 1;
        gs32(filePartGA, bufGA + filePartOffset * charSize);
      }
      return len;
    },

    // CreateFileMappingA(hFile, protect, sizeHi, sizeLo) → mapping handle
    fs_create_file_mapping: (hFile, protect, sizeHi, sizeLo, nameWA) => {
      hFile = hFile >>> 0;
      const name = nameWA ? readStrA(nameWA) : '';
      // INVALID_HANDLE_VALUE means "back this with the pagefile", i.e. plain
      // shared memory with no file behind it. Apps use a named one to publish
      // their presence to a sibling process — Kodak Imaging creates
      // "EastManSoftwarePrvFile" so its Preview counterpart can find it.
      const anonymous = hFile === 0xFFFFFFFF || hFile === 0;
      const fh = anonymous ? null : vfs.handles.get(hFile);
      if (!anonymous && !fh) return 0;
      if (anonymous) {
        const bytes = sizeLo >>> 0;             // high dword is out of range here
        if (!bytes) return 0;
        if (name) {
          for (const [h, m] of _mappings) {
            if (m.name === name) return h;      // existing section wins
          }
        }
        const h = (_nextMappingHandle++) | 0;
        _mappings.set(h, { anon: new Uint8Array(bytes), name });
        if (ctx.log) ctx.log(`CreateFileMapping(pagefile, ${bytes}B${name ? ', "' + name + '"' : ''}) → 0x${h.toString(16)}`);
        return h;
      }
      // A named section is reopenable by name. Win32 hands back the existing
      // one rather than a second section, so an app that names its mapping can
      // find it again — which is the whole point of naming it.
      if (name) {
        for (const [h, m] of _mappings) {
          if (m.name === name) return h;
        }
      }
      const h = (_nextMappingHandle++) | 0;
      _mappings.set(h, { filePath: fh.path, hFile, name });
      if (ctx.log) ctx.log(`CreateFileMapping(0x${hFile.toString(16)}${name ? ', "' + name + '"' : ''}) → 0x${h.toString(16)}`);
      return h;
    },

    // OpenFileMapping(lpName) → handle, or 0 when nothing published that name.
    // Zero is a real answer here, not a stub: the section belongs to whichever
    // process created it, and in a single-process world an unclaimed name
    // genuinely does not exist.
    fs_open_file_mapping: (nameWA) => {
      const name = nameWA ? readStrA(nameWA) : '';
      if (!name) return 0;
      for (const [h, m] of _mappings) {
        if (m.name === name) {
          if (ctx.log) ctx.log(`OpenFileMapping("${name}") → 0x${h.toString(16)}`);
          return h;
        }
      }
      if (ctx.log) ctx.log(`OpenFileMapping("${name}") → not found`);
      return 0;
    },

    // MapViewOfFile(hMapping, access, offsetHi, offsetLo, size) → guest addr
    fs_map_view_of_file: (hMapping, access, offsetHi, offsetLo, size) => {
      const mapping = _mappings.get(hMapping);
      if (!mapping) return 0;
      // A pagefile-backed section carries its bytes directly; a file-backed
      // one reads them from the VFS.
      const data = mapping.anon || (() => {
        const entry = vfs.files.get(mapping.filePath);
        return entry ? entry.data : null;
      })();
      if (!data) return 0;
      const offset = offsetLo; // ignore high 32 bits
      const mapSize = size || (data.length - offset);
      if (mapSize <= 0) return 0;

      // Allocate via guest heap (VirtualAlloc-style page-aligned bump)
      // so mapped memory stays in low guest address space, away from
      // emulator-private regions (thunks, thread cache, etc.)
      const guestAddr = ctx.exports.guest_alloc(mapSize);
      if (!guestAddr) return 0;
      const g2wOff = 0x12000 - ctx.exports.get_image_base();
      const wasmAddr = guestAddr + g2wOff;

      // Copy data into WASM memory
      const mem = new Uint8Array(ctx.getMemory());
      mem.set(data.subarray(offset, offset + mapSize), wasmAddr);

      _mappedViews.set(guestAddr, { size: mapSize, hMapping, offset, wasmAddr });
      if (ctx.log) ctx.log(`[FS] MapViewOfFile → guest 0x${guestAddr.toString(16)} wasm 0x${wasmAddr.toString(16)} (${(mapSize/1024)|0}KB, ${mapping.anon ? 'pagefile' : 'file=' + mapping.filePath})`);
      return guestAddr;
    },

    // UnmapViewOfFile(baseAddr) → BOOL
    fs_unmap_view: (baseAddr) => {
      const view = _mappedViews.get(baseAddr);
      if (view) {
        // Coherency: Sync back to file data
        const mapping = _mappings.get(view.hMapping);
        if (mapping) {
          const entry = vfs.files.get(mapping.filePath);
          if (entry) {
            const mem = new Uint8Array(ctx.getMemory());
            const wa = view.wasmAddr || g2w(baseAddr);
            const toSync = Math.min(view.size, entry.data.length - view.offset);
            if (toSync > 0) {
              entry.data.set(mem.subarray(wa, wa + toSync), view.offset);
            }
          }
        }
        _mappedViews.delete(baseAddr);
        if (ctx.log) ctx.log(`[FS] UnmapViewOfFile(0x${baseAddr.toString(16)}) - synced and freed`);
      }
      return 1;
    },

    // FileTimeToSystemTime — convert FILETIME (100ns since 1601) to SYSTEMTIME
    fs_filetime_to_systemtime: (ftWA, stWA) => {
      const dv = new DataView(ctx.getMemory());
      const lo = dv.getUint32(ftWA, true);
      const hi = dv.getUint32(ftWA + 4, true);
      // FILETIME → milliseconds since Unix epoch
      // FILETIME epoch: 1601-01-01, Unix epoch: 1970-01-01
      // Difference: 11644473600 seconds = 116444736000000000 in 100ns ticks
      const ftBig = BigInt(hi) * 0x100000000n + BigInt(lo);
      const unixMs = Number((ftBig - 116444736000000000n) / 10000n);
      const d = new Date(unixMs);
      if (isNaN(d.getTime())) return 0;
      dv.setUint16(stWA, d.getUTCFullYear(), true);
      dv.setUint16(stWA + 2, d.getUTCMonth() + 1, true);
      dv.setUint16(stWA + 4, d.getUTCDay(), true);
      dv.setUint16(stWA + 6, d.getUTCDate(), true);
      dv.setUint16(stWA + 8, d.getUTCHours(), true);
      dv.setUint16(stWA + 10, d.getUTCMinutes(), true);
      dv.setUint16(stWA + 12, d.getUTCSeconds(), true);
      dv.setUint16(stWA + 14, d.getUTCMilliseconds(), true);
      return 1;
    },

    fs_get_short_path_name: (longWA, shortGA, bufSize, isWide) => {
      // Just copy long → short (no 8.3 conversion needed in virtual FS)
      const long = readStr(longWA, isWide);
      return writeStr(shortGA, long, isWide);
    },
  };
}

// Export for Node.js and browser
if (typeof module !== 'undefined') {
  module.exports = { createFilesystemImports, VirtualFS, expandRtfStylesheet };
}
if (typeof window !== 'undefined') {
  window.FilesystemImports = { createFilesystemImports, VirtualFS, expandRtfStylesheet };
}
