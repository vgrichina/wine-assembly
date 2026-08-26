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

  console.log('PASS  GetMessage distinguishes recreation, teardown, and explicit quit');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
