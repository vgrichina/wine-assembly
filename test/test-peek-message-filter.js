#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_call_PeekMessageA")
    (param $msg i32) (param $hwnd i32) (param $min i32)
    (param $max i32) (param $remove i32) (result i32)
    (local $saved_esp i32) (local $saved_eip i32) (local $result i32)
    (local.set $saved_esp (global.get $esp))
    (local.set $saved_eip (global.get $eip))
    (call $handle_PeekMessageA
      (local.get $msg) (local.get $hwnd) (local.get $min)
      (local.get $max) (local.get $remove) (i32.const 0))
    (local.set $result (global.get $eax))
    (global.set $esp (local.get $saved_esp))
    (global.set $eip (local.get $saved_eip))
    (local.get $result))
  (func (export "test_seed_paint") (param $hwnd i32)
    (global.set $main_hwnd (local.get $hwnd))
    (call $wnd_table_set (local.get $hwnd) (i32.const 0x12345678))
    (call $update_invalidate_full (local.get $hwnd))
    (call $paint_flag_set (local.get $hwnd)))
  (func (export "test_paint_pending") (param $hwnd i32) (result i32)
    (call $paint_flag_test_hwnd (local.get $hwnd)))
`;

(async () => {
  const hardware = [];
  let hardwarePolls = 0;
  let now = 100;
  const { exports: e, memory } = await bootRenderHarness({
    extraWat,
    extraHostOverrides: {
      check_input: () => {
        hardwarePolls++;
        return hardware.length ? hardware.shift() : 0;
      },
      check_input_hwnd: () => 0x3333,
      check_input_lparam: () => 0x0014000A,
      get_ticks: () => now,
    },
  });
  const queue = new DataView(memory.buffer, 0x400, 64);
  const msgWa = e.get_guest_base() + 0x3000;
  const msg = new DataView(memory.buffer, msgWa, 28);

  const put = (index, hwnd, id, wParam, lParam) => {
    const off = index * 16;
    queue.setUint32(off, hwnd, true);
    queue.setUint32(off + 4, id, true);
    queue.setUint32(off + 8, wParam, true);
    queue.setUint32(off + 12, lParam, true);
  };

  put(0, 0x1111, 0x0417, 8, 1);
  put(1, 0x2222, 0x0200, 2, 3);
  msg.setUint32(16, 0xFFFFFFFF, true);
  e.set_post_queue_count(2);

  assert.strictEqual(e.test_call_PeekMessageA(0x3000, 0, 0, 0x0400, 1), 1,
    'range-filtered peek finds a later matching message');
  assert.strictEqual(msg.getUint32(4, true), 0x0200,
    'the admitted message is returned');
  assert.notStrictEqual(msg.getUint32(16, true), 0xFFFFFFFF,
    'a posted message fills MSG.time for callers that merge filtered peeks');
  assert.strictEqual(e.get_post_queue_count(), 1,
    'PM_REMOVE removes only the admitted message');
  assert.strictEqual(queue.getUint32(4, true), 0x0417,
    'a private message above the filter remains queued');

  assert.strictEqual(e.test_call_PeekMessageA(0x3000, 0, 0, 0x0400, 1), 0,
    'peek reports empty when only an out-of-range message remains');
  assert.strictEqual(e.get_post_queue_count(), 1,
    'an out-of-range head message is not consumed');

  assert.strictEqual(e.test_call_PeekMessageA(0x3000, 0x2222, 0, 0, 0), 0,
    'an hWnd filter rejects another window message');
  assert.strictEqual(e.test_call_PeekMessageA(0x3000, 0, 0, 0, 0), 1,
    'an unfiltered PM_NOREMOVE sees the retained private message');
  assert.strictEqual(e.get_post_queue_count(), 1,
    'PM_NOREMOVE leaves the message queued');
  assert.strictEqual(e.test_call_PeekMessageA(0x3000, 0, 0, 0, 1), 1,
    'an unfiltered PM_REMOVE consumes the retained message');
  assert.strictEqual(e.get_post_queue_count(), 0);

  const pollsBeforeHardware = hardwarePolls;
  hardware.push(0x00010201); // WM_LBUTTONDOWN, MK_LBUTTON
  assert.strictEqual(e.test_call_PeekMessageA(0x3000, 0, 0x000F, 0x000F, 1), 0,
    'a WM_PAINT-only peek rejects hardware mouse input');
  assert.strictEqual(hardwarePolls, pollsBeforeHardware + 1,
    'the filtered peek fetched one hardware event');
  assert.strictEqual(e.test_call_PeekMessageA(0x3000, 0, 0, 0x0400, 1), 1,
    'a later general peek receives hardware input skipped by the filter');
  assert.strictEqual(msg.getUint32(0, true), 0x3333);
  assert.strictEqual(msg.getUint32(4, true), 0x0201);
  assert.strictEqual(msg.getUint32(8, true), 1);
  assert.strictEqual(msg.getUint32(12, true), 0x0014000A);
  assert.strictEqual(hardwarePolls, pollsBeforeHardware + 2,
    'the later peek checks for newer hardware before scanning the retained event');
  assert.strictEqual(e.test_call_PeekMessageA(0x3000, 0, 0, 0x0400, 1), 0,
    'PM_REMOVE consumes the retained hardware event after it matches');

  const pollsBeforeDisjoint = hardwarePolls;
  hardware.push(0x000D0102, 0x00000200); // WM_CHAR Enter, then WM_MOUSEMOVE
  assert.strictEqual(e.test_call_PeekMessageA(0x3000, 0, 0, 0x00FF, 1), 0);
  assert.strictEqual(e.test_call_PeekMessageA(0x3000, 0, 0x0109, 0x01FF, 1), 0);
  assert.strictEqual(e.test_call_PeekMessageA(0x3000, 0, 0x020A, 0xFFFF, 1), 0,
    'disjoint filters may skip both keyboard and mouse messages');
  assert.strictEqual(hardwarePolls, pollsBeforeDisjoint + 3,
    'skipping one hardware event allows the next filter to fetch the event behind it');
  assert.strictEqual(e.test_call_PeekMessageA(0x3000, 0, 0x0200, 0x0209, 1), 1,
    'a later mouse filter finds the queued message behind an excluded key');
  assert.strictEqual(msg.getUint32(4, true), 0x0200);
  assert.strictEqual(e.test_call_PeekMessageA(0x3000, 0, 0x0100, 0x0108, 1), 1,
    'the earlier excluded key remains queued in original order for its own filter');
  assert.strictEqual(msg.getUint32(4, true), 0x0102);
  assert.strictEqual(msg.getUint32(8, true), 13);

  e.test_timer_set(0x4444, 7, 10, 0);
  now = 110;
  msg.setUint32(16, 0xFFFFFFFF, true);
  assert.strictEqual(e.test_call_PeekMessageA(0x3000, 0, 0x0109, 0x01FF, 0), 1,
    'the middle disjoint range sees a due WM_TIMER');
  assert.strictEqual(msg.getUint32(4, true), 0x0113);
  assert.strictEqual(msg.getUint32(16, true), 110,
    'a synthesized timer fills MSG.time so a caller can select and remove it');
  assert.strictEqual(e.test_call_PeekMessageA(0x3000, 0, 0x0113, 0x0113, 1), 1,
    'the selected timer can be removed by its exact message range');
  assert.strictEqual(e.test_call_PeekMessageA(0x3000, 0, 0x0113, 0x0113, 1), 0,
    'the consumed timer is not returned forever at the same tick');

  e.test_seed_paint(0x4444);
  assert.strictEqual(e.test_call_PeekMessageA(0x3000, 0, 0x0401, 0x0401, 1), 0,
    'an exact private-message filter does not receive a pending WM_PAINT');
  assert.strictEqual(e.test_paint_pending(0x4444), 1,
    'a filtered-out WM_PAINT remains pending');

  console.log('PASS  PeekMessage filters posted and hardware messages without dropping skipped entries');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
