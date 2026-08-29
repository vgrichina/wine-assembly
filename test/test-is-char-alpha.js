#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const handlers = fs.readFileSync(path.join(root, 'src', '09a-handlers.wat'), 'utf8');
const apiTable = require('../src/api_table.json');

const api = apiTable.find(entry => entry.name === 'IsCharAlphaA');
assert(api, 'IsCharAlphaA is registered');
assert.strictEqual(api.nargs, 1, 'IsCharAlphaA consumes one promoted CHAR argument');
assert.match(handlers,
  /\(func \$handle_IsCharAlphaA[\s\S]*?\(call \$ctype1_ascii_flags[\s\S]*?\(i32\.const 0x100\)[\s\S]*?\(i32\.const 8\)\)\)\)/,
  'IsCharAlphaA reuses ANSI C1_ALPHA classification and pops ret plus one argument');

const alphaNumericApi = apiTable.find(entry => entry.name === 'IsCharAlphaNumericA');
assert(alphaNumericApi, 'IsCharAlphaNumericA is registered');
assert.strictEqual(alphaNumericApi.nargs, 1,
  'IsCharAlphaNumericA consumes one promoted CHAR argument');
assert.match(handlers,
  /\(func \$handle_IsCharAlphaNumericA[\s\S]*?\(call \$ctype1_ascii_flags[\s\S]*?\(i32\.const 0x104\)[\s\S]*?\(i32\.const 8\)\)\)\)/,
  'IsCharAlphaNumericA accepts C1_ALPHA or C1_DIGIT and pops ret plus one argument');

function isCharAlphaA(value) {
  const ch = value & 0xff;
  return (ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a);
}

for (const ch of ['A', 'Z', 'a', 'z']) assert.strictEqual(isCharAlphaA(ch.charCodeAt(0)), true);
for (const ch of ['0', '_', ' ', '[']) assert.strictEqual(isCharAlphaA(ch.charCodeAt(0)), false);
assert.strictEqual(isCharAlphaA(0x12341), true, 'only the promoted low ANSI byte is classified');

function isCharAlphaNumericA(value) {
  const ch = value & 0xff;
  return isCharAlphaA(ch) || (ch >= 0x30 && ch <= 0x39);
}

for (const ch of ['A', 'z', '0', '9']) {
  assert.strictEqual(isCharAlphaNumericA(ch.charCodeAt(0)), true);
}
for (const ch of ['_', ' ', '[', '!']) {
  assert.strictEqual(isCharAlphaNumericA(ch.charCodeAt(0)), false);
}

console.log('PASS  IsCharAlphaA/IsCharAlphaNumericA expose bounded ANSI classification');
