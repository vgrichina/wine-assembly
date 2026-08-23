#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_create_menu") (result i32)
    (global.set $esp (i32.const 0x07000000))
    (call $handle_CreateMenu
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_create_popup_menu") (result i32)
    (global.set $esp (i32.const 0x07000000))
    (call $handle_CreatePopupMenu
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_append_menu")
      (param $menu i32) (param $id i32) (param $text i32) (result i32)
    (global.set $esp (i32.const 0x07000000))
    (call $handle_AppendMenuA
      (local.get $menu) (i32.const 0) (local.get $id) (local.get $text)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_delete_menu")
      (param $menu i32) (param $item i32) (param $flags i32) (result i32)
    (global.set $esp (i32.const 0x07000000))
    (call $handle_DeleteMenu
      (local.get $menu) (local.get $item) (local.get $flags)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat });
  const text = e.guest_alloc(5) >>> 0;
  for (const [offset, value] of [...Buffer.from('Item\0')].entries()) {
    e.guest_write8(text + offset, value);
  }

  const bar = e.test_create_menu() >>> 0;
  assert(bar, 'CreateMenu returns a host-owned handle');
  assert.strictEqual(e.test_delete_menu(bar, 0, 0x400), 0,
    'deleting position zero from an empty menu returns FALSE');
  assert.strictEqual(e.test_append_menu(bar, 101, text), 1);
  assert.strictEqual(e.test_delete_menu(bar, 0, 0x400), 1);
  assert.strictEqual(e.test_delete_menu(bar, 0, 0x400), 0,
    'the removed host item is no longer present');

  const popup = e.test_create_popup_menu() >>> 0;
  assert(popup, 'CreatePopupMenu returns a WAT-owned handle');
  assert.strictEqual(e.test_append_menu(popup, 201, text), 1);
  assert.strictEqual(e.test_append_menu(popup, 202, text), 1);
  assert.strictEqual(e.test_delete_menu(popup, 201, 0), 1,
    'MF_BYCOMMAND removes the matching dynamic item');
  assert.strictEqual(e.test_delete_menu(popup, 0, 0x400), 1,
    'MF_BYPOSITION removes the shifted remaining item');
  assert.strictEqual(e.test_delete_menu(popup, 0, 0x400), 0,
    'an exhausted dynamic menu also returns FALSE');

  console.log('PASS  DeleteMenu removes host/dynamic items and terminates empty-menu loops');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
