#!/usr/bin/env node
// Regression coverage for WordPad's native RichEdit startup/editing path:
//   - WordPad reaches ShowWindow with a visible top-level editor window
//   - mouse focus lands on the RichEdit child
//   - keypresses route to that child
//   - typed text is present in RichEdit's own WM_GETTEXT buffer
//   - Backspace and Enter update that buffer
//   - Delete-forward, Left, Home, and End update insertion position
//   - Shift+Left selection is visible through EM_GETSEL and replacement text
//   - Ctrl+A/C/X/V plain-text clipboard shortcuts work for native RichEdit focus
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
  '70:click:40:150',
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
seq.push('124:keydown:37');
seq.push('125:keyup:37');
seq.push('128:keydown:37');
seq.push('129:keyup:37');
seq.push('132:keydown:46');
seq.push('133:keyup:46');
seq.push('138:dump-focus-text:delete');
seq.push('142:keydown:36');
seq.push('143:keyup:36');
seq.push('146:keypress:88');
seq.push('150:dump-focus-text:home');
seq.push('154:keydown:35');
seq.push('155:keyup:35');
seq.push('158:keypress:89');
seq.push('162:dump-focus-text:end');
seq.push('166:keydown:16');
seq.push('168:keydown:37');
seq.push('169:keyup:37');
seq.push('172:keydown:37');
seq.push('173:keyup:37');
seq.push('176:dump-focus-state:selected');
seq.push('178:keyup:16');
seq.push('182:keypress:90');
seq.push('186:dump-focus-state:replace');
seq.push('190:keydown:17');
seq.push('191:keydown:65');
seq.push('192:keyup:65');
seq.push('193:keyup:17');
seq.push('196:dump-focus-state:selectall');
seq.push('200:keydown:17');
seq.push('201:keydown:67');
seq.push('202:keyup:67');
seq.push('203:keyup:17');
seq.push('206:keydown:35');
seq.push('207:keyup:35');
seq.push('210:dump-focus-state:copyend');
seq.push('214:keydown:17');
seq.push('215:keydown:86');
seq.push('216:keyup:86');
seq.push('217:keyup:17');
seq.push('222:dump-focus-state:pasted');
seq.push('226:keydown:17');
seq.push('227:keydown:65');
seq.push('228:keyup:65');
seq.push('229:keyup:17');
seq.push('232:dump-focus-state:cutselect');
seq.push('236:keydown:17');
seq.push('237:keydown:88');
seq.push('238:keyup:88');
seq.push('239:keyup:17');
seq.push('242:dump-focus-state:cut');
seq.push('246:keydown:17');
seq.push('247:keydown:86');
seq.push('248:keyup:86');
seq.push('249:keyup:17');
seq.push('254:dump-focus-state:restored');
seq.push('262:dump-windows:final');
seq.push(`268:png:${PNG_OUT}`);

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=290',
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
  // Tight band over the upper-left of WordPad's editor, below the visible
  // standard/format toolbars, where the edited text paints after click+typing.
  const x0 = 5, x1 = Math.min(170, png.width);
  const y0 = 130, y1 = Math.min(210, png.height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2], a = png.data[i + 3];
      if (a && r < 120 && g < 120 && b < 120) dark++;
    }
  }
  return dark;
}
function countChromeBluePixelsInToolbarBand(pngPath) {
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  let blue = 0;
  // The toolbar/ruler band starts below the top-level title/menu and above the
  // RichEdit document. A copied Win98 title bar shows up here as a dark-blue
  // strip. Real toolbar bitmap icons also contain dark-blue glyph pixels, so
  // only count long same-row blue runs that indicate copied chrome rather than
  // small icon clusters.
  const x0 = 0, x1 = Math.min(390, png.width);
  const y0 = 38, y1 = Math.min(130, png.height);
  for (let y = y0; y < y1; y++) {
    let run = 0;
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2], a = png.data[i + 3];
      if (a && r < 32 && g < 48 && b >= 96 && b <= 192) {
        run++;
      } else {
        if (run >= 24) blue += run;
        run = 0;
      }
    }
    if (run >= 24) blue += run;
  }
  return blue;
}

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

const pngExists = fs.existsSync(PNG_OUT) && fs.statSync(PNG_OUT).size > 0;
const darkPixels = pngExists ? countDarkTextPixels(PNG_OUT) : 0;
const toolbarBluePixels = pngExists ? countChromeBluePixelsInToolbarBand(PNG_OUT) : 0;
const keyboardFocusHits = (out.match(/\[check_input_hwnd\] keyboard → focus 0x10002/g) || []).length;
const typedTextOk = /dump-focus-text typed: hwnd=0x10002 class=0 id=59648 parent=0x10001 len=11 text="hello world"/.test(out);
const editedTextOk = /dump-focus-text edited: hwnd=0x10002 class=0 id=59648 parent=0x10001 len=\d+ text="hello worl\\r?\\nagain"/.test(out);
const deleteTextOk = /dump-focus-text delete: hwnd=0x10002 class=0 id=59648 parent=0x10001 len=\d+ text="hello worl\\r?\\nagan"/.test(out);
const homeTextOk = /dump-focus-text home: hwnd=0x10002 class=0 id=59648 parent=0x10001 len=\d+ text="hello worl\\r?\\nXagan"/.test(out);
const endTextOk = /dump-focus-text end: hwnd=0x10002 class=0 id=59648 parent=0x10001 len=\d+ text="hello worl\\r?\\nXaganY"/.test(out);
// Native RichEdit reports EM_GETSEL character positions with the CRLF newline
// folded differently from WM_GETTEXT's byte count, so the second visual line is
// one position lower than the JSON text length suggests.
const selectionStateOk = /dump-focus-state selected: hwnd=0x10002 class=0 id=59648 parent=0x10001 .*len=18 sel=15\.\.17 .*lineCount=2 text="hello worl\\r?\\nXaganY"/.test(out);
const replacementTextOk = /dump-focus-state replace: hwnd=0x10002 class=0 id=59648 parent=0x10001 .*len=17 sel=16\.\.16 .*lineCount=2 text="hello worl\\r?\\nXagaZ"/.test(out);
const selectAllOk = /dump-focus-state selectall: hwnd=0x10002 class=0 id=59648 parent=0x10001 .*len=17 sel=0\.\.17 .*lineCount=2 text="hello worl\\r?\\nXagaZ"/.test(out);
const copyEndOk = /dump-focus-state copyend: hwnd=0x10002 class=0 id=59648 parent=0x10001 .*len=17 sel=16\.\.16 .*lineCount=2 text="hello worl\\r?\\nXagaZ"/.test(out);
const pastedTextOk = /dump-focus-state pasted: hwnd=0x10002 class=0 id=59648 parent=0x10001 .*len=34 sel=32\.\.32 .*lineCount=3 text="hello worl\\r?\\nXagaZhello worl\\r?\\nXagaZ"/.test(out);
const cutSelectOk = /dump-focus-state cutselect: hwnd=0x10002 class=0 id=59648 parent=0x10001 .*len=34 sel=0\.\.33 .*lineCount=3 text="hello worl\\r?\\nXagaZhello worl\\r?\\nXagaZ"/.test(out);
const cutTextOk = /dump-focus-state cut: hwnd=0x10002 class=0 id=59648 parent=0x10001 .*len=0 sel=0\.\.0 .*lineCount=1 text=""/.test(out);
const restoredTextOk = /dump-focus-state restored: hwnd=0x10002 class=0 id=59648 parent=0x10001 .*len=34 sel=32\.\.32 .*lineCount=3 text="hello worl\\r?\\nXagaZhello worl\\r?\\nXagaZ"/.test(out);

check('WordPad reached ShowWindow', /\[ShowWindow\] hwnd=0x10001 cmd=10/.test(out));
check('top-level WordPad window visible', /window:final hwnd=65537 .*visible=true .*title="Document - WordPad"/.test(out));
check('click focused native RichEdit child', /dump-focus clicked: hwnd=0x10002 class=0 id=59648 parent=0x10001/.test(out));
check('keypresses routed to RichEdit child', keyboardFocusHits >= text.length + 'again'.length);
check('focus remained on native RichEdit after typing', /dump-focus typed: hwnd=0x10002 class=0 id=59648 parent=0x10001/.test(out));
check('typed text is readable with WM_GETTEXT', typedTextOk);
check('Backspace and Enter update RichEdit text', editedTextOk);
check('Delete-forward updates RichEdit text', deleteTextOk);
check('Home changes insertion position', homeTextOk);
check('End changes insertion position', endTextOk);
check('Shift+Left updates RichEdit selection range', selectionStateOk);
check('selection replacement updates RichEdit text', replacementTextOk);
check('Ctrl+A selects all native RichEdit text', selectAllOk);
check('Ctrl+C preserves copied text and End collapses selection', copyEndOk);
check('Ctrl+V pastes copied native RichEdit text', pastedTextOk);
check('Ctrl+A selects duplicated native RichEdit text', cutSelectOk);
check('Ctrl+X cuts selected native RichEdit text', cutTextOk);
check('Ctrl+V restores cut native RichEdit text', restoredTextOk);
check('edited-text screenshot written', pngExists);
check(`edited text visibly painted (${darkPixels} dark pixels)`, darkPixels >= 50);
check(`no duplicated title/menu chrome in toolbar band (${toolbarBluePixels} blue pixels)`, toolbarBluePixels < 20);
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
