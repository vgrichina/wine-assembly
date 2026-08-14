#!/usr/bin/env node
'use strict';

// The persistent screen DC is also the renderer's canonical desktop surface.
// Its untouched pixels must start at COLOR_DESKTOP rather than inheriting a
// white compatibility-bitmap fill.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_alloc_screen_dc") (result i32)
    (call $host_alloc_screen_dc))
  (func (export "test_alloc_printer_dc") (result i32)
    (call $gdi_printer_dc_alloc))
  (func (export "test_screen_bitmap") (result i32)
    (global.get $gdi_screen_bitmap))
  (func (export "test_printer_bitmap") (result i32)
    (global.get $printer_bitmap))
  (func (export "test_reset_thread_gdi_counters")
    ;; Model a newly instantiated worker: tables are shared, globals restart.
    (global.set $gdi_next_object_handle (i32.const 0x00410001))
    (global.set $gdi_next_dc_handle (i32.const 0x00310001)))
`;

(async () => {
  const { exports: e, renderer } = await bootRenderHarness({
    extraWat, width: 64, height: 48,
  });
  const screenDc = e.test_alloc_screen_dc() >>> 0;
  assert(screenDc, 'screen DC allocation should succeed');
  assert(renderer._desktopSurfaceCanvas, 'screen DC should attach a desktop surface');
  const desktop = renderer._desktopSurfaceCanvas;
  const screenBitmap = e.test_screen_bitmap() >>> 0;
  renderer.repaint();
  let pixel = Array.from(desktop.getContext('2d').getImageData(63, 47, 1, 1).data);
  assert.deepStrictEqual(pixel, [0, 128, 128, 255],
    'untouched canonical desktop pixel should be Win98 teal');

  e.test_reset_thread_gdi_counters();
  const printerDc = e.test_alloc_printer_dc() >>> 0;
  const printerBitmap = e.test_printer_bitmap() >>> 0;
  assert(printerDc && printerDc !== screenDc,
    'a worker-style stale DC counter must skip the active screen DC handle');
  assert(printerBitmap && printerBitmap !== screenBitmap,
    'a worker-style stale object counter must skip the active screen bitmap handle');

  const secondScreenDc = e.test_alloc_screen_dc() >>> 0;
  assert(secondScreenDc && secondScreenDc !== screenDc && secondScreenDc !== printerDc,
    'a later screen acquisition must receive another live DC handle');
  renderer.repaint();
  assert.strictEqual(renderer._desktopSurfaceCanvas, desktop,
    'allocating a worker printer page must not replace the attached desktop surface');
  assert.deepStrictEqual([desktop.width, desktop.height], [64, 48],
    'desktop surface dimensions must remain the screen dimensions');
  pixel = Array.from(desktop.getContext('2d').getImageData(63, 47, 1, 1).data);
  assert.deepStrictEqual(pixel, [0, 128, 128, 255],
    'worker printer allocation must leave the desktop teal');
  console.log('PASS  canonical desktop survives stale worker GDI counters');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
