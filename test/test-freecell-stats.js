#!/usr/bin/env node
// FreeCell Statistics dialog regression: verify Options > Statistics (ID 105,
// aka F4) opens the "FreeCell Statistics" dialog and renders its body without
// crashing. The dialog has title "FreeCell Statistics" plus static labels
// This session / Total / Streaks, OK + Clear buttons.
//
// PASS criteria:
//   - FreeCell launches
//   - After WM_COMMAND(105), canvas changes vs baseline (dialog appeared)
//   - The "after" canvas gains a meaningful chunk of gray pixels (dialog face)
//   - No UNIMPLEMENTED API crash, no LinkError, no *** CRASH

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

if (!fs.existsSync(EXE)) { console.log('SKIP  freecell.exe not found'); process.exit(0); }
if (!createCanvas || !loadImage) { console.log('SKIP  node-canvas not available'); process.exit(0); }

const TMP = path.join(ROOT, 'scratch');
fs.mkdirSync(TMP, { recursive: true });
const beforePng = path.join(TMP, 'freecell_stats_before.png');
const afterPng  = path.join(TMP, 'freecell_stats_after.png');
for (const p of [beforePng, afterPng]) { try { fs.unlinkSync(p); } catch (_) {} }

// Let the initial deal settle, snapshot, then send WM_COMMAND 105
// (Options > Statistics), pump more batches, snapshot again.
const inputSpec = [
  `100:png:${beforePng}`,
  '120:0x111:105',
  `300:png:${afterPng}`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --no-close --input='${inputSpec}' --max-batches=500`;
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

(async () => {
  const checks = [];
  const sized = p => fs.existsSync(p) && fs.statSync(p).size > 1000;
  checks.push({ name: 'before snapshot written', pass: sized(beforePng) });
  checks.push({ name: 'after snapshot written',  pass: sized(afterPng)  });
  checks.push({ name: 'no UNIMPLEMENTED API crash', pass: !/UNIMPLEMENTED API:/.test(out) });
  checks.push({ name: 'no CRASH at batch',          pass: !/\*\*\* CRASH/.test(out) });
  checks.push({ name: 'no LinkError',               pass: !/LinkError/.test(out) });

  if (sized(beforePng) && sized(afterPng)) {
    const a = await loadPixels(beforePng);
    const b = await loadPixels(afterPng);
    // Count pixels that changed between the two snapshots.
    let diff = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      if (a.data[i] !== b.data[i] || a.data[i+1] !== b.data[i+1] || a.data[i+2] !== b.data[i+2]) diff++;
    }
    console.log(`  before→after diff: ${diff}px`);
    checks.push({
      name: 'Statistics dialog changed the canvas (>= 5000 px diff)',
      pass: diff >= 5000,
    });

    // Count the number of Win95 3D-face gray pixels (0xC0C0C0) in the "after"
    // snapshot. A dialog body + buttons should produce thousands of them;
    // cards + green table alone do not.
    let gray = 0;
    for (let i = 0; i < b.data.length; i += 4) {
      if (b.data[i] === 0xC0 && b.data[i+1] === 0xC0 && b.data[i+2] === 0xC0) gray++;
    }
    console.log(`  C0C0C0 pixels in after: ${gray}`);
    checks.push({
      name: 'After snapshot contains a dialog face (>= 5000 gray px)',
      pass: gray >= 5000,
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
