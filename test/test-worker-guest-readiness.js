#!/usr/bin/env node
'use strict';

// Exercise the browser test's actual sampler with a virtual clock. No browser
// or guest is needed to prove that slow readiness stays bounded and truthful.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, 'test-worker-guest.js'), 'utf8');
const start = source.indexOf('  const sampleStarted = Date.now();');
const end = source.indexOf('  fs.mkdirSync(OUT', start);
assert(start >= 0 && end > start, 'readiness sampler must be present');
const sampler = source.slice(start, end);

async function sample(readyAfterMs) {
  let clock = 0, samples = 0;
  const result = await vm.runInNewContext(`(async () => {
    ${sampler}
    return { peak, readyAtMs, firstProgress, lastProgress };
  })()`, {
    Date: { now: () => clock },
    wait: async ms => { clock += ms; },
    console: { log() {} },
    page: { evaluate: async () => {
      samples++;
      return { backend: 'worker', spawned: 3, workers: 3, alive: 1,
        slices: clock >= readyAfterMs ? 11 : 4,
        progress: { mainPending: 1, mainSlices: 1, rpcServed: samples * 100 } };
    } },
  });
  return { ...result, clock, samples };
}

(async () => {
  const immediate = await sample(1000);
  assert.strictEqual(immediate.readyAtMs, 1000);
  assert.strictEqual(immediate.samples, 12, 'retain all original samples after early readiness');
  const slow = await sample(16000);
  assert.strictEqual(slow.readyAtMs, 16000, 'continue observing past the former 12-second cutoff');
  assert.strictEqual(slow.peak.slices, 11, 'retain the original execution threshold');
  const stalled = await sample(Infinity);
  assert.strictEqual(stalled.readyAtMs, null);
  assert.strictEqual(stalled.peak.slices, 4, 'a stalled guest must not become a passing sample');
  assert.strictEqual(stalled.clock, 60000, 'unready sampling stops at the wall-clock deadline');
  assert(stalled.lastProgress.rpcServed > stalled.firstProgress.rpcServed);
  console.log('PASS browser worker readiness: original samples, slow progress, finite failure');
})().catch(error => { console.error(error); process.exitCode = 1; });
