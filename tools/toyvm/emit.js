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
h('end', 1, `
  ${ops(1)}
  (global.set $gip (local.get $t0))
  (global.set $left (global.get $steps)) (global.set $steps (i32.const -1))
`);

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
const CF_IN = '(i32.and (global.get $flags) (i32.const 1))';
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
const ADD_FLAGS = (w, a, b, s) => w === 32
  ? `(call $flags_add32 ${a} ${b} (i32.const 0) ${s})`
  : `(call $flags_add ${a} ${b} ${s} (i32.const ${w}))`;
const SUB_FLAGS = (w, a, b, s) => w === 32
  ? `(call $flags_sub32 ${a} ${b} (i32.const 0) ${s})`
  : `(call $flags_sub ${a} ${b} ${s} (i32.const ${w}))`;
const INC_FLAGS = (w, a, s) => w === 32
  ? `(call $flags_inc32 ${a} ${s})` : `(call $flags_inc ${a} ${s} (i32.const ${w}))`;
const DEC_FLAGS = (w, a, s) => w === 32
  ? `(call $flags_dec32 ${a} ${s})` : `(call $flags_dec ${a} ${s} (i32.const ${w}))`;

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
        ? `(${spec.op} (${spec.op} ${a} ${b}) ${CF_IN})`
        : `(${spec.op} ${a} ${b})`;
      // At width 32 the arithmetic flags go to the dedicated helpers, which take
      // the carry-in and the truncated result instead of an oversized sum.
      const flags = (a, b, s) => spec.flags === 'logic'
        ? `(call $flags_logic (i32.and ${s} (i32.const ${mask})) (i32.const ${w}))`
        : (w === 32
          ? `(call $flags_${spec.flags}32 ${a} ${b} ${spec.carry ? CF_IN : '(i32.const 0)'} ${s})`
          : `(call $flags_${spec.flags} ${a} ${b} ${s} (i32.const ${w}))`);

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

const bit = (b) => `(i32.and (i32.shr_u (global.get $flags) (i32.const ${b})) (i32.const 1))`;
const CONDS = {
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
};

// Shared tail: commit one successor. $arena is the arena address (0 = stop),
// $guest is the guest IP to record either way.
const GO = (arena, guest) => `
  (global.set $gip ${guest})
  (if ${arena}
    (then (global.set $ip ${arena}))
    (else (global.set $left (global.get $steps)) (global.set $steps (i32.const -1))))`;

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
  h('pushf', 0, `(call $push16 (global.get $flags))`);
  // POPF must both OR in the bits that always read 1 and MASK OFF the ones that
  // always read 0 (3 and 5). Only doing the first half leaves whatever the
  // pushed value had in those bits and fails three quarters of the corpus.
  h('popf', 0, `
  (global.set $flags (i32.or
    (i32.and (call $pop16) ${DEFINED})
    ${RESERVED}))
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
  (if (local.get $t7)
    (then (global.set $ip (local.get $t7)))
    (else (global.set $left (global.get $steps)) (global.set $steps (i32.const -1))))`;
  h('ret', 0, RET_BODY);
  h('ret_imm', 1, `
  ${ops(1)}
  (global.set $gip (call $pop16))
  (global.set $sp (i32.and (i32.add (global.get $sp) (local.get $t0)) (i32.const 0xFFFF)))
  (local.set $t7 (call $rpop (global.get $gip)))
  (if (local.get $t7)
    (then (global.set $ip (local.get $t7)))
    (else (global.set $left (global.get $steps)) (global.set $steps (i32.const -1))))
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
  const setF = (b, v) => v
    ? `(global.set $flags (i32.or (global.get $flags) (i32.const ${1 << b})))`
    : `(global.set $flags (i32.and (global.get $flags) (i32.const ${(~(1 << b)) & 0xFFFF})))`;
  h('clc', 0, setF(F.CF, 0));
  h('stc', 0, setF(F.CF, 1));
  h('cmc', 0, `(global.set $flags (i32.xor (global.get $flags) (i32.const ${1 << F.CF})))`);
  h('cld', 0, setF(F.DF, 0));
  h('std', 0, setF(F.DF, 1));
  h('cli', 0, setF(F.IF, 0));
  h('sti', 0, setF(F.IF, 1));
  h('nop', 0, '');

  // SAHF/LAHF move the low byte of FLAGS through AH.
  h('sahf', 0, `
  (global.set $flags (i32.or
    (i32.and (global.get $flags) (i32.const 0xFF00))
    (i32.or (i32.and (i32.shr_u (global.get $ax) (i32.const 8)) (i32.const 0xD5))
            (i32.const 2))))
`);
  h('lahf', 0, `
  (call $rset16 (i32.const 0) (i32.or
    (i32.and (global.get $ax) (i32.const 0x00FF))
    (i32.shl (i32.and (global.get $flags) (i32.const 0xFF)) (i32.const 8))))
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
  (global.set $flags (i32.or
    (i32.and (global.get $flags)
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

  // JCXZ, LOOPZ, LOOPNZ -- the remaining counted-loop terminators.
  h('jcxz', 4, `
  ${ops(4)}
  (if (i32.eqz (call $cx16))
    (then ${GO('(local.get $t0)', '(local.get $t1)')})
    (else ${GO('(local.get $t2)', '(local.get $t3)')}))
`);
  for (const [nm, want] of [['loopz', 1], ['loopnz', 0]]) {
    h(nm, 4, `
  ${ops(4)}
  (if (i32.and (i32.ne (call $cxdec) (i32.const 0))
               (i32.eq ${bit(F.ZF)} (i32.const ${want})))
    (then ${GO('(local.get $t0)', '(local.get $t1)')})
    (else ${GO('(local.get $t2)', '(local.get $t3)')}))
`);
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
  h('int_imm', 2, `
  ${ops(2)}
  (call $push16 (global.get $flags))
  (call $push16 (call $sget (i32.const 1)))
  (call $push16 (local.get $t1))
  (global.set $flags (i32.and (global.get $flags)
    (i32.const ${(~((1 << F.IF) | (1 << F.TF))) & 0xFFFF})))
  (global.set $intno (local.get $t0))
  (local.set $t2 (i32.shl (local.get $t0) (i32.const 2)))
  (global.set $gip (call $rdphys16 (local.get $t2)))
  (call $sset (i32.const 1) (call $rdphys16 (i32.add (local.get $t2) (i32.const 2))))
  (global.set $left (global.get $steps)) (global.set $steps (i32.const -1))
`);
  h('iret', 0, `
  (global.set $gip (call $pop16))
  (call $sset (i32.const 1) (call $pop16))
  (global.set $flags (i32.or
    (i32.and (call $pop16) ${DEFINED})
    ${RESERVED}))
  (global.set $left (global.get $steps)) (global.set $steps (i32.const -1))
`);
}

// --- String operations, with and without REP --------------------------------
// ES is segment index 0 and is NOT overridable for the destination; the source
// defaults to DS and is. Direction comes from DF, so every one of these moves
// backwards when a demo sets STD -- which they do, constantly, for scrolls.
// A compare's flags, at whichever width -- the 32-bit form needs the dedicated
// helper because there is no room above bit 31 to keep the borrow.
const CMP_FLAGS = (w, a, b) => w === 32
  ? `(call $flags_sub32 ${a} ${b} (i32.const 0) (i32.sub ${a} ${b}))`
  : `(call $flags_sub ${a} ${b} (i32.sub ${a} ${b}) (i32.const ${w}))`;

function genStrings() {
  const DELTA = (sz) => `(select (i32.const ${-sz}) (i32.const ${sz}) ${bit(F.DF)})`;
  // SI/DI move as 16-bit quantities in 16-bit address mode, and the upper half
  // of ESI/EDI must survive -- $rset16 merges rather than replaces.
  const bump = (reg, sz) =>
    `(call $rset16 (i32.const ${{ si: 6, di: 7 }[reg]})
       (i32.add (call $rget16 (i32.const ${{ si: 6, di: 7 }[reg]})) ${DELTA(sz)}))`;

  // body(w) produces one iteration; `rep` wraps it in a CX loop.
  const BODIES = {
    movs: (w, sz) => `
    (call $wr${w} (i32.const 0) (call $rget16 (i32.const 7))
      (call $rd${w} (local.get $t0) (call $rget16 (i32.const 6))))
    ${bump('si', sz)} ${bump('di', sz)}`,
    stos: (w, sz) => `
    (call $wr${w} (i32.const 0) (call $rget16 (i32.const 7)) (call $rget${w} (i32.const 0)))
    ${bump('di', sz)}`,
    lods: (w, sz) => `
    (call $rset${w} (i32.const 0) (call $rd${w} (local.get $t0) (call $rget16 (i32.const 6))))
    ${bump('si', sz)}`,
    scas: (w, sz) => `
    (local.set $t2 (call $rget${w} (i32.const 0)))
    (local.set $t3 (call $rd${w} (i32.const 0) (call $rget16 (i32.const 7))))
    ${CMP_FLAGS(w, '(local.get $t2)', '(local.get $t3)')}
    ${bump('di', sz)}`,
    cmps: (w, sz) => `
    (local.set $t2 (call $rd${w} (local.get $t0) (call $rget16 (i32.const 6))))
    (local.set $t3 (call $rd${w} (i32.const 0) (call $rget16 (i32.const 7))))
    ${CMP_FLAGS(w, '(local.get $t2)', '(local.get $t3)')}
    ${bump('si', sz)} ${bump('di', sz)}`,
  };

  for (const [name, body] of Object.entries(BODIES)) {
    for (const w of [8, 16, 32]) {
      const sz = w >> 3;
      const suffix = { 8: 'b', 16: 'w', 32: 'd' }[w];
      // Plain form: operand is the source segment index (ignored by STOS/SCAS).
      h(`${name}${suffix}`, 1, `
  ${ops(1)}
  ${body(w, sz)}
`);

      // REP forms run the whole count inside one dispatch, which is exactly
      // what the production interpreter's REP handlers do -- and is the reason
      // a fold like this is worth anything: the loop never pays dispatch again.
      // CX is the meter, so a super-op like this must also charge the host's
      // step budget; here that is $steps, decremented per element.
      const isCompare = name === 'scas' || name === 'cmps';
      for (const rep of (isCompare ? ['rep', 'repne'] : ['rep'])) {
        const zWant = rep === 'rep' ? 1 : 0;
        h(`${rep}_${name}${suffix}`, 1, `
  ${ops(1)}
  (block $done
    (loop $l
      (br_if $done (i32.eqz (call $cx16)))
      ${body(w, sz)}
      (drop (call $cxdec))
      (global.set $steps (i32.sub (global.get $steps) (i32.const 1)))
      ${isCompare ? `(br_if $done (i32.ne ${bit(F.ZF)} (i32.const ${zWant})))` : ''}
      (br $l)))
`);
      }
    }
  }
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
  (local.set $cf (i32.and (global.get $flags) (i32.const 1)))
  (if (i32.eqz (local.get $n)) (then (return (local.get $v))))
  (block $done (loop $l
    (br_if $done (i32.eqz (local.get $n)))
    ${one}
    (local.set $n (i32.sub (local.get $n) (i32.const 1)))
    (br $l)))
  ;; A rotate touches only CF and OF; a shift also defines SF, ZF and PF. Which
  ;; bits get cleared here has to match, or a rotate silently zeroes the ZF a
  ;; preceding compare set.
  (local.set $f (i32.and (global.get $flags)
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
  (global.set $flags (i32.or (local.get $f) ${RESERVED}))
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
  (local.set $f (i32.and (global.get $flags) (i32.const ${(~((1 << isa.F.CF)
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
  (global.set $flags (i32.or (local.get $f) ${RESERVED}))
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

  // Far transfers and indirect jumps. All of them land on an address that is
  // data, so all of them leave the trace.
  h('jmp_far', 2, `
  ${ops(2)}
  (call $sset (i32.const 1) (local.get $t1))
  (global.set $gip (local.get $t0))
  (global.set $left (global.get $steps)) (global.set $steps (i32.const -1))
`);
  h('call_far', 3, `
  ${ops(3)}
  (call $push16 (call $sget (i32.const 1)))
  (call $push16 (local.get $t2))
  (call $sset (i32.const 1) (local.get $t1))
  (global.set $gip (local.get $t0))
  (global.set $left (global.get $steps)) (global.set $steps (i32.const -1))
`);
  h('retf', 0, `
  (global.set $gip (call $pop16))
  (call $sset (i32.const 1) (call $pop16))
  (global.set $left (global.get $steps)) (global.set $steps (i32.const -1))
`);
  h('retf_imm', 1, `
  ${ops(1)}
  (global.set $gip (call $pop16))
  (call $sset (i32.const 1) (call $pop16))
  (global.set $sp (i32.and (i32.add (global.get $sp) (local.get $t0)) (i32.const 0xFFFF)))
  (global.set $left (global.get $steps)) (global.set $steps (i32.const -1))
`);
  // The target is a runtime value, so it is looked up in the jump-target cache
  // rather than baked in. A miss hands back exactly as before; a hit keeps a
  // computed jump inside wasm, which is what mars.exe's unrolled span writer is
  // entered through several hundred thousand times a frame.
  const GO_INDIRECT = `
  (local.set $t3 (call $jlook (global.get $gip)))
  (if (local.get $t3)
    (then (global.set $ip (local.get $t3)))
    (else (global.set $left (global.get $steps)) (global.set $steps (i32.const -1))))`;
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

  // FF /5 and FF /3: far JMP and far CALL through a memory operand. Between
  // them these are the single biggest coverage gap in the demo corpus -- the
  // `2e ff 2f` (jmp far [cs:bx]) and `26 ff 19` (call far [es:bx+di]) startup
  // thunks that Turbo-era runtimes open with.
  h('jmp_far_m', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (local.set $t7 (call $rd16 (local.get $t5) (local.get $t4)))
  (call $sset (i32.const 1) (call $rd16 (local.get $t5)
    (i32.and (i32.add (local.get $t4) (i32.const 2)) (i32.const 0xFFFF))))
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
    (i32.and (i32.add (local.get $t4) (i32.const 2)) (i32.const 0xFFFF))))
  (call $push16 (call $sget (i32.const 1)))
  (call $push16 (local.get $t2))
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
  // SI/DI move as 16-bit quantities in 16-bit address mode, and the upper half
  // of ESI/EDI must survive -- $rset16 merges rather than replaces.
  const bump = (reg, sz) =>
    `(call $rset16 (i32.const ${{ si: 6, di: 7 }[reg]})
       (i32.add (call $rget16 (i32.const ${{ si: 6, di: 7 }[reg]})) ${DELTA(sz)}))`;

  for (const w of [8, 16]) {
    const sz = w >> 3, sfx = w === 8 ? 'b' : 'w';
    const BODY = {
      [`outs${sfx}`]: `
    (call $port_out (call $rget16 (i32.const 2)) (call $rd${w} (local.get $t0) (call $rget16 (i32.const 6))) (i32.const ${w}))
    ${bump('si', sz)}`,
      [`ins${sfx}`]: `
    (call $wr${w} (i32.const 0) (call $rget16 (i32.const 7)) (call $port_in (call $rget16 (i32.const 2)) (i32.const ${w})))
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
      (br_if $done (i32.eqz (call $cx16)))
      ${body}
      (drop (call $cxdec))
      (global.set $steps (i32.sub (global.get $steps) (i32.const 1)))
      (br $l)))
`);
    }
  }
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
}

genStrings();
gen186StringIO();
gen386();
genFpu();
genShifts();
genSetmo();
genShiftHandlers();
genDoubleShifts();
genArithIO();

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
  s += brTableFn('sset', '(param $i i32) (param $v i32)', '',
    isa.SEG.map(r => `(global.set $${r} (local.get $v)) (return)`));

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
(func $lin (param $seg i32) (param $off i32) (result i32)
  (i32.and
    (i32.add (i32.shl (call $sget (local.get $seg)) (i32.const 4)) (local.get $off))
    (i32.const 0xFFFFF)))

(func $rd8 (param $seg i32) (param $off i32) (result i32)
  (i32.load8_u (call $lin (local.get $seg) (local.get $off))))

(func $wr8 (param $seg i32) (param $off i32) (param $v i32)
  (i32.store8 (call $lin (local.get $seg) (local.get $off)) (local.get $v)))

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

;; Absolute physical read, for the interrupt vector table at address 0. It is
;; not reachable through $rd16, which always goes via a segment register.
(func $rdphys16 (param $lin i32) (result i32)
  (i32.or
    (i32.load8_u (i32.and (local.get $lin) (i32.const 0xFFFFF)))
    (i32.shl (i32.load8_u (i32.and (i32.add (local.get $lin) (i32.const 1))
                                   (i32.const 0xFFFFF)))
             (i32.const 8))))

;; Stack. SS is segment index 2. SP wraps at 16 bits like every other offset,
;; which matters for a .COM that starts with SP=0xFFFE and pushes.
(func $push16 (param $v i32)
  (global.set $sp (i32.and (i32.sub (global.get $sp) (i32.const 2)) (i32.const 0xFFFF)))
  (call $wr16 (i32.const 2) (global.get $sp) (local.get $v)))

(func $pop16 (result i32)
  (local $v i32)
  (local.set $v (call $rd16 (i32.const 2) (global.get $sp)))
  (global.set $sp (i32.and (i32.add (global.get $sp) (i32.const 2)) (i32.const 0xFFFF)))
  (local.get $v))

;; A 32-bit push on a 16-bit stack still moves SP by four. SP itself stays a
;; 16-bit quantity here: a real-mode demo runs on a 16-bit stack segment, and
;; nothing in the corpus or in the demos exercises a 32-bit ESP.
(func $push32 (param $v i32)
  (global.set $sp (i32.and (i32.sub (global.get $sp) (i32.const 4)) (i32.const 0xFFFF)))
  (call $wr32 (i32.const 2) (global.get $sp) (local.get $v)))

(func $pop32 (result i32)
  (local $v i32)
  (local.set $v (call $rd32 (i32.const 2) (global.get $sp)))
  (global.set $sp (i32.and (i32.add (global.get $sp) (i32.const 4)) (i32.const 0xFFFF)))
  (local.get $v))

;; Eager flags. $s is the UNMASKED sum, so the carry out is still in it.
;; Width is 8 or 16; everything below is written against it rather than
;; branching on it, so the two widths share one path.
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
  (global.set $flags (i32.or (local.get $f) ${RESERVED})))

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
  (global.set $flags (i32.or (local.get $f) ${RESERVED})))

;; INC/DEC are add/sub by one that leave CF ALONE. Saving and restoring the
;; bit around the shared helper is cheaper than a second copy of the whole
;; flag computation, and cannot drift from it.
(func $flags_inc (param $a i32) (param $s i32) (param $w i32)
  (local $cf i32)
  (local.set $cf (i32.and (global.get $flags) (i32.const 1)))
  (call $flags_add (local.get $a) (i32.const 1) (local.get $s) (local.get $w))
  (global.set $flags (i32.or (i32.and (global.get $flags) (i32.const 0xFFFE))
                             (local.get $cf))))

(func $flags_dec (param $a i32) (param $s i32) (param $w i32)
  (local $cf i32)
  (local.set $cf (i32.and (global.get $flags) (i32.const 1)))
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
  (global.set $flags (i32.or (local.get $f) ${RESERVED})))

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
  (global.set $flags (i32.or (local.get $f) ${RESERVED})))

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
  (global.set $flags (i32.or (local.get $f) ${RESERVED})))

(func $flags_inc32 (param $a i32) (param $r i32)
  (local $cf i32)
  (local.set $cf (i32.and (global.get $flags) (i32.const 1)))
  (call $flags_add32 (local.get $a) (i32.const 1) (i32.const 0) (local.get $r))
  (global.set $flags (i32.or (i32.and (global.get $flags) (i32.const 0xFFFE))
                             (local.get $cf))))

(func $flags_dec32 (param $a i32) (param $r i32)
  (local $cf i32)
  (local.set $cf (i32.and (global.get $flags) (i32.const 1)))
  (call $flags_sub32 (local.get $a) (i32.const 1) (i32.const 0) (local.get $r))
  (global.set $flags (i32.or (i32.and (global.get $flags) (i32.const 0xFFFE))
                             (local.get $cf))))

;; MUL/IMUL set CF and OF together from "the upper half carries information"
;; and leave SF/ZF/AF/PF undefined. $nz is the caller's answer to that question.
(func $flags_mul (param $nz i32)
  (local $f i32)
  (local.set $f (i32.and (global.get $flags)
    (i32.const ${(~((1 << isa.F.CF) | (1 << isa.F.OF))) & 0xFFFF})))
  (local.set $nz (i32.ne (local.get $nz) (i32.const 0)))
  (global.set $flags (i32.or (i32.or (local.get $f)
    (i32.or (local.get $nz) (i32.shl (local.get $nz) (i32.const ${isa.F.OF}))))
    ${RESERVED})))

;; A CPU-raised interrupt. Same sequence as INT -- and the same handing-back to
;; the host, since the vector points at whatever the guest installed.
(func $fault (param $vec i32) (param $ip i32)
  (local $v i32)
  (call $push16 (global.get $flags))
  (call $push16 (call $sget (i32.const 1)))
  (call $push16 (local.get $ip))
  (global.set $flags (i32.and (global.get $flags)
    (i32.const ${(~((1 << isa.F.IF) | (1 << isa.F.TF))) & 0xFFFF})))
  (global.set $intno (local.get $vec))
  (local.set $v (i32.shl (local.get $vec) (i32.const 2)))
  (global.set $gip (call $rdphys16 (local.get $v)))
  (call $sset (i32.const 1) (call $rdphys16 (i32.add (local.get $v) (i32.const 2))))
  (global.set $left (global.get $steps)) (global.set $steps (i32.const -1)))

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

;; Indirect-jump target lookup. The key carries CS so a trace compiled for one
;; segment can never be entered from another.
(func $jlook (param $ip i32) (result i32)
  (local $k i32) (local $a i32)
  (local.set $k (i32.or (i32.shl (call $sget (i32.const 1)) (i32.const 16))
                        (i32.and (local.get $ip) (i32.const 0xFFFF))))
  (local.set $a (i32.add (i32.const ${isa.JTAB_BASE}) (i32.mul
    (i32.and (i32.shr_u (i32.mul (local.get $k) (i32.const ${isa.JTAB_HASH_MUL}))
                        (i32.const 16))
             (i32.const ${isa.JTAB_ENTRIES - 1}))
    (i32.const 8))))
  (if (i32.eq (i32.load offset=0 (local.get $a)) (local.get $k))
    (then (return (i32.load offset=4 (local.get $a)))))
  (i32.const 0))
${SHIFT_FNS.join('')}${fpuHelpers()}`;
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
const STATE = [...isa.REG16, ...isa.SEG, 'gip', 'flags', 'ip', 'steps', 'intno', 'left', 'rtop'];

// Memory is IMPORTED and state is read through accessor functions rather than
// inline-exported, because that is the shape lib/compile-wat.js actually
// supports. Measured 2026-08-24: it encodes a defined `(memory (export ...) N N)`
// with min=0, and an inline `(global $x (export ...) (mut i32) ...)` with value
// type 0x00, producing a module the engine rejects at +84. Production WAT
// imports its memory (src/01-header.wat:805) and exports state through
// functions in src/13-exports.wat, so neither form has ever been exercised.
function preamble() {
  const globals = STATE
    .map(g => `(global $${g} (mut i32) (i32.const 0))`).join('\n');
  const accessors = STATE.map(g => `
(func (export "get_${g}") (result i32) (global.get $${g}))
(func (export "set_${g}") (param $v i32) (global.set $${g} (local.get $v)))`).join('');
  return `(module
(import "host" "memory" (memory ${isa.MEM_PAGES} ${isa.MEM_PAGES}))
(import "host" "port_in" (func $port_in (param i32) (param i32) (result i32)))
(import "host" "port_out" (func $port_out (param i32) (param i32) (param i32)))
${globals}
;; The x87 register file: eight f64 values and a rotating TOP. See fpuHelpers.
${[...Array(8).keys()].map(i => `(global $st${i} (mut f64) (f64.const 0))`).join('\n')}
(global $ftop (mut i32) (i32.const 0))
(global $ftag (mut i32) (i32.const 0))
(global $fsw (mut i32) (i32.const 0))
(global $fcw (mut i32) (i32.const 0x037F))
;; CR0 as this machine actually is: real mode (PE clear), ET set because the
;; 386 encodings are available, no paging. Nothing writes it -- see smsw.
(global $cr0 (mut i32) (i32.const 0x0010))
;; The FLAGS shape, defaulting to the 8086's. set_cpu raises it.
(global $f_res (mut i32) (i32.const ${isa.FLAGS_RESERVED}))
(global $f_def (mut i32) (i32.const ${isa.FLAGS_DEFINED}))
(func (export "set_cpu") (param $level i32)
  (if (i32.ge_u (local.get $level) (i32.const 386))
    (then
      (global.set $f_res (i32.const 2))
      (global.set $f_def (i32.const ${isa.FLAGS_DEFINED | 0x7000})))
    (else
      (global.set $f_res (i32.const ${isa.FLAGS_RESERVED}))
      (global.set $f_def (i32.const ${isa.FLAGS_DEFINED})))))
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
function emitTailcall() {
  let s = preamble() + helpers();
  s += `(table $h ${HANDLERS.length} funcref)\n`;
  s += `(elem (i32.const 0) ${HANDLERS.map(x => `$${x.name}`).join(' ')})\n`;
  s += `
(func $next
  (local $fn i32)
  (global.set $steps (i32.sub (global.get $steps) (i32.const 1)))
  (if (i32.lt_s (global.get $steps) (i32.const 0)) (then (return)))
  (local.set $fn (i32.load (global.get $ip)))
  (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
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
  (if (i32.lt_s (global.get $steps) (i32.const 0)) (then (return)))
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
    (if (i32.lt_s (global.get $steps) (i32.const 0)) (then (return)))
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
    (if (i32.lt_s (global.get $steps) (i32.const 0)) (then (return)))
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
  (call $next))
`;
}

const VARIANTS = {
  tailcall: emitTailcall,
  repl_tailcall: emitReplTailcall,
  calls: emitCalls,
  switch: emitSwitch,
};

function emit(variant) {
  const fn = VARIANTS[variant];
  if (!fn) throw new Error(`unknown variant: ${variant} (have ${Object.keys(VARIANTS).join(', ')})`);
  return fn();
}

// helpers/LOCALS/STATE are exported for tools/toyvm/trace-jit.js, which builds
// a standalone module out of the SAME handler bodies. It duplicates the helper
// text rather than importing the interpreter's copies on purpose: a cross-module
// call per $rget16 would be measuring module boundaries, not code generation.
module.exports = { emit, HANDLERS, VARIANTS: Object.keys(VARIANTS), helpers, LOCALS, STATE };

// CLI: dump one variant's WAT, for eyeballing or for handing to wat2wasm.
//   node tools/toyvm/emit.js --variant=tailcall > /tmp/t.wat
if (require.main === module) {
  const a = process.argv.slice(2).find(x => x.startsWith('--variant='));
  process.stdout.write(emit(a ? a.slice(10) : 'tailcall'));
}
