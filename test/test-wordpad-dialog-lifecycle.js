#!/usr/bin/env node
'use strict';

// Open and close every non-OLE dialog reachable from WordPad's menus. Each
// case gets a fresh process so a broken modal loop cannot mask later cases.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

const build = spawnSync('bash', ['tools/build.sh'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 24 * 1024 * 1024,
});
if (build.status !== 0 || build.signal || build.error) {
  process.stdout.write(build.stdout || '');
  process.stderr.write(build.stderr || '');
  console.log(`FAIL  build status=${build.status} signal=${build.signal || 'none'} error=${build.error ? build.error.message : 'none'}`);
  process.exit(1);
}

const cases = [
  { name: 'File New', command: 57600, close: 2 },
  { name: 'File Open', command: 57601, close: 2 },
  { name: 'File Save As', command: 57604, close: 2 },
  { name: 'File Print', command: 57607, close: 2 },
  { name: 'File Page Setup', command: 32771, close: 2 },
  { name: 'View Options', command: 32776, close: 2 },
  { name: 'Edit Find', command: 57636, close: 2, needsText: true },
  { name: 'Edit Replace', command: 57641, close: 2, needsText: true },
  { name: 'Insert Date and Time', command: 32778, close: 2 },
  { name: 'Format Font', command: 57696, close: 2 },
  { name: 'Format Paragraph', command: 32780, close: 2 },
  { name: 'Format Tabs', command: 32781, close: 2 },
  { name: 'Help About WordPad', command: 57664, close: 1 },
];

function runDialog(testCase) {
  const input = [
    ...(testCase.needsText ? ['66:click:40:150', '67:keypress:120'] : []),
    `70:0x111:${testCase.command}`,
    '94:dlg-dump:open',
    `98:dlg-click:${testCase.close}`,
    '112:dlg-dump:closed',
    '114:dump-windows:after',
    '118:stop',
  ].join(',');
  const result = spawnSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input}`,
    '--max-batches=135',
    '--batch-size=50000',
    '--quiet-api',
    '--quiet-blocks',
    '--no-close',
    '--no-build',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 24 * 1024 * 1024,
  });
  return {
    result,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

let failed = 0;
let skipped = 0;
for (const testCase of cases) {
  if (testCase.skip) {
    skipped++;
    console.log(`SKIP  ${testCase.name}: ${testCase.skip}`);
    continue;
  }
  const { result, output } = runDialog(testCase);
  const completed = result.status === 0 && !result.signal && !result.error;
  const opened = /dlg-dump:open: dlg=0x[0-9a-f]+/i.test(output);
  const closeSent = new RegExp(`dlg-click: id=${testCase.close} hwnd=0x[0-9a-f]+`, 'i').test(output);
  const closed = /dlg-dump:closed: dlg=none modal=none/.test(output);
  const mainReady = /window:after hwnd=65537 .*visible=true.*enabled=true.*title="[^"]*WordPad"/.test(output);
  const healthy = !/UNIMPLEMENTED API:|CRASH|CompileError|RuntimeError|Unreachable code|EIP=0x00000000/.test(output);
  const pass = completed && opened && closeSent && closed && mainReady && healthy;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${testCase.name} opens, closes, and returns to WordPad`);
  if (!pass) {
    failed++;
    for (const line of output.split('\n')) {
      if (/dlg-dump:|dlg-click:|window:after hwnd=65537 |UNIMPLEMENTED API:|CRASH|CompileError|RuntimeError|Unreachable code|EIP=0x00000000/.test(line)) {
        console.log(`  ${line}`);
      }
    }
    if (!completed) {
      console.log(`  process status=${result.status} signal=${result.signal || 'none'} error=${result.error ? result.error.message : 'none'}`);
    }
  }
}

const attempted = cases.length - skipped;
console.log(`\n${attempted - failed}/${attempted} dialog lifecycles passed; ${skipped} skipped`);
process.exit(failed ? 1 : 0);
