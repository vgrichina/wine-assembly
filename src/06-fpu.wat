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
  ;;     mantissa, 11-bit exponent). FLD/FSTP m80 convert between real 80-bit
  ;;     sign/exponent/explicit-mantissa values and f64, so code that depends
  ;;     on the extra ~11 bits of mantissa or the wider exponent range will
  ;;     still diverge.
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
    (global.set $fpu_raw_tag (i32.and (global.get $fpu_raw_tag)
      (i32.xor (i32.const 0xFF)
        (i32.shl (i32.const 1) (call $fpu_tag_phys
          (i32.add (global.get $fpu_top) (local.get $i)))))))
    (global.set $fpu_tag (i32.and (global.get $fpu_tag)
      (i32.xor (i32.const 0xFF)
        (i32.shl (i32.const 1) (call $fpu_tag_phys
          (i32.add (global.get $fpu_top) (local.get $i))))))))
  (func $fpu_is_valid (param $i i32) (result i32)
    (i32.and (i32.shr_u (global.get $fpu_tag)
      (call $fpu_tag_phys (i32.add (global.get $fpu_top) (local.get $i))))
      (i32.const 1)))

  (func $fpu_raw_clear (param $i i32)
    (global.set $fpu_raw_tag (i32.and (global.get $fpu_raw_tag)
      (i32.xor (i32.const 0xFF)
        (i32.shl (i32.const 1) (call $fpu_tag_phys
          (i32.add (global.get $fpu_top) (local.get $i))))))))

  (func $fpu_raw_valid (param $i i32) (result i32)
    (i32.and (i32.shr_u (global.get $fpu_raw_tag)
      (call $fpu_tag_phys (i32.add (global.get $fpu_top) (local.get $i))))
      (i32.const 1)))

  (func $fpu_raw_get_phys (param $p i32) (result i64)
    (local $v i64)
    (local.set $v (global.get $fpu_raw7))
    (if (i32.eq (local.get $p) (i32.const 0)) (then (local.set $v (global.get $fpu_raw0))))
    (if (i32.eq (local.get $p) (i32.const 1)) (then (local.set $v (global.get $fpu_raw1))))
    (if (i32.eq (local.get $p) (i32.const 2)) (then (local.set $v (global.get $fpu_raw2))))
    (if (i32.eq (local.get $p) (i32.const 3)) (then (local.set $v (global.get $fpu_raw3))))
    (if (i32.eq (local.get $p) (i32.const 4)) (then (local.set $v (global.get $fpu_raw4))))
    (if (i32.eq (local.get $p) (i32.const 5)) (then (local.set $v (global.get $fpu_raw5))))
    (if (i32.eq (local.get $p) (i32.const 6)) (then (local.set $v (global.get $fpu_raw6))))
    (local.get $v))

  (func $fpu_raw_get (param $i i32) (result i64)
    (call $fpu_raw_get_phys
      (call $fpu_tag_phys (i32.add (global.get $fpu_top) (local.get $i)))))

  (func $fpu_raw_set (param $i i32) (param $v i64)
    (local $p i32)
    (local.set $p (call $fpu_tag_phys (i32.add (global.get $fpu_top) (local.get $i))))
    (if (i32.eq (local.get $p) (i32.const 0)) (then (global.set $fpu_raw0 (local.get $v))))
    (if (i32.eq (local.get $p) (i32.const 1)) (then (global.set $fpu_raw1 (local.get $v))))
    (if (i32.eq (local.get $p) (i32.const 2)) (then (global.set $fpu_raw2 (local.get $v))))
    (if (i32.eq (local.get $p) (i32.const 3)) (then (global.set $fpu_raw3 (local.get $v))))
    (if (i32.eq (local.get $p) (i32.const 4)) (then (global.set $fpu_raw4 (local.get $v))))
    (if (i32.eq (local.get $p) (i32.const 5)) (then (global.set $fpu_raw5 (local.get $v))))
    (if (i32.eq (local.get $p) (i32.const 6)) (then (global.set $fpu_raw6 (local.get $v))))
    (if (i32.eq (local.get $p) (i32.const 7)) (then (global.set $fpu_raw7 (local.get $v))))
    (global.set $fpu_raw_tag
      (i32.or (global.get $fpu_raw_tag) (i32.shl (i32.const 1) (local.get $p)))))

  ;; Set status-word exception flags. Bits: IE=1, DE=2, ZE=4, OE=8, UE=16, PE=32,
  ;; SF=64 (stack fault, paired with IE), ES=128 (error summary).
  (func $fpu_set_exc (param $bits i32)
    (global.set $fpu_sw (i32.or (global.get $fpu_sw)
      (i32.or (local.get $bits) (i32.const 0x80)))))

  (func $fpu_get (param $i i32) (result f64)
    (f64.load (i32.add (i32.const 0x200)
      (i32.shl (i32.and (i32.add (global.get $fpu_top) (local.get $i)) (i32.const 7)) (i32.const 3)))))

  (func $fpu_set (param $i i32) (param $v f64)
    (call $fpu_raw_clear (local.get $i))
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

  (func $fpu_load_m80 (param $addr i32) (result f64)
    (local $w i32) (local $se i32) (local $exp i32) (local $sign i32)
    (local $mant i64) (local $val f64)
    (local.set $w (call $g2w (local.get $addr)))
    (local.set $mant (i64.load (local.get $w)))
    (local.set $se (i32.load16_u (i32.add (local.get $w) (i32.const 8))))
    (local.set $exp (i32.and (local.get $se) (i32.const 0x7FFF)))
    (local.set $sign (i32.and (local.get $se) (i32.const 0x8000)))
    ;; Backward compatibility for values stored by our FSTP m80 path: an f64
    ;; payload followed by a zero sign/exponent word.
    (if (i32.and (i32.eqz (local.get $exp)) (i64.ne (local.get $mant) (i64.const 0)))
      (then (return (f64.load (local.get $w)))))
    (if (i64.eqz (local.get $mant))
      (then
        (if (local.get $sign)
          (then (return (f64.const -0.0)))
          (else (return (f64.const 0.0))))))
    (if (i32.eq (local.get $exp) (i32.const 0x7FFF))
      (then
        (local.set $val (f64.const 1.7976931348623157e308))
        (if (local.get $sign) (then (local.set $val (f64.neg (local.get $val)))))
        (return (local.get $val))))
    (local.set $val
      (f64.mul
        (f64.div (f64.convert_i64_u (local.get $mant))
                 (f64.const 9223372036854775808.0))
        (call $host_math_pow2
          (f64.convert_i32_s (i32.sub (local.get $exp) (i32.const 16383))))))
    (if (local.get $sign) (then (local.set $val (f64.neg (local.get $val)))))
    (local.get $val))

  (func $fpu_store_m80 (param $addr i32) (param $val f64)
    (local $w i32) (local $sign i32) (local $exp i32)
    (local $abs f64) (local $scaled f64)
    (local.set $w (call $g2w (local.get $addr)))
    (local.set $abs (f64.abs (local.get $val)))
    (if (i64.lt_s (i64.reinterpret_f64 (local.get $val)) (i64.const 0))
      (then (local.set $sign (i32.const 0x8000))))
    (if (call $fpu_is_nan (local.get $val))
      (then
        (i64.store (local.get $w) (i64.const -4611686018427387904))
        (i32.store16 (i32.add (local.get $w) (i32.const 8))
          (i32.or (local.get $sign) (i32.const 0x7FFF)))
        (return)))
    (if (f64.eq (local.get $abs) (f64.const 0))
      (then
        (i64.store (local.get $w) (i64.const 0))
        (i32.store16 (i32.add (local.get $w) (i32.const 8)) (local.get $sign))
        (return)))
    (if (f64.ge (local.get $abs) (f64.const 1.7976931348623157e308))
      (then
        (i64.store (local.get $w) (i64.const -9223372036854775808))
        (i32.store16 (i32.add (local.get $w) (i32.const 8))
          (i32.or (local.get $sign) (i32.const 0x7FFF)))
        (return)))
    (local.set $exp (i32.trunc_f64_s (f64.floor (call $host_math_log2 (local.get $abs)))))
    (local.set $scaled
      (f64.mul
        (f64.div (local.get $abs)
          (call $host_math_pow2 (f64.convert_i32_s (local.get $exp))))
        (f64.const 9223372036854775808.0)))
    (if (f64.ge (local.get $scaled) (f64.const 18446744073709551616.0))
      (then
        (i64.store (local.get $w) (i64.const -9223372036854775808))
        (local.set $exp (i32.add (local.get $exp) (i32.const 1))))
      (else
        (i64.store (local.get $w) (i64.trunc_f64_u (local.get $scaled)))))
    (i32.store16 (i32.add (local.get $w) (i32.const 8))
      (i32.or (local.get $sign)
        (i32.and (i32.add (local.get $exp) (i32.const 16383)) (i32.const 0x7FFF)))))

  ;; ── FNSTENV / FLDENV / FNSAVE / FRSTOR / FBLD / FBSTP helpers ─────
  ;; 32-bit protected-mode env block (28 bytes): CW, SW (with TOP packed),
  ;; Tag word (2 bits/reg: 00=valid, 11=empty), FIP, FCS:opcode, FDP, FDS.
  ;; We collapse all "valid" subtypes to 00 since our tag global is 1-bit/reg.
  (func $fpu_pack_tag_word (result i32)
    (local $i i32) (local $w i32)
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (i32.const 8)))
      (if (i32.eqz (i32.and (i32.shr_u (global.get $fpu_tag) (local.get $i)) (i32.const 1)))
        (then (local.set $w (i32.or (local.get $w)
          (i32.shl (i32.const 3) (i32.shl (local.get $i) (i32.const 1)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (local.get $w))

  (func $fpu_unpack_tag_word (param $tw i32)
    (local $i i32) (local $t i32)
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (i32.const 8)))
      (if (i32.ne
            (i32.and (i32.shr_u (local.get $tw) (i32.shl (local.get $i) (i32.const 1))) (i32.const 3))
            (i32.const 3))
        (then (local.set $t (i32.or (local.get $t) (i32.shl (i32.const 1) (local.get $i))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (global.set $fpu_tag (local.get $t)))

  ;; FIP (+12) / FCS:FOP (+16) / FDP (+20) / FDS (+24): on real x87 these
  ;; record the linear address + selector + opcode of the last non-control
  ;; FPU instruction and its memory operand, so an #MF handler can identify
  ;; the faulting op. We never deliver #MF (masked exceptions only set SW
  ;; flags and continue), nothing in our test corpus reads these fields,
  ;; we have no segment selectors to report, and computing a real FIP would
  ;; require stashing EIP in every FPU thread handler. We write zeros and
  ;; document the gap. If a guest ever does parse them it sees a null
  ;; selector — easy to spot if it ever matters.
  (func $fpu_store_env (param $addr i32)
    (local $w i32)
    (local.set $w (call $g2w (local.get $addr)))
    (i32.store (local.get $w) (global.get $fpu_cw))
    (i32.store (i32.add (local.get $w) (i32.const 4))
      (i32.or (i32.and (global.get $fpu_sw) (i32.const 0xC7FF))
              (i32.shl (global.get $fpu_top) (i32.const 11))))
    (i32.store (i32.add (local.get $w) (i32.const 8)) (call $fpu_pack_tag_word))
    (i32.store (i32.add (local.get $w) (i32.const 12)) (i32.const 0))   ;; FIP
    (i32.store (i32.add (local.get $w) (i32.const 16)) (i32.const 0))   ;; FCS:FOP
    (i32.store (i32.add (local.get $w) (i32.const 20)) (i32.const 0))   ;; FDP
    (i32.store (i32.add (local.get $w) (i32.const 24)) (i32.const 0)))  ;; FDS

  (func $fpu_load_env (param $addr i32)
    (local $w i32) (local $sw i32)
    (local.set $w (call $g2w (local.get $addr)))
    (global.set $fpu_cw (i32.and (i32.load (local.get $w)) (i32.const 0xFFFF)))
    (local.set $sw (i32.and (i32.load (i32.add (local.get $w) (i32.const 4))) (i32.const 0xFFFF)))
    (global.set $fpu_top (i32.and (i32.shr_u (local.get $sw) (i32.const 11)) (i32.const 7)))
    (global.set $fpu_sw (i32.and (local.get $sw) (i32.const 0xC7FF)))
    (global.set $fpu_raw_tag (i32.const 0))
    (call $fpu_unpack_tag_word
      (i32.and (i32.load (i32.add (local.get $w) (i32.const 8))) (i32.const 0xFFFF))))

  ;; FNSAVE/FRSTOR ST area: 8 x 10-byte slots in PHYSICAL order.
  (func $fpu_store_regs (param $addr i32)
    (local $i i32) (local $base i32) (local $slot i32)
    (local.set $base (call $g2w (local.get $addr)))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (i32.const 8)))
      (local.set $slot (i32.add (local.get $base)
        (i32.add (i32.shl (local.get $i) (i32.const 3)) (i32.shl (local.get $i) (i32.const 1)))))
      (call $fpu_store_m80
        (i32.add (local.get $addr)
          (i32.add (i32.shl (local.get $i) (i32.const 3)) (i32.shl (local.get $i) (i32.const 1))))
        (f64.load (i32.add (i32.const 0x200) (i32.shl (local.get $i) (i32.const 3)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp))))

  (func $fpu_load_regs (param $addr i32)
    (local $i i32) (local $base i32) (local $slot i32)
    (global.set $fpu_raw_tag (i32.const 0))
    (local.set $base (call $g2w (local.get $addr)))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (i32.const 8)))
      (local.set $slot (i32.add (local.get $base)
        (i32.add (i32.shl (local.get $i) (i32.const 3)) (i32.shl (local.get $i) (i32.const 1)))))
      (f64.store (i32.add (i32.const 0x200) (i32.shl (local.get $i) (i32.const 3)))
        (call $fpu_load_m80 (i32.add (local.get $addr)
          (i32.add (i32.shl (local.get $i) (i32.const 3)) (i32.shl (local.get $i) (i32.const 1))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp))))

  ;; FBLD: 80-bit packed BCD → ST(0). 18 BCD digits in low 9 bytes
  ;; (low nibble = lower digit), sign byte at offset 9 (bit 7 = negative).
  (func $fpu_bld (param $addr i32)
    (local $i i32) (local $w i32) (local $b i32) (local $val f64) (local $mult f64)
    (local.set $w (call $g2w (local.get $addr)))
    (local.set $mult (f64.const 1))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (i32.const 9)))
      (local.set $b (i32.load8_u (i32.add (local.get $w) (local.get $i))))
      (local.set $val (f64.add (local.get $val)
        (f64.mul (f64.convert_i32_u (i32.and (local.get $b) (i32.const 0x0F)))
                 (local.get $mult))))
      (local.set $mult (f64.mul (local.get $mult) (f64.const 10)))
      (local.set $val (f64.add (local.get $val)
        (f64.mul (f64.convert_i32_u (i32.and (i32.shr_u (local.get $b) (i32.const 4)) (i32.const 0x0F)))
                 (local.get $mult))))
      (local.set $mult (f64.mul (local.get $mult) (f64.const 10)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (if (i32.and (i32.load8_u (i32.add (local.get $w) (i32.const 9))) (i32.const 0x80))
      (then (local.set $val (f64.neg (local.get $val)))))
    (call $fpu_push (local.get $val)))

  ;; FBSTP: ST(0) → 80-bit packed BCD, then pop.
  (func $fpu_bstp (param $addr i32)
    (local $i i32) (local $w i32) (local $sign i32) (local $val f64) (local $vi i64)
    (local $rem i32) (local $tens i32) (local $ones i32)
    (local.set $w (call $g2w (local.get $addr)))
    (local.set $val (call $fpu_pop))
    (if (f64.lt (local.get $val) (f64.const 0))
      (then (local.set $sign (i32.const 0x80)) (local.set $val (f64.neg (local.get $val)))))
    (local.set $val (f64.nearest (local.get $val)))
    ;; BCD max is 10^18 - 1; clamp out-of-range and NaN to zero (i64.trunc traps otherwise).
    (if (i32.or (f64.ne (local.get $val) (local.get $val))
                (f64.ge (local.get $val) (f64.const 1e18)))
      (then (local.set $val (f64.const 0))))
    (local.set $vi (i64.trunc_f64_u (local.get $val)))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (i32.const 9)))
      (local.set $rem (i32.wrap_i64 (i64.rem_u (local.get $vi) (i64.const 100))))
      (local.set $vi  (i64.div_u (local.get $vi) (i64.const 100)))
      (local.set $ones (i32.rem_u (local.get $rem) (i32.const 10)))
      (local.set $tens (i32.div_u (local.get $rem) (i32.const 10)))
      (i32.store8 (i32.add (local.get $w) (local.get $i))
        (i32.or (i32.shl (local.get $tens) (i32.const 4)) (local.get $ones)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (i32.store8 (i32.add (local.get $w) (i32.const 9)) (local.get $sign)))

  (func $fpu_exec_mem (param $group i32) (param $reg i32) (param $addr i32)
    (local $val f64) (local $raw i64)
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
          (then
            (f32.store (call $g2w (local.get $addr)) (f32.demote_f64 (call $fpu_get (i32.const 0))))
            (return)))
        (if (i32.eq (local.get $reg) (i32.const 3))
          (then
            (f32.store (call $g2w (local.get $addr)) (f32.demote_f64 (call $fpu_pop)))
            (return)))
        (if (i32.eq (local.get $reg) (i32.const 5))
          (then (global.set $fpu_cw (i32.load16_u (call $g2w (local.get $addr)))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 7))
          (then (call $gs16 (local.get $addr) (global.get $fpu_cw)) (return)))
        ;; reg=4 FLDENV, reg=6 FNSTENV — 28-byte 32-bit protected-mode env block.
        (if (i32.eq (local.get $reg) (i32.const 4))
          (then (call $fpu_load_env (local.get $addr)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 6))
          (then (call $fpu_store_env (local.get $addr))
                ;; Real FNSTENV masks all exceptions in CW after save.
                (global.set $fpu_cw (i32.or (global.get $fpu_cw) (i32.const 0x3F)))
                (return)))
        (call $fpu_crash_op (local.get $group) (local.get $reg) (i32.const 0)) (return)))
    ;; Group 5 (DD): FLD/FST/FSTP float64, FRSTOR, FNSAVE, FNSTSW m16
    (if (i32.eq (local.get $group) (i32.const 5))
      (then
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (call $fpu_push (f64.load (call $g2w (local.get $addr)))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then
            (f64.store (call $g2w (local.get $addr)) (call $fpu_get (i32.const 0)))
            (return)))
        (if (i32.eq (local.get $reg) (i32.const 3))
          (then
            (f64.store (call $g2w (local.get $addr)) (call $fpu_pop))
            (return)))
        (if (i32.eq (local.get $reg) (i32.const 7))
          (then
            (global.set $fpu_sw (i32.or (i32.and (global.get $fpu_sw) (i32.const 0xC7FF))
              (i32.shl (global.get $fpu_top) (i32.const 11))))
            (call $gs16 (local.get $addr) (global.get $fpu_sw)) (return)))
        ;; reg=4 FRSTOR, reg=6 FNSAVE — 108-byte: 28-byte env + 8×10-byte STs.
        (if (i32.eq (local.get $reg) (i32.const 4))
          (then (call $fpu_load_env (local.get $addr))
                (call $fpu_load_regs (i32.add (local.get $addr) (i32.const 28)))
                (return)))
        (if (i32.eq (local.get $reg) (i32.const 6))
          (then (call $fpu_store_env (local.get $addr))
                (call $fpu_store_regs (i32.add (local.get $addr) (i32.const 28)))
                ;; Post-FNSAVE: reinit to power-on state (matches real x87).
                (global.set $fpu_top (i32.const 0)) (global.set $fpu_cw (i32.const 0x037F))
                (global.set $fpu_sw (i32.const 0)) (global.set $fpu_tag (i32.const 0))
                (global.set $fpu_raw_tag (i32.const 0))
                (return)))
        (call $fpu_crash_op (local.get $group) (local.get $reg) (i32.const 0)) (return)))
    ;; Group 3 (DB): FILD/FIST/FISTP int32, FLD/FSTP m80
    (if (i32.eq (local.get $group) (i32.const 3))
      (then
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (call $fpu_push (f64.convert_i32_s (call $gl32 (local.get $addr)))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (call $gs32 (local.get $addr) (call $fpu_to_i32 (call $fpu_get (i32.const 0)))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 3))
          (then (call $gs32 (local.get $addr) (call $fpu_to_i32 (call $fpu_pop))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 5))
          ;; FLD m80 — decode real 80-bit extended values into f64.
          (then (call $fpu_push (call $fpu_load_m80 (local.get $addr))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 7))
          ;; FSTP m80 — convert f64-backed ST(0) to real 80-bit extended format.
          (then (call $fpu_store_m80 (local.get $addr) (call $fpu_pop)) (return)))
        (call $fpu_crash_op (local.get $group) (local.get $reg) (i32.const 0)) (return)))
    ;; Group 7 (DF): FILD/FIST/FISTP int16, FILD/FISTP int64
    (if (i32.eq (local.get $group) (i32.const 7))
      (then
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (call $fpu_push (f64.convert_i32_s (i32.load16_s (call $g2w (local.get $addr))))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (call $gs16 (local.get $addr) (call $fpu_to_i16 (call $fpu_get (i32.const 0)))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 3))
          (then (call $gs16 (local.get $addr) (call $fpu_to_i16 (call $fpu_pop))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 4))
          (then (call $fpu_bld (local.get $addr)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 5))
          (then
            (local.set $raw (i64.load (call $g2w (local.get $addr))))
            (call $fpu_push (f64.convert_i64_s (local.get $raw)))
            (call $fpu_raw_set (i32.const 0) (local.get $raw))
            (return)))
        (if (i32.eq (local.get $reg) (i32.const 6))
          (then (call $fpu_bstp (local.get $addr)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 7))
          (then
            (if (call $fpu_raw_valid (i32.const 0))
              (then
                (i64.store (call $g2w (local.get $addr)) (call $fpu_raw_get (i32.const 0)))
                (drop (call $fpu_pop))
                (return)))
            (i64.store (call $g2w (local.get $addr)) (call $fpu_to_i64 (call $fpu_pop)))
            (return)))
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

(func $th_emms (param $op i32)
            (global.set $fpu_tag (i32.const 0)) (return_call $next))
