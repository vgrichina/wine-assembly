#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (global $test_icon_group (mut i32) (i32.const 0))
  (func $put_group_icon_entry (param $p i32) (param $w i32) (param $h i32)
      (param $bpp i32) (param $id i32)
    (call $gs8 (local.get $p) (local.get $w))
    (call $gs8 (i32.add (local.get $p) (i32.const 1)) (local.get $h))
    (call $gs8 (i32.add (local.get $p) (i32.const 2)) (i32.const 0))
    (call $gs8 (i32.add (local.get $p) (i32.const 3)) (i32.const 0))
    (call $gs16 (i32.add (local.get $p) (i32.const 4)) (i32.const 1))
    (call $gs16 (i32.add (local.get $p) (i32.const 6)) (local.get $bpp))
    (call $gs32 (i32.add (local.get $p) (i32.const 8)) (i32.const 1024))
    (call $gs16 (i32.add (local.get $p) (i32.const 12)) (local.get $id)))

  (func (export "test_lookup_icon_id") (result i64)
    (local $p i32)
    (local.set $p (call $heap_alloc (i32.const 64)))
    (global.set $test_icon_group (local.get $p))
    (call $gs16 (local.get $p) (i32.const 0))
    (call $gs16 (i32.add (local.get $p) (i32.const 2)) (i32.const 1))
    (call $gs16 (i32.add (local.get $p) (i32.const 4)) (i32.const 4))
    (call $put_group_icon_entry (i32.add (local.get $p) (i32.const 6))
      (i32.const 16) (i32.const 16) (i32.const 8) (i32.const 11))
    (call $put_group_icon_entry (i32.add (local.get $p) (i32.const 20))
      (i32.const 32) (i32.const 32) (i32.const 4) (i32.const 22))
    (call $put_group_icon_entry (i32.add (local.get $p) (i32.const 34))
      (i32.const 48) (i32.const 48) (i32.const 32) (i32.const 33))
    (call $put_group_icon_entry (i32.add (local.get $p) (i32.const 48))
      (i32.const 32) (i32.const 32) (i32.const 32) (i32.const 44))
    (global.set $esp (i32.const 0x00421000))
    (call $handle_LookupIconIdFromDirectoryEx
      (local.get $p) (i32.const 1) (i32.const 32) (i32.const 32)
      (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
  (func (export "test_lookup_icon_header") (result i32)
    (call $gl32 (global.get $test_icon_group)))
  (func (export "test_lookup_icon_count") (result i32)
    (call $gl16 (i32.add (global.get $test_icon_group) (i32.const 4))))
  (func (export "test_lookup_icon_last_id") (result i32)
    (call $gl16 (i32.add (global.get $test_icon_group) (i32.const 60))))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const result = wat.test_lookup_icon_id();
  assert.strictEqual(wat.test_lookup_icon_header(), 0x00010000,
    'the packed GRPICONDIR header is visible through guest memory translation');
  assert.strictEqual(wat.test_lookup_icon_count(), 4);
  assert.strictEqual(wat.test_lookup_icon_last_id(), 44);
  assert.strictEqual(Number(result & 0xffffffffn), 44,
    'an exact-size icon wins, with the highest bit depth breaking ties');
  assert.strictEqual(Number(result >> 32n), 0x00421018,
    'LookupIconIdFromDirectoryEx pops five stdcall arguments and its return address');
  console.log('PASS  LookupIconIdFromDirectoryEx selects the closest group-icon resource');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
