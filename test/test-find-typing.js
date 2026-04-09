#!/usr/bin/env node
// Regression: typing into Notepad's Find dialog "Find what" edit field.
//
// Drives the CLI emulator end-to-end:
//   1. Launch notepad
//   2. Open Edit > Find         (WM_COMMAND id 3)
//   3. Wait for the FindTextA dialog to appear
//   4. Programmatically focus the dialog edit ctrl   (focus-find)
//   5. Type 'A','B','C' via renderer.handleKeyPress  (keypress events)
//   6. Dump the dialog edit state                    (dump-find)
//
// PASS criteria:
//   - Find dialog appears                     ([FindTextA])
//   - focus-find finds an edit control        (focus-find log)
//   - keypress logs report editText growing   ([keypress] ... editText="A","AB","ABC")
//   - dump-find shows editText="ABC"          ([input] dump-find ...)
//
// Each criterion isolates a different link in the chain so the failure
// mode is diagnosable from a single run.

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

// Schedule:
//   batch 50  : open Find menu (Notepad's Find = id 3)
//   batch 90  : focus the find dialog edit ctrl
//   batch 92  : type 'A'
//   batch 94  : type 'B'
//   batch 96  : type 'C'
//   batch 100 : dump dialog state
//   batch 102 : click Find Next button (id=1) — exercises full WAT click chain
//   batch 104 : dump FINDREPLACE struct (Flags + lpstrFindWhat)
const inputSpec = [
  '50:0x111:3',
  '90:focus-find',
  '92:keypress:65',
  '94:keypress:66',
  '96:keypress:67',
  '100:dump-find',
  '102:find-click:1',
  '104:dump-fr',
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --input=${inputSpec} --max-batches=120`;
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 60000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero — output captured)');
}

// Diagnostic dump (truncated)
const lines = out.split('\n');
const interesting = lines.filter(l =>
  l.includes('FindTextA') ||
  l.includes('[keypress]') ||
  l.includes('focus-find') ||
  l.includes('dump-find') ||
  l.includes('[input]') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH'));
for (const l of interesting) console.log('  ' + l);

// Pass criteria
const checks = [
  {
    name: 'find dialog appeared',
    pass: /\[FindTextA\]/.test(out),
  },
  {
    name: 'focus-find found edit ctrl',
    pass: /focus-find: hwnd=/.test(out) && !/NO EDIT CTRL/.test(out) && !/NO FIND DIALOG/.test(out),
  },
  {
    name: 'keypress dispatched to WAT EditState',
    pass: /\[input\] keypress code=65/.test(out),
  },
  {
    name: 'editText accumulated to "ABC"',
    pass: /editText="ABC"|editText=\\"ABC\\"/.test(out),
  },
  {
    name: 'dump-find reports ABC',
    pass: /dump-find:.*editText="ABC"/.test(out),
  },
  {
    name: 'find-click reached WAT button',
    pass: /find-click: id=0x1 hwnd=/.test(out),
  },
  {
    name: 'Find Next wrote findWhat="ABC" through WAT',
    pass: /dump-fr: flags=0x[0-9a-f]*8 findWhat="ABC"/.test(out),
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
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
