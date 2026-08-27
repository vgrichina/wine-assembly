#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_get_clipboard_sequence_number") (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GetClipboardSequenceNumber
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const first = e.test_get_clipboard_sequence_number();
  const second = e.test_get_clipboard_sequence_number();
  assert.strictEqual(Number(first & 0xffffffffn), 1, 'generation is nonzero');
  assert.strictEqual(first, second, 'generation remains stable without a host bridge');
  assert.strictEqual(Number(first >> 32n), 0x00300004,
    'zero-argument stdcall pops only the thunk return address');
  console.log('PASS clipboard polling exposes one stable process generation');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
