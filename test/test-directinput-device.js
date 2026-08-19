#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
const apiTable = require('../src/api_table.json');

const extraWat = `
  (func (export "test_call_IDirectInputDevice_EnumObjects") (param $stack i32) (result i32)
    (global.set $esp (local.get $stack))
    (call $handle_IDirectInputDevice_EnumObjects
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $esp))
`;

(async () => {
  assert.strictEqual(
    apiTable.find(api => api.name === 'IDirectInputDevice_EnumObjects').nargs,
    4,
    'EnumObjects metadata includes this + callback + ref + flags'
  );
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const stack = 0x074ff000;

  assert.strictEqual(
    wat.test_call_IDirectInputDevice_EnumObjects(stack) >>> 0,
    stack + 20,
    'IDirectInputDevice::EnumObjects must pop this + 3 parameters + return address'
  );
  assert.strictEqual(wat.get_eax(), 0, 'EnumObjects succeeds after enumerating no host devices');

  console.log('PASS  DirectInput EnumObjects preserves its caller return address');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
