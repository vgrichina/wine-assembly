#!/usr/bin/env node

'use strict';

// Begin/Defer/EndDeferWindowPos is one transaction. Defer retains WINDOWPOS
// records without changing the windows; End validates the complete set and
// commits each record through the ordinary SetWindowPos path.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const pack = (low, high) => ((low & 0xffff) | ((high & 0xffff) << 16)) >>> 0;

const extraWat = String.raw`
  (func (export "test_make_parent") (result i32)
    (local $hwnd i32)
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_CTRL_NATIVE))
    (drop (call $wnd_set_style (local.get $hwnd) (i32.const 0x90000000)))
    (local.get $hwnd))

  (func (export "test_make_child")
      (param $parent i32) (param $x i32) (param $y i32)
      (param $width i32) (param $height i32) (result i32)
    (call $ctrl_create_child
      (local.get $parent) (i32.const 2) (i32.const 100)
      (local.get $x) (local.get $y) (local.get $width) (local.get $height)
      (i32.const 0x50000000) (i32.const 0)))

  (func (export "test_call_BeginDeferWindowPos") (param $count i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_BeginDeferWindowPos
      (local.get $count) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_DeferWindowPos")
      (param $hdwp i32) (param $hwnd i32) (param $after i32)
      (param $x i32) (param $y i32) (param $width i32)
      (param $height i32) (param $flags i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $gs32 (i32.add (local.get $saved_esp) (i32.const 24)) (local.get $width))
    (call $gs32 (i32.add (local.get $saved_esp) (i32.const 28)) (local.get $height))
    (call $gs32 (i32.add (local.get $saved_esp) (i32.const 32)) (local.get $flags))
    (call $handle_DeferWindowPos
      (local.get $hdwp) (local.get $hwnd) (local.get $after)
      (local.get $x) (local.get $y) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_EndDeferWindowPos") (param $hdwp i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_EndDeferWindowPos
      (local.get $hdwp) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_last_error") (result i32) (global.get $last_error))
`;

(async () => {
  const sizes = new Map();
  const positions = new Map();
  const moves = [];
  let memory;
  let tracking = false;

  const harness = await bootRenderHarness({
    extraWat,
    extraHostOverrides: {
      get_window_client_size(hwnd) {
        return sizes.get(hwnd >>> 0) || 0;
      },
      move_window(hwnd, x, y, width, height, flags) {
        hwnd >>>= 0;
        flags >>>= 0;
        const oldSize = sizes.get(hwnd) || 0;
        const oldPosition = positions.get(hwnd) || 0;
        const nextWidth = flags & 0x0001 ? oldSize & 0xffff : width;
        const nextHeight = flags & 0x0001 ? oldSize >>> 16 : height;
        const nextX = flags & 0x0002 ? oldPosition << 16 >> 16 : x;
        const nextY = flags & 0x0002 ? oldPosition >> 16 : y;
        sizes.set(hwnd, pack(nextWidth, nextHeight));
        positions.set(hwnd, pack(nextX, nextY));
        if (tracking) moves.push({ hwnd, x, y, width, height, flags });
      },
      get_window_rect(hwnd, out) {
        const xy = positions.get(hwnd >>> 0) || 0;
        const wh = sizes.get(hwnd >>> 0) || 0;
        const view = new DataView(memory.buffer);
        const x = xy << 16 >> 16;
        const y = xy >> 16;
        view.setInt32(out, x, true);
        view.setInt32(out + 4, y, true);
        view.setInt32(out + 8, x + (wh & 0xffff), true);
        view.setInt32(out + 12, y + (wh >>> 16), true);
      },
    },
  });
  const e = harness.exports;
  memory = harness.memory;

  const parent = e.test_make_parent() >>> 0;
  const first = e.test_make_child(parent, 0, 0, 40, 20) >>> 0;
  const second = e.test_make_child(parent, 2, 3, 50, 25) >>> 0;
  const reparented = e.test_make_child(parent, 6, 7, 45, 23) >>> 0;
  const otherParent = e.test_make_parent() >>> 0;
  const outsider = e.test_make_child(otherParent, 4, 5, 60, 30) >>> 0;
  sizes.set(first, pack(40, 20));
  sizes.set(second, pack(50, 25));
  sizes.set(reparented, pack(45, 23));
  sizes.set(outsider, pack(60, 30));
  positions.set(first, pack(0, 0));
  positions.set(second, pack(2, 3));
  positions.set(reparented, pack(6, 7));
  positions.set(outsider, pack(4, 5));
  tracking = true;

  assert.strictEqual(e.test_call_BeginDeferWindowPos(-1), 0,
    'negative initial capacity is invalid');
  assert.strictEqual(e.test_last_error(), 87, 'negative capacity sets ERROR_INVALID_PARAMETER');
  const preallocated = e.test_call_BeginDeferWindowPos(65) >>> 0;
  assert(preallocated,
    'the transaction capacity is not narrower than the browser USER window table');
  assert.strictEqual(e.test_call_EndDeferWindowPos(preallocated), 1);
  assert.strictEqual(e.test_call_BeginDeferWindowPos(257), 0,
    'the bounded browser USER repository rejects impossible capacity');
  assert.strictEqual(e.test_last_error(), 8, 'capacity exhaustion sets ERROR_NOT_ENOUGH_MEMORY');

  const hdwp = e.test_call_BeginDeferWindowPos(1) >>> 0;
  assert(hdwp, 'BeginDeferWindowPos returns an opaque live handle');
  assert.notStrictEqual(hdwp, 0xdef00001, 'the old universal magic handle is gone');
  assert.strictEqual(
    e.test_call_DeferWindowPos(hdwp, first, 0, 10, 12, 80, 30, 0x14) >>> 0,
    hdwp, 'DeferWindowPos returns the current live handle');
  assert.strictEqual(
    e.test_call_DeferWindowPos(hdwp, second, 0, 20, 24, 90, 35, 0x14) >>> 0,
    hdwp, 'the repository grows beyond Begin initial capacity');
  assert.deepStrictEqual(moves, [], 'DeferWindowPos does not change geometry before End');
  assert.strictEqual(positions.get(first), pack(0, 0));
  assert.strictEqual(sizes.get(second), pack(50, 25));

  assert.strictEqual(e.test_call_EndDeferWindowPos(hdwp), 1,
    'EndDeferWindowPos commits the complete transaction');
  assert.deepStrictEqual(moves.map(move => move.hwnd), [first, second],
    'End applies retained records in their original order');
  assert.strictEqual(positions.get(first), pack(10, 12));
  assert.strictEqual(sizes.get(first), pack(80, 30));
  assert.strictEqual(positions.get(second), pack(20, 24));
  assert.strictEqual(sizes.get(second), pack(90, 35));
  assert.strictEqual(e.test_call_EndDeferWindowPos(hdwp), 0,
    'End consumes and invalidates its HDWP');
  assert.strictEqual(e.test_last_error(), 6, 'a consumed HDWP reports ERROR_INVALID_HANDLE');
  assert.strictEqual(
    e.test_call_DeferWindowPos(hdwp, first, 0, 0, 0, 1, 1, 0x14), 0,
    'a stale HDWP cannot accept more records');

  const movesBeforeFailure = moves.length;
  const mixedParents = e.test_call_BeginDeferWindowPos(2) >>> 0;
  assert.strictEqual(
    e.test_call_DeferWindowPos(mixedParents, first, 0, 1, 1, 41, 21, 0x14) >>> 0,
    mixedParents);
  assert.strictEqual(
    e.test_call_DeferWindowPos(mixedParents, outsider, 0, 2, 2, 61, 31, 0x14), 0,
    'all windows in one transaction must share a parent');
  assert.strictEqual(e.test_last_error(), 87);
  assert.strictEqual(e.test_call_EndDeferWindowPos(mixedParents), 0,
    'a failed Defer abandons the whole transaction');
  assert.strictEqual(moves.length, movesBeforeFailure,
    'an abandoned transaction applies none of its earlier records');

  const badWindow = e.test_call_BeginDeferWindowPos(1) >>> 0;
  assert.strictEqual(
    e.test_call_DeferWindowPos(badWindow, 0, 0, 0, 0, 40, 20, 0x14),
    0, 'NULL is not a window even though HWND_TOP is valid as insert-after');
  assert.strictEqual(e.test_last_error(), 1400);
  assert.strictEqual(e.test_call_EndDeferWindowPos(badWindow), 0,
    'invalid-window failure consumes the transaction');

  const badAfter = e.test_call_BeginDeferWindowPos(1) >>> 0;
  assert.strictEqual(
    e.test_call_DeferWindowPos(badAfter, first, 0x12345678, 0, 0, 40, 20, 0x10),
    0, 'a non-sentinel insertion target must be a live sibling HWND');
  assert.strictEqual(e.test_last_error(), 1400);

  const parentChanged = e.test_call_BeginDeferWindowPos(1) >>> 0;
  assert.strictEqual(
    e.test_call_DeferWindowPos(parentChanged, reparented, 0, 9, 10, 46, 24, 0x14) >>> 0,
    parentChanged);
  e.test_wnd_set_parent(reparented, otherParent);
  assert.strictEqual(e.test_call_EndDeferWindowPos(parentChanged), 0,
    'End revalidates the common parent before applying any record');
  assert.strictEqual(e.test_last_error(), 87);
  assert.strictEqual(positions.get(reparented), pack(6, 7),
    'a reparented transaction remains unapplied');

  const emptyA = e.test_call_BeginDeferWindowPos(0) >>> 0;
  const emptyB = e.test_call_BeginDeferWindowPos(0) >>> 0;
  assert(emptyA && emptyB && emptyA !== emptyB,
    'simultaneous empty transactions receive distinct handles');
  assert.strictEqual(e.test_call_EndDeferWindowPos(emptyA), 1);
  assert.strictEqual(e.test_call_EndDeferWindowPos(emptyB), 1);

  console.log('PASS  Begin/Defer/EndDeferWindowPos owns an atomic HDWP lifecycle');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
