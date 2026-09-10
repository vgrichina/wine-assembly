#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
(async () => {
  const { exports: e } = await bootRenderHarness({ fonts: 'none', extraWat: `
    (func (export "new_device") (result i32)
      (local $device i32) (local $state i32)
      (local.set $device (call $dx_create_com_obj (i32.const 20) (global.get $DX_VTBL_D3DDEV9)))
      (local.set $state (call $d3d9_program_alloc))
      (store.field DxObject misc1 (call $dx_from_this (local.get $device)) (local.get $state))
      (local.get $device))
    (func (export "constants") (param $device i32) (param $start i32) (param $p i32)
      (param $count i32) (param $pixel i32) (param $get i32) (result i32)
      (call $d3d9_float_constants (local.get $device) (local.get $start) (local.get $p)
        (local.get $count) (local.get $pixel) (local.get $get))
      (global.get $eax))
    (func (export "release_device") (param $device i32) (result i32)
      (call $handle_IDirect3DDevice9_Release (local.get $device) (i32.const 0)
        (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
      (global.get $eax))
  ` });
  const a = e.new_device(), b = e.new_device(), input = 0x00405000, output = 0x00406000;
  for (let i = 0; i < 32; ++i) e.guest_write32(input + i * 4, 0x3f000000 + i);
  for (const pixel of [0,1]) {
    const last = pixel ? 7 : 95;
    assert.strictEqual(e.constants(a, last, input, 1, pixel, 0), 0);
    e.guest_write32(output - 4, 0xdeadbeef); e.guest_write32(output + 16, 0xdeadbeef);
    assert.strictEqual(e.constants(a, last, output, 1, pixel, 1), 0);
    for (let i = 0; i < 4; ++i) assert.strictEqual(e.guest_read32(output+i*4), 0x3f000000+i);
    assert.strictEqual(e.guest_read32(output-4) >>> 0, 0xdeadbeef);
    assert.strictEqual(e.guest_read32(output+16) >>> 0, 0xdeadbeef);
    assert.strictEqual(e.constants(b, last, output, 1, pixel, 1), 0);
    for (let i = 0; i < 4; ++i) assert.strictEqual(e.guest_read32(output+i*4), 0);
    assert.strictEqual(e.constants(a, last, input, 2, pixel, 0) >>> 0, 0x8876086c);
    assert.strictEqual(e.constants(a, 0xffffffff, input, 1, pixel, 0) >>> 0, 0x8876086c);
    assert.strictEqual(e.constants(a, 0, input, 0xffffffff, pixel, 0) >>> 0, 0x8876086c);
    assert.strictEqual(e.constants(a, 0, 0, 1, pixel, 0) >>> 0, 0x8876086c);
  }
  assert.strictEqual(e.constants(0, 0, input, 1, 0, 0) >>> 0, 0x8876086c);
  assert.strictEqual(e.release_device(a), 0);
  assert.strictEqual(e.constants(a, 0, output, 1, 0, 1) >>> 0, 0x8876086c);
  assert.strictEqual(e.release_device(b), 0);
  console.log('PASS D3D9 float constant register banks, per-device ownership, bounds, release');
})().catch(error => { console.error(error); process.exitCode = 1; });
