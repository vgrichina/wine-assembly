#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const harness = await bootRenderHarness({
    extraWat: `
      (func (export "test_public_char_widths")
            (param i32 i32 i32 i32 i32) (result i32)
        (call $gdi_font_char_widths
          (local.get 0) (local.get 1) (local.get 2)
          (call $g2w (local.get 3)) (local.get 4)))
      (func (export "test_public_character_placement_w")
            (param i32 i32 i32 i32 i32 i32) (result i32)
        (call $gdi_character_placement_w
          (local.get 0) (call $g2w (local.get 1)) (local.get 2)
          (local.get 3) (call $g2w (local.get 4)) (local.get 5)))
      (func (export "test_public_call_CreateDIBPatternBrush")
            (param i32 i32) (result i32)
        (local $saved i32)
        (local.set $saved (global.get $esp))
        (call $handle_CreateDIBPatternBrush
          (local.get 0) (local.get 1) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0))
        (global.set $esp (local.get $saved))
        (global.get $eax))
      (func (export "test_public_call_CreateDiscardableBitmap")
            (param i32 i32 i32) (result i32)
        (local $saved i32)
        (local.set $saved (global.get $esp))
        (call $handle_CreateDiscardableBitmap
          (local.get 0) (local.get 1) (local.get 2) (i32.const 0)
          (i32.const 0) (i32.const 0))
        (global.set $esp (local.get $saved))
        (global.get $eax))
      (func (export "test_public_call_GetCharWidth32A")
            (param i32 i32 i32 i32) (result i32)
        (local $saved i32)
        (local.set $saved (global.get $esp))
        (call $handle_GetCharWidth32A
          (local.get 0) (local.get 1) (local.get 2) (local.get 3)
          (i32.const 0) (i32.const 0))
        (global.set $esp (local.get $saved))
        (global.get $eax))
      (func (export "test_public_call_GetCharWidth32W")
            (param i32 i32 i32 i32) (result i32)
        (local $saved i32)
        (local.set $saved (global.get $esp))
        (call $handle_GetCharWidth32W
          (local.get 0) (local.get 1) (local.get 2) (local.get 3)
          (i32.const 0) (i32.const 0))
        (global.set $esp (local.get $saved))
        (global.get $eax))
      (func (export "test_public_call_GetCharacterPlacementW")
            (param i32 i32 i32 i32 i32 i32) (result i32)
        (local $saved i32)
        (local.set $saved (global.get $esp))
        (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (local.get 5))
        (call $handle_GetCharacterPlacementW
          (local.get 0) (local.get 1) (local.get 2) (local.get 3)
          (local.get 4) (i32.const 0))
        (global.set $esp (local.get $saved))
        (global.get $eax))
      (func (export "test_public_call_InvertRgn")
            (param i32 i32) (result i32)
        (local $saved i32)
        (local.set $saved (global.get $esp))
        (call $handle_InvertRgn
          (local.get 0) (local.get 1) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0))
        (global.set $esp (local.get $saved))
        (global.get $eax))
      (func (export "test_public_call_PolyPolyline")
            (param i32 i32 i32 i32) (result i32)
        (local $saved i32)
        (local.set $saved (global.get $esp))
        (call $handle_PolyPolyline
          (local.get 0) (local.get 1) (local.get 2) (local.get 3)
          (i32.const 0) (i32.const 0))
        (global.set $esp (local.get $saved))
        (global.get $eax))
    `,
  });
  const { exports: wat, memory, hostCtx } = harness;
  const bytes = new Uint8Array(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;
  const allocZero = size => {
    const pointer = wat.guest_alloc(size) >>> 0;
    bytes.fill(0, wa(pointer), wa(pointer) + size);
    return pointer;
  };
  const writeWide = value => {
    const pointer = allocZero((value.length + 1) * 2);
    [...value].forEach((character, index) =>
      wat.guest_write16(pointer + index * 2, character.charCodeAt(0)));
    return pointer;
  };
  const createDc = () => {
    const bmi = allocZero(40);
    wat.guest_write32(bmi, 40);
    wat.guest_write32(bmi + 4, 64);
    wat.guest_write32(bmi + 8, -32);
    wat.guest_write16(bmi + 12, 1);
    wat.guest_write16(bmi + 14, 32);
    const bitsOut = allocZero(4);
    const bitmap = wat.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    assert(bitmap && hdc);
    wat.test_call_SelectObject(hdc, bitmap);
    return hdc;
  };
  const createSurface = (width, height) => {
    const bmi = allocZero(40);
    wat.guest_write32(bmi, 40);
    wat.guest_write32(bmi + 4, width);
    wat.guest_write32(bmi + 8, -height);
    wat.guest_write16(bmi + 12, 1);
    wat.guest_write16(bmi + 14, 32);
    const bitsOut = allocZero(4);
    const bitmap = wat.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
    const surfaceHdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    assert(bitmap && surfaceHdc);
    wat.test_call_SelectObject(surfaceHdc, bitmap);
    return { hdc: surfaceHdc, bitmap, bits: wat.guest_read32(bitsOut) >>> 0, width, height };
  };
  const fillSurface = (surface, color) => {
    for (let index = 0; index < surface.width * surface.height; index++) {
      wat.guest_write32(surface.bits + index * 4, color);
    }
  };
  const pixel = (surface, x, y) =>
    wat.guest_read32(surface.bits + (y * surface.width + x) * 4) & 0x00ffffff;
  const makeResults = capacity => {
    const results = allocZero(36);
    const outString = allocZero(capacity * 2);
    const order = allocZero(capacity * 4);
    const dx = allocZero(capacity * 4);
    const caret = allocZero(capacity * 4);
    const classes = allocZero(capacity);
    const glyphs = allocZero(capacity * 2);
    wat.guest_write32(results, 36);
    [outString, order, dx, caret, classes, glyphs].forEach((pointer, index) =>
      wat.guest_write32(results + 4 + index * 4, pointer));
    wat.guest_write32(results + 28, capacity);
    return { results, outString, order, dx, caret, classes, glyphs };
  };

  const root = path.join(__dirname, '..');
  hostCtx.vfs.dirs.add('c:\\windows');
  hostCtx.vfs.dirs.add('c:\\windows\\fonts');
  for (const name of ['System.fon', 'MSSansSerif.fon']) {
    hostCtx.vfs.files.set(`c:\\windows\\fonts\\${name.toLowerCase()}`, {
      data: new Uint8Array(fs.readFileSync(path.join(root, 'fonts', name))),
      attrs: 0x20,
    });
  }

  const hdc = createDc();
  const widths = allocZero(12);
  assert.strictEqual(wat.test_public_char_widths(hdc, 65, 67, widths, 0), 1);
  const bitmapWidths = [0, 1, 2].map(index => wat.guest_read32(widths + index * 4));
  assert(bitmapWidths.every(width => width > 0));
  assert.strictEqual(wat.test_public_call_GetCharWidth32A(hdc, 65, 67, widths), 1);
  assert.deepStrictEqual([0, 1, 2].map(index => wat.guest_read32(widths + index * 4)),
    bitmapWidths);
  assert.strictEqual(wat.test_public_call_GetCharWidth32W(hdc, 65, 67, widths), 1);
  assert.deepStrictEqual([0, 1, 2].map(index => wat.guest_read32(widths + index * 4)),
    bitmapWidths);

  const text = writeWide('ABC');
  const placement = makeResults(3);
  const packed = wat.test_public_character_placement_w(
    hdc, text, 3, 1000, placement.results, 0) >>> 0;
  assert.strictEqual(packed & 0xffff, bitmapWidths.reduce((sum, width) => sum + width, 0));
  assert((packed >>> 16) > 0);
  assert.deepStrictEqual([0, 1, 2].map(index =>
    wat.guest_read32(placement.order + index * 4)), [0, 1, 2]);
  assert.deepStrictEqual([0, 1, 2].map(index =>
    wat.guest_read32(placement.dx + index * 4)), bitmapWidths);
  assert.deepStrictEqual([0, 1, 2].map(index =>
    wat.guest_read32(placement.caret + index * 4)),
  [0, bitmapWidths[0], bitmapWidths[0] + bitmapWidths[1]]);
  assert.deepStrictEqual([...bytes.slice(wa(placement.classes), wa(placement.classes) + 3)],
    [1, 1, 1]);
  assert.deepStrictEqual([0, 1, 2].map(index =>
    wat.guest_read32(placement.outString + index * 2) & 0xffff), [65, 66, 67]);
  assert.deepStrictEqual([0, 1, 2].map(index =>
    wat.guest_read32(placement.glyphs + index * 2) & 0xffff), [65, 66, 67]);
  assert.strictEqual(wat.guest_read32(placement.results + 28), 3);
  assert.strictEqual(wat.guest_read32(placement.results + 32), 3);
  const publicPlacement = makeResults(3);
  assert.strictEqual(wat.test_public_call_GetCharacterPlacementW(
    hdc, text, 3, 1000, publicPlacement.results, 0) >>> 0, packed);
  assert.strictEqual(wat.guest_read32(publicPlacement.results + 28), 3);

  const limited = makeResults(3);
  const twoWidth = bitmapWidths[0] + bitmapWidths[1];
  const limitedPacked = wat.test_public_character_placement_w(
    hdc, text, 3, twoWidth, limited.results, 0x00100000) >>> 0;
  assert.strictEqual(limitedPacked & 0xffff, twoWidth);
  assert.strictEqual(wat.guest_read32(limited.results + 28), 2);
  assert.strictEqual(wat.guest_read32(limited.results + 32), 2);

  const justified = makeResults(3);
  const justifiedWidth = bitmapWidths.reduce((sum, width) => sum + width, 0) + 5;
  const justifiedPacked = wat.test_public_character_placement_w(
    hdc, text, 3, justifiedWidth, justified.results, 0x00110000) >>> 0;
  assert.strictEqual(justifiedPacked & 0xffff, justifiedWidth);
  assert.strictEqual([0, 1, 2].reduce((sum, index) =>
    sum + wat.guest_read32(justified.dx + index * 4), 0), justifiedWidth);

  const arial = writeWide('Arial');
  const scalable = wat.test_call_CreateFontW(-14, 400, 0, arial) >>> 0;
  assert(scalable);
  wat.test_call_SelectObject(hdc, scalable);
  assert.strictEqual(wat.test_public_char_widths(hdc, 65, 67, widths, 1), 1);
  const scalableWidths = [0, 1, 2].map(index => wat.guest_read32(widths + index * 4));
  // Arial is rasterized from its vendored substitute, so pin the shape of the
  // answer rather than the exact advances of one font version: three positive
  // whole-pixel widths, with 'C' at least as wide as 'A' in any roman face.
  assert(scalableWidths.every(width => width > 0), `scalable widths: ${scalableWidths}`);
  assert(scalableWidths[2] >= scalableWidths[0], `scalable widths: ${scalableWidths}`);
  const scalablePlacement = makeResults(3);
  const scalablePacked = wat.test_public_character_placement_w(
    hdc, text, 3, 1000, scalablePlacement.results, 0) >>> 0;
  assert.strictEqual(scalablePacked & 0xffff,
    [0, 1, 2].reduce((sum, index) =>
      sum + wat.guest_read32(scalablePlacement.dx + index * 4), 0),
    'placement extent must be the sum of the advances it reported');
  assert((scalablePacked >>> 16) > 0, 'placement should report a cell height');

  const bitmapInfo = allocZero(24);
  const discardable = wat.test_public_call_CreateDiscardableBitmap(hdc, 3, 2) >>> 0;
  assert(discardable);
  assert.strictEqual(wat.test_call_GetObjectA(discardable, 24, bitmapInfo), 24);
  assert.strictEqual(wat.guest_read32(bitmapInfo + 4), 3);
  assert.strictEqual(wat.guest_read32(bitmapInfo + 8), 2);
  assert.strictEqual(wat.guest_read32(bitmapInfo + 12), 12);
  assert.strictEqual(wat.guest_read32(bitmapInfo + 16) & 0xffff, 1);
  assert.strictEqual(wat.guest_read32(bitmapInfo + 16) >>> 16, 32);
  assert.strictEqual(wat.guest_read32(bitmapInfo + 20), 0);

  const packedDib = allocZero(56);
  wat.guest_write32(packedDib, 40);
  wat.guest_write32(packedDib + 4, 2);
  wat.guest_write32(packedDib + 8, -2);
  wat.guest_write16(packedDib + 12, 1);
  wat.guest_write16(packedDib + 14, 8);
  wat.guest_write32(packedDib + 32, 2);
  bytes.set([0x00, 0x00, 0xff, 0, 0xff, 0x00, 0x00, 0], wa(packedDib) + 40);
  bytes.set([0, 1, 0, 0, 1, 0, 0, 0], wa(packedDib) + 48);
  const pattern = wat.test_public_call_CreateDIBPatternBrush(packedDib, 0) >>> 0;
  assert(pattern);
  const patternSurface = createSurface(2, 2);
  wat.test_call_SelectObject(patternSurface.hdc, pattern);
  assert.strictEqual(wat.test_call_PatBlt(
    patternSurface.hdc, 0, 0, 2, 2, 0x00f00021), 1);
  assert.deepStrictEqual([
    pixel(patternSurface, 0, 0), pixel(patternSurface, 1, 0),
    pixel(patternSurface, 0, 1), pixel(patternSurface, 1, 1),
  ], [0xff0000, 0x0000ff, 0x0000ff, 0xff0000]);

  const invertSurface = createSurface(8, 8);
  fillSurface(invertSurface, 0x00112233);
  const region = wat.test_call_CreateRectRgn(1, 1, 4, 3) >>> 0;
  assert(region);
  assert.strictEqual(wat.test_public_call_InvertRgn(invertSurface.hdc, region), 1);
  assert.strictEqual(pixel(invertSurface, 0, 0), 0x112233);
  assert.strictEqual(pixel(invertSurface, 1, 1), 0xeeddcc);
  assert.strictEqual(pixel(invertSurface, 3, 2), 0xeeddcc);
  assert.strictEqual(pixel(invertSurface, 4, 2), 0x112233);
  assert.strictEqual(wat.test_public_call_InvertRgn(invertSurface.hdc, region), 1);
  assert.strictEqual(pixel(invertSurface, 2, 2), 0x112233);

  const polySurface = createSurface(8, 8);
  fillSurface(polySurface, 0x00ffffff);
  const points = allocZero(5 * 8);
  [[1, 1], [5, 1], [5, 3], [1, 5], [5, 5]].forEach(([x, y], index) => {
    wat.guest_write32(points + index * 8, x);
    wat.guest_write32(points + index * 8 + 4, y);
  });
  const counts = allocZero(8);
  wat.guest_write32(counts, 3);
  wat.guest_write32(counts + 4, 2);
  assert.strictEqual(wat.test_public_call_PolyPolyline(polySurface.hdc, points, counts, 2), 1);
  assert.strictEqual(pixel(polySurface, 2, 1), 0);
  assert.strictEqual(pixel(polySurface, 5, 2), 0);
  assert.strictEqual(pixel(polySurface, 2, 5), 0);
  assert.strictEqual(pixel(polySurface, 3, 4), 0x00ffffff,
    'independent polylines must not gain a connecting segment');

  const rejected = createSurface(8, 8);
  fillSurface(rejected, 0x00ffffff);
  wat.guest_write32(counts, 2);
  wat.guest_write32(counts + 4, 1);
  assert.strictEqual(wat.test_public_call_PolyPolyline(rejected.hdc, points, counts, 2), 0);
  for (let y = 0; y < rejected.height; y++) {
    for (let x = 0; x < rejected.width; x++) {
      assert.strictEqual(pixel(rejected, x, y), 0x00ffffff,
        'failed PolyPolyline must be atomic');
    }
  }

  console.log('PASS  seven new public GDI handlers and FNT-aware font paths');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
