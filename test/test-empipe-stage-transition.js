#!/usr/bin/env node
// EmPipe stage-complete regression: force the board state into the app's own
// completed condition, let WM_TIMER reach the real stage-complete handler, then
// accept the modal and verify the stage advances.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'wep32-community', 'EmPipe', 'EMPIPE.EXE');
const OUT = path.join(ROOT, 'scratch');
fs.mkdirSync(OUT, { recursive: true });

if (!fs.existsSync(EXE)) {
  console.log('SKIP  EmPipe.exe missing');
  process.exit(0);
}

const afterOkPng = path.join(OUT, 'empipe_stage_after_ok.png');
try { fs.unlinkSync(afterOkPng); } catch (_) {}

const inputSpec = [
  '130:mousedown:475:354',
  '132:mouseup:475:354',
  '220:mousedown:475:354',
  '222:mouseup:475:354',
  '256:read-dword:0x410bd8:stage-before',
  '260:poke:0x410b74:0',
  '262:poke:0x410b7c:0',
  '264:poke:0x4117fc:0',
  '330:dlg-dump:stageclear',
  '350:dlg-click:1',
  '430:dlg-dump:afterok',
  '440:read-dword:0x410bd8:stage-after',
  '442:read-dword:0x410bb4:score-after',
  `450:png:${afterOkPng}`,
  '460:stop',
].join(',');

const args = [
  RUN,
  `--exe=${EXE}`,
  '--no-close',
  `--input=${inputSpec}`,
  '--max-batches=480',
  '--quiet-api',
  '--quiet-blocks',
  '--trace-api=MessageBoxA,SetTimer,KillTimer',
  '--count=0x404b2a,0x40464d,0x405397',
  '--stuck-after=1000',
];

console.log('$ node', args.map(a => a.replace(ROOT, '.')).join(' '));

let out = '';
let exitCode = 0;
try {
  out = execFileSync('node', args, {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 25000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  exitCode = e.status ?? 1;
  console.log(`(run.js exited non-zero status=${exitCode} - output captured)`);
}

for (const line of out.split('\n')) {
  if (/\[input\]|MessageBox|SetTimer|KillTimer|Hit counts|0x00404b2a|0x0040464d|STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED/.test(line)) {
    console.log('  ' + line);
  }
}

const afterOkSize = fs.existsSync(afterOkPng) ? fs.statSync(afterOkPng).size : 0;
const checks = [
  { name: 'bounded run exited cleanly', pass: exitCode === 0 },
  { name: 'gameplay was started before forcing completion', pass: /SetTimer\(0x00010001, 0x00000002/.test(out) },
  { name: 'stage started at zero-based stage 0', pass: /read-dword:stage-before \[0x410bd8\] = 0x0 \(0\)/.test(out) },
  { name: 'timer path reached stage-complete handler', pass: /0x0040464d = 1/.test(out) },
  { name: 'Stage cleared modal appeared', pass: /dlg-dump:stageclear: dlg=0x[0-9a-f]+ modal=0x[0-9a-f]+[\s\S]*Stage cleared!/.test(out) },
  { name: 'OK was clicked through the dialog path', pass: /dlg-click: id=1/.test(out) },
  { name: 'stage-clear dialog closed', pass: /dlg-dump:afterok: dlg=none modal=none/.test(out) },
  { name: 'stage advanced to zero-based stage 1', pass: /read-dword:stage-after \[0x410bd8\] = 0x1 \(1\)/.test(out) },
  { name: 'clear bonus was applied', pass: /read-dword:score-after \[0x410bb4\] = 0x64 \(100\)/.test(out) },
  { name: 'post-transition screenshot written', pass: afterOkSize > 6000 },
  { name: 'no crash marker', pass: !/STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED API:/.test(out) },
];

let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log(`afterOk=${afterOkPng} size=${afterOkSize}`);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
