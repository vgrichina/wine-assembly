#!/usr/bin/env node
'use strict';

// A retained CF_DIB must not make an ordinary one-space selection behave like
// an object. The native UTF-16 selection discriminator keeps this path textual.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const ID_EDIT_COPY = 57634;
const ID_EDIT_PASTE = 57637;

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

const seq = ['70:click:40:150'];
let batch = 74;
for (const ch of 'before ') seq.push(`${batch++}:keypress:${ch.charCodeAt(0)}`);
seq.push('90:seed-cf-dib:initial-paste');
seq.push('125:set-focus-selection:6:7:select-real-space');
seq.push(`135:menu-edit-command:${ID_EDIT_COPY}:copy-real-space`);
seq.push('155:dump-clipboard:after-real-space-copy');
seq.push('165:set-focus-selection:8:8:append-real-space');
seq.push(`175:menu-edit-command:${ID_EDIT_PASTE}:paste-real-space`);
seq.push('210:dump-focus-state:after-real-space-paste');
seq.push('220:dump-focus-unicode:after-real-space-paste-unicode');
seq.push('230:stop');

let output = '';
try {
  output = execFileSync('node', [
    RUN,
    `--exe=${EXE}`,
    `--input=${seq.join(',')}`,
    '--max-batches=250',
    '--batch-size=50000',
    '--quiet-api',
    '--quiet-blocks',
    '--no-close',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (error) {
  output = String(error.stdout || '') + String(error.stderr || '');
}

for (const line of output.split('\n')) {
  if (/seed-cf-dib|set-focus-selection|menu-edit-command|dump-clipboard|dump-focus-state|dump-focus-unicode|UNIMPLEMENTED|CRASH|Program exited/.test(line)) {
    console.log('  ' + line);
  }
}

const checks = [
  ['ordinary one-space Copy clears the prior CF_DIB format', /dump-clipboard after-real-space-copy: .*textLen=1 .*availText=1 .*availDib=0 .*textHandle=0x[1-9a-f][0-9a-f]*/.test(output)],
  ['ordinary space pastes as text beside the original object', /dump-focus-state after-real-space-paste: .*len=9 .*text="before   "/.test(output)],
  ['only the original position is a native RichEdit object', /dump-focus-unicode after-real-space-paste-unicode: .*U\+20,U\+FFFC,U\+20/.test(output)],
  ['WordPad remained alive', !/--- Program exited ---/.test(output)],
  ['no runtime or unimplemented crash', !/CRASH|UNIMPLEMENTED API:|Unreachable code/.test(output)],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
