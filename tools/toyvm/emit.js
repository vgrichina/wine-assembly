'use strict';

// Emit the toy VM as WAT, once per dispatch variant.
//
// One shared set of handler bodies, six different ways of getting from the end
// of one handler to the start of the next. That is the whole experiment: if the
// bodies are byte-identical and only the dispatch shell differs, any timing gap
// belongs to the shell.
//
//   tailcall      return_call_indirect              <- what we ship today
//   calls         call_indirect, handlers return    <- classic subroutine threading
//   switch        one giant br_table in one function
//   repl_switch   br_table duplicated at the end of every arm
//   repl_tailcall dispatch tail inlined into every handler
//   typed         typed function table, drops the signature check
//
// The two "repl_" variants are the open lever from docs/performance-summary.md:
// today all handlers funnel through ONE return_call_indirect, so one branch site
// shares its predictor entries across every handler and cannot learn that
// cmp is usually followed by jcc. Replication gives each its own history. The
// recorded negative result on dispatch did NOT cover this -- that experiment
// changed what $next did, not how many sites there were.
//
// Handler bodies live in this file as pure fragments: they read operands from
// $ip, advance it, use only locals $t0..$t7, and never dispatch.

const isa = require('./isa');

// ---------------------------------------------------------------------------
// Handler table. Order IS the handler index -- the decoder emits these numbers.
// `args` counts operand words following the handler index in the stream.
// ---------------------------------------------------------------------------
const HANDLERS = [];

// Lazy flags are on. This is the A/B switch for them, and it is a GENERATION-time
// variable rather than a runtime one: the whole point of the change is that a
// compare stores its inputs instead of computing six bits, so the two arms have
// to be different handler bodies. buildHandlers() below rebuilds the table under
// the other setting, which is what lets bench-dos.js interleave the two arms in
// ONE process -- the alternative, a worktree per arm, measures this box's load.
let LAZY = true;
// CF as an INPUT (ADC/SBB, and the eager helpers' saved carry for INC/DEC).
const CF_IN = () => (LAZY ? '(call $get_cf)' : '(i32.and (global.get $flags) (i32.const 1))');

function h(name, args, body) {
  HANDLERS.push({ name, args, index: HANDLERS.length, body });
  return HANDLERS.length - 1;
}

// Read the next `n` operand words into $t0.. and step $ip past them.
function ops(n) {
  let s = '';
  for (let i = 0; i < n; i++) {
    s += `(local.set $t${i} (i32.load offset=${i * 4} (global.get $ip)))\n`;
  }
  s += `(global.set $ip (i32.add (global.get $ip) (i32.const ${n * 4})))\n`;
  return s;
}

// End of a decoded run. Carries the guest IP the instruction stream ended at,
// which is where the production interpreter also writes eip: at a block end,
// not once per instruction.
function genTerminators() {
  h('end', 1, `
  ${ops(1)}
  (global.set $gip (local.get $t0))
  (global.set $left (global.get $steps)) (global.set $halt (i32.const 1))
`);

// The same, for a block that just patched its own code. A write through a CS
// override is a program editing the instruction stream it is standing in --
// Turbo Pascal's Intr() writes the interrupt number into the `int` two
// instructions ahead of the store, and every TP program in the corpus reaches
// the BIOS through it. Decoding straight past the store bakes whatever byte
// was there at DECODE time into the trace, so a program that patched in $10
// executes the $00 the image shipped with, and Turbo Pascal's INT 0 handler
// turns that into "Runtime error 200" a long way from anything to do with
// arithmetic. Ending the block here is only half the fix: $smc tells the host
// to drop the block the store landed in, which is the one holding the byte.
// Only claim the store patched code if the store itself did not already say
// so. $wr8 sets $smc=2 when the address it wrote lands in a paragraph some
// region decoded, which is the authoritative answer; overwriting it with 1
// threw away the one bit that separates a real self-patch from a program
// keeping a table in its code segment. The block still ends either way -- the
// cut is what makes Turbo Pascal's Intr() work -- but the host can now tell
// which kind it was and retire the rule where it is doing nothing.
  h('end_smc', 1, `
  ${ops(1)}
  (if (i32.eqz (global.get $smc)) (then (global.set $smc (i32.const 1))))
  (global.set $gip (local.get $t0))
  (global.set $left (global.get $steps)) (global.set $halt (i32.const 1))
`);
}

// --- ALU + MOV families, generated -----------------------------------------
// x86 encodes six of the ALU ops at 8*code + form, and every one shares the
// same operand plumbing -- only the arithmetic and the flag rule differ.
// Generating them keeps that shape identical across handlers on purpose: once
// we start timing, drift between two hand-written handlers is indistinguishable
// from a dispatch effect.
//
// Forms, and the operand words each consumes:
//   rr  [dst | src<<4]                 register, register
//   mr  [eaKind|seg<<4|reg<<8][disp]   memory destination, register source
//   rm  [eaKind|seg<<4|reg<<8][disp]   register destination, memory source
//   ri  [reg][imm]                     register destination, immediate
//   mi  [eaKind|seg<<4|reg<<8][disp][imm]
// `carry` folds CF into the result. ADC/SBB need no special flag rule: with
// s = a+b+cf the carry out still lands above bit w-1, and the AF and OF
// formulas are written on (a, b, r) and stay correct.
// Which deferred rule $fop names. 0 is "nothing pending, the $flags word is
// authoritative" -- the state every non-arithmetic path leaves behind.
const FOP = {
  NONE: 0, ADD: 1, SUB: 2, LOGIC: 3, ADD32: 4, SUB32: 5,
  INC: 6, DEC: 7, INC32: 8, DEC32: 9,
};
const ALU = {
  add: { code: 0, flags: 'add', write: true, op: 'i32.add' },
  or: { code: 1, flags: 'logic', write: true, op: 'i32.or' },
  adc: { code: 2, flags: 'add', write: true, op: 'i32.add', carry: '+' },
  sbb: { code: 3, flags: 'sub', write: true, op: 'i32.sub', carry: '-' },
  and: { code: 4, flags: 'logic', write: true, op: 'i32.and' },
  sub: { code: 5, flags: 'sub', write: true, op: 'i32.sub' },
  xor: { code: 6, flags: 'logic', write: true, op: 'i32.xor' },
  cmp: { code: 7, flags: 'sub', write: false, op: 'i32.sub' },
  // TEST is AND without the write-back. It is not part of the 8*code+form
  // layout -- the decoder reaches it from 84/85, A8/A9 and F6/F7 /0.
  test: { code: null, flags: 'logic', write: false, op: 'i32.and' },
};

// Operand-width helpers shared by every generator. At width 32 the mask is the
// identity and the arithmetic flags go to the *32 helpers, which take a
// carry-in and a truncated result rather than an oversized one.
const WM = (w) => ({ 8: '0xFF', 16: '0xFFFF', 32: '-1' })[w];
// $rec_NAME and $flags_NAME take the same parameters in the same order, on
// purpose: the recorder is exactly the eager helper with the computation
// removed, so switching arms is a prefix substitution and cannot silently
// reorder an argument.
const FL = (name) => `$${LAZY ? 'rec' : 'flags'}_${name}`;
const ADD_FLAGS = (w, a, b, s) => (w === 32
  ? `(call ${FL('add32')} ${a} ${b} (i32.const 0) ${s})`
  : `(call ${FL('add')} ${a} ${b} ${s} (i32.const ${w}))`);
const SUB_FLAGS = (w, a, b, s) => (w === 32
  ? `(call ${FL('sub32')} ${a} ${b} (i32.const 0) ${s})`
  : `(call ${FL('sub')} ${a} ${b} ${s} (i32.const ${w}))`);
const INC_FLAGS = (w, a, s) => (w === 32
  ? `(call ${FL('inc32')} ${a} ${s})` : `(call ${FL('inc')} ${a} ${s} (i32.const ${w}))`);
const DEC_FLAGS = (w, a, s) => (w === 32
  ? `(call ${FL('dec32')} ${a} ${s})` : `(call ${FL('dec')} ${a} ${s} (i32.const ${w}))`);

const EA_SETUP_PRE = `
  (local.set $t4 (call $ea (local.get $t0) (local.get $t1)))
  (local.set $t5 (i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 7)))
  (local.set $t6 (i32.and (i32.shr_u (local.get $t0) (i32.const 8)) (i32.const 7)))
`;

function genAlu() {
  for (const [name, spec] of Object.entries(ALU)) {
    for (const w of [8, 16, 32]) {
      const mask = { 8: '0xFF', 16: '0xFFFF', 32: '-1' }[w];
      const rget = `$rget${w}`, rset = `$rset${w}`;
      const rd = `$rd${w}`, wr = `$wr${w}`;
      // Flag call, given the two inputs and the UNMASKED result. Logic ops take
      // only the masked result -- they define CF and OF as zero and leave AF
      // genuinely undefined on this part, which tools/toyvm/gate.js masks and
      // reports rather than silently ignoring.
      // ADC/SBB fold CF into the result; everything else is the bare op.
      const combine = (a, b) => spec.carry
        ? `(${spec.op} (${spec.op} ${a} ${b}) ${CF_IN()})`
        : `(${spec.op} ${a} ${b})`;
      // At width 32 the arithmetic flags go to the dedicated helpers, which take
      // the carry-in and the truncated result instead of an oversized sum.
      const flags = (a, b, s) => (spec.flags === 'logic'
        ? `(call ${FL('logic')} (i32.and ${s} (i32.const ${mask})) (i32.const ${w}))`
        : (w === 32
          ? `(call ${FL(`${spec.flags}32`)} ${a} ${b} ${spec.carry ? CF_IN() : '(i32.const 0)'} ${s})`
          : `(call ${FL(spec.flags)} ${a} ${b} ${s} (i32.const ${w}))`));

      h(`${name}_rr${w}`, 1, `
  ${ops(1)}
  (local.set $t1 (call ${rget} (i32.and (local.get $t0) (i32.const 7))))
  (local.set $t2 (call ${rget} (i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 7))))
  (local.set $t3 ${combine('(local.get $t1)', '(local.get $t2)')})
  ${spec.write ? `(call ${rset} (i32.and (local.get $t0) (i32.const 7)) (i32.and (local.get $t3) (i32.const ${mask})))` : ''}
  ${flags('(local.get $t1)', '(local.get $t2)', '(local.get $t3)')}
`);

      h(`${name}_mr${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (local.set $t2 (call ${rd} (local.get $t5) (local.get $t4)))
  (local.set $t3 (call ${rget} (local.get $t6)))
  (local.set $t7 ${combine('(local.get $t2)', '(local.get $t3)')})
  ${spec.write ? `(call ${wr} (local.get $t5) (local.get $t4) (i32.and (local.get $t7) (i32.const ${mask})))` : ''}
  ${flags('(local.get $t2)', '(local.get $t3)', '(local.get $t7)')}
`);

      h(`${name}_rm${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (local.set $t2 (call ${rget} (local.get $t6)))
  (local.set $t3 (call ${rd} (local.get $t5) (local.get $t4)))
  (local.set $t7 ${combine('(local.get $t2)', '(local.get $t3)')})
  ${spec.write ? `(call ${rset} (local.get $t6) (i32.and (local.get $t7) (i32.const ${mask})))` : ''}
  ${flags('(local.get $t2)', '(local.get $t3)', '(local.get $t7)')}
`);

      h(`${name}_ri${w}`, 2, `
  ${ops(2)}
  (local.set $t2 (call ${rget} (local.get $t0)))
  (local.set $t3 ${combine('(local.get $t2)', '(local.get $t1)')})
  ${spec.write ? `(call ${rset} (local.get $t0) (i32.and (local.get $t3) (i32.const ${mask})))` : ''}
  ${flags('(local.get $t2)', '(local.get $t1)', '(local.get $t3)')}
`);

      h(`${name}_mi${w}`, 3, `
  ${ops(3)}
  ${EA_SETUP_PRE}
  (local.set $t3 (call ${rd} (local.get $t5) (local.get $t4)))
  (local.set $t7 ${combine('(local.get $t3)', '(local.get $t2)')})
  ${spec.write ? `(call ${wr} (local.get $t5) (local.get $t4) (i32.and (local.get $t7) (i32.const ${mask})))` : ''}
  ${flags('(local.get $t3)', '(local.get $t2)', '(local.get $t7)')}
`);
    }
  }
}

// MOV is the same five forms with no arithmetic and no flags at all. It gets
// its own generator rather than an ALU entry with a null flag rule, because a
// handler that writes no flags is exactly the shape a lazy-flag design is
// supposed to profit from, and it must not accidentally inherit a flag call.
function genMov() {
  for (const w of [8, 16, 32]) {
    const rget = `$rget${w}`, rset = `$rset${w}`, rd = `$rd${w}`, wr = `$wr${w}`;
    h(`mov_rr${w}`, 1, `
  ${ops(1)}
  (call ${rset} (i32.and (local.get $t0) (i32.const 7))
                (call ${rget} (i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 7))))
`);
    h(`mov_mr${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call ${wr} (local.get $t5) (local.get $t4) (call ${rget} (local.get $t6)))
`);
    h(`mov_rm${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call ${rset} (local.get $t6) (call ${rd} (local.get $t5) (local.get $t4)))
`);
    h(`mov_ri${w}`, 2, `
  ${ops(2)}
  (call ${rset} (local.get $t0) (local.get $t1))
`);
    h(`mov_mi${w}`, 3, `
  ${ops(3)}
  ${EA_SETUP_PRE}
  (call ${wr} (local.get $t5) (local.get $t4) (local.get $t2))
`);
  }
}

// --- Control flow -----------------------------------------------------------
// Branch operands carry BOTH an arena address and a guest IP, for each of the
// taken and not-taken paths:
//
//   [arenaTaken][guestTaken][arenaFall][guestFall]
//
// An arena address of 0 means "this successor is not compiled" and the handler
// hands control back to the host after writing the guest IP. That single
// convention makes one handler serve two very different callers: the gate,
// which compiles exactly one instruction and always gets 0, and the block
// compiler, which resolves both successors and keeps the whole loop running
// inside wasm. Without the second case there is nothing to time -- a host call
// per instruction swamps dispatch entirely.
const F = isa.F;

// Which FLAGS bits are always set, and which the guest may write. They are
// globals rather than constants because they are the ONE thing that differs
// between the 8086 the conformance corpus was recorded on and the 386 the
// demos assume, and the handler bodies are generated once at load time.
//
// On an 8086 bits 12-15 read 1 always. On a 386 in real mode IOPL (12-13) and
// NT (14) are writable and bit 15 reads 0 -- which is exactly what every
// CPU-detection routine of the era tests, by clearing them and reading back.
// RACE.EXE prints "386 or better not detected!!!" against the 8086 word.
//
// They have to be used EVERYWHERE, not just in POPF and IRET: each flag helper
// preserves the bits it does not compute and then ORs the always-set ones back
// in, so an 0xF002 there forces bits 12-15 on after every arithmetic
// instruction and undoes the detection two instructions later.
const RESERVED = '(global.get $f_res)';
const DEFINED = '(global.get $f_def)';

// Reading one flag. With lazy flags this is a call into the getter for that
// bit rather than a shift out of the word, because the word may not hold the
// answer yet -- see the $fop block in helpers(). Every condition, every SETcc
// and INTO's overflow test go through here, so this one line is the whole
// consumer side of the change.
const GETTER = {
  [F.CF]: '$get_cf', [F.PF]: '$get_pf', [F.AF]: '$get_af',
  [F.ZF]: '$get_zf', [F.SF]: '$get_sf', [F.OF]: '$get_of',
};
const bit = (b) => {
  if (LAZY && GETTER[b]) return `(call ${GETTER[b]})`;
  if (!LAZY) {
    return `(i32.and (i32.shr_u (global.get $flags) (i32.const ${b})) (i32.const 1))`;
  }
  // Everything outside FLAGS_ARITH -- DF for the string ops, IF, TF -- is never
  // deferred and is always authoritative in the word, so it is read directly.
  // Asserting rather than assuming: a new arithmetic flag reaching here would
  // read a stale bit, silently and only sometimes.
  if (isa.FLAGS_ARITH & (1 << b)) throw new Error(`no lazy getter for flag bit ${b}`);
  return `(i32.and (i32.shr_u (global.get $flags) (i32.const ${b})) (i32.const 1))`;
};
// Built by a function, not frozen at require time: every other bit() call in
// this file sits inside a gen* function and is re-evaluated when buildHandlers()
// switches the flag scheme, and a top-level object here would keep the FIRST
// scheme's condition tests. That is not a crash -- it is an eager-arm build
// whose Jcc still calls the lazy getters, which quietly measures neither arm.
const makeConds = () => ({
  o: bit(F.OF),
  no: `(i32.eqz ${bit(F.OF)})`,
  b: bit(F.CF),
  ae: `(i32.eqz ${bit(F.CF)})`,
  z: bit(F.ZF),
  nz: `(i32.eqz ${bit(F.ZF)})`,
  be: `(i32.or ${bit(F.CF)} ${bit(F.ZF)})`,
  a: `(i32.eqz (i32.or ${bit(F.CF)} ${bit(F.ZF)}))`,
  s: bit(F.SF),
  ns: `(i32.eqz ${bit(F.SF)})`,
  p: bit(F.PF),
  np: `(i32.eqz ${bit(F.PF)})`,
  l: `(i32.ne ${bit(F.SF)} ${bit(F.OF)})`,
  ge: `(i32.eq ${bit(F.SF)} ${bit(F.OF)})`,
  le: `(i32.or ${bit(F.ZF)} (i32.ne ${bit(F.SF)} ${bit(F.OF)}))`,
  g: `(i32.eqz (i32.or ${bit(F.ZF)} (i32.ne ${bit(F.SF)} ${bit(F.OF)})))`,
});
let CONDS = makeConds();

// Shared tail: commit one successor. $arena is the arena address (0 = stop),
// $guest is the guest IP to record either way.
// A store that landed in a paragraph some compiled region decoded sets $smc=2,
// and every arena address in flight is now suspect -- including the successor
// this block is about to jump into. The flag cannot cut the block it fires in
// (a handback mid-instruction resumes at the last block head, which would redo
// the store), so the cut happens here instead, at the first block boundary
// after it: $gip is already the guest address to resume at, so refusing the
// arena successor is a correct and cheap handback. Without it a depacker that
// falls straight through into the code it just wrote keeps running the bytes
// that were there at decode time -- COROMER's second stage did exactly that and
// ended up executing the interrupt vector table.
// The step budget is spent here too, for the same reason and with the same
// argument. A slice that simply stopped where the counter ran out stopped in
// the MIDDLE of a block -- and $gip is only written at block boundaries, so the
// host resumed at the block head and the guest re-ran everything the block had
// already done. Harmless for arithmetic, fatal for a depacker: CARRIE.EXE's
// unpacking loop re-copied its prefix once per expired slice and jumped into
// the wreckage, which looked exactly like a decoder bug and got worse the
// smaller the slice (64000 lit pixels at a 2M slice, 15300 at 500k, none at
// 200k). So the budget is checked where a boundary already exists: the counter
// runs to zero, the block finishes, and the handback happens on its way out.
// The overrun is bounded by one block.
const CONT = (arena) => `(select (i32.const 0) ${arena}
    (i32.or (global.get $smc) (i32.lt_s (global.get $steps) (i32.const 0))))`;
const GO = (arena, guest) => `
  (global.set $gip ${guest})
  (if ${CONT(arena)}
    (then (global.set $ip ${arena}))
    (else (global.set $left (global.get $steps)) (global.set $halt (i32.const 1))))`;

function genBranches() {
  for (const [cc, expr] of Object.entries(CONDS)) {
    h(`j${cc}`, 4, `
  ${ops(4)}
  (if ${expr}
    (then ${GO('(local.get $t0)', '(local.get $t1)')})
    (else ${GO('(local.get $t2)', '(local.get $t3)')}))
`);
  }

  // Unconditional jump: one successor, so two operands.
  h('jmp', 2, `
  ${ops(2)}
  ${GO('(local.get $t0)', '(local.get $t1)')}
`);

  // LOOP decrements CX and branches on non-zero WITHOUT touching flags. It is
  // the shape every counted loop in real 16-bit code ends with, which is why
  // it is here rather than left to dec+jnz.
  h('loop', 4, `
  ${ops(4)}
  (if (call $cxdec)
    (then ${GO('(local.get $t0)', '(local.get $t1)')})
    (else ${GO('(local.get $t2)', '(local.get $t3)')}))
`);
  h('loop32', 4, `
  ${ops(4)}
  (if (call $ecxdec)
    (then ${GO('(local.get $t0)', '(local.get $t1)')})
    (else ${GO('(local.get $t2)', '(local.get $t3)')}))
`);
}

// INC/DEC are generated for both widths and both operand kinds inside
// genExtras(), since they are the one arithmetic pair that must NOT write CF
// and it would be easy to end up with two definitions that disagree.

// --- Stack, call/ret, unary group, flag ops, INT ----------------------------
function genExtras() {
  // Stack. SS is segment index 2.
  h('push_r16', 1, `
  ${ops(1)}
  (call $push16 (call $rget16 (local.get $t0)))
`);
  h('pop_r16', 1, `
  ${ops(1)}
  (call $rset16 (local.get $t0) (call $pop16))
`);
  h('push_seg', 1, `
  ${ops(1)}
  (call $push16 (call $sget (local.get $t0)))
`);
  h('pop_seg', 1, `
  ${ops(1)}
  (call $sset (local.get $t0) (call $pop16))
`);
  // The 32-bit forms. A segment register is 16 bits either way; the operand
  // size decides how far the STACK moves, and that is the whole difference.
  // Every DOS extender here reflects interrupts with `66 1f` (pop ds) after
  // restoring a 32-bit frame, so emitting the 16-bit handler for it left the
  // stack two bytes low on every reflected call. CONTAGIO.EXE's extender drifted
  // its way into a `ret` that read the wrong word and jumped into its own error
  // strings, where it sat spinning at 868:13d inside "Unrecognized Data In LE!".
  h('push_seg32', 1, `
  ${ops(1)}
  (call $push32 (call $sget (local.get $t0)))
`);
  h('pop_seg32', 1, `
  ${ops(1)}
  (call $sset (local.get $t0) (i32.and (call $pop32) (i32.const 0xFFFF)))
`);
  h('push_m16', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $push16 (call $rd16 (local.get $t5) (local.get $t4)))
`);
  h('pop_m16', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $wr16 (local.get $t5) (local.get $t4) (call $pop16))
`);
  h('push_i16', 1, `
  ${ops(1)}
  (call $push16 (local.get $t0))
`);

  // The 32-bit stack forms. SP still moves within a 16-bit stack segment; only
  // the datum is four bytes wide.
  h('push_r32', 1, `
  ${ops(1)}
  (call $push32 (call $rget32 (local.get $t0)))
`);
  h('pop_r32', 1, `
  ${ops(1)}
  (call $rset32 (local.get $t0) (call $pop32))
`);
  h('push_m32', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $push32 (call $rd32 (local.get $t5) (local.get $t4)))
`);
  h('pop_m32', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $wr32 (local.get $t5) (local.get $t4) (call $pop32))
`);
  h('push_i32', 1, `
  ${ops(1)}
  (call $push32 (local.get $t0))
`);
  h('lea32', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $rset32 (local.get $t6) (local.get $t4))
`);
  // PUSH SP is its own handler because the 8086 pushes the ALREADY-DECREMENTED
  // SP, unlike the 80286 and everything after it, which push the original. The
  // corpus is recorded off real 8088 silicon and fails 1200/1200 on the modern
  // behaviour, which is how this got noticed.
  h('push_sp', 0, `
  (global.set $sp (i32.and (i32.sub (global.get $sp) (i32.const 2)) (i32.const 0xFFFF)))
  (call $wr16 (i32.const 2) (global.get $sp) (global.get $sp))
`);
  h('pushf', 0, `(call $push16 (call $flags_word))`);
  // POPF must both OR in the bits that always read 1 and MASK OFF the ones that
  // always read 0 (3 and 5). Only doing the first half leaves whatever the
  // pushed value had in those bits and fails three quarters of the corpus.
  // The operand is the address of the next instruction, and it is here for one
  // bit: TF. A POPF that raises the trap flag has to give the block back, or
  // the rest of the block runs at full speed and the guest never sees the INT 1
  // it just armed -- which is the whole of a DOS trace decryptor. Setting TF is
  // the only way in (nothing else writes it) and it happens a handful of times
  // in a run, so the cost is one compare on a POPF that leaves TF clear.
  h('popf', 1, `
  ${ops(1)}
  (call $flags_put (i32.or
    (i32.and (call $pop16) ${DEFINED})
    ${RESERVED}))
  (if (i32.and (global.get $flags) (i32.const ${1 << isa.F.TF}))
    (then (global.set $gip (local.get $t0))
          (global.set $left (global.get $steps)) (global.set $halt (i32.const 1))))
`);
  // PUSHFD / POPFD. Four bytes, not two, and getting that wrong is not a
  // wrong flags value -- it is a stack that is two bytes out from there on.
  // The reason every demo runs these is the rung of the CPU ladder that tells
  // a 386 from a 486: push EFLAGS, toggle AC (bit 18), pop it back, push again
  // and see whether the bit stuck. Decoded as their 16-bit twins, CTSLASSE.EXE
  // came out of that sequence with a misaligned stack, concluded it was on
  // something older than a 386, and took the exit.
  //
  // The upper half is zero on the way out and ignored on the way in: this
  // machine is a 386, so AC, VM and ID do not exist, and RF is never set.
  // VM lives outside $flags (see the global), so PUSHFD has to put it back or
  // a guest that saves and restores EFLAGS around anything loses the mode --
  // and a V86 monitor reading the frame cannot tell where the trap came from.
  h('pushf32', 0, `(call $push32 (i32.or (i32.and (call $flags_word) (i32.const 0xFFFF))
                                         (i32.shl (global.get $vm86) (i32.const 17))))`);
  h('popf32', 1, `
  ${ops(1)}
  (call $flags_put (i32.or
    (i32.and (i32.and (call $pop32) (i32.const 0xFFFF)) ${DEFINED})
    ${RESERVED}))
  (if (i32.and (global.get $flags) (i32.const ${1 << isa.F.TF}))
    (then (global.set $gip (local.get $t0))
          (global.set $left (global.get $steps)) (global.set $halt (i32.const 1))))
`);

  // CALL near, relative. Operands: [arenaTarget][guestTarget][retIp][arenaRet].
  // The fourth operand is the whole reason returns stay inside wasm: it is the
  // arena address the matching RET should resume at, recorded on the shadow
  // stack rather than baked into the RET (which has no idea who called it).
  h('call_rel', 4, `
  ${ops(4)}
  (call $push16 (local.get $t2))
  (call $rpush (local.get $t2) (local.get $t3))
  ${GO('(local.get $t0)', '(local.get $t1)')}
`);
  // RET consults the shadow stack. A hit resumes in the arena; anything else --
  // a manufactured return address, a stack the callee rearranged, a call whose
  // return point was never compiled -- falls back to handing the guest IP to
  // the host, which is what always used to happen.
  const RET_BODY = `
  (global.set $gip (call $pop16))
  (local.set $t7 (call $rpop (global.get $gip)))
  (if ${CONT('(local.get $t7)')}
    (then (global.set $ip (local.get $t7)))
    (else (global.set $left (global.get $steps)) (global.set $halt (i32.const 1))))`;
  h('ret', 0, RET_BODY);
  h('ret_imm', 1, `
  ${ops(1)}
  (global.set $gip (call $pop16))
  (global.set $sp (i32.and (i32.add (global.get $sp) (local.get $t0)) (global.get $spm)))
  (local.set $t7 (call $rpop (global.get $gip)))
  (if ${CONT('(local.get $t7)')}
    (then (global.set $ip (local.get $t7)))
    (else (global.set $left (global.get $steps)) (global.set $halt (i32.const 1))))
`);
  // The same three, in a 32-bit code segment. The only difference is the width
  // of the return address on the stack -- but it is the difference between
  // resuming at 0x00031a4c and resuming at 0x1a4c, so they are separate
  // handlers rather than a runtime test inside the hot ones.
  h('call_rel32', 4, `
  ${ops(4)}
  (call $push32 (local.get $t2))
  (call $rpush (local.get $t2) (local.get $t3))
  ${GO('(local.get $t0)', '(local.get $t1)')}
`);
  h('ret32', 0, `
  (global.set $gip (call $pop32))
  (local.set $t7 (call $rpop (global.get $gip)))
  (if ${CONT('(local.get $t7)')}
    (then (global.set $ip (local.get $t7)))
    (else (global.set $left (global.get $steps)) (global.set $halt (i32.const 1))))
`);
  h('ret_imm32', 1, `
  ${ops(1)}
  (global.set $gip (call $pop32))
  (global.set $sp (i32.and (i32.add (global.get $sp) (local.get $t0)) (global.get $spm)))
  (local.set $t7 (call $rpop (global.get $gip)))
  (if ${CONT('(local.get $t7)')}
    (then (global.set $ip (local.get $t7)))
    (else (global.set $left (global.get $steps)) (global.set $halt (i32.const 1))))
`);

  // LEA computes the effective address and never touches memory -- which is
  // why it is here and not a MOV form.
  h('lea', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $rset16 (local.get $t6) (local.get $t4))
`);

  // XCHG. The register/register form is also how NOP encodes (90 = xchg ax,ax).
  for (const w of [8, 16, 32]) {
    h(`xchg_rr${w}`, 1, `
  ${ops(1)}
  (local.set $t1 (i32.and (local.get $t0) (i32.const 7)))
  (local.set $t2 (i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 7)))
  (local.set $t3 (call $rget${w} (local.get $t1)))
  (call $rset${w} (local.get $t1) (call $rget${w} (local.get $t2)))
  (call $rset${w} (local.get $t2) (local.get $t3))
`);
    h(`xchg_mr${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (local.set $t2 (call $rd${w} (local.get $t5) (local.get $t4)))
  (call $wr${w} (local.get $t5) (local.get $t4) (call $rget${w} (local.get $t6)))
  (call $rset${w} (local.get $t6) (local.get $t2))
`);

    // NOT writes no flags at all; NEG is 0 - x and writes them all.
    h(`not_r${w}`, 1, `
  ${ops(1)}
  (call $rset${w} (local.get $t0)
    (i32.and (i32.xor (call $rget${w} (local.get $t0)) (i32.const -1))
             (i32.const ${WM(w)})))
`);
    h(`not_m${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $wr${w} (local.get $t5) (local.get $t4)
    (i32.and (i32.xor (call $rd${w} (local.get $t5) (local.get $t4)) (i32.const -1))
             (i32.const ${WM(w)})))
`);
    h(`neg_r${w}`, 1, `
  ${ops(1)}
  (local.set $t1 (call $rget${w} (local.get $t0)))
  (local.set $t2 (i32.sub (i32.const 0) (local.get $t1)))
  (call $rset${w} (local.get $t0) (i32.and (local.get $t2) (i32.const ${WM(w)})))
  ${SUB_FLAGS(w, '(i32.const 0)', '(local.get $t1)', '(local.get $t2)')}
`);
    h(`neg_m${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (local.set $t2 (call $rd${w} (local.get $t5) (local.get $t4)))
  (local.set $t3 (i32.sub (i32.const 0) (local.get $t2)))
  (call $wr${w} (local.get $t5) (local.get $t4) (i32.and (local.get $t3) (i32.const ${WM(w)})))
  ${SUB_FLAGS(w, '(i32.const 0)', '(local.get $t2)', '(local.get $t3)')}
`);

    // INC/DEC on memory and on 8-bit registers. Like the 16-bit register pair
    // above, these must leave CF alone.
    h(`inc_r${w}`, 1, `
  ${ops(1)}
  (local.set $t1 (call $rget${w} (local.get $t0)))
  (local.set $t2 (i32.add (local.get $t1) (i32.const 1)))
  (call $rset${w} (local.get $t0) (i32.and (local.get $t2) (i32.const ${WM(w)})))
  ${INC_FLAGS(w, '(local.get $t1)', '(local.get $t2)')}
`);
    h(`dec_r${w}`, 1, `
  ${ops(1)}
  (local.set $t1 (call $rget${w} (local.get $t0)))
  (local.set $t2 (i32.sub (local.get $t1) (i32.const 1)))
  (call $rset${w} (local.get $t0) (i32.and (local.get $t2) (i32.const ${WM(w)})))
  ${DEC_FLAGS(w, '(local.get $t1)', '(local.get $t2)')}
`);
    h(`inc_m${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (local.set $t2 (call $rd${w} (local.get $t5) (local.get $t4)))
  (local.set $t3 (i32.add (local.get $t2) (i32.const 1)))
  (call $wr${w} (local.get $t5) (local.get $t4) (i32.and (local.get $t3) (i32.const ${WM(w)})))
  ${INC_FLAGS(w, '(local.get $t2)', '(local.get $t3)')}
`);
    h(`dec_m${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (local.set $t2 (call $rd${w} (local.get $t5) (local.get $t4)))
  (local.set $t3 (i32.sub (local.get $t2) (i32.const 1)))
  (call $wr${w} (local.get $t5) (local.get $t4) (i32.and (local.get $t3) (i32.const ${WM(w)})))
  ${DEC_FLAGS(w, '(local.get $t2)', '(local.get $t3)')}
`);
  }

  // Segment register moves. 8C reads one, 8E writes one.
  h('mov_r_sr', 1, `
  ${ops(1)}
  (call $rset16 (i32.and (local.get $t0) (i32.const 7))
                (call $sget (i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 7))))
`);
  h('mov_sr_r', 1, `
  ${ops(1)}
  (call $sset (i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 7))
              (call $rget16 (i32.and (local.get $t0) (i32.const 7))))
`);
  h('mov_m_sr', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $wr16 (local.get $t5) (local.get $t4)
              (call $sget (i32.and (local.get $t6) (i32.const 7))))
`);
  h('mov_sr_m', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $sset (i32.and (local.get $t6) (i32.const 7))
              (call $rd16 (local.get $t5) (local.get $t4)))
`);

  // Sign extension. These go through the register file rather than writing the
  // global directly, so the upper half of EAX/EDX survives -- a demo that keeps
  // a fixed-point value in EAX and calls CBW on AL would otherwise lose it.
  h('cbw', 0, `
  (call $rset16 (i32.const 0)
    (i32.shr_s (i32.shl (global.get $ax) (i32.const 24)) (i32.const 24)))
`);
  h('cwd', 0, `
  (call $rset16 (i32.const 2) (select (i32.const 0xFFFF) (i32.const 0)
    (i32.and (i32.shr_u (global.get $ax) (i32.const 15)) (i32.const 1))))
`);
  // The 32-bit twins: CWDE widens AX into EAX, CDQ widens EAX into EDX:EAX.
  h('cwde', 0, `
  (global.set $ax (i32.shr_s (i32.shl (global.get $ax) (i32.const 16)) (i32.const 16)))
`);
  h('cdq', 0, `
  (global.set $dx (i32.shr_s (global.get $ax) (i32.const 31)))
`);

  // Flag-register instructions. Each one is a single bit, but a wrong one here
  // changes which way a later branch goes, so they are spelled out.
  // CLD/STD/CLI/STI move a bit OUTSIDE the arithmetic set, and those bits are
  // authoritative in the word whether or not an ALU result is still deferred --
  // so they edit it in place and leave the pending record alone. CLC/STC/CMC
  // move CF, which may still be owed by an earlier compare, so they materialize
  // first and retire the record with the result.
  const setF = (b, v) => {
    const lazy = LAZY && (isa.FLAGS_ARITH & (1 << b)) !== 0;
    const read = lazy ? '(call $flags_word)' : '(global.get $flags)';
    const put = (x) => (lazy ? `(call $flags_put ${x})` : `(global.set $flags ${x})`);
    return put(v
      ? `(i32.or ${read} (i32.const ${1 << b}))`
      : `(i32.and ${read} (i32.const ${(~(1 << b)) & 0xFFFF}))`);
  };
  h('clc', 0, setF(F.CF, 0));
  h('stc', 0, setF(F.CF, 1));
  h('cmc', 0, `(call $flags_put (i32.xor (call $flags_word) (i32.const ${1 << F.CF})))`);
  h('cld', 0, setF(F.DF, 0));
  h('std', 0, setF(F.DF, 1));
  h('cli', 0, setF(F.IF, 0));
  h('sti', 0, setF(F.IF, 1));
  h('nop', 0, '');

  // SAHF/LAHF move the low byte of FLAGS through AH.
  h('sahf', 0, `
  (call $flags_put (i32.or
    (i32.and (call $flags_word) (i32.const 0xFF00))
    (i32.or (i32.and (i32.shr_u (global.get $ax) (i32.const 8)) (i32.const 0xD5))
            (i32.const 2))))
`);
  h('lahf', 0, `
  (call $rset16 (i32.const 0) (i32.or
    (i32.and (global.get $ax) (i32.const 0x00FF))
    (i32.shl (i32.and (call $flags_word) (i32.const 0xFF)) (i32.const 8))))
`);

  // --- BCD and ASCII adjust -------------------------------------------------
  // The four packed/unpacked decimal fixups. They are rare in compiler output
  // and common in hand-written demo and depacker code, which is exactly the
  // corpus this VM runs. Each one is spelled out from the Intel pseudo-code
  // rather than folded together: the second test in DAA/DAS reads the value AL
  // had BEFORE the first adjustment, and sharing a local between the two is the
  // classic way to get that wrong.
  //
  // $flags_logic sets SF/ZF/PF from the result and clears CF/AF/OF, so each
  // handler recomputes CF and AF afterwards. OF is architecturally undefined
  // for all four and is left cleared.
  // Both halves test the value AL held on entry, and CF comes out of the high
  // test alone -- a borrow out of `AL - 6` does not survive into it, which is
  // where the manual's pseudo-code and the physical 8088 first part company
  // (DAS on AL=0x03 with AF set leaves CF clear on the real part).
  //
  // And they part company again on the high threshold. The manual's `old_AL >
  // 0x99` holds only with AF clear on entry; with AF set the band 0x9A..0x9F
  // does NOT adjust, so the effective threshold there is 0x9F. Both mnemonics
  // behave the same way and the corpus is unanimous on all four corners --
  // e.g. DAA on AL=0x9E adjusts to 0x04 with AF clear and stops at 0xA4 with
  // AF set. No valid BCD add or subtract can land in that band, which is
  // presumably why the manual never had to be right about it.
  for (const [nm, sign] of [['daa', '+'], ['das', '-']]) {
    const add = sign === '+' ? 'i32.add' : 'i32.sub';
    h(nm, 0, `
  (local.set $t0 (call $rget8 (i32.const 0)))
  (local.set $t2 (i32.or (i32.or (i32.gt_u (local.get $t0) (i32.const 0x9F)) ${bit(F.CF)})
    (i32.and (i32.gt_u (local.get $t0) (i32.const 0x99)) (i32.eqz ${bit(F.AF)}))))
  (local.set $t3 (i32.const 0))
  (if (i32.or (i32.gt_u (i32.and (local.get $t0) (i32.const 0x0F)) (i32.const 9))
              ${bit(F.AF)})
    (then
      (local.set $t3 (i32.const 1))
      (local.set $t0 (i32.and (${add} (local.get $t0) (i32.const 6)) (i32.const 0xFF)))))
  (if (local.get $t2)
    (then
      (local.set $t0 (i32.and (${add} (local.get $t0) (i32.const 0x60)) (i32.const 0xFF)))))
  (call $rset8 (i32.const 0) (local.get $t0))
  (call $flags_logic (local.get $t0) (i32.const 8))
  (global.set $flags (i32.or (global.get $flags)
    (i32.or (local.get $t2) (i32.shl (local.get $t3) (i32.const ${F.AF})))))
`);
  }

  // AAA/AAS unpack one BCD digit: the adjustment carries into AH, and AL keeps
  // only its low nibble. SF/ZF/PF are undefined here (unlike DAA/DAS), so the
  // flag word is edited in place rather than recomputed.
  for (const [nm, sign] of [['aaa', '+'], ['aas', '-']]) {
    const add = sign === '+' ? 'i32.add' : 'i32.sub';
    h(nm, 0, `
  (local.set $t0 (call $rget8 (i32.const 0)))
  (local.set $t2 (i32.const 0))
  (if (i32.or (i32.gt_u (i32.and (local.get $t0) (i32.const 0x0F)) (i32.const 9))
              ${bit(F.AF)})
    (then
      (local.set $t0 (i32.and (${add} (local.get $t0) (i32.const 6)) (i32.const 0xFF)))
      (call $rset8 (i32.const 4)
        (i32.and (${add} (call $rget8 (i32.const 4)) (i32.const 1)) (i32.const 0xFF)))
      (local.set $t2 (i32.const 1))))
  (call $rset8 (i32.const 0) (i32.and (local.get $t0) (i32.const 0x0F)))
  (call $flags_put (i32.or
    (i32.and (call $flags_word)
             (i32.const ${(~((1 << F.CF) | (1 << F.AF))) & 0xFFFF}))
    (i32.or (local.get $t2) (i32.shl (local.get $t2) (i32.const ${F.AF})))))
`);
  }

  // AAM divides AL by the immediate (10 in every sane encoding, but the byte is
  // real and the corpus exercises other values); AAD multiplies back. A zero
  // divisor faults exactly like DIV does, so the operand carries the guest IP.
  h('aam', 2, `
  ${ops(2)}
  ;; A zero divisor faults, but not before the flags are written -- the part
  ;; sets SF/ZF/PF as though the result were zero and then takes INT 0, so the
  ;; flags word the fault pushes carries them. DIV does not do this; AAM does.
  (if (i32.eqz (local.get $t0))
    (then
      (call $flags_logic (i32.const 0) (i32.const 8))
      (call $fault0 (local.get $t1))
      (return)))
  (local.set $t2 (call $rget8 (i32.const 0)))
  (call $rset16 (i32.const 0) (i32.or
    (i32.rem_u (local.get $t2) (local.get $t0))
    (i32.shl (i32.div_u (local.get $t2) (local.get $t0)) (i32.const 8))))
  (call $flags_logic (i32.rem_u (local.get $t2) (local.get $t0)) (i32.const 8))
`);
  h('aad', 1, `
  ${ops(1)}
  (local.set $t2 (i32.and (i32.add (call $rget8 (i32.const 0))
    (i32.mul (call $rget8 (i32.const 4)) (local.get $t0))) (i32.const 0xFF)))
  (call $rset16 (i32.const 0) (local.get $t2))
  (call $flags_logic (local.get $t2) (i32.const 8))
`);

  // SALC (undocumented, 0xD6): AL = CF ? 0xFF : 0, no flags touched. It is a
  // one-byte "set AL from carry" that assembly-language demo code does use.
  h('salc', 0, `
  (call $rset8 (i32.const 0) (i32.sub (i32.const 0) ${bit(F.CF)}))
`);

  // INTO takes INT 4 only when OF is set, and otherwise falls through -- so
  // unlike INT it does not end the block, and the fall-through path leaves $ip
  // alone for the next op in the arena.
  h('into', 1, `
  ${ops(1)}
  (if ${bit(F.OF)} (then (call $fault (i32.const 4) (local.get $t0))))
`);

  // BOUND, the other conditional fault. It reads a two-element signed array at
  // the effective address and takes INT 5 when the register is outside it,
  // which is why it shares INTO's shape: no block end, and the fall-through
  // leaves $ip where the next op expects it.
  //
  // Its real job here is not array checking. Polymorphic decryptors use BOUND
  // and ICEBP as filler between the instructions that matter -- both are one or
  // two bytes, both are almost always harmless on real hardware, and a
  // disassembler walking the stream linearly trips over them. STHINTRO.EXE's
  // decryptor emits `F1 62 48 A4`, and refusing either byte stops the run on
  // code the guest was entitled to execute.
  for (const w of [16, 32]) {
    // Both bounds and the index are signed, and at 16 bits they arrive
    // zero-extended, so each one is widened before it is compared.
    const sx = (e) => (w === 32 ? e
      : `(i32.shr_s (i32.shl ${e} (i32.const 16)) (i32.const 16))`);
    h(`bound${w}`, 3, `
  ${ops(3)}
  ${EA_SETUP_PRE}
  (local.set $t7 ${sx(`(call $rget${w} (local.get $t6))`)})
  (local.set $t3 ${sx(`(call $rd${w} (local.get $t5) (local.get $t4))`)})
  (if (i32.or
        (i32.lt_s (local.get $t7) (local.get $t3))
        (i32.gt_s (local.get $t7)
          ${sx(`(call $rd${w} (local.get $t5) (i32.add (local.get $t4) (i32.const ${w >> 3})))`)}))
    (then (call $fault (i32.const 5) (local.get $t2))))
`);
  }

  // JCXZ, LOOPZ, LOOPNZ -- the remaining counted-loop terminators. Each is
  // generated twice: once counting CX, and once counting ECX for the form with
  // a 0x67 address-size override in front of it. LOOP itself gets the same
  // treatment beside its 16-bit definition above.
  for (const [sfx, zero, dec] of [['', '$cx16', '$cxdec'], ['32', '$ecx32', '$ecxdec']]) {
    h(`jcxz${sfx}`, 4, `
  ${ops(4)}
  (if (i32.eqz (call ${zero}))
    (then ${GO('(local.get $t0)', '(local.get $t1)')})
    (else ${GO('(local.get $t2)', '(local.get $t3)')}))
`);
    for (const [nm, want] of [['loopz', 1], ['loopnz', 0]]) {
      h(`${nm}${sfx}`, 4, `
  ${ops(4)}
  (if (i32.and (i32.ne (call ${dec}) (i32.const 0))
               (i32.eq ${bit(F.ZF)} (i32.const ${want})))
    (then ${GO('(local.get $t0)', '(local.get $t1)')})
    (else ${GO('(local.get $t2)', '(local.get $t3)')}))
`);
    }
  }

  // INT does the architectural thing: push FLAGS/CS/IP, clear IF and TF, and
  // load CS:IP from the interrupt vector table at physical 0. It does NOT
  // short-circuit to the host -- doing that failed all 1200 corpus cases,
  // because the tests supply a real IVT and expect it to be read.
  //
  // The host still gets to service DOS and BIOS calls: tools/toyvm/dos.js
  // points the vectors at a stub whose first byte the decoder refuses, so the
  // trace ends there and the host sees a guest IP inside its own stub region.
  // $intno is recorded for its convenience.
  // $fault is the whole sequence, shared with the arithmetic faults, and it is
  // what knows whether this machine currently has an IDT to go through.
  h('int_imm', 3, `
  ${ops(3)}
  (call $faultsw (local.get $t0) (local.get $t1) (local.get $t2))
`);
  h('iret', 0, `
  (global.set $gip (call $pop16))
  (call $sset (i32.const 1) (call $pop16))
  (call $flags_put (i32.or
    (i32.and (call $pop16) ${DEFINED})
    ${RESERVED}))
  (global.set $left (global.get $steps)) (global.set $halt (i32.const 1))
`);
  // IRETD. The frame is three dwords, and the selector is the low half of the
  // middle one -- the upper half is pushed and popped but means nothing.
  // The whole frame comes off into locals before anything is published, and
  // the reason is ordering rather than tidiness: $sset recomputes the segment
  // base through $segbase, and $segbase's answer depends on $vm86 -- which is
  // in the third dword, the one popped last. Load CS first and a V86 return is
  // resolved as a protected-mode selector that names no descriptor, which is
  // exactly the failure this is here to fix.
  //
  // $vm86 is only ever set here, never cleared: on the hardware, leaving V86
  // is a trap into the monitor, not an IRETD, and an IRETD executed BY the V86
  // guest is an ordinary 8086 IRET whose frame carries no VM bit at all. So the
  // set is guarded on being in protected mode and not already in V86 -- without
  // that guard the guest's own IRETs would drop it back out on the first one.
  h('iret32', 0, `
  (local.set $t0 (call $pop32))
  (local.set $t1 (call $pop32))
  (local.set $t2 (call $pop32))
  (if (i32.and (i32.and (global.get $cr0) (i32.const 1))
               (i32.and (i32.eqz (global.get $vm86))
                        (i32.and (i32.shr_u (local.get $t2) (i32.const 17))
                                 (i32.const 1))))
    (then (call $v86_from_monitor (local.get $t0) (local.get $t1) (local.get $t2)))
    (else
      (call $sset (i32.const 1) (i32.and (local.get $t1) (i32.const 0xFFFF)))
      (global.set $gip (local.get $t0))
      (call $flags_put (i32.or (i32.and (local.get $t2) ${DEFINED}) ${RESERVED}))))
  (global.set $left (global.get $steps)) (global.set $halt (i32.const 1))
`);
}

// --- String operations, with and without REP --------------------------------
// ES is segment index 0 and is NOT overridable for the destination; the source
// defaults to DS and is. Direction comes from DF, so every one of these moves
// backwards when a demo sets STD -- which they do, constantly, for scrolls.
// A compare's flags, at whichever width -- the 32-bit form needs the dedicated
// helper because there is no room above bit 31 to keep the borrow.
const CMP_FLAGS = (w, a, b) => (w === 32
  ? `(call ${FL('sub32')} ${a} ${b} (i32.const 0) (i32.sub ${a} ${b}))`
  : `(call ${FL('sub')} ${a} ${b} (i32.sub ${a} ${b}) (i32.const ${w}))`);

function genStrings() {
  const DELTA = (sz) => `(select (i32.const ${-sz}) (i32.const ${sz}) ${bit(F.DF)})`;

  // Everything below is generated twice, once per ADDRESS size. That is the
  // only axis a 0x67 prefix moves: which registers index the strings and how
  // wide the counter is. The data width is separate and already varies.
  //
  // In 16-bit addressing SI/DI move as 16-bit quantities and the upper half of
  // ESI/EDI has to survive, which is why the index goes through $rset16 --
  // that merges rather than replaces. In 32-bit addressing the whole of ESI and
  // EDI is the index and the whole of it moves.
  const forAsize = (a) => {
    const g = a === 32 ? '$rget32' : '$rget16';
    const st = a === 32 ? '$rset32' : '$rset16';
    const idx = (reg) => `(call ${g} (i32.const ${{ si: 6, di: 7 }[reg]}))`;
    const bump = (reg, sz) =>
      `(call ${st} (i32.const ${{ si: 6, di: 7 }[reg]})
         (i32.add ${idx(reg)} ${DELTA(sz)}))`;

    // body(w) produces one iteration; `rep` wraps it in a count loop.
    const BODIES = {
      movs: (w, sz) => `
    (call $wr${w} (i32.const 0) ${idx('di')}
      (call $rd${w} (local.get $t0) ${idx('si')}))
    ${bump('si', sz)} ${bump('di', sz)}`,
      stos: (w, sz) => `
    (call $wr${w} (i32.const 0) ${idx('di')} (call $rget${w} (i32.const 0)))
    ${bump('di', sz)}`,
      lods: (w, sz) => `
    (call $rset${w} (i32.const 0) (call $rd${w} (local.get $t0) ${idx('si')}))
    ${bump('si', sz)}`,
      scas: (w, sz) => `
    (local.set $t2 (call $rget${w} (i32.const 0)))
    (local.set $t3 (call $rd${w} (i32.const 0) ${idx('di')}))
    ${CMP_FLAGS(w, '(local.get $t2)', '(local.get $t3)')}
    ${bump('di', sz)}`,
      cmps: (w, sz) => `
    (local.set $t2 (call $rd${w} (local.get $t0) ${idx('si')}))
    (local.set $t3 (call $rd${w} (i32.const 0) ${idx('di')}))
    ${CMP_FLAGS(w, '(local.get $t2)', '(local.get $t3)')}
    ${bump('si', sz)} ${bump('di', sz)}`,
    };

    const asfx = a === 32 ? '32' : '';
    const count = a === 32 ? '$ecx32' : '$cx16';
    const dec = a === 32 ? '$ecxdec' : '$cxdec';

    for (const [name, body] of Object.entries(BODIES)) {
      for (const w of [8, 16, 32]) {
        const sz = w >> 3;
        const suffix = { 8: 'b', 16: 'w', 32: 'd' }[w];
        // Plain form: operand is the source segment index (ignored by
        // STOS/SCAS).
        h(`${name}${suffix}${asfx}`, 1, `
  ${ops(1)}
  ${body(w, sz)}
`);

        // REP forms run the whole count inside one dispatch, which is exactly
        // what the production interpreter's REP handlers do -- and is the
        // reason a fold like this is worth anything: the loop never pays
        // dispatch again. The count register is the meter, so a super-op like
        // this must also charge the host's step budget; here that is $steps,
        // decremented per element.
        const isCompare = name === 'scas' || name === 'cmps';
        for (const rep of (isCompare ? ['rep', 'repne'] : ['rep'])) {
          const zWant = rep === 'rep' ? 1 : 0;
          h(`${rep}_${name}${suffix}${asfx}`, 1, `
  ${ops(1)}
  (block $done
    (loop $l
      (br_if $done (i32.eqz (call ${count})))
      ${body(w, sz)}
      (drop (call ${dec}))
      (global.set $steps (i32.sub (global.get $steps) (i32.const 1)))
      ${isCompare ? `(br_if $done (i32.ne ${bit(F.ZF)} (i32.const ${zWant})))` : ''}
      (br $l)))
`);
        }
      }
    }
  };
  forAsize(16);
  forAsize(32);
}

// --- Shifts and rotates -----------------------------------------------------
// Done a bit at a time in a loop rather than with a closed form. The 8086 does
// not mask the count, CF is defined as the last bit shifted out, and OF is only
// meaningful for a count of one -- a closed form gets at least one of those
// wrong, and a shift flag error surfaces as a branch going the wrong way much
// later.
function genShifts() {
  for (const w of [8, 16, 32]) {
    // Written as -1 at width 32 rather than 0xFFFFFFFF: an i32.const is signed,
    // and every use here is a mask where -1 is the identity anyway.
    const mask = { 8: '0xFF', 16: '0xFFFF', 32: '-1' }[w];
    const msb = w - 1;
    // One bit of movement per kind. The count is not masked on an 8086 and CF
    // is defined as the last bit out, so the loop is the specification; a
    // closed form would have to special-case both.
    const ONE = {
      rol: `(local.set $v (i32.or (i32.and (i32.shl (local.get $v) (i32.const 1)) (i32.const ${mask}))
                                  (i32.shr_u (local.get $v) (i32.const ${msb}))))
            (local.set $cf (i32.and (local.get $v) (i32.const 1)))`,
      ror: `(local.set $cf (i32.and (local.get $v) (i32.const 1)))
            (local.set $v (i32.or (i32.shr_u (local.get $v) (i32.const 1))
                                  (i32.shl (local.get $cf) (i32.const ${msb}))))`,
      rcl: `(local.set $t (i32.and (i32.shr_u (local.get $v) (i32.const ${msb})) (i32.const 1)))
            (local.set $v (i32.or (i32.and (i32.shl (local.get $v) (i32.const 1)) (i32.const ${mask}))
                                  (local.get $cf)))
            (local.set $cf (local.get $t))`,
      rcr: `(local.set $t (i32.and (local.get $v) (i32.const 1)))
            (local.set $v (i32.or (i32.shr_u (local.get $v) (i32.const 1))
                                  (i32.shl (local.get $cf) (i32.const ${msb}))))
            (local.set $cf (local.get $t))`,
      shl: `(local.set $cf (i32.and (i32.shr_u (local.get $v) (i32.const ${msb})) (i32.const 1)))
            (local.set $v (i32.and (i32.shl (local.get $v) (i32.const 1)) (i32.const ${mask})))`,
      shr: `(local.set $cf (i32.and (local.get $v) (i32.const 1)))
            (local.set $v (i32.shr_u (local.get $v) (i32.const 1)))`,
      sar: `(local.set $cf (i32.and (local.get $v) (i32.const 1)))
            (local.set $v (i32.and (i32.shr_s
                (i32.shr_s (i32.shl (local.get $v) (i32.const ${32 - w})) (i32.const ${32 - w}))
                (i32.const 1)) (i32.const ${mask})))`,
    };
    for (const [kind, one] of Object.entries(ONE)) {
      const rotate = ['rol', 'ror', 'rcl', 'rcr'].includes(kind);
      // OF is architecturally defined only for a shift of one. The 8086 still
      // writes it for longer counts; the corpus marks it undefined there, and
      // gate.js masks it for these mnemonics.
      const ofExpr = {
        rol: `(i32.xor (local.get $cf) (i32.and (i32.shr_u (local.get $v) (i32.const ${msb})) (i32.const 1)))`,
        rcl: `(i32.xor (local.get $cf) (i32.and (i32.shr_u (local.get $v) (i32.const ${msb})) (i32.const 1)))`,
        ror: `(i32.xor (i32.and (i32.shr_u (local.get $v) (i32.const ${msb})) (i32.const 1))
                       (i32.and (i32.shr_u (local.get $v) (i32.const ${msb - 1})) (i32.const 1)))`,
        rcr: `(i32.xor (i32.and (i32.shr_u (local.get $v) (i32.const ${msb})) (i32.const 1))
                       (i32.and (i32.shr_u (local.get $v) (i32.const ${msb - 1})) (i32.const 1)))`,
        shl: `(i32.xor (local.get $cf) (i32.and (i32.shr_u (local.get $v) (i32.const ${msb})) (i32.const 1)))`,
        shr: `(i32.and (i32.shr_u (local.get $orig) (i32.const ${msb})) (i32.const 1))`,
        sar: `(i32.const 0)`,
      }[kind];

      s_shift(kind, w, one, rotate, ofExpr, mask, msb);
    }
  }
}

// Emitted as a helper function per (kind, width) so the shift handlers stay
// small and the loop is written once.
const SHIFT_FNS = [];
function s_shift(kind, w, one, rotate, ofExpr, mask, msb) {
  SHIFT_FNS.push(`
(func $sh_${kind}${w} (param $v i32) (param $n i32) (result i32)
  (local $cf i32) (local $t i32) (local $orig i32) (local $f i32)
  (local.set $orig (local.get $v))
  ;; A rotate-through-carry reads the INCOMING CF, which under lazy flags may
  ;; still be owed by an earlier compare -- hence the getter rather than a shift
  ;; out of the word.
  (local.set $cf ${CF_IN()})
  ;; How much of the count this part looks at. See \$shmask -- an 8086 shifts
  ;; the whole of it, a 186 and later masks it to five bits, and programs probe
  ;; the difference deliberately.
  (local.set $n (i32.and (local.get $n) (global.get $shmask)))
  (if (i32.eqz (local.get $n)) (then (return (local.get $v))))
  (block $done (loop $l
    (br_if $done (i32.eqz (local.get $n)))
    ${one}
    (local.set $n (i32.sub (local.get $n) (i32.const 1)))
    (br $l)))
  ;; A rotate touches only CF and OF; a shift also defines SF, ZF and PF. Which
  ;; bits get cleared here has to match, or a rotate silently zeroes the ZF a
  ;; preceding compare set.
  (local.set $f (i32.and (call $flags_word)
    (i32.const ${(~((1 << isa.F.CF) | (1 << isa.F.OF) | (rotate ? 0
      : ((1 << isa.F.SF) | (1 << isa.F.ZF) | (1 << isa.F.PF))))) & 0xFFFF})))
  (local.set $f (i32.or (local.get $f) (i32.and (local.get $cf) (i32.const 1))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.and ${ofExpr} (i32.const 1)) (i32.const ${isa.F.OF}))))
  ${rotate ? '' : `
  ;; Rotates leave SF/ZF/PF alone; shifts define all three.
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.and (i32.shr_u (local.get $v) (i32.const ${msb})) (i32.const 1))
             (i32.const ${isa.F.SF}))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.eqz (local.get $v)) (i32.const ${isa.F.ZF}))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.and (i32.xor (i32.popcnt (i32.and (local.get $v) (i32.const 0xFF)))
                               (i32.const 1)) (i32.const 1))
             (i32.const ${isa.F.PF}))))`}
  (call $flags_put (i32.or (local.get $f) ${RESERVED}))
  (local.get $v))
`);
}

// /6 is not a second SHL. On this part it is the undocumented SETMO: the
// destination becomes all ones and the flags come out as if from a logic op.
// The count still matters for the CL forms -- a count of zero does nothing at
// all, flags included.
const SHIFT_KINDS = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'setmo', 'sar'];
function genSetmo() {
  for (const w of [8, 16, 32]) {
    const all = { 8: '0xFF', 16: '0xFFFF', 32: '-1' }[w];
    const guard = (count) => `(if (i32.ne ${count} (i32.const 0)) (then`;
    h(`sh6_r${w}`, 2, `
  ${ops(2)}
  (local.set $t2 (select (i32.and (call $rget8 (i32.const 1)) (i32.const 0xFF))
                         (local.get $t1) (i32.eq (local.get $t1) (i32.const -1))))
  ${guard('(local.get $t2)')}
    (call $rset${w} (local.get $t0) (i32.const ${all}))
    (call $flags_logic (i32.const ${all}) (i32.const ${w}))))
`);
    h(`sh6_m${w}`, 3, `
  ${ops(3)}
  ${EA_SETUP_PRE}
  (local.set $t3 (select (i32.and (call $rget8 (i32.const 1)) (i32.const 0xFF))
                         (local.get $t2) (i32.eq (local.get $t2) (i32.const -1))))
  ${guard('(local.get $t3)')}
    (call $wr${w} (local.get $t5) (local.get $t4) (i32.const ${all}))
    (call $flags_logic (i32.const ${all}) (i32.const ${w}))))
`);
  }
}

function genShiftHandlers() {
  for (const w of [8, 16, 32]) {
    SHIFT_KINDS.forEach((kind, idx) => {
      if (idx === 6) return;   // SETMO, generated above
      // Two operand shapes: register or memory destination, count from an
      // immediate operand (which the decoder fills with 1 for D0/D1 and with CL
      // at run time for D2/D3 by passing 0xFF as a sentinel).
      h(`sh${idx}_r${w}`, 2, `
  ${ops(2)}
  (call $rset${w} (local.get $t0)
    (call $sh_${kind}${w} (call $rget${w} (local.get $t0))
      (select (i32.and (call $rget8 (i32.const 1)) (i32.const 0xFF)) (local.get $t1)
              (i32.eq (local.get $t1) (i32.const -1)))))
`);
      h(`sh${idx}_m${w}`, 3, `
  ${ops(3)}
  ${EA_SETUP_PRE}
  (call $wr${w} (local.get $t5) (local.get $t4)
    (call $sh_${kind}${w} (call $rd${w} (local.get $t5) (local.get $t4))
      (select (i32.and (call $rget8 (i32.const 1)) (i32.const 0xFF)) (local.get $t2)
              (i32.eq (local.get $t2) (i32.const -1)))))
`);
    });
  }
}

// --- SHLD / SHRD ------------------------------------------------------------
// The 386 double-precision shifts: bits shifted out of the destination are
// replaced from a second register rather than with zeroes. mars.exe reaches one
// within a few thousand instructions, and it is the only place in the VM where
// a result depends on 2w bits at once -- hence the i64, which makes the 16- and
// 32-bit forms the same code instead of two special cases.
function genDoubleShifts() {
  for (const w of [16, 32]) {
    const mask = WM(w);
    const msb = w - 1;
    for (const kind of ['shld', 'shrd']) {
      // The concatenation the shift walks across, and where the last bit out of
      // the destination comes from. Note SHLD reads its CF bit from the count
      // counted down from the top and SHRD from the bottom.
      const cat = kind === 'shld'
        ? `(i64.or (i64.shl (i64.extend_i32_u (local.get $v)) (i64.const ${w}))
                   (i64.extend_i32_u (local.get $s)))`
        : `(i64.or (i64.shl (i64.extend_i32_u (local.get $s)) (i64.const ${w}))
                   (i64.extend_i32_u (local.get $v)))`;
      const res = kind === 'shld'
        ? `(i32.wrap_i64 (i64.shr_u (i64.shl (local.get $q) (i64.extend_i32_u (local.get $n)))
                                    (i64.const ${w})))`
        : `(i32.wrap_i64 (i64.shr_u (local.get $q) (i64.extend_i32_u (local.get $n))))`;
      const cf = kind === 'shld'
        ? `(i32.shr_u (local.get $v) (i32.sub (i32.const ${w}) (local.get $n)))`
        : `(i32.shr_u (local.get $v) (i32.sub (local.get $n) (i32.const 1)))`;
      SHIFT_FNS.push(`
(func $${kind}${w} (param $v i32) (param $s i32) (param $n i32) (result i32)
  (local $q i64) (local $r i32) (local $f i32)
  (local.set $n (i32.and (local.get $n) (i32.const 31)))
  ;; A count of zero is a complete no-op, flags included.
  (if (i32.eqz (local.get $n)) (then (return (local.get $v))))
  (local.set $q ${cat})
  (local.set $r (i32.and ${res} (i32.const ${mask})))
  (local.set $f (i32.and (call $flags_word) (i32.const ${(~((1 << isa.F.CF)
    | (1 << isa.F.OF) | (1 << isa.F.SF) | (1 << isa.F.ZF) | (1 << isa.F.PF))) & 0xFFFF})))
  (local.set $f (i32.or (local.get $f) (i32.and ${cf} (i32.const 1))))
  ;; OF is defined only for a count of one, as the sign changing.
  (local.set $f (i32.or (local.get $f) (i32.shl
    (i32.and (i32.xor (i32.shr_u (local.get $v) (i32.const ${msb}))
                      (i32.shr_u (local.get $r) (i32.const ${msb}))) (i32.const 1))
    (i32.const ${isa.F.OF}))))
  (local.set $f (i32.or (local.get $f) (i32.shl
    (i32.and (i32.shr_u (local.get $r) (i32.const ${msb})) (i32.const 1))
    (i32.const ${isa.F.SF}))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.eqz (local.get $r)) (i32.const ${isa.F.ZF}))))
  (local.set $f (i32.or (local.get $f) (i32.shl
    (i32.and (i32.xor (i32.popcnt (i32.and (local.get $r) (i32.const 0xFF))) (i32.const 1))
             (i32.const 1))
    (i32.const ${isa.F.PF}))))
  (call $flags_put (i32.or (local.get $f) ${RESERVED}))
  (local.get $r))
`);
      // -1 as the count operand means "take it from CL", the same sentinel the
      // single shifts use for their D2/D3 forms.
      const CNT = (t) => `(select (i32.and (call $rget8 (i32.const 1)) (i32.const 0xFF))
              (local.get $${t}) (i32.eq (local.get $${t}) (i32.const -1)))`;
      h(`${kind}_r${w}`, 2, `
  ${ops(2)}
  (call $rset${w} (i32.and (local.get $t0) (i32.const 7))
    (call $${kind}${w}
      (call $rget${w} (i32.and (local.get $t0) (i32.const 7)))
      (call $rget${w} (i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 7)))
      ${CNT('t1')}))
`);
      h(`${kind}_m${w}`, 3, `
  ${ops(3)}
  ${EA_SETUP_PRE}
  (call $wr${w} (local.get $t5) (local.get $t4)
    (call $${kind}${w}
      (call $rd${w} (local.get $t5) (local.get $t4))
      (call $rget${w} (local.get $t6))
      ${CNT('t2')}))
`);
    }
  }
}

// --- bit test / bit scan (386) ----------------------------------------------
// BT/BTS/BTR/BTC and BSF/BSR. Two things here are worth stating rather than
// inferring from the code:
//
// A register destination masks the bit index to the operand width, so BTS
// AX,17 touches bit 1 and nothing outside AX. A MEMORY destination does not:
// the index is a SIGNED bit displacement from the effective address, so
// BT [BX],-1 reads the top bit of the byte BEFORE the one BX names. Modelling
// that as a byte address plus a bit-in-byte is both exact and width-agnostic,
// which is why every memory form below reads and writes through $rd8/$wr8
// regardless of operand size.
//
// Only CF is architecturally defined by the bit tests (BSF/BSR define only ZF).
// The rest are left as they were rather than zeroed -- a program that reads
// them is reading undefined state on real silicon too, and leaving them alone
// keeps the difference visible instead of inventing a value.
const BIT_OPS = {
  bt: null,
  bts: (v, m) => `(i32.or ${v} ${m})`,
  btr: (v, m) => `(i32.and ${v} (i32.xor ${m} (i32.const -1)))`,
  btc: (v, m) => `(i32.xor ${v} ${m})`,
};
function genBitOps() {
  const CF_ONLY = (cf) => `(call $flags_put (i32.or
    (i32.and (call $flags_word) (i32.const 0xFFFE)) (i32.and ${cf} (i32.const 1))))`;

  for (const w of [16, 32]) {
    const mask = WM(w);
    // The bit index: an immediate when the decoder passed one, otherwise the
    // register named in the ModRM reg field. -1 is the "from a register"
    // sentinel, the same shape the shifts use for their CL forms.
    const IDX = (imm, reg) => `(select ${imm} ${reg} (i32.ne ${imm} (i32.const -1)))`;
    const SEXT = (v) => (w === 16
      ? `(i32.shr_s (i32.shl ${v} (i32.const 16)) (i32.const 16))` : v);

    for (const [nm, apply] of Object.entries(BIT_OPS)) {
      h(`${nm}_r${w}`, 2, `
  ${ops(2)}
  (local.set $t2 (i32.and (local.get $t0) (i32.const 7)))
  (local.set $t3 (i32.and ${IDX('(local.get $t1)',
        `(call $rget${w} (i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 7)))`)}
    (i32.const ${w - 1})))
  (local.set $t7 (call $rget${w} (local.get $t2)))
  ${CF_ONLY('(i32.shr_u (local.get $t7) (local.get $t3))')}
  ${apply ? `(call $rset${w} (local.get $t2) (i32.and
    ${apply('(local.get $t7)', '(i32.shl (i32.const 1) (local.get $t3))')}
    (i32.const ${mask})))` : ''}
`);
      h(`${nm}_m${w}`, 3, `
  ${ops(3)}
  ${EA_SETUP_PRE}
  (local.set $t3 ${IDX('(local.get $t2)', SEXT(`(call $rget${w} (local.get $t6))`))})
  (local.set $t7 (i32.and
    (i32.add (local.get $t4) (i32.shr_s (local.get $t3) (i32.const 3)))
    (i32.const 0xFFFF)))
  (local.set $t3 (i32.and (local.get $t3) (i32.const 7)))
  (local.set $t2 (call $rd8 (local.get $t5) (local.get $t7)))
  ${CF_ONLY('(i32.shr_u (local.get $t2) (local.get $t3))')}
  ${apply ? `(call $wr8 (local.get $t5) (local.get $t7) (i32.and
    ${apply('(local.get $t2)', '(i32.shl (i32.const 1) (local.get $t3))')}
    (i32.const 0xFF)))` : ''}
`);
    }

    // BSF/BSR. A zero source sets ZF and leaves the destination alone -- not
    // zeroes it, which is the tempting simplification and is wrong: the 386
    // documents the destination as undefined there, and real code relies on it
    // still holding the value it had.
    for (const nm of ['bsf', 'bsr']) {
      const scan = nm === 'bsf'
        ? '(i32.ctz (local.get $t7))'
        : `(i32.sub (i32.const 31) (i32.clz (local.get $t7)))`;
      const body = (src, dst) => `
  (local.set $t7 (i32.and ${src} (i32.const ${mask})))
  (call $flags_put (i32.or
    (i32.and (call $flags_word) (i32.const ${(~(1 << isa.F.ZF)) & 0xFFFF}))
    (i32.shl (i32.eqz (local.get $t7)) (i32.const ${isa.F.ZF}))))
  (if (local.get $t7) (then (call $rset${w} ${dst} ${scan})))
`;
      h(`${nm}_rr${w}`, 1, `
  ${ops(1)}
  ${body(`(call $rget${w} (i32.and (local.get $t0) (i32.const 7)))`,
    '(i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 7))')}
`);
      h(`${nm}_rm${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  ${body(`(call $rd${w} (local.get $t5) (local.get $t4))`, '(local.get $t6)')}
`);
    }
  }
}

// --- MUL / IMUL, port I/O, XLAT, moffs --------------------------------------
function genArithIO() {
  // MUL/IMUL/DIV/IDIV in both operand shapes. The only difference between them
  // is where the source comes from, so both are generated from one body with
  // the source expression swapped -- a memory divisor is not rare enough in
  // real code to leave out.
  //   reg form: [reg] (+ [ip] for the faulting ones)
  //   mem form: [ea] [disp] (+ [ip])
  const SRC = {
    r: (w) => ({ pre: '', src: `(call $rget${w} (local.get $t0))`, argc: 1 }),
    m: (w) => ({ pre: EA_SETUP_PRE, src: `(call $rd${w} (local.get $t5) (local.get $t4))`, argc: 2 }),
  };

  for (const form of ['r', 'm']) {
    const g = (w) => SRC[form](w);
    h(`mul_${form}8`, g(8).argc, `
  ${ops(g(8).argc)}
  ${g(8).pre}
  (call $rset16 (i32.const 0) (i32.mul (call $rget8 (i32.const 0)) ${g(8).src}))
  (call $flags_mul (call $rget8 (i32.const 4)))
`);
    h(`mul_${form}16`, g(16).argc, `
  ${ops(g(16).argc)}
  ${g(16).pre}
  (local.set $t7 (i32.mul (call $rget16 (i32.const 0)) ${g(16).src}))
  (call $rset16 (i32.const 2) (i32.shr_u (local.get $t7) (i32.const 16)))
  (call $rset16 (i32.const 0) (local.get $t7))
  (call $flags_mul (call $rget16 (i32.const 2)))
`);
    h(`imul_${form}8`, g(8).argc, `
  ${ops(g(8).argc)}
  ${g(8).pre}
  (local.set $t7 (i32.mul
    (i32.shr_s (i32.shl (call $rget8 (i32.const 0)) (i32.const 24)) (i32.const 24))
    (i32.shr_s (i32.shl ${g(8).src} (i32.const 24)) (i32.const 24))))
  (call $rset16 (i32.const 0) (local.get $t7))
  (call $flags_mul (i32.ne
    (i32.shr_s (i32.shl (local.get $t7) (i32.const 24)) (i32.const 24)) (local.get $t7)))
`);
    h(`imul_${form}16`, g(16).argc, `
  ${ops(g(16).argc)}
  ${g(16).pre}
  (local.set $t7 (i32.mul
    (i32.shr_s (i32.shl (call $rget16 (i32.const 0)) (i32.const 16)) (i32.const 16))
    (i32.shr_s (i32.shl ${g(16).src} (i32.const 16)) (i32.const 16))))
  (call $rset16 (i32.const 2) (i32.shr_u (local.get $t7) (i32.const 16)))
  (call $rset16 (i32.const 0) (local.get $t7))
  (call $flags_mul (i32.ne
    (i32.shr_s (i32.shl (local.get $t7) (i32.const 16)) (i32.const 16)) (local.get $t7)))
`);
  }

  // The 186's three-operand IMUL: a named destination instead of DX:AX, and an
  // immediate second factor. It is how a compiler indexes an array of structs,
  // so it turns up in the middle of the demos' inner loops rather than in their
  // startup. Only CF and OF are defined -- set when the full product does not
  // fit back into the destination width.
  for (const w of [16, 32]) {
    const SX = (e) => w === 32 ? e : `(i32.shr_s (i32.shl ${e} (i32.const 16)) (i32.const 16))`;
    const FITS = w === 32
      // At 32 bits the product needs 64 to test, so this is the one place the
      // check cannot be done in i32.
      ? `(i64.ne (i64.extend_i32_s (i32.wrap_i64 (local.get $q))) (local.get $q))`
      : `(i32.ne ${SX('(local.get $t7)')} (local.get $t7))`;
    const MUL = (a, b) => w === 32
      ? `(local.set $q (i64.mul (i64.extend_i32_s ${a}) (i64.extend_i32_s ${b})))
         (local.set $t7 (i32.wrap_i64 (local.get $q)))`
      : `(local.set $t7 (i32.mul ${SX(a)} ${SX(b)}))`;
    h(`imul3_rr${w}`, 2, `
  ${ops(2)}
  ${MUL(`(call $rget${w} (i32.and (local.get $t0) (i32.const 7)))`, '(local.get $t1)')}
  (call $rset${w} (i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 7))
    (local.get $t7))
  (call $flags_mul ${FITS})
`);
    h(`imul3_rm${w}`, 3, `
  ${ops(3)}
  ${EA_SETUP_PRE}
  ${MUL(`(call $rd${w} (local.get $t5) (local.get $t4))`, '(local.get $t2)')}
  (call $rset${w} (local.get $t6) (local.get $t7))
  (call $flags_mul ${FITS})
`);
    // The 0F AF two-operand form: destination *= source, both registers or a
    // register and memory. Same product and the same flag rule as the
    // three-operand one, only the second factor comes from the destination.
    h(`imul2_rr${w}`, 1, `
  ${ops(1)}
  ${MUL(`(call $rget${w} (i32.and (local.get $t0) (i32.const 7)))`,
        `(call $rget${w} (i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 7)))`)}
  (call $rset${w} (i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 7))
    (local.get $t7))
  (call $flags_mul ${FITS})
`);
    h(`imul2_rm${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  ${MUL(`(call $rd${w} (local.get $t5) (local.get $t4))`,
        `(call $rget${w} (local.get $t6))`)}
  (call $rset${w} (local.get $t6) (local.get $t7))
  (call $flags_mul ${FITS})
`);
  }

  // DIV/IDIV fault to INT 0 on a zero divisor or a quotient that will not fit.
  // The vector is taken the same way INT does, so the last operand carries the
  // guest IP to push.
  for (const nm of ['div', 'idiv']) for (const form of ['r', 'm']) for (const w of [8, 16]) {
    const signed = nm[0] === 'i';
    const g = SRC[form](w);
    // $t4..$t6 belong to the EA setup in the memory form, so the arithmetic
    // uses $t7 (divisor) and $t3 (quotient) in both. The IP operand is the last
    // one loaded, which is $t1 for a register source and $t2 for a memory one.
    const ip = `(local.get ${form === 'r' ? '$t1' : '$t2'})`;
    const argc = g.argc + 1;
    const sxD = w === 8
      ? '(i32.shr_s (i32.shl (local.get $t7) (i32.const 24)) (i32.const 24))'
      : '(i32.shr_s (i32.shl (local.get $t7) (i32.const 16)) (i32.const 16))';
    // The dividend always comes through the 16-bit accessors: a 386-era guest
    // can have something live in the top half of EAX/EDX, and reading the raw
    // global would fold it into the numerator.
    const num = w === 8
      ? (signed ? '(i32.shr_s (i32.shl (call $rget16 (i32.const 0)) (i32.const 16)) (i32.const 16))'
                : '(call $rget16 (i32.const 0))')
      : '(local.get $t0)';
    const div = signed ? 'i32.div_s' : 'i32.div_u';
    const rem = signed ? 'i32.rem_s' : 'i32.rem_u';
    const dvs = signed ? sxD : '(local.get $t7)';
    const lim = w === 8
      ? (signed ? '(i32.or (i32.gt_s (local.get $t3) (i32.const 127)) (i32.lt_s (local.get $t3) (i32.const -128)))'
                : '(i32.gt_u (local.get $t3) (i32.const 255))')
      : (signed ? '(i32.or (i32.gt_s (local.get $t3) (i32.const 32767)) (i32.lt_s (local.get $t3) (i32.const -32768)))'
                : '(i32.gt_u (local.get $t3) (i32.const 65535))');
    const store = w === 8 ? `
  (call $rset16 (i32.const 0) (i32.or (i32.and (local.get $t3) (i32.const 0xFF))
    (i32.shl (i32.and (${rem} ${num} ${dvs}) (i32.const 0xFF)) (i32.const 8))))`
      : `
  (call $rset16 (i32.const 2) (${rem} ${num} ${dvs}))
  (call $rset16 (i32.const 0) (local.get $t3))`;

    h(`${nm}_${form}${w}`, argc, `
  ${ops(argc)}
  ${g.pre}
  (local.set $t7 ${g.src})
  (if (i32.eqz (local.get $t7)) (then (call $fault0 ${ip}) (return)))
  ${w === 16 ? `(local.set $t0 (i32.or (i32.shl (call $rget16 (i32.const 2)) (i32.const 16))
                                       (call $rget16 (i32.const 0))))` : ''}
  (local.set $t3 (${div} ${num} ${dvs}))
  (if ${lim} (then (call $fault0 ${ip}) (return)))
  ${store}
`);
  }

  // 32-bit multiply and divide need 64 bits of product, so these are the only
  // handlers in the whole VM that touch i64. Everything else stays in i32
  // deliberately: a 64-bit local is not free on every engine, and the point of
  // the exercise is to compare dispatch, not to benchmark i64 lowering.
  for (const form of ['r', 'm']) {
    const g = SRC[form](32);
    const ip = `(local.get ${form === 'r' ? '$t1' : '$t2'})`;
    for (const signed of [false, true]) {
      const ext = signed ? 'i64.extend_i32_s' : 'i64.extend_i32_u';
      h(`${signed ? 'imul' : 'mul'}_${form}32`, g.argc, `
  ${ops(g.argc)}
  ${g.pre}
  (local.set $q (i64.mul (${ext} (global.get $ax)) (${ext} ${g.src})))
  (global.set $ax (i32.wrap_i64 (local.get $q)))
  (global.set $dx (i32.wrap_i64 (i64.shr_u (local.get $q) (i64.const 32))))
  (call $flags_mul ${signed
    ? `(i64.ne (i64.extend_i32_s (global.get $ax)) (local.get $q))`
    : `(global.get $dx)`})
`);
      const div = signed ? 'i64.div_s' : 'i64.div_u';
      const rem = signed ? 'i64.rem_s' : 'i64.rem_u';
      h(`${signed ? 'idiv' : 'div'}_${form}32`, g.argc + 1, `
  ${ops(g.argc + 1)}
  ${g.pre}
  (local.set $t7 ${g.src})
  (if (i32.eqz (local.get $t7)) (then (call $fault0 ${ip}) (return)))
  (local.set $q (i64.or (i64.shl (i64.extend_i32_u (global.get $dx)) (i64.const 32))
                        (i64.extend_i32_u (global.get $ax))))
  (local.set $d (${ext} (local.get $t7)))
  (local.set $r (${div} (local.get $q) (local.get $d)))
  (if ${signed
    ? `(i64.ne (i64.extend_i32_s (i32.wrap_i64 (local.get $r))) (local.get $r))`
    : `(i64.ne (i64.shr_u (local.get $r) (i64.const 32)) (i64.const 0))`}
    (then (call $fault0 ${ip}) (return)))
  (global.set $dx (i32.wrap_i64 (${rem} (local.get $q) (local.get $d))))
  (global.set $ax (i32.wrap_i64 (local.get $r)))
`);
    }
  }

  // Port I/O. Demos reach the VGA palette through 0x3C8/0x3C9 and wait on the
  // retrace bit of 0x3DA, so these must exist even though nothing here is a
  // real peripheral -- tools/toyvm/dos.js models the few ports that matter.
  for (const w of [8, 16]) {
    h(`in_${w}`, 1, `
  ${ops(1)}
  (call $rset${w} (i32.const 0)
    (call $port_in (select (call $rget16 (i32.const 2)) (local.get $t0)
                           (i32.eq (local.get $t0) (i32.const -1)))
                   (i32.const ${w})))
`);
    h(`out_${w}`, 1, `
  ${ops(1)}
  (call $port_out (select (call $rget16 (i32.const 2)) (local.get $t0)
                          (i32.eq (local.get $t0) (i32.const -1)))
                  (call $rget${w} (i32.const 0)) (i32.const ${w}))
`);
  }

  h('xlat', 1, `
  ${ops(1)}
  (call $rset8 (i32.const 0)
    (call $rd8 (local.get $t0)
      (i32.and (i32.add (call $rget16 (i32.const 3)) (call $rget8 (i32.const 0)))
               (i32.const 0xFFFF))))
`);

  // XLAT with a 32-bit address size: the table is at EBX and the offset does
  // not wrap at 64KB. A palette-remap loop in a flat segment is exactly this
  // instruction, and refusing it stopped ACME-SYW.EXE the moment it started
  // drawing.
  h('xlat32', 1, `
  ${ops(1)}
  (call $rset8 (i32.const 0)
    (call $rd8 (local.get $t0)
      (i32.add (call $rget32 (i32.const 3)) (call $rget8 (i32.const 0)))))
`);

  // BSWAP (486): reverse the four bytes of a 32-bit register. CTSLASSE.EXE
  // uses it inside its 32-bit code, so the decoder refusing it stopped the
  // demo at the first instruction of a routine, not at a rare corner.
  h('bswap32', 1, `
  ${ops(1)}
  (local.set $t1 (call $rget32 (local.get $t0)))
  (call $rset32 (local.get $t0) (i32.or (i32.or
    (i32.shl (i32.and (local.get $t1) (i32.const 0xFF)) (i32.const 24))
    (i32.shl (i32.and (local.get $t1) (i32.const 0xFF00)) (i32.const 8)))
    (i32.or
      (i32.and (i32.shr_u (local.get $t1) (i32.const 8)) (i32.const 0xFF00))
      (i32.shr_u (local.get $t1) (i32.const 24)))))
`);

  // MOV to/from a direct address (A0-A3). Common enough in tight code that it
  // gets its own handlers rather than going through the ModRM path.
  for (const w of [8, 16, 32]) {
    h(`mov_acc_moffs${w}`, 2, `
  ${ops(2)}
  (call $rset${w} (i32.const 0) (call $rd${w} (local.get $t1) (local.get $t0)))
`);
    h(`mov_moffs_acc${w}`, 2, `
  ${ops(2)}
  (call $wr${w} (local.get $t1) (local.get $t0) (call $rget${w} (i32.const 0)))
`);
  }

  // Resolve $gip against the block cache and keep running if it is there.
  //
  // $jlook keys on the offset AND the selector, and it reads the selector live,
  // so it is safe for a transfer that has just changed CS: the far forms below
  // set CS before they get here, and the lookup is then asking the question
  // they actually want asked -- "is THIS cs:ip compiled" -- rather than the
  // near forms' "is this offset compiled". That is why they can share it.
  // ...but never across a pending self-patch. $wr8 sets $smc=2 for a store into
  // a byte something has already compiled and does NOT stop the slice; it
  // leaves the regions standing and lets the host throw them away at the next
  // handback, on the stated grounds that a packed program reaches its unpacked
  // entry through a far jump and so hands back there anyway. That was true
  // while every far transfer left wasm. Resolve one through the cache with
  // $smc still up and the depacker jumps straight into the block compiled from
  // its own ciphertext -- ACCIDENT.EXE stopped at 1bb5:4b2b with a black
  // screen and one of its two data files opened, and nothing in the run named
  // a decoder or a store as the cause. So the guard is part of the lookup, not
  // part of any one handler: any dirty byte this slice, take the handback.
  const GO_INDIRECT = `
  (local.set $t3 (select (i32.const 0) (call $jlook (global.get $gip))
                         (global.get $smc)))
  (if ${CONT('(local.get $t3)')}
    (then (global.set $ip (local.get $t3)))
    (else (global.set $left (global.get $steps)) (global.set $halt (i32.const 1))))`;

  // Far transfers and indirect jumps. All of them land on an address that is
  // data, so all of them leave the trace.
  //
  // ...leave the TRACE, which is not the same as leaving wasm, and every far
  // form here used to do both. A far transfer is one guest instruction and it
  // was costing a JS round trip every time, however many times the program had
  // already been through it: DTM2.EXE re-entered 8 addresses 576,000 times
  // between them, spent 65% of its wall clock outside wasm doing it, and the
  // entry census said `jt=hit` on all 8 -- the target was compiled and sitting
  // in the table the whole time, and nothing asked. Segmented code reaches for
  // far calls constantly (overlays, a Turbo runtime's inter-unit calls), so
  // this is not an exotic path, it is the ordinary one for a large real-mode
  // program.
  // The last operand is the guest address the immediates were decoded from, and
  // they are read again from there rather than used as decoded. See the 0xEA
  // comment in decode.js: a depacker patches the selector of its own exit jump
  // in the same block that executes it, so the decoded value is the stale one.
  h('jmp_far', 3, `
  ${ops(3)}
  (local.set $t0 (call $rd16 (i32.const 1) (local.get $t2)))
  (local.set $t1 (call $rd16 (i32.const 1) (i32.add (local.get $t2) (i32.const 2))))
  (call $sset (i32.const 1) (local.get $t1))
  (global.set $gip (local.get $t0))
  ${GO_INDIRECT}
`);
  h('call_far', 4, `
  ${ops(4)}
  (local.set $t0 (call $rd16 (i32.const 1) (local.get $t3)))
  (local.set $t1 (call $rd16 (i32.const 1) (i32.add (local.get $t3) (i32.const 2))))
  (call $push16 (call $sget (i32.const 1)))
  (call $push16 (local.get $t2))
  (call $sset (i32.const 1) (local.get $t1))
  (global.set $gip (local.get $t0))
  ${GO_INDIRECT}
`);
  h('retf', 0, `
  (global.set $gip (call $pop16))
  (call $sset (i32.const 1) (call $pop16))
  ${GO_INDIRECT}
`);
  h('retf_imm', 1, `
  ${ops(1)}
  (global.set $gip (call $pop16))
  (call $sset (i32.const 1) (call $pop16))
  (global.set $sp (i32.and (i32.add (global.get $sp) (local.get $t0)) (global.get $spm)))
  ${GO_INDIRECT}
`);
  // The operand-size-32 far transfers. These are how a DOS extender enters and
  // leaves its 32-bit world, and until they existed the 66-prefixed forms were
  // decoded as their 16-bit twins, which is silently catastrophic rather than
  // merely wrong: `66 68 08 00 00 00 / 66 57 / 66 cb` pushes selector 8 and
  // EDI as dwords and returns to 0008:00000228, but popping words off that
  // frame yields 0000:0228 -- a null selector -- and COLORS.EXE went on to
  // execute 200M dispatches of whatever it found there. The offset is a full
  // 32 bits; the selector is still 16, occupying the low half of its dword.
  h('retf32', 0, `
  (global.set $gip (call $pop32))
  (call $sset (i32.const 1) (i32.and (call $pop32) (i32.const 0xFFFF)))
  ${GO_INDIRECT}
`);
  h('retf_imm32', 1, `
  ${ops(1)}
  (global.set $gip (call $pop32))
  (call $sset (i32.const 1) (i32.and (call $pop32) (i32.const 0xFFFF)))
  (global.set $sp (i32.and (i32.add (global.get $sp) (local.get $t0)) (global.get $spm)))
  ${GO_INDIRECT}
`);
  h('jmp_far32', 3, `
  ${ops(3)}
  (local.set $t0 (call $rd32 (i32.const 1) (local.get $t2)))
  (local.set $t1 (call $rd16 (i32.const 1) (i32.add (local.get $t2) (i32.const 4))))
  (call $sset (i32.const 1) (local.get $t1))
  (global.set $gip (local.get $t0))
  (global.set $left (global.get $steps)) (global.set $halt (i32.const 1))
`);
  h('call_far32', 4, `
  ${ops(4)}
  (local.set $t0 (call $rd32 (i32.const 1) (local.get $t3)))
  (local.set $t1 (call $rd16 (i32.const 1) (i32.add (local.get $t3) (i32.const 4))))
  (call $push32 (call $sget (i32.const 1)))
  (call $push32 (local.get $t2))
  (call $sset (i32.const 1) (local.get $t1))
  (global.set $gip (local.get $t0))
  (global.set $left (global.get $steps)) (global.set $halt (i32.const 1))
`);
  // The target is a runtime value, so it is looked up in the jump-target cache
  // rather than baked in. A miss hands back exactly as before; a hit keeps a
  // computed jump inside wasm, which is what mars.exe's unrolled span writer is
  // entered through several hundred thousand times a frame.
  h('jmp_r16', 1, `
  ${ops(1)}
  (global.set $gip (call $rget16 (local.get $t0)))
  ${GO_INDIRECT}
`);
  h('jmp_m16', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (global.set $gip (call $rd16 (local.get $t5) (local.get $t4)))
  ${GO_INDIRECT}
`);
  // The operand is read BEFORE the return address is pushed. `call sp` is the
  // case that proves it: the real part jumps to the SP the instruction started
  // with, not the decremented one.
  h('call_r16', 3, `
  ${ops(3)}
  (local.set $t7 (call $rget16 (local.get $t0)))
  (call $push16 (local.get $t1))
  (call $rpush (local.get $t1) (local.get $t2))
  (global.set $gip (local.get $t7))
  ${GO_INDIRECT}
`);
  h('call_m16', 4, `
  ${ops(4)}
  ${EA_SETUP_PRE}
  (local.set $t7 (call $rd16 (local.get $t5) (local.get $t4)))
  (call $push16 (local.get $t2))
  (call $rpush (local.get $t2) (local.get $t3))
  (global.set $gip (local.get $t7))
  ${GO_INDIRECT}
`);
  // FF /4 and FF /2 with a 32-bit operand size. A jump table in a flat segment
  // holds dwords, and reading it as words is how a 32-bit indirect jump lands
  // in the first 64KB of the program every time.
  h('jmp_r32', 1, `
  ${ops(1)}
  (global.set $gip (call $rget32 (local.get $t0)))
  ${GO_INDIRECT}
`);
  h('jmp_m32', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (global.set $gip (call $rd32 (local.get $t5) (local.get $t4)))
  ${GO_INDIRECT}
`);
  h('call_r32', 3, `
  ${ops(3)}
  (local.set $t7 (call $rget32 (local.get $t0)))
  (call $push32 (local.get $t1))
  (call $rpush (local.get $t1) (local.get $t2))
  (global.set $gip (local.get $t7))
  ${GO_INDIRECT}
`);
  h('call_m32', 4, `
  ${ops(4)}
  ${EA_SETUP_PRE}
  (local.set $t7 (call $rd32 (local.get $t5) (local.get $t4)))
  (call $push32 (local.get $t2))
  (call $rpush (local.get $t2) (local.get $t3))
  (global.set $gip (local.get $t7))
  ${GO_INDIRECT}
`);

  // FF /5 and FF /3: far JMP and far CALL through a memory operand. Between
  // them these are the single biggest coverage gap in the demo corpus -- the
  // `2e ff 2f` (jmp far [cs:bx]) and `26 ff 19` (call far [es:bx+di]) startup
  // thunks that Turbo-era runtimes open with.
  h('jmp_far_m', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (local.set $t7 (call $rd16 (local.get $t5) (local.get $t4)))
  (call $sset (i32.const 1) (call $rd16 (local.get $t5)
    (call $off_add (local.get $t4) (i32.const 2))))
  (global.set $gip (local.get $t7))
  ${GO_INDIRECT}
`);
  // The far return address is CS:IP of the next instruction. There is no
  // shadow-stack entry: a far RET can land in a different segment, and the
  // arena address alone would not say which.
  h('call_far_m', 3, `
  ${ops(3)}
  ${EA_SETUP_PRE}
  (local.set $t7 (call $rd16 (local.get $t5) (local.get $t4)))
  (local.set $t3 (call $rd16 (local.get $t5)
    (call $off_add (local.get $t4) (i32.const 2))))
  (call $push16 (call $sget (i32.const 1)))
  (call $push16 (local.get $t2))
  (call $sset (i32.const 1) (local.get $t3))
  (global.set $gip (local.get $t7))
  ${GO_INDIRECT}
`);

  // The operand-size-32 twins: `66 ff /5` and `66 ff /3` read a 48-bit far
  // pointer -- a dword offset and then the selector at +4, not +2.
  //
  // A 16-bit read of one of those is not a wrong address, it is a wrong
  // SELECTOR: the word at +2 is the high half of the offset, which for any
  // 16-bit target is zero, so the jump goes through the null selector. That is
  // how COUNTDWN.EXE's extender derailed -- its protected-mode INT 21h
  // dispatcher passes an unhandled AH through with `66 2e ff 2e de 03`, and we
  // read cs:[0x3de] as 0x0196:0x0000 instead of 0x0196 in its real segment.
  //
  // The selector's own address goes through $off_add and not a bare
  // `& 0xFFFF`, which is a second, independent way to read the wrong selector.
  // A 0x67 prefix makes the effective address 32-bit, and masking the +4 to 16
  // bits then folds it back into the first 64K: INTRO.EXE calls far through
  // [0x28da4], we truncated 0x28da8 to 0x8da8, and the word that happened to
  // sit there was 0x0002. Selector 2 has base 0, so protected mode carried on
  // running for another handback or two before dying at 2:1a43 -- far enough
  // from the transfer to look like anything but a bad far pointer. $off_add
  // wraps the low 16 bits and keeps the high half, which is what the address
  // arithmetic does everywhere else.
  h('jmp_far_m32', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (local.set $t7 (call $rd32 (local.get $t5) (local.get $t4)))
  (call $sset (i32.const 1) (call $rd16 (local.get $t5)
    (call $off_add (local.get $t4) (i32.const 4))))
  (global.set $gip (local.get $t7))
  ${GO_INDIRECT}
`);
  h('call_far_m32', 3, `
  ${ops(3)}
  ${EA_SETUP_PRE}
  (local.set $t7 (call $rd32 (local.get $t5) (local.get $t4)))
  (local.set $t3 (call $rd16 (local.get $t5)
    (call $off_add (local.get $t4) (i32.const 4))))
  (call $push32 (call $sget (i32.const 1)))
  (call $push32 (local.get $t2))
  (call $sset (i32.const 1) (local.get $t3))
  (global.set $gip (local.get $t7))
  ${GO_INDIRECT}
`);

  // ENTER/LEAVE, the 186's stack-frame pair. Every C compiler of the era emits
  // them, so three of the demos stop at the first `c8 xx xx 00` in their
  // startup. The nesting level is almost always zero; the display-copy loop is
  // here anyway because a Pascal-style nested procedure does use it.
  h('enter', 2, `
  ${ops(2)}
  (call $push16 (call $rget16 (i32.const 5)))
  (local.set $t7 (global.get $sp))
  (local.set $t1 (i32.and (local.get $t1) (i32.const 31)))
  (block $done (loop $l
    (br_if $done (i32.le_u (local.get $t1) (i32.const 1)))
    (call $rset16 (i32.const 5)
      (i32.and (i32.sub (call $rget16 (i32.const 5)) (i32.const 2)) (i32.const 0xFFFF)))
    (call $push16 (call $rd16 (i32.const 2) (call $rget16 (i32.const 5))))
    (local.set $t1 (i32.sub (local.get $t1) (i32.const 1)))
    (br $l)))
  (if (local.get $t1) (then (call $push16 (local.get $t7))))
  (call $rset16 (i32.const 5) (local.get $t7))
  (global.set $sp (i32.and (i32.sub (local.get $t7) (local.get $t0)) (i32.const 0xFFFF)))
`);
  h('leave', 0, `
  (global.set $sp (call $rget16 (i32.const 5)))
  (call $rset16 (i32.const 5) (call $pop16))
`);
  // LEAVE with a 32-bit operand size: ESP := EBP, then pop EBP as a dword.
  // Every Watcom-compiled function in a protected-mode demo ends with this.
  h('leave32', 0, `
  (global.set $sp (call $rget32 (i32.const 5)))
  (call $rset32 (i32.const 5) (call $pop32))
`);
  h('enter32', 2, `
  ${ops(2)}
  (call $push32 (call $rget32 (i32.const 5)))
  (local.set $t7 (global.get $sp))
  (local.set $t1 (i32.and (local.get $t1) (i32.const 31)))
  (block $done (loop $l
    (br_if $done (i32.le_u (local.get $t1) (i32.const 1)))
    (call $rset32 (i32.const 5) (i32.sub (call $rget32 (i32.const 5)) (i32.const 4)))
    (call $push32 (call $rd32 (i32.const 2) (call $rget32 (i32.const 5))))
    (local.set $t1 (i32.sub (local.get $t1) (i32.const 1)))
    (br $l)))
  (if (local.get $t1) (then (call $push32 (local.get $t7))))
  (call $rset32 (i32.const 5) (local.get $t7))
  (global.set $sp (i32.and (i32.sub (local.get $t7) (local.get $t0)) (global.get $spm)))
`);

  // PUSHA/POPA and their 32-bit twins. PUSHA stores the SP the instruction
  // started with, and POPA discards that slot rather than restoring it --
  // popping into SP would move the stack out from under the remaining pops.
  for (const w of [16, 32]) {
    const push = w === 16 ? '$push16' : '$push32';
    const pop = w === 16 ? '$pop16' : '$pop32';
    const rset = `$rset${w}`, rget = `$rget${w}`;
    h(`pusha${w}`, 0, `
  (local.set $t7 (call ${rget} (i32.const 4)))
  ${[0, 1, 2, 3].map(r => `(call ${push} (call ${rget} (i32.const ${r})))`).join('\n  ')}
  (call ${push} (local.get $t7))
  ${[5, 6, 7].map(r => `(call ${push} (call ${rget} (i32.const ${r})))`).join('\n  ')}
`);
    h(`popa${w}`, 0, `
  ${[7, 6, 5].map(r => `(call ${rset} (i32.const ${r}) (call ${pop}))`).join('\n  ')}
  (drop (call ${pop}))
  ${[3, 2, 1, 0].map(r => `(call ${rset} (i32.const ${r}) (call ${pop}))`).join('\n  ')}
`);
  }

  // LES/LDS load a far pointer into a segment register and a GPR at once.
  for (const [nm, seg] of [['les', 0], ['lds', 3], ['lfs', 4], ['lgs', 5]]) {
    h(nm, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $rset16 (local.get $t6) (call $rd16 (local.get $t5) (local.get $t4)))
  (call $sset (i32.const ${seg}) (call $rd16 (local.get $t5)
    (call $off_add (local.get $t4) (i32.const 2))))
`);
  }
}

// The generators run once here at require time and again, in the same order,
// from buildHandlers() when an arm asks for the other flag scheme. Order IS the
// handler index, so this list and the one in buildHandlers() are the same list.
genTerminators();
genAlu();
genMov();
genBranches();
genExtras();
// --- 80186 string I/O -------------------------------------------------------
// REP OUTSB is how a demo uploads a 768-byte VGA palette in one instruction, so
// this is not an exotic corner: it is the first thing mars.exe does after
// setting the mode.
function gen186StringIO() {
  const DELTA = (sz) => `(select (i32.const ${-sz}) (i32.const ${sz}) ${bit(F.DF)})`;

  // Generated on both axes, exactly like the other string ops: address size
  // decides which register indexes the string and how wide the counter is,
  // data size decides how much moves per port access. The 32-bit address form
  // is not exotic -- a Watcom-compiled demo runs in a flat segment where ESI
  // is the only pointer there is, and `rep outsb` through it is still how the
  // palette gets uploaded. Refusing it stopped BRW.EXE dead at the first
  // palette write, one instruction into its own code.
  const forAsize = (a) => {
    const g = a === 32 ? '$rget32' : '$rget16';
    const st = a === 32 ? '$rset32' : '$rset16';
    const idx = (reg) => `(call ${g} (i32.const ${{ si: 6, di: 7 }[reg]}))`;
    // In 16-bit addressing the upper half of ESI/EDI must survive, which is
    // what $rset16 does -- it merges rather than replaces.
    const bump = (reg, sz) =>
      `(call ${st} (i32.const ${{ si: 6, di: 7 }[reg]}) (i32.add ${idx(reg)} ${DELTA(sz)}))`;
    const asfx = a === 32 ? '32' : '';
    const count = a === 32 ? '$ecx32' : '$cx16';
    const dec = a === 32 ? '$ecxdec' : '$cxdec';

    for (const w of [8, 16, 32]) {
      const sz = w >> 3, sfx = { 8: 'b', 16: 'w', 32: 'd' }[w];
      const BODY = {
        [`outs${sfx}${asfx}`]: `
    (call $port_out (call $rget16 (i32.const 2))
      (call $rd${w} (local.get $t0) ${idx('si')}) (i32.const ${w}))
    ${bump('si', sz)}`,
        [`ins${sfx}${asfx}`]: `
    (call $wr${w} (i32.const 0) ${idx('di')}
      (call $port_in (call $rget16 (i32.const 2)) (i32.const ${w})))
    ${bump('di', sz)}`,
      };
      for (const [name, body] of Object.entries(BODY)) {
        h(name, 1, `
  ${ops(1)}
  ${body}
`);
        h(`rep_${name}`, 1, `
  ${ops(1)}
  (block $done
    (loop $l
      (br_if $done (i32.eqz (call ${count})))
      ${body}
      (drop (call ${dec}))
      (global.set $steps (i32.sub (global.get $steps) (i32.const 1)))
      (br $l)))
`);
      }
    }
  };
  forAsize(16);
  forAsize(32);
}

// --- 80386 additions --------------------------------------------------------
// Not part of the 8088 gate -- the corpus cannot check these -- but a demo that
// says "386 or better" on the tin uses them, and SETcc in particular turns up
// in the inner loop of anything doing per-pixel comparisons.
function gen386() {
  for (const [cc, expr] of Object.entries(CONDS)) {
    h(`set_${cc}_r8`, 1, `
  ${ops(1)}
  (call $rset8 (local.get $t0) ${expr})
`);
    h(`set_${cc}_m8`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $wr8 (local.get $t5) (local.get $t4) ${expr})
`);
  }

  // MOVZX/MOVSX, both destination widths and both source widths. The
  // destination width comes from the operand-size prefix, the source width from
  // the opcode -- which is why there are four of each.
  const EXT = {
    movzx: { 8: (v) => v, 16: (v) => v },
    movsx: {
      8: (v) => `(i32.shr_s (i32.shl ${v} (i32.const 24)) (i32.const 24))`,
      16: (v) => `(i32.shr_s (i32.shl ${v} (i32.const 16)) (i32.const 16))`,
    },
  };
  for (const [nm, byWidth] of Object.entries(EXT)) {
    for (const sw of [8, 16]) for (const dw of [16, 32]) {
      const ext = byWidth[sw];
      h(`${nm}${sw}_rr${dw}`, 1, `
  ${ops(1)}
  (call $rset${dw} (i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 7))
    ${ext(`(call $rget${sw} (i32.and (local.get $t0) (i32.const 15)))`)})
`);
      h(`${nm}${sw}_rm${dw}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $rset${dw} (local.get $t6) ${ext(`(call $rd${sw} (local.get $t5) (local.get $t4))`)})
`);
    }
  }

  // SMSW, and reading a control register. This machine has exactly one CR0
  // value -- real mode, no coprocessor -- and never leaves it, because nothing
  // WRITES a control register: LMSW, MOV CR,r and LGDT/LIDT stay unimplemented,
  // so a program that genuinely tries to switch mode is reported as blocked
  // rather than quietly run in the wrong one. Reading is a different matter:
  // nine corpus programs open with `smsw ax` / `test al,1` to check they are
  // not already inside a V86 monitor, and the answer to that is no.
  h('smsw_r16', 1, `
  ${ops(1)}
  (call $rset16 (local.get $t0) (global.get $cr0))
`);
  h('smsw_m16', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $wr16 (local.get $t5) (local.get $t4) (global.get $cr0))
`);
  // MOV r32, CRn. Only CR0 has a value; CR2 (the page-fault address) and CR3
  // (the page directory) are zero on a machine that has never paged.
  h('mov_r_cr', 1, `
  ${ops(1)}
  (call $rset32 (i32.and (local.get $t0) (i32.const 7))
    (select (global.get $cr0) (i32.const 0)
      (i32.eqz (i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 7)))))
`);

  // The segment limit out of the descriptor whose address is in $t7: twenty
  // bits split across bytes 0-1 and the low nibble of byte 6, scaled by a page
  // when the granularity bit above them is set. The low twelve bits read back
  // as 1s in that case, which is why a 4GB segment reports 0xFFFFFFFF.
  const GRAN = '(i32.and (i32.load8_u offset=6 (local.get $t7)) (i32.const 0x80))';
  const LSL_LIMIT = `(i32.or
    (i32.shl (i32.or (i32.load16_u (local.get $t7))
                     (i32.shl (i32.and (i32.load8_u offset=6 (local.get $t7))
                                       (i32.const 0x0F))
                              (i32.const 16)))
             (select (i32.const 12) (i32.const 0) ${GRAN}))
    (select (i32.const 0xFFF) (i32.const 0) ${GRAN}))`;

  // Group 6. LLDT is the only one that changes anything: it names a GDT
  // descriptor whose base is where the LDT lives, and a selector with the
  // table-indicator bit set is resolved through that instead. LTR and the
  // VERR/VERW pair are accepted and inert -- there is no task switching here,
  // and every descriptor this machine builds is readable and writable, so the
  // access checks can only ever succeed.
  for (const [nm, body] of [
    ['sldt', '(call $rset16 %R% (global.get $ldt))'],
    ['str', '(call $rset16 %R% (global.get $tr))'],
    ['lldt', '(global.set $ldt %V%) (global.set $ldtb (call $gdtbase %V%))'],
    ['ltr', '(global.set $tr %V%)'],
    ['verr', `(call $flags_put (i32.or (call $flags_word) (i32.const ${1 << F.ZF})))`],
    ['verw', `(call $flags_put (i32.or (call $flags_word) (i32.const ${1 << F.ZF})))`],
  ]) {
    const store = nm === 'sldt' || nm === 'str';
    h(`${nm}_r`, 1, `
  ${ops(1)}
  ${body.replace(/%R%/g, '(local.get $t0)')
    .replace(/%V%/g, '(call $rget16 (local.get $t0))')}
`);
    h(`${nm}_m`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  ${store
    ? `(call $wr16 (local.get $t5) (local.get $t4) (global.get $${nm === 'str' ? 'tr' : 'ldt'}))`
    : body.replace(/%V%/g, '(call $rd16 (local.get $t5) (local.get $t4))')}
`);
  }

  // LAR and LSL: read the access rights, and the limit, out of the descriptor a
  // selector names. An extender runs these on the selectors DPMI just handed it
  // to find out what it got -- COUNTDWN.EXE does `mov dx,cs / lar ax,dx` two
  // instructions after its INT 31h -- and with them missing the decoder gives
  // up in the middle of the extender's own setup.
  //
  // Both set ZF when the selector is usable and leave the destination alone
  // when it is not, which is the same shape as BSF above and for the same
  // reason: real code reads the destination back only after testing ZF.
  for (const [nm, w, value] of [
    ['lar', 16, '(i32.and (local.get $t7) (i32.const 0x0000FF00))'],
    ['lar', 32, '(i32.and (local.get $t7) (i32.const 0x00FFFF00))'],
    // The limit is 20 bits split across the descriptor, and the granularity bit
    // scales it by a page -- with the low twelve bits reading back as 1s, which
    // is what makes a 4GB segment come out as 0xFFFFFFFF rather than 0xFFFFF000.
    ['lsl', 16, LSL_LIMIT],
    ['lsl', 32, LSL_LIMIT],
  ]) {
    // $t7 holds the second descriptor dword for LAR, the whole descriptor
    // address for LSL; $t3 holds the selector.
    const load = nm === 'lar'
      ? '(local.set $t7 (i32.load offset=4 (local.get $t7)))'
      : '';
    const body = (src, dst) => `
  (local.set $t3 ${src})
  (local.set $t7 (call $descaddr (local.get $t3)))
  (call $flags_put (i32.or
    (i32.and (call $flags_word) (i32.const ${(~(1 << F.ZF)) & 0xFFFF}))
    (i32.shl (i32.ne (local.get $t7) (i32.const 0)) (i32.const ${F.ZF}))))
  (if (local.get $t7) (then
    (local.set $t7 (i32.sub (local.get $t7) (i32.const 1)))
    ${load}
    (call $rset${w} ${dst} ${value})))
`;
    h(`${nm}_rr${w}`, 1, `
  ${ops(1)}
  ${body('(call $rget16 (i32.and (local.get $t0) (i32.const 7)))',
    '(i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 7))')}
`);
    h(`${nm}_rm${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  ${body('(call $rd16 (local.get $t5) (local.get $t4))', '(local.get $t6)')}
`);
  }

  // LMSW: the 286's half of the same switch, still emitted by extenders that
  // want to boot on one. It writes the low four bits of CR0 and cannot clear
  // PE -- once protected, a 286 stays protected, and no demo here tries.
  h('lmsw_r16', 1, `
  ${ops(1)}
  (global.set $cr0 (i32.or (global.get $cr0)
    (i32.and (call $rget16 (local.get $t0)) (i32.const 0xF))))
`);
  h('lmsw_m16', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (global.set $cr0 (i32.or (global.get $cr0)
    (i32.and (call $rd16 (local.get $t5) (local.get $t4)) (i32.const 0xF))))
`);

  // MOV CRn, r32 -- the mode switch itself. Only CR0 is kept; a write to CR2 or
  // CR3 is a paging setup this machine has nothing to page with, and is
  // dropped rather than refused because the extenders that write them do so
  // unconditionally on their way past.
  //
  // Setting PE does NOT reload any segment register, and that is not an
  // omission: a real 386 keeps running on the descriptors already cached in
  // the segment registers until something reloads them, which is exactly what
  // the cached $__b bases here do. PMODE/W depends on it -- it builds 16-bit
  // descriptors whose bases equal the real-mode segments it was just using, so
  // the instructions between MOV CR0 and the far jump address the same bytes
  // either side of the switch.
  h('mov_cr_r', 1, `
  ${ops(1)}
  (if (i32.eqz (i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 7)))
    (then (global.set $cr0 (call $rget32 (i32.and (local.get $t0) (i32.const 7))))))
`);

  // LGDT/LIDT. Six bytes: a 16-bit limit then a 32-bit base, of which a
  // 16-bit-operand form keeps only the low 24 -- the 386 loads the fourth byte
  // as zero there, and extenders rely on that to build a table pointer with a
  // word-sized instruction.
  for (const [nm, gb, gl] of [['lgdt', '$gdtb', '$gdtl'], ['lidt', '$idtb', '$idtl']]) {
    for (const w of [16, 32]) {
      h(`${nm}${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (global.set ${gl} (call $rd16 (local.get $t5) (local.get $t4)))
  (global.set ${gb} (i32.and
    (call $rd32 (local.get $t5) (i32.and (i32.add (local.get $t4) (i32.const 2))
                                         (i32.const 0xFFFF)))
    (i32.const ${w === 32 ? '0xFFFFFFFF' : '0xFFFFFF'})))
`);
      // The store side. Not a curiosity: SGDT is how a real-mode program asks
      // "is anything already in protected mode here" before it installs its own
      // extender, and STARPORT.COM stops at the first `0f 01 07` in its startup.
      // A 16-bit SGDT writes only the low 24 bits of the base and leaves the
      // fourth byte as the 386 does -- ones, not zeroes.
      h(`s${nm.slice(1)}${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $wr16 (local.get $t5) (local.get $t4) (global.get ${gl}))
  (call $wr32 (local.get $t5)
    (i32.and (i32.add (local.get $t4) (i32.const 2)) (i32.const 0xFFFF))
    (i32.or (i32.and (global.get ${gb}) (i32.const ${w === 32 ? '0xFFFFFFFF' : '0xFFFFFF'}))
            (i32.const ${w === 32 ? '0' : '0xFF000000'})))
`);
    }
  }

  // XADD (486): the destination gets dst+src and the source gets the OLD dst,
  // in that order. Reading both before writing either is the whole instruction
  // -- XADD AX,AX has to leave AX doubled, not squared.
  for (const w of [8, 16, 32]) {
    h(`xadd_rr${w}`, 1, `
  ${ops(1)}
  (local.set $t1 (i32.and (local.get $t0) (i32.const 7)))
  (local.set $t2 (i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 7)))
  (local.set $t3 (call $rget${w} (local.get $t1)))
  (local.set $t4 (call $rget${w} (local.get $t2)))
  (call $rset${w} (local.get $t2) (local.get $t3))
  (call $rset${w} (local.get $t1) (i32.add (local.get $t3) (local.get $t4)))
  ${ADD_FLAGS(w, '(local.get $t3)', '(local.get $t4)',
    `(i32.add (local.get $t3) (local.get $t4))`)}
`);
    h(`xadd_rm${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (local.set $t3 (call $rd${w} (local.get $t5) (local.get $t4)))
  (local.set $t7 (call $rget${w} (local.get $t6)))
  (call $rset${w} (local.get $t6) (local.get $t3))
  (call $wr${w} (local.get $t5) (local.get $t4) (i32.add (local.get $t3) (local.get $t7)))
  ${ADD_FLAGS(w, '(local.get $t3)', '(local.get $t7)',
    `(i32.add (local.get $t3) (local.get $t7))`)}
`);
  }

  // CMPXCHG (486). The accumulator is compared with the DESTINATION, and the
  // flags left behind are that compare's -- so ZF says which way the exchange
  // went and the instruction needs no second CMP after it. On a match the
  // source register lands in the destination; on a miss the destination lands
  // in the accumulator, which is what lets the retry loop around it converge.
  // Either way exactly one place is written.
  for (const w of [8, 16, 32]) {
    const acc = `(call $rget${w} (i32.const 0))`;
    h(`cmpxchg_rr${w}`, 1, `
  ${ops(1)}
  (local.set $t1 (i32.and (local.get $t0) (i32.const 7)))
  (local.set $t2 (i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 7)))
  (local.set $t3 (call $rget${w} (local.get $t1)))
  (local.set $t4 ${acc})
  ${CMP_FLAGS(w, '(local.get $t4)', '(local.get $t3)')}
  (if (i32.eq (local.get $t4) (local.get $t3))
    (then (call $rset${w} (local.get $t1) (call $rget${w} (local.get $t2))))
    (else (call $rset${w} (i32.const 0) (local.get $t3))))
`);
    h(`cmpxchg_rm${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (local.set $t3 (call $rd${w} (local.get $t5) (local.get $t4)))
  (local.set $t7 ${acc})
  ${CMP_FLAGS(w, '(local.get $t7)', '(local.get $t3)')}
  (if (i32.eq (local.get $t7) (local.get $t3))
    (then (call $wr${w} (local.get $t5) (local.get $t4)
            (call $rget${w} (local.get $t6))))
    (else (call $rset${w} (i32.const 0) (local.get $t3))))
`);
  }
}

// --- x87 handlers -----------------------------------------------------------
// The escape opcodes are extremely regular: six arithmetic operations across
// four memory formats and three register forms, then a long tail of one-off
// register instructions. Generating the regular part is what keeps the tail
// readable.
function genFpu() {
  // Memory sources, by the four formats the arithmetic takes. `pop` is the
  // integer forms' sign extension; the reals need none.
  const SRC_M = {
    m32: '(call $fmr32 (local.get $t5) (local.get $t4))',
    m64: '(call $fmr64 (local.get $t5) (local.get $t4))',
    mi16: `(f64.convert_i32_s (i32.shr_s (i32.shl
      (call $rd16 (local.get $t5) (local.get $t4)) (i32.const 16)) (i32.const 16)))`,
    mi32: '(f64.convert_i32_s (call $rd32 (local.get $t5) (local.get $t4)))',
  };
  // ST(0) is the left operand of the `_st0i` form and the RIGHT operand of the
  // `_sti0` form -- which is the whole reason FSUB and FSUBR both exist, and
  // the reason DC E0 is FSUBR while DE E0 is FSUBRP.
  const OPS = {
    fadd: (a, b) => `(f64.add ${a} ${b})`,
    fmul: (a, b) => `(f64.mul ${a} ${b})`,
    fsub: (a, b) => `(f64.sub ${a} ${b})`,
    fsubr: (a, b) => `(f64.sub ${b} ${a})`,
    fdiv: (a, b) => `(f64.div ${a} ${b})`,
    fdivr: (a, b) => `(f64.div ${b} ${a})`,
  };
  const ST0 = '(call $fst_get (i32.const 0))';
  const STI = '(call $fst_get (local.get $t0))';

  for (const [nm, f] of Object.entries(OPS)) {
    for (const [fmt, src] of Object.entries(SRC_M)) {
      h(`${nm}_${fmt}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $fst_set (i32.const 0) ${f(ST0, src)})
`);
    }
    // ST(0) = ST(0) op ST(i)
    h(`${nm}_st0i`, 1, `
  ${ops(1)}
  (call $fst_set (i32.const 0) ${f(ST0, STI)})
`);
    // ST(i) = ST(i) op ST(0), with and without the pop that follows it.
    for (const p of ['', 'p']) {
      h(`${nm}_sti0${p}`, 1, `
  ${ops(1)}
  (call $fst_set (local.get $t0) ${f(STI, ST0)})
  ${p ? '(call $fpop)' : ''}
`);
    }
  }

  // Loads and stores.
  for (const [fmt, ld] of Object.entries({
    m32: '(call $fmr32 (local.get $t5) (local.get $t4))',
    m64: '(call $fmr64 (local.get $t5) (local.get $t4))',
    m80: '(call $fmr80 (local.get $t5) (local.get $t4))',
    i16: `(f64.convert_i32_s (i32.shr_s (i32.shl
      (call $rd16 (local.get $t5) (local.get $t4)) (i32.const 16)) (i32.const 16)))`,
    i32: '(f64.convert_i32_s (call $rd32 (local.get $t5) (local.get $t4)))',
    i64: `(f64.convert_i64_s (i64.or
      (i64.extend_i32_u (call $rd32 (local.get $t5) (local.get $t4)))
      (i64.shl (i64.extend_i32_u (call $rd32 (local.get $t5)
        (call $off_add (local.get $t4) (i32.const 4)))) (i64.const 32))))`,
  })) {
    h(`fld_${fmt}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $fpush ${ld})
`);
  }
  // The integer stores round through the control word first: an FISTP with RC
  // set to truncate and one set to nearest differ by a pixel, every pixel.
  // trunc_sat and not trunc: a NaN coordinate must produce a wrong number, not
  // take the whole VM down with a trap.
  for (const [fmt, store] of Object.entries({
    m32: '(call $fmw32 (local.get $t5) (local.get $t4) (call $fst_get (i32.const 0)))',
    m64: '(call $fmw64 (local.get $t5) (local.get $t4) (call $fst_get (i32.const 0)))',
    m80: '(call $fmw80 (local.get $t5) (local.get $t4) (call $fst_get (i32.const 0)))',
    i16: `(call $wr16 (local.get $t5) (local.get $t4)
      (i32.trunc_sat_f64_s (call $fround (call $fst_get (i32.const 0)))))`,
    i32: `(call $wr32 (local.get $t5) (local.get $t4)
      (i32.trunc_sat_f64_s (call $fround (call $fst_get (i32.const 0)))))`,
    i64: `(local.set $q (i64.trunc_sat_f64_s (call $fround (call $fst_get (i32.const 0)))))
      (call $wr32 (local.get $t5) (local.get $t4) (i32.wrap_i64 (local.get $q)))
      (call $wr32 (local.get $t5) (call $off_add (local.get $t4) (i32.const 4))
        (i32.wrap_i64 (i64.shr_u (local.get $q) (i64.const 32))))`,
  })) {
    for (const p of ['', 'p']) {
      h(`fst${p}_${fmt}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  ${store}
  ${p ? '(call $fpop)' : ''}
`);
    }
  }

  // The register-to-register moves.
  h('fld_st', 1, `
  ${ops(1)}
  (call $fpush ${STI})
`);
  for (const p of ['', 'p']) {
    h(`fst${p}_st`, 1, `
  ${ops(1)}
  (call $fst_set (local.get $t0) ${ST0})
  ${p ? '(call $fpop)' : ''}
`);
  }
  h('fxch', 1, `
  ${ops(1)}
  (local.set $f0 ${ST0})
  (call $fst_set (i32.const 0) ${STI})
  (call $fst_set (local.get $t0) (local.get $f0))
`);

  // Compares. FUCOM differs from FCOM only in which NaN raises an exception,
  // and no exception is raised here, so they share an implementation.
  for (const [fmt, src] of Object.entries({
    m32: '(call $fmr32 (local.get $t5) (local.get $t4))',
    m64: '(call $fmr64 (local.get $t5) (local.get $t4))',
    mi16: `(f64.convert_i32_s (i32.shr_s (i32.shl
      (call $rd16 (local.get $t5) (local.get $t4)) (i32.const 16)) (i32.const 16)))`,
    mi32: '(f64.convert_i32_s (call $rd32 (local.get $t5) (local.get $t4)))',
  })) {
    for (const p of ['', 'p']) {
      h(`fcom${p}_${fmt}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $fcmp ${ST0} ${src})
  ${p ? '(call $fpop)' : ''}
`);
    }
  }
  for (const p of ['', 'p', 'pp']) {
    h(`fcom${p}_st`, 1, `
  ${ops(1)}
  (call $fcmp ${ST0} ${STI})
  ${p.length >= 1 ? '(call $fpop)' : ''}
  ${p.length === 2 ? '(call $fpop)' : ''}
`);
  }

  // The one-off register instructions.
  const UN = {
    fchs: `(f64.neg ${ST0})`,
    fabs: `(f64.abs ${ST0})`,
    fsqrt: `(f64.sqrt ${ST0})`,
    frndint: `(call $fround ${ST0})`,
  };
  for (const [nm, e] of Object.entries(UN)) {
    h(nm, 0, `(call $fst_set (i32.const 0) ${e})`);
  }
  // The seven constants FLD can produce without a memory operand.
  const CONSTS = {
    fld1: '1', fldl2t: '3.321928094887362', fldl2e: '1.4426950408889634',
    fldpi: '3.141592653589793', fldlg2: '0.30102999566398120',
    fldln2: '0.69314718055994531', fldz: '0',
  };
  for (const [nm, v] of Object.entries(CONSTS)) {
    h(nm, 0, `(call $fpush (f64.const ${v}))`);
  }

  h('ftst', 0, `(call $fcmp ${ST0} (f64.const 0))`);
  // FXAM reports what ST(0) IS rather than how it compares: C3/C2/C0 name the
  // class and C1 carries the sign. Only the classes a demo can produce are
  // distinguished -- empty, zero, normal, NaN.
  h('fxam', 0, `
  (local.set $t0 (i32.const ${(1 << 14) | (1 << 8)}))
  (if (i32.and (global.get $ftag) (i32.shl (i32.const 1) (global.get $ftop)))
    (then
      (local.set $t0 (i32.const ${1 << 10}))
      (if (f64.eq ${ST0} (f64.const 0)) (then (local.set $t0 (i32.const ${1 << 14}))))
      (if (f64.ne ${ST0} ${ST0}) (then (local.set $t0 (i32.const ${1 << 8}))))))
  (global.set $fsw (i32.or
    (i32.and (global.get $fsw)
      (i32.const ${~((1 << 14) | (1 << 10) | (1 << 9) | (1 << 8)) & 0xFFFF}))
    (i32.or (local.get $t0)
      (i32.shl (f64.lt ${ST0} (f64.const 0)) (i32.const 9)))))
`);

  // FSCALE multiplies by a power of two taken from ST(1); FPREM is the
  // remainder with the quotient's low bits reported in the condition codes,
  // which nothing in this corpus reads, so Q is left alone.
  h('fscale', 0, `
  (call $fst_set (i32.const 0) (f64.mul ${ST0}
    (call $pow2 (i32.trunc_sat_f64_s (f64.trunc (call $fst_get (i32.const 1)))))))
`);
  h('fprem', 0, `
  (local.set $t0 (i32.const 0))
  (call $fst_set (i32.const 0) (f64.sub ${ST0}
    (f64.mul (f64.trunc (f64.div ${ST0} (call $fst_get (i32.const 1))))
             (call $fst_get (i32.const 1)))))
  (global.set $fsw (i32.and (global.get $fsw) (i32.const ${~(1 << 10) & 0xFFFF})))
`);

  h('fnop', 0, '');
  h('fincstp', 0, `
  (global.set $ftop (i32.and (i32.add (global.get $ftop) (i32.const 1)) (i32.const 7)))
`);
  h('fdecstp', 0, `
  (global.set $ftop (i32.and (i32.sub (global.get $ftop) (i32.const 1)) (i32.const 7)))
`);
  h('ffree', 1, `
  ${ops(1)}
  (global.set $ftag (i32.and (global.get $ftag) (i32.xor
    (i32.shl (i32.const 1) (i32.and (i32.add (global.get $ftop) (local.get $t0))
                                    (i32.const 7)))
    (i32.const -1))))
`);

  // FNINIT is where nearly every corpus program stopped: it is the first FPU
  // instruction a demo executes and it appears both bare (DB E3) and behind a
  // WAIT (9B DB E3).
  h('finit', 0, `
  (global.set $ftop (i32.const 0))
  (global.set $ftag (i32.const 0))
  (global.set $fsw (i32.const 0))
  (global.set $fcw (i32.const 0x037F))
`);
  h('fclex', 0, `
  (global.set $fsw (i32.and (global.get $fsw) (i32.const 0x7F00)))
`);
  h('fldcw', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (global.set $fcw (call $rd16 (local.get $t5) (local.get $t4)))
`);
  h('fnstcw', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $wr16 (local.get $t5) (local.get $t4) (global.get $fcw))
`);
  // The status word carries TOP in bits 11-13, so it is assembled on the way
  // out rather than kept in $fsw.
  const SW = `(i32.or (i32.and (global.get $fsw) (i32.const 0xC7FF))
    (i32.shl (global.get $ftop) (i32.const 11)))`;
  h('fnstsw_ax', 0, `(call $rset16 (i32.const 0) ${SW})`);
  h('fnstsw_m', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $wr16 (local.get $t5) (local.get $t4) ${SW})
`);

  // The environment and whole-state moves. A demo that wants to know whether a
  // coprocessor is present writes a known control word, FSTENVs, and reads the
  // word back -- so refusing these reads as "no FPU fitted" even with every
  // arithmetic instruction implemented.
  for (const [nm, call] of Object.entries({
    fnstenv: '(call $fenv_save (local.get $t5) (local.get $t4))',
    fldenv: '(call $fenv_load (local.get $t5) (local.get $t4))',
    fnsave: '(call $fstate_save (local.get $t5) (local.get $t4))',
    frstor: '(call $fstate_load (local.get $t5) (local.get $t4))',
    fbld: '(call $fpush (call $fbcd_read (local.get $t5) (local.get $t4)))',
    fbstp: `(call $fbcd_write (local.get $t5) (local.get $t4) ${ST0}) (call $fpop)`,
  })) {
    // FNSAVE reinitialises the unit once the state is safely in memory, which
    // is the whole reason a program calls it before handing the FPU to someone
    // else. FNSTENV does not.
    const reinit = nm === 'fnsave' ? `
  (global.set $ftop (i32.const 0))
  (global.set $ftag (i32.const 0))
  (global.set $fsw (i32.const 0))
  (global.set $fcw (i32.const 0x037F))` : '';
    h(nm, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  ${call}${reinit}
`);
  }

  // The transcendentals. Every one of these is defined on ST(0) and most write
  // ST(1) as well, so the operand order below is the manual's, not the obvious
  // one: FYL2X is "y times log2 x" with y in ST(1) and x in ST(0), and the
  // result replaces ST(1) before the pop.
  const M = (op, a, b = '(f64.const 0)') => `(call $fmath (i32.const ${op}) ${a} ${b})`;
  const ST1 = '(call $fst_get (i32.const 1))';
  // C2 is the out-of-range flag on FPTAN and the sin/cos pair. The reduction
  // these need is done in f64 by the host, which has no |x| < 2^63 limit, so it
  // is always cleared.
  const C2_CLEAR = `(global.set $fsw (i32.and (global.get $fsw) (i32.const ${~(1 << 10) & 0xFFFF})))`;

  h('f2xm1', 0, `(call $fst_set (i32.const 0) (f64.sub ${M(5, ST0)} (f64.const 1)))`);
  h('fsin', 0, `(call $fst_set (i32.const 0) ${M(0, ST0)}) ${C2_CLEAR}`);
  h('fcos', 0, `(call $fst_set (i32.const 0) ${M(1, ST0)}) ${C2_CLEAR}`);
  h('fsincos', 0, `
  (local.set $f0 ${ST0})
  (call $fst_set (i32.const 0) ${M(0, '(local.get $f0)')})
  (call $fpush ${M(1, '(local.get $f0)')})
  ${C2_CLEAR}
`);
  h('fptan', 0, `
  (call $fst_set (i32.const 0) ${M(2, ST0)})
  (call $fpush (f64.const 1))
  ${C2_CLEAR}
`);
  h('fpatan', 0, `
  (call $fst_set (i32.const 1) ${M(3, ST1, ST0)})
  (call $fpop)
`);
  h('fyl2x', 0, `
  (call $fst_set (i32.const 1) (f64.mul ${ST1} ${M(4, ST0)}))
  (call $fpop)
`);
  h('fyl2xp1', 0, `
  (call $fst_set (i32.const 1) (f64.mul ${ST1} ${M(4, `(f64.add ${ST0} (f64.const 1))`)}))
  (call $fpop)
`);
  // FXTRACT splits ST(0) into its exponent and its significand in [1,2), the
  // exponent replacing ST(0) and the significand pushed on top. Reading it
  // straight out of the f64 exponent field is both exact and shorter than the
  // log2 the definition suggests. Subnormals come back as zero, which is the
  // same answer the rest of this FPU gives for them.
  h('fxtract', 0, `
  (local.set $q (i64.reinterpret_f64 ${ST0}))
  (local.set $t0 (i32.wrap_i64 (i64.and (i64.shr_u (local.get $q) (i64.const 52))
                                        (i64.const 0x7FF))))
  (if (i32.eqz (local.get $t0))
    (then
      (call $fst_set (i32.const 0) (f64.const 0))
      (call $fpush (f64.const 0)))
    (else
      (call $fst_set (i32.const 0)
        (f64.convert_i32_s (i32.sub (local.get $t0) (i32.const 1023))))
      (call $fpush (f64.reinterpret_i64 (i64.or
        (i64.and (local.get $q) (i64.const 0x800FFFFFFFFFFFFF))
        (i64.const 0x3FF0000000000000))))))
`);
  // FPREM1 differs from FPREM only in rounding the implied quotient to nearest
  // rather than toward zero, which is what makes it the IEEE remainder.
  h('fprem1', 0, `
  (call $fst_set (i32.const 0) (f64.sub ${ST0}
    (f64.mul (f64.nearest (f64.div ${ST0} ${ST1})) ${ST1})))
  ${C2_CLEAR}
`);
}

genStrings();
gen186StringIO();
gen386();
genFpu();
genShifts();
genSetmo();
genShiftHandlers();
genDoubleShifts();
genBitOps();
genArithIO();

// --- Superinstructions: a flag-setting op and the branch that reads it ------
//
// Threaded code pays for every op twice: once to do the work and once to get
// to it. Fusing two ops into one handler pays the second cost once, and the
// pair worth fusing is not a guess -- the handler-pair census over the core
// ten (8M dispatches each, counts exact) says an ALU op immediately followed
// by a Jcc is 10,323,039 of 80,000,000 dispatches, 12.9%. Two pairs alone
// (`cmp_ri8 -> jz`, `cmp_rm8 -> jz`) are 6.0% of everything the corpus runs.
//
// The fused body is the CONCATENATION of the two bodies, with nothing else
// changed, and that is not a shortcut -- it is why this is safe. Every handler
// reads its operands with ops(n), which loads them at offsets off $ip and then
// advances $ip past them, so two bodies in sequence read two operand lists in
// sequence with no re-layout and no renumbering. The arena loses exactly one
// word: the Jcc's opcode.
//
// FIRST is the census's own list, top-down, cut where the tail stops paying:
// these twelve are 88.5% of all fusable pairs. `popf` is the notable omission
// from the top twenty -- it can end the block mid-instruction when it raises
// TF, and a first half that hands back would leave the branch half unrun with
// $ip parked between two operand lists. The assertion below is what enforces
// that rather than the comment: a first op that can halt, fault or return is a
// build error, not a silent miscompile.
const FUSE_FIRST = [
  'cmp_ri8', 'cmp_rm8', 'sbb_ri16', 'cmp_ri16', 'dec_r16', 'cmp_mi16',
  'or_rr8', 'or_rr16', 'cmp_rm16', 'cmp_mi8', 'sh2_r16', 'dec_r8',
];

// alu handler index * 65536 + jcc handler index -> fused handler index. Built
// here so the compiler never has to know the naming scheme.
const FUSE = new Map();

function genFusedBranches() {
  const byName = new Map(HANDLERS.map(x => [x.name, x]));
  for (const alu of FUSE_FIRST) {
    const a = byName.get(alu);
    if (!a) throw new Error(`FUSE_FIRST names ${alu}, which is not a handler`);
    // A fused first half must run to its end every time. Anything that can
    // hand back, fault or return early would strand $ip between the two
    // operand lists, and the resume would read the branch's operands as an
    // instruction.
    if (/\$halt|\(return\)|\$fault|\$jlook/.test(a.body)) {
      throw new Error(`${alu} can leave its handler early; it cannot be fused`);
    }
    for (const cc of Object.keys(CONDS)) {
      const j = byName.get(`j${cc}`);
      // The dispatch that used to sit between the two halves charged one step.
      // Charging it here keeps $steps -- and so every slice boundary, every
      // interrupt injection point and every frame -- bit-identical to the
      // unfused build, which is what makes the corpus diff a real check on
      // this rather than a vague "it still runs".
      const idx = h(`${alu}_j${cc}`, a.args + j.args, `
  ${a.body}
  (global.set $steps (i32.sub (global.get $steps) (i32.const 1)))
  ${j.body}
`);
      FUSE.set(a.index * 65536 + j.index, idx);
    }
  }
}
genFusedBranches();

// Rebuild the whole table under the other flag scheme. Both arms live in one
// process so bench-dos.js can interleave them rep by rep; a worktree per arm on
// a box that sits at load 10-40 measures the box.
//
// The handler table's SHAPE must not move: same handlers, same order, same
// operand counts, same fusions. Only the bodies differ -- laziness changes what
// a compare computes, not what it consumes. compile.js holds ARITY and FUSE by
// reference from require time, so if that ever stopped being true the compiler
// would lay out one arm's arena with the other arm's operand counts and produce
// garbage with no error. It is asserted rather than assumed.
function buildHandlers(lazy) {
  if (lazy === LAZY) return;
  const before = HANDLERS.map(x => `${x.name}/${x.args}`).join(',');
  const fuseBefore = [...FUSE.entries()].map(([k, v]) => `${k}:${v}`).sort().join(',');
  LAZY = lazy;
  CONDS = makeConds();
  HANDLERS.length = 0;
  FUSE.clear();
  // genShifts()/genDoubleShifts() append to this rather than returning, so a
  // rebuild that does not clear it emits both arms' shift helpers -- same
  // function names twice, and the handler table's ARITY check cannot see it.
  SHIFT_FNS.length = 0;
  genTerminators();
  genAlu(); genMov(); genBranches(); genExtras();
  genStrings(); gen186StringIO(); gen386(); genFpu();
  genShifts(); genSetmo(); genShiftHandlers(); genDoubleShifts();
  genBitOps(); genArithIO();
  genFusedBranches();
  const after = HANDLERS.map(x => `${x.name}/${x.args}`).join(',');
  if (after !== before) {
    throw new Error('the flag scheme moved the handler table: names or arities differ');
  }
  const fuseAfter = [...FUSE.entries()].map(([k, v]) => `${k}:${v}`).sort().join(',');
  if (fuseAfter !== fuseBefore) throw new Error('the flag scheme changed the fusion table');
}

// The first six handlers were written by hand to prove the gate; genAlu()
// covers every form they did and forty more, so they are gone rather than
// kept as a second definition of the same arithmetic.

// ---------------------------------------------------------------------------
// Shared helper functions. These are called from bodies and are identical in
// every variant, so they are not part of what is being measured -- but they ARE
// part of what the JIT sees, and whether it inlines them is exactly the kind of
// thing tools/wasm-native.js is for.
// ---------------------------------------------------------------------------
function brTableFn(name, params, result, arms, idx = '(local.get $i)') {
  // Build the nested-block br_table shape by hand; it is the same one
  // $get_reg uses in src/03-registers.wat.
  // Block nesting order is load-bearing and easy to get backwards: branching to
  // $b0 exits block $b0, so arm 0 must sit immediately AFTER $b0 closes, not
  // inside it. $bad is therefore the outermost block and $b0 the innermost.
  const n = arms.length;
  let s = `(func $${name} ${params} ${result}\n(block $bad\n`;
  for (let i = n - 1; i >= 0; i--) s += `(block $b${i} `;
  s += `\n(br_table ${arms.map((_, i) => `$b${i}`).join(' ')} $bad ${idx})\n`;
  for (let i = 0; i < n; i++) s += `)\n${arms[i]}\n`;
  s += `)\n(unreachable)\n)\n`;
  return s;
}

function helpers() {
  const R = isa.REG16;
  let s = '';

  // The register file holds the FULL 32 bits. A 16-bit write leaves the upper
  // half alone and an 8-bit write leaves the other three bytes alone, exactly
  // as the hardware does -- a 386-era demo sets ESI once and then addresses
  // through SI, and zeroing the top half on every 16-bit write turns that into
  // a wild pointer thousands of instructions later.
  s += brTableFn('rget32', '(param $i i32)', '(result i32)',
    R.map(r => `(return (global.get $${r}))`));
  s += brTableFn('rset32', '(param $i i32) (param $v i32)', '',
    R.map(r => `(global.set $${r} (local.get $v)) (return)`));

  s += brTableFn('rget16', '(param $i i32)', '(result i32)',
    R.map(r => `(return (i32.and (global.get $${r}) (i32.const 0xFFFF)))`));
  s += brTableFn('rset16', '(param $i i32) (param $v i32)', '',
    R.map(r => `(global.set $${r} (i32.or (i32.and (global.get $${r}) (i32.const 0xFFFF0000))`
      + ` (i32.and (local.get $v) (i32.const 0xFFFF)))) (return)`));

  // 8-bit halves. 0-3 are the low bytes of AX/CX/DX/BX, 4-7 the high bytes.
  s += brTableFn('rget8', '(param $i i32)', '(result i32)',
    isa.REG8.map((_, i) => {
      const host = R[i & 3];
      return i < 4
        ? `(return (i32.and (global.get $${host}) (i32.const 0xFF)))`
        : `(return (i32.and (i32.shr_u (global.get $${host}) (i32.const 8)) (i32.const 0xFF)))`;
    }));
  s += brTableFn('rset8', '(param $i i32) (param $v i32)', '',
    isa.REG8.map((_, i) => {
      const host = R[i & 3];
      return i < 4
        ? `(global.set $${host} (i32.or (i32.and (global.get $${host}) (i32.const 0xFFFFFF00)) (i32.and (local.get $v) (i32.const 0xFF)))) (return)`
        : `(global.set $${host} (i32.or (i32.and (global.get $${host}) (i32.const 0xFFFF00FF)) (i32.shl (i32.and (local.get $v) (i32.const 0xFF)) (i32.const 8)))) (return)`;
    }));
  s += brTableFn('sget', '(param $i i32)', '(result i32)',
    isa.SEG.map(r => `(return (global.get $${r}))`));
  s += brTableFn('sbase', '(param $i i32)', '(result i32)',
    isa.SEG.map(r => `(return (global.get $${r}b))`));
  // Loading CS also republishes the default operand size, since that lives in
  // the descriptor CS came from and nothing else can change it.
  //
  // SS republishes the stack width for the same reason. The B bit of the stack
  // descriptor is what decides whether a push moves SP or ESP, and it is not
  // the same bit as CS's D: an extender's 32-bit code can run on a 16-bit
  // stack and does, briefly, on either side of a mode switch. Masking the
  // stack pointer to 16 bits regardless -- which is what this did while
  // nothing was ever 32-bit -- throws away the high half of every ESP a flat
  // stack uses, and the first `ret` after it lands somewhere in the first 64KB
  // of the program.
  s += brTableFn('sset', '(param $i i32) (param $v i32)', '',
    isa.SEG.map(r => `(global.set $${r} (local.get $v))`
      + ` (global.set $${r}b (call $segbase (local.get $v)))`
      + (r === 'cs' ? ` (global.set $d32 (call $segd32 (local.get $v)))` : '')
      + (r === 'ss' ? ` (global.set $spm (select (i32.const -1) (i32.const 0xFFFF)`
        + ` (call $segd32 (local.get $v))))` : '')
      + ` (return)`));

  // Effective address. Every form masks to 16 bits: the 8086 wraps an EA inside
  // its segment rather than carrying into the segment base.
  //
  // These read the globals raw rather than through $rget16, on purpose. The sum
  // is masked to 16 bits anyway, and (a + b) & 0xFFFF depends only on the low
  // halves -- so a 32-bit value sitting in ESI cannot change the answer, and
  // this is the hottest path in the whole VM.
  const eaArms = [
    '(return (i32.and (i32.add (i32.add (global.get $bx) (global.get $si)) (local.get $d)) (i32.const 0xFFFF)))',
    '(return (i32.and (i32.add (i32.add (global.get $bx) (global.get $di)) (local.get $d)) (i32.const 0xFFFF)))',
    '(return (i32.and (i32.add (i32.add (global.get $bp) (global.get $si)) (local.get $d)) (i32.const 0xFFFF)))',
    '(return (i32.and (i32.add (i32.add (global.get $bp) (global.get $di)) (local.get $d)) (i32.const 0xFFFF)))',
    '(return (i32.and (i32.add (global.get $si) (local.get $d)) (i32.const 0xFFFF)))',
    '(return (i32.and (i32.add (global.get $di) (local.get $d)) (i32.const 0xFFFF)))',
    '(return (i32.and (i32.add (global.get $bp) (local.get $d)) (i32.const 0xFFFF)))',
    '(return (i32.and (i32.add (global.get $bx) (local.get $d)) (i32.const 0xFFFF)))',
    '(return (i32.and (local.get $d) (i32.const 0xFFFF)))',
    // 32-bit addressing. The fields do not fit in a br_table arm, and this is
    // the one EA form the 16-bit corpus almost never takes, so it costs the
    // fast path a call it does not make.
    '(return (call $ea32 (local.get $i) (local.get $d)))',
  ];
  // The index is masked here rather than at every call site: the callers pass
  // the whole packed operand, because arm 9 needs the bits above the kind.
  s += brTableFn('ea', '(param $i i32) (param $d i32)', '(result i32)', eaArms,
    '(i32.and (local.get $i) (i32.const 15))');

  // base + index*scale + disp, at full 32 bits and NOT wrapped to 64K -- that
  // is the whole point of the encoding. Real mode still puts (seg<<4) under it
  // and $lin still wraps the sum at 1MB, which is what an unreal-mode demo
  // reaching past 0xFFFF within a zero-based segment actually wants.
  s += `
(func $ea32 (param $i i32) (param $d i32) (result i32)
  (local $a i32)
  (local.set $a (local.get $d))
  (if (i32.eqz (i32.and (local.get $i) (i32.const ${isa.EA_A32.NO_BASE})))
    (then (local.set $a (i32.add (local.get $a) (call $rget32
      (i32.and (i32.shr_u (local.get $i) (i32.const ${isa.EA_A32.BASE_SHIFT}))
               (i32.const 7)))))))
  (if (i32.eqz (i32.and (local.get $i) (i32.const ${isa.EA_A32.NO_INDEX})))
    (then (local.set $a (i32.add (local.get $a) (i32.shl
      (call $rget32 (i32.and (i32.shr_u (local.get $i) (i32.const ${isa.EA_A32.INDEX_SHIFT}))
                             (i32.const 7)))
      (i32.and (i32.shr_u (local.get $i) (i32.const ${isa.EA_A32.SCALE_SHIFT}))
               (i32.const 3)))))))
  (local.get $a))
`;

  // Linear address: (segment << 4) + offset, wrapped at 1MB the way the 8086's
  // 20 address lines do.
  s += `
;; Selector to linear base. Real mode has no table to consult: the base IS the
;; selector times sixteen, which is the whole of 8086 segmentation. Protected
;; mode reads it out of a descriptor instead, and the two have no arithmetic
;; relationship -- which is why the base is cached per segment register rather
;; than recomputed per access.
;;
;; Only the base is taken. Limits, and the protection the name refers to, are
;; deliberately not modelled: every extender in this corpus builds flat or
;; segment-sized descriptors and then runs its own code through them, so a
;; limit check could only ever fire on a program that was already wrong. What
;; a demo actually needs from protected mode is the address arithmetic.
(func $segbase (param $v i32) (result i32)
  ;; Real mode, or virtual-8086 mode, which IS real-mode segmentation running
  ;; with PE set. The V86 test comes first and is unconditional: a V86 selector
  ;; that happens to fall inside the GDT limit must still be read as a
  ;; paragraph, or a guest running at segment 0x30 addresses a descriptor.
  (if (i32.or (i32.eqz (i32.and (global.get $cr0) (i32.const 1)))
              (global.get $vm86))
    (then (return (i32.shl (i32.and (local.get $v) (i32.const 0xFFFF)) (i32.const 4)))))
  ;; A null selector addresses nothing, and the low three bits are the
  ;; requested privilege level and table indicator, not part of the index.
  (if (i32.eqz (i32.and (local.get $v) (i32.const 0xFFF8))) (then (return (i32.const 0))))
  ;; Past the table's own limit there is no descriptor, and reading one anyway
  ;; is how a real-mode segment number that never went through a selector load
  ;; -- 0x9bf0, say -- comes back with a plausible base and a random D bit.
  ;; A real CPU faults; here the selector keeps its real-mode meaning, which is
  ;; what it had a moment ago and is the reading that lets an extender running
  ;; with PE still set but addressing conventional memory carry on.
  (if (i32.gt_u (i32.and (local.get $v) (i32.const 0xFFF8))
                (i32.and (global.get $gdtl) (i32.const 0xFFFF)))
    (then (return (i32.shl (i32.and (local.get $v) (i32.const 0xFFFF)) (i32.const 4)))))
  ;; Bit 2 is the table indicator: set means this selector indexes the LDT that
  ;; LLDT named, clear means the GDT.
  (call $descbase
    (select (global.get $ldtb) (global.get $gdtb)
            (i32.and (local.get $v) (i32.const 4)))
    (local.get $v)))

;; The base out of one descriptor, given the table it lives in. Split three
;; ways across the eight bytes, which is the 286 layout with the 386's high
;; byte bolted on the end.
(func $descbase (param $table i32) (param $v i32) (result i32) (local $d i32)
  (local.set $d (i32.and (i32.add (local.get $table)
                                  (i32.and (local.get $v) (i32.const 0xFFF8)))
                         (global.get $linmask)))
  (i32.or (i32.or (i32.load16_u offset=2 (local.get $d))
                  (i32.shl (i32.load8_u offset=4 (local.get $d)) (i32.const 16)))
          (i32.shl (i32.load8_u offset=7 (local.get $d)) (i32.const 24))))

;; Where one selector's descriptor lives, plus one so that zero can mean "there
;; isn't one" -- a null selector, one past its table's limit, or real mode,
;; where the number is a paragraph and names no descriptor at all. LAR and LSL
;; report exactly that distinction in ZF, so they need the question answered
;; rather than the base $segbase would hand back.
(func $descaddr (param $v i32) (result i32)
  (if (i32.eqz (i32.and (global.get $cr0) (i32.const 1)))
    (then (return (i32.const 0))))
  (if (i32.eqz (i32.and (local.get $v) (i32.const 0xFFF8))) (then (return (i32.const 0))))
  (if (i32.gt_u (i32.and (local.get $v) (i32.const 0xFFF8))
                (i32.and (global.get $gdtl) (i32.const 0xFFFF)))
    (then (return (i32.const 0))))
  (i32.add
    (i32.and (i32.add (select (global.get $ldtb) (global.get $gdtb)
                              (i32.and (local.get $v) (i32.const 4)))
                      (i32.and (local.get $v) (i32.const 0xFFF8)))
             (global.get $linmask))
    (i32.const 1)))

;; LLDT's operand always names a GDT entry, whatever its own table bit says.
(func $gdtbase (param $v i32) (result i32)
  (if (i32.eqz (i32.and (local.get $v) (i32.const 0xFFF8))) (then (return (i32.const 0))))
  (call $descbase (global.get $gdtb) (local.get $v)))

;; The D/B bit of a descriptor: bit 6 of the granularity byte. On a code
;; segment it selects the default operand and address size, which is the whole
;; of what 32-bit protected mode means to a decoder.
(func $segd32 (param $v i32) (result i32)
  ;; V86 code is 16-bit by definition -- there is no descriptor to carry a D
  ;; bit. Same ordering argument as $segbase.
  (if (i32.or (i32.eqz (i32.and (global.get $cr0) (i32.const 1)))
              (global.get $vm86))
    (then (return (i32.const 0))))
  (if (i32.eqz (i32.and (local.get $v) (i32.const 0xFFF8))) (then (return (i32.const 0))))
  ;; No descriptor, no D bit -- see $segbase. Guessing one here is what made a
  ;; real-mode segment look like a 32-bit code selector.
  (if (i32.gt_u (i32.and (local.get $v) (i32.const 0xFFF8))
                (i32.and (global.get $gdtl) (i32.const 0xFFFF)))
    (then (return (i32.const 0))))
  (i32.and (i32.shr_u
             (i32.load8_u (i32.and (i32.add (i32.add
                                              (select (global.get $ldtb) (global.get $gdtb)
                                                      (i32.and (local.get $v) (i32.const 4)))
                                              (i32.and (local.get $v) (i32.const 0xFFF8)))
                                            (i32.const 6))
                                   (global.get $linmask)))
             (i32.const 6))
           (i32.const 1)))

(func $lin (param $seg i32) (param $off i32) (result i32)
  (i32.and (i32.add (call $sbase (local.get $seg)) (local.get $off))
           (global.get $linmask)))

;; The A000 window in unchained ("mode X") mode. See isa.js for why the planes
;; cannot live in the guest's own RAM.
;;
;; The guard is what every guest byte access now pays: one load of a constant
;; address, an and/or/eq, and a branch. It is written as a key compare rather
;; than a flag test so that "are we unchained" and "is this address video
;; memory" are the SAME branch instead of two -- and the spare low bit means a
;; zeroed control block reads as chained, which is what a caller that resets the
;; machine with mem.fill(0) leaves behind. See isa.js.
;;
;; The cost is identical in all four dispatch shells, so it moves every arm of
;; the shootout together and does not change any ratio it reports.
(func $vga_plane (param $p i32) (param $lin i32) (result i32)
  (i32.add (i32.const ${isa.VGA_PLANES})
    (i32.add (i32.shl (local.get $p) (i32.const 16))
             (i32.and (local.get $lin) (i32.const 0xFFFF)))))

;; One graphics-controller register, as the host last mirrored it.
(func $gc (param $i i32) (result i32)
  (i32.load (i32.add (i32.const ${isa.VGA_CTL_GC})
                     (i32.shl (local.get $i) (i32.const 2)))))

;; A read loads ALL four latches and returns the plane the read map selects.
;; The latches are the point: mode X's fast blit is a read that fills them and a
;; write in mode 1 that spills them into up to four planes at once, moving four
;; pixels per pair of instructions without the value ever reaching a register.
;;
;; Read mode 1 (GC5 bit 3) returns a colour-compare instead: one bit per pixel
;; saying whether every plane the "colour don't care" register cares about
;; matches GC2. EGA code uses it to test eight pixels against a colour at once.
(func $vga_rd8 (param $lin i32) (result i32)
  (local $p i32) (local $lat i32) (local $res i32) (local $pb i32) (local $cmp i32)
  (i32.store (i32.const ${isa.VGA_CTL_READS})
    (i32.add (i32.load (i32.const ${isa.VGA_CTL_READS})) (i32.const 1)))
  (i32.store (i32.const ${isa.VGA_CTL_LATCH})
    (i32.or
      (i32.or (i32.load8_u (call $vga_plane (i32.const 0) (local.get $lin)))
              (i32.shl (i32.load8_u (call $vga_plane (i32.const 1) (local.get $lin)))
                       (i32.const 8)))
      (i32.or (i32.shl (i32.load8_u (call $vga_plane (i32.const 2) (local.get $lin)))
                       (i32.const 16))
              (i32.shl (i32.load8_u (call $vga_plane (i32.const 3) (local.get $lin)))
                       (i32.const 24)))))
  (local.set $lat (i32.load (i32.const ${isa.VGA_CTL_LATCH})))
  (if (i32.and (call $gc (i32.const 5)) (i32.const 0x08))
    (then
      (local.set $res (i32.const 0xFF))
      (block $cdone
        (loop $cplane
          (br_if $cdone (i32.eq (local.get $p) (i32.const 4)))
          (if (i32.and (call $gc (i32.const 7)) (i32.shl (i32.const 1) (local.get $p)))
            (then
              (local.set $pb (i32.and (i32.shr_u (local.get $lat)
                                                 (i32.shl (local.get $p) (i32.const 3)))
                                      (i32.const 0xFF)))
              (local.set $cmp (if (result i32)
                (i32.and (call $gc (i32.const 2)) (i32.shl (i32.const 1) (local.get $p)))
                (then (i32.const 0xFF)) (else (i32.const 0))))
              (local.set $res (i32.and (local.get $res)
                (i32.xor (i32.const 0xFF)
                         (i32.xor (local.get $pb) (local.get $cmp)))))))
          (local.set $p (i32.add (local.get $p) (i32.const 1)))
          (br $cplane)))
      (return (local.get $res))))
  (i32.and
    (i32.shr_u (local.get $lat)
               (i32.shl (i32.and (call $gc (i32.const 4)) (i32.const 3)) (i32.const 3)))
    (i32.const 0xFF)))

;; The full graphics-controller write pipeline. Mode X needs almost none of it
;; -- write mode 0 with an all-ones bit mask is a plain store -- but an EGA
;; 16-colour mode drives set/reset, the bit mask and the ALU function on nearly
;; every store, because there a byte is eight PIXELS in one plane rather than
;; one pixel, and touching a single pixel means a read-modify-write the hardware
;; performs on the guest's behalf.
;;
;; Per plane: pick a source byte (rotated CPU data, or set/reset expanded to
;; 0x00/0xFF), combine it with that plane's latch through the ALU function, then
;; merge under the bit mask -- masked-out bits come back from the latch
;; untouched, which is why the guest reads before it writes.
(func $vga_wr8 (param $lin i32) (param $v i32)
  (local $p i32) (local $mask i32) (local $lat i32) (local $bit i32)
  (local $wmode i32) (local $rot i32) (local $fn i32) (local $bm i32)
  (local $src i32) (local $latb i32)
  (i32.store (i32.const ${isa.VGA_CTL_WRITES})
    (i32.add (i32.load (i32.const ${isa.VGA_CTL_WRITES})) (i32.const 1)))
  (local.set $mask (i32.load (i32.const ${isa.VGA_CTL_MASK})))
  (local.set $lat (i32.load (i32.const ${isa.VGA_CTL_LATCH})))
  (local.set $wmode (i32.and (call $gc (i32.const 5)) (i32.const 3)))
  (local.set $rot (i32.and (call $gc (i32.const 3)) (i32.const 7)))
  (local.set $fn (i32.and (i32.shr_u (call $gc (i32.const 3)) (i32.const 3))
                          (i32.const 3)))
  ;; Rotate right by the data-rotate count. rot = 0 leaves the value alone: the
  ;; shl by 8 falls entirely outside the byte the mask keeps.
  (local.set $v (i32.and (local.get $v) (i32.const 0xFF)))
  (local.set $v (i32.and
    (i32.or (i32.shr_u (local.get $v) (local.get $rot))
            (i32.shl (local.get $v) (i32.sub (i32.const 8) (local.get $rot))))
    (i32.const 0xFF)))
  (local.set $bm (i32.and (call $gc (i32.const 8)) (i32.const 0xFF)))
  ;; Write mode 3 ANDs the rotated CPU byte into the bit mask instead of
  ;; supplying data -- the data IS the mask, and the colour comes from set/reset.
  (if (i32.eq (local.get $wmode) (i32.const 3))
    (then (local.set $bm (i32.and (local.get $bm) (local.get $v)))))
  (block $done
    (loop $plane
      (br_if $done (i32.eq (local.get $p) (i32.const 4)))
      (local.set $bit (i32.shl (i32.const 1) (local.get $p)))
      (if (i32.and (local.get $mask) (local.get $bit))
        (then
          (local.set $latb (i32.and (i32.shr_u (local.get $lat)
                                               (i32.shl (local.get $p) (i32.const 3)))
                                    (i32.const 0xFF)))
          (if (i32.eq (local.get $wmode) (i32.const 1))
            (then
              ;; Mode 1 is the latch spill: no source, no ALU, no bit mask.
              (i32.store8 (call $vga_plane (local.get $p) (local.get $lin))
                          (local.get $latb)))
            (else
              (local.set $src
                (if (result i32) (i32.eq (local.get $wmode) (i32.const 2))
                  ;; Mode 2: bit p of the CPU byte becomes this plane's whole byte.
                  (then (if (result i32) (i32.and (local.get $v) (local.get $bit))
                          (then (i32.const 0xFF)) (else (i32.const 0))))
                  (else (if (result i32)
                          (i32.or (i32.eq (local.get $wmode) (i32.const 3))
                                  (i32.ne (i32.and (call $gc (i32.const 1))
                                                   (local.get $bit))
                                          (i32.const 0)))
                          ;; Set/reset: this plane's colour bit, expanded.
                          (then (if (result i32)
                                  (i32.and (call $gc (i32.const 0)) (local.get $bit))
                                  (then (i32.const 0xFF)) (else (i32.const 0))))
                          (else (local.get $v))))))
              (if (i32.eq (local.get $fn) (i32.const 1))
                (then (local.set $src (i32.and (local.get $src) (local.get $latb)))))
              (if (i32.eq (local.get $fn) (i32.const 2))
                (then (local.set $src (i32.or (local.get $src) (local.get $latb)))))
              (if (i32.eq (local.get $fn) (i32.const 3))
                (then (local.set $src (i32.xor (local.get $src) (local.get $latb)))))
              (i32.store8 (call $vga_plane (local.get $p) (local.get $lin))
                (i32.or (i32.and (local.get $src) (local.get $bm))
                        (i32.and (local.get $latb)
                                 (i32.xor (local.get $bm) (i32.const 0xFF)))))))))
      (local.set $p (i32.add (local.get $p) (i32.const 1)))
      (br $plane))))

(func $rd8 (param $seg i32) (param $off i32) (result i32)
  (local $l i32)
  (local.set $l (call $lin (local.get $seg) (local.get $off)))
  (if (i32.eq (i32.or (i32.and (local.get $l) (i32.const 0xFFF0000)) (i32.const 1))
              (i32.load (i32.const ${isa.VGA_CTL_KEY})))
    (then (return (call $vga_rd8 (local.get $l)))))
  (i32.load8_u (local.get $l)))

(func $wr8 (param $seg i32) (param $off i32) (param $v i32)
  (local $l i32)
  (local.set $l (call $lin (local.get $seg) (local.get $off)))
  (if (i32.eq (i32.or (i32.and (local.get $l) (i32.const 0xFFF0000)) (i32.const 1))
              (i32.load (i32.const ${isa.VGA_CTL_KEY})))
    (then (call $vga_wr8 (local.get $l) (local.get $v)) (return)))
  ;; A store into a byte that has already been COMPILED means the compiled form
  ;; is now a lie -- see isa.CODE_BITMAP. The flag is all this does: the host
  ;; throws the regions away on the next handback, which is where a packed
  ;; program goes anyway (it reaches its unpacked entry through a far jump).
  (if (i32.and (i32.load8_u (i32.add (i32.const ${isa.CODE_BITMAP})
                                     (i32.shr_u (local.get $l) (i32.const 3))))
               (i32.shl (i32.const 1) (i32.and (local.get $l) (i32.const 7))))
    (then
      ;; Widen the range this slice has dirtied. The host clears $smc on every
      ;; handback, so "already 2" means "this slice, not an older one".
      (if (i32.eq (global.get $smc) (i32.const 2))
        (then
          (if (i32.lt_u (local.get $l) (global.get $smclo))
            (then (global.set $smclo (local.get $l))))
          (if (i32.gt_u (local.get $l) (global.get $smchi))
            (then (global.set $smchi (local.get $l)))))
        (else (global.set $smclo (local.get $l))
              (global.set $smchi (local.get $l))))
      (global.set $smc (i32.const 2))))
  (i32.store8 (local.get $l) (local.get $v)))

;; Step an offset to the next byte. A 16-bit offset of 0xFFFF wraps to 0x0000
;; within the SAME segment -- which is why every multi-byte access is done a
;; byte at a time and not as one i32.load16_u, and the 8088 vectors exercise it.
;; But a 32-bit address (a 0x67 prefix, an unreal-mode demo reaching 0xA0000
;; through a zero-based segment) must NOT wrap at 64K, or the second byte of
;; every word lands at offset 1. Wrapping inside the 64K page the offset is
;; already in satisfies both, branch-free: identical to the old mask for any
;; offset that fits in 16 bits.
(func $off_add (param $off i32) (param $n i32) (result i32)
  (i32.or
    (i32.and (i32.add (i32.and (local.get $off) (i32.const 0xFFFF)) (local.get $n))
             (i32.const 0xFFFF))
    (i32.and (local.get $off) (i32.const 0x7FFF0000))))

(func $rd16 (param $seg i32) (param $off i32) (result i32)
  (i32.or
    (call $rd8 (local.get $seg) (local.get $off))
    (i32.shl (call $rd8 (local.get $seg) (call $off_add (local.get $off) (i32.const 1)))
             (i32.const 8))))

(func $wr16 (param $seg i32) (param $off i32) (param $v i32)
  (call $wr8 (local.get $seg) (local.get $off) (i32.and (local.get $v) (i32.const 0xFF)))
  (call $wr8 (local.get $seg) (call $off_add (local.get $off) (i32.const 1))
    (i32.shr_u (local.get $v) (i32.const 8))))

;; 32-bit access, built from the 16-bit pair so it inherits the same wrap.
(func $rd32 (param $seg i32) (param $off i32) (result i32)
  (i32.or
    (call $rd16 (local.get $seg) (local.get $off))
    (i32.shl (call $rd16 (local.get $seg) (call $off_add (local.get $off) (i32.const 2)))
             (i32.const 16))))

(func $wr32 (param $seg i32) (param $off i32) (param $v i32)
  (call $wr16 (local.get $seg) (local.get $off) (local.get $v))
  (call $wr16 (local.get $seg) (call $off_add (local.get $off) (i32.const 2))
    (i32.shr_u (local.get $v) (i32.const 16))))

;; CX as a 16-bit counter with ECX's upper half preserved. Every counted loop
;; and every REP goes through these: a 386-era guest that keeps something in the
;; top half of ECX must not lose it to a REP MOVSB.
(func $cx16 (result i32) (i32.and (global.get $cx) (i32.const 0xFFFF)))
(func $cxdec (result i32)
  (global.set $cx (i32.or (i32.and (global.get $cx) (i32.const 0xFFFF0000))
                          (i32.and (i32.sub (global.get $cx) (i32.const 1)) (i32.const 0xFFFF))))
  (call $cx16))

;; The same two with an address-size override in front, where the counter is
;; the whole of ECX rather than its low half. $cx already holds 32 bits, so
;; these differ from the pair above only in not preserving a high half -- but
;; that difference is the entire point of the prefix, and running the 16-bit
;; version instead reads CX where the program meant ECX.
(func $ecx32 (result i32) (global.get $cx))
(func $ecxdec (result i32)
  (global.set $cx (i32.sub (global.get $cx) (i32.const 1)))
  (global.get $cx))

;; Absolute physical read, for the interrupt vector table at address 0. It is
;; not reachable through $rd16, which always goes via a segment register.
(func $rdphys16 (param $lin i32) (result i32)
  (i32.or
    (i32.load8_u (i32.and (local.get $lin) (i32.const 0xFFFFF)))
    (i32.shl (i32.load8_u (i32.and (i32.add (local.get $lin) (i32.const 1))
                                   (i32.const 0xFFFFF)))
             (i32.const 8))))

;; Stack. SS is segment index 2. SP wraps at whatever width the stack segment
;; is -- 16 bits for a .COM that starts with SP=0xFFFE and pushes, 32 for a
;; flat protected-mode stack, and $spm is the one place that difference lives.
(func $push16 (param $v i32)
  (global.set $sp (i32.and (i32.sub (global.get $sp) (i32.const 2)) (global.get $spm)))
  (call $wr16 (i32.const 2) (global.get $sp) (local.get $v)))

(func $pop16 (result i32)
  (local $v i32)
  (local.set $v (call $rd16 (i32.const 2) (global.get $sp)))
  (global.set $sp (i32.and (i32.add (global.get $sp) (i32.const 2)) (global.get $spm)))
  (local.get $v))

;; A 32-bit push on a 16-bit stack still moves SP by four, and wraps at 16 bits
;; while it does -- which is the case a real-mode demo doing 32-bit maths hits.
(func $push32 (param $v i32)
  (global.set $sp (i32.and (i32.sub (global.get $sp) (i32.const 4)) (global.get $spm)))
  (call $wr32 (i32.const 2) (global.get $sp) (local.get $v)))

(func $pop32 (result i32)
  (local $v i32)
  (local.set $v (call $rd32 (i32.const 2) (global.get $sp)))
  (global.set $sp (i32.and (i32.add (global.get $sp) (i32.const 4)) (global.get $spm)))
  (local.get $v))

;; Eager flags. $s is the UNMASKED sum, so the carry out is still in it.
;; Width is 8 or 16; everything below is written against it rather than
;; branching on it, so the two widths share one path.
;; Publish a whole EFLAGS word and retire any pending record with it. Every
;; eager helper below ends here, so none of them can leave a stale $fop behind
;; to be read back over the flags it just computed.
(func $flags_put (param $v i32)
  (global.set $flags (local.get $v))
  (global.set $fop (i32.const 0)))

;; The whole EFLAGS word, with anything deferred folded in first. This is what
;; PUSHF, LAHF and the interrupt frames read.
(func $flags_word (result i32)
  (call $flags_sync)
  (global.get $flags))

(func $flags_add (param $a i32) (param $b i32) (param $s i32) (param $w i32)
  (local $r i32) (local $msb i32) (local $f i32)
  (local.set $r (i32.and (local.get $s)
    (i32.sub (i32.shl (i32.const 1) (local.get $w)) (i32.const 1))))
  (local.set $msb (i32.sub (local.get $w) (i32.const 1)))
  (local.set $f (i32.and (global.get $flags) (i32.const ${(~isa.FLAGS_ARITH) & 0xFFFF})))
  ;; CF: the bit that fell off the top of the operand width.
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.and (i32.shr_u (local.get $s) (local.get $w)) (i32.const 1))
             (i32.const ${isa.F.CF}))))
  ;; AF: carry out of bit 3, which is a XOR of the three bit-4s.
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.and (i32.shr_u
        (i32.xor (i32.xor (local.get $a) (local.get $b)) (local.get $r))
        (i32.const 4)) (i32.const 1))
      (i32.const ${isa.F.AF}))))
  ;; OF: both inputs differ from the result in the sign bit.
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.and (i32.shr_u
        (i32.and (i32.xor (local.get $a) (local.get $r))
                 (i32.xor (local.get $b) (local.get $r)))
        (local.get $msb)) (i32.const 1))
      (i32.const ${isa.F.OF}))))
  ;; SF, ZF.
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.and (i32.shr_u (local.get $r) (local.get $msb)) (i32.const 1))
             (i32.const ${isa.F.SF}))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.eqz (local.get $r)) (i32.const ${isa.F.ZF}))))
  ;; PF is parity of the LOW BYTE only, at every width, and is SET for EVEN
  ;; parity -- hence the xor 1, which is the whole of the negation. Doing it
  ;; again below would invert it back; that cost one gate run to find.
  (local.set $f (i32.or (local.get $f)
    (i32.shl
      (i32.and (i32.xor (i32.popcnt (i32.and (local.get $r) (i32.const 0xFF))) (i32.const 1))
               (i32.const 1))
      (i32.const ${isa.F.PF}))))
  (call $flags_put (i32.or (local.get $f) ${RESERVED})))

;; SUB/CMP. Same shape as add; only CF and OF read differently.
;; $s is the unmasked difference, so a borrow is still visible above bit w-1.
(func $flags_sub (param $a i32) (param $b i32) (param $s i32) (param $w i32)
  (local $r i32) (local $msb i32) (local $f i32)
  (local.set $r (i32.and (local.get $s)
    (i32.sub (i32.shl (i32.const 1) (local.get $w)) (i32.const 1))))
  (local.set $msb (i32.sub (local.get $w) (i32.const 1)))
  (local.set $f (i32.and (global.get $flags) (i32.const ${(~isa.FLAGS_ARITH) & 0xFFFF})))
  ;; CF is a borrow: a - b went negative, which leaves the bit set above the
  ;; operand width in the 32-bit difference.
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.and (i32.shr_u (local.get $s) (local.get $w)) (i32.const 1))
             (i32.const ${isa.F.CF}))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.and (i32.shr_u
        (i32.xor (i32.xor (local.get $a) (local.get $b)) (local.get $r))
        (i32.const 4)) (i32.const 1))
      (i32.const ${isa.F.AF}))))
  ;; OF: the operands differed in sign AND the result took the source's sign.
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.and (i32.shr_u
        (i32.and (i32.xor (local.get $a) (local.get $b))
                 (i32.xor (local.get $a) (local.get $r)))
        (local.get $msb)) (i32.const 1))
      (i32.const ${isa.F.OF}))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.and (i32.shr_u (local.get $r) (local.get $msb)) (i32.const 1))
             (i32.const ${isa.F.SF}))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.eqz (local.get $r)) (i32.const ${isa.F.ZF}))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl
      (i32.and (i32.xor (i32.popcnt (i32.and (local.get $r) (i32.const 0xFF))) (i32.const 1))
               (i32.const 1))
      (i32.const ${isa.F.PF}))))
  (call $flags_put (i32.or (local.get $f) ${RESERVED})))

;; INC/DEC are add/sub by one that leave CF ALONE. Saving and restoring the
;; bit around the shared helper is cheaper than a second copy of the whole
;; flag computation, and cannot drift from it.
(func $flags_inc (param $a i32) (param $s i32) (param $w i32)
  (local $cf i32)
  (local.set $cf ${CF_IN()})
  (call $flags_add (local.get $a) (i32.const 1) (local.get $s) (local.get $w))
  (global.set $flags (i32.or (i32.and (global.get $flags) (i32.const 0xFFFE))
                             (local.get $cf))))

(func $flags_dec (param $a i32) (param $s i32) (param $w i32)
  (local $cf i32)
  (local.set $cf ${CF_IN()})
  (call $flags_sub (local.get $a) (i32.const 1) (local.get $s) (local.get $w))
  (global.set $flags (i32.or (i32.and (global.get $flags) (i32.const 0xFFFE))
                             (local.get $cf))))

;; AND/OR/XOR. CF and OF are architecturally cleared; AF is genuinely
;; UNDEFINED on this part, so writing 0 here is a choice, not a claim -- the
;; gate masks AF for these mnemonics and says so in its output.
(func $flags_logic (param $r i32) (param $w i32)
  (local $f i32)
  (local.set $f (i32.and (global.get $flags) (i32.const ${(~isa.FLAGS_ARITH) & 0xFFFF})))
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.and (i32.shr_u (local.get $r)
        (i32.sub (local.get $w) (i32.const 1))) (i32.const 1))
      (i32.const ${isa.F.SF}))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.eqz (local.get $r)) (i32.const ${isa.F.ZF}))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl
      (i32.and (i32.xor (i32.popcnt (i32.and (local.get $r) (i32.const 0xFF))) (i32.const 1))
               (i32.const 1))
      (i32.const ${isa.F.PF}))))
  (call $flags_put (i32.or (local.get $f) ${RESERVED})))

;; The 32-bit forms cannot share the 8/16 path: those keep the carry visible
;; above the operand width in an unmasked 32-bit result, and at width 32 there
;; is nowhere left to keep it. So the caller hands over the inputs, the carry-in
;; and the already-truncated result, and the carry-out is recovered by
;; comparison instead.
(func $flags_add32 (param $a i32) (param $b i32) (param $cin i32) (param $r i32)
  (local $f i32)
  (local.set $f (i32.and (global.get $flags) (i32.const ${(~isa.FLAGS_ARITH) & 0xFFFF})))
  ;; With no carry in, a wrap shows up as r < a; with one, r == a is also a
  ;; wrap (b was all ones).
  (local.set $f (i32.or (local.get $f)
    (select (i32.le_u (local.get $r) (local.get $a))
            (i32.lt_u (local.get $r) (local.get $a))
            (local.get $cin))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.and (i32.shr_u
        (i32.xor (i32.xor (local.get $a) (local.get $b)) (local.get $r))
        (i32.const 4)) (i32.const 1))
      (i32.const ${isa.F.AF}))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.shr_u
        (i32.and (i32.xor (local.get $a) (local.get $r))
                 (i32.xor (local.get $b) (local.get $r)))
        (i32.const 31))
      (i32.const ${isa.F.OF}))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.shr_u (local.get $r) (i32.const 31)) (i32.const ${isa.F.SF}))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.eqz (local.get $r)) (i32.const ${isa.F.ZF}))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.and (i32.xor (i32.popcnt (i32.and (local.get $r) (i32.const 0xFF)))
                               (i32.const 1)) (i32.const 1))
      (i32.const ${isa.F.PF}))))
  (call $flags_put (i32.or (local.get $f) ${RESERVED})))

(func $flags_sub32 (param $a i32) (param $b i32) (param $cin i32) (param $r i32)
  (local $f i32)
  (local.set $f (i32.and (global.get $flags) (i32.const ${(~isa.FLAGS_ARITH) & 0xFFFF})))
  (local.set $f (i32.or (local.get $f)
    (select (i32.le_u (local.get $a) (local.get $b))
            (i32.lt_u (local.get $a) (local.get $b))
            (local.get $cin))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.and (i32.shr_u
        (i32.xor (i32.xor (local.get $a) (local.get $b)) (local.get $r))
        (i32.const 4)) (i32.const 1))
      (i32.const ${isa.F.AF}))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.shr_u
        (i32.and (i32.xor (local.get $a) (local.get $b))
                 (i32.xor (local.get $a) (local.get $r)))
        (i32.const 31))
      (i32.const ${isa.F.OF}))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.shr_u (local.get $r) (i32.const 31)) (i32.const ${isa.F.SF}))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.eqz (local.get $r)) (i32.const ${isa.F.ZF}))))
  (local.set $f (i32.or (local.get $f)
    (i32.shl (i32.and (i32.xor (i32.popcnt (i32.and (local.get $r) (i32.const 0xFF)))
                               (i32.const 1)) (i32.const 1))
      (i32.const ${isa.F.PF}))))
  (call $flags_put (i32.or (local.get $f) ${RESERVED})))

(func $flags_inc32 (param $a i32) (param $r i32)
  (local $cf i32)
  (local.set $cf ${CF_IN()})
  (call $flags_add32 (local.get $a) (i32.const 1) (i32.const 0) (local.get $r))
  (global.set $flags (i32.or (i32.and (global.get $flags) (i32.const 0xFFFE))
                             (local.get $cf))))

(func $flags_dec32 (param $a i32) (param $r i32)
  (local $cf i32)
  (local.set $cf ${CF_IN()})
  (call $flags_sub32 (local.get $a) (i32.const 1) (i32.const 0) (local.get $r))
  (global.set $flags (i32.or (i32.and (global.get $flags) (i32.const 0xFFFE))
                             (local.get $cf))))

;; MUL/IMUL set CF and OF together from "the upper half carries information"
;; and leave SF/ZF/AF/PF undefined. $nz is the caller's answer to that question.
(func $flags_mul (param $nz i32)
  (local $f i32)
  ;; A partial write: CF and OF come from $nz and everything else is preserved,
  ;; so whatever is still deferred has to be folded into the word first or it
  ;; would be preserved from before the last ALU instruction instead of after.
  (call $flags_sync)
  (local.set $f (i32.and (global.get $flags)
    (i32.const ${(~((1 << isa.F.CF) | (1 << isa.F.OF))) & 0xFFFF})))
  (local.set $nz (i32.ne (local.get $nz) (i32.const 0)))
  (global.set $flags (i32.or (i32.or (local.get $f)
    (i32.or (local.get $nz) (i32.shl (local.get $nz) (i32.const ${isa.F.OF}))))
    ${RESERVED})))

;; --- Lazy flags: record, read one bit, materialize -------------------------
;;
;; The recorders are what the hot ALU paths call instead of the eager helpers
;; above. They store the inputs and stop; nothing is computed until something
;; asks. $fr is masked here rather than in the getters so that ZF, SF and PF --
;; which do not care which rule produced the result -- need no branch on $fop.
;;
;; $fu stays UNmasked because at 8 and 16 bits that is where the carry out
;; lives. At 32 there is nowhere above the width to keep it, so those two
;; recorders take the already-truncated result and the carry IN, and $get_cf
;; recovers the carry by comparison -- the same split the eager helpers make,
;; and for the same reason.
(func $rec_add (param $a i32) (param $b i32) (param $s i32) (param $w i32)
  (global.set $fa (local.get $a)) (global.set $fb (local.get $b))
  (global.set $fu (local.get $s)) (global.set $fw (local.get $w))
  (global.set $fr (i32.and (local.get $s)
    (i32.sub (i32.shl (i32.const 1) (local.get $w)) (i32.const 1))))
  (global.set $fop (i32.const ${FOP.ADD})))

(func $rec_sub (param $a i32) (param $b i32) (param $s i32) (param $w i32)
  (global.set $fa (local.get $a)) (global.set $fb (local.get $b))
  (global.set $fu (local.get $s)) (global.set $fw (local.get $w))
  (global.set $fr (i32.and (local.get $s)
    (i32.sub (i32.shl (i32.const 1) (local.get $w)) (i32.const 1))))
  (global.set $fop (i32.const ${FOP.SUB})))

;; AND/OR/XOR/TEST: CF, OF and AF are architecturally 0 (AF is UNDEFINED and 0
;; is the choice the eager helper already made), so only the result is kept.
(func $rec_logic (param $r i32) (param $w i32)
  (global.set $fr (local.get $r)) (global.set $fw (local.get $w))
  (global.set $fop (i32.const ${FOP.LOGIC})))

(func $rec_add32 (param $a i32) (param $b i32) (param $cin i32) (param $r i32)
  (global.set $fa (local.get $a)) (global.set $fb (local.get $b))
  (global.set $fcf (local.get $cin)) (global.set $fr (local.get $r))
  (global.set $fw (i32.const 32))
  (global.set $fop (i32.const ${FOP.ADD32})))

(func $rec_sub32 (param $a i32) (param $b i32) (param $cin i32) (param $r i32)
  (global.set $fa (local.get $a)) (global.set $fb (local.get $b))
  (global.set $fcf (local.get $cin)) (global.set $fr (local.get $r))
  (global.set $fw (i32.const 32))
  (global.set $fop (i32.const ${FOP.SUB32})))

;; INC/DEC are add/sub by one that leave CF ALONE, so the carry has to be
;; resolved NOW -- it is the one flag whose value comes from before this
;; instruction and cannot be recomputed from its inputs afterwards.
(func $rec_inc (param $a i32) (param $s i32) (param $w i32)
  (local $cf i32)
  (local.set $cf (call $get_cf))
  (call $rec_add (local.get $a) (i32.const 1) (local.get $s) (local.get $w))
  (global.set $fcf (local.get $cf))
  (global.set $fop (i32.const ${FOP.INC})))

(func $rec_dec (param $a i32) (param $s i32) (param $w i32)
  (local $cf i32)
  (local.set $cf (call $get_cf))
  (call $rec_sub (local.get $a) (i32.const 1) (local.get $s) (local.get $w))
  (global.set $fcf (local.get $cf))
  (global.set $fop (i32.const ${FOP.DEC})))

(func $rec_inc32 (param $a i32) (param $r i32)
  (local $cf i32)
  (local.set $cf (call $get_cf))
  (call $rec_add32 (local.get $a) (i32.const 1) (i32.const 0) (local.get $r))
  (global.set $fcf (local.get $cf))
  (global.set $fop (i32.const ${FOP.INC32})))

(func $rec_dec32 (param $a i32) (param $r i32)
  (local $cf i32)
  (local.set $cf (call $get_cf))
  (call $rec_sub32 (local.get $a) (i32.const 1) (i32.const 0) (local.get $r))
  (global.set $fcf (local.get $cf))
  (global.set $fop (i32.const ${FOP.DEC32})))

;; The getters. $fop 0 means nothing is pending and the word is authoritative,
;; which is the state every non-arithmetic path leaves behind.
;;
;; ZF, SF and PF read straight off $fr with no test on which rule produced it.
;; That is the point of masking at record time: ZF is the most consumed flag in
;; the corpus by a wide margin (cmp/jz is 6.0% of all dispatches on its own),
;; and it costs a compare.
(func $get_zf (result i32)
  (if (i32.eqz (global.get $fop))
    (then (return (i32.and (i32.shr_u (global.get $flags) (i32.const ${F.ZF}))
                           (i32.const 1)))))
  (i32.eqz (global.get $fr)))

(func $get_sf (result i32)
  (if (i32.eqz (global.get $fop))
    (then (return (i32.and (i32.shr_u (global.get $flags) (i32.const ${F.SF}))
                           (i32.const 1)))))
  (i32.and (i32.shr_u (global.get $fr)
             (i32.sub (global.get $fw) (i32.const 1)))
           (i32.const 1)))

;; Parity of the LOW BYTE only, at every width, SET for EVEN parity.
(func $get_pf (result i32)
  (if (i32.eqz (global.get $fop))
    (then (return (i32.and (i32.shr_u (global.get $flags) (i32.const ${F.PF}))
                           (i32.const 1)))))
  (i32.and (i32.xor (i32.popcnt (i32.and (global.get $fr) (i32.const 0xFF)))
                    (i32.const 1))
           (i32.const 1)))

;; CF is the one that has to know the rule. SUB first: cmp is the commonest
;; recorded op in the corpus and jb/jae the commonest carry readers.
(func $get_cf (result i32)
  (local $op i32)
  (local.set $op (global.get $fop))
  (if (i32.eqz (local.get $op))
    (then (return (i32.and (global.get $flags) (i32.const 1)))))
  (if (i32.or (i32.eq (local.get $op) (i32.const ${FOP.SUB}))
              (i32.eq (local.get $op) (i32.const ${FOP.ADD})))
    (then (return (i32.and (i32.shr_u (global.get $fu) (global.get $fw))
                           (i32.const 1)))))
  (if (i32.eq (local.get $op) (i32.const ${FOP.LOGIC}))
    (then (return (i32.const 0))))
  ;; At width 32 a wrap shows up as r < a with no carry in, and r == a is also
  ;; a wrap with one (b was all ones). Subtract compares the operands instead.
  (if (i32.eq (local.get $op) (i32.const ${FOP.ADD32}))
    (then (return (select (i32.le_u (global.get $fr) (global.get $fa))
                          (i32.lt_u (global.get $fr) (global.get $fa))
                          (global.get $fcf)))))
  (if (i32.eq (local.get $op) (i32.const ${FOP.SUB32}))
    (then (return (select (i32.le_u (global.get $fa) (global.get $fb))
                          (i32.lt_u (global.get $fa) (global.get $fb))
                          (global.get $fcf)))))
  ;; INC/DEC in either width: the carry from before the instruction.
  (global.get $fcf))

;; OF: for a sum, both inputs differ from the result in the sign bit; for a
;; difference, the operands differed and the result took the source's sign.
;; INC shares ADD's rule and DEC shares SUB's, so the test is only "was this a
;; subtract".
(func $get_of (result i32)
  (local $op i32) (local $msb i32)
  (local.set $op (global.get $fop))
  (if (i32.eqz (local.get $op))
    (then (return (i32.and (i32.shr_u (global.get $flags) (i32.const ${F.OF}))
                           (i32.const 1)))))
  (if (i32.eq (local.get $op) (i32.const ${FOP.LOGIC}))
    (then (return (i32.const 0))))
  (local.set $msb (i32.sub (global.get $fw) (i32.const 1)))
  (if (i32.or (i32.or (i32.eq (local.get $op) (i32.const ${FOP.SUB}))
                      (i32.eq (local.get $op) (i32.const ${FOP.SUB32})))
              (i32.or (i32.eq (local.get $op) (i32.const ${FOP.DEC}))
                      (i32.eq (local.get $op) (i32.const ${FOP.DEC32}))))
    (then (return (i32.and (i32.shr_u
        (i32.and (i32.xor (global.get $fa) (global.get $fb))
                 (i32.xor (global.get $fa) (global.get $fr)))
        (local.get $msb)) (i32.const 1)))))
  (i32.and (i32.shr_u
      (i32.and (i32.xor (global.get $fa) (global.get $fr))
               (i32.xor (global.get $fb) (global.get $fr)))
      (local.get $msb)) (i32.const 1)))

;; AF is the carry out of bit 3, a XOR of the three bit-4s, and the formula is
;; the same for add and subtract.
(func $get_af (result i32)
  (if (i32.eqz (global.get $fop))
    (then (return (i32.and (i32.shr_u (global.get $flags) (i32.const ${F.AF}))
                           (i32.const 1)))))
  (if (i32.eq (global.get $fop) (i32.const ${FOP.LOGIC}))
    (then (return (i32.const 0))))
  (i32.and (i32.shr_u
      (i32.xor (i32.xor (global.get $fa) (global.get $fb)) (global.get $fr))
      (i32.const 4)) (i32.const 1)))

;; Fold a pending record into the word and clear it. Everything that reads or
;; writes the whole EFLAGS -- PUSHF, POPF, SAHF/LAHF, the interrupt frames, and
;; every partial writer that preserves flags it does not set -- calls this
;; first, and then works on $flags exactly as it did before laziness existed.
;; Those are all cold paths; they pay for the hot ones staying lazy.
(func $flags_sync
  (local $f i32)
  (if (i32.eqz (global.get $fop)) (then (return)))
  (local.set $f (i32.and (global.get $flags) (i32.const ${(~isa.FLAGS_ARITH) & 0xFFFF})))
  (local.set $f (i32.or (local.get $f) (call $get_cf)))
  (local.set $f (i32.or (local.get $f) (i32.shl (call $get_pf) (i32.const ${F.PF}))))
  (local.set $f (i32.or (local.get $f) (i32.shl (call $get_af) (i32.const ${F.AF}))))
  (local.set $f (i32.or (local.get $f) (i32.shl (call $get_zf) (i32.const ${F.ZF}))))
  (local.set $f (i32.or (local.get $f) (i32.shl (call $get_sf) (i32.const ${F.SF}))))
  (local.set $f (i32.or (local.get $f) (i32.shl (call $get_of) (i32.const ${F.OF}))))
  ;; Clear the record BEFORE publishing, so the getters above cannot be re-read
  ;; against a half-updated word by anything this calls.
  (global.set $fop (i32.const 0))
  (call $flags_put (i32.or (local.get $f) ${RESERVED})))

;; A CPU-raised interrupt. Same sequence as INT -- and the same handing-back to
;; the host, since the vector points at whatever the guest installed.
;; The gate descriptor for one vector, plus one so that zero can mean "none",
;; or 0 when this interrupt does not go through an IDT at all: real mode, a
;; vector past the table's limit, or a gate with its present bit clear.
;;
;; This is what makes a DOS extender's own INT 31h reach the extender. These
;; programs check for a DPMI host with INT 2Fh AX=1687h, are told there is
;; none, and then install one themselves -- an IDT full of gates, pointed at
;; with LIDT. Servicing their INT 31h out of the real-mode vector table sends
;; it to our stub, which reports it as unhandled and leaves the guest to carry
;; on from an address nobody wrote: five programs in the corpus, COUNTDWN.EXE
;; among them, ended up handing back from 0000:003B for exactly that reason.
(func $idtgate (param $vec i32) (result i32) (local $d i32)
  (if (i32.eqz (i32.and (global.get $cr0) (i32.const 1)))
    (then (return (i32.const 0))))
  (if (i32.gt_u (i32.add (i32.shl (local.get $vec) (i32.const 3)) (i32.const 7))
                (i32.and (global.get $idtl) (i32.const 0xFFFF)))
    (then (return (i32.const 0))))
  (local.set $d (i32.and (i32.add (global.get $idtb)
                                  (i32.shl (local.get $vec) (i32.const 3)))
                         (global.get $linmask)))
  (if (i32.eqz (i32.and (i32.load8_u offset=5 (local.get $d)) (i32.const 0x80)))
    (then (return (i32.const 0))))
  (i32.add (local.get $d) (i32.const 1)))

;; Deliver an interrupt: the faults raised by the arithmetic handlers, and INT
;; itself, which is the same sequence with the vector spelled out. Through the
;; IDT when there is one, through the vector table at physical 0 when there is
;; not.
(func $fault (param $vec i32) (param $ip i32)
  (local $v i32) (local $g i32)
  (global.set $intno (local.get $vec))
  (local.set $g (call $idtgate (local.get $vec)))
  ;; A trap taken while the CPU is in virtual-8086 mode is not the same
  ;; sequence at all, and it is the ONLY way off that mode -- there is no
  ;; instruction that clears VM. Handled whole, before the size branch below,
  ;; because a V86 trap always uses a 32-bit gate and always builds the bigger
  ;; frame. With no IDT the fall-through case below still applies and reflects
  ;; the vector straight to the guest's own real-mode handler, which is what a
  ;; reflecting monitor would have done anyway.
  (if (i32.and (local.get $g) (global.get $vm86))
    (then
      (call $v86_to_monitor (i32.sub (local.get $g) (i32.const 1)) (local.get $ip)
                            (local.get $vec))
      (global.set $left (global.get $steps)) (global.set $halt (i32.const 1))
      (return)))
  (if (local.get $g)
    (then
      (local.set $g (i32.sub (local.get $g) (i32.const 1)))
      ;; Bit 3 of the type field separates the 386 gates from the 286 ones: a
      ;; 386 gate takes a doubleword frame and a 32-bit offset split across the
      ;; two ends of the descriptor.
      (if (i32.and (i32.load8_u offset=5 (local.get $g)) (i32.const 8))
        (then
          (call $push32 (call $flags_word))
          (call $push32 (call $sget (i32.const 1)))
          (call $push32 (local.get $ip))
          (local.set $v (i32.or (i32.load16_u (local.get $g))
                                (i32.shl (i32.load16_u offset=6 (local.get $g))
                                         (i32.const 16)))))
        (else
          (call $push16 (call $flags_word))
          (call $push16 (call $sget (i32.const 1)))
          (call $push16 (local.get $ip))
          (local.set $v (i32.load16_u (local.get $g)))))
      ;; An interrupt gate clears IF; a trap gate (bit 0 of the type) leaves it
      ;; alone. Both clear TF.
      (global.set $flags (i32.and (global.get $flags)
        (select (i32.const ${(~(1 << isa.F.TF)) & 0xFFFF})
                (i32.const ${(~((1 << isa.F.IF) | (1 << isa.F.TF))) & 0xFFFF})
                (i32.and (i32.load8_u offset=5 (local.get $g)) (i32.const 1)))))
      (call $sset (i32.const 1) (i32.load16_u offset=2 (local.get $g)))
      (global.set $gip (local.get $v)))
    (else
      (call $push16 (call $flags_word))
      (call $push16 (call $sget (i32.const 1)))
      (call $push16 (local.get $ip))
      (global.set $flags (i32.and (global.get $flags)
        (i32.const ${(~((1 << isa.F.IF) | (1 << isa.F.TF))) & 0xFFFF})))
      (local.set $v (i32.shl (local.get $vec) (i32.const 2)))
      (global.set $gip (call $rdphys16 (local.get $v)))
      (call $sset (i32.const 1) (call $rdphys16 (i32.add (local.get $v) (i32.const 2))))))
  (global.set $left (global.get $steps)) (global.set $halt (i32.const 1)))

;; Going the other way: an IRETD whose frame has VM set, which is how a monitor
;; hands control back to its guest.
;;
;; The frame is the same nine dwords $v86_to_monitor built, and ALL NINE come
;; off -- EIP, CS, EFLAGS, then ESP, SS, ES, DS, FS, GS. Popping only the first
;; three is the trap this was written for and it does not look like a bug from
;; anywhere near where it bites: the guest carries on, the monitor carries on,
;; and the only symptom is that the ring-0 stack does not unwind. daretro.exe
;; lost 0x100 bytes per round trip and ran 1825 of them -- roughly 460KB of
;; stack -- before the monitor's own frame walked off the end and it started
;; printing a register dump.
;;
;; Every pop has to happen while SS is still the monitor's, so the segment
;; registers are read into locals first and published afterwards. And $vm86 goes
;; up before any of them are published, because $sset resolves each one through
;; $segbase and every one of these is a paragraph.
(func \$v86_from_monitor (param \$ip i32) (param \$cs i32) (param \$fl i32)
  (local \$sp i32) (local \$ss i32) (local \$es i32)
  (local \$ds i32) (local \$fs i32) (local \$gs i32)
  (local.set \$sp (call \$pop32))
  (local.set \$ss (call \$pop32))
  (local.set \$es (call \$pop32))
  (local.set \$ds (call \$pop32))
  (local.set \$fs (call \$pop32))
  (local.set \$gs (call \$pop32))
  (global.set \$vm86 (i32.const 1))
  (call \$sset (i32.const 1) (i32.and (local.get \$cs) (i32.const 0xFFFF)))
  (call \$sset (i32.const 2) (i32.and (local.get \$ss) (i32.const 0xFFFF)))
  (call \$sset (i32.const 0) (i32.and (local.get \$es) (i32.const 0xFFFF)))
  (call \$sset (i32.const 3) (i32.and (local.get \$ds) (i32.const 0xFFFF)))
  (call \$sset (i32.const 4) (i32.and (local.get \$fs) (i32.const 0xFFFF)))
  (call \$sset (i32.const 5) (i32.and (local.get \$gs) (i32.const 0xFFFF)))
  ;; \$sset on SS has just republished \$spm, and in V86 that is 16 bits: the
  ;; stack pointer the monitor saved is an ESP image but the guest is an 8086.
  (global.set \$sp (i32.and (local.get \$sp) (global.get \$spm)))
  (global.set \$gip (i32.and (local.get \$ip) (i32.const 0xFFFF)))
  (global.set \$flags (i32.or (i32.and (local.get \$fl) ${DEFINED}) ${RESERVED})))

;; Leaving virtual-8086 mode, which only ever happens through a gate.
;;
;; The frame is six dwords deeper than an ordinary one -- GS, FS, DS, ES, SS,
;; ESP under the usual EFLAGS/CS/EIP -- and it is built on a DIFFERENT stack:
;; the ring-0 one out of the TSS that LTR named, because the V86 guest's own SS
;; is a paragraph and means nothing at CPL0. Every V86 monitor unwinds exactly
;; this shape, so getting the order or the stack wrong does not produce a
;; slightly wrong monitor, it produces one reading its own locals as a register
;; image.
;;
;; The EFLAGS pushed still has VM set even though the mode is already off by
;; then. That is deliberate and is the hardware's contract: the bit in the frame
;; is how the monitor knows this trap came from a V86 guest rather than from
;; protected-mode code, and it is also what an IRETD back into the guest reads
;; to restore the mode.
(func $v86_to_monitor (param $g i32) (param $ip i32) (param $vec i32)
  (local $ss i32) (local $sp i32) (local $t i32)
  (local.set $ss (call $sget (i32.const 2)))
  (local.set $sp (global.get $sp))
  ;; ESP0 at +4 and SS0 at +8 of the 32-bit TSS. $tr holds the selector LTR was
  ;; given; the base comes out of its GDT descriptor like any other.
  (local.set $t (i32.and (call $descbase (global.get $gdtb) (global.get $tr))
                         (global.get $linmask)))
  ;; Off the mode BEFORE the new SS is loaded, or $segbase reads the ring-0
  ;; stack selector as a paragraph and the monitor's stack lands at 0x100.
  (global.set $vm86 (i32.const 0))
  (call $sset (i32.const 2) (i32.load16_u offset=8 (local.get $t)))
  (global.set $sp (i32.load offset=4 (local.get $t)))
  (call $push32 (call $sget (i32.const 5)))
  (call $push32 (call $sget (i32.const 4)))
  (call $push32 (call $sget (i32.const 3)))
  (call $push32 (call $sget (i32.const 0)))
  (call $push32 (local.get $ss))
  (call $push32 (local.get $sp))
  (call $push32 (i32.or (call $flags_word) (i32.const 0x20000)))
  (call $push32 (call $sget (i32.const 1)))
  (call $push32 (local.get $ip))
  ;; #DF, #TS, #NP, #SS, #GP, #PF and #AC carry an error code, pushed last so
  ;; it sits under the handler's ESP. Everything else leaves the frame at nine
  ;; dwords, and a handler that pops one anyway would take the guest's EIP.
  (if (i32.or (i32.eq (local.get $vec) (i32.const 8))
              (i32.or (i32.and (i32.ge_u (local.get $vec) (i32.const 10))
                               (i32.le_u (local.get $vec) (i32.const 14)))
                      (i32.eq (local.get $vec) (i32.const 17))))
    (then (call $push32 (global.get $errc))))
  (global.set $errc (i32.const 0))
  ;; The guest's data selectors are paragraphs and cannot be revalidated at
  ;; CPL0, so the hardware zeroes them rather than leave them loadable.
  (call $sset (i32.const 0) (i32.const 0))
  (call $sset (i32.const 3) (i32.const 0))
  (call $sset (i32.const 4) (i32.const 0))
  (call $sset (i32.const 5) (i32.const 0))
  ;; Same gate semantics as the ordinary path: a trap gate leaves IF alone, an
  ;; interrupt gate clears it, both clear TF.
  (global.set $flags (i32.and (global.get $flags)
    (select (i32.const ${(~(1 << isa.F.TF)) & 0xFFFF})
            (i32.const ${(~((1 << isa.F.IF) | (1 << isa.F.TF))) & 0xFFFF})
            (i32.and (i32.load8_u offset=5 (local.get $g)) (i32.const 1)))))
  (call $sset (i32.const 1) (i32.load16_u offset=2 (local.get $g)))
  (global.set $gip (i32.or (i32.load16_u (local.get $g))
                           (i32.shl (i32.load16_u offset=6 (local.get $g))
                                    (i32.const 16)))))

;; A software interrupt is not a fault, and the difference only shows up in
;; virtual-8086 mode. The guest runs at CPL 3, and for the software-generated
;; vectors -- INT n, INT3, INTO -- the 386 checks the gate's DPL against CPL
;; and raises #GP(vec*8+2) when the gate is more privileged. Every gate in
;; daretro's IDT is DPL 0 (type byte 0x8E), which is exactly how its monitor
;; funnels the guest's int 10h -- and every other INT the guest issues --
;; into the one #GP handler at 8:22fa that reads the opcode back and reflects
;; it. Taking vector 0x10's own gate instead lands in the catch-all
;; "unexpected interrupt" register printer at 8:23f9, which is what the guest
;; did on 1825 consecutive round trips without ever advancing an instruction.
;;
;; A fault reports the address OF the instruction, not the one after it,
;; because the handler has to be able to decode it -- hence the third operand.
(func $faultsw (param $vec i32) (param $next i32) (param $ip i32)
  (local $g i32)
  (if (global.get $vm86)
    (then
      (local.set $g (call $idtgate (local.get $vec)))
      ;; No gate is a #GP as well, not a fall-back to the vector table at
      ;; physical 0: daretro's IDT stops at vector 0x30, and the int 0xfd its
      ;; V86 thunk signs off with is how it asks the monitor to take the CPU
      ;; back. Serviced out of the IVT instead, that INT reached our own DOS
      ;; stub, came back reported as unhandled, and the demo took its abort
      ;; path to int 21h/4Ch.
      (if (i32.eqz (i32.and (local.get $g)
                            (i32.eq (i32.and (i32.shr_u (i32.load8_u offset=4 (local.get $g))
                                                        (i32.const 5))
                                             (i32.const 3))
                                    (i32.const 3))))
        (then
          (global.set $errc (i32.or (i32.shl (local.get $vec) (i32.const 3))
                                    (i32.const 2)))
          (call $fault (i32.const 13) (local.get $ip))
          (return)))))
  (call $fault (local.get $vec) (local.get $next)))

;; Divide error -- the only fault the arithmetic handlers raise.
(func $fault0 (param $ip i32)
  (call $fault (i32.const 0) (local.get $ip)))

;; --- shadow return stack --------------------------------------------------
;; Push is skipped, not truncated, when there is no arena address to resume at
;; or the stack is full; the matching pop then misses, resets, and takes the
;; slow path. Correctness never depends on this being right, only speed.
(func $rpush (param $ip i32) (param $arena i32)
  (local $a i32)
  (if (i32.eqz (local.get $arena)) (then (return)))
  (if (i32.ge_u (global.get $rtop) (i32.const ${isa.RSTACK_ENTRIES})) (then (return)))
  (local.set $a (i32.add (i32.const ${isa.RSTACK_BASE})
                         (i32.mul (global.get $rtop) (i32.const 12))))
  (i32.store offset=0 (local.get $a) (local.get $ip))
  (i32.store offset=4 (local.get $a) (local.get $arena))
  (i32.store offset=8 (local.get $a) (call $sget (i32.const 1)))
  (global.set $rtop (i32.add (global.get $rtop) (i32.const 1))))

;; Returns the arena address to resume at, or 0 to hand back. A miss empties the
;; stack: once one frame is wrong every frame under it is suspect, and a wrong
;; guess here would resume in the middle of unrelated code.
(func $rpop (param $ip i32) (result i32)
  (local $a i32)
  (if (i32.eqz (global.get $rtop)) (then (return (i32.const 0))))
  (local.set $a (i32.add (i32.const ${isa.RSTACK_BASE})
                         (i32.mul (i32.sub (global.get $rtop) (i32.const 1)) (i32.const 12))))
  (if (i32.and (i32.eq (i32.load offset=0 (local.get $a)) (local.get $ip))
               (i32.eq (i32.load offset=8 (local.get $a)) (call $sget (i32.const 1))))
    (then
      (global.set $rtop (i32.sub (global.get $rtop) (i32.const 1)))
      (return (i32.load offset=4 (local.get $a)))))
  (global.set $rtop (i32.const 0))
  (i32.const 0))

;; Indirect-jump target lookup. The key is the offset and the selector, checked
;; separately, so a trace compiled for one segment can never be entered from
;; another and two offsets 64KB apart in a flat segment cannot be confused.
;;
;; ...and the selector's BASE, which is a third thing and not implied by the
;; other two. A selector is a name, not an address: PMODE/W reuses the numbers
;; it was just using as real-mode paragraphs, so 0x1faf can mean linear 0x1faf0
;; before a mode switch and whatever a descriptor says after one. The JS-side
;; cache has always known this -- DosCache.regions is keyed on the linear base
;; for exactly this reason -- but this table was keyed on the selector alone,
;; which was survivable while only the far forms that already leave wasm could
;; reach it. Now that a far RET resolves here, a stale entry would resume the
;; guest in whatever got compiled for the same selector in the other mode.
(func $jlook (param $ip i32) (result i32)
  (local $k i32) (local $a i32)
  (local.set $k (i32.xor (local.get $ip)
                         (i32.shl (call $sget (i32.const 1)) (i32.const 16))))
  (local.set $a (i32.add (i32.const ${isa.JTAB_BASE}) (i32.mul
    (i32.and (i32.shr_u (i32.mul (local.get $k) (i32.const ${isa.JTAB_HASH_MUL}))
                        (i32.const 16))
             (i32.const ${isa.JTAB_ENTRIES - 1}))
    (i32.const ${isa.JTAB_STRIDE}))))
  (if (i32.and (i32.eq (i32.load offset=0 (local.get $a)) (local.get $ip))
               (i32.and (i32.eq (i32.load offset=4 (local.get $a)) (call $sget (i32.const 1)))
                        (i32.eq (i32.load offset=12 (local.get $a)) (global.get $csb))))
    (then (return (i32.load offset=8 (local.get $a)))))
  (i32.const 0))
${SHIFT_FNS.join('')}${fpuHelpers()}${require('./emit-decoder').decoderWat()}`;
  return s;
}

// --- x87 --------------------------------------------------------------------
// Eight f64 globals and a rotating TOP, which is what the register file
// actually is: ST(i) names the global at (TOP + i) & 7, and a push moves TOP
// rather than moving eight values. f64 and not the real 80-bit format -- the
// 11 extra mantissa bits change the last digit of a fixed-point coordinate and
// nothing a demo puts on screen, and modelling them would mean an f80 softfloat
// under every arithmetic handler.
//
// $ftag is one bit per physical register, set when it holds something. The real
// tag word is two bits and distinguishes zero and special from valid; only
// empty-vs-occupied is ever read here (FFREE, FXAM, and the stack-fault check
// that is not modelled).
function fpuHelpers() {
  const idx = '(i32.and (i32.add (global.get $ftop) (local.get $i)) (i32.const 7))';
  let s = brTableFn('fget', '(param $i i32)', '(result f64)',
    [...Array(8).keys()].map(i => `(return (global.get $st${i}))`));
  s += brTableFn('fset', '(param $i i32) (param $v f64)', '',
    [...Array(8).keys()].map(i => `(global.set $st${i} (local.get $v)) (return)`));
  s += `
;; ST(i), by the rotating top.
(func $fst_get (param $i i32) (result f64) (call $fget ${idx}))
(func $fst_set (param $i i32) (param $v f64) (call $fset ${idx} (local.get $v)))

(func $fpush (param $v f64)
  (global.set $ftop (i32.and (i32.sub (global.get $ftop) (i32.const 1)) (i32.const 7)))
  (global.set $ftag (i32.or (global.get $ftag) (i32.shl (i32.const 1) (global.get $ftop))))
  (call $fset (global.get $ftop) (local.get $v)))

(func $fpop
  (global.set $ftag (i32.and (global.get $ftag)
    (i32.xor (i32.shl (i32.const 1) (global.get $ftop)) (i32.const -1))))
  (global.set $ftop (i32.and (i32.add (global.get $ftop) (i32.const 1)) (i32.const 7))))

;; Single and double precision in memory. Both go through the byte-at-a-time
;; accessors so a 16-bit offset still wraps inside its segment.
(func $fmr32 (param $seg i32) (param $off i32) (result f64)
  (f64.promote_f32 (f32.reinterpret_i32 (call $rd32 (local.get $seg) (local.get $off)))))
(func $fmw32 (param $seg i32) (param $off i32) (param $v f64)
  (call $wr32 (local.get $seg) (local.get $off)
    (i32.reinterpret_f32 (f32.demote_f64 (local.get $v)))))
(func $fmr64 (param $seg i32) (param $off i32) (result f64)
  (f64.reinterpret_i64 (i64.or
    (i64.extend_i32_u (call $rd32 (local.get $seg) (local.get $off)))
    (i64.shl (i64.extend_i32_u (call $rd32 (local.get $seg)
                                 (call $off_add (local.get $off) (i32.const 4))))
             (i64.const 32)))))
(func $fmw64 (param $seg i32) (param $off i32) (param $v f64)
  (local $b i64)
  (local.set $b (i64.reinterpret_f64 (local.get $v)))
  (call $wr32 (local.get $seg) (local.get $off) (i32.wrap_i64 (local.get $b)))
  (call $wr32 (local.get $seg) (call $off_add (local.get $off) (i32.const 4))
    (i32.wrap_i64 (i64.shr_u (local.get $b) (i64.const 32)))))

;; 80-bit extended, the format FLD/FSTP m80 and the FPU's own save area use.
;; Sign and a 15-bit exponent in the top word, an explicit 64-bit mantissa
;; below it -- explicit, unlike every other IEEE format, so there is no hidden
;; bit to restore. The value is mantissa * 2^(exp - 16383 - 63).
(func $fmr80 (param $seg i32) (param $off i32) (result f64)
  (local $m i64) (local $e i32) (local $v f64)
  (local.set $m (i64.or
    (i64.extend_i32_u (call $rd32 (local.get $seg) (local.get $off)))
    (i64.shl (i64.extend_i32_u (call $rd32 (local.get $seg)
                                 (call $off_add (local.get $off) (i32.const 4))))
             (i64.const 32))))
  (local.set $e (call $rd16 (local.get $seg) (call $off_add (local.get $off) (i32.const 8))))
  (local.set $v (f64.mul
    (f64.convert_i64_u (local.get $m))
    (call $pow2 (i32.sub (i32.and (local.get $e) (i32.const 0x7FFF)) (i32.const 16446)))))
  (if (i32.and (local.get $e) (i32.const 0x8000))
    (then (local.set $v (f64.neg (local.get $v)))))
  (local.get $v))

(func $fmw80 (param $seg i32) (param $off i32) (param $v f64)
  (local $b i64) (local $e i32) (local $m i64)
  (local.set $b (i64.reinterpret_f64 (local.get $v)))
  (local.set $e (i32.wrap_i64 (i64.and (i64.shr_u (local.get $b) (i64.const 52))
                                       (i64.const 0x7FF))))
  (local.set $m (i64.and (local.get $b) (i64.const 0xFFFFFFFFFFFFF)))
  (if (i32.eqz (local.get $e))
    ;; Zero or subnormal: an f64 subnormal is far below the 80-bit format's
    ;; range boundary, so it stores as a zero-exponent value with no implicit
    ;; bit rather than being renormalised.
    (then (local.set $m (i64.shl (local.get $m) (i64.const 11))))
    (else
      (local.set $m (i64.or (i64.shl (local.get $m) (i64.const 11))
                            (i64.const 0x8000000000000000)))
      (local.set $e (i32.add (local.get $e) (i32.const ${16383 - 1023})))))
  (call $wr32 (local.get $seg) (local.get $off) (i32.wrap_i64 (local.get $m)))
  (call $wr32 (local.get $seg) (call $off_add (local.get $off) (i32.const 4))
    (i32.wrap_i64 (i64.shr_u (local.get $m) (i64.const 32))))
  (call $wr16 (local.get $seg) (call $off_add (local.get $off) (i32.const 8))
    (i32.or (local.get $e)
      (i32.wrap_i64 (i64.shr_u (i64.and (local.get $b) (i64.const 0x8000000000000000))
                               (i64.const 48))))))

;; 2^k, built out of the exponent field rather than by multiplying. Saturates
;; to 0 and infinity outside f64's range, which is what the arithmetic that
;; follows would produce anyway.
(func $pow2 (param $k i32) (result f64)
  (if (i32.lt_s (local.get $k) (i32.const -1074)) (then (return (f64.const 0))))
  (if (i32.gt_s (local.get $k) (i32.const 1023))
    (then (return (f64.reinterpret_i64 (i64.const 0x7FF0000000000000)))))
  (if (i32.lt_s (local.get $k) (i32.const -1022))
    ;; Subnormal territory: halve twice rather than build a denormal bit pattern.
    (then (return (f64.mul (call $pow2 (i32.add (local.get $k) (i32.const 512)))
                           (call $pow2 (i32.const -512))))))
  (f64.reinterpret_i64 (i64.shl
    (i64.extend_i32_u (i32.add (local.get $k) (i32.const 1023))) (i64.const 52))))

;; Rounding, per the control word's RC field. 00 nearest-even, 01 down, 10 up,
;; 11 truncate -- and 11 is not a corner case: a demo that converts floats to
;; screen coordinates sets it once at startup and leaves it there, so getting
;; this wrong moves every pixel it draws.
(func $fround (param $v f64) (result f64)
  (local $rc i32)
  (local.set $rc (i32.and (i32.shr_u (global.get $fcw) (i32.const 10)) (i32.const 3)))
  (if (i32.eqz (local.get $rc)) (then (return (f64.nearest (local.get $v)))))
  (if (i32.eq (local.get $rc) (i32.const 1)) (then (return (f64.floor (local.get $v)))))
  (if (i32.eq (local.get $rc) (i32.const 2)) (then (return (f64.ceil (local.get $v)))))
  (f64.trunc (local.get $v)))

;; The three condition-code bits FCOM writes, in status-word positions.
;; Unordered sets all three, which is how a NaN compare is told from a real one.
(func $fcmp (param $a f64) (param $b f64)
  (local $c i32)
  (local.set $c (i32.const ${(1 << 14) | (1 << 10) | (1 << 8)}))   ;; C3 C2 C0
  (if (f64.eq (local.get $a) (local.get $b)) (then (local.set $c (i32.const ${1 << 14}))))
  (if (f64.lt (local.get $a) (local.get $b)) (then (local.set $c (i32.const ${1 << 8}))))
  (if (f64.gt (local.get $a) (local.get $b)) (then (local.set $c (i32.const 0))))
  (global.set $fsw (i32.or
    (i32.and (global.get $fsw) (i32.const ${~((1 << 14) | (1 << 10) | (1 << 9) | (1 << 8)) & 0xFFFF}))
    (local.get $c))))

;; The 14-byte real-mode environment FSTENV/FLDENV move, and the 94-byte block
;; FSAVE/FRSTOR move on top of it (env + eight 80-bit registers, top of stack
;; first). The four instruction/data pointer fields are written as zero: they
;; record where the last FPU instruction and its operand were, which only a
;; numeric exception handler reads, and nothing here raises one. A program that
;; uses FSTENV to find out what its own control word is -- which is the common
;; real use -- gets the right answer.
(func $fenv_save (param $seg i32) (param $off i32)
  (local $i i32) (local $tw i32)
  ;; Tag word: two bits per PHYSICAL register, 00 valid and 11 empty. $ftag is
  ;; one bit per physical register, so this is a spread, not a copy.
  (local.set $tw (i32.const 0))
  (local.set $i (i32.const 0))
  (block $done (loop $l
    (br_if $done (i32.eq (local.get $i) (i32.const 8)))
    (if (i32.eqz (i32.and (global.get $ftag) (i32.shl (i32.const 1) (local.get $i))))
      (then (local.set $tw (i32.or (local.get $tw)
        (i32.shl (i32.const 3) (i32.shl (local.get $i) (i32.const 1)))))))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $l)))
  (call $wr16 (local.get $seg) (local.get $off) (global.get $fcw))
  (call $wr16 (local.get $seg) (call $off_add (local.get $off) (i32.const 2))
    (i32.or (i32.and (global.get $fsw) (i32.const 0xC7FF))
            (i32.shl (global.get $ftop) (i32.const 11))))
  (call $wr16 (local.get $seg) (call $off_add (local.get $off) (i32.const 4))
    (local.get $tw))
  (local.set $i (i32.const 6))
  (block $z (loop $m
    (br_if $z (i32.eq (local.get $i) (i32.const 14)))
    (call $wr16 (local.get $seg) (call $off_add (local.get $off) (local.get $i))
      (i32.const 0))
    (local.set $i (i32.add (local.get $i) (i32.const 2)))
    (br $m))))

(func $fenv_load (param $seg i32) (param $off i32)
  (local $i i32) (local $tw i32) (local $sw i32)
  (global.set $fcw (call $rd16 (local.get $seg) (local.get $off)))
  (local.set $sw (call $rd16 (local.get $seg) (call $off_add (local.get $off) (i32.const 2))))
  (global.set $ftop (i32.and (i32.shr_u (local.get $sw) (i32.const 11)) (i32.const 7)))
  (global.set $fsw (i32.and (local.get $sw) (i32.const 0xC7FF)))
  (local.set $tw (call $rd16 (local.get $seg) (call $off_add (local.get $off) (i32.const 4))))
  (local.set $i (i32.const 0))
  (global.set $ftag (i32.const 0))
  (block $done (loop $l
    (br_if $done (i32.eq (local.get $i) (i32.const 8)))
    (if (i32.ne (i32.and (i32.shr_u (local.get $tw) (i32.shl (local.get $i) (i32.const 1)))
                         (i32.const 3))
                (i32.const 3))
      (then (global.set $ftag (i32.or (global.get $ftag)
        (i32.shl (i32.const 1) (local.get $i))))))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $l))))

(func $fstate_save (param $seg i32) (param $off i32)
  (local $i i32)
  (call $fenv_save (local.get $seg) (local.get $off))
  (local.set $i (i32.const 0))
  (block $done (loop $l
    (br_if $done (i32.eq (local.get $i) (i32.const 8)))
    (call $fmw80 (local.get $seg)
      (call $off_add (local.get $off) (i32.add (i32.const 14)
        (i32.mul (local.get $i) (i32.const 10))))
      (call $fst_get (local.get $i)))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $l))))

(func $fstate_load (param $seg i32) (param $off i32)
  (local $i i32)
  (call $fenv_load (local.get $seg) (local.get $off))
  (local.set $i (i32.const 0))
  (block $done (loop $l
    (br_if $done (i32.eq (local.get $i) (i32.const 8)))
    (call $fst_set (local.get $i) (call $fmr80 (local.get $seg)
      (call $off_add (local.get $off) (i32.add (i32.const 14)
        (i32.mul (local.get $i) (i32.const 10))))))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $l))))

;; Packed BCD, the 10-byte format FBLD and FBSTP move: eighteen digits, two per
;; byte low nibble first, and a sign bit at the top of byte 9. It exists because
;; a DOS program printing a float in decimal has no other cheap way to get the
;; digits, so a demo's score display can depend on it.
(func $fbcd_read (param $seg i32) (param $off i32) (result f64)
  (local $i i32) (local $b i32) (local $v f64)
  (local.set $v (f64.const 0))
  (local.set $i (i32.const 8))
  (block $done (loop $l
    (br_if $done (i32.lt_s (local.get $i) (i32.const 0)))
    (local.set $b (call $rd8 (local.get $seg)
      (call $off_add (local.get $off) (local.get $i))))
    (local.set $v (f64.add (f64.mul (local.get $v) (f64.const 100))
      (f64.convert_i32_u (i32.add
        (i32.mul (i32.shr_u (local.get $b) (i32.const 4)) (i32.const 10))
        (i32.and (local.get $b) (i32.const 15))))))
    (local.set $i (i32.sub (local.get $i) (i32.const 1)))
    (br $l)))
  (if (i32.and (call $rd8 (local.get $seg)
                 (call $off_add (local.get $off) (i32.const 9)))
               (i32.const 0x80))
    (then (local.set $v (f64.neg (local.get $v)))))
  (local.get $v))

(func $fbcd_write (param $seg i32) (param $off i32) (param $v f64)
  (local $i i32) (local $n i64) (local $d i32)
  ;; Round first: FBSTP stores an integer, and the control word's RC decides
  ;; which one, exactly as it does for FISTP.
  (local.set $n (i64.trunc_sat_f64_s (call $fround (f64.abs (local.get $v)))))
  (local.set $i (i32.const 0))
  (block $done (loop $l
    (br_if $done (i32.eq (local.get $i) (i32.const 9)))
    (local.set $d (i32.or
      (i32.wrap_i64 (i64.rem_u (local.get $n) (i64.const 10)))
      (i32.shl (i32.wrap_i64 (i64.rem_u (i64.div_u (local.get $n) (i64.const 10))
                                        (i64.const 10)))
               (i32.const 4))))
    (call $wr8 (local.get $seg) (call $off_add (local.get $off) (local.get $i))
      (local.get $d))
    (local.set $n (i64.div_u (local.get $n) (i64.const 100)))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $l)))
  (call $wr8 (local.get $seg) (call $off_add (local.get $off) (i32.const 9))
    (select (i32.const 0x80) (i32.const 0) (f64.lt (local.get $v) (f64.const 0)))))
`;
  return s;
}

// Every piece of guest state is a wasm global, exactly as it is in the real
// interpreter -- that is the thing under test, so the toy must not "improve" on
// it by putting registers in linear memory.
// $intno records which INT vector handed control back, so the host can service
// DOS and BIOS calls in JS instead of the VM pretending to be DOS.
// $left is written only on the rare handback path -- a control transfer the
// trace could not resolve -- and holds the step budget that was still unspent
// there. Without it a run() that bails after 40 steps and one that burns its
// whole slice are indistinguishable, and every dispatch count the harness
// prints is the slice size instead of the work done.
// $halt is what ends a run(), and it is set only where $gip is known good --
// every handback path, and the block boundary the step budget is now spent at
// (see CONT). It exists because $steps cannot do both jobs: the counter has to
// keep running for accounting after the budget is gone, and a return keyed off
// its sign would fire mid-block.
// smclo/smchi bound the linear addresses a slice's self-modifying stores
// landed on, so the host can throw away the compiled regions that actually
// covered them instead of everything it has. A RANGE rather than one address
// because a slice can store into compiled code many times before it hands back
// -- a `rep movsb` over a compiled paragraph does it once per byte -- and
// remembering only the last one would leave the earlier writes running stale
// code, which is the exact bug the flag exists to prevent. Over-approximating
// the gap between two distant stores only costs a recompile.
const STATE = [...isa.REG16, ...isa.SEG, 'gip', 'flags', 'ip', 'steps', 'intno', 'left', 'rtop', 'smc', 'smclo', 'smchi', 'halt'];

// Memory is IMPORTED and state is read through accessor functions rather than
// inline-exported, because that is the shape lib/compile-wat.js actually
// supports. Measured 2026-08-24: it encodes a defined `(memory (export ...) N N)`
// with min=0, and an inline `(global $x (export ...) (mut i32) ...)` with value
// type 0x00, producing a module the engine rejects at +84. Production WAT
// imports its memory (src/01-header.wat:805) and exports state through
// functions in src/13-exports.wat, so neither form has ever been exercised.
// Guest state that is NOT one of the i32 registers in STATE, and so has no
// get_/set_ accessor pair. It lives here rather than inline in preamble()
// because tools/toyvm/trace-jit.js builds its own module around the same
// helpers() body: when these were only in preamble, every one added broke that
// tool with `compile-wat: unknown global`, and nothing in the build says so.
const EXTRA_GLOBALS = `
;; --- Lazy arithmetic flags -------------------------------------------------
;;
;; The eager scheme this replaces computed all six arithmetic flags on every
;; ALU instruction -- CF, AF, OF, SF, ZF and a popcnt for PF -- and threw
;; almost all of them away: the consumer is nearly always a single Jcc reading
;; one bit. $flags_sub was ~35 instructions behind a call, and cmp_ri8 plus
;; cmp_rm8 alone are 7.8% of the corpus's dispatches.
;;
;; So an ALU op now RECORDS its inputs and defers. $fop names the rule; 0 means
;; nothing is pending and the $flags word is authoritative, which is also the
;; state every non-arithmetic path wants to see. This is the scheme
;; src/03-registers.wat uses in the production interpreter, and the toy VM
;; modelling an eager one it had already abandoned was the wrong shape to be
;; measuring against.
;;
;; $fr is the result ALREADY MASKED to the operand width, which is what makes
;; ZF, SF and PF readable without knowing which rule produced them -- only CF,
;; OF and AF have to branch on $fop. That matters because ZF is the single most
;; consumed flag in the corpus.
;;
;; A partial write -- anything that sets some flags and preserves others, like
;; MUL touching only CF and OF, or a shift, or SAHF -- calls $flags_sync first
;; and then works on the word. Cold paths, so they pay for the laziness of the
;; hot ones.
(global $fop (mut i32) (i32.const 0))
(global $fa (mut i32) (i32.const 0))   ;; first operand
(global $fb (mut i32) (i32.const 0))   ;; second operand
;; NOT $fs -- that name is the FS segment register's global, and taking it here
;; silently aliased the two: every recorded ALU result landed in FS, and the
;; gate went to 78/60000 with "fs moved but corpus says unchanged" on every row.
(global $fu (mut i32) (i32.const 0))   ;; UNmasked result: CF at 8/16 bits is
                                       ;; the bit that fell off the top of it
(global $fr (mut i32) (i32.const 0))   ;; result masked to the operand width
(global $fw (mut i32) (i32.const 0))   ;; operand width in bits
(global $fcf (mut i32) (i32.const 0))  ;; carry IN (32-bit adc/sbb), and the
                                       ;; preserved CF that INC/DEC must not
                                       ;; disturb
;; The previous handler index, for the --handler-hist pair table. Declared in
;; every build so the two share one global layout; only an instrumented one
;; ever writes it.
(global $hprev (mut i32) (i32.const 0))
;; The x87 register file: eight f64 values and a rotating TOP. See fpuHelpers.
${[...Array(8).keys()].map(i => `(global $st${i} (mut f64) (f64.const 0))`).join('\n')}
(global $ftop (mut i32) (i32.const 0))
(global $ftag (mut i32) (i32.const 0))
(global $fsw (mut i32) (i32.const 0))
(global $fcw (mut i32) (i32.const 0x037F))
;; CR0 as this machine starts: real mode (PE clear), ET set because the 386
;; encodings are available, no paging. MOV CR0,r and LMSW write it, and setting
;; PE is what puts $segbase on the descriptor path.
(global $cr0 (mut i32) (i32.const 0x0010))
;; EFLAGS.VM, kept out of \$flags on purpose.
;;
;; Virtual-8086 mode is protected mode -- PE stays set -- with segmentation put
;; back the way real mode had it: a selector is a paragraph again, the D bit is
;; gone, and code is 16-bit. So it cannot be modelled by clearing PE, and it
;; cannot live in \$flags either, because every 16-bit POPF and IRET masks the
;; word with \$f_def and would take bit 17 down with it. A separate global is
;; the only place a bit survives both.
;;
;; It is entered exactly one way here, the way the hardware allows: an IRETD
;; from protected mode with bit 17 set in the frame's EFLAGS. daretro.exe does
;; precisely that -- \`pushfd / or eax,0x20000 / push eax\` at 8:22c6, building a
;; frame that drops it back into its own DOS image at 110:3dd. Read without VM
;; that is a protected-mode CS of 0x110 naming no descriptor, which is what the
;; run reported and is not what the program did.
(global \$vm86 (mut i32) (i32.const 0))
;; The error code the next V86 trap frame carries, set by \$faultsw and read by
;; \$v86_to_monitor. Only the vectors that have one push it, and of those only
;; #GP is ever reached from here, but the handler pops a fixed frame either way
;; so getting the presence right matters more than the value.
(global \$errc (mut i32) (i32.const 0))
;; How much of a shift count the hardware looks at, and this is a real part
;; difference rather than a detail. The 8086 shifts the full count, so
;; \`shr ax,32\` clears the register; every part from the 186 on masks the count
;; to five bits, so the same instruction does nothing at all.
;;
;; Programs ask this question ON PURPOSE -- it is the standard 8086-vs-186
;; probe, and COROMER.EXE opens with it:
;;
;;   mov cl,32 / mov ax,1 / shr ax,cl / cmp ax,0 / jnz <186+ path>
;;
;; Answering \"8086\" sent it into an 8086-only follow-up (\`push cs\` and the 0Fh
;; that is POP CS only on that part), where the decoder refused 0F 14 and the
;; run wedged: 200 handbacks at 110:545 and a blank screen.
;;
;; It is a global rather than a constant for the same reason \$linmask is. Both
;; answers are correct, for different machines, and this repository runs both:
;; gate.js checks against vectors recorded on a physical 8088 and needs the
;; unmasked shift (masking cost it 15427 of 70000 cases), while the DOS machine
;; answers CPUID and decodes 0F opcodes and has no business claiming to be an
;; 8086. So the default is the 8086's and set_cpu raises it, which leaves every
;; existing caller exactly where it was.
(global \$shmask (mut i32) (i32.const 0xFF))
;; The FLAGS shape, defaulting to the 8086's. set_cpu raises it.
(global $f_res (mut i32) (i32.const ${isa.FLAGS_RESERVED}))
(global $f_def (mut i32) (i32.const ${isa.FLAGS_DEFINED}))
;; How far the address bus goes. An 8086 has twenty lines and every address
;; wraps at 1MB; a machine with A20 open and extended memory in it does not.
;; Both are correct and a program can tell the difference, so this is a global
;; the host raises the moment the guest takes an XMS handle, rather than a
;; constant. Left alone it is exactly the old behaviour -- which is what the
;; instruction gate checks, since its 8088 vectors include the wrap.
(global $linmask (mut i32) (i32.const ${isa.LIN_MASK_REAL}))

;; Where each segment register's window starts, in linear bytes. In real mode
;; this is just the selector shifted left four, and keeping it beside the
;; selector rather than recomputing it buys nothing on its own -- $lin used to
;; do the shift inline. It is here because a segment base is the one part of
;; addressing that protected mode changes: there the number comes out of a
;; descriptor and has no arithmetic relationship to the selector at all.
;;
;; Derived state, so there is exactly one writer: $sset. Nothing else may
;; assign a segment global, including the host, whose set_es/set_cs/... exports
;; are routed through $sset for this reason.
${isa.SEG.map(r => `(global $${r}b (mut i32) (i32.const 0))`).join('\n')}

;; The descriptor tables, as LGDT/LIDT left them, and the D bit of whatever
;; descriptor CS was last loaded from. $d32 is what makes a code segment
;; 32-bit-by-default; it is read at DECODE time, so it is part of the block
;; cache key rather than something a running block consults.
(global $gdtb (mut i32) (i32.const 0))
(global $gdtl (mut i32) (i32.const 0))
(global $idtb (mut i32) (i32.const 0))
(global $idtl (mut i32) (i32.const 0))
(global $d32 (mut i32) (i32.const 0))
;; How wide the stack pointer is: 0xFFFF while SS is a 16-bit segment, all ones
;; once it names a descriptor with B set. Every push and pop masks with it, so
;; a 16-bit stack keeps the exact wrap a .COM starting at SP=0xFFFE depends on
;; and a flat one keeps the whole of ESP.
(global $spm (mut i32) (i32.const 0xFFFF))
;; LDT selector and the linear base it resolved to, plus the task register.
;; Nothing switches tasks, so $tr is storage that STR can read back.
(global $ldt (mut i32) (i32.const 0))
(global $ldtb (mut i32) (i32.const 0))
(global $tr (mut i32) (i32.const 0))`;

function preamble() {
  const globals = STATE
    .map(g => `(global $${g} (mut i32) (i32.const 0))`).join('\n');
  // A segment register's setter goes through $sset like every in-guest write
  // does, so the shadow base cannot drift when the host pokes CS or ES -- which
  // it does on every interrupt dispatch and on the way into a program.
  const accessors = STATE.map(g => {
    const seg = isa.SEG.indexOf(g);
    // The flags word is the one piece of state that may be DEFERRED rather than
    // stored (see the lazy-flag block): a host read has to materialize it first,
    // and a host write has to retire the pending rule, or the next in-guest read
    // would recompute the arithmetic bits from an operation the host overwrote.
    if (g === 'flags') {
      return `
(func (export "get_flags") (result i32) (call $flags_word))
(func (export "set_flags") (param $v i32) (call $flags_put (local.get $v)))`;
    }
    return `
(func (export "get_${g}") (result i32) (global.get $${g}))
(func (export "set_${g}") (param $v i32) ${seg < 0
      ? `(global.set $${g} (local.get $v))`
      : `(call $sset (i32.const ${seg}) (local.get $v))`})`;
  }).join('');
  return `(module
(import "host" "memory" (memory ${isa.MEM_PAGES} ${isa.MEM_PAGES}))
(import "host" "port_in" (func $port_in (param i32) (param i32) (result i32)))
(import "host" "port_out" (func $port_out (param i32) (param i32) (param i32)))
;; The transcendentals. Wasm has no sin/cos/tan/atan2/log2/exp2 primitive and
;; a series expansion good enough for FSIN would be longer than the rest of the
;; FPU put together, so they go out to the host -- which is exactly what the
;; production interpreter's src/06-fpu.wat does with its $host_math_* imports.
;; One import with a selector rather than six, since none of them is hot.
(import "host" "fmath" (func $fmath (param i32) (param f64) (param f64) (result f64)))
${globals}
${EXTRA_GLOBALS}
;; How wide the address bus is. See $linmask -- the host opens it up when the
;; guest takes an XMS handle and never narrows it again.
;; The decoder needs CS's linear base, not its selector: in protected mode the
;; two are unrelated, and fetching at selector<<4 reads a different part of
;; memory entirely. $d32 goes with it because the default operand size is a
;; property of the same descriptor and so is part of what a block was compiled
;; against.
${isa.SEG.map(r => `(func (export "get_${r}b") (result i32) (global.get $${r}b))`).join('\n')}
(func (export "get_d32") (result i32) (global.get $d32))
(func (export "get_cr0") (result i32) (global.get $cr0))
(func (export "get_vm86") (result i32) (global.get $vm86))
;; A hardware IRQ, delivered the same way the CPU delivers everything else.
;;
;; The host used to build this frame itself, and could only build the real-mode
;; one -- push three words at (ss << 4) + sp and read the vector from physical
;; 0 -- so it refused to deliver at all once the guest was in protected mode.
;; That was the right refusal for the frame it could build and the wrong answer
;; for the machine: a protected-mode demo paced off INT 8 got no beat and stood
;; still. INTRO.EXE sets mode 13h, loads its 246 palette entries, then spins on
;; a tick counter its own IDT gate increments, and waited forever.
;;
;; $fault already knows all three cases -- a 386 or 286 gate through the IDT,
;; the V86 hand-off to the monitor, and the real-mode vector table when there
;; is no IDT -- so the host asks for a vector and the CPU decides how to take
;; it. The return address is the current EIP because an external interrupt is
;; taken between instructions, not part-way through one.
(func (export "raise_irq") (param $vec i32)
  (call $fault (local.get $vec) (global.get $gip)))
(func (export "get_gdtb") (result i32) (global.get $gdtb))
(func (export "get_gdtl") (result i32) (global.get $gdtl))
(func (export "get_linmask") (result i32) (global.get $linmask))
(func (export "set_linmask") (param $v i32) (global.set $linmask (local.get $v)))
(func (export "set_cpu") (param $level i32)
  (if (i32.ge_u (local.get $level) (i32.const 386))
    (then
      (global.set $f_res (i32.const 2))
      (global.set $f_def (i32.const ${isa.FLAGS_DEFINED | 0x7000})))
    (else
      (global.set $f_res (i32.const ${isa.FLAGS_RESERVED}))
      (global.set $f_def (i32.const ${isa.FLAGS_DEFINED}))))
  ;; Shift-count masking arrived with the 186, one generation before the FLAGS
  ;; change above, so it gets its own threshold rather than sharing that one.
  (global.set $shmask (select (i32.const 31) (i32.const 0xFF)
    (i32.ge_u (local.get $level) (i32.const 186)))))
(type $void (func))
${accessors}
`;
}

const LOCALS = '(local $t0 i32) (local $t1 i32) (local $t2 i32) (local $t3 i32) '
  + '(local $t4 i32) (local $t5 i32) (local $t6 i32) (local $t7 i32) '
  // The only i64 locals in the VM: 32-bit MUL and DIV need 64 bits of product.
  // Everything else is deliberately i32, so these three are the whole cost.
  + '(local $q i64) (local $d i64) (local $r i64) '
  // One f64 scratch, for FXCH. The x87 register file lives in globals like
  // every other piece of guest state.
  + '(local $f0 f64)';

// ---------------------------------------------------------------------------
// The six shells.
// ---------------------------------------------------------------------------
// The dispatch histogram, as WAT, or nothing at all.
//
// Two counters per dispatch: one for this handler, one for the ordered pair
// (previous handler, this one). The pair is the point -- see isa.HIST_PAIRS.
// `$hprev` is a global rather than a local because the tail-call shells never
// return, so there is no frame to carry it in.
//
// This is an INSTRUMENTED build and it is not the build that ships. Three
// extra memory ops per dispatch is a large fraction of a dispatch, so its
// timings mean nothing; its COUNTS are exact, which is what it is for. Any
// timing question goes to bench-loops.js.
function histBump() {
  const one = (addr) => `(i32.store ${addr}
    (i32.add (i32.load ${addr}) (i32.const 1)))`;
  const flat = `(i32.add (i32.const ${isa.HIST_BASE})
    (i32.shl (local.get $fn) (i32.const 2)))`;
  const pair = `(i32.add (i32.const ${isa.HIST_PAIRS})
    (i32.shl (i32.add (i32.shl (global.get $hprev) (i32.const ${Math.log2(isa.HIST_SLOTS)}))
                      (local.get $fn))
             (i32.const 2)))`;
  return `${one(flat)}\n${one(pair)}\n(global.set $hprev (local.get $fn))`;
}

function emitTailcall(opts = {}) {
  let s = preamble() + helpers();
  s += `(table $h ${HANDLERS.length} funcref)\n`;
  s += `(elem (i32.const 0) ${HANDLERS.map(x => `$${x.name}`).join(' ')})\n`;
  const hist = opts.hist ? histBump() : '';
  s += `
(func $next
  (local $fn i32)
  (global.set $steps (i32.sub (global.get $steps) (i32.const 1)))
  (if (global.get $halt) (then (return)))
  (local.set $fn (i32.load (global.get $ip)))
  (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
  ${hist}
  (return_call_indirect $h (type $void) (local.get $fn)))
`;
  for (const x of HANDLERS) {
    s += `(func $${x.name} ${LOCALS}\n${x.body}\n(return_call $next))\n`;
  }
  s += runExport();
  return s + ')\n';
}

// Replicated tail-call dispatch: the same handlers, but each one ends with its
// OWN copy of the dispatch sequence instead of tail-calling a shared $next. The
// machine code is nearly identical; what changes is that there are N indirect
// branch sites rather than one, so the predictor gets a separate history per
// handler. That is the classic threaded-code replication trick, and it is the
// one structural idea in this comparison that costs nothing but code size.
//
// There is deliberately no replicated br_table twin. A br_table's arm labels
// are only in scope at the innermost point of the block nest, so an arm cannot
// re-dispatch after its own block has closed -- replicating it would mean N
// copies of an N-arm nest, which is quadratic in handler count.
function emitReplTailcall() {
  let s = preamble() + helpers();
  s += `(table $h ${HANDLERS.length} funcref)\n`;
  s += `(elem (i32.const 0) ${HANDLERS.map(x => `$${x.name}`).join(' ')})\n`;
  const dispatch = `
  (global.set $steps (i32.sub (global.get $steps) (i32.const 1)))
  (if (global.get $halt) (then (return)))
  (local.set $fn (i32.load (global.get $ip)))
  (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
  (return_call_indirect $h (type $void) (local.get $fn))`;
  // $next still exists as the entry point run() calls into.
  s += `(func $next (local $fn i32)${dispatch})\n`;
  for (const x of HANDLERS) {
    s += `(func $${x.name} (local $fn i32) ${LOCALS}\n${x.body}\n${dispatch})\n`;
  }
  s += runExport();
  return s + ')\n';
}

function emitCalls() {
  let s = preamble() + helpers();
  s += `(table $h ${HANDLERS.length} funcref)\n`;
  s += `(elem (i32.const 0) ${HANDLERS.map(x => `$${x.name}`).join(' ')})\n`;
  for (const x of HANDLERS) {
    s += `(func $${x.name} ${LOCALS}\n${x.body}\n)\n`;
  }
  // The dispatch loop lives in the caller; handlers return into it.
  s += `
(func $next
  (local $fn i32)
  (loop $l
    (global.set $steps (i32.sub (global.get $steps) (i32.const 1)))
    (if (global.get $halt) (then (return)))
    (local.set $fn (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (call_indirect $h (type $void) (local.get $fn))
    (br $l)))
`;
  s += runExport();
  return s + ')\n';
}

function emitSwitch() {
  let s = preamble() + helpers();
  // Every handler body inlined as one arm of a single br_table. No calls, no
  // frames, no signature check -- and, in the non-replicated form, still just
  // one branch site for all of them.
  const dispatch = `
    (global.set $steps (i32.sub (global.get $steps) (i32.const 1)))
    (if (global.get $halt) (then (return)))
    (local.set $fn (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (br_table ${HANDLERS.map((_, i) => `$a${i}`).join(' ')} $bad (local.get $fn))`;

  // Same nesting rule as brTableFn: $bad outermost, $a0 innermost, and each
  // arm's body sits immediately after its own block closes.
  s += `(func $next (local $fn i32) ${LOCALS}\n(loop $l\n(block $bad\n`;
  for (let i = HANDLERS.length - 1; i >= 0; i--) s += `(block $a${i} `;
  s += `\n${dispatch}\n`;
  for (let i = 0; i < HANDLERS.length; i++) {
    s += `)\n${HANDLERS[i].body}\n`;
    // Every arm falls out to the shared loop back-edge and through the one
    // branch site again. See emitReplTailcall for why there is no replicated
    // twin of this shell.
    s += `(br $l)\n`;
  }
  s += `)\n(unreachable)\n)\n)\n`;
  s += runExport();
  return s + ')\n';
}

function runExport() {
  return `
(func (export "run") (param $entry i32) (param $budget i32)
  (global.set $ip (local.get $entry))
  (global.set $steps (local.get $budget))
  (global.set $left (i32.const -1))
  (global.set $halt (i32.const 0))
  (call $next))
`;
}

const VARIANTS = {
  tailcall: emitTailcall,
  repl_tailcall: emitReplTailcall,
  calls: emitCalls,
  switch: emitSwitch,
};

// `opts.hist` builds the instrumented dispatch. Only the tailcall shell
// implements it: the census is a property of the guest's instruction stream,
// not of how the shell branches, so counting it once in the shipped shell
// answers the question for all four. A request for it on another shell is an
// error rather than a silently uninstrumented build.
// Every top-level (func has to start one level inside (module. A generated
// function with one paren too many closes the module instead of itself, and
// lib/compile-wat.js accepts that silently: the functions after it end up
// outside the module, their bodies are dropped, and calls to them compile to
// nothing. That is not a crash and not a warning -- it is a decoder that
// returns zeros. This cost an hour when $dc_modrm did exactly that, so the
// module is checked before it is ever handed to the compiler.
//
// src/*.wat has tools/check-parens.js for this. Generated WAT never reaches
// that check, so it needs its own.
function checkNesting(wat) {
  let depth = 0, line = 1, comment = false;
  for (let i = 0; i < wat.length; i++) {
    const c = wat[i];
    if (c === '\n') { line++; comment = false; continue; }
    if (comment) continue;
    if (c === ';' && wat[i + 1] === ';') { comment = true; continue; }
    if (c === '(') {
      if (depth === 0 && wat.startsWith('(func ', i)) {
        throw new Error(`generated WAT line ${line}: a top-level (func starts outside `
          + `(module -- an earlier function has one close-paren too many`);
      }
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth < 0) throw new Error(`generated WAT line ${line}: unbalanced close paren`);
    }
  }
  if (depth !== 0) throw new Error(`generated WAT ends at nesting depth ${depth}, expected 0`);
  // Two functions with one name. This is what a rebuild under the other flag
  // scheme produces if it forgets to clear an accumulator the generators append
  // to (SHIFT_FNS did exactly that), and it is silent the same way the nesting
  // bug is: the module still compiles, calls bind to whichever definition the
  // compiler kept, and the arm being measured is neither of the two.
  const seen = new Set();
  for (const m of wat.matchAll(/^\(func (\$[A-Za-z0-9_]+)/gm)) {
    if (seen.has(m[1])) throw new Error(`generated WAT defines ${m[1]} twice`);
    seen.add(m[1]);
  }
  return wat;
}

function emit(variant, opts = {}) {
  buildHandlers(opts.lazyFlags !== false);
  const fn = VARIANTS[variant];
  if (!fn) throw new Error(`unknown variant: ${variant} (have ${Object.keys(VARIANTS).join(', ')})`);
  if (opts.hist && variant !== 'tailcall') {
    throw new Error(`--handler-hist is only implemented for the tailcall shell, not ${variant}`);
  }
  return checkNesting(fn(opts));
}

// helpers/LOCALS/STATE are exported for tools/toyvm/trace-jit.js, which builds
// a standalone module out of the SAME handler bodies. It duplicates the helper
// text rather than importing the interpreter's copies on purpose: a cross-module
// call per $rget16 would be measuring module boundaries, not code generation.
module.exports = {
  emit, HANDLERS, VARIANTS: Object.keys(VARIANTS), helpers, LOCALS, STATE,
  EXTRA_GLOBALS,
  // The compiler walks a finished block op by op to find a fusable tail, which
  // it can only do if it knows how many operand words each handler eats.
  ARITY: HANDLERS.map(x => x.args),
  FUSE,
};

// CLI: dump one variant's WAT, for eyeballing or for handing to wat2wasm.
//   node tools/toyvm/emit.js --variant=tailcall > /tmp/t.wat
if (require.main === module) {
  const a = process.argv.slice(2).find(x => x.startsWith('--variant='));
  process.stdout.write(emit(a ? a.slice(10) : 'tailcall'));
}
