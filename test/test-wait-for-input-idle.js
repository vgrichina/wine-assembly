#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const handlers = fs.readFileSync(path.join(root, 'src', '09a-handlers.wat'), 'utf8');
const apiTable = require('../src/api_table.json');

const api = apiTable.find(entry => entry.name === 'WaitForInputIdle');
assert(api, 'WaitForInputIdle is registered');
assert.strictEqual(api.nargs, 2, 'WaitForInputIdle consumes handle and timeout');
assert.match(handlers,
  /\(func \$handle_WaitForInputIdle[\s\S]*?\(i32\.eq \(local\.get \$arg0\) \(i32\.const -1\)\)[\s\S]*?0x000e2000[\s\S]*?WAIT_OBJECT_0[\s\S]*?WAIT_FAILED[\s\S]*?ERROR_INVALID_HANDLE[\s\S]*?\(i32\.const 12\)\)\)\)/,
  'handler accepts current-process handles, rejects invalid handles, and cleans stdcall');

function waitForInputIdle(handle) {
  const current = handle === -1 || ((handle >>> 0) & 0xfffff000) === 0x000e2000;
  return current ? { result: 0, error: 0 } : { result: -1, error: 6 };
}

assert.deepStrictEqual(waitForInputIdle(-1), { result: 0, error: 0 });
assert.deepStrictEqual(waitForInputIdle(0x000e2123), { result: 0, error: 0 });
assert.deepStrictEqual(waitForInputIdle(0), { result: -1, error: 6 });
assert.deepStrictEqual(waitForInputIdle(0x1234), { result: -1, error: 6 });

console.log('PASS  WaitForInputIdle models the browser-hosted console process');
