'use strict';

// The x86 decoder, in wasm, generated from the tables the JS decoder decodes
// with. See docs/toyvm-decoder-in-wasm.md for why it is moving and what the
// contract is.
//
// GENERATED, not hand-written, and from the SAME tables as tools/toyvm/decode.js
// -- the two decoders have to agree exactly wherever they overlap, and the one
// place a decoder drifts first is which handler an encoding names. Writing the
// mapping out twice guarantees a disagreement the first time an opcode moves;
// generating both from one table means tools/toyvm/decode-diff.js is comparing
// one table rendered two ways, which is a test rather than a coin toss.
//
// The unit is a BLOCK, not an instruction. A wasm decodeOne called from a JS
// loop would add a boundary crossing per instruction to remove none, so
// $compile_block runs the whole worklist -- straight-line code until a branch,
// branch targets queued -- and hands the host back only what its cache needs.
//
// Anything not implemented here declines: $compile_block returns 0 having
// written nothing, and the host compiles that block with the JS decoder. So
// correctness never depends on this being complete, only on it being right
// about what it claims, and opcode families can land one at a time.

const isa = require('./isa');

// The tables come from decode.js, required lazily. decode.js requires emit.js
// for HANDLERS and emit.js requires this file, so a top-level require here
// would close a cycle and hand us a half-built module. Every call happens
// during emit(), long after both have finished loading.
function tables() {
  const { H } = require('./decode');
  return { H };
}

// x86 lays the ALU group out at 8*code + form; MOV shares all five operand
// shapes with it exactly, so it rides in the same tables as a ninth row and
// the emitters below need no special case for it.
const ALU_ROWS = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp', 'mov'];
const MOV_ROW = 8;
// Jcc in tttn order, which is opcode order for 70..7F.
const CC_NAMES = ['o', 'no', 'b', 'ae', 'z', 'nz', 'be', 'a',
  's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'];
// The three operand widths, in the order the tables index them.
const WIDTHS = [8, 16, 32];
const wIndex = (w) => (w === 8 ? 0 : w === 16 ? 1 : 2);

// Five shapes x nine ops x three widths, then the sixteen jumps. Missing
// combinations are stored as -1 and refused at decode time rather than
// silently decoded as whatever sits at index 0 -- `mov_ri8` exists but
// `mov_mr8` and `add_rr8` do not have the same spelling everywhere, and a
// wrong handler index is the one decoder bug that produces plausible garbage.
const SHAPES = ['rr', 'rm', 'mr', 'ri', 'mi'];

// Why a block compile stopped. The host needs to tell these apart: ENDED means
// the block is complete and needs nothing further, UNIMPL means resume the JS
// decoder at $dc_stop_ip, and FULL means the arena filled and the caller has to
// decide whether to grow it or split the block.
const STOP = { ENDED: 1, UNIMPL: 2, FULL: 3, ONE: 4 };

function decoderTables(H) {
  const words = [];
  const at = {};
  const push = (name, vals) => { at[name] = words.length * 4; words.push(...vals); };

  for (const shape of SHAPES) {
    const row = [];
    for (const op of ALU_ROWS) {
      for (const w of WIDTHS) {
        const h = H[`${op}_${shape}${w}`];
        row.push(h === undefined ? -1 : h);
      }
    }
    push(shape, row);
  }
  push('jcc', CC_NAMES.map((c) => {
    const h = H[`j${c}`];
    return h === undefined ? -1 : h;
  }));
  // Which segment each 16-bit EA kind defaults to with no prefix. Straight out
  // of isa so the two decoders read one list; stored a word per entry rather
  // than a byte because the whole table is i32 and a mixed-width segment is a
  // second layout to get wrong for eight bytes saved.
  push('defseg', isa.EA_DEFAULT_SEG.slice());
  // The unconditional near jump, used to close a block that has run into the
  // head of one already emitted.
  push('jmp', [H.jmp === undefined ? -1 : H.jmp]);
  return { words, at };
}

// Bytes for a (data ...) segment, little-endian i32s.
function dataBytes(words) {
  let s = '';
  for (const w of words) {
    const v = w | 0;
    for (let i = 0; i < 4; i++) s += `\\${(((v >> (i * 8)) & 0xFF)).toString(16).padStart(2, '0')}`;
  }
  return s;
}

// --- the generated module ---------------------------------------------------

function decoderWat() {
  const { H } = tables();
  const T = decoderTables(H);
  const A = isa.EA_A32;
  const tab = (name) => isa.DEC_TAB + T.at[name];

  // Index arithmetic for the five shape tables: nine ops x three widths.
  const shapeAt = (name, opExpr, wExpr) =>
    `(i32.load (i32.add (i32.const ${tab(name)})
       (i32.shl (i32.add (i32.mul ${opExpr} (i32.const 3)) ${wExpr}) (i32.const 2))))`;

  return `
(data (i32.const ${isa.DEC_TAB}) "${dataBytes(T.words)}")

;; --- decoder state ---------------------------------------------------------
;; One compile at a time, so this is a set of globals rather than a parameter
;; block. $dc_ prefixed so nothing here can be confused with the interpreter's
;; own state, which these must never touch: decoding is a pure function of the
;; guest's BYTES, and a decoder that read $ax would compile one program into
;; something only correct for the run that compiled it.
(global $dc_base (mut i32) (i32.const 0))    ;; CS linear base
(global $dc_mask (mut i32) (i32.const 0))    ;; address bus mask
(global $dc_d32 (mut i32) (i32.const 0))     ;; CS descriptor D bit
(global $dc_ip (mut i32) (i32.const 0))      ;; guest ip of this instruction
(global $dc_n (mut i32) (i32.const 0))       ;; bytes consumed so far
(global $dc_opsize (mut i32) (i32.const 0))
(global $dc_asize (mut i32) (i32.const 0))
(global $dc_seg (mut i32) (i32.const 0))     ;; segment override, -1 for none
(global $dc_rep (mut i32) (i32.const 0))     ;; 0 none, 1 rep (F3), 2 repne (F2)
(global $dc_out (mut i32) (i32.const 0))     ;; arena word index to write next
(global $dc_max (mut i32) (i32.const 0))     ;; arena word capacity
(global $dc_arena (mut i32) (i32.const 0))   ;; arena base address
(global $dc_ends (mut i32) (i32.const 0))    ;; this instruction ended the block
(global $dc_wrote (mut i32) (i32.const 0))   ;; this instruction stored to memory
(global $dc_bulk (mut i32) (i32.const 0))    ;; ...and stored a RANGE (a REP'd string op)
(global $dc_bad (mut i32) (i32.const 0))     ;; decline flag: something was not implemented
;; The packed effective address and its displacement, set by $dc_modrm. Two
;; globals rather than a multi-value return because every caller wants both and
;; most want to look at $dc_isreg first.
(global $dc_isreg (mut i32) (i32.const 0))
(global $dc_ea (mut i32) (i32.const 0))
(global $dc_disp (mut i32) (i32.const 0))
(global $dc_reg (mut i32) (i32.const 0))
(global $dc_rm (mut i32) (i32.const 0))
;; Side-table counts, read back by the host after the call.
(global $dc_stopped (mut i32) (i32.const 0))   ;; why the block compile stopped
(global $dc_stop_ip (mut i32) (i32.const 0))   ;; ...and the guest ip it stopped at
(global $dc_outAtInsn (mut i32) (i32.const 0)) ;; out cursor at the current instruction
(global $dc_blockWrote (mut i32) (i32.const 0)) ;; any instruction in the block stored
(global $dc_blockBulk (mut i32) (i32.const 0))  ;; ...and any stored a range

(global $dc_nfix (mut i32) (i32.const 0))
(global $dc_ncov (mut i32) (i32.const 0))

;; How an instruction pointer wraps in this segment: 16 bits normally, 32 in a
;; segment whose descriptor has the D bit set. Getting this wrong does not
;; produce a near miss -- ACME-SYW.EXE's return to 0x11c43 read as 0x1c43 is a
;; text banner in its data.
(func $dc_wip (param $v i32) (result i32)
  (if (result i32) (global.get $dc_d32)
    (then (local.get $v))
    (else (i32.and (local.get $v) (i32.const 0xFFFF)))))

;; The byte at offset $k of the instruction being decoded.
(func $dc_at (param $k i32) (result i32)
  (i32.load8_u (i32.and (i32.add (global.get $dc_base)
                                 (call $dc_wip (i32.add (global.get $dc_ip) (local.get $k))))
                        (global.get $dc_mask))))

;; ...and the same byte, consumed.
(func $dc_next8 (param $unused i32) (result i32)
  (local $v i32)
  (local.set $v (call $dc_at (global.get $dc_n)))
  (global.set $dc_n (i32.add (global.get $dc_n) (i32.const 1)))
  (local.get $v))

(func $dc_imm8 (result i32) (call $dc_next8 (i32.const 0)))

(func $dc_imm16 (result i32)
  (local $v i32)
  (local.set $v (i32.or (call $dc_at (global.get $dc_n))
                        (i32.shl (call $dc_at (i32.add (global.get $dc_n) (i32.const 1)))
                                 (i32.const 8))))
  (global.set $dc_n (i32.add (global.get $dc_n) (i32.const 2)))
  (local.get $v))

(func $dc_imm32 (result i32)
  (local $v i32)
  (local.set $v (i32.or
    (i32.or (call $dc_at (global.get $dc_n))
            (i32.shl (call $dc_at (i32.add (global.get $dc_n) (i32.const 1))) (i32.const 8)))
    (i32.or (i32.shl (call $dc_at (i32.add (global.get $dc_n) (i32.const 2))) (i32.const 16))
            (i32.shl (call $dc_at (i32.add (global.get $dc_n) (i32.const 3))) (i32.const 24)))))
  (global.set $dc_n (i32.add (global.get $dc_n) (i32.const 4)))
  (local.get $v))

;; Every "imm16" in the 8086 manual is really this: at the operand size, so two
;; bytes normally and four behind a 0x66 prefix.
(func $dc_immW (result i32)
  (if (result i32) (i32.eq (global.get $dc_opsize) (i32.const 32))
    (then (call $dc_imm32))
    (else (call $dc_imm16))))

(func $dc_sx8 (param $v i32) (result i32)
  (if (result i32) (i32.and (local.get $v) (i32.const 0x80))
    (then (i32.sub (local.get $v) (i32.const 0x100)))
    (else (local.get $v))))

;; A sign-extended imm8 AT THE OPERAND SIZE. In a 16-bit operand size the result
;; has to be masked back to 16 bits, because that is the width the handler will
;; read it at; leaving it negative makes 0x83 /5 subtract a 32-bit constant.
(func $dc_sx8toW (param $v i32) (result i32)
  (if (result i32) (i32.eq (global.get $dc_opsize) (i32.const 32))
    (then (call $dc_sx8 (local.get $v)))
    (else (i32.and (call $dc_sx8 (local.get $v)) (i32.const 0xFFFF)))))

;; --- arena output ----------------------------------------------------------
;; Every emit goes through here so the capacity check cannot be forgotten at one
;; call site. Past the end it raises the decline flag and keeps going; the
;; caller checks once, at the end of the block, rather than after every word.
(func $dc_w (param $v i32)
  (if (i32.ge_u (global.get $dc_out) (global.get $dc_max))
    (then (global.set $dc_bad (i32.const 1)) (return)))
  (i32.store (i32.add (global.get $dc_arena) (i32.shl (global.get $dc_out) (i32.const 2)))
             (local.get $v))
  (global.set $dc_out (i32.add (global.get $dc_out) (i32.const 1))))

;; A handler index straight out of one of the generated tables, refusing the
;; combinations the table has no spelling for. -1 means the encoding names a
;; handler that does not exist, which is a decline and never an index.
(func $dc_wh (param $h i32)
  (if (i32.lt_s (local.get $h) (i32.const 0))
    (then (global.set $dc_bad (i32.const 1)) (return)))
  (call $dc_w (local.get $h)))

;; --- ModRM -----------------------------------------------------------------
;; Bits 0-3 the EA form, 4-6 the segment, 8-10 the ModRM reg field, and for the
;; 32-bit form the base/index/scale above that. Same packing as decode.js's
;; packEa, because the handlers read it and there is only one layout.
(func $dc_modrm
  (local $m i32) (local $mod i32) (local $rm i32)
  (local $base i32) (local $index i32) (local $scale i32) (local $sib i32)
  (local $nobase i32) (local $disp i32) (local $kind i32) (local $seg i32)
  (local.set $m (call $dc_next8 (i32.const 0)))
  (local.set $mod (i32.shr_u (local.get $m) (i32.const 6)))
  (global.set $dc_reg (i32.and (i32.shr_u (local.get $m) (i32.const 3)) (i32.const 7)))
  (local.set $rm (i32.and (local.get $m) (i32.const 7)))
  (global.set $dc_rm (local.get $rm))
  (global.set $dc_disp (i32.const 0))
  ;; mod=11 is a register operand and has no address at all.
  (if (i32.eq (local.get $mod) (i32.const 3))
    (then (global.set $dc_isreg (i32.const 1)) (return)))
  (global.set $dc_isreg (i32.const 0))

  (if (i32.eq (global.get $dc_asize) (i32.const 32))
    (then
      ;; The 386 form: rm=100 means a SIB byte follows, rm=101 with mod=00 is a
      ;; bare disp32, and mod=10's displacement is four bytes rather than two.
      (local.set $base (local.get $rm))
      (local.set $index (i32.const 4))   ;; 100 is the "no index" code
      (local.set $scale (i32.const 0))
      (local.set $nobase (i32.const 0))
      (local.set $disp (i32.const 0))
      (if (i32.eq (local.get $rm) (i32.const 4))
        (then
          (local.set $sib (call $dc_next8 (i32.const 0)))
          (local.set $scale (i32.shr_u (local.get $sib) (i32.const 6)))
          (local.set $index (i32.and (i32.shr_u (local.get $sib) (i32.const 3)) (i32.const 7)))
          (local.set $base (i32.and (local.get $sib) (i32.const 7)))))
      (if (i32.and (i32.eq (local.get $rm) (i32.const 5)) (i32.eqz (local.get $mod)))
        (then (local.set $nobase (i32.const 1)) (local.set $disp (call $dc_imm32)))
        (else (if (i32.and (i32.and (i32.eq (local.get $base) (i32.const 5))
                                    (i32.eqz (local.get $mod)))
                           (i32.eq (local.get $rm) (i32.const 4)))
          (then (local.set $nobase (i32.const 1)) (local.set $disp (call $dc_imm32)))
          (else (if (i32.eq (local.get $mod) (i32.const 1))
            (then (local.set $disp (call $dc_sx8 (call $dc_next8 (i32.const 0)))))
            (else (if (i32.eq (local.get $mod) (i32.const 2))
              (then (local.set $disp (call $dc_imm32))))))))))
      ;; ESP and EBP as a BASE are stack-relative; an index of EBP is not,
      ;; which is why this reads the SIB base and not the ModRM rm field.
      (local.set $seg (if (result i32) (i32.ge_s (global.get $dc_seg) (i32.const 0))
        (then (global.get $dc_seg))
        (else (if (result i32)
                (i32.and (i32.eqz (local.get $nobase))
                         (i32.or (i32.eq (local.get $base) (i32.const 4))
                                 (i32.eq (local.get $base) (i32.const 5))))
          (then (i32.const 2))
          (else (i32.const 3))))))
      (global.set $dc_disp (local.get $disp))
      (global.set $dc_ea (i32.or (i32.or
        (i32.or (i32.const ${isa.EA.A32})
                (i32.shl (i32.and (local.get $seg) (i32.const 7)) (i32.const 4)))
        (i32.shl (global.get $dc_reg) (i32.const 8)))
        (i32.or
          (i32.or (i32.shl (i32.and (local.get $base) (i32.const 7)) (i32.const ${A.BASE_SHIFT}))
                  (i32.shl (i32.and (local.get $index) (i32.const 7)) (i32.const ${A.INDEX_SHIFT})))
          (i32.or (i32.shl (i32.and (local.get $scale) (i32.const 3)) (i32.const ${A.SCALE_SHIFT}))
                  (i32.or
                    (select (i32.const ${A.NO_BASE}) (i32.const 0) (local.get $nobase))
                    (select (i32.const ${A.NO_INDEX}) (i32.const 0)
                            (i32.eq (local.get $index) (i32.const 4))))))))
      (return)))

  ;; The 16-bit form. The EA kind is the rm field, except mod=00 rm=110, which
  ;; is a bare disp16 with no base at all.
  (local.set $kind (local.get $rm))
  (local.set $disp (i32.const 0))
  (if (i32.and (i32.eqz (local.get $mod)) (i32.eq (local.get $rm) (i32.const 6)))
    (then (local.set $kind (i32.const ${isa.EA.DISP})) (local.set $disp (call $dc_imm16)))
    (else (if (i32.eq (local.get $mod) (i32.const 1))
      (then (local.set $disp (call $dc_sx8 (call $dc_next8 (i32.const 0)))))
      (else (if (i32.eq (local.get $mod) (i32.const 2))
        (then (local.set $disp (call $dc_imm16))))))))
  ;; Anything built on BP is stack-relative; everything else is data.
  (local.set $seg (if (result i32) (i32.ge_s (global.get $dc_seg) (i32.const 0))
    (then (global.get $dc_seg))
    (else (i32.load (i32.add (i32.const ${tab('defseg')})
                             (i32.shl (local.get $kind) (i32.const 2)))))))
  (global.set $dc_disp (i32.and (local.get $disp) (i32.const 0xFFFF)))
  (global.set $dc_ea (i32.or
    (i32.or (i32.and (local.get $kind) (i32.const 15))
            (i32.shl (i32.and (local.get $seg) (i32.const 7)) (i32.const 4)))
    (i32.shl (global.get $dc_reg) (i32.const 8)))))

;; --- the five operand shapes the ALU group and MOV share -------------------
;; $op indexes ALU_ROWS, $w is 8/16/32. dstIsRm picks which of the pair is the
;; destination, which is the only thing that separates 88 from 8A.
(func $dc_rmr (param $op i32) (param $w i32) (param $dstIsRm i32)
  (local $wi i32)
  (local.set $wi (if (result i32) (i32.eq (local.get $w) (i32.const 8))
    (then (i32.const 0))
    (else (if (result i32) (i32.eq (local.get $w) (i32.const 16))
      (then (i32.const 1)) (else (i32.const 2))))))
  (if (global.get $dc_isreg)
    (then
      (call $dc_wh ${shapeAt('rr', '(local.get $op)', '(local.get $wi)')})
      (call $dc_w (if (result i32) (local.get $dstIsRm)
        (then (i32.or (global.get $dc_rm) (i32.shl (global.get $dc_reg) (i32.const 4))))
        (else (i32.or (global.get $dc_reg) (i32.shl (global.get $dc_rm) (i32.const 4)))))))
    (else
      (if (local.get $dstIsRm) (then (global.set $dc_wrote (i32.const 1))))
      (call $dc_wh (if (result i32) (local.get $dstIsRm)
        (then ${shapeAt('mr', '(local.get $op)', '(local.get $wi)')})
        (else ${shapeAt('rm', '(local.get $op)', '(local.get $wi)')})))
      (call $dc_w (global.get $dc_ea))
      (call $dc_w (global.get $dc_disp)))))

(func $dc_rmi (param $op i32) (param $w i32) (param $imm i32)
  (local $wi i32)
  (local.set $wi (if (result i32) (i32.eq (local.get $w) (i32.const 8))
    (then (i32.const 0))
    (else (if (result i32) (i32.eq (local.get $w) (i32.const 16))
      (then (i32.const 1)) (else (i32.const 2))))))
  (if (global.get $dc_isreg)
    (then
      (call $dc_wh ${shapeAt('ri', '(local.get $op)', '(local.get $wi)')})
      (call $dc_w (global.get $dc_rm))
      (call $dc_w (local.get $imm)))
    (else
      (global.set $dc_wrote (i32.const 1))
      (call $dc_wh ${shapeAt('mi', '(local.get $op)', '(local.get $wi)')})
      (call $dc_w (global.get $dc_ea))
      (call $dc_w (global.get $dc_disp))
      (call $dc_w (local.get $imm)))))

;; --- side tables -----------------------------------------------------------
;; A branch target is emitted as [handler, 0, targetIp, 0, fallIp]; the host
;; resolves the two zero slots to arena addresses once every block head is
;; known. The fixup records WHICH word to patch, so the layout above and this
;; are one fact and have to move together.
(func $dc_fixup (param $wordIndex i32) (param $ip i32)
  (if (i32.ge_u (global.get $dc_nfix) (i32.const ${isa.DEC_FIXUPS_MAX}))
    (then (global.set $dc_bad (i32.const 1)) (return)))
  (i32.store (i32.add (i32.const ${isa.DEC_FIXUPS})
                      (i32.shl (global.get $dc_nfix) (i32.const 3)))
             (local.get $wordIndex))
  (i32.store offset=4 (i32.add (i32.const ${isa.DEC_FIXUPS})
                               (i32.shl (global.get $dc_nfix) (i32.const 3)))
             (local.get $ip))
  (global.set $dc_nfix (i32.add (global.get $dc_nfix) (i32.const 1))))

(func $dc_cover (param $from i32) (param $to i32)
  (local $a i32)
  (if (i32.ge_u (global.get $dc_ncov) (i32.const ${isa.DEC_COVERED_MAX}))
    (then (global.set $dc_bad (i32.const 1)) (return)))
  (local.set $a (i32.add (i32.const ${isa.DEC_COVERED})
                         (i32.shl (global.get $dc_ncov) (i32.const 3))))
  (i32.store (local.get $a) (local.get $from))
  (i32.store offset=4 (local.get $a) (local.get $to))
  (global.set $dc_ncov (i32.add (global.get $dc_ncov) (i32.const 1))))

;; --- one instruction -------------------------------------------------------
;; Consumes prefixes and one opcode from $dc_ip, emits its words, and leaves
;; $dc_n holding the instruction's length. Sets $dc_bad for anything not
;; implemented, having emitted nothing useful -- the caller throws the whole
;; block away, so a partial emit costs nothing but the words it wrote.
(func $dc_one
  (local $b i32) (local $op i32) (local $form i32) (local $alu i32)
  (local $w i32) (local $d i32) (local $fall i32) (local $target i32)
  (global.set $dc_n (i32.const 0))
  (global.set $dc_seg (i32.const -1))
  (global.set $dc_rep (i32.const 0))
  (global.set $dc_ends (i32.const 0))
  (global.set $dc_wrote (i32.const 0))
  (global.set $dc_bulk (i32.const 0))
  (global.set $dc_opsize (select (i32.const 32) (i32.const 16) (global.get $dc_d32)))
  (global.set $dc_asize (select (i32.const 32) (i32.const 16) (global.get $dc_d32)))

  ;; Prefixes. A segment override and a repeat prefix can both be present, and
  ;; the LAST one of each kind wins.
  (block $done
    (loop $l
      (local.set $b (call $dc_at (global.get $dc_n)))
      (block $notprefix
        (br_if $notprefix (i32.eqz (call $dc_isPrefix (local.get $b))))
        (call $dc_takePrefix (local.get $b))
        (global.set $dc_n (i32.add (global.get $dc_n) (i32.const 1)))
        ;; Prefix soup, which the corpus does not produce -- and the same limit
        ;; the JS decoder applies, because a byte run that one decoder calls an
        ;; instruction and the other refuses is a block that means two different
        ;; things depending on which one reached it. Found by diffing every
        ;; offset of ATTIC.EXE, where nine 0x66 bytes in a row read as one.
        (if (i32.gt_u (global.get $dc_n) (i32.const 8))
          (then (global.set $dc_bad (i32.const 1)) (return)))
        (br $l))
      (br $done)))

  (local.set $op (call $dc_next8 (i32.const 0)))

  ;; A store through a CS override is the self-patch shape, and the JS decoder
  ;; ends the block on one so the patched bytes are recompiled -- unless the
  ;; host has watched that exact linear address hit nothing compiled often
  ;; enough to call it benign. That verdict is host state, learned at RUN time
  ;; from what the store actually hit, and it is the right place for it: DOPE.EXE
  ;; builds a fade table inside its own code segment and cutting the block there
  ;; cost 96% of its wall clock until the host learned better.
  ;;
  ;; So this declines the whole shape rather than reimplementing half of it.
  ;; Deciding it here without the benign set would end blocks the host has
  ;; already decided not to end, which is not a wrong decode -- it is a decode
  ;; that silently gives back a measured 96%.
  (if (i32.eq (global.get $dc_seg) (i32.const 1))
    (then (if (i32.or (i32.or (i32.eq (local.get $op) (i32.const 0x88))
                              (i32.eq (local.get $op) (i32.const 0x89)))
                      (i32.or (i32.eq (local.get $op) (i32.const 0xC6))
                              (i32.eq (local.get $op) (i32.const 0xC7))))
            (then (global.set $dc_bad (i32.const 1)) (return)))))

  ;; --- ALU group: 8*code + form, forms 0..5 --------------------------------
  ;; The (op & 7) < 6 test is what keeps the non-ALU opcodes sharing the 8*code
  ;; block -- PUSH/POP seg at x6/x7 and DAA/AAA at x7 -- out of here.
  (if (i32.and (i32.lt_u (local.get $op) (i32.const 0x40))
               (i32.lt_u (i32.and (local.get $op) (i32.const 7)) (i32.const 6)))
    (then
      (local.set $alu (i32.shr_u (local.get $op) (i32.const 3)))
      (local.set $form (i32.and (local.get $op) (i32.const 7)))
      (if (i32.le_u (local.get $form) (i32.const 3))
        (then
          (local.set $w (if (result i32) (i32.and (local.get $form) (i32.const 1))
            (then (global.get $dc_opsize)) (else (i32.const 8))))
          (call $dc_modrm)
          (call $dc_rmr (local.get $alu) (local.get $w)
                        (i32.lt_u (local.get $form) (i32.const 2))))
        (else (if (i32.eq (local.get $form) (i32.const 4))
          (then   ;; AL, imm8
            (call $dc_wh ${shapeAt('ri', '(local.get $alu)', '(i32.const 0)')})
            (call $dc_w (i32.const 0))
            (call $dc_w (call $dc_imm8)))
          (else   ;; AX / EAX, immW
            (call $dc_wh ${shapeAt('ri', '(local.get $alu)',
              '(select (i32.const 2) (i32.const 1) (i32.eq (global.get $dc_opsize) (i32.const 32)))')})
            (call $dc_w (i32.const 0))
            (call $dc_w (call $dc_immW))))))
      (return)))

  ;; --- ALU with immediate, group 80/81/82/83 -------------------------------
  ;; The op comes from the ModRM reg field rather than the opcode. 0x82 is an
  ;; undocumented alias of 0x80 that assemblers of the era emitted, so the
  ;; corpus contains it. 0x83 is the sign-extended-imm8 form, which is what a
  ;; compiler emits for a small constant and is therefore everywhere.
  (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x80))
               (i32.le_u (local.get $op) (i32.const 0x83)))
    (then
      (call $dc_modrm)
      (if (i32.or (i32.eq (local.get $op) (i32.const 0x80))
                  (i32.eq (local.get $op) (i32.const 0x82)))
        (then (call $dc_rmi (global.get $dc_reg) (i32.const 8) (call $dc_imm8)))
        (else (if (i32.eq (local.get $op) (i32.const 0x81))
          (then (call $dc_rmi (global.get $dc_reg) (global.get $dc_opsize) (call $dc_immW)))
          (else (call $dc_rmi (global.get $dc_reg) (global.get $dc_opsize)
                              (call $dc_sx8toW (call $dc_imm8)))))))
      (return)))

  ;; --- MOV r/m, r and r, r/m ----------------------------------------------
  (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x88))
               (i32.le_u (local.get $op) (i32.const 0x8B)))
    (then
      (call $dc_modrm)
      (call $dc_rmr (i32.const ${MOV_ROW})
        (if (result i32) (i32.and (local.get $op) (i32.const 1))
          (then (global.get $dc_opsize)) (else (i32.const 8)))
        (i32.lt_u (local.get $op) (i32.const 0x8A)))
      (return)))

  ;; --- MOV r/m, imm --------------------------------------------------------
  (if (i32.eq (local.get $op) (i32.const 0xC6))
    (then (call $dc_modrm)
          (call $dc_rmi (i32.const ${MOV_ROW}) (i32.const 8) (call $dc_imm8))
          (return)))
  (if (i32.eq (local.get $op) (i32.const 0xC7))
    (then (call $dc_modrm)
          (call $dc_rmi (i32.const ${MOV_ROW}) (global.get $dc_opsize) (call $dc_immW))
          (return)))

  ;; --- Conditional jumps, 70-7F -------------------------------------------
  ;; rel8 is measured from the END of the instruction, so the target can only be
  ;; computed once the displacement byte has been consumed.
  ;;
  ;; 0x60-0x6F alias to the same sixteen jumps on an 8088 and become PUSH/IMUL/
  ;; INS/OUTS on a 186. This decodes only the 0x70 block; the aliases are a
  ;; cpuLevel question the JS decoder answers and this one declines, which is
  ;; the difference between "not implemented" and "implemented for one CPU".
  (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x70))
               (i32.le_u (local.get $op) (i32.const 0x7F)))
    (then
      (local.set $d (call $dc_imm8))
      (local.set $fall (call $dc_wip (i32.add (global.get $dc_ip) (global.get $dc_n))))
      (local.set $target (call $dc_wip
        (i32.add (local.get $fall) (call $dc_sx8 (local.get $d)))))
      (call $dc_wh (i32.load (i32.add (i32.const ${tab('jcc')})
        (i32.shl (i32.and (local.get $op) (i32.const 15)) (i32.const 2)))))
      (call $dc_w (i32.const 0))
      (call $dc_fixup (i32.sub (global.get $dc_out) (i32.const 1)) (local.get $target))
      (call $dc_w (local.get $target))
      (call $dc_w (i32.const 0))
      (call $dc_fixup (i32.sub (global.get $dc_out) (i32.const 1)) (local.get $fall))
      (call $dc_w (local.get $fall))
      (global.set $dc_ends (i32.const 1))
      (return)))

  ;; Everything else: decline, and let the host's decoder have it.
  (global.set $dc_bad (i32.const 1)))

;; Is this byte a prefix this decoder consumes? FS/GS only exist from the 386
;; on, but this VM's decoder is only asked to decode a segment whose CPU level
;; the host has already selected, and the host declines to use the wasm decoder
;; below a 386 rather than encoding the level here twice.
(func $dc_isPrefix (param $b i32) (result i32)
  (i32.or
    (i32.or (i32.or (i32.eq (local.get $b) (i32.const 0x26))
                    (i32.eq (local.get $b) (i32.const 0x2E)))
            (i32.or (i32.eq (local.get $b) (i32.const 0x36))
                    (i32.eq (local.get $b) (i32.const 0x3E))))
    (i32.or
      (i32.or (i32.or (i32.eq (local.get $b) (i32.const 0x64))
                      (i32.eq (local.get $b) (i32.const 0x65)))
              (i32.or (i32.eq (local.get $b) (i32.const 0x66))
                      (i32.eq (local.get $b) (i32.const 0x67))))
      (i32.or (i32.or (i32.eq (local.get $b) (i32.const 0xF2))
                      (i32.eq (local.get $b) (i32.const 0xF3)))
              (i32.eq (local.get $b) (i32.const 0xF0))))))

(func $dc_takePrefix (param $b i32)
  ;; 0x66 flips the operand size and 0x67 the address size. In a 16-bit segment
  ;; that means "make it 32"; in a 32-bit one it means the opposite, which is
  ;; why both read $dc_d32 rather than assuming a direction.
  (if (i32.eq (local.get $b) (i32.const 0x66))
    (then (global.set $dc_opsize (select (i32.const 16) (i32.const 32) (global.get $dc_d32)))
          (return)))
  (if (i32.eq (local.get $b) (i32.const 0x67))
    (then (global.set $dc_asize (select (i32.const 16) (i32.const 32) (global.get $dc_d32)))
          (return)))
  (if (i32.eq (local.get $b) (i32.const 0xF3))
    (then (global.set $dc_rep (i32.const 1)) (return)))
  (if (i32.eq (local.get $b) (i32.const 0xF2))
    (then (global.set $dc_rep (i32.const 2)) (return)))
  ;; LOCK has no effect with one core.
  (if (i32.eq (local.get $b) (i32.const 0xF0)) (then (return)))
  ;; A segment override, by the order SEG is declared in isa.js.
  (if (i32.eq (local.get $b) (i32.const 0x26)) (then (global.set $dc_seg (i32.const 0)) (return)))
  (if (i32.eq (local.get $b) (i32.const 0x2E)) (then (global.set $dc_seg (i32.const 1)) (return)))
  (if (i32.eq (local.get $b) (i32.const 0x36)) (then (global.set $dc_seg (i32.const 2)) (return)))
  (if (i32.eq (local.get $b) (i32.const 0x3E)) (then (global.set $dc_seg (i32.const 3)) (return)))
  (if (i32.eq (local.get $b) (i32.const 0x64)) (then (global.set $dc_seg (i32.const 4)) (return)))
  (if (i32.eq (local.get $b) (i32.const 0x65)) (then (global.set $dc_seg (i32.const 5)) (return))))

;; --- one straight-line block ----------------------------------------------
;; Compiles from $ip until the block ends, the arena runs low, or an opcode
;; turns up that this decoder does not implement. Returns the number of words
;; written; the host reads $dc_stop_ip for where it got to and $dc_stopped for
;; why.
;;
;; STOPPING, not declining, and the difference is the whole reason this is
;; useful before it is complete. Declining a block whenever any instruction in
;; it is unimplemented sounds safe and is nearly useless: real code contains the
;; whole opcode range, so one unknown byte anywhere throws away the decode of
;; everything around it. Measured on the first version, which did exactly that:
;; 0.8% of random cases claimed. Stopping lets the host's decoder pick up at the
;; instruction that stopped it and carry on into the same arena, so coverage
;; buys time in proportion to itself.
;;
;; The worklist stays on the host. It already has one, it owns the block cache
;; that the answers go into, and a second copy here could disagree with it about
;; which blocks exist -- which is the kind of bug that shows up as a jump into
;; the middle of an instruction a thousand blocks later.
(func $dc_block (param $ip i32) (param $base i32) (param $mask i32)
                (param $d32 i32) (param $arena i32) (param $maxWords i32)
                (param $oneInsn i32) (result i32)
  (local $cur i32) (local $from i32)
  (global.set $dc_base (local.get $base))
  (global.set $dc_mask (local.get $mask))
  (global.set $dc_d32 (local.get $d32))
  (global.set $dc_arena (local.get $arena))
  (global.set $dc_max (local.get $maxWords))
  (global.set $dc_out (i32.const 0))
  (global.set $dc_bad (i32.const 0))
  (global.set $dc_nfix (i32.const 0))
  (global.set $dc_ncov (i32.const 0))
  (global.set $dc_stopped (i32.const 0))
  (global.set $dc_outAtInsn (i32.const 0))
  (global.set $dc_blockWrote (i32.const 0))
  (global.set $dc_blockBulk (i32.const 0))
  (local.set $cur (call $dc_wip (local.get $ip)))

  (block $done
    (loop $insn
      ;; Leave headroom rather than filling the arena exactly: a compile that
      ;; truncates mid-instruction is a block that resumes at a byte which is
      ;; not an instruction boundary.
      (if (i32.gt_u (i32.add (global.get $dc_out) (i32.const 16)) (global.get $dc_max))
        (then (global.set $dc_stopped (i32.const ${STOP.FULL})) (br $done)))
      (global.set $dc_ip (local.get $cur))
      (local.set $from (i32.and (i32.add (global.get $dc_base) (local.get $cur))
                                (global.get $dc_mask)))
      (call $dc_one)
      ;; An unimplemented opcode has emitted nothing this host can use, but it
      ;; may have emitted words before it noticed. The out cursor is rewound to
      ;; where the instruction started so the host's decoder writes over them.
      (if (global.get $dc_bad)
        (then (global.set $dc_out (global.get $dc_outAtInsn))
              (global.set $dc_stopped (i32.const ${STOP.UNIMPL}))
              (br $done)))
      (call $dc_cover (local.get $from) (i32.add (local.get $from) (global.get $dc_n)))
      (if (global.get $dc_wrote) (then (global.set $dc_blockWrote (i32.const 1))))
      (if (global.get $dc_bulk) (then (global.set $dc_blockBulk (i32.const 1))))
      (local.set $cur (call $dc_wip (i32.add (local.get $cur) (global.get $dc_n))))
      (if (global.get $dc_ends)
        (then (global.set $dc_stopped (i32.const ${STOP.ENDED})) (br $done)))
      (if (local.get $oneInsn)
        (then (global.set $dc_stopped (i32.const ${STOP.ONE})) (br $done)))
      (global.set $dc_outAtInsn (global.get $dc_out))
      (br $insn)))

  (global.set $dc_stop_ip (local.get $cur))
  (global.get $dc_out))

;; Readers, so the host can pull the side tables back without knowing the map.
(func (export "dc_fixups") (result i32) (global.get $dc_nfix))
(func (export "dc_covered") (result i32) (global.get $dc_ncov))
;; The decoded ModRM, exported so decode-diff can say WHICH part of an operand
;; disagreed rather than only that the emitted word did.
(func (export "dc_ea") (result i32) (global.get $dc_ea))
(func (export "dc_disp") (result i32) (global.get $dc_disp))
(func (export "dc_isreg") (result i32) (global.get $dc_isreg))
(func (export "dc_rm") (result i32) (global.get $dc_rm))
(func (export "dc_reg") (result i32) (global.get $dc_reg))
(func (export "dc_asize") (result i32) (global.get $dc_asize))
(func (export "dc_stopped") (result i32) (global.get $dc_stopped))
(func (export "dc_stop_ip") (result i32) (global.get $dc_stop_ip))
(func (export "dc_wrote") (result i32) (global.get $dc_blockWrote))
(func (export "dc_bulk") (result i32) (global.get $dc_blockBulk))
(func (export "compile_block")
      (param $ip i32) (param $base i32) (param $mask i32)
      (param $d32 i32) (param $arena i32) (param $maxWords i32)
      (param $oneInsn i32) (result i32)
  (call $dc_block (local.get $ip) (local.get $base) (local.get $mask)
                  (local.get $d32) (local.get $arena) (local.get $maxWords)
                  (local.get $oneInsn)))
`;
}

module.exports = { decoderWat, ALU_ROWS, MOV_ROW, CC_NAMES, SHAPES, WIDTHS, wIndex,
  decoderTables };
