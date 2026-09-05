#!/usr/bin/env node
'use strict';

// A BUTTON custom command can open a nested dialog from its parent DLGPROC.
// Delivering that command through the recursive synchronous sender strands the
// browser inside the outer click, so the nested dialog can never receive its
// own input. Custom dialog commands stay on the ordinary message pump, while
// IDOK/IDCANCEL can be wizard navigation and stay on that pump too. A true
// DialogBox gets its unhandled IDOK fallback when the queued command runs.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const ROOT = path.join(__dirname, '..');
const extraWat = String.raw`
  (func (export "test_create_dialog_button")
    (param $dlgproc i32) (param $id i32) (result i32)
    (local $dlg i32)
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $dlg) (global.get $WNDPROC_DIALOG))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x90000000)))
    (drop (call $dialog_proc_set (local.get $dlg) (local.get $dlgproc)))
    (call $ctrl_create_child
      (local.get $dlg) (i32.const 1) (local.get $id)
      (i32.const 0) (i32.const 0) (i32.const 100) (i32.const 24)
      (i32.const 0x50010000) (i32.const 0)))

  (func (export "test_button_click") (param $hwnd i32)
    (drop (call $button_wndproc
      (local.get $hwnd) (i32.const 0x0201) (i32.const 1) (i32.const 0)))
    (drop (call $button_wndproc
      (local.get $hwnd) (i32.const 0x0202) (i32.const 0) (i32.const 0))))

  (func (export "test_subclass_parent") (param $hwnd i32) (param $proc i32)
    (call $wnd_table_set (call $wnd_get_parent (local.get $hwnd)) (local.get $proc)))

  (func (export "test_make_owned_guest_parent")
    (param $hwnd i32) (param $proc i32)
    (local $parent i32) (local $owner i32)
    (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
    (local.set $owner (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $owner) (global.get $WNDPROC_BUILTIN))
    (call $wnd_set_owner (local.get $parent) (local.get $owner))
    (drop (call $dialog_proc_set (local.get $parent) (i32.const 0)))
    (call $wnd_table_set (local.get $parent) (local.get $proc)))

  (func (export "test_make_unowned_guest_parent")
    (param $hwnd i32) (param $proc i32)
    (local $parent i32)
    (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
    (drop (call $dialog_proc_set (local.get $parent) (i32.const 0)))
    (call $wnd_table_set (local.get $parent) (local.get $proc)))

  (func (export "test_set_button_id")
    (param $hwnd i32) (param $id i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_SetWindowLongA
      (local.get $hwnd) (i32.const -12) (local.get $id)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

function u32(value) {
  return [value, value >>> 8, value >>> 16, value >>> 24].map(v => v & 0xff);
}

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat });
  const fixture = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE initializes x86 callback support');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const toWasm = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const result = e.guest_alloc(12) >>> 0;
  const proc = e.guest_alloc(64) >>> 0;

  // DLGPROC: capture WM_COMMAND's msg/wParam/lParam and return TRUE.
  bytes.set(Uint8Array.from([
    0x81, 0x7c, 0x24, 0x08, 0x11, 0x01, 0x00, 0x00,
    0x75, 0x1b,
    0x8b, 0x44, 0x24, 0x08, 0xa3, ...u32(result),
    0x8b, 0x44, 0x24, 0x0c, 0xa3, ...u32(result + 4),
    0x8b, 0x44, 0x24, 0x10, 0xa3, ...u32(result + 8),
    0xb8, 0x01, 0x00, 0x00, 0x00,
    0xc2, 0x10, 0x00,
  ]), toWasm(proc));

  const captured = () => [
    view.getUint32(toWasm(result), true),
    view.getUint32(toWasm(result + 4), true),
    view.getUint32(toWasm(result + 8), true),
  ];

  const custom = e.test_create_dialog_button(proc, 1016) >>> 0;
  const customParent = e.wnd_get_parent(custom) >>> 0;
  e.test_subclass_parent(custom, proc);
  e.test_button_click(custom);
  assert.deepStrictEqual(captured(), [0, 0, 0],
    'subclassed dialog custom command does not enter a recursive x86 frame');
  assert.strictEqual(e.get_post_queue_count(), 1,
    'custom dialog command is queued for DispatchMessage');
  assert.deepStrictEqual([
    view.getUint32(0x400, true),
    view.getUint32(0x404, true),
    view.getUint32(0x408, true),
    view.getUint32(0x40c, true),
  ], [customParent, 0x0111, 1016, custom],
  'queued message retains the parent, command id, and BUTTON hwnd');

  // Clear the synthetic queue before checking the standard command path.
  e.set_post_queue_count(0);
  const ok = e.test_create_dialog_button(proc, 1) >>> 0;
  const okParent = e.wnd_get_parent(ok) >>> 0;
  e.test_button_click(ok);
  assert.strictEqual(e.get_post_queue_count(), 1,
    'modeless IDOK stays on the main pump for wizard navigation');
  assert.deepStrictEqual([
    view.getUint32(0x400, true),
    view.getUint32(0x404, true),
    view.getUint32(0x408, true),
    view.getUint32(0x40c, true),
  ], [okParent, 0x0111, 1, ok],
  'queued modeless IDOK retains the parent and button HWND');

  e.set_post_queue_count(0);
  const nativeOk = e.test_create_dialog_button(proc, 1) >>> 0;
  const nativeOkParent = e.wnd_get_parent(nativeOk) >>> 0;
  e.test_make_unowned_guest_parent(nativeOk, proc);
  e.test_button_click(nativeOk);
  assert.strictEqual(e.get_post_queue_count(), 1,
    'native installer IDOK stays on the main pump for nested license pages');
  assert.deepStrictEqual([
    view.getUint32(0x400, true),
    view.getUint32(0x404, true),
    view.getUint32(0x408, true),
    view.getUint32(0x40c, true),
  ], [nativeOkParent, 0x0111, 1, nativeOk],
  'queued native installer IDOK retains the parent and button HWND');

  e.set_post_queue_count(0);
  const owned = e.test_create_dialog_button(proc, 0) >>> 0;
  const ownedParent = e.wnd_get_parent(owned) >>> 0;
  assert.strictEqual(e.test_set_button_id(owned, 0x1009), 0,
    'VCL-style GWL_ID assignment returns the creation-time zero ID');
  e.test_make_owned_guest_parent(owned, proc);
  e.test_button_click(owned);
  assert.strictEqual(e.get_post_queue_count(), 1,
    'an owned guest form queues its custom BUTTON command');
  assert.deepStrictEqual([
    view.getUint32(0x400, true),
    view.getUint32(0x404, true),
    view.getUint32(0x408, true),
    view.getUint32(0x40c, true),
  ], [owned, 0xBD11, 0x1009, owned],
  'owned guest form receives reflected CN_COMMAND on the main message pump');

  e.set_post_queue_count(0);
  const nested = e.test_create_dialog_button(proc, 0) >>> 0;
  const nestedId = nested & 0xffff;
  assert.strictEqual(e.test_set_button_id(nested, nestedId), 0,
    'VCL-style child uses its HWND as its runtime control ID');
  e.test_make_unowned_guest_parent(nested, proc);
  e.test_button_click(nested);
  assert.strictEqual(e.get_post_queue_count(), 1,
    'self-ID button under an unowned guest panel queues its reflection');
  assert.deepStrictEqual([
    view.getUint32(0x400, true),
    view.getUint32(0x404, true),
    view.getUint32(0x408, true),
    view.getUint32(0x40c, true),
  ], [nested, 0xBD11, nestedId, nested],
  'nested VCL panel receives reflected CN_COMMAND on the main message pump');

  console.log('PASS  custom modal-form BUTTON commands stay on the main message pump');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
