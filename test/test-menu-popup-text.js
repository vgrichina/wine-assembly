#!/usr/bin/env node

'use strict';

// A menu an app builds at runtime -- CreatePopupMenu + AppendMenu, then
// TrackPopupMenu -- has to show the labels it was given. Winamp's plug-in and
// playlist menus are built this way, so is WordPad's color popup.
//
// This used to test renderer._menuFormatText/_menuPaintDropdownJs, a JS menu
// painter deleted in cdb2426 when menu rendering moved into WAT; it had been
// asserting against a layer that no longer exists. The behaviour it guarded is
// real, so it is re-pointed at the WAT model the painter reads:
//
//   label / shortcut split on '\t'   (menu_child_label_*, menu_child_shortcut_*)
//   mnemonic from an un-doubled '&'  (menu_child_accel)
//
// The '&' itself stays in the label -- DrawText strips it and underlines the
// next character, the same way Win32 does.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const MF_STRING = 0x000;
const MF_SEPARATOR = 0x800;

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`  ok  ${label}`);
}

(async () => {
  const harness = await bootRenderHarness();
  const wat = harness.exports;
  const bytes = () => new Uint8Array(harness.memory.buffer);

  const strA = text => {
    const p = wat.guest_alloc(text.length + 1) >>> 0;
    for (let i = 0; i < text.length; i++) wat.guest_write8(p + i, text.charCodeAt(i));
    wat.guest_write8(p + text.length, 0);
    return p;
  };

  // The blob keeps offsets into itself, so the accessors hand back WASM
  // addresses and a length -- there is no NUL to stop at.
  const readAt = (ptr, len) => {
    if (!ptr || !len) return '';
    return Buffer.from(bytes().slice(ptr, ptr + len)).toString('latin1');
  };

  const hmenu = wat.test_call_CreatePopupMenu() >>> 0;
  assert(hmenu, 'CreatePopupMenu should return a handle');
  const items = [
    { id: 101, text: '&Enabled' },
    { id: 102, text: 'Spectrum &Radar' },
    { id: 103, text: 'E&&xit\tCtrl+X' },
    { id: 104, text: 'Close Plug-in\t[Escape]' },
  ];
  for (const it of items) {
    assert.strictEqual(wat.test_call_AppendMenuA(hmenu, MF_STRING, it.id, strA(it.text)), 1);
  }
  wat.test_call_AppendMenuA(hmenu, MF_SEPARATOR, 0, 0);

  // hwnd 0 is fine here: TrackPopupMenu parks the synthesized blob in a global
  // keyed by the owner hwnd, and every accessor below asks for that same one.
  assert.strictEqual(wat.menu_track_popup_open(hmenu, 0, 40, 40, 0), 1,
    'TrackPopupMenu should open a dynamic popup');

  const label = i => readAt(wat.menu_child_label_ptr(0, 0, i), wat.menu_child_label_len(0, 0, i));
  const shortcut = i =>
    readAt(wat.menu_child_shortcut_ptr(0, 0, i), wat.menu_child_shortcut_len(0, 0, i));

  check('every appended item is in the popup', () => {
    assert.strictEqual(wat.menu_child_count(0, 0), 5);
  });

  check('an item shows the string it was appended with', () => {
    assert.strictEqual(label(0), '&Enabled');
    assert.strictEqual(label(1), 'Spectrum &Radar');
  });

  check('the label stops at the tab and the shortcut carries the rest', () => {
    assert.strictEqual(label(2), 'E&&xit');
    assert.strictEqual(shortcut(2), 'Ctrl+X');
    assert.strictEqual(label(3), 'Close Plug-in');
    assert.strictEqual(shortcut(3), '[Escape]');
  });

  check('an item without a tab has no shortcut column', () => {
    assert.strictEqual(wat.menu_child_shortcut_len(0, 0, 0), 0);
    assert.strictEqual(wat.menu_child_shortcut_ptr(0, 0, 0), 0);
  });

  check('command ids survive the popup blob', () => {
    for (let i = 0; i < items.length; i++) {
      assert.strictEqual(wat.menu_child_id(0, 0, i), items[i].id);
    }
  });

  check('the separator is marked as one', () => {
    assert.strictEqual(wat.menu_child_flags(0, 0, 4) & 1, 1);
  });

  check('the mnemonic is the character after an un-doubled &', () => {
    assert.strictEqual(wat.menu_child_accel(0, 0, 0), 'E'.charCodeAt(0));
    assert.strictEqual(wat.menu_child_accel(0, 0, 1), 'R'.charCodeAt(0));
  });

  check('a doubled && is a literal ampersand, not a mnemonic', () => {
    // Stepping one byte at a time made the second '&' look like a fresh
    // marker, so "E&&xit" claimed 'X'.
    assert.strictEqual(wat.menu_child_accel(0, 0, 2), 0);
  });

  check('an item with no & has no mnemonic', () => {
    assert.strictEqual(wat.menu_child_accel(0, 0, 3), 0);
  });

  // GetMenuString reads the same blob, so it used to hand back "#0065" too.
  check('GetMenuString returns the label, not the command id', () => {
    // menu_handle_copy_label writes to a WASM address, not a guest one.
    const g2w = g => g - wat.get_image_base() + 0x12000;
    const buf = wat.guest_alloc(64) >>> 0;
    const n = wat.menu_handle_copy_label(hmenu, 1, 0x400, g2w(buf), 64);
    assert.strictEqual(readAt(g2w(buf), n), 'Spectrum &Radar');
  });

  console.log(`test-menu-popup-text: ${passed} checks ok`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
