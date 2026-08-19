#!/usr/bin/env node
// Bricks/Klotski drag regression.
//
// Bricks calls ClipCursor while dragging and advances a piece only when the
// cursor reaches the clipped edge. The renderer must clamp mousemove coords to
// that rect; otherwise the cursor crosses past the edge and no brick moves.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'wep32-community', 'Bricks', 'bricks.exe');
const OUT = path.join(ROOT, 'scratch');
fs.mkdirSync(OUT, { recursive: true });

if (!fs.existsSync(EXE)) {
  console.log('SKIP  bricks.exe missing');
  process.exit(0);
}

const scenarios = [
  {
    name: 'horizontal',
    beforePng: path.join(OUT, 'bricks_drag_horizontal_before.png'),
    afterPng: path.join(OUT, 'bricks_drag_horizontal_after.png'),
    drag: [
      '95:mousedown:305:293',
      '96:mousemove:282:293',
      '97:mousemove:259:293',
      '98:mouseup:259:293',
    ],
    pathRe: /mousedown 305,293[\s\S]*mousemove 259,293[\s\S]*mouseup 259,293/,
  },
  {
    name: 'vertical',
    beforePng: path.join(OUT, 'bricks_drag_vertical_before.png'),
    afterPng: path.join(OUT, 'bricks_drag_vertical_after.png'),
    drag: [
      '95:mousedown:242:263',
      '96:mousemove:242:284',
      '97:mousemove:242:305',
      '98:mouseup:242:305',
    ],
    pathRe: /mousedown 242,263[\s\S]*mousemove 242,305[\s\S]*mouseup 242,305/,
  },
];

function runScenario(scenario) {
  for (const p of [scenario.beforePng, scenario.afterPng]) {
    try { fs.unlinkSync(p); } catch (_) {}
  }

  const inputSpec = [
    '50:mousedown:240:450',
    '51:mouseup:240:450',
    `85:png:${scenario.beforePng}`,
    ...scenario.drag,
    `125:png:${scenario.afterPng}`,
    '130:stop',
  ].join(',');

  const args = [
    RUN,
    `--exe=${EXE}`,
    '--no-close',
    `--input=${inputSpec}`,
    '--max-batches=150',
    '--batch-size=1000',
    '--quiet-api',
    '--quiet-blocks',
  ];

  console.log('$ node', args.map(a => a.replace(ROOT, '.')).join(' '));

  let out = '';
  let exitCode = 0;
  try {
    out = execFileSync('node', args, {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    out = (e.stdout || '').toString() + (e.stderr || '').toString();
    exitCode = e.status ?? 1;
    console.log(`(run.js exited non-zero status=${exitCode} - output captured)`);
  }

  for (const line of out.split('\n')) {
    if (/\[input\]|STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED/.test(line)) {
      console.log('  ' + line);
    }
  }

  return { ...scenario, out, exitCode };
}

async function readPixels(file) {
  const img = await loadImage(file);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
}

function countDiff(a, b, rect) {
  let diff = 0;
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      const i = (y * a.w + x) * 4;
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) diff++;
    }
  }
  return diff;
}

(async () => {
  const results = [];
  for (const scenario of scenarios) {
    const run = runScenario(scenario);
    const beforeSize = fs.existsSync(run.beforePng) ? fs.statSync(run.beforePng).size : 0;
    const afterSize = fs.existsSync(run.afterPng) ? fs.statSync(run.afterPng).size : 0;
    let boardDiff = 0;
    if (beforeSize && afterSize) {
      const before = await readPixels(run.beforePng);
      const after = await readPixels(run.afterPng);
      boardDiff = countDiff(before, after, { x0: 185, y0: 145, x1: 330, y1: 335 });
    }
    results.push({ ...run, beforeSize, afterSize, boardDiff });
  }

  const checks = [];
  for (const r of results) {
    checks.push({ name: `${r.name} bounded run exited cleanly`, pass: r.exitCode === 0 });
    checks.push({ name: `${r.name} board start click was injected`, pass: /mousedown 240,450/.test(r.out) && /mouseup 240,450/.test(r.out) });
    checks.push({ name: `${r.name} drag path was injected`, pass: r.pathRe.test(r.out) });
    checks.push({ name: `${r.name} before PNG written`, pass: r.beforeSize > 6000 });
    checks.push({ name: `${r.name} after PNG written`, pass: r.afterSize > 6000 });
    checks.push({ name: `${r.name} drag changed board pixels`, pass: r.boardDiff > 300 });
    checks.push({ name: `${r.name} no crash marker`, pass: !/STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED API:/.test(r.out) });
  }

  let failed = 0;
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  for (const r of results) {
    console.log(`${r.name}: before=${r.beforePng} size=${r.beforeSize}`);
    console.log(`${r.name}: after=${r.afterPng} size=${r.afterSize} boardDiff=${r.boardDiff}`);
  }
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
