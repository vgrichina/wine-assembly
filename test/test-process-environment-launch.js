#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
const { setEnvironmentVariable } = require('../lib/process-boot');

const extraWat = String.raw`
  (func (export "test_launch_env_len") (result i32) (global.get $launch_env_len))
  (func (export "test_env_block") (result i32) (global.get $env_block))
  (func (export "test_zero_image_base") (global.set $image_base (i32.const 0)))
  (func (export "test_get_environment_a")
      (param $name i32) (param $buffer i32) (param $size i32) (result i32)
    (global.set $image_base (i32.const 0))
    (call $env_get (local.get $name) (local.get $buffer) (local.get $size) (i32.const 0)))
`;

(async () => {
  const { exports: wat, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
  assert(setEnvironmentVariable(wat, memory.buffer, 'SDL_RENDER_DRIVER', 'software'));
  assert.strictEqual(wat.test_launch_env_len(), 27);
  assert.strictEqual(wat.test_env_block(), 0, 'environment remains lazy before first query');

  const name = 0x2600;
  const buffer = 0x2700;
  const bytes = new TextEncoder().encode('SDL_RENDER_DRIVER\0');
  wat.test_zero_image_base();
  bytes.forEach((value, index) => wat.guest_write8(name + index, value));
  const result = wat.test_get_environment_a(name, buffer, 32);
  if (result !== 8) {
    const env = [];
    const envBlock = wat.test_env_block();
    for (let i = 0, zeros = 0; i < 512 && zeros < 2; i++) {
      const ch = wat.guest_read8(envBlock + i);
      env.push(ch);
      zeros = ch ? 0 : zeros + 1;
    }
    throw new Error(`launch environment lookup returned ${result}: ${Buffer.from(env).toString('latin1').replace(/\0/g, '|')}`);
  }
  const value = Buffer.from(Array.from({ length: 9 }, (_, index) => wat.guest_read8(buffer + index)))
    .toString('latin1').replace(/\0.*$/, '');
  assert.strictEqual(value, 'software');
  console.log('PASS per-process launch environment is merged lazily');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
