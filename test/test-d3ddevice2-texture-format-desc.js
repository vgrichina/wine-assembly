#!/usr/bin/env node
'use strict';

// Direct3D 1/2 use D3DENUMTEXTUREFORMATSCALLBACK, whose first argument is a
// DDSURFACEDESC.  Device3/7 switched to the pixel-format-only callback.  MCM
// reads ddpfPixelFormat at DDSURFACEDESC+72; passing a 32-byte DDPIXELFORMAT
// makes it record unrelated heap bytes and reject every texture format later.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_d3ddev2_enum_begin")
      (param $callback i32) (param $context i32) (param $return_addr i32)
      (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $gs32 (global.get $esp) (local.get $return_addr))
    (call $handle_IDirect3DDevice2_EnumTextureFormats
      (i32.const 0) (local.get $callback) (local.get $context)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $esp))

  (func (export "test_fill_d3d_texture_desc")
      (param $desc i32) (param $index i32)
    (call $d3d_fill_texture_desc (local.get $desc) (local.get $index)))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const callback = 0x12345678;
  const context = 0x410000;
  const returnAddress = 0x10203040;
  const esp = wat.test_d3ddev2_enum_begin(callback, context, returnAddress) >>> 0;

  assert.strictEqual(wat.get_eip() >>> 0, callback,
    'Device2 enumeration should dispatch the supplied callback');
  assert.strictEqual(esp, 0x30000,
    'callback frame should preserve the three-argument stdcall layout');
  const desc = wat.guest_read32(esp + 4) >>> 0;
  assert(desc, 'callback should receive a texture-format descriptor');
  assert.strictEqual(wat.guest_read32(esp + 8) >>> 0, context,
    'callback context should be preserved');
  assert.strictEqual(wat.guest_read32(esp + 12) >>> 0, returnAddress,
    'callback continuation should preserve the API caller return address');

  assert.strictEqual(wat.guest_read32(desc) >>> 0, 108,
    'Device2 callback must receive DDSURFACEDESC, not DDPIXELFORMAT');
  assert.strictEqual(wat.guest_read32(desc + 4) >>> 0, 0x100f,
    'texture descriptor should declare caps, dimensions, pitch and pixel format');
  assert.strictEqual(wat.guest_read32(desc + 72) >>> 0, 32,
    'DDSURFACEDESC.ddpfPixelFormat must begin at offset 72');
  assert.strictEqual(wat.guest_read32(desc + 76) >>> 0, 0x40,
    'first advertised Device2 texture format should be RGB');
  assert.strictEqual(wat.guest_read32(desc + 84) >>> 0, 16,
    'first advertised Device2 texture format should be RGB565');
  assert.strictEqual(wat.guest_read32(desc + 88) >>> 0, 0xf800);
  assert.strictEqual(wat.guest_read32(desc + 92) >>> 0, 0x07e0);
  assert.strictEqual(wat.guest_read32(desc + 96) >>> 0, 0x001f);

  const probeDesc = 0x420000;
  wat.test_fill_d3d_texture_desc(probeDesc, 1);
  assert.strictEqual(wat.guest_read32(probeDesc + 76) >>> 0, 0x41,
    'second advertised format should carry per-pixel alpha');
  assert.strictEqual(wat.guest_read32(probeDesc + 84) >>> 0, 16);
  assert.strictEqual(wat.guest_read32(probeDesc + 88) >>> 0, 0x0f00);
  assert.strictEqual(wat.guest_read32(probeDesc + 92) >>> 0, 0x00f0);
  assert.strictEqual(wat.guest_read32(probeDesc + 96) >>> 0, 0x000f);
  assert.strictEqual(wat.guest_read32(probeDesc + 100) >>> 0, 0xf000,
    'ARGB4444 alpha mask must preserve gradual texture opacity');

  wat.test_fill_d3d_texture_desc(probeDesc, 2);
  assert.strictEqual(wat.guest_read32(probeDesc + 76) >>> 0, 0x41);
  assert.strictEqual(wat.guest_read32(probeDesc + 88) >>> 0, 0x7c00);
  assert.strictEqual(wat.guest_read32(probeDesc + 92) >>> 0, 0x03e0);
  assert.strictEqual(wat.guest_read32(probeDesc + 96) >>> 0, 0x001f);
  assert.strictEqual(wat.guest_read32(probeDesc + 100) >>> 0, 0x8000,
    'ARGB1555 should remain available for binary-alpha textures');

  wat.test_fill_d3d_texture_desc(probeDesc, 3);
  assert.strictEqual(wat.guest_read32(probeDesc + 76) >>> 0, 0x40);
  assert.strictEqual(wat.guest_read32(probeDesc + 84) >>> 0, 32,
    'opaque XRGB8888 should remain available after the 16-bit alpha formats');
  assert.strictEqual(wat.guest_read32(probeDesc + 88) >>> 0, 0x00ff0000);
  assert.strictEqual(wat.guest_read32(probeDesc + 92) >>> 0, 0x0000ff00);
  assert.strictEqual(wat.guest_read32(probeDesc + 96) >>> 0, 0x000000ff);
  assert.strictEqual(wat.guest_read32(probeDesc + 100) >>> 0, 0);

  console.log('PASS IDirect3DDevice2 EnumTextureFormats supplies RGB and alpha DDSURFACEDESC formats');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
