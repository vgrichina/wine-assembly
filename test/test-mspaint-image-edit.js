#!/usr/bin/env node

// End-to-end Paint image editing regression. This covers the native MFC undo
// stack around whole-image raster operations, not just the underlying GDI
// primitive: Invert -> Undo -> Repeat -> Clear -> Undo must preserve pixels.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'mspaint.exe');
const OUT = path.join(ROOT, 'scratch', 'mspaint-image-edit');
const shots = Object.fromEntries([
  'drawn', 'inverted', 'undone', 'repeated', 'cleared', 'clear-undone',
].map(name => [name, path.join(OUT, `${name}.png`)]));

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
for (const file of Object.values(shots)) {
  try { fs.unlinkSync(file); } catch (_) {}
}

const input = [
  '18:click:39:146',                     // Pencil
  '28:mousedown:120:140', '29:mousemove:150:160', '30:mouseup:190:190',
  `34:png:${shots.drawn}`,
  '36:0x111:37682',                      // Image > Invert Colors
  `40:png:${shots.inverted}`,
  '42:0x111:57643',                      // Edit > Undo
  `46:png:${shots.undone}`,
  '48:0x111:57644',                      // Edit > Repeat
  `52:png:${shots.repeated}`,
  '54:0x111:37684',                      // Image > Clear Image
  `58:png:${shots.cleared}`,
  '60:0x111:57643',                      // Undo Clear Image
  `64:png:${shots['clear-undone']}`,
  '65:stop',
].join(',');

let output = '';
let runFailed = false;
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input}`,
    '--max-batches=69',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
} catch (error) {
  runFailed = true;
  output = `${error.stdout || ''}${error.stderr || ''}`;
}

async function pixels(file) {
  const image = await loadImage(file);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return { width: image.width, height: image.height,
    data: ctx.getImageData(0, 0, image.width, image.height).data };
}

// The 320x240 document is wider than the initial view, so only part of it is
// on screen; exclude its sizing border and the gray workspace below from
// whole-image comparisons. Measured 2026-08-19: the visible image pixels are
// x=88..286 and y=69..308. They used to be x=83..291/y=64..303, and moved
// because Paint's frame and its view are both created with WS_EX_CLIENTEDGE
// (2px per side) and the sizing border went 3 -> 4 -- 5px of inset on the
// left and top, and 10px off the visible width.
const canvasBox = { x0: 88, y0: 69, x1: 287, y1: 309 };

function compare(a, b, transform = value => value) {
  let matching = 0;
  let total = 0;
  for (let y = canvasBox.y0; y < Math.min(canvasBox.y1, a.height, b.height); y++) {
    for (let x = canvasBox.x0; x < Math.min(canvasBox.x1, a.width, b.width); x++) {
      const i = (y * a.width + x) * 4;
      if (b.data[i] === transform(a.data[i]) &&
          b.data[i + 1] === transform(a.data[i + 1]) &&
          b.data[i + 2] === transform(a.data[i + 2])) matching++;
      total++;
    }
  }
  return { matching, total };
}

function countDark(image) {
  let count = 0;
  for (let y = 130; y < 200; y++) {
    for (let x = 110; x < 200; x++) {
      const i = (y * image.width + x) * 4;
      if (image.data[i] < 64 && image.data[i + 1] < 64 && image.data[i + 2] < 64) count++;
    }
  }
  return count;
}

function countWhite(image) {
  let count = 0;
  for (let y = canvasBox.y0; y < canvasBox.y1; y++) {
    for (let x = canvasBox.x0; x < canvasBox.x1; x++) {
      const i = (y * image.width + x) * 4;
      if (image.data[i] === 255 && image.data[i + 1] === 255 && image.data[i + 2] === 255) count++;
    }
  }
  return count;
}

(async () => {
  const filesExist = Object.values(shots).every(file =>
    fs.existsSync(file) && fs.statSync(file).size > 0);
  let drawnDark = -1;
  let inverted = { matching: -1, total: -1 };
  let undone = { matching: -1, total: -1 };
  let repeated = { matching: -1, total: -1 };
  let clearedWhite = -1;
  let clearUndone = { matching: -1, total: -1 };
  if (filesExist) {
    const images = Object.fromEntries(await Promise.all(
      Object.entries(shots).map(async ([name, file]) => [name, await pixels(file)]),
    ));
    drawnDark = countDark(images.drawn);
    inverted = compare(images.drawn, images.inverted, value => 255 - value);
    undone = compare(images.drawn, images.undone);
    repeated = compare(images.inverted, images.repeated);
    clearedWhite = countWhite(images.cleared);
    clearUndone = compare(images.repeated, images['clear-undone']);
  }

  const CANVAS_PX = (canvasBox.x1 - canvasBox.x0) * (canvasBox.y1 - canvasBox.y0);
  const nearlyAll = result => result.total === CANVAS_PX && result.matching >= result.total - 5;
  const checks = [
    ['emulator run completed', !runFailed],
    ['all six image-edit screenshots written', filesExist],
    [`source pencil stroke exists (${drawnDark} dark px)`, drawnDark >= 30],
    [`Invert Colors inverted the full visible image (${inverted.matching}/${inverted.total})`,
      nearlyAll(inverted)],
    [`Undo restored the drawing exactly (${undone.matching}/${undone.total})`, nearlyAll(undone)],
    [`Repeat restored the inversion exactly (${repeated.matching}/${repeated.total})`, nearlyAll(repeated)],
    [`Clear Image produced a blank white image (${clearedWhite} white px)`, clearedWhite >= CANVAS_PX - 5],
    [`Undo Clear restored the inverted image (${clearUndone.matching}/${clearUndone.total})`,
      nearlyAll(clearUndone)],
    ['no runtime crash or unimplemented API',
      !/UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH/.test(output)],
  ];

  if (runFailed) {
    console.error(output.split('\n').filter(line =>
      /Error|Runtime|CRASH|STUCK|input|Stats/.test(line)).slice(-60).join('\n'));
  }
  let failed = 0;
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) failed++;
  }
  console.log(`Artifacts: ${OUT}`);
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
