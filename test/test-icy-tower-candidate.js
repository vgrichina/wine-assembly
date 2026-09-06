#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');
const { startControlSession } = require('./control-session');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const CANDIDATE_ROOT = path.join(__dirname, 'binaries', 'candidates', 'icy-tower');
const INSTALLER = path.join(CANDIDATE_ROOT, 'icytower13_install.exe');
const DEBUG_WEB_DIR = path.join(CANDIDATE_ROOT, 'installed');
const INSTALLER_SHA256 = 'e8a6ddc8a11d49b1e68484f725afc9204d9d15e0bf6cf90f0b14f0d1c9d24302';
const GAME_SHA256 = 'e139648070ec1de00c7cbb135db664dd725c1cdb6d2ecad3108b8b9f906cf4de';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function assert(condition, message) { if (!condition) throw new Error(message); }
function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function runCli(args) {
  const result = spawnSync('node', [RUN, ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.error) throw result.error;
  assert(result.status === 0, `Icy Tower bootstrap CLI exited ${result.status}\n${output.slice(-8000)}`);
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
  assert(a.width === b.width && a.height === b.height, 'Icy Tower frame sizes differ');
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

async function stepTotal(session, count, chunk = 5) {
  let remaining = count;
  while (remaining > 0) {
    const n = Math.min(chunk, remaining);
    const reply = await session.send({ action: 'step', n });
    assert(reply.ran === n,
      `requested ${n} Icy Tower steps but ran ${reply.ran}: ${JSON.stringify(reply)}\n${session.output().slice(-8000)}`);
    remaining -= n;
    if (remaining) await sleep(20);
  }
}

async function quitSession(session) {
  return session.quit();
}

const clickButtonCode = source => `(() => {
  const re = new RegExp(${JSON.stringify(source)}, 'i');
  const b = Object.values(renderer.windows).find(w => w.visible && re.test(w.title || ''));
  return b ? instance.exports.send_message(b.parentHwnd, 0x111, 1, b.hwnd) : -1;
})()`;

async function runInstaller(captureDir, installRoot, screenshotDir) {
  const metadata = JSON.parse(fs.readFileSync(path.join(captureDir, 'launch.json'), 'utf8'));
  const childExe = path.join(captureDir, ...metadata.exe.split('/'));
  const screenshot = path.join(screenshotDir, 'installer-finished.png');
  const session = startControlled([
    `--exe=${childExe}`, `--args=${metadata.args}`,
    `--vfs-mount=${path.join(captureDir, 'icytower13_install.exe')}=c:\\icytower13_install.exe`,
    '--screen=800x600', '--batch-size=200000',
    '--control-stdin', '--frozen', '--max-batches=1000000', '--max-seconds=300',
    '--quiet-api', '--quiet-blocks', '--no-close', '--no-build', `--save-vfs=${installRoot}`,
  ], 'ii');
  try {
    await stepTotal(session, 40);
    for (let page = 0; page < 5; page++) {
      const result = await session.send({ action: 'eval', code: clickButtonCode('Next') });
      assert(result !== -1, `Icy Tower setup page ${page + 1} had no Next button`);
      await stepTotal(session, 8, 8);
    }
    const installPoint = await session.send({ action: 'eval', code: `(() => {
      const e = instance.exports;
      const b = Object.values(renderer.windows).find(w => w.visible && /^(?:&?Install|&?Next)/i.test(w.title || ''));
      return b ? [e.wnd_window_screen_x(b.hwnd) + (e.wnd_screen_w(b.hwnd) >> 1),
        e.wnd_window_screen_y(b.hwnd) + (e.wnd_screen_h(b.hwnd) >> 1)] : null;
    })()` });
    if (!Array.isArray(installPoint)) {
      await session.send({ action: 'png', path: path.join(screenshotDir, 'installer-ready.png') });
      const controls = await session.send({ action: 'eval', code:
        `Object.values(renderer.windows).filter(w => w.visible).map(w =>
          ({ title: w.title || '', x: w.x, y: w.y, width: w.w, height: w.h, parent: w.parentHwnd }))` });
      throw new Error(`Icy Tower ready page had no Install button: ${JSON.stringify(controls)}`);
    }
    await session.send(`mousemove:${installPoint[0]}:${installPoint[1]}`);
    await session.send(`mousedown:${installPoint[0]}:${installPoint[1]}`);
    await stepTotal(session, 1, 1);
    await session.send(`mouseup:${installPoint[0]}:${installPoint[1]}`);
    await stepTotal(session, 30, 10);

    let installed = false;
    for (let guard = 0; guard < 120; guard++) {
      const titles = await session.send({ action: 'eval', code:
        `Object.values(renderer.windows).filter(w => w.visible).map(w => w.title || '')` });
      if (titles.filter(title => /when you are ready to continue/i.test(title)).length >= 2) {
        installed = true;
        break;
      }
      await stepTotal(session, 20, 10);
    }
    assert(installed, `Icy Tower installer did not finish extraction\n${session.output().slice(-8000)}`);
    await session.send({ action: 'eval', code: clickButtonCode('Next') });
    await stepTotal(session, 10, 5);
    await session.send({ action: 'png', path: screenshot });
    const frame = imageStats(screenshot);
    assert(frame.width === 800 && frame.height === 600 && frame.colors > 20,
      `Icy Tower completion page was not rendered: ${frame.colors} colors`);
    const code = await quitSession(session);
    assert(code === 0, `Icy Tower installer CLI exited ${code}\n${session.output().slice(-8000)}`);
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
    `--exe=${gameExe}`, '--vfs-include=**/*', '--screen=640x480', '--batch-size=200000',
    '--control-stdin', '--frozen', '--max-batches=1000000', '--max-seconds=300',
    '--quiet-api', '--quiet-blocks', '--no-close', '--no-build',
  ], 'ig');
  const pulse = async vk => {
    await session.send(`keydown:${vk}`);
    await stepTotal(session, 3, 3);
    await session.send(`keyup:${vk}`);
    await stepTotal(session, 8, 4);
  };
  try {
    await stepTotal(session, 300);
    await session.send({ action: 'png', path: menuPath });
    const menu = imageStats(menuPath);
    assert(menu.width === 640 && menu.height === 480 && menu.colors > 40 && menu.nonBlack > 250000,
      `Icy Tower title menu did not render: ${menu.colors} colors, ${menu.nonBlack} nonblack pixels`);
    await pulse(32); // Start Game, documented Space control.
    await stepTotal(session, 80);
    await session.send({ action: 'png', path: frameAPath });
    await session.send('keydown:39');
    await stepTotal(session, 20, 5);
    await session.send('keyup:39');
    await stepTotal(session, 10, 5);
    await session.send({ action: 'png', path: frameBPath });
    const a = imageStats(frameAPath);
    const b = imageStats(frameBPath);
    assert(a.colors > 40 && b.colors > 40 && a.nonBlack > 250000 && b.nonBlack > 250000,
      `Icy Tower gameplay art was incomplete: ${a.colors}/${b.colors} colors`);
    const changed = pixelDiff(a.png, b.png);
    assert(changed > 1000, `Icy Tower gameplay did not advance after movement: ${changed} pixels`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(session.output()),
      `Icy Tower hit a compatibility failure\n${session.output().slice(-8000)}`);
    const code = await quitSession(session);
    assert(code === 0, `Icy Tower game CLI exited ${code}\n${session.output().slice(-8000)}`);
    return { a, b, changed, frameAPath, frameBPath };
  } catch (error) {
    await quitSession(session);
    throw error;
  }
}

async function main() {
  if (!fs.existsSync(INSTALLER)) {
    console.log('SKIP Icy Tower candidate: fetch with node tools/fetch-candidate-corpus.js --id=icy-tower');
    return;
  }
  assert(sha256(INSTALLER) === INSTALLER_SHA256, 'Icy Tower installer hash mismatch');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-icy-tower-candidate-'));
  const captureDir = path.join(temp, 'bootstrap-vfs');
  const installRoot = path.join(temp, 'installed-vfs');
  const screenshotDir = process.env.ICY_TOWER_SCREENSHOT_DIR ||
    path.join(ROOT, 'build', 'icy-tower-candidate');
  fs.mkdirSync(screenshotDir, { recursive: true });
  try {
    const seed = String(process.env.ICY_TOWER_INSTALLED_ROOT || '').trim();
    if (seed) {
      console.log(`Icy Tower stage 1/2: reusing emulator-installed VFS ${seed}`);
      fs.cpSync(seed, installRoot, { recursive: true });
    } else {
      console.log('Icy Tower stage 1/2: running original bootstrap and installer...');
      const bootstrap = runCli([
        `--exe=${INSTALLER}`, '--screen=800x600', '--batch-size=100000',
        '--max-batches=300', '--max-seconds=90', '--quiet-api', '--quiet-blocks',
        '--no-build', `--capture-launch=${captureDir}`,
      ]);
      assert(/\[capture-launch\] snapshotted .*\.tmp/i.test(bootstrap),
        `Icy Tower bootstrap did not emit its Inno child\n${bootstrap.slice(-5000)}`);
      const installer = await runInstaller(captureDir, installRoot, screenshotDir);
      console.log(`PASS installer: ${installer.width}x${installer.height}, ${installer.colors} colors`);
    }
    const gameExe = findFile(installRoot, 'icytower13.exe');
    const readme = findFile(installRoot, 'readme.txt');
    assert(gameExe && sha256(gameExe) === GAME_SHA256, 'Icy Tower installed game hash mismatch');
    assert(readme && /encouraged to distribute this game[\s\S]*original form/i.test(
      fs.readFileSync(readme, 'latin1')), 'Icy Tower installed readme omitted distribution terms');
    if (process.env.PREPARE_ICY_TOWER_DEBUG_WEB === '1') prepareDebugWeb(path.dirname(gameExe));
    console.log('Icy Tower stage 2/2: driving frozen gameplay...');
    const gameplay = await runGameplay(gameExe, screenshotDir);
    console.log(`PASS gameplay: ${gameplay.a.colors}/${gameplay.b.colors} colors, ${gameplay.changed} changed pixels`);
    console.log(`PASS screenshots: ${gameplay.frameAPath} ${gameplay.frameBPath}`);
    console.log('Icy Tower candidate: PASS 2/2');
  } finally {
    if (process.env.KEEP_ICY_TOWER_CANDIDATE_TMP === '1') console.log(`kept candidate artifacts: ${temp}`);
    else fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL Icy Tower candidate: ${error.stack || error.message}`);
  process.exit(1);
});
