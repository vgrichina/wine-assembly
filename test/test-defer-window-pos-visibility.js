#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const WS_VISIBLE = 0x10000000;
const SWP_NOREDRAW = 0x0008;
const SWP_SHOWWINDOW = 0x0040;
const SWP_HIDEWINDOW = 0x0080;

const extraWat = String.raw`
  (func (export "test_call_BeginDeferWindowPos") (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_BeginDeferWindowPos
      (i32.const 1) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_DeferWindowPos_flags")
    (param $hdwp i32) (param $hwnd i32) (param $flags i32)
    (param $x i32) (param $y i32) (param $width i32) (param $height i32)
    (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $gs32 (i32.add (local.get $saved_esp) (i32.const 24)) (local.get $width))
    (call $gs32 (i32.add (local.get $saved_esp) (i32.const 28)) (local.get $height))
    (call $gs32 (i32.add (local.get $saved_esp) (i32.const 32)) (local.get $flags))
    (call $handle_DeferWindowPos
      (local.get $hdwp) (local.get $hwnd) (i32.const 0)
      (local.get $x) (local.get $y) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_EndDeferWindowPos") (param $hdwp i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_EndDeferWindowPos
      (local.get $hdwp) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_clear_window_paint") (param $hwnd i32)
    (call $paint_flag_clear_hwnd (local.get $hwnd))
    (call $update_clear_hwnd (local.get $hwnd)))

  (func (export "test_first_pending_paint") (result i32)
    (call $paint_flag_first))

  (func (export "test_select_next_paint") (result i32)
    (call $paint_select_next_dirty))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat });
  const child = e.test_create_edit(0, 0, 40, 20, 0x50000000, 0) >>> 0;
  const parent = e.wnd_get_parent(child) >>> 0;
  e.wnd_set_style_export(parent,
    (e.wnd_get_style_export(parent) | WS_VISIBLE) >>> 0);
  e.test_clear_window_paint(child);

  assert(e.wnd_get_style_export(child) & WS_VISIBLE,
    'test child starts visible');
  let hdwp = e.test_call_BeginDeferWindowPos() >>> 0;
  assert.strictEqual(
    e.test_call_DeferWindowPos_flags(
      hdwp, child, 0x17 | SWP_HIDEWINDOW, 0, 0, 40, 20) >>> 0,
    hdwp,
    'DeferWindowPos returns the deferred-position handle');
  assert(e.wnd_get_style_export(child) & WS_VISIBLE,
    'SWP_HIDEWINDOW remains deferred before End');
  assert.notStrictEqual(e.test_first_pending_paint() >>> 0, child,
    'collecting a hidden window does not queue paint');
  assert.strictEqual(e.test_call_EndDeferWindowPos(hdwp), 1);
  assert.strictEqual(e.wnd_get_style_export(child) & WS_VISIBLE, 0,
    'End commits SWP_HIDEWINDOW to WS_VISIBLE');

  hdwp = e.test_call_BeginDeferWindowPos() >>> 0;
  assert.strictEqual(
    e.test_call_DeferWindowPos_flags(
      hdwp, child, 0x17 | SWP_SHOWWINDOW, 0, 0, 40, 20) >>> 0,
    hdwp,
    'show keeps the deferred-position handle valid');
  assert.strictEqual(e.wnd_get_style_export(child) & WS_VISIBLE, 0,
    'SWP_SHOWWINDOW also waits for End');
  assert.strictEqual(e.test_call_EndDeferWindowPos(hdwp), 1);
  assert(e.wnd_get_style_export(child) & WS_VISIBLE,
    'End commits SWP_SHOWWINDOW to WS_VISIBLE');
  assert.strictEqual(e.test_first_pending_paint() >>> 0, child,
    'a newly shown deferred window is queued for paint');

  e.test_clear_window_paint(child);
  hdwp = e.test_call_BeginDeferWindowPos() >>> 0;
  e.test_call_DeferWindowPos_flags(
    hdwp, child, 0x04 | SWP_NOREDRAW, 3, 4, 42, 22);
  e.test_call_EndDeferWindowPos(hdwp);
  assert.notStrictEqual(e.test_select_next_paint() >>> 0, child,
    'SWP_NOREDRAW does not create an update region');

  e.test_clear_window_paint(child);
  hdwp = e.test_call_BeginDeferWindowPos() >>> 0;
  e.test_call_DeferWindowPos_flags(hdwp, child, 0x04, 7, 8, 44, 24);
  e.test_call_EndDeferWindowPos(hdwp);
  assert.strictEqual(e.test_select_next_paint() >>> 0, parent,
    'ordinary EndDeferWindowPos repaints the parent area uncovered by the move');

  console.log('PASS  deferred visibility and paint state commit only at End');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
