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

// This file runs in two hosts: a browser Worker (the shipped path) and a Node
// worker_thread (test/run.js --threads). The message bodies below are identical
// in both — only the bootstrap differs, so the fork is isolated here rather than
// duplicated into a second worker file that would drift.
//
// The Node host exists because worker mode had no automated coverage at all:
// every test ran the cooperative backend, and the wait-completion bug that made
// worker mode quietly wrong for a whole phase was found by hand in a browser.
const IS_WEB_WORKER = typeof importScripts === 'function';
let parentPort = null;

if (IS_WEB_WORKER) {
  importScripts('guest-rpc.js');
  // The DLL loader drives guest execution — it sets EIP/ESP and calls run() to
  // execute each DllMain — so it belongs on whichever thread owns the instance.
  importScripts('dll-loader.js');
} else {
  parentPort = require('worker_threads').parentPort;
  // The bodies below reach for `self.DllLoader` and the global `GuestRpc`, the
  // names importScripts would have defined. Node has no `self`, so alias it.
  globalThis.self = globalThis;
  globalThis.GuestRpc = require('./guest-rpc.js');
  globalThis.DllLoader = require('./dll-loader.js');
}

let instance = null;
let broker = null;
let memory = null;
let stats = null;

const send = IS_WEB_WORKER ? (msg => self.postMessage(msg)) : (msg => parentPort.postMessage(msg));

const handleMessage = async (msg) => {
  try {
    if (msg.t === 'init') {
      memory = msg.memory;
      const built = GuestRpc.createWorkerImports(memory, msg.sigs, send, { slot: msg.slot || 0 });
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
      // Process-wide state that lives in per-instance globals has to be pushed in
      // before every slice, not just at spawn. The thunk cursor is the dangerous
      // one: $num_thunks is BOTH the count and the next free index, so an
      // instance running with a stale one hands out a thunk address another
      // instance already used. The guest then calls a thunk whose api id belongs
      // to a different function — which is how a guest ends up at EIP=0xffffffff
      // with no bad pointer anywhere in its own code. The cooperative scheduler
      // does exactly this sync around every slice; carrying it in the slice
      // message costs no extra round trip.
      if (msg.sync && instance) {
        const ex = instance.exports;
        if (msg.sync.csStealAfter && ex.set_cs_steal_after) {
          ex.set_cs_steal_after(msg.sync.csStealAfter | 0);
        }
        if (msg.sync.dllCount !== undefined && ex.get_dll_count
            && (msg.sync.dllCount | 0) > (ex.get_dll_count() | 0)) {
          if (ex.set_dll_count) ex.set_dll_count(msg.sync.dllCount | 0);
          else if (ex.test_set_dll_count) ex.test_set_dll_count(msg.sync.dllCount | 0);
        }
        if (msg.sync.numThunks !== undefined && ex.sync_thunk_state && ex.get_num_thunks
            && (msg.sync.numThunks >>> 0) > (ex.get_num_thunks() >>> 0)) {
          ex.sync_thunk_state(msg.sync.thunkEnd >>> 0, msg.sync.numThunks >>> 0);
        }
      }

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
      // A trap in a worker used to report its EIP and nothing else, which is the
      // least useful register in the case that actually happens: EIP=0xffffffff
      // means the guest jumped through a bad pointer, and the question is always
      // where it jumped FROM. Collected only on a trap, so the normal path pays
      // nothing.
      let regs = null;
      if (trapped) {
        const g = (name) => (ex[name] ? ex[name]() >>> 0 : 0);
        regs = {
          prevEip: g('get_dbg_prev_eip'), esp: g('get_esp'), eax: g('get_eax'),
          ebx: g('get_ebx'), ecx: g('get_ecx'), edx: g('get_edx'),
          esi: g('get_esi'), edi: g('get_edi'), ebp: g('get_ebp'),
        };
      }
      // get_sleep_yielded reads AND clears the flag, so it must be read exactly
      // once per slice — here, not by a later probe that would find it gone.
      const sleepYielded = (!trapped && ex.get_sleep_yielded) ? !!ex.get_sleep_yielded() : false;
      send({
        t: 'sliceDone',
        seq: msg.seq,
        ms: performance.now() - t0,
        eip: ex.get_eip ? ex.get_eip() >>> 0 : 0,
        yield: ex.get_yield_reason ? ex.get_yield_reason() >>> 0 : 0,
        esp: ex.get_esp ? ex.get_esp() >>> 0 : 0,
        // Wait parameters, so the scheduler on the main thread can resolve a
        // wait without a second round trip per parked slice.
        waitHandle: ex.get_wait_handle ? ex.get_wait_handle() >>> 0 : 0,
        waitHandlesPtr: ex.get_wait_handles_ptr ? ex.get_wait_handles_ptr() >>> 0 : 0,
        waitTimeout: ex.get_wait_timeout ? ex.get_wait_timeout() >>> 0 : 0xFFFFFFFF,
        waitStackBytes: ex.get_wait_stack_bytes ? ex.get_wait_stack_bytes() | 0 : 12,
        sleepYielded,
        sleepMs: (sleepYielded && ex.get_sleep_timeout) ? ex.get_sleep_timeout() >>> 0 : 0,
        // Critical-section contention, so the scheduler can report it without a
        // round trip into this thread.
        csWaits: ex.get_cs_waits ? ex.get_cs_waits() >>> 0 : 0,
        csSteals: ex.get_cs_steals ? ex.get_cs_steals() >>> 0 : 0,
        thunkEnd: ex.get_thunk_end ? ex.get_thunk_end() >>> 0 : 0,
        numThunks: ex.get_num_thunks ? ex.get_num_thunks() >>> 0 : 0,
        trapped, regs,
        rpc: stats ? { sync: stats.sync, async: stats.async, local: stats.local } : null,
      });
      return;
    }

    // Main-thread code occasionally needs to call an export on the guest
    // instance (renderer-input does this in three places). It cannot block on a
    // worker, so those are one-way: the call happens, the result comes back in
    // a message, and callers that need an answer have to be restructured to
    // publish it instead. Enumerated rather than general on purpose.
    // ---- guest threads (phase 2) -------------------------------------------

    // Become guest thread `tid`. This is spawnPending's body, minus everything
    // that can be computed on the main thread: the stack, the TIB and the TLS
    // block are allocated over there out of the shared heap, and only the calls
    // that touch THIS instance happen here. They have to: set_esp, set_eip and
    // guest_write32 write per-instance state, and writing them into the idle
    // main-thread instance is the mistake that made set_winver silently do
    // nothing in phase 1.
    if (msg.t === 'initGuestThread') {
      const ex = instance.exports;
      ex.init_thread(msg.tid | 0, msg.imageBase | 0, msg.codeStart | 0, msg.codeEnd | 0,
        msg.thunkBase | 0, msg.thunkEnd | 0, msg.numThunks | 0);
      if (msg.dllCount) {
        if (ex.set_dll_count) ex.set_dll_count(msg.dllCount | 0);
        else if (ex.test_set_dll_count) ex.test_set_dll_count(msg.dllCount | 0);
      }
      // The room address is a property of the process, not of one thread — a
      // worker that opens a socket without it sends frames from address 0.
      if (msg.vlanIp && ex.set_vlan_local_ip) ex.set_vlan_local_ip(msg.vlanIp | 0);
      // The stack, TIB and TLS block are allocated HERE rather than on the main
      // thread, even though the heap cursor is shared. In worker mode the
      // main-thread instance never loaded the PE, so its $image_base is 0 — and
      // g2w is image-base relative, so every address it computed would be wrong.
      // This instance has just been told the real one by init_thread.
      const stackSize = (msg.stackSize | 0) || 0x10000;
      const stackBase = ex.guest_alloc(stackSize) >>> 0;
      const stackTop = (stackBase + stackSize) >>> 0;
      const g2w = ga => (ga - (msg.imageBase | 0) + 0x12000) >>> 0;
      // Windows zero-fills new stack pages, and code that reads an uninitialised
      // local behaves differently if we do not.
      new Uint8Array(memory.buffer, g2w(stackBase), stackSize).fill(0);
      ex.guest_write32(stackTop - 4, msg.param | 0);   // the thread parameter
      ex.guest_write32(stackTop - 8, 0);               // return address: halt on return
      ex.set_esp(stackTop - 8);
      ex.set_eip(msg.startAddr | 0);
      if (ex.set_hwnd_base) ex.set_hwnd_base(msg.hwndBase | 0);
      // Real Win32 gives each thread its own TIB and TLS values while sharing
      // TLS indexes across the process.
      const tib = ex.guest_alloc(0x30) >>> 0;
      const tlsSlots = ex.guest_alloc(0x100) >>> 0;
      new Uint8Array(memory.buffer, g2w(tlsSlots), 0x100).fill(0);
      ex.guest_write32(tib, 0xFFFFFFFF);        // SEH head = -1
      ex.guest_write32(tib + 4, stackTop);      // stack top
      ex.guest_write32(tib + 8, stackBase);     // stack bottom
      ex.guest_write32(tib + 0x18, tib);        // self pointer
      ex.guest_write32(tib + 0x2c, tlsSlots);   // ThreadLocalStoragePointer
      if (ex.set_fs_base) ex.set_fs_base(tib);
      if (ex.set_tls_slots) ex.set_tls_slots(tlsSlots);
      if (msg.tlsNextIndex !== undefined && ex.set_tls_next_index) {
        ex.set_tls_next_index(msg.tlsNextIndex | 0);
      }
      // Debug state is per-instance, so a thread spawned without it runs blind
      // to --break and --watch. Same lesson as the cooperative backend's
      // propagation, in a different place.
      if (msg.bp && ex.set_bp) ex.set_bp(msg.bp | 0);
      if (msg.watch && ex.set_watchpoint) {
        if (msg.watchSize && ex.set_watchpoint_size) ex.set_watchpoint_size(msg.watchSize | 0);
        ex.set_watchpoint(msg.watch | 0);
      }
      if (msg.callstack && ex.set_callstack_enabled) ex.set_callstack_enabled(1);
      send({
        t: 'threadReady', seq: msg.seq,
        eip: ex.get_eip ? ex.get_eip() >>> 0 : 0,
        esp: ex.get_esp ? ex.get_esp() >>> 0 : 0,
        stackBase, stackTop, tib, tlsSlots,
      });
      return;
    }

    // A wait this instance parked on has been satisfied. The scheduler on the
    // main thread decides that (it owns the sync table's bookkeeping); the
    // resume itself is three writes to per-instance state plus a return-address
    // recovery that reads linear memory, so it belongs here.
    if (msg.t === 'completeWait') {
      const ex = instance.exports;
      let retAddr = ex.guest_read32(ex.get_esp()) >>> 0;
      const codeStart = ex.get_code_start ? (ex.get_code_start() >>> 0) : 0;
      const codeEnd = ex.get_code_end ? (ex.get_code_end() >>> 0) : 0;
      // The saved return address is usually just at [ESP]. When it is not — the
      // yield unwound through a thunk — recover it by finding the call
      // instruction that got us here, which is what the cooperative backend's
      // _readWaitReturnAddress does.
      if (codeStart && codeEnd && (retAddr < codeStart || retAddr >= codeEnd) && ex.get_dbg_prev_eip) {
        const prev = ex.get_dbg_prev_eip() >>> 0;
        const imageBase = ex.get_image_base ? (ex.get_image_base() >>> 0) : 0;
        if (prev >= codeStart && prev < codeEnd && imageBase) {
          const mem8 = new Uint8Array(memory.buffer);
          const start = (prev - imageBase + 0x12000) >>> 0;
          for (let off = 0; off < 16 && start + off + 5 < mem8.length; off++) {
            if (mem8[start + off] === 0xFF && mem8[start + off + 1] === 0x15) {
              retAddr = (prev + off + 6) >>> 0; break;
            }
            if (mem8[start + off] === 0xE8) { retAddr = (prev + off + 5) >>> 0; break; }
          }
        }
      }
      ex.clear_yield();
      ex.set_eax(msg.result | 0);
      ex.set_esp(ex.get_esp() + (msg.waitStackBytes | 0));
      ex.set_eip(retAddr);
      send({ t: 'waitCompleted', seq: msg.seq, eip: retAddr >>> 0 });
      return;
    }

    // Thunk allocation is per-instance bookkeeping over a shared thunk zone, so
    // a thread that allocated thunks has to tell the others where the zone now
    // ends or they hand out the same addresses.
    if (msg.t === 'syncThunks') {
      const ex = instance.exports;
      if (ex.sync_thunk_state) ex.sync_thunk_state(msg.thunkEnd >>> 0, msg.numThunks >>> 0);
      send({
        t: 'thunksSynced', seq: msg.seq,
        thunkEnd: ex.get_thunk_end ? ex.get_thunk_end() >>> 0 : 0,
        numThunks: ex.get_num_thunks ? ex.get_num_thunks() >>> 0 : 0,
      });
      return;
    }

    if (msg.t === 'loadDlls') {
      // Same call host.js makes single-threaded, with local exports. Results
      // (load addresses) go back so the main thread can register bitmap
      // resources, which is its own bookkeeping rather than guest work.
      const loader = self.DllLoader;
      if (!loader || !loader.loadDlls) throw new Error('dll-loader did not load in the worker');
      const results = loader.loadDlls(
        instance.exports, memory.buffer, msg.exeBytes, msg.configs, () => {}, msg.opts || {});
      send({
        t: 'dllsLoaded', seq: msg.seq,
        results: (results || []).map(r => ({ loadAddr: r && r.loadAddr })),
      });
      return;
    }

    if (msg.t === 'loadLibrary') {
      // The guest is parked on a LoadLibrary yield. Everything here touches the
      // instance — load the image, patch its imports, run DllMain, set EAX,
      // unwind the yield — so it runs on this thread; the main thread only
      // supplied the bytes.
      const L = self.DllLoader || {};
      const ex = instance.exports;
      const finish = (eax) => {
        if (ex.set_eax) ex.set_eax(eax | 0);
        if (L.resumeAfterLoadLibraryYield) L.resumeAfterLoadLibraryYield(ex, memory.buffer);
        if (ex.clear_yield) ex.clear_yield();
      };
      if (!msg.bytes || !L.loadDll) { finish(0); send({ t: 'libLoaded', seq: msg.seq, loadAddr: 0 }); return; }
      try {
        const result = L.loadDll(ex, memory.buffer, msg.bytes);
        if (L.patchDllImports) {
          L.patchDllImports(ex, memory.buffer, [{ name: msg.fileName, bytes: msg.bytes }], [result], () => {});
        }
        if (ex.clear_yield) ex.clear_yield();
        if (result.dllMain && L.callDllMain) L.callDllMain(ex, result.loadAddr, result.dllMain, () => {});
        finish(result.loadAddr);
        send({ t: 'libLoaded', seq: msg.seq, loadAddr: result.loadAddr >>> 0 });
      } catch (err) {
        finish(0);
        send({ t: 'libLoaded', seq: msg.seq, loadAddr: 0, error: String(err && err.message || err) });
      }
      return;
    }

    if (msg.t === 'comLoadDll') {
      // CoCreateInstance parked the guest on a COM yield (reason 3) because the
      // class's server DLL is not loaded. Same split as loadLibrary: the main
      // thread resolved the bytes, everything that touches the instance happens
      // here.
      //
      // The success path deliberately does NOT advance ESP. Clearing the yield
      // makes run() re-enter the CoCreateInstance handler, which retries and now
      // finds the class registered — so the stdcall frame has to still be there.
      // The failure path is the opposite: nothing will retry, so it returns an
      // HRESULT in EAX and drops the 5 args plus the return address itself.
      const L = self.DllLoader || {};
      const ex = instance.exports;
      const fail = (hr) => {
        if (ex.clear_yield) ex.clear_yield();
        if (ex.set_eax) ex.set_eax(hr | 0);
        if (ex.set_esp) ex.set_esp(ex.get_esp() + 24);
      };
      if (!msg.bytes || !L.loadDll) {
        fail(0x80040154); // REGDB_E_CLASSNOTREG
        send({ t: 'comDllLoaded', seq: msg.seq, loadAddr: 0 });
        return;
      }
      try {
        const result = L.loadDll(ex, memory.buffer, msg.bytes);
        if (msg.exeBytes && L.patchExeImports) {
          // dlls=null: we do not know the DLL-table index of every previously
          // loaded image, and the matcher only uses that list for a filename
          // hint — without it, it compares against each DLL's own export name,
          // which is what resolves a late-loaded COM server either way.
          L.patchExeImports(ex, memory.buffer, msg.exeBytes, null, () => {});
        }
        if (result.dllMain && L.callDllMain) {
          L.callDllMain(ex, result.loadAddr, result.dllMain, () => {});
        }
        if (ex.clear_yield) ex.clear_yield();
        send({ t: 'comDllLoaded', seq: msg.seq, loadAddr: result.loadAddr >>> 0 });
      } catch (err) {
        fail(0x80004005); // E_FAIL
        send({
          t: 'comDllLoaded', seq: msg.seq, loadAddr: 0,
          error: String(err && err.message || err),
        });
      }
      return;
    }

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

if (IS_WEB_WORKER) self.onmessage = event => handleMessage((event && event.data) || {});
else parentPort.on('message', msg => handleMessage(msg || {}));
