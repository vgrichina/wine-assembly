#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { startControlSession } = require('./control-session');

const ROOT = path.join(__dirname, '..');
const PACKAGE = path.join(ROOT, 'test/binaries/win98-games-a-d',
  'Dungeon Keeper Demo-SWonly');
const INSTALLER = path.join(PACKAGE, 'KDDATA.EXE');
const INSTALLED = path.join(PACKAGE, 'installed');
const EXE = path.join(INSTALLED, 'KEEPER95.EXE');
const OUT = process.env.DUNGEON_KEEPER_CAPTURE_DIR ||
  path.join(ROOT, 'build/dungeon-keeper-gameplay');

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function stats(png) {
  const colors = new Set();
  let nonBlack = 0;
  let bright = 0;
  let red = 0;
  let orange = 0;
  let bottomOrange = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i];
      const g = png.data[i + 1];
      const b = png.data[i + 2];
      colors.add(`${r >> 3},${g >> 3},${b >> 3}`);
      if (r + g + b > 30) nonBlack++;
      if (r + g + b > 500) bright++;
      if (r > 70 && r > g * 1.4 && r > b * 1.3) red++;
      if (r > 140 && g > 45 && g < 170 && b < 70) {
        orange++;
        if (y >= 350 && x >= 140) bottomOrange++;
      }
    }
  }
  return { colors: colors.size, nonBlack, bright, red, orange, bottomOrange };
}

function changedPixels(a, b) {
  assert.strictEqual(a.width, b.width);
  assert.strictEqual(a.height, b.height);
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (delta > 30) changed++;
  }
  return changed;
}

async function main() {
  if (!fs.existsSync(INSTALLER)) {
    console.log('SKIP  Dungeon Keeper demo source package is absent');
    return;
  }
  assert(fs.existsSync(EXE),
    'original Dungeon Keeper installer output is absent; run node tools/install-dungeon-keeper-demo.js');
  assert.strictEqual(sha256(INSTALLER),
    'f121c2f77583e35a258617308f609aefbd73ca249974e3cdbac7520c4cdda92a');
  assert.strictEqual(sha256(EXE),
    '4d3cd6a7866520f360288b08440e0f20379b4b39216a9576c388e42fcdf72c84');
  assert.strictEqual(sha256(path.join(INSTALLED, 'LEVELS/MAP00001.DAT')),
    '57f068b16b43b42e268bcf03794a966debb1bf0524f6a4ce2d1f875cb60c7fa9');

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const session = startControlSession([
    'test/run.js', '--app=dungeon_keeper_demo', '--control-stdin', '--frozen',
    '--max-batches=1000000', '--max-seconds=240', '--batch-size=200000',
    '--tick-ms-per-batch=100', '--repaint-every=1', '--screen=640x480',
    '--quiet-api', '--quiet-blocks', '--no-build', '--no-close',
  ], { cwd: ROOT, idPrefix: 'dk-game-' });

  const capture = async name => {
    const filename = path.join(OUT, `${name}.png`);
    await session.send({ action: 'png', path: filename });
    return { filename, png: PNG.sync.read(fs.readFileSync(filename)) };
  };

  try {
    await session.step(20);
    let menu = null;
    for (let stage = 0; stage < 20 && !menu; stage++) {
      await session.send('keydown:27');
      await session.send('keypress:27');
      await session.send('di-keydown:27');
      await session.step(1);
      await session.send('keyup:27');
      await session.send('di-keyup:27');
      await session.step(9);
      const candidate = await capture('menu-probe');
      const s = stats(candidate.png);
      if (s.nonBlack > 260000 && s.bright > 5000 && s.red > 28000) menu = candidate;
    }
    assert(menu, `Dungeon Keeper main menu was not reached:\n${session.output().slice(-5000)}`);
    fs.copyFileSync(menu.filename, path.join(OUT, 'main-menu.png'));

    // Relative mouse motion controls the game's software cursor. Small steps
    // are intentional: the game applies its own sensitivity and clipping.
    await session.send('mousemove:172:116');
    await session.step(1);
    for (let i = 0; i < 20; i++) {
      await session.send('relmousemove:-10:-10');
      await session.step(1);
    }
    for (let i = 0; i < 5; i++) {
      await session.send('relmousemove:0:-10');
      await session.step(1);
    }
    const hover = await capture('new-game-hover');
    assert(changedPixels(menu.png, hover.png) > 1000,
      'relative mouse input did not highlight Start New Game');

    // The menu takes Win32 button messages while reading cursor motion from
    // DirectInput. Click at the renderer's unchanged host point so no false
    // DirectInput delta is introduced.
    const pointer = await session.send({
      action: 'eval', code: '({x:renderer._mouseX|0,y:renderer._mouseY|0})',
    });
    await session.send(`mousedown:${pointer.x}:${pointer.y}`);
    await session.step(3);
    await session.send(`mouseup:${pointer.x}:${pointer.y}`);
    await session.step(1);

    let dungeon = null;
    for (let stage = 0; stage < 14 && !dungeon; stage++) {
      await session.step(10);
      const candidate = await capture('dungeon-probe');
      const s = stats(candidate.png);
      if (s.colors > 160 && s.nonBlack > 190000 && s.nonBlack < 255000 &&
          s.bright < 2000 && s.bottomOrange < 2000) {
        dungeon = candidate;
      }
    }
    assert(dungeon, `Dungeon Keeper did not load its playable level:\n${session.output().slice(-5000)}`);
    fs.copyFileSync(dungeon.filename, path.join(OUT, 'dungeon-live.png'));

    await session.send('di-keydown:39');
    await session.step(8);
    const tutorial = await capture('dungeon-tutorial');
    await session.send('di-keyup:39');
    await session.step(2);

    const dungeonStats = stats(dungeon.png);
    const tutorialStats = stats(tutorial.png);
    const changed = changedPixels(dungeon.png, tutorial.png);
    assert(tutorialStats.bottomOrange > 3000,
      `the live level did not expose its tutorial UI (${JSON.stringify(tutorialStats)})`);
    assert(changed > 30000,
      `the dungeon did not advance into the tutorial (${changed} changed pixels)`);
    assert(!/RuntimeError|unreachable|FATAL:/.test(session.output()),
      `Dungeon Keeper trapped:\n${session.output().slice(-5000)}`);

    const code = await session.quit();
    assert.strictEqual(code, 0, session.output().slice(-5000));
    console.log(`PASS  Dungeon Keeper installer payload reached live gameplay: ${JSON.stringify(dungeonStats)}`);
    console.log(`PASS  Dungeon Keeper tutorial advanced: ${changed} changed pixels`);
    console.log(`PASS  Dungeon Keeper screenshots: ${OUT}`);
  } catch (error) {
    await session.quit({ ignoreReplyError: true });
    throw error;
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
