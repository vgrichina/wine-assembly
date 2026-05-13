#!/usr/bin/env node
// Funtris real game-over/name-entry regression.
//
// Drives an actual game to game over on a tiny board, types a name into the
// ranking dialog, accepts it, then opens Hall of Fame and verifies the score
// and name came through the app's own high-score insertion path.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'wep32-community', 'Funpack', 'Funtris.exe');
const PNG = path.join(ROOT, 'scratch', 'funtris_gameover_hall_name.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  Funtris.exe missing');
  process.exit(0);
}

const input = [
  '3800:keydown:16',
  '3810:keyup:16',
  '10500:0x111:40001',
  '10600:wait-dlg-control:1025:5000',
  '10610:mousedown:40:105',
  '10611:mouseup:40:105',
];
for (const [i, ch] of Array.from('TEST').entries()) {
  input.push(`${10620 + i * 2}:keypress:${ch.charCodeAt(0)}`);
}
input.push(
  '10650:dlg-click:1',
  '10710:0x111:40005',
  '10730:wait-title:Hall_of_Fame:5000',
  '10740:dlg-paint',
  '10741:dlg-dump:hall-after-gameover',
  `10742:dlg-png:${PNG}`,
  '10760:dlg-click:1',
  '10850:0x2:0:0',
);

const runnerArgs = [
  `--exe=${EXE}`,
  '--no-close',
  `--input=${input.join(',')}`,
  '--max-batches=16000',
  '--batch-size=100',
  '--stuck-after=200',
  '--quiet-api',
  '--quiet-blocks',
  '--trace-reg',
];

const bootstrap = `
const { setRegValue } = require(${JSON.stringify(path.join(ROOT, 'lib', 'storage'))});
const key = 'HKCU\\\\Software\\\\Funpack Software\\\\Funtris\\\\Options';
setRegValue(key, 'GetStarted', 4, 0);
setRegValue(key, 'Rows', 4, 6);
setRegValue(key, 'Columns', 4, 4);
setRegValue(key, 'StartSpeed', 4, 1);
setRegValue(key, 'SpeedInc', 4, 1);
setRegValue(key, 'LevelTime', 4, 1);
process.argv = ${JSON.stringify(['node', RUN, ...runnerArgs])};
require(${JSON.stringify(RUN)});
`;

console.log('$ node', [RUN, ...runnerArgs].map(a => a.replace(ROOT, '.')).join(' '));

let out = '';
let exitCode = 0;
try {
  out = execFileSync('node', ['-e', bootstrap], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  exitCode = e.status ?? 1;
  console.log(`(run.js exited non-zero status=${exitCode} - output captured)`);
}

for (const line of out.split('\n')) {
  if (/\[input\]|\[reg\] set|STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED/.test(line)) {
    console.log('  ' + line);
  }
}

const hallDump = out.split('\n').find(l => l.includes('dlg-dump:hall-after-gameover:')) || '';

const checks = [
  { name: 'bounded run exited cleanly', pass: exitCode === 0 },
  { name: 'ranking name-entry edit appeared after game over', pass: /wait-dlg-control: matched id=1025/.test(out) },
  { name: 'typed name appears in Hall of Fame', pass: /text="TEST"/.test(hallDump) },
  { name: 'game-over score appears in Hall of Fame', pass: /text="[1-9][0-9]*"/.test(hallDump) },
  { name: 'high-score name written to registry', pass: /\[reg\] set\s+HKCU\\software\\Funpack Software\\Funtris\\Options\\Name[0-9]+ = TEST/.test(out) },
  { name: 'high-score level written to registry', pass: /\[reg\] set\s+HKCU\\software\\Funpack Software\\Funtris\\Options\\Level[0-9]+ = [1-9][0-9]*/.test(out) },
  { name: 'Hall of Fame PNG written', pass: fs.existsSync(PNG) && fs.statSync(PNG).size > 1000 },
  { name: 'no crash marker', pass: !/STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED API:/.test(out) },
];

let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
