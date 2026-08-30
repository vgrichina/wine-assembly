#!/usr/bin/env node

'use strict';

// Destroying a top-level window leaves quit_flag=1 as a lifecycle hint. A live
// replacement main HWND makes that marker stale; no live main HWND means the
// old message loop must unwind before a launcher can create its next window.
// PostQuitMessage uses the distinct explicit value 2.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_set_quit_flag") (param $value i32)
    (global.set $quit_flag (local.get $value)))

  (func (export "test_set_main_hwnd") (param $value i32)
    (global.set $main_hwnd (local.get $value)))

  (func (export "test_call_GetMessageA")
    (param $msg i32) (result i32)
    (local $saved_esp i32) (local $saved_eip i32) (local $result i32)
    (local.set $saved_esp (global.get $esp))
    (local.set $saved_eip (global.get $eip))
    (call $handle_GetMessageA
      (local.get $msg) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (local.set $result (global.get $eax))
    (global.set $esp (local.get $saved_esp))
    (global.set $eip (local.get $saved_eip))
    (local.get $result))

  (func (export "test_call_WaitMessage") (result i32)
    (global.set $esp (i32.const 0x00300000))
    (global.set $eax (i32.const 0))
    (call $handle_WaitMessage
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat });
  const guestMsg = 0x3000;
  const msg = new DataView(memory.buffer, e.get_guest_base() + guestMsg, 16);
  const queue = new DataView(memory.buffer, 0x400, 16);

  queue.setUint32(0, 0x1234, true);
  queue.setUint32(4, 0x0401, true);
  queue.setUint32(8, 0x5678, true);
  queue.setUint32(12, 0x9abc, true);
  e.set_post_queue_count(1);
  e.test_set_main_hwnd(0x1234);
  e.wnd_table_set(0x1234, 0xFFFF0001);
  e.test_set_quit_flag(1);

  assert.strictEqual(e.test_call_GetMessageA(guestMsg), 1,
    'teardown marker does not quit a recreated live main window');
  assert.strictEqual(e.get_quit_flag(), 0,
    'stale recreation marker is cleared when GetMessage observes it');
  assert.strictEqual(msg.getUint32(4, true), 0x0401,
    'GetMessage continues to the next real queued message');
  assert.strictEqual(msg.getUint32(8, true), 0x5678);

  e.test_set_main_hwnd(0x4321);
  e.test_set_quit_flag(1);
  assert.strictEqual(e.test_call_GetMessageA(guestMsg), 0,
    'destroyed main window terminates its old message loop');
  assert.strictEqual(e.get_quit_flag(), 0,
    'synthetic loop-exit marker is consumed');
  assert.strictEqual(msg.getUint32(4, true), 0x0012,
    'destroyed main loop receives the synthetic WM_QUIT shape');

  e.test_set_quit_flag(2);
  assert.strictEqual(e.test_call_GetMessageA(guestMsg), 0,
    'explicit PostQuitMessage marker terminates GetMessage');
  assert.strictEqual(msg.getUint32(4, true), 0x0012,
    'explicit marker is delivered as WM_QUIT');

  e.test_set_quit_flag(0);
  e.test_set_main_hwnd(0);
  e.set_post_queue_count(0);
  assert.strictEqual(e.has_pending_message(), 0,
    'the WaitMessage regression starts with an idle USER queue');
  e.test_call_WaitMessage();
  assert.strictEqual(e.get_yield_reason(), 7,
    'WaitMessage parks on the browser message-wait yield');
  assert.strictEqual(e.get_esp(), 0x00300000,
    'a parked WaitMessage keeps its return address live');

  queue.setUint32(0, 0x2468, true);
  queue.setUint32(4, 0x0402, true);
  queue.setUint32(8, 0x1357, true);
  queue.setUint32(12, 0x9bdf, true);
  e.set_post_queue_count(1);
  assert.strictEqual(e.has_pending_message(), 1,
    'posting browser-visible queue work wakes the message scheduler');
  assert.strictEqual(e.resume_message_wait(), 1,
    'the scheduler completes WaitMessage after queue work arrives');
  assert.strictEqual(e.get_yield_reason(), 0);
  assert.strictEqual(e.get_eax(), 1,
    'WaitMessage returns TRUE after waking');
  assert.strictEqual(e.get_esp(), 0x00300004,
    'WaitMessage completes exactly its zero-argument stdcall frame');
  assert.strictEqual(e.get_post_queue_count(), 1,
    'WaitMessage wakes without consuming the queued message');

  assert.strictEqual(e.test_call_WaitMessage(), 1,
    'WaitMessage returns immediately when USER work is already queued');
  assert.strictEqual(e.get_yield_reason(), 0,
    'an already-ready queue does not park the thread');
  assert.strictEqual(e.get_esp(), 0x00300004);

  console.log('PASS  GetMessage quit states and WaitMessage browser wake semantics');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
