#!/usr/bin/env node
'use strict';

// Copy, cut, and paste a native RichEdit static bitmap through WordPad's Edit
// command bridge. This covers the browser keyboard/menu route, not merely a
// direct WM_PASTE seeded by the harness.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const PNG_PATH = path.join(OUT, 'wordpad-ole-copy-cut-paste.png');
const ID_EDIT_COPY = 57634;
const ID_EDIT_CUT = 57635;
const ID_EDIT_PASTE = 57637;

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });
try { fs.unlinkSync(PNG_PATH); } catch (_) {}

const seq = ['70:click:40:150'];
let batch = 74;
for (const ch of 'before ') seq.push(`${batch++}:keypress:${ch.charCodeAt(0)}`);
seq.push('90:seed-cf-dib:initial-paste');
seq.push('125:dump-focus-state:one-object');
seq.push('135:set-focus-selection:7:8:select-object-copy');
seq.push(`145:menu-edit-command:${ID_EDIT_COPY}:copy-object`);
seq.push('165:dump-clipboard:after-object-copy');
seq.push('175:set-focus-selection:8:8:append-copy');
seq.push(`185:menu-edit-command:${ID_EDIT_PASTE}:paste-copy`);
seq.push('225:dump-focus-state:two-objects');
seq.push('235:set-focus-selection:8:9:select-object-cut');
seq.push(`245:menu-edit-command:${ID_EDIT_CUT}:cut-object`);
seq.push('275:dump-focus-state:after-cut');
seq.push('285:set-focus-selection:8:8:append-cut');
seq.push(`295:menu-edit-command:${ID_EDIT_PASTE}:paste-cut`);
seq.push('340:dump-focus-state:after-cut-paste');
seq.push(`350:png-pixels:${PNG_PATH}`);
seq.push('370:stop');

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=400',
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
  if (/seed-cf-dib|set-focus-selection|menu-edit-command|dump-clipboard|dump-focus-state|png-pixels|UNIMPLEMENTED|CRASH|Program exited/.test(line)) {
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
  ['Edit Copy handled the selected object', new RegExp(`menu-edit-command copy-object: id=${ID_EDIT_COPY} ret=1`).test(output)],
  ['object Copy retained an eager CF_DIB snapshot', /dump-clipboard after-object-copy: .*availDib=1 .*dibHandle=0x[1-9a-f][0-9a-f]*/.test(output)],
  ['Edit Paste duplicated the object position', /dump-focus-state two-objects: .*len=9 .*text="before   "/.test(output)],
  ['Edit Cut removed the selected object', new RegExp(`menu-edit-command cut-object: id=${ID_EDIT_CUT} ret=1`).test(output) && /dump-focus-state after-cut: .*len=8 .*text="before  "/.test(output)],
  ['Edit Paste restored the cut object position', new RegExp(`menu-edit-command paste-cut: id=${ID_EDIT_PASTE} ret=1`).test(output) && /dump-focus-state after-cut-paste: .*len=9 .*text="before   "/.test(output)],
  ['final document renders red bitmap cells', redPixels > 200],
  ['final document renders blue bitmap cells', bluePixels > 200],
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
