#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');
const { startControlSession } = require('./control-session');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const CANDIDATE_ROOT = path.join(__dirname, 'binaries', 'candidates', 'snood');
const INSTALLER = path.join(CANDIDATE_ROOT, 'SnoodWin22Install.exe');
const DEBUG_WEB_DIR = path.join(CANDIDATE_ROOT, 'installed');
const INSTALLER_SHA256 = 'af87ef644d2a8d5a99f160ac522a7d318b0dc378285fd337c53dbf41c70db4ea';
const GAME_SHA256 = 'af45b6e77e95a20b26813f2e1a91bdc51cee2ad98b724d66288755f171b47bbd';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function assert(condition, message) { if (!condition) throw new Error(message); }
function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
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
  assert(a.width === b.width && a.height === b.height, 'Snood frame sizes differ');
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

function findFile(root, basename) {
  const lower = basename.toLowerCase();
  const relative = walkFiles(root).find(file => path.basename(file).toLowerCase() === lower);
  return relative ? path.join(root, relative) : null;
}

function prepareDebugWeb(installDir) {
  fs.rmSync(DEBUG_WEB_DIR, { recursive: true, force: true });
  fs.cpSync(installDir, DEBUG_WEB_DIR, { recursive: true });
  const files = walkFiles(DEBUG_WEB_DIR).sort((a, b) => a.localeCompare(b)).map(relative => ({
    url: relative.split(path.sep).join('/'),
    vfsPath: `c:\\${relative.split(path.sep).join('\\')}`,
  }));
  fs.writeFileSync(path.join(DEBUG_WEB_DIR, '.wine-assembly-browser.json'),
    `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`);
}

function startControlled(args, prefix) {
  return startControlSession([RUN, ...args], { cwd: ROOT, idPrefix: prefix });
}

async function stepTotal(session, count, chunk = 8) {
  let remaining = count;
  while (remaining > 0) {
    const n = Math.min(chunk, remaining);
    const reply = await session.send({ action: 'step', n });
    assert(reply.ran === n,
      `requested ${n} Snood steps but ran ${reply.ran}: ${JSON.stringify(reply)}\n${session.output().slice(-8000)}`);
    remaining -= n;
    if (remaining) await sleep(10);
  }
}

async function quitSession(session) {
  return session.quit();
}

async function clickDialogButton(session, titlePattern, id, steps = 8) {
  const clicked = await session.send({ action: 'eval', code: `(() => {
    const re = new RegExp(${JSON.stringify(titlePattern)}, 'i');
    const parent = Object.values(renderer.windows).find(w => w.visible && re.test(w.title || ''));
    return parent ? instance.exports.click_dialog_control(parent.hwnd, ${id}) : 0;
  })()` });
  assert(clicked === 1,
    `no visible Snood dialog/button matched /${titlePattern}/i id=${id}\n${session.output().slice(-8000)}`);
  await stepTotal(session, steps);
}

async function runBootstrap(captureDir) {
  const session = startControlled([
    `--exe=${INSTALLER}`, '--screen=800x600', '--batch-size=100000',
    '--control-stdin', '--frozen', '--max-batches=1000000', '--max-seconds=90',
    '--quiet-api', '--quiet-blocks', '--no-build',
  ], 'sb');
  try {
    await stepTotal(session, 3, 3);
    await clickDialogButton(session, '^Setup$', 6, 0); // IDYES
    let captured = false;
    for (let guard = 0; guard < 30 && session.child.exitCode === null; guard++) {
      try { await stepTotal(session, 1, 1); } catch (error) {
        if (session.child.exitCode === null) throw error;
        break;
      }
      if (!captured && /\[ShellExecute\].*\.tmp\s+\/SL2/i.test(session.output())) {
        const rows = await session.send({ action: 'eval', code: `(() => {
          const save = process.mainModule.require(${JSON.stringify(path.join(ROOT, 'lib', 'vfs-export.js'))}).saveVfsToHost;
          return save(ctx.vfs, ${JSON.stringify(captureDir)}).map(row => row.outputPath);
        })()` });
        captured = rows.some(file => /^ins\d+\.tmp$/i.test(path.basename(file)));
      }
    }
    const code = await session.exited;
    assert(code === 0, `Snood bootstrap CLI exited ${code}\n${session.output().slice(-8000)}`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(session.output()),
      `Snood bootstrap hit a compatibility failure\n${session.output().slice(-8000)}`);
    const childRelative = walkFiles(captureDir).find(file => /^ins\d+\.tmp$/i.test(path.basename(file)));
    const launch = session.output().match(/\[ShellExecute\].*file="[^"\r\n]*?\.tmp\s+([^"\r\n]+?)\s*"/i);
    assert(captured && childRelative && launch,
      `Snood bootstrap did not preserve its Inno child/arguments\n${session.output().slice(-8000)}`);
    return { output: session.output(), childExe: path.join(captureDir, childRelative), args: launch[1] };
  } catch (error) {
    await quitSession(session);
    throw error;
  }
}

async function runInstaller(bootstrap, installRoot, screenshotDir) {
  const screenshot = path.join(screenshotDir, 'installer-finished.png');
  const session = startControlled([
    `--exe=${bootstrap.childExe}`, `--args=${bootstrap.args}`,
    `--vfs-mount=${INSTALLER}=c:\\SnoodWin22Install.exe`,
    '--screen=800x600', '--batch-size=500000',
    '--control-stdin', '--frozen', '--max-batches=1000000', '--max-seconds=300',
    '--quiet-api', '--quiet-blocks', '--no-close', '--no-build', `--save-vfs=${installRoot}`,
  ], 'si');
  try {
    await stepTotal(session, 10);
    for (let page = 0; page < 4; page++) {
      await session.send('click:475:443');
      await stepTotal(session, 8);
    }

    let completed = false;
    for (let guard = 0; guard < 60; guard++) {
      const titles = await session.send({ action: 'eval', code:
        `Object.values(renderer.windows).filter(w => w.visible).map(w => w.title || '')` });
      if (titles.some(title => /Setup Completed/i.test(title))) {
        completed = true;
        break;
      }
      await stepTotal(session, 5, 5);
    }
    assert(completed, `Snood installer did not reach Setup Completed\n${session.output().slice(-8000)}`);
    await session.send({ action: 'png', path: screenshot });
    const frame = imageStats(screenshot);
    assert(frame.width === 800 && frame.height === 600 && frame.colors > 20,
      `Snood completion page was not rendered: ${frame.colors} colors`);

    await session.send('click:340:256');
    await stepTotal(session, 2, 2);
    await session.send('click:475:443');
    try { await stepTotal(session, 4, 1); } catch (_) {}
    const code = await session.exited;
    assert(code === 0, `Snood installer CLI exited ${code}\n${session.output().slice(-8000)}`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(session.output()),
      `Snood installer hit a compatibility failure\n${session.output().slice(-8000)}`);
    return frame;
  } catch (error) {
    await quitSession(session);
    throw error;
  }
}

async function runGameplay(gameExe, screenshotDir) {
  const menuPath = path.join(screenshotDir, 'menu.png');
  const frameAPath = path.join(screenshotDir, 'gameplay-a.png');
  const frameBPath = path.join(screenshotDir, 'gameplay-b.png');
  const session = startControlled([
    `--exe=${gameExe}`, '--vfs-include=*', '--screen=800x600', '--batch-size=500000',
    '--control-stdin', '--frozen', '--max-batches=1000000', '--max-seconds=180',
    '--quiet-api', '--quiet-blocks', '--no-close', '--no-build',
  ], 'sg');
  try {
    await stepTotal(session, 3, 3);
    await clickDialogButton(session, '^Please Register Snood!$', 2, 5);
    await clickDialogButton(session, '^Please Try out Gator', 2, 8);
    await session.send({ action: 'png', path: menuPath });
    const menu = imageStats(menuPath);
    assert(menu.width === 800 && menu.height === 600 && menu.colors > 100 && menu.nonBlack > 300000,
      `Snood title screen did not render: ${menu.colors} colors, ${menu.nonBlack} nonblack pixels`);

    const origin = await session.send({ action: 'eval', code: `(() => {
      const w = Object.values(renderer.windows).find(row => row.visible && /^Snood$/.test(row.title || ''));
      return w ? [instance.exports.wnd_window_screen_x(w.hwnd),
        instance.exports.wnd_window_screen_y(w.hwnd)] : null;
    })()` });
    assert(Array.isArray(origin), 'Snood main window disappeared before gameplay');
    await session.send(`click:${origin[0] + 297}:${origin[1] + 240}`);
    await stepTotal(session, 10);
    await session.send({ action: 'png', path: frameAPath });
    await session.send(`click:${origin[0] + 300}:${origin[1] + 250}`);
    await stepTotal(session, 30, 10);
    await session.send({ action: 'png', path: frameBPath });

    const a = imageStats(frameAPath);
    const b = imageStats(frameBPath);
    assert(a.colors > 100 && b.colors > 100 && a.nonBlack > 300000 && b.nonBlack > 300000,
      `Snood gameplay art was incomplete: ${a.colors}/${b.colors} colors`);
    const changed = pixelDiff(a.png, b.png);
    assert(changed > 2000, `Snood shot did not advance gameplay: ${changed} changed pixels`);
    const audio = await session.send({ action: 'eval', code: `(() => {
      const shared = ctx.sharedAudio;
      const voices = shared && shared.voices && shared.voices._map;
      const rows = voices ? Object.values(voices) : [];
      return { voices: rows.length,
        bytes: rows.reduce((sum, voice) => sum + (voice.snapshotBytes || voice.bytesWritten || 0), 0) };
    })()` });
    assert(audio.voices > 0 && audio.bytes > 0,
      `Snood did not submit DirectSound audio: ${JSON.stringify(audio)}`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(session.output()),
      `Snood gameplay hit a compatibility failure\n${session.output().slice(-8000)}`);
    const code = await quitSession(session);
    assert(code === 0, `Snood game CLI exited ${code}\n${session.output().slice(-8000)}`);
    return { a, b, changed, audio, frameAPath, frameBPath };
  } catch (error) {
    await quitSession(session);
    throw error;
  }
}

async function main() {
  const seed = String(process.env.SNOOD_INSTALLED_ROOT || '').trim();
  if (!fs.existsSync(INSTALLER) && !seed) {
    console.log('SKIP Snood candidate: fetch with node tools/fetch-candidate-corpus.js --id=snood');
    return;
  }
  if (fs.existsSync(INSTALLER)) {
    assert(sha256(INSTALLER) === INSTALLER_SHA256, 'Snood installer hash mismatch');
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-snood-candidate-'));
  const captureDir = path.join(temp, 'bootstrap-vfs');
  const installRoot = path.join(temp, 'installed-vfs');
  const screenshotDir = process.env.SNOOD_SCREENSHOT_DIR || path.join(ROOT, 'build', 'snood-candidate');
  fs.mkdirSync(screenshotDir, { recursive: true });
  try {
    if (seed) {
      console.log(`Snood stage 1/2: reusing emulator-installed VFS ${seed}`);
      fs.cpSync(seed, installRoot, { recursive: true });
    } else {
      console.log('Snood stage 1/2: running original bootstrap and installer...');
      const bootstrap = await runBootstrap(captureDir);
      const installer = await runInstaller(bootstrap, installRoot, screenshotDir);
      console.log(`PASS installer: ${installer.width}x${installer.height}, ${installer.colors} colors`);
    }

    const gameExe = findFile(installRoot, 'snood.exe');
    const readme = findFile(installRoot, 'snood 2.2 readme (text).txt');
    assert(gameExe && sha256(gameExe) === GAME_SHA256, 'Snood installed game hash mismatch');
    assert(readme && /demonstration version[\s\S]*more than 30 days[\s\S]*register or\s+delete/i.test(
      fs.readFileSync(readme, 'latin1')), 'Snood installed readme omitted its trial terms');
    if (process.env.PREPARE_SNOOD_DEBUG_WEB === '1') prepareDebugWeb(path.dirname(gameExe));

    console.log('Snood stage 2/2: driving frozen gameplay...');
    const gameplay = await runGameplay(gameExe, screenshotDir);
    console.log(`PASS gameplay: ${gameplay.a.colors}/${gameplay.b.colors} colors, ${gameplay.changed} changed pixels`);
    console.log(`PASS audio: ${gameplay.audio.voices} voices, ${gameplay.audio.bytes} submitted bytes`);
    console.log(`PASS screenshots: ${gameplay.frameAPath} ${gameplay.frameBPath}`);
    console.log('Snood candidate: PASS 2/2');
  } finally {
    if (process.env.KEEP_SNOOD_CANDIDATE_TMP === '1') console.log(`kept candidate artifacts: ${temp}`);
    else fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL Snood candidate: ${error.stack || error.message}`);
  process.exit(1);
});
