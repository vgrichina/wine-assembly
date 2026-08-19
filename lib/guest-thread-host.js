// Main-thread driver for guests running in Workers.
//
// Owns the workers' lifecycle, boots the PE inside the first one, services their
// host-import RPC (lib/guest-rpc.js), and drives slices. Kept out of host.js so
// the existing single-threaded path is untouched: this is an alternative driver,
// not a rewrite of the working one.
//
// SHAPE
//   slot 0            the guest's MAIN thread — boots the PE, owns the message
//                     pump, and is the one host.js's yield handling talks to
//   slot 1..N         one per guest CreateThread, spawned by ThreadManager's
//                     worker backend, each with its own instance over the same
//                     shared memory and its own RPC control block
//
// All of them execute at the same time. The main thread never runs guest code
// here; it serves host imports, composites, and hands out slices.

(function (root) {
  'use strict';

  const RPC = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./guest-rpc.js') : root.GuestRpc;

  // Under Node the workers are worker_threads, not Workers: same postMessage and
  // same structured clone (a shared WebAssembly.Memory and a compiled Module both
  // travel), but events arrive through .on('message') and the payload is the
  // message itself rather than an event wrapper. Everything else is identical, so
  // the difference is confined to start().
  const NODE_WT = (typeof require === 'function' && typeof process !== 'undefined'
    && process.versions && process.versions.node) ? require('worker_threads') : null;

  // One Worker, one guest thread, one RPC slot. Everything that has to happen on
  // the thread that owns the instance goes through here as a message, because
  // that is the rule phase 1 established the hard way: anything that sets EIP or
  // ESP, or calls run(), is guest work and belongs to the instance's own thread.
  class WorkerLink {
    constructor(opts) {
      this.slot = opts.slot | 0;
      this.memory = opts.memory;
      this.module = opts.module;
      this.sigs = opts.sigs;
      this.broker = opts.broker;
      this.workerUrl = opts.workerUrl || 'lib/guest-worker.js';
      this.log = opts.log || (() => {});
      this.onRpc = opts.onRpc || null;
      this.onRpcEnd = opts.onRpcEnd || null;
      this.worker = null;
      this._seq = 0;
      this._pending = new Map();
      this.sliceStats = { slices: 0, guestMs: 0, rpcSync: 0, rpcAsync: 0, rpcLocal: 0 };
    }

    start() {
      if (NODE_WT) {
        this.worker = new NODE_WT.Worker(this.workerUrl);
        this.worker.on('message', m => this._onMessage(m || {}));
        this.worker.on('error', e => {
          this.log(`[guest-worker ${this.slot}] worker error: ${(e && e.message) || e}`);
          if (this._readyPromise) this._readyPromise.reject(e instanceof Error ? e : new Error(String(e)));
        });
      } else {
        this.worker = new Worker(this.workerUrl);
        this.worker.onmessage = e => this._onMessage(e.data || {});
        this.worker.onerror = e => this.log(`[guest-worker ${this.slot}] worker error: ${e.message || e}`);
      }
      const ready = new Promise((resolve, reject) => {
        // Cleared once the answer arrives: under Node a live timer keeps the
        // process alive, so a run that finished in 200ms would sit for 20s.
        const t = setTimeout(() => reject(new Error(`worker ${this.slot} did not become ready in 20s`)), 20000);
        this._readyPromise = {
          resolve: v => { clearTimeout(t); resolve(v); },
          reject: e => { clearTimeout(t); reject(e); },
        };
      });
      this.worker.postMessage({
        t: 'init', module: this.module, memory: this.memory, sigs: this.sigs, slot: this.slot,
      });
      return ready;
    }

    stop() {
      if (this.worker) this.worker.terminate();
      this.worker = null;
      for (const [, p] of this._pending) p.reject(new Error(`worker ${this.slot} stopped`));
      this._pending.clear();
    }

    _onMessage(msg) {
      switch (msg.t) {
        case 'ready':
          this.log(`[guest-worker ${this.slot}] instantiated: ${msg.exports} exports, ${msg.imports} brokered imports`);
          if (this._readyPromise) this._readyPromise.resolve(msg);
          break;
        case 'rpc':
          // A blocking host call. The worker is parked in Atomics.wait until
          // this returns, so it must not be deferred. The slot names which
          // control block to read — with N threads there are N of them.
          //
          // The hooks tell the scheduler WHICH guest thread is inside the host
          // right now, which is the only way an import like ExitThread can know
          // who called it: it takes no handle, and in this mode the caller is not
          // on this thread at all. Serving is synchronous, so the answer cannot
          // go stale mid-call.
          if (this.onRpc) this.onRpc(this.slot);
          try {
            this.broker.serveRpc(msg.slot === undefined ? this.slot : msg.slot);
          } finally {
            if (this.onRpcEnd) this.onRpcEnd(this.slot);
          }
          break;
        case 'call':
          this.broker.serveCall(msg);
          break;
        case 'error':
          this.log(`[guest-worker ${this.slot}] ${msg.stage}: ${msg.message}`);
          for (const [, p] of this._pending) p.reject(new Error(msg.message));
          this._pending.clear();
          break;
        default: {
          // Every other reply is an answer to an _ask, matched by seq. Listing
          // the message names here as well was pure duplication — a new message
          // type meant editing two places and getting "unexpected message" if
          // you forgot.
          const p = msg.seq !== undefined ? this._pending.get(msg.seq) : null;
          if (p) { this._pending.delete(msg.seq); p.resolve(msg); }
          else this.log(`[guest-worker ${this.slot}] unexpected message ${msg.t}`);
        }
      }
    }

    _ask(msg, timeoutMs) {
      const seq = ++this._seq;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          if (this._pending.delete(seq)) reject(new Error(`worker ${this.slot} did not answer ${msg.t} in ${timeoutMs || 30000}ms`));
        }, timeoutMs || 30000);
        this._pending.set(seq, {
          resolve: v => { clearTimeout(t); resolve(v); },
          reject: e => { clearTimeout(t); reject(e); },
        });
        this.worker.postMessage(Object.assign({ seq }, msg));
      });
    }

    // Call one export on this worker's instance. Async by necessity: the main
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

    // Run one slice and report where the guest ended up.
    // `sync` carries process-wide state that lives in per-instance globals (the
    // thunk cursor, the DLL count). It rides along with the slice so keeping N
    // instances agreeing costs no extra round trips.
    async slice(steps, sync) {
      const r = await this._ask({ t: 'slice', steps, sync }, 60000);
      this.sliceStats.slices++;
      this.sliceStats.guestMs += r.ms || 0;
      if (r.rpc) {
        this.sliceStats.rpcSync = r.rpc.sync;
        this.sliceStats.rpcAsync = r.rpc.async;
        this.sliceStats.rpcLocal = r.rpc.local;
      }
      return r;
    }

    // Set this instance up as guest thread `tid`: identity, PE metadata, stack,
    // TIB and entry point. Every value is computed on the main thread (the heap
    // and the shared cursors live in the shared memory both sides see) and every
    // export call happens over there, where the instance is.
    initGuestThread(spec) {
      return this._ask(Object.assign({ t: 'initGuestThread' }, spec));
    }

    // Satisfy a wait this instance is parked on: set EAX, drop the stdcall
    // frame, and resume at the return address. The return-address heuristic
    // needs both the exports and linear memory, so it runs worker-side.
    completeWait(result, waitStackBytes) {
      return this._ask({ t: 'completeWait', result, waitStackBytes });
    }

    syncThunks(thunkEnd, numThunks) {
      return this._ask({ t: 'syncThunks', thunkEnd, numThunks });
    }
  }

  class GuestThreadHost {
    constructor(opts) {
      this.memory = opts.memory;
      this.module = opts.module;
      this.sigs = opts.sigs;
      this.hostImports = opts.hostImports;      // the real table, from createHostImports
      this.workerUrl = opts.workerUrl || 'lib/guest-worker.js';
      this.log = opts.log || (() => {});
      this.tickMs = opts.tickMs || (() => Date.now());
      // A function slot => import table, when each thread wants its own (the CLI
      // tags every log line with the thread's tid). Falls back to the one shared
      // table, which is what the browser has.
      this.hostImportsForSlot = opts.hostImportsForSlot || null;
      // CLI mode: the guest's MAIN thread stays in-process and only CreateThread
      // threads get Workers. Slot 0 has no worker then, so PE metadata is read
      // from the local instance instead — a getter, because run.js does not have
      // the instance yet when this is constructed.
      //
      // This is NOT the browser's shape and is not pretending to be: there the
      // main thread is a Worker too. What it does buy is real coverage of the
      // shared-memory locks, the per-thread RPC blocks and the worker scheduler
      // from a headless test, plus one thing the browser cannot check — that no
      // WAT lock is ever held across a host import, since here the main thread
      // both runs guest code and serves the workers' RPC.
      this.localMainExports = opts.localMainExports || null;
      // 0 disables the clock interval: the CLI's guest clock is derived from the
      // batch counter, not from the wall clock, so it publishes by hand.
      this.clockIntervalMs = opts.clockIntervalMs === undefined ? 4 : opts.clockIntervalMs;
      // Count brokered calls per thread, for --rpc-census. See the broker.
      this.countCalls = !!opts.countCalls;
      this.broker = null;
      this.link = null;                         // slot 0 — the guest's main thread
      this.threadLinks = new Map();             // slot → WorkerLink, one per guest thread
      this.slotTid = new Map();                 // slot → guest tid, for per-slot tables
      this._nextSlot = 1;
    }

    // Kept for the callers that only know about slot 0.
    get worker() { return this.link ? this.link.worker : null; }
    get sliceStats() { return this.link ? this.link.sliceStats : null; }

    async start() {
      // Per-slot tables are resolved lazily by the broker, on the slot's first
      // request — which is always after spawnThread recorded its tid, so the
      // table can be built for the right thread.
      const table = this.hostImportsForSlot
        ? (slot => this.hostImportsForSlot(slot | 0, this.slotTid.get(slot | 0) || 0))
        : this.hostImports;
      this.broker = RPC.createMainBroker(
        this.memory, table, this.sigs, {
          onError: (name, err) => this.log(`[guest-worker] host import ${name} threw: ${err.message}`),
          // Off unless asked for: it is a Map write per brokered call.
          countCalls: !!this.countCalls,
        });

      // Publish the clock before anything runs: the guest reads it locally, and
      // a zero would make GetTickCount jump on the first real publish.
      this.broker.publish({ tickMs: this.tickMs() });
      // Keep it moving even while the guest is mid-slice. 4ms is well inside
      // Win98's own 10-55ms GetTickCount resolution, so the guest sees a clock
      // no coarser than the one it was written for.
      if (this.clockIntervalMs > 0) {
        this._clock = setInterval(() => this.broker.publish({ tickMs: this.tickMs() }), this.clockIntervalMs);
        if (this._clock && this._clock.unref) this._clock.unref();
      }

      if (this.localMainExports) return null;   // no slot-0 worker in CLI mode

      this.link = new WorkerLink({
        slot: 0, memory: this.memory, module: this.module, sigs: this.sigs,
        broker: this.broker, workerUrl: this.workerUrl, log: this.log,
        onRpc: s => { if (this.onRpcSlot) this.onRpcSlot(s); },
        onRpcEnd: s => { if (this.onRpcSlotEnd) this.onRpcSlotEnd(s); },
      });
      return this.link.start();
    }

    stop() {
      if (this._clock) clearInterval(this._clock);
      for (const [, l] of this.threadLinks) l.stop();
      this.threadLinks.clear();
      if (this.link) this.link.stop();
      this.link = null;
    }

    // --- guest threads (phase 2) ---------------------------------------------

    // Spawn a Worker for one guest thread and hand it its identity. Returns the
    // link, which ThreadManager's worker backend stores in the thread record in
    // place of the in-process instance the cooperative backend keeps there.
    async spawnThread(spec) {
      const slot = this._nextSlot++;
      if (slot >= RPC.RPC_MAX_SLOTS) throw new Error('out of RPC slots for guest threads');
      this.slotTid.set(slot, spec.tid | 0);
      const link = new WorkerLink({
        slot, memory: this.memory, module: this.module, sigs: this.sigs,
        broker: this.broker, workerUrl: this.workerUrl, log: this.log,
        onRpc: s => { if (this.onRpcSlot) this.onRpcSlot(s); },
        onRpcEnd: s => { if (this.onRpcSlotEnd) this.onRpcSlotEnd(s); },
      });
      await link.start();
      const r = await link.initGuestThread(spec);
      // Where the thread starts, kept on the link: the scheduler reports it in
      // the spawn and first_run events, and it has no other way to read another
      // OS thread's registers.
      link.startEip = r.eip >>> 0;
      link.startEsp = r.esp >>> 0;
      this.threadLinks.set(slot, link);
      this.log(`[guest-worker ${slot}] guest thread tid=${spec.tid} EIP=0x${(r.eip >>> 0).toString(16)} `
        + `ESP=0x${(r.esp >>> 0).toString(16)}`);
      return link;
    }

    dropThread(link) {
      if (!link) return;
      this.threadLinks.delete(link.slot);
      this.slotTid.delete(link.slot);
      link.stop();
    }

    // --- slot 0 delegation ----------------------------------------------------

    callExport(name, ...args) { return this.link.callExport(name, ...args); }

    // ThreadManager reads the PE's metadata through here, because in the browser
    // the only instance that has ever seen the image is slot 0's. When the main
    // thread is local it is the same read, without the round trip.
    async readExports(names) {
      if (this.localMainExports) {
        const ex = this.localMainExports();
        const out = {};
        for (const name of names || []) {
          out[name] = typeof ex[name] === 'function' ? (ex[name]() >>> 0) : null;
        }
        return out;
      }
      return this.link.readExports(names);
    }

    slice(steps, sync) { return this.link.slice(steps, sync); }

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
      const r = await this.link._ask({ t: 'loadDlls', configs, exeBytes, opts }, 120000);
      return r.results || [];
    }

    async loadLibrary(bytes, fileName) {
      return this.link._ask({ t: 'loadLibrary', bytes, fileName }, 120000);
    }

    // Load a COM server DLL for a guest parked on yield reason 3. exeBytes is
    // passed so the worker can re-patch the EXE's import table, which is what
    // makes a late-loaded DLL's exports reachable from the already-loaded image.
    async comLoadDll(bytes, fileName, exeBytes) {
      return this.link._ask({ t: 'comLoadDll', bytes, fileName, exeBytes }, 120000);
    }
  }

  const api = { GuestThreadHost, WorkerLink };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.GuestThreadHost = GuestThreadHost; root.GuestWorkerLink = WorkerLink; }
})(typeof self !== 'undefined' ? self : this);
