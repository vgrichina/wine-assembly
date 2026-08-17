// Host-import broker: lets a guest thread run in a Worker while the host
// imports it calls keep executing on the main thread, unchanged.
//
// WHY A GENERIC BROKER AND NOT 178 HAND-WRITTEN PROXIES
// The module imports 178 host functions. Re-implementing them worker-side would
// be a rewrite of lib/host-imports.js and a second thing to keep correct. This
// marshals the call instead, so the one existing implementation runs — on the
// main thread, where the canvas, the audio graph and localStorage actually are.
//
// WHY IT IS AFFORDABLE
// Measured on Blobby, 600 batches (~120M guest steps): 57,155 host calls total,
// of which 44,930 are `log` / `log_api_exit`. The interpreter's hot loop is pure
// WASM; the host is called ~20 times per batch. So the cost of brokering is not
// per-instruction, it is per-host-call, and there are few.
//
//   log, log_api_exit    44930   void      → fire and forget, no round trip
//   net_frame_peek        2407   returns   → round trip
//   check_input           2403   returns   → SHARED RING (no round trip)
//   get_ticks             2402   returns   → SHARED SLOT (no round trip)
//   get_mouse_position    2400   returns   → SHARED SLOT (no round trip)
//   get_window_rect       1278   returns   → round trip
//   everything else        <100  mixed
//
// Which is the whole design: void calls never block, the four hottest
// value-returning calls read state the main thread publishes into shared
// memory, and the long tail takes a real round trip.
//
// LAYOUT
// The control block lives at RPC_BASE in the shared linear memory, above the
// VirtualAlloc backing pool (which ends at 0x1C000000) and below the 512MB top,
// so it collides with nothing the emulator maps.

(function (root) {
  'use strict';

  const RPC_BASE = 0x1F000000;        // byte offset in the shared memory
  const I32 = n => n * 4;

  const SLOT = {
    STATUS: 0,        // 0 idle, 1 request pending, 2 response ready
    FN: 1,            // import id
    ARGC: 2,
    RESULT: 3,
    TICK: 4,          // main-published guest clock (ms)
    MOUSE_X: 5,
    MOUSE_Y: 6,
    GEN: 7,           // bumped by main whenever published state changes
    ARGS: 8,          // 16 slots
    F64_RESULT: 32,   // 2 slots, read via Float64Array
  };
  const CTRL_INTS = 64;

  const STATUS_IDLE = 0, STATUS_REQ = 1, STATUS_RESP = 2;

  function views(memory) {
    return {
      i32: new Int32Array(memory.buffer, RPC_BASE, CTRL_INTS),
      f64: new Float64Array(memory.buffer, RPC_BASE + I32(SLOT.F64_RESULT), 2),
    };
  }

  // ---- worker side ---------------------------------------------------------

  // Builds the import object a worker-hosted instance is instantiated with.
  // `post` sends a message to the main thread; `sigs` is
  // lib/host-import-sigs.generated.json.
  function createWorkerImports(memory, sigs, post, opts) {
    opts = opts || {};
    const v = views(memory);
    const names = Object.keys(sigs).sort();          // stable ids both sides
    const host = {};
    const stats = { sync: 0, async: 0, local: 0 };

    names.forEach((name, id) => {
      const sig = sigs[name];
      const returnsValue = sig.results.length > 0;
      const returnsF64 = sig.results[0] === 'f64';

      // --- local fast paths. Each reads state the main thread publishes, so
      // the guest never waits for a main-thread turn to learn the time, where
      // the pointer is, or whether a key was pressed.
      if (name === 'get_ticks') {
        host[name] = () => { stats.local++; return Atomics.load(v.i32, SLOT.TICK); };
        return;
      }
      // Mouse and input are NOT fast-pathed, deliberately. renderer-input's
      // getMousePosition answers differently while an input event is being
      // dispatched (`_activeInputEvent`), and check_input *dequeues*. A
      // published snapshot would silently decouple a guest's pointer read from
      // the event it is handling, and drop keystrokes — for 4 calls a batch,
      // which is not worth being wrong about. They take the round trip.

      if (!returnsValue) {
        // Fire and forget. Messages keep their order, so a void call is always
        // processed before any later blocking call — a paint issued now is on
        // screen before a read-back asked for afterwards.
        host[name] = (...args) => {
          stats.async++;
          post({ t: 'call', id, args });
        };
        return;
      }

      host[name] = (...args) => {
        stats.sync++;
        const n = Math.min(args.length, 16);
        for (let i = 0; i < n; i++) v.i32[SLOT.ARGS + i] = args[i] | 0;
        v.i32[SLOT.FN] = id;
        v.i32[SLOT.ARGC] = n;
        Atomics.store(v.i32, SLOT.STATUS, STATUS_REQ);
        post({ t: 'rpc' });
        // Block until the main thread answers. Legal in a worker, and it is
        // exactly the semantics the guest expects: the instruction that made
        // this call has not retired yet.
        while (Atomics.load(v.i32, SLOT.STATUS) === STATUS_REQ) {
          Atomics.wait(v.i32, SLOT.STATUS, STATUS_REQ, 1000);
        }
        const out = returnsF64 ? v.f64[0] : v.i32[SLOT.RESULT];
        Atomics.store(v.i32, SLOT.STATUS, STATUS_IDLE);
        return out;
      };
    });

    return { imports: { host: Object.assign({ memory }, host) }, names, stats };
  }

  // ---- main side ----------------------------------------------------------

  // Services requests from the worker against the real host import table.
  function createMainBroker(memory, hostImports, sigs, opts) {
    opts = opts || {};
    const v = views(memory);
    const names = Object.keys(sigs).sort();
    let served = 0, missing = new Set();

    const invoke = (id, args) => {
      const name = names[id];
      const fn = hostImports[name];
      if (typeof fn !== 'function') { missing.add(name); return 0; }
      return fn(...args);
    };

    return {
      names,
      // A blocking request: read it out of the control block, run the real
      // import, publish the answer, wake the worker.
      serveRpc() {
        if (Atomics.load(v.i32, SLOT.STATUS) !== STATUS_REQ) return false;
        const id = v.i32[SLOT.FN];
        const argc = v.i32[SLOT.ARGC];
        const args = new Array(argc);
        for (let i = 0; i < argc; i++) args[i] = v.i32[SLOT.ARGS + i];
        let result = 0;
        try { result = invoke(id, args); } catch (err) {
          if (opts.onError) opts.onError(names[id], err);
        }
        if (typeof result === 'number' && !Number.isInteger(result)) v.f64[0] = result;
        v.i32[SLOT.RESULT] = result | 0;
        served++;
        Atomics.store(v.i32, SLOT.STATUS, STATUS_RESP);
        Atomics.notify(v.i32, SLOT.STATUS);
        return true;
      },
      // A fire-and-forget call, arguments carried in the message itself.
      serveCall(msg) {
        try { invoke(msg.id, msg.args || []); } catch (err) {
          if (opts.onError) opts.onError(names[msg.id], err);
        }
        served++;
      },
      // Publish the state the worker reads locally. Cheap enough to call on
      // every slice boundary and on every input event.
      publish(state) {
        if (state.tickMs !== undefined) Atomics.store(v.i32, SLOT.TICK, state.tickMs | 0);
        if (state.mouseX !== undefined) Atomics.store(v.i32, SLOT.MOUSE_X, state.mouseX | 0);
        if (state.mouseY !== undefined) Atomics.store(v.i32, SLOT.MOUSE_Y, state.mouseY | 0);
        Atomics.add(v.i32, SLOT.GEN, 1);
      },
      stats() { return { served, missing: [...missing] }; },
    };
  }

  const api = { RPC_BASE, SLOT, CTRL_INTS, STATUS_IDLE, STATUS_REQ, STATUS_RESP,
                views, createWorkerImports, createMainBroker };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GuestRpc = api;
})(typeof self !== 'undefined' ? self : this);
