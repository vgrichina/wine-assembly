#!/usr/bin/env node
// FreeCell card-move regression: verify a bottom card can be picked up
// and moved to a free cell.
//
// Fixed seed: we explicitly open Select Game (F3, ID 103) and submit
// game number 1 via the edit-ok helper — this pins the layout regardless
// of emulator timing. Game #1 column 1 bottom is the 6 of spades; we pick
// it up and drop it on free cell 1 (an always-legal single-card move).
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

// Game #1 layout: column 1 bottom card is the 6 of spades at roughly
// (52, 290). Free cell 1 is at the top-left at roughly (40, 100).
// Click col1 bottom (pick up 6S), click free cell 1 (drop).
const inputSpec = [
  '50:0x111:103',                         // Game > Select Game (F3)
  '200:edit-ok:203:1',                    // enter "1" into game number, OK
  `400:png:${beforePng}`,                 // snapshot initial deal
  '450:mousedown:52:290', '460:mouseup:52:290',    // pick up 6S on col1
  '520:mousedown:40:100', '530:mouseup:40:100',    // drop on free cell 1
  `700:png:${afterPng}`,                  // snapshot after move
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --no-close --input='${inputSpec}' --max-batches=800`;
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
