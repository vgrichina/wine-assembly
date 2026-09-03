#!/usr/bin/env node

// End to end from the original Pocket Tanks bootstrap through its generated
// Inno child and into Target Practice. All extraction happens in the guest
// VFS; the host only receives the VFS after the installer has run.

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
  'pocket-tanks-installer');
const INSTALLER = path.join(CANDIDATE_ROOT, 'ptanks.exe');
const DEBUG_WEB_DIR = path.join(CANDIDATE_ROOT, 'installed');
const INSTALLER_SHA256 = 'a3d7da899ab2d3cdd33c6b10747478628175c5a5e0c215eb43a629e6cf98c982';

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
  assert(result.status === 0,
    `CLI exited ${result.status}${result.signal ? ` (${result.signal})` : ''}\n${output.slice(-8000)}`);
  assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(output),
    `CLI compatibility failure\n${output.slice(-8000)}`);
  return output;
}

function imageStats(filename) {
  const png = PNG.sync.read(fs.readFileSync(filename));
  let nonBlack = 0;
  const colors = new Set();
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2], a = png.data[i + 3];
    if (a && (r || g || b)) nonBlack++;
    if (a) colors.add((r << 16) | (g << 8) | b);
  }
  return { png, width: png.width, height: png.height, nonBlack, colors: colors.size };
}

function pixelDiff(a, b) {
  assert(a.width === b.width && a.height === b.height,
    'cannot compare differently sized Pocket Tanks frames');
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) changed++;
  }
  return changed;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function walkFiles(root, relative = '') {
  const rows = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) rows.push(...walkFiles(root, child));
    else if (entry.isFile()) rows.push(child);
  }
  return rows;
}

function findFile(root, basename) {
  const lower = basename.toLowerCase();
  const relative = walkFiles(root).find(file => path.basename(file).toLowerCase() === lower);
  return relative ? path.join(root, relative) : null;
}

function prepareDebugWeb(installDir) {
  fs.rmSync(DEBUG_WEB_DIR, { recursive: true, force: true });
  fs.mkdirSync(DEBUG_WEB_DIR, { recursive: true });
  for (const relative of walkFiles(installDir)) {
    const destination = path.join(DEBUG_WEB_DIR, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(installDir, relative), destination);
  }
  const files = walkFiles(DEBUG_WEB_DIR).sort((a, b) => a.localeCompare(b)).map(relative => ({
    url: relative.split(path.sep).join('/'),
    vfsPath: `c:\\${relative.split(path.sep).join('\\')}`,
  }));
  fs.writeFileSync(path.join(DEBUG_WEB_DIR, '.wine-assembly-browser.json'),
    `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`);
}

function startControlled(args, prefix) {
  const child = spawn('node', [RUN, ...args], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
    for (const [, waiter] of pending) waiter.reject(new Error(`run.js exited ${code}`));
    pending.clear();
  });

  function send(command) {
    const id = `${prefix}${nextId++}`;
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
  return { child, exited, send, output: () => output };
}

async function stepTotal(session, count, chunk = 25) {
  let remaining = count;
  while (remaining > 0) {
    const n = Math.min(chunk, remaining);
    const reply = await session.send({ action: 'step', n });
    assert(reply.ran === n,
      `requested ${n} frozen steps but ran ${reply.ran}: ${JSON.stringify(reply)}\n${session.output().slice(-8000)}`);
    remaining -= n;
    if (remaining) await sleep(20);
  }
}

async function quitSession(session) {
  if (session.child.exitCode === null) {
    try { await session.send({ action: 'quit' }); } catch (_) {}
    session.child.stdin.end();
  }
  return session.exited;
}

const clickVisibleButtonCode = source => `(() => {
  const re = new RegExp(${JSON.stringify(source)}, 'i');
  const b = Object.values(renderer.windows).find(w => w.visible && re.test(w.title || ''));
  return b ? instance.exports.send_message(b.parentHwnd, 0x111, 1, b.hwnd) : -1;
})()`;

async function runInnoInstaller(captureDir, installRoot, screenshotDir) {
  const metadata = JSON.parse(fs.readFileSync(path.join(captureDir, 'launch.json'), 'utf8'));
  const childExe = path.join(captureDir, ...metadata.exe.split('/'));
  const installerPng = path.join(screenshotDir, 'installer-finished.png');
  const session = startControlled([
    `--exe=${childExe}`,
    `--args=${metadata.args}`,
    `--vfs-mount=${path.join(captureDir, 'ptanks.exe')}=c:\\ptanks.exe`,
    '--screen=800x600',
    '--batch-size=200000',
    '--control-stdin',
    '--frozen',
    '--max-batches=1000000',
    '--max-seconds=300',
    '--quiet-api',
    '--quiet-blocks',
    '--no-close',
    '--no-build',
    `--save-vfs=${installRoot}`,
  ], 'pi');

  try {
    await stepTotal(session, 35);
    await session.send({ action: 'eval', code: clickVisibleButtonCode('^&?Next') });
    await stepTotal(session, 8, 8);
    const radioResult = await session.send({ action: 'eval', code: `(() => {
      const e = instance.exports;
      const radio = Object.values(renderer.windows).find(w =>
        w.visible && /accept the agreement/i.test(w.title || '') && !/not accept/i.test(w.title || ''));
      const top = Object.values(renderer.windows).find(w => w.visible && !w.isChild && w.w > 300);
      if (!radio || !top) return null;
      const x = e.wnd_window_screen_x(radio.hwnd) + 10;
      const y = e.wnd_window_screen_y(radio.hwnd) + (e.wnd_screen_h(radio.hwnd) >> 1);
      return [e.dialog_route_mouse_screen(top.hwnd, 0x201, 1, x, y),
        e.dialog_route_mouse_screen(top.hwnd, 0x202, 0, x, y)];
    })()` });
    assert(Array.isArray(radioResult) && radioResult[0] === 1 && radioResult[1] === 1,
      `Pocket Tanks license radio was not clicked: ${JSON.stringify(radioResult)}`);
    await stepTotal(session, 5, 5);

    for (let page = 0; page < 4; page++) {
      const result = await session.send({ action: 'eval',
        code: clickVisibleButtonCode('^&?Next') });
      assert(result !== -1, `Pocket Tanks setup page ${page + 1} had no advance button`);
      await stepTotal(session, 8, 8);
    }

    // Installation yields while unpacking. Dispatch this click through the
    // normal input queue so the run loop retains and resumes that continuation.
    await session.send('mousemove:515:467');
    await session.send('mousedown:515:467');
    await stepTotal(session, 1, 1);
    await session.send('mouseup:515:467');
    await stepTotal(session, 30, 10);

    let finished = false;
    for (let guard = 0; guard < 120; guard++) {
      const titles = await session.send({ action: 'eval', code:
        `Object.values(renderer.windows).filter(w => w.visible).map(w => w.title || '')` });
      if (titles.some(title => /complet|finish|installed/i.test(title))) {
        finished = true;
        break;
      }
      await stepTotal(session, 20, 10);
      await sleep(20);
    }
    if (!finished) {
      await session.send({ action: 'png', path: path.join(screenshotDir, 'installer-stalled.png') });
      const controls = await session.send({ action: 'eval', code: `Object.values(renderer.windows)
        .filter(w => w.visible).map(w => ({ hwnd: w.hwnd, parent: w.parentHwnd,
          title: w.title || '', x: w.x, y: w.y, width: w.w, height: w.h,
          id: instance.exports.ctrl_get_id ? instance.exports.ctrl_get_id(w.hwnd) : -1 }))` });
      throw new Error(`Pocket Tanks installer did not reach completion\ncontrols=${JSON.stringify(controls)}\n${session.output().slice(-8000)}`);
    }
    await session.send({ action: 'png', path: installerPng });
    const installer = imageStats(installerPng);
    assert(installer.width === 800 && installer.height === 600 && installer.colors > 20,
      `Pocket Tanks completion page was not rendered: ${installer.width}x${installer.height}, ${installer.colors} colors`);
    const code = await quitSession(session);
    assert(code === 0, `Pocket Tanks installer CLI exited ${code}\n${session.output().slice(-8000)}`);
    return installer;
  } catch (error) {
    await quitSession(session);
    throw error;
  }
}

async function runGameplay(gameExe, screenshotDir) {
  const readyPng = path.join(screenshotDir, 'offer.png');
  const menuPng = path.join(screenshotDir, 'menu.png');
  const frameAPath = path.join(screenshotDir, 'gameplay-a.png');
  const frameBPath = path.join(screenshotDir, 'gameplay-b.png');
  const session = startControlled([
    `--exe=${gameExe}`,
    '--vfs-include=**/*',
    '--screen=800x600',
    '--batch-size=200000',
    '--control-stdin',
    '--frozen',
    '--max-batches=1000000',
    '--max-seconds=300',
    '--quiet-api',
    '--quiet-blocks',
    '--no-close',
    '--no-build',
  ], 'pg');

  async function click(x, y) {
    await session.send(`mousemove:${x}:${y}`);
    await session.send(`mousedown:${x}:${y}`);
    await stepTotal(session, 2, 2);
    await session.send(`mouseup:${x}:${y}`);
    await stepTotal(session, 12, 6);
  }

  try {
    let offerReady = false;
    for (let guard = 0; guard < 20; guard++) {
      await stepTotal(session, 25);
      await session.send({ action: 'png', path: readyPng });
      const frame = imageStats(readyPng);
      if (frame.nonBlack > 100000 && frame.colors > 200) {
        offerReady = true;
        break;
      }
    }
    assert(offerReady, `Pocket Tanks offer did not finish loading\n${session.output().slice(-8000)}`);
    await click(635, 525); // Deluxe offer: Maybe Later.
    await stepTotal(session, 20, 10);
    await click(595, 565); // Title: Start.
    await stepTotal(session, 20, 10);
    await session.send({ action: 'png', path: menuPng });
    await click(400, 263); // Target Practice.
    let battlefieldReady = false;
    for (let guard = 0; guard < 20; guard++) {
      await stepTotal(session, 25);
      await session.send({ action: 'png', path: frameAPath });
      const frame = imageStats(frameAPath);
      let topRed = 0;
      for (let y = 0; y < 60; y++) {
        for (let x = 0; x < 220; x++) {
          const i = (y * frame.width + x) * 4;
          if (frame.png.data[i] > 120 && frame.png.data[i + 1] < 100 &&
              frame.png.data[i + 2] < 100) topRed++;
        }
      }
      if (topRed > 300 && frame.colors > 1000) {
        battlefieldReady = true;
        break;
      }
    }
    assert(battlefieldReady,
      `Pocket Tanks Target Practice did not finish loading\n${session.output().slice(-8000)}`);
    await click(405, 490); // Fire.
    await stepTotal(session, 20, 5);
    await session.send({ action: 'png', path: frameBPath });

    const menu = imageStats(menuPng);
    const a = imageStats(frameAPath);
    const b = imageStats(frameBPath);
    assert(menu.colors > 100 && a.colors > 100 && b.colors > 100,
      `Pocket Tanks frames lacked game art: ${menu.colors}/${a.colors}/${b.colors} colors`);
    assert(a.nonBlack > 250000 && b.nonBlack > 250000,
      `Pocket Tanks battlefield stayed blank: ${a.nonBlack}/${b.nonBlack} nonblack pixels`);
    const changed = pixelDiff(a.png, b.png);
    assert(changed > 100, `Pocket Tanks battlefield did not react: ${changed} changed pixels`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(session.output()),
      `Pocket Tanks hit a compatibility failure\n${session.output().slice(-8000)}`);
    const code = await quitSession(session);
    assert(code === 0, `Pocket Tanks game CLI exited ${code}\n${session.output().slice(-8000)}`);
    return { menu, a, b, changed, frameAPath, frameBPath };
  } catch (error) {
    await quitSession(session);
    throw error;
  }
}

async function main() {
  if (!fs.existsSync(INSTALLER)) {
    console.log('SKIP Pocket Tanks candidate: fetch with node tools/fetch-candidate-corpus.js --id=pocket-tanks-installer');
    return;
  }
  assert(sha256(INSTALLER) === INSTALLER_SHA256,
    'Pocket Tanks installer hash does not match the pinned package');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-pocket-tanks-candidate-'));
  const captureDir = path.join(temp, 'bootstrap-vfs');
  const installRoot = path.join(temp, 'installed-vfs');
  const screenshotDir = process.env.POCKET_TANKS_SCREENSHOT_DIR ||
    path.join(ROOT, 'build', 'pocket-tanks-candidate');
  fs.mkdirSync(screenshotDir, { recursive: true });

  try {
    const installedSeed = String(process.env.POCKET_TANKS_INSTALLED_ROOT || '').trim();
    if (installedSeed) {
      console.log(`Pocket Tanks stage 1/3: reusing emulator-installed VFS ${installedSeed}`);
      fs.cpSync(installedSeed, installRoot, { recursive: true });
    } else {
      console.log('Pocket Tanks stage 1/3: running original bootstrap...');
      const bootstrap = runCli([
        `--exe=${INSTALLER}`,
        '--screen=800x600',
        '--batch-size=100000',
        '--max-batches=300',
        '--max-seconds=90',
        '--quiet-api',
        '--quiet-blocks',
        '--no-build',
        `--capture-launch=${captureDir}`,
      ]);
      assert(/\[capture-launch\] snapshotted .*\.tmp/i.test(bootstrap),
        `Pocket Tanks bootstrap did not emit its Inno child\n${bootstrap.slice(-5000)}`);

      console.log('Pocket Tanks stage 2/3: running captured Inno child...');
      const installer = await runInnoInstaller(captureDir, installRoot, screenshotDir);
      console.log(`PASS installer: ${installer.width}x${installer.height}, ${installer.colors} colors`);
    }

    const gameExe = findFile(installRoot, 'pockettanks.exe');
    const loaderExe = findFile(installRoot, 'ptloader.exe');
    assert(gameExe && fs.statSync(gameExe).size > 500000,
      'Pocket Tanks installer omitted pockettanks.exe');
    assert(loaderExe && fs.statSync(loaderExe).size > 10000,
      'Pocket Tanks installer omitted ptloader.exe');
    if (process.env.PREPARE_POCKET_TANKS_DEBUG_WEB === '1') {
      prepareDebugWeb(path.dirname(gameExe));
      console.log(`prepared debug web payload: ${path.relative(ROOT, DEBUG_WEB_DIR)}`);
    }

    console.log('Pocket Tanks stage 3/3: driving frozen Target Practice...');
    const gameplay = await runGameplay(gameExe, screenshotDir);
    console.log(`PASS gameplay: ${gameplay.a.colors}/${gameplay.b.colors} colors, ${gameplay.changed} changed pixels`);
    console.log(`PASS screenshots: ${gameplay.frameAPath} ${gameplay.frameBPath}`);
    console.log('Pocket Tanks candidate: PASS 3/3');
  } finally {
    if (process.env.KEEP_POCKET_TANKS_CANDIDATE_TMP === '1') {
      console.log(`kept candidate artifacts: ${temp}`);
    } else {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(`FAIL Pocket Tanks candidate: ${error.stack || error.message}`);
  process.exit(1);
});
