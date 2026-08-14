#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const sizes = new Map();
const pack = (w, h) => ((w & 0xffff) | ((h & 0xffff) << 16)) >>> 0;

const extraWat = String.raw`
  (func (export "test_call_MoveWindow_size")
    (param $hwnd i32) (param $w i32) (param $h i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $gs32 (i32.add (local.get $saved_esp) (i32.const 24)) (i32.const 1))
    (call $handle_MoveWindow
      (local.get $hwnd) (i32.const 0) (i32.const 0)
      (local.get $w) (local.get $h) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({
    extraWat,
    extraHostOverrides: {
      get_window_client_size(hwnd) {
        return sizes.get(hwnd >>> 0) || 0;
      },
      move_window(hwnd, _x, _y, w, h, flags) {
        hwnd >>>= 0;
        const old = sizes.get(hwnd) || 0;
        const oldW = old & 0xffff;
        const oldH = old >>> 16;
        const nextW = (flags & 0x0001) ? oldW : w;
        const nextH = (flags & 0x0001) ? oldH : h;
        sizes.set(hwnd, pack(nextW, nextH));
      },
    },
  });

  const first = e.test_create_edit(0, 0, 40, 20, 0x50000000, 0) >>> 0;
  const second = e.test_create_edit(0, 0, 50, 25, 0x50000000, 0) >>> 0;
  sizes.set(first, pack(40, 20));
  sizes.set(second, pack(50, 25));
  e.set_post_queue_count(0);

  assert.strictEqual(e.test_call_MoveWindow_size(first, 80, 30), 1,
    'first child resize succeeds');
  assert.strictEqual(e.test_call_MoveWindow_size(second, 90, 35), 1,
    'second child resize succeeds');
  assert.strictEqual(e.get_post_queue_count(), 2,
    'each changed child keeps its own queued WM_SIZE');

  const q = new DataView(memory.buffer, 0x400, 32);
  assert.strictEqual(q.getUint32(0, true), first, 'first queue entry targets first child');
  assert.strictEqual(q.getUint32(4, true), 0x0005, 'first queue entry is WM_SIZE');
  assert.strictEqual(q.getUint32(12, true), pack(80, 30),
    'first WM_SIZE carries the new client size');
  assert.strictEqual(q.getUint32(16, true), second, 'second queue entry targets second child');
  assert.strictEqual(q.getUint32(20, true), 0x0005, 'second queue entry is WM_SIZE');
  assert.strictEqual(q.getUint32(28, true), pack(90, 35),
    'second WM_SIZE carries the new client size');

  e.test_call_MoveWindow_size(second, 90, 35);
  assert.strictEqual(e.get_post_queue_count(), 2,
    'same-size MoveWindow does not create a WM_SIZE loop');

  console.log('PASS  MoveWindow preserves WM_SIZE for every resized child');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
