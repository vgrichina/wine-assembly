#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_expand_environment_a")
    (param $src i32) (param $dst i32) (param $size i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_ExpandEnvironmentStringsA
      (local.get $src) (local.get $dst) (local.get $size)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const src = 0x2600;
  const dst = 0x2800;

  const writeAscii = (ptr, value) => {
    for (let i = 0; i < value.length; i++) wat.guest_write8(ptr + i, value.charCodeAt(i));
    wat.guest_write8(ptr + value.length, 0);
  };
  const readAscii = ptr => {
    let out = '';
    for (let i = 0; i < 1024; i++) {
      const ch = wat.guest_read8(ptr + i);
      if (!ch) return out;
      out += String.fromCharCode(ch);
    }
    throw new Error('unterminated guest string');
  };

  const input = '%windir%\\SYSTEM;%DOES_NOT_EXIST%;tail%';
  const expected = 'C:\\WINDOWS\\SYSTEM;%DOES_NOT_EXIST%;tail%';
  writeAscii(src, input);

  const required = wat.test_expand_environment_a(src, 0, 0);
  assert.strictEqual(required, expected.length + 1,
    'size query includes the terminating NUL');

  wat.guest_write8(dst, 0x5a);
  assert.strictEqual(wat.test_expand_environment_a(src, dst, required - 1), required,
    'short destination reports the required size');
  assert.strictEqual(wat.guest_read8(dst), 0x5a,
    'short destination is not exposed as a partial expansion');

  assert.strictEqual(wat.test_expand_environment_a(src, dst, required), required);
  assert.strictEqual(readAscii(dst), expected,
    'known variables expand case-insensitively while unknown/unmatched tokens remain literal');

  writeAscii(src, '%PATH%');
  assert.strictEqual(wat.test_expand_environment_a(src, src, 128),
    'C:\\WINDOWS;C:\\WINDOWS\\COMMAND'.length + 1);
  assert.strictEqual(readAscii(src), 'C:\\WINDOWS;C:\\WINDOWS\\COMMAND',
    'source and destination may alias');

  console.log('PASS  ExpandEnvironmentStringsA expands, sizes, and preserves ANSI tokens');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
