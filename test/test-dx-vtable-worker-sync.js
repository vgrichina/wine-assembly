#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_dx_seed_registry") (param $count i32) (param $base i32)
    (local $i i32)
    (call $dx_vtable_registry_reset)
    (local.set $i (i32.const 0))
    (block $done (loop $seed
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (call $dx_vtable_registry_append
        (i32.add (local.get $base) (i32.mul (local.get $i) (i32.const 0x100))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $seed))))
  (func (export "test_dx_clear_thread_vtables")
    ;; Model a newly instantiated worker: its mutable globals start at zero.
    (global.set $DX_VTBL_DDRAW (i32.const 0))
    (global.set $DX_VTBL_DPLAY3 (i32.const 0))
    (global.set $DX_VTBL_OLE_FONT (i32.const 0)))
  (func (export "test_dx_vtbl_ddraw") (result i32)
    (global.get $DX_VTBL_DDRAW))
  (func (export "test_dx_vtbl_dplay3") (result i32)
    (global.get $DX_VTBL_DPLAY3))
  ;; The global fed from the highest registry slot -- keep this pointing at
  ;; whatever $dx_sync_thread_vtables assigns last.
  (func (export "test_dx_vtbl_last") (result i32)
    (global.get $DX_VTBL_OLE_FONT))
  ;; Read the size rather than restating it: the registry grows every time a
  ;; COM interface is added, and this test used to hardcode 52/53 -- it went
  ;; red the next time one was, saying "worker does not restore vtables" about
  ;; a worker that restores them correctly.
  (func (export "test_dx_registry_count") (result i32)
    (global.get $DX_VTBL_REGISTRY_COUNT))
  (func (export "test_dx_registry_ptr") (result i32)
    (global.get $DX_VTBL_REGISTRY))
  (func (export "test_dx_registry_bytes") (result i32)
    (i32.add (i32.const 4)
      (i32.mul (global.get $DX_VTBL_REGISTRY_COUNT) (i32.const 4))))
  (func (export "test_dx_aux_end") (result i32)
    (i32.add (global.get $COM_WRAPPERS_AUX)
      (global.get $COM_WRAPPERS_AUX_SIZE)))
  (func (export "test_vsock_ptr") (result i32)
    (global.get $VSOCK_TABLE))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const base = 0x51000000;

  const count = wat.test_dx_registry_count() | 0;
  assert(count > 10, `registry count looks wrong: ${count}`);
  assert.strictEqual(wat.test_dx_aux_end() >>> 0, wat.test_dx_registry_ptr() >>> 0,
    'the shared registry begins immediately after the bounded aux-wrapper pool');
  assert((wat.test_dx_registry_ptr() >>> 0) + (wat.test_dx_registry_bytes() >>> 0)
      <= (wat.test_vsock_ptr() >>> 0),
    'the shared DirectX registry does not overlap the virtual-socket table');

  wat.test_dx_seed_registry(count - 1, base);
  wat.test_dx_clear_thread_vtables();
  wat.init_thread(1, 0, 0, 0, 0, 0, 0);
  assert.strictEqual(wat.test_dx_vtbl_ddraw() >>> 0, 0,
    'workers reject a partially initialized shared vtable registry');
  assert.strictEqual(wat.test_dx_vtbl_dplay3() >>> 0, 0,
    'partial registries cannot leak a DirectPlay vtable');

  wat.test_dx_seed_registry(count, base);
  wat.test_dx_clear_thread_vtables();
  wat.init_thread(1, 0, 0, 0, 0, 0, 0);
  assert.strictEqual(wat.test_dx_vtbl_ddraw() >>> 0, base,
    'init_thread restores the first generated COM vtable before guest code');
  assert.strictEqual(wat.test_dx_vtbl_dplay3() >>> 0, base + 10 * 0x100,
    'worker restores IDirectPlay3 from its generated-order registry slot');
  assert.strictEqual(wat.test_dx_vtbl_last() >>> 0, base + (count - 1) * 0x100,
    'worker restores the final generated COM vtable');

  console.log('PASS  worker instances restore shared DirectX COM vtables');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
