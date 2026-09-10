#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_dinput8_seed") (param $vtbl i32)
    (global.set $DX_VTBL_DINPUT (local.get $vtbl)))
  (func (export "test_dinput8_call")
      (param $iid i32) (param $out i32) (param $outer i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_DirectInput8Create
      (i32.const 0x400000) (i32.const 0x800) (local.get $iid)
      (local.get $out) (local.get $outer) (i32.const 0))
    (global.get $eax))
  (func (export "test_dinput8_esp") (result i32) (global.get $esp))
  (func (export "test_dinput8_refcount") (param $obj i32) (result i32)
    (load.field DxObject refcount (call $dx_from_this (local.get $obj))))
  (func (export "test_dinput8_release") (param $obj i32) (result i32)
    (call $dx_com_release_basic (local.get $obj)))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const iid = 0x410000;
  const out = 0x410020;
  const vtable = 0x53000000;
  wat.test_dinput8_seed(vtable);

  // IID_IDirectInput8A = BF798030-483A-4DA2-AA99-5D64ED369700.
  wat.guest_write32(iid, 0xBF798030);
  wat.guest_write32(iid + 4, 0x4DA2483A);
  wat.guest_write32(iid + 8, 0x645D99AA);
  wat.guest_write32(iid + 12, 0x009736ED);
  assert.strictEqual(wat.test_dinput8_call(iid, out, 0) >>> 0, 0,
    'IDirectInput8A creation should succeed');
  const object = wat.guest_read32(out) >>> 0;
  assert(object, 'DirectInput8Create should publish an interface pointer');
  assert.strictEqual(wat.guest_read32(object) >>> 0, vtable,
    'created interface should use the DirectInput vtable');
  assert.strictEqual(wat.test_dinput8_refcount(object), 1,
    'created interface transfers one caller-owned reference');
  assert.strictEqual(wat.test_dinput8_esp() >>> 0, 0x30018,
    'DirectInput8Create pops its return address and five stdcall arguments');
  assert.strictEqual(wat.test_dinput8_release(object), 0,
    'created IDirectInput8A releases cleanly');

  wat.guest_write32(iid, 0xBF798031);
  assert.strictEqual(wat.test_dinput8_call(iid, out, 0) >>> 0, 0,
    'complete IDirectInput8W creation should succeed');
  assert.strictEqual(wat.test_dinput8_release(wat.guest_read32(out) >>> 0), 0,
    'created IDirectInput8W releases cleanly');

  wat.guest_write32(out, 0xdeadbeef);
  wat.guest_write32(iid, 0xBF798030);
  wat.guest_write32(iid + 4, 0);
  wat.guest_write32(iid + 8, 0);
  wat.guest_write32(iid + 12, 0);
  assert.strictEqual(wat.test_dinput8_call(iid, out, 0) >>> 0, 0x80004002,
    'same-Data1 IID forgery should return E_NOINTERFACE');
  assert.strictEqual(wat.guest_read32(out) >>> 0, 0,
    'interface failure should clear the output pointer');

  wat.guest_write32(iid, 0x89521360);
  wat.guest_write32(iid + 4, 0x11CFAA8A);
  wat.guest_write32(iid + 8, 0x4544C7BF);
  wat.guest_write32(iid + 12, 0x00005453);
  assert.strictEqual(wat.test_dinput8_call(iid, out, 0) >>> 0, 0x80004002,
    'DirectInput8 class rejects legacy IDirectInput interfaces');

  wat.guest_write32(out, 0xdeadbeef);
  assert.strictEqual(wat.test_dinput8_call(iid, out, 1) >>> 0, 0x80040110,
    'aggregation should return CLASS_E_NOAGGREGATION');
  assert.strictEqual(wat.guest_read32(out) >>> 0, 0,
    'aggregation failure should clear the output pointer');

  console.log('PASS  DirectInput8Create returns the requested input interface');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
