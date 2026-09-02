#!/usr/bin/env node

'use strict';

// USER protects clipboard contents with an exclusive OpenClipboard /
// CloseClipboard transaction. EmptyClipboard changes ownership and notifies
// the previous owner synchronously before SetClipboardData can publish data.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const ROOT = path.join(__dirname, '..');
const CF_TEXT = 1;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_WINDOW_HANDLE = 1400;
const ERROR_CLIPBOARD_NOT_OPEN = 1418;

const u32 = value => [value, value >>> 8, value >>> 16, value >>> 24].map(v => v & 0xff);

const extraWat = String.raw`
  (func (export "test_make_window") (param $proc i32) (result i32)
    (local $hwnd i32)
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $hwnd) (local.get $proc))
    (local.get $hwnd))

  (func (export "test_open_clipboard") (param $hwnd i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_OpenClipboard
      (local.get $hwnd) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_close_clipboard") (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_CloseClipboard
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_empty_clipboard") (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_EmptyClipboard
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_set_clipboard_data")
      (param $format i32) (param $memory i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_SetClipboardData
      (local.get $format) (local.get $memory) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_get_clipboard_data") (param $format i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetClipboardData
      (local.get $format) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_get_clipboard_owner") (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetClipboardOwner
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_clipboard_format_available") (param $format i32) (result i32)
    (call $clipboard_is_format_available (local.get $format)))

  (func (export "test_last_error") (result i32) (global.get $last_error))
`;

(async () => {
  const harness = await bootRenderHarness({ extraWat, fonts: 'none' });
  const { exports: e, memory } = harness;

  const fixture = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE initializes synchronous owner notification');
  e.init_dx_com_thunks();

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const toWasm = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const notifications = e.guest_alloc(4) >>> 0;
  const proc = e.guest_alloc(64) >>> 0;

  // WndProc: increment the counter only for WM_DESTROYCLIPBOARD, return 0.
  bytes.set(Uint8Array.from([
    0x8b, 0x44, 0x24, 0x08,       // mov eax,[esp+8] (message)
    0x3d, 0x07, 0x03, 0x00, 0x00, // cmp eax,0x307
    0x75, 0x06,                   // jne done
    0xff, 0x05, ...u32(notifications), // inc dword [notifications]
    0x31, 0xc0,                   // done: xor eax,eax
    0xc2, 0x10, 0x00,             // ret 16
  ]), toWasm(proc));

  const first = e.test_make_window(proc) >>> 0;
  const second = e.test_make_window(proc) >>> 0;
  const text = e.guest_alloc(6) >>> 0;
  bytes.set(Buffer.from('hello\0', 'ascii'), toWasm(text));
  const notificationCount = () => view.getUint32(toWasm(notifications), true);
  const readText = guest => {
    let result = '';
    for (let at = toWasm(guest); bytes[at]; at++) result += String.fromCharCode(bytes[at]);
    return result;
  };

  assert.strictEqual(e.test_get_clipboard_data(CF_TEXT), 0,
    'GetClipboardData fails outside an open transaction');
  assert.strictEqual(e.test_last_error(), ERROR_CLIPBOARD_NOT_OPEN);
  assert.strictEqual(e.test_empty_clipboard(), 0,
    'EmptyClipboard fails while the clipboard is closed');
  assert.strictEqual(e.test_last_error(), ERROR_CLIPBOARD_NOT_OPEN);
  assert.strictEqual(e.test_set_clipboard_data(CF_TEXT, text), 0,
    'SetClipboardData fails while the clipboard is closed');
  assert.strictEqual(e.test_last_error(), ERROR_CLIPBOARD_NOT_OPEN);

  assert.strictEqual(e.test_open_clipboard(0xdeadbeef), 0,
    'OpenClipboard rejects a stale owner HWND');
  assert.strictEqual(e.test_last_error(), ERROR_INVALID_WINDOW_HANDLE);
  assert.strictEqual(e.test_open_clipboard(first), 1,
    'OpenClipboard accepts a live owner window');
  assert.strictEqual(e.test_open_clipboard(second), 0,
    'a second window cannot steal an open clipboard');
  assert.strictEqual(e.test_last_error(), ERROR_ACCESS_DENIED);
  assert.strictEqual(e.test_empty_clipboard(), 1,
    'the opener may empty the clipboard');
  assert.strictEqual(e.test_get_clipboard_owner() >>> 0, first,
    'EmptyClipboard transfers ownership to the opening HWND');
  assert.strictEqual(notificationCount(), 0,
    'the first owner transfer has no previous owner to notify');
  assert.strictEqual(e.test_set_clipboard_data(CF_TEXT, text) >>> 0, text,
    'the owner can publish CF_TEXT after emptying');
  const stored = e.test_get_clipboard_data(CF_TEXT) >>> 0;
  assert(stored && stored !== text, 'clipboard owns a copy of the caller data');
  assert.strictEqual(readText(stored), 'hello');
  assert.strictEqual(e.test_close_clipboard(), 1, 'CloseClipboard ends the transaction');
  assert.strictEqual(e.test_close_clipboard(), 0, 'closing twice fails');
  assert.strictEqual(e.test_last_error(), ERROR_CLIPBOARD_NOT_OPEN);
  assert.strictEqual(e.test_get_clipboard_owner() >>> 0, first,
    'closing does not relinquish clipboard ownership');
  assert.strictEqual(e.test_clipboard_format_available(CF_TEXT), 1,
    'closing leaves published clipboard data available');

  assert.strictEqual(e.test_open_clipboard(second), 1);
  assert.strictEqual(e.test_get_clipboard_data(CF_TEXT) >>> 0, stored,
    'a later opener may inspect the existing clipboard data');
  assert.strictEqual(e.test_empty_clipboard(), 1);
  assert.strictEqual(notificationCount(), 1,
    'EmptyClipboard synchronously notifies the previous owner');
  assert.strictEqual(e.test_get_clipboard_owner() >>> 0, second,
    'the second opener becomes owner after the notification');
  assert.strictEqual(e.test_clipboard_format_available(CF_TEXT), 0,
    'EmptyClipboard removes the previous formats');
  assert.strictEqual(e.test_close_clipboard(), 1);

  assert.strictEqual(e.test_open_clipboard(0), 1,
    'NULL associates an open clipboard with the task');
  assert.strictEqual(e.test_empty_clipboard(), 1,
    'a NULL-associated opener may still empty the clipboard');
  assert.strictEqual(notificationCount(), 2,
    'the prior window owner receives destruction before NULL ownership');
  assert.strictEqual(e.test_get_clipboard_owner(), 0,
    'EmptyClipboard after OpenClipboard(NULL) leaves no owner');
  assert.strictEqual(e.test_set_clipboard_data(CF_TEXT, text), 0,
    'a NULL-associated opener cannot publish clipboard data');
  assert.strictEqual(e.test_last_error(), ERROR_CLIPBOARD_NOT_OPEN);
  assert.strictEqual(e.test_close_clipboard(), 1);

  console.log('PASS  clipboard open lifecycle, ownership and WM_DESTROYCLIPBOARD semantics');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
