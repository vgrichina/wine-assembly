#!/usr/bin/env node
// Regression coverage for WordPad Save As using the plain Text Document
// common-dialog filter. This proves the WAT Open/Save dialog mirrors
// OPENFILENAME.nFilterIndex back to the app, so WordPad chooses plain text
// instead of its default rich/Word format.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const PNG = path.join(OUT_DIR, 'plain-text-filter.png');
const SAVE_NAME = 'wordpad-plain-filter.txt';
const TEXT = 'plain text';
const TEXT_FILTER_INDEX = 3; // WordPad order: Word 6, RTF, Text Document, ...

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const seq = ['70:click:40:70'];
let b = 74;
for (const ch of TEXT) {
  seq.push(`${b}:keypress:${ch.charCodeAt(0)}`);
  b += 1;
}
seq.push('100:dump-focus-text:typed');
seq.push('120:0x111:57604');
seq.push('170:dlg-dump:save');
seq.push(`172:open-dlg-filter:${TEXT_FILTER_INDEX}`);
seq.push('174:dlg-dump:filter-text');
seq.push(`180:open-dlg-pick:${SAVE_NAME}`);
seq.push('205:dlg-dump:text-warning');
seq.push('210:dlg-cmd:6');
seq.push('250:click:40:70');
seq.push('260:dump-focus-text:after-save');
seq.push('300:0x111:57600');
seq.push('330:dlg-cmd:1');
seq.push('380:dump-focus-text:after-new');
seq.push('410:0x111:57601');
seq.push(`460:open-dlg-pick:${SAVE_NAME}`);
seq.push('550:dump-focus-text:after-open');
seq.push(`555:png:${PNG}`);
seq.push('560:stop');

const traceApis = [
  'GetSaveFileNameA',
  'GetOpenFileNameA',
  'CreateFileA',
  'ReadFile',
  'WriteFile',
  'wvsprintfA',
].join(',');

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=700',
  '--batch-size=50000',
  '--quiet-api',
  `--trace-api=${traceApis}`,
  '--no-close',
];

console.log('$ node ' + args.map(a => JSON.stringify(a)).join(' '));

let out = '';
try {
  out = execFileSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  out = String(e.stdout || '') + String(e.stderr || '');
  console.log('(run.js exited non-zero or timed out - output captured)');
}

const interesting = out.split('\n').filter(l =>
  l.includes('ShowWindow') ||
  l.includes('dump-focus-text') ||
  l.includes('dlg-dump') ||
  l.includes('dlg-cmd') ||
  l.includes('open-dlg-filter') ||
  l.includes('open-dlg-pick') ||
  l.includes('MessageBox') ||
  l.includes('GetSaveFileNameA') ||
  l.includes('GetOpenFileNameA') ||
  l.includes('CreateFileA') ||
  l.includes('ReadFile') ||
  l.includes('WriteFile') ||
  l.includes('wvsprintfA') ||
  l.includes('SetWindowText') ||
  l.includes('png ') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH') ||
  l.includes('Unreachable code'));
for (const l of interesting) console.log('  ' + l);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function line(label, kind = 'dump-focus-text') {
  const prefix = `${kind} ${label}:`;
  return out.split('\n').find(l => l.includes(prefix)) || '';
}

const typed = line('typed');
const afterSave = line('after-save');
const afterNew = line('after-new');
const afterOpen = line('after-open');

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

check('WordPad reached ShowWindow', /ShowWindow\] hwnd=0x10001/.test(out));
check('typed text reached native RichEdit', /text="plain text"/.test(typed));
check('Save As dialog exposes file type combobox',
  /dlg-dump:save: .*text="Files of type:".*sel=0 text="Word for Windows 6\.0"/.test(out));
check('Text Document filter was selected',
  /open-dlg-filter: requested=3 .*selected=3 text="Text Document"/.test(out));
check('Save As filename accepted', new RegExp(`open-dlg-pick: ${escapeRe(SAVE_NAME)}`).test(out));
check('WordPad showed text-only data loss warning',
  /MessageBox\] "WordPad": "You are about to save the document in a Text-Only format/.test(out));
check('text-only warning accepted with Yes', /dlg-cmd: cmd=6 hwnd=0x[0-9a-f]+ at batch 210/.test(out));
check('GetSaveFileNameA was called', /GetSaveFileNameA/.test(out));
check('CreateFileA created picked plain text file',
  new RegExp(`CreateFileA\\(path="${escapeRe(SAVE_NAME)}"`).test(out));
check('WriteFile wrote exact plain text byte count',
  /WriteFile\(0x[0-9a-f]+, 0x[0-9a-f]+, 0x0000000a,/i.test(out));
check('plain text save did not write an RTF-sized payload',
  !/WriteFile\(0x[0-9a-f]+, 0x[0-9a-f]+, 0x0000009[0-9a-f],/i.test(out));
check('WordPad title updated to saved filename',
  new RegExp(`SetWindowText\\] "${escapeRe(SAVE_NAME)} - WordPad"`).test(out));
check('focus returned to editor with text intact after save', /text="plain text"/.test(afterSave));
check('File New cleared native RichEdit text', /len=0 text=""/.test(afterNew));
check('GetOpenFileNameA was called', /GetOpenFileNameA/.test(out));
check('Open saved filename accepted',
  (out.match(new RegExp(`open-dlg-pick: ${escapeRe(SAVE_NAME)}`, 'g')) || []).length >= 2);
check('CreateFileA reopened saved plain text file',
  new RegExp(`CreateFileA\\(path="C:\\\\windows\\\\${escapeRe(SAVE_NAME)}"`).test(out));
check('ReadFile streamed saved plain text bytes',
  /ReadFile\(0x[0-9a-f]+, 0x[0-9a-f]+, 0x00000ffe,/i.test(out));
check('reopened plain text restored native RichEdit text', /len=10 text="plain text"/.test(afterOpen));
check('plain text filter screenshot written', fs.existsSync(PNG) && fs.statSync(PNG).size > 0);
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
