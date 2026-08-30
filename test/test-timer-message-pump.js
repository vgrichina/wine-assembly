#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_get_message") (param $msg i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (global.set $yield_flag (i32.const 0))
    (call $handle_GetMessageA
      (local.get $msg) (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  let now = 0;
  const { exports: e, memory } = await bootRenderHarness({
    extraWat,
    extraHostOverrides: { get_ticks: () => now },
  });
  const msg = 0x3000;

  e.test_timer_set(0, 2, 100, 0x402000);
  now = 100;
  assert.strictEqual(e.test_get_message(msg), 1,
    'GetMessage returns one due window timer');
  assert.strictEqual(e.get_yield_flag(), 0,
    'timer delivery stays in the current guest slice so the pump can become empty');

  const bytes = new DataView(memory.buffer);
  const wa = e.get_guest_base() + msg;
  assert.strictEqual(bytes.getUint32(wa + 4, true), 0x0113,
    'the delivered message is WM_TIMER');
  assert.strictEqual(bytes.getUint32(wa + 8, true), 2,
    'WM_TIMER carries the registered timer id');

  console.log('PASS  GetMessage timer delivery does not strand a draining pump');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
