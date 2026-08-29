#!/usr/bin/env node
'use strict';

// Device3 DrawIndexedPrimitive must take the same bound-texture path as
// DrawPrimitive. MW3 obtains a legacy Texture2 handle, binds it through
// D3DRENDERSTATE_TEXTUREHANDLE, then submits its world as indexed vertices.
// Both halves of that authentic chain are covered here: bypassing either one
// produces recognizable terrain geometry with every texture removed.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_diptex_seed")
      (param $ddraw_vtbl i32) (param $surface_vtbl i32) (param $device_vtbl i32)
    (global.set $DX_VTBL_DDRAW (local.get $ddraw_vtbl))
    (global.set $DX_VTBL_DDSURF2 (local.get $surface_vtbl))
    (global.set $DX_VTBL_D3DDEV3 (local.get $device_vtbl)))

  (func (export "test_diptex_create_surface") (param $desc i32) (param $out i32) (result i32)
    (local $ddraw i32)
    (local.set $ddraw (call $dx_create_com_obj (i32.const 1) (global.get $DX_VTBL_DDRAW)))
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDraw_CreateSurface
      (local.get $ddraw) (local.get $desc) (local.get $out) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_diptex_create_device") (param $surface i32) (param $out i32) (result i32)
    (call $d3dim_create_device
      (i32.const 0) (local.get $surface) (local.get $out) (global.get $DX_VTBL_D3DDEV3))
    (global.get $eax))

  (func (export "test_diptex_dib") (param $surface i32) (result i32)
    (i32.load offset=20 (call $dx_from_this (local.get $surface))))

  (func (export "test_diptex_format") (param $surface i32) (result i32)
    (call $dx_surf_fmt_get (call $dx_from_this (local.get $surface))))

  (func (export "test_diptex_get_handle") (param $texture i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirect3DTexture2_GetHandle
      (local.get $texture) (i32.const 0) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_diptex_bind_handle") (param $device i32) (param $handle i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirect3DDevice3_SetRenderState
      (local.get $device) (i32.const 1) (local.get $handle)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_diptex_set_rs") (param $device i32) (param $state i32) (param $value i32)
    (call $d3dim_set_render_state (local.get $device) (local.get $state) (local.get $value)))

  (func (export "test_diptex_draw")
      (param $device i32) (param $vertices i32) (param $indices i32)
    ;; Direct handler calls still read the tail arguments from the guest stack.
    (global.set $esp (i32.const 0x30000))
    (call $gs32 (i32.const 0x30014) (i32.const 3))
    (call $gs32 (i32.const 0x30018) (local.get $indices))
    (call $gs32 (i32.const 0x3001c) (i32.const 3))
    (call $handle_IDirect3DDevice3_DrawIndexedPrimitive
      (local.get $device) (i32.const 4) (i32.const 0x1c4)
      (local.get $vertices) (i32.const 3) (i32.const 0)))
`;

function makeSurface(wat, desc, out, width, height, format = {}) {
  const {
    flags = 0x40,
    bpp = 16,
    rMask = 0xf800,
    gMask = 0x07e0,
    bMask = 0x001f,
    aMask = 0,
  } = format;
  for (let i = 0; i < 128; i += 4) wat.guest_write32(desc + i, 0);
  wat.guest_write32(desc, 108);
  wat.guest_write32(desc + 4, 0x1007); // CAPS|HEIGHT|WIDTH|PIXELFORMAT
  wat.guest_write32(desc + 8, height);
  wat.guest_write32(desc + 12, width);
  wat.guest_write32(desc + 72, 32);
  wat.guest_write32(desc + 76, flags);
  wat.guest_write32(desc + 84, bpp);
  wat.guest_write32(desc + 88, rMask);
  wat.guest_write32(desc + 92, gMask);
  wat.guest_write32(desc + 96, bMask);
  wat.guest_write32(desc + 100, aMask);
  wat.guest_write32(desc + 104, 0x40); // DDSCAPS_OFFSCREENPLAIN
  assert.strictEqual(wat.test_diptex_create_surface(desc, out) >>> 0, 0);
  return wat.guest_read32(out) >>> 0;
}

function writeFloat(wat, addr, value) {
  const bits = new ArrayBuffer(4);
  new DataView(bits).setFloat32(0, value, true);
  wat.guest_write32(addr, new DataView(bits).getUint32(0, true));
}

(async () => {
  const h = await bootRenderHarness({ extraWat, fonts: 'none' });
  const { exports: wat, memory } = h;
  const desc = 0x410000;
  const out = 0x410100;
  const devOut = 0x410110;
  const vertices = 0x411000;
  const indices = 0x411100;

  wat.test_diptex_seed(0x51000000, 0x52000000, 0x53000000);
  const rt = makeSurface(wat, desc, out, 8, 8);
  const texture = makeSurface(wat, desc, out + 4, 2, 2);
  assert(rt && texture);
  assert.strictEqual(wat.test_diptex_create_device(rt, devOut) >>> 0, 0);
  const device = wat.guest_read32(devOut) >>> 0;
  assert(device);

  // A four-colour RGB565 texture.  The surface pitch can exceed width*2, so
  // seed it through its actual DX entry metadata rather than assuming 4 bytes.
  const texDib = wat.test_diptex_dib(texture) >>> 0;
  const mem = new DataView(memory.buffer);
  // DirectDraw's 2x2 allocation uses a DWORD-aligned 4-byte pitch.
  mem.setUint16(texDib + 0, 0xf800, true); // red
  mem.setUint16(texDib + 2, 0x07e0, true); // green
  mem.setUint16(texDib + 4, 0x001f, true); // blue
  mem.setUint16(texDib + 6, 0xffe0, true); // yellow

  // Three TL vertices covering the upper-left half of the 8x8 target.
  const vertex = (i, x, y, u, v) => {
    const p = vertices + i * 32;
    writeFloat(wat, p + 0, x);
    writeFloat(wat, p + 4, y);
    writeFloat(wat, p + 8, 0.5);
    writeFloat(wat, p + 12, 1.0);
    // Half-intensity diffuse verifies the fixed-function MODULATE path used
    // for MW3's lighting, not merely that raw texture texels are copied.
    wat.guest_write32(p + 16, 0xff808080);
    wat.guest_write32(p + 20, 0);
    writeFloat(wat, p + 24, u);
    writeFloat(wat, p + 28, v);
  };
  vertex(0, 0, 0, 0.05, 0.05);
  vertex(1, 7, 0, 0.95, 0.05);
  vertex(2, 0, 7, 0.05, 0.95);
  wat.guest_write32(indices, 0x00010000); // u16 indices 0,1
  wat.guest_write32(indices + 4, 0x00000002); // u16 index 2

  const handleOut = out + 8;
  assert.strictEqual(wat.test_diptex_get_handle(texture, handleOut) >>> 0, 0);
  const textureHandle = wat.guest_read32(handleOut) >>> 0;
  assert(textureHandle, 'Texture2::GetHandle returned a null handle');
  assert.strictEqual(wat.test_diptex_bind_handle(device, textureHandle) >>> 0, 0);
  wat.test_diptex_draw(device, vertices, indices);

  const rtDib = wat.test_diptex_dib(rt) >>> 0;
  const pixels = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) pixels.push(mem.getUint16(rtDib + y * 16 + x * 2, true));
  }
  const textured = new Set(pixels.filter(p => p && p !== 0xffff));
  assert(textured.has(0x8000) || textured.has(0x0400)
      || textured.has(0x0010) || textured.has(0x8400),
    `indexed triangle ignored the bound texture (pixels: ${[...new Set(pixels)].map(p => p.toString(16))})`);

  // MW3 uses ZERO/SRCCOLOR for fixed-function light-map passes. Ignoring the
  // blend state paints the source texture opaquely; the requested operation
  // instead keeps the destination and modulates it by the sampled texture.
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) mem.setUint16(rtDib + y * 16 + x * 2, 0x8410, true);
  }
  for (let i = 0; i < 3; i++) wat.guest_write32(vertices + i * 32 + 16, 0xffffffff);
  wat.test_diptex_set_rs(device, 27, 1); // ALPHABLENDENABLE
  wat.test_diptex_set_rs(device, 19, 1); // SRCBLEND=ZERO
  wat.test_diptex_set_rs(device, 20, 3); // DESTBLEND=SRCCOLOR
  wat.test_diptex_draw(device, vertices, indices);
  assert.strictEqual(mem.getUint16(rtDib, true), 0x8000,
    'ZERO/SRCCOLOR did not modulate the existing render-target pixel');

  // The same path must retain TL vertex alpha for MW3's fade/effect passes.
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) mem.setUint16(rtDib + y * 16 + x * 2, 0x001f, true);
  }
  for (let i = 0; i < 3; i++) wat.guest_write32(vertices + i * 32 + 16, 0x80ffffff);
  wat.test_diptex_set_rs(device, 19, 5); // SRCBLEND=SRCALPHA
  wat.test_diptex_set_rs(device, 20, 6); // DESTBLEND=INVSRCALPHA
  wat.test_diptex_draw(device, vertices, indices);
  assert.strictEqual(mem.getUint16(rtDib, true), 0x800f,
    'SRCALPHA/INVSRCALPHA discarded interpolated vertex alpha');

  // Same-bit-depth formats are not interchangeable. MW3 creates ARGB4444
  // light/detail textures whose common grey texels (for example 0xF678) look
  // like neon green/purple noise when incorrectly decoded as RGB565.
  const alphaTexture = makeSurface(wat, desc, out + 12, 2, 2, {
    flags: 0x41, // DDPF_RGB | DDPF_ALPHAPIXELS
    rMask: 0x0f00,
    gMask: 0x00f0,
    bMask: 0x000f,
    aMask: 0xf000,
  });
  assert.strictEqual(wat.test_diptex_format(alphaTexture), 4,
    'CreateSurface discarded the ARGB4444 channel masks');
  const alphaDib = wat.test_diptex_dib(alphaTexture) >>> 0;
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) mem.setUint16(alphaDib + y * 4 + x * 2, 0xf678, true);
  }
  assert.strictEqual(wat.test_diptex_get_handle(alphaTexture, handleOut) >>> 0, 0);
  assert.strictEqual(wat.test_diptex_bind_handle(device, wat.guest_read32(handleOut) >>> 0) >>> 0, 0);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) mem.setUint16(rtDib + y * 16 + x * 2, 0x001f, true);
  }
  for (let i = 0; i < 3; i++) wat.guest_write32(vertices + i * 32 + 16, 0xffffffff);
  wat.test_diptex_draw(device, vertices, indices);
  assert.strictEqual(mem.getUint16(rtDib, true), 0x63b1,
    'ARGB4444 grey texel was not decoded using its declared channel masks');

  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) mem.setUint16(alphaDib + y * 4 + x * 2, 0x0877, true);
  }
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) mem.setUint16(rtDib + y * 16 + x * 2, 0x001f, true);
  }
  wat.test_diptex_draw(device, vertices, indices);
  assert.strictEqual(mem.getUint16(rtDib, true), 0x001f,
    'transparent ARGB4444 texel did not preserve the destination');

  console.log(`PASS D3DIM Texture2 indexed triangles use declared pixel formats, diffuse lighting, and framebuffer blend state (${textured.size} texture colours)`);
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
