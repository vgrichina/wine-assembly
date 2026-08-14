#!/usr/bin/env node

'use strict';

const fs = require('fs');

function fail(message) {
  console.error(`render-fon-benchmark: ${message}`);
  process.exit(2);
}

if (process.argv.length < 4) {
  fail('usage: node tools/render-fon-benchmark.js INPUT.fon OUTPUT.pgm [HEIGHT ...]');
}

const input = fs.readFileSync(process.argv[2]);
const output = process.argv[3];
const ne = input.readUInt32LE(0x3c);
if (input.readUInt16LE(ne) !== 0x454e) fail('input is not an NE FON');
const resources = ne + input.readUInt16LE(ne + 0x24);
const shift = input.readUInt16LE(resources);
const strikes = new Map();
let cursor = resources + 2;
for (;;) {
  const type = input.readUInt16LE(cursor) & 0x7fff;
  if (!type) break;
  const count = input.readUInt16LE(cursor + 2);
  cursor += 8;
  for (let index = 0; index < count; index++, cursor += 12) {
    if (type !== 8) continue;
    const offset = input.readUInt16LE(cursor) << shift;
    const height = input.readUInt16LE(offset + 88);
    strikes.set(height, {
      offset,
      height,
      first: input[offset + 95],
      last: input[offset + 96],
      width: input.readUInt16LE(offset + 86),
      averageWidth: input.readUInt16LE(offset + 91),
      maximumWidth: input.readUInt16LE(offset + 93),
    });
  }
}

const heights = process.argv.length > 4
  ? process.argv.slice(4).map(value => Number.parseInt(value, 10))
  : [16, 18, 21, 24, 32, 48, 64, 80];
if (heights.some(height => !Number.isInteger(height) || height < 1)) {
  fail('heights must be positive integers');
}
for (const height of heights) {
  if (!strikes.has(height)) fail(`missing ${height}px strike`);
}

const smallSample = 'AWMWVxyz09/\\<>';
const largeSample = 'AWVxy/\\';
const padding = 4;
const gap = 4;
const ascii = strikes.get(heights[0]);
const includeAscii = true;
const asciiColumns = 16;
const asciiRows = 6;
const asciiCellWidth = ascii.width || ascii.maximumWidth;
const asciiWidth = includeAscii ? asciiColumns * asciiCellWidth : 0;
const asciiHeight = includeAscii ? asciiRows * ascii.height : 0;
function glyphWidth(strike, code) {
  if (code < strike.first || code > strike.last) code = 63;
  return input.readUInt16LE(strike.offset + 148 + (code - strike.first) * 6);
}

function textWidth(strike, value) {
  let width = 0;
  for (const character of value) width += glyphWidth(strike, character.charCodeAt(0));
  return width;
}

const samples = heights.map(height => {
  const strike = strikes.get(height);
  const text = `${height} ${height <= 32 ? smallSample : largeSample}`;
  return { strike, text, width: textWidth(strike, text) };
});
const width = padding * 2 + Math.max(asciiWidth,
  ...samples.map(sample => sample.width));
const height = padding * 2 + asciiHeight + gap * (samples.length +
  (includeAscii ? 1 : 0)) +
  samples.reduce((sum, sample) => sum + sample.strike.height, 0);
const pixels = Buffer.alloc(width * height, 255);

function drawGlyph(strike, code, left, top) {
  if (code < strike.first || code > strike.last) code = 63;
  const entry = strike.offset + 148 + (code - strike.first) * 6;
  const glyphWidth = input.readUInt16LE(entry);
  const glyphOffset = strike.offset + input.readUInt32LE(entry + 2);
  for (let x = 0; x < glyphWidth; x++) {
    for (let y = 0; y < strike.height; y++) {
      const bit = input[glyphOffset + (x >> 3) * strike.height + y] &
        (0x80 >> (x & 7));
      if (bit) pixels[(top + y) * width + left + x] = 0;
    }
  }
  return glyphWidth;
}

function drawText(strike, text, left, top) {
  let cursor = left;
  for (let index = 0; index < text.length; index++) {
    cursor += drawGlyph(strike, text.charCodeAt(index), cursor, top);
  }
}

let top = padding;
if (includeAscii) {
  for (let code = 32; code <= 126; code++) {
    const index = code - 32;
    drawGlyph(ascii, code, padding + (index % asciiColumns) * asciiCellWidth,
      top + Math.floor(index / asciiColumns) * ascii.height);
  }
  top += asciiHeight + gap;
}
for (const sample of samples) {
  drawText(sample.strike, sample.text, padding, top);
  top += sample.strike.height + gap;
}

const header = Buffer.from(`P5\n${width} ${height}\n255\n`, 'ascii');
fs.writeFileSync(output, Buffer.concat([header, pixels]));
console.log(`wrote ${output} (${width}x${height}, source FNT pixels)`);
