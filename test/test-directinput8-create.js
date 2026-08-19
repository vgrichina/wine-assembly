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
  assert.strictEqual(wat.test_dinput8_esp() >>> 0, 0x30018,
    'DirectInput8Create pops its return address and five stdcall arguments');

  wat.guest_write32(out, 0xdeadbeef);
  wat.guest_write32(iid, 0x12345678);
  assert.strictEqual(wat.test_dinput8_call(iid, out, 0) >>> 0, 0x80004002,
    'unsupported interfaces should return E_NOINTERFACE');
  assert.strictEqual(wat.guest_read32(out) >>> 0, 0,
    'interface failure should clear the output pointer');

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
