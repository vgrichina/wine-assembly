#!/usr/bin/env node
// Winamp 2.91 skin render regression.
//
// Winamp boots, shows the first-run survey dialog, and (once dismissed) loads
// the embedded skin bitmaps via in_mp3's init path. End state: main player at
// 275x116 painted from the sprite sheet, stable in the message loop.
//
// See apps/winamp.md "Current Status: FULLY SKINNED" for the documented run.
//
// PASS criteria:
//   - No UNIMPLEMENTED / unreachable / CRASH in output
//   - Completes the full 200 batches (no early stuck-after exit)
//   - Main window (hwnd=65537) exists at 275x116 with title "Winamp 2.91"
//   - Main back-canvas PNG has >100 unique colors (skin bitmap painted, not
//     a blank gray client-area)
//   - API count in the expected order of magnitude (>5k)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createCanvas, loadImage } = require('canvas');

const ROOT   = path.join(__dirname, '..');
const RUN    = path.join(__dirname, 'run.js');
const EXE    = path.join(__dirname, 'binaries', 'winamp.exe');
const OUTDIR = path.join(__dirname, 'output');
const PNG    = path.join(OUTDIR, 'winamp.png');
const BACK   = path.join(OUTDIR, 'winamp_back_65537.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  winamp.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUTDIR, { recursive: true });
for (const p of [PNG, BACK]) if (fs.existsSync(p)) fs.unlinkSync(p);

// input=10:273:2 dismisses the first-run survey via WM_COMMAND IDCANCEL
const cmd = [
  `node "${RUN}"`,
  `--exe="${EXE}"`,
  '--max-batches=200',
  '--batch-size=5000',
  '--buttons=1,1,1,1,1,1,1,1,1,1',
  '--no-close',
  '--stuck-after=5000',
  '--input=10:273:2',
  `--png="${PNG}"`,
].join(' ');
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 180000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero — output captured)');
}

const apiMatch = out.match(/Stats:\s+(\d+)\s+API calls,\s+(\d+)\s+batches/);
const apiCount = apiMatch ? parseInt(apiMatch[1], 10) : 0;
const batches  = apiMatch ? parseInt(apiMatch[2], 10) : 0;

const mainMatch = out.match(/hwnd=65537\s+pos=\S+\s+size=(\d+)x(\d+)[^\n]*title="([^"]*)"/);
const mainW     = mainMatch ? parseInt(mainMatch[1], 10) : 0;
const mainH     = mainMatch ? parseInt(mainMatch[2], 10) : 0;
const mainTitle = mainMatch ? mainMatch[3] : '';

async function backCanvasColors() {
  if (!fs.existsSync(BACK)) return 0;
  const img = await loadImage(BACK);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, img.width, img.height).data;
  const s = new Set();
  for (let i = 0; i < d.length; i += 4) s.add((d[i] << 16) | (d[i+1] << 8) | d[i+2]);
  return s.size;
}

(async () => {
  const colors = await backCanvasColors();

  const checks = [
    { name: 'no UNIMPLEMENTED API crash',       pass: !/UNIMPLEMENTED API:/.test(out) },
    { name: 'no unreachable trap',              pass: !/RuntimeError:\s*unreachable/.test(out) },
    { name: 'completed 200 batches',            pass: batches === 200 },
    { name: 'API count > 5000',                 pass: apiCount > 5000 },
    { name: 'main hwnd 65537 reported',         pass: !!mainMatch },
    { name: 'main window is 275x116',           pass: mainW === 275 && mainH === 116 },
    { name: 'main title is "Winamp 2.91"',      pass: mainTitle === 'Winamp 2.91' },
    { name: 'main back-canvas PNG exists',      pass: fs.existsSync(BACK) },
    { name: 'main back-canvas has >100 colors', pass: colors > 100 },
  ];

  console.log('');
  console.log(`  apiCount=${apiCount} batches=${batches} mainSize=${mainW}x${mainH} title="${mainTitle}" backColors=${colors}`);
  console.log('');
  let failed = 0;
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  console.log('');
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
})();
