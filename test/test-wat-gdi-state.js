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

  const pen = wat.test_call_CreatePen(2, 3, 0x123456) >>> 0;
  const brush = wat.test_call_CreateSolidBrush(0xABCDEF) >>> 0;
  assert(pen && brush, 'WAT handlers should allocate dynamic objects');
  assert.strictEqual(wat.test_gdi_object_type(pen), 1);
  assert.strictEqual(wat.test_gdi_object_type(brush), 2);
  assert.strictEqual(wat.test_gdi_object_type(0x30007), 3);
  assert.strictEqual(wat.test_gdi_object_type(0x30001), 3);
  assert.strictEqual(wat.test_gdi_object_type(0x30017), 1);
  assert.strictEqual(wat.test_gdi_object_type(0x30021), 4);
  assert.strictEqual(wat.test_gdi_object_type(0x30010), 2);

  const hatched = wat.test_call_CreateHatchBrush(4, 0x000000FF) >>> 0;
  assert(hatched, 'CreateHatchBrush should allocate a WAT brush');
  assert.strictEqual(wat.test_gdi_object_style(hatched), 2);
  assert.strictEqual(wat.test_gdi_object_param(hatched), 4,
    'brush record width slot preserves the hatch selector');
  assert.strictEqual(wat.test_gdi_object_color(hatched), 0x000000FF);
  assert.strictEqual(wat.test_call_CreateHatchBrush(6, 0), 0,
    'invalid hatch selectors must be rejected');

  const logbrush = wat.guest_alloc(12) >>> 0;
  wat.guest_write32(logbrush, 2);
  wat.guest_write32(logbrush + 4, 0x0000FF00);
  wat.guest_write32(logbrush + 8, 1);
  const indirectHatch = wat.test_call_CreateBrushIndirect(logbrush) >>> 0;
  assert(indirectHatch);
  assert.strictEqual(wat.test_gdi_object_style(indirectHatch), 2);
  assert.strictEqual(wat.test_gdi_object_param(indirectHatch), 1);

  const extPen = wat.test_call_ExtCreatePen(0x00010200, 5, logbrush, 0, 0) >>> 0;
  assert(extPen, 'ExtCreatePen should preserve geometric style and LOGBRUSH color');
  assert.strictEqual(wat.test_gdi_object_style(extPen), 0);
  assert.strictEqual(wat.test_gdi_object_param(extPen), 5);
  assert.strictEqual(wat.test_gdi_object_color(extPen), 0x0000FF00);

  const objectStruct = wat.guest_alloc(16) >>> 0;
  assert.strictEqual(wat.test_call_GetObjectA(pen, 16, objectStruct), 16);
  assert.strictEqual(wat.guest_read32(objectStruct), 2);
  assert.strictEqual(wat.guest_read32(objectStruct + 4), 3);
  assert.strictEqual(wat.guest_read32(objectStruct + 8), 0);
  assert.strictEqual(wat.guest_read32(objectStruct + 12), 0x123456);
  assert.strictEqual(wat.test_call_GetObjectA(hatched, 12, objectStruct), 12);
  assert.strictEqual(wat.guest_read32(objectStruct), 2);
  assert.strictEqual(wat.guest_read32(objectStruct + 4), 0x000000FF);
  assert.strictEqual(wat.guest_read32(objectStruct + 8), 4);

  const wideFace = wat.guest_alloc(32) >>> 0;
  'Arial'.split('').forEach((ch, i) => wat.guest_write16(wideFace + i * 2, ch.charCodeAt(0)));
  wat.guest_write16(wideFace + 10, 0);
  const wideFont = wat.test_call_CreateFontW(-17, 700, 1, wideFace) >>> 0;
  assert(wideFont, 'CreateFontW should allocate through the text-only host boundary');
  assert.strictEqual(wat.test_gdi_object_type(wideFont), 4);
  const wideLogfont = wat.guest_alloc(92) >>> 0;
  assert.strictEqual(wat.test_call_GetObjectW(wideFont, 92, wideLogfont), 92);
  assert.strictEqual(wat.guest_read32(wideLogfont), -17);
  assert.strictEqual(wat.guest_read32(wideLogfont + 16), 700);
  const wideDc = wat.test_call_CreateDCW() >>> 0;
  assert(wideDc, 'CreateDCW should allocate a usable screen/printer DC');
  assert.strictEqual(wat.test_call_GetObjectType(wideDc), 3);

  const hdcA = wat.test_call_CreateCompatibleDC(0) >>> 0;
  const hdcB = wat.test_call_CreateCompatibleDC(0) >>> 0;
  assert.strictEqual(wat.test_gdi_dc_get_field(hdcA, 4, 0x30017), 0x30017);
  assert.strictEqual(wat.test_call_SelectObject(hdcA, pen), 0x30017);
  assert.strictEqual(wat.test_call_SelectObject(hdcA, 0x30018), pen);
  assert.strictEqual(wat.test_call_SelectObject(hdcA, brush), 0x30010);
  assert.strictEqual(wat.test_gdi_dc_get_field(hdcA, 4, 0), 0x30018);
  assert.strictEqual(wat.test_gdi_dc_get_field(hdcA, 8, 0), brush);
  assert.strictEqual(wat.test_gdi_dc_get_field(hdcB, 4, 0x30017), 0x30017,
    'DC selections must not leak between handles');

  assert.strictEqual(wat.test_gdi_dc_set_field(hdcA, 12, -17, 0), 0);
  assert.strictEqual(wat.test_gdi_dc_set_field(hdcA, 16, 29, 0), 0);
  assert.strictEqual(wat.test_gdi_dc_get_field(hdcA, 12, 0), -17);
  assert.strictEqual(wat.test_gdi_dc_get_field(hdcA, 16, 0), 29);
  assert.strictEqual(wat.test_gdi_dc_set_rop2(hdcA, 7), 13);
  assert.strictEqual(wat.test_gdi_dc_get_rop2(hdcA), 7);

  const clipRect = 0x07EF12D0;
  const memoryView = new DataView(memory.buffer);
  const readClipRect = () => [0, 4, 8, 12].map(offset =>
    memoryView.getInt32(clipRect + offset, true));
  const savedClip = wat.test_call_CreateRectRgn(1, 2, 11, 12) >>> 0;
  assert(savedClip);
  assert.strictEqual(wat.test_gdi_dc_clip_select(hdcA, savedClip), 2);
  assert.strictEqual(wat.test_gdi_dc_aux_set(hdcA, 20, 3, 0), 0);
  assert.strictEqual(wat.test_gdi_dc_aux_set(hdcA, 24, 9, 0), 0);
  assert.strictEqual(wat.test_gdi_dc_aux_set(hdcA, 28, 2, 0), 0);
  const savedLevel1 = wat.test_call_SaveDC(hdcA);
  assert.strictEqual(savedLevel1, 1);

  assert.strictEqual(wat.test_call_SelectObject(hdcA, 0x30017), 0x30018);
  assert.strictEqual(wat.test_gdi_dc_set_field(hdcA, 20, 0x00112233, 0), 0);
  assert.strictEqual(wat.test_gdi_dc_aux_set(hdcA, 20, 7, 0), 3);
  assert.strictEqual(wat.test_gdi_dc_aux_set(hdcA, 24, 15, 0), 9);
  assert.strictEqual(wat.test_gdi_dc_aux_set(hdcA, 28, 4, 0), 2);
  assert.strictEqual(wat.test_gdi_dc_clip_offset(hdcA, 20, 30), 2);
  const savedLevel2 = wat.test_call_SaveDC(hdcA);
  assert.strictEqual(savedLevel2, 2);

  assert.strictEqual(wat.test_gdi_dc_set_field(hdcA, 20, 0x00ABCDEF, 0), 0x00112233);
  assert.strictEqual(wat.test_gdi_dc_aux_set(hdcA, 20, 99, 0), 7);
  assert.strictEqual(wat.test_gdi_dc_clip_clear(hdcA), 1);
  assert.strictEqual(wat.test_call_RestoreDC(hdcA, -1), 1,
    'relative restore should select the most recent snapshot');
  assert.strictEqual(wat.test_gdi_dc_get_field(hdcA, 4, 0), 0x30017);
  assert.strictEqual(wat.test_gdi_dc_get_field(hdcA, 20, 0), 0x00112233);
  assert.strictEqual(wat.test_gdi_dc_aux_get(hdcA, 20, 0), 7);
  assert.strictEqual(wat.test_gdi_dc_aux_get(hdcA, 24, 0), 15);
  assert.strictEqual(wat.test_gdi_dc_aux_get(hdcA, 28, 0), 4);
  assert.strictEqual(wat.test_gdi_dc_clip_get_box(hdcA, clipRect), 2);
  assert.deepStrictEqual(readClipRect(), [21, 32, 31, 42]);

  assert.strictEqual(wat.test_call_RestoreDC(hdcA, savedLevel1), 1,
    'absolute restore should discard the requested snapshot and newer states');
  assert.strictEqual(wat.test_gdi_dc_get_field(hdcA, 4, 0), 0x30018);
  assert.strictEqual(wat.test_gdi_dc_get_field(hdcA, 20, 0), 0);
  assert.strictEqual(wat.test_gdi_dc_aux_get(hdcA, 20, 0), 3);
  assert.strictEqual(wat.test_gdi_dc_aux_get(hdcA, 24, 0), 9);
  assert.strictEqual(wat.test_gdi_dc_aux_get(hdcA, 28, 0), 2);
  assert.strictEqual(wat.test_gdi_dc_clip_get_box(hdcA, clipRect), 2);
  assert.deepStrictEqual(readClipRect(), [1, 2, 11, 12]);
  assert.strictEqual(wat.test_call_RestoreDC(hdcA, savedLevel1), 0,
    'restored snapshots must no longer remain on the stack');
  assert.strictEqual(wat.test_call_DeleteObject(savedClip), 1);

  assert.strictEqual(wat.test_gdi_map_coordinate(10, 0, 10, 5, 20), 25);
  assert.strictEqual(wat.test_gdi_map_coordinate(-3, -5, 4, 7, 6), 10,
    'mapping must preserve signed coordinates and round consistently');
  assert.strictEqual(wat.test_gdi_map_coordinate(3, 1, -4, 20, 8), 16,
    'negative extents must invert an axis');

  const bitmap = wat.test_call_CreateCompatibleBitmap(hdcA, 17, 9) >>> 0;
  assert(bitmap, 'WAT should allocate compatible bitmap storage');
  assert.strictEqual(wat.test_gdi_object_type(bitmap), 3);
  assert(base.gdi.surfacePresentations.has(bitmap), 'JS should own only its derived presentation');
  assert.strictEqual(wat.test_call_SelectObject(hdcA, bitmap), 0x30007);
  assert.strictEqual(wat.test_call_SelectObject(hdcA, 0x30007), bitmap,
    'restoring the stock bitmap must return the selected DDB');
  assert.strictEqual(wat.test_call_SelectObject(hdcA, bitmap), 0x30007,
    'a DDB must remain selectable after restoring the stock bitmap');
  assert.strictEqual(wat.test_call_SelectObject(hdcA, 0x30021), 0x3001D);
  assert.strictEqual(wat.test_call_GetCurrentObject(hdcA, 6), 0x30021);
  const logfont = wat.guest_alloc(92) >>> 0;
  assert.strictEqual(wat.test_call_GetObjectA(0x30021, 60, logfont), 60);
  assert.strictEqual(wat.guest_read32(logfont), 11);
  assert.strictEqual(wat.guest_read32(logfont + 16), 400);
  assert.strictEqual(wat.test_call_GetObjectW(0x30021, 92, logfont), 92);
  assert.strictEqual(wat.guest_read32(logfont), 11);
  const bitmapStruct = wat.guest_alloc(24) >>> 0;
  assert.strictEqual(wat.test_call_GetObjectA(bitmap, 24, bitmapStruct), 24);
  assert.strictEqual(wat.guest_read32(bitmapStruct + 4), 17);
  assert.strictEqual(wat.guest_read32(bitmapStruct + 8), 9);
  assert.strictEqual(wat.guest_read32(bitmapStruct + 12), 68);
  assert.strictEqual(wat.guest_read32(bitmapStruct + 16), 1 | (32 << 16));
  assert.strictEqual(wat.guest_read32(bitmapStruct + 20), 0,
    'DDB-compatible bitmap storage must remain private through GetObject');

  const text = wat.guest_alloc(2) >>> 0;
  wat.guest_write16(text, 0x58); // "X\0"
  assert.strictEqual(wat.test_call_TextOutA(hdcA, 1, 1, text, 1), 1);
  const descriptor = 0x07EF1000;
  assert.strictEqual(wat.test_gdi_surface_descriptor(hdcA, descriptor), 1);
  const bits = new Uint8Array(memory.buffer);
  const bitsWa = new DataView(memory.buffer).getUint32(descriptor, true);
  const byteLength = new DataView(memory.buffer).getUint32(descriptor + 12, true) * 9;
  assert(bits.subarray(bitsWa, bitsWa + byteLength).some(value => value !== 0),
    'Canvas text must synchronize rendered pixels into canonical WAT storage');

  assert.strictEqual(wat.test_call_DeleteObject(pen), 1);
  assert.strictEqual(wat.test_gdi_object_type(pen), 0);
  assert.strictEqual(wat.test_gdi_object_delete(0x30017), 1,
    'stock objects remain valid process-owned handles');
  assert.strictEqual(wat.test_gdi_object_type(0x30017), 1);
  assert.strictEqual(wat.test_call_DeleteObject(brush), 1);
  assert.strictEqual(wat.test_call_DeleteObject(hatched), 1);
  assert.strictEqual(wat.test_call_DeleteObject(indirectHatch), 1);
  assert.strictEqual(wat.test_call_DeleteObject(extPen), 1);
  assert.strictEqual(wat.test_call_DeleteObject(wideFont), 1);
  assert.strictEqual(wat.test_call_DeleteObject(bitmap), 1);
  assert(!base.gdi.surfacePresentations.has(bitmap), 'bitmap deletion should discard its Canvas cache');
  assert.strictEqual(wat.test_call_DeleteDC(hdcA), 1);
  assert.strictEqual(wat.test_call_DeleteDC(hdcB), 1);

  console.log('PASS  WAT owns pen/brush records and independent per-DC state');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
