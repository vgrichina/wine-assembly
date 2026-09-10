#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_alloc_byte_bstr") (param $src i32) (param $len i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_SysAllocStringByteLen
      (local.get $src) (local.get $len) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_byte_bstr_len") (param $bstr i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_SysStringByteLen
      (local.get $bstr) (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const src = 0x00403000;
  const bytes = [0x41, 0x00, 0x42, 0x7f, 0xcc];
  bytes.forEach((value, i) => wat.guest_write8(src + i, value));

  const bstr = wat.test_alloc_byte_bstr(src, bytes.length) >>> 0;
  assert.notStrictEqual(bstr, 0, 'byte-length BSTR allocation succeeds');
  assert.strictEqual(wat.get_esp() >>> 0, 0x0030000c,
    'SysAllocStringByteLen pops its return address and two arguments');
  assert.strictEqual(wat.guest_read32(bstr - 4) >>> 0, bytes.length,
    'BSTR prefix stores an exact byte count');
  assert.deepStrictEqual(bytes.map((_, i) => wat.guest_read8(bstr + i)), bytes,
    'payload preserves embedded NULs and odd byte lengths');
  assert.strictEqual(wat.guest_read8(bstr + bytes.length), 0);
  assert.strictEqual(wat.guest_read8(bstr + bytes.length + 1), 0,
    'byte BSTR retains the required two-byte trailing terminator');

  assert.strictEqual(wat.test_byte_bstr_len(bstr) >>> 0, bytes.length,
    'SysStringByteLen returns the stored byte count');
  assert.strictEqual(wat.get_esp() >>> 0, 0x00300008,
    'SysStringByteLen pops its return address and argument');
  assert.strictEqual(wat.test_byte_bstr_len(0), 0,
    'a NULL BSTR has zero byte length');

  console.log('PASS  byte-length BSTR APIs preserve exact binary payloads and ABI');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
