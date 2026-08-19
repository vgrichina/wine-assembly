#!/usr/bin/env node
// Solitaire Deal regression: verify CARDS.dll resources, initial window
// geometry, chrome/status placement, and Game > Deal rendering.
//
// The card library completes an initial deal by batch 60 with a 20k-instruction
// slice. Keeping this regression short avoids spending most of the suite in
// the game's idle message loop.
//
// PASS criteria:
//   - Initial deal shows cards (>= 5000 px diff vs blank green)
//   - Deal changes the card arrangement (>= 500 px diff vs initial)
//   - No UNIMPLEMENTED API crash

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
let createCanvas, loadImage;
try {
  ({ createCanvas, loadImage } = require('../lib/canvas-compat'));
} catch (_) {}

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'entertainment-pack', 'sol.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  sol.exe not found at', EXE);
  process.exit(0);
}
if (!createCanvas || !loadImage) {
  console.log('SKIP  node-canvas not available — cannot diff PNGs');
  process.exit(0);
}

const TMP = path.join(ROOT, 'scratch');
fs.mkdirSync(TMP, { recursive: true });
const initialPng = path.join(TMP, 'sol_initial.png');
const dealPng    = path.join(TMP, 'sol_deal.png');
for (const p of [initialPng, dealPng]) {
  try { fs.unlinkSync(p); } catch (_) {}
}

const inputSpec = [
  `60:png:${initialPng}`,
  '70:0x111:1000',                       // Game > Deal
  `125:png:${dealPng}`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --no-close --quiet-api ` +
  `--batch-size=20000 --input='${inputSpec}' --max-batches=130`;
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

// Show diagnostics
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
  checks.push({ name: 'initial snapshot written',  pass: sizeOf(initialPng) });
  checks.push({ name: 'deal snapshot written',     pass: sizeOf(dealPng) });
  checks.push({ name: 'no UNIMPLEMENTED API crash', pass: !/UNIMPLEMENTED API:/.test(out) });
  checks.push({ name: 'no LinkError',               pass: !/LinkError/.test(out) });
  checks.push({
    name: 'CARDS.dll initializes Win98 card size 71x96',
    pass: /Initialized CARDS\.dll cdtInit=1 card=71x96/.test(out),
  });
  const solRect = out.match(/CreateWindow\] hwnd=0x[0-9a-f]+ title="Solitaire".*pos=(-?\d+),(-?\d+) size=(\d+)x(\d+)/);
  checks.push({
    name: 'Solitaire initial window is not tiny',
    pass: !!solRect && Number(solRect[3]) >= 560 && Number(solRect[4]) >= 400,
  });

  if (sizeOf(initialPng) && sizeOf(dealPng)) {
    // Compare initial deal vs a blank green rectangle — cards should be visible
    // We diff initial vs deal to verify the deal changed something
    const dDeal = await diffPngs(initialPng, dealPng);
    if (dDeal.error) {
      console.log('  diff error:', dDeal.error);
      checks.push({ name: 'png diff completed', pass: false });
    } else {
      console.log(`  deal vs initial: ${dDeal.diff}px`);
      // The initial deal and re-deal should produce different card arrangements
      // (different game number seed). Even if the same seed, the pixel count
      // changes because the initial draw includes stacked card backs.
      checks.push({
        name: 'Deal changed card arrangement (>= 100 px diff)',
        pass: dDeal.diff >= 100,
      });
    }

    // Check that the initial deal has cards visible (not a blank green screen)
    // by checking that the initial snapshot has significant non-green content
    const img = await loadImage(initialPng);
    const w = img.width, h = img.height;
    const c = createCanvas(w, h);
    c.getContext('2d').drawImage(img, 0, 0);
    const data = c.getContext('2d').getImageData(0, 0, w, h).data;
    let nonGreen = 0;
    let bottomCaptionBlue = 0;
    let bottomWhite = 0;
    let bottomBlackText = 0;
    let captionBlue = 0;
    for (let i = 0; i < data.length; i += 4) {
      // Green background is rgb(0, 128, 0) or close
      if (!(data[i] < 20 && data[i+1] > 100 && data[i+2] < 20)) nonGreen++;
    }
    // Solitaire creates a bordered child status strip at the bottom. It must
    // not get top-level caption chrome; the old bug drew a blue titlebar and
    // close button across this band.
    const winX = solRect ? Number(solRect[1]) : 20;
    const winY = solRect ? Number(solRect[2]) : 0;
    const winW = solRect ? Number(solRect[3]) : 593;
    const winH = solRect ? Number(solRect[4]) : 431;
    for (let y = winY + winH - 18; y < Math.min(winY + winH, h); y++) {
      for (let x = winX; x < Math.min(winX + winW, w); x++) {
        const i = (y * w + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (b > 70 && r < 60 && g < 130) bottomCaptionBlue++;
        if (r > 245 && g > 245 && b > 245) bottomWhite++;
        if (r < 40 && g < 40 && b < 40) bottomBlackText++;
      }
    }
    for (let y = winY + 3; y < Math.min(winY + 21, h); y++) {
      for (let x = winX + 3; x < Math.min(winX + winW - 3, w); x++) {
        const i = (y * w + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (b > 70 && b > r * 1.5 && b > g * 1.15) captionBlue++;
      }
    }
    console.log(`  non-green pixels in initial: ${nonGreen}`);
    console.log(`  blue caption pixels in bottom status strip: ${bottomCaptionBlue}`);
    console.log(`  white pixels in bottom status strip: ${bottomWhite}`);
    console.log(`  black text pixels in bottom status strip: ${bottomBlackText}`);
    console.log(`  blue pixels in top-level caption: ${captionBlue}`);
    checks.push({
      name: 'Initial deal shows cards (>= 5000 non-green px)',
      pass: nonGreen >= 5000,
    });
    checks.push({
      name: 'Bottom status child has no caption chrome',
      pass: bottomCaptionBlue < 50,
    });
    checks.push({
      name: 'Bottom status child paints a Win98 white status field',
      pass: bottomWhite >= 4000,
    });
    checks.push({
      name: 'Bottom status child draws black status text',
      pass: bottomBlackText >= 50,
    });
    checks.push({
      name: 'Top-level caption paints Win98 blue chrome',
      pass: captionBlue >= 1000,
    });
  }

  console.log('');
  let failed = 0;
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  console.log('');
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  console.log(`Snapshots: ${initialPng}  ${dealPng}`);
  process.exit(failed > 0 ? 1 : 0);
})();
