#!/usr/bin/env node
'use strict';

// Gameplay coverage for the two VB1 Entertainment Pack games. Both cases use
// real menu and renderer input paths and require a visible board transition;
// a launch-only window check would miss the IsChild trap and Rodent overflow.

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

function runGame(args) {
  return execFileSync(process.execPath, [RUN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function assertHealthy(output, game) {
  assert.doesNotMatch(output, /\*\*\* CRASH|UNIMPLEMENTED API|RuntimeError|Overflow/,
    `${game} must not crash, trap, or show VB Overflow`);
}

function testRodent(outDir) {
  const before = path.join(outDir, 'rodent-before.png');
  const after = path.join(outDir, 'rodent-after.png');
  // Wall-clock ticks keep the score at its real-play pace. Holding Right over
  // a timer tick moves the mouse instead of merely delivering a key message.
  const output = runGame([
    '--app=wep16_rodent', '--no-close', '--real-ticks', '--batch-size=2000',
    '--max-batches=1400', '--quiet-api', '--quiet-blocks', '--repaint-every=20',
    `--input=200:mousedown:300:55,201:mouseup:300:55,` +
      `500:mousedown:202:72,501:mouseup:202:72,` +
      `520:mousedown:240:93,521:mouseup:240:93,` +
      `1050:png:${before},1100:keydown:39,1101:sleep-ms:1200,` +
      `1200:keyup:39,1250:png:${after},1350:stop`,
  ]);
  assertHealthy(output, 'Rodent');
  assert.match(output, /keydown vk=39/, 'Rodent Right key must reach the renderer');
  assert(changedPixels(before, after, { x: 180, y: 116, w: 276, h: 276 }) > 40,
    'Rodent board should visibly advance after holding Right');
  console.log('PASS  Win16 Rodent starts a new game and responds to Right');
}

function testRattler(outDir) {
  const before = path.join(outDir, 'rattler-before.png');
  const after = path.join(outDir, 'rattler-after.png');
  const output = runGame([
    '--app=wep16_rattler', '--no-close', '--batch-size=2000', '--max-batches=1100',
    '--quiet-api', '--quiet-blocks', '--repaint-every=20',
    `--input=200:mousedown:300:55,201:mouseup:300:55,` +
      `500:mousedown:210:72,501:mouseup:210:72,` +
      `520:mousedown:230:94,521:mouseup:230:94,` +
      `750:png:${before},800:keypress:54,1000:png:${after},1050:stop`,
  ]);
  assertHealthy(output, 'Rattler');
  // Rattler implements pix_KeyPress (ASCII keypad controls), not KeyDown.
  // ASCII '6' turns clockwise; F3 is Pause and would stop the live timer.
  assert.match(output, /keypress code=54/, 'Rattler keypad 6 must reach pix_KeyPress');
  assert(changedPixels(before, after, { x: 188, y: 129, w: 256, h: 260 }) > 100,
    'Rattler board should visibly advance after its keypad-6 turn control');
  console.log('PASS  Win16 Rattler starts a new game and responds to keypad 6');
}

const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
assert.match(index, /<option value="wep16_rodent">Rodent's Revenge<\/option>/,
  'Rodent must be selectable beside the other original WEP2 games');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win16-vb-gameplay-'));
try {
  testRodent(outDir);
  testRattler(outDir);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
