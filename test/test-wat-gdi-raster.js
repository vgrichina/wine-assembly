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

  function surface(width, height, bpp = 32, topDown = true, masks = null) {
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
    if (masks) {
      dv.setUint32(desc + 24, masks[0], true);
      dv.setUint32(desc + 28, masks[1], true);
      dv.setUint32(desc + 64, masks[2], true);
    }
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

  check('16-bpp pixels distinguish BI_RGB RGB555 from explicit RGB565 masks', () => {
    const rgb555 = surface(2, 1, 16);
    assert.strictEqual(wat.test_gdi_raster_set_pixel(rgb555.desc, 0, 0, 0x000000FF), 0x000000FF);
    assert.strictEqual(dv.getUint16(address(rgb555, 0, 0), true), 0x7C00);
    assert.strictEqual(wat.test_gdi_raster_set_pixel(rgb555.desc, 1, 0, 0x0000FF00), 0x0000FF00);
    assert.strictEqual(dv.getUint16(address(rgb555, 1, 0), true), 0x03E0);
    assert.strictEqual(wat.test_gdi_raster_get_pixel(rgb555.desc, 0, 0) >>> 0, 0x000000FF);

    const rgb565 = surface(2, 1, 16, true, [0xF800, 0x07E0, 0x001F]);
    assert.strictEqual(wat.test_gdi_raster_set_pixel(rgb565.desc, 0, 0, 0x000000FF), 0x000000FF);
    assert.strictEqual(dv.getUint16(address(rgb565, 0, 0), true), 0xF800);
    assert.strictEqual(wat.test_gdi_raster_set_pixel(rgb565.desc, 1, 0, 0x0000FF00), 0x0000FF00);
    assert.strictEqual(dv.getUint16(address(rgb565, 1, 0), true), 0x07E0);

    const rgb444 = surface(1, 1, 16, true, [0x0F00, 0x00F0, 0x000F]);
    assert.strictEqual(wat.test_gdi_raster_set_pixel(rgb444.desc, 0, 0, 0x00FFFFFF), 0x00FFFFFF);
    assert.strictEqual(dv.getUint16(address(rgb444, 0, 0), true), 0x0FFF);
  });

  check('BitBlt converts colors between RGB555 and RGB565 surfaces', () => {
    const src = surface(3, 1, 16);
    const dst = surface(3, 1, 16, true, [0xF800, 0x07E0, 0x001F]);
    [0x000000FF, 0x0000FF00, 0x00FF0000].forEach((color, x) => {
      assert.strictEqual(wat.test_gdi_raster_set_pixel(src.desc, x, 0, color), color);
    });
    assert.strictEqual(wat.test_gdi_raster_bitblt(
      dst.desc, 0, 0, 3, 1, src.desc, 0, 0, 0, 0x00CC0020), 1);
    assert.deepStrictEqual([0, 1, 2].map(x => dv.getUint16(address(dst, x, 0), true)),
      [0xF800, 0x07E0, 0x001F]);
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

  check('32-bpp bulk paths preserve clipping, orientation, ROPs, and XRGB bytes', () => {
    const src = surface(5, 3, 32, false);
    const dst = surface(6, 4, 32, true);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) setPacked(src, x, y, 0x10000 * (y + 1) + x + 1);
    }
    wat.test_gdi_fast_reset();
    assert.strictEqual(wat.test_gdi_raster_bitblt(
      dst.desc, -1, 1, 5, 3, src.desc, 0, 0, 0, 0x00CC0020), 1);
    assert(wat.test_gdi_fast_count(1) > 0, 'SRCCOPY did not use the 32-bpp bulk path');
    assert.strictEqual(packed(dst, 0, 1), packed(src, 1, 0));
    assert.strictEqual(packed(dst, 3, 3), packed(src, 4, 2));
    assert.strictEqual(packed(dst, 4, 1), 0);
    assert.strictEqual(bytes[address(dst, 0, 1) + 3], 0,
      'bulk SRCCOPY must retain canonical XRGB reserved-byte behavior');

    setPacked(dst, 2, 0, 0x0F0F0F);
    assert.strictEqual(wat.test_gdi_raster_bitblt(
      dst.desc, 2, 0, 1, 1, src.desc, 0, 0, 0, 0x00660046), 1); // SRCINVERT
    assert.strictEqual(packed(dst, 2, 0), (packed(src, 0, 0) ^ 0x0F0F0F) & 0xFFFFFF);
    assert.strictEqual(wat.test_gdi_raster_bitblt(
      dst.desc, 1, 0, 3, 1, 0, 0, 0, 0x123456, 0x00F00021), 1); // PATCOPY
    assert.deepStrictEqual([1, 2, 3].map(x => packed(dst, x, 0)),
      [0x123456, 0x123456, 0x123456]);

    const scaled = surface(10, 6, 32, false);
    assert.strictEqual(wat.test_gdi_raster_stretch_blt(
      scaled.desc, 0, 0, 10, 6, src.desc, 0, 0, 5, 3, 0, 0x00CC0020), 1);
    assert(wat.test_gdi_fast_count(2) > 0, 'StretchBlt did not use the 32-bpp bulk path');
    assert.strictEqual(packed(scaled, 0, 0), packed(src, 0, 0));
    assert.strictEqual(packed(scaled, 9, 5), packed(src, 4, 2));
    assert.strictEqual(bytes[address(scaled, 9, 5) + 3], 0);
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

  check('BitBlt clips source pixels outside the bitmap without aborting the transfer', () => {
    const src = surface(4, 3, 24, false);
    const dst = surface(5, 4, 32, true);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) setPacked(src, x, y, 0x010000 * y + x + 1);
    }
    for (let y = 0; y < dst.height; y++) {
      for (let x = 0; x < dst.width; x++) setPacked(dst, x, y, 0xA0B0C0);
    }

    assert.strictEqual(wat.test_gdi_raster_bitblt(
      dst.desc, 0, 0, 4, 3, src.desc, -1, -1, 0, 0x00CC0020), 1);
    assert.strictEqual(packed(dst, 0, 0), 0xA0B0C0,
      'out-of-source destination pixels must remain unchanged');
    assert.strictEqual(packed(dst, 1, 1), packed(src, 0, 0));
    assert.strictEqual(packed(dst, 3, 2), packed(src, 2, 1));
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
    const negativeDestination = surface(3, 2, 32);
    const vertical = surface(3, 2, 32);
    const bothNegative = surface(3, 2, 32);
    [[1, 2, 3], [4, 5, 6]].forEach((row, y) =>
      row.forEach((color, x) => setPacked(src, x, y, color)));
    assert.strictEqual(wat.test_gdi_raster_stretch_blt(
      horizontal.desc, 0, 0, 3, 2, src.desc, 2, 0, -3, 2, 0, 0x00CC0020), 1);
    assert.deepStrictEqual([...Array(3)].map((_, x) => packed(horizontal, x, 0)), [3, 2, 1]);
    assert.deepStrictEqual([...Array(3)].map((_, x) => packed(horizontal, x, 1)), [6, 5, 4]);
    assert.strictEqual(wat.test_gdi_raster_stretch_blt(
      negativeDestination.desc, 2, 0, -3, 2,
      src.desc, 0, 0, 3, 2, 0, 0x00CC0020), 1);
    assert.deepStrictEqual([...Array(3)].map((_, x) => packed(negativeDestination, x, 0)), [3, 2, 1]);
    assert.deepStrictEqual([...Array(3)].map((_, x) => packed(negativeDestination, x, 1)), [6, 5, 4]);
    assert.strictEqual(wat.test_gdi_raster_stretch_blt(
      vertical.desc, 0, 0, 3, 2, src.desc, 0, 1, 3, -2, 0, 0x00CC0020), 1);
    assert.deepStrictEqual([...Array(3)].map((_, x) => packed(vertical, x, 0)), [4, 5, 6]);
    assert.deepStrictEqual([...Array(3)].map((_, x) => packed(vertical, x, 1)), [1, 2, 3]);
    assert.strictEqual(wat.test_gdi_raster_stretch_blt(
      bothNegative.desc, 2, 1, -3, -2, src.desc, 2, 1, -3, -2, 0, 0x00CC0020), 1);
    assert.deepStrictEqual([...Array(3)].map((_, x) => packed(bothNegative, x, 0)), [1, 2, 3]);
    assert.deepStrictEqual([...Array(3)].map((_, x) => packed(bothNegative, x, 1)), [4, 5, 6]);
  });

  check('StretchBlt snapshots an overlapping surface before an in-place mirror', () => {
    const image = surface(4, 2, 24);
    [[1, 2, 3, 4], [5, 6, 7, 8]].forEach((row, y) =>
      row.forEach((color, x) => setPacked(image, x, y, color)));
    assert.strictEqual(wat.test_gdi_raster_stretch_blt(
      image.desc, 0, 0, 4, 2, image.desc, 3, 0, -4, 2, 0, 0x00CC0020), 1);
    assert.deepStrictEqual([...Array(4)].map((_, x) => packed(image, x, 0)), [4, 3, 2, 1]);
    assert.deepStrictEqual([...Array(4)].map((_, x) => packed(image, x, 1)), [8, 7, 6, 5]);

    const paintImage = surface(320, 200, 24);
    setPacked(paintImage, 0, 100, 0x112233);
    setPacked(paintImage, 319, 100, 0x445566);
    assert.strictEqual(wat.test_gdi_raster_stretch_blt(
      paintImage.desc, 0, 0, 320, 200,
      paintImage.desc, 319, 0, -320, 200, 0, 0x00CC0020), 1);
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

    dv.setUint16(bmi + 14, 16, true);
    dv.setUint32(bmi + 16, 0, true);
    assert.strictEqual(wat.test_gdi_raster_desc_from_bmi(desc, nextBits, bmi), 1);
    assert.deepStrictEqual([24, 28, 64].map(offset => dv.getUint32(desc + offset, true)),
      [0x7C00, 0x03E0, 0x001F]);
    dv.setUint32(bmi + 16, 3, true);
    dv.setUint32(bmi + 40, 0xF800, true);
    dv.setUint32(bmi + 44, 0x07E0, true);
    dv.setUint32(bmi + 48, 0x001F, true);
    assert.strictEqual(wat.test_gdi_raster_desc_from_bmi(desc, nextBits, bmi), 1);
    assert.deepStrictEqual([24, 28, 64].map(offset => dv.getUint32(desc + offset, true)),
      [0xF800, 0x07E0, 0x001F]);
    dv.setUint32(bmi + 44, 0xF800, true);
    assert.strictEqual(wat.test_gdi_raster_desc_from_bmi(desc, nextBits, bmi), 0,
      'overlapping BI_BITFIELDS masks must be rejected');
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
