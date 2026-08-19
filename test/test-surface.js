#!/usr/bin/env node
// lib/surface.js describes drawing in pixels instead of in canvas, so that the
// renderer can stop speaking CanvasRenderingContext2D and the browser's canvas
// becomes one implementation of the contract rather than the definition of it.
//
// Both implementations are exercised here against the same assertions. That is
// the point of the exercise: if RasterSurface and CanvasSurface disagree, a
// headless screenshot stops predicting what the browser draws, which is the
// exact failure that made this project adopt a native canvas in the first
// place (259623f: node-canvas had no Path2D, CLI clipping silently collapsed).
//
// CanvasSurface is tested by wrapping the canvas-shaped adapter in
// lib/raster-canvas.js, which is enough to prove the adapter drives a 2D
// context correctly without needing a browser here.

const assert = require('assert');
const { RasterSurface, CanvasSurface } = require('../lib/surface');
const { createCanvas } = require('../lib/raster-canvas');

function makeBoth(w, h) {
  return [
    ['RasterSurface', new RasterSurface(w, h)],
    ['CanvasSurface', new CanvasSurface(createCanvas(w, h))],
  ];
}

function at(surface, x, y) {
  const p = surface.readPixels(x, y, 1, 1);
  return [p.data[0], p.data[1], p.data[2], p.data[3]];
}

for (const [name, s] of makeBoth(32, 32)) {
  // Fill, in the colour formats the renderer's palette uses.
  s.fill(0, 0, 32, 32, '#008080');
  assert.deepStrictEqual(at(s, 16, 16), [0, 128, 128, 255], `${name}: hex fill`);
  s.fill(0, 0, 8, 8, 'rgb(255,0,0)');
  assert.deepStrictEqual(at(s, 2, 2), [255, 0, 0, 255], `${name}: rgb() fill`);
  assert.deepStrictEqual(at(s, 16, 16), [0, 128, 128, 255], `${name}: fill is bounded`);

  // Clip is rectangular and nests.
  s.pushClip({ x: 0, y: 0, w: 4, h: 4 });
  s.fill(0, 0, 32, 32, '#00ff00');
  s.popClip();
  assert.deepStrictEqual(at(s, 1, 1), [0, 255, 0, 255], `${name}: inside clip paints`);
  assert.deepStrictEqual(at(s, 10, 10), [0, 128, 128, 255], `${name}: outside clip untouched`);

  // A band list clips to the region it covers.
  s.pushClip([{ x: 20, y: 20, w: 4, h: 4 }, { x: 24, y: 20, w: 4, h: 4 }]);
  s.fill(0, 0, 32, 32, '#ffffff');
  s.popClip();
  assert.deepStrictEqual(at(s, 25, 21), [255, 255, 255, 255], `${name}: band clip paints`);
  assert.deepStrictEqual(at(s, 30, 30), [0, 128, 128, 255], `${name}: band clip bounded`);

  // Clear punches a hole.
  s.clear(28, 0, 4, 4);
  assert.deepStrictEqual(at(s, 29, 1), [0, 0, 0, 0], `${name}: clear`);
}

// Blit, 1:1 and scaled, plus alpha compositing.
for (const [name, dst] of makeBoth(32, 32)) {
  const src = new RasterSurface(4, 4);
  src.fill(0, 0, 4, 4, '#123456');
  const srcForDst = dst.isRaster ? src : (() => {
    const c = createCanvas(4, 4);
    new CanvasSurface(c).fill(0, 0, 4, 4, '#123456');
    return { canvas: c, width: 4, height: 4, data: null };
  })();

  dst.fill(0, 0, 32, 32, '#000000');
  dst.blit(srcForDst, 0, 0, 4, 4, 5, 6, 4, 4);
  assert.deepStrictEqual(at(dst, 5, 6), [0x12, 0x34, 0x56, 255], `${name}: blit lands`);
  assert.deepStrictEqual(at(dst, 8, 9), [0x12, 0x34, 0x56, 255], `${name}: blit covers extent`);
  assert.deepStrictEqual(at(dst, 9, 10), [0, 0, 0, 255], `${name}: blit stops`);

  dst.blit(srcForDst, 0, 0, 4, 4, 16, 16, 16, 16);
  assert.deepStrictEqual(at(dst, 31, 31), [0x12, 0x34, 0x56, 255], `${name}: scaled blit`);
}

// Pixels in and out -- the path WAT's surface upload uses.
for (const [name, s] of makeBoth(16, 16)) {
  const px = s.createPixels(2, 2);
  for (let i = 0; i < 4; i++) {
    px.data[i * 4] = 10 + i; px.data[i * 4 + 1] = 20;
    px.data[i * 4 + 2] = 30; px.data[i * 4 + 3] = 255;
  }
  s.writePixels(px, 4, 4);
  assert.deepStrictEqual(at(s, 4, 4), [10, 20, 30, 255], `${name}: writePixels`);
  assert.deepStrictEqual(at(s, 5, 5), [13, 20, 30, 255], `${name}: writePixels block`);

  const back = s.readPixels(4, 4, 2, 2);
  assert.strictEqual(back.width, 2, `${name}: readPixels width`);
  assert.strictEqual(back.data[0], 10, `${name}: readPixels round-trip`);
}

// The drag marquee has to be visible over any background.
for (const [name, s] of makeBoth(16, 16)) {
  s.fill(0, 0, 16, 16, '#000000');
  s.invert(0, 0, 8, 8);
  assert.deepStrictEqual(at(s, 2, 2), [255, 255, 255, 255], `${name}: invert flips black to white`);
  s.invert(0, 0, 8, 8);
  assert.deepStrictEqual(at(s, 2, 2), [0, 0, 0, 255], `${name}: invert is its own inverse`);
}

// Stroked outlines, solid and dashed.
{
  const s = new RasterSurface(16, 16);
  s.frame(0, 0, 16, 16, '#ff0000', 1);
  assert.deepStrictEqual(at(s, 0, 0), [255, 0, 0, 255], 'frame draws the border');
  assert.deepStrictEqual(at(s, 8, 8), [0, 0, 0, 0], 'frame leaves the interior alone');

  const d = new RasterSurface(16, 16);
  d.frame(0, 0, 16, 16, '#ff0000', 1, 2);
  const lit = at(d, 0, 0)[3] === 255;
  const gap = at(d, 2, 0)[3] === 0;
  assert.ok(lit && gap, 'dashed frame alternates');
}

// Wallpaper tiling.
{
  const tileSrc = new RasterSurface(2, 2);
  tileSrc.fill(0, 0, 2, 2, '#abcdef');
  const s = new RasterSurface(16, 16);
  s.tile(tileSrc, 0, 0, 16, 16);
  assert.deepStrictEqual(at(s, 15, 15), [0xab, 0xcd, 0xef, 255], 'tile repeats to fill');
}

// PNG encode.
{
  const s = new RasterSurface(6, 6);
  s.fill(0, 0, 6, 6, '#c0c0c0');
  const buf = s.toPNG();
  assert.ok(buf && buf.length > 8 && buf[1] === 0x50 && buf[2] === 0x4e, 'toPNG emits a PNG');
}

console.log('PASS  RasterSurface and CanvasSurface agree on fills, clips and blits');
console.log('PASS  pixels, invert, frames, tiling and PNG encode behave');
