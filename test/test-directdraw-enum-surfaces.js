#!/usr/bin/env node
'use strict';

// IDirectDraw::EnumSurfaces must enumerate the live surfaces owned by this
// DirectDraw object, not report a silent empty success.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_ddes_init")
    (global.set $current_thread_id (i32.const 1))
    (global.set $ddenum_ret_thunk (i32.const 0x55000000)))
  (func (export "test_ddes_ddraw") (result i32)
    (call $dx_create_com_obj (i32.const 1) (i32.const 0x54000000)))
  (func (export "test_ddes_surface")
    (param $ddraw i32) (param $w i32) (param $h i32) (param $caps i32) (result i32)
    (local $obj i32) (local $entry i32)
    (local.set $obj (call $dx_create_com_obj (i32.const 2) (i32.const 0x54000100)))
    (local.set $entry (call $dx_from_this (local.get $obj)))
    (i32.store16 offset=12 (local.get $entry) (local.get $w))
    (i32.store16 offset=14 (local.get $entry) (local.get $h))
    (i32.store16 offset=16 (local.get $entry) (i32.const 16))
    (i32.store16 offset=18 (local.get $entry) (i32.shl (local.get $w) (i32.const 1)))
    (i32.store offset=28 (local.get $entry) (i32.const 4))
    (i32.store (call $dx_surf_meta_ptr (local.get $entry)) (local.get $caps))
    (i32.store (call $dx_surf_owner_ptr (local.get $entry))
      (i32.add (call $dx_slot_of (call $dx_from_this (local.get $ddraw))) (i32.const 1)))
    (local.get $obj))
  (func (export "test_ddes_create_surface")
    (param $ddraw i32) (param $desc i32) (param $out i32) (param $stack i32) (result i32)
    (global.set $esp (local.get $stack))
    (call $handle_IDirectDraw_CreateSurface
      (local.get $ddraw) (local.get $desc) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_ddes_owner") (param $surface i32) (result i32)
    (i32.load (call $dx_surf_owner_ptr (call $dx_from_this (local.get $surface)))))
  (func (export "test_ddes_owner_of_ddraw") (param $ddraw i32) (result i32)
    (i32.add (call $dx_slot_of (call $dx_from_this (local.get $ddraw))) (i32.const 1)))
  (func (export "test_ddes_call")
    (param $ddraw i32) (param $flags i32) (param $desc i32)
    (param $context i32) (param $callback i32) (param $stack i32) (result i32)
    (global.set $esp (local.get $stack))
    (global.set $eip (i32.const 0x56000000))
    (call $handle_IDirectDraw_EnumSurfaces
      (local.get $ddraw) (local.get $flags) (local.get $desc)
      (local.get $context) (local.get $callback) (i32.const 0))
    (global.get $eax))
  (func (export "test_ddes_continue") (param $callback_result i32)
    ;; A stdcall callback pops its return address and three arguments.
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (global.set $eax (local.get $callback_result))
    (call $dd_enum_surfaces_continue))
  (func (export "test_ddes_ref") (param $surface i32) (result i32)
    (i32.load offset=4 (call $dx_from_this (local.get $surface))))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  wat.test_ddes_init();

  const stack = 0x00450000;
  const query = 0x00451000;
  const callback = 0x57000000;
  const callerReturn = 0x58000000;
  const context = 0x1234abcd;
  const ddraw = wat.test_ddes_ddraw() >>> 0;
  const otherDdraw = wat.test_ddes_ddraw() >>> 0;
  const small = wat.test_ddes_surface(ddraw, 320, 200, 0x40) >>> 0;
  const primary = wat.test_ddes_surface(ddraw, 640, 480, 0x218) >>> 0;
  wat.test_ddes_surface(otherDdraw, 800, 600, 0x40);

  // Exercise the production CreateSurface path too; enumeration ownership is
  // recorded there rather than inferred from whichever DDraw was created last.
  const createDesc = 0x00452000;
  const createOut = 0x00452100;
  for (let offset = 0; offset < 108; offset += 4) wat.guest_write32(createDesc + offset, 0);
  wat.guest_write32(createDesc, 108);
  wat.guest_write32(createDesc + 4, 0x7); // DDSD_CAPS | HEIGHT | WIDTH
  wat.guest_write32(createDesc + 8, 64);
  wat.guest_write32(createDesc + 12, 96);
  wat.guest_write32(createDesc + 104, 0x840); // OFFSCREENPLAIN | SYSTEMMEMORY
  assert.strictEqual(wat.test_ddes_create_surface(otherDdraw, createDesc, createOut,
    0x00453000) >>> 0, 0);
  const created = wat.guest_read32(createOut) >>> 0;
  assert(created, 'CreateSurface returns a live interface');
  assert.strictEqual(wat.test_ddes_owner(created), wat.test_ddes_owner_of_ddraw(otherDdraw),
    'CreateSurface records the creating DirectDraw instance');

  const begin = (root, flags, desc = 0, cb = callback) => {
    wat.guest_write32(stack, callerReturn);
    return wat.test_ddes_call(root, flags, desc, context, cb, stack) >>> 0;
  };
  const callbackArgs = () => {
    const esp = wat.get_esp() >>> 0;
    return {
      esp,
      thunk: wat.guest_read32(esp) >>> 0,
      surface: wat.guest_read32(esp + 4) >>> 0,
      desc: wat.guest_read32(esp + 8) >>> 0,
      context: wat.guest_read32(esp + 12) >>> 0,
    };
  };

  assert.strictEqual(begin(ddraw, 0x11), 1,
    'the initial dispatch preserves a non-cancel callback result');
  assert.strictEqual(wat.get_eip() >>> 0, callback);
  let args = callbackArgs();
  assert.deepStrictEqual([args.thunk, args.surface, args.context],
    [0x55000000, small, context],
    'DOESEXIST|ALL calls back with the first owned surface and context');
  assert.deepStrictEqual([
    wat.guest_read32(args.desc), wat.guest_read32(args.desc + 4),
    wat.guest_read32(args.desc + 8), wat.guest_read32(args.desc + 12),
    wat.guest_read32(args.desc + 16), wat.guest_read32(args.desc + 104),
  ], [108, 0x100f, 200, 320, 640, 0x40],
  'callback receives the canonical legacy DDSURFACEDESC');
  assert.strictEqual(wat.test_ddes_ref(small), 2,
    'DOESEXIST AddRefs every surface handed to the callback');

  wat.test_ddes_continue(1); // DDENUMRET_OK
  assert.strictEqual(wat.get_eip() >>> 0, callback);
  args = callbackArgs();
  assert.strictEqual(args.surface, primary,
    'DDENUMRET_OK resumes at the next surface owned by the same DirectDraw');
  assert.strictEqual(wat.test_ddes_ref(primary), 2);
  wat.test_ddes_continue(0); // DDENUMRET_CANCEL
  assert.strictEqual(wat.get_eip() >>> 0, callerReturn,
    'DDENUMRET_CANCEL returns to the original caller');
  assert.strictEqual(wat.get_esp() >>> 0, stack + 24,
    'cancellation restores the five-argument stdcall frame');

  // Match WIDTH=640 and require PRIMARYSURFACE. Extra actual caps are allowed.
  for (let offset = 0; offset < 108; offset += 4) wat.guest_write32(query + offset, 0);
  wat.guest_write32(query, 108);
  wat.guest_write32(query + 4, 0x5); // DDSD_CAPS | DDSD_WIDTH
  wat.guest_write32(query + 12, 640);
  wat.guest_write32(query + 104, 0x200);
  begin(ddraw, 0x12, query); // DOESEXIST | MATCH
  args = callbackArgs();
  assert.strictEqual(args.surface, primary, 'MATCH filters by selected descriptor fields');
  wat.test_ddes_continue(0);

  begin(ddraw, 0x14, query); // DOESEXIST | NOMATCH
  args = callbackArgs();
  assert.strictEqual(args.surface, small, 'NOMATCH returns surfaces outside the descriptor');
  wat.test_ddes_continue(0);

  wat.guest_write32(query + 12, 1024);
  begin(ddraw, 0x12, query);
  assert.strictEqual(wat.get_eip() >>> 0, callerReturn,
    'a valid query with no matches is a successful empty enumeration');
  assert.strictEqual(wat.get_esp() >>> 0, stack + 24);
  assert.strictEqual(wat.get_eax() >>> 0, 0);

  assert.strictEqual(begin(ddraw, 0x10, 0), 0x80070057,
    'a search type without one matching flag is invalid');
  assert.strictEqual(begin(ddraw, 0x12, 0), 0x80070057,
    'MATCH requires a surface description');
  assert.strictEqual(begin(ddraw, 0x11, 0, 0), 0x80070057,
    'a null callback is invalid');
  assert.strictEqual(begin(small, 0x11), 0x88760082,
    'a surface passed as this returns DDERR_INVALIDOBJECT');
  assert.strictEqual(begin(ddraw, 0x0a, query), 0x80004001,
    'CANBECREATED fails honestly until temporary-surface lifetime is modeled');

  console.log('PASS  DirectDraw EnumSurfaces enumerates owned live surfaces with matching and cancellation');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
