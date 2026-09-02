#!/usr/bin/env node

// End-to-end gate for the original Little Fighter 2 v1.9 installer. The
// proprietary freeware package remains a local/gitignored fixture, so this
// test is intentionally outside run-all.sh and skips when it is absent.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const CANDIDATE_ROOT = path.join(__dirname, 'binaries', 'candidates',
  'little-fighter-2-installer');
const INSTALLER = path.join(CANDIDATE_ROOT, 'lf2_v19.exe');
const DEBUG_WEB_DIR = path.join(CANDIDATE_ROOT, 'installed');
const INSTALLER_SHA256 = '1e4e93510fc47ac636c918cdde97c645e02bcac611ec9d3181f4ecaf9733b819';
const GAME_SHA256 = '41ee2d29f41eb8e6975d14b42922fe40481d40c6b11eb7a2c6b239fbc578f251';

// Loading all 134 stock DirectDraw sprite surfaces makes this candidate a
// memory-capacity test instead of a gameplay test. Keep authentic installed
// assets, but reduce the object index in the temporary test VFS to three
// fighters, their dependencies, and one stock background.
const REDUCED_DATA = String.raw`<object>
id:  0  type: 0  file: data\template.dat
id:  1  type: 0  file: data\deep.dat
id:  2  type: 0  file: data\john.dat

id: 100  type: 1  file: data\weapon0.dat
id: 200  type: 3  file: data\john_ball.dat
id: 203  type: 3  file: data\deep_ball.dat
id: 214  type: 3  file: data\john_biscuit.dat
id: 998  type: 5  file: data\etc.dat
id: 999  type: 5  file: data\broken_weapon.dat
<object_end>

<file_editing>
data\nothing.txt
<file_editing_end>

<background>
id: 0    file: bg\sys\thv\bg.dat
<background_end>

id: 100~199 drop weapon
`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function runCli(args) {
  const result = spawnSync('node', [RUN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`CLI exited ${result.status}${result.signal ? ` (${result.signal})` : ''}\n${output.slice(-8000)}`);
  }
  if (/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(output)) {
    throw new Error(`CLI compatibility failure\n${output.slice(-8000)}`);
  }
  return output;
}

function imageStats(filename) {
  const png = PNG.sync.read(fs.readFileSync(filename));
  const colors = new Set();
  let nonBlack = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2], a = png.data[i + 3];
    if (a && (r || g || b)) nonBlack++;
    if (a) colors.add((r << 16) | (g << 8) | b);
  }
  return { png, width: png.width, height: png.height, colors: colors.size, nonBlack };
}

function pixelDiff(a, b) {
  assert(a.width === b.width && a.height === b.height,
    'cannot compare differently sized LF2 frames');
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) changed++;
  }
  return changed;
}

function walkFiles(root, relative = '') {
  const rows = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) rows.push(...walkFiles(root, child));
    else if (entry.isFile()) rows.push(child);
  }
  return rows;
}

function prepareDebugWeb(installRoot) {
  fs.mkdirSync(DEBUG_WEB_DIR, { recursive: true });
  for (const relative of walkFiles(installRoot)) {
    if (relative === 'lf2_v19.exe' || relative.startsWith(`windows${path.sep}`)) continue;
    const destination = path.join(DEBUG_WEB_DIR, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(installRoot, relative), destination);
  }
  const files = walkFiles(DEBUG_WEB_DIR)
    .filter(relative => relative !== '.wine-assembly-browser.json')
    .sort((a, b) => a.localeCompare(b))
    .map(relative => ({
      url: relative.split(path.sep).join('/'),
      vfsPath: `c:\\${relative.split(path.sep).join('\\')}`,
    }));
  fs.writeFileSync(path.join(DEBUG_WEB_DIR, '.wine-assembly-browser.json'),
    `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`);
  fs.writeFileSync(path.join(DEBUG_WEB_DIR, 'data', 'data.txt'), REDUCED_DATA);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runGameplay(gameExe, screenshotDir) {
  const menuPath = path.join(screenshotDir, 'menu.png');
  const frameAPath = path.join(screenshotDir, 'gameplay-a.png');
  const frameBPath = path.join(screenshotDir, 'gameplay-b.png');
  const useRegisteredApp = process.env.PREPARE_LF2_DEBUG_WEB === '1';
  const child = spawn('node', [
    RUN,
    useRegisteredApp ? '--app=little_fighter_2' : `--exe=${gameExe}`,
    ...(useRegisteredApp ? [] : ['--vfs-include=**/*']),
    '--screen=800x600',
    '--batch-size=100000',
    '--control-stdin',
    '--frozen',
    '--max-seconds=600',
    '--quiet-api',
    '--quiet-blocks',
    '--no-build',
  ], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });

  let output = '';
  let lineBuf = '';
  let nextId = 1;
  const pending = new Map();
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));

  function onData(data) {
    output += data;
    lineBuf += String(data);
    const lines = lineBuf.split(/\r?\n/);
    lineBuf = lines.pop() || '';
    for (const line of lines) {
      const match = line.match(/^\[ctl\] (.*)$/);
      if (!match) continue;
      let reply;
      try { reply = JSON.parse(match[1]); } catch (_) { continue; }
      const waiter = pending.get(reply.id);
      if (!waiter) continue;
      pending.delete(reply.id);
      reply.ok ? waiter.resolve(reply.value) : waiter.reject(new Error(reply.error));
    }
  }

  child.stdout.on('data', onData);
  child.stderr.on('data', data => { output += data; });
  child.on('exit', code => {
    for (const [id, waiter] of pending) {
      waiter.reject(new Error(`run.js exited before replying to ${id} (exit ${code})`));
    }
    pending.clear();
  });

  function send(command) {
    const id = `lf${nextId++}`;
    const payload = typeof command === 'string' ? { id, cmd: command } : { id, ...command };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify(payload)}\n`, error => {
        if (!error) return;
        pending.delete(id);
        reject(error);
      });
    });
  }

  // Short stepped bursts cap continuous CPU use. Between bursts the frozen
  // CLI blocks on stdin and executes no emulator work.
  async function stepTotal(count, chunk = 25) {
    let remaining = count;
    while (remaining > 0) {
      const n = Math.min(chunk, remaining);
      const reply = await send({ action: 'step', n });
      assert(reply.ran === n,
        `LF2 requested ${n} steps but ran ${reply.ran}: ${JSON.stringify(reply)}\n${output.slice(-5000)}`);
      remaining -= n;
      if (remaining) await sleep(40);
    }
  }

  async function pulse(vk, downSteps = 3, upSteps = 5) {
    await send(`keydown:${vk}`);
    await stepTotal(downSteps, downSteps);
    await send(`keyup:${vk}`);
    await stepTotal(upSteps, upSteps);
  }

  try {
    await stepTotal(2, 2);
    await send('mousemove:400:313');
    await stepTotal(1, 1);
    await send('mousedown:400:313');
    await stepTotal(1, 1);
    await send('mouseup:400:313');
    await stepTotal(5, 5);

    // The reduced authentic roster finishes loading near batch 628. Keep the
    // command stream responsive rather than issuing one long 620-batch burst.
    await stepTotal(650);
    await send({ action: 'png', path: menuPath });
    const menu = imageStats(menuPath);
    assert(menu.width === 800 && menu.height === 600 && menu.colors > 200,
      `LF2 mode menu did not render: ${menu.width}x${menu.height}, ${menu.colors} colors, ${menu.nonBlack} nonblack pixels`);

    await pulse(13); // VS mode.
    for (let i = 0; i < 3; i++) await pulse(13); // P3 joins, picks fighter/team.
    for (let i = 0; i < 3; i++) await pulse(83); // P2 attack: join/fighter/team.
    await stepTotal(180);
    await pulse(39); // One computer player.
    await pulse(13);
    await pulse(13); // CPU fighter.
    await pulse(13); // CPU team.
    await pulse(38); // Overlay selection: Reset Random -> Reset All.
    await pulse(38); // Reset All -> Fight.
    await pulse(13);
    // The fight starts immediately, but LF2 leaves only player labels visible
    // during its opening countdown. Wait for the actual fighter sprites.
    await stepTotal(180);

    await send({ action: 'png', path: frameAPath });
    await send('keydown:39'); // P3 right.
    await stepTotal(12, 6);
    await send('keydown:13'); // P3 attack.
    await stepTotal(5, 5);
    await send('keyup:13');
    await send('keyup:39');
    await stepTotal(8, 4);
    await send({ action: 'png', path: frameBPath });

    const a = imageStats(frameAPath);
    const b = imageStats(frameBPath);
    for (const [label, stats] of [['first', a], ['second', b]]) {
      assert(stats.width === 800 && stats.height === 600,
        `LF2 ${label} combat frame was ${stats.width}x${stats.height}`);
      assert(stats.nonBlack > 400000 && stats.colors > 1000,
        `LF2 ${label} frame was not textured combat: ${stats.colors} colors, ${stats.nonBlack} nonblack pixels`);
    }
    const changed = pixelDiff(a.png, b.png);
    assert(changed > 50000,
      `LF2 fighters/arena did not advance after movement and attack: ${changed} pixels`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(output),
      `LF2 hit a compatibility failure\n${output.slice(-8000)}`);

    await send({ action: 'quit' });
    child.stdin.end();
    const code = await exited;
    assert(code === 0, `LF2 gameplay CLI exited ${code}\n${output.slice(-8000)}`);
    return { a, b, changed, frameAPath, frameBPath };
  } catch (error) {
    if (child.exitCode === null) {
      try { await send({ action: 'quit' }); } catch (_) {}
      child.stdin.end();
      await exited;
    }
    throw error;
  }
}

async function main() {
  if (!fs.existsSync(INSTALLER)) {
    console.log('SKIP LF2 candidate: fetch with node tools/fetch-candidate-corpus.js --id=little-fighter-2-installer');
    return;
  }
  assert(sha256(INSTALLER) === INSTALLER_SHA256, 'LF2 installer hash does not match the pinned v1.9 package');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-lf2-candidate-'));
  const inputRoot = path.join(temp, 'input');
  const installRoot = path.join(temp, 'installed-vfs');
  const screenshotDir = process.env.LF2_SCREENSHOT_DIR ||
    path.join(ROOT, 'build', 'little-fighter-2-candidate');
  const installerPng = path.join(screenshotDir, 'installer-finished.png');
  fs.mkdirSync(inputRoot, { recursive: true });
  fs.mkdirSync(screenshotDir, { recursive: true });
  fs.copyFileSync(INSTALLER, path.join(inputRoot, 'lf2_v19.exe'));

  try {
    const installedSeed = String(process.env.LF2_INSTALLED_ROOT || '').trim();
    if (installedSeed) {
      console.log(`Little Fighter 2 candidate stage 1/2: reusing installed debug seed ${installedSeed}`);
      fs.cpSync(installedSeed, installRoot, { recursive: true });
    } else {
      console.log('Little Fighter 2 candidate stage 1/2: running original installer...');
      const installerOutput = runCli([
        `--exe=${path.join(inputRoot, 'lf2_v19.exe')}`,
        '--screen=800x600',
        '--batch-size=10000',
        '--max-batches=9000',
        '--max-seconds=300',
        '--repaint-every=1000',
        '--stuck-after=9000',
        '--no-close',
        '--quiet-api',
        '--quiet-blocks',
        '--no-build',
        '--input=0:wait-title:Welcome:500,1:click:490:469,' +
          '2:wait-title:Directory:500,3:click:490:469,' +
          '4:wait-title:Confirmation:500,5:click:490:469,' +
          '6:wait-title-dump-stop:Install_Program_-_End:8000:lf2',
        `--save-vfs=${installRoot}`,
        `--png=${installerPng}`,
      ]);
      assert(/wait-title: matched "Install Program - End"/.test(installerOutput),
        `LF2 installer did not reach its completion page\n${installerOutput.slice(-8000)}`);
      assert(/successfully installed/i.test(installerOutput),
        `LF2 installer did not report success\n${installerOutput.slice(-8000)}`);
      const installer = imageStats(installerPng);
      assert(installer.width === 800 && installer.height === 600 && installer.colors > 10,
        `LF2 completion page was not visibly rendered: ${installer.width}x${installer.height}, ${installer.colors} colors`);
      console.log(`PASS installer: ${installer.width}x${installer.height}, ${installer.colors} colors`);
    }

    const gameExe = path.join(installRoot, 'lf2.exe');
    for (const [relative, minBytes] of [
      ['lf2.exe', 3800000], ['uninstal.exe', 60000], ['readme.txt', 7000],
      [path.join('data', 'data.txt'), 3000], [path.join('bg', 'sys', 'thv', 'bg.dat'), 100],
    ]) {
      const filename = path.join(installRoot, relative);
      assert(fs.existsSync(filename), `LF2 installer omitted ${relative}`);
      assert(fs.statSync(filename).size >= minBytes, `LF2 installer truncated ${relative}`);
    }
    assert(sha256(gameExe) === GAME_SHA256, 'LF2 installer produced an unexpected game executable');
    const readme = fs.readFileSync(path.join(installRoot, 'readme.txt'), 'latin1');
    assert(/Copyright 1999-2002[\s\S]*Marti Wong and Starsky Wong[\s\S]*All rights reserved/i.test(readme),
      'LF2 installed readme omitted its copyright notice');
    if (process.env.PREPARE_LF2_DEBUG_WEB === '1') {
      prepareDebugWeb(installRoot);
      console.log(`prepared debug web payload: ${path.relative(ROOT, DEBUG_WEB_DIR)}`);
    }

    fs.writeFileSync(path.join(installRoot, 'data', 'data.txt'), REDUCED_DATA);
    console.log('Little Fighter 2 candidate stage 2/2: driving frozen VS combat...');
    const gameplay = await runGameplay(gameExe, screenshotDir);
    console.log(`PASS gameplay: ${gameplay.a.colors}/${gameplay.b.colors} colors, ${gameplay.changed} changed pixels`);
    console.log(`PASS screenshots: ${gameplay.frameAPath} ${gameplay.frameBPath}`);
    console.log('Little Fighter 2 candidate: PASS 2/2');
  } finally {
    if (process.env.KEEP_LF2_CANDIDATE_TMP === '1') {
      console.log(`kept candidate artifacts: ${temp}`);
    } else {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(`FAIL LF2 candidate: ${error.stack || error.message}`);
  process.exit(1);
});
