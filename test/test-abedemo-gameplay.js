#!/usr/bin/env node
'use strict';

// Abe's Oddysee demo: exercise the real registered payload from boot, through
// BEGIN and the story transition, into the playable RuptureFarms level.
//
// This is intentionally stronger than test-all-exes' title-art gate. The bug
// that motivated it left a healthy window and two live DirectDraw surfaces on
// screen forever: CreateThread returned HANDLE 0xE1000 and also wrote that
// value to lpThreadId, so Abe's PostThreadMessage targeted a handle instead of
// loader thread id 2. A splash-only test could never distinguish that deadlock
// from a slow intro.
//
// `node test/test-abedemo-gameplay.js <dir>` skips the long run and re-scores
// existing loading/before/moving/after captures while thresholds are tuned.
// --frozen-route uses the verified smaller-batch stdio sequence. The default
// retains the historical larger-batch route, which currently fails at the menu.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');
const { startControlSession } = require('./control-session');

const ROOT = path.join(__dirname, '..');
const INSTALLED_DIR = process.env.ABE_INSTALLED_DIR;
const EXE = INSTALLED_DIR ? path.join(path.resolve(INSTALLED_DIR), 'abedemo.exe')
  : path.join(ROOT, 'test/binaries/shareware/abe/ex/AbeDemo.exe');
const RUN = path.join(__dirname, 'run.js');
const FROZEN_ROUTE = process.argv.includes('--frozen-route');
const RUN_NAME = FROZEN_ROUTE ? 'abedemo-frozen-gameplay' : 'abedemo-gameplay';
const OUTDIR = path.join(ROOT, 'build', RUN_NAME);
const LOG = path.join(ROOT, 'build', `${RUN_NAME}.log`);
const ANALYZE_ONLY = process.argv.slice(2).find(arg => !arg.startsWith('--'));
const DIR = ANALYZE_ONLY || OUTDIR;

if (!ANALYZE_ONLY && !fs.existsSync(EXE)) {
  assert(!INSTALLED_DIR, `installer-produced executable is missing: ${EXE}`);
  console.log('SKIP  Abe Oddysee demo payload is absent');
  process.exit(0);
}

const shot = name => path.join(DIR, `${name}.png`);

async function runFrozen() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const session = startControlSession([
    RUN,
    ...(INSTALLED_DIR ? [`--exe=${EXE}`, '--vfs-include=*.lvl,*.ddv,readme.txt']
      : ['--app=abedemo']),
    '--no-build', '--no-threads', '--max-seconds=180', '--batch-size=100000',
    '--quiet-api', '--quiet-blocks', '--no-close', '--control-stdin', '--frozen',
  ], { cwd: ROOT });
  async function step(n, batch) {
    const reply = await session.step(n);
    assert.strictEqual(reply.batch, batch, 'frozen route stopped before its boundary');
    assert.strictEqual(reply.frozen, true);
  }
  const capture = name => session.send({ action: 'png', path: shot(name) });
  try {
    await step(50, 50);
    await session.send('keydown:13'); await step(1, 51);
    await session.send('keyup:13'); await step(1, 52);
    await session.send('keydown:27'); await step(2, 54);
    await session.send('keyup:27'); await step(150, 204);
    // The entry frame is the menu on this route, not the legacy loading card.
    await capture('loading');
    await session.send('keydown:13'); await step(1, 205);
    await session.send('keyup:13'); await step(100, 305);
    await session.send('keydown:27'); await step(2, 307);
    await session.send('keyup:27'); await step(30, 337);
    await capture('before');
    await session.send('keydown:39'); await step(3, 340);
    await capture('moving');
    await step(3, 343);
    await session.send('keyup:39'); await step(2, 345);
    await capture('after');
  } finally {
    const code = await session.quit({ ignoreReplyError: true });
    fs.writeFileSync(LOG, session.output());
    assert.strictEqual(code, 0, `frozen CLI failed; read ${LOG}`);
    assert(!/\[max-seconds\]/.test(session.output()), `CLI deadline reached; read ${LOG}`);
  }
}

if (!ANALYZE_ONLY && !FROZEN_ROUTE) {
  fs.mkdirSync(OUTDIR, { recursive: true });

  // Historical larger-batch regression: this schedule used to reach the level
  // but currently remains in the menu. Keep it independently reproducible;
  // the passing frozen route does not prove that delivery fault is repaired.
  // Keydown/up deliberately goes only through normal renderer input.
  const input = [
    '405:keydown:40', '407:keyup:40',       // Gamespeak -> Begin
    '420:keydown:13', '422:keyup:13',       // select Begin
  ];
  for (const batch of [520, 540, 560, 580, 600]) {
    input.push(`${batch}:keydown:27`, `${batch + 2}:keyup:27`);
  }
  input.push(
    `570:png:${shot('loading')}`,
    `610:png:${shot('before')}`,
    '612:keydown:39',                       // walk right in the live level
    `620:png:${shot('moving')}`,
    '624:keyup:39',
    `629:png:${shot('after')}`,
    '630:stop',
  );

  const args = [
    RUN,
    ...(INSTALLED_DIR ? [`--exe=${EXE}`, '--vfs-include=*.lvl,*.ddv,readme.txt']
      : ['--app=abedemo']),
    '--no-build', '--no-threads', '--max-seconds=240',
    '--batch-size=1000000', '--max-batches=631',
    '--quiet-api', '--quiet-blocks', '--no-close', '--dx-surfaces',
    '--trace-api=CreateThread,PostThreadMessageA',
    `--input=${input.join(',')}`,
  ];
  console.log('$', process.execPath, args.join(' '));
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  const output = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(LOG, output);
  if (result.error) throw result.error;
  if (result.status !== 0 || /\[max-seconds\]/.test(output)) {
    console.error(output.split('\n').slice(-60).join('\n'));
    throw new Error(/\[max-seconds\]/.test(output)
      ? `Abe gameplay reached the CLI deadline; read ${LOG}`
      : result.signal
      ? `Abe gameplay run ended by ${result.signal}; check host load and ${LOG}`
      : `Abe gameplay run exited ${result.status}; read ${LOG}`);
  }
}

function readPng(name) {
  const file = shot(name);
  assert(fs.existsSync(file), `${name}.png was not captured; read ${LOG}`);
  return PNG.sync.read(fs.readFileSync(file));
}

function colorStats(png) {
  const colors = new Set();
  let nonBlack = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    colors.add((r << 16) | (g << 8) | b);
    if (r + g + b > 24) nonBlack++;
  }
  return { colors: colors.size, nonBlack };
}

function changedShare(a, b, x0, y0, x1, y1) {
  assert.strictEqual(a.width, b.width);
  assert.strictEqual(a.height, b.height);
  let changed = 0, total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (a.width * y + x) << 2;
      const delta = Math.abs(a.data[i] - b.data[i])
        + Math.abs(a.data[i + 1] - b.data[i + 1])
        + Math.abs(a.data[i + 2] - b.data[i + 2]);
      if (delta > 30) changed++;
      total++;
    }
  }
  return changed / total;
}

// Abe is the concentrated cyan/teal object in the left-center playfield.
// Keeping this bounded excludes the green lamps along the bottom HUD rail.
function abeCyan(png) {
  let count = 0, sumX = 0, sumY = 0;
  for (let y = 140; y < 400; y++) {
    for (let x = 40; x < 380; x++) {
      const i = (png.width * y + x) << 2;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      if (g > 45 && b > 40 && g > r * 1.35 && b > r * 1.15) {
        count++; sumX += x; sumY += y;
      }
    }
  }
  return { count, x: sumX / Math.max(1, count), y: sumY / Math.max(1, count) };
}

function verifyGameplay() {
  const loading = readPng('loading');
  const before = readPng('before');
  const moving = readPng('moving');
  const after = readPng('after');
  for (const png of [loading, before, moving, after]) {
    assert.strictEqual(png.width, 640);
    assert.strictEqual(png.height, 480);
  }

  const loadingStats = colorStats(loading);
  const gameplayStats = colorStats(before);
  const beforeAbe = abeCyan(before);
  const movingAbe = abeCyan(moving);
  const afterAbe = abeCyan(after);
  const movement = changedShare(before, moving, 0, 48, 640, 430);
  const followThrough = changedShare(moving, after, 0, 48, 640, 430);
  const loadingToLevel = changedShare(loading, before, 0, 0, 640, 480);

  console.log('  loading:', loadingStats);
  console.log('  gameplay:', gameplayStats);
  console.log('  Abe before:', beforeAbe);
  console.log('  Abe moving:', movingAbe);
  console.log('  Abe after:', afterAbe);
  console.log('  loading -> level changed:', loadingToLevel.toFixed(3));
  console.log('  right-key frame changed:', movement.toFixed(3));
  console.log('  post-release frame changed:', followThrough.toFixed(3));

  assert(loadingStats.colors > 500 && loadingStats.nonBlack > 180000,
    FROZEN_ROUTE ? 'the entry menu did not render' : 'the batch-570 frame is not Abe\'s rendered loading card');
  assert(gameplayStats.colors > 800 && gameplayStats.nonBlack > 100000,
    'the run did not reach a richly rendered RuptureFarms gameplay frame');
  assert(loadingToLevel > 0.45,
    'the loading card never transitioned into the level');
  assert(beforeAbe.count > 300,
    `the gameplay frame does not contain Abe's cyan sprite (${beforeAbe.count}px)`);
  assert(movement > 0.01,
    `the level did not advance while Right was held (${movement.toFixed(3)} changed)`);
  assert(movingAbe.x > beforeAbe.x + 2,
    `Abe did not move right (${beforeAbe.x.toFixed(1)} -> ${movingAbe.x.toFixed(1)})`);
  assert(afterAbe.count > 300 && afterAbe.x > movingAbe.x + 5 && followThrough > 0.01,
    `Abe's live run did not continue through key release `
    + `(${movingAbe.x.toFixed(1)} -> ${afterAbe.x.toFixed(1)}, `
    + `${followThrough.toFixed(3)} changed)`);

  if (!ANALYZE_ONLY) {
    const log = fs.readFileSync(LOG, 'utf8');
    assert(FROZEN_ROUTE ? /"batch":345,"ran":2/.test(log) : /\[input\] stop at batch 630/.test(log),
      'gameplay input schedule did not finish');
    assert(!/\[input\] png FAILED/.test(log), 'a gameplay capture failed');
    if (!FROZEN_ROUTE) assert(/PostThreadMessageA\(0x00000002/.test(log),
      'Abe did not target its loader thread id');
    assert(!/UNIMPLEMENTED API|RuntimeError|unreachable/.test(log),
      `the run trapped; read ${LOG}`);
  }

  console.log('PASS  Abe Oddysee selects BEGIN, loads RuptureFarms, and walks right');
}

if (FROZEN_ROUTE && !ANALYZE_ONLY) {
  runFrozen().then(verifyGameplay).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  verifyGameplay();
}
