#!/usr/bin/env node
'use strict';

// A primary DirectSound buffer exposes IDirectSound3DListener through QI.
// Returning its ordinary IDirectSoundBuffer wrapper makes listener slot 11
// dispatch as IDirectSoundBuffer::Lock, whose eight-argument stack cleanup
// destroys the caller's return frame (the post-loading MCM failure).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_dsbuf_create") (result i32)
    (call $dx_create_com_obj (i32.const 5) (global.get $DX_VTBL_DSBUF)))

  (func (export "test_dsbuf_qi")
      (param $this i32) (param $iid i32) (param $out i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_IDirectSoundBuffer_QueryInterface
      (local.get $this) (local.get $iid) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_listener_set_distance_stack")
      (param $this i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectSound3DListener_SetDistanceFactor
      (local.get $this) (i32.const 0x3f800000) (i32.const 1)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $esp))
`;

(async () => {
  const { exports: wat, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const exe = fs.readFileSync(path.join(__dirname, 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, wat.get_staging());
  assert(wat.load_pe(exe.length), 'fixture PE initializes DirectX vtables');
  wat.init_dx_com_thunks();

  const iid = wat.guest_alloc(16) >>> 0;
  const out = wat.guest_alloc(4) >>> 0;
  // IID_IDirectSound3DListener {279AFA84-4981-11CE-A521-0020AF0BE560}.
  wat.guest_write32(iid, 0x279afa84);
  wat.guest_write32(iid + 4, 0x11ce4981);
  wat.guest_write32(iid + 8, 0x200021a5);
  wat.guest_write32(iid + 12, 0x60e50baf);

  const buffer = wat.test_dsbuf_create() >>> 0;
  assert(buffer, 'primary sound buffer fixture allocates');
  assert.strictEqual(wat.test_dsbuf_qi(buffer, iid, out) >>> 0, 0);
  const listener = wat.guest_read32(out) >>> 0;
  assert(listener && listener !== buffer,
    'listener QI must return an auxiliary wrapper, not the buffer vtable');

  const listenerVtable = wat.guest_read32(listener) >>> 0;
  const setDistanceThunk = wat.guest_read32(listenerVtable + 11 * 4) >>> 0;
  const setDopplerThunk = wat.guest_read32(listenerVtable + 12 * 4) >>> 0;
  assert.strictEqual(wat.guest_read32(setDistanceThunk + 4) >>> 0, 3047,
    'listener slot 11 must dispatch SetDistanceFactor');
  assert.strictEqual(wat.guest_read32(setDopplerThunk + 4) >>> 0, 3048,
    'listener slot 12 must dispatch SetDopplerFactor');
  assert.strictEqual(wat.test_listener_set_distance_stack(listener) >>> 0, 0x30010,
    'SetDistanceFactor must consume return + this + value + apply (16 bytes)');

  console.log('PASS DirectSound primary buffer QI exposes the 3D listener vtable');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
