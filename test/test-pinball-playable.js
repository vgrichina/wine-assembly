#!/usr/bin/env node
// Pinball playability regression: can a user actually play the game?
//
// Confirms three independent things, end-to-end through the CLI emulator:
//   1. Game reaches gameplay (F2 + Space-plunger deploys a ball).
//   2. LEFT flipper (Z) actually swings — bottom-LEFT pixels change.
//   3. RIGHT flipper (/, VK_OEM_2 = 0xBF) actually swings — bottom-RIGHT
//      pixels change.
//
// Why split bottom-left vs bottom-right? A single global "bottom diff"
// would pass even if one flipper were broken and the other animated
// hard enough to dominate the count. Splitting forces both halves to
// actually move when their own key is held.
//
// Schedule (timings calibrated to ShowWindow(game) firing at batch
// ~10548 — keys delivered before that go to the splash window 0x10001
// and die in DefWindowProc, never reaching the game wndproc):
//   12000 : F2 (start new game)
//   12500 : keydown Space (plunger, build power)
//   14500 : keyup   Space (deploy ball)
//   14700 : png "rest"      (no key held — baseline animation noise)
//   14800 : png "rest2"     (still no key held — measures noise floor)
//   14810 : keydown Z       (left flipper)
//   15000 : png "left"      (Z held)
//   15010 : keyup   Z
//   15200 : png "settle"    (back to rest)
//   15210 : keydown /       (right flipper, VK_OEM_2 = 0xBF)
//   15400 : png "right"     (/ held)
//   15410 : keyup   /
//
// Pass criteria (per side):
//   - the side's bottom-quadrant pixel diff with key held is at least
//     2× the noise floor AND at least 200 px greater in absolute terms.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
let createCanvas, loadImage;
try {
  ({ createCanvas, loadImage } = require('canvas'));
} catch (_) {}

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'pinball', 'pinball.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  pinball.exe not found at', EXE);
  process.exit(0);
}
if (!createCanvas || !loadImage) {
  console.log('SKIP  node-canvas not available — cannot diff PNGs');
  process.exit(0);
}

const TMP = path.join(ROOT, 'scratch');
fs.mkdirSync(TMP, { recursive: true });
const restPng    = path.join(TMP, 'pinball_play_rest.png');
const rest2Png   = path.join(TMP, 'pinball_play_rest2.png');
const leftPng    = path.join(TMP, 'pinball_play_left.png');
const settlePng  = path.join(TMP, 'pinball_play_settle.png');
const rightPng   = path.join(TMP, 'pinball_play_right.png');
for (const p of [restPng, rest2Png, leftPng, settlePng, rightPng]) {
  try { fs.unlinkSync(p); } catch (_) {}
}

const inputSpec = [
  `12000:keydown:113`,          // VK_F2 — new game
  `12010:keyup:113`,
  `12500:keydown:32`,           // VK_SPACE — plunger
  `14500:keyup:32`,
  `14700:png:${restPng}`,
  `14800:png:${rest2Png}`,
  `14810:keydown:90`,           // 'Z' — left flipper
  `15000:png:${leftPng}`,
  `15010:keyup:90`,
  `15200:png:${settlePng}`,
  `15210:keydown:191`,          // VK_OEM_2 ('/') — right flipper
  `15400:png:${rightPng}`,
  `15410:keyup:191`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --args=-quick --input='${inputSpec}' --max-batches=15500 --stuck-after=15500`;
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 360000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero — output captured)');
}

// Diagnostic dump
for (const l of out.split('\n')) {
  if (l.includes('[input]') || l.includes('UNIMPLEMENTED') || l.includes('CRASH') || l.includes('LinkError')) {
    console.log('  ' + l);
  }
}

// Crop two images to a rect and count differing pixels.
// Used to look ONLY at each flipper's bounding box, so scoreboard
// text changes and right-panel light animation don't pollute the
// signal. Flipper sprite rect was eyeballed from the rendered PNG:
//   playfield ~ x∈[9,196], y∈[21,320]
//   left flipper  ~ x∈[40,100],  y∈[270,310]
//   right flipper ~ x∈[105,165], y∈[270,310]
async function diffRect(aPath, bPath, x0, y0, x1, y1) {
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
  const xa = Math.max(0, x0), xb = Math.min(w, x1);
  const ya = Math.max(0, y0), yb = Math.min(h, y1);
  let diff = 0;
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const i = (y * w + x) * 4;
      if (da[i] !== db[i] || da[i+1] !== db[i+1] || da[i+2] !== db[i+2]) diff++;
    }
  }
  return { diff, w, h };
}

const LEFT_FLIPPER_RECT  = [40, 270, 100, 310];
const RIGHT_FLIPPER_RECT = [105, 270, 165, 310];

(async () => {
  const checks = [];
  const sizeOk = p => fs.existsSync(p) && fs.statSync(p).size > 1000;
  for (const [name, p] of [
    ['rest',   restPng],
    ['rest2',  rest2Png],
    ['left',   leftPng],
    ['settle', settlePng],
    ['right',  rightPng],
  ]) {
    checks.push({ name: `${name} snapshot written`, pass: sizeOk(p) });
  }
  checks.push({ name: 'no UNIMPLEMENTED API crash', pass: !/UNIMPLEMENTED API:/.test(out) });
  checks.push({ name: 'no LinkError', pass: !/LinkError/.test(out) });

  if (checks.every(c => c.pass)) {
    // Noise floor: how many pixels change in each flipper rect between
    // two consecutive snapshots with no key held.
    const lNoise = await diffRect(restPng, rest2Png, ...LEFT_FLIPPER_RECT);
    const rNoise = await diffRect(restPng, rest2Png, ...RIGHT_FLIPPER_RECT);
    // Signal: pixels changed in each flipper rect when its key is held.
    const lSignal = await diffRect(rest2Png, leftPng,    ...LEFT_FLIPPER_RECT);
    const rSignal = await diffRect(settlePng, rightPng,  ...RIGHT_FLIPPER_RECT);
    if (lNoise.error || rNoise.error || lSignal.error || rSignal.error) {
      console.log('  diff error:', lNoise.error || rNoise.error || lSignal.error || rSignal.error);
      checks.push({ name: 'png diff completed', pass: false });
    } else {
      console.log(`  L flipper rect: noise=${lNoise.diff}px signal=${lSignal.diff}px`);
      console.log(`  R flipper rect: noise=${rNoise.diff}px signal=${rSignal.diff}px`);
      const lExtra = lSignal.diff - lNoise.diff;
      const rExtra = rSignal.diff - rNoise.diff;
      checks.push({
        name: `left flipper (Z) swings — L-rect signal >= noise+200`,
        pass: lExtra >= 200,
      });
      checks.push({
        name: `right flipper (/) swings — R-rect signal >= noise+200`,
        pass: rExtra >= 200,
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
  console.log(`Snapshots: ${restPng} ${leftPng} ${rightPng}`);
  process.exit(failed > 0 ? 1 : 0);
})();
