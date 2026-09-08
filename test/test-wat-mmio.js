#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const extraWat = `
  (func (export "test_call_mmioStringToFOURCCA")
        (param $str i32) (param $flags i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_mmioStringToFOURCCA
      (local.get $str) (local.get $flags) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_mmio_esp") (result i32) (global.get $esp))
  `;
  const { exports: wat, memory } = await bootRenderHarness({ extraWat });
  const setBuffer = (handle, buffer, size, flags = 0) =>
    wat.test_call_mmioSetBuffer(handle, buffer, size, flags);
  const imageBase = wat.get_image_base() >>> 0;
  const guestBase = wat.get_guest_base() >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const allocString = value => {
    const guest = wat.guest_alloc(value.length + 1) >>> 0;
    const wa = (guest - imageBase + guestBase) >>> 0;
    bytes.set(Buffer.from(`${value}\0`, 'ascii'), wa);
    return guest;
  };

  assert.strictEqual(
    wat.test_call_mmioStringToFOURCCA(allocString('WAVE'), 0) >>> 0,
    0x45564157,
    'four characters pack in little-endian order');
  assert.strictEqual(
    wat.test_call_mmioStringToFOURCCA(allocString('fmt '), 0) >>> 0,
    0x20746d66,
    'case is retained without MMIO_TOUPPER');
  assert.strictEqual(
    wat.test_call_mmioStringToFOURCCA(allocString('ab'), 0x10) >>> 0,
    0x20204241,
    'MMIO_TOUPPER folds ASCII and a short string is space-padded');
  assert.strictEqual(
    wat.test_call_mmioStringToFOURCCA(allocString('longer'), 0) >>> 0,
    0x676e6f6c,
    'a long string is truncated to four characters');
  assert.strictEqual(wat.test_mmio_esp() >>> 0, 0x3000c,
    'stdcall removes the return address and two arguments');

  assert.strictEqual(setBuffer(0x70000107, 0, 0x4000), 0,
    'Alpha Centauri 16 KiB internal-buffer request succeeds');
  const info = wat.guest_alloc(72);
  assert.strictEqual(wat.test_call_mmioGetInfo(0x70000107, info), 0);
  const infoWa = (info - imageBase + guestBase) >>> 0;
  const view = new DataView(memory.buffer);
  assert.strictEqual(view.getUint32(infoWa + 20, true), 0x4000,
    'mmioGetInfo reports the selected internal buffer size');
  assert.notStrictEqual(view.getUint32(infoWa + 24, true), 0,
    'mmioGetInfo exposes stable internal storage');
  const callerBuffer = wat.guest_alloc(256);
  assert.strictEqual(setBuffer(0x70000107, callerBuffer, 256), 0,
    'an application-owned buffer succeeds');
  assert.strictEqual(wat.test_call_mmioGetInfo(0x70000107, info), 0);
  assert.strictEqual(view.getUint32(infoWa + 20, true), 256,
    'mmioGetInfo reports a caller-owned buffer size');
  assert.strictEqual(view.getUint32(infoWa + 24, true), callerBuffer,
    'mmioGetInfo retains the caller-owned buffer pointer');
  assert.strictEqual(setBuffer(0x70000107, 0, 0), 0,
    'a null zero-sized buffer disables buffering');
  assert.strictEqual(setBuffer(0x70000107, 0, -1), 5,
    'negative buffer size is rejected');
  assert.strictEqual(setBuffer(0x70000107, 0, 256, 1), 5,
    'reserved flags must be zero');

  console.log('PASS: mmio FOURCC conversion and buffer management');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
