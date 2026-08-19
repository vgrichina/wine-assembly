#!/usr/bin/env node
// Space Cadet Pinball fullscreen menu restoration regression.
//
// Pinball removes its menu on entry and restores the HMENU returned by
// GetMenu on exit. That opaque handle must be normalized back to RT_MENU 1
// before WAT reloads the authoritative menu blob.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'pinball', 'pinball.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  pinball.exe not found at', EXE);
  process.exit(0);
}

const input = [
  '20:post-cmd:403', // Enter fullscreen: SetMenu(hwnd, NULL).
  '30:post-cmd:403', // Exit fullscreen: restore saved HMENU.
  '40:wait-title-menu-open:3D_Pinball_for_Windows_-_Space_Cadet:2000:79:restored',
  '40:menu-dump:restored',
  '50:stop',
].join(',');

const args = [
  RUN,
  `--exe=${EXE}`,
  '--args=-quick',
  '--batch-size=200000',
  '--max-batches=80',
  '--quiet-api',
  '--quiet-blocks',
  '--no-close',
  `--input=${input}`,
];

const run = spawnSync(process.execPath, args, {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 120000,
  maxBuffer: 32 * 1024 * 1024,
});
const out = String(run.stdout || '') + String(run.stderr || '');

for (const line of out.split('\n')) {
  if (line.includes('[SetMenu]') || line.includes('[input]') ||
      line.includes('CRASH') || line.includes('RuntimeError')) {
    console.log('  ' + line);
  }
}

const checks = [
  {
    name: 'fullscreen detaches and exit restores the named menu identity',
    pass: /\[SetMenu\] hwnd=0x[0-9a-f]+ menu=0\r?$/m.test(out) &&
      /\[SetMenu\] hwnd=0x[0-9a-f]+ menu=16782948\r?$/m.test(out),
  },
  {
    name: 'Options menu opens after leaving fullscreen',
    pass: /wait-title-menu-open:restored:[^\n]*Alt\+79/.test(out) &&
      /menu-dump:restored:[^\n]*hwnd=0x[0-9a-f]+[^\n]*count=[1-9][0-9]*/.test(out),
  },
  {
    name: 'restored menu contains Pinball commands',
    pass: /menu-dump:restored:[^\n]*&Players[^\n]*&Music/.test(out),
  },
  {
    name: 'no crash or trap',
    pass: run.status === 0 &&
      !/UNIMPLEMENTED API:|RuntimeError:|\*\*\* CRASH|Thread \d+ crashed/.test(out),
  },
];

let failed = 0;
for (const check of checks) {
  console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}`);
  if (!check.pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
