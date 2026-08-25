#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: wat, memory, renderer, canvas, gdi } = await bootRenderHarness({
    width: 96,
    height: 64,
    extraWat: `
      (func (export "test_gdi_dc_binding") (param $hdc i32) (result i32)
        (local $dc i32)
        (local.set $dc (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
        (if (i32.eqz (local.get $dc)) (then (return (i32.const 0))))
        (i32.load offset=92 (local.get $dc)))
      (func (export "test_is_pinball_compat") (result i32)
        (call $compat_is_pinball_exe))
      (func (export "test_set_main_hwnd") (param $hwnd i32)
        (global.set $main_hwnd (local.get $hwnd)))
      (func (export "test_clear_screen_rect")
            (param $x i32) (param $y i32) (param $w i32) (param $h i32)
        (call $gdi_screen_surface_clear_rect
          (local.get $x) (local.get $y) (local.get $w) (local.get $h)))
    `,
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

  const outside = bits + (2 * 96 + 2) * 4;
  new DataView(memory.buffer).setUint32(outside, 0x00FF0000, true);
  wat.test_clear_screen_rect(4, 3, 2, 2);
  assert.deepStrictEqual([
    new Uint8Array(memory.buffer)[bits + (3 * 96 + 4) * 4],
    new Uint8Array(memory.buffer)[bits + (3 * 96 + 4) * 4 + 1],
    new Uint8Array(memory.buffer)[bits + (3 * 96 + 4) * 4 + 2],
  ], [128, 128, 0], 'destroyed popup bounds must return to COLOR_DESKTOP');
  assert.strictEqual(new DataView(memory.buffer).getUint32(outside, true), 0x00FF0000,
    'clearing exposed popup bounds must preserve the rest of the desktop');
  renderer.repaint();
  assert.deepStrictEqual(
    [...canvas.getContext('2d').getImageData(4, 3, 1, 1).data.subarray(0, 3)],
    [0, 128, 128], 'renderer must receive the cleared screen rectangle');

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

  const mainHwnd = 0x10001;
  renderer.createWindow(mainHwnd, 0x10000000, 0, 0, 96, 64, 'Pinball', 0);
  wat.wnd_table_set(mainHwnd, 0);
  wat.ctrl_set_geom(mainHwnd, 0, 0, 96, 64);
  wat.test_set_main_hwnd(mainHwnd);

  const exeName = 0x400;
  new Uint8Array(memory.buffer).set(Buffer.from('pinball.exe\0', 'ascii'), exeName);
  wat.set_exe_name(exeName, 11);
  assert.strictEqual(wat.test_is_pinball_compat(), 1,
    'Pinball executable identity must select its desktop compatibility path');
  const pinballDesktop = wat.test_call_GetDC(0x10000) >>> 0;
  assert(pinballDesktop, 'Pinball must receive its compatibility desktop HDC');
  assert.strictEqual(wat.test_gdi_dc_binding(pinballDesktop) >>> 0, mainHwnd,
    'Pinball desktop DC must bind to its composited main-window surface');
  assert.strictEqual(wat.test_gdi_surface_descriptor(pinballDesktop, desc), 1);
  assert.strictEqual(wat.test_call_ReleaseDC(0x10000, pinballDesktop), 1);

  console.log('Canonical WAT screen surface: PASS');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
