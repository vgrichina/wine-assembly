#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_gdip_prepare")
    (global.set $image_base (i32.const 0))
    (global.set $heap_base (i32.const 0x00100000))
    (global.set $heap_ptr (i32.const 0x00100000))
    (global.set $free_list (i32.const 0)))
  (func (export "test_GdiplusStartup") (param $token i32) (result i32)
    (local $esp i32) (local.set $esp (global.get $esp))
    (call $handle_GdiplusStartup (local.get $token) (i32.const 0x21000)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $esp)) (global.get $eax))
  (func (export "test_GdipLoadImageFromFile") (param $out i32) (result i32)
    (local $esp i32) (local.set $esp (global.get $esp))
    (call $handle_GdipLoadImageFromFile (i32.const 0x22000) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $esp)) (global.get $eax))
  (func (export "test_GdipGetImageWidth") (param $image i32) (param $out i32) (result i32)
    (local $esp i32) (local.set $esp (global.get $esp))
    (call $handle_GdipGetImageWidth (local.get $image) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $esp)) (global.get $eax))
  (func (export "test_GdipGetImageHeight") (param $image i32) (param $out i32) (result i32)
    (local $esp i32) (local.set $esp (global.get $esp))
    (call $handle_GdipGetImageHeight (local.get $image) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $esp)) (global.get $eax))
  (func (export "test_GdipCreateBitmapFromGraphics")
      (param $width i32) (param $height i32) (param $out i32) (result i32)
    (local $esp i32) (local.set $esp (global.get $esp))
    (call $handle_GdipCreateBitmapFromGraphics (local.get $width) (local.get $height)
      (i32.const 0x1234) (local.get $out) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $esp)) (global.get $eax))
  (func (export "test_GdipDisposeImage") (param $image i32) (result i32)
    (local $esp i32) (local.set $esp (global.get $esp))
    (call $handle_GdipDisposeImage (local.get $image)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $esp)) (global.get $eax))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });
  e.test_gdip_prepare();

  const tokenOut = 0x20000;
  const imageOut = 0x20004;
  const widthOut = 0x20008;
  const heightOut = 0x2000c;
  const bitmapOut = 0x20010;

  assert.strictEqual(e.test_GdiplusStartup(tokenOut), 0, 'startup returns Ok');
  assert.strictEqual(e.guest_read32(tokenOut), 1, 'startup publishes a stable token');
  assert.strictEqual(e.test_GdiplusStartup(0), 2, 'missing token output is InvalidParameter');

  assert.strictEqual(e.test_GdipLoadImageFromFile(imageOut), 0, 'image load returns Ok');
  const image = e.guest_read32(imageOut) >>> 0;
  assert.notStrictEqual(image, 0, 'image load publishes an opaque image');
  assert.strictEqual(e.test_GdipGetImageWidth(image, widthOut), 0);
  assert.strictEqual(e.test_GdipGetImageHeight(image, heightOut), 0);
  assert.strictEqual(e.guest_read32(widthOut), 1, 'placeholder width is deterministic');
  assert.strictEqual(e.guest_read32(heightOut), 1, 'placeholder height is deterministic');

  assert.strictEqual(e.test_GdipCreateBitmapFromGraphics(320, 200, bitmapOut), 0);
  const bitmap = e.guest_read32(bitmapOut) >>> 0;
  assert.notStrictEqual(bitmap, 0, 'bitmap creation publishes an opaque image');
  assert.strictEqual(e.test_GdipGetImageWidth(bitmap, widthOut), 0);
  assert.strictEqual(e.test_GdipGetImageHeight(bitmap, heightOut), 0);
  assert.strictEqual(e.guest_read32(widthOut), 320, 'created bitmap preserves width');
  assert.strictEqual(e.guest_read32(heightOut), 200, 'created bitmap preserves height');

  assert.strictEqual(e.test_GdipDisposeImage(image), 0);
  assert.strictEqual(e.test_GdipDisposeImage(bitmap), 0);
  console.log('PASS GDI+ flat API publishes coherent opaque image objects');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
