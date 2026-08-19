#!/usr/bin/env node
// Regression coverage for modifier-aware accelerator translation in WordPad:
// Ctrl+B / Ctrl+I / Ctrl+U should dispatch WordPad's formatting commands and
// update native RichEdit CHARFORMAT state for the selected text.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG: PNGJS } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const PLAIN_PNG = path.join(OUT_DIR, 'format-accelerators-plain.png');
const FORMATTED_PNG = path.join(OUT_DIR, 'format-accelerators.png');
const TEXT = 'style';

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const seq = [
  '70:click:40:150',
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
seq.push('100:dump-focus-state:selected');
seq.push('104:keydown:17');
seq.push('105:keydown:66');
seq.push('106:keyup:66');
seq.push('107:keyup:17');
seq.push('116:dump-focus-charformat:bold');
seq.push('120:keydown:17');
seq.push('121:keydown:73');
seq.push('122:keyup:73');
seq.push('123:keyup:17');
seq.push('132:dump-focus-charformat:bold-italic');
seq.push('136:keydown:17');
seq.push('137:keydown:85');
seq.push('138:keyup:85');
seq.push('139:keyup:17');
seq.push('148:dump-focus-charformat:bold-italic-underline');
seq.push('152:keydown:39');
seq.push('153:keyup:39');
seq.push('158:dump-focus-state:final');
seq.push(`162:png:${FORMATTED_PNG}`);
seq.push('166:stop');

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=220',
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
  l.includes('dump-focus-charformat') ||
  l.includes('png ') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH') ||
  l.includes('Unreachable code'));
for (const l of interesting) console.log('  ' + l);

function line(label, kind = 'dump-focus-charformat') {
  const prefix = `${kind} ${label}:`;
  return out.split('\n').find(l => l.includes(prefix)) || '';
}

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

const typed = line('typed', 'dump-focus-state');
const selected = line('selected', 'dump-focus-state');
const final = line('final', 'dump-focus-state');
const plain = line('plain');
const bold = line('bold');
const boldItalic = line('bold-italic');
const all = line('bold-italic-underline');

function readPng(file) {
  return PNGJS.sync.read(fs.readFileSync(file));
}

function compareTextBand(beforePath, afterPath) {
  if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) return null;

  const before = readPng(beforePath);
  const after = readPng(afterPath);
  if (before.width !== after.width || before.height !== after.height) {
    return { mismatch: true };
  }

  // WordPad's edit surface begins below the visible standard/format toolbars in
  // the fixed-size test window. Keep the region tight around the typed word so
  // caret/window chrome noise does not satisfy the visual formatting assertion.
  const x0 = 0;
  const y0 = 130;
  const x1 = Math.min(220, before.width);
  const y1 = Math.min(200, before.height);
  let changedPixels = 0;
  let darkBefore = 0;
  let darkAfter = 0;
  let diffSum = 0;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * before.width + x) * 4;
      const dr = Math.abs(before.data[i] - after.data[i]);
      const dg = Math.abs(before.data[i + 1] - after.data[i + 1]);
      const db = Math.abs(before.data[i + 2] - after.data[i + 2]);
      const delta = dr + dg + db;
      if (delta > 30) changedPixels++;
      diffSum += delta;

      if (before.data[i] < 120 && before.data[i + 1] < 120 && before.data[i + 2] < 120 && before.data[i + 3]) {
        darkBefore++;
      }
      if (after.data[i] < 120 && after.data[i + 1] < 120 && after.data[i + 2] < 120 && after.data[i + 3]) {
        darkAfter++;
      }
    }
  }

  return {
    changedPixels,
    darkBefore,
    darkAfter,
    darkDelta: darkAfter - darkBefore,
    diffSum,
  };
}

const visual = compareTextBand(PLAIN_PNG, FORMATTED_PNG);
if (visual) {
  console.log(`visual text-band diff: changed=${visual.changedPixels} darkBefore=${visual.darkBefore} darkAfter=${visual.darkAfter} darkDelta=${visual.darkDelta} diffSum=${visual.diffSum}`);
}

check('WordPad reached ShowWindow', /ShowWindow\] hwnd=0x10001/.test(out));
check('typed text reached native RichEdit', /text="style"/.test(typed));
check('plain text starts without bold/italic/underline effects',
  /bold=0 .*italic=0 .*underline=0/.test(plain));
check('Ctrl+A selected the native RichEdit text',
  /sel=0\.\.[1-9][0-9]*/.test(selected));
check('Ctrl+B accelerator toggled selected text bold',
  /bold=1 .*italic=0 .*underline=0/.test(bold));
check('Ctrl+I accelerator toggled selected text italic without dropping bold',
  /bold=1 .*italic=1 .*underline=0/.test(boldItalic));
check('Ctrl+U accelerator toggled selected text underline without dropping prior effects',
  /bold=1 .*italic=1 .*underline=1/.test(all));
check('formatting accelerators did not insert literal shortcut letters',
  /text="style"/.test(final));
check('plain formatting screenshot written', fs.existsSync(PLAIN_PNG) && fs.statSync(PLAIN_PNG).size > 0);
check('formatted screenshot written', fs.existsSync(FORMATTED_PNG) && fs.statSync(FORMATTED_PNG).size > 0);
check('bold/italic/underline formatting changes visible text pixels',
  visual &&
  !visual.mismatch &&
  visual.changedPixels >= 60 &&
  visual.darkDelta >= 20 &&
  visual.diffSum >= 20000);
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
