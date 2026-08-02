#!/usr/bin/env node
// Regression coverage for native RichEdit text-color rendering in WordPad.
//
// This intentionally probes the focused RichEdit control directly with
// EM_SETCHARFORMAT(CFM_COLOR). WordPad's own color toolbar/menu command route is
// a separate UI gap: the current format bar exists as a zero-sized toolbar and
// direct color command IDs do not yet carry WordPad's palette state correctly.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG: PNGJS } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const PLAIN_PNG = path.join(OUT_DIR, 'richedit-color-plain.png');
const BLUE_PNG = path.join(OUT_DIR, 'richedit-color-blue.png');
const TEXT = 'color';
// Win32 COLORREF is 0x00BBGGRR, so 0x00ff0000 paints blue.
const COLORREF_BLUE = 0x00ff0000;

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const seq = [
  '70:click:40:70',
];
let b = 74;
for (const ch of TEXT) {
  seq.push(`${b}:keypress:${ch.charCodeAt(0)}`);
  b += 1;
}
seq.push('84:dump-focus-state:typed');
seq.push('86:dump-focus-charformat:plain');
seq.push(`88:png:${PLAIN_PNG}`);
seq.push('94:keydown:17');
seq.push('95:keydown:65');
seq.push('96:keyup:65');
seq.push('97:keyup:17');
seq.push(`104:set-focus-charformat-color:0x${COLORREF_BLUE.toString(16).padStart(8, '0')}:blue`);
seq.push('122:dump-focus-charformat:after-blue');
seq.push('126:dump-focus-state:after-blue');
seq.push('132:keydown:39'); // collapse selection before the visual assertion
seq.push('133:keyup:39');
seq.push(`148:png:${BLUE_PNG}`);
seq.push('152:stop');

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=220',
  '--batch-size=50000',
  '--quiet-api',
  '--trace-api=SendMessageA,SetTextColor',
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
  l.includes('set-focus-charformat-color') ||
  l.includes('dump-focus-state') ||
  l.includes('dump-focus-charformat') ||
  l.includes('png ') ||
  (l.includes('SetTextColor') && l.includes('0xff0000')) ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH') ||
  l.includes('Unreachable code'));
for (const l of interesting) console.log('  ' + l);

function line(label, kind = 'dump-focus-charformat') {
  const prefix = `${kind} ${label}:`;
  return out.split('\n').find(l => l.includes(prefix)) || '';
}

function readPng(file) {
  return PNGJS.sync.read(fs.readFileSync(file));
}

function analyzeTextBand(beforePath, afterPath) {
  if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) return null;

  const before = readPng(beforePath);
  const after = readPng(afterPath);
  if (before.width !== after.width || before.height !== after.height) {
    return { mismatch: true };
  }

  const x0 = 0;
  const y0 = 45;
  const x1 = Math.min(220, before.width);
  const y1 = Math.min(95, before.height);
  let changedPixels = 0;
  let diffSum = 0;
  let darkBefore = 0;
  let darkAfter = 0;
  let blueBefore = 0;
  let blueAfter = 0;

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

      if (ba && br < 120 && bg < 120 && bb < 120) darkBefore++;
      if (aa && ar < 120 && ag < 120 && ab < 120) darkAfter++;
      if (ba && bb > 120 && br < 100 && bg < 100) blueBefore++;
      if (aa && ab > 120 && ar < 100 && ag < 100) blueAfter++;
    }
  }

  return {
    changedPixels,
    diffSum,
    darkBefore,
    darkAfter,
    blueBefore,
    blueAfter,
  };
}

const typed = line('typed', 'dump-focus-state');
const afterBlueState = line('after-blue', 'dump-focus-state');
const plain = line('plain');
const afterBlue = line('after-blue');
const setBlue = out.split('\n').find(l => l.includes('set-focus-charformat-color blue:')) || '';
const visual = analyzeTextBand(PLAIN_PNG, BLUE_PNG);
if (visual) {
  console.log(`visual text-band color: changed=${visual.changedPixels} diffSum=${visual.diffSum} darkBefore=${visual.darkBefore} darkAfter=${visual.darkAfter} blueBefore=${visual.blueBefore} blueAfter=${visual.blueAfter}`);
}

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

check('WordPad reached ShowWindow', /ShowWindow\] hwnd=0x10001/.test(out));
check('typed text reached native RichEdit', /text="color"/.test(typed));
check('plain text starts with automatic black color',
  /effects=0x40000000/.test(plain) &&
  /color=0x0/.test(plain));
check('direct CFM_COLOR setter returned success',
  /color=0xff0000/.test(setBlue) &&
  /ret=0x1/.test(setBlue));
check('RichEdit reports blue COLORREF with autocolor cleared',
  /effects=0x0/.test(afterBlue) &&
  /color=0xff0000/.test(afterBlue));
check('text color formatting did not corrupt editor text', /text="color"/.test(afterBlueState));
check('GDI text renderer used the blue COLORREF',
  /SetTextColor\(.*0xff0000/.test(out));
check('plain color screenshot written', fs.existsSync(PLAIN_PNG) && fs.statSync(PLAIN_PNG).size > 0);
check('blue color screenshot written', fs.existsSync(BLUE_PNG) && fs.statSync(BLUE_PNG).size > 0);
check('blue color changes visible text pixels',
  visual &&
  !visual.mismatch &&
  visual.blueBefore <= 2 &&
  visual.blueAfter >= 20 &&
  visual.changedPixels >= 40 &&
  visual.diffSum >= 5000);
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
