#!/usr/bin/env node

'use strict';

const assert = require('assert');
const apiTable = require('../src/api_table.json');
const { bootRenderHarness } = require('./render-helper');

const extraWat = `
  (func (export "test_directx_setup") (param $stack i32) (result i32)
    (global.set $esp (local.get $stack))
    (call $handle_DirectXSetup
      (i32.const 0x00010001) (i32.const 0x00420270) (i32.const 0x0000023f)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $esp))
`;

(async () => {
  const api = apiTable.find(entry => entry.name === 'DirectXSetup');
  assert(api, 'DirectXSetup must resolve from the legacy DSETUP import');
  assert.strictEqual(api.nargs, 3, 'DirectXSetup has three stdcall arguments');

  const { exports: wat } = await bootRenderHarness({ extraWat });
  const stack = 0x074ff000;
  assert.strictEqual(wat.test_directx_setup(stack) >>> 0, stack + 16,
    'DirectXSetup pops its three arguments and return address');
  assert.strictEqual(wat.get_eax(), 0,
    'the already-provided DirectX runtime reports DSETUPERR_SUCCESS');

  console.log('PASS  DirectXSetup reports the installed runtime and cleans up stdcall');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
