#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  comparePixelSets,
  parseArgs,
  parseOracle,
  readHistory,
  referencePixels,
  writeHistory,
} = require('../tools/font-render-history');

const oracle = parseOracle([
  'noise',
  'G code=65 format=1 needed=8 metrics=3,2,-1,2,3,0 hex=A000000040000000',
  '',
].join('\n'));
assert.strictEqual(oracle.size, 1);
assert.deepStrictEqual(oracle.get(65).metrics, [3, 2, -1, 2, 3, 0]);
assert.deepStrictEqual([...referencePixels(oracle.get(65))].sort(),
  ['-1,1', '0,0', '1,1']);
assert.deepStrictEqual(comparePixelSets(
  new Set(['-1,1', '1,0']), new Set(['-1,1', '0,0'])), {
  oursInk: 2,
  referenceInk: 2,
  intersection: 1,
  union: 3,
  inkIoU: 1 / 3,
});

const parsed = parseArgs([
  '--repo=.', '--ppem=12', '--font=/tmp/a.ttf',
  '--oracle=/tmp/a.serial', '--history=/tmp/history.json', '--commit=abc123',
], '/unused');
assert.strictEqual(parsed.repo, process.cwd());
assert.strictEqual(parsed.ppem, 12);
assert.strictEqual(parsed.font, '/tmp/a.ttf');
assert.strictEqual(parsed.commit, 'abc123');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'font-render-history-'));
const historyPath = path.join(temp, 'history.json');
const first = { commit: 'abc', runtimeSha256: 'one', ppem: 10, exactGlyphs: 1 };
writeHistory(historyPath, first);
writeHistory(historyPath, { ...first, exactGlyphs: 2 });
writeHistory(historyPath,
  { commit: 'def', runtimeSha256: 'two', ppem: 10, exactGlyphs: 3 });
const history = readHistory(historyPath);
assert.strictEqual(history.runs.length, 2, 'same runtime run must be replaced');
assert.strictEqual(history.runs[0].exactGlyphs, 2);
assert.strictEqual(history.runs[1].exactGlyphs, 3);

console.log('PASS font render history parser, pixel metric, and keyed ledger');
