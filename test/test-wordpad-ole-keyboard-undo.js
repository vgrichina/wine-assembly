#!/usr/bin/env node
'use strict';

// Exercise the browser-style Ctrl+C/X/V route for an inline static bitmap,
// then undo the object deletion through WordPad's real Ctrl+Z accelerator.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const PNG_PATH = path.join(OUT, 'wordpad-ole-keyboard-undo.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });
try { fs.unlinkSync(PNG_PATH); } catch (_) {}

function ctrl(batch, vk) {
  return [
    `${batch}:keydown:17`,
    `${batch + 1}:keydown:${vk}`,
    `${batch + 2}:keyup:${vk}`,
    `${batch + 3}:keyup:17`,
  ];
}

const seq = ['70:click:40:150'];
let batch = 74;
for (const ch of 'before ') seq.push(`${batch++}:keypress:${ch.charCodeAt(0)}`);
seq.push('90:seed-cf-dib:initial-paste');
seq.push('125:dump-focus-state:one-object');
seq.push('135:set-focus-selection:7:8:select-object-copy');
seq.push(...ctrl(145, 67)); // Ctrl+C
seq.push('165:dump-clipboard:after-object-copy');
seq.push('175:set-focus-selection:8:8:append-copy');
seq.push(...ctrl(185, 86)); // Ctrl+V
seq.push('225:dump-focus-state:two-objects');
seq.push('235:set-focus-selection:8:9:select-object-cut');
seq.push(...ctrl(245, 88)); // Ctrl+X
seq.push('275:dump-focus-state:after-cut');
seq.push(...ctrl(285, 90)); // Ctrl+Z
seq.push('325:dump-focus-state:after-undo');
seq.push(`335:png-pixels:${PNG_PATH}`);
seq.push('355:stop');

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=380',
  '--batch-size=50000',
  '--quiet-api',
  '--quiet-blocks',
  '--no-close',
];

let output = '';
try {
  output = execFileSync('node', args, {
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
  if (/seed-cf-dib|set-focus-selection|dump-clipboard|dump-focus-state|png-pixels|UNIMPLEMENTED|CRASH|Program exited/.test(line)) {
    console.log('  ' + line);
  }
}

let redPixels = 0;
let bluePixels = 0;
if (fs.existsSync(PNG_PATH)) {
  const png = PNG.sync.read(fs.readFileSync(PNG_PATH));
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    if (r > 180 && g < 100 && b < 100) redPixels++;
    if (b > 180 && r < 100 && g < 100) bluePixels++;
  }
}
console.log(`  bitmap pixels: red=${redPixels} blue=${bluePixels}`);

const checks = [
  ['initial bitmap inserted one object position', /dump-focus-state one-object: .*len=8 .*text="before  "/.test(output)],
  ['Ctrl+C retained an eager CF_DIB snapshot', /dump-clipboard after-object-copy: .*availDib=1 .*dibHandle=0x[1-9a-f][0-9a-f]*/.test(output)],
  ['Ctrl+V duplicated the inline object', /dump-focus-state two-objects: .*len=9 .*text="before   "/.test(output)],
  ['Ctrl+X removed the selected inline object', /dump-focus-state after-cut: .*len=8 .*text="before  "/.test(output)],
  ['Ctrl+Z restored the cut inline object', /dump-focus-state after-undo: .*len=9 .*text="before   "/.test(output)],
  ['undo-restored document renders red bitmap cells', redPixels > 200],
  ['undo-restored document renders blue bitmap cells', bluePixels > 200],
  ['screenshot written', fs.existsSync(PNG_PATH) && fs.statSync(PNG_PATH).size > 0],
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
