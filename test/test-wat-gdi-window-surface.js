#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('../lib/canvas-compat');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const HWND = 0x10001;

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
  const renderer = {
    windows: { [HWND]: win },
    wasm: { exports: null },
    getWindowCanvas: hwnd => hwnd === HWND ? { canvas, ctx: canvas.getContext('2d') } : null,
    scheduleRepaint: () => { repaints++; },
    invalidate: () => {},
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

  wat.wnd_table_set(HWND, 0);
  wat.ctrl_set_geom(HWND, 100, 50, 40, 30);
  wat.test_gdi_client_rect_set(HWND, 3, 5, 37, 27);

  const hdc = wat.test_call_GetDC(HWND) >>> 0;
  assert(hdc, 'GetDC must allocate a real window DC');
  const desc = 0x07EF1000;
  assert.strictEqual(wat.test_gdi_surface_descriptor(hdc, desc), 1);
  const dv = new DataView(memory.buffer);
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
  canvas = createCanvas(52, 36);
  wat.ctrl_set_geom(HWND, 100, 50, 52, 36);
  wat.test_gdi_client_rect_set(HWND, 3, 5, 49, 33);
  assert.strictEqual(wat.test_gdi_surface_descriptor(hdc, desc), 1);
  assert.deepStrictEqual([
    dv.getInt32(desc + 4, true), dv.getInt32(desc + 8, true),
  ], [52, 36], 'descriptor lookup must recreate canonical backing after resize');
  assert.strictEqual(base.gdi.surfacePresentations.get(surfaceId).canvas, canvas,
    'resized canonical surface must attach to the renderer replacement canvas');

  assert.strictEqual(wat.test_call_ReleaseDC(HWND, hdc), 1);
  assert.strictEqual(wat.test_call_ReleaseDC(HWND, whole), 1);
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
