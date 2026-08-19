#!/usr/bin/env node
// Browser-style mouse click regression for Notepad's modeless Find dialog
// autoradio buttons. The Direction groupbox overlaps the Up/Down radios,
// so renderer hit-testing must not deliver clicks to the groupbox first.

const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'notepad.exe');

const inputSpec = [
  '150:0x111:3',
  '200:dlg-dump:initial',
  '210:click:205:130',
  '220:dlg-dump:after-up',
  '230:click:255:130',
  '240:dlg-dump:after-down',
  '250:png:scratch/notepad_find_radio_click.png',
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --input='${inputSpec}' --max-batches=280 --no-close --quiet-api`;
console.log('$', cmd.replace(ROOT, '.'));

let out = '';
try {
  out = execSync(cmd, {
    encoding: 'utf-8',
    timeout: 60000,
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero - output captured)');
}

const dumpLines = out.split('\n').filter(l => l.includes('[input] dlg-dump'));
for (const l of dumpLines) console.log('  ' + l);

function line(label) {
  return dumpLines.find(l => l.includes(`dlg-dump:${label}:`)) || '';
}

function checked(dump, id) {
  const re = new RegExp(`id=${id} cls=1[^|]* checked=(\\d+)`);
  const m = dump.match(re);
  return m ? Number(m[1]) : -1;
}

const initial = line('initial');
const afterUp = line('after-up');
const afterDown = line('after-down');

const checks = [
  {
    name: 'Find dialog opened with Down initially checked',
    pass: checked(initial, 1056) === 0 && checked(initial, 1057) === 1,
  },
  {
    name: 'browser-style click on Up selects Up and clears Down',
    pass: checked(afterUp, 1056) === 1 && checked(afterUp, 1057) === 0,
  },
  {
    name: 'browser-style click on Down selects Down and clears Up',
    pass: checked(afterDown, 1056) === 0 && checked(afterDown, 1057) === 1,
  },
  {
    name: 'no UNIMPLEMENTED API crash',
    pass: !/UNIMPLEMENTED API:/.test(out),
  },
];

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}

console.log('\nPASS');
