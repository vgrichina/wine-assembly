#!/usr/bin/env node

// Win98 standard scrollbar thumbs span the full 16px non-client strip. Paint
// makes both axes visible for an oversized bitmap, providing a real MFC case
// that catches cross-axis insets which make the thumbs look unnaturally thin.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'mspaint.exe');
const OUT = path.join(ROOT, 'scratch', 'mspaint-scrollbar-thumb');
const bmpPath = path.join(OUT, 'oversized.bmp');
const screenshot = path.join(OUT, 'scrollbars.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

function makeBmp(width, height) {
  const stride = (width * 3 + 3) & ~3;
  const pixels = stride * height;
  const bmp = Buffer.alloc(54 + pixels, 0xFF);
  bmp.write('BM', 0, 'ascii');
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(pixels, 34);
  return bmp;
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(bmpPath, makeBmp(600, 500));
try { fs.unlinkSync(screenshot); } catch (_) {}

const input = [
  `10:vfs-import:oversized.bmp:${bmpPath}`,
  '24:0x111:57601',
  '32:open-dlg-pick:oversized.bmp',
  // Ask the emulator where the strips are rather than hardcoding them. They
  // sit just outside the view's client rect, so they move whenever frame
  // metrics, default placement, or Paint's own control-bar layout move.
  '47:dump-scrollbar:v:vert',
  '47:dump-scrollbar:h:horz',
  `48:png:${screenshot}`,
  '49:stop',
].join(',');

function parseStrip(text, label) {
  const line = text.split('\n').find(l => l.includes(`[scrollbar]:${label} `));
  const m = line && line.match(/strip=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);
  if (!m) return null;
  return { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] };
}

let output = '';
let runFailed = false;
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input}`,
    '--max-batches=52',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
    // A ceiling for a hang, not a performance budget: a 50-batch Paint run
    // takes a few seconds alone but several times that when the suite (or
    // another agent) is loading the box, and a tight limit turns that into a
    // phantom regression that reports every pixel assert as 0x0.
  ], { cwd: ROOT, encoding: 'utf8', timeout: 45000, maxBuffer: 8 * 1024 * 1024 });
} catch (error) {
  runFailed = true;
  output = `${error.stdout || ''}${error.stderr || ''}`;
}

function isButtonFace(data, index) {
  return data[index] === 0xC0 && data[index + 1] === 0xC0 && data[index + 2] === 0xC0;
}

(async () => {
  const screenshotExists = fs.existsSync(screenshot) && fs.statSync(screenshot).size > 0;
  const vertStrip = parseStrip(output, 'vert');
  const horzStrip = parseStrip(output, 'horz');
  let verticalOuterEdge = -1;
  let horizontalOuterEdge = -1;
  if (screenshotExists && vertStrip && horzStrip) {
    const image = await loadImage(screenshot);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, image.width, image.height).data;

    // At position zero each thumb starts immediately after the 16px low arrow.
    // Sample 20 rows/columns of it at both outer edges of the strip: a thumb
    // that spans the strip puts its raised edge there (white highlight on the
    // low side, shadow on the high side), while an inset one leaves exposed
    // button-face track rails.
    const sample = (x, y) => !isButtonFace(data, (y * image.width + x) * 4);
    verticalOuterEdge = 0;
    for (let y = vertStrip.y0 + 20; y < vertStrip.y0 + 40; y++) {
      for (const x of [vertStrip.x0, vertStrip.x1 - 1]) {
        if (sample(x, y)) verticalOuterEdge++;
      }
    }
    horizontalOuterEdge = 0;
    for (let x = horzStrip.x0 + 20; x < horzStrip.x0 + 40; x++) {
      for (const y of [horzStrip.y0, horzStrip.y1 - 1]) {
        if (sample(x, y)) horizontalOuterEdge++;
      }
    }
  }

  const describe = (s) => (s ? `${s.x0},${s.y0}-${s.x1},${s.y1}` : 'NOT REPORTED');
  const checks = [
    ['emulator run completed', !runFailed],
    ['oversized Paint screenshot written', screenshotExists],
    [`both scrollbar strips located (v ${describe(vertStrip)}, h ${describe(horzStrip)})`,
      !!vertStrip && !!horzStrip],
    [`vertical thumb reaches both strip edges (${verticalOuterEdge}/40 chrome samples)`,
      verticalOuterEdge >= 35],
    [`horizontal thumb reaches both strip edges (${horizontalOuterEdge}/40 chrome samples)`,
      horizontalOuterEdge >= 35],
    ['no runtime crash or unimplemented API',
      !/UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH/.test(output)],
  ];

  if (runFailed) {
    console.error(output.split('\n').filter(line =>
      /Error|Runtime|CRASH|STUCK|input|Stats/.test(line)).slice(-50).join('\n'));
  }
  let failed = 0;
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) failed++;
  }
  console.log(`Artifact: ${screenshot}`);
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
