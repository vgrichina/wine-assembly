#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');

const memory = new WebAssembly.Memory({ initial: 1 });
const bytes = new Uint8Array(memory.buffer);
const dllNameWA = 0x100;
bytes.set(Buffer.from('DSOUND.dll\0', 'ascii'), dllNameWA);

const apiTable = [
  { id: 470, name: 'DirectSoundCreate' },
  { id: 1236, name: 'DirectSoundEnumerateA' },
  { id: 2600, name: 'KERNEL32_Ordinal99' },
];
const { host } = createHostImports({
  getMemory: () => memory.buffer,
  renderer: null,
  resourceJson: {},
  apiTable,
});

assert.strictEqual(host.resolve_ordinal(dllNameWA, 1), 470,
  'DSOUND ordinal 1 resolves DirectSoundCreate');
assert.strictEqual(host.resolve_ordinal(dllNameWA, 2), 1236,
  'DSOUND ordinal 2 resolves DirectSoundEnumerateA');
assert.strictEqual(host.resolve_ordinal(dllNameWA, 99), -1,
  'unknown DirectSound ordinals remain fail-fast diagnostics');

bytes.fill(0, dllNameWA, dllNameWA + 32);
bytes.set(Buffer.from('KERNEL32.dll\0', 'ascii'), dllNameWA);
assert.strictEqual(host.resolve_ordinal(dllNameWA, 99), 2600,
  'Win98 KERNEL32 ordinal 99 resolves to its one-argument timezone classifier');
assert.strictEqual(host.resolve_ordinal(dllNameWA, 98), -1,
  'unknown KERNEL32 ordinals remain fail-fast diagnostics');

console.log('PASS  DirectSound and Win98 KERNEL32 ordinal imports resolve to named handlers');
