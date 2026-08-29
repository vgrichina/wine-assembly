#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_dplobby_compound_address")
      (param $elements i32) (param $count i32) (param $address i32)
      (param $size i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectPlayLobby2_CreateCompoundAddress
      (i32.const 0) (local.get $elements) (local.get $count)
      (local.get $address) (local.get $size) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const elements = 0x410000;
  const firstData = 0x410100;
  const secondData = 0x410110;
  const size = 0x410200;
  const address = 0x410300;

  // Two 24-byte DPCOMPOUNDADDRESSELEMENT records.  Their GUID bytes are
  // represented by four dwords here; the handler must preserve all 16 bytes.
  for (let i = 0; i < 4; i++) wat.guest_write32(elements + i * 4, 0x11111111 + i);
  wat.guest_write32(elements + 16, 4);
  wat.guest_write32(elements + 20, firstData);
  wat.guest_write32(firstData, 0xA4A3A2A1);

  const second = elements + 24;
  for (let i = 0; i < 4; i++) wat.guest_write32(second + i * 4, 0x22222222 + i);
  wat.guest_write32(second + 16, 3);
  wat.guest_write32(second + 20, secondData);
  wat.guest_write8(secondData, 0xB1);
  wat.guest_write8(secondData + 1, 0xB2);
  wat.guest_write8(secondData + 2, 0xB3);

  const required = 20 + 4 + 20 + 3;
  wat.guest_write32(size, 0);
  assert.strictEqual(
    wat.test_dplobby_compound_address(elements, 2, 0, size) >>> 0,
    0x8877001E,
    'a null output buffer must request a sizing retry');
  assert.strictEqual(wat.guest_read32(size) >>> 0, required,
    'the sizing retry must publish the packed address byte count');

  wat.guest_write32(size, required - 1);
  assert.strictEqual(
    wat.test_dplobby_compound_address(elements, 2, address, size) >>> 0,
    0x8877001E,
    'an undersized output buffer must request a sizing retry');
  assert.strictEqual(wat.guest_read32(size) >>> 0, required);

  wat.guest_write32(size, required);
  assert.strictEqual(
    wat.test_dplobby_compound_address(elements, 2, address, size) >>> 0,
    0,
    'a sufficiently large buffer should receive the compound address');
  assert.strictEqual(wat.guest_read32(size) >>> 0, required);
  for (let i = 0; i < 4; i++) {
    assert.strictEqual(wat.guest_read32(address + i * 4) >>> 0, (0x11111111 + i) >>> 0);
  }
  assert.strictEqual(wat.guest_read32(address + 16) >>> 0, 4);
  assert.strictEqual(wat.guest_read32(address + 20) >>> 0, 0xA4A3A2A1);

  const packedSecond = address + 24;
  for (let i = 0; i < 4; i++) {
    assert.strictEqual(wat.guest_read32(packedSecond + i * 4) >>> 0, (0x22222222 + i) >>> 0);
  }
  assert.strictEqual(wat.guest_read32(packedSecond + 16) >>> 0, 3);
  assert.deepStrictEqual([
    wat.guest_read8(packedSecond + 20),
    wat.guest_read8(packedSecond + 21),
    wat.guest_read8(packedSecond + 22),
  ], [0xB1, 0xB2, 0xB3]);

  console.log('PASS  DirectPlayLobby2 compound addresses negotiate size and pack every element');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
