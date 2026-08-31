#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_nc_wake_setup")
    (global.set $next_hwnd (i32.const 0x10002))
    (global.set $main_hwnd (i32.const 0x10001))
    (call $wnd_table_set (i32.const 0x10001) (i32.const 0x00401000))
    (drop (call $wnd_set_style (i32.const 0x10001) (i32.const 0x10000000)))
    (call $nc_flags_set (i32.const 0x10001) (i32.const 8)))
  (func (export "test_nc_wake_set") (param $bits i32)
    (call $nc_flags_set (i32.const 0x10001) (local.get $bits)))
  (func (export "test_nc_wake_clear") (param $bits i32)
    (call $nc_flags_clear (i32.const 0x10001) (local.get $bits)))
  (func (export "test_nc_main_paint_pending") (param $pending i32) (result i32)
    (global.set $paint_pending (local.get $pending))
    (call $paint_flag_test_hwnd (i32.const 0x10001)))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });

  wat.test_nc_wake_setup();
  assert.strictEqual(wat.has_pending_message(), 0,
    'persistent background-erase ownership must not wake GetMessage');

  for (const bit of [1, 2, 4]) {
    wat.test_nc_wake_set(bit);
    assert.strictEqual(wat.has_pending_message(), 1,
      `transient NC flag ${bit} must wake GetMessage`);
    wat.test_nc_wake_clear(bit);
    assert.strictEqual(wat.has_pending_message(), 0,
      `clearing transient NC flag ${bit} must leave persistent bit 8 idle`);
  }

  assert.strictEqual(wat.test_nc_main_paint_pending(1), 1,
    'the erase scheduler must see the main window global paint state');
  assert.strictEqual(wat.test_nc_main_paint_pending(0), 0,
    'clearing the main paint state must leave no per-window paint behind');

  console.log('PASS  persistent NC state does not masquerade as queued message work');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
