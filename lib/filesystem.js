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
    this._nextHandle = 0xF0000001;
    this._nextFindHandle = 0xFA000001;
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

  createFile(path, access, creation) {
    let norm = this._resolvePath(path);
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

  readFile(handle, buf, nToRead) {
    handle = handle >>> 0;
    const fh = this.handles.get(handle);
    if (!fh) return { ok: false, bytesRead: 0 };
    const entry = this.files.get(fh.path);
    if (!entry) return { ok: false, bytesRead: 0 };
    const avail = Math.max(0, entry.data.length - fh.pos);
    const toRead = Math.min(nToRead, avail);
    buf.set(entry.data.subarray(fh.pos, fh.pos + toRead));
    fh.pos += toRead;
    return { ok: true, bytesRead: toRead };
  }

  writeFile(handle, data, nToWrite) {
    handle = handle >>> 0;
    const fh = this.handles.get(handle);
    if (!fh) return { ok: false, bytesWritten: 0 };
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
    const size = entry ? entry.data.length : 0;
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

  getFileSize(handle) {
    handle = handle >>> 0;
    const fh = this.handles.get(handle);
    if (!fh) return 0xFFFFFFFF;
    const entry = this.files.get(fh.path);
    return entry ? entry.data.length : 0;
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
    if (entry) return entry.attrs || 0x80;
    return 0xFFFFFFFF; // INVALID_FILE_ATTRIBUTES
  }

  setFileAttributes(path, attrs) {
    const norm = this._resolvePath(path);
    const entry = this.files.get(norm);
    if (entry) { entry.attrs = attrs; return true; }
    if (this.dirs.has(norm)) return true;
    return false;
  }

  deleteFile(path) {
    const norm = this._resolvePath(path);
    return this.files.delete(norm);
  }

  createDirectory(path) {
    const norm = this._resolvePath(path);
    if (this.dirs.has(norm)) return false; // already exists
    this.dirs.add(norm);
    // Ensure parent exists
    this.dirs.add(this._parentDir(norm));
    return true;
  }

  removeDirectory(path) {
    const norm = this._resolvePath(path);
    return this.dirs.delete(norm);
  }

  moveFile(src, dst) {
    const normSrc = this._resolvePath(src);
    const normDst = this._resolvePath(dst);
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
    const norm = this._resolvePath(pattern);
    const dir = this._parentDir(norm);
    const pat = this._fileName(norm);
    const results = [];

    // Convert glob pattern to regex
    const regex = new RegExp('^' + pat.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');

    // Search files
    for (const [path, entry] of this.files) {
      if (this._parentDir(path) === dir && regex.test(this._fileName(path))) {
        results.push({ name: this._fileName(path), size: entry.data.length, attrs: entry.attrs || 0x80 });
      }
    }
    // Search subdirectories
    for (const d of this.dirs) {
      if (this._parentDir(d) === dir && d !== dir && regex.test(this._fileName(d))) {
        results.push({ name: this._fileName(d), size: 0, attrs: 0x10 }); // DIRECTORY
      }
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
    return exports ? _mu3.g2w(guestAddr, exports.get_image_base()) : guestAddr;
  };

  const writeStrA = (guestAddr, str) => {
    const mem = new Uint8Array(ctx.getMemory());
    const wa = g2w(guestAddr);
    for (let i = 0; i < str.length; i++) mem[wa + i] = str.charCodeAt(i) & 0xFF;
    mem[wa + str.length] = 0;
    return str.length;
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
  const MAP_ALLOC_BASE = 0x04462400; // after DLL table + DLL resource table
  const MAP_ALLOC_END  = 0x08000000; // 128MB total WASM memory
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
          try {
            const e = ctx.exports;
            const esp = e.get_esp();
            const imageBase = e.get_image_base();
            const dv = new DataView(ctx.getMemory());
            const ra = dv.getUint32(esp - imageBase + 0x12000, true);
            caller = ` ra=0x${ra.toString(16)}`;
          } catch (_) {}
        }
        console.log(`[fs] CreateFile("${path}", access=0x${access.toString(16)}, creation=${creation}) → ${h ? '0x'+(h>>>0).toString(16) : 'FAIL'}${caller}`);
      }
      if (!h) return INVALID_HANDLE;
      return h;
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
      for (const cand of candidates) {
        const attrs = vfs.getFileAttributes(cand);
        if ((attrs >>> 0) !== 0xFFFFFFFF && (attrs & 0x10) === 0) {
          const full = vfs.getFullPathName(cand);
          if (_traceFs()) console.log(`[fs] SearchPath("${name}") → "${full}"`);
          if (bufGA) writeStr(bufGA, full, bufLen, isWide);
          if (filePartPtrGA) {
            const lastSlash = full.lastIndexOf('\\');
            const off = (lastSlash >= 0) ? lastSlash + 1 : 0;
            gs32(filePartPtrGA, bufGA + off * (isWide ? 2 : 1));
          }
          return full.length;
        }
      }
      if (_traceFs()) console.log(`[fs] SearchPath("${name}") → NOT FOUND`);
      return 0;
    },

    fs_read_file: (handle, bufGA, nToRead, nReadGA) => {
      const buf = new Uint8Array(ctx.getMemory(), g2w(bufGA), nToRead);
      const { ok, bytesRead } = vfs.readFile(handle, buf, nToRead);
      if (nReadGA) gs32(nReadGA, bytesRead);
      if (ctx._debugReadFile) console.log(`[FS] ReadFile(0x${(handle>>>0).toString(16)}, buf=0x${(bufGA>>>0).toString(16)}, n=0x${nToRead.toString(16)}, read=${bytesRead})`);
      return ok ? 1 : 0;
    },

    fs_write_file: (handle, bufGA, nToWrite, nWrittenGA) => {
      const data = new Uint8Array(ctx.getMemory(), g2w(bufGA), nToWrite);
      const { ok, bytesWritten } = vfs.writeFile(handle, data, nToWrite);
      if (nWrittenGA) gs32(nWrittenGA, bytesWritten);
      return ok ? 1 : 0;
    },

    fs_close_handle: (handle) => {
      return vfs.closeHandle(handle) ? 1 : 0;
    },

    fs_set_file_pointer: (handle, distance, moveMethod) => {
      return vfs.setFilePointer(handle, distance, moveMethod);
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
        console.log(`[fs] GetFileAttributes("${path}") → ${ok ? '0x'+(attrs>>>0).toString(16) : 'INVALID'}`);
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
    fs_create_file_mapping: (hFile, protect, sizeHi, sizeLo) => {
      const fh = vfs.handles.get(hFile);
      if (!fh) return 0;
      const h = (_nextMappingHandle++) | 0;
      _mappings.set(h, { filePath: fh.path, hFile });
      if (ctx.log) ctx.log(`CreateFileMapping(0x${hFile.toString(16)}) → 0x${h.toString(16)}`);
      return h;
    },

    // MapViewOfFile(hMapping, access, offsetHi, offsetLo, size) → guest addr
    fs_map_view_of_file: (hMapping, access, offsetHi, offsetLo, size) => {
      const mapping = _mappings.get(hMapping);
      if (!mapping) return 0;
      const entry = vfs.files.get(mapping.filePath);
      if (!entry) return 0;
      const offset = offsetLo; // ignore high 32 bits
      const data = entry.data;
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
      if (ctx.log) ctx.log(`[FS] MapViewOfFile → guest 0x${guestAddr.toString(16)} wasm 0x${wasmAddr.toString(16)} (${(mapSize/1024)|0}KB, file=${mapping.filePath})`);
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
  module.exports = { createFilesystemImports, VirtualFS };
}
if (typeof window !== 'undefined') {
  window.FilesystemImports = { createFilesystemImports, VirtualFS };
}
