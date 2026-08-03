#!/usr/bin/env node
// Regression coverage for WordPad RichEdit long-line painting.
//
// Win98 WordPad creates a native RichEdit20A child with ES_AUTOHSCROLL, so a
// long paragraph remains one logical line and RichEdit relies on
// ExtTextOut(... ETO_CLIPPED ...) to keep the visible editor band clipped.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const PNG_OUT = path.join(OUT_DIR, 'long-line-clipped.png');
const TEXT = 'word '.repeat(20);

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
seq.push(`${b + 6}:dump-focus-state:long`);
seq.push(`${b + 8}:dump-windows:long`);
seq.push(`${b + 12}:png:${PNG_OUT}`);
seq.push(`${b + 16}:stop`);

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=220',
  '--batch-size=50000',
  '--quiet-api',
  '--trace-api=ExtTextOutA,ExtTextOutW',
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

let extPrinted = 0;
let extTotal = 0;
for (const line of out.split('\n')) {
  const isExt = line.includes('ExtTextOut');
  if (isExt) extTotal++;
  if (
    line.includes('ShowWindow') ||
    line.includes('dump-focus-state') ||
    line.includes('window:long') ||
    (isExt && extPrinted < 24) ||
    line.includes('[input] png') ||
    line.includes('UNIMPLEMENTED') ||
    line.includes('CRASH') ||
    line.includes('Unreachable code')
  ) {
    console.log('  ' + line);
    if (isExt) extPrinted++;
  }
}
if (extTotal > extPrinted) console.log(`  ... ${extTotal - extPrinted} more ExtTextOut trace lines omitted`);

function parseRichEditClientOrigin(text) {
  let topClient = null;
  let childPos = null;
  for (const line of text.split('\n')) {
    if (!line.includes('window:long')) continue;
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
  if (!topClient || !childPos) return null;
  return {
    x: topClient.x + childPos.x,
    y: topClient.y + childPos.y,
    w: childPos.w,
    h: childPos.h,
  };
}

function analyzeScreenshot(file, editor) {
  if (!fs.existsSync(file) || !editor) return null;
  const png = PNG.sync.read(fs.readFileSync(file));
  let editorDark = 0;
  let desktopSpillDark = 0;
  const textBandTop = editor.y;
  const textBandBottom = Math.min(png.height, editor.y + 30);

  for (let y = textBandTop; y < textBandBottom; y++) {
    for (let x = editor.x; x < Math.min(png.width, editor.x + editor.w); x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2], a = png.data[i + 3];
      if (a && r < 120 && g < 120 && b < 120) editorDark++;
    }
    const outerWindowRight = 400;
    for (let x = Math.min(png.width, outerWindowRight + 2); x < Math.min(png.width, outerWindowRight + 120); x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2], a = png.data[i + 3];
      if (a && r < 120 && g < 120 && b < 120) desktopSpillDark++;
    }
  }

  return { editorDark, desktopSpillDark };
}

const longLine = out.split('\n').find(l => l.includes('dump-focus-state long:')) || '';
const lineCount = parseInt((/lineCount=(\d+)/.exec(longLine) || [])[1] || '0', 10);
const editor = parseRichEditClientOrigin(out);
const visual = analyzeScreenshot(PNG_OUT, editor);

if (editor) console.log(`richedit client: x=${editor.x} y=${editor.y} w=${editor.w} h=${editor.h}`);
if (visual) console.log(`visual text pixels: editorDark=${visual.editorDark} desktopSpillDark=${visual.desktopSpillDark}`);

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

check('WordPad reached ShowWindow', /\[ShowWindow\] hwnd=0x10001 cmd=10/.test(out));
check('click focused native RichEdit child', /dump-focus-state clicked: hwnd=0x10002 class=0 id=59648 parent=0x10001/.test(out));
check('long text reached native RichEdit', /dump-focus-state long: hwnd=0x10002 class=0 id=59648 parent=0x10001 len=100 /.test(out));
check('long text produced multiple native RichEdit lines', lineCount >= 2);
check('RichEdit painted with ExtTextOut ETO_CLIPPED', /ExtTextOutA\(.*fuOptions=4.*lprc=&\{l=\d+ t=\d+ r=\d+ b=\d+\}/.test(out));
check('RichEdit window origin was dumped', !!editor);
check('long-line screenshot written', fs.existsSync(PNG_OUT) && fs.statSync(PNG_OUT).size > 0);
check('long-line text visibly painted inside editor', visual && visual.editorDark >= 40);
check('long-line glyphs did not spill into desktop band', visual && visual.desktopSpillDark === 0);
check('no UNIMPLEMENTED API crash', !/UNIMPLEMENTED API:/.test(out));
check('no runtime crash', !/CRASH|Unreachable code/.test(out));

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log(`${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exit(1);
