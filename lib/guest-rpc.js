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
//   log                  22465   void, POINTER arg  → must block (see below)
//   log_api_exit         22465   void, no args      → fire and forget
//   net_frame_peek        2407   returns            → round trip
//   check_input           2403   returns, dequeues  → round trip
//   get_ticks             2402   returns            → published slot, no trip
//   get_mouse_position    2400   returns            → round trip
//   get_window_rect       1278   returns            → round trip
//   everything else        <100  mixed
//
// So: one published slot (the clock), a five-entry allowlist of value-only void
// calls that may be fired and forgotten, and a real round trip for everything
// else. The tempting version of this — "void calls never block" — is WRONG, and
// the reason is worth keeping: a void import that takes a pointer is read by the
// main thread after the guest has already run on, so the buffer it points at may
// have been reused. `log(ptr, len)` is exactly that shape.
//
// LAYOUT
// One control block per guest thread, in THREAD_RPC — the last megabyte of the
// shared linear memory, declared in src/01-header.wat so nothing else can claim
// it. The earlier single block sat at 0x1F000000, which was 48MB INSIDE the
// CreateDIBSection pixel arena: a guest that allocated that much DIB would
// overwrite a worker's status word and park it forever. The WAT globals are the
// authority for these numbers now; test/test-wat-rpc-region.js pins them.
//
// Blocks are indexed by thread slot, not by tid, so slot 0 is the guest's main
// thread and slot N is the Nth CreateThread worker. Each is 64 ints (256 bytes),
// its own cache lines, so two threads' status words never share one.

(function (root) {
  'use strict';

  const RPC_BASE = 0x1FF00000;        // byte offset in the shared memory (THREAD_RPC)
  const CTRL_INTS = 64;               // per-thread control block, in i32 slots
  const RPC_STRIDE = CTRL_INTS * 4;   // 256 bytes — a whole number of cache lines
  const RPC_MAX_SLOTS = 0x100000 / RPC_STRIDE;
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
    INPUT_PENDING: 8, // renderer input queue depth, published by main
    ARGS: 12,         // 16 slots (12..27)
    F64_RESULT: 32,   // 2 slots, read via Float64Array
  };

  const STATUS_IDLE = 0, STATUS_REQ = 1, STATUS_RESP = 2;

  // Void imports whose arguments are values, never pointers into guest memory,
  // so the main thread can run them at its leisure. Everything else blocks —
  // see the note in createWorkerImports. Verified against src/01-header.wat and
  // the implementations in lib/host-imports.js.
  const ASYNC_SAFE = new Set([
    'log_i32',            // (val) — the value IS the message
    'log_eip',            // (eip)
    'log_api_exit',       // ()
    'set_cursor',         // (cursor id)
    'set_mouse_position', // (x, y)
  ]);

  function blockBase(slot) {
    const s = slot | 0;
    if (s < 0 || s >= RPC_MAX_SLOTS) throw new Error(`rpc slot ${slot} out of range`);
    return RPC_BASE + s * RPC_STRIDE;
  }

  // Each thread gets `i32`/`f64` over its OWN block for the request handshake,
  // and `pub` over block 0 for the state the main thread publishes once for
  // everybody (clock, mouse, input depth). Publishing per-thread would mean N
  // writes per 4ms tick and N clocks that could disagree.
  function views(memory, slot) {
    const base = blockBase(slot || 0);
    return {
      i32: new Int32Array(memory.buffer, base, CTRL_INTS),
      f64: new Float64Array(memory.buffer, base + I32(SLOT.F64_RESULT), 2),
      pub: new Int32Array(memory.buffer, RPC_BASE, CTRL_INTS),
    };
  }

  // Read the main thread's published input-queue depth. The guest's
  // message-wait resume needs it, and an RPC per poll would round-trip on every
  // idle spin — the one place where a published snapshot is both cheap and
  // harmless, since a stale "no input" only costs one more spin.
  function readInputPending(memory) {
    return Atomics.load(views(memory, 0).pub, SLOT.INPUT_PENDING) | 0;
  }

  // ---- worker side ---------------------------------------------------------

  // Builds the import object a worker-hosted instance is instantiated with.
  // `post` sends a message to the main thread; `sigs` is
  // lib/host-import-sigs.generated.json.
  // `opts.slot` selects this thread's control block (0 = the guest's main
  // thread). Every message this side posts carries the slot, so the main thread
  // knows which block to serve without keeping a worker→slot map of its own.
  function createWorkerImports(memory, sigs, post, opts) {
    opts = opts || {};
    const slot = (opts.slot || 0) | 0;
    const v = views(memory, slot);
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
        host[name] = () => { stats.local++; return Atomics.load(v.pub, SLOT.TICK); };
        return;
      }
      // Mouse and input are NOT fast-pathed, deliberately. renderer-input's
      // getMousePosition answers differently while an input event is being
      // dispatched (`_activeInputEvent`), and check_input *dequeues*. A
      // published snapshot would silently decouple a guest's pointer read from
      // the event it is handling, and drop keystrokes — for 4 calls a batch,
      // which is not worth being wrong about. They take the round trip.

      // Fire-and-forget looked free and is not: a void import that takes a
      // POINTER is read by the main thread after the guest has already run on,
      // and by then the guest may have reused the buffer. `log(ptr, len)` is
      // that shape and is called twice per Win32 API dispatch, so the version
      // of this that skips the round trip for every void import would print
      // whatever happened to be in the buffer later.
      //
      // Nothing in an i32 signature says which arguments are pointers, so the
      // safe default is to block, and only calls known to pass values may skip
      // the round trip. This list is short and deliberate; adding to it
      // requires checking that the import reads no guest memory.
      if (!returnsValue && ASYNC_SAFE.has(name)) {
        host[name] = (...args) => {
          stats.async++;
          post({ t: 'call', id, args, slot });
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
        post({ t: 'rpc', slot });
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
    const pub = views(memory, 0).pub;
    // One view per slot, made on demand. Which slot a request belongs to comes
    // from the message, so N threads share one broker and one import table.
    const blocks = new Map();
    const block = slot => {
      const s = (slot || 0) | 0;
      if (!blocks.has(s)) blocks.set(s, views(memory, s));
      return blocks.get(s);
    };
    const names = Object.keys(sigs).sort();
    let served = 0, missing = new Set();

    // `hostImports` is either one table every slot shares — the browser, where
    // createHostImports builds exactly one — or a function slot => table, which
    // is what the CLI needs: test/run.js builds a per-thread table so each
    // thread's log lines carry its own tid. Resolved once per slot and cached,
    // because building one is not free.
    const tables = new Map();
    const tableFor = (slot) => {
      if (typeof hostImports !== 'function') return hostImports;
      const s = (slot || 0) | 0;
      if (!tables.has(s)) tables.set(s, hostImports(s) || {});
      return tables.get(s);
    };

    const invoke = (id, args, slot) => {
      const name = names[id];
      const fn = tableFor(slot)[name];
      if (typeof fn !== 'function') { missing.add(name); return 0; }
      return fn(...args);
    };

    return {
      names,
      // A blocking request: read it out of the control block, run the real
      // import, publish the answer, wake the worker.
      serveRpc(slot) {
        const v = block(slot);
        if (Atomics.load(v.i32, SLOT.STATUS) !== STATUS_REQ) return false;
        const id = v.i32[SLOT.FN];
        const argc = v.i32[SLOT.ARGC];
        const args = new Array(argc);
        for (let i = 0; i < argc; i++) args[i] = v.i32[SLOT.ARGS + i];
        let result = 0;
        try { result = invoke(id, args, slot); } catch (err) {
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
        try { invoke(msg.id, msg.args || [], msg.slot); } catch (err) {
          if (opts.onError) opts.onError(names[msg.id], err);
        }
        served++;
      },
      // Publish the state the worker reads locally. Cheap enough to call on
      // every slice boundary and on every input event.
      publish(state) {
        if (state.tickMs !== undefined) Atomics.store(pub, SLOT.TICK, state.tickMs | 0);
        if (state.mouseX !== undefined) Atomics.store(pub, SLOT.MOUSE_X, state.mouseX | 0);
        if (state.mouseY !== undefined) Atomics.store(pub, SLOT.MOUSE_Y, state.mouseY | 0);
        if (state.inputPending !== undefined) Atomics.store(pub, SLOT.INPUT_PENDING, state.inputPending | 0);
        Atomics.add(pub, SLOT.GEN, 1);
      },
      stats() { return { served, missing: [...missing] }; },
    };
  }

  const api = { RPC_BASE, RPC_STRIDE, RPC_MAX_SLOTS, SLOT, CTRL_INTS,
                STATUS_IDLE, STATUS_REQ, STATUS_RESP, readInputPending,
                blockBase, views, createWorkerImports, createMainBroker };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GuestRpc = api;
})(typeof self !== 'undefined' ? self : this);
