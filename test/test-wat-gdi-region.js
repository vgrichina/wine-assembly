#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const RECT_SCRATCH = 0x07E09000;
const GDI_REGION_BANDS = 0x07E1C000;

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
  const dv = new DataView(memory.buffer);
  let passed = 0;

  function check(name, fn) {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  }

  function box(handle) {
    const complexity = wat.test_gdi_rgn_get_box(handle, RECT_SCRATCH);
    return {
      complexity,
      rect: [0, 4, 8, 12].map(offset => dv.getInt32(RECT_SCRATCH + offset, true)),
    };
  }

  function recordFor(handle) {
    const slot = (handle & 0xFF) - 1;
    return wat.get_gdi_region_table() + slot * 32;
  }

  function bands(handle) {
    const slot = (handle & 0xFF) - 1;
    const record = recordFor(handle);
    const count = dv.getUint32(record + 28, true);
    const base = GDI_REGION_BANDS + slot * 128 * 16;
    const rects = [];
    for (let i = 0; i < count; i++) {
      rects.push([0, 4, 8, 12].map(offset => dv.getInt32(base + i * 16 + offset, true)));
    }
    return rects;
  }

  check('allocates normalized generation-tagged rectangle handles in WAT', () => {
    const handle = wat.test_gdi_rgn_alloc_rect(8, 9, 2, 3);
    assert.strictEqual(handle & 0xFFFF0000, 0x00500000);
    assert.deepStrictEqual(box(handle), { complexity: 2, rect: [2, 3, 8, 9] });
    assert.strictEqual(dv.getUint32(recordFor(handle), true), 1);
  });

  check('public GDI handlers expose WAT regions as OBJ_REGION', () => {
    const handle = wat.test_call_CreateRectRgn(2, 4, 12, 14);
    assert.strictEqual(handle & 0xFFFF0000, 0x00500000);
    assert.strictEqual(wat.test_call_GetObjectType(handle), 8);
    assert.deepStrictEqual(box(handle), { complexity: 2, rect: [2, 4, 12, 14] });
  });

  check('WAT geometry remains authoritative over its JS presentation mirror', () => {
    const handle = wat.test_gdi_rgn_alloc_rect(1, 2, 7, 8);
    const record = recordFor(handle);
    const mirror = dv.getUint32(record + 24, true);
    assert(mirror >= 0x400001);
    assert.strictEqual(base.host.gdi_set_rect_rgn(mirror, 90, 91, 99, 100), 1);
    assert.deepStrictEqual(box(handle), { complexity: 2, rect: [1, 2, 7, 8] });

    assert.strictEqual(wat.test_gdi_rgn_set_rect(handle, -4, -3, 5, 6), 1);
    assert.deepStrictEqual(box(handle), { complexity: 2, rect: [-4, -3, 5, 6] });
    assert.deepStrictEqual(base.gdi._gdiObjects[mirror].bbox, { l: -4, t: -3, r: 5, b: 6 });
  });

  check('rectangle intersection and offset execute on canonical WAT bands', () => {
    const a = wat.test_gdi_rgn_alloc_rect(0, 0, 8, 8);
    const b = wat.test_gdi_rgn_alloc_rect(3, 2, 10, 6);
    const dst = wat.test_gdi_rgn_alloc_rect(0, 0, 0, 0);
    assert.strictEqual(wat.test_gdi_rgn_combine(dst, a, b, 1), 2); // RGN_AND
    assert.deepStrictEqual(box(dst), { complexity: 2, rect: [3, 2, 8, 6] });
    assert.deepStrictEqual(bands(dst), [[3, 2, 8, 6]]);
    assert.strictEqual(wat.test_gdi_rgn_offset(dst, -2, 5), 2);
    assert.deepStrictEqual(box(dst), { complexity: 2, rect: [1, 7, 6, 11] });
    assert.deepStrictEqual(bands(dst), [[1, 7, 6, 11]]);
  });

  check('all Boolean modes produce exact disjoint WAT bands', () => {
    const a = wat.test_gdi_rgn_alloc_rect(0, 0, 8, 8);
    const b = wat.test_gdi_rgn_alloc_rect(3, 2, 10, 6);
    const expected = new Map([
      [1, [[3, 2, 8, 6]]],
      [2, [[0, 0, 8, 2], [0, 2, 10, 6], [0, 6, 8, 8]]],
      [3, [[0, 0, 8, 2], [0, 2, 3, 6], [8, 2, 10, 6], [0, 6, 8, 8]]],
      [4, [[0, 0, 8, 2], [0, 2, 3, 6], [0, 6, 8, 8]]],
    ]);
    for (const [mode, rects] of expected) {
      const dst = wat.test_gdi_rgn_alloc_rect(0, 0, 0, 0);
      assert.strictEqual(wat.test_gdi_rgn_combine(dst, a, b, mode), rects.length === 1 ? 2 : 3);
      assert.deepStrictEqual(bands(dst), rects, `mode ${mode}`);
      assert.strictEqual(dv.getUint32(recordFor(dst), true), rects.length === 1 ? 1 : 2);
      const mirror = dv.getUint32(recordFor(dst) + 24, true);
      assert.deepStrictEqual(base.gdi._gdiObjects[mirror].rects,
        rects.map(([l, t, r, btm]) => ({ x: l, y: t, w: r - l, h: btm - t })));
    }
    const copy = wat.test_gdi_rgn_alloc_rect(0, 0, 0, 0);
    assert.strictEqual(wat.test_gdi_rgn_combine(copy, a, 0, 5), 2);
    assert.deepStrictEqual(bands(copy), [[0, 0, 8, 8]]);
  });

  check('adjacent equal bands coalesce vertically', () => {
    const top = wat.test_gdi_rgn_alloc_rect(0, 0, 4, 4);
    const bottom = wat.test_gdi_rgn_alloc_rect(0, 4, 4, 8);
    const dst = wat.test_gdi_rgn_alloc_rect(0, 0, 0, 0);
    assert.strictEqual(wat.test_gdi_rgn_combine(dst, top, bottom, 2), 2);
    assert.deepStrictEqual(bands(dst), [[0, 0, 4, 8]]);
  });

  check('ellipses scan-convert into exact canonical WAT bands', () => {
    const ellipse = wat.test_gdi_rgn_alloc_ellipse(0, 0, 10, 8);
    assert.notStrictEqual(ellipse, 0);
    assert.deepStrictEqual(bands(ellipse), [
      [3, 0, 7, 1], [1, 1, 9, 2], [0, 2, 10, 6],
      [1, 6, 9, 7], [3, 7, 7, 8],
    ]);
    assert.deepStrictEqual(box(ellipse), { complexity: 3, rect: [0, 0, 10, 8] });

    const negative = wat.test_gdi_rgn_alloc_ellipse(5, 4, -5, -4);
    assert.deepStrictEqual(bands(negative), [
      [-2, -4, 2, -3], [-4, -3, 4, -2], [-5, -2, 5, 2],
      [-4, 2, 4, 3], [-2, 3, 2, 4],
    ]);
    assert.deepStrictEqual(bands(wat.test_gdi_rgn_alloc_ellipse(0, 0, 1, 1)), [[0, 0, 1, 1]]);
    assert.deepStrictEqual(bands(wat.test_gdi_rgn_alloc_ellipse(4, 4, 4, 9)), []);
  });

  check('ellipse bands participate in WAT Boolean algebra', () => {
    const ellipse = wat.test_gdi_rgn_alloc_ellipse(0, 0, 10, 8);
    const clip = wat.test_gdi_rgn_alloc_rect(2, 1, 8, 7);
    const dst = wat.test_gdi_rgn_alloc_rect(0, 0, 0, 0);
    assert.strictEqual(wat.test_gdi_rgn_combine(dst, ellipse, clip, 1), 2);
    assert.deepStrictEqual(bands(dst), [[2, 1, 8, 7]]);
  });

  check('Boolean operations are alias-safe and preserve empty results', () => {
    const a = wat.test_gdi_rgn_alloc_rect(0, 0, 8, 8);
    const b = wat.test_gdi_rgn_alloc_rect(3, 2, 10, 6);
    assert.strictEqual(wat.test_gdi_rgn_combine(a, a, b, 4), 3);
    assert.deepStrictEqual(bands(a), [[0, 0, 8, 2], [0, 2, 3, 6], [0, 6, 8, 8]]);

    const far = wat.test_gdi_rgn_alloc_rect(20, 20, 30, 30);
    assert.strictEqual(wat.test_gdi_rgn_combine(a, a, far, 1), 1);
    assert.deepStrictEqual(bands(a), []);
    assert.deepStrictEqual(box(a), { complexity: 1, rect: [0, 0, 0, 0] });
  });

  check('arena overflow returns ERROR and leaves destination unchanged', () => {
    const buildStripes = startY => {
      const result = wat.test_gdi_rgn_alloc_rect(0, 0, 0, 0);
      for (let i = 0; i < 128; i++) {
        const stripe = wat.test_gdi_rgn_alloc_rect(0, startY + i * 4, 4, startY + i * 4 + 1);
        assert.notStrictEqual(stripe, 0);
        assert.notStrictEqual(wat.test_gdi_rgn_combine(result, result, stripe, 2), 0);
        assert.strictEqual(wat.test_gdi_rgn_delete(stripe), 1);
      }
      assert.strictEqual(bands(result).length, 128);
      return result;
    };
    const even = buildStripes(0);
    const odd = buildStripes(2);
    const dst = wat.test_gdi_rgn_alloc_rect(90, 91, 99, 100);
    assert.strictEqual(wat.test_gdi_rgn_combine(dst, even, odd, 2), 0);
    assert.deepStrictEqual(bands(dst), [[90, 91, 99, 100]]);
  });

  check('delete invalidates stale generations before reusing a slot', () => {
    const oldHandle = wat.test_gdi_rgn_alloc_rect(1, 1, 2, 2);
    assert.strictEqual(wat.test_gdi_rgn_delete(oldHandle), 1);
    const newHandle = wat.test_gdi_rgn_alloc_rect(4, 4, 9, 9);
    assert.strictEqual(newHandle & 0xFF, oldHandle & 0xFF);
    assert.notStrictEqual(newHandle, oldHandle);
    assert.strictEqual(wat.test_gdi_rgn_get_box(oldHandle, RECT_SCRATCH), 0);
    assert.deepStrictEqual(box(newHandle), { complexity: 2, rect: [4, 4, 9, 9] });
  });

  console.log(`\n${passed}/${passed} checks passed`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
