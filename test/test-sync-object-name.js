#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readSyncObjectName } = require('../lib/mem-utils');

const buffer = new ArrayBuffer(64);
const bytes = new Uint8Array(buffer);
bytes.set(Buffer.from('Alpha\0', 'ascii'), 4);
const wide = new DataView(buffer);
wide.setUint16(16, 'B'.charCodeAt(0), true);
wide.setUint16(18, 0x03a9, true);
wide.setUint16(20, 0, true);

assert.strictEqual(readSyncObjectName(buffer, 0, 0), '');
assert.strictEqual(readSyncObjectName(buffer, 4, 0), 'Alpha');
assert.strictEqual(readSyncObjectName(buffer, 4, 2), 'Alpha',
  'mutex bit must not change ANSI decoding');
assert.strictEqual(readSyncObjectName(buffer, 16, 1), 'B\u03a9');
assert.strictEqual(readSyncObjectName(buffer, 16, 3), 'B\u03a9',
  'mutex bit must not change UTF-16 decoding');
assert.strictEqual(readSyncObjectName(buffer, 4, 0, 3), 'Alp');
assert.strictEqual(readSyncObjectName({}, 4, 0), '');
assert.strictEqual(readSyncObjectName(buffer, 64, 0), '');
bytes[63] = 0x5a;
assert.strictEqual(readSyncObjectName(buffer, 63, 0), 'Z',
  'a non-terminated ANSI name at the final byte is safely bounded');
assert.strictEqual(readSyncObjectName(buffer, 63, 1), '',
  'a truncated UTF-16 code unit is not read past memory');

const memory = new WebAssembly.Memory({ initial: 1 });
new Uint8Array(memory.buffer).set(Buffer.from('Event\0', 'ascii'), 32);
assert.strictEqual(readSyncObjectName(memory, 32, 0), 'Event');
if (typeof SharedArrayBuffer !== 'undefined') {
  const shared = new SharedArrayBuffer(32);
  new Uint8Array(shared).set(Buffer.from('Shared\0', 'ascii'), 8);
  assert.strictEqual(readSyncObjectName(shared, 8, 0), 'Shared');
}

const ROOT = path.join(__dirname, '..');
const sources = ['lib/mem-utils.js', 'host.js', 'test/run.js']
  .map(file => fs.readFileSync(path.join(ROOT, file), 'utf8'));
assert.strictEqual(sources.reduce((count, source) =>
  count + (source.match(/function readSyncObjectName\s*\(/g) || []).length, 0), 1,
  'the sync-object name decoder must have one implementation');
assert.match(sources[1], /HostMemUtils\.readSyncObjectName\(self\.memory, nameWa, flags\)/);
assert.match(sources[2], /readSyncObjectName\(memory, nameWa, wide\)/);

console.log('PASS  browser and CLI share one bounded sync-object name decoder');
