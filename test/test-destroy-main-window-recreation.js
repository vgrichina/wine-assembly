#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_seed_main_window") (param $hwnd i32)
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_BUILTIN))
    (global.set $main_hwnd (local.get $hwnd)))
  (func (export "test_retire_main_window") (param $hwnd i32) (result i32)
    (call $destroy_main_window_lifecycle (local.get $hwnd))
    (global.get $main_hwnd))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  wat.test_seed_main_window(0x10001);
  assert.strictEqual(wat.get_main_hwnd() >>> 0, 0x10001);
  assert.strictEqual(wat.test_retire_main_window(0x10001) >>> 0, 0,
    'destroying the only top-level clears main_hwnd for its replacement');

  console.log('PASS DestroyWindow clears a lone main HWND before recreation');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
