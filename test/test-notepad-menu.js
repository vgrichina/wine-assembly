#!/usr/bin/env node
// Notepad menu regression: opening, navigating, and closing the menu
// bar must produce visible pixel changes and end up with the WAT-side
// menu state in the right shape.
//
// Drives the CLI emulator end-to-end:
//   1. Launch notepad.exe.
//   2. Run a few dozen batches so the main window + menu bar are up.
//   3. Snapshot screen → before.png (idle, no menu open).
//   4. Inject Alt+F (vk 18, vk 70) to open the File dropdown via the
//      WAT bar-accelerator table ($menu_find_bar_accel + $menu_open).
//   5. Snapshot screen → open.png (dropdown overlay should be drawn
//      by $menu_paint_dropdown via the WAT-owned state).
//   6. Inject Down (vk 40) twice to advance the dropdown hover —
//      $menu_advance owns the cursor, so the highlighted row should
//      move and produce another pixel diff vs open.png.
//   7. Snapshot screen → hover.png.
//   8. Inject Escape (vk 27) to call $menu_close.
//   9. Snapshot screen → close.png (should match before.png closely).
//
// PASS criteria:
//   - All four PNGs were written.
//   - open.png differs from before.png by a meaningful amount (the
//     dropdown is real pixels, not a no-op).
//   - hover.png differs from open.png (advance moved the highlight).
//   - close.png is close to before.png (no leaked dropdown overlay).
//   - No UNIMPLEMENTED API crash, no LinkError.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
let createCanvas, loadImage;
try {
  ({ createCanvas, loadImage } = require('../lib/canvas-compat'));
} catch (_) {}

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'notepad.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  notepad.exe not found at', EXE);
  process.exit(0);
}
if (!createCanvas || !loadImage) {
  console.log('SKIP  node-canvas not available — cannot diff PNGs');
  process.exit(0);
}

const TMP = path.join(ROOT, 'scratch');
fs.mkdirSync(TMP, { recursive: true });
const beforePng = path.join(TMP, 'notepad_menu_before.png');
const openPng   = path.join(TMP, 'notepad_menu_open.png');
const hoverPng  = path.join(TMP, 'notepad_menu_hover.png');
const closePng  = path.join(TMP, 'notepad_menu_close.png');
for (const p of [beforePng, openPng, hoverPng, closePng]) {
  try { fs.unlinkSync(p); } catch (_) {}
}

// VK codes
const VK_RETURN = 13;
const VK_ESCAPE = 27;
const VK_DOWN   = 40;
const VK_MENU   = 18; // Alt
const VK_F      = 70;

const inputSpec = [
  '19:dump-windows:np',
  `20:png:${beforePng}`,
  `22:keydown:${VK_MENU}`,    // Alt down
  `23:keydown:${VK_F}`,       // F → opens File menu via WAT
  `24:keyup:${VK_F}`,
  `25:keyup:${VK_MENU}`,
  `30:png:${openPng}`,
  `32:keydown:${VK_DOWN}`,    // advance hover
  `33:keydown:${VK_DOWN}`,
  `38:png:${hoverPng}`,
  `40:keydown:${VK_ESCAPE}`,  // close
  `45:png:${closePng}`,
  `46:stop`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --no-close --input='${inputSpec}' --max-batches=70`;
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 60000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
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

async function rgbAt(pngPath, x, y) {
  const image = await loadImage(pngPath);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return [...ctx.getImageData(x, y, 1, 1).data.subarray(0, 3)];
}

(async () => {
  const checks = [];
  const sizeOf = p => (fs.existsSync(p) && fs.statSync(p).size > 1000);
  checks.push({ name: 'before snapshot written', pass: sizeOf(beforePng) });
  checks.push({ name: 'open   snapshot written', pass: sizeOf(openPng) });
  checks.push({ name: 'hover  snapshot written', pass: sizeOf(hoverPng) });
  checks.push({ name: 'close  snapshot written', pass: sizeOf(closePng) });
  checks.push({ name: 'no UNIMPLEMENTED API crash', pass: !/UNIMPLEMENTED API:/.test(out) });
  checks.push({ name: 'no LinkError', pass: !/LinkError/.test(out) });
  checks.push({ name: 'no repaint recursion stack overflow', pass: !/Maximum call stack|RangeError/.test(out) });

  if (sizeOf(beforePng) && sizeOf(openPng) && sizeOf(hoverPng) && sizeOf(closePng)) {
    const dOpen   = await diffPngs(beforePng, openPng);
    const dHover  = await diffPngs(openPng,   hoverPng);
    const dClose  = await diffPngs(beforePng, closePng);

    if (dOpen.error || dHover.error || dClose.error) {
      console.log('  diff error:', dOpen.error || dHover.error || dClose.error);
      checks.push({ name: 'png diff completed', pass: false });
    } else {
      console.log(`  open  vs before: ${dOpen.diff}px`);
      console.log(`  hover vs open  : ${dHover.diff}px`);
      console.log(`  close vs before: ${dClose.diff}px`);
      // Dropdown overlay should change a bunch of pixels — File menu
      // dropdown is roughly 180x140 ≈ 25k pixels, but with anti-alias
      // and partial colour matches the diff is usually a few thousand.
      checks.push({
        name: 'Alt+F dropdown drew >= 1500 px diff vs idle',
        pass: dOpen.diff >= 1500,
      });
      // Sample the dropdown body relative to Notepad's live window origin
      // rather than at a fixed desktop point: the File popup hangs off the
      // menu bar, so it moves with the frame, and a constant here silently
      // starts measuring the desktop the moment default placement changes.
      const npWindow = (() => {
        const line = lines.find(l => l.includes('window:np ') && l.includes('class="Notepad"'));
        const m = line && line.match(/pos=(-?\d+),(-?\d+)/);
        return m ? { x: +m[1], y: +m[2] } : null;
      })();
      const anchor = npWindow
        ? { x: npWindow.x + 10, y: npWindow.y + 46 }
        : { x: 30, y: 66 };
      const popupTopLeft = await rgbAt(openPng, anchor.x, anchor.y);
      const preservedDesktop = await rgbAt(openPng, 500, 300);
      checks.push({
        name: `dropdown is anchored below File at (${anchor.x},${anchor.y})${npWindow ? '' : ' [window pos not reported]'}`,
        pass: !!npWindow &&
          popupTopLeft[0] >= 190 && popupTopLeft[1] >= 190 && popupTopLeft[2] >= 190,
      });
      checks.push({
        name: 'overlay does not cover unrelated desktop pixels',
        pass: preservedDesktop[0] === 0 && preservedDesktop[1] === 128 && preservedDesktop[2] === 128,
      });
      // Hover advance should also change pixels (highlight bar moves
      // by one row). Two rows of ~180px wide ≈ a few hundred px diff.
      checks.push({
        name: 'Down arrow moved highlight (>= 100 px diff vs open)',
        pass: dHover.diff >= 100,
      });
      // Escape should leave the screen visually identical to before
      // — allow a tiny bit of slack for caret/blink animation.
      checks.push({
        name: 'Escape closed dropdown (< 200 px diff vs before)',
        pass: dClose.diff < 200,
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
  console.log(`Snapshots: ${beforePng}  ${openPng}  ${hoverPng}  ${closePng}`);
  process.exitCode = failed > 0 ? 1 : 0;
  setImmediate(() => process.exit(process.exitCode));
})();
