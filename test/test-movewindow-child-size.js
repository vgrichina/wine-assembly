#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const sizes = new Map();
const positions = new Map();
const moveFlags = [];
const pack = (w, h) => ((w & 0xffff) | ((h & 0xffff) << 16)) >>> 0;

const extraWat = String.raw`
  (func (export "test_call_MoveWindow")
    (param $hwnd i32) (param $x i32) (param $y i32)
    (param $w i32) (param $h i32) (param $repaint i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $gs32 (i32.add (local.get $saved_esp) (i32.const 24)) (local.get $repaint))
    (call $handle_MoveWindow
      (local.get $hwnd) (local.get $x) (local.get $y)
      (local.get $w) (local.get $h) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
  (func (export "test_call_SetWindowPos")
    (param $hwnd i32) (param $x i32) (param $y i32)
    (param $w i32) (param $h i32) (param $flags i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $gs32 (i32.add (local.get $saved_esp) (i32.const 24)) (local.get $h))
    (call $gs32 (i32.add (local.get $saved_esp) (i32.const 28)) (local.get $flags))
    (call $handle_SetWindowPos
      (local.get $hwnd) (i32.const 0) (local.get $x) (local.get $y)
      (local.get $w) (i32.const 0))
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
        if (!(flags & 0x0002)) positions.set(hwnd, pack(_x, _y));
        moveFlags.push(flags >>> 0);
      },
      get_window_rect(hwnd, out) {
        const xy = positions.get(hwnd >>> 0) || 0;
        const wh = sizes.get(hwnd >>> 0) || 0;
        const view = new DataView(memory.buffer);
        view.setInt32(out, xy << 16 >> 16, true);
        view.setInt32(out + 4, xy >> 16, true);
        view.setInt32(out + 8, (xy << 16 >> 16) + (wh & 0xffff), true);
        view.setInt32(out + 12, (xy >> 16) + (wh >>> 16), true);
      },
    },
  });

  const first = e.test_create_edit(0, 0, 40, 20, 0x50000000, 0) >>> 0;
  const second = e.test_create_edit(0, 0, 50, 25, 0x50000000, 0) >>> 0;
  sizes.set(first, pack(40, 20));
  sizes.set(second, pack(50, 25));
  positions.set(first, pack(0, 0));
  positions.set(second, pack(0, 0));
  e.set_post_queue_count(0);

  assert.strictEqual(e.test_call_MoveWindow(first, 10, 12, 80, 30, 1), 1,
    'first child resize succeeds');
  assert.strictEqual(e.test_call_MoveWindow(second, 20, 24, 90, 35, 0), 1,
    'second child resize succeeds');
  assert.strictEqual(e.get_post_queue_count(), 0,
    'built-in default processing sends geometry messages synchronously');
  assert.strictEqual(positions.get(first), pack(10, 12));
  assert.strictEqual(sizes.get(first), pack(80, 30));
  assert.strictEqual(positions.get(second), pack(20, 24));
  assert.strictEqual(sizes.get(second), pack(90, 35));
  assert.strictEqual(moveFlags[0], 0x14,
    'bRepaint=TRUE keeps redraw enabled while preserving z-order and activation');
  assert.strictEqual(moveFlags[1], 0x1c,
    'bRepaint=FALSE maps to SWP_NOREDRAW');

  e.test_call_MoveWindow(second, 20, 24, 90, 35, 1);
  assert.strictEqual(e.get_post_queue_count(), 0,
    'same-geometry MoveWindow creates no deferred geometry-message loop');

  assert.strictEqual(e.test_call_SetWindowPos(first, 30, 32, 100, 40, 0x14), 1,
    'SetWindowPos move and resize succeeds');
  assert.strictEqual(e.get_post_queue_count(), 0,
    'SetWindowPos default geometry messages are not posted');
  assert.strictEqual(positions.get(first), pack(30, 32));
  assert.strictEqual(sizes.get(first), pack(100, 40));

  e.test_call_SetWindowPos(first, 99, 99, 150, 60, 0x17); // NOMOVE|NOSIZE
  assert.strictEqual(e.get_post_queue_count(), 0,
    'SWP_NOMOVE|SWP_NOSIZE leaves no queued geometry messages');

  console.log('PASS MoveWindow/SetWindowPos preserve geometry messages and repaint flags');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
