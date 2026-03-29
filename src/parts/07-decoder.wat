  ;; ============================================================
  ;; x86 DECODER — Full i486 with ModR/M + SIB
  ;; ============================================================

  ;; Decode ModR/M + optional SIB + displacement.
  ;; Returns the effective address as a guest virtual address.
  ;; Advances $d_pc (decoder PC, guest addr).
  ;; $d_pc is a global used during decoding.
  (global $d_pc (mut i32) (i32.const 0))

  ;; Read next byte from guest at d_pc, advance d_pc
  (func $d_fetch8 (result i32)
    (local $v i32)
    (local.set $v (call $gl8 (global.get $d_pc)))
    (global.set $d_pc (i32.add (global.get $d_pc) (i32.const 1)))
    (local.get $v))
  (func $d_fetch16 (result i32)
    (local $v i32)
    (local.set $v (call $gl16 (global.get $d_pc)))
    (global.set $d_pc (i32.add (global.get $d_pc) (i32.const 2)))
    (local.get $v))
  (func $d_fetch32 (result i32)
    (local $v i32)
    (local.set $v (call $gl32 (global.get $d_pc)))
    (global.set $d_pc (i32.add (global.get $d_pc) (i32.const 4)))
    (local.get $v))
  (func $sign_ext8 (param $v i32) (result i32)
    (if (result i32) (i32.ge_u (local.get $v) (i32.const 0x80))
      (then (i32.or (local.get $v) (i32.const 0xFFFFFF00)))
      (else (local.get $v))))
  (func $sign_ext16 (param $v i32) (result i32)
    (if (result i32) (i32.ge_u (local.get $v) (i32.const 0x8000))
      (then (i32.or (local.get $v) (i32.const 0xFFFF0000)))
      (else (local.get $v))))

  ;; Decode SIB byte and return base+index*scale
  (func $decode_sib (param $mod i32) (result i32)
    (local $sib i32) (local $scale i32) (local $index i32) (local $base i32) (local $addr i32)
    (local.set $sib (call $d_fetch8))
    (local.set $scale (i32.shr_u (local.get $sib) (i32.const 6)))
    (local.set $index (i32.and (i32.shr_u (local.get $sib) (i32.const 3)) (i32.const 7)))
    (local.set $base (i32.and (local.get $sib) (i32.const 7)))
    ;; Base
    (if (i32.and (i32.eq (local.get $base) (i32.const 5)) (i32.eq (local.get $mod) (i32.const 0)))
      (then (local.set $addr (call $d_fetch32))) ;; disp32, no base
      (else (local.set $addr (call $get_reg (local.get $base)))))
    ;; Index (4 = no index)
    (if (i32.ne (local.get $index) (i32.const 4))
      (then (local.set $addr (i32.add (local.get $addr)
        (i32.shl (call $get_reg (local.get $index)) (local.get $scale))))))
    (local.get $addr))

  ;; Decode ModR/M — returns addressing mode info for RUNTIME resolution.
  ;; For mod=11: mr_val = rm register index
  ;; For mod!=11: mr_base = base reg (-1 if none), mr_disp = displacement,
  ;;   mr_index = index reg (-1 if none), mr_scale = SIB scale
  ;; The caller must emit thread ops that compute addr at runtime.
  (global $mr_mod   (mut i32) (i32.const 0))
  (global $mr_reg   (mut i32) (i32.const 0))
  (global $mr_val   (mut i32) (i32.const 0))  ;; rm register index (mod=11 only)
  (global $mr_base  (mut i32) (i32.const -1)) ;; base register (-1=none)
  (global $mr_disp  (mut i32) (i32.const 0))  ;; displacement
  (global $mr_index (mut i32) (i32.const -1)) ;; SIB index register (-1=none)
  (global $mr_scale (mut i32) (i32.const 0))  ;; SIB scale (0-3)

  (func $decode_modrm
    (local $modrm i32) (local $mod i32) (local $rm i32)
    (local $sib i32)
    (global.set $mr_base (i32.const -1))
    (global.set $mr_disp (i32.const 0))
    (global.set $mr_index (i32.const -1))
    (global.set $mr_scale (i32.const 0))

    (local.set $modrm (call $d_fetch8))
    (local.set $mod (i32.shr_u (local.get $modrm) (i32.const 6)))
    (global.set $mr_reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
    (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
    (global.set $mr_mod (local.get $mod))

    ;; mod=11: register direct
    (if (i32.eq (local.get $mod) (i32.const 3))
      (then (global.set $mr_val (local.get $rm)) (return)))

    ;; mod=00
    (if (i32.eq (local.get $mod) (i32.const 0))
      (then
        (if (i32.eq (local.get $rm) (i32.const 4)) ;; SIB
          (then (call $decode_sib_info (i32.const 0)) (return)))
        (if (i32.eq (local.get $rm) (i32.const 5)) ;; disp32 only
          (then (global.set $mr_disp (call $d_fetch32)) (return)))
        ;; [reg] only
        (global.set $mr_base (local.get $rm))
        (return)))

    ;; mod=01: [rm + disp8]
    (if (i32.eq (local.get $mod) (i32.const 1))
      (then
        (if (i32.eq (local.get $rm) (i32.const 4))
          (then (call $decode_sib_info (i32.const 1)))
          (else (global.set $mr_base (local.get $rm))))
        (global.set $mr_disp (i32.add (global.get $mr_disp) (call $sign_ext8 (call $d_fetch8))))
        (return)))

    ;; mod=10: [rm + disp32]
    (if (i32.eq (local.get $rm) (i32.const 4))
      (then (call $decode_sib_info (i32.const 2)))
      (else (global.set $mr_base (local.get $rm))))
    (global.set $mr_disp (i32.add (global.get $mr_disp) (call $d_fetch32)))
  )

  ;; Apply FS segment override to mr_disp (call after decode_modrm when mr_mod != 3)
  (func $apply_seg_override
    (if (i32.eq (global.get $d_seg) (i32.const 5))
      (then (global.set $mr_disp (i32.add (global.get $mr_disp) (global.get $fs_base))))))

  ;; Decode SIB, store base/index/scale info (not resolved)
  (func $decode_sib_info (param $mod i32)
    (local $sib i32) (local $base i32) (local $index i32)
    (local.set $sib (call $d_fetch8))
    (global.set $mr_scale (i32.shr_u (local.get $sib) (i32.const 6)))
    (local.set $index (i32.and (i32.shr_u (local.get $sib) (i32.const 3)) (i32.const 7)))
    (local.set $base (i32.and (local.get $sib) (i32.const 7)))
    ;; Index 4 means no index
    (if (i32.ne (local.get $index) (i32.const 4))
      (then (global.set $mr_index (local.get $index))))
    ;; Base 5 with mod=0 means disp32 only
    (if (i32.and (i32.eq (local.get $base) (i32.const 5)) (i32.eq (local.get $mod) (i32.const 0)))
      (then (global.set $mr_disp (call $d_fetch32)))
      (else (global.set $mr_base (local.get $base)))))

  ;; Emit SIB EA compute prefix if needed, then return the address word to emit.
  ;; If SIB: emits compute_ea_sib handler and returns sentinel 0xEADEAD.
  ;; If absolute: returns mr_disp directly.
  (func $emit_sib_or_abs (result i32)
    (if (i32.ne (global.get $mr_index) (i32.const -1))
      (then
        (call $te (i32.const 149) (i32.const 0))
        (call $te_raw (i32.or
          (if (result i32) (i32.ne (global.get $mr_base) (i32.const -1))
            (then (global.get $mr_base)) (else (i32.const 0xF)))
          (i32.or (i32.shl (global.get $mr_index) (i32.const 4))
                  (i32.shl (global.get $mr_scale) (i32.const 8)))))
        (call $te_raw (global.get $mr_disp))
        (return (i32.const 0xEADEAD))))
    (global.get $mr_disp))

  ;;
  ;; Simplest approach: add a $mr_ea_to_thread function that emits ops to
  ;; compute the address into a specific register or thread-word sequence.
  ;; For the common case [reg+disp], emit the (reg<<4|0, disp) operands directly.
  ;; For [disp32] (no base), emit (addr) directly.
  ;; For SIB with index, we need a more complex approach.
  ;;
  ;; Let's handle the common cases and fall back for complex SIB.

  ;; ============================================================
  ;; EMIT HELPERS — emit thread ops for memory access with runtime EA
  ;; ============================================================
  ;; After decode_modrm, mr_base/mr_disp/mr_index/mr_scale describe the EA.
  ;; These helpers emit the correct handler ops based on the addressing mode.

  ;; Helper: has base reg, no SIB index?
  (func $mr_simple_base (result i32)
    (i32.and (i32.ne (global.get $mr_base) (i32.const -1)) (i32.eq (global.get $mr_index) (i32.const -1))))
  ;; Helper: absolute address (no base, no index)?
  (func $mr_absolute (result i32)
    (i32.and (i32.eq (global.get $mr_base) (i32.const -1)) (i32.eq (global.get $mr_index) (i32.const -1))))

  (func $emit_load32 (param $dst i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 26) (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 20) (local.get $dst)) (call $te_raw (local.get $a)))

  (func $emit_store32 (param $src i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 27) (i32.or (i32.shl (local.get $src) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 21) (local.get $src)) (call $te_raw (local.get $a)))

  (func $emit_load8 (param $dst i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 28) (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 24) (local.get $dst)) (call $te_raw (local.get $a)))

  (func $emit_store8 (param $src i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 29) (i32.or (i32.shl (local.get $src) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 25) (local.get $src)) (call $te_raw (local.get $a)))

  (func $emit_lea (param $dst i32)
    ;; LEA computes address without memory access
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then
        (if (i32.eqz (global.get $mr_disp))
          (then (call $te (i32.const 11) (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base))))
          (else ;; dst = base + disp (runtime). Use th_lea_ro (handler 126)
            (call $te (i32.const 126) (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp))))
        (return)))
    ;; SIB with index: use th_lea_sib (handler 148)
    (if (i32.ne (global.get $mr_index) (i32.const -1))
      (then
        (call $te (i32.const 148) (local.get $dst))
        ;; Encode: base (0xF if none) | index<<4 | scale<<8
        (call $te_raw (i32.or
          (if (result i32) (i32.ne (global.get $mr_base) (i32.const -1))
            (then (global.get $mr_base)) (else (i32.const 0xF)))
          (i32.or (i32.shl (global.get $mr_index) (i32.const 4))
                  (i32.shl (global.get $mr_scale) (i32.const 8)))))
        (call $te_raw (global.get $mr_disp))
        (return)))
    ;; Absolute: LEA reg, [const] = MOV reg, const
    (call $te (i32.const 2) (local.get $dst)) (call $te_raw (global.get $mr_disp)))

  ;; ALU [mem] OP= reg (runtime address)
  (func $emit_alu_m32_r (param $alu_op i32) (param $reg i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 127) (i32.or (i32.shl (local.get $alu_op) (i32.const 8))
          (i32.or (i32.shl (local.get $reg) (i32.const 4)) (global.get $mr_base))))
        (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 47) (i32.or (i32.shl (local.get $alu_op) (i32.const 4)) (local.get $reg)))
    (call $te_raw (local.get $a)))

  (func $emit_alu_r_m32 (param $alu_op i32) (param $reg i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 128) (i32.or (i32.shl (local.get $alu_op) (i32.const 8))
          (i32.or (i32.shl (local.get $reg) (i32.const 4)) (global.get $mr_base))))
        (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 48) (i32.or (i32.shl (local.get $alu_op) (i32.const 4)) (local.get $reg)))
    (call $te_raw (local.get $a)))

  (func $emit_alu_m8_r (param $alu_op i32) (param $reg i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 129) (i32.or (i32.shl (local.get $alu_op) (i32.const 8))
              (i32.or (i32.shl (local.get $reg) (i32.const 4)) (global.get $mr_base))))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 49) (i32.or (i32.shl (local.get $alu_op) (i32.const 4)) (local.get $reg)))
    (call $te_raw (local.get $a)))

  (func $emit_alu_r_m8 (param $alu_op i32) (param $reg i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 130) (i32.or (i32.shl (local.get $alu_op) (i32.const 8))
              (i32.or (i32.shl (local.get $reg) (i32.const 4)) (global.get $mr_base))))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 50) (i32.or (i32.shl (local.get $alu_op) (i32.const 4)) (local.get $reg)))
    (call $te_raw (local.get $a)))

  ;; ALU [mem] OP= imm
  (func $emit_alu_m16_i (param $alu_op i32) (param $imm i32) (local $a i32)
    ;; 16-bit ALU [mem], imm16 — use handler 122 (th_alu_m16_i16)
    ;; For base+disp, fall through to 32-bit (TODO: proper 16-bit handler)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 131) (i32.or (i32.shl (local.get $alu_op) (i32.const 8)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $imm)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 122) (local.get $alu_op))
    (call $te_raw (local.get $a)) (call $te_raw (local.get $imm)))
  ;; 16-bit: r16 OP= [mem]
  (func $emit_alu_r16_m16 (param $alu_op i32) (param $reg i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 161) (i32.or (i32.shl (local.get $alu_op) (i32.const 8))
              (i32.or (i32.shl (local.get $reg) (i32.const 4)) (global.get $mr_base))))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 159) (i32.or (i32.shl (local.get $alu_op) (i32.const 4)) (local.get $reg)))
    (call $te_raw (local.get $a)))
  ;; 16-bit: [mem] OP= r16
  (func $emit_alu_m16_r16 (param $alu_op i32) (param $reg i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 162) (i32.or (i32.shl (local.get $alu_op) (i32.const 8))
              (i32.or (i32.shl (local.get $reg) (i32.const 4)) (global.get $mr_base))))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 160) (i32.or (i32.shl (local.get $alu_op) (i32.const 4)) (local.get $reg)))
    (call $te_raw (local.get $a)))
  ;; 16-bit: MOV r16, [mem]
  (func $emit_load16 (param $dst i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 166) (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 164) (local.get $dst)) (call $te_raw (local.get $a)))
  ;; 16-bit: MOV [mem], r16
  (func $emit_store16 (param $src i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 165) (i32.or (i32.shl (local.get $src) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 163) (local.get $src)) (call $te_raw (local.get $a)))
  ;; 16-bit: MOV [mem], imm16
  (func $emit_store16_imm (param $imm i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 168) (global.get $mr_base))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $imm)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 167) (i32.const 0))
    (call $te_raw (local.get $a)) (call $te_raw (local.get $imm)))
  (func $emit_alu_m32_i (param $alu_op i32) (param $imm i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 131) (i32.or (i32.shl (local.get $alu_op) (i32.const 8)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $imm)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 51) (local.get $alu_op))
    (call $te_raw (local.get $a)) (call $te_raw (local.get $imm)))

  (func $emit_alu_m8_i (param $alu_op i32) (param $imm i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 132) (i32.or (i32.shl (local.get $alu_op) (i32.const 8)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $imm)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 52) (local.get $alu_op))
    (call $te_raw (local.get $a)) (call $te_raw (local.get $imm)))

  ;; MOV [mem], imm32
  (func $emit_store32_imm (param $imm i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 133) (global.get $mr_base))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $imm)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 76) (i32.const 0))
    (call $te_raw (local.get $a)) (call $te_raw (local.get $imm)))

  ;; MOV [mem], imm8
  (func $emit_store8_imm (param $imm i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 134) (global.get $mr_base))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $imm)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 77) (local.get $imm))
    (call $te_raw (local.get $a)))

  ;; Unary (inc/dec/not/neg) [mem32]
  (func $emit_unary_m32 (param $uop i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 135) (i32.or (i32.shl (local.get $uop) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 68) (local.get $uop))
    (call $te_raw (local.get $a)))

  ;; TEST [mem32], reg
  (func $emit_test_m32_r (param $reg i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 136) (i32.or (i32.shl (local.get $reg) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 74) (local.get $reg))
    (call $te_raw (local.get $a)))

  (func $emit_test_m8_r (param $reg i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 152) (i32.or (i32.shl (local.get $reg) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 151) (local.get $reg))
    (call $te_raw (local.get $a)))

  ;; TEST [mem32], imm32
  (func $emit_test_m32_i (param $imm i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 137) (global.get $mr_base))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $imm)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 75) (i32.const 0))
    (call $te_raw (local.get $a)) (call $te_raw (local.get $imm)))

  ;; TEST [mem8], imm8
  (func $emit_test_m8_i (param $imm i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 138) (global.get $mr_base))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $imm)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 124) (local.get $imm))
    (call $te_raw (local.get $a)))

  ;; Shift [mem32]
  (func $emit_shift_m32 (param $shift_info i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 139) (global.get $mr_base))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $shift_info)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 54) (local.get $shift_info))
    (call $te_raw (local.get $a)))

  ;; CALL [mem] (indirect)
  (func $emit_call_ind (param $ret_addr i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 140) (local.get $ret_addr))
            (call $te_raw (global.get $mr_base)) (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 40) (local.get $ret_addr))
    (call $te_raw (local.get $a)))

  ;; JMP [mem] (indirect)
  (func $emit_jmp_ind (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 141) (i32.const 0))
            (call $te_raw (global.get $mr_base)) (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 125) (i32.const 0))
    (call $te_raw (local.get $a)))

  ;; PUSH [mem32]
  (func $emit_push_m32 (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 142) (global.get $mr_base))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 121) (i32.const 0))
    (call $te_raw (local.get $a)))

  ;; MOVZX reg, byte [mem]
  (func $emit_movzx8 (param $dst i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 143) (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 78) (local.get $dst))
    (call $te_raw (local.get $a)))

  ;; MOVSX reg, byte [mem]
  (func $emit_movsx8 (param $dst i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 144) (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 79) (local.get $dst))
    (call $te_raw (local.get $a)))

  ;; MOVZX reg, word [mem]
  (func $emit_movzx16 (param $dst i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 145) (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 80) (local.get $dst))
    (call $te_raw (local.get $a)))

  ;; MOVSX reg, word [mem]
  (func $emit_movsx16 (param $dst i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 146) (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 81) (local.get $dst))
    (call $te_raw (local.get $a)))

  ;; MUL/IMUL/DIV/IDIV [mem32]. type: 0=mul,1=imul,2=div,3=idiv
  (func $emit_muldiv_m32 (param $mtype i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 147) (i32.or (i32.shl (local.get $mtype) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    ;; Absolute: use existing handlers 60-63
    (if (i32.eq (local.get $mtype) (i32.const 0)) (then (call $te (i32.const 60) (i32.const 0)) (call $te_raw (global.get $mr_disp)) (return)))
    (if (i32.eq (local.get $mtype) (i32.const 1)) (then (call $te (i32.const 61) (i32.const 0)) (call $te_raw (global.get $mr_disp)) (return)))
    (if (i32.eq (local.get $mtype) (i32.const 2)) (then (call $te (i32.const 62) (i32.const 0)) (call $te_raw (global.get $mr_disp)) (return)))
    (call $te (i32.const 63) (i32.const 0)) (call $te_raw (global.get $mr_disp)))

  ;; ============================================================
  ;; DECODE BLOCK
  ;; ============================================================
  (func $decode_block (param $start_eip i32) (result i32)
    (local $tstart i32)
    (local $op i32)
    (local $done i32)
    (local $prefix_rep i32)    ;; 0=none, 1=REP/REPE, 2=REPNE
    (local $prefix_66 i32)     ;; operand-size override
    (local $prefix_seg i32)    ;; segment override (ignored but consumed)
    (local $imm i32)
    (local $disp i32)
    (local $a i32)

    (local.set $tstart (global.get $thread_alloc))
    (global.set $d_pc (local.get $start_eip))
    (local.set $done (i32.const 0))

    (block $exit (loop $decode
      (br_if $exit (local.get $done))

      ;; Reset prefixes
      (local.set $prefix_rep (i32.const 0))
      (local.set $prefix_66 (i32.const 0))
      (local.set $prefix_seg (i32.const 0))

      ;; Consume prefixes
      (block $pfx_done (loop $pfx
        (local.set $op (call $d_fetch8))
        (if (i32.eq (local.get $op) (i32.const 0xF3)) (then (local.set $prefix_rep (i32.const 1)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0xF2)) (then (local.set $prefix_rep (i32.const 2)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x66)) (then (local.set $prefix_66 (i32.const 1)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x26)) (then (local.set $prefix_seg (i32.const 1)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x2E)) (then (local.set $prefix_seg (i32.const 2)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x36)) (then (local.set $prefix_seg (i32.const 3)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x3E)) (then (local.set $prefix_seg (i32.const 4)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x64)) (then (local.set $prefix_seg (i32.const 5)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x65)) (then (local.set $prefix_seg (i32.const 6)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0xF0)) (then (br $pfx))) ;; LOCK — ignore
        (br $pfx_done)
      ))

      ;; Propagate segment prefix to global for ModRM decoder
      (global.set $d_seg (local.get $prefix_seg))

      ;; ---- NOP (0x90) ----
      (if (i32.eq (local.get $op) (i32.const 0x90)) (then (call $te (i32.const 0) (i32.const 0)) (br $decode)))

      ;; ---- PUSH reg (0x50-0x57) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x50)) (i32.le_u (local.get $op) (i32.const 0x57)))
        (then (if (local.get $prefix_66)
          (then (call $te (i32.const 181) (i32.sub (local.get $op) (i32.const 0x50))))
          (else (call $te (i32.const 32) (i32.sub (local.get $op) (i32.const 0x50)))))
          (br $decode)))
      ;; ---- POP reg (0x58-0x5F) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x58)) (i32.le_u (local.get $op) (i32.const 0x5F)))
        (then (if (local.get $prefix_66)
          (then (call $te (i32.const 182) (i32.sub (local.get $op) (i32.const 0x58))))
          (else (call $te (i32.const 33) (i32.sub (local.get $op) (i32.const 0x58)))))
          (br $decode)))
      ;; ---- INC reg (0x40-0x47) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x40)) (i32.le_u (local.get $op) (i32.const 0x47)))
        (then (call $te (i32.const 64) (i32.sub (local.get $op) (i32.const 0x40))) (br $decode)))
      ;; ---- DEC reg (0x48-0x4F) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x48)) (i32.le_u (local.get $op) (i32.const 0x4F)))
        (then (call $te (i32.const 65) (i32.sub (local.get $op) (i32.const 0x48))) (br $decode)))
      ;; ---- MOV reg, imm32 (0xB8-0xBF) / MOV reg, imm16 with 0x66 ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0xB8)) (i32.le_u (local.get $op) (i32.const 0xBF)))
        (then
          (call $te (i32.const 2) (i32.sub (local.get $op) (i32.const 0xB8)))
          (if (local.get $prefix_66)
            (then (call $te_raw (call $d_fetch16)))
            (else (call $te_raw (call $d_fetch32))))
          (br $decode)))
      ;; ---- MOV reg8, imm8 (0xB0-0xB7) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0xB0)) (i32.le_u (local.get $op) (i32.const 0xB7)))
        (then
          (call $te (i32.const 156) (i32.sub (local.get $op) (i32.const 0xB0)))
          (call $te_raw (call $d_fetch8)) (br $decode)))
      ;; ---- XCHG eax, reg (0x91-0x97) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x91)) (i32.le_u (local.get $op) (i32.const 0x97)))
        (then (call $te (i32.const 116) (i32.sub (local.get $op) (i32.const 0x90))) (br $decode)))

      ;; ---- ALU r/m32, r32 (0x00-0x3F even: ADD=00,OR=08,ADC=10,SBB=18,AND=20,SUB=28,XOR=30,CMP=38) ----
      ;; Opcodes 0x00/0x01: ADD r/m, r (byte/dword)
      ;; 0x02/0x03: ADD r, r/m
      ;; Pattern: (op>>3)&7 = ALU index, bit 1 = direction (0=rm,r 1=r,rm), bit 0 = size (0=8 1=32)
      ;; This covers 0x00-0x3D (excluding 0x0F, and x6/x7/xE/xF = segment ops)
      (if (i32.and (i32.le_u (local.get $op) (i32.const 0x3D))
                   (i32.lt_u (i32.and (local.get $op) (i32.const 0x7)) (i32.const 6)))
        (then
          (local.set $imm (i32.and (i32.shr_u (local.get $op) (i32.const 3)) (i32.const 7))) ;; ALU op index
          ;; Check for AL/EAX, imm forms (bit pattern: xx100 = AL,imm8 and xx101 = EAX,imm32)
          (if (i32.eq (i32.and (local.get $op) (i32.const 7)) (i32.const 4))
            (then ;; AL, imm8 — byte ALU handler 154
              (call $te (i32.const 154) (i32.or (i32.shl (local.get $imm) (i32.const 8)) (i32.const 0))) ;; reg=AL(0)
              (call $te_raw (i32.and (call $d_fetch8) (i32.const 0xFF)))
              (br $decode)))
          (if (i32.eq (i32.and (local.get $op) (i32.const 7)) (i32.const 5))
            (then (if (local.get $prefix_66)
              (then ;; AX, imm16 — handler 207 (alu_r16_i16)
                (call $te (i32.const 207) (i32.shl (local.get $imm) (i32.const 4))) ;; reg=0(AX)
                (call $te_raw (i32.and (call $d_fetch16) (i32.const 0xFFFF))))
              (else ;; EAX, imm32
                (call $te (i32.add (i32.const 3) (local.get $imm)) (i32.const 0))
                (call $te_raw (call $d_fetch32))))
              (br $decode)))

          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then
              ;; reg, reg — check byte vs word vs dword
              (if (i32.and (local.get $op) (i32.const 1))
                (then (if (local.get $prefix_66)
                  (then ;; 16-bit: handler 206, op=alu<<8|dst<<4|src
                    (if (i32.and (local.get $op) (i32.const 2))
                      (then (call $te (i32.const 206)
                        (i32.or (i32.shl (local.get $imm) (i32.const 8))
                          (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val)))))
                      (else (call $te (i32.const 206)
                        (i32.or (i32.shl (local.get $imm) (i32.const 8))
                          (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))))
                  (else ;; 32-bit (odd opcode)
                    (if (i32.and (local.get $op) (i32.const 2))
                      (then (call $te (i32.add (i32.const 12) (local.get $imm))
                        (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                      (else (call $te (i32.add (i32.const 12) (local.get $imm))
                        (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))))))
                (else ;; byte (even opcode) — use r8 handler 153
                  (if (i32.and (local.get $op) (i32.const 2))
                    (then (call $te (i32.const 153)
                      (i32.or (i32.shl (local.get $imm) (i32.const 8))
                        (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val)))))
                    (else (call $te (i32.const 153)
                      (i32.or (i32.shl (local.get $imm) (i32.const 8))
                        (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))))))
            (else
              ;; memory involved — use runtime EA helpers
              (if (i32.and (local.get $op) (i32.const 2))
                (then ;; r, [mem]
                  (if (i32.and (local.get $op) (i32.const 1))
                    (then (if (local.get $prefix_66)
                      (then (call $emit_alu_r16_m16 (local.get $imm) (global.get $mr_reg)))
                      (else (call $emit_alu_r_m32 (local.get $imm) (global.get $mr_reg)))))
                    (else (call $emit_alu_r_m8 (local.get $imm) (global.get $mr_reg)))))
                (else ;; [mem], r
                  (if (i32.and (local.get $op) (i32.const 1))
                    (then (if (local.get $prefix_66)
                      (then (call $emit_alu_m16_r16 (local.get $imm) (global.get $mr_reg)))
                      (else (call $emit_alu_m32_r (local.get $imm) (global.get $mr_reg)))))
                    (else (call $emit_alu_m8_r (local.get $imm) (global.get $mr_reg))))))))
          (br $decode)))

      ;; ---- 0x80/0x81/0x82/0x83: Group 1 — ALU r/m, imm ----
      (if (i32.or (i32.or (i32.eq (local.get $op) (i32.const 0x80)) (i32.eq (local.get $op) (i32.const 0x81)))
                  (i32.or (i32.eq (local.get $op) (i32.const 0x82)) (i32.eq (local.get $op) (i32.const 0x83))))
        (then
          (call $decode_modrm)
          ;; imm: 0x81=imm32 (or imm16 with 0x66), others=imm8 sign-extended
          (if (i32.eq (local.get $op) (i32.const 0x81))
            (then (if (local.get $prefix_66)
              (then (local.set $imm (call $d_fetch16)))
              (else (local.set $imm (call $d_fetch32)))))
            (else (local.set $imm (call $sign_ext8 (call $d_fetch8)))))
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then ;; reg, imm
              (if (i32.or (i32.eq (local.get $op) (i32.const 0x80)) (i32.eq (local.get $op) (i32.const 0x82)))
                (then ;; byte reg, imm8 — handler 154
                  (call $te (i32.const 154) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (global.get $mr_val)))
                  (call $te_raw (local.get $imm)))
                (else (if (i32.and (local.get $prefix_66) (i32.or (i32.eq (local.get $op) (i32.const 0x81)) (i32.eq (local.get $op) (i32.const 0x83))))
                  (then ;; 16-bit reg, imm16 — handler 207
                    (call $te (i32.const 207) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val)))
                    (call $te_raw (local.get $imm)))
                  (else ;; dword reg, imm32
                    (call $te (i32.add (i32.const 3) (global.get $mr_reg)) (global.get $mr_val))
                    (call $te_raw (local.get $imm)))))))
            (else ;; [mem], imm — use runtime EA
              (if (i32.or (i32.eq (local.get $op) (i32.const 0x80)) (i32.eq (local.get $op) (i32.const 0x82)))
                (then (call $emit_alu_m8_i (global.get $mr_reg) (local.get $imm)))
                (else (if (local.get $prefix_66)
                  (then (call $emit_alu_m16_i (global.get $mr_reg) (local.get $imm)))
                  (else (call $emit_alu_m32_i (global.get $mr_reg) (local.get $imm))))))))
          (br $decode)))

      ;; ---- 0x84: TEST r/m8, r8 ----
      (if (i32.eq (local.get $op) (i32.const 0x84))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 150) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
            (else (call $emit_test_m8_r (global.get $mr_reg))))
          (br $decode)))

      ;; ---- 0x85: TEST r/m32, r ----
      (if (i32.eq (local.get $op) (i32.const 0x85))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 72) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
            (else (call $emit_test_m32_r (global.get $mr_reg))))
          (br $decode)))

      ;; ---- 0x88/0x89: MOV r/m, r ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0x88)) (i32.eq (local.get $op) (i32.const 0x89)))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then
              (if (i32.eq (local.get $op) (i32.const 0x88))
                (then (call $te (i32.const 155) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
                (else (call $te (i32.const 11) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))))
            (else
              (if (i32.eq (local.get $op) (i32.const 0x89))
                (then (if (local.get $prefix_66)
                  (then (call $emit_store16 (global.get $mr_reg)))
                  (else (call $emit_store32 (global.get $mr_reg)))))
                (else (call $emit_store8 (global.get $mr_reg))))))
          (br $decode)))

      ;; ---- 0x8A/0x8B: MOV r, r/m ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0x8A)) (i32.eq (local.get $op) (i32.const 0x8B)))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then
              (if (i32.eq (local.get $op) (i32.const 0x8A))
                (then (call $te (i32.const 155) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                (else (call $te (i32.const 11) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))))
            (else
              (if (i32.eq (local.get $op) (i32.const 0x8B))
                (then (if (local.get $prefix_66)
                  (then (call $emit_load16 (global.get $mr_reg)))
                  (else (call $emit_load32 (global.get $mr_reg)))))
                (else (call $emit_load8 (global.get $mr_reg))))))
          (br $decode)))

      ;; ---- 0x8D: LEA ----
      (if (i32.eq (local.get $op) (i32.const 0x8D))
        (then
          (call $decode_modrm)
          (call $emit_lea (global.get $mr_reg))
          (br $decode)))

      ;; ---- 0xA0-0xA3: MOV AL/EAX, [abs] / MOV [abs], AL/EAX ----
      ;; Apply FS base if segment override is active
      (if (i32.eq (local.get $op) (i32.const 0xA0)) (then (call $te (i32.const 24) (i32.const 0)) (call $te_raw (call $seg_adj (call $d_fetch32) (local.get $prefix_seg))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xA1)) (then
        (if (local.get $prefix_66)
          (then (call $te (i32.const 164) (i32.const 0)) (call $te_raw (call $seg_adj (call $d_fetch32) (local.get $prefix_seg))))  ;; mov ax, [addr]
          (else (call $te (i32.const 20) (i32.const 0)) (call $te_raw (call $seg_adj (call $d_fetch32) (local.get $prefix_seg)))))   ;; mov eax, [addr]
        (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xA2)) (then (call $te (i32.const 25) (i32.const 0)) (call $te_raw (call $seg_adj (call $d_fetch32) (local.get $prefix_seg))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xA3)) (then
        (if (local.get $prefix_66)
          (then (call $te (i32.const 163) (i32.const 0)) (call $te_raw (call $seg_adj (call $d_fetch32) (local.get $prefix_seg))))  ;; mov [addr], ax
          (else (call $te (i32.const 21) (i32.const 0)) (call $te_raw (call $seg_adj (call $d_fetch32) (local.get $prefix_seg)))))   ;; mov [addr], eax
        (br $decode)))

      ;; ---- 0xC6: MOV r/m8, imm8 ----
      (if (i32.eq (local.get $op) (i32.const 0xC6))
        (then
          (call $decode_modrm)
          (local.set $imm (call $d_fetch8))
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 2) (global.get $mr_val)) (call $te_raw (local.get $imm)))
            (else (call $emit_store8_imm (local.get $imm))))
          (br $decode)))

      ;; ---- 0xC7: MOV r/m32, imm32 (or r/m16, imm16 with 66 prefix) ----
      (if (i32.eq (local.get $op) (i32.const 0xC7))
        (then
          (call $decode_modrm)
          (if (local.get $prefix_66)
            (then (local.set $imm (call $d_fetch16)))
            (else (local.set $imm (call $d_fetch32))))
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 2) (global.get $mr_val)) (call $te_raw (local.get $imm)))
            (else (if (local.get $prefix_66)
              (then (call $emit_store16_imm (local.get $imm)))
              (else (call $emit_store32_imm (local.get $imm))))))
          (br $decode)))

      ;; ---- 0xA8: TEST AL, imm8 ----
      (if (i32.eq (local.get $op) (i32.const 0xA8))
        (then (call $te (i32.const 73) (i32.const 0)) (call $te_raw (call $sign_ext8 (call $d_fetch8))) (br $decode)))
      ;; ---- 0xA9: TEST EAX, imm32 ----
      (if (i32.eq (local.get $op) (i32.const 0xA9))
        (then (call $te (i32.const 73) (i32.const 0)) (call $te_raw (call $d_fetch32)) (br $decode)))

      ;; ---- 0xF6/0xF7: Unary group 3 ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0xF6)) (i32.eq (local.get $op) (i32.const 0xF7)))
        (then
          (call $decode_modrm)
          ;; mr_reg: 0=TEST,1=TEST,2=NOT,3=NEG,4=MUL,5=IMUL,6=DIV,7=IDIV
          (if (i32.le_u (global.get $mr_reg) (i32.const 1)) ;; TEST
            (then
              (if (i32.eq (local.get $op) (i32.const 0xF7))
                (then (local.set $imm (call $d_fetch32)))
                (else (local.set $imm (call $d_fetch8))))
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 73) (global.get $mr_val)) (call $te_raw (local.get $imm)))
                (else
                  (if (i32.eq (local.get $op) (i32.const 0xF7))
                    (then (call $emit_test_m32_i (local.get $imm)))
                    (else (call $emit_test_m8_i (local.get $imm))))))

              (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 2)) ;; NOT
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 66) (global.get $mr_val)))
                (else (call $emit_unary_m32 (i32.const 2))))
              (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 3)) ;; NEG
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 67) (global.get $mr_val)))
                (else (call $emit_unary_m32 (i32.const 3))))
              (br $decode)))
          ;; MUL/IMUL/DIV/IDIV
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then
              (if (i32.eq (global.get $mr_reg) (i32.const 4)) (then (call $te (i32.const 55) (global.get $mr_val))))
              (if (i32.eq (global.get $mr_reg) (i32.const 5)) (then (call $te (i32.const 56) (global.get $mr_val))))
              (if (i32.eq (global.get $mr_reg) (i32.const 6)) (then (call $te (i32.const 57) (global.get $mr_val))))
              (if (i32.eq (global.get $mr_reg) (i32.const 7)) (then (call $te (i32.const 58) (global.get $mr_val)))))
            (else
              (if (i32.eq (global.get $mr_reg) (i32.const 4)) (then (call $emit_muldiv_m32 (i32.const 0))))
              (if (i32.eq (global.get $mr_reg) (i32.const 5)) (then (call $emit_muldiv_m32 (i32.const 1))))
              (if (i32.eq (global.get $mr_reg) (i32.const 6)) (then (call $emit_muldiv_m32 (i32.const 2))))
              (if (i32.eq (global.get $mr_reg) (i32.const 7)) (then (call $emit_muldiv_m32 (i32.const 3))))))
          (br $decode)))

      ;; ---- 0xFE/0xFF: Group 4/5 (INC/DEC/CALL/JMP/PUSH r/m) ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0xFE)) (i32.eq (local.get $op) (i32.const 0xFF)))
        (then
          (call $decode_modrm)
          ;; 0=INC, 1=DEC, 2=CALL, 3=CALL far, 4=JMP, 5=JMP far, 6=PUSH
          (if (i32.eq (global.get $mr_reg) (i32.const 0)) ;; INC
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 64) (global.get $mr_val)))
                (else (call $emit_unary_m32 (i32.const 0))))
              (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 1)) ;; DEC
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 65) (global.get $mr_val)))
                (else (call $emit_unary_m32 (i32.const 1))))
              (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 2)) ;; CALL r/m32
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 119) (global.get $d_pc))
                      (call $te_raw (global.get $mr_val)))
                (else (call $emit_call_ind (global.get $d_pc))))
              (local.set $done (i32.const 1)) (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 4)) ;; JMP r/m32
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 120) (global.get $mr_val)))
                (else (call $emit_jmp_ind)))
              (local.set $done (i32.const 1)) (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 6)) ;; PUSH r/m32
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 32) (global.get $mr_val)))
                (else (call $emit_push_m32)))
              (br $decode)))
          ;; Unhandled FF variant
          (call $te (i32.const 45) (global.get $d_pc))
          (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- 0xD0-0xD3: Shift group 2 ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0xD0)) (i32.le_u (local.get $op) (i32.const 0xD3)))
        (then
          (call $decode_modrm)
          ;; D0=rm8,1  D1=rm32,1  D2=rm8,CL  D3=rm32,CL
          (local.set $imm (if (result i32) (i32.or (i32.eq (local.get $op) (i32.const 0xD0)) (i32.eq (local.get $op) (i32.const 0xD1)))
            (then (i32.const 1)) (else (i32.const 0xFF)))) ;; 0xFF = use CL
          (if (i32.or (i32.eq (local.get $op) (i32.const 0xD0)) (i32.eq (local.get $op) (i32.const 0xD2)))
            (then ;; 8-bit shifts
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 191) (i32.or (global.get $mr_val) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16))))))
                (else (call $te (i32.const 192) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16)))) (call $te_raw (call $emit_sib_or_abs)))))
            (else (if (local.get $prefix_66)
              (then ;; 16-bit shifts
                (if (i32.eq (global.get $mr_mod) (i32.const 3))
                  (then (call $te (i32.const 193) (i32.or (global.get $mr_val) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16))))))
                  (else (call $te (i32.const 194) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16)))) (call $te_raw (call $emit_sib_or_abs)))))
              (else ;; 32-bit shifts
                (if (i32.eq (global.get $mr_mod) (i32.const 3))
                  (then (call $te (i32.const 53) (i32.or (global.get $mr_val) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16))))))
                  (else (call $emit_shift_m32 (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (local.get $imm)))))))))
          (br $decode)))

      ;; ---- 0xC0/0xC1: Shift group 2, imm8 ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0xC0)) (i32.eq (local.get $op) (i32.const 0xC1)))
        (then
          (call $decode_modrm)
          (local.set $imm (call $d_fetch8))
          (if (i32.eq (local.get $op) (i32.const 0xC0))
            (then ;; 8-bit shift
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 191) (i32.or (global.get $mr_val) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16))))))
                (else (call $te (i32.const 192) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16)))) (call $te_raw (call $emit_sib_or_abs)))))
            (else (if (local.get $prefix_66)
              (then ;; 16-bit shift
                (if (i32.eq (global.get $mr_mod) (i32.const 3))
                  (then (call $te (i32.const 193) (i32.or (global.get $mr_val) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16))))))
                  (else (call $te (i32.const 194) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16)))) (call $te_raw (call $emit_sib_or_abs)))))
              (else ;; 32-bit shift
                (if (i32.eq (global.get $mr_mod) (i32.const 3))
                  (then (call $te (i32.const 53) (i32.or (global.get $mr_val) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16))))))
                  (else (call $emit_shift_m32 (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (local.get $imm)))))))))
          (br $decode)))

      ;; ---- PUSH imm32 (0x68) / PUSH imm8 (0x6A) ----
      (if (i32.eq (local.get $op) (i32.const 0x68))
        (then (call $te (i32.const 34) (i32.const 0))
          (if (local.get $prefix_66)
            (then (call $te_raw (call $d_fetch16)))
            (else (call $te_raw (call $d_fetch32))))
          (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0x6A)) (then (call $te (i32.const 34) (i32.const 0)) (call $te_raw (call $sign_ext8 (call $d_fetch8))) (br $decode)))

      ;; ---- IMUL r32, r/m32, imm (0x69/0x6B) ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0x69)) (i32.eq (local.get $op) (i32.const 0x6B)))
        (then
          (call $decode_modrm)
          (if (i32.eq (local.get $op) (i32.const 0x69))
            (then (local.set $imm (call $d_fetch32)))
            (else (local.set $imm (call $sign_ext8 (call $d_fetch8)))))
          ;; For reg,reg: emit imul_r_r_i
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 59) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val)))
                  (call $te_raw (local.get $imm)))
            (else ;; reg, [mem], imm — load then multiply
              (call $emit_load32 (global.get $mr_reg))
              (call $te (i32.const 59) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_reg)))
              (call $te_raw (local.get $imm))))
          (br $decode)))

      ;; ---- CALL rel32 (0xE8) ----
      (if (i32.eq (local.get $op) (i32.const 0xE8))
        (then
          (local.set $disp (call $d_fetch32))
          (call $te (i32.const 39) (global.get $d_pc))
          (call $te_raw (i32.add (global.get $d_pc) (local.get $disp)))
          (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- RET (0xC3) ----
      (if (i32.eq (local.get $op) (i32.const 0xC3)) (then (call $te (i32.const 41) (i32.const 0)) (local.set $done (i32.const 1)) (br $decode)))
      ;; ---- RET imm16 (0xC2) ----
      (if (i32.eq (local.get $op) (i32.const 0xC2)) (then (call $te (i32.const 42) (call $d_fetch16)) (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- JMP rel8 (0xEB) / JMP rel32 (0xE9) ----
      (if (i32.eq (local.get $op) (i32.const 0xEB))
        (then (local.set $disp (call $sign_ext8 (call $d_fetch8)))
              (call $te (i32.const 43) (i32.const 0)) (call $te_raw (i32.add (global.get $d_pc) (local.get $disp)))
              (local.set $done (i32.const 1)) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xE9))
        (then (local.set $disp (call $d_fetch32))
              (call $te (i32.const 43) (i32.const 0)) (call $te_raw (i32.add (global.get $d_pc) (local.get $disp)))
              (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- Jcc rel8 (0x70-0x7F) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x70)) (i32.le_u (local.get $op) (i32.const 0x7F)))
        (then
          (local.set $disp (call $sign_ext8 (call $d_fetch8)))
          (call $te (i32.const 44) (i32.and (local.get $op) (i32.const 0xF)))
          (call $te_raw (global.get $d_pc)) ;; fall-through
          (call $te_raw (i32.add (global.get $d_pc) (local.get $disp))) ;; target
          (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- LOOP/LOOPE/LOOPNE (0xE0-0xE2) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0xE0)) (i32.le_u (local.get $op) (i32.const 0xE2)))
        (then
          (local.set $disp (call $sign_ext8 (call $d_fetch8)))
          ;; E2=LOOP, E1=LOOPE, E0=LOOPNE
          (local.set $imm (i32.sub (i32.const 0xE2) (local.get $op))) ;; 0=LOOP, 1=LOOPE, 2=LOOPNE
          (call $te (i32.const 46) (local.get $imm))
          (call $te_raw (i32.add (global.get $d_pc) (local.get $disp)))
          (call $te_raw (global.get $d_pc))
          (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- String ops ----
      (if (i32.eq (local.get $op) (i32.const 0xA4)) ;; MOVSB
        (then (if (local.get $prefix_rep) (then (call $te (i32.const 82) (i32.const 0))) (else (call $te (i32.const 86) (i32.const 0)))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xA5)) ;; MOVSD / MOVSW
        (then (if (local.get $prefix_66)
          (then (if (local.get $prefix_rep) (then (call $te (i32.const 186) (i32.const 0))) (else (call $te (i32.const 183) (i32.const 0)))))
          (else (if (local.get $prefix_rep) (then (call $te (i32.const 83) (i32.const 0))) (else (call $te (i32.const 87) (i32.const 0))))))
          (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xAA)) ;; STOSB
        (then (if (local.get $prefix_rep) (then (call $te (i32.const 84) (i32.const 0))) (else (call $te (i32.const 88) (i32.const 0)))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xAB)) ;; STOSD / STOSW
        (then (if (local.get $prefix_66)
          (then (if (local.get $prefix_rep) (then (call $te (i32.const 187) (i32.const 0))) (else (call $te (i32.const 184) (i32.const 0)))))
          (else (if (local.get $prefix_rep) (then (call $te (i32.const 85) (i32.const 0))) (else (call $te (i32.const 89) (i32.const 0))))))
          (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xAC)) ;; LODSB
        (then (call $te (i32.const 90) (i32.const 0)) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xAD)) ;; LODSD / LODSW
        (then (if (local.get $prefix_66)
          (then (call $te (i32.const 185) (i32.const 0)))
          (else (call $te (i32.const 91) (i32.const 0))))
          (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xA6)) ;; CMPSB
        (then (if (local.get $prefix_rep) (then (call $te (i32.const 92) (i32.sub (local.get $prefix_rep) (i32.const 1)))) (else (call $te (i32.const 94) (i32.const 0)))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xA7)) ;; CMPSD
        (then (if (local.get $prefix_rep) (then (call $te (i32.const 169) (i32.sub (local.get $prefix_rep) (i32.const 1)))) (else (call $te (i32.const 171) (i32.const 0)))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xAE)) ;; SCASB
        (then (if (local.get $prefix_rep) (then (call $te (i32.const 93) (i32.sub (local.get $prefix_rep) (i32.const 1)))) (else (call $te (i32.const 95) (i32.const 0)))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xAF)) ;; SCASD
        (then (if (local.get $prefix_rep) (then (call $te (i32.const 170) (i32.sub (local.get $prefix_rep) (i32.const 1)))) (else (call $te (i32.const 172) (i32.const 0)))) (br $decode)))

      ;; ---- Misc single-byte ----
      (if (i32.eq (local.get $op) (i32.const 0x60)) (then (call $te (i32.const 35) (i32.const 0)) (br $decode))) ;; PUSHAD
      (if (i32.eq (local.get $op) (i32.const 0x61)) (then (call $te (i32.const 36) (i32.const 0)) (br $decode))) ;; POPAD
      (if (i32.eq (local.get $op) (i32.const 0x9C)) (then (call $te (i32.const 37) (i32.const 0)) (br $decode))) ;; PUSHFD
      (if (i32.eq (local.get $op) (i32.const 0x9D)) (then (call $te (i32.const 38) (i32.const 0)) (br $decode))) ;; POPFD
      (if (i32.eq (local.get $op) (i32.const 0x99)) ;; CDQ / CWD
        (then (if (local.get $prefix_66)
          (then (call $te (i32.const 180) (i32.const 0)))  ;; CWD
          (else (call $te (i32.const 105) (i32.const 0)))) ;; CDQ
          (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0x98)) ;; CWDE / CBW
        (then (if (local.get $prefix_66)
          (then (call $te (i32.const 106) (i32.const 0)))  ;; CBW
          (else (call $te (i32.const 107) (i32.const 0)))) ;; CWDE
          (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xFC)) (then (call $te (i32.const 108) (i32.const 0)) (br $decode))) ;; CLD
      (if (i32.eq (local.get $op) (i32.const 0xFD)) (then (call $te (i32.const 109) (i32.const 0)) (br $decode))) ;; STD
      (if (i32.eq (local.get $op) (i32.const 0xF8)) (then (call $te (i32.const 110) (i32.const 0)) (br $decode))) ;; CLC
      (if (i32.eq (local.get $op) (i32.const 0xF9)) (then (call $te (i32.const 111) (i32.const 0)) (br $decode))) ;; STC
      (if (i32.eq (local.get $op) (i32.const 0xF5)) (then (call $te (i32.const 112) (i32.const 0)) (br $decode))) ;; CMC
      (if (i32.eq (local.get $op) (i32.const 0xC9)) (then (call $te (i32.const 113) (i32.const 0)) (br $decode))) ;; LEAVE
      (if (i32.eq (local.get $op) (i32.const 0xCC)) (then (call $te (i32.const 45) (global.get $d_pc)) (local.set $done (i32.const 1)) (br $decode))) ;; INT3
      (if (i32.eq (local.get $op) (i32.const 0xCD)) (then (drop (call $d_fetch8)) (call $te (i32.const 45) (global.get $d_pc)) (local.set $done (i32.const 1)) (br $decode))) ;; INT imm8
      (if (i32.eq (local.get $op) (i32.const 0xF4)) (then (call $te (i32.const 45) (global.get $d_pc)) (local.set $done (i32.const 1)) (br $decode))) ;; HLT
      ;; CLI/STI — ignore (no interrupt emulation)
      (if (i32.eq (local.get $op) (i32.const 0xFA)) (then (call $te (i32.const 0) (i32.const 0)) (br $decode))) ;; CLI
      (if (i32.eq (local.get $op) (i32.const 0xFB)) (then (call $te (i32.const 0) (i32.const 0)) (br $decode))) ;; STI

      ;; ---- 0x8F: POP r/m32 (/0) ----
      (if (i32.eq (local.get $op) (i32.const 0x8F))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 33) (global.get $mr_val)))
            (else ;; POP to memory — load from stack, store to mem
              (call $te (i32.const 20) (i32.const 0)) ;; load32 eax from [esp]
              (call $te_raw (global.get $esp))         ;; but esp is dynamic... this won't work
              ;; Just end block for this rare case
              (call $te (i32.const 45) (i32.sub (global.get $d_pc) (i32.const 2)))))
          (br $decode)))

      ;; ---- 0x0F: Two-byte opcodes ----
      (if (i32.eq (local.get $op) (i32.const 0x0F))
        (then
          (local.set $op (call $d_fetch8))

          ;; 0x0F 0x80-0x8F: Jcc rel32
          (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x80)) (i32.le_u (local.get $op) (i32.const 0x8F)))
            (then
              (local.set $disp (call $d_fetch32))
              (call $te (i32.const 44) (i32.and (local.get $op) (i32.const 0xF)))
              (call $te_raw (global.get $d_pc))
              (call $te_raw (i32.add (global.get $d_pc) (local.get $disp)))
              (local.set $done (i32.const 1)) (br $decode)))

          ;; 0x0F 0x90-0x9F: SETcc r/m8
          (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x90)) (i32.le_u (local.get $op) (i32.const 0x9F)))
            (then
              (call $decode_modrm)
              (call $te (i32.const 102) (i32.and (local.get $op) (i32.const 0xF)))
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te_raw (global.get $mr_val)))
                (else (call $te_raw (global.get $mr_disp)))) ;; TODO: runtime EA for SETcc mem
              (br $decode)))

          ;; 0x0F 0xA3: BT r/m32, r32
          (if (i32.eq (local.get $op) (i32.const 0xA3))
            (then (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 198) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))
              (br $decode)))
          ;; 0x0F 0xAB: BTS r/m32, r32
          (if (i32.eq (local.get $op) (i32.const 0xAB))
            (then (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 199) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))
              (br $decode)))
          ;; 0x0F 0xB3: BTR r/m32, r32
          (if (i32.eq (local.get $op) (i32.const 0xB3))
            (then (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 200) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))
              (br $decode)))
          ;; 0x0F 0xBB: BTC r/m32, r32
          (if (i32.eq (local.get $op) (i32.const 0xBB))
            (then (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 201) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))
              (br $decode)))

          ;; 0x0F 0xAF: IMUL r32, r/m32
          (if (i32.eq (local.get $op) (i32.const 0xAF))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 118) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                (else ;; imul reg, [mem] — dedicated opcodes to avoid clobbering dst
                  (if (call $mr_simple_base)
                    (then (call $te (i32.const 157) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_base)))
                          (call $te_raw (global.get $mr_disp)))
                    (else (local.set $imm (call $emit_sib_or_abs))
                          (call $te (i32.const 158) (global.get $mr_reg))
                          (call $te_raw (local.get $imm))))))
              (br $decode)))

          ;; 0x0F 0xB6: MOVZX r32, r/m8
          (if (i32.eq (local.get $op) (i32.const 0xB6))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then ;; movzx r32, reg8 — handler 208
                  (call $te (i32.const 208) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                (else (call $emit_movzx8 (global.get $mr_reg))))
              (br $decode)))

          ;; 0x0F 0xB7: MOVZX r32, r/m16
          (if (i32.eq (local.get $op) (i32.const 0xB7))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 11) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val)))
                      (call $te (i32.const 7) (global.get $mr_reg)) (call $te_raw (i32.const 0xFFFF)))
                (else (call $emit_movzx16 (global.get $mr_reg))))
              (br $decode)))

          ;; 0x0F 0xBE: MOVSX r32, r/m8
          (if (i32.eq (local.get $op) (i32.const 0xBE))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then ;; movsx r32, reg8 — handler 209
                  (call $te (i32.const 209) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                (else (call $emit_movsx8 (global.get $mr_reg))))
              (br $decode)))

          ;; 0x0F 0xBF: MOVSX r32, r/m16
          (if (i32.eq (local.get $op) (i32.const 0xBF))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then
                  (call $te (i32.const 11) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val)))
                  (call $te (i32.const 53) (i32.or (global.get $mr_reg) (i32.or (i32.shl (i32.const 4) (i32.const 8)) (i32.shl (i32.const 16) (i32.const 16)))))
                  (call $te (i32.const 53) (i32.or (global.get $mr_reg) (i32.or (i32.shl (i32.const 7) (i32.const 8)) (i32.shl (i32.const 16) (i32.const 16))))))
                (else (call $emit_movsx16 (global.get $mr_reg))))
              (br $decode)))

          ;; 0x0F 0xA4/0xA5: SHLD, 0x0F 0xAC/0xAD: SHRD
          (if (i32.or (i32.eq (local.get $op) (i32.const 0xA4)) (i32.eq (local.get $op) (i32.const 0xA5)))
            (then
              (call $decode_modrm)
              (if (i32.eq (local.get $op) (i32.const 0xA4))
                (then (local.set $imm (call $d_fetch8)))
                (else (local.set $imm (i32.and (global.get $ecx) (i32.const 31)))))
              (call $te (i32.const 103) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))
              (call $te_raw (local.get $imm)) (br $decode)))
          (if (i32.or (i32.eq (local.get $op) (i32.const 0xAC)) (i32.eq (local.get $op) (i32.const 0xAD)))
            (then
              (call $decode_modrm)
              (if (i32.eq (local.get $op) (i32.const 0xAC))
                (then (local.set $imm (call $d_fetch8)))
                (else (local.set $imm (i32.and (global.get $ecx) (i32.const 31)))))
              (call $te (i32.const 104) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))
              (call $te_raw (local.get $imm)) (br $decode)))

          ;; 0x0F 0xBA: BT/BTS/BTR/BTC r/m32, imm8
          (if (i32.eq (local.get $op) (i32.const 0xBA))
            (then
              (call $decode_modrm)
              (local.set $imm (call $d_fetch8))
              ;; mr_reg: 4=BT, 5=BTS, 6=BTR, 7=BTC
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then
                  (call $te (i32.add (i32.const 92) (global.get $mr_reg)) (global.get $mr_val)) ;; 96-99
                  (call $te_raw (local.get $imm)))
                (else
                  ;; Memory BT/BTS/BTR/BTC: mr_reg 4=BT,5=BTS,6=BTR,7=BTC → handler 176-179
                  (call $te (i32.add (i32.const 172) (global.get $mr_reg)) (i32.const 0))
                  (call $te_raw (call $emit_sib_or_abs))
                  (call $te_raw (local.get $imm))))
              (br $decode)))

          ;; 0x0F 0xBC: BSF, 0x0F 0xBD: BSR
          (if (i32.eq (local.get $op) (i32.const 0xBC))
            (then (call $decode_modrm) (call $te (i32.const 100) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))) (br $decode)))
          (if (i32.eq (local.get $op) (i32.const 0xBD))
            (then (call $decode_modrm) (call $te (i32.const 101) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))) (br $decode)))

          ;; 0x0F 0xC8-0xCF: BSWAP reg
          (if (i32.and (i32.ge_u (local.get $op) (i32.const 0xC8)) (i32.le_u (local.get $op) (i32.const 0xCF)))
            (then (call $te (i32.const 115) (i32.sub (local.get $op) (i32.const 0xC8))) (br $decode)))

          ;; 0x0F 0x1F: multi-byte NOP (NOP r/m32)
          (if (i32.eq (local.get $op) (i32.const 0x1F))
            (then (call $decode_modrm) (call $te (i32.const 0) (i32.const 0)) (br $decode)))

          ;; 0x0F 0x31: RDTSC — stub (return 0 in edx:eax)
          (if (i32.eq (local.get $op) (i32.const 0x31))
            (then (call $te (i32.const 2) (i32.const 0)) (call $te_raw (i32.const 0))
                  (call $te (i32.const 2) (i32.const 2)) (call $te_raw (i32.const 0)) (br $decode)))

          ;; 0x0F 0xB1: CMPXCHG r/m32, r32
          (if (i32.eq (local.get $op) (i32.const 0xB1))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 173) (i32.or (i32.const 0x80) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))
                (else (call $te (i32.const 173) (global.get $mr_reg)) (call $te_raw (call $emit_sib_or_abs))))
              (br $decode)))

          ;; 0x0F 0xC1: XADD r/m32, r32
          (if (i32.eq (local.get $op) (i32.const 0xC1))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 174) (i32.or (i32.const 0x80) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))
                (else (call $te (i32.const 174) (global.get $mr_reg)) (call $te_raw (call $emit_sib_or_abs))))
              (br $decode)))

          ;; 0x0F 0xC7: CMPXCHG8B m64 (ModRM reg field must be 1)
          (if (i32.eq (local.get $op) (i32.const 0xC7))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_reg) (i32.const 1))
                (then (call $te (i32.const 195) (i32.const 0)) (call $te_raw (call $emit_sib_or_abs))))
              (br $decode)))

          ;; 0x0F 0xA2: CPUID
          (if (i32.eq (local.get $op) (i32.const 0xA2))
            (then (call $te (i32.const 175) (i32.const 0)) (br $decode)))

          ;; Unknown 0x0F xx
          (call $host_log_i32 (i32.or (i32.const 0x0F00) (local.get $op)))
          (call $te (i32.const 45) (i32.sub (global.get $d_pc) (i32.const 2)))
          (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- XCHG r/m32, r32 (0x87) / XCHG r/m8 (0x86) ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0x86)) (i32.eq (local.get $op) (i32.const 0x87)))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 71) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
            (else (if (call $mr_simple_base)
              (then (call $te (i32.const 197) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_base)))
                    (call $te_raw (global.get $mr_disp)))
              (else (call $te (i32.const 196) (global.get $mr_reg))
                    (call $te_raw (call $emit_sib_or_abs))))))
          (br $decode)))

      ;; ---- x87 FPU (D8-DF) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0xD8)) (i32.le_u (local.get $op) (i32.const 0xDF)))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then
              ;; Register-register: emit th_fpu_reg (189) with (group<<8)|(reg<<4)|rm
              (call $te (i32.const 189) (i32.or (i32.or
                (i32.shl (i32.sub (local.get $op) (i32.const 0xD8)) (i32.const 8))
                (i32.shl (global.get $mr_reg) (i32.const 4)))
                (global.get $mr_val))))
            (else
              ;; Memory operand
              (call $apply_seg_override)
              (if (call $mr_simple_base)
                (then
                  ;; base+disp: emit th_fpu_mem_ro (190) with (group<<8)|(reg<<4)|base, disp
                  (call $te (i32.const 190) (i32.or (i32.or
                    (i32.shl (i32.sub (local.get $op) (i32.const 0xD8)) (i32.const 8))
                    (i32.shl (global.get $mr_reg) (i32.const 4)))
                    (global.get $mr_base)))
                  (call $te_raw (global.get $mr_disp)))
                (else
                  ;; absolute or SIB: use emit_sib_or_abs
                  (local.set $a (call $emit_sib_or_abs))
                  (call $te (i32.const 188) (i32.or
                    (i32.shl (i32.sub (local.get $op) (i32.const 0xD8)) (i32.const 4))
                    (global.get $mr_reg)))
                  (call $te_raw (local.get $a))))))
          (local.set $done (i32.const 1))
          (br $decode)))

      ;; ---- Unrecognized opcode ----
      (call $host_log_i32 (local.get $op))
      (call $te (i32.const 45) (i32.sub (global.get $d_pc) (i32.const 1)))
      (local.set $done (i32.const 1))
      (br $decode)
    ))

    (call $cache_store (local.get $start_eip) (local.get $tstart))
    (local.get $tstart)
  )

