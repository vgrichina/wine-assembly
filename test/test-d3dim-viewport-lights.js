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
  (func (export "test_d3dim_create_device") (result i32)
    (local $obj i32) (local $entry i32) (local $state i32)
    (local.set $obj (call $dx_create_com_obj (i32.const 20) (i32.const 0x53000000)))
    (if (i32.eqz (local.get $obj)) (then (return (i32.const 0))))
    (local.set $entry (call $dx_from_this (local.get $obj)))
    (local.set $state (call $heap_alloc (i32.const 4096)))
    (call $d3ddev_init_state (local.get $state))
    (i32.store offset=16 (local.get $entry) (local.get $state))
    (local.get $obj))
  (func (export "test_d3dim_device_alias") (param $device i32) (result i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $device)))
    (call $dx_get_wrapper_for_vtbl
      (call $dx_slot_of (local.get $entry)) (i32.const 0x54000000)))
  (func (export "test_d3dim_viewport_alias") (param $viewport i32) (result i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $viewport)))
    (call $dx_get_wrapper_for_vtbl
      (call $dx_slot_of (local.get $entry)) (i32.const 0x55000000)))
  (func (export "test_d3dim_add_viewport")
    (param $revision i32) (param $device i32) (param $viewport i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (if (i32.eq (local.get $revision) (i32.const 1))
      (then (call $handle_IDirect3DDevice_AddViewport
        (local.get $device) (local.get $viewport) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0)))
      (else (if (i32.eq (local.get $revision) (i32.const 2))
        (then (call $handle_IDirect3DDevice2_AddViewport
          (local.get $device) (local.get $viewport) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0)))
        (else (call $handle_IDirect3DDevice3_AddViewport
          (local.get $device) (local.get $viewport) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0))))))
    (global.get $eax))
  (func (export "test_d3dim_delete_viewport")
    (param $revision i32) (param $device i32) (param $viewport i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (if (i32.eq (local.get $revision) (i32.const 1))
      (then (call $handle_IDirect3DDevice_DeleteViewport
        (local.get $device) (local.get $viewport) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0)))
      (else (if (i32.eq (local.get $revision) (i32.const 2))
        (then (call $handle_IDirect3DDevice2_DeleteViewport
          (local.get $device) (local.get $viewport) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0)))
        (else (call $handle_IDirect3DDevice3_DeleteViewport
          (local.get $device) (local.get $viewport) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0))))))
    (global.get $eax))
  (func (export "test_d3dim_next_viewport")
    (param $revision i32) (param $device i32) (param $viewport i32)
    (param $out i32) (param $flags i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (if (i32.eq (local.get $revision) (i32.const 1))
      (then (call $handle_IDirect3DDevice_NextViewport
        (local.get $device) (local.get $viewport) (local.get $out) (local.get $flags)
        (i32.const 0) (i32.const 0)))
      (else (if (i32.eq (local.get $revision) (i32.const 2))
        (then (call $handle_IDirect3DDevice2_NextViewport
          (local.get $device) (local.get $viewport) (local.get $out) (local.get $flags)
          (i32.const 0) (i32.const 0)))
        (else (call $handle_IDirect3DDevice3_NextViewport
          (local.get $device) (local.get $viewport) (local.get $out) (local.get $flags)
          (i32.const 0) (i32.const 0))))))
    (global.get $eax))
  (func (export "test_d3dim_set_current_viewport")
    (param $revision i32) (param $device i32) (param $viewport i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (if (i32.eq (local.get $revision) (i32.const 2))
      (then (call $handle_IDirect3DDevice2_SetCurrentViewport
        (local.get $device) (local.get $viewport) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0)))
      (else (call $handle_IDirect3DDevice3_SetCurrentViewport
        (local.get $device) (local.get $viewport) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0))))
    (global.get $eax))
  (func (export "test_d3dim_set_current_viewport_core")
    (param $device i32) (param $viewport i32) (result i32)
    (call $d3dim_device_set_current_viewport
      (local.get $device) (local.get $viewport)))
  (func (export "test_d3dim_get_current_viewport")
    (param $revision i32) (param $device i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (if (i32.eq (local.get $revision) (i32.const 2))
      (then (call $handle_IDirect3DDevice2_GetCurrentViewport
        (local.get $device) (local.get $out) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0)))
      (else (call $handle_IDirect3DDevice3_GetCurrentViewport
        (local.get $device) (local.get $out) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0))))
    (global.get $eax))
  (func (export "test_d3dim_device_add_ref")
    (param $revision i32) (param $device i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (if (i32.eq (local.get $revision) (i32.const 1))
      (then (call $handle_IDirect3DDevice_AddRef
        (local.get $device) (i32.const 0) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0)))
      (else (if (i32.eq (local.get $revision) (i32.const 2))
        (then (call $handle_IDirect3DDevice2_AddRef
          (local.get $device) (i32.const 0) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0)))
        (else (if (i32.eq (local.get $revision) (i32.const 3))
          (then (call $handle_IDirect3DDevice3_AddRef
            (local.get $device) (i32.const 0) (i32.const 0) (i32.const 0)
            (i32.const 0) (i32.const 0)))
          (else (call $handle_IDirect3DDevice7_AddRef
            (local.get $device) (i32.const 0) (i32.const 0) (i32.const 0)
            (i32.const 0) (i32.const 0))))))))
    (global.get $eax))
  (func (export "test_d3dim_device_release")
    (param $revision i32) (param $device i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (if (i32.eq (local.get $revision) (i32.const 1))
      (then (call $handle_IDirect3DDevice_Release
        (local.get $device) (i32.const 0) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0)))
      (else (if (i32.eq (local.get $revision) (i32.const 2))
        (then (call $handle_IDirect3DDevice2_Release
          (local.get $device) (i32.const 0) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0)))
        (else (if (i32.eq (local.get $revision) (i32.const 3))
          (then (call $handle_IDirect3DDevice3_Release
            (local.get $device) (i32.const 0) (i32.const 0) (i32.const 0)
            (i32.const 0) (i32.const 0)))
          (else (call $handle_IDirect3DDevice7_Release
            (local.get $device) (i32.const 0) (i32.const 0) (i32.const 0)
            (i32.const 0) (i32.const 0))))))))
    (global.get $eax))
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
  (func (export "test_d3dim_viewport_owner") (param $viewport i32) (result i32)
    (load.field DxObject misc0 (call $dx_from_this (local.get $viewport))))
  (func (export "test_d3dim_current_viewport_slot") (param $device i32) (result i32)
    (local $state i32)
    (local.set $state (call $d3ddev_state (local.get $device)))
    (if (result i32) (local.get $state)
      (then (call $gl32
        (i32.add (local.get $state) (global.get $D3DIM_OFF_CUR_VP))))
      (else (i32.const 0))))
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
const D3DERR_NOVIEWPORTS = 0x88760304;
const D3DERR_VIEWPORTHASNODEVICE = 0x88760306;
const D3DERR_NOCURRENTVIEWPORT = 0x88760307;
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

  const currentOut = 0x410000;
  for (const revision of [1, 2, 3]) {
    const device = wat.test_d3dim_create_device() >>> 0;
    const deviceAlias = wat.test_d3dim_device_alias(device) >>> 0;
    const otherDevice = wat.test_d3dim_create_device() >>> 0;
    const attached = wat.test_d3dim_create_viewport() >>> 0;
    const unattached = wat.test_d3dim_create_viewport() >>> 0;
    const middle = wat.test_d3dim_create_viewport() >>> 0;
    const newest = wat.test_d3dim_create_viewport() >>> 0;
    const wrongType = wat.test_d3dim_create_light() >>> 0;
    assert(device && deviceAlias && deviceAlias !== device &&
      otherDevice && attached && unattached && middle && newest && wrongType,
      `D3D${revision} viewport relationship setup failed`);

    wat.guest_write32(currentOut, 0xdeadbeef);
    assert.strictEqual(
      wat.test_d3dim_next_viewport(revision, device, 0,
        currentOut, D3DNEXT_HEAD) >>> 0,
      D3DERR_NOVIEWPORTS, 'an empty device reports D3DERR_NOVIEWPORTS');
    assert.strictEqual(wat.guest_read32(currentOut), 0,
      'empty NextViewport clears its caller output');
    assert.strictEqual(wat.test_d3dim_esp() >>> 0, 0x00300014,
      'NextViewport pops its four arguments and return address');
    assert.strictEqual(
      wat.test_d3dim_next_viewport(revision, device, 0, 0, D3DNEXT_HEAD) >>> 0,
      E_INVALIDARG, 'NextViewport rejects a null output pointer');

    assert.strictEqual(
      wat.test_d3dim_add_viewport(revision, device, 0) >>> 0,
      E_INVALIDARG, `D3D${revision} AddViewport rejects NULL`);
    assert.strictEqual(wat.test_d3dim_esp() >>> 0, 0x0030000c,
      'AddViewport pops this, viewport, and the return address');
    assert.strictEqual(
      wat.test_d3dim_add_viewport(revision, device, wrongType) >>> 0,
      E_INVALIDARG, `D3D${revision} AddViewport rejects a non-viewport object`);
    assert.strictEqual(wat.test_d3dim_object_ref(wrongType), 1,
      'rejected AddViewport input is not retained');

    assert.strictEqual(
      wat.test_d3dim_add_viewport(revision, device, attached) >>> 0,
      D3D_OK, `D3D${revision} AddViewport succeeds`);
    assert.strictEqual(wat.test_d3dim_viewport_owner(attached) >>> 0, device,
      'AddViewport records the owning device');
    assert.strictEqual(wat.test_d3dim_object_ref(attached), 2,
      'AddViewport owns one viewport reference');
    assert.strictEqual(
      wat.test_d3dim_add_viewport(revision, deviceAlias, attached) >>> 0,
      D3DERR_VIEWPORTHASNODEVICE,
      'duplicate AddViewport reports existing ownership through another interface');
    assert.strictEqual(
      wat.test_d3dim_add_viewport(revision, otherDevice, attached) >>> 0,
      D3DERR_VIEWPORTHASNODEVICE, 'one viewport cannot belong to two devices');
    assert.strictEqual(wat.test_d3dim_object_ref(attached), 2,
      'rejected viewport attachments do not AddRef');

    assert.strictEqual(
      wat.test_d3dim_add_viewport(revision, deviceAlias, middle) >>> 0,
      D3D_OK, 'a device can own multiple ordered viewports');
    assert.strictEqual(
      wat.test_d3dim_add_viewport(revision, device, newest) >>> 0,
      D3D_OK, 'later AddViewport inserts another list member');
    const middleAlias = wat.test_d3dim_viewport_alias(middle) >>> 0;
    const newestAlias = wat.test_d3dim_viewport_alias(newest) >>> 0;
    assert(middleAlias && middleAlias !== middle && newestAlias && newestAlias !== newest,
      'viewport aliases use distinct wrappers for one COM identity');

    const nextViewport = (viewport, flags, expected, message) => {
      wat.guest_write32(currentOut, 0xdeadbeef);
      assert.strictEqual(
        wat.test_d3dim_next_viewport(revision, deviceAlias, viewport,
          currentOut, flags) >>> 0,
        D3D_OK, message);
      assert.strictEqual(wat.guest_read32(currentOut) >>> 0, expected, message);
      if (expected) {
        assert.strictEqual(wat.test_d3dim_object_ref(expected), 3,
          'NextViewport AddRefs the returned interface');
        assert.strictEqual(wat.test_d3dim_viewport_release(revision, expected), 2,
          'the caller can release its NextViewport reference');
      }
    };
    nextViewport(wrongType, D3DNEXT_HEAD, newest,
      'HEAD ignores its input and returns the newest viewport');
    nextViewport(0, D3DNEXT_TAIL, attached,
      'TAIL ignores NULL input and returns the oldest viewport');
    nextViewport(newestAlias, D3DNEXT_NEXT, middle,
      'NEXT accepts an alias and follows Win9x head insertion order');
    nextViewport(middleAlias, D3DNEXT_NEXT, attached,
      'NEXT continues toward the oldest viewport');
    nextViewport(attached, D3DNEXT_NEXT, 0,
      'NEXT at the list end succeeds with a NULL result');

    wat.guest_write32(currentOut, 0xdeadbeef);
    assert.strictEqual(
      wat.test_d3dim_next_viewport(revision, device, unattached,
        currentOut, D3DNEXT_NEXT) >>> 0,
      E_INVALIDARG, 'NEXT rejects a viewport outside this device');
    assert.strictEqual(wat.guest_read32(currentOut), 0,
      'failed NEXT clears its caller output');
    wat.guest_write32(currentOut, 0xdeadbeef);
    assert.strictEqual(
      wat.test_d3dim_next_viewport(revision, device, newest,
        currentOut, 0x80) >>> 0,
      E_INVALIDARG, 'NextViewport rejects unsupported flag combinations');
    assert.strictEqual(wat.guest_read32(currentOut), 0,
      'invalid flags leave a cleared output');

    assert.strictEqual(
      wat.test_d3dim_delete_viewport(revision, deviceAlias, middleAlias) >>> 0,
      D3D_OK, 'DeleteViewport accepts an alias for a middle list member');
    assert.strictEqual(wat.test_d3dim_object_ref(middle), 1,
      'deleting a middle member releases its list reference');
    nextViewport(newest, D3DNEXT_NEXT, attached,
      'deleting a middle viewport reconnects its neighbors');
    assert.strictEqual(
      wat.test_d3dim_delete_viewport(revision, device, newest) >>> 0,
      D3D_OK, 'DeleteViewport removes the list head');
    assert.strictEqual(wat.test_d3dim_object_ref(newest), 1,
      'deleting the head releases its list reference');
    nextViewport(0, D3DNEXT_HEAD, attached,
      'HEAD advances after deleting the newest viewport');

    assert.strictEqual(
      wat.test_d3dim_delete_viewport(revision, otherDevice, attached) >>> 0,
      E_INVALIDARG, 'DeleteViewport rejects a viewport owned by another device');
    assert.strictEqual(wat.test_d3dim_viewport_owner(attached) >>> 0, device);
    assert.strictEqual(wat.test_d3dim_object_ref(attached), 2);

    if (revision >= 2) {
      wat.guest_write32(currentOut, 0xdeadbeef);
      assert.strictEqual(
        wat.test_d3dim_get_current_viewport(revision, deviceAlias, currentOut) >>> 0,
        D3DERR_NOCURRENTVIEWPORT, 'GetCurrentViewport distinguishes no selection');
      assert.strictEqual(wat.guest_read32(currentOut), 0,
        'failed GetCurrentViewport clears output');
      assert.strictEqual(
        wat.test_d3dim_get_current_viewport(revision, deviceAlias, 0) >>> 0,
        E_INVALIDARG, 'GetCurrentViewport rejects a null output pointer');
      assert.strictEqual(wat.test_d3dim_viewport_owner(unattached), 0,
        'fresh viewport starts without a device owner');
      assert.strictEqual(
        wat.test_d3dim_set_current_viewport_core(deviceAlias, unattached) >>> 0,
        E_INVALIDARG, 'SetCurrentViewport core rejects an unattached viewport');
      assert.strictEqual(
        wat.test_d3dim_set_current_viewport(revision, deviceAlias, unattached) >>> 0,
        E_INVALIDARG, `D3D${revision} SetCurrentViewport requires prior AddViewport ownership`);
      assert.strictEqual(wat.test_d3dim_viewport_owner(unattached), 0,
        'SetCurrentViewport cannot manufacture device ownership');
      assert.strictEqual(wat.test_d3dim_object_ref(unattached), 1);

      assert.strictEqual(
        wat.test_d3dim_set_current_viewport(revision, deviceAlias, attached) >>> 0,
        D3D_OK, 'SetCurrentViewport selects an attached viewport');
      assert.strictEqual(wat.test_d3dim_object_ref(attached), 3,
        'current viewport selection owns an independent reference');
      assert.strictEqual(
        wat.test_d3dim_set_current_viewport(revision, deviceAlias, attached) >>> 0,
        D3D_OK, 'selecting the current viewport again is idempotent');
      assert.strictEqual(wat.test_d3dim_object_ref(attached), 3,
        'idempotent selection does not leak a reference');
      wat.guest_write32(currentOut, 0xdeadbeef);
      assert.strictEqual(
        wat.test_d3dim_get_current_viewport(revision, deviceAlias, currentOut) >>> 0,
        D3D_OK, 'GetCurrentViewport returns the selected viewport');
      assert.strictEqual(wat.guest_read32(currentOut) >>> 0, attached);
      assert.strictEqual(wat.test_d3dim_object_ref(attached), 4,
        'GetCurrentViewport AddRefs its returned interface');
      assert.strictEqual(wat.test_d3dim_viewport_release(revision, attached), 3,
        'caller can release the GetCurrentViewport reference');
      assert.notStrictEqual(wat.test_d3dim_current_viewport_slot(deviceAlias), 0,
        'SetCurrentViewport records a nonzero viewport slot in device state');

      assert.strictEqual(
        wat.test_d3dim_add_viewport(revision, deviceAlias, unattached) >>> 0,
        D3D_OK, 'AddViewport accepts another interface for the owning device');
      assert.strictEqual(wat.test_d3dim_viewport_owner(unattached) >>> 0, device,
        'viewport ownership records canonical COM identity, not interface pointer');
      assert.strictEqual(
        wat.test_d3dim_set_current_viewport(revision, deviceAlias, unattached) >>> 0,
        D3D_OK, 'SetCurrentViewport replaces the selected viewport');
      assert.strictEqual(wat.test_d3dim_object_ref(attached), 2,
        'replacing current viewport releases the old selection reference');
      assert.strictEqual(wat.test_d3dim_object_ref(unattached), 3,
        'replacement viewport owns list and current-selection references');
    }

    assert.strictEqual(
      wat.test_d3dim_delete_viewport(revision, deviceAlias, attached) >>> 0,
      D3D_OK, `D3D${revision} DeleteViewport succeeds`);
    assert.strictEqual(wat.test_d3dim_esp() >>> 0, 0x0030000c,
      'DeleteViewport pops this, viewport, and the return address');
    assert.strictEqual(wat.test_d3dim_viewport_owner(attached), 0,
      'DeleteViewport clears ownership');
    assert.strictEqual(wat.test_d3dim_object_ref(attached), 1,
      `D3D${revision} DeleteViewport releases every reference this attachment owns`);
    assert.strictEqual(
      wat.test_d3dim_delete_viewport(revision, deviceAlias, attached) >>> 0,
      E_INVALIDARG, 'a detached viewport cannot be deleted twice');
    if (revision >= 2) {
      assert.strictEqual(
        wat.test_d3dim_delete_viewport(revision, deviceAlias, unattached) >>> 0,
        D3D_OK, 'deleting the replacement viewport drops list and current references');
      assert.strictEqual(wat.test_d3dim_viewport_owner(unattached), 0);
      assert.strictEqual(wat.test_d3dim_object_ref(unattached), 1);
      wat.guest_write32(currentOut, 0xdeadbeef);
      assert.strictEqual(
        wat.test_d3dim_get_current_viewport(revision, deviceAlias, currentOut) >>> 0,
        D3DERR_NOCURRENTVIEWPORT, 'deleting the current viewport clears selection');
      assert.strictEqual(wat.guest_read32(currentOut), 0);
    }

    assert.strictEqual(wat.test_d3dim_viewport_release(revision, attached), 0);
    assert.strictEqual(wat.test_d3dim_viewport_release(revision, unattached), 0);
    assert.strictEqual(wat.test_d3dim_viewport_release(revision, middle), 0);
    assert.strictEqual(wat.test_d3dim_viewport_release(revision, newest), 0);
    assert.strictEqual(wat.test_d3dim_light_release(wrongType), 0);
    assert.strictEqual(wat.test_d3dim_device_release(revision, otherDevice), 0);
    assert.strictEqual(wat.test_d3dim_device_release(revision, deviceAlias), 0);
  }

  for (const releaseRevision of [1, 2, 3, 7]) {
    const device = wat.test_d3dim_create_device() >>> 0;
    const deviceAlias = wat.test_d3dim_device_alias(device) >>> 0;
    const current = wat.test_d3dim_create_viewport() >>> 0;
    const listed = wat.test_d3dim_create_viewport() >>> 0;
    const retainedLight = wat.test_d3dim_create_light() >>> 0;
    assert.strictEqual(wat.test_d3dim_add_viewport(3, device, current), D3D_OK);
    assert.strictEqual(wat.test_d3dim_add_viewport(3, device, listed), D3D_OK);
    assert.strictEqual(wat.test_d3dim_set_current_viewport(3, device, current), D3D_OK);
    assert.strictEqual(wat.test_d3dim_add_light(3, listed, retainedLight), D3D_OK);
    assert.strictEqual(wat.test_d3dim_viewport_release(3, current), 2,
      'caller release leaves list plus current references');
    assert.strictEqual(wat.test_d3dim_viewport_release(3, listed), 1,
      'caller release leaves the device list reference');

    assert.strictEqual(wat.test_d3dim_device_add_ref(releaseRevision, device), 2,
      `Device${releaseRevision} AddRef shares the underlying object count`);
    assert.strictEqual(wat.test_d3dim_device_release(releaseRevision, device), 1,
      'a nonfinal device Release preserves attachment state');
    assert.strictEqual(wat.test_d3dim_object_type(device), 20);
    assert.strictEqual(wat.test_d3dim_viewport_owner(current) >>> 0, device);
    assert.strictEqual(wat.test_d3dim_object_ref(current), 2,
      'nonfinal device Release preserves list and current references');
    assert.strictEqual(wat.test_d3dim_object_ref(listed), 1,
      'nonfinal device Release preserves ordinary list ownership');

    assert.strictEqual(wat.test_d3dim_device_release(releaseRevision, deviceAlias), 0,
      `final Device${releaseRevision} Release succeeds`);
    assert.strictEqual(wat.test_d3dim_esp() >>> 0, 0x00300008,
      'every device Release revision has one-argument COM cleanup');
    assert.strictEqual(wat.test_d3dim_object_type(device), 0,
      'final device Release destroys the device');
    assert.strictEqual(wat.test_d3dim_object_type(current), 0,
      'device teardown releases both current viewport references');
    assert.strictEqual(wat.test_d3dim_object_type(listed), 0,
      'device teardown releases non-current viewport list ownership');
    assert.strictEqual(wat.test_d3dim_light_owner(retainedLight), 0,
      'viewport destruction during device teardown detaches its lights');
    assert.strictEqual(wat.test_d3dim_object_ref(retainedLight), 1,
      'device teardown returns attached lights to their caller reference');
    assert.strictEqual(wat.test_d3dim_light_release(retainedLight), 0);
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

  console.log('PASS  D3DIM child creation and device/viewport/light ownership match legacy contracts');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
