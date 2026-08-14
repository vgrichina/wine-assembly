#!/usr/bin/env node
// Space Cadet Pinball Player Controls layout regression.
//
// DLGTEMPLATE cx/cy are client-area dimensions for a top-level dialog. If
// WAT stores them as the whole-window CONTROL_GEOM dimensions, NCCALCSIZE and
// Pinball's centering pass remove the non-client height twice. The dialog then
// ends through the OK / Cancel / Default row instead of below it.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let createCanvas, loadImage;
try { ({ createCanvas, loadImage } = require('../lib/canvas-compat')); } catch (_) {}

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'pinball', 'pinball.exe');
const PNG = path.join(ROOT, 'scratch', 'pinball_player_controls_layout.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  pinball.exe not found at', EXE);
  process.exit(0);
}
if (!createCanvas || !loadImage) {
  console.log('SKIP  canvas backend not available');
  process.exit(0);
}

fs.mkdirSync(path.dirname(PNG), { recursive: true });
try { fs.unlinkSync(PNG); } catch (_) {}

// Larger batches preserve the established Pinball instruction timing while
// avoiding the long idle gaps in the broader combobox lifecycle fixture.
const input = `150:post-cmd:406,190:png:${PNG}`;
const cmd = `node "${RUN}" --exe="${EXE}" --batch-size=400000 ` +
  `--max-batches=200 --quiet-api --input='${input}'`;

let out = '';
try {
  out = execSync(cmd, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 150000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
} catch (e) {
  out = String(e.stdout || '') + String(e.stderr || '');
}

const checks = [
  { name: 'no UNIMPLEMENTED API crash', pass: !/UNIMPLEMENTED API:/.test(out) },
  { name: 'no LinkError', pass: !/LinkError/.test(out) },
  { name: 'no unreachable trap', pass: !/RuntimeError: unreachable/.test(out) },
  { name: 'Player Controls dialog created',
    pass: /\[CreateDialog\] hwnd=0x[0-9a-f]+ parent=0x10002/.test(out) },
  { name: 'layout screenshot written',
    pass: fs.existsSync(PNG) && fs.statSync(PNG).size > 1000 },
];

function pixelAt(data, width, x, y) {
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
}

(async () => {
  if (checks[4].pass) {
    const img = await loadImage(PNG);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;

    // The focused OK button has a stable classic-frame signature at x=220:
    // black top edge, white highlight, black lower edge 22px later, then two
    // pixels of dialog-face padding. The clipped rendering ended before the
    // lower edge and exposed game pixels at both probe locations.
    let okTop = -1;
    for (let y = 280; y < Math.min(img.height - 25, 360); y++) {
      const top = pixelAt(data, img.width, 220, y);
      const highlight = pixelAt(data, img.width, 220, y + 1);
      if (top.every(v => v === 0) && highlight.every(v => v === 255)) {
        okTop = y;
        break;
      }
    }
    const lowerEdge = okTop >= 0 ? pixelAt(data, img.width, 220, okTop + 22) : [];
    const faceBelow = okTop >= 0 ? pixelAt(data, img.width, 220, okTop + 24) : [];
    checks.push({
      name: 'bottom-row buttons have complete lower edge and padding',
      pass: okTop >= 0 && lowerEdge.every(v => v === 0) &&
        faceBelow.every(v => v === 192),
    });
    console.log(`  screenshot: ${img.width}x${img.height}, OK top y=${okTop}`);
  }

  let failed = 0;
  for (const check of checks) {
    console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}`);
    if (!check.pass) failed++;
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  console.log('Snapshot:', PNG);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
