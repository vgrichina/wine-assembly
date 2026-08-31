#!/usr/bin/env node
'use strict';

// Compatibility calls reached by the original Win16 Civilization II after
// CPUID16's LAR probe: the task passes its DGROUP selector as hModule and then
// requests the Win16 multimedia timer ordinals.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func $test_civ16_setup
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
    (global.set $seg_base_ds (i32.const 0x00110000)))

  (func (export "test_civ16_module_filename") (result i32)
    (call $test_civ16_setup)
    (global.set $esp (i32.const 0x00110100))
    ;; far return followed by Pascal's rightmost argument first.
    (call $gs16 (i32.const 0x00110100) (i32.const 0x0010))
    (call $gs16 (i32.const 0x00110102) (call $win16_index_to_sel (i32.const 1)))
    (call $gs16 (i32.const 0x00110104) (i32.const 32))
    (call $gs16 (i32.const 0x00110106) (i32.const 0x0200))
    (call $gs16 (i32.const 0x00110108) (call $win16_index_to_sel (i32.const 2)))
    ;; The exact hModule shape Civ II uses: a live DGROUP selector.
    (call $gs16 (i32.const 0x0011010A) (call $win16_index_to_sel (i32.const 2)))
    (call $win16_GetModuleFileName)
    (global.get $eax))

  (func (export "test_civ16_filename_byte") (param $index i32) (result i32)
    (call $gl8 (i32.add (i32.const 0x00110200) (local.get $index))))

  (func (export "test_civ16_mmsystem") (param $ordinal i32) (param $argbytes i32)
        (result i32)
    (call $test_civ16_setup)
    (global.set $esp (i32.const 0x00110100))
    (call $gs16 (i32.const 0x00110100) (i32.const 0x0010))
    (call $gs16 (i32.const 0x00110102) (call $win16_index_to_sel (i32.const 1)))
    (call $gs16 (i32.const 0x00110104) (i32.const 1))
    (drop (call $win16_mmsystem (local.get $ordinal)))
    (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF))
      (i32.shl (i32.and (global.get $edx) (i32.const 0xFFFF)) (i32.const 16))))

  (func (export "test_civ16_dynamic_module") (param $which i32) (result i32)
    (local $p i32)
    (if (i32.eqz (local.get $which)) (then (call $win16_dynamic_modules_reset)))
    (local.set $p (i32.add (call $g2w (i32.const 0x00110300))
      (i32.mul (local.get $which) (i32.const 16))))
    (i32.store8 (local.get $p) (i32.const 2))
    (i32.store8 offset=1 (local.get $p) (i32.const 77)) ;; M
    (i32.store8 offset=2 (local.get $p) (i32.add (i32.const 48) (local.get $which)))
    (call $win16_dynamic_module_id (local.get $p)))

  (func (export "test_civ16_toolhelp_first") (result i32)
    (local $name i32) (local $module i32)
    (call $test_civ16_setup)
    (call $win16_dynamic_modules_reset)
    (local.set $name (call $g2w (i32.const 0x00110500)))
    (i32.store8 (local.get $name) (i32.const 8))
    (i64.store offset=1 (local.get $name) (i64.const 0x504C45484C4F4F54))
    (local.set $module (call $win16_dynamic_module_id (local.get $name)))
    (call $gs32 (i32.const 0x00110300) (i32.const 20))
    ;; A far stack frame for StackTraceNext to walk after the first result.
    (call $gs16 (i32.const 0x00110400) (i32.const 0x0420))
    (call $gs16 (i32.const 0x00110402) (i32.const 0x5678))
    (call $gs16 (i32.const 0x00110404) (call $win16_index_to_sel (i32.const 1)))
    (global.set $esp (i32.const 0x00110100))
    (call $gs16 (i32.const 0x00110100) (i32.const 0x0010))
    (call $gs16 (i32.const 0x00110102) (call $win16_index_to_sel (i32.const 1)))
    ;; Pascal rightmost first: BP, IP, CS, SS, then the output far pointer.
    (call $gs16 (i32.const 0x00110104) (i32.const 0x0400))
    (call $gs16 (i32.const 0x00110106) (i32.const 0x1234))
    (call $gs16 (i32.const 0x00110108) (call $win16_index_to_sel (i32.const 1)))
    (call $gs16 (i32.const 0x0011010A) (call $win16_index_to_sel (i32.const 2)))
    (call $gs16 (i32.const 0x0011010C) (i32.const 0x0300))
    (call $gs16 (i32.const 0x0011010E) (call $win16_index_to_sel (i32.const 2)))
    (drop (call $win16_toolhelp (local.get $module) (i32.const 67)))
    (global.get $eax))

  (func (export "test_civ16_toolhelp_module") (result i32)
    (call $test_civ16_setup)
    (call $gs32 (i32.const 0x00110300) (i32.const 276))
    (global.set $esp (i32.const 0x00110100))
    (call $gs16 (i32.const 0x00110100) (i32.const 0x0010))
    (call $gs16 (i32.const 0x00110102) (call $win16_index_to_sel (i32.const 1)))
    ;; Pascal rightmost first: hModule, then the output far pointer.
    (call $gs16 (i32.const 0x00110104) (call $win16_index_to_sel (i32.const 2)))
    (call $gs16 (i32.const 0x00110106) (i32.const 0x0300))
    (call $gs16 (i32.const 0x00110108) (call $win16_index_to_sel (i32.const 2)))
    (drop (call $win16_toolhelp (i32.const 13) (i32.const 62)))
    (global.get $eax))

  (func (export "test_civ16_toolhelp_byte") (param $offset i32) (result i32)
    (call $gl8 (i32.add (i32.const 0x00110300) (local.get $offset))))

  (func (export "test_civ16_toolhelp_memman") (result i32)
    (call $test_civ16_setup)
    (call $gs32 (i32.const 0x00110300) (i32.const 42))
    (global.set $esp (i32.const 0x00110100))
    (call $gs16 (i32.const 0x00110100) (i32.const 0x0010))
    (call $gs16 (i32.const 0x00110102) (call $win16_index_to_sel (i32.const 1)))
    (call $gs16 (i32.const 0x00110104) (i32.const 0x0300))
    (call $gs16 (i32.const 0x00110106) (call $win16_index_to_sel (i32.const 2)))
    (drop (call $win16_toolhelp (i32.const 13) (i32.const 72)))
    (global.get $eax))

  (func (export "test_civ16_toolhelp_next") (result i32)
    (global.set $esp (i32.const 0x00110100))
    (call $gs16 (i32.const 0x00110100) (i32.const 0x0010))
    (call $gs16 (i32.const 0x00110102) (call $win16_index_to_sel (i32.const 1)))
    (call $gs16 (i32.const 0x00110104) (i32.const 0x0300))
    (call $gs16 (i32.const 0x00110106) (call $win16_index_to_sel (i32.const 2)))
    (drop (call $win16_toolhelp (i32.const 13) (i32.const 68)))
    (global.get $eax))

  (func (export "test_civ16_toolhelp_word") (param $offset i32) (result i32)
    (call $gl16 (i32.add (i32.const 0x00110300) (local.get $offset))))

  (func (export "test_civ16_hmemcpy") (result i32)
    (call $test_civ16_setup)
    (call $win16_seg_set (i32.const 3) (i32.const 0x00120000)
      (i32.const 0x10000) (i32.const 0) (i32.const 3))
    (call $gs8 (i32.const 0x00110300) (i32.const 0x11))
    (call $gs8 (i32.const 0x00110301) (i32.const 0x22))
    (call $gs8 (i32.const 0x00110302) (i32.const 0x33))
    (call $gs8 (i32.const 0x00110303) (i32.const 0x44))
    (call $gs8 (i32.const 0x00110304) (i32.const 0x55))
    (global.set $esp (i32.const 0x00110100))
    (call $gs16 (i32.const 0x00110100) (i32.const 0x0010))
    (call $gs16 (i32.const 0x00110102) (call $win16_index_to_sel (i32.const 1)))
    ;; Pascal rightmost argument first: DWORD count, src far, dst far.
    (call $gs16 (i32.const 0x00110104) (i32.const 5))
    (call $gs16 (i32.const 0x00110106) (i32.const 0))
    (call $gs16 (i32.const 0x00110108) (i32.const 0x0300))
    (call $gs16 (i32.const 0x0011010A) (call $win16_index_to_sel (i32.const 2)))
    (call $gs16 (i32.const 0x0011010C) (i32.const 0x0400))
    (call $gs16 (i32.const 0x0011010E) (call $win16_index_to_sel (i32.const 3)))
    (call $win16_hmemcpy)
    (global.get $esp))

  (func (export "test_civ16_hmemcpy_byte") (param $index i32) (result i32)
    (call $gl8 (i32.add (i32.const 0x00120400) (local.get $index))))

  (func (export "test_civ16_text_extent_point") (result i32)
    (local $hdc i32)
    (call $test_civ16_setup)
    ;; GetDC(NULL) supplies a real shared GDI DC and its Win16 handle mapping.
    (global.set $esp (i32.const 0x00110100))
    (call $gs16 (i32.const 0x00110100) (i32.const 0x0010))
    (call $gs16 (i32.const 0x00110102) (call $win16_index_to_sel (i32.const 1)))
    (call $gs16 (i32.const 0x00110104) (i32.const 0))
    (call $win16_GetDC)
    (local.set $hdc (global.get $eax))
    (call $gs8 (i32.const 0x00110500) (i32.const 0x43)) ;; C
    (call $gs8 (i32.const 0x00110501) (i32.const 0x69)) ;; i
    (call $gs8 (i32.const 0x00110502) (i32.const 0x76)) ;; v
    (call $gs8 (i32.const 0x00110503) (i32.const 0))
    (call $gs16 (i32.const 0x00110600) (i32.const 0xDEAD))
    (call $gs16 (i32.const 0x00110602) (i32.const 0xBEEF))
    (global.set $esp (i32.const 0x00110100))
    (call $gs16 (i32.const 0x00110100) (i32.const 0x0010))
    (call $gs16 (i32.const 0x00110102) (call $win16_index_to_sel (i32.const 1)))
    ;; Pascal rightmost first: lpSize, count, lpString, hDC.
    (call $gs16 (i32.const 0x00110104) (i32.const 0x0600))
    (call $gs16 (i32.const 0x00110106) (call $win16_index_to_sel (i32.const 2)))
    (call $gs16 (i32.const 0x00110108) (i32.const 3))
    (call $gs16 (i32.const 0x0011010A) (i32.const 0x0500))
    (call $gs16 (i32.const 0x0011010C) (call $win16_index_to_sel (i32.const 2)))
    (call $gs16 (i32.const 0x0011010E) (local.get $hdc))
    (drop (call $win16_gdi (i32.const 471)))
    (global.get $eax))
  (func (export "test_civ16_text_extent_word") (param $offset i32) (result i32)
    (call $gl16 (i32.add (i32.const 0x00110600) (local.get $offset))))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({
    extraWat,
    fonts: 'bitmap',
    extraHostOverrides: { get_ticks: () => 0x12345678 },
  });

  assert.strictEqual(e.test_civ16_module_filename(), 10);
  const filename = Array.from({ length: 10 }, (_, i) =>
    String.fromCharCode(e.test_civ16_filename_byte(i))).join('');
  assert.strictEqual(filename, 'C:\\app.exe',
    'a live task selector should resolve to the current executable without handle-table lookup');
  assert.strictEqual(e.test_civ16_filename_byte(10), 0);

  assert.strictEqual(e.test_civ16_mmsystem(605, 2), 0,
    'timeBeginPeriod should accept the Win16 timer-resolution request');
  assert.strictEqual(e.test_civ16_mmsystem(606, 2), 0,
    'timeEndPeriod should balance it successfully');
  assert.strictEqual(e.test_civ16_mmsystem(607, 0) >>> 0, 0x12345678,
    'timeGetTime should preserve the full DWORD in DX:AX');

  assert.strictEqual(e.test_civ16_toolhelp_first(), 1,
    'TOOLHELP.67 should begin the documented active-task stack walk');
  assert.deepStrictEqual([6, 8, 10, 12, 16, 18].map(offset =>
    e.test_civ16_toolhelp_word(offset)), [0x17, 0x0400, 0x0f, 0x1234, 1, 0],
  'StackTraceCSIPFirst should fill SS:BP, CS:IP, segment, and FRAME_FAR');
  assert.strictEqual(e.test_civ16_toolhelp_next(), 1,
    'TOOLHELP.68 should advance through the caller far frame');
  assert.deepStrictEqual([8, 10, 12].map(offset =>
    e.test_civ16_toolhelp_word(offset)), [0x0420, 0x0f, 0x5678],
  'StackTraceNext should expose the caller BP and CS:IP');

  assert.strictEqual(e.test_civ16_toolhelp_module(), 0x17,
    'TOOLHELP.62 should return the requested live module handle');
  const moduleName = Array.from({ length: 3 }, (_, i) =>
    String.fromCharCode(e.test_civ16_toolhelp_byte(4 + i))).join('');
  const modulePath = Array.from({ length: 10 }, (_, i) =>
    String.fromCharCode(e.test_civ16_toolhelp_byte(18 + i))).join('');
  assert.strictEqual(moduleName, 'APP',
    'ModuleFindHandle should fill the SDK module-name field');
  assert.strictEqual(modulePath, 'C:\\app.exe',
    'ModuleFindHandle should fill the SDK executable-path field');
  assert.deepStrictEqual([14, 16, 274].map(offset =>
    e.test_civ16_toolhelp_word(offset)), [0x17, 1, 0],
  'ModuleFindHandle should fill hModule, usage, and the walk cursor');
  assert.strictEqual(e.test_civ16_toolhelp_memman(), 1,
    'TOOLHELP.72 should fill the documented memory-manager structure');
  assert.deepStrictEqual([0, 4, 16, 28, 32, 40].map(offset =>
    offset === 40
      ? e.test_civ16_toolhelp_word(offset)
      : (e.test_civ16_toolhelp_word(offset) |
         (e.test_civ16_toolhelp_word(offset + 2) << 16)) >>> 0),
  [42, 0x01000000, 0x08000000, 0x00008000, 0x04000000, 4096],
  'MemManInfo should report coherent byte, page-count, and page-size fields');

  for (let i = 0; i < 24; i++) {
    assert.strictEqual(e.test_civ16_dynamic_module(i), 13 + i,
      `app-local Win16 module ${i + 1} should receive its own id`);
  }
  assert.strictEqual(e.test_civ16_dynamic_module(24), 0,
    'the dynamic module registry has room for Civ II artwork DLLs');

  assert.strictEqual(e.test_civ16_hmemcpy() >>> 0, 0x00110110,
    'hmemcpy should pop its 12 Pascal argument bytes and far return');
  assert.deepStrictEqual(Array.from({ length: 5 }, (_, i) => e.test_civ16_hmemcpy_byte(i)),
    [0x11, 0x22, 0x33, 0x44, 0x55],
    'hmemcpy should copy the requested bytes between Win16 far selectors');

  const extent = e.test_civ16_text_extent_point() >>> 0;
  assert.strictEqual(extent, 1,
    'GDI.471 GetTextExtentPoint should report success');
  assert.notStrictEqual(e.test_civ16_text_extent_word(0), 0xDEAD,
    'GDI.471 should narrow cx into the Win16 SIZE');
  assert.notStrictEqual(e.test_civ16_text_extent_word(2), 0xBEEF,
    'GDI.471 should narrow cy into the Win16 SIZE');

  console.log('PASS Civ II Win16 selector, ToolHelp, timers, DLL capacity, hmemcpy, and text extent');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
