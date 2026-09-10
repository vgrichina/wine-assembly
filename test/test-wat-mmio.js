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
  (func (export "test_mmio_lazy_read")
        (param $handle i32) (param $buf i32) (param $count i32) (result i32)
    (call $handle_mmioRead
      (local.get $handle) (local.get $buf) (local.get $count)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_mmio_lazy_advance")
        (param $handle i32) (param $info i32) (result i32)
    (call $handle_mmioAdvance
      (local.get $handle) (local.get $info) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_mmio_set_call_state") (param $esp_value i32) (param $thunk i32)
    (global.set $esp (local.get $esp_value))
    (global.set $current_thunk_eip (local.get $thunk))
    (global.set $yield_reason (i32.const 0))
    (global.set $yield_flag (i32.const 0)))
  `;
  let wat;
  let lazyReads = 0;
  let bufferedReads = 0;
  let pendingRead = false;
  const lazyPayload = Uint8Array.from([0x53, 0x4d, 0x41, 0x43]);
  const { exports, memory } = await bootRenderHarness({
    extraWat,
    extraHostOverrides: {
      fs_read_file(handle, buffer, requested, count) {
        const isDirect = handle === 0x70000120;
        const isBuffered = handle === 0x70000121;
        if (!isDirect && !isBuffered) return 0;
        assert.strictEqual(requested, lazyPayload.length);
        const reads = isDirect ? ++lazyReads : ++bufferedReads;
        pendingRead = reads === 1;
        if (pendingRead) return 0;
        for (let i = 0; i < lazyPayload.length; i++) {
          wat.guest_write8(buffer + i, lazyPayload[i]);
        }
        wat.guest_write32(count, lazyPayload.length);
        return 1;
      },
      fs_read_pending() {
        return pendingRead ? 1 : 0;
      },
    },
  });
  wat = exports;
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

  const lazyBuffer = wat.guest_alloc(lazyPayload.length) >>> 0;
  const lazyEsp = 0x30000;
  const lazyThunk = 0x0badf00d;
  wat.test_mmio_set_call_state(lazyEsp, lazyThunk);
  assert.strictEqual(wat.test_mmio_lazy_read(0x70000120, lazyBuffer, lazyPayload.length), 0,
    'a pending provider read does not masquerade as bytes read');
  assert.strictEqual(wat.get_yield_reason(), 12,
    'a pending mmioRead parks on IO_WAIT');
  assert.strictEqual(wat.test_mmio_esp() >>> 0, lazyEsp,
    'the mmioRead stdcall frame remains intact while parked');
  assert.strictEqual(wat.get_eip() >>> 0, lazyThunk,
    'the pending read retries from the original API thunk');

  wat.test_mmio_set_call_state(lazyEsp, lazyThunk);
  assert.strictEqual(
    wat.test_mmio_lazy_read(0x70000120, lazyBuffer, lazyPayload.length),
    lazyPayload.length,
    'the resumed mmioRead reports the resident provider bytes');
  assert.strictEqual(wat.test_mmio_esp() >>> 0, lazyEsp + 16,
    'the successful retry pops the stdcall frame once');
  assert.deepStrictEqual(
    Array.from(lazyPayload, (_, i) => wat.guest_read8(lazyBuffer + i)),
    Array.from(lazyPayload),
    'the resumed provider bytes reach the movie buffer');
  assert.strictEqual(lazyReads, 2, 'one pending mmioRead is retried exactly once');

  const bufferedHandle = 0x70000121;
  const bufferedStorage = wat.guest_alloc(lazyPayload.length) >>> 0;
  const bufferedInfo = wat.guest_alloc(72) >>> 0;
  const bufferedInfoWa = (bufferedInfo - imageBase + guestBase) >>> 0;
  assert.strictEqual(setBuffer(bufferedHandle, bufferedStorage, lazyPayload.length), 0);
  assert.strictEqual(wat.test_call_mmioGetInfo(bufferedHandle, bufferedInfo), 0);
  wat.test_mmio_set_call_state(lazyEsp, lazyThunk);
  assert.strictEqual(wat.test_mmio_lazy_advance(bufferedHandle, bufferedInfo), 0,
    'a pending buffered refill retains the MMIO success contract');
  assert.strictEqual(wat.get_yield_reason(), 12,
    'a pending mmioAdvance parks on IO_WAIT');
  assert.strictEqual(wat.test_mmio_esp() >>> 0, lazyEsp,
    'the mmioAdvance stdcall frame remains intact while parked');
  assert.strictEqual(wat.get_eip() >>> 0, lazyThunk,
    'the buffered refill retries from the original API thunk');
  assert.strictEqual(view.getUint32(bufferedInfoWa + 32, true), bufferedStorage,
    'a pending refill exposes no false end-of-file bytes');

  wat.test_mmio_set_call_state(lazyEsp, lazyThunk);
  assert.strictEqual(wat.test_mmio_lazy_advance(bufferedHandle, bufferedInfo), 0,
    'the resumed buffered refill succeeds');
  assert.strictEqual(wat.test_mmio_esp() >>> 0, lazyEsp + 16,
    'the successful mmioAdvance retry pops the stdcall frame once');
  assert.strictEqual(view.getUint32(bufferedInfoWa + 32, true),
    bufferedStorage + lazyPayload.length,
    'the resumed refill publishes all resident bytes');
  assert.deepStrictEqual(
    Array.from(lazyPayload, (_, i) => wat.guest_read8(bufferedStorage + i)),
    Array.from(lazyPayload),
    'the resumed buffered provider bytes reach the MMIO buffer');
  assert.strictEqual(bufferedReads, 2,
    'one pending mmioAdvance refill is retried exactly once');

  console.log('PASS: mmio FOURCC conversion, buffer management, and lazy read/refill retry');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
