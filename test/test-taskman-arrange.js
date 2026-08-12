#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'taskman.exe');
const OUT = path.join(ROOT, 'scratch', 'taskman-arrange');
const cascadePng = path.join(OUT, 'cascade.png');
const tileVerticalPng = path.join(OUT, 'tile-vertical.png');
const tileHorizontalPng = path.join(OUT, 'tile-horizontal.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  taskman.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
for (const file of [cascadePng, tileVerticalPng, tileHorizontalPng]) {
  try { fs.unlinkSync(file); } catch (_) {}
}

const input = [
  '0:wait-title:Tasks:1000',
  '5:dump-listbox:initial',
  '7:click:20:59',
  '8:keydown:17',                    // Ctrl-click the second task
  '8:click:20:75',
  '8:keyup:17',
  '9:dump-listbox:selected',
  '10:post-cmd:408',                 // Cascade
  '25:dump-windows:cascade',
  `25:png:${cascadePng}`,
  '30:post-cmd:410',                 // Tile Vertically
  '45:dump-windows:tile-vertical',
  `45:png:${tileVerticalPng}`,
  '50:post-cmd:409',                 // Tile Horizontally
  '65:dump-windows:tile-horizontal',
  `65:png:${tileHorizontalPng}`,
  '70:post-cmd:412',                 // Minimize
  '85:dump-windows:minimized',
  '90:post-cmd:413',                 // Arrange Minimized Windows
  '105:dump-windows:arranged-icons',
  '110:stop',
].join(',');

let output = '';
let runFailed = false;
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    '--seed-window=Calculator|Untitled - Notepad',
    `--input=${input}`,
    '--max-batches=1100',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
} catch (error) {
  runFailed = true;
  output = `${error.stdout || ''}${error.stderr || ''}`;
}

function windowRows(label) {
  return output.split('\n').filter(line =>
    line.includes(`window:${label}`) && /title="(?:Calculator|Untitled - Notepad)"/.test(line));
}

function geometry(line) {
  const match = line.match(/pos=(-?\d+),(-?\d+) size=(\d+)x(\d+)/);
  return match ? match.slice(1).map(Number) : [];
}

const cascade = windowRows('cascade').map(geometry);
const vertical = windowRows('tile-vertical').map(geometry);
const horizontal = windowRows('tile-horizontal').map(geometry);
const minimized = windowRows('minimized');
const icons = windowRows('arranged-icons').map(geometry);
const screenshots = [cascadePng, tileVerticalPng, tileHorizontalPng]
  .every(file => fs.existsSync(file) && fs.statSync(file).size > 4000);
const checks = [
  ['emulator run completed', !runFailed],
  ['both renderer tasks populate Task Manager',
    /dump-listbox:initial:[^\n]*count=2[^\n]*Untitled - Notepad[^\n]*Calculator/.test(output)],
  ['Ctrl-click selects both task rows through normal pointer input',
    /dump-listbox:selected:[^\n]*selected=0,1/.test(output)],
  ['Cascade offsets both windows', cascade.length === 2 && cascade[0][0] !== cascade[1][0] && cascade[0][1] !== cascade[1][1]],
  ['Tile Vertically gives equal heights and different columns',
    vertical.length === 2 && vertical[0][1] === vertical[1][1] && vertical[0][3] === vertical[1][3] && vertical[0][0] !== vertical[1][0]],
  ['Tile Horizontally gives equal widths and different rows',
    horizontal.length === 2 && horizontal[0][0] === horizontal[1][0] && horizontal[0][2] === horizontal[1][2] && horizontal[0][1] !== horizontal[1][1]],
  ['Minimize hides and marks both selected tasks',
    minimized.length === 2 && minimized.every(line => line.includes('visible=false') && line.includes('minimized=true'))],
  ['Arrange Minimized Windows places both icons along the bottom',
    icons.length === 2 && icons.every(row => row[1] >= 440 && row[2] === 160 && row[3] === 28) && icons[0][0] !== icons[1][0]],
  ['arrangement screenshots were written', screenshots],
  ['no unimplemented API or runtime crash', !/UNIMPLEMENTED API:|RuntimeError|LinkError|\*\*\* CRASH/.test(output)],
];

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) failed++;
}
if (runFailed || failed) console.error(output.slice(-6000));
console.log(`Screenshots: ${OUT}`);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
