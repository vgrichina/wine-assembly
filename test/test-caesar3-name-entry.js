#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { EXE_PATCHES, applyExeCompatibilityPatches } = require('../lib/app-profiles');
const { GUEST_BASE } = require('../lib/region-map.generated');

const imageBase = 0x400000;
const memory = new ArrayBuffer(0x180000);
const bytes = new Uint8Array(memory);
const wasmExports = {
  get_image_base: () => imageBase,
  get_guest_base: () => GUEST_BASE,
};
const patches = EXE_PATCHES['c3.exe'];

assert(patches && patches.length === 1, 'Caesar III has one narrow name-entry patch');
const patch = patches[0];
const wa = patch.addr - imageBase + GUEST_BASE;
bytes.set(patch.expected, wa);

const logs = [];
assert.strictEqual(applyExeCompatibilityPatches('c3.exe', wasmExports, memory, {
  log: message => logs.push(message),
}), 1, 'the exact demo executable accepts the patch');
assert.deepStrictEqual([...bytes.slice(wa, wa + patch.replacement.length)], patch.replacement,
  'the default-name copy is replaced by a bounded 32-byte clear');
assert(logs.some(line => line.includes(patch.label)), 'patch application is reported');

bytes[wa] ^= 0xff;
assert.strictEqual(applyExeCompatibilityPatches('c3.exe', wasmExports, memory, {
  log: () => {}, warn: () => {},
}), 0, 'a different or already-modified executable is left untouched');

console.log('PASS  Caesar III exact-image name entry starts with an empty buffer');
