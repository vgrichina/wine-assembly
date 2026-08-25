#!/usr/bin/env node
'use strict';

// mciGetDeviceIDA shares the alias namespace populated by mciSendStringA.
// Half-Life Uplink opens its startup video as "sierravideo" and immediately
// resolves that alias before entering the menu.

const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');

const memory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
const imports = createHostImports(ctx);
imports.host.memory = memory;
const bytes = new Uint8Array(memory.buffer);
const write = (at, value) => {
  bytes.set(Buffer.from(value + '\0', 'ascii'), at);
  return at;
};

assert.strictEqual(imports.host.mci_string(
  write(0x100, 'open intro.avi type avivideo alias SierraVideo'), 0, 0), 0,
'mciSendStringA accepts an aliased video device');
const id = imports.host.mci_get_device_id(write(0x200, 'sierravideo'));
assert(id > 0, 'mciGetDeviceIDA resolves aliases case-insensitively');
assert.strictEqual(imports.host.mci_get_device_id(write(0x240, 'missing')), 0,
  'unknown aliases return zero');
assert.strictEqual(imports.host.mci_string(write(0x280, 'close SierraVideo'), 0, 0), 0,
  'closing the aliased device succeeds');
assert.strictEqual(imports.host.mci_get_device_id(write(0x2c0, 'SierraVideo')), 0,
  'closed aliases are no longer visible');

console.log('test-mci-get-device-id: PASS');
