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
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat });
  const queue = new DataView(memory.buffer, 0x400, 64);
  const msgWa = e.get_guest_base() + 0x3000;
  const msg = new DataView(memory.buffer, msgWa, 16);

  const put = (index, hwnd, id, wParam, lParam) => {
    const off = index * 16;
    queue.setUint32(off, hwnd, true);
    queue.setUint32(off + 4, id, true);
    queue.setUint32(off + 8, wParam, true);
    queue.setUint32(off + 12, lParam, true);
  };

  put(0, 0x1111, 0x0417, 8, 1);
  put(1, 0x2222, 0x0200, 2, 3);
  e.set_post_queue_count(2);

  assert.strictEqual(e.test_call_PeekMessageA(0x3000, 0, 0, 0x0400, 1), 1,
    'range-filtered peek finds a later matching message');
  assert.strictEqual(msg.getUint32(4, true), 0x0200,
    'the admitted message is returned');
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

  console.log('PASS  PeekMessage filters posted messages without dropping skipped entries');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
