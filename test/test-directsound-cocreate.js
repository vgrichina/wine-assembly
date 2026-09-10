#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');
const apiTable = require('../src/api_table.json');

const extraWat = String.raw`
  (func (export "test_cocreate")
      (param $clsid i32) (param $iid i32) (param $outer i32) (param $out i32)
      (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_CoCreateInstance
      (local.get $clsid) (local.get $outer) (i32.const 1) (local.get $iid)
      (local.get $out) (i32.const 0))
    (global.get $eax))

  (func (export "test_esp") (result i32) (global.get $esp))

  (func (export "test_dispatch_one")
      (param $api_id i32) (param $this i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $dispatch_api_table
      (local.get $api_id) (local.get $this)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0))
    (global.get $eax))

  (func (export "test_set_cooperative_level")
      (param $this i32) (param $hwnd i32) (param $level i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectSound_SetCooperativeLevel
      (local.get $this) (local.get $hwnd) (local.get $level)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_query_interface")
      (param $this i32) (param $iid i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectSound_QueryInterface
      (local.get $this) (local.get $iid) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_refcount") (param $this i32) (result i32)
    (load.field DxObject refcount (call $dx_from_this (local.get $this))))

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
  assert(wat.load_pe(exe.length), 'fixture PE initializes DirectSound vtables');
  wat.init_dx_com_thunks();

  const clsid = wat.guest_alloc(16) >>> 0;
  const iid = wat.guest_alloc(16) >>> 0;
  const iunknown = wat.guest_alloc(16) >>> 0;
  const unsupported = wat.guest_alloc(16) >>> 0;
  const out = wat.guest_alloc(4) >>> 0;
  // CLSID_DirectSound and IID_IDirectSound, as requested by SMAC Sound.dll.
  wat.guest_write32(clsid, 0x47d4d946);
  wat.guest_write32(clsid + 4, 0x11cf62e8);
  wat.guest_write32(clsid + 8, 0x4544bc93);
  wat.guest_write32(clsid + 12, 0x00005453);
  wat.guest_write32(iid, 0x279afa83);
  wat.guest_write32(iid + 4, 0x11ce4981);
  wat.guest_write32(iid + 8, 0x200021a5);
  wat.guest_write32(iid + 12, 0x60e50baf);
  wat.guest_write32(iunknown, 0);
  wat.guest_write32(iunknown + 4, 0);
  wat.guest_write32(iunknown + 8, 0x000000c0);
  wat.guest_write32(iunknown + 12, 0x46000000);
  wat.guest_write32(unsupported, 0x279afa83);
  wat.guest_write32(unsupported + 4, 0);
  wat.guest_write32(unsupported + 8, 0);
  wat.guest_write32(unsupported + 12, 0);

  assert.strictEqual(wat.test_cocreate(clsid, iid, 0, out) >>> 0, 0);
  assert.strictEqual(hostCreates, 0, 'DirectSound creation stays on the native COM fast path');
  assert.strictEqual(wat.test_esp() >>> 0, 0x30018,
    'CoCreateInstance consumes its return address and five arguments');

  const sound = wat.guest_read32(out) >>> 0;
  assert(sound, 'CLSID_DirectSound returns an IDirectSound object');
  assert.strictEqual(wat.test_refcount(sound), 1,
    'CoCreateInstance transfers exactly one caller-owned reference');
  const vtable = wat.guest_read32(sound) >>> 0;
  assert(vtable, 'IDirectSound object has a vtable');
  for (let slot = 0; slot < 11; slot++) {
    assert(wat.guest_read32(vtable + slot * 4), `IDirectSound slot ${slot} is populated`);
  }
  const setCooperativeLevel = wat.guest_read32(vtable + 6 * 4) >>> 0;
  assert.strictEqual(wat.guest_read32(setCooperativeLevel + 4) >>> 0, 1050,
    'slot 6 dispatches IDirectSound::SetCooperativeLevel');
  assert.strictEqual(wat.test_set_cooperative_level(sound, 0x10001, 3) >>> 0, 0);
  assert.strictEqual(wat.test_esp() >>> 0, 0x30010,
    'SetCooperativeLevel consumes return, this, HWND, and level');

  assert.strictEqual(wat.test_query_interface(sound, iid, 0) >>> 0, 0x80004003,
    'IDirectSound QueryInterface reports E_POINTER for a null output');
  assert.strictEqual(wat.test_refcount(sound), 1, 'null-output query does not AddRef');
  wat.guest_write32(out, 0xfeedface);
  assert.strictEqual(wat.test_query_interface(sound, unsupported, out) >>> 0, 0x80004002,
    'IDirectSound QueryInterface compares the complete IID');
  assert.strictEqual(wat.guest_read32(out) >>> 0, 0, 'unsupported query clears output');
  assert.strictEqual(wat.test_refcount(sound), 1, 'unsupported query does not AddRef');
  assert.strictEqual(wat.test_query_interface(sound, iunknown, out) >>> 0, 0,
    'IDirectSound exposes IUnknown');
  assert.strictEqual(wat.guest_read32(out) >>> 0, sound);
  assert.strictEqual(wat.test_refcount(sound), 2, 'successful IUnknown query AddRefs');

  const releaseId = apiTable.find(entry => entry.name === 'IDirectSound_Release').id;
  assert.strictEqual(wat.test_dispatch_one(releaseId, sound) >>> 0, 1,
    'IUnknown query reference balances back to the caller reference');

  const liveWithSound = wat.test_live_count();
  wat.guest_write32(out, 0xfeedface);
  assert.strictEqual(wat.test_cocreate(clsid, unsupported, 0, out) >>> 0, 0x80004002,
    'DirectSound factory rejects an unsupported requested IID');
  assert.strictEqual(wat.guest_read32(out) >>> 0, 0, 'factory IID failure clears output');
  assert.strictEqual(wat.test_live_count(), liveWithSound,
    'factory IID failure releases its temporary object reference');
  assert.strictEqual(wat.test_cocreate(clsid, iid, 1, out) >>> 0, 0x80040110,
    'DirectSound factory rejects unsupported aggregation');
  assert.strictEqual(wat.test_live_count(), liveWithSound,
    'aggregation rejection allocates no object');

  // Preserve Data1 but corrupt the rest: this must miss the local class and
  // fall through to the host registry instead of manufacturing DirectSound.
  wat.guest_write32(clsid + 4, 0);
  wat.guest_write32(clsid + 8, 0);
  wat.guest_write32(clsid + 12, 0);
  wat.guest_write32(out, 0xfeedface);
  assert.strictEqual(wat.test_cocreate(clsid, iid, 0, out) >>> 0, 0x80040154);
  assert.strictEqual(hostCreates, 1, 'DirectSound factory compares the complete CLSID');
  assert.strictEqual(wat.test_live_count(), liveWithSound,
    'same-Data1 class mismatch allocates no local object');

  wat.guest_write32(clsid, 0x12345678);
  wat.guest_write32(out, 0xfeedface);
  assert.strictEqual(wat.test_cocreate(clsid, iid, 0, out) >>> 0, 0x80040154);
  assert.strictEqual(hostCreates, 2, 'unrelated CLSIDs still use the host COM path');
  assert.strictEqual(wat.guest_read32(out) >>> 0, 0,
    'failed fallback creation clears the output interface');

  const addRefId = apiTable.find(entry => entry.name === 'IDirectSound_AddRef').id;
  assert.strictEqual(wat.test_dispatch_one(addRefId, sound) >>> 0, 2,
    'generated dispatch routes IDirectSound AddRef through the shared DX lifetime core');
  assert.strictEqual(wat.test_esp() >>> 0, 0x30008,
    'shared AddRef consumes return address and this');
  assert.strictEqual(wat.test_dispatch_one(releaseId, sound) >>> 0, 1,
    'shared Release preserves the caller-owned reference');
  assert.strictEqual(wat.test_dispatch_one(releaseId, sound) >>> 0, 0,
    'final shared Release retires the DirectSound object');
  assert.strictEqual(wat.test_esp() >>> 0, 0x30008,
    'shared Release consumes return address and this');

  console.log('PASS DirectSound CoCreateInstance returns the native 11-slot interface');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
