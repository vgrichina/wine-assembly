#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_call_SHChangeNotify")
    (param $event i32) (param $flags i32) (param $item1 i32) (param $item2 i32)
    (result i32)
    (global.set $esp (i32.const 0x07000000))
    (call $handle_SHChangeNotify
      (local.get $event) (local.get $flags) (local.get $item1)
      (local.get $item2) (i32.const 0) (i32.const 0))
    (global.get $esp))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat });

  assert.strictEqual(
    e.test_call_SHChangeNotify(0x00000008, 0x00001001, 0x00402000, 0),
    0x07000014,
    'SHCNE_MKDIR with SHCNF_PATHA|SHCNF_FLUSH completes its four-argument stdcall frame');

  console.log('PASS  SHChangeNotify completes synchronously when no shell listeners exist');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
