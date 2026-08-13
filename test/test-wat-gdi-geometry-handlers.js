#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

async function main() {
  const root = path.join(__dirname, '..');
  const wasm = await compileWat(file => fs.promises.readFile(path.join(root, 'src', file), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const base = createHostImports({ getMemory: () => memory.buffer, renderer: null, resourceJson: {} });
  Object.assign(base.host, {
    memory,
    create_thread: () => 0,
    exit_thread: () => 0,
    create_event: () => 0,
    set_event: () => 0,
    reset_event: () => 0,
    wait_single: () => 0,
    wait_multiple: () => 0,
    com_create_instance: () => 0x80004002,
  });
  const { instance } = await WebAssembly.instantiate(wasm, base);
  const wat = instance.exports;
  const bytes = new Uint8Array(memory.buffer);
  let passed = 0;

  function check(name, fn) {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  }

  function makeDib(width, height, bpp = 32, topDown = true) {
    const bmi = wat.guest_alloc(0x100) >>> 0;
    const out = wat.guest_alloc(4) >>> 0;
    wat.guest_write32(bmi, 40);
    wat.guest_write32(bmi + 4, width);
    wat.guest_write32(bmi + 8, topDown ? -height : height);
    wat.guest_write16(bmi + 12, 1);
    wat.guest_write16(bmi + 14, bpp);
    const bitmap = wat.test_call_CreateDIBSection(0, bmi, out) >>> 0;
    const bitsGa = wat.guest_read32(out) >>> 0;
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    assert(bitmap && hdc);
    assert.strictEqual(wat.test_call_SelectObject(hdc, bitmap) >>> 0, 0x30007);
    return {
      bitmap, hdc, width, height, bpp, topDown,
      stride: ((width * bpp + 31) >> 5) << 2,
      bits: 0x1C000000 + (bitsGa - 0x50000000),
    };
  }

  function clear(dib, value = 0) {
    bytes.fill(value, dib.bits, dib.bits + dib.stride * dib.height);
  }

  function pixel(dib, x, y) {
    const row = dib.topDown ? y : dib.height - 1 - y;
    const p = dib.bits + row * dib.stride + x * (dib.bpp >> 3);
    return bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
  }

  function rect(left, top, right, bottom) {
    const p = wat.guest_alloc(16) >>> 0;
    [left, top, right, bottom].forEach((value, i) => wat.guest_write32(p + i * 4, value));
    return p;
  }

  function points(values) {
    const p = wat.guest_alloc(values.length * 8) >>> 0;
    values.forEach(([x, y], i) => {
      wat.guest_write32(p + i * 8, x);
      wat.guest_write32(p + i * 8 + 4, y);
    });
    return p;
  }

  const dib = makeDib(12, 10);
  const redPen = wat.test_call_CreatePen(0, 1, 0x000000FF) >>> 0;
  const greenBrush = wat.test_call_CreateSolidBrush(0x0000FF00) >>> 0;

  check('Rectangle and Ellipse handlers consume selected WAT objects', () => {
    wat.test_call_SelectObject(dib.hdc, redPen);
    wat.test_call_SelectObject(dib.hdc, greenBrush);
    assert.strictEqual(wat.test_call_Rectangle(dib.hdc, 1, 1, 8, 6), 1);
    assert.strictEqual(pixel(dib, 1, 1), 0xFF0000);
    assert.strictEqual(pixel(dib, 3, 3), 0x00FF00);
    clear(dib);
    assert.strictEqual(wat.test_call_Ellipse(dib.hdc, 1, 1, 9, 7), 1);
    assert.strictEqual(pixel(dib, 1, 4), 0xFF0000);
    assert.strictEqual(pixel(dib, 4, 4), 0x00FF00);
  });

  check('FillRect, FrameRect, DrawEdge, and DrawFocusRect route through WAT', () => {
    clear(dib);
    assert.strictEqual(wat.test_call_FillRect(dib.hdc, rect(1, 1, 10, 8), 16), 1);
    assert.strictEqual(pixel(dib, 4, 4), 0xC0C0C0);
    assert.strictEqual(wat.test_call_FrameRect(dib.hdc, rect(2, 2, 9, 7), 0x30014), 1);
    assert.strictEqual(pixel(dib, 2, 4), 0);
    assert.strictEqual(pixel(dib, 4, 4), 0xC0C0C0);
    const adjusted = rect(1, 1, 10, 8);
    assert.strictEqual(wat.test_call_DrawEdge(dib.hdc, adjusted, 5, 0x200F), 1);
    assert.deepStrictEqual([0, 4, 8, 12].map(o => wat.guest_read32(adjusted + o)), [3, 3, 8, 6]);
    assert.strictEqual(pixel(dib, 1, 1), 0xFFFFFF);
    const focus = rect(3, 3, 8, 6);
    const before = bytes.slice(dib.bits, dib.bits + dib.stride * dib.height);
    assert.strictEqual(wat.test_call_DrawFocusRect(dib.hdc, focus), 1);
    assert.strictEqual(wat.test_call_DrawFocusRect(dib.hdc, focus), 1);
    assert.deepStrictEqual(bytes.slice(dib.bits, dib.bits + dib.stride * dib.height), before);
  });

  check('hatched brushes honor origin, background mode, and shape coverage', () => {
    const hatch = wat.test_call_CreateHatchBrush(4, 0x000000FF) >>> 0; // HS_CROSS red
    assert(hatch);
    wat.test_call_SelectObject(dib.hdc, 0x30018); // NULL_PEN
    wat.test_call_SelectObject(dib.hdc, hatch);
    wat.test_gdi_dc_set_field(dib.hdc, 24, 0x0000FF00, 0xFFFFFF); // green background
    wat.test_gdi_dc_set_field(dib.hdc, 28, 2, 2); // OPAQUE
    assert.strictEqual(wat.test_call_SetBrushOrgEx(dib.hdc, 2, 3, 0), 1);
    clear(dib);
    assert.strictEqual(wat.test_call_Rectangle(dib.hdc, 0, 0, 12, 10), 1);
    assert.strictEqual(pixel(dib, 2, 3), 0xFF0000, 'hatch crossing uses foreground');
    assert.strictEqual(pixel(dib, 3, 4), 0x00FF00, 'opaque gap uses DC background');
    wat.test_gdi_dc_set_field(dib.hdc, 28, 1, 2); // TRANSPARENT
    clear(dib, 0x33);
    assert.strictEqual(wat.test_call_Ellipse(dib.hdc, 0, 0, 12, 10), 1);
    assert.strictEqual(pixel(dib, 6, 3), 0xFF0000, 'hatch origin applies to ellipse fill');
    assert.strictEqual(pixel(dib, 6, 4), 0x333333, 'transparent gap preserves destination');
    wat.test_call_SelectObject(dib.hdc, greenBrush);
    wat.test_call_SelectObject(dib.hdc, redPen);
    wat.test_call_SetBrushOrgEx(dib.hdc, 0, 0, 0);
    assert.strictEqual(wat.test_call_DeleteObject(hatch), 1);
  });

  check('Polygon and Polyline handlers rasterize guest POINT arrays', () => {
    clear(dib);
    assert.strictEqual(wat.test_call_Polygon(
      dib.hdc, points([[1, 1], [9, 1], [5, 7]]), 3), 1);
    assert.strictEqual(pixel(dib, 5, 3), 0x00FF00);
    clear(dib);
    assert.strictEqual(wat.test_call_Polyline(
      dib.hdc, points([[1, 1], [7, 1], [7, 6]]), 3), 1);
    assert.strictEqual(pixel(dib, 4, 1), 0xFF0000);
    assert.strictEqual(pixel(dib, 7, 4), 0xFF0000);
  });

  check('MoveToEx, LineTo, and PolylineTo own current position', () => {
    clear(dib);
    assert.strictEqual(wat.test_call_MoveToEx(dib.hdc, 2, 2), 1);
    assert.strictEqual(wat.test_call_LineTo(dib.hdc, 8, 2), 1);
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 12, 0), 8);
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 16, 0), 2);
    assert.strictEqual(wat.test_call_PolylineTo(
      dib.hdc, points([[8, 6], [3, 6]]), 2), 1);
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 12, 0), 3);
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 16, 0), 6);
    assert.strictEqual(pixel(dib, 8, 4), 0xFF0000);
  });

  check('RoundRect, PolyBezier, and Arc use canonical integer pixels', () => {
    clear(dib);
    assert.strictEqual(wat.test_call_RoundRect(dib.hdc, 1, 1, 11, 9, 6, 6), 1);
    assert.strictEqual(pixel(dib, 1, 1), 0, 'rounded corner remains outside');
    assert.strictEqual(pixel(dib, 6, 1), 0xFF0000, 'rounded top edge uses selected pen');
    assert.strictEqual(pixel(dib, 6, 4), 0x00FF00, 'rounded interior uses selected brush');

    clear(dib);
    assert.strictEqual(wat.test_call_PolyBezier(
      dib.hdc, points([[1, 8], [3, 1], [8, 1], [10, 8]]), 4), 1);
    const curvePixels = Array.from({ length: dib.height }, (_, y) =>
      Array.from({ length: dib.width }, (_, x) => pixel(dib, x, y)))
      .flat().filter(Boolean);
    assert(curvePixels.length >= 8, 'Bezier should rasterize a visible curve');
    assert(curvePixels.every(color => color === 0xFF0000), 'Bezier must not produce antialias colors');

    assert.strictEqual(wat.test_call_MoveToEx(dib.hdc, 1, 8), 1);
    assert.strictEqual(wat.test_call_PolyBezierTo(
      dib.hdc, points([[3, 7], [8, 7], [10, 2]]), 3), 1);
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 12, 0), 10);
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 16, 0), 2);

    clear(dib);
    assert.strictEqual(wat.test_call_Arc(dib.hdc, 1, 1, 11, 9, 11, 5, 6, 1), 1);
    const arcPixels = Array.from({ length: dib.height }, (_, y) =>
      Array.from({ length: dib.width }, (_, x) => pixel(dib, x, y)))
      .flat().filter(Boolean);
    assert(arcPixels.length >= 6, 'Arc should rasterize a visible segment');
    assert(arcPixels.every(color => color === 0xFF0000), 'Arc must not produce antialias colors');
  });

  check('extended DC state and mixed PolyDraw commands round-trip in WAT', () => {
    assert.strictEqual(wat.test_call_SetArcDirection(dib.hdc, 2), 1);
    assert.strictEqual(wat.test_call_SetArcDirection(dib.hdc, 1), 2);
    assert.strictEqual(wat.test_call_SetArcDirection(dib.hdc, 9), 0);
    assert.strictEqual(wat.test_call_SetTextCharacterExtra(dib.hdc, 3), 0);
    assert.strictEqual(wat.test_call_GetTextCharacterExtra(dib.hdc), 3);
    assert.strictEqual(wat.test_call_SetTextCharacterExtra(dib.hdc, -2), 3);
    assert.strictEqual(wat.test_call_SetTextJustification(dib.hdc, 7, 2), 1);
    assert.strictEqual(wat.test_gdi_dc_aux_get(dib.hdc, 24, 0), 7);
    assert.strictEqual(wat.test_gdi_dc_aux_get(dib.hdc, 28, 0), 2);
    assert.strictEqual(wat.test_call_SetMapperFlags(dib.hdc, 0x40), 0);
    assert.strictEqual(wat.test_call_SetMapperFlags(dib.hdc, 0x20), 0x40);
    const oldOrigin = rect(0, 0, 0, 0);
    assert.strictEqual(wat.test_call_SetBrushOrgEx(dib.hdc, 4, -3, oldOrigin), 1);
    assert.deepStrictEqual([wat.guest_read32(oldOrigin), wat.guest_read32(oldOrigin + 4)], [0, 0]);
    assert.strictEqual(wat.test_call_SetBrushOrgEx(dib.hdc, 7, 8, oldOrigin), 1);
    assert.deepStrictEqual([wat.guest_read32(oldOrigin), wat.guest_read32(oldOrigin + 4)], [4, -3]);

    clear(dib);
    const path = points([[1, 7], [1, 2], [5, 2], [8, 2], [10, 7]]);
    const types = wat.guest_alloc(8) >>> 0;
    wat.guest_write32(types, 0x04040206);
    wat.guest_write32(types + 4, 5);
    assert.strictEqual(wat.test_call_PolyDraw(dib.hdc, path, types, 5), 1);
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 12, 0), 1,
      'PT_CLOSEFIGURE returns current position to the figure start');
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 16, 0), 7);
    const pathPixels = Array.from({ length: dib.height }, (_, y) =>
      Array.from({ length: dib.width }, (_, x) => pixel(dib, x, y)))
      .flat().filter(Boolean);
    assert(pathPixels.length >= 10);
    assert(pathPixels.every(color => color === 0xFF0000));
  });

  check('clockwise ArcTo connects and updates the current position', () => {
    clear(dib);
    assert.strictEqual(wat.test_call_SetArcDirection(dib.hdc, 2), 1);
    assert.strictEqual(wat.test_call_MoveToEx(dib.hdc, 0, 5), 1);
    assert.strictEqual(wat.test_call_ArcTo(dib.hdc, 1, 1, 11, 9, 11, 5, 6, 1), 1);
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 12, 0), 6);
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 16, 0), 1);
    assert.strictEqual(pixel(dib, 0, 5), 0xFF0000,
      'ArcTo draws the connector from current position');
  });

  console.log(`\n${passed}/${passed} checks passed`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
