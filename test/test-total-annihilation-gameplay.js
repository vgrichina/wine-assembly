#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');
const { startControlSession } = require('./control-session');

const ROOT = path.join(__dirname, '..');
const INSTALLED = path.join(__dirname, 'binaries', 'candidates',
  'total-annihilation-demo', 'installed-fixed', 'cavedog', 'totala', 'demo');
const EXE = path.join(INSTALLED, 'tademo.exe');
const HPI = path.join(INSTALLED, 'tademo.hpi');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readPng(filename) {
  return PNG.sync.read(fs.readFileSync(filename));
}

function countPixels(png, x0, y0, x1, y1, predicate) {
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      if (predicate(png.data[i], png.data[i + 1], png.data[i + 2])) count++;
    }
  }
  return count;
}

function pixelDiff(a, b) {
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2]) changed++;
  }
  return changed;
}

async function main() {
  if (!fs.existsSync(EXE) || !fs.existsSync(HPI)) {
    console.log('SKIP Total Annihilation installer-produced payload is not present');
    return;
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ta-gameplay-'));
  const frameAPath = path.join(temp, 'battlefield-a.png');
  const frameBPath = process.env.TA_SCREENSHOT || path.join(temp, 'battlefield-b.png');
  const session = startControlSession([
    'test/run.js', '--app=total_annihilation_demo', '--screen=640x480',
    '--batch-size=1000', '--control-stdin', '--frozen', '--max-seconds=120',
    '--quiet-api', '--quiet-blocks', '--no-close', '--no-build',
    '--repaint-every=1000000',
  ], { cwd: ROOT, idPrefix: 'ta' });
  const { send } = session;

  try {
    await send({ action: 'ping' });
    await send({ action: 'step', n: 22000 });
    await send('click:185:400'); // Single
    await send({ action: 'step', n: 1000 });
    await send('click:505:145'); // New Campaign
    await send({ action: 'step', n: 1000 });
    await send('click:535:430'); // Arm, Medium, Start
    await send({ action: 'step', n: 5000 });
    await send('click:545:447'); // Mission briefing Start
    await send({ action: 'step', n: 40000 });
    await send(`png:${frameAPath}`);
    await send('mousemove:638:240');
    await send({ action: 'step', n: 1000 });
    await send(`png:${frameBPath}`);

    const a = readPng(frameAPath);
    const b = readPng(frameBPath);
    assert(a.width === 640 && a.height === 480 && b.width === 640 && b.height === 480,
      'Total Annihilation battlefield frames must be 640x480');
    const terrain = countPixels(b, 112, 28, 640, 450,
      (r, g, blue) => g > 28 && g > r * 1.15 && g > blue * 1.2);
    const minimap = countPixels(b, 0, 0, 112, 128,
      (r, g, blue) => g > 35 && g > r * 1.1 && g > blue * 1.1);
    const resourceText = countPixels(b, 112, 0, 640, 28,
      (r, g, blue) => r > 120 && g > 90 && blue < 80);
    const changed = pixelDiff(a, b);
    assert(terrain > 90000, `battlefield terrain is missing (${terrain} green pixels)`);
    assert(minimap > 100, `battlefield minimap is missing (${minimap} green pixels)`);
    assert(resourceText > 100, `resource HUD is missing (${resourceText} yellow pixels)`);
    assert(changed > 100, `battlefield did not respond to pointer input (${changed} changed pixels)`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(session.output()),
      `Total Annihilation hit a compatibility failure\n${session.output().slice(-6000)}`);

    const code = await session.quit();
    assert(code === 0,
      `Total Annihilation CLI exited ${code}\n${session.output().slice(-6000)}`);
    console.log(`PASS Total Annihilation gameplay: terrain=${terrain}, minimap=${minimap}, inputPixels=${changed}`);
    console.log(`PASS Total Annihilation screenshot: ${frameBPath}`);
  } catch (error) {
    await session.quit({ ignoreReplyError: true });
    throw error;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL Total Annihilation gameplay: ${error.stack || error.message}`);
  process.exit(1);
});
