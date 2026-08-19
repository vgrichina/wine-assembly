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

console.log('PASS  DirectSound ordinal imports resolve to named handlers');
