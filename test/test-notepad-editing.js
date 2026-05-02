#!/usr/bin/env node
// Regression coverage for Notepad's main edit control:
//   - typed characters reach the EDIT control
//   - Ctrl+A selects text
//   - typing over a selection replaces it, and Backspace edits it
//   - long multiline content can scroll

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

const seq = [];
let b = 30;

function push(action, step = 2) {
  seq.push(`${b}:${action}`);
  b += step;
}

function typeText(text) {
  for (const ch of text) push(`keypress:${ch.charCodeAt(0)}`, 2);
}

function keydown(vk, step = 2) { push(`keydown:${vk}`, step); }
function keyup(vk, step = 2) { push(`keyup:${vk}`, step); }

push('focus-main-window', 4);
typeText('alpha beta');
push('dump-main-edit-state:typed', 8);
push('drag-main-edit:4:8:52:8', 8);
push('dump-main-edit-state:mouse-selected', 8);

keydown(17);              // Ctrl
keydown(65);              // A
keyup(65);
keyup(17);
push('dump-main-edit-state:selected', 8);

typeText('gammax');
keydown(8);               // Backspace removes the extra character.
push('dump-main-edit-state:edited', 8);

keydown(17);
keydown(65);
keyup(65);
keyup(17);

const lines = [];
for (let i = 0; i < 60; i++) {
  lines.push(`line${String(i).padStart(2, '0')}`);
}
typeText(lines.join('\r'));
push('dump-main-edit-state:long-before-scroll', 8);
push('wheel-main-edit:-120', 4);
push('wheel-main-edit:-120', 4);
push('wheel-main-edit:-120', 4);
push('dump-main-edit-state:long-after-scroll', 8);

const inputSpec = seq.join(',');
const cmd = `node "${RUN}" --exe="${EXE}" --input='${inputSpec}' --max-batches=${b + 40} --batch-size=50000 --no-close`;
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, {
    encoding: 'utf-8', timeout: 120000, cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero - output captured)');
}

const interesting = out.split('\n').filter(l =>
  l.includes('dump-main-edit-state') ||
  l.includes('wheel-main-edit') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH') ||
  l.includes('Unreachable code'));
for (const l of interesting) console.log('  ' + l);

function state(label) {
  const line = out.split('\n').find(l => l.includes(`dump-main-edit-state ${label}:`));
  if (!line) return null;
  const m = line.match(/len=(\d+) cursor=(\d+) sel=(\d+) firstVisible=(\d+) lineCount=(\d+) text=(".*") at batch/);
  if (!m) return null;
  return {
    line,
    len: parseInt(m[1], 10),
    cursor: parseInt(m[2], 10),
    sel: parseInt(m[3], 10),
    firstVisible: parseInt(m[4], 10),
    lineCount: parseInt(m[5], 10),
    text: JSON.parse(m[6]),
  };
}

const typed = state('typed');
const mouseSelected = state('mouse-selected');
const selected = state('selected');
const edited = state('edited');
const longBefore = state('long-before-scroll');
const longAfter = state('long-after-scroll');

const checks = [
  { name: 'typed text reached Notepad edit', pass: typed && typed.text === 'alpha beta' },
  { name: 'mouse drag selected text in Notepad edit', pass: mouseSelected && mouseSelected.text === 'alpha beta' && mouseSelected.cursor !== mouseSelected.sel },
  { name: 'Ctrl+A selected typed text', pass: selected && selected.text === 'alpha beta' && selected.sel === 0 && selected.cursor === selected.len },
  { name: 'typing over selection and Backspace edited text', pass: edited && edited.text === 'gamm' },
  { name: 'long multiline content inserted', pass: longBefore && longBefore.text.includes('line00\nline01') && longBefore.lineCount >= 60 },
  { name: 'mouse wheel scrolled long edit', pass: longAfter && longBefore && longAfter.firstVisible > longBefore.firstVisible },
  { name: 'no UNIMPLEMENTED API crash', pass: !/UNIMPLEMENTED API:/.test(out) },
  { name: 'no runtime crash', pass: !/CRASH|Unreachable code/.test(out) },
];

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
