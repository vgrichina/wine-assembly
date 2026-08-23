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
const OPTIONAL_WASM = process.env.WINE_ASSEMBLY_WASM || '';

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

function matchingPixels(file, rect, predicate) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * png.width + x) * 4;
      if (predicate(png.data[i], png.data[i + 1], png.data[i + 2])) count++;
    }
  }
  return count;
}

let built = false;
function runGame(app, input, maxBatches, extra = []) {
  const args = [RUN, `--app=${app}`, '--no-close', '--batch-size=20000',
    `--max-batches=${maxBatches}`, '--quiet-api', '--quiet-blocks',
    '--repaint-every=5', ...extra, `--input=${input}`];
  if (OPTIONAL_WASM) args.splice(2, 0, '--no-build', `--wasm=${OPTIONAL_WASM}`);
  else if (built) args.splice(2, 0, '--no-build');
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
  const capturedCaption = matchingPixels(before, { x: 450, y: 260, w: 190, h: 38 },
    (r, g, b) => b > 80 && b > r * 2 && b > g * 2);
  assert(capturedCaption > 1800,
    `Chess should paint the Captured Pieces child frame (blue=${capturedCaption})`);
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
    `90:dump-windows:gofigure,100:png:${before},120:mousedown:124:126,121:mouseup:124:126,` +
    `140:mousedown:150:148,141:mouseup:150:148,` +
    `260:png:${after},300:stop`, 330);
  assertHealthy(output, 'Go Figure');
  assert.match(output,
    /window:gofigure hwnd=.*class="ThunderForm".*size=451x247 client=\{"x":\d+,"y":\d+,"w":445,"h":202\}.*menuBar=true/,
    'Go Figure dynamic menu creation must recalculate the non-client area without clipping its controls');
  assert.match(output,
    /\[input\] mousedown 150,148[\s\S]*SetWindowText\] " [1-9][0-9]*"/,
    'Go Figure should generate a positive target for a new puzzle');
  const disabledCaptionGray = matchingPixels(before,
    { x: 145, y: 255, w: 290, h: 67 }, (r, g, b) => r === 128 && g === 128 && b === 128);
  assert(disabledCaptionGray > 35,
    `Go Figure should visibly paint its operator, Figure, and Hint captions (gray pixels=${disabledCaptionGray})`);
  const whitePuzzleFields = matchingPixels(after,
    { x: 132, y: 200, w: 310, h: 35 }, (r, g, b) => r > 245 && g > 245 && b > 245);
  assert(whitePuzzleFields > 6000,
    `Go Figure's bordered puzzle fields should use their white VB BackColor ` +
    `(white pixels=${whitePuzzleFields})`);
  assert(changedPixels(before, after, { x: 100, y: 150, w: 445, h: 190 }) > 200,
    'Go Figure should fill in a new arithmetic puzzle');
  console.log('PASS  Win16 Go Figure generates a playable arithmetic puzzle');
}

function testJezzBall(outDir) {
  const before = path.join(outDir, 'jezz-before.png');
  const after = path.join(outDir, 'jezz-after.png');
  // Keep the press live long enough for the game loop to observe it, then
  // capture the red/blue wall builder before either moving ball can destroy it.
  const output = runGame('wep16_jezzball',
    `50:png:${before},70:mousedown:400:150,100:sleep-ms:1000,` +
    `180:png:${after},190:mouseup:400:150,220:sleep-ms:500,245:png:${after},250:stop`,
    260, ['--real-ticks']);
  assertHealthy(output, 'JezzBall');
  assert(changedPixels(before, after, { x: 45, y: 80, w: 455, h: 270 }) > 700,
    'JezzBall should grow a wall while its balls continue moving');
  const builder = { x: 395, y: 135, w: 25, h: 50 };
  assert(matchingPixels(after, builder,
    (r, g, b) => r > 180 && g < 80 && b < 80) > 100 &&
    matchingPixels(after, builder,
      (r, g, b) => r < 80 && g < 80 && b > 150) > 100,
  'JezzBall should render both halves of the live wall builder');
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
  const comboText = [
    { x: 82, y: 50, w: 27, h: 13 },
    { x: 196, y: 50, w: 27, h: 13 },
    { x: 329, y: 50, w: 27, h: 13 },
    { x: 426, y: 50, w: 56, h: 13 },
  ].map(rect => matchingPixels(before, rect, (r, g, b) => r < 64 && g < 64 && b < 64));
  assert(comboText.every(count => count > 2),
    `Tic Tac Drop should visibly populate all toolbar combo boxes (dark pixels=${comboText.join(',')})`);
  assert(changedPixels(before, after, { x: 155, y: 140, w: 30, h: 30 }) > 150,
    'Tic Tac Drop should pick up a red piece from the player bin');
  console.log('PASS  Win16 Tic Tac Drop enters the board and accepts a piece drag');
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win16-wep4-gameplay-'));
try {
  const only = process.argv[2] || '';
  if (!only || only === 'blackjack') testBlackjack(outDir);
  if (!only || only === 'chess') testChess(outDir);
  if (!only || only === 'chips') testChips(outDir);
  if (!only || only === 'gofigure') testGoFigure(outDir);
  if (!only || only === 'jezzball') testJezzBall(outDir);
  if (!only || only === 'maxwell') testMaxwell(outDir);
  if (!only || only === 'tictacdrop') testTicTacDrop(outDir);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
