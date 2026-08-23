#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_mm_timer_consume_tick")
    (param $last i32) (param $interval i32) (param $now i32) (result i32)
    (global.set $mm_timer_last_tick (local.get $last))
    (global.set $mm_timer_interval (local.get $interval))
    (global.set $tick_count (local.get $now))
    (call $mm_timer_consume_due_tick)
    (global.get $mm_timer_last_tick))
  (func (export "test_mm_timer_defers_parked_wait") (result i32)
    (global.set $image_base (i32.const 0x00400000))
    (global.set $esp (i32.const 0x00500000))
    (global.set $eip (i32.const 0x00405678))
    (global.set $mm_timer_id (i32.const 1))
    (global.set $mm_timer_interval (i32.const 0))
    (global.set $mm_timer_callback (i32.const 0x00401000))
    (global.set $mm_timer_in_cb (i32.const 0))
    (global.set $yield_reason (i32.const 1))
    (call $fire_mm_timer))
  (func (export "test_mm_timer_callback_return") (result i32)
    ;; Model fire_mm_timer's interrupted frame, followed by the callback's
    ;; stdcall RET landing on the dedicated CACA000A continuation.
    (global.set $image_base (i32.const 0x00400000))
    (global.set $esp (i32.const 0x00500000))
    (global.set $eip (i32.const 0x00401234))
    (global.set $eax (i32.const 0x11223344))
    (call $save_caller_regs)
    (i32.store (global.get $THUNK_BASE) (i32.const 0xCACA000A))
    (i32.store offset=4 (global.get $THUNK_BASE) (i32.const 0))
    (global.set $mm_timer_in_cb (i32.const 1))
    (call $win32_dispatch (i32.const 0))
    (global.get $mm_timer_in_cb))
  (func (export "test_mm_timer_dispatch_enter") (result i32)
    ;; Dispatch the internal MM_TIMER message exactly as GetMessage supplies
    ;; it. The handler must leave a marked callback frame, not an untracked
    ;; direct return to the application's DispatchMessage caller.
    (global.set $image_base (i32.const 0x00400000))
    (global.set $esp (i32.const 0x00500000))
    (global.set $eip (i32.const 0x00409999))
    (call $gs32 (global.get $esp) (i32.const 0x00401234))
    (call $gs32 (i32.const 0x00510000) (i32.const 0))
    (call $gs32 (i32.const 0x00510004) (i32.const 0x7FF0))
    (call $gs32 (i32.const 0x00510008) (i32.const 7))
    (call $gs32 (i32.const 0x0051000C) (i32.const 0x00405678))
    (global.set $mm_timer_dwuser (i32.const 0x12345678))
    (global.set $mm_timer_ret_thunk (i32.const 0x00402000))
    (i32.store (global.get $THUNK_BASE) (i32.const 0xCACA000A))
    (i32.store offset=4 (global.get $THUNK_BASE) (i32.const 0))
    (call $handle_DispatchMessageA (i32.const 0x00510000)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eip))
  (func (export "test_mm_timer_dispatch_return") (result i32)
    ;; Model RET 20 from the stdcall TimeProc: pop its return address and five
    ;; arguments, then execute the CACA000A continuation.
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
    (call $win32_dispatch (i32.const 0))
    (global.get $mm_timer_in_cb))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });

  assert.strictEqual(wat.test_mm_timer_consume_tick(100, 5, 156), 155,
    'late periodic delivery retains the original 5ms phase');
  assert.strictEqual(wat.test_mm_timer_consume_tick(100, 5, 150), 150,
    'on-time periodic delivery advances by one exact boundary');
  assert.strictEqual(wat.test_mm_timer_consume_tick(100, 0, 156), 156,
    'a zero-delay timer consumes at the current tick without dividing by zero');

  assert.strictEqual(wat.test_mm_timer_defers_parked_wait(), 0,
    'a multimedia callback cannot interrupt a parked Win32 wait frame');
  assert.strictEqual(wat.get_eip() >>> 0, 0x00405678,
    'deferring the callback preserves the parked instruction pointer');
  wat.clear_yield();

  assert.strictEqual(
    wat.test_mm_timer_callback_return(),
    0,
    'the multimedia callback return thunk clears the re-entrancy guard exactly'
  );
  assert.strictEqual(wat.get_eip() >>> 0, 0x00401234,
    'the callback continuation restores the interrupted EIP');
  assert.strictEqual(wat.get_esp() >>> 0, 0x00500000,
    'the callback continuation restores the interrupted stack');

  assert.strictEqual(wat.test_mm_timer_dispatch_enter() >>> 0, 0x00405678,
    'DispatchMessage redirects an internal multimedia timer to its TimeProc');
  assert.strictEqual(wat.is_mm_timer_callback_active(), 1,
    'the message-loop timer path marks its borrowed callback context');
  assert.strictEqual(wat.guest_read32(wat.get_esp()) >>> 0, 0x00402000,
    'the callback returns through the multimedia continuation thunk');
  assert.strictEqual(wat.test_mm_timer_dispatch_return(), 0,
    'the multimedia continuation clears the message-loop callback context');
  assert.strictEqual(wat.get_eip() >>> 0, 0x00401234,
    'the message-loop callback resumes after DispatchMessage');
  assert.strictEqual(wat.get_esp() >>> 0, 0x00500008,
    'the message-loop callback restores the completed stdcall frame');

  console.log('PASS  multimedia timer completion is tied to its return thunk');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
