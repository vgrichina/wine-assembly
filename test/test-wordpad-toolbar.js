#!/usr/bin/env node
// Regression coverage for WordPad's ToolbarWindow32 layout path:
//   - both standard and formatting toolbars are WAT-native class 21 controls
//   - the MFC control bar lays out the RichEdit child below the toolbar rows
//   - a screenshot proves nested toolbar surfaces are composited and clipped
//   - toolbar bitmap strips render real colored icon pixels, not only fallback
//     placeholder squares
//   - disabled standard-toolbar commands are exposed in the button state dump
//     and are visually dimmed instead of looking enabled
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
  '92:dump-toolbar:final',
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
  l.includes('toolbar:') ||
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
    `parent=(0x[0-9a-f]+)(?: owner=0x[0-9a-f]+)?(?: wndProc=0x[0-9a-f]+)?(?: dialogProc=0x[0-9a-f]+)?(?: z=-?\\d+)? pos=(-?\\d+),(-?\\d+) size=(\\d+)x(\\d+) ` +
    `client=\\{"x":(-?\\d+),"y":(-?\\d+),"w":(-?\\d+),"h":(-?\\d+)\\} ` +
    // Every optional group here is a field that was added to the dump after
    // this test was written; menuBar= is the one that broke it, and it sits
    // between dialog= and hasBack=, so all thirteen toolbar checks failed on
    // a null parse while the toolbars themselves were fine.
    `visible=(true|false)(?: minimized=(?:true|false))?(?: iconic=(?:true|false))?(?: zoomed=(?:true|false))?(?: enabled=(?:true|false))?(?: style=0x[0-9a-f]+)? dialog=(true|false)(?: menuBar=(?:true|false))? hasBack=(true|false) title=("[^"]*")`,
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

function countColorPixelsInRegions(pngPath, regions) {
  if (!fs.existsSync(pngPath)) return 0;
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  let colorful = 0;
  for (const [x0, y0, x1, y1] of regions) {
    for (let y = Math.max(0, y0 | 0); y < Math.min(y1 | 0, png.height); y++) {
      for (let x = Math.max(0, x0 | 0); x < Math.min(x1 | 0, png.width); x++) {
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

function countDarkTopLeftEdgePixels(pngPath, toolbar, rect) {
  if (!toolbar || !rect || !fs.existsSync(pngPath)) return 0;
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  const x0 = toolbar.clientX + rect[0];
  const y0 = toolbar.clientY + rect[1];
  const x1 = toolbar.clientX + rect[2];
  const y1 = toolbar.clientY + rect[3];
  let dark = 0;
  function isDarkEdgePixel(x, y) {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return false;
    const i = (y * png.width + x) * 4;
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    const a = png.data[i + 3];
    return !!a && r <= 150 && g <= 150 && b <= 150;
  }
  for (let y = y0; y < Math.min(y0 + 2, y1); y++) {
    for (let x = x0; x < x1; x++) {
      if (isDarkEdgePixel(x, y)) dark++;
    }
  }
  for (let x = x0; x < Math.min(x0 + 2, x1); x++) {
    for (let y = y0; y < y1; y++) {
      if (isDarkEdgePixel(x, y)) dark++;
    }
  }
  return dark;
}

function parseToolbarButtons(dump) {
  return [...dump.matchAll(
    /#(\d+) ok=\d+\/\d+ img=(-?\d+) cmd=(-?\d+) state=0x([0-9a-f]+) style=0x([0-9a-f]+) rect=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/gi,
  )].map(m => ({
    index: Number(m[1]),
    image: Number(m[2]),
    command: Number(m[3]),
    state: parseInt(m[4], 16),
    style: parseInt(m[5], 16),
    rect: m.slice(6).map(Number),
  }));
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
const standardToolbarDump = out.split('\n').find(l => l.includes('toolbar:final:') && l.includes('ctrlId=59392')) || '';
const formattingToolbarDump = out.split('\n').find(l => l.includes('toolbar:final:') && l.includes('ctrlId=59396')) || '';
const disabledStandardButtonCount = (standardToolbarDump.match(/state=0x0 style=0x0/g) || []).length;
const formattingButtons = parseToolbarButtons(formattingToolbarDump);
const formattingRects = formattingButtons.map(button => button.rect);
const fontComboSlot = formattingButtons.find(button => button.command === 165);
const sizeComboSlot = formattingButtons.find(button => button.command === 166);
const formattingRectsBounded =
  formatting &&
  formattingRects.length >= 14 &&
  formattingRects.every(r => r[0] >= 0 && r[1] >= 0 && r[2] <= formatting.clientW && r[3] <= formatting.clientH);
const checkedFormattingButton = formattingButtons.find(button =>
  (button.state & 0x01) && !(button.style & 0x01));
const checkedFormattingSunkenEdgePixels =
  countDarkTopLeftEdgePixels(PNG_OUT, formatting, checkedFormattingButton && checkedFormattingButton.rect);
const disabledStandardIconColorPixels = countColorPixelsInRegions(PNG_OUT, [
  [137, 44, 153, 60],
  [168, 44, 184, 60],
  [191, 44, 207, 60],
  [214, 44, 230, 60],
  [237, 44, 253, 60],
]);
const fontComboWhitePixels = formatting && fontComboSlot
  ? countWhitePixels(PNG_OUT,
      formatting.clientX + fontComboSlot.rect[0] + 2,
      formatting.clientY + fontComboSlot.rect[1] + 2,
      formatting.clientX + fontComboSlot.rect[2] - 18,
      formatting.clientY + fontComboSlot.rect[1] + 16)
  : 0;
const sizeComboWhitePixels = formatting && sizeComboSlot
  ? countWhitePixels(PNG_OUT,
      formatting.clientX + sizeComboSlot.rect[0] + 2,
      formatting.clientY + sizeComboSlot.rect[1] + 2,
      formatting.clientX + sizeComboSlot.rect[2] - 18,
      formatting.clientY + sizeComboSlot.rect[1] + 16)
  : 0;
const fontComboWhiteTarget = fontComboSlot
  ? Math.floor(Math.max(0, fontComboSlot.rect[2] - fontComboSlot.rect[0] - 20) * 14 * 0.55)
  : Infinity;
const sizeComboWhiteTarget = sizeComboSlot
  ? Math.floor(Math.max(0, sizeComboSlot.rect[2] - sizeComboSlot.rect[0] - 20) * 14 * 0.55)
  : Infinity;
const openedNewDialog =
  /window:after-click hwnd=\d+ class="[^"]*" ctrlClass=-?\d+ ctrlId=\d+ .* visible=true(?: minimized=(?:true|false))?(?: iconic=(?:true|false))?(?: zoomed=(?:true|false))?(?: enabled=(?:true|false))?(?: style=0x[0-9a-f]+)? dialog=true .* title="New"/.test(out);

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

check('WordPad reached ShowWindow', /\[ShowWindow\] hwnd=0x10001 cmd=10/.test(out));
check('standard toolbar exists as WAT-native ToolbarWindow32',
  standard &&
  standard.className === 'ToolbarWindow32' &&
  standard.ctrlClass === 21 &&
  standard.visible);
check('standard toolbar has paintable geometry and height',
  standard && standard.w >= 300 && standard.h >= 24);
check('formatting toolbar exists as WAT-native ToolbarWindow32',
  formatting &&
  formatting.className === 'ToolbarWindow32' &&
  formatting.ctrlClass === 21 &&
  formatting.visible);
check('formatting toolbar has paintable geometry and height',
  formatting && formatting.w >= 300 && formatting.h >= 24);
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
  fontCombo.x >= 0 &&
  fontCombo.y >= 0);
check('size combo is visible and separated from the font combo',
  fontCombo &&
  sizeCombo &&
  sizeCombo.className === 'COMBOBOX' &&
  sizeCombo.ctrlClass === 5 &&
  sizeCombo.parent === fontCombo.parent &&
  sizeCombo.visible &&
  sizeCombo.x >= fontCombo.x + fontCombo.w &&
  sizeCombo.y === fontCombo.y);
check('formatting toolbar button rects fit the narrow control bar',
  formattingRectsBounded);
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
check(`standard toolbar state dump exposes disabled command buttons (${disabledStandardButtonCount})`,
  disabledStandardButtonCount >= 5);
check(`disabled standard toolbar icons are visually dimmed (${disabledStandardIconColorPixels} color pixels)`,
  disabledStandardIconColorPixels <= 140);
check(`checked formatting toolbar button paints a sunken edge (${checkedFormattingSunkenEdgePixels} dark edge pixels)`,
  checkedFormattingSunkenEdgePixels >= 70);
check(`toolbar combo fields paint majority-white interiors (${fontComboWhitePixels}/${sizeComboWhitePixels} white pixels)`,
  fontComboWhitePixels >= fontComboWhiteTarget &&
  sizeComboWhitePixels >= sizeComboWhiteTarget);
check('toolbar font and size combo text is populated',
  fontCombo &&
  sizeCombo &&
  fontCombo.title === 'Times New Roman' &&
  sizeCombo.title === '10');
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
