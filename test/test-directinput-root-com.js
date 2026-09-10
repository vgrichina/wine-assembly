#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_seed") (param $base i32) (param $expanded i32)
    (global.set $DX_VTBL_DINPUT (local.get $base))
    (global.set $DX_VTBL_DINPUT7 (local.get $expanded)))

  (func (export "test_create") (param $version i32) (param $vtbl i32) (result i32)
    (local $obj i32) (local $entry i32)
    (local.set $obj (call $dx_create_com_obj (i32.const 6) (local.get $vtbl)))
    (local.set $entry (call $dx_from_this (local.get $obj)))
    (store.field.memarg DxObject misc0 (local.get $entry) (local.get $version))
    (local.get $obj))

  (func (export "test_query_interface")
      (param $this i32) (param $iid i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectInput_QueryInterface
      (local.get $this) (local.get $iid) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_create_ex")
      (param $version i32) (param $iid i32) (param $out i32) (param $outer i32)
      (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_DirectInputCreateEx
      (i32.const 0x400000) (local.get $version) (local.get $iid)
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
  const baseVtable = 0x51000000;
  const expandedVtable = 0x51000100;
  wat.test_seed(baseVtable, expandedVtable);

  const allocGuid = words => {
    const guest = wat.guest_alloc(16) >>> 0;
    words.forEach((word, index) => wat.guest_write32(guest + index * 4, word));
    return guest;
  };
  const out = wat.guest_alloc(4) >>> 0;
  const iunknown = allocGuid([0, 0, 0x000000c0, 0x46000000]);
  const inputA = allocGuid([0x89521360, 0x11cfaa8a, 0x4544c7bf, 0x00005453]);
  const input2W = allocGuid([0x5944e663, 0x11cfaa8a, 0x4544c7bf, 0x00005453]);
  const input7W = allocGuid([0x9a4cb685, 0x11d3236d, 0xc0009d8e, 0xae44684f]);
  const input8A = allocGuid([0xbf798030, 0x4da2483a, 0x645d99aa, 0x009736ed]);
  const forgedInput = allocGuid([0x89521360, 0, 0, 0]);

  const legacy = wat.test_create(0x0700, expandedVtable) >>> 0;
  assert(legacy, 'creates a legacy DirectInput7 object');
  assert.strictEqual(wat.test_query_interface(legacy, iunknown, 0) >>> 0, 0x80004003,
    'null output returns E_POINTER');
  assert.strictEqual(wat.test_query_interface(legacy, 0, out) >>> 0, 0x80004003,
    'null riid returns E_POINTER');
  assert.strictEqual(wat.guest_read32(out) >>> 0, 0, 'null riid clears output');

  assert.strictEqual(wat.test_query_interface(legacy, iunknown, out) >>> 0, 0,
    'legacy object exposes IUnknown');
  assert.strictEqual(wat.guest_read32(out) >>> 0, legacy,
    'IUnknown returns the controlling primary wrapper');
  assert.strictEqual(wat.test_refcount(legacy), 2, 'successful IUnknown query AddRefs');
  assert.strictEqual(wat.test_release(legacy), 1, 'IUnknown query reference balances');

  assert.strictEqual(wat.test_query_interface(legacy, inputA, out) >>> 0, 0,
    'DirectInput7 object exposes the base interface');
  const base = wat.guest_read32(out) >>> 0;
  assert.notStrictEqual(base, legacy, 'base ABI uses a distinct wrapper');
  assert.strictEqual(wat.guest_read32(base) >>> 0, baseVtable,
    'base query selects the base vtable');
  assert.strictEqual(wat.test_release(base), 1, 'base query reference balances');

  for (const [name, iid] of [['IDirectInput2W', input2W], ['IDirectInput7W', input7W]]) {
    assert.strictEqual(wat.test_query_interface(legacy, iid, out) >>> 0, 0,
      `legacy object exposes complete ${name}`);
    const iface = wat.guest_read32(out) >>> 0;
    assert.strictEqual(wat.guest_read32(iface) >>> 0, expandedVtable,
      `${name} selects the expanded vtable`);
    assert.strictEqual(wat.test_release(iface), 1, `${name} query reference balances`);
  }

  for (const [name, iid] of [['forged same-Data1 IID', forgedInput], ['IDirectInput8A', input8A]]) {
    wat.guest_write32(out, 0xcccccccc);
    assert.strictEqual(wat.test_query_interface(legacy, iid, out) >>> 0, 0x80004002,
      `${name} is unavailable from a legacy object`);
    assert.strictEqual(wat.guest_read32(out) >>> 0, 0, `${name} failure clears output`);
    assert.strictEqual(wat.test_refcount(legacy), 1, `${name} failure does not AddRef`);
  }
  assert.strictEqual(wat.test_release(legacy), 0, 'legacy root releases cleanly');

  const input8 = wat.test_create(0x0800, baseVtable) >>> 0;
  assert.strictEqual(wat.test_query_interface(input8, input8A, out) >>> 0, 0,
    'DirectInput8 object exposes complete IDirectInput8A');
  assert.strictEqual(wat.guest_read32(out) >>> 0, input8,
    'DirectInput8 returns its primary wrapper');
  assert.strictEqual(wat.test_release(input8), 1, 'DirectInput8 query reference balances');
  assert.strictEqual(wat.test_query_interface(input8, input7W, out) >>> 0, 0x80004002,
    'DirectInput8 object does not expose earlier interfaces');
  assert.strictEqual(wat.test_release(input8), 0, 'DirectInput8 root releases cleanly');

  for (const [name, iid, vtable] of [
    ['IDirectInputA', inputA, baseVtable],
    ['IDirectInput7W', input7W, expandedVtable],
  ]) {
    assert.strictEqual(wat.test_create_ex(0x0700, iid, out, 0) >>> 0, 0,
      `DirectInputCreateEx accepts complete ${name}`);
    const created = wat.guest_read32(out) >>> 0;
    assert.strictEqual(wat.guest_read32(created) >>> 0, vtable,
      `${name} creation selects the matching ABI`);
    assert.strictEqual(wat.test_refcount(created), 1,
      `${name} creation transfers one caller reference`);
    assert.strictEqual(wat.test_release(created), 0, `${name} factory object releases cleanly`);
  }

  for (const [name, iid] of [
    ['same-Data1 forgery', forgedInput],
    ['IDirectInput8A', input8A],
  ]) {
    wat.guest_write32(out, 0xcccccccc);
    assert.strictEqual(wat.test_create_ex(0x0700, iid, out, 0) >>> 0, 0x80004002,
      `DirectInputCreateEx rejects ${name}`);
    assert.strictEqual(wat.guest_read32(out) >>> 0, 0, `${name} failure clears output`);
    assert.strictEqual(wat.test_live_count(), 0, `${name} failure allocates no object`);
  }

  wat.guest_write32(out, 0xcccccccc);
  assert.strictEqual(wat.test_create_ex(0x0700, input7W, out, 1) >>> 0, 0x80040110,
    'unsupported aggregation returns CLASS_E_NOAGGREGATION');
  assert.strictEqual(wat.guest_read32(out) >>> 0, 0, 'aggregation failure clears output');
  assert.strictEqual(wat.test_live_count(), 0, 'all DirectInput root paths are balanced');

  console.log('PASS DirectInput root queries and legacy factory validate complete identities');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
