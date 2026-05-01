#!/usr/bin/env node
// Regression test for the browser/shared host tick source. Pinball's
// timeGetTime-driven physics loop can stall if consecutive get_ticks()
// calls inside one hot run slice return the same value.

const path = require('path');
const { createMonotonicTickSource } = require(path.join(__dirname, '..', 'lib', 'monotonic-ticks'));

function fail(msg) {
  console.log(`FAIL  ${msg}`);
  process.exit(1);
}

const frozen = createMonotonicTickSource(() => 123456);
const frozenSeq = [frozen(), frozen(), frozen(), frozen()];
if (frozenSeq.join(',') !== '123456,123457,123458,123459') {
  fail(`frozen clock should advance monotonically, got ${frozenSeq.join(',')}`);
}

const jitterValues = [2000, 2000, 1999, 2001, 2001, 2005];
let jitterIdx = 0;
const jitter = createMonotonicTickSource(() => jitterValues[jitterIdx++]);
const jitterSeq = jitterValues.map(() => jitter());
for (let i = 1; i < jitterSeq.length; i++) {
  if (!(jitterSeq[i] > jitterSeq[i - 1])) {
    fail(`non-increasing tick at index ${i}: ${jitterSeq.join(',')}`);
  }
}

console.log('PASS  monotonic tick source survives frozen and jittery wall clock');
