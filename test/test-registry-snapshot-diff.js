#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  decodeRegistrySnapshot,
  diffRegistrySnapshots,
  startupRegistryFromDiff,
} = require('../lib/registry-snapshot');

const reg = values => JSON.stringify({ values });
const before = {
  'reg:HKLM\\Software\\Demo': reg({
    Kept: { type: 1, data: 'same' },
    Changed: { type: 4, data: 1 },
    Removed: { type: 1, data: 'old' },
  }),
  'reg:HKCU\\Software\\OldEmpty': reg({}),
  'ini:win.ini': JSON.stringify({ values: { ignored: 'yes' } }),
  broken: 'not registry data',
};
const after = {
  'reg:hklm\\software\\DEMO': reg({
    kept: { type: 1, data: 'same' },
    changed: { type: 4, data: 2 },
    Added: { type: 1, data: 'new' },
  }),
  'reg:HKLM\\Software\\NewEmpty': reg({}),
  'reg:HKCU\\Software\\Binary': reg({
    Bytes: { type: 3, data: [1, 2, 3] },
  }),
};

const decoded = decodeRegistrySnapshot(after);
assert.strictEqual(decoded.values.size, 4, 'registry values decode while INI data stays out');

const diff = diffRegistrySnapshots(before, after);
assert.deepStrictEqual(diff.addedKeys, [
  'HKCU\\Software\\Binary',
  'HKLM\\Software\\NewEmpty',
]);
assert.deepStrictEqual(diff.removedKeys, ['HKCU\\Software\\OldEmpty']);
assert.deepStrictEqual(diff.added.map(entry => entry.valueName), ['Bytes', 'Added']);
assert.strictEqual(diff.changed.length, 1);
assert.strictEqual(diff.changed[0].before.data, 1);
assert.strictEqual(diff.changed[0].after.data, 2);
assert.deepStrictEqual(diff.removed.map(entry => entry.valueName), ['Removed']);

const startup = startupRegistryFromDiff(diff);
assert.deepStrictEqual(startup, [
  { keyPath: 'HKCU\\Software\\Binary', valueName: 'Bytes', type: 3, data: [1, 2, 3] },
  { keyPath: 'hklm\\software\\DEMO', valueName: 'Added', type: 1, data: 'new' },
  { keyPath: 'hklm\\software\\DEMO', valueName: 'changed', type: 4, data: 2 },
]);

console.log('PASS installer registry snapshots diff case-insensitively');
console.log('PASS registry deltas convert to app startupRegistry entries');
