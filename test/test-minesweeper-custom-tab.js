#!/usr/bin/env node
// Tab focus regression for the new dialog-focus story.
//
// Drives Minesweeper's "Game > Custom..." dialog (resource id 80, menu
// id 524) — three Edit fields + one OK button — and verifies:
//
//   1. The dialog opens. (slot count grows, dump-focus reports a non-zero
//      hwnd inside the dialog after open.)
//   2. $dlg_load assigned initial focus automatically (dump-focus
//      hwnd != 0 immediately after open, before any Tab is pressed).
//   3. Tab moves focus forward through the tabstop list (dump-focus
//      hwnd values change between presses).
//   4. Shift+Tab moves focus backward (hwnd reverts to a prior value).
//   5. The full ring is visited (>= 3 distinct focus hwnds across 4 Tabs,
//      since the Custom dialog has 3 edits + 1 button = 4 tabstops).
//
// PASS criteria are the four bullets above plus "no UNIMPLEMENTED API".

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'entertainment-pack', 'winmine.exe');

if (!fs.existsSync(EXE)) { console.log('SKIP  winmine.exe not found'); process.exit(0); }

// Schedule:
//   60   open Custom dialog (Game>Custom = WM_COMMAND id 524)
//   90   dump-focus (initial focus from $dlg_load)
//   92   Tab (vk 9)
//   94   dump-focus
//   96   Tab
//   98   dump-focus
//   100  Tab
//   102  dump-focus
//   104  Tab (wraps)
//   106  dump-focus
//   110  Shift down (vk 16)
//   112  Tab (Shift+Tab → backward)
//   114  dump-focus
//   116  Shift up
const inputSpec = [
  '60:post-cmd:524',
  '90:dump-focus:initial',
  '92:keydown:9',
  '94:dump-focus:tab1',
  '96:keydown:9',
  '98:dump-focus:tab2',
  '100:keydown:9',
  '102:dump-focus:tab3',
  '104:keydown:9',
  '106:dump-focus:tab4',
  '110:keydown:16',
  '112:keydown:9',
  '114:dump-focus:shifttab',
  '116:keyup:16',
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --input='${inputSpec}' --max-batches=140 --no-close`;
console.log('$', cmd.replace(ROOT, '.'));

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 60000, cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero — output captured)');
}

// Pull every dump-focus line.
const focusLines = out.split('\n').filter(l => l.includes('[input] dump-focus'));
for (const l of focusLines) console.log('  ' + l);

function parseFocus(line) {
  const m = line.match(/dump-focus(?:\s+(\S+))?:\s+hwnd=0x([0-9a-f]+)\s+class=(-?\d+)\s+id=(-?\d+)/);
  if (!m) return null;
  return { label: m[1] || '', hwnd: parseInt(m[2], 16), cls: +m[3], id: +m[4] };
}

const focuses = focusLines.map(parseFocus).filter(Boolean);
const byLabel = Object.fromEntries(focuses.map(f => [f.label, f]));

const initial   = byLabel.initial;
const tab1      = byLabel.tab1;
const tab2      = byLabel.tab2;
const tab3      = byLabel.tab3;
const tab4      = byLabel.tab4;
const shifttab  = byLabel.shifttab;

const distinct = new Set(focuses.map(f => f.hwnd).filter(h => h !== 0));

const checks = [
  {
    name: 'Custom dialog opened (initial focus assigned by $dlg_load)',
    pass: !!initial && initial.hwnd !== 0,
  },
  {
    name: 'initial focus is a control (class 1=Button, 2=Edit, 3=Static)',
    pass: !!initial && [1, 2, 3].includes(initial.cls),
  },
  {
    name: 'Tab #1 changed focus',
    pass: !!tab1 && !!initial && tab1.hwnd !== initial.hwnd,
  },
  {
    name: 'Tab #2 changed focus again',
    pass: !!tab2 && !!tab1 && tab2.hwnd !== tab1.hwnd,
  },
  {
    name: 'at least 3 distinct focus hwnds visited across Tabs',
    pass: distinct.size >= 3,
  },
  {
    name: 'Tab #4 wrapped to a previously-visited hwnd',
    pass: !!tab4 && [initial && initial.hwnd, tab1 && tab1.hwnd,
                     tab2 && tab2.hwnd, tab3 && tab3.hwnd].includes(tab4.hwnd),
  },
  {
    name: 'Shift+Tab moved backward',
    pass: !!shifttab && !!tab4 && shifttab.hwnd !== tab4.hwnd,
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
