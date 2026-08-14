#!/usr/bin/env node

// Paint's Draw Opaque setting changes selection blits. Move two identical
// black-on-white selections over red targets: the default opaque move copies
// white background pixels, while the toggled transparent move keeps red.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.resolve(__dirname, '..');
const RUN = path.join(ROOT, 'test', 'run.js');
const EXE = path.join(ROOT, 'test', 'binaries', 'mspaint.exe');
const OUT = path.join(ROOT, 'scratch', 'mspaint-opaque-selection');
const SHOT = path.join(OUT, 'opaque-vs-transparent.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
try { fs.unlinkSync(SHOT); } catch (_) {}

const input = [
  // Two black strokes on white source backgrounds.
  '18:click:39:146',
  '19:mousedown:100:105', '20:mousemove:120:115', '21:mouseup:125:115',
  '22:mousedown:100:205', '23:mousemove:120:215', '24:mouseup:125:215',

  // Two solid red destination rectangles.
  '25:click:91:375',
  '26:click:39:221',
  '27:click:50:315',                      // Rectangle: fill only
  '28:mousedown:170:90', '29:mousemove:240:140', '30:mouseup:240:140',
  '31:mousedown:170:190', '32:mousemove:240:240', '33:mouseup:240:240',

  // Default Draw Opaque: selection background overwrites the first target.
  '34:click:64:71',
  '35:mousedown:95:98', '36:mousemove:132:122', '37:mouseup:132:122',
  '39:mousedown:110:108', '40:mousemove:190:112', '41:mouseup:190:112',
  '43:click:260:280',

  // Turn Draw Opaque off and repeat over the second red target.
  '44:0x111:6868',
  '45:click:64:71',
  '46:mousedown:95:198', '47:mousemove:132:222', '48:mouseup:132:222',
  '50:mousedown:110:208', '51:mousemove:190:212', '52:mouseup:190:212',
  '54:click:260:280',
  `58:png:${SHOT}`,
  '59:stop',
].join(',');

let output = '';
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input}`,
    '--max-batches=62',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
} catch (error) {
  output = `${error.stdout || ''}${error.stderr || ''}`;
  assert.fail(`Paint opaque-selection run failed:\n${output.slice(-5000)}`);
}

function classify(image, box) {
  let red = 0;
  let white = 0;
  let dark = 0;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const i = (y * image.width + x) * 4;
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      if (r > 220 && g < 40 && b < 40) red++;
      if (r > 245 && g > 245 && b > 245) white++;
      if (r < 40 && g < 40 && b < 40) dark++;
    }
  }
  return { red, white, dark };
}

(async () => {
  assert(fs.existsSync(SHOT) && fs.statSync(SHOT).size > 0,
    'Paint did not write the opaque-selection screenshot');
  const source = await loadImage(SHOT);
  const canvas = createCanvas(source.width, source.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0);
  const image = { width: source.width, height: source.height,
    data: ctx.getImageData(0, 0, source.width, source.height).data };

  const opaque = classify(image, { x0: 176, y0: 102, x1: 217, y1: 126 });
  const transparent = classify(image, { x0: 176, y0: 202, x1: 217, y1: 226 });

  assert(opaque.white >= 750 && opaque.red < 100,
    `opaque selection did not copy its white background: ${JSON.stringify(opaque)}`);
  assert(transparent.red >= 750 && transparent.white < 100,
    `transparent selection erased its red target: ${JSON.stringify(transparent)}`);
  assert(opaque.dark >= 15 && transparent.dark >= 15,
    `selection foreground strokes were lost: opaque=${opaque.dark} transparent=${transparent.dark}`);
  assert(!/UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH/.test(output),
    'Paint Draw Opaque workflow triggered an emulator failure');

  console.log('PASS  Paint selection moves honor the Draw Opaque setting');
  console.log(`opaque=${JSON.stringify(opaque)} transparent=${JSON.stringify(transparent)}`);
  console.log(`Screenshot: ${SHOT}`);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
