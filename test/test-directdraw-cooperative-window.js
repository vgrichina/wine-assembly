#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const directDrawWat = fs.readFileSync(
  path.join(__dirname, '..', 'src', '09a8-handlers-directx.wat'), 'utf8');

const extraWat = String.raw`
  (func (export "test_dx_target_seed") (param $main i32) (param $cooperative i32)
    (global.set $main_hwnd (local.get $main))
    (call $dx_coop_hwnd_set (local.get $cooperative)))
  (func (export "test_dx_target_get") (result i32)
    (call $dx_target_hwnd))

  (func (export "test_exclusive_reveals_guest_visible_window")
      (param $hwnd i32) (result i32)
    (local $entry i32) (local $wrapper i32)
    ;; Reproduce a framework that writes WS_VISIBLE through GWL_STYLE without
    ;; asking USER to show the host window before it enters exclusive mode.
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_BUILTIN))
    (drop (call $wnd_set_style (local.get $hwnd) (i32.const 0x10000000)))
    (local.set $entry (call $dx_alloc (i32.const 1)))
    (local.set $wrapper (call $heap_alloc (i32.const 8)))
    (call $gs32 (local.get $wrapper) (i32.const 0))
    (call $gs32 (i32.add (local.get $wrapper) (i32.const 4))
      (call $dx_slot_of (local.get $entry)))
    (global.set $esp (i32.const 0x074ff000))
    (call $handle_IDirectDraw_SetCooperativeLevel
      (local.get $wrapper) (local.get $hwnd) (i32.const 0x10)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const shown = [];
  const { exports: wat } = await bootRenderHarness({
    extraWat,
    extraHostOverrides: {
      show_window(hwnd, cmd) {
        shown.push([hwnd >>> 0, cmd | 0]);
        return 0;
      },
    },
  });
  const hiddenApplication = 0x10001;
  const visibleGameForm = 0x10002;

  wat.test_dx_target_seed(hiddenApplication, 0);
  assert.strictEqual(wat.test_dx_target_get() >>> 0, hiddenApplication,
    'DirectDraw callers without SetCooperativeLevel should retain the main-window fallback');

  wat.test_dx_target_seed(hiddenApplication, visibleGameForm);
  assert.strictEqual(wat.test_dx_target_get() >>> 0, visibleGameForm,
    'the cooperative-level HWND must override an earlier hidden application window');

  assert.strictEqual(
    wat.test_exclusive_reveals_guest_visible_window(hiddenApplication), 0,
    'SetCooperativeLevel succeeds for a registered device window');
  assert.deepStrictEqual(shown, [[hiddenApplication, 5]],
    'exclusive mode reveals the host window even when guest WS_VISIBLE is already set');

  assert(/\$handle_IDirectDraw_SetCooperativeLevel[\s\S]*?call \$dx_coop_hwnd_set \(local\.get \$arg1\)/.test(directDrawWat),
    'SetCooperativeLevel must retain its HWND as the DirectDraw presentation owner');
  assert(/Under DDSCL_NORMAL[\s\S]*?(?:call \$dx_exclusive_get|global\.get \$dx_exclusive_fullscreen)[\s\S]*?call \$wnd_get_style \(call \$dx_target_hwnd\)[\s\S]*?host_move_window \(call \$dx_target_hwnd\)/.test(directDrawWat),
    'primary-surface creation must resize only exclusive or borderless cooperative windows');
  assert(/\$handle_IDirectDraw_SetDisplayMode[\s\S]*?local\.set \$target_hwnd \(call \$dx_target_hwnd\)[\s\S]*?host_move_window \(local\.get \$target_hwnd\)/.test(directDrawWat),
    'SetDisplayMode must resize the cooperative window');
  assert(/\$dx_present[\s\S]*?host_gdi_surface_attach \(local\.get \$surface_id\) \(local\.get \$target_hwnd\)/.test(directDrawWat),
    'DirectDraw presentation must attach its frame to the cooperative window');

  console.log('PASS  DirectDraw presents through the SetCooperativeLevel window');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
