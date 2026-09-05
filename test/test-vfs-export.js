#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveVfsToHost } = require('../lib/vfs-export');

const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-vfs-export-'));
const logs = [];
const vfs = {
  files: new Map([
    ['c:\\tree', { data: Uint8Array.from([1, 2, 3]) }],
    ['c:\\tree\\child.bin', { data: Uint8Array.from([4, 5]) }],
    ['c:\\normal.bin', { data: Uint8Array.from([6]) }],
    ['c:\\app.exe', { data: Uint8Array.from([7]) }],
    ['d:\\disc.bin', {
      _provider: { readRange() {} },
      get data() { throw new Error('lazy media must not be materialized by export'); },
    }],
  ]),
  dirs: new Set(['c:', 'c:\\', 'c:\\tree']),
};

const written = saveVfsToHost(vfs, outputRoot, {
  skipPaths: ['c:\\app.exe'],
  log: line => logs.push(line),
});

assert.deepStrictEqual(
  [...fs.readFileSync(path.join(outputRoot, 'tree.__vfs_file__'))],
  [1, 2, 3],
  'a file that collides with a guest directory should survive under the collision suffix');
assert.deepStrictEqual(
  [...fs.readFileSync(path.join(outputRoot, 'tree', 'child.bin'))],
  [4, 5],
  'the colliding directory tree should remain intact');
assert.deepStrictEqual([...fs.readFileSync(path.join(outputRoot, 'normal.bin'))], [6]);
assert(!fs.existsSync(path.join(outputRoot, 'app.exe')), 'explicitly skipped files should not export');
assert(!fs.existsSync(path.join(outputRoot, 'd:', 'disc.bin')), 'lazy source media should not export');
assert.strictEqual(written.filter(entry => entry.collision).length, 1);
assert(logs.some(line => /file\/directory collision: c:\\tree -> tree\.__vfs_file__/.test(line)),
  'the lossy host namespace translation should be visible in the log');
assert(logs.some(line => /skip lazy media file d:\\disc\.bin/.test(line)),
  'skipped provider-backed media should be visible in the log');

console.log('PASS vfs export preserves file/directory collisions');
