#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_call_SetWindowLongA_id")
    (param $hwnd i32) (param $id i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_SetWindowLongA
      (local.get $hwnd) (i32.const -12) (local.get $id)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_GetDlgCtrlID")
    (param $hwnd i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetDlgCtrlID
      (local.get $hwnd) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_GetWindowLongA_id")
    (param $hwnd i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetWindowLongA
      (local.get $hwnd) (i32.const -12) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_GetWindowLongA_hinstance")
    (param $hwnd i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetWindowLongA
      (local.get $hwnd) (i32.const -6) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_set_window_hinstance")
    (param $hwnd i32) (param $hinstance i32)
    (call $wnd_set_hinstance (local.get $hwnd) (local.get $hinstance)))

  (func (export "test_call_SetWindowContextHelpId")
    (param $hwnd i32) (param $help_id i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_SetWindowContextHelpId
      (local.get $hwnd) (local.get $help_id) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_GetQueueStatus")
    (param $flags i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetQueueStatus
      (local.get $flags) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_set_post_queue_count") (param $count i32)
    (global.set $post_queue_count (local.get $count)))

  (func (export "test_default_paint_validates")
    (param $hwnd i32) (result i32)
    (local $saved_esp i32) (local $before i32)
    (call $update_invalidate_rect
      (local.get $hwnd) (i32.const 1) (i32.const 2)
      (i32.const 30) (i32.const 40))
    (local.set $before (call $update_get_rect (local.get $hwnd) (i32.const 0)))
    (local.set $saved_esp (global.get $esp))
    (call $handle_DefWindowProcA
      (local.get $hwnd) (i32.const 0x000F) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (i32.or (i32.shl (local.get $before) (i32.const 1))
      (call $update_get_rect (local.get $hwnd) (i32.const 0))))

  (func (export "test_call_GetDlgItem_id")
    (param $parent i32) (param $id i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetDlgItem
      (local.get $parent) (local.get $id) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_create_button_with_id")
    (param $id i32) (result i32)
    (local $parent i32)
    (local.set $parent (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $parent) (global.get $WNDPROC_BUILTIN))
    (drop (call $wnd_set_style (local.get $parent) (i32.const 0x90000000)))
    (call $ctrl_create_child
      (local.get $parent) (i32.const 1) (local.get $id)
      (i32.const 0) (i32.const 0) (i32.const 75) (i32.const 23)
      (i32.const 0x50010000) (i32.const 0)))

  (func (export "test_button_state_id")
    (param $hwnd i32) (result i32)
    (i32.load offset=12 (call $g2w (call $wnd_get_state_ptr (local.get $hwnd)))))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat });
  const child = e.test_create_edit(0, 0, 40, 20, 0x50000000, 0) >>> 0;
  const parent = e.wnd_get_parent(child) >>> 0;

  assert.strictEqual(e.test_call_GetDlgCtrlID(child), 100,
    'new child starts with its creation-time control ID');
  assert.strictEqual(e.test_call_GetWindowLongA_id(child), 100,
    'GetWindowLongA(GWL_ID) returns the creation-time control ID');
  e.test_set_window_hinstance(child, 0x0058D000);
  assert.strictEqual(e.test_call_GetWindowLongA_hinstance(child) >>> 0, 0x0058D000,
    'GetWindowLongA(GWL_HINSTANCE) retains a DLL-owned window module');
  assert.strictEqual(e.test_call_SetWindowContextHelpId(child, -1), 1,
    'SetWindowContextHelpId accepts a valid framework-owned window');
  assert.strictEqual(e.test_call_SetWindowContextHelpId(0x7FFFFFFF, -1), 0,
    'SetWindowContextHelpId rejects an invalid window');
  assert.strictEqual(e.test_call_GetQueueStatus(0x0040), 0,
    'GetQueueStatus leaves unsupported QS_SENDMESSAGE clear');
  e.test_set_post_queue_count(1);
  assert.strictEqual(e.test_call_GetQueueStatus(0x0008) >>> 0, 0x00080000,
    'GetQueueStatus reports queued QS_POSTMESSAGE state in the high word');
  e.test_set_post_queue_count(0);
  assert.strictEqual(e.test_default_paint_validates(child), 2,
    'DefWindowProcA(WM_PAINT) validates an outstanding update region');
  assert.strictEqual(e.test_call_GetDlgItem_id(parent, 100) >>> 0, child,
    'parent resolves the original child ID');

  assert.strictEqual(e.test_call_SetWindowLongA_id(child, 0xEA21), 100,
    'SetWindowLongA(GWL_ID) returns the previous child ID');
  assert.strictEqual(e.test_call_GetDlgCtrlID(child), 0xEA21,
    'GetDlgCtrlID observes the replacement child ID');
  assert.strictEqual(e.test_call_GetWindowLongA_id(child), 0xEA21,
    'GetWindowLongA(GWL_ID) observes the replacement child ID');
  assert.strictEqual(e.test_call_GetDlgItem_id(parent, 100), 0,
    'the old child ID no longer resolves');
  assert.strictEqual(e.test_call_GetDlgItem_id(parent, 0xEA21) >>> 0, child,
    'the replacement child ID resolves to the saved view');

  const button = e.test_create_button_with_id(0) >>> 0;
  assert.strictEqual(e.test_button_state_id(button), 0,
    'BUTTON starts with the hMenu-derived creation ID in native state');
  assert.strictEqual(e.test_call_SetWindowLongA_id(button, 0x1234), 0,
    'SetWindowLongA(GWL_ID) returns BUTTON\'s previous zero ID');
  assert.strictEqual(e.test_button_state_id(button), 0x1234,
    'SetWindowLongA(GWL_ID) synchronizes BUTTON notification state');

  assert.strictEqual(e.test_call_SetWindowLongA_id(0x7FFFFFFF, 1), 0,
    'an invalid window is not assigned a control ID');
  assert.strictEqual(e.test_call_GetWindowLongA_id(0x7FFFFFFF), 0,
    'an invalid window returns zero without inventing a control ID');

  console.log('PASS  SetWindowLongA(GWL_ID) updates child lookup atomically');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
