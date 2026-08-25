#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_map_view_of_file_ex") (param $base i32) (result i64)
    (global.set $esp (i32.const 0x00300000))
    ;; Sixth stdcall argument lives beyond the five dispatcher locals.
    (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (local.get $base))
    (call $handle_MapViewOfFileEx
      (i32.const 0xfb000002) (i32.const 2) (i32.const 3)
      (i32.const 4) (i32.const 0x16c) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

(async () => {
  const calls = [];
  const { exports: wat } = await bootRenderHarness({
    extraWat,
    extraHostOverrides: {
      fs_map_view_of_file: (...args) => {
        calls.push(args);
        return 0x12345000;
      },
    },
  });

  const automatic = wat.test_map_view_of_file_ex(0);
  assert.strictEqual(Number(automatic & 0xffffffffn), 0x12345000);
  assert.strictEqual(Number(automatic >> 32n), 0x0030001c,
    'MapViewOfFileEx pops its return address and six stdcall arguments');
  assert.deepStrictEqual(calls, [[0xfb000002 | 0, 2, 3, 4, 0x16c]],
    'a NULL preferred address delegates all mapping fields to MapViewOfFile');

  const fixed = wat.test_map_view_of_file_ex(0x22000000);
  assert.strictEqual(Number(fixed & 0xffffffffn), 0,
    'unsupported fixed placement fails instead of returning the wrong address');
  assert.strictEqual(calls.length, 1,
    'fixed placement does not create an unwanted view at an arbitrary address');

  console.log('PASS  MapViewOfFileEx maps NULL-base views and rejects unsupported fixed placement');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
