#!/usr/bin/env node
'use strict';

// End-to-end gameplay gate for the RollerCoaster Tycoon demo. The original
// package is local/gitignored, so this test skips when the fixture is absent.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');
const { startControlSession } = require('./control-session');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'binaries', 'shareware', 'rct', 'English', 'RCT.exe');
const SCENARIOS = path.join(ROOT, 'binaries', 'shareware', 'rct', 'Scenarios', 'SC.IDX');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function readPng(filename) {
  return PNG.sync.read(fs.readFileSync(filename));
}

function frameStats(png) {
  const colors = new Set();
  for (let i = 0; i < png.data.length; i += 4) {
    colors.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
  }
  return { width: png.width, height: png.height, colors: colors.size };
}

function pixelDiff(a, b, x0 = 0, y0 = 0, x1 = a.width, y1 = a.height) {
  assert(a.width === b.width && a.height === b.height,
    'cannot compare differently sized RCT frames');
  let changed = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 4;
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
          a.data[i + 2] !== b.data[i + 2]) changed++;
    }
  }
  return changed;
}

async function main() {
  if (!fs.existsSync(EXE) || !fs.existsSync(SCENARIOS)) {
    console.log('SKIP RollerCoaster Tycoon gameplay: local demo fixture is absent');
    return;
  }
  assert(sha256(EXE) ===
    'ebeef3544924254ab78cc02d080f67dff4fe44916fd16d57bbc9df37b7bbb0a7',
  'RCT.exe does not match the pinned demo executable');
  assert(sha256(SCENARIOS) ===
    'cc2445201274727c2c64cb798864f2aae72775882a83a3536232bd20c30f1c02',
  'SC.IDX does not match the pinned demo scenario index');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-rct-gameplay-'));
  const frameAPath = path.join(temp, 'park-a.png');
  const frameBPath = path.join(temp, 'park-b.png');
  const constructionPath = process.env.RCT_SCREENSHOT || path.join(temp, 'construction.png');
  const session = startControlSession([
    'test/run.js', '--app=rct', '--control-stdin', '--frozen',
    '--max-seconds=180', '--max-batches=1000000000', '--batch-size=200000',
    '--quiet-api', '--quiet-blocks', '--no-close', '--no-build',
    '--repaint-every=1000000',
  ], { cwd: ROOT, idPrefix: 'r' });
  const { send } = session;

  try {
    await send({ action: 'ping' });
    await send({ action: 'step', n: 3000 });
    await send('click:198:430');
    await send({ action: 'step', n: 200 });
    await send('click:310:166');
    await send({ action: 'step', n: 1000 });
    await send('click:428:157');
    await send({ action: 'step', n: 40 });
    await send({ action: 'png', path: frameAPath });
    await send({ action: 'step', n: 120 });
    await send({ action: 'png', path: frameBPath });
    await send('click:382:15');
    await send({ action: 'step', n: 60 });
    await send({ action: 'png', path: constructionPath });

    const a = readPng(frameAPath);
    const b = readPng(frameBPath);
    const construction = readPng(constructionPath);
    const stats = frameStats(construction);
    const simulationChanged = pixelDiff(a, b);
    const panelChanged = pixelDiff(b, construction, 0, 32, 120, 446);
    assert(stats.width === 640 && stats.height === 480 && stats.colors > 100,
      `expected a detailed 640x480 park, got ${JSON.stringify(stats)}`);
    assert(simulationChanged > 10000,
      `Forest Frontiers did not visibly advance: ${simulationChanged} changed pixels`);
    assert(panelChanged > 10000,
      `Path Construction did not open: ${panelChanged} changed panel pixels`);
    assert(!/STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED API:/i.test(session.output()),
      `RCT emitted a failure marker:\n${session.output().slice(-12000)}`);
    console.log(`PASS RCT Forest Frontiers gameplay (${simulationChanged} live pixels, ` +
      `${panelChanged} construction-panel pixels)`);
    console.log(`  screenshot: ${constructionPath}`);
  } finally {
    await session.quit({ ignoreReplyError: true });
    if (!process.env.RCT_SCREENSHOT) fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
