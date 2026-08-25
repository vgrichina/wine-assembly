#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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

const dlls = [
  'hw.dll', 'sw.dll', 'hl_res.dll', 'a3dapi.dll',
  'valve/dlls/hl.dll', 'valve/cl_dlls/client.dll',
].map(file => path.join(installed, file)).join(',');
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

console.log('PASS Half-Life Uplink installed payload reaches its DirectDraw main menu');
