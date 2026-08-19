#!/usr/bin/env node
// Calculator creates a chrome-less top-level EDIT named CalcMsgPumpWnd before
// loading its real dialog. Its CW_USEDEFAULT sentinels must resolve to a 0x0
// renderer surface; expanding them to the normal 400x300 framed-window default
// leaves a large grey rectangle behind Calculator on the desktop.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'calc.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  calc.exe missing');
  process.exit(0);
}

let out = '';
try {
  out = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    '--max-batches=20',
    '--batch-size=50000',
    '--no-close',
  ], {
    encoding: 'utf8',
    timeout: 30000,
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  out = String(error.stdout || '') + String(error.stderr || '');
}

const helper = out.match(
  /\[CreateWindow\].*title="CalcMsgPumpWnd".*pos=(-?\d+),(-?\d+) size=(\d+)x(\d+)/,
);
const checks = [
  {
    name: 'CalcMsgPumpWnd helper was created',
    pass: !!helper,
  },
  {
    name: 'CalcMsgPumpWnd has no renderer surface',
    pass: !!helper && Number(helper[3]) === 0 && Number(helper[4]) === 0,
  },
  {
    name: 'real Calculator dialog was created',
    pass: /\[CreateDialog\].*parent=0x0/.test(out),
  },
];

let failed = 0;
for (const check of checks) {
  console.log(`${check.pass ? 'PASS  ' : 'FAIL  '}${check.name}`);
  if (!check.pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
