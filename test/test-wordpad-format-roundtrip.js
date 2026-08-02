#!/usr/bin/env node
// Regression coverage for simple WordPad RTF formatting round-trip:
// select text, toggle Bold/Italic/Underline, Save As, New, reopen, then verify
// native RichEdit still reports those CHARFORMAT effects on the reopened text.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const PNG = path.join(OUT_DIR, 'format-roundtrip.png');
const SAVE_NAME = 'wordpad-format-roundtrip.rtf';
const TEXT = 'style';

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
seq.push('90:keydown:17');
seq.push('91:keydown:65');
seq.push('92:keyup:65');
seq.push('93:keyup:17');
seq.push('100:keydown:17');
seq.push('101:keydown:66');
seq.push('102:keyup:66');
seq.push('103:keyup:17');
seq.push('116:keydown:17');
seq.push('117:keydown:73');
seq.push('118:keyup:73');
seq.push('119:keyup:17');
seq.push('132:keydown:17');
seq.push('133:keydown:85');
seq.push('134:keyup:85');
seq.push('135:keyup:17');
seq.push('145:dump-focus-charformat:before-save');
seq.push('160:0x111:57604');
seq.push(`210:open-dlg-pick:${SAVE_NAME}`);
seq.push('280:dump-focus-charformat:after-save');
seq.push('300:0x111:57600');
seq.push('330:dlg-cmd:1');
seq.push('380:dump-focus-text:after-new');
seq.push('410:0x111:57601');
seq.push(`460:open-dlg-pick:${SAVE_NAME}`);
seq.push('550:dump-focus-text:after-open');
seq.push('560:keydown:17');
seq.push('561:keydown:65');
seq.push('562:keyup:65');
seq.push('563:keyup:17');
seq.push('575:dump-focus-state:after-reopen-selected');
seq.push('585:dump-focus-charformat:after-reopen');
seq.push(`588:png:${PNG}`);
seq.push('590:stop');

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
  l.includes('dump-focus-state') ||
  l.includes('dump-focus-charformat') ||
  l.includes('open-dlg-pick') ||
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

function line(label, kind) {
  const prefix = `${kind} ${label}:`;
  return out.split('\n').find(l => l.includes(prefix)) || '';
}

const picks = (out.match(new RegExp(`open-dlg-pick: ${escapeRe(SAVE_NAME)}`, 'g')) || []).length;
const beforeSave = line('before-save', 'dump-focus-charformat');
const afterSave = line('after-save', 'dump-focus-charformat');
const afterNew = line('after-new', 'dump-focus-text');
const afterOpen = line('after-open', 'dump-focus-text');
const selected = line('after-reopen-selected', 'dump-focus-state');
const afterReopen = line('after-reopen', 'dump-focus-charformat');

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

check('WordPad reached ShowWindow', /ShowWindow\] hwnd=0x10001/.test(out));
check('formatting effects were set before Save As',
  /bold=1 .*italic=1 .*underline=1/.test(beforeSave));
check('Save As dialog filename accepted', picks >= 1);
check('GetSaveFileNameA was called', /GetSaveFileNameA/.test(out));
check('CreateFileA created formatted RTF file', new RegExp(`CreateFileA\\(path="${escapeRe(SAVE_NAME)}"`).test(out));
check('wvsprintfA streamed formatted RTF', /wvsprintfA\(/.test(out));
check('WriteFile wrote non-empty formatted RTF bytes', /WriteFile\(0x[0-9a-f]+, 0x[0-9a-f]+, 0x0*[1-9a-f][0-9a-f]*,/i.test(out));
check('formatting effects remained after Save As',
  /bold=1 .*italic=1 .*underline=1/.test(afterSave));
check('File New cleared native RichEdit text', /len=0 text=""/.test(afterNew));
check('Open saved filename accepted', picks >= 2);
check('GetOpenFileNameA was called', /GetOpenFileNameA/.test(out));
check('CreateFileA reopened formatted RTF file',
  new RegExp(`CreateFileA\\(path="C:\\\\windows\\\\${escapeRe(SAVE_NAME)}"`).test(out));
check('ReadFile streamed formatted RTF bytes', /ReadFile\(0x[0-9a-f]+, 0x[0-9a-f]+, 0x0*[1-9a-f][0-9a-f]*,/i.test(out));
check('reopened formatted RTF restored plain text', /len=5 text="style"/.test(afterOpen));
check('Ctrl+A selected reopened text', /sel=0\.\.[1-9][0-9]*/.test(selected));
check('reopened RTF preserved bold/italic/underline effects',
  /bold=1 .*italic=1 .*underline=1/.test(afterReopen));
check('format round-trip screenshot written', fs.existsSync(PNG) && fs.statSync(PNG).size > 0);
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
