#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_menu_get_submenu")
      (param $menu i32) (param $pos i32) (result i32)
    (global.set $esp (i32.const 0x07000000))
    (call $handle_GetSubMenu
      (local.get $menu) (local.get $pos) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_menu_modify_a")
      (param $menu i32) (param $item i32) (param $flags i32)
      (param $id i32) (param $text i32) (result i32)
    (global.set $esp (i32.const 0x07000000))
    (call $handle_ModifyMenuA
      (local.get $menu) (local.get $item) (local.get $flags)
      (local.get $id) (local.get $text) (i32.const 0))
    (global.get $eax))
  (func (export "test_menu_modify_w")
      (param $menu i32) (param $item i32) (param $flags i32)
      (param $id i32) (param $text i32) (result i32)
    (global.set $esp (i32.const 0x07000000))
    (call $handle_ModifyMenuW
      (local.get $menu) (local.get $item) (local.get $flags)
      (local.get $id) (local.get $text) (i32.const 0))
    (global.get $eax))
  (func (export "test_menu_item_count_api") (param $menu i32) (result i32)
    (global.set $esp (i32.const 0x07000000))
    (call $handle_GetMenuItemCount
      (local.get $menu) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_menu_item_id_api")
      (param $menu i32) (param $pos i32) (result i32)
    (global.set $esp (i32.const 0x07000000))
    (call $handle_GetMenuItemID
      (local.get $menu) (local.get $pos) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_menu_is_menu") (param $menu i32) (result i32)
    (global.set $esp (i32.const 0x07000000))
    (call $handle_IsMenu
      (local.get $menu) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_draw_menu_bar") (param $hwnd i32) (result i32)
    (global.set $esp (i32.const 0x07000000))
    (call $handle_DrawMenuBar
      (local.get $hwnd) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  let frameInvalidations = 0;
  const { exports: e } = await bootRenderHarness({
    extraWat,
    extraHostOverrides: {
      invalidate_frame: () => { frameInvalidations++; },
    },
  });

  const MF_CHECKED = 0x0008;
  const MF_POPUP = 0x0010;
  const MF_BYPOSITION = 0x0400;

  const strA = text => {
    const bytes = Buffer.from(text + '\0', 'latin1');
    const guest = e.guest_alloc(bytes.length) >>> 0;
    bytes.forEach((value, index) => e.guest_write8(guest + index, value));
    return guest;
  };
  const strW = text => {
    const guest = e.guest_alloc((text.length + 1) * 2) >>> 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      e.guest_write8(guest + i * 2, code & 0xff);
      e.guest_write8(guest + i * 2 + 1, code >>> 8);
    }
    e.guest_write8(guest + text.length * 2, 0);
    e.guest_write8(guest + text.length * 2 + 1, 0);
    return guest;
  };
  const popup = () => e.test_call_CreatePopupMenu() >>> 0;

  const parent = popup();
  const oldChild = popup();
  const newChild = popup();
  assert.strictEqual(e.test_call_AppendMenuA(
    parent, MF_POPUP, oldChild, strA('More')), 1);
  assert.strictEqual(e.test_call_AppendMenuA(parent, 0, 42, strA('Command')), 1);

  assert.strictEqual(e.test_menu_item_count_api(parent), 2,
    'GetMenuItemCount sees WAT-owned popup items');
  assert.strictEqual(e.test_menu_get_submenu(parent, 0) >>> 0, oldChild,
    'GetSubMenu returns the retained popup handle');
  assert.strictEqual(e.test_menu_get_submenu(parent, 1), 0,
    'GetSubMenu returns NULL for a command item');
  assert.strictEqual(e.test_menu_get_submenu(parent, 2), 0,
    'GetSubMenu returns NULL beyond the menu');
  assert.strictEqual(e.test_menu_item_id_api(parent, 0), -1,
    'GetMenuItemID returns -1 for a popup item');
  assert.strictEqual(e.test_menu_item_id_api(parent, 1), 42);

  assert.strictEqual(e.test_menu_modify_a(
    parent, 0, MF_BYPOSITION | MF_POPUP, newChild, strA('New submenu')), 1);
  assert.strictEqual(e.test_menu_get_submenu(parent, 0) >>> 0, newChild,
    'ModifyMenuA replaces popup ownership in place');
  assert.strictEqual(e.test_menu_item_field(parent, 0, 0) & MF_BYPOSITION, 0,
    'MF_BYPOSITION selects lookup without leaking into retained item state');
  assert.strictEqual(e.test_menu_is_menu(oldChild), 0,
    'replacing a popup destroys and retires the old submenu handle');
  assert.strictEqual(e.test_menu_is_menu(newChild), 1);

  assert.strictEqual(e.test_menu_modify_a(
    parent, 42, MF_CHECKED, 43, strA('Renamed')), 1);
  assert.strictEqual(e.test_menu_item_field(parent, 1, 1), 43,
    'MF_BYCOMMAND replacement publishes the new command id');
  assert.strictEqual(e.test_menu_item_field(parent, 1, 0) & MF_CHECKED, MF_CHECKED,
    'ModifyMenuA publishes the new checked state');
  assert.strictEqual(e.test_menu_modify_a(parent, 999, 0, 1, strA('Missing')), 0,
    'ModifyMenuA fails when the requested item does not exist');
  assert.strictEqual(e.test_menu_modify_a(0x1234, 0, 0, 1, strA('Bad menu')), 0,
    'ModifyMenuA fails for an unknown menu handle');

  assert.strictEqual(e.test_menu_modify_w(
    parent, 1, MF_BYPOSITION, 44, strW('Wide')), 1,
    'ModifyMenuW shares the item mutation path');
  assert.strictEqual(e.test_menu_item_id_api(parent, 1), 44);

  // Resource/attached menu bars keep encoded dropdown identities, but only
  // actual popup positions may produce one.
  const hwnd = 0x10001;
  const source = 0x00410134;
  const childHeader = 4 + 2 * 16;
  const blobSize = childHeader + 4 + 28;
  const blob = e.guest_alloc(blobSize) >>> 0;
  for (let offset = 0; offset < blobSize; offset += 4) {
    e.guest_write32(blob + offset, 0);
  }
  e.guest_write32(blob, 2);
  e.guest_write32(blob + 4 + 8, childHeader);
  e.guest_write32(blob + childHeader, 1);
  e.guest_write32(blob + childHeader + 4 + 20, 77);
  e.guest_write32(blob + 4 + 16 + 12, 88);
  e.test_wnd_table_set(hwnd, 0xffff0002);
  e.menu_set_source_guest(hwnd, blob, blobSize, source);
  assert.strictEqual(e.test_menu_get_submenu(source, 0) >>> 0, 0x00010134,
    'attached popup position receives the established dropdown handle');
  assert.strictEqual(e.test_menu_get_submenu(source, 1), 0,
    'attached command position does not fabricate a submenu');
  assert.strictEqual(e.test_menu_get_submenu(source, -1), 0);

  const before = frameInvalidations;
  assert.strictEqual(e.test_draw_menu_bar(0x7777), 0,
    'DrawMenuBar rejects an invalid HWND');
  assert.strictEqual(frameInvalidations, before,
    'an invalid HWND does not schedule non-client damage');
  assert.strictEqual(e.test_draw_menu_bar(hwnd), 1,
    'DrawMenuBar redraws a live window menu');
  assert(frameInvalidations > before,
    'DrawMenuBar publishes non-client damage to the renderer');
  assert.strictEqual(e.test_menu_item_count_api(0x1234), -1,
    'GetMenuItemCount reports invalid handles as failure');

  console.log('PASS  Win32 submenu lookup, menu replacement, and menu-bar redraw own real state');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
