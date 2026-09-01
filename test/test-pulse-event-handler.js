#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (global $test_eax (mut i32) (i32.const 0))
  (global $test_esp_delta (mut i32) (i32.const 0))

  (func (export "call_pulse_event") (param $handle i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_PulseEvent
      (local.get $handle) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $test_eax (global.get $eax))
    (global.set $test_esp_delta (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp)))

  (func (export "last_eax") (result i32) (global.get $test_eax))
  (func (export "last_esp_delta") (result i32) (global.get $test_esp_delta))
`;

(async () => {
  const calls = [];
  const { exports } = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      set_event: handle => {
        calls.push(['set', handle >>> 0]);
        return handle === 0x1234 ? 1 : 0;
      },
      reset_event: handle => {
        calls.push(['reset', handle >>> 0]);
        return 1;
      },
    },
  });

  exports.call_pulse_event(0x1234);
  assert.strictEqual(exports.last_eax(), 1, 'PulseEvent succeeds when SetEvent succeeds');
  assert.strictEqual(exports.last_esp_delta(), 8, 'PulseEvent preserves stdcall cleanup');
  assert.deepStrictEqual(calls, [['set', 0x1234], ['reset', 0x1234]]);

  calls.length = 0;
  exports.call_pulse_event(0x9999);
  assert.strictEqual(exports.last_eax(), 0, 'PulseEvent fails when SetEvent rejects the handle');
  assert.deepStrictEqual(calls, [['set', 0x9999]], 'PulseEvent does not reset invalid handles');

  console.log('PASS  PulseEvent handler resolves dynamically and preserves event semantics');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
