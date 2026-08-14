#!/usr/bin/env node

// Paint customizes the stock ChooseColor dialog through a CC_ENABLEHOOK
// callback. In particular, its WM_INITDIALOG hook changes the caption from
// "Color" to "Edit Colors".

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'mspaint.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

const input = [
  '20:wait-title-command:untitled_-_Paint:55:6869:colors',
  '31:dump-windows:colors',
  '32:dlg-click:1122',
  '33:dump-windows:expanded',
  '34:dlg-click:2',
  '35:dump-windows:closed',
  '36:stop',
].join(',');

let output = '';
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input}`,
    '--max-batches=42',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
} catch (error) {
  output = `${error.stdout || ''}${error.stderr || ''}`;
  assert.fail(`Paint Edit Colors run failed:\n${output.slice(-4000)}`);
}

assert(output.includes('[SetWindowText] "Edit Colors"'),
  'Paint ChooseColor WM_INITDIALOG hook did not run');
const dialogLine = output.split('\n').find(line =>
  line.includes('window:colors') && line.includes('dialog=true')) || '';
assert(dialogLine.includes('title="Edit Colors"'),
  'Paint Edit Colors dialog did not expose the hook-provided caption');
const expandedLine = output.split('\n').find(line =>
  line.includes('window:expanded') && line.includes('dialog=true')) || '';
assert(expandedLine.includes('size=436x330'),
  `Paint Define Custom Colors did not expand the dialog: ${expandedLine}`);
assert(/dlg-click: id=1122/.test(output),
  'Paint Define Custom Colors button was not handled');
assert(/dlg-click: id=2/.test(output), 'Paint Edit Colors Cancel button was not handled');
assert(!output.split('\n').some(line =>
  line.includes('window:closed') && line.includes('dialog=true')),
  'Paint Edit Colors remained visible after Cancel');
assert(!/UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH/.test(output),
  'Paint Edit Colors hook triggered an emulator failure');

console.log('PASS  Paint Edit Colors runs its common-dialog hook and closes cleanly');
