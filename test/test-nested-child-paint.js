#!/usr/bin/env node
'use strict';

// USER propagates a parent's update region through every intersecting visible
// child level. Native-control draining must seed descendants before consuming
// the current control's update region, or nested toolbar/control children lose
// their only repaint geometry.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (global $test_nested_top (mut i32) (i32.const 0))
  (global $test_nested_child (mut i32) (i32.const 0))
  (global $test_nested_grandchild (mut i32) (i32.const 0))

  (func (export "test_create_nested_paint_tree") (result i32)
    (local $top i32) (local $child i32) (local $grandchild i32)
    (local.set $top (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $host_register_dialog_frame
      (local.get $top) (i32.const 0)
      (i32.const 0) (i32.const 200) (i32.const 120) (i32.const 0))
    (call $wnd_table_set (local.get $top) (global.get $WNDPROC_CTRL_NATIVE))
    (drop (call $wnd_set_style (local.get $top) (i32.const 0x90000000)))
    (local.set $child (call $ctrl_create_child
      (local.get $top) (i32.const 3) (i32.const 101)
      (i32.const 10) (i32.const 10) (i32.const 100) (i32.const 60)
      (i32.const 0x50000000) (i32.const 0)))
    (local.set $grandchild (call $ctrl_create_child
      (local.get $child) (i32.const 1) (i32.const 102)
      (i32.const 5) (i32.const 5) (i32.const 40) (i32.const 20)
      (i32.const 0x50000000) (i32.const 0)))
    (global.set $test_nested_top (local.get $top))
    (global.set $test_nested_child (local.get $child))
    (global.set $test_nested_grandchild (local.get $grandchild))
    (local.get $top))

  (func (export "test_nested_child") (result i32)
    (global.get $test_nested_child))
  (func (export "test_nested_grandchild") (result i32)
    (global.get $test_nested_grandchild))

  (func (export "test_nested_clear_paints")
    (call $paint_flag_clear_hwnd (global.get $test_nested_top))
    (call $update_clear_hwnd (global.get $test_nested_top))
    (call $paint_flag_clear_hwnd (global.get $test_nested_child))
    (call $update_clear_hwnd (global.get $test_nested_child))
    (call $paint_flag_clear_hwnd (global.get $test_nested_grandchild))
    (call $update_clear_hwnd (global.get $test_nested_grandchild)))

  (func (export "test_nested_seed_from_top") (result i32)
    (call $update_invalidate_full (global.get $test_nested_top))
    (call $paint_seed_child_paints (global.get $test_nested_top)))

  (func (export "test_nested_queue_child")
    (call $update_invalidate_full (global.get $test_nested_child))
    (call $paint_flag_set (global.get $test_nested_child)))

  (func (export "test_nested_drain") (result i32)
    (call $paint_drain_native_control_paints))

  (func (export "test_nested_has_update") (param $hwnd i32) (result i32)
    (call $update_get_rect (local.get $hwnd) (global.get $PAINT_SCRATCH)))

  (func (export "test_nested_first_pending") (result i32)
    (call $paint_flag_first))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat });
  const top = e.test_create_nested_paint_tree() >>> 0;
  const child = e.test_nested_child() >>> 0;
  const grandchild = e.test_nested_grandchild() >>> 0;
  assert(top && child && grandchild, 'three-level window tree should exist');

  e.test_nested_clear_paints();
  assert.strictEqual(e.test_nested_seed_from_top(), 2,
    'top-level update should seed both child and grandchild');
  assert.strictEqual(e.test_nested_has_update(child), 1,
    'direct child receives an intersected update region');
  assert.strictEqual(e.test_nested_has_update(grandchild), 1,
    'grandchild receives the recursively intersected update region');

  e.test_nested_clear_paints();
  e.test_nested_queue_child();
  assert.strictEqual(e.test_nested_drain(), 2,
    'native-control drain should paint child and seeded grandchild');
  assert.strictEqual(e.test_nested_first_pending() >>> 0, 0,
    'native-control drain should consume the complete nested paint tree');

  console.log('PASS  nested child updates propagate and drain before parent consumption');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
