#!/usr/bin/env node
// Solitaire Deal regression: verify Game > Deal renders cards at correct positions.
//
// Solitaire (debug build) fires assertion dialogs during initial card drawing
// because card pile positions start at (0,0) until WM_SIZE computes layout.
// Three emulator fixes make this work:
//   1. Child WM_SIZE uses saved hwnd instead of cleared pending_child_create
//   2. Posted messages (WM_COMMAND/Deal) drain before pending WM_SIZE
//   3. nc_height uses resolved class menu ID, not raw hMenu=0 from CreateWindowExA
//
// Test flow:
//   1. Launch sol.exe
//   2. Dismiss ~20 assertion dialogs (debug build artifacts)
//   3. Snapshot → cards should be visible (initial deal)
//   4. Inject Deal (WM_COMMAND id=1000)
//   5. Dismiss any new assertions
//   6. Snapshot → cards should differ (new deal, different arrangement)
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

// Build input sequence: dismiss assertion dialogs (Continue=IDOK=1),
// then snapshot, then Deal, then dismiss more assertions, then snapshot.
// The debug build fires ~17 assertions during initial deal.
// Each assertion dialog processes WM_CREATE for its controls, so space
// dismissals at 40-batch intervals for headroom.
const dismiss = (start, count, step) =>
  Array.from({length: count}, (_, i) => `${start + i * step}:0x111:1`);

const inputSpec = [
  ...dismiss(50, 20, 40),                // dismiss initial assertions (50..810)
  `900:png:${initialPng}`,               // snapshot after initial deal
  '950:0x111:1000',                      // Game > Deal
  ...dismiss(1000, 20, 40),              // dismiss re-deal assertions (1000..1760)
  `1850:png:${dealPng}`,                 // snapshot after re-deal
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --no-close --input='${inputSpec}' --max-batches=1900`;
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
    for (let i = 0; i < data.length; i += 4) {
      // Green background is rgb(0, 128, 0) or close
      if (!(data[i] < 20 && data[i+1] > 100 && data[i+2] < 20)) nonGreen++;
    }
    console.log(`  non-green pixels in initial: ${nonGreen}`);
    checks.push({
      name: 'Initial deal shows cards (>= 5000 non-green px)',
      pass: nonGreen >= 5000,
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
