#!/usr/bin/env node
// Regression coverage for native USER caret painting in WordPad's RichEdit.
//
// WordPad's native RichEdit calls CreateCaret/SetCaretPos/ShowCaret. The
// emulator must keep enough USER caret state to leave a visible caret stroke
// in screenshots and blink/erase it without corrupting the backing store; WAT
// EDIT focus flags do not cover this native-control path.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const PNG_ON = path.join(OUT_DIR, 'caret-on.png');
const PNG_OFF = path.join(OUT_DIR, 'caret-off.png');
const PNG_ON_AGAIN = path.join(OUT_DIR, 'caret-on-again.png');
const TEXT = 'caret';

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const seq = [
  '70:click:40:150',
  '72:dump-focus-state:clicked',
];
let b = 74;
for (const ch of TEXT) {
  seq.push(`${b}:keypress:${ch.charCodeAt(0)}`);
  b += 1;
}
seq.push('86:dump-focus-state:typed');
seq.push('88:dump-windows:caret');
seq.push('90:keydown:37');
seq.push('91:keydown:39');
seq.push(`92:png:${PNG_ON}`);
seq.push('93:sleep-ms:560');
seq.push(`94:png:${PNG_OFF}`);
seq.push('95:sleep-ms:560');
seq.push(`96:png:${PNG_ON_AGAIN}`);
seq.push('100:stop');

const traceApis = [
  'CreateCaret',
  'SetCaretPos',
  'ShowCaret',
  'HideCaret',
  'DestroyCaret',
  'GetCaretPos',
].join(',');

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=140',
  '--batch-size=50000',
  '--quiet-api',
  '--quiet-blocks',
  `--trace-api=${traceApis}`,
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

for (const line of out.split('\n')) {
  if (
    line.includes('ShowWindow') ||
    line.includes('dump-focus-state') ||
    line.includes('window:caret') ||
    line.includes('CreateCaret') ||
    line.includes('SetCaretPos') ||
    line.includes('ShowCaret') ||
    line.includes('HideCaret') ||
    line.includes('[input] png') ||
    line.includes('UNIMPLEMENTED') ||
    line.includes('CRASH') ||
    line.includes('Unreachable code')
  ) {
    console.log('  ' + line);
  }
}

function parseNumber(s) {
  if (!s) return null;
  return /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
}

function parseLastCaretPos(text) {
  let pos = null;
  for (const line of text.split('\n')) {
    if (!line.includes('SetCaretPos')) continue;
    const m = /SetCaretPos\((?:x=)?(0x[0-9a-f]+|\d+),\s*(?:y=)?(0x[0-9a-f]+|\d+)/i.exec(line);
    if (m) pos = { x: parseNumber(m[1]), y: parseNumber(m[2]) };
  }
  return pos;
}

function parseRichEditClientOrigin(text) {
  let topClient = null;
  let childPos = null;
  for (const line of text.split('\n')) {
    if (!line.includes('window:caret')) continue;
    if (line.includes('hwnd=65537 ')) {
      const client = /client=\{"x":(-?\d+),"y":(-?\d+),"w":(-?\d+),"h":(-?\d+)\}/.exec(line);
      if (client) {
        topClient = {
          x: parseInt(client[1], 10),
          y: parseInt(client[2], 10),
          w: parseInt(client[3], 10),
          h: parseInt(client[4], 10),
        };
      }
    }
    if (line.includes('ctrlId=59648')) {
      const pos = /pos=(-?\d+),(-?\d+) size=(-?\d+)x(-?\d+)/.exec(line);
      if (pos) {
        childPos = {
          x: parseInt(pos[1], 10),
          y: parseInt(pos[2], 10),
          w: parseInt(pos[3], 10),
          h: parseInt(pos[4], 10),
        };
      }
    }
  }
  if (topClient && childPos) {
    return {
      x: topClient.x + childPos.x,
      y: topClient.y + childPos.y,
      w: childPos.w,
      h: childPos.h,
    };
  }
  for (const line of text.split('\n')) {
    if (!line.includes('window:caret') || !line.includes('ctrlId=59648')) continue;
    const pos = /pos=(-?\d+),(-?\d+) size=(-?\d+)x(-?\d+)/.exec(line);
    if (pos) {
      return {
        x: parseInt(pos[1], 10),
        y: parseInt(pos[2], 10),
        w: parseInt(pos[3], 10),
        h: parseInt(pos[4], 10),
      };
    }
  }
  return null;
}

function analyzeCaretStroke(file, origin, pos) {
  if (!fs.existsSync(file) || !origin || !pos) return null;
  const png = PNG.sync.read(fs.readFileSync(file));
  const expectedX = origin.x + pos.x;
  const expectedY = origin.y + pos.y;
  const x0 = Math.max(0, expectedX - 3);
  const x1 = Math.min(png.width - 1, expectedX + 4);
  const y0 = Math.max(0, expectedY - 1);
  const y1 = Math.min(png.height - 1, expectedY + 18);
  let maxColumnDark = 0;
  let maxColumnX = -1;

  for (let x = x0; x <= x1; x++) {
    let dark = 0;
    for (let y = y0; y <= y1; y++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i];
      const g = png.data[i + 1];
      const bl = png.data[i + 2];
      const a = png.data[i + 3];
      if (a && r < 80 && g < 80 && bl < 80) dark++;
    }
    if (dark > maxColumnDark) {
      maxColumnDark = dark;
      maxColumnX = x;
    }
  }

  return { expectedX, expectedY, maxColumnDark, maxColumnX };
}

function line(label) {
  const marker = `dump-focus-state ${label}:`;
  return out.split('\n').find(l => l.includes(marker)) || '';
}

const typed = line('typed');
const caretPos = parseLastCaretPos(out);
const origin = parseRichEditClientOrigin(out);
const visualOn = analyzeCaretStroke(PNG_ON, origin, caretPos);
const visualOff = analyzeCaretStroke(PNG_OFF, origin, caretPos);
const visualOnAgain = analyzeCaretStroke(PNG_ON_AGAIN, origin, caretPos);

if (caretPos) console.log(`last caret pos: x=${caretPos.x} y=${caretPos.y}`);
if (origin) console.log(`richedit client: x=${origin.x} y=${origin.y} w=${origin.w} h=${origin.h}`);
if (visualOn) {
  console.log(`visual caret on: expected=${visualOn.expectedX},${visualOn.expectedY} maxColumnX=${visualOn.maxColumnX} dark=${visualOn.maxColumnDark}`);
}
if (visualOff) {
  console.log(`visual caret off: expected=${visualOff.expectedX},${visualOff.expectedY} maxColumnX=${visualOff.maxColumnX} dark=${visualOff.maxColumnDark}`);
}
if (visualOnAgain) {
  console.log(`visual caret on-again: expected=${visualOnAgain.expectedX},${visualOnAgain.expectedY} maxColumnX=${visualOnAgain.maxColumnX} dark=${visualOnAgain.maxColumnDark}`);
}

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

check('WordPad reached ShowWindow', /\[ShowWindow\] hwnd=0x10001 cmd=10/.test(out));
check('click focused native RichEdit child', /dump-focus-state clicked: hwnd=0x10002 class=0 id=59648 parent=0x10001/.test(out));
check('typed text reached native RichEdit', /text="caret"/.test(typed));
check('native RichEdit created USER caret', /CreateCaret\(/.test(out));
check('native RichEdit set USER caret position', !!caretPos && caretPos.x > 0 && caretPos.y >= 0);
check('native RichEdit showed USER caret', /ShowCaret\(/.test(out));
check('RichEdit window origin was dumped', !!origin);
check('caret blink screenshots written',
  [PNG_ON, PNG_OFF, PNG_ON_AGAIN].every(file => fs.existsSync(file) && fs.statSync(file).size > 0));
check('caret paints an inverted vertical stroke in on phase',
  visualOn &&
  visualOn.expectedX >= origin.x &&
  visualOn.expectedY >= origin.y &&
  visualOn.maxColumnDark >= 10);
check('caret off phase erases the stroke',
  visualOff &&
  visualOff.maxColumnDark <= 3);
check('caret returns in the next on phase without stale backing-store damage',
  visualOnAgain &&
  visualOnAgain.maxColumnDark >= 10);
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
