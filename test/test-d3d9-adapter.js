#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: e } = await bootRenderHarness({ fonts: 'none', extraWat: `
    (func (export "test_adapter") (param $adapter i32) (param $flags i32) (param $p i32) (result i32)
      (global.set $esp (i32.const 0x00300000))
      (call $handle_IDirect3D9_GetAdapterIdentifier (i32.const 0) (local.get $adapter)
        (local.get $flags) (local.get $p) (i32.const 0) (i32.const 0))
      (global.get $eax))
    (func (export "test_caps") (param $adapter i32) (param $type i32) (param $p i32) (result i32)
      (global.set $esp (i32.const 0x00300000))
      (call $handle_IDirect3D9_GetDeviceCaps (i32.const 0) (local.get $adapter)
        (local.get $type) (local.get $p) (i32.const 0) (i32.const 0))
      (global.get $eax))
    (func (export "test_device_caps") (param $p i32) (result i32)
      (global.set $esp (i32.const 0x00300000))
      (call $handle_IDirect3DDevice9_GetDeviceCaps (i32.const 0) (local.get $p)
        (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
      (global.get $eax))
  ` });
  const ptr = 0x00403004;
  const str = offset => {
    let result = '';
    for (let i = 0; i < 512; ++i) {
      const c = e.guest_read8(ptr + offset + i); if (!c) break;
      result += String.fromCharCode(c);
    }
    return result;
  };
  for (const flags of [0, 2]) {
    e.guest_write32(ptr - 4, 0xdeadbeef); e.guest_write32(ptr + 1100, 0xdeadbeef);
    assert.strictEqual(e.test_adapter(0, flags, ptr), 0);
    assert.strictEqual(e.get_esp(), 0x00300014);
    assert.strictEqual(str(0), 'wine-assembly');
    assert.strictEqual(str(512), 'Wine Assembly D3D9');
    assert.strictEqual(str(1024), String.raw`\\.\DISPLAY1`);
    assert.strictEqual(e.guest_read32(ptr + 1096), 0, 'no WHQL certification claimed');
    assert.strictEqual(e.guest_read32(ptr - 4) >>> 0, 0xdeadbeef);
    assert.strictEqual(e.guest_read32(ptr + 1100) >>> 0, 0xdeadbeef);
  }
  assert.strictEqual(e.test_adapter(1, 0, ptr) >>> 0, 0x8876086c);
  assert.ok(Array.from({ length: 1100 }, (_, i) => e.guest_read8(ptr + i)).every(v => v === 0));
  assert.strictEqual(e.test_adapter(0, 1, ptr) >>> 0, 0x8876086c);
  assert.strictEqual(e.test_adapter(0, 0, 0) >>> 0, 0x8876086c);
  e.guest_write32(ptr + 304, 0xdeadbeef);
  assert.strictEqual(e.test_caps(0, 1, ptr), 0);
  assert.strictEqual(e.get_esp(), 0x00300014);
  assert.strictEqual(e.guest_read32(ptr), 1);
  assert.strictEqual(e.guest_read32(ptr + 88), 2048);
  assert.strictEqual(e.guest_read32(ptr + 92), 2048);
  assert.strictEqual(e.guest_read32(ptr + 196), 0, 'no vertex shader version advertised');
  assert.strictEqual(e.guest_read32(ptr + 204), 0, 'no pixel shader version advertised');
  assert.strictEqual(e.guest_read32(ptr + 152), 0, 'no texture sampling advertised');
  assert.strictEqual(e.guest_read32(ptr + 232), 1, 'one adapter in group');
  assert.strictEqual(e.guest_read32(ptr + 236), 0, 'DeclTypes is not adapter count');
  assert.strictEqual(e.guest_read32(ptr + 240), 1, 'one simultaneous render target');
  assert.strictEqual(e.guest_read32(ptr + 244), 0, 'no StretchRect filtering advertised');
  assert.strictEqual(e.guest_read32(ptr + 304) >>> 0, 0xdeadbeef);
  const caps = Array.from({ length: 304 }, (_, i) => e.guest_read8(ptr + i));
  assert.strictEqual(e.test_device_caps(ptr + 1200), 0);
  assert.strictEqual(e.get_esp(), 0x0030000c);
  assert.deepStrictEqual(Array.from({ length: 304 }, (_, i) => e.guest_read8(ptr + 1200 + i)), caps);
  assert.strictEqual(e.test_caps(1, 1, ptr) >>> 0, 0x8876086c);
  assert.strictEqual(e.test_caps(0, 1, 0) >>> 0, 0x8876086c);
  console.log('PASS D3D9 adapter identity, validation, output bounds and ABI');
})().catch(error => { console.error(error); process.exitCode = 1; });
