// "Keep in library" — the bytes in OPFS, the catalog in IndexedDB.
//
// Phase ④ of docs/design-byo-media.md. A session import is free and honest:
// the File object stays alive, nothing is copied, and it is gone on reload.
// Keeping is the opposite trade — the bytes are streamed into origin-private
// storage so the same disc is there tomorrow — and that trade is what this
// file implements.
//
// ---- why two stores, and the seam between them --------------------------
//
// OPFS holds content because it is the only browser store with real files:
// byte-range reads, no base64 tax, and a `getFile()` that hands back a File —
// which is exactly what BlobProvider (lib/byte-provider.js) already consumes,
// so a kept ISO re-mounts through the identical code path as a dropped one.
// IndexedDB holds the catalog because OPFS has no queryable metadata: it is a
// directory of opaque blobs, and "what discs do I have" must not require
// opening every one of them.
//
// The two cannot share a transaction, and that is risk register item 4. A
// crash — a closed tab, a killed phone browser, a quota refusal mid-copy —
// can land between them in either direction:
//
//   record written, bytes not (or half) written   → a library row that opens
//                                                   to a truncated disc
//   bytes written, record not                     → quota consumed by a file
//                                                   nothing can ever name
//
// So imports are staged. The record is written FIRST with state 'copying' and
// the byte count it expects; only a completed, size-verified copy flips it to
// 'complete'. `list()` returns complete rows only, and `cleanupOrphans()` runs
// at open: it deletes every non-complete record with its partial file, and
// every OPFS file no record names. Both failure directions therefore heal on
// the next visit rather than accumulating.
//
// ---- what is honestly not durable ---------------------------------------
//
// `navigator.storage.persist()` REQUESTS eviction protection and can answer
// false — on Safari it usually does until the site earns engagement. The
// caller gets the boolean and the UI shows it; nothing here treats a kept
// import as guaranteed. Private-browsing Safari has no OPFS at all, which
// `probe()` reports so the import flow can offer session-only and say why.

(function () {
  'use strict';

  const DB_NAME = 'wine-media';
  // Bump when the record shape changes; onupgradeneeded migrates or clears.
  const SCHEMA_VERSION = 1;
  const STORE = 'media';
  const OPFS_DIR = 'media';
  // Above this, a full-content hash means reading the whole disc into memory
  // for no benefit the import flow can use. Bigger media gets a head+tail
  // digest instead, marked partial so nothing mistakes it for a content hash.
  const FULL_HASH_LIMIT = 64 * 1024 * 1024;
  const HASH_SAMPLE = 1024 * 1024;

  // ---- capability probe ---------------------------------------------------

  // What this browser can actually do, asked once and answered honestly.
  // Feature detection only — no user-agent sniffing — because the thing that
  // varies is the mode (private browsing), not the brand.
  function probe() {
    const result = { opfs: false, idb: false, writable: false, reason: null };
    result.idb = typeof indexedDB !== 'undefined' && !!indexedDB;
    const storage = typeof navigator !== 'undefined' ? navigator.storage : null;
    if (!storage || typeof storage.getDirectory !== 'function') {
      result.reason = 'this browser has no origin-private file system';
      return result;
    }
    // `getDirectory` exists but rejects in private browsing, so presence is
    // not capability. The real answer needs an await; supported() does that.
    result.opfs = true;
    result.writable = typeof FileSystemFileHandle !== 'undefined' &&
      typeof FileSystemFileHandle.prototype.createWritable === 'function';
    if (!result.idb) result.reason = 'this browser has no IndexedDB';
    else if (!result.writable) result.reason = 'this browser cannot write OPFS files from the page';
    return result;
  }

  // The probe, actually exercised. Private-browsing Safari passes `probe()`
  // and fails here, which is the whole reason this is separate and async.
  async function supported() {
    const p = probe();
    if (!p.opfs || !p.idb || !p.writable) return { ok: false, ...p };
    try {
      await navigator.storage.getDirectory();
      return { ok: true, ...p };
    } catch (error) {
      return {
        ok: false, ...p,
        reason: 'origin-private storage is unavailable (private browsing?): ' +
          String((error && error.message) || error),
      };
    }
  }

  // ---- IndexedDB plumbing -------------------------------------------------

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, SCHEMA_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        // Version 1 creates the store. A later version migrates here rather
        // than deleting: a schema bump must never silently drop a visitor's
        // library, and the OPFS files would outlive the rows anyway.
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('state', 'state', { unique: false });
          store.createIndex('addedAt', 'addedAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('indexedDB.open failed'));
    });
  }

  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const store = transaction.objectStore(STORE);
      let out;
      try { out = fn(store); } catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(out && out.__req ? out.__req.result : out);
      transaction.onerror = () => reject(transaction.error || new Error('media library transaction failed'));
      transaction.onabort = () => reject(transaction.error || new Error('media library transaction aborted'));
    });
  }

  function request(store, call) {
    const req = call(store);
    return { __req: req };
  }

  // ---- hashing ------------------------------------------------------------

  function hex(buffer) {
    const bytes = new Uint8Array(buffer);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  // A content identity for the row. Small media gets a true sha256 of every
  // byte; anything larger gets a digest of head + tail + the size, flagged
  // partial. It is an identity, not a checksum — the only consumers are "is
  // this the same disc I already kept" and "reattach the saves for this ISO".
  async function digestFor(file) {
    const subtle = typeof crypto !== 'undefined' && crypto.subtle;
    if (!subtle) return { sha256: null, partial: true };
    if (file.size <= FULL_HASH_LIMIT) {
      const buf = await file.arrayBuffer();
      return { sha256: hex(await subtle.digest('SHA-256', buf)), partial: false };
    }
    const head = new Uint8Array(await file.slice(0, HASH_SAMPLE).arrayBuffer());
    const tail = new Uint8Array(await file.slice(Math.max(0, file.size - HASH_SAMPLE)).arrayBuffer());
    const sizeTag = new TextEncoder().encode(`|${file.size}|`);
    const joined = new Uint8Array(head.length + sizeTag.length + tail.length);
    joined.set(head, 0);
    joined.set(sizeTag, head.length);
    joined.set(tail, head.length + sizeTag.length);
    return { sha256: hex(await subtle.digest('SHA-256', joined)), partial: true };
  }

  // ---- the library --------------------------------------------------------

  class MediaLibrary {
    constructor(db, dir) {
      this.db = db;
      this.dir = dir;
    }

    // Open the library and heal whatever a previous crash left behind. Always
    // call through this rather than the constructor: the orphan sweep is not
    // optional, it is what makes the two-store split safe.
    static async open() {
      const ok = await supported();
      if (!ok.ok) throw new Error(`media library unavailable: ${ok.reason}`);
      const db = await openDb();
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
      const library = new MediaLibrary(db, dir);
      await library.cleanupOrphans();
      return library;
    }

    close() { try { this.db.close(); } catch (_) { /* already gone */ } }

    // Complete rows only. A row mid-copy is not media the visitor has.
    async list() {
      const all = await tx(this.db, 'readonly', store => request(store, s => s.getAll()));
      return (all || []).filter(row => row.state === 'complete')
        .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    }

    async get(id) {
      const row = await tx(this.db, 'readonly', store => request(store, s => s.get(id)));
      return row || null;
    }

    _put(record) {
      return tx(this.db, 'readwrite', store => request(store, s => s.put(record)));
    }

    // Stream a File into OPFS and catalog it. `onProgress({loaded, total})` is
    // called as the copy runs — a 600MB disc is not instant and a UI that says
    // nothing during it looks hung.
    //
    // The order here is the crash-consistency contract, and it is deliberate:
    // stage the record, copy, verify the written size, then complete. Every
    // early exit leaves a row that cleanupOrphans() can identify and undo.
    async add(file, opts) {
      const options = opts || {};
      const id = options.id || newId();
      const name = options.name || file.name || 'media';
      const record = {
        id,
        schema: SCHEMA_VERSION,
        name,
        kind: options.kind || 'unknown',
        size: file.size,
        sha256: null,
        sha256Partial: null,
        volumeLabel: options.volumeLabel || null,
        addedAt: Date.now(),
        state: 'copying',
        // Whatever the import flow needs to rebuild a launchable entry on the
        // next visit without re-reading the media: which exe was chosen, what
        // to call it on the desktop. Kept in the catalog because the point of
        // the library is that a reload shows the icon before anything is read.
        ...(options.extra || {}),
      };
      await this._put(record);

      let handle;
      try {
        handle = await this.dir.getFileHandle(id, { create: true });
        const writable = await handle.createWritable();
        try {
          await copyInto(writable, file, options.onProgress);
          await writable.close();
        } catch (error) {
          // An aborted writable discards its staged bytes; the record is still
          // 'copying' and the sweep will drop it either way.
          try { await writable.abort(); } catch (_) { /* nothing to undo */ }
          throw error;
        }
        // Verify what actually landed. A quota refusal can surface as a short
        // file rather than a rejection, and a truncated ISO that reports itself
        // as complete is the one failure this whole design must not produce.
        const written = await handle.getFile();
        if (written.size !== file.size) {
          throw new Error(`media library: copied ${written.size} of ${file.size} bytes ` +
            `(out of storage quota?)`);
        }
        const digest = await digestFor(written);
        record.sha256 = digest.sha256;
        record.sha256Partial = digest.partial;
        record.state = 'complete';
        await this._put(record);
        return record;
      } catch (error) {
        await this.remove(id).catch(() => {});
        throw error;
      }
    }

    // A CUE is only meaningful with every BIN it names. Keep the set under
    // one catalog row while storing each part as its own OPFS file, preserving
    // lazy range reads and avoiding an archive/repack copy. Existing schema-1
    // single-file rows remain valid; `parts` is an additive record field.
    async addBundle(values, opts) {
      const options = opts || {};
      const files = Array.from(values || []).map(value => ({
        source: value && value.source ? value.source : value,
        name: String((value && value.name) ||
          (value && value.source && value.source.name) || 'media'),
      }));
      if (!files.length) throw new Error('media library: cannot keep an empty bundle');
      for (const part of files) {
        if (!part.source || typeof part.source.size !== 'number') {
          throw new Error(`media library: ${part.name} is not a File or Blob`);
        }
      }
      const id = options.id || newId();
      const total = files.reduce((sum, part) => sum + part.source.size, 0);
      const record = {
        id,
        schema: SCHEMA_VERSION,
        name: options.name || files[0].name || 'media',
        kind: options.kind || 'unknown',
        size: total,
        sha256: null,
        sha256Partial: true,
        volumeLabel: options.volumeLabel || null,
        addedAt: Date.now(),
        state: 'copying',
        parts: files.map((part, index) => ({
          name: part.name,
          size: part.source.size,
          storageName: partStorageName(id, index),
          sha256: null,
          sha256Partial: null,
        })),
        ...(options.extra || {}),
      };
      await this._put(record);

      let completed = 0;
      try {
        for (let index = 0; index < files.length; index++) {
          const part = files[index];
          const meta = record.parts[index];
          const handle = await this.dir.getFileHandle(meta.storageName, { create: true });
          const writable = await handle.createWritable();
          try {
            await copyInto(writable, part.source, progress => {
              if (options.onProgress) {
                options.onProgress({ loaded: completed + progress.loaded, total });
              }
            });
            await writable.close();
          } catch (error) {
            try { await writable.abort(); } catch (_) { /* nothing to undo */ }
            throw error;
          }
          const written = await handle.getFile();
          if (written.size !== part.source.size) {
            throw new Error(`media library: copied ${written.size} of ${part.source.size} bytes for ${part.name}`);
          }
          const digest = await digestFor(written);
          meta.sha256 = digest.sha256;
          meta.sha256Partial = digest.partial;
          completed += written.size;
        }
        // The ordered part manifest is the bundle identity. Each part already
        // carries its own full or sampled digest; hashing the manifest makes a
        // single stable value for save attachment and duplicate detection.
        const subtle = typeof crypto !== 'undefined' && crypto.subtle;
        if (subtle) {
          const manifest = new TextEncoder().encode(JSON.stringify(record.parts.map(part =>
            [part.name, part.size, part.sha256, part.sha256Partial])));
          record.sha256 = hex(await subtle.digest('SHA-256', manifest));
        }
        record.state = 'complete';
        await this._put(record);
        return record;
      } catch (error) {
        await this.remove(id).catch(() => {});
        throw error;
      }
    }

    // Delete both halves, tolerating either being gone already.
    async remove(id) {
      const row = await this.get(id).catch(() => null);
      const names = row && Array.isArray(row.parts)
        ? row.parts.map(part => part.storageName).filter(Boolean) : [id];
      for (const name of names) {
        try { await this.dir.removeEntry(name); } catch (_) { /* already gone */ }
      }
      await tx(this.db, 'readwrite', store => request(store, s => s.delete(id)));
      return true;
    }

    // The File behind a kept import — OPFS hands back a real File, so this
    // plugs straight into BlobProvider and every mount path a dropped file
    // uses. Never returns a File for an incomplete row.
    async fileFor(id) {
      const row = await this.get(id);
      if (!row) throw new Error(`media library: no item ${id}`);
      if (row.state !== 'complete') throw new Error(`media library: ${row.name} is incomplete`);
      const handle = await this.dir.getFileHandle(id);
      const file = await handle.getFile();
      if (file.size !== row.size) {
        throw new Error(`media library: ${row.name} is ${file.size} bytes, catalog says ${row.size}`);
      }
      return file;
    }

    // Original names matter to CUE resolution, while OPFS filenames are
    // deliberately opaque. Return descriptors that pair each stored File
    // with the name written in the catalog.
    async filesFor(id) {
      const row = await this.get(id);
      if (!row) throw new Error(`media library: no item ${id}`);
      if (row.state !== 'complete') throw new Error(`media library: ${row.name} is incomplete`);
      if (!Array.isArray(row.parts)) {
        const source = await this.fileFor(id);
        return [{ name: row.name, size: source.size, source }];
      }
      const out = [];
      for (const part of row.parts) {
        const handle = await this.dir.getFileHandle(part.storageName);
        const source = await handle.getFile();
        if (source.size !== part.size) {
          throw new Error(`media library: ${part.name} is ${source.size} bytes, catalog says ${part.size}`);
        }
        out.push({ name: part.name, size: source.size, source });
      }
      return out;
    }

    // Both crash directions, healed. Returns what it removed so a caller can
    // say so rather than tidying up in silence.
    async cleanupOrphans() {
      const removed = { records: [], files: [] };
      const all = await tx(this.db, 'readonly', store => request(store, s => s.getAll()));
      const known = new Set();
      for (const row of (all || [])) {
        if (row.state !== 'complete' || row.schema !== SCHEMA_VERSION) {
          await this.remove(row.id).catch(() => {});
          removed.records.push(row.id);
          continue;
        }
        if (Array.isArray(row.parts)) {
          for (const part of row.parts) if (part.storageName) known.add(part.storageName);
        } else {
          known.add(row.id);
        }
      }
      // OPFS files nothing names. `values()`/`keys()` is an async iterator on
      // the directory handle; a browser without it simply skips this half
      // rather than failing the open.
      if (typeof this.dir.keys === 'function') {
        const names = [];
        try {
          for await (const name of this.dir.keys()) names.push(name);
        } catch (_) { return removed; }
        for (const name of names) {
          if (known.has(name)) continue;
          try { await this.dir.removeEntry(name); removed.files.push(name); } catch (_) { /* raced */ }
        }
      }
      return removed;
    }

    // Ask for eviction protection. The boolean is the answer, not a formality:
    // Safari says false until the origin has earned engagement, and the UI is
    // required to show that rather than implying durability.
    static async requestPersist() {
      if (typeof navigator === 'undefined' || !navigator.storage ||
          typeof navigator.storage.persist !== 'function') {
        return { supported: false, persisted: false };
      }
      const already = typeof navigator.storage.persisted === 'function'
        ? await navigator.storage.persisted() : false;
      if (already) return { supported: true, persisted: true, alreadyGranted: true };
      const granted = await navigator.storage.persist();
      return { supported: true, persisted: !!granted, alreadyGranted: false };
    }

    // Origin headroom, NOT disk free space — the UI must label it as such.
    static async estimate() {
      if (typeof navigator === 'undefined' || !navigator.storage ||
          typeof navigator.storage.estimate !== 'function') return null;
      try {
        const { usage, quota } = await navigator.storage.estimate();
        return { usage: usage || 0, quota: quota || 0 };
      } catch (_) { return null; }
    }
  }

  // Stream rather than buffer: a 600MB disc must never be resident in memory
  // just to be copied. `file.stream()` exists everywhere OPFS does; the slice
  // loop is the fallback for anything that lacks it.
  async function copyInto(writable, file, onProgress) {
    let loaded = 0;
    const report = () => { if (onProgress) onProgress({ loaded, total: file.size }); };
    report();
    if (typeof file.stream === 'function') {
      const reader = file.stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        loaded += value.length;
        report();
      }
      return;
    }
    const CHUNK = 4 * 1024 * 1024;
    while (loaded < file.size) {
      const slice = file.slice(loaded, Math.min(file.size, loaded + CHUNK));
      const buf = new Uint8Array(await slice.arrayBuffer());
      await writable.write(buf);
      loaded += buf.length;
      report();
    }
  }

  function newId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function partStorageName(id, index) {
    return `${id}.part-${String(index).padStart(3, '0')}`;
  }

  const api = {
    DB_NAME,
    SCHEMA_VERSION,
    STORE,
    OPFS_DIR,
    MediaLibrary,
    probe,
    supported,
    requestPersist: MediaLibrary.requestPersist,
    estimate: MediaLibrary.estimate,
    partStorageName,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.mediaLibrary = api;
})();
