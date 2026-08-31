#!/usr/bin/env node
'use strict';

// Keep both authentic GDI32!SwapBuffers and Quake II ref_gl's dynamically
// resolved legacy wglSwapBuffers spelling connected to one generic present.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileSrcWasm } = require('./compile-src');
const apiTable = require('../src/api_table.json');
// $VIRTUAL_MAP_STATE and $VIRTUAL_MAP_TABLE, from the map declared in
// src/00-regions.wat.
const RegionMap = require('../lib/region-map.generated.js');

const ROOT = path.join(__dirname, '..');

async function main() {
  const extraWat = `
  (func (export "test_call_legacy_wglSwapBuffers") (param $stack i32) (result i32)
    (global.set $esp (local.get $stack))
    (call $handle_gpu_api
      (i32.const 55) (i32.const 1)
      (i32.const 0x1234) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  `;
  // Plain append: src fragments are self-balanced now, so there is no trailing
  // `)` to splice into — the old regex matched nothing and dropped extraWat.
  const wasm = compileSrcWasm((file, source) =>
    file === '13-exports.wat' ? `${source}\n${extraWat}\n` : source);
  const memory = new WebAssembly.Memory({
    initial: 8192, maximum: 8192, shared: true,
  });
  const imports = createHostImports({
    getMemory: () => memory.buffer,
    renderer: null,
    resourceJson: {},
  });
  imports.host.memory = memory;
  Object.assign(imports.host, {
    create_thread: () => 0, exit_thread: () => 0, terminate_thread: () => 0,
    create_event: () => 0, set_event: () => 0, reset_event: () => 0,
    wait_single: () => 0, wait_multiple: () => 0,
    com_create_instance: () => 0x80004002,
  });

  const presents = [];
  let gpuResult = 1;
  imports.host.gpu_gl_call = (opcode, stackWa, aux) => {
    presents.push({ opcode, stackWa, aux });
    return gpuResult;
  };
  const { instance } = await WebAssembly.instantiate(wasm, imports);

  const mapView = new DataView(memory.buffer);
  const mapTable = RegionMap.BASE.VIRTUAL_MAP_TABLE;
  mapView.setUint32(RegionMap.BASE.VIRTUAL_MAP_STATE, 1, true);
  mapView.setUint32(mapTable, 0x4e300000, true);
  mapView.setUint32(mapTable + 4, 0x00010000, true);
  mapView.setUint32(mapTable + 8, 0x10000000, true);
  assert.strictEqual(instance.exports.guest_to_wasm(0x4e306050) >>> 0, 0x10006050,
    'GPU host translator resolves a real Quake-style sparse vertex pointer');

  const legacy = apiTable.find(api => api.name === 'wglSwapBuffers');
  assert(legacy && legacy.nargs === 1 && legacy.convention === 'stdcall',
    'GetProcAddress name table exposes Quake II ref_gl legacy presentation');

  assert.strictEqual(instance.exports.test_call_SwapBuffers(0x1234), 1,
    'GDI32 SwapBuffers returns the successful GPU presentation result');
  assert.strictEqual(presents.length, 1,
    'GDI32 SwapBuffers presents exactly one frame through the GPU bridge');
  assert.strictEqual(presents[0].opcode, 55,
    'GDI32 SwapBuffers uses the GL frontend present operation');
  assert.strictEqual(presents[0].aux, 0,
    'presentation resolves the already-current GL context');

  const legacyStack = 0x074ff000;
  assert.strictEqual(instance.exports.test_call_legacy_wglSwapBuffers(legacyStack), 1,
    'legacy wglSwapBuffers returns the generic GPU presentation result');
  assert.strictEqual(instance.exports.get_esp() >>> 0, legacyStack + 8,
    'legacy wglSwapBuffers pops its one-argument stdcall frame');
  assert.strictEqual(presents.length, 2,
    'legacy wglSwapBuffers reaches the same present bridge exactly once');
  assert.strictEqual(presents[1].opcode, 55,
    'legacy wglSwapBuffers uses the backend-neutral present operation');

  gpuResult = 0;
  assert.strictEqual(instance.exports.test_call_SwapBuffers(0x1234), 0,
    'without a GL context, an unknown DC retains the legacy GDI failure');

  console.log('PASS GDI32/legacy WGL SwapBuffers share GPU present and preserve GDI fallback');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
