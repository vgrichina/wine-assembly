#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: wat, memory } = await bootRenderHarness();
  const setBuffer = (handle, buffer, size, flags = 0) =>
    wat.test_call_mmioSetBuffer(handle, buffer, size, flags);

  assert.strictEqual(setBuffer(0x70000107, 0, 0x4000), 0,
    'Alpha Centauri 16 KiB internal-buffer request succeeds');
  const info = wat.guest_alloc(72);
  assert.strictEqual(wat.test_call_mmioGetInfo(0x70000107, info), 0);
  const imageBase = wat.get_image_base() >>> 0;
  const guestBase = wat.get_guest_base() >>> 0;
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

  console.log('PASS: mmioSetBuffer allocation, caller buffer, disable, and validation');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
