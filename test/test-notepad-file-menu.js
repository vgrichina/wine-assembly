#!/usr/bin/env node
// Regression coverage for every Notepad File menu action:
//   New=9, Open=10, Save=1, Save As=2, Page Setup=32, Print=14, Exit=28.

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

function run(name, inputSpec, maxBatches = 180, extra = '') {
  const cmd = `node "${RUN}" --exe="${EXE}" --input='${inputSpec}' --max-batches=${maxBatches} --batch-size=50000 ${extra}`;
  console.log('$', name, cmd);
  try {
    return execSync(cmd, {
      encoding: 'utf-8', timeout: 90000, cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    return (e.stdout || '').toString() + (e.stderr || '').toString();
  }
}

function slot(out, label) {
  const m = out.match(new RegExp(`slot-count ${label}: used=(\\d+)`));
  return m ? parseInt(m[1], 10) : null;
}

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }
function noCrash(name, out) {
  check(`${name}: no UNIMPLEMENTED API`, !/UNIMPLEMENTED API:/.test(out));
  check(`${name}: no runtime crash`, !/CRASH|Unreachable code/.test(out));
}

// New on an unmodified document should not open a dialog or crash.
{
  const out = run('New', '30:slot-count:before,50:0x111:9,90:slot-count:after', 120, '--no-close');
  noCrash('New', out);
  check('New: no dialog on clean document', slot(out, 'before') !== null && slot(out, 'after') === slot(out, 'before'));
}

// Open an existing VFS file; this exercises GetOpenFileNameA -> CreateFileA
// -> ReadFile -> GetFileTitleA during Notepad title update. Use a relative
// filename so the shell cannot eat backslashes before run.js parses the input.
{
  const out = run('Open', [
    '30:slot-count:before',
    '50:0x111:10',
    '90:slot-count:opened',
    '95:open-dlg-pick:sources.md',
    '150:dump-main-edit',
  ].join(','), 220, '--trace-api=GetOpenFileNameA,GetFileTitleA,CreateFileA,ReadFile --no-close');
  noCrash('Open', out);
  check('Open: dialog opened', slot(out, 'opened') > slot(out, 'before'));
  check('Open: picked file accepted', /open-dlg-pick: sources\.md/i.test(out));
  check('Open: GetFileTitleA called', /GetFileTitleA/.test(out));
  check('Open: edit populated', /dump-main-edit: hwnd=0x[0-9a-f]+ text="[^"]+/.test(out));
}

// Save on an untitled document should route to Save As.
{
  const out = run('Save', '30:slot-count:before,50:0x111:1,90:slot-count:opened,95:class-cmd:12:2,130:slot-count:closed', 160, '--no-close');
  noCrash('Save', out);
  check('Save: Save As dialog opened for untitled document', slot(out, 'opened') > slot(out, 'before'));
  check('Save: dialog closed', slot(out, 'closed') === slot(out, 'before'));
}

// Save As directly opens the common dialog.
{
  const out = run('SaveAs', '30:slot-count:before,50:0x111:2,90:slot-count:opened,95:class-cmd:12:2,130:slot-count:closed', 160, '--no-close');
  noCrash('SaveAs', out);
  check('SaveAs: dialog opened', slot(out, 'opened') > slot(out, 'before'));
  check('SaveAs: dialog closed', slot(out, 'closed') === slot(out, 'before'));
}

for (const item of [
  { name: 'PageSetup', id: 32, input: `30:slot-count:before,50:0x111:32,90:slot-count:opened,95:class-cmd:13:2,130:slot-count:closed` },
  // Print first shows our PrintDlg stub, then Notepad displays its printer
  // error MessageBox. Close both dialogs before checking slot count.
  { name: 'Print', id: 14, input: `30:slot-count:before,50:0x111:14,90:slot-count:opened,95:class-cmd:13:2,110:class-cmd:16:1,140:slot-count:closed` },
]) {
  const out = run(item.name, item.input, 170, '--no-close');
  noCrash(item.name, out);
  check(`${item.name}: stub dialog opened`, slot(out, 'opened') > slot(out, 'before'));
  check(`${item.name}: stub dialog closed`, slot(out, 'closed') === slot(out, 'before'));
}

// Exit should terminate cleanly.
{
  const out = run('Exit', '50:0x111:28', 120);
  noCrash('Exit', out);
  check('Exit: process exited cleanly', /Exit.*code=0/.test(out));
}

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
