// The guest's main thread, running in a Worker.
//
// Receives the compiled module and the shared memory from the page, instantiates
// against them with brokered host imports (lib/guest-rpc.js), and then runs
// slices on command. Host calls go back to the main thread; the guest's own
// execution never leaves this thread, which is the entire point: the UI thread
// is no longer in the guest's critical path.
//
// This worker deliberately does NOT own the renderer, the audio graph or the
// registry. Those stay where the browser keeps them, and the broker reaches
// them. See docs/design-real-threads.md.

'use strict';

importScripts('guest-rpc.js');

let instance = null;
let broker = null;
let memory = null;
let stats = null;

const send = msg => self.postMessage(msg);

self.onmessage = async (event) => {
  const msg = event.data || {};

  try {
    if (msg.t === 'init') {
      memory = msg.memory;
      const built = GuestRpc.createWorkerImports(memory, msg.sigs, send);
      stats = built.stats;
      const result = await WebAssembly.instantiate(msg.module, built.imports);
      instance = result.exports ? result : (result.instance || result);
      send({
        t: 'ready',
        exports: Object.keys(instance.exports).length,
        imports: built.names.length,
      });
      return;
    }

    if (msg.t === 'slice') {
      // Message-wait resume, ported from ThreadManager.checkMainYield's yr===7
      // branch. It belongs here: every call it makes is on the guest instance,
      // which now lives in this thread, so what was a cross-thread problem is
      // three local calls. Clearing the yield without this leaves the guest
      // re-entering the wait forever — the window frame paints, the caption,
      // sysbuttons and scrollbars never do, because the messages that draw them
      // are never delivered.
      const resumeMessageWait = () => {
        const ex = instance.exports;
        if (!ex.get_yield_reason || (ex.get_yield_reason() >>> 0) !== 7) return false;
        const hasLocal = ex.has_pending_message ? (ex.has_pending_message() | 0) : 0;
        // The renderer's own input queue lives on the main thread, so its depth
        // is published into the control block rather than queried.
        const hasHostInput = GuestRpc.readInputPending(memory);
        if (!hasLocal && !hasHostInput) return false;
        const retAddr = ex.guest_read32 ? ex.guest_read32(ex.get_esp()) >>> 0 : 0;
        if (ex.resume_message_wait && (ex.resume_message_wait() | 0)) {
          ex.set_eip(retAddr);
          return true;
        }
        return false;
      };
      if (instance) resumeMessageWait();
      // One uninterrupted guest slice. Nothing on the page can be blocked by
      // it, so there is no wall-clock budget to respect here — the reason the
      // input-wake heuristic exists at all disappears in this mode.
      const t0 = performance.now();
      let trapped = null;
      try {
        instance.exports.run(msg.steps | 0);
      } catch (err) {
        trapped = String(err && err.message || err);
      }
      const ex = instance.exports;
      send({
        t: 'sliceDone',
        seq: msg.seq,
        ms: performance.now() - t0,
        eip: ex.get_eip ? ex.get_eip() >>> 0 : 0,
        yield: ex.get_yield_reason ? ex.get_yield_reason() >>> 0 : 0,
        esp: ex.get_esp ? ex.get_esp() >>> 0 : 0,
        trapped,
        rpc: stats ? { sync: stats.sync, async: stats.async, local: stats.local } : null,
      });
      return;
    }

    // Main-thread code occasionally needs to call an export on the guest
    // instance (renderer-input does this in three places). It cannot block on a
    // worker, so those are one-way: the call happens, the result comes back in
    // a message, and callers that need an answer have to be restructured to
    // publish it instead. Enumerated rather than general on purpose.
    if (msg.t === 'callExport') {
      const fn = instance && instance.exports[msg.name];
      if (typeof fn !== 'function') {
        send({ t: 'exportResult', seq: msg.seq, name: msg.name, missing: true });
        return;
      }
      const value = fn(...(msg.args || []));
      send({ t: 'exportResult', seq: msg.seq, name: msg.name, value: typeof value === 'number' ? value : null });
      return;
    }

    if (msg.t === 'readExports') {
      const out = {};
      for (const name of msg.names || []) {
        const fn = instance && instance.exports[name];
        out[name] = typeof fn === 'function' ? (fn() >>> 0) : null;
      }
      send({ t: 'exportsRead', seq: msg.seq, values: out });
      return;
    }
  } catch (err) {
    send({ t: 'error', stage: msg.t, message: String(err && err.message || err) });
  }
};
