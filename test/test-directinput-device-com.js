#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_seed") (param $root i32) (param $device i32) (param $device2 i32)
    (global.set $DX_VTBL_DINPUT7 (local.get $root))
    (global.set $DX_VTBL_DIDEV (local.get $device))
    (global.set $DX_VTBL_DIDEV2 (local.get $device2)))

  (func (export "test_create_root") (result i32)
    (local $obj i32) (local $entry i32)
    (local.set $obj (call $dx_create_com_obj
      (i32.const 6) (global.get $DX_VTBL_DINPUT7)))
    (local.set $entry (call $dx_from_this (local.get $obj)))
    (store.field.memarg DxObject misc0 (local.get $entry) (i32.const 0x0700))
    (local.get $obj))

  (func (export "test_create_device") (result i32)
    (local $obj i32) (local $entry i32)
    (local.set $obj (call $dx_create_com_obj
      (i32.const 7) (global.get $DX_VTBL_DIDEV2)))
    (local.set $entry (call $dx_from_this (local.get $obj)))
    (i32.store offset=16 (local.get $entry) (i32.const 0x0700))
    (local.get $obj))

  (func (export "test_query_interface")
      (param $this i32) (param $iid i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectInputDevice_QueryInterface
      (local.get $this) (local.get $iid) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_create_device_ex")
      (param $root i32) (param $guid i32) (param $iid i32)
      (param $out i32) (param $outer i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectInput7_CreateDeviceEx
      (local.get $root) (local.get $guid) (local.get $iid)
      (local.get $out) (local.get $outer) (i32.const 0))
    (global.get $eax))

  (func (export "test_refcount") (param $this i32) (result i32)
    (load.field DxObject refcount (call $dx_from_this (local.get $this))))

  (func (export "test_release") (param $this i32) (result i32)
    (call $dx_com_release_basic (local.get $this)))

  (func (export "test_live_count") (result i32)
    (local $i i32) (local $count i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $DX_MAX)))
      (if (i32.load (i32.add (global.get $DX_OBJECTS)
            (i32.mul (local.get $i) (i32.const 32))))
        (then (local.set $count (i32.add (local.get $count) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $count))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const rootVtable = 0x52000000;
  const deviceVtable = 0x52000100;
  const device2Vtable = 0x52000200;
  wat.test_seed(rootVtable, deviceVtable, device2Vtable);

  const allocGuid = words => {
    const guest = wat.guest_alloc(16) >>> 0;
    words.forEach((word, index) => wat.guest_write32(guest + index * 4, word));
    return guest;
  };
  const out = wat.guest_alloc(4) >>> 0;
  const out2 = wat.guest_alloc(4) >>> 0;
  const iunknown = allocGuid([0, 0, 0x000000c0, 0x46000000]);
  const deviceA = allocGuid([0x5944e680, 0x11cfc92e, 0x4544c7bf, 0x00005453]);
  const device2W = allocGuid([0x5944e683, 0x11cfc92e, 0x4544c7bf, 0x00005453]);
  const device7A = allocGuid([0x57d7c6bc, 0x11d32356, 0xc0009d8e, 0xae44684f]);
  const device8A = allocGuid([0x54d41080, 0x4833dc15, 0x8f741ba4, 0x7981a373]);
  const forgedDevice2 = allocGuid([0x5944e683, 0, 0, 0]);
  const sysMouse = allocGuid([0x6f1d2b60, 0x11cfd5a0, 0x4544c7bf, 0x00005453]);

  const device = wat.test_create_device() >>> 0;
  assert(device, 'creates an IDirectInputDevice2-backed object');
  assert.strictEqual(wat.test_query_interface(device, iunknown, 0) >>> 0, 0x80004003,
    'null output returns E_POINTER');
  assert.strictEqual(wat.test_query_interface(device, 0, out) >>> 0, 0x80004003,
    'null riid returns E_POINTER');
  assert.strictEqual(wat.guest_read32(out) >>> 0, 0, 'null riid clears output');

  assert.strictEqual(wat.test_query_interface(device, iunknown, out) >>> 0, 0,
    'complete IUnknown succeeds');
  assert.strictEqual(wat.guest_read32(out) >>> 0, device,
    'IUnknown returns the controlling primary wrapper');
  assert.strictEqual(wat.test_release(device), 1, 'IUnknown query reference balances');

  assert.strictEqual(wat.test_query_interface(device, deviceA, out) >>> 0, 0,
    'complete IDirectInputDeviceA succeeds');
  const device1 = wat.guest_read32(out) >>> 0;
  assert.notStrictEqual(device1, device, 'Device1 ABI uses an auxiliary wrapper');
  assert.strictEqual(wat.guest_read32(device1) >>> 0, deviceVtable,
    'Device1 query selects the short vtable');
  assert.strictEqual(wat.test_query_interface(device1, iunknown, out2) >>> 0, 0,
    'IUnknown is queryable through the Device1 wrapper');
  assert.strictEqual(wat.guest_read32(out2) >>> 0, device,
    'Device1 wrapper preserves the controlling IUnknown identity');
  assert.strictEqual(wat.test_release(device), 2, 'auxiliary IUnknown reference balances');
  assert.strictEqual(wat.test_release(device1), 1, 'Device1 query reference balances');

  assert.strictEqual(wat.test_query_interface(device, device2W, out) >>> 0, 0,
    'complete IDirectInputDevice2W succeeds');
  assert.strictEqual(wat.guest_read32(out) >>> 0, device,
    'Device2 query reuses the matching primary wrapper');
  assert.strictEqual(wat.test_release(device), 1, 'Device2 query reference balances');

  for (const [name, iid] of [
    ['same-Data1 forgery', forgedDevice2],
    ['IDirectInputDevice7A without a Device7 tail', device7A],
    ['IDirectInputDevice8A from the legacy class', device8A],
  ]) {
    wat.guest_write32(out, 0xcccccccc);
    assert.strictEqual(wat.test_query_interface(device, iid, out) >>> 0, 0x80004002,
      `${name} returns E_NOINTERFACE`);
    assert.strictEqual(wat.guest_read32(out) >>> 0, 0, `${name} failure clears output`);
    assert.strictEqual(wat.test_refcount(device), 1, `${name} failure does not AddRef`);
  }
  assert.strictEqual(wat.test_release(device), 0, 'direct device releases cleanly');

  const root = wat.test_create_root() >>> 0;
  for (const [name, iid, vtable] of [
    ['IDirectInputDeviceA', deviceA, deviceVtable],
    ['IDirectInputDevice2W', device2W, device2Vtable],
  ]) {
    assert.strictEqual(wat.test_create_device_ex(root, sysMouse, iid, out, 0) >>> 0, 0,
      `CreateDeviceEx accepts complete ${name}`);
    const created = wat.guest_read32(out) >>> 0;
    assert.strictEqual(wat.guest_read32(created) >>> 0, vtable,
      `${name} creation selects the matching ABI`);
    assert.strictEqual(wat.test_refcount(created), 1,
      `${name} creation transfers one caller reference`);
    assert.strictEqual(wat.test_release(created), 0, `${name} factory object releases cleanly`);
  }

  for (const [name, iid] of [
    ['same-Data1 forgery', forgedDevice2],
    ['unsupported Device7 ABI', device7A],
    ['wrong-generation Device8 IID', device8A],
  ]) {
    wat.guest_write32(out, 0xcccccccc);
    assert.strictEqual(wat.test_create_device_ex(root, sysMouse, iid, out, 0) >>> 0, 0x80004002,
      `CreateDeviceEx rejects ${name}`);
    assert.strictEqual(wat.guest_read32(out) >>> 0, 0, `${name} failure clears output`);
    assert.strictEqual(wat.test_live_count(), 1, `${name} failure allocates no device`);
  }

  wat.guest_write32(out, 0xcccccccc);
  assert.strictEqual(wat.test_create_device_ex(root, sysMouse, device2W, out, 1) >>> 0,
    0x80040110, 'unsupported aggregation returns CLASS_E_NOAGGREGATION');
  assert.strictEqual(wat.guest_read32(out) >>> 0, 0, 'aggregation failure clears output');
  assert.strictEqual(wat.test_release(root), 0, 'root releases cleanly');
  assert.strictEqual(wat.test_live_count(), 0, 'all device COM paths are balanced');

  console.log('PASS DirectInput device queries and CreateDeviceEx validate complete identities');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
