#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_is_window") (param $hwnd i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_IsWindow
      (local.get $hwnd) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_register_window") (param $hwnd i32)
    (call $wnd_table_set (local.get $hwnd) (i32.const 0x401000)))

  (func (export "test_remove_window") (param $hwnd i32)
    (call $wnd_table_remove (local.get $hwnd)))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat });

  assert.strictEqual(e.test_is_window(0), 0, 'NULL is not a window');
  assert.strictEqual(e.test_is_window(0xffffffff), 0,
    'HWND_BROADCAST is a sentinel, not a window');
  assert.strictEqual(e.test_is_window(0x12345), 0,
    'an unallocated value in the HWND range is not a window');
  assert.strictEqual(e.test_is_window(0x10000), 1,
    'the permanent desktop HWND remains valid without a table slot');

  const hwnd = 0x12345;
  e.test_register_window(hwnd);
  assert.strictEqual(e.test_is_window(hwnd), 1,
    'a registered WND_RECORDS entry is a live window');
  e.test_remove_window(hwnd);
  assert.strictEqual(e.test_is_window(hwnd), 0,
    'a destroyed window handle is no longer valid');

  console.log('PASS  IsWindow requires a live window-table entry');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
