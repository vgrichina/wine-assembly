#!/usr/bin/env node
// SkiFree registers its classes with CS_OWNDC (style 0x2023) and selects
// GetStockObject(OEM_FIXED_FONT) into a GetDC exactly once, during startup. It
// then paints the four stats labels through a *later* BeginPaint DC and never
// selects a font again. Only a private per-window DC keeps that selection
// alive; hand out a fresh DC each time and the labels come back in the default
// proportional face, where "Speed:" loses its descender and reads "Sneed:".
//
// The two faces are easy to tell apart in pixels: the ANAKRON Terminal strike
// is fixed-pitch with 7 rows of ink per line plus real descenders, while the
// proportional fallback is taller and puts each line's colon somewhere else.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createCanvas, loadImage } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'entertainment-pack', 'ski32.exe');
const PNG = path.join(os.tmpdir(), `wine-assembly-skifree-stats-${process.pid}.png`);

if (!fs.existsSync(EXE)) {
  console.log('SKIP  ski32.exe not found');
  process.exit(0);
}

// The stats panel sits at a fixed place on a 640x480 screen. Labels start at
// window-local x=2 and step 12px per line, which is the pitch the app assumes
// and the height our OEM_FIXED_FONT stock object reports.
const LABEL_X0 = 414;
const LABEL_X1 = 466;   // values are drawn from window-local x=50 rightwards
const LINE_TOP = [28, 40, 52, 64];   // Time / Dist / Speed / Style
const LINE_H = 12;

const args = [
  RUN,
  `--exe=${EXE}`,
  '--no-close',
  '--screen=640x480',
  '--quiet-api',
  '--quiet-blocks',
  '--max-batches=4000',
  `--png=${PNG}`,
];

console.log('$', [process.execPath, ...args].join(' ').replace(ROOT, '.'));
const run = spawnSync(process.execPath, args, {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 300000,
  maxBuffer: 32 * 1024 * 1024,
});
const output = `${run.stdout || ''}${run.stderr || ''}`;

async function readPixels(png) {
  if (!fs.existsSync(png) || fs.statSync(png).size <= 1000) return null;
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: ctx.getImageData(0, 0, image.width, image.height).data };
}

function isInk(frame, x, y) {
  const i = (y * frame.width + x) * 4;
  return frame.data[i] < 96 && frame.data[i + 1] < 96 && frame.data[i + 2] < 96;
}

// Rows of the line band that carry any label ink, relative to the band top.
function inkRows(frame, top) {
  const rows = [];
  for (let dy = 0; dy < LINE_H; dy++) {
    for (let x = LABEL_X0; x < LABEL_X1; x++) {
      if (isInk(frame, x, top + dy)) { rows.push(dy); break; }
    }
  }
  return rows;
}

// Rightmost label column with ink anywhere in the band — the colon.
function colonX(frame, top) {
  for (let x = LABEL_X1 - 1; x >= LABEL_X0; x--) {
    for (let dy = 0; dy < LINE_H; dy++) {
      if (isInk(frame, x, top + dy)) return x;
    }
  }
  return -1;
}

(async () => {
  let frame = null;
  try {
    frame = await readPixels(PNG);
  } finally {
    try { fs.unlinkSync(PNG); } catch (_) {}
  }

  const checks = [{ name: 'CLI run exits cleanly', pass: run.status === 0 && !run.error }];
  if (!frame) {
    checks.push({ name: 'stats screenshot is written', pass: false });
  } else {
    const rows = LINE_TOP.map((top) => inkRows(frame, top));
    const colons = LINE_TOP.map((top) => colonX(frame, top));
    const [timeRows, , speedRows, styleRows] = rows;
    console.log(`ink rows per line: ${rows.map((r) => `[${r.join(',')}]`).join(' ')}`);
    console.log(`colon x per line: ${colons.join(', ')}`);

    checks.push(
      { name: 'all four stats labels are painted', pass: rows.every((r) => r.length > 0) },
      // "Time:" in the Terminal strike is the dot of its i on one row plus 7
      // rows of ink, and nothing below the baseline. The taller proportional
      // fallback that appears without CS_OWNDC covers 11 rows of the band.
      { name: 'label glyphs are the 8-row fixed strike', pass: timeRows.length === 8 },
      // "Speed:" and "Style:" are the same length, so a fixed-pitch face puts
      // their colons in the same column and a proportional one cannot.
      { name: 'equal-length labels align (fixed pitch)', pass: colons[2] > 0 && colons[2] === colons[3] },
      { name: 'shorter labels end one cell left', pass: colons[0] === colons[1] && colons[2] - colons[0] === 8 },
      // The whole visible symptom: the p of "Speed:" and the y of "Style:"
      // must reach below the baseline.
      { name: 'p of "Speed:" keeps its descender', pass: speedRows.includes(8) && speedRows.includes(9) },
      { name: 'y of "Style:" keeps its descender', pass: styleRows.includes(8) && styleRows.includes(9) },
    );
  }
  checks.push({ name: 'no runtime crash', pass: !/\*\*\* CRASH|UNIMPLEMENTED API:|LinkError/.test(output) });

  let failed = 0;
  for (const check of checks) {
    console.log(`${check.pass ? 'PASS  ' : 'FAIL  '}${check.name}`);
    if (!check.pass) failed++;
  }
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error.stack || error);
  try { fs.unlinkSync(PNG); } catch (_) {}
  process.exit(1);
});
