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
const CANDIDATE_ROOT = path.join(__dirname, 'binaries', 'candidates', 'worms-2-demo');
const ARCHIVE = path.join(CANDIDATE_ROOT, 'Worms2Demo10Oct.zip');
const INSTALLER_ROOT = path.join(CANDIDATE_ROOT, 'installer-10oct');
const SETUP = path.join(INSTALLER_ROOT, 'SETUP.EXE');
const ARCHIVE_SHA256 = 'c65d36cef69437f066a3d50d8ff26d43d228a0595d7bcc106d541375e1d3cfd8';
const SETUP_SHA256 = '795c2f00a669bdbcea105402c5341a1efecdb7d4e64d0a4d8d9ab3d509649e12';
const CAB_SHA256 = '8aa6f288c4cf96d841d1fd60791a19396847a454791fb32a5610995b9d6d082a';
const ENGINE_SHA256 = 'a4caeb938fcb6bef335af1855f582e699d7fb9b4368de01c01a06e8fafc784cf';
const ZDATA_SHA256 = '0db8d82d36d3092e8c9772b148818daefa47dae1332c92b06a7f94ba72e3a714';
const GAME_SHA256 = 'cfb393c9ae72764dd4ff85b3e679671d28017d59d5c4b852d64bee7597447caa';
const LAND_SHA256 = 'd9efd28af0605566cd67f3f74b857870eb2e4fc18333fe519f6503f90d9eaeb2';
const GFX_SHA256 = 'ac79437346dfbb00e3e22998e0dbeb356c233798bbc6cc73d27ab3ddb63bff7a';
const LEVEL_SHA256 = '02f0f1b03d3ad1d1bf279ff9decbcbdd204031452cd75351ca44b6609c396b22';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function assert(condition, message) { if (!condition) throw new Error(message); }
function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
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
  const wanted = basename.toLowerCase();
  const relative = walkFiles(root).find(file => path.basename(file).toLowerCase() === wanted);
  return relative ? path.join(root, relative) : null;
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
  return { png, width: png.width, height: png.height, colors: colors.size, nonBlack };
}

function pixelDiff(a, b) {
  assert(a.width === b.width && a.height === b.height, 'Worms 2 frame sizes differ');
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) changed++;
  }
  return changed;
}

async function parkAtWindow(session, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await session.send({ action: 'snapshot' });
    if (last.windows.some(win => win.visible && pattern.test(win.title || ''))) {
      await session.send({ action: 'frozen', mode: 'on' });
      const parked = await session.send({ action: 'snapshot' });
      assert(parked.frozen.frozen, `Worms 2 did not park at ${pattern}`);
      return parked;
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for Worms 2 window ${pattern}; last=${JSON.stringify(last)}\n` +
    session.output().slice(-8000));
}

async function advanceInstaller(session, nextTitle, timeoutMs = 30000) {
  await session.send('dlg-click:1');
  await session.send({ action: 'frozen', mode: 'off' });
  return parkAtWindow(session, nextTitle, timeoutMs);
}

function runBootstrap(captureRoot) {
  const result = spawnSync(process.execPath, [
    RUN,
    `--exe=${SETUP}`,
    '--vfs-include=*',
    '--screen=800x600',
    '--batch-size=100000',
    '--max-batches=10000',
    '--max-seconds=60',
    '--quiet-api',
    '--quiet-blocks',
    '--no-build',
    `--capture-launch=${captureRoot}`,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  assert(result.status === 0, `Worms 2 bootstrap exited ${result.status}\n${output.slice(-8000)}`);
  assert(/\[capture-launch\] snapshotted .*_ins\d+\._mp/i.test(output),
    `Worms 2 bootstrap did not capture its native child\n${output.slice(-8000)}`);
  assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(output),
    `Worms 2 bootstrap hit a compatibility failure\n${output.slice(-8000)}`);

  const metadata = JSON.parse(fs.readFileSync(path.join(captureRoot, 'launch.json'), 'utf8'));
  assert(metadata.schemaVersion === 1 && /^windows\/temp\/_ins\d+\._mp$/i.test(metadata.exe),
    `unexpected Worms 2 child metadata: ${JSON.stringify(metadata)}`);
  const emittedChild = path.join(captureRoot, ...metadata.exe.split('/'));
  const tempRoot = path.join(captureRoot, 'windows', 'temp');
  const emittedIni = fs.readdirSync(tempRoot).find(name => /^_ins\d+\.ini$/i.test(name));
  const emittedZdata = path.join(tempRoot, 'zdatai50.dll');
  assert(emittedIni && fs.existsSync(emittedZdata), 'Worms 2 bootstrap omitted InstallShield companions');
  assert(sha256(emittedChild) === ENGINE_SHA256, 'Worms 2 emitted InstallShield engine hash mismatch');
  assert(sha256(emittedZdata) === ZDATA_SHA256, 'Worms 2 emitted zdatai50.dll hash mismatch');

  // The child needs the source media at C:\ and reads its bootstrap INI there.
  // Relocate only files the emulator just emitted; the host never opens a CAB.
  const child = path.join(captureRoot, path.basename(emittedChild));
  const zdata = path.join(captureRoot, 'zdatai50.dll');
  fs.copyFileSync(emittedChild, child);
  fs.copyFileSync(emittedZdata, zdata);
  fs.copyFileSync(path.join(tempRoot, emittedIni), path.join(captureRoot, emittedIni));
  const ini = fs.readFileSync(path.join(captureRoot, emittedIni), 'latin1').replace(/\0+$/, '');
  assert(/^-?\s*-fC:\\SETUP\.INS\s+-z1\s+-cx\s+-xC:\\WINDOWS\\TEMP\\\s+-x1C:\\\s+-q10009$/i.test(ini.trim()),
    `unexpected Worms 2 InstallShield arguments: ${JSON.stringify(ini)}`);
  return { child, zdata, metadata };
}

async function runInstaller(bootstrap, installRoot, screenshotDir) {
  const finishedPath = path.join(screenshotDir, 'installer-finished.png');
  const session = startControlSession([
    RUN,
    `--exe=${bootstrap.child}`,
    `--dll-seed=${bootstrap.zdata}`,
    '--vfs-include=**/*',
    '--screen=800x600',
    '--batch-size=100000',
    '--max-batches=1000000',
    '--max-seconds=120',
    '--quiet-api',
    '--quiet-blocks',
    '--no-build',
    '--no-close',
    '--control-stdin',
    `--save-vfs=${installRoot}`,
  ], { cwd: ROOT, idPrefix: 'wi' });
  try {
    await parkAtWindow(session, /^Welcome$/i, 30000);
    await advanceInstaller(session, /^Choose Destination Location$/i);
    await advanceInstaller(session, /^Select Program Folder$/i);
    await advanceInstaller(session, /^Setup Complete$/i, 60000);

    await session.send({ action: 'png', path: finishedPath });
    const finished = imageStats(finishedPath);
    assert(finished.width === 800 && finished.height === 600 &&
      finished.colors > 40 && finished.nonBlack > 350000,
    `Worms 2 completion page was not rendered: ${JSON.stringify(finished)}`);

    await session.send('dlg-send:501:241:0:0'); // Clear optional README checkbox.
    const stepped = await session.send({ action: 'step', n: 1 });
    assert(stepped.ran === 1, `Worms 2 checkbox step failed: ${JSON.stringify(stepped)}`);
    await session.send('dlg-click:1'); // Finish.
    await session.send({ action: 'frozen', mode: 'off' });
    const exitCode = await session.exited;
    session.child.stdin.end();
    assert(exitCode === 0,
      `Worms 2 installer CLI exited ${exitCode}\n${session.output().slice(-8000)}`);
    assert(/\[Exit\] code=0/.test(session.output()),
      `Worms 2 installer did not exit through Finish\n${session.output().slice(-8000)}`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(session.output()),
      `Worms 2 installer hit a compatibility failure\n${session.output().slice(-8000)}`);
    return { finished, finishedPath };
  } catch (error) {
    await session.quit({ ignoreReplyError: true });
    throw error;
  }
}

function verifyInstall(installRoot) {
  const game = findFile(installRoot, 'worms2.dat');
  assert(game && sha256(game) === GAME_SHA256, 'Worms 2 installed game hash mismatch');
  const gameRoot = path.dirname(game);
  const required = [
    ['data/land.dat', LAND_SHA256],
    ['data/gfx/gfx.dir', GFX_SHA256],
    ['data/level/medieval/level.dir', LEVEL_SHA256],
  ];
  for (const [relative, expected] of required) {
    const filename = path.join(gameRoot, ...relative.split('/'));
    assert(fs.existsSync(filename) && sha256(filename) === expected,
      `Worms 2 installed asset mismatch: ${relative}`);
  }
  const files = walkFiles(gameRoot);
  assert(files.length === 158, `Worms 2 install produced ${files.length}/158 files`);
  assert(files.filter(file => /\.wav$/i.test(file)).length === 140,
    'Worms 2 install omitted effect or speech WAV files');
  const readme = fs.readFileSync(path.join(gameRoot, 'readme.txt'), 'latin1');
  assert(/REDISTRIBUTION OF THIS DEMO:[\s\S]*permit authority to redistribute[\s\S]*original\s+files remain intact and unchanged/i.test(readme),
    'Worms 2 installed README omitted its original-files redistribution grant');
  assert(/No music \(final game has CD audio ambience tracks/i.test(readme),
    'Worms 2 installed README omitted the demo no-music limitation');
  return { game, gameRoot, files: files.length };
}

async function parkAtGameplay(session, probePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await session.send({ action: 'png', path: probePath });
    last = imageStats(probePath);
    if (last.width === 800 && last.height === 600 && last.colors > 100 &&
        last.nonBlack > 425000 && fs.statSync(probePath).size > 150000) {
      await session.send({ action: 'frozen', mode: 'on' });
      return session.send({ action: 'snapshot' });
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for Worms 2 gameplay; last=${JSON.stringify(last)}\n` +
    session.output().slice(-8000));
}

async function runGameplay(game, screenshotDir) {
  const probePath = path.join(screenshotDir, 'gameplay-probe.png');
  const frameAPath = path.join(screenshotDir, 'gameplay-a.png');
  const frameBPath = path.join(screenshotDir, 'gameplay-b.png');
  const session = startControlSession([
    RUN,
    `--exe=${game}`,
    '--vfs-include=**/*',
    '--screen=800x600',
    '--batch-size=100000',
    '--tick-ms-per-batch=5',
    '--max-batches=1000000',
    '--max-seconds=90',
    '--quiet-api',
    '--quiet-blocks',
    '--no-build',
    '--no-close',
    '--control-stdin',
    '--dx-surfaces',
  ], { cwd: ROOT, idPrefix: 'wg' });
  try {
    const start = await parkAtGameplay(session, probePath, 45000);
    await session.send({ action: 'png', path: frameAPath });
    const a = imageStats(frameAPath);

    await session.send('keydown:37'); // Walk Fudge left from the shore into the water.
    await session.send({ action: 'frozen', mode: 'off' });
    const targetBatch = start.batch + 400;
    let moving = start;
    while (moving.batch < targetBatch) {
      await sleep(25);
      moving = await session.send({ action: 'snapshot' });
    }
    await session.send({ action: 'frozen', mode: 'on' });
    await session.send({ action: 'png', path: frameBPath });
    const b = imageStats(frameBPath);
    const changed = pixelDiff(a.png, b.png);
    assert(a.colors > 100 && b.colors > 80 && a.nonBlack > 425000 && b.nonBlack > 425000,
      `Worms 2 gameplay art was incomplete: ${a.colors}/${b.colors} colors`);
    assert(changed > 100000,
      `Worms 2 held-key gameplay did not visibly advance: ${changed} changed pixels`);

    const audio = await session.send({ action: 'eval', code: `(() => {
      const voices = ctx.sharedAudio && ctx.sharedAudio.voices && ctx.sharedAudio.voices._map;
      const rows = voices ? Object.values(voices) : [];
      return { voices: rows.length,
        bytes: rows.reduce((sum, voice) => sum + (voice.snapshotBytes || voice.bytesWritten || 0), 0) };
    })()` });
    assert(audio.voices > 0 && audio.bytes > 0,
      `Worms 2 did not submit DirectSound audio: ${JSON.stringify(audio)}`);
    const exitCode = await session.quit();
    assert(exitCode === 0,
      `Worms 2 gameplay CLI exited ${exitCode}\n${session.output().slice(-8000)}`);
    assert(/\[input\] keydown vk=37/.test(session.output()),
      `Worms 2 did not receive the held Left key\n${session.output().slice(-8000)}`);
    assert(/slot=1 640x480 bpp=8[^\n]*colors=(?:[4-9]\d|\d{3,})/.test(session.output()),
      `Worms 2 did not retain a colorful 640x480 primary surface\n${session.output().slice(-8000)}`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(session.output()),
      `Worms 2 gameplay hit a compatibility failure\n${session.output().slice(-8000)}`);
    return { a, b, changed, audio, frameAPath, frameBPath };
  } catch (error) {
    await session.quit({ ignoreReplyError: true });
    throw error;
  }
}

async function main() {
  const seed = String(process.env.WORMS2_INSTALLED_ROOT || '').trim();
  if (!fs.existsSync(SETUP) && !seed) {
    console.log('SKIP Worms 2 candidate: fetch with node tools/fetch-candidate-corpus.js --id=worms-2-demo');
    return;
  }
  if (fs.existsSync(ARCHIVE)) {
    assert(fs.statSync(ARCHIVE).size === 7299379 && sha256(ARCHIVE) === ARCHIVE_SHA256,
      'Worms 2 original October ZIP hash mismatch');
  }
  if (fs.existsSync(SETUP)) {
    assert(fs.statSync(SETUP).size === 59904 && sha256(SETUP) === SETUP_SHA256,
      'Worms 2 original SETUP.EXE hash mismatch');
    assert(sha256(path.join(INSTALLER_ROOT, 'data1.cab')) === CAB_SHA256,
      'Worms 2 original data1.cab hash mismatch');
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-worms2-candidate-'));
  const captureRoot = path.join(temp, 'bootstrap-vfs');
  const installRoot = path.join(temp, 'installed-vfs');
  const screenshotDir = process.env.WORMS2_SCREENSHOT_DIR ||
    path.join(ROOT, 'build', 'worms2-candidate');
  fs.mkdirSync(screenshotDir, { recursive: true });
  try {
    let installed = seed;
    if (seed) {
      console.log(`Worms 2 stage 1/2: reusing emulator-installed VFS ${seed}`);
    } else {
      console.log('Worms 2 stage 1/2: running original bootstrap and installer...');
      fs.mkdirSync(captureRoot, { recursive: true });
      const bootstrap = runBootstrap(captureRoot);
      const installer = await runInstaller(bootstrap, installRoot, screenshotDir);
      console.log(`PASS installer: ${installer.finished.width}x${installer.finished.height}, ` +
        `${installer.finished.colors} colors, ${installer.finishedPath}`);
      installed = installRoot;
    }

    const verified = verifyInstall(installed);
    console.log(`PASS installed payload: ${verified.files} files, game ${GAME_SHA256}`);
    console.log('Worms 2 stage 2/2: driving parked stdio gameplay...');
    const gameplay = await runGameplay(verified.game, screenshotDir);
    console.log(`PASS gameplay: ${gameplay.a.colors}/${gameplay.b.colors} colors, ` +
      `${gameplay.changed} changed pixels`);
    console.log(`PASS audio: ${gameplay.audio.voices} voice(s), ${gameplay.audio.bytes} submitted bytes`);
    console.log(`PASS screenshots: ${gameplay.frameAPath} ${gameplay.frameBPath}`);
    console.log('Worms 2 candidate: PASS 2/2');
  } finally {
    if (process.env.KEEP_WORMS2_CANDIDATE_TMP === '1') {
      console.log(`kept candidate artifacts: ${temp}`);
    } else {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(`FAIL Worms 2 candidate: ${error.stack || error.message}`);
  process.exit(1);
});
