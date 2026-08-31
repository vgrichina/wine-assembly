#!/usr/bin/env node
'use strict';

// Full uninstrumented acceptance for the path that exposed a decoded-stream
// resume pointer crossing a Miles WOM_DONE callback boundary.  A menu or intro
// frame is insufficient: reach the adventure map with normal page chaining,
// dismiss its objective dialog, pan the live map, then keep running past the
// former batch-5161 crash.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');
const { diffPng } = require('../tools/png-diff');

const root = path.resolve(__dirname, '..');
const exe = path.join(root,
  'test/binaries/candidates/heroes-3-demo-installer/installed-extracted/Program_Files/h3demo.exe');
if (!fs.existsSync(exe)) {
  console.log('SKIP Heroes III local candidate payload is not present');
  process.exit(0);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'heroes3-demo-gameplay-'));
const menu = path.join(temp, 'menu.png');
const objective = path.join(temp, 'objective.png');
const playable = path.join(temp, 'playable-map.png');
const panned = path.join(temp, 'panned-map.png');
const input = [
  '700:mousedown:400:300', '702:mouseup:400:300',
  '1300:mousedown:400:300', '1302:mouseup:400:300',
  '1900:mousedown:400:300', '1902:mouseup:400:300',
  '2500:mousedown:400:300', '2502:mouseup:400:300',
  `3050:png:${menu}`,
  '3500:mousedown:650:80', '3502:mouseup:650:80',
  `4000:png:${objective}`,
  // The objective's live check button. Once it is gone, leave the pointer at
  // the left map edge long enough for H3's normal adventure-map pan loop.
  '4050:mousedown:400:414', '4052:mouseup:400:414',
  `4100:png:${playable}`,
  '4160:mousemove:5:300',
  `4300:png:${panned}`,
  '4310:mousemove:400:300',
].join(',');

const run = spawnSync(process.execPath, [
  'test/run.js', '--app=heroes3_demo', '--screen=800x600',
  '--max-batches=5166', '--batch-size=200000', '--thread-slices=1',
  '--tick-ms-per-batch=100', '--stuck-after=1000000',
  '--quiet-api', '--quiet-blocks', '--no-close', '--repaint-every=50',
  '--dx-surfaces', `--input=${input}`,
], {
  cwd: root,
  encoding: 'utf8',
  timeout: 300000,
  maxBuffer: 32 * 1024 * 1024,
});
const output = `${run.stdout || ''}\n${run.stderr || ''}`;
assert.strictEqual(run.error, undefined, run.error && run.error.message);
assert.strictEqual(run.status, 0, output.slice(-6000));
assert(output.includes('Stats:') && output.includes('5166 batches'),
  `run did not cross the former batch-5161 crash boundary\n${output.slice(-6000)}`);
assert(!output.includes('*** CRASH'), `Heroes III crashed during map load\n${output.slice(-6000)}`);

const fast = output.match(/desk trips skipped (\d+)/);
assert(fast && Number(fast[1]) > 1000000,
  `acceptance accidentally disabled decoded-page chaining\n${output.slice(-6000)}`);

function census(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  assert.strictEqual(png.width, 800);
  assert.strictEqual(png.height, 600);
  let lit = 0;
  let brownDialog = 0;
  let starField = 0;
  const colors = new Set();
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      if (r || g || b) lit++;
      colors.add(`${r},${g},${b}`);
      if (x >= 240 && x < 560 && y >= 140 && y < 460 && r > g * 1.15 && g > b * 1.15) {
        brownDialog++;
      }
      if (x < 600 && y < 560 && b > r * 1.4 && b > g * 1.15 && b > 18) starField++;
    }
  }
  return { lit, colors: colors.size, brownDialog, starField };
}

const menuStats = census(menu);
const objectiveStats = census(objective);
const playableStats = census(playable);
const pannedStats = census(panned);
assert(objectiveStats.lit > 350000 && objectiveStats.colors > 200,
  `adventure-map capture is blank or lacks detail: ${JSON.stringify(objectiveStats)}`);
assert(objectiveStats.brownDialog > 10000 && objectiveStats.starField > 10000,
  `capture lacks the map's objective dialog/star field: ${JSON.stringify(objectiveStats)}`);
assert(objectiveStats.brownDialog > menuStats.brownDialog * 4,
  `batch 4000 still resembles the sky main menu: menu=${JSON.stringify(menuStats)} map=${JSON.stringify(objectiveStats)}`);
assert(playableStats.lit > 350000 && playableStats.colors > 200,
  `post-objective map is blank or lacks detail: ${JSON.stringify(playableStats)}`);
assert(playableStats.brownDialog < objectiveStats.brownDialog / 4,
  `objective dialog did not close: objective=${JSON.stringify(objectiveStats)} playable=${JSON.stringify(playableStats)}`);

const mapPan = diffPng(playable, panned, { region: { x: 0, y: 0, w: 600, h: 560 } });
const fixedUi = diffPng(playable, panned, { region: { x: 610, y: 0, w: 190, h: 600 } });
assert(mapPan.share > 0.5,
  `left-edge input did not pan the adventure map: ${JSON.stringify(mapPan)}`);
assert(fixedUi.share < 0.02,
  `map pan corrupted the fixed right-side UI: ${JSON.stringify(fixedUi)} panned=${JSON.stringify(pannedStats)}`);

console.log(`PASS Heroes III dismisses the objective, pans the adventure map, and survives the former crash ` +
  `(${fast[1]} fast desk trips, ${(mapPan.share * 100).toFixed(1)}% map change)`);
