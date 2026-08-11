#!/usr/bin/env node
// Regression coverage for WordPad's formatting-toolbar color popup.
//
// WordPad builds this as a temporary owner-draw CreatePopupMenu/AppendMenuA
// menu. The emulator keeps that popup usable after async TrackPopupMenu opens
// it and applies the selected color to the native RichEdit child.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG: PNGJS } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const PLAIN_PNG = path.join(OUT_DIR, 'toolbar-color-menu-plain.png');
const POPUP_PNG = path.join(OUT_DIR, 'toolbar-color-menu-popup.png');
const BLUE_PNG = path.join(OUT_DIR, 'toolbar-color-menu-blue.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const ctrlA = b => [
  `${b}:keydown:17`,
  `${b + 1}:keydown:65`,
  `${b + 2}:keyup:65`,
  `${b + 3}:keyup:17`,
];

const seq = [
  '70:click:40:150',
  '74:keypress:99',
  '75:keypress:111',
  '76:keypress:108',
  '77:keypress:111',
  '78:keypress:114',
  '84:dump-focus-state:typed',
  `88:png:${PLAIN_PNG}`,
  ...ctrlA(92),

  // Formatting toolbar color button center, after font/size combo fields.
  '104:click:390:80',
  '110:menu-dump:color',
  `112:png:${POPUP_PNG}`,

  // Popup anchor is x=378,y=93. Row #12 is #801a / Blue.
  '120:mousemove:390:345',
  '122:menu-dump:hover-blue',
  '124:click:390:345',

  // Refocus/reselect the document text for a stable CHARFORMAT assertion.
  '142:click:40:150',
  ...ctrlA(146),
  '160:dump-focus-charformat:after-blue',
  '162:dump-focus-state:after-blue',

  // Collapse selection before the visual assertion so text ink color is visible.
  '166:keydown:39',
  '167:keyup:39',
  `180:png-pixels:${BLUE_PNG}`,
  '186:stop',
];

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=280',
  '--batch-size=50000',
  '--quiet-api',
  '--trace-api=SetTextColor',
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
  l.includes('menu-dump') ||
  l.includes('dump-focus-state') ||
  l.includes('dump-focus-charformat') ||
  l.includes('[input] png') ||
  (l.includes('SetTextColor') && l.includes('0xff0000')) ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH') ||
  l.includes('Unreachable code'));
for (const l of interesting) console.log('  ' + l);

function line(label, kind) {
  const marker = kind === 'menu-dump'
    ? `${kind}:${label}:`
    : `${kind} ${label}:`;
  return out.split('\n').find(l => l.includes(marker)) || '';
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
  const y0 = 130;
  const x1 = Math.min(220, before.width);
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
      if (ba && bb > br + 40 && bb > bg + 40 && bb > 80) blueDominantBefore++;
      if (aa && ab > ar + 40 && ab > ag + 40 && ab > 80) blueDominantAfter++;
    }
  }

  return { changedPixels, diffSum, blueDominantBefore, blueDominantAfter };
}

const typed = line('typed', 'dump-focus-state');
const colorMenu = line('color', 'menu-dump');
const hoverBlue = line('hover-blue', 'menu-dump');
const afterBlue = line('after-blue', 'dump-focus-charformat');
const afterBlueState = line('after-blue', 'dump-focus-state');
const plainPngWritten = out.includes(`[input] png ${PLAIN_PNG} `);
const popupPngWritten = out.includes(`[input] png ${POPUP_PNG} `);
const bluePngWritten = out.includes(`[input] png-pixels ${BLUE_PNG} `);
const visual = analyzeTextBand(PLAIN_PNG, BLUE_PNG);
if (visual) {
  console.log(`visual text-band color: changed=${visual.changedPixels} diffSum=${visual.diffSum} blueDominantBefore=${visual.blueDominantBefore} blueDominantAfter=${visual.blueDominantAfter}`);
}

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

check('WordPad reached ShowWindow', /\[ShowWindow\] hwnd=0x10001 cmd=10/.test(out));
check('typed text reached native RichEdit', /text="color"/.test(typed));
check('color toolbar popup exposes 17 dynamic commands',
  /count=17/.test(colorMenu) &&
  /#0 id=32782/.test(colorMenu) &&
  /#12 id=32794 flags=0x0 "#801a"/.test(colorMenu) &&
  /#16 id=32798/.test(colorMenu));
check('mouse hover hit-tests Blue row', /hover=12/.test(hoverBlue));
check('toolbar color popup screenshot written',
  popupPngWritten && fs.existsSync(POPUP_PNG) && fs.statSync(POPUP_PNG).size > 0);
check('Blue menu row applies Win32 blue COLORREF',
  /effects=0x0/.test(afterBlue) &&
  /color=0xff0000/.test(afterBlue));
check('text color command did not corrupt editor text', /text="color"/.test(afterBlueState));
check('GDI text renderer used the blue COLORREF', /SetTextColor\(.*0xff0000/.test(out));
check('plain screenshot written',
  plainPngWritten && fs.existsSync(PLAIN_PNG) && fs.statSync(PLAIN_PNG).size > 0);
check('blue screenshot written',
  bluePngWritten && fs.existsSync(BLUE_PNG) && fs.statSync(BLUE_PNG).size > 0);
check('blue color changes visible text pixels',
  visual &&
  !visual.mismatch &&
  visual.blueDominantBefore <= 2 &&
  visual.blueDominantAfter >= 40 &&
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
