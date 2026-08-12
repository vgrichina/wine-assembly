#!/usr/bin/env node
// WordPad editing-command regression: native RichEdit Undo plus the actual
// MFC Edit > Find command and common modeless Find dialog notification path.

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

const seq = [
  '70:click:40:150',
  '70:keypress:97', '70:keypress:108', '70:keypress:112',
  '70:keypress:104', '70:keypress:97', '70:keypress:32',
  '70:keypress:98', '70:keypress:101', '70:keypress:116', '70:keypress:97',
  '71:dump-focus-state:typed',
  // WordPad's Ctrl+Z accelerator sends its real MFC Undo command.
  '71:keydown:17', '71:keydown:90', '71:keyup:90', '71:keyup:17',
  '72:dump-focus-state:undone',
  // Retype after Undo, then search from the document start.
  '72:keypress:97', '72:keypress:108', '72:keypress:112',
  '72:keypress:104', '72:keypress:97', '72:keypress:32',
  '72:keypress:98', '72:keypress:101', '72:keypress:116', '72:keypress:97',
  '72:keydown:36',
  '75:0x111:57636', // MFC ID_EDIT_FIND
  '85:focus-find',
  '85:keypress:98', '85:keypress:101', '85:keypress:116', '85:keypress:97',
  '86:dump-find',
  '86:find-click:1',
  '86:dump-fr',
  '86:dump-control-state:59648:found',
  '86:dlg-paint',
  `86:png:${PNG}`,
  '86:stop',
];

const result = spawnSync(process.execPath, [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=100',
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
check('Find Next notification targets the RichEdit owner', /post_queue after find-click:.*h=0x10002 m=0xc[0-9a-f]+ .*lp=0x[1-9a-f][0-9a-f]*/i.test(output));
check('FINDREPLACE reports Find Next beta', /dump-fr: flags=0x[0-9a-f]*[89a-f][0-9a-f]* findWhat="beta"/i.test(output));
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
