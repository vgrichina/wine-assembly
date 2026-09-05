/**
 * Virtual filesystem backed by in-memory Map.
 * Provides host imports for Win32 file I/O APIs.
 * Files are stored as Uint8Array in memory. Directory entries tracked separately.
 */

// How big a file entry is without reading it. A lazily-backed entry knows its
// size from the directory listing that created it, so asking for it must not
// pull the bytes in — FindFirstFile over a populated drive would otherwise
// materialize every file on it just to fill in nFileSizeLow.
function entrySize(entry) {
  if (!entry) return 0;
  if (entry._size !== undefined) return entry._size;
  return entry.data.length;
}

const FILE_NOTIFY_CHANGE_FILE_NAME = 0x00000001;
const FILE_NOTIFY_CHANGE_DIR_NAME = 0x00000002;
const FILE_NOTIFY_CHANGE_ATTRIBUTES = 0x00000004;
const FILE_NOTIFY_CHANGE_SIZE = 0x00000008;
const FILE_NOTIFY_CHANGE_LAST_WRITE = 0x00000010;

const FILETIME_UNIX_EPOCH = 116444736000000000n;

function splitFileTime(value) {
  const ticks = BigInt.asUintN(64, value);
  return {
    lo: Number(ticks & 0xFFFFFFFFn) >>> 0,
    hi: Number(ticks >> 32n) >>> 0,
  };
}

function currentFileTime() {
  return splitFileTime(FILETIME_UNIX_EPOCH + BigInt(Date.now()) * 10000n);
}

function cloneFileTime(value) {
  return { lo: value.lo >>> 0, hi: value.hi >>> 0 };
}

function sameFileTime(a, b) {
  return (a.lo >>> 0) === (b.lo >>> 0) && (a.hi >>> 0) === (b.hi >>> 0);
}

function preserveFileTime(value) {
  return value && (value.lo >>> 0) === 0xFFFFFFFF && (value.hi >>> 0) === 0xFFFFFFFF;
}

function ensureFileTimes(entry) {
  if (!entry.creationTime || !entry.lastAccessTime || !entry.lastWriteTime) {
    const now = currentFileTime();
    if (!entry.creationTime) entry.creationTime = cloneFileTime(now);
    if (!entry.lastAccessTime) entry.lastAccessTime = cloneFileTime(now);
    if (!entry.lastWriteTime) entry.lastWriteTime = cloneFileTime(now);
  }
  return entry;
}

function createFileEntry(data, attrs) {
  return ensureFileTimes({ data, attrs });
}

// ---- provider-backed (lazy) entries ---------------------------------------
//
// Phase ① of docs/design-byo-media.md. An entry may name its bytes through a
// `lib/byte-provider.js` ChunkCache plus an (offset, length) window instead of
// carrying a materialized Uint8Array — that is what lets a mounted ISO or zip
// be a set of files without allocating the container.
//
// Two access shapes exist, and the difference matters:
//
//   * `readFile` reads *ranges*. It asks the chunk cache synchronously and,
//     on a miss, returns a distinguishable `pending` result. A miss must never
//     look like a short read: the guest would take it for end-of-file.
//   * `entry.data` materializes the *whole* file. Every pre-existing consumer
//     in this file and its callers keeps working through this accessor, and a
//     write through the setter drops the provider — copy-on-write, for free.
//     It is correct but not cheap, so the read path deliberately does not use
//     it.
//
// THE CONTRACT, and why it is drawn here. A JS host import cannot suspend and
// resume its WASM caller; parking has to happen in WAT, before the handler
// pops its stdcall frame. ReadFile and read-only MapViewOfFile do that (see
// their handlers and $io_block). Every *other* consumer of a lazy entry runs
// to completion in the same turn and therefore needs the bytes now:
//
//     _lread / _hread          src/09a-handlers.wat — continues immediately
//     writable mapped views      this file — materialize before writeback
//     DLL and resource loading   host.js, lib/dll-loader.js
//     audio and GDI asset reads  src/09a3-*, src/09a4-*
//     writeFile / setEndOfFile / createFile(TRUNCATE) / copyFile — this file
//
// So a provider that can read synchronously (Node fd, resident bytes, a chunk
// cache that already holds the range) serves all of them through this
// accessor, and an async-only provider (Blob, HTTP Range) must be
// pre-materialized with `vfs.materialize(path)` before any of them touches
// it. Hitting one of them with an unfilled async-only provider throws
// VfsPendingError: that is a mount bug, and a loud one beats inventing bytes
// or unwinding through nested WASM frames. Spawned guest threads use the same
// explicit IO_WAIT contract through the cooperative or Worker scheduler.

// Resolved lazily and tolerantly: this file also loads in hosts that never
// mount a container and therefore never ship lib/byte-provider.js.
let _bpCache;
function _byteProvider() {
  if (_bpCache !== undefined) return _bpCache;
  _bpCache = null;
  if (typeof window !== 'undefined' && window.byteProvider) _bpCache = window.byteProvider;
  else if (typeof require !== 'undefined') {
    try { _bpCache = require('./byte-provider'); } catch (_) { _bpCache = null; }
  }
  return _bpCache;
}

class VfsPendingError extends Error {
  constructor(path, offset, length) {
    super(`VFS entry ${path} is backed by an async-only provider and was used ` +
      `by a consumer that cannot wait (@${offset}+${length}). ` +
      `Call vfs.materialize('${path}') at mount time, or mount it behind a ` +
      `provider that reads synchronously.`);
    this.name = 'VfsPendingError';
    this.vfsPending = { path, offset, length };
  }
}

function providerReadSync(entry, off, len) {
  const p = entry._provider;
  if (!p || !p.tryRead) return null;
  return p.tryRead((entry._offset || 0) + off, len);
}

function providerWindowValue(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new RangeError(`setProviderFile: ${label} must be a non-negative safe integer`);
  }
  return number;
}

// Whole-file consumers must not ask a bounded ChunkCache to make the entire
// file resident at once: files larger than its LRU capacity evict their first
// chunks before the final `tryRead`. Materialization is terminal (the provider
// is dropped when the bytes are installed), so read bounded windows directly
// from the cache's underlying provider when that standard shape is available.
// A custom cache without an exposed provider still gets bounded requests
// through its own readRange/fill contract.
const MATERIALIZE_CHUNK_SIZE = 4 * 1024 * 1024;
function providerReadAsync(cache, absolute, len) {
  const source = cache && cache.provider && typeof cache.provider.readRange === 'function'
    ? cache.provider : cache;
  if (source && typeof source.readRange === 'function') {
    return Promise.resolve(source.readRange(absolute, len));
  }
  if (!cache || typeof cache.fill !== 'function' || typeof cache.tryRead !== 'function') {
    return Promise.reject(new Error('materialize: provider has no asynchronous read path'));
  }
  return Promise.resolve(cache.fill(absolute, len)).then(() => {
    const bytes = cache.tryRead(absolute, len);
    if (!bytes) throw new Error(`materialize: fill did not satisfy @${absolute}+${len}`);
    return bytes;
  });
}

function defineProviderData(entry, path) {
  let data = null;
  Object.defineProperty(entry, 'data', {
    configurable: true,
    enumerable: true,
    get() {
      if (data === null) {
        const whole = providerReadSync(entry, 0, entry._size);
        if (!whole) throw new VfsPendingError(path, 0, entry._size);
        data = new Uint8Array(whole);
        entry._provider = null;
        entry._offset = 0;
        entry._size = data.length;
      }
      return data;
    },
    set(v) {
      data = v;
      entry._provider = null;
      entry._offset = 0;
      entry._size = v.length;
    },
  });
}

class VirtualFS {
  constructor() {
    this.files = new Map();    // normalized path → { data: Uint8Array, attrs: number }
    this.dirs = new Set();     // normalized paths of directories
    this.handles = new Map();  // handle → { path, pos, access, data (ref to files entry) }
    this.findHandles = new Map(); // handle → { pattern, results[], index }
    this.changeNotifications = new Map(); // waitable handle → directory watch
    this.readOnlyDrives = new Set(); // lower-case drive letters backed by immutable media
    // Lazy (provider-backed) read state. `pendingRead` is the one read that
    // parked and is keyed by handle + position so a second handle on the same
    // file cannot answer for it; `readFaults` latches a fill that failed, so
    // the retry completes as a Win32 failure instead of parking forever.
    this.pendingRead = null;
    this.readFaults = new Map(); // handle → { pos, error }
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
    this.dirs.add('c:\\windows\\desktop');
    this.dirs.add('c:\\windows\\application data');
    this.dirs.add('c:\\windows\\start menu');
    this.dirs.add('c:\\windows\\start menu\\programs');
    this.dirs.add('c:\\windows\\start menu\\programs\\startup');
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
      if (part === '..') {
        // Win32 clamps parent traversal at a drive root. Keeping the `..`
        // here turns C:\..\Maps into a literal, unreachable directory; UE1
        // uses that spelling while its executable lives conceptually in
        // C:\System, and an ad-hoc root-mounted executable must still discover
        // the sibling asset directory.
        if (out.length > 1) out.pop();
        continue;
      }
      out.push(part);
    }
    n = out.join('\\');
    if (n.length > 3 && n.endsWith('\\')) n = n.slice(0, -1);
    return n;
  }

  _resolvePath(p) {
    let resolved = p;
    const driveRelative = /^([a-zA-Z]):([^\\].*)?$/.exec(resolved);
    if (driveRelative) {
      const drive = driveRelative[1].toLowerCase();
      const suffix = driveRelative[2] || '';
      const cwdDrive = this.cwd.slice(0, 1).toLowerCase();
      const base = drive === cwdDrive ? this.cwd : `${drive}:\\`;
      resolved = suffix ? base.replace(/\\$/, '') + '\\' + suffix : base;
    // If relative (no drive letter), prepend CWD
    } else if (!/^[a-zA-Z]:/.test(resolved) && !resolved.startsWith('\\\\')) {
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

  // Mount helpers normally receive a file path rather than an explicit drive
  // declaration. Register the drive itself as well as every parent so Win32
  // drive scans can chdir to and enumerate non-C media roots.
  ensureParentDirs(path) {
    const norm = this._normPath(path);
    if (/^[a-z]:/i.test(norm)) {
      this.dirs.add(norm.slice(0, 2));
      this.dirs.add(norm.slice(0, 2) + '\\');
    }
    let p = norm;
    while (true) {
      const idx = p.lastIndexOf('\\');
      if (idx <= 2) break;
      p = p.slice(0, idx);
      this.dirs.add(p);
    }
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

  _watchDirectory(path) {
    const norm = this._resolvePath(path);
    return /^[a-z]:$/i.test(norm) ? norm + '\\' : norm;
  }

  registerChangeNotification(handle, path, watchSubtree, filter, callbacks = {}) {
    handle >>>= 0;
    const directory = this._watchDirectory(path);
    if (!handle || this.changeNotifications.has(handle) ||
        !(this.dirs.has(directory) || this.dirs.has(directory.replace(/\\$/, '')))) {
      return false;
    }
    this.changeNotifications.set(handle, {
      directory,
      watchSubtree: !!watchSubtree,
      filter: filter >>> 0,
      armed: true,
      pending: false,
      signal: typeof callbacks.signal === 'function' ? callbacks.signal : () => false,
      reset: typeof callbacks.reset === 'function' ? callbacks.reset : () => false,
      close: typeof callbacks.close === 'function' ? callbacks.close : () => false,
    });
    return true;
  }

  _changeMatches(watch, path) {
    const changed = this._resolvePath(path);
    if (changed === watch.directory) return false;
    const prefix = watch.directory.endsWith('\\')
      ? watch.directory : watch.directory + '\\';
    if (!changed.startsWith(prefix)) return false;
    return watch.watchSubtree || this._parentDir(changed) === watch.directory;
  }

  _notifyChange(path, filter) {
    filter >>>= 0;
    if (!filter) return;
    for (const [handle, watch] of this.changeNotifications) {
      if (!(watch.filter & filter) || !this._changeMatches(watch, path)) continue;
      if (!watch.armed) {
        watch.pending = true;
        continue;
      }
      watch.armed = false;
      watch.signal(handle);
    }
  }

  nextChangeNotification(handle) {
    handle >>>= 0;
    const watch = this.changeNotifications.get(handle);
    if (!watch || !watch.reset(handle)) return false;
    if (watch.pending) {
      watch.pending = false;
      watch.armed = false;
      watch.signal(handle);
    } else {
      watch.armed = true;
    }
    return true;
  }

  closeChangeNotification(handle) {
    handle >>>= 0;
    const watch = this.changeNotifications.get(handle);
    if (!watch) return false;
    this.changeNotifications.delete(handle);
    return !!watch.close(handle);
  }

  createFile(path, access, creation) {
    let norm = this._resolvePath(path);
    const wantsWrite = creation !== 3 || (((access >>> 0) & 0x40000000) !== 0);
    if (wantsWrite && this._isReadOnlyPath(norm)) return 0;
    let exists = this.files.has(norm);
    // Basename fallback on every mode that would open an existing file — DX
    // games scan drive letters looking for their data CD; accept a match on
    // filename alone if the literal path misses. OPEN_ALWAYS (4) needs this as
    // badly as OPEN_EXISTING: without it a game that opens its archive that way
    // silently gets a brand-new empty file instead of the mounted one, and
    // reports the empty archive as a graphics-hardware fault (Age of Empires II
    // and its Data\*.drs).
    if (!exists && !wantsWrite && !norm.startsWith('c:') &&
        !this.dirs.has(this._parentDir(norm)) &&
        (creation === 3 || creation === 4 || creation === 5)) {
      const base = this._fileName(norm);
      for (const p of this.files.keys()) {
        if (this._fileName(p) === base) { norm = p; exists = true; break; }
      }
    }
    const oldSize = exists ? entrySize(this.files.get(norm)) : 0;
    let changeFilter = 0;
    // creation: 1=CREATE_NEW, 2=CREATE_ALWAYS, 3=OPEN_EXISTING, 4=OPEN_ALWAYS, 5=TRUNCATE_EXISTING
    switch (creation) {
      case 1: // CREATE_NEW
        if (exists) return 0; // fail, ERROR_FILE_EXISTS
        this.files.set(norm, createFileEntry(new Uint8Array(0), 0x80)); // FILE_ATTRIBUTE_NORMAL
        changeFilter = FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_LAST_WRITE;
        break;
      case 2: // CREATE_ALWAYS
        this.files.set(norm, createFileEntry(new Uint8Array(0), 0x80));
        changeFilter = exists
          ? FILE_NOTIFY_CHANGE_LAST_WRITE | (oldSize ? FILE_NOTIFY_CHANGE_SIZE : 0)
          : FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_LAST_WRITE;
        break;
      case 3: // OPEN_EXISTING
        if (!exists) return 0;
        break;
      case 4: // OPEN_ALWAYS
        if (!exists) {
          this.files.set(norm, createFileEntry(new Uint8Array(0), 0x80));
          changeFilter = FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_LAST_WRITE;
        }
        break;
      case 5: // TRUNCATE_EXISTING
        if (!exists) return 0;
        this.files.get(norm).data = new Uint8Array(0);
        delete this.files.get(norm)._capacityData;
        changeFilter = FILE_NOTIFY_CHANGE_LAST_WRITE | (oldSize ? FILE_NOTIFY_CHANGE_SIZE : 0);
        break;
      default:
        return 0;
    }
    const h = this._nextHandle;
    this._nextHandle = ((this._nextHandle + 1) & 0x7FFFFFFF) || 0xF0000001;  // wraparound
    this.handles.set(h, { path: norm, pos: 0, access });
    // Ensure every parent exists; archive caches commonly create the output
    // file before separately enumerating both parent levels.
    this.ensureParentDirs(norm);
    this._notifyChange(norm, changeFilter);
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
    // Provider-backed entry: serve the range straight out of the chunk cache
    // without materializing the file. A cache miss is reported as `pending`,
    // never as a short read — the caller (fs_read_file) turns it into an
    // IO_WAIT yield, fills the chunk, and re-enters this same call.
    if (!fh.readData && entry._provider) {
      // A fill that failed (or that kept failing to satisfy the same read) is
      // latched here, so the very next attempt completes the call as a Win32
      // read failure. Without the latch a dead provider is an infinite
      // park/retry loop, which presents as a hang with no error anywhere.
      const fault = this.readFaults.get(handle);
      if (fault && fault.pos === fh.pos) {
        this.readFaults.delete(handle);
        return { ok: false, bytesRead: 0, faulted: true, error: fault.error };
      }
      const avail = Math.max(0, entry._size - fh.pos);
      const toRead = Math.min(nToRead, avail);
      if (toRead === 0) return { ok: true, bytesRead: 0 };
      const bytes = providerReadSync(entry, fh.pos, toRead);
      if (!bytes) {
        const prev = this.pendingRead;
        // Same handle, same position, already parked: the host filled and the
        // read still cannot be served. Three rounds is generous for a chunk
        // cache whose fill is supposed to satisfy exactly this range.
        const again = prev && prev.handle === handle && prev.pos === fh.pos
          ? prev.attempts + 1 : 1;
        if (again > 3) {
          this.readFaults.set(handle, { pos: fh.pos, error: 30 /* ERROR_READ_FAULT */ });
          this.pendingRead = null;
          return { ok: false, bytesRead: 0, faulted: true, error: 30 };
        }
        return {
          ok: false,
          bytesRead: 0,
          pending: {
            provider: entry._provider,
            path: fh.path,
            handle,
            pos: fh.pos,
            attempts: again,
            offset: (entry._offset || 0) + fh.pos,
            length: toRead,
          },
        };
      }
      this.readFaults.delete(handle);
      buf.set(bytes.subarray(0, toRead));
      fh.pos += toRead;
      return { ok: true, bytesRead: toRead };
    }
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
      entry = createFileEntry(new Uint8Array(0), 0x80);
      this.files.set(fh.path, entry);
    }
    ensureFileTimes(entry);
    const oldSize = entry.data.length;
    const newEnd = fh.pos + nToWrite;
    let backing = entry._capacityData || entry.data;
    if (newEnd > backing.length) {
      // Grow geometrically. Archive decompressors write thousands of small
      // chunks; reallocating exactly to newEnd on each call is quadratic.
      let capacity = Math.max(1024, backing.length || 1);
      while (capacity < newEnd) capacity = Math.max(capacity * 2, newEnd);
      const grown = new Uint8Array(capacity);
      grown.set(entry.data);
      backing = grown;
    }
    if (fh.pos > oldSize) backing.fill(0, oldSize, fh.pos);
    backing.set(data.subarray(0, nToWrite), fh.pos);
    const logicalSize = Math.max(oldSize, newEnd);
    entry._capacityData = backing;
    entry.data = backing.subarray(0, logicalSize);
    fh.pos += nToWrite;
    if (nToWrite) {
      entry.lastWriteTime = currentFileTime();
      this._notifyChange(fh.path, FILE_NOTIFY_CHANGE_LAST_WRITE |
        (logicalSize !== oldSize ? FILE_NOTIFY_CHANGE_SIZE : 0));
    }
    return { ok: true, bytesWritten: nToWrite };
  }

  setFilePointer(handle, distance, moveMethod) {
    handle = handle >>> 0;
    const fh = this.handles.get(handle);
    if (!fh) return 0xFFFFFFFF; // INVALID_SET_FILE_POINTER
    const entry = this.files.get(fh.path);
    const size = fh.readData ? fh.readData.length : entrySize(entry);
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
    const oldSize = entry.data.length;
    const newSize = Math.max(0, fh.pos);
    if (newSize === oldSize) return true;
    let backing = entry._capacityData || entry.data;
    if (newSize > backing.length) {
      let capacity = Math.max(1024, backing.length || 1);
      while (capacity < newSize) capacity = Math.max(capacity * 2, newSize);
      const grown = new Uint8Array(capacity);
      grown.set(entry.data);
      backing = grown;
    }
    if (newSize > oldSize) backing.fill(0, oldSize, newSize);
    entry._capacityData = backing;
    entry.data = backing.subarray(0, newSize);
    ensureFileTimes(entry).lastWriteTime = currentFileTime();
    this._notifyChange(fh.path, FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_LAST_WRITE);
    return true;
  }

  // File bytes are committed to the in-memory VFS by writeFile itself, so a
  // flush has no deferred data to move. It still has the Win32-observable
  // validation contract: only a live writable disk-file handle can succeed.
  // Return an error code so the WAT handler can preserve BOOL/GetLastError.
  flushFileBuffers(handle) {
    handle >>>= 0;
    const fh = this.handles.get(handle);
    if (!fh || fh.closed || !this.files.has(fh.path)) return 6; // ERROR_INVALID_HANDLE
    if (this._isReadOnlyPath(fh.path) ||
        !((fh.access >>> 0) & 0x40000000)) {
      return 5; // ERROR_ACCESS_DENIED
    }
    return 0;
  }

  getFileTimes(handle) {
    handle >>>= 0;
    const fh = this.handles.get(handle);
    if (!fh) return { error: 6 }; // ERROR_INVALID_HANDLE
    const entry = this.files.get(fh.path);
    if (!entry) return { error: 6 };
    ensureFileTimes(entry);
    return {
      error: 0,
      creationTime: cloneFileTime(entry.creationTime),
      lastAccessTime: cloneFileTime(entry.lastAccessTime),
      lastWriteTime: cloneFileTime(entry.lastWriteTime),
    };
  }

  setFileTimes(handle, creationTime, lastAccessTime, lastWriteTime) {
    handle >>>= 0;
    const fh = this.handles.get(handle);
    if (!fh) return 6; // ERROR_INVALID_HANDLE
    if (this._isReadOnlyPath(fh.path) ||
        !((fh.access >>> 0) & (0x40000000 | 0x00000100))) {
      return 5; // ERROR_ACCESS_DENIED
    }
    const entry = this.files.get(fh.path);
    if (!entry) return 6;
    ensureFileTimes(entry);

    let changed = false;
    const assign = (key, value) => {
      if (!value || preserveFileTime(value) || sameFileTime(entry[key], value)) return;
      entry[key] = cloneFileTime(value);
      changed = true;
    };
    assign('creationTime', creationTime);
    assign('lastAccessTime', lastAccessTime);
    assign('lastWriteTime', lastWriteTime);
    if (changed) this._notifyChange(fh.path, FILE_NOTIFY_CHANGE_LAST_WRITE);
    return 0;
  }

  getFileSize(handle) {
    handle = handle >>> 0;
    const fh = this.handles.get(handle);
    if (!fh) return 0xFFFFFFFF;
    const entry = this.files.get(fh.path);
    return fh.readData ? fh.readData.length : entrySize(entry);
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
    if (entry) {
      if (entry.attrs !== attrs) {
        entry.attrs = attrs;
        this._notifyChange(norm, FILE_NOTIFY_CHANGE_ATTRIBUTES);
      }
      return true;
    }
    if (this.dirs.has(norm)) {
      this._notifyChange(norm, FILE_NOTIFY_CHANGE_ATTRIBUTES);
      return true;
    }
    return false;
  }

  _shellPathKind(path) {
    const norm = this._resolvePath(path);
    if (this.files.has(norm)) return 'file';
    if (this.dirs.has(norm) || this.dirs.has(norm + '\\')) return 'dir';
    return '';
  }

  _shellPathChildren(path) {
    const norm = this._resolvePath(path).replace(/\\$/, '');
    const prefix = norm + '\\';
    return {
      files: [...this.files.keys()].filter(item => item.startsWith(prefix)),
      dirs: [...this.dirs].filter(item =>
        item !== norm && item !== norm + '\\' && item.startsWith(prefix)),
    };
  }

  _shellUniqueDestination(path) {
    const norm = this._resolvePath(path);
    if (!this._shellPathKind(norm)) return norm;
    const parent = this._parentDir(norm);
    const name = this._fileName(norm);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 2; n < 10000; n++) {
      const candidate = `${parent}\\${stem} (${n})${ext}`;
      if (!this._shellPathKind(candidate)) return candidate;
    }
    return '';
  }

  _shellExpandSource(path, filesOnly) {
    const raw = String(path || '');
    const slash = Math.max(raw.lastIndexOf('\\'), raw.lastIndexOf('/'));
    const wildcard = Math.min(
      ...[raw.indexOf('*'), raw.indexOf('?')].filter(index => index >= 0));
    if (Number.isFinite(wildcard) && wildcard <= slash) return null;
    if (!Number.isFinite(wildcard)) {
      const norm = this._resolvePath(raw);
      return this._shellPathKind(norm) ? [norm] : [];
    }

    const norm = this._resolvePath(raw);
    const dir = this._parentDir(norm);
    const pattern = this._fileName(norm) === '*.*' ? '*' : this._fileName(norm);
    const regex = new RegExp('^' + pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    const found = [];
    for (const file of this.files.keys()) {
      if (this._parentDir(file) === dir && regex.test(this._fileName(file))) {
        found.push(file);
      }
    }
    if (!filesOnly) {
      for (const child of this.dirs) {
        if (child !== dir && this._parentDir(child) === dir &&
            regex.test(this._fileName(child))) found.push(child);
      }
    }
    found.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    return found;
  }

  _shellCopyPath(src, dst, recursive) {
    const srcKind = this._shellPathKind(src);
    const dstKind = this._shellPathKind(dst);
    if (srcKind === 'file') {
      if (dstKind === 'dir') return 0x80; // DE_FILEDESTISFLD
      if (this._isReadOnlyPath(dst)) return 0x10000 | 5;
      return this.copyFile(src, dst, false) ? 0 : 0x402;
    }
    if (srcKind !== 'dir') return 0x7C; // DE_INVALIDFILES
    if (dstKind === 'file') return 0x7E; // DE_FLDDESTISFILE
    const srcNorm = this._resolvePath(src).replace(/\\$/, '');
    const dstNorm = this._resolvePath(dst).replace(/\\$/, '');
    if (dstNorm.startsWith(srcNorm + '\\')) return 0x76; // DE_DESTSUBTREE
    if (this._isReadOnlyPath(dstNorm)) return 0x10000 | 5;

    const children = this._shellPathChildren(srcNorm);
    const dirs = recursive ? children.dirs : [];
    const files = children.files.filter(file =>
      recursive || this._parentDir(file) === srcNorm);
    for (const dir of dirs) {
      const target = dstNorm + dir.slice(srcNorm.length);
      if (this._shellPathKind(target) === 'file') return 0x7E;
    }
    for (const file of files) {
      const target = dstNorm + file.slice(srcNorm.length);
      if (this._shellPathKind(target) === 'dir') return 0x80;
      if (this._isReadOnlyPath(target)) return 0x10000 | 5;
    }

    this.ensureParentDirs(dstNorm);
    if (!this.dirs.has(dstNorm)) {
      this.dirs.add(dstNorm);
      this._notifyChange(dstNorm, FILE_NOTIFY_CHANGE_DIR_NAME);
    }
    for (const dir of dirs.sort((a, b) => a.length - b.length)) {
      const target = dstNorm + dir.slice(srcNorm.length);
      if (!this.dirs.has(target)) {
        this.dirs.add(target);
        this._notifyChange(target, FILE_NOTIFY_CHANGE_DIR_NAME);
      }
    }
    for (const file of files) {
      const target = dstNorm + file.slice(srcNorm.length);
      if (!this.copyFile(file, target, false)) return 0x402;
    }
    return 0;
  }

  _shellDeletePath(path, recursive) {
    const kind = this._shellPathKind(path);
    if (kind === 'file') {
      if (this._isReadOnlyPath(path)) return 0x78;
      return this.deleteFile(path) ? 0 : 0x402;
    }
    if (kind !== 'dir') return 0x7C;
    const norm = this._resolvePath(path).replace(/\\$/, '');
    if (/^[a-z]:$/i.test(norm)) return 0x74;
    if (this._isReadOnlyPath(norm)) return 0x78; // DE_ACCESSDENIEDSRC
    const children = this._shellPathChildren(norm);
    const files = children.files.filter(file =>
      recursive || this._parentDir(file) === norm);
    for (const file of files) {
      if (!this.deleteFile(file)) return 0x402;
    }
    if (!recursive && children.dirs.length) return 0x402;
    for (const dir of children.dirs.sort((a, b) => b.length - a.length)) {
      if (this.dirs.delete(dir)) this._notifyChange(dir, FILE_NOTIFY_CHANGE_DIR_NAME);
    }
    if (!this.dirs.delete(norm) && !this.dirs.delete(norm + '\\')) return 0x402;
    this._notifyChange(norm, FILE_NOTIFY_CHANGE_DIR_NAME);
    return 0;
  }

  _shellMovePath(src, dst, recursive) {
    const srcKind = this._shellPathKind(src);
    const dstKind = this._shellPathKind(dst);
    if (srcKind === 'file') {
      if (dstKind === 'dir') return 0x80;
      if (this._isReadOnlyPath(src)) return 0x78;
      if (this._isReadOnlyPath(dst)) return 0x10000 | 5;
      return this.moveFile(src, dst) ? 0 : 0x402;
    }
    if (srcKind !== 'dir') return 0x7C;
    if (dstKind === 'file') return 0x7E;
    const srcNorm = this._resolvePath(src).replace(/\\$/, '');
    const dstNorm = this._resolvePath(dst).replace(/\\$/, '');
    if (dstNorm.startsWith(srcNorm + '\\')) return 0x76;
    if (this._isReadOnlyPath(srcNorm)) return 0x78;
    if (this._isReadOnlyPath(dstNorm)) return 0x10000 | 5;
    const children = this._shellPathChildren(srcNorm);
    if (!recursive && (children.files.length || children.dirs.length)) return 0x402;
    const copied = this._shellCopyPath(srcNorm, dstNorm, recursive);
    if (copied) return copied;
    return this._shellDeletePath(srcNorm, recursive);
  }

  // Win9x SHFileOperation is the shell's bulk path mutator. The UI flags are
  // intentionally presentation-only here; the browser has no Explorer copy
  // dialog, but the requested filesystem effects and failure codes are real.
  shellFileOperation(func, fromPaths, toPaths, flags) {
    func >>>= 0;
    flags >>>= 0;
    if (![1, 2, 3, 4].includes(func) || !Array.isArray(fromPaths) ||
        fromPaths.length === 0 || fromPaths.some(path => !path || path.length >= 260) ||
        !Array.isArray(toPaths) || toPaths.some(path => !path || path.length >= 260)) {
      return 0x7C; // DE_INVALIDFILES
    }

    const sources = [];
    for (const path of fromPaths) {
      const expanded = this._shellExpandSource(path, !!(flags & 0x0080));
      if (expanded === null || expanded.length === 0) return 0x7C;
      for (const item of expanded) if (!sources.includes(item)) sources.push(item);
    }
    if (func === 3) {
      if (toPaths.length) return 0x7C;
      for (const source of sources) {
        const result = this._shellDeletePath(source, !(flags & 0x1000));
        if (result) return result;
      }
      return 0;
    }

    if (func === 4) {
      if (sources.length !== 1 || toPaths.length !== 1) return 0x72;
      const source = sources[0];
      let target = this._resolvePath(toPaths[0]);
      if (this._parentDir(source) !== this._parentDir(target)) return 0x73;
      if (source === target) return 0x71;
      if (this._shellPathKind(target) && (flags & 0x0008)) {
        target = this._shellUniqueDestination(target);
      }
      if (!target) return 0x402;
      return this._shellMovePath(source, target, !(flags & 0x1000));
    }

    if (toPaths.length === 0) return 0x7C;
    const pairs = [];
    if (flags & 0x0001) { // FOF_MULTIDESTFILES
      if (toPaths.length !== sources.length) return 0x7A; // DE_MANYDEST
      for (let i = 0; i < sources.length; i++) {
        pairs.push([sources[i], this._resolvePath(toPaths[i])]);
      }
    } else {
      if (toPaths.length !== 1) return 0x7A;
      let destination = this._resolvePath(toPaths[0]);
      const destinationIsDir = this._shellPathKind(destination) === 'dir' ||
        /[\\/]$/.test(toPaths[0]) || sources.length > 1;
      if (sources.length > 1 && this._shellPathKind(destination) === 'file') return 0x72;
      if (destinationIsDir && !this._shellPathKind(destination)) {
        this.ensureParentDirs(destination);
        this.dirs.add(destination);
        this._notifyChange(destination, FILE_NOTIFY_CHANGE_DIR_NAME);
      }
      for (const source of sources) {
        pairs.push([source, destinationIsDir
          ? destination.replace(/\\$/, '') + '\\' + this._fileName(source)
          : destination]);
      }
    }

    for (let [source, target] of pairs) {
      if (source === target) return 0x71;
      if (this._shellPathKind(target) && (flags & 0x0008)) {
        target = this._shellUniqueDestination(target);
      }
      if (!target) return 0x402;
      const result = func === 1
        ? this._shellMovePath(source, target, !(flags & 0x1000))
        : this._shellCopyPath(source, target, !(flags & 0x1000));
      if (result) return result;
    }
    return 0;
  }

  deleteFile(path) {
    const norm = this._resolvePath(path);
    if (this._isReadOnlyPath(norm)) return false;
    const deleted = this.files.delete(norm);
    if (deleted) this._notifyChange(norm, FILE_NOTIFY_CHANGE_FILE_NAME);
    return deleted;
  }

  createDirectory(path) {
    const norm = this._resolvePath(path);
    if (this._isReadOnlyPath(norm)) return false;
    if (this.dirs.has(norm)) return false; // already exists
    this.dirs.add(norm);
    // Ensure parent exists
    this.dirs.add(this._parentDir(norm));
    this._notifyChange(norm, FILE_NOTIFY_CHANGE_DIR_NAME);
    return true;
  }

  removeDirectory(path) {
    const norm = this._resolvePath(path);
    if (this._isReadOnlyPath(norm)) return false;
    const deleted = this.dirs.delete(norm);
    if (deleted) this._notifyChange(norm, FILE_NOTIFY_CHANGE_DIR_NAME);
    return deleted;
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
    this._notifyChange(normSrc, FILE_NOTIFY_CHANGE_FILE_NAME);
    this._notifyChange(normDst, FILE_NOTIFY_CHANGE_FILE_NAME);
    return true;
  }

  copyFile(src, dst, failIfExists) {
    const normSrc = this._resolvePath(src);
    const normDst = this._resolvePath(dst);
    if (this._isReadOnlyPath(normDst)) return false;
    const entry = this.files.get(normSrc);
    if (!entry) return false;
    const existed = this.files.has(normDst);
    if (failIfExists && existed) return false;
    const oldSize = existed ? entrySize(this.files.get(normDst)) : 0;
    const copy = {
      attrs: entry.attrs,
      creationTime: cloneFileTime(ensureFileTimes(entry).creationTime),
      lastAccessTime: cloneFileTime(entry.lastAccessTime),
      lastWriteTime: cloneFileTime(entry.lastWriteTime),
    };
    if (entry._provider) {
      // Copying off a mounted container shares the source's provider window
      // rather than pulling the bytes in. An installer copying a 600MB file
      // off a CD would otherwise materialize the whole extent here, which is
      // exactly what the lazy entry exists to avoid. The copy is still
      // independent: writing to either side drops that side's provider.
      copy._provider = entry._provider;
      copy._offset = entry._offset || 0;
      copy._size = entry._size;
      defineProviderData(copy, normDst);
    } else {
      copy.data = new Uint8Array(entry.data);
    }
    this.files.set(normDst, copy);
    this.dirs.add(this._parentDir(normDst));
    this._notifyChange(normDst,
      (existed ? 0 : FILE_NOTIFY_CHANGE_FILE_NAME) |
      FILE_NOTIFY_CHANGE_LAST_WRITE |
      (oldSize !== entrySize(entry) ? FILE_NOTIFY_CHANGE_SIZE : 0));
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

    // Win32/DOS wildcard semantics treat *.* as every entry, including names
    // with no dot (notably a CD's top-level data directory).
    const matchPat = pat === '*.*' ? '*' : pat;
    const regex = new RegExp('^' + matchPat.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');

    const collect = (searchDir) => {
      const found = [];
      // Win9x FindFirstFile exposes the filesystem's synthetic directory
      // records. Shells normally hide `.` and turn `..` into their parent row;
      // omitting both here left FAR with no way to navigate up. At a drive root
      // `..` resolves back to that root, but remains an enumerable record.
      if (this.dirs.has(searchDir)) {
        if (regex.test('.')) found.push({ name: '.', size: 0, attrs: 0x10 });
        if (regex.test('..')) found.push({ name: '..', size: 0, attrs: 0x10 });
      }
      // Search files
      for (const [path, entry] of this.files) {
        if (this._parentDir(path) === searchDir && regex.test(this._fileName(path))) {
          ensureFileTimes(entry);
          found.push({
            name: this._fileName(path), size: entrySize(entry), attrs: entry.attrs || 0x80,
            creationTime: cloneFileTime(entry.creationTime),
            lastAccessTime: cloneFileTime(entry.lastAccessTime),
            lastWriteTime: cloneFileTime(entry.lastWriteTime),
          });
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

    // DOSBox validates a host mount root with FindFirstFile("C:\\").  The
    // normal matcher treats the normalized drive root (`c:`) as both a parent
    // and a filename, so it can never find the root that is already present in
    // `dirs`.  Win32 accepts this drive-root probe; represent it as the same
    // directory result an exact lookup of any other directory would return.
    if (/^[a-z]:$/i.test(norm) && this.dirs.has(norm)) {
      results = [{ name: norm + '\\', size: 0, attrs: 0x10 }];
    } else {
      results = collect(dir);
    }

    // Directory-stripped wildcard fallback: some old demo/shareware layouts are
    // flat copies of media that the program searches via relative subfolders
    // (e.g. "campaign\\*.cpn"). If the requested relative directory does not
    // exist in the VFS, retry the same wildcard in the current directory.
    const broadWildcard = pat === '*' || pat === '*.*';
    if (results.length === 0 && relativePattern && !broadWildcard &&
        (pat.includes('*') || pat.includes('?')) && !this.dirs.has(dir)) {
      const cwdDir = /^[a-z]:\\$/i.test(this.cwd) ? this.cwd.toLowerCase() : this._normPath(this.cwd);
      results = collect(cwdDir);
    }

    // Host filesystem iteration order is platform-dependent and can produce
    // pathological Win32 enumerations like SC10, SC11, ... SC4, sc0, sc3.
    // Keep the synthetic directory records first, then use a deterministic
    // case-insensitive natural sort so game asset scans (notably RCT's
    // \Scenarios\*.SC4 walk) see a stable Windows-like order.
    if (results.length > 1) {
      results.sort((a, b) => (
        (a.name === '.' ? -2 : a.name === '..' ? -1 : 0) -
        (b.name === '.' ? -2 : b.name === '..' ? -1 : 0) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
      ));
    }

    // Basename fallback: DX games scan drive letters (D:\foo\file → Z:\foo\file) looking
    // for their data on whatever drive the CD is mounted as. If the literal path misses,
    // try matching just the filename anywhere in the VFS. Only for non-glob lookups.
    if (results.length === 0 && !pat.includes('*') && !pat.includes('?') &&
        !this.dirs.has(dir)) {
      for (const [path, entry] of this.files) {
        if (this._fileName(path) === pat) {
          ensureFileTimes(entry);
          results.push({
            name: pat, size: entrySize(entry), attrs: entry.attrs || 0x80,
            creationTime: cloneFileTime(entry.creationTime),
            lastAccessTime: cloneFileTime(entry.lastAccessTime),
            lastWriteTime: cloneFileTime(entry.lastWriteTime),
          });
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

  // Register a file that exists but whose bytes have not been read yet.
  // `load()` is called at most once, the first time anything touches .data,
  // and its result replaces the accessor with a plain property so every later
  // read is an ordinary Map lookup. Writing .data (truncate, write, setEndOfFile)
  // discards the loader the same way.
  //
  // The loader is injected rather than imported because this file also runs in
  // the browser, where there is no fs to lazily read from.
  setLazyFile(path, { attrs = 0x20, size = 0, load }) {
    const entry = ensureFileTimes({ attrs, _size: size });
    let data = null;
    Object.defineProperty(entry, 'data', {
      configurable: true,
      enumerable: true,
      get() {
        if (data === null) {
          data = load();
          entry._size = data.length;
        }
        return data;
      },
      set(v) {
        data = v;
        entry._size = v.length;
      },
    });
    this.files.set(this._normPath(path), entry);
    return entry;
  }

  // Mount a file whose bytes live behind a byte provider (lib/byte-provider.js)
  // — an ISO extent, a stored zip member, a dropped File, a remote URL read
  // over Range. `offset`/`length` carve the window out of the provider, so a
  // container mounts N files against one provider and one chunk cache.
  //
  // The provider is wrapped in a ChunkCache unless it already is one, because
  // the read path's synchronous `tryRead` is what the cache adds; a bare
  // provider has no synchronous shape to offer.
  setProviderFile(path, { provider, offset = 0, length, attrs = 0x20, chunkCache } = {}) {
    if (!provider) throw new Error('setProviderFile: no provider');
    const bp = chunkCache || _byteProvider();
    const cache = (provider.tryRead && provider.fill) ? provider
      : (bp ? bp.cached(provider) : null);
    if (!cache) {
      throw new Error('setProviderFile: lib/byte-provider.js is unavailable and ' +
        'the provider offers no tryRead/fill of its own');
    }
    const providerSize = providerWindowValue(cache.size, 'provider size');
    const start = providerWindowValue(offset, 'offset');
    if (start > providerSize) {
      throw new RangeError(`setProviderFile: offset ${start} exceeds provider size ${providerSize}`);
    }
    const available = providerSize - start;
    const size = length === undefined ? available : providerWindowValue(length, 'length');
    if (size > available) {
      throw new RangeError(`setProviderFile: window ${start}+${size} exceeds provider size ${providerSize}`);
    }
    const norm = this._normPath(path);
    const entry = ensureFileTimes({
      attrs,
      _provider: cache,
      _offset: start,
      _size: size,
    });
    defineProviderData(entry, norm);
    this.files.set(norm, entry);
    this.ensureParentDirs(norm);
    return entry;
  }

  // Async companion to a `pending` result from readFile(): pull the missing
  // chunk in, after which the identical call succeeds synchronously. The host
  // run loop awaits this while the guest is parked on the IO_WAIT yield.
  fillPendingRead(pending) {
    if (!pending || !pending.provider) return Promise.resolve(false);
    return pending.provider.fill(pending.offset, pending.length).then(
      () => { if (this.pendingRead === pending) this.pendingRead = null; return true; },
      err => {
        // A rejected fetch, a revoked File, a truncated Range response. Latch
        // the failure against this handle and position: the retried ReadFile
        // returns FALSE with ERROR_READ_FAULT rather than parking again.
        if (this.pendingRead === pending) this.pendingRead = null;
        this.readFaults.set(pending.handle, {
          pos: pending.pos, error: 30, message: String((err && err.message) || err),
        });
        return false;
      });
  }

  // Pull a provider-backed entry's bytes in and turn it into an ordinary
  // eager entry. Mount code calls this *before* handing a lazily mounted file
  // to a synchronous consumer that cannot use the ReadFile/MapViewOfFile park
  // path — see the contract note above defineProviderData. Resolves to the
  // materialized Uint8Array.
  async materialize(path) {
    const norm = this._resolvePath(path);
    const entry = this.files.get(norm);
    if (!entry) throw new Error(`materialize: no such file ${path}`);
    if (!entry._provider) return entry.data;
    const provider = entry._provider;
    const offset = entry._offset || 0;
    const size = entry._size;
    const out = new Uint8Array(size);
    const chunkSize = provider.provider && typeof provider.provider.readRange === 'function'
      ? MATERIALIZE_CHUNK_SIZE
      : Math.max(1, Math.min(MATERIALIZE_CHUNK_SIZE, provider.chunkSize || MATERIALIZE_CHUNK_SIZE));
    for (let off = 0; off < size; off += chunkSize) {
      const want = Math.min(chunkSize, size - off);
      const bytes = await providerReadAsync(provider, offset + off, want);
      if (!(bytes instanceof Uint8Array) || bytes.length !== want) {
        const got = bytes && typeof bytes.length === 'number' ? bytes.length : 'non-byte result';
        throw new Error(`materialize: short provider read @${offset + off}+${want} (got ${got})`);
      }
      out.set(bytes, off);
    }
    // A write/truncate may have replaced the provider while an async range was
    // in flight. Preserve that newer eager value instead of resurrecting the
    // old media bytes over it.
    if (entry._provider !== provider || (entry._offset || 0) !== offset || entry._size !== size) {
      return entry.data;
    }
    entry.data = out;
    return entry.data;
  }

  // Adopt another VFS's world: file entries, directories, and per-drive
  // metadata. A ShellExecute chain-launch (a CD launcher handing off to the
  // game its installer just wrote) boots a NEW process that must see the SAME
  // filesystem. Entry objects are shared, not copied — the caller is exiting,
  // and a provider-backed entry (a mounted ISO) has live state that cannot be
  // deep-copied anyway. Per-handle runtime state (open handles, finds,
  // pending reads) deliberately stays behind.
  adoptFrom(other) {
    for (const [path, entry] of other.files) this.files.set(path, entry);
    for (const dir of other.dirs) this.dirs.add(dir);
    for (const drive of other.readOnlyDrives) this.readOnlyDrives.add(drive);
    for (const key of ['volumeLabels', 'volumeSerials', 'driveTypes', 'volumeSizes']) {
      if (!(other[key] instanceof Map)) continue;
      if (!(this[key] instanceof Map)) this[key] = new Map();
      for (const [drive, value] of other[key]) this[key].set(drive, value);
    }
    this.cwd = other.cwd;
  }

  getTempPath() {
    return 'C:\\WINDOWS\\TEMP\\';
  }

  getTempFileName(dir, prefix, unique) {
    if (unique) return dir.replace(/\\$/, '') + '\\' + (prefix || 'tmp') + unique.toString(16) + '.tmp';
    const name = dir.replace(/\\$/, '') + '\\' + (prefix || 'tmp') + (this._tempCounter++).toString(16) + '.tmp';
    // Create the file
    const norm = this._normPath(name);
    this.files.set(norm, createFileEntry(new Uint8Array(0), 0x80));
    this._notifyChange(norm, FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_LAST_WRITE);
    return name;
  }

  getCurrentDirectory() {
    // GetCurrentDirectory preserves the trailing slash only for a drive root.
    // Keeping our internal separator on ordinary directories made FAR treat
    // every CWD as a root and suppress its synthetic `..` panel entry.
    return this.cwd.length > 3 && this.cwd.endsWith('\\')
      ? this.cwd.slice(0, -1)
      : this.cwd;
  }

  setCurrentDirectory(path) {
    const resolved = this._resolvePath(path);
    // SetCurrentDirectory succeeds only for an existing directory. Treating
    // arbitrary strings (including filenames and application-specific aliases)
    // as directories lets failed probes poison the process CWD.
    if (!this.dirs.has(resolved)) return false;
    this.cwd = resolved.endsWith('\\') ? resolved : resolved + '\\';
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
// The fixed memory map, generated from the `region.declare-fixed` forms in
// src/00-regions.wat (docs/watx-region-safety-design.md §6): $GUEST_BASE for the
// two address translations, and $VIRTUAL_BACKING_BASE for the ceiling the file
// mapping allocator must not cross — that one was an adjacency written as a
// number, which is precisely what a declared region is for.
var _regionMap = typeof require !== 'undefined' ? require('./region-map.generated')
  : (typeof self !== 'undefined' ? self.RegionMap : globalThis.RegionMap);

// Shared "who called me?" hint for trace logs. Walks the stack looking for dwords
// that are preceded by a valid call opcode (E8/FF) and formats them compactly.
function _frameHint(ctx) {
  try {
    const e = ctx.exports;
    const esp = e.get_esp() >>> 0;
    const imageBase = e.get_image_base();
    const dv = new DataView(ctx.getMemory());
    const ra = dv.getUint32(esp - imageBase + _regionMap.GUEST_BASE, true);
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

  // Win98's en-US OEM file API page is CP437. The VFS stores JavaScript
  // Unicode names, so narrow Kernel32 filename APIs decode on entry and encode
  // on return according to the process-wide SetFileApisToOEM/ANSI selection.
  // Shell APIs and named kernel objects deliberately keep their ANSI contract.
  const CP437_HIGH =
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
    'áíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
    '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
    'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00A0';
  const CP1252_CONTROLS =
    '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';
  const cp437Bytes = new Map(Array.from(CP437_HIGH,
    (char, index) => [char, index + 0x80]));
  const cp1252Bytes = new Map(Array.from(CP1252_CONTROLS,
    (char, index) => [char, index + 0x80]));
  if (vfs.fileApisAnsi === undefined) vfs.fileApisAnsi = true;

  const decodeFileApiByte = byte => {
    if (!vfs.fileApisAnsi) {
      return byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
    }
    return byte < 0x80 || byte >= 0xA0
      ? String.fromCharCode(byte)
      : CP1252_CONTROLS[byte - 0x80];
  };
  const encodeFileApiChar = char => {
    const code = char.charCodeAt(0);
    if (!vfs.fileApisAnsi) return code < 0x80 ? code : (cp437Bytes.get(char) || 0x3F);
    if (code < 0x80 || (code >= 0xA0 && code <= 0xFF)) return code;
    return cp1252Bytes.get(char) || 0x3F;
  };

  const readRawStrA = (wasmAddr, maxLen = 260) =>
    _mu3.readStrA(ctx.getMemory(), wasmAddr, maxLen);
  const readStrA = (wasmAddr, maxLen = 260) => {
    const raw = readRawStrA(wasmAddr, maxLen);
    let result = '';
    for (let i = 0; i < raw.length; i++) {
      const byte = raw.charCodeAt(i) & 0xFF;
      result += decodeFileApiByte(byte);
    }
    return result;
  };
  const readStrW = (wasmAddr, maxLen = 260) => _mu3.readStrW(ctx.getMemory(), wasmAddr, maxLen);
  const readStr = (wasmAddr, isWide) => isWide ? readStrW(wasmAddr) : readStrA(wasmAddr);

  // SHFileOperationA's PCZZSTR values are lists of MAX_PATH-bounded strings,
  // terminated by one additional NUL. Keep the aggregate bounded too: a bad
  // guest pointer must become DE_INVALIDFILES rather than a host-side scan.
  const readMultiStrA = (wasmAddr) => {
    if (!wasmAddr) return [];
    const mem = new Uint8Array(ctx.getMemory());
    const result = [];
    let cursor = wasmAddr >>> 0;
    let total = 0;
    while (total < 32768 && result.length < 1024) {
      if (cursor >= mem.length) return null;
      if (mem[cursor] === 0) return result;
      const chars = [];
      let terminated = false;
      for (let i = 0; i < 260 && total < 32768; i++, total++) {
        if (cursor >= mem.length) return null;
        const ch = mem[cursor++];
        if (ch === 0) {
          terminated = true;
          break;
        }
        chars.push(ch);
      }
      if (!terminated || chars.length >= 260) return null;
      result.push(String.fromCharCode(...chars));
    }
    return null;
  };

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

  // Change-notification handles are ordinary process wait objects owned by
  // ThreadManager. The VFS owns only their directory/filter/latch metadata.
  // Keep callbacks late-bound because hosts create ThreadManager after this
  // import table.
  const changeCallbacks = {
    signal: handle => !!(ctx.signalSyncHandle && ctx.signalSyncHandle(handle >>> 0)),
    reset: handle => !!(ctx.resetSyncHandle && ctx.resetSyncHandle(handle >>> 0)),
    close: handle => !!(ctx.closeSyncHandle && ctx.closeSyncHandle(handle >>> 0)),
  };

  const writeStrA = (guestAddr, str) => {
    const total = str.length + 1;
    let offset = 0;
    while (offset < total) {
      const chunk = guestChunk(guestAddr + offset, total - offset);
      for (let i = 0; i < chunk.len; i++) {
        const pos = offset + i;
        if (pos >= str.length) {
          chunk.view[i] = 0;
        } else {
          chunk.view[i] = encodeFileApiChar(str[pos]);
        }
      }
      offset += chunk.len;
    }
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
    const total = (str.length + 1) * 2;
    let offset = 0;
    while (offset < total) {
      const chunk = guestChunk(guestAddr + offset, total - offset);
      for (let i = 0; i < chunk.len; i++) {
        const bytePos = offset + i;
        const charPos = bytePos >>> 1;
        const value = charPos < str.length ? str.charCodeAt(charPos) : 0;
        chunk.view[i] = (bytePos & 1) ? value >>> 8 : value & 0xFF;
      }
      offset += chunk.len;
    }
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
    const writeFileTime = (offset, value) => {
      if (!value) return;
      dv.setUint32(wa + offset, value.lo >>> 0, true);
      dv.setUint32(wa + offset + 4, value.hi >>> 0, true);
    };
    writeFileTime(4, entry.creationTime);
    writeFileTime(12, entry.lastAccessTime);
    writeFileTime(20, entry.lastWriteTime);
    // nFileSizeHigh at offset 28
    dv.setUint32(wa + 28, 0, true);
    // nFileSizeLow at offset 32
    dv.setUint32(wa + 32, entry.size, true);
    // cFileName at offset 44 (ANSI: 260 bytes, Wide: 520 bytes)
    if (isWide) {
      for (let i = 0; i < entry.name.length; i++)
        dv.setUint16(wa + 44 + i * 2, entry.name.charCodeAt(i), true);
    } else {
      for (let i = 0; i < entry.name.length; i++) {
        mem[wa + 44 + i] = encodeFileApiChar(entry.name[i]);
      }
    }
  };

  // File mappings: mapping handle → { fileHandle, data ref }
  const _mappings = new Map();
  let _nextMappingHandle = 0xFB000001;
  // MapViewOfFile allocations: base addr → size (for UnmapViewOfFile)
  const _mappedViews = new Map();
  // A provider-backed read-only mapping is filled while the guest is parked
  // on IO_WAIT, then returned when the identical MapViewOfFile retries. Keep
  // the provider entry lazy: large CD archives otherwise exist once in the
  // browser heap and again in guest memory for no useful reason.
  const _completedProviderMaps = new Map();
  const _failedProviderMaps = new Set();

  // Copy a run of a mapped view back onto whatever backs the section: the VFS
  // file for a file-backed mapping, the section's own bytes for a pagefile
  // one (a named anonymous section is how two guest components share state,
  // so its writes have to land somewhere the next MapViewOfFile can read).
  // Both UnmapViewOfFile and FlushViewOfFile are this operation over a
  // different span, which is why it is not written twice.
  const syncMappedView = (base, from, view, bytes) => {
    // FILE_MAP_READ and FILE_MAP_COPY views never write through to the file.
    // In particular, a read-only provider mapping has no eager entry.data to
    // receive a writeback and must stay provider-backed after it is unmapped.
    if (!(view.access & 2)) return;
    const mapping = _mappings.get(view.hMapping);
    if (!mapping) return;
    const dest = mapping.anon || (() => {
      const entry = vfs.files.get(mapping.filePath);
      return entry ? entry.data : null;
    })();
    if (!dest) return;
    const destOffset = view.offset + (from - base);
    const toSync = Math.min(bytes, dest.length - destOffset);
    if (toSync <= 0) return;
    // Same split as the map side: a sparse-backed view is not one contiguous
    // run in linear memory.
    let synced = 0;
    while (synced < toSync) {
      const chunk = guestChunk(from + synced, toSync - synced);
      dest.set(chunk.view, destOffset + synced);
      synced += chunk.len;
    }
  };

  // Bump allocator for file mappings — uses free WASM space above DLL table
  // These are WASM addresses; converted to guest addresses via w2g.
  const MAP_ALLOC_BASE = 0x07992400; // after 8MB PE staging + DLL metadata
  // End of the direct guest window: sparse VirtualAlloc backing starts here, so
  // the limit IS the next region's base and is read from it rather than retyped.
  const MAP_ALLOC_END  = _regionMap.BASE.VIRTUAL_BACKING_BASE;
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
    return exports ? exports.get_image_base() - _regionMap.GUEST_BASE : 0;
  };

  const INVALID_HANDLE = 0xFFFFFFFF;
  const _traceFs = () => ctx.trace && ctx.trace.has('fs');

  return {
    // mode -1 queries; 0 selects OEM; 1 selects ANSI. Keeping the state on
    // the shared VFS makes this process-wide across real guest Workers.
    fs_file_api_ansi: mode => {
      if ((mode | 0) >= 0) vfs.fileApisAnsi = !!mode;
      return vfs.fileApisAnsi ? 1 : 0;
    },

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
        // Win9x SearchPath(NULL, ...) includes the system and Windows
        // directories. Stock SHELL32 relies on that contract when its icon
        // cache expands the bare module name "shell32.dll" before opening the
        // PE resources. Omitting these locations makes an installed system
        // DLL look absent and turns the shell's icon/attribute result into -1.
        candidates.push('c:\\windows\\system\\' + nm);
        candidates.push('c:\\windows\\' + nm);
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
        // SearchPath reports the size it needs and writes NOTHING when the
        // caller's buffer is too small. Writing anyway overruns whatever the
        // caller sized -- usually a stack buffer -- and the damage surfaces
        // later as a return into garbage, which is how CD Player died.
        if (bufGA && full.length + 1 > (bufLen >>> 0)) {
          if (_traceFs()) console.log(`[fs] SearchPath buffer too small: need ${full.length + 1}, have ${bufLen >>> 0}`);
          return full.length + 1;
        }
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
        const dirs = ['', 'c:\\windows\\system\\', 'c:\\windows\\'];
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
      vfs.pendingRead = null;
      vfs.readFault = 0;
      while (moved < nToRead) {
        const { view, len } = guestChunk((bufGA + moved) >>> 0, nToRead - moved);
        const r = vfs.readFile(handle, view, len);
        if (r.faulted) {
          // A lazy fill failed for good. Complete the call as a Win32 read
          // failure — never as a park, and never as a short read.
          vfs.pendingRead = null;
          vfs.readFault = r.error || 30;
          if (nReadGA) gs32(nReadGA, 0);
          return 0;
        }
        if (r.pending) {
          // A provider-backed file whose chunk is not resident. Report zero
          // bytes and hand the guest back unread: $handle_ReadFile sees the
          // pending flag, restores its stdcall frame and parks on the IO_WAIT
          // yield, the host fills the chunk, and this exact call runs again.
          // Bytes already gathered by earlier iterations of this loop are
          // rewound rather than reported: the retry redoes the whole call, so
          // the file position has to be exactly where it was on entry.
          // Reporting a partial count instead would be indistinguishable from
          // end-of-file, which is the failure this whole path exists to avoid.
          const fhPending = vfs.handles.get(handle >>> 0);
          if (fhPending && bytesRead) fhPending.pos -= bytesRead;
          vfs.pendingRead = r.pending;
          if (nReadGA) gs32(nReadGA, 0);
          return 0;
        }
        if (!r.ok) { ok = false; break; }
        bytesRead += r.bytesRead;
        moved += len;
        if (r.bytesRead < len) break;   // hit end of file
      }
      if (nReadGA) gs32(nReadGA, bytesRead);
      // Filling the buffer from JS skips every store handler, so nothing has
      // retired the decoded blocks that used to live in those bytes. Storm
      // keeps its generated code and its MPQ read buffers in the same heap
      // region, so a read can land on a page holding cached code.
      if (bytesRead && ctx.exports && ctx.exports.invalidate_code_range) {
        ctx.exports.invalidate_code_range(bufGA >>> 0, bytesRead);
      }
      if (fhDbg) {
        console.log(`[FS] ReadFile(h=0x${(handle>>>0).toString(16)}, buf=0x${(bufGA>>>0).toString(16)}, n=0x${nToRead.toString(16)}, read=0x${bytesRead.toString(16)}, pos=0x${posBefore.toString(16)}, path=${fhDbg.path})`);
      }
      return ok ? 1 : 0;
    },

    // Did the fs_read_file that just returned 0 fail, or is it merely waiting
    // on bytes? Only ReadFile asks, and only on a zero return. A separate
    // question needs a separate channel: every i32 the read could return is
    // already spoken for (0 = failed, non-zero = succeeded, and several other
    // WAT call sites treat the result as a plain BOOL), so overloading it
    // would turn a park into a silent read failure at those sites.
    // 1 = park and retry, 2 = a lazy fill failed for good (ReadFile completes
    // FALSE with ERROR_READ_FAULT), 0 = an ordinary read failure.
    fs_read_pending: () => (vfs.pendingRead ? 1 : (vfs.readFault ? 2 : 0)),

    fs_write_file: (handle, bufGA, nToWrite, nWrittenGA) => {
      const fhDbg = _traceFs() ? vfs.handles.get(handle >>> 0) : null;
      const posBefore = fhDbg ? fhDbg.pos : -1;
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
      if (_traceFs()) {
        const entry = fhDbg ? vfs.files.get(fhDbg.path) : null;
        console.log(`[fs] WriteFile(h=0x${(handle>>>0).toString(16)}, n=0x${nToWrite.toString(16)}, wrote=0x${ok ? nToWrite.toString(16) : '0'}, pos=0x${posBefore.toString(16)}, size=0x${entry ? entry.data.length.toString(16) : '0'}, path=${fhDbg ? fhDbg.path : '?'})`);
      }
      // Report the caller's source byte count even if compatibility rewriting
      // changes the stored stream length.
      if (nWrittenGA) gs32(nWrittenGA, ok ? nToWrite : 0);
      return ok ? 1 : 0;
    },

    // FlushFileBuffers is synchronous from the guest's point of view. VFS
    // writes already update their backing entry before WriteFile returns, so
    // this bridge reports the remaining observable result: validation/error.
    fs_flush_file_buffers: (handle) => {
      const error = vfs.flushFileBuffers(handle);
      if (_traceFs()) {
        console.log(`[fs] FlushFileBuffers(h=0x${(handle >>> 0).toString(16)}) → ${error ? `FAIL error=${error}` : 'ok'}`);
      }
      return error;
    },

    fs_close_handle: (handle) => {
      // File handles and kernel synchronization handles share Win32's
      // CloseHandle entry point.  Let the process scheduler release an event
      // or semaphore slot before falling through to ordinary VFS bookkeeping.
      if (vfs.changeNotifications.has(handle >>> 0)) {
        return vfs.closeChangeNotification(handle) ? 1 : 0;
      }
      if (ctx.closeSyncHandle && ctx.closeSyncHandle(handle >>> 0)) return 1;
      return vfs.closeHandle(handle) ? 1 : 0;
    },

    fs_set_file_pointer: (handle, distance, moveMethod) => {
      const fhDbg = _traceFs() ? vfs.handles.get(handle >>> 0) : null;
      const posBefore = fhDbg ? fhDbg.pos : -1;
      const result = vfs.setFilePointer(handle, distance, moveMethod);
      if (_traceFs()) {
        console.log(`[fs] SetFilePointer(h=0x${(handle>>>0).toString(16)}, distance=${distance | 0}, method=${moveMethod}, pos=0x${posBefore.toString(16)}) → 0x${(result>>>0).toString(16)} path=${fhDbg ? fhDbg.path : '?'}`);
      }
      return result;
    },

    fs_set_end_of_file: (handle) => {
      const fhDbg = _traceFs() ? vfs.handles.get(handle >>> 0) : null;
      const ok = vfs.setEndOfFile(handle);
      if (_traceFs()) {
        const entry = fhDbg ? vfs.files.get(fhDbg.path) : null;
        console.log(`[fs] SetEndOfFile(h=0x${(handle>>>0).toString(16)}) → ${ok ? 'ok' : 'FAIL'} size=0x${entry ? entry.data.length.toString(16) : '0'} path=${fhDbg ? fhDbg.path : '?'}`);
      }
      return ok ? 1 : 0;
    },

    fs_get_file_size: (handle) => {
      const sz = vfs.getFileSize(handle);
      if (ctx.log) ctx.log(`[FS] GetFileSize(0x${(handle>>>0).toString(16)}) → ${sz}`);
      return sz;
    },

    // GetFileTime / SetFileTime share one synchronous host bridge. Pointers
    // are WASM addresses (or zero); the return value is a Win32 error code so
    // the WAT handlers can preserve BOOL plus GetLastError semantics.
    fs_file_time: (handle, set, creationWA, accessWA, writeWA) => {
      const dv = new DataView(ctx.getMemory());
      const readTime = wa => wa ? {
        lo: dv.getUint32(wa, true),
        hi: dv.getUint32(wa + 4, true),
      } : null;
      const writeTime = (wa, value) => {
        if (!wa || !value) return;
        dv.setUint32(wa, value.lo >>> 0, true);
        dv.setUint32(wa + 4, value.hi >>> 0, true);
      };

      if (set) {
        return vfs.setFileTimes(handle,
          readTime(creationWA), readTime(accessWA), readTime(writeWA));
      }
      const result = vfs.getFileTimes(handle);
      if (result.error) return result.error;
      writeTime(creationWA, result.creationTime);
      writeTime(accessWA, result.lastAccessTime);
      writeTime(writeWA, result.lastWriteTime);
      return 0;
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
      const ok = vfs.createDirectory(path);
      if (_traceFs()) console.log(`[fs] CreateDirectory("${path}") → ${ok ? 'created' : 'failed'}`);
      return ok ? 1 : 0;
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

    fs_shell_file_operation: (fromWA, toWA, func, flags) => {
      const from = readMultiStrA(fromWA);
      const to = readMultiStrA(toWA);
      if (!from || !to) return 0x7C; // DE_INVALIDFILES
      const result = vfs.shellFileOperation(func, from, to, flags);
      if (_traceFs()) {
        console.log(`[fs] SHFileOperation(${func}, ${JSON.stringify(from)}, ` +
          `${JSON.stringify(to)}, 0x${(flags >>> 0).toString(16)}) → 0x${result.toString(16)}`);
      }
      return result;
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

    fs_register_change_notification: (handle, pathWA, watchSubtree, filter, isWide) => {
      const path = readStr(pathWA, isWide);
      return vfs.registerChangeNotification(
        handle, path, watchSubtree, filter, changeCallbacks) ? 1 : 0;
    },

    fs_next_change_notification: handle =>
      vfs.nextChangeNotification(handle) ? 1 : 0,

    fs_close_change_notification: handle =>
      vfs.closeChangeNotification(handle) ? 1 : 0,

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
      const ok = vfs.setCurrentDirectory(path);
      if (_traceFs()) console.log(`[fs] SetCurrentDirectory("${path}") → ${ok ? `"${vfs.getCurrentDirectory()}"` : 'FAIL'}`);
      return ok ? 1 : 0;
    },

    fs_get_full_path_name: (fileWA, bufSize, bufGA, filePartGA, isWide) => {
      const file = readStr(fileWA, isWide);
      // RtlGetFullPathName_U treats an empty filename as invalid.  Resolving it
      // against the current directory fabricates "C:" and lets optional empty
      // installer paths overwrite unrelated path fields with the drive name.
      if (!file) {
        return 0;
      }
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
      const name = nameWA ? readRawStrA(nameWA) : '';
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
      const name = nameWA ? readRawStrA(nameWA) : '';
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
      vfs.pendingRead = null;
      vfs.readFault = 0;
      const entry = mapping.filePath ? vfs.files.get(mapping.filePath) : null;
      if (!mapping.anon && !entry) return 0;
      const offset = offsetLo >>> 0; // high offsets exceed the supported media ceiling
      if (offsetHi) return 0;
      const dataSize = mapping.anon ? mapping.anon.length
        : (entry._provider ? entry._size : entry.data.length);
      const mapSize = (size >>> 0) || (dataSize - offset);
      if (mapSize <= 0) return 0;

      const requestKey = `${hMapping >>> 0}:${access >>> 0}:${offset}:${mapSize}`;
      if (_completedProviderMaps.has(requestKey)) {
        const completed = _completedProviderMaps.get(requestKey);
        _completedProviderMaps.delete(requestKey);
        return completed;
      }
      if (_failedProviderMaps.has(requestKey)) {
        _failedProviderMaps.delete(requestKey);
        vfs.readFault = 30; // ERROR_READ_FAULT, observed through fs_read_pending
        return 0;
      }

      // A writable mapping needs eager bytes for FlushViewOfFile/UnmapViewOfFile
      // writeback. A read-only mapping can stream straight into its guest view.
      if (entry && entry._provider) {
        const provider = entry._provider;
        const providerOffset = (entry._offset || 0) + offset;
        const sourceSize = Math.min(mapSize, Math.max(0, dataSize - offset));
        const mapAlloc = ctx.exports.guest_map_alloc || ctx.exports.guest_alloc;
        const guestAddr = (access & 2) ? 0 : mapAlloc(mapSize);
        if (!(access & 2) && !guestAddr) return 0;
        const pending = {
          handle: hMapping >>> 0,
          pos: offset,
          path: mapping.filePath,
          offset: providerOffset,
          length: sourceSize,
          provider: {
            fill: async () => {
              try {
                if (access & 2) {
                  await vfs.materialize(mapping.filePath);
                  return;
                }
                for (let copied = 0; copied < sourceSize;) {
                  const want = Math.min(MATERIALIZE_CHUNK_SIZE, sourceSize - copied);
                  const bytes = await providerReadAsync(provider, providerOffset + copied, want);
                  if (!(bytes instanceof Uint8Array) || bytes.length !== want) {
                    const got = bytes && typeof bytes.length === 'number'
                      ? bytes.length : 'non-byte result';
                    throw new Error(`MapViewOfFile: short provider read ` +
                      `@${providerOffset + copied}+${want} (got ${got})`);
                  }
                  let moved = 0;
                  while (moved < bytes.length) {
                    const chunk = guestChunk(guestAddr + copied + moved, bytes.length - moved);
                    chunk.view.set(bytes.subarray(moved, moved + chunk.len));
                    moved += chunk.len;
                  }
                  copied += want;
                }
                _mappedViews.set(guestAddr,
                  { size: mapSize, hMapping, offset, access: access >>> 0 });
                _completedProviderMaps.set(requestKey, guestAddr);
                if (ctx.log) ctx.log(`[FS] MapViewOfFile async → guest ` +
                  `0x${guestAddr.toString(16)} (${(mapSize / 1024) | 0}KB, ` +
                  `file=${mapping.filePath})`);
                if (_traceFs()) console.log(`[fs] MapViewOfFile async → ` +
                  `0x${guestAddr.toString(16)} size=0x${mapSize.toString(16)} ` +
                  `path=${mapping.filePath}`);
              } catch (error) {
                _failedProviderMaps.add(requestKey);
                throw error;
              }
            },
          },
        };
        vfs.pendingRead = pending;
        return 0;
      }

      // A pagefile-backed section carries its bytes directly; an eager
      // file-backed entry does too.
      const data = mapping.anon || entry.data;

      // Allocate via guest heap (VirtualAlloc-style page-aligned bump)
      // so mapped memory stays in low guest address space, away from
      // emulator-private regions (thunks, thread cache, etc.)
      const mapAlloc = ctx.exports.guest_map_alloc || ctx.exports.guest_alloc;
      const guestAddr = mapAlloc(mapSize);
      if (!guestAddr) return 0;
      // Copy data into WASM memory. HeapAlloc starts in the low direct guest
      // window but spills to sparse high chunks once that window reaches
      // emulator-private memory, and those chunks are contiguous to the guest
      // yet NOT in linear memory -- so translate per run instead of computing
      // one naive `guestAddr + (GUEST_BASE - image_base)` base. RollerCoaster
      // Tycoon maps a multi-megabyte scenario, landed in a sparse chunk, and
      // the naive address pointed past the end of memory: Uint8Array.set threw
      // "offset is out of bounds" and killed the run.
      const src = data.subarray(offset, offset + mapSize);
      let copied = 0;
      while (copied < src.length) {
        const chunk = guestChunk(guestAddr + copied, src.length - copied);
        chunk.view.set(src.subarray(copied, copied + chunk.len));
        copied += chunk.len;
      }

      _mappedViews.set(guestAddr, { size: mapSize, hMapping, offset, access: access >>> 0 });
      if (ctx.log) ctx.log(`[FS] MapViewOfFile → guest 0x${guestAddr.toString(16)} (${(mapSize/1024)|0}KB, ${mapping.anon ? 'pagefile' : 'file=' + mapping.filePath})`);
      return guestAddr;
    },

    // UnmapViewOfFile(baseAddr) → BOOL
    fs_unmap_view: (baseAddr) => {
      const view = _mappedViews.get(baseAddr);
      if (view) {
        syncMappedView(baseAddr, baseAddr, view, view.size);
        _mappedViews.delete(baseAddr);
        if (ctx.log) ctx.log(`[FS] UnmapViewOfFile(0x${baseAddr.toString(16)}) - synced and freed`);
      }
      return 1;
    },

    // FlushViewOfFile(lpBaseAddress, dwNumberOfBytesToFlush) → BOOL.
    //
    // The same writeback UnmapViewOfFile does, without giving the view up: an
    // app that keeps a mapping open for the length of a session (Kodak Imaging
    // holds one over its thumbnail cache) calls this to make its edits durable
    // and carries on writing through the same pointer. lpBaseAddress may point
    // anywhere *inside* a view, and 0 bytes means "to the end of the view",
    // both per MSDN.
    fs_flush_view: (baseAddr, bytes) => {
      baseAddr >>>= 0; bytes >>>= 0;
      for (const [base, view] of _mappedViews) {
        if (baseAddr < base || baseAddr >= base + view.size) continue;
        const span = bytes ? Math.min(bytes, base + view.size - baseAddr)
                           : base + view.size - baseAddr;
        syncMappedView(base, baseAddr, view, span);
        if (ctx.log) ctx.log(`[FS] FlushViewOfFile(0x${baseAddr.toString(16)}, ${span}B) - synced`);
        return 1;
      }
      // Not inside any view we handed out. Win32 fails this with
      // ERROR_INVALID_ADDRESS rather than pretending it wrote something.
      if (ctx.log) ctx.log(`[FS] FlushViewOfFile(0x${baseAddr.toString(16)}) - not a mapped view`);
      return 0;
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
      // Just copy long → short (no 8.3 conversion needed in virtual FS).
      // The buffer contract still holds: a caller passing NULL, or a buffer
      // one character too small, is asking how much to allocate, and Win32
      // answers with the length *including* the terminator and writes nothing.
      const long = readStr(longWA, isWide);
      if (!shortGA || bufSize <= long.length) return long.length + 1;
      return writeStr(shortGA, long, isWide);
    },
  };
}

// Export for Node.js and browser
if (typeof module !== 'undefined') {
  module.exports = { createFilesystemImports, VirtualFS, expandRtfStylesheet, VfsPendingError };
}
if (typeof window !== 'undefined') {
  window.FilesystemImports = { createFilesystemImports, VirtualFS, expandRtfStylesheet, VfsPendingError };
}
