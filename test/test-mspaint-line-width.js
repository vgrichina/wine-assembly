#!/usr/bin/env node
// Paint98 diagonal line-width regression. This deliberately exercises the
// real Line tool rather than only the software GDI kernel: every option must
// grow the diagonal footprint by one pixel without adding a black outline.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'mspaint.exe');
const SHOT = path.join(ROOT, 'scratch', 'mspaint-line-width.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(path.dirname(SHOT), { recursive: true });
try { fs.unlinkSync(SHOT); } catch (_) {}

const strokes = [
  { optionY: 271, y: 90 },
  { optionY: 283, y: 125 },
  { optionY: 295, y: 160 },
  { optionY: 307, y: 195 },
  { optionY: 319, y: 230 },
];
const input = [
  '18:click:91:375',       // red foreground
  '21:click:39:196',       // Line tool
];
let batch = 24;
for (const { optionY, y } of strokes) {
  input.push(`${batch}:click:50:${optionY}`);
  input.push(`${batch + 2}:mousedown:105:${y}`);
  input.push(`${batch + 3}:mousemove:125:${y + 10}`);
  input.push(`${batch + 4}:mouseup:145:${y + 20}`);
  batch += 6;
}
input.push(`${batch + 2}:png:${SHOT}`, `${batch + 3}:stop`);

let output = '';
let runFailed = false;
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input.join(',')}`,
    `--max-batches=${batch + 6}`,
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 12000, maxBuffer: 4 * 1024 * 1024 });
} catch (error) {
  runFailed = true;
  output = `${error.stdout || ''}${error.stderr || ''}`;
}

async function analyze() {
  if (runFailed) {
    console.error(output.split('\n').filter(line =>
      /Error|Runtime|CRASH|STUCK|input|Stats/.test(line)).slice(-40).join('\n'));
  }
  if (!fs.existsSync(SHOT) || fs.statSync(SHOT).size === 0) {
    throw new Error('Paint did not write the diagonal-line screenshot');
  }

  const image = await loadImage(SHOT);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
  const red = new Set();
  for (let y = 75; y < 275; y++) {
    for (let x = 90; x < 170; x++) {
      const i = (y * image.width + x) * 4;
      if (pixels[i] > 180 && pixels[i + 1] < 80 && pixels[i + 2] < 80) {
        red.add(y * image.width + x);
      }
    }
  }

  const components = [];
  while (red.size) {
    const first = red.values().next().value;
    const queue = [first];
    const points = [];
    red.delete(first);
    while (queue.length) {
      const point = queue.pop();
      points.push(point);
      const x = point % image.width;
      const y = (point - x) / image.width;
      for (let yy = y - 1; yy <= y + 1; yy++) {
        for (let xx = x - 1; xx <= x + 1; xx++) {
          const neighbor = yy * image.width + xx;
          if (red.delete(neighbor)) queue.push(neighbor);
        }
      }
    }
    const xs = points.map(point => point % image.width);
    const ys = points.map(point => (point - point % image.width) / image.width);
    components.push({
      pixels: points.length,
      x0: Math.min(...xs), x1: Math.max(...xs),
      y0: Math.min(...ys), y1: Math.max(...ys),
    });
  }
  components.sort((a, b) => a.y0 - b.y0);

  const widths = components.map(c => c.x1 - c.x0 + 1);
  const heights = components.map(c => c.y1 - c.y0 + 1);
  let blackOutline = 0;
  for (const c of components) {
    for (let y = c.y0 - 1; y <= c.y1 + 1; y++) {
      for (let x = c.x0 - 1; x <= c.x1 + 1; x++) {
        const i = (y * image.width + x) * 4;
        if (pixels[i] < 40 && pixels[i + 1] < 40 && pixels[i + 2] < 40) blackOutline++;
      }
    }
  }

  const checks = [
    ['emulator run completed', !runFailed],
    [`five diagonal strokes captured (${components.length})`, components.length === 5],
    [`diagonal widths grow 41..45 pixels (${widths.join(',')})`,
      widths.join(',') === '41,42,43,44,45'],
    [`diagonal heights grow 21..25 pixels (${heights.join(',')})`,
      heights.join(',') === '21,22,23,24,25'],
    [`no black outline around red strokes (${blackOutline} px)`, blackOutline === 0],
    ['no unimplemented API or runtime crash',
      !/UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH/.test(output)],
  ];
  let failed = 0;
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) failed++;
  }
  console.log(`Screenshot: ${SHOT}`);
  process.exit(failed ? 1 : 0);
}

analyze().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
