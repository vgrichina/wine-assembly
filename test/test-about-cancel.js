#!/usr/bin/env node
// Regression: opening + closing Notepad's About dialog (ShellAboutA) must
// release every WAT slot allocated by $create_about_dialog so that opening
// many times doesn't slowly exhaust MAX_WINDOWS.
//
// The About dialog is fully WAT-driven via $host_register_dialog_frame:
//   - $handle_ShellAboutA allocates a fresh dlg hwnd
//   - $create_about_dialog calls $host_register_dialog_frame (renderer mirror)
//     then $wnd_table_set (dlg) + N × $ctrl_create_child (children)
//   - $about_wndproc handles WM_COMMAND id=IDOK / WM_CLOSE → $wnd_destroy_tree
//
// PASS criteria:
//   - Slot count grows by exactly DELTA per open
//   - Slot count drops by exactly DELTA per close (back to baseline)
//   - 3 open/close cycles all behave identically
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

// Notepad's Help → About menu id is 11 (verified via tools/parse-rsrc.js).
// class-cmd:11:1 walks WND_RECORDS for the first ctrl class 11 (about
// dialog) and posts WM_COMMAND wParam=IDOK=1, which $about_wndproc
// treats as the OK click and tears down the dialog.
const inputSpec = [
  '40:slot-count:baseline',
  '50:0x111:11',                  // open About #1
  '90:slot-count:after-open1',
  '95:class-cmd:11:1',            // OK
  '120:slot-count:after-close1',
  '130:0x111:11',                 // open About #2
  '170:slot-count:after-open2',
  '175:class-cmd:11:1',
  '200:slot-count:after-close2',
  '210:0x111:11',                 // open About #3
  '250:slot-count:after-open3',
  '255:class-cmd:11:1',
  '280:slot-count:after-close3',
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

const lines = out.split('\n');
const interesting = lines.filter(l =>
  l.includes('slot-count') ||
  l.includes('class-cmd') ||
  l.includes('ShellAbout') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH'));
for (const l of interesting) console.log('  ' + l);

function parseSlot(label) {
  const re = new RegExp(`slot-count ${label}: used=(\\d+)`);
  const m = out.match(re);
  if (!m) return null;
  return { used: parseInt(m[1], 10) };
}

const baseline    = parseSlot('baseline');
const afterOpen1  = parseSlot('after-open1');
const afterClose1 = parseSlot('after-close1');
const afterOpen2  = parseSlot('after-open2');
const afterClose2 = parseSlot('after-close2');
const afterOpen3  = parseSlot('after-open3');
const afterClose3 = parseSlot('after-close3');

const delta = afterOpen1 && baseline ? afterOpen1.used - baseline.used : null;

const checks = [
  { name: 'baseline slot count read',          pass: !!baseline },
  { name: 'open #1 added slots (>0)',          pass: !!afterOpen1 && afterOpen1.used > baseline.used },
  { name: 'close #1 returned to baseline',     pass: !!afterClose1 && afterClose1.used === baseline.used },
  { name: 'open #2 added same delta',          pass: !!afterOpen2 && afterOpen2.used - baseline.used === delta },
  { name: 'close #2 returned to baseline',     pass: !!afterClose2 && afterClose2.used === baseline.used },
  { name: 'open #3 added same delta',          pass: !!afterOpen3 && afterOpen3.used - baseline.used === delta },
  { name: 'close #3 returned to baseline',     pass: !!afterClose3 && afterClose3.used === baseline.used },
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
