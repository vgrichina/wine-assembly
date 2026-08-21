#!/usr/bin/env node
'use strict';

// Real gameplay coverage for WEP1 titles whose launch-only windows concealed
// failures in their first action. Each case uses renderer input and requires a
// visible board transition, rather than accepting an empty or inert window.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(ROOT, 'test', 'run.js');

function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

function changedPixels(beforePath, afterPath, rect) {
  const before = readPng(beforePath);
  const after = readPng(afterPath);
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

function matchingPixels(png, rect, predicate) {
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * png.width + x) * 4;
      if (predicate(png.data[i], png.data[i + 1], png.data[i + 2])) count++;
    }
  }
  return count;
}

function runGame(app, input, maxBatches) {
  return execFileSync(process.execPath, [
    RUN, `--app=${app}`, '--no-close', '--batch-size=20000',
    `--max-batches=${maxBatches}`, '--quiet-api', '--quiet-blocks',
    '--repaint-every=10', `--input=${input}`,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function assertHealthy(output, game) {
  assert.doesNotMatch(output, /\*\*\* CRASH|UNIMPLEMENTED API|RuntimeError|Unreachable code/,
    `${game} must not crash or trap during its first real action`);
}

function testCruel(outDir) {
  const before = path.join(outDir, 'cruel-before.png');
  const after = path.join(outDir, 'cruel-after.png');
  const output = runGame('wep16_cruel',
    `50:png:${before},70:keydown:113,71:keyup:113,` +
    `130:png:${after},150:stop`, 170);
  assertHealthy(output, 'Cruel');
  assert(changedPixels(before, after, { x: 22, y: 50, w: 365, h: 255 }) > 10000,
    'Cruel should visibly redeal its card tableau on New Game');
  console.log('PASS  Win16 Cruel redeals a playable tableau');
}

function testGolf(outDir) {
  const before = path.join(outDir, 'golf-before.png');
  const after = path.join(outDir, 'golf-after.png');
  const output = runGame('wep16_golf',
    `50:png:${before},70:keydown:113,71:keyup:113,` +
    `130:png:${after},150:stop`, 170);
  assertHealthy(output, 'Golf');
  assert(changedPixels(before, after, { x: 30, y: 50, w: 565, h: 220 }) > 10000,
    'Golf should visibly redeal its card tableau on New Game');
  console.log('PASS  Win16 Golf redeals a playable tableau');
}

function testPegged(outDir) {
  const before = path.join(outDir, 'pegged-before.png');
  const after = path.join(outDir, 'pegged-after.png');
  // Move the centre peg right over its neighbour into the empty hole. Pegged
  // requires a drag; a click alone is deliberately not a legal move.
  const output = runGame('wep16_pegged',
    `50:png:${before},70:mousedown:300:135,71:mouseup:300:135,` +
    `80:mousedown:317:236,81:mousemove:367:236,82:mouseup:367:236,` +
    `105:png:${after},120:stop`, 130);
  assertHealthy(output, 'Pegged');
  assert.match(output, /mousemove 367,236/, 'Pegged drag must reach the renderer');
  assert(changedPixels(before, after, { x: 200, y: 160, w: 240, h: 240 }) > 300,
    'Pegged should visibly move the centre peg into the empty hole');
  console.log('PASS  Win16 Pegged accepts a legal peg drag');
}

function testTaipei(outDir) {
  const board = path.join(outDir, 'taipei-board.png');
  // The first client click dismisses the splash and starts a game. Exercise
  // Game > New too: that path uses GDI.156 CreateDiscardableBitmap to compose
  // the board after loading custom type "LAYOUT" through FindResource.
  const output = runGame('wep16_tp',
    `40:mousedown:320:220,41:mouseup:320:220,` +
    `100:mousedown:60:73,101:mouseup:60:73,` +
    `115:mousedown:60:94,116:mouseup:60:94,` +
    `160:png:${board},180:stop`, 190);
  assertHealthy(output, 'Taipei');
  assert.match(output, /SetWindowText\] "Taipei  Game #\d+"/,
    'Taipei should enter a numbered game');

  const png = readPng(board);
  let nonGreen = 0;
  const colors = new Set();
  for (let y = 84; y < 389; y++) {
    for (let x = 35; x < 604; x++) {
      const i = (y * png.width + x) * 4;
      const rgb = `${png.data[i]},${png.data[i + 1]},${png.data[i + 2]}`;
      colors.add(rgb);
      if (rgb !== '0,128,0') nonGreen++;
    }
  }
  assert(nonGreen > 60000 && colors.size >= 10,
    `Taipei should paint mahjong tiles, not a blank green client (nonGreen=${nonGreen}, colors=${colors.size})`);
  console.log('PASS  Win16 Taipei loads a layout and paints a new game');
}

function testMinesweeper(outDir) {
  const before = path.join(outDir, 'winmine-before.png');
  const after = path.join(outDir, 'winmine-after.png');
  const output = runGame('wep16_winmine',
    `50:png:${before},70:mousedown:101:145,71:mouseup:101:145,` +
    `100:png:${after},110:stop`, 120);
  assertHealthy(output, 'Minesweeper');
  assert(changedPixels(before, after, { x: 78, y: 105, w: 154, h: 170 }) > 100,
    'Minesweeper should visibly reveal its first selected cell');
  console.log('PASS  Win16 Minesweeper reveals its first cell');
}

function testTicTactics(outDir) {
  const before = path.join(outDir, 'tictactics-before.png');
  const after = path.join(outDir, 'tictactics-after.png');
  // Select an empty square on the lowest 4x4 plane. The game places the red
  // move and immediately answers with a blue move on its turn.
  const output = runGame('wep16_tic',
    `50:png:${before},70:mousedown:249:319,71:mouseup:249:319,` +
    `95:png:${after},105:stop`, 110);
  assertHealthy(output, 'TicTactics');
  assert(changedPixels(before, after, { x: 158, y: 74, w: 182, h: 288 }) > 400,
    'TicTactics should place the player and computer pieces on the 3D board');
  console.log('PASS  Win16 TicTactics accepts a board move');
}

function testTetris(outDir) {
  const started = path.join(outDir, 'tetris-started.png');
  const dropped = path.join(outDir, 'tetris-dropped.png');
  // Tetris opens with its animated About DLL. Close it, start a game with F2,
  // then use Down (this version's hard drop) and require both the settled
  // piece and its successor. This crosses the modal-focus, child WM_SIZE,
  // palette-index, timer-id-zero, and keyboard paths that a launch screenshot
  // cannot exercise.
  const output = runGame('wep16_tetris',
    `40:dlg-cmd:1,55:keydown:113,56:keyup:113,` +
    `75:png:${started},90:keydown:40,91:keyup:40,` +
    `105:png:${dropped},115:stop`, 120);
  assertHealthy(output, 'Tetris');
  assert.match(output, /keyboard → focus 0x10001/,
    'Tetris keyboard input must return to the live main window after About');

  const before = readPng(started);
  const after = readPng(dropped);
  const magenta = (r, g, b) => r > 160 && g < 80 && b > 120;
  const green = (r, g, b) => r < 80 && g > 100 && b < 80;
  const teal = (r, g, b) => r === 0 && g === 128 && b === 128;
  assert(matchingPixels(before, { x: 130, y: 50, w: 129, h: 90 }, magenta) > 250,
    'Tetris should paint a colored active piece near the top of the playfield');
  assert(matchingPixels(after, { x: 130, y: 210, w: 129, h: 49 }, magenta) > 100,
    'Tetris Down should settle the active piece at the bottom of the playfield');
  assert(matchingPixels(after, { x: 130, y: 50, w: 129, h: 90 }, green) > 400,
    'Tetris should spawn and paint the next colored piece after a hard drop');
  assert(changedPixels(started, dropped, { x: 130, y: 35, w: 129, h: 224 }) > 600,
    'Tetris playfield should visibly advance after keyboard input');
  assert.strictEqual(
    matchingPixels(after, { x: 143, y: 290, w: 353, h: 140 }, teal), 353 * 140,
    'closing About must restore the exposed desktop below the game window');
  console.log('PASS  Win16 Tetris starts, hard-drops, and spawns the next piece');
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win16-wep1-gameplay-'));
try {
  testCruel(outDir);
  testGolf(outDir);
  testPegged(outDir);
  testTaipei(outDir);
  testMinesweeper(outDir);
  testTicTactics(outDir);
  testTetris(outDir);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
