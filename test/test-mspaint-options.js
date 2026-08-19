#!/usr/bin/env node

// Win98 Paint tool-options regression. Verify that clicks in the native
// brush and airbrush option panels affect the marks produced on the canvas.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'mspaint.exe');
const OUT = path.join(ROOT, 'scratch', 'mspaint-options');
const shot = path.join(OUT, 'brush-airbrush-sizes.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
try { fs.unlinkSync(shot); } catch (_) {}

const input = [
  // Brush, largest round option, then smallest round option.
  '7:click:64:146',
  '8:click:37:269', '9:click:120:100',
  '10:click:62:269', '11:click:150:100',
  // Airbrush, smallest option, then largest option.
  '12:click:39:171',
  '13:click:39:279', '14:click:120:160',
  '15:click:50:310', '16:click:180:160',
  `18:png:${shot}`,
  '19:stop',
].join(',');

let output = '';
let runFailed = false;
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input}`,
    '--max-batches=25',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
    // Ceiling for a hang, not a performance budget — see the note in
    // test-mspaint-scrollbar-thumb.js. At 9s this test reported 1/8 with every
    // pixel assert reading 0x0 whenever the box was busy.
  ], { cwd: ROOT, encoding: 'utf8', timeout: 45000, maxBuffer: 12 * 1024 * 1024 });
} catch (error) {
  runFailed = true;
  output = `${error.stdout || ''}${error.stderr || ''}`;
}

async function pixels(file) {
  const image = await loadImage(file);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return {
    width: image.width,
    height: image.height,
    data: ctx.getImageData(0, 0, image.width, image.height).data,
  };
}

function inkBounds(image, box) {
  let count = 0;
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = box.y0; y < Math.min(box.y1, image.height); y++) {
    for (let x = box.x0; x < Math.min(box.x1, image.width); x++) {
      const i = (y * image.width + x) * 4;
      if (image.data[i] < 245 || image.data[i + 1] < 245 || image.data[i + 2] < 245) {
        count++;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return {
    count,
    width: maxX >= minX ? maxX - minX + 1 : 0,
    height: maxY >= minY ? maxY - minY + 1 : 0,
  };
}

// The tool-options well is a sunken 40x65 frame that Paint itself positions,
// with four 1px PatBlt rules at toolbox-child coords (10,203)-(50,268). Its
// screen position therefore follows the toolbox child origin, which follows
// the frame window's client origin — so a change in window chrome moves it.
// It has moved once already: this band used to be hardcoded at x=23..76,
// y=260..328, which sits 3px up and left of where the well is now and clipped
// the bottom edge of the tool-button grid into the margin, counting 47
// legitimately black button-shadow pixels as stray ink.
//
// So find the well rather than assume it. Its top edge is a ~41px horizontal
// run of COLOR_3DSHADOW. The tool buttons end in a shadow row of their own, so
// that alone is ambiguous; what separates them is that the well is preceded by
// clear button-face gray, while a button's shadow row has the button's own
// highlight and edge pixels immediately above it.
const WELL_W = 40;
const WELL_H = 65;

function isShadow(image, x, y) {
  const i = (y * image.width + x) * 4;
  return Math.abs(image.data[i] - 128) <= 6 &&
         Math.abs(image.data[i + 1] - 128) <= 6 &&
         Math.abs(image.data[i + 2] - 128) <= 6;
}
function isFace(image, x, y) {
  const i = (y * image.width + x) * 4;
  return Math.abs(image.data[i] - 192) <= 2 &&
         Math.abs(image.data[i + 1] - 192) <= 2 &&
         Math.abs(image.data[i + 2] - 192) <= 2;
}

function findOptionWell(image) {
  for (let y = 200; y < 400 && y < image.height; y++) {
    let run = 0;
    for (let x = 20; x < 100 && x < image.width; x++) {
      run = isShadow(image, x, y) ? run + 1 : 0;
      if (run < WELL_W - 2 || run > WELL_W + 4) continue;
      const x0 = x - run + 1;
      let clearAbove = y > 0;
      for (let px = x0; px <= x && clearAbove; px++) {
        if (!isFace(image, px, y - 1)) clearAbove = false;
      }
      // Take the extents from the app-fixed size, not the matched run: the
      // corner pixels of the frame are not all shadow, so the run can stop a
      // few pixels short of the real right edge.
      if (clearAbove) return { x0, y0: y, x1: x0 + WELL_W, y1: y + WELL_H };
    }
  }
  return null;
}

function optionWellMargin(image) {
  const well = findOptionWell(image);
  if (!well) return { black: Infinity, buttonFace: 0, found: false };
  let black = 0;
  let buttonFace = 0;
  // A 3px band around the well: it should be plain button-face gray, with the
  // button grid's own shadow edge safely above it.
  for (let y = well.y0 - 3; y <= well.y1 + 3; y++) {
    for (let x = well.x0 - 3; x <= well.x1 + 3; x++) {
      if (x >= well.x0 && x <= well.x1 && y >= well.y0 && y <= well.y1) continue;
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const i = (y * image.width + x) * 4;
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      if (r < 20 && g < 20 && b < 20) black++;
      if (Math.abs(r - 192) <= 2 && Math.abs(g - 192) <= 2 && Math.abs(b - 192) <= 2) {
        buttonFace++;
      }
    }
  }
  return { black, buttonFace, found: true, well };
}

(async () => {
  const screenshotExists = fs.existsSync(shot) && fs.statSync(shot).size > 0;
  const marks = {};
  if (screenshotExists) {
    const image = await pixels(shot);
    marks.brushLarge = inkBounds(image, { x0: 105, y0: 85, x1: 135, y1: 115 });
    marks.brushSmall = inkBounds(image, { x0: 140, y0: 90, x1: 160, y1: 110 });
    marks.spraySmall = inkBounds(image, { x0: 100, y0: 140, x1: 140, y1: 180 });
    marks.sprayLarge = inkBounds(image, { x0: 145, y0: 125, x1: 215, y1: 195 });
    marks.optionWell = optionWellMargin(image);
  }

  const brushLarge = marks.brushLarge || { count: 0, width: 0, height: 0 };
  const brushSmall = marks.brushSmall || { count: 0, width: 0, height: 0 };
  const spraySmall = marks.spraySmall || { count: 0, width: 0, height: 0 };
  const sprayLarge = marks.sprayLarge || { count: 0, width: 0, height: 0 };
  const optionWell = marks.optionWell || { black: Infinity, buttonFace: 0 };
  const checks = [
    ['emulator run completed', !runFailed],
    ['tool-options screenshot written', screenshotExists],
    [`large brush option produced a broad mark (${brushLarge.width}x${brushLarge.height})`,
      brushLarge.count > 0 && brushLarge.width >= 6 && brushLarge.height >= 6],
    [`small brush option produced a compact mark (${brushSmall.width}x${brushSmall.height})`,
      brushSmall.count > 0 && brushSmall.width <= 3 && brushSmall.height <= 3],
    [`small airbrush option stayed compact (${spraySmall.width}x${spraySmall.height})`,
      spraySmall.count > 0 && spraySmall.width <= 10 && spraySmall.height <= 10],
    [`large airbrush option expanded the spray (${sprayLarge.width}x${sprayLarge.height})`,
      sprayLarge.count > 0 && Math.max(sprayLarge.width, sprayLarge.height) >= 15 &&
        sprayLarge.width * sprayLarge.height >= 150],
    [`tool-options margin stayed button-face gray (${optionWell.black} black, ${optionWell.buttonFace} gray, well ${optionWell.well ? `${optionWell.well.x0},${optionWell.well.y0}-${optionWell.well.x1},${optionWell.well.y1}` : 'NOT FOUND'})`,
      optionWell.black < 20 && optionWell.buttonFace > 600],
    ['no crash or unimplemented API',
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
  console.log(`Artifact: ${shot}`);
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
