#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_create_directory_a") (param $path i32) (result i64)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_CreateDirectoryA (local.get $path) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $last_error)) (i64.const 32))))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const writeAscii = (ptr, value) => {
    [...value].forEach((ch, i) => wat.guest_write8(ptr + i, ch.charCodeAt(0)));
    wat.guest_write8(ptr + value.length, 0);
  };
  const path = 0x2600;
  writeAscii(path, 'C:\\Program Files');
  const existing = wat.test_create_directory_a(path);
  assert.strictEqual(Number(existing & 0xffffffffn), 0,
    'CreateDirectory fails when the directory already exists');
  assert.strictEqual(Number(existing >> 32n), 183,
    'an existing directory sets ERROR_ALREADY_EXISTS');

  writeAscii(path, 'C:\\Starcraft Setup Test');
  const created = wat.test_create_directory_a(path);
  assert.strictEqual(Number(created & 0xffffffffn), 1);
  assert.strictEqual(Number(created >> 32n), 0);
  console.log('PASS  CreateDirectory preserves Win32 success and last-error contracts');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
