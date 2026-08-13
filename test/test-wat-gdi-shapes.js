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
  base.host.memory = memory;
  base.host.create_thread = () => 0;
  base.host.exit_thread = () => 0;
  base.host.create_event = () => 0;
  base.host.set_event = () => 0;
  base.host.reset_event = () => 0;
  base.host.wait_single = () => 0;
  base.host.wait_multiple = () => 0;
  base.host.com_create_instance = () => 0x80004002;
  const { instance } = await WebAssembly.instantiate(wasm, base);
  const wat = instance.exports;
  const bytes = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  let nextBits = 0x02000000;
  let nextDesc = 0x00100000;
  let nextHandle = 0x00410000;
  let nextHdc = 0x00310000;
  let nextPoints = 0x00180000;
  let passed = 0;

  function check(name, fn) {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  }

  function target(width, height, bpp = 32, topDown = true, explicitClip = true) {
    const stride = ((width * bpp + 31) >> 5) << 2;
    const bits = nextBits;
    const desc = nextDesc;
    const hdc = nextHdc++;
    nextBits += stride * height + 0x1000;
    nextDesc += 0x100;
    bytes.fill(0, bits, bits + stride * height);
    const fields = [bits, width, height, stride, bpp, topDown ? 1 : 0,
      0, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0];
    fields.forEach((value, index) => dv.setInt32(desc + index * 4, value, true));
    if (explicitClip) {
      const clip = wat.test_gdi_rgn_alloc_rect(0, 0, width, height);
      const selected = wat.test_gdi_dc_clip_select(hdc, clip);
      assert.strictEqual(selected, 2, `clip=${clip.toString(16)} hdc=${hdc.toString(16)}`);
      wat.test_gdi_rgn_delete(clip);
    }
    return { hdc, desc, bits, width, height, bpp, topDown, stride };
  }

  function colorAt(t, x, y) {
    const row = t.topDown ? y : t.height - 1 - y;
    const p = t.bits + row * t.stride + x * (t.bpp >> 3);
    return bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
  }

  function rows(t) {
    const chars = new Map([[0, '.'], [0xFFFFFF, 'W'], [0xFF0000, 'R'], [0x00FF00, 'G']]);
    return Array.from({ length: t.height }, (_, y) =>
      Array.from({ length: t.width }, (_, x) => chars.get(colorAt(t, x, y)) || '?').join(''));
  }

  function object(type, style, width, color, flags = 0) {
    const handle = nextHandle++;
    assert.strictEqual(wat.test_gdi_object_adopt(handle, type, style, width, color, flags), handle);
    return handle;
  }

  function points(values) {
    const address = nextPoints;
    nextPoints += values.length * 8 + 0x20;
    values.forEach(([x, y], index) => {
      dv.setInt32(address + index * 8, x, true);
      dv.setInt32(address + index * 8 + 4, y, true);
    });
    return address;
  }

  check('rectangle fills half-open bounds and replaces the edge with its pen', () => {
    const t = target(9, 7, 32, true);
    const redPen = object(1, 0, 1, 0x000000FF);
    assert.strictEqual(wat.test_gdi_rectangle_desc(
      t.hdc, t.desc, 2, 1, 8, 6, redPen, 0x30010, 13), 1);
    assert.deepStrictEqual(rows(t), [
      '.........',
      '..RRRRRR.',
      '..RWWWWR.',
      '..RWWWWR.',
      '..RWWWWR.',
      '..RRRRRR.',
      '.........',
    ]);
  });

  check('rectangle maps reversed bounds and honors canonical clip bands', () => {
    const t = target(9, 7, 24, false);
    const green = object(2, 0, 0, 0x0000FF00);
    const clip = wat.test_gdi_rgn_alloc_rect(3, 2, 7, 5);
    assert.strictEqual(wat.test_gdi_dc_clip_select(t.hdc, clip), 2);
    assert.strictEqual(wat.test_gdi_rectangle_desc(
      t.hdc, t.desc, 8, 6, 1, 1, 0x30018, green, 13), 1);
    assert.deepStrictEqual(rows(t), [
      '.........',
      '.........',
      '...GGGG..',
      '...GGGG..',
      '...GGGG..',
      '.........',
      '.........',
    ]);
  });

  check('scaled targets inverse-map device pixels for logical clipping', () => {
    const t = target(10, 8);
    const green = object(2, 0, 0, 0x0000FF00);
    dv.setInt32(t.desc + 40, 5, true);
    dv.setInt32(t.desc + 44, 4, true);
    dv.setInt32(t.desc + 56, 10, true);
    dv.setInt32(t.desc + 60, 8, true);
    const clip = wat.test_gdi_rgn_alloc_rect(1, 1, 4, 3);
    assert.strictEqual(wat.test_gdi_dc_clip_select(t.hdc, clip), 2);
    assert.strictEqual(wat.test_gdi_rectangle_desc(
      t.hdc, t.desc, 0, 0, 5, 4, 0x30018, green, 13), 1);
    assert.deepStrictEqual(rows(t), [
      '..........',
      '.GGGGGG...',
      '.GGGGGG...',
      '.GGGGGG...',
      '.GGGGGG...',
      '..........',
      '..........',
      '..........',
    ]);
  });

  check('rectangle pen ROP2 combines exact destination pixels', () => {
    const t = target(7, 5);
    const red = object(1, 0, 1, 0x000000FF);
    bytes.fill(0x00, t.bits, t.bits + t.stride * t.height);
    for (let y = 0; y < t.height; y++) {
      for (let x = 0; x < t.width; x++) {
        const p = t.bits + y * t.stride + x * 4;
        bytes[p + 1] = 0xFF;
      }
    }
    assert.strictEqual(wat.test_gdi_rectangle_desc(
      t.hdc, t.desc, 1, 1, 6, 4, red, 0x30015, 7), 1);
    for (const [x, y] of [[1, 1], [3, 1], [1, 2], [5, 2], [2, 3]]) {
      assert.strictEqual(colorAt(t, x, y), 0xFFFF00, `${x},${y} should be XOR yellow`);
    }
    assert.strictEqual(colorAt(t, 3, 2), 0x00FF00, 'interior is unchanged with NULL_BRUSH');
  });

  check('unsupported styled rectangle fails atomically', () => {
    const t = target(6, 4);
    const dash = object(1, 1, 1, 0x00FFFFFF);
    assert.strictEqual(wat.test_gdi_rectangle_desc(
      t.hdc, t.desc, 1, 1, 5, 3, dash, 0x30010, 13), 0);
    assert.deepStrictEqual(new Set(rows(t).join('')), new Set(['.']));
  });

  check('rectangle uses descriptor bounds without a host/default clip', () => {
    const t = target(5, 4, 32, true, false);
    const green = object(2, 0, 0, 0x0000FF00);
    assert.strictEqual(wat.test_gdi_rectangle_desc(
      t.hdc, t.desc, -2, -2, 3, 2, 0x30018, green, 13), 1);
    assert.deepStrictEqual(rows(t), [
      'GGG..',
      'GGG..',
      '.....',
      '.....',
    ]);
  });

  check('narrow XOR rectangle applies each outline pixel exactly once', () => {
    const t = target(4, 5);
    const red = object(1, 0, 2, 0x000000FF);
    assert.strictEqual(wat.test_gdi_rectangle_desc(
      t.hdc, t.desc, 1, 0, 3, 5, red, 0x30015, 7), 1);
    assert.deepStrictEqual(rows(t), [
      '.RR.',
      '.RR.',
      '.RR.',
      '.RR.',
      '.RR.',
    ]);
  });

  check('invalid mapping and patterned brush fail without memory changes', () => {
    const t = target(6, 4);
    const hatch = object(2, 2, 0, 0x0000FF00);
    assert.strictEqual(wat.test_gdi_rectangle_desc(
      t.hdc, t.desc, 1, 1, 5, 3, 0x30018, hatch, 13), 0);
    dv.setInt32(t.desc + 40, 0, true);
    assert.strictEqual(wat.test_gdi_ellipse_desc(
      t.hdc, t.desc, 0, 0, 6, 4, 0x30018, 0x30010, 13), 0);
    assert.deepStrictEqual(new Set(rows(t).join('')), new Set(['.']));
  });

  check('line uses integer Bresenham coverage and excludes its endpoint', () => {
    const t = target(9, 7);
    const red = object(1, 0, 1, 0x000000FF);
    assert.strictEqual(wat.test_gdi_line_desc(t.hdc, t.desc, 1, 1, 7, 5, red, 13), 1);
    assert.deepStrictEqual(rows(t), [
      '.........',
      '.R.......',
      '..RR.....',
      '....R....',
      '.....RR..',
      '.........',
      '.........',
    ]);
  });

  check('thick and dashed lines have exact non-antialiased masks', () => {
    const thickTarget = target(10, 7);
    const thick = object(1, 0, 3, 0x000000FF);
    assert.strictEqual(wat.test_gdi_line_desc(
      thickTarget.hdc, thickTarget.desc, 2, 3, 7, 3, thick, 13), 1);
    assert.deepStrictEqual(rows(thickTarget), [
      '..........',
      '..........',
      '.RRRRRRR..',
      '.RRRRRRR..',
      '.RRRRRRR..',
      '..........',
      '..........',
    ]);

    const dashTarget = target(11, 2);
    const dash = object(1, 1, 1, 0x000000FF);
    assert.strictEqual(wat.test_gdi_line_desc(
      dashTarget.hdc, dashTarget.desc, 0, 0, 10, 0, dash, 13), 1);
    assert.deepStrictEqual(rows(dashTarget), [
      'RRRRRR..RR.',
      '...........',
    ]);
  });

  check('unsupported wide Boolean line fails atomically', () => {
    const t = target(8, 5);
    const wide = object(1, 0, 3, 0x00FFFFFF);
    assert.strictEqual(wat.test_gdi_line_desc(t.hdc, t.desc, 1, 2, 7, 2, wide, 7), 0);
    assert.deepStrictEqual(new Set(rows(t).join('')), new Set(['.']));
  });

  check('polygon fills canonical bands and closes its integer outline', () => {
    const t = target(9, 7);
    const red = object(1, 0, 1, 0x000000FF);
    const green = object(2, 0, 0, 0x0000FF00);
    const square = points([[1, 1], [7, 1], [7, 5], [1, 5]]);
    assert.strictEqual(wat.test_gdi_polygon_desc(
      t.hdc, t.desc, square, 4, red, green, 13, 1), 1);
    assert.deepStrictEqual(rows(t), [
      '.........',
      '.RRRRRRR.',
      '.RGGGGGR.',
      '.RGGGGGR.',
      '.RGGGGGR.',
      '.RRRRRRR.',
      '.........',
    ]);
  });

  check('polygon brush-only triangle has deterministic scanline coverage', () => {
    const t = target(9, 7, 24, false);
    const green = object(2, 0, 0, 0x0000FF00);
    const triangle = points([[1, 1], [8, 1], [4, 6]]);
    assert.strictEqual(wat.test_gdi_polygon_desc(
      t.hdc, t.desc, triangle, 3, 0x30018, green, 13, 2), 1);
    assert.deepStrictEqual(rows(t), [
      '.........',
      '.GGGGGGG.',
      '..GGGGG..',
      '..GGGG...',
      '...GG....',
      '.........',
      '.........',
    ]);
  });

  check('ellipse uses deterministic pixel-center fill and one-pixel outline', () => {
    const t = target(9, 7);
    const redPen = object(1, 0, 1, 0x000000FF);
    assert.strictEqual(wat.test_gdi_ellipse_desc(
      t.hdc, t.desc, 1, 1, 8, 6, redPen, 0x30010, 13), 1);
    assert.deepStrictEqual(rows(t), [
      '.........',
      '..RRRRR..',
      '.RWWWWWR.',
      '.RWWWWWR.',
      '.RWWWWWR.',
      '..RRRRR..',
      '.........',
    ]);
  });

  check('ellipse supports brush-only clipping and rejects wide outlines', () => {
    const t = target(8, 6, 24, false);
    const green = object(2, 0, 0, 0x0000FF00);
    const clip = wat.test_gdi_rgn_alloc_rect(3, 1, 6, 5);
    wat.test_gdi_dc_clip_select(t.hdc, clip);
    assert.strictEqual(wat.test_gdi_ellipse_desc(
      t.hdc, t.desc, 1, 0, 7, 6, 0x30018, green, 13), 1);
    assert.deepStrictEqual(rows(t), [
      '........',
      '...GGG..',
      '...GGG..',
      '...GGG..',
      '...GGG..',
      '........',
    ]);
    const wide = object(1, 0, 3, 0x00FFFFFF);
    const before = rows(t);
    assert.strictEqual(wat.test_gdi_ellipse_desc(
      t.hdc, t.desc, 0, 0, 8, 6, wide, 0x30015, 13), 0);
    assert.deepStrictEqual(rows(t), before);
  });

  console.log(`\n${passed}/${passed} checks passed`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
