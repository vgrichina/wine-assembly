#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const PAYLOAD = path.join(ROOT,
  'test/binaries/candidates/gta2-demo/installed/Program_Executable_Files');
const EXE = path.join(PAYLOAD, 'gta2.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  GTA2 local demo payload is absent');
  process.exit(0);
}

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.strictEqual(fs.statSync(EXE).size, 2893824, 'the installed game EXE is pinned');
assert.strictEqual(sha256(EXE),
  '97ad743b6ec9ea1be95282053c3127084acd764a7f37a3e57e2268af52d02ae3');
assert.strictEqual(sha256(path.join(PAYLOAD, 'mss32.dll')),
  '0974b244354a5d13e0711db15430c05f7949dc279b63897146f304d1401153fc');
for (const required of [
  'd3ddll.dll', 'data/wildemo.gmp', 'data/wildemo.SCR',
  'data/wil.sty', 'data/frontend/1_Play.tga',
]) {
  assert(fs.existsSync(path.join(PAYLOAD, required)), `installed payload includes ${required}`);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-gta2-gameplay-'));
const pngFile = path.join(temporary, 'wild-demo.png');
const run = spawnSync(process.execPath, [
  'test/run.js', '--app=gta2_demo', '--no-build',
  '--max-batches=4500', '--batch-size=1000',
  '--input=3000:di-keydown:13,3100:di-keyup:13',
  '--quiet-api', '--quiet-blocks', '--dx-slot=7', `--png=${pngFile}`,
], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 120000,
  maxBuffer: 32 * 1024 * 1024,
});
const output = `${run.stdout || ''}\n${run.stderr || ''}`;
assert.strictEqual(run.error, undefined, run.error && run.error.message);
assert.strictEqual(run.status, 0, output.slice(-8000));
for (const marker of [
  'DLL: mss32.dll',
  '[LoadLibrary] dmavideo.dll loaded',
  '[LoadLibrary] d3ddll.dll loaded',
  'DllMain resumed after cooperative Sleep (1)',
  '[input] di-keydown vk=13 at batch 3000',
  'dx slot 7 640x480',
]) {
  assert(output.includes(marker), `missing GTA2 runtime marker: ${marker}\n${output.slice(-8000)}`);
}
assert(!/UNIMPLEMENTED API:|RuntimeError:|\bCRASH\b|CORRUPT state/i.test(output),
  `GTA2 entered a failed compatibility path\n${output.slice(-8000)}`);

const png = PNG.sync.read(fs.readFileSync(pngFile));
assert.deepStrictEqual([png.width, png.height], [640, 480]);
let grass = 0, heartRed = 0, tutorialGold = 0;
const colors = new Set();
for (let y = 0; y < png.height; y++) {
  for (let x = 0; x < png.width; x++) {
    const i = (y * png.width + x) * 4;
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    colors.add((r << 16) | (g << 8) | b);
    if (x > 120 && x < 510 && y > 80 && y < 390 && g > r * 1.18 && g > b * 1.12) grass++;
    if (y < 70 && x > 500 && r > 150 && r > g * 2.2 && r > b * 1.7) heartRed++;
    if (y > 400 && r > 115 && g > 85 && b < 85 && r > b * 1.7) tutorialGold++;
  }
}
assert(colors.size > 1500, `gameplay frame is unexpectedly flat (${colors.size} colors)`);
assert(grass > 18000, `Wild Demo grass playfield is missing (${grass} pixels)`);
assert(heartRed > 250, `gameplay heart HUD is missing (${heartRed} red pixels)`);
assert(tutorialGold > 900, `tutorial dialogue is missing (${tutorialGold} gold pixels)`);

console.log('PASS  installed GTA2 demo loads its authentic DLLs and enters Wild Demo gameplay');
console.log(`PASS  gameplay frame has grass=${grass}, hearts=${heartRed}, tutorial=${tutorialGold}`);
