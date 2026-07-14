#!/usr/bin/env node
// CWordZap's WM_SIZE handler enforces a square window with MoveWindow. A
// same-size MoveWindow must not generate another WM_SIZE, or the app loops
// forever before painting. Its splash is also a BI_RLE4 DIB whose color table
// contains logical-palette indices (DIB_PAL_COLORS).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'wep32-community', 'Wordzap', 'CWordZap.exe');
const PNG_PATH = path.join(ROOT, 'scratch', 'cwordzap_render.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  CWordZap.exe not found');
  process.exit(0);
}

fs.mkdirSync(path.dirname(PNG_PATH), { recursive: true });
try { fs.unlinkSync(PNG_PATH); } catch (_) {}

const args = [
  RUN,
  `--exe=${EXE}`,
  '--max-batches=20',
  '--batch-size=100000',
  '--no-close',
  '--quiet-api',
  '--quiet-blocks',
  '--trace-api-counts',
  '--api-counts-top=100',
  `--png=${PNG_PATH}`,
];
console.log('$ node', args.map(a => a.replace(ROOT, '.')).join(' '));

let out = '';
let exitCode = 0;
try {
  out = execFileSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  exitCode = e.status ?? 1;
}

function apiCount(name) {
  const m = out.match(new RegExp(`^\\s+(\\d+)\\s+${name}$`, 'm'));
  return m ? Number(m[1]) : 0;
}

const totalMatch = out.match(/Stats: (\d+) API calls/);
const totalApiCalls = totalMatch ? Number(totalMatch[1]) : Infinity;
const png = fs.existsSync(PNG_PATH) ? PNG.sync.read(fs.readFileSync(PNG_PATH)) : null;
let whiteShare = 0;
let saturatedShare = 0;
if (png) {
  let white = 0, saturated = 0;
  const total = png.width * png.height;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    if (r > 235 && g > 235 && b > 235) white++;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max > 160 && max - min > 120) saturated++;
  }
  whiteShare = white / total;
  saturatedShare = saturated / total;
}

const checks = [
  { name: 'run.js exited cleanly', pass: exitCode === 0 },
  { name: 'same-size MoveWindow does not loop', pass: apiCount('MoveWindow') === 2 && totalApiCalls < 1000 },
  { name: 'RLE4 splash reaches StretchDIBits', pass: apiCount('StretchDIBits') >= 1 },
  { name: 'CWordZap title is initialized', pass: out.includes('C L A S S I C  W O R D Z A P -- An Addictionary Game') },
  { name: 'splash screenshot is written', pass: !!png && png.width === 640 && png.height === 480 },
  // The decoded splash has a large white field plus the saturated logo. When
  // RLE command bytes are mistaken for raw 4bpp rows, white falls below 30%.
  { name: 'RLE4 splash has coherent white field', pass: whiteShare > 0.5 },
  { name: 'RLE4 splash retains colored logo', pass: saturatedShare > 0.1 },
];

let failed = 0;
for (const check of checks) {
  console.log((check.pass ? 'PASS  ' : 'FAIL  ') + check.name);
  if (!check.pass) failed++;
}
console.log(`metrics: api=${totalApiCalls} MoveWindow=${apiCount('MoveWindow')} ` +
  `StretchDIBits=${apiCount('StretchDIBits')} white=${whiteShare.toFixed(3)} saturated=${saturatedShare.toFixed(3)}`);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
