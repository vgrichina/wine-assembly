#!/usr/bin/env node
// Spider regression: its top-level "Deal!" menu item is a command, not a
// popup. Clicking it must post WM_COMMAND 40016 and deal a row.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'plus98', 'SPIDER.EXE');
const DLL = path.join(__dirname, 'binaries', 'entertainment-pack', 'cards.dll');
const TMP = path.join(ROOT, 'scratch');
fs.mkdirSync(TMP, { recursive: true });

if (!fs.existsSync(EXE) || !fs.existsSync(DLL)) {
  console.log('SKIP  Spider.exe/cards.dll not found');
  process.exit(0);
}

const beforePng = path.join(TMP, 'spider_deal_menu_before.png');
const afterPng = path.join(TMP, 'spider_deal_menu_after.png');
for (const p of [beforePng, afterPng]) {
  try { fs.unlinkSync(p); } catch (_) {}
}

const inputSpec = [
  `200:png:${beforePng}`,
  '260:click:72:31',
  `700:png:${afterPng}`,
].join(',');

const args = [
  RUN,
  `--exe=${EXE}`,
  `--dlls=${DLL}`,
  '--no-close',
  `--input=${inputSpec}`,
  '--max-batches=850',
  '--batch-size=50000',
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

function sizeOf(p) {
  return fs.existsSync(p) ? fs.statSync(p).size : 0;
}

function diffPixels(aPath, bPath) {
  if (!fs.existsSync(aPath) || !fs.existsSync(bPath)) return 0;
  const a = PNG.sync.read(fs.readFileSync(aPath));
  const b = PNG.sync.read(fs.readFileSync(bPath));
  if (a.width !== b.width || a.height !== b.height) return 0;
  let diff = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] ||
        a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2]) {
      diff++;
    }
  }
  return diff;
}

const beforeSize = sizeOf(beforePng);
const afterSize = sizeOf(afterPng);
const diff = diffPixels(beforePng, afterPng);

const checks = [
  { name: 'process exited cleanly', pass: exitCode === 0 },
  { name: 'baseline PNG written', pass: beforeSize > 20000 },
  { name: 'after-click PNG written', pass: afterSize > 20000 },
  { name: 'Deal! top-level command changed Spider board', pass: diff > 10000 },
  { name: 'no crash marker', pass: !/CRASH|LinkError|UNIMPLEMENTED API:/.test(out) },
];

let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log(`sizes: before=${beforeSize} after=${afterSize} diff=${diff}`);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
