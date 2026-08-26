#!/usr/bin/env node
'use strict';

// A handler quantum can expire after the last block budget was spent.  The
// partially executed block must finish before run() returns: resume_ip is a
// host pointer into decoded code, not x86 state that a cooperative callback
// can safely interrupt between slices.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_zero_budget_drains_resume") (result i32)
    (global.set $eip (i32.const 0x00401234))
    ;; One pending threaded op: block_end sets EIP to its operand, zero.
    (i32.store (global.get $THREAD_BASE) (i32.const 45))
    (i32.store offset=4 (global.get $THREAD_BASE) (i32.const 0))
    (global.set $resume_ip (global.get $THREAD_BASE))
    ;; Model re-entry after the preceding chain spent its final block.  The
    ;; saved resume must take precedence over the exhausted budget.
    (call $run (i32.const 0))
    (global.get $eip))
  (func (export "test_resume_after_zero_budget") (result i32)
    (global.get $resume_ip))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  assert.strictEqual(wat.test_zero_budget_drains_resume() >>> 0, 0,
    'run() drains the already-started block even with no block budget left');
  assert.strictEqual(wat.test_resume_after_zero_budget() >>> 0, 0,
    'run() never exposes a decoded-stream resume pointer to the host boundary');
  console.log('PASS run budget cannot strand a partial decoded block across slices');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
