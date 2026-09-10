#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');
const { startControlSession } = require('./control-session');

const root = path.join(__dirname, '..');
const game = path.join(__dirname, 'binaries/win98-games-a-d/Curse of Monkey Island demo-SW/COMI.EXE');
const shots = process.env.COMI_SCREENSHOT_DIR || path.join(os.tmpdir(), 'wine-assembly-comi-gameplay');

function shirtPosition(filename) {
  const p = PNG.sync.read(fs.readFileSync(filename));
  assert.strictEqual(p.width, 640);
  assert.strictEqual(p.height, 480);
  let count = 0, sumX = 0;
  // Guybrush's cream shirt has a distinct palette entry. Scene lighting
  // changes its green channel; red/blue remain fixed in this pinned demo.
  for (let y = 100; y < 345; y++) for (let x = 200; x < 520; x++) {
    const i = (y * p.width + x) * 4;
    if (p.data[i] === 193 && p.data[i + 2] === 117 && p.data[i + 1] >= 165) {
      count++;
      sumX += x;
    }
  }
  assert(count > 500, `Guybrush's shirt is absent (${count} pixels)`);
  return sumX / count;
}

function controlPixels(filename, kind) {
  const p = PNG.sync.read(fs.readFileSync(filename));
  let count = 0;
  const bounds = kind === 'inventory' ? [100, 170, 540, 420] : [215, 200, 335, 320];
  for (let y = bounds[1]; y < bounds[3]; y++) for (let x = bounds[0]; x < bounds[2]; x++) {
    const i = (y * p.width + x) * 4;
    const r = p.data[i], g = p.data[i + 1], b = p.data[i + 2];
    if (kind === 'inventory' ? r > 70 && r > g * 1.5 && g > b * 1.3 :
      r > 170 && g > 140 && b < 150) count++;
  }
  return count;
}

(async () => {
  if (!fs.existsSync(game)) {
    console.log('SKIP  local Curse of Monkey Island demo is absent');
    return;
  }
  assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(game)).digest('hex'),
    'b55524231edacc7d184c22c762d25193d616adc55d0141785fb21b8890d352b9');
  fs.mkdirSync(shots, { recursive: true });
  const s = startControlSession(['test/run.js', '--app=curse_monkey_island_demo',
    '--no-build', '--no-threads', '--quiet-api', '--quiet-blocks', '--no-close',
    '--max-seconds=180', '--batch-size=100000', '--tick-ms-per-batch=200',
    '--control-stdin', '--frozen'], { cwd: root });
  try {
    const step = async n => assert.strictEqual((await s.step(n)).ran, n);
    await step(150);
    await s.send('keydown:27');
    await step(2);
    await s.send('keyup:27');
    await step(80);
    const before = path.join(shots, 'hold-before-walk.png');
    await s.send({ action: 'png', path: before });
    const xBefore = shirtPosition(before);
    assert(xBefore > 400, `Guybrush did not reach his initial standing position (${xBefore})`);
    await s.send('click:250:390');
    await step(100);
    const after = path.join(shots, 'hold-after-walk.png');
    await s.send({ action: 'png', path: after });
    const xAfter = shirtPosition(after);
    assert(xBefore - xAfter > 60, `Guybrush did not walk left (${xBefore} -> ${xAfter})`);
    await s.send('rclick:500:350');
    await step(30);
    const inventory = path.join(shots, 'inventory.png');
    await s.send({ action: 'png', path: inventory });
    assert(controlPixels(inventory, 'inventory') > 90000, 'inventory chest did not open');
    await s.send('rclick:500:350');
    await step(20);
    await s.send('mousemove:275:300');
    await step(5);
    await s.send('mousedown:275:300');
    await step(30);
    const coin = path.join(shots, 'verb-coin.png');
    await s.send({ action: 'png', path: coin });
    assert(controlPixels(coin, 'coin') > 2500, 'held left click did not open the verb coin');
    await s.send('mouseup:275:300');
    await step(5);
    assert.strictEqual(await s.quit(), 0);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError:/.test(s.output()), s.output().slice(-8000));
    console.log(`PASS  COMI player click moves Guybrush left (${Math.round(xBefore)} -> ${Math.round(xAfter)})`);
    console.log('PASS  inventory chest and held-click verb coin');
    console.log(`Screenshots: ${shots}`);
  } catch (error) {
    await s.quit({ ignoreReplyError: true });
    throw new Error(`${error.message}\n${s.output().slice(-8000)}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
