#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
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
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });

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

  console.log('PASS  multimedia timer completion is tied to its return thunk');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
