#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const extraWat = String.raw`
  (func (export "test_surface3_create") (result i32)
    (call $dx_create_com_obj (i32.const 2) (global.get $DX_VTBL_DDSURF2)))
  (func (export "test_surface3_query") (param $surface i32) (param $iid i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDrawSurface_QueryInterface
      (local.get $surface) (local.get $iid) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_surface3_set_desc") (param $surface i32) (param $desc i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDrawSurface3_SetSurfaceDesc
      (local.get $surface) (local.get $desc) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_surface3_pixels") (param $surface i32) (result i32)
    (i32.load offset=20 (call $dx_from_this (local.get $surface))))
  (func (export "test_surface3_pitch") (param $surface i32) (result i32)
    (i32.load16_u offset=18 (call $dx_from_this (local.get $surface))))
  (func (export "test_surface3_vtbl") (result i32)
    (global.get $DX_VTBL_DDSURF3))
`;

async function main() {
  const wasm = await compileWat(async file => {
    const source = await fs.promises.readFile(path.join(ROOT, 'src', file), 'utf8');
    if (file !== '13-exports.wat') return source;
    return source.replace(/\n\)\s*$/, `\n${extraWat}\n)\n`);
  });
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const imports = createHostImports({ getMemory: () => memory.buffer, renderer: null, resourceJson: {} });
  Object.assign(imports.host, {
    memory,
    create_thread: () => 0,
    exit_thread: () => 0,
    create_event: () => 0,
    set_event: () => 0,
    reset_event: () => 0,
    wait_single: () => 0,
    wait_multiple: () => 0,
    com_create_instance: () => 0x80004002,
  });

  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const e = instance.exports;
  const exe = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, e.get_staging());
  assert(e.load_pe(exe.length), 'fixture PE should initialize thunk memory');
  e.init_dx_com_thunks();

  const surface = e.test_surface3_create() >>> 0;
  const iid = e.guest_alloc(16) >>> 0;
  const out = e.guest_alloc(4) >>> 0;
  const desc = e.guest_alloc(108) >>> 0;
  const pixels = e.guest_alloc(64000) >>> 0;
  assert(surface && iid && out && desc && pixels, 'test allocations should succeed');

  e.guest_write32(iid, 0xDA044E00);
  e.guest_write32(iid + 4, 0x11D069B2);
  e.guest_write32(iid + 8, 0xAA00D5A1);
  e.guest_write32(iid + 12, 0xBBDFB800);
  assert.strictEqual(e.test_surface3_query(surface, iid, out) >>> 0, 0);
  const surface3 = e.guest_read32(out) >>> 0;
  assert(surface3, 'Surface3 QueryInterface should publish a wrapper');
  assert.strictEqual(e.guest_read32(surface3) >>> 0, e.test_surface3_vtbl() >>> 0,
    'Surface3 QueryInterface should use the 40-slot Surface3 vtable');
  assert(e.guest_read32((e.test_surface3_vtbl() + 39 * 4) >>> 0) >>> 0,
    'Surface3 vtable slot 39 should contain a callable thunk');

  e.guest_write32(desc, 108);
  e.guest_write32(desc + 4, 0x808); // DDSD_PITCH | DDSD_LPSURFACE
  e.guest_write32(desc + 16, 320);
  e.guest_write32(desc + 36, pixels);
  assert.strictEqual(e.test_surface3_set_desc(surface3, desc) >>> 0, 0);
  assert.strictEqual(e.test_surface3_pitch(surface3) >>> 0, 320);
  const expectedWa = (pixels - (e.get_image_base() >>> 0) + (e.get_guest_base() >>> 0)) >>> 0;
  assert.strictEqual(e.test_surface3_pixels(surface3) >>> 0, expectedWa,
    'SetSurfaceDesc should attach the caller-owned framebuffer');

  console.log('PASS  DirectDraw Surface3 exposes slot 39 and attaches SDL pixel memory');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
