#!/usr/bin/env node
'use strict';

// An 8bpp DirectDraw surface must describe itself as DDPF_PALETTEINDEXED8 with
// no RGB masks, and GetPalette must hand back an object bound to the palette
// the surface actually carries. When either half lies, a caller that converts
// palettized art to 16bpp reads index bytes through 5-6-5 masks (dark blue
// noise) or reads an all-zero colour table (black silhouettes) -- both of which
// d3drm did to Organic Art's leaf textures.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_ddpf_seed") (param $ddraw_vtbl i32) (param $surface_vtbl i32) (param $pal_vtbl i32)
    (global.set $DX_VTBL_DDRAW (local.get $ddraw_vtbl))
    (global.set $DX_VTBL_DDSURF2 (local.get $surface_vtbl))
    (global.set $DX_VTBL_DDPAL (local.get $pal_vtbl)))
  (func (export "test_ddpf_create") (param $desc i32) (param $out i32) (result i32)
    (local $ddraw i32)
    (local.set $ddraw (call $dx_create_com_obj (i32.const 1) (global.get $DX_VTBL_DDRAW)))
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDraw_CreateSurface
      (local.get $ddraw) (local.get $desc) (local.get $out) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_ddpf_get_pixel_format") (param $surface i32) (param $pf i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDrawSurface_GetPixelFormat
      (local.get $surface) (local.get $pf) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_ddpf_get_surface_desc") (param $surface i32) (param $desc i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDrawSurface_GetSurfaceDesc
      (local.get $surface) (local.get $desc) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_ddpf_create_palette") (param $entries i32) (param $out i32) (result i32)
    (local $ddraw i32)
    (local.set $ddraw (call $dx_create_com_obj (i32.const 1) (global.get $DX_VTBL_DDRAW)))
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDraw_CreatePalette
      (local.get $ddraw) (i32.const 0) (local.get $entries) (local.get $out)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_ddpf_set_palette") (param $surface i32) (param $pal i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDrawSurface_SetPalette
      (local.get $surface) (local.get $pal) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_ddpf_get_palette") (param $surface i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDrawSurface_GetPalette
      (local.get $surface) (local.get $out) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_ddpf_get_entries") (param $pal i32) (param $count i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDrawPalette_GetEntries
      (local.get $pal) (i32.const 0) (i32.const 0) (local.get $count)
      (local.get $out) (i32.const 0))
    (global.get $eax))
`;

const DDPF_RGB = 0x40;
const DDPF_PALETTEINDEXED8 = 0x20;

const createSurface = (wat, desc, out, bpp, caps) => {
  for (let i = 0; i < 128; i += 4) wat.guest_write32(desc + i, 0);
  wat.guest_write32(desc, 108);
  wat.guest_write32(desc + 4, 0x1007);   // CAPS|HEIGHT|WIDTH|PIXELFORMAT
  wat.guest_write32(desc + 8, 32);       // dwHeight
  wat.guest_write32(desc + 12, 32);      // dwWidth
  wat.guest_write32(desc + 72, 32);      // ddpfPixelFormat.dwSize
  wat.guest_write32(desc + 76, bpp === 8 ? (DDPF_RGB | DDPF_PALETTEINDEXED8) : DDPF_RGB);
  wat.guest_write32(desc + 84, bpp);     // dwRGBBitCount
  wat.guest_write32(desc + 104, caps);
  assert.strictEqual(wat.test_ddpf_create(desc, out) >>> 0, 0);
  const surface = wat.guest_read32(out) >>> 0;
  assert(surface, `surface should be published for ${bpp}bpp`);
  return surface;
};

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const desc = 0x410000;
  const out = 0x410200;
  const pf = 0x410240;
  const query = 0x410300;
  const entriesIn = 0x411000;
  const entriesOut = 0x412000;
  const palOut = 0x410280;

  wat.test_ddpf_seed(0x51000000, 0x52000000, 0x53000000);

  // --- 8bpp offscreen: palettized, no masks -------------------------------
  const surf8 = createSurface(wat, desc, out, 8, 0x40); // OFFSCREENPLAIN
  assert.strictEqual(wat.test_ddpf_get_pixel_format(surf8, pf) >>> 0, 0);
  assert.strictEqual(wat.guest_read32(pf + 12) >>> 0, 8, '8bpp surface reports 8 bits');
  const flags8 = wat.guest_read32(pf + 4) >>> 0;
  assert(flags8 & DDPF_PALETTEINDEXED8,
    `8bpp surface must set DDPF_PALETTEINDEXED8 (got 0x${flags8.toString(16)})`);
  for (const off of [16, 20, 24]) {
    assert.strictEqual(wat.guest_read32(pf + off) >>> 0, 0,
      `a palettized format carries no RGB mask at +${off}`);
  }

  // GetSurfaceDesc must agree with GetPixelFormat.
  assert.strictEqual(wat.test_ddpf_get_surface_desc(surf8, query) >>> 0, 0);
  assert.strictEqual(wat.guest_read32(query + 84) >>> 0, 8);
  assert(wat.guest_read32(query + 76) & DDPF_PALETTEINDEXED8,
    'GetSurfaceDesc must report the same palettized format as GetPixelFormat');
  assert.strictEqual(wat.guest_read32(query + 88) >>> 0, 0,
    'GetSurfaceDesc must not leave a 5-6-5 red mask on a palettized surface');

  // --- 16bpp: RGB with 5-6-5 masks ----------------------------------------
  const surf16 = createSurface(wat, desc, out, 16, 0x40);
  assert.strictEqual(wat.test_ddpf_get_pixel_format(surf16, pf) >>> 0, 0);
  assert.strictEqual(wat.guest_read32(pf + 12) >>> 0, 16);
  assert.strictEqual(wat.guest_read32(pf + 4) >>> 0, DDPF_RGB,
    '16bpp surface is plain DDPF_RGB');
  assert.strictEqual(wat.guest_read32(pf + 16) >>> 0, 0xF800);
  assert.strictEqual(wat.guest_read32(pf + 20) >>> 0, 0x07E0);
  assert.strictEqual(wat.guest_read32(pf + 24) >>> 0, 0x001F);

  // --- GetPalette round trip ----------------------------------------------
  // Distinctive entries so an all-zero read-back cannot pass by accident.
  for (let i = 0; i < 256; i++) {
    wat.guest_write32(entriesIn + i * 4, (i * 7) & 0xFF | (((i * 3) & 0xFF) << 8) | (((255 - i) & 0xFF) << 16));
  }
  assert.strictEqual(wat.test_ddpf_create_palette(entriesIn, palOut) >>> 0, 0);
  const palette = wat.guest_read32(palOut) >>> 0;
  assert(palette, 'CreatePalette should publish an object');

  assert.strictEqual(wat.test_ddpf_set_palette(surf8, palette) >>> 0, 0);
  for (let i = 0; i < 256; i++) wat.guest_write32(entriesOut + i * 4, 0xDEADBEEF);
  assert.strictEqual(wat.test_ddpf_get_palette(surf8, palOut + 8) >>> 0, 0);
  const fetched = wat.guest_read32(palOut + 8) >>> 0;
  assert(fetched, 'GetPalette should publish an object');

  assert.strictEqual(wat.test_ddpf_get_entries(fetched, 256, entriesOut) >>> 0, 0);
  for (let i = 0; i < 256; i++) {
    assert.strictEqual(wat.guest_read32(entriesOut + i * 4) >>> 0,
      wat.guest_read32(entriesIn + i * 4) >>> 0,
      `GetPalette->GetEntries must return the surface's own colour table (entry ${i})`);
  }

  console.log('PASS test-directdraw-palette-format');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
