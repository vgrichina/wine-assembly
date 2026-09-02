#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const apiTable = require('../src/api_table.json');
const { bootRenderHarness } = require('./render-helper');

const ROOT = path.join(__dirname, '..');
const COUNT = 0;
const HNDS = 4;
const MSGS = 68;
const WPARAMS = 132;
const LPARAMS = 196;
const RECORD_BYTES = 260;

const u32 = value => [value, value >>> 8, value >>> 16, value >>> 24]
  .map(byte => byte & 0xff);

function makeWndProc(observed) {
  const out = [];
  const emit = (...bytes) => out.push(...bytes.map(byte => byte & 0xff));
  const storeIndexedEax = address => emit(0x89, 0x04, 0x8d, ...u32(address));
  emit(0x8b, 0x0d, ...u32(observed + COUNT)); // mov ecx,[count]
  for (const [stackOffset, recordOffset] of [
    [4, HNDS], [8, MSGS], [12, WPARAMS], [16, LPARAMS],
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
  (func (export "test_make_window")
      (param $proc i32) (param $style i32) (param $parent i32)
      (param $tid i32) (result i32)
    (local $hwnd i32) (local $saved_tid i32)
    (local.set $saved_tid (global.get $current_thread_id))
    (global.set $current_thread_id (local.get $tid))
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $hwnd) (local.get $proc))
    (drop (call $wnd_set_style (local.get $hwnd) (local.get $style)))
    (call $wnd_set_parent (local.get $hwnd) (local.get $parent))
    (global.set $current_thread_id (local.get $saved_tid))
    (local.get $hwnd))

  (func (export "test_set_active") (param $hwnd i32) (param $stack i32) (result i64)
    (global.set $esp (local.get $stack))
    (call $handle_SetActiveWindow
      (local.get $hwnd) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))

  (func (export "test_get_active") (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetActiveWindow
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_set_foreground") (param $hwnd i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_SetForegroundWindow
      (local.get $hwnd) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_bring") (param $hwnd i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_BringWindowToTop
      (local.get $hwnd) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_focus") (result i32) (global.get $focus_hwnd))
  (func (export "test_destroy") (param $hwnd i32)
    (call $wnd_destroy_recursive (local.get $hwnd)))
`;

(async () => {
  assert.strictEqual(apiTable.find(api => api.name === 'SetActiveWindow').nargs, 1);
  assert.strictEqual(apiTable.find(api => api.name === 'GetActiveWindow').nargs, 0);

  const hostCalls = [];
  const harness = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      activate_window(hwnd) {
        hostCalls.push(['activate', hwnd >>> 0]);
        return hwnd ? 1 : 0;
      },
      set_window_zorder(hwnd, after) {
        hostCalls.push(['zorder', hwnd >>> 0, after | 0]);
      },
      invalidate_frame() {},
      destroy_window() {},
    },
  });
  const { exports: e, memory } = harness;
  const fixture = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE initializes synchronous wndproc dispatch');
  e.init_dx_com_thunks();

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const toWasm = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const observed = e.guest_alloc(RECORD_BYTES) >>> 0;
  const proc = e.guest_alloc(128) >>> 0;
  bytes.set(makeWndProc(observed), toWasm(proc));

  const WS_VISIBLE = 0x10000000;
  const WS_CHILD = 0x40000000;
  const first = e.test_make_window(proc, WS_VISIBLE, 0, 1) >>> 0;
  const second = e.test_make_window(proc, WS_VISIBLE, 0, 1) >>> 0;
  const child = e.test_make_window(proc, WS_VISIBLE | WS_CHILD, first, 1) >>> 0;
  const foreign = e.test_make_window(proc, WS_VISIBLE, 0, 2) >>> 0;
  const stack = 0x074ff000;
  const count = () => view.getUint32(toWasm(observed + COUNT), true);
  const records = () => Array.from({ length: count() }, (_, index) => ({
    hwnd: view.getUint32(toWasm(observed + HNDS + index * 4), true),
    msg: view.getUint32(toWasm(observed + MSGS + index * 4), true),
    wParam: view.getUint32(toWasm(observed + WPARAMS + index * 4), true),
    lParam: view.getUint32(toWasm(observed + LPARAMS + index * 4), true),
  }));
  const result = value => Number(value & 0xffffffffn) >>> 0;
  const finalEsp = value => Number(value >> 32n) >>> 0;

  assert.strictEqual(e.test_get_active(), 0,
    'a thread queue starts without an active window');
  let packed = e.test_set_active(first, stack);
  assert.strictEqual(result(packed), 0,
    'first successful SetActiveWindow returns the previous NULL active window');
  assert.strictEqual(finalEsp(packed), stack + 8, 'SetActiveWindow cleans stdcall');
  assert.strictEqual(e.test_get_active() >>> 0, first);
  assert.strictEqual(e.test_focus() >>> 0, first,
    'default WM_ACTIVATE behavior assigns focus to the active top-level');
  assert.deepStrictEqual(records(), [
    { hwnd: first, msg: 0x0006, wParam: 1, lParam: 0 },
    { hwnd: first, msg: 0x0007, wParam: 0, lParam: 0 },
  ], 'first activation synchronously sends WM_ACTIVATE then WM_SETFOCUS');

  packed = e.test_set_active(second, stack);
  assert.strictEqual(result(packed), first,
    'SetActiveWindow returns the previously active top-level');
  assert.strictEqual(e.test_get_active() >>> 0, second);
  assert.strictEqual(e.test_focus() >>> 0, second);
  assert.deepStrictEqual(records().slice(2), [
    { hwnd: first, msg: 0x0006, wParam: 0, lParam: second },
    { hwnd: second, msg: 0x0006, wParam: 1, lParam: first },
    { hwnd: first, msg: 0x0008, wParam: second, lParam: 0 },
    { hwnd: second, msg: 0x0007, wParam: first, lParam: 0 },
  ], 'switch sends deactivation/activation before the focus pair');

  packed = e.test_set_active(child, stack);
  assert.strictEqual(result(packed), 0, 'SetActiveWindow rejects child HWNDs');
  assert.strictEqual(e.test_get_active() >>> 0, second,
    'failed child activation preserves active state');

  packed = e.test_set_active(foreign, stack);
  assert.strictEqual(result(packed), second,
    'a foreign-thread HWND returns this queue\'s previous active window');
  assert.strictEqual(e.test_get_active(), 0,
    'a foreign-thread HWND clears rather than steals this queue\'s active state');
  assert.strictEqual(e.test_focus(), 0,
    'clearing the active window releases focus from its old window tree');
  assert.deepStrictEqual(hostCalls, [
    ['activate', first], ['activate', second],
  ], 'only same-thread SetActiveWindow calls reach browser activation');

  assert.strictEqual(e.test_set_foreground(second), 1);
  assert.strictEqual(e.test_get_active() >>> 0, second,
    'SetForegroundWindow updates the caller queue active state');
  assert.strictEqual(e.test_bring(child), 1);
  assert.strictEqual(e.test_get_active() >>> 0, first,
    'BringWindowToTop activates a child HWND\'s top-level ancestor');
  assert.deepStrictEqual(hostCalls.slice(-3), [
    ['activate', second], ['zorder', child, 0], ['activate', child],
  ], 'foreground and child Bring calls preserve their renderer targets');

  e.test_destroy(first);
  assert.strictEqual(e.test_get_active(), 0,
    'destroying the active top-level clears GetActiveWindow state');

  console.log('PASS Set/GetActiveWindow retain per-thread USER activation state');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
