#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const ROOT = path.join(__dirname, '..');
const extraWat = String.raw`
  (func (export "test_show_owned_top_level") (param $wndproc i32) (result i64)
    (local $helper i32) (local $form i32)
    (local.set $helper (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $helper) (local.get $wndproc))
    (drop (call $wnd_set_style (local.get $helper) (i32.const 0x10000000)))

    (local.set $form (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $form) (local.get $wndproc))
    (call $wnd_set_owner (local.get $form) (local.get $helper))
    (drop (call $wnd_set_style (local.get $form) (i32.const 0)))

    ;; Model VCL's zero-sized TApplication having consumed startup activation.
    (global.set $main_hwnd (local.get $helper))
    (global.set $show_window_activated (i32.const 1))
    (global.set $active_hwnd (local.get $helper))
    (global.set $focus_hwnd (local.get $helper))
    ;; Model the imported ShowWindow frame's return slot. The continuation
    ;; chain returns to zero, which is the nested-test run stop sentinel.
    (call $gs32 (global.get $esp) (i32.const 0))
    (call $handle_ShowWindow
      (local.get $form) (i32.const 3)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or (i64.extend_i32_u (local.get $helper))
      (i64.shl (i64.extend_i32_u (local.get $form)) (i64.const 32))))

  (func (export "test_active_hwnd") (result i32) (global.get $active_hwnd))
  (func (export "test_main_hwnd") (result i32) (global.get $main_hwnd))
`;

function u32(value) {
  return [value, value >>> 8, value >>> 16, value >>> 24].map(v => v & 0xff);
}

(async () => {
  let activatedRendererHwnd = 0;
  let shownFormHwnd = 0;
  let testMemory;
  const harness = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      show_window: hwnd => { shownFormHwnd = hwnd >>> 0; return 800 | (600 << 16); },
      get_window_rect: (hwnd, ptr) => {
        const view = new DataView(testMemory.buffer);
        const visible = (hwnd >>> 0) === shownFormHwnd;
        view.setInt32(ptr, 0, true);
        view.setInt32(ptr + 4, 0, true);
        view.setInt32(ptr + 8, visible ? 800 : 0, true);
        view.setInt32(ptr + 12, visible ? 600 : 0, true);
      },
      activate_window: hwnd => { activatedRendererHwnd = hwnd >>> 0; return 1; },
    },
  });
  const { exports: e, memory } = harness;
  testMemory = memory;
  const fixture = fs.readFileSync(path.join(
    ROOT, 'test', 'binaries', 'entertainment-pack', 'sol.exe'));
  new Uint8Array(memory.buffer).set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE initializes x86 callback support');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const toWasm = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const count = e.guest_alloc(4) >>> 0;
  const messages = e.guest_alloc(32) >>> 0;
  const proc = e.guest_alloc(64) >>> 0;

  // WNDPROC: messages[count++] = msg; return 0.
  bytes.set(Uint8Array.from([
    0x8b, 0x0d, ...u32(count),
    0x8b, 0x44, 0x24, 0x08,
    0x89, 0x04, 0x8d, ...u32(messages),
    0x41,
    0x89, 0x0d, ...u32(count),
    0x31, 0xc0,
    0xc2, 0x10, 0x00,
  ]), toWasm(proc));

  const packed = BigInt.asUintN(64, e.test_show_owned_top_level(proc));
  const helper = Number(packed & 0xffffffffn) >>> 0;
  const form = Number(packed >> 32n) >>> 0;
  assert.notStrictEqual(form, helper);
  assert.strictEqual(e.test_main_hwnd() >>> 0, form,
    'visible form replaces its zero-area VCL utility owner as main HWND');
  assert.strictEqual(e.test_active_hwnd() >>> 0, form,
    'activating ShowWindow transitions away from the utility HWND');
  e.run(1000000);
  assert.strictEqual(e.get_focus_hwnd() >>> 0, form,
    'activated owned top-level receives focus');
  assert.strictEqual(activatedRendererHwnd, form,
    'renderer input ownership follows the activated form');
  const seen = Array.from({ length: view.getUint32(toWasm(count), true) }, (_, i) =>
    view.getUint32(toWasm(messages + i * 4), true));
  assert.deepStrictEqual(seen, [0x001c, 0x0006, 0x0007, 0x0003, 0x0005],
    'resumable startup chain delivers activation, focus, move, and size');
  console.log('PASS activating ShowWindow reaches a VCL-style owned top-level form');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
