#!/usr/bin/env node
// Notepad basic-shape regression: one process run, many assertions over its
// trace output. Focuses on the bits NOT covered by test-notepad-menu.js /
// test-notepad-menu-items.js / test-notepad-find.js / test-find-typing.js:
//
//   - clean exit
//   - main window + edit child created with expected hwnds/style
//   - edit child gets a sane, positive MoveWindow rect (no negative-height
//     regression from the old window-sizing bug)
//   - PNG snapshot actually gets written after some typing
//   - no UNIMPLEMENTED API crash
//
// Keeps all checks against a single traced run so the runtime cost stays low.

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

const TMP = path.join(ROOT, 'scratch');
fs.mkdirSync(TMP, { recursive: true });
const pngPath = path.join(TMP, 'notepad_basic.png');
try { fs.unlinkSync(pngPath); } catch (_) {}

// Type "Test" then let notepad idle for a couple of batches before quitting
// (no --no-close → clean WM_CLOSE path, so we also exercise exit-code=0).
const inputSpec = [
  '30:keypress:84',   // 'T'
  '31:keypress:101',  // 'e'
  '32:keypress:115',  // 's'
  '33:keypress:116',  // 't'
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --input=${inputSpec} --max-batches=80 --batch-size=50000 --trace-api --png="${pngPath}"`;
console.log('$', cmd);

let out = '';
let exitCode = 0;
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 60000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  exitCode = e.status ?? 1;
  console.log(`(run.js exited non-zero status=${exitCode} — output captured)`);
}

// Check individual API log lines (one pass over the trace output).
const hasCreateMain   = /CreateWindow.*hwnd=0x10001/.test(out);
const hasCreateEdit   = /CreateWindow.*hwnd=0x10002/.test(out);
const hasEditStyle    = /style=0x50300104/.test(out);
// MoveWindow on the edit child is optional — notepad may size it correctly
// at CreateWindow time. But if MoveWindow IS called on it, the dimensions
// must not be negative (the old window-sizing bug produced 0xffff... heights).
const hasNegHeight    = /MoveWindow\(0x00010002,[^\)]*0xfffff/.test(out);
const hasUnimpl       = /UNIMPLEMENTED API:/.test(out);
const hasCleanExit    = /Exit.*code=0/.test(out) || exitCode === 0;
const pngWritten      = fs.existsSync(pngPath) && fs.statSync(pngPath).size > 0;

const checks = [
  { name: 'main window created (hwnd=0x10001)',  pass: hasCreateMain },
  { name: 'edit control created (hwnd=0x10002)', pass: hasCreateEdit },
  { name: 'edit style multiline (0x50300104)',    pass: hasEditStyle },
  { name: 'edit MoveWindow rect logged',          pass: hasMoveWindow },
  { name: 'no negative-height MoveWindow',        pass: !hasNegHeight },
  { name: 'no UNIMPLEMENTED API crash',           pass: !hasUnimpl },
  { name: 'PNG snapshot written',                 pass: pngWritten },
  { name: 'clean exit (code=0)',                  pass: hasCleanExit },
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
