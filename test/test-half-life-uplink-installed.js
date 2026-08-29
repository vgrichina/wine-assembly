#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');
const { spawnSync } = require('child_process');
const { APPS } = require('../lib/apps');

const root = path.resolve(__dirname, '..');
const installed = path.join(root,
  'test/binaries/candidates/half-life-uplink-installer/installed');
const exe = path.join(installed, 'hldemo.exe');
const pak = path.join(installed, 'valve/pak0.pak');
if (!fs.existsSync(exe) || !fs.existsSync(pak)) {
  console.log('SKIP Half-Life Uplink installer-produced payload is not present');
  process.exit(0);
}

const digest = file => crypto.createHash('sha256')
  .update(fs.readFileSync(file)).digest('hex');
assert.strictEqual(fs.statSync(exe).size, 737280);
assert.strictEqual(digest(exe),
  'e459ef7d19bc0690d2e2d6dca9af1d773b49f8172096e49a694f897119bc4dc1');
assert.strictEqual(fs.statSync(pak).size, 79150544);
assert.strictEqual(digest(pak),
  'c9eac1391845d6fabd93d7a1cc48281275410d35e01b74bd7f02325c65c99a42');

for (const [suffix, vfsPath] of [
  ['/valve/dlls/hl.dll', 'c:\\valve\\dlls\\hl.dll'],
  ['/valve/cl_dlls/client.dll', 'c:\\valve\\cl_dlls\\client.dll'],
]) {
  assert(APPS.halflife_uplink.files.some(file =>
    file.url.endsWith(suffix) && file.vfsPath === vfsPath),
  `Half-Life Uplink mounts ${suffix} at its installed discovery path`);
}
const browserShell = fs.readFileSync(path.join(root, 'lib/browser-shell.js'), 'utf8');
assert(/case 'jazz2_demo':\s*[\s\S]*?case 'halflife_uplink':\s*return 10000;/.test(browserShell),
  'Half-Life Uplink gives OpenGL enough work per cooperative slice for gameplay');
const halfLifeRegistry = new Map(APPS.halflife_uplink.startupRegistry.map(entry =>
  [entry.valueName, entry.data]));
assert.strictEqual(halfLifeRegistry.get('EngineGLDriver'), 'Default',
  'Half-Life selects the generic Wine-Assembly OpenGL driver');
assert.strictEqual(halfLifeRegistry.get('EngineType'), 2,
  'Half-Life persists the OpenGL renderer rather than the black software path');
assert.deepStrictEqual(APPS.halflife_uplink.rendererRunSlices,
  { software: 1000, opengl: 10000 },
  'Half-Life keeps OpenGL fed while letting its software renderer yield');
assert(browserShell.includes('wine.onOpenGLContextCountChange = count =>'),
  'browser scheduler follows in-process OpenGL context replacement');
assert(browserShell.includes("frame.kind === 'directdraw'"),
  'software presentation selects the yielding cooperative run slice');
assert(browserShell.includes("frame.kind === 'gpu'"),
  'OpenGL presentation restores the throughput-oriented run slice');
assert(browserShell.includes("String(change.name).toLowerCase() !== 'enginetype'"),
  'GoldSrc video-mode registry writes switch scheduling before the next frame');

const dlls = [
  'hw.dll', 'sw.dll', 'hl_res.dll', 'a3dapi.dll',
  'valve/dlls/hl.dll', 'valve/cl_dlls/client.dll',
].map(file => path.join(installed, file)).join(',');
const screenshot = path.join(os.tmpdir(),
  `wine-assembly-half-life-uplink-menu-${process.pid}.png`);
const run = spawnSync(process.execPath, [
  'test/run.js',
  `--exe=${exe}`,
  '--no-build',
  '--vfs-include=**/*',
  `--dll-seed=${dlls}`,
  '--max-batches=1000000',
  '--max-seconds=12',
  '--batch-size=1000',
  '--repaint-every=1000',
  `--png=${screenshot}`,
  '--quiet-api',
  '--quiet-blocks',
  '--input=1:wait-dlg-control:1:10000,2:dlg-click:1',
  '--trace-api=mciSendStringA,mciGetDeviceIDA,DirectDrawCreate,SetWindowTextA',
], {
  cwd: root,
  encoding: 'utf8',
  timeout: 30000,
  maxBuffer: 16 * 1024 * 1024,
});
const output = `${run.stdout || ''}\n${run.stderr || ''}`;
assert.strictEqual(run.error, undefined, run.error && run.error.message);
assert.strictEqual(run.status, 0, output.slice(-5000));
for (const marker of [
  'DirectDrawCreate(',
  'mciGetDeviceIDA(pszDevice="sierravideo")',
  'mciSendStringA(lpszCommand="close sierravideo wait"',
  'text="&New game"',
  'text="&Hazard course"',
]) {
  assert(output.includes(marker), `missing installed-game marker ${marker}\n${output.slice(-5000)}`);
}
assert(!/UNIMPLEMENTED API|\*\*\* CRASH|RuntimeError:/i.test(output),
  `installed game entered a failed compatibility path\n${output.slice(-5000)}`);

const menu = PNG.sync.read(fs.readFileSync(screenshot));
assert.strictEqual(menu.width, 640);
assert.strictEqual(menu.height, 480);
const yellowPixels = y0 => {
  let count = 0;
  for (let y = y0; y < y0 + 26; y++) {
    for (let x = 60; x < 226; x++) {
      const i = (y * menu.width + x) * 4;
      if (menu.data[i] > 150 && menu.data[i + 1] > 100 && menu.data[i + 2] < 100) {
        count++;
      }
    }
  }
  return count;
};
for (const y of [180, 212, 244, 276, 308, 340, 372]) {
  assert(yellowPixels(y) > 100,
    `Half-Life Uplink menu label at y=${y} was not rendered`);
}

console.log('PASS Half-Life Uplink installed payload renders all seven main-menu labels');
