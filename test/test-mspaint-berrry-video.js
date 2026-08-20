#!/usr/bin/env node

'use strict';

// End-to-end demo workflow for the reusable CLI recorder. Real scheduled
// mouse input maximizes Win98 Paint, builds a filled strawberry, and hand-draws
// BERRRY in block letters while test/run.js records every rendered batch.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'mspaint.exe');
const OUT = path.join(__dirname, 'output', 'mspaint-berrry-video');
const VIDEO = path.join(OUT, 'berrry-paint.webm');
const FINAL = path.join(OUT, 'berrry-paint.png');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || (path.isAbsolute(FFMPEG)
  ? path.join(path.dirname(FFMPEG), 'ffprobe')
  : 'ffprobe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}
if (spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status !== 0 ||
    spawnSync(FFPROBE, ['-version'], { stdio: 'ignore' }).status !== 0) {
  console.log('SKIP  ffmpeg and ffprobe are required for the Paint video test');
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
for (const file of [VIDEO, FINAL]) {
  try { fs.unlinkSync(file); } catch (_) {}
}

const events = [];
const at = (batch, action) => events.push(`${batch}:${action}`);
const click = (batch, x, y) => at(batch, `click:${x}:${y}`);
const polygon = (startBatch, points) => {
  let batch = startBatch;
  const [first, second, ...rest] = points;
  at(batch++, `mousedown:${first[0]}:${first[1]}`);
  at(batch++, `mouseup:${second[0]}:${second[1]}`);
  for (const point of rest.slice(0, -1)) click(batch++, point[0], point[1]);
  const last = rest[rest.length - 1];
  at(batch++, `dblclick:${last[0]}:${last[1]}`);
  return batch;
};
const stroke = (batch, x0, y0, x1, y1) => {
  at(batch++, `mousedown:${x0}:${y0}`);
  at(batch++, `mousemove:${x1}:${y1}`);
  at(batch++, `mouseup:${x1}:${y1}`);
  return batch;
};

// Paint is ready by batch 7 in the focused Paint suite. Maximize it using the
// live caption geometry so the workflow is stable if default placement moves.
at(10, 'caption-click:0x10001:max');

// Black polygon outline for the berry, followed by a red flood fill.
click(18, 46, 204); // Polygon tool.
let batch = polygon(20, [
  [110, 135], [200, 135], [215, 160], [210, 195], [185, 235],
  [155, 255], [125, 235], [105, 195], [95, 160], [110, 135],
]);
click(batch + 1, 78, 433); // Bright red foreground.
click(batch + 2, 46, 79);  // Fill tool.
click(batch + 3, 155, 185);

// Jagged green crown, also created entirely with Paint's Polygon and Fill.
click(batch + 6, 46, 416); // Black foreground.
click(batch + 7, 46, 204); // Polygon tool.
batch = polygon(batch + 9, [
  [105, 145], [135, 125], [125, 90], [155, 115], [165, 75],
  [175, 115], [205, 90], [195, 125], [215, 145], [185, 155],
  [135, 155], [105, 145],
]);
click(batch + 1, 110, 433); // Bright green foreground.
click(batch + 2, 46, 79);   // Fill tool.
click(batch + 3, 165, 100);

// Large round brush for seeds and the BERRRY wordmark.
click(batch + 6, 46, 416); // Black foreground.
click(batch + 7, 46, 129); // Brush tool.
click(batch + 8, 19, 252); // Largest round brush option.
batch += 8;
for (const [x, y] of [
  [130, 170], [160, 165], [190, 175], [120, 195],
  [150, 195], [185, 205], [140, 225], [170, 225],
]) click(++batch, x, y);

batch += 3;
const lines = [
  // B
  [230,160,230,220], [230,160,245,160], [230,190,245,190], [230,220,245,220],
  [245,160,250,175], [250,175,245,190], [245,190,250,205], [250,205,245,220],
  // E
  [258,160,258,220], [258,160,275,160], [258,190,273,190], [258,220,275,220],
  // R R R
  [282,160,282,220], [282,160,298,160], [282,190,298,190], [298,160,298,190], [290,190,300,220],
  [306,160,306,220], [306,160,322,160], [306,190,322,190], [322,160,322,190], [314,190,324,220],
  [330,160,330,220], [330,160,346,160], [330,190,346,190], [346,160,346,190], [338,190,348,220],
  // Y
  [352,160,362,188], [372,160,362,188], [362,188,362,220],
];
for (const line of lines) batch = stroke(batch, ...line);

const finalBatch = batch + 5;
at(finalBatch, `png:${FINAL}`);
at(finalBatch + 15, 'stop'); // Hold the completed logo in the final second.

let output = '';
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    '--screen=640x480',
    `--input=${events.join(',')}`,
    `--video=${VIDEO}`,
    '--video-fps=15',
    `--ffmpeg=${FFMPEG}`,
    `--max-batches=${finalBatch + 17}`,
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
} catch (error) {
  output = `${error.stdout || ''}${error.stderr || ''}`;
  console.error(output.slice(-10000));
  throw error;
}

assert(fs.existsSync(FINAL) && fs.statSync(FINAL).size > 1000,
  `final Paint snapshot was not written: ${FINAL}`);
assert(fs.existsSync(VIDEO) && fs.statSync(VIDEO).size > 10000,
  `Paint video was not written: ${VIDEO}`);

const image = PNG.sync.read(fs.readFileSync(FINAL));
const count = (box, predicate) => {
  let total = 0;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const i = (y * image.width + x) * 4;
      if (predicate(image.data[i], image.data[i + 1], image.data[i + 2])) total++;
    }
  }
  return total;
};
const berry = { x0: 90, y0: 70, x1: 220, y1: 265 };
const word = { x0: 225, y0: 150, x1: 380, y1: 225 };
const red = count(berry, (r, g, b) => r > 200 && g < 60 && b < 60);
const green = count(berry, (r, g, b) => g > 180 && r < 80 && b < 80);
const seedInk = count(berry, (r, g, b) => r < 40 && g < 40 && b < 40);
const wordInk = count(word, (r, g, b) => r < 40 && g < 40 && b < 40);

assert(red >= 4000, `strawberry body is not visibly red (${red} pixels)`);
assert(green >= 500, `strawberry crown is not visibly green (${green} pixels)`);
assert(seedInk >= 200, `strawberry outline/seeds are missing (${seedInk} dark pixels)`);
assert(wordInk >= 500, `BERRRY block lettering is missing (${wordInk} dark pixels)`);

const probe = JSON.parse(execFileSync(FFPROBE, [
  '-v', 'error',
  '-show_entries', 'stream=codec_name,width,height,avg_frame_rate:format=duration,size',
  '-of', 'json', VIDEO,
], { encoding: 'utf8' }));
const stream = probe.streams && probe.streams[0];
const duration = Number(probe.format && probe.format.duration);
assert(stream && stream.codec_name === 'vp9', `unexpected video stream: ${JSON.stringify(stream)}`);
assert.strictEqual(stream.width, 640, 'recorded video width');
assert.strictEqual(stream.height, 480, 'recorded video height');
assert(duration >= 8, `recorded workflow is too short (${duration}s)`);
assert(/\[video\] wrote .*berrry-paint\.webm/.test(output),
  'CLI did not report a completed video');
assert(!/UNIMPLEMENTED API:|RuntimeError|LinkError|\*\*\* CRASH/.test(output),
  output.slice(-5000));

console.log(`PASS  Paint drew a red strawberry (${red} red, ${green} green, ${seedInk} dark pixels)`);
console.log(`PASS  Paint hand-drew BERRRY (${wordInk} dark pixels)`);
console.log(`PASS  CLI recorded ${duration.toFixed(2)}s VP9 video at ${stream.width}x${stream.height}`);
console.log(`Video: ${VIDEO}`);
console.log(`Final frame: ${FINAL}`);
