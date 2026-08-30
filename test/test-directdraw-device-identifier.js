#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_device_identifier") (param $out i32) (result i32)
    (global.set $esp (i32.const 0x00430000))
    (call $handle_IDirectDraw4_GetDeviceIdentifier
      (i32.const 0) (local.get $out) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_device_identifier_esp") (result i32) (global.get $esp))
`;

function cString(wat, address, limit) {
  const bytes = [];
  for (let i = 0; i < limit; i++) {
    const value = wat.guest_read8(address + i);
    if (!value) break;
    bytes.push(value);
  }
  return Buffer.from(bytes).toString('ascii');
}

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const out = 0x00440000;
  for (let i = 0; i < 560; i++) wat.guest_write8(out + i, 0xa5);

  assert.strictEqual(wat.test_device_identifier(out) >>> 0, 0,
    'IDirectDraw4 GetDeviceIdentifier succeeds');
  assert.strictEqual(cString(wat, out, 260), 'wine-assembly');
  assert.strictEqual(cString(wat, out + 260, 260), 'Wine Assembly DirectDraw');
  assert.strictEqual(wat.guest_read32(out + 556) >>> 0, 0,
    'the complete DX6 structure is initialized');
  assert.strictEqual(wat.test_device_identifier_esp() >>> 0, 0x00430010,
    'GetDeviceIdentifier uses the three-argument stdcall ABI');

  assert.strictEqual(wat.test_device_identifier(0) >>> 0, 0x80070057,
    'a NULL output receives E_INVALIDARG');
  console.log('PASS  IDirectDraw4 exposes an ABI-correct DX6 device identity');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
