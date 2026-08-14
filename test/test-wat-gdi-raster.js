#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

(async () => {
  const wasm = await compileWat(file => fs.promises.readFile(path.join(SRC, file), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
  const imports = createHostImports(ctx);
  Object.assign(imports.host, {
    memory, create_thread: () => 0, exit_thread: () => 0,
    create_event: () => 0, set_event: () => 0, reset_event: () => 0,
    wait_single: () => 0, wait_multiple: () => 0,
    com_create_instance: () => 0x80004002,
  });
  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const wat = instance.exports;
  const bytes = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  let nextDesc = 0x00100000;
  let nextBits = 0x02000000;
  let passed = 0;

  function check(name, fn) {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  }

  function surface(width, height, bpp = 32, topDown = true) {
    const desc = nextDesc;
    const bits = nextBits;
    const stride = ((width * bpp + 31) >> 5) << 2;
    nextDesc += 0x100;
    nextBits += stride * height + 0x100;
    dv.setUint32(desc, bits, true);
    dv.setInt32(desc + 4, width, true);
    dv.setInt32(desc + 8, height, true);
    dv.setInt32(desc + 12, stride, true);
    dv.setInt32(desc + 16, bpp, true);
    dv.setInt32(desc + 20, topDown ? 1 : 0, true);
    return { desc, bits, width, height, bpp, stride, topDown };
  }

  function address(s, x, y) {
    const row = s.topDown ? y : s.height - 1 - y;
    return s.bits + row * s.stride + x * (s.bpp >> 3);
  }

  function packed(s, x, y) {
    const p = address(s, x, y);
    return bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
  }

  function setPacked(s, x, y, color) {
    const p = address(s, x, y);
    bytes[p] = color & 255;
    bytes[p + 1] = (color >>> 8) & 255;
    bytes[p + 2] = (color >>> 16) & 255;
    if (s.bpp === 32) bytes[p + 3] = 0xA5;
  }

  check('GetPixel and SetPixel honor COLORREF, stride, orientation, and bounds', () => {
    for (const bpp of [24, 32]) {
      for (const topDown of [false, true]) {
        const s = surface(3, 2, bpp, topDown);
        assert.strictEqual(wat.test_gdi_raster_set_pixel(s.desc, 2, 1, 0x00332211), 0x00332211);
        assert.strictEqual(packed(s, 2, 1), 0x112233);
        assert.strictEqual(wat.test_gdi_raster_get_pixel(s.desc, 2, 1) >>> 0, 0x00332211);
        if (bpp === 32) assert.strictEqual(bytes[address(s, 2, 1) + 3], 0);
        assert.strictEqual(wat.test_gdi_raster_get_pixel(s.desc, 3, 1), -1);
        assert.strictEqual(wat.test_gdi_raster_set_pixel(s.desc, -1, 0, 0), -1);
      }
    }
  });

  check('all 256 ROP3 truth tables match bitwise P:S:D evaluation', () => {
    const p = 0xB4C31A, s = 0x5AD2E1, d = 0x8E7156;
    for (let rop = 0; rop < 256; rop++) {
      let expected = 0;
      for (let bit = 0; bit < 24; bit++) {
        const index = (((p >>> bit) & 1) << 2) |
          (((s >>> bit) & 1) << 1) | ((d >>> bit) & 1);
        if (rop & (1 << index)) expected |= 1 << bit;
      }
      assert.strictEqual(wat.test_gdi_apply_rop3(rop, p, s, d) >>> 0, expected >>> 0,
        `ROP3 0x${rop.toString(16).padStart(2, '0')}`);
    }
  });

  check('BitBlt copies exact pixels across 24/32-bit orientations and clips destination', () => {
    const src = surface(4, 3, 24, false);
    const dst = surface(5, 4, 32, true);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) setPacked(src, x, y, 0x010000 * y + x + 1);
    }
    assert.strictEqual(wat.test_gdi_raster_bitblt(
      dst.desc, -1, 1, 4, 3, src.desc, 0, 0, 0, 0x00CC0020), 1);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) assert.strictEqual(packed(dst, x, y + 1), packed(src, x + 1, y));
    }
    assert.strictEqual(packed(dst, 3, 1), 0);
  });

  check('BitBlt evaluates source/destination ROP3 and pattern-only PatBlt modes', () => {
    const src = surface(2, 1, 32);
    const dst = surface(3, 1, 24);
    setPacked(src, 0, 0, 0x112233);
    setPacked(dst, 1, 0, 0x0F0F0F);
    assert.strictEqual(wat.test_gdi_raster_bitblt(
      dst.desc, 1, 0, 1, 1, src.desc, 0, 0, 0, 0x00660046), 1); // SRCINVERT
    assert.strictEqual(packed(dst, 1, 0), 0x1E2D3C);
    assert.strictEqual(wat.test_gdi_raster_bitblt(
      dst.desc, 0, 0, 3, 1, 0, 0, 0, 0xA1B2C3, 0x00F00021), 1); // PATCOPY
    assert.deepStrictEqual([0, 1, 2].map(x => packed(dst, x, 0)),
      [0xA1B2C3, 0xA1B2C3, 0xA1B2C3]);
    assert.strictEqual(wat.test_gdi_raster_bitblt(
      dst.desc, 0, 0, 3, 1, 0, 0, 0, 0, 0x00550009), 1); // DSTINVERT
    assert.strictEqual(packed(dst, 2, 0), 0x5E4D3C);
  });

  check('overlapping SRCCOPY uses memmove traversal in both directions', () => {
    const s = surface(7, 1, 32);
    for (let x = 0; x < 7; x++) setPacked(s, x, 0, x + 1);
    assert.strictEqual(wat.test_gdi_raster_bitblt(
      s.desc, 2, 0, 5, 1, s.desc, 0, 0, 0, 0x00CC0020), 1);
    assert.deepStrictEqual([...Array(7)].map((_, x) => packed(s, x, 0)), [1, 2, 1, 2, 3, 4, 5]);
    assert.strictEqual(wat.test_gdi_raster_bitblt(
      s.desc, 0, 0, 5, 1, s.desc, 2, 0, 0, 0x00CC0020), 1);
    assert.deepStrictEqual([...Array(7)].map((_, x) => packed(s, x, 0)), [1, 2, 3, 4, 5, 4, 5]);
  });

  check('StretchBlt performs deterministic nearest-neighbor expansion and reduction', () => {
    const src = surface(2, 2, 24);
    const expanded = surface(4, 4, 32);
    const reduced = surface(1, 1, 24);
    [[0x110000, 0x220000], [0x330000, 0x440000]].forEach((row, y) =>
      row.forEach((color, x) => setPacked(src, x, y, color)));
    assert.strictEqual(wat.test_gdi_raster_stretch_blt(
      expanded.desc, 0, 0, 4, 4, src.desc, 0, 0, 2, 2, 0, 0x00CC0020), 1);
    assert.deepStrictEqual([...Array(4)].map((_, x) => packed(expanded, x, 0)),
      [0x110000, 0x110000, 0x220000, 0x220000]);
    assert.deepStrictEqual([...Array(4)].map((_, x) => packed(expanded, x, 3)),
      [0x330000, 0x330000, 0x440000, 0x440000]);
    assert.strictEqual(wat.test_gdi_raster_stretch_blt(
      reduced.desc, 0, 0, 1, 1, src.desc, 0, 0, 2, 2, 0, 0x00CC0020), 1);
    assert.strictEqual(packed(reduced, 0, 0), 0x110000);
    const overlap = surface(4, 1, 24);
    [1, 2, 3, 4].forEach((color, x) => setPacked(overlap, x, 0, color));
    assert.strictEqual(wat.test_gdi_raster_stretch_blt(
      overlap.desc, 0, 0, 4, 1, overlap.desc, 0, 0, 2, 1, 0, 0x00CC0020), 1);
    assert.deepStrictEqual([...Array(4)].map((_, x) => packed(overlap, x, 0)), [1, 1, 2, 2],
      'overlapping expansion must read an immutable source snapshot');
  });

  check('StretchBlt mirrors pixels when source and destination extent signs differ', () => {
    const src = surface(3, 2, 24);
    const horizontal = surface(3, 2, 32);
    const vertical = surface(3, 2, 32);
    const bothNegative = surface(3, 2, 32);
    [[1, 2, 3], [4, 5, 6]].forEach((row, y) =>
      row.forEach((color, x) => setPacked(src, x, y, color)));
    assert.strictEqual(wat.test_gdi_raster_stretch_blt(
      horizontal.desc, 3, 0, -3, 2, src.desc, 0, 0, 3, 2, 0, 0x00CC0020), 1);
    assert.deepStrictEqual([...Array(3)].map((_, x) => packed(horizontal, x, 0)), [3, 2, 1]);
    assert.deepStrictEqual([...Array(3)].map((_, x) => packed(horizontal, x, 1)), [6, 5, 4]);
    assert.strictEqual(wat.test_gdi_raster_stretch_blt(
      vertical.desc, 0, 0, 3, 2, src.desc, 0, 2, 3, -2, 0, 0x00CC0020), 1);
    assert.deepStrictEqual([...Array(3)].map((_, x) => packed(vertical, x, 0)), [4, 5, 6]);
    assert.deepStrictEqual([...Array(3)].map((_, x) => packed(vertical, x, 1)), [1, 2, 3]);
    assert.strictEqual(wat.test_gdi_raster_stretch_blt(
      bothNegative.desc, 3, 2, -3, -2, src.desc, 3, 2, -3, -2, 0, 0x00CC0020), 1);
    assert.deepStrictEqual([...Array(3)].map((_, x) => packed(bothNegative, x, 0)), [1, 2, 3]);
    assert.deepStrictEqual([...Array(3)].map((_, x) => packed(bothNegative, x, 1)), [4, 5, 6]);
  });

  check('StretchBlt snapshots an overlapping surface before an in-place mirror', () => {
    const image = surface(4, 2, 24);
    [[1, 2, 3, 4], [5, 6, 7, 8]].forEach((row, y) =>
      row.forEach((color, x) => setPacked(image, x, y, color)));
    assert.strictEqual(wat.test_gdi_raster_stretch_blt(
      image.desc, 4, 0, -4, 2, image.desc, 0, 0, 4, 2, 0, 0x00CC0020), 1);
    assert.deepStrictEqual([...Array(4)].map((_, x) => packed(image, x, 0)), [4, 3, 2, 1]);
    assert.deepStrictEqual([...Array(4)].map((_, x) => packed(image, x, 1)), [8, 7, 6, 5]);

    const paintImage = surface(320, 200, 24);
    setPacked(paintImage, 0, 100, 0x112233);
    setPacked(paintImage, 319, 100, 0x445566);
    assert.strictEqual(wat.test_gdi_raster_stretch_blt(
      paintImage.desc, 320, 0, -320, 200,
      paintImage.desc, 0, 0, 320, 200, 0, 0x00CC0020), 1);
    assert.strictEqual(packed(paintImage, 0, 100), 0x445566);
    assert.strictEqual(packed(paintImage, 319, 100), 0x112233);
  });

  check('BITMAPINFO descriptors validate true-color and indexed BI_RGB layouts', () => {
    const bmi = nextDesc;
    nextDesc += 0x100;
    dv.setUint32(bmi, 40, true);
    dv.setInt32(bmi + 4, 3, true);
    dv.setInt32(bmi + 8, -2, true);
    dv.setUint16(bmi + 12, 1, true);
    dv.setUint16(bmi + 14, 24, true);
    dv.setUint32(bmi + 16, 0, true);
    const desc = nextDesc;
    nextDesc += 0x100;
    assert.strictEqual(wat.test_gdi_raster_desc_from_bmi(desc, nextBits, bmi), 1);
    assert.deepStrictEqual([
      dv.getUint32(desc, true), dv.getInt32(desc + 4, true), dv.getInt32(desc + 8, true),
      dv.getInt32(desc + 12, true), dv.getInt32(desc + 16, true), dv.getInt32(desc + 20, true),
    ], [nextBits, 3, 2, 12, 24, 1]);
    dv.setUint32(bmi + 16, 1, true); // BI_RLE8
    assert.strictEqual(wat.test_gdi_raster_desc_from_bmi(desc, nextBits, bmi), 0);
    dv.setUint32(bmi + 16, 0, true);
    dv.setUint16(bmi + 14, 8, true);
    assert.strictEqual(wat.test_gdi_raster_desc_from_bmi(desc, nextBits, bmi), 1);
    assert.deepStrictEqual([
      dv.getInt32(desc + 16, true), dv.getUint32(desc + 24, true),
      dv.getInt32(desc + 28, true),
    ], [8, bmi + 40, 256]);
  });

  check('MaskBlt selects foreground/background ROP3 bytes from exact mono mask bits', () => {
    const src = surface(8, 1, 24);
    const dst = surface(8, 1, 32);
    for (let x = 0; x < 8; x++) {
      setPacked(src, x, 0, 0x100000 + x);
      setPacked(dst, x, 0, 0x010101);
    }
    const mask = nextBits;
    nextBits += 0x100;
    bytes[mask] = 0b10110001;
    // Foreground SRCCOPY (CC), background DSTINVERT (55).
    assert.strictEqual(wat.test_gdi_raster_mask_blt(
      dst.desc, 0, 0, 8, 1, src.desc, 0, 0, mask, 4, 0, 0, 0, 0x55CC0020), 1);
    const expected = [
      0x100000, 0xFEFEFE, 0x100002, 0x100003,
      0xFEFEFE, 0xFEFEFE, 0xFEFEFE, 0x100007,
    ];
    assert.deepStrictEqual([...Array(8)].map((_, x) => packed(dst, x, 0)), expected);
  });

  console.log(`\n${passed}/${passed} checks passed`);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
