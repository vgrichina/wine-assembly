#!/usr/bin/env node

'use strict';

// InsertMenu / InsertMenuItem against the WAT dynamic-menu (MNUD) state.
//
// AppendMenu only ever grows the tail, so nothing previously exercised item
// *order*. Insertion is the whole point of these two entry points: winamp.exe
// builds its playlist menu by inserting at a position rather than appending.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const MF_BYPOSITION = 0x400;
const MF_STRING = 0x000;
const MF_SEPARATOR = 0x800;
const MF_POPUP = 0x010;
const MF_CHECKED = 0x008;

const MIIM_STATE = 0x01;
const MIIM_ID = 0x02;
const MIIM_SUBMENU = 0x04;
const MIIM_DATA = 0x20;
const MIIM_STRING = 0x40;
const MIIM_FTYPE = 0x100;

const MFT_SEPARATOR = 0x800;
const MFS_CHECKED = 0x008;

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`  ok  ${label}`);
}

(async () => {
  const harness = await bootRenderHarness();
  const wat = harness.exports;

  const allocated = [];
  const alloc = size => {
    const p = wat.guest_alloc(size) >>> 0;
    allocated.push(p);
    return p;
  };
  const strA = text => {
    const p = alloc(text.length + 1);
    for (let i = 0; i < text.length; i++) wat.guest_write8(p + i, text.charCodeAt(i));
    wat.guest_write8(p + text.length, 0);
    return p;
  };
  // MENUITEMINFOA as Win98 defines it: cbSize, fMask, fType, fState, wID,
  // hSubMenu, hbmpChecked, hbmpUnchecked, dwItemData, dwTypeData, cch.
  const menuItemInfo = ({ mask = 0, type = 0, state = 0, id = 0, subMenu = 0,
                          itemData = 0, typeData = 0 }) => {
    const p = alloc(44);
    for (let i = 0; i < 44; i += 4) wat.guest_write32(p + i, 0);
    wat.guest_write32(p + 0, 44);
    wat.guest_write32(p + 4, mask);
    wat.guest_write32(p + 8, type);
    wat.guest_write32(p + 12, state);
    wat.guest_write32(p + 16, id);
    wat.guest_write32(p + 20, subMenu);
    wat.guest_write32(p + 32, itemData);
    wat.guest_write32(p + 36, typeData);
    return p;
  };
  const ids = hmenu => {
    const out = [];
    for (let i = 0; i < wat.test_menu_item_count(hmenu); i++) {
      out.push(wat.test_menu_item_field(hmenu, i, 1));
    }
    return out;
  };

  const popup = () => {
    const h = wat.test_call_CreatePopupMenu() >>> 0;
    assert(h, 'CreatePopupMenu should return a handle');
    assert.strictEqual(wat.test_menu_item_count(h), 0);
    return h;
  };

  check('InsertMenuA appends when the position is past the end', () => {
    const h = popup();
    assert.strictEqual(wat.test_call_InsertMenuA(h, 0, MF_BYPOSITION | MF_STRING, 101, strA('One')), 1);
    assert.strictEqual(wat.test_call_InsertMenuA(h, 99, MF_BYPOSITION | MF_STRING, 102, strA('Two')), 1);
    assert.deepStrictEqual(ids(h), [101, 102]);
    wat.test_call_DestroyMenu(h);
  });

  check('InsertMenuA inserts before the given position', () => {
    const h = popup();
    wat.test_call_AppendMenuA(h, MF_STRING, 1, strA('A'));
    wat.test_call_AppendMenuA(h, MF_STRING, 3, strA('C'));
    assert.strictEqual(wat.test_call_InsertMenuA(h, 1, MF_BYPOSITION | MF_STRING, 2, strA('B')), 1);
    assert.deepStrictEqual(ids(h), [1, 2, 3]);
    wat.test_call_DestroyMenu(h);
  });

  check('inserting at 0 shifts every existing item down', () => {
    const h = popup();
    wat.test_call_AppendMenuA(h, MF_STRING, 10, strA('X'));
    wat.test_call_AppendMenuA(h, MF_STRING, 20, strA('Y'));
    wat.test_call_AppendMenuA(h, MF_STRING, 30, strA('Z'));
    wat.test_call_InsertMenuA(h, 0, MF_BYPOSITION | MF_STRING, 5, strA('W'));
    assert.deepStrictEqual(ids(h), [5, 10, 20, 30]);
    wat.test_call_DestroyMenu(h);
  });

  check('without MF_BYPOSITION the position names an item id', () => {
    const h = popup();
    wat.test_call_AppendMenuA(h, MF_STRING, 100, strA('A'));
    wat.test_call_AppendMenuA(h, MF_STRING, 300, strA('C'));
    wat.test_call_InsertMenuA(h, 300, MF_STRING, 200, strA('B'));
    assert.deepStrictEqual(ids(h), [100, 200, 300]);
    wat.test_call_DestroyMenu(h);
  });

  check('the inserted item keeps its flags and label pointer', () => {
    const h = popup();
    const label = strA('Checked');
    wat.test_call_AppendMenuA(h, MF_STRING, 1, strA('First'));
    wat.test_call_InsertMenuA(h, 0, MF_BYPOSITION | MF_CHECKED, 2, label);
    assert.strictEqual(wat.test_menu_item_field(h, 0, 1), 2);
    assert.strictEqual(wat.test_menu_item_field(h, 0, 2) >>> 0, label);
    assert(wat.test_menu_item_field(h, 0, 0) & MF_CHECKED, 'MF_CHECKED should survive');
    wat.test_call_DestroyMenu(h);
  });

  check('InsertMenuItemA places a string item by position', () => {
    const h = popup();
    const label = strA('Playlist');
    wat.test_call_AppendMenuA(h, MF_STRING, 1, strA('First'));
    wat.test_call_AppendMenuA(h, MF_STRING, 3, strA('Third'));
    assert.strictEqual(
      wat.test_call_InsertMenuItemA(h, 1, 1,
        menuItemInfo({ mask: MIIM_ID | MIIM_STRING, id: 2, typeData: label })), 1);
    assert.deepStrictEqual(ids(h), [1, 2, 3]);
    assert.strictEqual(wat.test_menu_item_field(h, 1, 2) >>> 0, label);
    wat.test_call_DestroyMenu(h);
  });

  check('InsertMenuItemA with fByPosition=0 inserts before the matching id', () => {
    const h = popup();
    wat.test_call_AppendMenuA(h, MF_STRING, 10, strA('A'));
    wat.test_call_AppendMenuA(h, MF_STRING, 30, strA('C'));
    wat.test_call_InsertMenuItemA(h, 30, 0,
      menuItemInfo({ mask: MIIM_ID | MIIM_STRING, id: 20, typeData: strA('B') }));
    assert.deepStrictEqual(ids(h), [10, 20, 30]);
    wat.test_call_DestroyMenu(h);
  });

  check('MFT_SEPARATOR and MFS_CHECKED carry into the item flags', () => {
    const h = popup();
    wat.test_call_InsertMenuItemA(h, 0, 1,
      menuItemInfo({ mask: MIIM_FTYPE, type: MFT_SEPARATOR }));
    assert(wat.test_menu_item_field(h, 0, 0) & MF_SEPARATOR, 'separator flag expected');
    wat.test_call_InsertMenuItemA(h, 1, 1,
      menuItemInfo({ mask: MIIM_ID | MIIM_STATE | MIIM_STRING, id: 7,
                     state: MFS_CHECKED, typeData: strA('On') }));
    assert(wat.test_menu_item_field(h, 1, 0) & MF_CHECKED, 'checked state expected');
    wat.test_call_DestroyMenu(h);
  });

  check('a separator does not take dwTypeData as a label', () => {
    const h = popup();
    wat.test_call_InsertMenuItemA(h, 0, 1,
      menuItemInfo({ mask: MIIM_FTYPE | MIIM_STRING, type: MFT_SEPARATOR,
                     typeData: strA('ignored') }));
    assert.strictEqual(wat.test_menu_item_field(h, 0, 2), 0);
    wat.test_call_DestroyMenu(h);
  });

  check('MIIM_SUBMENU marks the item as a popup and stores the submenu', () => {
    const h = popup();
    const sub = popup();
    wat.test_call_InsertMenuItemA(h, 0, 1,
      menuItemInfo({ mask: MIIM_ID | MIIM_SUBMENU | MIIM_STRING, id: 9,
                     subMenu: sub, typeData: strA('More') }));
    assert(wat.test_menu_item_field(h, 0, 0) & MF_POPUP, 'MF_POPUP expected');
    // Field 2 stays the label; the submenu handle lives in field 3, because a
    // popup item carries both and one slot cannot hold them.
    assert.strictEqual(wat.test_menu_item_field(h, 0, 3) >>> 0, sub);
    assert(wat.test_menu_item_field(h, 0, 2) >>> 0, 'the label pointer should survive');
    wat.test_call_DestroyMenu(sub);
    wat.test_call_DestroyMenu(h);
  });

  check('MIIM_DATA carries an owner-draw payload', () => {
    const h = popup();
    wat.test_call_InsertMenuItemA(h, 0, 1,
      menuItemInfo({ mask: MIIM_ID | MIIM_DATA, id: 4, itemData: 0xDEADBEEF }));
    assert.strictEqual(wat.test_menu_item_field(h, 0, 2) >>> 0, 0xDEADBEEF);
    wat.test_call_DestroyMenu(h);
  });

  check('a resource-backed handle reports success without a dynamic table', () => {
    // winamp.exe passes a GetSubMenu-encoded handle like this one. Mutating a
    // resource menu blob is not modelled, and these entry points report
    // success for it exactly as InsertMenuA/ModifyMenuA already did.
    const resourceHandle = 0x00030065;
    assert.strictEqual(wat.test_menu_item_count(resourceHandle), -1);
    assert.strictEqual(
      wat.test_call_InsertMenuItemA(resourceHandle, 4, 1,
        menuItemInfo({ mask: MIIM_ID | MIIM_STRING, id: 1, typeData: strA('Item') })), 1);
    assert.strictEqual(
      wat.test_call_InsertMenuA(resourceHandle, 0, MF_BYPOSITION, 1, strA('Item')), 1);
  });

  check('a full menu reports failure instead of overrunning its capacity', () => {
    const h = popup();
    let inserted = 0;
    for (let i = 0; i < 80; i++) {
      if (wat.test_call_InsertMenuA(h, 0, MF_BYPOSITION | MF_STRING, i + 1, strA(`I${i}`)) !== 1) break;
      inserted++;
    }
    assert.strictEqual(inserted, 64, 'the MNUD table holds 64 items');
    assert.strictEqual(wat.test_menu_item_count(h), 64);
    wat.test_call_DestroyMenu(h);
  });

  for (const p of allocated) wat.guest_free(p);

  console.log(`\ntest-menu-insert: ${passed}/${passed} passed`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
