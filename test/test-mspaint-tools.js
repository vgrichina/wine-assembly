#!/usr/bin/env node

// End-to-end Win98 Paint tool regression. Each stage is captured separately
// so line, rectangle, ellipse, foreground-color selection, and pencil drawing
// cannot accidentally pass from one surviving operation.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'mspaint.exe');
const OUT = path.join(ROOT, 'scratch', 'mspaint-tools');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
const shots = Object.fromEntries(
  ['before', 'line', 'rectangle', 'ellipse', 'color', 'menu']
    .map(name => [name, path.join(OUT, `${name}.png`)]),
);
for (const file of Object.values(shots)) {
  try { fs.unlinkSync(file); } catch (_) {}
}

const input = [
  `40:png:${shots.before}`,
  '50:click:39:196',                  // line tool
  '60:mousedown:115:125', '61:mousemove:145:150',
  '62:mousemove:180:170', '63:mouseup:220:190',
  `75:png:${shots.line}`,
  '85:click:39:221',                  // rectangle tool
  '95:mousedown:115:205', '96:mousemove:145:225',
  '97:mousemove:175:250', '98:mouseup:215:275',
  `110:png:${shots.rectangle}`,
  '120:click:39:246',                 // ellipse tool
  '130:mousedown:150:100', '131:mousemove:175:110',
  '132:mousemove:205:125', '133:mouseup:240:145',
  `145:png:${shots.ellipse}`,
  '155:click:91:375',                 // red foreground swatch
  '165:click:39:146',                 // pencil tool
  '175:mousedown:110:300', '176:mousemove:130:290',
  '177:mousemove:150:280', '178:mousemove:175:270',
  '179:mouseup:200:260',
  `195:png:${shots.color}`,
  '205:wait-title-menu-open:untitled_-_Paint:100:70:file',
  '205:menu-dump:file',
  `206:png:${shots.menu}`,
  '207:stop',
].join(',');

let output = '';
let runFailed = false;
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input}`,
    '--max-batches=320',
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
  return { width: image.width, height: image.height, data: ctx.getImageData(0, 0, image.width, image.height).data };
}

function countDiff(a, b, box) {
  let count = 0;
  for (let y = box.y0; y < Math.min(box.y1, a.height, b.height); y++) {
    for (let x = box.x0; x < Math.min(box.x1, a.width, b.width); x++) {
      const i = (y * a.width + x) * 4;
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) count++;
    }
  }
  return count;
}

function countRed(image, box) {
  let count = 0;
  for (let y = box.y0; y < Math.min(box.y1, image.height); y++) {
    for (let x = box.x0; x < Math.min(box.x1, image.width); x++) {
      const i = (y * image.width + x) * 4;
      if (image.data[i] > 180 && image.data[i + 1] < 100 && image.data[i + 2] < 100) count++;
    }
  }
  return count;
}

function countWhere(image, box, predicate) {
  let count = 0;
  for (let y = box.y0; y < Math.min(box.y1, image.height); y++) {
    for (let x = box.x0; x < Math.min(box.x1, image.width); x++) {
      const i = (y * image.width + x) * 4;
      if (predicate(image.data[i], image.data[i + 1], image.data[i + 2])) count++;
    }
  }
  return count;
}

(async () => {
  if (runFailed) {
    const diagnostic = output.split('\n').filter(line =>
      /Error|Runtime|CRASH|STUCK|input|CreateWindow|Stats/.test(line),
    ).slice(-40).join('\n');
    console.error(diagnostic || output.slice(-4000));
  }
  const filesExist = Object.values(shots).every(file => fs.existsSync(file) && fs.statSync(file).size > 0);
  let lineDiff = -1;
  let rectangleDiff = -1;
  let ellipseDiff = -1;
  let redPixels = -1;
  let whiteCanvas = -1;
  let toolInk = -1;
  let paletteColor = -1;
  if (filesExist) {
    const [before, line, rectangle, ellipse, color] = await Promise.all([
      pixels(shots.before), pixels(shots.line), pixels(shots.rectangle),
      pixels(shots.ellipse), pixels(shots.color),
    ]);
    lineDiff = countDiff(before, line, { x0: 105, y0: 115, x1: 230, y1: 200 });
    rectangleDiff = countDiff(line, rectangle, { x0: 105, y0: 195, x1: 225, y1: 285 });
    ellipseDiff = countDiff(rectangle, ellipse, { x0: 140, y0: 90, x1: 250, y1: 155 });
    redPixels = countRed(color, { x0: 100, y0: 250, x1: 210, y1: 310 });
    whiteCanvas = countWhere(before, { x0: 82, y0: 62, x1: 292, y1: 304 },
      (r, g, b) => r > 245 && g > 245 && b > 245);
    toolInk = countWhere(before, { x0: 25, y0: 62, x1: 76, y1: 260 },
      (r, g, b) => r < 80 && g < 80 && b < 80);
    paletteColor = countWhere(before, { x0: 25, y0: 352, x1: 278, y1: 384 },
      (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) > 80);
  }

  const checks = [
    ['emulator run completed', !runFailed],
    ['all six screenshots written', filesExist],
    [`line tool changed expected region (${lineDiff} px)`, lineDiff >= 50],
    [`rectangle tool changed expected region (${rectangleDiff} px)`, rectangleDiff >= 100],
    [`ellipse tool changed expected region (${ellipseDiff} px)`, ellipseDiff >= 50],
    [`red pencil produced red pixels (${redPixels} px)`, redPixels >= 25],
    [`classic canvas, tool grid, and color palette are populated`,
      whiteCanvas >= 35000 && toolInk >= 500 && paletteColor >= 1000],
    ['File menu contains 17 direct items', /menu-dump:file:[^\n]*count=17/.test(output)],
    ['File menu exposes New, Save As, Print, Wallpaper, and Exit',
      ['&New', 'Save &As', '&Print', '&Wallpaper', 'E&xit'].every(label => output.includes(label))],
    ['no unimplemented API or runtime crash', !/UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH/.test(output)],
  ];

  let failed = 0;
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) failed++;
  }
  console.log(`Screenshots: ${OUT}`);
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
