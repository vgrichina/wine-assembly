#!/usr/bin/env node
'use strict';

// First-action coverage for every game in Windows Entertainment Pack 4.

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
function runGame(app, input, maxBatches, extra = []) {
  const args = [RUN, `--app=${app}`, '--no-close', '--batch-size=20000',
    `--max-batches=${maxBatches}`, '--quiet-api', '--quiet-blocks',
    '--repaint-every=5', ...extra, `--input=${input}`];
  if (built) args.splice(2, 0, '--no-build');
  const output = execFileSync(process.execPath, args, {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
  });
  built = true;
  return output;
}

function assertHealthy(output, game) {
  assert.doesNotMatch(output, /\*\*\* CRASH|UNIMPLEMENTED API|RuntimeError|Unreachable code/,
    `${game} must not crash or trap during gameplay`);
}

function testBlackjack(outDir) {
  const before = path.join(outDir, 'blackjack-before.png');
  const after = path.join(outDir, 'blackjack-after.png');
  const output = runGame('wep16_blakjak',
    `50:dlg-cmd:1,120:png:${before},140:mousedown:393:455,141:mouseup:393:455,` +
    `260:png:${after},300:stop`, 330);
  assertHealthy(output, 'Blackjack');
  assert(changedPixels(before, after, { x: 55, y: 145, w: 515, h: 295 }) > 15000,
    'Blackjack should deal visible player and dealer cards');
  console.log('PASS  Win16 Blackjack deals a playable hand');
}

function testChess(outDir) {
  const before = path.join(outDir, 'chess-before.png');
  const after = path.join(outDir, 'chess-after.png');
  const output = runGame('wep16_chess',
    `50:png:${before},70:mousedown:187:328,71:mousemove:187:256,` +
    `72:mouseup:187:256,230:png:${after},270:stop`, 300);
  assertHealthy(output, 'Chess');
  assert(changedPixels(before, after, { x: 25, y: 95, w: 555, h: 290 }) > 1000,
    'Chess should accept e2-e4 and render the computer reply');
  console.log('PASS  Win16 Chess accepts e2-e4 and makes a reply');
}

function testChips(outDir) {
  const before = path.join(outDir, 'chips-before.png');
  const after = path.join(outDir, 'chips-after.png');
  const output = runGame('wep16_chips',
    `50:mousedown:200:310,51:mouseup:200:310,100:png:${before},` +
    `120:keydown:39,140:sleep-ms:700,220:png:${after},240:keyup:39,270:stop`,
    300, ['--real-ticks']);
  assertHealthy(output, "Chip's Challenge");
  assert(changedPixels(before, after, { x: 50, y: 70, w: 470, h: 305 }) > 10000,
    "Chip's Challenge should dismiss Lesson 1 and advance under movement input");
  console.log("PASS  Win16 Chip's Challenge starts Lesson 1 and responds to movement");
}

function testGoFigure(outDir) {
  const before = path.join(outDir, 'gofigure-before.png');
  const after = path.join(outDir, 'gofigure-after.png');
  const output = runGame('wep16_gofigure',
    `100:png:${before},120:mousedown:123:145,121:mouseup:123:145,` +
    `140:mousedown:123:165,141:mouseup:123:165,260:png:${after},300:stop`, 330);
  assertHealthy(output, 'Go Figure');
  assert.match(output, /SetWindowText\] " 16"/,
    'Go Figure should generate the deterministic target for a new puzzle');
  assert(changedPixels(before, after, { x: 100, y: 150, w: 445, h: 190 }) > 200,
    'Go Figure should fill in a new arithmetic puzzle');
  console.log('PASS  Win16 Go Figure generates a playable arithmetic puzzle');
}

function testJezzBall(outDir) {
  const before = path.join(outDir, 'jezz-before.png');
  const after = path.join(outDir, 'jezz-after.png');
  const output = runGame('wep16_jezzball',
    `50:png:${before},70:mousedown:300:200,71:mouseup:300:200,` +
    `100:sleep-ms:1000,180:png:${after},210:stop`, 240, ['--real-ticks']);
  assertHealthy(output, 'JezzBall');
  assert(changedPixels(before, after, { x: 45, y: 80, w: 455, h: 270 }) > 700,
    'JezzBall should grow a wall while its balls continue moving');
  console.log('PASS  Win16 JezzBall grows a wall in the live arena');
}

function testMaxwell(outDir) {
  const before = path.join(outDir, 'maxwell-before.png');
  const after = path.join(outDir, 'maxwell-after.png');
  const output = runGame('wep16_maxwell',
    `50:png:${before},80:sleep-ms:1000,180:png:${after},210:stop`,
    240, ['--real-ticks']);
  assertHealthy(output, "Maxwell's Maniac");
  assert(changedPixels(before, after, { x: 45, y: 45, w: 450, h: 315 }) > 250,
    "Maxwell's Maniac should keep its live balls moving through the chamber");
  console.log("PASS  Win16 Maxwell's Maniac runs its live chamber simulation");
}

function testTicTacDrop(outDir) {
  const before = path.join(outDir, 'tictacdrop-before.png');
  const after = path.join(outDir, 'tictacdrop-after.png');
  // The first click closes the VB splash through USER.53 DestroyWindow. Drag a
  // red piece from its bin toward the first board column; this used to crash
  // before the playable form appeared because a far WndProc was used as EIP.
  const output = runGame('wep16_tictacdp',
    `50:mousedown:320:240,51:mouseup:320:240,110:png:${before},` +
    `130:mousedown:168:151,131:mousemove:180:148,132:mousemove:195:145,` +
    `133:mousemove:209:145,134:mouseup:209:145,280:png:${after},320:stop`, 360);
  assertHealthy(output, 'Tic Tac Drop');
  assert.match(output, /SetWindowText\] "< Player 1's turn"/,
    'Tic Tac Drop should promote its playable one-player form');
  assert(changedPixels(before, after, { x: 155, y: 140, w: 30, h: 30 }) > 150,
    'Tic Tac Drop should pick up a red piece from the player bin');
  console.log('PASS  Win16 Tic Tac Drop enters the board and accepts a piece drag');
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win16-wep4-gameplay-'));
try {
  testBlackjack(outDir);
  testChess(outDir);
  testChips(outDir);
  testGoFigure(outDir);
  testJezzBall(outDir);
  testMaxwell(outDir);
  testTicTacDrop(outDir);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
