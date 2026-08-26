#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_get_environment_variable_w") (param $name i32) (param $buf i32) (param $size i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GetEnvironmentVariableW
      (local.get $name) (local.get $buf) (local.get $size)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const name = 0x2600;
  const buffer = 0x2700;
  const writeWide = (address, value) => {
    for (let i = 0; i <= value.length; i++) {
      const code = i < value.length ? value.charCodeAt(i) : 0;
      wat.guest_write8(address + i * 2, code & 0xff);
      wat.guest_write8(address + i * 2 + 1, code >>> 8);
    }
  };
  const readWide = address => {
    let value = '';
    for (let i = 0; ; i++) {
      const code = wat.guest_read8(address + i * 2) |
        (wat.guest_read8(address + i * 2 + 1) << 8);
      if (!code) return value;
      value += String.fromCharCode(code);
    }
  };

  writeWide(name, 'windir');
  assert.strictEqual(wat.test_get_environment_variable_w(name, buffer, 11), 10,
    'success returns characters excluding NUL');
  assert.strictEqual(readWide(buffer), 'C:\\WINDOWS', 'value is widened into caller buffer');
  assert.strictEqual(wat.get_esp(), 0x00300010,
    'three-argument stdcall pops return address plus arguments');
  assert.strictEqual(wat.test_get_environment_variable_w(name, 0, 0), 11,
    'size query returns required characters including NUL');

  writeWide(name, 'DOES_NOT_EXIST');
  assert.strictEqual(wat.test_get_environment_variable_w(name, buffer, 32), 0,
    'unknown variable returns zero');

  console.log('PASS GetEnvironmentVariableW shares and widens the process environment');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
