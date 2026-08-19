#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
const apiTable = require('../src/api_table.json');

const extraWat = `
  (func (export "test_call_CoInitializeEx") (param $stack i32) (result i32)
    (global.set $esp (local.get $stack))
    (call $handle_CoInitializeEx
      (i32.const 0) (i32.const 2) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $esp))
`;

(async () => {
  assert.strictEqual(apiTable.find(api => api.name === 'CoInitializeEx').nargs, 2,
    'CoInitializeEx is available to dynamic GetProcAddress callers');
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const stack = 0x074ff000;

  assert.strictEqual(wat.test_call_CoInitializeEx(stack) >>> 0, stack + 12,
    'CoInitializeEx pops two stdcall arguments and its return address');
  assert.strictEqual(wat.get_eax(), 0, 'CoInitializeEx reports S_OK');

  console.log('PASS  CoInitializeEx exposes the static OLE32 initialization path');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
