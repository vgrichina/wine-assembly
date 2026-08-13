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
    assert.strictEqual(wat.test_call_PatBlt(dst.hdc, 1, 1, 3, 2, 0x00F00021), 1);
    assert.strictEqual(packed(dst, 2, 2), 0x00FF00);
    assert.strictEqual(canvasRgb(dst, 2, 2), 0x00FF00);
    assert.strictEqual(packed(dst, 0, 0), 0);
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

  console.log(`\n${passed}/${passed} checks passed`);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
