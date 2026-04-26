#!/usr/bin/env node
// Regression: full typing flow in Notepad.
//   1. Launch notepad
//   2. Type "hello world" into the main edit
//   3. Open Edit > Find (WM_COMMAND id 3)
//   4. Type "world" into the Find dialog
//   5. Verify Find dialog FINDREPLACE struct holds findWhat="world"
//
// PASS criteria:
//   - Main edit text == "hello world" before Find opens
//   - Find dialog edit text == "world"
//   - FINDREPLACE.lpstrFindWhat == "world"

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'notepad.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  notepad.exe not found at', EXE);
  process.exit(0);
}

const text = 'hello world';
const seq = [];
let b = 50;
for (const ch of text) {
  seq.push(`${b}:keypress:${ch.charCodeAt(0)}`);
  b += 5;
}
// Open Find dialog
seq.push(`${b + 20}:0x111:3`);
b += 60;
// Type "world" into Find dialog
for (const ch of 'world') {
  seq.push(`${b}:keypress:${ch.charCodeAt(0)}`);
  b += 5;
}
// Dump Notepad main edit, dump Find edit, dump FINDREPLACE struct
seq.push(`${b + 20}:dump-main-edit`);
seq.push(`${b + 20}:dump-find`);
seq.push(`${b + 25}:find-click:1`);
seq.push(`${b + 25}:dump-fr`);

const inputSpec = seq.join(',');
const cmd = `node "${RUN}" --exe="${EXE}" --input=${inputSpec} --max-batches=${b + 60}`;
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 60000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero — output captured)');
}

const lines = out.split('\n');
const interesting = lines.filter(l =>
  l.includes('FindTextA') ||
  l.includes('[input] dump-main-edit') ||
  l.includes('[input] dump-find') ||
  l.includes('[input] dump-fr') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH'));
for (const l of interesting) console.log('  ' + l);

const checks = [];
function check(label, cond) { checks.push({ label, ok: !!cond }); }

// Notepad main edit content
const editLine = lines.find(l => l.startsWith('[input] dump-main-edit'));
check('dump-main-edit emitted', !!editLine);
if (editLine) {
  const m = editLine.match(/text="([^"]*)"/);
  check(`main edit text == "hello world" (got "${m ? m[1] : '?'}")`, m && m[1] === 'hello world');
}

// Find dialog opened
check('Find dialog appeared', out.includes('[FindTextA]'));

// Find dialog edit content
const findLine = lines.find(l => l.startsWith('[input] dump-find'));
check('dump-find emitted', !!findLine);
if (findLine) {
  const m = findLine.match(/editText="([^"]*)"/);
  check(`find edit text == "world" (got "${m ? m[1] : '?'}")`, m && m[1] === 'world');
}

// FINDREPLACE struct content
const frLine = lines.find(l => l.startsWith('[input] dump-fr'));
check('dump-fr emitted', !!frLine);
if (frLine) {
  const m = frLine.match(/findWhat="([^"]*)"/);
  check(`findWhat == "world" (got "${m ? m[1] : '?'}")`, m && m[1] === 'world');
}

check('no UNIMPLEMENTED', !out.includes('UNIMPLEMENTED'));
check('no CRASH', !out.includes('CRASH'));

let pass = 0, fail = 0;
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label}`);
  c.ok ? pass++ : fail++;
}
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
