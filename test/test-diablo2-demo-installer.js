#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const installer = path.join(root,
  'test/binaries/candidates/diablo-2-demo-installer/DiabloIIDemo.exe');

if (!fs.existsSync(installer)) {
  console.log('SKIP Diablo II local demo installer is not present');
  process.exit(0);
}

const digest = crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex');
assert.strictEqual(fs.statSync(installer).size, 138309685,
  'the installer is the pinned Diablo II Shareware package');
assert.strictEqual(digest,
  '89352716523e474514553e2092a1ae9349c5c7ff9e79c7861dd65fe19be88b61',
  'the installer bytes match the tested package');

// The first screen is the package launcher rather than a Win32 dialog. After
// that one real mouse click, wait for each InstallShield control instead of
// depending on fixed batches. Stop in the same batch as the final Yes click:
// the full 127 MiB copy is an explicitly documented/manual acceptance run,
// not work every aggregate test should repeat.
const input = [
  '1:wait-title:Diablo_II_Shareware_Setup:20000',
  '2:mousedown:130:163',
  '3:mouseup:130:163',
  '4:wait-dlg-control:1:20000',
  '5:dlg-click:1',
  '6:wait-dlg-control:2001:20000',
  '7:keydown:13',
  '8:keyup:13',
  '9:wait-dlg-control:6:20000',
  '10:dlg-click:6',
  '10:stop',
].join(',');

const run = spawnSync(process.execPath, [
  'test/run.js',
  '--app=diablo2_demo_installer',
  '--no-build',
  '--screen=640x480',
  '--max-batches=5000',
  '--batch-size=100000',
  '--stuck-after=1000000',
  '--quiet-api',
  '--quiet-blocks',
  `--input=${input}`,
], {
  cwd: root,
  encoding: 'utf8',
  timeout: 60000,
  maxBuffer: 16 * 1024 * 1024,
});
const output = `${run.stdout || ''}\n${run.stderr || ''}`;
assert.strictEqual(run.error, undefined, run.error && run.error.message);
assert.strictEqual(run.status, 0, output.slice(-6000));
for (const marker of [
  '[input] wait-title: matched "Diablo II Shareware Setup"',
  '[input] wait-dlg-control: matched id=1',
  '[input] dlg-click: id=1',
  '[input] wait-dlg-control: matched id=2001',
  '[input] wait-dlg-control: matched id=6',
  '[input] dlg-click: id=6',
  '[input] stop at batch',
]) {
  assert(output.includes(marker), `missing installer marker ${marker}\n${output.slice(-6000)}`);
}
assert(!/ABANDONED wndproc|unimplemented:|CORRUPT state|RuntimeError:/i.test(output),
  `installer entered a failed compatibility path\n${output.slice(-6000)}`);

console.log('PASS Diablo II setup reaches the real copy phase through deterministic dialogs');
console.log('PASS Diablo II setup avoids fixed-batch dialog timing and pins the installer bytes');
