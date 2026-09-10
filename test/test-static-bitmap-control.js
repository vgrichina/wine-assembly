#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
const RegionMap = require('../lib/region-map.generated.js');

const extraWat = String.raw`
  (func (export "test_seed_etched_static") (param $child i32) (param $style i32)
    (local $brush i32)
    (call $static_set_style (call $g2w (call $wnd_get_state_ptr (local.get $child)))
      (i32.or (i32.const 0x50000000) (local.get $style)))
    (local.set $brush (call $host_gdi_create_solid_brush (i32.const 0x00332211)))
    (drop (call $host_gdi_fill_rect (i32.add (local.get $child) (i32.const 0x40000))
      (i32.const 0) (i32.const 0) (i32.const 16) (i32.const 16) (local.get $brush)))
    (drop (call $host_gdi_delete_object (local.get $brush))))

  (func (export "test_create_bitmap_static")
      (param $style_bits i32) (param $w i32) (param $h i32) (result i32)
    (local $top i32) (local $child i32)
    (local.set $top (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $host_register_dialog_frame
      (local.get $top) (i32.const 0) (i32.const 0)
      (i32.const 48) (i32.const 32) (i32.const 0))
    (call $wnd_table_set (local.get $top) (global.get $WNDPROC_CTRL_NATIVE))
    (drop (call $wnd_set_style (local.get $top) (i32.const 0x90000000)))
    (local.set $child (call $ctrl_create_child
      (local.get $top) (i32.const 3) (i32.const 1024)
      (i32.const 4) (i32.const 4) (local.get $w) (local.get $h)
      (i32.or (i32.const 0x5000000E) (local.get $style_bits))
      (i32.const 101)))
    (local.get $child))

  (func (export "test_count_bitmap_objects") (result i32)
    (local $i i32) (local $p i32) (local $count i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_OBJECT_COUNT)))
      (local.set $p (i32.add (global.get $GDI_OBJECT_TABLE)
        (i32.mul (local.get $i) (global.get $GDI_OBJECT_STRIDE))))
      (if (i32.eq (i32.load offset=4 (local.get $p)) (i32.const 3))
        (then (local.set $count (i32.add (local.get $count) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $count))
`;

function installBitmapResource(memory) {
  const bytes = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const guestBase = RegionMap.GUEST_BASE;
  const root = guestBase + 0x1000;
  const payload = guestBase + 0x1100;

  // Minimal PE resource tree: RT_BITMAP / 101 / 1033.
  dv.setUint32(guestBase + 0x3C, 0x80, true);
  dv.setUint32(guestBase + 0x80 + 136, 0x1000, true);
  dv.setUint16(root + 14, 1, true);
  dv.setUint32(root + 16, 2, true);
  dv.setUint32(root + 20, 0x80000020, true);
  dv.setUint16(root + 0x20 + 14, 1, true);
  dv.setUint32(root + 0x30, 101, true);
  dv.setUint32(root + 0x34, 0x80000040, true);
  dv.setUint16(root + 0x40 + 14, 1, true);
  dv.setUint32(root + 0x50, 1033, true);
  dv.setUint32(root + 0x54, 0x60, true);
  dv.setUint32(root + 0x60, 0x1100, true);
  dv.setUint32(root + 0x64, 64, true);

  // 4x2 bottom-up 24-bpp RT_BITMAP. Each row is exactly 12 bytes.
  dv.setUint32(payload, 40, true);
  dv.setInt32(payload + 4, 4, true);
  dv.setInt32(payload + 8, 2, true);
  dv.setUint16(payload + 12, 1, true);
  dv.setUint16(payload + 14, 24, true);
  bytes.set([
    0, 0, 0, 0, 255, 255, 255, 255, 0, 255, 0, 255,
    0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255,
  ], payload + 40);
}

function pixel(canvas, x, y) {
  return [...canvas.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3)];
}

(async () => {
  const h = await bootRenderHarness({ extraWat, width: 96, height: 64, fonts: 'none' });
  const e = h.exports;
  installBitmapResource(h.memory);
  e.init_thread(0, 0, 0, 0, 0, 0, 0, 0x1000);

  const child = e.test_create_bitmap_static(0, 1, 1) >>> 0;
  assert(child, 'SS_BITMAP child should be created');

  const before = e.test_count_bitmap_objects() | 0;
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(e.send_message(child, 0x000F, 0, 0), 0);
    assert.strictEqual(e.test_count_bitmap_objects() | 0, before,
      'resource-backed repaints release their temporary HBITMAP');
  }
  assert.strictEqual(e.ctrl_get_wh(child) >>> 0, 4 | (2 << 16),
    'plain SS_BITMAP adopts the resource natural size');

  h.renderer.repaint();
  const x = e.wnd_window_screen_x(child) | 0;
  const y = e.wnd_window_screen_y(child) | 0;
  assert.deepStrictEqual(pixel(h.canvas, x, y), [255, 0, 0],
    'top-left resource pixel is painted through the static control');
  assert.deepStrictEqual(pixel(h.canvas, x + 2, y), [0, 0, 255],
    'the complete source row is copied in display order');

  const raw = e.guest_alloc(24) >>> 0;
  const source = new Uint8Array(h.memory.buffer, RegionMap.GUEST_BASE + raw, 24);
  source.set(new Array(24).fill(0x55));
  const dynamic = e.test_call_CreateBitmap(4, 2, 1, 24, raw) >>> 0;
  assert(dynamic, 'dynamic HBITMAP should be created');
  e.send_message(child, 0x0172, 0, dynamic);
  assert.strictEqual(e.send_message(child, 0x0173, 0, 0) >>> 0, dynamic,
    'STM_GETIMAGE returns the caller-owned HBITMAP');
  const withDynamic = e.test_count_bitmap_objects() | 0;
  for (let i = 0; i < 3; i++) e.send_message(child, 0x000F, 0, 0);
  assert.strictEqual(e.test_count_bitmap_objects() | 0, withDynamic,
    'painting a caller-owned HBITMAP neither deletes nor duplicates it');

  const centered = e.test_create_bitmap_static(0x200, 8, 6) >>> 0;
  e.send_message(centered, 0x000F, 0, 0);
  assert.strictEqual(e.ctrl_get_wh(centered) >>> 0, 8 | (6 << 16),
    'SS_CENTERIMAGE preserves the requested control extent');

  const stretched = e.test_create_bitmap_static(0x40, 8, 6) >>> 0;
  const beforeStretch = e.test_count_bitmap_objects() | 0;
  e.send_message(stretched, 0x000F, 0, 0);
  assert.strictEqual(e.ctrl_get_wh(stretched) >>> 0, 8 | (6 << 16),
    'SS_REALSIZECONTROL stretches into the requested extent');
  assert.strictEqual(e.test_count_bitmap_objects() | 0, beforeStretch,
    'stretched resource painting releases its temporary HBITMAP');

  for (const style of [0x10, 0x11, 0x12]) {
    const etched = e.test_create_bitmap_static(0x200, 16, 16) >>> 0;
    h.renderer.repaint();
    e.test_seed_etched_static(etched, style);
    for (let i = 0; i < 3; i++) e.send_message(etched, 0x000F, 0, 0);
    h.renderer.repaint();
    const ex = e.wnd_window_screen_x(etched) | 0;
    const ey = e.wnd_window_screen_y(etched) | 0;
    assert.deepStrictEqual(pixel(h.canvas, ex + 8, ey + 8), [17, 34, 51],
      `etched style ${style.toString(16)} must preserve interior artwork`);
    assert.notDeepStrictEqual(pixel(h.canvas, ex, ey), [17, 34, 51],
      'etched border must actually draw');
    const top = pixel(h.canvas, ex + 8, ey);
    const left = pixel(h.canvas, ex, ey + 8);
    if (style === 0x11) assert.deepStrictEqual(top, [17, 34, 51]);
    else assert.notDeepStrictEqual(top, [17, 34, 51]);
    if (style === 0x10) assert.deepStrictEqual(left, [17, 34, 51]);
    else assert.notDeepStrictEqual(left, [17, 34, 51]);
  }
  console.log('PASS  SS_BITMAP resource, STM_SETIMAGE, and etched frame painting');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
