#!/usr/bin/env node
// Calculator About regression: ShellAboutA is WAT-built, but it must still
// expose and paint its native STATIC/BUTTON children like Win98's modal shell
// dialog path.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'calc.exe');
const OUT = path.join(ROOT, 'scratch');
fs.mkdirSync(OUT, { recursive: true });

if (!fs.existsSync(EXE)) {
  console.log('SKIP  calc.exe missing');
  process.exit(0);
}

const png = path.join(OUT, 'calc_about.png');
try { fs.unlinkSync(png); } catch (_) {}

const inputSpec = [
  '80:0x111:302',
  `130:png:${png}`,
  '135:dlg-dump:calc-about',
].join(',');

const args = [
  RUN,
  `--exe=${EXE}`,
  '--no-close',
  `--input=${inputSpec}`,
  '--max-batches=180',
  '--batch-size=50000',
  '--quiet-api',
];

console.log('$ node', args.map(a => a.replace(ROOT, '.')).join(' '));

function runCase(caseArgs) {
  let out = '';
  let exitCode = 0;
  try {
    out = execFileSync('node', caseArgs, {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    out = (e.stdout || '').toString() + (e.stderr || '').toString();
    exitCode = e.status ?? 1;
    console.log(`(run.js exited non-zero status=${exitCode} - output captured)`);
  }
  return { out, exitCode };
}

const first = runCase(args);

const closeArgs = [
  RUN,
  `--exe=${EXE}`,
  '--no-close',
  '--input=80:0x111:302,110:click:326:52,140:click:291:12',
  '--max-batches=240',
  '--batch-size=50000',
  '--trace-api=ShellAboutA,PostQuitMessage',
  '--quiet-api',
];
console.log('$ node', closeArgs.map(a => a.replace(ROOT, '.')).join(' '));
const closeRun = runCase(closeArgs);

let out = first.out;
let exitCode = first.exitCode;

function aboutInkPixels(pngPath) {
  if (!fs.existsSync(pngPath)) return 0;
  const img = PNG.sync.read(fs.readFileSync(pngPath));
  let ink = 0;
  // About dialog is centered at 80,40 in this harness. Count client-area
  // pixels that are not flat COLOR_3DFACE; text, OK button bevels, and icon
  // details all count as ink.
  for (let y = 64; y < 192 && y < img.height; y++) {
    for (let x = 84; x < 336 && x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      const btnFace = Math.abs(r - 192) <= 2 && Math.abs(g - 192) <= 2 && Math.abs(b - 192) <= 2;
      if (!btnFace) ink++;
    }
  }
  return ink;
}

const pngSize = fs.existsSync(png) ? fs.statSync(png).size : 0;
const ink = aboutInkPixels(png);
const checks = [
  { name: 'process exited cleanly', pass: exitCode === 0 },
  { name: 'ShellAboutA called for Calculator', pass: /\[ShellAbout\].*"Calculator"/.test(out) },
  { name: 'About dialog children exist', pass: /dlg-dump:calc-about:[\s\S]*text="OK"/.test(out) },
  { name: 'About PNG written', pass: pngSize > 8000 },
  { name: 'About child controls painted', pass: ink > 1200 },
  { name: 'About titlebar close permits main close', pass: closeRun.exitCode === 0 && /\[Exit\] code=0/.test(closeRun.out) },
  { name: 'no crash marker', pass: !/CRASH|LinkError|UNIMPLEMENTED API:/.test(out) },
];

let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log(`pngSize=${pngSize} aboutInk=${ink}`);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
