#!/usr/bin/env node
// Regression coverage for WordPad Edit-menu clipboard commands.
//
// WordPad/MFC uses standard edit command ids (ID_EDIT_COPY/CUT/PASTE/
// SELECT_ALL). The emulator's WAT menu activation bridges those ids to
// focused native RichEdit plain-text messages so everyday menu Copy/Cut/Paste
// works without entering RichEdit's rich/OLE clipboard storage path.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const COPY_PNG = path.join(OUT_DIR, 'menu-edit-copy-paste.png');
const CUT_PNG = path.join(OUT_DIR, 'menu-edit-cut-paste.png');
const TEXT = 'menu';

const ID_EDIT_COPY = 57634;
const ID_EDIT_CUT = 57635;
const ID_EDIT_PASTE = 57637;
const ID_EDIT_SELECT_ALL = 57642;

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

function typeTextSeq(startBatch) {
  const seq = ['70:click:40:150'];
  let b = startBatch;
  for (const ch of TEXT) {
    seq.push(`${b}:keypress:${ch.charCodeAt(0)}`);
    b += 1;
  }
  return seq;
}

function runScenario(name, seq, maxBatches) {
  const traceApis = [
    'CreateILockBytesOnHGlobal',
    'StgCreateDocfileOnILockBytes',
  ].join(',');
  const args = [
    RUN,
    `--exe=${EXE}`,
    `--input=${seq.join(',')}`,
    `--max-batches=${maxBatches}`,
    '--batch-size=50000',
    '--quiet-api',
    '--quiet-blocks',
    `--trace-api=${traceApis}`,
    '--no-close',
  ];
  console.log(`$ ${name}: node ${args.map(a => JSON.stringify(a)).join(' ')}`);
  try {
    return execFileSync('node', args, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    console.log(`(${name} exited non-zero or timed out - output captured)`);
    return String(e.stdout || '') + String(e.stderr || '');
  }
}

const copySeq = typeTextSeq(74);
copySeq.push('84:dump-focus-state:copy-typed');
copySeq.push(`96:menu-edit-command:${ID_EDIT_SELECT_ALL}:copy-select-all`);
copySeq.push('110:dump-focus-state:copy-selected');
copySeq.push(`124:menu-edit-command:${ID_EDIT_COPY}:copy`);
copySeq.push('142:keydown:39');
copySeq.push('143:keyup:39');
copySeq.push(`160:menu-edit-command:${ID_EDIT_PASTE}:paste`);
copySeq.push('190:dump-focus-state:after-copy-paste');
copySeq.push(`194:png:${COPY_PNG}`);
copySeq.push('198:stop');

const cutSeq = typeTextSeq(74);
cutSeq.push('84:dump-focus-state:cut-typed');
cutSeq.push(`96:menu-edit-command:${ID_EDIT_SELECT_ALL}:cut-select-all`);
cutSeq.push('110:dump-focus-state:cut-selected');
cutSeq.push(`124:menu-edit-command:${ID_EDIT_CUT}:cut`);
cutSeq.push('155:dump-focus-state:after-cut');
cutSeq.push(`170:menu-edit-command:${ID_EDIT_PASTE}:paste`);
cutSeq.push('205:dump-focus-state:after-cut-paste');
cutSeq.push(`209:png:${CUT_PNG}`);
cutSeq.push('213:stop');

const copyOut = runScenario('copy-paste', copySeq, 240);
const cutOut = runScenario('cut-paste', cutSeq, 260);
const combined = copyOut + '\n' + cutOut;

for (const line of combined.split('\n')) {
  if (
    line.includes('ShowWindow') ||
    line.includes('dump-focus-state') ||
    line.includes('menu-edit-command') ||
    line.includes('CreateILockBytesOnHGlobal') ||
    line.includes('StgCreateDocfileOnILockBytes') ||
    line.includes('png ') ||
    line.includes('UNIMPLEMENTED') ||
    line.includes('CRASH') ||
    line.includes('Unreachable code')
  ) {
    console.log('  ' + line);
  }
}

function line(out, label) {
  const marker = `dump-focus-state ${label}:`;
  return out.split('\n').find(l => l.includes(marker)) || '';
}

function commandRet(out, label, id) {
  const re = new RegExp(`menu-edit-command ${label}: id=${id} ret=1`);
  return re.test(out);
}

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

check('copy scenario reached WordPad ShowWindow', /ShowWindow\] hwnd=0x10001/.test(copyOut));
check('copy scenario typed text reached native RichEdit', /len=4 .*text="menu"/.test(line(copyOut, 'copy-typed')));
check('menu Select All selected copy text', commandRet(copyOut, 'copy-select-all', ID_EDIT_SELECT_ALL) && /sel=0\.\.[1-9][0-9]*/.test(line(copyOut, 'copy-selected')));
check('menu Copy command was bridged', commandRet(copyOut, 'copy', ID_EDIT_COPY));
check('menu Paste command was bridged', commandRet(copyOut, 'paste', ID_EDIT_PASTE));
check('menu Copy then Paste duplicated text', /len=8 .*text="menumenu"/.test(line(copyOut, 'after-copy-paste')));
check('copy/paste screenshot written', fs.existsSync(COPY_PNG) && fs.statSync(COPY_PNG).size > 0);

check('cut scenario reached WordPad ShowWindow', /ShowWindow\] hwnd=0x10001/.test(cutOut));
check('cut scenario typed text reached native RichEdit', /len=4 .*text="menu"/.test(line(cutOut, 'cut-typed')));
check('menu Select All selected cut text', commandRet(cutOut, 'cut-select-all', ID_EDIT_SELECT_ALL) && /sel=0\.\.[1-9][0-9]*/.test(line(cutOut, 'cut-selected')));
check('menu Cut command was bridged', commandRet(cutOut, 'cut', ID_EDIT_CUT));
check('menu Cut cleared selected text', /len=0 .*text=""/.test(line(cutOut, 'after-cut')));
check('menu Paste restored cut text', commandRet(cutOut, 'paste', ID_EDIT_PASTE) && /len=4 .*text="menu"/.test(line(cutOut, 'after-cut-paste')));
check('cut/paste screenshot written', fs.existsSync(CUT_PNG) && fs.statSync(CUT_PNG).size > 0);

check('menu bridge avoided RichEdit OLE clipboard storage path',
  !/CreateILockBytesOnHGlobal|StgCreateDocfileOnILockBytes/.test(combined));
check('no UNIMPLEMENTED API crash', !/UNIMPLEMENTED API:/.test(combined));
check('no runtime crash', !/CRASH|Unreachable code|EIP=0x00000000/.test(combined));

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);

process.exit(failed ? 1 : 0);
