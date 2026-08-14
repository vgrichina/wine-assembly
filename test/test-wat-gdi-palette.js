#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const harness = await bootRenderHarness();
  const wat = harness.exports;
  const memory = harness.memory;
  const bytes = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = ga => (0x12000 + ((ga >>> 0) - imageBase)) >>> 0;
  let passed = 0;

  const check = (name, fn) => {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  };

  function createPalette(colors) {
    const lp = wat.guest_alloc(4 + colors.length * 4) >>> 0;
    wat.guest_write16(lp, 0x0300);
    wat.guest_write16(lp + 2, colors.length);
    colors.forEach((color, index) => wat.guest_write32(lp + 4 + index * 4, color));
    return wat.test_call_CreatePalette(lp) >>> 0;
  }

  function readEntries(palette, start, count) {
    const out = wat.guest_alloc(Math.max(4, count * 4)) >>> 0;
    const copied = wat.test_call_GetPaletteEntries(palette, start, count, out) >>> 0;
    return {
      copied,
      values: Array.from({ length: copied }, (_, i) => wat.guest_read32(out + i * 4) >>> 0),
    };
  }

  function makeBmi(width, height, bpp, colors, usage = 0, pixelBytes = 0) {
    const tableBytes = bpp <= 8 ? colors.length * (usage ? 2 : 4) : 0;
    const ga = wat.guest_alloc(40 + tableBytes + pixelBytes) >>> 0;
    for (let offset = 0; offset < 40 + tableBytes + pixelBytes; offset += 4) {
      wat.guest_write32(ga + offset, 0);
    }
    wat.guest_write32(ga, 40);
    wat.guest_write32(ga + 4, width);
    wat.guest_write32(ga + 8, height);
    wat.guest_write16(ga + 12, 1);
    wat.guest_write16(ga + 14, bpp);
    wat.guest_write32(ga + 16, 0);
    wat.guest_write32(ga + 32, colors.length);
    colors.forEach((color, i) => {
      if (usage) wat.guest_write16(ga + 40 + i * 2, color);
      else wat.guest_write32(ga + 40 + i * 4, color);
    });
    return ga;
  }

  function makeSurface32(width, height) {
    const bmi = makeBmi(width, -height, 32, []);
    const out = wat.guest_alloc(4) >>> 0;
    const bitmap = wat.test_call_CreateDIBSection(0, bmi, out) >>> 0;
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    assert(bitmap && hdc);
    assert.strictEqual(wat.test_call_SelectObject(hdc, bitmap) >>> 0, 0x30007);
    return { bitmap, hdc, bits: wat.test_gdi_bitmap_storage(bitmap) >>> 0 };
  }

  check('palette objects scale past the obsolete four-slot table', () => {
    const palettes = Array.from({ length: 7 }, (_, i) =>
      createPalette([0x00010203 + i, 0x00102030 + i]));
    assert.strictEqual(new Set(palettes).size, palettes.length);
    palettes.forEach((palette, i) => {
      assert.strictEqual(wat.test_gdi_object_type(palette), 5);
      assert.deepStrictEqual(readEntries(palette, 0, 2), {
        copied: 2,
        values: [0x00010203 + i, 0x00102030 + i],
      });
    });
  });

  check('logical palette selection is independent per DC', () => {
    const a = createPalette([0x000000FF, 0x0000FF00]);
    const b = createPalette([0x00FF0000, 0x0000FFFF, 0x00FFFFFF]);
    const dcA = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const dcB = wat.test_call_CreateCompatibleDC(0) >>> 0;
    assert.strictEqual(wat.test_call_GetCurrentObject(dcA, 5) >>> 0, 0x3001F);
    assert.strictEqual(wat.test_call_SelectPalette(dcA, a) >>> 0, 0x3001F);
    assert.strictEqual(wat.test_call_SelectPalette(dcB, b) >>> 0, 0x3001F);
    assert.strictEqual(wat.test_gdi_dc_aux_set(dcA, 28, 6, 0), 0,
      'text justification break count remains independent palette state');
    assert.strictEqual(wat.test_call_GetCurrentObject(dcA, 5) >>> 0, a);
    assert.strictEqual(wat.test_call_GetCurrentObject(dcB, 5) >>> 0, b);
    assert.strictEqual(wat.test_call_RealizePalette(dcA), 2);
    assert.strictEqual(wat.test_call_RealizePalette(dcB), 3);
    assert.strictEqual(wat.test_call_SelectPalette(dcA, 0x3001F) >>> 0, a);
    assert.strictEqual(wat.test_call_GetCurrentObject(dcB, 5) >>> 0, b,
      'changing one DC must not alter another DC palette');
    const saved = wat.test_call_SaveDC(dcB);
    assert.strictEqual(saved, 1);
    assert.strictEqual(wat.test_call_SelectPalette(dcB, 0x3001F) >>> 0, b);
    assert.strictEqual(wat.test_call_RestoreDC(dcB, -1), 1);
    assert.strictEqual(wat.test_call_GetCurrentObject(dcB, 5) >>> 0, b,
      'RestoreDC must restore the selected logical palette');
  });

  check('palette mutation, resize, nearest lookup, and deletion are canonical', () => {
    const palette = createPalette([0x00000000, 0x000000FF, 0x00FFFFFF]);
    const update = wat.guest_alloc(4) >>> 0;
    wat.guest_write32(update, 0x0000FF00);
    assert.strictEqual(wat.test_call_SetPaletteEntries(palette, 1, 1, update), 1);
    assert.deepStrictEqual(readEntries(palette, 0, 3).values,
      [0x00000000, 0x0000FF00, 0x00FFFFFF]);
    assert.strictEqual(wat.test_call_GetNearestPaletteIndex(palette, 0x0000EE10), 1);
    assert.strictEqual(wat.test_call_ResizePalette(palette, 5), 1);
    assert.deepStrictEqual(readEntries(palette, 3, 2).values, [0, 0]);
    assert.strictEqual(wat.test_call_ResizePalette(palette, 2), 1);
    assert.strictEqual(wat.test_call_GetPaletteEntries(palette, 0, 0, 0), 2);
    assert.strictEqual(wat.test_call_DeleteObject(palette), 1);
    assert.strictEqual(wat.test_gdi_object_type(palette), 0);
  });

  check('DIB_PAL_COLORS bitmap creation owns resolved RGBQUADs', () => {
    const palette = createPalette([0x00112233, 0x00A0B0C0]);
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    assert.strictEqual(wat.test_call_SelectPalette(hdc, palette) >>> 0, 0x3001F);
    const bmi = makeBmi(2, -1, 8, [1, 0], 1);
    const out = wat.guest_alloc(4) >>> 0;
    const bitmap = wat.test_call_CreateDIBSectionUsage(hdc, bmi, 1, out) >>> 0;
    assert(bitmap);
    const storage = wat.test_gdi_bitmap_storage(bitmap) >>> 0;
    assert.deepStrictEqual([...bytes.slice(storage + 4, storage + 12)], [
      0xA0, 0xB0, 0xC0, 0,
      0x11, 0x22, 0x33, 0,
    ]);
    wat.guest_write32(bmi + 40, 0xFFFFFFFF);
    assert.deepStrictEqual([...bytes.slice(storage + 4, storage + 12)], [
      0xA0, 0xB0, 0xC0, 0,
      0x11, 0x22, 0x33, 0,
    ]);
  });

  check('DIB_PAL_COLORS tolerates identity slots beyond a logical palette', () => {
    const colors = Array.from({ length: 236 }, (_, i) =>
      i === 0 ? 0x00112233 : (i === 235 ? 0x00A0B0C0 : i));
    const palette = createPalette(colors);
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    assert.strictEqual(wat.test_call_SelectPalette(hdc, palette) >>> 0, 0x3001F);

    const indexes = Array.from({ length: 256 }, (_, i) => i);
    const bmi = makeBmi(4, -1, 8, indexes, 1);
    const out = wat.guest_alloc(4) >>> 0;
    const bitmap = wat.test_call_CreateDIBSectionUsage(hdc, bmi, 1, out) >>> 0;
    assert(bitmap, 'a 256-slot identity table must accept a 236-entry palette');
    const storage = wat.test_gdi_bitmap_storage(bitmap) >>> 0;
    assert.deepStrictEqual([...bytes.slice(storage + 4, storage + 8)],
      [0x11, 0x22, 0x33, 0], 'valid logical palette slots retain their colors');
    assert.deepStrictEqual([...bytes.slice(storage + 4 + 235 * 4, storage + 4 + 237 * 4)], [
      0xA0, 0xB0, 0xC0, 0,
      0, 0, 0, 0,
    ], 'the first missing logical slot resolves deterministically to black');
    assert.deepStrictEqual([...bytes.slice(storage + 4 + 255 * 4, storage + 4 + 256 * 4)],
      [0, 0, 0, 0], 'the final missing identity slot also resolves to black');

    const surface = makeSurface32(4, 1);
    wat.test_call_SelectPalette(surface.hdc, palette);
    const bits = wat.guest_alloc(4) >>> 0;
    bytes.set([0, 235, 236, 255], wa(bits));
    assert.strictEqual(wat.test_gdi_stretch_dibits(
      surface.hdc, 0, 0, 4, 1, 0, 0, 4, 1,
      wa(bits), wa(bmi), 1, 0x00CC0020), 1,
    'transient DIB conversion must tolerate the same unused slots');
    assert.deepStrictEqual([...bytes.slice(surface.bits, surface.bits + 16)], [
      0x11, 0x22, 0x33, 0,
      0xA0, 0xB0, 0xC0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
  });

  check('SetDIBColorTable recolors indexed pixels without changing their bits', () => {
    const bmi = makeBmi(1, -1, 8, [0x00000000, 0x00FFFFFF]);
    const out = wat.guest_alloc(4) >>> 0;
    const bitmap = wat.test_call_CreateDIBSection(0, bmi, out) >>> 0;
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    wat.test_call_SelectObject(hdc, bitmap);
    const storage = wat.test_gdi_bitmap_storage(bitmap) >>> 0;
    bytes[storage] = 0;
    const color = wat.guest_alloc(4) >>> 0;
    wat.guest_write32(color, 0x00FF0000); // RGBQUAD bytes B=0,G=0,R=255
    assert.strictEqual(wat.test_call_SetDIBColorTable(hdc, 0, 1, color), 1);
    assert.strictEqual(bytes[storage], 0, 'palette update must preserve pixel indexes');
    const presentation = harness.gdi.surfacePresentations.get(bitmap);
    const pixel = presentation.canvas.getContext('2d').getImageData(0, 0, 1, 1).data;
    assert.deepStrictEqual([...pixel.slice(0, 3)], [255, 0, 0]);
  });

  check('transient DIB_PAL_COLORS operations use the selected DC palette', () => {
    const palette = createPalette([0x000000FF, 0x0000FF00]); // red, green
    const surface = makeSurface32(2, 1);
    wat.test_call_SelectPalette(surface.hdc, palette);
    const bmi = makeBmi(2, -1, 8, [0, 1], 1);
    const bits = wat.guest_alloc(4) >>> 0;
    bytes.set([0, 1, 0, 0], wa(bits));
    assert.strictEqual(wat.test_gdi_stretch_dibits(
      surface.hdc, 0, 0, 2, 1, 0, 0, 2, 1,
      wa(bits), wa(bmi), 1, 0x00CC0020), 1);
    assert.deepStrictEqual([...bytes.slice(surface.bits, surface.bits + 8)], [
      0, 0, 255, 0,
      0, 255, 0, 0,
    ]);

    bytes.fill(0, surface.bits, surface.bits + 8);
    assert.strictEqual(wat.test_call_SetDIBitsToDevice(
      surface.hdc, 0, 0, 2, 1, 0, 0, 0, 1, bits, bmi, 1), 1);
    assert.deepStrictEqual([...bytes.slice(surface.bits, surface.bits + 8)], [
      0, 0, 255, 0,
      0, 255, 0, 0,
    ]);
  });

  check('DIB_PAL_COLORS pattern brushes resolve at destination-DC use time', () => {
    const paletteA = createPalette([0x000000FF, 0x0000FF00]);
    const paletteB = createPalette([0x00FF0000, 0x0000FFFF]);
    const packed = makeBmi(2, -1, 8, [0, 1], 1, 4);
    const pixelsWa = wa(packed) + 44;
    bytes.set([0, 1, 0, 0], pixelsWa);
    const brush = wat.test_call_CreateDIBPatternBrushPt(packed, 1) >>> 0;
    const dcA = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const dcB = wat.test_call_CreateCompatibleDC(0) >>> 0;
    wat.test_call_SelectPalette(dcA, paletteA);
    wat.test_call_SelectPalette(dcB, paletteB);
    assert.strictEqual(wat.test_gdi_brush_sample(dcA, brush, 0, 0) >>> 0, 0x000000FF);
    assert.strictEqual(wat.test_gdi_brush_sample(dcA, brush, 1, 0) >>> 0, 0x0000FF00);
    assert.strictEqual(wat.test_gdi_brush_sample(dcB, brush, 0, 0) >>> 0, 0x00FF0000);
    assert.strictEqual(wat.test_gdi_brush_sample(dcB, brush, 1, 0) >>> 0, 0x0000FFFF);
  });

  check('GetDIBits emits WORD logical-palette indexes for DIB_PAL_COLORS', () => {
    const sourceBmi = makeBmi(2, -1, 8, [0x000000FF, 0x0000FF00]);
    const sourceOut = wat.guest_alloc(4) >>> 0;
    const bitmap = wat.test_call_CreateDIBSection(0, sourceBmi, sourceOut) >>> 0;
    const storage = wat.test_gdi_bitmap_storage(bitmap) >>> 0;
    bytes.set([0, 1, 0, 0], storage);
    const palette = createPalette([0x000000FF, 0x0000FF00]);
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    wat.test_call_SelectPalette(hdc, palette);
    const outBmi = makeBmi(2, -1, 8, [0, 0], 1);
    const outBits = wat.guest_alloc(4) >>> 0;
    assert.strictEqual(wat.test_gdi_get_dibits(
      hdc, bitmap, 0, 1, wa(outBits), wa(outBmi), 1), 1);
    assert.deepStrictEqual([...bytes.slice(wa(outBmi) + 40, wa(outBmi) + 44)], [0, 0, 1, 0]);
    assert.deepStrictEqual([...bytes.slice(wa(outBits), wa(outBits) + 4)], [0, 1, 0, 0]);
  });

  check('halftone palettes are full canonical palette objects', () => {
    const palette = wat.test_call_CreateHalftonePalette(0) >>> 0;
    assert(palette);
    assert.strictEqual(wat.test_gdi_object_type(palette), 5);
    assert.strictEqual(wat.test_call_GetPaletteEntries(palette, 0, 0, 0), 256);
    assert.strictEqual(readEntries(palette, 0, 1).values[0], 0);
    assert.strictEqual(readEntries(palette, 215, 1).values[0], 0x00FFFFFF);
  });

  console.log(`\n${passed}/${passed} checks passed`);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
