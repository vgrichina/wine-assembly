#!/usr/bin/env node

// Paint must protect a modified untitled document when File > New is used.
// Cancel preserves the current image; No discards it and creates a blank one.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'mspaint.exe');
const OUT = path.join(ROOT, 'scratch', 'mspaint-dirty-new');
const shots = Object.fromEntries(
  ['dirty', 'cancelled', 'discarded'].map(name => [name, path.join(OUT, `${name}.png`)]),
);

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
for (const file of Object.values(shots)) {
  try { fs.unlinkSync(file); } catch (_) {}
}

const input = [
  '18:click:39:146',
  '28:mousedown:120:140', '29:mousemove:150:160', '30:mouseup:190:190',
  `38:png:${shots.dirty}`,
  '45:0x111:57600',                       // File > New
  '60:dlg-dump:first-prompt',
  '62:dlg-cmd:2',                         // Cancel
  `75:png:${shots.cancelled}`,
  '75:dump-windows:cancelled',
  '80:0x111:57600',
  '95:dlg-dump:second-prompt',
  '97:dlg-cmd:7',                         // No
  `110:png:${shots.discarded}`,
  '110:dump-windows:discarded',
  '111:stop',
].join(',');

let output = '';
let runFailed = false;
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input}`,
    '--max-batches=115',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
    '--trace-api=MessageBoxA',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
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
  let dirtyVsCancelled = -1;
  let dirtyVsDiscarded = -1;
  let minimumFrameCoverage = -1;
  if (screenshotsExist) {
    const [dirty, cancelled, discarded] = await Promise.all(
      [shots.dirty, shots.cancelled, shots.discarded].map(pixels),
    );
    const canvasBox = { x0: 82, y0: 62, x1: 292, y1: 304 };
    dirtyVsCancelled = countDiff(dirty, cancelled, canvasBox);
    dirtyVsDiscarded = countDiff(dirty, discarded, canvasBox);
    const frameBox = { x0: 20, y0: 20, x1: 295, y1: 420 };
    minimumFrameCoverage = Math.min(...[dirty, cancelled, discarded]
      .map(image => countNonDesktop(image, frameBox)));
  }

  const promptCount = (output.match(/Save changes to untitled\?/g) || []).length;
  const checks = [
    ['emulator run completed', !runFailed],
    ['all three workflow screenshots written', screenshotsExist],
    [`Paint frame stayed fully composited (${minimumFrameCoverage} non-desktop px minimum)`,
      minimumFrameCoverage >= 50000],
    ['both New commands displayed the dirty-document prompt', promptCount >= 4],
    ['prompt provides Yes, No, and Cancel choices',
      /dlg-dump:first-prompt:[^\n]*id=6[^\n]*text="Yes"[^\n]*id=7[^\n]*text="No"[^\n]*id=2[^\n]*text="Cancel"/.test(output)],
    ['Cancel and No commands reached a modal dialog',
      /dlg-cmd: cmd=2 hwnd=0x[0-9a-f]+/.test(output) && /dlg-cmd: cmd=7 hwnd=0x[0-9a-f]+/.test(output)],
    [`Cancel preserved the drawing (${dirtyVsCancelled} px changed)`, dirtyVsCancelled <= 5],
    [`No discarded the drawing (${dirtyVsDiscarded} px changed)`, dirtyVsDiscarded >= 30],
    ['Cancel kept the untitled Paint document open',
      /window:cancelled[^\n]*visible=true[^\n]*title="untitled - Paint"/i.test(output)],
    ['No produced a visible blank untitled Paint document',
      /window:discarded[^\n]*visible=true[^\n]*title="untitled - Paint"/i.test(output)],
    ['no missing dialog, unimplemented API, or runtime crash',
      !/NO DIALOG|UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH/.test(output)],
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
