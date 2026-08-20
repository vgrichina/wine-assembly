#!/usr/bin/env node
// Regression coverage for WordPad paragraph alignment:
// Ctrl+E should dispatch WordPad's center-align command, native RichEdit should
// report PFA_CENTER through EM_GETPARAFORMAT, Save As should emit centered RTF,
// and a simple RTF Save As -> New -> Open round-trip should restore text.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG: PNGJS } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const LEFT_PNG = path.join(OUT_DIR, 'paragraph-align-left.png');
const CENTER_PNG = path.join(OUT_DIR, 'paragraph-align-center.png');
const RUN_LOG = path.join(OUT_DIR, 'paragraph-align-run.log');
const RUN_ERR = path.join(OUT_DIR, 'paragraph-align-run.err.log');
const VFS_OUT = path.join(OUT_DIR, 'paragraph-align-vfs');
const SAVE_NAME = 'wordpad-para-align.rtf';
const SAVED_RTF = path.join(VFS_OUT, 'windows', SAVE_NAME);
const TEXT = 'align';

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.rmSync(VFS_OUT, { recursive: true, force: true });
for (const file of [LEFT_PNG, CENTER_PNG]) {
  fs.rmSync(file, { force: true });
}
fs.rmSync(RUN_LOG, { force: true });
fs.rmSync(RUN_ERR, { force: true });

const seq = ['70:click:40:150'];
let b = 74;
for (const ch of TEXT) {
  seq.push(`${b}:keypress:${ch.charCodeAt(0)}`);
  b += 1;
}
seq.push('84:dump-focus-state:typed');
seq.push('86:dump-focus-paraformat:plain');
seq.push(`88:png:${LEFT_PNG}`);
seq.push('94:keydown:17');
seq.push('95:keydown:65');
seq.push('96:keyup:65');
seq.push('97:keyup:17');
seq.push('100:dump-focus-state:selected');
seq.push('104:keydown:17');
seq.push('105:keydown:69');
seq.push('106:keyup:69');
seq.push('107:keyup:17');
seq.push('122:dump-focus-paraformat:centered');
seq.push('128:keydown:39');
seq.push('129:keyup:39');
seq.push(`142:png:${CENTER_PNG}`);
seq.push('160:0x111:57604');
seq.push(`210:open-dlg-pick:${SAVE_NAME}`);
seq.push('280:dump-focus-paraformat:after-save');
seq.push('300:0x111:57600');
seq.push('330:dlg-cmd:1');
seq.push('380:dump-focus-text:after-new');
seq.push('410:0x111:57601');
seq.push(`460:open-dlg-pick:${SAVE_NAME}`);
seq.push('490:dump-focus-text:after-open');
seq.push('490:stop');

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=520',
  '--batch-size=50000',
  '--quiet-blocks',
  '--quiet-api',
  '--no-close',
  `--save-vfs=${VFS_OUT}`,
];

console.log('$ node ' + args.map(a => JSON.stringify(a)).join(' '));

let out = '';
let run = null;
let outFd = null;
let errFd = null;
try {
  outFd = fs.openSync(RUN_LOG, 'w');
  errFd = fs.openSync(RUN_ERR, 'w');
  run = spawnSync('node', args, {
    cwd: ROOT,
    timeout: 220000,
    stdio: ['ignore', outFd, errFd],
  });
} finally {
  if (outFd !== null) fs.closeSync(outFd);
  if (errFd !== null) fs.closeSync(errFd);
  out = (fs.existsSync(RUN_LOG) ? fs.readFileSync(RUN_LOG, 'utf8') : '') +
    (fs.existsSync(RUN_ERR) ? fs.readFileSync(RUN_ERR, 'utf8') : '');
}

if (run && (run.error || run.status !== 0 || run.signal)) {
  console.log('(run.js exited non-zero or timed out - output captured)');
}

const interesting = out.split('\n').filter(l =>
  l.includes('ShowWindow') ||
  l.includes('dump-focus-text') ||
  l.includes('dump-focus-state') ||
  l.includes('dump-focus-paraformat') ||
  l.includes('open-dlg-pick') ||
  l.includes('ReadFile') ||
  l.includes('png ') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH') ||
  l.includes('Unreachable code'));
for (const l of interesting) console.log('  ' + l);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function line(label, kind = 'dump-focus-paraformat') {
  const prefix = `${kind} ${label}:`;
  return out.split('\n').find(l => l.includes(prefix)) || '';
}

function readPng(file) {
  return PNGJS.sync.read(fs.readFileSync(file));
}

function textBandBounds(file) {
  if (!fs.existsSync(file)) return null;
  const img = readPng(file);
  // Inside the RichEdit's client area, below its top border. x=0..9 and
  // x>=386 are the window frame and x1=394/y0=132 caught both it and the
  // editor's border line, so minX..maxX came back 4..392 for every paragraph
  // no matter where the text sat. Centred "align" lands at x 295..320 against
  // 22..47 for left, and its descenders reach y=152.
  const x0 = 10;
  const y0 = 134;
  const x1 = Math.min(386, img.width);
  const y1 = Math.min(156, img.height);
  let minX = Infinity;
  let maxX = -1;
  let count = 0;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      const a = img.data[i + 3];
      if (a && r < 100 && g < 100 && b < 100) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        count++;
      }
    }
  }

  if (!count) return null;
  return { minX, maxX, count };
}

const picks = (out.match(new RegExp(`open-dlg-pick: ${escapeRe(SAVE_NAME)}`, 'g')) || []).length;
const typed = line('typed', 'dump-focus-state');
const selected = line('selected', 'dump-focus-state');
const plain = line('plain');
const centered = line('centered');
const afterSave = line('after-save');
const afterNew = line('after-new', 'dump-focus-text');
const afterOpen = line('after-open', 'dump-focus-text');
const leftBounds = textBandBounds(LEFT_PNG);
const centerBounds = textBandBounds(CENTER_PNG);
const savedRtf = fs.existsSync(SAVED_RTF) ? fs.readFileSync(SAVED_RTF, 'latin1') : '';

if (leftBounds && centerBounds) {
  console.log(`visual paragraph bounds: left=${leftBounds.minX}..${leftBounds.maxX} center=${centerBounds.minX}..${centerBounds.maxX} darkLeft=${leftBounds.count} darkCenter=${centerBounds.count}`);
}

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

check('WordPad reached ShowWindow', /ShowWindow\] hwnd=0x10001/.test(out));
check('typed text reached native RichEdit', /text="align"/.test(typed));
check('plain paragraph starts left-aligned', /alignment=1/.test(plain));
check('Ctrl+A selected the native RichEdit text', /sel=0\.\.[1-9][0-9]*/.test(selected));
check('Ctrl+E centered the selected paragraph', /alignment=3/.test(centered));
check('center alignment visibly shifts text right',
  leftBounds &&
  centerBounds &&
  leftBounds.minX < 40 &&
  centerBounds.minX > leftBounds.minX + 80 &&
  centerBounds.count >= Math.max(8, Math.floor(leftBounds.count * 0.5)));
check('left-aligned screenshot written', fs.existsSync(LEFT_PNG) && fs.statSync(LEFT_PNG).size > 0);
check('center-aligned screenshot written', fs.existsSync(CENTER_PNG) && fs.statSync(CENTER_PNG).size > 0);
check('Save As dialog filename accepted', picks >= 1);
check('saved RTF file extracted from VFS', fs.existsSync(SAVED_RTF) && savedRtf.length > 0);
check('saved RTF stream contains centered paragraph control word', /\\qc\b/.test(savedRtf));
check('center alignment remained after Save As', /alignment=3/.test(afterSave));
check('File New cleared native RichEdit text', /len=0 text=""/.test(afterNew));
check('Open saved filename accepted', picks >= 2);
check('reopened centered RTF restored plain text', /len=5 text="align"/.test(afterOpen));
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
