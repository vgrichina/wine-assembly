#!/usr/bin/env node

'use strict';

// InsertMenuItemA/W against a host-backed CreateMenu handle.
//
// tetravex.exe builds its entire menu bar this way: CreateMenu for the bar and
// for each popup, then repeated InsertMenuItemA(uItem = -1). CreateMenu handles
// live in the host tree (unlike CreatePopupMenu's WAT-side MNUD records), so the
// dynamic path declines them — and the handler used to answer TRUE and drop the
// item on the floor. SetMenu then had nothing to serialize and the window came
// up with no menu bar at all.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const MIIM_ID = 0x02;
const MIIM_SUBMENU = 0x04;
const MIIM_STRING = 0x40;

const extraWat = `
  (func (export "test_call_CreateMenu") (result i32)
    (call $handle_CreateMenu
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_call_InsertMenuItemW")
      (param $hmenu i32) (param $item i32) (param $bypos i32) (param $mii i32) (result i32)
    (call $handle_InsertMenuItemW
      (local.get $hmenu) (local.get $item) (local.get $bypos) (local.get $mii)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log(`  ok  ${label}`); };

(async () => {
  const harness = await bootRenderHarness({ extraWat });
  const wat = harness.exports;

  const alloc = size => wat.guest_alloc(size) >>> 0;
  const strA = text => {
    const p = alloc(text.length + 1);
    for (let i = 0; i < text.length; i++) wat.guest_write8(p + i, text.charCodeAt(i));
    wat.guest_write8(p + text.length, 0);
    return p;
  };
  const strW = text => {
    const p = alloc(text.length * 2 + 2);
    for (let i = 0; i < text.length; i++) {
      wat.guest_write8(p + i * 2, text.charCodeAt(i) & 0xff);
      wat.guest_write8(p + i * 2 + 1, text.charCodeAt(i) >>> 8);
    }
    wat.guest_write8(p + text.length * 2, 0);
    wat.guest_write8(p + text.length * 2 + 1, 0);
    return p;
  };
  // MENUITEMINFOA: cbSize, fMask, fType, fState, wID, hSubMenu, hbmpChecked,
  // hbmpUnchecked, dwItemData, dwTypeData, cch.
  const menuItemInfo = ({ mask = 0, id = 0, subMenu = 0, typeData = 0 }) => {
    const p = alloc(44);
    for (let i = 0; i < 44; i += 4) wat.guest_write32(p + i, 0);
    wat.guest_write32(p + 0, 44);
    wat.guest_write32(p + 4, mask);
    wat.guest_write32(p + 16, id);
    wat.guest_write32(p + 20, subMenu);
    wat.guest_write32(p + 36, typeData);
    return p;
  };
  const hostItems = h => harness.hostCtx._hostMenus.get(h >>> 0) || [];

  const bar = wat.test_call_CreateMenu() >>> 0;
  const game = wat.test_call_CreateMenu() >>> 0;
  assert(bar && game && bar !== game, 'CreateMenu returns distinct host handles');

  check('a tail InsertMenuItemA lands in the host submenu', () => {
    assert.strictEqual(wat.test_call_InsertMenuItemA(game, -1, 1,
      menuItemInfo({ mask: MIIM_ID | MIIM_STRING, id: 42, typeData: strA('&New Game') })), 1);
    assert.strictEqual(hostItems(game).length, 1);
    assert.strictEqual(hostItems(game)[0].id, 42);
    assert.strictEqual(hostItems(game)[0].text, '&New Game');
  });

  check('MIIM_SUBMENU attaches the popup to the bar', () => {
    assert.strictEqual(wat.test_call_InsertMenuItemA(bar, -1, 1,
      menuItemInfo({ mask: MIIM_SUBMENU | MIIM_STRING, subMenu: game,
                     typeData: strA('&Game') })), 1);
    assert.strictEqual(hostItems(bar).length, 1);
    assert.strictEqual(hostItems(bar)[0].text, '&Game');
    assert.strictEqual(hostItems(bar)[0].submenu, game, 'the host entry must be a popup');
    assert.strictEqual(hostItems(bar)[0].popup, true);
  });

  check('the W twin reads its label as UTF-16', () => {
    assert.strictEqual(wat.test_call_InsertMenuItemW(game, -1, 1,
      menuItemInfo({ mask: MIIM_ID | MIIM_STRING, id: 43, typeData: strW('E&xit') })), 1);
    assert.strictEqual(hostItems(game).length, 2);
    assert.strictEqual(hostItems(game)[1].text, 'E&xit');
  });

  check('a non-tail insert into a host menu still reports success', () => {
    // Mutating a host tree anywhere but the tail is not modelled; the historical
    // no-op result stays, exactly as InsertMenuA already behaves.
    assert.strictEqual(wat.test_call_InsertMenuItemA(bar, 0, 1,
      menuItemInfo({ mask: MIIM_ID | MIIM_STRING, id: 44, typeData: strA('&Help') })), 1);
    assert.strictEqual(hostItems(bar).length, 1, 'and it must not append instead');
  });

  console.log(`\ntest-insert-menu-item-host-bar: ${passed}/${passed} passed`);
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
