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
  (global.set $steps (i32.const -1))
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

const EA_SETUP_PRE = `
  (local.set $t4 (call $ea (i32.and (local.get $t0) (i32.const 15)) (local.get $t1)))
  (local.set $t5 (i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 3)))
  (local.set $t6 (i32.and (i32.shr_u (local.get $t0) (i32.const 8)) (i32.const 7)))
`;

function genAlu() {
  for (const [name, spec] of Object.entries(ALU)) {
    for (const w of [8, 16]) {
      const mask = w === 8 ? '0xFF' : '0xFFFF';
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
      const flags = (a, b, s) => spec.flags === 'logic'
        ? `(call $flags_logic (i32.and ${s} (i32.const ${mask})) (i32.const ${w}))`
        : `(call $flags_${spec.flags} ${a} ${b} ${s} (i32.const ${w}))`;

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
  for (const w of [8, 16]) {
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
    (else (global.set $steps (i32.const -1))))`;

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
  (global.set $cx (i32.and (i32.sub (global.get $cx) (i32.const 1)) (i32.const 0xFFFF)))
  (if (global.get $cx)
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
    (i32.and (call $pop16) (i32.const ${isa.FLAGS_DEFINED}))
    (i32.const ${isa.FLAGS_RESERVED})))
`);

  // CALL near, relative. Operands: [arenaTarget][guestTarget][retIp].
  h('call_rel', 3, `
  ${ops(3)}
  (call $push16 (local.get $t2))
  ${GO('(local.get $t0)', '(local.get $t1)')}
`);
  // RET always leaves the trace: the return address is data, so no arena
  // address can be baked in. The host recompiles from wherever it lands.
  h('ret', 0, `
  (global.set $gip (call $pop16))
  (global.set $steps (i32.const -1))
`);
  h('ret_imm', 1, `
  ${ops(1)}
  (global.set $gip (call $pop16))
  (global.set $sp (i32.and (i32.add (global.get $sp) (local.get $t0)) (i32.const 0xFFFF)))
  (global.set $steps (i32.const -1))
`);

  // LEA computes the effective address and never touches memory -- which is
  // why it is here and not a MOV form.
  h('lea', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $rset16 (local.get $t6) (local.get $t4))
`);

  // XCHG. The register/register form is also how NOP encodes (90 = xchg ax,ax).
  for (const w of [8, 16]) {
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
             (i32.const ${w === 8 ? '0xFF' : '0xFFFF'})))
`);
    h(`not_m${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $wr${w} (local.get $t5) (local.get $t4)
    (i32.and (i32.xor (call $rd${w} (local.get $t5) (local.get $t4)) (i32.const -1))
             (i32.const ${w === 8 ? '0xFF' : '0xFFFF'})))
`);
    h(`neg_r${w}`, 1, `
  ${ops(1)}
  (local.set $t1 (call $rget${w} (local.get $t0)))
  (local.set $t2 (i32.sub (i32.const 0) (local.get $t1)))
  (call $rset${w} (local.get $t0) (i32.and (local.get $t2) (i32.const ${w === 8 ? '0xFF' : '0xFFFF'})))
  (call $flags_sub (i32.const 0) (local.get $t1) (local.get $t2) (i32.const ${w}))
`);
    h(`neg_m${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (local.set $t2 (call $rd${w} (local.get $t5) (local.get $t4)))
  (local.set $t3 (i32.sub (i32.const 0) (local.get $t2)))
  (call $wr${w} (local.get $t5) (local.get $t4) (i32.and (local.get $t3) (i32.const ${w === 8 ? '0xFF' : '0xFFFF'})))
  (call $flags_sub (i32.const 0) (local.get $t2) (local.get $t3) (i32.const ${w}))
`);

    // INC/DEC on memory and on 8-bit registers. Like the 16-bit register pair
    // above, these must leave CF alone.
    h(`inc_r${w}`, 1, `
  ${ops(1)}
  (local.set $t1 (call $rget${w} (local.get $t0)))
  (local.set $t2 (i32.add (local.get $t1) (i32.const 1)))
  (call $rset${w} (local.get $t0) (i32.and (local.get $t2) (i32.const ${w === 8 ? '0xFF' : '0xFFFF'})))
  (call $flags_inc (local.get $t1) (local.get $t2) (i32.const ${w}))
`);
    h(`dec_r${w}`, 1, `
  ${ops(1)}
  (local.set $t1 (call $rget${w} (local.get $t0)))
  (local.set $t2 (i32.sub (local.get $t1) (i32.const 1)))
  (call $rset${w} (local.get $t0) (i32.and (local.get $t2) (i32.const ${w === 8 ? '0xFF' : '0xFFFF'})))
  (call $flags_dec (local.get $t1) (local.get $t2) (i32.const ${w}))
`);
    h(`inc_m${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (local.set $t2 (call $rd${w} (local.get $t5) (local.get $t4)))
  (local.set $t3 (i32.add (local.get $t2) (i32.const 1)))
  (call $wr${w} (local.get $t5) (local.get $t4) (i32.and (local.get $t3) (i32.const ${w === 8 ? '0xFF' : '0xFFFF'})))
  (call $flags_inc (local.get $t2) (local.get $t3) (i32.const ${w}))
`);
    h(`dec_m${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (local.set $t2 (call $rd${w} (local.get $t5) (local.get $t4)))
  (local.set $t3 (i32.sub (local.get $t2) (i32.const 1)))
  (call $wr${w} (local.get $t5) (local.get $t4) (i32.and (local.get $t3) (i32.const ${w === 8 ? '0xFF' : '0xFFFF'})))
  (call $flags_dec (local.get $t2) (local.get $t3) (i32.const ${w}))
`);
  }

  // Segment register moves. 8C reads one, 8E writes one.
  h('mov_r_sr', 1, `
  ${ops(1)}
  (call $rset16 (i32.and (local.get $t0) (i32.const 7))
                (call $sget (i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 3))))
`);
  h('mov_sr_r', 1, `
  ${ops(1)}
  (call $sset (i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 3))
              (call $rget16 (i32.and (local.get $t0) (i32.const 7))))
`);
  h('mov_m_sr', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $wr16 (local.get $t5) (local.get $t4)
              (call $sget (i32.and (local.get $t6) (i32.const 3))))
`);
  h('mov_sr_m', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $sset (i32.and (local.get $t6) (i32.const 3))
              (call $rd16 (local.get $t5) (local.get $t4)))
`);

  // Sign extension.
  h('cbw', 0, `
  (global.set $ax (i32.and
    (i32.shr_s (i32.shl (global.get $ax) (i32.const 24)) (i32.const 24))
    (i32.const 0xFFFF)))
`);
  h('cwd', 0, `
  (global.set $dx (select (i32.const 0xFFFF) (i32.const 0)
    (i32.and (i32.shr_u (global.get $ax) (i32.const 15)) (i32.const 1))))
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
  (global.set $ax (i32.or
    (i32.and (global.get $ax) (i32.const 0x00FF))
    (i32.shl (i32.and (global.get $flags) (i32.const 0xFF)) (i32.const 8))))
`);

  // JCXZ, LOOPZ, LOOPNZ -- the remaining counted-loop terminators.
  h('jcxz', 4, `
  ${ops(4)}
  (if (i32.eqz (global.get $cx))
    (then ${GO('(local.get $t0)', '(local.get $t1)')})
    (else ${GO('(local.get $t2)', '(local.get $t3)')}))
`);
  for (const [nm, want] of [['loopz', 1], ['loopnz', 0]]) {
    h(nm, 4, `
  ${ops(4)}
  (global.set $cx (i32.and (i32.sub (global.get $cx) (i32.const 1)) (i32.const 0xFFFF)))
  (if (i32.and (i32.ne (global.get $cx) (i32.const 0))
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
  (global.set $steps (i32.const -1))
`);
  h('iret', 0, `
  (global.set $gip (call $pop16))
  (call $sset (i32.const 1) (call $pop16))
  (global.set $flags (i32.or
    (i32.and (call $pop16) (i32.const ${isa.FLAGS_DEFINED}))
    (i32.const ${isa.FLAGS_RESERVED})))
  (global.set $steps (i32.const -1))
`);
}

// --- String operations, with and without REP --------------------------------
// ES is segment index 0 and is NOT overridable for the destination; the source
// defaults to DS and is. Direction comes from DF, so every one of these moves
// backwards when a demo sets STD -- which they do, constantly, for scrolls.
function genStrings() {
  const DELTA = (sz) => `(select (i32.const ${-sz}) (i32.const ${sz}) ${bit(F.DF)})`;
  const bump = (reg, sz) =>
    `(global.set $${reg} (i32.and (i32.add (global.get $${reg}) ${DELTA(sz)}) (i32.const 0xFFFF)))`;

  // body(w) produces one iteration; `rep` wraps it in a CX loop.
  const BODIES = {
    movs: (w, sz) => `
    (call $wr${w} (i32.const 0) (global.get $di)
      (call $rd${w} (local.get $t0) (global.get $si)))
    ${bump('si', sz)} ${bump('di', sz)}`,
    stos: (w, sz) => `
    (call $wr${w} (i32.const 0) (global.get $di) (call $rget${w} (i32.const 0)))
    ${bump('di', sz)}`,
    lods: (w, sz) => `
    (call $rset${w} (i32.const 0) (call $rd${w} (local.get $t0) (global.get $si)))
    ${bump('si', sz)}`,
    scas: (w, sz) => `
    (local.set $t2 (call $rget${w} (i32.const 0)))
    (local.set $t3 (call $rd${w} (i32.const 0) (global.get $di)))
    (call $flags_sub (local.get $t2) (local.get $t3)
      (i32.sub (local.get $t2) (local.get $t3)) (i32.const ${w}))
    ${bump('di', sz)}`,
    cmps: (w, sz) => `
    (local.set $t2 (call $rd${w} (local.get $t0) (global.get $si)))
    (local.set $t3 (call $rd${w} (i32.const 0) (global.get $di)))
    (call $flags_sub (local.get $t2) (local.get $t3)
      (i32.sub (local.get $t2) (local.get $t3)) (i32.const ${w}))
    ${bump('si', sz)} ${bump('di', sz)}`,
  };

  for (const [name, body] of Object.entries(BODIES)) {
    for (const w of [8, 16]) {
      const sz = w >> 3;
      const suffix = w === 8 ? 'b' : 'w';
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
      (br_if $done (i32.eqz (global.get $cx)))
      ${body(w, sz)}
      (global.set $cx (i32.and (i32.sub (global.get $cx) (i32.const 1)) (i32.const 0xFFFF)))
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
  for (const w of [8, 16]) {
    const mask = w === 8 ? 0xFF : 0xFFFF;
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
  (global.set $flags (i32.or (local.get $f) (i32.const ${isa.FLAGS_RESERVED})))
  (local.get $v))
`);
}

// /6 is not a second SHL. On this part it is the undocumented SETMO: the
// destination becomes all ones and the flags come out as if from a logic op.
// The count still matters for the CL forms -- a count of zero does nothing at
// all, flags included.
const SHIFT_KINDS = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'setmo', 'sar'];
function genSetmo() {
  for (const w of [8, 16]) {
    const all = w === 8 ? '0xFF' : '0xFFFF';
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
  for (const w of [8, 16]) {
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
  (global.set $ax (i32.mul (i32.and (global.get $ax) (i32.const 0xFF)) ${g(8).src}))
  (call $flags_mul (i32.and (i32.shr_u (global.get $ax) (i32.const 8)) (i32.const 0xFF)))
`);
    h(`mul_${form}16`, g(16).argc, `
  ${ops(g(16).argc)}
  ${g(16).pre}
  (local.set $t7 (i32.mul (global.get $ax) ${g(16).src}))
  (global.set $dx (i32.and (i32.shr_u (local.get $t7) (i32.const 16)) (i32.const 0xFFFF)))
  (global.set $ax (i32.and (local.get $t7) (i32.const 0xFFFF)))
  (call $flags_mul (global.get $dx))
`);
    h(`imul_${form}8`, g(8).argc, `
  ${ops(g(8).argc)}
  ${g(8).pre}
  (local.set $t7 (i32.mul
    (i32.shr_s (i32.shl (global.get $ax) (i32.const 24)) (i32.const 24))
    (i32.shr_s (i32.shl ${g(8).src} (i32.const 24)) (i32.const 24))))
  (global.set $ax (i32.and (local.get $t7) (i32.const 0xFFFF)))
  (call $flags_mul (i32.ne
    (i32.shr_s (i32.shl (local.get $t7) (i32.const 24)) (i32.const 24)) (local.get $t7)))
`);
    h(`imul_${form}16`, g(16).argc, `
  ${ops(g(16).argc)}
  ${g(16).pre}
  (local.set $t7 (i32.mul
    (i32.shr_s (i32.shl (global.get $ax) (i32.const 16)) (i32.const 16))
    (i32.shr_s (i32.shl ${g(16).src} (i32.const 16)) (i32.const 16))))
  (global.set $dx (i32.and (i32.shr_u (local.get $t7) (i32.const 16)) (i32.const 0xFFFF)))
  (global.set $ax (i32.and (local.get $t7) (i32.const 0xFFFF)))
  (call $flags_mul (i32.ne
    (i32.shr_s (i32.shl (local.get $t7) (i32.const 16)) (i32.const 16)) (local.get $t7)))
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
    const num = w === 8
      ? (signed ? '(i32.shr_s (i32.shl (global.get $ax) (i32.const 16)) (i32.const 16))'
                : '(global.get $ax)')
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
  (global.set $ax (i32.or (i32.and (local.get $t3) (i32.const 0xFF))
    (i32.shl (i32.and (${rem} ${num} ${dvs}) (i32.const 0xFF)) (i32.const 8))))`
      : `
  (global.set $dx (i32.and (${rem} ${num} ${dvs}) (i32.const 0xFFFF)))
  (global.set $ax (i32.and (local.get $t3) (i32.const 0xFFFF)))`;

    h(`${nm}_${form}${w}`, argc, `
  ${ops(argc)}
  ${g.pre}
  (local.set $t7 ${g.src})
  (if (i32.eqz (local.get $t7)) (then (call $fault0 ${ip}) (return)))
  ${w === 16 ? `(local.set $t0 (i32.or (i32.shl (global.get $dx) (i32.const 16)) (global.get $ax)))` : ''}
  (local.set $t3 (${div} ${num} ${dvs}))
  (if ${lim} (then (call $fault0 ${ip}) (return)))
  ${store}
`);
  }

  // Port I/O. Demos reach the VGA palette through 0x3C8/0x3C9 and wait on the
  // retrace bit of 0x3DA, so these must exist even though nothing here is a
  // real peripheral -- tools/toyvm/dos.js models the few ports that matter.
  for (const w of [8, 16]) {
    h(`in_${w}`, 1, `
  ${ops(1)}
  (call $rset${w} (i32.const 0)
    (call $port_in (select (global.get $dx) (local.get $t0)
                           (i32.eq (local.get $t0) (i32.const -1)))
                   (i32.const ${w})))
`);
    h(`out_${w}`, 1, `
  ${ops(1)}
  (call $port_out (select (global.get $dx) (local.get $t0)
                          (i32.eq (local.get $t0) (i32.const -1)))
                  (call $rget${w} (i32.const 0)) (i32.const ${w}))
`);
  }

  h('xlat', 1, `
  ${ops(1)}
  (call $rset8 (i32.const 0)
    (call $rd8 (local.get $t0)
      (i32.and (i32.add (global.get $bx) (i32.and (global.get $ax) (i32.const 0xFF)))
               (i32.const 0xFFFF))))
`);

  // MOV to/from a direct address (A0-A3). Common enough in tight code that it
  // gets its own handlers rather than going through the ModRM path.
  for (const w of [8, 16]) {
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
  (global.set $steps (i32.const -1))
`);
  h('call_far', 3, `
  ${ops(3)}
  (call $push16 (call $sget (i32.const 1)))
  (call $push16 (local.get $t2))
  (call $sset (i32.const 1) (local.get $t1))
  (global.set $gip (local.get $t0))
  (global.set $steps (i32.const -1))
`);
  h('retf', 0, `
  (global.set $gip (call $pop16))
  (call $sset (i32.const 1) (call $pop16))
  (global.set $steps (i32.const -1))
`);
  h('retf_imm', 1, `
  ${ops(1)}
  (global.set $gip (call $pop16))
  (call $sset (i32.const 1) (call $pop16))
  (global.set $sp (i32.and (i32.add (global.get $sp) (local.get $t0)) (i32.const 0xFFFF)))
  (global.set $steps (i32.const -1))
`);
  h('jmp_r16', 1, `
  ${ops(1)}
  (global.set $gip (call $rget16 (local.get $t0)))
  (global.set $steps (i32.const -1))
`);
  h('jmp_m16', 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (global.set $gip (call $rd16 (local.get $t5) (local.get $t4)))
  (global.set $steps (i32.const -1))
`);
  // The operand is read BEFORE the return address is pushed. `call sp` is the
  // case that proves it: the real part jumps to the SP the instruction started
  // with, not the decremented one.
  h('call_r16', 2, `
  ${ops(2)}
  (local.set $t3 (call $rget16 (local.get $t0)))
  (call $push16 (local.get $t1))
  (global.set $gip (local.get $t3))
  (global.set $steps (i32.const -1))
`);
  h('call_m16', 3, `
  ${ops(3)}
  ${EA_SETUP_PRE}
  (local.set $t3 (call $rd16 (local.get $t5) (local.get $t4)))
  (call $push16 (local.get $t2))
  (global.set $gip (local.get $t3))
  (global.set $steps (i32.const -1))
`);

  // LES/LDS load a far pointer into a segment register and a GPR at once.
  for (const [nm, seg] of [['les', 0], ['lds', 3]]) {
    h(nm, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (call $rset16 (local.get $t6) (call $rd16 (local.get $t5) (local.get $t4)))
  (call $sset (i32.const ${seg}) (call $rd16 (local.get $t5)
    (i32.and (i32.add (local.get $t4) (i32.const 2)) (i32.const 0xFFFF))))
`);
  }
}

genAlu();
genMov();
genBranches();
genExtras();
genStrings();
genShifts();
genSetmo();
genShiftHandlers();
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
function brTableFn(name, params, result, arms) {
  // Build the nested-block br_table shape by hand; it is the same one
  // $get_reg uses in src/03-registers.wat.
  // Block nesting order is load-bearing and easy to get backwards: branching to
  // $b0 exits block $b0, so arm 0 must sit immediately AFTER $b0 closes, not
  // inside it. $bad is therefore the outermost block and $b0 the innermost.
  const n = arms.length;
  let s = `(func $${name} ${params} ${result}\n(block $bad\n`;
  for (let i = n - 1; i >= 0; i--) s += `(block $b${i} `;
  s += `\n(br_table ${arms.map((_, i) => `$b${i}`).join(' ')} $bad (local.get $i))\n`;
  for (let i = 0; i < n; i++) s += `)\n${arms[i]}\n`;
  s += `)\n(unreachable)\n)\n`;
  return s;
}

function helpers() {
  const R = isa.REG16;
  let s = '';

  // 16-bit register file. Arms fall out of their block and then out of the
  // function, so each arm ends the function with its value.
  s += brTableFn('rget16', '(param $i i32)', '(result i32)',
    R.map(r => `(return (global.get $${r}))`));
  s += brTableFn('rset16', '(param $i i32) (param $v i32)', '',
    R.map(r => `(global.set $${r} (local.get $v)) (return)`));

  // 8-bit halves. 0-3 are the low bytes of AX/CX/DX/BX, 4-7 the high bytes.
  s += brTableFn('rget8', '(param $i i32)', '(result i32)',
    isa.REG8.map((_, i) => {
      const host = R[i & 3];
      return i < 4
        ? `(return (i32.and (global.get $${host}) (i32.const 0xFF)))`
        : `(return (i32.shr_u (global.get $${host}) (i32.const 8)))`;
    }));
  s += brTableFn('rset8', '(param $i i32) (param $v i32)', '',
    isa.REG8.map((_, i) => {
      const host = R[i & 3];
      return i < 4
        ? `(global.set $${host} (i32.or (i32.and (global.get $${host}) (i32.const 0xFF00)) (local.get $v))) (return)`
        : `(global.set $${host} (i32.or (i32.and (global.get $${host}) (i32.const 0x00FF)) (i32.shl (local.get $v) (i32.const 8)))) (return)`;
    }));
  s += brTableFn('sget', '(param $i i32)', '(result i32)',
    isa.SEG.map(r => `(return (global.get $${r}))`));
  s += brTableFn('sset', '(param $i i32) (param $v i32)', '',
    isa.SEG.map(r => `(global.set $${r} (local.get $v)) (return)`));

  // Effective address. Every form masks to 16 bits: the 8086 wraps an EA inside
  // its segment rather than carrying into the segment base.
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
  ];
  s += brTableFn('ea', '(param $i i32) (param $d i32)', '(result i32)', eaArms);

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

;; 16-bit access is done a byte at a time on purpose: an offset of 0xFFFF wraps
;; to 0x0000 within the SAME segment, which a single i32.load16_u would get
;; wrong. The test vectors exercise it.
(func $rd16 (param $seg i32) (param $off i32) (result i32)
  (i32.or
    (call $rd8 (local.get $seg) (local.get $off))
    (i32.shl (call $rd8 (local.get $seg)
               (i32.and (i32.add (local.get $off) (i32.const 1)) (i32.const 0xFFFF)))
             (i32.const 8))))

(func $wr16 (param $seg i32) (param $off i32) (param $v i32)
  (call $wr8 (local.get $seg) (local.get $off) (i32.and (local.get $v) (i32.const 0xFF)))
  (call $wr8 (local.get $seg)
    (i32.and (i32.add (local.get $off) (i32.const 1)) (i32.const 0xFFFF))
    (i32.shr_u (local.get $v) (i32.const 8))))

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
  (global.set $flags (i32.or (local.get $f) (i32.const ${isa.FLAGS_RESERVED}))))

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
  (global.set $flags (i32.or (local.get $f) (i32.const ${isa.FLAGS_RESERVED}))))

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
  (global.set $flags (i32.or (local.get $f) (i32.const ${isa.FLAGS_RESERVED}))))

;; MUL/IMUL set CF and OF together from "the upper half carries information"
;; and leave SF/ZF/AF/PF undefined. $nz is the caller's answer to that question.
(func $flags_mul (param $nz i32)
  (local $f i32)
  (local.set $f (i32.and (global.get $flags)
    (i32.const ${(~((1 << isa.F.CF) | (1 << isa.F.OF))) & 0xFFFF})))
  (local.set $nz (i32.ne (local.get $nz) (i32.const 0)))
  (global.set $flags (i32.or (i32.or (local.get $f)
    (i32.or (local.get $nz) (i32.shl (local.get $nz) (i32.const ${isa.F.OF}))))
    (i32.const ${isa.FLAGS_RESERVED}))))

;; Divide error. Same sequence as INT 0 -- and the same handing-back to the
;; host, since the vector points at whatever the guest installed.
(func $fault0 (param $ip i32)
  (call $push16 (global.get $flags))
  (call $push16 (call $sget (i32.const 1)))
  (call $push16 (local.get $ip))
  (global.set $flags (i32.and (global.get $flags)
    (i32.const ${(~((1 << isa.F.IF) | (1 << isa.F.TF))) & 0xFFFF})))
  (global.set $intno (i32.const 0))
  (global.set $gip (call $rdphys16 (i32.const 0)))
  (call $sset (i32.const 1) (call $rdphys16 (i32.const 2)))
  (global.set $steps (i32.const -1)))
${SHIFT_FNS.join('')}`;
  return s;
}

// Every piece of guest state is a wasm global, exactly as it is in the real
// interpreter -- that is the thing under test, so the toy must not "improve" on
// it by putting registers in linear memory.
// $intno records which INT vector handed control back, so the host can service
// DOS and BIOS calls in JS instead of the VM pretending to be DOS.
const STATE = [...isa.REG16, ...isa.SEG, 'gip', 'flags', 'ip', 'steps', 'intno'];

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
(type $void (func))
${accessors}
`;
}

const LOCALS = '(local $t0 i32) (local $t1 i32) (local $t2 i32) (local $t3 i32) '
  + '(local $t4 i32) (local $t5 i32) (local $t6 i32) (local $t7 i32)';

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

function emitSwitch(replicated) {
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
    // Replicated: each arm re-runs the whole dispatch itself, so each gets its
    // own branch site and its own predictor history. Non-replicated: fall out
    // to the shared loop back-edge and through the one site again.
    s += replicated ? `${dispatch}\n` : `(br $l)\n`;
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
  (call $next))
`;
}

const VARIANTS = {
  tailcall: emitTailcall,
  calls: emitCalls,
  switch: () => emitSwitch(false),
};

function emit(variant) {
  const fn = VARIANTS[variant];
  if (!fn) throw new Error(`unknown variant: ${variant} (have ${Object.keys(VARIANTS).join(', ')})`);
  return fn();
}

module.exports = { emit, HANDLERS, VARIANTS: Object.keys(VARIANTS) };

// CLI: dump one variant's WAT, for eyeballing or for handing to wat2wasm.
//   node tools/toyvm/emit.js --variant=tailcall > /tmp/t.wat
if (require.main === module) {
  const a = process.argv.slice(2).find(x => x.startsWith('--variant='));
  process.stdout.write(emit(a ? a.slice(10) : 'tailcall'));
}
