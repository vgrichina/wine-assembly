#!/usr/bin/env node

'use strict';

// A DLGTEMPLATE may name an application-registered window class. USER creates
// the dialog from that class, so its brush/cursor/class metadata must be
// inherited just as if the app had called CreateWindowExA itself. Half-Life's
// launcher depends on the HalfLifeLauncher class's BLACK_BRUSH background;
// dropping the class field leaves the owner-drawn menu blinking over grey.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_register_class") (param $wc i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_RegisterClassA
      (local.get $wc) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_load_dialog")
    (param $hwnd i32) (param $template i32) (result i32)
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_DIALOG))
    (global.set $dlg_indirect_template_ptr (local.get $template))
    (call $dlg_load (local.get $hwnd) (i32.const 0)))

  (func (export "test_dialog_brush") (param $hwnd i32) (result i32)
    (call $wnd_get_bg_brush (local.get $hwnd)))

  (func (export "test_dialog_cursor") (param $hwnd i32) (result i32)
    (call $wnd_get_class_cursor (local.get $hwnd)))

  (func (export "test_dialog_class_slot") (param $hwnd i32) (result i32)
    (call $wnd_get_class_slot (local.get $hwnd)))

  (func (export "test_dialog_is_class_dialog") (param $hwnd i32) (result i32)
    (call $wnd_class_is_dialog (local.get $hwnd)))

  (func (export "test_dialog_own_dc") (param $hwnd i32) (result i32)
    (call $wnd_get_own_dc (local.get $hwnd)))

  (func (export "test_find_child") (param $parent i32) (param $id i32) (result i32)
    (call $ctrl_find_by_id (local.get $parent) (local.get $id)))

  (func (export "test_get_window_dc") (param $hwnd i32) (result i32)
    (call $host_alloc_window_dc (local.get $hwnd) (i32.const 0)))

  (func (export "test_above_sibling") (param $hwnd i32) (param $sibling i32) (result i32)
    (call $wnd_z_is_above_sibling (local.get $hwnd) (local.get $sibling)))

  (func (export "test_move_window") (param $hwnd i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (i32.const 1))
    (call $handle_MoveWindow
      (local.get $hwnd) (i32.const 0) (i32.const 0)
      (i32.const 160) (i32.const 100) (i32.const 0))
    (global.set $esp (local.get $saved_esp)))

  (func (export "test_set_window_pos") (param $hwnd i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (i32.const 100))
    (call $gs32 (i32.add (global.get $esp) (i32.const 28)) (i32.const 0))
    (call $handle_SetWindowPos
      (local.get $hwnd) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 160) (i32.const 0))
    (global.set $esp (local.get $saved_esp)))
`;

(async () => {
  const erases = [];
  const { exports: e, memory } = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      erase_trace: (hwnd, brush) => erases.push([hwnd >>> 0, brush >>> 0]),
    },
  });
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const base = e.get_guest_base() >>> 0;

  const guestAnsi = (text) => {
    const ptr = e.guest_alloc(text.length + 1) >>> 0;
    for (let i = 0; i < text.length; i++) bytes[base + ptr + i] = text.charCodeAt(i);
    bytes[base + ptr + text.length] = 0;
    return ptr;
  };

  const className = guestAnsi('HalfLifeLauncher');
  const wc = e.guest_alloc(40) >>> 0;
  bytes.fill(0, base + wc, base + wc + 40);
  view.setUint32(base + wc + 0, 0x20, true);          // CS_OWNDC
  view.setUint32(base + wc + 4, 0xFFFF0001, true);   // harmless WAT-native wndproc
  view.setUint32(base + wc + 12, 30, true);          // DLGWINDOWEXTRA
  view.setUint32(base + wc + 24, 0x12345678, true);  // hCursor
  view.setUint32(base + wc + 28, 6, true);           // BLACK_BRUSH
  view.setUint32(base + wc + 36, className, true);
  assert.ok(e.test_register_class(wc) >>> 0, 'RegisterClassA returns an atom');

  // Classic DLGTEMPLATE with no controls:
  // style, exStyle, cdit/x/y/cx/cy, no menu, named UTF-16 class, empty title.
  const template = e.guest_alloc(96) >>> 0;
  const wa = base + template;
  bytes.fill(0, wa, wa + 96);
  view.setUint32(wa + 0, 0x80000000, true); // WS_POPUP
  view.setUint16(wa + 14, 160, true);       // cx
  view.setUint16(wa + 16, 100, true);       // cy
  let p = wa + 20;                          // +18 menu WORD 0
  for (const ch of 'HalfLifeLauncher') {
    view.setUint16(p, ch.charCodeAt(0), true);
    p += 2;
  }
  view.setUint16(p, 0, true);               // class terminator
  view.setUint16(p + 2, 0, true);           // empty title

  const hwnd = 0x10020;
  assert.strictEqual(e.test_load_dialog(hwnd, template), 0,
    'zero-control custom dialog parses successfully');
  assert.strictEqual(e.test_dialog_brush(hwnd), 6,
    'dialog inherits the registered BLACK_BRUSH');
  assert.strictEqual(e.test_dialog_cursor(hwnd) >>> 0, 0x12345678,
    'dialog inherits the registered class cursor');
  assert.ok(e.test_dialog_class_slot(hwnd) >= 0,
    'dialog retains its registered class slot');
  assert.strictEqual(e.test_dialog_is_class_dialog(hwnd), 1,
    'DLGWINDOWEXTRA metadata is visible on the dialog');
  assert.strictEqual(e.test_dialog_own_dc(hwnd), -1,
    'dialog inherits CS_OWNDC before its first GetDC');

  // The same class may name a control inside a DLGTEMPLATE. That path used
  // to retain only its wndproc: the class brush/cursor/slot/CS_OWNDC were all
  // dropped, which made CD Player's LED black-on-black and left stale title
  // text behind. Build one classic DLGITEMTEMPLATE using the registered name.
  const childTemplate = e.guest_alloc(160) >>> 0;
  const childWa = base + childTemplate;
  bytes.fill(0, childWa, childWa + 160);
  view.setUint32(childWa + 0, 0x80000000, true); // WS_POPUP dialog
  view.setUint16(childWa + 8, 2, true);          // cdit
  view.setUint16(childWa + 14, 160, true);
  view.setUint16(childWa + 16, 100, true);
  // Empty menu/class/title consume six bytes, naturally aligning the item at +24.
  p = childWa + 24;
  view.setUint32(p + 0, 0x50000000, true);       // WS_CHILD | WS_VISIBLE
  view.setUint16(p + 8, 4, true);
  view.setUint16(p + 10, 4, true);
  view.setUint16(p + 12, 80, true);
  view.setUint16(p + 14, 20, true);
  view.setUint16(p + 16, 77, true);
  p += 18;
  for (const ch of 'HalfLifeLauncher') {
    view.setUint16(p, ch.charCodeAt(0), true);
    p += 2;
  }
  view.setUint16(p, 0, true); p += 2;            // class terminator
  view.setUint16(p, 0, true); p += 2;            // empty title
  view.setUint16(p, 0, true); p += 2;            // no creation data
  // A later overlapping Static is lower in the dialog's front-to-back item
  // order. This is the relationship CD Player uses for Play over its LED.
  view.setUint32(p + 0, 0x50000000, true);
  view.setUint16(p + 8, 40, true);
  view.setUint16(p + 10, 4, true);
  view.setUint16(p + 12, 80, true);
  view.setUint16(p + 14, 20, true);
  view.setUint16(p + 16, 78, true);
  p += 18;
  view.setUint16(p, 0xFFFF, true); p += 2;
  view.setUint16(p, 0x0082, true); p += 2;        // Static ordinal
  view.setUint16(p, 0, true); p += 2;            // empty title
  view.setUint16(p, 0, true);                     // no creation data

  const childParent = 0x10040;
  assert.strictEqual(e.test_load_dialog(childParent, childTemplate), 2,
    'two-control custom dialog parses successfully');
  const child = e.test_find_child(childParent, 77) >>> 0;
  const lowerSibling = e.test_find_child(childParent, 78) >>> 0;
  assert.ok(child, 'custom dialog child is registered by its control id');
  assert.ok(lowerSibling, 'later dialog child is registered by its control id');
  assert.strictEqual(e.test_above_sibling(lowerSibling, child), 1,
    'earlier dialog resource item remains above later overlapping siblings');
  assert.strictEqual(e.test_dialog_brush(child), 6,
    'custom dialog child inherits the registered BLACK_BRUSH');
  assert.strictEqual(e.test_dialog_cursor(child) >>> 0, 0x12345678,
    'custom dialog child inherits the registered class cursor');
  assert.ok(e.test_dialog_class_slot(child) >= 0,
    'custom dialog child retains its registered class slot');
  assert.strictEqual(e.test_dialog_own_dc(child), -1,
    'custom dialog child inherits CS_OWNDC before WM_CREATE');
  const childDc = e.test_get_window_dc(child);
  assert.ok(childDc > 0,
    'a live pre-host dialog child can acquire its WM_CREATE device context');
  assert.strictEqual(e.test_dialog_own_dc(child), childDc,
    'the early device context is retained as the class private DC');
  assert.strictEqual(e.test_get_window_dc(child), childDc,
    'later GetDC calls reuse the same CS_OWNDC state');

  // Resize helpers may seed COLOR_BTNFACE for the ordinary #32770 dialog
  // class, but must not synchronously cover an application-owned custom
  // dialog after its DlgProc has painted it.
  e.test_move_window(hwnd);
  e.test_set_window_pos(hwnd);
  assert.deepStrictEqual(erases, [],
    'resize helpers do not overwrite a custom-class dialog with BTNFACE');

  const defaultTemplate = e.guest_alloc(32) >>> 0;
  const defaultWa = base + defaultTemplate;
  bytes.fill(0, defaultWa, defaultWa + 32);
  view.setUint32(defaultWa + 0, 0x80000000, true);
  view.setUint16(defaultWa + 14, 160, true);
  view.setUint16(defaultWa + 16, 100, true);
  // menu, class, and title are the three zero WORDs at +18/+20/+22.
  const defaultHwnd = hwnd + 1;
  e.test_load_dialog(defaultHwnd, defaultTemplate);
  e.test_move_window(defaultHwnd);
  e.test_set_window_pos(defaultHwnd);
  assert.deepStrictEqual(erases, [
    [defaultHwnd, 16],
    [defaultHwnd, 16],
  ], 'ordinary dialogs retain the compatibility BTNFACE resize seed');

  console.log('PASS  custom DLGTEMPLATE class state is inherited');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
