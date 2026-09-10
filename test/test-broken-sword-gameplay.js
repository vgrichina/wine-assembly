#!/usr/bin/env node

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');
const { startControlSession } = require('./control-session');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const PACKAGE = path.join(__dirname, 'binaries', 'win98-games-a-d',
  'Broken_Sword_demo-SW');
const INSTALLER = path.join(PACKAGE, 'SETUP.EXE');
const GAME = path.join(PACKAGE, 'installed', 'winsword.exe');
const INSTALLER_SHA256 = '091ad0e2e8f1f49f6c2cb69067c7c0b7c7d75f3255ab227b6ef17152bb6f40ae';
const GAME_SHA256 = '8ca6e3f0c56e1f289f79e2d52ca8cd98466c5b5c2817b3d05b7f7d80425c4177';
const SHOTS = process.env.BROKEN_SWORD_SCREENSHOT_DIR ||
  path.join(os.tmpdir(), 'wine-assembly-broken-sword-gameplay');

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function imageStats(filename) {
  const png = PNG.sync.read(fs.readFileSync(filename));
  const colors = new Set();
  let nonBlack = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    if (r || g || b) nonBlack++;
    colors.add((r << 16) | (g << 8) | b);
  }
  return { png, colors: colors.size, nonBlack };
}

function changedPixels(a, b) {
  assert.strictEqual(a.width, b.width);
  assert.strictEqual(a.height, b.height);
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2]) changed++;
  }
  return changed;
}

async function stepTotal(session, count, chunk = 5) {
  let remaining = count;
  while (remaining > 0) {
    const n = Math.min(chunk, remaining);
    const reply = await session.send({ action: 'step', n });
    assert.strictEqual(reply.ran, n,
      `requested ${n} frozen steps, ran ${reply.ran}\n${session.output().slice(-10000)}`);
    remaining -= n;
  }
}

async function readGameplayState(session) {
  return session.send({ action: 'eval', code: `(() => {
    const read = address => instance.exports.guest_read32(address) >>> 0;
    const mouse = read(0x004387e4);
    return {
      control: read(0x004288a4),
      cursorResource: read(0x004263d6),
      mouse,
      x: read(mouse) >>> 16,
      y: read(mouse + 4) & 0xffff,
    };
  })()` });
}

async function tapSpace(session) {
  await session.send('keydown:32');
  await session.send('di-keydown:32');
  await stepTotal(session, 1, 1);
  await session.send('keyup:32');
  await session.send('di-keyup:32');
  await stepTotal(session, 4);
}

async function capture(session, name) {
  const filename = path.join(SHOTS, `${name}.png`);
  await session.send({ action: 'png', path: filename });
  return imageStats(filename);
}

async function main() {
  if (!fs.existsSync(GAME)) {
    console.log('SKIP  Broken Sword installer output is absent; run node tools/install-broken-sword-demo.js');
    return;
  }
  assert(fs.existsSync(INSTALLER), 'the original Broken Sword SETUP.EXE is absent');
  assert.strictEqual(sha256(INSTALLER), INSTALLER_SHA256,
    'Broken Sword SETUP.EXE does not match the pinned package');
  assert.strictEqual(sha256(GAME), GAME_SHA256,
    'WINSWORD.EXE does not match the original installer output');
  fs.mkdirSync(SHOTS, { recursive: true });

  const session = startControlSession([
    RUN,
    '--app=broken_sword_demo',
    '--screen=640x480',
    '--batch-size=100000',
    '--tick-ms-per-batch=1000',
    '--max-batches=1000000',
    '--max-seconds=600',
    '--repaint-every=5',
    '--quiet-api',
    '--quiet-blocks',
    '--no-threads',
    '--no-build',
    '--no-close',
    '--control-stdin',
    '--frozen',
  ], { cwd: ROOT, idPrefix: 'bsg-' });

  try {
    let state = await readGameplayState(session);
    for (let attempt = 0; attempt < 160 && !(state.control & 1); attempt++) {
      // The installed demo's readme documents Space as "quit cartoon
      // sequences". Repeating the tap catches each sequence after DirectInput
      // acquisition without relying on host speed or a fixed batch number.
      await tapSpace(session);
      state = await readGameplayState(session);
    }
    assert(state.control & 1,
      `Broken Sword did not hand control to the player: ${JSON.stringify(state)}`);
    assert.strictEqual(state.cursorResource, 0x04010000,
      'playable cafe did not enable the default software cursor');

    await session.send('mousemove:100:100');
    await stepTotal(session, 8);
    const movedA = await readGameplayState(session);
    assert.deepStrictEqual([movedA.x, movedA.y], [100, 100],
      'the playable cafe did not consume the first mouse position');
    const frameA = await capture(session, 'cafe-cursor-top-left');
    assert(frameA.colors > 100 && frameA.nonBlack > 200000,
      `the cafe frame is missing: colors=${frameA.colors}, nonBlack=${frameA.nonBlack}`);

    await session.send('mousemove:500:350');
    await stepTotal(session, 8);
    const movedB = await readGameplayState(session);
    assert.deepStrictEqual([movedB.x, movedB.y], [500, 350],
      'the playable cafe did not consume the second mouse position');
    const frameB = await capture(session, 'cafe-cursor-bottom-right');
    const changed = changedPixels(frameA.png, frameB.png);
    assert(changed > 100,
      `the live cafe did not visibly respond after mouse movement (${changed} changed pixels)`);

    const code = await session.quit();
    assert.strictEqual(code, 0,
      `Broken Sword CLI exited ${code}\n${session.output().slice(-12000)}`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError:|CORRUPT state/i.test(session.output()),
      `Broken Sword hit a compatibility failure\n${session.output().slice(-12000)}`);
    console.log(`PASS  installed Broken Sword demo reached responsive cafe gameplay (${changed} changed pixels)`);
    console.log(`Screenshots: ${SHOTS}`);
  } catch (error) {
    const detail = session.output().slice(-12000);
    await session.quit({ ignoreReplyError: true });
    throw new Error(`${error.message}\n${detail}`);
  }
}

main().catch(error => {
  console.error(`FAIL  Broken Sword gameplay: ${error.stack || error.message}`);
  process.exit(1);
});
