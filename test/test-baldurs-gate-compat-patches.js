#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { EXE_PATCHES, applyExeCompatibilityPatches } = require('../lib/app-profiles');

const imageBase = 0x400000;
// $GUEST_BASE, from the map declared in src/00-regions.wat.
const guestBase = require('../lib/region-map.generated.js').GUEST_BASE;
const memory = new ArrayBuffer(0x220000);
const bytes = new Uint8Array(memory);
const wasmExports = {
  get_image_base: () => imageBase,
  get_guest_base: () => guestBase,
};

for (const [exe, expectedCount] of [['bgdemo.exe', 2], ['bgmain.exe', 2]]) {
  const patches = EXE_PATCHES[exe];
  assert.strictEqual(patches.length, expectedCount, `${exe} patch count`);
  for (const patch of patches) {
    const wa = patch.addr - imageBase + guestBase;
    bytes.set(patch.expected, wa);
  }
  const logs = [];
  assert.strictEqual(applyExeCompatibilityPatches(exe, wasmExports, memory, {
    log: message => logs.push(message),
  }), expectedCount, `${exe} applied patch count`);
  assert.strictEqual(logs.length, expectedCount, `${exe} patch logs`);
  for (const patch of patches) {
    const wa = patch.addr - imageBase + guestBase;
    assert.deepStrictEqual([...bytes.slice(wa, wa + patch.replacement.length)], patch.replacement,
      `${patch.key} replacement bytes`);
  }
  assert.strictEqual(applyExeCompatibilityPatches(exe, wasmExports, memory, {
    log: () => {}, warn: () => {},
  }), 0, `${exe} refuses already-modified bytes`);
}

console.log('PASS  Baldur demo transition patches are verified before application');
