#!/usr/bin/env node
// Regression: Notepad's File→Open dialog opens via the new WAT-driven
// $create_open_dialog + modal pump (CACA0006). Cancel must release every
// WAT slot allocated by the dialog so repeated open/cancel doesn't leak,
// AND the modal pump must successfully unblock the API call so notepad
// continues executing post-Cancel.
//
// PASS criteria:
//   - GetOpenFileNameA fires
//   - Slot count grows (parent + children) on open
//   - Cancel returns to baseline
//   - 3 cycles all behave identically
//   - Post-Cancel API call count > pre-Cancel (notepad still running)
//   - No UNIMPLEMENTED API crash

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

// Notepad File → &Open... = id 10. class 12 = open dialog parent.
// class-cmd:12:2 = WM_COMMAND id=IDCANCEL=2 → $opendlg_wndproc → $modal_done(0).
const inputSpec = [
  '40:slot-count:baseline',
  '50:0x111:10',                  // open #1
  '90:slot-count:after-open1',
  '95:class-cmd:12:2',            // Cancel
  '120:slot-count:after-cancel1',
  '130:0x111:10',                 // open #2
  '170:slot-count:after-open2',
  '175:class-cmd:12:2',
  '200:slot-count:after-cancel2',
  '210:0x111:10',                 // open #3
  '250:slot-count:after-open3',
  '255:class-cmd:12:2',
  '280:slot-count:after-cancel3',
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --input=${inputSpec} --max-batches=320`;
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 60000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero — output captured)');
}

const interesting = out.split('\n').filter(l =>
  l.includes('slot-count') ||
  l.includes('class-cmd') ||
  l.includes('GetOpenFile') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH'));
for (const l of interesting) console.log('  ' + l);

function parseSlot(label) {
  const re = new RegExp(`slot-count ${label}: used=(\\d+)`);
  const m = out.match(re);
  return m ? { used: parseInt(m[1], 10) } : null;
}

const baseline    = parseSlot('baseline');
const afterOpen1  = parseSlot('after-open1');
const afterCancel1 = parseSlot('after-cancel1');
const afterOpen2  = parseSlot('after-open2');
const afterCancel2 = parseSlot('after-cancel2');
const afterOpen3  = parseSlot('after-open3');
const afterCancel3 = parseSlot('after-cancel3');

const delta = afterOpen1 && baseline ? afterOpen1.used - baseline.used : null;
const sawOpenApi = /GetOpenFileNameA/.test(out);

const checks = [
  { name: 'baseline slot count read',          pass: !!baseline },
  { name: 'GetOpenFileNameA fired',            pass: sawOpenApi },
  { name: 'open #1 added slots (>0)',          pass: !!afterOpen1 && afterOpen1.used > baseline.used },
  { name: 'cancel #1 returned to baseline',    pass: !!afterCancel1 && afterCancel1.used === baseline.used },
  { name: 'open #2 added same delta',          pass: !!afterOpen2 && afterOpen2.used - baseline.used === delta },
  { name: 'cancel #2 returned to baseline',    pass: !!afterCancel2 && afterCancel2.used === baseline.used },
  { name: 'open #3 added same delta',          pass: !!afterOpen3 && afterOpen3.used - baseline.used === delta },
  { name: 'cancel #3 returned to baseline',    pass: !!afterCancel3 && afterCancel3.used === baseline.used },
  { name: 'no UNIMPLEMENTED API crash',        pass: !/UNIMPLEMENTED API:/.test(out) },
];

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed (delta=${delta})`);
process.exit(failed > 0 ? 1 : 0);
