#!/usr/bin/env node

'use strict';

const assert = require('assert');
const apiTable = require('../src/api_table.json');
const { bootRenderHarness } = require('./render-helper');

const extraWat = `
  (func (export "test_open_mutex_w") (param $name i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_OpenMutexW
      (i32.const 0x00100000) (i32.const 0) (local.get $name)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_last_error") (result i32)
    (global.get $last_error))
`;

(async () => {
  assert.strictEqual(apiTable.find(entry => entry.name === 'OpenMutexW').nargs, 3,
    'OpenMutexW is available to Unicode import callers');
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const name = wat.guest_alloc(8) >>> 0;

  assert.strictEqual(wat.test_open_mutex_w(name), 0,
    'no process-external named mutex is present');
  assert.strictEqual(wat.test_last_error(), 2,
    'OpenMutexW reports ERROR_FILE_NOT_FOUND');

  console.log('PASS OpenMutexW reports a missing process-local named mutex');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
