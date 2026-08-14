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
  const imports = createHostImports({ getMemory: () => memory.buffer, renderer: null, resourceJson: {} });
  Object.assign(imports.host, {
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
  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const wat = instance.exports;
  const bytes = new Uint8Array(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  let passed = 0;

  function check(name, fn) {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  }

  function wasmAddress(guestAddress) {
    return (guestAddress - imageBase + 0x12000) >>> 0;
  }

  function allocPoints(values) {
    const ptr = wat.guest_alloc(values.length * 8) >>> 0;
    assert(ptr);
    values.forEach(([x, y], i) => {
      wat.guest_write32(ptr + i * 8, x);
      wat.guest_write32(ptr + i * 8 + 4, y);
    });
    return ptr;
  }

  function readPath(hdc) {
    const count = wat.test_call_GetPath(hdc, 0, 0, 0) | 0;
    assert(count >= 0);
    const points = wat.guest_alloc(Math.max(1, count) * 8) >>> 0;
    const types = wat.guest_alloc(Math.max(1, count)) >>> 0;
    assert(points && types);
    assert.strictEqual(wat.test_call_GetPath(hdc, points, types, count) | 0, count);
    return {
      points: Array.from({ length: count }, (_, i) => [
        wat.guest_read32(points + i * 8) | 0,
        wat.guest_read32(points + i * 8 + 4) | 0,
      ]),
      types: Array.from(bytes.slice(wasmAddress(types), wasmAddress(types) + count)),
    };
  }

  function makeDib(width, height) {
    const bmi = wat.guest_alloc(64) >>> 0;
    const out = wat.guest_alloc(4) >>> 0;
    wat.guest_write32(bmi, 40);
    wat.guest_write32(bmi + 4, width);
    wat.guest_write32(bmi + 8, -height);
    wat.guest_write16(bmi + 12, 1);
    wat.guest_write16(bmi + 14, 32);
    const bitmap = wat.test_call_CreateDIBSection(0, bmi, out) >>> 0;
    const bitsGuest = wat.guest_read32(out) >>> 0;
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    assert(bitmap && bitsGuest && hdc);
    assert.strictEqual(wat.test_call_SelectObject(hdc, bitmap) >>> 0, 0x30007);
    return {
      bitmap,
      hdc,
      bits: 0x1c000000 + (bitsGuest - 0x50000000),
      size: width * height * 4,
    };
  }

  const dib = makeDib(20, 16);

  check('path lifecycle rejects invalid states and AbortPath discards closed paths', () => {
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 0);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_GetPath(dib.hdc, 0, 0, 0) | 0, -1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 0);
    assert.deepStrictEqual(readPath(dib.hdc), { points: [], types: [] });
    assert.strictEqual(wat.test_call_AbortPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_GetPath(dib.hdc, 0, 0, 0) | 0, -1);
    assert.strictEqual(wat.test_call_AbortPath(0xdeadbeef), 0);
  });

  check('MoveToEx, LineTo, and CloseFigure record typed points without painting', () => {
    bytes.fill(0x5a, dib.bits, dib.bits + dib.size);
    const before = bytes.slice(dib.bits, dib.bits + dib.size);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_MoveToEx(dib.hdc, 2, 2), 1);
    assert.strictEqual(wat.test_call_LineTo(dib.hdc, 12, 2), 1);
    assert.strictEqual(wat.test_call_LineTo(dib.hdc, 12, 10), 1);
    assert.strictEqual(wat.test_call_CloseFigure(dib.hdc), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    assert.deepStrictEqual(bytes.slice(dib.bits, dib.bits + dib.size), before);
    assert.deepStrictEqual(readPath(dib.hdc), {
      points: [[2, 2], [12, 2], [12, 10]],
      types: [6, 2, 3],
    });
    const region = wat.test_call_PathToRegion(dib.hdc) >>> 0;
    assert(region);
    assert.strictEqual(wat.test_call_PtInRegion(region, 10, 3), 1);
    assert.strictEqual(wat.test_call_PtInRegion(region, 3, 9), 0);
    assert.strictEqual(wat.test_call_GetPath(dib.hdc, 0, 0, 0) | 0, -1);
    assert.strictEqual(wat.test_call_DeleteObject(region), 1);
  });

  check('GetPath inversely maps device points through the current transform', () => {
    assert.strictEqual(wat.test_gdi_dc_set_field(dib.hdc, 40, 10, 0), 0);
    assert.strictEqual(wat.test_gdi_dc_set_field(dib.hdc, 44, 20, 0), 0);
    assert.strictEqual(wat.test_gdi_dc_set_field(dib.hdc, 48, 2, 1), 1);
    assert.strictEqual(wat.test_gdi_dc_set_field(dib.hdc, 52, 3, 1), 1);
    assert.strictEqual(wat.test_gdi_dc_set_field(dib.hdc, 56, 3, 0), 0);
    assert.strictEqual(wat.test_gdi_dc_set_field(dib.hdc, 60, 5, 0), 0);
    assert.strictEqual(wat.test_gdi_dc_set_field(dib.hdc, 64, 4, 1), 1);
    assert.strictEqual(wat.test_gdi_dc_set_field(dib.hdc, 68, 6, 1), 1);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_MoveToEx(dib.hdc, 12, 23), 1);
    assert.strictEqual(wat.test_call_LineTo(dib.hdc, 14, 26), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    assert.deepStrictEqual(readPath(dib.hdc), {
      points: [[12, 23], [14, 26]],
      types: [6, 2],
    });
    assert.strictEqual(wat.test_gdi_dc_set_field(dib.hdc, 40, 0, 0), 10);
    assert.strictEqual(wat.test_gdi_dc_set_field(dib.hdc, 44, 0, 0), 20);
    assert.strictEqual(wat.test_gdi_dc_set_field(dib.hdc, 48, 1, 1), 2);
    assert.strictEqual(wat.test_gdi_dc_set_field(dib.hdc, 52, 1, 1), 3);
    assert.strictEqual(wat.test_gdi_dc_set_field(dib.hdc, 56, 1, 0), 3);
    assert.strictEqual(wat.test_gdi_dc_set_field(dib.hdc, 60, 1, 0), 5);
    assert.strictEqual(wat.test_gdi_dc_set_field(dib.hdc, 64, 2, 1), 4);
    assert.strictEqual(wat.test_gdi_dc_set_field(dib.hdc, 68, 2, 1), 6);
    assert.deepStrictEqual(readPath(dib.hdc), {
      points: [[3, 5], [5, 8]],
      types: [6, 2],
    });
    assert.strictEqual(wat.test_call_AbortPath(dib.hdc), 1);
  });

  check('Rectangle records a closed path and SelectClipPath derives its region', () => {
    bytes.fill(0x33, dib.bits, dib.bits + dib.size);
    const before = bytes.slice(dib.bits, dib.bits + dib.size);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_Rectangle(dib.hdc, 2, 3, 9, 11), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    assert.deepStrictEqual(bytes.slice(dib.bits, dib.bits + dib.size), before);
    assert.deepStrictEqual(readPath(dib.hdc), {
      points: [[2, 3], [9, 3], [9, 11], [2, 11]],
      types: [6, 2, 2, 3],
    });
    assert.strictEqual(wat.test_call_SelectClipPath(dib.hdc, 5), 1);
    assert.strictEqual(wat.test_gdi_dc_clip_point_visible(dib.hdc, 4, 5), 1);
    assert.strictEqual(wat.test_gdi_dc_clip_point_visible(dib.hdc, 12, 5), 0);
    assert.strictEqual(wat.test_call_AbortPath(dib.hdc), 1);
  });

  check('Polygon and PolylineTo preserve figure boundaries and current position', () => {
    const triangle = allocPoints([[1, 1], [6, 1], [1, 6]]);
    const tail = allocPoints([[9, 8], [10, 9]]);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_Polygon(dib.hdc, triangle, 3), 1);
    assert.strictEqual(wat.test_call_MoveToEx(dib.hdc, 8, 7), 1);
    assert.strictEqual(wat.test_call_PolylineTo(dib.hdc, tail, 2), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    assert.deepStrictEqual(readPath(dib.hdc), {
      points: [[1, 1], [6, 1], [1, 6], [8, 7], [9, 8], [10, 9]],
      types: [6, 2, 3, 6, 2, 2],
    });
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 12, -1), 10);
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 16, -1), 9);
    assert.strictEqual(wat.test_call_AbortPath(dib.hdc), 1);
  });

  check('Bezier and PolyDraw calls retain exact control-point types', () => {
    const bezier = allocPoints([[1, 10], [3, 2], [7, 2], [9, 10]]);
    const bezierTo = allocPoints([[11, 14], [14, 14], [16, 10]]);
    const draw = allocPoints([[2, 12], [6, 12], [6, 14]]);
    const drawTypes = wat.guest_alloc(3) >>> 0;
    bytes.set([6, 2, 3], wasmAddress(drawTypes));
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_PolyBezier(dib.hdc, bezier, 4), 1);
    assert.strictEqual(wat.test_call_PolyBezierTo(dib.hdc, bezierTo, 3), 1);
    assert.strictEqual(wat.test_call_PolyDraw(dib.hdc, draw, drawTypes, 3), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    assert.deepStrictEqual(readPath(dib.hdc), {
      points: [
        [1, 10], [3, 2], [7, 2], [9, 10],
        [11, 14], [14, 14], [16, 10],
        [2, 12], [6, 12], [6, 14],
      ],
      types: [6, 4, 4, 4, 4, 4, 4, 6, 2, 3],
    });
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 12, -1), 6);
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 16, -1), 14);
    assert.strictEqual(wat.test_call_AbortPath(dib.hdc), 1);
  });

  check('PolyPolyline records each sub-polyline as a disjoint figure', () => {
    const points = allocPoints([[1, 1], [4, 1], [4, 4], [10, 2], [12, 4]]);
    const counts = wat.guest_alloc(8) >>> 0;
    wat.guest_write32(counts, 3);
    wat.guest_write32(counts + 4, 2);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_PolyPolyline(dib.hdc, points, counts, 2), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    assert.deepStrictEqual(readPath(dib.hdc), {
      points: [[1, 1], [4, 1], [4, 4], [10, 2], [12, 4]],
      types: [6, 2, 2, 6, 2],
    });
    assert.strictEqual(wat.test_call_AbortPath(dib.hdc), 1);
  });

  check('path buffer grows past its initial capacity and DC deletion releases it', () => {
    const values = Array.from({ length: 40 }, (_, i) => [i % 20, (i * 3) % 15]);
    const points = allocPoints(values);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_Polyline(dib.hdc, points, values.length), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_GetPath(dib.hdc, 0, 0, 0), 40);
    assert.strictEqual(wat.test_call_DeleteDC(dib.hdc), 1);
    assert.strictEqual(wat.test_call_GetPath(dib.hdc, 0, 0, 0) | 0, -1);
    assert.strictEqual(wat.test_call_DeleteObject(dib.bitmap), 1);
  });

  console.log(`\n${passed}/${passed} WAT path checks passed.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
