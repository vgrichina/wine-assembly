#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

async function main() {
  const root = path.join(__dirname, '..');
  const apiTable = JSON.parse(fs.readFileSync(path.join(root, 'src', 'api_table.json'), 'utf8'));
  for (const [name, nargs] of [['AngleArc', 6], ['Chord', 9], ['Pie', 9]]) {
    const api = apiTable.find(entry => entry.name === name);
    assert(api, `${name} must be exposed through the public API table`);
    assert.strictEqual(api.nargs, nargs, `${name} stdcall arity`);
  }
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
      width,
    };
  }

  function pixel(dib, x, y) {
    const p = dib.bits + (y * dib.width + x) * 4;
    return Array.from(bytes.slice(p, p + 3));
  }

  function clearDib(dib) {
    bytes.fill(0xff, dib.bits, dib.bits + dib.size);
  }

  function setIdentityMap(hdc) {
    wat.test_gdi_dc_set_field(hdc, 40, 0, 0);
    wat.test_gdi_dc_set_field(hdc, 44, 0, 0);
    wat.test_gdi_dc_set_field(hdc, 48, 1, 1);
    wat.test_gdi_dc_set_field(hdc, 52, 1, 1);
    wat.test_gdi_dc_set_field(hdc, 56, 0, 0);
    wat.test_gdi_dc_set_field(hdc, 60, 0, 0);
    wat.test_gdi_dc_set_field(hdc, 64, 1, 1);
    wat.test_gdi_dc_set_field(hdc, 68, 1, 1);
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
    assert.notStrictEqual(wat.test_gdi_dc_clip_clear(dib.hdc), 0);
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

  check('Ellipse records a closed four-cubic device-space figure without painting', () => {
    setIdentityMap(dib.hdc);
    bytes.fill(0x5a, dib.bits, dib.bits + dib.size);
    const before = bytes.slice(dib.bits, dib.bits + dib.size);
    assert.strictEqual(wat.test_call_SetArcDirection(dib.hdc, 1), 1);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_Ellipse(dib.hdc, 2, 2, 18, 14), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    assert.deepStrictEqual(bytes.slice(dib.bits, dib.bits + dib.size), before);
    assert.deepStrictEqual(readPath(dib.hdc), {
      points: [
        [18, 8], [18, 5], [14, 2], [10, 2],
        [6, 2], [2, 5], [2, 8],
        [2, 11], [6, 14], [10, 14],
        [14, 14], [18, 11], [18, 8],
      ],
      types: [6, ...Array(11).fill(4), 5],
    });
    const region = wat.test_call_PathToRegion(dib.hdc) >>> 0;
    assert(region);
    assert.strictEqual(wat.test_call_PtInRegion(region, 10, 8), 1);
    assert.strictEqual(wat.test_call_PtInRegion(region, 2, 2), 0);
    assert.strictEqual(wat.test_call_DeleteObject(region), 1);
  });

  check('RoundRect records cubic corners and straight sides with exact types', () => {
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_RoundRect(dib.hdc, 2, 2, 18, 14, 8, 6), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    assert.deepStrictEqual(readPath(dib.hdc), {
      points: [
        [18, 5], [18, 3], [16, 2], [14, 2],
        [6, 2], [4, 2], [2, 3], [2, 5],
        [2, 11], [2, 13], [4, 14], [6, 14],
        [14, 14], [16, 14], [18, 13], [18, 11],
      ],
      types: [6, 4, 4, 4, 2, 4, 4, 4, 2, 4, 4, 4, 2, 4, 4, 5],
    });
    assert.strictEqual(wat.test_call_AbortPath(dib.hdc), 1);
  });

  check('Arc and ArcTo record quadrant cubics and ArcTo connector/current position', () => {
    assert.strictEqual(wat.test_call_SetArcDirection(dib.hdc, 1), 1);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_Arc(dib.hdc, 2, 2, 18, 14, 18, 8, 10, 2), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    assert.deepStrictEqual(readPath(dib.hdc), {
      points: [
        [18, 8], [18, 5], [14, 2], [10, 2],
        [10, 2], [10, 2], [10, 2],
      ],
      types: [6, 4, 4, 4, 4, 4, 4],
    });
    assert.strictEqual(wat.test_call_AbortPath(dib.hdc), 1);

    assert.strictEqual(wat.test_call_MoveToEx(dib.hdc, 2, 8), 1);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_ArcTo(dib.hdc, 2, 2, 18, 14, 18, 8, 10, 2), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    assert.deepStrictEqual(readPath(dib.hdc), {
      points: [
        [2, 8], [18, 8], [18, 5], [14, 2], [10, 2],
        [10, 2], [10, 2], [10, 2],
      ],
      types: [6, 2, 4, 4, 4, 4, 4, 4],
    });
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 12, -1), 10);
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 16, -1), 2);
    assert.strictEqual(wat.test_call_AbortPath(dib.hdc), 1);
  });

  check('clockwise shape paths reverse their cubic traversal', () => {
    assert.strictEqual(wat.test_call_SetArcDirection(dib.hdc, 2), 1);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_Ellipse(dib.hdc, 2, 2, 18, 14), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    const path = readPath(dib.hdc);
    assert.deepStrictEqual(path.points.slice(0, 4), [[18, 8], [18, 11], [14, 14], [10, 14]]);
    assert.deepStrictEqual(path.types, [6, ...Array(11).fill(4), 5]);
    assert.strictEqual(wat.test_call_AbortPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_SetArcDirection(dib.hdc, 1), 2);
  });

  check('Chord and Pie record exact closed arc figures without painting', () => {
    clearDib(dib);
    const before = bytes.slice(dib.bits, dib.bits + dib.size);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_Chord(dib.hdc, 2, 2, 18, 14, 18, 8, 10, 2), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    assert.deepStrictEqual(readPath(dib.hdc), {
      points: [
        [18, 8], [18, 5], [14, 2], [10, 2],
        [10, 2], [10, 2], [10, 2],
      ],
      types: [6, 4, 4, 4, 4, 4, 5],
    });
    assert.deepStrictEqual(bytes.slice(dib.bits, dib.bits + dib.size), before);
    assert.strictEqual(wat.test_call_AbortPath(dib.hdc), 1);

    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_Pie(dib.hdc, 2, 2, 18, 14, 18, 8, 10, 2), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    assert.deepStrictEqual(readPath(dib.hdc), {
      points: [
        [18, 8], [18, 5], [14, 2], [10, 2],
        [10, 2], [10, 2], [10, 2], [10, 8],
      ],
      types: [6, 4, 4, 4, 4, 4, 4, 3],
    });
    assert.strictEqual(wat.test_call_AbortPath(dib.hdc), 1);
  });

  check('AngleArc records its connector and sweep while preserving arc direction', () => {
    assert.strictEqual(wat.test_call_SetArcDirection(dib.hdc, 2), 1);
    assert.strictEqual(wat.test_call_MoveToEx(dib.hdc, 2, 8), 1);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_AngleArc(dib.hdc, 10, 8, 6, 0, 90), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    assert.deepStrictEqual(readPath(dib.hdc), {
      points: [
        [2, 8], [16, 8], [16, 5], [13, 2], [10, 2],
        [10, 2], [10, 2], [10, 2],
      ],
      types: [6, 2, 4, 4, 4, 4, 4, 4],
    });
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 12, -1), 10);
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 16, -1), 2);
    assert.strictEqual(wat.test_call_AbortPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_SetArcDirection(dib.hdc, 1), 2);
  });

  check('AngleArc retains complete multi-turn sweeps instead of normalizing them away', () => {
    assert.strictEqual(wat.test_call_MoveToEx(dib.hdc, 2, 8), 1);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_AngleArc(dib.hdc, 10, 8, 6, 0, 450), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    const path = readPath(dib.hdc);
    assert.strictEqual(path.points.length, 24);
    assert.deepStrictEqual(path.points[0], [2, 8]);
    assert.deepStrictEqual(path.points[1], [16, 8]);
    assert.deepStrictEqual(path.points[13], [16, 8]);
    assert.deepStrictEqual(path.points[16], [16, 8]);
    assert.deepStrictEqual(path.points[17], [16, 8]);
    assert.deepStrictEqual(path.points[23], [10, 2]);
    assert.deepStrictEqual(path.types, [6, 2, ...Array(15).fill(4), 2, ...Array(6).fill(4)]);
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 12, -1), 10);
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 16, -1), 2);
    assert.strictEqual(wat.test_call_AbortPath(dib.hdc), 1);
  });

  check('AngleArc rejects invalid radius and float inputs without changing current position', () => {
    const x = wat.test_gdi_dc_get_field(dib.hdc, 12, -1);
    const y = wat.test_gdi_dc_get_field(dib.hdc, 16, -1);
    assert.strictEqual(wat.test_call_AngleArc(dib.hdc, 10, 8, 0, 0, 90), 0);
    assert.strictEqual(wat.test_call_AngleArc(dib.hdc, 10, 8, 6, NaN, 90), 0);
    assert.strictEqual(wat.test_call_AngleArc(dib.hdc, 10, 8, 6, Infinity, 90), 0);
    assert.strictEqual(wat.test_call_AngleArc(dib.hdc, 10, 8, 6, 0, Infinity), 0);
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 12, -1), x);
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 16, -1), y);
  });

  check('direct Chord/Pie rasterization preserves a retained application path', () => {
    clearDib(dib);
    const pen = wat.test_call_CreatePen(0, 1, 0x000000ff) >>> 0;
    const brush = wat.test_call_CreateSolidBrush(0x0000ff00) >>> 0;
    assert(pen && brush);
    assert.notStrictEqual(wat.test_call_SelectObject(dib.hdc, pen) | 0, -1);
    assert.notStrictEqual(wat.test_call_SelectObject(dib.hdc, brush) | 0, -1);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_Rectangle(dib.hdc, 1, 1, 4, 4), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    const retained = readPath(dib.hdc);
    assert.strictEqual(wat.test_call_Chord(dib.hdc, 2, 2, 18, 14, 18, 8, 10, 2), 1);
    assert.deepStrictEqual(readPath(dib.hdc), retained);
    assert.deepStrictEqual(pixel(dib, 14, 4), [0, 255, 0]);
    assert.deepStrictEqual(pixel(dib, 5, 12), [255, 255, 255]);
    assert.strictEqual(wat.test_call_Pie(dib.hdc, 2, 2, 18, 14, 18, 8, 10, 2), 1);
    assert.deepStrictEqual(readPath(dib.hdc), retained);
    assert.deepStrictEqual(pixel(dib, 13, 5), [0, 255, 0]);
    assert.strictEqual(wat.test_call_MoveToEx(dib.hdc, 2, 8), 1);
    assert.strictEqual(wat.test_call_AngleArc(dib.hdc, 10, 8, 6, 0, 90), 1);
    assert.deepStrictEqual(readPath(dib.hdc), retained);
    assert.deepStrictEqual(pixel(dib, 5, 8), [0, 0, 255]);
    assert.deepStrictEqual(pixel(dib, 16, 5), [0, 0, 255]);
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 12, -1), 10);
    assert.strictEqual(wat.test_gdi_dc_get_field(dib.hdc, 16, -1), 2);
    assert.strictEqual(wat.test_call_AbortPath(dib.hdc), 1);
    assert.notStrictEqual(wat.test_call_SelectObject(dib.hdc, 0x30017) | 0, -1);
    assert.notStrictEqual(wat.test_call_SelectObject(dib.hdc, 0x30010) | 0, -1);
    assert.strictEqual(wat.test_call_DeleteObject(pen), 1);
    assert.strictEqual(wat.test_call_DeleteObject(brush), 1);
  });

  check('FlattenPath converts cubic controls to exact device-space line points', () => {
    setIdentityMap(dib.hdc);
    const bezier = allocPoints([[1, 10], [3, 2], [7, 2], [9, 10]]);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_PolyBezier(dib.hdc, bezier, 4), 1);
    assert.strictEqual(wat.test_call_CloseFigure(dib.hdc), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_FlattenPath(dib.hdc), 1);
    const path = readPath(dib.hdc);
    assert.strictEqual(path.points.length, 33);
    assert.deepStrictEqual(path.points[0], [1, 10]);
    assert.deepStrictEqual(path.points[16], [5, 4]);
    assert.deepStrictEqual(path.points[32], [9, 10]);
    assert.deepStrictEqual(path.types, [6, ...Array(31).fill(2), 3]);
    const region = wat.test_call_PathToRegion(dib.hdc) >>> 0;
    assert(region);
    assert.strictEqual(wat.test_call_PtInRegion(region, 5, 7), 1);
    assert.strictEqual(wat.test_call_PtInRegion(region, 5, 2), 0);
    assert.strictEqual(wat.test_call_DeleteObject(region), 1);
  });

  check('PathToRegion flattens a retained cubic without an explicit FlattenPath', () => {
    setIdentityMap(dib.hdc);
    const bezier = allocPoints([[1, 10], [3, 2], [7, 2], [9, 10]]);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_PolyBezier(dib.hdc, bezier, 4), 1);
    assert.strictEqual(wat.test_call_CloseFigure(dib.hdc), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    const region = wat.test_call_PathToRegion(dib.hdc) >>> 0;
    assert(region);
    assert.strictEqual(wat.test_call_PtInRegion(region, 5, 7), 1);
    assert.strictEqual(wat.test_call_DeleteObject(region), 1);
  });

  check('FillPath uses the selected brush and consumes the closed path', () => {
    setIdentityMap(dib.hdc);
    clearDib(dib);
    const brush = wat.test_call_CreateSolidBrush(0x000000ff) >>> 0;
    assert(brush);
    assert.notStrictEqual(wat.test_call_SelectObject(dib.hdc, brush) | 0, -1);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_Rectangle(dib.hdc, 2, 3, 9, 11), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_FillPath(dib.hdc), 1);
    assert.deepStrictEqual(pixel(dib, 4, 5), [0, 0, 255]);
    assert.deepStrictEqual(pixel(dib, 12, 5), [255, 255, 255]);
    assert.strictEqual(wat.test_call_GetPath(dib.hdc, 0, 0, 0) | 0, -1);
    assert.notStrictEqual(wat.test_call_SelectObject(dib.hdc, 0x30010) | 0, -1);
    assert.strictEqual(wat.test_call_DeleteObject(brush), 1);
  });

  check('StrokePath paints only the selected-pen outline and consumes the path', () => {
    setIdentityMap(dib.hdc);
    clearDib(dib);
    const pen = wat.test_call_CreatePen(0, 1, 0x000000ff) >>> 0;
    assert(pen);
    assert.notStrictEqual(wat.test_call_SelectObject(dib.hdc, pen) | 0, -1);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_Rectangle(dib.hdc, 2, 3, 9, 11), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_StrokePath(dib.hdc), 1);
    assert.deepStrictEqual(pixel(dib, 2, 3), [0, 0, 255]);
    assert.deepStrictEqual(pixel(dib, 4, 5), [255, 255, 255]);
    assert.strictEqual(wat.test_call_GetPath(dib.hdc, 0, 0, 0) | 0, -1);
    assert.notStrictEqual(wat.test_call_SelectObject(dib.hdc, 0x30017) | 0, -1);
    assert.strictEqual(wat.test_call_DeleteObject(pen), 1);
  });

  check('StrokeAndFillPath closes open figures, fills, strokes, and consumes', () => {
    setIdentityMap(dib.hdc);
    clearDib(dib);
    const pen = wat.test_call_CreatePen(0, 1, 0x000000ff) >>> 0;
    const brush = wat.test_call_CreateSolidBrush(0x00ff0000) >>> 0;
    assert(pen && brush);
    assert.notStrictEqual(wat.test_call_SelectObject(dib.hdc, pen) | 0, -1);
    assert.notStrictEqual(wat.test_call_SelectObject(dib.hdc, brush) | 0, -1);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_MoveToEx(dib.hdc, 2, 2), 1);
    assert.strictEqual(wat.test_call_LineTo(dib.hdc, 12, 2), 1);
    assert.strictEqual(wat.test_call_LineTo(dib.hdc, 12, 10), 1);
    assert.strictEqual(wat.test_call_LineTo(dib.hdc, 2, 10), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_StrokeAndFillPath(dib.hdc), 1);
    assert.deepStrictEqual(pixel(dib, 2, 2), [0, 0, 255]);
    assert.deepStrictEqual(pixel(dib, 5, 5), [255, 0, 0]);
    assert.strictEqual(wat.test_call_GetPath(dib.hdc, 0, 0, 0) | 0, -1);
    assert.notStrictEqual(wat.test_call_SelectObject(dib.hdc, 0x30017) | 0, -1);
    assert.notStrictEqual(wat.test_call_SelectObject(dib.hdc, 0x30010) | 0, -1);
    assert.strictEqual(wat.test_call_DeleteObject(pen), 1);
    assert.strictEqual(wat.test_call_DeleteObject(brush), 1);
  });

  check('path consumers keep recorded device geometry after mapping changes', () => {
    setIdentityMap(dib.hdc);
    clearDib(dib);
    const brush = wat.test_call_CreateSolidBrush(0x0000ff00) >>> 0;
    assert(brush);
    assert.notStrictEqual(wat.test_call_SelectObject(dib.hdc, brush) | 0, -1);
    wat.test_gdi_dc_set_field(dib.hdc, 48, 1, 1);
    wat.test_gdi_dc_set_field(dib.hdc, 52, 1, 1);
    wat.test_gdi_dc_set_field(dib.hdc, 56, 2, 0);
    wat.test_gdi_dc_set_field(dib.hdc, 60, 1, 0);
    wat.test_gdi_dc_set_field(dib.hdc, 64, 2, 1);
    wat.test_gdi_dc_set_field(dib.hdc, 68, 1, 1);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_Rectangle(dib.hdc, 2, 3, 5, 8), 1);
    assert.strictEqual(wat.test_call_EndPath(dib.hdc), 1);
    wat.test_gdi_dc_set_field(dib.hdc, 56, 0, 0);
    wat.test_gdi_dc_set_field(dib.hdc, 64, 1, 1);
    assert.strictEqual(wat.test_call_FillPath(dib.hdc), 1);
    assert.deepStrictEqual(pixel(dib, 7, 5), [0, 255, 0]);
    assert.deepStrictEqual(pixel(dib, 3, 5), [255, 255, 255]);
    assert.notStrictEqual(wat.test_call_SelectObject(dib.hdc, 0x30010) | 0, -1);
    assert.strictEqual(wat.test_call_DeleteObject(brush), 1);
    setIdentityMap(dib.hdc);
  });

  check('path consumers reject open and absent paths without hiding state', () => {
    assert.strictEqual(wat.test_call_FillPath(dib.hdc), 0);
    assert.strictEqual(wat.test_call_StrokePath(dib.hdc), 0);
    assert.strictEqual(wat.test_call_StrokeAndFillPath(dib.hdc), 0);
    assert.strictEqual(wat.test_call_FlattenPath(dib.hdc), 0);
    assert.strictEqual(wat.test_call_BeginPath(dib.hdc), 1);
    assert.strictEqual(wat.test_call_MoveToEx(dib.hdc, 1, 1), 1);
    assert.strictEqual(wat.test_call_FillPath(dib.hdc), 0);
    assert.strictEqual(wat.test_call_StrokePath(dib.hdc), 0);
    assert.strictEqual(wat.test_call_GetPath(dib.hdc, 0, 0, 0) | 0, -1);
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
