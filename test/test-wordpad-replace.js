#!/usr/bin/env node
// WordPad Edit > Replace regression: dynamic ReplaceTextA lookup, modeless
// dialog controls, Find Next, single Replace, Match Case, and Replace All.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const PNG = path.join(OUT, 'replace-all.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });
try { fs.unlinkSync(PNG); } catch (_) {}

const text = 'alpha ALPHA alpha';
const seq = ['70:click:40:150'];
for (const ch of text) seq.push(`70:keypress:${ch.charCodeAt(0)}`);
seq.push(
  '71:keydown:36',
  '73:0x111:57641', // WordPad/MFC ID_EDIT_REPLACE
  '81:dlg-dump:replace-open',
  '82:dlg-set-edit:1152:alpha', // edt1 / find what
  '82:dlg-set-edit:1153:X',     // edt2 / replace with
  '83:dlg-click:1',             // Find Next
  '84:dump-control-state:59648:found',
  '85:dlg-click:1024',          // psh1 / Replace
  '86:dump-fr',
  '86:dump-control-state:59648:single',
  '87:dlg-click:1041',          // chx1 / Match case
  '88:dlg-click:1025',          // psh2 / Replace All
  '89:dump-fr',
  '89:dump-control-state:59648:all',
  '89:dlg-paint',
  `89:png:${PNG}`,
  '89:stop',
);

const run = (events, maxBatches = 100, trace = false) => spawnSync(process.execPath, [
  RUN, `--exe=${EXE}`, `--input=${events.join(',')}`,
  `--max-batches=${maxBatches}`, '--batch-size=100000',
  ...(trace ? ['--trace-api=ReplaceTextA,GetProcAddress'] : []),
  '--quiet-api', '--quiet-blocks', '--no-close',
], { cwd: ROOT, encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 });

const result = run(seq, 100, true);

const output = `${result.stdout || ''}${result.stderr || ''}`;
for (const line of output.split('\n')) {
  if (/ReplaceTextA|dlg-dump:replace-open|dlg-set-edit|dlg-click|dump-fr|dump-control-state|png |MessageBox|UNIMPLEMENTED|CRASH|RuntimeError/.test(line)) {
    console.log('  ' + line);
  }
}

const state = label => output.split('\n').find(line => line.includes(`dump-control-state ${label}:`)) || '';
const checks = [];
const check = (name, pass) => checks.push([name, !!pass]);

check('emulator completed inside timeout', result.status === 0 && !result.signal && !result.error);
check('WordPad dynamically resolved ReplaceTextA',
  /GetProcAddress.*ReplaceTextA/.test(output) && !/GetProcAddress.*ReplaceTextA[\s\S]{0,120}=> 0(?:x0)?\b/i.test(output));
check('ReplaceTextA opened without missing-export error', /\[API .*\] ReplaceTextA\(/.test(output) && !/missing export ReplaceTextA/.test(output));
check('Replace dialog exposes both edits and four buttons',
  /dlg-dump:replace-open:.*id=1152 .*id=1153 .*id=1 .*id=1024 .*id=1025 .*id=2 /.test(output));
check('Find Next selected the first lowercase alpha', /len=17 sel=0\.\.5 .*text="alpha ALPHA alpha"/.test(state('found')));
check('Replace changed one match and advanced to the next case-insensitive match',
  /len=13 sel=2\.\.7 .*text="X ALPHA alpha"/.test(state('single')));
check('single Replace notification carries both buffers',
  /dump-fr: flags=0x10 findWhat="alpha" replaceWith="X"/.test(output));
check('Match Case Replace All leaves uppercase ALPHA untouched',
  /len=9 sel=9\.\.9 .*text="X ALPHA X"/.test(state('all')));
check('Replace All notification uses FR_REPLACEALL plus FR_MATCHCASE',
  /dump-fr: flags=0x24 findWhat="alpha" replaceWith="X"/.test(output));
check('Replace screenshot written', fs.existsSync(PNG) && fs.statSync(PNG).size > 0);
check('no unimplemented API', !/UNIMPLEMENTED/.test(output));
check('no crash', !/CRASH|RuntimeError|Unreachable code/.test(output));

const deleteSeq = [
  '70:click:40:150', '70:keypress:97', '70:keypress:32', '70:keypress:97',
  '71:keydown:36', '73:0x111:57641',
  '82:dlg-set-edit:1152:a', '82:dlg-set-edit:1153:',
  '83:dlg-click:1025', '84:dump-control-state:59648:deleted', '84:stop',
];
const deleteResult = run(deleteSeq, 95, false);
const deleteOutput = `${deleteResult.stdout || ''}${deleteResult.stderr || ''}`;
check('empty Replace All deletes every match',
  deleteResult.status === 0 && /dump-control-state deleted:.*len=1 .*text=" "/.test(deleteOutput));

const notFoundSeq = [
  '70:click:40:150', '70:keypress:97', '70:keypress:98', '70:keypress:99',
  '71:keydown:36', '73:0x111:57641',
  '82:dlg-set-edit:1152:z', '82:dlg-set-edit:1153:X',
  '83:dlg-click:1024', '84:dump-control-state:59648:notfound', '84:stop',
];
const notFoundResult = run(notFoundSeq, 95, false);
const notFoundOutput = `${notFoundResult.stdout || ''}${notFoundResult.stderr || ''}`;
check('single Replace with no match leaves the document unchanged',
  notFoundResult.status === 0 && /dump-control-state notfound:.*len=3 .*text="abc"/.test(notFoundOutput));

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
