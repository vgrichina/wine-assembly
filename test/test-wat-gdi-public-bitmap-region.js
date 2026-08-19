#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: wat, memory } = await bootRenderHarness();
  const bytes = new Uint8Array(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;
  let passed = 0;
  const check = (name, fn) => {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  };
  const allocZero = size => {
    const pointer = wat.guest_alloc(size) >>> 0;
    for (let offset = 0; offset < size; offset += 4) wat.guest_write32(pointer + offset, 0);
    return pointer;
  };
  const readBytes = (pointer, size) => Array.from(bytes.subarray(wa(pointer), wa(pointer) + size));
  const writeByte = (pointer, value) => { bytes[wa(pointer)] = value; };

  check('CreateBitmapIndirect and bitmap bit access use canonical storage', () => {
    const pixels = allocZero(16);
    const initial = [
      0x11, 0x22, 0x33, 0, 0x44, 0x55, 0x66, 0,
      0x77, 0x88, 0x99, 0, 0xaa, 0xbb, 0xcc, 0,
    ];
    initial.forEach((value, index) => writeByte(pixels + index, value));
    const object = allocZero(24);
    wat.guest_write32(object + 4, 2);
    wat.guest_write32(object + 8, 2);
    wat.guest_write32(object + 12, 8);
    wat.guest_write16(object + 16, 1);
    wat.guest_write16(object + 18, 32);
    wat.guest_write32(object + 20, pixels);
    const bitmap = wat.test_call_CreateBitmapIndirect(object) >>> 0;
    assert(bitmap);
    const output = allocZero(16);
    assert.strictEqual(wat.test_call_GetBitmapBits(bitmap, 16, output), 16);
    assert.deepStrictEqual(readBytes(output, 16), initial);

    const replacement = initial.map((value, index) => index % 4 === 3 ? 0 : value ^ 0xff);
    replacement.forEach((value, index) => writeByte(output + index, value));
    assert.strictEqual(wat.test_call_SetBitmapBits(bitmap, 16, output), 16);
    const verify = allocZero(16);
    assert.strictEqual(wat.test_call_GetBitmapBits(bitmap, 64, verify), 16,
      'bitmap access must clamp to the canonical allocation');
    assert.deepStrictEqual(readBytes(verify, 16), replacement);

    const dimension = allocZero(8);
    assert.strictEqual(wat.test_call_GetBitmapDimensionEx(bitmap, dimension), 1);
    assert.deepStrictEqual([wat.guest_read32(dimension), wat.guest_read32(dimension + 4)], [0, 0]);
    assert.strictEqual(wat.test_call_DeleteObject(bitmap), 1);
  });

  check('GetBrushOrgEx reports independent per-DC brush origin', () => {
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const previous = allocZero(8);
    assert.strictEqual(wat.test_call_SetBrushOrgEx(hdc, -7, 13, previous), 1);
    const origin = allocZero(8);
    assert.strictEqual(wat.test_call_GetBrushOrgEx(hdc, origin), 1);
    assert.deepStrictEqual([wat.guest_read32(origin), wat.guest_read32(origin + 4)], [-7, 13]);
    assert.strictEqual(wat.test_call_DeleteDC(hdc), 1);
  });

  check('rounded rectangle regions expose exact point and RGNDATA semantics', () => {
    const region = wat.test_call_CreateRoundRectRgn(0, 0, 10, 10, 6, 6) >>> 0;
    assert(region);
    assert.strictEqual(wat.test_call_PtInRegion(region, 5, 5), 1);
    assert.strictEqual(wat.test_call_PtInRegion(region, 0, 0), 0);
    const required = wat.test_call_GetRegionData(region, 0, 0) >>> 0;
    assert(required >= 48 && required % 16 === 0);
    const data = allocZero(required);
    assert.strictEqual(wat.test_call_GetRegionData(region, required - 1, data), 0);
    assert.strictEqual(wat.test_call_GetRegionData(region, required, data), required);
    assert.strictEqual(wat.guest_read32(data), 32);
    assert.strictEqual(wat.guest_read32(data + 4), 1);
    assert.strictEqual(wat.guest_read32(data + 8) * 16 + 32, required);
    assert.deepStrictEqual([
      wat.guest_read32(data + 16), wat.guest_read32(data + 20),
      wat.guest_read32(data + 24), wat.guest_read32(data + 28),
    ], [0, 0, 10, 10]);
    assert.strictEqual(wat.test_call_DeleteObject(region), 1);
  });

  check('poly-polygon regions union each closed polygon', () => {
    const points = allocZero(6 * 8);
    [[0, 0], [4, 0], [0, 4], [10, 10], [14, 10], [10, 14]].forEach(([x, y], index) => {
      wat.guest_write32(points + index * 8, x);
      wat.guest_write32(points + index * 8 + 4, y);
    });
    const counts = allocZero(8);
    wat.guest_write32(counts, 3);
    wat.guest_write32(counts + 4, 3);
    const region = wat.test_call_CreatePolyPolygonRgn(points, counts, 2, 1) >>> 0;
    assert(region);
    assert.strictEqual(wat.test_call_PtInRegion(region, 1, 1), 1);
    assert.strictEqual(wat.test_call_PtInRegion(region, 11, 11), 1);
    assert.strictEqual(wat.test_call_PtInRegion(region, 7, 7), 0);
    assert.strictEqual(wat.test_call_DeleteObject(region), 1);
  });

  check('MaskBlt routes the public ROP4 API through the WAT mask kernel', () => {
    const srcBits = allocZero(8);
    wat.guest_write32(srcBits, 0x00112233);
    wat.guest_write32(srcBits + 4, 0x00445566);
    const dstBits = allocZero(8);
    wat.guest_write32(dstBits, 0x00aabbcc);
    wat.guest_write32(dstBits + 4, 0x00ddeeff);
    const maskBits = allocZero(2);
    writeByte(maskBits, 0x80);
    const srcBitmap = wat.test_call_CreateBitmap(2, 1, 1, 32, srcBits) >>> 0;
    const dstBitmap = wat.test_call_CreateBitmap(2, 1, 1, 32, dstBits) >>> 0;
    const maskBitmap = wat.test_call_CreateBitmap(2, 1, 1, 1, maskBits) >>> 0;
    const srcDc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const dstDc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    assert(srcBitmap && dstBitmap && maskBitmap && srcDc && dstDc);
    wat.test_call_SelectObject(srcDc, srcBitmap);
    wat.test_call_SelectObject(dstDc, dstBitmap);
    assert.strictEqual(wat.test_call_MaskBlt(
      dstDc, 0, 0, 2, 1, srcDc, 0, 0, maskBitmap, 0, 0, 0xaacc0020), 1);
    const output = allocZero(8);
    assert.strictEqual(wat.test_call_GetBitmapBits(dstBitmap, 8, output), 8);
    assert.strictEqual(wat.guest_read32(output) >>> 0, 0x00112233);
    assert.strictEqual(wat.guest_read32(output + 4) >>> 0, 0x00ddeeff);
    [srcBitmap, dstBitmap, maskBitmap].forEach(bitmap => wat.test_call_DeleteObject(bitmap));
    [srcDc, dstDc].forEach(dc => wat.test_call_DeleteDC(dc));
  });

  console.log(`\n${passed}/${passed} checks passed`);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
