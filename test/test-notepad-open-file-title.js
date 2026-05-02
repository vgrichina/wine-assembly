#!/usr/bin/env node
// Regression: Notepad File->Open on a selected/uploaded filename calls
// COMDLG32.GetFileTitleA while updating its window title. That API must not
// crash as unimplemented, and Notepad should keep running after OK.

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

// SOURCES.md is preloaded into the VFS from test/binaries as c:\sources.md.
// Use a relative filename so the shell cannot eat backslashes before run.js
// parses the input spec.
const inputSpec = [
  '40:0x111:10',                       // Notepad File -> Open...
  '90:open-dlg-pick:sources.md',       // choose existing VFS file + OK
  '150:dump-main-edit',
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --input=${inputSpec} --max-batches=220 --batch-size=50000 --trace-api=GetOpenFileNameA,GetFileTitleA,CreateFileA,ReadFile --no-close`;
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 90000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero - output captured)');
}

const interesting = out.split('\n').filter(l =>
  l.includes('GetOpenFileNameA') ||
  l.includes('GetFileTitleA') ||
  l.includes('CreateFileA') ||
  l.includes('ReadFile') ||
  l.includes('open-dlg-pick') ||
  l.includes('dump-main-edit') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH'));
for (const l of interesting) console.log('  ' + l);

const checks = [
  { name: 'open dialog accepted picked file', pass: /open-dlg-pick: sources\.md/i.test(out) },
  { name: 'GetOpenFileNameA fired',          pass: /GetOpenFileNameA/.test(out) },
  { name: 'GetFileTitleA fired',             pass: /GetFileTitleA/.test(out) },
  { name: 'Notepad edit populated from file',pass: /dump-main-edit: hwnd=0x[0-9a-f]+ text="[^"]+/.test(out) },
  { name: 'no UNIMPLEMENTED API crash',      pass: !/UNIMPLEMENTED API:/.test(out) },
  { name: 'no runtime crash',                pass: !/CRASH|Unreachable code/.test(out) },
];

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
