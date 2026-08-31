#!/usr/bin/env node
'use strict';

// Civilization II's 16-bit executable validates a cached far pointer with
//   lar ax,[bp-6] / jnz stale / test ax,0800h / jnz code_selector
// before dereferencing it. Exercise that exact memory encoding through the
// real decoder and threaded executor, including the architectural distinction
// between valid data, valid code, and an invalid selector.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_lar_setup") (param $off i32) (param $sel i32)
        (param $eax_in i32)
    (local $code i32)
    (global.set $image_base (i32.const 0))
    (call $win16_seg_set (i32.const 1) (i32.const 0x00100000)
      (i32.const 0x10000) (i32.const 0) (i32.const 1))
    (call $win16_seg_set (i32.const 2) (i32.const 0x00110000)
      (i32.const 0x10000) (i32.const 1) (i32.const 2))
    (global.set $code16 (i32.const 1))
    (global.set $sreg_cs (call $win16_index_to_sel (i32.const 1)))
    (global.set $seg_base_cs (i32.const 0x00100000))
    (global.set $sreg_ss (call $win16_index_to_sel (i32.const 2)))
    (global.set $seg_base_ss (i32.const 0x00110000))
    (global.set $sreg_ds (call $win16_index_to_sel (i32.const 2)))
    (global.set $seg_base_ds (i32.const 0x00110000))
    (global.set $ebp (i32.const 0x26))
    (global.set $eax (local.get $eax_in))
    (call $gs16 (i32.const 0x00110020) (local.get $sel))
    (local.set $code (i32.add (i32.const 0x00100000) (local.get $off)))
    (call $gs8 (local.get $code)                 (i32.const 0x0F))
    (call $gs8 (i32.add (local.get $code) (i32.const 1)) (i32.const 0x02))
    (call $gs8 (i32.add (local.get $code) (i32.const 2)) (i32.const 0x46))
    (call $gs8 (i32.add (local.get $code) (i32.const 3)) (i32.const 0xFA))
    (call $gs8 (i32.add (local.get $code) (i32.const 4)) (i32.const 0xF4))
    (call $load_eflags (i32.const 0x202))
    (global.set $eip (local.get $code)))
  (func (export "test_lar_eax") (result i32) (global.get $eax))
  (func (export "test_lar_zf") (result i32) (call $get_zf))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, width: 32, height: 24 });
  const DATA = 0x17; // selector index 2, TI/RPL bits set like a Win16 selector
  const CODE = 0x0f; // selector index 1

  e.test_lar_setup(0x200, DATA, 0xABCD7777);
  e.run(1);
  assert.strictEqual(e.test_lar_eax() >>> 0, 0xABCDF300,
    'valid data selector should return a present DPL3 writable-data access byte in AX');
  assert.strictEqual(e.test_lar_zf(), 1, 'valid data selector should set ZF');
  assert.strictEqual((e.test_lar_eax() & 0x0800), 0,
    'data selector must leave Civ II executable/access-right bit clear');

  e.test_lar_setup(0x220, CODE, 0x12345678);
  e.run(1);
  assert.strictEqual(e.test_lar_eax() >>> 0, 0x1234FB00,
    'valid code selector should return a readable-code access byte in AX');
  assert.strictEqual(e.test_lar_zf(), 1, 'valid code selector should set ZF');
  assert.strictEqual(e.test_lar_eax() & 0x0800, 0x0800,
    'code selector must set the access-right bit Civ II tests');

  e.test_lar_setup(0x240, 0xFFF7, 0x89ABCDEF);
  e.run(1);
  assert.strictEqual(e.test_lar_eax() >>> 0, 0x89ABCDEF,
    'invalid selector should leave the destination unchanged');
  assert.strictEqual(e.test_lar_zf(), 0, 'invalid selector should clear ZF');

  console.log('PASS Win16 LAR decodes Civ II memory form and reports data/code/invalid selectors');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
