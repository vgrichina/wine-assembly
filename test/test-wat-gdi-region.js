#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const RECT_SCRATCH = 0x07E09000;

async function main() {
  const wasmBytes = await compileWat(file => fs.promises.readFile(path.join(SRC, file), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
  const base = createHostImports(ctx);
  base.host.memory = memory;
  base.host.create_thread = () => 0;
  base.host.exit_thread = () => 0;
  base.host.create_event = () => 0;
  base.host.set_event = () => 0;
  base.host.reset_event = () => 0;
  base.host.wait_single = () => 0;
  base.host.wait_multiple = () => 0;
  base.host.com_create_instance = () => 0x80004002;

  const { instance } = await WebAssembly.instantiate(wasmBytes, base);
  const wat = instance.exports;
  const dv = new DataView(memory.buffer);
  let passed = 0;

  function check(name, fn) {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  }

  function box(handle) {
    const complexity = wat.test_gdi_rgn_get_box(handle, RECT_SCRATCH);
    return {
      complexity,
      rect: [0, 4, 8, 12].map(offset => dv.getInt32(RECT_SCRATCH + offset, true)),
    };
  }

  function recordFor(handle) {
    const slot = (handle & 0xFF) - 1;
    return wat.get_gdi_region_table() + slot * 32;
  }

  check('allocates normalized generation-tagged rectangle handles in WAT', () => {
    const handle = wat.test_gdi_rgn_alloc_rect(8, 9, 2, 3);
    assert.strictEqual(handle & 0xFFFF0000, 0x00500000);
    assert.deepStrictEqual(box(handle), { complexity: 2, rect: [2, 3, 8, 9] });
    assert.strictEqual(dv.getUint32(recordFor(handle), true), 1);
  });

  check('public GDI handlers expose WAT regions as OBJ_REGION', () => {
    const handle = wat.test_call_CreateRectRgn(2, 4, 12, 14);
    assert.strictEqual(handle & 0xFFFF0000, 0x00500000);
    assert.strictEqual(wat.test_call_GetObjectType(handle), 8);
    assert.deepStrictEqual(box(handle), { complexity: 2, rect: [2, 4, 12, 14] });
  });

  check('WAT geometry remains authoritative over its JS presentation mirror', () => {
    const handle = wat.test_gdi_rgn_alloc_rect(1, 2, 7, 8);
    const record = recordFor(handle);
    const mirror = dv.getUint32(record + 24, true);
    assert(mirror >= 0x400001);
    assert.strictEqual(base.host.gdi_set_rect_rgn(mirror, 90, 91, 99, 100), 1);
    assert.deepStrictEqual(box(handle), { complexity: 2, rect: [1, 2, 7, 8] });

    assert.strictEqual(wat.test_gdi_rgn_set_rect(handle, -4, -3, 5, 6), 1);
    assert.deepStrictEqual(box(handle), { complexity: 2, rect: [-4, -3, 5, 6] });
    assert.deepStrictEqual(base.gdi._gdiObjects[mirror].bbox, { l: -4, t: -3, r: 5, b: 6 });
  });

  check('offset and rectangle intersection execute in WAT', () => {
    const a = wat.test_gdi_rgn_alloc_rect(0, 0, 8, 8);
    const b = wat.test_gdi_rgn_alloc_rect(3, 2, 10, 6);
    const dst = wat.test_gdi_rgn_alloc_rect(0, 0, 0, 0);
    assert.strictEqual(wat.test_gdi_rgn_combine(dst, a, b, 1), 2); // RGN_AND
    assert.deepStrictEqual(box(dst), { complexity: 2, rect: [3, 2, 8, 6] });
    assert.strictEqual(wat.test_gdi_rgn_offset(dst, -2, 5), 2);
    assert.deepStrictEqual(box(dst), { complexity: 2, rect: [1, 7, 6, 11] });
  });

  check('complex combinations are explicitly tagged pending WAT band algebra', () => {
    const a = wat.test_gdi_rgn_alloc_rect(0, 0, 8, 8);
    const b = wat.test_gdi_rgn_alloc_rect(3, 2, 10, 6);
    const dst = wat.test_gdi_rgn_alloc_rect(0, 0, 0, 0);
    assert.strictEqual(wat.test_gdi_rgn_combine(dst, a, b, 4), 3); // RGN_DIFF
    assert.deepStrictEqual(box(dst), { complexity: 3, rect: [0, 0, 8, 8] });
    assert.strictEqual(dv.getUint32(recordFor(dst), true), 2);
  });

  check('delete invalidates stale generations before reusing a slot', () => {
    const oldHandle = wat.test_gdi_rgn_alloc_rect(1, 1, 2, 2);
    assert.strictEqual(wat.test_gdi_rgn_delete(oldHandle), 1);
    const newHandle = wat.test_gdi_rgn_alloc_rect(4, 4, 9, 9);
    assert.strictEqual(newHandle & 0xFF, oldHandle & 0xFF);
    assert.notStrictEqual(newHandle, oldHandle);
    assert.strictEqual(wat.test_gdi_rgn_get_box(oldHandle, RECT_SCRATCH), 0);
    assert.deepStrictEqual(box(newHandle), { complexity: 2, rect: [4, 4, 9, 9] });
  });

  console.log(`\n${passed}/${passed} checks passed`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
