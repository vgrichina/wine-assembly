#!/usr/bin/env node

'use strict';

// WinRAR 3.10 is a Win98-compatible GUI acceptance target. Its license allows
// redistribution of only the original unmodified installer, so this gate runs
// that hash-pinned local corpus artifact directly and never checks in extracted
// files.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');
const { compileWatSnapshot } = require('../lib/compile-wat');
const { APPS, DESKTOP_APPS, LOCAL_CANDIDATE_APPS } = require('../lib/apps');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const MANIFEST = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'candidate-corpus', 'manifest.json'), 'utf8'));
const WINRAR = path.join(__dirname, 'binaries', 'candidates',
  'winrar-310', 'wrar310.exe');
const INSTALLED_ROOT = path.join(__dirname, 'binaries', 'candidates',
  'winrar-310', 'installed');
const INSTALLED_WINRAR = path.join(INSTALLED_ROOT, 'WinRAR.exe');
const SHA1 = 'e7fbcc871245ef9eaf73f8c0dfb00f4b63456a91';

const winrarApp = APPS.winrar_310;
assert(winrarApp, 'installed WinRAR has a browser app registry entry');
assert(LOCAL_CANDIDATE_APPS.some(([id]) => id === 'winrar_310'),
  'installed WinRAR is visible on the localhost desktop and dropdown');
assert(!DESKTOP_APPS.some(([id]) => id === 'winrar_310'),
  'WinRAR is not published as a deployed app');
assert.strictEqual(winrarApp.exe,
  'test/binaries/candidates/winrar-310/installed/WinRAR.exe',
  'the launcher uses the installed GUI, not the self-extracting installer');
assert.strictEqual(winrarApp.requiredFiles, true,
  'WinRAR refuses a partial companion-file mount');
assert.strictEqual(winrarApp.preExtractIcon, false,
  'WinRAR derives its icon at runtime from the ignored executable');
assert(winrarApp.files.some(file => file.vfsPath === 'Formats\\ace.fmt'),
  'WinRAR mounts archive-format plugins in their original subdirectory');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
assert(html.includes('<option value="winrar_310">WinRAR 3.10</option>'),
  'WinRAR has a concrete localhost dropdown option');

function peSubsystem(bytes) {
  assert(bytes.length >= 0x100 && bytes.toString('ascii', 0, 2) === 'MZ',
    'WinRAR package has a DOS/PE header');
  const pe = bytes.readUInt32LE(0x3c);
  assert(pe + 94 <= bytes.length && bytes.toString('binary', pe, pe + 4) === 'PE\0\0',
    'WinRAR package has a valid PE signature');
  return bytes.readUInt16LE(pe + 24 + 68);
}

function colorCount(png, rgb) {
  let count = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] === rgb[0] && png.data[i + 1] === rgb[1] &&
        png.data[i + 2] === rgb[2] && png.data[i + 3]) count++;
  }
  return count;
}

(async () => {
  const candidate = MANIFEST.candidates.find(item => item.id === 'winrar-310');
  assert(candidate, 'WinRAR 3.10 has a candidate-corpus entry');
  assert.strictEqual(candidate.kind, 'GUI application',
    'WinRAR is classified separately from console candidates');
  assert.strictEqual(candidate.localOnly, true,
    'WinRAR remains an ignored local-only artifact');
  assert.deepStrictEqual(candidate.packages.map(pkg => [
    pkg.type, pkg.destination, pkg.sha1,
  ]), [['file', 'wrar310.exe', SHA1]],
  'WinRAR preserves the exact intact installer download and hash');
  assert.deepStrictEqual(candidate.postExtract, [{
    type: 'extractArchive', archive: 'wrar310.exe', into: 'installed',
  }], 'WinRAR preparation extracts the intact SFX into the launcher tree');

  if (!fs.existsSync(WINRAR)) {
    console.log('SKIP WinRAR candidate: fetch with node tools/fetch-candidate-corpus.js --id=winrar-310');
    return;
  }

  const bytes = fs.readFileSync(WINRAR);
  assert.strictEqual(bytes.length, 964587, 'WinRAR fixture has the pinned installer size');
  assert.strictEqual(crypto.createHash('sha1').update(bytes).digest('hex'), SHA1,
    'WinRAR fixture bytes match the pinned original installer');
  assert.strictEqual(peSubsystem(bytes), 2,
    'WinRAR is a Windows GUI executable, not a console-subsystem executable');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-winrar-'));
  const wasmPath = path.join(temp, 'candidate.wasm');
  const framePath = path.join(temp, 'winrar.png');
  const installedFramePath = path.join(temp, 'winrar-installed.png');
  try {
    const wasm = await compileWatSnapshot(file =>
      fs.promises.readFile(path.join(ROOT, 'src', file), 'utf8'));
    fs.writeFileSync(wasmPath, wasm);

    const result = spawnSync('node', [
      RUN,
      `--exe=${WINRAR}`,
      `--wasm=${wasmPath}`,
      '--no-build',
      '--quiet-api',
      '--quiet-blocks',
      '--max-batches=120',
      '--batch-size=50000',
      `--png=${framePath}`,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.error) throw result.error;
    assert.strictEqual(result.status, 0,
      `WinRAR installer exited ${result.status}${result.signal ? ` (${result.signal})` : ''}\n${output.slice(-8000)}`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(output),
      `WinRAR installer hit a compatibility failure\n${output.slice(-8000)}`);
    for (const marker of [
      '"WinRAR self-extracting archive"', '"WinRAR 3.10"',
      '"&Destination folder"', '"Install"', '"License"', '"Accept"',
    ]) {
      assert(output.includes(`[SetWindowText] ${marker}`),
        `WinRAR installer did not reach ${marker}\n${output.slice(-8000)}`);
    }
    assert(fs.existsSync(framePath), 'WinRAR installer did not produce a browser frame');

    const png = PNG.sync.read(fs.readFileSync(framePath));
    assert.strictEqual(`${png.width}x${png.height}`, '640x480',
      'WinRAR candidate uses the browser-sized Win98 desktop');
    const teal = colorCount(png, [0, 128, 128]);
    const gray = colorCount(png, [192, 192, 192]);
    const white = colorCount(png, [255, 255, 255]);
    const blue = colorCount(png, [0, 0, 128]);
    assert(teal > 80000 && gray > 50000 && white > 50000 && blue > 50,
      `WinRAR setup UI is not visibly rendered (${teal} teal, ${gray} gray, ${white} white, ${blue} blue)`);

    assert(fs.existsSync(INSTALLED_WINRAR),
      'prepare WinRAR before testing the dropdown: node tools/fetch-candidate-corpus.js --id=winrar-310 --prepare');
    const installed = spawnSync('node', [
      RUN,
      `--exe=${INSTALLED_WINRAR}`,
      '--vfs-include=**/*',
      `--wasm=${wasmPath}`,
      '--no-build',
      '--quiet-api',
      '--quiet-blocks',
      '--max-batches=120',
      '--batch-size=50000',
      '--input=1:wait-title:Please_register:2000,2:dlg-click:1,3:wait-title:Settings:2000,4:dlg-click:2',
      `--png=${installedFramePath}`,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const installedOutput = `${installed.stdout || ''}${installed.stderr || ''}`;
    if (installed.error) throw installed.error;
    assert.strictEqual(installed.status, 0,
      `installed WinRAR exited ${installed.status}${installed.signal ? ` (${installed.signal})` : ''}\n${installedOutput.slice(-8000)}`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(installedOutput),
      `installed WinRAR hit a compatibility failure\n${installedOutput.slice(-8000)}`);
    assert(installedOutput.includes('[SetWindowText] "c:\\ - WinRAR (evaluation copy)"'),
      `installed WinRAR never reached its live file panel\n${installedOutput.slice(-8000)}`);
    for (const plugin of ['ace', 'arj', 'bz2', 'cab', 'gz', 'iso', 'lzh', 'tar', 'uue']) {
      assert(installedOutput.includes(`[LoadLibrary] ${plugin}.fmt loaded`),
        `installed WinRAR did not load ${plugin}.fmt\n${installedOutput.slice(-8000)}`);
    }
    const installedPng = PNG.sync.read(fs.readFileSync(installedFramePath));
    const installedTeal = colorCount(installedPng, [0, 128, 128]);
    const installedGray = colorCount(installedPng, [192, 192, 192]);
    const installedWhite = colorCount(installedPng, [255, 255, 255]);
    const installedBlue = colorCount(installedPng, [0, 0, 128]);
    assert(installedTeal > 150000 && installedGray > 35000 &&
      installedWhite > 35000 && installedBlue > 3000,
    `installed WinRAR file manager is not visibly rendered (${installedTeal} teal, ${installedGray} gray, ${installedWhite} white, ${installedBlue} blue)`);

    console.log(`PASS  WinRAR 3.10 installer and installed file manager render (${installedGray} gray, ${installedWhite} white, ${installedBlue} blue pixels)`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
