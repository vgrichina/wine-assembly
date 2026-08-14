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
    bytes.fill(0, wa(pointer), wa(pointer) + size);
    return pointer;
  };
  const makeWmf = () => {
    const data = allocZero(24);
    wat.guest_write16(data, 1);
    wat.guest_write16(data + 2, 9);
    wat.guest_write16(data + 4, 0x0300);
    wat.guest_write32(data + 6, 12);
    wat.guest_write32(data + 12, 3);
    wat.guest_write32(data + 18, 3);
    return data;
  };
  const makeEmf = () => {
    const data = allocZero(108);
    wat.guest_write32(data, 1);
    wat.guest_write32(data + 4, 88);
    wat.guest_write32(data + 40, 0x464d4520);
    wat.guest_write32(data + 44, 0x00010000);
    wat.guest_write32(data + 48, 108);
    wat.guest_write32(data + 52, 2);
    wat.guest_write16(data + 56, 1);
    wat.guest_write32(data + 88, 14);
    wat.guest_write32(data + 92, 20);
    wat.guest_write32(data + 104, 20);
    return data;
  };
  const readBytes = (pointer, size) => Array.from(bytes.subarray(wa(pointer), wa(pointer) + size));
  const read16 = pointer => bytes[wa(pointer)] | (bytes[wa(pointer) + 1] << 8);

  check('classic WMF bits are owned, copied, typed, and deleted in WAT', () => {
    const source = makeWmf();
    const metafile = wat.test_call_SetMetaFileBitsEx(24, source) >>> 0;
    assert(metafile);
    assert.strictEqual(wat.test_call_GetObjectType(metafile), 9);
    assert.strictEqual(wat.test_call_GetMetaFileBitsEx(metafile, 0, 0), 24);
    const output = allocZero(24);
    assert.strictEqual(wat.test_call_GetMetaFileBitsEx(metafile, 24, output), 24);
    assert.deepStrictEqual(readBytes(output, 24), readBytes(source, 24));
    assert.strictEqual(wat.test_call_DeleteMetaFile(metafile), 1);
    assert.strictEqual(wat.test_call_DeleteMetaFile(metafile), 0);
  });

  check('classic recording serializes and replays canonical pixels', () => {
    const recording = wat.test_call_CreateMetaFileA(0) >>> 0;
    assert(recording);
    const red = wat.test_call_CreateSolidBrush(0x000000ff) >>> 0;
    const rect = allocZero(16);
    wat.guest_write32(rect, 10);
    wat.guest_write32(rect + 4, 10);
    wat.guest_write32(rect + 8, 30);
    wat.guest_write32(rect + 12, 25);
    assert.strictEqual(wat.test_call_FillRect(recording, rect, red), 1);
    assert.strictEqual(wat.test_call_GetPixel(recording, 15, 15) >>> 0, 0x000000ff);
    const metafile = wat.test_call_CloseMetaFile(recording) >>> 0;
    assert(metafile);
    const required = wat.test_call_GetMetaFileBitsEx(metafile, 0, 0) >>> 0;
    assert.strictEqual(required, 640 * 480 * 4 + 120);
    const stream = allocZero(required);
    assert.strictEqual(wat.test_call_GetMetaFileBitsEx(metafile, required, stream), required);
    assert.strictEqual(wat.guest_read32(stream + 6) * 2, required,
      'METAHEADER size must cover the complete stream');
    assert.strictEqual(read16(stream + 50), 0x0f43,
      'recording must use the standard META_STRETCHDIB record');
    assert.strictEqual(wat.guest_read32(stream + 74), 40);
    assert.strictEqual(wat.guest_read32(stream + 78), 640);
    assert.strictEqual(wat.guest_read32(stream + 82) | 0, -480);

    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const bitmap = wat.test_call_CreateCompatibleBitmap(0, 640, 480) >>> 0;
    assert(bitmap);
    assert.notStrictEqual(wat.test_call_SelectObject(hdc, bitmap) | 0, -1);
    assert.strictEqual(wat.test_call_PlayMetaFile(hdc, metafile), 1);
    assert.strictEqual(wat.test_call_GetPixel(hdc, 15, 15) >>> 0, 0x000000ff,
      'replay must restore recorded geometry');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 0, 0) >>> 0, 0x00ffffff,
      'replay must preserve the recording surface background');
    assert.strictEqual(wat.test_call_DeleteMetaFile(metafile), 1);
  });

  check('enhanced metafile transport supports headers, copy, play, and deletion', () => {
    const source = makeEmf();
    const metafile = wat.test_call_SetEnhMetaFileBits(108, source) >>> 0;
    assert(metafile);
    assert.strictEqual(wat.test_call_GetObjectType(metafile), 13);
    assert.strictEqual(wat.test_call_GetEnhMetaFileBits(metafile, 0, 0), 108);
    const header = allocZero(88);
    assert.strictEqual(wat.test_call_GetEnhMetaFileHeader(metafile, 0, 0), 88);
    assert.strictEqual(wat.test_call_GetEnhMetaFileHeader(metafile, 88, header), 88);
    assert.strictEqual(wat.guest_read32(header + 40) >>> 0, 0x464d4520);
    assert.strictEqual(wat.test_call_GetEnhMetaFilePaletteEntries(metafile, 0, 0), 0);
    const copy = wat.test_call_CopyEnhMetaFileA(metafile, 0) >>> 0;
    assert(copy && copy !== metafile);
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const bitmap = wat.test_call_CreateCompatibleBitmap(0, 64, 64) >>> 0;
    assert.notStrictEqual(wat.test_call_SelectObject(hdc, bitmap) | 0, -1);
    const rect = allocZero(16);
    wat.guest_write32(rect + 8, 64);
    wat.guest_write32(rect + 12, 64);
    assert.strictEqual(wat.test_call_PlayEnhMetaFile(hdc, copy, rect), 1);
    assert.strictEqual(wat.test_call_DeleteEnhMetaFile(metafile), 1);
    assert.strictEqual(wat.test_call_GetEnhMetaFileBits(copy, 0, 0), 108,
      'copy must retain independent storage');
    assert.strictEqual(wat.test_call_DeleteEnhMetaFile(copy), 1);
  });

  check('WMF/EMF conversion preserves bitmap records and replay pixels', () => {
    const recording = wat.test_call_CreateMetaFileA(0) >>> 0;
    const red = wat.test_call_CreateSolidBrush(0x000000ff) >>> 0;
    const fill = allocZero(16);
    wat.guest_write32(fill, 10);
    wat.guest_write32(fill + 4, 10);
    wat.guest_write32(fill + 8, 30);
    wat.guest_write32(fill + 12, 25);
    assert.strictEqual(wat.test_call_FillRect(recording, fill, red), 1);
    const sourceWmf = wat.test_call_CloseMetaFile(recording) >>> 0;
    const sourceSize = wat.test_call_GetMetaFileBitsEx(sourceWmf, 0, 0) >>> 0;
    const sourceBytes = allocZero(sourceSize);
    assert.strictEqual(
      wat.test_call_GetMetaFileBitsEx(sourceWmf, sourceSize, sourceBytes), sourceSize);

    const emf = wat.test_call_SetWinMetaFileBits(sourceSize, sourceBytes, 0, 0) >>> 0;
    assert(emf, 'SetWinMetaFileBits must convert the bitmap record');
    assert.strictEqual(wat.test_call_GetEnhMetaFileBits(emf, 0, 0), 640 * 480 * 4 + 228);
    const header = allocZero(88);
    assert.strictEqual(wat.test_call_GetEnhMetaFileHeader(emf, 88, header), 88);
    assert.strictEqual(wat.guest_read32(header + 48), 640 * 480 * 4 + 228);

    const emfDc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const emfBitmap = wat.test_call_CreateCompatibleBitmap(0, 640, 480) >>> 0;
    assert.notStrictEqual(wat.test_call_SelectObject(emfDc, emfBitmap) | 0, -1);
    const target = allocZero(16);
    wat.guest_write32(target + 8, 640);
    wat.guest_write32(target + 12, 480);
    assert.strictEqual(wat.test_call_PlayEnhMetaFile(emfDc, emf, target), 1);
    assert.strictEqual(wat.test_call_GetPixel(emfDc, 15, 15) >>> 0, 0x000000ff,
      'EMR_STRETCHDIBITS replay must preserve recorded color');

    const required = wat.test_call_GetWinMetaFileBits(emf, 0, 0, 8, 0) >>> 0;
    assert.strictEqual(required, 640 * 480 * 4 + 120);
    const wmf = allocZero(required);
    assert.strictEqual(wat.test_call_GetWinMetaFileBits(emf, required, wmf, 8, 0), required);
    assert.strictEqual(read16(wmf + 2), 9);
    assert.strictEqual(read16(wmf + 50), 0x0f43);
    const converted = wat.test_call_SetMetaFileBitsEx(required, wmf) >>> 0;
    assert(converted);
    const wmfDc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const wmfBitmap = wat.test_call_CreateCompatibleBitmap(0, 640, 480) >>> 0;
    assert.notStrictEqual(wat.test_call_SelectObject(wmfDc, wmfBitmap) | 0, -1);
    assert.strictEqual(wat.test_call_PlayMetaFile(wmfDc, converted), 1);
    assert.strictEqual(wat.test_call_GetPixel(wmfDc, 15, 15) >>> 0, 0x000000ff,
      'EMF-to-WMF conversion must preserve replay pixels');
  });

  check('ICM profile sizing and ResetDCA follow public contracts', () => {
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const size = allocZero(4);
    wat.guest_write32(size, 4);
    assert.strictEqual(wat.test_call_GetICMProfileA(hdc, size, 0), 0);
    assert.strictEqual(wat.guest_read32(size), 29);
    const path = allocZero(29);
    assert.strictEqual(wat.test_call_GetICMProfileA(hdc, size, path), 1);
    assert.strictEqual(Buffer.from(readBytes(path, 28)).toString('latin1'),
      'sRGB Color Space Profile.icm');
    assert.strictEqual(wat.test_call_ResetDCA(hdc, 0) >>> 0, hdc);
    assert.strictEqual(wat.test_call_ResetDCA(0xdeadbeef, 0), 0);
  });

  console.log(`\n${passed}/${passed} checks passed`);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
