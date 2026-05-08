#!/usr/bin/env node
// Spider MessageBox regression: after dealing a row, New Game prompts with
// MB_YESNO, and the WAT-native button captions must survive app execution.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'plus98', 'SPIDER.EXE');
const DLL  = path.join(__dirname, 'binaries', 'entertainment-pack', 'cards.dll');
const TMP  = path.join(ROOT, 'scratch');
fs.mkdirSync(TMP, { recursive: true });

if (!fs.existsSync(EXE) || !fs.existsSync(DLL)) {
  console.log('SKIP  Spider.exe/cards.dll not found');
  process.exit(0);
}

const png = path.join(TMP, 'spider_messagebox_yesno.png');
try { fs.unlinkSync(png); } catch (_) {}

const inputSpec = [
  '200:0x111:40016',      // Deal next row so the game is dirty.
  '360:0x111:40005',      // Game > New Game -> MB_YESNO confirmation.
  `430:png:${png}`,
  '440:dlg-dump:spider-msg',
].join(',');

const args = [
  RUN,
  `--exe=${EXE}`,
  `--dlls=${DLL}`,
  '--no-close',
  `--input=${inputSpec}`,
  '--max-batches=550',
  '--batch-size=50000',
  '--trace-api=MessageBoxA',
  '--quiet-api',
];

console.log('$ node', args.map(a => a.replace(ROOT, '.')).join(' '));

let out = '';
let exitCode = 0;
try {
  out = execFileSync('node', args, {
    encoding: 'utf-8',
    timeout: 120000,
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  exitCode = e.status ?? 1;
  console.log(`(run.js exited non-zero status=${exitCode} - output captured)`);
}

const pngSize = fs.existsSync(png) ? fs.statSync(png).size : 0;
let noButtonChrome = false;
if (pngSize > 0) {
  const img = PNG.sync.read(fs.readFileSync(png));
  const pixel = (x, y) => {
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]].join(',');
  };
  noButtonChrome =
    pixel(230, 140) === '255,255,255' &&  // raised top edge
    pixel(195, 152) === '255,255,255' &&  // raised left edge
    pixel(266, 152) === '64,64,64' &&     // shadow right edge
    pixel(230, 163) === '64,64,64';       // shadow bottom edge
}
const checks = [
  { name: 'process exited cleanly', pass: exitCode === 0 },
  { name: 'Spider called MessageBoxA with MB_YESNO', pass: /MessageBoxA\(.*MB_ICONQUESTION\|MB_YESNO/.test(out) },
  { name: 'Yes button text preserved', pass: /id=6 cls=1[\s\S]*text="Yes"/.test(out) },
  { name: 'No button text preserved', pass: /id=7 cls=1[\s\S]*text="No"/.test(out) },
  { name: 'No button has full raised frame', pass: noButtonChrome },
  { name: 'messagebox PNG written', pass: pngSize > 20000 },
  { name: 'no crash marker', pass: !/CRASH|LinkError/.test(out) },
];

let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log(`pngSize=${pngSize}`);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
