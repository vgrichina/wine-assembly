#!/usr/bin/env node
// Tab focus regression for Notepad's modeless Find dialog.
//
// Drives Notepad's "Search > Find..." (menu id 3, common-dialog FindTextA
// → WAT-built $create_findreplace_dialog) and verifies Tab/Shift+Tab
// traversal across its 6 tabstops (Find-what edit, Match-case checkbox,
// Up radio, Down radio, Find Next button, Cancel button).
//
// Pass criteria:
//   1. Find dialog opens with initial focus on a control.
//   2. Tab #1..#5 each move focus to a new hwnd.
//   3. Tab #6 wraps back to a previously-visited hwnd.
//   4. >= 5 distinct focus hwnds visited.
//   5. Shift+Tab moves backward.
//   6. No UNIMPLEMENTED API crash.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'notepad.exe');

const inputSpec = [
  '150:0x111:3',                 // WM_COMMAND id 3 = Find
  '200:dump-focus:initial',
  '210:keydown:9',  '220:dump-focus:tab1',
  '230:keydown:9',  '240:dump-focus:tab2',
  '250:keydown:9',  '260:dump-focus:tab3',
  '270:keydown:9',  '280:dump-focus:tab4',
  '290:keydown:9',  '300:dump-focus:tab5',
  '310:keydown:9',  '320:dump-focus:tab6',
  '330:keydown:16', '340:keydown:9', '350:dump-focus:shifttab', '360:keyup:16',
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --input='${inputSpec}' --max-batches=400 --no-close`;
console.log('$', cmd.replace(ROOT, '.'));

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 60000, cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero — output captured)');
}

const focusLines = out.split('\n').filter(l => l.includes('[input] dump-focus'));
for (const l of focusLines) console.log('  ' + l);

function parseFocus(line) {
  const m = line.match(/dump-focus(?:\s+(\S+))?:\s+hwnd=0x([0-9a-f]+)\s+class=(-?\d+)\s+id=(-?\d+)/);
  if (!m) return null;
  return { label: m[1] || '', hwnd: parseInt(m[2], 16), cls: +m[3], id: +m[4] };
}

const focuses = focusLines.map(parseFocus).filter(Boolean);
const byLabel = Object.fromEntries(focuses.map(f => [f.label, f]));

const initial  = byLabel.initial;
const tab1     = byLabel.tab1;
const tab2     = byLabel.tab2;
const tab3     = byLabel.tab3;
const tab4     = byLabel.tab4;
const tab5     = byLabel.tab5;
const tab6     = byLabel.tab6;
const shifttab = byLabel.shifttab;

const tabSeq = [initial, tab1, tab2, tab3, tab4, tab5];
const distinct = new Set(focuses.map(f => f.hwnd).filter(h => h !== 0));

const checks = [
  {
    name: 'Find dialog opened (FindTextA logged)',
    pass: /\[FindTextA\]/.test(out),
  },
  {
    name: 'initial focus assigned by $dlg_seed_focus',
    pass: !!initial && initial.hwnd !== 0,
  },
  {
    name: 'initial focus is the Find-what Edit (class 2)',
    pass: !!initial && initial.cls === 2,
  },
  {
    name: 'Tab #1 changed focus',
    pass: !!tab1 && !!initial && tab1.hwnd !== initial.hwnd,
  },
  {
    name: 'Tab #2..#5 each advance focus',
    pass: tab2 && tab3 && tab4 && tab5
       && tab2.hwnd !== tab1.hwnd
       && tab3.hwnd !== tab2.hwnd
       && tab4.hwnd !== tab3.hwnd
       && tab5.hwnd !== tab4.hwnd,
  },
  {
    name: 'at least 5 distinct focus hwnds visited',
    pass: distinct.size >= 5,
  },
  {
    name: 'Tab #6 wrapped to a previously-visited hwnd',
    pass: !!tab6 && tabSeq.some(f => f && f.hwnd === tab6.hwnd),
  },
  {
    name: 'Shift+Tab moved backward (different hwnd than tab6)',
    pass: !!shifttab && !!tab6 && shifttab.hwnd !== tab6.hwnd,
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
console.log('');
console.log(`distinct focus hwnds: ${distinct.size}  (${[...distinct].map(h => '0x' + h.toString(16)).join(', ')})`);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
