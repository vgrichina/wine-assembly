#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('../lib/canvas-compat');
const { createHostImports } = require('../lib/host-imports');
const { mountBundledFonts } = require('./render-helper');
const { compileWat } = require('../lib/compile-wat');

const HWND = 0x10001;
const CHILD = 0x10002;
const GRANDCHILD = 0x10003;
const SECOND_CHILD = 0x10004;

async function main() {
  const root = path.join(__dirname, '..');
  const wasm = await compileWat(file => fs.promises.readFile(path.join(root, 'src', file), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  let canvas = createCanvas(40, 30);
  let repaints = 0;
  const win = {
    hwnd: HWND, x: 100, y: 50, w: 40, h: 30, style: 0x10000000, isChild: false,
    clientRect: { x: 103, y: 55, w: 34, h: 22 },
  };
  const child = {
    hwnd: CHILD, x: 7, y: 12, w: 20, h: 14, style: 0x50000000,
    isChild: true, parentHwnd: HWND,
    clientRect: { x: 0, y: 0, w: 20, h: 14 },
  };
  const grandchild = {
    hwnd: GRANDCHILD, x: 15, y: 8, w: 10, h: 10, style: 0x50000000,
    isChild: true, parentHwnd: CHILD,
    clientRect: { x: 0, y: 0, w: 10, h: 10 },
  };
  const renderer = {
    canvas: createCanvas(640, 480),
    windows: { [HWND]: win, [CHILD]: child, [GRANDCHILD]: grandchild },
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
  mountBundledFonts(ctx);
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
  // The VFS reads guest memory through ctx.exports, so a font file cannot be
  // loaded until this is set — and with no host text path left, no font means
  // no text at all.
  ctx.exports = wat;
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
  wat.wnd_table_set(GRANDCHILD, 0);
  wat.ctrl_set_geom(HWND, 100, 50, 40, 30);
  wat.ctrl_set_geom(CHILD, 7, 12, 20, 14);
  wat.ctrl_set_geom(GRANDCHILD, 15, 8, 10, 10);
  wat.test_wnd_set_parent(CHILD, HWND);
  wat.test_wnd_set_parent(GRANDCHILD, CHILD);
  wat.wnd_set_style_export(HWND, 0x10000000);
  wat.wnd_set_style_export(CHILD, 0x50000000);
  wat.wnd_set_style_export(GRANDCHILD, 0x50000000);
  wat.test_gdi_client_rect_set(HWND, 3, 5, 37, 27);
  wat.test_gdi_client_rect_set(CHILD, 0, 0, 20, 14);
  wat.test_gdi_client_rect_set(GRANDCHILD, 0, 0, 10, 10);

  const hdc = wat.test_call_GetDC(HWND) >>> 0;
  assert(hdc, 'GetDC must allocate a real window DC');
  const dcOrigin = wat.guest_alloc(8) >>> 0;
  assert.strictEqual(wat.test_call_GetDCOrgEx(hdc, dcOrigin), 1);
  assert.deepStrictEqual([
    wat.guest_read32(dcOrigin) | 0,
    wat.guest_read32(dcOrigin + 4) | 0,
  ], [103, 55], 'client DC origin must be the client top-left in screen coordinates');
  assert.strictEqual(wat.test_call_GetDCOrgEx(hdc, 0), 0,
    'GetDCOrgEx must reject a null output pointer');
  assert.strictEqual(wat.test_call_GetDCOrgEx(0x7FFFFFF0, dcOrigin), 0,
    'GetDCOrgEx must reject an unknown DC');
  const desc = 0x07EF1000;
  // First rect of the PAINT_SCRATCH ring (src/01-header.wat).
  const paintScratch = 0x00006E00;
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
  assert.deepStrictEqual(
    [...canvas.getContext('2d').getImageData(3, 5, 1, 1).data],
    [192, 192, 192, 255],
    'attached presentation must expose untouched canonical window pixels');

  const clipCopy = wat.test_gdi_rgn_alloc_rect(0, 0, 0, 0) >>> 0;
  assert.strictEqual(wat.test_gdi_dc_clip_get(hdc, clipCopy), 0,
    'GetDC system visibility must not appear as an application-selected clip');
  assert.strictEqual(wat.test_gdi_dc_clip_point_visible(hdc, 33, 21), 1);
  assert.strictEqual(wat.test_gdi_dc_clip_point_visible(hdc, 34, 21), 0,
    'effective visibility must still constrain raster queries to the client');
  const appClip = wat.test_gdi_rgn_alloc_rect(2, 2, 10, 10) >>> 0;
  assert.strictEqual(wat.test_gdi_dc_clip_select(hdc, appClip), 2);
  assert.strictEqual(wat.test_gdi_dc_clip_get(hdc, clipCopy), 1);
  assert.strictEqual(wat.test_gdi_dc_clip_point_visible(hdc, 9, 9), 1);
  assert.strictEqual(wat.test_gdi_dc_clip_point_visible(hdc, 10, 9), 0,
    'raster visibility must intersect app and system clips');
  assert.strictEqual(wat.test_gdi_dc_clip_clear(hdc), 1);
  assert.strictEqual(wat.test_gdi_dc_clip_get(hdc, clipCopy), 0);
  assert.strictEqual(wat.test_gdi_dc_clip_point_visible(hdc, 33, 21), 1,
    'clearing the app clip must retain USER visibility');

  // Tic Tac Drop covers its form with a toolbar, board, and status bar. The
  // visible-region loop used to close after its first child, so WS_CLIPCHILDREN
  // protected only the toolbar and a later parent erase wiped out the board.
  wat.wnd_table_set(SECOND_CHILD, 0);
  wat.ctrl_set_geom(SECOND_CHILD, 25, 2, 5, 5);
  wat.test_wnd_set_parent(SECOND_CHILD, HWND);
  wat.wnd_set_style_export(SECOND_CHILD, 0x50000000);
  wat.wnd_set_style_export(HWND, 0x12000000);
  wat.dc_apply_client_clip(hdc, HWND);
  assert.strictEqual(wat.test_gdi_dc_clip_point_visible(hdc, 8, 13), 0,
    'WS_CLIPCHILDREN must exclude the first visible child');
  assert.strictEqual(wat.test_gdi_dc_clip_point_visible(hdc, 26, 3), 0,
    'WS_CLIPCHILDREN must continue through later visible children');
  wat.dc_apply_client_erase_clip(hdc, HWND);
  assert.strictEqual(wat.test_gdi_dc_clip_point_visible(hdc, 8, 13), 0,
    'erase clipping must exclude the first visible child');
  assert.strictEqual(wat.test_gdi_dc_clip_point_visible(hdc, 26, 3), 0,
    'erase clipping must continue through later visible children');
  wat.wnd_set_style_export(HWND, 0x10000000);
  wat.wnd_set_style_export(SECOND_CHILD, 0x40000000);
  wat.dc_apply_client_clip(hdc, HWND);

  // SkiFree acquires and retains its drawing DC from WM_CREATE, before the
  // main window is shown. Its system clip must follow later visibility
  // changes without requiring the application to acquire another DC.
  wat.wnd_set_style_export(HWND, 0);
  assert.strictEqual(wat.test_gdi_dc_clip_point_visible(hdc, 0, 0), 0,
    'hiding a window must empty the system clip of a retained DC');
  wat.wnd_set_style_export(HWND, 0x10000000);
  assert.strictEqual(wat.test_gdi_dc_clip_point_visible(hdc, 0, 0), 1,
    'showing a window must restore the system clip of a retained DC');

  // Paint establishes its preview clip under MM_TEXT, then switches the same
  // DC to MM_ANISOTROPIC before drawing the page. The retained clip must stay
  // in device coordinates instead of being reinterpreted by the new mapping.
  assert.strictEqual(wat.test_gdi_dc_set_field(hdc, 56, 2, 0), 0);
  assert.strictEqual(wat.test_gdi_dc_set_field(hdc, 60, 1, 0), 0);
  assert.strictEqual(wat.test_gdi_dc_clip_intersect_rect(hdc, -1, -1, 20, 15), 2);
  assert.strictEqual(wat.test_gdi_dc_clip_get(hdc, clipCopy), 1);
  const clipBox = paintScratch;
  assert.strictEqual(wat.test_gdi_rgn_get_box(clipCopy, clipBox), 2);
  assert.deepStrictEqual([
    dv.getInt32(clipBox, true), dv.getInt32(clipBox + 4, true),
    dv.getInt32(clipBox + 8, true), dv.getInt32(clipBox + 12, true),
  ], [1, 0, 22, 16], 'IntersectClipRect must retain its mapped device bounds');
  assert.strictEqual(wat.test_gdi_dc_set_field(hdc, 48, 100, 0), 1);
  assert.strictEqual(wat.test_gdi_dc_set_field(hdc, 52, 100, 0), 1);
  assert.strictEqual(wat.test_gdi_dc_set_field(hdc, 64, 10, 0), 1);
  assert.strictEqual(wat.test_gdi_dc_set_field(hdc, 68, 10, 0), 1);
  assert.strictEqual(wat.test_call_SetPixel(hdc, 100, 50, 0x000000FF), 0x000000FF);
  assert.deepStrictEqual(
    [...canvas.getContext('2d').getImageData(15, 11, 1, 1).data.subarray(0, 3)],
    [255, 0, 0], 'later anisotropic drawing must test the retained device clip');
  assert.strictEqual(wat.test_gdi_dc_clip_clear(hdc), 1);
  assert.strictEqual(wat.test_call_SetMapMode(hdc, 1), 1);
  assert.strictEqual(wat.test_gdi_dc_set_field(hdc, 56, 0, 0), 2);
  assert.strictEqual(wat.test_gdi_dc_set_field(hdc, 60, 0, 0), 1);

  const edgeBrush = wat.test_call_CreateSolidBrush(0x00FF00FF) >>> 0;
  const oldBrush = wat.test_call_SelectObject(hdc, edgeBrush) >>> 0;
  wat.test_gdi_fast_reset();
  assert.strictEqual(wat.test_call_PatBlt(hdc, 33, 20, 4, 4, 0x00F00021), 1);
  assert(wat.test_gdi_fast_count(1) > 0,
    'client-edge PatBlt must enter the canonical 32-bpp bulk path');
  const edgePixels = canvas.getContext('2d').getImageData(36, 25, 2, 3).data;
  const edgeRgb = (x, y) => [...edgePixels.subarray((y * 2 + x) * 4, (y * 2 + x) * 4 + 3)];
  assert.deepStrictEqual(edgeRgb(0, 0), [255, 0, 255],
    'bulk drawing must apply the client origin');
  assert.deepStrictEqual(edgeRgb(0, 1), [255, 0, 255],
    'bulk drawing must include the last client row');
  assert.deepStrictEqual(edgeRgb(1, 0), [192, 192, 192],
    'bulk drawing must not overwrite the right nonclient border');
  assert.deepStrictEqual(edgeRgb(0, 2), [192, 192, 192],
    'bulk drawing must not overwrite the bottom nonclient border');
  assert.strictEqual(wat.test_call_SelectObject(hdc, oldBrush) >>> 0, edgeBrush);
  assert.strictEqual(wat.test_call_DeleteObject(edgeBrush), 1);

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
  assert.strictEqual(wat.test_call_GetDCOrgEx(sourceDc, dcOrigin), 1);
  assert.deepStrictEqual([
    wat.guest_read32(dcOrigin) | 0,
    wat.guest_read32(dcOrigin + 4) | 0,
  ], [0, 0], 'memory DC origin must remain device-local');
  assert.strictEqual(wat.test_call_SelectObject(sourceDc, sourceBitmap) >>> 0, 0x30007);
  assert.strictEqual(wat.test_call_SetPixel(sourceDc, 0, 0, 0x0000FF00), 0x0000FF00);
  assert.strictEqual(wat.test_call_BitBlt(hdc, 2, 2, 1, 1, sourceDc, 0, 0, 0x00CC0020), 1);
  assert.deepStrictEqual(
    [...canvas.getContext('2d').getImageData(5, 7, 1, 1).data.subarray(0, 3)],
    [0, 255, 0], 'BitBlt destination must map through the client DC origin');

  const text = wat.guest_alloc(2) >>> 0;
  wat.guest_write16(text, 0x58); // "X\0"
  const textPresentation = base.gdi.surfacePresentations.get(surfaceId);
  const rgbaRect = textPresentation.surface.rgbaRect.bind(textPresentation.surface);
  const destinationReads = [];
  // Warm the strike first. The FNT payload is a DIB-arena allocation installed
  // on first use, so a cold TextOut legitimately changes the allocator map; it
  // is a second draw touching that map that would mean corruption.
  assert.strictEqual(wat.test_call_TextOutA(hdc, 10, 10, text, 1), 1);
  const dibPageMapBeforeText = Buffer.from(
    new Uint8Array(memory.buffer, 0x07E10000, 0x4000));
  textPresentation.surface.rgbaRect = (...args) => {
    destinationReads.push(args);
    return rgbaRect(...args);
  };
  assert.strictEqual(wat.test_call_TextOutA(hdc, 10, 10, text, 1), 1);
  textPresentation.surface.rgbaRect = rgbaRect;
  assert.strictEqual(destinationReads.length, 0,
    'TextOut must not read its destination presentation or canonical surface');
  assert.deepStrictEqual(
    Buffer.from(new Uint8Array(memory.buffer, 0x07E10000, 0x4000)),
    dibPageMapBeforeText, 'text composition must not corrupt DIB allocator metadata');
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

  const grandchildDc = wat.test_call_GetDC(GRANDCHILD) >>> 0;
  assert(grandchildDc, 'nested child GetDC must allocate a canonical window DC');
  assert.strictEqual(wat.test_gdi_dc_clip_point_visible(grandchildDc, 4, 1), 1);
  assert.strictEqual(wat.test_gdi_dc_clip_point_visible(grandchildDc, 5, 1), 0,
    'nested visibility must clip through the immediate parent client');
  assert.strictEqual(wat.test_gdi_dc_clip_point_visible(grandchildDc, 4, 2), 0,
    'nested visibility must also clip through the top-level client');
  const beforeHiddenText = Buffer.from(canvas.toBuffer('raw'));
  wat.wnd_set_style_export(CHILD, 0x40000000);
  wat.dc_apply_client_clip(grandchildDc, GRANDCHILD);
  assert.strictEqual(wat.test_gdi_dc_clip_point_visible(grandchildDc, 0, 0), 0,
    'a hidden ancestor must produce an empty USER visible region');
  assert.strictEqual(wat.test_call_TextOutA(grandchildDc, 0, 0, text, 1), 1);
  assert.deepStrictEqual(Buffer.from(canvas.toBuffer('raw')), beforeHiddenText,
    'WAT text composition must consume the same empty effective device clip');
  wat.wnd_set_style_export(CHILD, 0x50000000);
  assert.strictEqual(wat.test_call_ReleaseDC(GRANDCHILD, grandchildDc), 1);

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
  assert.strictEqual(wat.test_call_GetDCOrgEx(whole, dcOrigin), 1);
  assert.deepStrictEqual([
    wat.guest_read32(dcOrigin) | 0,
    wat.guest_read32(dcOrigin + 4) | 0,
  ], [100, 50], 'whole-window DC origin must be the window top-left in screen coordinates');
  assert.strictEqual(wat.test_gdi_surface_descriptor(whole, desc), 1);
  assert.deepStrictEqual([
    dv.getInt32(desc + 72, true), dv.getInt32(desc + 76, true),
  ], [0, 0], 'whole-window DC origin must be the window top-left');

  {
    const makeDragDib = (width, height) => {
      const dragBmi = wat.guest_alloc(40) >>> 0;
      const dragBitsOut = wat.guest_alloc(4) >>> 0;
      const imageBase = wat.get_image_base() >>> 0;
      const dragBmiWa = 0x12000 + (dragBmi - imageBase);
      const dragBitsOutWa = 0x12000 + (dragBitsOut - imageBase);
      new Uint8Array(memory.buffer).fill(0, dragBmiWa, dragBmiWa + 40);
      new Uint8Array(memory.buffer).fill(0, dragBitsOutWa, dragBitsOutWa + 4);
      wat.guest_write32(dragBmi, 40);
      wat.guest_write32(dragBmi + 4, width);
      wat.guest_write32(dragBmi + 8, -height);
      wat.guest_write16(dragBmi + 12, 1);
      wat.guest_write16(dragBmi + 14, 32);
      const bitmap = wat.test_call_CreateDIBSection(0, dragBmi, dragBitsOut) >>> 0;
      const dc = wat.test_call_CreateCompatibleDC(0) >>> 0;
      assert(bitmap && dc,
        `drag scratch DIB/DC allocation failed (bitmap=0x${bitmap.toString(16)}, dc=0x${dc.toString(16)})`);
      assert.strictEqual(wat.test_call_SelectObject(dc, bitmap) >>> 0, 0x30007);
      return { bitmap, dc, width, height };
    };
    const sprite = makeDragDib(7, 6);
    let oldBackground = makeDragDib(7, 6);
    let newBackground = makeDragDib(7, 6);
    const stretchedBackground = makeDragDib(14, 12);
    for (let y = 0; y < 22; y++) {
      for (let x = 0; x < 34; x++) {
        assert.notStrictEqual(wat.test_call_SetPixel(
          hdc, x, y, 0x00004000 + ((x * 3 + y * 5) & 0x3F)), -1);
      }
    }
    for (let y = 0; y < sprite.height; y++) {
      for (let x = 0; x < sprite.width; x++) {
        assert.notStrictEqual(wat.test_call_SetPixel(
          sprite.dc, x, y, 0x00000080 + y * 0x100 + x), -1);
      }
    }
    const origin = { x: 2, y: 10 };
    assert.strictEqual(wat.test_call_BitBlt(
      oldBackground.dc, 0, 0, 7, 6, hdc, origin.x, origin.y, 0x00CC0020), 1);
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 7; x++) {
        assert.strictEqual(wat.test_call_GetPixel(oldBackground.dc, x, y) >>> 0,
          0x00004000 + (((origin.x + x) * 3 + (origin.y + y) * 5) & 0x3F),
          'BitBlt must map a window source through its client-surface origin');
      }
    }
    assert.strictEqual(wat.test_call_StretchBlt(
      stretchedBackground.dc, 0, 0, 14, 12,
      hdc, origin.x, origin.y, 7, 6, 0x00CC0020), 1);
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 14; x++) {
        assert.strictEqual(wat.test_call_GetPixel(stretchedBackground.dc, x, y) >>> 0,
          0x00004000 + (((origin.x + (x >> 1)) * 3 +
            (origin.y + (y >> 1)) * 5) & 0x3F),
          'StretchBlt must map a window source through its client-surface origin');
      }
    }
    assert.strictEqual(wat.test_call_BitBlt(
      hdc, origin.x, origin.y, 7, 6, sprite.dc, 0, 0, 0x00CC0020), 1);
    const expected = Array.from({ length: 34 * 22 }, (_, i) =>
      wat.test_call_GetPixel(hdc, i % 34, (i / 34) | 0) >>> 0);

    let old = origin;
    for (const next of [
      { x: 15, y: 10 },
      { x: 11, y: 9 },
      { x: 7, y: 10 },
      { x: 3, y: 10 },
    ]) {
      assert.strictEqual(wat.test_call_BitBlt(
        newBackground.dc, 0, 0, 7, 6, hdc, next.x, next.y, 0x00CC0020), 1);
      assert.strictEqual(wat.test_call_BitBlt(
        newBackground.dc, old.x - next.x, old.y - next.y,
        7, 6, oldBackground.dc, 0, 0, 0x00CC0020), 1);
      assert.strictEqual(wat.test_call_BitBlt(
        oldBackground.dc, next.x - old.x, next.y - old.y,
        7, 6, sprite.dc, 0, 0, 0x00CC0020), 1);
      assert.strictEqual(wat.test_call_BitBlt(
        hdc, next.x, next.y, 7, 6, sprite.dc, 0, 0, 0x00CC0020), 1);
      assert.strictEqual(wat.test_call_BitBlt(
        hdc, old.x, old.y, 7, 6, oldBackground.dc, 0, 0, 0x00CC0020), 1);
      [oldBackground, newBackground] = [newBackground, oldBackground];
      old = next;
    }
    assert.strictEqual(wat.test_call_BitBlt(
      hdc, old.x, old.y, 7, 6, oldBackground.dc, 0, 0, 0x00CC0020), 1);
    assert.strictEqual(wat.test_call_BitBlt(
      hdc, origin.x, origin.y, 7, 6, sprite.dc, 0, 0, 0x00CC0020), 1);
    const actual = Array.from({ length: 34 * 22 }, (_, i) =>
      wat.test_call_GetPixel(hdc, i % 34, (i / 34) | 0) >>> 0);
    const mismatches = actual.reduce((count, value, index) =>
      count + (value !== expected[index] ? 1 : 0), 0);
    assert.strictEqual(mismatches, 0,
      'retained window blits must restore overlapping drag buffers without trails');
    for (const dib of [sprite, oldBackground, newBackground, stretchedBackground]) {
      assert.strictEqual(wat.test_call_DeleteDC(dib.dc), 1);
      assert.strictEqual(wat.test_call_DeleteObject(dib.bitmap), 1);
    }
  }

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

  wat.guest_write32(rect, 1);
  wat.guest_write32(rect + 4, 1);
  wat.guest_write32(rect + 8, 5);
  wat.guest_write32(rect + 12, 4);
  assert.strictEqual(wat.test_call_FillRect(hdc, rect, redBrush), 1);
  assert.strictEqual(wat.test_gdi_scroll_window(HWND, 2, 0, 0, 0), 1);
  assert.deepStrictEqual(
    [...canvas.getContext('2d').getImageData(6, 6, 1, 1).data.subarray(0, 3)],
    [255, 0, 0], 'ScrollWindow must move canonical client pixels by the requested delta');
  assert.deepStrictEqual(
    [...canvas.getContext('2d').getImageData(4, 6, 1, 1).data.subarray(0, 3)],
    [255, 255, 255], 'ScrollWindow must expose the vacated client strip');

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
