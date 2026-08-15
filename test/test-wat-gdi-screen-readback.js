#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('../lib/canvas-compat');
const { createHostImports } = require('../lib/host-imports');
const { Win98Renderer } = require('../lib/renderer');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const RED = 0x000000ff;
const BLUE = 0x00ff0000;
const GREEN = 0x0000ff00;
const MAGENTA = 0x00ff00ff;
const WHITE = 0x00ffffff;
const DESKTOP = 0x00808000;
const SRCCOPY = 0x00cc0020;

async function instantiate(wasm, renderer) {
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
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
  ctx.exports = instance.exports;
  return { instance, memory, base };
}

function installWindow(app, renderer, hwnd, x, y, width, height, zOrder) {
  const wat = app.instance.exports;
  renderer.windows[hwnd] = {
    hwnd, x, y, w: width, h: height, zOrder,
    style: 0x10000000, visible: true, isChild: false,
    clientRect: { x, y, w: width, h: height },
    wasm: app.instance, wasmMemory: app.memory,
  };
  wat.wnd_table_set(hwnd, 0);
  wat.ctrl_set_geom(hwnd, x, y, width, height);
  wat.wnd_set_style_export(hwnd, 0x10000000);
  wat.test_gdi_client_rect_set(hwnd, 0, 0, width, height);
  const hdc = wat.test_call_GetWindowDC(hwnd) >>> 0;
  assert(hdc, 'window DC must allocate');
  return hdc;
}

function fill(wat, hdc, width, height, color) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      assert.notStrictEqual(wat.test_call_SetPixel(hdc, x, y, color) | 0, -1);
    }
  }
}

async function main() {
  const wasm = await compileWat(file =>
    fs.promises.readFile(path.join(ROOT, 'src', file), 'utf8'));
  const renderer = new Win98Renderer(createCanvas(32, 24));
  const appA = await instantiate(wasm, renderer);
  const appB = await instantiate(wasm, renderer);
  const hwndA = 0x10001;
  const hwndB = 0x20001;
  const dcA = installWindow(appA, renderer, hwndA, 4, 3, 12, 9, 1);
  const dcB = installWindow(appB, renderer, hwndB, 8, 6, 10, 8, 2);
  fill(appA.instance.exports, dcA, 12, 9, RED);
  fill(appB.instance.exports, dcB, 10, 8, BLUE);

  const wat = appA.instance.exports;
  const screen = wat.test_call_GetDC(0) >>> 0;
  assert(screen, 'screen DC must allocate canonical WAT storage');
  const forbidCanvasReadback = canvas => {
    const context = canvas && canvas.getContext && canvas.getContext('2d');
    if (context) context.getImageData = () => { throw new Error('Canvas readback is forbidden'); };
  };
  forbidCanvasReadback(renderer.canvas);
  forbidCanvasReadback(renderer.windows[hwndA]._backCanvas);
  forbidCanvasReadback(renderer.windows[hwndB]._backCanvas);
  forbidCanvasReadback(renderer._desktopSurfaceCanvas);
  assert.strictEqual(wat.test_call_GetPixel(screen, 1, 1) >>> 0, DESKTOP,
    'screen readback must preserve the desktop background');
  assert.strictEqual(wat.test_call_GetPixel(screen, 5, 4) >>> 0, RED,
    'screen readback must copy the lower cross-instance window');
  assert.strictEqual(wat.test_call_GetPixel(screen, 9, 7) >>> 0, BLUE,
    'screen readback must respect global z-order');

  renderer.windows[hwndB].region = { rects: [{ x: 0, y: 0, w: 4, h: 4 }] };
  assert.strictEqual(wat.test_call_GetPixel(screen, 9, 7) >>> 0, BLUE,
    'window regions must retain pixels inside their visible bands');
  assert.strictEqual(wat.test_call_GetPixel(screen, 14, 7) >>> 0, RED,
    'window regions must expose lower windows outside their visible bands');
  renderer.windows[hwndB].region = null;

  renderer.windows[hwndB].x = 20;
  renderer.windows[hwndB].y = 12;
  appB.instance.exports.ctrl_set_geom(hwndB, 20, 12, 10, 8);
  assert.strictEqual(wat.test_call_GetPixel(screen, 9, 7) >>> 0, RED,
    'layout changes must invalidate the composed screen snapshot');
  assert.strictEqual(wat.test_call_GetPixel(screen, 21, 13) >>> 0, BLUE,
    'the recomposed snapshot must use the new window position');

  const dxBits = 0x00060000;
  const dxPalette = 0x00060100;
  const appBBytes = new Uint8Array(appB.memory.buffer);
  appBBytes.set([1, 1, 0, 0, 1, 1, 0, 0], dxBits);
  appBBytes.set([0, 0, 0, 0, 255, 0, 255, 0], dxPalette);
  const dxId = 0x00200123;
  assert.strictEqual(appB.base.host.gdi_surface_create(
    dxId, 2, 2, 8, dxBits, 4, 1, dxPalette, 2, 0, 0, 0), 1);
  const dxPresentation = appB.base.gdi.surfacePresentations.get(dxId);
  renderer.windows[hwndB]._dxFrameLayer = { canvas: dxPresentation.canvas };
  forbidCanvasReadback(dxPresentation.canvas);
  assert.strictEqual(wat.test_call_GetPixel(screen, 20, 12) >>> 0, MAGENTA,
    'indexed DirectDraw layers must decode from source WASM bytes and palettes');

  assert.notStrictEqual(wat.test_call_SetPixel(dcA, 1, 1, GREEN) | 0, -1);
  assert.strictEqual(wat.test_call_GetPixel(screen, 5, 4) >>> 0, GREEN,
    'a canonical surface upload must invalidate the cached screen snapshot');

  assert.notStrictEqual(wat.test_call_SetPixel(screen, 2, 2, WHITE) | 0, -1);
  assert.strictEqual(wat.test_call_GetPixel(screen, 2, 2) >>> 0, WHITE,
    'direct screen writes must survive reads while the global scene is unchanged');

  const memoryDc = wat.test_call_CreateCompatibleDC(screen) >>> 0;
  const bitmap = wat.test_call_CreateCompatibleBitmap(screen, 4, 3) >>> 0;
  assert(memoryDc && bitmap);
  wat.test_call_SelectObject(memoryDc, bitmap);
  assert.strictEqual(
    wat.test_call_BitBlt(memoryDc, 0, 0, 4, 3, screen, 4, 3, SRCCOPY), 1,
    'BitBlt from a screen DC must synchronize the same canonical snapshot');
  assert.strictEqual(wat.test_call_GetPixel(memoryDc, 1, 1) >>> 0, GREEN);

  console.log('PASS  screen GetPixel composes cross-instance WAT surfaces in z-order');
  console.log('PASS  window movement invalidates the direct-memory screen snapshot');
  console.log('PASS  regions, surface dirties, and direct screen writes retain Win32 ordering');
  console.log('PASS  indexed DirectDraw capture decodes canonical bytes without Canvas');
  console.log('PASS  screen-to-memory BitBlt reads the canonical WAT snapshot');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
