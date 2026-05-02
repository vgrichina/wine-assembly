#!/usr/bin/env node
// Regression: the visible Find dialog "Find Next" button is clickable through
// normal canvas mouse input, not just the test-only find-click helper.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'notepad.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  notepad.exe not found at', EXE);
  process.exit(0);
}

const inputSpec = [
  '50:0x111:3',
  '90:focus-find',
  '92:keypress:65',
  '100:mousedown:350:101',
  '103:mouseup:350:101',
  '110:dump-fr',
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --input=${inputSpec} --max-batches=140 --quiet-api --no-close`;
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 60000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero - output captured)');
}

for (const l of out.split('\n').filter(l =>
  l.includes('FindTextA') ||
  l.includes('mousedown') ||
  l.includes('mouseup') ||
  l.includes('MessageBox') ||
  l.includes('dump-fr') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH'))) {
  console.log('  ' + l);
}

const m = out.match(/dump-fr: flags=0x([0-9a-f]+) findWhat="A"/);
const checks = [
  ['Find dialog appeared', out.includes('[FindTextA]')],
  ['mouse down/up was injected', out.includes('mousedown 350,101') && out.includes('mouseup 350,101')],
  ['Find Next command fired from mouse click', !!m && (parseInt(m[1], 16) & 0x08) !== 0],
  ['search result MessageBox appeared', out.includes('Cannot find "A"')],
  ['no UNIMPLEMENTED', !out.includes('UNIMPLEMENTED')],
  ['no CRASH', !out.includes('CRASH')],
];

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
