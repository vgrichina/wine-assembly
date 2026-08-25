#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const SAVE_NAME = 'wordpad-ole-roundtrip.rtf';
const SAVED = path.join(OUT, SAVE_NAME);
const ID_EDIT_COPY = 57634;
const ID_EDIT_PASTE = 57637;

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });
for (const file of [SAVED]) {
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
      killSignal: 'SIGKILL',
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
saveSeq.push('135:set-focus-selection:7:8:select-object');
saveSeq.push(`145:menu-edit-command:${ID_EDIT_COPY}:copy-object`);
saveSeq.push('165:set-focus-selection:8:8:append-object');
saveSeq.push(`175:menu-edit-command:${ID_EDIT_PASTE}:paste-object`);
saveSeq.push('215:dump-focus-unicode:before-save');
saveSeq.push('230:0x111:57604'); // File > Save As
saveSeq.push(`285:open-dlg-pick:${SAVE_NAME}`);
saveSeq.push(`390:vfs-export:${SAVE_NAME}:${SAVED}`);
saveSeq.push('410:stop');
const saveOutput = runWordPad(saveSeq, 440);

const output = saveOutput;

for (const line of output.split('\n')) {
  if (/seed-cf-dib|set-focus-selection|menu-edit-command|dump-focus-(?:text|unicode)|open-dlg-pick|vfs-(?:export|import)|png-pixels|Program exited|CRASH|UNIMPLEMENTED/.test(line)) {
    console.log('  ' + line);
  }
}

const saved = fs.existsSync(SAVED) ? fs.readFileSync(SAVED) : Buffer.alloc(0);
const savedText = saved.toString('latin1');
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

const presentations = extractWmfPresentations(savedText);

const escapedName = SAVE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const checks = [
  ['CF_DIB paste was queued into focused RichEdit', /seed-cf-dib paste: .*owned=0x[1-9a-f][0-9a-f]* queued=1/.test(saveOutput)],
  ['native RichEdit inserted one object position before save', /dump-focus-text after-paste: .*len=8 text="before  "/.test(saveOutput)],
  ['Copy/Paste created two native objects before save', /dump-focus-unicode before-save: .*U\+FFFC,U\+FFFC/.test(saveOutput)],
  ['Save As accepted the RTF filename', new RegExp(`open-dlg-pick: ${escapedName}`).test(saveOutput)],
  ['saved file was exported from VFS', saved.length > 0],
  ['saved document is RTF', /^\{\\rtf/i.test(savedText)],
  ['saved RTF contains two WMF presentations', presentations.length === 2],
  ['both WMFs contain a complete 32 by 24 StretchDIB record',
    presentations.length === 2 && presentations.every(validDibWmf)],
  ['no runtime or unimplemented crash', !/CRASH|UNIMPLEMENTED API:|Unreachable code/.test(output)],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
