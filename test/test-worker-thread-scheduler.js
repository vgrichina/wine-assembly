#!/usr/bin/env node

'use strict';

// ThreadManager's WORKER backend: one Worker per guest thread, all running at
// once (docs/design-real-threads.md phase 2).
//
// The guest threads here are fakes, and that is the point. What needs testing is
// the scheduler's decisions — who gets a slice, when a wait is satisfied, who is
// told to resume, what happens on exit — and those are decided on this thread
// from data in shared memory. Driving real x86 through real Workers would test
// the same logic behind two layers of chance; test-worker-guest.js covers the
// real path end to end in a browser.
//
// Each fake link records what it was asked to do, so the assertions are about
// the protocol: "this thread was given a slice", "that one was told to complete
// its wait with 0", "the exited one was dropped".

const assert = require('assert');
const { ThreadManager } = require('../lib/thread-manager');

let passed = 0, failed = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
  ok ? passed++ : failed++;
}

// A fake WorkerLink. `script` is the list of slice results to hand back, in
// order; the last one repeats, so a thread that stays parked keeps parking.
class FakeLink {
  constructor(slot, script) {
    this.slot = slot;
    this.script = script.slice();
    this.calls = [];
    this.completed = [];
    this.exports = [];
    this.stopped = false;
    this.concurrentPeak = 0;
  }

  async slice(steps) {
    this.calls.push(steps);
    FakeLink.inFlight++;
    FakeLink.peak = Math.max(FakeLink.peak, FakeLink.inFlight);
    // Yield to the event loop so a scheduler that awaited each thread in turn
    // instead of together would show a peak of 1 and fail the parallelism check.
    await new Promise(resolve => setImmediate(resolve));
    FakeLink.inFlight--;
    const r = this.script.length > 1 ? this.script.shift() : this.script[0];
    return Object.assign({ eip: 0x401000, yield: 0, ms: 1 }, r);
  }

  async completeWait(result, waitStackBytes) {
    this.completed.push({ result, waitStackBytes });
    return { eip: 0x401000 };
  }

  async callExport(name) { this.exports.push(name); return 0; }
  async syncThunks() { return {}; }
  stop() { this.stopped = true; }
}
FakeLink.inFlight = 0;
FakeLink.peak = 0;

// Enough of GuestThreadHost for the scheduler: PE metadata comes from slot 0,
// and every spawn hands back a link.
function makeBackend(scripts) {
  let slot = 0;
  const links = [];
  return {
    links,
    specs: [],
    dropped: [],
    async readExports() {
      return {
        get_image_base: 0x400000, get_code_start: 0x401000, get_code_end: 0x420000,
        get_thunk_base: 0x7500000, get_thunk_end: 0x7502818, get_num_thunks: 1283,
        get_dll_count: 3, get_vlan_local_ip: 0x0A4D0001, get_tls_next_index: 2,
      };
    },
    async spawnThread(spec) {
      this.specs.push(spec);
      const link = new FakeLink(++slot, scripts[links.length] || [{}]);
      links.push(link);
      return link;
    },
    dropThread(link) { this.dropped.push(link.slot); },
  };
}

function makeManager(backend) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const mainInstance = {
    exports: {
      get_sync_table: () => 0,
      get_num_thunks: () => 1283,
      sync_thunk_state: () => {},
      get_bp_addr: () => 0,
      get_watch_addr: () => 0,
    },
  };
  const tm = new ThreadManager({}, memory, mainInstance, () => ({ host: {} }),
    { workerBackend: backend, threadsRequested: true });
  tm._log = () => {};
  return tm;
}

(async () => {
  console.log('ThreadManager worker backend\n');

  // --- the backend is what decides the mode, and it says so ------------------
  {
    const tm = makeManager(makeBackend([]));
    check(tm.backend === 'worker', 'a worker backend switches the reported scheduler', tm.backend);
    const coop = makeManager(null);
    check(coop.backend === 'cooperative', 'without one it stays cooperative', coop.backend);
    let threw = false;
    try { tm.runSlice(1000); } catch (_) { threw = true; }
    check(threw, 'runSlice refuses to walk worker-backed threads');
  }

  // --- spawn ----------------------------------------------------------------
  {
    const backend = makeBackend([[{}], [{}]]);
    const tm = makeManager(backend);
    const h1 = tm.createThread(0x401500, 0xdead, 0x20000, 0);
    const h2 = tm.createThread(0x401600, 0xbeef, 0, 0);
    await tm.runWorkerSlices(50000);
    check(backend.specs.length === 2, 'each CreateThread became a Worker', `${backend.specs.length}`);
    const s = backend.specs[0];
    check(s.imageBase === 0x400000 && s.codeStart === 0x401000,
      'PE metadata came from the guest main thread, not the idle main instance',
      `imageBase=0x${(s.imageBase >>> 0).toString(16)}`);
    check(s.hwndBase === 0x10001 + 0x10000 && backend.specs[1].hwndBase === 0x10001 + 0x20000,
      'each thread gets its own hwnd range, as in the cooperative backend',
      `${s.hwndBase.toString(16)}, ${backend.specs[1].hwndBase.toString(16)}`);
    check(s.stackSize === 0x20000 && backend.specs[1].stackSize === 0x10000,
      'the requested stack size is honoured, with the Win32 default when zero',
      `${s.stackSize}, ${backend.specs[1].stackSize}`);
    check(s.dllCount === 3 && s.vlanIp === 0x0A4D0001 && s.tlsNextIndex === 2,
      'process-wide state a new instance cannot infer is passed in');
    check(tm.threads.get(h1).state === 'active' && tm.threads.get(h2).state === 'active',
      'both threads are live in the same handle map the waits read');
  }

  // --- real concurrency ------------------------------------------------------
  {
    const backend = makeBackend([[{}], [{}], [{}]]);
    const tm = makeManager(backend);
    for (let i = 0; i < 3; i++) tm.createThread(0x401500 + i, 0, 0, 0);
    FakeLink.peak = 0; FakeLink.inFlight = 0;
    await tm.runWorkerSlices(50000);
    check(FakeLink.peak === 3, 'all three threads are in a slice at the same time',
      `peak in flight = ${FakeLink.peak}`);
    check(backend.links.every(l => l.calls.length === 1), 'each got exactly one slice',
      backend.links.map(l => l.calls.length).join(','));
  }

  // --- waits ----------------------------------------------------------------
  {
    // The thread parks on WaitForSingleObject. Nothing signals the event, so the
    // scheduler must re-poll rather than resume it.
    // The first slice runs normally: a wait on handle 0 would be resolved
    // immediately, because Win32 treats an unknown handle as signaled and so do
    // we — which is worth knowing before writing "it parks" into a test.
    const backend = makeBackend([[{}]]);
    const tm = makeManager(backend);
    tm.createThread(0x401500, 0, 0, 0);
    await tm.runWorkerSlices(1000);           // spawn + first slice
    const ev = tm.createEvent(false, false);  // auto-reset, unsignaled
    backend.links[0].script = [{ yield: 1, waitHandle: ev, waitStackBytes: 12, waitTimeout: 0xFFFFFFFF }];
    await tm.runWorkerSlices(1000);
    check(backend.links[0].completed.length === 0, 'an unsignaled wait is not resumed');
    check(tm.threads.get([...tm.threads.keys()][0]).waitPolls > 0, 'and it is recorded as still waiting');

    tm.setEvent(ev);
    await tm.runWorkerSlices(1000);
    const done = backend.links[0].completed;
    check(done.length === 1 && done[0].result === 0 && done[0].waitStackBytes === 12,
      'a signaled wait resumes with WAIT_OBJECT_0 and the right frame size',
      JSON.stringify(done));
  }

  {
    // A finite timeout must eventually expire into WAIT_TIMEOUT instead of
    // parking forever.
    const backend = makeBackend([[{ yield: 1, waitHandle: 0xE0001, waitStackBytes: 12, waitTimeout: 5 }]]);
    const tm = makeManager(backend);
    let clock = 1000;
    tm._now = () => clock;
    tm.createThread(0x401500, 0, 0, 0);
    tm.createEvent(false, false);            // idx 0 → handle 0xE0000
    tm.createEvent(false, false);            // idx 1 → handle 0xE0001, unsignaled
    await tm.runWorkerSlices(1000);
    check(backend.links[0].completed.length === 0, 'inside the timeout it keeps waiting');
    clock += 50;
    await tm.runWorkerSlices(1000);
    const done = backend.links[0].completed;
    check(done.length === 1 && done[0].result === 0x102, 'past the timeout it resumes with WAIT_TIMEOUT',
      JSON.stringify(done));
  }

  // --- exit -----------------------------------------------------------------
  {
    const backend = makeBackend([[{ yield: 2 }]]);
    const tm = makeManager(backend);
    const h = tm.createThread(0x401500, 0, 0, 0);
    await tm.runWorkerSlices(1000);
    check(tm.threads.get(h).state === 'exited', 'yield 2 marks the thread exited');
    check(backend.dropped.length === 1, 'and its Worker is dropped', `${backend.dropped}`);
    check(tm.waitSingle(h, 0) === 0, 'a wait on the thread handle is now signaled');
    check(tm.getExitCodeThread(h) !== 0x103, 'and GetExitCodeThread stops saying STILL_ACTIVE');
    const before = backend.links[0].calls.length;
    await tm.runWorkerSlices(1000);
    check(backend.links[0].calls.length === before, 'an exited thread is never given another slice');
  }

  {
    // EIP 0 is the other way a thread ends: its threadproc returned into the
    // zero return address the spawn pushed.
    const backend = makeBackend([[{ eip: 0 }]]);
    const tm = makeManager(backend);
    const h = tm.createThread(0x401500, 0, 0, 0);
    await tm.runWorkerSlices(1000);
    check(tm.threads.get(h).state === 'exited', 'returning from the threadproc (EIP=0) also exits');
  }

  {
    // A trap inside the worker must not take the page down with it.
    const backend = makeBackend([[{ trapped: 'unreachable', eip: 0x401234 }]]);
    const tm = makeManager(backend);
    const h = tm.createThread(0x401500, 0, 0, 0);
    await tm.runWorkerSlices(1000);
    check(tm.threads.get(h).state === 'exited', 'a trapped thread is exited, not left active');
    check(backend.dropped.length === 1, 'and its Worker is dropped too');
  }

  // --- Sleep and Suspend ----------------------------------------------------
  {
    const backend = makeBackend([[{ sleepYielded: true, sleepMs: 100 }, {}]]);
    const tm = makeManager(backend);
    let clock = 5000;
    tm._now = () => clock;
    tm.createThread(0x401500, 0, 0, 0);
    await tm.runWorkerSlices(1000);
    const after = backend.links[0].calls.length;
    await tm.runWorkerSlices(1000);
    check(backend.links[0].calls.length === after, 'a sleeping thread is skipped while it sleeps');
    clock += 200;
    await tm.runWorkerSlices(1000);
    check(backend.links[0].calls.length === after + 1, 'and runs again once the sleep is up');
  }

  {
    const backend = makeBackend([[{}]]);
    const tm = makeManager(backend);
    const h = tm.createThread(0x401500, 0, 0, 0x4);   // CREATE_SUSPENDED
    await tm.runWorkerSlices(1000);
    check(backend.links.length === 1, 'a CREATE_SUSPENDED thread still gets its Worker');
    check(backend.links[0].calls.length === 0, 'but is given no slice while suspended');
    tm.resumeThread(h);
    await tm.runWorkerSlices(1000);
    check(backend.links[0].calls.length === 1, 'and runs after ResumeThread');
  }

  // --- ExitThread from inside a host call -----------------------------------
  {
    // ExitThread takes no handle. The cooperative backend knows the caller
    // because it just called run() on that instance; this backend has to learn
    // it from the RPC slot, or ExitThread silently exits nobody.
    const backend = makeBackend([[{}]]);
    const tm = makeManager(backend);
    const h = tm.createThread(0x401500, 0, 0, 0);
    await tm.runWorkerSlices(1000);
    backend.onRpcSlot(backend.links[0].slot);
    tm.exitThread(7);
    backend.onRpcSlotEnd();
    check(tm.threads.get(h).state === 'exited', 'ExitThread on a worker slot exits that thread');
    check(tm.getExitCodeThread(h) === 7, 'with its exit code', `${tm.getExitCodeThread(h)}`);
  }

  // --- net_wait -------------------------------------------------------------
  {
    const backend = makeBackend([[{ yield: 8 }]]);
    const tm = makeManager(backend);
    tm.createThread(0x401500, 0, 0, 0);
    await tm.runWorkerSlices(1000);
    check(backend.links[0].exports.includes('clear_yield')
      && backend.links[0].exports.includes('vlan_pump'),
      'net_wait clears the yield and pumps the wire',
      backend.links[0].exports.join(','));
    check(tm.netWaitPending === true,
      'and asks the caller for an event-loop turn, or the frames it waits for never arrive');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('test-worker-thread-scheduler failed:', err); process.exit(1); });
