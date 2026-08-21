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
// The first keystroke waits until batch 2400 because the document has to
// exist before a character can land in it: MFC 6.00 (the VC++ 6.0
// redistributable mfc42.dll) needs about twice as many batches to bring
// WordPad's view up as MFC 4.21 did, and typing into a not-yet-created
// RichEdit left WM_GETTEXTLENGTH at 0 — Select All then selected nothing and
// Copy published nothing.
const inputSpec = [
  '2400:keypress:72',
  '2430:keypress:101',
  '2460:keypress:108',
  '2800:post-cmd:57642',
  '3600:post-cmd:57634',
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --no-close --batch-size=100 ` +
  `--max-batches=4600 --trace-api=OleSetClipboard,CountClipboardFormats ` +
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
  // The argument is typed in api_table now, so the trace prints it by name
  // rather than as a bare hex dword. Match the value, not the punctuation.
  { name: 'RichEdit published a data object via OleSetClipboard',
    pass: /OleSetClipboard\((?:pDataObj=h:)?0x[0-9a-f]*[1-9a-f]/.test(out) },
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
