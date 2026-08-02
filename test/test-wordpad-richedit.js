#!/usr/bin/env node
// Regression coverage for WordPad's native RichEdit startup/editing path:
//   - WordPad reaches ShowWindow with a visible top-level editor window
//   - mouse focus lands on the RichEdit child
//   - keypresses route to that child
//   - typed text is present in RichEdit's own WM_GETTEXT buffer
//   - Backspace and Enter update that buffer
//   - edited text is visibly painted in the editor screenshot

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const PNG_OUT = path.join(OUT_DIR, 'hello-world-edited.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const text = 'hello world';
const seq = [
  '70:click:40:70',
  '72:dump-focus:clicked',
];
let b = 74;
for (const ch of text) {
  seq.push(`${b}:keypress:${ch.charCodeAt(0)}`);
  b += 1;
}
seq.push('95:dump-focus:typed');
seq.push('96:dump-focus-text:typed');
seq.push('100:keydown:8');
seq.push('101:keyup:8');
seq.push('104:keydown:13');
seq.push('105:keyup:13');
b = 108;
for (const ch of 'again') {
  seq.push(`${b}:keypress:${ch.charCodeAt(0)}`);
  b += 1;
}
seq.push('120:dump-focus-text:edited');
seq.push('125:dump-windows:final');
seq.push(`130:png:${PNG_OUT}`);

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=150',
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
  l.includes('dump-focus') ||
  l.includes('dump-focus-text') ||
  l.includes('dump-windows') ||
  l.includes('window:final') ||
  l.includes('[check_input_hwnd] keyboard') ||
  l.includes('[input] png') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH') ||
  l.includes('Unreachable code') ||
  l.includes('MessageBox'));
for (const l of interesting) console.log('  ' + l);

function countDarkTextPixels(pngPath) {
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  let dark = 0;
  // Tight band over the upper-left of WordPad's editor, where "hello world"
  // paints after click+typing. The blank editor baseline has 0 dark pixels
  // here in current renderer output.
  const x0 = 5, x1 = Math.min(170, png.width);
  const y0 = 50, y1 = Math.min(90, png.height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2], a = png.data[i + 3];
      if (a && r < 120 && g < 120 && b < 120) dark++;
    }
  }
  return dark;
}

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

const pngExists = fs.existsSync(PNG_OUT) && fs.statSync(PNG_OUT).size > 0;
const darkPixels = pngExists ? countDarkTextPixels(PNG_OUT) : 0;
const keyboardFocusHits = (out.match(/\[check_input_hwnd\] keyboard → focus 0x10002/g) || []).length;
const typedTextOk = /dump-focus-text typed: hwnd=0x10002 class=0 id=59648 parent=0x10001 len=11 text="hello world"/.test(out);
const editedTextOk = /dump-focus-text edited: hwnd=0x10002 class=0 id=59648 parent=0x10001 len=\d+ text="hello worl\\r?\\nagain"/.test(out);

check('WordPad reached ShowWindow', /\[ShowWindow\] hwnd=0x10001 cmd=10/.test(out));
check('top-level WordPad window visible', /window:final hwnd=65537 .*visible=true .*title="Document - WordPad"/.test(out));
check('click focused native RichEdit child', /dump-focus clicked: hwnd=0x10002 class=0 id=59648 parent=0x10001/.test(out));
check('keypresses routed to RichEdit child', keyboardFocusHits >= text.length + 'again'.length);
check('focus remained on native RichEdit after typing', /dump-focus typed: hwnd=0x10002 class=0 id=59648 parent=0x10001/.test(out));
check('typed text is readable with WM_GETTEXT', typedTextOk);
check('Backspace and Enter update RichEdit text', editedTextOk);
check('edited-text screenshot written', pngExists);
check(`edited text visibly painted (${darkPixels} dark pixels)`, darkPixels >= 50);
check('no UNIMPLEMENTED API crash', !/UNIMPLEMENTED API:/.test(out));
check('no runtime crash', !/CRASH|Unreachable code/.test(out));

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);

process.exit(failed ? 1 : 0);
