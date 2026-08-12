#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const SAVE_NAME = 'wordpad-ole-roundtrip.rtf';
const SAVED = path.join(OUT, SAVE_NAME);
const REOPEN_PNG = path.join(OUT, 'wordpad-ole-roundtrip-reopened.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });
for (const file of [SAVED, REOPEN_PNG]) {
  try { fs.unlinkSync(file); } catch (_) {}
}

function runWordPad(seq, maxBatches) {
  const args = [
    RUN,
    `--exe=${EXE}`,
    `--input=${seq.join(',')}`,
    `--max-batches=${maxBatches}`,
    '--batch-size=50000',
    '--quiet-api',
    '--quiet-blocks',
    '--no-close',
  ];
  try {
    return execFileSync('node', args, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    return String(error.stdout || '') + String(error.stderr || '');
  }
}

const saveSeq = ['70:click:40:150'];
let batch = 74;
for (const ch of 'before ') saveSeq.push(`${batch++}:keypress:${ch.charCodeAt(0)}`);
saveSeq.push('90:seed-cf-dib:paste');
saveSeq.push('125:dump-focus-text:after-paste');
saveSeq.push('150:0x111:57604'); // File > Save As
saveSeq.push(`205:open-dlg-pick:${SAVE_NAME}`);
saveSeq.push(`300:vfs-export:${SAVE_NAME}:${SAVED}`);
saveSeq.push('320:stop');
const saveOutput = runWordPad(saveSeq, 350);

const reopenSeq = [
  `60:vfs-import:${SAVE_NAME}:${SAVED}`,
  '80:0x111:57601', // File > Open
  `140:open-dlg-pick:${SAVE_NAME}`,
  '260:dump-focus-text:after-reopen',
  `285:png-pixels:${REOPEN_PNG}`,
  '310:stop',
];
const reopenOutput = fs.existsSync(SAVED) ? runWordPad(reopenSeq, 340) : '';
const output = `${saveOutput}\n${reopenOutput}`;

for (const line of output.split('\n')) {
  if (/seed-cf-dib|dump-focus-text|open-dlg-pick|vfs-(?:export|import)|png-pixels|Program exited|CRASH|UNIMPLEMENTED/.test(line)) {
    console.log('  ' + line);
  }
}

const saved = fs.existsSync(SAVED) ? fs.readFileSync(SAVED) : Buffer.alloc(0);
const savedText = saved.toString('latin1');
let redPixels = 0;
let bluePixels = 0;
if (fs.existsSync(REOPEN_PNG)) {
  const png = PNG.sync.read(fs.readFileSync(REOPEN_PNG));
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    if (r > 180 && g < 100 && b < 100) redPixels++;
    if (b > 180 && r < 100 && g < 100) bluePixels++;
  }
}
console.log(`  reopened bitmap pixels: red=${redPixels} blue=${bluePixels}`);

const escapedName = SAVE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const checks = [
  ['CF_DIB paste was queued into focused RichEdit', /seed-cf-dib paste: .*owned=0x[1-9a-f][0-9a-f]* queued=1/.test(saveOutput)],
  ['native RichEdit inserted one object position before save', /dump-focus-text after-paste: .*len=8 text="before  "/.test(saveOutput)],
  ['Save As accepted the RTF filename', new RegExp(`open-dlg-pick: ${escapedName}`).test(saveOutput)],
  ['saved file was exported from VFS', saved.length > 0],
  ['saved document is RTF', /^\{\\rtf/i.test(savedText)],
  ['saved RTF contains DIB presentation data', /\\pict\\dibitmap0/i.test(savedText)],
  ['saved RTF records the 32 by 24 bitmap dimensions', /\\picw32\\pich24/i.test(savedText)],
  ['fresh WordPad imported the saved document', /vfs-import .*wordpad-ole-roundtrip\.rtf/.test(reopenOutput)],
  ['fresh WordPad accepted the Open filename', new RegExp(`open-dlg-pick: ${escapedName}`).test(reopenOutput)],
  ['reopened document restores the inline object position', /dump-focus-text after-reopen: .*len=8 text="before  "/.test(reopenOutput)],
  ['reopened document renders the red bitmap cells', redPixels > 100],
  ['reopened document renders the blue bitmap cells', bluePixels > 100],
  ['fresh WordPad remained alive through reopen', !/--- Program exited ---/.test(reopenOutput)],
  ['no runtime or unimplemented crash', !/CRASH|UNIMPLEMENTED API:|Unreachable code/.test(output)],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
