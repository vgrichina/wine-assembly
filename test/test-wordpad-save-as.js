#!/usr/bin/env node
// Regression coverage for WordPad's Save As path:
//   - type text into the native RichEdit control
//   - invoke MFC command ID 57604 (Save As)
//   - accept the common dialog filename
//   - verify the file/write/time and OLE/ROT save bookkeeping paths ran
//   - verify WordPad returned to the editor and updated the title

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const SAVE_NAME = 'wordpad-save-probe.txt';

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

const seq = [
  '60:slot-count:before',
  '70:click:40:70',
];
let b = 74;
for (const ch of 'save me') {
  seq.push(`${b}:keypress:${ch.charCodeAt(0)}`);
  b += 1;
}
seq.push('90:dump-focus-text:typed');
seq.push('110:0x111:57604');
seq.push('150:slot-count:opened');
seq.push(`160:open-dlg-pick:${SAVE_NAME}`);
seq.push('230:slot-count:after');
seq.push('250:dump-focus-text:after');
seq.push('260:stop');

const traceApis = [
  'GetSaveFileNameA',
  'CreateFileA',
  'GetFileTime',
  'WriteFile',
  'CloseHandle',
  'CreateFileMoniker',
  'GetRunningObjectTable',
  'IRunningObjectTable_Register',
  'IRunningObjectTable_Release',
].join(',');

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=300',
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
  l.includes('CreateFileA') ||
  l.includes('GetFileTime') ||
  l.includes('WriteFile') ||
  l.includes('CloseHandle') ||
  l.includes('CreateFileMoniker') ||
  l.includes('GetRunningObjectTable') ||
  l.includes('IRunningObjectTable_Register') ||
  l.includes('IRunningObjectTable_Release') ||
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

function savedSize() {
  const re = new RegExp(`FindFirstFile\\("\\\\?C:\\\\windows\\\\${SAVE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\) → "${SAVE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" size=(\\d+)`, 'i');
  const m = out.match(re);
  return m ? parseInt(m[1], 10) : 0;
}

const before = slot('before');
const opened = slot('opened');
const after = slot('after');
const size = savedSize();

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

check('typed text reached native RichEdit', /dump-focus-text typed: hwnd=0x10002 .* text="save me"/.test(out));
check('Save As dialog opened', before !== null && opened !== null && opened > before);
check('Save As filename accepted', new RegExp(`open-dlg-pick: ${SAVE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(out));
check('Save As dialog closed', before !== null && after === before);
check('GetSaveFileNameA was called', /GetSaveFileNameA/.test(out));
check('CreateFileA created picked file', new RegExp(`CreateFileA\\(path="${SAVE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(out));
check('GetFileTime compatibility handler was used', /GetFileTime\(0x[0-9a-f]+,/i.test(out));
check('WriteFile wrote non-empty document bytes', /WriteFile\(0x[0-9a-f]+, 0x[0-9a-f]+, 0x0*97,/i.test(out));
check('CloseHandle closed saved file', /CloseHandle\(0x[0-9a-f]+\)/i.test(out));
check('saved file is visible in VFS', size > 0);
check('CreateFileMoniker compatibility handler was used', /CreateFileMoniker\(/.test(out));
check('GetRunningObjectTable returned usable ROT object', /GetRunningObjectTable\(/.test(out) && !/EIP=0x00000000/.test(out));
check('ROT Register was called', /IRunningObjectTable_Register\(/.test(out));
check('ROT Release was called', /IRunningObjectTable_Release\(/.test(out));
check('WordPad title updated to saved filename', new RegExp(`SetWindowText\\] "${SAVE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} - WordPad"`).test(out));
check('focus returned to native RichEdit with text intact', /dump-focus-text after: hwnd=0x10002 .* text="save me"/.test(out));
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
