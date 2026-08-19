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
    (global.set $dx_coop_hwnd (local.get $cooperative)))
  (func (export "test_dx_target_get") (result i32)
    (call $dx_target_hwnd))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const hiddenApplication = 0x10001;
  const visibleGameForm = 0x10002;

  wat.test_dx_target_seed(hiddenApplication, 0);
  assert.strictEqual(wat.test_dx_target_get() >>> 0, hiddenApplication,
    'DirectDraw callers without SetCooperativeLevel should retain the main-window fallback');

  wat.test_dx_target_seed(hiddenApplication, visibleGameForm);
  assert.strictEqual(wat.test_dx_target_get() >>> 0, visibleGameForm,
    'the cooperative-level HWND must override an earlier hidden application window');

  assert(/\$handle_IDirectDraw_SetCooperativeLevel[\s\S]*?global\.set \$dx_coop_hwnd \(local\.get \$arg1\)/.test(directDrawWat),
    'SetCooperativeLevel must retain its HWND as the DirectDraw presentation owner');
  assert(/Primary surface[\s\S]*?host_move_window \(call \$dx_target_hwnd\)/.test(directDrawWat),
    'primary-surface creation must resize the cooperative window');
  assert(/\$handle_IDirectDraw_SetDisplayMode[\s\S]*?local\.set \$target_hwnd \(call \$dx_target_hwnd\)[\s\S]*?host_move_window \(local\.get \$target_hwnd\)/.test(directDrawWat),
    'SetDisplayMode must resize the cooperative window');
  assert(/\$dx_present[\s\S]*?host_gdi_surface_attach \(local\.get \$surface_id\) \(local\.get \$target_hwnd\)/.test(directDrawWat),
    'DirectDraw presentation must attach its frame to the cooperative window');

  console.log('PASS  DirectDraw presents through the SetCooperativeLevel window');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
