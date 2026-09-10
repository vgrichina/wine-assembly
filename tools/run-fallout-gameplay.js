#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { startControlSession } = require('../test/control-session');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'fallout-gameplay');

function player(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  assert.strictEqual(png.width, 640);
  assert.strictEqual(png.height, 480);
  let count = 0, sumX = 0;
  // This open ground contains Max Stone's blue suit, not the blue building.
  for (let y = 190; y < 330; y++) {
    for (let x = 270; x < 500; x++) {
      const i = (y * png.width + x) * 4;
      const [r, g, b] = png.data.subarray(i, i + 3);
      if (b > 35 && b > r * 1.4 && b > g * 1.15) {
        count++;
        sumX += x;
      }
    }
  }
  return { count, x: sumX / count };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const session = startControlSession([
    path.join(ROOT, 'test/run.js'), '--app=fallout_demo', '--no-build',
    '--no-threads', '--quiet-api', '--quiet-blocks', '--no-close',
    '--max-seconds=240', '--batch-size=100000', '--tick-ms-per-batch=10',
    '--stuck-after=1000000', '--control-stdin', '--frozen',
    ...(process.argv.includes('--trace-mouse-state') ? ['--trace-mouse-state'] : []),
  ], { cwd: ROOT, idPrefix: 'fallout-' });
  async function step(n) {
    const reply = await session.step(n);
    assert.strictEqual(reply.ran, n, 'guest stopped before the requested boundary');
    assert.strictEqual(reply.frozen, true);
  }
  async function shot(name) {
    const file = path.join(OUT, `${name}.png`);
    await session.send({ action: 'png', path: file });
    return file;
  }
  async function key(vk, after) {
    await session.send(`keydown:${vk}`);
    await step(10);
    await session.send(`keyup:${vk}`);
    await step(after);
  }
  try {
    await step(1500);
    await shot('menu');
    console.log('Fallout: menu captured');
    await key(78, 200); // New Game
    await shot('character');
    console.log('Fallout: character selection captured');
    await key(84, 400); // Take
    await shot('demo-notice');
    await key(13, 1000);
    const before = await shot('before');
    console.log('Fallout: map reached');
    // The initial movement cursor is on the open hex at the screen center.
    await session.send('mousemove:320:240');
    await step(5);
    await session.send('mousedown:320:240');
    await step(10);
    await session.send('mouseup:320:240');
    await step(150);
    const after = await shot('after');
    const a = player(before), b = player(after);
    assert(a.count > 150 && b.count > 150, 'blue player sprite is present in both map frames');
    assert(a.x > 390 && a.x < 435, `initial player position: ${a.x}`);
    assert(b.x < a.x - 50 && b.x > 295, `leftward walk: ${a.x} -> ${b.x}`);
    await step(200);
    await session.send('relmousemove:100:0');
    // DirectInput polling and the software-cursor paint can lag the host
    // event. Admit the click only once the red destination hex has moved.
    let cursorReady = false;
    for (let attempt = 0; attempt < 10 && !cursorReady; attempt++) {
      await step(25);
      const png = PNG.sync.read(fs.readFileSync(await shot('cursor-right')));
      let red = 0;
      for (let y = 220; y < 250; y++) {
        for (let x = 395; x < 435; x++) {
          const i = (y * png.width + x) * 4;
          if (png.data[i] > 120 && png.data[i + 1] < 45 && png.data[i + 2] < 45) red++;
        }
      }
      cursorReady = red > 40;
    }
    assert(cursorReady, 'relative mouse motion moves the red destination hex');
    await session.send('mousedown:420:240');
    await step(10);
    await session.send('mouseup:420:240');
    await step(500);
    const right = player(await shot('right'));
    await key(73, 150);
    const inventory = PNG.sync.read(fs.readFileSync(await shot('inventory')));
    let green = 0;
    for (let y = 40; y < 140; y++) {
      for (let x = 360; x < 535; x++) {
        const i = (y * inventory.width + x) * 4;
        const [r, g, b] = inventory.data.subarray(i, i + 3);
        if (g > 130 && g > r * 1.5 && g > b * 1.5) green++;
      }
    }
    assert(green > 500, `inventory character-stat panel: ${green} green pixels`);
    assert(right.count > 150 && right.x > b.x + 50,
      `walk to a second destination: ${b.x} -> ${right.x}`);
    assert(!/\[max-seconds\]|ABANDONED|UNIMPLEMENTED API|RuntimeError|\*\*\* CRASH/.test(session.output()),
      'guest hit a deadline or runtime failure');
    console.log('PASS Fallout: New Game, Max Stone, two walking destinations and inventory', { before: a, after: b, right });
  } finally {
    const code = await session.quit({ ignoreReplyError: true });
    fs.writeFileSync(path.join(OUT, 'run.log'), session.output());
    assert.strictEqual(code, 0, 'Fallout CLI failed');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
