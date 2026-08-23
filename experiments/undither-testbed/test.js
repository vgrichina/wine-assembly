#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { algorithmInfo, extractPalette, run } = require('./algorithms');

function fixture(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = pixel(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = color.length > 3 ? color[3] : 255;
    }
  }
  return { width, height, data };
}

function pixel(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return Array.from(image.data.slice(offset, offset + 4));
}

const redBlue = fixture(8, 8, (x, y) => (x + y) % 2 ? [255, 0, 0] : [0, 0, 255]);
const solid = fixture(8, 8, () => [32, 96, 160]);

assert.deepStrictEqual(run('original', redBlue, {}).data, redBlue.data,
  'original must be a byte-exact bypass');
assert.strictEqual(extractPalette(redBlue).colors.length, 2,
  'checker should expose two exact displayed colors');

for (const name of Object.keys(algorithmInfo)) {
  const output = run(name, redBlue, {
    radius: 2,
    strength: 1,
    threshold: 20,
    iterations: 3,
    matrixSize: 2,
  });
  assert.strictEqual(output.width, redBlue.width, `${name} width`);
  assert.strictEqual(output.height, redBlue.height, `${name} height`);
  assert.strictEqual(output.data.length, redBlue.data.length, `${name} RGBA length`);
  for (let i = 3; i < output.data.length; i += 4) {
    assert.strictEqual(output.data[i], 255, `${name} must preserve alpha`);
  }
}

const gaussian = run('gaussian', redBlue, { radius: 2, strength: 1 });
const gaussianCenter = pixel(gaussian, 4, 4);
assert(gaussianCenter[0] > 100 && gaussianCenter[2] > 100,
  `Gaussian should reconstruct an intermediate red/blue mixture: ${gaussianCenter}`);

const ordered = run('orderedCell', redBlue, {
  strength: 1,
  threshold: 20,
  matrixSize: 2,
});
const orderedA = pixel(ordered, 2, 2);
const orderedB = pixel(ordered, 3, 2);
assert.deepStrictEqual(orderedA, orderedB,
  'ordered-cell reconstruction should make a detected 2x2 cell uniform');
assert(orderedA[0] > 150 && orderedA[2] > 150,
  `ordered-cell reconstruction should mix in linear light: ${orderedA}`);

const paletteMixed = run('paletteMix', redBlue, {
  radius: 2,
  strength: 1,
  threshold: 20,
});
assert.notDeepStrictEqual(pixel(paletteMixed, 4, 4), pixel(redBlue, 4, 4),
  'palette-pair mixer should alter a confident alternating pair');

const kornelskiTwoColor = run('kornelski', redBlue, { strength: 1 });
assert.notDeepStrictEqual(pixel(kornelskiTwoColor, 4, 4), pixel(redBlue, 4, 4),
  'Kornelski prior art should smooth a two-color Floyd–Steinberg-like field');

const paletteEdge = fixture(16, 16, (x, y) => {
  if (x === 0 && y === 0) return [127, 0, 127];
  return (x + y) % 2 ? [255, 0, 0] : [0, 0, 255];
});
const kornelskiPaletteEdge = run('kornelski', paletteEdge, { strength: 1 });
assert.deepStrictEqual(pixel(kornelskiPaletteEdge, 8, 8), pixel(paletteEdge, 8, 8),
  'an existing palette color between a pair should make Kornelski preserve that pair as an edge');

const verticalLines = fixture(12, 8, x => x % 2 ? [230, 150, 40] : [40, 80, 180]);
const sgenpt = run('sgenpt', verticalLines, { strength: 1 });
assert.notDeepStrictEqual(pixel(sgenpt, 6, 4), pixel(verticalLines, 6, 4),
  'SGENPT prior art should blend horizontal alternation / vertical-line pseudo-transparency');

for (const name of Object.keys(algorithmInfo)) {
  const output = run(name, solid, {
    radius: 2,
    strength: 1,
    threshold: 20,
    iterations: 4,
    matrixSize: 2,
  });
  assert.deepStrictEqual(output.data, solid.data, `${name} should preserve a perfectly flat image exactly`);
}

assert.throws(() => run('not-an-algorithm', solid, {}), /Unknown algorithm/);
console.log(`PASS  ${Object.keys(algorithmInfo).length} undithering algorithms, palette extraction, exact bypass, alpha, and flat-field invariants`);
