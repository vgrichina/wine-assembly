#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const handlers = fs.readFileSync(path.join(root, 'src', '09a-handlers.wat'), 'utf8');
const apiTable = require('../src/api_table.json');

for (const name of ['SetFileApisToOEM', 'SetFileApisToANSI', 'AreFileApisANSI']) {
  const api = apiTable.find(entry => entry.name === name);
  assert(api, `${name} is registered`);
  assert.strictEqual(api.nargs, 0, `${name} takes no arguments`);
}

assert.match(handlers,
  /\(func \$handle_SetFileApisToOEM[\s\S]*?\(global\.set \$file_apis_ansi \(i32\.const 0\)\)[\s\S]*?\(i32\.const 4\)\)\)\)/,
  'OEM setter changes process mode and pops the return address');
assert.match(handlers,
  /\(func \$handle_SetFileApisToANSI[\s\S]*?\(global\.set \$file_apis_ansi \(i32\.const 1\)\)[\s\S]*?\(i32\.const 4\)\)\)\)/,
  'ANSI setter restores process mode and pops the return address');
assert.match(handlers,
  /\(func \$handle_AreFileApisANSI[\s\S]*?\(global\.set \$eax \(global\.get \$file_apis_ansi\)\)[\s\S]*?\(i32\.const 4\)\)\)\)/,
  'query returns the selected process mode');

console.log('PASS  Win98 file-API ANSI/OEM selection is observable process state');
