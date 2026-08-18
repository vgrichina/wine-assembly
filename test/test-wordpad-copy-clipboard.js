#!/usr/bin/env node
// Regression: WordPad's Edit > Copy must reach the clipboard instead of
// trapping the emulator.
//
// Copy is not a clipboard call in WordPad — it is a whole rendering pass.
// RichEdit builds a CF_METAFILEPICT of the selection, and to size it MFC does
//
//   ScaleWindowExtEx(hdcMeta, 96, 300, 96, 300)
//
// on a DC whose window extent is still the default 1x1. Integer division
// truncated 1*96/300 to 0, and every later logical-to-device mapping on that
// DC divided by that zero: the run died with a WASM "divide by zero" whose
// stack named only $gdi_round_ratio, several layers below the actual mistake.
// A zero extent is not a legal DC state — SetWindowExtEx refuses one — so the
// scale now fails and leaves the extents alone.
//
// With that out of the way RichEdit publishes its data object, and
// CountClipboardFormats has to see it: WordPad gates both Paste and Paste
// Special on that count, and RichEdit's Copy puts nothing else on the
// clipboard, so a count of zero meant the app could not paste what it had
// just copied.
//
// PASS criteria:
//   - no CRASH and no divide by zero
//   - riched20 calls OleSetClipboard after the Copy command
//   - CountClipboardFormats reports a non-empty clipboard afterwards

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

// Type three characters, select all (ID_EDIT_SELECT_ALL), copy (ID_EDIT_COPY).
// The gaps are wide because Copy runs a full metafile render of the selection.
const inputSpec = [
  '1200:keypress:72',
  '1230:keypress:101',
  '1260:keypress:108',
  '1400:post-cmd:57642',
  '1800:post-cmd:57634',
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --no-close --batch-size=100 ` +
  `--max-batches=2600 --trace-api=OleSetClipboard,CountClipboardFormats ` +
  `--input=${inputSpec}`;
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 300000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero — output captured)');
}

for (const l of out.split('\n')) {
  if (/OleSetClipboard|CountClipboardFormats|CRASH|divide by zero|UNIMPLEMENTED/.test(l)) {
    console.log('  ' + l.trim());
  }
}

// --trace-api prints the return on its own line under the call.
const counts = [];
const lines = out.split('\n');
lines.forEach((l, i) => {
  if (!/\bCountClipboardFormats\(\)/.test(l)) return;
  const m = /=>\s*0x([0-9a-f]+)/.exec(lines[i + 1] || '');
  if (m) counts.push(parseInt(m[1], 16));
});

const checks = [
  { name: 'no emulator crash',            pass: !/\*\*\* CRASH/.test(out) },
  { name: 'no divide by zero',            pass: !/divide by zero/.test(out) },
  { name: 'no UNIMPLEMENTED API',         pass: !/UNIMPLEMENTED API:/.test(out) },
  { name: 'RichEdit published a data object via OleSetClipboard',
    pass: /OleSetClipboard\(0x[0-9a-f]*[1-9a-f]/.test(out) },
  { name: 'clipboard reads empty before the copy',
    pass: counts.length > 0 && counts[0] === 0 },
  { name: 'CountClipboardFormats non-zero after the copy',
    pass: counts.some(n => n > 0) },
];

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed ` +
  `(CountClipboardFormats returned ${counts.join(', ') || 'nothing'})`);
process.exit(failed > 0 ? 1 : 0);
