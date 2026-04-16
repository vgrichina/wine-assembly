  ;; ============================================================
  ;; REGISTER ACCESS
  ;; ============================================================
  (func $get_reg (param $r i32) (result i32)
    (if (i32.eq (local.get $r) (i32.const 0)) (then (return (global.get $eax))))
    (if (i32.eq (local.get $r) (i32.const 1)) (then (return (global.get $ecx))))
    (if (i32.eq (local.get $r) (i32.const 2)) (then (return (global.get $edx))))
    (if (i32.eq (local.get $r) (i32.const 3)) (then (return (global.get $ebx))))
    (if (i32.eq (local.get $r) (i32.const 4)) (then (return (global.get $esp))))
    (if (i32.eq (local.get $r) (i32.const 5)) (then (return (global.get $ebp))))
    (if (i32.eq (local.get $r) (i32.const 6)) (then (return (global.get $esi))))
    (global.get $edi)
  )

  (func $set_reg (param $r i32) (param $v i32)
    (if (i32.eq (local.get $r) (i32.const 0)) (then (global.set $eax (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 1)) (then (global.set $ecx (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 2)) (then (global.set $edx (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 3)) (then (global.set $ebx (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 4)) (then (global.set $esp (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 5)) (then (global.set $ebp (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 6)) (then (global.set $esi (local.get $v)) (return)))
    (global.set $edi (local.get $v))
  )

  ;; Get byte register value (0-3=al/cl/dl/bl, 4-7=ah/ch/dh/bh)
  (func $get_reg8 (param $r i32) (result i32)
    (if (result i32) (i32.lt_u (local.get $r) (i32.const 4))
      (then (i32.and (call $get_reg (local.get $r)) (i32.const 0xFF)))
      (else (i32.and (i32.shr_u (call $get_reg (i32.sub (local.get $r) (i32.const 4))) (i32.const 8)) (i32.const 0xFF))))
  )

  ;; Set byte register (preserves other bits)
  (func $set_reg8 (param $r i32) (param $v i32)
    (local $old i32)
    (if (i32.lt_u (local.get $r) (i32.const 4))
      (then
        (local.set $old (call $get_reg (local.get $r)))
        (call $set_reg (local.get $r) (i32.or (i32.and (local.get $old) (i32.const 0xFFFFFF00)) (i32.and (local.get $v) (i32.const 0xFF)))))
      (else
        (local.set $old (call $get_reg (i32.sub (local.get $r) (i32.const 4))))
        (call $set_reg (i32.sub (local.get $r) (i32.const 4))
          (i32.or (i32.and (local.get $old) (i32.const 0xFFFF00FF))
            (i32.shl (i32.and (local.get $v) (i32.const 0xFF)) (i32.const 8))))))
  )

  ;; Get/set 16-bit register
  (func $get_reg16 (param $r i32) (result i32)
    (i32.and (call $get_reg (local.get $r)) (i32.const 0xFFFF))
  )
  (func $set_reg16 (param $r i32) (param $v i32)
    (call $set_reg (local.get $r)
      (i32.or (i32.and (call $get_reg (local.get $r)) (i32.const 0xFFFF0000))
              (i32.and (local.get $v) (i32.const 0xFFFF))))
  )

  ;; ============================================================
  ;; GUEST MEMORY
  ;; ============================================================
  ;; Null sentinel: a 4-byte region at offset 0xF0 that stays zeroed.
  ;; Used as g2w fallback so reads from invalid guest addresses see zeros
  ;; (simulating Windows null-page behavior) and writes go to a harmless sink.
  (global $NULL_SENTINEL i32 (i32.const 0xF0))
  (func $g2w (param $ga i32) (result i32)
    (local $wa i32)
    (local.set $wa (i32.add (i32.sub (local.get $ga) (global.get $image_base)) (global.get $GUEST_BASE)))
    (if (i32.or (i32.lt_s (local.get $wa) (i32.const 0))
                (i32.ge_u (local.get $wa) (i32.const 0x8000000))) ;; 128MB (full WASM memory)
      (then
        ;; Re-zero the sentinel (in case a prior bad write landed here)
        (i32.store (global.get $NULL_SENTINEL) (i32.const 0))
        (return (global.get $NULL_SENTINEL))))
    (local.get $wa)
  )
  (func $gl32 (param $ga i32) (result i32) (i32.load (call $g2w (local.get $ga))))
  (func $gl16 (param $ga i32) (result i32) (i32.load16_u (call $g2w (local.get $ga))))
  (func $gl8 (param $ga i32) (result i32) (i32.load8_u (call $g2w (local.get $ga))))
  (func $gs32 (param $ga i32) (param $v i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $ga)))
    (if (i32.and (i32.ge_u (local.get $ga) (global.get $code_start))
                 (i32.lt_u (local.get $ga) (global.get $code_end)))
      (then (call $invalidate_page (local.get $ga))))
    (i32.store (local.get $wa) (local.get $v)))
  (func $gs16 (param $ga i32) (param $v i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $ga)))
    (if (i32.and (i32.ge_u (local.get $ga) (global.get $code_start))
                 (i32.lt_u (local.get $ga) (global.get $code_end)))
      (then (call $invalidate_page (local.get $ga))))
    (i32.store16 (local.get $wa) (local.get $v)))
  (func $gs8 (param $ga i32) (param $v i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $ga)))
    (if (i32.and (i32.ge_u (local.get $ga) (global.get $code_start))
                 (i32.lt_u (local.get $ga) (global.get $code_end)))
      (then (call $invalidate_page (local.get $ga))))
    (i32.store8 (local.get $wa) (local.get $v)))

  ;; ============================================================
  ;; LAZY FLAGS
  ;; ============================================================
  (func $set_flags_add (param $a i32) (param $b i32) (param $r i32)
    (global.set $flag_op (i32.const 1)) (global.set $flag_sign_shift (i32.const 31))
    (global.set $flag_a (local.get $a)) (global.set $flag_b (local.get $b)) (global.set $flag_res (local.get $r)))
  (func $set_flags_sub (param $a i32) (param $b i32) (param $r i32)
    (global.set $flag_op (i32.const 2)) (global.set $flag_sign_shift (i32.const 31))
    (global.set $flag_a (local.get $a)) (global.set $flag_b (local.get $b)) (global.set $flag_res (local.get $r)))
  (func $set_flags_logic (param $r i32)
    (global.set $flag_op (i32.const 3)) (global.set $flag_sign_shift (i32.const 31)) (global.set $flag_res (local.get $r)))
  (func $set_flags_shift (param $r i32) (param $cf i32)
    (global.set $flag_op (i32.const 7)) (global.set $flag_sign_shift (i32.const 31)) (global.set $flag_res (local.get $r))
    (global.set $flag_b (local.get $cf)))
  (func $set_flags_inc (param $a i32) (param $r i32)
    (global.set $saved_cf (call $get_cf))  ;; INC preserves CF
    (global.set $flag_op (i32.const 4)) (global.set $flag_sign_shift (i32.const 31))
    (global.set $flag_a (local.get $a)) (global.set $flag_b (i32.const 1)) (global.set $flag_res (local.get $r)))
  (func $set_flags_dec (param $a i32) (param $r i32)
    (global.set $saved_cf (call $get_cf))  ;; DEC preserves CF
    (global.set $flag_op (i32.const 5)) (global.set $flag_sign_shift (i32.const 31))
    (global.set $flag_a (local.get $a)) (global.set $flag_b (i32.const 1)) (global.set $flag_res (local.get $r)))

  (func $get_zf (result i32) (i32.eqz (global.get $flag_res)))
  (func $get_sf (result i32) (i32.and (i32.shr_u (global.get $flag_res) (global.get $flag_sign_shift)) (i32.const 1)))
  (func $get_cf (result i32)
    (if (result i32) (i32.eq (global.get $flag_op) (i32.const 1))
      (then (i32.lt_u (global.get $flag_res) (global.get $flag_a)))
    (else (if (result i32) (i32.eq (global.get $flag_op) (i32.const 2))
      (then (i32.lt_u (global.get $flag_a) (global.get $flag_b)))
    (else (if (result i32) (i32.or (i32.eq (global.get $flag_op) (i32.const 4))
                                   (i32.eq (global.get $flag_op) (i32.const 5)))
      (then (global.get $saved_cf))  ;; INC/DEC preserve CF
    (else (if (result i32) (i32.eq (global.get $flag_op) (i32.const 6))
      (then (global.get $flag_b))  ;; MUL/IMUL: flag_b stores CF/OF
    (else (if (result i32) (i32.eq (global.get $flag_op) (i32.const 7))
      (then (global.get $flag_b))  ;; Shift: flag_b stores last bit shifted out
    (else (if (result i32) (i32.eq (global.get $flag_op) (i32.const 8))
      (then (global.get $flag_a))  ;; Raw mode: CF stored in flag_a
    (else (i32.const 0))))))))))))))
  (func $get_of (result i32)
    (local $sa i32) (local $sb i32) (local $sr i32)
    ;; Raw mode: OF stored in flag_b
    (if (i32.eq (global.get $flag_op) (i32.const 8))
      (then (return (global.get $flag_b))))
    ;; MUL/IMUL: OF = CF = flag_b
    (if (i32.eq (global.get $flag_op) (i32.const 6))
      (then (return (global.get $flag_b))))
    (local.set $sa (i32.and (i32.shr_u (global.get $flag_a) (global.get $flag_sign_shift)) (i32.const 1)))
    (local.set $sb (i32.and (i32.shr_u (global.get $flag_b) (global.get $flag_sign_shift)) (i32.const 1)))
    (local.set $sr (i32.and (i32.shr_u (global.get $flag_res) (global.get $flag_sign_shift)) (i32.const 1)))
    (if (result i32) (i32.or (i32.eq (global.get $flag_op) (i32.const 1)) (i32.eq (global.get $flag_op) (i32.const 4)))
      (then (i32.and (i32.eq (local.get $sa) (local.get $sb)) (i32.ne (local.get $sa) (local.get $sr))))
    (else (if (result i32) (i32.or (i32.eq (global.get $flag_op) (i32.const 2)) (i32.eq (global.get $flag_op) (i32.const 5)))
      (then (i32.and (i32.ne (local.get $sa) (local.get $sb)) (i32.eq (local.get $sb) (local.get $sr))))
    (else (i32.const 0))))))

  ;; Evaluate condition code (same encoding as x86 Jcc lower nibble)
  ;; 0=O,1=NO,2=B,3=AE,4=Z,5=NZ,6=BE,7=A,8=S,9=NS,A=P,B=NP,C=L,D=GE,E=LE,F=G
  (func $eval_cc (param $cc i32) (result i32)
    (local $r i32)
    (if (i32.eq (local.get $cc) (i32.const 0x0)) (then (return (call $get_of))))
    (if (i32.eq (local.get $cc) (i32.const 0x1)) (then (return (i32.eqz (call $get_of)))))
    (if (i32.eq (local.get $cc) (i32.const 0x2)) (then (return (call $get_cf))))
    (if (i32.eq (local.get $cc) (i32.const 0x3)) (then (return (i32.eqz (call $get_cf)))))
    (if (i32.eq (local.get $cc) (i32.const 0x4)) (then (return (call $get_zf))))
    (if (i32.eq (local.get $cc) (i32.const 0x5)) (then (return (i32.eqz (call $get_zf)))))
    (if (i32.eq (local.get $cc) (i32.const 0x6)) (then (return (i32.or (call $get_cf) (call $get_zf)))))
    (if (i32.eq (local.get $cc) (i32.const 0x7)) (then (return (i32.and (i32.eqz (call $get_cf)) (i32.eqz (call $get_zf))))))
    (if (i32.eq (local.get $cc) (i32.const 0x8)) (then (return (call $get_sf))))
    (if (i32.eq (local.get $cc) (i32.const 0x9)) (then (return (i32.eqz (call $get_sf)))))
    ;; 0xA=P (parity even): low byte of result has even number of set bits
    (if (i32.eq (local.get $cc) (i32.const 0xA)) (then (return (i32.eqz (i32.and (i32.popcnt (i32.and (global.get $flag_res) (i32.const 0xFF))) (i32.const 1))))))
    ;; 0xB=NP (parity odd)
    (if (i32.eq (local.get $cc) (i32.const 0xB)) (then (return (i32.and (i32.popcnt (i32.and (global.get $flag_res) (i32.const 0xFF))) (i32.const 1)))))
    ;; 0xC=L: SF!=OF
    (if (i32.eq (local.get $cc) (i32.const 0xC)) (then (return (i32.ne (call $get_sf) (call $get_of)))))
    ;; 0xD=GE: SF==OF
    (if (i32.eq (local.get $cc) (i32.const 0xD)) (then (return (i32.eq (call $get_sf) (call $get_of)))))
    ;; 0xE=LE: ZF=1 or SF!=OF
    (if (i32.eq (local.get $cc) (i32.const 0xE)) (then (return (i32.or (call $get_zf) (i32.ne (call $get_sf) (call $get_of))))))
    ;; 0xF=G: ZF=0 and SF==OF
    (i32.and (i32.eqz (call $get_zf)) (i32.eq (call $get_sf) (call $get_of)))
  )

  ;; Build EFLAGS from lazy state (for pushfd)
  (func $build_eflags (result i32)
    (i32.or (i32.or (i32.or
      (i32.shl (call $get_cf) (i32.const 0))
      (i32.const 2))  ;; bit 1 always set
      (i32.or
        (i32.shl (call $get_zf) (i32.const 6))
        (i32.shl (call $get_sf) (i32.const 7))))
      (i32.or
        (i32.shl (global.get $df) (i32.const 10))
        (i32.shl (call $get_of) (i32.const 11))))
  )

  ;; Restore flags from EFLAGS value (for popfd)
  ;; Uses flag_op=8 (raw mode): CF/ZF/SF/OF stored directly in flag globals
  (func $load_eflags (param $f i32)
    (global.set $df (i32.and (i32.shr_u (local.get $f) (i32.const 10)) (i32.const 1)))
    (global.set $flag_op (i32.const 8))  ;; raw flags mode
    ;; Store individual flag bits in globals: CF in flag_a, OF in flag_b, ZF/SF encoded in flag_res
    (global.set $flag_a (i32.and (local.get $f) (i32.const 1)))  ;; CF = bit 0
    (global.set $flag_b (i32.and (i32.shr_u (local.get $f) (i32.const 11)) (i32.const 1)))  ;; OF = bit 11
    ;; flag_res: bit 31 = SF, zero iff ZF. This makes get_zf and get_sf work with flag_sign_shift=31.
    (global.set $flag_sign_shift (i32.const 31))
    (if (i32.and (local.get $f) (i32.const 0x40))  ;; ZF = bit 6
      (then (global.set $flag_res (i32.const 0)))
      (else (if (i32.and (local.get $f) (i32.const 0x80))  ;; SF = bit 7
        (then (global.set $flag_res (i32.const 0x80000000)))
        (else (global.set $flag_res (i32.const 1))))))
  )

