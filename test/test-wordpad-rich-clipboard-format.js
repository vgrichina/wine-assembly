#!/usr/bin/env node
// Regression coverage for WordPad's bounded rich clipboard bridge:
// copy selected native RichEdit text with basic character/paragraph formatting,
// clear the document, paste through the WordPad menu bridge, then verify that
// text, CRLF-aware caret position, ANSI high-byte text, and formatting survive.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-richedit');

const ID_EDIT_CLEAR = 57632;
const ID_EDIT_COPY = 57634;
const ID_EDIT_PASTE = 57637;
const ID_EDIT_SELECT_ALL = 57642;

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const seq = [
  '70:click:40:150',
  '74:keypress:99',   // c
  '75:keypress:97',   // a
  '76:keypress:102',  // f
  '77:keypress:233',  // é in the current ANSI/Latin-1 test path
  '80:keydown:13',
  '81:keyup:13',
  '84:keypress:116',  // t
  '85:keypress:119',  // w
  '86:keypress:111',  // o
  '94:dump-focus-state:typed',
  `100:menu-edit-command:${ID_EDIT_SELECT_ALL}:select-all`,
  '106:set-focus-charformat-color:0x00ff0000:blue',
  '110:set-focus-paraformat-basic:1:720:360:-240:1440:para',
  '116:dump-focus-charformat:before-copy',
  '118:dump-focus-paraformat:before-copy',
  `124:menu-edit-command:${ID_EDIT_COPY}:copy`,
  `138:menu-edit-command:${ID_EDIT_CLEAR}:clear`,
  '152:dump-focus-state:after-clear',
  '158:set-focus-charformat-color:0x00000000:black-after-clear',
  '162:set-focus-paraformat-basic:0:0:0:0:0:plain-after-clear',
  `176:menu-edit-command:${ID_EDIT_PASTE}:paste`,
  '194:dump-focus-state:after-paste',
  `206:menu-edit-command:${ID_EDIT_SELECT_ALL}:select-pasted`,
  '216:dump-focus-charformat:after-paste-selected',
  '218:dump-focus-paraformat:after-paste-selected',
  '222:stop',
];

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=260',
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
  l.includes('menu-edit-command') ||
  l.includes('png ') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH') ||
  l.includes('Unreachable code'));
for (const l of interesting) console.log('  ' + l);

function line(label, kind) {
  const marker = `${kind} ${label}:`;
  return out.split('\n').find(l => l.includes(marker)) || '';
}

function commandRet(label, id) {
  const re = new RegExp(`menu-edit-command ${label}: id=${id} ret=1`);
  return re.test(out);
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
const afterClear = line('after-clear', 'dump-focus-state');
const afterPaste = line('after-paste', 'dump-focus-state');
const afterChar = line('after-paste-selected', 'dump-focus-charformat');
const afterPara = line('after-paste-selected', 'dump-focus-paraformat');

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

check('WordPad reached ShowWindow', /ShowWindow\] hwnd=0x10001/.test(out));
check('typed ANSI high-byte text and CRLF reached native RichEdit', hasText(typed));
check('typed CRLF reports logical caret position, not byte length', /sel=8\.\.8/.test(typed));
check('menu Select All selected source text', commandRet('select-all', ID_EDIT_SELECT_ALL));
check('source text has blue character formatting before copy', hasBlue(beforeChar));
check('source text has paragraph fields before copy', hasParaFields(beforePara));
check('menu Copy command was bridged', commandRet('copy', ID_EDIT_COPY));
check('menu Clear command was bridged', commandRet('clear', ID_EDIT_CLEAR));
check('menu Clear emptied the native RichEdit text', /len=0 .*text=""/.test(afterClear));
check('insertion formatting was reset to black before paste',
  /set-focus-charformat-color black-after-clear: .*color=0x0 .*ret=0x1/.test(out));
check('insertion paragraph formatting was reset before paste',
  /set-focus-paraformat-basic plain-after-clear: .*numbering=0 .*dxStartIndent=0 .*dxRightIndent=0 .*dxOffset=0 .*tab=0 .*ret=0x1/.test(out));
check('menu Paste command was bridged', commandRet('paste', ID_EDIT_PASTE));
check('pasted text preserves ANSI high-byte byte and CRLF', hasText(afterPaste));
check('pasted caret preserves RichEdit logical CRLF position', /sel=8\.\.8/.test(afterPaste));
check('menu Select All selected pasted text', commandRet('select-pasted', ID_EDIT_SELECT_ALL));
check('pasted selected text preserved blue character formatting', hasBlue(afterChar));
check('pasted selected text preserved paragraph formatting', hasParaFields(afterPara));
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
