#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const SAVE_NAME = 'wordpad-ole-delete-roundtrip.rtf';
const SAVED = path.join(OUT, SAVE_NAME);
const ID_EDIT_COPY = 57634;
const ID_EDIT_PASTE = 57637;
const ID_EDIT_CLEAR = 57632;

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });
for (const file of [SAVED]) {
  try { fs.unlinkSync(file); } catch (_) {}
}

function runWordPad(seq, maxBatches) {
  const args = [RUN, `--exe=${EXE}`, `--input=${seq.join(',')}`, `--max-batches=${maxBatches}`,
    '--batch-size=50000', '--quiet-api', '--quiet-blocks', '--no-close'];
  try {
    return execFileSync('node', args, { cwd: ROOT, encoding: 'utf8', timeout: 180000,
      killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
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

const output = saveOutput;
for (const line of output.split('\n')) {
  if (/seed-cf-dib|set-focus-selection|menu-edit-command|dump-focus-unicode|open-dlg-pick|vfs-(?:export|import)|png-pixels|Program exited|CRASH|UNIMPLEMENTED/.test(line)) console.log('  ' + line);
}

const saved = fs.existsSync(SAVED) ? fs.readFileSync(SAVED).toString('latin1') : '';

function extractWmfPresentations(rtf) {
  const presentations = [];
  const pict = /\\pict\\wmetafile8[^\r\n]*\r?\n([0-9a-f\r\n]+)\}/gi;
  for (const match of rtf.matchAll(pict)) {
    presentations.push(Buffer.from(match[1].replace(/\s/g, ''), 'hex'));
  }
  return presentations;
}

function validDibWmf(wmf) {
  if (wmf.length < 18 || wmf.readUInt16LE(0) !== 1 ||
      wmf.readUInt16LE(2) !== 9 || wmf.readUInt16LE(4) !== 0x300 ||
      wmf.readUInt32LE(6) * 2 !== wmf.length) return false;
  let offset = 18;
  let stretchDib = 0;
  let sawEof = false;
  while (offset + 6 <= wmf.length) {
    const words = wmf.readUInt32LE(offset);
    const bytes = words * 2;
    if (words < 3 || offset + bytes > wmf.length) return false;
    const fn = wmf.readUInt16LE(offset + 4);
    if (fn === 0x0f43) {
      const dib = offset + 28;
      if (dib + 12 > offset + bytes || wmf.readUInt32LE(dib) !== 40 ||
          wmf.readInt32LE(dib + 4) !== 32 || wmf.readInt32LE(dib + 8) !== 24) return false;
      stretchDib++;
    }
    offset += bytes;
    if (fn === 0) { sawEof = true; break; }
  }
  return sawEof && offset === wmf.length && stretchDib === 1;
}

const presentations = extractWmfPresentations(saved);
const checks = [
  ['two objects were created before deletion', /menu-edit-command paste-second: .*ret=1/.test(output)],
  ['Clear deleted only the selected first object', /menu-edit-command delete-first: .*ret=1/.test(output) && /dump-focus-unicode after-delete: .*U\+20,U\+FFFC text="before ￼"/.test(output)],
  ['saved RTF contains exactly one WMF presentation', presentations.length === 1],
  ['remaining WMF contains a complete 32 by 24 StretchDIB record',
    presentations.length === 1 && validDibWmf(presentations[0])],
  ['no runtime or unimplemented crash', !/CRASH|UNIMPLEMENTED API:|Unreachable code/.test(output)],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
