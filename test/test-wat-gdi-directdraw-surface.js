#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const DX_OBJECTS = 0x07FF0000;
const DX_ENTRY_SIZE = 32;

(async () => {
  const { exports: wat, memory, gdi } = await bootRenderHarness();
  const dv = new DataView(memory.buffer);
  const bytes = new Uint8Array(memory.buffer);
  const slot = 7;
  const hdc = 0x200000 + slot;
  const entry = DX_OBJECTS + slot * DX_ENTRY_SIZE;
  const width = 12;
  const height = 8;
  const stride = width * 4;
  const bitsGa = wat.guest_alloc(stride * height) >>> 0;
  const bitsWa = 0x12000 + (bitsGa - (wat.get_image_base() >>> 0));
  const desc = 0x07EF1000;

  bytes.fill(0xFF, bitsWa, bitsWa + stride * height);
  dv.setUint32(entry, 2, true); // DDSurface
  dv.setUint16(entry + 12, width, true);
  dv.setUint16(entry + 14, height, true);
  dv.setUint16(entry + 16, 32, true);
  dv.setUint16(entry + 18, stride, true);
  dv.setUint32(entry + 20, bitsWa, true);

  assert.strictEqual(wat.test_gdi_dx_dc_bind(hdc), 1);
  assert.strictEqual(wat.test_gdi_surface_descriptor(hdc, desc), 1);
  assert.deepStrictEqual([
    dv.getUint32(desc, true), dv.getInt32(desc + 4, true),
    dv.getInt32(desc + 8, true), dv.getInt32(desc + 12, true),
    dv.getInt32(desc + 16, true), dv.getUint32(desc + 68, true),
  ], [bitsWa, width, height, stride, 32, hdc]);

  assert.strictEqual(wat.test_call_SetPixel(hdc, 1, 1, 0x000000FF), 0x000000FF);
  assert.deepStrictEqual([...bytes.subarray(bitsWa + stride + 4, bitsWa + stride + 7)],
    [0, 0, 255], 'SetPixel must write the native DirectDraw DIB');
  const presentation = gdi.surfacePresentations.get(hdc);
  assert(presentation, 'GetDC binding must create a presentation-only Canvas cache');
  assert.deepStrictEqual(
    [...presentation.canvas.getContext('2d').getImageData(1, 1, 1, 1).data],
    [255, 0, 0, 255], 'WAT writes must upload to the presentation cache');

  wat.test_gdi_dc_set_field(hdc, 20, 0x00000000, 0); // black text
  wat.test_gdi_dc_set_field(hdc, 28, 1, 2); // transparent background
  const text = wat.guest_alloc(2) >>> 0;
  wat.guest_write16(text, 0x58); // X\0
  assert.strictEqual(wat.test_call_TextOutA(hdc, 2, 1, text, 1), 1);
  let textChangedNativePixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 2; x < width; x++) {
      const p = bitsWa + y * stride + x * 4;
      if (bytes[p] !== 0xFF || bytes[p + 1] !== 0xFF || bytes[p + 2] !== 0xFF) {
        textChangedNativePixels++;
      }
    }
  }
  assert(textChangedNativePixels > 0,
    'Canvas text rasterization must synchronously copy its dirty pixels into the native DIB');

  const nativeBeforePoison = bytes.slice(bitsWa, bitsWa + stride * height);
  const canvasContext = presentation.canvas.getContext('2d');
  canvasContext.fillStyle = '#ff00ff';
  canvasContext.fillRect(0, 0, width, height);
  wat.test_gdi_dx_dc_release(hdc);
  assert.deepStrictEqual(bytes.slice(bitsWa, bitsWa + stride * height), nativeBeforePoison,
    'ReleaseDC must never copy stale or corrupted Canvas pixels into WAT memory');
  assert(!gdi.surfacePresentations.has(hdc), 'ReleaseDC must delete the transient presentation');

  const indexedSlot = 8;
  const indexedHdc = 0x200000 + indexedSlot;
  const indexedEntry = DX_OBJECTS + indexedSlot * DX_ENTRY_SIZE;
  const indexedStride = 12;
  const indexedBitsGa = wat.guest_alloc(indexedStride * height) >>> 0;
  const indexedBitsWa = 0x12000 + (indexedBitsGa - (wat.get_image_base() >>> 0));
  const paletteGa = wat.guest_alloc(1024) >>> 0;
  const paletteWa = 0x12000 + (paletteGa - (wat.get_image_base() >>> 0));
  bytes.fill(0, paletteWa, paletteWa + 1024);
  bytes.set([0, 0, 0, 0], paletteWa); // black PALETTEENTRY
  bytes.set([255, 255, 255, 0], paletteWa + 4); // white
  bytes.set([255, 0, 0, 0], paletteWa + 8); // red
  bytes.fill(1, indexedBitsWa, indexedBitsWa + indexedStride * height);
  wat.test_dx_set_primary_palette_wa(paletteWa);
  dv.setUint32(indexedEntry, 2, true);
  dv.setUint16(indexedEntry + 12, width, true);
  dv.setUint16(indexedEntry + 14, height, true);
  dv.setUint16(indexedEntry + 16, 8, true);
  dv.setUint16(indexedEntry + 18, indexedStride, true);
  dv.setUint32(indexedEntry + 20, indexedBitsWa, true);
  assert.strictEqual(wat.test_gdi_dx_dc_bind(indexedHdc), 1);
  assert.strictEqual(wat.test_call_SetPixel(indexedHdc, 1, 1, 0x000000FF), 0x000000FF);
  assert.strictEqual(bytes[indexedBitsWa + indexedStride + 1], 2,
    '8-bit SetPixel must choose the matching live DirectDraw palette index');
  const indexedPresentation = gdi.surfacePresentations.get(indexedHdc);
  assert.deepStrictEqual(
    [...indexedPresentation.canvas.getContext('2d').getImageData(1, 1, 1, 1).data],
    [255, 0, 0, 255], 'indexed WAT pixels must present through PALETTEENTRY colors');
  wat.test_gdi_dc_set_field(indexedHdc, 20, 0x00000000, 0);
  wat.test_gdi_dc_set_field(indexedHdc, 28, 1, 2);
  assert.strictEqual(wat.test_call_TextOutA(indexedHdc, 2, 1, text, 1), 1);
  assert(bytes.subarray(indexedBitsWa, indexedBitsWa + indexedStride * height).includes(0),
    'Canvas text must quantize its pixels back into the canonical indexed DIB');
  wat.test_gdi_dx_dc_release(indexedHdc);

  console.log('DirectDraw canonical GDI surface: PASS');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
