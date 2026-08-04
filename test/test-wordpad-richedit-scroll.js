#!/usr/bin/env node
// Regression coverage for WordPad native RichEdit mouse selection and scrolling:
//   - mouse drag changes the native RichEdit EM_GETSEL range
//   - long multiline text inserts into the native RichEdit buffer
//   - renderer wheel routing reaches the focused native RichEdit child
//   - renderer native-scrollbar thumb drag reaches the focused RichEdit child
//   - a screenshot is captured after the scrolled document state

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const PNG_OUT = path.join(OUT_DIR, 'mouse-scroll.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const seq = ['70:click:40:150'];
let b = 74;

function push(action, step = 1) {
  seq.push(`${b}:${action}`);
  b += step;
}

function typeText(text) {
  for (const ch of text) push(`keypress:${ch.charCodeAt(0)}`);
}

function enter() {
  push('keydown:13');
  push('keyup:13');
}

function ctrlKey(vk) {
  push('keydown:17');
  push(`keydown:${vk}`);
  push(`keyup:${vk}`);
  push('keyup:17');
}

typeText('mouse select');
push('dump-focus-state:typed', 8);
push('mousedown:10:150', 2);
push('mousemove:120:150', 2);
push('mouseup:120:150', 6);
push('dump-focus-state:dragged', 8);

ctrlKey(65); // Ctrl+A
for (let i = 0; i < 35; i++) {
  typeText(`line${String(i).padStart(2, '0')}`);
  if (i !== 34) enter();
}
push('dump-focus-state:long-before-wheel', 8);
push('wheel:200:170:-120', 4);
push('wheel:200:170:-120', 4);
push('wheel:200:170:-120', 8);
push('dump-focus-state:long-after-wheel', 8);
push('mousedown:390:225', 2);
push('mousemove:390:160', 2);
push('mouseup:390:160', 8);
push('dump-focus-state:long-after-thumb', 8);
push(`png:${PNG_OUT}`, 4);
push('stop', 1);

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  `--max-batches=${b + 40}`,
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
  l.includes('[input] wheel') ||
  l.includes('[input] png') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH') ||
  l.includes('Unreachable code') ||
  l.includes('MessageBox'));
for (const l of interesting) console.log('  ' + l);

function state(label) {
  const line = out.split('\n').find(l => l.includes(`dump-focus-state ${label}:`));
  if (!line) return null;
  const m = line.match(/len=(\d+) sel=(\d+)\.\.(\d+) .*firstVisible=(\d+) lineCount=(\d+) text=(".*") at batch/);
  if (!m) return null;
  return {
    line,
    len: parseInt(m[1], 10),
    selStart: parseInt(m[2], 10),
    selEnd: parseInt(m[3], 10),
    firstVisible: parseInt(m[4], 10),
    lineCount: parseInt(m[5], 10),
    text: JSON.parse(m[6]),
  };
}

function countDarkPixels(pngPath) {
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  let dark = 0;
  for (let y = 125; y < Math.min(285, png.height); y++) {
    for (let x = 5; x < Math.min(220, png.width); x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2], a = png.data[i + 3];
      if (a && r < 120 && g < 120 && b < 120) dark++;
    }
  }
  return dark;
}

const typed = state('typed');
const dragged = state('dragged');
const longBefore = state('long-before-wheel');
const longAfter = state('long-after-wheel');
const longAfterThumb = state('long-after-thumb');
const pngExists = fs.existsSync(PNG_OUT) && fs.statSync(PNG_OUT).size > 0;
const darkPixels = pngExists ? countDarkPixels(PNG_OUT) : 0;

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

check('WordPad reached ShowWindow', /\[ShowWindow\] hwnd=0x10001 cmd=10/.test(out));
check('typed text reached native RichEdit', typed && typed.text === 'mouse select');
check('mouse drag selected native RichEdit text', dragged && dragged.text === 'mouse select' && dragged.selStart !== dragged.selEnd);
check('long multiline text inserted', longBefore && longBefore.text.includes('line00\r\nline01') && longBefore.text.includes('line34') && longBefore.lineCount >= 35);
check('long text auto-scrolled to caret', longBefore && longBefore.firstVisible > 0);
check('mouse wheel routed to native RichEdit scroll', longBefore && longAfter && longAfter.firstVisible < longBefore.firstVisible);
check('scrollbar thumb drag routed to native RichEdit scroll', longAfter && longAfterThumb && longAfterThumb.firstVisible < longAfter.firstVisible);
check('scrolled screenshot written', pngExists);
check(`scrolled text visibly painted (${darkPixels} dark pixels)`, darkPixels >= 50);
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
