#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

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

  (func (export "test_set_cooperative_level")
      (param $this i32) (param $hwnd i32) (param $level i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectSound_SetCooperativeLevel
      (local.get $this) (local.get $hwnd) (local.get $level)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
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

  assert.strictEqual(wat.test_cocreate(clsid, iid, 0, out) >>> 0, 0);
  assert.strictEqual(hostCreates, 0, 'DirectSound creation stays on the native COM fast path');
  assert.strictEqual(wat.test_esp() >>> 0, 0x30018,
    'CoCreateInstance consumes its return address and five arguments');

  const sound = wat.guest_read32(out) >>> 0;
  assert(sound, 'CLSID_DirectSound returns an IDirectSound object');
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

  wat.guest_write32(clsid, 0x12345678);
  wat.guest_write32(out, 0xfeedface);
  assert.strictEqual(wat.test_cocreate(clsid, iid, 0, out) >>> 0, 0x80040154);
  assert.strictEqual(hostCreates, 1, 'unrelated CLSIDs still use the host COM path');
  assert.strictEqual(wat.guest_read32(out) >>> 0, 0,
    'failed fallback creation clears the output interface');

  console.log('PASS DirectSound CoCreateInstance returns the native 11-slot interface');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
