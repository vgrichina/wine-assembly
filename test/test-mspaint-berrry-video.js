#!/usr/bin/env node

'use strict';

// End-to-end demo workflow for the reusable CLI recorder. Real scheduled
// mouse and keyboard input maximize Win98 Paint, build a filled strawberry,
// hand-draw BERRRY, then add its tagline with Paint's native Text tool while
// test/run.js records every rendered batch.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'mspaint.exe');
const OUT = path.join(__dirname, 'output', 'mspaint-berrry-video');
const VIDEO = path.join(OUT, 'berrry-paint.mp4');
const FINAL = path.join(OUT, 'berrry-paint.png');
const TAGLINE = 'best place to host vibe coded apps';
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

// Maximizing Paint does not resize the bitmap: its original bottom-right size
// handle remains at 389,290. Drag that real handle across the gray work area
// before drawing so the white document fills the maximized window.
at(13, 'mousedown:389:290');
at(14, 'mousemove:500:340');
at(15, 'mousemove:626:396');
at(16, 'mouseup:626:396');

// Black polygon outline for the berry, followed by a red flood fill.
click(18, 46, 204); // Polygon tool.
let batch = polygon(20, [
  [120, 135], [260, 135], [285, 170], [280, 225], [245, 285],
  [190, 325], [140, 290], [105, 230], [95, 170], [120, 135],
]);
click(batch + 1, 78, 433); // Bright red foreground.
click(batch + 2, 46, 79);  // Fill tool.
click(batch + 3, 190, 210);

// Jagged green crown, also created entirely with Paint's Polygon and Fill.
click(batch + 6, 46, 416); // Black foreground.
click(batch + 7, 46, 204); // Polygon tool.
batch = polygon(batch + 9, [
  [105, 145], [145, 120], [125, 70], [175, 110], [190, 55],
  [205, 110], [260, 70], [240, 125], [280, 145], [235, 160],
  [150, 160], [105, 145],
]);
click(batch + 1, 110, 433); // Bright green foreground.
click(batch + 2, 46, 79);   // Fill tool.
click(batch + 3, 190, 105);

// Large round brush for seeds and the BERRRY wordmark.
click(batch + 6, 46, 416); // Black foreground.
click(batch + 7, 46, 129); // Brush tool.
click(batch + 8, 19, 252); // Largest round brush option.
batch += 8;
for (const [x, y] of [
  [145, 185], [190, 175], [235, 185], [125, 220],
  [170, 215], [225, 225], [145, 255], [195, 250],
  [245, 260], [165, 285], [220, 285],
]) click(++batch, x, y);

batch += 3;
const lines = [
  // B
  [315,100,315,250], [315,100,350,100], [315,175,350,175], [315,250,350,250],
  [350,100,360,135], [360,135,350,175], [350,175,360,215], [360,215,350,250],
  // E
  [370,100,370,250], [370,100,405,100], [370,175,402,175], [370,250,405,250],
  // R R R
  [415,100,415,250], [415,100,450,100], [415,175,450,175], [450,100,450,175], [430,175,455,250],
  [465,100,465,250], [465,100,500,100], [465,175,500,175], [500,100,500,175], [480,175,505,250],
  [515,100,515,250], [515,100,550,100], [515,175,550,175], [550,100,550,175], [530,175,555,250],
  // Y
  [560,100,580,175], [605,100,580,175], [580,175,580,250],
];
for (const line of lines) batch = stroke(batch, ...line);

// Put the tagline beneath the mark using Paint's actual Text tool and EDIT
// control. One character every two video frames makes the typing legible in
// the recording; switching back to Brush commits the text to the bitmap.
batch += 4;
click(batch++, 46, 154); // Text tool.
at(batch++, 'mousedown:305:280');
at(batch++, 'mousemove:615:345');
at(batch++, 'mouseup:615:345');
batch += 3; // Let Paint create and focus control 114 plus its Fonts palette.
at(batch, 'dump-combobox:103:paint-font-size');
at(batch++, 'dump-combobox:104:paint-font-face');

// Paint defaults this scalable font to 8pt. Open its live size dropdown,
// scroll until 18pt is the fourth visible row, and click that real list item.
at(batch++, 'ctrl-click:103');
at(batch++, 'mousedown:258:76');
at(batch++, 'mousemove:258:88');
at(batch++, 'mouseup:258:88');
click(batch++, 220, 95);
at(batch++, 'dump-combobox:103:paint-font-size-selected');
batch += 2;
click(batch++, 330, 310);
for (const char of TAGLINE) {
  const code = char === ' ' ? 32 : char.toUpperCase().charCodeAt(0);
  at(batch, `keydown:${code}`);
  at(batch, `keypress:${char.charCodeAt(0)}`);
  at(batch, `keyup:${code}`);
  batch += 2;
}
at(batch++, 'dump-focus-state:berrry-tagline');
batch += 2;
click(batch++, 46, 129); // Brush tool commits the live text edit.

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
    '--video-start-batch=17',
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
const countPixels = (source, box, predicate) => {
  let total = 0;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const i = (y * source.width + x) * 4;
      if (predicate(source.data[i], source.data[i + 1], source.data[i + 2])) total++;
    }
  }
  return total;
};
const count = (box, predicate) => countPixels(image, box, predicate);
const berry = { x0: 90, y0: 50, x1: 290, y1: 335 };
const word = { x0: 305, y0: 90, x1: 615, y1: 260 };
const tagline = { x0: 300, y0: 275, x1: 620, y1: 350 };
const expandedCanvas = { x0: 400, y0: 355, x1: 620, y1: 390 };
const red = count(berry, (r, g, b) => r > 200 && g < 60 && b < 60);
const green = count(berry, (r, g, b) => g > 180 && r < 80 && b < 80);
const seedInk = count(berry, (r, g, b) => r < 40 && g < 40 && b < 40);
const wordInk = count(word, (r, g, b) => r < 40 && g < 40 && b < 40);
const taglineInk = count(tagline, (r, g, b) => r < 40 && g < 40 && b < 40);
const expandedCanvasWhite = count(expandedCanvas, (r, g, b) => r > 245 && g > 245 && b > 245);

assert(expandedCanvasWhite >= 7000,
  `Paint document did not fill the maximized work area (${expandedCanvasWhite} white pixels)`);
assert(red >= 15000, `strawberry body is not visibly red (${red} pixels)`);
assert(green >= 2500, `strawberry crown is not visibly green (${green} pixels)`);
assert(seedInk >= 700, `strawberry outline/seeds are missing (${seedInk} dark pixels)`);
assert(wordInk >= 7000, `BERRRY block lettering is missing (${wordInk} dark pixels)`);
assert(taglineInk >= 500, `Berrry tagline is missing or too small (${taglineInk} dark pixels)`);
assert(/dump-combobox paint-font-size-selected:.*id=103 .*cursel=7 /.test(output),
  'Paint Fonts palette did not select its 18pt row');
const taglineFocusDump = output.match(/dump-focus-state berrry-tagline:.*$/m);
assert(/dump-focus-state berrry-tagline:.*class=2 id=114 .*text="best place to host vibe coded apps"/.test(output),
  `Paint native text edit did not receive the complete Berrry tagline (${taglineFocusDump || 'no focus dump'})`);

const probe = JSON.parse(execFileSync(FFPROBE, [
  '-v', 'error',
  '-show_entries', 'stream=codec_name,width,height,avg_frame_rate:format=duration,size',
  '-of', 'json', VIDEO,
], { encoding: 'utf8' }));
const stream = probe.streams && probe.streams[0];
const duration = Number(probe.format && probe.format.duration);
const firstFrame = PNG.sync.read(execFileSync(FFMPEG, [
  '-v', 'error', '-i', VIDEO,
  '-vf', 'select=eq(n\\,0)', '-frames:v', '1',
  '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
], { maxBuffer: 4 * 1024 * 1024 }));
const openingCanvas = { x0: 70, y0: 50, x1: 620, y1: 390 };
const openingWhite = countPixels(firstFrame, openingCanvas,
  (r, g, b) => r > 240 && g > 240 && b > 240);
const openingInk = countPixels(firstFrame, openingCanvas,
  (r, g, b) => r < 80 && g < 80 && b < 80);
assert(stream && stream.codec_name === 'h264', `unexpected video stream: ${JSON.stringify(stream)}`);
assert.strictEqual(stream.width, 640, 'recorded video width');
assert.strictEqual(stream.height, 480, 'recorded video height');
assert(duration >= 12, `recorded workflow is too short (${duration}s)`);
assert(openingWhite >= 185000 && openingInk <= 20,
  `video did not start on the clean expanded canvas (${openingWhite} white, ${openingInk} dark pixels)`);
assert(/\[video\] wrote .*berrry-paint\.mp4/.test(output),
  'CLI did not report a completed video');
assert(!/UNIMPLEMENTED API:|RuntimeError|LinkError|\*\*\* CRASH/.test(output),
  output.slice(-5000));

console.log(`PASS  Paint expanded its document across the work area (${expandedCanvasWhite} white pixels)`);
console.log(`PASS  Paint drew a red strawberry (${red} red, ${green} green, ${seedInk} dark pixels)`);
console.log(`PASS  Paint hand-drew BERRRY (${wordInk} dark pixels)`);
console.log(`PASS  Paint Text tool committed the tagline (${taglineInk} dark pixels)`);
console.log(`PASS  MP4 starts on the clean expanded canvas (${openingWhite} white pixels)`);
console.log(`PASS  CLI recorded ${duration.toFixed(2)}s H.264 video at ${stream.width}x${stream.height}`);
console.log(`Video: ${VIDEO}`);
console.log(`Final frame: ${FINAL}`);
