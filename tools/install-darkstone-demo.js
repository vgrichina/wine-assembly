#!/usr/bin/env node

'use strict';

// Run the original Darkstone demo bootstrap and the InstallShield engine it
// emits. The host only copies files after the guest installer has written them.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startControlSession } = require('../test/control-session');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(ROOT, 'test', 'run.js');
const PACKAGE = path.join(ROOT, 'test', 'binaries', 'win98-games-a-d',
  'DarkstoneDemo-D3D');
const DEFAULT_INSTALLER = path.join(PACKAGE, 'Setup.exe');
const DEFAULT_OUTPUT = path.join(PACKAGE, 'installed');
const INSTALLER_SHA256 = 'a6d2f8b9173fd43f03aabff0b8cc3fadbd0b15224bcbe5f562a32158a297b502';
const ENGINE_SHA256 = 'c9d2bee521bc3d8037b164c9468b145646fc556a6969acf83f5556e4b295fc79';
const GAME_SHA256 = 'b43db5e1b835eb1e93688a1f3f1d9c814517be6fc8110c7fb6e024d467ee721b';
const INSTALLED_GUEST_ROOT = 'c:\\program files\\delphinesoft\\darkstone demo';

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
  throw new Error(`Darkstone installer did not reach ${description}\n${session.output().slice(-12000)}`);
}

async function waitForTitle(session, pattern, attempts = 40) {
  return waitFor(session, `window ${pattern}`, async () => {
    const snapshot = await session.send({ action: 'snapshot' });
    return snapshot.windows.find(win => win.visible && pattern.test(win.title || '')) || null;
  }, attempts);
}

async function clickNext(session) {
  await session.send('dlg-click:1');
  await stepTotal(session, 1, 1);
}

async function runBootstrap(installer, captureRoot) {
  const session = startControlSession([
    RUN,
    `--exe=${installer}`,
    '--vfs-include=**/*',
    '--screen=800x600',
    '--batch-size=100000',
    '--tick-ms-per-batch=100',
    '--max-batches=1000000',
    '--max-seconds=180',
    '--quiet-api',
    '--quiet-blocks',
    '--no-build',
    '--no-close',
    '--control-stdin',
    '--frozen',
    `--capture-launch=${captureRoot}`,
  ], { cwd: ROOT, idPrefix: 'dsb-' });

  try {
    await waitFor(session, 'the emitted InstallShield child', async () => {
      const snapshot = await session.send({ action: 'snapshot' });
      return snapshot.yieldReason === 7;
    }, 30);
    const code = await session.quit();
    assert.strictEqual(code, 0,
      `Darkstone bootstrap exited ${code}\n${session.output().slice(-8000)}`);
  } catch (error) {
    await session.quit({ ignoreReplyError: true });
    throw error;
  }

  const metadata = JSON.parse(fs.readFileSync(path.join(captureRoot, 'launch.json'), 'utf8'));
  assert.strictEqual(metadata.schemaVersion, 1);
  assert.match(metadata.guestExe, /\\_ins\d+\._mp$/i,
    `unexpected InstallShield child: ${metadata.guestExe}`);
  const child = path.join(captureRoot, ...metadata.exe.split('/'));
  assert.strictEqual(sha256(child), ENGINE_SHA256,
    'Setup.exe emitted an unexpected InstallShield engine');
  assert(fs.existsSync(path.join(captureRoot, 'data', 'dvoices1.mtf')),
    'bootstrap capture omitted the original recursive data directory');
  return { metadata, child };
}

async function runInstaller(captureRoot, bootstrap, installVfs, completionPng) {
  const childDir = path.dirname(bootstrap.child);
  const zdata = path.join(childDir, 'zdatai51.dll');
  const utility = path.join(childDir, '_wutl951.dll');
  assert(fs.existsSync(zdata) && fs.existsSync(utility),
    'Setup.exe omitted an InstallShield runtime DLL');
  const requiredGuestFiles = [
    `${INSTALLED_GUEST_ROOT}\\darkstonedemo.exe`,
    `${INSTALLED_GUEST_ROOT}\\ddata.mtf`,
    `${INSTALLED_GUEST_ROOT}\\dmusic.mtf`,
    `${INSTALLED_GUEST_ROOT}\\dvoices1.mtf`,
  ];

  const session = startControlSession([
    RUN,
    `--exe=${bootstrap.child}`,
    `--exe-guest-path=${bootstrap.metadata.guestExe}`,
    `--vfs-tree=${captureRoot}`,
    `--cwd=${bootstrap.metadata.directory || 'C:\\'}`,
    `--dll-seed=${zdata},${utility}`,
    '--screen=800x600',
    '--batch-size=100000',
    '--tick-ms-per-batch=100',
    '--max-batches=1000000',
    '--max-seconds=300',
    '--repaint-every=10',
    '--quiet-api',
    '--quiet-blocks',
    '--no-build',
    '--no-close',
    '--control-stdin',
    '--frozen',
    `--save-vfs=${installVfs}`,
  ], { cwd: ROOT, idPrefix: 'dsi-' });

  try {
    await waitForTitle(session, /^Welcome$/i, 35);
    await clickNext(session);
    await waitForTitle(session, /^Choose Destination Location$/i, 20);
    await clickNext(session);
    await waitForTitle(session, /^Select Program Folder$/i, 20);
    await clickNext(session);

    const installed = await waitFor(session, 'the installed gameplay payload', () =>
      session.send({ action: 'eval', code:
        `${JSON.stringify(requiredGuestFiles)}.every(file => ctx.vfs.files.has(file))` }), 80, 2);
    assert(installed, 'InstallShield did not write the complete Darkstone payload');

    await waitForTitle(session, /Setup Complete|Complete/i, 40);
    if (completionPng) {
      fs.mkdirSync(path.dirname(completionPng), { recursive: true });
      await session.send({ action: 'png', path: completionPng });
    }
    const code = await session.quit();
    assert.strictEqual(code, 0,
      `Darkstone installer exited ${code}\n${session.output().slice(-8000)}`);
    assert(!/An error occurred during the move data process|UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError:/i.test(session.output()),
      `Darkstone installer hit a compatibility failure\n${session.output().slice(-12000)}`);
  } catch (error) {
    const detail = session.output().slice(-12000);
    await session.quit({ ignoreReplyError: true });
    throw new Error(`${error.message}\n${detail}`);
  }
}

function publishInstall(installVfs, output) {
  const installed = path.join(installVfs, 'program files', 'delphinesoft', 'darkstone demo');
  const game = path.join(installed, 'darkstonedemo.exe');
  assert(fs.existsSync(game), 'InstallShield output omitted DarkstoneDemo.exe');
  assert.strictEqual(sha256(game), GAME_SHA256,
    'installed DarkstoneDemo.exe does not match the tested demo');
  for (const file of ['ddata.mtf', 'dmusic.mtf', 'dvoices1.mtf', 'readme.txt']) {
    assert(fs.existsSync(path.join(installed, file)), `InstallShield output omitted ${file}`);
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
  assert(fs.existsSync(installer), `Darkstone installer is missing: ${installer}`);
  assert.strictEqual(sha256(installer), INSTALLER_SHA256,
    'Darkstone installer does not match the pinned original package');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-darkstone-installer-'));
  const captureRoot = reusedCapture || path.join(temp, 'package-vfs');
  const installVfs = path.join(temp, 'installed-vfs');
  try {
    let bootstrap;
    if (reusedCapture) {
      console.log(`Darkstone install 1/2: reusing captured Setup.exe VFS ${captureRoot}`);
      const metadata = JSON.parse(fs.readFileSync(path.join(captureRoot, 'launch.json'), 'utf8'));
      const child = path.join(captureRoot, ...metadata.exe.split('/'));
      assert.strictEqual(sha256(child), ENGINE_SHA256,
        'captured InstallShield engine hash mismatch');
      bootstrap = { metadata, child };
    } else {
      console.log('Darkstone install 1/2: running original Setup.exe bootstrap...');
      bootstrap = await runBootstrap(installer, captureRoot);
    }

    console.log('Darkstone install 2/2: driving the emitted InstallShield engine...');
    await runInstaller(captureRoot, bootstrap, installVfs, completionPng);
    publishInstall(installVfs, output);
    console.log(`PASS  authentic Darkstone demo installed to ${output}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL  Darkstone demo installer: ${error.stack || error.message}`);
  process.exit(1);
});
