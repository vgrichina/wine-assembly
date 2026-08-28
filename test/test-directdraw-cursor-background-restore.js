#!/usr/bin/env node
'use strict';

// Motocross Madness starts each overlay frame with a null-source WAIT Blt whose
// explicit source and destination rectangles both cover the complete surface.
// The emulator uses that exact marker to restore the background cached beneath
// the game's keyed 32x32 cursor, without erasing the static title artwork.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_dx_surface_new")
    (param $w i32) (param $h i32) (param $flags i32) (result i32)
    (local $surface i32) (local $entry i32)
    (local.set $surface (call $dx_create_com_obj (i32.const 2) (i32.const 0x52000000)))
    (local.set $entry (call $dx_from_this (local.get $surface)))
    (i32.store16 offset=12 (local.get $entry) (local.get $w))
    (i32.store16 offset=14 (local.get $entry) (local.get $h))
    (i32.store16 offset=16 (local.get $entry) (i32.const 16))
    (i32.store16 offset=18 (local.get $entry) (i32.mul (local.get $w) (i32.const 2)))
    (i32.store offset=20 (local.get $entry)
      (call $g2w (call $dib_alloc (i32.mul (i32.mul (local.get $w) (local.get $h)) (i32.const 2)))))
    (i32.store offset=28 (local.get $entry) (local.get $flags))
    (local.get $surface))

  (func $test_dx_pixel_wa (param $surface i32) (param $x i32) (param $y i32) (result i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $surface)))
    (i32.add (i32.load offset=20 (local.get $entry))
      (i32.add (i32.mul (local.get $y) (i32.load16_u offset=18 (local.get $entry)))
               (i32.mul (local.get $x) (i32.const 2)))))

  (func (export "test_dx_surface_set")
    (param $surface i32) (param $x i32) (param $y i32) (param $value i32)
    (i32.store16 (call $test_dx_pixel_wa
      (local.get $surface) (local.get $x) (local.get $y)) (local.get $value)))

  (func (export "test_dx_surface_get")
    (param $surface i32) (param $x i32) (param $y i32) (result i32)
    (i32.load16_u (call $test_dx_pixel_wa
      (local.get $surface) (local.get $x) (local.get $y))))

  (func (export "test_dx_surface_blt")
    (param $dst i32) (param $dst_rect i32) (param $src i32)
    (param $src_rect i32) (param $flags i32)
    (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDrawSurface_Blt
      (local.get $dst) (local.get $dst_rect) (local.get $src) (local.get $src_rect)
      (local.get $flags) (i32.const 0))
    (global.get $eax))
`;

function writeRect(wat, address, left, top, right, bottom) {
  wat.guest_write32(address, left);
  wat.guest_write32(address + 4, top);
  wat.guest_write32(address + 8, right);
  wat.guest_write32(address + 12, bottom);
}

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const surface = wat.test_dx_surface_new(64, 64, 2) >>> 0;
  const cursor = wat.test_dx_surface_new(32, 32, 4) >>> 0;
  const panelSurface = wat.test_dx_surface_new(640, 480, 2) >>> 0;
  const fullDst = 0x410000;
  const fullSrc = 0x410020;
  const partial = 0x410040;
  const panel = 0x4100a0;
  assert(surface, 'surface fixture should allocate');
  const cursorDst = 0x410060;
  const cursorSrc = 0x410080;
  writeRect(wat, fullDst, 0, 0, 64, 64);
  writeRect(wat, fullSrc, 0, 0, 64, 64);
  writeRect(wat, partial, 1, 1, 63, 63);
  writeRect(wat, panel, 35, 44, 306, 257);
  writeRect(wat, cursorDst, 12, 14, 44, 46);
  writeRect(wat, cursorSrc, 0, 0, 32, 32);

  wat.test_dx_surface_set(surface, 12, 14, 0x1234);
  wat.test_dx_surface_set(cursor, 0, 0, 0x5678);
  // First marker arms the cache without changing the static frame.
  assert.strictEqual(
    wat.test_dx_surface_blt(surface, fullDst, 0, fullSrc, 0x01000000) >>> 0, 0);
  assert.strictEqual(wat.test_dx_surface_get(surface, 12, 14), 0x1234,
    'first legacy frame marker must preserve the static background');
  assert.strictEqual(
    wat.test_dx_surface_blt(surface, cursorDst, cursor, cursorSrc, 0x01008000) >>> 0, 0);
  assert.strictEqual(wat.test_dx_surface_get(surface, 12, 14), 0x5678,
    'keyed cursor should be drawn after caching its background');
  assert.strictEqual(
    wat.test_dx_surface_blt(surface, fullDst, 0, fullSrc, 0x01000000) >>> 0, 0);
  assert.strictEqual(wat.test_dx_surface_get(surface, 12, 14), 0x1234,
    'next legacy frame marker should restore the prior cursor background');

  wat.test_dx_surface_set(surface, 2, 2, 0x44);
  assert.strictEqual(
    wat.test_dx_surface_blt(surface, partial, 0, fullSrc, 0x01000000) >>> 0, 0);
  assert.strictEqual(wat.test_dx_surface_get(surface, 2, 2), 0x44,
    'partial null-source WAIT Blt must remain a successful no-op');

  wat.test_dx_surface_set(panelSurface, 35, 44, 0x1357);
  wat.test_dx_surface_set(panelSurface, 34, 44, 0x2468);
  assert.strictEqual(
    wat.test_dx_surface_blt(panelSurface, panel, 0, 0, 0x01008000) >>> 0, 0);
  assert.strictEqual(wat.test_dx_surface_get(panelSurface, 35, 44), 0,
    'the exact MCM profile-panel fallback should clear its backing rectangle');
  assert.strictEqual(wat.test_dx_surface_get(panelSurface, 34, 44), 0x2468,
    'the MCM profile-panel fallback must preserve adjacent title pixels');

  wat.test_dx_surface_set(surface, 2, 2, 0x44);
  assert.strictEqual(
    wat.test_dx_surface_blt(surface, fullDst, 0, fullSrc, 0x01008000) >>> 0, 0);
  assert.strictEqual(wat.test_dx_surface_get(surface, 2, 2), 0x44,
    'effect-bearing null-source Blt must remain a successful no-op');

  console.log('PASS  DirectDraw legacy null-source cursor-background restore');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
