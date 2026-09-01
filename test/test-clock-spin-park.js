#!/usr/bin/env node

'use strict';

// Spin parking: the two detectors that notice a guest busy-waiting inside an
// API call, and the park they take.
//
// WHY THIS EXISTS
// Eight of the twenty-two games in docs/frame-pacing-census.md hold their frame
// rate by reading the millisecond clock in a tight loop -- Abe's Oddysee makes
// 1.77 million timeGetTime calls in three guest seconds -- and four more spin on
// PeekMessage returning empty. Every one of those calls is a full Win32
// dispatch that computes "not yet", and in a browser tab that is the entire
// CPU. Blocking inside the API call is behaviour-legal (real Windows preempts a
// thread there), so the fix needs no loop analysis at all: notice the spin,
// park, and let the host wake it.
//
// The whole design rests on the DETECTOR, because a false park is a stall in a
// healthy game. Four things must hold K times in a row before either detector
// fires -- same value (clock only), same call site, same stack depth, and no
// other Win32 call in between -- and the tests below are mostly about proving
// each of those four actually resets the run. In particular:
//
//   * "reset on a changed value" is what keeps a 60 fps game reading
//     delta-time out of this entirely: it sees a different millisecond every
//     frame and can never reach K.
//
//   * "reset on an interleaved call" is what keeps an ordinary game loop out:
//     empty-peek, RENDER A FRAME, empty-peek is the normal shape, and a frame
//     is API calls. Without this the PeekMessage detector would park a healthy
//     pump on its second poll.
//
// The park itself has the same sharp edge every blocking handler here has: it
// must leave the stdcall frame alone and raise $handler_set_eip, or $run's
// thunk-zone auto-pop splices the call out and the guest resumes past its own
// timeGetTime with the arguments still on the stack. That is checks 3 and 4.
//
// The guest clock is supplied here (ctx.guestNowMs), so nothing depends on wall
// time and the whole file is deterministic. The last section runs host.js in a
// vm context, the way test/test-browser-park-sleep.js does, to check the sleep
// the browser turns a park into -- including that it can never exceed the cap.

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const IMAGE_BASE = 0x400000;
const WASM = path.join(__dirname, '..', 'build', 'wine-assembly.wasm');

// Bits returned by test_clock_spin_once / test_peek_spin_once.
const PARKED = 1;        // yielded with the spin reason
const FRAME_INTACT = 2;  // ESP untouched, so the re-entry sees the same args
const SET_EIP = 4;       // $handler_set_eip raised
const POPPED = 8;        // completed instead: popped its own stdcall frame
const RETURNED = 16;     // completed instead: handed back the expected value

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

async function boot() {
  const { createHostImports } = require('../lib/host-imports');
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const clock = { now: 1000 };
  const ctx = {
    getMemory: () => memory.buffer,
    resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
    onExit: () => {},
    guestNowMs: () => clock.now,
  };
  const base = createHostImports(ctx);
  base.host.memory = memory;
  for (const stub of ['create_thread', 'exit_thread', 'terminate_thread', 'create_event',
    'set_event', 'reset_event', 'wait_single', 'wait_multiple']) base.host[stub] = () => 0;
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(WASM), base);
  ctx.exports = instance.exports;
  instance.exports.init_thread(1, IMAGE_BASE, 0, 0, 0, 0, 0);
  return { e: instance.exports, clock };
}

async function main() {
  const { e, clock } = await boot();
  const K = e.get_spin_park_k() >>> 0;

  // ---- 1. the debounce threshold --------------------------------------
  // K reads of the same millisecond from the same call site with nothing in
  // between. The first K-1 complete normally; the Kth parks. "Completes
  // normally" is checked as hard as the park is, because a detector that
  // swallowed an ordinary clock read would be far worse than one that never
  // fires.
  check('K is a sane threshold', K >= 2 && K <= 64, `K=${K}`);
  e.test_spin_reset();
  let parkedAt = -1, allCompleted = true;
  for (let i = 1; i <= K; i++) {
    const bits = e.test_clock_spin_once() >>> 0;
    if (bits & PARKED) { parkedAt = i; break; }
    if ((bits & (POPPED | RETURNED)) !== (POPPED | RETURNED)) allCompleted = false;
  }
  check('the reads before the threshold complete: frame popped, clock returned', allCompleted);
  check(`the ${K}th identical read parks`, parkedAt === K, `parked at ${parkedAt}`);
  check('one trip recorded', (e.get_clock_spin_parks() >>> 0) === 1);

  // ---- 2. the park's contract -----------------------------------------
  // The parked call must be re-enterable. Popping the frame or leaving EIP on
  // the caller's block would splice the call out, and the guest would come back
  // past its own timeGetTime with the arguments still on the stack.
  e.test_spin_reset();
  let parkBits = 0;
  for (let i = 0; i < K; i++) parkBits = e.test_clock_spin_once() >>> 0;
  check('the park leaves the stdcall frame untouched', (parkBits & FRAME_INTACT) !== 0);
  check('the park raises $handler_set_eip', (parkBits & SET_EIP) !== 0);
  check('the park does NOT pop the frame', (parkBits & POPPED) === 0);
  check('the park names a deadline one millisecond ahead',
    (e.get_spin_deadline_ms() >>> 0) === clock.now + 1,
    `deadline=${e.get_spin_deadline_ms() >>> 0} now=${clock.now}`);

  // ---- 3. reset on a changed value ------------------------------------
  // The safety filter that matters most. A game that reads the clock once per
  // frame sees a different millisecond every time and must never debounce, no
  // matter how many frames it renders.
  e.test_spin_reset();
  let parkedOnMovingClock = false;
  for (let i = 0; i < K * 5; i++) {
    clock.now += 1;
    if ((e.test_clock_spin_once() >>> 0) & PARKED) parkedOnMovingClock = true;
  }
  check('a moving clock never debounces', !parkedOnMovingClock);
  check('no trips on a moving clock', (e.get_clock_spin_parks() >>> 0) === 0);

  // A clock that moves only every other read still must not park: the run
  // resets on the change, so it can never accumulate K.
  e.test_spin_reset();
  let parkedOnHalfRate = false;
  for (let i = 0; i < K * 5; i++) {
    if (i % 2 === 0) clock.now += 1;
    if ((e.test_clock_spin_once() >>> 0) & PARKED) parkedOnHalfRate = true;
  }
  check('a clock that moves every other read never debounces', !parkedOnHalfRate);

  // ---- 4. reset on an interleaved call --------------------------------
  // The guest did something else between the two reads, so it is not spinning
  // even though the millisecond did not change. This is the condition that
  // keeps a real frame loop out: rendering is API calls.
  e.test_spin_reset();
  let parkedWithWork = false;
  for (let i = 0; i < K * 5; i++) {
    e.test_clock_spin_once();
    e.test_spin_other_call();
    if ((e.get_clock_spin_count() >>> 0) >= K) parkedWithWork = true;
  }
  check('a call between two identical reads resets the run', !parkedWithWork);
  check('no trips when the guest is doing other work',
    (e.get_clock_spin_parks() >>> 0) === 0);

  // ---- 5. one park per millisecond ------------------------------------
  // Progress guarantee. If the host hands the guest back with the clock still
  // reading the same thing, parking again would be an infinite ping-pong; the
  // honest answer is to let it spin until the millisecond moves.
  e.test_spin_reset();
  for (let i = 0; i < K * 4; i++) e.test_clock_spin_once();
  check('a stalled clock is parked on exactly once',
    (e.get_clock_spin_parks() >>> 0) === 1, `${e.get_clock_spin_parks() >>> 0} trips`);
  clock.now += 1;
  for (let i = 0; i < K * 2; i++) e.test_clock_spin_once();
  check('the next millisecond re-arms the park',
    (e.get_clock_spin_parks() >>> 0) === 2, `${e.get_clock_spin_parks() >>> 0} trips`);

  // ---- 6. the off switch ----------------------------------------------
  // --no-spin-park is the A/B arm that decides whether a suspicious stall is
  // this feature's fault, so it has to actually disable the detector.
  e.test_spin_reset();
  e.set_spin_park_k(0);
  let parkedWhenOff = false;
  for (let i = 0; i < 200; i++) {
    if ((e.test_clock_spin_once() >>> 0) & PARKED) parkedWhenOff = true;
  }
  check('K=0 disables the clock detector', !parkedWhenOff);
  check('K=0 records no trips', (e.get_clock_spin_parks() >>> 0) === 0);
  e.set_spin_park_k(K);

  // ---- 7. the PeekMessage detector ------------------------------------
  // Same machinery, no value to compare: "the queue was empty" is the repeated
  // observation. A scratch MSG buffer well inside the image is enough; the
  // empty path does not write to it.
  const MSG = IMAGE_BASE + 0x2000;
  e.test_spin_reset();
  let peekParkedAt = -1, peekBits = 0;
  for (let i = 1; i <= K; i++) {
    peekBits = e.test_peek_spin_once(MSG) >>> 0;
    if (peekBits & PARKED) { peekParkedAt = i; break; }
  }
  check(`the ${K}th consecutive empty peek parks`, peekParkedAt === K,
    `parked at ${peekParkedAt}`);
  check('the peek park leaves the stdcall frame untouched',
    (peekBits & FRAME_INTACT) !== 0);
  check('the peek park raises $handler_set_eip', (peekBits & SET_EIP) !== 0);
  check('the peek park does NOT pop the 5-arg frame', (peekBits & POPPED) === 0);
  check('one peek trip recorded', (e.get_peek_spin_parks() >>> 0) === 1);

  // The reset that makes the peek detector safe. An ordinary game loop is
  // empty-peek, render, empty-peek — and if that debounced, every game in the
  // corpus would stall on its second frame.
  e.test_spin_reset();
  let peekRunHigh = false;
  for (let i = 0; i < K * 5; i++) {
    e.test_peek_spin_once(MSG);
    e.test_spin_other_call();
    if ((e.get_peek_spin_count() >>> 0) >= K) peekRunHigh = true;
  }
  check('a call between two empty peeks resets the run', !peekRunHigh);
  check('no peek trips in a pump that does work',
    (e.get_peek_spin_parks() >>> 0) === 0, `${e.get_peek_spin_parks() >>> 0} trips`);

  e.test_spin_reset();
  e.set_spin_park_k(0);
  let peekParkedWhenOff = false;
  for (let i = 0; i < 200; i++) {
    if ((e.test_peek_spin_once(MSG) >>> 0) & PARKED) peekParkedWhenOff = true;
  }
  check('K=0 disables the peek detector too', !peekParkedWhenOff);
  e.set_spin_park_k(K);

  // ---- 8. the sleep the browser turns a park into ----------------------
  // host.js in a vm context, exactly as test/test-browser-park-sleep.js does.
  // The two reasons have different deadlines and both are capped: a wake source
  // we got wrong must degrade to 20 Hz polling, never to a hang.
  const hostSource = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8');
  const context = {
    MessageChannel: class { constructor() { this.port1 = {}; this.port2 = { postMessage() {} }; } },
    URLSearchParams,
    console,
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    performance: { now: () => 100000 },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  };
  vm.runInNewContext(hostSource + '\n;globalThis.WineAssembly = WineAssembly;', context);
  const WineAssembly = context.WineAssembly;
  const CAP = WineAssembly.MAX_PARK_SLEEP_MS;

  const host = (exports) => {
    const w = new WineAssembly();
    w.running = true;
    w.instance = { exports: Object.assign({
      get_yield_reason: () => 0,
      get_wait_timeout: () => 0xFFFFFFFF,
      next_timer_due_ms: () => -1,
      get_spin_deadline_ms: () => 0,
      get_tick_count: () => 0,
    }, exports) };
    w.threadManager = { hasActiveThreads: () => false, _mainSleepUntil: 0 };
    w.renderer = { _recentMessageWakeAt: 0 };
    return w;
  };

  check('a clock park sleeps to the millisecond it named',
    host({ get_spin_deadline_ms: () => 1001, get_tick_count: () => 1000 })._spinParkDelay(14) === 1);
  check('a clock park never sleeps zero',
    host({ get_spin_deadline_ms: () => 1000, get_tick_count: () => 1000 })._spinParkDelay(14) === 1);
  check('a clock park is capped',
    host({ get_spin_deadline_ms: () => 9999, get_tick_count: () => 0 })._spinParkDelay(14) === CAP,
    `cap=${CAP}`);
  check('a peek park with no timer sleeps the cap',
    host({})._spinParkDelay(15) === CAP);
  check('a peek park sleeps until the next timer is due',
    host({ next_timer_due_ms: () => 12 })._spinParkDelay(15) === 12);
  check('a peek park with an overdue timer still sleeps at least a millisecond',
    host({ next_timer_due_ms: () => 0 })._spinParkDelay(15) === 1);
  check('a peek park is capped',
    host({ next_timer_due_ms: () => 5000 })._spinParkDelay(15) === CAP);

  // The recorded delay is single-use: this step's yield handler sets it, this
  // step's tail consumes it. Leaking it into the next step would shorten a
  // sleep that has nothing to do with a spin.
  const w = host({});
  w._spinParkSleepMs = 3;
  check('a recorded spin delay reaches _parkedSleepMs', w._parkedSleepMs() === 3);
  check('and is consumed exactly once', w._parkedSleepMs() === CAP);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
