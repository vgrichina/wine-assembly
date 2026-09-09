#!/usr/bin/env node

// The drive loop's "the guest is parked, so sleep" decision, and the two
// lifecycle policies that hang off it: the hidden-tab pause and the lazy
// AudioContext.
//
// This exists because the alternative is a browser. Every one of these rules
// is a pure function of state the host already has -- a yield reason, a wait
// timeout, a timer deadline, document.hidden, whether anything asked for audio
// -- so all of it is testable in a vm context with stub globals, and none of it
// needs a page. Loading host.js in that context also evaluates the class-level
// constants, which is what a `WineHost.MAX_PARK_SLEEP_MS` typo against a class
// actually named WineAssembly looks like: a ReferenceError on a plain launch.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const hostSource = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8');

const timers = [];
// Well clear of zero: the tick-freeze guard treats a non-positive origin as
// "not started yet" and leaves it alone, so a clock that starts at 1000 and a
// state seeded four seconds earlier would be testing the wrong branch.
let nowMs = 100000;
const fakeSetTimeout = (fn, ms) => {
  const id = timers.length + 1;
  timers.push({ id, fn, dueAt: nowMs + (ms || 0), ms: ms || 0, cleared: false });
  return id;
};
const fakeClearTimeout = id => {
  const t = timers.find(entry => entry.id === id);
  if (t) t.cleared = true;
};
const pendingTimers = () => timers.filter(t => !t.cleared && !t.fired);
const runTimer = () => {
  const t = pendingTimers()[0];
  assert.ok(t, 'expected a pending timeout');
  t.fired = true;
  t.fn();
  return t;
};

class FakeMessageChannel {
  constructor() {
    this.port1 = { onmessage: null };
    this.port2 = { postMessage: () => {} };
  }
}

let audioContexts = 0;
class FakeAudioContext {
  constructor() { audioContexts++; this.state = 'running'; this.currentTime = 0; }
  resume() { this.state = 'running'; }
  suspend() { this.state = 'suspended'; }
  close() { this.state = 'closed'; }
}

const documentStub = { hidden: false, addEventListener() {}, removeEventListener() {} };

const context = {
  MessageChannel: FakeMessageChannel,
  AudioContext: FakeAudioContext,
  URLSearchParams,
  console,
  document: documentStub,
  performance: { now: () => nowMs },
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
};
vm.runInNewContext(hostSource + '\n;globalThis.WineAssembly = WineAssembly;', context);
const WineAssembly = context.WineAssembly;

// The constants the drive loop reads. A reference to a class that does not
// exist throws here rather than on somebody's app launch.
assert.strictEqual(typeof WineAssembly.MAX_PARK_SLEEP_MS, 'number');
assert.strictEqual(typeof WineAssembly.AUDIO_IDLE_SUSPEND_MS, 'number');
assert.strictEqual(WineAssembly.GUEST_TICK_POLL_STRIDE, 4,
  'the browser default reuses one wall sample for four within-slice calls');

// --------------------------------------------------------- guest tick stride

{
  const wine = new WineAssembly();
  const state = wine._guestTickState();
  let reads = 0;
  wine._audioSchedulerNow = () => { reads++; return nowMs; };
  wine.guestTickPollStride = 4;
  wine._beginGuestTickBatch();
  assert.strictEqual(reads, 1, 'a slice boundary refreshes wall time');
  nowMs += 1;
  assert.deepStrictEqual([
    wine._guestTickMs(), wine._guestTickMs(), wine._guestTickMs(),
  ], [0, 0, 0], 'the first N-1 calls reuse the slice-boundary sample');
  assert.strictEqual(reads, 1, 'reused guest ticks do not read performance.now');
  assert.strictEqual(wine._guestTickMs(), 1, 'the stride boundary refreshes guest time');
  assert.strictEqual(reads, 2, 'the stride boundary performs exactly one new wall read');

  nowMs += 9;
  wine._beginGuestTickBatch();
  assert.strictEqual(reads, 3, 'the next run slice refreshes even before N calls');
  assert.strictEqual(state.batchMs, 10, 'a sparse caller sees current time each slice');

  wine.guestTickPollStride = 1;
  nowMs += 1;
  assert.strictEqual(wine._guestTickMs(), 11, 'stride one preserves exact per-call refresh');
  assert.strictEqual(reads, 4, 'stride one reads the wall on every guest call');
}

// ---------------------------------------------------------------- scheduling

{
  const wine = new WineAssembly();
  wine.running = true;
  let ran = 0;
  const step = () => { ran++; };

  // delay 0 keeps the unclamped MessageChannel path byte for byte.
  wine._scheduleStep(step, 0);
  assert.strictEqual(pendingTimers().length, 0, 'a zero delay must not use a timer');
  assert.strictEqual(wine._pendingStep, step, 'a zero delay posts on the port');
  wine._stepListenPort.onmessage();
  assert.strictEqual(ran, 1);

  // A positive delay sleeps instead.
  wine._scheduleStep(step, 12);
  assert.strictEqual(pendingTimers().length, 1, 'a positive delay schedules a timeout');
  assert.strictEqual(pendingTimers()[0].ms, 12, 'the requested delay is honoured');
  runTimer();
  assert.strictEqual(ran, 2, 'the timeout runs the slice');

  // Nothing may sleep past the cap: a wake source we forgot degrades to 20Hz
  // polling, never to a hang.
  wine._scheduleStep(step, 5000);
  assert.strictEqual(pendingTimers()[0].ms, WineAssembly.MAX_PARK_SLEEP_MS,
    'a sleep is clamped to MAX_PARK_SLEEP_MS');

  // A wake cancels the sleep and steps immediately.
  const before = ran;
  wine._wakeStep();
  assert.strictEqual(pendingTimers().length, 0, 'waking cancels the pending sleep');
  wine._stepListenPort.onmessage();
  assert.strictEqual(ran, before + 1, 'waking runs the slice through the fast path');

  // A stopped host cancels its sleep rather than leaving a timer holding the
  // 512MB shared memory alive.
  wine._scheduleStep(step, 40);
  wine.stop({ repaint: false });
  assert.strictEqual(pendingTimers().length, 0, 'stop() cancels a pending parked sleep');
}

// ------------------------------------------------------------ sleep deadline

function parkedHost(options = {}) {
  const wine = new WineAssembly();
  wine.running = true;
  wine.instance = { exports: Object.assign({
    get_yield_reason: () => options.yieldReason | 0,
    get_wait_timeout: () => (options.waitTimeout === undefined ? 0xFFFFFFFF : options.waitTimeout) >>> 0,
    next_timer_due_ms: () => (options.timerDueMs === undefined ? -1 : options.timerDueMs) | 0,
  }, options.exports || {}) };
  wine.threadManager = {
    hasActiveThreads: () => !!options.activeThreads,
    _mainSleepUntil: options.mainSleepUntil || 0,
  };
  wine.renderer = { _recentMessageWakeAt: options.recentWakeAt || 0 };
  return wine;
}

// A GetMessage park with no timer at all: nothing but an external event can
// wake it, and those wake the loop explicitly. Poll at the cap.
assert.strictEqual(parkedHost({ yieldReason: 7 })._parkedSleepMs(),
  WineAssembly.MAX_PARK_SLEEP_MS, 'a message wait with no timer sleeps the cap');

// A WM_TIMER is the one wake source that arrives with nothing touching the
// emulator, so its deadline is the sleep.
assert.strictEqual(parkedHost({ yieldReason: 7, timerDueMs: 17 })._parkedSleepMs(), 17,
  'a message wait sleeps until the next timer is due');

// A timer already overdue still means park -- returning 0 would put the loop
// straight back into the spin this exists to end.
assert.strictEqual(parkedHost({ yieldReason: 7, timerDueMs: 0 })._parkedSleepMs(), 1,
  'an overdue timer still parks, for the minimum');

// A bounded wait carries its own deadline; an infinite one does not.
assert.strictEqual(parkedHost({ yieldReason: 1, waitTimeout: 30 })._parkedSleepMs(), 30,
  'a bounded wait sleeps its own timeout');
assert.strictEqual(parkedHost({ yieldReason: 1, waitTimeout: 0xFFFFFFFF })._parkedSleepMs(),
  WineAssembly.MAX_PARK_SLEEP_MS, 'an infinite wait sleeps the cap');

// Sleep(n) on the main thread.
assert.strictEqual(parkedHost({ mainSleepUntil: nowMs + 8 })._parkedSleepMs(), 8,
  'a main-thread Sleep sleeps the rest of its interval');

// A worker with runnable code is the other half of this step. The machine is
// not idle just because the main thread is.
assert.strictEqual(parkedHost({ yieldReason: 7, activeThreads: true })._parkedSleepMs(), 0,
  'active guest threads forbid sleeping');

// Do not sleep through the tail of an interaction.
assert.strictEqual(parkedHost({ yieldReason: 7, recentWakeAt: nowMs - 10 })._parkedSleepMs(), 0,
  'recent input forbids sleeping');
assert.strictEqual(parkedHost({ yieldReason: 7, recentWakeAt: nowMs - 500 })._parkedSleepMs(),
  WineAssembly.MAX_PARK_SLEEP_MS, 'old input does not forbid sleeping');

// The soonest of several deadlines wins.
assert.strictEqual(
  parkedHost({ yieldReason: 7, timerDueMs: 40, mainSleepUntil: nowMs + 9 })._parkedSleepMs(), 9,
  'the soonest deadline decides');

// ------------------------------------------------------------- hidden pause

{
  const wine = new WineAssembly();
  wine.running = true;
  documentStub.hidden = false;
  assert.strictEqual(wine._maybePauseForHidden(), false, 'a visible tab does not pause');

  documentStub.hidden = true;
  // Audible playback is the one case worth the battery.
  wine._sharedAudio = { waveOutHotUntilMs: nowMs + 5000 };
  assert.strictEqual(wine._maybePauseForHidden(), false,
    'a hidden tab playing audio keeps running');

  wine._sharedAudio = { waveOutHotUntilMs: 0, cdAudioHotUntilMs: nowMs + 5000 };
  assert.strictEqual(wine._maybePauseForHidden(), false,
    'a hidden tab playing an MCI audio CD keeps running');

  wine._sharedAudio = { waveOutHotUntilMs: 0, cdAudioHotUntilMs: 0 };
  const tickState = wine._guestTickState(null);
  tickState.wallStartMs = nowMs - 4000;
  assert.strictEqual(wine._maybePauseForHidden(), true, 'a hidden silent tab pauses');
  assert.strictEqual(wine._hiddenPaused, true);

  // Guest time must not jump when the tab comes back: every WM_TIMER the app
  // owns would be instantly overdue and fire a backlog.
  const startBefore = tickState.wallStartMs;
  nowMs += 30000;
  let resumed = 0;
  wine._pausedStep = () => { resumed++; };
  documentStub.hidden = false;
  wine._resumeFromHidden();
  assert.strictEqual(wine._hiddenPaused, false);
  assert.strictEqual(tickState.wallStartMs, startBefore + 30000,
    'the guest clock origin slides by the paused interval, so guest time froze');
  wine._stepListenPort.onmessage();
  assert.strictEqual(resumed, 1, 'resuming restarts the step chain');
}

// --------------------------------------------------------------- lazy audio

{
  audioContexts = 0;
  const wine = new WineAssembly();
  assert.strictEqual(wine.primeAudio(), null,
    'no AudioContext exists before the guest asks for audio');
  assert.strictEqual(audioContexts, 0,
    'a launch gesture alone must not build an AudioContext');

  wine.markAudioRequested();
  const ac = wine.primeAudio();
  assert.ok(ac, 'the first audio API use makes a gesture worth spending');
  assert.strictEqual(audioContexts, 1);
  assert.strictEqual(ac.state, 'running');

  // Suspended for silence, then brought back by the one call that knows sound
  // is imminent. Never closed: a closed context cannot be reopened.
  ac.suspend();
  wine.wakeAudio();
  assert.strictEqual(ac.state, 'running', 'wakeAudio resumes a suspended context');

  // Once a context exists, priming it again is still allowed -- that is the
  // iOS gesture unlock, and it must keep working.
  ac.state = 'suspended';
  assert.strictEqual(wine.primeAudio(), ac, 'priming reuses the existing context');
  assert.strictEqual(ac.state, 'running');
  assert.strictEqual(audioContexts, 1, 'priming does not build a second context');
}

console.log('PASS  parked-sleep deadlines, hidden-tab pause and lazy AudioContext');
