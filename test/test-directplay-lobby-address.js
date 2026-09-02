#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
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

  (func (export "test_dplobby_enum_address")
      (param $callback i32) (param $address i32) (param $size i32)
      (param $context i32) (result i32)
    (global.set $eip (i32.const 0))
    (global.set $esp (i32.const 0x074FF000))
    (call $gs32 (global.get $esp) (i32.const 0))
    (call $handle_IDirectPlayLobby2_EnumAddress
      (i32.const 0) (local.get $callback) (local.get $address) (local.get $size)
      (local.get $context) (i32.const 0))
    (global.get $eip))

  (func (export "test_dplobby_enum_address_types")
      (param $callback i32) (param $provider i32) (param $context i32)
      (param $flags i32) (result i32)
    (global.set $eip (i32.const 0))
    (global.set $esp (i32.const 0x074FF000))
    (call $gs32 (global.get $esp) (i32.const 0))
    (call $handle_IDirectPlayLobby2_EnumAddressTypes
      (i32.const 0) (local.get $callback) (local.get $provider)
      (local.get $context) (local.get $flags) (i32.const 0))
    (global.get $eip))
`;

(async () => {
  const { exports: wat, memory } = await bootRenderHarness({ extraWat });
  const root = path.join(__dirname, '..');
  const exe = fs.readFileSync(path.join(root, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, wat.get_staging());
  assert(wat.load_pe(exe.length), 'PE load initializes callback continuation thunks');
  const imageBase = wat.get_image_base() >>> 0;
  const guestBase = wat.get_guest_base() >>> 0;
  const wa = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const elements = wat.guest_alloc(48) >>> 0;
  const firstData = wat.guest_alloc(4) >>> 0;
  const secondData = wat.guest_alloc(3) >>> 0;
  const size = wat.guest_alloc(4) >>> 0;
  const address = wat.guest_alloc(64) >>> 0;

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

  const u32 = value => [value, value >>> 8, value >>> 16, value >>> 24]
    .map(byte => byte & 0xff);
  const count = wat.guest_alloc(4) >>> 0;
  const makeCountingCallback = (result, popBytes) => {
    const callback = wat.guest_alloc(24) >>> 0;
    bytes.set(Uint8Array.from([
      0xa1, ...u32(count),             // mov eax,[count]
      0x40,                            // inc eax
      0xa3, ...u32(count),             // mov [count],eax
      0xb8, ...u32(result),            // mov eax,result
      0xc2, popBytes, 0x00,            // ret N
    ]), wa(callback));
    return callback;
  };
  const enumAddressContinue = makeCountingCallback(1, 16);
  const enumAddressCancel = makeCountingCallback(0, 16);
  const enumTypesContinue = makeCountingCallback(1, 12);
  const runCallback = (expectedResult = 0) => {
    for (let index = 0; index < 1000 && wat.get_eip(); index++) wat.run(1000);
    assert.strictEqual(wat.get_eip(), 0,
      'Lobby enumeration callback continuation restores the API caller');
    assert.strictEqual(wat.get_eax() >>> 0, expectedResult >>> 0,
      'Lobby enumeration publishes the final HRESULT');
    assert.strictEqual(wat.get_esp() >>> 0, 0x074ff018,
      'Lobby method and callback honor their stdcall frame sizes');
  };

  wat.guest_write32(count, 0);
  assert.strictEqual(
    wat.test_dplobby_enum_address(enumAddressContinue, address, required, 0x12345678)
      >>> 0,
    enumAddressContinue, 'EnumAddress enters the callback for the first chunk');
  let stack = wat.get_esp() >>> 0;
  assert.strictEqual(wat.guest_read32(stack + 4) >>> 0, address,
    'EnumAddress passes a pointer to the chunk GUID');
  assert.strictEqual(wat.guest_read32(stack + 8), 4,
    'EnumAddress passes the first chunk byte count');
  assert.strictEqual(wat.guest_read32(stack + 12) >>> 0, address + 20,
    'EnumAddress passes a pointer to the first chunk data');
  assert.strictEqual(wat.guest_read32(stack + 16) >>> 0, 0x12345678,
    'EnumAddress preserves caller context');
  runCallback();
  assert.strictEqual(wat.guest_read32(count), 2,
    'EnumAddress invokes one callback per packed chunk');

  wat.guest_write32(count, 0);
  assert.strictEqual(
    wat.test_dplobby_enum_address(enumAddressCancel, address, required, 0) >>> 0,
    enumAddressCancel, 'EnumAddress enters a cancelling callback');
  runCallback();
  assert.strictEqual(wat.guest_read32(count), 1,
    'FALSE cancels EnumAddress before the second chunk');

  wat.guest_write32(count, 0);
  assert.strictEqual(
    wat.test_dplobby_enum_address(enumAddressContinue, packedSecond, 23, 0) >>> 0,
    enumAddressContinue, 'EnumAddress accepts an address slice at a chunk boundary');
  stack = wat.get_esp() >>> 0;
  assert.strictEqual(wat.guest_read32(stack + 8), 3,
    'the sliced enumeration reports the second chunk size');
  assert.strictEqual(wat.guest_read32(stack + 12) >>> 0, packedSecond + 20,
    'the sliced enumeration reports the second chunk data');
  runCallback();
  assert.strictEqual(wat.guest_read32(count), 1);

  wat.guest_write32(count, 0);
  assert.strictEqual(
    wat.test_dplobby_enum_address(enumAddressContinue, address, required - 1, 0)
      >>> 0,
    enumAddressContinue, 'a truncated later chunk is detected after earlier callbacks');
  runCallback(0x80070057);
  assert.strictEqual(wat.guest_read32(count), 1,
    'EnumAddress never reads or calls back for a truncated chunk');
  assert.strictEqual(wat.test_dplobby_enum_address(0, address, required, 0), 0,
    'a NULL EnumAddress callback fails synchronously');
  assert.strictEqual(wat.get_eax() >>> 0, 0x80070057);

  const tcpip = wat.guest_alloc(16) >>> 0;
  wat.guest_write32(tcpip, 0x36e95ee0);
  wat.guest_write32(tcpip + 4, 0x11cf8577);
  wat.guest_write32(tcpip + 8, 0x80000c96);
  wat.guest_write32(tcpip + 12, 0x824e53c7);
  wat.guest_write32(count, 0);
  assert.strictEqual(
    wat.test_dplobby_enum_address_types(enumTypesContinue, tcpip, 0x87654321, 0)
      >>> 0,
    enumTypesContinue, 'EnumAddressTypes enters the TCP/IP address callback');
  stack = wat.get_esp() >>> 0;
  const addressType = wat.guest_read32(stack + 4) >>> 0;
  assert.deepStrictEqual([
    wat.guest_read32(addressType) >>> 0,
    wat.guest_read32(addressType + 4) >>> 0,
    wat.guest_read32(addressType + 8) >>> 0,
    wat.guest_read32(addressType + 12) >>> 0,
  ], [0xc4a54da0, 0x11cfe0af, 0xa0004e9c, 0x5e4205c9],
  'the TCP/IP provider enumerates DPAID_INet');
  assert.strictEqual(wat.guest_read32(stack + 8) >>> 0, 0x87654321,
    'EnumAddressTypes preserves caller context');
  assert.strictEqual(wat.guest_read32(stack + 12), 0,
    'Win98 address-type callback flags are reserved zero');
  runCallback();
  assert.strictEqual(wat.guest_read32(count), 1,
    'TCP/IP exposes exactly its required Internet address type');
  assert.strictEqual(
    wat.test_dplobby_enum_address_types(enumTypesContinue, tcpip, 0, 1), 0,
    'EnumAddressTypes rejects nonzero reserved flags synchronously');
  assert.strictEqual(wat.get_eax() >>> 0, 0x80070057);

  console.log('PASS  DirectPlayLobby2 packs and enumerates Win98 compound addresses');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
