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

for (const [name, flag] of [['IsCharUpperA', '0x01'], ['IsCharLowerA', '0x02']]) {
  const entry = apiTable.find(apiEntry => apiEntry.name === name);
  assert(entry, `${name} is registered`);
  assert.strictEqual(entry.nargs, 1, `${name} consumes one promoted CHAR argument`);
  assert.match(handlers,
    new RegExp(`\\(func \\$handle_${name}[\\s\\S]*?\\(call \\$ctype1_ascii_flags[\\s\\S]*?\\(i32\\.const ${flag}\\)[\\s\\S]*?\\(i32\\.const 8\\)\\)\\)\\)`),
    `${name} reuses ANSI CTYPE1 classification and pops ret plus one argument`);
}

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

function isCharUpperA(value) {
  const ch = value & 0xff;
  return (ch >= 0x41 && ch <= 0x5a)
    || (ch >= 0xc0 && ch <= 0xd6)
    || (ch >= 0xd8 && ch <= 0xde)
    || [0x8a, 0x8c, 0x8e, 0x9f].includes(ch);
}

function isCharLowerA(value) {
  const ch = value & 0xff;
  return (ch >= 0x61 && ch <= 0x7a)
    || (ch >= 0xdf && ch <= 0xf6)
    || (ch >= 0xf8 && ch <= 0xff)
    || [0x9a, 0x9c, 0x9e, 0xb5, 0xaa, 0xba].includes(ch);
}

for (const ch of [0x41, 0xc9, 0x8a, 0x9f]) assert.strictEqual(isCharUpperA(ch), true);
for (const ch of [0x61, 0xe9, 0x9a, 0xdf]) assert.strictEqual(isCharLowerA(ch), true);
for (const ch of [0x61, 0xe9, 0xd7, 0xf7]) assert.strictEqual(isCharUpperA(ch), false);
for (const ch of [0x41, 0xc9, 0xd7, 0xf7]) assert.strictEqual(isCharLowerA(ch), false);
assert.strictEqual(isCharUpperA(0x490041), true,
  'only the promoted low ANSI byte is classified');

for (const ch of ['A', 'z', '0', '9']) {
  assert.strictEqual(isCharAlphaNumericA(ch.charCodeAt(0)), true);
}
for (const ch of ['_', ' ', '[', '!']) {
  assert.strictEqual(isCharAlphaNumericA(ch.charCodeAt(0)), false);
}

console.log('PASS  IsCharAlphaA/IsCharAlphaNumericA expose bounded ANSI classification');
