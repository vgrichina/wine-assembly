#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

async function boot() {
  const harness = await bootRenderHarness();
  const memory = harness.memory;
  return {
    wat: harness.exports,
    memory,
    bytes: new Uint8Array(memory.buffer),
    dv: new DataView(memory.buffer),
    gdi: harness.gdi,
  };
}

function writeGuestBytes(wat, ptr, values) {
  for (let i = 0; i < values.length; i += 4) {
    let word = 0;
    for (let j = 0; j < 4 && i + j < values.length; j++) word |= values[i + j] << (j * 8);
    wat.guest_write32(ptr + i, word);
  }
}

function readBitmapObject(wat, handle, wide = false) {
  const out = wat.guest_alloc(24) >>> 0;
  const get = wide ? wat.test_call_GetObjectW : wat.test_call_GetObjectA;
  assert.strictEqual(get(handle, 24, out), 24);
  return [0, 4, 8, 12, 16, 20].map(offset => wat.guest_read32(out + offset) >>> 0);
}

(async () => {
  let passed = 0;
  const check = (name, fn) => {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  };

  const first = await boot();
  const { wat, bytes, gdi } = first;

  check('CreateBitmap copies exact WORD-aligned DDB bytes into WAT storage', () => {
    const source = Array.from({ length: 20 }, (_, i) => (i * 13 + 7) & 0xFF);
    const sourceGa = wat.guest_alloc(source.length) >>> 0;
    writeGuestBytes(wat, sourceGa, source);
    const bitmap = wat.test_call_CreateBitmap(3, 2, 1, 24, sourceGa) >>> 0;
    assert(bitmap, 'CreateBitmap should allocate a WAT bitmap record');
    const storage = wat.test_gdi_bitmap_storage(bitmap) >>> 0;
    assert.deepStrictEqual([...bytes.subarray(storage, storage + source.length)], source);
    assert.deepStrictEqual(readBitmapObject(wat, bitmap), [0, 3, 2, 10, 1 | (24 << 16), 0]);
    assert(gdi.surfacePresentations.has(bitmap), 'surface presentation must be derived from WAT storage');
    assert.strictEqual(wat.test_call_GetObjectA(bitmap, 23, sourceGa), 0,
      'undersized BITMAP output must fail without a partial structure');
  });

  check('CreateBitmap blank and invalid layouts have deterministic behavior', () => {
    const blank = wat.test_call_CreateBitmap(9, 3, 1, 1, 0) >>> 0;
    assert(blank);
    const storage = wat.test_gdi_bitmap_storage(blank) >>> 0;
    assert.deepStrictEqual([...bytes.subarray(storage, storage + 6)], [0, 0, 0, 0, 0, 0]);
    assert.deepStrictEqual(readBitmapObject(wat, blank, true), [0, 9, 3, 2, 1 | (1 << 16), 0]);
    assert.strictEqual(wat.test_call_CreateBitmap(2, 2, 2, 24, 0), 0);
    assert.strictEqual(wat.test_call_CreateBitmap(-1, 2, 1, 24, 0), 0);
  });

  check('CreateDIBitmap copies top-down indexed pixels and owned RGBQUADs', () => {
    const bmi = wat.guest_alloc(48) >>> 0;
    wat.guest_write32(bmi, 40);
    wat.guest_write32(bmi + 4, 2);
    wat.guest_write32(bmi + 8, -2);
    wat.guest_write32(bmi + 12, 1 | (8 << 16));
    wat.guest_write32(bmi + 16, 0);
    wat.guest_write32(bmi + 32, 2);
    writeGuestBytes(wat, bmi + 40, [0, 0, 0, 0, 0x11, 0x22, 0x33, 0]);
    const pixels = [1, 0, 0xA5, 0xA6, 0, 1, 0xB5, 0xB6];
    const pixelsGa = wat.guest_alloc(pixels.length) >>> 0;
    writeGuestBytes(wat, pixelsGa, pixels);
    const bitmap = wat.test_call_CreateDIBitmap(0, bmi, 4, pixelsGa, bmi, 0) >>> 0;
    assert(bitmap);
    const storage = wat.test_gdi_bitmap_storage(bitmap) >>> 0;
    assert.strictEqual(wat.test_gdi_bitmap_palette_count(bitmap), 2);
    assert.strictEqual(wat.test_gdi_bitmap_palette(bitmap) >>> 0, storage + 8);
    assert.deepStrictEqual([...bytes.subarray(storage, storage + 16)], [
      ...pixels, 0, 0, 0, 0, 0x11, 0x22, 0x33, 0,
    ]);
    assert.deepStrictEqual(readBitmapObject(wat, bitmap), [0, 2, 2, 4, 1 | (8 << 16), 0]);
    const presentation = gdi.surfacePresentations.get(bitmap);
    assert.strictEqual(presentation.surface.topDown, true);
    assert.deepStrictEqual(presentation.surface.palette, [[0, 0, 0], [0x33, 0x22, 0x11]]);
    assert.strictEqual(wat.test_call_CreateDIBitmap(0, bmi, 4, pixelsGa, bmi, 1), 0,
      'DIB_PAL_COLORS requires palette-object realization and must not be misrendered');
  });

  check('CreateDIBitmap without CBM_INIT ignores caller pixel bytes', () => {
    const bmi = wat.guest_alloc(40) >>> 0;
    wat.guest_write32(bmi, 40);
    wat.guest_write32(bmi + 4, 2);
    wat.guest_write32(bmi + 8, 2);
    wat.guest_write32(bmi + 12, 1 | (24 << 16));
    const pixelsGa = wat.guest_alloc(16) >>> 0;
    writeGuestBytes(wat, pixelsGa, new Array(16).fill(0xFE));
    const bitmap = wat.test_call_CreateDIBitmap(0, bmi, 0, pixelsGa, bmi, 0) >>> 0;
    assert(bitmap);
    const storage = wat.test_gdi_bitmap_storage(bitmap) >>> 0;
    assert.deepStrictEqual([...bytes.subarray(storage, storage + 16)], new Array(16).fill(0));
  });

  const resource = await boot();
  const rw = resource.wat;
  const rdv = resource.dv;
  const rbytes = resource.bytes;
  const guestBaseWa = 0x00012000;
  const root = guestBaseWa + 0x1000;
  const payload = guestBaseWa + 0x1100;
  rdv.setUint32(guestBaseWa + 0x3C, 0x80, true);
  rdv.setUint32(guestBaseWa + 0x80 + 136, 0x1000, true);
  rdv.setUint16(root + 14, 1, true);
  rdv.setUint32(root + 16, 2, true);
  rdv.setUint32(root + 20, 0x80000020, true);
  rdv.setUint16(root + 0x20 + 12, 1, true);
  rdv.setUint16(root + 0x20 + 14, 1, true);
  rdv.setUint32(root + 0x30, 0x80000080, true);
  rdv.setUint32(root + 0x34, 0x800000A0, true);
  rdv.setUint32(root + 0x38, 101, true);
  rdv.setUint32(root + 0x3C, 0x80000040, true);
  rdv.setUint16(root + 0x40 + 14, 1, true);
  rdv.setUint32(root + 0x50, 1033, true);
  rdv.setUint32(root + 0x54, 0x60, true);
  rdv.setUint32(root + 0x60, 0x1100, true);
  rdv.setUint32(root + 0x64, 56, true);
  rdv.setUint16(root + 0x80, 4, true);
  for (const [index, ch] of [...'TEST'].entries()) {
    rdv.setUint16(root + 0x82 + index * 2, ch.charCodeAt(0), true);
  }
  rdv.setUint16(root + 0xA0 + 14, 1, true);
  rdv.setUint32(root + 0xB0, 1033, true);
  rdv.setUint32(root + 0xB4, 0xC0, true);
  rdv.setUint32(root + 0xC0, 0x1100, true);
  rdv.setUint32(root + 0xC4, 56, true);
  rdv.setUint32(payload, 40, true);
  rdv.setInt32(payload + 4, 2, true);
  rdv.setInt32(payload + 8, 2, true);
  rdv.setUint16(payload + 12, 1, true);
  rdv.setUint16(payload + 14, 8, true);
  rdv.setUint32(payload + 32, 2, true);
  rbytes.set([0, 0, 0, 0, 0x30, 0x20, 0x10, 0], payload + 40);
  const resourcePixels = [1, 0, 0xAA, 0xAB, 0, 1, 0xBA, 0xBB];
  rbytes.set(resourcePixels, payload + 48);
  rw.init_thread(0, 0, 0, 0, 0, 0, 0);

  check('LoadBitmapA resolves raw RT_BITMAP bytes and owns an exact copy', () => {
    const bitmap = rw.test_call_LoadBitmapA(0, 101) >>> 0;
    assert(bitmap);
    const storage = rw.test_gdi_bitmap_storage(bitmap) >>> 0;
    assert.deepStrictEqual([...rbytes.subarray(storage, storage + 16)], [
      ...resourcePixels, 0, 0, 0, 0, 0x30, 0x20, 0x10, 0,
    ]);
    rbytes.fill(0xEE, payload + 40, payload + 56);
    assert.deepStrictEqual([...rbytes.subarray(storage, storage + 8)], resourcePixels);
    assert.deepStrictEqual(readBitmapObject(rw, bitmap), [0, 2, 2, 4, 1 | (8 << 16), 0]);

    const srcDc = rw.test_call_CreateCompatibleDC(0) >>> 0;
    assert.strictEqual(rw.test_call_SelectObject(srcDc, bitmap) >>> 0, 0x30007);
    const srcDesc = 0x07EF1000;
    assert.strictEqual(rw.test_gdi_surface_descriptor(srcDc, srcDesc), 1);
    assert.strictEqual(rdv.getUint32(srcDesc + 68, true), bitmap,
      'surface descriptor must retain the selected bitmap handle');
    assert.strictEqual(rw.test_gdi_bitmap_palette(bitmap) >>> 0, storage + 8);
    assert.strictEqual(rw.test_gdi_bitmap_palette_count(bitmap), 2);
    assert.strictEqual(rw.test_gdi_raster_palette_color(srcDesc, 1) >>> 0, 0x102030,
      'WAT raster palette lookup must resolve the selected bitmap RGBQUAD');
    const bmi = rw.guest_alloc(40) >>> 0;
    const bitsOut = rw.guest_alloc(4) >>> 0;
    rw.guest_write32(bmi, 40);
    rw.guest_write32(bmi + 4, 2);
    rw.guest_write32(bmi + 8, -2);
    rw.guest_write32(bmi + 12, 1 | (32 << 16));
    const dstBitmap = rw.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
    const dstDc = rw.test_call_CreateCompatibleDC(0) >>> 0;
    assert(dstBitmap && dstDc);
    assert.strictEqual(rw.test_call_SelectObject(dstDc, dstBitmap) >>> 0, 0x30007);
    assert.strictEqual(rw.test_call_BitBlt(
      dstDc, 0, 0, 2, 2, srcDc, 0, 0, 0x00CC0020), 1);
    const dstStorage = rw.test_gdi_bitmap_storage(dstBitmap) >>> 0;
    const pixel = offset => rbytes[offset] | (rbytes[offset + 1] << 8) |
      (rbytes[offset + 2] << 16);
    assert.deepStrictEqual([
      pixel(dstStorage), pixel(dstStorage + 4),
      pixel(dstStorage + 8), pixel(dstStorage + 12),
    ], [0, 0x102030, 0x102030, 0],
    'indexed source pixels must expand through their owned RGBQUAD palette');
  });

  check('LoadBitmapW handles integer and named resources; misses return NULL', () => {
    rbytes.set([0, 0, 0, 0, 0x30, 0x20, 0x10, 0], payload + 40);
    rbytes.set(resourcePixels, payload + 48);
    const bitmap = rw.test_call_LoadBitmapW(0, 101) >>> 0;
    assert(bitmap);
    const wideName = rw.guest_alloc(10) >>> 0;
    rw.guest_write32(wideName, 'T'.charCodeAt(0) | ('E'.charCodeAt(0) << 16));
    rw.guest_write32(wideName + 4, 'S'.charCodeAt(0) | ('T'.charCodeAt(0) << 16));
    rw.guest_write32(wideName + 8, 0);
    assert(rw.test_call_LoadBitmapW(0, wideName) >>> 0,
      'wide resource names should resolve through the shared raw-byte walker');
    assert.strictEqual(rw.test_call_LoadBitmapA(0, 999), 0,
      'missing resources must not fabricate a placeholder bitmap');
  });

  console.log(`\n${passed}/${passed} checks passed`);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
