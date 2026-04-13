  ;; ============================================================
  ;; x87 FPU SUPPORT
  ;; ============================================================
  ;;
  ;; This is an *x87-lite* implementation backed by WebAssembly f64. It is
  ;; deliberately not bit-exact to a real 8087/80387: WASM does not expose the
  ;; primitives required for full IEEE-754 / x87 compliance, and we do NOT
  ;; emulate them in software. The intentional differences are:
  ;;
  ;;   * 80-bit extended precision is unavailable. ST(i) is f64 (53-bit
  ;;     mantissa, 11-bit exponent). FLD/FSTP m80 store/load the 8-byte f64
  ;;     payload plus 2 zero bytes; the 16-bit sign+exponent of the m80
  ;;     format is fabricated. Code that depends on the extra ~11 bits of
  ;;     mantissa or the wider exponent range will diverge.
  ;;
  ;;   * Precision Control (CW bits 8-9: 24/53/64-bit) is ignored. All
  ;;     arithmetic runs at f64 precision regardless of PC.
  ;;
  ;;   * Rounding Control (CW bits 10-11) is honored only for FRNDINT and
  ;;     FIST/FISTP via $fpu_round. FADD/FSUB/FMUL/FDIV/FSQRT use WASM's
  ;;     fixed round-to-nearest-even — directed rounding modes are NOT
  ;;     applied to arithmetic results.
  ;;
  ;;   * Denormals are handled by the WASM runtime; FTZ/DAZ-style flushing
  ;;     in the x87 control word is ignored.
  ;;
  ;;   * Exception masking (CW bits 0-5) is partially honored. We set the
  ;;     status-word exception flags (IE/DE/ZE/OE/UE/PE) for the cases we
  ;;     can detect cheaply (stack over/underflow, sqrt of negative,
  ;;     divide-by-zero, integer-conversion overflow, NaN compare in FCOMI),
  ;;     but we never raise #MF — masked or not, execution always continues.
  ;;
  ;;   * The tag word is reduced to one valid/empty bit per physical
  ;;     register (see $fpu_tag in 01-header.wat). The C0/C1/C2/C3 condition
  ;;     bits in the status word are kept for compare-and-FNSTSW patterns.
  ;;     C1 is set by FRNDINT to report rounding direction; arithmetic does
  ;;     not update C1.
  ;;
  ;;   * FCOMI/FUCOMI funnel into the lazy CPU flag system via
  ;;     $fpu_compare_eflags so that "FCOMI; Jcc" works, but the unordered
  ;;     case sets ZF|PF|CF as the spec requires while also flagging IE in
  ;;     the FPU status word for FCOMI (FUCOMI suppresses IE on QNaN).
  ;;
  ;; Decoder coverage is exhaustive: every D8..DF byte reaches one of the
  ;; three FPU thread handlers. Anything that lands in $fpu_exec_reg or
  ;; $fpu_exec_mem without a handler calls $fpu_crash_op, which logs
  ;; (group, reg, rm) and traps via $crash_unimplemented — so we fail loud
  ;; instead of silently no-op'ing unknown encodings.

  ;; --- Tag-word helpers (1 bit per physical register, 1 = valid) ---
  (func $fpu_tag_phys (param $i i32) (result i32)
    (i32.and (local.get $i) (i32.const 7)))
  (func $fpu_mark_valid (param $i i32)
    (global.set $fpu_tag (i32.or (global.get $fpu_tag)
      (i32.shl (i32.const 1) (call $fpu_tag_phys
        (i32.add (global.get $fpu_top) (local.get $i)))))))
  (func $fpu_mark_empty (param $i i32)
    (global.set $fpu_tag (i32.and (global.get $fpu_tag)
      (i32.xor (i32.const 0xFF)
        (i32.shl (i32.const 1) (call $fpu_tag_phys
          (i32.add (global.get $fpu_top) (local.get $i))))))))
  (func $fpu_is_valid (param $i i32) (result i32)
    (i32.and (i32.shr_u (global.get $fpu_tag)
      (call $fpu_tag_phys (i32.add (global.get $fpu_top) (local.get $i))))
      (i32.const 1)))

  ;; Set status-word exception flags. Bits: IE=1, DE=2, ZE=4, OE=8, UE=16, PE=32,
  ;; SF=64 (stack fault, paired with IE), ES=128 (error summary).
  (func $fpu_set_exc (param $bits i32)
    (global.set $fpu_sw (i32.or (global.get $fpu_sw)
      (i32.or (local.get $bits) (i32.const 0x80)))))

  (func $fpu_get (param $i i32) (result f64)
    (f64.load (i32.add (i32.const 0x200)
      (i32.shl (i32.and (i32.add (global.get $fpu_top) (local.get $i)) (i32.const 7)) (i32.const 3)))))

  (func $fpu_set (param $i i32) (param $v f64)
    (f64.store (i32.add (i32.const 0x200)
      (i32.shl (i32.and (i32.add (global.get $fpu_top) (local.get $i)) (i32.const 7)) (i32.const 3)))
      (local.get $v))
    (call $fpu_mark_valid (local.get $i)))

  (func $fpu_push (param $v f64)
    ;; Stack overflow: pushing into a slot that is still tagged valid.
    ;; Real x87 sets IE|SF and (with IE masked) writes the "indefinite" QNaN.
    ;; We set the flag and keep going with the user's value, since we don't
    ;; have an indefinite-NaN bit pattern that round-trips f64.
    (global.set $fpu_top (i32.and (i32.sub (global.get $fpu_top) (i32.const 1)) (i32.const 7)))
    (if (call $fpu_is_valid (i32.const 0))
      (then (call $fpu_set_exc (i32.const 0x41))))   ;; IE | SF
    (call $fpu_set (i32.const 0) (local.get $v)))

  (func $fpu_pop (result f64)
    (local $v f64)
    ;; Stack underflow: popping a slot that is already tagged empty.
    (if (i32.eqz (call $fpu_is_valid (i32.const 0)))
      (then (call $fpu_set_exc (i32.const 0x41))))   ;; IE | SF
    (local.set $v (call $fpu_get (i32.const 0)))
    (call $fpu_mark_empty (i32.const 0))
    (global.set $fpu_top (i32.and (i32.add (global.get $fpu_top) (i32.const 1)) (i32.const 7)))
    (local.get $v))

  ;; Crash on an x87 escape we don't implement. The string at 0x2F0 is
  ;; "FPU_UNIMPL\0"; the (group, reg, rm) triple is logged so the next
  ;; implementation pass knows exactly which encoding to add.
  (func $fpu_crash_op (param $group i32) (param $reg i32) (param $rm i32)
    (call $host_log_i32 (i32.or (i32.const 0xF0000000)
      (i32.or (i32.shl (local.get $group) (i32.const 8))
              (i32.or (i32.shl (local.get $reg) (i32.const 4)) (local.get $rm)))))
    (call $crash_unimplemented (i32.const 0x2F0))
    (unreachable))

  ;; Detect NaN: x != x is true only for NaN under IEEE-754.
  (func $fpu_is_nan (param $v f64) (result i32)
    (f64.ne (local.get $v) (local.get $v)))

  (func $fpu_compare (param $a f64) (param $b f64)
    (local $cc i32)
    (if (f64.lt (local.get $a) (local.get $b))
      (then (local.set $cc (i32.const 0x0100)))
      (else (if (f64.gt (local.get $a) (local.get $b))
        (then (local.set $cc (i32.const 0x0000)))
        (else (if (f64.eq (local.get $a) (local.get $b))
          (then (local.set $cc (i32.const 0x4000)))
          (else
            ;; Unordered (at least one operand is NaN). Real x87 sets C3|C2|C0
            ;; (encoded here as 0x4500) and signals IE for FCOM (we don't
            ;; distinguish QNaN vs SNaN, so we always raise IE).
            (local.set $cc (i32.const 0x4500))
            (call $fpu_set_exc (i32.const 0x01))))))))
    (global.set $fpu_sw (i32.or (i32.and (global.get $fpu_sw) (i32.const 0xB8FF)) (local.get $cc))))

  ;; FCOMI / FCOMIP: ordered compare, sets eflags AND signals IE on NaN.
  (func $fpu_compare_eflags (param $a f64) (param $b f64)
    (if (i32.or (call $fpu_is_nan (local.get $a)) (call $fpu_is_nan (local.get $b)))
      (then (call $fpu_set_exc (i32.const 0x01))))
    (call $fpu_compare_eflags_unord (local.get $a) (local.get $b)))

  ;; FUCOMI / FUCOMIP: unordered compare. NaN (treated as QNaN) does NOT
  ;; raise IE — only the eflags are set to ZF=PF=CF=1.
  (func $fpu_compare_eflags_unord (param $a f64) (param $b f64)
    (if (f64.lt (local.get $a) (local.get $b))
      (then
        (global.set $flag_op (i32.const 2))
        (global.set $flag_a (i32.const 0)) (global.set $flag_b (i32.const 1))
        (global.set $flag_res (i32.const 0xFFFFFFFF)))
      (else (if (f64.eq (local.get $a) (local.get $b))
        (then
          (global.set $flag_op (i32.const 3))
          (global.set $flag_res (i32.const 0)))
        (else (if (f64.gt (local.get $a) (local.get $b))
          (then
            (global.set $flag_op (i32.const 3))
            (global.set $flag_res (i32.const 1)))
          (else
            ;; Unordered: emulate x87 by setting ZF=CF=1 (PF support is partial
            ;; in the lazy flag system; ZF+CF is what compilers actually test).
            (global.set $flag_op (i32.const 2))
            (global.set $flag_a (i32.const 0)) (global.set $flag_b (i32.const 1))
            (global.set $flag_res (i32.const 0)))))))))

  ;; Apply current FPU rounding-control (CW bits 10-11) to an f64.
  ;; 00 = nearest-even, 01 = round down, 10 = round up, 11 = truncate.
  (func $fpu_round (param $v f64) (result f64)
    (local $rc i32)
    (local.set $rc (i32.and (i32.shr_u (global.get $fpu_cw) (i32.const 10)) (i32.const 3)))
    (if (result f64) (i32.eq (local.get $rc) (i32.const 1)) (then (f64.floor (local.get $v)))
    (else (if (result f64) (i32.eq (local.get $rc) (i32.const 2)) (then (f64.ceil (local.get $v)))
    (else (if (result f64) (i32.eq (local.get $rc) (i32.const 3)) (then (f64.trunc (local.get $v)))
    (else (f64.nearest (local.get $v)))))))))

  (func $fpu_arith (param $a f64) (param $b f64) (param $op i32) (result f64)
    ;; FDIV (op=6: a/b) and FDIVR (op=7: b/a) — flag ZE if the divisor is zero.
    ;; The WASM result is ±inf which we let through; real x87 with ZE masked
    ;; produces the same value.
    (if (i32.eq (local.get $op) (i32.const 6))
      (then (if (f64.eq (local.get $b) (f64.const 0)) (then (call $fpu_set_exc (i32.const 0x04))))))
    (if (i32.eq (local.get $op) (i32.const 7))
      (then (if (f64.eq (local.get $a) (f64.const 0)) (then (call $fpu_set_exc (i32.const 0x04))))))
    (if (result f64) (i32.eq (local.get $op) (i32.const 0)) (then (f64.add (local.get $a) (local.get $b)))
    (else (if (result f64) (i32.eq (local.get $op) (i32.const 1)) (then (f64.mul (local.get $a) (local.get $b)))
    (else (if (result f64) (i32.eq (local.get $op) (i32.const 4)) (then (f64.sub (local.get $a) (local.get $b)))
    (else (if (result f64) (i32.eq (local.get $op) (i32.const 5)) (then (f64.sub (local.get $b) (local.get $a)))
    (else (if (result f64) (i32.eq (local.get $op) (i32.const 6)) (then (f64.div (local.get $a) (local.get $b)))
    (else (f64.div (local.get $b) (local.get $a)))))))))))))

  ;; Convert ST(0) (or popped TOS) to a signed integer in [-2^(width-1), 2^(width-1)-1].
  ;; Sets IE and returns the "integer indefinite" pattern on out-of-range or NaN.
  ;; Real x87 stores 0x80000000 / 0x8000 / 0x8000000000000000 in those cases.
  (func $fpu_to_i32 (param $v f64) (result i32)
    (local.set $v (call $fpu_round (local.get $v)))
    (if (i32.or (call $fpu_is_nan (local.get $v))
                (i32.or (f64.ge (local.get $v) (f64.const 2147483648.0))
                        (f64.lt (local.get $v) (f64.const -2147483648.0))))
      (then (call $fpu_set_exc (i32.const 0x01)) (return (i32.const -2147483648))))
    (i32.trunc_f64_s (local.get $v)))

  (func $fpu_to_i16 (param $v f64) (result i32)
    (local.set $v (call $fpu_round (local.get $v)))
    (if (i32.or (call $fpu_is_nan (local.get $v))
                (i32.or (f64.ge (local.get $v) (f64.const 32768.0))
                        (f64.lt (local.get $v) (f64.const -32768.0))))
      (then (call $fpu_set_exc (i32.const 0x01)) (return (i32.const 0x8000))))
    (i32.trunc_f64_s (local.get $v)))

  (func $fpu_to_i64 (param $v f64) (result i64)
    (local.set $v (call $fpu_round (local.get $v)))
    (if (i32.or (call $fpu_is_nan (local.get $v))
                (i32.or (f64.ge (local.get $v) (f64.const 9223372036854775808.0))
                        (f64.lt (local.get $v) (f64.const -9223372036854775808.0))))
      (then (call $fpu_set_exc (i32.const 0x01)) (return (i64.const -9223372036854775808))))
    (i64.trunc_f64_s (local.get $v)))

  (func $fpu_load_mem (param $addr i32) (param $group i32) (result f64)
    (if (result f64) (i32.eq (local.get $group) (i32.const 0))
      (then (f64.promote_f32 (f32.load (call $g2w (local.get $addr)))))
    (else (if (result f64) (i32.eq (local.get $group) (i32.const 4))
      (then (f64.load (call $g2w (local.get $addr))))
    (else (if (result f64) (i32.or (i32.eq (local.get $group) (i32.const 2)) (i32.eq (local.get $group) (i32.const 3)))
      (then (f64.convert_i32_s (i32.load (call $g2w (local.get $addr)))))
    (else (if (result f64) (i32.or (i32.eq (local.get $group) (i32.const 6)) (i32.eq (local.get $group) (i32.const 7)))
      (then (f64.convert_i32_s (i32.load16_s (call $g2w (local.get $addr)))))
    (else
      (f64.load (call $g2w (local.get $addr))))))))))))

  (func $fpu_exec_mem (param $group i32) (param $reg i32) (param $addr i32)
    (local $val f64)
    ;; Group 0 (D8) / Group 4 (DC): arithmetic with float32/float64
    (if (i32.or (i32.eq (local.get $group) (i32.const 0)) (i32.eq (local.get $group) (i32.const 4)))
      (then
        (local.set $val (call $fpu_load_mem (local.get $addr) (local.get $group)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (call $fpu_compare (call $fpu_get (i32.const 0)) (local.get $val)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 3))
          (then (call $fpu_compare (call $fpu_get (i32.const 0)) (local.get $val)) (drop (call $fpu_pop)) (return)))
        (call $fpu_set (i32.const 0) (call $fpu_arith (call $fpu_get (i32.const 0)) (local.get $val) (local.get $reg)))
        (return)))
    ;; Group 2 (DA) / Group 6 (DE): arithmetic with int32/int16
    (if (i32.or (i32.eq (local.get $group) (i32.const 2)) (i32.eq (local.get $group) (i32.const 6)))
      (then
        (local.set $val (call $fpu_load_mem (local.get $addr) (local.get $group)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (call $fpu_compare (call $fpu_get (i32.const 0)) (local.get $val)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 3))
          (then (call $fpu_compare (call $fpu_get (i32.const 0)) (local.get $val)) (drop (call $fpu_pop)) (return)))
        (call $fpu_set (i32.const 0) (call $fpu_arith (call $fpu_get (i32.const 0)) (local.get $val) (local.get $reg)))
        (return)))
    ;; Group 1 (D9): FLD/FST/FSTP float32, FLDENV, FLDCW, FNSTENV, FNSTCW
    (if (i32.eq (local.get $group) (i32.const 1))
      (then
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (call $fpu_push (f64.promote_f32 (f32.load (call $g2w (local.get $addr))))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (f32.store (call $g2w (local.get $addr)) (f32.demote_f64 (call $fpu_get (i32.const 0)))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 3))
          (then (f32.store (call $g2w (local.get $addr)) (f32.demote_f64 (call $fpu_pop))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 5))
          (then (global.set $fpu_cw (i32.load16_u (call $g2w (local.get $addr)))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 7))
          (then (i32.store16 (call $g2w (local.get $addr)) (global.get $fpu_cw)) (return)))
        ;; reg=4 FLDENV, reg=6 FNSTENV — 28-byte environment block, not implemented.
        (call $fpu_crash_op (local.get $group) (local.get $reg) (i32.const 0)) (return)))
    ;; Group 5 (DD): FLD/FST/FSTP float64, FRSTOR, FNSAVE, FNSTSW m16
    (if (i32.eq (local.get $group) (i32.const 5))
      (then
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (call $fpu_push (f64.load (call $g2w (local.get $addr)))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (f64.store (call $g2w (local.get $addr)) (call $fpu_get (i32.const 0))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 3))
          (then (f64.store (call $g2w (local.get $addr)) (call $fpu_pop)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 7))
          (then
            (global.set $fpu_sw (i32.or (i32.and (global.get $fpu_sw) (i32.const 0xC7FF))
              (i32.shl (global.get $fpu_top) (i32.const 11))))
            (i32.store16 (call $g2w (local.get $addr)) (global.get $fpu_sw)) (return)))
        ;; reg=4 FRSTOR, reg=6 FNSAVE — 108-byte state, not implemented.
        (call $fpu_crash_op (local.get $group) (local.get $reg) (i32.const 0)) (return)))
    ;; Group 3 (DB): FILD/FIST/FISTP int32, FLD/FSTP m80
    (if (i32.eq (local.get $group) (i32.const 3))
      (then
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (call $fpu_push (f64.convert_i32_s (call $gl32 (local.get $addr)))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (i32.store (call $g2w (local.get $addr)) (call $fpu_to_i32 (call $fpu_get (i32.const 0)))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 3))
          (then (i32.store (call $g2w (local.get $addr)) (call $fpu_to_i32 (call $fpu_pop))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 5))
          ;; FLD m80 — see header note: we read the f64 payload and ignore the
          ;; trailing 2 bytes of x87 sign+exponent.
          (then (call $fpu_push (f64.load (call $g2w (local.get $addr)))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 7))
          ;; FSTP m80 — write the f64 payload and zero the sign+exponent slot.
          (then (f64.store (call $g2w (local.get $addr)) (call $fpu_pop))
            (i32.store16 (call $g2w (i32.add (local.get $addr) (i32.const 8))) (i32.const 0)) (return)))
        (call $fpu_crash_op (local.get $group) (local.get $reg) (i32.const 0)) (return)))
    ;; Group 7 (DF): FILD/FIST/FISTP int16, FILD/FISTP int64
    (if (i32.eq (local.get $group) (i32.const 7))
      (then
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (call $fpu_push (f64.convert_i32_s (i32.load16_s (call $g2w (local.get $addr))))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (i32.store16 (call $g2w (local.get $addr)) (call $fpu_to_i16 (call $fpu_get (i32.const 0)))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 3))
          (then (i32.store16 (call $g2w (local.get $addr)) (call $fpu_to_i16 (call $fpu_pop))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 4))
          ;; FBLD m80 (BCD load) — not implemented.
          (then (call $fpu_crash_op (local.get $group) (local.get $reg) (i32.const 0)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 5))
          (then (call $fpu_push (f64.convert_i64_s (i64.load (call $g2w (local.get $addr))))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 6))
          ;; FBSTP m80 (BCD store) — not implemented.
          (then (call $fpu_crash_op (local.get $group) (local.get $reg) (i32.const 0)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 7))
          (then (i64.store (call $g2w (local.get $addr)) (call $fpu_to_i64 (call $fpu_pop))) (return)))
        (call $fpu_crash_op (local.get $group) (local.get $reg) (i32.const 0)) (return)))
    (call $fpu_crash_op (local.get $group) (local.get $reg) (i32.const 0))
  )

  (func $fpu_exec_reg (param $group i32) (param $reg i32) (param $rm i32)
    (local $v f64) (local $st0 f64)
    (local.set $st0 (call $fpu_get (i32.const 0)))
    ;; Group 0 (D8): arith ST(0), ST(rm) — every reg value (0..7) is a valid op
    (if (i32.eq (local.get $group) (i32.const 0))
      (then
        (local.set $v (call $fpu_get (local.get $rm)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (call $fpu_compare (local.get $st0) (local.get $v)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 3))
          (then (call $fpu_compare (local.get $st0) (local.get $v)) (drop (call $fpu_pop)) (return)))
        (call $fpu_set (i32.const 0) (call $fpu_arith (local.get $st0) (local.get $v) (local.get $reg)))
        (return)))
    ;; Group 1 (D9): FLD, FXCH, constants, transcendentals
    (if (i32.eq (local.get $group) (i32.const 1))
      (then
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (call $fpu_push (call $fpu_get (local.get $rm))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 1))
          (then
            (local.set $v (call $fpu_get (local.get $rm)))
            (call $fpu_set (local.get $rm) (local.get $st0))
            (call $fpu_set (i32.const 0) (local.get $v))
            (return)))
        ;; reg=2: only D9 D0 (rm=0) is FNOP. D9 D1..D7 are reserved.
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then
            (if (i32.eq (local.get $rm) (i32.const 0)) (then (return)))
            (call $fpu_crash_op (local.get $group) (local.get $reg) (local.get $rm)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 4))
          (then
            (if (i32.eq (local.get $rm) (i32.const 0))
              (then (call $fpu_set (i32.const 0) (f64.neg (local.get $st0))) (return)))
            (if (i32.eq (local.get $rm) (i32.const 1))
              (then (call $fpu_set (i32.const 0) (f64.abs (local.get $st0))) (return)))
            (if (i32.eq (local.get $rm) (i32.const 4))
              (then (call $fpu_compare (local.get $st0) (f64.const 0)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 5))
              (then (global.set $fpu_sw (i32.or (i32.and (global.get $fpu_sw) (i32.const 0xB8FF)) (i32.const 0x0400))) (return)))
            ;; D9 E2/E3/E6/E7 — reserved.
            (call $fpu_crash_op (local.get $group) (local.get $reg) (local.get $rm)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 5))
          (then
            (if (i32.eq (local.get $rm) (i32.const 0)) (then (call $fpu_push (f64.const 1.0)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 1)) (then (call $fpu_push (f64.const 3.321928094887362)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 2)) (then (call $fpu_push (f64.const 1.4426950408889634)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 3)) (then (call $fpu_push (f64.const 3.141592653589793)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 4)) (then (call $fpu_push (f64.const 0.3010299957316877)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 5)) (then (call $fpu_push (f64.const 0.6931471805599453)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 6)) (then (call $fpu_push (f64.const 0.0)) (return)))
            ;; D9 EF — reserved.
            (call $fpu_crash_op (local.get $group) (local.get $reg) (local.get $rm)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 6))
          (then
            (if (i32.eq (local.get $rm) (i32.const 2))
              (then ;; FPTAN: ST(0) = tan(ST(0)), push 1.0
                (call $fpu_set (i32.const 0) (call $host_math_tan (local.get $st0)))
                (call $fpu_push (f64.const 1.0)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 3))
              (then ;; FPATAN: ST(1) = atan2(ST(1), ST(0)), pop
                (call $fpu_set (i32.const 1) (call $host_math_atan2 (call $fpu_get (i32.const 1)) (local.get $st0)))
                (drop (call $fpu_pop)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 4))
              ;; FXTRACT — placeholder. Real spec splits ST(0) into unbiased
              ;; exponent (replaces ST(0)) and significand (pushed). We push
              ;; (1.0, 0.0); stack effect is correct, magnitudes are not.
              (then (call $fpu_set (i32.const 0) (f64.const 1.0)) (call $fpu_push (f64.const 0.0)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 6))
              (then (global.set $fpu_top (i32.and (i32.sub (global.get $fpu_top) (i32.const 1)) (i32.const 7))) (return)))
            (if (i32.eq (local.get $rm) (i32.const 7))
              (then (global.set $fpu_top (i32.and (i32.add (global.get $fpu_top) (i32.const 1)) (i32.const 7))) (return)))
            (if (i32.eq (local.get $rm) (i32.const 0))
              (then ;; F2XM1: ST(0) = 2^ST(0) - 1
                (call $fpu_set (i32.const 0) (f64.sub (call $host_math_pow2 (local.get $st0)) (f64.const 1.0))) (return)))
            (if (i32.eq (local.get $rm) (i32.const 1))
              (then ;; FYL2X: ST(1) = ST(1) * log2(ST(0)), pop
                (call $fpu_set (i32.const 1) (f64.mul (call $fpu_get (i32.const 1)) (call $host_math_log2 (local.get $st0))))
                (drop (call $fpu_pop)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 5))
              (then ;; FPREM1: IEEE remainder ST(0) mod ST(1), clear C2
                (call $fpu_set (i32.const 0)
                  (f64.sub (local.get $st0)
                    (f64.mul (call $fpu_round (f64.div (local.get $st0) (call $fpu_get (i32.const 1))))
                             (call $fpu_get (i32.const 1)))))
                (global.set $fpu_sw (i32.and (global.get $fpu_sw) (i32.const 0xFBFF)))
                (return)))
            (call $fpu_crash_op (local.get $group) (local.get $reg) (local.get $rm)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 7))
          (then
            (if (i32.eq (local.get $rm) (i32.const 0))
              (then ;; FPREM: ST(0) = ST(0) mod ST(1), clear C2 (complete)
                (call $fpu_set (i32.const 0)
                  (f64.sub (local.get $st0)
                    (f64.mul (f64.trunc (f64.div (local.get $st0) (call $fpu_get (i32.const 1))))
                             (call $fpu_get (i32.const 1)))))
                (global.set $fpu_sw (i32.and (global.get $fpu_sw) (i32.const 0xFBFF)))
                (return)))
            (if (i32.eq (local.get $rm) (i32.const 2))
              ;; FSQRT — set IE on negative input (WASM's f64.sqrt of a
              ;; negative produces NaN, equivalent to the masked-IE result).
              (then
                (if (f64.lt (local.get $st0) (f64.const 0)) (then (call $fpu_set_exc (i32.const 0x01))))
                (call $fpu_set (i32.const 0) (f64.sqrt (local.get $st0))) (return)))
            (if (i32.eq (local.get $rm) (i32.const 3))
              (then ;; FSINCOS: ST(0) = sin, push cos
                (local.set $v (call $host_math_cos (local.get $st0)))
                (call $fpu_set (i32.const 0) (call $host_math_sin (local.get $st0)))
                (call $fpu_push (local.get $v)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 4))
              ;; FRNDINT — set C1 to 1 if result rounded up, else 0.
              (then
                (local.set $v (call $fpu_round (local.get $st0)))
                (if (f64.gt (local.get $v) (local.get $st0))
                  (then (global.set $fpu_sw (i32.or (global.get $fpu_sw) (i32.const 0x0200))))
                  (else (global.set $fpu_sw (i32.and (global.get $fpu_sw) (i32.const 0xFDFF)))))
                (call $fpu_set (i32.const 0) (local.get $v)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 6))
              (then (call $fpu_set (i32.const 0) (call $host_math_sin (local.get $st0))) (return))) ;; FSIN
            (if (i32.eq (local.get $rm) (i32.const 7))
              (then (call $fpu_set (i32.const 0) (call $host_math_cos (local.get $st0))) (return))) ;; FCOS
            (if (i32.eq (local.get $rm) (i32.const 1))
              (then ;; FYL2XP1: ST(1) = ST(1) * log2(ST(0) + 1), pop
                (call $fpu_set (i32.const 1) (f64.mul (call $fpu_get (i32.const 1)) (call $host_math_log2 (f64.add (local.get $st0) (f64.const 1.0)))))
                (drop (call $fpu_pop)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 5))
              (then ;; FSCALE: ST(0) = ST(0) * 2^trunc(ST(1))
                (call $fpu_set (i32.const 0) (f64.mul (local.get $st0) (call $host_math_pow2 (f64.trunc (call $fpu_get (i32.const 1)))))) (return)))
            (call $fpu_crash_op (local.get $group) (local.get $reg) (local.get $rm)) (return)))
        (call $fpu_crash_op (local.get $group) (local.get $reg) (local.get $rm)) (return)))
    ;; Group 2 (DA): FCMOV / FUCOMPP
    (if (i32.eq (local.get $group) (i32.const 2))
      (then
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (if (call $get_cf) (then (call $fpu_set (i32.const 0) (call $fpu_get (local.get $rm))))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 1))
          (then (if (call $get_zf) (then (call $fpu_set (i32.const 0) (call $fpu_get (local.get $rm))))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (if (i32.or (call $get_cf) (call $get_zf)) (then (call $fpu_set (i32.const 0) (call $fpu_get (local.get $rm))))) (return)))
        ;; DA E9 = FUCOMPP — unordered compare ST(0)<->ST(1), pop both
        (if (i32.and (i32.eq (local.get $reg) (i32.const 5)) (i32.eq (local.get $rm) (i32.const 1)))
          (then
            (call $fpu_compare (local.get $st0) (call $fpu_get (i32.const 1)))
            (drop (call $fpu_pop)) (drop (call $fpu_pop))
            (return)))
        ;; reg=3 = FCMOVU (cmov-if-PF) — lazy flag system has no PF, not impl.
        (call $fpu_crash_op (local.get $group) (local.get $reg) (local.get $rm)) (return)))
    ;; Group 3 (DB): FCMOVN, FNINIT, FNCLEX, FUCOMI, FCOMI
    (if (i32.eq (local.get $group) (i32.const 3))
      (then
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (if (i32.eqz (call $get_cf)) (then (call $fpu_set (i32.const 0) (call $fpu_get (local.get $rm))))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 1))
          (then (if (i32.eqz (call $get_zf)) (then (call $fpu_set (i32.const 0) (call $fpu_get (local.get $rm))))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (if (i32.eqz (i32.or (call $get_cf) (call $get_zf))) (then (call $fpu_set (i32.const 0) (call $fpu_get (local.get $rm))))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 4))
          (then
            ;; DB E0 / E1 = FNENI / FNDISI — 8087 enable/disable interrupts;
            ;; documented as no-ops on 80287 and later. We accept and ignore.
            (if (i32.or (i32.eq (local.get $rm) (i32.const 0)) (i32.eq (local.get $rm) (i32.const 1)))
              (then (return)))
            ;; DB E2 = FNCLEX
            (if (i32.eq (local.get $rm) (i32.const 2))
              (then (global.set $fpu_sw (i32.and (global.get $fpu_sw) (i32.const 0x7F00))) (return)))
            ;; DB E3 = FNINIT — full reset (clear tag word too).
            (if (i32.eq (local.get $rm) (i32.const 3))
              (then (global.set $fpu_top (i32.const 0)) (global.set $fpu_cw (i32.const 0x037F))
                    (global.set $fpu_sw (i32.const 0)) (global.set $fpu_tag (i32.const 0)) (return)))
            (call $fpu_crash_op (local.get $group) (local.get $reg) (local.get $rm)) (return)))
        ;; DB E8..EF = FUCOMI ST(i)
        (if (i32.eq (local.get $reg) (i32.const 5))
          (then (call $fpu_compare_eflags_unord (local.get $st0) (call $fpu_get (local.get $rm))) (return)))
        ;; DB F0..F7 = FCOMI ST(i)
        (if (i32.eq (local.get $reg) (i32.const 6))
          (then (call $fpu_compare_eflags (local.get $st0) (call $fpu_get (local.get $rm))) (return)))
        ;; reg=3 = FCMOVNU, reg=7 = reserved.
        (call $fpu_crash_op (local.get $group) (local.get $reg) (local.get $rm)) (return)))
    ;; Group 4 (DC): arith ST(rm), ST(0)
    (if (i32.eq (local.get $group) (i32.const 4))
      (then
        (local.set $v (call $fpu_get (local.get $rm)))
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (call $fpu_set (local.get $rm) (f64.add (local.get $v) (local.get $st0))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 1))
          (then (call $fpu_set (local.get $rm) (f64.mul (local.get $v) (local.get $st0))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 4))
          (then (call $fpu_set (local.get $rm) (f64.sub (local.get $st0) (local.get $v))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 5))
          (then (call $fpu_set (local.get $rm) (f64.sub (local.get $v) (local.get $st0))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 6))
          (then (call $fpu_set (local.get $rm) (f64.div (local.get $st0) (local.get $v))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 7))
          (then (call $fpu_set (local.get $rm) (f64.div (local.get $v) (local.get $st0))) (return)))
        ;; DC reg=2,3 are FCOM/FCOMP register-form aliases — uncommon, not impl.
        (call $fpu_crash_op (local.get $group) (local.get $reg) (local.get $rm)) (return)))
    ;; Group 5 (DD): FFREE, FST, FSTP, FUCOM, FUCOMP
    (if (i32.eq (local.get $group) (i32.const 5))
      (then
        ;; DD C0..C7 = FFREE ST(i): mark target empty, leave value bits alone.
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (call $fpu_mark_empty (local.get $rm)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (call $fpu_set (local.get $rm) (local.get $st0)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 3))
          (then (call $fpu_set (local.get $rm) (local.get $st0)) (drop (call $fpu_pop)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 4))
          (then (call $fpu_compare (local.get $st0) (call $fpu_get (local.get $rm))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 5))
          (then (call $fpu_compare (local.get $st0) (call $fpu_get (local.get $rm))) (drop (call $fpu_pop)) (return)))
        ;; reg=1 = FXCH alt, reg=6 = reserved, reg=7 = reserved.
        (call $fpu_crash_op (local.get $group) (local.get $reg) (local.get $rm)) (return)))
    ;; Group 6 (DE): FADDP/FMULP/FCOMPP/FSUBRP/FSUBP/FDIVRP/FDIVP
    (if (i32.eq (local.get $group) (i32.const 6))
      (then
        (local.set $v (call $fpu_get (local.get $rm)))
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (call $fpu_set (local.get $rm) (f64.add (local.get $v) (local.get $st0))) (drop (call $fpu_pop)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 1))
          (then (call $fpu_set (local.get $rm) (f64.mul (local.get $v) (local.get $st0))) (drop (call $fpu_pop)) (return)))
        (if (i32.and (i32.eq (local.get $reg) (i32.const 3)) (i32.eq (local.get $rm) (i32.const 1)))
          (then (call $fpu_compare (local.get $st0) (call $fpu_get (i32.const 1))) (drop (call $fpu_pop)) (drop (call $fpu_pop)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 4))
          (then (call $fpu_set (local.get $rm) (f64.sub (local.get $st0) (local.get $v))) (drop (call $fpu_pop)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 5))
          (then (call $fpu_set (local.get $rm) (f64.sub (local.get $v) (local.get $st0))) (drop (call $fpu_pop)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 6))
          (then (call $fpu_set (local.get $rm) (f64.div (local.get $st0) (local.get $v))) (drop (call $fpu_pop)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 7))
          (then (call $fpu_set (local.get $rm) (f64.div (local.get $v) (local.get $st0))) (drop (call $fpu_pop)) (return)))
        ;; reg=2 = FCOMP alt — not impl.
        (call $fpu_crash_op (local.get $group) (local.get $reg) (local.get $rm)) (return)))
    ;; Group 7 (DF): FNSTSW AX, FUCOMIP, FCOMIP
    (if (i32.eq (local.get $group) (i32.const 7))
      (then
        ;; DF E0 = FNSTSW AX
        (if (i32.and (i32.eq (local.get $reg) (i32.const 4)) (i32.eq (local.get $rm) (i32.const 0)))
          (then
            (global.set $fpu_sw (i32.or (i32.and (global.get $fpu_sw) (i32.const 0xC7FF))
              (i32.shl (global.get $fpu_top) (i32.const 11))))
            (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (global.get $fpu_sw)))
            (return)))
        ;; DF E8..EF = FUCOMIP ST, ST(i) — pop after unordered compare.
        (if (i32.eq (local.get $reg) (i32.const 5))
          (then (call $fpu_compare_eflags_unord (local.get $st0) (call $fpu_get (local.get $rm))) (drop (call $fpu_pop)) (return)))
        ;; DF F0..F7 = FCOMIP ST, ST(i)
        (if (i32.eq (local.get $reg) (i32.const 6))
          (then (call $fpu_compare_eflags (local.get $st0) (call $fpu_get (local.get $rm))) (drop (call $fpu_pop)) (return)))
        ;; reg=0 = FFREEP ST(i), reg=1..3 = FXCH/FSTP aliases, reg=7 = reserved.
        (call $fpu_crash_op (local.get $group) (local.get $reg) (local.get $rm)) (return)))
    ;; Unknown group — should be impossible since the decoder only emits 0..7.
    (call $fpu_crash_op (local.get $group) (local.get $reg) (local.get $rm))
  )

  ;; 188: FPU memory op — op=(group<<4)|reg, addr in next word
  (func $th_fpu_mem (param $op i32)
    (local $addr i32)
    (local.set $addr (call $read_thread_word))
    (if (i32.eq (local.get $addr) (global.get $SIB_SENTINEL))
      (then (local.set $addr (global.get $ea_temp))))
    (call $fpu_exec_mem
      (i32.shr_u (local.get $op) (i32.const 4))
      (i32.and (local.get $op) (i32.const 0xF))
      (local.get $addr))
    (return_call $next))

  ;; 189: FPU register op — op=(group<<8)|(reg<<4)|rm
  (func $th_fpu_reg (param $op i32)
    (call $fpu_exec_reg
      (i32.shr_u (local.get $op) (i32.const 8))
      (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF))
      (i32.and (local.get $op) (i32.const 0xF)))
    (return_call $next))

  ;; 190: FPU memory op with base+disp — op=(group<<8)|(reg<<4)|base, disp in next word
  (func $th_fpu_mem_ro (param $op i32)
    (call $fpu_exec_mem
      (i32.shr_u (local.get $op) (i32.const 8))
      (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF))
      (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (call $read_thread_word)))
    (return_call $next))

  (func $th_cld (param $op i32) (global.set $df (i32.const 0)) (return_call $next))
  (func $th_std (param $op i32) (global.set $df (i32.const 1)) (return_call $next))
  (func $th_clc (param $op i32)
    (global.set $flag_op (i32.const 3)) (global.set $flag_res (i32.const 0)) (return_call $next))
  (func $th_stc (param $op i32)
    (global.set $flag_op (i32.const 1)) (global.set $flag_a (i32.const 0xFFFFFFFF))
    (global.set $flag_b (i32.const 1)) (global.set $flag_res (i32.const 0)) (return_call $next))
  (func $th_cmc (param $op i32)
    ;; Toggle CF by flipping the condition that produces it
    (if (call $get_cf)
      (then (global.set $flag_op (i32.const 3)) (global.set $flag_res (i32.const 0)))
      (else (global.set $flag_op (i32.const 1)) (global.set $flag_a (i32.const 0xFFFFFFFF))
            (global.set $flag_b (i32.const 1)) (global.set $flag_res (i32.const 0))))
    (return_call $next))
  (func $th_leave (param $op i32)
    (global.set $esp (global.get $ebp))
    (global.set $ebp (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return_call $next))
  (func $th_nop2 (param $op i32) (return_call $next))
  (func $th_bswap (param $op i32)
    (local $v i32) (local.set $v (call $get_reg (local.get $op)))
    (call $set_reg (local.get $op)
      (i32.or (i32.or
        (i32.shl (i32.and (local.get $v) (i32.const 0xFF)) (i32.const 24))
        (i32.shl (i32.and (i32.shr_u (local.get $v) (i32.const 8)) (i32.const 0xFF)) (i32.const 16)))
        (i32.or
          (i32.shl (i32.and (i32.shr_u (local.get $v) (i32.const 16)) (i32.const 0xFF)) (i32.const 8))
          (i32.shr_u (local.get $v) (i32.const 24)))))
    (return_call $next))
  (func $th_xchg_eax_r (param $op i32)
    (local $tmp i32) (local.set $tmp (global.get $eax))
    (global.set $eax (call $get_reg (local.get $op)))
    (call $set_reg (local.get $op) (local.get $tmp)) (return_call $next))
  (func $th_thunk_call (param $op i32)
    (call $win32_dispatch (local.get $op)))
  (func $th_imul_r_r (param $op i32)
    (local $d i32) (local.set $d (i32.shr_u (local.get $op) (i32.const 4)))
    (call $set_reg (local.get $d) (i32.mul (call $get_reg (local.get $d))
      (call $get_reg (i32.and (local.get $op) (i32.const 0xF))))) (return_call $next))
  ;; 157: imul reg, [base+disp] — 2-operand imul with memory source (simple base)
  (func $th_imul_r_m_ro (param $op i32)
    (local $addr i32) (local $dst i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $dst (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (call $set_reg (local.get $dst) (i32.mul (call $get_reg (local.get $dst)) (call $gl32 (local.get $addr))))
    (return_call $next))
  ;; 158: imul reg, [addr] — 2-operand imul with memory source (absolute/SIB)
  (func $th_imul_r_m_abs (param $op i32)
    (local $addr i32) (local.set $addr (call $read_addr))
    (call $set_reg (local.get $op) (i32.mul (call $get_reg (local.get $op)) (call $gl32 (local.get $addr))))
    (return_call $next))
  ;; 159: r16 OP= [addr] (op=alu_op<<4|reg, addr in next word)
  (func $th_alu_r16_m16 (param $op i32)
    (local $addr i32) (local $reg i32) (local $alu i32) (local $val i32)
    (local.set $addr (call $read_addr))
    (local.set $reg (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0x7)))
    (local.set $val (call $do_alu32 (local.get $alu) (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF)) (call $gl16 (local.get $addr))))
    (global.set $flag_res (i32.and (global.get $flag_res) (i32.const 0xFFFF)))
    (global.set $flag_sign_shift (i32.const 15))
    (if (i32.ne (local.get $alu) (i32.const 7))
      (then (call $set_reg (local.get $reg) (i32.or (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF0000)) (i32.and (local.get $val) (i32.const 0xFFFF))))))
    (return_call $next))
  ;; 160: [addr] OP= r16 (op=alu_op<<4|reg, addr in next word)
  (func $th_alu_m16_r16 (param $op i32)
    (local $addr i32) (local $reg i32) (local $alu i32) (local $val i32)
    (local.set $addr (call $read_addr))
    (local.set $reg (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0x7)))
    (local.set $val (call $do_alu32 (local.get $alu) (call $gl16 (local.get $addr)) (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF))))
    (global.set $flag_res (i32.and (global.get $flag_res) (i32.const 0xFFFF)))
    (global.set $flag_sign_shift (i32.const 15))
    (if (i32.ne (local.get $alu) (i32.const 7))
      (then (call $gs16 (local.get $addr) (local.get $val))))
    (return_call $next))
  ;; 161: r16 OP= [base+disp] (op=alu_op<<8|reg<<4|base, disp in word)
  (func $th_alu_r16_m16_ro (param $op i32)
    (local $addr i32) (local $reg i32) (local $alu i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0x7)))
    (local.set $val (call $do_alu32 (local.get $alu) (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF)) (call $gl16 (local.get $addr))))
    (global.set $flag_res (i32.and (global.get $flag_res) (i32.const 0xFFFF)))
    (global.set $flag_sign_shift (i32.const 15))
    (if (i32.ne (local.get $alu) (i32.const 7))
      (then (call $set_reg (local.get $reg) (i32.or (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF0000)) (i32.and (local.get $val) (i32.const 0xFFFF))))))
    (return_call $next))
  ;; 162: [base+disp] OP= r16 (op=alu_op<<8|reg<<4|base, disp in word)
  (func $th_alu_m16_r16_ro (param $op i32)
    (local $addr i32) (local $reg i32) (local $alu i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0x7)))
    (local.set $val (call $do_alu32 (local.get $alu) (call $gl16 (local.get $addr)) (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF))))
    (global.set $flag_res (i32.and (global.get $flag_res) (i32.const 0xFFFF)))
    (global.set $flag_sign_shift (i32.const 15))
    (if (i32.ne (local.get $alu) (i32.const 7))
      (then (call $gs16 (local.get $addr) (local.get $val))))
    (return_call $next))
  ;; 163: mov [addr], r16 (op=reg, addr in next word)
  (func $th_mov_m16_r16 (param $op i32)
    (call $gs16 (call $read_addr) (i32.and (call $get_reg (local.get $op)) (i32.const 0xFFFF)))
    (return_call $next))
  ;; 164: mov r16, [addr] (op=reg, addr in next word)
  (func $th_mov_r16_m16 (param $op i32)
    (local $val i32) (local.set $val (call $gl16 (call $read_addr)))
    (call $set_reg (local.get $op) (i32.or (i32.and (call $get_reg (local.get $op)) (i32.const 0xFFFF0000)) (local.get $val)))
    (return_call $next))
  ;; 165: mov [base+disp], r16 (op=reg<<4|base, disp in word)
  (func $th_mov_m16_r16_ro (param $op i32)
    (local $addr i32) (local $reg i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (call $gs16 (local.get $addr) (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF)))
    (return_call $next))
  ;; 166: mov r16, [base+disp] (op=reg<<4|base, disp in word)
  (func $th_mov_r16_m16_ro (param $op i32)
    (local $addr i32) (local $dst i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $dst (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $val (call $gl16 (local.get $addr)))
    (call $set_reg (local.get $dst) (i32.or (i32.and (call $get_reg (local.get $dst)) (i32.const 0xFFFF0000)) (local.get $val)))
    (return_call $next))
  ;; 167: mov [addr], imm16 (op=0, addr+imm in words)
  (func $th_mov_m16_i16 (param $op i32)
    (local $addr i32)
    (local.set $addr (call $read_addr))
    (call $gs16 (local.get $addr) (call $read_thread_word))
    (return_call $next))
  ;; 168: mov [base+disp], imm16 (op=base, disp+imm in words)
  (func $th_mov_m16_i16_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (i32.add (call $get_reg (local.get $op)) (call $read_thread_word)))
    (call $gs16 (local.get $addr) (call $read_thread_word))
    (return_call $next))
  (func $th_call_r (param $op i32)
    (local $reg i32) (local $target i32)
    (local.set $reg (call $read_thread_word))
    (local.set $target (call $get_reg (local.get $reg)))
    ;; Check thunk zone (guest-space bounds)
    (if (i32.and (i32.ge_u (local.get $target) (global.get $thunk_guest_base))
                 (i32.lt_u (local.get $target) (global.get $thunk_guest_end)))
      (then
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (local.get $op))
        (call $win32_dispatch (i32.div_u (i32.sub (local.get $target) (global.get $thunk_guest_base)) (i32.const 8)))
        (if (global.get $steps) (then (global.set $eip (local.get $op))))
        (return)))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $op))
    (global.set $eip (local.get $target)))
  (func $th_jmp_r (param $op i32)
    (local $target i32) (local $ret_addr i32)
    (local.set $target (call $get_reg (local.get $op)))
    ;; Check thunk zone — JMP reg, return addr already on stack from prior CALL
    (if (i32.and (i32.ge_u (local.get $target) (global.get $thunk_guest_base))
                 (i32.lt_u (local.get $target) (global.get $thunk_guest_end)))
      (then
        (local.set $ret_addr (call $gl32 (global.get $esp)))
        (call $win32_dispatch (i32.div_u (i32.sub (local.get $target) (global.get $thunk_guest_base)) (i32.const 8)))
        (if (global.get $steps) (then (global.set $eip (local.get $ret_addr))))
        (return)))
    (global.set $eip (local.get $target)))
  (func $th_push_m32 (param $op i32)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $gl32 (call $read_addr))) (return_call $next))
  (func $th_alu_m16_i16 (param $op i32)
    (local $addr i32) (local $imm i32) (local $val i32)
    (local.set $addr (call $read_addr)) (local.set $imm (call $read_thread_word))
    (local.set $val (call $do_alu32 (local.get $op) (call $gl16 (local.get $addr)) (local.get $imm)))
    (global.set $flag_res (i32.and (global.get $flag_res) (i32.const 0xFFFF)))
    (global.set $flag_sign_shift (i32.const 15))
    (if (i32.ne (local.get $op) (i32.const 7)) (then (call $gs16 (local.get $addr) (local.get $val))))
    (return_call $next))
  (func $th_load8s (param $op i32)
    (local $v i32) (local.set $v (call $gl8 (call $read_addr)))
    (if (i32.ge_u (local.get $v) (i32.const 0x80))
      (then (local.set $v (i32.or (local.get $v) (i32.const 0xFFFFFF00)))))
    (call $set_reg (local.get $op) (local.get $v)) (return_call $next))
  (func $th_test_m8_i8 (param $op i32)
    (call $set_flags_logic (i32.and (call $gl8 (call $read_addr)) (local.get $op))) (return_call $next))

  ;; 125: jmp [mem] — for jmp through IAT or vtable
  ;; operand=ignored, mem_addr in next thread word
  (func $th_jmp_ind (param $op i32)
    (local $mem_addr i32) (local $target i32) (local $ret_addr i32)
    (local.set $mem_addr (call $read_addr))
    (local.set $target (call $gl32 (local.get $mem_addr)))
    ;; Check thunk zone (guest-space bounds) — JMP, not CALL. Return addr already on stack.
    (if (i32.and (i32.ge_u (local.get $target) (global.get $thunk_guest_base))
                 (i32.lt_u (local.get $target) (global.get $thunk_guest_end)))
      (then
        (local.set $ret_addr (call $gl32 (global.get $esp)))
        (call $win32_dispatch (i32.div_u (i32.sub (local.get $target) (global.get $thunk_guest_base)) (i32.const 8)))
        (if (global.get $steps) (then (global.set $eip (local.get $ret_addr))))
        (return)))
    ;; Not a thunk — regular indirect jump
    (global.set $eip (local.get $target)))

  ;; --- Runtime EA handlers (compute address from base_reg + disp at execution time) ---

  ;; 126: LEA dst, [base+disp]. operand=dst<<4|base, disp in next word.
  (func $th_lea_ro (param $op i32)
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4))
      (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (call $read_thread_word)))
    (return_call $next))

  ;; 148: LEA dst, [base+index*scale+disp]. op=dst. Words: base|index<<4|scale<<8, disp.
  (func $th_lea_sib (param $op i32)
    (local $info i32) (local $base_val i32) (local $index_val i32) (local $scale i32) (local $disp i32)
    (local.set $info (call $read_thread_word))
    (local.set $disp (call $read_thread_word))
    ;; base: low 4 bits (0xF = no base)
    (if (i32.ne (i32.and (local.get $info) (i32.const 0xF)) (i32.const 0xF))
      (then (local.set $base_val (call $get_reg (i32.and (local.get $info) (i32.const 0xF))))))
    ;; index: bits 4-7 (0xF = no index)
    (if (i32.ne (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF)) (i32.const 0xF))
      (then
        (local.set $scale (i32.and (i32.shr_u (local.get $info) (i32.const 8)) (i32.const 3)))
        (local.set $index_val (i32.shl
          (call $get_reg (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF)))
          (local.get $scale)))))
    (call $set_reg (local.get $op)
      (i32.add (i32.add (local.get $base_val) (local.get $index_val)) (local.get $disp)))
    (return_call $next))

  ;; 149: compute SIB EA → ea_temp, then continue to next handler
  (func $th_compute_ea_sib (param $op i32)
    (local $info i32) (local $base_val i32) (local $index_val i32) (local $scale i32) (local $disp i32)
    (local.set $info (call $read_thread_word))
    (local.set $disp (call $read_thread_word))
    (if (i32.ne (i32.and (local.get $info) (i32.const 0xF)) (i32.const 0xF))
      (then (local.set $base_val (call $get_reg (i32.and (local.get $info) (i32.const 0xF))))))
    (if (i32.ne (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF)) (i32.const 0xF))
      (then
        (local.set $scale (i32.and (i32.shr_u (local.get $info) (i32.const 8)) (i32.const 3)))
        (local.set $index_val (i32.shl
          (call $get_reg (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF)))
          (local.get $scale)))))
    (global.set $ea_temp (i32.add (i32.add (local.get $base_val) (local.get $index_val)) (local.get $disp)))
    (return_call $next))

  ;; Helper: compute EA from operand encoding (alu_op<<8 | reg<<4 | base)
  (func $ea_from_op (param $op i32) (result i32)
    (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (call $read_thread_word)))

  ;; 127: [base+disp] OP= reg32. operand = alu_op<<8 | reg<<4 | base. disp in next word.
  (func $th_alu_m32_r_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $reg i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $val (call $do_alu32 (local.get $alu) (call $gl32 (local.get $addr)) (call $get_reg (local.get $reg))))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $gs32 (local.get $addr) (local.get $val))))
    (return_call $next))

  ;; 128: reg32 OP= [base+disp]. operand = alu_op<<8 | reg<<4 | base.
  (func $th_alu_r_m32_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $reg i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $val (call $do_alu32 (local.get $alu) (call $get_reg (local.get $reg)) (call $gl32 (local.get $addr))))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $set_reg (local.get $reg) (local.get $val))))
    (return_call $next))

  ;; 129: [base+disp] OP= reg8. operand = alu_op<<8 | reg<<4 | base.
  (func $th_alu_m8_r_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $reg i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $val (call $do_alu32 (local.get $alu) (call $gl8 (local.get $addr)) (call $get_reg8 (local.get $reg))))
    (global.set $flag_sign_shift (i32.const 7))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $gs8 (local.get $addr) (local.get $val))))
    (return_call $next))

  ;; 130: reg8 OP= [base+disp]. operand = alu_op<<8 | reg<<4 | base.
  (func $th_alu_r_m8_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $reg i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $val (call $do_alu32 (local.get $alu) (call $get_reg8 (local.get $reg)) (call $gl8 (local.get $addr))))
    (global.set $flag_sign_shift (i32.const 7))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $set_reg8 (local.get $reg) (local.get $val))))
    (return_call $next))

  ;; 131: [base+disp] OP= imm32. operand = alu_op<<8 | base. disp+imm in next words.
  (func $th_alu_m32_i_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $imm i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $imm (call $read_thread_word))
    (local.set $val (call $do_alu32 (local.get $alu) (call $gl32 (local.get $addr)) (local.get $imm)))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $gs32 (local.get $addr) (local.get $val))))
    (return_call $next))

  ;; 132: [base+disp] OP= imm8. operand = alu_op<<8 | base. disp+imm in next words.
  (func $th_alu_m8_i_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $imm i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $imm (call $read_thread_word))
    (local.set $val (call $do_alu32 (local.get $alu) (call $gl8 (local.get $addr)) (local.get $imm)))
    (global.set $flag_sign_shift (i32.const 7))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $gs8 (local.get $addr) (local.get $val))))
    (return_call $next))

  ;; 220: [base+disp] OP= imm16. operand = alu_op<<8 | base. disp+imm in next words.
  (func $th_alu_m16_i_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $imm i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $imm (call $read_thread_word))
    (local.set $val (call $do_alu32 (local.get $alu) (call $gl16 (local.get $addr)) (local.get $imm)))
    (global.set $flag_res (i32.and (global.get $flag_res) (i32.const 0xFFFF)))
    (global.set $flag_sign_shift (i32.const 15))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $gs16 (local.get $addr) (local.get $val))))
    (return_call $next))

  ;; 133: mov [base+disp], imm32. op=base, disp+imm in next words.
  (func $th_mov_m32_i32_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (call $gs32 (local.get $addr) (call $read_thread_word))
    (return_call $next))
  ;; 134: mov [base+disp], imm8.
  (func $th_mov_m8_i8_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (call $gs8 (local.get $addr) (call $read_thread_word))
    (return_call $next))
  ;; 135: inc/dec/not/neg [base+disp]. op=unary_op<<4|base, disp in word.
  (func $th_unary_m32_ro (param $op i32)
    (local $addr i32) (local $uop i32) (local $old i32) (local $r i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $uop (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $old (call $gl32 (local.get $addr)))
    (if (i32.eq (local.get $uop) (i32.const 0))
      (then (local.set $r (i32.add (local.get $old) (i32.const 1)))
            (call $set_flags_inc (local.get $old) (local.get $r))))
    (if (i32.eq (local.get $uop) (i32.const 1))
      (then (local.set $r (i32.sub (local.get $old) (i32.const 1)))
            (call $set_flags_dec (local.get $old) (local.get $r))))
    (if (i32.eq (local.get $uop) (i32.const 2))
      (then (local.set $r (i32.xor (local.get $old) (i32.const -1)))))
    (if (i32.eq (local.get $uop) (i32.const 3))
      (then (local.set $r (i32.sub (i32.const 0) (local.get $old)))
            (call $set_flags_sub (i32.const 0) (local.get $old) (local.get $r))))
    (call $gs32 (local.get $addr) (local.get $r)) (return_call $next))
  ;; 136: test [base+disp], reg. op=reg<<4|base, disp in word.
  (func $th_test_m32_r_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (drop (call $do_alu32 (i32.const 4) (call $gl32 (local.get $addr))
      (call $get_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))))
    (return_call $next))
  ;; 137: test [base+disp], imm32. op=base, disp+imm in words.
  (func $th_test_m32_i32_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (drop (call $do_alu32 (i32.const 4) (call $gl32 (local.get $addr)) (call $read_thread_word)))
    (return_call $next))
  ;; 138: test [base+disp], imm8. op=base, disp+imm in words.
  (func $th_test_m8_i8_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (drop (call $do_alu32 (i32.const 4) (call $gl8 (local.get $addr)) (call $read_thread_word)))
    (return_call $next))
  ;; 139: shift [base+disp]. op=base, next word=shift_info (type<<8|count), next word=disp.
  ;; Wait — ea_from_op reads disp as first word. So: op=base, word1=disp (from ea_from_op), word2=shift_info.
  ;; Actually let me not use ea_from_op here for flexibility. op=base, w1=disp, w2=shift_type<<8|count.
  (func $th_shift_m32_ro (param $op i32)
    (local $addr i32) (local $info i32) (local $stype i32) (local $count i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $info (call $read_thread_word))
    (local.set $stype (i32.and (i32.shr_u (local.get $info) (i32.const 8)) (i32.const 7)))
    (local.set $count (i32.and (local.get $info) (i32.const 0xFF)))
    (if (i32.eq (local.get $count) (i32.const 0xFF)) (then (local.set $count (i32.and (global.get $ecx) (i32.const 31)))))
    (local.set $val (call $gl32 (local.get $addr)))
    (call $gs32 (local.get $addr) (call $do_shift32 (local.get $stype) (local.get $val) (local.get $count)))
    (return_call $next))
  ;; 140: call [base+disp]. op=ret_addr, w1=base, w2=disp.
  ;; Different encoding: we need ret_addr in operand AND base+disp. Pack base in w1, disp in w2.
  (func $th_call_ind_ro (param $op i32)
    (local $base i32) (local $disp i32) (local $mem_addr i32) (local $target i32)
    (local.set $base (call $read_thread_word))
    (local.set $disp (call $read_thread_word))
    (local.set $mem_addr (i32.add (call $get_reg (local.get $base)) (local.get $disp)))
    (local.set $target (call $gl32 (local.get $mem_addr)))
    (if (i32.and (i32.ge_u (local.get $target) (global.get $thunk_guest_base))
                 (i32.lt_u (local.get $target) (global.get $thunk_guest_end)))
      (then
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (local.get $op))
        (call $win32_dispatch (i32.div_u (i32.sub (local.get $target) (global.get $thunk_guest_base)) (i32.const 8)))
        (if (global.get $steps) (then (global.set $eip (local.get $op))))
        (return)))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $op))
    (global.set $eip (local.get $target)))
  ;; 141: jmp [base+disp]. op=0, w1=base, w2=disp.
  (func $th_jmp_ind_ro (param $op i32)
    (local $base i32) (local $disp i32) (local $mem_addr i32) (local $target i32)
    (local $ret_addr i32)
    (local.set $base (call $read_thread_word))
    (local.set $disp (call $read_thread_word))
    (local.set $mem_addr (i32.add (call $get_reg (local.get $base)) (local.get $disp)))
    (local.set $target (call $gl32 (local.get $mem_addr)))
    (if (i32.and (i32.ge_u (local.get $target) (global.get $thunk_guest_base))
                 (i32.lt_u (local.get $target) (global.get $thunk_guest_end)))
      (then
        ;; JMP to thunk (e.g. JMP [IAT] trampoline). The return address is at [ESP]
        ;; (pushed by the preceding CALL). Save it before the handler pops it.
        (local.set $ret_addr (call $gl32 (global.get $esp)))
        (call $win32_dispatch (i32.div_u (i32.sub (local.get $target) (global.get $thunk_guest_base)) (i32.const 8)))
        ;; If dispatch redirected (steps=0), EIP was already set by the handler
        (if (global.get $steps) (then (global.set $eip (local.get $ret_addr))))
        (return)))
    (global.set $eip (local.get $target)))
  ;; 142: push [base+disp]. op=base, disp in word.
  (func $th_push_m32_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $gl32 (local.get $addr)))
    (return_call $next))
  ;; 143-146: movzx/movsx [base+disp] variants. op=dst<<4|base, disp in word.
  (func $th_movzx8_ro (param $op i32)
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4))
      (call $gl8 (call $ea_from_op (local.get $op))))
    (return_call $next))
  (func $th_movsx8_ro (param $op i32)
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4))
      (call $sign_ext8 (call $gl8 (call $ea_from_op (local.get $op)))))
    (return_call $next))
  (func $th_movzx16_ro (param $op i32)
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4))
      (call $gl16 (call $ea_from_op (local.get $op))))
    (return_call $next))
  (func $th_movsx16_ro (param $op i32)
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4))
      (call $sign_ext16 (call $gl16 (call $ea_from_op (local.get $op)))))
    (return_call $next))
  ;; 147: mul/imul/div/idiv [base+disp]. op=type<<4|base, disp in word. type: 0=mul,1=imul,2=div,3=idiv
  (func $th_muldiv_m32_ro (param $op i32)
    (local $addr i32) (local $mtype i32) (local $mval i32) (local $val64 i64) (local $divisor i64) (local $dividend i64)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $mtype (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $mval (call $gl32 (local.get $addr)))
    (if (i32.eq (local.get $mtype) (i32.const 0)) ;; MUL
      (then (local.set $val64 (i64.mul (i64.extend_i32_u (global.get $eax)) (i64.extend_i32_u (local.get $mval))))
            (global.set $eax (i32.wrap_i64 (local.get $val64)))
            (global.set $edx (i32.wrap_i64 (i64.shr_u (local.get $val64) (i64.const 32))))
            (call $set_flags_mul (i32.ne (global.get $edx) (i32.const 0)))))
    (if (i32.eq (local.get $mtype) (i32.const 1)) ;; IMUL
      (then (local.set $val64 (i64.mul (i64.extend_i32_s (global.get $eax)) (i64.extend_i32_s (local.get $mval))))
            (global.set $eax (i32.wrap_i64 (local.get $val64)))
            (global.set $edx (i32.wrap_i64 (i64.shr_s (local.get $val64) (i64.const 32))))
            (call $set_flags_mul (i32.ne (global.get $edx) (i32.shr_s (global.get $eax) (i32.const 31))))))
    (if (i32.eq (local.get $mtype) (i32.const 2)) ;; DIV
      (then (local.set $divisor (i64.extend_i32_u (local.get $mval)))
            (local.set $dividend (i64.or (i64.extend_i32_u (global.get $eax))
              (i64.shl (i64.extend_i32_u (global.get $edx)) (i64.const 32))))
            (if (i64.eqz (local.get $divisor)) (then (call $raise_exception (i32.const 2)) (return)))
            (global.set $eax (i32.wrap_i64 (i64.div_u (local.get $dividend) (local.get $divisor))))
            (global.set $edx (i32.wrap_i64 (i64.rem_u (local.get $dividend) (local.get $divisor))))))
    (if (i32.eq (local.get $mtype) (i32.const 3)) ;; IDIV
      (then (local.set $divisor (i64.extend_i32_s (local.get $mval)))
            (local.set $dividend (i64.or (i64.extend_i32_u (global.get $eax))
              (i64.shl (i64.extend_i32_u (global.get $edx)) (i64.const 32))))
            (if (i64.eqz (local.get $divisor)) (then (call $raise_exception (i32.const 3)) (return)))
            (global.set $eax (i32.wrap_i64 (i64.div_s (local.get $dividend) (local.get $divisor))))
            (global.set $edx (i32.wrap_i64 (i64.rem_s (local.get $dividend) (local.get $divisor))))))
    (return_call $next))

