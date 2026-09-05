#!/usr/bin/env node
'use strict';

// Classic DirectDraw software cursors save a small rectangle, draw the cursor,
// then restore the saved rectangle. If the render target is CPU-redrawn between
// save and restore, that background is stale and must not be stamped over the
// new frame. Age of Empires I/II otherwise leave terrain-colored rectangles
// behind while the camera scrolls through fog.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_dx_surface_new") (param $w i32) (param $h i32) (result i32)
    (local $surface i32) (local $entry i32)
    (local.set $surface (call $dx_create_com_obj (i32.const 2) (i32.const 0x52000000)))
    (local.set $entry (call $dx_from_this (local.get $surface)))
    (i32.store16 offset=12 (local.get $entry) (local.get $w))
    (i32.store16 offset=14 (local.get $entry) (local.get $h))
    (i32.store16 offset=16 (local.get $entry) (i32.const 8))
    (i32.store16 offset=18 (local.get $entry) (local.get $w))
    (i32.store offset=20 (local.get $entry)
      (call $g2w (call $dib_alloc (i32.mul (local.get $w) (local.get $h)))))
    (i32.store offset=28 (local.get $entry) (i32.const 4))
    (local.get $surface))

  (func $test_dx_pixel_wa (param $surface i32) (param $x i32) (param $y i32) (result i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $surface)))
    (i32.add (i32.load offset=20 (local.get $entry))
      (i32.add (i32.mul (local.get $y) (i32.load16_u offset=18 (local.get $entry)))
               (local.get $x))))

  (func (export "test_dx_surface_set")
    (param $surface i32) (param $x i32) (param $y i32) (param $value i32)
    (i32.store8 (call $test_dx_pixel_wa
      (local.get $surface) (local.get $x) (local.get $y)) (local.get $value)))

  (func (export "test_dx_surface_get")
    (param $surface i32) (param $x i32) (param $y i32) (result i32)
    (i32.load8_u (call $test_dx_pixel_wa
      (local.get $surface) (local.get $x) (local.get $y))))

  (func (export "test_dx_surface_blt")
    (param $dst i32) (param $dst_rect i32) (param $src i32) (param $src_rect i32)
    (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDrawSurface_Blt
      (local.get $dst) (local.get $dst_rect) (local.get $src) (local.get $src_rect)
      (i32.const 0x01000000) (i32.const 0))
    (global.get $eax))

  (func (export "test_dx_surface_unlock") (param $surface i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IDirectDrawSurface_Unlock
      (local.get $surface) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
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
  const large = wat.test_dx_surface_new(64, 64) >>> 0;
  const saved = wat.test_dx_surface_new(8, 8) >>> 0;
  const largeRect = 0x410000;
  const savedRect = 0x410020;
  assert(large && saved, 'surface fixtures should allocate');
  writeRect(wat, savedRect, 0, 0, 8, 8);

  // Save 8x8 at (10,12), CPU-redraw the large surface, then request the exact
  // inverse restore. The stale saved value 7 must not replace new value 9.
  writeRect(wat, largeRect, 10, 12, 18, 20);
  wat.test_dx_surface_set(large, 10, 12, 7);
  assert.strictEqual(wat.test_dx_surface_blt(saved, savedRect, large, largeRect) >>> 0, 0);
  assert.strictEqual(wat.test_dx_surface_get(saved, 0, 0), 7);
  wat.test_dx_surface_set(large, 10, 12, 9);
  assert.strictEqual(wat.test_dx_surface_unlock(large) >>> 0, 0);
  assert.strictEqual(wat.test_dx_surface_blt(large, largeRect, saved, savedRect) >>> 0, 0);
  assert.strictEqual(wat.test_dx_surface_get(large, 10, 12), 9,
    'exact inverse restore must not replay a background saved before CPU redraw');

  // With no intervening Unlock, the ordinary save/draw/restore idiom remains
  // intact: a cursor/sprite write in the saved rectangle can be erased.
  writeRect(wat, largeRect, 30, 20, 38, 28);
  wat.test_dx_surface_set(large, 30, 20, 4);
  assert.strictEqual(wat.test_dx_surface_blt(saved, savedRect, large, largeRect) >>> 0, 0);
  wat.test_dx_surface_set(large, 30, 20, 6);
  assert.strictEqual(wat.test_dx_surface_blt(large, largeRect, saved, savedRect) >>> 0, 0);
  assert.strictEqual(wat.test_dx_surface_get(large, 30, 20), 4,
    'same-epoch software-cursor restore must still copy the saved background');

  // Even after a CPU redraw, a copy to a different destination rectangle is
  // normal drawing, not the inverse restore, and must still execute.
  writeRect(wat, largeRect, 40, 10, 48, 18);
  wat.test_dx_surface_set(large, 40, 10, 11);
  assert.strictEqual(wat.test_dx_surface_blt(saved, savedRect, large, largeRect) >>> 0, 0);
  wat.test_dx_surface_set(large, 41, 10, 13);
  assert.strictEqual(wat.test_dx_surface_unlock(large) >>> 0, 0);
  writeRect(wat, largeRect, 41, 10, 49, 18);
  assert.strictEqual(wat.test_dx_surface_blt(large, largeRect, saved, savedRect) >>> 0, 0);
  assert.strictEqual(wat.test_dx_surface_get(large, 41, 10), 11,
    'non-inverse rectangle copy must not be suppressed');

  // AoE's 280x140 UI backing surface is smaller than its 800x600 render
  // target, but it is not cursor storage. Its inverse restore remains real
  // drawing even when the render target was CPU-redrawn in between.
  const frame = wat.test_dx_surface_new(800, 600) >>> 0;
  const panel = wat.test_dx_surface_new(280, 140) >>> 0;
  const framePanelRect = 0x410040;
  const panelRect = 0x410060;
  writeRect(wat, framePanelRect, 100, 80, 380, 220);
  writeRect(wat, panelRect, 0, 0, 280, 140);
  wat.test_dx_surface_set(frame, 100, 80, 17);
  assert.strictEqual(wat.test_dx_surface_blt(panel, panelRect, frame, framePanelRect) >>> 0, 0);
  wat.test_dx_surface_set(frame, 100, 80, 19);
  assert.strictEqual(wat.test_dx_surface_unlock(frame) >>> 0, 0);
  assert.strictEqual(wat.test_dx_surface_blt(frame, framePanelRect, panel, panelRect) >>> 0, 0);
  assert.strictEqual(wat.test_dx_surface_get(frame, 100, 80), 17,
    'large UI backing-surface restore must not be mistaken for a stale cursor restore');

  console.log('PASS  DirectDraw drops only stale exact background restores');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
