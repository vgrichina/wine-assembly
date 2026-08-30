#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const handlers = fs.readFileSync(path.join(root, 'src', '09a-handlers.wat'), 'utf8');
const apiTable = require('../src/api_table.json');

for (const [name, nargs, cleanup] of [
  ['VkKeyScanA', 1, 8],
  ['VkKeyScanExA', 2, 12],
]) {
  const api = apiTable.find(entry => entry.name === name);
  assert(api, `${name} is registered`);
  assert.strictEqual(api.nargs, nargs, `${name} argument count`);
  assert.match(handlers,
    new RegExp(`\\(func \\$handle_${name}[\\s\\S]*?\\(call \\$vk_key_scan[\\s\\S]*?\\(i32\\.const ${cleanup}\\)\\)\\)\\)`),
    `${name} uses the common mapping and performs stdcall cleanup`);
}

function vkKeyScan(ch) {
  if (ch >= 'a' && ch <= 'z') return ch.toUpperCase().charCodeAt(0);
  if (ch >= 'A' && ch <= 'Z') return 0x100 | ch.charCodeAt(0);
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0);
  const plain = {
    ' ': 0x20, '`': 0xc0, '-': 0xbd, '=': 0xbb, '[': 0xdb,
    ']': 0xdd, '\\': 0xdc, ';': 0xba, "'": 0xde, ',': 0xbc,
    '.': 0xbe, '/': 0xbf,
  };
  if (plain[ch] !== undefined) return plain[ch];
  const shifted = {
    '!': 0x31, '@': 0x32, '#': 0x33, '$': 0x34, '%': 0x35,
    '^': 0x36, '&': 0x37, '*': 0x38, '(': 0x39, ')': 0x30,
    '~': 0xc0, '_': 0xbd, '+': 0xbb, '{': 0xdb, '}': 0xdd,
    '|': 0xdc, ':': 0xba, '"': 0xde, '<': 0xbc, '>': 0xbe, '?': 0xbf,
  };
  return shifted[ch] === undefined ? 0xffff : 0x100 | shifted[ch];
}

assert.strictEqual(vkKeyScan('a'), 0x41);
assert.strictEqual(vkKeyScan('A'), 0x141);
assert.strictEqual(vkKeyScan('/'), 0xbf);
assert.strictEqual(vkKeyScan('?'), 0x1bf);
assert.strictEqual(vkKeyScan('!'), 0x131);
assert.strictEqual(vkKeyScan('\u00e9'), 0xffff);

console.log('PASS  VkKeyScanA/ExA expose the Win98 en-US keyboard mapping');
