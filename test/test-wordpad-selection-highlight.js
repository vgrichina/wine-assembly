#!/usr/bin/env node
// Regression coverage for visible native RichEdit selection painting in WordPad.
//
// Selection state has separate EM_GETSEL coverage. This test keeps a screenshot
// assertion on the paint path: selected text should render white-on-blue in the
// document band, not only update the internal range.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const PLAIN_PNG = path.join(OUT_DIR, 'selection-highlight-plain.png');
const SELECTED_PNG = path.join(OUT_DIR, 'selection-highlight.png');
const TEXT = 'select me';

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const seq = ['70:click:40:150'];
let b = 74;
for (const ch of TEXT) {
  seq.push(`${b}:keypress:${ch.charCodeAt(0)}`);
  b += 1;
}
seq.push('86:dump-focus-state:typed');
seq.push(`90:png:${PLAIN_PNG}`);
seq.push('96:keydown:17');
seq.push('97:keydown:65');
seq.push('98:keyup:65');
seq.push('99:keyup:17');
seq.push('115:dump-focus-state:selected');
seq.push(`118:png:${SELECTED_PNG}`);
seq.push('122:stop');

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=180',
  '--batch-size=50000',
  '--quiet-api',
  '--no-close',
];

console.log('$ node ' + args.map(a => JSON.stringify(a)).join(' '));

let out = '';
try {
  out = execFileSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  out = String(e.stdout || '') + String(e.stderr || '');
  console.log('(run.js exited non-zero or timed out - output captured)');
}

const interesting = out.split('\n').filter(l =>
  l.includes('ShowWindow') ||
  l.includes('dump-focus-state') ||
  l.includes('[input] png') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH') ||
  l.includes('Unreachable code'));
for (const l of interesting) console.log('  ' + l);

function line(label) {
  const marker = `dump-focus-state ${label}:`;
  return out.split('\n').find(l => l.includes(marker)) || '';
}

function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

function analyzeSelectionBand(beforePath, afterPath) {
  if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) return null;

  const before = readPng(beforePath);
  const after = readPng(afterPath);
  if (before.width !== after.width || before.height !== after.height) {
    return { mismatch: true };
  }

  // WordPad's document RichEdit starts around y=130 in the fixed 640x480 test
  // canvas. Keep the band wide enough for short text but away from toolbars.
  const x0 = 0;
  const y0 = 120;
  const x1 = Math.min(260, before.width);
  const y1 = Math.min(200, before.height);
  let changedPixels = 0;
  let diffSum = 0;
  let blueDominantBefore = 0;
  let blueDominantAfter = 0;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * before.width + x) * 4;
      const br = before.data[i];
      const bg = before.data[i + 1];
      const bb = before.data[i + 2];
      const ba = before.data[i + 3];
      const ar = after.data[i];
      const ag = after.data[i + 1];
      const ab = after.data[i + 2];
      const aa = after.data[i + 3];
      const delta = Math.abs(br - ar) + Math.abs(bg - ag) + Math.abs(bb - ab);
      if (delta > 30) changedPixels++;
      diffSum += delta;
      if (ba && bb > br + 30 && bb > bg + 30 && bb > 80) blueDominantBefore++;
      if (aa && ab > ar + 30 && ab > ag + 30 && ab > 80) blueDominantAfter++;
    }
  }

  return { changedPixels, diffSum, blueDominantBefore, blueDominantAfter };
}

const typed = line('typed');
const selected = line('selected');
const visual = analyzeSelectionBand(PLAIN_PNG, SELECTED_PNG);
if (visual) {
  console.log(`visual selection band: changed=${visual.changedPixels} diffSum=${visual.diffSum} blueBefore=${visual.blueDominantBefore} blueAfter=${visual.blueDominantAfter}`);
}

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

check('WordPad reached ShowWindow', /\[ShowWindow\] hwnd=0x10001 cmd=10/.test(out));
check('typed text reached native RichEdit', /text="select me"/.test(typed));
check('Ctrl+A selected native RichEdit text',
  /text="select me"/.test(selected) &&
  /sel=0\.\.[1-9][0-9]*/.test(selected));
check('plain screenshot written', fs.existsSync(PLAIN_PNG) && fs.statSync(PLAIN_PNG).size > 0);
check('selected screenshot written', fs.existsSync(SELECTED_PNG) && fs.statSync(SELECTED_PNG).size > 0);
check('selection highlight paints blue pixels',
  visual &&
  !visual.mismatch &&
  visual.blueDominantBefore <= 5 &&
  visual.blueDominantAfter >= 500 &&
  visual.changedPixels >= 500 &&
  visual.diffSum >= 100000);
check('no UNIMPLEMENTED API crash', !/UNIMPLEMENTED API:/.test(out));
check('no runtime crash', !/CRASH|Unreachable code|EIP=0x00000000/.test(out));

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);

process.exit(failed ? 1 : 0);
