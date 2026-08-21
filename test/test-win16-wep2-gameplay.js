#!/usr/bin/env node
'use strict';

// First-action coverage for the WEP2 games not already exercised by the Pipe,
// JigSawed, and Visual Basic gameplay suites.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(ROOT, 'test', 'run.js');

function changedPixels(beforePath, afterPath, rect) {
  const before = PNG.sync.read(fs.readFileSync(beforePath));
  const after = PNG.sync.read(fs.readFileSync(afterPath));
  assert.strictEqual(after.width, before.width);
  assert.strictEqual(after.height, before.height);
  let changed = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * before.width + x) * 4;
      if (before.data[i] !== after.data[i] || before.data[i + 1] !== after.data[i + 1] ||
          before.data[i + 2] !== after.data[i + 2] || before.data[i + 3] !== after.data[i + 3]) {
        changed++;
      }
    }
  }
  return changed;
}

let built = false;
function runGame(app, input, maxBatches) {
  const args = [RUN, `--app=${app}`, '--no-close', '--batch-size=20000',
    `--max-batches=${maxBatches}`, '--quiet-api', '--quiet-blocks',
    '--repaint-every=5', `--input=${input}`];
  if (built) args.splice(2, 0, '--no-build');
  const output = execFileSync(process.execPath, args, {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
  });
  built = true;
  return output;
}

function assertHealthy(output, game) {
  assert.doesNotMatch(output, /\*\*\* CRASH|UNIMPLEMENTED API|RuntimeError|Unreachable code/,
    `${game} must not crash or trap during its first real action`);
}

function testFreeCell(outDir) {
  const before = path.join(outDir, 'freecell-before.png');
  const after = path.join(outDir, 'freecell-after.png');
  const output = runGame('wep16_freecell',
    `40:png:${before},60:keydown:113,61:keyup:113,` +
    `130:png:${after},150:stop`, 170);
  assertHealthy(output, 'FreeCell');
  assert.match(output, /SetWindowText\] "FreeCell Game #\d+"/,
    'FreeCell should enter a numbered game');
  assert(changedPixels(before, after, { x: 22, y: 60, w: 616, h: 330 }) > 50000,
    'FreeCell should deal all eight cascades after New Game');
  console.log('PASS  Win16 FreeCell deals a playable game');
}

function testStones(outDir) {
  const before = path.join(outDir, 'stones-before.png');
  const after = path.join(outDir, 'stones-after.png');
  const output = runGame('wep16_stones',
    `50:png:${before},70:keydown:113,71:keyup:113,` +
    `160:png:${after},180:stop`, 200);
  assertHealthy(output, 'Stones');
  assert(changedPixels(before, after, { x: 155, y: 60, w: 370, h: 330 }) > 5000,
    'Stones should generate a visibly different playing field on New Game');
  console.log('PASS  Win16 Stones generates a playable new field');
}

function testTutsTomb(outDir) {
  const before = path.join(outDir, 'tut-before.png');
  const after = path.join(outDir, 'tut-after.png');
  // The opening pyramid is deterministic and exposes a king at bottom-right.
  const output = runGame('wep16_tutstomb',
    `50:png:${before},70:mousedown:534:360,71:mouseup:534:360,` +
    `160:png:${after},180:stop`, 200);
  assertHealthy(output, "Tut's Tomb");
  assert(changedPixels(before, after, { x: 560, y: 435, w: 65, h: 30 }) > 5,
    "Tut's Tomb should score the exposed-king action");
  console.log("PASS  Win16 Tut's Tomb accepts and scores an exposed-king move");
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win16-wep2-gameplay-'));
try {
  testFreeCell(outDir);
  testStones(outDir);
  testTutsTomb(outDir);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
