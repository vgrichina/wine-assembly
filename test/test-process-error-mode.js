#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_set_error_mode") (param $mode i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_SetErrorMode
      (local.get $mode) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_set_last_error") (param $value i32)
    (global.set $last_error (local.get $value)))
  (func (export "test_get_last_error") (result i32)
    (global.get $last_error))
`;

(async () => {
  const first = await bootRenderHarness({ extraWat, fonts: 'none' });
  const second = await bootRenderHarness({
    extraWat, fonts: 'none', memory: first.memory,
  });
  const e = first.exports;
  const e2 = second.exports;

  const SEM_FAILCRITICALERRORS = 0x0001;
  const SEM_NOGPFAULTERRORBOX = 0x0002;
  const SEM_NOALIGNMENTFAULTEXCEPT = 0x0004;
  const SEM_NOOPENFILEERRORBOX = 0x8000;

  e.test_set_last_error(0x1234);
  assert.strictEqual(e.test_set_error_mode(SEM_FAILCRITICALERRORS), 0,
    'a fresh process returns the default previous error mode');
  assert.strictEqual(e.test_get_last_error(), 0x1234,
    'SetErrorMode success leaves LastError unchanged');
  assert.strictEqual(e.get_esp() >>> 0, 0x00300008,
    'SetErrorMode pops its one stdcall argument');

  const uiModes = SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX;
  assert.strictEqual(e2.test_set_error_mode(uiModes), SEM_FAILCRITICALERRORS,
    'a second WASM instance observes and replaces the process-wide mode');
  assert.strictEqual(e.test_set_error_mode(0), uiModes,
    'the original instance observes the Worker-visible replacement');

  assert.strictEqual(e.test_set_error_mode(SEM_NOALIGNMENTFAULTEXCEPT), 0,
    'the emulated x86 process ignores the alignment-fault mode');
  assert.strictEqual(e2.test_set_error_mode(0), 0,
    'the ignored x86 alignment mode does not become process state');

  assert.strictEqual(e.test_set_error_mode(0x7ffffffe), 0,
    'undocumented input bits do not enter the process mode');
  assert.strictEqual(e2.test_set_error_mode(0), uiModes,
    'known UI flags survive while unknown and x86-only flags are masked');

  console.log('PASS SetErrorMode retains shared Win98 x86 process state');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
