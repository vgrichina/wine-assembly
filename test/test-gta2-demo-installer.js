#!/usr/bin/env node
'use strict';

// Full local acceptance for the original GTA2 demo distribution. This does
// not use Unshield: each file consumed below was emitted by the preceding
// authentic executable. Wine Assembly cannot run a child process yet, so the
// self-extractor, Setup.exe bootstrap, and InstallShield engine are resumed as
// three emulator processes at the exact CreateProcess/WinExec boundaries.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INSTALLER = path.join(ROOT, 'test/binaries/candidates/gta2-demo/gta2demo.exe');
const RUN = path.join(ROOT, 'test/run.js');

if (!fs.existsSync(INSTALLER)) {
  console.log('SKIP  original GTA2 demo installer is absent');
  process.exit(0);
}

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.strictEqual(fs.statSync(INSTALLER).size, 12972175);
assert.strictEqual(hash(INSTALLER),
  'f8fc0a9653932f008a03e56ea892fb31dbeb98d228cc4df61b910bcb35d08d21');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-gta2-installer-'));
const stage1 = path.join(work, 'self-extractor');
const stage2 = path.join(work, 'bootstrap');
const stage3 = path.join(work, 'installed');
for (const directory of [stage1, stage2, stage3]) fs.mkdirSync(directory);

function run(label, args, timeout) {
  const result = spawnSync(process.execPath, [RUN, '--no-build', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    maxBuffer: 48 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert.strictEqual(result.error, undefined,
    `${label}: ${result.error && result.error.message}\n${output.slice(-6000)}`);
  assert.strictEqual(result.status, 0, `${label} failed\n${output.slice(-10000)}`);
  assert(!/UNIMPLEMENTED API:|RuntimeError:|CORRUPT state/i.test(output),
    `${label} entered a failed compatibility path\n${output.slice(-10000)}`);
  return output;
}

// Stage 1 is the original 12.9 MB package. It unpacks all 92 split cabinets
// and then reaches CreateProcessA. The expected error dialog is the current
// one-process boundary, not an extraction substitute or installer failure.
const first = run('GTA2 self-extractor', [
  `--exe=${INSTALLER}`,
  '--max-batches=1300', '--batch-size=100000',
  '--quiet-api', '--quiet-blocks', `--save-vfs=${stage1}`,
], 90000);
assert(first.includes('[SetWindowText] "Unpacking GTA2..."'));
assert(first.includes('"C:\\WINDOWS\\TEMP\\pftw3~tmp\\Disk1\\Setup.exe" /SMS'));
const disk1 = path.join(stage1, 'windows/temp/pftw3~tmp/disk1');
const setup = path.join(disk1, 'setup.exe');
assert.strictEqual(hash(setup),
  '5656e87da0641c9dcfcd0ee8949ce72b3fa6a7d0e8b1fd985a16f6bd6c34ce52');
assert(fs.existsSync(path.join(disk1, 'data92.cab')), 'self-extractor emitted the final split cabinet');

// Stage 2 is that emitted Setup.exe. It expands the real InstallShield engine
// and calls WinExec; run.js intentionally reports success without launching a
// nested process, so resume the emitted engine below.
const second = run('GTA2 Setup bootstrap', [
  `--exe=${setup}`, '--args=/SMS', '--vfs-include=**/*',
  '--max-batches=800', '--batch-size=100000',
  '--quiet-api', '--quiet-blocks', '--trace-api=WinExec',
  `--save-vfs=${stage2}`,
], 60000);
assert(second.includes('WinExec(lpCmdLine="C:\\WINDOWS\\TEMP\\_ISTMP1.DIR\\_INS5576._MP"'));
const runtimeDir = path.join(stage2, 'windows/temp/_istmp1.dir');
const engine = path.join(runtimeDir, '_ins5576._mp');
assert.strictEqual(hash(engine),
  'a8657371f03e2e66db951c3dcd3aeb42c576894908ca2eb1b3806aa0404cb083');

// The engine's generated command line names C:\SETUP.INS and C:\ as its
// source media. Materialize exactly that working layout from Setup.exe's own
// output; no cabinet is opened by test code.
for (const name of ['_ins5576._mp', 'zdatai51.dll', '_wutl951.dll', '_ins0432.ini']) {
  fs.copyFileSync(path.join(runtimeDir, name), path.join(stage2, name));
}
const engineArgs = '/SMS -fC:\\SETUP.INS -z1 -cx ' +
  '-xC:\\WINDOWS\\TEMP\\_ISTMP1.DIR -x1"C:\\" -q10009';
const input = [
  '1:wait-title:GTA2_Installer:1500',
  '2:wait-dlg-control:1:500', '3:dlg-click:1',
  '4:wait-dlg-control:196:1000', '5:dlg-click:1',
  '6:wait-dlg-control:301:1000', '7:dlg-click:1',
].join(',');
const third = run('GTA2 InstallShield wizard', [
  `--exe=${path.join(stage2, '_ins5576._mp')}`, `--args=${engineArgs}`,
  `--dll-seed=${path.join(stage2, 'zdatai51.dll')}`,
  `--dll-seed=${path.join(stage2, '_wutl951.dll')}`,
  '--vfs-include=**/*', '--max-batches=14000', '--batch-size=100000',
  '--quiet-api', '--quiet-blocks', `--input=${input}`, `--save-vfs=${stage3}`,
], 180000);
for (const marker of [
  '[input] wait-title: matched "GTA2 Installer"',
  '[SetWindowText] "Copying GTA2 files..."',
  'The GTA2 Installer has finished installing GTA2 on your computer.',
  'The GTA2 Installer can now launch GTA2.',
]) {
  assert(third.includes(marker), `missing authentic installer marker: ${marker}`);
}

const installed = path.join(stage3, 'program files/gta2 demo');
const installedFiles = [];
(function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile()) installedFiles.push(file);
  }
})(installed);
assert.strictEqual(installedFiles.length, 74,
  'InstallShield writes 73 demo payload files plus uninst.isu');
assert.strictEqual(hash(path.join(installed, 'gta2.exe')),
  '97ad743b6ec9ea1be95282053c3127084acd764a7f37a3e57e2268af52d02ae3');
assert.strictEqual(hash(path.join(installed, 'mss32.dll')),
  '0974b244354a5d13e0711db15430c05f7949dc279b63897146f304d1401153fc');
assert(fs.existsSync(path.join(installed, 'data/wildemo.gmp')));

console.log('PASS  original gta2demo.exe emits and runs both authentic installer stages');
console.log('PASS  InstallShield finishes and writes the complete hash-pinned GTA2 demo');
