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
const OPTIONAL_WASM = process.env.WINE_ASSEMBLY_WASM || '';

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
  const args = [
    RUN, `--app=${app}`, '--no-close', '--batch-size=20000',
    `--max-batches=${maxBatches}`, '--quiet-api', '--quiet-blocks',
    '--repaint-every=10', `--input=${input}`,
  ];
  if (OPTIONAL_WASM) args.splice(2, 0, '--no-build', `--wasm=${OPTIONAL_WASM}`);
  return execFileSync(process.execPath, args, {
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
  const opening = path.join(outDir, 'tetris-opening.png');
  const started = path.join(outDir, 'tetris-started.png');
  const dropped = path.join(outDir, 'tetris-dropped.png');
  // Tetris opens with its animated About DLL. Close it, start a game with F2,
  // then use Down (this version's hard drop) and require both the settled
  // piece and its successor. This crosses the modal-focus, child WM_SIZE,
  // palette-index, timer-id-zero, and keyboard paths that a launch screenshot
  // cannot exercise.
  const output = runGame('wep16_tetris',
    `25:png:${opening},40:dlg-cmd:1,55:keydown:113,56:keyup:113,` +
    `75:png:${started},90:keydown:40,91:keyup:40,` +
    `105:png:${dropped},115:stop`, 120);
  assertHealthy(output, 'Tetris');
  assert.match(output, /keyboard → focus 0x10001/,
    'Tetris keyboard input must return to the live main window after About');

  const before = readPng(started);
  const after = readPng(dropped);
  const startup = readPng(opening);
  const magenta = (r, g, b) => r > 160 && g < 80 && b > 120;
  const green = (r, g, b) => r < 80 && g > 100 && b < 80;
  assert(matchingPixels(startup, { x: 0, y: 38, w: 640, h: 415 }, magenta) > 30000,
    'Tetris must be maximized and tile the exposed client behind its About dialog');
  assert(matchingPixels(before, { x: 130, y: 50, w: 129, h: 90 }, magenta) > 250,
    'Tetris should paint a colored active piece near the top of the playfield');
  assert(matchingPixels(after, { x: 130, y: 210, w: 129, h: 49 }, magenta) > 100,
    'Tetris Down should settle the active piece at the bottom of the playfield');
  assert(matchingPixels(after, { x: 130, y: 50, w: 129, h: 90 }, green) > 400,
    'Tetris should spawn and paint the next colored piece after a hard drop');
  assert(changedPixels(started, dropped, { x: 130, y: 35, w: 129, h: 224 }) > 600,
    'Tetris playfield should visibly advance after keyboard input');
  assert(matchingPixels(after, { x: 270, y: 50, w: 360, h: 390 }, magenta) > 50000,
    'closing About must leave the maximized tiled game client visible around the playfield');
  console.log('PASS  Win16 Tetris starts, hard-drops, and spawns the next piece');
}

function testIdleWild(outDir) {
  const first = path.join(outDir, 'idlewild-first.png');
  const second = path.join(outDir, 'idlewild-second.png');
  // Select the first real module, then allow it to animate. Blackness draws
  // into the black parent client around the two child controls on Win98; the
  // IWINFO child itself keeps its registered white class background.
  const output = runGame('wep16_idlewild',
    `45:mousedown:200:203,46:mouseup:200:203,70:png:${first},` +
    `80:sleep-ms:1000,145:png:${second},165:stop`, 180);
  assertHealthy(output, 'IdleWild');
  const png = readPng(second);
  const white = (r, g, b) => r > 225 && g > 225 && b > 225;
  const saturated = (r, g, b) => Math.max(r, g, b) > 170 &&
    Math.max(r, g, b) - Math.min(r, g, b) > 110;
  assert(matchingPixels(png, { x: 155, y: 197, w: 135, h: 15 }, white) > 20,
    'IdleWild must show the selected Blackness module name in its list');
  assert(matchingPixels(png, { x: 328, y: 194, w: 160, h: 130 }, white) > 18000,
    'IdleWild module information child must erase to its native white class background');
  assert(matchingPixels(png, { x: 136, y: 178, w: 368, h: 162 }, saturated) > 100,
    'IdleWild should render the selected module around its child controls');
  assert(changedPixels(first, second, { x: 136, y: 178, w: 368, h: 162 }) > 500,
    'IdleWild should keep running the selected module after the click');
  console.log('PASS  Win16 IdleWild selects Blackness and runs its animation');
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win16-wep1-gameplay-'));
try {
  const only = process.argv[2] || '';
  if (!only || only === 'cruel') testCruel(outDir);
  if (!only || only === 'golf') testGolf(outDir);
  if (!only || only === 'pegged') testPegged(outDir);
  if (!only || only === 'taipei') testTaipei(outDir);
  if (!only || only === 'winmine') testMinesweeper(outDir);
  if (!only || only === 'tic') testTicTactics(outDir);
  if (!only || only === 'tetris') testTetris(outDir);
  if (!only || only === 'idlewild') testIdleWild(outDir);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
