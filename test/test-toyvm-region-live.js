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
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runDos } = require('../tools/toyvm/run-dos');
const { wavBytes } = require('../tools/toyvm/audio');
const { inlineBackend } = require('../tools/toyvm/region-prepare');

// A tiny assembler with labels. The first program below is laid out by hand
// with its addresses in the comments, which is readable exactly as long as
// nothing is ever inserted into it; the second one has three forward branches
// whose displacements would have to be recomputed by hand on every edit, so it
// gets this instead. `.COM`, so everything is relative to 0x100.
function asm() {
  const b = [], labels = new Map(), fixups = [];
  const at = () => 0x100 + b.length;
  return {
    w: (...x) => { b.push(...x); },
    label(n) { labels.set(n, at()); },
    rel8(n) { fixups.push({ i: b.length, n, size: 1 }); b.push(0); },
    rel16(n) { fixups.push({ i: b.length, n, size: 2 }); b.push(0, 0); },
    abs16(n) { fixups.push({ i: b.length, n, size: 2, abs: true }); b.push(0, 0); },
    at,
    done() {
      for (const f of fixups) {
        const target = labels.get(f.n);
        assert.ok(target !== undefined, `no such label: ${f.n}`);
        const v = f.abs ? target : target - (0x100 + f.i + f.size);
        if (f.size === 1) {
          assert.ok(v >= -128 && v <= 127, `${f.n} is out of rel8 range (${v})`);
          b[f.i] = v & 0xFF;
        } else { b[f.i] = v & 0xFF; b[f.i + 1] = (v >> 8) & 0xFF; }
      }
      return Buffer.from(b);
    },
  };
}

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

// ---------------------------------------------------------------------------
// THE EXIT THE AUDIT NEVER TAKES.
//
// The snapshot gate runs the region's ops 4000 times from a state the program
// really reached and compares registers and memory with the interpreter. 4000
// iterations of a loop whose behaviour changes on iteration 20,000 prove
// nothing about iteration 20,000 -- the audit is a check on the LOWERING of the
// ops it saw run, not a proof about every path through them. So this program
// has a second exit that the audit window cannot reach: a comparison against a
// counter that is only equal once, five outer reps in.
//
// If the region compiled that exit wrong -- a missing side exit, a successor
// that resumes at the wrong ip, a flag the lowering never had to get right
// because the audit never branched on it -- `bp` and the printed digits differ
// from the interpreter, and nothing about the first 4000 iterations would have
// said so.
const SX_INNER = 0x0FFF;   // iterations of the hot loop per outer rep
// Enough reps that the profile window (2M dispatches in, 4M wide) lands well
// inside the loop and the install has millions of iterations left to be wrong
// over. Roughly 12M iterations, ~75M dispatches.
const SX_REPS = 3000;
const SX_ADD = 5;
const SX_XOR = 0x3C3C;
// `si` counts across ALL reps and wraps at 16 bits, so this is equal once every
// 65,536 iterations: five times the audit window before the first one, ~187
// times over the run, and never on a rep boundary -- the state it exits from is
// mid-loop with a different `di` each time.
const SX_RARE = 0x5001;

function sideExitProgram() {
  const a = asm();
  const { w } = a;
  const lo = (n) => n & 0xFF, hi = (n) => (n >> 8) & 0xFF;
  w(0xB9, lo(SX_REPS), hi(SX_REPS));       // mov cx,SX_REPS
  w(0x31, 0xDB);                           // xor bx,bx
  w(0x31, 0xF6);                           // xor si,si
  w(0x31, 0xED);                           // xor bp,bp
  a.label('outer');
  w(0x31, 0xFF);                           // xor di,di
  w(0x31, 0xD2);                           // xor dx,dx
  w(0xE8); a.rel16('hot');                 // call hot
  w(0x01, 0xD3);                           // add bx,dx
  w(0xE2); a.rel8('outer');                // loop outer
  // bx and bp, as eight hex digits, so a wrong answer is visible on the screen
  // and not only in a register nobody prints.
  w(0x89, 0xD8);                           // mov ax,bx
  w(0xE8); a.rel16('hex');                 // call hex
  w(0x89, 0xE8);                           // mov ax,bp
  w(0xE8); a.rel16('hex');                 // call hex
  w(0xB8, 0x00, 0x4C);                     // mov ax,4C00h
  w(0xCD, 0x21);                           // int 21h
  // ax as four hex digits through INT 21h/2. Clobbers ax, cx and dx, all dead
  // at both call sites.
  a.label('hex');
  w(0x89, 0xC7);                           // mov di,ax
  w(0xB9, 0x04, 0x00);                     // mov cx,4
  a.label('hexloop');
  w(0xC1, 0xC7, 0x04);                     // rol di,4
  w(0x89, 0xF8);                           // mov ax,di
  w(0x24, 0x0F);                           // and al,0Fh
  w(0x04, 0x30);                           // add al,'0'
  w(0x3C, 0x39);                           // cmp al,'9'
  w(0x76, 0x02);                           // jbe +2
  w(0x04, 0x07);                           // add al,7
  w(0x88, 0xC2);                           // mov dl,al
  w(0xB4, 0x02);                           // mov ah,2
  w(0xCD, 0x21);                           // int 21h
  w(0xE2); a.rel8('hexloop');              // loop hexloop
  w(0xC3);                                 // ret
  // The hot loop. Same shape as the one above -- head is the block head, the
  // conditionals leave, the bottom `jmp` closes it -- with ONE MORE EXIT.
  a.label('hot');
  w(0x83, 0xC2, SX_ADD);                   // add dx,SX_ADD
  w(0x81, 0xF2, lo(SX_XOR), hi(SX_XOR));   // xor dx,SX_XOR
  w(0x46);                                 // inc si
  w(0x47);                                 // inc di
  w(0x81, 0xFF, lo(SX_INNER), hi(SX_INNER));  // cmp di,SX_INNER
  w(0x74); a.rel8('sxdone');               // jz sxdone      <- the common exit
  w(0x81, 0xFE, lo(SX_RARE), hi(SX_RARE)); // cmp si,SX_RARE
  w(0x74); a.rel8('rare');                 // jz rare        <- taken ONCE, at 20481
  w(0xEB); a.rel8('hot');                  // jmp hot
  a.label('rare');
  w(0x45);                                 // inc bp
  w(0xC3);                                 // ret
  a.label('sxdone');
  w(0xC3);                                 // ret
  return a.done();
}

// The same arithmetic in JavaScript, for the same reason as `expected()`.
function sideExitExpected() {
  let bx = 0, si = 0, bp = 0;
  for (let r = 0; r < SX_REPS; r++) {
    let dx = 0, di = 0;
    for (;;) {
      dx = (dx + SX_ADD) & 0xFFFF;
      dx = (dx ^ SX_XOR) & 0xFFFF;
      si = (si + 1) & 0xFFFF;
      di = (di + 1) & 0xFFFF;
      if (di === SX_INNER) break;
      if (si === SX_RARE) { bp = (bp + 1) & 0xFFFF; break; }
    }
    bx = (bx + dx) & 0xFFFF;
  }
  return { bx, si, bp };
}

async function run(com, jit) {
  const r = await runDos({
    exe: com,
    budget: 120e6,
    // Samples are taken once per slice, so the slice length is the sampling
    // rate: at the 2M default this whole program is a handful of samples and
    // the pick is a coin toss between two blocks.
    slice: 5e4,
    // THE CLOCK THAT SHIPS, in both arms. `latticeClock` is left off here on
    // purpose: the guarantee worth testing is that an install is invisible on
    // the clock people actually run, not on an experimental one. See
    // run-dos.js `latticeClock` and docs/toyvm-region-live.md.
    // THE AUDIO CLOCK, RENDERED. Nothing here makes a sound, but the render is
    // still a measurement of when the run loop handed back: the sample grid is
    // a function of the dispatch count and the Sound Blaster's DMA is fetched
    // at the instant a slice's audio is rendered. A region that ends its slice
    // somewhere the interpreter would not, or an install that costs the run a
    // handback it would not otherwise take, moves that instant -- and this is
    // where it shows, byte for byte, without needing a demo that plays music.
    audioRate: 22050,
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
    bx: regs.bx, si: regs.si, dx: regs.dx, bp: regs.bp,
    frame: r.frame, cells: r.text.cells, written: r.machine.con.written,
    wav: crypto.createHash('sha256')
      .update(Buffer.from(wavBytes(r.audioChunks, r.audioRate))).digest('hex').slice(0, 16),
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

  // --- and now the exit the audit never took ------------------------------
  const sxCom = path.join(dir, 'SIDEEXIT.COM');
  fs.writeFileSync(sxCom, sideExitProgram());
  const sxWant = sideExitExpected();
  assert.ok(sxWant.bp > 0,
    `the rare exit is never reached (bp ${sxWant.bp}) -- SX_RARE must be hit `
    + 'while si wraps, or this program says nothing about a side exit');
  const sxOff = await run(sxCom, false);
  const sxOn = await run(sxCom, true);
  assert.strictEqual(sxOff.bx, sxWant.bx, `interpreter bx: got ${sxOff.bx}, want ${sxWant.bx}`);
  assert.strictEqual(sxOff.bp, sxWant.bp, `interpreter bp: got ${sxOff.bp}, want ${sxWant.bp}`);
  assert.strictEqual(sxOff.si, sxWant.si, `interpreter si: got ${sxOff.si}, want ${sxWant.si}`);
  const sj = sxOn.jit;
  assert.ok(sj && sj.installs >= 1,
    `no region was installed over the side-exit loop (phase ${sj && sj.phase}`
    + `${sj && sj.declined ? `: ${sj.declined}` : ''}) -- without an install this `
    + 'program tests nothing');
  // bp is the whole point: it counts the exits the 4000-iteration audit window
  // never reached, and it is carried in a register the swap has to move.
  for (const k of ['bx', 'si', 'bp']) {
    assert.strictEqual(sxOn[k], sxOff[k],
      `${k} differs with the JIT on over the late side exit: ${sxOn[k]} vs ${sxOff[k]}`);
  }
  assert.strictEqual(sxOn.frame, sxOff.frame, 'the frame hash differs over the late side exit');
  assert.strictEqual(sxOn.cells, sxOff.cells, 'the text screen differs over the late side exit');
  // The audio clock, byte for byte. See `run`.
  assert.strictEqual(sxOn.wav, sxOff.wav,
    `the rendered audio differs with the JIT on (${sxOn.wav} vs ${sxOff.wav}): the `
    + 'region ended a slice somewhere the interpreter would not, or the install '
    + 'cost the run a handback');
  assert.strictEqual(on.wav, off.wav,
    `the rendered audio differs with the JIT on (${on.wav} vs ${off.wav})`);
  const sxDrift = Math.abs(sxOn.dispatched - sxOff.dispatched);
  assert.ok(sxDrift <= sj.installs + sj.drops,
    `the dispatch clock moved by ${sxDrift} across ${sj.installs} install(s) and `
    + `${sj.drops} drop(s): ${sxOn.dispatched} with the JIT vs ${sxOff.dispatched} without`);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`PASS test-toyvm-region-live: side exit bp=${sxWant.bp} bx=0x${sxWant.bx.toString(16)}`
    + ` identical over ${sj.installs} install(s), wav ${sxOn.wav}, `
    + `${sxDrift} dispatch(es) apart`);
  console.log(`PASS test-toyvm-region-live: bx=0x${want.bx.toString(16)} si=${want.si} `
    + `identical interpreted and jitted; ${j.installs} install(s), ${j.drops} drop(s), `
    + `region at 0x${(j.at && j.at[0] || 0).toString(16)}, `
    + `${on.dispatched} dispatches vs ${off.dispatched} (${drift} apart)`);
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
