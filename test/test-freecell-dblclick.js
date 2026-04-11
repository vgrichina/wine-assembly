#!/usr/bin/env node
// FreeCell double-click auto-move regression: verify that double-clicking a
// column's bottom card sends it to a free cell / home cell via the classic
// "auto-move" shortcut (WM_LBUTTONDBLCLK handling).
//
// Setup: pin game #1 via Select Game. Column 1 bottom is the 6 of spades;
// there's no ace of spades on the home pile, so double-clicking it should
// auto-move it to an empty free cell (the next-best landing for an orphan
// card). This is the same end state as the existing click-click move test,
// but reached with a single double-click input action.
//
// PASS criteria:
//   - No crash / no LinkError / no UNIMPLEMENTED API
//   - Canvas changed by >= 500 px vs pre-dblclick snapshot
//   - The moved card occupies the top-left free cell region, producing a
//     block of non-green pixels where there was only green before

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
let createCanvas, loadImage;
try { ({ createCanvas, loadImage } = require('canvas')); } catch (_) {}

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'entertainment-pack', 'freecell.exe');

if (!fs.existsSync(EXE)) { console.log('SKIP  freecell.exe not found'); process.exit(0); }
if (!createCanvas || !loadImage) { console.log('SKIP  node-canvas not available'); process.exit(0); }

const TMP = path.join(ROOT, 'scratch');
fs.mkdirSync(TMP, { recursive: true });
const beforePng = path.join(TMP, 'freecell_dblclk_before.png');
const afterPng  = path.join(TMP, 'freecell_dblclk_after.png');
for (const p of [beforePng, afterPng]) { try { fs.unlinkSync(p); } catch (_) {} }

const inputSpec = [
  '50:0x111:103',                  // Game > Select Game (F3)
  '200:edit-ok:203:1',             // pin game #1
  `450:png:${beforePng}`,          // baseline once the initial deal settles
  '500:dblclick:52:290',           // dblclick col1 bottom (6S) → auto-move
  `700:png:${afterPng}`,           // after snapshot
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --no-close --input='${inputSpec}' --max-batches=900`;
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

for (const l of out.split('\n')) {
  if (l.includes('UNIMPLEMENTED') || l.includes('CRASH') || l.includes('LinkError')) {
    console.log('  ' + l);
  }
}

async function loadPixels(p) {
  const img = await loadImage(p);
  const c = createCanvas(img.width, img.height);
  c.getContext('2d').drawImage(img, 0, 0);
  return { w: img.width, h: img.height,
           data: c.getContext('2d').getImageData(0, 0, img.width, img.height).data };
}
const isGreen = (r, g, b) => r < 20 && g > 100 && b < 20;

(async () => {
  const checks = [];
  const sized = p => fs.existsSync(p) && fs.statSync(p).size > 1000;
  checks.push({ name: 'before snapshot written',    pass: sized(beforePng) });
  checks.push({ name: 'after snapshot written',     pass: sized(afterPng)  });
  checks.push({ name: 'no UNIMPLEMENTED API crash', pass: !/UNIMPLEMENTED API:/.test(out) });
  checks.push({ name: 'no CRASH at batch',          pass: !/\*\*\* CRASH/.test(out) });
  checks.push({ name: 'no LinkError',               pass: !/LinkError/.test(out) });

  if (sized(beforePng) && sized(afterPng)) {
    const a = await loadPixels(beforePng);
    const b = await loadPixels(afterPng);
    let diff = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      if (a.data[i] !== b.data[i] || a.data[i+1] !== b.data[i+1] || a.data[i+2] !== b.data[i+2]) diff++;
    }
    console.log(`  before→after diff: ${diff}px`);
    checks.push({
      name: 'Dblclick changed the canvas (>= 500 px diff)',
      pass: diff >= 500,
    });

    // Count non-green pixels inside the top-left free-cell region where
    // an auto-moved card should appear. The 4 free cells occupy roughly
    // the top-left 240px × 60px block right below the menu. In the before
    // snapshot this region is almost entirely green; in the after snapshot
    // it should contain the 6♠ card face.
    const X0 = 0, Y0 = 70, X1 = 80, Y1 = 130;
    const countCardPixels = (px) => {
      let n = 0;
      for (let y = Y0; y < Y1; y++) {
        for (let x = X0; x < X1; x++) {
          const i = (y * px.w + x) * 4;
          if (!isGreen(px.data[i], px.data[i+1], px.data[i+2])) n++;
        }
      }
      return n;
    };
    const beforeCard = countCardPixels(a);
    const afterCard  = countCardPixels(b);
    console.log(`  free-cell #1 non-green px: before=${beforeCard} after=${afterCard}`);
    checks.push({
      name: 'Free cell #1 now holds a card (gained >= 1500 non-green px)',
      pass: (afterCard - beforeCard) >= 1500,
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
  console.log(`Snapshots: ${beforePng}  ${afterPng}`);
  process.exit(failed > 0 ? 1 : 0);
})();
