#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_create") (result i32)
    (call $dx_create_com_obj (i32.const 5) (global.get $DX_VTBL_DSBUF)))

  (func (export "test_query_interface")
      (param $this i32) (param $iid i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectSoundBuffer_QueryInterface
      (local.get $this) (local.get $iid) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_refcount") (param $this i32) (result i32)
    (load.field DxObject refcount (call $dx_from_this (local.get $this))))

  (func (export "test_release") (param $this i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_IDirectSoundBuffer_Release
      (local.get $this) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

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
  let voiceOpens = 0;
  let voiceCloses = 0;
  const { exports: wat, memory } = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      voice_open: () => { voiceOpens++; return 17; },
      voice_close: () => { voiceCloses++; return 0; },
      voice_3d_set: () => {},
    },
  });
  const exe = fs.readFileSync(path.join(__dirname, 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, wat.get_staging());
  assert(wat.load_pe(exe.length), 'fixture PE initializes DirectSound vtables');
  wat.init_dx_com_thunks();

  const allocGuid = words => {
    const guest = wat.guest_alloc(16) >>> 0;
    words.forEach((word, index) => wat.guest_write32(guest + index * 4, word));
    return guest;
  };
  const out = wat.guest_alloc(4) >>> 0;
  const out2 = wat.guest_alloc(4) >>> 0;
  const iunknown = allocGuid([0, 0, 0x000000c0, 0x46000000]);
  const soundBuffer = allocGuid([0x279afa85, 0x11ce4981, 0x200021a5, 0x60e50baf]);
  const sound3DBuffer = allocGuid([0x279afa86, 0x11ce4981, 0x200021a5, 0x60e50baf]);
  const sound3DListener = allocGuid([0x279afa84, 0x11ce4981, 0x200021a5, 0x60e50baf]);
  const forgedBuffer = allocGuid([0x279afa85, 0, 0, 0]);
  const unsupported = allocGuid([0xdeadbeef, 0, 0, 0]);

  const buffer = wat.test_create() >>> 0;
  assert(buffer, 'creates a DirectSound buffer object');
  assert.strictEqual(wat.test_refcount(buffer), 1, 'new buffer owns one reference');

  assert.strictEqual(wat.test_query_interface(buffer, iunknown, 0) >>> 0, 0x80004003,
    'null output returns E_POINTER');
  assert.strictEqual(wat.test_query_interface(buffer, 0, out) >>> 0, 0x80004003,
    'null riid returns E_POINTER');
  assert.strictEqual(wat.guest_read32(out) >>> 0, 0, 'null riid clears output');

  for (const [name, iid] of [['IUnknown', iunknown], ['IDirectSoundBuffer', soundBuffer]]) {
    assert.strictEqual(wat.test_query_interface(buffer, iid, out) >>> 0, 0,
      `complete ${name} succeeds`);
    assert.strictEqual(wat.guest_read32(out) >>> 0, buffer,
      `${name} returns the primary buffer wrapper`);
    assert.strictEqual(wat.test_refcount(buffer), 2, `${name} query AddRefs`);
    assert.strictEqual(wat.test_release(buffer), 1, `${name} query reference balances`);
  }

  assert.strictEqual(wat.test_query_interface(buffer, sound3DBuffer, out) >>> 0, 0,
    'complete IDirectSound3DBuffer succeeds');
  const buffer3D = wat.guest_read32(out) >>> 0;
  assert(buffer3D && buffer3D !== buffer, '3D buffer uses an auxiliary vtable wrapper');
  assert.strictEqual(voiceOpens, 1, 'first 3D-buffer query creates one shared host voice');
  assert.strictEqual(wat.test_query_interface(buffer3D, iunknown, out2) >>> 0, 0,
    'IUnknown is queryable through the 3D wrapper');
  assert.strictEqual(wat.guest_read32(out2) >>> 0, buffer,
    '3D wrapper preserves the controlling IUnknown identity');
  assert.strictEqual(wat.test_release(buffer), 2, 'auxiliary IUnknown reference balances');
  assert.strictEqual(wat.test_release(buffer3D), 1, '3D-buffer query reference balances');

  assert.strictEqual(wat.test_query_interface(buffer, sound3DListener, out) >>> 0, 0,
    'complete IDirectSound3DListener succeeds');
  const listener = wat.guest_read32(out) >>> 0;
  assert(listener && listener !== buffer && listener !== buffer3D,
    'listener uses its distinct auxiliary vtable wrapper');
  assert.strictEqual(wat.test_release(listener), 1, 'listener query reference balances');

  for (const [name, iid] of [
    ['same-Data1 forgery', forgedBuffer],
    ['unsupported IID', unsupported],
  ]) {
    wat.guest_write32(out, 0xcccccccc);
    assert.strictEqual(wat.test_query_interface(buffer, iid, out) >>> 0, 0x80004002,
      `${name} returns E_NOINTERFACE`);
    assert.strictEqual(wat.guest_read32(out) >>> 0, 0, `${name} clears output`);
    assert.strictEqual(wat.test_refcount(buffer), 1, `${name} does not AddRef`);
  }

  assert.strictEqual(wat.test_release(buffer), 0, 'buffer releases to destruction');
  assert.strictEqual(voiceCloses, 1, 'final release closes the one shared host voice');
  assert.strictEqual(wat.test_live_count(), 0, 'all DirectSound buffer faces are balanced');

  console.log('PASS DirectSoundBuffer QueryInterface validates complete identities and ownership');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
