#!/usr/bin/env node
'use strict';

// EnumAttachedSurfaces is a callback API, not an existence probe. A silent
// DD_OK hid the backbuffer from games that walk a flip chain this way.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_dd_enum_init")
    (global.set $current_thread_id (i32.const 1))
    (global.set $ddenum_ret_thunk (i32.const 0x55000000)))
  (func (export "test_dd_enum_surface")
    (param $flags i32) (param $caps i32) (result i32)
    (local $obj i32) (local $entry i32)
    (local.set $obj (call $dx_create_com_obj (i32.const 2) (i32.const 0x54000000)))
    (local.set $entry (call $dx_from_this (local.get $obj)))
    (i32.store16 offset=12 (local.get $entry) (i32.const 320))
    (i32.store16 offset=14 (local.get $entry) (i32.const 200))
    (i32.store16 offset=16 (local.get $entry) (i32.const 16))
    (i32.store16 offset=18 (local.get $entry) (i32.const 640))
    (i32.store offset=28 (local.get $entry) (local.get $flags))
    (i32.store (call $dx_surf_meta_ptr (local.get $entry)) (local.get $caps))
    (local.get $obj))
  (func (export "test_dd_enum_link") (param $parent i32) (param $child i32)
    (i32.store offset=8 (call $dx_from_this (local.get $parent)) (local.get $child)))
  (func (export "test_dd_enum_attach_meta") (param $parent i32) (param $child i32)
    (i32.store offset=4 (call $dx_surf_meta_ptr (call $dx_from_this (local.get $child)))
      (i32.add (call $dx_slot_of (call $dx_from_this (local.get $parent))) (i32.const 1))))
  (func (export "test_dd_enum_call")
    (param $surface i32) (param $context i32) (param $callback i32) (param $stack i32)
    (result i32)
    (global.set $esp (local.get $stack))
    (global.set $eip (i32.const 0x56000000))
    (call $handle_IDirectDrawSurface_EnumAttachedSurfaces
      (local.get $surface) (local.get $context) (local.get $callback)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_dd_enum_ref") (param $surface i32) (result i32)
    (i32.load offset=4 (call $dx_from_this (local.get $surface))))
  (func (export "test_dd_enum_release") (param $surface i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_IDirectDrawSurface_Release
      (local.get $surface) (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  wat.test_dd_enum_init();
  const stack = 0x00420000;
  const context = 0x1234abcd;
  const callback = 0x57000000;
  const callerReturn = 0x58000000;
  const caps = 0x00004004; // DDSCAPS_VIDEOMEMORY | DDSCAPS_BACKBUFFER

  const parent = wat.test_dd_enum_surface(1, 0x218) >>> 0;
  const back = wat.test_dd_enum_surface(2, caps) >>> 0;
  wat.test_dd_enum_link(parent, back);
  wat.guest_write32(stack, callerReturn);

  wat.test_dd_enum_call(parent, context, callback, stack);
  assert.strictEqual(wat.get_eip() >>> 0, callback,
    'enumeration transfers control to the guest callback');
  assert.strictEqual(wat.get_esp() >>> 0, stack - 4,
    'callback frame replaces this, context, callback, and the caller return');
  const desc = wat.guest_read32(stack + 4) >>> 0;
  assert.deepStrictEqual([
    wat.guest_read32(stack - 4) >>> 0,
    wat.guest_read32(stack) >>> 0,
    desc,
    wat.guest_read32(stack + 8) >>> 0,
    wat.guest_read32(stack + 12) >>> 0,
  ], [0x55000000, back, desc, context, callerReturn],
  'callback receives surface, DDSURFACEDESC, context, then returns through CACA0007');

  assert(desc, 'callback receives a descriptor');
  assert.deepStrictEqual([
    wat.guest_read32(desc), wat.guest_read32(desc + 4),
    wat.guest_read32(desc + 8), wat.guest_read32(desc + 12),
    wat.guest_read32(desc + 16), wat.guest_read32(desc + 104),
  ], [108, 0x100f, 200, 320, 640, caps],
  'callback descriptor matches GetSurfaceDesc legacy layout and creation caps');
  assert.strictEqual(wat.guest_read32(desc + 72), 32, 'pixel format has DDPIXELFORMAT size');
  assert.strictEqual(wat.guest_read32(desc + 84), 16, 'pixel format reports 16 bpp');
  assert.strictEqual(wat.test_dd_enum_ref(back), 2,
    'enumerated surface is AddRefed for the callback');
  assert.strictEqual(wat.test_dd_enum_release(back), 1,
    'callback owner can release its enumeration reference');

  const explicitParent = wat.test_dd_enum_surface(0, 0x40) >>> 0;
  const explicitChild = wat.test_dd_enum_surface(0, 0x20000) >>> 0;
  wat.test_dd_enum_attach_meta(explicitParent, explicitChild);
  wat.guest_write32(stack, callerReturn);
  wat.test_dd_enum_call(explicitParent, context, callback, stack);
  assert.strictEqual(wat.guest_read32(stack) >>> 0, explicitChild,
    'explicit AddAttachedSurface parent metadata is discoverable');
  assert.strictEqual(wat.test_dd_enum_release(explicitChild), 1);

  const empty = wat.test_dd_enum_surface(0, 0) >>> 0;
  wat.guest_write32(stack, callerReturn);
  assert.strictEqual(wat.test_dd_enum_call(empty, context, callback, stack) >>> 0, 0);
  assert.strictEqual(wat.get_eip() >>> 0, 0x56000000,
    'an empty enumeration does not call the callback');
  assert.strictEqual(wat.get_esp() >>> 0, stack + 16,
    'empty enumeration returns through the original API frame');

  wat.guest_write32(stack, callerReturn);
  assert.strictEqual(wat.test_dd_enum_call(parent, context, 0, stack) >>> 0, 0x80070057,
    'a null callback returns DDERR_INVALIDPARAMS');
  assert.strictEqual(wat.get_eip() >>> 0, 0x56000000);
  assert.strictEqual(wat.get_esp() >>> 0, stack + 16);

  console.log('PASS  DirectDraw EnumAttachedSurfaces calls back with retained direct attachments');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
