#!/usr/bin/env node
// Calculator arithmetic regression. Drives 1 + 2 = via mouse clicks at the
// standard-view button screen coordinates, then asserts that the display
// area changed between the initial "0." snapshot and the post-calculation
// snapshot (i.e. calc actually evaluated something).
//
// Button screen coords (window pos=40,0, client at +43,+41; children are
// client-relative; standard view):
//   '1' = (115, 204)   '2' = (154, 204)
//   '+' = (232, 239)   '=' = (271, 239)

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
const pngBefore = path.join(OUT, 'calc_arith_before.png');
const pngAfter  = path.join(OUT, 'calc_arith_after.png');

// Calc only polls input infrequently (most GetMessage iterations are
// consumed by NC_FLAGS / paint queue), so spread clicks ~100 batches apart
// and snapshot near the end after another long settle.
const click = (b, x, y) => [`${b}:mousedown:${x}:${y}`, `${b+3}:mouseup:${x}:${y}`];
const inputSpec = [
  `50:png:${pngBefore}`,
  ...click(100, 115, 204),  // '1'
  ...click(200, 232, 239),  // '+'
  ...click(300, 154, 204),  // '2'
  ...click(400, 271, 239),  // '='
  `495:png:${pngAfter}`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --input=${inputSpec} --max-batches=500 --batch-size=50000 --no-close`;
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 120000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero — output captured)');
}

// The 7-segment-style display sits in the top-right of the dialog client
// area. Standard view: client at (43,41), w=256 h=211. The number text is
// right-aligned in a static at roughly y=51..67 within a wide rect that ends
// near client x=256-10. We probe a generous slab covering the right half of
// the display row, which is where '0.' / '3.' renders.
const DISPLAY_BBOX = { x0: 43 + 100, y0: 41, x1: 43 + 256, y1: 41 + 22 };

async function readPixels(p) {
  const img = await loadImage(p);
  const cv = createCanvas(img.width, img.height);
  cv.getContext('2d').drawImage(img, 0, 0);
  return { w: img.width, h: img.height,
           data: cv.getContext('2d').getImageData(0, 0, img.width, img.height).data };
}

function diffPixels(A, B, bbox) {
  const w = Math.min(A.w, B.w), h = Math.min(A.h, B.h);
  let n = 0;
  for (let y = bbox.y0; y < Math.min(bbox.y1, h); y++) {
    for (let x = bbox.x0; x < Math.min(bbox.x1, w); x++) {
      const i = (y * w + x) * 4;
      if (A.data[i] !== B.data[i] || A.data[i+1] !== B.data[i+1] || A.data[i+2] !== B.data[i+2]) n++;
    }
  }
  return n;
}

(async () => {
  const checks = [];
  const exists = (p) => fs.existsSync(p) && fs.statSync(p).size > 0;
  const haveB = exists(pngBefore), haveA = exists(pngAfter);
  checks.push({ name: 'before PNG written', pass: haveB });
  checks.push({ name: 'after PNG written',  pass: haveA });
  checks.push({ name: 'no UNIMPLEMENTED API crash', pass: !/UNIMPLEMENTED API:/.test(out) });

  let nDiff = -1;
  if (haveB && haveA) {
    const [A, B] = await Promise.all([readPixels(pngBefore), readPixels(pngAfter)]);
    nDiff = diffPixels(A, B, DISPLAY_BBOX);
  }
  // '0.' → '3.' transition dirties ~18 pixels in the right-aligned display.
  // 0 = clicks didn't land; we need at least a clear digit-shape difference.
  checks.push({ name: `display changed after 1+2= (>=10 px, got ${nDiff})`, pass: nDiff >= 10 });

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
