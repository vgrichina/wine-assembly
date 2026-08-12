#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'mplay32.exe');
const MSVCRT = path.join(__dirname, 'binaries', 'dlls', 'msvcrt.dll');
const COMCTL32 = path.join(__dirname, 'binaries', 'dlls', 'comctl32.dll');
const MIDI = path.join(__dirname, 'binaries', 'pinball', 'PINBALL.MID');
const OUT = path.join(ROOT, 'scratch', 'mplay32-dual-mode');

for (const file of [EXE, MSVCRT, COMCTL32, MIDI]) {
  if (!fs.existsSync(file)) {
    console.log('SKIP  missing fixture:', file);
    process.exit(0);
  }
}
fs.mkdirSync(OUT, { recursive: true });

function runMode(name, dlls, openBatch) {
  const png = path.join(OUT, `${name}.png`);
  try { fs.unlinkSync(png); } catch (_) {}
  const pickBatch = openBatch + 60;
  const input = [
    `8:vfs-import:PINBALL.MID:${MIDI}`,
    `${openBatch}:wait-title-command:Media_Player:800:100:open`,
    `${pickBatch}:open-dlg-pick:PINBALL.MID`,
    `${pickBatch + 30}:dump-windows:${name}`,
    `${pickBatch + 35}:dump-toolbar:${name}`,
    `${pickBatch + 40}:click:31:79`,
    `${pickBatch + 55}:png:${png}`,
    `${pickBatch + 65}:0x10:0`,
  ].join(',');
  try {
    const output = execFileSync(process.execPath, [
      RUN,
      `--exe=${EXE}`,
      `--dlls=${dlls.join(',')}`,
      `--input=${input}`,
      `--max-batches=${pickBatch + 70}`,
      '--batch-size=1000',
      '--no-close',
      '--quiet-api',
      '--quiet-blocks',
    ], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    return { name, output, png, failed: false };
  } catch (error) {
    return {
      name,
      output: `${error.stdout || ''}${error.stderr || ''}`,
      png,
      failed: true,
    };
  }
}

const wat = runMode('wat', [MSVCRT], 140);
const native = runMode('native', [MSVCRT, COMCTL32], 160);
const runs = [wat, native];
const checks = [];
const check = (name, pass) => checks.push([name, !!pass]);

for (const run of runs) {
  check(`${run.name}: emulator run completed`, !run.failed);
  check(`${run.name}: MIDI file opened`, /\[MCI\] open sequencer id=1 element="PINBALL\.MID" notes=14139/.test(run.output));
  check(`${run.name}: stable stopped title rendered`, /title="PINBALL\.MID - Media Player \(stopped\)"/.test(run.output));
  check(`${run.name}: Play reaches MCI`, /\[MCI\] play sequencer id=1 element="PINBALL\.MID" notes=14139/.test(run.output));
  check(`${run.name}: screenshot written`, fs.existsSync(run.png) && fs.statSync(run.png).size > 4000);
  check(`${run.name}: WM_CLOSE exits cleanly`, /\[Exit\] code=0/.test(run.output));
  check(`${run.name}: no runtime crash`, !/UNIMPLEMENTED API:|RuntimeError|LinkError|\*\*\* CRASH|STUCK at EIP/.test(run.output));
}

check('WAT: trackbar uses built-in class and owns a painted surface',
  /window:wat[^\n]*class="msctls_trackbar32" ctrlClass=19[^\n]*hasBack=true/.test(wat.output));
check('WAT: transport toolbar keeps Play enabled after open',
  /toolbar:wat:[^\n]*#0 ok=1\/1 img=0 cmd=501 state=0x4/.test(wat.output));
check('WAT: toolbar uses Win98 padded 23x22 transport faces',
  /toolbar:wat:[^\n]*#0[^\n]*rect=2,2,25,24/.test(wat.output));
check('native: loaded comctl32 owns toolbar and trackbar classes',
  /window:native[^\n]*class="msctls_trackbar32" ctrlClass=0[^\n]*hasBack=true/.test(native.output) &&
  /window:native[^\n]*class="ToolbarWindow32" ctrlClass=0/.test(native.output));

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) failed++;
}
if (failed) {
  for (const run of runs) console.error(`\n--- ${run.name} tail ---\n${run.output.slice(-5000)}`);
}
console.log(`Screenshots: ${OUT}`);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
