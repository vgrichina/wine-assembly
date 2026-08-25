#!/usr/bin/env node

// The perf HUD's pointer counters. These exist because a step histogram can
// look perfect while a game still feels laggy: pointer-to-paddle latency is
// not made of step time, it is how long a move waits in the queue and how
// many moves the guest samples per second. Nothing else in the HUD can see
// either, so nothing else can tell "the emulator is slow" from "the emulator
// is fine and the input path is behind".

const assert = require('assert');

require('../lib/perf-hud.js');
const perf = globalThis.WinePerf;
assert(perf, 'lib/perf-hud.js did not install WinePerf');

// Disabled is the default, and a disabled HUD must record nothing at all --
// the queue path calls this seam on every pointer sample.
perf.inputMove(false);
perf.inputTake(1);
assert.strictEqual(perf.inputMoves.length, 0, 'recorded a move while disabled');
assert.strictEqual(perf.inputTaken.length, 0, 'recorded a take while disabled');

perf.enabled = true;
perf._startedAt = performance.now();

// 40 moves, a third of them coalesced away, all consumed with a known age.
const started = performance.now();
for (let i = 0; i < 40; i++) {
  perf.inputMove(i % 3 === 0);
  if (i % 3 !== 0) perf.inputTake(started - 8);
}

const snap = perf.snapshot();
assert(snap.input, 'snapshot has no input section');
assert.strictEqual(perf.inputMoves.length, 26, `queued moves: ${perf.inputMoves.length}`);
assert.strictEqual(perf.inputCoalesced.length, 14, `coalesced moves: ${perf.inputCoalesced.length}`);
assert.strictEqual(perf.inputTaken.length, 26, `taken moves: ${perf.inputTaken.length}`);

// Age is measured from the stamp the queue put on the event, so a move that
// was queued 8ms ago must report at least 8ms and not wildly more.
assert(snap.input.ageMs.p50 >= 8, `age p50 too low: ${snap.input.ageMs.p50}`);
assert(snap.input.ageMs.max < 200, `age max implausible: ${snap.input.ageMs.max}`);

// Rates are per second over the ring's own span. These all land in one tight
// burst, so the exact number is not the point -- that it is a positive rate
// derived from timestamps, rather than a raw count, is.
assert(snap.input.movesPerSec > 0, 'movesPerSec did not report');
assert(snap.input.takenPerSec > 0, 'takenPerSec did not report');
assert(snap.input.coalescedPerSec > 0, 'coalescedPerSec did not report');

// A move with no stamp (a synthetic event, or one queued before the HUD was
// switched on) must not be reported as having waited since the epoch.
perf.inputTaken.length = 0;
perf.inputTake(0);
assert.strictEqual(perf.inputTaken[0].ageMs, 0, 'unstamped event reported a bogus age');

// The rings are bounded: a long session must not grow them without limit.
for (let i = 0; i < 1000; i++) perf.inputMove(false);
assert(perf.inputMoves.length <= 240, `move ring unbounded: ${perf.inputMoves.length}`);

// And the queue path itself has to stamp what it enqueues, or every age
// above reads 0 forever. This is the one line in lib/renderer-input.js the
// HUD depends on, so assert its shape rather than trusting it.
const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'renderer-input.js'), 'utf8');
assert(/evt\.queuedAt = _perfNow\(\)/.test(src), 'renderer-input no longer stamps queuedAt');
assert(/if \(evt\.queuedAt\) _perfInputTake\(evt\.queuedAt\)/.test(src), 'takeInput no longer reports queue age');

console.log('PASS perf HUD pointer counters: rates, queue age, bounded rings, queue-path stamp');
