#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('../lib/canvas-compat');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const HWND = 0x10001;
const CHILD = 0x10002;

async function main() {
  const root = path.join(__dirname, '..');
  const wasm = await compileWat(file => fs.promises.readFile(path.join(root, 'src', file), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  let canvas = createCanvas(40, 30);
  let repaints = 0;
  const win = {
    hwnd: HWND, x: 100, y: 50, w: 40, h: 30, style: 0, isChild: false,
    clientRect: { x: 103, y: 55, w: 34, h: 22 },
  };
  const child = {
    hwnd: CHILD, x: 7, y: 12, w: 20, h: 14, style: 0x40000000,
    isChild: true, parentHwnd: HWND,
    clientRect: { x: 0, y: 0, w: 20, h: 14 },
  };
  const renderer = {
    canvas: createCanvas(640, 480),
    windows: { [HWND]: win, [CHILD]: child },
    wasm: { exports: null },
    getWindowCanvas: hwnd => hwnd === HWND ? { canvas, ctx: canvas.getContext('2d') } : null,
    scheduleRepaint: () => { repaints++; },
    invalidate: () => {},
    attachWindowSurface: (hwnd, surfaceCanvas) => {
      if (hwnd !== HWND) return false;
      canvas = surfaceCanvas;
      return true;
    },
    detachWindowSurface: (hwnd, surfaceCanvas) => hwnd === HWND && canvas === surfaceCanvas,
    attachMenuOverlaySurface: surfaceCanvas => {
      renderer.menuOverlayCanvas = surfaceCanvas;
      return true;
    },
    detachMenuOverlaySurface: surfaceCanvas => renderer.menuOverlayCanvas === surfaceCanvas,
  };
  const ctx = { getMemory: () => memory.buffer, renderer, resourceJson: {}, exports: null };
  const base = createHostImports(ctx);
  base.host.memory = memory;
  base.host.create_thread = () => 0;
  base.host.exit_thread = () => 0;
  base.host.create_event = () => 0;
  base.host.set_event = () => 0;
  base.host.reset_event = () => 0;
  base.host.wait_single = () => 0;
  base.host.wait_multiple = () => 0;
  base.host.com_create_instance = () => 0x80004002;
  const { instance } = await WebAssembly.instantiate(wasm, base);
  const wat = instance.exports;
  ctx.exports = wat;
  renderer.wasm.exports = wat;

  assert.strictEqual(wat.menu_prepare_overlay(), 1);
  const overlayBitmap = wat.test_gdi_menu_overlay_bitmap() >>> 0;
  const overlayDc = wat.test_gdi_menu_overlay_dc() >>> 0;
  assert(overlayBitmap && overlayDc && renderer.menuOverlayCanvas,
    'menu overlay should allocate and attach one canonical bitmap/DC');
  const overlayRecord = wat.test_gdi_object_record(overlayBitmap) >>> 0;
  assert(overlayRecord, 'menu overlay bitmap must remain in the WAT object table');
  assert.deepStrictEqual([
    new DataView(memory.buffer).getInt32(overlayRecord + 8, true),
    new DataView(memory.buffer).getInt32(overlayRecord + 12, true),
  ], [640, 480], 'menu overlay bitmap record must preserve screen dimensions');
  assert.strictEqual(wat.menu_prepare_overlay(), 1);
  assert.strictEqual(wat.test_gdi_menu_overlay_bitmap() >>> 0, overlayBitmap,
    'repeated menu overlay preparation must reuse the canonical bitmap');
  assert.strictEqual(wat.test_gdi_menu_overlay_dc() >>> 0, overlayDc,
    'repeated menu overlay preparation must reuse the canonical DC');

  wat.wnd_table_set(HWND, 0);
  wat.wnd_table_set(CHILD, 0);
  wat.ctrl_set_geom(HWND, 100, 50, 40, 30);
  wat.ctrl_set_geom(CHILD, 7, 12, 20, 14);
  wat.test_wnd_set_parent(CHILD, HWND);
  wat.wnd_set_style_export(CHILD, 0x40000000);
  wat.test_gdi_client_rect_set(HWND, 3, 5, 37, 27);
  wat.test_gdi_client_rect_set(CHILD, 0, 0, 20, 14);

  const hdc = wat.test_call_GetDC(HWND) >>> 0;
  assert(hdc, 'GetDC must allocate a real window DC');
  const desc = 0x07EF1000;
  const paintScratch = 0x0000AD40;
  const paintSentinel = [7, 3, 37, 21];
  const dv = new DataView(memory.buffer);
  paintSentinel.forEach((value, index) => dv.setInt32(paintScratch + index * 4, value, true));
  assert.strictEqual(wat.test_gdi_surface_descriptor(hdc, desc), 1);
  assert.deepStrictEqual(
    paintSentinel.map((_, index) => dv.getInt32(paintScratch + index * 4, true)),
    paintSentinel,
    'surface and coordinate resolution must not overwrite the painter RECT');
  assert.deepStrictEqual([
    dv.getInt32(desc + 4, true), dv.getInt32(desc + 8, true),
    dv.getInt32(desc + 72, true), dv.getInt32(desc + 76, true),
  ], [40, 30, 3, 5], 'client DC should resolve into the full window backing with client origin');
  const surfaceId = dv.getUint32(desc + 68, true);
  assert(base.gdi.surfacePresentations.has(surfaceId));

  const redBrush = wat.test_call_CreateSolidBrush(0x000000FF) >>> 0;
  const rect = wat.guest_alloc(16) >>> 0;
  wat.guest_write32(rect, 1);
  wat.guest_write32(rect + 4, 1);
  wat.guest_write32(rect + 8, 5);
  wat.guest_write32(rect + 12, 4);
  assert.strictEqual(wat.test_call_FillRect(hdc, rect, redBrush), 1);
  assert.deepStrictEqual(
    [...canvas.getContext('2d').getImageData(4, 6, 1, 1).data.subarray(0, 3)],
    [255, 0, 0], 'WAT FillRect pixels must upload at the client offset');

  const bmi = wat.guest_alloc(40) >>> 0;
  const bitsOut = wat.guest_alloc(4) >>> 0;
  wat.guest_write32(bmi, 40);
  wat.guest_write32(bmi + 4, 2);
  wat.guest_write32(bmi + 8, -2);
  wat.guest_write16(bmi + 12, 1);
  wat.guest_write16(bmi + 14, 32);
  const sourceBitmap = wat.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
  const sourceDc = wat.test_call_CreateCompatibleDC(0) >>> 0;
  assert(sourceBitmap && sourceDc);
  assert.strictEqual(wat.test_call_SelectObject(sourceDc, sourceBitmap) >>> 0, 0x30007);
  assert.strictEqual(wat.test_call_SetPixel(sourceDc, 0, 0, 0x0000FF00), 0x0000FF00);
  assert.strictEqual(wat.test_call_BitBlt(hdc, 2, 2, 1, 1, sourceDc, 0, 0, 0x00CC0020), 1);
  assert.deepStrictEqual(
    [...canvas.getContext('2d').getImageData(5, 7, 1, 1).data.subarray(0, 3)],
    [0, 255, 0], 'BitBlt destination must map through the client DC origin');

  const text = wat.guest_alloc(2) >>> 0;
  wat.guest_write16(text, 0x58); // "X\0"
  assert.strictEqual(wat.test_call_TextOutA(hdc, 10, 10, text, 1), 1);
  assert.deepStrictEqual(
    [...canvas.getContext('2d').getImageData(4, 6, 1, 1).data.subarray(0, 3)],
    [255, 0, 0], 'text synchronization must retain prior canonical geometry');

  const childDc = wat.test_call_GetDC(CHILD) >>> 0;
  assert(childDc, 'child GetDC must allocate a canonical window DC');
  assert.strictEqual(wat.test_call_TextOutA(childDc, 0, 0, text, 1), 1);
  const childOrigin = [
    wat.wnd_client_screen_x(CHILD) - wat.wnd_window_screen_x(HWND),
    wat.wnd_client_screen_y(CHILD) - wat.wnd_window_screen_y(HWND),
  ];
  const childInk = canvas.getContext('2d').getImageData(
    childOrigin[0], childOrigin[1], 12, 14).data;
  assert([...childInk].some((value, index) => index % 4 !== 3 && value < 128),
    'child text must rasterize at its WAT-computed parent-surface origin');
  assert.strictEqual(wat.test_call_ReleaseDC(CHILD, childDc), 1);

  // WAT-native control/chrome painters predate the explicit GetDC table and
  // still pass the Win9x-style encoded handles directly. They must be adopted
  // into canonical DC state, not routed to a JS Canvas geometry fallback.
  const legacyChildDc = (CHILD + 0x40000) >>> 0;
  assert.strictEqual(wat.test_gdi_surface_descriptor(legacyChildDc, desc), 1);
  assert.deepStrictEqual([
    dv.getInt32(desc + 72, true), dv.getInt32(desc + 76, true),
  ], childOrigin, 'encoded child DC should resolve to the child origin in the owner surface');
  const magentaBrush = wat.test_call_CreateSolidBrush(0x00FF00FF) >>> 0;
  wat.guest_write32(rect, 0);
  wat.guest_write32(rect + 4, 0);
  wat.guest_write32(rect + 8, 2);
  wat.guest_write32(rect + 12, 2);
  assert.strictEqual(wat.test_call_FillRect(legacyChildDc, rect, magentaBrush), 1);
  assert.deepStrictEqual(
    [...canvas.getContext('2d').getImageData(childOrigin[0], childOrigin[1], 1, 1).data.subarray(0, 3)],
    [255, 0, 255], 'encoded child DC geometry must update canonical owner pixels');

  const legacyWholeDc = (HWND + 0xC0000) >>> 0;
  assert.strictEqual(wat.test_gdi_surface_descriptor(legacyWholeDc, desc), 1);
  assert.deepStrictEqual([
    dv.getInt32(desc + 72, true), dv.getInt32(desc + 76, true),
  ], [0, 0], 'encoded whole-window DC should use the owner surface origin');
  assert.strictEqual(wat.test_gdi_dc_clip_intersect_rect(
    legacyWholeDc, 0, 0, 40, 30), 2,
  'top-level whole-window DC default clip must use canonical surface dimensions');

  const bluePen = wat.test_call_CreatePen(0, 1, 0x00FF0000) >>> 0;
  assert.strictEqual(wat.test_call_SelectObject(hdc, bluePen), 0x30017);
  assert.strictEqual(wat.test_call_MoveToEx(hdc, 0, 0), 1);
  assert.strictEqual(wat.test_call_LineTo(hdc, 6, 0), 1);
  assert.deepStrictEqual(
    [...canvas.getContext('2d').getImageData(3, 5, 1, 1).data.subarray(0, 3)],
    [0, 0, 255], 'WAT line pixels must upload to the renderer window canvas');

  const whole = wat.test_call_GetWindowDC(HWND) >>> 0;
  assert.strictEqual(wat.test_gdi_surface_descriptor(whole, desc), 1);
  assert.deepStrictEqual([
    dv.getInt32(desc + 72, true), dv.getInt32(desc + 76, true),
  ], [0, 0], 'whole-window DC origin must be the window top-left');

  win.w = 52;
  win.h = 36;
  win.clientRect = { x: 103, y: 55, w: 46, h: 28 };
  wat.ctrl_set_geom(HWND, 100, 50, 52, 36);
  wat.test_gdi_client_rect_set(HWND, 3, 5, 49, 33);
  assert.strictEqual(wat.test_gdi_surface_descriptor(hdc, desc), 1);
  assert.deepStrictEqual([
    dv.getInt32(desc + 4, true), dv.getInt32(desc + 8, true),
  ], [52, 36], 'descriptor lookup must recreate canonical backing after resize');
  assert.strictEqual(base.gdi.surfacePresentations.get(surfaceId).canvas, canvas,
    'resized canonical surface presentation must become the renderer back canvas');

  assert.strictEqual(wat.test_call_ReleaseDC(HWND, hdc), 1);
  assert.strictEqual(wat.test_call_ReleaseDC(HWND, whole), 1);
  assert.strictEqual(wat.test_call_DeleteObject(sourceBitmap), 1);
  wat.wnd_destroy_tree(HWND);
  assert(!base.gdi.surfacePresentations.has(surfaceId),
    'destroying the owning window must release canonical pixels and presentation');
  assert(repaints > 0, 'window uploads must schedule renderer composition');

  console.log('PASS  real client/whole window DCs use canonical WAT surfaces across resize and destroy');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
