#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (global $test_win16_icon (mut i32) (i32.const 0))
  (global $test_win16_hicon (mut i32) (i32.const 0))

  (func $test_win16_destroy_setup
    (call $win16_seg_set (i32.const 1) (i32.const 0x00100000)
      (i32.const 0x10000) (i32.const 0) (i32.const 1))
    (call $win16_seg_set (i32.const 2) (i32.const 0x00110000)
      (i32.const 0x10000) (i32.const 1) (i32.const 2))
    (global.set $code16 (i32.const 1))
    (global.set $sreg_cs (call $win16_index_to_sel (i32.const 1)))
    (global.set $seg_base_cs (i32.const 0x00100000))
    (global.set $sreg_ss (call $win16_index_to_sel (i32.const 2)))
    (global.set $seg_base_ss (i32.const 0x00110000))
    (global.set $esp (i32.const 0x00110100))
    ;; Far return followed by DestroyIcon's one-word Pascal argument.
    (call $gs16 (i32.const 0x00110100) (i32.const 0x004d))
    (call $gs16 (i32.const 0x00110102) (call $win16_index_to_sel (i32.const 1)))
    (call $gs16 (i32.const 0x00110104) (global.get $test_win16_hicon)))

  (func (export "test_win16_destroy_shared") (result i32)
    (global.set $test_win16_icon
      (call $icon_intern
        (i32.or (global.get $ICON_FROM_WIN16) (i32.const 1))
        (i32.const 42)))
    (global.set $test_win16_hicon (call $win16_h16 (global.get $test_win16_icon)))
    (call $test_win16_destroy_setup)
    (drop (call $win16_user (i32.const 457)))
    (global.get $eax))

  (func (export "test_win16_destroy_private") (result i32)
    (global.set $test_win16_icon
      (call $icon_private_slot (global.get $ICON_FROM_OPAQUE) (i32.const 77)))
    (global.set $test_win16_hicon (call $win16_h16 (global.get $test_win16_icon)))
    (call $test_win16_destroy_setup)
    (drop (call $win16_user (i32.const 457)))
    (global.get $eax))

  (func (export "test_win16_destroy_esp") (result i32) (global.get $esp))
  (func (export "test_win16_destroy_eip") (result i32) (global.get $eip))
  (func (export "test_win16_destroy_icon_live") (result i32)
    (i32.ne (call $icon_table_record (global.get $test_win16_icon)) (i32.const 0)))
  (func (export "test_win16_destroy_mapping") (result i32)
    (call $win16_h32 (global.get $test_win16_hicon)))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat });

  assert.strictEqual(e.test_win16_destroy_shared(), 1,
    'USER.457 reports success for a loaded shared icon');
  assert.strictEqual(e.test_win16_destroy_icon_live(), 1,
    'DestroyIcon keeps a loaded shared icon live');
  assert.notStrictEqual(e.test_win16_destroy_mapping(), 0,
    'DestroyIcon keeps the shared icon handle mapping');
  assert.strictEqual(e.test_win16_destroy_esp(), 0x00110106,
    'DestroyIcon removes its far return and Pascal argument');
  assert.strictEqual(e.test_win16_destroy_eip(), 0x0010004d,
    'DestroyIcon returns to its Win16 caller');

  assert.strictEqual(e.test_win16_destroy_private(), 1,
    'USER.457 reports success for a private icon');
  assert.strictEqual(e.test_win16_destroy_icon_live(), 0,
    'DestroyIcon releases a private icon-table slot');
  assert.strictEqual(e.test_win16_destroy_mapping(), 0,
    'DestroyIcon releases a private Win16 handle mapping');

  console.log('PASS  Win16 USER.457 DestroyIcon preserves shared icons and releases private icons');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
