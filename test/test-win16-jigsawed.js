#!/usr/bin/env node
'use strict';

// Exercise JigSawed's real VB1 File -> Open path, then drag an isolated puzzle
// piece and verify its picture pixels move to the release point. This covers
// both the VB/GDI setup path and actual gameplay; a rendered but inert board,
// a drag outline, or a white replacement rectangle cannot pass.

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
  const beforeScreenshot = path.join(outDir, 'jigsawed-before.png');
  const afterScreenshot = path.join(outDir, 'jigsawed-after.png');
  const args = [path.join(ROOT, 'test', 'run.js'), '--app=wep16_jigsawed',
    '--max-batches=1500', '--quiet-blocks'];
  if (OPTIONAL_WASM) args.push('--no-build', `--wasm=${OPTIONAL_WASM}`);
  args.push('--input=190:dlg-click:1,215:post-cmd:3216,' +
    '285:click:150:150,315:ctrl-cmd:5,' +
    `800:png:${beforeScreenshot},` +
    '900:mousedown:280:328,1000:mousemove:320:328,' +
    '1100:mousemove:370:328,1200:mousemove:420:328,' +
    `1300:mouseup:420:328,1450:png:${afterScreenshot}`);

  const output = execFileSync(process.execPath, args, {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.doesNotMatch(output,
    /\*\*\* CRASH|UNIMPLEMENTED API|RuntimeError|\[MessageBox\]/);
  assert.match(output, /SetWindowText\] "JigSawed: c:\\bricks\.bmp"/,
    'the archived bitmap should load through JigSawed\'s Open dialog');
  assert.match(output, /\[input\] mousedown 280,328 at batch 900/);
  assert.match(output, /\[input\] mouseup 420,328 at batch 1300/);

  const before = PNG.sync.read(fs.readFileSync(beforeScreenshot));
  const after = PNG.sync.read(fs.readFileSync(afterScreenshot));
  assert.strictEqual(before.width, 640);
  assert.strictEqual(before.height, 480);
  assert.strictEqual(after.width, 640);
  assert.strictEqual(after.height, 480);

  // BRICKS.BMP is dominated by high-saturation orange/yellow/red pixels. The
  // broken 6x6 path paints only 272 vivid pixels; full-size pieces paint more
  // than 37,000. Keep ample headroom for outlines and deterministic shuffling.
  function countVivid(png, left, top, right, bottom) {
    let vivid = 0;
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const p = (y * png.width + x) * 4;
        const r = png.data[p];
        const g = png.data[p + 1];
        const b = png.data[p + 2];
        if (Math.max(r, g, b) > 160 &&
            Math.max(r, g, b) - Math.min(r, g, b) > 80) vivid++;
      }
    }
    return vivid;
  }

  const vivid = countVivid(before, 4, 42, 636, 456);
  assert(vivid > 20000,
    `loaded puzzle should contain full-size bitmap pieces (found ${vivid} vivid pixels)`);

  // The deterministic shuffle leaves one complete 108x59 piece at
  // [229,298]-[337,357). Dragging its centre by +140px moves that exact bitmap
  // rectangle to [369,298]-[477,357). Compare every RGBA pixel, then require the
  // saturated brick colors to leave the source and arrive at the destination.
  const source = { left: 229, top: 298, right: 337, bottom: 357 };
  const deltaX = 140;
  let matchingMovedPixels = 0;
  for (let y = source.top; y < source.bottom; y++) {
    for (let x = source.left; x < source.right; x++) {
      const beforePixel = (y * before.width + x) * 4;
      const afterPixel = (y * after.width + x + deltaX) * 4;
      let equal = true;
      for (let channel = 0; channel < 4; channel++) {
        if (before.data[beforePixel + channel] !== after.data[afterPixel + channel]) {
          equal = false;
          break;
        }
      }
      if (equal) matchingMovedPixels++;
    }
  }
  const piecePixels = (source.right - source.left) * (source.bottom - source.top);
  assert.strictEqual(matchingMovedPixels, piecePixels,
    'the complete selected picture fragment should appear at the release point');

  const sourceBefore = countVivid(before,
    source.left, source.top, source.right, source.bottom);
  const sourceAfter = countVivid(after,
    source.left, source.top, source.right, source.bottom);
  const destinationBefore = countVivid(before,
    source.left + deltaX, source.top, source.right + deltaX, source.bottom);
  const destinationAfter = countVivid(after,
    source.left + deltaX, source.top, source.right + deltaX, source.bottom);
  assert(sourceBefore > 1200 && sourceAfter < 100,
    `drag should clear the old piece location (${sourceBefore} -> ${sourceAfter} vivid pixels)`);
  assert(destinationBefore < 100 && destinationAfter === sourceBefore,
    `drag should preserve the piece at its new location (${destinationBefore} -> ${destinationAfter} vivid pixels)`);

  console.log('PASS  Win16 JigSawed loads BRICKS.BMP through its VB1 Open dialog');
  console.log(`PASS  Win16 JigSawed renders full-size puzzle pieces (${vivid} vivid pixels)`);
  console.log(`PASS  Win16 JigSawed drags a complete picture piece (${matchingMovedPixels} pixels)`);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
