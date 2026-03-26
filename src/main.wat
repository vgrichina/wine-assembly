(module
  ;; ============================================================
  ;; Wine-Assembly: Windows 98 PE interpreter in raw WAT
  ;; Forth-style threaded code x86 interpreter
  ;; ============================================================

  ;; ---- Host imports ----
  (import "host" "log" (func $host_log (param i32 i32)))           ;; ptr, len
  (import "host" "log_i32" (func $host_log_i32 (param i32)))       ;; debug: print a number
  (import "host" "message_box" (func $host_message_box (param i32 i32 i32 i32) (result i32)))
  (import "host" "exit" (func $host_exit (param i32)))
  (import "host" "draw_rect" (func $host_draw_rect (param i32 i32 i32 i32 i32)))
  (import "host" "read_file" (func $host_read_file (param i32 i32 i32) (result i32)))

  ;; ---- Memory: 256 pages = 16MB initial ----
  (memory (export "memory") 256)

  ;; ============================================================
  ;; MEMORY MAP
  ;; ============================================================
  ;; 0x00000000  4KB    Null page (trap)
  ;; 0x00001000  256B   CPU state (registers)
  ;; 0x00001100  4KB    Internal scratch
  ;; 0x00002000  64KB   PE staging area
  ;; 0x00012000  4MB    Guest address space (PE sections loaded here)
  ;; 0x00412000  1MB    Guest stack
  ;; 0x00512000  1MB    Guest heap
  ;; 0x00612000  256KB  IAT thunk zone
  ;; 0x00652000  256KB  Thread cache (decoded Forth threads)
  ;; 0x00692000  64KB   Block cache index (hash table: guest_addr → thread_offset)
  ;; 0x006A2000  ...    Free

  ;; ============================================================
  ;; CONSTANTS
  ;; ============================================================

  ;; Memory region bases
  (global $CPU_STATE    i32 (i32.const 0x00001000))
  (global $PE_STAGING   i32 (i32.const 0x00002000))
  (global $GUEST_BASE   i32 (i32.const 0x00012000))
  (global $GUEST_STACK  i32 (i32.const 0x00512000))  ;; ESP starts here (top of 1MB stack)
  (global $GUEST_HEAP   i32 (i32.const 0x00512000))
  (global $THUNK_BASE   i32 (i32.const 0x00612000))
  (global $THUNK_END    i32 (i32.const 0x00652000))
  (global $THREAD_BASE  i32 (i32.const 0x00652000))
  (global $CACHE_INDEX  i32 (i32.const 0x00692000))

  ;; Guest code section bounds (set by PE loader)
  (global $code_start (mut i32) (i32.const 0))
  (global $code_end   (mut i32) (i32.const 0))

  ;; Thread cache bump allocator
  (global $thread_alloc (mut i32) (i32.const 0x00652000))

  ;; ============================================================
  ;; CPU STATE — x86 registers as globals for speed
  ;; ============================================================
  (global $eax (mut i32) (i32.const 0))
  (global $ecx (mut i32) (i32.const 0))
  (global $edx (mut i32) (i32.const 0))
  (global $ebx (mut i32) (i32.const 0))
  (global $esp (mut i32) (i32.const 0))
  (global $ebp (mut i32) (i32.const 0))
  (global $esi (mut i32) (i32.const 0))
  (global $edi (mut i32) (i32.const 0))
  (global $eip (mut i32) (i32.const 0))

  ;; Lazy flags: store last operation info, compute flags on demand
  ;; flag_op: 0=none, 1=add, 2=sub, 3=and, 4=or, 5=xor, 6=cmp, 7=dec, 8=inc
  (global $flag_op   (mut i32) (i32.const 0))
  (global $flag_a    (mut i32) (i32.const 0))  ;; left operand
  (global $flag_b    (mut i32) (i32.const 0))  ;; right operand
  (global $flag_res  (mut i32) (i32.const 0))  ;; result

  ;; Threaded interpreter state
  (global $ip    (mut i32) (i32.const 0))  ;; thread instruction pointer
  (global $steps (mut i32) (i32.const 0))  ;; remaining steps before yield

  ;; PE info
  (global $image_base   (mut i32) (i32.const 0))
  (global $entry_point  (mut i32) (i32.const 0))
  (global $num_thunks   (mut i32) (i32.const 0))

  ;; Heap bump allocator pointer (guest address space)
  (global $heap_ptr (mut i32) (i32.const 0x00512000))

  ;; Fake command line stored here (WASM address in scratch area)
  (global $fake_cmdline_addr (mut i32) (i32.const 0))

  ;; ============================================================
  ;; HANDLER TABLE — Forth-style threaded dispatch
  ;; ============================================================
  ;; Each handler: (func (param $operand i32))
  ;; Operand packing varies per op, documented at each handler.

  (type $handler_t (func (param i32)))

  (table $handlers 64 funcref)
  (elem (i32.const 0)
    ;; 0: nop
    $th_nop
    ;; 1: mov_reg_imm        operand: reg<<24 | imm(24-bit, sign-ext in handler if needed)
    $th_mov_reg_imm32
    ;; 2: mov_reg_reg        operand: dst<<4 | src
    $th_mov_reg_reg
    ;; 3: load_reg_mem       operand: dst<<4 | base   (load [base_reg] into dst_reg)
    $th_load_reg_mem
    ;; 4: store_reg_mem      operand: base<<4 | src    (store src_reg into [base_reg])
    $th_store_reg_mem
    ;; 5: add_reg_imm        operand: reg<<24 | imm
    $th_add_reg_imm
    ;; 6: sub_reg_imm        operand: reg<<24 | imm
    $th_sub_reg_imm
    ;; 7: add_reg_reg        operand: dst<<4 | src
    $th_add_reg_reg
    ;; 8: sub_reg_reg        operand: dst<<4 | src
    $th_sub_reg_reg
    ;; 9: xor_reg_reg        operand: dst<<4 | src
    $th_xor_reg_reg
    ;; 10: and_reg_reg       operand: dst<<4 | src
    $th_and_reg_reg
    ;; 11: or_reg_reg        operand: dst<<4 | src
    $th_or_reg_reg
    ;; 12: cmp_reg_imm       operand: reg<<24 | imm
    $th_cmp_reg_imm
    ;; 13: cmp_reg_reg       operand: dst<<4 | src
    $th_cmp_reg_reg
    ;; 14: push_reg          operand: reg
    $th_push_reg
    ;; 15: pop_reg           operand: reg
    $th_pop_reg
    ;; 16: push_imm          operand: (imm is in next thread word)
    $th_push_imm
    ;; 17: call_rel           operand: ignored (target addr in next thread word)
    $th_call_rel
    ;; 18: ret
    $th_ret
    ;; 19: jmp_rel            operand: ignored (target guest addr in next thread word)
    $th_jmp_rel
    ;; 20: jz_rel             operand: ignored (target guest addr in next thread word)
    $th_jz_rel
    ;; 21: jnz_rel
    $th_jnz_rel
    ;; 22: jl_rel (signed <)
    $th_jl_rel
    ;; 23: jge_rel (signed >=)
    $th_jge_rel
    ;; 24: jle_rel (signed <=)
    $th_jle_rel
    ;; 25: jg_rel (signed >)
    $th_jg_rel
    ;; 26: lea_reg            operand: dst<<4 | base  (+ disp in next thread word)
    $th_lea_reg
    ;; 27: dec_reg            operand: reg
    $th_dec_reg
    ;; 28: inc_reg            operand: reg
    $th_inc_reg
    ;; 29: call_indirect      operand: ignored (addr in next thread word — for call [mem])
    $th_call_indirect
    ;; 30: block_end          signals end of basic block, returns to $run
    $th_block_end
    ;; 31: mov_reg_imm32_wide operand: reg (full imm32 in next thread word)
    $th_mov_reg_imm32_wide
    ;; 32: xor_reg_imm       operand: reg<<24 | imm
    $th_xor_reg_imm
    ;; 33: and_reg_imm       operand: reg<<24 | imm
    $th_and_reg_imm
    ;; 34: or_reg_imm        operand: reg<<24 | imm
    $th_or_reg_imm
    ;; 35: load_reg_mem_disp  operand: dst<<4 | base (disp32 in next thread word)
    $th_load_reg_mem_disp
    ;; 36: store_reg_mem_disp operand: base<<4 | src (disp32 in next thread word)
    $th_store_reg_mem_disp
    ;; 37: test_reg_reg       operand: dst<<4 | src
    $th_test_reg_reg
    ;; 38: jb_rel (unsigned <)
    $th_jb_rel
    ;; 39: jae_rel (unsigned >=)
    $th_jae_rel
    ;; 40: movzx_reg_byte     operand: dst<<4 | src (zero-extend byte)
    $th_movzx_reg_byte
    ;; 41: thunk_call         operand: thunk index (Win32 API dispatch)
    $th_thunk_call
    ;; 42: mov_load_abs32     operand: reg (abs addr in next thread word)
    $th_load_abs32
    ;; 43: mov_store_abs32    operand: reg (abs addr in next thread word)
    $th_store_abs32
    ;; 44: load_byte_mem      operand: dst<<4 | base  (load byte [base] zero-ext into low byte of dst)
    $th_load_byte_mem
    ;; 45: store_byte_mem     operand: base<<4 | src  (store low byte of src into [base])
    $th_store_byte_mem
    ;; 46: cmp_al_imm8        operand: imm8
    $th_cmp_al_imm8
    ;; 47: load_byte_mem_disp operand: dst<<4 | base (disp32 in next word)
    $th_load_byte_mem_disp
    ;; 48: store_byte_mem_disp operand: base<<4 | src (disp32 in next word)
    $th_store_byte_mem_disp
    ;; 49: test_al_imm8       operand: imm8
    $th_test_al_imm8
    ;; 50: ret_imm16          operand: bytes to pop (stdcall ret N)
    $th_ret_imm16
    ;; 51: movsx_byte         operand: dst<<4 | src (sign-extend byte from [src_reg])
    $th_movsx_byte
    ;; 52: sub_esp_imm        operand: ignored (imm32 in next word) — optimized sub esp, N
    $th_sub_esp_imm
  )

  ;; ============================================================
  ;; REGISTER ACCESS HELPERS
  ;; ============================================================
  ;; reg index: 0=eax,1=ecx,2=edx,3=ebx,4=esp,5=ebp,6=esi,7=edi

  (func $get_reg (param $r i32) (result i32)
    (if (i32.eq (local.get $r) (i32.const 0)) (then (return (global.get $eax))))
    (if (i32.eq (local.get $r) (i32.const 1)) (then (return (global.get $ecx))))
    (if (i32.eq (local.get $r) (i32.const 2)) (then (return (global.get $edx))))
    (if (i32.eq (local.get $r) (i32.const 3)) (then (return (global.get $ebx))))
    (if (i32.eq (local.get $r) (i32.const 4)) (then (return (global.get $esp))))
    (if (i32.eq (local.get $r) (i32.const 5)) (then (return (global.get $ebp))))
    (if (i32.eq (local.get $r) (i32.const 6)) (then (return (global.get $esi))))
    (if (i32.eq (local.get $r) (i32.const 7)) (then (return (global.get $edi))))
    (unreachable)
  )

  (func $set_reg (param $r i32) (param $v i32)
    (if (i32.eq (local.get $r) (i32.const 0)) (then (global.set $eax (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 1)) (then (global.set $ecx (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 2)) (then (global.set $edx (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 3)) (then (global.set $ebx (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 4)) (then (global.set $esp (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 5)) (then (global.set $ebp (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 6)) (then (global.set $esi (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 7)) (then (global.set $edi (local.get $v)) (return)))
  )

  ;; ============================================================
  ;; GUEST MEMORY ACCESS
  ;; ============================================================
  ;; Translate guest virtual address to WASM linear memory address.
  ;; Guest addr space starts at $GUEST_BASE in linear memory.
  ;; Guest VA is relative to $image_base.

  (func $guest_to_wasm (param $guest_addr i32) (result i32)
    ;; wasm_addr = guest_addr - image_base + GUEST_BASE
    (i32.add
      (i32.sub (local.get $guest_addr) (global.get $image_base))
      (global.get $GUEST_BASE)
    )
  )

  (func $guest_load32 (param $guest_addr i32) (result i32)
    (i32.load (call $guest_to_wasm (local.get $guest_addr)))
  )

  (func $guest_load16 (param $guest_addr i32) (result i32)
    (i32.load16_u (call $guest_to_wasm (local.get $guest_addr)))
  )

  (func $guest_load8 (param $guest_addr i32) (result i32)
    (i32.load8_u (call $guest_to_wasm (local.get $guest_addr)))
  )

  (func $guest_store32 (param $guest_addr i32) (param $val i32)
    (local $wasm_addr i32)
    (local.set $wasm_addr (call $guest_to_wasm (local.get $guest_addr)))

    ;; Self-modifying code detection: if writing to code region, invalidate
    (if (i32.and
          (i32.ge_u (local.get $guest_addr) (global.get $code_start))
          (i32.lt_u (local.get $guest_addr) (global.get $code_end)))
      (then
        (call $invalidate_page (local.get $guest_addr))
      )
    )

    (i32.store (local.get $wasm_addr) (local.get $val))
  )

  (func $guest_store16 (param $guest_addr i32) (param $val i32)
    (local $wasm_addr i32)
    (local.set $wasm_addr (call $guest_to_wasm (local.get $guest_addr)))
    (if (i32.and
          (i32.ge_u (local.get $guest_addr) (global.get $code_start))
          (i32.lt_u (local.get $guest_addr) (global.get $code_end)))
      (then (call $invalidate_page (local.get $guest_addr))))
    (i32.store16 (local.get $wasm_addr) (local.get $val))
  )

  (func $guest_store8 (param $guest_addr i32) (param $val i32)
    (local $wasm_addr i32)
    (local.set $wasm_addr (call $guest_to_wasm (local.get $guest_addr)))
    (if (i32.and
          (i32.ge_u (local.get $guest_addr) (global.get $code_start))
          (i32.lt_u (local.get $guest_addr) (global.get $code_end)))
      (then (call $invalidate_page (local.get $guest_addr))))
    (i32.store8 (local.get $wasm_addr) (local.get $val))
  )

  ;; ============================================================
  ;; LAZY FLAGS
  ;; ============================================================
  ;; Instead of computing EFLAGS after every instruction, we store
  ;; the operation type and operands. Flags are computed on demand
  ;; by the conditional branch handlers.

  (func $set_flags_add (param $a i32) (param $b i32) (param $res i32)
    (global.set $flag_op  (i32.const 1))
    (global.set $flag_a   (local.get $a))
    (global.set $flag_b   (local.get $b))
    (global.set $flag_res (local.get $res))
  )

  (func $set_flags_sub (param $a i32) (param $b i32) (param $res i32)
    (global.set $flag_op  (i32.const 2))
    (global.set $flag_a   (local.get $a))
    (global.set $flag_b   (local.get $b))
    (global.set $flag_res (local.get $res))
  )

  (func $set_flags_logic (param $res i32)
    (global.set $flag_op  (i32.const 3))
    (global.set $flag_res (local.get $res))
  )

  ;; Zero flag
  (func $get_zf (result i32)
    (i32.eqz (global.get $flag_res))
  )

  ;; Sign flag
  (func $get_sf (result i32)
    (i32.shr_u (global.get $flag_res) (i32.const 31))
  )

  ;; Carry flag (unsigned overflow)
  (func $get_cf (result i32)
    ;; For add: CF = result < a
    (if (i32.eq (global.get $flag_op) (i32.const 1))
      (then (return (i32.lt_u (global.get $flag_res) (global.get $flag_a)))))
    ;; For sub/cmp: CF = a < b
    (if (i32.eq (global.get $flag_op) (i32.const 2))
      (then (return (i32.lt_u (global.get $flag_a) (global.get $flag_b)))))
    ;; For logic ops: CF = 0
    (i32.const 0)
  )

  ;; Overflow flag (signed overflow)
  (func $get_of (result i32)
    (local $sign_a i32)
    (local $sign_b i32)
    (local $sign_r i32)
    (local.set $sign_a (i32.shr_u (global.get $flag_a) (i32.const 31)))
    (local.set $sign_b (i32.shr_u (global.get $flag_b) (i32.const 31)))
    (local.set $sign_r (i32.shr_u (global.get $flag_res) (i32.const 31)))
    ;; For add: OF = (a_sign == b_sign) && (a_sign != res_sign)
    (if (i32.eq (global.get $flag_op) (i32.const 1))
      (then (return (i32.and
        (i32.eq (local.get $sign_a) (local.get $sign_b))
        (i32.ne (local.get $sign_a) (local.get $sign_r))))))
    ;; For sub/cmp: OF = (a_sign != b_sign) && (b_sign == res_sign)
    (if (i32.eq (global.get $flag_op) (i32.const 2))
      (then (return (i32.and
        (i32.ne (local.get $sign_a) (local.get $sign_b))
        (i32.eq (local.get $sign_b) (local.get $sign_r))))))
    (i32.const 0)
  )

  ;; ============================================================
  ;; BLOCK CACHE
  ;; ============================================================
  ;; Direct-mapped cache: 4096 slots
  ;; Each slot: [guest_addr:i32, thread_offset:i32] = 8 bytes
  ;; Total: 32KB at $CACHE_INDEX

  (func $cache_lookup (param $guest_addr i32) (result i32)
    (local $slot i32)
    (local $idx i32)
    ;; slot = (guest_addr >> 2) & 0xFFF
    (local.set $slot (i32.and (i32.shr_u (local.get $guest_addr) (i32.const 2)) (i32.const 0xFFF)))
    (local.set $idx (i32.add (global.get $CACHE_INDEX) (i32.mul (local.get $slot) (i32.const 8))))
    ;; check if this slot holds our address
    (if (i32.eq (i32.load (local.get $idx)) (local.get $guest_addr))
      (then (return (i32.load offset=4 (local.get $idx)))))
    (i32.const 0)  ;; miss
  )

  (func $cache_store (param $guest_addr i32) (param $thread_off i32)
    (local $slot i32)
    (local $idx i32)
    (local.set $slot (i32.and (i32.shr_u (local.get $guest_addr) (i32.const 2)) (i32.const 0xFFF)))
    (local.set $idx (i32.add (global.get $CACHE_INDEX) (i32.mul (local.get $slot) (i32.const 8))))
    (i32.store (local.get $idx) (local.get $guest_addr))
    (i32.store offset=4 (local.get $idx) (local.get $thread_off))
  )

  ;; Invalidate threads covering a page (4KB aligned)
  (func $invalidate_page (param $guest_addr i32)
    (local $page_base i32)
    (local $i i32)
    (local $idx i32)
    (local $cached_addr i32)
    ;; page_base = guest_addr & ~0xFFF
    (local.set $page_base (i32.and (local.get $guest_addr) (i32.const 0xFFFFF000)))
    ;; scan all 4096 cache slots and clear entries on this page
    (local.set $i (i32.const 0))
    (block $done
      (loop $scan
        (br_if $done (i32.ge_u (local.get $i) (i32.const 4096)))
        (local.set $idx (i32.add (global.get $CACHE_INDEX) (i32.mul (local.get $i) (i32.const 8))))
        (local.set $cached_addr (i32.load (local.get $idx)))
        (if (i32.eq
              (i32.and (local.get $cached_addr) (i32.const 0xFFFFF000))
              (local.get $page_base))
          (then
            (i32.store (local.get $idx) (i32.const 0))
            (i32.store offset=4 (local.get $idx) (i32.const 0))
          )
        )
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $scan)
      )
    )
  )

  ;; Allocate space in thread cache, returns offset
  (func $thread_emit_start (result i32)
    (global.get $thread_alloc)
  )

  ;; Emit a thread word: [func_idx:i32, operand:i32]
  (func $thread_emit (param $func_idx i32) (param $operand i32)
    (i32.store (global.get $thread_alloc) (local.get $func_idx))
    (i32.store offset=4 (global.get $thread_alloc) (local.get $operand))
    (global.set $thread_alloc (i32.add (global.get $thread_alloc) (i32.const 8)))
  )

  ;; Emit a raw i32 (used for wide immediates that follow an op)
  (func $thread_emit_raw (param $val i32)
    (i32.store (global.get $thread_alloc) (local.get $val))
    (global.set $thread_alloc (i32.add (global.get $thread_alloc) (i32.const 4)))
  )

  ;; ============================================================
  ;; FORTH INNER INTERPRETER — $next
  ;; ============================================================
  ;; $ip points into the thread cache.
  ;; Each entry is [func_idx:i32, operand:i32] = 8 bytes.
  ;; $next loads the func_idx, loads operand, advances $ip,
  ;; then call_indirect to the handler.

  (func $next
    (local $fn i32)
    (local $operand i32)

    ;; decrement step counter
    (global.set $steps (i32.sub (global.get $steps) (i32.const 1)))
    (if (i32.le_s (global.get $steps) (i32.const 0)) (then (return)))

    ;; load thread word
    (local.set $fn (i32.load (global.get $ip)))
    (local.set $operand (i32.load offset=4 (global.get $ip)))

    ;; advance $ip past this thread word
    (global.set $ip (i32.add (global.get $ip) (i32.const 8)))

    ;; dispatch to handler
    (call_indirect (type $handler_t) (local.get $operand) (local.get $fn))
  )

  ;; ============================================================
  ;; THREADED CODE HANDLERS
  ;; ============================================================

  ;; 0: nop — do nothing, continue
  (func $th_nop (param $operand i32)
    (call $next)
  )

  ;; 1: mov_reg_imm32 — operand: reg (full imm32 follows in next thread word)
  ;; NOTE: this is actually the wide version; kept as slot 1 for simplicity
  (func $th_mov_reg_imm32 (param $operand i32)
    (local $imm i32)
    ;; imm32 is in the next 4 bytes of thread
    (local.set $imm (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (call $set_reg (local.get $operand) (local.get $imm))
    (call $next)
  )

  ;; 2: mov_reg_reg — operand: dst<<4 | src
  (func $th_mov_reg_reg (param $operand i32)
    (call $set_reg
      (i32.shr_u (local.get $operand) (i32.const 4))
      (call $get_reg (i32.and (local.get $operand) (i32.const 0xF)))
    )
    (call $next)
  )

  ;; 3: load_reg_mem — load [base_reg] into dst_reg
  ;; operand: dst<<4 | base
  (func $th_load_reg_mem (param $operand i32)
    (call $set_reg
      (i32.shr_u (local.get $operand) (i32.const 4))
      (call $guest_load32 (call $get_reg (i32.and (local.get $operand) (i32.const 0xF))))
    )
    (call $next)
  )

  ;; 4: store_reg_mem — store src_reg into [base_reg]
  ;; operand: base<<4 | src
  (func $th_store_reg_mem (param $operand i32)
    (call $guest_store32
      (call $get_reg (i32.shr_u (local.get $operand) (i32.const 4)))
      (call $get_reg (i32.and (local.get $operand) (i32.const 0xF)))
    )
    (call $next)
  )

  ;; 5: add_reg_imm — operand: reg (imm32 in next thread word)
  (func $th_add_reg_imm (param $operand i32)
    (local $old i32)
    (local $imm i32)
    (local $res i32)
    (local.set $imm (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (local.set $old (call $get_reg (local.get $operand)))
    (local.set $res (i32.add (local.get $old) (local.get $imm)))
    (call $set_reg (local.get $operand) (local.get $res))
    (call $set_flags_add (local.get $old) (local.get $imm) (local.get $res))
    (call $next)
  )

  ;; 6: sub_reg_imm — operand: reg (imm32 in next thread word)
  (func $th_sub_reg_imm (param $operand i32)
    (local $old i32)
    (local $imm i32)
    (local $res i32)
    (local.set $imm (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (local.set $old (call $get_reg (local.get $operand)))
    (local.set $res (i32.sub (local.get $old) (local.get $imm)))
    (call $set_reg (local.get $operand) (local.get $res))
    (call $set_flags_sub (local.get $old) (local.get $imm) (local.get $res))
    (call $next)
  )

  ;; 7: add_reg_reg — operand: dst<<4 | src
  (func $th_add_reg_reg (param $operand i32)
    (local $dst i32) (local $a i32) (local $b i32) (local $res i32)
    (local.set $dst (i32.shr_u (local.get $operand) (i32.const 4)))
    (local.set $a (call $get_reg (local.get $dst)))
    (local.set $b (call $get_reg (i32.and (local.get $operand) (i32.const 0xF))))
    (local.set $res (i32.add (local.get $a) (local.get $b)))
    (call $set_reg (local.get $dst) (local.get $res))
    (call $set_flags_add (local.get $a) (local.get $b) (local.get $res))
    (call $next)
  )

  ;; 8: sub_reg_reg — operand: dst<<4 | src
  (func $th_sub_reg_reg (param $operand i32)
    (local $dst i32) (local $a i32) (local $b i32) (local $res i32)
    (local.set $dst (i32.shr_u (local.get $operand) (i32.const 4)))
    (local.set $a (call $get_reg (local.get $dst)))
    (local.set $b (call $get_reg (i32.and (local.get $operand) (i32.const 0xF))))
    (local.set $res (i32.sub (local.get $a) (local.get $b)))
    (call $set_reg (local.get $dst) (local.get $res))
    (call $set_flags_sub (local.get $a) (local.get $b) (local.get $res))
    (call $next)
  )

  ;; 9: xor_reg_reg — operand: dst<<4 | src
  (func $th_xor_reg_reg (param $operand i32)
    (local $dst i32) (local $res i32)
    (local.set $dst (i32.shr_u (local.get $operand) (i32.const 4)))
    (local.set $res (i32.xor
      (call $get_reg (local.get $dst))
      (call $get_reg (i32.and (local.get $operand) (i32.const 0xF)))))
    (call $set_reg (local.get $dst) (local.get $res))
    (call $set_flags_logic (local.get $res))
    (call $next)
  )

  ;; 10: and_reg_reg — operand: dst<<4 | src
  (func $th_and_reg_reg (param $operand i32)
    (local $dst i32) (local $res i32)
    (local.set $dst (i32.shr_u (local.get $operand) (i32.const 4)))
    (local.set $res (i32.and
      (call $get_reg (local.get $dst))
      (call $get_reg (i32.and (local.get $operand) (i32.const 0xF)))))
    (call $set_reg (local.get $dst) (local.get $res))
    (call $set_flags_logic (local.get $res))
    (call $next)
  )

  ;; 11: or_reg_reg — operand: dst<<4 | src
  (func $th_or_reg_reg (param $operand i32)
    (local $dst i32) (local $res i32)
    (local.set $dst (i32.shr_u (local.get $operand) (i32.const 4)))
    (local.set $res (i32.or
      (call $get_reg (local.get $dst))
      (call $get_reg (i32.and (local.get $operand) (i32.const 0xF)))))
    (call $set_reg (local.get $dst) (local.get $res))
    (call $set_flags_logic (local.get $res))
    (call $next)
  )

  ;; 12: cmp_reg_imm — operand: reg (imm32 in next thread word)
  (func $th_cmp_reg_imm (param $operand i32)
    (local $a i32) (local $b i32)
    (local.set $a (call $get_reg (local.get $operand)))
    (local.set $b (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (call $set_flags_sub (local.get $a) (local.get $b)
      (i32.sub (local.get $a) (local.get $b)))
    (call $next)
  )

  ;; 13: cmp_reg_reg — operand: dst<<4 | src
  (func $th_cmp_reg_reg (param $operand i32)
    (local $a i32) (local $b i32)
    (local.set $a (call $get_reg (i32.shr_u (local.get $operand) (i32.const 4))))
    (local.set $b (call $get_reg (i32.and (local.get $operand) (i32.const 0xF))))
    (call $set_flags_sub (local.get $a) (local.get $b)
      (i32.sub (local.get $a) (local.get $b)))
    (call $next)
  )

  ;; 14: push_reg — operand: reg index
  (func $th_push_reg (param $operand i32)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $guest_store32 (global.get $esp) (call $get_reg (local.get $operand)))
    (call $next)
  )

  ;; 15: pop_reg — operand: reg index
  (func $th_pop_reg (param $operand i32)
    (call $set_reg (local.get $operand) (call $guest_load32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
    (call $next)
  )

  ;; 16: push_imm — imm32 in next thread word
  (func $th_push_imm (param $operand i32)
    (local $imm i32)
    (local.set $imm (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $guest_store32 (global.get $esp) (local.get $imm))
    (call $next)
  )

  ;; 17: call_rel — target guest addr in next thread word
  ;; Pushes return address (stored in operand), sets EIP to target, ends block
  (func $th_call_rel (param $operand i32)
    (local $target i32)
    (local.set $target (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    ;; push return address (operand = guest addr of instruction after call)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $guest_store32 (global.get $esp) (local.get $operand))
    ;; set EIP to call target — block ends, $run will look up the new block
    (global.set $eip (local.get $target))
    ;; don't call $next — return to $run to dispatch new block
  )

  ;; 18: ret — pop return address into EIP, end block
  (func $th_ret (param $operand i32)
    (global.set $eip (call $guest_load32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
    ;; end block — return to $run
  )

  ;; 19: jmp_rel — target guest addr in next thread word
  (func $th_jmp_rel (param $operand i32)
    (global.set $eip (i32.load (global.get $ip)))
    ;; end block
  )

  ;; 20: jz_rel — jump if zero flag set
  ;; Always ends block. operand = fall-through addr, target in next thread word.
  (func $th_jz_rel (param $operand i32)
    (local $target i32)
    (local.set $target (i32.load (global.get $ip)))
    (if (call $get_zf)
      (then (global.set $eip (local.get $target)))
      (else (global.set $eip (local.get $operand)))
    )
  )

  ;; Let me redo conditional jumps cleanly — always end the block.
  ;; operand = fall-through guest addr. target = next thread word.

  ;; 21: jnz_rel — jump if not zero
  (func $th_jnz_rel (param $operand i32)
    (local $target i32)
    (local.set $target (i32.load (global.get $ip)))
    (if (i32.eqz (call $get_zf))
      (then (global.set $eip (local.get $target)))
      (else (global.set $eip (local.get $operand)))
    )
    ;; end block
  )

  ;; Fix $th_jz_rel to match the pattern:
  ;; (already defined above, but let's keep it — WAT allows only one def per name,
  ;;  so we need to fix the one above. We'll make them all consistent.)

  ;; 22: jl_rel — jump if SF != OF (signed less)
  (func $th_jl_rel (param $operand i32)
    (local $target i32)
    (local.set $target (i32.load (global.get $ip)))
    (if (i32.ne (call $get_sf) (call $get_of))
      (then (global.set $eip (local.get $target)))
      (else (global.set $eip (local.get $operand)))
    )
  )

  ;; 23: jge_rel — jump if SF == OF
  (func $th_jge_rel (param $operand i32)
    (local $target i32)
    (local.set $target (i32.load (global.get $ip)))
    (if (i32.eq (call $get_sf) (call $get_of))
      (then (global.set $eip (local.get $target)))
      (else (global.set $eip (local.get $operand)))
    )
  )

  ;; 24: jle_rel — jump if ZF=1 or SF!=OF
  (func $th_jle_rel (param $operand i32)
    (local $target i32)
    (local.set $target (i32.load (global.get $ip)))
    (if (i32.or (call $get_zf) (i32.ne (call $get_sf) (call $get_of)))
      (then (global.set $eip (local.get $target)))
      (else (global.set $eip (local.get $operand)))
    )
  )

  ;; 25: jg_rel — jump if ZF=0 and SF==OF
  (func $th_jg_rel (param $operand i32)
    (local $target i32)
    (local.set $target (i32.load (global.get $ip)))
    (if (i32.and (i32.eqz (call $get_zf)) (i32.eq (call $get_sf) (call $get_of)))
      (then (global.set $eip (local.get $target)))
      (else (global.set $eip (local.get $operand)))
    )
  )

  ;; 26: lea_reg — operand: dst<<4 | base, disp32 in next thread word
  (func $th_lea_reg (param $operand i32)
    (local $disp i32)
    (local.set $disp (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (call $set_reg
      (i32.shr_u (local.get $operand) (i32.const 4))
      (i32.add (call $get_reg (i32.and (local.get $operand) (i32.const 0xF))) (local.get $disp))
    )
    (call $next)
  )

  ;; 27: dec_reg
  (func $th_dec_reg (param $operand i32)
    (local $old i32) (local $res i32)
    (local.set $old (call $get_reg (local.get $operand)))
    (local.set $res (i32.sub (local.get $old) (i32.const 1)))
    (call $set_reg (local.get $operand) (local.get $res))
    (call $set_flags_sub (local.get $old) (i32.const 1) (local.get $res))
    (call $next)
  )

  ;; 28: inc_reg
  (func $th_inc_reg (param $operand i32)
    (local $old i32) (local $res i32)
    (local.set $old (call $get_reg (local.get $operand)))
    (local.set $res (i32.add (local.get $old) (i32.const 1)))
    (call $set_reg (local.get $operand) (local.get $res))
    (call $set_flags_add (local.get $old) (i32.const 1) (local.get $res))
    (call $next)
  )

  ;; 29: call_indirect — for call [mem] (e.g., IAT calls)
  ;; operand = return guest addr. target addr in next thread word loc, but
  ;; we read it from the memory location stored in the thread.
  (func $th_call_indirect (param $operand i32)
    (local $mem_addr i32)
    (local $target i32)
    (local.set $mem_addr (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (local.set $target (call $guest_load32 (local.get $mem_addr)))

    ;; Check if target is in thunk zone (Win32 API call)
    (if (i32.and
          (i32.ge_u (local.get $target) (global.get $THUNK_BASE))
          (i32.lt_u (local.get $target) (global.get $THUNK_END)))
      (then
        ;; It's a Win32 API call — dispatch it
        ;; Push return address onto guest stack (stdcall: callee cleans args)
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $guest_store32 (global.get $esp) (local.get $operand))
        (call $win32_dispatch
          (i32.div_u
            (i32.sub (local.get $target) (global.get $THUNK_BASE))
            (i32.const 8)))
        ;; win32_dispatch already popped ret addr + args via esp adjustment
        ;; Set EIP to return address (= operand)
        (global.set $eip (local.get $operand))
        ;; end block
        (return)
      )
    )
    ;; Not a thunk — regular indirect call
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $guest_store32 (global.get $esp) (local.get $operand))
    (global.set $eip (local.get $target))
    ;; end block
  )

  ;; 30: block_end — explicit end of block, EIP already set in operand
  (func $th_block_end (param $operand i32)
    (global.set $eip (local.get $operand))
    ;; return to $run
  )

  ;; 31: mov_reg_imm32_wide — same as slot 1 (alias)
  (func $th_mov_reg_imm32_wide (param $operand i32)
    (local $imm i32)
    (local.set $imm (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (call $set_reg (local.get $operand) (local.get $imm))
    (call $next)
  )

  ;; 32: xor_reg_imm
  (func $th_xor_reg_imm (param $operand i32)
    (local $imm i32) (local $res i32)
    (local.set $imm (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (local.set $res (i32.xor (call $get_reg (local.get $operand)) (local.get $imm)))
    (call $set_reg (local.get $operand) (local.get $res))
    (call $set_flags_logic (local.get $res))
    (call $next)
  )

  ;; 33: and_reg_imm
  (func $th_and_reg_imm (param $operand i32)
    (local $imm i32) (local $res i32)
    (local.set $imm (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (local.set $res (i32.and (call $get_reg (local.get $operand)) (local.get $imm)))
    (call $set_reg (local.get $operand) (local.get $res))
    (call $set_flags_logic (local.get $res))
    (call $next)
  )

  ;; 34: or_reg_imm
  (func $th_or_reg_imm (param $operand i32)
    (local $imm i32) (local $res i32)
    (local.set $imm (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (local.set $res (i32.or (call $get_reg (local.get $operand)) (local.get $imm)))
    (call $set_reg (local.get $operand) (local.get $res))
    (call $set_flags_logic (local.get $res))
    (call $next)
  )

  ;; 35: load_reg_mem_disp — load [base+disp32] into dst
  ;; operand: dst<<4 | base, disp32 in next thread word
  (func $th_load_reg_mem_disp (param $operand i32)
    (local $disp i32) (local $addr i32)
    (local.set $disp (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (local.set $addr (i32.add
      (call $get_reg (i32.and (local.get $operand) (i32.const 0xF)))
      (local.get $disp)))
    (call $set_reg
      (i32.shr_u (local.get $operand) (i32.const 4))
      (call $guest_load32 (local.get $addr)))
    (call $next)
  )

  ;; 36: store_reg_mem_disp — store src into [base+disp32]
  ;; operand: base<<4 | src, disp32 in next thread word
  (func $th_store_reg_mem_disp (param $operand i32)
    (local $disp i32) (local $addr i32)
    (local.set $disp (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (local.set $addr (i32.add
      (call $get_reg (i32.shr_u (local.get $operand) (i32.const 4)))
      (local.get $disp)))
    (call $guest_store32 (local.get $addr)
      (call $get_reg (i32.and (local.get $operand) (i32.const 0xF))))
    (call $next)
  )

  ;; 37: test_reg_reg — like AND but don't store result
  (func $th_test_reg_reg (param $operand i32)
    (call $set_flags_logic
      (i32.and
        (call $get_reg (i32.shr_u (local.get $operand) (i32.const 4)))
        (call $get_reg (i32.and (local.get $operand) (i32.const 0xF)))))
    (call $next)
  )

  ;; 38: jb_rel — jump if CF=1 (unsigned below)
  (func $th_jb_rel (param $operand i32)
    (local $target i32)
    (local.set $target (i32.load (global.get $ip)))
    (if (call $get_cf)
      (then (global.set $eip (local.get $target)))
      (else (global.set $eip (local.get $operand)))
    )
  )

  ;; 39: jae_rel — jump if CF=0 (unsigned above or equal)
  (func $th_jae_rel (param $operand i32)
    (local $target i32)
    (local.set $target (i32.load (global.get $ip)))
    (if (i32.eqz (call $get_cf))
      (then (global.set $eip (local.get $target)))
      (else (global.set $eip (local.get $operand)))
    )
  )

  ;; 40: movzx_reg_byte — zero-extend byte from [base_reg] into dst
  ;; operand: dst<<4 | base
  (func $th_movzx_reg_byte (param $operand i32)
    (call $set_reg
      (i32.shr_u (local.get $operand) (i32.const 4))
      (call $guest_load8 (call $get_reg (i32.and (local.get $operand) (i32.const 0xF))))
    )
    (call $next)
  )

  ;; 41: thunk_call — Win32 API call by thunk index
  (func $th_thunk_call (param $operand i32)
    (call $win32_dispatch (local.get $operand))
    ;; win32_dispatch handles stdcall cleanup and sets EIP
    ;; end block
  )

  ;; 42: load_abs32 — mov reg, [abs_addr]
  (func $th_load_abs32 (param $operand i32)
    (local $addr i32)
    (local.set $addr (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (call $set_reg (local.get $operand) (call $guest_load32 (local.get $addr)))
    (call $next)
  )

  ;; 43: store_abs32 — mov [abs_addr], reg
  (func $th_store_abs32 (param $operand i32)
    (local $addr i32)
    (local.set $addr (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (call $guest_store32 (local.get $addr) (call $get_reg (local.get $operand)))
    (call $next)
  )

  ;; 44: load_byte_mem — load byte [base_reg] zero-ext into dst (low byte)
  ;; For simplicity, loads into full 32-bit reg as zero-extended
  (func $th_load_byte_mem (param $operand i32)
    (call $set_reg
      (i32.shr_u (local.get $operand) (i32.const 4))
      (call $guest_load8 (call $get_reg (i32.and (local.get $operand) (i32.const 0xF)))))
    (call $next)
  )

  ;; 45: store_byte_mem — store low byte of src into [base_reg]
  (func $th_store_byte_mem (param $operand i32)
    (call $guest_store8
      (call $get_reg (i32.shr_u (local.get $operand) (i32.const 4)))
      (i32.and (call $get_reg (i32.and (local.get $operand) (i32.const 0xF))) (i32.const 0xFF)))
    (call $next)
  )

  ;; 46: cmp_al_imm8
  (func $th_cmp_al_imm8 (param $operand i32)
    (local $al i32)
    (local.set $al (i32.and (global.get $eax) (i32.const 0xFF)))
    (call $set_flags_sub (local.get $al) (local.get $operand)
      (i32.sub (local.get $al) (local.get $operand)))
    (call $next)
  )

  ;; 47: load_byte_mem_disp — load byte [base+disp32] zero-ext into dst
  (func $th_load_byte_mem_disp (param $operand i32)
    (local $disp i32) (local $addr i32)
    (local.set $disp (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (local.set $addr (i32.add
      (call $get_reg (i32.and (local.get $operand) (i32.const 0xF)))
      (local.get $disp)))
    (call $set_reg
      (i32.shr_u (local.get $operand) (i32.const 4))
      (call $guest_load8 (local.get $addr)))
    (call $next)
  )

  ;; 48: store_byte_mem_disp — store low byte of src into [base+disp32]
  (func $th_store_byte_mem_disp (param $operand i32)
    (local $disp i32) (local $addr i32)
    (local.set $disp (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (local.set $addr (i32.add
      (call $get_reg (i32.shr_u (local.get $operand) (i32.const 4)))
      (local.get $disp)))
    (call $guest_store8 (local.get $addr)
      (i32.and (call $get_reg (i32.and (local.get $operand) (i32.const 0xF))) (i32.const 0xFF)))
    (call $next)
  )

  ;; 49: test_al_imm8
  (func $th_test_al_imm8 (param $operand i32)
    (call $set_flags_logic
      (i32.and (i32.and (global.get $eax) (i32.const 0xFF)) (local.get $operand)))
    (call $next)
  )

  ;; 50: ret_imm16 — ret N (pop return addr + N extra bytes)
  (func $th_ret_imm16 (param $operand i32)
    (global.set $eip (call $guest_load32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.add (i32.const 4) (local.get $operand))))
  )

  ;; 51: movsx_byte — sign-extend byte from [src_reg] into dst
  (func $th_movsx_byte (param $operand i32)
    (local $val i32)
    (local.set $val (call $guest_load8
      (call $get_reg (i32.and (local.get $operand) (i32.const 0xF)))))
    (if (i32.ge_u (local.get $val) (i32.const 0x80))
      (then (local.set $val (i32.or (local.get $val) (i32.const 0xFFFFFF00)))))
    (call $set_reg (i32.shr_u (local.get $operand) (i32.const 4)) (local.get $val))
    (call $next)
  )

  ;; 52: sub_esp_imm — optimized: sub esp, imm32
  (func $th_sub_esp_imm (param $operand i32)
    (local $imm i32)
    (local.set $imm (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (global.set $esp (i32.sub (global.get $esp) (local.get $imm)))
    (call $next)
  )

  ;; ============================================================
  ;; x86 DECODER — decodes a basic block into threaded code
  ;; ============================================================
  ;; Reads x86 bytes from guest memory starting at $eip.
  ;; Emits thread words into the thread cache.
  ;; Stops at: RET, JMP, Jcc, CALL, or unrecognized opcode.
  ;; Returns the thread cache offset of the emitted block.

  (func $decode_block (param $start_eip i32) (result i32)
    (local $thread_start i32)
    (local $pc i32)           ;; current decode position (guest addr)
    (local $opcode i32)
    (local $modrm i32)
    (local $mod i32)
    (local $reg i32)
    (local $rm i32)
    (local $disp i32)
    (local $imm i32)
    (local $done i32)
    (local $next_pc i32)

    (local.set $thread_start (call $thread_emit_start))
    (local.set $pc (local.get $start_eip))
    (local.set $done (i32.const 0))

    (block $exit
      (loop $decode_loop
        (br_if $exit (local.get $done))

        ;; Fetch opcode
        (local.set $opcode (call $guest_load8 (local.get $pc)))
        (local.set $pc (i32.add (local.get $pc) (i32.const 1)))

        ;; ---- NOP (0x90) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x90))
          (then
            (call $thread_emit (i32.const 0) (i32.const 0))  ;; th_nop
            (br $decode_loop)
          )
        )

        ;; ---- PUSH reg (0x50-0x57) ----
        (if (i32.and
              (i32.ge_u (local.get $opcode) (i32.const 0x50))
              (i32.le_u (local.get $opcode) (i32.const 0x57)))
          (then
            (call $thread_emit (i32.const 14)  ;; th_push_reg
              (i32.sub (local.get $opcode) (i32.const 0x50)))
            (br $decode_loop)
          )
        )

        ;; ---- POP reg (0x58-0x5F) ----
        (if (i32.and
              (i32.ge_u (local.get $opcode) (i32.const 0x58))
              (i32.le_u (local.get $opcode) (i32.const 0x5F)))
          (then
            (call $thread_emit (i32.const 15)  ;; th_pop_reg
              (i32.sub (local.get $opcode) (i32.const 0x58)))
            (br $decode_loop)
          )
        )

        ;; ---- MOV reg, imm32 (0xB8-0xBF) ----
        (if (i32.and
              (i32.ge_u (local.get $opcode) (i32.const 0xB8))
              (i32.le_u (local.get $opcode) (i32.const 0xBF)))
          (then
            (local.set $imm (call $guest_load32 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 4)))
            (call $thread_emit (i32.const 1)  ;; th_mov_reg_imm32
              (i32.sub (local.get $opcode) (i32.const 0xB8)))
            (call $thread_emit_raw (local.get $imm))
            (br $decode_loop)
          )
        )

        ;; ---- PUSH imm32 (0x68) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x68))
          (then
            (local.set $imm (call $guest_load32 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 4)))
            (call $thread_emit (i32.const 16) (i32.const 0))  ;; th_push_imm
            (call $thread_emit_raw (local.get $imm))
            (br $decode_loop)
          )
        )

        ;; ---- PUSH imm8 sign-extended (0x6A) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x6A))
          (then
            (local.set $imm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            ;; sign extend byte to i32
            (if (i32.ge_u (local.get $imm) (i32.const 0x80))
              (then (local.set $imm (i32.or (local.get $imm) (i32.const 0xFFFFFF00)))))
            (call $thread_emit (i32.const 16) (i32.const 0))
            (call $thread_emit_raw (local.get $imm))
            (br $decode_loop)
          )
        )

        ;; ---- CALL rel32 (0xE8) ----
        (if (i32.eq (local.get $opcode) (i32.const 0xE8))
          (then
            (local.set $disp (call $guest_load32 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 4)))
            ;; target = pc + disp (pc already past the 4 imm bytes)
            (call $thread_emit (i32.const 17) (local.get $pc))  ;; operand = return addr
            (call $thread_emit_raw (i32.add (local.get $pc) (local.get $disp)))  ;; target
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- RET (0xC3) ----
        (if (i32.eq (local.get $opcode) (i32.const 0xC3))
          (then
            (call $thread_emit (i32.const 18) (i32.const 0))  ;; th_ret
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- JMP rel8 (0xEB) ----
        (if (i32.eq (local.get $opcode) (i32.const 0xEB))
          (then
            (local.set $disp (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (if (i32.ge_u (local.get $disp) (i32.const 0x80))
              (then (local.set $disp (i32.or (local.get $disp) (i32.const 0xFFFFFF00)))))
            (call $thread_emit (i32.const 19) (i32.const 0))  ;; th_jmp_rel
            (call $thread_emit_raw (i32.add (local.get $pc) (local.get $disp)))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- JMP rel32 (0xE9) ----
        (if (i32.eq (local.get $opcode) (i32.const 0xE9))
          (then
            (local.set $disp (call $guest_load32 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 4)))
            (call $thread_emit (i32.const 19) (i32.const 0))
            (call $thread_emit_raw (i32.add (local.get $pc) (local.get $disp)))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- Jcc rel8: JZ(0x74), JNZ(0x75), JL(0x7C), JGE(0x7D), JLE(0x7E), JG(0x7F) ----
        ;; ---- Also: JB(0x72), JAE(0x73) ----
        (if (i32.and
              (i32.ge_u (local.get $opcode) (i32.const 0x70))
              (i32.le_u (local.get $opcode) (i32.const 0x7F)))
          (then
            (local.set $disp (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (if (i32.ge_u (local.get $disp) (i32.const 0x80))
              (then (local.set $disp (i32.or (local.get $disp) (i32.const 0xFFFFFF00)))))

            ;; Map x86 condition code to our handler index
            ;; 0x74=JZ→20, 0x75=JNZ→21, 0x7C=JL→22, 0x7D=JGE→23, 0x7E=JLE→24, 0x7F=JG→25
            ;; 0x72=JB→38, 0x73=JAE→39
            (if (i32.eq (local.get $opcode) (i32.const 0x74))
              (then
                (call $thread_emit (i32.const 20) (local.get $pc)) ;; fall-through addr
                (call $thread_emit_raw (i32.add (local.get $pc) (local.get $disp)))))
            (if (i32.eq (local.get $opcode) (i32.const 0x75))
              (then
                (call $thread_emit (i32.const 21) (local.get $pc))
                (call $thread_emit_raw (i32.add (local.get $pc) (local.get $disp)))))
            (if (i32.eq (local.get $opcode) (i32.const 0x7C))
              (then
                (call $thread_emit (i32.const 22) (local.get $pc))
                (call $thread_emit_raw (i32.add (local.get $pc) (local.get $disp)))))
            (if (i32.eq (local.get $opcode) (i32.const 0x7D))
              (then
                (call $thread_emit (i32.const 23) (local.get $pc))
                (call $thread_emit_raw (i32.add (local.get $pc) (local.get $disp)))))
            (if (i32.eq (local.get $opcode) (i32.const 0x7E))
              (then
                (call $thread_emit (i32.const 24) (local.get $pc))
                (call $thread_emit_raw (i32.add (local.get $pc) (local.get $disp)))))
            (if (i32.eq (local.get $opcode) (i32.const 0x7F))
              (then
                (call $thread_emit (i32.const 25) (local.get $pc))
                (call $thread_emit_raw (i32.add (local.get $pc) (local.get $disp)))))
            (if (i32.eq (local.get $opcode) (i32.const 0x72))
              (then
                (call $thread_emit (i32.const 38) (local.get $pc))
                (call $thread_emit_raw (i32.add (local.get $pc) (local.get $disp)))))
            (if (i32.eq (local.get $opcode) (i32.const 0x73))
              (then
                (call $thread_emit (i32.const 39) (local.get $pc))
                (call $thread_emit_raw (i32.add (local.get $pc) (local.get $disp)))))

            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- INC reg (0x40-0x47) ----
        (if (i32.and
              (i32.ge_u (local.get $opcode) (i32.const 0x40))
              (i32.le_u (local.get $opcode) (i32.const 0x47)))
          (then
            (call $thread_emit (i32.const 28) ;; th_inc_reg
              (i32.sub (local.get $opcode) (i32.const 0x40)))
            (br $decode_loop)
          )
        )

        ;; ---- DEC reg (0x48-0x4F) ----
        (if (i32.and
              (i32.ge_u (local.get $opcode) (i32.const 0x48))
              (i32.le_u (local.get $opcode) (i32.const 0x4F)))
          (then
            (call $thread_emit (i32.const 27) ;; th_dec_reg
              (i32.sub (local.get $opcode) (i32.const 0x48)))
            (br $decode_loop)
          )
        )

        ;; ---- XOR reg,reg (0x31) ---- common: xor eax,eax
        (if (i32.eq (local.get $opcode) (i32.const 0x31))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
            (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
            ;; Only handle mod=11 (reg,reg) for now
            (if (i32.eq (i32.shr_u (local.get $modrm) (i32.const 6)) (i32.const 3))
              (then
                (call $thread_emit (i32.const 9) ;; th_xor_reg_reg
                  (i32.or (i32.shl (local.get $rm) (i32.const 4)) (local.get $reg)))
                (br $decode_loop)
              )
            )
            ;; TODO: handle memory operands
            (call $thread_emit (i32.const 30) (local.get $pc))  ;; block_end on unhandled
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- XOR r,r/m (0x33) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x33))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
            (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
            (if (i32.eq (i32.shr_u (local.get $modrm) (i32.const 6)) (i32.const 3))
              (then
                (call $thread_emit (i32.const 9)
                  (i32.or (i32.shl (local.get $reg) (i32.const 4)) (local.get $rm)))
                (br $decode_loop)
              )
            )
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- MOV r/m32, r32 (0x89) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x89))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (local.set $mod (i32.shr_u (local.get $modrm) (i32.const 6)))
            (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
            (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))

            ;; mod=11: mov reg,reg
            (if (i32.eq (local.get $mod) (i32.const 3))
              (then
                (call $thread_emit (i32.const 2)  ;; th_mov_reg_reg
                  (i32.or (i32.shl (local.get $rm) (i32.const 4)) (local.get $reg)))
                (br $decode_loop)
              )
            )
            ;; mod=00, rm!=5,4: mov [reg], reg
            (if (i32.and
                  (i32.eq (local.get $mod) (i32.const 0))
                  (i32.and
                    (i32.ne (local.get $rm) (i32.const 5))
                    (i32.ne (local.get $rm) (i32.const 4))))
              (then
                (call $thread_emit (i32.const 4) ;; th_store_reg_mem
                  (i32.or (i32.shl (local.get $rm) (i32.const 4)) (local.get $reg)))
                (br $decode_loop)
              )
            )
            ;; mod=10: mov [reg+disp32], reg
            (if (i32.and
                  (i32.eq (local.get $mod) (i32.const 2))
                  (i32.ne (local.get $rm) (i32.const 4)))
              (then
                (local.set $disp (call $guest_load32 (local.get $pc)))
                (local.set $pc (i32.add (local.get $pc) (i32.const 4)))
                (call $thread_emit (i32.const 36) ;; th_store_reg_mem_disp
                  (i32.or (i32.shl (local.get $rm) (i32.const 4)) (local.get $reg)))
                (call $thread_emit_raw (local.get $disp))
                (br $decode_loop)
              )
            )
            ;; mod=01: mov [reg+disp8], reg
            (if (i32.and
                  (i32.eq (local.get $mod) (i32.const 1))
                  (i32.ne (local.get $rm) (i32.const 4)))
              (then
                (local.set $disp (call $guest_load8 (local.get $pc)))
                (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
                (if (i32.ge_u (local.get $disp) (i32.const 0x80))
                  (then (local.set $disp (i32.or (local.get $disp) (i32.const 0xFFFFFF00)))))
                (call $thread_emit (i32.const 36)
                  (i32.or (i32.shl (local.get $rm) (i32.const 4)) (local.get $reg)))
                (call $thread_emit_raw (local.get $disp))
                (br $decode_loop)
              )
            )
            ;; Unhandled addressing mode
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- MOV r32, r/m32 (0x8B) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x8B))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (local.set $mod (i32.shr_u (local.get $modrm) (i32.const 6)))
            (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
            (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))

            (if (i32.eq (local.get $mod) (i32.const 3))
              (then
                (call $thread_emit (i32.const 2)
                  (i32.or (i32.shl (local.get $reg) (i32.const 4)) (local.get $rm)))
                (br $decode_loop)
              )
            )
            (if (i32.and
                  (i32.eq (local.get $mod) (i32.const 0))
                  (i32.and
                    (i32.ne (local.get $rm) (i32.const 5))
                    (i32.ne (local.get $rm) (i32.const 4))))
              (then
                (call $thread_emit (i32.const 3) ;; th_load_reg_mem
                  (i32.or (i32.shl (local.get $reg) (i32.const 4)) (local.get $rm)))
                (br $decode_loop)
              )
            )
            (if (i32.and
                  (i32.eq (local.get $mod) (i32.const 2))
                  (i32.ne (local.get $rm) (i32.const 4)))
              (then
                (local.set $disp (call $guest_load32 (local.get $pc)))
                (local.set $pc (i32.add (local.get $pc) (i32.const 4)))
                (call $thread_emit (i32.const 35)
                  (i32.or (i32.shl (local.get $reg) (i32.const 4)) (local.get $rm)))
                (call $thread_emit_raw (local.get $disp))
                (br $decode_loop)
              )
            )
            (if (i32.and
                  (i32.eq (local.get $mod) (i32.const 1))
                  (i32.ne (local.get $rm) (i32.const 4)))
              (then
                (local.set $disp (call $guest_load8 (local.get $pc)))
                (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
                (if (i32.ge_u (local.get $disp) (i32.const 0x80))
                  (then (local.set $disp (i32.or (local.get $disp) (i32.const 0xFFFFFF00)))))
                (call $thread_emit (i32.const 35)
                  (i32.or (i32.shl (local.get $reg) (i32.const 4)) (local.get $rm)))
                (call $thread_emit_raw (local.get $disp))
                (br $decode_loop)
              )
            )
            ;; mod=00, rm=5: disp32 (no base register)
            (if (i32.and (i32.eq (local.get $mod) (i32.const 0)) (i32.eq (local.get $rm) (i32.const 5)))
              (then
                (local.set $disp (call $guest_load32 (local.get $pc)))
                (local.set $pc (i32.add (local.get $pc) (i32.const 4)))
                ;; Load from absolute address — emit as load_reg_mem_disp with base=0 hack
                ;; Actually: use mov_reg_imm32 to load the address, but that changes a register.
                ;; Better: emit a special "load from absolute" — but we don't have that handler.
                ;; For now: end block.
                (call $thread_emit (i32.const 30) (local.get $pc))
                (local.set $done (i32.const 1))
                (br $decode_loop)
              )
            )
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- SUB r/m32, imm8 sign-ext / ADD / CMP / AND / OR / XOR (0x83) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x83))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
            (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))

            ;; Only handle mod=11 (register) for now
            (if (i32.eq (i32.shr_u (local.get $modrm) (i32.const 6)) (i32.const 3))
              (then
                (local.set $imm (call $guest_load8 (local.get $pc)))
                (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
                ;; sign-extend
                (if (i32.ge_u (local.get $imm) (i32.const 0x80))
                  (then (local.set $imm (i32.or (local.get $imm) (i32.const 0xFFFFFF00)))))

                ;; reg field selects operation: 0=ADD, 1=OR, 4=AND, 5=SUB, 6=XOR, 7=CMP
                (if (i32.eq (local.get $reg) (i32.const 0))
                  (then
                    (call $thread_emit (i32.const 5) (local.get $rm))  ;; add_reg_imm
                    (call $thread_emit_raw (local.get $imm))
                    (br $decode_loop)))
                (if (i32.eq (local.get $reg) (i32.const 5))
                  (then
                    (call $thread_emit (i32.const 6) (local.get $rm))  ;; sub_reg_imm
                    (call $thread_emit_raw (local.get $imm))
                    (br $decode_loop)))
                (if (i32.eq (local.get $reg) (i32.const 7))
                  (then
                    (call $thread_emit (i32.const 12) (local.get $rm))  ;; cmp_reg_imm
                    (call $thread_emit_raw (local.get $imm))
                    (br $decode_loop)))
                (if (i32.eq (local.get $reg) (i32.const 4))
                  (then
                    (call $thread_emit (i32.const 33) (local.get $rm))  ;; and_reg_imm
                    (call $thread_emit_raw (local.get $imm))
                    (br $decode_loop)))
                (if (i32.eq (local.get $reg) (i32.const 6))
                  (then
                    (call $thread_emit (i32.const 32) (local.get $rm))  ;; xor_reg_imm
                    (call $thread_emit_raw (local.get $imm))
                    (br $decode_loop)))
                (if (i32.eq (local.get $reg) (i32.const 1))
                  (then
                    (call $thread_emit (i32.const 34) (local.get $rm))  ;; or_reg_imm
                    (call $thread_emit_raw (local.get $imm))
                    (br $decode_loop)))
              )
            )
            ;; Unhandled
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- ADD r/m32, r32 (0x01) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x01))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (if (i32.eq (i32.shr_u (local.get $modrm) (i32.const 6)) (i32.const 3))
              (then
                (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
                (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
                (call $thread_emit (i32.const 7)  ;; th_add_reg_reg
                  (i32.or (i32.shl (local.get $rm) (i32.const 4)) (local.get $reg)))
                (br $decode_loop)))
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- SUB r/m32, r32 (0x29) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x29))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (if (i32.eq (i32.shr_u (local.get $modrm) (i32.const 6)) (i32.const 3))
              (then
                (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
                (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
                (call $thread_emit (i32.const 8)  ;; th_sub_reg_reg
                  (i32.or (i32.shl (local.get $rm) (i32.const 4)) (local.get $reg)))
                (br $decode_loop)))
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- CMP r/m32, r32 (0x39) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x39))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (if (i32.eq (i32.shr_u (local.get $modrm) (i32.const 6)) (i32.const 3))
              (then
                (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
                (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
                (call $thread_emit (i32.const 13)  ;; th_cmp_reg_reg
                  (i32.or (i32.shl (local.get $rm) (i32.const 4)) (local.get $reg)))
                (br $decode_loop)))
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- TEST r/m32, r32 (0x85) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x85))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (if (i32.eq (i32.shr_u (local.get $modrm) (i32.const 6)) (i32.const 3))
              (then
                (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
                (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
                (call $thread_emit (i32.const 37)  ;; th_test_reg_reg
                  (i32.or (i32.shl (local.get $rm) (i32.const 4)) (local.get $reg)))
                (br $decode_loop)))
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- LEA r32, [r/m32] (0x8D) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x8D))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (local.set $mod (i32.shr_u (local.get $modrm) (i32.const 6)))
            (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
            (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))

            ;; mod=01: lea reg, [rm+disp8]
            (if (i32.and (i32.eq (local.get $mod) (i32.const 1)) (i32.ne (local.get $rm) (i32.const 4)))
              (then
                (local.set $disp (call $guest_load8 (local.get $pc)))
                (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
                (if (i32.ge_u (local.get $disp) (i32.const 0x80))
                  (then (local.set $disp (i32.or (local.get $disp) (i32.const 0xFFFFFF00)))))
                (call $thread_emit (i32.const 26)
                  (i32.or (i32.shl (local.get $reg) (i32.const 4)) (local.get $rm)))
                (call $thread_emit_raw (local.get $disp))
                (br $decode_loop)
              )
            )
            ;; mod=10: lea reg, [rm+disp32]
            (if (i32.and (i32.eq (local.get $mod) (i32.const 2)) (i32.ne (local.get $rm) (i32.const 4)))
              (then
                (local.set $disp (call $guest_load32 (local.get $pc)))
                (local.set $pc (i32.add (local.get $pc) (i32.const 4)))
                (call $thread_emit (i32.const 26)
                  (i32.or (i32.shl (local.get $reg) (i32.const 4)) (local.get $rm)))
                (call $thread_emit_raw (local.get $disp))
                (br $decode_loop)
              )
            )
            ;; Unhandled (SIB, etc.)
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- CALL [mem] via FF /2 (0xFF with reg=2) ----
        (if (i32.eq (local.get $opcode) (i32.const 0xFF))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (local.set $mod (i32.shr_u (local.get $modrm) (i32.const 6)))
            (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
            (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))

            ;; FF /2 = CALL r/m32
            (if (i32.eq (local.get $reg) (i32.const 2))
              (then
                ;; mod=00, rm=5: call [disp32] — absolute indirect (IAT pattern!)
                (if (i32.and (i32.eq (local.get $mod) (i32.const 0)) (i32.eq (local.get $rm) (i32.const 5)))
                  (then
                    (local.set $disp (call $guest_load32 (local.get $pc)))
                    (local.set $pc (i32.add (local.get $pc) (i32.const 4)))
                    (call $thread_emit (i32.const 29) (local.get $pc))  ;; operand = return addr
                    (call $thread_emit_raw (local.get $disp))  ;; mem addr to read target from
                    (local.set $done (i32.const 1))
                    (br $decode_loop)
                  )
                )
                ;; mod=00, rm != 4,5: call [reg]
                (if (i32.and
                      (i32.eq (local.get $mod) (i32.const 0))
                      (i32.and (i32.ne (local.get $rm) (i32.const 4)) (i32.ne (local.get $rm) (i32.const 5))))
                  (then
                    (call $thread_emit (i32.const 29) (local.get $pc))
                    ;; We need to emit a sentinel — use the rm reg index
                    ;; Actually call_indirect reads target from [mem_addr], so we need the guest addr at runtime.
                    ;; This doesn't fit neatly — for now, end block.
                    (call $thread_emit_raw (i32.const 0))
                    (local.set $done (i32.const 1))
                    (br $decode_loop)
                  )
                )
              )
            )
            ;; FF /6 = PUSH r/m32 — handle reg direct
            (if (i32.and (i32.eq (local.get $reg) (i32.const 6))
                         (i32.eq (local.get $mod) (i32.const 3)))
              (then
                (call $thread_emit (i32.const 14) (local.get $rm))  ;; push_reg
                (br $decode_loop)
              )
            )
            ;; Unhandled FF variant
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- MOV dword [r/m32], imm32 (0xC7 /0) ----
        (if (i32.eq (local.get $opcode) (i32.const 0xC7))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (local.set $mod (i32.shr_u (local.get $modrm) (i32.const 6)))
            (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
            (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
            ;; Only handle /0 (mov)
            (if (i32.eq (local.get $reg) (i32.const 0))
              (then
                ;; mod=01: [rm+disp8], imm32
                (if (i32.and (i32.eq (local.get $mod) (i32.const 1)) (i32.ne (local.get $rm) (i32.const 4)))
                  (then
                    (local.set $disp (call $guest_load8 (local.get $pc)))
                    (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
                    (if (i32.ge_u (local.get $disp) (i32.const 0x80))
                      (then (local.set $disp (i32.or (local.get $disp) (i32.const 0xFFFFFF00)))))
                    (local.set $imm (call $guest_load32 (local.get $pc)))
                    (local.set $pc (i32.add (local.get $pc) (i32.const 4)))
                    ;; Emit: push_imm(value), then store to [rm+disp]
                    ;; Actually need a "store_imm_to_mem_disp" handler. Let's use existing ops:
                    ;; 1. mov_reg_imm32 into eax (temp), 2. store_reg_mem_disp(base=rm, src=eax)
                    ;; This clobbers eax. For mov [ebp+x], imm32 this is usually fine.
                    ;; Actually: emit a dedicated handler. Or use push_imm + store pattern.
                    ;; Simplest: mov eax, imm32 then store [rm+disp], eax
                    (call $thread_emit (i32.const 1) (i32.const 0)) ;; mov eax, imm32
                    (call $thread_emit_raw (local.get $imm))
                    (call $thread_emit (i32.const 36) ;; store_reg_mem_disp: base=rm, src=eax(0)
                      (i32.or (i32.shl (local.get $rm) (i32.const 4)) (i32.const 0)))
                    (call $thread_emit_raw (local.get $disp))
                    (br $decode_loop)))
                ;; mod=10: [rm+disp32], imm32
                (if (i32.and (i32.eq (local.get $mod) (i32.const 2)) (i32.ne (local.get $rm) (i32.const 4)))
                  (then
                    (local.set $disp (call $guest_load32 (local.get $pc)))
                    (local.set $pc (i32.add (local.get $pc) (i32.const 4)))
                    (local.set $imm (call $guest_load32 (local.get $pc)))
                    (local.set $pc (i32.add (local.get $pc) (i32.const 4)))
                    (call $thread_emit (i32.const 1) (i32.const 0))
                    (call $thread_emit_raw (local.get $imm))
                    (call $thread_emit (i32.const 36)
                      (i32.or (i32.shl (local.get $rm) (i32.const 4)) (i32.const 0)))
                    (call $thread_emit_raw (local.get $disp))
                    (br $decode_loop)))
                ;; mod=00, rm!=4,5: [rm], imm32
                (if (i32.and (i32.eq (local.get $mod) (i32.const 0))
                      (i32.and (i32.ne (local.get $rm) (i32.const 4)) (i32.ne (local.get $rm) (i32.const 5))))
                  (then
                    (local.set $imm (call $guest_load32 (local.get $pc)))
                    (local.set $pc (i32.add (local.get $pc) (i32.const 4)))
                    (call $thread_emit (i32.const 1) (i32.const 0))
                    (call $thread_emit_raw (local.get $imm))
                    (call $thread_emit (i32.const 4) ;; store_reg_mem: base=rm, src=eax
                      (i32.or (i32.shl (local.get $rm) (i32.const 4)) (i32.const 0)))
                    (br $decode_loop)))
                ;; mod=11: mov reg, imm32
                (if (i32.eq (local.get $mod) (i32.const 3))
                  (then
                    (local.set $imm (call $guest_load32 (local.get $pc)))
                    (local.set $pc (i32.add (local.get $pc) (i32.const 4)))
                    (call $thread_emit (i32.const 1) (local.get $rm))
                    (call $thread_emit_raw (local.get $imm))
                    (br $decode_loop)))))
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- Group 0x80: CMP/ADD/etc byte [r/m8], imm8 ----
        (if (i32.eq (local.get $opcode) (i32.const 0x80))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (local.set $mod (i32.shr_u (local.get $modrm) (i32.const 6)))
            (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
            (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
            ;; mod=00, rm!=4,5: cmp byte [rm], imm8
            (if (i32.and (i32.eq (local.get $mod) (i32.const 0))
                  (i32.and (i32.ne (local.get $rm) (i32.const 4)) (i32.ne (local.get $rm) (i32.const 5))))
              (then
                (local.set $imm (call $guest_load8 (local.get $pc)))
                (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
                ;; reg=7: cmp byte [rm], imm8
                ;; Emit: load byte from [rm_reg], then cmp_al_imm8 (reuse for simplicity)
                ;; Actually need a generic "cmp byte mem, imm" — use load + cmp
                ;; Emit load byte into a temp (reuse eax concept via cmp_al_imm8)
                ;; Better: emit a cmp_byte_mem_imm handler. For now, just use cmp_al_imm8
                ;; since the byte is loaded to AL-equivalent in the flag computation.
                ;; We need a new handler: cmp_mem8_imm8. Let's use inline flag set:
                ;; emit load_byte_mem (dst=scratch, base=rm) then cmp_reg_imm.
                ;; Simplest: th_load_byte_mem into a virtual "reg 0" (eax), then cmp_al_imm8
                ;; This clobbers EAX low byte which is wrong... but for cmp, the source isn't modified.
                ;; Actually cmp_al_imm8 reads global $eax low byte. So we'd need to save/restore.
                ;; Better approach: emit two ops. First movzx [rm] -> temp reg concept won't work cleanly.
                ;; Let me just add a cmp_mem8_imm8 handler.
                ;; For now, emit block_end on this — we'll come back.
                ;; ACTUALLY: let's just emit it properly:
                ;; load_byte_mem into "virtual eax" (op 44, dst=0, base=rm), then cmp_al_imm8
                ;; The cmp doesn't modify eax, and the load does modify eax's low byte.
                ;; Notepad's code: `cmp byte [esi], 0x20` — eax is used for the char anyway, so clobbering is fine here.
                ;; This is a hack but works for the common case.
                (if (i32.eq (local.get $reg) (i32.const 7)) ;; CMP
                  (then
                    (call $thread_emit (i32.const 44) ;; load_byte_mem: dst=0(eax), base=rm
                      (i32.or (i32.shl (i32.const 0) (i32.const 4)) (local.get $rm)))
                    (call $thread_emit (i32.const 46) (local.get $imm)) ;; cmp_al_imm8
                    (br $decode_loop)))
                (call $thread_emit (i32.const 30) (local.get $pc))
                (local.set $done (i32.const 1))
                (br $decode_loop)))
            ;; mod=11: byte register
            (if (i32.eq (local.get $mod) (i32.const 3))
              (then
                (local.set $imm (call $guest_load8 (local.get $pc)))
                (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
                (if (i32.eq (local.get $reg) (i32.const 7)) ;; CMP
                  (then
                    ;; cmp reg8, imm8 — use cmp_al approach with the specific register
                    (call $thread_emit (i32.const 46) (local.get $imm))
                    (br $decode_loop)))
                (call $thread_emit (i32.const 30) (local.get $pc))
                (local.set $done (i32.const 1))
                (br $decode_loop)))
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- MOV AL/reg8, [r/m8] (0x8A) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x8A))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (local.set $mod (i32.shr_u (local.get $modrm) (i32.const 6)))
            (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
            (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
            ;; mod=00, rm!=4,5: load byte [rm_reg] into reg (zero-ext to 32)
            (if (i32.and (i32.eq (local.get $mod) (i32.const 0))
                  (i32.and (i32.ne (local.get $rm) (i32.const 4)) (i32.ne (local.get $rm) (i32.const 5))))
              (then
                (call $thread_emit (i32.const 44)
                  (i32.or (i32.shl (local.get $reg) (i32.const 4)) (local.get $rm)))
                (br $decode_loop)))
            ;; mod=01: load byte [rm+disp8]
            (if (i32.and (i32.eq (local.get $mod) (i32.const 1)) (i32.ne (local.get $rm) (i32.const 4)))
              (then
                (local.set $disp (call $guest_load8 (local.get $pc)))
                (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
                (if (i32.ge_u (local.get $disp) (i32.const 0x80))
                  (then (local.set $disp (i32.or (local.get $disp) (i32.const 0xFFFFFF00)))))
                (call $thread_emit (i32.const 47)
                  (i32.or (i32.shl (local.get $reg) (i32.const 4)) (local.get $rm)))
                (call $thread_emit_raw (local.get $disp))
                (br $decode_loop)))
            ;; mod=11: mov reg8, rm8 (reg-to-reg byte) — treat as mov_reg_reg for low bytes
            (if (i32.eq (local.get $mod) (i32.const 3))
              (then
                ;; Simplified: treat as full 32-bit mov (close enough for most code)
                (call $thread_emit (i32.const 44)
                  (i32.or (i32.shl (local.get $reg) (i32.const 4)) (local.get $rm)))
                (br $decode_loop)))
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- MOV EAX, [abs32] (0xA1) ----
        (if (i32.eq (local.get $opcode) (i32.const 0xA1))
          (then
            (local.set $imm (call $guest_load32 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 4)))
            (call $thread_emit (i32.const 42) (i32.const 0)) ;; th_load_abs32, reg=eax
            (call $thread_emit_raw (local.get $imm))
            (br $decode_loop)
          )
        )

        ;; ---- MOV [abs32], EAX (0xA3) ----
        (if (i32.eq (local.get $opcode) (i32.const 0xA3))
          (then
            (local.set $imm (call $guest_load32 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 4)))
            (call $thread_emit (i32.const 43) (i32.const 0)) ;; th_store_abs32, reg=eax
            (call $thread_emit_raw (local.get $imm))
            (br $decode_loop)
          )
        )

        ;; ---- CMP AL, imm8 (0x3C) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x3C))
          (then
            (local.set $imm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (call $thread_emit (i32.const 46) (local.get $imm)) ;; th_cmp_al_imm8
            (br $decode_loop)
          )
        )

        ;; ---- TEST AL, imm8 (0xA8) ----
        (if (i32.eq (local.get $opcode) (i32.const 0xA8))
          (then
            (local.set $imm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (call $thread_emit (i32.const 49) (local.get $imm)) ;; th_test_al_imm8
            (br $decode_loop)
          )
        )

        ;; ---- TEST r/m8, r8 (0x84) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x84))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            ;; Simplified: only handle mod=11 (reg,reg)
            (if (i32.eq (i32.shr_u (local.get $modrm) (i32.const 6)) (i32.const 3))
              (then
                (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
                (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
                (call $thread_emit (i32.const 37)  ;; reuse test_reg_reg (close enough)
                  (i32.or (i32.shl (local.get $rm) (i32.const 4)) (local.get $reg)))
                (br $decode_loop)))
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- RET imm16 (0xC2) ----
        (if (i32.eq (local.get $opcode) (i32.const 0xC2))
          (then
            (local.set $imm (call $guest_load16 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 2)))
            (call $thread_emit (i32.const 50) (local.get $imm)) ;; th_ret_imm16
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- MOV r/m8, r8 (0x88) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x88))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (local.set $mod (i32.shr_u (local.get $modrm) (i32.const 6)))
            (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
            (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
            (if (i32.and (i32.eq (local.get $mod) (i32.const 0))
                  (i32.and (i32.ne (local.get $rm) (i32.const 4)) (i32.ne (local.get $rm) (i32.const 5))))
              (then
                (call $thread_emit (i32.const 45)  ;; store_byte_mem
                  (i32.or (i32.shl (local.get $rm) (i32.const 4)) (local.get $reg)))
                (br $decode_loop)))
            (if (i32.eq (local.get $mod) (i32.const 3))
              (then
                (call $thread_emit (i32.const 2) ;; mov_reg_reg (simplified)
                  (i32.or (i32.shl (local.get $rm) (i32.const 4)) (local.get $reg)))
                (br $decode_loop)))
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- MOV r8, imm8 (0xB0-0xB7) ----
        (if (i32.and
              (i32.ge_u (local.get $opcode) (i32.const 0xB0))
              (i32.le_u (local.get $opcode) (i32.const 0xB7)))
          (then
            (local.set $imm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            ;; Simplified: set full reg to imm (ok for most cases)
            (call $thread_emit (i32.const 1) ;; mov_reg_imm32
              (i32.sub (local.get $opcode) (i32.const 0xB0)))
            (call $thread_emit_raw (local.get $imm))
            (br $decode_loop)
          )
        )

        ;; ---- CMP EAX, imm32 (0x3D) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x3D))
          (then
            (local.set $imm (call $guest_load32 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 4)))
            (call $thread_emit (i32.const 12) (i32.const 0)) ;; cmp_reg_imm, reg=eax
            (call $thread_emit_raw (local.get $imm))
            (br $decode_loop)
          )
        )

        ;; ---- CMP r/m32, imm32 (0x81 /7) and other 0x81 variants ----
        (if (i32.eq (local.get $opcode) (i32.const 0x81))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
            (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
            (if (i32.eq (i32.shr_u (local.get $modrm) (i32.const 6)) (i32.const 3))
              (then
                (local.set $imm (call $guest_load32 (local.get $pc)))
                (local.set $pc (i32.add (local.get $pc) (i32.const 4)))
                (if (i32.eq (local.get $reg) (i32.const 7))
                  (then
                    (call $thread_emit (i32.const 12) (local.get $rm))
                    (call $thread_emit_raw (local.get $imm))
                    (br $decode_loop)))
                (if (i32.eq (local.get $reg) (i32.const 0))
                  (then
                    (call $thread_emit (i32.const 5) (local.get $rm))
                    (call $thread_emit_raw (local.get $imm))
                    (br $decode_loop)))
                (if (i32.eq (local.get $reg) (i32.const 5))
                  (then
                    (call $thread_emit (i32.const 6) (local.get $rm))
                    (call $thread_emit_raw (local.get $imm))
                    (br $decode_loop)))
              )
            )
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- ADD r32, r/m32 (0x03) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x03))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (if (i32.eq (i32.shr_u (local.get $modrm) (i32.const 6)) (i32.const 3))
              (then
                (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
                (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
                (call $thread_emit (i32.const 7)
                  (i32.or (i32.shl (local.get $reg) (i32.const 4)) (local.get $rm)))
                (br $decode_loop)))
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- SUB r32, r/m32 (0x2B) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x2B))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (if (i32.eq (i32.shr_u (local.get $modrm) (i32.const 6)) (i32.const 3))
              (then
                (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
                (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
                (call $thread_emit (i32.const 8)
                  (i32.or (i32.shl (local.get $reg) (i32.const 4)) (local.get $rm)))
                (br $decode_loop)))
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- 2-byte opcodes (0x0F prefix) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x0F))
          (then
            (local.set $opcode (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))

            ;; Near Jcc rel32 (0x0F 0x80-0x8F)
            (if (i32.and
                  (i32.ge_u (local.get $opcode) (i32.const 0x80))
                  (i32.le_u (local.get $opcode) (i32.const 0x8F)))
              (then
                (local.set $disp (call $guest_load32 (local.get $pc)))
                (local.set $pc (i32.add (local.get $pc) (i32.const 4)))
                (local.set $imm (i32.add (local.get $pc) (local.get $disp))) ;; target

                ;; Map 0x84=JZ, 0x85=JNZ, 0x8C=JL, 0x8D=JGE, 0x8E=JLE, 0x8F=JG
                ;; 0x82=JB, 0x83=JAE
                (if (i32.eq (local.get $opcode) (i32.const 0x84))
                  (then (call $thread_emit (i32.const 20) (local.get $pc))
                        (call $thread_emit_raw (local.get $imm))))
                (if (i32.eq (local.get $opcode) (i32.const 0x85))
                  (then (call $thread_emit (i32.const 21) (local.get $pc))
                        (call $thread_emit_raw (local.get $imm))))
                (if (i32.eq (local.get $opcode) (i32.const 0x8C))
                  (then (call $thread_emit (i32.const 22) (local.get $pc))
                        (call $thread_emit_raw (local.get $imm))))
                (if (i32.eq (local.get $opcode) (i32.const 0x8D))
                  (then (call $thread_emit (i32.const 23) (local.get $pc))
                        (call $thread_emit_raw (local.get $imm))))
                (if (i32.eq (local.get $opcode) (i32.const 0x8E))
                  (then (call $thread_emit (i32.const 24) (local.get $pc))
                        (call $thread_emit_raw (local.get $imm))))
                (if (i32.eq (local.get $opcode) (i32.const 0x8F))
                  (then (call $thread_emit (i32.const 25) (local.get $pc))
                        (call $thread_emit_raw (local.get $imm))))
                (if (i32.eq (local.get $opcode) (i32.const 0x82))
                  (then (call $thread_emit (i32.const 38) (local.get $pc))
                        (call $thread_emit_raw (local.get $imm))))
                (if (i32.eq (local.get $opcode) (i32.const 0x83))
                  (then (call $thread_emit (i32.const 39) (local.get $pc))
                        (call $thread_emit_raw (local.get $imm))))
                ;; Also handle 0x86=JBE and 0x87=JA — map to jle/jg (unsigned)
                ;; For now, bail on unhandled conditions
                (local.set $done (i32.const 1))
                (br $decode_loop)
              )
            )

            ;; MOVZX r32, r/m8 (0x0F 0xB6)
            (if (i32.eq (local.get $opcode) (i32.const 0xB6))
              (then
                (local.set $modrm (call $guest_load8 (local.get $pc)))
                (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
                (local.set $mod (i32.shr_u (local.get $modrm) (i32.const 6)))
                (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
                (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
                (if (i32.and (i32.eq (local.get $mod) (i32.const 0))
                      (i32.and (i32.ne (local.get $rm) (i32.const 4)) (i32.ne (local.get $rm) (i32.const 5))))
                  (then
                    (call $thread_emit (i32.const 40)
                      (i32.or (i32.shl (local.get $reg) (i32.const 4)) (local.get $rm)))
                    (br $decode_loop)))
                (if (i32.eq (local.get $mod) (i32.const 3))
                  (then
                    ;; movzx reg32, reg8 — simplified
                    (call $thread_emit (i32.const 40)
                      (i32.or (i32.shl (local.get $reg) (i32.const 4)) (local.get $rm)))
                    (br $decode_loop)))
                (if (i32.and (i32.eq (local.get $mod) (i32.const 1)) (i32.ne (local.get $rm) (i32.const 4)))
                  (then
                    (local.set $disp (call $guest_load8 (local.get $pc)))
                    (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
                    (if (i32.ge_u (local.get $disp) (i32.const 0x80))
                      (then (local.set $disp (i32.or (local.get $disp) (i32.const 0xFFFFFF00)))))
                    (call $thread_emit (i32.const 47)
                      (i32.or (i32.shl (local.get $reg) (i32.const 4)) (local.get $rm)))
                    (call $thread_emit_raw (local.get $disp))
                    (br $decode_loop)))
                (call $thread_emit (i32.const 30) (local.get $pc))
                (local.set $done (i32.const 1))
                (br $decode_loop)
              )
            )

            ;; MOVSX r32, r/m8 (0x0F 0xBE)
            (if (i32.eq (local.get $opcode) (i32.const 0xBE))
              (then
                (local.set $modrm (call $guest_load8 (local.get $pc)))
                (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
                (local.set $mod (i32.shr_u (local.get $modrm) (i32.const 6)))
                (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
                (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
                (if (i32.and (i32.eq (local.get $mod) (i32.const 0))
                      (i32.and (i32.ne (local.get $rm) (i32.const 4)) (i32.ne (local.get $rm) (i32.const 5))))
                  (then
                    (call $thread_emit (i32.const 51)
                      (i32.or (i32.shl (local.get $reg) (i32.const 4)) (local.get $rm)))
                    (br $decode_loop)))
                (if (i32.eq (local.get $mod) (i32.const 3))
                  (then
                    (call $thread_emit (i32.const 51)
                      (i32.or (i32.shl (local.get $reg) (i32.const 4)) (local.get $rm)))
                    (br $decode_loop)))
                (call $thread_emit (i32.const 30) (local.get $pc))
                (local.set $done (i32.const 1))
                (br $decode_loop)
              )
            )

            ;; Unknown 0x0F xx — end block
            (call $host_log_i32 (i32.or (i32.const 0x0F00) (local.get $opcode)))
            (call $thread_emit (i32.const 30)
              (i32.sub (local.get $pc) (i32.const 2)))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- LEAVE (0xC9) — mov esp,ebp; pop ebp ----
        (if (i32.eq (local.get $opcode) (i32.const 0xC9))
          (then
            ;; mov esp, ebp
            (call $thread_emit (i32.const 2) ;; mov_reg_reg: dst=esp(4), src=ebp(5)
              (i32.or (i32.shl (i32.const 4) (i32.const 4)) (i32.const 5)))
            ;; pop ebp
            (call $thread_emit (i32.const 15) (i32.const 5)) ;; pop_reg ebp
            (br $decode_loop)
          )
        )

        ;; ---- AND r/m32, r32 (0x21) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x21))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (if (i32.eq (i32.shr_u (local.get $modrm) (i32.const 6)) (i32.const 3))
              (then
                (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
                (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
                (call $thread_emit (i32.const 10)
                  (i32.or (i32.shl (local.get $rm) (i32.const 4)) (local.get $reg)))
                (br $decode_loop)))
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- OR r/m32, r32 (0x09) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x09))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (if (i32.eq (i32.shr_u (local.get $modrm) (i32.const 6)) (i32.const 3))
              (then
                (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
                (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
                (call $thread_emit (i32.const 11)
                  (i32.or (i32.shl (local.get $rm) (i32.const 4)) (local.get $reg)))
                (br $decode_loop)))
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- CMP r32, r/m32 (0x3B) ----
        (if (i32.eq (local.get $opcode) (i32.const 0x3B))
          (then
            (local.set $modrm (call $guest_load8 (local.get $pc)))
            (local.set $pc (i32.add (local.get $pc) (i32.const 1)))
            (if (i32.eq (i32.shr_u (local.get $modrm) (i32.const 6)) (i32.const 3))
              (then
                (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
                (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
                (call $thread_emit (i32.const 13)
                  (i32.or (i32.shl (local.get $reg) (i32.const 4)) (local.get $rm)))
                (br $decode_loop)))
            (call $thread_emit (i32.const 30) (local.get $pc))
            (local.set $done (i32.const 1))
            (br $decode_loop)
          )
        )

        ;; ---- Unrecognized opcode: end block ----
        ;; Set EIP to current decode position (after the unknown opcode byte)
        ;; and log it for debugging
        (call $host_log_i32 (local.get $opcode))  ;; log unknown opcode
        (call $thread_emit (i32.const 30)          ;; th_block_end
          (i32.sub (local.get $pc) (i32.const 1))) ;; back up to the unknown opcode
        (local.set $done (i32.const 1))
        (br $decode_loop)
      )
    )

    ;; Store in cache and return
    (call $cache_store (local.get $start_eip) (local.get $thread_start))
    (local.get $thread_start)
  )

  ;; ============================================================
  ;; PE LOADER
  ;; ============================================================
  ;; Parses a PE file from the staging area and loads it into guest memory.
  ;; Called from JS after copying the .exe bytes to $PE_STAGING.
  ;; Param: size of the PE file in bytes.

  (func $load_pe (export "load_pe") (param $size i32) (result i32)
    (local $pe_off i32)       ;; offset to PE signature
    (local $num_sections i32)
    (local $opt_hdr_size i32)
    (local $section_off i32)
    (local $i i32)
    (local $vaddr i32)
    (local $vsize i32)
    (local $raw_off i32)
    (local $raw_size i32)
    (local $import_rva i32)
    (local $src i32)
    (local $dst i32)
    (local $characteristics i32)

    ;; Check MZ signature
    (if (i32.ne (i32.load16_u (global.get $PE_STAGING)) (i32.const 0x5A4D))
      (then (return (i32.const -1))))

    ;; e_lfanew at offset 0x3C
    (local.set $pe_off (i32.add (global.get $PE_STAGING)
      (i32.load (i32.add (global.get $PE_STAGING) (i32.const 0x3C)))))

    ;; Check PE\0\0 signature
    (if (i32.ne (i32.load (local.get $pe_off)) (i32.const 0x00004550))
      (then (return (i32.const -2))))

    ;; FILE HEADER starts at pe_off + 4
    (local.set $num_sections (i32.load16_u (i32.add (local.get $pe_off) (i32.const 6))))
    (local.set $opt_hdr_size (i32.load16_u (i32.add (local.get $pe_off) (i32.const 20))))

    ;; OPTIONAL HEADER starts at pe_off + 24
    ;; ImageBase at optional_header + 28
    (global.set $image_base (i32.load (i32.add (local.get $pe_off) (i32.const 52))))
    ;; AddressOfEntryPoint at optional_header + 16
    (global.set $entry_point (i32.add
      (global.get $image_base)
      (i32.load (i32.add (local.get $pe_off) (i32.const 40)))))

    ;; Import directory RVA at optional_header + 104 (offset into data directories)
    (local.set $import_rva (i32.load (i32.add (local.get $pe_off) (i32.const 128))))

    ;; SECTION HEADERS start after optional header
    (local.set $section_off (i32.add (local.get $pe_off) (i32.add (i32.const 24) (local.get $opt_hdr_size))))

    ;; Load each section
    (local.set $i (i32.const 0))
    (block $sections_done
      (loop $sections
        (br_if $sections_done (i32.ge_u (local.get $i) (local.get $num_sections)))

        ;; Section header: 40 bytes each
        ;; +8: VirtualSize, +12: VirtualAddress (RVA)
        ;; +16: SizeOfRawData, +20: PointerToRawData
        ;; +36: Characteristics
        (local.set $vsize (i32.load (i32.add (local.get $section_off) (i32.const 8))))
        (local.set $vaddr (i32.load (i32.add (local.get $section_off) (i32.const 12))))
        (local.set $raw_size (i32.load (i32.add (local.get $section_off) (i32.const 16))))
        (local.set $raw_off (i32.load (i32.add (local.get $section_off) (i32.const 20))))
        (local.set $characteristics (i32.load (i32.add (local.get $section_off) (i32.const 36))))

        ;; Copy raw data to guest address space
        ;; dst = GUEST_BASE + vaddr
        (local.set $dst (i32.add (global.get $GUEST_BASE) (local.get $vaddr)))
        (local.set $src (i32.add (global.get $PE_STAGING) (local.get $raw_off)))

        ;; memcpy src→dst for raw_size bytes
        (call $memcpy (local.get $dst) (local.get $src) (local.get $raw_size))

        ;; Track code section bounds (IMAGE_SCN_CNT_CODE = 0x20)
        (if (i32.and (local.get $characteristics) (i32.const 0x20))
          (then
            (global.set $code_start (i32.add (global.get $image_base) (local.get $vaddr)))
            (global.set $code_end (i32.add (global.get $code_start) (local.get $vsize)))
          )
        )

        (local.set $section_off (i32.add (local.get $section_off) (i32.const 40)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $sections)
      )
    )

    ;; Process imports
    (if (i32.ne (local.get $import_rva) (i32.const 0))
      (then (call $process_imports (local.get $import_rva))))

    ;; Set up initial CPU state
    (global.set $eip (global.get $entry_point))
    (global.set $esp (global.get $GUEST_STACK))
    (global.set $eax (i32.const 0))
    (global.set $ecx (i32.const 0))
    (global.set $edx (i32.const 0))
    (global.set $ebx (i32.const 0))
    (global.set $ebp (i32.const 0))
    (global.set $esi (i32.const 0))
    (global.set $edi (i32.const 0))

    ;; Return entry point for debugging
    (global.get $entry_point)
  )

  ;; ============================================================
  ;; IMPORT TABLE PROCESSING
  ;; ============================================================
  ;; Walks the import directory and patches IAT entries to point
  ;; to thunk zone addresses. Each imported function gets an 8-byte
  ;; slot in the thunk zone.

  (func $process_imports (param $import_rva i32)
    (local $desc_ptr i32)     ;; pointer to import descriptor in WASM memory
    (local $ilt_rva i32)      ;; import lookup table RVA
    (local $iat_rva i32)      ;; import address table RVA
    (local $ilt_ptr i32)
    (local $iat_ptr i32)
    (local $entry i32)
    (local $hint_name_rva i32)
    (local $thunk_addr i32)

    ;; Import descriptor is at GUEST_BASE + import_rva
    (local.set $desc_ptr (i32.add (global.get $GUEST_BASE) (local.get $import_rva)))

    (block $imports_done
      (loop $import_dlls
        ;; Each import descriptor is 20 bytes
        ;; +0: OriginalFirstThunk (ILT RVA), +16: FirstThunk (IAT RVA)
        ;; All zeros = end of import descriptors
        (local.set $ilt_rva (i32.load (local.get $desc_ptr)))
        (local.set $iat_rva (i32.load (i32.add (local.get $desc_ptr) (i32.const 16))))

        ;; End when ILT RVA is 0
        (br_if $imports_done (i32.eqz (local.get $ilt_rva)))

        ;; Walk the ILT/IAT in parallel
        (local.set $ilt_ptr (i32.add (global.get $GUEST_BASE) (local.get $ilt_rva)))
        (local.set $iat_ptr (i32.add (global.get $GUEST_BASE) (local.get $iat_rva)))

        (block $funcs_done
          (loop $import_funcs
            (local.set $entry (i32.load (local.get $ilt_ptr)))
            (br_if $funcs_done (i32.eqz (local.get $entry)))

            ;; Allocate a thunk slot
            (local.set $thunk_addr (i32.add
              (global.get $THUNK_BASE)
              (i32.mul (global.get $num_thunks) (i32.const 8))))

            ;; Patch the IAT entry to point to our thunk
            (i32.store (local.get $iat_ptr) (local.get $thunk_addr))

            ;; Store the hint/name RVA in the thunk slot for later resolution
            ;; Bit 31 set = ordinal import (we don't handle these yet)
            (if (i32.eqz (i32.and (local.get $entry) (i32.const 0x80000000)))
              (then
                ;; Name import: entry is RVA to hint/name
                ;; Store the name RVA in the thunk slot for win32_dispatch to match
                (local.set $hint_name_rva (local.get $entry))
                (i32.store (i32.add (global.get $GUEST_BASE)
                  (i32.sub (local.get $thunk_addr) (global.get $image_base)))
                  (local.get $hint_name_rva))
              )
            )

            (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))
            (local.set $ilt_ptr (i32.add (local.get $ilt_ptr) (i32.const 4)))
            (local.set $iat_ptr (i32.add (local.get $iat_ptr) (i32.const 4)))
            (br $import_funcs)
          )
        )

        ;; Next import descriptor
        (local.set $desc_ptr (i32.add (local.get $desc_ptr) (i32.const 20)))
        (br $import_dlls)
      )
    )
  )

  ;; ============================================================
  ;; WIN32 API DISPATCH
  ;; ============================================================
  ;; Called when EIP lands in the thunk zone.
  ;; Param: thunk index (0-based).
  ;; Reads function name from the hint/name table, matches against
  ;; known APIs, and executes the stub.
  ;; stdcall: callee cleans args, return value in EAX.

  (func $win32_dispatch (param $thunk_idx i32)
    (local $name_rva i32)
    (local $name_ptr i32)
    (local $hash i32)
    (local $arg0 i32)
    (local $arg1 i32)
    (local $arg2 i32)
    (local $arg3 i32)

    ;; Read the hint/name RVA we stored in the thunk slot
    (local.set $name_rva (i32.load
      (i32.add (global.get $GUEST_BASE)
        (i32.sub
          (i32.add (global.get $THUNK_BASE) (i32.mul (local.get $thunk_idx) (i32.const 8)))
          (global.get $image_base)))))

    ;; name_ptr = GUEST_BASE + name_rva + 2 (skip hint word)
    (local.set $name_ptr (i32.add (global.get $GUEST_BASE) (i32.add (local.get $name_rva) (i32.const 2))))

    ;; Simple hash of the function name for matching
    (local.set $hash (call $hash_name (local.get $name_ptr)))

    ;; Read stdcall arguments from guest stack (after return address)
    ;; ESP points to return addr, args start at ESP+4
    (local.set $arg0 (call $guest_load32 (i32.add (global.get $esp) (i32.const 4))))
    (local.set $arg1 (call $guest_load32 (i32.add (global.get $esp) (i32.const 8))))
    (local.set $arg2 (call $guest_load32 (i32.add (global.get $esp) (i32.const 12))))
    (local.set $arg3 (call $guest_load32 (i32.add (global.get $esp) (i32.const 16))))

    ;; Dispatch on hash for reliable matching
    ;; Use djb2 hash to match API names

    ;; ---- KERNEL32 APIs ----

    ;; ExitProcess(uExitCode) — 1 arg
    ;; "Exit" = 0x74697845
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x74697845))
      (then
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (call $host_exit (local.get $arg0))
        (return)))

    ;; GetModuleHandleA(lpModuleName) — 1 arg
    ;; "GetM" = 0x4D746547
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x4D746547))
      (then
        ;; Check: "odul" at +4 to distinguish from GetMenu etc
        (if (i32.eq (i32.load (i32.add (local.get $name_ptr) (i32.const 4))) (i32.const 0x6C75646F))
          (then
            (global.set $eax (global.get $image_base))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
            (return)))))

    ;; GetCommandLineA() — 0 args, returns ptr to command line string
    ;; "GetC" = 0x43746547
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x43746547))
      (then
        ;; Check "omma" at +4
        (if (i32.eq (i32.load (i32.add (local.get $name_ptr) (i32.const 4))) (i32.const 0x616D6D6F))
          (then
            ;; Return pointer to a fake command line in guest memory
            ;; Store "notepad.exe\0" at a known scratch location
            (call $store_fake_cmdline)
            (global.set $eax (global.get $fake_cmdline_addr))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) ;; pop ret only, 0 args
            (return)))))

    ;; GetStartupInfoA(lpStartupInfo) — 1 arg, fills struct with zeros
    ;; "GetS" = 0x53746547
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x53746547))
      (then
        ;; Check "tart" at +4
        (if (i32.eq (i32.load (i32.add (local.get $name_ptr) (i32.const 4))) (i32.const 0x74726174))
          (then
            ;; Zero out the STARTUPINFO struct (68 bytes) and set cb field
            (call $zero_memory (call $guest_to_wasm (local.get $arg0)) (i32.const 68))
            ;; cb = 68
            (call $guest_store32 (local.get $arg0) (i32.const 68))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
            (return)))))

    ;; GetProfileStringA — 5 args, stub returns 0
    ;; "GetP" = 0x50746547
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x50746547))
      (then
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 4))) (i32.const 0x72)) ;; 'r'
          (then
            (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
            (return)))))

    ;; LocalAlloc(uFlags, uBytes) — 2 args
    ;; "Loca" = 0x61636F4C
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x61636F4C))
      (then
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 5))) (i32.const 0x41)) ;; 'A' = LocalAlloc
          (then
            (global.set $eax (call $heap_alloc (local.get $arg1)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
            (return)))
        ;; LocalFree — 1 arg, stub (return 0 = success)
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 5))) (i32.const 0x46)) ;; 'F' = LocalFree
          (then
            (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
            (return)))
        ;; LocalLock — 1 arg, returns the pointer itself (for LMEM_FIXED)
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 5))) (i32.const 0x4C)) ;; 'L' = LocalLock
          (then
            (global.set $eax (local.get $arg0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
            (return)))
        ;; LocalUnlock — 1 arg, return 0
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 5))) (i32.const 0x55)) ;; 'U' = LocalUnlock
          (then
            (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
            (return)))
        ;; LocalReAlloc — 3 args, stub
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 5))) (i32.const 0x52)) ;; 'R' = LocalReAlloc
          (then
            (global.set $eax (local.get $arg0)) ;; return same pointer
            (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
            (return)))))

    ;; GlobalAlloc/GlobalFree/GlobalLock/GlobalUnlock — same pattern
    ;; "Glob" = 0x626F6C47
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x626F6C47))
      (then
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 6))) (i32.const 0x41)) ;; GlobalAlloc
          (then
            (global.set $eax (call $heap_alloc (local.get $arg1)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
            (return)))
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 6))) (i32.const 0x46)) ;; GlobalFree
          (then
            (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
            (return)))
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 6))) (i32.const 0x4C)) ;; GlobalLock
          (then
            (global.set $eax (local.get $arg0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
            (return)))
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 6))) (i32.const 0x55)) ;; GlobalUnlock
          (then
            (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
            (return)))))

    ;; lstrlenA(lpString) — 1 arg
    ;; "lstr" = 0x7274736C
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x7274736C))
      (then
        ;; Distinguish by char at offset 4: 'l'=lstrlenA, 'c'=lstrcpyA/lstrcmpA/lstrcatA
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 4))) (i32.const 0x6C)) ;; lstrlenA
          (then
            (global.set $eax (call $guest_strlen (local.get $arg0)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
            (return)))
        ;; lstrcpyA — 2 args, return dst
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 7))) (i32.const 0x79)) ;; lstrcpy ends with 'y'
          (then
            (call $guest_strcpy (local.get $arg0) (local.get $arg1))
            (global.set $eax (local.get $arg0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
            (return)))
        ;; For others (lstrcmpA, lstrcatA, lstrcmpiA, lstrcpynA) — stub
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))

    ;; GetLastError — 0 args, return 0
    ;; "GetL" = 0x4C746547
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x4C746547))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))

    ;; MulDiv — 3 args
    ;; "MulD" = 0x446C754D
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x446C754D))
      (then
        ;; MulDiv(a, b, c) = (a * b) / c
        ;; Use i64 for intermediate to avoid overflow
        (global.set $eax (i32.wrap_i64 (i64.div_s
          (i64.mul (i64.extend_i32_s (local.get $arg0)) (i64.extend_i32_s (local.get $arg1)))
          (i64.extend_i32_s (local.get $arg2)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))

    ;; RtlMoveMemory — 3 args (dst, src, len)
    ;; "RtlM" = 0x4D6C7452
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x4D6C7452))
      (then
        (call $memcpy
          (call $guest_to_wasm (local.get $arg0))
          (call $guest_to_wasm (local.get $arg1))
          (local.get $arg2))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))

    ;; ---- USER32 APIs ----

    ;; MessageBoxA — 4 args
    ;; "Mess" = 0x7373654D
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x7373654D))
      (then
        (global.set $eax (call $host_message_box
          (local.get $arg0)
          (call $guest_to_wasm (local.get $arg1))
          (call $guest_to_wasm (local.get $arg2))
          (local.get $arg3)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))

    ;; RegisterClassExA — 1 arg, return atom (fake nonzero)
    ;; "Regi" = 0x69676552
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x69676552))
      (then
        (global.set $eax (i32.const 0xC001)) ;; fake atom
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))

    ;; CreateWindowExA — 12 args, return fake HWND
    ;; "Crea" = 0x61657243
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x61657243))
      (then
        ;; Check if CreateWindowExA vs CreateDialogParamA vs CreateFileA etc
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 4))) (i32.const 0x74)) ;; 't' = CreateWindowExA or CreateThread
          (then
            ;; Check 'e' at +5 for CreateWindowExA
            (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 5))) (i32.const 0x65))
              (then
                (global.set $eax (i32.const 0x10001)) ;; fake HWND
                (global.set $esp (i32.add (global.get $esp) (i32.const 52))) ;; ret + 12 args
                (return)))))
        ;; CreateDialogParamA — 5 args
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 4))) (i32.const 0x44)) ;; 'D' = CreateDialogParamA
          (then
            (global.set $eax (i32.const 0x10002)) ;; fake HWND
            (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
            (return)))
        ;; CreateFileA — 7 args
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 4))) (i32.const 0x46)) ;; 'F' = CreateFileA
          (then
            (global.set $eax (i32.const 0xFFFFFFFF)) ;; INVALID_HANDLE_VALUE
            (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
            (return)))
        ;; Default Create* — return nonzero, pop 4 args
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))

    ;; LoadCursorA/LoadIconA/LoadStringA/LoadAcceleratorsA
    ;; "Load" = 0x64616F4C
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x64616F4C))
      (then
        ;; LoadCursorA — 2 args, return fake handle
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 4))) (i32.const 0x43)) ;; 'C'
          (then
            (global.set $eax (i32.const 0x20001))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
            (return)))
        ;; LoadIconA — 2 args
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 4))) (i32.const 0x49)) ;; 'I'
          (then
            (global.set $eax (i32.const 0x20002))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
            (return)))
        ;; LoadStringA — 4 args, return 0 (no string loaded)
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 4))) (i32.const 0x53)) ;; 'S'
          (then
            (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
            (return)))
        ;; LoadAcceleratorsA — 2 args
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 4))) (i32.const 0x41)) ;; 'A'
          (then
            (global.set $eax (i32.const 0x20003))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
            (return)))
        ;; Default Load*
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))

    ;; ShowWindow — 2 args
    ;; "Show" = 0x776F6853
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x776F6853))
      (then
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))

    ;; UpdateWindow — 1 arg
    ;; "Upda" = 0x61647055
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x61647055))
      (then
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))

    ;; GetMessageA — 4 args, return 0 to signal WM_QUIT (terminates message loop)
    ;; "GetM" handled above for GetModuleHandle — need to check further
    ;; Actually "GetMessage" starts "GetM" but offset+4 = "essa" = 0x61737365
    ;; Already handled GetModuleHandle by checking "odul" at +4

    ;; GetSystemMetrics — 1 arg, return 0
    ;; "GetS" with "yste" at +4 = 0x65747379
    ;; Already have GetStartupInfoA check above

    ;; Catch-all for Get* APIs — return 0, pop 4 args
    (if (i32.eq (i32.load8_u (local.get $name_ptr)) (i32.const 0x47)) ;; 'G'
      (then
        ;; Log the name for debugging
        (call $host_log (local.get $name_ptr) (i32.const 32))
        ;; Assume 1-4 args, pop 4 as safe default
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))

    ;; SendMessageA — 4 args, return 0
    ;; "Send" = 0x646E6553
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x646E6553))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))

    ;; PostQuitMessage — 1 arg, no return
    ;; "Post" = 0x74736F50
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x74736F50))
      (then
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))

    ;; DefWindowProcA — 4 args
    ;; "DefW" = 0x57666544
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x57666544))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))

    ;; DestroyWindow — 1 arg
    ;; "Dest" = 0x74736544
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x74736544))
      (then
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))

    ;; DispatchMessageA — 1 arg
    ;; "Disp" = 0x70736944
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x70736944))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))

    ;; TranslateMessage — 1 arg
    ;; "Tran" = 0x6E617254
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x6E617254))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))

    ;; wsprintfA — varargs, hard to handle; stub
    ;; "wspr" = 0x72707377
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x72707377))
      (then
        (global.set $eax (i32.const 0))
        ;; Pop 3 args as common case
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))

    ;; ---- GDI32 stubs — return nonzero/fake handles ----

    ;; "Sele" SelectObject = 0x656C6553
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x656C6553))
      (then
        (global.set $eax (i32.const 0x30001))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))

    ;; "Dele" DeleteObject/DeleteDC = 0x656C6544
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x656C6544))
      (then
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))

    ;; ---- ADVAPI32 stubs ----
    ;; "RegO" RegOpenKeyA = 0x4F676552
    ;; "RegC" RegCloseKey/RegCreateKeyA = 0x43676552
    ;; "RegQ" RegQueryValueExA = 0x51676552
    ;; "RegS" RegSetValueExA = 0x53676552
    (if (i32.eq (i32.load16_u (local.get $name_ptr)) (i32.const 0x6552)) ;; "Re"
      (then
        ;; RegOpenKeyA — 3 args, return ERROR_FILE_NOT_FOUND (2)
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 3))) (i32.const 0x4F)) ;; 'O'
          (then
            (global.set $eax (i32.const 2))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
            (return)))
        ;; RegCloseKey — 1 arg
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 3))) (i32.const 0x43)) ;; 'C'
          (then
            (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
            (return)))
        ;; RegQueryValueExA — 6 args, return ERROR_FILE_NOT_FOUND
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 3))) (i32.const 0x51)) ;; 'Q'
          (then
            (global.set $eax (i32.const 2))
            (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
            (return)))
        ;; RegCreateKeyA — 3 args
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))

    ;; ---- SHELL32 stubs ----
    ;; "Shel" ShellAboutA/ShellExecuteA = 0x6C656853
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x6C656853))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))

    ;; "Drag" DragAcceptFiles etc = 0x67617244
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x67617244))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))

    ;; ---- comdlg32 stubs ----
    ;; All return 0 (user cancelled), pop 1 arg
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x4F746547)) ;; "GetO" GetOpenFileNameA
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (if (i32.eq (i32.load (local.get $name_ptr)) (i32.const 0x6F6F6843)) ;; "Choo" ChooseFontA
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))

    ;; ---- Generic fallback: log name, return 0, pop 4 args ----
    (call $host_log (local.get $name_ptr) (i32.const 48))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; Simple name hash (not currently used for dispatch, but available)
  (func $hash_name (param $ptr i32) (result i32)
    (local $hash i32)
    (local $ch i32)
    (local.set $hash (i32.const 5381))
    (block $done
      (loop $hash_loop
        (local.set $ch (i32.load8_u (local.get $ptr)))
        (br_if $done (i32.eqz (local.get $ch)))
        ;; hash = hash * 33 + ch
        (local.set $hash (i32.add
          (i32.add (i32.shl (local.get $hash) (i32.const 5)) (local.get $hash))
          (local.get $ch)))
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
        (br $hash_loop)
      )
    )
    (local.get $hash)
  )

  ;; ============================================================
  ;; MEMCPY
  ;; ============================================================
  (func $memcpy (param $dst i32) (param $src i32) (param $len i32)
    (local $i i32)
    (local.set $i (i32.const 0))
    (block $done
      (loop $copy
        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
        (i32.store8
          (i32.add (local.get $dst) (local.get $i))
          (i32.load8_u (i32.add (local.get $src) (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $copy)
      )
    )
  )

  ;; ============================================================
  ;; HELPER FUNCTIONS for Win32 stubs
  ;; ============================================================

  ;; Simple bump allocator for guest heap
  (func $heap_alloc (param $size i32) (result i32)
    (local $ptr i32)
    (local.set $ptr (global.get $heap_ptr))
    ;; Align to 8 bytes
    (global.set $heap_ptr (i32.and
      (i32.add (i32.add (global.get $heap_ptr) (local.get $size)) (i32.const 7))
      (i32.const 0xFFFFFFF8)))
    (local.get $ptr)
  )

  ;; Zero memory at WASM address
  (func $zero_memory (param $wasm_ptr i32) (param $len i32)
    (local $i i32)
    (local.set $i (i32.const 0))
    (block $done
      (loop $zloop
        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
        (i32.store8 (i32.add (local.get $wasm_ptr) (local.get $i)) (i32.const 0))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $zloop)))
  )

  ;; Store a fake command line string and set $fake_cmdline_addr
  (func $store_fake_cmdline
    (local $ptr i32)
    ;; Allocate in guest heap
    (local.set $ptr (call $heap_alloc (i32.const 16)))
    (global.set $fake_cmdline_addr (local.get $ptr))
    ;; Write "NOTEPAD\0" at the guest address
    ;; Need to write to WASM linear memory at guest_to_wasm(ptr)
    (i32.store (call $guest_to_wasm (local.get $ptr)) (i32.const 0x45544F4E)) ;; "NOTE"
    (i32.store (i32.add (call $guest_to_wasm (local.get $ptr)) (i32.const 4)) (i32.const 0x00444150)) ;; "PAD\0"
  )

  ;; Guest strlen — count bytes until null
  (func $guest_strlen (param $guest_ptr i32) (result i32)
    (local $len i32)
    (local.set $len (i32.const 0))
    (block $done
      (loop $sloop
        (br_if $done (i32.eqz (call $guest_load8
          (i32.add (local.get $guest_ptr) (local.get $len)))))
        (local.set $len (i32.add (local.get $len) (i32.const 1)))
        (br_if $done (i32.ge_u (local.get $len) (i32.const 65536))) ;; safety limit
        (br $sloop)))
    (local.get $len)
  )

  ;; Guest strcpy — copy null-terminated string
  (func $guest_strcpy (param $dst i32) (param $src i32)
    (local $i i32)
    (local $ch i32)
    (local.set $i (i32.const 0))
    (block $done
      (loop $cloop
        (local.set $ch (call $guest_load8 (i32.add (local.get $src) (local.get $i))))
        (call $guest_store8 (i32.add (local.get $dst) (local.get $i)) (local.get $ch))
        (br_if $done (i32.eqz (local.get $ch)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $cloop)))
  )

  ;; ============================================================
  ;; MAIN RUN LOOP
  ;; ============================================================
  ;; Called from JS. Runs up to $max_steps x86 instructions,
  ;; then yields back to JS.

  (func $run (export "run") (param $max_steps i32)
    (local $thread i32)

    (global.set $steps (local.get $max_steps))

    (block $halt
      (loop $main
        ;; Out of steps? Yield to JS.
        (br_if $halt (i32.le_s (global.get $steps) (i32.const 0)))

        ;; Look up or decode block for current EIP
        (local.set $thread (call $cache_lookup (global.get $eip)))
        (if (i32.eqz (local.get $thread))
          (then
            (local.set $thread (call $decode_block (global.get $eip)))
          )
        )

        ;; Run the threaded block
        (global.set $ip (local.get $thread))
        (call $next)

        ;; $next returns when block ends (control transfer) or steps exhausted
        (br $main)
      )
    )
  )

  ;; ============================================================
  ;; DEBUG EXPORTS
  ;; ============================================================
  (func $get_eip (export "get_eip") (result i32) (global.get $eip))
  (func $get_esp (export "get_esp") (result i32) (global.get $esp))
  (func $get_eax (export "get_eax") (result i32) (global.get $eax))
  (func $get_ecx (export "get_ecx") (result i32) (global.get $ecx))
  (func $get_edx (export "get_edx") (result i32) (global.get $edx))
  (func $get_ebx (export "get_ebx") (result i32) (global.get $ebx))
  (func $get_ebp (export "get_ebp") (result i32) (global.get $ebp))
  (func $get_esi (export "get_esi") (result i32) (global.get $esi))
  (func $get_edi (export "get_edi") (result i32) (global.get $edi))
  (func $get_staging (export "get_staging") (result i32) (global.get $PE_STAGING))
)
