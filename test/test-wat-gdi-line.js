#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const WIDE_LINE_FIXTURES = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'gdi-wide-line-pixels.json'), 'utf8'));

async function main() {
  const wasmBytes = await compileWat(file => fs.promises.readFile(path.join(SRC, file), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
  const base = createHostImports(ctx);
  base.host.memory = memory;
  base.host.create_thread = () => 0;
  base.host.exit_thread = () => 0;
  base.host.create_event = () => 0;
  base.host.set_event = () => 0;
  base.host.reset_event = () => 0;
  base.host.wait_single = () => 0;
  base.host.wait_multiple = () => 0;
  base.host.com_create_instance = () => 0x80004002;
  const { instance } = await WebAssembly.instantiate(wasmBytes, base);
  const wat = instance.exports;
  const bytes = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  let nextBmi = 0x00100000;
  let nextBits = 0x02000000;
  let passed = 0;

  function check(name, fn) {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  }

  function makeDib(width, height, bpp, topDown = false) {
    const bmi = nextBmi;
    const bits = nextBits;
    const stride = ((width * bpp + 31) >> 5) << 2;
    nextBmi += 0x1000;
    nextBits += stride * height + 0x1000;
    dv.setUint32(bmi, 40, true);
    dv.setInt32(bmi + 4, width, true);
    dv.setInt32(bmi + 8, topDown ? -height : height, true);
    dv.setUint16(bmi + 12, 1, true);
    dv.setUint16(bmi + 14, bpp, true);
    const bitmap = base.host.gdi_create_dib_section(width, height, bpp, bits, bmi);
    const hdc = base.host.gdi_create_compat_dc(0);
    base.host.gdi_select_object(hdc, bitmap);
    return { hdc, bitmap, bits, stride, width, height, bpp, topDown };
  }

  function pixel(dib, x, y) {
    const row = dib.topDown ? y : dib.height - 1 - y;
    const p = dib.bits + row * dib.stride + x * (dib.bpp >> 3);
    return bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
  }

  function setPixel(dib, x, y, packedBgr) {
    const row = dib.topDown ? y : dib.height - 1 - y;
    const p = dib.bits + row * dib.stride + x * (dib.bpp >> 3);
    bytes[p] = packedBgr & 0xFF;
    bytes[p + 1] = (packedBgr >>> 8) & 0xFF;
    bytes[p + 2] = (packedBgr >>> 16) & 0xFF;
  }

  function referenceLine(x0, y0, x1, y1) {
    const points = [];
    const dx = Math.abs(x1 - x0);
    const sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0);
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    while (x0 !== x1 || y0 !== y1) {
      points.push(`${x0},${y0}`);
      const e2 = err * 2;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
    return points;
  }

  function pointsBuffer(points) {
    const wa = nextBmi;
    nextBmi += Math.max(0x1000, points.length * 8);
    points.forEach(([x, y], index) => {
      dv.setInt32(wa + index * 8, x, true);
      dv.setInt32(wa + index * 8 + 4, y, true);
    });
    return wa;
  }

  check('ROP2 truth table matches all 16 binary raster modes', () => {
    const p = 0x123456;
    const d = 0xA5C33C;
    const mask = 0xFFFFFF;
    const expected = [
      0,
      ~(d | p), d & ~p, ~p,
      p & ~d, ~d, p ^ d, ~(p & d),
      p & d, ~(p ^ d), d, d | ~p,
      p, p | ~d, p | d, mask,
    ].map(value => value & mask);
    for (let mode = 1; mode <= 16; mode++) {
      assert.strictEqual(wat.test_gdi_apply_rop2(mode, p, d) >>> 0, expected[mode - 1]);
    }
  });

  check('per-DC ROP2 state defaults, validates, and round-trips', () => {
    const { hdc } = makeDib(4, 4, 24);
    assert.strictEqual(wat.test_gdi_dc_get_rop2(hdc), 13);
    assert.strictEqual(wat.test_gdi_dc_set_rop2(hdc, 7), 13);
    assert.strictEqual(wat.test_gdi_dc_get_rop2(hdc), 7);
    assert.strictEqual(wat.test_gdi_dc_set_rop2(hdc, 17), 0);
    assert.strictEqual(wat.test_gdi_dc_get_rop2(hdc), 7);
  });

  check('Bresenham writes exact bottom-up 24bpp pixels and excludes endpoint', () => {
    const dib = makeDib(8, 6, 24);
    const pen = base.host.gdi_create_pen(0, 1, 0x00332211);
    base.host.gdi_select_object(dib.hdc, pen);
    assert.strictEqual(wat.test_gdi_line_try(dib.hdc, 1, 1, 6, 4), 1);
    const expected = new Set(['1,1', '2,2', '3,2', '4,3', '5,3']);
    for (let y = 0; y < dib.height; y++) {
      for (let x = 0; x < dib.width; x++) {
        assert.strictEqual(pixel(dib, x, y), expected.has(`${x},${y}`) ? 0x112233 : 0,
          `unexpected pixel at ${x},${y}`);
      }
    }
    assert.strictEqual(pixel(dib, 6, 4), 0);
    const canvas = base.gdi._gdiObjects[dib.bitmap].canvas.getContext('2d');
    assert.deepStrictEqual(Array.from(canvas.getImageData(1, 1, 1, 1).data), [0x11, 0x22, 0x33, 0xFF]);
  });

  check('top-down 32bpp lines respect WAT clip bands', () => {
    const dib = makeDib(8, 4, 32, true);
    const pen = base.host.gdi_create_pen(0, 1, 0x000000FF);
    const clip = wat.test_gdi_rgn_alloc_rect(2, 1, 6, 3);
    base.host.gdi_select_object(dib.hdc, pen);
    assert.strictEqual(wat.test_gdi_dc_clip_select(dib.hdc, clip), 2);
    assert.strictEqual(wat.test_gdi_line_try(dib.hdc, 0, 1, 8, 1), 1);
    for (let x = 0; x < 8; x++) {
      assert.strictEqual(pixel(dib, x, 1), x >= 2 && x < 6 ? 0xFF0000 : 0);
    }
  });

  check('Bresenham covers horizontal, vertical, reverse, and steep octants', () => {
    const cases = [
      [1, 1, 7, 1], [7, 2, 1, 2], [2, 1, 2, 7], [3, 7, 3, 1],
      [1, 1, 7, 4], [7, 4, 1, 1], [1, 7, 4, 1], [7, 1, 4, 7],
    ];
    for (const [x0, y0, x1, y1] of cases) {
      const dib = makeDib(9, 9, 24, true);
      const pen = base.host.gdi_create_pen(0, 1, 0x00FFFFFF);
      base.host.gdi_select_object(dib.hdc, pen);
      assert.strictEqual(wat.test_gdi_line_try(dib.hdc, x0, y0, x1, y1), 1);
      const expected = new Set(referenceLine(x0, y0, x1, y1));
      for (let y = 0; y < dib.height; y++) {
        for (let x = 0; x < dib.width; x++) {
          assert.strictEqual(pixel(dib, x, y), expected.has(`${x},${y}`) ? 0xFFFFFF : 0,
            `case ${x0},${y0}->${x1},${y1}: unexpected pixel at ${x},${y}`);
        }
      }
    }
  });

  check('viewport/window mapping and XOR operate before byte presentation', () => {
    const dib = makeDib(10, 5, 24);
    const pen = base.host.gdi_create_pen(0, 1, 0x000000FF);
    base.host.gdi_select_object(dib.hdc, pen);
    base.host.gdi_set_window_org(dib.hdc, 1, 0);
    base.host.gdi_set_window_ext(dib.hdc, 2, 1);
    base.host.gdi_set_viewport_org(dib.hdc, 2, 0);
    base.host.gdi_set_viewport_ext(dib.hdc, 4, 1);
    for (let x = 4; x < 8; x++) setPixel(dib, x, 2, 0x00FF00);
    assert.strictEqual(wat.test_gdi_dc_set_rop2(dib.hdc, 7), 13);
    assert.strictEqual(wat.test_gdi_line_try(dib.hdc, 2, 2, 4, 2), 1);
    // Logical x=2..4 maps to surface x=4..8; LineTo excludes mapped x=8.
    for (let x = 4; x < 8; x++) assert.strictEqual(pixel(dib, x, 2), 0xFFFF00);
    assert.strictEqual(pixel(dib, 8, 2), 0);
  });

  check('wide solid COPYPEN strokes use exact square integer footprints', () => {
    const dib = makeDib(10, 8, 24, true);
    const wide = base.host.gdi_create_pen(0, 3, 0x000000FF);
    base.host.gdi_select_object(dib.hdc, wide);
    assert.strictEqual(wat.test_gdi_line_try(dib.hdc, 2, 3, 7, 3), 1);
    for (let y = 0; y < dib.height; y++) {
      for (let x = 0; x < dib.width; x++) {
        const expected = x >= 1 && x <= 7 && y >= 2 && y <= 4;
        assert.strictEqual(pixel(dib, x, y), expected ? 0xFF0000 : 0,
          `unexpected wide-stroke pixel at ${x},${y}`);
      }
    }
  });

  check('even-width strokes use a stable top-left bias and clip at DIB edges', () => {
    const dib = makeDib(7, 6, 32, true);
    const wide = base.host.gdi_create_pen(0, 4, 0x0000FF00);
    base.host.gdi_select_object(dib.hdc, wide);
    assert.strictEqual(wat.test_gdi_line_try(dib.hdc, 0, 1, 4, 1), 1);
    for (let y = 0; y < dib.height; y++) {
      for (let x = 0; x < dib.width; x++) {
        const expected = x <= 4 && y <= 2;
        assert.strictEqual(pixel(dib, x, y), expected ? 0x00FF00 : 0,
          `unexpected even-width clipped pixel at ${x},${y}`);
      }
    }
  });

  check('wide-line migration fixtures match exact pixels and contain no blended colors', () => {
    assert.strictEqual(WIDE_LINE_FIXTURES.provenance.kind, 'implementation-regression');
    assert.strictEqual(WIDE_LINE_FIXTURES.provenance.fidelityClaim, false);
    const foreground = parseInt(WIDE_LINE_FIXTURES.foregroundPackedBgr, 16);
    const background = parseInt(WIDE_LINE_FIXTURES.background, 16);
    const colorRef = parseInt(WIDE_LINE_FIXTURES.foregroundColorRef, 16);
    for (const fixture of WIDE_LINE_FIXTURES.cases) {
      const [width, height] = fixture.size;
      const [x0, y0, x1, y1] = fixture.line;
      assert.strictEqual(fixture.pixels.length, height, `${fixture.name}: fixture height`);
      assert(fixture.pixels.every(row => row.length === width), `${fixture.name}: fixture width`);
      const dib = makeDib(width, height, 24, true);
      const pen = base.host.gdi_create_pen(0, fixture.width, colorRef);
      base.host.gdi_select_object(dib.hdc, pen);
      assert.strictEqual(wat.test_gdi_line_try(dib.hdc, x0, y0, x1, y1), 1,
        `${fixture.name}: WAT must own the supported DIB stroke`);
      const colors = new Set();
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const actual = pixel(dib, x, y);
          colors.add(actual);
          const expected = fixture.pixels[y][x] === '#' ? foreground : background;
          assert.strictEqual(actual, expected,
            `${fixture.name}: unexpected pixel at ${x},${y}`);
        }
      }
      assert.deepStrictEqual([...colors].sort((a, b) => a - b), [background, foreground],
        `${fixture.name}: output must contain only exact background and pen colors`);
    }
  });

  check('unsupported wide ROP2, transformed wide, huge, and 16bpp lines fall back', () => {
    const dib = makeDib(6, 4, 24);
    const wide = base.host.gdi_create_pen(0, 3, 0x000000FF);
    base.host.gdi_select_object(dib.hdc, wide);
    assert.strictEqual(wat.test_gdi_dc_set_rop2(dib.hdc, 7), 13);
    assert.strictEqual(wat.test_gdi_line_try(dib.hdc, 0, 0, 4, 0), 0);
    assert.strictEqual(wat.test_gdi_dc_set_rop2(dib.hdc, 13), 7);
    base.host.gdi_set_window_ext(dib.hdc, 1, 1);
    base.host.gdi_set_viewport_ext(dib.hdc, 2, 1);
    assert.strictEqual(wat.test_gdi_line_try(dib.hdc, 0, 0, 2, 0), 0);
    base.host.gdi_set_viewport_ext(dib.hdc, 1, 1);
    const thin = base.host.gdi_create_pen(0, 1, 0x000000FF);
    base.host.gdi_select_object(dib.hdc, thin);
    assert.strictEqual(wat.test_gdi_line_try(dib.hdc, 0, 0, 70000, 0), 0);
    const dib16 = makeDib(6, 4, 16);
    base.host.gdi_select_object(dib16.hdc, thin);
    assert.strictEqual(wat.test_gdi_line_try(dib16.hdc, 0, 0, 4, 0), 0);
  });

  check('wide dash requests normalize to solid and PS_NULL never draws', () => {
    const dib = makeDib(8, 5, 24, true);
    const wideDash = base.host.gdi_create_pen(1, 3, 0x000000FF);
    base.host.gdi_select_object(dib.hdc, wideDash);
    assert.strictEqual(wat.test_gdi_line_try(dib.hdc, 2, 2, 6, 2), 1);
    assert.strictEqual(pixel(dib, 3, 2), 0xFF0000);
    const nullPen = base.host.gdi_create_pen(5, 1, 0x0000FF00);
    base.host.gdi_select_object(dib.hdc, nullPen);
    assert.strictEqual(wat.test_gdi_line_try(dib.hdc, 0, 4, 7, 4), 0);
    assert.strictEqual(pixel(dib, 3, 4), 0);
  });

  check('thin default styles use fixed device-step coverage tables', () => {
    const patterns = [
      [1, [1, 1, 1, 1, 1, 1, 0, 0]],
      [2, [1, 0, 1, 0, 1, 0, 1, 0]],
      [3, [1, 1, 1, 0, 0, 1, 0, 0]],
      [4, [1, 1, 1, 0, 1, 0, 1, 0]],
    ];
    for (const [style, pattern] of patterns) {
      const dib = makeDib(10, 2, 24, true);
      const pen = base.host.gdi_create_pen(style, 1, 0x00FFFFFF);
      base.host.gdi_select_object(dib.hdc, pen);
      assert.strictEqual(wat.test_gdi_line_try(dib.hdc, 0, 0, 8, 0), 1);
      for (let x = 0; x < 8; x++) {
        assert.strictEqual(pixel(dib, x, 0), pattern[x] ? 0xFFFFFF : 0,
          `style ${style}: unexpected coverage at ${x}`);
      }
    }
  });

  check('styled coverage preserves phase through clipping and reverse traversal', () => {
    const clipped = makeDib(10, 2, 24, true);
    const dash = base.host.gdi_create_pen(1, 1, 0x00FFFFFF);
    const clip = wat.test_gdi_rgn_alloc_rect(4, 0, 8, 1);
    base.host.gdi_select_object(clipped.hdc, dash);
    assert.strictEqual(wat.test_gdi_dc_clip_select(clipped.hdc, clip), 2);
    assert.strictEqual(wat.test_gdi_line_try(clipped.hdc, 0, 0, 8, 0), 1);
    assert.deepStrictEqual(Array.from({ length: 10 }, (_, x) => pixel(clipped, x, 0) !== 0),
      [false, false, false, false, true, true, false, false, false, false]);

    const reverse = makeDib(10, 2, 24, true);
    base.host.gdi_select_object(reverse.hdc, dash);
    assert.strictEqual(wat.test_gdi_line_try(reverse.hdc, 8, 0, 0, 0), 1);
    assert.deepStrictEqual(Array.from({ length: 10 }, (_, x) => pixel(reverse, x, 0) !== 0),
      [false, false, false, true, true, true, true, true, true, false]);
  });

  check('Polyline shares styled phase across segment boundaries', () => {
    const dib = makeDib(8, 8, 24, true);
    const dash = base.host.gdi_create_pen(1, 1, 0x00FFFFFF);
    const points = pointsBuffer([[0, 0], [5, 0], [5, 5]]);
    base.host.gdi_select_object(dib.hdc, dash);
    assert.strictEqual(wat.test_gdi_polyline_try(dib.hdc, points, 3, 0), 1);
    for (let x = 0; x < 5; x++) assert.strictEqual(pixel(dib, x, 0), 0xFFFFFF);
    assert.strictEqual(pixel(dib, 5, 0), 0xFFFFFF);
    assert.strictEqual(pixel(dib, 5, 1), 0);
    assert.strictEqual(pixel(dib, 5, 2), 0);
    assert.strictEqual(pixel(dib, 5, 3), 0xFFFFFF);
    assert.strictEqual(pixel(dib, 5, 4), 0xFFFFFF);
  });

  check('Polyline preflight rejects atomically before any segment writes', () => {
    const dib = makeDib(8, 3, 24, true);
    const pen = base.host.gdi_create_pen(0, 1, 0x000000FF);
    const points = pointsBuffer([[0, 1], [4, 1], [70000, 1]]);
    base.host.gdi_select_object(dib.hdc, pen);
    assert.strictEqual(wat.test_gdi_polyline_try(dib.hdc, points, 3, 0), 0);
    for (let x = 0; x < dib.width; x++) assert.strictEqual(pixel(dib, x, 1), 0);
  });

  check('PolylineTo begins at the WAT-owned current position', () => {
    const dib = makeDib(8, 5, 24, true);
    const pen = base.host.gdi_create_pen(0, 1, 0x000000FF);
    const points = pointsBuffer([[5, 2], [5, 4]]);
    base.host.gdi_select_object(dib.hdc, pen);
    wat.test_gdi_current_pos_set(dib.hdc, 1, 2);
    assert.strictEqual(wat.test_gdi_polyline_try(dib.hdc, points, 2, 1), 1);
    for (let x = 1; x < 5; x++) assert.strictEqual(pixel(dib, x, 2), 0xFF0000);
    assert.strictEqual(pixel(dib, 5, 2), 0xFF0000);
    assert.strictEqual(pixel(dib, 5, 3), 0xFF0000);
    assert.strictEqual(pixel(dib, 5, 4), 0);
  });

  console.log(`\n${passed}/${passed} checks passed`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
