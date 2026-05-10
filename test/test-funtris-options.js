#!/usr/bin/env node
// Funtris Options dialog regression.
//
// Game > Options... is WM_COMMAND id 40002. This test catches hangs in that
// command path and writes the dialog's actual GDI back-canvas PNG.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'wep32-community', 'Funpack', 'Funtris.exe');
const OUT = path.join(ROOT, 'scratch');
fs.mkdirSync(OUT, { recursive: true });

if (!fs.existsSync(EXE)) {
  console.log('SKIP  Funtris.exe missing');
  process.exit(0);
}

const optionsPng = path.join(OUT, 'funtris_options.png');
try { fs.unlinkSync(optionsPng); } catch (_) {}

const inputSpec = [
  '3800:post-cmd:40002',
  `3820:wait-title:Options:5000:dump-stop:funtris-options:${optionsPng}`,
].join(',');

const args = [
  RUN,
  `--exe=${EXE}`,
  '--no-close',
  `--input=${inputSpec}`,
  '--max-batches=3831',
  '--batch-size=100',
  '--stuck-after=100',
  '--quiet-api',
  '--quiet-blocks',
];

console.log('$ node', args.map(a => a.replace(ROOT, '.')).join(' '));

let out = '';
let exitCode = 0;
let timedOut = false;
try {
  out = execFileSync('node', args, {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 45000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  exitCode = e.status ?? 1;
  timedOut = e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
  console.log(`(run.js exited non-zero status=${exitCode}${timedOut ? ' timeout' : ''} - output captured)`);
}

for (const line of out.split('\n')) {
  if (/\[input\]|STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED/.test(line)) {
    console.log('  ' + line);
  }
}

const sizeOf = p => fs.existsSync(p) ? fs.statSync(p).size : 0;
const optionsSize = sizeOf(optionsPng);
const dumpLine = out.split('\n').find(l => l.includes('dlg-dump:funtris-options:')) || '';

const checks = [
  { name: 'bounded run reached Options before timeout', pass: /wait-title: matched "Options"/.test(out) },
  { name: 'Options title appeared', pass: /wait-title: matched "Options"/.test(out) },
  { name: 'Options dialog controls dumped', pass: /text="OK"/.test(dumpLine) && /text="Cancel"/.test(dumpLine) && /text="Defaults"/.test(dumpLine) },
  { name: 'Options dialog labels dumped', pass: /text="Columns"/.test(dumpLine) && /text="Level Time"/.test(dumpLine) && /text="Bricks"/.test(dumpLine) },
  { name: 'Slider controls are native trackbars', pass: /id=1003 cls=19/.test(dumpLine) && /id=1008 cls=19/.test(dumpLine) },
  { name: 'Options GDI PNG written', pass: /dlg-png .*funtris_options\.png/.test(out) && optionsSize > 1000 },
  { name: 'no crash marker', pass: !/STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED API:/.test(out) },
];

let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log(`optionsPng=${optionsPng} size=${optionsSize}`);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
