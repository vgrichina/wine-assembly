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
  const imports = createHostImports({ getMemory: () => memory.buffer, renderer: null, resourceJson: {} });
  imports.host.memory = memory;
  imports.host.create_thread = () => 0;
  imports.host.exit_thread = () => 0;
  imports.host.create_event = () => 0;
  imports.host.set_event = () => 0;
  imports.host.reset_event = () => 0;
  imports.host.wait_single = () => 0;
  imports.host.wait_multiple = () => 0;
  imports.host.com_create_instance = () => 0x80004002;

  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const wat = instance.exports;
  const dv = new DataView(memory.buffer);
  const rectPtr = 0x07EF12D0;
  let passed = 0;

  function check(name, fn) {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  }

  function box(hdc) {
    const complexity = wat.test_gdi_dc_clip_get_box(hdc, rectPtr);
    return {
      complexity,
      rect: [0, 4, 8, 12].map(offset => dv.getInt32(rectPtr + offset, true)),
    };
  }

  function selectBase(hdc) {
    const base = wat.test_call_CreateRectRgn(0, 0, 10, 10) >>> 0;
    assert(base);
    assert.strictEqual(wat.test_gdi_dc_clip_select(hdc, base), 2);
    assert.strictEqual(wat.test_call_DeleteObject(base), 1);
  }

  const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
  assert(hdc);
  const source = wat.test_call_CreateRectRgn(5, 5, 15, 15) >>> 0;
  assert(source);

  check('SelectClipPath rejects DCs without a closed current path', () => {
    assert.strictEqual(wat.test_call_SelectClipPath(hdc, 5), 0);
    assert.strictEqual(wat.test_gdi_dc_path_set_region(0xDEADBEEF, source), 0);
  });

  check('closed path state owns a copy of its source region', () => {
    assert.strictEqual(wat.test_gdi_dc_get_field(hdc, 4, 0), 0x30017);
    assert.strictEqual(wat.test_gdi_rgn_get_box(source, rectPtr), 2);
    assert.strictEqual(wat.test_gdi_dc_path_set_region(hdc, source), 1);
    assert.strictEqual(wat.test_call_DeleteObject(source), 1);
    assert.strictEqual(wat.test_call_SelectClipPath(hdc, 5), 1);
    assert.deepStrictEqual(box(hdc), { complexity: 2, rect: [5, 5, 15, 15] });
  });

  check('RGN_AND intersects the current clip with the closed path', () => {
    selectBase(hdc);
    assert.strictEqual(wat.test_call_SelectClipPath(hdc, 1), 1);
    assert.deepStrictEqual(box(hdc), { complexity: 2, rect: [5, 5, 10, 10] });
  });

  check('RGN_OR unions the current clip and closed path', () => {
    selectBase(hdc);
    assert.strictEqual(wat.test_call_SelectClipPath(hdc, 2), 1);
    assert.deepStrictEqual(box(hdc), { complexity: 3, rect: [0, 0, 15, 15] });
    assert.strictEqual(wat.test_gdi_dc_clip_point_visible(hdc, 12, 12), 1);
  });

  check('RGN_XOR excludes overlap while preserving both outer areas', () => {
    selectBase(hdc);
    assert.strictEqual(wat.test_call_SelectClipPath(hdc, 3), 1);
    assert.deepStrictEqual(box(hdc), { complexity: 3, rect: [0, 0, 15, 15] });
    assert.strictEqual(wat.test_gdi_dc_clip_point_visible(hdc, 2, 2), 1);
    assert.strictEqual(wat.test_gdi_dc_clip_point_visible(hdc, 7, 7), 0);
    assert.strictEqual(wat.test_gdi_dc_clip_point_visible(hdc, 12, 12), 1);
  });

  check('RGN_DIFF removes the closed path from the current clip', () => {
    selectBase(hdc);
    assert.strictEqual(wat.test_call_SelectClipPath(hdc, 4), 1);
    assert.deepStrictEqual(box(hdc), { complexity: 3, rect: [0, 0, 10, 10] });
    assert.strictEqual(wat.test_gdi_dc_clip_point_visible(hdc, 2, 2), 1);
    assert.strictEqual(wat.test_gdi_dc_clip_point_visible(hdc, 7, 7), 0);
  });

  check('invalid modes are atomic and DC destruction releases path state', () => {
    const before = box(hdc);
    assert.strictEqual(wat.test_call_SelectClipPath(hdc, 0), 0);
    assert.strictEqual(wat.test_call_SelectClipPath(hdc, 6), 0);
    assert.deepStrictEqual(box(hdc), before);
    assert.strictEqual(wat.test_call_DeleteDC(hdc), 1);
    assert.strictEqual(wat.test_call_SelectClipPath(hdc, 5), 0);
  });

  console.log(`\n${passed}/${passed} SelectClipPath checks passed.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
