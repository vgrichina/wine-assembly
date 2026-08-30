#!/usr/bin/env node

'use strict';

const assert = require('assert');
const apiTable = require('../src/api_table.json');
const { bootRenderHarness } = require('./render-helper');

const extraWat = `
  (func (export "test_add_window")
      (param $hwnd i32) (param $parent i32) (param $owner i32) (param $style i32)
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_DIALOG))
    (call $wnd_set_parent (local.get $hwnd) (local.get $parent))
    (call $wnd_set_owner (local.get $hwnd) (local.get $owner))
    (drop (call $wnd_set_style (local.get $hwnd) (local.get $style))))

  (func (export "test_get_ancestor") (param $hwnd i32) (param $flags i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetAncestor
      (local.get $hwnd) (local.get $flags) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_show_owned_popups")
      (param $owner i32) (param $show i32) (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_ShowOwnedPopups
      (local.get $owner) (local.get $show) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

(async () => {
  assert.strictEqual(apiTable.find(entry => entry.name === 'GetAncestor').nargs, 2,
    'GetAncestor is available to dynamic import callers');
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const ownerRoot = 0x10020;
  const popup = 0x10021;
  const child = 0x10022;
  const otherPopup = 0x10023;
  const WS_CHILD = 0x40000000;
  const WS_POPUP = 0x80000000;
  const WS_VISIBLE = 0x10000000;
  wat.test_add_window(ownerRoot, 0, 0, WS_POPUP | WS_VISIBLE);
  wat.test_add_window(popup, 0, ownerRoot, WS_POPUP | WS_VISIBLE);
  wat.test_add_window(child, popup, 0, WS_CHILD | WS_VISIBLE);
  wat.test_add_window(otherPopup, 0, 0, WS_POPUP | WS_VISIBLE);

  assert.strictEqual(wat.test_get_ancestor(child, 1) >>> 0, popup,
    'GA_PARENT returns the immediate parent');
  assert.strictEqual(wat.test_get_ancestor(child, 2) >>> 0, popup,
    'GA_ROOT stops at the child hierarchy root');
  assert.strictEqual(wat.test_get_ancestor(child, 3) >>> 0, ownerRoot,
    'GA_ROOTOWNER follows the root popup owner');
  assert.strictEqual(wat.test_get_ancestor(popup, 1), 0,
    'GA_PARENT does not substitute a top-level owner');
  assert.strictEqual(wat.test_get_ancestor(0x7ffffffe, 2), 0,
    'an invalid window has no ancestor');
  assert.strictEqual(wat.test_get_ancestor(child, 99), 0,
    'an unsupported flag returns NULL');

  const hidden = wat.test_show_owned_popups(ownerRoot, 0);
  assert.strictEqual(Number(hidden & 0xffffffffn), 1,
    'ShowOwnedPopups accepts a real owner');
  assert.strictEqual(Number(hidden >> 32n), 0x0030000c,
    'ShowOwnedPopups pops two stdcall arguments and its return address');
  assert.strictEqual(wat.wnd_get_style_export(popup) & WS_VISIBLE, 0,
    'ShowOwnedPopups hides the directly owned popup');
  assert.notStrictEqual(wat.wnd_get_style_export(child) & WS_VISIBLE, 0,
    'ShowOwnedPopups does not rewrite child visibility');
  assert.notStrictEqual(wat.wnd_get_style_export(otherPopup) & WS_VISIBLE, 0,
    'ShowOwnedPopups does not hide unrelated top-level windows');
  assert.strictEqual(Number(wat.test_show_owned_popups(ownerRoot, 1) & 0xffffffffn), 1,
    'ShowOwnedPopups restores owned popups');
  assert.notStrictEqual(wat.wnd_get_style_export(popup) & WS_VISIBLE, 0,
    'restored owned popup is visible in USER state');
  assert.strictEqual(Number(wat.test_show_owned_popups(0x7ffffffe, 0) & 0xffffffffn), 0,
    'ShowOwnedPopups rejects an invalid owner');

  console.log('PASS GetAncestor and ShowOwnedPopups preserve parent/owner behavior');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
