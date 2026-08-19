#!/usr/bin/env node
// Regression: Notepad Find Next finds an existing substring and selects it.
//
// Covers both activation paths that have diverged before:
//   - real canvas mouse down/up on the Find Next button
//   - Enter key on the dialog default button
//   - first downward search with the main edit caret already at EOF

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'notepad.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  notepad.exe not found at', EXE);
  process.exit(0);
}

function chars(startBatch, text) {
  const seq = [];
  let b = startBatch;
  for (const ch of text) {
    seq.push(`${b}:keypress:${ch.charCodeAt(0)}`);
    b += 5;
  }
  return [seq, b];
}

function runCase(name, activateEvents, opts = {}) {
  const docText = opts.docText || 'hello';
  const findText = opts.findText || 'ell';
  const input = [];
  let b = 50;
  {
    const [seq, next] = chars(b, docText);
    input.push(...seq);
    b = next;
  }
  if (opts.home !== false) {
    input.push(`${b + 5}:keydown:36`); // VK_HOME: search forward from start.
  }
  input.push(`${b + 25}:dump-main-edit-state:before`);
  input.push(`${b + 35}:0x111:3`); // Search > Find...
  input.push(`${b + 75}:focus-find`);
  {
    const [seq, next] = chars(b + 80, findText);
    input.push(...seq);
    b = next;
  }
  input.push(`${b + 10}:dump-find`);
  input.push(...activateEvents(b + 20));
  input.push(`${b + 70}:dump-main-edit-state:after`);
  input.push(`${b + 75}:dump-fr`);

  const args = [
    RUN,
    `--exe=${EXE}`,
    `--input=${input.join(',')}`,
    `--max-batches=${b + 95}`,
    '--quiet-api',
    '--no-close',
  ];
  const r = spawnSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  console.log(`\n# ${name}`);
  for (const line of out.split('\n')) {
    if (/FindTextA|dump-main-edit-state|dump-find|mousedown|mouseup|keydown vk=13|MessageBox|dump-fr|UNIMPLEMENTED|CRASH/.test(line)) {
      console.log('  ' + line);
    }
  }
  return { name, out, status: r.status, signal: r.signal, error: r.error };
}

const cases = [
  runCase('mouse Find Next', b => [
    `${b}:mousedown:350:101`,
    `${b + 10}:mouseup:350:101`,
  ]),
  runCase('Enter default Find Next', b => [
    `${b}:keydown:13`,
  ]),
  runCase('Find from EOF starts at top', b => [
    `${b}:mousedown:350:101`,
    `${b + 10}:mouseup:350:101`,
  ], { docText: 'hello, w', findText: 'hel', home: false }),
];

const checks = [];
function check(name, pass) { checks.push([name, !!pass]); }

for (const c of cases) {
  check(`${c.name}: process exited`, c.status === 0 && !c.signal && !c.error);
  check(`${c.name}: Find dialog appeared`, c.out.includes('[FindTextA]'));
  if (c.name === 'Find from EOF starts at top') {
    check(`${c.name}: find edit contains hel`, /dump-find:.*editText="hel"/.test(c.out));
    check(`${c.name}: main edit started at EOF`, /dump-main-edit-state before:.*cursor=8 sel=8 .*text="hello, w"/.test(c.out));
    check(`${c.name}: selected prefix hel`, /dump-main-edit-state after:.*cursor=3 sel=0 .*text="hello, w"/.test(c.out));
  } else {
    check(`${c.name}: find edit contains ell`, /dump-find:.*editText="ell"/.test(c.out));
    check(`${c.name}: main edit started at cursor 0`, /dump-main-edit-state before:.*cursor=0 sel=0 .*text="hello"/.test(c.out));
    check(`${c.name}: selected substring ell`, /dump-main-edit-state after:.*cursor=4 sel=1 .*text="hello"/.test(c.out));
  }
  const term = c.name === 'Find from EOF starts at top' ? 'hel' : 'ell';
  check(`${c.name}: FINDREPLACE has FR_FINDNEXT and ${term}`, (() => {
    const m = c.out.match(new RegExp(`dump-fr: flags=0x([0-9a-f]+) findWhat="${term}"`));
    return !!m && (parseInt(m[1], 16) & 0x08) !== 0;
  })());
  check(`${c.name}: no not-found MessageBox`, !c.out.includes(`Cannot find "${term}"`));
  check(`${c.name}: no UNIMPLEMENTED`, !c.out.includes('UNIMPLEMENTED'));
  check(`${c.name}: no CRASH`, !c.out.includes('CRASH'));
}

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
