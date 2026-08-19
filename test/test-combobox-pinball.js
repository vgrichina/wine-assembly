#!/usr/bin/env node
// Pinball Player Controls dialog regression: drives the real pinball.exe,
// posts WM_COMMAND id=406 (the F8 menu/accelerator) to open the Player
// Controls dialog, and verifies it renders without crashing.
//
// This dialog is the in-tree fixture for combobox CB_GETITEMDATA /
// CB_SETITEMDATA (commit 8b3b1f3) and the listbox WM_PAINT-while-hidden
// guard (commit ebbd8a4). Pinball stores VK codes per slot via
// CB_SETITEMDATA and reads them back later — without round-tripping
// item-data the dialog's OK button silently lost the user's binding.
//
// PASS criteria:
//   - emulator runs to completion without UNIMPLEMENTED / LinkError
//   - PNG snapshot is written and >1KB
//   - dialog frame ("3D Pinball: Player Controls") logged via CreateDialog
//   - dialog top-level hwnd has visible content (>=8 distinct colors)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
let createCanvas, loadImage;
try { ({ createCanvas, loadImage } = require('../lib/canvas-compat')); } catch (_) {}

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'pinball', 'pinball.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  pinball.exe not found at', EXE);
  process.exit(0);
}
if (!createCanvas || !loadImage) {
  console.log('SKIP  node-canvas not available');
  process.exit(0);
}

const TMP = path.join(ROOT, 'scratch');
fs.mkdirSync(TMP, { recursive: true });
const dlgPng       = path.join(TMP, 'pinball_player_controls.png');
const dropPng      = path.join(TMP, 'pinball_player_controls_dropped.png');
const pickedPng    = path.join(TMP, 'pinball_player_controls_picked.png');
const drop2Png     = path.join(TMP, 'pinball_player_controls_dropped2.png');
const picked2Png   = path.join(TMP, 'pinball_player_controls_picked2.png');
const closedPng    = path.join(TMP, 'pinball_player_controls_closed.png');
for (const p of [dlgPng, dropPng, pickedPng, drop2Png, picked2Png, closedPng]) {
  try { fs.unlinkSync(p); } catch (_) {}
}

// Phases — exercise two open/pick cycles in a row to catch popup-zorder
// regressions (previously the second open landed *behind* the dialog
// because host_move_window's SHOW path didn't re-bump zOrder, while
// every dialog click did).
//   500 — dialog painted
//   510 — click Left Flipper arrow → first open
//   520 — snapshot: dropdown visible
//   530 — click row 4 → first pick + close
//   540 — snapshot: closed, field shows picked letter
//   550 — click Left Flipper arrow again → second open
//   560 — snapshot: dropdown visible AGAIN (regression target)
//   570 — click row 6 → second pick + close
//   600 — snapshot: closed, field shows new letter
//   610 — click dialog titlebar close button
//   630 — snapshot: dialog destroyed, not blanked in-place
const inputSpec = [
  `300:post-cmd:406`,
  `500:png:${dlgPng}`,
  `510:click:170:197`,
  `520:png:${dropPng}`,
  `530:click:110:263`,
  `540:png:${pickedPng}`,
  `550:click:170:197`,
  `560:png:${drop2Png}`,
  `570:click:110:283`,
  `600:png:${picked2Png}`,
  `610:click:424:28`,
  `630:png:${closedPng}`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --batch-size=200000 --max-batches=700 --input='${inputSpec}'`;
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 180000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero — output captured)');
}

const checks = [];
checks.push({ name: 'no UNIMPLEMENTED API crash', pass: !/UNIMPLEMENTED API:/.test(out) });
checks.push({ name: 'no LinkError',               pass: !/LinkError/.test(out) });
checks.push({ name: 'no unreachable trap',        pass: !/RuntimeError: unreachable/.test(out) });

const dlgOk = fs.existsSync(dlgPng) && fs.statSync(dlgPng).size > 1000;
checks.push({ name: 'dialog snapshot written', pass: dlgOk });

const dialogLogged = /\[CreateDialog\] hwnd=0x[0-9a-f]+ parent=0x10002/.test(out);
checks.push({ name: 'CreateDialog fired with main parent', pass: dialogLogged });

async function loadPixels(p) {
  if (!fs.existsSync(p)) return null;
  const img = await loadImage(p);
  const c = createCanvas(img.width, img.height);
  c.getContext('2d').drawImage(img, 0, 0);
  return { w: img.width, h: img.height, data: c.getContext('2d').getImageData(0, 0, img.width, img.height).data };
}

// Sum |Δr|+|Δg|+|Δb| over a sub-rect between two frames.
function rectDiff(a, b, x, y, w, h) {
  if (!a || !b || a.w !== b.w || a.h !== b.h) return 0;
  let total = 0;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * a.w + xx) * 4;
      total += Math.abs(a.data[i]   - b.data[i])
             + Math.abs(a.data[i+1] - b.data[i+1])
             + Math.abs(a.data[i+2] - b.data[i+2]);
    }
  }
  return total;
}

function pixelAt(img, x, y) {
  const i = (y * img.w + x) * 4;
  return [img.data[i], img.data[i+1], img.data[i+2], img.data[i+3]];
}

(async () => {
  if (dlgOk) {
    const img = await loadPixels(dlgPng);
    const seen = new Set();
    for (let y = 0; y < img.h; y += 4) {
      for (let x = 0; x < img.w; x += 4) {
        const i = (y * img.w + x) * 4;
        seen.add((img.data[i] << 16) | (img.data[i+1] << 8) | img.data[i+2]);
      }
    }
    console.log(`  dialog png: ${img.w}x${img.h}, ${seen.size} distinct sampled colors`);
    checks.push({ name: 'dialog snapshot has ≥8 distinct colors', pass: seen.size >= 8 });
  }

  // Combobox dropdown lifecycle: opening adds a WS_POPUP shell with the
  // listbox child; clicking a row selects it + dismisses the popup. We
  // verify both transitions by diffing the dropdown rectangle (the area
  // immediately below the Left Flipper arrow) across the three snapshots.
  // Coords match the click target in inputSpec — the dropdown extends
  // roughly y=210..310, x=85..185.
  const dropImg   = await loadPixels(dropPng);
  const baseImg   = await loadPixels(dlgPng);
  const pickedImg = await loadPixels(pickedPng);

  checks.push({ name: 'dropdown snapshot written',
    pass: !!dropImg && fs.statSync(dropPng).size > 1000 });
  checks.push({ name: 'after-pick snapshot written',
    pass: !!pickedImg && fs.statSync(pickedPng).size > 1000 });

  if (dropImg && baseImg) {
    // Region directly below the Left Flipper arrow — should be empty
    // dialog background before opening, full dropdown after.
    const d = rectDiff(baseImg, dropImg, 85, 215, 100, 95);
    console.log(`  dropdown rect diff base→drop: ${d}`);
    checks.push({ name: 'dropdown rect changed after open click',
      pass: d > 5000 });
  }

  if (dropImg && pickedImg) {
    // Same region — dropdown should disappear after the item-pick click,
    // restoring the dialog background. So the diff drop→picked is large
    // (popup gone), while picked closely matches base.
    const d1 = rectDiff(dropImg, pickedImg, 85, 215, 100, 95);
    console.log(`  dropdown rect diff drop→picked: ${d1}`);
    checks.push({ name: 'dropdown closed after item-pick click',
      pass: d1 > 5000 });
  }

  if (baseImg && pickedImg) {
    // Picking a row updates the combobox field text. CBN_SELCHANGE/SELENDOK/
    // CLOSEUP are POSTED to the dialog (not sent) so they don't reenter the
    // dialog wndproc nested under the JS-driven row-click — that previously
    // froze the emulator at EIP=0 (pinball's wndproc epilogue popped a
    // recursive-scratch ESI=0, then the outer pump's `call esi` jumped to 0).
    // The field-text glyph for the picked letter (e.g. "Z") repaints at the
    // left edge of the field — bbox observed at x=[109,115] y=[193,200].
    const d = rectDiff(baseImg, pickedImg, 105, 193, 20, 12);
    console.log(`  field text rect diff base→picked: ${d}`);
    checks.push({ name: 'field text repainted after pick', pass: d > 50 });
  }

  // Second-cycle: re-open the same combobox and pick again. Regression
  // target — host_move_window's SWP_SHOWWINDOW path used to leave the
  // popup's stale (low) zOrder while every dialog click bumped the dialog
  // ABOVE it, so the second open rendered behind the dialog.
  const drop2Img   = await loadPixels(drop2Png);
  const picked2Img = await loadPixels(picked2Png);
  checks.push({ name: '2nd dropdown snapshot written',
    pass: !!drop2Img && fs.statSync(drop2Png).size > 1000 });
  checks.push({ name: '2nd after-pick snapshot written',
    pass: !!picked2Img && fs.statSync(picked2Png).size > 1000 });
  if (drop2Img && pickedImg) {
    const d = rectDiff(pickedImg, drop2Img, 85, 215, 100, 95);
    console.log(`  dropdown rect diff pick→drop2: ${d}`);
    checks.push({ name: '2nd open: dropdown reappears above dialog',
      pass: d > 5000 });
  }
  if (drop2Img && picked2Img) {
    const d = rectDiff(drop2Img, picked2Img, 85, 215, 100, 95);
    console.log(`  dropdown rect diff drop2→picked2: ${d}`);
    checks.push({ name: '2nd pick: dropdown closes',
      pass: d > 5000 });
  }
  if (baseImg && picked2Img) {
    // Different row this time (y=283 vs 263) → different letter glyph at
    // the field's left edge. Check the same x-rect repaints to a non-base
    // glyph.
    const d = rectDiff(baseImg, picked2Img, 105, 193, 20, 12);
    console.log(`  field text rect diff base→picked2: ${d}`);
    checks.push({ name: '2nd pick: field text updated', pass: d > 50 });
  }

  const closedImg = await loadPixels(closedPng);
  checks.push({ name: 'closed-dialog snapshot written',
    pass: !!closedImg && fs.statSync(closedPng).size > 1000 });
  if (closedImg) {
    const titlePx = pixelAt(closedImg, 20, 28);
    console.log(`  closed title pixel @20,28: ${titlePx.slice(0, 3).join(',')}`);
    checks.push({ name: 'titlebar close destroys dialog chrome',
      pass: !(titlePx[2] > 80 && titlePx[0] < 40 && titlePx[1] < 80) });
  }

  console.log('');
  let failed = 0;
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  console.log('');
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  console.log(`Snapshots: ${dlgPng} ${dropPng} ${pickedPng} ${closedPng}`);
  process.exit(failed > 0 ? 1 : 0);
})();
