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
const ALU = {
  add: { code: 0, flags: 'add', write: true, op: 'i32.add' },
  or: { code: 1, flags: 'logic', write: true, op: 'i32.or' },
  and: { code: 4, flags: 'logic', write: true, op: 'i32.and' },
  sub: { code: 5, flags: 'sub', write: true, op: 'i32.sub' },
  xor: { code: 6, flags: 'logic', write: true, op: 'i32.xor' },
  cmp: { code: 7, flags: 'sub', write: false, op: 'i32.sub' },
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
      const flags = (a, b, s) => spec.flags === 'logic'
        ? `(call $flags_logic (i32.and ${s} (i32.const ${mask})) (i32.const ${w}))`
        : `(call $flags_${spec.flags} ${a} ${b} ${s} (i32.const ${w}))`;

      h(`${name}_rr${w}`, 1, `
  ${ops(1)}
  (local.set $t1 (call ${rget} (i32.and (local.get $t0) (i32.const 7))))
  (local.set $t2 (call ${rget} (i32.and (i32.shr_u (local.get $t0) (i32.const 4)) (i32.const 7))))
  (local.set $t3 (${spec.op} (local.get $t1) (local.get $t2)))
  ${spec.write ? `(call ${rset} (i32.and (local.get $t0) (i32.const 7)) (i32.and (local.get $t3) (i32.const ${mask})))` : ''}
  ${flags('(local.get $t1)', '(local.get $t2)', '(local.get $t3)')}
`);

      h(`${name}_mr${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (local.set $t2 (call ${rd} (local.get $t5) (local.get $t4)))
  (local.set $t3 (call ${rget} (local.get $t6)))
  (local.set $t7 (${spec.op} (local.get $t2) (local.get $t3)))
  ${spec.write ? `(call ${wr} (local.get $t5) (local.get $t4) (i32.and (local.get $t7) (i32.const ${mask})))` : ''}
  ${flags('(local.get $t2)', '(local.get $t3)', '(local.get $t7)')}
`);

      h(`${name}_rm${w}`, 2, `
  ${ops(2)}
  ${EA_SETUP_PRE}
  (local.set $t2 (call ${rget} (local.get $t6)))
  (local.set $t3 (call ${rd} (local.get $t5) (local.get $t4)))
  (local.set $t7 (${spec.op} (local.get $t2) (local.get $t3)))
  ${spec.write ? `(call ${rset} (local.get $t6) (i32.and (local.get $t7) (i32.const ${mask})))` : ''}
  ${flags('(local.get $t2)', '(local.get $t3)', '(local.get $t7)')}
`);

      h(`${name}_ri${w}`, 2, `
  ${ops(2)}
  (local.set $t2 (call ${rget} (local.get $t0)))
  (local.set $t3 (${spec.op} (local.get $t2) (local.get $t1)))
  ${spec.write ? `(call ${rset} (local.get $t0) (i32.and (local.get $t3) (i32.const ${mask})))` : ''}
  ${flags('(local.get $t2)', '(local.get $t1)', '(local.get $t3)')}
`);

      h(`${name}_mi${w}`, 3, `
  ${ops(3)}
  ${EA_SETUP_PRE}
  (local.set $t3 (call ${rd} (local.get $t5) (local.get $t4)))
  (local.set $t7 (${spec.op} (local.get $t3) (local.get $t2)))
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

genAlu();
genMov();

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
`;
  return s;
}

// Every piece of guest state is a wasm global, exactly as it is in the real
// interpreter -- that is the thing under test, so the toy must not "improve" on
// it by putting registers in linear memory.
const STATE = [...isa.REG16, ...isa.SEG, 'gip', 'flags', 'ip', 'steps'];

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
