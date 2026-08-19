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
      (br $seed)))
    ;; Model a newly instantiated worker: its mutable globals start at zero.
    (global.set $DX_VTBL_DDRAW (i32.const 0))
    (global.set $DX_VTBL_DPLAY3 (i32.const 0))
    (global.set $DX_VTBL_D3DTEX2 (i32.const 0))
    (call $dx_sync_thread_vtables_if_needed))
  (func (export "test_dx_vtbl_ddraw") (result i32)
    (global.get $DX_VTBL_DDRAW))
  (func (export "test_dx_vtbl_dplay3") (result i32)
    (global.get $DX_VTBL_DPLAY3))
  (func (export "test_dx_vtbl_last") (result i32)
    (global.get $DX_VTBL_D3DTEX2))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const base = 0x51000000;

  wat.test_dx_seed_registry(52, base);
  assert.strictEqual(wat.test_dx_vtbl_ddraw() >>> 0, 0,
    'workers reject a partially initialized shared vtable registry');
  assert.strictEqual(wat.test_dx_vtbl_dplay3() >>> 0, 0,
    'partial registries cannot leak a DirectPlay vtable');

  wat.test_dx_seed_registry(53, base);
  assert.strictEqual(wat.test_dx_vtbl_ddraw() >>> 0, base,
    'worker restores the first generated COM vtable');
  assert.strictEqual(wat.test_dx_vtbl_dplay3() >>> 0, base + 10 * 0x100,
    'worker restores IDirectPlay3 from its generated-order registry slot');
  assert.strictEqual(wat.test_dx_vtbl_last() >>> 0, base + 52 * 0x100,
    'worker restores the final generated COM vtable');

  console.log('PASS  worker instances restore shared DirectX COM vtables');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
