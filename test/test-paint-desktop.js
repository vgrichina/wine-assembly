#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_alloc_screen_dc") (result i32)
    (call $host_alloc_screen_dc))
  (func (export "test_paint_desktop") (param $hdc i32) (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_PaintDesktop
      (local.get $hdc) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

(async () => {
  const { exports: wat, memory } = await bootRenderHarness({
    extraWat, width: 64, height: 48,
  });
  const hdc = wat.test_alloc_screen_dc() >>> 0;
  const desc = 0x07EF1000;
  assert(hdc, 'screen DC allocation should succeed');
  assert.strictEqual(wat.test_gdi_surface_descriptor(hdc, desc), 1);
  assert.strictEqual(wat.test_call_SetPixel(hdc, 63, 47, 0x000000ff) >>> 0,
    0x000000ff, 'the test pixel should start non-desktop red');

  const result = wat.test_paint_desktop(hdc);
  assert.strictEqual(Number(result & 0xffffffffn), 1,
    'PaintDesktop should report a successful GDI fill');
  assert.strictEqual(Number(result >> 32n), 0x00300008,
    'PaintDesktop pops its one stdcall argument and return address');
  assert.strictEqual(wat.test_gdi_raster_get_pixel(desc, 63, 47) >>> 0,
    0x00808000, 'PaintDesktop should cover the full HDC with Win98 teal');

  const dv = new DataView(memory.buffer);
  assert.deepStrictEqual([
    dv.getInt32(desc + 4, true), dv.getInt32(desc + 8, true),
  ], [64, 48], 'the paint target should retain the actual screen geometry');
  console.log('PASS  PaintDesktop fills the Win98 desktop surface and returns BOOL');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
