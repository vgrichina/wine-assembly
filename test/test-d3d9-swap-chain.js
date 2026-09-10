#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
const apiTable = require('../src/api_table.json');

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

  (func (export "test_d3d9_dispatch_one")
      (param $api_id i32) (param $this i32) (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $dispatch_api_table
      (local.get $api_id) (local.get $this)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0))
    (i64.or (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))

  (func (export "test_d3d9_create_root") (result i32)
    (call $dx_create_com_obj (i32.const 34) (global.get $DX_VTBL_D3D9)))

  (func (export "test_d3d9_create_texture") (result i32)
    (call $dx_create_com_obj (i32.const 35) (global.get $DX_VTBL_D3DTEX9)))

  (func (export "test_d3d9_create_standalone_surface") (result i32)
    (call $d3d9_create_surface
      (i32.const 8) (i32.const 8) (i32.const 32) (i32.const 4)))

  (func (export "test_d3d9_render_target") (param $dev i32) (result i32)
    (local $entry i32)
    (local.set $entry (call $d3ddev_rt_entry (local.get $dev)))
    (call $d3dim_primary_guest (local.get $entry)))

  (func (export "test_d3d9_object_ref") (param $this i32) (result i32)
    (load.field DxObject refcount (call $dx_from_this (local.get $this))))

  (func (export "test_d3d9_object_type") (param $this i32) (result i32)
    (load.field DxObject type (call $dx_from_this (local.get $this))))

  (func (export "test_d3d9_surface_bits") (param $this i32) (result i32)
    (load.field DxObject misc1 (call $dx_from_this (local.get $this))))

  (func (export "test_d3d9_vidmem_used") (result i32)
    (global.get $dx_vidmem_used))

  (func (export "test_d3d9_swap_vtable") (result i32)
    (global.get $DX_VTBL_D3DSWAP9))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const apiId = name => apiTable.find(entry => entry.name === name).id;
  const dispatchOne = (name, object) => {
    const result = e.test_d3d9_dispatch_one(apiId(name), object);
    assert.strictEqual(Number(result >> 32n), 0x00300008,
      `${name} pops this and its return address`);
    return Number(result & 0xffffffffn) >>> 0;
  };

  for (const [prefix, create] of [
    ['IDirect3D9', () => e.test_d3d9_create_root() >>> 0],
    ['IDirect3DTexture9', () => e.test_d3d9_create_texture() >>> 0],
  ]) {
    const object = create();
    assert(object, `${prefix} lifetime fixture exists`);
    assert.strictEqual(dispatchOne(`${prefix}_AddRef`, object), 2);
    assert.strictEqual(dispatchOne(`${prefix}_Release`, object), 1);
    assert.strictEqual(dispatchOne(`${prefix}_Release`, object), 0);
    assert.strictEqual(e.test_d3d9_object_type(object), 0,
      `${prefix} final Release retires its backing object`);
  }

  const standaloneBefore = e.test_d3d9_vidmem_used() >>> 0;
  const standaloneSurface = e.test_d3d9_create_standalone_surface() >>> 0;
  assert(standaloneSurface, 'standalone Surface9 lifetime fixture exists');
  const standaloneBits = e.test_d3d9_surface_bits(standaloneSurface) >>> 0;
  assert.strictEqual(dispatchOne('IDirect3DSurface9_AddRef', standaloneSurface), 2);
  assert.strictEqual(dispatchOne('IDirect3DSurface9_Release', standaloneSurface), 1);
  assert.strictEqual(dispatchOne('IDirect3DSurface9_Release', standaloneSurface), 0);
  assert.strictEqual(e.test_d3d9_object_type(standaloneSurface), 0,
    'Surface9 final Release runs type-2 surface teardown');
  assert.strictEqual(e.test_d3d9_vidmem_used() >>> 0, standaloneBefore,
    'Surface9 final Release returns its DIB allocation');
  const recycledSurface = e.test_d3d9_create_standalone_surface() >>> 0;
  assert.strictEqual(e.test_d3d9_surface_bits(recycledSurface) >>> 0, standaloneBits,
    'the released DIB page run is reusable');
  assert.strictEqual(dispatchOne('IDirect3DSurface9_Release', recycledSurface), 0);

  const deviceBefore = e.test_d3d9_vidmem_used() >>> 0;
  const dev = e.test_d3d9_device() >>> 0;
  const renderTarget = e.test_d3d9_render_target(dev) >>> 0;
  assert(renderTarget, 'device owns an implicit render target');
  assert.strictEqual(e.test_d3d9_object_ref(dev), 1);
  assert.strictEqual(e.test_d3d9_object_ref(renderTarget), 1);
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

  assert.strictEqual(dispatchOne('IDirect3DDevice9_AddRef', dev), 3,
    'Device9 AddRef shares the device/swap-chain identity');
  assert.strictEqual(dispatchOne('IDirect3DDevice9_Release', dev), 2,
    'nonfinal Device9 Release preserves the render target');
  assert.strictEqual(dispatchOne('IDirect3DSwapChain9_Release', swap), 1,
    'releasing the returned swap-chain interface drops its shared reference');
  assert.strictEqual(e.test_d3d9_object_type(renderTarget), 2,
    'nonfinal device/swap releases preserve the render target');
  assert.strictEqual(dispatchOne('IDirect3DDevice9_Release', dev), 0,
    'final Device9 Release retires the shared identity');
  assert.strictEqual(e.test_d3d9_object_type(dev), 0);
  assert.strictEqual(e.test_d3d9_object_type(renderTarget), 0,
    'final device release drops its implicit render-target reference');
  assert.strictEqual(e.test_d3d9_vidmem_used() >>> 0, deviceBefore,
    'device teardown returns implicit render-target video memory');
  console.log('PASS D3D9 exposes its implicit swap chain and presentation parameters');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
