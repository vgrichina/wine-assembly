#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_create") (result i32)
    (call $dx_create_com_obj (i32.const 1) (global.get $DX_VTBL_DDRAW)))

  (func (export "test_query_interface")
      (param $this i32) (param $iid i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDraw_QueryInterface
      (local.get $this) (local.get $iid) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
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
  const { exports: wat, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
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
  const out2 = wat.guest_alloc(4) >>> 0;
  const iunknown = allocGuid([0, 0, 0x000000c0, 0x46000000]);
  const directDrawIids = [
    ['IDirectDraw', [0x6c14db80, 0x11cea733, 0x200021a5, 0x60e50baf]],
    ['IDirectDraw2', [0xb3a6f3e0, 0x11cf2b43, 0xaa00dea2, 0x5633b900]],
    ['IDirectDraw4', [0x9c59509a, 0x11d139bd, 0xc0004a8c, 0xc530d94f]],
    ['IDirectDraw7', [0x15e65ec0, 0x11d23b9c, 0x60002fb9, 0x5bea9797]],
  ].map(([name, words]) => [name, allocGuid(words), words[0]]);
  const direct3DIids = [
    ['IDirect3D', [0x3bba0080, 0x11cf2421, 0xaa001aa3, 0x5633b900]],
    ['IDirect3D2', [0x6aae1ec1, 0x11d0662a, 0xaa009d88, 0x6ab7bb00]],
    ['IDirect3D3', [0xbb223240, 0x11d0e72b, 0xaa00b4a9, 0x3e99c000]],
    ['IDirect3D7', [0xf5049e77, 0x11d24861, 0xa00007a4, 0xa82906c9]],
  ].map(([name, words]) => [name, allocGuid(words), words[0]]);

  const object = wat.test_create() >>> 0;
  assert(object, 'creates a DirectDraw object');
  assert.strictEqual(wat.test_refcount(object), 1, 'new object owns one reference');

  assert.strictEqual(wat.test_query_interface(object, iunknown, 0) >>> 0, 0x80004003,
    'null output returns E_POINTER');
  assert.strictEqual(wat.test_query_interface(object, 0, out) >>> 0, 0x80004003,
    'null riid returns E_POINTER');
  assert.strictEqual(wat.guest_read32(out) >>> 0, 0, 'null riid clears output');
  assert.strictEqual(wat.test_refcount(object), 1, 'invalid pointers do not AddRef');

  assert.strictEqual(wat.test_query_interface(object, iunknown, out) >>> 0, 0,
    'complete IUnknown succeeds');
  assert.strictEqual(wat.guest_read32(out) >>> 0, object,
    'IUnknown returns the controlling primary wrapper');
  assert.strictEqual(wat.test_release(object), 1, 'IUnknown AddRef balances');

  for (const [name, iid] of directDrawIids) {
    assert.strictEqual(wat.test_query_interface(object, iid, out) >>> 0, 0,
      `complete ${name} succeeds`);
    const iface = wat.guest_read32(out) >>> 0;
    assert(iface, `${name} returns an interface wrapper`);
    assert.strictEqual(wat.test_refcount(iface), 2, `${name} AddRefs the shared object`);

    if (name === 'IDirectDraw2') {
      assert.notStrictEqual(iface, object, 'versioned ABI uses an auxiliary wrapper');
      assert.strictEqual(wat.test_query_interface(iface, iunknown, out2) >>> 0, 0,
        'IUnknown is queryable through an auxiliary wrapper');
      assert.strictEqual(wat.guest_read32(out2) >>> 0, object,
        'auxiliary wrapper preserves controlling IUnknown identity');
      assert.strictEqual(wat.test_release(object), 2, 'controlling IUnknown AddRef balances');
    }
    assert.strictEqual(wat.test_release(iface), 1, `${name} reference balances`);
  }

  for (const [name, , data1] of [...directDrawIids, ...direct3DIids]) {
    const partial = allocGuid([data1, 0, 0, 0]);
    wat.guest_write32(out, 0xcccccccc);
    assert.strictEqual(wat.test_query_interface(object, partial, out) >>> 0, 0x80004002,
      `same-Data1 ${name} forgery returns E_NOINTERFACE`);
    assert.strictEqual(wat.guest_read32(out) >>> 0, 0,
      `same-Data1 ${name} failure clears output`);
    assert.strictEqual(wat.test_refcount(object), 1,
      `same-Data1 ${name} failure does not AddRef or create a child`);
  }

  for (const [name, iid] of direct3DIids) {
    assert.strictEqual(wat.test_query_interface(object, iid, out) >>> 0, 0,
      `complete ${name} succeeds`);
    const child = wat.guest_read32(out) >>> 0;
    assert(child && child !== object, `${name} returns a distinct child interface`);
    assert.strictEqual(wat.test_refcount(child), 1, `${name} child owns one reference`);
    assert.strictEqual(wat.test_release(child), 0, `${name} child releases cleanly`);
    assert.strictEqual(wat.test_refcount(object), 1, `${name} leaves parent ownership stable`);
  }

  assert.strictEqual(wat.test_live_count(), 1, 'only the parent remains live');
  assert.strictEqual(wat.test_release(object), 0, 'parent releases to destruction');
  assert.strictEqual(wat.test_live_count(), 0, 'all QueryInterface paths are balanced');

  console.log('PASS IDirectDraw QueryInterface validates full identities and wrapper ownership');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
