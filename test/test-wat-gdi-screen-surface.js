#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: wat, memory, renderer, canvas, gdi } = await bootRenderHarness({
    width: 96,
    height: 64,
  });
  const dv = new DataView(memory.buffer);
  const desc = 0x07EF1000;
  const hdc = wat.test_call_GetDC(0) >>> 0;

  assert(hdc, 'GetDC(NULL) must allocate a screen HDC');
  assert.strictEqual(wat.test_gdi_surface_descriptor(hdc, desc), 1);
  assert.deepStrictEqual([
    dv.getInt32(desc + 4, true), dv.getInt32(desc + 8, true),
    dv.getInt32(desc + 16, true), dv.getInt32(desc + 72, true),
    dv.getInt32(desc + 76, true),
  ], [96, 64, 32, 0, 0]);
  const screenBitmap = dv.getUint32(desc + 68, true);
  const bits = dv.getUint32(desc, true);
  assert(screenBitmap && bits && gdi.surfacePresentations.has(screenBitmap));
  assert.strictEqual(renderer._desktopSurfaceCanvas,
    gdi.surfacePresentations.get(screenBitmap).canvas,
    'the desktop must display the canonical screen bitmap presentation');

  assert.strictEqual(wat.test_call_SetPixel(hdc, 4, 3, 0x000000FF), 0x000000FF);
  assert.deepStrictEqual([
    new Uint8Array(memory.buffer)[bits + (3 * 96 + 4) * 4],
    new Uint8Array(memory.buffer)[bits + (3 * 96 + 4) * 4 + 1],
    new Uint8Array(memory.buffer)[bits + (3 * 96 + 4) * 4 + 2],
  ], [0, 0, 255], 'screen GDI must write WAT memory');
  renderer.repaint();
  assert.deepStrictEqual(
    [...canvas.getContext('2d').getImageData(4, 3, 1, 1).data.subarray(0, 3)],
    [255, 0, 0], 'renderer must composite the screen presentation');

  const presentation = gdi.surfacePresentations.get(screenBitmap);
  presentation.canvas.getContext('2d').fillStyle = '#ff00ff';
  presentation.canvas.getContext('2d').fillRect(4, 3, 1, 1);
  assert.strictEqual(wat.test_call_ReleaseDC(0, hdc), 1);
  assert.deepStrictEqual([
    new Uint8Array(memory.buffer)[bits + (3 * 96 + 4) * 4],
    new Uint8Array(memory.buffer)[bits + (3 * 96 + 4) * 4 + 1],
    new Uint8Array(memory.buffer)[bits + (3 * 96 + 4) * 4 + 2],
  ], [0, 0, 255], 'ReleaseDC must not read the desktop presentation back');

  const second = wat.test_call_GetDC(0) >>> 0;
  assert(second && second !== hdc);
  assert.strictEqual(wat.test_gdi_surface_descriptor(second, desc), 1);
  assert.strictEqual(dv.getUint32(desc + 68, true), screenBitmap,
    'screen DC acquisitions must share one persistent WAT bitmap');
  assert.strictEqual(wat.test_call_ReleaseDC(0, second), 1);

  const desktop = wat.test_call_GetDC(0x10000) >>> 0;
  assert(desktop, 'GetDC(GetDesktopWindow()) must allocate a screen HDC');
  assert.strictEqual(wat.test_gdi_surface_descriptor(desktop, desc), 1);
  assert.strictEqual(dv.getUint32(desc + 68, true), screenBitmap,
    'the desktop pseudo HWND must share the persistent screen bitmap');
  assert.strictEqual(wat.test_call_ReleaseDC(0x10000, desktop), 1);

  console.log('Canonical WAT screen surface: PASS');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
