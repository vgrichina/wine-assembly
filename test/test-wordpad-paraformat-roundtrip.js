#!/usr/bin/env node
// Regression coverage for basic WordPad/RichEdit paragraph-format RTF:
// apply PARAFORMAT2 numbering/indents/tab stop directly to the focused native
// RichEdit child, Save As .rtf, File New, reopen the saved file, then verify
// both the saved RTF controls and reopened EM_GETPARAFORMAT state.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const RUN_LOG = path.join(OUT_DIR, 'paraformat-roundtrip-run.log');
const RUN_ERR = path.join(OUT_DIR, 'paraformat-roundtrip-run.err.log');
const VFS_OUT = path.join(OUT_DIR, 'paraformat-roundtrip-vfs');
const SAVE_NAME = 'wordpad-para-basic.rtf';
const SAVED_RTF = path.join(VFS_OUT, 'windows', SAVE_NAME);

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.rmSync(VFS_OUT, { recursive: true, force: true });
fs.rmSync(RUN_LOG, { force: true });
fs.rmSync(RUN_ERR, { force: true });

const seq = [
  '70:click:40:150',
  '74:keypress:112',
  '75:keypress:97',
  '76:keypress:114',
  '77:keypress:97',
  '82:dump-focus-state:typed',
  '86:keydown:17',
  '87:keydown:65',
  '88:keyup:65',
  '89:keyup:17',
  '94:dump-focus-state:selected',
  '98:set-focus-paraformat-basic:1:720:360:-240:1440:applied',
  '106:dump-focus-paraformat:applied',
  '120:0x111:57604',
  `170:open-dlg-pick:${SAVE_NAME}`,
  '230:dump-focus-paraformat:after-save',
  '250:0x111:57600',
  '280:dlg-cmd:1',
  '320:dump-focus-text:after-new',
  '350:0x111:57601',
  `400:open-dlg-pick:${SAVE_NAME}`,
  '430:dump-focus-text:after-open',
  '435:keydown:17',
  '436:keydown:65',
  '437:keyup:65',
  '438:keyup:17',
  '445:dump-focus-state:after-reopen-selected',
  '445:dump-focus-paraformat:after-reopen',
  '445:stop',
];

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=470',
  '--batch-size=50000',
  '--quiet-blocks',
  '--quiet-api',
  '--no-close',
  `--save-vfs=${VFS_OUT}`,
];

console.log('$ node ' + args.map(a => JSON.stringify(a)).join(' '));

let out = '';
let run = null;
let outFd = null;
let errFd = null;
try {
  outFd = fs.openSync(RUN_LOG, 'w');
  errFd = fs.openSync(RUN_ERR, 'w');
  run = spawnSync('node', args, {
    cwd: ROOT,
    timeout: 180000,
    stdio: ['ignore', outFd, errFd],
  });
} finally {
  if (outFd !== null) fs.closeSync(outFd);
  if (errFd !== null) fs.closeSync(errFd);
  out = (fs.existsSync(RUN_LOG) ? fs.readFileSync(RUN_LOG, 'utf8') : '') +
    (fs.existsSync(RUN_ERR) ? fs.readFileSync(RUN_ERR, 'utf8') : '');
}

if (run && (run.error || run.status !== 0 || run.signal)) {
  console.log('(run.js exited non-zero or timed out - output captured)');
}

const interesting = out.split('\n').filter(l =>
  l.includes('ShowWindow') ||
  l.includes('dump-focus-text') ||
  l.includes('dump-focus-state') ||
  l.includes('set-focus-paraformat') ||
  l.includes('dump-focus-paraformat') ||
  l.includes('open-dlg-pick') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH') ||
  l.includes('Unreachable code'));
for (const l of interesting) console.log('  ' + l);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function line(label, kind = 'dump-focus-paraformat') {
  const prefix = `${kind} ${label}:`;
  return out.split('\n').find(l => l.includes(prefix)) || '';
}

function hasParaFields(l) {
  return /numbering=1/.test(l) &&
    /dxStartIndent=720/.test(l) &&
    /dxRightIndent=360/.test(l) &&
    /dxOffset=-240/.test(l) &&
    /alignment=1/.test(l) &&
    /tabCount=1/.test(l) &&
    /tab0=1440/.test(l);
}

const picks = (out.match(new RegExp(`open-dlg-pick: ${escapeRe(SAVE_NAME)}`, 'g')) || []).length;
const typed = line('typed', 'dump-focus-state');
const selected = line('selected', 'dump-focus-state');
const appliedSet = line('applied', 'set-focus-paraformat-basic');
const applied = line('applied');
const afterSave = line('after-save');
const afterNew = line('after-new', 'dump-focus-text');
const afterOpen = line('after-open', 'dump-focus-text');
const selectedReopen = line('after-reopen-selected', 'dump-focus-state');
const afterReopen = line('after-reopen');
const savedRtf = fs.existsSync(SAVED_RTF) ? fs.readFileSync(SAVED_RTF, 'latin1') : '';

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

check('WordPad reached ShowWindow', /ShowWindow\] hwnd=0x10001/.test(out));
check('typed text reached native RichEdit', /text="para"/.test(typed));
check('Ctrl+A selected native RichEdit text', /sel=0\.\.[1-9][0-9]*/.test(selected));
check('basic paragraph field set returned success', /ret=0x1/.test(appliedSet));
check('direct paragraph fields read back before save', hasParaFields(applied));
check('Save As dialog filename accepted', picks >= 1);
check('paragraph fields remained after Save As', hasParaFields(afterSave));
check('saved RTF file extracted from VFS', fs.existsSync(SAVED_RTF) && savedRtf.length > 0);
check('saved RTF contains bullet paragraph controls',
  /\\pntext/.test(savedRtf) && /\\pnlvlblt/.test(savedRtf));
check('saved RTF contains first-line offset', /\\fi240\b/.test(savedRtf));
check('saved RTF contains left indent', /\\li480\b/.test(savedRtf));
check('saved RTF contains right indent', /\\ri360\b/.test(savedRtf));
check('saved RTF contains first tab stop', /\\tx1440\b/.test(savedRtf));
check('File New cleared native RichEdit text', /len=0 text=""/.test(afterNew));
check('Open saved filename accepted', picks >= 2);
check('reopened RTF restored plain text', /len=4 text="para"/.test(afterOpen));
check('Ctrl+A selected reopened text', /sel=0\.\.[1-9][0-9]*/.test(selectedReopen));
check('reopened RTF restored paragraph fields', hasParaFields(afterReopen));
check('no UNIMPLEMENTED API crash', !/UNIMPLEMENTED API:/.test(out));
check('no runtime crash', !/CRASH|Unreachable code|EIP=0x00000000/.test(out));

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);

process.exit(failed ? 1 : 0);
