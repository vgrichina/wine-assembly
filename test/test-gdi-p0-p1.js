#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

async function main() {
  const root = path.join(__dirname, '..');
  const table = JSON.parse(fs.readFileSync(path.join(root, 'src/api_table.json'), 'utf8'));
  const expected = new Map([
    ['CloseEnhMetaFile', 1], ['ColorMatchToTarget', 3],
    ['CreateEllipticRgnIndirect', 1], ['CreateEnhMetaFileA', 4],
    ['EqualRgn', 2], ['ExtCreateRegion', 3],
    ['GetCharacterPlacementA', 6], ['SetICMMode', 2], ['SetICMProfileA', 2],
  ]);
  for (const [name, nargs] of expected) {
    const api = table.find(entry => entry.name === name);
    assert(api, `${name} is public`);
    assert.strictEqual(api.nargs, nargs, `${name} arity`);
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
  const view = new DataView(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  let passed = 0;

  function wasmAddress(guest) {
    return (guest - imageBase + 0x12000) >>> 0;
  }
  function alloc(size) {
    const p = wat.guest_alloc(size) >>> 0;
    assert(p, `allocate ${size}`);
    return p;
  }
  function writeBytes(guest, values) {
    bytes.set(values, wasmAddress(guest));
  }
  function writeString(value) {
    const p = alloc(value.length + 1);
    writeBytes(p, [...Buffer.from(value, 'latin1'), 0]);
    return p;
  }
  function readString(guest, max = 256) {
    const start = wasmAddress(guest);
    let end = start;
    while (end < start + max && bytes[end]) end++;
    return Buffer.from(bytes.slice(start, end)).toString('latin1');
  }
  function check(name, fn) {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  }

  check('all nine corpus APIs are append-only public dispatch entries', () => {
    const firstId = table.find(entry => entry.name === expected.keys().next().value).id;
    const entries = table.slice(firstId, firstId + expected.size);
    assert.deepStrictEqual(entries.map(x => x.name), [...expected.keys()]);
    entries.forEach((entry, i) => assert.strictEqual(entry.id, firstId + i));
  });

  check('indirect ellipse and exact normalized region equality', () => {
    const rect = alloc(16);
    [2, 3, 14, 13].forEach((v, i) => wat.guest_write32(rect + i * 4, v));
    const a = wat.test_call_CreateEllipticRgnIndirect(rect) >>> 0;
    const b = wat.test_gdi_rgn_alloc_ellipse(2, 3, 14, 13) >>> 0;
    const c = wat.test_gdi_rgn_alloc_rect(2, 3, 14, 13) >>> 0;
    assert(a && b && c);
    assert.strictEqual(wat.test_call_EqualRgn(a, b), 1);
    assert.strictEqual(wat.test_call_EqualRgn(a, c), 0);
    assert.strictEqual(wat.test_call_CreateEllipticRgnIndirect(0), 0);
    [a, b, c].forEach(r => assert.strictEqual(wat.test_gdi_rgn_delete(r), 1));
  });

  check('ExtCreateRegion unions RGNDATA rectangles and applies an affine XFORM', () => {
    const data = alloc(64);
    wat.guest_write32(data, 32);
    wat.guest_write32(data + 4, 1);
    wat.guest_write32(data + 8, 2);
    wat.guest_write32(data + 12, 32);
    [0, 0, 3, 3, 6, 0, 9, 3].forEach((v, i) => wat.guest_write32(data + 32 + i * 4, v));
    const xf = alloc(24);
    const wa = wasmAddress(xf);
    [1, 0, 0, 1, 10, 20].forEach((v, i) => view.setFloat32(wa + i * 4, v, true));
    const region = wat.test_call_ExtCreateRegion(xf, 64, data) >>> 0;
    assert(region);
    assert.strictEqual(wat.test_call_PtInRegion(region, 11, 21), 1);
    assert.strictEqual(wat.test_call_PtInRegion(region, 14, 21), 0);
    assert.strictEqual(wat.test_call_PtInRegion(region, 17, 21), 1);
    assert.strictEqual(wat.test_gdi_rgn_delete(region), 1);
  });

  const dc = wat.test_call_CreateCompatibleDC(0) >>> 0;
  const target = wat.test_call_CreateCompatibleDC(0) >>> 0;
  assert(dc && target);

  check('ANSI character placement adapts strings while preserving result arrays', () => {
    const text = writeString('ABC');
    const results = alloc(36);
    const output = alloc(4);
    const order = alloc(12);
    const dx = alloc(12);
    const caret = alloc(12);
    const classes = alloc(3);
    const glyphs = alloc(6);
    wat.guest_write32(results, 36);
    [output, order, dx, caret, classes, glyphs].forEach((p, i) => wat.guest_write32(results + 4 + i * 4, p));
    wat.guest_write32(results + 28, 3);
    const packed = wat.test_call_GetCharacterPlacementA(dc, text, 3, 1000, results, 0) >>> 0;
    assert.strictEqual(typeof packed, 'number');
    assert.strictEqual(wat.guest_read32(results + 28), 3);
    assert.strictEqual(wat.guest_read32(results + 32), 3);
    assert.strictEqual(readString(output, 3), 'ABC');
    assert.deepStrictEqual([0, 1, 2].map(i => wat.guest_read32(order + i * 4)), [0, 1, 2]);
    assert.deepStrictEqual([0, 1, 2].map(i => view.getUint16(wasmAddress(glyphs + i * 2), true)), [65, 66, 67]);
  });

  check('ICM mode/profile and target matching are per-DC observable state', () => {
    assert.strictEqual(wat.test_call_SetICMMode(dc, 3), 1);
    assert.strictEqual(wat.test_call_SetICMMode(dc, 2), 1);
    assert.strictEqual(wat.test_call_SetICMMode(dc, 3), 2);
    assert.strictEqual(wat.test_call_SetICMMode(dc, 99), 0);
    assert.strictEqual(wat.test_call_SetICMMode(0xdeadbeef, 3), 0);
    const profile = writeString('profiles/custom.icm');
    assert.strictEqual(wat.test_call_SetICMProfileA(dc, profile), 1);
    const length = alloc(4);
    const output = alloc(64);
    wat.guest_write32(length, 64);
    assert.strictEqual(wat.test_call_GetICMProfileA(dc, length, output), 1);
    assert.strictEqual(readString(output), 'profiles/custom.icm');
    assert.strictEqual(wat.test_call_ColorMatchToTarget(dc, target, 1), 1);
    assert.strictEqual(wat.test_call_ColorMatchToTarget(dc, 0, 1), 0);
    assert.strictEqual(wat.test_call_ColorMatchToTarget(dc, 0, 2), 1);
  });

  check('enhanced metafile recorder closes to a valid EMF handle', () => {
    const recording = wat.test_call_CreateEnhMetaFileA(0, 0, 0, 0) >>> 0;
    assert(recording);
    const emf = wat.test_call_CloseEnhMetaFile(recording) >>> 0;
    assert(emf);
    assert(wat.test_call_GetEnhMetaFileBits(emf, 0, 0) >= 108);
    assert.strictEqual(wat.test_call_DeleteEnhMetaFile(emf), 1);
    assert.strictEqual(wat.test_call_CreateEnhMetaFileA(0, writeString('file.emf'), 0, 0), 0);
  });

  check('adaptive cubic flattening scales with device-space curvature', () => {
    assert.strictEqual(wat.test_gdi_bezier_leaf_count(0, 0, 3, 0, 7, 0, 10, 0), 1);
    const modest = wat.test_gdi_bezier_leaf_count(0, 0, 0, 10, 10, 10, 10, 0);
    const large = wat.test_gdi_bezier_leaf_count(0, 0, 0, 10000, 10000, 10000, 10000, 0);
    assert(modest > 1 && modest < 32, `modest leaf count ${modest}`);
    assert(large > 32, `large leaf count ${large}`);
  });

  check('geometric flat, round, and square caps produce distinct regions', () => {
    const brush = alloc(12);
    wat.guest_write32(brush, 0);
    wat.guest_write32(brush + 4, 0);
    wat.guest_write32(brush + 8, 0);
    function widened(style) {
      const pen = wat.test_call_ExtCreatePen(0x10000 | style, 6, brush, 0, 0) >>> 0;
      assert(pen);
      assert.notStrictEqual(wat.test_call_SelectObject(dc, pen) | 0, -1);
      assert.strictEqual(wat.test_call_BeginPath(dc), 1);
      assert.strictEqual(wat.test_call_MoveToEx(dc, 5, 10), 1);
      assert.strictEqual(wat.test_call_LineTo(dc, 15, 10), 1);
      assert.strictEqual(wat.test_call_EndPath(dc), 1);
      assert.strictEqual(wat.test_call_WidenPath(dc), 1);
      const region = wat.test_call_PathToRegion(dc) >>> 0;
      assert(region);
      assert.notStrictEqual(wat.test_call_SelectObject(dc, 0x30017) | 0, -1);
      assert.strictEqual(wat.test_call_DeleteObject(pen), 1);
      return region;
    }
    const round = widened(0x0000);
    const square = widened(0x0100);
    const flat = widened(0x0200);
    assert.strictEqual(wat.test_call_PtInRegion(flat, 3, 10), 0);
    assert.strictEqual(wat.test_call_PtInRegion(round, 3, 10), 1);
    assert.strictEqual(wat.test_call_PtInRegion(square, 3, 10), 1);
    assert.strictEqual(wat.test_call_PtInRegion(round, 2, 7), 0);
    assert.strictEqual(wat.test_call_PtInRegion(square, 2, 7), 1);
    [round, square, flat].forEach(r => assert.strictEqual(wat.test_gdi_rgn_delete(r), 1));
  });

  check('geometric round and angular joins produce distinct outer wedges', () => {
    const brush = alloc(12);
    function widenedJoin(join) {
      const pen = wat.test_call_ExtCreatePen(0x10000 | 0x0200 | join, 8, brush, 0, 0) >>> 0;
      assert(pen);
      assert.strictEqual(view.getUint32(wat.test_gdi_object_record(pen) + 20, true) & 0xf000, join);
      assert.notStrictEqual(wat.test_call_SelectObject(dc, pen) | 0, -1);
      assert.strictEqual(wat.test_call_BeginPath(dc), 1);
      assert.strictEqual(wat.test_call_MoveToEx(dc, 5, 15), 1);
      assert.strictEqual(wat.test_call_LineTo(dc, 10, 10), 1);
      assert.strictEqual(wat.test_call_LineTo(dc, 15, 15), 1);
      assert.strictEqual(wat.test_call_EndPath(dc), 1);
      assert.strictEqual(wat.test_call_WidenPath(dc), 1);
      const region = wat.test_call_PathToRegion(dc) >>> 0;
      assert(region);
      assert.notStrictEqual(wat.test_call_SelectObject(dc, 0x30017) | 0, -1);
      assert.strictEqual(wat.test_call_DeleteObject(pen), 1);
      return region;
    }
    const round = widenedJoin(0x0000);
    const bevel = widenedJoin(0x1000);
    const miter = widenedJoin(0x2000);
    assert.strictEqual(wat.test_call_EqualRgn(round, bevel), 0);
    assert.strictEqual(wat.test_call_EqualRgn(round, miter), 0);
    [round, bevel, miter].forEach(r => assert.strictEqual(wat.test_gdi_rgn_delete(r), 1));
  });

  assert.strictEqual(wat.test_call_DeleteDC(target), 1);
  assert.strictEqual(wat.test_call_DeleteDC(dc), 1);
  console.log(`\n${passed}/${passed} GDI Priority-0/1 checks passed.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
