#!/usr/bin/env node
'use strict';

// The WinG runtime shipped on Civilization II's original retail disc enters
// its bitmap setup through `lfs si,[bp+0e]`. Exercise that exact encoding and
// prove both halves of the far pointer affect the following FS-relative read.
// Civ then switches to 32-bit ESI addressing without a segment prefix; that
// access must select DS afresh and retain the full 32-bit offset.
// VBRUN100 also reaches `verr word [91ad]` while Rodent closes a form. Keep
// that exact disp16 encoding beside the other protected-mode selector probes.

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
    (call $win16_seg_set (i32.const 4) (i32.const 0x00130000)
      (i32.const 0x20000) (i32.const 0) (i32.const 4))
    (global.set $code16 (i32.const 1))
    (global.set $sreg_cs (call $win16_index_to_sel (i32.const 1)))
    (global.set $seg_base_cs (i32.const 0x00100000))
    (global.set $sreg_ss (call $win16_index_to_sel (i32.const 2)))
    (global.set $seg_base_ss (i32.const 0x00110000))
    (global.set $sreg_ds (call $win16_index_to_sel (i32.const 4)))
    (global.set $seg_base_ds (i32.const 0x00130000))
    (global.set $ebp (i32.const 0x0020))
    ;; SS:[BP+0E] = offset 0x3456, selector for segment index 3.
    (call $gs16 (i32.const 0x0011002E) (i32.const 0x3456))
    (call $gs16 (i32.const 0x00110030) (call $win16_index_to_sel (i32.const 3)))
    (call $gs16 (i32.const 0x00123456) (i32.const 0xA55A))
    ;; Distinguish DS:[0] from DS:[0x10000], and both from stale FS.
    (call $gs16 (i32.const 0x00130000) (i32.const 0x1111))
    (call $gs16 (i32.const 0x00140000) (i32.const 0xBEEF))
    ;; A mapped selector must set ZF; an unmapped one must clear it. SETZ AL
    ;; and SETNZ AH turn both answers into the durable marker DX=0x0101.
    (call $gs16 (i32.const 0x001391AD) (call $win16_index_to_sel (i32.const 3)))
    (call $gs16 (i32.const 0x001391AF) (i32.const 0xDEAD))
    ;; verr word [91ad]; setz al; verr word [91af]; setnz ah; mov dx,ax;
    ;; lfs si,[bp+0e]; mov ax,fs:[si]; mov cx,ax;
    ;; mov esi,0x10004; mov ax,ds:[esi-4]; hlt.
    (call $gs8 (i32.const 0x00100200) (i32.const 0x0F))
    (call $gs8 (i32.const 0x00100201) (i32.const 0x00))
    (call $gs8 (i32.const 0x00100202) (i32.const 0x26))
    (call $gs16 (i32.const 0x00100203) (i32.const 0x91AD))
    (call $gs8 (i32.const 0x00100205) (i32.const 0x0F))
    (call $gs8 (i32.const 0x00100206) (i32.const 0x94))
    (call $gs8 (i32.const 0x00100207) (i32.const 0xC0))
    (call $gs8 (i32.const 0x00100208) (i32.const 0x0F))
    (call $gs8 (i32.const 0x00100209) (i32.const 0x00))
    (call $gs8 (i32.const 0x0010020A) (i32.const 0x26))
    (call $gs16 (i32.const 0x0010020B) (i32.const 0x91AF))
    (call $gs8 (i32.const 0x0010020D) (i32.const 0x0F))
    (call $gs8 (i32.const 0x0010020E) (i32.const 0x95))
    (call $gs8 (i32.const 0x0010020F) (i32.const 0xC4))
    (call $gs8 (i32.const 0x00100210) (i32.const 0x8B))
    (call $gs8 (i32.const 0x00100211) (i32.const 0xD0))
    (call $gs8 (i32.const 0x00100212) (i32.const 0x0F))
    (call $gs8 (i32.const 0x00100213) (i32.const 0xB4))
    (call $gs8 (i32.const 0x00100214) (i32.const 0x76))
    (call $gs8 (i32.const 0x00100215) (i32.const 0x0E))
    (call $gs8 (i32.const 0x00100216) (i32.const 0x64))
    (call $gs8 (i32.const 0x00100217) (i32.const 0x8B))
    (call $gs8 (i32.const 0x00100218) (i32.const 0x04))
    (call $gs8 (i32.const 0x00100219) (i32.const 0x8B))
    (call $gs8 (i32.const 0x0010021A) (i32.const 0xC8))
    (call $gs8 (i32.const 0x0010021B) (i32.const 0x66))
    (call $gs8 (i32.const 0x0010021C) (i32.const 0xBE))
    (call $gs32 (i32.const 0x0010021D) (i32.const 0x00010004))
    (call $gs8 (i32.const 0x00100221) (i32.const 0x67))
    (call $gs8 (i32.const 0x00100222) (i32.const 0x8B))
    (call $gs8 (i32.const 0x00100223) (i32.const 0x46))
    (call $gs8 (i32.const 0x00100224) (i32.const 0xFC))
    (call $gs8 (i32.const 0x00100225) (i32.const 0xF4))
    (global.set $eip (i32.const 0x00100200)))
  (func (export "test_lfs_si") (result i32) (call $get_reg16 (i32.const 6)))
  (func (export "test_lfs_ax") (result i32) (call $get_reg16 (i32.const 0)))
  (func (export "test_lfs_cx") (result i32) (call $get_reg16 (i32.const 1)))
  (func (export "test_verr_dx") (result i32) (call $get_reg16 (i32.const 2)))
  (func (export "test_lfs_base") (result i32) (global.get $fs_base))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, width: 32, height: 24 });
  e.test_lfs_setup();
  e.run(1);
  assert.strictEqual(e.test_lfs_si(), 0x0004, 'the later 32-bit ESI value is retained');
  assert.strictEqual(e.test_lfs_base() >>> 0, 0x00120000,
    'LFS resolves the selector to the Win16 segment base');
  assert.strictEqual(e.test_lfs_cx(), 0xA55A,
    'the following FS-relative memory operand reads through the loaded selector');
  assert.strictEqual(e.test_verr_dx(), 0x0101,
    'VERR sets ZF for a mapped selector and clears it for an unmapped selector');
  assert.strictEqual(e.test_lfs_ax(), 0xBEEF,
    '67 [ESI-4] selects DS after FS and keeps the full 32-bit offset');
  console.log('PASS Win16 LFS, FS-relative access, and 32-bit segmented address override');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
