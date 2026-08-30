#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_window_from_point") (param $x i32) (param $y i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_WindowFromPoint
      (local.get $x) (local.get $y) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  const { exports: e, renderer } = await bootRenderHarness({ extraWat });
  const bootstrap = 0x10001;
  const video = 0x10005;
  const WS_VISIBLE = 0x10000000;

  e.wnd_table_set(bootstrap, 0x401000);
  e.wnd_table_set(video, 0x402000);
  e.wnd_set_style_export(bootstrap, 0);
  e.wnd_set_style_export(video, WS_VISIBLE);
  renderer.windows[bootstrap] = {
    hwnd: bootstrap, x: 20, y: 20, w: 320, h: 240, visible: false,
  };
  renderer.windows[video] = {
    hwnd: video, x: 20, y: 20, w: 320, h: 240, visible: true,
  };

  assert.strictEqual(e.test_window_from_point(80, 50) >>> 0, video,
    'a recreated visible video HWND must win over the stale hidden main HWND');
  assert.strictEqual(e.test_window_from_point(500, 400) >>> 0, 0,
    'a point outside every registered window returns NULL');

  e.wnd_set_style_export(bootstrap, WS_VISIBLE);
  renderer.windows[bootstrap].visible = true;
  e.wnd_z_set_after(bootstrap, 0); // HWND_TOP
  assert.strictEqual(e.test_window_from_point(80, 50) >>> 0, bootstrap,
    'overlapping visible windows are selected by live USER z-order');

  console.log('PASS  WindowFromPoint selects the visible topmost HWND');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
