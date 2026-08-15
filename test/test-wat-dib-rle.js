#!/usr/bin/env node

'use strict';

// CreateDIBitmap with BI_RLE8 / BI_RLE4 source data.
//
// The WAT bitmap path has decoded RLE for RT_BITMAP resources all along, but
// $gdi_bitmap_plan_info — the CreateDIBitmap entry — accepted only BI_RGB and
// BI_BITFIELDS, so an app handing it a compressed DIB got NULL back. Four Plus!
// 98 screensavers store their sprite sheets as BI_RLE8 and drew nothing at all
// because of it: SelectObject(hdc, NULL) then failed and the whole mask-blit
// block was skipped.
//
// RLE scanlines are enumerated from the bottom, which is also row zero of a
// bottom-up DIB allocation, so the first encoded row lands at storage offset 0.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const BI_RGB = 0;
const BI_RLE8 = 1;
const BI_RLE4 = 2;
const CBM_INIT = 4;
const DIB_RGB_COLORS = 0;

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`  ok  ${label}`);
}

(async () => {
  const harness = await bootRenderHarness();
  const wat = harness.exports;
  const bytes = new Uint8Array(harness.memory.buffer);

  const allocated = [];
  const alloc = size => {
    const p = wat.guest_alloc(size) >>> 0;
    allocated.push(p);
    return p;
  };
  const writeBytes = list => {
    const p = alloc(list.length);
    list.forEach((b, i) => wat.guest_write8(p + i, b));
    return p;
  };
  // BITMAPINFOHEADER followed by a palette of `colors` RGBQUADs.
  const bitmapInfo = ({ width, height, bpp, compression, sizeImage, colors = 256 }) => {
    const p = alloc(40 + colors * 4);
    for (let i = 0; i < 40 + colors * 4; i++) wat.guest_write8(p + i, 0);
    wat.guest_write32(p + 0, 40);
    wat.guest_write32(p + 4, width);
    wat.guest_write32(p + 8, height);
    wat.guest_write32(p + 12, 1 | (bpp << 16));   // biPlanes | biBitCount
    wat.guest_write32(p + 16, compression);
    wat.guest_write32(p + 20, sizeImage);
    wat.guest_write32(p + 32, colors);            // biClrUsed
    wat.guest_write32(p + 36, colors);            // biClrImportant
    // A recognisable palette so a decoded index maps to a distinct colour.
    for (let i = 0; i < colors; i++) {
      wat.guest_write32(p + 40 + i * 4, (i * 0x010101) >>> 0);
    }
    return p;
  };
  const storageBytes = (handle, count) => {
    const base = wat.test_gdi_bitmap_storage(handle) >>> 0;
    assert(base, 'a created bitmap should have backing storage');
    return Array.from(bytes.subarray(base, base + count));
  };

  // 4x2 at 8bpp. Encoded rows run bottom-up: row 0 is four of index 1, row 1
  // is two of index 2 then two of index 3.
  const rle8 = [
    0x04, 0x01,   // 4 x index 1
    0x00, 0x00,   // end of line
    0x02, 0x02,   // 2 x index 2
    0x02, 0x03,   // 2 x index 3
    0x00, 0x01,   // end of bitmap
  ];

  check('CreateDIBitmap accepts a BI_RLE8 DIB', () => {
    const info = bitmapInfo({ width: 4, height: 2, bpp: 8, compression: BI_RLE8, sizeImage: rle8.length });
    const bits = writeBytes(rle8);
    const h = wat.test_call_CreateDIBitmap(0, info, CBM_INIT, bits, info, DIB_RGB_COLORS) >>> 0;
    assert(h, 'BI_RLE8 must not be rejected — this is the screensaver regression');
  });

  check('the RLE8 stream decodes to the right indices', () => {
    const info = bitmapInfo({ width: 4, height: 2, bpp: 8, compression: BI_RLE8, sizeImage: rle8.length });
    const bits = writeBytes(rle8);
    const h = wat.test_call_CreateDIBitmap(0, info, CBM_INIT, bits, info, DIB_RGB_COLORS) >>> 0;
    // 8bpp width 4 rounds up to a 4-byte stride, so 8 bytes total.
    assert.deepStrictEqual(storageBytes(h, 8), [1, 1, 1, 1, 2, 2, 3, 3]);
  });

  check('absolute mode and a run mix within one row', () => {
    // Row 0: absolute run of 4 explicit indices; row 1: a 4-long run of 9.
    const stream = [
      0x00, 0x04, 0x05, 0x06, 0x07, 0x08,  // absolute, 4 bytes, already word-aligned
      0x00, 0x00,
      0x04, 0x09,
      0x00, 0x01,
    ];
    const info = bitmapInfo({ width: 4, height: 2, bpp: 8, compression: BI_RLE8, sizeImage: stream.length });
    const h = wat.test_call_CreateDIBitmap(0, info, CBM_INIT, writeBytes(stream), info, DIB_RGB_COLORS) >>> 0;
    assert(h, 'absolute mode should decode');
    assert.deepStrictEqual(storageBytes(h, 8), [5, 6, 7, 8, 9, 9, 9, 9]);
  });

  check('a delta command leaves the skipped pixels untouched', () => {
    // Row 0: one pixel of index 7, then delta right by 2 (leaving a gap), then
    // one pixel of index 8.
    const stream = [
      0x01, 0x07,
      0x00, 0x02, 0x02, 0x00,  // delta dx=2 dy=0
      0x01, 0x08,
      0x00, 0x01,
    ];
    const info = bitmapInfo({ width: 4, height: 1, bpp: 8, compression: BI_RLE8, sizeImage: stream.length });
    const h = wat.test_call_CreateDIBitmap(0, info, CBM_INIT, writeBytes(stream), info, DIB_RGB_COLORS) >>> 0;
    assert(h, 'delta should decode');
    assert.deepStrictEqual(storageBytes(h, 4), [7, 0, 0, 8]);
  });

  check('CreateDIBitmap accepts a BI_RLE4 DIB and packs two indices per byte', () => {
    // 4x2 at 4bpp. Each run byte carries two alternating 4-bit indices.
    const stream = [
      0x04, 0x12,   // 4 pixels: 1,2,1,2
      0x00, 0x00,
      0x04, 0x34,   // 4 pixels: 3,4,3,4
      0x00, 0x01,
    ];
    const info = bitmapInfo({ width: 4, height: 2, bpp: 4, compression: BI_RLE4, sizeImage: stream.length, colors: 16 });
    const h = wat.test_call_CreateDIBitmap(0, info, CBM_INIT, writeBytes(stream), info, DIB_RGB_COLORS) >>> 0;
    assert(h, 'BI_RLE4 must not be rejected');
    // 4bpp width 4 is 2 bytes of pixels, padded to a 4-byte stride.
    const s = storageBytes(h, 8);
    assert.deepStrictEqual([s[0], s[1]], [0x12, 0x12]);
    assert.deepStrictEqual([s[4], s[5]], [0x34, 0x34]);
  });

  check('an uncompressed DIB still works', () => {
    const info = bitmapInfo({ width: 4, height: 2, bpp: 8, compression: BI_RGB, sizeImage: 0 });
    const bits = writeBytes([1, 2, 3, 4, 5, 6, 7, 8]);
    const h = wat.test_call_CreateDIBitmap(0, info, CBM_INIT, bits, info, DIB_RGB_COLORS) >>> 0;
    assert(h, 'BI_RGB must keep working');
    assert.deepStrictEqual(storageBytes(h, 8), [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  check('a compressed DIB with no biSizeImage is refused, not read past', () => {
    // Nothing else bounds the stream here, so an unstated length has to fail.
    const info = bitmapInfo({ width: 4, height: 2, bpp: 8, compression: BI_RLE8, sizeImage: 0 });
    const h = wat.test_call_CreateDIBitmap(0, info, CBM_INIT, writeBytes(rle8), info, DIB_RGB_COLORS) >>> 0;
    assert.strictEqual(h, 0);
  });

  check('BI_RLE8 is refused at any depth other than 8bpp', () => {
    const info = bitmapInfo({ width: 4, height: 2, bpp: 4, compression: BI_RLE8, sizeImage: rle8.length, colors: 16 });
    assert.strictEqual(wat.test_call_CreateDIBitmap(0, info, CBM_INIT, writeBytes(rle8), info, DIB_RGB_COLORS) >>> 0, 0);
  });

  check('BI_RLE4 is refused at any depth other than 4bpp', () => {
    const info = bitmapInfo({ width: 4, height: 2, bpp: 8, compression: BI_RLE4, sizeImage: rle8.length });
    assert.strictEqual(wat.test_call_CreateDIBitmap(0, info, CBM_INIT, writeBytes(rle8), info, DIB_RGB_COLORS) >>> 0, 0);
  });

  check('a top-down compressed DIB is refused — Win32 does not define one', () => {
    const info = bitmapInfo({ width: 4, height: -2, bpp: 8, compression: BI_RLE8, sizeImage: rle8.length });
    assert.strictEqual(wat.test_call_CreateDIBitmap(0, info, CBM_INIT, writeBytes(rle8), info, DIB_RGB_COLORS) >>> 0, 0);
  });

  check('a truncated RLE stream fails instead of running off the end', () => {
    // biSizeImage claims the full stream but the terminator is missing.
    const truncated = [0x04, 0x01, 0x00, 0x00, 0x02, 0x02];
    const info = bitmapInfo({ width: 4, height: 2, bpp: 8, compression: BI_RLE8, sizeImage: truncated.length });
    const h = wat.test_call_CreateDIBitmap(0, info, CBM_INIT, writeBytes(truncated), info, DIB_RGB_COLORS) >>> 0;
    assert.strictEqual(h, 0);
  });

  for (const p of allocated) wat.guest_free(p);

  console.log(`\ntest-wat-dib-rle: ${passed}/${passed} passed`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
