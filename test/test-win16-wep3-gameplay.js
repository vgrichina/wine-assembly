#!/usr/bin/env node
'use strict';

// First-action coverage for Windows Entertainment Pack 3. A launch window is
// not enough: each case must enter a real game and visibly change its board.

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

let built = false;
function runGame(app, input, maxBatches, extra = []) {
  const args = [
    RUN, `--app=${app}`, '--no-close', '--batch-size=20000',
    `--max-batches=${maxBatches}`, '--quiet-api', '--quiet-blocks',
    '--repaint-every=5', ...extra, `--input=${input}`,
  ];
  if (built) args.splice(2, 0, '--no-build');
  const output = execFileSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  built = true;
  return output;
}

function assertHealthy(output, game) {
  assert.doesNotMatch(output, /\*\*\* CRASH|UNIMPLEMENTED API|RuntimeError|Unreachable code/,
    `${game} must not crash or trap during its first real action`);
}

function testKlotski(outDir) {
  const before = path.join(outDir, 'klotski-before.png');
  const after = path.join(outDir, 'klotski-after.png');
  // Dismiss Welcome, choose Game > Level 1 and the default puzzle, then enter
  // a player name. Move the centre single-square block into the empty cell
  // below it; this crosses both modal returns and USER.433 name validation.
  const output = runGame('wep16_klotski',
      '20:dlg-cmd:1,45:mousedown:48:51,46:mouseup:48:51,' +
      '55:mousedown:70:72,56:mouseup:70:72,90:dlg-cmd:1,' +
      '120:dlg-set-edit:201:Codex,130:dlg-cmd:1,' +
      `170:png:${before},190:mousedown:210:190,191:mousemove:210:208,` +
      `192:mouseup:210:208,230:png:${after},250:stop`, 300);
  assertHealthy(output, 'Klotski');
  assert.match(output, /dlg-set-edit: id=201 text="Codex"/,
    'Klotski should receive the player name before gameplay');
  const changed = changedPixels(before, after, { x: 178, y: 137, w: 80, h: 86 });
  assert(changed > 100,
    `Klotski should visibly move a legal puzzle block (changed=${changed})`);
  console.log('PASS  Win16 Klotski selects a puzzle and accepts a legal block move');
}

function testTetraVex(outDir) {
  const before = path.join(outDir, 'tetravex-before.png');
  const after = path.join(outDir, 'tetravex-after.png');
  const output = runGame('wep16_tetravex',
    `40:png:${before},60:mousedown:343:181,61:mousemove:184:183,` +
    `62:mouseup:184:183,110:png:${after},130:stop`, 150);
  assertHealthy(output, 'TetraVex');
  assert(changedPixels(before, after, { x: 145, y: 135, w: 230, h: 100 }) > 1000,
    'TetraVex should visibly move a numbered tile onto the left board');
  console.log('PASS  Win16 TetraVex accepts a legal tile drag');
}

function testFujiGolf(outDir) {
  const clubhouse = path.join(outDir, 'fuji-clubhouse.png');
  const course = path.join(outDir, 'fuji-course.png');
  const output = runGame('wep16_fujigolf',
    `45:png:${clubhouse},60:mousedown:200:337,61:mouseup:200:337,` +
    `100:dlg-set-edit:100:Codex,110:dlg-cmd:1,220:png:${course},250:stop`, 280);
  assertHealthy(output, 'Fuji Golf');
  assert.match(output, /dlg-set-edit: id=100 text="Codex"/,
    'Fuji Golf should accept a player name for the new round');
  assert(changedPixels(clubhouse, course, { x: 12, y: 55, w: 605, h: 395 }) > 30000,
    'Fuji Golf should leave the clubhouse and render a playable course');
  console.log('PASS  Win16 Fuji Golf starts a round and renders the first tee');
}

function testLifeGenesis(outDir) {
  const before = path.join(outDir, 'life-before.png');
  const after = path.join(outDir, 'life-after.png');
  const output = runGame('wep16_lifegen',
    `40:png:${before},60:mousedown:200:150,61:mouseup:200:150,` +
    `70:mousedown:210:150,71:mouseup:210:150,110:png:${after},130:stop`, 150);
  assertHealthy(output, 'LifeGenesis');
  assert(changedPixels(before, after, { x: 22, y: 65, w: 360, h: 340 }) > 100,
    'LifeGenesis should toggle live cells in its universe');
  console.log('PASS  Win16 LifeGenesis accepts live-cell edits');
}

function testSkiFree(outDir) {
  const before = path.join(outDir, 'ski-before.png');
  const after = path.join(outDir, 'ski-after.png');
  const output = runGame('wep16_ski',
    `40:png:${before},60:keydown:113,61:keyup:113,` +
    `90:keydown:40,91:keyup:40,160:png:${after},180:stop`, 200);
  assertHealthy(output, 'SkiFree');
  assert(changedPixels(before, after, { x: 80, y: 20, w: 480, h: 458 }) > 5000,
    'SkiFree should start a run and render the skier, course, and status');
  console.log('PASS  Win16 SkiFree starts and steers a run');
}

function testTriPeaks(outDir) {
  const before = path.join(outDir, 'tripeaks-before.png');
  const after = path.join(outDir, 'tripeaks-after.png');
  const output = runGame('wep16_tripeaks',
    `30:dlg-cmd:1,60:png:${before},80:keydown:113,81:keyup:113,` +
    `180:png:${after},210:stop`, 230);
  assertHealthy(output, 'TriPeaks');
  assert(changedPixels(before, after, { x: 2, y: 42, w: 636, h: 325 }) > 25000,
    'TriPeaks should deal the full card tableau after New Game');
  console.log('PASS  Win16 TriPeaks deals a playable tableau');
}

function testWordZap(outDir) {
  const ready = path.join(outDir, 'wordzap-ready.png');
  const played = path.join(outDir, 'wordzap-played.png');
  // F2 creates the local computer game. Ready crosses WriteComm, then selecting
  // a rack letter must place it into the first grid cell and draw a new rack.
  const output = runGame('wep16_wordzap',
    `60:keydown:113,61:keyup:113,120:mousedown:250:390,121:mouseup:250:390,` +
    `180:sleep-ms:1500,220:png:${ready},240:mousedown:75:220,241:mouseup:75:220,` +
    `300:png:${played},340:stop`, 370, ['--real-ticks']);
  assertHealthy(output, 'WordZap');
  assert(changedPixels(ready, played, { x: 42, y: 185, w: 594, h: 230 }) > 10000,
    'WordZap should place a selected rack letter and advance the board');
  console.log('PASS  Win16 WordZap starts against the computer and plays a letter');
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win16-wep3-gameplay-'));
try {
  testKlotski(outDir);
  testTetraVex(outDir);
  testFujiGolf(outDir);
  testLifeGenesis(outDir);
  testSkiFree(outDir);
  testTriPeaks(outDir);
  testWordZap(outDir);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
