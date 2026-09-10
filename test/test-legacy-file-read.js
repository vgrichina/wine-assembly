#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_legacy_read")
      (param $kind i32) (param $handle i32) (param $buffer i32)
      (param $count i32) (param $reset i32) (result i32)
    (if (local.get $reset)
      (then
        (global.set $esp (i32.const 0x00300000))
        (global.set $current_thunk_eip (i32.const 0x0013579b))
        (global.set $eip (i32.const 0))
        (global.set $eax (i32.const 0x2468ace0))
        (global.set $last_error (i32.const 0))
        (global.set $handler_set_eip (i32.const 0))
        (global.set $yield_reason (i32.const 0))
        (global.set $yield_flag (i32.const 0)))
      (else
        ;; Model the host completing an IO_WAIT before the thunk is retried.
        (global.set $handler_set_eip (i32.const 0))
        (global.set $yield_reason (i32.const 0))
        (global.set $yield_flag (i32.const 0))))
    (if (i32.eq (local.get $kind) (i32.const 0))
      (then
        (call $handle__lread
          (local.get $handle) (local.get $buffer) (local.get $count)
          (i32.const 0) (i32.const 0) (i32.const 0)))
      (else
        (if (i32.eq (local.get $kind) (i32.const 1))
          (then
            (call $handle__hread
              (local.get $handle) (local.get $buffer) (local.get $count)
              (i32.const 0) (i32.const 0) (i32.const 0)))
          (else
            (call $handle_mmioRead
              (local.get $handle) (local.get $buffer) (local.get $count)
              (i32.const 0) (i32.const 0) (i32.const 0))))))
    (global.get $eax))

  (func (export "test_legacy_read_last_error") (result i32)
    (global.get $last_error))
`;

(async () => {
  let wat;
  let mode = 'success';
  let reads = 0;
  const payload = Uint8Array.from([0x52, 0x65, 0x61, 0x64]);
  const harness = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      fs_read_file(handle, buffer, requested, count) {
        assert.strictEqual(handle, 41, 'the legacy handle reaches the shared host read');
        reads++;
        wat.guest_write32(count, 0);
        if (mode === 'failure' || mode === 'fault' ||
            (mode === 'pending' && reads === 1)) return 0;
        if (mode === 'eof') return 1;
        assert.strictEqual(requested, payload.length);
        for (let i = 0; i < payload.length; i++) wat.guest_write8(buffer + i, payload[i]);
        wat.guest_write32(count, payload.length);
        return 1;
      },
      fs_read_pending() {
        if (mode === 'pending' && reads === 1) return 1;
        if (mode === 'fault') return 2;
        return 0;
      },
    },
  });
  wat = harness.exports;
  const buffer = (wat.get_image_base() >>> 0) + 0x2800;

  for (const [kind, name] of ['_lread', '_hread', 'mmioRead'].entries()) {
    mode = 'success';
    reads = 0;
    assert.strictEqual(wat.test_legacy_read(kind, 41, buffer, payload.length, 1),
      payload.length, `${name} returns the number of bytes read`);
    assert.strictEqual(wat.get_esp() >>> 0, 0x00300010,
      `${name} pops three arguments and its return address exactly once`);
    assert.deepStrictEqual(Array.from(payload, (_, i) => wat.guest_read8(buffer + i)),
      Array.from(payload), `${name} writes the shared read payload`);
    assert.strictEqual(reads, 1, `${name} performs one host read`);

    mode = 'eof';
    reads = 0;
    assert.strictEqual(wat.test_legacy_read(kind, 41, buffer, payload.length, 1), 0,
      `${name} reports a successful zero-byte read as EOF`);

    mode = 'failure';
    reads = 0;
    assert.strictEqual(wat.test_legacy_read(kind, 41, buffer, payload.length, 1), -1,
      `${name} distinguishes a read failure from EOF`);
    assert.strictEqual(wat.get_esp() >>> 0, 0x00300010,
      `${name} still cleans its stdcall frame on failure`);
  }

  for (const [kind, name] of [[1, '_hread'], [2, 'mmioRead']]) {
    mode = 'success';
    reads = 0;
    assert.strictEqual(wat.test_legacy_read(kind, 41, buffer, -1, 1), -1,
      `${name} rejects a negative LONG count`);
    assert.strictEqual(reads, 0, `${name} rejects a negative count before host I/O`);
  }

  mode = 'fault';
  reads = 0;
  assert.strictEqual(wat.test_legacy_read(2, 41, buffer, payload.length, 1), -1,
    'a failed lazy fill completes mmioRead as an error');
  assert.strictEqual(wat.test_legacy_read_last_error(), 30,
    'a failed lazy fill reports ERROR_READ_FAULT');

  mode = 'pending';
  reads = 0;
  wat.test_legacy_read(2, 41, buffer, payload.length, 1);
  assert.strictEqual(wat.get_yield_reason(), 12,
    'a nonresident mmioRead parks on IO_WAIT');
  assert.strictEqual(wat.get_esp() >>> 0, 0x00300000,
    'the parked stdcall frame is restored for retry');
  assert.strictEqual(wat.get_eip() >>> 0, 0x0013579b,
    'the parked read retries through its original thunk');
  assert.strictEqual(wat.test_legacy_read(2, 41, buffer, payload.length, 0), payload.length,
    'the resumed mmioRead reports the filled byte count');
  assert.strictEqual(wat.get_esp() >>> 0, 0x00300010,
    'the successful retry pops the frame once');
  assert.strictEqual(reads, 2, 'one pending read is retried exactly once');

  const root = path.join(__dirname, '..');
  const kernel = fs.readFileSync(path.join(root, 'src', '09a-handlers.wat'), 'utf8');
  const audio = fs.readFileSync(path.join(root, 'src', '09a3-handlers-audio.wat'), 'utf8');
  assert.match(kernel, /\(func \$handle__hread[\s\S]*?\(call \$handle__lread/,
    '_hread must delegate to the canonical _lread implementation');
  assert.match(audio, /\(func \$handle_mmioRead[\s\S]*?\(call \$handle__hread/,
    'mmioRead must share the signed legacy-read adapter');

  console.log('PASS  legacy file-read APIs share EOF, failure, and lazy retry behavior');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
