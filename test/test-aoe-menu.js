#!/usr/bin/env node
// Age of Empires menu regression.
//
// AoE creates its pause/menu UI from game code after the top "Menu" button is
// clicked. A stale low-memory GDI palette table used to overwrite WND_RECORDS,
// so the menu object existed but never visibly painted. This test drives the
// shareware demo to gameplay, verifies a unit click visibly selects a unit,
// opens Menu, clicks Cancel, and opens Menu again.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createCanvas, loadImage } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'shareware', 'aoe', 'aoe_ex', 'Empires.exe');
const OUT = path.join(ROOT, 'scratch');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  Empires.exe not found');
  process.exit(0);
}
if (!createCanvas || !loadImage) {
  console.log('SKIP  canvas backend not available');
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });

const beforePng = path.join(OUT, 'aoe_menu_before.png');
const selectedPng = path.join(OUT, 'aoe_unit_selected.png');
const menu1Png = path.join(OUT, 'aoe_menu_open.png');
const cancelPng = path.join(OUT, 'aoe_menu_cancelled.png');
const menu2Png = path.join(OUT, 'aoe_menu_reopened.png');
for (const p of [beforePng, selectedPng, menu1Png, cancelPng, menu2Png]) {
  try { fs.unlinkSync(p); } catch (_) {}
}

const startup = [
  '1500:click:320:200',
  '2600:click:320:190',
  '3300:keypress:65',
  '3301:keypress:79',
  '3302:keypress:69',
  '3800:click:240:305',
  '5200:click:190:455',
  '12000:click:320:190',
  '30000:keypress:65',
  '30001:keypress:79',
  '30002:keypress:69',
  '50000:click:240:305',
  '82000:click:190:455',
  '230000:click:560:465',
];

const inputSpec = [
  ...startup,
  `255000:png:${beforePng}`,
  '257000:click:105:150',
  `259000:png:${selectedPng}`,
  '262000:click:608:8',
  `272000:png:${menu1Png}`,
  '282000:click:320:382',
  `297000:png:${cancelPng}`,
  '307000:click:608:8',
  `327000:png:${menu2Png}`,
  '327001:stop',
].join(',');

const args = [
  RUN,
  `--exe=${EXE}`,
  '--no-build',
  '--max-batches=328000',
  '--quiet-api',
  '--quiet-blocks',
  `--input=${inputSpec}`,
];

console.log('$ node', args.map(a => a.replace(ROOT, '.')).join(' '));

let out = '';
let exitCode = 0;
try {
  out = execFileSync('node', args, {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 480000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  exitCode = e.status ?? 1;
  console.log(`(run.js exited non-zero status=${exitCode} - output captured)`);
}

for (const line of out.split('\n')) {
  if (/\[input\]|STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED|MessageBox/.test(line)) {
    console.log('  ' + line);
  }
}

async function readPixels(file) {
  const img = await loadImage(file);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
}

function clampRect(img, rect) {
  return {
    x0: Math.max(0, Math.min(img.w, rect.x0)),
    y0: Math.max(0, Math.min(img.h, rect.y0)),
    x1: Math.max(0, Math.min(img.w, rect.x1)),
    y1: Math.max(0, Math.min(img.h, rect.y1)),
  };
}

function tanRatio(img, rect) {
  const r = clampRect(img, rect);
  let tan = 0;
  let total = 0;
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const i = (y * img.w + x) * 4;
      const red = img.data[i];
      const green = img.data[i + 1];
      const blue = img.data[i + 2];
      if (red >= 105 && green >= 70 && blue >= 40 && red >= green && green >= blue && red - blue >= 35) {
        tan++;
      }
      total++;
    }
  }
  return total ? tan / total : 0;
}

function darkRatio(img, rect) {
  const r = clampRect(img, rect);
  let dark = 0;
  let total = 0;
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const i = (y * img.w + x) * 4;
      if (img.data[i] < 55 && img.data[i + 1] < 55 && img.data[i + 2] < 55) {
        dark++;
      }
      total++;
    }
  }
  return total ? dark / total : 0;
}

function diffRect(a, b, rect) {
  if (a.w !== b.w || a.h !== b.h) return -1;
  const r = clampRect(a, rect);
  let diff = 0;
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const i = (y * a.w + x) * 4;
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) {
        diff++;
      }
    }
  }
  return diff;
}

(async () => {
  const checks = [];
  const pngs = [
    ['before gameplay snapshot written', beforePng],
    ['selected unit snapshot written', selectedPng],
    ['first menu snapshot written', menu1Png],
    ['cancelled gameplay snapshot written', cancelPng],
    ['reopened menu snapshot written', menu2Png],
  ];
  for (const [name, file] of pngs) {
    checks.push({ name, pass: fs.existsSync(file) && fs.statSync(file).size > 1000 });
  }

  let before = null;
  let selected = null;
  let menu1 = null;
  let cancelled = null;
  let menu2 = null;
  if (checks.every(c => c.pass)) {
    before = await readPixels(beforePng);
    selected = await readPixels(selectedPng);
    menu1 = await readPixels(menu1Png);
    cancelled = await readPixels(cancelPng);
    menu2 = await readPixels(menu2Png);
  }

  const menuRect = { x0: 200, y0: 95, x1: 600, y1: 505 };
  if (before && selected && menu1 && cancelled && menu2) {
    const selectionRect = { x0: 0, y0: 380, x1: 115, y1: 475 };
    const beforeDark = darkRatio(before, selectionRect);
    const selectedDark = darkRatio(selected, selectionRect);
    const selectDiff = diffRect(before, selected, selectionRect);
    console.log(`  selection panel dark ratio before=${beforeDark.toFixed(3)} selected=${selectedDark.toFixed(3)} diff=${selectDiff}px`);

    const beforeTan = tanRatio(before, menuRect);
    const menu1Tan = tanRatio(menu1, menuRect);
    const cancelledTan = tanRatio(cancelled, menuRect);
    const menu2Tan = tanRatio(menu2, menuRect);
    const openDiff = diffRect(before, menu1, menuRect);
    const closeDiff = diffRect(menu1, cancelled, menuRect);
    const reopenDiff = diffRect(cancelled, menu2, menuRect);
    console.log(`  tan ratio before=${beforeTan.toFixed(3)} menu1=${menu1Tan.toFixed(3)} cancelled=${cancelledTan.toFixed(3)} menu2=${menu2Tan.toFixed(3)}`);
    console.log(`  central diff open=${openDiff}px close=${closeDiff}px reopen=${reopenDiff}px`);

    checks.push({ name: 'Unit click visibly selects a unit', pass: selectedDark >= beforeDark + 0.25 && selectDiff > 3000 });
    checks.push({ name: 'Menu click visibly opens the pause dialog', pass: menu1Tan >= beforeTan + 0.25 && openDiff > 40000 });
    checks.push({ name: 'Cancel visibly removes the pause dialog', pass: cancelledTan <= menu1Tan - 0.20 && closeDiff > 40000 });
    checks.push({ name: 'Menu can be reopened after Cancel', pass: menu2Tan >= cancelledTan + 0.25 && reopenDiff > 40000 });
  } else {
    checks.push({ name: 'PNG analysis completed', pass: false });
  }

  checks.push({ name: 'Unit input click was injected', pass: /\[input\] click 105,150 at batch 257000/.test(out) });
  checks.push({ name: 'Menu input click was injected', pass: /\[input\] click 608,8 at batch 262000/.test(out) });
  checks.push({ name: 'Cancel input click was injected', pass: /\[input\] click 320,382 at batch 282000/.test(out) });
  checks.push({ name: 'no crash marker', pass: exitCode === 0 && !/STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED API:/.test(out) });

  console.log('');
  let failed = 0;
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  console.log('');
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  console.log(`Snapshots: ${beforePng} ${selectedPng} ${menu1Png} ${cancelPng} ${menu2Png}`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
