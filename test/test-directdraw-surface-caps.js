#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_dx_caps_seed") (param $ddraw_vtbl i32) (param $surface_vtbl i32)
    (global.set $DX_VTBL_DDRAW (local.get $ddraw_vtbl))
    (global.set $DX_VTBL_DDSURF2 (local.get $surface_vtbl)))
  (func (export "test_dx_caps_create") (param $desc i32) (param $out i32) (result i32)
    (local $ddraw i32)
    (local.set $ddraw (call $dx_create_com_obj (i32.const 1) (global.get $DX_VTBL_DDRAW)))
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDraw_CreateSurface
      (local.get $ddraw) (local.get $desc) (local.get $out) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_dx_caps_get_attached") (param $surface i32) (param $caps i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDrawSurface_GetAttachedSurface
      (local.get $surface) (local.get $caps) (local.get $out) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_dx_caps_desc") (param $surface i32) (param $desc i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDrawSurface_GetSurfaceDesc
      (local.get $surface) (local.get $desc) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const createDesc = 0x410000;
  const primaryOut = 0x410100;
  const attachedCaps = 0x410104;
  const attachedOut = 0x410108;
  const queryDesc = 0x410200;

  wat.test_dx_caps_seed(0x51000000, 0x52000000);
  wat.guest_write32(createDesc, 108);
  wat.guest_write32(createDesc + 4, 0x21); // DDSD_CAPS|BACKBUFFERCOUNT
  wat.guest_write32(createDesc + 20, 1);
  const requested = 0x6218; // PRIMARY|3DDEVICE|VIDEOMEMORY|FLIP|COMPLEX
  wat.guest_write32(createDesc + 104, requested);

  assert.strictEqual(wat.test_dx_caps_create(createDesc, primaryOut) >>> 0, 0);
  const primary = wat.guest_read32(primaryOut) >>> 0;
  assert(primary, 'primary surface should be created');

  assert.strictEqual(wat.test_dx_caps_desc(primary, queryDesc) >>> 0, 0);
  assert.strictEqual(wat.guest_read32(queryDesc + 104) >>> 0, requested,
    'primary GetSurfaceDesc must preserve requested allocation/render caps');

  wat.guest_write32(attachedCaps, 0x4); // DDSCAPS_BACKBUFFER
  assert.strictEqual(
    wat.test_dx_caps_get_attached(primary, attachedCaps, attachedOut) >>> 0, 0);
  const attached = wat.guest_read32(attachedOut) >>> 0;
  assert(attached, 'attached back buffer should be returned');

  assert.strictEqual(wat.test_dx_caps_desc(attached, queryDesc) >>> 0, 0);
  assert.strictEqual(wat.guest_read32(queryDesc + 104) >>> 0, 0x601c,
    'back buffer must inherit 3DDEVICE and VIDEOMEMORY while replacing PRIMARY');

  console.log('PASS  DirectDraw surface descriptions preserve creation and inherited back-buffer caps');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
