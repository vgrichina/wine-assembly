'use strict';

// AN INSTALL MUST NOT COST THE RUN A HANDBACK -- and the frame this is about is
// the one the guest is standing on.
//
// Putting a region in drops the compiled programs its guest bytes fall inside,
// and the shadow return stack (emit.js `$rpush`/`$rpop`) holds arena addresses
// into exactly those programs. The install used to CUT the stack at the lowest
// stale frame, which is sound -- a `ret` that misses falls back to the slow
// path and gets the right answer -- but it is not free: the miss ends the slice
// early, the unspent remainder shifts every later slice boundary, and every
// timer, retrace and audio deadline in this emulator is derived from where
// those boundaries fall. The result is a run whose frame, pixels, interrupts
// and total dispatch count are all identical and whose rendered AUDIO is not.
// That was BMGLP.EXE: one truncated frame, one extra handback (13,206 against
// 13,207 by 4M dispatches), a different wav for the rest of the program.
//
// test-toyvm-region-live.js cannot see this. It allows the dispatch clock to
// move by one per install -- a real and separate cost, the lump step charge a
// region bills per straight line -- and one is exactly what a single missed
// `ret` costs. So this test does not measure the clock at all. It checks the
// MECHANISM: that the install found a stale frame, re-pointed it instead of
// cutting, and that the run is byte-identical to the interpreter -- and it
// re-runs the same program with the repair switched off as a negative control,
// because a test that passes whether or not the code under it exists is not a
// test.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runDos } = require('../tools/toyvm/run-dos');
const { wavBytes } = require('../tools/toyvm/audio');
const { inlineBackend } = require('../tools/toyvm/region-prepare');

const INNER = 0x2FFF;      // iterations of the hot loop per call
const REPS = 260;          // calls
const ADD = 7;
const XOR = 0x5A5A;

// A .COM whose hot loop is REACHED THROUGH A CALL. That is the whole design:
// while the loop runs there is a live shadow-return frame pointing at the
// caller's compiled block, the caller sits in the same compiled program as the
// loop, and so an install that drops that program has a stale frame to deal
// with. A hot loop written inline in `main` would have an empty return stack
// and would pass this test no matter what the install did with it.
function program() {
  const b = [];
  const w = (...x) => b.push(...x);
  const lo = (n) => n & 0xFF, hi = (n) => (n >> 8) & 0xFF;
  //                                        addr  what
  w(0xB9, lo(REPS), hi(REPS));             // 0100 mov cx,REPS
  w(0x31, 0xDB);                           // 0103 xor bx,bx
  w(0x31, 0xF6);                           // 0105 xor si,si
  w(0x31, 0xFF);                           // 0107 xor di,di      <- outer:
  w(0x31, 0xD2);                           // 0109 xor dx,dx
  w(0xE8, 0x52, 0x00);                     // 010B call 0160
  w(0x01, 0xD3);                           // 010E add bx,dx
  w(0xE2, 0xF5);                           // 0110 loop 0107
  w(0xB8, 0x00, 0x4C);                     // 0112 mov ax,4C00h
  w(0xCD, 0x21);                           // 0115 int 21h
  while (b.length < 0x60) w(0x90);         // 0117 nop, to 0160
  // The shape region-jit.js lowers: the block head IS the loop head, the
  // conditional leaves the region and the bottom `jmp` closes it. See the same
  // note in test-toyvm-region-live.js.
  w(0x83, 0xC2, ADD);                      // 0160 add dx,ADD     <- hot:
  w(0x81, 0xF2, lo(XOR), hi(XOR));         // 0163 xor dx,XOR
  w(0x46);                                 // 0167 inc si
  w(0x47);                                 // 0168 inc di
  w(0x81, 0xFF, lo(INNER), hi(INNER));     // 0169 cmp di,INNER
  w(0x74, 0x02);                           // 016D jz 0171
  w(0xEB, 0xEF);                           // 016F jmp 0160
  w(0xC3);                                 // 0171 ret
  return Buffer.from(b);
}

// The same arithmetic in JavaScript, so an agreement between two arms that are
// both wrong cannot pass.
function expected() {
  let bx = 0, si = 0;
  for (let r = 0; r < REPS; r++) {
    let dx = 0;
    for (let di = 0; di < INNER; di++) { dx = ((dx + ADD) & 0xFFFF) ^ XOR; si = (si + 1) & 0xFFFF; }
    bx = (bx + dx) & 0xFFFF;
  }
  return { bx, si };
}

async function run(com, jit) {
  const r = await runDos({
    exe: com,
    budget: 120e6,
    // The slice length is the sampling rate: at the 2M default this program is
    // a handful of samples and the pick is a coin toss.
    slice: 5e4,
    // THE CLOCK THAT SHIPS, in both arms -- `latticeClock` is deliberately off.
    // It re-anchors every boundary to the absolute dispatch count and would
    // hide the exact cost this test is about.
    //
    // The audio is rendered for the same reason: nothing here makes a sound,
    // but the sample grid is a function of where the run loop handed back, so
    // a wav that moved IS a boundary that moved.
    audioRate: 22050,
    log: () => {},
    regionJit: jit ? {
      sampleAfter: 2e6, profileFor: 4e6, minOps: 2,
      // Correctness, not speed: the agreement half of the audit still runs.
      gateAt: 0,
      backend: inlineBackend(),
      log: () => {},
    } : null,
  });
  const regs = r.vm.getAll();
  return {
    bx: regs.bx, si: regs.si, frame: r.frame,
    wav: crypto.createHash('sha256')
      .update(Buffer.from(wavBytes(r.audioChunks, r.audioRate))).digest('hex').slice(0, 16),
    dispatched: r.dispatched, handbacks: r.handbacks, jit: r.jit,
  };
}

// region-live.js reads its install-side bisectors off process.argv, the way
// region-jit.js reads its own. Setting one here is how the negative control
// gets a build with the repair switched off without a second process.
async function withFlag(name, fn) {
  process.argv.push(`--${name}`);
  try { return await fn(); } finally {
    const i = process.argv.lastIndexOf(`--${name}`);
    if (i >= 0) process.argv.splice(i, 1);
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyvm-region-clock-'));
  const com = path.join(dir, 'CALLLOOP.COM');
  fs.writeFileSync(com, program());
  const want = expected();
  assert.ok(want.bx !== 0, 'the expected answer is zero, which an emulator that has stopped computing would also produce');

  const off = await run(com, false);
  assert.strictEqual(off.bx, want.bx, `interpreter bx: got ${off.bx}, want ${want.bx}`);
  assert.strictEqual(off.si, want.si, `interpreter si: got ${off.si}, want ${want.si}`);

  const on = await run(com, true);
  const j = on.jit;
  assert.ok(j && j.installs >= 1,
    `no region was installed (phase ${j && j.phase}${j && j.declined ? `: ${j.declined}` : ''})`
    + ' -- without an install this program tests nothing');
  // THE PATH HAS TO HAVE BEEN EXERCISED. A program whose return stack held no
  // stale frame agrees with the interpreter either way, and would grade a
  // repair that never ran.
  assert.ok(j.rtopRepaired >= 1,
    `the install found no stale return-stack frame to re-point (repaired ${j.rtopRepaired}, `
    + `cut ${j.rtopCut}) -- this program no longer reaches its hot loop through a call `
    + 'that is live at the install, so it says nothing about the repair');
  assert.strictEqual(j.rtopCut, 0,
    `${j.rtopCut} return-stack frame(s) were still cut: each one is a \`ret\` that will `
    + 'miss, and a miss is a handback the interpreter never took');

  assert.strictEqual(on.bx, off.bx, `bx differs with the JIT on: ${on.bx} vs ${off.bx}`);
  assert.strictEqual(on.si, off.si, `si differs with the JIT on: ${on.si} vs ${off.si}`);
  assert.strictEqual(on.frame, off.frame, 'the frame hash differs with the JIT on');
  assert.strictEqual(on.wav, off.wav,
    `the rendered audio differs with the JIT on (${on.wav} vs ${off.wav}): the install `
    + 'moved a slice boundary');
  // THE HANDBACK COUNT IS THE COST, DIRECTLY. Everything downstream of it --
  // where a timer lands, which guest instant the card's DMA is read at, what
  // the wav sounds like -- is a consequence, and on a program that makes no
  // sound and asks for no timer those consequences are invisible while the
  // cause is not. So this is the assertion, and the wav above is the symptom.
  assert.strictEqual(on.handbacks, off.handbacks,
    `the install cost the run ${on.handbacks - off.handbacks} handback(s) `
    + `(${on.handbacks} with the JIT vs ${off.handbacks} without)`);

  // --- the control: the same install with the repair switched off ----------
  // What this pins down is that the two assertions above are ABOUT the repair
  // and not about the program: with `--no-install-repair-rtop` the same install
  // over the same program cuts the frame it otherwise re-points, so a build
  // with the repair deleted lands on `rtopCut >= 1` and fails.
  //
  // It does NOT assert that the cut costs this program a handback. On BMGLP.EXE
  // it does -- one truncated frame, one extra handback, a different wav for the
  // rest of the run -- but that needs the missed `ret` to land inside a slice
  // that had budget left, and on a program this small the boundary it moves is
  // one this program never observes. A synthetic assertion that the cost is
  // always visible would be a claim about slice arithmetic, not about the fix.
  const cut = await withFlag('no-install-repair-rtop', () => run(com, true));
  assert.ok(cut.jit && cut.jit.installs >= 1, 'the control run installed no region');
  assert.strictEqual(cut.bx, off.bx,
    'the control run computed a different answer, so it is not a control for the clock');
  assert.ok(cut.jit.rtopCut >= 1,
    `the control cut no frame (cut ${cut.jit.rtopCut}, repaired ${cut.jit.rtopRepaired}) -- `
    + 'the switch is not reaching the install, so the assertions above prove nothing');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`PASS test-toyvm-region-install-clock: bx=0x${want.bx.toString(16)} si=${want.si}, `
    + `${j.installs} install(s), ${j.rtopRepaired} return frame(s) re-pointed and ${j.rtopCut} cut, `
    + `wav ${on.wav} == interpreter, ${on.handbacks} handbacks == interpreter`);
  console.log(`  control (--no-install-repair-rtop): ${cut.jit.rtopCut} frame(s) cut, `
    + `${cut.handbacks} handbacks against ${off.handbacks} interpreted`);
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
