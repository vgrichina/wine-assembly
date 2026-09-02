#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_get_priority_class") (param $process i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GetPriorityClass
      (local.get $process) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_set_priority_class")
      (param $process i32) (param $class i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_SetPriorityClass
      (local.get $process) (local.get $class) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_open_process") (param $pid i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_OpenProcess
      (i32.const 0x0600) (i32.const 0) (local.get $pid)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_process_id") (result i32)
    (call $current_process_id))
  (func (export "test_set_last_error") (param $value i32)
    (global.set $last_error (local.get $value)))
  (func (export "test_get_last_error") (result i32)
    (global.get $last_error))
`;

(async () => {
  const first = await bootRenderHarness({ extraWat, fonts: 'none' });
  const e = first.exports;
  const second = await bootRenderHarness({
    extraWat, fonts: 'none', memory: first.memory,
  });
  const e2 = second.exports;

  const CURRENT_PROCESS = -1;
  const NORMAL = 0x20;
  const IDLE = 0x40;
  const HIGH = 0x80;
  const REALTIME = 0x100;

  e.test_set_last_error(0x1234);
  assert.strictEqual(e.test_get_priority_class(CURRENT_PROCESS), NORMAL,
    'a fresh Win98 process starts at NORMAL_PRIORITY_CLASS');
  assert.strictEqual(e.test_get_last_error(), 0x1234,
    'a successful query does not overwrite LastError');
  assert.strictEqual(e.get_esp() >>> 0, 0x00300008,
    'GetPriorityClass pops its one stdcall argument');

  assert.strictEqual(e.test_set_priority_class(CURRENT_PROCESS, IDLE), 1,
    'the current-process pseudo-handle can select IDLE priority');
  assert.strictEqual(e.test_get_priority_class(CURRENT_PROCESS), IDLE,
    'GetPriorityClass reads back the selected class');
  assert.strictEqual(e2.test_get_priority_class(CURRENT_PROCESS), IDLE,
    'a second WASM instance observes the process-wide selected class');
  assert.strictEqual(e.test_get_last_error(), 0x1234,
    'successful set/get calls leave LastError unchanged');

  const process = e.test_open_process(e.test_process_id()) >>> 0;
  assert.notStrictEqual(process, 0,
    'OpenProcess returns a durable handle for the emulated process');
  e.test_set_last_error(0x5678);
  assert.strictEqual(e.test_set_priority_class(process, HIGH), 1,
    'an opened current-process handle can select HIGH priority');
  assert.strictEqual(e.test_get_priority_class(process), HIGH,
    'the opened handle observes the same process-wide class');
  assert.strictEqual(e.test_get_priority_class(CURRENT_PROCESS), HIGH,
    'pseudo and opened handles share one priority-class state');
  assert.strictEqual(e.test_get_last_error(), 0x5678,
    'opened-handle success also preserves LastError');

  assert.strictEqual(e.test_set_priority_class(process, 0x4000), 0,
    'post-Win98 BELOW_NORMAL_PRIORITY_CLASS is rejected');
  assert.strictEqual(e.test_get_last_error(), 87,
    'an unsupported priority class reports ERROR_INVALID_PARAMETER');
  assert.strictEqual(e.test_get_priority_class(process), HIGH,
    'a rejected class does not mutate retained process state');

  assert.strictEqual(e.test_set_priority_class(0x7777, REALTIME), 0,
    'a fabricated process handle cannot change priority');
  assert.strictEqual(e.test_get_last_error(), 6,
    'SetPriorityClass reports ERROR_INVALID_HANDLE first');
  assert.strictEqual(e.get_esp() >>> 0, 0x0030000c,
    'SetPriorityClass pops its two stdcall arguments on failure');
  assert.strictEqual(e.test_get_priority_class(0x7777), 0,
    'GetPriorityClass rejects a fabricated process handle');
  assert.strictEqual(e.test_get_last_error(), 6,
    'GetPriorityClass reports ERROR_INVALID_HANDLE');

  assert.strictEqual(e.test_set_priority_class(process, REALTIME), 1,
    'REALTIME_PRIORITY_CLASS is a supported original Win98 class');
  assert.strictEqual(e2.test_set_priority_class(CURRENT_PROCESS, NORMAL), 1,
    'another WASM instance can restore NORMAL priority');
  assert.strictEqual(e.test_get_priority_class(process), NORMAL,
    'restored priority is visible through every instance and process handle');

  console.log('PASS process priority class has shared Win98 state and errors');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
