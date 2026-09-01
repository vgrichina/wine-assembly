  ;; ============================================================
  ;; NON-FPU THREADED HANDLERS
  ;; Flag ops, LEAVE, BSWAP, XCHG, IMUL, the 16-bit ALU/MOV family, and every
  ;; memory-form (_ro) handler: EA computation, ALU, TEST, shifts, indirect
  ;; call/jmp, push/pop, movzx/movsx, mul/div.
  ;; 
  ;; These lived in 06-fpu.wat, which is named for the x87 unit and ends at
  ;; $th_fpu_mem_ro. Nothing here is FPU.
  ;; ============================================================

  (func $th_cld (param $op i32) (global.set $df (i32.const 0)) (NEXT))
  (func $th_std (param $op i32) (global.set $df (i32.const 1)) (NEXT))
  (func $th_clc (param $op i32)
    ;; CLC/STC/CMC modify CF only. Materialize the other lazy arithmetic flags
    ;; before changing that bit, then restore the complete flag word in raw
    ;; mode. Replacing the lazy operation here also replaced ZF/SF/OF/PF: in
    ;; particular, DOSBox emits `cmp; stc; pushfd; jz` and relies on STC leaving
    ;; the comparison's ZF intact.
    (call $load_eflags (i32.and (call $build_eflags) (i32.const 0xFFFFFFFE)))
    (NEXT))
  (func $th_stc (param $op i32)
    (call $load_eflags (i32.or (call $build_eflags) (i32.const 1)))
    (NEXT))
  (func $th_cmc (param $op i32)
    (call $load_eflags (i32.xor (call $build_eflags) (i32.const 1)))
    (NEXT))
  (func $th_leave (param $op i32)
    (global.set $esp (global.get $ebp))
    (global.set $ebp (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (NEXT))
  ;; 399: ENTER imm16,0 — the ordinary 32-bit compiler frame prologue.
  ;; Non-zero nesting levels are rejected by the decoder.
  (func $th_enter (param $op i32)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $ebp))
    (global.set $ebp (global.get $esp))
    (global.set $esp
      (i32.sub (global.get $esp) (i32.and (local.get $op) (i32.const 0xFFFF))))
    (NEXT))
  (func $th_nop2 (param $op i32) (NEXT))
  (func $th_bswap (param $op i32)
    (local $v i32) (local.set $v (call $get_reg (local.get $op)))
    (call $set_reg (local.get $op)
      (i32.or (i32.or
        (i32.shl (i32.and (local.get $v) (i32.const 0xFF)) (i32.const 24))
        (i32.shl (i32.and (i32.shr_u (local.get $v) (i32.const 8)) (i32.const 0xFF)) (i32.const 16)))
        (i32.or
          (i32.shl (i32.and (i32.shr_u (local.get $v) (i32.const 16)) (i32.const 0xFF)) (i32.const 8))
          (i32.shr_u (local.get $v) (i32.const 24)))))
    (NEXT))
  (func $th_xchg_eax_r (param $op i32)
    (local $tmp i32) (local.set $tmp (global.get $eax))
    (global.set $eax (call $get_reg (local.get $op)))
    (call $set_reg (local.get $op) (local.get $tmp)) (NEXT))
  (func $th_thunk_call (param $op i32)
    (call $win32_dispatch (local.get $op)))
  (func $th_imul_r_r (param $op i32)
    (local $d i32) (local $full i64) (local $low i32)
    (local.set $d (i32.shr_u (local.get $op) (i32.const 4)))
    (local.set $full (i64.mul
      (i64.extend_i32_s (call $get_reg (local.get $d)))
      (i64.extend_i32_s (call $get_reg (i32.and (local.get $op) (i32.const 0xF))))))
    (local.set $low (i32.wrap_i64 (local.get $full)))
    (call $set_reg (local.get $d) (local.get $low))
    (global.set $flag_op (i32.const 6))
    (global.set $flag_sign_shift (i32.const 31))
    (global.set $flag_b (i64.ne (local.get $full) (i64.extend_i32_s (local.get $low))))
    (global.set $flag_res (local.get $low))
    (NEXT))
  ;; 157: imul reg, [base+disp] — 2-operand imul with memory source (simple base)
  (func $th_imul_r_m_ro (param $op i32)
    (local $addr i32) (local $dst i32) (local $full i64) (local $low i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $dst (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $full (i64.mul
      (i64.extend_i32_s (call $get_reg (local.get $dst)))
      (i64.extend_i32_s (call $gl32 (local.get $addr)))))
    (local.set $low (i32.wrap_i64 (local.get $full)))
    (call $set_reg (local.get $dst) (local.get $low))
    (global.set $flag_op (i32.const 6))
    (global.set $flag_sign_shift (i32.const 31))
    (global.set $flag_b (i64.ne (local.get $full) (i64.extend_i32_s (local.get $low))))
    (global.set $flag_res (local.get $low))
    (NEXT))
  ;; 158: imul reg, [addr] — 2-operand imul with memory source (absolute/SIB)
  (func $th_imul_r_m_abs (param $op i32)
    (local $addr i32) (local $full i64) (local $low i32)
    (local.set $addr (call $read_addr))
    (local.set $full (i64.mul
      (i64.extend_i32_s (call $get_reg (local.get $op)))
      (i64.extend_i32_s (call $gl32 (local.get $addr)))))
    (local.set $low (i32.wrap_i64 (local.get $full)))
    (call $set_reg (local.get $op) (local.get $low))
    (global.set $flag_op (i32.const 6))
    (global.set $flag_sign_shift (i32.const 31))
    (global.set $flag_b (i64.ne (local.get $full) (i64.extend_i32_s (local.get $low))))
    (global.set $flag_res (local.get $low))
    (NEXT))
  ;; 159: r16 OP= [addr] (op=alu_op<<4|reg, addr in next word)
  (func $th_alu_r16_m16 (param $op i32)
    (local $addr i32) (local $reg i32) (local $alu i32) (local $val i32)
    (local.set $addr (call $read_addr))
    (local.set $reg (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0x7)))
    (local.set $val (call $do_alu_sized (local.get $alu) (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF)) (call $gl16 (local.get $addr)) (i32.const 0xFFFF) (i32.const 15)))
    (if (i32.ne (local.get $alu) (i32.const 7))
      (then (call $set_reg (local.get $reg) (i32.or (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF0000)) (i32.and (local.get $val) (i32.const 0xFFFF))))))
    (NEXT))
  ;; 160: [addr] OP= r16 (op=alu_op<<4|reg, addr in next word)
  (func $th_alu_m16_r16 (param $op i32)
    (local $addr i32) (local $reg i32) (local $alu i32) (local $val i32)
    (local.set $addr (call $read_addr))
    (local.set $reg (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0x7)))
    (local.set $val (call $do_alu_sized (local.get $alu) (call $gl16 (local.get $addr)) (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF)) (i32.const 0xFFFF) (i32.const 15)))
    (if (i32.ne (local.get $alu) (i32.const 7))
      (then (call $gs16 (local.get $addr) (local.get $val))))
    (NEXT))
  ;; 161: r16 OP= [base+disp] (op=alu_op<<8|reg<<4|base, disp in word)
  (func $th_alu_r16_m16_ro (param $op i32)
    (local $addr i32) (local $reg i32) (local $alu i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0x7)))
    (local.set $val (call $do_alu_sized (local.get $alu) (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF)) (call $gl16 (local.get $addr)) (i32.const 0xFFFF) (i32.const 15)))
    (if (i32.ne (local.get $alu) (i32.const 7))
      (then (call $set_reg (local.get $reg) (i32.or (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF0000)) (i32.and (local.get $val) (i32.const 0xFFFF))))))
    (NEXT))
  ;; 162: [base+disp] OP= r16 (op=alu_op<<8|reg<<4|base, disp in word)
  (func $th_alu_m16_r16_ro (param $op i32)
    (local $addr i32) (local $reg i32) (local $alu i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0x7)))
    (local.set $val (call $do_alu_sized (local.get $alu) (call $gl16 (local.get $addr)) (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF)) (i32.const 0xFFFF) (i32.const 15)))
    (if (i32.ne (local.get $alu) (i32.const 7))
      (then (call $gs16 (local.get $addr) (local.get $val))))
    (NEXT))
  ;; 163: mov [addr], r16 (op=reg, addr in next word)
  (func $th_mov_m16_r16 (param $op i32)
    (call $gs16 (call $read_addr) (i32.and (call $get_reg (local.get $op)) (i32.const 0xFFFF)))
    (NEXT))
  ;; 164: mov r16, [addr] (op=reg, addr in next word)
  (func $th_mov_r16_m16 (param $op i32)
    (local $val i32) (local.set $val (call $gl16 (call $read_addr)))
    (call $set_reg (local.get $op) (i32.or (i32.and (call $get_reg (local.get $op)) (i32.const 0xFFFF0000)) (local.get $val)))
    (NEXT))
  ;; 165: mov [base+disp], r16 (op=reg<<4|base, disp in word)
  (func $th_mov_m16_r16_ro (param $op i32)
    (local $addr i32) (local $reg i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (call $gs16 (local.get $addr) (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF)))
    (NEXT))
  ;; 166: mov r16, [base+disp] (op=reg<<4|base, disp in word)
  (func $th_mov_r16_m16_ro (param $op i32)
    (local $addr i32) (local $dst i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $dst (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $val (call $gl16 (local.get $addr)))
    (call $set_reg (local.get $dst) (i32.or (i32.and (call $get_reg (local.get $dst)) (i32.const 0xFFFF0000)) (local.get $val)))
    (NEXT))
  ;; 167: mov [addr], imm16 (op=0, addr+imm in words)
  (func $th_mov_m16_i16 (param $op i32)
    (local $addr i32)
    (local.set $addr (call $read_addr))
    (call $gs16 (local.get $addr) (call $read_thread_word))
    (NEXT))
  ;; 168: mov [base+disp], imm16 (op=base, disp+imm in words)
  (func $th_mov_m16_i16_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (i32.add (call $get_reg (local.get $op)) (call $read_thread_word)))
    (call $gs16 (local.get $addr) (call $read_thread_word))
    (NEXT))
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
    (call $gs32 (global.get $esp) (call $gl32 (call $read_addr))) (NEXT))
  (func $th_pop_m32 (param $op i32)
    (local $addr i32)
    (local.set $addr (call $read_addr))
    (call $gs32 (local.get $addr) (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (NEXT))
  (func $th_alu_m16_i16 (param $op i32)
    (local $addr i32) (local $imm i32) (local $val i32)
    ;; The immediate is masked to sixteen bits like the memory operand: a
    ;; sign-extended imm8 arrives as 0xFFFFFFxx and would compare unsigned
    ;; against a 16-bit value as though it were enormous. See $th_alu_r16_i16.
    (local.set $addr (call $read_addr))
    (local.set $imm (i32.and (call $read_thread_word) (i32.const 0xFFFF)))
    (local.set $val (call $do_alu_sized (local.get $op) (call $gl16 (local.get $addr)) (local.get $imm) (i32.const 0xFFFF) (i32.const 15)))
    (if (i32.ne (local.get $op) (i32.const 7)) (then (call $gs16 (local.get $addr) (local.get $val))))
    (NEXT))
  (func $th_load8s (param $op i32)
    (local $v i32) (local.set $v (call $gl8 (call $read_addr)))
    (if (i32.ge_u (local.get $v) (i32.const 0x80))
      (then (local.set $v (i32.or (local.get $v) (i32.const 0xFFFFFF00)))))
    (call $set_reg (local.get $op) (local.get $v)) (NEXT))
  (func $th_test_m8_i8 (param $op i32)
    (call $set_flags_logic (i32.and (call $gl8 (call $read_addr)) (local.get $op)))
    (global.set $flag_sign_shift (i32.const 7)) (NEXT))

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
    (NEXT))

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
    (NEXT))

  ;; 149: compute SIB EA → ea_temp, then continue to next handler.
  ;; op bit 8 fuses the overwhelmingly common SIB byte-load consumer; low
  ;; three bits are the destination byte register. Keeping this in the EA
  ;; handler preserves the generic SIB encoding while avoiding a second
  ;; indirect threaded dispatch and the sentinel word it used to consume.
  (func $th_compute_ea_sib (param $op i32)
    (local $info i32) (local $base_val i32) (local $index_val i32) (local $scale i32) (local $disp i32)
    (local.set $info (call $read_thread_word))
    (local.set $disp (call $read_thread_word))
    (if (global.get $handler_hist_enabled)
      (then
        (if (i32.and (local.get $op) (i32.const 0x100))
          (then
            ;; Report the semantic consumer so profiles before and after the
            ;; fusion remain directly comparable.
            (call $sib_consumer_hist_record
              (i32.const 24)
              (i32.and (local.get $op) (i32.const 7))
              (local.get $info)))
          (else
            (call $sib_consumer_hist_record
              (i32.load (global.get $ip))
              (i32.load offset=4 (global.get $ip))
              (local.get $info))))))
    (if (i32.ne (i32.and (local.get $info) (i32.const 0xF)) (i32.const 0xF))
      (then (local.set $base_val (call $get_reg (i32.and (local.get $info) (i32.const 0xF))))))
    (if (i32.ne (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF)) (i32.const 0xF))
      (then
        (local.set $scale (i32.and (i32.shr_u (local.get $info) (i32.const 8)) (i32.const 3)))
        (local.set $index_val (i32.shl
          (call $get_reg (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF)))
          (local.get $scale)))))
    (global.set $ea_temp (i32.add (i32.add (local.get $base_val) (local.get $index_val)) (local.get $disp)))
    (if (i32.and (local.get $op) (i32.const 0x100))
      (then
        (call $set_reg8
          (i32.and (local.get $op) (i32.const 7))
          (call $gl8 (global.get $ea_temp)))))
    (NEXT))

  ;; 389: MOV r32,[base+index*scale+disp]. This is deliberately separate from
  ;; handler 149: StarCraft's generated Smacker converter executes indexed
  ;; dword loads millions of times, while adding another mode branch to the
  ;; generic SIB handler slows every other SIB operation.
  (func $th_load32_sib (param $op i32)
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
    (call $set_reg (local.get $op)
      (call $gl32 (i32.add (i32.add (local.get $base_val) (local.get $index_val)) (local.get $disp))))
    (NEXT))

  ;; 400/401/402: the other three dominant SIB consumers, fused the same way
  ;; 389 fuses the dword load. Heroes II's ICN sprite blitter is the case that
  ;; forced these: a --handler-hist run of its adventure map attributes 37.7%
  ;; of every SIB EA computed to MOVSX r32, byte [eax+ecx], 24.3% to a byte
  ;; store through [ecx*4+disp] and 8.1% to a byte-immediate store, so three
  ;; quarters of the generic handler-149 traffic in that loop was paying for a
  ;; second threaded dispatch and a SIB_SENTINEL word per pixel.
  ;;
  ;; Each keeps the 149 encoding — info word then disp word — so the decoder
  ;; change is only which opcode it emits, and reports its semantic consumer to
  ;; the SIB histogram so profiles stay comparable across the fusion.
  (func $sib_ea (param $info i32) (param $disp i32) (result i32)
    (local $addr i32)
    (local.set $addr (local.get $disp))
    (if (i32.ne (i32.and (local.get $info) (i32.const 0xF)) (i32.const 0xF))
      (then (local.set $addr (i32.add (local.get $addr)
        (call $get_reg (i32.and (local.get $info) (i32.const 0xF)))))))
    (if (i32.ne (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF)) (i32.const 0xF))
      (then (local.set $addr (i32.add (local.get $addr) (i32.shl
        (call $get_reg (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF)))
        (i32.and (i32.shr_u (local.get $info) (i32.const 8)) (i32.const 3)))))))
    (local.get $addr))

  ;; 400: MOVSX r32, byte [base+index*scale+disp]
  (func $th_movsx8_sib (param $op i32)
    (local $info i32) (local $v i32)
    (local.set $info (call $read_thread_word))
    (if (global.get $handler_hist_enabled)
      (then (call $sib_consumer_hist_record (i32.const 79) (local.get $op) (local.get $info))))
    (local.set $v (call $gl8 (call $sib_ea (local.get $info) (call $read_thread_word))))
    (if (i32.ge_u (local.get $v) (i32.const 0x80))
      (then (local.set $v (i32.or (local.get $v) (i32.const 0xFFFFFF00)))))
    (call $set_reg (local.get $op) (local.get $v))
    (NEXT))

  ;; 401: MOV byte [base+index*scale+disp], r8
  (func $th_store8_sib (param $op i32)
    (local $info i32)
    (local.set $info (call $read_thread_word))
    (if (global.get $handler_hist_enabled)
      (then (call $sib_consumer_hist_record (i32.const 25) (local.get $op) (local.get $info))))
    (call $gs8 (call $sib_ea (local.get $info) (call $read_thread_word))
      (call $get_reg8 (local.get $op)))
    (NEXT))

  ;; 402: MOV byte [base+index*scale+disp], imm8 (op = the immediate)
  (func $th_mov_m8_i8_sib (param $op i32)
    (local $info i32)
    (local.set $info (call $read_thread_word))
    (if (global.get $handler_hist_enabled)
      (then (call $sib_consumer_hist_record (i32.const 77) (local.get $op) (local.get $info))))
    (call $gs8 (call $sib_ea (local.get $info) (call $read_thread_word)) (local.get $op))
    (NEXT))

  ;; 420: MOV dword [base+index*scale+disp], r32 — the dword twin of 401.
  ;; Caesar III's RLE sprite decoder (0x0040f6d9) is the case that forced this
  ;; one: its per-length unrolled copy runs are `mov eax,[esi+k]` /
  ;; `mov [edi+edx*1+k],eax` pairs, and a --handler-hist run of the city view
  ;; attributes 96.66% of every SIB EA computed — 11,248,380 of them — to this
  ;; single consumer shape. Before the fusion each copied dword paid for a
  ;; second threaded dispatch and a SIB_SENTINEL word.
  ;;
  ;; Separate handler rather than another mode bit in 149, for the reason 389
  ;; states: an extra branch there is paid by every other SIB operation, and
  ;; docs/aoe-performance-optimization.md measured broad SIB fusions losing
  ;; more than they saved. Keeps the 149 encoding (info word, then disp), so
  ;; the decoder change is only which opcode it emits.
  (func $th_store32_sib (param $op i32)
    (local $info i32)
    ;; Charge the step the fused-away dispatch would have cost. $next bills
    ;; $steps once per dispatch, so without this the guest advances ~12%
    ;; further per host batch on this workload and every frame captured at a
    ;; fixed batch number lands on a different game state -- DX-Ball's
    ;; ball-animation frames caught it. $th_copy_run's `cost` word is the same
    ;; contract: how an instruction is LOWERED must not change how much guest
    ;; work a batch buys. The win here is the removed call_indirect, the
    ;; SIB_SENTINEL word and the $ea_temp round trip, not the step.
    (global.set $steps (i32.sub (global.get $steps) (i32.const 1)))
    (local.set $info (call $read_thread_word))
    (if (global.get $handler_hist_enabled)
      (then (call $sib_consumer_hist_record (i32.const 21) (local.get $op) (local.get $info))))
    (call $gs32 (call $sib_ea (local.get $info) (call $read_thread_word))
      (call $get_reg (local.get $op)))
    (NEXT))

  ;; 421: the whole copied dword —
  ;;
  ;;   mov  r32, [base+disp]                 ; H345 when base is esi
  ;;   mov  [base+index*scale+disp], r32     ; H420 since the fusion above
  ;;
  ;; which is what Caesar III's unrolled sprite blitters are made of -- ~787
  ;; of them between 0x0041cf11 and 0x004ffefd, one per tile shape, each a
  ;; diamond of rows 1, 3, 5, 7 ... dwords wide with an `add edx,ecx` between
  ;; rows and no branch from the prologue to the ret. Together they were
  ;; 21.3M dispatches, 5.2% of a Caesar gameplay drive. 420 already removed
  ;; the second of the three dispatches each dword used to cost; this removes
  ;; the first, so a copied dword is one dispatch and three operand words
  ;; instead of three dispatches and four. Handler 422 below folds a whole
  ;; sprite when it can; this stays the fallback for a pair that stands alone
  ;; and for the tail of a run 422 declined.
  ;;
  ;; (Two earlier revisions of this comment named the wrong site. The RLE
  ;; decoder at 0x0040f6d9 stores through `mov [edi+0x4],eax`, a simple base
  ;; form that goes to 354, so this never fires there; and the rectangular
  ;; tile blit at 0x00410407 does not execute at all -- it is absent from
  ;; every one of the 1859 blocks a gameplay drive enters.)
  ;;
  ;; op = src_base | dst_reg<<4; words follow in x86 order: src disp, then the
  ;; store's 149-style info word, then its disp.
  ;;
  ;; The register is written BEFORE the store address is computed, because it
  ;; may be part of that address -- `mov edx,[esi+4] / mov [edi+edx*1],edx` is a
  ;; legal member of this family and reads the new edx. Doing it in x86 order
  ;; costs nothing and means the fusion needs no predicate about which registers
  ;; may overlap.
  (func $th_copy32_ro_to_sib (param $op i32)
    (local $v i32) (local $info i32)
    ;; Two dispatches folded away, so two steps to charge on top of the one
    ;; $next bills -- see 420's note. Three total, matching what H345 + H149 +
    ;; H21 billed before either fusion existed, so pacing is unchanged by how
    ;; deep the lowering goes.
    (global.set $steps (i32.sub (global.get $steps) (i32.const 2)))
    (local.set $v (call $gl32 (i32.add
      (call $get_reg (i32.and (local.get $op) (i32.const 0xF)))
      (call $read_thread_word))))
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4)) (local.get $v))
    (local.set $info (call $read_thread_word))
    ;; Report the store, not the fusion: the SIB EA this computes is consumed by
    ;; a store32 exactly as it was before, and a profile that renamed it would
    ;; stop being comparable across the change.
    (if (global.get $handler_hist_enabled)
      (then (call $sib_consumer_hist_record (i32.const 21)
              (i32.shr_u (local.get $op) (i32.const 4)) (local.get $info))))
    (call $gs32 (call $sib_ea (local.get $info) (call $read_thread_word))
      (local.get $v))
    (NEXT))

  ;; 422: the re-rolled sprite run.
  ;;
  ;; Caesar III draws its isometric tiles out of fully unrolled blitters --
  ;; ~787 of them between 0x0041cf11 and 0x004ffefd, one per sprite shape.
  ;; Each is a diamond: rows of 1, 3, 5, 7 ... dwords, every row a straight
  ;; line of `mov eax,[esi+k] / mov [edi+edx+d],eax` pairs with an
  ;; `add edx,ecx` between rows and no branch anywhere from the prologue to
  ;; the ret. That is still a loop -- it just carries its trip counts and its
  ;; destination offsets in the instruction encoding instead of in registers,
  ;; and the row widths differ, which is why a fixed rows x cols rectangle
  ;; could not describe it. 421 already brought each pair down to one
  ;; dispatch; this brings a whole sprite down to one.
  ;;
  ;; The difference from COPY_RUN (419) is exactly why this one is safe to
  ;; enable by default while that one is not. 419 has to *infer* its cursors,
  ;; stride and counter from a loop body, and gets them wrong on Storm's MPQ
  ;; sliding-window copy. Nothing is inferred here: the decoder reads literal
  ;; consecutive displacements and refuses unless every one of them is the
  ;; value the run predicts. It is also dword-granular and two-dimensional,
  ;; so 419's byte cursors and single counter could not have expressed it
  ;; even if they were trustworthy.
  ;;
  ;;   op   = src_base | scratch<<4 | dst_base<<8 | dst_index<<12
  ;;          | step_reg<<16 | scale<<20
  ;;   w0   nrows
  ;;   w1   src_disp        displacement of the very first load
  ;;   w2   pairs           dwords copied by the whole run
  ;;   w3   cost            steps the unrolled form billed
  ;;   then nrows pairs of (cols, dst_disp) -- the row's width and the
  ;;   displacement of its first store. Source displacements are not stored:
  ;;   they run contiguously from w1 across the whole sprite, which the
  ;;   decoder checked byte by byte.
  ;;
  ;; Registers the copy addresses through are read once, before the first
  ;; store: the decoder guarantees the scratch register is none of them, so
  ;; there is no address that a store could change under us. The row cursor
  ;; (dst_index) is stepped arithmetically rather than written back per row,
  ;; and lands on idx0 + (nrows-1)*step -- the adds sit *between* rows, so
  ;; there are one fewer of them than there are rows.
  ;; 423: a whole `cmp al,imm8 / jz target` ladder -- a switch, as a compiler
  ;; that would not build a jump table emits it. Caesar III's RLE sprite
  ;; decoder opens with sixteen of them at 0x40f725..0x40f7a3, and walking to
  ;; case k costs k block ends: the ladder is 24.0% of all block entries in a
  ;; gameplay window and H154->H311 is the single busiest handler pair in the
  ;; program (7.69%). One dispatch does the whole ladder here.
  ;;
  ;; Descriptor at $ip: [default_eip] then N x [imm, target]. $op = N.
  ;;
  ;; The scan is still linear, which is deliberate. A 256-entry jump table
  ;; would be O(1) but costs 1KB of chunk per site against a 16KB chunk cap,
  ;; and the win here is not the comparisons -- sixteen native i32.eq are
  ;; nothing -- it is the k dispatches, k eip stores and k index lookups the
  ;; comparisons used to be wrapped in.
  (func $th_case_chain (param $op i32)
    (local $tp i32) (local $n i32) (local $i i32) (local $a i32)
    (local $imm i32) (local $hit i32) (local $k i32) (local $r i32)
    (local.set $n (local.get $op))
    (local.set $tp (global.get $ip))
    ;; default word + N (imm, target) pairs
    (global.set $ip (i32.add (local.get $tp)
      (i32.shl (i32.add (i32.const 1) (i32.shl (local.get $n) (i32.const 1)))
               (i32.const 2))))

    (local.set $a (call $get_reg8 (i32.const 0)))   ;; AL
    (local.set $hit (i32.const -1))
    (local.set $i (i32.const 0))
    (block $found (loop $l
      (br_if $found (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $imm (i32.load (i32.add (local.get $tp)
        (i32.shl (i32.add (i32.const 1) (i32.shl (local.get $i) (i32.const 1)))
                 (i32.const 2)))))
      (if (i32.eq (local.get $a) (local.get $imm))
        (then (local.set $hit (local.get $i)) (br $found)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))

    ;; How many compares really happened: through the match, or all of them.
    (local.set $k (if (result i32) (i32.ge_s (local.get $hit) (i32.const 0))
      (then (local.get $hit)) (else (i32.sub (local.get $n) (i32.const 1)))))

    ;; Flags are those of the LAST cmp executed, and only that one is
    ;; observable: every earlier cmp in the ladder is consumed by its own jz
    ;; and then overwritten by the next cmp. Same publication as
    ;; $th_alu_r8_i8's CMP arm, byte sign bit included.
    (local.set $imm (i32.load (i32.add (local.get $tp)
      (i32.shl (i32.add (i32.const 1) (i32.shl (local.get $k) (i32.const 1)))
               (i32.const 2)))))
    (local.set $r (i32.and (i32.sub (local.get $a) (local.get $imm))
                           (i32.const 0xFF)))
    (call $set_flags_sub (local.get $a) (local.get $imm) (local.get $r))
    (global.set $flag_sign_shift (i32.const 7))

    ;; Pacing contract, as 420/421/422: how deep the lowering goes must not
    ;; change how much guest work a host batch buys, or a frame captured at a
    ;; fixed batch number lands somewhere else. The ladder billed one step per
    ;; cmp and one per jz. $next already billed one of them.
    (global.set $steps (i32.sub (global.get $steps)
      (i32.sub (i32.shl (i32.add (local.get $k) (i32.const 1)) (i32.const 1))
               (i32.const 1))))

    ;; $steps is not the only meter. Every jz in the unfolded ladder ended a
    ;; block, and $branch_end spends one $block_budget per transfer, so a fold
    ;; that pays only in steps buys the guest extra work per host batch --
    ;; measured as +2.8% API calls over the same 3400 batches, which moves the
    ;; captured frame and makes an A/B compare two different moments in the
    ;; game. Charge the k transfers this dispatch replaced.
    (global.set $block_budget
      (i32.sub (global.get $block_budget) (local.get $k)))

    ;; And the histogram has to keep counting the cmps and jzs it replaced, or
    ;; op totals stop being comparable with a --no-case-chain build. Recording
    ;; them alternately also reproduces the H154->H311 pair this fold exists
    ;; to delete, which is what makes the before/after readable.
    (if (global.get $handler_hist_enabled)
      (then
        (local.set $i (i32.const 0))
        (block $hdone (loop $h
          (br_if $hdone (i32.gt_u (local.get $i) (local.get $k)))
          (call $handler_hist_record (i32.const 154))
          (call $handler_hist_record (i32.const 311))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $h)))))

    (global.set $eip (if (result i32) (i32.ge_s (local.get $hit) (i32.const 0))
      (then (i32.load (i32.add (local.get $tp)
        (i32.shl (i32.add (i32.const 2) (i32.shl (local.get $hit) (i32.const 1)))
                 (i32.const 2)))))
      (else (i32.load (local.get $tp)))))
    (return_call $branch_end))

  (func $th_rect_run (param $op i32)
    (local $tp i32) (local $nrows i32) (local $cols i32) (local $pairs i32)
    (local $src_disp i32) (local $dst_disp i32) (local $rp i32)
    (local $cost i32) (local $scale i32)
    (local $src i32) (local $dbase i32) (local $idx0 i32) (local $step i32)
    (local $r i32) (local $c i32) (local $idx i32)
    (local $src_ga i32) (local $dst_ga i32) (local $sw i32) (local $dw i32)
    (local $row_bytes i32) (local $v i32) (local $info i32) (local $scratch i32)

    (local.set $tp (global.get $ip))
    (local.set $nrows      (i32.load          (local.get $tp)))
    (local.set $src_disp   (i32.load offset=4  (local.get $tp)))
    (local.set $pairs      (i32.load offset=8  (local.get $tp)))
    (local.set $cost       (i32.load offset=12 (local.get $tp)))
    (local.set $rp (i32.add (local.get $tp) (i32.const 16)))
    (global.set $ip
      (i32.add (local.get $rp) (i32.shl (local.get $nrows) (i32.const 3))))

    ;; Same pacing contract as 420/421: how deep the lowering goes must not
    ;; change how much guest work a host batch buys. $next already billed one.
    (global.set $steps
      (i32.sub (global.get $steps) (i32.sub (local.get $cost) (i32.const 1))))

    (local.set $scratch (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $scale (i32.and (i32.shr_u (local.get $op) (i32.const 20)) (i32.const 3)))
    (local.set $src   (call $get_reg (i32.and (local.get $op) (i32.const 0xF))))
    (local.set $dbase (call $get_reg (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF))))
    (local.set $idx0  (call $get_reg (i32.and (i32.shr_u (local.get $op) (i32.const 12)) (i32.const 0xF))))
    (local.set $step  (call $get_reg (i32.and (i32.shr_u (local.get $op) (i32.const 16)) (i32.const 0xF))))

    ;; The histogram has to keep counting one store per copied dword, or the
    ;; op totals stop being comparable with a build that has this fold off.
    (if (global.get $handler_hist_enabled)
      (then
        (local.set $info (i32.or
          (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF))
          (i32.or
            (i32.shl (i32.and (i32.shr_u (local.get $op) (i32.const 12)) (i32.const 0xF))
                     (i32.const 4))
            (i32.shl (local.get $scale) (i32.const 8)))))
        (local.set $c (local.get $pairs))
        (block $hdone (loop $h
          (br_if $hdone (i32.eqz (local.get $c)))
          (call $sib_consumer_hist_record (i32.const 21)
            (local.get $scratch) (local.get $info))
          (local.set $c (i32.sub (local.get $c) (i32.const 1)))
          (br $h)))))

    (local.set $src_ga (i32.add (local.get $src) (local.get $src_disp)))
    (local.set $r (i32.const 0))
    (block $rdone (loop $rl
      (br_if $rdone (i32.ge_u (local.get $r) (local.get $nrows)))
      (local.set $cols     (i32.load         (local.get $rp)))
      (local.set $dst_disp (i32.load offset=4 (local.get $rp)))
      (local.set $rp (i32.add (local.get $rp) (i32.const 8)))
      (local.set $row_bytes (i32.shl (local.get $cols) (i32.const 2)))
      (local.set $idx (i32.add (local.get $idx0)
        (i32.mul (local.get $r) (local.get $step))))
      (local.set $dst_ga (i32.add (local.get $dbase) (i32.add
        (i32.shl (local.get $idx) (local.get $scale)) (local.get $dst_disp))))

      ;; $g2w is affine inside a 4 KB page -- the same invariant $gl32's fast
      ;; path and $th_copy_run's chunking both rely on -- so a row that starts
      ;; and ends in one page needs one translation, one bounds decision and
      ;; one code-page test for all of it. A row that straddles a page, or
      ;; either end of which is unmapped, takes the ordinary per-dword path;
      ;; that is not a rare-case shortcut, it is literally what the unrolled
      ;; instructions did.
      (local.set $sw (call $g2w (local.get $src_ga)))
      (local.set $dw (call $g2w (local.get $dst_ga)))
      (if (i32.and
            (i32.and (i32.ne (local.get $sw) (global.get $NULL_SENTINEL))
                     (i32.ne (local.get $dw) (global.get $NULL_SENTINEL)))
            (i32.and (i32.le_u (local.get $row_bytes) (i32.const 0x1000))
              (i32.and
                (i32.le_u (i32.and (local.get $src_ga) (i32.const 0xFFF))
                          (i32.sub (i32.const 0x1000) (local.get $row_bytes)))
                (i32.le_u (i32.and (local.get $dst_ga) (i32.const 0xFFF))
                          (i32.sub (i32.const 0x1000) (local.get $row_bytes))))))
        (then
          (call $invalidate_code_write (local.get $dst_ga) (local.get $row_bytes))
          ;; The guard above proved the whole row is one affine span at each
          ;; end, so the move is a single (dst, src, len) -- except when the
          ;; destination overlaps the source from above. memory.copy is
          ;; memmove; the unrolled `mov`s this fold replaces went forward one
          ;; dword at a time and SMEAR in that case, which a guest scroll blit
          ;; can depend on. Same split $th_rep_movsb makes, same reason.
          (if (i32.and (i32.lt_u (local.get $sw) (local.get $dw))
                       (i32.lt_u (local.get $dw)
                                 (i32.add (local.get $sw) (local.get $row_bytes))))
            (then
              (local.set $c (local.get $cols))
              (loop $fast
                (local.set $v (i32.load (local.get $sw)))
                (i32.store (local.get $dw) (local.get $v))
                (local.set $sw (i32.add (local.get $sw) (i32.const 4)))
                (local.set $dw (i32.add (local.get $dw) (i32.const 4)))
                (local.set $c (i32.sub (local.get $c) (i32.const 1)))
                (br_if $fast (local.get $c))))
            (else
              ;; $v is the last dword the row moved, read before the copy so a
              ;; destination lying below the source cannot have overwritten it.
              (local.set $v (i32.load
                (i32.sub (i32.add (local.get $sw) (local.get $row_bytes)) (i32.const 4))))
              (memory.copy (local.get $dw) (local.get $sw) (local.get $row_bytes))))
          ;; The slow path leaves $src_ga past the row it just copied; this
          ;; one walks $sw instead, so it owes that advance here.
          (local.set $src_ga (i32.add (local.get $src_ga) (local.get $row_bytes))))
        (else
          (local.set $c (local.get $cols))
          (loop $slow
            (local.set $v (call $gl32 (local.get $src_ga)))
            (call $gs32 (local.get $dst_ga) (local.get $v))
            (local.set $src_ga (i32.add (local.get $src_ga) (i32.const 4)))
            (local.set $dst_ga (i32.add (local.get $dst_ga) (i32.const 4)))
            (local.set $c (i32.sub (local.get $c) (i32.const 1)))
            (br_if $slow (local.get $c)))))
      (local.set $r (i32.add (local.get $r) (i32.const 1)))
      (br $rl)))

    ;; $v holds the last dword either path moved, which is what the final
    ;; `mov scratch,[...]` left in the register.
    (call $set_reg (local.get $scratch) (local.get $v))
    (local.set $idx (i32.add (local.get $idx0)
      (i32.mul (i32.sub (local.get $nrows) (i32.const 1)) (local.get $step))))
    (call $set_reg (i32.and (i32.shr_u (local.get $op) (i32.const 12)) (i32.const 0xF))
      (local.get $idx))
    ;; Only the last `add` is observable -- nothing between the rows reads
    ;; flags -- so publish that one.
    (call $set_flags_add
      (i32.sub (local.get $idx) (local.get $step)) (local.get $step) (local.get $idx))
    (NEXT))

  ;; Read one byte from a span whose complete affine mapping was proved once.
  ;; NULL_SENTINEL retains the ordinary guest-mapping fallback for page/sparse
  ;; edges; offset is always bounded by the caller's proved span.
  (func $lut_span8_load (param $ga i32) (param $wa i32) (param $offset i32)
                        (result i32)
    (if (result i32) (i32.eq (local.get $wa) (global.get $NULL_SENTINEL))
      (then (call $gl8 (i32.add (local.get $ga) (local.get $offset))))
      (else (i32.load8_u (i32.add (local.get $wa) (local.get $offset))))))

  ;; H431 mode 2: Jazz 2's compiler-unrolled fixed-offset lighting kernel.
  ;; It reads pixels 2,3,0,1,6,7, publishes the first packed dword, then reads
  ;; 4,5 and publishes the second. Keeping that order (instead of eagerly
  ;; gathering all eight bytes) preserves even pathological table/destination
  ;; or frame/destination aliasing exactly like the guest instruction stream.
  (func $th_lut_span8_rows (param $op i32)
    (local $pix_reg i32) (local $eax_reg i32) (local $frame_reg i32)
    (local $edx_reg i32) (local $esi_reg i32)
    (local $selector_disp i32) (local $rows_disp i32) (local $cost i32)
    (local $table_abs i32) (local $eax_disp i32) (local $ebx_disp i32)
    (local $ecx_disp i32)
    (local $pix i32) (local $frame i32) (local $selector i32)
    (local $rows i32) (local $table i32) (local $row0_ga i32)
    (local $row1_ga i32) (local $pix_wa i32) (local $row0_wa i32)
    (local $row1_wa i32)
    (local $p0 i32) (local $p1 i32) (local $p2 i32) (local $p3 i32)
    (local $p4 i32) (local $p5 i32) (local $p6 i32) (local $p7 i32)
    (local $w0 i32) (local $w1 i32)

    (local.set $pix_reg (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $eax_reg
      (i32.and (i32.shr_u (local.get $op) (i32.const 12)) (i32.const 0xF)))
    (local.set $frame_reg
      (i32.and (i32.shr_u (local.get $op) (i32.const 20)) (i32.const 0xF)))
    (local.set $edx_reg
      (i32.and (i32.shr_u (local.get $op) (i32.const 24)) (i32.const 0xF)))
    (local.set $esi_reg
      (i32.and (i32.shr_u (local.get $op) (i32.const 28)) (i32.const 0xF)))
    (local.set $selector_disp (call $read_thread_word))
    (local.set $rows_disp (call $read_thread_word))
    (local.set $cost (call $read_thread_word))
    (local.set $table_abs (call $read_thread_word))
    (local.set $eax_disp (call $read_thread_word))
    (local.set $ebx_disp (call $read_thread_word))
    (local.set $ecx_disp (call $read_thread_word))

    (local.set $pix (call $get_reg (local.get $pix_reg)))
    (local.set $frame (call $get_reg (local.get $frame_reg)))
    (local.set $selector
      (i32.and (call $gl32 (i32.add (local.get $frame) (local.get $selector_disp)))
               (i32.const 1)))
    (local.set $rows
      (call $gl32
        (i32.add
          (i32.add (local.get $frame) (local.get $rows_disp))
          (i32.shl (local.get $selector) (i32.const 2)))))
    (local.set $table
      (i32.add (local.get $table_abs)
        (i32.and (call $get_reg (i32.const 1)) (i32.const 0xFF00))))
    (local.set $row0_ga
      (i32.add (local.get $table)
        (i32.shl (i32.and (local.get $rows) (i32.const 0xFF)) (i32.const 8))))
    (local.set $row1_ga
      (i32.add (local.get $table) (i32.and (local.get $rows) (i32.const 0xFF00))))
    (local.set $pix_wa (call $g2w_affine_span (local.get $pix) (i32.const 8)))
    (local.set $row0_wa
      (call $g2w_affine_span (local.get $row0_ga) (i32.const 256)))
    (local.set $row1_wa
      (call $g2w_affine_span (local.get $row1_ga) (i32.const 256)))

    (local.set $p2 (call $lut_span8_load (local.get $pix) (local.get $pix_wa)
                         (i32.const 2)))
    (local.set $p2 (call $lut_span8_load (local.get $row0_ga) (local.get $row0_wa)
                         (local.get $p2)))
    (local.set $p3 (call $lut_span8_load (local.get $pix) (local.get $pix_wa)
                         (i32.const 3)))
    (local.set $p3 (call $lut_span8_load (local.get $row1_ga) (local.get $row1_wa)
                         (local.get $p3)))
    (local.set $p0 (call $lut_span8_load (local.get $pix) (local.get $pix_wa)
                         (i32.const 0)))
    (local.set $p0 (call $lut_span8_load (local.get $row0_ga) (local.get $row0_wa)
                         (local.get $p0)))
    (local.set $p1 (call $lut_span8_load (local.get $pix) (local.get $pix_wa)
                         (i32.const 1)))
    (local.set $p1 (call $lut_span8_load (local.get $row1_ga) (local.get $row1_wa)
                         (local.get $p1)))
    (local.set $p6 (call $lut_span8_load (local.get $pix) (local.get $pix_wa)
                         (i32.const 6)))
    (local.set $p6 (call $lut_span8_load (local.get $row0_ga) (local.get $row0_wa)
                         (local.get $p6)))
    (local.set $p7 (call $lut_span8_load (local.get $pix) (local.get $pix_wa)
                         (i32.const 7)))
    (local.set $p7 (call $lut_span8_load (local.get $row1_ga) (local.get $row1_wa)
                         (local.get $p7)))
    (local.set $w0
      (i32.or (local.get $p0)
        (i32.or (i32.shl (local.get $p1) (i32.const 8))
          (i32.or (i32.shl (local.get $p2) (i32.const 16))
                  (i32.shl (local.get $p3) (i32.const 24))))))
    (call $invalidate_code_write (local.get $pix) (i32.const 8))
    (if (i32.eq (local.get $pix_wa) (global.get $NULL_SENTINEL))
      (then (call $gs32 (local.get $pix) (local.get $w0)))
      (else (i32.store (local.get $pix_wa) (local.get $w0))))

    (local.set $p4 (call $lut_span8_load (local.get $pix) (local.get $pix_wa)
                         (i32.const 4)))
    (local.set $p4 (call $lut_span8_load (local.get $row0_ga) (local.get $row0_wa)
                         (local.get $p4)))
    (local.set $p5 (call $lut_span8_load (local.get $pix) (local.get $pix_wa)
                         (i32.const 5)))
    (local.set $p5 (call $lut_span8_load (local.get $row1_ga) (local.get $row1_wa)
                         (local.get $p5)))
    (local.set $w1
      (i32.or (local.get $p4)
        (i32.or (i32.shl (local.get $p5) (i32.const 8))
          (i32.or (i32.shl (local.get $p6) (i32.const 16))
                  (i32.shl (local.get $p7) (i32.const 24))))))
    (if (i32.eq (local.get $pix_wa) (global.get $NULL_SENTINEL))
      (then (call $gs32 (i32.add (local.get $pix) (i32.const 4)) (local.get $w1)))
      (else (i32.store offset=4 (local.get $pix_wa) (local.get $w1))))

    ;; Exact architectural state at 0x474e6e. EDI/EBP are unchanged; the three
    ;; frame loads occur after both stores in the guest and therefore stay last
    ;; here too when a deliberately aliased probe exercises that ordering.
    (call $set_reg (local.get $eax_reg)
      (call $gl32 (i32.add (local.get $frame) (local.get $eax_disp))))
    (call $set_reg (i32.const 3)
      (call $gl32 (i32.add (local.get $frame) (local.get $ebx_disp))))
    (call $set_reg (i32.const 1)
      (call $gl32 (i32.add (local.get $frame) (local.get $ecx_disp))))
    (call $set_reg (local.get $edx_reg) (local.get $w1))
    (call $set_reg (local.get $esi_reg) (local.get $table))
    (call $set_flags_logic (local.get $w1))
    (global.set $steps
      (i32.sub (global.get $steps) (i32.sub (local.get $cost) (i32.const 1))))
    (global.set $lut_span_runs
      (i32.add (global.get $lut_span_runs) (i32.const 1)))
    (global.set $lut_span_bytes
      (i64.add (global.get $lut_span_bytes) (i64.const 8)))
    (NEXT))

  ;; 431: a fixed, straight-line LUT span selected through a Duff-style jump
  ;; table. This is the nonterminal sibling of H418: bases are snapshots and
  ;; remain architecturally unchanged, the descriptor supplies a compiled
  ;; count, and execution continues with the row tail through $next.
  ;;
  ;; op nibbles: src1, dst-base, table-base (F=absolute), accumulator,
  ;; mode (0=table[src], 1=table[(src1<<8)|src2]), src2, dst-index, aux.
  ;; Six words: start displacement, count, original instruction cost,
  ;; table displacement, final aux kind, final aux displacement.
  (func $th_lut_span (param $op i32)
    (local $src1_reg i32) (local $dst_reg i32) (local $tbl_reg i32)
    (local $acc_reg i32) (local $mode i32) (local $src2_reg i32)
    (local $didx_reg i32) (local $aux_reg i32)
    (local $start i32) (local $count i32) (local $cost i32)
    (local $tbl_disp i32) (local $aux_kind i32) (local $aux_disp i32)
    (local $src1 i32) (local $src2 i32) (local $dst i32) (local $tbl i32)
    (local $src1_ga i32) (local $src2_ga i32) (local $dst_ga i32)
    (local $src1_wa i32) (local $src2_wa i32) (local $dst_wa i32)
    (local $tbl_wa i32) (local $tbl_end_wa i32) (local $tbl_range i32)
    (local $disp i32) (local $n i32) (local $a i32) (local $b i32)
    (local $index i32) (local $out i32)

    (local.set $src1_reg (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $dst_reg
      (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $tbl_reg
      (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $acc_reg
      (i32.and (i32.shr_u (local.get $op) (i32.const 12)) (i32.const 0xF)))
    (local.set $mode
      (i32.and (i32.shr_u (local.get $op) (i32.const 16)) (i32.const 0xF)))
    (local.set $src2_reg
      (i32.and (i32.shr_u (local.get $op) (i32.const 20)) (i32.const 0xF)))
    (local.set $didx_reg
      (i32.and (i32.shr_u (local.get $op) (i32.const 24)) (i32.const 0xF)))
    (local.set $aux_reg
      (i32.and (i32.shr_u (local.get $op) (i32.const 28)) (i32.const 0xF)))

    (if (i32.eq (local.get $mode) (i32.const 2))
      (then (return_call $th_lut_span8_rows (local.get $op))))

    (local.set $start (call $read_thread_word))
    (local.set $count (call $read_thread_word))
    (local.set $cost (call $read_thread_word))
    (local.set $tbl_disp (call $read_thread_word))
    (local.set $aux_kind (call $read_thread_word))
    (local.set $aux_disp (call $read_thread_word))

    (local.set $src1 (call $get_reg (local.get $src1_reg)))
    (local.set $dst (call $get_reg (local.get $dst_reg)))
    (if (i32.ne (local.get $didx_reg) (i32.const 0xF))
      (then (local.set $dst
        (i32.add (local.get $dst) (call $get_reg (local.get $didx_reg))))))
    (if (i32.ne (local.get $tbl_reg) (i32.const 0xF))
      (then (local.set $tbl (i32.add
        (call $get_reg (local.get $tbl_reg)) (local.get $tbl_disp))))
      (else (local.set $tbl (local.get $tbl_disp))))
    (if (local.get $mode)
      (then (local.set $src2 (call $get_reg (local.get $src2_reg)))))

    (local.set $src1_ga (i32.add (local.get $src1) (local.get $start)))
    (local.set $dst_ga (i32.add (local.get $dst) (local.get $start)))
    (if (local.get $mode)
      (then (local.set $src2_ga (i32.add (local.get $src2) (local.get $start)))))

    ;; The span is descending. Translate source/destination streams once when
    ;; their whole range stays in one guest page; otherwise the ordinary
    ;; helpers preserve every mapping/null-page edge case byte by byte.
    (if (i32.ge_u (i32.and (local.get $src1_ga) (i32.const 0xFFF))
                   (i32.sub (local.get $count) (i32.const 1)))
      (then
        (local.set $src1_wa (call $g2w (local.get $src1_ga)))
        (if (i32.eq (local.get $src1_wa) (global.get $NULL_SENTINEL))
          (then (local.set $src1_wa (i32.const 0))))))
    (if (i32.ge_u (i32.and (local.get $dst_ga) (i32.const 0xFFF))
                   (i32.sub (local.get $count) (i32.const 1)))
      (then
        (local.set $dst_wa (call $g2w (local.get $dst_ga)))
        (if (i32.eq (local.get $dst_wa) (global.get $NULL_SENTINEL))
          (then (local.set $dst_wa (i32.const 0))))))
    (if (local.get $mode)
      (then
        (if (i32.ge_u (i32.and (local.get $src2_ga) (i32.const 0xFFF))
                       (i32.sub (local.get $count) (i32.const 1)))
          (then
            (local.set $src2_wa (call $g2w (local.get $src2_ga)))
            (if (i32.eq (local.get $src2_wa) (global.get $NULL_SENTINEL))
              (then (local.set $src2_wa (i32.const 0))))))))

    ;; Only the normal direct guest window is known affine over the complete
    ;; 256-byte or 64KB table. Sparse/DIB mappings may have individually valid
    ;; endpoints with a hole between them, so they deliberately stay on gl8.
    (local.set $tbl_range
      (select (i32.const 0xFFFF) (i32.const 0xFF) (local.get $mode)))
    (local.set $tbl_wa (call $g2w (local.get $tbl)))
    (local.set $tbl_end_wa
      (call $g2w (i32.add (local.get $tbl) (local.get $tbl_range))))
    (if (i32.or
          (i32.ne (local.get $tbl_wa)
            (i32.add (i32.sub (local.get $tbl) (global.get $image_base))
                     (global.get $GUEST_BASE)))
          (i32.ne (local.get $tbl_end_wa)
            (i32.add
              (i32.sub (i32.add (local.get $tbl) (local.get $tbl_range))
                       (global.get $image_base))
              (global.get $GUEST_BASE))))
      (then (local.set $tbl_wa (i32.const 0))))

    (call $invalidate_code_write
      (i32.sub (local.get $dst_ga) (i32.sub (local.get $count) (i32.const 1)))
      (local.get $count))
    (local.set $disp (local.get $start))
    (local.set $n (local.get $count))
    (loop $pixels
      (if (local.get $src1_wa)
        (then (local.set $a (i32.load8_u (local.get $src1_wa))))
        (else (local.set $a
          (call $gl8 (i32.add (local.get $src1) (local.get $disp))))))
      (if (local.get $mode)
        (then
          (if (local.get $src2_wa)
            (then (local.set $b (i32.load8_u (local.get $src2_wa))))
            (else (local.set $b
              (call $gl8 (i32.add (local.get $src2) (local.get $disp))))))
          (local.set $index
            (i32.or (i32.shl (local.get $a) (i32.const 8)) (local.get $b))))
        (else (local.set $index (local.get $a))))
      (if (local.get $tbl_wa)
        (then (local.set $out
          (i32.load8_u (i32.add (local.get $tbl_wa) (local.get $index)))))
        (else (local.set $out
          (call $gl8 (i32.add (local.get $tbl) (local.get $index))))))
      (if (local.get $dst_wa)
        (then (i32.store8 (local.get $dst_wa) (local.get $out)))
        (else (call $gs8 (i32.add (local.get $dst) (local.get $disp))
                         (local.get $out))))
      (if (local.get $src1_wa)
        (then (local.set $src1_wa (i32.sub (local.get $src1_wa) (i32.const 1)))))
      (if (local.get $src2_wa)
        (then (local.set $src2_wa (i32.sub (local.get $src2_wa) (i32.const 1)))))
      (if (local.get $dst_wa)
        (then (local.set $dst_wa (i32.sub (local.get $dst_wa) (i32.const 1)))))
      (local.set $disp (i32.sub (local.get $disp) (i32.const 1)))
      (local.set $n (i32.sub (local.get $n) (i32.const 1)))
      (br_if $pixels (local.get $n)))

    ;; Every accepted checkpoint's last flag writer is XOR of a register with
    ;; itself. MOV/SHL/table/store register publication follows the exact final
    ;; symbolic state proved by the scanner.
    (if (local.get $mode)
      (then
        (call $set_reg (local.get $acc_reg)
          (i32.or (i32.shl (local.get $a) (i32.const 8)) (local.get $out)))
        (if (i32.eq (local.get $aux_kind) (i32.const 1))
          (then (call $set_reg (local.get $aux_reg) (i32.const 0)))
          (else (call $set_reg (local.get $aux_reg)
            (call $gl8 (i32.add (local.get $src2) (local.get $aux_disp)))))))
      (else (call $set_reg (local.get $acc_reg) (local.get $out))))
    (call $set_flags_logic (i32.const 0))
    (global.set $steps
      (i32.sub (global.get $steps) (i32.sub (local.get $cost) (i32.const 1))))
    (global.set $lut_span_runs
      (i32.add (global.get $lut_span_runs) (i32.const 1)))
    (global.set $lut_span_bytes
      (i64.add (global.get $lut_span_bytes) (i64.extend_i32_u (local.get $count))))
    (NEXT))

  ;; 403: the post-increment byte fetch through a pointer *variable*:
  ;;
  ;;   mov ecx,[0x525d80]      ; the stream pointer lives in memory, not a reg
  ;;   inc ecx
  ;;   mov [0x525d80],ecx
  ;;   mov al,[ecx-1]          ; optional: read the byte just stepped over
  ;;
  ;; Heroes II's ICN decoder is written entirely out of this idiom -- it reads
  ;; every RLE control byte and every pixel run this way, and the profile shows
  ;; the shape rather than the operation: load32-abs 6.5%, store32-abs 8.8%,
  ;; inc_r 3.4%, with the adjacent pairs load32->inc, inc->store32 and
  ;; store32->load8_ro all in the top ten. Folding the group into one dispatch
  ;; is worth three or four of them per byte consumed.
  ;;
  ;; op: bits 0-3 pointer register, bit 8 set when the byte load is present,
  ;; and then bits 4-6 its destination byte register. Words: the absolute
  ;; address of the pointer variable, then the byte load's displacement (only
  ;; when bit 8 is set). Flags are INC's, exactly as the separate ops left them.
  (func $th_ptrvar_fetch8 (param $op i32)
    (local $abs i32) (local $old i32) (local $ptr i32)
    (local.set $abs (call $read_thread_word))
    (local.set $old (call $gl32 (local.get $abs)))
    (local.set $ptr (i32.add (local.get $old) (i32.const 1)))
    (call $set_reg (i32.and (local.get $op) (i32.const 0xF)) (local.get $ptr))
    (call $gs32 (local.get $abs) (local.get $ptr))
    (call $set_flags_inc (local.get $old) (local.get $ptr))
    (if (i32.and (local.get $op) (i32.const 0x100))
      (then
        (call $set_reg8 (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 7))
          (call $gl8 (i32.add (local.get $ptr) (call $read_thread_word))))))
    (NEXT))

  ;; 404: TEST r,r (or TEST r8,r8) immediately followed by a Jcc. The branch is
  ;; the only consumer of those flags in every occurrence the decoder fuses, so
  ;; the pair costs one dispatch instead of two, and the condition is read off
  ;; the AND result directly — a logic op leaves CF=0 and OF=0, which collapses
  ;; BE to ZF, A to !ZF, L/GE to the sign bit and LE/G to a sign-or-zero test.
  ;; Lazy-flag state is still published so any later reader (PUSHFD, SETcc, a
  ;; second branch) sees exactly what the separate TEST would have left.
  ;;
  ;; op: bits 0-3 and 4-7 the two registers, bits 8-11 the x86 condition code,
  ;; bit 12 set for the byte form. Words: fall-through EIP, then target EIP.
  (func $th_test_jcc (param $op i32)
    (local $r i32) (local $cc i32) (local $sign i32) (local $taken i32)
    (local $fall i32) (local $target i32)
    (local.set $cc (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (if (global.get $handler_hist_enabled)
      (then (call $branch_hist_record_jcc (local.get $cc))))
    (if (i32.and (local.get $op) (i32.const 0x1000))
      (then
        (local.set $r (i32.and
          (call $get_reg8 (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
          (call $get_reg8 (i32.and (local.get $op) (i32.const 0xF)))))
        (call $set_flags_logic (local.get $r))
        (global.set $flag_sign_shift (i32.const 7))
        (local.set $sign (i32.and (i32.shr_u (local.get $r) (i32.const 7)) (i32.const 1))))
      (else
        (local.set $r (i32.and
          (call $get_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
          (call $get_reg (i32.and (local.get $op) (i32.const 0xF)))))
        (call $set_flags_logic (local.get $r))
        (local.set $sign (i32.shr_u (local.get $r) (i32.const 31)))))
    (local.set $fall (call $read_thread_word))
    (local.set $target (call $read_thread_word))
    (block $cc_done
      (if (i32.or (i32.eq (local.get $cc) (i32.const 0x4)) (i32.eq (local.get $cc) (i32.const 0x6)))
        (then (local.set $taken (i32.eqz (local.get $r))) (br $cc_done)))
      (if (i32.or (i32.eq (local.get $cc) (i32.const 0x5)) (i32.eq (local.get $cc) (i32.const 0x7)))
        (then (local.set $taken (i32.ne (local.get $r) (i32.const 0))) (br $cc_done)))
      (if (i32.or (i32.eq (local.get $cc) (i32.const 0x8)) (i32.eq (local.get $cc) (i32.const 0xC)))
        (then (local.set $taken (local.get $sign)) (br $cc_done)))
      (if (i32.or (i32.eq (local.get $cc) (i32.const 0x9)) (i32.eq (local.get $cc) (i32.const 0xD)))
        (then (local.set $taken (i32.eqz (local.get $sign))) (br $cc_done)))
      (if (i32.eq (local.get $cc) (i32.const 0xE))
        (then
          (local.set $taken (i32.or (i32.eqz (local.get $r)) (local.get $sign)))
          (br $cc_done)))
      (if (i32.eq (local.get $cc) (i32.const 0xF))
        (then
          (local.set $taken (i32.and (i32.ne (local.get $r) (i32.const 0)) (i32.eqz (local.get $sign))))
          (br $cc_done)))
      ;; O/NO/B/AE/P/NP are rare after a logic op; let the general evaluator
      ;; answer them from the state just published.
      (local.set $taken (call $eval_cc (local.get $cc))))
    (if (local.get $taken)
      (then (global.set $eip (local.get $target)))
      (else (global.set $eip (local.get $fall))))
    (return_call $branch_end))

  ;; 405/406: a run of 2-4 back-to-back absolute MOVs — `mov [abs],reg` or
  ;; `mov reg,[abs]` with nothing in between. Absolute loads and stores are the
  ;; two heaviest handlers in Heroes II's blitter (8.6% and 6.0% of all ops) and
  ;; the compiler emits them in clusters when it spills a register set, so the
  ;; run costs one dispatch instead of four.
  ;;
  ;; op: bits 0-3 the run length, then one register per nibble from bit 4 up.
  ;; Words: one absolute address per element, in program order.
  (func $th_store32_abs_run (param $op i32)
    (local $n i32) (local $i i32) (local $addr i32)
    (local.set $n (i32.and (local.get $op) (i32.const 0xF)))
    (block $done (loop $l
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $addr (call $read_thread_word))
      (call $gs32 (local.get $addr)
        (call $get_reg (i32.and
          (i32.shr_u (local.get $op)
            (i32.add (i32.const 4) (i32.shl (local.get $i) (i32.const 2))))
          (i32.const 0xF))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (NEXT))

  (func $th_load32_abs_run (param $op i32)
    (local $n i32) (local $i i32) (local $addr i32)
    (local.set $n (i32.and (local.get $op) (i32.const 0xF)))
    (block $done (loop $l
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $addr (call $read_thread_word))
      (call $set_reg
        (i32.and
          (i32.shr_u (local.get $op)
            (i32.add (i32.const 4) (i32.shl (local.get $i) (i32.const 2))))
          (i32.const 0xF))
        (call $gl32 (local.get $addr)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (NEXT))

  ;; 407: `OP dword [base+disp], imm32` with the Jcc that immediately follows
  ;; it. This is the largest remaining adjacent pair in the Heroes II gameplay
  ;; histogram (537,833 back-to-back 131 -> jcc dispatches): the compare-a-
  ;; local-against-a-constant-and-branch shape every compiled loop is built
  ;; from. Unlike the TEST fusion in 404 the condition is not readable off the
  ;; result — a CMP/ADD/SUB publishes real CF and OF — so the flags are
  ;; published exactly as handler 131 leaves them and $eval_cc answers from
  ;; that state. The saving is the second dispatch, not the flag work, and the
  ;; lazy-flag globals are byte-for-byte what the unfused pair produced, so
  ;; PUSHFD, SETcc or a second branch after the group still see the truth.
  ;;
  ;; op: bits 0-3 base reg, 8-11 the ALU op, 12-15 the condition code.
  ;; Words: disp, imm32, fall-through EIP, branch target — the 131 payload with
  ;; the ordinary Jcc payload appended, so the emitter is unchanged apart from
  ;; which opcode it writes.
  (func $th_alu_m32_i_jcc (param $op i32)
    (local $addr i32) (local $alu i32) (local $imm i32) (local $val i32)
    (local $cc i32) (local $fall i32) (local $target i32)
    (local.set $cc (i32.and (i32.shr_u (local.get $op) (i32.const 12)) (i32.const 0xF)))
    (if (global.get $handler_hist_enabled)
      (then (call $branch_hist_record_jcc (local.get $cc))))
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $imm (call $read_thread_word))
    (local.set $val (call $do_alu32 (local.get $alu) (call $gl32 (local.get $addr)) (local.get $imm)))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $gs32 (local.get $addr) (local.get $val))))
    (local.set $fall (call $read_thread_word))
    (local.set $target (call $read_thread_word))
    (if (call $eval_cc (local.get $cc))
      (then (global.set $eip (local.get $target)))
      (else (global.set $eip (local.get $fall))))
    (return_call $branch_end))

  ;; 408: 2-4 back-to-back `mov r32,[base+disp]` sharing one base register —
  ;; the frame-local read the compiler emits everywhere, and by a wide margin
  ;; the hottest single handler in a real game (11.6% of Heroes II's gameplay
  ;; dispatches land in $th_load32_ro_base_ebp alone).
  ;;
  ;; op is (n) | (base<<4) | (dst_i << (8 + 4*i)); the n words that follow are
  ;; the displacements, already segment-adjusted by the decoder. The base
  ;; register is read once, up front: the decoder ends a run at the element
  ;; whose destination IS the base (`mov ebp,[ebp+0xc]`), so every address in
  ;; the group is computed from the base value the group started with, which
  ;; is exactly what the unfused sequence would have done.
  (func $th_load32_base_run (param $op i32)
    (local $n i32) (local $i i32) (local $base i32)
    (local.set $n (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $base
      (call $get_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF))))
    (block $done (loop $l
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (call $set_reg
        (i32.and
          (i32.shr_u (local.get $op)
            (i32.add (i32.const 8) (i32.shl (local.get $i) (i32.const 2))))
          (i32.const 0xF))
        (call $gl32 (i32.add (local.get $base) (call $read_thread_word))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (NEXT))

  ;; 409: a memory unary (inc/dec/not/neg dword [base+disp]) immediately
  ;; followed by an ALU of an immediate against the SAME [base+disp] — the
  ;; loop-counter idiom every compiler emits for a counter that lives on the
  ;; stack rather than in a register:
  ;;
  ;;   inc dword [ebp-8]
  ;;   cmp dword [ebp-8], 0x64
  ;;
  ;; Handlers 135 and 131 each recompute the effective address and each pay a
  ;; dispatch; fused they compute it once, and the second op reads the value
  ;; the first just stored instead of loading it back.
  ;;
  ;; The operations are performed in exactly the order the two handlers would
  ;; have performed them, using the same helpers, so the lazy-flag state left
  ;; behind is the ALU op's — whatever $do_alu32 publishes — exactly as in the
  ;; unfused pair. op: bits 0-3 base reg, 4-7 the unary op, 8-11 the ALU op.
  ;; Words: the displacement, then the immediate.
  (func $th_unary_alu_m32_ro (param $op i32)
    (local $addr i32) (local $uop i32) (local $alu i32)
    (local $old i32) (local $r i32) (local $imm i32)
    (local.set $addr (i32.add
      (call $get_reg (i32.and (local.get $op) (i32.const 0xF)))
      (call $read_thread_word)))
    (local.set $imm (call $read_thread_word))
    (local.set $uop (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
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
    (call $gs32 (local.get $addr) (local.get $r))
    (local.set $r (call $do_alu32 (local.get $alu) (local.get $r) (local.get $imm)))
    (if (i32.ne (local.get $alu) (i32.const 7))
      (then (call $gs32 (local.get $addr) (local.get $r))))
    (NEXT))

  ;; 390: two adjacent SIB LEAs. Words are info1, disp1, info2, disp2 and the
  ;; destination registers are packed into op. The second address is computed
  ;; after committing the first result, preserving dependent LEA semantics.
  (func $th_lea_sib_pair (param $op i32)
    (local $info1 i32) (local $disp1 i32) (local $info2 i32) (local $disp2 i32)
    (local $base_val i32) (local $index_val i32) (local $scale i32)
    (local.set $info1 (call $read_thread_word))
    (local.set $disp1 (call $read_thread_word))
    (local.set $info2 (call $read_thread_word))
    (local.set $disp2 (call $read_thread_word))
    (if (i32.ne (i32.and (local.get $info1) (i32.const 0xF)) (i32.const 0xF))
      (then (local.set $base_val (call $get_reg (i32.and (local.get $info1) (i32.const 0xF))))))
    (if (i32.ne (i32.and (i32.shr_u (local.get $info1) (i32.const 4)) (i32.const 0xF)) (i32.const 0xF))
      (then
        (local.set $scale (i32.and (i32.shr_u (local.get $info1) (i32.const 8)) (i32.const 3)))
        (local.set $index_val (i32.shl
          (call $get_reg (i32.and (i32.shr_u (local.get $info1) (i32.const 4)) (i32.const 0xF)))
          (local.get $scale)))))
    (call $set_reg (i32.and (local.get $op) (i32.const 7))
      (i32.add (i32.add (local.get $base_val) (local.get $index_val)) (local.get $disp1)))
    (local.set $base_val (i32.const 0))
    (local.set $index_val (i32.const 0))
    (if (i32.ne (i32.and (local.get $info2) (i32.const 0xF)) (i32.const 0xF))
      (then (local.set $base_val (call $get_reg (i32.and (local.get $info2) (i32.const 0xF))))))
    (if (i32.ne (i32.and (i32.shr_u (local.get $info2) (i32.const 4)) (i32.const 0xF)) (i32.const 0xF))
      (then
        (local.set $scale (i32.and (i32.shr_u (local.get $info2) (i32.const 8)) (i32.const 3)))
        (local.set $index_val (i32.shl
          (call $get_reg (i32.and (i32.shr_u (local.get $info2) (i32.const 4)) (i32.const 0xF)))
          (local.get $scale)))))
    (call $set_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 7))
      (i32.add (i32.add (local.get $base_val) (local.get $index_val)) (local.get $disp2)))
    (NEXT))

  ;; 391: MOV EAX,[EDX+disp] followed by TEST EAX,imm32. Smacker's Huffman
  ;; tree builder uses this pair for every node probe. MOV leaves flags alone;
  ;; TEST publishes the same lazy logic flags as the two ordinary handlers.
  (func $th_load_eax_edx_test_i32 (param $op i32)
    (global.set $eax
      (call $gl32
        (i32.add (global.get $edx) (call $read_thread_word))))
    (call $set_flags_logic
      (i32.and (global.get $eax) (call $read_thread_word)))
    (NEXT))

  ;; 392: ADD EDX,EAX followed by the zero-displacement form of handler 391.
  ;; TEST overwrites every arithmetic flag written by ADD, so the only live
  ;; intermediate state is the updated EDX used as the load address.
  (func $th_add_edx_eax_load_test (param $op i32)
    (global.set $edx (i32.add (global.get $edx) (global.get $eax)))
    (global.set $eax (call $gl32 (global.get $edx)))
    (call $set_flags_logic
      (i32.and (global.get $eax) (call $read_thread_word)))
    (NEXT))

  ;; 393: Smacker refills its bit reservoir after decrementing an absolute
  ;; byte counter, then immediately branches on DEC's ZF. The fall-through
  ;; and target words make this block-ending just like $th_jcc_nz; DEC's full
  ;; lazy-flag state (including preserved CF) remains visible at either edge.
  (func $th_dec_m8_abs_jnz (param $op i32)
    (local $old i32) (local $r i32) (local $fall i32) (local $target i32)
    (local.set $old (call $gl8 (local.get $op)))
    (local.set $r
      (i32.and (i32.sub (local.get $old) (i32.const 1)) (i32.const 0xFF)))
    (call $set_flags_dec (local.get $old) (local.get $r))
    (global.set $flag_sign_shift (i32.const 7))
    (call $gs8 (local.get $op) (local.get $r))
    (local.set $fall (call $read_thread_word))
    (local.set $target (call $read_thread_word))
    (if (global.get $handler_hist_enabled)
      (then (call $branch_hist_record_jcc (i32.const 5))))
    (if (local.get $r)
      (then (global.set $eip (local.get $target)))
      (else (global.set $eip (local.get $fall))))
    (return_call $branch_end))

  ;; 394: Smacker consumes one input bit with SHR EBP,1 and immediately uses
  ;; CF through JB or JAE. op=0 is JB, op=1 is JAE. $do_shift32 publishes the
  ;; exact count-one shift flags; the saved low bit selects the successor
  ;; without resolving the lazy CF a second time.
  (func $th_shr_ebp_1_jcc_b (param $op i32)
    (local $old i32) (local $taken i32) (local $fall i32) (local $target i32)
    (local.set $old (global.get $ebp))
    (global.set $ebp
      (call $do_shift32 (i32.const 5) (local.get $old) (i32.const 1)))
    (local.set $fall (call $read_thread_word))
    (local.set $target (call $read_thread_word))
    (if (global.get $handler_hist_enabled)
      (then (call $branch_hist_record_jcc (i32.add (i32.const 2) (local.get $op)))))
    (local.set $taken
      (if (result i32) (i32.eqz (local.get $op))
        (then (i32.and (local.get $old) (i32.const 1)))
        (else (i32.eqz (i32.and (local.get $old) (i32.const 1))))))
    (if (local.get $taken)
      (then (global.set $eip (local.get $target)))
      (else (global.set $eip (local.get $fall))))
    (return_call $branch_end))

  ;; 395: Exact Smacker Huffman node walk. op is the absolute byte-counter
  ;; address; words are the original loop EIP and the fall-through EIP. Each
  ;; iteration has no externally visible call boundary, and every arithmetic
  ;; flag before the final TEST is overwritten by that TEST. Bound the native
  ;; loop so even corrupt input returns control with an exact guest resume EIP.
  (func $th_smack_huff_walk (param $op i32)
    (local $loop_eip i32) (local $fall i32) (local $counter i32)
    (local $old_ebp i32) (local $r i32) (local $n i32)
    (local.set $loop_eip (call $read_thread_word))
    (local.set $fall (call $read_thread_word))
    (block $done
      (loop $walk
        (local.set $counter
          (i32.and
            (i32.sub (call $gl8 (local.get $op)) (i32.const 1))
            (i32.const 0xFF)))
        (call $gs8 (local.get $op) (local.get $counter))
        (if (i32.eqz (local.get $counter))
          (then
            (global.set $ebp (call $gl32 (global.get $esi)))
            (global.set $esi (i32.add (global.get $esi) (i32.const 4)))
            (call $gs8 (local.get $op) (i32.const 32))))
        (local.set $old_ebp (global.get $ebp))
        (global.set $ebp (i32.shr_u (local.get $old_ebp) (i32.const 1)))
        (if (i32.eqz (i32.and (local.get $old_ebp) (i32.const 1)))
          (then (global.set $eax (i32.const 4))))
        (global.set $edx (i32.add (global.get $edx) (global.get $eax)))
        (global.set $eax (call $gl32 (global.get $edx)))
        (local.set $r (i32.and (global.get $eax) (i32.const 0x80000000)))
        (call $set_flags_logic (local.get $r))
        (if (local.get $r)
          (then (global.set $eip (local.get $fall)) (br $done)))
        (local.set $n (i32.add (local.get $n) (i32.const 1)))
        (if (i32.ge_u (local.get $n) (i32.const 64))
          (then (global.set $eip (local.get $loop_eip)) (br $done)))
        (br $walk))))

  ;; 396: Exact common paths through Storm.dll's PKWARE bit-reservoir helper.
  ;; The helper is called for almost every decoded symbol. Its usual paths do
  ;; nothing but a cdecl prologue/epilogue around two reservoir dwords, so the
  ;; emulated call/return and threaded dispatch cost much more than the work.
  ;; op is the guest EIP of the rare input-refill path. When the byte buffer is
  ;; exhausted, reconstruct the precise prologue state and resume original
  ;; code there; the callback and its failure behavior remain fully emulated.
  (func $th_storm_bitreader (param $op i32)
    (local $sp i32) (local $ctx i32) (local $bits i32) (local $avail i32)
    (local $reservoir i32) (local $pos_addr i32) (local $pos i32)
    (local $end i32) (local $byte i32) (local $shift i32) (local $v i32)
    (local.set $sp (global.get $esp))
    (local.set $ctx (call $gl32 (i32.add (local.get $sp) (i32.const 4))))
    (local.set $bits (call $gl32 (i32.add (local.get $sp) (i32.const 8))))
    (local.set $avail (call $gl32 (i32.add (local.get $ctx) (i32.const 0x18))))
    (local.set $reservoir (call $gl32 (i32.add (local.get $ctx) (i32.const 0x14))))
    (if (i32.ge_u (local.get $avail) (local.get $bits))
      (then
        (call $gs32 (i32.add (local.get $ctx) (i32.const 0x18))
          (i32.sub (local.get $avail) (local.get $bits)))
        (call $gs32 (i32.add (local.get $ctx) (i32.const 0x14))
          (i32.shr_u (local.get $reservoir) (local.get $bits)))
        (global.set $eax (i32.const 0))
        (call $set_flags_logic (i32.const 0))
        (global.set $eip (call $gl32 (local.get $sp)))
        (global.set $esp (i32.add (local.get $sp) (i32.const 4)))
        (call $cs_pop)
        (return)))

    ;; The original slow path first discards every remaining reservoir bit,
    ;; then checks whether its 2 KiB input buffer needs a callback refill.
    (local.set $reservoir
      (i32.shr_u (local.get $reservoir) (local.get $avail)))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 0x14))
      (local.get $reservoir))
    (local.set $pos_addr (i32.add (local.get $ctx) (i32.const 0x1C)))
    (local.set $pos (call $gl32 (local.get $pos_addr)))
    (local.set $end (call $gl32 (i32.add (local.get $ctx) (i32.const 0x20))))
    (if (i32.eq (local.get $pos) (local.get $end))
      (then
        ;; State at original offset +0x31, immediately before the refill call.
        (call $gs32 (i32.sub (local.get $sp) (i32.const 4)) (global.get $ebx))
        (call $gs32 (i32.sub (local.get $sp) (i32.const 8)) (global.get $esi))
        (call $gs32 (i32.sub (local.get $sp) (i32.const 12)) (global.get $edi))
        (global.set $esp (i32.sub (local.get $sp) (i32.const 12)))
        (global.set $esi (local.get $ctx))
        (global.set $edi (local.get $pos_addr))
        (global.set $ebx (local.get $bits))
        (global.set $eax (local.get $end))
        (global.set $ecx
          (i32.or
            (i32.and (global.get $ecx) (i32.const 0xFFFFFF00))
            (i32.and (local.get $avail) (i32.const 0xFF))))
        (call $set_flags_sub (local.get $pos) (local.get $end) (i32.const 0))
        (global.set $eip (local.get $op))
        (return)))

    ;; Common no-refill path, original offsets +0x5f..+0x8f.
    (local.set $byte
      (call $gl8
        (i32.add
          (i32.add (local.get $ctx) (i32.const 0x2234))
          (local.get $pos))))
    (call $gs32 (local.get $pos_addr) (i32.add (local.get $pos) (i32.const 1)))
    (local.set $v
      (i32.or (i32.shl (local.get $byte) (i32.const 8)) (local.get $reservoir)))
    (local.set $shift
      (i32.and (i32.sub (local.get $bits) (local.get $avail)) (i32.const 0xFF)))
    (global.set $ecx
      (i32.or
        (i32.and (local.get $bits) (i32.const 0xFFFFFF00))
        (local.get $shift)))
    (global.set $edx (i32.shr_u (local.get $v) (local.get $shift)))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 0x14)) (global.get $edx))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 0x18))
      (i32.add
        (i32.sub (local.get $avail) (local.get $bits))
        (i32.const 8)))
    (global.set $eax (i32.const 0))
    (call $set_flags_logic (i32.const 0))
    (global.set $eip (call $gl32 (local.get $sp)))
    (global.set $esp (i32.add (local.get $sp) (i32.const 4)))
    (call $cs_pop))

  ;; 397: ASCII adjust after multiply. The immediate is normally decimal 10,
  ;; but 32-bit x86 accepts any non-zero byte base. Only AL participates; AH
  ;; receives the quotient and AL the remainder while EAX[31:16] is preserved.
  (func $th_aam (param $op i32)
    (local $al i32) (local $quotient i32) (local $remainder i32)
    (if (i32.eqz (local.get $op))
      (then
        (call $raise_exception (i32.const 0xC0000094))
        (return)))
    (local.set $al (i32.and (global.get $eax) (i32.const 0xFF)))
    (local.set $quotient (i32.div_u (local.get $al) (local.get $op)))
    (local.set $remainder (i32.rem_u (local.get $al) (local.get $op)))
    (global.set $eax
      (i32.or
        (i32.and (global.get $eax) (i32.const 0xFFFF0000))
        (i32.or
          (i32.shl (local.get $quotient) (i32.const 8))
          (local.get $remainder))))
    (call $set_flags_logic (local.get $remainder))
    (global.set $flag_sign_shift (i32.const 7))
    (NEXT))

  ;; Minimal PC port state used by Win9x applications that legitimately issue
  ;; user-mode IN/OUT. Channel 0 is latched through port 0x43 and returned low
  ;; byte then high byte from 0x40, matching the 8254 access Fallout uses for
  ;; its random/timer seed. Port 0x3DA alternates vertical-retrace status so a
  ;; legacy VGA polling loop cannot deadlock. Other ports float high.
  (global $io_pit_latch (mut i32) (i32.const 0))
  (global $io_pit_phase (mut i32) (i32.const 0))
  (global $io_vga_status (mut i32) (i32.const 0))

  ;; 398: IN/OUT AL/AX/EAX with an immediate or DX port. Operand bits 0..7 are
  ;; the x86 opcode, 8..15 hold an immediate port, and bit 16 records 66h.
  (func $th_port_io (param $op i32)
    (local $opcode i32) (local $port i32) (local $value i32)
    (local $wide i32) (local $word i32) (local $is_in i32)
    (local.set $opcode (i32.and (local.get $op) (i32.const 0xFF)))
    (local.set $port
      (if (result i32) (i32.lt_u (local.get $opcode) (i32.const 0xEC))
        (then (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xFF)))
        (else (i32.and (global.get $edx) (i32.const 0xFFFF)))))
    (local.set $wide (i32.and (local.get $opcode) (i32.const 1)))
    (local.set $word
      (i32.and
        (local.get $wide)
        (i32.ne (i32.and (local.get $op) (i32.const 0x10000)) (i32.const 0))))
    (local.set $is_in
      (i32.or
        (i32.eq (local.get $opcode) (i32.const 0xE4))
        (i32.or
          (i32.eq (local.get $opcode) (i32.const 0xE5))
          (i32.or
            (i32.eq (local.get $opcode) (i32.const 0xEC))
            (i32.eq (local.get $opcode) (i32.const 0xED))))))

    (if (local.get $is_in)
      (then
        (local.set $value (i32.const -1))
        (if (i32.eq (local.get $port) (i32.const 0x40))
          (then
            (if (i32.eqz (global.get $io_pit_phase))
              (then
                (local.set $value (i32.and (global.get $io_pit_latch) (i32.const 0xFF)))
                (global.set $io_pit_phase (i32.const 1)))
              (else
                (local.set $value
                  (i32.and (i32.shr_u (global.get $io_pit_latch) (i32.const 8)) (i32.const 0xFF)))
                (global.set $io_pit_phase (i32.const 0))))))
        (if (i32.eq (local.get $port) (i32.const 0x61))
          (then (local.set $value (i32.const 0))))
        (if (i32.eq (local.get $port) (i32.const 0x3DA))
          (then
            (global.set $io_vga_status
              (i32.xor (global.get $io_vga_status) (i32.const 8)))
            (local.set $value (global.get $io_vga_status))))
        (if (i32.eqz (local.get $wide))
          (then
            (global.set $eax
              (i32.or
                (i32.and (global.get $eax) (i32.const 0xFFFFFF00))
                (i32.and (local.get $value) (i32.const 0xFF)))))
          (else
            (if (local.get $word)
              (then
                (global.set $eax
                  (i32.or
                    (i32.and (global.get $eax) (i32.const 0xFFFF0000))
                    (i32.and (local.get $value) (i32.const 0xFFFF)))))
              (else (global.set $eax (local.get $value)))))))
      (else
        (local.set $value
          (if (result i32) (i32.eqz (local.get $wide))
            (then (i32.and (global.get $eax) (i32.const 0xFF)))
            (else
              (if (result i32) (local.get $word)
                (then (i32.and (global.get $eax) (i32.const 0xFFFF)))
                (else (global.get $eax))))))
        (if (i32.and
              (i32.eq (local.get $port) (i32.const 0x43))
              (i32.eqz (i32.and (local.get $value) (i32.const 0xC0))))
          (then
            (global.set $io_pit_latch
              (i32.and
                (i32.sub
                  (i32.const 0)
                  (i32.mul (call $host_get_ticks) (i32.const 1193)))
                (i32.const 0xFFFF)))
            (global.set $io_pit_phase (i32.const 0))))))
    (NEXT))

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
    (NEXT))

  ;; 128: reg32 OP= [base+disp]. operand = alu_op<<8 | reg<<4 | base.
  (func $th_alu_r_m32_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $reg i32) (local $val i32)
    (if (global.get $handler_hist_enabled)
      (then
        (call $branch_hist_set (i32.const 3)
          (i32.or
            (i32.shl (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 7)) (i32.const 6))
            (i32.or
              (i32.shl (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 7)) (i32.const 3))
              (i32.and (local.get $op) (i32.const 7)))))))
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $val (call $do_alu32 (local.get $alu) (call $get_reg (local.get $reg)) (call $gl32 (local.get $addr))))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $set_reg (local.get $reg) (local.get $val))))
    (NEXT))

  ;; 129: [base+disp] OP= reg8. operand = alu_op<<8 | reg<<4 | base.
  (func $th_alu_m8_r_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $reg i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $val (call $do_alu_sized (local.get $alu) (call $gl8 (local.get $addr)) (call $get_reg8 (local.get $reg)) (i32.const 0xFF) (i32.const 7)))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $gs8 (local.get $addr) (local.get $val))))
    (NEXT))

  ;; 130: reg8 OP= [base+disp]. operand = alu_op<<8 | reg<<4 | base.
  (func $th_alu_r_m8_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $reg i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $val (call $do_alu_sized (local.get $alu) (call $get_reg8 (local.get $reg)) (call $gl8 (local.get $addr)) (i32.const 0xFF) (i32.const 7)))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $set_reg8 (local.get $reg) (local.get $val))))
    (NEXT))

  ;; 131: [base+disp] OP= imm32. operand = alu_op<<8 | base. disp+imm in next words.
  (func $th_alu_m32_i_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $imm i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $imm (call $read_thread_word))
    (local.set $val (call $do_alu32 (local.get $alu) (call $gl32 (local.get $addr)) (local.get $imm)))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $gs32 (local.get $addr) (local.get $val))))
    (NEXT))

  ;; 132: [base+disp] OP= imm8. operand = alu_op<<8 | base. disp+imm in next words.
  (func $th_alu_m8_i_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $imm i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    ;; The immediate is masked to eight bits like the memory operand: a
    ;; sign-extended imm8 arrives as 0xFFFFFFxx and would compare unsigned
    ;; against a byte as though it were enormous. See $th_alu_m16_i_ro.
    (local.set $imm (i32.and (call $read_thread_word) (i32.const 0xFF)))
    (local.set $val (call $do_alu_sized (local.get $alu) (call $gl8 (local.get $addr)) (local.get $imm) (i32.const 0xFF) (i32.const 7)))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $gs8 (local.get $addr) (local.get $val))))
    (NEXT))

  ;; 220: [base+disp] OP= imm16. operand = alu_op<<8 | base. disp+imm in next words.
  (func $th_alu_m16_i_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $imm i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $imm (i32.and (call $read_thread_word) (i32.const 0xFFFF)))
    (local.set $val (call $do_alu_sized (local.get $alu) (call $gl16 (local.get $addr)) (local.get $imm) (i32.const 0xFFFF) (i32.const 15)))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $gs16 (local.get $addr) (local.get $val))))
    (NEXT))

  ;; 133: mov [base+disp], imm32. op=base, disp+imm in next words.
  (func $th_mov_m32_i32_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (call $gs32 (local.get $addr) (call $read_thread_word))
    (NEXT))
  ;; 134: mov [base+disp], imm8.
  (func $th_mov_m8_i8_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (call $gs8 (local.get $addr) (call $read_thread_word))
    (NEXT))
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
    (call $gs32 (local.get $addr) (local.get $r)) (NEXT))
  ;; 136: test [base+disp], reg. op=reg<<4|base, disp in word.
  (func $th_test_m32_r_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (drop (call $do_alu32 (i32.const 4) (call $gl32 (local.get $addr))
      (call $get_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))))
    (NEXT))
  ;; 137: test [base+disp], imm32. op=base, disp+imm in words.
  (func $th_test_m32_i32_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (drop (call $do_alu32 (i32.const 4) (call $gl32 (local.get $addr)) (call $read_thread_word)))
    (NEXT))
  ;; 138: test [base+disp], imm8. op=base, disp+imm in words.
  (func $th_test_m8_i8_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (drop (call $do_alu32 (i32.const 4) (call $gl8 (local.get $addr)) (call $read_thread_word)))
    (global.set $flag_sign_shift (i32.const 7)) (NEXT))
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
    (NEXT))
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
    (call $cs_push (local.get $op))
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
  ;; 355: jmp [disp+eax*4]. Hot AoE blitter command-table dispatch.
  (func $th_jmp_ind_sib_eax4_abs (param $op i32)
    (local $disp i32) (local $target i32) (local $ret_addr i32)
    (local.set $disp (call $read_thread_word))
    (local.set $target
      (call $gl32
        (i32.add (local.get $disp)
          (i32.shl (global.get $eax) (i32.const 2)))))
    (if (i32.and (i32.ge_u (local.get $target) (global.get $thunk_guest_base))
                 (i32.lt_u (local.get $target) (global.get $thunk_guest_end)))
      (then
        (local.set $ret_addr (call $gl32 (global.get $esp)))
        (call $win32_dispatch (i32.div_u (i32.sub (local.get $target) (global.get $thunk_guest_base)) (i32.const 8)))
        (if (global.get $steps) (then (global.set $eip (local.get $ret_addr))))
        (return)))
    (global.set $eip (local.get $target)))
  ;; 142: push [base+disp]. op=base, disp in word.
  (func $th_push_m32_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $gl32 (local.get $addr)))
    (NEXT))
  (func $th_pop_m32_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (call $gs32 (local.get $addr) (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (NEXT))
  ;; 143-146: movzx/movsx [base+disp] variants. op=dst<<4|base, disp in word.
  (func $th_movzx8_ro (param $op i32)
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4))
      (call $gl8 (call $ea_from_op (local.get $op))))
    (NEXT))
  (func $th_movsx8_ro (param $op i32)
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4))
      (call $sign_ext8 (call $gl8 (call $ea_from_op (local.get $op)))))
    (NEXT))
  (func $th_movzx16_ro (param $op i32)
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4))
      (call $gl16 (call $ea_from_op (local.get $op))))
    (NEXT))
  (func $th_movsx16_ro (param $op i32)
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4))
      (call $sign_ext16 (call $gl16 (call $ea_from_op (local.get $op)))))
    (NEXT))
  ;; 147: mul/imul/div/idiv [base+disp]. op=type<<4|base, disp in word. type: 0=mul,1=imul,2=div,3=idiv
  (func $th_muldiv_m32_ro (param $op i32)
    (local $addr i32) (local $mtype i32) (local $mval i32) (local $val64 i64) (local $divisor i64) (local $dividend i64) (local $quotient i64)
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
    ;; DIV/IDIV here must match $th_div_m32/$th_idiv_m32 exactly: same divide
    ;; signedness, same #DE code, same quotient-range check. IDIV divided
    ;; unsignedly for years, so any `idiv [base+disp]` with a negative operand
    ;; silently returned 0 -- that is what flattened MSPaint's round brush on
    ;; every stroke heading up or left.
    (if (i32.eq (local.get $mtype) (i32.const 2)) ;; DIV
      (then (local.set $divisor (i64.extend_i32_u (local.get $mval)))
            (local.set $dividend (i64.or (i64.extend_i32_u (global.get $eax))
              (i64.shl (i64.extend_i32_u (global.get $edx)) (i64.const 32))))
            (if (i64.eqz (local.get $divisor)) (then (call $raise_exception (i32.const 0xC0000094)) (return)))
            (local.set $quotient (i64.div_u (local.get $dividend) (local.get $divisor)))
            (if (i64.gt_u (local.get $quotient) (i64.const 0xFFFFFFFF))
              (then (call $raise_exception (i32.const 0xC0000094)) (return)))
            (global.set $eax (i32.wrap_i64 (local.get $quotient)))
            (global.set $edx (i32.wrap_i64 (i64.rem_u (local.get $dividend) (local.get $divisor))))))
    (if (i32.eq (local.get $mtype) (i32.const 3)) ;; IDIV
      (then (local.set $divisor (i64.extend_i32_s (local.get $mval)))
            (local.set $dividend (i64.or (i64.extend_i32_u (global.get $eax))
              (i64.shl (i64.extend_i32_u (global.get $edx)) (i64.const 32))))
            (if (i64.eqz (local.get $divisor)) (then (call $raise_exception (i32.const 0xC0000094)) (return)))
            (local.set $quotient (i64.div_s (local.get $dividend) (local.get $divisor)))
            (if (i32.or (i64.gt_s (local.get $quotient) (i64.const 0x7FFFFFFF))
                        (i64.lt_s (local.get $quotient) (i64.const -2147483648)))
              (then (call $raise_exception (i32.const 0xC0000094)) (return)))
            (global.set $eax (i32.wrap_i64 (local.get $quotient)))
            (global.set $edx (i32.wrap_i64 (i64.rem_s (local.get $dividend) (local.get $divisor))))))
            (NEXT))

  ;; 424: a whole run-length sprite blit ROW. Caesar III's decoder at 0x40f71c
  ;; is a loop nest, not a self-loop, so neither the Design-A matcher in
  ;; 07b-loop-match.wat nor $th_rect_run's straight-line scan can see it:
  ;;
  ;;   head:  cmp C, imm / jle EXIT          <- 934k entries in a 400-batch window
  ;;          mov T8, [S]                    <- the token byte
  ;;          cmp T8,imm / jz case   x N     <- folded on its own by 423
  ;;   caseK: mov X,[S+d] / mov [D+d],X  (k times, branch-free)
  ;;          add S,a / add D,b / sub C,c / jmp head
  ;;   0xff:  n = [S+1]; D += 2n; S += 2; C -= n     (transparent run)
  ;;
  ;; 34.7% of all dispatches in a gameplay window, at ~21 dispatches and ~3.4
  ;; painted pixels per token. This runs the whole row in one dispatch.
  ;;
  ;; Descriptor at $ip: [exit_eip][cmp_imm][head_cost][head_eip] then N+1
  ;; 8-word case records, the last being the ladder's default. $op packs
  ;; S | D<<4 | C<<8 | T<<12 | N<<16.
  ;;
  ;; Every field is *replayed*, never inferred: the decoder read each body's
  ;; displacements and its three literal advances out of the instruction
  ;; stream and checked them for contiguity, so copying $bytes and adding
  ;; $src_adv is by construction what the unrolled instructions did.
  (func $th_rle_run (param $op i32)
    (local $tp i32) (local $desc i32) (local $n i32)
    (local $S i32) (local $D i32) (local $C i32) (local $T i32)
    (local $s i32) (local $d i32) (local $c i32) (local $x i32)
    (local $exit_eip i32) (local $cmp_imm i32) (local $head i32)
    (local $head_eip i32) (local $tok i32) (local $i i32) (local $hit i32)
    (local $walked i32) (local $p i32) (local $kind i32) (local $insn i32)
    (local $src i32) (local $dst i32) (local $nb i32) (local $cnt i32)
    (local $cost i32) (local $iters i32)
    (local.set $tp (global.get $ip))
    (local.set $n (i32.and (i32.shr_u (local.get $op) (i32.const 16)) (i32.const 0xFF)))
    (local.set $exit_eip (i32.load          (local.get $tp)))
    (local.set $cmp_imm  (i32.load offset=4  (local.get $tp)))
    (local.set $head     (i32.load offset=8  (local.get $tp)))
    (local.set $head_eip (i32.load offset=12 (local.get $tp)))
    (local.set $desc (i32.add (local.get $tp) (i32.const 16)))
    (global.set $ip (i32.add (local.get $desc)
      (i32.shl (i32.add (local.get $n) (i32.const 1)) (i32.const 5))))

    (local.set $S (i32.and                  (local.get $op)                    (i32.const 0xF)))
    (local.set $D (i32.and (i32.shr_u (local.get $op) (i32.const 4))  (i32.const 0xF)))
    (local.set $C (i32.and (i32.shr_u (local.get $op) (i32.const 8))  (i32.const 0xF)))
    (local.set $T (i32.and (i32.shr_u (local.get $op) (i32.const 12)) (i32.const 0xF)))
    (local.set $s (call $get_reg (local.get $S)))
    (local.set $d (call $get_reg (local.get $D)))
    (local.set $c (call $get_reg (local.get $C)))
    (local.set $x (call $get_reg (local.get $T)))

    (block $done (loop $tokl
      ;; the head: cmp C,imm / jle EXIT
      (br_if $done (i32.le_s (local.get $c) (local.get $cmp_imm)))
      ;; A row is bounded by the guest's own counter, but a descriptor whose
      ;; skip run reads a zero count would spin here forever where the x86
      ;; would too. Park at the head instead -- resuming there is exactly
      ;; equivalent, and it hands the scheduler back a turn.
      (local.set $iters (i32.add (local.get $iters) (i32.const 1)))
      (if (i32.gt_u (local.get $iters) (i32.const 4096))
        (then
          (local.set $exit_eip (local.get $head_eip))
          (br $done)))

      (local.set $tok (call $gl8 (local.get $s)))
      ;; the head's `mov T8,[S]` writes only the low byte
      (local.set $x (i32.or (i32.and (local.get $x) (i32.const 0xFFFFFF00))
                            (local.get $tok)))

      ;; the ladder, walked linearly because that is what the x86 pays for
      (local.set $hit (local.get $n))
      (local.set $i (i32.const 0))
      (block $found (loop $l
        (br_if $found (i32.ge_u (local.get $i) (local.get $n)))
        (if (i32.eq (i32.load
              (i32.add (local.get $desc) (i32.shl (local.get $i) (i32.const 5))))
              (local.get $tok))
          (then (local.set $hit (local.get $i)) (br $found)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
      (local.set $walked (if (result i32) (i32.eq (local.get $hit) (local.get $n))
        (then (local.get $n)) (else (i32.add (local.get $hit) (i32.const 1)))))

      (local.set $p (i32.add (local.get $desc) (i32.shl (local.get $hit) (i32.const 5))))
      (local.set $kind (i32.load offset=4 (local.get $p)))
      (local.set $insn (i32.shr_u (local.get $kind) (i32.const 16)))

      (if (i32.and (local.get $kind) (i32.const 0xFF))
        (then
          ;; transparent run: n = [S + cnt_off]; D += n*mul; S += adv; C -= n
          (local.set $cnt (call $gl8
            (i32.add (local.get $s) (i32.load offset=8 (local.get $p)))))
          (local.set $x (local.get $cnt))
          (local.set $d (i32.add (local.get $d)
            (i32.mul (local.get $cnt) (i32.load offset=16 (local.get $p)))))
          (local.set $s (i32.add (local.get $s) (i32.load offset=20 (local.get $p))))
          (local.set $c (i32.sub (local.get $c) (local.get $cnt))))
        (else
          ;; literal run: the k unrolled load/store pairs, in order
          (local.set $src (i32.add (local.get $s) (i32.load offset=8  (local.get $p))))
          (local.set $dst (i32.add (local.get $d) (i32.load offset=12 (local.get $p))))
          (local.set $nb  (i32.load offset=16 (local.get $p)))
          (block $cdone (loop $cl
            (br_if $cdone (i32.lt_u (local.get $nb) (i32.const 4)))
            (local.set $x (call $gl32 (local.get $src)))
            (call $gs32 (local.get $dst) (local.get $x))
            (local.set $src (i32.add (local.get $src) (i32.const 4)))
            (local.set $dst (i32.add (local.get $dst) (i32.const 4)))
            (local.set $nb (i32.sub (local.get $nb) (i32.const 4)))
            (br $cl)))
          ;; an odd pixel at the end is a 16-bit pair, and it writes only AX
          (if (local.get $nb)
            (then
              (local.set $x (i32.or (i32.and (local.get $x) (i32.const 0xFFFF0000))
                                    (call $gl16 (local.get $src))))
              (call $gs16 (local.get $dst) (local.get $x))))
          (local.set $s (i32.add (local.get $s) (i32.load offset=20 (local.get $p))))
          (local.set $d (i32.add (local.get $d) (i32.load offset=24 (local.get $p))))
          (local.set $c (i32.sub (local.get $c) (i32.load offset=28 (local.get $p))))))

      ;; Pacing, both meters, same contract as 420-423: what this dispatch
      ;; swallowed is what the folded form must still be billed for, or a
      ;; batch buys more guest work here than it does with the fold off and
      ;; the two builds stop being comparable at a fixed batch number.
      ;; Per token: head cmp+jle+mov (3), the ladder's cmp/jz pairs (2 each,
      ;; which is what 423 bills), and the body's own dispatches.
      (local.set $cost (i32.add (local.get $cost)
        (i32.add (i32.add (local.get $head) (local.get $insn))
                 (i32.shl (local.get $walked) (i32.const 1)))))
      ;; three block ends a token: the head, the ladder block, the body.
      (global.set $block_budget (i32.sub (global.get $block_budget) (i32.const 3)))
      (br $tokl)))

    ;; the final cmp that fell out of the loop is billed too; $next billed one.
    (global.set $steps (i32.sub (global.get $steps)
      (i32.add (local.get $cost) (i32.const 1))))

    (call $set_reg (local.get $S) (local.get $s))
    (call $set_reg (local.get $D) (local.get $d))
    (call $set_reg (local.get $C) (local.get $c))
    (call $set_reg (local.get $T) (local.get $x))
    ;; Flags are the head's `cmp C,imm` -- the only ones that survive the loop,
    ;; exactly as every body's `sub C,c` is overwritten by the next head.
    (call $set_flags_sub (local.get $c) (local.get $cmp_imm)
      (i32.sub (local.get $c) (local.get $cmp_imm)))
    (global.set $flag_sign_shift (i32.const 31))
    (global.set $eip (local.get $exit_eip))
    (return_call $branch_end))
