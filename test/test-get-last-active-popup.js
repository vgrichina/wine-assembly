#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const apiTable = require('../src/api_table.json');
const { bootRenderHarness } = require('./render-helper');

const ROOT = path.join(__dirname, '..');

const extraWat = String.raw`
  (func (export "test_make_window")
      (param $style i32) (param $parent i32) (param $owner i32)
      (param $proc i32) (result i32)
    (local $hwnd i32)
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd
      (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $hwnd) (local.get $proc))
    (drop (call $wnd_set_style (local.get $hwnd) (local.get $style)))
    (call $wnd_set_parent (local.get $hwnd) (local.get $parent))
    (call $wnd_set_owner (local.get $hwnd) (local.get $owner))
    (local.get $hwnd))

  (func (export "test_activate") (param $hwnd i32) (result i32)
    (call $active_window_transition (local.get $hwnd)))

  (func (export "test_get_last_active_popup")
      (param $hwnd i32) (param $stack i32) (result i64)
    (global.set $esp (local.get $stack))
    (call $handle_GetLastActivePopup
      (local.get $hwnd) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))

  (func (export "test_remove") (param $hwnd i32)
    (call $wnd_table_remove (local.get $hwnd)))
`;

(async () => {
  assert.strictEqual(apiTable.find(api => api.name === 'GetLastActivePopup').nargs, 1);

  const harness = await bootRenderHarness({ extraWat, fonts: 'none' });
  const { exports: e, memory } = harness;
  const fixture = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE initializes synchronous wndproc dispatch');
  e.init_dx_com_thunks();
  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const toWasm = guest => (guest - imageBase + guestBase) >>> 0;
  const proc = e.guest_alloc(16) >>> 0;
  new Uint8Array(memory.buffer).set(
    Uint8Array.from([0x31, 0xc0, 0xc2, 0x10, 0x00]), toWasm(proc));
  const WS_VISIBLE = 0x10000000;
  const WS_CHILD = 0x40000000;
  const stack = 0x074ff000;
  const result = value => Number(value & 0xffffffffn) >>> 0;
  const finalEsp = value => Number(value >> 32n) >>> 0;
  const getLast = hwnd => BigInt.asUintN(64,
    e.test_get_last_active_popup(hwnd, stack));

  const owner = e.test_make_window(WS_VISIBLE, 0, 0, proc) >>> 0;
  const child = e.test_make_window(WS_VISIBLE | WS_CHILD, owner, 0, proc) >>> 0;
  const popup1 = e.test_make_window(WS_VISIBLE, 0, owner, proc) >>> 0;
  const popup2 = e.test_make_window(WS_VISIBLE, 0, owner, proc) >>> 0;
  const unrelated = e.test_make_window(WS_VISIBLE, 0, 0, proc) >>> 0;

  let packed = getLast(owner);
  assert.strictEqual(result(packed), owner,
    'an owner with no activation history returns itself');
  assert.strictEqual(finalEsp(packed), stack + 8,
    'GetLastActivePopup pops its one stdcall argument');
  assert.strictEqual(result(getLast(child)), child,
    'a child HWND returns itself instead of entering the owner popup group');
  assert.strictEqual(result(getLast(popup1)), popup1,
    'an owned popup HWND returns itself');

  e.test_activate(popup1);
  assert.strictEqual(result(getLast(owner)), popup1,
    'activating an owned popup publishes it on the owner');
  e.test_activate(popup2);
  assert.strictEqual(result(getLast(owner)), popup2,
    'the most recently active direct popup replaces the previous one');
  e.test_activate(unrelated);
  assert.strictEqual(result(getLast(owner)), popup2,
    'activating another owner group preserves this owner\'s popup history');
  e.test_activate(owner);
  assert.strictEqual(result(getLast(owner)), owner,
    'reactivating the owner makes it the last-active group member');

  e.test_activate(popup1);
  e.test_remove(popup1);
  assert.strictEqual(result(getLast(owner)), owner,
    'a destroyed remembered popup is rejected');

  e.test_activate(popup2);
  e.test_remove(owner);
  const replacement = e.test_make_window(WS_VISIBLE, 0, 0, proc) >>> 0;
  assert.strictEqual(result(getLast(replacement)), replacement,
    'a recycled table slot cannot inherit another owner\'s popup history');

  console.log('PASS GetLastActivePopup retains validated per-owner activation history');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
