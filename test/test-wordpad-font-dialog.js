#!/usr/bin/env node
// Regression coverage for WordPad's Format > Font dialog path:
// selecting face/style/size in the WAT ChooseFontA dialog must write the
// selected values back into CHOOSEFONT/LOGFONT so WordPad sends a meaningful
// EM_SETCHARFORMAT to native RichEdit.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG: PNGJS } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const PLAIN_PNG = path.join(OUT_DIR, 'font-dialog-plain.png');
const FONT_PNG = path.join(OUT_DIR, 'font-dialog.png');
const TEXT = 'font';

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
seq.push('84:dump-focus-charformat:plain');
seq.push(`86:png:${PLAIN_PNG}`);
seq.push('90:keydown:17');
seq.push('91:keydown:65');
seq.push('92:keyup:65');
seq.push('93:keyup:17');
seq.push('100:0x111:57696');          // Format > Font...
seq.push('130:dlg-dump:font');
seq.push('140:dlg-send:1104:390:1:0'); // face listbox: Arial
seq.push('142:dlg-send:1105:390:3:0'); // style listbox: Bold Italic
seq.push('144:dlg-send:1106:390:5:0'); // size listbox: 24
seq.push('150:dlg-cmd:1');             // OK
seq.push('188:dump-focus-charformat:after-font');
seq.push('194:keydown:39');            // collapse selection for screenshot
seq.push('195:keyup:39');
seq.push('200:dump-focus-state:final');
seq.push(`204:png:${FONT_PNG}`);
seq.push('208:stop');

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=280',
  '--batch-size=50000',
  '--quiet-api',
  '--trace-api=ChooseFontA,SendMessageA',
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
  l.includes('ChooseFontA') ||
  l.includes('msg=1092') ||
  l.includes('dlg-dump:font') ||
  l.includes('dlg-send: id=1104') ||
  l.includes('dlg-send: id=1105') ||
  l.includes('dlg-send: id=1106') ||
  l.includes('dlg-cmd') ||
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

  const x0 = 0;
  const y0 = 45;
  const x1 = Math.min(220, before.width);
  const y1 = Math.min(95, before.height);
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

const plain = line('plain');
const afterFont = line('after-font');
const final = line('final', 'dump-focus-state');
const setCharFormat = out.split('\n').find(l =>
  l.includes('msg=1092') &&
  l.includes('wP=1') &&
  l.includes('effects=0x00000003:bold|italic') &&
  l.includes('yHeight=480') &&
  l.includes('face="Arial"')) || '';

const visual = compareTextBand(PLAIN_PNG, FONT_PNG);
if (visual) {
  console.log(`visual text-band diff: changed=${visual.changedPixels} darkBefore=${visual.darkBefore} darkAfter=${visual.darkAfter} darkDelta=${visual.darkDelta} diffSum=${visual.diffSum}`);
}

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

check('WordPad reached ShowWindow', /ShowWindow\] hwnd=0x10001/.test(out));
check('plain selected text starts without font-dialog effects',
  /bold=0 .*italic=0 .*underline=0/.test(plain));
check('Format > Font opened ChooseFontA', /ChooseFontA\(/.test(out));
check('Font dialog exposed face/style/size listboxes',
  /dlg-dump:font: .*id=1104.*id=1105.*id=1106/.test(out));
check('font face selection accepted', /dlg-send: id=1104 .* ret=1/.test(out));
check('font style selection accepted', /dlg-send: id=1105 .* ret=3/.test(out));
check('font size selection accepted', /dlg-send: id=1106 .* ret=5/.test(out));
check('Font dialog returned Arial Bold Italic 24pt to WordPad',
  /yHeight=480/.test(setCharFormat) &&
  /effects=0x00000003:bold\|italic/.test(setCharFormat) &&
  /face="Arial"/.test(setCharFormat));
check('RichEdit selection reports applied face/style',
  /bold=1 .*italic=1 .*underline=0/.test(afterFont) &&
  /face="Arial"/.test(afterFont));
check('font dialog path did not corrupt editor text', /text="font"/.test(final));
check('plain font screenshot written', fs.existsSync(PLAIN_PNG) && fs.statSync(PLAIN_PNG).size > 0);
check('font dialog screenshot written', fs.existsSync(FONT_PNG) && fs.statSync(FONT_PNG).size > 0);
check('font dialog face/style changes visible text pixels',
  visual &&
  !visual.mismatch &&
  visual.changedPixels >= 40 &&
  visual.diffSum >= 10000);
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
