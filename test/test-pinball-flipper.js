#!/usr/bin/env node
// Pinball flipper regression: did pressing the left flipper actually
// change anything on screen?
//
// Drives the CLI emulator end-to-end:
//   1. Launch pinball.exe (companion data files auto-loaded by run.js).
//   2. Run ~6000 batches so pinball reaches its GetMessageA gameplay loop
//      (per pinball.md, the table is rendering by ~5000 batches).
//   3. Inject F2 (VK_F2=0x71) to start a new game.
//   4. Run more batches to let the game settle.
//   5. Snapshot screen → before.png.
//   6. Inject Z keydown (VK 0x5A) — left flipper.
//   7. Run more batches to let the flipper animate.
//   8. Snapshot screen → after.png.
//   9. Inject Z keyup so the flipper returns to rest.
//
// PASS criteria:
//   - both PNGs were written
//   - the lower portion of the table (where the flippers live) has at
//     least N differing pixels between before/after
//
// The whole point is that the user reported flippers look broken — if
// the bottom of the table never changes when Z is pressed, this test
// FAILS loudly so we know to dig into rotated-sprite blits.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
let createCanvas, loadImage;
try {
  ({ createCanvas, loadImage } = require('../lib/canvas-compat'));
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
const beforePng  = path.join(TMP, 'pinball_flipper_before.png');
const controlPng = path.join(TMP, 'pinball_flipper_control.png');
const afterPng   = path.join(TMP, 'pinball_flipper_after.png');
for (const p of [beforePng, controlPng, afterPng]) { try { fs.unlinkSync(p); } catch (_) {} }

// Schedule (batch numbers chosen so pinball has time to reach gameplay).
// IMPORTANT: pinball gates flipper input on "ball in play" — F2 alone
// leaves the table in "Awaiting Deployment" and Z is silently no-op'd
// by the game-state object's update path. We must hold Space (the
// plunger) to deploy the ball before pressing Z.
//
//   5000 : F2 (start new game)
//   5500 : keydown Space (plunger) — needs ~2000 batches to build full
//                                     plunger power and actually deploy
//   7500 : keyup Space   (ball is now in play)
//   7700 : snapshot "before"   (no flipper key held)
//   7800 : snapshot "control"  (still no flipper key — animation noise)
//   7810 : keydown Z   (left flipper)
//   8000 : snapshot "after"    (with flipper key held ~190 batches)
//   8010 : keyup Z
//
// Comparison:
//   noise = pixel diff(before, control)         — baseline animation
//   move  = pixel diff(control, after)          — same gap, with key held
// If `move` is not meaningfully larger than `noise` (especially in the
// bottom 30% where the flippers live), the flipper is broken.
const inputSpec = [
  `5000:keydown:113`,    // VK_F2
  `5010:keyup:113`,
  `5500:keydown:32`,     // VK_SPACE = plunger (hold ~2000 batches)
  `7500:keyup:32`,
  `7700:png:${beforePng}`,
  `7800:png:${controlPng}`,
  `7810:keydown:90`,     // VK 'Z' = left flipper
  `8000:png:${afterPng}`,
  `8010:keyup:90`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --args=-quick --input='${inputSpec}' --max-batches=8100 --stuck-after=8100`;
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 300000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero — output captured)');
}

// Diagnostic dump
const lines = out.split('\n');
const interesting = lines.filter(l =>
  l.includes('[input]') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH') ||
  l.includes('LinkError'));
for (const l of interesting) console.log('  ' + l);

// Pixel diff helper: returns { totalDiff, bottomDiff, w, h, bottomRect }.
// "Bottom" = lower 30% of the rendered window (flipper region).
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
  const yBottom = Math.floor(h * 0.7);
  let totalDiff = 0, bottomDiff = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (da[i] !== db[i] || da[i+1] !== db[i+1] || da[i+2] !== db[i+2]) {
        totalDiff++;
        if (y >= yBottom) bottomDiff++;
      }
    }
  }
  return { w, h, yBottom, totalDiff, bottomDiff };
}

(async () => {
  const checks = [];

  const sizeOf = p => (fs.existsSync(p) && fs.statSync(p).size > 1000);
  const beforeOk  = sizeOf(beforePng);
  const controlOk = sizeOf(controlPng);
  const afterOk   = sizeOf(afterPng);
  checks.push({ name: 'before  snapshot written', pass: beforeOk });
  checks.push({ name: 'control snapshot written', pass: controlOk });
  checks.push({ name: 'after   snapshot written', pass: afterOk });
  checks.push({ name: 'no UNIMPLEMENTED API crash', pass: !/UNIMPLEMENTED API:/.test(out) });
  checks.push({ name: 'no LinkError', pass: !/LinkError/.test(out) });

  if (beforeOk && controlOk && afterOk) {
    const noise = await diffPngs(beforePng, controlPng);  // animation noise
    const move  = await diffPngs(controlPng, afterPng);   // with key held
    if (noise.error || move.error) {
      console.log('  diff error:', noise.error || move.error);
      checks.push({ name: 'png diff completed', pass: false });
    } else {
      console.log(`  noise (no key)   : total=${noise.totalDiff}px, bottom(y≥${noise.yBottom})=${noise.bottomDiff}px`);
      console.log(`  move  (Z held)   : total=${move.totalDiff}px,  bottom(y≥${move.yBottom})=${move.bottomDiff}px`);
      checks.push({ name: 'png diff completed', pass: true });
      // Flipper swing should change WAY more pixels than the baseline
      // animation noise. We require both a 2× absolute increase in the
      // bottom-30% region and at least 200 extra changed pixels (so a
      // tiny noise floor doesn't auto-pass via the ratio).
      const extra = move.bottomDiff - noise.bottomDiff;
      const ratioOk = move.bottomDiff >= noise.bottomDiff * 2;
      console.log(`  bottom delta = ${extra}px, ratio = ${(move.bottomDiff / Math.max(1, noise.bottomDiff)).toFixed(2)}x`);
      checks.push({
        name: 'flipper swing visible in bottom 30% (>= noise*2 and >=200 extra px)',
        pass: ratioOk && extra >= 200,
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
