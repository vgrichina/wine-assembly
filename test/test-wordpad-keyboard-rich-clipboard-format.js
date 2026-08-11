#!/usr/bin/env node
// Regression coverage for keyboard native-RichEdit rich clipboard shortcuts:
// Ctrl+C/Ctrl+X use the shared WAT clipboard backend, advertise non-OLE
// "Rich Text Format" data, and Ctrl+V restores basic character/paragraph
// formatting without byte-counting CRLF positions.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-richedit');

const ID_EDIT_CLEAR = 57632;

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

function ctrl(batch, vk) {
  return [
    `${batch}:keydown:17`,
    `${batch + 1}:keydown:${vk}`,
    `${batch + 2}:keyup:${vk}`,
    `${batch + 3}:keyup:17`,
  ];
}

const seq = [
  '70:click:40:150',
  '74:keypress:99',   // c
  '75:keypress:97',   // a
  '76:keypress:102',  // f
  '77:keypress:233',  // é in current ANSI/Latin-1 path
  '80:keydown:13',
  '81:keyup:13',
  '84:keypress:116',  // t
  '85:keypress:119',  // w
  '86:keypress:111',  // o
  '94:dump-focus-state:typed',
  ...ctrl(100, 65), // Ctrl+A
  '108:set-focus-charformat-color:0x00ff0000:blue',
  '112:set-focus-paraformat-basic:1:720:360:-240:1440:para',
  '118:dump-focus-charformat:before-copy',
  '120:dump-focus-paraformat:before-copy',
  ...ctrl(126, 67), // Ctrl+C
  '134:dump-clipboard:after-copy',
  `146:menu-edit-command:${ID_EDIT_CLEAR}:clear`,
  '160:dump-focus-state:after-clear',
  '166:set-focus-charformat-color:0x00000000:black-after-clear',
  '170:set-focus-paraformat-basic:0:0:0:0:0:plain-after-clear',
  ...ctrl(184, 86), // Ctrl+V
  '204:dump-focus-state:after-paste',
  ...ctrl(212, 65), // Ctrl+A pasted text
  '222:dump-focus-charformat:after-paste-selected',
  '224:dump-focus-paraformat:after-paste-selected',
  ...ctrl(232, 88), // Ctrl+X pasted text
  '244:dump-focus-state:after-cut',
  '250:set-focus-charformat-color:0x00000000:black-after-cut',
  '254:set-focus-paraformat-basic:0:0:0:0:0:plain-after-cut',
  ...ctrl(268, 86), // Ctrl+V cut text
  '288:dump-focus-state:after-cut-paste',
  ...ctrl(296, 65),
  '306:dump-focus-charformat:after-cut-paste-selected',
  '308:dump-focus-paraformat:after-cut-paste-selected',
  '314:stop',
];

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=350',
  '--batch-size=50000',
  '--quiet-api',
  '--quiet-blocks',
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
  l.includes('dump-focus-paraformat') ||
  l.includes('set-focus-charformat') ||
  l.includes('set-focus-paraformat') ||
  l.includes('dump-clipboard') ||
  l.includes('menu-edit-command') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH') ||
  l.includes('Unreachable code'));
for (const l of interesting) console.log('  ' + l);

function line(label, kind) {
  const marker = `${kind} ${label}:`;
  return out.split('\n').find(l => l.includes(marker)) || '';
}

function hasText(l) {
  return /len=9 /.test(l) && /text="café\\r\\ntwo"/.test(l);
}

function hasBlue(l) {
  return /color=0xff0000/.test(l);
}

function hasParaFields(l) {
  return /numbering=1/.test(l) &&
    /dxStartIndent=720/.test(l) &&
    /dxRightIndent=360/.test(l) &&
    /dxOffset=-240/.test(l) &&
    /tabCount=1/.test(l) &&
    /tab0=1440/.test(l);
}

const typed = line('typed', 'dump-focus-state');
const beforeChar = line('before-copy', 'dump-focus-charformat');
const beforePara = line('before-copy', 'dump-focus-paraformat');
const clip = line('after-copy', 'dump-clipboard');
const afterClear = line('after-clear', 'dump-focus-state');
const afterPaste = line('after-paste', 'dump-focus-state');
const afterPasteChar = line('after-paste-selected', 'dump-focus-charformat');
const afterPastePara = line('after-paste-selected', 'dump-focus-paraformat');
const afterCut = line('after-cut', 'dump-focus-state');
const afterCutPaste = line('after-cut-paste', 'dump-focus-state');
const afterCutPasteChar = line('after-cut-paste-selected', 'dump-focus-charformat');
const afterCutPastePara = line('after-cut-paste-selected', 'dump-focus-paraformat');

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

check('WordPad reached ShowWindow', /ShowWindow\] hwnd=0x10001/.test(out));
check('typed ANSI high-byte text and CRLF reached native RichEdit', hasText(typed));
check('typed CRLF reports logical caret position', /sel=8\.\.8/.test(typed));
check('source text has blue character formatting before copy', hasBlue(beforeChar));
check('source text has paragraph fields before copy', hasParaFields(beforePara));
check('Ctrl+C populated text and RTF clipboard formats',
  /count=2 /.test(clip) && /textLen=9 /.test(clip) &&
  /rtfFmt=0xc[0-9a-f]+/.test(clip) && /rtfLen=[1-9][0-9]*/.test(clip) &&
  /availText=1 /.test(clip) && /availRtf=1 /.test(clip) &&
  /textHandle=0x[1-9a-f]/.test(clip) && /rtfHandle=0x[1-9a-f]/.test(clip));
check('RTF clipboard escapes high byte and CRLF',
  /rtf=.*\\\\rtf1\\\\ansi caf\\\\'e9\\\\par two/.test(clip));
check('Clear emptied native RichEdit text', /len=0 .*text=""/.test(afterClear));
check('Ctrl+V pasted text with ANSI high byte and CRLF', hasText(afterPaste));
check('Ctrl+V preserved logical CRLF caret position', /sel=8\.\.8/.test(afterPaste));
check('Ctrl+V restored blue character formatting', hasBlue(afterPasteChar));
check('Ctrl+V restored paragraph formatting', hasParaFields(afterPastePara));
check('Ctrl+X cleared selected native RichEdit text', /len=0 .*text=""/.test(afterCut));
check('Ctrl+V restored cut text with ANSI high byte and CRLF', hasText(afterCutPaste));
check('Ctrl+V restored cut text logical caret position', /sel=8\.\.8/.test(afterCutPaste));
check('Ctrl+X/Ctrl+V restored blue character formatting', hasBlue(afterCutPasteChar));
check('Ctrl+X/Ctrl+V restored paragraph formatting', hasParaFields(afterCutPastePara));
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
