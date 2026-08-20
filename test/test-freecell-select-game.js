#!/usr/bin/env node
// FreeCell Select Game regression.
//
// This intentionally drives the real renderer input path instead of the
// edit-ok harness shortcut: open Select Game, type a new game number, and
// click OK. The bug this covers was a WAT/renderer visibility split where
// DialogBoxParamA made the JS window visible while WAT still considered the
// dialog HWND hidden, so dialog child hit-testing rejected the OK button.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'entertainment-pack', 'freecell.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  freecell.exe not found at', EXE);
  process.exit(0);
}

const TMP = path.join(ROOT, 'scratch');
fs.mkdirSync(TMP, { recursive: true });
const dialogPng = path.join(TMP, 'freecell_select_game_dialog.png');
const typedPng = path.join(TMP, 'freecell_select_game_typed.png');
const afterPng = path.join(TMP, 'freecell_select_game_after.png');
for (const p of [dialogPng, typedPng, afterPng]) {
  try { fs.unlinkSync(p); } catch (_) {}
}

const inputSpec = [
  '50:0x111:103',                         // Game > Select Game
  '80:wait-title:Game_Number:400',
  `100:png:${dialogPng}`,
  '120:keypress:49',                      // "1" replaces selected default text
  '130:keypress:50',                      // "2"
  `140:png:${typedPng}`,
  '160:click:150:200',                    // real mouse click on OK
  `280:png:${afterPng}`,
  '300:slot-count:after',
  '320:stop',
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --no-close --input='${inputSpec}' --max-batches=420 --quiet-api`;
console.log('$', cmd.replace(ROOT, '.'));

let out = '';
let exitedNonZero = false;
try {
  out = execSync(cmd, {
    encoding: 'utf-8', timeout: 120000, cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  exitedNonZero = true;
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  console.log('(run.js exited non-zero - output captured)');
}

const checks = [];
const sizeOf = p => fs.existsSync(p) && fs.statSync(p).size > 1000;
checks.push({ name: 'run.js exited cleanly', pass: !exitedNonZero });
checks.push({ name: 'dialog snapshot written', pass: sizeOf(dialogPng) });
checks.push({ name: 'typed snapshot written', pass: sizeOf(typedPng) });
checks.push({ name: 'after snapshot written', pass: sizeOf(afterPng) });
checks.push({ name: 'Select Game changed title to #12', pass: /\[SetWindowText\] "FreeCell Game #12"/.test(out) });
checks.push({ name: 'dialog closed after OK click', pass: /\[input\] slot-count after: used=1\b/.test(out) });
checks.push({ name: 'no STUCK', pass: !/STUCK at EIP=/.test(out) });
checks.push({ name: 'no UNIMPLEMENTED API crash', pass: !/UNIMPLEMENTED API:/.test(out) });
checks.push({ name: 'no CRASH at batch', pass: !/\*\*\* CRASH/.test(out) });
checks.push({ name: 'no LinkError', pass: !/LinkError/.test(out) });

const interesting = out.split('\n').filter(l =>
  l.includes('SetWindowText') ||
  l.includes('slot-count') ||
  l.includes('STUCK') ||
  l.includes('UNIMPLEMENTED') ||
  l.includes('CRASH') ||
  l.includes('LinkError'));
for (const l of interesting) console.log('  ' + l);

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);
console.log(`Snapshots: ${dialogPng}  ${typedPng}  ${afterPng}`);
process.exit(failed > 0 ? 1 : 0);
