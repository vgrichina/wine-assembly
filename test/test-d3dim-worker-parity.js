#!/usr/bin/env node

'use strict';

// The optional D3DIM render Worker is a second instance of the production
// WAT module over the process SharedArrayBuffer. Its exported draw entry must
// be pixel-identical to the ordinary in-instance path; command transport and
// context creation alone cannot prove that the second instance resolves the
// copied device state, DirectDraw objects, and guest pointers correctly.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_worker_seed")
      (param $ddraw_vtbl i32) (param $surface_vtbl i32) (param $device_vtbl i32)
    (global.set $DX_VTBL_DDRAW (local.get $ddraw_vtbl))
    (global.set $DX_VTBL_DDSURF2 (local.get $surface_vtbl))
    (global.set $DX_VTBL_D3DDEV3 (local.get $device_vtbl)))

  (func (export "test_worker_create_surface")
      (param $desc i32) (param $out i32) (result i32)
    (local $ddraw i32)
    (local.set $ddraw
      (call $dx_create_com_obj (i32.const 1) (global.get $DX_VTBL_DDRAW)))
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDraw_CreateSurface
      (local.get $ddraw) (local.get $desc) (local.get $out) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_worker_create_device")
      (param $surface i32) (param $out i32) (result i32)
    (call $d3dim_create_device
      (i32.const 0) (local.get $surface) (local.get $out)
      (global.get $DX_VTBL_D3DDEV3))
    (global.get $eax))

  (func (export "test_worker_surface_dib") (param $surface i32) (result i32)
    (i32.load offset=20 (call $dx_from_this (local.get $surface))))

  (func (export "test_worker_surface_pitch") (param $surface i32) (result i32)
    (i32.load16_u offset=18 (call $dx_from_this (local.get $surface))))

  (func (export "test_worker_device_state") (param $device i32) (result i32)
    (call $d3ddev_state (local.get $device)))

  (func (export "test_worker_draw_normal")
      (param $device i32) (param $vertices i32) (param $count i32)
    (call $d3dim_draw_primitive
      (local.get $device) (i32.const 4) (i32.const 3)
      (local.get $vertices) (local.get $count)))
`;

function writeFloat(wat, address, value) {
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setFloat32(0, value, true);
  wat.guest_write32(address, view.getUint32(0, true));
}

function createSurface(wat, desc, out, width, height) {
  for (let i = 0; i < 128; i += 4) wat.guest_write32(desc + i, 0);
  wat.guest_write32(desc, 108);
  wat.guest_write32(desc + 4, 0x1007); // CAPS|HEIGHT|WIDTH|PIXELFORMAT
  wat.guest_write32(desc + 8, height);
  wat.guest_write32(desc + 12, width);
  wat.guest_write32(desc + 72, 32);
  wat.guest_write32(desc + 76, 0x40); // DDPF_RGB
  wat.guest_write32(desc + 84, 32);
  wat.guest_write32(desc + 88, 0x00ff0000);
  wat.guest_write32(desc + 92, 0x0000ff00);
  wat.guest_write32(desc + 96, 0x000000ff);
  wat.guest_write32(desc + 104, 0x40);
  assert.strictEqual(wat.test_worker_create_surface(desc, out) >>> 0, 0);
  return wat.guest_read32(out) >>> 0;
}

function writeVertex(wat, address, x, y, color) {
  writeFloat(wat, address, x);
  writeFloat(wat, address + 4, y);
  writeFloat(wat, address + 8, 0.5);
  writeFloat(wat, address + 12, 1.0);
  wat.guest_write32(address + 16, color >>> 0);
  wat.guest_write32(address + 20, 0);
  writeFloat(wat, address + 24, 0);
  writeFloat(wat, address + 28, 0);
}

(async () => {
  const normalHarness = await bootRenderHarness({ extraWat, fonts: 'none' });
  const normal = normalHarness.exports;
  const memory = normalHarness.memory;
  const desc = 0x410000;
  const out = 0x410100;
  const vertices = 0x411000;

  normal.test_worker_seed(0x51000000, 0x52000000, 0x53000000);
  const surface = createSurface(normal, desc, out, 16, 16);
  assert(surface, 'render target creation returned NULL');
  assert.strictEqual(normal.test_worker_create_device(surface, out + 4) >>> 0, 0);
  const device = normal.guest_read32(out + 4) >>> 0;
  const state = normal.test_worker_device_state(device) >>> 0;
  const dib = normal.test_worker_surface_dib(surface) >>> 0;
  const pitch = normal.test_worker_surface_pitch(surface) >>> 0;
  assert(device && state && dib && pitch >= 16 * 4,
    `incomplete D3DIM fixture device=${device} state=${state} dib=${dib} pitch=${pitch}`);

  writeVertex(normal, vertices, 2, 2, 0xffff0000);
  writeVertex(normal, vertices + 32, 13, 2, 0xff00ff00);
  writeVertex(normal, vertices + 64, 2, 13, 0xff0000ff);

  const target = new Uint8Array(memory.buffer, dib, pitch * 16);
  target.fill(0);
  normal.test_worker_draw_normal(device, vertices, 3);
  const expected = target.slice();
  const expectedLit = expected.reduce((count, byte) => count + (byte !== 0), 0);
  assert(expectedLit > 100,
    `ordinary D3DIM path produced only ${expectedLit} non-zero target bytes`);

  target.fill(0);
  const workerHarness = await bootRenderHarness({
    extraWat, fonts: 'none', memory,
  });
  assert.notStrictEqual(workerHarness.instance, normalHarness.instance,
    'worker parity must use a distinct WAT instance');
  const worker = workerHarness.exports;
  worker.d3dim_worker_init(normal.get_image_base() >>> 0);
  worker.d3dim_worker_draw(device, 4, 3, vertices, 3, state);

  const actual = target.slice();
  assert.deepStrictEqual(actual, expected,
    'second-instance d3dim_worker_draw pixels differ from the normal D3DIM path');
  assert(actual.some(byte => byte !== 0),
    'byte equality must not pass on two blank render targets');

  console.log(`PASS D3DIM second-instance worker parity (${expectedLit} lit bytes, ${pitch}B pitch)`);
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
