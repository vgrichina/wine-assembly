#!/usr/bin/env node

'use strict';

// Run the original Broken Sword demo setup launcher and the configuration
// program it starts. The host publishes only files written by the guest
// installer after the authentic two-stage flow completes.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startControlSession } = require('../test/control-session');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(ROOT, 'test', 'run.js');
const PACKAGE = path.join(ROOT, 'test', 'binaries', 'win98-games-a-d',
  'Broken_Sword_demo-SW');
const DEFAULT_INSTALLER = path.join(PACKAGE, 'SETUP.EXE');
const DEFAULT_OUTPUT = path.join(PACKAGE, 'installed');
const INSTALLER_SHA256 = '091ad0e2e8f1f49f6c2cb69067c7c0b7c7d75f3255ab227b6ef17152bb6f40ae';
const CONFIG_SHA256 = '2f67c74ce3ce737383c6481e5e50ac47de682f670383f8d385d9d6abfe4da439';
const GAME_SHA256 = '8ca6e3f0c56e1f289f79e2d52ca8cd98466c5b5c2817b3d05b7f7d80425c4177';
const INSTALLED_GUEST_ROOT = 'c:\\sword';

function getArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find(arg => arg.startsWith(prefix));
  return value ? path.resolve(value.slice(prefix.length)) : fallback;
}

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

async function stepTotal(session, count, chunk = 5) {
  let remaining = count;
  while (remaining > 0) {
    const n = Math.min(chunk, remaining);
    const reply = await session.send({ action: 'step', n });
    assert.strictEqual(reply.ran, n,
      `requested ${n} frozen steps, ran ${reply.ran}\n${session.output().slice(-8000)}`);
    remaining -= n;
  }
}

async function waitFor(session, description, predicate, attempts = 40, steps = 5) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await predicate();
    if (value) return value;
    await stepTotal(session, steps);
  }
  throw new Error(`Broken Sword installer did not reach ${description}\n${session.output().slice(-12000)}`);
}

async function waitForTitle(session, pattern, attempts = 40) {
  return waitFor(session, `window ${pattern}`, async () => {
    const snapshot = await session.send({ action: 'snapshot' });
    return snapshot.windows.find(win => win.visible && pattern.test(win.title || '')) || null;
  }, attempts);
}

async function pressReturn(session, settleSteps = 15) {
  await session.send('keypress:13');
  await stepTotal(session, settleSteps);
}

async function chooseHighResolution(session) {
  // GAMECFIG uses DirectInput and draws its own pointer. Moving to this canvas
  // coordinate places that pointer over the High Resolution selector.
  await session.send('mousemove:78:411');
  await stepTotal(session, 5);
  await session.send('mousedown:78:411');
  await session.send('di-mousedown:1');
  await stepTotal(session, 10);
  await session.send('mouseup:78:411');
  await session.send('di-mouseup:1');
  await stepTotal(session, 15);
}

async function runBootstrap(installer, captureRoot, wasm) {
  const args = [
    RUN,
    `--exe=${installer}`,
    '--vfs-include=**/*',
    '--screen=800x600',
    '--batch-size=100000',
    '--tick-ms-per-batch=1000',
    '--max-batches=1000000',
    '--max-seconds=90',
    '--quiet-api',
    '--quiet-blocks',
    '--no-build',
    '--no-close',
    '--control-stdin',
    '--frozen',
    `--capture-launch=${captureRoot}`,
  ];
  if (wasm) args.push(`--wasm=${wasm}`);
  const session = startControlSession(args, { cwd: ROOT, idPrefix: 'bsb-' });

  try {
    await waitForTitle(session, /^Install$/i, 25);
    await session.send('dlg-click:1');
    await waitFor(session, 'the launched configuration program', async () => {
      const snapshot = await session.send({ action: 'snapshot' });
      return snapshot.yieldReason === 7;
    }, 30, 1);
    const code = await session.quit();
    assert.strictEqual(code, 0,
      `Broken Sword setup launcher exited ${code}\n${session.output().slice(-8000)}`);
  } catch (error) {
    await session.quit({ ignoreReplyError: true });
    throw error;
  }

  const metadata = JSON.parse(fs.readFileSync(path.join(captureRoot, 'launch.json'), 'utf8'));
  assert.strictEqual(metadata.schemaVersion, 1);
  assert.match(metadata.guestExe, /\\gamecfig\.exe$/i,
    `unexpected setup child: ${metadata.guestExe}`);
  const child = path.join(captureRoot, ...metadata.exe.split('/'));
  assert.strictEqual(sha256(child), CONFIG_SHA256,
    'SETUP.EXE launched an unexpected GAMECFIG.EXE');
  assert(fs.existsSync(path.join(captureRoot, 'install', 'test.smk')),
    'setup capture omitted the original recursive installation media');
  return { metadata, child };
}

async function runInstaller(captureRoot, bootstrap, installVfs, completionPng, wasm) {
  const mfc = path.join(captureRoot, 'mfc40.dll');
  assert(fs.existsSync(mfc), 'setup capture omitted MFC40.DLL');
  const requiredGuestFiles = [
    `${INSTALLED_GUEST_ROOT}\\winsword.exe`,
    `${INSTALLED_GUEST_ROOT}\\sword.inf`,
    `${INSTALLED_GUEST_ROOT}\\clusters\\scripts.clu`,
    `${INSTALLED_GUEST_ROOT}\\clusters\\paris1.clu`,
  ];

  const args = [
    RUN,
    `--exe=${bootstrap.child}`,
    `--exe-guest-path=${bootstrap.metadata.guestExe}`,
    `--vfs-tree=${captureRoot}`,
    `--cwd=${bootstrap.metadata.directory || 'C:\\'}`,
    `--dll-seed=${mfc}`,
    '--screen=800x600',
    '--batch-size=100000',
    '--tick-ms-per-batch=1000',
    '--max-batches=1000000',
    '--max-seconds=420',
    '--repaint-every=10',
    '--quiet-api',
    '--quiet-blocks',
    '--no-build',
    '--no-close',
    '--control-stdin',
    '--frozen',
    `--save-vfs=${installVfs}`,
  ];
  if (wasm) args.push(`--wasm=${wasm}`);
  const session = startControlSession(args, { cwd: ROOT, idPrefix: 'bsi-' });

  try {
    await waitForTitle(session, /^Broken Sword Demo installation$/i, 40);
    await session.send('dlg-click:1');

    // Let the original video/system check finish and reach its first menu.
    await stepTotal(session, 420);
    await chooseHighResolution(session);

    // Destination Drive, Destination Directory, Installation Type, and
    // Confirm Selection all accept their displayed defaults with Return.
    await pressReturn(session, 20);
    await pressReturn(session, 20);
    await pressReturn(session, 20);
    await pressReturn(session, 20);

    const installed = await waitFor(session, 'the installed demo payload', () =>
      session.send({ action: 'eval', code:
        `${JSON.stringify(requiredGuestFiles)}.every(file => ctx.vfs.files.has(file))` }), 100, 3);
    assert(installed, 'the guest installer did not write the complete demo payload');

    await waitForTitle(session, /^Broken Sword Demo$/i, 30);

    if (completionPng) {
      fs.mkdirSync(path.dirname(completionPng), { recursive: true });
      await session.send({ action: 'png', path: completionPng });
    }
    const code = await session.quit();
    assert.strictEqual(code, 0,
      `Broken Sword installer exited ${code}\n${session.output().slice(-8000)}`);
    assert(!/Not enough disk space|UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError:/i.test(session.output()),
      `Broken Sword installer hit a compatibility failure\n${session.output().slice(-12000)}`);
  } catch (error) {
    const detail = session.output().slice(-12000);
    await session.quit({ ignoreReplyError: true });
    throw new Error(`${error.message}\n${detail}`);
  }
}

function publishInstall(installVfs, output) {
  const installed = path.join(installVfs, 'sword');
  const game = path.join(installed, 'winsword.exe');
  assert(fs.existsSync(game), 'guest installer output omitted WINSWORD.EXE');
  assert.strictEqual(sha256(game), GAME_SHA256,
    'installed WINSWORD.EXE does not match the tested demo');
  for (const file of ['sword.inf', 'clusters/scripts.clu', 'clusters/paris1.clu']) {
    assert(fs.existsSync(path.join(installed, file)), `guest installer output omitted ${file}`);
  }

  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.cpSync(installed, output, { recursive: true });
}

async function main() {
  const installer = getArg('installer', DEFAULT_INSTALLER);
  const output = getArg('output', DEFAULT_OUTPUT);
  const completionPng = getArg('screenshot');
  const reusedCapture = getArg('capture');
  const wasm = getArg('wasm');
  assert(fs.existsSync(installer), `Broken Sword installer is missing: ${installer}`);
  assert.strictEqual(sha256(installer), INSTALLER_SHA256,
    'Broken Sword installer does not match the pinned original package');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-broken-sword-installer-'));
  const captureRoot = reusedCapture || path.join(temp, 'package-vfs');
  const installVfs = path.join(temp, 'installed-vfs');
  try {
    let bootstrap;
    if (reusedCapture) {
      console.log(`Broken Sword install 1/2: reusing captured SETUP.EXE VFS ${captureRoot}`);
      const metadata = JSON.parse(fs.readFileSync(path.join(captureRoot, 'launch.json'), 'utf8'));
      const child = path.join(captureRoot, ...metadata.exe.split('/'));
      assert.strictEqual(sha256(child), CONFIG_SHA256,
        'captured GAMECFIG.EXE hash mismatch');
      bootstrap = { metadata, child };
    } else {
      console.log('Broken Sword install 1/2: running original SETUP.EXE...');
      bootstrap = await runBootstrap(installer, captureRoot, wasm);
    }

    console.log('Broken Sword install 2/2: driving GAMECFIG.EXE and INSTALL.EXE...');
    await runInstaller(captureRoot, bootstrap, installVfs, completionPng, wasm);
    publishInstall(installVfs, output);
    console.log(`PASS  authentic Broken Sword demo installed to ${output}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL  Broken Sword demo installer: ${error.stack || error.message}`);
  process.exit(1);
});
