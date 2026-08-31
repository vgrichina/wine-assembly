#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
// $GUEST_BASE, from the map declared in src/00-regions.wat.
const RegionMap = require('../lib/region-map.generated.js');

const extraWat = String.raw`
  (func (export "test_fill_desktop") (param $hdc i32) (param $w i32) (param $h i32)
    (drop (call $host_gdi_fill_rect (local.get $hdc)
      (i32.const 0) (i32.const 0) (local.get $w) (local.get $h) (i32.const 2))))
  (func (export "test_fill_color")
      (param $hdc i32) (param $x0 i32) (param $y0 i32)
      (param $x1 i32) (param $y1 i32) (param $color i32)
    (local $brush i32)
    (local.set $brush (call $host_gdi_create_solid_brush (local.get $color)))
    (drop (call $host_gdi_fill_rect (local.get $hdc)
      (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1)
      (local.get $brush)))
    (drop (call $host_gdi_delete_object (local.get $brush))))
`;

(async () => {
  const { exports: e, memory, renderer } = await bootRenderHarness({ extraWat });
  const u8 = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const wa = guest => RegionMap.g2w(guest, e.get_image_base());
  const writeString = text => {
    const guest = e.guest_alloc(text.length + 1);
    u8.set(Buffer.from(text + '\0', 'latin1'), wa(guest));
    return guest;
  };

  // LVS_ICON | LVS_AUTOARRANGE | LVS_ALIGNLEFT, matching stock DefView.
  const lv = e.test_create_listview(0, 0, 150, 140, 0x0900, 0);
  const parent = e.wnd_get_parent(lv) >>> 0;
  e.wnd_set_style_export(parent,
    (e.wnd_get_style_export(parent) | 0x10000000) >>> 0);
  renderer.windows[parent] = {
    hwnd: parent, x: 0, y: 0, w: 150, h: 140, zOrder: 1,
    style: 0x10000000, visible: true, isChild: false,
    clientRect: { x: 0, y: 0, w: 150, h: 140 },
  };
  e.ctrl_set_geom(parent, 0, 0, 150, 140);
  e.test_gdi_client_rect_set(parent, 0, 0, 150, 140);
  const hdc = e.test_call_GetDC(parent) >>> 0;
  assert(hdc);
  e.test_fill_desktop(hdc, 150, 140);

  // Even if DefView inserted details columns, icon mode must not paint them.
  const column = e.guest_alloc(24);
  u8.fill(0, wa(column), wa(column) + 24);
  dv.setUint32(wa(column), 0x0006, true); // LVCF_WIDTH | LVCF_TEXT
  dv.setInt32(wa(column) + 8, 120, true);
  dv.setUint32(wa(column) + 12, writeString('Name'), true);
  assert.strictEqual(e.send_message(lv, 0x101B, 0, column), 0);

  const item = e.guest_alloc(40);
  u8.fill(0, wa(item), wa(item) + 40);
  dv.setUint32(wa(item), 0x0003, true); // LVIF_TEXT | LVIF_IMAGE
  dv.setInt32(wa(item) + 4, 0, true);
  dv.setUint32(wa(item) + 20, writeString('My Computer'), true);
  dv.setInt32(wa(item) + 28, 0, true);
  assert.strictEqual(e.send_message(lv, 0x1007, 0, item), 0);
  const textOut = e.guest_alloc(64);
  assert.strictEqual(e.listview_get_item_text(lv, 0, 0, textOut, 64), 'My Computer'.length);

  // Model the authentic COMCTL32 "HIML" object used by stock Win98 shell
  // DLLs: count/cx/cy plus ready-to-blit colour and mask DCs.
  const colorDc = e.test_call_CreateCompatibleDC(hdc) >>> 0;
  const maskDc = e.test_call_CreateCompatibleDC(hdc) >>> 0;
  const colorBmp = e.test_call_CreateCompatibleBitmap(hdc, 32, 32) >>> 0;
  const maskBmp = e.test_call_CreateCompatibleBitmap(hdc, 32, 32) >>> 0;
  e.test_call_SelectObject(colorDc, colorBmp);
  e.test_call_SelectObject(maskDc, maskBmp);
  e.test_fill_color(colorDc, 0, 0, 32, 32, 0x00000000);
  e.test_fill_color(colorDc, 8, 8, 24, 24, 0x000000ff);
  e.test_fill_color(maskDc, 0, 0, 32, 32, 0x00ffffff);
  e.test_fill_color(maskDc, 8, 8, 24, 24, 0x00000000);
  const stockHiml = e.guest_alloc(64);
  u8.fill(0, wa(stockHiml), wa(stockHiml) + 64);
  dv.setUint32(wa(stockHiml) + 0, 0x4c4d4948, true);
  dv.setUint32(wa(stockHiml) + 4, 1, true);
  dv.setUint32(wa(stockHiml) + 16, 32, true);
  dv.setUint32(wa(stockHiml) + 20, 32, true);
  dv.setUint32(wa(stockHiml) + 56, colorDc, true);
  dv.setUint32(wa(stockHiml) + 60, maskDc, true);
  assert.strictEqual(e.send_message(lv, 0x1003, 0, stockHiml), 0);
  assert.strictEqual(e.send_message(lv, 0x1003, 1, 0x12340002), 0);
  assert.strictEqual(e.send_message(lv, 0x1002, 0, 0), stockHiml,
    'LVSIL_NORMAL should remain separate from LVSIL_SMALL');
  assert.strictEqual(e.send_message(lv, 0x1002, 1, 0), 0x12340002);
  e.send_message(lv, 0x1001, 0, -1); // CLR_NONE desktop background
  e.send_message(lv, 0x1024, 0, 0x00ffffff);
  assert.strictEqual(e.test_call_SetPixel(hdc, 2, 2, 0x000000ff) >>> 0, 0x000000ff);
  assert.strictEqual(e.send_message(lv, 0x000F, 0, 0), 0);

  assert.strictEqual(e.test_call_GetPixel(hdc, 2, 2) >>> 0, 0x000000ff,
    'icon mode with CLR_NONE must preserve the painted desktop, not draw a report header');
  let white = 0;
  for (let y = 0; y < 140; y++) {
    for (let x = 0; x < 150; x++) {
      if ((e.test_call_GetPixel(hdc, x, y) >>> 0) === 0x00ffffff) white++;
    }
  }
  assert(white > 20, `centered icon label should paint white text (pixels=${white})`);
  let red = 0;
  for (let y = 8; y < 40; y++) {
    for (let x = 28; x < 60; x++) {
      if ((e.test_call_GetPixel(hdc, x, y) >>> 0) === 0x000000ff) red++;
    }
  }
  assert(red > 100, `authentic HIML colour/mask DCs should paint the icon (pixels=${red})`);
  console.log('PASS  LVS_ICON paints desktop labels without report chrome');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
