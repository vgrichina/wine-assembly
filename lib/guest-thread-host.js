// Main-thread driver for a guest running in a Worker.
//
// Owns the worker's lifecycle, boots the PE inside it, services its host-import
// RPC (lib/guest-rpc.js), and drives slices. Kept out of host.js so the existing
// single-threaded path is untouched: this is an alternative driver, not a
// rewrite of the working one.
//
// STATUS: experimental. Enough to boot a PE and execute guest code in a worker
// with the real host imports running here. Yield handling inside the worker is
// minimal (see runUntil), DLL loading and the async yields are not ported, and
// nothing here is on by default.

(function (root) {
  'use strict';

  const RPC = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./guest-rpc.js') : root.GuestRpc;

  class GuestThreadHost {
    constructor(opts) {
      this.memory = opts.memory;
      this.module = opts.module;
      this.sigs = opts.sigs;
      this.hostImports = opts.hostImports;      // the real table, from createHostImports
      this.workerUrl = opts.workerUrl || 'lib/guest-worker.js';
      this.log = opts.log || (() => {});
      this.tickMs = opts.tickMs || (() => Date.now());
      this.worker = null;
      this.broker = null;
      this._seq = 0;
      this._pending = new Map();
      this._ready = null;
      this.sliceStats = { slices: 0, guestMs: 0, rpcSync: 0, rpcAsync: 0, rpcLocal: 0 };
    }

    async start() {
      this.broker = RPC.createMainBroker(this.memory, this.hostImports, this.sigs, {
        onError: (name, err) => this.log(`[guest-worker] host import ${name} threw: ${err.message}`),
      });
      this.worker = new Worker(this.workerUrl);
      this.worker.onmessage = e => this._onMessage(e.data || {});
      this.worker.onerror = e => this.log(`[guest-worker] worker error: ${e.message || e}`);

      // Publish the clock before anything runs: the guest reads it locally, and
      // a zero would make GetTickCount jump on the first real publish.
      this.broker.publish({ tickMs: this.tickMs() });
      // Keep it moving even while the guest is mid-slice. 4ms is well inside
      // Win98's own 10-55ms GetTickCount resolution, so the guest sees a clock
      // no coarser than the one it was written for.
      this._clock = setInterval(() => this.broker.publish({ tickMs: this.tickMs() }), 4);

      const ready = new Promise((resolve, reject) => {
        this._ready = { resolve, reject };
        setTimeout(() => reject(new Error('worker did not become ready in 20s')), 20000);
      });
      this.worker.postMessage({ t: 'init', module: this.module, memory: this.memory, sigs: this.sigs });
      return ready;
    }

    stop() {
      if (this._clock) clearInterval(this._clock);
      if (this.worker) this.worker.terminate();
      this.worker = null;
    }

    _onMessage(msg) {
      switch (msg.t) {
        case 'ready':
          this.log(`[guest-worker] instantiated: ${msg.exports} exports, ${msg.imports} brokered imports`);
          if (this._ready) this._ready.resolve(msg);
          break;
        case 'rpc':
          // A blocking host call. The worker is parked in Atomics.wait until
          // this returns, so it must not be deferred.
          this.broker.serveRpc();
          break;
        case 'call':
          this.broker.serveCall(msg);
          break;
        case 'sliceDone':
        case 'exportResult':
        case 'dllsLoaded':
        case 'libLoaded':
        case 'comDllLoaded':
        case 'exportsRead': {
          const p = this._pending.get(msg.seq);
          if (p) { this._pending.delete(msg.seq); p.resolve(msg); }
          break;
        }
        case 'error':
          this.log(`[guest-worker] ${msg.stage}: ${msg.message}`);
          for (const [, p] of this._pending) p.reject(new Error(msg.message));
          this._pending.clear();
          break;
        default:
          this.log(`[guest-worker] unexpected message ${msg.t}`);
      }
    }

    _ask(msg, timeoutMs) {
      const seq = ++this._seq;
      return new Promise((resolve, reject) => {
        this._pending.set(seq, { resolve, reject });
        const t = setTimeout(() => {
          if (this._pending.delete(seq)) reject(new Error(`worker did not answer ${msg.t} in ${timeoutMs || 30000}ms`));
        }, timeoutMs || 30000);
        const wrapped = { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } };
        this._pending.set(seq, wrapped);
        this.worker.postMessage(Object.assign({ seq }, msg));
      });
    }

    // Call one export on the guest instance. Async by necessity: the main
    // thread cannot block on a worker (Atomics.wait is forbidden here), which is
    // why every main-side use of a guest export has to be restructured rather
    // than proxied. There are only a handful, and they are enumerated.
    async callExport(name, ...args) {
      const r = await this._ask({ t: 'callExport', name, args });
      if (r.missing) throw new Error(`guest instance has no export ${name}`);
      return r.value;
    }

    async readExports(names) {
      const r = await this._ask({ t: 'readExports', names });
      return r.values;
    }

    // Boot a PE inside the worker. Mirrors host.js's own sequence; the bytes go
    // into shared memory from here, and only the export calls are marshalled.
    async loadPe(exeBytes, exeName, processId) {
      if (processId !== undefined) {
        try { await this.callExport('set_process_id', processId | 0); } catch (_) {}
      }
      const staging = await this.callExport('get_staging');
      const cap = await this.callExport('get_staging_size');
      const staged = Math.min(exeBytes.length, cap);
      new Uint8Array(this.memory.buffer).set(exeBytes.subarray(0, staged), staging);
      const entry = await this.callExport('load_pe', staged);
      try { await this.callExport('init_dx_com_thunks'); } catch (_) {}
      if (exeName) {
        const bytes = new TextEncoder().encode(exeName);
        new Uint8Array(this.memory.buffer).set(bytes, staging);
        try { await this.callExport('set_exe_name', staging, bytes.length); } catch (_) {}
      }
      return entry >>> 0;
    }

    // Load DLLs inside the worker. The bytes are copied over rather than left
    // in shared memory because the loader wants plain arrays, and a few MB once
    // per launch is not worth a second protocol.
    async loadDlls(configs, exeBytes, opts) {
      const r = await this._ask({ t: 'loadDlls', configs, exeBytes, opts }, 120000);
      return r.results || [];
    }

    async loadLibrary(bytes, fileName) {
      return this._ask({ t: 'loadLibrary', bytes, fileName }, 120000);
    }

    // Load a COM server DLL for a guest parked on yield reason 3. exeBytes is
    // passed so the worker can re-patch the EXE's import table, which is what
    // makes a late-loaded DLL's exports reachable from the already-loaded image.
    async comLoadDll(bytes, fileName, exeBytes) {
      return this._ask({ t: 'comLoadDll', bytes, fileName, exeBytes }, 120000);
    }

    // Run one slice and report where the guest ended up.
    async slice(steps) {
      const r = await this._ask({ t: 'slice', steps }, 60000);
      this.sliceStats.slices++;
      this.sliceStats.guestMs += r.ms || 0;
      if (r.rpc) {
        this.sliceStats.rpcSync = r.rpc.sync;
        this.sliceStats.rpcAsync = r.rpc.async;
        this.sliceStats.rpcLocal = r.rpc.local;
      }
      return r;
    }
  }

  const api = { GuestThreadHost };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GuestThreadHost = GuestThreadHost;
})(typeof self !== 'undefined' ? self : this);
