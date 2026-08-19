#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { GdiSurface, defaultStride } = require('../lib/gdi-surface');
const { parseDIB } = require('../lib/dib');
const { createHostImports } = require('../lib/host-imports');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS  ${name}`);
}

check('computes DWORD-aligned DIB strides', () => {
  assert.strictEqual(defaultStride(9, 1), 4);
  assert.strictEqual(defaultStride(3, 24), 12);
  assert.strictEqual(defaultStride(3, 24, 2), 10);
});

check('reads and writes bottom-up 24bpp BGR storage', () => {
  const bytes = new Uint8Array(24);
  const surface = new GdiSurface({ width: 3, height: 2, bpp: 24, storage: bytes, topDown: false });
  assert.strictEqual(surface.writePixel(1, 0, 0x00332211), 0x00332211);
  assert.deepStrictEqual(Array.from(bytes.slice(12 + 3, 12 + 6)), [0x33, 0x22, 0x11]);
  assert.strictEqual(surface.readPixel(1, 0), 0x00332211);
  assert.deepStrictEqual(surface.takeDirtyRect(), { x: 1, y: 0, w: 1, h: 1 });
});

check('preserves adjacent packed 1bpp and 4bpp pixels', () => {
  const monoBytes = new Uint8Array(4);
  const mono = new GdiSurface({ width: 8, height: 1, bpp: 1, storage: monoBytes });
  mono.writePixel(0, 0, 0xFFFFFF);
  mono.writePixel(7, 0, 0xFFFFFF);
  assert.strictEqual(monoBytes[0], 0x81);
  assert.strictEqual(mono.readPixel(1, 0), 0);

  const nibbleBytes = new Uint8Array(4);
  const nibble = new GdiSurface({
    width: 2, height: 1, bpp: 4, storage: nibbleBytes,
    palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0]],
  });
  nibble.writePixel(0, 0, 0x000000FF);
  nibble.writePixel(1, 0, 0x0000FF00);
  assert.strictEqual(nibbleBytes[0], 0x12);
  assert.strictEqual(nibble.readPixel(0, 0), 0x000000FF);
  assert.strictEqual(nibble.readPixel(1, 0), 0x0000FF00);
});

check('quantizes indexed pixels against the supplied palette', () => {
  const bytes = new Uint8Array(4);
  const surface = new GdiSurface({
    width: 2, height: 1, bpp: 8, storage: bytes,
    palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0]],
  });
  assert.strictEqual(surface.writePixel(0, 0, 0x000000F0), 0x000000FF);
  assert.strictEqual(bytes[0], 1);
});

check('round-trips default RGB555, explicit RGB565, and RGBA32 storage', () => {
  const rgb555Bytes = new Uint8Array(4);
  const rgb555 = new GdiSurface({ width: 1, height: 1, bpp: 16, storage: rgb555Bytes });
  assert.strictEqual(rgb555.writePixel(0, 0, 0x000000FF), 0x000000FF);
  assert.deepStrictEqual(Array.from(rgb555Bytes.slice(0, 2)), [0x00, 0x7C]);

  const rgb565Bytes = new Uint8Array(4);
  const rgb565 = new GdiSurface({
    width: 1, height: 1, bpp: 16, storage: rgb565Bytes,
    masks: [0xF800, 0x07E0, 0x001F],
  });
  assert.strictEqual(rgb565.writePixel(0, 0, 0x0000FF00), 0x0000FF00);
  assert.deepStrictEqual(Array.from(rgb565Bytes.slice(0, 2)), [0xE0, 0x07]);
  assert.throws(() => new GdiSurface({
    width: 1, height: 1, bpp: 16, storage: new Uint8Array(4),
    masks: [0xF800, 0xF800, 0x001F],
  }), /overlap/);

  const rgbaBytes = new Uint8Array(4);
  const rgba = new GdiSurface({
    width: 1, height: 1, bpp: 32, format: 'rgba32', stride: 4, storage: rgbaBytes,
  });
  rgba.writePixel(0, 0, 0x00563412);
  assert.deepStrictEqual(Array.from(rgbaBytes), [0x12, 0x34, 0x56, 0xFF]);
  assert.strictEqual(rgba.readPixel(0, 0), 0x00563412);
});

check('raw DIB conversion distinguishes RGB555 BI_RGB and RGB565 BI_BITFIELDS', () => {
  function dib16(compression, masks, pixel) {
    const maskBytes = compression === 3 ? 12 : 0;
    const dib = new Uint8Array(40 + maskBytes + 4);
    const dv = new DataView(dib.buffer);
    dv.setUint32(0, 40, true);
    dv.setInt32(4, 1, true);
    dv.setInt32(8, 1, true);
    dv.setUint16(12, 1, true);
    dv.setUint16(14, 16, true);
    dv.setUint32(16, compression, true);
    if (masks) masks.forEach((mask, index) => dv.setUint32(40 + index * 4, mask, true));
    dv.setUint16(40 + maskBytes, pixel, true);
    return dib;
  }
  const rgb555 = parseDIB(dib16(0, null, 0x7C00));
  assert.deepStrictEqual(Array.from(rgb555.pixels), [255, 0, 0, 255]);
  assert.deepStrictEqual(rgb555.masks, [0x7C00, 0x03E0, 0x001F]);
  const rgb565 = parseDIB(dib16(3, [0xF800, 0x07E0, 0x001F], 0x07E0));
  assert.deepStrictEqual(Array.from(rgb565.pixels), [0, 255, 0, 255]);
  assert.deepStrictEqual(rgb565.masks, [0xF800, 0x07E0, 0x001F]);
  assert.strictEqual(parseDIB(dib16(3, [0xF800, 0xF800, 0x001F], 0)), null);
});

check('clips fills and coalesces dirty rectangles', () => {
  let dirtyCalls = 0;
  const surface = new GdiSurface({
    width: 4,
    height: 3,
    bpp: 32,
    storage: new Uint8Array(48),
    onDirty: () => dirtyCalls++,
  });
  assert.strictEqual(surface.fillRect(-1, 1, 4, 3, 0x00112233), true);
  assert.deepStrictEqual(surface.takeDirtyRect(), { x: 0, y: 1, w: 3, h: 2 });
  assert.strictEqual(dirtyCalls, 1);
  assert.strictEqual(surface.readPixel(2, 2), 0x00112233);
  assert.strictEqual(surface.readPixel(3, 2), 0);
});

check('raw presentation uploads canonical DIB bytes without semantic GDI state', () => {
  const memory = new ArrayBuffer(64 * 1024);
  const bytes = new Uint8Array(memory);
  const bits = 0x1000;
  const { host, gdi } = createHostImports({ getMemory: () => memory, exports: {} });
  bytes.set([0x66, 0x55, 0x44], bits); // bottom row, first pixel
  bytes.set([0x33, 0x22, 0x11], bits + 12 + 3); // top row, second pixel
  assert.strictEqual(host.gdi_surface_create(0x1234, 3, 2, 24, bits, 12, 0, 0, 0), 1);
  const canvas = gdi.surfacePresentations.get(0x1234).canvas.getContext('2d');
  assert.deepStrictEqual(Array.from(canvas.getImageData(1, 0, 1, 1).data),
    [0x11, 0x22, 0x33, 0xFF],
    'new presentation cache must start from canonical pixels');
  assert.strictEqual(host.gdi_surface_upload(0x1234, 0, 0, 3, 2), 1);
  assert.deepStrictEqual(Array.from(canvas.getImageData(1, 0, 1, 1).data),
    [0x11, 0x22, 0x33, 0xFF]);
  assert.deepStrictEqual(Array.from(canvas.getImageData(0, 1, 1, 1).data),
    [0x44, 0x55, 0x66, 0xFF]);
  assert.strictEqual(host.gdi_surface_delete(0x1234), 1);
  assert.strictEqual(gdi.surfacePresentations.has(0x1234), false);

  const bits16 = 0x2000;
  bytes[bits16] = 0x00;
  bytes[bits16 + 1] = 0xF8;
  assert.strictEqual(host.gdi_surface_create(
    0x2234, 1, 1, 16, bits16, 4, 1, 0, 0, 0xF800, 0x07E0, 0x001F), 1);
  const canvas16 = gdi.surfacePresentations.get(0x2234).canvas.getContext('2d');
  assert.deepStrictEqual(Array.from(canvas16.getImageData(0, 0, 1, 1).data),
    [0xFF, 0, 0, 0xFF],
    'BI_BITFIELDS masks must reach the derived Canvas presentation cache');
  assert.strictEqual(host.gdi_surface_delete(0x2234), 1);
});

console.log(`\n${passed}/${passed} checks passed`);
