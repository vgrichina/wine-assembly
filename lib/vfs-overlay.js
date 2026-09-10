// The writable C:\ overlay — phase ⑤ of docs/design-byo-media.md.
//
// Read its "Overlay semantics" section first; this file is that contract in
// code. In one paragraph: `VirtualFS` is a flat Map that mounts populate, so
// there is no union-mount lookup to write. What has to survive a reload is the
// *difference* the guest made to it — one record per normalized path, three
// kinds (file / dir / whiteout), last-write-wins — and the tracker below is
// what notices those differences and hands batches of them to an async store
// (lib/overlay-store.js).
//
// This is the "keep everything" mode, for an arbitrary import that has no
// `apps.js` entry and therefore no `persistFiles` globs. lib/vfs-persistence.js
// stays exactly as it is for a *registered* app's saves: explicit globs, a
// per-file cap, synchronous localStorage. Both can be attached to one VFS.

(function () {
  const overlayStore = (function () {
    if (typeof window !== 'undefined' && window.OverlayStore) return window.OverlayStore;
    if (typeof require !== 'undefined') return require('./overlay-store');
    return null;
  })();

  // Win9x answers a write to write-protected media with ERROR_WRITE_PROTECT.
  // It is latched rather than returned because $handle_CreateFileA sets
  // $last_error on success only and there is no host→WAT error import yet;
  // see the doc section.
  const ERROR_WRITE_PROTECT = 19;
  // A provider-backed base file opened for write whose bytes are not resident.
  // CreateFile cannot park (no pending status in the WAT handler), so the open
  // fails visibly instead of materializing a possibly-600MB extent inline.
  const ERROR_NOT_READY = 21;

  const GENERIC_WRITE = 0x40000000;
  const GENERIC_ALL = 0x10000000;

  const FILE = 'file';
  const DIR = 'dir';
  const WHITEOUT = 'whiteout';

  function cloneTime(value) {
    if (!value || !Number.isFinite(value.lo) || !Number.isFinite(value.hi)) return null;
    return { lo: value.lo >>> 0, hi: value.hi >>> 0 };
  }

  function attach(vfs, options) {
    options = options || {};
    if (!vfs || !vfs.files) throw new Error('vfs-overlay.attach: no VirtualFS');
    const store = overlayStore
      ? overlayStore.assertStore(options.store, 'vfs-overlay.attach')
      : options.store;
    if (!store) throw new Error('vfs-overlay.attach: no store');
    const log = typeof options.log === 'function' ? options.log : () => {};
    const drives = new Set((options.drives || ['c'])
      .map(d => String(d).replace(/:$/, '').toLowerCase()));

    const originals = new Map();
    const dirty = new Map();   // normalized path -> kind
    const errors = [];
    let flushChain = Promise.resolve();
    const state = { lastError: 0 };

    const resolve = path => vfs._resolvePath(String(path == null ? '' : path));

    // Only writable drives are journalled. A read-only drive is the mounted
    // disc: its content is content, not state, and VirtualFS refuses writes to
    // it anyway.
    function tracked(norm) {
      if (!norm || norm.length < 2 || norm[1] !== ':') return false;
      if (!drives.has(norm[0])) return false;
      return !(vfs.readOnlyDrives && vfs.readOnlyDrives.has(norm[0]));
    }

    function mark(norm, kind) {
      if (!tracked(norm)) return;
      dirty.set(norm, kind);
    }

    function latchReadOnly(path) {
      const norm = resolve(path);
      if (norm.length >= 2 && norm[1] === ':' &&
          vfs.readOnlyDrives && vfs.readOnlyDrives.has(norm[0])) {
        state.lastError = ERROR_WRITE_PROTECT;
        vfs.lastFsError = ERROR_WRITE_PROTECT;
        return true;
      }
      return false;
    }

    function handlePath(handle) {
      const fh = vfs.handles && vfs.handles.get(handle >>> 0);
      return fh ? fh.path : null;
    }

    function wrap(name, replacement) {
      if (typeof vfs[name] !== 'function') {
        throw new Error(`vfs-overlay.attach: VirtualFS has no ${name}()`);
      }
      const original = vfs[name];
      originals.set(name, original);
      vfs[name] = replacement(original);
    }

    // --- copy-on-write over a provider-backed base file --------------------
    //
    // Case 1 of the three in the doc: the bytes are resident, so touching
    // `.data` materializes them synchronously and the entry's own setter drops
    // the provider on the first write. Case 2: they are not, and this is the
    // one place that can say so before the guest holds a handle it will write
    // through.
    function copyOnWritePrepare(norm) {
      const entry = vfs.files.get(norm);
      if (!entry || !entry._provider) return true;
      try {
        void entry.data;
        return true;
      } catch (error) {
        if (!error || error.name !== 'VfsPendingError') throw error;
        state.lastError = ERROR_NOT_READY;
        vfs.lastFsError = ERROR_NOT_READY;
        const message = `overlay: cannot copy-on-write ${norm} — its bytes are ` +
          `not resident and CreateFile cannot park; pre-materialize it with ` +
          `vfs.materialize('${norm}') before launch`;
        errors.push({ path: norm, stage: 'copy-on-write', message });
        log(`[overlay] ${message}`);
        return false;
      }
    }

    wrap('createFile', original => function (path, access, creation) {
      const norm = resolve(path);
      const wantsWrite = creation !== 3 ||
        (((access >>> 0) & (GENERIC_WRITE | GENERIC_ALL)) !== 0);
      if (wantsWrite && tracked(norm) && !copyOnWritePrepare(norm)) return 0;
      const result = original.call(this, path, access, creation);
      if (!result) { latchReadOnly(path); return result; }
      if (creation !== 3) mark(norm, FILE);
      return result;
    });

    wrap('writeFile', original => function (handle, data, length) {
      const target = handlePath(handle);
      const result = original.call(this, handle, data, length);
      if (result && result.ok) mark(resolve(target || ''), FILE);
      else if (target) latchReadOnly(target);
      return result;
    });

    wrap('setEndOfFile', original => function (handle) {
      const target = handlePath(handle);
      const result = original.call(this, handle);
      if (result) mark(resolve(target || ''), FILE);
      else if (target) latchReadOnly(target);
      return result;
    });

    wrap('setFileTimes', original => function (handle, creation, access, write) {
      const target = handlePath(handle);
      const result = original.call(this, handle, creation, access, write);
      if (result === 0 && target) mark(resolve(target), FILE);
      return result;
    });

    wrap('setFileAttributes', original => function (path, attrs) {
      const norm = resolve(path);
      const result = original.call(this, path, attrs);
      if (!result) { latchReadOnly(path); return result; }
      if (vfs.files.has(norm)) mark(norm, FILE);
      else if (vfs.dirs.has(norm)) mark(norm, DIR);
      return result;
    });

    wrap('deleteFile', original => function (path) {
      const norm = resolve(path);
      const result = original.call(this, path);
      if (result) mark(norm, WHITEOUT);
      else latchReadOnly(path);
      return result;
    });

    wrap('createDirectory', original => function (path) {
      const norm = resolve(path);
      const result = original.call(this, path);
      if (result) mark(norm, DIR);
      else latchReadOnly(path);
      return result;
    });

    wrap('removeDirectory', original => function (path) {
      const norm = resolve(path);
      const result = original.call(this, path);
      if (result) mark(norm, WHITEOUT);
      else latchReadOnly(path);
      return result;
    });

    // A rename is a whiteout plus a create, recorded in the same batch, so
    // enumeration after a hydrate can never show both halves.
    wrap('moveFile', original => function (source, destination) {
      const normSource = resolve(source);
      const normDestination = resolve(destination);
      const result = original.call(this, source, destination);
      if (result) {
        mark(normSource, WHITEOUT);
        mark(normDestination, FILE);
      } else {
        latchReadOnly(source) || latchReadOnly(destination);
      }
      return result;
    });

    wrap('copyFile', original => function (source, destination, failIfExists) {
      const normDestination = resolve(destination);
      const result = original.call(this, source, destination, failIfExists);
      if (result) mark(normDestination, FILE);
      else latchReadOnly(destination);
      return result;
    });

    // --- persistence -------------------------------------------------------

    function recordFor(norm, kind) {
      if (kind === WHITEOUT) return { path: norm, kind: WHITEOUT };
      if (kind === DIR) {
        return vfs.dirs.has(norm) ? { path: norm, kind: DIR } : { path: norm, kind: WHITEOUT };
      }
      const entry = vfs.files.get(norm);
      // Marked as a file and no longer there: it was deleted after the mark.
      // The journal's job is the final state, so this is a whiteout.
      if (!entry) return { path: norm, kind: WHITEOUT };
      const data = entry.data; // may throw VfsPendingError — caller reports it
      // `writeBatch` is asynchronous while VirtualFS writes mutate their
      // capacity buffer in place. Give this flush an immutable point-in-time
      // snapshot; otherwise a later guest write can silently change a record
      // that is already queued for persistence.
      const snapshot = new Uint8Array(data);
      return {
        path: norm,
        kind: FILE,
        attrs: (entry.attrs >>> 0) || 0x80,
        size: snapshot.length,
        data: snapshot,
        creationTime: cloneTime(entry.creationTime),
        lastAccessTime: cloneTime(entry.lastAccessTime),
        lastWriteTime: cloneTime(entry.lastWriteTime),
      };
    }

    // The guest never learns that a store write failed — its write already
    // succeeded in RAM — so every failure is held here instead of dropped.
    function flush() {
      const batchPaths = [...dirty.keys()];
      const kinds = batchPaths.map(p => dirty.get(p));
      dirty.clear();
      const retry = (path, kind) => {
        // A write after this flush began is newer than the failed snapshot;
        // keep its kind. If nothing newer is pending, restore the consumed
        // mark so a later flush retries the current VFS state.
        if (!dirty.has(path)) dirty.set(path, kind);
      };
      if (!batchPaths.length) {
        flushChain = flushChain.then(() => ({ written: 0, removed: 0, failed: 0, errors }));
        return flushChain;
      }
      const records = [];
      let failed = 0;
      for (let i = 0; i < batchPaths.length; i++) {
        try {
          records.push(recordFor(batchPaths[i], kinds[i]));
        } catch (error) {
          failed++;
          retry(batchPaths[i], kinds[i]);
          const message = `overlay: cannot persist ${batchPaths[i]}: ` +
            `${(error && error.message) || error}`;
          errors.push({ path: batchPaths[i], stage: 'read', message });
          log(`[overlay] ${message}`);
        }
      }
      flushChain = flushChain
        .then(() => store.writeBatch(records))
        .then(result => ({
          written: (result && result.written) || 0,
          removed: (result && result.removed) || 0,
          failed,
          errors,
        }), error => {
          for (let i = 0; i < batchPaths.length; i++) retry(batchPaths[i], kinds[i]);
          const message = `overlay: store write failed for ${records.length} ` +
            `record(s): ${(error && error.message) || error}`;
          errors.push({ path: null, stage: 'store', message });
          log(`[overlay] ${message}`);
          return { written: 0, removed: 0, failed: failed + records.length, errors };
        });
      return flushChain;
    }

    // Replay: base mounts (already done by the caller) → file/dir records →
    // whiteouts. Whiteouts last is what stops a FindFirstFile over a mounted
    // container from resurrecting a deleted file.
    function hydrate() {
      return Promise.resolve(store.readSnapshot ? store.readSnapshot() : store.list()).then(list => {
        const records = (list || []).slice();
        const content = records.filter(r => r.kind !== WHITEOUT);
        const whiteouts = records.filter(r => r.kind === WHITEOUT);
        const report = { files: 0, dirs: 0, whiteouts: 0, errors };
        let chain = Promise.resolve();
        for (const record of content) {
          chain = chain.then(() => {
            if (record.readError) throw record.readError;
            if (record.kind === DIR) {
              vfs.dirs.add(record.path);
              vfs.ensureParentDirs(record.path);
              report.dirs++;
              return null;
            }
            return Promise.resolve(record.data || store.read(record.path)).then(data => {
              if (!data) {
                throw new Error('store has no bytes for this record');
              }
              const entry = { data, attrs: (record.attrs >>> 0) || 0x80 };
              if (record.creationTime) entry.creationTime = cloneTime(record.creationTime);
              if (record.lastAccessTime) entry.lastAccessTime = cloneTime(record.lastAccessTime);
              if (record.lastWriteTime) entry.lastWriteTime = cloneTime(record.lastWriteTime);
              vfs.files.set(record.path, entry);
              vfs.ensureParentDirs(record.path);
              report.files++;
              return null;
            });
          }).catch(error => {
            const message = `overlay: cannot hydrate ${record.path}: ` +
              `${(error && error.message) || error}`;
            errors.push({ path: record.path, stage: 'hydrate', message });
            log(`[overlay] ${message}`);
          });
        }
        return chain.then(() => {
          for (const record of whiteouts) {
            vfs.files.delete(record.path);
            vfs.dirs.delete(record.path);
            report.whiteouts++;
          }
          return report;
        });
      });
    }

    return {
      store,
      errors,
      get lastError() { return state.lastError; },
      set lastError(value) { state.lastError = value >>> 0; },
      dirtyPaths() { return [...dirty.keys()]; },
      hydrate,
      flush,
      detach() {
        return flush().then(result => {
          for (const [name, original] of originals) vfs[name] = original;
          originals.clear();
          return result;
        });
      },
    };
  }

  const api = { attach, ERROR_WRITE_PROTECT, ERROR_NOT_READY, FILE, DIR, WHITEOUT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.VfsOverlay = api;
})();
