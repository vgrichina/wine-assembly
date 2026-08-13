#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: wat, memory, gdi } = await bootRenderHarness();
  let bytes = new Uint8Array(memory.buffer);
  let passed = 0;

  function check(name, fn) {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  }

  function makeDib(width, height) {
    const bmi = wat.guest_alloc(40) >>> 0;
    const out = wat.guest_alloc(4) >>> 0;
    wat.guest_write32(bmi, 40);
    wat.guest_write32(bmi + 4, width);
    wat.guest_write32(bmi + 8, -height);
    wat.guest_write16(bmi + 12, 1);
    wat.guest_write16(bmi + 14, 32);
    const bitmap = wat.test_call_CreateDIBSection(0, bmi, out) >>> 0;
    const bitsGa = wat.guest_read32(out) >>> 0;
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    assert(bitmap && bitsGa && hdc);
    assert.strictEqual(wat.test_call_SelectObject(hdc, bitmap) >>> 0, 0x30007);
    return {
      bitmap, hdc, width, height, stride: width * 4,
      bits: 0x1C000000 + (bitsGa - 0x50000000),
      presentation: gdi.surfacePresentations.get(bitmap),
    };
  }

  function packed(dib, x, y) {
    const p = dib.bits + y * dib.stride + x * 4;
    return bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
  }

  function canvasRgb(dib, x, y) {
    const p = dib.presentation.canvas.getContext('2d').getImageData(x, y, 1, 1).data;
    return (p[0] << 16) | (p[1] << 8) | p[2];
  }

  const src = makeDib(4, 4);
  const dst = makeDib(8, 6);

  check('SetPixel and GetPixel route through the selected WAT surface', () => {
    assert.strictEqual(wat.test_call_SetPixel(src.hdc, 1, 2, 0x00332211), 0x00332211);
    assert.strictEqual(wat.test_call_GetPixel(src.hdc, 1, 2), 0x00332211);
    assert.strictEqual(packed(src, 1, 2), 0x112233);
    assert.strictEqual(canvasRgb(src, 1, 2), 0x112233);
    assert.strictEqual(wat.test_call_GetPixel(src.hdc, -1, 0), -1);
  });

  check('PatBlt resolves the selected WAT brush and uploads its dirty rectangle', () => {
    const green = wat.test_call_CreateSolidBrush(0x0000FF00) >>> 0;
    wat.test_call_SelectObject(dst.hdc, green);
    assert.strictEqual(wat.test_gdi_rop3_uses_pattern(0xF0), 1);
    assert.strictEqual(wat.test_gdi_dc_get_field(dst.hdc, 8, 0), green);
    assert.strictEqual(wat.test_gdi_brush_sample(dst.hdc, green, 2, 2), 0x0000FF00);
    assert.strictEqual(wat.test_call_PatBlt(dst.hdc, 1, 1, 3, 2, 0x00F00021), 1);
    assert.strictEqual(packed(dst, 2, 2), 0x00FF00);
    assert.strictEqual(canvasRgb(dst, 2, 2), 0x00FF00);
    assert.strictEqual(packed(dst, 0, 0), 0);
  });

  check('PatBlt samples hatch brushes per pixel and honors brush origin', () => {
    const surface = makeDib(10, 4);
    const hatch = wat.test_call_CreateHatchBrush(1, 0x000000FF) >>> 0;
    wat.test_call_SelectObject(surface.hdc, hatch);
    wat.test_gdi_dc_set_field(surface.hdc, 24, 0x0000FF00, 0xFFFFFF);
    wat.test_gdi_dc_set_field(surface.hdc, 28, 2, 2);
    wat.test_call_SetBrushOrgEx(surface.hdc, 2, 0, 0);
    assert.strictEqual(wat.test_call_PatBlt(
      surface.hdc, 0, 0, 10, 4, 0x00F00021), 1);
    assert.strictEqual(packed(surface, 2, 1), 0xFF0000);
    assert.strictEqual(packed(surface, 3, 1), 0x00FF00);
    assert.strictEqual(packed(surface, 9, 1), 0x00FF00);
    assert.strictEqual(canvasRgb(surface, 2, 1), 0xFF0000);
  });

  check('CreatePatternBrush snapshots and repeats canonical bitmap pixels', () => {
    const pattern = makeDib(2, 2);
    wat.test_call_SetPixel(pattern.hdc, 0, 0, 0x000000FF); // red COLORREF
    wat.test_call_SetPixel(pattern.hdc, 1, 0, 0x0000FF00); // green
    wat.test_call_SetPixel(pattern.hdc, 0, 1, 0x00FF0000); // blue
    wat.test_call_SetPixel(pattern.hdc, 1, 1, 0x00FFFFFF); // white
    const brush = wat.test_call_CreatePatternBrush(pattern.bitmap) >>> 0;
    assert(brush);
    assert.strictEqual(wat.test_call_DeleteObject(pattern.bitmap), 1,
      'brush must own a snapshot independent of the source bitmap');
    wat.test_call_SelectObject(dst.hdc, brush);
    wat.test_call_SetBrushOrgEx(dst.hdc, 1, 0, 0);
    assert.strictEqual(wat.test_call_PatBlt(dst.hdc, 0, 0, 4, 2, 0x00F00021), 1);
    assert.strictEqual(packed(dst, 0, 0), 0x00FF00);
    assert.strictEqual(packed(dst, 1, 0), 0xFF0000);
    assert.strictEqual(packed(dst, 0, 1), 0xFFFFFF);
    assert.strictEqual(packed(dst, 1, 1), 0x0000FF);
    assert.strictEqual(wat.test_call_DeleteObject(brush), 1);
  });

  check('CreateDIBPatternBrushPt copies indexed packed DIB pixels', () => {
    const dib = wat.guest_alloc(40 + 8 + 8) >>> 0;
    wat.guest_write32(dib, 40);
    wat.guest_write32(dib + 4, 2);
    wat.guest_write32(dib + 8, -2);
    wat.guest_write16(dib + 12, 1);
    wat.guest_write16(dib + 14, 8);
    wat.guest_write32(dib + 32, 2);
    const imageBase = wat.get_image_base() >>> 0;
    const wa = 0x12000 + (dib - imageBase);
    bytes = new Uint8Array(memory.buffer);
    bytes.set([0x00, 0x00, 0xFF, 0, 0xFF, 0x00, 0x00, 0], wa + 40);
    bytes.set([0, 1, 0, 0, 1, 0, 0, 0], wa + 48);
    const brush = wat.test_call_CreateDIBPatternBrushPt(dib, 0) >>> 0;
    assert(brush);
    wat.test_call_SelectObject(dst.hdc, brush);
    wat.test_call_SetBrushOrgEx(dst.hdc, 0, 0, 0);
    assert.strictEqual(wat.test_call_PatBlt(dst.hdc, 0, 0, 2, 2, 0x00F00021), 1);
    assert.strictEqual(packed(dst, 0, 0), 0xFF0000);
    assert.strictEqual(packed(dst, 1, 0), 0x0000FF);
    assert.strictEqual(packed(dst, 0, 1), 0x0000FF);
    assert.strictEqual(packed(dst, 1, 1), 0xFF0000);
    assert.strictEqual(wat.test_call_DeleteObject(brush), 1);
    assert.strictEqual(wat.test_call_CreateDIBPatternBrushPt(dib, 1), 0,
      'DIB_PAL_COLORS must fail until selected palette realization is owned');
  });

  check('BitBlt applies SRCCOPY between canonical WAT surfaces', () => {
    assert.strictEqual(wat.test_call_BitBlt(
      dst.hdc, 4, 1, 2, 3, src.hdc, 0, 1, 0x00CC0020), 1);
    assert.strictEqual(packed(dst, 5, 2), 0x112233);
    assert.strictEqual(canvasRgb(dst, 5, 2), 0x112233);
  });

  check('BitBlt preserves destination pixels outside the WAT DC clip region', () => {
    const clipped = makeDib(4, 4);
    const clip = wat.test_gdi_rgn_alloc_rect(1, 1, 3, 3) >>> 0;
    assert(clip);
    assert.strictEqual(wat.test_gdi_dc_clip_select(clipped.hdc, clip), 2);
    assert.strictEqual(wat.test_call_BitBlt(
      clipped.hdc, 0, 0, 4, 4, src.hdc, 0, 0, 0x00CC0020), 1);
    assert.strictEqual(packed(clipped, 1, 2), 0x112233);
    assert.strictEqual(packed(clipped, 0, 2), 0);
    assert.strictEqual(canvasRgb(clipped, 0, 2), 0);
  });

  check('StretchBlt expands pixels with deterministic nearest-neighbor sampling', () => {
    assert.strictEqual(wat.test_call_StretchBlt(
      dst.hdc, 0, 3, 4, 2, src.hdc, 0, 2, 2, 1, 0x00CC0020), 1);
    assert.strictEqual(packed(dst, 2, 4), 0x112233);
    assert.strictEqual(canvasRgb(dst, 2, 4), 0x112233);
  });

  check('SetDIBitsToDevice decodes indexed RGBQUAD sprites in WAT', () => {
    const bmiGa = wat.guest_alloc(40 + 16 * 4) >>> 0;
    const bitsGa = wat.guest_alloc(8) >>> 0;
    bytes = new Uint8Array(memory.buffer);
    wat.guest_write32(bmiGa, 40);
    wat.guest_write32(bmiGa + 4, 4);
    // Winmine advertises a tall sprite sheet but supplies one scanline slice
    // per call. The source pointer below owns only these two rows.
    wat.guest_write32(bmiGa + 8, 256);
    wat.guest_write16(bmiGa + 12, 1);
    wat.guest_write16(bmiGa + 14, 4);
    wat.guest_write32(bmiGa + 32, 16);
    const imageBase = wat.get_image_base() >>> 0;
    const bmiWa = 0x12000 + (bmiGa - imageBase);
    const bitsWa = 0x12000 + (bitsGa - imageBase);
    // RGBQUAD index 1 = red, index 2 = green, index 3 = blue.
    bytes.set([0x00, 0x00, 0xFF, 0x00], bmiWa + 40 + 4);
    bytes.set([0x00, 0xFF, 0x00, 0x00], bmiWa + 40 + 8);
    bytes.set([0xFF, 0x00, 0x00, 0x00], bmiWa + 40 + 12);
    // Two DWORD-aligned 4-bpp rows: 1,2,3,1 and 3,2,1,3.
    bytes.set([0x12, 0x31, 0, 0, 0x32, 0x13, 0, 0], bitsWa);
    assert.strictEqual(wat.test_call_SetDIBitsToDevice(
      dst.hdc, 1, 0, 4, 2, 0, 0, 0, 2, bitsGa, bmiGa, 0), 2);
    assert.strictEqual(packed(dst, 1, 0), 0x0000FF);
    assert.strictEqual(packed(dst, 2, 0), 0x00FF00);
    assert.strictEqual(packed(dst, 3, 0), 0xFF0000);
    assert.strictEqual(packed(dst, 1, 1), 0xFF0000);
    assert.strictEqual(canvasRgb(dst, 2, 1), 0x00FF00);
  });

  check('ExtFloodFill owns surface and border modes in WAT', () => {
    const surface = makeDib(6, 6);
    const red = wat.test_call_CreateSolidBrush(0x000000FF) >>> 0;
    wat.test_call_SelectObject(surface.hdc, red);
    for (let y = 1; y < 5; y++) {
      for (let x = 1; x < 5; x++) {
        const p = surface.bits + y * surface.stride + x * 4;
        bytes[p] = bytes[p + 1] = bytes[p + 2] = 0xFF;
      }
    }
    assert.strictEqual(wat.test_call_ExtFloodFill(
      surface.hdc, 2, 2, 0x00FFFFFF, 1), 1);
    assert.strictEqual(packed(surface, 2, 2), 0xFF0000);
    assert.strictEqual(packed(surface, 0, 0), 0);

    const border = makeDib(6, 6);
    wat.test_call_SelectObject(border.hdc, red);
    for (let x = 1; x < 5; x++) {
      for (const y of [1, 4]) bytes.fill(0xFF, border.bits + y * border.stride + x * 4,
        border.bits + y * border.stride + x * 4 + 3);
    }
    for (let y = 1; y < 5; y++) {
      for (const x of [1, 4]) bytes.fill(0xFF, border.bits + y * border.stride + x * 4,
        border.bits + y * border.stride + x * 4 + 3);
    }
    assert.strictEqual(wat.test_call_ExtFloodFill(border.hdc, 2, 2, 0x00FFFFFF, 0), 1);
    assert.strictEqual(packed(border, 2, 2), 0xFF0000);
    assert.strictEqual(packed(border, 1, 2), 0xFFFFFF);
    assert.strictEqual(packed(border, 0, 0), 0);
  });

  check('ExtFloodFill samples hatch pixels without changing region discovery', () => {
    const surface = makeDib(9, 4);
    const hatch = wat.test_call_CreateHatchBrush(0, 0x00FF0000) >>> 0;
    wat.test_call_SelectObject(surface.hdc, hatch);
    wat.test_gdi_dc_set_field(surface.hdc, 28, 1, 2);
    bytes.fill(0x44, surface.bits, surface.bits + surface.stride * surface.height);
    assert.strictEqual(wat.test_call_ExtFloodFill(
      surface.hdc, 1, 1, 0x00444444, 1), 1);
    assert.strictEqual(packed(surface, 4, 0), 0x0000FF);
    assert.strictEqual(packed(surface, 4, 1), 0x444444);
  });

  check('internal bitmap and mapping adapters use canonical WAT records', () => {
    assert.strictEqual(wat.test_gdi_object_width(src.bitmap), 4);
    assert.strictEqual(wat.test_gdi_object_height(src.bitmap), 4);
    assert.strictEqual(wat.test_gdi_mapping_adapters(src.hdc), 1);
    // Restore identity mapping for the raster adapter checks below.
    wat.test_gdi_dc_set_field(src.hdc, 40, 0, 0);
    wat.test_gdi_dc_set_field(src.hdc, 44, 0, 0);
    wat.test_gdi_dc_set_field(src.hdc, 48, 1, 1);
    wat.test_gdi_dc_set_field(src.hdc, 52, 1, 1);
    wat.test_gdi_dc_set_field(src.hdc, 56, 0, 0);
    wat.test_gdi_dc_set_field(src.hdc, 60, 0, 0);
    wat.test_gdi_dc_set_field(src.hdc, 64, 1, 1);
    wat.test_gdi_dc_set_field(src.hdc, 68, 1, 1);
  });

  check('internal BitBlt adapter shares the public canonical raster path', () => {
    const target = makeDib(4, 4);
    assert.strictEqual(wat.test_gdi_hdc_bitblt(
      target.hdc, 0, 0, 4, 4, src.hdc, 0, 0, 0x00CC0020), 1);
    assert.strictEqual(packed(target, 1, 2), 0x112233);
    assert.strictEqual(canvasRgb(target, 1, 2), 0x112233);
  });

  check('transparent and disabled adapters apply exact color-key masks', () => {
    const sprite = makeDib(3, 2);
    const transparent = makeDib(5, 4);
    const disabled = makeDib(5, 4);
    // Source storage is BGR: magenta key at (0,0), green glyph at (1,0).
    bytes.set([0xFF, 0x00, 0xFF, 0x00], sprite.bits);
    bytes.set([0x00, 0xFF, 0x00, 0x00], sprite.bits + 4);
    assert.strictEqual(wat.test_gdi_hdc_transparent_blt(
      transparent.hdc, 1, 1, 2, 1, sprite.hdc, 0, 0, 0x00FF00FF), 1);
    assert.strictEqual(packed(transparent, 1, 1), 0);
    assert.strictEqual(packed(transparent, 2, 1), 0x00FF00);
    assert.strictEqual(wat.test_gdi_hdc_disabled_blt(
      disabled.hdc, 1, 1, 2, 1, sprite.hdc, 0, 0, 0x00FF00FF), 1);
    assert.strictEqual(packed(disabled, 1, 1), 0);
    assert.strictEqual(packed(disabled, 2, 1), 0x808080);
    assert.strictEqual(packed(disabled, 3, 2), 0xFFFFFF);
  });

  check('FillRgn and FrameRgn consume WAT region bands', () => {
    const surface = makeDib(8, 7);
    const red = wat.test_call_CreateSolidBrush(0x000000FF) >>> 0;
    const green = wat.test_call_CreateSolidBrush(0x0000FF00) >>> 0;
    const region = wat.test_gdi_rgn_alloc_rect(2, 1, 7, 6) >>> 0;
    assert.strictEqual(wat.test_gdi_hdc_fill_rgn(surface.hdc, region, red), 1);
    assert.strictEqual(packed(surface, 3, 3), 0xFF0000);
    assert.strictEqual(packed(surface, 1, 3), 0);
    assert.strictEqual(wat.test_gdi_hdc_frame_rgn(surface.hdc, region, green, 1, 1), 1);
    assert.strictEqual(packed(surface, 2, 3), 0x00FF00);
    assert.strictEqual(packed(surface, 3, 3), 0xFF0000);
  });

  check('GetDIBits and SetDIBits convert canonical scanline slices', () => {
    const surface = makeDib(3, 3);
    wat.test_call_SetPixel(surface.hdc, 0, 0, 0x000000FF); // red top
    wat.test_call_SetPixel(surface.hdc, 1, 1, 0x0000FF00); // green middle
    wat.test_call_SetPixel(surface.hdc, 2, 2, 0x00FF0000); // blue bottom
    const bmiGa = wat.guest_alloc(40) >>> 0;
    const outGa = wat.guest_alloc(36) >>> 0;
    const imageBase = wat.get_image_base() >>> 0;
    const bmiWa = 0x12000 + (bmiGa - imageBase);
    const outWa = 0x12000 + (outGa - imageBase);
    wat.guest_write32(bmiGa, 40);
    wat.guest_write32(bmiGa + 8, 3);
    wat.guest_write16(bmiGa + 12, 1);
    wat.guest_write16(bmiGa + 14, 24);
    assert.strictEqual(wat.test_gdi_get_dibits(surface.bitmap, 0, 3, outWa, bmiWa, 0), 3);
    // Bottom-up output begins with the blue bottom scanline (DWORD stride 12).
    assert.deepStrictEqual([...bytes.slice(outWa + 6, outWa + 9)], [0xFF, 0x00, 0x00]);
    const copy = makeDib(3, 3);
    assert.strictEqual(wat.test_gdi_set_dibits(copy.bitmap, 0, 3, outWa, bmiWa, 0), 3);
    assert.strictEqual(packed(copy, 0, 0), 0xFF0000);
    assert.strictEqual(packed(copy, 1, 1), 0x00FF00);
    assert.strictEqual(packed(copy, 2, 2), 0x0000FF);
  });

  check('GetDIBColorTable returns the selected indexed bitmap RGBQUADs', () => {
    const bmiGa = wat.guest_alloc(48) >>> 0;
    const outGa = wat.guest_alloc(4) >>> 0;
    const imageBase = wat.get_image_base() >>> 0;
    const bmiWa = 0x12000 + (bmiGa - imageBase);
    wat.guest_write32(bmiGa, 40);
    wat.guest_write32(bmiGa + 4, 2);
    wat.guest_write32(bmiGa + 8, -1);
    wat.guest_write16(bmiGa + 12, 1);
    wat.guest_write16(bmiGa + 14, 1);
    wat.guest_write32(bmiGa + 32, 2);
    bytes.set([0x00, 0x00, 0xFF, 0x00, 0x00, 0xFF, 0x00, 0x00], bmiWa + 40);
    const bitmap = wat.test_call_CreateDIBSection(0, bmiGa, outGa) >>> 0;
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    wat.test_call_SelectObject(hdc, bitmap);
    const colorsGa = wat.guest_alloc(8) >>> 0;
    const colorsWa = 0x12000 + (colorsGa - imageBase);
    assert.strictEqual(wat.test_gdi_get_dib_color_table(hdc, 0, 2, colorsWa), 2);
    assert.deepStrictEqual([...bytes.slice(colorsWa, colorsWa + 8)],
      [0x00, 0x00, 0xFF, 0x00, 0x00, 0xFF, 0x00, 0x00]);
  });

  check('StretchDIBits converts and scales application-owned pixels', () => {
    const surface = makeDib(4, 4);
    const bmiGa = wat.guest_alloc(40) >>> 0;
    const bitsGa = wat.guest_alloc(16) >>> 0;
    const imageBase = wat.get_image_base() >>> 0;
    const bmiWa = 0x12000 + (bmiGa - imageBase);
    const bitsWa = 0x12000 + (bitsGa - imageBase);
    wat.guest_write32(bmiGa, 40);
    wat.guest_write32(bmiGa + 4, 2);
    wat.guest_write32(bmiGa + 8, -2);
    wat.guest_write16(bmiGa + 12, 1);
    wat.guest_write16(bmiGa + 14, 24);
    wat.guest_write32(bmiGa + 16, 0);
    // top-down: red, green / blue, white with 8-byte stride
    bytes.set([0, 0, 255, 0, 255, 0, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0], bitsWa);
    assert.strictEqual(wat.test_gdi_rop3_uses_pattern(0xCC), 0);
    assert.strictEqual(wat.test_gdi_stretch_dibits(
      surface.hdc, 0, 0, 4, 4, 0, 0, 2, 2, bitsWa, bmiWa, 0, 0x00CC0020), 2);
    assert.strictEqual(packed(surface, 0, 0), 0xFF0000);
    assert.strictEqual(packed(surface, 3, 0), 0x00FF00);
    assert.strictEqual(packed(surface, 0, 3), 0x0000FF);
    assert.strictEqual(packed(surface, 3, 3), 0xFFFFFF);
    assert.strictEqual(canvasRgb(surface, 3, 3), 0xFFFFFF);
  });

  console.log(`\n${passed}/${passed} checks passed`);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
