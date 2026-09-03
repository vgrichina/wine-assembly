#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { renderTinySynthNotes, tinySynthTables } = require('../lib/tinysynth-offline');

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function channelEnergy(bytes, channel) {
  let sum = 0;
  for (let at = channel * 2; at < bytes.length; at += 4) {
    const value = bytes.readInt16LE(at);
    sum += value * value;
  }
  return sum;
}

const tables = tinySynthTables();
assert.strictEqual(tables.program.length, 128);
assert.strictEqual(tables.drums.length, 47);
assert.ok(tables.program.every(program => program.p.length), 'every GM program needs operators');
console.log('PASS  bundled TinySynth exposes all GM programs and drums');

const base = {
  duration: 1.5,
  notes: [
    { start: 0.00, dur: 0.55, ch: 0, note: 60, vel: 112, program: 0, pan: 20, channelGain: 1 },
    { start: 0.30, dur: 0.70, ch: 1, note: 67, vel: 104, program: 48, pan: 108, channelGain: 0.8 },
    { start: 0.10, dur: 0.12, ch: 9, note: 36, vel: 120, program: 0, pan: 64, channelGain: 1 },
    { start: 0.55, dur: 0.10, ch: 9, note: 42, vel: 96, program: 0, pan: 64, channelGain: 1 },
  ],
};
const first = renderTinySynthNotes(base, { sampleRate: 11025 });
const again = renderTinySynthNotes(base, { sampleRate: 11025 });
assert.strictEqual(first.channels, 2);
assert.strictEqual(first.bits, 16);
assert.ok(first.peak > 0.02 && first.peak <= 1);
assert.ok(first.instruments >= 4);
assert.strictEqual(digest(first.bytes), digest(again.bytes));
console.log('PASS  offline rendition is audible, stereo, and deterministic');

const leftEnergy = channelEnergy(first.bytes, 0);
const rightEnergy = channelEnergy(first.bytes, 1);
assert.ok(leftEnergy > 0 && rightEnergy > 0);
assert.ok(Math.abs(leftEnergy - rightEnergy) / Math.max(leftEnergy, rightEnergy) > 0.05);
console.log('PASS  channel pan produces a genuine stereo image');

const guitar = renderTinySynthNotes({
  duration: 1,
  notes: [{ start: 0, dur: 0.6, ch: 0, note: 60, vel: 110, program: 24, pan: 64, channelGain: 1 }],
}, { sampleRate: 11025 });
const brass = renderTinySynthNotes({
  duration: 1,
  notes: [{ start: 0, dur: 0.6, ch: 0, note: 60, vel: 110, program: 56, pan: 64, channelGain: 1 }],
}, { sampleRate: 11025 });
assert.notStrictEqual(digest(guitar.bytes), digest(brass.bytes));
console.log('PASS  General MIDI program changes select distinct TinySynth timbres');

const denseDuration = 60;
const denseNotes = [];
for (let i = 0; i < 1600; i++) {
  denseNotes.push({
    start: i * denseDuration / 1600,
    dur: 0.18 + (i % 7) * 0.04,
    ch: i % 11 === 0 ? 9 : i % 8,
    note: i % 11 === 0 ? 35 + (i % 24) : 42 + (i % 43),
    vel: 72 + (i % 50), program: (i * 17) % 128,
    pan: 16 + (i % 97), channelGain: 0.72,
  });
}
const denseStart = performance.now();
const dense = renderTinySynthNotes(
  { duration: denseDuration, notes: denseNotes }, { sampleRate: 11025 });
const denseMs = performance.now() - denseStart;
assert.strictEqual(dense.renderedNotes, denseNotes.length);
assert.strictEqual(dense.bytes.length, denseDuration * 11025 * 4);
assert.ok(denseDuration * 1000 / denseMs > 10,
  `dense score must render at least 10x real time, got ${(denseDuration * 1000 / denseMs).toFixed(1)}x`);
console.log(`PASS  dense 60s/1600-note score renders ${(denseDuration * 1000 / denseMs).toFixed(1)}x real time`);

console.log('TEST PASSED');
