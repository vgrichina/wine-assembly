#!/usr/bin/env node
'use strict';

// EDIT keeps an ANSI internal buffer for painting, but a control created by
// CreateWindowExW must consume and produce UTF-16 for the window-text messages.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_create_unicode_edit") (result i32)
    (local $hwnd i32)
    (local.set $hwnd (call $ctrl_create_child
      (i32.const 0) (i32.const 2) (i32.const 100)
      (i32.const 0) (i32.const 0) (i32.const 200) (i32.const 24)
      (i32.const 0x50010000) (i32.const 0)))
    (call $wnd_unicode_set (local.get $hwnd) (i32.const 1))
    (local.get $hwnd))

  (func (export "test_edit_message")
    (param $hwnd i32) (param $msg i32) (param $wp i32) (param $lp i32)
    (result i32)
    (call $edit_wndproc
      (local.get $hwnd) (local.get $msg) (local.get $wp) (local.get $lp)))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const hwnd = e.test_create_unicode_edit() >>> 0;
  const src = 0x2800;
  const dst = 0x2a00;
  const value = 'C:\\GOG Games\\Lure of the Temptress';

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    e.guest_write8(src + i * 2, code & 0xff);
    e.guest_write8(src + i * 2 + 1, code >>> 8);
  }
  e.guest_write8(src + value.length * 2, 0);
  e.guest_write8(src + value.length * 2 + 1, 0);

  assert.strictEqual(e.test_edit_message(hwnd, 0x000c, 0, src) | 0, 1,
    'Unicode WM_SETTEXT succeeds');
  assert.strictEqual(e.test_edit_message(hwnd, 0x000e, 0, 0) | 0, value.length,
    'WM_GETTEXTLENGTH counts UTF-16 code units, not bytes');
  assert.strictEqual(e.test_edit_message(hwnd, 0x000d, 260, dst) | 0, value.length,
    'Unicode WM_GETTEXT returns the character count');

  let roundTrip = '';
  for (let i = 0; i < 260; i++) {
    const code = e.guest_read8(dst + i * 2) |
      (e.guest_read8(dst + i * 2 + 1) << 8);
    if (!code) break;
    roundTrip += String.fromCharCode(code);
  }
  assert.strictEqual(roundTrip, value);

  console.log('PASS  Unicode EDIT window text round-trips through UTF-16 messages');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
