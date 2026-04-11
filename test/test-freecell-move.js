#!/usr/bin/env node
// FreeCell card-move regression: verify a bottom card can be picked up and
// stacked on a column of opposite color / one-higher rank.
//
// Fixed seed: FreeCell's game number is derived from GetTickCount(), which
// test/run.js makes deterministic (tickState.batch * 200 + callsInBatch).
// Running the same batch sequence always picks the same game — currently
// game #7387. Column 5 bottom is 8H, column 4 bottom is 9S, so the move
// 8H -> col4 is legal and expected to produce a visible change.
//
// PASS criteria:
//   - FreeCell launches and renders the initial deal (cards visible)
//   - After the click/click move sequence, the canvas differs from the
//     before snapshot by a meaningful pixel delta (card physically moved)
//   - No UNIMPLEMENTED API crash

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
let createCanvas, loadImage;
try {
  ({ createCanvas, loadImage } = require('canvas'));
} catch (_) {}

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'entertainment-pack', 'freecell.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  freecell.exe not found at', EXE);
  process.exit(0);
}
if (!createCanvas || !loadImage) {
  console.log('SKIP  node-canvas not available — cannot diff PNGs');
  process.exit(0);
}

const TMP = path.join(ROOT, 'scratch');
fs.mkdirSync(TMP, { recursive: true });
const beforePng = path.join(TMP, 'freecell_move_before.png');
const afterPng  = path.join(TMP, 'freecell_move_after.png');
for (const p of [beforePng, afterPng]) {
  try { fs.unlinkSync(p); } catch (_) {}
}

// Game #7387 layout (col indices 1..8, each ~75px wide starting near x=15):
//   col4 bottom ~ 9 of spades @ (275, 290)
//   col5 bottom ~ 8 of hearts @ (350, 290)
// Click col5 bottom (pick up 8H), click col4 bottom (drop onto 9S).
const inputSpec = [
  '50:0x111:102',                         // Game > New Game (F2)
  `300:png:${beforePng}`,                 // snapshot initial deal
  '350:mousedown:350:290', '360:mouseup:350:290',  // select 8H on col5
  '420:mousedown:275:290', '430:mouseup:275:290',  // drop on 9S on col4
  `600:png:${afterPng}`,                  // snapshot after move
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --no-close --input='${inputSpec}' --max-batches=700`;
console.log('$', cmd.replace(ROOT, '.'));

let out = '';
try {
  out = execSync(cmd, {
    encoding: 'utf-8', timeout: 120000, cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero — output captured)');
}

const lines = out.split('\n');
const interesting = lines.filter(l =>
  l.includes('UNIMPLEMENTED') || l.includes('CRASH') || l.includes('LinkError'));
for (const l of interesting) console.log('  ' + l);

async function diffPngs(aPath, bPath) {
  const a = await loadImage(aPath);
  const b = await loadImage(bPath);
  if (a.width !== b.width || a.height !== b.height) {
    return { error: `size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}` };
  }
  const w = a.width, h = a.height;
  const ca = createCanvas(w, h), cb = createCanvas(w, h);
  ca.getContext('2d').drawImage(a, 0, 0);
  cb.getContext('2d').drawImage(b, 0, 0);
  const da = ca.getContext('2d').getImageData(0, 0, w, h).data;
  const db = cb.getContext('2d').getImageData(0, 0, w, h).data;
  let diff = 0;
  for (let i = 0; i < da.length; i += 4) {
    if (da[i] !== db[i] || da[i+1] !== db[i+1] || da[i+2] !== db[i+2]) diff++;
  }
  return { w, h, diff };
}

(async () => {
  const checks = [];
  const sizeOf = p => (fs.existsSync(p) && fs.statSync(p).size > 1000);
  checks.push({ name: 'before snapshot written',    pass: sizeOf(beforePng) });
  checks.push({ name: 'after snapshot written',     pass: sizeOf(afterPng) });
  checks.push({ name: 'no UNIMPLEMENTED API crash', pass: !/UNIMPLEMENTED API:/.test(out) });
  checks.push({ name: 'no CRASH at batch',          pass: !/\*\*\* CRASH/.test(out) });
  checks.push({ name: 'no LinkError',               pass: !/LinkError/.test(out) });

  if (sizeOf(beforePng) && sizeOf(afterPng)) {
    const img = await loadImage(beforePng);
    const w = img.width, h = img.height;
    const c = createCanvas(w, h);
    c.getContext('2d').drawImage(img, 0, 0);
    const data = c.getContext('2d').getImageData(0, 0, w, h).data;
    let nonGreen = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (!(data[i] < 20 && data[i+1] > 100 && data[i+2] < 20)) nonGreen++;
    }
    console.log(`  non-green pixels in before: ${nonGreen}`);
    checks.push({
      name: 'Initial deal shows cards (>= 20000 non-green px)',
      pass: nonGreen >= 20000,
    });

    const d = await diffPngs(beforePng, afterPng);
    if (d.error) {
      console.log('  diff error:', d.error);
      checks.push({ name: 'png diff completed', pass: false });
    } else {
      console.log(`  after vs before: ${d.diff}px`);
      // A single-card move redraws the source column and destination column;
      // expect at least a few hundred pixels to differ.
      checks.push({
        name: 'Card move changed the canvas (>= 500 px diff)',
        pass: d.diff >= 500,
      });
    }
  }

  console.log('');
  let failed = 0;
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  console.log('');
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  console.log(`Snapshots: ${beforePng}  ${afterPng}`);
  process.exit(failed > 0 ? 1 : 0);
})();
