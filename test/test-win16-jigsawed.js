#!/usr/bin/env node
'use strict';

// Exercise JigSawed's real VB1 File -> Open path and verify the loaded bitmap
// is divided into full-size puzzle pieces. A Win16 SetWindowPos that changes
// only the host HWND geometry leaves VBRUN's cached PictureBox ScaleWidth at
// its 32px design-time value. The app then divides 32 by five and paints 25
// tiny 6x6 fragments instead of using the 541x295 bitmap.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const WEP2 = path.join(ROOT, 'test', 'binaries', 'wep16', 'WEP2');
const EXE = path.join(WEP2, 'JIGSAWED.EXE');
const BITMAP = path.join(WEP2, 'BRICKS.BMP');
const OPTIONAL_WASM = process.env.WINE_ASSEMBLY_WASM || '';

if (!fs.existsSync(EXE) || !fs.existsSync(BITMAP)) {
  console.log('SKIP  JigSawed corpus is not installed');
  process.exit(0);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

assert.strictEqual(sha256(EXE),
  '11ba2c35296c1c01af6f75da58cc98c25f18640310d786f9115f573a2aa36d2e');
assert.strictEqual(sha256(BITMAP),
  'e34fd93f523ecda8ab17b40dc74b735933bfe6df37ff61d7646718f4fbbb1142');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win16-jigsawed-'));
try {
  const screenshot = path.join(outDir, 'jigsawed.png');
  const args = [path.join(ROOT, 'test', 'run.js'), '--app=wep16_jigsawed',
    '--max-batches=800', '--quiet-blocks'];
  if (OPTIONAL_WASM) args.push('--no-build', `--wasm=${OPTIONAL_WASM}`);
  args.push('--input=190:dlg-click:1,215:post-cmd:3216,' +
    '285:click:150:150,315:ctrl-cmd:5', `--png=${screenshot}`);

  const output = execFileSync(process.execPath, args, {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.doesNotMatch(output, /\*\*\* CRASH|UNIMPLEMENTED API|RuntimeError/);
  assert.match(output, /SetWindowText\] "JigSawed: c:\\bricks\.bmp"/,
    'the archived bitmap should load through JigSawed\'s Open dialog');

  const png = PNG.sync.read(fs.readFileSync(screenshot));
  assert.strictEqual(png.width, 640);
  assert.strictEqual(png.height, 480);

  // BRICKS.BMP is dominated by high-saturation orange/yellow/red pixels. The
  // broken 6x6 path paints only 272 vivid pixels; full-size pieces paint more
  // than 37,000. Keep ample headroom for outlines and deterministic shuffling.
  let vivid = 0;
  for (let y = 42; y < 456; y++) {
    for (let x = 4; x < 636; x++) {
      const p = (y * png.width + x) * 4;
      const r = png.data[p];
      const g = png.data[p + 1];
      const b = png.data[p + 2];
      if (Math.max(r, g, b) > 160 &&
          Math.max(r, g, b) - Math.min(r, g, b) > 80) vivid++;
    }
  }
  assert(vivid > 20000,
    `loaded puzzle should contain full-size bitmap pieces (found ${vivid} vivid pixels)`);

  console.log('PASS  Win16 JigSawed loads BRICKS.BMP through its VB1 Open dialog');
  console.log(`PASS  Win16 JigSawed renders full-size puzzle pieces (${vivid} vivid pixels)`);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
