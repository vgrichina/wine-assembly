#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_d3d9_device") (result i32)
    (local $surf i32) (local $dev i32) (local $entry i32)
    (local.set $surf (call $d3d9_create_surface
      (i32.const 640) (i32.const 480) (i32.const 32) (i32.const 1)))
    (local.set $dev (call $dx_create_com_obj
      (i32.const 20) (global.get $DX_VTBL_D3DDEV9)))
    (local.set $entry (call $dx_from_this (local.get $dev)))
    (i32.store offset=8 (local.get $entry)
      (call $dx_slot_of (call $dx_from_this (local.get $surf))))
    (global.set $d3d9_windowed_hwnd (i32.const 0x10001))
    (local.get $dev))

  (func (export "test_d3d9_get_swap_chain") (param $dev i32) (param $out i32) (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_IDirect3DDevice9_GetSwapChain
      (local.get $dev) (i32.const 0) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))

  (func (export "test_d3d9_get_present_parameters") (param $swap i32) (param $pp i32) (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_IDirect3DSwapChain9_GetPresentParameters
      (local.get $swap) (local.get $pp) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))

  (func (export "test_d3d9_swap_vtable") (result i32)
    (global.get $DX_VTBL_D3DSWAP9))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const dev = e.test_d3d9_device() >>> 0;
  const out = e.guest_alloc(4) >>> 0;
  const pp = e.guest_alloc(56) >>> 0;
  let result = e.test_d3d9_get_swap_chain(dev, out);
  assert.strictEqual(Number(result & 0xffffffffn), 0, 'swap chain zero exists');
  assert.strictEqual(Number(result >> 32n), 0x00300010,
    'GetSwapChain pops this, index, output, and return address');
  const swap = e.guest_read32(out) >>> 0;
  assert(swap, 'swap-chain interface pointer is returned');
  assert.strictEqual(e.guest_read32(swap) >>> 0, e.test_d3d9_swap_vtable() >>> 0,
    'returned interface uses the swap-chain vtable');

  result = e.test_d3d9_get_present_parameters(swap, pp);
  assert.strictEqual(Number(result & 0xffffffffn), 0, 'presentation parameters succeed');
  assert.strictEqual(Number(result >> 32n), 0x0030000c,
    'GetPresentParameters pops this, output, and return address');
  assert.strictEqual(e.guest_read32(pp) >>> 0, 640, 'back-buffer width');
  assert.strictEqual(e.guest_read32(pp + 4) >>> 0, 480, 'back-buffer height');
  assert.strictEqual(e.guest_read32(pp + 8) >>> 0, 22, 'X8R8G8B8 format');
  assert.strictEqual(e.guest_read32(pp + 12) >>> 0, 1, 'one back buffer');
  assert.strictEqual(e.guest_read32(pp + 24) >>> 0, 1, 'discard swap effect');
  assert.strictEqual(e.guest_read32(pp + 28) >>> 0, 0x10001, 'device window');
  assert.strictEqual(e.guest_read32(pp + 32) >>> 0, 1, 'windowed device');
  console.log('PASS D3D9 exposes its implicit swap chain and presentation parameters');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
