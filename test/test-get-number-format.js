#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_call_GetNumberFormatA")
    (param $value i32) (param $format i32) (param $out i32) (param $cch i32)
    (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (global.set $esp (i32.const 0x07000000))
    (call $gs32 (i32.const 0x07000018) (local.get $cch))
    (call $handle_GetNumberFormatA
      (i32.const 0x400) (i32.const 0x80000000)
      (local.get $value) (local.get $format) (local.get $out) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat });
  const u8 = new Uint8Array(memory.buffer);
  const wa = guest => guest - e.get_image_base() + e.get_guest_base();

  function writeAscii(text) {
    const guest = e.guest_alloc(text.length + 1) >>> 0;
    const ptr = wa(guest);
    for (let i = 0; i < text.length; i++) u8[ptr + i] = text.charCodeAt(i);
    u8[ptr + text.length] = 0;
    return guest;
  }

  function readAscii(guest) {
    let text = '';
    for (let ptr = wa(guest); u8[ptr]; ptr++) text += String.fromCharCode(u8[ptr]);
    return text;
  }

  const value = writeAscii('2.00');
  const out = e.guest_alloc(16) >>> 0;
  assert.strictEqual(e.test_call_GetNumberFormatA(value, 0, 0, 0), 5,
    'size query includes the terminator');
  assert.strictEqual(e.test_call_GetNumberFormatA(value, 0, out, 16), 5);
  assert.strictEqual(readAscii(out), '2.00',
    'Win98 default locale preserves the installer decimal spelling');

  e.guest_write8(out, 0x58);
  assert.strictEqual(e.test_call_GetNumberFormatA(value, 0, out, 4), 0);
  assert.strictEqual(e.guest_read8(out), 0x58, 'short destination is untouched');
  assert.strictEqual(e.test_call_GetLastError(), 122);

  const customFormat = e.guest_alloc(24) >>> 0;
  assert.strictEqual(e.test_call_GetNumberFormatA(value, customFormat, out, 16), 0,
    'unsupported custom regrouping fails explicitly');
  assert.strictEqual(e.test_call_GetLastError(), 120);

  console.log('PASS  GetNumberFormatA default locale size and bounded copy contract');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
