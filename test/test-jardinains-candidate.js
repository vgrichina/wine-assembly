#!/usr/bin/env node
'use strict';

// End-to-end gameplay gate for the original Jardinains! 1.2 installer output.
// The proprietary shareware payload is local/gitignored, so this test skips
// when that guest-produced tree has not been prepared.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');
const { startControlSession } = require('./control-session');

const ROOT = path.join(__dirname, '..');
const INSTALLER = path.join(__dirname, 'binaries', 'candidates', 'jardinains',
  'jardinains_1_2.exe');
const INSTALLED = path.join(__dirname, 'binaries', 'candidates', 'jardinains', 'installed');
const EXE = path.join(INSTALLED, 'jardinains.exe');
const MANIFEST = path.join(INSTALLED, '.wine-assembly-browser.json');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function readPng(filename) {
  return PNG.sync.read(fs.readFileSync(filename));
}

function imageStats(png) {
  const colors = new Set();
  let red = 0;
  let blue = 0;
  let orange = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    colors.add((r << 16) | (g << 8) | b);
    if (r > 140 && g < 80 && b < 80) red++;
    if (b > 100 && r < 100 && g < 130) blue++;
    if (r > 150 && g > 70 && g < 180 && b < 80) orange++;
  }
  return { colors: colors.size, red, blue, orange };
}

function pixelDiff(a, b) {
  assert(a.width === b.width && a.height === b.height,
    'cannot compare differently sized Jardinains frames');
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2]) changed++;
  }
  return changed;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  if (!fs.existsSync(INSTALLER) || !fs.existsSync(EXE) || !fs.existsSync(MANIFEST)) {
    console.log('SKIP Jardinains candidate: run the original installer and prepare its ignored installed tree');
    return;
  }

  assert(sha256(INSTALLER) ===
    '78c37d94d9bcf927343b56201ac6cdefed5b3233819c935650ce24260c49268c',
  'Jardinains installer does not match the pinned original package');
  assert(sha256(EXE) ===
    'f1a8ba7040b190da398ced766940b6a853d747cb2dbbd6c46690a41a8368f117',
  'Jardinains executable does not match the installer-produced payload');
  for (const relative of [
    'data/levels/current/level_1.lvl', 'images/bricks.png',
    'images/gamescreen.png', 'images/paddle.png', 'music/song01.mp3',
  ]) {
    assert(fs.existsSync(path.join(INSTALLED, relative)),
      `Jardinains installer output is missing ${relative}`);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  assert(manifest.schemaVersion === 1 && manifest.files.length === 115,
    'Jardinains browser manifest must inventory all 115 installer-produced files');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-jardinains-candidate-'));
  const readyPath = path.join(temp, 'level-ready.png');
  const activePath = process.env.JARDINAINS_SCREENSHOT || path.join(temp, 'level-active.png');
  const session = startControlSession([
    'test/run.js', '--app=jardinains', '--control-stdin', '--frozen',
    '--max-seconds=240', '--max-batches=1000000000', '--batch-size=200000',
    '--tick-ms-per-batch=16', '--quiet-api', '--quiet-blocks', '--no-close',
    '--no-build', '--copy-superops', '--async-mm-timer',
    '--repaint-every=1000000',
  ], { cwd: ROOT, idPrefix: 'j' });
  const { send } = session;

  async function liveClick(x, y) {
    await send({ action: 'frozen', mode: 'off' });
    await send(`mousemove:${x}:${y}`);
    await send(`mousedown:${x}:${y}`);
    await sleep(1500);
    await send(`mouseup:${x}:${y}`);
    await send({ action: 'frozen', mode: 'on' });
  }

  try {
    await send({ action: 'ping' });
    await send({ action: 'step', n: 1800 });

    await liveClick(300, 204);
    await send({ action: 'step', n: 300 });

    await liveClick(306, 207);
    await send({ action: 'step', n: 700 });
    await send({ action: 'png', path: readyPath });

    await liveClick(350, 450);
    await send({ action: 'step', n: 240 });
    await send({ action: 'png', path: activePath });

    const ready = readPng(readyPath);
    const active = readPng(activePath);
    const stats = imageStats(active);
    const changed = pixelDiff(ready, active);
    assert(active.width === 640 && active.height === 480,
      `expected a 640x480 game frame, got ${active.width}x${active.height}`);
    assert(stats.colors > 250 && stats.red > 5000 && stats.blue > 5000 &&
      stats.orange > 3000,
    `expected the multicolored Level 1 brick field, got ${JSON.stringify(stats)}\n` +
      session.output().slice(-12000));
    assert(changed > 100,
      `launching the ball and moving the paddle changed only ${changed} pixels`);
    assert(!/STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED API:/i.test(session.output()),
      `Jardinains emitted a crash marker:\n${session.output().slice(-12000)}`);
    console.log(`PASS Jardinains installer-produced Level 1 is playable (${changed} changed pixels)`);
    console.log(`  screenshot: ${activePath}`);
  } finally {
    await session.quit({ ignoreReplyError: true });
    if (!process.env.KEEP_JARDINAINS_CANDIDATE_TMP && !process.env.JARDINAINS_SCREENSHOT) {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
