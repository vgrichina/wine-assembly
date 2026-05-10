#!/usr/bin/env node
// Funtris Hall of Fame regression.
//
// Opens Hall of Fame through the real command path, clicks OK through the
// browser-facing mouse route, and verifies the modeless MFC dialog closes.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'wep32-community', 'Funpack', 'Funtris.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  Funtris.exe missing');
  process.exit(0);
}

const inputSpec = [
  '3800:0x111:40005',
  '3900:wait-title:Hall_of_Fame:1000',
  '3910:dlg-dump:hall',
  '3920:mousedown:385:44',
  '3921:mouseup:385:44',
  '4000:dlg-dump:after-ok',
  '4010:stop',
].join(',');

const args = [
  RUN,
  `--exe=${EXE}`,
  '--no-close',
  `--input=${inputSpec}`,
  '--max-batches=4020',
  '--batch-size=100',
  '--stuck-after=100',
  '--quiet-api',
  '--quiet-blocks',
];

console.log('$ node', args.map(a => a.replace(ROOT, '.')).join(' '));

let out = '';
let exitCode = 0;
try {
  out = execFileSync('node', args, {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  exitCode = e.status ?? 1;
  console.log(`(run.js exited non-zero status=${exitCode} - output captured)`);
}

for (const line of out.split('\n')) {
  if (/\[input\]|STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED/.test(line)) {
    console.log('  ' + line);
  }
}

const hallDump = out.split('\n').find(l => l.includes('dlg-dump:hall:')) || '';
const afterDump = out.split('\n').find(l => l.includes('dlg-dump:after-ok:')) || '';

const checks = [
  { name: 'bounded run exited cleanly', pass: exitCode === 0 },
  { name: 'Hall of Fame title appeared', pass: /wait-title: matched "Hall of Fame"/.test(out) },
  { name: 'Hall of Fame OK control exists', pass: /id=1 cls=1/.test(hallDump) && /text="OK"/.test(hallDump) },
  { name: 'OK click delivered through mouse path', pass: /mousedown 385,44/.test(out) && /mouseup 385,44/.test(out) },
  { name: 'Hall of Fame dialog closed after OK', pass: /dlg-dump:after-ok: dlg=none/.test(afterDump) },
  { name: 'no crash marker', pass: !/STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED API:/.test(out) },
];

let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
