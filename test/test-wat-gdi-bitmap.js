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
  let next = 0x00100000;
  let passed = 0;

  function alloc(size = 0x100) {
    const result = next;
    next += Math.max(size, 0x100);
    return result;
  }

  function check(name, fn) {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  }

  function initRecord({ dib = false, topDown = false } = {}) {
    const record = alloc();
    const bits = 0x1C002000;
    const flags = (dib ? 1 : 0) | (topDown ? 2 : 0);
    assert.strictEqual(wat.test_gdi_bitmap_record_init(
      record, 0x510001, 13, 7, 24, flags, bits, 40, 0, 0, 9), 1);
    return { record, bits };
  }

  function writeInfoHeader(at, { width, height, bpp, compression = 0, clrUsed = 0 }) {
    dv.setUint32(at, 40, true);
    dv.setInt32(at + 4, width, true);
    dv.setInt32(at + 8, height, true);
    dv.setUint16(at + 12, 1, true);
    dv.setUint16(at + 14, bpp, true);
    dv.setUint32(at + 16, compression, true);
    dv.setUint32(at + 32, clrUsed, true);
  }

  check('48-byte bitmap record initialization and query helpers are exact', () => {
    const { record, bits } = initRecord({ dib: true, topDown: true });
    assert.deepStrictEqual([
      dv.getUint32(record, true), dv.getUint32(record + 4, true),
      dv.getUint32(record + 8, true), dv.getUint32(record + 12, true),
      dv.getUint32(record + 16, true), dv.getUint32(record + 20, true),
      dv.getUint32(record + 24, true), dv.getUint32(record + 28, true),
      dv.getUint32(record + 40, true), dv.getUint32(record + 44, true),
    ], [0x510001, 3, 13, 7, 24, 3, bits, 40, 9, 0]);
    assert.strictEqual(wat.test_gdi_bitmap_record_width(record), 13);
    assert.strictEqual(wat.test_gdi_bitmap_record_height(record), 7);
    assert.strictEqual(wat.test_gdi_bitmap_record_bpp(record), 24);
    assert.strictEqual(wat.test_gdi_bitmap_record_storage(record), bits);
    assert.strictEqual(wat.test_gdi_bitmap_record_dib_bits(record), bits);
    assert.strictEqual(wat.test_gdi_bitmap_record_width(0), 0);
  });

  check('GetObject BITMAP writer exposes DIB bits but hides DDB backing', () => {
    const out = alloc();
    const dib = initRecord({ dib: true });
    assert.strictEqual(wat.test_gdi_bitmap_write_object(dib.record, out, 24), 24);
    assert.deepStrictEqual([
      dv.getInt32(out, true), dv.getInt32(out + 4, true), dv.getInt32(out + 8, true),
      dv.getInt32(out + 12, true), dv.getUint16(out + 16, true),
      dv.getUint16(out + 18, true), dv.getUint32(out + 20, true),
    ], [0, 13, 7, 40, 1, 24, 0x50002000]);

    const ddb = initRecord();
    bytes.fill(0xCC, out, out + 24);
    assert.strictEqual(wat.test_gdi_bitmap_write_object(ddb.record, out, 24), 24);
    assert.strictEqual(dv.getUint32(out + 20, true), 0,
      'BITMAP.bmBits must stay NULL for private DDB storage');
    assert.strictEqual(wat.test_gdi_bitmap_write_object(ddb.record, out, 23), 0);
  });

  check('RT_BITMAP parser accepts bounded bottom-up 24bpp payloads', () => {
    const data = alloc();
    const plan = alloc();
    writeInfoHeader(data, { width: 3, height: 2, bpp: 24 });
    for (let i = 0; i < 24; i++) bytes[data + 40 + i] = i + 1;
    assert.strictEqual(wat.test_gdi_bitmap_parse_dib(data, 64, plan), 1);
    assert.deepStrictEqual([
      dv.getUint32(plan, true), dv.getUint32(plan + 4, true),
      dv.getUint32(plan + 8, true), dv.getUint32(plan + 12, true),
      dv.getUint32(plan + 16, true), dv.getUint32(plan + 20, true),
      dv.getUint32(plan + 24, true), dv.getUint32(plan + 28, true),
      dv.getUint32(plan + 32, true), dv.getUint32(plan + 36, true),
    ], [3, 2, 24, 0, 12, 0, 0, data + 40, 24, 40]);
    assert.strictEqual(wat.test_gdi_bitmap_parse_dib(data, 63, plan), 0,
      'truncated resource pixel bytes must be rejected');
  });

  check('paletted top-down DIB plans expose exact palette and pixel spans', () => {
    const data = alloc();
    const plan = alloc();
    writeInfoHeader(data, { width: 2, height: -2, bpp: 8, clrUsed: 4 });
    const palette = [
      [0, 0, 0, 0], [0x10, 0x20, 0x30, 0],
      [0x40, 0x50, 0x60, 0], [0x70, 0x80, 0x90, 0],
    ];
    palette.flat().forEach((value, index) => { bytes[data + 40 + index] = value; });
    bytes.fill(2, data + 56, data + 64);
    assert.strictEqual(wat.test_gdi_bitmap_parse_dib(data, 64, plan), 1);
    assert.deepStrictEqual([
      dv.getUint32(plan + 4, true), dv.getUint32(plan + 8, true),
      dv.getUint32(plan + 12, true), dv.getUint32(plan + 16, true),
      dv.getUint32(plan + 20, true), dv.getUint32(plan + 24, true),
      dv.getUint32(plan + 28, true), dv.getUint32(plan + 32, true),
    ], [2, 8, 2, 4, data + 40, 4, data + 56, 8]);
  });

  check('DIB parser accepts matching bounded RLE and rejects invalid formats', () => {
    const data = alloc();
    const plan = alloc();
    writeInfoHeader(data, { width: 2, height: 2, bpp: 8, compression: 1 });
    dv.setUint32(data + 20, 4, true);
    bytes.set([0, 1, 0, 0], data + 40 + 256 * 4);
    assert.strictEqual(wat.test_gdi_bitmap_parse_dib(data, 40 + 256 * 4 + 4, plan), 1);
    assert.strictEqual(dv.getUint32(plan + 40, true), 1);
    assert.strictEqual(dv.getUint32(plan + 44, true), 4);
    writeInfoHeader(data, { width: 2, height: 2, bpp: 4, compression: 1 });
    assert.strictEqual(wat.test_gdi_bitmap_parse_dib(data, 1100, plan), 0,
      'BI_RLE8 must reject non-8bpp input');
    writeInfoHeader(data, { width: 2, height: 2, bpp: 8, compression: 2 });
    assert.strictEqual(wat.test_gdi_bitmap_parse_dib(data, 1100, plan), 0,
      'BI_RLE4 must reject non-4bpp input');
    writeInfoHeader(data, { width: 2, height: 2, bpp: 8, clrUsed: 257 });
    assert.strictEqual(wat.test_gdi_bitmap_parse_dib(data, 1100, plan), 0);
    writeInfoHeader(data, { width: 2, height: 2, bpp: 16 });
    assert.strictEqual(wat.test_gdi_bitmap_parse_dib(data, 1100, plan), 0);
    writeInfoHeader(data, { width: -2, height: 2, bpp: 24 });
    assert.strictEqual(wat.test_gdi_bitmap_parse_dib(data, 1100, plan), 0);
  });

  check('BI_RLE4 resource decoding produces exact packed bottom-up rows', () => {
    const data = alloc();
    writeInfoHeader(data, { width: 4, height: 2, bpp: 4, compression: 2, clrUsed: 7 });
    const palette = [
      [0, 0, 0, 0], [0, 0, 0x11, 0], [0, 0, 0x22, 0],
      [0, 0, 0x33, 0], [0, 0, 0x44, 0], [0, 0, 0x55, 0], [0, 0, 0x66, 0],
    ];
    palette.flat().forEach((value, index) => { bytes[data + 40 + index] = value; });
    const stream = [4, 0x12, 0, 0, 0, 4, 0x34, 0x56, 0, 1];
    dv.setUint32(data + 20, stream.length, true);
    bytes.set(stream, data + 40 + palette.length * 4);
    const bitmap = wat.test_gdi_bitmap_create_resource(
      data, 40 + palette.length * 4 + stream.length) >>> 0;
    assert(bitmap, 'valid RLE4 resource should materialize a DDB');
    const storage = wat.test_gdi_bitmap_storage(bitmap) >>> 0;
    assert.deepStrictEqual([...bytes.subarray(storage, storage + 8)],
      [0x12, 0x12, 0, 0, 0x34, 0x56, 0, 0]);
  });

  check('BI_RLE8 absolute runs decode and present palette colors', () => {
    const data = alloc();
    writeInfoHeader(data, { width: 4, height: 2, bpp: 8, compression: 1, clrUsed: 6 });
    const palette = Array.from({ length: 6 }, (_, index) => [0, index * 10, index * 20, 0]);
    palette.flat().forEach((value, index) => { bytes[data + 40 + index] = value; });
    const stream = [4, 1, 0, 0, 0, 4, 2, 3, 4, 5, 0, 1];
    dv.setUint32(data + 20, stream.length, true);
    bytes.set(stream, data + 40 + palette.length * 4);
    const bitmap = wat.test_gdi_bitmap_create_resource(
      data, 40 + palette.length * 4 + stream.length) >>> 0;
    assert(bitmap, 'valid RLE8 resource should materialize a DDB');
    const storage = wat.test_gdi_bitmap_storage(bitmap) >>> 0;
    assert.deepStrictEqual([...bytes.subarray(storage, storage + 8)], [1, 1, 1, 1, 2, 3, 4, 5]);
    const canvas = imports.gdi.surfacePresentations.get(bitmap).canvas.getContext('2d');
    assert.deepStrictEqual([...canvas.getImageData(0, 0, 1, 1).data], [40, 20, 0, 255]);
    assert.deepStrictEqual([...canvas.getImageData(0, 1, 1, 1).data], [20, 10, 0, 255]);
  });

  check('CreateBitmap planner uses Win32 WORD-aligned scanline sizes', () => {
    const plan = alloc();
    assert.strictEqual(wat.test_gdi_bitmap_plan_create_bitmap(9, 3, 1, 1, plan), 1);
    assert.deepStrictEqual([
      dv.getUint32(plan, true), dv.getUint32(plan + 4, true),
      dv.getUint32(plan + 8, true), dv.getUint32(plan + 16, true),
      dv.getUint32(plan + 32, true),
    ], [9, 3, 1, 2, 6]);
    assert.strictEqual(wat.test_gdi_bitmap_plan_create_bitmap(3, 2, 1, 24, plan), 1);
    assert.deepStrictEqual([dv.getUint32(plan + 8, true), dv.getUint32(plan + 16, true),
      dv.getUint32(plan + 32, true)], [24, 10, 20]);
    assert.strictEqual(wat.test_gdi_bitmap_plan_create_bitmap(2, 2, 2, 24, plan), 0);
  });

  console.log(`\n${passed}/${passed} checks passed`);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
