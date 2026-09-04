#!/usr/bin/env node

'use strict';

// USER mouse capture belongs to a thread queue, while browser input routing
// consumes the one process-visible owner. Exercise both views and the
// synchronous WM_CAPTURECHANGED contract through a real x86 wndproc.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const ROOT = path.join(__dirname, '..');
const COUNT = 0;
const HNDS = 4;
const MSGS = 68;
const LPARAMS = 132;
const RECORD_BYTES = 196;

const u32 = value => [value, value >>> 8, value >>> 16, value >>> 24]
  .map(byte => byte & 0xff);

function makeWndProc(observed) {
  const out = [];
  const emit = (...bytes) => out.push(...bytes.map(byte => byte & 0xff));
  const storeIndexedEax = address => emit(0x89, 0x04, 0x8d, ...u32(address));
  emit(0x8b, 0x0d, ...u32(observed + COUNT)); // mov ecx,[count]
  for (const [stackOffset, recordOffset] of [
    [4, HNDS], [8, MSGS], [16, LPARAMS],
  ]) {
    emit(0x8b, 0x44, 0x24, stackOffset); // mov eax,[esp+stackOffset]
    storeIndexedEax(observed + recordOffset);
  }
  emit(0x41); // inc ecx
  emit(0x89, 0x0d, ...u32(observed + COUNT)); // mov [count],ecx
  emit(0x31, 0xc0); // xor eax,eax
  emit(0xc2, 0x10, 0x00); // ret 16
  return Uint8Array.from(out);
}

const extraWat = String.raw`
  (func (export "test_make_capture_window")
      (param $proc i32) (param $tid i32) (result i32)
    (local $saved_tid i32) (local $hwnd i32)
    (local.set $saved_tid (global.get $current_thread_id))
    (global.set $current_thread_id (local.get $tid))
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $hwnd) (local.get $proc))
    (drop (call $wnd_set_style (local.get $hwnd) (i32.const 0x10000000)))
    (global.set $current_thread_id (local.get $saved_tid))
    (local.get $hwnd))

  (func (export "test_set_capture") (param $hwnd i32) (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_SetCapture
      (local.get $hwnd) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))

  (func (export "test_get_capture") (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_GetCapture
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))

  (func (export "test_release_capture") (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_ReleaseCapture
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))

  (func (export "test_set_thread") (param $tid i32)
    (global.set $current_thread_id (local.get $tid)))
  (func (export "test_capture_raw") (result i32)
    (global.get $capture_hwnd))
  (func (export "test_destroy") (param $hwnd i32)
    (call $wnd_destroy_recursive (local.get $hwnd)))
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      destroy_window() {},
      invalidate_frame() {},
    },
  });

  const fixture = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE initializes synchronous wndproc dispatch');
  e.init_dx_com_thunks();

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const toWasm = guest => (guest - imageBase + guestBase) >>> 0;
  const observed = e.guest_alloc(RECORD_BYTES) >>> 0;
  const proc = e.guest_alloc(128) >>> 0;
  new Uint8Array(memory.buffer).set(makeWndProc(observed), toWasm(proc));
  const view = new DataView(memory.buffer);
  const count = () => view.getUint32(toWasm(observed + COUNT), true);
  const records = () => Array.from({ length: count() }, (_, index) => ({
    hwnd: view.getUint32(toWasm(observed + HNDS + index * 4), true),
    msg: view.getUint32(toWasm(observed + MSGS + index * 4), true),
    lParam: view.getUint32(toWasm(observed + LPARAMS + index * 4), true),
  }));

  const first = e.test_make_capture_window(proc, 1) >>> 0;
  const second = e.test_make_capture_window(proc, 1) >>> 0;
  const foreign = e.test_make_capture_window(proc, 2) >>> 0;

  assert.strictEqual(e.test_set_capture(first), 0,
    'first capture has no previous owner');
  assert.strictEqual(e.test_get_capture() >>> 0, first);
  assert.strictEqual(e.test_capture_raw() >>> 0, first,
    'browser-visible capture follows SetCapture');

  assert.strictEqual(e.test_set_capture(first) >>> 0, first,
    'capturing the same HWND returns it without a transition');
  assert.strictEqual(count(), 0, 'same-owner capture sends no notification');

  assert.strictEqual(e.test_set_capture(second) >>> 0, first,
    'capture transfer returns the previous owner');
  assert.deepStrictEqual(records(), [
    { hwnd: first, msg: 0x0215, lParam: second },
  ], 'old owner synchronously receives WM_CAPTURECHANGED(new owner)');

  assert.strictEqual(e.test_set_capture(0x7fffffff), 0,
    'an invented HWND cannot capture the mouse');
  assert.strictEqual(e.test_set_capture(0), 0,
    'NULL is not a SetCapture target');
  assert.strictEqual(e.test_set_capture(foreign), 0,
    'a window owned by another thread cannot be the target');
  assert.strictEqual(e.test_capture_raw() >>> 0, second,
    'failed capture attempts preserve the live owner');
  assert.strictEqual(count(), 1, 'failed attempts send no notification');

  e.test_set_thread(2);
  assert.strictEqual(e.test_get_capture(), 0,
    'GetCapture hides another thread queue\'s owner');
  assert.strictEqual(e.test_release_capture(), 0,
    'another thread cannot release capture');
  assert.strictEqual(e.test_capture_raw() >>> 0, second);

  e.test_set_thread(1);
  assert.strictEqual(e.test_release_capture(), 1);
  assert.strictEqual(e.test_get_capture(), 0);
  assert.deepStrictEqual(records().slice(-1), [
    { hwnd: second, msg: 0x0215, lParam: 0 },
  ], 'ReleaseCapture notifies its old owner with a NULL replacement');
  assert.strictEqual(e.test_release_capture(), 0,
    'ReleaseCapture fails when this thread has no capture');

  e.test_set_thread(2);
  assert.strictEqual(e.test_set_capture(foreign), 0);
  assert.strictEqual(e.test_get_capture() >>> 0, foreign);
  e.test_set_thread(1);
  assert.strictEqual(e.test_get_capture(), 0);
  assert.strictEqual(e.test_capture_raw() >>> 0, foreign,
    'thread-local GetCapture does not erase a foreign live owner');
  e.test_set_thread(2);
  assert.strictEqual(e.test_release_capture(), 1);

  e.test_set_thread(1);
  assert.strictEqual(e.test_set_capture(first), 0);
  const beforeRendererRelease = count();
  e.release_capture();
  assert.strictEqual(e.test_capture_raw(), 0,
    'renderer release hook clears browser routing state');
  assert.strictEqual(count(), beforeRendererRelease + 1);
  assert.deepStrictEqual(records().slice(-1), [
    { hwnd: first, msg: 0x0215, lParam: 0 },
  ], 'renderer release hook uses the USER notification transition');

  assert.strictEqual(e.test_set_capture(first), 0);
  e.test_destroy(first);
  assert.strictEqual(e.test_capture_raw(), 0,
    'destroying the capture window clears browser routing state');
  assert.strictEqual(e.test_get_capture(), 0);

  console.log('PASS  mouse capture is thread-owned and sends WM_CAPTURECHANGED');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
