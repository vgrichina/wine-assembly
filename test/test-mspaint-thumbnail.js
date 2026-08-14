#!/usr/bin/env node
'use strict';

// Paint's 400% thumbnail copies the document into a floating child DC from
// source (-3,-3). Win32 clips that source rectangle, leaving a three-pixel
// inset. Rejecting the first out-of-bitmap pixel leaves the preview solid gray.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..');
const RUN = path.join(ROOT, 'test', 'run.js');
const EXE = path.join(ROOT, 'test', 'binaries', 'mspaint.exe');
const SHOT = path.join(ROOT, 'scratch', 'mspaint_thumbnail.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(path.dirname(SHOT), { recursive: true });
try { fs.unlinkSync(SHOT); } catch (_) {}

const input = [
  '30:click:39:146',
  '38:mousedown:110:110',
  '39:mousemove:130:125',
  '40:mouseup:150:140',
  '55:wait-title-command:untitled_-_Paint:50:37671:zoom',
  '65:wait-title-command:untitled_-_Paint:50:37676:thumbnail',
  '82:dump-windows:thumbnail',
  `84:png:${SHOT}`,
  '85:stop',
].join(',');

let output = '';
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input}`,
    '--max-batches=90',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
} catch (error) {
  output = `${error.stdout || ''}${error.stderr || ''}`;
  assert.fail(`Paint thumbnail run failed:\n${output.slice(-4000)}`);
}

assert(fs.existsSync(SHOT) && fs.statSync(SHOT).size > 0,
  'Paint thumbnail screenshot was not written');
const windowLine = output.split('\n').find(line =>
  line.includes('window:thumbnail') && line.includes('title="Thumbnail"')) || '';
const geometry = windowLine.match(
  /pos=(-?\d+),(-?\d+) size=(\d+)x(\d+) client=\{"x":(-?\d+),"y":(-?\d+),"w":(\d+),"h":(\d+)\}/);
assert(geometry, `Paint Thumbnail window geometry was not reported:\n${windowLine}`);

const [, , , widthText, heightText, clientXText, clientYText, clientWText, clientHText] = geometry;
assert(Number(widthText) >= 100 && Number(heightText) >= 100,
  'Paint Thumbnail floating window has invalid dimensions');

const png = PNG.sync.read(fs.readFileSync(SHOT));
const clientX = Number(clientXText);
const clientY = Number(clientYText);
const clientW = Number(clientWText);
const clientH = Number(clientHText);
let white = 0;
let dark = 0;
for (let y = clientY; y < clientY + clientH; y++) {
  for (let x = clientX; x < clientX + clientW; x++) {
    const p = (y * png.width + x) * 4;
    const r = png.data[p], g = png.data[p + 1], b = png.data[p + 2];
    if (r >= 248 && g >= 248 && b >= 248) white++;
    if (r < 80 && g < 80 && b < 80) dark++;
  }
}

const clientPixels = clientW * clientH;
assert(white > clientPixels * 0.8,
  `Paint Thumbnail preview stayed gray (${white}/${clientPixels} white pixels)`);
assert(dark >= 15,
  `Paint Thumbnail did not reproduce the drawn line (${dark} dark pixels)`);
assert(!/UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH/.test(output),
  'Paint Thumbnail triggered an emulator failure');

console.log(`PASS  Paint Thumbnail previews the document (${white} white, ${dark} dark pixels)`);
