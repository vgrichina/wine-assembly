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

  console.log('PASS IDirect3DDevice2 EnumTextureFormats supplies DDSURFACEDESC');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
