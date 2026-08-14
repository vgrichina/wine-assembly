#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const WS_VISIBLE = 0x10000000;
const SWP_NOREDRAW = 0x0008;
const SWP_SHOWWINDOW = 0x0040;
const SWP_HIDEWINDOW = 0x0080;

const extraWat = String.raw`
  (func (export "test_call_DeferWindowPos_flags")
    (param $hwnd i32) (param $flags i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $gs32 (i32.add (local.get $saved_esp) (i32.const 24)) (i32.const 40))
    (call $gs32 (i32.add (local.get $saved_esp) (i32.const 28)) (i32.const 20))
    (call $gs32 (i32.add (local.get $saved_esp) (i32.const 32)) (local.get $flags))
    (call $handle_DeferWindowPos
      (i32.const 0xDEF00001) (local.get $hwnd) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_clear_window_paint") (param $hwnd i32)
    (call $paint_flag_clear_hwnd (local.get $hwnd)))

  (func (export "test_first_pending_paint") (result i32)
    (call $paint_flag_first))
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
  assert.strictEqual(
    e.test_call_DeferWindowPos_flags(child, 0x17 | SWP_HIDEWINDOW) >>> 0,
    0xDEF00001,
    'DeferWindowPos returns the deferred-position handle');
  assert.strictEqual(e.wnd_get_style_export(child) & WS_VISIBLE, 0,
    'SWP_HIDEWINDOW clears WS_VISIBLE');
  assert.notStrictEqual(e.test_first_pending_paint() >>> 0, child,
    'a hidden deferred window is not queued for paint');

  assert.strictEqual(
    e.test_call_DeferWindowPos_flags(child, 0x17 | SWP_SHOWWINDOW) >>> 0,
    0xDEF00001,
    'show keeps the deferred-position handle valid');
  assert(e.wnd_get_style_export(child) & WS_VISIBLE,
    'SWP_SHOWWINDOW restores WS_VISIBLE');
  assert.strictEqual(e.test_first_pending_paint() >>> 0, child,
    'a newly shown deferred window is queued for paint');

  e.test_clear_window_paint(child);
  e.test_call_DeferWindowPos_flags(child, 0x07 | SWP_NOREDRAW);
  assert.notStrictEqual(e.test_first_pending_paint() >>> 0, child,
    'SWP_NOREDRAW does not create an update region');

  console.log('PASS  DeferWindowPos synchronizes visibility and paint state');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
