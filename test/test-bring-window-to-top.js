#!/usr/bin/env node

'use strict';

const assert = require('assert');
const apiTable = require('../src/api_table.json');
const { bootRenderHarness } = require('./render-helper');

const extraWat = `
  (func (export "test_bring_window_to_top")
      (param $hwnd i32) (param $stack i32) (result i64)
    (global.set $esp (local.get $stack))
    (call $handle_BringWindowToTop
      (local.get $hwnd) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

(async () => {
  const api = apiTable.find(entry => entry.name === 'BringWindowToTop');
  assert(api, 'BringWindowToTop is registered for imported and dynamic calls');
  assert.strictEqual(api.nargs, 1, 'BringWindowToTop has one stdcall argument');

  const calls = [];
  const { exports: wat } = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      set_window_zorder(hwnd, insertAfter) {
        calls.push(['zorder', hwnd >>> 0, insertAfter | 0]);
      },
      activate_window(hwnd) {
        calls.push(['activate', hwnd >>> 0]);
        return (hwnd >>> 0) === 0x10020 ? 1 : 0;
      },
    },
  });

  const stack = 0x074ff000;
  const success = wat.test_bring_window_to_top(0x10020, stack);
  assert.strictEqual(Number(success & 0xffffffffn), 1,
    'BringWindowToTop returns host activation success');
  assert.strictEqual(Number(success >> 32n) >>> 0, stack + 8,
    'BringWindowToTop pops its HWND and return address');
  assert.deepStrictEqual(calls, [
    ['zorder', 0x10020, 0],
    ['activate', 0x10020],
  ], 'BringWindowToTop raises the requested HWND before activating it');

  calls.length = 0;
  const failure = wat.test_bring_window_to_top(0x7ffffffe, stack);
  assert.strictEqual(Number(failure & 0xffffffffn), 0,
    'BringWindowToTop reports invalid HWND activation failure');
  assert.deepStrictEqual(calls, [
    ['zorder', 0x7ffffffe, 0],
    ['activate', 0x7ffffffe],
  ], 'invalid HWNDs still follow the same non-mutating host path');

  console.log('PASS BringWindowToTop raises and activates through the renderer host');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
