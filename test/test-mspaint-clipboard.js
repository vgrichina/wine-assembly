#!/usr/bin/env node

// End-to-end Win98 Paint image clipboard regression. Paint publishes copied
// selections as an MFC delayed-render IDataObject; USER clipboard APIs must
// expose a concrete CF_DIB so native Cut -> Paste works in-process.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'mspaint.exe');
const OUT = path.join(ROOT, 'scratch', 'mspaint-clipboard');
const shots = Object.fromEntries(
  ['drawn', 'cut', 'pasted'].map(name => [name, path.join(OUT, `${name}.png`)]),
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
  '19:mousedown:120:140', '20:mousemove:150:160', '21:mouseup:190:190',
  `23:png:${shots.drawn}`,
  '24:0x111:57642', // Edit > Select All
  '27:0x111:57635', // Edit > Cut
  '32:dump-clipboard:after-cut',
  `33:png:${shots.cut}`,
  '35:0x111:57637', // Edit > Paste
  `43:png:${shots.pasted}`,
  '43:dump-clipboard:after-paste',
  '44:stop',
].join(',');

let output = '';
let runFailed = false;
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input}`,
    '--max-batches=48',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
    '--trace-api=OleSetClipboard,OpenClipboard,GetClipboardData,IsClipboardFormatAvailable,CloseClipboard',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 15000, maxBuffer: 12 * 1024 * 1024 });
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

function countDark(image, box) {
  let count = 0;
  for (let y = box.y0; y < Math.min(box.y1, image.height); y++) {
    for (let x = box.x0; x < Math.min(box.x1, image.width); x++) {
      const i = (y * image.width + x) * 4;
      if (image.data[i] < 128 && image.data[i + 1] < 128 && image.data[i + 2] < 128) count++;
    }
  }
  return count;
}

(async () => {
  const filesExist = Object.values(shots).every(file =>
    fs.existsSync(file) && fs.statSync(file).size > 0);
  let drawnDark = -1;
  let cutDark = -1;
  let pastedDark = -1;
  if (filesExist) {
    const [drawn, cut, pasted] = await Promise.all(
      [shots.drawn, shots.cut, shots.pasted].map(pixels),
    );
    const lineBox = { x0: 110, y0: 130, x1: 200, y1: 170 };
    drawnDark = countDark(drawn, lineBox);
    cutDark = countDark(cut, lineBox);
    pastedDark = countDark(pasted, lineBox);
  }

  const dibDumps = output.match(/dump-clipboard (?:after-cut|after-paste):[^\n]*/g) || [];
  const checks = [
    ['emulator run completed', !runFailed],
    ['drawn, cut, and pasted screenshots written', filesExist],
    [`source line was drawn (${drawnDark} dark px)`, drawnDark >= 20],
    [`Cut cleared the selected line (${cutDark} dark px)`, cutDark <= 2],
    [`Paste restored the selected line (${pastedDark} dark px)`, pastedDark === drawnDark],
    ['Paint published an OLE clipboard object',
      dibDumps.length === 2 && dibDumps.every(line => /oleObject=0x[1-9a-f][0-9a-f]*/.test(line))],
    ['CF_DIB remained available through Cut and Paste',
      dibDumps.length === 2 && dibDumps.every(line =>
        /count=1/.test(line) && /availDib=1/.test(line) && /dibHandle=0x[1-9a-f][0-9a-f]*/.test(line))],
    ['Paste retrieved CF_DIB through the native clipboard API',
      /GetClipboardData\(0x00000008\)/.test(output)],
    ['no clipboard error dialog, crash, or unimplemented API',
      !/Error getting the Clipboard Data|UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH/.test(output)],
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
