#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ fonts: 'none', extraWat: `
    (func (export "test_memory_status") (param $p i32) (result i32)
      (global.set $esp (i32.const 0x00300000))
      (call $handle_GlobalMemoryStatusEx (local.get $p) (i32.const 0)
        (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
      (global.get $eax))
    (func (export "test_commit") (result i32)
      (call $virtual_map_commit (i32.const 0x40000000) (i32.const 65536)))
    (func (export "test_last_error") (result i32) (global.get $last_error))
  ` });
  const ptr = 0x00403004;
  const snapshot = () => Array.from({ length: 16 }, (_, i) => e.guest_read32(ptr + i * 4) >>> 0);
  for (let i = -4; i <= 64; i += 4) e.guest_write32(ptr + i, 0xdeadbeef);
  e.guest_write32(ptr, 63);
  const invalid = snapshot();
  assert.strictEqual(e.test_memory_status(ptr), 0);
  assert.strictEqual(e.test_last_error(), 87);
  assert.deepStrictEqual(snapshot(), invalid, 'bad length does not overwrite output');
  assert.strictEqual(e.test_memory_status(0), 0);
  e.guest_write32(ptr, 64);
  assert.strictEqual(e.test_memory_status(ptr), 1);
  assert.strictEqual(e.get_esp(), 0x00300008);
  const first = snapshot();
  assert.strictEqual(first[0], 64);
  assert.strictEqual(first[2], memory.buffer.byteLength);
  assert.ok(first[4] > 0 && first[4] <= first[2]);
  assert.strictEqual(first[1], Math.floor((first[2] - first[4]) * 100 / first[2]));
  for (const i of [3, 5, 7, 9, 11, 13, 14, 15]) assert.strictEqual(first[i], 0);
  assert.strictEqual(e.guest_read32(ptr - 4) >>> 0, 0xdeadbeef);
  assert.strictEqual(e.guest_read32(ptr + 64) >>> 0, 0xdeadbeef);
  assert.strictEqual(e.test_commit(), 0x40000000);
  assert.strictEqual(e.test_memory_status(ptr), 1);
  assert.strictEqual(snapshot()[4], first[4] - 65536, 'available capacity tracks committed backing');
  console.log('PASS GlobalMemoryStatusEx layout, bounds, validation and allocation accounting');
})().catch(error => { console.error(error); process.exitCode = 1; });
