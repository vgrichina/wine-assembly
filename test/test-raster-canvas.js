#!/usr/bin/env node
// Unit tests for lib/raster-canvas.js, the pure-JS surface the CLI presents
// through. It only has to do what the renderer measurably asks of it -- fill
// and blit rectangles, clip to rectangles, and move pixels in and out -- but it
// has to do those exactly, because every headless screenshot goes through it.

const assert = require('assert');
const { createCanvas, loadImage } = require('../lib/raster-canvas');

function px(canvas, x, y) {
  const d = canvas.getContext('2d').getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}

// fillRect paints, and honours the colour formats the renderer emits.
{
  const c = createCanvas(16, 16);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#008080';
  ctx.fillRect(0, 0, 16, 16);
  assert.deepStrictEqual(px(c, 8, 8), [0, 128, 128, 255], 'hex fill');
  ctx.fillStyle = 'rgb(255,0,0)';
  ctx.fillRect(0, 0, 4, 4);
  assert.deepStrictEqual(px(c, 1, 1), [255, 0, 0, 255], 'rgb() fill');
  assert.deepStrictEqual(px(c, 8, 8), [0, 128, 128, 255], 'fill is bounded');
}

// clip is rectangular and composes with save/restore.
{
  const c = createCanvas(16, 16);
  const ctx = c.getContext('2d');
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, 8, 8);
  ctx.clip();
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 16, 16);
  ctx.restore();
  assert.deepStrictEqual(px(c, 2, 2), [255, 0, 0, 255], 'inside clip is painted');
  assert.deepStrictEqual(px(c, 12, 12), [0, 0, 0, 0], 'outside clip is untouched');
  ctx.fillStyle = '#00ff00';
  ctx.fillRect(0, 0, 16, 16);
  assert.deepStrictEqual(px(c, 12, 12), [0, 255, 0, 255], 'restore drops the clip');
}

// The composite path: blit one canvas onto another, 1:1 and scaled.
{
  const src = createCanvas(4, 4);
  const sctx = src.getContext('2d');
  sctx.fillStyle = '#123456';
  sctx.fillRect(0, 0, 4, 4);

  const dst = createCanvas(16, 16);
  const dctx = dst.getContext('2d');
  dctx.drawImage(src, 2, 3);
  assert.deepStrictEqual(px(dst, 2, 3), [0x12, 0x34, 0x56, 255], 'blit lands at the offset');
  assert.deepStrictEqual(px(dst, 5, 6), [0x12, 0x34, 0x56, 255], 'blit covers the source extent');
  assert.deepStrictEqual(px(dst, 6, 7), [0, 0, 0, 0], 'blit stops at the source extent');

  const scaled = createCanvas(16, 16);
  scaled.getContext('2d').drawImage(src, 0, 0, 16, 16);
  assert.deepStrictEqual(px(scaled, 15, 15), [0x12, 0x34, 0x56, 255], 'scaled blit fills the target');
}

// Transparent source pixels must not erase what is under them.
{
  const src = createCanvas(4, 4);
  const dst = createCanvas(4, 4);
  const dctx = dst.getContext('2d');
  dctx.fillStyle = '#ffffff';
  dctx.fillRect(0, 0, 4, 4);
  dctx.drawImage(src, 0, 0);
  assert.deepStrictEqual(px(dst, 1, 1), [255, 255, 255, 255], 'fully transparent source is a no-op');
}

// get/putImageData round-trip, which is how WAT-rendered pixels arrive.
{
  const c = createCanvas(8, 8);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(2, 2);
  for (let i = 0; i < 4; i++) {
    img.data[i * 4] = 10 + i; img.data[i * 4 + 1] = 20; img.data[i * 4 + 2] = 30; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 3, 3);
  assert.deepStrictEqual(px(c, 3, 3), [10, 20, 30, 255], 'putImageData writes');
  assert.deepStrictEqual(px(c, 4, 4), [13, 20, 30, 255], 'putImageData writes the whole block');
  assert.deepStrictEqual(px(c, 0, 0), [0, 0, 0, 0], 'putImageData is bounded');
}

// Resizing reallocates and clears, like a real canvas. The screen surface is
// resized this way (test/run.js sets renderer.canvas.width), and getting it
// wrong is invisible until a window-resize test notices the surface never grew.
{
  const c = createCanvas(4, 4);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 4, 4);

  c.width = 20;
  c.height = 10;
  assert.strictEqual(c.width, 20, 'width takes the new value');
  assert.strictEqual(c.height, 10, 'height takes the new value');
  assert.deepStrictEqual(px(c, 1, 1), [0, 0, 0, 0], 'resize clears the surface');

  // The enlarged area must be real, addressable pixels.
  ctx.fillStyle = '#00ff00';
  ctx.fillRect(0, 0, 20, 10);
  assert.deepStrictEqual(px(c, 19, 9), [0, 255, 0, 255], 'the grown region is paintable');

  // Same-size assignment still resets, which is what canvas does.
  c.width = 20;
  assert.deepStrictEqual(px(c, 19, 9), [0, 0, 0, 0], 'assigning the same size clears too');

  // And a stale clip must not survive the resize.
  const c2 = createCanvas(4, 4);
  const x2 = c2.getContext('2d');
  x2.beginPath(); x2.rect(0, 0, 2, 2); x2.clip();
  c2.width = 8; c2.height = 8;
  x2.fillStyle = '#0000ff';
  x2.fillRect(0, 0, 8, 8);
  assert.deepStrictEqual(px(c2, 6, 6), [0, 0, 255, 255], 'resize drops the old clip');
}

// PNG encode, and decode back to the same pixels.
(async () => {
  const c = createCanvas(6, 6);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#c0c0c0';
  ctx.fillRect(0, 0, 6, 6);
  const buf = c.toBufferSync();
  assert.ok(buf.length > 8 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47, 'emits a PNG');

  const round = await loadImage(buf);
  assert.strictEqual(round.width, 6, 'decoded width');
  assert.strictEqual(round.height, 6, 'decoded height');
  const back = createCanvas(6, 6);
  back.getContext('2d').drawImage(round, 0, 0);
  assert.deepStrictEqual(px(back, 3, 3), [192, 192, 192, 255], 'round-trips through PNG');

  console.log('PASS  fills, clips, blits, scales and composites alpha');
  console.log('PASS  ImageData round-trips and PNG encode/decode agree');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
