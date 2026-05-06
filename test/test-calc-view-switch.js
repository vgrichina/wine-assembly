#!/usr/bin/env node
// Calculator regression: client area must not show black bleed-through
// from the back-canvas. Win98 calc is a dialog with grey COLOR_BTNFACE
// background; buttons composite on top. Since 499f40a (pre-fill back-
// canvas opaque black) the button-face fill went missing in calc, leaving
// large pure-black regions inside the client area.
//
// We snapshot three states:
//   1. initial Standard view
//   2. View menu open from a real mouse click
//   3. after View → Scientific from real menu clicks
//   4. after View → Standard from real menu clicks
// and assert that the client-area black-pixel ratio is below a generous
// threshold for each. A healthy calc shows almost no pure-black pixels in
// the client (digit segments are dark blue/red, menu strip is grey).
//
// Menu IDs from tools/parse-rsrc.js: View > S&tandard=304, &Scientific=303.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'calc.exe');

if (!fs.existsSync(EXE)) { console.log('SKIP  calc.exe missing'); process.exit(0); }

const OUT = path.join(ROOT, 'scratch');
fs.mkdirSync(OUT, { recursive: true });
const pngStd1 = path.join(OUT, 'calc_view_std1.png');
const pngMenu1 = path.join(OUT, 'calc_view_menu1.png');
const pngSci  = path.join(OUT, 'calc_view_sci.png');
const pngMenu2 = path.join(OUT, 'calc_view_menu2.png');
const pngStd2 = path.join(OUT, 'calc_view_std2.png');
for (const p of [pngStd1, pngMenu1, pngSci, pngMenu2, pngStd2]) { try { fs.unlinkSync(p); } catch (_) {} }

const inputSpec = [
  `30:png:${pngStd1}`,
  `40:click:96:31`,
  `45:png:${pngMenu1}`,
  `55:click:105:71`,
  `80:mousedown:184:86`,
  `83:mouseup:184:86`,
  `90:png:${pngSci}`,
  `100:click:96:31`,
  `105:png:${pngMenu2}`,
  `115:click:105:51`,
  `140:png:${pngStd2}`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --input=${inputSpec} --max-batches=150 --batch-size=50000 --no-close --dump-backcanvas`;
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 30000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero — output captured)');
}

// Calc main window in standard view: pos=40,0 size=262x256, client {x:43,y:41,w:256,h:211}.
// Scientific view is wider; we keep the bbox to the standard client area which is
// always present in both views (top-left of frame).
const STD_BBOX = { x0: 43, y0: 41, x1: 43 + 256, y1: 41 + 211 };
// Scientific view: parse from logs of second run not strictly necessary; it's
// at least as big as standard. We probe the same standard-sized area, which is
// inside scientific too, so any black background bleed shows up there as well.
const SCI_BBOX = STD_BBOX;
const BTN_BBOX = { x0: 98, y0: 191, x1: 133, y1: 218 };
const SCI_DEC_DOT = { x0: 117, y0: 81, x1: 128, y1: 92 };
const SCI_OCT_DOT = { x0: 179, y0: 81, x1: 190, y1: 92 };
const VIEW_STANDARD_CHECK = { x0: 84, y0: 48, x1: 96, y1: 60 };
const VIEW_SCI_CHECK = { x0: 84, y0: 68, x1: 96, y1: 80 };

async function readPixels(p) {
  const img = await loadImage(p);
  const cv = createCanvas(img.width, img.height);
  cv.getContext('2d').drawImage(img, 0, 0);
  return { w: img.width, h: img.height,
           data: cv.getContext('2d').getImageData(0, 0, img.width, img.height).data };
}

function blackRatio(img, bbox) {
  const w = img.w;
  let total = 0, black = 0;
  for (let y = bbox.y0; y < Math.min(bbox.y1, img.h); y++) {
    for (let x = bbox.x0; x < Math.min(bbox.x1, w); x++) {
      const i = (y * w + x) * 4;
      const r = img.data[i], g = img.data[i+1], b = img.data[i+2];
      if (r === 0 && g === 0 && b === 0) black++;
      total++;
    }
  }
  return { black, total, ratio: black / total };
}

function nonFacePixels(img, bbox) {
  const w = img.w;
  let total = 0, nonFace = 0;
  for (let y = bbox.y0; y < Math.min(bbox.y1, img.h); y++) {
    for (let x = bbox.x0; x < Math.min(bbox.x1, w); x++) {
      const i = (y * w + x) * 4;
      const r = img.data[i], g = img.data[i+1], b = img.data[i+2];
      if (!(r === 0xC0 && g === 0xC0 && b === 0xC0)) nonFace++;
      total++;
    }
  }
  return { nonFace, total, ratio: nonFace / total };
}

function darkPixels(img, bbox) {
  const w = img.w;
  let dark = 0;
  for (let y = bbox.y0; y < Math.min(bbox.y1, img.h); y++) {
    for (let x = bbox.x0; x < Math.min(bbox.x1, w); x++) {
      const i = (y * w + x) * 4;
      const r = img.data[i], g = img.data[i+1], b = img.data[i+2];
      if (r < 64 && g < 64 && b < 64) dark++;
    }
  }
  return dark;
}

(async () => {
  const checks = [];
  const dialogRects = [...out.matchAll(/window hwnd=\d+ pos=(-?\d+),(-?\d+) size=(\d+)x(\d+) visible=true dialog=true/g)]
    .map(m => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) }));
  checks.push({
    name: 'calc dialog rectangles dumped',
    pass: dialogRects.length >= 3,
  });
  checks.push({
    name: 'calc fixed dialogs are not oversized vertically',
    pass: dialogRects.length > 0 && dialogRects.every(r => r.h <= 330),
  });
  const exists = (p) => fs.existsSync(p) && fs.statSync(p).size > 0;
  const have1 = exists(pngStd1), haveM1 = exists(pngMenu1), haveS = exists(pngSci), haveM2 = exists(pngMenu2), have2 = exists(pngStd2);
  checks.push({ name: 'standard PNG #1 written', pass: have1 });
  checks.push({ name: 'View menu PNG #1 written', pass: haveM1 });
  checks.push({ name: 'scientific PNG written',  pass: haveS });
  checks.push({ name: 'View menu PNG #2 written', pass: haveM2 });
  checks.push({ name: 'standard PNG #2 written', pass: have2 });

  const THRESH = 0.10; // healthy calc has < 1% pure-black; bug fills >50%
  if (have1) {
    const img = await readPixels(pngStd1);
    const r = blackRatio(img, STD_BBOX);
    checks.push({ name: `std#1 black ratio < ${THRESH} (got ${r.ratio.toFixed(3)})`,
                  pass: r.ratio < THRESH });
    const b = nonFacePixels(img, BTN_BBOX);
    checks.push({ name: `std#1 keypad button visible (>=30 non-face px, got ${b.nonFace})`,
                  pass: b.nonFace >= 30 });
  }
  if (haveS) {
    const img = await readPixels(pngSci);
    const r = blackRatio(img, SCI_BBOX);
    checks.push({ name: `scientific black ratio < ${THRESH} (got ${r.ratio.toFixed(3)})`,
                  pass: r.ratio < THRESH });
    const decDark = darkPixels(img, SCI_DEC_DOT);
    const octDark = darkPixels(img, SCI_OCT_DOT);
    checks.push({ name: `scientific Oct radio selected after click (oct=${octDark}, dec=${decDark})`,
                  pass: octDark > decDark + 3 });
  }
  if (haveM1) {
    const img = await readPixels(pngMenu1);
    const stdCheck = darkPixels(img, VIEW_STANDARD_CHECK);
    const sciCheck = darkPixels(img, VIEW_SCI_CHECK);
    checks.push({ name: `View menu marks Standard initially (std=${stdCheck}, sci=${sciCheck})`,
                  pass: stdCheck > sciCheck + 3 });
  }
  if (haveM2) {
    const img = await readPixels(pngMenu2);
    const stdCheck = darkPixels(img, VIEW_STANDARD_CHECK);
    const sciCheck = darkPixels(img, VIEW_SCI_CHECK);
    checks.push({ name: `View menu marks Scientific after switch (std=${stdCheck}, sci=${sciCheck})`,
                  pass: sciCheck > stdCheck + 3 });
  }
  if (have2) {
    const img = await readPixels(pngStd2);
    const r = blackRatio(img, STD_BBOX);
    checks.push({ name: `std#2 black ratio < ${THRESH} (got ${r.ratio.toFixed(3)})`,
                  pass: r.ratio < THRESH });
    const b = nonFacePixels(img, BTN_BBOX);
    checks.push({ name: `std#2 keypad button visible (>=30 non-face px, got ${b.nonFace})`,
                  pass: b.nonFace >= 30 });
  }

  console.log('');
  let failed = 0;
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  console.log('');
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
})();
