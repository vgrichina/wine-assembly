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
  'DarkstoneDemo-D3D');
const INSTALLER = path.join(PACKAGE, 'Setup.exe');
const GAME = path.join(PACKAGE, 'installed', 'darkstonedemo.exe');
const INSTALLER_SHA256 = 'a6d2f8b9173fd43f03aabff0b8cc3fadbd0b15224bcbe5f562a32158a297b502';
const GAME_SHA256 = 'b43db5e1b835eb1e93688a1f3f1d9c814517be6fc8110c7fb6e024d467ee721b';
const SHOTS = process.env.DARKSTONE_SCREENSHOT_DIR ||
  path.join(os.tmpdir(), 'wine-assembly-darkstone-gameplay');

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function imageStats(filename) {
  const png = PNG.sync.read(fs.readFileSync(filename));
  const colors = new Set();
  let nonBlack = 0;
  let parchment = 0;
  let hudBlue = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    if (r || g || b) nonBlack++;
    if (r > 100 && g > 50 && r > g * 1.08 && g > b * 1.15) parchment++;
    if (i / 4 >= png.width * Math.floor(png.height * 0.75) &&
        b > 80 && b > r * 1.25 && b > g * 1.1) hudBlue++;
    colors.add((r << 16) | (g << 8) | b);
  }
  return {
    png, width: png.width, height: png.height,
    colors: colors.size, nonBlack, parchment, hudBlue,
  };
}

function pixelDiff(a, b) {
  assert(a.width === b.width && a.height === b.height,
    'Darkstone gameplay frames have different dimensions');
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) changed++;
  }
  return changed;
}

function regionDiff(a, b, x, y, width, height) {
  assert(a.width === b.width && a.height === b.height,
    'Darkstone gameplay frames have different dimensions');
  let changed = 0;
  for (let py = y; py < y + height; py++) {
    for (let px = x; px < x + width; px++) {
      const i = (py * a.width + px) * 4;
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
          a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) changed++;
    }
  }
  return changed;
}

async function stepTotal(session, count, chunk = 2) {
  let remaining = count;
  while (remaining > 0) {
    const n = Math.min(chunk, remaining);
    const reply = await session.send({ action: 'step', n });
    assert.strictEqual(reply.ran, n,
      `requested ${n} frozen steps, ran ${reply.ran}\n${session.output().slice(-10000)}`);
    remaining -= n;
  }
}

async function capture(session, name) {
  const filename = path.join(SHOTS, `${name}.png`);
  await session.send({ action: 'png', path: filename });
  return imageStats(filename);
}

async function click(session, x, y, settle = 10) {
  // Darkstone polls DirectInput position separately from its button state.
  await session.send(`mousemove:${x}:${y}`);
  await stepTotal(session, 2);
  await session.send(`mousedown:${x}:${y}`);
  await stepTotal(session, 2);
  await session.send(`mouseup:${x}:${y}`);
  await stepTotal(session, settle);
}

async function tap(session, x, y, settle = 14) {
  await session.send(`mousemove:${x}:${y}`);
  await stepTotal(session, 2);
  await session.send(`click:${x}:${y}`);
  await stepTotal(session, settle);
}

async function keypressText(session, text) {
  for (const ch of text.toUpperCase()) {
    const vk = ch.charCodeAt(0);
    await session.send(`keydown:${vk}`);
    await session.send(`di-keydown:${vk}`);
    await stepTotal(session, 1, 1);
    await session.send(`keyup:${vk}`);
    await session.send(`di-keyup:${vk}`);
    await stepTotal(session, 1, 1);
  }
  await stepTotal(session, 2);
}

async function waitForWindow(session) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const snapshot = await session.send({ action: 'snapshot' });
    if (snapshot.windows.some(win => win.visible && /DarkStone Demo DSI/i.test(win.title || ''))) {
      return snapshot;
    }
    await stepTotal(session, 2);
  }
  throw new Error(`Darkstone did not create its main window\n${session.output().slice(-12000)}`);
}

async function waitForMainMenu(session) {
  let escapeSent = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const frame = await capture(session, '01-main-menu');
    if (frame.parchment > 200000) return frame;
    if (!escapeSent && frame.nonBlack > 100000) {
      await session.send('keydown:27');
      await session.send('di-keydown:27');
      await stepTotal(session, 2);
      await session.send('keyup:27');
      await session.send('di-keyup:27');
      escapeSent = true;
    }
    await stepTotal(session, 4);
  }
  throw new Error(`Darkstone main menu did not render\n${session.output().slice(-12000)}`);
}

async function waitForTown(session) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const frame = await capture(session, '08-town-before-input');
    if (frame.colors > 100 && frame.nonBlack > 300000 && frame.hudBlue > 500) {
      return frame;
    }
    await stepTotal(session, 4);
  }
  throw new Error(`Darkstone did not reach the 3D town\n${session.output().slice(-12000)}`);
}

async function main() {
  if (!fs.existsSync(GAME)) {
    console.log('SKIP  Darkstone installer output is absent; run node tools/install-darkstone-demo.js');
    return;
  }
  assert(fs.existsSync(INSTALLER), 'the original Darkstone Setup.exe is absent');
  assert.strictEqual(sha256(INSTALLER), INSTALLER_SHA256,
    'Darkstone Setup.exe does not match the pinned package');
  assert.strictEqual(sha256(GAME), GAME_SHA256,
    'DarkstoneDemo.exe does not match the original installer output');
  fs.mkdirSync(SHOTS, { recursive: true });

  const session = startControlSession([
    RUN,
    '--app=darkstone_demo',
    '--screen=800x600',
    '--batch-size=500000',
    '--tick-ms-per-batch=250',
    '--max-batches=1000000',
    '--max-seconds=600',
    '--repaint-every=2',
    '--quiet-api',
    '--quiet-blocks',
    '--no-threads',
    '--no-build',
    '--no-close',
    '--control-stdin',
    '--frozen',
  ], { cwd: ROOT, idPrefix: 'dsg-' });

  try {
    await waitForWindow(session);
    const menu = await waitForMainMenu(session);
    assert(menu.width === 800 && menu.height === 600,
      `Darkstone rendered an unexpected ${menu.width}x${menu.height} frame`);

    await click(session, 400, 260, 10); // New Game
    const mode = await capture(session, '02-new-game');
    assert(pixelDiff(menu.png, mode.png) > 5000, 'New Game did not change the menu');
    await click(session, 400, 305, 14); // One Player
    const champions = await capture(session, '03-choose-champions');
    assert(pixelDiff(mode.png, champions.png) > 50000,
      'One Player did not open champion selection');

    await click(session, 145, 410, 14); // Create A Character
    const creator = await capture(session, '04-create-character');
    assert(pixelDiff(champions.png, creator.png) > 30000,
      'Create A Character did not open the character sheet');
    await click(session, 385, 480, 1); // Name field
    await keypressText(session, 'Codex');
    await capture(session, '05-character-named');
    await click(session, 425, 570, 14); // Create
    const created = await capture(session, '06-champion-created');
    assert(pixelDiff(creator.png, created.png) > 20000,
      'Create did not add the champion');

    // Create leaves the new champion attached to the cursor; clicking its
    // roster icon again would cancel that pending placement.
    await tap(session, 530, 225); // Place CODEX in the first team slot.
    const selected = await capture(session, '07-champion-selected');
    assert(pixelDiff(created.png, selected.png) > 10000,
      'The created champion was not selected');
    await session.send('mousemove:425:570');
    await stepTotal(session, 4);
    const persisted = await capture(session, '07b-champion-slot-persisted');
    assert(regionDiff(created.png, persisted.png, 480, 180, 110, 95) > 4000,
      'The champion did not remain in its team slot after moving the cursor');
    await click(session, 425, 570, 10); // OK
    const townA = await waitForTown(session);
    await session.send('keydown:39');
    await session.send('di-keydown:39'); // Rotate camera right.
    await stepTotal(session, 12);
    await session.send('keyup:39');
    await session.send('di-keyup:39');
    await stepTotal(session, 4);
    const townB = await capture(session, '09-town-after-input');
    const changed = pixelDiff(townA.png, townB.png);
    assert(changed > 10000,
      `Darkstone town did not respond to camera input: ${changed} changed pixels`);

    const code = await session.quit();
    assert.strictEqual(code, 0,
      `Darkstone CLI exited ${code}\n${session.output().slice(-12000)}`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError:|CORRUPT state/i.test(session.output()),
      `Darkstone hit a compatibility failure\n${session.output().slice(-12000)}`);
    console.log(`PASS  Darkstone installer payload reached responsive town gameplay (${changed} changed pixels)`);
    console.log(`Screenshots: ${SHOTS}`);
  } catch (error) {
    const detail = session.output().slice(-12000);
    await session.quit({ ignoreReplyError: true });
    throw new Error(`${error.message}\n${detail}`);
  }
}

main().catch(error => {
  console.error(`FAIL  Darkstone gameplay: ${error.stack || error.message}`);
  process.exit(1);
});
