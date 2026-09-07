#!/usr/bin/env node
'use strict';

// Direct3D 1-3 viewports own an ordered, eight-entry light list.  These calls
// used to report success without retaining, enumerating, or detaching anything,
// which left callers with plausible HRESULTs and completely false COM state.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_d3dim_light_init")
    (global.set $current_thread_id (i32.const 1))
    (global.set $DX_VTBL_D3DVP3 (i32.const 0x51000000))
    (global.set $DX_VTBL_D3DLIGHT (i32.const 0x52000000)))
  (func (export "test_d3dim_create_viewport") (result i32)
    (call $dx_create_com_obj (i32.const 23) (i32.const 0x51000000)))
  (func (export "test_d3dim_create_light") (result i32)
    (call $dx_create_com_obj (i32.const 24) (i32.const 0x52000000)))
  (func (export "test_d3dim_add_light")
    (param $revision i32) (param $viewport i32) (param $light i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (if (i32.eq (local.get $revision) (i32.const 1))
      (then (call $handle_IDirect3DViewport_AddLight
        (local.get $viewport) (local.get $light) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0)))
      (else (if (i32.eq (local.get $revision) (i32.const 2))
        (then (call $handle_IDirect3DViewport2_AddLight
          (local.get $viewport) (local.get $light) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0)))
        (else (call $handle_IDirect3DViewport3_AddLight
          (local.get $viewport) (local.get $light) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0))))))
    (global.get $eax))
  (func (export "test_d3dim_delete_light")
    (param $revision i32) (param $viewport i32) (param $light i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (if (i32.eq (local.get $revision) (i32.const 1))
      (then (call $handle_IDirect3DViewport_DeleteLight
        (local.get $viewport) (local.get $light) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0)))
      (else (if (i32.eq (local.get $revision) (i32.const 2))
        (then (call $handle_IDirect3DViewport2_DeleteLight
          (local.get $viewport) (local.get $light) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0)))
        (else (call $handle_IDirect3DViewport3_DeleteLight
          (local.get $viewport) (local.get $light) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0))))))
    (global.get $eax))
  (func (export "test_d3dim_next_light")
    (param $revision i32) (param $viewport i32) (param $light i32)
    (param $out i32) (param $flags i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (if (i32.eq (local.get $revision) (i32.const 1))
      (then (call $handle_IDirect3DViewport_NextLight
        (local.get $viewport) (local.get $light) (local.get $out) (local.get $flags)
        (i32.const 0) (i32.const 0)))
      (else (if (i32.eq (local.get $revision) (i32.const 2))
        (then (call $handle_IDirect3DViewport2_NextLight
          (local.get $viewport) (local.get $light) (local.get $out) (local.get $flags)
          (i32.const 0) (i32.const 0)))
        (else (call $handle_IDirect3DViewport3_NextLight
          (local.get $viewport) (local.get $light) (local.get $out) (local.get $flags)
          (i32.const 0) (i32.const 0))))))
    (global.get $eax))
  (func (export "test_d3dim_light_elements")
    (param $revision i32) (param $viewport i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (if (i32.eq (local.get $revision) (i32.const 1))
      (then (call $handle_IDirect3DViewport_LightElements
        (local.get $viewport) (i32.const 0) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0)))
      (else (if (i32.eq (local.get $revision) (i32.const 2))
        (then (call $handle_IDirect3DViewport2_LightElements
          (local.get $viewport) (i32.const 0) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0)))
        (else (call $handle_IDirect3DViewport3_LightElements
          (local.get $viewport) (i32.const 0) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0))))))
    (global.get $eax))
  (func (export "test_d3dim_viewport_release")
    (param $revision i32) (param $viewport i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (if (i32.eq (local.get $revision) (i32.const 1))
      (then (call $handle_IDirect3DViewport_Release
        (local.get $viewport) (i32.const 0) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0)))
      (else (if (i32.eq (local.get $revision) (i32.const 2))
        (then (call $handle_IDirect3DViewport2_Release
          (local.get $viewport) (i32.const 0) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0)))
        (else (call $handle_IDirect3DViewport3_Release
          (local.get $viewport) (i32.const 0) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0))))))
    (global.get $eax))
  (func (export "test_d3dim_light_release") (param $light i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_IDirect3DLight_Release
      (local.get $light) (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_d3dim_object_type") (param $object i32) (result i32)
    (i32.load (call $dx_from_this (local.get $object))))
  (func (export "test_d3dim_object_ref") (param $object i32) (result i32)
    (i32.load offset=4 (call $dx_from_this (local.get $object))))
  (func (export "test_d3dim_light_owner") (param $light i32) (result i32)
    (i32.load offset=12 (call $dx_from_this (local.get $light))))
  (func (export "test_d3dim_light_index") (param $light i32) (result i32)
    (i32.load offset=16 (call $dx_from_this (local.get $light))))
  (func (export "test_d3dim_viewport_head") (param $viewport i32) (result i32)
    (i32.load (call $d3dim_viewport_light_head_addr (local.get $viewport))))
  (func (export "test_d3dim_create_child_api")
    (param $revision i32) (param $type i32) (param $out i32) (param $outer i32)
    (result i32)
    (global.set $esp (i32.const 0x00300000))
    (if (i32.eq (local.get $type) (i32.const 24))
      (then
        (if (i32.eq (local.get $revision) (i32.const 1))
          (then (call $handle_IDirect3D_CreateLight
            (i32.const 0) (local.get $out) (local.get $outer) (i32.const 0)
            (i32.const 0) (i32.const 0)))
          (else (if (i32.eq (local.get $revision) (i32.const 2))
            (then (call $handle_IDirect3D2_CreateLight
              (i32.const 0) (local.get $out) (local.get $outer) (i32.const 0)
              (i32.const 0) (i32.const 0)))
            (else (call $handle_IDirect3D3_CreateLight
              (i32.const 0) (local.get $out) (local.get $outer) (i32.const 0)
              (i32.const 0) (i32.const 0)))))))
      (else
        (if (i32.eq (local.get $revision) (i32.const 1))
          (then (call $handle_IDirect3D_CreateViewport
            (i32.const 0) (local.get $out) (local.get $outer) (i32.const 0)
            (i32.const 0) (i32.const 0)))
          (else (if (i32.eq (local.get $revision) (i32.const 2))
            (then (call $handle_IDirect3D2_CreateViewport
              (i32.const 0) (local.get $out) (local.get $outer) (i32.const 0)
              (i32.const 0) (i32.const 0)))
            (else (call $handle_IDirect3D3_CreateViewport
              (i32.const 0) (local.get $out) (local.get $outer) (i32.const 0)
              (i32.const 0) (i32.const 0))))))))
    (global.get $eax))
  (func (export "test_d3dim_esp") (result i32) (global.get $esp))
  (func (export "test_d3dim_live_type") (param $type i32) (result i32)
    (local $i i32) (local $count i32) (local $entry i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $DX_MAX)))
      (local.set $entry (i32.add (global.get $DX_OBJECTS)
        (i32.mul (local.get $i) (global.get $DX_ENTRY_SIZE))))
      (if (i32.eq (load.field DxObject type (local.get $entry)) (local.get $type))
        (then (local.set $count (i32.add (local.get $count) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $count))
`;

const D3D_OK = 0;
const E_NOTIMPL = 0x80004001;
const E_INVALIDARG = 0x80070057;
const CLASS_E_NOAGGREGATION = 0x80040110;
const D3DERR_LIGHTHASVIEWPORT = 0x887602ef;
const D3DERR_LIGHTNOTINTHISVIEWPORT = 0x887602f0;
const D3DNEXT_NEXT = 1;
const D3DNEXT_HEAD = 2;
const D3DNEXT_TAIL = 4;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  wat.test_d3dim_light_init();
  const createOut = 0x410000;
  for (const type of [23, 24]) {
    for (const revision of [1, 2, 3]) {
      const before = wat.test_d3dim_live_type(type);
      wat.guest_write32(createOut, 0xdeadbeef);
      assert.strictEqual(
        wat.test_d3dim_create_child_api(revision, type, createOut, 0) >>> 0,
        D3D_OK, `D3D${revision} type ${type} creation succeeds`);
      assert.strictEqual(wat.test_d3dim_esp() >>> 0, 0x00300010,
        'all creation wrappers pop their three arguments and return address');
      const created = wat.guest_read32(createOut) >>> 0;
      assert(created, 'successful creation publishes a child interface');
      assert.strictEqual(wat.test_d3dim_object_type(created), type);
      assert.strictEqual(wat.test_d3dim_object_ref(created), 1);
      assert.strictEqual(wat.test_d3dim_live_type(type), before + 1);
      if (type === 23) wat.test_d3dim_viewport_release(revision, created);
      else wat.test_d3dim_light_release(created);
      assert.strictEqual(wat.test_d3dim_live_type(type), before);

      wat.guest_write32(createOut, 0xdeadbeef);
      assert.strictEqual(
        wat.test_d3dim_create_child_api(revision, type, createOut, 1) >>> 0,
        CLASS_E_NOAGGREGATION, 'legacy D3D child objects do not aggregate');
      assert.strictEqual(wat.guest_read32(createOut), 0,
        'failed aggregation clears the caller output');
      assert.strictEqual(wat.test_d3dim_live_type(type), before,
        'failed aggregation consumes no DX object slot');

      assert.strictEqual(
        wat.test_d3dim_create_child_api(revision, type, 0, 0) >>> 0,
        E_INVALIDARG, 'a null child output is invalid');
      assert.strictEqual(wat.test_d3dim_live_type(type), before,
        'a null output consumes no DX object slot');
    }
  }
  const viewport = wat.test_d3dim_create_viewport() >>> 0;
  const otherViewport = wat.test_d3dim_create_viewport() >>> 0;
  const lights = Array.from({ length: 9 }, () => wat.test_d3dim_create_light() >>> 0);
  const out = 0x410000;

  assert(viewport && otherViewport && lights.every(Boolean), 'DX object allocation failed');
  for (const revision of [1, 2, 3]) {
    assert.strictEqual(wat.test_d3dim_light_elements(revision, viewport) >>> 0, E_NOTIMPL,
      `viewport${revision} LightElements must report unsupported`);
  }

  assert.strictEqual(wat.test_d3dim_add_light(1, viewport, lights[0]) >>> 0, D3D_OK);
  assert.strictEqual(wat.test_d3dim_object_ref(lights[0]), 2,
    'viewport owns one COM reference to an attached light');
  assert.strictEqual(wat.test_d3dim_light_owner(lights[0]) >>> 0, viewport);
  assert.strictEqual(wat.test_d3dim_light_index(lights[0]), 0);
  assert.strictEqual(wat.test_d3dim_add_light(2, viewport, lights[0]) >>> 0,
    D3DERR_LIGHTHASVIEWPORT, 'a light cannot be attached twice');
  assert.strictEqual(wat.test_d3dim_add_light(3, otherViewport, lights[0]) >>> 0,
    D3DERR_LIGHTHASVIEWPORT, 'a light cannot belong to two viewports');
  assert.strictEqual(wat.test_d3dim_object_ref(lights[0]), 2,
    'rejected attachment must not AddRef');

  assert.strictEqual(wat.test_d3dim_add_light(2, viewport, lights[1]) >>> 0, D3D_OK);
  assert.strictEqual(wat.test_d3dim_add_light(3, viewport, lights[2]) >>> 0, D3D_OK);
  assert.strictEqual(wat.test_d3dim_viewport_head(viewport) >>> 0, lights[2],
    'AddLight inserts at the head');

  const next = (revision, light, flags, expected, message) => {
    wat.guest_write32(out, 0xdeadbeef);
    assert.strictEqual(
      wat.test_d3dim_next_light(revision, viewport, light, out, flags) >>> 0,
      D3D_OK, message);
    assert.strictEqual(wat.guest_read32(out) >>> 0, expected, message);
    assert.strictEqual(wat.test_d3dim_object_ref(expected), 3,
      'NextLight AddRefs the returned interface');
    assert.strictEqual(wat.test_d3dim_light_release(expected), 2,
      'caller can release the NextLight reference');
  };
  next(1, 0, D3DNEXT_HEAD, lights[2], 'HEAD returns the newest light');
  next(2, 0, D3DNEXT_TAIL, lights[0], 'TAIL returns the oldest light');
  next(3, lights[2], D3DNEXT_NEXT, lights[1], 'NEXT follows insertion order');

  wat.guest_write32(out, 0xdeadbeef);
  assert.strictEqual(
    wat.test_d3dim_next_light(3, viewport, lights[8], out, D3DNEXT_NEXT) >>> 0,
    E_INVALIDARG, 'NEXT rejects a light outside this viewport');
  assert.strictEqual(wat.guest_read32(out) >>> 0, 0, 'failed NextLight clears output');
  assert.strictEqual(
    wat.test_d3dim_next_light(3, viewport, 0, 0, D3DNEXT_HEAD) >>> 0,
    E_INVALIDARG, 'NextLight rejects a null output pointer');

  assert.strictEqual(wat.test_d3dim_delete_light(1, otherViewport, lights[1]) >>> 0,
    D3DERR_LIGHTNOTINTHISVIEWPORT, 'DeleteLight validates the owning viewport');
  assert.strictEqual(wat.test_d3dim_delete_light(2, viewport, lights[1]) >>> 0, D3D_OK);
  assert.strictEqual(wat.test_d3dim_light_owner(lights[1]), 0);
  assert.strictEqual(wat.test_d3dim_object_ref(lights[1]), 1,
    'DeleteLight releases the viewport reference');
  assert.strictEqual(wat.test_d3dim_delete_light(3, viewport, lights[1]) >>> 0,
    D3DERR_LIGHTNOTINTHISVIEWPORT, 'a detached light cannot be deleted twice');

  assert.strictEqual(wat.test_d3dim_add_light(1, viewport, lights[1]) >>> 0, D3D_OK);
  assert.strictEqual(wat.test_d3dim_light_index(lights[1]), 1,
    'AddLight reuses the lowest free hardware-light index');
  for (let i = 3; i < 8; i++) {
    assert.strictEqual(wat.test_d3dim_add_light((i % 3) + 1, viewport, lights[i]) >>> 0,
      D3D_OK);
  }
  assert.strictEqual(wat.test_d3dim_add_light(3, viewport, lights[8]) >>> 0,
    E_INVALIDARG, 'a Win9x viewport accepts at most eight lights');
  assert.strictEqual(wat.test_d3dim_object_ref(lights[8]), 1,
    'rejected ninth light is not retained');

  assert.strictEqual(wat.test_d3dim_delete_light(2, viewport, lights[1]) >>> 0, D3D_OK);
  assert.strictEqual(wat.test_d3dim_add_light(3, viewport, lights[8]) >>> 0, D3D_OK);
  assert.strictEqual(wat.test_d3dim_light_index(lights[8]), 1,
    'a newly attached light reuses the vacated index');

  assert.strictEqual(wat.test_d3dim_viewport_release(3, viewport), 0);
  assert.strictEqual(wat.test_d3dim_object_type(viewport), 0,
    'final viewport Release destroys the viewport');
  assert.strictEqual(wat.test_d3dim_viewport_head(viewport), 0,
    'viewport destruction clears its light-list head');
  for (const light of lights) {
    assert.strictEqual(wat.test_d3dim_light_owner(light), 0,
      'viewport destruction detaches every light');
    assert.strictEqual(wat.test_d3dim_object_ref(light), 1,
      'viewport destruction releases every attachment reference');
    assert.strictEqual(wat.test_d3dim_light_release(light), 0);
  }
  assert.strictEqual(wat.test_d3dim_viewport_release(1, otherViewport), 0);

  console.log('PASS  D3DIM child creation and viewport-light ownership match legacy contracts');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
