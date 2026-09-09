'use strict';

// The region JIT, installed into a program that is already running, and taken
// back out again when the program rewrites the loop it compiled.
//
// Two things are being checked, and only the second one is new. The first is
// that a region installed MID-FLIGHT computes what the interpreter computes:
// the swap moves the running program onto a second wasm instance over the same
// memory, and everything the guest owns that lives in a wasm GLOBAL rather than
// in that memory -- every register, the segment bases, the lazy-flag state, the
// x87 file -- has to be carried across by hand (region-live.js `carryState`). A
// register left behind is not a crash; it is a wrong number, days later.
//
// The second is the drop. The program patches the immediate INSIDE its hot loop
// and runs the same loop again with a different constant, so a region that
// stayed installed would keep computing the old sum and the answer would be
// wrong in a way that no crash reports. The JIT is expected to notice (its
// guard bytes no longer match memory), uninstall, flush, and let the
// interpreter decode the rewritten loop.
//
// Both arms are compared against a closed-form answer computed here as well,
// so an agreement between two arms that are both wrong cannot pass.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runDos } = require('../tools/toyvm/run-dos');
const { inlineBackend } = require('../tools/toyvm/region-prepare');

// An ODD iteration count, and a rep count that is not a multiple of 4. Both
// matter: `dx ^= XOR` is its own inverse, so an even inner count returns dx to
// where it started and an even number of those returns bx to zero -- and a
// test whose expected answer is 0 in every register passes on an emulator that
// has stopped computing anything at all. The assertion below refuses a zero.
const INNER = 0x3FFF;      // iterations of the hot loop per outer rep
const REPS1 = 200;         // outer reps before the patch
const REPS2 = 100;         // ...and after it
const ADD1 = 7;            // the immediate the hot loop starts with
const ADD2 = 9;            // ...and the one it is rewritten to
const XOR = 0x5A5A;

// A .COM. Two calls to one subroutine with a store between them that rewrites
// an immediate in the subroutine's inner loop, then the low 16 bits of the
// accumulator as four hex digits.
//
// The inner loop is deliberately dull: four instructions, no call, no branch
// but its own back edge, and a live register (dx) carried across iterations.
// That is the shape region-jit.js can lower, which is the point -- this test is
// about the install and the drop, not about the matcher's reach.
function program() {
  const b = [];
  const w = (...x) => b.push(...x);
  const lo = (n) => n & 0xFF, hi = (n) => (n >> 8) & 0xFF;
  //                                        addr  what
  w(0xB9, lo(REPS1), hi(REPS1));           // 0100 mov cx,REPS1
  w(0x31, 0xDB);                           // 0103 xor bx,bx
  w(0x31, 0xF6);                           // 0105 xor si,si
  w(0x31, 0xFF);                           // 0107 xor di,di      <- outer1:
  w(0x31, 0xD2);                           // 0109 xor dx,dx
  w(0xE8, 0x52, 0x00);                     // 010B call 0160
  w(0x01, 0xD3);                           // 010E add bx,dx
  w(0xE2, 0xF5);                           // 0110 loop 0107
  w(0xB0, ADD2);                           // 0112 mov al,ADD2
  w(0x2E, 0xA2, 0x62, 0x01);               // 0114 mov cs:[0162],al   <- the patch
  w(0xB9, lo(REPS2), hi(REPS2));           // 0118 mov cx,REPS2
  w(0x31, 0xFF);                           // 011B xor di,di      <- outer2:
  w(0x31, 0xD2);                           // 011D xor dx,dx
  w(0xE8, 0x3E, 0x00);                     // 011F call 0160
  w(0x01, 0xD3);                           // 0122 add bx,dx
  w(0xE2, 0xF5);                           // 0124 loop 011B
  w(0xB9, 0x04, 0x00);                     // 0126 mov cx,4
  w(0xC1, 0xC3, 0x04);                     // 0129 rol bx,4
  w(0x88, 0xD8);                           // 012C mov al,bl
  w(0x24, 0x0F);                           // 012E and al,0Fh
  w(0x04, 0x30);                           // 0130 add al,'0'
  w(0x3C, 0x39);                           // 0132 cmp al,'9'
  w(0x76, 0x02);                           // 0134 jbe 0138
  w(0x04, 0x07);                           // 0136 add al,7
  w(0x88, 0xC2);                           // 0138 mov dl,al
  w(0xB4, 0x02);                           // 013A mov ah,2
  w(0xCD, 0x21);                           // 013C int 21h
  w(0xE2, 0xE9);                           // 013E loop 0129
  w(0xB8, 0x00, 0x4C);                     // 0140 mov ax,4C00h
  w(0xCD, 0x21);                           // 0143 int 21h
  while (b.length < 0x60) w(0x90);         // 0145 nop, to 0160
  // THE LOOP HEAD IS THE SUBROUTINE'S ENTRY, THE EXIT IS THE CONDITIONAL AND
  // THE BACK EDGE IS A `jmp`. None of that is stylistic. The compiler traces
  // straight through a conditional whose fall-through it lays down next, so a
  // loop with its setup in front of it and `jnz head` at the bottom becomes ONE
  // block whose head is the setup -- and the walker then reports "top-tested
  // inner loop at ip N: no exit continued" and picks nothing. The measured
  // shape of a region that IS picked (DRAGON.EXE at 0xb65) is this one: the
  // block head is the loop head, the conditional leaves the region, and the
  // bottom `jmp` closes it.
  w(0x83, 0xC2, ADD1);                     // 0160 add dx,ADD1    <- hot:, imm at 0162
  w(0x81, 0xF2, lo(XOR), hi(XOR));         // 0163 xor dx,XOR
  w(0x46);                                 // 0167 inc si
  w(0x47);                                 // 0168 inc di
  w(0x81, 0xFF, lo(INNER), hi(INNER));     // 0169 cmp di,INNER
  w(0x74, 0x02);                           // 016D jz 0171
  w(0xEB, 0xEF);                           // 016F jmp 0160
  w(0xC3);                                 // 0171 ret
  return Buffer.from(b);
}

// The same arithmetic, in JavaScript. Not a second implementation of the
// emulator -- four operations over four lines -- and it is what stops two
// agreeing-but-wrong arms from passing.
function expected() {
  let bx = 0, si = 0, dx = 0;
  for (const [reps, add] of [[REPS1, ADD1], [REPS2, ADD2]]) {
    for (let r = 0; r < reps; r++) {
      dx = 0;
      for (let i = 0; i < INNER; i++) {
        dx = (dx + add) & 0xFFFF;
        dx = (dx ^ XOR) & 0xFFFF;
        si = (si + 1) & 0xFFFF;
      }
      bx = (bx + dx) & 0xFFFF;
    }
  }
  return { bx, si, dx };
}

async function run(com, jit) {
  const r = await runDos({
    exe: com,
    budget: 120e6,
    // Samples are taken once per slice, so the slice length is the sampling
    // rate: at the 2M default this whole program is a handful of samples and
    // the pick is a coin toss between two blocks.
    slice: 5e4,
    log: () => {},
    regionJit: jit ? {
      sampleAfter: 2e6, profileFor: 4e6, minOps: 2,
      // The audit's AGREEMENT half is never optional and still runs. Its speed
      // bar is dropped, because this test is about correctness and the bar is a
      // measurement: on a loaded machine one region measured 2.62x and 0.84x an
      // hour apart, and a run that declines installs nothing and would grade
      // itself on a JIT that never engaged.
      gateAt: 0,
      backend: inlineBackend(),
      log: () => {},
    } : null,
  });
  const regs = r.vm.getAll();
  return {
    bx: regs.bx, si: regs.si, dx: regs.dx,
    frame: r.frame, cells: r.text.cells, written: r.machine.con.written,
    dispatched: r.dispatched, jit: r.jit,
  };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyvm-region-live-'));
  const com = path.join(dir, 'REGION.COM');
  fs.writeFileSync(com, program());

  const want = expected();
  assert.ok(want.bx !== 0 && want.si !== 0,
    `the constants degenerated to zero (bx ${want.bx}, si ${want.si}) -- pick `
    + 'an odd INNER and a REPS pair whose sum is not a multiple of 4');
  const off = await run(com, false);
  const on = await run(com, true);

  // The interpreter is right about its own arithmetic before anything is said
  // about the JIT.
  assert.strictEqual(off.bx, want.bx, `interpreter bx: got ${off.bx}, want ${want.bx}`);
  assert.strictEqual(off.si, want.si, `interpreter si: got ${off.si}, want ${want.si}`);
  // dx is not checked against the closed form: the hex printer at 0116 puts
  // each digit in dl for INT 21h/2, so what is left in dx at exit is the last
  // character printed, not the loop's accumulator. It is still compared BETWEEN
  // the two arms below, where it is a register the swap had to carry.

  const j = on.jit;
  assert.ok(j, 'the JIT reported nothing at all');
  assert.ok(j.installs >= 1,
    `no region was installed (phase ${j.phase}${j.declined ? `: ${j.declined}` : ''})`);
  // The patch lands inside the installed region's own bytes, so the region has
  // to go. A drop that never happens is the failure this test exists for: the
  // program would keep running a loop compiled from code it has replaced.
  assert.ok(j.drops >= 1,
    `the region survived the guest rewriting its own loop (installs ${j.installs}, drops ${j.drops})`);

  for (const k of ['bx', 'si', 'dx']) {
    assert.strictEqual(on[k], off[k],
      `${k} differs with the JIT on: ${on[k]} vs ${off[k]} interpreted`);
  }
  // ...and the screen, which is where a carried-across register that went
  // missing would actually be noticed by a person.
  assert.strictEqual(on.frame, off.frame, 'the frame hash differs with the JIT on');
  assert.strictEqual(on.cells, off.cells, 'the text screen differs with the JIT on');
  assert.strictEqual(on.written, off.written, 'a different number of characters was printed');
  // The dispatch count is a CLOCK -- every timer, retrace and audio deadline in
  // this emulator is derived from it -- and a region charges $steps per op so
  // that it does not move. A region that billed itself as one dispatch would
  // show up here long before it showed up as a demo running at the wrong speed.
  //
  // The bound is one dispatch per INSTALL, not exact equality, and the
  // difference between those two is the whole point of the check. A region
  // charges $steps in one lump per straight line rather than one per op, so the
  // slice a swap lands in can overshoot its budget by up to the length of one
  // line; that is a fixed cost per transition. Measured across four rep counts
  // (200/100, 200/200, 400/100, 300/150) the gap was 1 or 2 dispatches against
  // 34-57M, always with two installs, and did NOT grow with the iteration count
  // -- which is what says it is the transition and not the loop. A region that
  // mis-billed its BODY would scale with those reps and blow this bound by
  // orders of magnitude on the first rep count that got raised.
  const drift = Math.abs(on.dispatched - off.dispatched);
  assert.ok(drift <= j.installs,
    `the dispatch clock moved by ${drift} across ${j.installs} install(s): `
    + `${on.dispatched} with the JIT vs ${off.dispatched} without`);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`PASS test-toyvm-region-live: bx=0x${want.bx.toString(16)} si=${want.si} `
    + `identical interpreted and jitted; ${j.installs} install(s), ${j.drops} drop(s), `
    + `region at 0x${(j.at && j.at[0] || 0).toString(16)}, `
    + `${on.dispatched} dispatches vs ${off.dispatched} (${drift} apart)`);
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
