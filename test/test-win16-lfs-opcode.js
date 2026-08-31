#!/usr/bin/env node
'use strict';

// The WinG runtime shipped on Civilization II's original retail disc enters
// its bitmap setup through `lfs si,[bp+0e]`. Exercise that exact encoding and
// prove both halves of the far pointer affect the following FS-relative read.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_lfs_setup")
    (call $win16_seg_set (i32.const 1) (i32.const 0x00100000)
      (i32.const 0x10000) (i32.const 0) (i32.const 1))
    (call $win16_seg_set (i32.const 2) (i32.const 0x00110000)
      (i32.const 0x10000) (i32.const 1) (i32.const 2))
    (call $win16_seg_set (i32.const 3) (i32.const 0x00120000)
      (i32.const 0x10000) (i32.const 0) (i32.const 3))
    (global.set $code16 (i32.const 1))
    (global.set $sreg_cs (call $win16_index_to_sel (i32.const 1)))
    (global.set $seg_base_cs (i32.const 0x00100000))
    (global.set $sreg_ss (call $win16_index_to_sel (i32.const 2)))
    (global.set $seg_base_ss (i32.const 0x00110000))
    (global.set $sreg_ds (call $win16_index_to_sel (i32.const 2)))
    (global.set $seg_base_ds (i32.const 0x00110000))
    (global.set $ebp (i32.const 0x0020))
    ;; SS:[BP+0E] = offset 0x3456, selector for segment index 3.
    (call $gs16 (i32.const 0x0011002E) (i32.const 0x3456))
    (call $gs16 (i32.const 0x00110030) (call $win16_index_to_sel (i32.const 3)))
    (call $gs16 (i32.const 0x00123456) (i32.const 0xA55A))
    ;; 0F B4 76 0E = lfs si,[bp+0e]; 64 8B 04 = mov ax,fs:[si]; hlt.
    (call $gs8 (i32.const 0x00100200) (i32.const 0x0F))
    (call $gs8 (i32.const 0x00100201) (i32.const 0xB4))
    (call $gs8 (i32.const 0x00100202) (i32.const 0x76))
    (call $gs8 (i32.const 0x00100203) (i32.const 0x0E))
    (call $gs8 (i32.const 0x00100204) (i32.const 0x64))
    (call $gs8 (i32.const 0x00100205) (i32.const 0x8B))
    (call $gs8 (i32.const 0x00100206) (i32.const 0x04))
    (call $gs8 (i32.const 0x00100207) (i32.const 0xF4))
    (global.set $eip (i32.const 0x00100200)))
  (func (export "test_lfs_si") (result i32) (call $get_reg16 (i32.const 6)))
  (func (export "test_lfs_ax") (result i32) (call $get_reg16 (i32.const 0)))
  (func (export "test_lfs_base") (result i32) (global.get $fs_base))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, width: 32, height: 24 });
  e.test_lfs_setup();
  e.run(1);
  assert.strictEqual(e.test_lfs_si(), 0x3456, 'LFS loads the offset into SI');
  assert.strictEqual(e.test_lfs_base() >>> 0, 0x00120000,
    'LFS resolves the selector to the Win16 segment base');
  assert.strictEqual(e.test_lfs_ax(), 0xA55A,
    'the following FS-relative memory operand reads through the loaded selector');
  console.log('PASS Win16 LFS and FS-relative access used by Civ II WinG');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
