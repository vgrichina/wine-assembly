#!/usr/bin/env node

'use strict';

const assert = require('assert');
const crypto = require('crypto');
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
  let passed = 0;

  const createPen = (style, width, color) => wat.test_call_CreatePen(style, width, color) >>> 0;
  const selectObject = (hdc, object) => wat.test_call_SelectObject(hdc, object) >>> 0;

  function check(name, fn) {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  }

  function makeDib(width, height, bpp, topDown = false) {
    const stride = ((width * bpp + 31) >> 5) << 2;
    const bmi = wat.guest_alloc(0x1000) >>> 0;
    const out = wat.guest_alloc(4) >>> 0;
    for (let offset = 0; offset < 40; offset += 4) wat.guest_write32(bmi + offset, 0);
    wat.guest_write32(out, 0);
    wat.guest_write32(bmi, 40);
    wat.guest_write32(bmi + 4, width);
    wat.guest_write32(bmi + 8, topDown ? -height : height);
    wat.guest_write16(bmi + 12, 1);
    wat.guest_write16(bmi + 14, bpp);
    const bitmap = wat.test_call_CreateDIBSection(0, bmi, out) >>> 0;
    const bitsGa = wat.guest_read32(out) >>> 0;
    const bits = 0x1C000000 + (bitsGa - 0x50000000);
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    assert(bitmap && hdc, `failed to create ${width}x${height}x${bpp} DIB/DC`);
    assert.strictEqual(selectObject(hdc, bitmap), 0x30007);
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
    const pen = createPen(0, 1, 0x00332211);
    selectObject(dib.hdc, pen);
    assert.strictEqual(wat.test_gdi_object_type(dib.bitmap), 3);
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 84, 0) >>> 0, dib.bitmap);
    assert.strictEqual(wat.test_gdi_surface_descriptor(dib.hdc, 0x07EF1000), 1);
    assert.strictEqual(dv.getUint32(0x07EF1000, true), dib.bits >>> 0);
    assert.strictEqual(dv.getUint32(0x07EF1000 + 24, true), 0x00332211);
    assert.strictEqual(wat.test_gdi_line_try(dib.hdc, 1, 1, 6, 4), 1);
    const expected = new Set(['1,1', '2,2', '3,2', '4,3', '5,3']);
    for (let y = 0; y < dib.height; y++) {
      for (let x = 0; x < dib.width; x++) {
        assert.strictEqual(pixel(dib, x, y), expected.has(`${x},${y}`) ? 0x112233 : 0,
          `unexpected pixel at ${x},${y}`);
      }
    }
    assert.strictEqual(pixel(dib, 6, 4), 0);
    const canvas = base.gdi.surfacePresentations.get(dib.bitmap).canvas.getContext('2d');
    assert.deepStrictEqual(Array.from(canvas.getImageData(1, 1, 1, 1).data), [0x11, 0x22, 0x33, 0xFF]);
  });

  check('top-down 32bpp lines respect WAT clip bands', () => {
    const dib = makeDib(8, 4, 32, true);
    const pen = createPen(0, 1, 0x000000FF);
    const clip = wat.test_gdi_rgn_alloc_rect(2, 1, 6, 3);
    selectObject(dib.hdc, pen);
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
      const pen = createPen(0, 1, 0x00FFFFFF);
      selectObject(dib.hdc, pen);
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
    const pen = createPen(0, 1, 0x000000FF);
    selectObject(dib.hdc, pen);
    wat.test_gdi_dc_set_field(dib.hdc, 40, 1, 0);
    wat.test_gdi_dc_set_field(dib.hdc, 44, 0, 0);
    wat.test_gdi_dc_set_field(dib.hdc, 48, 2, 1);
    wat.test_gdi_dc_set_field(dib.hdc, 52, 1, 1);
    wat.test_gdi_dc_set_field(dib.hdc, 56, 2, 0);
    wat.test_gdi_dc_set_field(dib.hdc, 60, 0, 0);
    wat.test_gdi_dc_set_field(dib.hdc, 64, 4, 1);
    wat.test_gdi_dc_set_field(dib.hdc, 68, 1, 1);
    for (let x = 4; x < 8; x++) setPixel(dib, x, 2, 0x00FF00);
    assert.strictEqual(wat.test_gdi_dc_set_rop2(dib.hdc, 7), 13);
    assert.strictEqual(wat.test_gdi_line_try(dib.hdc, 2, 2, 4, 2), 1);
    // Logical x=2..4 maps to surface x=4..8; LineTo excludes mapped x=8.
    for (let x = 4; x < 8; x++) assert.strictEqual(pixel(dib, x, 2), 0xFFFF00);
    assert.strictEqual(pixel(dib, 8, 2), 0);
  });

  check('wide solid strokes include native square endpoint caps', () => {
    const dib = makeDib(10, 8, 24, true);
    const wide = createPen(0, 3, 0x000000FF);
    selectObject(dib.hdc, wide);
    assert.strictEqual(wat.test_gdi_line_try(dib.hdc, 2, 3, 7, 3), 1);
    for (let y = 0; y < dib.height; y++) {
      for (let x = 0; x < dib.width; x++) {
        const expected = x >= 1 && x <= 8 && y >= 2 && y <= 4;
        assert.strictEqual(pixel(dib, x, y), expected ? 0xFF0000 : 0,
          `unexpected wide-stroke pixel at ${x},${y}`);
      }
    }
  });

  check('even-width native caps use a stable top-left bias and clip at DIB edges', () => {
    const dib = makeDib(7, 6, 32, true);
    const wide = createPen(0, 4, 0x0000FF00);
    selectObject(dib.hdc, wide);
    assert.strictEqual(wat.test_gdi_line_try(dib.hdc, 0, 1, 4, 1), 1);
    for (let y = 0; y < dib.height; y++) {
      for (let x = 0; x < dib.width; x++) {
        const expected = x <= 5 && y <= 2;
        assert.strictEqual(pixel(dib, x, y), expected ? 0x00FF00 : 0,
          `unexpected even-width clipped pixel at ${x},${y}`);
      }
    }
  });

  check('native Win98 fixtures preserve diagonal references and match exact axis pixels', () => {
    assert.strictEqual(WIDE_LINE_FIXTURES.provenance.kind, 'native-windows-98-reference');
    assert.strictEqual(WIDE_LINE_FIXTURES.provenance.fidelityClaim, true);
    assert.strictEqual(WIDE_LINE_FIXTURES.provenance.source,
      'tools/v86-reference/probes/gdi-wide-lines.c');
    const probeSource = fs.readFileSync(path.join(ROOT, WIDE_LINE_FIXTURES.provenance.source));
    assert.strictEqual(crypto.createHash('sha256').update(probeSource).digest('hex'),
      WIDE_LINE_FIXTURES.provenance.probeSourceSha256);
    assert.match(WIDE_LINE_FIXTURES.provenance.serialOutputSha256, /^[0-9a-f]{64}$/);
    const foreground = parseInt(WIDE_LINE_FIXTURES.foregroundPackedBgr, 16);
    const background = parseInt(WIDE_LINE_FIXTURES.background, 16);
    const colorRef = parseInt(WIDE_LINE_FIXTURES.foregroundColorRef, 16);
    let exactCases = 0;
    for (const fixture of WIDE_LINE_FIXTURES.cases) {
      const [width, height] = fixture.size;
      const [x0, y0, x1, y1] = fixture.line;
      assert.strictEqual(fixture.pixels.length, height, `${fixture.name}: fixture height`);
      assert(fixture.pixels.every(row => row.length === width), `${fixture.name}: fixture width`);
      const dib = makeDib(width, height, 24, true);
      const pen = createPen(0, fixture.width, colorRef);
      selectObject(dib.hdc, pen);
      assert.strictEqual(wat.test_gdi_line_try(dib.hdc, x0, y0, x1, y1), 1,
        `${fixture.name}: WAT must own the supported DIB stroke`);
      const colors = new Set();
      const actualRows = [];
      for (let y = 0; y < height; y++) {
        let actualRow = '';
        for (let x = 0; x < width; x++) {
          const actual = pixel(dib, x, y);
          colors.add(actual);
          actualRow += actual === foreground ? '#' : actual === background ? '.' : '?';
        }
        actualRows.push(actualRow);
      }
      if (fixture.watExact) {
        exactCases++;
        assert.deepStrictEqual(actualRows, fixture.pixels, `${fixture.name}: native pixel mask`);
      }
      assert.deepStrictEqual([...colors].sort((a, b) => a - b), [background, foreground],
        `${fixture.name}: output must contain only exact background and pen colors`);
    }
    assert.strictEqual(exactCases, 5, 'five captured axis cases must be exact');
  });

  check('wide ROP2 uses one coverage write; transformed wide and huge lines still fall back', () => {
    const dib = makeDib(6, 4, 24);
    const wide = createPen(0, 3, 0x000000FF);
    selectObject(dib.hdc, wide);
    assert.strictEqual(wat.test_gdi_dc_set_rop2(dib.hdc, 7), 13);
    assert.strictEqual(wat.test_gdi_line_try(dib.hdc, 0, 0, 4, 0), 1);
    assert.strictEqual(pixel(dib, 1, 0), 0xFF0000,
      'wide XOR coverage must apply once even where body and caps overlap');
    assert.strictEqual(wat.test_gdi_dc_set_rop2(dib.hdc, 13), 7);
    wat.test_gdi_dc_set_field(dib.hdc, 48, 1, 1);
    wat.test_gdi_dc_set_field(dib.hdc, 52, 1, 1);
    wat.test_gdi_dc_set_field(dib.hdc, 64, 2, 1);
    wat.test_gdi_dc_set_field(dib.hdc, 68, 1, 1);
    assert.strictEqual(wat.test_gdi_line_try(dib.hdc, 0, 0, 2, 0), 0);
    wat.test_gdi_dc_set_field(dib.hdc, 64, 1, 1);
    const thin = createPen(0, 1, 0x000000FF);
    selectObject(dib.hdc, thin);
    assert.strictEqual(wat.test_gdi_line_try(dib.hdc, 0, 0, 70000, 0), 0);
    const bitmap16 = wat.test_call_CreateBitmap(6, 4, 1, 16, 0) >>> 0;
    const dc16 = wat.test_call_CreateCompatibleDC(0) >>> 0;
    assert(bitmap16 && dc16, 'failed to create 16bpp DDB/DC');
    assert.strictEqual(selectObject(dc16, bitmap16), 0x30007);
    selectObject(dc16, thin);
    assert.strictEqual(wat.test_gdi_line_try(dc16, 0, 0, 4, 0), 1);
    const storage16 = wat.test_gdi_bitmap_storage(bitmap16) >>> 0;
    assert.deepStrictEqual([0, 1, 2, 3, 4].map(x =>
      dv.getUint16(storage16 + 36 + x * 2, true)),
    [0x7C00, 0x7C00, 0x7C00, 0x7C00, 0],
    '16-bpp BI_RGB lines use RGB555 and preserve endpoint exclusion');
  });

  check('diagonal wide ROP2 writes each stamp-union pixel once in all octants', () => {
    const directions = [
      [6, 3], [3, 6], [-3, 6], [-6, 3],
      [-6, -3], [-3, -6], [3, -6], [6, -3],
    ];
    for (const width of [2, 3, 4]) {
      for (const rop2 of [6, 7]) { // R2_NOT and R2_XORPEN are non-idempotent.
        for (const [dx, dy] of directions) {
          const dib = makeDib(20, 20, 24, true);
          const pen = createPen(0, width, 0x00FFFFFF);
          const x0 = 10;
          const y0 = 10;
          const x1 = x0 + dx;
          const y1 = y0 + dy;
          selectObject(dib.hdc, pen);
          assert.strictEqual(wat.test_gdi_dc_set_rop2(dib.hdc, rop2), 13);
          assert.strictEqual(wat.test_gdi_line_try(dib.hdc, x0, y0, x1, y1), 1,
            `width ${width}, ROP2 ${rop2}, delta ${dx},${dy}: raster admission`);

          const expected = new Set();
          for (const center of referenceLine(x0, y0, x1, y1)) {
            const [cx, cy] = center.split(',').map(Number);
            const left = cx - (width >> 1);
            const top = cy - (width >> 1);
            for (let sy = 0; sy < width; sy++) {
              for (let sx = 0; sx < width; sx++) expected.add(`${left + sx},${top + sy}`);
            }
          }
          for (let y = 0; y < dib.height; y++) {
            for (let x = 0; x < dib.width; x++) {
              assert.strictEqual(pixel(dib, x, y), expected.has(`${x},${y}`) ? 0xFFFFFF : 0,
                `width ${width}, ROP2 ${rop2}, delta ${dx},${dy}: pixel ${x},${y}`);
            }
          }
        }
      }
    }
  });

  check('wide dash requests normalize to solid and PS_NULL never draws', () => {
    const dib = makeDib(8, 5, 24, true);
    const wideDash = createPen(1, 3, 0x000000FF);
    selectObject(dib.hdc, wideDash);
    assert.strictEqual(wat.test_gdi_line_try(dib.hdc, 2, 2, 6, 2), 1);
    assert.strictEqual(pixel(dib, 3, 2), 0xFF0000);
    const nullPen = createPen(5, 1, 0x0000FF00);
    selectObject(dib.hdc, nullPen);
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
      const pen = createPen(style, 1, 0x00FFFFFF);
      selectObject(dib.hdc, pen);
      assert.strictEqual(wat.test_gdi_line_try(dib.hdc, 0, 0, 8, 0), 1);
      for (let x = 0; x < 8; x++) {
        assert.strictEqual(pixel(dib, x, 0), pattern[x] ? 0xFFFFFF : 0,
          `style ${style}: unexpected coverage at ${x}`);
      }
    }
  });

  check('styled coverage preserves phase through clipping and reverse traversal', () => {
    const clipped = makeDib(10, 2, 24, true);
    const dash = createPen(1, 1, 0x00FFFFFF);
    const clip = wat.test_gdi_rgn_alloc_rect(4, 0, 8, 1);
    selectObject(clipped.hdc, dash);
    assert.strictEqual(wat.test_gdi_dc_clip_select(clipped.hdc, clip), 2);
    assert.strictEqual(wat.test_gdi_line_try(clipped.hdc, 0, 0, 8, 0), 1);
    assert.deepStrictEqual(Array.from({ length: 10 }, (_, x) => pixel(clipped, x, 0) !== 0),
      [false, false, false, false, true, true, false, false, false, false]);

    const reverse = makeDib(10, 2, 24, true);
    selectObject(reverse.hdc, dash);
    assert.strictEqual(wat.test_gdi_line_try(reverse.hdc, 8, 0, 0, 0), 1);
    assert.deepStrictEqual(Array.from({ length: 10 }, (_, x) => pixel(reverse, x, 0) !== 0),
      [false, false, false, true, true, true, true, true, true, false]);
  });

  check('Polyline shares styled phase across segment boundaries', () => {
    const dib = makeDib(8, 8, 24, true);
    const dash = createPen(1, 1, 0x00FFFFFF);
    const points = pointsBuffer([[0, 0], [5, 0], [5, 5]]);
    selectObject(dib.hdc, dash);
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
    const pen = createPen(0, 1, 0x000000FF);
    const points = pointsBuffer([[0, 1], [4, 1], [70000, 1]]);
    selectObject(dib.hdc, pen);
    assert.strictEqual(wat.test_gdi_polyline_try(dib.hdc, points, 3, 0), 0);
    for (let x = 0; x < dib.width; x++) assert.strictEqual(pixel(dib, x, 1), 0);
  });

  check('PolylineTo begins at the WAT-owned current position', () => {
    const dib = makeDib(8, 5, 24, true);
    const pen = createPen(0, 1, 0x000000FF);
    const points = pointsBuffer([[5, 2], [5, 4]]);
    selectObject(dib.hdc, pen);
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
