#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_delphi_seh_continue_search")
      (param $fs i32) (param $current i32) (param $head_before i32)
      (param $live i32) (param $saved_next i32) (result i32)
    (global.set $fs_base (local.get $fs))
    (global.set $delphi_seh_rec (local.get $current))
    (global.set $delphi_seh_head_before (local.get $head_before))
    (global.set $delphi_exception_record (i32.const 0x24000))
    (call $gs32 (i32.const 0x24004) (i32.const 7))
    (call $gs32 (local.get $fs) (local.get $live))
    (call $gs32 (local.get $current) (local.get $saved_next))
    (call $delphi_seh_continue_search)
    (global.get $delphi_seh_rec))
  (func (export "test_delphi_exception_flags") (result i32)
    (call $gl32 (i32.const 0x24004)))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const fs = 0x20000;
  const current = 0x21000;
  const live = 0x22000;
  const staleNext = 0x23000;

  assert.strictEqual(
    wat.test_delphi_seh_continue_search(fs, current, current, live, staleNext) >>> 0,
    live,
    'RtlUnwind-mutated chains continue from the live FS:[0] frame',
  );
  assert.strictEqual(wat.test_delphi_exception_flags() >>> 0, 1,
    'continue-search clears transient unwind flags before the next catch frame');
  assert.strictEqual(
    wat.test_delphi_seh_continue_search(fs, current, current, current, staleNext) >>> 0,
    staleNext,
    'untouched chains advance through the current registration record',
  );
  assert.strictEqual(
    wat.test_delphi_seh_continue_search(fs, current, current, -1, staleNext) >>> 0,
    0xFFFFFFFF,
    'an unwind to the end of the live chain stays at the sentinel',
  );
  assert.strictEqual(
    wat.test_delphi_seh_continue_search(fs, current, live, live, staleNext) >>> 0,
    staleNext,
    'searching an outer frame does not jump back to the unchanged live head',
  );

  console.log('PASS  Delphi SEH continuation follows a handler-mutated live chain');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
