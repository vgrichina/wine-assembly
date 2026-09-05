#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { EXE_PATCHES, applyExeCompatibilityPatches } = require('../lib/app-profiles');
const { GUEST_BASE: guestBase } = require('../lib/region-map.generated');

const imageBase = 0x400000;
const memory = new ArrayBuffer(0x220000);
const bytes = new Uint8Array(memory);
const wasmExports = {
  get_image_base: () => imageBase,
  get_guest_base: () => guestBase,
};
const patches = EXE_PATCHES['ww.exe'];

assert.strictEqual(patches.length, 1, 'War Wind patch count');
const patch = patches[0];
const wa = patch.addr - imageBase + guestBase;
bytes.set(patch.expected, wa);

const logs = [];
assert.strictEqual(applyExeCompatibilityPatches('WW.EXE', wasmExports, memory, {
  log: message => logs.push(message),
}), 1, 'verified War Wind binary is patched');
assert.deepStrictEqual([...bytes.slice(wa, wa + patch.replacement.length)], patch.replacement,
  'Unlock reload uses the buffer pointer saved by the matching Lock');
assert.match(logs[0], /audio worker unlocks its successfully locked buffer/);

assert.strictEqual(applyExeCompatibilityPatches('ww.exe', wasmExports, memory, {
  log: () => {},
  warn: () => {},
}), 0, 'already-patched bytes are refused');

bytes.set(patch.expected, wa);
bytes[wa + 1] ^= 0xff;
assert.strictEqual(applyExeCompatibilityPatches('ww.exe', wasmExports, memory, {
  log: () => {},
  warn: () => {},
}), 0, 'a different ww.exe build is left untouched');

console.log('PASS  War Wind audio worker Unlock keeps its successfully locked buffer');
