#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_win16_temp_file") (param $drive i32) (param $unique i32) (result i32)
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
    (call $gs8 (i32.const 0x00110200) (i32.const 0x53)) ;; S
    (call $gs8 (i32.const 0x00110201) (i32.const 0x44)) ;; D
    (call $gs8 (i32.const 0x00110202) (i32.const 0))
    (global.set $esp (i32.const 0x00110100))
    ;; Far return, then Pascal's rightmost argument first.
    (call $gs16 (i32.const 0x00110100) (i32.const 0x0010))
    (call $gs16 (i32.const 0x00110102) (call $win16_index_to_sel (i32.const 1)))
    (call $gs16 (i32.const 0x00110104) (i32.const 0x0300))
    (call $gs16 (i32.const 0x00110106) (call $win16_index_to_sel (i32.const 2)))
    (call $gs16 (i32.const 0x00110108) (local.get $unique))
    (call $gs16 (i32.const 0x0011010A) (i32.const 0x0200))
    (call $gs16 (i32.const 0x0011010C) (call $win16_index_to_sel (i32.const 2)))
    (call $gs16 (i32.const 0x0011010E) (local.get $drive))
    (drop (call $win16_kernel (i32.const 97)))
    (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF))
      (i32.shl (global.get $esp) (i32.const 16))))

  (func (export "test_win16_temp_byte") (param $index i32) (result i32)
    (call $gl8 (i32.add (i32.const 0x00110300) (local.get $index))))

  (func (export "test_win16_mkdir") (result i32)
    (call $win16_seg_set (i32.const 2) (i32.const 0x00110000)
      (i32.const 0x10000) (i32.const 1) (i32.const 2))
    (global.set $sreg_ds (call $win16_index_to_sel (i32.const 2)))
    (global.set $seg_base_ds (i32.const 0x00110000))
    ;; C:\WINDOWS\TEMP\WISE
    (i64.store (call $g2w (i32.const 0x00110400))
      (i64.const 0x4F444E49575C3A43))
    (i64.store offset=8 (call $g2w (i32.const 0x00110400))
      (i64.const 0x5C504D45545C5357))
    (i64.store offset=16 (call $g2w (i32.const 0x00110400))
      (i64.const 0x00000045534957))
    (global.set $edx (i32.const 0x0400))
    (global.set $eax (i32.const 0x3900))
    (call $win16_dos_int21)
    (global.get $eax))

  (func (export "test_win16_rename") (result i32)
    (call $win16_seg_set (i32.const 2) (i32.const 0x00110000)
      (i32.const 0x10000) (i32.const 1) (i32.const 2))
    (global.set $sreg_ds (call $win16_index_to_sel (i32.const 2)))
    (global.set $seg_base_ds (i32.const 0x00110000))
    (call $win16_set_sreg (i32.const 0) (call $win16_index_to_sel (i32.const 2)))
    (i64.store (call $g2w (i32.const 0x00110500))
      (i64.const 0x2E444C4F5C3A43)) ;; C:\OLD.
    (i32.store offset=7 (call $g2w (i32.const 0x00110500))
      (i32.const 0x00504D54))       ;; TMP\0
    (i64.store (call $g2w (i32.const 0x00110540))
      (i64.const 0x2E57454E5C3A43)) ;; C:\NEW.
    (i32.store offset=7 (call $g2w (i32.const 0x00110540))
      (i32.const 0x00504D54))       ;; TMP\0
    (global.set $edx (i32.const 0x0500))
    (global.set $edi (i32.const 0x0540))
    (global.set $eax (i32.const 0x5600))
    (call $win16_dos_int21)
    (global.get $eax))
`;

(async () => {
  const { exports: e, hostCtx } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const result = e.test_win16_temp_file(0x63, 0x1234) >>> 0;
  assert.strictEqual(result & 0xFFFF, 0x1234,
    'KERNEL.97 should preserve a caller-supplied unique number');
  assert.strictEqual(result >>> 16, 0x0110,
    'GetTempFileName16 should pop its 12-byte Pascal argument frame');
  const text = Array.from({ length: 64 }, (_, i) => e.test_win16_temp_byte(i))
    .slice(0, Array.from({ length: 64 }, (_, i) => e.test_win16_temp_byte(i)).indexOf(0))
    .map(ch => String.fromCharCode(ch)).join('');
  assert.strictEqual(text, 'C:\\WINDOWS\\TEMP\\SD1234.tmp');
  assert.strictEqual(e.test_win16_mkdir() & 0xFFFF, 0,
    'DOS3Call AH=39 should report successful directory creation in AX');
  assert.ok(hostCtx.vfs.dirs.has('c:\\windows\\temp\\wise'),
    'DOS3Call AH=39 should create the requested VFS directory');
  hostCtx.vfs.files.set('c:\\old.tmp', { data: Uint8Array.of(1, 2, 3), attrs: 0x20 });
  assert.strictEqual(e.test_win16_rename() & 0xFFFF, 0,
    'DOS3Call AH=56 should report successful file rename in AX');
  assert.ok(!hostCtx.vfs.files.has('c:\\old.tmp') && hostCtx.vfs.files.has('c:\\new.tmp'),
    'DOS3Call AH=56 should move the file to the ES:DI path');
  console.log('test-win16-temp-file: PASS');
})().catch(error => { console.error(error); process.exit(1); });
