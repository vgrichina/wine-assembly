#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_win16_lazy_read_first") (result i32)
    (local $h16 i32)
    (call $win16_seg_set (i32.const 1) (i32.const 0x00100000)
      (i32.const 0x10000) (i32.const 0) (i32.const 1))
    (call $win16_seg_set (i32.const 2) (i32.const 0x00110000)
      (i32.const 0x10000) (i32.const 1) (i32.const 2))
    (call $win16_seg_set (i32.const 3) (i32.const 0x00120000)
      (i32.const 0x10000) (i32.const 2) (i32.const 3))
    (call $win16_seg_set (i32.const 4) (i32.const 0x00130000)
      (i32.const 0x10000) (i32.const 3) (i32.const 4))
    (global.set $code16 (i32.const 1))
    (global.set $sreg_cs (call $win16_index_to_sel (i32.const 1)))
    (global.set $seg_base_cs (i32.const 0x00100000))
    (global.set $sreg_ss (call $win16_index_to_sel (i32.const 2)))
    (global.set $seg_base_ss (i32.const 0x00110000))
    (global.set $esp (i32.const 0x00110100))
    (global.set $WIN16_THUNK_SEL (call $win16_index_to_sel (i32.const 4)))
    (global.set $current_thunk_eip (i32.const 0x00130123))
    (local.set $h16 (call $win16_fh16 (i32.const 41)))
    ;; Far return, then Pascal's rightmost argument first: count, buffer, file.
    (call $gs16 (i32.const 0x00110100) (i32.const 0x0020))
    (call $gs16 (i32.const 0x00110102) (call $win16_index_to_sel (i32.const 1)))
    (call $gs16 (i32.const 0x00110104) (i32.const 4))
    (call $gs16 (i32.const 0x00110106) (i32.const 0x0004))
    (call $gs16 (i32.const 0x00110108) (call $win16_index_to_sel (i32.const 3)))
    (call $gs16 (i32.const 0x0011010a) (local.get $h16))
    (call $win16_lread (i32.const 0))
    (global.get $yield_reason))

  (func (export "test_win16_lazy_read_resume") (result i32)
    (global.set $yield_reason (i32.const 0))
    (global.set $yield_flag (i32.const 0))
    (call $win16_lread (i32.const 0))
    (global.get $eax))

  (func (export "test_win16_lazy_read_esp") (result i32) (global.get $esp))
  (func (export "test_win16_lazy_read_eip") (result i32) (global.get $eip))
  (func (export "test_win16_lazy_read_byte") (param $i i32) (result i32)
    (call $gl8 (i32.add (i32.const 0x00120004) (local.get $i))))
`;

(async () => {
  let wat;
  let reads = 0;
  const payload = Uint8Array.from([0x57, 0x61, 0x72, 0x21]);
  const harness = await bootRenderHarness({
    extraWat,
    extraHostOverrides: {
      fs_read_file(handle, buffer, requested, count) {
        assert.strictEqual(handle, 41);
        assert.strictEqual(buffer, 0x00120004);
        assert.strictEqual(requested, payload.length);
        reads++;
        if (reads === 1) return 0;
        for (let i = 0; i < payload.length; i++) wat.guest_write8(buffer + i, payload[i]);
        wat.guest_write32(count, payload.length);
        return 1;
      },
      fs_read_pending() {
        return reads === 1 ? 1 : 0;
      },
    },
  });
  wat = harness.exports;

  assert.strictEqual(wat.test_win16_lazy_read_first(), 12,
    'an async cache miss parks on IO_WAIT');
  assert.strictEqual(wat.test_win16_lazy_read_esp(), 0x00110100,
    'the Win16 Pascal far-call frame stays intact while parked');
  assert.strictEqual(wat.test_win16_lazy_read_eip(), 0x00130123,
    'the retry resumes at the original Win16 thunk');

  assert.strictEqual(wat.test_win16_lazy_read_resume(), payload.length,
    'the resumed _lread reports the filled byte count');
  assert.strictEqual(wat.test_win16_lazy_read_esp(), 0x0011010c,
    'the successful retry pops its far return and arguments once');
  assert.strictEqual(wat.test_win16_lazy_read_eip(), 0x00100020,
    'the successful retry returns to the Win16 caller');
  assert.deepStrictEqual(Array.from(payload, (_, i) => wat.test_win16_lazy_read_byte(i)),
    Array.from(payload), 'the filled provider bytes reach the far buffer');
  assert.strictEqual(reads, 2, 'one pending read is retried exactly once');

  console.log('PASS  Win16 file reads yield and retry async VFS providers');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
