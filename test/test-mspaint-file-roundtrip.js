#!/usr/bin/env node

// End-to-end Paint file regression: draw, Save As a BMP, create a new
// document, reopen the BMP, modify it, and Save back to the same file.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');
const { parseDIB } = require('../lib/dib');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'mspaint.exe');
const OUT = path.join(ROOT, 'scratch', 'mspaint-file-roundtrip');
const FILE_NAME = 'paint-roundtrip.bmp';
const bmpPath = path.join(OUT, FILE_NAME);
const shots = Object.fromEntries(
  ['saved', 'new', 'reopened', 'resaved'].map(name => [name, path.join(OUT, `${name}.png`)]),
);

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
for (const file of [...Object.values(shots), bmpPath]) {
  try { fs.unlinkSync(file); } catch (_) {}
}

const input = [
  '40:click:39:146',
  '50:mousedown:120:140', '51:mousemove:150:160', '52:mouseup:190:190',
  '70:0x111:57604',                       // File > Save As
  `120:open-dlg-pick:${FILE_NAME}`,
  `180:png:${shots.saved}`,
  '181:dump-windows:saved',
  '190:0x111:57600',                      // File > New
  `240:png:${shots.new}`,
  '241:dump-windows:new',
  '250:0x111:57601',                      // File > Open
  `300:open-dlg-pick:${FILE_NAME}`,
  `390:png:${shots.reopened}`,
  '391:dump-windows:reopened',
  '400:mousedown:170:100', '401:mousemove:190:115', '402:mouseup:220:130',
  '420:0x111:57603',                      // File > Save (no dialog)
  `470:png:${shots.resaved}`,
  `471:vfs-export:${FILE_NAME}:${bmpPath}`,
  '472:dump-windows:resaved',
  '480:stop',
].join(',');

let output = '';
let runFailed = false;
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input}`,
    '--max-batches=520',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
    '--trace-api=GetSaveFileNameA,GetOpenFileNameA,CreateFileA,ReadFile,WriteFile,GetDIBits,SetDIBitsToDevice',
    '--trace-fs',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 12 * 1024 * 1024 });
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

function countNonDesktop(image, box) {
  let count = 0;
  for (let y = box.y0; y < Math.min(box.y1, image.height); y++) {
    for (let x = box.x0; x < Math.min(box.x1, image.width); x++) {
      const i = (y * image.width + x) * 4;
      if (image.data[i] !== 0 || image.data[i + 1] !== 128 || image.data[i + 2] !== 128) count++;
    }
  }
  return count;
}

(async () => {
  const screenshotsExist = Object.values(shots).every(file => fs.existsSync(file) && fs.statSync(file).size > 0);
  const bmpExists = fs.existsSync(bmpPath) && fs.statSync(bmpPath).size >= 54;
  let savedVsNew = -1;
  let savedVsReopened = -1;
  let reopenedVsResaved = -1;
  let minimumFrameCoverage = -1;
  if (screenshotsExist) {
    const [saved, fresh, reopened, resaved] = await Promise.all(
      [shots.saved, shots.new, shots.reopened, shots.resaved].map(pixels),
    );
    const canvasBox = { x0: 82, y0: 62, x1: 292, y1: 304 };
    savedVsNew = countDiff(saved, fresh, canvasBox);
    savedVsReopened = countDiff(saved, reopened, canvasBox);
    reopenedVsResaved = countDiff(reopened, resaved, canvasBox);
    const frameBox = { x0: 20, y0: 20, x1: 295, y1: 420 };
    minimumFrameCoverage = Math.min(...[saved, fresh, reopened, resaved]
      .map(image => countNonDesktop(image, frameBox)));
  }

  let header = null;
  let dib = null;
  let inkPixels = -1;
  if (bmpExists) {
    const bmp = fs.readFileSync(bmpPath);
    header = {
      magic: bmp.toString('ascii', 0, 2),
      fileSize: bmp.readUInt32LE(2),
      pixelOffset: bmp.readUInt32LE(10),
      infoSize: bmp.readUInt32LE(14),
      planes: bmp.readUInt16LE(26),
      compression: bmp.readUInt32LE(30),
    };
    dib = parseDIB(bmp.subarray(14));
    if (dib) {
      inkPixels = 0;
      for (let i = 0; i < dib.pixels.length; i += 4) {
        if (dib.pixels[i] < 240 || dib.pixels[i + 1] < 240 || dib.pixels[i + 2] < 240) inkPixels++;
      }
    }
  }

  const saveDialogCalls = (output.match(/GetSaveFileNameA/g) || []).length;
  const expectedInkPixels = Math.max(1, savedVsNew + reopenedVsResaved - 2);
  const checks = [
    ['emulator run completed', !runFailed],
    ['all four workflow screenshots written', screenshotsExist],
    [`Paint frame stayed fully composited (${minimumFrameCoverage} non-desktop px minimum)`,
      minimumFrameCoverage >= 50000],
    ['saved BMP exported from the virtual filesystem', bmpExists],
    [`New cleared the saved drawing (${savedVsNew} px changed)`, savedVsNew >= 30],
    [`Open restored the saved drawing (${savedVsReopened} px changed)`, savedVsReopened <= 5],
    [`drawing after Open changed the document (${reopenedVsResaved} px changed)`, reopenedVsResaved >= 20],
    ['BMP file header and stored size are valid', !!header && header.magic === 'BM' && header.fileSize === fs.statSync(bmpPath).size],
    ['BMP is an uncompressed 320x240 24-bit image', !!header && !!dib && header.pixelOffset === 54 && header.infoSize === 40 && header.planes === 1 && header.compression === 0 && dib.w === 320 && dib.h === 240 && dib.bpp === 24],
    [`resaved BMP retained both scripted strokes (${inkPixels}/${expectedInkPixels} px)`,
      inkPixels >= expectedInkPixels],
    ['Save As and Open dialogs both completed', /GetSaveFileNameA/.test(output) && /GetOpenFileNameA/.test(output) && !/open-dlg-pick: no /.test(output)],
    ['Save reused the selected filename without a second Save As dialog', saveDialogCalls === 1],
    ['file titles transitioned through saved, new, reopened, and resaved states',
      /window:saved[^\n]*title="paint-roundtrip\.bmp - Paint"/i.test(output) &&
      /window:new[^\n]*title="untitled - Paint"/i.test(output) &&
      /window:reopened[^\n]*title="paint-roundtrip\.bmp - Paint"/i.test(output) &&
      /window:resaved[^\n]*title="paint-roundtrip\.bmp - Paint"/i.test(output)],
    ['BMP write/read paths were exercised', /GetDIBits/.test(output) && /SetDIBitsToDevice/.test(output) && /WriteFile/.test(output) && /ReadFile/.test(output)],
    ['no export failure, unimplemented API, or runtime crash', !/vfs-export FAILED|UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH/.test(output)],
  ];

  if (runFailed) {
    console.error(output.split('\n').filter(line => /Error|Runtime|CRASH|STUCK|input|Stats/.test(line)).slice(-50).join('\n'));
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
