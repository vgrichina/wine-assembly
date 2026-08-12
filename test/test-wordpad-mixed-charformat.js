#!/usr/bin/env node
// A selected subrange with explicit 24pt formatting must report 24pt, while a
// selection spanning that run plus default-size text must remain mixed.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

const text = 'small large';
const seq = ['70:click:40:150'];
let batch = 74;
for (const ch of text) seq.push(`${batch++}:keypress:${ch.charCodeAt(0)}`);
seq.push('92:keydown:36'); // Home
seq.push('93:keyup:36');
seq.push('96:keydown:16');
for (let i = 0; i < 5; i++) {
  seq.push(`${97 + i * 2}:keydown:39`); // Shift+Right selects "small"
  seq.push(`${98 + i * 2}:keyup:39`);
}
seq.push('108:keyup:16');
seq.push('112:dump-focus-state:small-selected');
seq.push('116:set-focus-charformat-size:480:small-24pt');
seq.push('122:dump-focus-charformat:small-only');
seq.push('128:keydown:17');
seq.push('129:keydown:65');
seq.push('130:keyup:65');
seq.push('131:keyup:17');
seq.push('136:dump-focus-state:mixed-selected');
seq.push('140:dump-focus-charformat:mixed');
seq.push('145:stop');

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=210',
  '--batch-size=50000',
  '--quiet-api',
  '--no-close',
];

let output = '';
let timedOut = false;
try {
  output = execFileSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
  });
} catch (error) {
  timedOut = error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT';
  output = `${error.stdout || ''}${error.stderr || ''}`;
}

const line = label => output.split('\n').find(value =>
  value.includes(`dump-focus-charformat ${label}:`)) || '';
const small = line('small-only');
const mixed = line('mixed');
const mixedState = output.split('\n').find(value =>
  value.includes('dump-focus-state mixed-selected:')) || '';
const checks = [
  ['emulator run completed', !timedOut],
  ['only first word selected', /small-selected: .*sel=0\.\.5 .*text="small large"/.test(output)],
  ['24pt size applied to selected word', /small-24pt: .*twips=480 .*ret=0x1/.test(output)],
  ['uniform formatted selection reports 24pt', /yHeight=480/.test(small)],
  ['whole document selected', /mixed-selected: .*sel=0\.\.1[12] .*text="small large"/.test(output)],
  ['mixed-size selection is not reported as uniform 24pt', !/yHeight=480/.test(mixed)],
  ['no unimplemented API or runtime crash', !/UNIMPLEMENTED API:|RuntimeError|Unreachable code|\*\*\* CRASH/.test(output)],
];

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) failed++;
}
if (failed) {
  console.log(`small: ${small}`);
  console.log(`mixed: ${mixed}`);
  console.log(`mixed state: ${mixedState}`);
}
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
