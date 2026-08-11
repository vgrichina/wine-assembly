#!/usr/bin/env node
// Regression coverage for WordPad's ToolbarWindow32 layout path:
//   - both standard and formatting toolbars are WAT-native class 21 controls
//   - the MFC control bar lays out the RichEdit child below the toolbar rows
//   - a screenshot proves nested toolbar surfaces are composited and clipped
//   - toolbar bitmap strips render real colored icon pixels, not only fallback
//     placeholder squares
//   - the first standard-toolbar button maps through TBBUTTON.idCommand and
//     opens WordPad's New dialog instead of crashing in MFC toolbar UI updates

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const PNG_OUT = path.join(OUT_DIR, 'toolbar-layout.png');
const PNG_CLICK_OUT = path.join(OUT_DIR, 'toolbar-command-new.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const seq = [
  '40:dump-windows:initial',
  '90:dump-windows:final',
  `94:png:${PNG_OUT}`,
  '110:click:10:48',
  '150:dump-windows:after-click',
  `154:png:${PNG_CLICK_OUT}`,
  '170:stop',
];

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
  l.includes('dump-windows') ||
  l.includes('window:final') ||
  l.includes('window:initial') ||
  l.includes('window:after-click') ||
  l.includes('[input] png') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH') ||
  l.includes('Unreachable code'));
for (const l of interesting) console.log('  ' + l);

function parseWindowByCtrlId(id) {
  const re = new RegExp(
    `window:final hwnd=(\\d+) class=("[^"]*") ctrlClass=(-?\\d+) ctrlId=${id} ` +
    `parent=(0x[0-9a-f]+) pos=(-?\\d+),(-?\\d+) size=(\\d+)x(\\d+) ` +
    `client=\\{"x":(-?\\d+),"y":(-?\\d+),"w":(-?\\d+),"h":(-?\\d+)\\} ` +
    `visible=(true|false)(?: enabled=(?:true|false))?(?: style=0x[0-9a-f]+)? dialog=(true|false) hasBack=(true|false) title=("[^"]*")`,
    'i');
  const line = out.split('\n').find(l => re.test(l)) || '';
  const m = line.match(re);
  if (!m) return null;
  return {
    line,
    hwnd: parseInt(m[1], 10),
    className: JSON.parse(m[2]),
    ctrlClass: parseInt(m[3], 10),
    ctrlId: id,
    parent: m[4],
    x: parseInt(m[5], 10),
    y: parseInt(m[6], 10),
    w: parseInt(m[7], 10),
    h: parseInt(m[8], 10),
    clientX: parseInt(m[9], 10),
    clientY: parseInt(m[10], 10),
    clientW: parseInt(m[11], 10),
    clientH: parseInt(m[12], 10),
    visible: m[13] === 'true',
    dialog: m[14] === 'true',
    hasBack: m[15] === 'true',
    title: JSON.parse(m[16]),
  };
}

function countToolbarButtonPixels(pngPath) {
  if (!fs.existsSync(pngPath)) return 0;
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  let detail = 0;
  const bands = [
    [43, 62], // Standard toolbar button interior/edges.
    [73, 92], // Formatting toolbar button interior/edges.
  ];
  for (const [y0, y1] of bands) {
    for (let y = y0; y < Math.min(y1, png.height); y++) {
      for (let x = 4; x < Math.min(390, png.width); x++) {
        const i = (y * png.width + x) * 4;
        const r = png.data[i];
        const g = png.data[i + 1];
        const b = png.data[i + 2];
        const a = png.data[i + 3];
        if (!a) continue;
        const isBtnFace =
          r >= 185 && r <= 195 &&
          g >= 185 && g <= 195 &&
          b >= 185 && b <= 195;
        if (!isBtnFace) detail++;
      }
    }
  }
  return detail;
}

function countToolbarIconColorPixels(pngPath) {
  if (!fs.existsSync(pngPath)) return 0;
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  let colorful = 0;
  const bands = [
    [43, 62], // Standard toolbar button interior/edges.
    [73, 92], // Formatting toolbar button interior/edges.
  ];
  for (const [y0, y1] of bands) {
    for (let y = y0; y < Math.min(y1, png.height); y++) {
      for (let x = 4; x < Math.min(390, png.width); x++) {
        const i = (y * png.width + x) * 4;
        const r = png.data[i];
        const g = png.data[i + 1];
        const b = png.data[i + 2];
        const a = png.data[i + 3];
        if (!a) continue;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const isDarkEdge = r < 50 && g < 50 && b < 50;
        if (!isDarkEdge && max - min >= 35) colorful++;
      }
    }
  }
  return colorful;
}

function countWhitePixels(pngPath, x0, y0, x1, y1) {
  if (!fs.existsSync(pngPath)) return 0;
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  let white = 0;
  for (let y = Math.max(0, y0 | 0); y < Math.min(y1 | 0, png.height); y++) {
    for (let x = Math.max(0, x0 | 0); x < Math.min(x1 | 0, png.width); x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i];
      const g = png.data[i + 1];
      const b = png.data[i + 2];
      const a = png.data[i + 3];
      if (a && r >= 245 && g >= 245 && b >= 245) white++;
    }
  }
  return white;
}

const standard = parseWindowByCtrlId(59392);
const formatting = parseWindowByCtrlId(59396);
const topControlBar = parseWindowByCtrlId(59419);
const fontCombo = parseWindowByCtrlId(165);
const sizeCombo = parseWindowByCtrlId(166);
const richEdit = parseWindowByCtrlId(59648);
const pngExists = fs.existsSync(PNG_OUT) && fs.statSync(PNG_OUT).size > 0;
const clickPngExists = fs.existsSync(PNG_CLICK_OUT) && fs.statSync(PNG_CLICK_OUT).size > 0;
const toolbarButtonPixels = countToolbarButtonPixels(PNG_OUT);
const toolbarIconColorPixels = countToolbarIconColorPixels(PNG_OUT);
const fontComboWhitePixels = fontCombo
  ? countWhitePixels(PNG_OUT, fontCombo.clientX + 4, fontCombo.clientY + 4,
      fontCombo.clientX + fontCombo.clientW - 22, fontCombo.clientY + 18)
  : 0;
const sizeComboWhitePixels = sizeCombo
  ? countWhitePixels(PNG_OUT, sizeCombo.clientX + 4, sizeCombo.clientY + 4,
      sizeCombo.clientX + sizeCombo.clientW - 22, sizeCombo.clientY + 18)
  : 0;
const openedNewDialog =
  /window:after-click hwnd=\d+ class="[^"]*" ctrlClass=-?\d+ ctrlId=\d+ .* visible=true(?: enabled=(?:true|false))?(?: style=0x[0-9a-f]+)? dialog=true .* title="New"/.test(out);

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

check('WordPad reached ShowWindow', /\[ShowWindow\] hwnd=0x10001 cmd=10/.test(out));
check('standard toolbar exists as WAT-native ToolbarWindow32',
  standard &&
  standard.className === 'ToolbarWindow32' &&
  standard.ctrlClass === 21 &&
  standard.visible);
check('standard toolbar has a real surface and height',
  standard && standard.hasBack && standard.w >= 300 && standard.h >= 24);
check('formatting toolbar exists as WAT-native ToolbarWindow32',
  formatting &&
  formatting.className === 'ToolbarWindow32' &&
  formatting.ctrlClass === 21 &&
  formatting.visible);
check('formatting toolbar has a real surface and height',
  formatting && formatting.hasBack && formatting.w >= 300 && formatting.h >= 24);
check('formatting toolbar renderer width is bounded by its control bar',
  formatting &&
  topControlBar &&
  topControlBar.className === 'AfxControlBar42' &&
  formatting.parent === `0x${topControlBar.hwnd.toString(16)}` &&
  formatting.w <= topControlBar.w + 8 &&
  formatting.clientW <= topControlBar.w + 8);
check('font combo is visible on the formatting toolbar',
  fontCombo &&
  fontCombo.className === 'COMBOBOX' &&
  fontCombo.ctrlClass === 5 &&
  formatting &&
  fontCombo.parent === `0x${formatting.hwnd.toString(16)}` &&
  fontCombo.visible &&
  fontCombo.hasBack &&
  fontCombo.x >= 0 &&
  fontCombo.y >= 0);
check('size combo is visible and separated from the font combo',
  fontCombo &&
  sizeCombo &&
  sizeCombo.className === 'COMBOBOX' &&
  sizeCombo.ctrlClass === 5 &&
  sizeCombo.parent === fontCombo.parent &&
  sizeCombo.visible &&
  sizeCombo.hasBack &&
  sizeCombo.x >= fontCombo.x + fontCombo.w &&
  sizeCombo.y === fontCombo.y);
check('toolbars occupy separate rows',
  standard && formatting && formatting.y >= standard.y + 20);
check('RichEdit child is laid out below the toolbars',
  richEdit &&
  richEdit.className === 'RichEdit20A' &&
  richEdit.ctrlId === 59648 &&
  richEdit.y >= 80 &&
  richEdit.h >= 100 &&
  richEdit.visible);
check('toolbar-layout screenshot written', pngExists);
check(`toolbar button details visibly painted (${toolbarButtonPixels} non-face pixels)`,
  toolbarButtonPixels >= 120);
check(`toolbar bitmap icons render colored strip pixels (${toolbarIconColorPixels} color pixels)`,
  toolbarIconColorPixels >= 80);
check(`toolbar combo fields paint white interiors (${fontComboWhitePixels}/${sizeComboWhitePixels} white pixels)`,
  fontComboWhitePixels >= 1200 &&
  sizeComboWhitePixels >= 150);
check('first standard toolbar button opens New dialog', openedNewDialog);
check('toolbar-command screenshot written', clickPngExists);
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
