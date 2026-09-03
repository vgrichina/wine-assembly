#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const CANDIDATE = path.join(__dirname, 'binaries', 'candidates',
  'total-annihilation-demo');
const INSTALLER = path.join(CANDIDATE, 'Total Annihilation.exe');
const GAME_ROOT = path.join(CANDIDATE, 'installed-fixed', 'cavedog', 'totala', 'demo');
const GAME = path.join(GAME_ROOT, 'tademo.exe');
const HPI = path.join(GAME_ROOT, 'tademo.hpi');
const SHOTS = path.join(ROOT, 'build', 'total-annihilation-candidate');

const HASHES = {
  installer: '5e41cf05226c274b4ac9e4398f74f6b321506bd7a4317ee1744ff7aceba34c49',
  game: '216e4f39617cb979cd2bc1fba92e9e5136b33a98790d9fc6d3d1cb901ecfbb57',
  hpi: 'fd53a2637ecf8fb5ca6d2c02a34b4ef783a4441f8be070137276afc4d5627e1e',
};

function check(condition, message) { if (!condition) throw new Error(message); }
function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function imageStats(filename) {
  const png = PNG.sync.read(fs.readFileSync(filename));
  let nonBlack = 0;
  const colors = new Set();
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    if (png.data[i + 3] && (r || g || b)) nonBlack++;
    colors.add((r << 16) | (g << 8) | b);
  }
  return { png, width: png.width, height: png.height, nonBlack, colors: colors.size };
}

function pixelDiff(a, b) {
  check(a.width === b.width && a.height === b.height,
    'Total Annihilation gameplay frame sizes differ');
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) changed++;
  }
  return changed;
}

function startControlled(args) {
  const child = spawn('node', [RUN, ...args],
    { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });

  let output = '', lineBuffer = '';
  let nextId = 1;
  const pending = new Map();
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  const onData = data => {
    output += data;
    lineBuffer += String(data);
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() || '';
    for (const line of lines) {
      const match = /^\[ctl\] (.*)$/.exec(line);
      if (!match) continue;
      let reply;
      try { reply = JSON.parse(match[1]); } catch (_) { continue; }
      const waiter = pending.get(reply.id);
      if (!waiter) continue;
      pending.delete(reply.id);
      reply.ok ? waiter.resolve(reply.value) : waiter.reject(new Error(reply.error));
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', data => { output += data; });
  child.on('exit', code => {
    for (const [, waiter] of pending) waiter.reject(new Error(`run.js exited ${code}`));
    pending.clear();
  });
  const send = command => {
    const id = `ta${nextId++}`;
    const payload = typeof command === 'string' ? { id, cmd: command } : { id, ...command };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify(payload)}\n`, error => {
        if (!error) return;
        pending.delete(id);
        reject(error);
      });
    });
  };
  return { child, exited, send, output: () => output };
}

async function step(session, n) {
  const reply = await session.send({ action: 'step', n });
  check(reply.ran === n,
    `Total Annihilation requested ${n} steps but ran ${reply.ran}: ${JSON.stringify(reply)}`);
}

async function quit(session) {
  if (session.child.exitCode === null) {
    try { await session.send({ action: 'quit' }); } catch (_) {}
    session.child.stdin.end();
  }
  return session.exited;
}

async function runInstaller(installRoot) {
  const eulaPath = path.join(SHOTS, 'installer-eula.png');
  const completedPath = path.join(SHOTS, 'installer-complete.png');
  const session = startControlled([
    `--exe=${INSTALLER}`, '--control-stdin', '--frozen',
    '--screen=640x480', '--batch-size=200000', '--repaint-every=10',
    '--max-batches=1000000', '--max-seconds=180',
    '--quiet-api', '--quiet-blocks', '--no-close', '--no-build',
    `--save-vfs=${installRoot}`,
  ]);
  try {
    await step(session, 20);
    await session.send({ action: 'png', path: eulaPath });
    const eula = imageStats(eulaPath);
    check(eula.colors > 10 && eula.nonBlack > 40000,
      `Total Annihilation EULA did not render (${eula.colors} colors)`);
    await session.send('click:89:221');
    await step(session, 100);
    await session.send('click:91:130');
    await step(session, 200);
    await session.send({ action: 'png', path: completedPath });
    const completed = imageStats(completedPath);
    check(completed.colors > 10 && completed.nonBlack > 40000,
      `Total Annihilation completion dialog did not render (${completed.colors} colors)`);
    const code = await quit(session);
    check(code === 0, `Total Annihilation installer exited ${code}\n${session.output().slice(-8000)}`);
  } catch (error) {
    await quit(session);
    throw error;
  }
  const freshRoot = path.join(installRoot, 'cavedog', 'totala', 'demo');
  const freshGame = path.join(freshRoot, 'tademo.exe');
  const freshHpi = path.join(freshRoot, 'tademo.hpi');
  check(fs.existsSync(freshGame) && sha256(freshGame) === HASHES.game,
    'native installer did not write the exact TADemo.exe');
  check(fs.existsSync(freshHpi) && sha256(freshHpi) === HASHES.hpi,
    'native installer did not write the exact TADemo.hpi');
  return { freshGame, freshHpi };
}

(async () => {
  if (![INSTALLER, GAME, HPI].every(fs.existsSync)) {
    console.log('SKIP  local Total Annihilation installer/payload is not present');
    process.exit(0);
  }
  check(sha256(INSTALLER) === HASHES.installer, 'Total Annihilation installer hash changed');
  check(sha256(GAME) === HASHES.game, 'installer-produced TADemo.exe hash changed');
  check(sha256(HPI) === HASHES.hpi, 'installer-produced TADemo.hpi hash changed');
  fs.mkdirSync(SHOTS, { recursive: true });
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-native-install-'));
  const { freshGame, freshHpi } = await runInstaller(installRoot);

  const menuPath = path.join(SHOTS, 'menu.png');
  const briefingPath = path.join(SHOTS, 'briefing.png');
  const gameplayAPath = path.join(SHOTS, 'gameplay-a.png');
  const gameplayBPath = path.join(SHOTS, 'gameplay-b.png');
  const session = startControlled([
    `--exe=${freshGame}`, `--vfs-mount=${freshHpi}=c:\\tademo.hpi`,
    '--control-stdin', '--frozen', '--screen=640x480',
    '--tick-ms-per-batch=16', '--batch-size=20000', '--repaint-every=20',
    '--max-batches=1000000', '--max-seconds=180',
    '--quiet-api', '--quiet-blocks', '--no-close', '--no-build',
  ]);
  try {
    await step(session, 1600);
    await session.send({ action: 'png', path: menuPath });
    const menu = imageStats(menuPath);
    check(menu.width === 640 && menu.height === 480 && menu.colors > 80 && menu.nonBlack > 180000,
      `Total Annihilation menu did not render (${menu.colors} colors, ${menu.nonBlack} nonblack)`);

    await session.send('click:184:402');
    await step(session, 300);
    await session.send('click:500:145');
    await step(session, 500);
    await session.send('click:532:430');
    await step(session, 1000);
    await session.send({ action: 'png', path: briefingPath });
    const briefing = imageStats(briefingPath);
    check(briefing.colors > 60 && briefing.nonBlack > 170000,
      `Total Annihilation mission briefing did not render (${briefing.colors} colors)`);

    await session.send('click:545:448');
    await step(session, 1200);
    await session.send({ action: 'png', path: gameplayAPath });
    const gameplayA = imageStats(gameplayAPath);
    check(gameplayA.colors > 150 && gameplayA.nonBlack > 240000,
      `Total Annihilation battlefield did not render (${gameplayA.colors} colors, ${gameplayA.nonBlack} nonblack)`);

    await session.send('keydown:39');
    await step(session, 30);
    await session.send('keyup:39');
    await step(session, 50);
    await session.send({ action: 'png', path: gameplayBPath });
    const gameplayB = imageStats(gameplayBPath);
    const changed = pixelDiff(gameplayA.png, gameplayB.png);
    check(changed > 5000,
      `Total Annihilation battlefield did not respond to input (${changed} changed pixels)`);

    const code = await quit(session);
    check(code === 0, `Total Annihilation CLI exited ${code}\n${session.output().slice(-8000)}`);
    check(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(session.output()),
      `Total Annihilation compatibility failure\n${session.output().slice(-8000)}`);
    console.log(`PASS  Total Annihilation original installer payload reaches responsive campaign gameplay (${gameplayA.colors}/${gameplayB.colors} colors, ${changed} changed pixels)`);
    fs.rmSync(installRoot, { recursive: true, force: true });
  } catch (error) {
    await quit(session);
    fs.rmSync(installRoot, { recursive: true, force: true });
    throw error;
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
