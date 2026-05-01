#!/usr/bin/env node
// Pinball Options > Select Table regression.
//
// The menu command reaches WinExec for the selected table executable.
// Without a WinExec handler this crashed at the first Select Table command.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'pinball', 'pinball.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  pinball.exe not found at', EXE);
  process.exit(0);
}

const TMP = path.join(ROOT, 'scratch');
fs.mkdirSync(TMP, { recursive: true });
const snapPng = path.join(TMP, 'pinball_select_table.png');
try { fs.unlinkSync(snapPng); } catch (_) {}

const inputSpec = [
  `300:post-cmd:405`,  // Options > Select Table
  `500:png:${snapPng}`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --args=-quick --batch-size=200000 --max-batches=520 --input='${inputSpec}' --no-close`;
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 180000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero — output captured)');
}

for (const l of out.split('\n')) {
  if (l.includes('[input]') || l.includes('UNIMPLEMENTED') || l.includes('CRASH') || l.includes('RuntimeError')) {
    console.log('  ' + l);
  }
}

const checks = [];
checks.push({ name: 'no UNIMPLEMENTED API crash', pass: !/UNIMPLEMENTED API:/.test(out) });
checks.push({ name: 'no unreachable trap', pass: !/RuntimeError: unreachable|\*\*\* CRASH/.test(out) });
checks.push({ name: 'snapshot written', pass: fs.existsSync(snapPng) && fs.statSync(snapPng).size > 1000 });

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);
console.log(`Snapshot: ${snapPng}`);
process.exit(failed > 0 ? 1 : 0);
