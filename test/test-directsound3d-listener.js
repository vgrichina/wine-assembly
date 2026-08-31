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

  (func (export "test_ds3d_buffer_get_all")
      (param $this i32) (param $params i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_IDirectSound3DBuffer_GetAllParameters
      (local.get $this) (local.get $params) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_ds3d_buffer_set_all")
      (param $this i32) (param $params i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_IDirectSound3DBuffer_SetAllParameters
      (local.get $this) (local.get $params) (i32.const 1)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_ds3d_listener_get_all")
      (param $this i32) (param $params i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_IDirectSound3DListener_GetAllParameters
      (local.get $this) (local.get $params) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_ds3d_listener_set_all")
      (param $this i32) (param $params i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_IDirectSound3DListener_SetAllParameters
      (local.get $this) (local.get $params) (i32.const 1)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  const voice3dSets = [];
  const { exports: wat, memory } = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      voice_3d_get: () => 0,
      voice_3d_set: (...args) => { voice3dSets.push(args); },
    },
  });
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

  // DS3DBUFFER and DS3DLISTENER are both fixed 64-byte DirectSound
  // structures. Win98 validates the caller-initialized dwSize before reading
  // or writing the remainder; accepting a smaller value corrupts the caller's
  // next stack/heap object.
  const params = wat.guest_alloc(68) >>> 0;
  const canary = 0xc0decafe;
  const sentinel = 0x13579bdf;
  const invalidParam = 0x80070057;
  const pointerError = 0x80004003;

  voice3dSets.length = 0;
  wat.guest_write32(params, 60);
  wat.guest_write32(params + 4, sentinel);
  wat.guest_write32(params + 64, canary);
  assert.strictEqual(wat.test_ds3d_listener_get_all(listener, params) >>> 0,
    invalidParam, 'listener GetAllParameters rejects an undersized structure');
  assert.strictEqual(wat.guest_read32(params + 4) >>> 0, sentinel,
    'rejected listener output must remain untouched');
  assert.strictEqual(wat.guest_read32(params + 64) >>> 0, canary,
    'rejected listener output must not overrun the caller structure');
  assert.strictEqual(wat.test_ds3d_buffer_get_all(buffer, params) >>> 0,
    invalidParam, 'buffer GetAllParameters rejects an undersized structure');
  assert.strictEqual(wat.guest_read32(params + 4) >>> 0, sentinel,
    'rejected buffer output must remain untouched');
  assert.strictEqual(wat.guest_read32(params + 64) >>> 0, canary,
    'rejected buffer output must not overrun the caller structure');

  assert.strictEqual(wat.test_ds3d_listener_set_all(listener, params) >>> 0,
    invalidParam, 'listener SetAllParameters rejects an undersized structure');
  assert.strictEqual(wat.test_ds3d_buffer_set_all(buffer, params) >>> 0,
    invalidParam, 'buffer SetAllParameters rejects an undersized structure');
  assert.strictEqual(voice3dSets.length, 0,
    'rejected DirectSound structures must not mutate host 3D state');
  assert.strictEqual(wat.test_ds3d_listener_get_all(listener, 0) >>> 0,
    pointerError, 'listener GetAllParameters retains its null-pointer result');
  assert.strictEqual(wat.test_ds3d_buffer_set_all(buffer, 0) >>> 0,
    pointerError, 'buffer SetAllParameters retains its null-pointer result');

  wat.guest_write32(params, 64);
  wat.guest_write32(params + 64, canary);
  assert.strictEqual(wat.test_ds3d_listener_get_all(listener, params) >>> 0, 0,
    'listener accepts the exact DS3DLISTENER size');
  assert.strictEqual(wat.guest_read32(params) >>> 0, 64);
  assert.strictEqual(wat.guest_read32(params + 64) >>> 0, canary,
    'valid listener output writes exactly 64 bytes');
  assert.strictEqual(wat.test_ds3d_buffer_get_all(buffer, params) >>> 0, 0,
    'buffer accepts the exact DS3DBUFFER size');
  assert.strictEqual(wat.guest_read32(params + 64) >>> 0, canary,
    'valid buffer output writes exactly 64 bytes');

  // Native-compatible getters accept a larger caller buffer, but still report
  // and write only the fixed structure size. Setters require the exact layout.
  wat.guest_write32(params, 68);
  wat.guest_write32(params + 64, canary);
  assert.strictEqual(wat.test_ds3d_listener_get_all(listener, params) >>> 0, 0,
    'listener getter accepts a larger caller buffer');
  assert.strictEqual(wat.guest_read32(params) >>> 0, 64,
    'listener getter reports the fixed DS3DLISTENER size');
  assert.strictEqual(wat.guest_read32(params + 64) >>> 0, canary,
    'listener getter leaves extension bytes untouched');
  wat.guest_write32(params, 68);
  assert.strictEqual(wat.test_ds3d_buffer_get_all(buffer, params) >>> 0, 0,
    'buffer getter accepts a larger caller buffer');
  assert.strictEqual(wat.guest_read32(params) >>> 0, 64,
    'buffer getter reports the fixed DS3DBUFFER size');
  assert.strictEqual(wat.guest_read32(params + 64) >>> 0, canary,
    'buffer getter leaves extension bytes untouched');

  wat.guest_write32(params, 68);
  voice3dSets.length = 0;
  assert.strictEqual(wat.test_ds3d_listener_set_all(listener, params) >>> 0,
    invalidParam, 'listener setter rejects an oversized fixed-layout structure');
  assert.strictEqual(wat.test_ds3d_buffer_set_all(buffer, params) >>> 0,
    invalidParam, 'buffer setter rejects an oversized fixed-layout structure');
  assert.strictEqual(voice3dSets.length, 0,
    'oversized DirectSound structures must not mutate host 3D state');

  wat.guest_write32(params, 64);
  voice3dSets.length = 0;
  assert.strictEqual(wat.test_ds3d_listener_set_all(listener, params) >>> 0, 0);
  assert.strictEqual(wat.test_ds3d_buffer_set_all(buffer, params) >>> 0, 0);
  assert.strictEqual(voice3dSets.length, 15,
    'valid listener and buffer structures reach every host 3D property group');

  console.log('PASS DirectSound 3D listener vtable and 64-byte parameter contracts');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
