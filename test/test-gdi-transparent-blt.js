#!/usr/bin/env node
// Direct host-GDI regression for TransparentBlt-style color-key copies.
//
// ToolbarWindow32 uses this for app bitmap-strip tiles: keyed pixels must leave
// the destination button face intact while non-key icon pixels copy opaquely.

const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');

try {
  require('skia-canvas');
} catch (_) {
  console.log('SKIP  gdi transparent blt test requires skia-canvas');
  process.exit(0);
}

const memory = new ArrayBuffer(64 * 1024);
const mem = new Uint8Array(memory);
const srcBits = 0x1000;
const dstBits = 0x1100;
const width = 3;
const height = 1;
const bpp = 24;
const rowBytes = Math.ceil((width * bpp) / 16) * 2;

function setBits(base, x, r, g, b) {
  const off = base + x * 3;
  mem[off] = b;
  mem[off + 1] = g;
  mem[off + 2] = r;
}

function pixelsOf(bitmap, w = width, h = height) {
  const data = bitmap.canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const out = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out.push([data[i], data[i + 1], data[i + 2], data[i + 3]]);
    }
  }
  return out;
}

// Source: red, transparent magenta, green.
setBits(srcBits, 0, 255, 0, 0);
setBits(srcBits, 1, 255, 0, 255);
setBits(srcBits, 2, 0, 255, 0);

// Destination: three distinct pixels, so the keyed middle pixel can be proven
// unchanged.
setBits(dstBits, 0, 10, 20, 30);
setBits(dstBits, 1, 40, 50, 60);
setBits(dstBits, 2, 70, 80, 90);

assert.strictEqual(rowBytes, 10, 'test assumes one padded 3px 24bpp row');

const { host, gdi } = createHostImports({
  getMemory: () => memory,
  exports: {},
});

const srcBitmap = host.gdi_create_bitmap(width, height, bpp, srcBits);
const dstBitmap = host.gdi_create_bitmap(width, height, bpp, dstBits);
const srcDC = host.gdi_create_compat_dc(0);
const dstDC = host.gdi_create_compat_dc(0);

host.gdi_select_object(srcDC, srcBitmap);
host.gdi_select_object(dstDC, dstBitmap);

const ok = host.gdi_transparent_blt(
  dstDC,
  0, 0,
  width, height,
  srcDC,
  0, 0,
  0x00FF00FF, // RGB(255,0,255) as COLORREF.
);

assert.strictEqual(ok, 1, 'transparent blit should succeed');
assert.deepStrictEqual(pixelsOf(gdi._gdiObjects[dstBitmap]), [
  [255, 0, 0, 255],
  [40, 50, 60, 255],
  [0, 255, 0, 255],
]);

console.log('PASS  TransparentBlt color key preserves destination pixels');

const disabledBitmap = host.gdi_create_compat_bitmap(0, 4, 2);
const disabledDC = host.gdi_create_compat_dc(0);
host.gdi_select_object(disabledDC, disabledBitmap);
const disabledCanvas = gdi._gdiObjects[disabledBitmap].canvas;
const disabledCtx = disabledCanvas.getContext('2d');
disabledCtx.fillStyle = 'rgb(192,192,192)';
disabledCtx.fillRect(0, 0, 4, 2);

assert.strictEqual(host.gdi_disabled_blt(
  disabledDC,
  0, 0,
  width, height,
  srcDC,
  0, 0,
  0x00FF00FF,
), 1, 'disabled blit should succeed');
assert.deepStrictEqual(pixelsOf(gdi._gdiObjects[disabledBitmap], 4, 2), [
  [128, 128, 128, 255], [192, 192, 192, 255],
  [128, 128, 128, 255], [192, 192, 192, 255],
  [192, 192, 192, 255], [255, 255, 255, 255],
  [192, 192, 192, 255], [255, 255, 255, 255],
]);

console.log('PASS  disabled blit embosses non-key mask pixels');
