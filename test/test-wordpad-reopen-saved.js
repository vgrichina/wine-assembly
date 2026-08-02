#!/usr/bin/env node
// Regression coverage for WordPad saving simple RichEdit content and reopening
// the saved document. This specifically covers the wvsprintfA va_list path used
// while RichEdit streams RTF bytes out during Save As.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const SAVE_NAME = 'wordpad-reopen-saved.txt';
const TEXT = 'save me';

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

const seq = [
  '60:slot-count:before',
  '70:click:40:150',
];
let b = 74;
for (const ch of TEXT) {
  seq.push(`${b}:keypress:${ch.charCodeAt(0)}`);
  b += 1;
}
seq.push('90:dump-focus-text:typed');
seq.push('110:0x111:57604');
seq.push('150:slot-count:save-opened');
seq.push(`160:open-dlg-pick:${SAVE_NAME}`);
seq.push('230:slot-count:save-after');
seq.push('250:dump-focus-text:after-save');
seq.push('270:0x111:57600');
seq.push('300:dlg-cmd:1');
seq.push('360:dump-focus-text:after-new');
seq.push('390:0x111:57601');
seq.push('440:slot-count:open-opened');
seq.push(`450:open-dlg-pick:${SAVE_NAME}`);
seq.push('540:slot-count:open-after');
seq.push('550:dump-focus-text:after-open-saved');
seq.push('560:stop');

const traceApis = [
  'GetSaveFileNameA',
  'GetOpenFileNameA',
  'CreateFileA',
  'ReadFile',
  'WriteFile',
  'CloseHandle',
  'GetFileTitleA',
  'wvsprintfA',
].join(',');

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=640',
  '--batch-size=50000',
  '--quiet-api',
  `--trace-api=${traceApis}`,
  '--trace-fs',
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
  l.includes('dump-focus-text') ||
  l.includes('slot-count') ||
  l.includes('open-dlg-pick') ||
  l.includes('GetSaveFileNameA') ||
  l.includes('GetOpenFileNameA') ||
  l.includes('CreateFileA') ||
  l.includes('ReadFile') ||
  l.includes('WriteFile') ||
  l.includes('CloseHandle') ||
  l.includes('GetFileTitleA') ||
  l.includes('wvsprintfA') ||
  l.includes('SetWindowText') ||
  l.includes('[fs] CreateFile') ||
  l.includes('[fs] FindFirstFile') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH') ||
  l.includes('Unreachable code'));
for (const l of interesting) console.log('  ' + l);

function slot(label) {
  const m = out.match(new RegExp(`slot-count ${label}: used=(\\d+)`));
  return m ? parseInt(m[1], 10) : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function savedSize() {
  const save = escapeRe(SAVE_NAME);
  const re = new RegExp(`FindFirstFile\\("\\\\?C:\\\\windows\\\\${save}"\\) → "${save}" size=(\\d+)`, 'i');
  const m = out.match(re);
  return m ? parseInt(m[1], 10) : 0;
}

const before = slot('before');
const saveOpened = slot('save-opened');
const saveAfter = slot('save-after');
const openOpened = slot('open-opened');
const openAfter = slot('open-after');
const size = savedSize();
const reopened = out.match(/dump-focus-text after-open-saved:[^\n]*/)?.[0] || '';
const savePicks = (out.match(new RegExp(`open-dlg-pick: ${escapeRe(SAVE_NAME)}`, 'g')) || []).length;

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

check('typed text reached native RichEdit', /dump-focus-text typed: hwnd=0x10002 .* text="save me"/.test(out));
check('Save As dialog opened', before !== null && saveOpened !== null && saveOpened > before);
check('Save As filename accepted', savePicks >= 1);
check('Save As dialog closed', before !== null && saveAfter === before);
check('GetSaveFileNameA was called', /GetSaveFileNameA/.test(out));
check('wvsprintfA was used while streaming saved RTF', /wvsprintfA\(/.test(out));
check('CreateFileA created picked file', new RegExp(`CreateFileA\\(path="${escapeRe(SAVE_NAME)}"`).test(out));
check('WriteFile wrote non-empty saved document bytes', /WriteFile\(0x[0-9a-f]+, 0x[0-9a-f]+, 0x0*[1-9a-f][0-9a-f]*,/i.test(out));
check('saved file is visible in VFS', size > 0);
check('focus returned to native RichEdit with text intact', /dump-focus-text after-save: hwnd=0x10002 .* text="save me"/.test(out));
check('File New cleared native RichEdit text', /dump-focus-text after-new: hwnd=0x10002 .* len=0 text=""/.test(out));
check('Open dialog opened after New', before !== null && openOpened !== null && openOpened > before);
check('Open saved filename accepted', savePicks >= 2);
check('Open dialog closed', before !== null && openAfter === before);
check('GetOpenFileNameA was called', /GetOpenFileNameA/.test(out));
check('CreateFileA reopened saved document', new RegExp(`CreateFileA\\(path="C:\\\\windows\\\\${escapeRe(SAVE_NAME)}"`).test(out));
check('ReadFile streamed saved document bytes', /ReadFile\(0x[0-9a-f]+, 0x[0-9a-f]+, 0x0*[1-9a-f][0-9a-f]*,/i.test(out));
check('saved document reopened as plain editor text', /len=7 text="save me"/.test(reopened));
check('saved RTF was not exposed as raw corrupted text', !/\(null\)|text="\{\\/.test(reopened));
check('WordPad title updated to saved filename', new RegExp(`SetWindowText\\] "${escapeRe(SAVE_NAME)} - WordPad"`).test(out));
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
