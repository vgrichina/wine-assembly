#!/usr/bin/env node
// Calculator regression: client area must not show black bleed-through
// from the back-canvas. Win98 calc is a dialog with grey COLOR_BTNFACE
// background; buttons composite on top. Since 499f40a (pre-fill back-
// canvas opaque black) the button-face fill went missing in calc, leaving
// large pure-black regions inside the client area.
//
// We snapshot three states:
//   1. initial Standard view
//   2. after View → Scientific (post-cmd 303)
//   3. after View → Standard (post-cmd 304)
// and assert that the client-area black-pixel ratio is below a generous
// threshold for each. A healthy calc shows almost no pure-black pixels in
// the client (digit segments are dark blue/red, menu strip is grey).
//
// Menu IDs from tools/parse-rsrc.js: View > S&tandard=304, &Scientific=303.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadImage, createCanvas } = require('canvas');

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'calc.exe');

if (!fs.existsSync(EXE)) { console.log('SKIP  calc.exe missing'); process.exit(0); }

const OUT = path.join(ROOT, 'scratch');
fs.mkdirSync(OUT, { recursive: true });
const pngStd1 = path.join(OUT, 'calc_view_std1.png');
const pngSci  = path.join(OUT, 'calc_view_sci.png');
const pngStd2 = path.join(OUT, 'calc_view_std2.png');
for (const p of [pngStd1, pngSci, pngStd2]) { try { fs.unlinkSync(p); } catch (_) {} }

const inputSpec = [
  `30:png:${pngStd1}`,
  `40:post-cmd:303`,
  `90:png:${pngSci}`,
  `100:post-cmd:304`,
  `135:png:${pngStd2}`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --input=${inputSpec} --max-batches=140 --batch-size=50000 --no-close`;
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 120000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
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

(async () => {
  const checks = [];
  const exists = (p) => fs.existsSync(p) && fs.statSync(p).size > 0;
  const have1 = exists(pngStd1), haveS = exists(pngSci), have2 = exists(pngStd2);
  checks.push({ name: 'standard PNG #1 written', pass: have1 });
  checks.push({ name: 'scientific PNG written',  pass: haveS });
  checks.push({ name: 'standard PNG #2 written', pass: have2 });

  const THRESH = 0.10; // healthy calc has < 1% pure-black; bug fills >50%
  if (have1) {
    const r = blackRatio(await readPixels(pngStd1), STD_BBOX);
    checks.push({ name: `std#1 black ratio < ${THRESH} (got ${r.ratio.toFixed(3)})`,
                  pass: r.ratio < THRESH });
  }
  if (haveS) {
    const r = blackRatio(await readPixels(pngSci), SCI_BBOX);
    checks.push({ name: `scientific black ratio < ${THRESH} (got ${r.ratio.toFixed(3)})`,
                  pass: r.ratio < THRESH });
  }
  if (have2) {
    const r = blackRatio(await readPixels(pngStd2), STD_BBOX);
    checks.push({ name: `std#2 black ratio < ${THRESH} (got ${r.ratio.toFixed(3)})`,
                  pass: r.ratio < THRESH });
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
