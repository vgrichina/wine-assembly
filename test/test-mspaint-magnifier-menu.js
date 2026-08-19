#!/usr/bin/env node
'use strict';

// Paint repaints its status-bar coordinates after Magnifier changes the view.
// That repaint must not overwrite USER's per-window menu state.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUN = path.join(ROOT, 'test', 'run.js');
const EXE = path.join(ROOT, 'test', 'binaries', 'mspaint.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

const input = [
  '25:click:64:121',
  '35:click:230:100',
  '45:wait-title-menu-open:untitled_-_Paint:50:70:file',
  '55:menu-dump:file',
  '56:stop',
].join(',');

let output = '';
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input}`,
    '--max-batches=65',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
} catch (error) {
  output = `${error.stdout || ''}${error.stderr || ''}`;
  assert.fail(`Paint Magnifier menu run failed:\n${output.slice(-4000)}`);
}

const menu = output.split('\n').find(line => line.includes('menu-dump:file:')) || '';
assert(/count=17\b/.test(menu),
  `Paint lost its File menu after Magnifier repainted coordinates:\n${menu}`);
for (const label of ['&New', 'Save &As...', '&Print...', 'E&xit']) {
  assert(menu.includes(`"${label}"`), `Paint File menu lost ${label}`);
}
assert(!/UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH/.test(output),
  'Paint Magnifier triggered an emulator failure');

console.log('PASS  Paint keeps its File menu after Magnifier coordinate repaint');
