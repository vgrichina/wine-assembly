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

  const GLCommandStream = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./gl-command-stream') : root.GLCommandStream;

  const RPC_BASE = 0x1FF00000;        // byte offset in the shared memory (THREAD_RPC)
  const CTRL_INTS = 64;               // per-thread control block, in i32 slots
  const RPC_STRIDE = CTRL_INTS * 4;   // 256 bytes — a whole number of cache lines
  const RPC_MAX_SLOTS = 0x100000 / RPC_STRIDE;
  const I32 = n => n * 4;
  const SYNC_TABLE = 0x07F14000;
  const SYNC_OBJECTS = 512;
  const SYNC_ENTRY_INTS = 4;
  const WAIT_OBJECT_0 = 0;
  const WAIT_TIMEOUT = 0x102;
  const INFINITE = 0xFFFFFFFF;

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
    INPUT_WAKE: 9,    // one-shot request for slot 0 to end its current slice
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
    'paint_begin',        // (hwnd) — ordered compositor transaction marker
    'paint_end',          // (hwnd) — ordered compositor transaction marker
    // (ptr, len) — the exception to the pointer rule above, and it is checked
    // rather than assumed. All three callers are in $win32_dispatch: the name
    // inside the PE's import table, the fixed 0x2E0 placeholder for a resolved
    // ordinal, and the 0x2D0 scratch buffer for an unimplemented API. The first
    // two are immutable for the life of the process; the third is followed
    // immediately by $crash_unimplemented, so that thread issues no further
    // dispatch that could overwrite it before the message is read.
    //
    // Worth the check: this is called twice per Win32 API dispatch, and it was
    // 10,378 blocking round trips — half of everything Winamp's decode thread
    // did — for two lines that --quiet-api then threw away.
    'log',
  ]);

  // Pure functions of their arguments. They touch no guest memory, no renderer
  // and no main-thread state, so a worker computes them itself instead of
  // stopping until the main thread takes a turn — the same idea as the
  // published clock, minus the publishing. lib/host-imports.js implements these
  // as the bare Math functions, so the answers are identical, not approximate.
  //
  // This is not a micro-optimisation: Winamp's MP3 decoder called math_pow
  // 9,909 times in one 1200-batch run, each one a postMessage and an
  // Atomics.wait, and that was half of everything that thread did.
  const PURE_MATH = {
    math_sin: Math.sin,
    math_cos: Math.cos,
    math_tan: Math.tan,
    math_atan2: Math.atan2,
    math_log2: Math.log2,
    math_pow: Math.pow,
    math_pow2: x => 2 ** x,
  };

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

  // A recursive synchronous WndProc runs inside the current interpreter call.
  // Returning the emulator's 0xFFFF yield sentinel from a wait at that point
  // abandons the recursive frame, so the instruction after the wait can never
  // run. A real Worker can instead park here: the browser thread remains free
  // to broker SetEvent/ReleaseSemaphore from another guest Worker, and those
  // operations wake this shared state directly.
  //
  // `null` means at least one handle is not an event/semaphore in the shared
  // table. The caller then uses the ordinary broker path so thread/process
  // handles retain ThreadManager's existing semantics.
  function waitSharedSyncObjects(memory, handles, waitAll, timeout) {
    if (!memory || !(memory.buffer instanceof SharedArrayBuffer)) return null;
    if (!Array.isArray(handles) || handles.length === 0) return 0xFFFFFFFF;
    const sync = new Int32Array(
      memory.buffer, SYNC_TABLE, SYNC_OBJECTS * SYNC_ENTRY_INTS);
    const wanted = handles.map(handle => handle >>> 0);
    const timeoutMs = timeout >>> 0;
    const deadline = timeoutMs === INFINITE ? Infinity : Date.now() + timeoutMs;

    const resolve = handle => {
      for (let idx = 0; idx < SYNC_OBJECTS; idx++) {
        const base = idx * SYNC_ENTRY_INTS;
        if ((Atomics.load(sync, base) >>> 0) !== handle) continue;
        const type = Atomics.load(sync, base + 1);
        if (type !== 1 && type !== 2) return null;
        return { base, type };
      }
      return null;
    };
    const resolveAll = () => {
      const objects = wanted.map(resolve);
      return objects.every(Boolean) ? objects : null;
    };
    const ready = object => Atomics.load(sync, object.base + 2) > 0;
    const consume = object => {
      const state = object.base + 2;
      if (object.type === 1) {
        if (Atomics.load(sync, object.base + 3)) return ready(object);
        return Atomics.compareExchange(sync, state, 1, 0) === 1;
      }
      while (true) {
        const count = Atomics.load(sync, state);
        if (count <= 0) return false;
        if (Atomics.compareExchange(sync, state, count, count - 1) === count) return true;
      }
    };
    const restore = object => {
      const state = object.base + 2;
      if (object.type === 1) {
        if (!Atomics.load(sync, object.base + 3)) Atomics.store(sync, state, 1);
      } else {
        Atomics.add(sync, state, 1);
      }
      Atomics.notify(sync, state);
    };

    while (true) {
      const objects = resolveAll();
      if (!objects) return null;

      if (waitAll) {
        if (objects.every(ready)) {
          const consumed = [];
          let complete = true;
          for (const object of objects) {
            // Manual-reset events are observed but never consumed.
            if (object.type === 1 && Atomics.load(sync, object.base + 3)) continue;
            if (!consume(object)) { complete = false; break; }
            consumed.push(object);
          }
          if (complete) return WAIT_OBJECT_0;
          // Another waiter won a race between the readiness and consume
          // passes. Put back only the tokens this attempt took and retry.
          for (const object of consumed) restore(object);
        }
      } else {
        for (let i = 0; i < objects.length; i++) {
          if (consume(objects[i])) return WAIT_OBJECT_0 + i;
        }
      }

      if (timeoutMs === 0) return WAIT_TIMEOUT;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return WAIT_TIMEOUT;
      // A wait-any can be woken by an object other than the one selected here.
      // Bound the sleep so it notices that signal without busy-spinning.
      const sleeper = objects.find(object => !ready(object)) || objects[0];
      const state = sleeper.base + 2;
      const observed = Atomics.load(sync, state);
      Atomics.wait(sync, state, observed, Math.min(10, remaining));
    }
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

    if (sigs.gpu_gl_call && (!GLCommandStream || !opts.guestToWasm)) {
      throw new Error('gpu_gl_call requires the buffered GL command transport');
    }

    const waitForResponse = message => {
      Atomics.store(v.i32, SLOT.STATUS, STATUS_REQ);
      try { post(message); }
      catch (err) { Atomics.store(v.i32, SLOT.STATUS, STATUS_IDLE); throw err; }
      while (Atomics.load(v.i32, SLOT.STATUS) === STATUS_REQ) {
        Atomics.wait(v.i32, SLOT.STATUS, STATUS_REQ, 1000);
      }
      const out = v.i32[SLOT.RESULT];
      Atomics.store(v.i32, SLOT.STATUS, STATUS_IDLE);
      return out;
    };

    const brokerCall = (id, args, returnsF64) => {
      stats.sync++;
      const n = Math.min(args.length, 16);
      for (let i = 0; i < n; i++) v.i32[SLOT.ARGS + i] = args[i] | 0;
      v.i32[SLOT.FN] = id;
      v.i32[SLOT.ARGC] = n;
      const i32Result = waitForResponse({ t: 'rpc', slot });
      return returnsF64 ? v.f64[0] : i32Result;
    };

    const glEncoder = GLCommandStream && sigs.gpu_gl_call && opts.guestToWasm
      ? new GLCommandStream.Encoder({
        getMemory: () => memory.buffer,
        guestToWasm: opts.guestToWasm,
        submit: batch => {
          stats.sync++;
          return waitForResponse({ t: 'glBatch', slot, batch });
        },
      })
      : null;

    names.forEach((name, id) => {
      const sig = sigs[name];
      const returnsValue = sig.results.length > 0;
      const returnsF64 = sig.results[0] === 'f64';

      if (name === 'gpu_gl_call' && glEncoder) {
        host[name] = (opcode, stackWa, aux) => {
          stats.local++;
          return glEncoder.call(opcode, stackWa, aux);
        };
        return;
      }

      // Every Win32/COM dispatch is bracketed by entry/exit logging hooks, and
      // resolved ordinals add log_i32. In a normal browser run the receiving
      // handlers are no-ops, so posting each hook individually only floods the
      // main event loop. `forwardGlLogs` is the existing wire-level opt-in set
      // by verbose/API-trace sessions; despite its historical name it enables
      // the complete API logger, not only OpenGL.
      if (!opts.forwardGlLogs &&
          (name === 'log' || name === 'log_i32' || name === 'log_api_exit')) {
        host[name] = () => { stats.local++; };
        return;
      }

      // --- local fast paths. Each reads state the main thread publishes, so
      // the guest never waits for a main-thread turn to learn the time, where
      // the pointer is, or whether a key was pressed.
      if (name === 'get_ticks') {
        host[name] = () => { stats.local++; return Atomics.load(v.pub, SLOT.TICK); };
        return;
      }
      if (PURE_MATH[name]) {
        const fn = PURE_MATH[name];
        host[name] = (...args) => { stats.local++; return fn(...args); };
        return;
      }
      if ((name === 'wait_single' || name === 'wait_multiple') &&
          typeof opts.getSyncMsgDepth === 'function') {
        host[name] = (...args) => {
          let depth = 0;
          try { depth = opts.getSyncMsgDepth() | 0; } catch (_) {}
          if (depth > 0) {
            let handles = null;
            let waitAll = false;
            let timeout = 0;
            if (name === 'wait_single') {
              handles = [args[0] >>> 0];
              timeout = args[1] >>> 0;
            } else {
              const count = args[0] >>> 0;
              const handlesWa = args[1] >>> 0;
              waitAll = !!args[2];
              timeout = args[3] >>> 0;
              if (count > 0 && count <= 64 && handlesWa + count * 4 <= memory.buffer.byteLength) {
                const mem = new Uint32Array(memory.buffer, handlesWa, count);
                handles = Array.from(mem, handle => handle >>> 0);
              }
            }
            if (handles) {
              // A secondary guest Worker may have finished its current slice
              // just before this thread queued the work it is waiting for. Let
              // the browser scheduler keep issuing those slices while this
              // Worker is parked; the matching end is posted before the outer
              // slice reply on the same message channel.
              if (slot === 0) post({ t: 'nestedWaitBegin', slot });
              const result = waitSharedSyncObjects(memory, handles, waitAll, timeout);
              if (slot === 0) post({ t: 'nestedWaitEnd', slot });
              if (result !== null) { stats.local++; return result; }
            }
          }
          return brokerCall(id, args, returnsF64);
        };
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
        // Block until the main thread answers. Legal in a worker, and it is
        // exactly the semantics the guest expects: the instruction that made
        // this call has not retired yet.
        return brokerCall(id, args, returnsF64);
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

    // Per-slot call histogram. A blocking import in worker mode is a postMessage
    // plus an Atomics.wait — the guest thread stops until the main thread takes
    // a turn — so "which import is this thread waiting on, and how often" is the
    // first question about worker throughput, and counting it here is the only
    // place that can answer it per thread. --host-census wraps the main
    // thread's table and cannot see a worker's calls at all.
    const byName = opts.countCalls ? new Map() : null;
    const invoke = (id, args, slot) => {
      const name = names[id];
      if (byName) {
        const key = `${slot | 0}:${name}`;
        byName.set(key, (byName.get(key) || 0) + 1);
      }
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
      // One synchronous OpenGL command-stream submission. The command buffer
      // is shared with the worker and remains immutable until this response
      // wakes it, which also makes borrowed texture pixels safe without a copy.
      serveGlBatch(msg) {
        const slot = (msg.slot || 0) | 0;
        const v = block(slot);
        if (Atomics.load(v.i32, SLOT.STATUS) !== STATUS_REQ) return false;
        if (byName) {
          const key = `${slot}:gpu_gl_batch`;
          byName.set(key, (byName.get(key) || 0) + 1);
        }
        let result = 0;
        try {
          const fn = tableFor(slot).gpu_gl_batch;
          if (typeof fn === 'function') result = fn(msg.batch, slot) | 0;
          else missing.add('gpu_gl_batch');
        } catch (err) {
          if (opts.onError) opts.onError('gpu_gl_batch', err);
        }
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
        if (state.inputWake) Atomics.store(pub, SLOT.INPUT_WAKE, 1);
        Atomics.add(pub, SLOT.GEN, 1);
      },
      stats() {
        return {
          served,
          missing: [...missing],
          // [{ slot, name, count }], busiest first. Empty unless countCalls.
          calls: byName
            ? [...byName.entries()]
              .map(([key, count]) => {
                const cut = key.indexOf(':');
                return { slot: +key.slice(0, cut), name: key.slice(cut + 1), count };
              })
              .sort((a, b) => b.count - a.count)
            : [],
        };
      },
    };
  }

  const api = { RPC_BASE, RPC_STRIDE, RPC_MAX_SLOTS, SLOT, CTRL_INTS,
                STATUS_IDLE, STATUS_REQ, STATUS_RESP, readInputPending,
                SYNC_TABLE, SYNC_OBJECTS, SYNC_ENTRY_INTS,
                blockBase, views, waitSharedSyncObjects,
                createWorkerImports, createMainBroker };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GuestRpc = api;
})(typeof self !== 'undefined' ? self : this);
