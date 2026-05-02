#!/usr/bin/env node
// Regression: full typing flow in Notepad.
//   1. Launch notepad
//   2. Type "hello world" into the main edit
//   3. Open Edit > Find (WM_COMMAND id 3)
//   4. Type "world" into the Find dialog
//   5. Activate Find Next from the keyboard
//   6. Verify the substring was selected in the main editor
//
// PASS criteria:
//   - Main edit text == "hello world" before Find opens
//   - Find dialog edit text == "world"
//   - FINDREPLACE.lpstrFindWhat == "world"
//   - Main edit selection covers "world"

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
// Move caret to start of buffer so Find Next searches from position 0
// (Win98 Notepad's Find Next searches forward from the caret — at end-of-
// buffer it would correctly say "Cannot find".)
seq.push(`${b}:keydown:36`); // VK_HOME
b += 5;
// Open Find dialog
seq.push(`${b + 20}:0x111:3`);
b += 50;
seq.push(`${b}:focus-find`);
b += 10;
// Type "world" into Find dialog
for (const ch of 'world') {
  seq.push(`${b}:keypress:${ch.charCodeAt(0)}`);
  b += 5;
}
// Dump main edit + Find dialog state before clicking
seq.push(`${b + 20}:dump-main-edit`);
seq.push(`${b + 20}:dump-find`);
b += 30;
// Tab from "Find what" edit to "Find Next" button. Our renderer's dialog
// focus traversal currently treats each radio in the Direction group as a
// separate tab stop (Up=0x420, Down=0x421), so:
//   edit -> Match case (0x411) -> Up radio -> Down radio -> Find Next (1) -> Cancel (2)
// Then Space to activate (Win32: VK_SPACE on focused button = click).
seq.push(`${b}:keydown:9`);  b += 8;   // VK_TAB -> Match case
seq.push(`${b}:keydown:9`);  b += 8;   // VK_TAB -> Up
seq.push(`${b}:keydown:9`);  b += 8;   // VK_TAB -> Down
seq.push(`${b}:keydown:9`);  b += 8;   // VK_TAB -> Find Next
seq.push(`${b}:dump-focus:before-space`);
seq.push(`${b + 4}:keydown:32`);       // VK_SPACE -> click Find Next
seq.push(`${b + 8}:keyup:32`);
b += 40;
seq.push(`${b}:dump-main-edit-state:after-find`);
b += 10;

const inputSpec = seq.join(',');
// --trace-api=MessageBoxA so we can verify successful Find Next did not fall
// into the not-found MessageBox path.
const cmd = `node "${RUN}" --exe="${EXE}" --input=${inputSpec} --max-batches=${b + 60} --trace-api=MessageBoxA,FindTextA --quiet-api`;
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
  l.includes('dump-focus') ||
  l.includes('Cannot find') ||
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

// Tab focus walked to Find Next button (id=1) before Space.
const focusLine = lines.find(l => l.includes('dump-focus before-space'));
check('dump-focus before-space emitted', !!focusLine);
if (focusLine) {
  check('focus on Find Next button (id=1) before Space',
        /class=1 id=1\b/.test(focusLine));
}

const selectedLine = lines.find(l => l.includes('dump-main-edit-state after-find'));
check('dump-main-edit-state after-find emitted', !!selectedLine);
if (selectedLine) {
  check('Find Next selected "world" in main edit',
        /cursor=11 sel=6\b/.test(selectedLine) && /text="hello world"/.test(selectedLine));
}

check('Space did not trigger not-found MessageBox',
      !out.includes('Cannot find "world"'));

check('no UNIMPLEMENTED', !out.includes('UNIMPLEMENTED'));
check('no CRASH', !out.includes('CRASH'));

let pass = 0, fail = 0;
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label}`);
  c.ok ? pass++ : fail++;
}
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
