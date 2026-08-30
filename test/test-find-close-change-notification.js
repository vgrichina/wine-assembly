#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_find_close_change_notification") (param $handle i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (global.set $last_error (i32.const 0))
    (call $handle_FindCloseChangeNotification (local.get $handle)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_last_error") (result i32) (global.get $last_error))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  assert.strictEqual(wat.test_find_close_change_notification(-1), 0,
    'INVALID_HANDLE_VALUE is not a valid change-notification handle');
  assert.strictEqual(wat.test_last_error(), 6,
    'invalid notification close reports ERROR_INVALID_HANDLE');
  assert.strictEqual(wat.get_esp(), 0x00300008,
    'one-argument API has the correct stdcall cleanup');
  console.log('PASS  FindCloseChangeNotification rejects an invalid Win32 notification handle');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
