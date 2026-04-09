#!/usr/bin/env node
// Regression: cancelling Notepad's Find dialog must release WAT slots
// (and the renderer-side window) so that opening + cancelling many times
// doesn't slowly exhaust MAX_WINDOWS.
//
// Before $wnd_destroy_tree was wired into $findreplace_wndproc's Cancel
// branch, each open allocated 9 WND_RECORDS slots (1 parent + 8 children:
// Find what static, edit, Match case checkbox, Direction groupbox, Up
// radio, Down radio, Find Next button, Cancel button) and released zero,
// so after ~28 opens the table overflowed.
//
// PASS criteria:
//   - Slot count grows by exactly 9 per open
//   - Slot count drops by exactly 9 per cancel (back to baseline)
//   - $findreplace_dlg_hwnd is cleared after cancel
//   - Reopen allocates a fresh dlg hwnd (next_hwnd advanced)
//   - 3 open/cancel cycles all behave identically
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

const inputSpec = [
  '40:slot-count:baseline',
  '50:0x111:3',                // open Find #1
  '80:slot-count:after-open1',
  '82:find-click:2',           // Cancel
  '84:slot-count:after-cancel1',
  '90:0x111:3',                // open Find #2
  '120:slot-count:after-open2',
  '122:find-click:2',
  '124:slot-count:after-cancel2',
  '130:0x111:3',               // open Find #3
  '160:slot-count:after-open3',
  '162:find-click:2',
  '164:slot-count:after-cancel3',
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --input=${inputSpec} --max-batches=180`;
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 60000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero — output captured)');
}

const lines = out.split('\n');
const interesting = lines.filter(l =>
  l.includes('slot-count') ||
  l.includes('find-click') ||
  l.includes('FindTextA') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH'));
for (const l of interesting) console.log('  ' + l);

// Parse "slot-count LABEL: used=N dlg=0xH ..."
function parseSlot(label) {
  const re = new RegExp(`slot-count ${label}: used=(\\d+) dlg=0x([0-9a-f]+)`);
  const m = out.match(re);
  if (!m) return null;
  return { used: parseInt(m[1], 10), dlg: parseInt(m[2], 16) };
}

const baseline    = parseSlot('baseline');
const afterOpen1  = parseSlot('after-open1');
const afterCancel1 = parseSlot('after-cancel1');
const afterOpen2  = parseSlot('after-open2');
const afterCancel2 = parseSlot('after-cancel2');
const afterOpen3  = parseSlot('after-open3');
const afterCancel3 = parseSlot('after-cancel3');

const checks = [
  { name: 'baseline slot count read',          pass: !!baseline },
  { name: 'open #1 added 9 slots',             pass: !!afterOpen1 && afterOpen1.used === baseline.used + 9 },
  { name: 'cancel #1 returned to baseline',    pass: !!afterCancel1 && afterCancel1.used === baseline.used },
  { name: 'cancel #1 cleared dlg global',      pass: !!afterCancel1 && afterCancel1.dlg === 0 },
  { name: 'open #2 added 9 slots',             pass: !!afterOpen2 && afterOpen2.used === baseline.used + 9 },
  { name: 'open #2 got a fresh dlg hwnd',      pass: !!afterOpen2 && afterOpen2.dlg !== 0 && afterOpen2.dlg !== afterOpen1.dlg },
  { name: 'cancel #2 returned to baseline',    pass: !!afterCancel2 && afterCancel2.used === baseline.used },
  { name: 'open #3 added 9 slots',             pass: !!afterOpen3 && afterOpen3.used === baseline.used + 9 },
  { name: 'open #3 got a fresh dlg hwnd',      pass: !!afterOpen3 && afterOpen3.dlg !== afterOpen2.dlg },
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
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
