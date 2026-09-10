#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: e } = await bootRenderHarness({ fonts: 'none', extraWat: `
    (func (export "test_wait_message") (result i32)
      (call $win16_seg_set (i32.const 1) (i32.const 0x00100000)
        (i32.const 0x10000) (i32.const 0) (i32.const 1))
      (global.set $code16 (i32.const 1))
      (global.set $esp (i32.const 0x00110100))
      (call $gs16 (i32.const 0x00110100) (i32.const 0x395))
      (call $gs16 (i32.const 0x00110102) (call $win16_index_to_sel (i32.const 1)))
      (drop (call $win16_user (i32.const 112)))
      (global.get $eax))
    (func (export "test_wait_esp") (result i32) (global.get $esp))
    (func (export "test_wait_flag") (result i32) (global.get $yield_flag))
  ` });
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(e.test_wait_message(), 1);
    assert.strictEqual(e.get_yield_reason(), 15, 'explicit queue park, not a reason-0 busy yield');
    assert.strictEqual(e.test_wait_flag(), 1);
    assert.strictEqual(e.get_eip(), 0x100395, 'far return resolves CS:IP');
    assert.strictEqual(e.test_wait_esp(), 0x110104, 'exact four-byte Pascal return');
    e.clear_yield();
    assert.strictEqual(e.get_eip(), 0x100395, 'wake preserves return PC');
    assert.strictEqual(e.test_wait_esp(), 0x110104, 'wake must not pop a Win32 frame');
  }
  console.log('PASS Win16 WaitMessage parks with a stack-neutral resume');
})().catch(err => { console.error(err); process.exitCode = 1; });
