#!/usr/bin/env node
'use strict';

// End-to-end gameplay gate for the official NetHack 3.4.3 Win32 package.
// The fetched package is gitignored, so this test skips when it is absent.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');
const { startControlSession } = require('./control-session');

const ROOT = path.join(__dirname, '..');
const CANDIDATE = path.join(__dirname, 'binaries', 'candidates', 'nethack-win32');
const INSTALLED = path.join(CANDIDATE, 'installed');
const EXE = path.join(INSTALLED, 'NetHackW.exe');
const DATA = path.join(INSTALLED, 'nhdat');
const MANIFEST = path.join(CANDIDATE, '.wine-assembly-browser.json');

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
  let black = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    colors.add((r << 16) | (g << 8) | b);
    if (r < 8 && g < 8 && b < 8) black++;
  }
  return { width: png.width, height: png.height, colors: colors.size, black };
}

function mapDiff(a, b) {
  assert(a.width === b.width && a.height === b.height,
    'cannot compare differently sized NetHack frames');
  let changed = 0;
  for (let y = 122; y < 272; y++) {
    for (let x = 20; x < 420; x++) {
      const i = (y * a.width + x) * 4;
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
          a.data[i + 2] !== b.data[i + 2]) changed++;
    }
  }
  return changed;
}

async function main() {
  if (!fs.existsSync(EXE) || !fs.existsSync(DATA) || !fs.existsSync(MANIFEST)) {
    console.log('SKIP NetHack candidate: fetch with node tools/fetch-candidate-corpus.js --id=nethack-win32');
    return;
  }

  assert(sha256(EXE) ===
    '0da7a494f0f3c87b20227d4ff77f5e0964609efa3d43b70e11fea87e6adcb951',
  'NetHackW.exe does not match the official 3.4.3 Win32 package');
  assert(sha256(DATA) ===
    'ab99c6962e4e1057390c9916f9e99a1afc887f37e2cc3b17a5b96954217d03b1',
  'nhdat does not match the official 3.4.3 Win32 package');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  assert(manifest.schemaVersion === 1 && manifest.files.length === 12,
    'NetHack browser manifest must inventory the 12 companion files');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-nethack-win32-'));
  const beforePath = path.join(temp, 'before.png');
  const finalPath = process.env.NETHACK_SCREENSHOT || path.join(temp, 'gameplay.png');
  const session = startControlSession([
    'test/run.js', '--app=nethack_win32',
    '--env=NETHACKOPTIONS=name:Codex,!splash_screen',
    '--control-stdin', '--frozen', '--max-seconds=240',
    '--max-batches=1000000000', '--batch-size=25000', '--quiet-api',
    '--quiet-blocks', '--no-close', '--no-build', '--repaint-every=1000000',
  ], { cwd: ROOT, idPrefix: 'n' });
  const { send } = session;

  try {
    await send({ action: 'ping' });
    await send({ action: 'step', n: 40 });
    await send('click:165:292');
    await send({ action: 'step', n: 140 });
    await send('click:220:277');
    await send({ action: 'step', n: 220 });
    await send('click:160:276');
    await send({ action: 'step', n: 220 });
    await send({ action: 'png', path: beforePath });

    const before = readPng(beforePath);
    let final = before;
    let changed = 0;
    for (const vk of [39, 40, 37, 38]) {
      await send(`keydown:${vk}`);
      await send({ action: 'step', n: 80 });
      await send(`keyup:${vk}`);
      await send({ action: 'png', path: finalPath });
      final = readPng(finalPath);
      changed = mapDiff(before, final);
      if (changed > 40) break;
    }

    const stats = frameStats(final);
    assert(stats.width === 640 && stats.height === 480,
      `expected a 640x480 game frame, got ${stats.width}x${stats.height}`);
    assert(stats.colors > 100 && stats.black > 30000,
      `expected a rendered tile dungeon, got ${JSON.stringify(stats)}\n${session.output().slice(-12000)}`);
    assert(changed > 40,
      `cursor movement changed only ${changed} dungeon pixels\n${session.output().slice(-12000)}`);
    assert(!/STUCK|CRASH|RuntimeError|LinkError|Bad directory or name/i.test(session.output()),
      `NetHack emitted a failure marker:\n${session.output().slice(-12000)}`);
    console.log(`PASS NetHack 3.4.3 reaches playable tile gameplay (${changed} changed pixels)`);
    console.log(`  screenshot: ${finalPath}`);
  } finally {
    await session.quit({ ignoreReplyError: true });
    if (!process.env.NETHACK_SCREENSHOT) {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
