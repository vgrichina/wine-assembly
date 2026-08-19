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
const SAVE_NAME = 'wordpad-ole-delete-roundtrip.rtf';
const SAVED = path.join(OUT, SAVE_NAME);
const PNG_PATH = path.join(OUT, 'wordpad-ole-delete-roundtrip.png');
const ID_EDIT_COPY = 57634;
const ID_EDIT_PASTE = 57637;
const ID_EDIT_CLEAR = 57632;

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });
for (const file of [SAVED, PNG_PATH]) {
  try { fs.unlinkSync(file); } catch (_) {}
}

function runWordPad(seq, maxBatches) {
  const args = [RUN, `--exe=${EXE}`, `--input=${seq.join(',')}`, `--max-batches=${maxBatches}`,
    '--batch-size=50000', '--quiet-api', '--quiet-blocks', '--no-close'];
  try {
    return execFileSync('node', args, { cwd: ROOT, encoding: 'utf8', timeout: 180000,
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    return String(error.stdout || '') + String(error.stderr || '');
  }
}

const saveSeq = ['70:click:40:150'];
let batch = 74;
for (const ch of 'before ') saveSeq.push(`${batch++}:keypress:${ch.charCodeAt(0)}`);
saveSeq.push('90:seed-cf-dib:initial-paste');
saveSeq.push('125:set-focus-selection:7:8:select-first');
saveSeq.push(`135:menu-edit-command:${ID_EDIT_COPY}:copy-first`);
saveSeq.push('155:set-focus-selection:8:8:append-second');
saveSeq.push(`165:menu-edit-command:${ID_EDIT_PASTE}:paste-second`);
saveSeq.push('205:set-focus-selection:7:8:select-first-for-delete');
saveSeq.push(`215:menu-edit-command:${ID_EDIT_CLEAR}:delete-first`);
saveSeq.push('245:dump-focus-unicode:after-delete');
saveSeq.push('255:0x111:57604'); // File > Save As
saveSeq.push(`310:open-dlg-pick:${SAVE_NAME}`);
saveSeq.push(`405:vfs-export:${SAVE_NAME}:${SAVED}`);
saveSeq.push('425:stop');
const saveOutput = runWordPad(saveSeq, 450);

const reopenSeq = [
  `60:vfs-import:${SAVE_NAME}:${SAVED}`,
  '80:0x111:57601', // File > Open
  `140:open-dlg-pick:${SAVE_NAME}`,
  '260:dump-focus-unicode:after-reopen',
  `280:png-pixels:${PNG_PATH}`,
  '305:stop',
];
const reopenOutput = fs.existsSync(SAVED) ? runWordPad(reopenSeq, 330) : '';
const output = `${saveOutput}\n${reopenOutput}`;
for (const line of output.split('\n')) {
  if (/seed-cf-dib|set-focus-selection|menu-edit-command|dump-focus-unicode|open-dlg-pick|vfs-(?:export|import)|png-pixels|Program exited|CRASH|UNIMPLEMENTED/.test(line)) console.log('  ' + line);
}

const saved = fs.existsSync(SAVED) ? fs.readFileSync(SAVED).toString('latin1') : '';
let red = 0, blue = 0;
if (fs.existsSync(PNG_PATH)) {
  const png = PNG.sync.read(fs.readFileSync(PNG_PATH));
  for (let y = 132; y < Math.min(166, png.height); y++) {
    for (let x = 62; x < Math.min(100, png.width); x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      if (r > 180 && g < 100 && b < 100) red++;
      if (b > 180 && r < 100 && g < 100) blue++;
    }
  }
}
const checks = [
  ['two objects were created before deletion', /menu-edit-command paste-second: .*ret=1/.test(output)],
  ['Clear deleted only the selected first object', /menu-edit-command delete-first: .*ret=1/.test(output) && /dump-focus-unicode after-delete: .*U\+20,U\+FFFC text="before ￼"/.test(output)],
  ['saved RTF contains exactly one DIB presentation', (saved.match(/\\pict\\dibitmap0/gi) || []).length === 1],
  ['fresh WordPad imported and opened the saved document', /vfs-import .*wordpad-ole-delete-roundtrip\.rtf/.test(reopenOutput) && /open-dlg-pick: wordpad-ole-delete-roundtrip\.rtf/.test(reopenOutput)],
  ['reopened document contains exactly one native object', /dump-focus-unicode after-reopen: .*U\+20,U\+FFFC text="before ￼"/.test(reopenOutput)],
  ['remaining object renders after delete/save/reopen', red > 50 && blue > 100],
  ['fresh WordPad remained alive', !/--- Program exited ---/.test(reopenOutput)],
  ['no runtime or unimplemented crash', !/CRASH|UNIMPLEMENTED API:|Unreachable code/.test(output)],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
