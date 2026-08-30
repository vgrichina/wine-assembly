#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_lzcopy") (param $src i32) (param $dst i32) (result i32)
    (global.set $esp (i32.const 0x00430000))
    (call $handle_LZCopy
      (local.get $src) (local.get $dst) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_lzcopy_esp") (result i32) (global.get $esp))
`;

(async () => {
  const source = Buffer.alloc(0x2345);
  for (let i = 0; i < source.length; i++) source[i] = (i * 37 + 11) & 0xff;
  const written = [];
  let offset = 0;
  let wat;
  const harness = await bootRenderHarness({
    extraWat,
    extraHostOverrides: {
      fs_read_file(handle, buffer, requested, count) {
        assert.strictEqual(handle, 41);
        const amount = Math.min(requested, source.length - offset);
        for (let i = 0; i < amount; i++) wat.guest_write8(buffer + i, source[offset + i]);
        wat.guest_write32(count, amount);
        offset += amount;
        return 1;
      },
      fs_write_file(handle, buffer, requested, count) {
        assert.strictEqual(handle, 42);
        for (let i = 0; i < requested; i++) written.push(wat.guest_read8(buffer + i));
        wat.guest_write32(count, requested);
        return 1;
      },
    },
  });
  wat = harness.exports;

  assert.strictEqual(wat.test_lzcopy(41, 42), source.length,
    'LZCopy returns the copied byte count');
  assert.deepStrictEqual(Buffer.from(written), source,
    'LZCopy preserves ordinary InstallShield payload bytes across chunk boundaries');
  assert.strictEqual(wat.test_lzcopy_esp() >>> 0, 0x0043000c,
    'LZCopy pops its return address and two stdcall arguments');
  console.log('PASS  LZCopy copies ordinary streams used by InstallShield self-extractors');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
