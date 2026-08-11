#!/usr/bin/env node
// Regression coverage for WordPad formatting-toolbar mouse commands.
// The accelerator path is covered separately; this verifies real toolbar
// clicks route through ToolbarWindow32 TBBUTTON.idCommand and MFC command UI.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const OUT_DIR = path.join(ROOT, 'test', 'output', 'wordpad-richedit');
const PLAIN_PNG = path.join(OUT_DIR, 'toolbar-format-buttons-plain.png');
const FORMATTED_PNG = path.join(OUT_DIR, 'toolbar-format-buttons.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const ctrlA = b => [
  `${b}:keydown:17`,
  `${b + 1}:keydown:65`,
  `${b + 2}:keyup:65`,
  `${b + 3}:keyup:17`,
];

const seq = [
  '70:click:40:150',
  '74:keypress:115',
  '75:keypress:116',
  '76:keypress:121',
  '77:keypress:108',
  '78:keypress:101',
  '84:dump-focus-state:typed',
  `88:png:${PLAIN_PNG}`,
  ...ctrlA(92),

  // Formatting toolbar y=80. The font/size combobox fields are real child
  // surfaces now, so the B/I/U buttons sit to their right.
  '104:click:320:80', // Bold
  '118:click:40:150',
  ...ctrlA(122),
  '136:dump-focus-charformat:bold',

  '146:click:342:80', // Italic
  '160:click:40:150',
  ...ctrlA(164),
  '178:dump-focus-charformat:bold-italic',

  '188:click:358:80', // Underline
  '202:click:40:150',
  ...ctrlA(206),
  '220:dump-focus-charformat:bold-italic-underline',
  '224:dump-focus-state:final',
  `228:png:${FORMATTED_PNG}`,
  '234:stop',
];

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=280',
  '--batch-size=50000',
  '--quiet-api',
];

console.log('$ node ' + args.map(a => JSON.stringify(a)).join(' '));

let out = '';
try {
  out = execFileSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  out = String(e.stdout || '') + String(e.stderr || '');
  console.log('(run.js exited non-zero or timed out - output captured)');
}

const interesting = out.split('\n').filter(l =>
  l.includes('ShowWindow') ||
  l.includes('dump-focus-state') ||
  l.includes('dump-focus-charformat') ||
  l.includes('[input] png') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH') ||
  l.includes('Unreachable code'));
for (const l of interesting) console.log('  ' + l);

function line(label) {
  return out.split('\n').find(l => l.includes(`dump-focus-charformat ${label}:`)) || '';
}

const bold = line('bold');
const boldItalic = line('bold-italic');
const all = line('bold-italic-underline');
const finalState = out.split('\n').find(l => l.includes('dump-focus-state final:')) || '';
const plainPngWritten = out.includes(`[input] png ${PLAIN_PNG} `);
const formattedPngWritten = out.includes(`[input] png ${FORMATTED_PNG} `);

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

check('WordPad reached ShowWindow', /\[ShowWindow\] hwnd=0x10001 cmd=10/.test(out));
check('typed text reached native RichEdit', /dump-focus-state typed: .*text="style"/.test(out));
check('toolbar Bold click toggled selected text bold',
  /bold=1 .*italic=0 .*underline=0/.test(bold));
check('toolbar Italic click preserved bold and added italic',
  /bold=1 .*italic=1 .*underline=0/.test(boldItalic));
check('toolbar Underline click preserved bold/italic and added underline',
  /bold=1 .*italic=1 .*underline=1/.test(all));
check('toolbar formatting clicks did not corrupt editor text',
  /text="style"/.test(finalState));
check('plain toolbar-format screenshot written',
  plainPngWritten && fs.existsSync(PLAIN_PNG) && fs.statSync(PLAIN_PNG).size > 0);
check('formatted toolbar-format screenshot written',
  formattedPngWritten && fs.existsSync(FORMATTED_PNG) && fs.statSync(FORMATTED_PNG).size > 0);
check('no UNIMPLEMENTED API crash', !/UNIMPLEMENTED API:/.test(out));
check('no runtime crash', !/CRASH|Unreachable code|EIP=0x00000000/.test(out));

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);

process.exit(failed ? 1 : 0);
