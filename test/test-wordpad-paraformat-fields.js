#!/usr/bin/env node
// Focused WordPad/RichEdit paragraph-format field coverage.
//
// The existing paragraph test covers WordPad's Ctrl+E alignment command and
// simple RTF center-alignment round-trip. This probe directly applies the other
// basic PARAFORMAT fields to the focused native RichEdit child and verifies
// EM_GETPARAFORMAT readback: numbering, start/right indent, first-line offset,
// and the first tab stop.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

const seq = [
  '70:click:40:150',
  '74:keypress:112',
  '75:keypress:97',
  '76:keypress:114',
  '77:keypress:97',
  '82:dump-focus-state:typed',
  '86:keydown:17',
  '87:keydown:65',
  '88:keyup:65',
  '89:keyup:17',
  '94:dump-focus-state:selected',
  '98:set-focus-paraformat-basic:1:720:360:-240:1440:applied',
  '106:dump-focus-paraformat:applied',
  '112:set-focus-paraformat-align:3:centered',
  '122:dump-focus-paraformat:centered',
  '126:stop',
];

const args = [
  RUN,
  `--exe=${EXE}`,
  `--input=${seq.join(',')}`,
  '--max-batches=180',
  '--batch-size=50000',
  '--quiet-blocks',
  '--quiet-api',
  '--no-close',
];

console.log('$ node ' + args.map(a => JSON.stringify(a)).join(' '));

let out = '';
try {
  out = execFileSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
} catch (e) {
  out = String(e.stdout || '') + String(e.stderr || '');
  console.log('(run.js exited non-zero or timed out - output captured)');
}

const interesting = out.split('\n').filter(l =>
  l.includes('ShowWindow') ||
  l.includes('dump-focus-state') ||
  l.includes('set-focus-paraformat') ||
  l.includes('dump-focus-paraformat') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH') ||
  l.includes('Unreachable code'));
for (const l of interesting) console.log('  ' + l);

function line(label, kind = 'dump-focus-paraformat') {
  const prefix = `${kind} ${label}:`;
  return out.split('\n').find(l => l.includes(prefix)) || '';
}

const typed = line('typed', 'dump-focus-state');
const selected = line('selected', 'dump-focus-state');
const appliedSet = line('applied', 'set-focus-paraformat-basic');
const applied = line('applied');
const centeredSet = line('centered', 'set-focus-paraformat-align');
const centered = line('centered');

const checks = [];
function check(name, pass) { checks.push({ name, pass: !!pass }); }

check('WordPad reached ShowWindow', /ShowWindow\] hwnd=0x10001/.test(out));
check('typed text reached native RichEdit', /text="para"/.test(typed));
check('Ctrl+A selected the native RichEdit text', /sel=0\.\.[1-9][0-9]*/.test(selected));
check('basic paragraph field set returned success', /ret=0x1/.test(appliedSet));
check('numbering read back', /numbering=1/.test(applied));
check('start indent read back', /dxStartIndent=720/.test(applied));
check('right indent read back', /dxRightIndent=360/.test(applied));
check('first-line offset read back', /dxOffset=-240/.test(applied));
check('first tab stop read back', /tabCount=1/.test(applied) && /tab0=1440/.test(applied));
check('alignment set returned success', /ret=0x1/.test(centeredSet));
check('alignment read back with previous fields preserved',
  /alignment=3/.test(centered) &&
  /numbering=1/.test(centered) &&
  /dxStartIndent=720/.test(centered) &&
  /dxRightIndent=360/.test(centered) &&
  /dxOffset=-240/.test(centered) &&
  /tabCount=1/.test(centered) &&
  /tab0=1440/.test(centered));
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
