#!/usr/bin/env node

'use strict';

// The two bulk blit paths that carry the DirectX samples.
//
// $gdi_raster_bitblt_fast32 and $gdi_raster_stretch_blt_fast32 used to require
// 32bpp on BOTH surfaces, and every DirectDraw app misses that by construction:
// a windowed present goes primary -> SetDIBitsToDevice -> $gdi_raster_bitblt,
// and DirectDraw primaries in this corpus are 16bpp (dx_tunnel, dx_twist) or
// 8bpp (dx_donuts). So every present fell into the generic per-pixel loop,
// which re-resolves the clip, the DC state and the three channel masks for
// each of ~300k pixels. dx_tunnel spent 93s on 3000 batches; 9.9s after.
//
// Two extensions, both guarded here:
//   * a 16bpp SOURCE into a 32bpp destination, with the masks/shifts/maxima
//     hoisted out of the loop and the exact rounding $gdi_raster_unpack_channel
//     uses, so the result is bit-identical to the generic path;
//   * an 8bpp -> 8bpp SRCCOPY StretchBlt when both sides address colour
//     through equivalent tables, which is then a straight index copy instead
//     of a palette_color -> RGB -> nearest_index round trip per pixel.
//
// What is asserted is BOTH halves: that the fast counter moved (otherwise the
// test passes on the generic path and guards nothing) and that the pixels are
// what the slow path would have produced.
//
// Not covered here: the swizzled-palette case, where a DirectDraw PALETTEENTRY
// table meets a bitmap's RGBQUAD table. $gdi_raster_palette_base only reports
// that layout for a real DirectDraw primary handle, which a synthetic
// descriptor cannot fake. That path was verified end to end on dx_donuts --
// 1200 batches with and without the acceptance, 0 of 307200 pixels differ.

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

  // Descriptor layout: +0 bits, +4 w, +8 h, +12 pitch, +16 bpp, +20 topDown,
  // +24/+28 transient palette ptr/count (also the red/green masks at 16bpp),
  // +64 blue mask, +68 surface handle.
  function surface(width, height, bpp, opts = {}) {
    const desc = nextDesc;
    const bits = nextBits;
    const stride = ((width * bpp + 31) >> 5) << 2;
    nextDesc += 0x100;
    nextBits += stride * height + 0x100;
    new Uint8Array(memory.buffer, desc, 0x100).fill(0);
    new Uint8Array(memory.buffer, bits, stride * height).fill(0);
    dv.setUint32(desc, bits, true);
    dv.setInt32(desc + 4, width, true);
    dv.setInt32(desc + 8, height, true);
    dv.setInt32(desc + 12, stride, true);
    dv.setInt32(desc + 16, bpp, true);
    dv.setInt32(desc + 20, opts.topDown === false ? 0 : 1, true);
    if (opts.masks) {
      dv.setUint32(desc + 24, opts.masks[0], true);
      dv.setUint32(desc + 28, opts.masks[1], true);
      dv.setUint32(desc + 64, opts.masks[2], true);
    }
    if (opts.palette) {
      dv.setUint32(desc + 24, opts.palette.base, true);
      dv.setInt32(desc + 28, opts.palette.count, true);
    }
    return { desc, bits, width, height, bpp, stride, topDown: opts.topDown !== false };
  }

  function rowPtr(s, y) {
    return s.bits + (s.topDown ? y : s.height - 1 - y) * s.stride;
  }

  // 0xRRGGBB, whatever the storage bpp — the same order $gdi_raster_read uses.
  function readRGB(s, x, y) {
    if (s.bpp === 32) {
      const p = rowPtr(s, y) + x * 4;
      return bytes[p + 2] << 16 | bytes[p + 1] << 8 | bytes[p];
    }
    throw new Error(`readRGB: unsupported bpp ${s.bpp}`);
  }

  function index8(s, x, y, value) {
    const p = rowPtr(s, y) + x;
    if (value === undefined) return bytes[p];
    bytes[p] = value;
    return value;
  }

  // An RGBQUAD table (B,G,R,reserved) in guest-visible memory.
  let nextPalette = 0x02800000;
  function palette(colors) {
    const base = nextPalette;
    nextPalette += 0x400;
    colors.forEach((c, i) => {
      bytes[base + i * 4] = c & 255;
      bytes[base + i * 4 + 1] = (c >>> 8) & 255;
      bytes[base + i * 4 + 2] = (c >>> 16) & 255;
      bytes[base + i * 4 + 3] = 0;
    });
    return { base, count: colors.length };
  }

  const SRCCOPY = 0x00CC0020;

  check('16-bpp source into a 32-bpp destination takes the bulk BitBlt path', () => {
    for (const masks of [null, [0xF800, 0x07E0, 0x001F]]) {
      const src = surface(4, 3, 16, masks ? { masks } : {});
      const dst = surface(6, 4, 32);
      // Sweep every bit of the 16-bit word so a wrong shift or a wrong
      // rounding constant shows up rather than cancelling out.
      for (let y = 0; y < src.height; y++) {
        for (let x = 0; x < src.width; x++) {
          dv.setUint16(rowPtr(src, y) + x * 2, (0x1234 * (y * src.width + x + 1)) & 0xFFFF, true);
        }
      }
      // Expected colour comes from the emulator's own single-pixel reader, so
      // this asserts the fast path agrees with the generic one rather than
      // re-deriving the channel arithmetic in JS.
      const expected = [];
      for (let y = 0; y < src.height; y++) {
        for (let x = 0; x < src.width; x++) {
          const bgr = wat.test_gdi_raster_get_pixel(src.desc, x, y) >>> 0; // 0x00BBGGRR
          expected.push((bgr & 255) << 16 | (bgr & 0xFF00) | (bgr >>> 16 & 255));
        }
      }

      wat.test_gdi_fast_reset();
      assert.strictEqual(wat.test_gdi_raster_bitblt(
        dst.desc, 1, 1, 4, 3, src.desc, 0, 0, 0, SRCCOPY), 1);
      assert(wat.test_gdi_fast_count(1) > 0,
        `16-bpp source fell back to the generic BitBlt loop (masks=${masks})`);

      for (let y = 0; y < src.height; y++) {
        for (let x = 0; x < src.width; x++) {
          assert.strictEqual(readRGB(dst, x + 1, y + 1), expected[y * src.width + x],
            `pixel ${x},${y} (masks=${masks})`);
        }
      }
      // Clipping still holds: nothing outside the destination rect moved.
      assert.strictEqual(readRGB(dst, 0, 0), 0);
      assert.strictEqual(readRGB(dst, 5, 3), 0);
    }
  });

  check('a bottom-up 16-bpp source still reads the right rows', () => {
    const src = surface(2, 2, 16, { topDown: false });
    const dst = surface(2, 2, 32);
    dv.setUint16(rowPtr(src, 0), 0x7C00, true); // top row: red in RGB555
    dv.setUint16(rowPtr(src, 0) + 2, 0x03E0, true);
    dv.setUint16(rowPtr(src, 1), 0x001F, true); // bottom row: blue
    dv.setUint16(rowPtr(src, 1) + 2, 0x7FFF, true);
    wat.test_gdi_fast_reset();
    assert.strictEqual(wat.test_gdi_raster_bitblt(
      dst.desc, 0, 0, 2, 2, src.desc, 0, 0, 0, SRCCOPY), 1);
    assert(wat.test_gdi_fast_count(1) > 0, 'bottom-up 16-bpp source missed the bulk path');
    assert.strictEqual(readRGB(dst, 0, 0), 0xFF0000);
    assert.strictEqual(readRGB(dst, 1, 0), 0x00FF00);
    assert.strictEqual(readRGB(dst, 0, 1), 0x0000FF);
    assert.strictEqual(readRGB(dst, 1, 1), 0xFFFFFF);
  });

  check('8-bpp StretchBlt copies indexes when both palettes agree', () => {
    const colors = [0x000000, 0xFF0000, 0x00FF00, 0x0000FF, 0x808080];
    const pal = palette(colors);
    const src = surface(3, 2, 8, { palette: pal });
    const dst = surface(6, 4, 8, { palette: palette(colors) }); // equal, not shared
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) index8(src, x, y, 1 + ((y * src.width + x) % 4));
    }

    wat.test_gdi_fast_reset();
    assert.strictEqual(wat.test_gdi_raster_stretch_blt(
      dst.desc, 0, 0, 6, 4, src.desc, 0, 0, 3, 2, 0, SRCCOPY), 1);
    assert(wat.test_gdi_fast_count(2) > 0,
      '8-bpp SRCCOPY with matching palettes fell back to the generic stretch loop');
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 6; x++) {
        assert.strictEqual(index8(dst, x, y), index8(src, x >> 1, y >> 1), `pixel ${x},${y}`);
      }
    }
  });

  check('8-bpp StretchBlt declines the index copy when the palettes differ', () => {
    // Same index means a different colour on each side, so copying the index
    // would be visibly wrong. The generic loop must run and remap through the
    // destination palette.
    const src = surface(2, 1, 8, { palette: palette([0x000000, 0xFF0000, 0x00FF00]) });
    const dst = surface(2, 1, 8, { palette: palette([0x000000, 0x00FF00, 0xFF0000]) });
    index8(src, 0, 0, 1);
    index8(src, 1, 0, 2);

    wat.test_gdi_fast_reset();
    assert.strictEqual(wat.test_gdi_raster_stretch_blt(
      dst.desc, 0, 0, 2, 1, src.desc, 0, 0, 2, 1, 0, SRCCOPY), 1);
    assert.strictEqual(wat.test_gdi_fast_count(2), 0,
      'mismatched palettes must not take the index-copy path');
    // Indexes are swapped between the two tables, so a correct remap swaps them.
    assert.strictEqual(index8(dst, 0, 0), 2);
    assert.strictEqual(index8(dst, 1, 0), 1);
  });

  console.log(`\nPASS: ${passed} GDI bulk blit path checks`);
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
