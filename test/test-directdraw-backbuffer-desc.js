#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_dx_backbuffer_seed") (param $ddraw_vtbl i32) (param $surface_vtbl i32)
    (global.set $DX_VTBL_DDRAW (local.get $ddraw_vtbl))
    (global.set $DX_VTBL_DDSURF2 (local.get $surface_vtbl)))
  (func (export "test_dx_backbuffer_create") (param $desc i32) (param $out i32) (result i32)
    (local $ddraw i32)
    (local.set $ddraw (call $dx_create_com_obj (i32.const 1) (global.get $DX_VTBL_DDRAW)))
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDraw_CreateSurface
      (local.get $ddraw) (local.get $desc) (local.get $out) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_dx_backbuffer_desc") (param $surface i32) (param $desc i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDrawSurface_GetSurfaceDesc
      (local.get $surface) (local.get $desc) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_dx_backbuffer_get") (param $surface i32) (param $caps i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDrawSurface_GetAttachedSurface
      (local.get $surface) (local.get $caps) (local.get $out) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_dx_surface_dib_wa") (param $surface i32) (result i32)
    (i32.load offset=20 (call $dx_from_this (local.get $surface))))
  (func (export "test_dx_surface_lock") (param $surface i32) (param $desc i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDrawSurface_Lock
      (local.get $surface) (i32.const 0) (local.get $desc) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_dx_surface_release") (param $surface i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDrawSurface_Release
      (local.get $surface) (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const createDesc = 0x410000;
  const primaryOut = 0x410100;
  const queryDesc = 0x410200;
  const caps = 0x410300;
  const attachedOut = 0x410304;
  const lockDesc = 0x410400;

  // The concrete vtable values only need to be non-zero for this direct
  // handler test; dx_from_this resolves objects through their wrapper slot.
  wat.test_dx_backbuffer_seed(0x51000000, 0x52000000);
  wat.guest_write32(createDesc, 108);
  wat.guest_write32(createDesc + 4, 0x21); // DDSD_CAPS|BACKBUFFERCOUNT
  wat.guest_write32(createDesc + 20, 1);
  wat.guest_write32(createDesc + 104, 0x218); // PRIMARY|FLIP|COMPLEX

  assert.strictEqual(wat.test_dx_backbuffer_create(createDesc, primaryOut) >>> 0, 0);
  const primary = wat.guest_read32(primaryOut) >>> 0;
  assert(primary, 'primary surface should be published');

  const primaryDibWa = wat.test_dx_surface_dib_wa(primary) >>> 0;
  assert(primaryDibWa >= 0x1C000000 && primaryDibWa < 0x20000000,
    `DirectDraw pixels must use the dedicated DIB backing, got WASM 0x${primaryDibWa.toString(16)}`);
  assert.strictEqual(wat.test_dx_surface_lock(primary, lockDesc) >>> 0, 0);
  const lockedGuest = wat.guest_read32(lockDesc + 36) >>> 0;
  assert(lockedGuest >= 0x50000000 && lockedGuest < 0x54000000,
    `Lock must return the DIB guest mapping, got 0x${lockedGuest.toString(16)}`);

  assert.strictEqual(wat.test_dx_backbuffer_desc(primary, queryDesc) >>> 0, 0);
  assert(wat.guest_read32(queryDesc + 4) & 0x20,
    'GetSurfaceDesc should report DDSD_BACKBUFFERCOUNT');
  assert.strictEqual(wat.guest_read32(queryDesc + 20) >>> 0, 1,
    'GetSurfaceDesc should retain the created back-buffer count');
  assert.strictEqual(wat.guest_read32(queryDesc + 104) >>> 0, 0x218,
    'primary description should retain PRIMARY|FLIP|COMPLEX caps');

  wat.guest_write32(caps, 0x4); // DDSCAPS_BACKBUFFER
  assert.strictEqual(wat.test_dx_backbuffer_get(primary, caps, attachedOut) >>> 0, 0);
  const attached = wat.guest_read32(attachedOut) >>> 0;
  assert(attached, 'GetAttachedSurface should return the linked back buffer');
  assert.strictEqual(wat.guest_read32(attached) >>> 0, 0x52000000,
    'attached surface should retain the DirectDrawSurface vtable');

  const usedBeforeRelease = wat.gdi_dib_arena_stat(0) >>> 0;
  assert.strictEqual(wat.test_dx_surface_release(primary) >>> 0, 0);
  assert((wat.gdi_dib_arena_stat(0) >>> 0) < usedBeforeRelease,
    'releasing a DirectDraw surface should return its DIB pages');

  console.log('PASS  DirectDraw surface descriptions preserve attached back buffers');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
