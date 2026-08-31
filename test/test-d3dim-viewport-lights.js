#!/usr/bin/env node
'use strict';

// Direct3D 1-3 viewports own an ordered, eight-entry light list.  These calls
// used to report success without retaining, enumerating, or detaching anything,
// which left callers with plausible HRESULTs and completely false COM state.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_d3dim_light_init")
    (global.set $current_thread_id (i32.const 1)))
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
`;

const D3D_OK = 0;
const E_NOTIMPL = 0x80004001;
const E_INVALIDARG = 0x80070057;
const D3DERR_LIGHTHASVIEWPORT = 0x887602ef;
const D3DERR_LIGHTNOTINTHISVIEWPORT = 0x887602f0;
const D3DNEXT_NEXT = 1;
const D3DNEXT_HEAD = 2;
const D3DNEXT_TAIL = 4;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  wat.test_d3dim_light_init();
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

  console.log('PASS  D3DIM viewport lights retain, enumerate, cap, detach, and fail honestly');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
