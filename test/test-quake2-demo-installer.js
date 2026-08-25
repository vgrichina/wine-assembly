#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const installer = path.join(root,
  'test/binaries/candidates/quake-2-demo-installer/q2-314-demo-x86.exe');
const installedRoot = path.join(root,
  'test/binaries/candidates/quake-2-demo-installer/installed-extracted/Install/Data');

if (!fs.existsSync(installer)) {
  console.log('SKIP Quake II local demo installer is not present');
  process.exit(0);
}

const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.strictEqual(fs.statSync(installer).size, 39015499,
  'the installer is the pinned q2-314-demo-x86 package');
assert.strictEqual(digest(installer),
  '7ace5a43983f10d6bdc9d9b6e17a1032ba6223118d389bd170df89b945a04a1e',
  'the installer bytes match the tested package');

// A raw queued WM_COMMAND exercises the guest's ordinary message pump. Using
// dlg-click here would synchronously re-enter the x86 WndProc from the host;
// decompression legitimately outlives that bridge's bounded safety loop.
const run = spawnSync(process.execPath, [
  'test/run.js',
  '--app=quake2_demo_installer',
  '--no-build',
  '--screen=800x600',
  '--max-batches=25',
  '--batch-size=20000',
  '--stuck-after=1000',
  '--repaint-every=1000',
  '--input=5:0x111:1',
], {
  cwd: root,
  encoding: 'utf8',
  timeout: 60000,
  maxBuffer: 16 * 1024 * 1024,
});
const output = `${run.stdout || ''}\n${run.stderr || ''}`;
assert.strictEqual(run.error, undefined, run.error && run.error.message);
assert.strictEqual(run.status, 0, output.slice(-4000));
for (const marker of [
  'WinZip Self-Extractor [q2-314-demo-x86.exe]',
  '[input] injected msg=0x111 wParam=0x1 at batch 5',
  '[API] OemToCharBuffA',
  '[API] DialogBoxIndirectParamA',
  '[API] GetWindowWord',
  '[API] _lwrite',
]) {
  assert(output.includes(marker), `missing installer marker ${marker}\n${output.slice(-4000)}`);
}
assert(!/ABANDONED wndproc|unimplemented:|CORRUPT state|RuntimeError:/i.test(output),
  `installer entered a failed compatibility path\n${output.slice(-4000)}`);

// The local extracted payload is also the dropdown's launch source. Pin the
// large archive here: a truncated extraction can otherwise look plausible
// until a map load reaches the missing tail.
const pak = path.join(installedRoot, 'baseq2/pak0.pak');
if (fs.existsSync(pak)) {
  assert.strictEqual(fs.statSync(pak).size, 49951322);
  assert.strictEqual(digest(pak),
    'cae257182f34d3913f3d663e1d7cf865d668feda6af393d4ecf3e9e408b48d09');
}

console.log('PASS Quake II WinZip setup starts extraction through the guest message queue');
console.log('PASS Quake II setup avoids nested-WndProc abandonment and pins the complete PAK');
