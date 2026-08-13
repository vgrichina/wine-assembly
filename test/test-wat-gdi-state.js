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
