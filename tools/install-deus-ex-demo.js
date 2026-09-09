#!/usr/bin/env node

'use strict';

// Run the original Deus Ex demo package and its emitted Setup.exe. The host
// never opens either installer payload; it only exports the VFS after setup.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { startControlSession } = require('../test/control-session');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(ROOT, 'test', 'run.js');
const INSTALLER_SHA256 = '997700876bbc3af74fa0a7d336dbe0e9ea085f871a73261239dfc2801d9fa6bd';
const EXE_SHA256 = '2ed115d9dc93582273830d9ae38f92ab4379842459e24eaec11390f312d5af5f';

function getArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find(value => value.startsWith(prefix));
  return arg ? path.resolve(arg.slice(prefix.length)) : null;
}

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function runCli(label, args) {
  const result = spawnSync(process.execPath, [RUN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.error) throw result.error;
  assert.strictEqual(result.status, 0,
    `${label} exited ${result.status}${result.signal ? ` (${result.signal})` : ''}\n${output.slice(-8000)}`);
  assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError:|CORRUPT state/i.test(output),
    `${label} hit a compatibility failure\n${output.slice(-8000)}`);
  return output;
}

async function stepTotal(session, count, chunk = 25) {
  let remaining = count;
  while (remaining > 0) {
    const n = Math.min(chunk, remaining);
    const reply = await session.send({ action: 'step', n });
    assert.strictEqual(reply.ran, n,
      `requested ${n} frozen steps, ran ${reply.ran}\n${session.output().slice(-8000)}`);
    remaining -= n;
  }
}

async function waitFor(session, description, code, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const found = await session.send({ action: 'eval', code });
    if (found) return found;
    await stepTotal(session, 10, 10);
  }
  throw new Error(`Deus Ex setup did not reach ${description}\n${session.output().slice(-8000)}`);
}

const hasControl = id => `(() => {
  const e = instance.exports;
  if (!e.wnd_slot_hwnd || !e.ctrl_get_id) return 0;
  for (let slot = 0; slot < 256; slot++) {
    const hwnd = e.wnd_slot_hwnd(slot);
    if (hwnd && e.ctrl_get_id(hwnd) === ${id}) return hwnd;
  }
  return 0;
})()`;

async function setEdit(session, id, text) {
  await session.send(`dlg-set-edit:${id}:${text}`);
  await stepTotal(session, 3, 3);
}

async function clickDialogButton(session, id, settle = 25) {
  await session.send(`dlg-click:${id}`);
  await stepTotal(session, settle);
}

function hasInstalledPayload(installVfs) {
  const root = path.join(installVfs, 'deusexdemo');
  return [
    'system/deusex.exe',
    'maps/00_training.dx',
    'textures/v_com_center.utx',
    'music/training_music.umx',
  ].every(file => fs.existsSync(path.join(root, file)));
}

async function runSetup(captureDir, installVfs, completionPng) {
  const metadata = JSON.parse(fs.readFileSync(path.join(captureDir, 'launch.json'), 'utf8'));
  assert.strictEqual(metadata.schemaVersion, 1);
  assert.match(metadata.guestExe, /\\system\\setup\.exe$/i,
    'the original package did not launch its Deus Ex Setup.exe');
  const setup = path.join(captureDir, ...metadata.exe.split('/'));
  const setupDir = path.dirname(setup);
  const windowDll = path.join(setupDir, 'window.dll');
  const coreDll = path.join(setupDir, 'core.dll');
  for (const file of [setup, windowDll, coreDll]) {
    assert(fs.existsSync(file), `captured setup file is missing: ${file}`);
  }

  const guestCwd = metadata.directory || path.win32.dirname(metadata.guestExe);
  const session = startControlSession([RUN,
    `--exe=${setup}`,
    `--exe-guest-path=${metadata.guestExe}`,
    `--dll-seed=${windowDll},${coreDll}`,
    `--vfs-tree=${captureDir}`,
    `--cwd=${guestCwd}`,
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
  ], { cwd: ROOT, idPrefix: 'dxi-' });

  try {
    await stepTotal(session, 80);
    await waitFor(session, 'the welcome page', hasControl(1004));
    await clickDialogButton(session, 1004);
    await waitFor(session, 'the license page', hasControl(1019));
    await clickDialogButton(session, 1004);
    await waitFor(session, 'the destination page', hasControl(1037));
    await setEdit(session, 1037, 'C:\\DeusExDemo');
    await clickDialogButton(session, 1004, 35);

    // Install the game component. Setup chains into its separate bundled
    // DirectX updater only after every game file has been written; the frozen
    // completion gate below stops at that exact boundary because Wine Assembly
    // already provides the DirectX runtime.
    await clickDialogButton(session, 1004, 35);
    await setEdit(session, 1037, 'C:\\WINDOWS\\TEMP\\WZS1.TMP');
    await clickDialogButton(session, 1004, 10);
    await session.send('set-batch-size:200000');

    const installed = await waitFor(session, 'the installed gameplay payload', `[
      'c:\\\\deusexdemo\\\\system\\\\deusex.exe',
      'c:\\\\deusexdemo\\\\maps\\\\00_training.dx',
      'c:\\\\deusexdemo\\\\textures\\\\v_com_center.utx',
      'c:\\\\deusexdemo\\\\music\\\\training_music.umx'
    ].every(file => ctx.vfs.files.has(file))`, 80);
    assert(installed, 'Deus Ex setup did not write the complete gameplay payload');
    if (completionPng) {
      fs.mkdirSync(path.dirname(completionPng), { recursive: true });
      await session.send({ action: 'png', path: completionPng });
    }
    const code = await session.quit();
    assert.strictEqual(code, 0,
      `Deus Ex setup exited ${code}\n${session.output().slice(-8000)}`);
    assert(!/SetupIterateCabinetA|UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError:/i.test(session.output()),
      `Deus Ex setup entered a failed DirectX or compatibility path\n${session.output().slice(-8000)}`);
  } catch (error) {
    const detail = session.output().slice(-12000);
    if (session.child.exitCode === 0 && hasInstalledPayload(installVfs) &&
        !/SetupIterateCabinetA|UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError:/i.test(session.output())) {
      return;
    }
    await session.quit({ ignoreReplyError: true });
    throw new Error(`${error.message}\n${detail}`);
  }
}

async function main() {
  const installer = getArg('installer');
  const output = getArg('output');
  const completionPng = getArg('screenshot');
  const capturedPackage = getArg('capture');
  if (!installer || !output) {
    console.error('usage: node tools/install-deus-ex-demo.js --installer=FILE --output=DIR [--screenshot=PNG] [--capture=DIR]');
    process.exit(2);
  }
  assert(fs.existsSync(installer), `Deus Ex installer is missing: ${installer}`);
  assert.strictEqual(sha256(installer), INSTALLER_SHA256,
    'Deus Ex installer does not match the pinned official demo');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-deus-ex-installer-'));
  const captureDir = capturedPackage || path.join(temp, 'package-vfs');
  const installVfs = path.join(temp, 'installed-vfs');
  try {
    if (capturedPackage) {
      console.log(`Deus Ex install 1/2: reusing captured package VFS ${capturedPackage}`);
    } else {
      console.log('Deus Ex install 1/2: running original self-extractor...');
      const bootstrap = runCli('Deus Ex self-extractor', [
        `--exe=${installer}`,
        '--screen=800x600',
        '--batch-size=200000',
        '--max-batches=2000',
        '--max-seconds=300',
        '--input=1:wait-dlg-control:1:2000,2:dlg-click:1',
        '--quiet-api',
        '--quiet-blocks',
        `--capture-launch=${captureDir}`,
      ]);
      assert(/\[capture-launch\] snapshotted .*setup\.exe/i.test(bootstrap),
        `the original package did not emit Setup.exe\n${bootstrap.slice(-5000)}`);
    }

    console.log('Deus Ex install 2/2: driving captured setup...');
    await runSetup(captureDir, installVfs, completionPng);
    const installed = path.join(installVfs, 'deusexdemo');
    const exe = path.join(installed, 'system', 'deusex.exe');
    assert(fs.existsSync(exe), 'Deus Ex setup did not install System/DeusEx.exe');
    assert.strictEqual(sha256(exe), EXE_SHA256,
      'installed DeusEx.exe does not match the tested demo');
    assert(fs.existsSync(path.join(installed, 'maps', '00_training.dx')),
      'Deus Ex setup omitted the Training map');

    fs.rmSync(output, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.cpSync(installed, output, { recursive: true });
    console.log(`PASS  authentic Deus Ex demo installed to ${output}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL  Deus Ex demo installer: ${error.stack || error.message}`);
  process.exit(1);
});
