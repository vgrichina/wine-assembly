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
const clickPng  = path.join(TMP, 'notepad_menu_click.png');
const swapPng   = path.join(TMP, 'notepad_menu_swap.png');
for (const p of [beforePng, openPng, hoverPng, closePng, clickPng, swapPng]) {
  try { fs.unlinkSync(p); } catch (_) {}
}

// VK codes
const VK_RETURN = 13;
const VK_ESCAPE = 27;
const VK_DOWN   = 40;
const VK_MENU   = 18; // Alt
const VK_F      = 70;

// Notepad's main window cascades to (20, 20) 600x400 in createWindow.
// Menu bar starts at canvas x≈23, y=42 (h=18). The bar items are
// File / Edit / Search / Help, but the actual widths come from
// $bar_item_width (text-width + 12) and the default font is wide
// enough that File ≈ 23..90, Edit ≈ 90..170, Search ≈ 170..230, Help ≈ 230..280.
// Pick coords solidly inside each item.
const FILE_X = 35, FILE_Y = 50;
const EDIT_X = 140, EDIT_Y = 50;

const inputSpec = [
  `40:png:${beforePng}`,
  `42:keydown:${VK_MENU}`,    // Alt down
  `43:keydown:${VK_F}`,       // F → opens File menu via WAT
  `44:keyup:${VK_F}`,
  `45:keyup:${VK_MENU}`,
  `60:png:${openPng}`,
  `62:keydown:${VK_DOWN}`,    // advance hover
  `63:keydown:${VK_DOWN}`,
  `80:png:${hoverPng}`,
  `82:keydown:${VK_ESCAPE}`,  // close
  `100:png:${closePng}`,
  // Click-based path: hit-test the bar via $menu_hittest_bar
  `102:click:${FILE_X}:${FILE_Y}`,
  `120:png:${clickPng}`,
  // Click-swap: click File then click Edit — previously recursed into
  // repaint() because gdi_draw_text → _getDrawTarget → scheduleRepaint
  // ran synchronously inside an in-flight paint. Guarded by the
  // re-entrancy check in scheduleRepaint/repaint.
  `122:click:${EDIT_X}:${EDIT_Y}`,
  `140:png:${swapPng}`,
  `142:keydown:${VK_ESCAPE}`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --no-close --input='${inputSpec}' --max-batches=160`;
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

(async () => {
  const checks = [];
  const sizeOf = p => (fs.existsSync(p) && fs.statSync(p).size > 1000);
  checks.push({ name: 'before snapshot written', pass: sizeOf(beforePng) });
  checks.push({ name: 'open   snapshot written', pass: sizeOf(openPng) });
  checks.push({ name: 'hover  snapshot written', pass: sizeOf(hoverPng) });
  checks.push({ name: 'close  snapshot written', pass: sizeOf(closePng) });
  checks.push({ name: 'click  snapshot written', pass: sizeOf(clickPng) });
  checks.push({ name: 'swap   snapshot written', pass: sizeOf(swapPng) });
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

      // Click-based path: clicking on "File" should reopen the same
      // dropdown (or one in the same area) — diff vs before should be
      // similar order of magnitude to the keyboard-driven open.
      const dClick  = await diffPngs(beforePng, clickPng);
      console.log(`  click  vs before: ${dClick.diff}px`);
      checks.push({
        name: 'Click on File opened dropdown (>= 1500 px diff vs idle)',
        pass: dClick.diff >= 1500,
      });

      // Click-swap: File dropdown → Edit dropdown. The swap must differ
      // from the plain File-click image because a different bar item is
      // now active AND a different dropdown body is drawn.
      if (sizeOf(swapPng)) {
        const dSwap = await diffPngs(clickPng, swapPng);
        const dSwapIdle = await diffPngs(beforePng, swapPng);
        console.log(`  swap   vs click : ${dSwap.diff}px`);
        console.log(`  swap   vs before: ${dSwapIdle.diff}px`);
        checks.push({
          name: 'Click Edit after click File drew different dropdown (>= 500 px vs File)',
          pass: dSwap.diff >= 500,
        });
        checks.push({
          name: 'Click-swap dropdown visible (>= 1500 px vs idle)',
          pass: dSwapIdle.diff >= 1500,
        });
      }
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
  console.log(`Snapshots: ${beforePng}  ${openPng}  ${hoverPng}  ${closePng}  ${clickPng}  ${swapPng}`);
  process.exit(failed > 0 ? 1 : 0);
})();
