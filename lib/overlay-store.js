// Async persistence repository for the writable C:\ overlay.
//
// Phase ⑤ of docs/design-byo-media.md — see its "Overlay semantics" section
// for the contract this file implements the storage half of.
//
// The overlay tracker (lib/vfs-overlay.js) decides *what* changed; a store
// decides *where those bytes live*. Four async methods, deliberately small,
// because there are three backends with nothing else in common:
//
//   memoryStore()      tests, the CLI without --overlay-dir, and the private-
//                      browsing fallback where OPFS does not exist
//   nodeDirStore(dir)  the CLI's --overlay-dir=DIR: an installer can be run
//                      headlessly, and a second process proves the tree
//                      survived
//   opfsStore(scope)   browser OPFS, one isolated journal per kept import
//
// The interface:
//
//   list()              -> Promise<Array<record>>        metadata, no bytes
//   read(path)          -> Promise<Uint8Array|null>      one file's bytes
//   writeBatch(records) -> Promise<{written, removed}>   upsert a batch
//   remove(path)        -> Promise<void>                 forget a record
//
// A record is {path, kind, attrs, size, creationTime, lastAccessTime,
// lastWriteTime}, with `data` present on the way *in* for kind 'file'.
// `kind` is 'file' | 'dir' | 'whiteout'.
//
// Dual-environment (module.exports + window.OverlayStore) like
// lib/vfs-persistence.js: memoryStore and assertStore run in the browser, the
// Node store is required lazily so the page never pulls `fs` in.

(function () {
  const KINDS = new Set(['file', 'dir', 'whiteout']);
  const STORE_METHODS = ['list', 'read', 'writeBatch', 'remove'];
  const INDEX_VERSION = 1;

  // A store handed in from outside (the browser's OPFS one) is validated at
  // attach time. A half-wired backend must fail here, loudly, and not at the
  // moment somebody reloads and finds their install gone.
  function assertStore(store, label) {
    const what = label ? `${label}: ` : '';
    if (!store || typeof store !== 'object') {
      throw new Error(`${what}overlay store must be an object with ` +
        `${STORE_METHODS.join('/')}`);
    }
    for (const name of STORE_METHODS) {
      if (typeof store[name] !== 'function') {
        throw new Error(`${what}overlay store is missing ${name}() — ` +
          `see docs/design-byo-media.md "Overlay semantics"`);
      }
    }
    return store;
  }

  function normalizeKind(kind) {
    if (!KINDS.has(kind)) {
      throw new Error(`overlay record kind must be one of ${[...KINDS].join('/')}, got ${kind}`);
    }
    return kind;
  }

  function fileTime(value) {
    if (!value || !Number.isFinite(value.lo) || !Number.isFinite(value.hi)) return null;
    return { lo: value.lo >>> 0, hi: value.hi >>> 0 };
  }

  // Metadata only. The bytes travel separately so a listing of a 600MB
  // installed tree costs a directory read, not a heap of Uint8Arrays.
  function metaOf(record) {
    const rawSize = record.kind === 'file'
      ? (record.data ? record.data.length : (record.size == null ? 0 : Number(record.size)))
      : 0;
    if (!Number.isSafeInteger(rawSize) || rawSize < 0) {
      throw new RangeError(`overlay record size must be a non-negative safe integer, got ${record.size}`);
    }
    return {
      path: String(record.path),
      kind: normalizeKind(record.kind),
      attrs: (record.attrs >>> 0) || 0,
      size: rawSize,
      creationTime: fileTime(record.creationTime),
      lastAccessTime: fileTime(record.lastAccessTime),
      lastWriteTime: fileTime(record.lastWriteTime),
    };
  }

  // ---------------------------------------------------------------- memory

  function memoryStore() {
    const meta = new Map();   // path -> record metadata
    const bytes = new Map();  // path -> Uint8Array

    return {
      kind: 'memory',
      list() {
        return Promise.resolve([...meta.values()].map(r => ({ ...r })));
      },
      read(path) {
        const found = bytes.get(String(path));
        return Promise.resolve(found ? new Uint8Array(found) : null);
      },
      writeBatch(records) {
        let written = 0;
        for (const record of records || []) {
          const entry = metaOf(record);
          meta.set(entry.path, entry);
          if (entry.kind === 'file') {
            bytes.set(entry.path, new Uint8Array(record.data || new Uint8Array(0)));
          } else {
            bytes.delete(entry.path);
          }
          written++;
        }
        return Promise.resolve({ written, removed: 0 });
      },
      remove(path) {
        const key = String(path);
        meta.delete(key);
        bytes.delete(key);
        return Promise.resolve();
      },
    };
  }

  // ------------------------------------------------------------- node fs

  // Blobs are named by a hash of the guest path rather than by the path
  // itself: guest paths carry ':' and '\' and can exceed a host filename
  // limit, and the index already holds the real name.
  function blobName(path) {
    const crypto = require('crypto');
    return crypto.createHash('sha1').update(path, 'utf8').digest('hex') + '.bin';
  }

  function nodeDirStore(dir, options) {
    options = options || {};
    const fs = require('fs');
    const nodePath = require('path');
    const root = nodePath.resolve(dir);
    const blobDir = nodePath.join(root, 'blobs');
    const indexPath = nodePath.join(root, 'index.json');
    const tmpPath = indexPath + '.tmp';
    const log = typeof options.log === 'function' ? options.log : () => {};

    let index = null; // path -> record metadata

    function loadIndex() {
      if (index) return index;
      index = new Map();
      let raw;
      try {
        raw = fs.readFileSync(indexPath, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return index;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== INDEX_VERSION || !Array.isArray(parsed.records)) {
        throw new Error(`overlay index ${indexPath} is not a version ${INDEX_VERSION} index`);
      }
      for (const record of parsed.records) index.set(record.path, record);
      return index;
    }

    // Blobs first, index last, and the index through a rename: a torn flush
    // loses the newest batch and never the index itself.
    function saveIndex() {
      const records = [...loadIndex().values()];
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify({ version: INDEX_VERSION, records }, null, 1));
      fs.renameSync(tmpPath, indexPath);
    }

    return {
      kind: 'node-dir',
      dir: root,
      list() {
        try {
          return Promise.resolve([...loadIndex().values()].map(r => ({ ...r })));
        } catch (error) {
          return Promise.reject(error);
        }
      },
      read(path) {
        try {
          const record = loadIndex().get(String(path));
          if (!record || record.kind !== 'file') return Promise.resolve(null);
          const file = nodePath.join(blobDir, record.blob);
          const buf = fs.readFileSync(file);
          // The record's own size is the validator: a blob that is short is a
          // torn write, and mounting it would be a silently truncated file.
          if (buf.length !== Number(record.size)) {
            return Promise.reject(new Error(
              `overlay blob for ${path} is ${buf.length} bytes, index says ${record.size}`));
          }
          return Promise.resolve(new Uint8Array(buf));
        } catch (error) {
          return Promise.reject(error);
        }
      },
      writeBatch(records) {
        try {
          const map = loadIndex();
          fs.mkdirSync(blobDir, { recursive: true });
          let written = 0;
          for (const record of records || []) {
            const entry = metaOf(record);
            if (entry.kind === 'file') {
              entry.blob = blobName(entry.path);
              fs.writeFileSync(nodePath.join(blobDir, entry.blob),
                Buffer.from(record.data || new Uint8Array(0)));
            } else {
              const previous = map.get(entry.path);
              if (previous && previous.blob) {
                try { fs.unlinkSync(nodePath.join(blobDir, previous.blob)); } catch (_) {}
              }
            }
            map.set(entry.path, entry);
            written++;
          }
          saveIndex();
          log(`[overlay] wrote ${written} record(s) to ${root}`);
          return Promise.resolve({ written, removed: 0 });
        } catch (error) {
          return Promise.reject(error);
        }
      },
      remove(path) {
        try {
          const map = loadIndex();
          const record = map.get(String(path));
          if (!record) return Promise.resolve();
          if (record.blob) {
            try { fs.unlinkSync(nodePath.join(blobDir, record.blob)); } catch (_) {}
          }
          map.delete(String(path));
          saveIndex();
          return Promise.resolve();
        } catch (error) {
          return Promise.reject(error);
        }
      },
    };
  }

  // --------------------------------------------------------------- OPFS

  function opfsScope(scope) {
    const scopeText = String(scope == null ? '' : scope);
    if (!scopeText) throw new Error('opfsStore: scope is required');
    const scopeBytes = new TextEncoder().encode(scopeText);
    if (scopeBytes.length > 100) {
      throw new Error(`opfsStore: scope is too long (${scopeBytes.length} UTF-8 bytes, max 100)`);
    }
    const scopeName = 'overlay-' + [...scopeBytes]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    return { scopeText, scopeName };
  }

  async function opfsRoot(options) {
    const supplied = options && options.root;
    if (supplied) return Promise.resolve(supplied);
    const storage = typeof navigator !== 'undefined' && navigator.storage;
    if (!storage || typeof storage.getDirectory !== 'function') {
      throw new Error('opfsStore: this browser has no origin-private file system');
    }
    return storage.getDirectory();
  }

  function opfsStore(scope, options) {
    options = options || {};
    const { scopeText, scopeName } = opfsScope(scope);
    const log = typeof options.log === 'function' ? options.log : () => {};
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let opened = null;
    let state = null;
    let loading = null;
    let operation = Promise.resolve();

    function isMissing(error) {
      return !!error && (error.name === 'NotFoundError' || error.code === 'ENOENT');
    }

    async function openDirs() {
      if (opened) return opened;
      opened = (async () => {
        const root = await opfsRoot(options);
        const appDir = await root.getDirectoryHandle('wine-assembly', { create: true });
        const overlays = await appDir.getDirectoryHandle('overlays', { create: true });
        const dir = await overlays.getDirectoryHandle(scopeName, { create: true });
        const blobs = await dir.getDirectoryHandle('blobs', { create: true });
        return { dir, blobs };
      })();
      return opened;
    }

    async function readBytes(dir, name) {
      const handle = await dir.getFileHandle(name);
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    }

    async function writeBytes(dir, name, bytes) {
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      try {
        await writable.write(bytes);
        await writable.close();
      } catch (error) {
        try { await writable.abort(); } catch (_) {}
        throw error;
      }
    }

    async function loadState() {
      if (state) return state;
      if (loading) return loading;
      loading = (async () => {
        const { dir, blobs } = await openDirs();
        let parsed = null;
        try {
          parsed = JSON.parse(decoder.decode(await readBytes(dir, 'index.json')));
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        if (!parsed) parsed = { version: INDEX_VERSION, scope: scopeText, nextBlob: 1, records: [] };
        if (parsed.version !== INDEX_VERSION || parsed.scope !== scopeText ||
            !Number.isSafeInteger(parsed.nextBlob) || parsed.nextBlob < 1 ||
            !Array.isArray(parsed.records)) {
          throw new Error(`opfsStore: invalid version ${INDEX_VERSION} index for ${scopeText}`);
        }
        const records = new Map();
        for (const raw of parsed.records) {
          const record = metaOf(raw);
          if (record.kind === 'file') {
            if (!raw.blob || typeof raw.blob !== 'string') {
              throw new Error(`opfsStore: file record ${record.path} has no blob`);
            }
            record.blob = raw.blob;
          }
          records.set(record.path, record);
        }
        state = { nextBlob: parsed.nextBlob, records };

        // A crash before the index commit can leave only the new blob. It is
        // unreachable by construction; remove it on the next open so repeated
        // interrupted installs cannot consume the quota forever.
        if (typeof blobs.keys === 'function') {
          const known = new Set([...records.values()].map(record => record.blob).filter(Boolean));
          for await (const name of blobs.keys()) {
            if (!known.has(name)) {
              try { await blobs.removeEntry(name); } catch (_) {}
            }
          }
        }
        return state;
      })();
      try {
        return await loading;
      } finally {
        loading = null;
      }
    }

    function queueMutation(fn) {
      const result = operation.then(fn, fn);
      operation = result.catch(() => {});
      return result;
    }

    async function commit(next) {
      const { dir } = await openDirs();
      const payload = {
        version: INDEX_VERSION,
        scope: scopeText,
        nextBlob: next.nextBlob,
        records: [...next.records.values()],
      };
      await writeBytes(dir, 'index.json', encoder.encode(JSON.stringify(payload)));
      state = next;
    }

    function nextBlobName(next) {
      if (!Number.isSafeInteger(next.nextBlob) || next.nextBlob < 1) {
        throw new RangeError('opfsStore: blob id exhausted');
      }
      return 'b' + String(next.nextBlob++).padStart(12, '0') + '.bin';
    }

    return {
      kind: 'opfs',
      scope: scopeText,
      async list() {
        await operation;
        const current = await loadState();
        return [...current.records.values()].map(record => ({ ...record }));
      },
      async read(path) {
        await operation;
        const current = await loadState();
        const record = current.records.get(String(path));
        if (!record || record.kind !== 'file') return null;
        const { blobs } = await openDirs();
        let data;
        try {
          data = await readBytes(blobs, record.blob);
        } catch (error) {
          if (isMissing(error)) return null;
          throw error;
        }
        if (data.length !== record.size) {
          throw new Error(`overlay blob for ${path} is ${data.length} bytes, index says ${record.size}`);
        }
        return data;
      },
      writeBatch(input) {
        const batch = [...(input || [])];
        return queueMutation(async () => {
          const current = await loadState();
          const next = { nextBlob: current.nextBlob, records: new Map(current.records) };
          const stale = new Set();
          const { blobs } = await openDirs();
          for (const raw of batch) {
            const record = metaOf(raw);
            const previous = next.records.get(record.path);
            if (previous && previous.blob) stale.add(previous.blob);
            if (record.kind === 'file') {
              record.blob = nextBlobName(next);
              await writeBytes(blobs, record.blob, new Uint8Array(raw.data || 0));
            }
            next.records.set(record.path, record);
          }
          await commit(next); // blobs first, visible index last
          for (const name of stale) {
            if ([...next.records.values()].some(record => record.blob === name)) continue;
            try { await blobs.removeEntry(name); } catch (_) {}
          }
          log(`[overlay] wrote ${batch.length} record(s) to browser storage ${scopeText}`);
          return { written: batch.length, removed: 0 };
        });
      },
      remove(path) {
        const key = String(path);
        return queueMutation(async () => {
          const current = await loadState();
          const previous = current.records.get(key);
          if (!previous) return;
          const next = { nextBlob: current.nextBlob, records: new Map(current.records) };
          next.records.delete(key);
          await commit(next);
          if (previous.blob) {
            const { blobs } = await openDirs();
            try { await blobs.removeEntry(previous.blob); } catch (_) {}
          }
        });
      },
    };
  }

  async function removeOpfsScope(scope, options) {
    const { scopeName } = opfsScope(scope);
    try {
      const root = await opfsRoot(options || {});
      const appDir = await root.getDirectoryHandle('wine-assembly');
      const overlays = await appDir.getDirectoryHandle('overlays');
      await overlays.removeEntry(scopeName, { recursive: true });
      return true;
    } catch (error) {
      if (error && (error.name === 'NotFoundError' || error.code === 'ENOENT')) return false;
      throw error;
    }
  }

  const api = {
    memoryStore, nodeDirStore, opfsStore, removeOpfsScope,
    assertStore, metaOf, STORE_METHODS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.OverlayStore = api;
})();
