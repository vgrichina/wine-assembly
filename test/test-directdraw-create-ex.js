#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_ddrawex_seed") (param $base_vtbl i32) (param $extended_vtbl i32)
    (global.set $DX_VTBL_DDRAW (local.get $base_vtbl))
    (global.set $DX_VTBL_DDRAW2 (local.get $extended_vtbl)))
  (func (export "test_ddrawex_call")
      (param $out i32) (param $iid i32) (param $outer i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_DirectDrawCreateEx
      (i32.const 0) (local.get $out) (local.get $iid) (local.get $outer)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_ddrawex_esp") (result i32) (global.get $esp))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const out = 0x410000;
  const iid = 0x410020;
  const baseVtable = 0x51000000;
  const extendedVtable = 0x52000000;
  wat.test_ddrawex_seed(baseVtable, extendedVtable);

  // IID_IDirectDraw7 = 15E65EC0-3B9C-11D2-B92F-00609797EA5B.
  wat.guest_write32(iid, 0x15E65EC0);
  wat.guest_write32(iid + 4, 0x11D23B9C);
  wat.guest_write32(iid + 8, 0x60002FB9);
  wat.guest_write32(iid + 12, 0x5BEA9797);
  assert.strictEqual(wat.test_ddrawex_call(out, iid, 0) >>> 0, 0,
    'IDirectDraw7 creation should succeed');
  const object = wat.guest_read32(out) >>> 0;
  assert(object, 'DirectDrawCreateEx should publish an interface pointer');
  assert.strictEqual(wat.guest_read32(object) >>> 0, extendedVtable,
    'IDirectDraw7 should use the extended DirectDraw vtable');
  assert.strictEqual(wat.test_ddrawex_esp() >>> 0, 0x30014,
    'DirectDrawCreateEx pops its return address and four stdcall arguments');

  wat.guest_write32(out, 0xdeadbeef);
  wat.guest_write32(iid, 0x12345678);
  assert.strictEqual(wat.test_ddrawex_call(out, iid, 0) >>> 0, 0x80004002,
    'unsupported interfaces should return E_NOINTERFACE');
  assert.strictEqual(wat.guest_read32(out) >>> 0, 0,
    'failed creation should clear the output interface');

  wat.guest_write32(out, 0xdeadbeef);
  assert.strictEqual(wat.test_ddrawex_call(out, iid, 1) >>> 0, 0x80040110,
    'aggregation should return CLASS_E_NOAGGREGATION');
  assert.strictEqual(wat.guest_read32(out) >>> 0, 0,
    'aggregation failure should clear the output interface');

  console.log('PASS  DirectDrawCreateEx selects the requested DirectDraw interface');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
