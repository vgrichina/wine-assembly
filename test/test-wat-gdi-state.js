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

  const pen = 0x301001;
  const brush = 0x301002;
  assert.strictEqual(wat.test_gdi_object_adopt(pen, 1, 2, 3, 0x123456, 0), pen);
  assert.strictEqual(wat.test_gdi_object_adopt(brush, 2, 0, 0, 0xABCDEF, 0), brush);
  assert.strictEqual(wat.test_gdi_object_type(pen), 1);
  assert.strictEqual(wat.test_gdi_object_type(brush), 2);
  assert.strictEqual(wat.test_gdi_object_type(0x30017), 1);
  assert.strictEqual(wat.test_gdi_object_type(0x30010), 2);

  const hdcA = 0x300001;
  const hdcB = 0x300002;
  assert.strictEqual(wat.test_gdi_dc_get_field(hdcA, 4, 0x30017), 0x30017);
  assert.strictEqual(wat.test_gdi_dc_select_owned_object(hdcA, pen), 0x30017);
  assert.strictEqual(wat.test_gdi_dc_select_owned_object(hdcA, 0x30018), pen);
  assert.strictEqual(wat.test_gdi_dc_select_owned_object(hdcA, brush), 0x30010);
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

  assert.strictEqual(wat.test_gdi_object_delete(pen), 1);
  assert.strictEqual(wat.test_gdi_object_type(pen), 0);
  assert.strictEqual(wat.test_gdi_object_delete(0x30017), 1,
    'stock objects remain valid process-owned handles');
  assert.strictEqual(wat.test_gdi_object_type(0x30017), 1);

  console.log('PASS  WAT owns pen/brush records and independent per-DC state');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
