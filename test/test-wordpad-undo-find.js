#!/usr/bin/env node
// WordPad editing-command regression: native RichEdit Undo plus the actual
// MFC Edit > Find command and the native RichEdit's single-execution path.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const PNG = path.join(OUT, 'find-beta.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });
try { fs.unlinkSync(PNG); } catch (_) {}

// One character per batch. The input queue hands the guest a single event per
// GetMessage poll, so ten keypresses stacked on one batch are still in flight
// when the next batch's dump runs -- which is why the old sequence read the
// document back empty and blamed the RichEdit.
const ALPHA = 'alpha beta';
const seq = ['70:click:40:150'];
let b = 71;
for (const ch of ALPHA) seq.push(`${b++}:keypress:${ch.charCodeAt(0)}`);
b += 2;
seq.push(`${b}:dump-focus-state:typed`);
// WordPad's Ctrl+Z accelerator sends its real MFC Undo command.
b += 1;
seq.push(`${b}:keydown:17`, `${b}:keydown:90`, `${b + 1}:keyup:90`, `${b + 1}:keyup:17`);
b += 4;
seq.push(`${b}:dump-focus-state:undone`);
// Retype after Undo, then search from the document start.
b += 1;
for (const ch of ALPHA) seq.push(`${b++}:keypress:${ch.charCodeAt(0)}`);
b += 2;
seq.push(`${b}:keydown:36`);
b += 3;
seq.push(`${b}:0x111:57636`); // MFC ID_EDIT_FIND
b += 10;
seq.push(`${b}:focus-find`);
for (const ch of 'beta') seq.push(`${b++}:keypress:${ch.charCodeAt(0)}`);
b += 2;
seq.push(
  `${b}:dump-find`,
  `${b}:find-click:1`,
  `${b}:dump-fr`,
  `${b}:dump-control-state:59648:found`,
  `${b}:dlg-paint`,
  `${b}:png:${PNG}`,
  `${b}:stop`,
);

const result = spawnSync(process.execPath, [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=160',
  '--batch-size=100000',
  '--quiet-api',
  '--quiet-blocks',
  '--no-close',
], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 180000,
  maxBuffer: 64 * 1024 * 1024,
});
const output = `${result.stdout || ''}${result.stderr || ''}`;

for (const line of output.split('\n')) {
  if (/FindTextA|dump-focus-state|dump-control-state|focus-find|dump-find|find-click|post_queue|dump-fr|png |UNIMPLEMENTED|CRASH|RuntimeError/.test(line)) {
    console.log('  ' + line);
  }
}

const checks = [];
const check = (name, pass) => checks.push([name, !!pass]);
const state = label => output.split('\n').find(line => line.includes(`dump-focus-state ${label}:`)) || '';
const controlState = label => output.split('\n').find(line => line.includes(`dump-control-state ${label}:`)) || '';

check('emulator completed inside timeout', result.status === 0 && !result.signal && !result.error);
check('typed text reached native RichEdit', /len=10 .*text="alpha beta"/.test(state('typed')));
check('Ctrl+Z invoked native RichEdit Undo', /len=0 .*text=""/.test(state('undone')));
check('WordPad opened the modeless Find dialog', /\[FindTextA\].*owner=0x10002/.test(output));
check('Find dialog accepted beta', /dump-find:.*editText="beta"/.test(output));
check('native Find avoids a duplicate owner notification', !/post_queue after find-click:.*h=0x10002 m=0xc[0-9a-f]+ .*lp=0x[1-9a-f][0-9a-f]*/i.test(output));
// MFC's CFindReplaceDialog attaches the HWND through the WH_CBT hook that real
// commdlg fires from inside its dialog; we do not fire it, so MFC concludes
// Create failed and deletes the object -- FINDREPLACE and its buffers become
// recycled heap while our dialog stays up. Writing the search text back into
// somebody else's allocation is worse than not writing it, so the struct only
// gets the answer while lStructSize still says it is a FINDREPLACE.
const frLine = output.split('\n').find(line => line.includes('dump-fr:')) || '';
const frLive = /size=40 /.test(frLine); // sizeof(FINDREPLACE)
check('Find Next notification carries FR_FINDNEXT and beta',
  /watFlags=0x[0-9a-f]*[89a-f][0-9a-f]* findWhat="beta"/i.test(frLine));
check('freed FINDREPLACE left untouched', frLive || /findBuf=0x0 /.test(frLine));
check('Find Next selects beta in native RichEdit', /len=10 sel=6\.\.10 .*text="alpha beta"/.test(controlState('found')));
check('Find screenshot written', fs.existsSync(PNG) && fs.statSync(PNG).size > 0);
check('no unimplemented API', !/UNIMPLEMENTED/.test(output));
check('no crash', !/CRASH|RuntimeError|Unreachable code/.test(output));

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
