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
//   (OPFS)             phase ④'s to supply — a third implementation of these
//                      same four methods, not something this file stubs out
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
    return {
      path: String(record.path),
      kind: normalizeKind(record.kind),
      attrs: (record.attrs >>> 0) || 0,
      size: record.kind === 'file'
        ? (record.data ? record.data.length : (record.size | 0) || 0) : 0,
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
          if (buf.length !== (record.size | 0)) {
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

  const api = { memoryStore, nodeDirStore, assertStore, metaOf, STORE_METHODS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.OverlayStore = api;
})();
