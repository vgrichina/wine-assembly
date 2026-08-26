#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_char_lower_w") (param $value i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_CharLowerW
      (local.get $value) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const buffer = 0x12600;
  const input = 'Setup_ÄZ';
  for (let i = 0; i <= input.length; i++) {
    const code = i < input.length ? input.charCodeAt(i) : 0;
    wat.guest_write8(buffer + i * 2, code & 0xff);
    wat.guest_write8(buffer + i * 2 + 1, code >>> 8);
  }

  assert.strictEqual(wat.test_char_lower_w(buffer), buffer, 'pointer form returns its input');
  let output = '';
  for (let i = 0; i < input.length; i++) {
    const code = wat.guest_read8(buffer + i * 2) |
      (wat.guest_read8(buffer + i * 2 + 1) << 8);
    output += String.fromCharCode(code);
  }
  assert.strictEqual(output, 'setup_Äz', 'ASCII capitals fold and other UTF-16 code units remain');
  assert.strictEqual(wat.test_char_lower_w('Q'.charCodeAt(0)), 'q'.charCodeAt(0),
    'single-character form folds the low WCHAR');
  assert.strictEqual(wat.get_esp(), 0x00300008,
    'one-argument stdcall pops return address plus argument');

  console.log('PASS CharLowerW pointer and single-character forms');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
