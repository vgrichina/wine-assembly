#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_create") (result i32)
    (call $dx_create_com_obj (i32.const 10) (global.get $DX_VTBL_DDFACTORY)))

  (func (export "test_query_interface")
      (param $this i32) (param $iid i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDrawFactory_QueryInterface
      (local.get $this) (local.get $iid) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_cocreate")
      (param $clsid i32) (param $iid i32) (param $outer i32) (param $out i32)
      (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_CoCreateInstance
      (local.get $clsid) (local.get $outer) (i32.const 1) (local.get $iid)
      (local.get $out) (i32.const 0))
    (global.get $eax))

  (func (export "test_esp") (result i32) (global.get $esp))

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
  let hostCreates = 0;
  const { exports: wat, memory } = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      com_create_instance: () => {
        hostCreates++;
        return 0x80040154;
      },
    },
  });
  const exe = fs.readFileSync(path.join(__dirname, 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, wat.get_staging());
  assert(wat.load_pe(exe.length), 'fixture PE initializes COM thunks');
  wat.init_dx_com_thunks();

  const allocGuid = words => {
    const guest = wat.guest_alloc(16) >>> 0;
    words.forEach((word, index) => wat.guest_write32(guest + index * 4, word));
    return guest;
  };
  const out = wat.guest_alloc(4) >>> 0;
  const iunknown = allocGuid([0, 0, 0x000000c0, 0x46000000]);
  const factoryIid = allocGuid([0x4fd2a823, 0x11d086c8, 0xc000ca8f, 0x9d18d94f]);
  const sameData1 = allocGuid([0x4fd2a823, 0, 0, 0]);
  const clsid = allocGuid([0x4fd2a832, 0x11d086c8, 0xc000ca8f, 0x9d18d94f]);
  const corruptClsid = allocGuid([0x4fd2a832, 0, 0, 0]);

  const object = wat.test_create() >>> 0;
  assert(object, 'creates the bounded DirectDrawFactory object');
  assert.strictEqual(wat.test_refcount(object), 1, 'new factory owns one reference');
  const vtable = wat.guest_read32(object) >>> 0;
  for (let slot = 0; slot < 5; slot++) {
    assert(wat.guest_read32(vtable + slot * 4), `IDirectDrawFactory slot ${slot} is populated`);
  }

  assert.strictEqual(wat.test_query_interface(object, factoryIid, 0) >>> 0, 0x80004003,
    'QueryInterface reports E_POINTER for a null output');
  assert.strictEqual(wat.test_refcount(object), 1, 'null-output query does not AddRef');

  for (const [name, iid] of [['IUnknown', iunknown], ['IDirectDrawFactory', factoryIid]]) {
    assert.strictEqual(wat.test_query_interface(object, iid, out) >>> 0, 0,
      `QueryInterface accepts complete ${name}`);
    assert.strictEqual(wat.guest_read32(out) >>> 0, object, `${name} preserves COM identity`);
    assert.strictEqual(wat.test_refcount(object), 2, `${name} query AddRefs`);
    assert.strictEqual(wat.test_release(object), 1, `${name} query reference balances`);
  }

  wat.guest_write32(out, 0xcccccccc);
  assert.strictEqual(wat.test_query_interface(object, sameData1, out) >>> 0, 0x80004002,
    'QueryInterface compares the complete IID');
  assert.strictEqual(wat.guest_read32(out) >>> 0, 0, 'unsupported query clears output');
  assert.strictEqual(wat.test_refcount(object), 1, 'unsupported query does not AddRef');
  assert.strictEqual(wat.test_release(object), 0, 'direct factory object releases to destruction');
  assert.strictEqual(wat.test_live_count(), 0, 'direct QueryInterface path leaks no object');

  wat.guest_write32(out, 0xcccccccc);
  assert.strictEqual(wat.test_cocreate(clsid, sameData1, 0, out) >>> 0, 0x80004002,
    'CoCreateInstance rejects an unsupported requested IID');
  assert.strictEqual(wat.guest_read32(out) >>> 0, 0, 'factory IID failure clears output');
  assert.strictEqual(wat.test_live_count(), 0,
    'factory IID failure releases its temporary object reference');

  wat.guest_write32(out, 0xcccccccc);
  assert.strictEqual(wat.test_cocreate(clsid, factoryIid, 1, out) >>> 0, 0x80040110,
    'CoCreateInstance rejects unsupported aggregation');
  assert.strictEqual(wat.guest_read32(out) >>> 0, 0, 'aggregation failure clears output');
  assert.strictEqual(wat.test_live_count(), 0, 'aggregation rejection allocates no object');

  assert.strictEqual(wat.test_cocreate(clsid, factoryIid, 0, 0) >>> 0, 0x80004003,
    'CoCreateInstance reports E_POINTER for a null output');
  assert.strictEqual(wat.test_live_count(), 0, 'null-output rejection allocates no object');

  assert.strictEqual(wat.test_cocreate(clsid, factoryIid, 0, out) >>> 0, 0,
    'CoCreateInstance returns the requested IDirectDrawFactory interface');
  assert.strictEqual(hostCreates, 0, 'exact CLSID_DirectDrawFactory stays on the local path');
  assert.strictEqual(wat.test_esp() >>> 0, 0x30018,
    'CoCreateInstance consumes its return address and five arguments');
  const factoryObject = wat.guest_read32(out) >>> 0;
  assert(factoryObject, 'factory returns an interface pointer');
  assert.strictEqual(wat.test_refcount(factoryObject), 1,
    'factory transfers exactly one caller-owned reference');
  assert.strictEqual(wat.test_release(factoryObject), 0, 'factory object releases cleanly');

  wat.guest_write32(out, 0xcccccccc);
  assert.strictEqual(wat.test_cocreate(corruptClsid, factoryIid, 0, out) >>> 0, 0x80040154,
    'same-Data1 class mismatch falls through to the host registry');
  assert.strictEqual(hostCreates, 1, 'factory compares the complete CLSID');
  assert.strictEqual(wat.guest_read32(out) >>> 0, 0, 'host fallback failure clears output');
  assert.strictEqual(wat.test_live_count(), 0, 'all factory paths leave no live object');

  console.log('PASS DirectDrawFactory QueryInterface and CoCreateInstance validate full COM identities');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
