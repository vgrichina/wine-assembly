#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { createBatchClock } = require('../lib/batch-clock');

const clock = createBatchClock(200, 1);
clock.state.batch = 500;
assert.deepStrictEqual(
  [clock.getTicks(), clock.getTicks(), clock.getTicks(), clock.getTicks()],
  [100000, 100001, 100002, 100003],
  'calls within one batch advance deterministic guest time');

// This is the sequence that trapped SDL 1.2 in its Win32 message pump: its
// 100ms timer was armed on the fourth tick call, then the next headless batch
// reset callsInBatch while retaining the same batch number. Returning 100000
// after 100003 makes unsigned elapsed-time arithmetic report a huge interval.
clock.state.callsInBatch = 0;
assert.strictEqual(clock.getTicks(), 100003,
  'resetting a batch call counter cannot move guest time backwards');
assert.strictEqual(clock.getTicks(), 100003,
  'the clock remains clamped until the deterministic batch timeline catches up');
assert.strictEqual(clock.getTicks(), 100003);
assert.strictEqual(clock.getTicks(), 100003);
assert.strictEqual(clock.getTicks(), 100004,
  'intra-batch ticking resumes after catching the previous high-water mark');

for (let i = 0; i < 300; i++) clock.getTicks();
assert.strictEqual(clock.getTicks(), 100199,
  'calls cannot advance beyond the next deterministic batch boundary');

clock.state.batch = 501;
clock.state.callsInBatch = 0;
assert.strictEqual(clock.getTicks(), 100200,
  'a later batch advances to its deterministic base time');

console.log('PASS  headless batch clock is monotonic across call-counter resets');
