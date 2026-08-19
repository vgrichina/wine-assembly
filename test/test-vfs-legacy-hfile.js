#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { VirtualFS } = require('../lib/filesystem');

const vfs = new VirtualFS();
vfs.files.set('c:\\sample.hlp', {
  data: new Uint8Array([1, 2, 3, 4]),
  attrs: 0x20,
});

const modern = vfs.createFile('C:\\sample.hlp', 0x80000000, 3);
assert(modern > 0xffff, 'ordinary CreateFile handle stays in the Win32 namespace');

const legacy = vfs.createLegacyFile('C:\\sample.hlp', 0x80000000, 3);
assert(legacy >= 4 && legacy < 0xffff, '_lopen handle fits in a 16-bit HFILE');

const buffer = new Uint8Array(4);
assert.deepStrictEqual(vfs.readFile(legacy, buffer, 4), { ok: true, bytesRead: 4 });
assert.deepStrictEqual([...buffer], [1, 2, 3, 4]);
assert.strictEqual(vfs.setFilePointer(legacy, 1, 0), 1);
assert.strictEqual(vfs.setEndOfFile(legacy), true,
  'SetEndOfFile truncates at the current legacy-handle position');
assert.deepStrictEqual([...vfs.files.get('c:\\sample.hlp').data], [1]);

assert.strictEqual(vfs.setFilePointer(legacy, 6, 0), 6);
assert.strictEqual(vfs.setEndOfFile(legacy), true,
  'SetEndOfFile extends with zero bytes when the pointer is past EOF');
assert.deepStrictEqual([...vfs.files.get('c:\\sample.hlp').data], [1, 0, 0, 0, 0, 0]);
assert.strictEqual(vfs.setEndOfFile(0xdead), false,
  'SetEndOfFile rejects an invalid handle');
assert.strictEqual(vfs.closeHandle(legacy), true);

console.log('legacy HFILE compatibility: PASS');
