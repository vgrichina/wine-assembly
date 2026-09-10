'use strict';

// The decode-time expression-tree fold (tools/toyvm/tree-fold.js, `--tree-fold`)
// runs the same program, and folds exactly what it says it folds.
//
// Six hand-assembled .COM programs, each one shape:
//
//   dot       straight-line full-width arithmetic, 12 ops -- MUST fold
//   addrloop  a `loop`-terminated body that walks a pointer  -- MUST fold
//   incloop   an `inc si / cmp si,N / jne` loop              -- MUST fold
//   partial   an 8-bit write in the middle                   -- MUST NOT fold
//   alias     a store followed by a load                     -- MUST NOT fold
//   flagcons  an `adc` in the middle                         -- MUST NOT fold
//
// Every one runs its body two thousand times inside an outer loop, prints AX,
// BX, CX, DX, SI, DI and the arithmetic bits of FLAGS, and is run twice: once
// plain, once `--tree-fold`. THE PRINTED LINE MUST BE IDENTICAL. That is the
// whole claim the fold makes -- it charges the dispatches it removes and
// materializes the flags the terminator reads, so a folded run and an unfolded
// one are the same computation and not merely the same picture.
//
// The FLAGS word is in the comparison on purpose and is the part a naive fold
// gets wrong. Flags are lazy: an op records its inputs and the bits are
// computed only when something asks. A fold that hoisted the whole run into
// wasm locals and wrote the register file back at the end would leave the
// recorder holding the FIRST op's inputs rather than the last writer's, and
// nothing about the registers would show it -- the picture would be right and
// `pushf` would be wrong. Printing the six arithmetic bits is what makes that
// visible.
//
// And the three negative cases are not decoration. Each is a rule that costs
// real folds (the decline histogram on ACCIDENT is thousands of `partial-reg`
// and hundreds of `alias`), so each is a rule somebody will eventually want to
// relax -- and relaxing one without noticing it also fires HERE is how a fold
// starts computing something else.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ITER = 2000;              // outer-loop trips, in a memory counter
const COUNTER = 0x500;          // where that counter lives
const SNAP = 0x300;             // where the seven printed words are stashed
const TABLE = 0x200;            // addrloop's data

// --- a two-pass assembler, just big enough --------------------------------
//
// Bytes plus named labels, with one rel16 (`call phex`) and rel8 backward
// branches resolved by hand. Two passes because the print helper sits after
// the body and the body has to call forward into it.
function asm(build) {
  let labels = {};
  let out = null;
  for (let pass = 0; pass < 2; pass++) {
    const b = [];
    const w = (...x) => b.push(...x);
    const here = () => 0x100 + b.length;
    const label = (n) => { labels[n] = here(); };
    // Displacements are measured from the END of the instruction, and `here()`
    // is its FIRST byte -- the argument is evaluated before `w` pushes
    // anything. So a 2-byte rel8 branch is `target - (here() + 2)` and a 3-byte
    // rel16 call is `target - (here() + 3)`. Getting the rel8 wrong by one puts
    // the loop back one byte into the middle of its own first instruction,
    // which does not crash: it runs forever at a plausible-looking address.
    const rel8 = (n) => ((labels[n] === undefined ? here() + 2 : labels[n]) - (here() + 2)) & 0xFF;
    const rel16 = (n) => {
      const d = ((labels[n] === undefined ? here() + 3 : labels[n]) - (here() + 3)) & 0xFFFF;
      return [d & 0xFF, d >> 8];
    };
    build({ w, here, label, rel8, rel16, at: (n) => labels[n] });
    out = Buffer.from(b);
  }
  return out;
}

// The seven-word snapshot, each store separated by a `nop`.
//
// The nops are load-bearing and not padding. A `nop` classifies as an
// unsupported op and therefore ENDS a run, which keeps the snapshot's own
// seven perfectly foldable stores from forming a fold of their own -- without
// them the three negative cases fold their snapshot and the test asserts
// nothing. The one before the first store is the same guard against the case
// body's tail joining it.
function snapshot(w) {
  const st = (bytes) => { w(0x90); w(...bytes); };
  w(0x90);
  st([0xA3, SNAP & 0xFF, SNAP >> 8]);                   // mov [SNAP+0],ax
  st([0x89, 0x1E, (SNAP + 2) & 0xFF, (SNAP + 2) >> 8]); // mov [SNAP+2],bx
  st([0x89, 0x0E, (SNAP + 4) & 0xFF, (SNAP + 4) >> 8]); // mov [SNAP+4],cx
  st([0x89, 0x16, (SNAP + 6) & 0xFF, (SNAP + 6) >> 8]); // mov [SNAP+6],dx
  st([0x89, 0x36, (SNAP + 8) & 0xFF, (SNAP + 8) >> 8]); // mov [SNAP+8],si
  st([0x89, 0x3E, (SNAP + 10) & 0xFF, (SNAP + 10) >> 8]); // mov [SNAP+10],di
  // ...and the flags the terminator's own compare left behind, masked to the
  // six arithmetic bits (CF PF AF ZF SF OF). The rest of the word is IF/DF and
  // the reserved bits, which say nothing about the arithmetic.
  w(0x90, 0x9C, 0x58, 0x25, 0xD5, 0x08);                // nop / pushf / pop ax / and ax,08D5h
  w(0x90); w(0xA3, (SNAP + 12) & 0xFF, (SNAP + 12) >> 8);
}

// Print the seven words as hex, then exit. `phex` prints BX and returns.
function printAndExit(a) {
  const { w, label, rel8, rel16 } = a;
  w(0xBE, SNAP & 0xFF, SNAP >> 8);       // mov si,SNAP
  w(0xB9, 0x07, 0x00);                   // mov cx,7
  label('L1');
  w(0x51);                               // push cx
  w(0xAD);                               // lodsw
  w(0x89, 0xC3);                         // mov bx,ax
  w(0xE8, ...rel16('phex'));             // call phex
  w(0x59);                               // pop cx
  w(0xE2, rel8('L1'));                   // loop L1
  w(0xB8, 0x00, 0x4C, 0xCD, 0x21);       // mov ax,4C00h / int 21h
  label('phex');
  w(0xB9, 0x04, 0x00);                   // mov cx,4
  label('L2');
  w(0xC1, 0xC3, 0x04);                   // rol bx,4
  w(0x88, 0xD8);                         // mov al,bl
  w(0x24, 0x0F);                         // and al,0Fh
  w(0x04, 0x30);                         // add al,'0'
  w(0x3C, 0x39);                         // cmp al,'9'
  w(0x76, 0x02);                         // jbe +2
  w(0x04, 0x07);                         // add al,7
  w(0x88, 0xC2);                         // mov dl,al
  w(0xB4, 0x02);                         // mov ah,2
  w(0xCD, 0x21);                         // int 21h
  w(0xE2, rel8('L2'));                   // loop L2
  w(0xC3);                               // ret
}

// One case: prologue, then `body` inside an outer loop counted in memory, then
// the snapshot and the print. The outer counter lives in memory rather than a
// register so no case has to give one up, and so that re-entering the body
// after an install exercises the FOLDED handler rather than only compiling it.
// `pre` is a straight-line run laid down BEFORE the loop, so it executes
// exactly once: the hotness gate's cold case, in the same program as its hot
// one. `iter` overrides the trip count, which the gate cases raise so the
// profile window has room to close while the program is still running.
function program(body, { tail = [], pre = null, iter = ITER } = {}) {
  return asm((a) => {
    const { w, label, rel8 } = a;
    if (pre) { pre(a); w(0x90); }
    w(0xC7, 0x06, COUNTER & 0xFF, COUNTER >> 8, iter & 0xFF, iter >> 8);
    // ...and a `nop` after it, for the same reason as the ones in `snapshot`.
    // `mov word [mem],imm16` is itself a foldable store, and the first trip
    // through the loop falls into the body from here -- so without this it
    // joins the body's first three ops and folds `alias` at exactly four.
    w(0x90);
    label('outer');
    body(a);
    w(0x90);                                                   // nop: end the run
    w(0xFF, 0x0E, COUNTER & 0xFF, COUNTER >> 8);               // dec word [COUNTER]
    w(0x75, rel8('outer'));                                    // jnz outer
    snapshot(w);
    printAndExit(a);
    for (const t of tail) w(...t);
  });
}

// Pad to `off` and lay bytes there.
function withData(buf, off, bytes) {
  const b = Buffer.alloc(Math.max(buf.length, off - 0x100 + bytes.length), 0);
  buf.copy(b);
  Buffer.from(bytes).copy(b, off - 0x100);
  return b;
}

const CASES = {
  // Twelve consecutive full-width ops: mov/shl/add/xor/sub/lea/not/neg, every
  // one in the census's fold set, no memory at all. The simplest thing the
  // fold can possibly be asked to do.
  dot: {
    folds: true,
    body: ({ w }) => {
      w(0xB8, 0x34, 0x12);       // mov ax,1234h
      w(0xBB, 0x78, 0x56);       // mov bx,5678h
      w(0x89, 0xC1);             // mov cx,ax
      w(0xC1, 0xE1, 0x03);       // shl cx,3
      w(0x01, 0xD9);             // add cx,bx
      w(0x31, 0xC1);             // xor cx,ax
      w(0x89, 0xCA);             // mov dx,cx
      w(0x29, 0xDA);             // sub dx,bx
      w(0x8D, 0x77, 0x09);       // lea si,[bx+9]
      w(0x89, 0xF7);             // mov di,si
      w(0xF7, 0xD7);             // not di
      w(0xF7, 0xDE);             // neg si
    },
  },
  // A `loop`-terminated body walking a pointer through a table: the fold's
  // real target, with memory reads inside the run. Loads only, so the alias
  // rule never fires and the whole body is one run.
  addrloop: {
    folds: true,
    data: [TABLE, Array.from({ length: 64 }, (_, i) => i)],
    body: ({ w, label, rel8 }) => {
      w(0xBE, TABLE & 0xFF, TABLE >> 8);   // mov si,TABLE
      w(0x31, 0xDB);                       // xor bx,bx
      w(0xB9, 0x08, 0x00);                 // mov cx,8
      label('inner');
      w(0x8B, 0x04);                       // mov ax,[si]
      w(0x01, 0xC3);                       // add bx,ax
      w(0x8D, 0x74, 0x02);                 // lea si,[si+2]
      w(0x89, 0xDA);                       // mov dx,bx
      w(0xD1, 0xE2);                       // shl dx,1
      w(0x31, 0xD3);                       // xor bx,dx
      w(0xE2, rel8('inner'));              // loop inner
    },
  },
  // The other loop shape: an explicit induction variable and a compare. `inc`
  // is in the fold set, so the run reaches all the way to the `cmp` that the
  // branch reads -- which is exactly the case where a fold has to get the
  // flags right, because the terminator's compare is the FIRST thing after it.
  incloop: {
    folds: true,
    body: ({ w, label, rel8 }) => {
      w(0x31, 0xDB);             // xor bx,bx
      w(0x31, 0xF6);             // xor si,si
      label('inner');
      w(0x89, 0xF0);             // mov ax,si
      w(0xC1, 0xE0, 0x02);       // shl ax,2
      w(0x01, 0xC3);             // add bx,ax
      w(0x31, 0xF3);             // xor bx,si
      w(0x89, 0xDA);             // mov dx,bx
      w(0x46);                   // inc si
      w(0x81, 0xFE, 0x10, 0x00); // cmp si,16
      w(0x75, rel8('inner'));    // jne inner
    },
  },
  // AL and AH are subfields of AX in the register file, so an 8-bit write in
  // the middle of a 16-bit run is an overlap the fold does not model. It splits
  // here into runs of 1 and 2, and nothing folds.
  partial: {
    folds: false,
    body: ({ w }) => {
      w(0xB8, 0x34, 0x12);       // mov ax,1234h
      w(0xB3, 0xAA);             // mov bl,0AAh     <- partial-reg
      w(0x04, 0x03);             // add al,3        <- partial-reg
      w(0x89, 0xC1);             // mov cx,ax
      w(0x31, 0xD9);             // xor cx,bx
    },
  },
  // A load after a store, with no proof they miss each other. The fold keeps
  // memory in source order but will not reorder a load across a store, so the
  // run ends at the load: 3 ops either side and neither reaches four.
  alias: {
    folds: false,
    body: ({ w }) => {
      w(0xB8, 0x34, 0x12);                 // mov ax,1234h
      w(0xBB, 0x78, 0x56);                 // mov bx,5678h
      w(0xA3, 0x00, 0x04);                 // mov [0400h],ax   <- store
      w(0x8B, 0x0E, 0x02, 0x04);           // mov cx,[0402h]   <- possibly aliasing load
      w(0x89, 0xCA);                       // mov dx,cx
      w(0x31, 0xC2);                       // xor dx,ax
    },
  },
  // `adc` READS the carry the previous op left, which is the one thing a lazy
  // flag scheme cannot defer past. Nothing inside a fold may consume flags
  // except the terminator itself.
  flagcons: {
    folds: false,
    body: ({ w }) => {
      w(0xB8, 0x34, 0x12);       // mov ax,1234h
      w(0xBB, 0x78, 0x56);       // mov bx,5678h
      w(0x89, 0xC1);             // mov cx,ax
      w(0x11, 0xD9);             // adc cx,bx       <- reads CF
      w(0x89, 0xCA);             // mov dx,cx
      w(0x31, 0xC2);             // xor dx,ax
      w(0x01, 0xDA);             // add dx,bx
    },
  },
};

function run(com, extra) {
  const args = [path.join(__dirname, '..', 'tools', 'toyvm', 'run-dos.js'), com,
    '--dispatches=8000000', '--text',
    // A small slice on purpose. `pump` installs BETWEEN slices, so a program
    // that runs its whole loop inside one slice never gets an install at all
    // and the folded arm would be the unfolded arm with extra bookkeeping.
    '--slice=20000', ...extra];
  return execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 1 << 24 });
}

const screen = (log) => (log.match(/^  \|(.*)$/gm) || []).map((s) => s.slice(3).trim()).join('');
const folds = (log) => +(/, (\d+) tree folds/.exec(log) || [0, 0])[1];
const trees = (log) => +(/tree fold: (\d+) handler/.exec(log) || [0, 0])[1];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyvm-tree-fold-'));
const summary = [];
for (const [name, c] of Object.entries(CASES)) {
  const com = path.join(dir, `${name.toUpperCase()}.COM`);
  let buf = program(c.body);
  if (c.data) buf = withData(buf, c.data[0], c.data[1]);
  fs.writeFileSync(com, buf);

  const off = run(com, []);
  // `--tree-fold-batch=1` installs the first tree the moment one is wanted.
  // The production default batches (a module build per tree costs more than
  // the fold saves -- see docs/toyvm-tree-fold.md), but a test wants the
  // install to have happened by the time the program ends.
  const on = run(com, ['--tree-fold', '--tree-fold-batch=1']);

  assert.ok(/exited=true/.test(off), `${name}: the plain arm did not exit:\n${off}`);
  assert.ok(/exited=true/.test(on), `${name}: the folded arm did not exit:\n${on}`);
  const a = screen(off), b = screen(on);
  assert.ok(a.length === 28, `${name}: expected seven words, got "${a}"`);
  assert.strictEqual(b, a,
    `${name}: the fold computed something else\n  plain  ${a}\n  folded ${b}`);

  const n = folds(on);
  if (c.folds) {
    assert.ok(n > 0, `${name}: nothing folded, but this shape must fold:\n${on}`);
    assert.ok(trees(on) > 0, `${name}: ${n} substitution(s) but no handler generated:\n${on}`);
  } else {
    assert.strictEqual(n, 0,
      `${name}: folded ${n} run(s), but this shape must not fold at all:\n${on}`);
  }
  // ...and the fold must never fire with the flag off, whatever else changes.
  assert.strictEqual(folds(off), 0, `${name}: the plain arm folded ${folds(off)} run(s)`);

  summary.push(`${name} ${a} ${c.folds ? `${n} fold(s)/${trees(on)} tree(s)` : 'no fold'}`);
}
// --- the hotness gate ------------------------------------------------------
//
// `--tree-fold-hot=N` compiles a run only after the arena word it starts at has
// been dispatched N times, so a block the program enters once never costs a
// handler. One program answers all three questions the gate has to answer,
// because it contains BOTH shapes:
//
//   pre    five straight-line ops before the loop -- entered exactly ONCE
//   body   the `dot` run inside a 60,000-trip loop -- entered 60,000 times
//
// and it is run at three settings:
//
//   hot=64      the loop is folded, the once-only run is refused as cold
//   hot=50000   NOTHING is folded: at the window's close the loop has been
//               entered ~20,000 times, which is under the bar. This is the
//               case that separates a gate from a delay -- a fold that merely
//               waited would still fire here, eventually.
//   plain       the baseline the other two must reproduce exactly
//
// The window is closed at 300,000 dispatches (`--tree-fold-warm`) while the
// program has ~600,000 still to run, so the third question -- is the picture
// the same on either side of the install -- is asked of a program that spends
// most of its life AFTER the swap. The printed snapshot is seven words of
// registers and flags, and it has to be identical in all three.
const GATE_ITER = 60000;
const GATE_WARM = 300000;
const GATE_COM = path.join(dir, 'GATE.COM');
fs.writeFileSync(GATE_COM, program(CASES.dot.body, {
  iter: GATE_ITER,
  // Five foldable full-width ops, run once. Long enough to be a candidate --
  // under four it would be declined as `too short` and would never reach the
  // gate at all, which would make this case prove nothing.
  pre: ({ w }) => {
    w(0xB8, 0x11, 0x11);       // mov ax,1111h
    w(0xBB, 0x22, 0x22);       // mov bx,2222h
    w(0x01, 0xD8);             // add ax,bx
    w(0xC1, 0xE0, 0x02);       // shl ax,2
    w(0x31, 0xD8);             // xor ax,bx
  },
}));

const gatePlain = run(GATE_COM, []);
// `--tree-fold-batch=1` for the same reason the six cases above pass it: the
// SECOND install -- the one that carries the trees the hot blocks recompiled
// into -- otherwise waits for a batch to fill or for the batch to stop growing,
// and this program only takes about forty-five slices in total. On the corpus
// that wait is a hundred handbacks out of thousands; here it is longer than the
// program.
const gateHot = run(GATE_COM,
  ['--tree-fold', '--tree-fold-hot=64', `--tree-fold-warm=${GATE_WARM}`, '--tree-fold-batch=1']);
const gateCold = run(GATE_COM,
  ['--tree-fold', '--tree-fold-hot=50000', `--tree-fold-warm=${GATE_WARM}`, '--tree-fold-batch=1']);

for (const [n, log] of [['plain', gatePlain], ['hot=64', gateHot], ['hot=50000', gateCold]]) {
  assert.ok(/exited=true/.test(log), `gate ${n}: did not exit:\n${log}`);
}
const gateBar = (log) => +(/(\d+) hot block\(s\)/.exec(log) || [0, -1])[1];
const gateCounts = (log) => ({
  hot: gateBar(log),
  folds: folds(log),
  trees: trees(log),
  cold: +(/(\d+) cold,/.exec(log) || [0, -1])[1],
});

// 1. A COLD BLOCK NEVER FOLDS. At hot=64 the loop is over the bar and the
//    once-only run is not, so the gate has to report at least one refusal --
//    a gate that promoted everything would fold and pass every other check
//    here while being no gate at all.
const g64 = gateCounts(gateHot);
assert.ok(g64.folds > 0, `gate hot=64: nothing folded:\n${gateHot}`);
assert.ok(g64.trees > 0, `gate hot=64: folded but generated no handler:\n${gateHot}`);
assert.ok(g64.cold > 0, `gate hot=64: no candidate was refused as cold, so the `
  + `once-per-run block was folded too:\n${gateHot}`);

// 2. A BLOCK FOLDS ONLY AFTER N ENTRIES. Same program, same window, a bar the
//    loop has not cleared by the time the window closes: nothing at all.
const gHi = gateCounts(gateCold);
assert.strictEqual(gHi.folds, 0,
  `gate hot=50000: folded ${gHi.folds} run(s) below the threshold:\n${gateCold}`);
assert.strictEqual(gHi.hot, 0,
  `gate hot=50000: promoted ${gHi.hot} block(s) below the threshold:\n${gateCold}`);

// 3. THE INSTALL IS INVISIBLE. Most of this program runs after the swap, and
//    all three arms have to print the same seven words.
const gp = screen(gatePlain);
assert.ok(gp.length === 28, `gate: expected seven words, got "${gp}"`);
assert.strictEqual(screen(gateHot), gp,
  `gate hot=64: the fold computed something else\n  plain  ${gp}\n  folded ${screen(gateHot)}`);
assert.strictEqual(screen(gateCold), gp,
  `gate hot=50000: the gated arm computed something else\n  plain  ${gp}\n  gated  ${screen(gateCold)}`);

// ...and the dispatch clock with it. The fold charges the dispatches it
// removes and the arena keeps its shape, so a gated run retires exactly the
// dispatches a plain one does -- the install is a host-side event and must not
// show up on the guest's clock.
const disp = (log) => +(/([\d.]+)M dispatches/.exec(log) || [0, -1])[1];
assert.strictEqual(disp(gateHot), disp(gatePlain),
  `gate hot=64: ${disp(gateHot)}M dispatches against ${disp(gatePlain)}M plain:\n${gateHot}`);

summary.push(`gate ${gp} hot=64:${g64.folds} fold(s)/${g64.trees} tree(s)/${g64.cold} cold, `
  + `hot=50000: no fold`);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`PASS test-toyvm-tree-fold: ${summary.join('; ')}`);
