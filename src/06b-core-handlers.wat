  ;; ============================================================
  ;; NON-FPU THREADED HANDLERS
  ;; Flag ops, LEAVE, BSWAP, XCHG, IMUL, the 16-bit ALU/MOV family, and every
  ;; memory-form (_ro) handler: EA computation, ALU, TEST, shifts, indirect
  ;; call/jmp, push/pop, movzx/movsx, mul/div.
  ;; 
  ;; These lived in 06-fpu.wat, which is named for the x87 unit and ends at
  ;; $th_fpu_mem_ro. Nothing here is FPU.
  ;; ============================================================

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
  ;; 399: ENTER imm16,0 — the ordinary 32-bit compiler frame prologue.
  ;; Non-zero nesting levels are rejected by the decoder.
  (func $th_enter (param $op i32)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $ebp))
    (global.set $ebp (global.get $esp))
    (global.set $esp
      (i32.sub (global.get $esp) (i32.and (local.get $op) (i32.const 0xFFFF))))
    (return_call $next))
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
    (return_call $next))
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
    (return_call $next))
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
    (return_call $next))
  ;; 159: r16 OP= [addr] (op=alu_op<<4|reg, addr in next word)
  (func $th_alu_r16_m16 (param $op i32)
    (local $addr i32) (local $reg i32) (local $alu i32) (local $val i32)
    (local.set $addr (call $read_addr))
    (local.set $reg (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0x7)))
    (local.set $val (call $do_alu_sized (local.get $alu) (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF)) (call $gl16 (local.get $addr)) (i32.const 0xFFFF) (i32.const 15)))
    (if (i32.ne (local.get $alu) (i32.const 7))
      (then (call $set_reg (local.get $reg) (i32.or (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF0000)) (i32.and (local.get $val) (i32.const 0xFFFF))))))
    (return_call $next))
  ;; 160: [addr] OP= r16 (op=alu_op<<4|reg, addr in next word)
  (func $th_alu_m16_r16 (param $op i32)
    (local $addr i32) (local $reg i32) (local $alu i32) (local $val i32)
    (local.set $addr (call $read_addr))
    (local.set $reg (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0x7)))
    (local.set $val (call $do_alu_sized (local.get $alu) (call $gl16 (local.get $addr)) (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF)) (i32.const 0xFFFF) (i32.const 15)))
    (if (i32.ne (local.get $alu) (i32.const 7))
      (then (call $gs16 (local.get $addr) (local.get $val))))
    (return_call $next))
  ;; 161: r16 OP= [base+disp] (op=alu_op<<8|reg<<4|base, disp in word)
  (func $th_alu_r16_m16_ro (param $op i32)
    (local $addr i32) (local $reg i32) (local $alu i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0x7)))
    (local.set $val (call $do_alu_sized (local.get $alu) (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF)) (call $gl16 (local.get $addr)) (i32.const 0xFFFF) (i32.const 15)))
    (if (i32.ne (local.get $alu) (i32.const 7))
      (then (call $set_reg (local.get $reg) (i32.or (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF0000)) (i32.and (local.get $val) (i32.const 0xFFFF))))))
    (return_call $next))
  ;; 162: [base+disp] OP= r16 (op=alu_op<<8|reg<<4|base, disp in word)
  (func $th_alu_m16_r16_ro (param $op i32)
    (local $addr i32) (local $reg i32) (local $alu i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0x7)))
    (local.set $val (call $do_alu_sized (local.get $alu) (call $gl16 (local.get $addr)) (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF)) (i32.const 0xFFFF) (i32.const 15)))
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
  (func $th_pop_m32 (param $op i32)
    (local $addr i32)
    (local.set $addr (call $read_addr))
    (call $gs32 (local.get $addr) (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return_call $next))
  (func $th_alu_m16_i16 (param $op i32)
    (local $addr i32) (local $imm i32) (local $val i32)
    ;; The immediate is masked to sixteen bits like the memory operand: a
    ;; sign-extended imm8 arrives as 0xFFFFFFxx and would compare unsigned
    ;; against a 16-bit value as though it were enormous. See $th_alu_r16_i16.
    (local.set $addr (call $read_addr))
    (local.set $imm (i32.and (call $read_thread_word) (i32.const 0xFFFF)))
    (local.set $val (call $do_alu_sized (local.get $op) (call $gl16 (local.get $addr)) (local.get $imm) (i32.const 0xFFFF) (i32.const 15)))
    (if (i32.ne (local.get $op) (i32.const 7)) (then (call $gs16 (local.get $addr) (local.get $val))))
    (return_call $next))
  (func $th_load8s (param $op i32)
    (local $v i32) (local.set $v (call $gl8 (call $read_addr)))
    (if (i32.ge_u (local.get $v) (i32.const 0x80))
      (then (local.set $v (i32.or (local.get $v) (i32.const 0xFFFFFF00)))))
    (call $set_reg (local.get $op) (local.get $v)) (return_call $next))
  (func $th_test_m8_i8 (param $op i32)
    (call $set_flags_logic (i32.and (call $gl8 (call $read_addr)) (local.get $op)))
    (global.set $flag_sign_shift (i32.const 7)) (return_call $next))

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
    (return_call $next))

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
    (return_call $next))

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
    (return_call $next))

  ;; 401: MOV byte [base+index*scale+disp], r8
  (func $th_store8_sib (param $op i32)
    (local $info i32)
    (local.set $info (call $read_thread_word))
    (if (global.get $handler_hist_enabled)
      (then (call $sib_consumer_hist_record (i32.const 25) (local.get $op) (local.get $info))))
    (call $gs8 (call $sib_ea (local.get $info) (call $read_thread_word))
      (call $get_reg8 (local.get $op)))
    (return_call $next))

  ;; 402: MOV byte [base+index*scale+disp], imm8 (op = the immediate)
  (func $th_mov_m8_i8_sib (param $op i32)
    (local $info i32)
    (local.set $info (call $read_thread_word))
    (if (global.get $handler_hist_enabled)
      (then (call $sib_consumer_hist_record (i32.const 77) (local.get $op) (local.get $info))))
    (call $gs8 (call $sib_ea (local.get $info) (call $read_thread_word)) (local.get $op))
    (return_call $next))

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
    (return_call $next))

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
      (else (global.set $eip (local.get $fall)))))

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
    (return_call $next))

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
    (return_call $next))

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
      (else (global.set $eip (local.get $fall)))))

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
    (return_call $next))

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
    (return_call $next))

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
    (return_call $next))

  ;; 391: MOV EAX,[EDX+disp] followed by TEST EAX,imm32. Smacker's Huffman
  ;; tree builder uses this pair for every node probe. MOV leaves flags alone;
  ;; TEST publishes the same lazy logic flags as the two ordinary handlers.
  (func $th_load_eax_edx_test_i32 (param $op i32)
    (global.set $eax
      (call $gl32
        (i32.add (global.get $edx) (call $read_thread_word))))
    (call $set_flags_logic
      (i32.and (global.get $eax) (call $read_thread_word)))
    (return_call $next))

  ;; 392: ADD EDX,EAX followed by the zero-displacement form of handler 391.
  ;; TEST overwrites every arithmetic flag written by ADD, so the only live
  ;; intermediate state is the updated EDX used as the load address.
  (func $th_add_edx_eax_load_test (param $op i32)
    (global.set $edx (i32.add (global.get $edx) (global.get $eax)))
    (global.set $eax (call $gl32 (global.get $edx)))
    (call $set_flags_logic
      (i32.and (global.get $eax) (call $read_thread_word)))
    (return_call $next))

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
      (else (global.set $eip (local.get $fall)))))

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
      (else (global.set $eip (local.get $fall)))))

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
    (return_call $next))

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
    (return_call $next))

  ;; 129: [base+disp] OP= reg8. operand = alu_op<<8 | reg<<4 | base.
  (func $th_alu_m8_r_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $reg i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $val (call $do_alu_sized (local.get $alu) (call $gl8 (local.get $addr)) (call $get_reg8 (local.get $reg)) (i32.const 0xFF) (i32.const 7)))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $gs8 (local.get $addr) (local.get $val))))
    (return_call $next))

  ;; 130: reg8 OP= [base+disp]. operand = alu_op<<8 | reg<<4 | base.
  (func $th_alu_r_m8_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $reg i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $val (call $do_alu_sized (local.get $alu) (call $get_reg8 (local.get $reg)) (call $gl8 (local.get $addr)) (i32.const 0xFF) (i32.const 7)))
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
    ;; The immediate is masked to eight bits like the memory operand: a
    ;; sign-extended imm8 arrives as 0xFFFFFFxx and would compare unsigned
    ;; against a byte as though it were enormous. See $th_alu_m16_i_ro.
    (local.set $imm (i32.and (call $read_thread_word) (i32.const 0xFF)))
    (local.set $val (call $do_alu_sized (local.get $alu) (call $gl8 (local.get $addr)) (local.get $imm) (i32.const 0xFF) (i32.const 7)))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $gs8 (local.get $addr) (local.get $val))))
    (return_call $next))

  ;; 220: [base+disp] OP= imm16. operand = alu_op<<8 | base. disp+imm in next words.
  (func $th_alu_m16_i_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $imm i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $imm (i32.and (call $read_thread_word) (i32.const 0xFFFF)))
    (local.set $val (call $do_alu_sized (local.get $alu) (call $gl16 (local.get $addr)) (local.get $imm) (i32.const 0xFFFF) (i32.const 15)))
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
    (global.set $flag_sign_shift (i32.const 7)) (return_call $next))
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
    (return_call $next))
  (func $th_pop_m32_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (call $gs32 (local.get $addr) (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return_call $next))
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
            (return_call $next))
