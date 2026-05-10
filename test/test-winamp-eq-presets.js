#!/usr/bin/env node
// Winamp EQ Presets popup regression.
//
// Opens Winamp, dismisses the first-run survey through the normal button path,
// then clicks the Equalizer Presets button. This used to trap at
// unimplemented TrackPopupMenu.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'winamp.exe');
const OUTDIR = path.join(__dirname, 'output');
const PNG = path.join(OUTDIR, 'winamp-eq-presets-popup.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  winamp.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUTDIR, { recursive: true });
if (fs.existsSync(PNG)) fs.unlinkSync(PNG);

const cmd = [
  `node "${RUN}"`,
  `--exe="${EXE}"`,
  '--max-batches=900',
  '--batch-size=100',
  '--quiet-api',
  '--quiet-blocks',
  '--buttons=1,1,1,1,1,1,1,1,1,1',
  '--no-close',
  '--stuck-after=5000',
  '--input="10:273:2,20:wait-title:Winamp:1000,420:click:263:164,650:stop"',
  '--trace-host=menu_track_popup',
  `--png="${PNG}"`,
].join(' ');
console.log('$', cmd);

let out = '';
let timedOut = false;
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 120000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  timedOut = e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
  console.log(timedOut ? '(run.js timed out - output captured)' : '(run.js exited non-zero - output captured)');
}

const apiMatch = out.match(/Stats:\s+(\d+)\s+API calls,\s+(\d+)\s+batches/);
const apiCount = apiMatch ? parseInt(apiMatch[1], 10) : 0;
const batches = apiMatch ? parseInt(apiMatch[2], 10) : 0;

const checks = [
  { name: 'run completed without timeout', pass: !timedOut },
  { name: 'no UNIMPLEMENTED API crash', pass: !/UNIMPLEMENTED API:/.test(out) },
  { name: 'no unreachable trap', pass: !/RuntimeError:\s*unreachable|Unreachable code should not be executed/.test(out) },
  { name: 'TrackPopupMenu host path was called', pass: /\[host\] menu_track_popup\(/.test(out) },
  { name: 'EQ preset click was injected', pass: /\[input\].*click.*263,164/.test(out) },
  { name: 'reached message loop', pass: apiCount > 1000 && batches > 100 },
  { name: 'wrote screenshot', pass: fs.existsSync(PNG) },
];

console.log('');
console.log(`  apiCount=${apiCount} batches=${batches}`);
console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
