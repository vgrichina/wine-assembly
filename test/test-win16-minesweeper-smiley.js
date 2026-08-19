#!/usr/bin/env node
// 16-bit Minesweeper: the smiley has to start a new game.
//
//   node test/test-win16-minesweeper-smiley.js
//
// Pressing the face is not a button click. Minesweeper draws the face itself,
// captures the mouse on the way down, and then runs its own peek loop until the
// button comes up — and the question it asks about that button-up is whether
// MSG.pt is still inside the face, a rectangle it has already put into screen
// space with ClientToScreen for exactly this comparison.
//
// The Win16 message narrowing wrote MSG.pt as a zero, which is the top-left
// corner of the screen and inside nothing. So the release was read, the capture
// released, and the board left exactly as it was: the timer kept running and
// every uncovered square stayed uncovered. The reset is what a player reaches
// for after every game, so this is the whole game's front door.
//
// What it checks: the board after two clicks is not the board it started with,
// and the board after the smiley is — pixel for pixel, over the grid only, so
// the running timer is not part of the comparison.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'output', 'win16-minesweeper');
const EXE = path.join(ROOT, 'test', 'binaries', 'win98-16bit', 'WINMINE.EXE');

// The beginner board and the face, in screen coordinates: the window opens at a
// fixed place and Minesweeper sizes itself to its grid, so these are stable.
const GRID = { x0: 84, y0: 122, x1: 228, y1: 262 };
const CELL_A = { x: 100, y: 150 };
const CELL_B = { x: 120, y: 180 };
const SMILEY = { x: 155, y: 103 };

let pass = 0;
function check(name, cond, detail) {
  assert(cond, detail ? `${name} -- ${detail}` : name);
  console.log(`PASS  ${name}`);
  pass++;
}

function run(inputs, batches) {
  return execFileSync('node', [
    path.join(ROOT, 'test', 'run.js'), `--exe=${EXE}`,
    `--max-batches=${batches}`, `--input=${inputs}`,
  ], { encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
}

// How many pixels of the grid differ between two shots. Zero means the same
// board; uncovering a square redraws its border and its digit, which is about a
// hundred pixels apiece.
function gridDiff(a, b) {
  const pa = PNG.sync.read(fs.readFileSync(a));
  const pb = PNG.sync.read(fs.readFileSync(b));
  let n = 0;
  for (let y = GRID.y0; y < GRID.y1; y++) {
    for (let x = GRID.x0; x < GRID.x1; x++) {
      const i = (y * pa.width + x) * 4;
      if (pa.data[i] !== pb.data[i] || pa.data[i + 1] !== pb.data[i + 1] ||
          pa.data[i + 2] !== pb.data[i + 2]) n++;
    }
  }
  return n;
}

function main() {
  if (!fs.existsSync(EXE)) { console.log('SKIP  WINMINE.EXE not found'); return; }
  fs.mkdirSync(OUT, { recursive: true });
  const fresh = path.join(OUT, 'fresh.png');
  const played = path.join(OUT, 'played.png');
  const reset = path.join(OUT, 'reset.png');

  const log = run(
    `1500:png:${fresh},` +
    `2000:mousedown:${CELL_A.x}:${CELL_A.y},2100:mouseup:${CELL_A.x}:${CELL_A.y},` +
    `2600:mousedown:${CELL_B.x}:${CELL_B.y},2700:mouseup:${CELL_B.x}:${CELL_B.y},` +
    `3500:png:${played},` +
    `4500:mousedown:${SMILEY.x}:${SMILEY.y},4600:mouseup:${SMILEY.x}:${SMILEY.y},` +
    `6000:png:${reset}`, 9000);

  check('Minesweeper played a game without crashing',
    !/CRASH|UNIMPLEMENTED API/.test(log));

  const uncovered = gridDiff(fresh, played);
  check(`the clicks uncovered squares (${uncovered} px changed)`, uncovered > 100);

  const after = gridDiff(fresh, reset);
  check(`the smiley covered them again (${after} px still differ)`, after === 0,
    `board after the smiley differs from a fresh one by ${after} px`);

  console.log(`\n${pass} passed, 0 failed`);
  console.log(`Snapshots: ${OUT}`);
}

main();
