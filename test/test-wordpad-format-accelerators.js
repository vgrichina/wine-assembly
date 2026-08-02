#!/usr/bin/env node
// Regression coverage for modifier-aware accelerator translation in WordPad:
// Ctrl+B / Ctrl+I / Ctrl+U should dispatch WordPad's formatting commands and
// update native RichEdit CHARFORMAT state for the selected text.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const PNG = path.join(OUT_DIR, 'format-accelerators.png');
const TEXT = 'style';

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const seq = [
  '70:click:40:70',
];
let b = 74;
for (const ch of TEXT) {
  seq.push(`${b}:keypress:${ch.charCodeAt(0)}`);
  b += 1;
}
seq.push('84:dump-focus-state:typed');
seq.push('86:dump-focus-charformat:plain');
seq.push('90:keydown:17');
seq.push('91:keydown:65');
seq.push('92:keyup:65');
seq.push('93:keyup:17');
seq.push('96:dump-focus-state:selected');
seq.push('100:keydown:17');
seq.push('101:keydown:66');
seq.push('102:keyup:66');
seq.push('103:keyup:17');
seq.push('112:dump-focus-charformat:bold');
seq.push('116:keydown:17');
seq.push('117:keydown:73');
seq.push('118:keyup:73');
seq.push('119:keyup:17');
seq.push('128:dump-focus-charformat:bold-italic');
seq.push('132:keydown:17');
seq.push('133:keydown:85');
seq.push('134:keyup:85');
seq.push('135:keyup:17');
seq.push('144:dump-focus-charformat:bold-italic-underline');
seq.push('148:dump-focus-state:final');
seq.push(`152:png:${PNG}`);
seq.push('156:stop');

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=220',
  '--batch-size=50000',
  '--quiet-api',
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
  l.includes('dump-focus-state') ||
  l.includes('dump-focus-charformat') ||
  l.includes('png ') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH') ||
  l.includes('Unreachable code'));
for (const l of interesting) console.log('  ' + l);

function line(label, kind = 'dump-focus-charformat') {
  const prefix = `${kind} ${label}:`;
  return out.split('\n').find(l => l.includes(prefix)) || '';
}

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

const typed = line('typed', 'dump-focus-state');
const selected = line('selected', 'dump-focus-state');
const final = line('final', 'dump-focus-state');
const plain = line('plain');
const bold = line('bold');
const boldItalic = line('bold-italic');
const all = line('bold-italic-underline');

check('WordPad reached ShowWindow', /ShowWindow\] hwnd=0x10001/.test(out));
check('typed text reached native RichEdit', /text="style"/.test(typed));
check('plain text starts without bold/italic/underline effects',
  /bold=0 .*italic=0 .*underline=0/.test(plain));
check('Ctrl+A selected the native RichEdit text',
  /sel=0\.\.[1-9][0-9]*/.test(selected));
check('Ctrl+B accelerator toggled selected text bold',
  /bold=1 .*italic=0 .*underline=0/.test(bold));
check('Ctrl+I accelerator toggled selected text italic without dropping bold',
  /bold=1 .*italic=1 .*underline=0/.test(boldItalic));
check('Ctrl+U accelerator toggled selected text underline without dropping prior effects',
  /bold=1 .*italic=1 .*underline=1/.test(all));
check('formatting accelerators did not insert literal shortcut letters',
  /text="style"/.test(final));
check('formatting screenshot written', fs.existsSync(PNG) && fs.statSync(PNG).size > 0);
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
