#!/usr/bin/env node
// Regression: pasting what WordPad just copied must not run through a freed
// data object.
//
// The OLE clipboard holds an IDataObject, and on a Copy that object belongs to
// riched20, not to us. Both clipboard entry points used to skip the AddRef for
// any object that was not one of ours, on the theory that whichever control
// published it keeps it alive. RichEdit does the opposite: it hands its only
// reference to OleSetClipboard and forgets about it. So when WordPad's Paste
// released the pointer OleGetClipboard had returned, the refcount reached zero,
// msvcrt freed the block, the next GetProcAddress name string ("CoLockObject-
// External") was allocated over it, and the following QueryInterface loaded
// "Obje" as a vtable pointer and called through address zero.
//
// The tell was EIP=0 with EAX=0x656a624f — four ASCII bytes where a vtable
// should be. Any future report of that shape is another object we hand out
// without taking a reference on.
//
// Both AddRefs now go through the object's own vtable, which means suspending
// the handler on the OLE guest-callback continuation (operation 29).
//
// PASS criteria:
//   - the copy publishes a data object
//   - the paste asks for it back
//   - execution never reaches EIP=0, and never loads ASCII as a vtable

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

// Type, select all, copy, cut, paste. The gaps are wide because each command
// runs a full metafile render of the selection.
//
// The first keystroke waits until batch 2400 because the document has to
// exist before a character can land in it: MFC 6.00 (the VC++ 6.0
// redistributable mfc42.dll) takes roughly twice as many batches to get
// WordPad's view up as MFC 4.21 does, and typing into a not-yet-created
// RichEdit left WM_GETTEXTLENGTH at 0, so Select All selected nothing and
// Copy had nothing to publish. Nothing was wrong with the emulator — the
// schedule was simply tuned to one DLL build's boot time.
const inputSpec = [
  '2400:keypress:72',
  '2430:keypress:101',
  '2460:keypress:108',
  '2800:post-cmd:57642',   // ID_EDIT_SELECT_ALL
  '3600:post-cmd:57634',   // ID_EDIT_COPY
  '5800:post-cmd:57637',   // ID_EDIT_CUT
  '7800:post-cmd:57633',   // ID_EDIT_PASTE
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --no-close --batch-size=100 ` +
  `--max-batches=12000 --repaint-every=200 ` +
  `--trace-api=OleSetClipboard,OleGetClipboard --input=${inputSpec}`;
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 900000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero — output captured)');
}

const cases = [];
const check = (name, pass, detail) => cases.push({ name, pass, detail });

const setCalls = (out.match(/OleSetClipboard\(/g) || []).length;
const getCalls = (out.match(/OleGetClipboard\(/g) || []).length;

check('the copy publishes a data object', setCalls > 0, `OleSetClipboard x${setCalls}`);
check('the paste asks for it back', getCalls > 0, `OleGetClipboard x${getCalls}`);
check('no crash', !/\*\*\* CRASH/.test(out), 'run.js reported a trap');
check('execution never reaches EIP=0', !/EIP=0x00000000/.test(out),
  'a call through a null vtable slot');
// The freed block was reused for an ASCII name string, so the giveaway is a
// printable-ASCII value where an object pointer belongs.
check('no ASCII loaded as an object pointer', !/EAX=0x656a624f/.test(out),
  'EAX = "Obje" — the data object was freed under us');

let failed = 0;
for (const c of cases) {
  if (c.pass) console.log(`PASS  ${c.name}`);
  else { failed++; console.log(`FAIL  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`); }
}
console.log('');
console.log(`${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
