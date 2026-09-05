  ;; ============================================================
  ;; MMX
  ;; ============================================================
  ;; The eight MMX registers live in i64 globals, not v128 ones, because that
  ;; is what the code we actually run wants. Across the two binaries that drive
  ;; this (Liquid War's blitter and SMACKW32's Smacker decoder) 222 of 236 and
  ;; 147 of 167 MMX instructions are whole-register moves, boolean ops and
  ;; 64-bit shifts -- all of which are one exact i64 instruction and would
  ;; otherwise pay a splat/extract round trip on every operation.
  ;;
  ;; The genuinely packed ops go the other way: they widen to v128, use the
  ;; real wasm SIMD instruction, and take lane 0 back. Those mappings are
  ;; exact, not approximations -- pmaddwd IS i32x4.dot_i16x8_s, paddusb IS
  ;; i8x16.add_sat_u, punpcklbw IS an i8x16.shuffle. Splatting means the upper
  ;; half computes the same result as the lower half and is discarded; that is
  ;; cheaper than masking and cannot introduce lane-crossing errors.
  ;;
  ;; Architecturally MMX aliases the x87 mantissas and any MMX write should
  ;; mark the FPU tag word full. We keep the two files separate: no guest mixes
  ;; MMX and x87 without an EMMS between them (that is the whole point of
  ;; EMMS), and $th_emms already clears the tag word.

  ;; ---- Register file ----
  (func $mmx_get (param $i i32) (result i64)
    (if (i32.eq (local.get $i) (i32.const 0)) (then (return (global.get $mm0))))
    (if (i32.eq (local.get $i) (i32.const 1)) (then (return (global.get $mm1))))
    (if (i32.eq (local.get $i) (i32.const 2)) (then (return (global.get $mm2))))
    (if (i32.eq (local.get $i) (i32.const 3)) (then (return (global.get $mm3))))
    (if (i32.eq (local.get $i) (i32.const 4)) (then (return (global.get $mm4))))
    (if (i32.eq (local.get $i) (i32.const 5)) (then (return (global.get $mm5))))
    (if (i32.eq (local.get $i) (i32.const 6)) (then (return (global.get $mm6))))
    (global.get $mm7))

  (func $mmx_set (param $i i32) (param $v i64)
    (if (i32.eq (local.get $i) (i32.const 0)) (then (global.set $mm0 (local.get $v)) (return)))
    (if (i32.eq (local.get $i) (i32.const 1)) (then (global.set $mm1 (local.get $v)) (return)))
    (if (i32.eq (local.get $i) (i32.const 2)) (then (global.set $mm2 (local.get $v)) (return)))
    (if (i32.eq (local.get $i) (i32.const 3)) (then (global.set $mm3 (local.get $v)) (return)))
    (if (i32.eq (local.get $i) (i32.const 4)) (then (global.set $mm4 (local.get $v)) (return)))
    (if (i32.eq (local.get $i) (i32.const 5)) (then (global.set $mm5 (local.get $v)) (return)))
    (if (i32.eq (local.get $i) (i32.const 6)) (then (global.set $mm6 (local.get $v)) (return)))
    (global.set $mm7 (local.get $v)))

  ;; ============================================================
  ;; SSE base used by SDL2
  ;; ============================================================
  ;; XMM state is kept as native v128 values. Guest memory still moves through
  ;; four $gl32/$gs32 accesses so page-edge, sparse-allocation, and DIB-backed
  ;; operands obey the same translation rules as scalar code.
  (func $xmm_lo_get (param $i i32) (result i64)
    (if (i32.eq (local.get $i) (i32.const 0)) (then (return (global.get $xmm0l))))
    (if (i32.eq (local.get $i) (i32.const 1)) (then (return (global.get $xmm1l))))
    (if (i32.eq (local.get $i) (i32.const 2)) (then (return (global.get $xmm2l))))
    (if (i32.eq (local.get $i) (i32.const 3)) (then (return (global.get $xmm3l))))
    (if (i32.eq (local.get $i) (i32.const 4)) (then (return (global.get $xmm4l))))
    (if (i32.eq (local.get $i) (i32.const 5)) (then (return (global.get $xmm5l))))
    (if (i32.eq (local.get $i) (i32.const 6)) (then (return (global.get $xmm6l))))
    (global.get $xmm7l))

  (func $xmm_hi_get (param $i i32) (result i64)
    (if (i32.eq (local.get $i) (i32.const 0)) (then (return (global.get $xmm0h))))
    (if (i32.eq (local.get $i) (i32.const 1)) (then (return (global.get $xmm1h))))
    (if (i32.eq (local.get $i) (i32.const 2)) (then (return (global.get $xmm2h))))
    (if (i32.eq (local.get $i) (i32.const 3)) (then (return (global.get $xmm3h))))
    (if (i32.eq (local.get $i) (i32.const 4)) (then (return (global.get $xmm4h))))
    (if (i32.eq (local.get $i) (i32.const 5)) (then (return (global.get $xmm5h))))
    (if (i32.eq (local.get $i) (i32.const 6)) (then (return (global.get $xmm6h))))
    (global.get $xmm7h))

  (func $xmm_get (param $i i32) (result v128)
    (i64x2.replace_lane 1
      (i64x2.splat (call $xmm_lo_get (local.get $i)))
      (call $xmm_hi_get (local.get $i))))

  (func $xmm_set (param $i i32) (param $v v128)
    (local $lo i64) (local $hi i64)
    (local.set $lo (i64x2.extract_lane 0 (local.get $v)))
    (local.set $hi (i64x2.extract_lane 1 (local.get $v)))
    (if (i32.eq (local.get $i) (i32.const 0)) (then (global.set $xmm0l (local.get $lo)) (global.set $xmm0h (local.get $hi)) (return)))
    (if (i32.eq (local.get $i) (i32.const 1)) (then (global.set $xmm1l (local.get $lo)) (global.set $xmm1h (local.get $hi)) (return)))
    (if (i32.eq (local.get $i) (i32.const 2)) (then (global.set $xmm2l (local.get $lo)) (global.set $xmm2h (local.get $hi)) (return)))
    (if (i32.eq (local.get $i) (i32.const 3)) (then (global.set $xmm3l (local.get $lo)) (global.set $xmm3h (local.get $hi)) (return)))
    (if (i32.eq (local.get $i) (i32.const 4)) (then (global.set $xmm4l (local.get $lo)) (global.set $xmm4h (local.get $hi)) (return)))
    (if (i32.eq (local.get $i) (i32.const 5)) (then (global.set $xmm5l (local.get $lo)) (global.set $xmm5h (local.get $hi)) (return)))
    (if (i32.eq (local.get $i) (i32.const 6)) (then (global.set $xmm6l (local.get $lo)) (global.set $xmm6h (local.get $hi)) (return)))
    (global.set $xmm7l (local.get $lo)) (global.set $xmm7h (local.get $hi)))

  (func $xmm_load128 (param $ga i32) (result v128)
    (i32x4.replace_lane 3
      (i32x4.replace_lane 2
        (i32x4.replace_lane 1
          (i32x4.replace_lane 0 (i32x4.splat (i32.const 0))
            (call $gl32 (local.get $ga)))
          (call $gl32 (i32.add (local.get $ga) (i32.const 4))))
        (call $gl32 (i32.add (local.get $ga) (i32.const 8))))
      (call $gl32 (i32.add (local.get $ga) (i32.const 12)))))

  (func $xmm_store128 (param $ga i32) (param $v v128)
    (call $gs32 (local.get $ga) (i32x4.extract_lane 0 (local.get $v)))
    (call $gs32 (i32.add (local.get $ga) (i32.const 4))
      (i32x4.extract_lane 1 (local.get $v)))
    (call $gs32 (i32.add (local.get $ga) (i32.const 8))
      (i32x4.extract_lane 2 (local.get $v)))
    (call $gs32 (i32.add (local.get $ga) (i32.const 12))
      (i32x4.extract_lane 3 (local.get $v))))

  (func $xmm_lane_get (param $v v128) (param $lane i32) (result i32)
    (if (i32.eq (local.get $lane) (i32.const 0))
      (then (return (i32x4.extract_lane 0 (local.get $v)))))
    (if (i32.eq (local.get $lane) (i32.const 1))
      (then (return (i32x4.extract_lane 1 (local.get $v)))))
    (if (i32.eq (local.get $lane) (i32.const 2))
      (then (return (i32x4.extract_lane 2 (local.get $v)))))
    (i32x4.extract_lane 3 (local.get $v)))

  ;; SHUFPS has a runtime immediate, while WebAssembly's native shuffle lane
  ;; indices are compile-time immediates. Build the four selected dwords with
  ;; static replace-lane instructions so all 256 guest masks remain exact.
  (func $sse_shufps (param $d v128) (param $s v128) (param $imm i32) (result v128)
    (i32x4.replace_lane 3
      (i32x4.replace_lane 2
        (i32x4.replace_lane 1
          (i32x4.replace_lane 0 (i32x4.splat (i32.const 0))
            (call $xmm_lane_get (local.get $d)
              (i32.and (local.get $imm) (i32.const 3))))
          (call $xmm_lane_get (local.get $d)
            (i32.and (i32.shr_u (local.get $imm) (i32.const 2)) (i32.const 3))))
        (call $xmm_lane_get (local.get $s)
          (i32.and (i32.shr_u (local.get $imm) (i32.const 4)) (i32.const 3))))
      (call $xmm_lane_get (local.get $s)
        (i32.and (i32.shr_u (local.get $imm) (i32.const 6)) (i32.const 3)))))

  ;; CVTT* converts with truncation toward zero and returns x86's integer
  ;; indefinite value for NaN or overflow. WebAssembly's saturating conversion
  ;; avoids a host trap; explicit bounds restore x86's high-overflow behavior.
  (func $sse_cvtt_f32_i32 (param $v f32) (result i32)
    (if (i32.or
          (f32.ne (local.get $v) (local.get $v))
          (i32.or
            (f32.ge (local.get $v) (f32.const 2147483648))
            (f32.lt (local.get $v) (f32.const -2147483648))))
      (then (return (i32.const 0x80000000))))
    (i32.trunc_sat_f32_s (local.get $v)))

  ;; sub=0 is a 128-bit move; sub=1 is XORPS; sub=2 is MOVSS; sub=3 is
  ;; UNPCKLPS; sub=4 is MOVLHPS (register source); sub=7 is SHUFPS, with its
  ;; imm8 in operand bits 16..23; sub=8/9 are ADDPS/MULPS.
  (func $th_sse_rr (param $op i32)
    (local $sub i32) (local $dst i32) (local $src i32)
    (local $d v128) (local $s v128) (local $v v128)
    (local.set $sub
      (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xFF)))
    (local.set $dst (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $src (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $d (call $xmm_get (local.get $dst)))
    (local.set $s (call $xmm_get (local.get $src)))
    (if (i32.eq (local.get $sub) (i32.const 5))
      (then
        (call $mmx_set (local.get $dst)
          (i64.or
            (i64.extend_i32_u
              (call $sse_cvtt_f32_i32 (f32x4.extract_lane 0 (local.get $s))))
            (i64.shl
              (i64.extend_i32_u
                (call $sse_cvtt_f32_i32 (f32x4.extract_lane 1 (local.get $s))))
              (i64.const 32))))
        (return_call $next)))
    (if (i32.eq (local.get $sub) (i32.const 6))
      (then
        (call $set_reg (local.get $dst)
          (call $sse_cvtt_f32_i32 (f32x4.extract_lane 0 (local.get $s))))
        (return_call $next)))
    (local.set $v (local.get $s))
    (if (i32.eq (local.get $sub) (i32.const 1))
      (then (local.set $v (v128.xor (local.get $d) (local.get $s)))))
    (if (i32.eq (local.get $sub) (i32.const 8))
      (then (local.set $v (f32x4.add (local.get $d) (local.get $s)))))
    (if (i32.eq (local.get $sub) (i32.const 9))
      (then (local.set $v (f32x4.mul (local.get $d) (local.get $s)))))
    (if (i32.eq (local.get $sub) (i32.const 2))
      (then (local.set $v (i32x4.replace_lane 0
        (local.get $d) (i32x4.extract_lane 0 (local.get $s))))))
    (if (i32.eq (local.get $sub) (i32.const 7))
      (then (local.set $v (call $sse_shufps
        (local.get $d) (local.get $s)
        (i32.and (i32.shr_u (local.get $op) (i32.const 16)) (i32.const 0xFF))))))
    (if (i32.eq (local.get $sub) (i32.const 3))
      (then (local.set $v
        (i32x4.replace_lane 3
          (i32x4.replace_lane 2
            (i32x4.replace_lane 1 (local.get $d)
              (i32x4.extract_lane 0 (local.get $s)))
            (i32x4.extract_lane 1 (local.get $d)))
          (i32x4.extract_lane 1 (local.get $s))))))
    (if (i32.eq (local.get $sub) (i32.const 4))
      (then (local.set $v
        (i32x4.replace_lane 3
          (i32x4.replace_lane 2 (local.get $d)
            (i32x4.extract_lane 0 (local.get $s)))
          (i32x4.extract_lane 1 (local.get $s))))))
    (call $xmm_set (local.get $dst) (local.get $v))
    (return_call $next))

  (func $th_sse_rm (param $op i32)
    (local $sub i32) (local $dst i32) (local $addr i32)
    (local $d v128) (local $s v128) (local $v v128)
    (local.set $sub
      (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xFF)))
    (local.set $dst (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $addr (call $read_addr))
    (local.set $d (call $xmm_get (local.get $dst)))
    (if (i32.eq (local.get $sub) (i32.const 5))
      (then
        (call $mmx_set (local.get $dst)
          (i64.or
            (i64.extend_i32_u
              (call $sse_cvtt_f32_i32
                (f32.reinterpret_i32 (call $gl32 (local.get $addr)))))
            (i64.shl
              (i64.extend_i32_u
                (call $sse_cvtt_f32_i32
                  (f32.reinterpret_i32
                    (call $gl32 (i32.add (local.get $addr) (i32.const 4))))))
              (i64.const 32))))
        (return_call $next)))
    (if (i32.eq (local.get $sub) (i32.const 6))
      (then
        (call $set_reg (local.get $dst)
          (call $sse_cvtt_f32_i32
            (f32.reinterpret_i32 (call $gl32 (local.get $addr)))))
        (return_call $next)))
    (if (i32.eq (local.get $sub) (i32.const 2))
      (then (local.set $v (i32x4.replace_lane 0
        (local.get $d) (call $gl32 (local.get $addr)))))
      (else
        (local.set $s (call $xmm_load128 (local.get $addr)))
        (local.set $v (local.get $s))
        (if (i32.eq (local.get $sub) (i32.const 7))
          (then (local.set $v (call $sse_shufps
            (local.get $d) (local.get $s)
            (i32.and (i32.shr_u (local.get $op) (i32.const 16)) (i32.const 0xFF))))))
        (if (i32.eq (local.get $sub) (i32.const 1))
          (then (local.set $v
            (v128.xor (local.get $d) (local.get $s)))))
        (if (i32.eq (local.get $sub) (i32.const 8))
          (then (local.set $v (f32x4.add (local.get $d) (local.get $s)))))
        (if (i32.eq (local.get $sub) (i32.const 9))
          (then (local.set $v (f32x4.mul (local.get $d) (local.get $s)))))
        (if (i32.eq (local.get $sub) (i32.const 3))
          (then (local.set $v
            (i32x4.replace_lane 3
              (i32x4.replace_lane 2
                (i32x4.replace_lane 1 (local.get $d)
                  (i32x4.extract_lane 0 (local.get $s)))
                (i32x4.extract_lane 1 (local.get $d)))
              (i32x4.extract_lane 1 (local.get $s))))))
        (if (i32.eq (local.get $sub) (i32.const 4))
          (then (local.set $v
            (i32x4.replace_lane 3
              (i32x4.replace_lane 2 (local.get $d)
                (i32x4.extract_lane 0 (local.get $s)))
              (i32x4.extract_lane 1 (local.get $s))))))))
    (call $xmm_set (local.get $dst) (local.get $v))
    (return_call $next))

  (func $th_sse_mr (param $op i32)
    (local $sub i32) (local $src i32) (local $addr i32) (local $v v128)
    (local.set $sub (i32.shr_u (local.get $op) (i32.const 8)))
    (local.set $src (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $v (call $xmm_get (local.get $src)))
    (local.set $addr (call $read_addr))
    (if (i32.eq (local.get $sub) (i32.const 2))
      (then (call $gs32 (local.get $addr) (i32x4.extract_lane 0 (local.get $v))))
      (else
        (if (i32.eq (local.get $sub) (i32.const 4))
          (then
            (call $gs32 (local.get $addr) (i32x4.extract_lane 2 (local.get $v)))
            (call $gs32 (i32.add (local.get $addr) (i32.const 4))
              (i32x4.extract_lane 3 (local.get $v))))
          (else (call $xmm_store128 (local.get $addr) (local.get $v))))))
    (return_call $next))

  ;; ---- Guest 64-bit access ----
  ;; Two 32-bit accesses rather than one i64.load on g2w: $gl32/$gs32 carry the
  ;; page-boundary and DIB-backing logic, and an MMX blitter reads straight out
  ;; of surfaces that use it.
  (func $mmx_load64 (param $ga i32) (result i64)
    (i64.or
      (i64.extend_i32_u (call $gl32 (local.get $ga)))
      (i64.shl (i64.extend_i32_u (call $gl32 (i32.add (local.get $ga) (i32.const 4))))
               (i64.const 32))))

  (func $mmx_store64 (param $ga i32) (param $v i64)
    (call $gs32 (local.get $ga) (i32.wrap_i64 (local.get $v)))
    (call $gs32 (i32.add (local.get $ga) (i32.const 4))
                (i32.wrap_i64 (i64.shr_u (local.get $v) (i64.const 32)))))

  ;; ---- Packed ops ----
  ;; $sub is the subop id assigned by $mmx_opcode_subop below. Whole-register
  ;; work stays in i64; anything lane-shaped widens to v128.
  ;;
  ;; The pack instructions all reduce two source halves to one, and wasm's
  ;; narrow_* puts the first operand's lanes in bytes 0..7 and the second's in
  ;; 8..15. Since both inputs are splatted, the four lanes we want from each
  ;; sit at bytes 0..3 and 8..11 -- hence the same shuffle for all three.
  (func $mmx_binop (param $a i64) (param $b i64) (param $sub i32) (result i64)
    (local $va v128) (local $vb v128)

    ;; --- whole-register, no lanes involved ---
    (if (i32.eq (local.get $sub) (i32.const 3))
      (then (return (i64.and (local.get $a) (local.get $b)))))
    (if (i32.eq (local.get $sub) (i32.const 4))     ;; pandn: ~dst & src
      (then (return (i64.and (i64.xor (local.get $a) (i64.const -1)) (local.get $b)))))
    (if (i32.eq (local.get $sub) (i32.const 5))
      (then (return (i64.or (local.get $a) (local.get $b)))))
    (if (i32.eq (local.get $sub) (i32.const 6))
      (then (return (i64.xor (local.get $a) (local.get $b)))))
    (if (i32.eq (local.get $sub) (i32.const 7))     ;; punpckldq
      (then (return (i64.or
              (i64.and (local.get $a) (i64.const 0xFFFFFFFF))
              (i64.shl (local.get $b) (i64.const 32))))))
    (if (i32.eq (local.get $sub) (i32.const 8))     ;; punpckhdq
      (then (return (i64.or
              (i64.shr_u (local.get $a) (i64.const 32))
              (i64.and (local.get $b) (i64.const -4294967296))))))  ;; 0xFFFFFFFF00000000

    (local.set $va (i64x2.splat (local.get $a)))
    (local.set $vb (i64x2.splat (local.get $b)))

    ;; --- interleave ---
    (if (i32.eq (local.get $sub) (i32.const 9))     ;; punpcklbw
      (then (return (i64x2.extract_lane 0 (i8x16.shuffle 0 16 1 17 2 18 3 19 0 0 0 0 0 0 0 0
              (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 10))    ;; punpckhbw
      (then (return (i64x2.extract_lane 0 (i8x16.shuffle 4 20 5 21 6 22 7 23 0 0 0 0 0 0 0 0
              (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 11))    ;; punpcklwd
      (then (return (i64x2.extract_lane 0 (i8x16.shuffle 0 1 16 17 2 3 18 19 0 0 0 0 0 0 0 0
              (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 12))    ;; punpckhwd
      (then (return (i64x2.extract_lane 0 (i8x16.shuffle 4 5 20 21 6 7 22 23 0 0 0 0 0 0 0 0
              (local.get $va) (local.get $vb))))))

    ;; --- pack with saturation ---
    (if (i32.eq (local.get $sub) (i32.const 13))    ;; packsswb
      (then (return (i64x2.extract_lane 0 (i8x16.shuffle 0 1 2 3 8 9 10 11 0 0 0 0 0 0 0 0
              (i8x16.narrow_i16x8_s (local.get $va) (local.get $vb))
              (i8x16.narrow_i16x8_s (local.get $va) (local.get $vb)))))))
    (if (i32.eq (local.get $sub) (i32.const 14))    ;; packssdw
      (then (return (i64x2.extract_lane 0 (i8x16.shuffle 0 1 2 3 8 9 10 11 0 0 0 0 0 0 0 0
              (i16x8.narrow_i32x4_s (local.get $va) (local.get $vb))
              (i16x8.narrow_i32x4_s (local.get $va) (local.get $vb)))))))
    (if (i32.eq (local.get $sub) (i32.const 15))    ;; packuswb
      (then (return (i64x2.extract_lane 0 (i8x16.shuffle 0 1 2 3 8 9 10 11 0 0 0 0 0 0 0 0
              (i8x16.narrow_i16x8_u (local.get $va) (local.get $vb))
              (i8x16.narrow_i16x8_u (local.get $va) (local.get $vb)))))))

    ;; --- multiply ---
    ;; pmaddwd is exactly i32x4.dot_i16x8_s: lanes 0 and 1 of the result are
    ;; a0*b0+a1*b1 and a2*b2+a3*b3, which is the whole 64-bit answer.
    (if (i32.eq (local.get $sub) (i32.const 16))
      (then (return (i64x2.extract_lane 0 (i32x4.dot_i16x8_s (local.get $va) (local.get $vb))))))
    ;; pmulhw/pmulhuw: widen to 32-bit products, then keep the high half of
    ;; each -- bytes 2,3 of every dword.
    (if (i32.eq (local.get $sub) (i32.const 17))
      (then (return (i64x2.extract_lane 0 (i8x16.shuffle 2 3 6 7 10 11 14 15 0 0 0 0 0 0 0 0
              (i32x4.extmul_low_i16x8_s (local.get $va) (local.get $vb))
              (i32x4.extmul_low_i16x8_s (local.get $va) (local.get $vb)))))))
    (if (i32.eq (local.get $sub) (i32.const 18))
      (then (return (i64x2.extract_lane 0 (i8x16.shuffle 2 3 6 7 10 11 14 15 0 0 0 0 0 0 0 0
              (i32x4.extmul_low_i16x8_u (local.get $va) (local.get $vb))
              (i32x4.extmul_low_i16x8_u (local.get $va) (local.get $vb)))))))
    (if (i32.eq (local.get $sub) (i32.const 19))    ;; pmullw
      (then (return (i64x2.extract_lane 0 (i16x8.mul (local.get $va) (local.get $vb))))))

    ;; --- elementwise, 32 + kind*4 + width ---
    (if (i32.eq (local.get $sub) (i32.const 32)) (then (return (i64x2.extract_lane 0 (i8x16.add (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 33)) (then (return (i64x2.extract_lane 0 (i16x8.add (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 34)) (then (return (i64x2.extract_lane 0 (i32x4.add (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 35)) (then (return (i64.add (local.get $a) (local.get $b)))))
    (if (i32.eq (local.get $sub) (i32.const 36)) (then (return (i64x2.extract_lane 0 (i8x16.sub (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 37)) (then (return (i64x2.extract_lane 0 (i16x8.sub (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 38)) (then (return (i64x2.extract_lane 0 (i32x4.sub (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 39)) (then (return (i64.sub (local.get $a) (local.get $b)))))
    (if (i32.eq (local.get $sub) (i32.const 40)) (then (return (i64x2.extract_lane 0 (i8x16.add_sat_s (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 41)) (then (return (i64x2.extract_lane 0 (i16x8.add_sat_s (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 44)) (then (return (i64x2.extract_lane 0 (i8x16.sub_sat_s (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 45)) (then (return (i64x2.extract_lane 0 (i16x8.sub_sat_s (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 48)) (then (return (i64x2.extract_lane 0 (i8x16.add_sat_u (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 49)) (then (return (i64x2.extract_lane 0 (i16x8.add_sat_u (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 52)) (then (return (i64x2.extract_lane 0 (i8x16.sub_sat_u (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 53)) (then (return (i64x2.extract_lane 0 (i16x8.sub_sat_u (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 56)) (then (return (i64x2.extract_lane 0 (i8x16.eq (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 57)) (then (return (i64x2.extract_lane 0 (i16x8.eq (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 58)) (then (return (i64x2.extract_lane 0 (i32x4.eq (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 60)) (then (return (i64x2.extract_lane 0 (i8x16.gt_s (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 61)) (then (return (i64x2.extract_lane 0 (i16x8.gt_s (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 62)) (then (return (i64x2.extract_lane 0 (i32x4.gt_s (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 64)) (then (return (i64x2.extract_lane 0 (i8x16.min_u (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 68)) (then (return (i64x2.extract_lane 0 (i8x16.max_u (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 73)) (then (return (i64x2.extract_lane 0 (i16x8.min_s (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 77)) (then (return (i64x2.extract_lane 0 (i16x8.max_s (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 80)) (then (return (i64x2.extract_lane 0 (i8x16.avgr_u (local.get $va) (local.get $vb))))))
    (if (i32.eq (local.get $sub) (i32.const 81)) (then (return (i64x2.extract_lane 0 (i16x8.avgr_u (local.get $va) (local.get $vb))))))

    ;; Shifts (128 + dir*4 + width). The count is the whole second operand, not
    ;; a lane value, and x86 flushes to zero (or to all sign bits for an
    ;; arithmetic shift) once it is wider than the lane. wasm instead takes the
    ;; count modulo the lane width, so an unguarded psrlw mm0, 32 would shift
    ;; by 0 and return the input untouched.
    (if (i32.ge_u (local.get $sub) (i32.const 128))
      (then (return (call $mmx_shift (local.get $a) (local.get $b) (local.get $sub)))))

    ;; Unreachable: the decoder only emits subops listed above.
    (call $host_log_i32 (i32.or (i32.const 0x0FD00000) (local.get $sub)))
    (unreachable))

  ;; Shift by a variable (or immediate) count, with x86 out-of-range behaviour.
  (func $mmx_shift (param $a i64) (param $cnt i64) (param $sub i32) (result i64)
    (local $n i32) (local $w i32) (local $dir i32) (local $max i32)
    (local $va v128)
    (local.set $dir (i32.div_u (i32.sub (local.get $sub) (i32.const 128)) (i32.const 4)))
    (local.set $w (i32.and (local.get $sub) (i32.const 3)))
    ;; Lane width in bits: w=1 -> 16, w=2 -> 32, w=3 -> 64.
    (local.set $max (i32.shl (i32.const 8) (local.get $w)))
    ;; A count of 2^32 or more is out of range for every width; clamping to the
    ;; width itself keeps the comparisons below in i32.
    (local.set $n (select (i32.const 255) (i32.wrap_i64 (local.get $cnt))
                    (i64.gt_u (local.get $cnt) (i64.const 255))))

    (if (i32.ge_u (local.get $n) (local.get $max))
      (then
        ;; Out of range: logical shifts produce zero, arithmetic replicates the
        ;; sign bit, which is the same as shifting by width-1.
        (if (i32.ne (local.get $dir) (i32.const 2))
          (then (return (i64.const 0))))
        (local.set $n (i32.sub (local.get $max) (i32.const 1)))))

    (if (i32.eq (local.get $w) (i32.const 3))
      (then
        ;; 64-bit shifts have no lane structure -- plain i64.
        (if (i32.eq (local.get $dir) (i32.const 0))
          (then (return (i64.shl (local.get $a) (i64.extend_i32_u (local.get $n))))))
        (if (i32.eq (local.get $dir) (i32.const 1))
          (then (return (i64.shr_u (local.get $a) (i64.extend_i32_u (local.get $n))))))
        (return (i64.shr_s (local.get $a) (i64.extend_i32_u (local.get $n))))))

    (local.set $va (i64x2.splat (local.get $a)))
    (if (i32.eq (local.get $w) (i32.const 1))
      (then
        (if (i32.eq (local.get $dir) (i32.const 0))
          (then (return (i64x2.extract_lane 0 (i16x8.shl (local.get $va) (local.get $n))))))
        (if (i32.eq (local.get $dir) (i32.const 1))
          (then (return (i64x2.extract_lane 0 (i16x8.shr_u (local.get $va) (local.get $n))))))
        (return (i64x2.extract_lane 0 (i16x8.shr_s (local.get $va) (local.get $n))))))
    (if (i32.eq (local.get $dir) (i32.const 0))
      (then (return (i64x2.extract_lane 0 (i32x4.shl (local.get $va) (local.get $n))))))
    (if (i32.eq (local.get $dir) (i32.const 1))
      (then (return (i64x2.extract_lane 0 (i32x4.shr_u (local.get $va) (local.get $n))))))
    (i64x2.extract_lane 0 (i32x4.shr_s (local.get $va) (local.get $n))))

  ;; ---- Threaded handlers ----
  ;; 407: mm, mm      op = sub<<8 | dst<<4 | src
  ;; 408: mm, m       op = sub<<8 | dst<<4        ; address word follows
  ;; 409: m, mm       op = sub<<8 | src<<4        ; address word follows
  ;; 410: mm, imm8    op = sub<<12 | dst<<8 | imm8

  (func $th_mmx_rr (param $op i32)
    (local $sub i32) (local $dst i32) (local $src i32)
    (global.set $mmx_exec_count (i32.add (global.get $mmx_exec_count) (i32.const 1)))
    (local.set $sub (i32.shr_u (local.get $op) (i32.const 8)))
    (local.set $dst (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $src (i32.and (local.get $op) (i32.const 0xF)))
    ;; movq mm, mm
    (if (i32.eqz (local.get $sub))
      (then (call $mmx_set (local.get $dst) (call $mmx_get (local.get $src))) (return_call $next)))
    ;; movd mm, r32 -- src names a general register, not an MMX one.
    (if (i32.eq (local.get $sub) (i32.const 1))
      (then (call $mmx_set (local.get $dst)
              (i64.extend_i32_u (call $get_reg (local.get $src))))
            (return_call $next)))
    ;; movd r32, mm -- dst names a general register.
    (if (i32.eq (local.get $sub) (i32.const 2))
      (then (call $set_reg (local.get $dst)
              (i32.wrap_i64 (call $mmx_get (local.get $src))))
            (return_call $next)))
    ;; pmovmskb r32, mm -- the sign bits of the eight bytes.
    (if (i32.eq (local.get $sub) (i32.const 20))
      (then (call $set_reg (local.get $dst)
              (i32.and (i8x16.bitmask (i64x2.splat (call $mmx_get (local.get $src))))
                       (i32.const 0xFF)))
            (return_call $next)))
    (call $mmx_set (local.get $dst)
      (call $mmx_binop (call $mmx_get (local.get $dst)) (call $mmx_get (local.get $src))
            (local.get $sub)))
    (return_call $next))

  (func $th_mmx_rm (param $op i32)
    (local $sub i32) (local $dst i32) (local $addr i32)
    (global.set $mmx_exec_count (i32.add (global.get $mmx_exec_count) (i32.const 1)))
    (local.set $sub (i32.shr_u (local.get $op) (i32.const 8)))
    (local.set $dst (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $addr (call $read_addr))
    (if (i32.eqz (local.get $sub))
      (then (call $mmx_set (local.get $dst) (call $mmx_load64 (local.get $addr)))
            (return_call $next)))
    (if (i32.eq (local.get $sub) (i32.const 1))     ;; movd mm, m32
      (then (call $mmx_set (local.get $dst)
              (i64.extend_i32_u (call $gl32 (local.get $addr))))
            (return_call $next)))
    (call $mmx_set (local.get $dst)
      (call $mmx_binop (call $mmx_get (local.get $dst)) (call $mmx_load64 (local.get $addr))
            (local.get $sub)))
    (return_call $next))

  (func $th_mmx_mr (param $op i32)
    (local $sub i32) (local $src i32) (local $addr i32)
    (global.set $mmx_exec_count (i32.add (global.get $mmx_exec_count) (i32.const 1)))
    (local.set $sub (i32.shr_u (local.get $op) (i32.const 8)))
    (local.set $src (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $addr (call $read_addr))
    (if (i32.eq (local.get $sub) (i32.const 2))     ;; movd m32, mm
      (then (call $gs32 (local.get $addr) (i32.wrap_i64 (call $mmx_get (local.get $src))))
            (return_call $next)))
    (call $mmx_store64 (local.get $addr) (call $mmx_get (local.get $src)))
    (return_call $next))

  (func $th_mmx_ri (param $op i32)
    (local $sub i32) (local $dst i32)
    (global.set $mmx_exec_count (i32.add (global.get $mmx_exec_count) (i32.const 1)))
    (local.set $sub (i32.shr_u (local.get $op) (i32.const 12)))
    (local.set $dst (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (call $mmx_set (local.get $dst)
      (call $mmx_binop (call $mmx_get (local.get $dst))
            (i64.extend_i32_u (i32.and (local.get $op) (i32.const 0xFF)))
            (local.get $sub)))
    (return_call $next))

  ;; ---- Decoder support ----
  ;; Map a second opcode byte to a subop, or -1 when it is not an MMX
  ;; instruction we implement. Called by $decode_block before it consumes the
  ;; ModRM byte, so it must decide purely from the opcode.
  ;;
  ;; Prefixed forms (66/F2/F3 before 0F) are the xmm variants and are NOT MMX;
  ;; the caller rejects them and lets the unknown-0F trap report them, which is
  ;; the honest outcome while CPUID advertises MMX but not SSE.
  (func $mmx_opcode_subop (param $op i32) (result i32)
    ;; 0x60-0x6B: interleave and pack
    (if (i32.eq (local.get $op) (i32.const 0x60)) (then (return (i32.const 9))))   ;; punpcklbw
    (if (i32.eq (local.get $op) (i32.const 0x61)) (then (return (i32.const 11))))  ;; punpcklwd
    (if (i32.eq (local.get $op) (i32.const 0x62)) (then (return (i32.const 7))))   ;; punpckldq
    (if (i32.eq (local.get $op) (i32.const 0x63)) (then (return (i32.const 13))))  ;; packsswb
    (if (i32.eq (local.get $op) (i32.const 0x64)) (then (return (i32.const 60))))  ;; pcmpgtb
    (if (i32.eq (local.get $op) (i32.const 0x65)) (then (return (i32.const 61))))  ;; pcmpgtw
    (if (i32.eq (local.get $op) (i32.const 0x66)) (then (return (i32.const 62))))  ;; pcmpgtd
    (if (i32.eq (local.get $op) (i32.const 0x67)) (then (return (i32.const 15))))  ;; packuswb
    (if (i32.eq (local.get $op) (i32.const 0x68)) (then (return (i32.const 10))))  ;; punpckhbw
    (if (i32.eq (local.get $op) (i32.const 0x69)) (then (return (i32.const 12))))  ;; punpckhwd
    (if (i32.eq (local.get $op) (i32.const 0x6A)) (then (return (i32.const 8))))   ;; punpckhdq
    (if (i32.eq (local.get $op) (i32.const 0x6B)) (then (return (i32.const 14))))  ;; packssdw
    (if (i32.eq (local.get $op) (i32.const 0x6E)) (then (return (i32.const 1))))   ;; movd mm, r/m32
    (if (i32.eq (local.get $op) (i32.const 0x6F)) (then (return (i32.const 0))))   ;; movq mm, mm/m64
    ;; 0x74-0x76: compare equal
    (if (i32.eq (local.get $op) (i32.const 0x74)) (then (return (i32.const 56))))
    (if (i32.eq (local.get $op) (i32.const 0x75)) (then (return (i32.const 57))))
    (if (i32.eq (local.get $op) (i32.const 0x76)) (then (return (i32.const 58))))
    (if (i32.eq (local.get $op) (i32.const 0x7E)) (then (return (i32.const 2))))   ;; movd r/m32, mm
    (if (i32.eq (local.get $op) (i32.const 0x7F)) (then (return (i32.const 0))))   ;; movq mm/m64, mm
    ;; 0xD1-0xD3: shift right logical by mm/m64
    (if (i32.eq (local.get $op) (i32.const 0xD1)) (then (return (i32.const 133))))
    (if (i32.eq (local.get $op) (i32.const 0xD2)) (then (return (i32.const 134))))
    (if (i32.eq (local.get $op) (i32.const 0xD3)) (then (return (i32.const 135))))
    (if (i32.eq (local.get $op) (i32.const 0xD4)) (then (return (i32.const 35))))  ;; paddq
    (if (i32.eq (local.get $op) (i32.const 0xD5)) (then (return (i32.const 19))))  ;; pmullw
    (if (i32.eq (local.get $op) (i32.const 0xD7)) (then (return (i32.const 20))))  ;; pmovmskb
    (if (i32.eq (local.get $op) (i32.const 0xD8)) (then (return (i32.const 52))))  ;; psubusb
    (if (i32.eq (local.get $op) (i32.const 0xD9)) (then (return (i32.const 53))))  ;; psubusw
    (if (i32.eq (local.get $op) (i32.const 0xDA)) (then (return (i32.const 64))))  ;; pminub
    (if (i32.eq (local.get $op) (i32.const 0xDB)) (then (return (i32.const 3))))   ;; pand
    (if (i32.eq (local.get $op) (i32.const 0xDC)) (then (return (i32.const 48))))  ;; paddusb
    (if (i32.eq (local.get $op) (i32.const 0xDD)) (then (return (i32.const 49))))  ;; paddusw
    (if (i32.eq (local.get $op) (i32.const 0xDE)) (then (return (i32.const 68))))  ;; pmaxub
    (if (i32.eq (local.get $op) (i32.const 0xDF)) (then (return (i32.const 4))))   ;; pandn
    (if (i32.eq (local.get $op) (i32.const 0xE0)) (then (return (i32.const 80))))  ;; pavgb
    (if (i32.eq (local.get $op) (i32.const 0xE1)) (then (return (i32.const 137)))) ;; psraw
    (if (i32.eq (local.get $op) (i32.const 0xE2)) (then (return (i32.const 138)))) ;; psrad
    (if (i32.eq (local.get $op) (i32.const 0xE3)) (then (return (i32.const 81))))  ;; pavgw
    (if (i32.eq (local.get $op) (i32.const 0xE4)) (then (return (i32.const 18))))  ;; pmulhuw
    (if (i32.eq (local.get $op) (i32.const 0xE5)) (then (return (i32.const 17))))  ;; pmulhw
    (if (i32.eq (local.get $op) (i32.const 0xE8)) (then (return (i32.const 44))))  ;; psubsb
    (if (i32.eq (local.get $op) (i32.const 0xE9)) (then (return (i32.const 45))))  ;; psubsw
    (if (i32.eq (local.get $op) (i32.const 0xEA)) (then (return (i32.const 73))))  ;; pminsw
    (if (i32.eq (local.get $op) (i32.const 0xEB)) (then (return (i32.const 5))))   ;; por
    (if (i32.eq (local.get $op) (i32.const 0xEC)) (then (return (i32.const 40))))  ;; paddsb
    (if (i32.eq (local.get $op) (i32.const 0xED)) (then (return (i32.const 41))))  ;; paddsw
    (if (i32.eq (local.get $op) (i32.const 0xEE)) (then (return (i32.const 77))))  ;; pmaxsw
    (if (i32.eq (local.get $op) (i32.const 0xEF)) (then (return (i32.const 6))))   ;; pxor
    ;; 0xF1-0xF3: shift left logical by mm/m64
    (if (i32.eq (local.get $op) (i32.const 0xF1)) (then (return (i32.const 129))))
    (if (i32.eq (local.get $op) (i32.const 0xF2)) (then (return (i32.const 130))))
    (if (i32.eq (local.get $op) (i32.const 0xF3)) (then (return (i32.const 131))))
    (if (i32.eq (local.get $op) (i32.const 0xF5)) (then (return (i32.const 16))))  ;; pmaddwd
    (if (i32.eq (local.get $op) (i32.const 0xF8)) (then (return (i32.const 36))))  ;; psubb
    (if (i32.eq (local.get $op) (i32.const 0xF9)) (then (return (i32.const 37))))  ;; psubw
    (if (i32.eq (local.get $op) (i32.const 0xFA)) (then (return (i32.const 38))))  ;; psubd
    (if (i32.eq (local.get $op) (i32.const 0xFB)) (then (return (i32.const 39))))  ;; psubq
    (if (i32.eq (local.get $op) (i32.const 0xFC)) (then (return (i32.const 32))))  ;; paddb
    (if (i32.eq (local.get $op) (i32.const 0xFD)) (then (return (i32.const 33))))  ;; paddw
    (if (i32.eq (local.get $op) (i32.const 0xFE)) (then (return (i32.const 34))))  ;; paddd
    (i32.const -1))

  ;; 0x0F 0x71/0x72/0x73 select the shift by the ModRM reg field and take an
  ;; imm8. Width comes from the opcode: 0x71 word, 0x72 dword, 0x73 qword.
  (func $mmx_group_subop (param $op i32) (param $reg i32) (result i32)
    (local $w i32)
    (local.set $w (i32.sub (local.get $op) (i32.const 0x70)))
    (if (i32.eq (local.get $reg) (i32.const 2))     ;; psrl
      (then (return (i32.add (i32.const 132) (local.get $w)))))
    (if (i32.eq (local.get $reg) (i32.const 6))     ;; psll
      (then (return (i32.add (i32.const 128) (local.get $w)))))
    (if (i32.eq (local.get $reg) (i32.const 4))     ;; psra -- no qword form
      (then
        (if (i32.eq (local.get $w) (i32.const 3)) (then (return (i32.const -1))))
        (return (i32.add (i32.const 136) (local.get $w)))))
    (i32.const -1))
