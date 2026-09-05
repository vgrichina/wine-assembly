'use strict';

// A program parked on an instruction the decoder refuses is not running.
//
// When compileProgram cannot decode the instruction at a block's entry it emits
// `end, ip` -- a block that hands control straight back with the guest IP
// unmoved. Re-entering it retires one dispatch and changes nothing, forever.
// Nothing stopped that: DosSession's stuck detector needs a run of identical
// handbacks AND a floor of guest WORK under it (20M dispatches by default), and
// at one dispatch per handback that floor needs twenty million round trips to
// the host. STHINTRO.EXE's protector derails into the interrupt vector table at
// 0:18c and paid exactly that -- 8,888,943 handbacks in a 10M-dispatch run, 90%
// of the wall clock -- while the report claimed 10M dispatches of progress.
//
// The work floor is the right question for a program that is being executed. It
// is not a question at all for one that is not: no amount of guest time can
// make a refused byte decodable, and the only thing that ever does -- a write
// to those bytes -- drops the refusal with the block. So the floor is waived
// when the entry the slice ran was a refusal stub.
//
// This asserts on the counters run-dos prints, in both directions: the run
// stops and says where, and it stops in hundreds of handbacks rather than
// millions. Before the fix it reports neither -- it spends the whole budget.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RUN_DOS = path.join(__dirname, '..', 'tools', 'toyvm', 'run-dos.js');
const BUDGET = 2000000;

// A .COM that prints one character through the BIOS -- so the run has done
// something real and the detector cannot be passing on a program that never
// started -- and then executes ARPL, which is a protected-mode instruction the
// real-mode decoder declines. It is the same byte pair the STHINTRO.EXE derail
// lands on: `63 01` at 0:18c, the low half of interrupt vector 0x63.
function deadEntryCom() {
  return Uint8Array.from([
    0xB4, 0x0E,                     // mov ah, 0Eh   (teletype)
    0xB0, 0x41,                     // mov al, 'A'
    0xCD, 0x10,                     // int 10h
    0x63, 0x01,                     // arpl [bx+di], ax  -- refused in real mode
    0xCD, 0x20,                     // int 20h  (never reached)
  ]);
}

function run(exe) {
  const out = execFileSync(process.execPath, [
    RUN_DOS, exe, `--dispatches=${BUDGET}`, '--report', '--text',
  ], { encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  const m = /^\s*(\d+) handbacks/m.exec(out);
  assert.ok(m, `no handback line in the report:\n${out}`);
  const d = /([\d.]+)M dispatches/.exec(out);
  assert.ok(d, `no dispatch line in the report:\n${out}`);
  return { out, handbacks: Number(m[1]), dispatches: Number(d[1]) * 1e6 };
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyvm-dead-entry-'));
  const exe = path.join(dir, 'DEADENT.COM');
  fs.writeFileSync(exe, deadEntryCom());

  const r = run(exe);

  // The verdict, named. A run that simply ends at its budget prints no such
  // line, which is the whole complaint: it reads as a program that ran.
  assert.match(r.out, /stuck at [0-9a-f]+:[0-9a-f]+/,
    `the run never reported being stuck on the refused instruction:\n${r.out}`);

  // ...and the decoder saying so, so the test cannot pass on some unrelated
  // spin that happens to trip the same detector.
  assert.match(r.out, /decoder gave up at/,
    `the decoder did not refuse anything, so this program is not the case under`
    + ` test:\n${r.out}`);

  // The cost. The detector fires after 200 identical handbacks, so a few
  // hundred is what a stop looks like; the unfixed build spends the budget one
  // dispatch at a time and comes back with about two million of them.
  assert.ok(r.handbacks < 10000,
    `${r.handbacks} handbacks for a program that gets nowhere -- the run is`
    + ` still spinning on the refused entry:\n${r.out}`);
  assert.ok(r.dispatches < BUDGET,
    `the run spent its whole ${BUDGET}-dispatch budget on an instruction that`
    + ` never executes:\n${r.out}`);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`PASS test-toyvm-dead-entry: stopped after ${r.handbacks} handbacks`
    + ` and ${r.dispatches} dispatches instead of spending ${BUDGET}`);
}

main();
