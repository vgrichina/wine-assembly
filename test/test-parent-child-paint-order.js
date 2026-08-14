#!/usr/bin/env node
'use strict';

// USER must dispatch a dirty parent before a native child whose pixels the
// parent can overwrite. The child remains queued, then repaints after the
// parent's WM_PAINT has propagated its update region down the window tree.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (global $test_order_parent (mut i32) (i32.const 0))
  (global $test_order_child (mut i32) (i32.const 0))

  (func (export "test_order_create") (result i32)
    (local $parent i32) (local $child i32)
    (local.set $parent (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $host_register_dialog_frame
      (local.get $parent) (i32.const 0)
      (i32.const 0) (i32.const 200) (i32.const 80) (i32.const 0))
    ;; An application-owned parent: present in USER's window table, but not
    ;; registered as one of the WAT-native built-in control classes.
    (call $wnd_table_set (local.get $parent) (i32.const 0x00401000))
    (drop (call $wnd_set_style (local.get $parent) (i32.const 0x90000000)))
    (local.set $child (call $ctrl_create_child
      (local.get $parent) (i32.const 4) (i32.const 101)
      (i32.const 0) (i32.const 0) (i32.const 180) (i32.const 24)
      (i32.const 0x50000000) (i32.const 0)))
    (global.set $test_order_parent (local.get $parent))
    (global.set $test_order_child (local.get $child))
    (local.get $parent))

  (func (export "test_order_child") (result i32)
    (global.get $test_order_child))

  (func (export "test_order_clear")
    (call $paint_flag_clear_hwnd (global.get $test_order_parent))
    (call $update_clear_hwnd (global.get $test_order_parent))
    (call $paint_flag_clear_hwnd (global.get $test_order_child))
    (call $update_clear_hwnd (global.get $test_order_child)))

  (func (export "test_order_queue_both")
    (call $paint_flag_set_inv (global.get $test_order_parent))
    (call $paint_flag_set_inv (global.get $test_order_child)))

  (func (export "test_order_drain_native") (result i32)
    (call $paint_drain_native_control_paints))

  (func (export "test_order_select") (result i32)
    (call $paint_select_next_dirty))

  (func (export "test_order_clear_parent")
    (call $paint_flag_clear_hwnd (global.get $test_order_parent))
    (drop (call $paint_seed_child_paints (global.get $test_order_parent)))
    (call $update_clear_hwnd (global.get $test_order_parent)))

  (func (export "test_order_first_pending") (result i32)
    (call $paint_flag_first))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat });
  const parent = e.test_order_create() >>> 0;
  const child = e.test_order_child() >>> 0;
  assert(parent && child, 'parent/child window tree should exist');

  e.test_order_clear();
  e.test_order_queue_both();
  assert.strictEqual(e.test_order_drain_native(), 0,
    'native child must wait while an application-owned ancestor is dirty');
  assert.strictEqual(e.test_order_select() >>> 0, parent,
    'the application-owned ancestor is the next WM_PAINT target');

  e.test_order_clear_parent();
  assert.strictEqual(e.test_order_drain_native(), 1,
    'native child paints after the ancestor update is consumed');
  assert.strictEqual(e.test_order_first_pending() >>> 0, 0,
    'parent and child paint state should be fully consumed');

  console.log('PASS  dirty ancestors paint before WAT-native child controls');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
