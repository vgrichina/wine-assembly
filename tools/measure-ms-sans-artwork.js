#!/usr/bin/env node

'use strict';

const fs = require('fs');
const { PNG } = require('pngjs');

const requests = [
  12, 13, 15, 16, 17,
  18, 20, 21, 22, 23,
  24, 25, 26, 30, 31,
  35, 36, 38, 39, 48,
];

function usage() {
  console.error('usage: node tools/measure-ms-sans-artwork.js LABEL=IMAGE.png [...]');
  process.exit(2);
}

function readInput(argument) {
  const separator = argument.indexOf('=');
  if (separator < 1) usage();
  const label = argument.slice(0, separator);
  const filename = argument.slice(separator + 1);
  const png = PNG.sync.read(fs.readFileSync(filename));
  if (png.width !== 640 || png.height !== 480) {
    throw new Error(`${filename}: expected 640x480, got ${png.width}x${png.height}`);
  }
  return { label, png };
}

function measure(png, index) {
  const column = index % 5;
  const row = Math.floor(index / 5);
  const originX = column * 128 + 5;
  const originY = 62 + row * 110;
  const left = column * 128 + 1;
  const right = (column + 1) * 128 - 1;
  const bottom = 40 + (row + 1) * 110 - 1;
  let minX = right;
  let minY = bottom;
  let maxX = left - 1;
  let maxY = originY - 1;
  let ink = 0;

  for (let y = originY; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const offset = (y * png.width + x) * 4;
      if (png.data[offset] >= 64 || png.data[offset + 1] >= 64 ||
          png.data[offset + 2] >= 64 || png.data[offset + 3] < 128) continue;
      ink++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!ink) return { width: 0, height: 0, dx: 0, dy: 0, ink: 0 };
  return {
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    dx: minX - originX,
    dy: minY - originY,
    ink,
  };
}

if (process.argv.length < 3) usage();
const inputs = process.argv.slice(2).map(readInput);
console.log(['request', ...inputs.flatMap(input => [
  `${input.label}_bbox`, `${input.label}_offset`, `${input.label}_ink`,
])].join('\t'));
for (let index = 0; index < requests.length; index++) {
  const columns = [`-${requests[index]}`];
  for (const input of inputs) {
    const result = measure(input.png, index);
    columns.push(`${result.width}x${result.height}`,
      `${result.dx},${result.dy}`, String(result.ink));
  }
  console.log(columns.join('\t'));
}
