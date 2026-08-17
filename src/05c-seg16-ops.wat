  ;; ============================================================
  ;; 16-BIT SEGMENTED OPERATIONS — the execution half of the NE loader
  ;; ============================================================
  ;;
  ;; A Win16 image is a set of 64KB segments rather than one flat mapping, so
  ;; every address a 16-bit instruction forms is `segment base + 16-bit offset`
  ;; rather than a linear number. This file holds the handlers that know that.
  ;;
  ;; The one invariant everything else rests on: every segment base is 64KB
  ;; aligned (WIN16_ARENA + index * 0x10000). That makes the low 16 bits of a
  ;; linear address inside a segment identical to the offset within it, which
  ;; is why the existing 16-bit stack handlers work unchanged — $esp holds
  ;; `ss_base + sp`, and pushing `esp & 0xFFFF` pushes SP. It is also why a
  ;; near CALL can push the low word of a linear return address and a near RET
  ;; can rebuild the linear address as `cs_base | ip`.
  ;;
  ;; Segment ids follow the x86 ModRM sreg encoding throughout: 0=ES, 1=CS,
  ;; 2=SS, 3=DS. FS and GS have no meaning in a Win16 task and trap.

  (func $seg16_base (param $id i32) (result i32)
    (if (i32.eq (local.get $id) (i32.const 0)) (then (return (global.get $seg_base_es))))
    (if (i32.eq (local.get $id) (i32.const 1)) (then (return (global.get $seg_base_cs))))
    (if (i32.eq (local.get $id) (i32.const 2)) (then (return (global.get $seg_base_ss))))
    (if (i32.eq (local.get $id) (i32.const 3)) (then (return (global.get $seg_base_ds))))
    (call $host_log_i32 (i32.const 0xCA165E67))  ;; FS/GS in a 16-bit task
    (call $host_log_i32 (local.get $id))
    (unreachable))

  (func $seg16_value (param $id i32) (result i32)
    (if (i32.eq (local.get $id) (i32.const 0)) (then (return (global.get $sreg_es))))
    (if (i32.eq (local.get $id) (i32.const 1)) (then (return (global.get $sreg_cs))))
    (if (i32.eq (local.get $id) (i32.const 2)) (then (return (global.get $sreg_ss))))
    (global.get $sreg_ds))

  ;; Load a segment register. The base comes from WIN16_SEG_TABLE, so a
  ;; selector that names no segment is a real bug — a GlobalAlloc block whose
  ;; selector was never registered, or a wild value — and traps here rather
  ;; than silently addressing segment 0.
  ;;
  ;; SS is special: $esp is `ss_base + sp`, so moving SS has to carry the
  ;; offset across to the new base. Guest code writes SS and SP as a pair and
  ;; expects SP to survive the SS write.
  (func $win16_set_sreg (export "win16_set_sreg") (param $id i32) (param $sel i32)
    (local $base i32)
    (local.set $sel (i32.and (local.get $sel) (i32.const 0xFFFF)))
    (local.set $base (call $win16_seg_base (call $win16_sel_to_index (local.get $sel))))
    (if (i32.eqz (local.get $base))
      (then
        (call $host_log_i32 (i32.const 0xCA165E10))  ;; selector names no segment
        (call $host_log_i32 (local.get $sel))
        (call $host_log_i32 (global.get $eip))
        (unreachable)))
    (if (i32.eq (local.get $id) (i32.const 0))
      (then (global.set $sreg_es (local.get $sel)) (global.set $seg_base_es (local.get $base)) (return)))
    (if (i32.eq (local.get $id) (i32.const 1))
      (then (global.set $sreg_cs (local.get $sel)) (global.set $seg_base_cs (local.get $base)) (return)))
    (if (i32.eq (local.get $id) (i32.const 2))
      (then
        (global.set $sreg_ss (local.get $sel))
        (global.set $seg_base_ss (local.get $base))
        (global.set $esp (i32.add (local.get $base) (i32.and (global.get $esp) (i32.const 0xFFFF))))
        (return)))
    (if (i32.eq (local.get $id) (i32.const 3))
      (then (global.set $sreg_ds (local.get $sel)) (global.set $seg_base_ds (local.get $base)) (return)))
    (call $host_log_i32 (i32.const 0xCA165E67))
    (call $host_log_i32 (local.get $id))
    (unreachable))

  ;; ---- Effective addresses ----
  ;;
  ;; info = base | index<<4 | seg<<8, with 0xF meaning "no register". The sum
  ;; wraps inside the segment before the base is added, which is what makes
  ;; `[bp-2]` with a small BP address the top of the segment rather than the
  ;; segment below it.
  (func $ea16_compute (param $info i32) (param $disp i32) (result i32)
    (local $off i32)
    (if (i32.ne (i32.and (local.get $info) (i32.const 0xF)) (i32.const 0xF))
      (then (local.set $off (call $get_reg (i32.and (local.get $info) (i32.const 0xF))))))
    (if (i32.ne (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF)) (i32.const 0xF))
      (then (local.set $off (i32.add (local.get $off)
        (call $get_reg (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF)))))))
    (i32.add
      (call $seg16_base (i32.and (i32.shr_u (local.get $info) (i32.const 8)) (i32.const 7)))
      (i32.and (i32.add (local.get $off) (local.get $disp)) (i32.const 0xFFFF))))

  ;; 363: compute a 16-bit segmented EA into ea_temp, then fall through to the
  ;; handler that consumes it — the same contract as $th_compute_ea_sib.
  (func $th_compute_ea16 (param $op i32)
    (local $info i32)
    (local.set $info (call $read_thread_word))
    (global.set $ea_temp (call $ea16_compute (local.get $info) (call $read_thread_word)))
    (return_call $next))

  ;; 364: LEA r16, m — the offset only, with no segment base and wrapped to
  ;; the segment, because that is the number the guest is about to use as one.
  (func $th_lea16 (param $op i32)
    (local $info i32) (local $off i32)
    (local.set $info (call $read_thread_word))
    (if (i32.ne (i32.and (local.get $info) (i32.const 0xF)) (i32.const 0xF))
      (then (local.set $off (call $get_reg (i32.and (local.get $info) (i32.const 0xF))))))
    (if (i32.ne (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF)) (i32.const 0xF))
      (then (local.set $off (i32.add (local.get $off)
        (call $get_reg (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF)))))))
    (call $set_reg16 (local.get $op)
      (i32.and (i32.add (local.get $off) (call $read_thread_word)) (i32.const 0xFFFF)))
    (return_call $next))

  ;; ---- Near returns ----
  ;;
  ;; The pushed word is IP, so the linear address comes back from the current
  ;; CS base. A near RET cannot change segment.
  (func $th_ret16 (param $op i32)
    (global.set $eip (i32.add (global.get $seg_base_cs) (call $gl16 (global.get $esp))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 2)))
    (call $cs_pop))

  (func $th_ret16_imm (param $op i32)
    (global.set $eip (i32.add (global.get $seg_base_cs) (call $gl16 (global.get $esp))))
    (global.set $esp (i32.add (global.get $esp) (i32.add (i32.const 2) (local.get $op))))
    (call $cs_pop))

  ;; ---- Far transfers ----
  ;;
  ;; A far call into WIN16_THUNK_SEL is an imported function: the loader
  ;; pointed every IMPORTORDINAL fixup there, so this is the single place a
  ;; Win16 API call is recognised, exactly as the thunk zone is for Win32.
  (func $win16_far_transfer (param $sel i32) (param $off i32) (param $ret_lin i32) (param $is_call i32)
    (if (i32.eq (local.get $sel) (global.get $WIN16_THUNK_SEL))
      (then
        (if (i32.eqz (local.get $is_call))
          (then
            ;; A far JMP to a thunk is a tail call: the return address on the
            ;; stack is already the caller's, so dispatch and let the API's own
            ;; far return unwind it.
            (call $win16_dispatch (local.get $off) (i32.const 0))
            (return)))
        (call $win16_dispatch (local.get $off) (local.get $ret_lin))
        (return)))
    (if (local.get $is_call)
      (then (call $cs_push (local.get $ret_lin))))
    (call $win16_set_sreg (i32.const 1) (local.get $sel))
    (global.set $eip (i32.add (global.get $seg_base_cs) (i32.and (local.get $off) (i32.const 0xFFFF)))))

  ;; Push CS:IP for a far call. Done before the transfer so a dispatched API
  ;; sees the same stack a real one would.
  (func $win16_push_far_ret (param $ret_lin i32)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 2)))
    (call $gs16 (global.get $esp) (global.get $sreg_cs))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 2)))
    (call $gs16 (global.get $esp) (i32.and (local.get $ret_lin) (i32.const 0xFFFF))))

  ;; 367: CALL FAR ptr16:16 — op = linear return address, then offset, selector
  (func $th_call_far_imm (param $op i32)
    (local $off i32) (local $sel i32)
    (local.set $off (call $read_thread_word))
    (local.set $sel (call $read_thread_word))
    (call $win16_push_far_ret (local.get $op))
    (call $win16_far_transfer (local.get $sel) (local.get $off) (local.get $op) (i32.const 1)))

  ;; 368: JMP FAR ptr16:16 — offset, selector
  (func $th_jmp_far_imm (param $op i32)
    (local $off i32) (local $sel i32)
    (local.set $off (call $read_thread_word))
    (local.set $sel (call $read_thread_word))
    (call $win16_far_transfer (local.get $sel) (local.get $off) (i32.const 0) (i32.const 0)))

  ;; 369: CALL FAR m16:16 — op = linear return address, address in next word
  (func $th_call_far_mem (param $op i32)
    (local $addr i32) (local $off i32) (local $sel i32)
    (local.set $addr (call $read_addr))
    (local.set $off (call $gl16 (local.get $addr)))
    (local.set $sel (call $gl16 (i32.add (local.get $addr) (i32.const 2))))
    (call $win16_push_far_ret (local.get $op))
    (call $win16_far_transfer (local.get $sel) (local.get $off) (local.get $op) (i32.const 1)))

  ;; 370: JMP FAR m16:16
  (func $th_jmp_far_mem (param $op i32)
    (local $addr i32) (local $off i32) (local $sel i32)
    (local.set $addr (call $read_addr))
    (local.set $off (call $gl16 (local.get $addr)))
    (local.set $sel (call $gl16 (i32.add (local.get $addr) (i32.const 2))))
    (call $win16_far_transfer (local.get $sel) (local.get $off) (i32.const 0) (i32.const 0)))

  ;; 371: RETF — pop IP then CS
  (func $th_retf16 (param $op i32)
    (local $ip i32) (local $sel i32)
    (local.set $ip (call $gl16 (global.get $esp)))
    (local.set $sel (call $gl16 (i32.add (global.get $esp) (i32.const 2))))
    (global.set $esp (i32.add (global.get $esp) (i32.add (i32.const 4) (local.get $op))))
    ;; Returning *into* the thunk segment is how an API that handed control to
    ;; guest code gets it back — see $win16_enter_wndproc's continuation. A far
    ;; call there is an API call; a far return there is an API resuming.
    (if (i32.eq (local.get $sel) (global.get $WIN16_THUNK_SEL))
      (then (call $win16_dispatch (local.get $ip) (i32.const 0)) (return)))
    (call $win16_set_sreg (i32.const 1) (local.get $sel))
    (global.set $eip (i32.add (global.get $seg_base_cs) (local.get $ip)))
    (call $cs_pop))

  ;; ---- Segment register moves ----

  ;; 372: MOV Sreg, r16 — op = sreg<<4 | reg
  (func $th_mov_sreg_r16 (param $op i32)
    (call $win16_set_sreg (i32.shr_u (local.get $op) (i32.const 4))
      (call $get_reg (i32.and (local.get $op) (i32.const 0xF))))
    (return_call $next))

  ;; 373: MOV Sreg, m16 — op = sreg id, address in next word
  (func $th_mov_sreg_m16 (param $op i32)
    (call $win16_set_sreg (local.get $op) (call $gl16 (call $read_addr)))
    (return_call $next))

  ;; 374: PUSH Sreg (16-bit stack) — op = sreg id
  (func $th_push_sreg16 (param $op i32)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 2)))
    (call $gs16 (global.get $esp) (call $seg16_value (local.get $op)))
    (return_call $next))

  ;; 375: POP Sreg (16-bit stack) — op = sreg id
  (func $th_pop_sreg16 (param $op i32)
    (local $sel i32)
    (local.set $sel (call $gl16 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 2)))
    (call $win16_set_sreg (local.get $op) (local.get $sel))
    (return_call $next))

  ;; 376: LES/LDS r16, m16:16 — op = sreg<<4 | reg, address in next word
  (func $th_load_far_ptr (param $op i32)
    (local $addr i32)
    (local.set $addr (call $read_addr))
    (call $set_reg16 (i32.and (local.get $op) (i32.const 0xF)) (call $gl16 (local.get $addr)))
    (call $win16_set_sreg (i32.shr_u (local.get $op) (i32.const 4))
      (call $gl16 (i32.add (local.get $addr) (i32.const 2))))
    (return_call $next))

  ;; 377: MOV r16, Sreg — op = sreg<<4 | reg
  (func $th_mov_r16_sreg (param $op i32)
    (call $set_reg16 (i32.and (local.get $op) (i32.const 0xF))
      (call $seg16_value (i32.shr_u (local.get $op) (i32.const 4))))
    (return_call $next))

  ;; 378: MOV m16, Sreg — op = sreg id, address in next word
  (func $th_mov_m16_sreg (param $op i32)
    (call $gs16 (call $read_addr) (call $seg16_value (local.get $op)))
    (return_call $next))

  ;; ---- Near indirect transfers ----
  ;;
  ;; The target word is an offset in the current code segment, and the pushed
  ;; return address is an offset too, so both go through the CS base.

  ;; 379: CALL r/m16 (register form) — op = linear return address, reg next
  (func $th_call_near16_r (param $op i32)
    (local $target i32)
    (local.set $target (i32.and (call $get_reg (call $read_thread_word)) (i32.const 0xFFFF)))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 2)))
    (call $gs16 (global.get $esp) (i32.and (local.get $op) (i32.const 0xFFFF)))
    (call $cs_push (local.get $op))
    (global.set $eip (i32.add (global.get $seg_base_cs) (local.get $target))))

  ;; 380: CALL r/m16 (memory form) — op = linear return address, address next
  (func $th_call_near16_m (param $op i32)
    (local $target i32)
    (local.set $target (call $gl16 (call $read_addr)))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 2)))
    (call $gs16 (global.get $esp) (i32.and (local.get $op) (i32.const 0xFFFF)))
    (call $cs_push (local.get $op))
    (global.set $eip (i32.add (global.get $seg_base_cs) (local.get $target))))

  ;; 381: JMP r/m16 (register form) — op = reg
  (func $th_jmp_near16_r (param $op i32)
    (global.set $eip (i32.add (global.get $seg_base_cs)
      (i32.and (call $get_reg (local.get $op)) (i32.const 0xFFFF)))))

  ;; 382: JMP r/m16 (memory form) — address in next word
  (func $th_jmp_near16_m (param $op i32)
    (global.set $eip (i32.add (global.get $seg_base_cs) (call $gl16 (call $read_addr)))))

  ;; ---- Inspection exports (used by test/test-win16-exec.js) ----
  (func (export "win16_sreg") (param $id i32) (result i32) (call $seg16_value (local.get $id)))
  (func (export "win16_seg_base_of") (param $id i32) (result i32) (call $seg16_base (local.get $id)))
  (func (export "is_code16") (result i32) (global.get $code16))

  ;; ---- Frame setup ----
  ;;
  ;; ENTER and LEAVE are 286 instructions and the standard prologue and
  ;; epilogue of 16-bit compiled code, so a Win16 task reaches them almost
  ;; immediately. The 32-bit forms are still undecoded and still trap; adding
  ;; them is a separate change with its own blast radius.

  ;; 383: ENTER imm16, 0 — push BP, BP = SP, SP -= imm16. The nesting level is
  ;; checked at decode time, so this only ever sees level 0.
  (func $th_enter16 (param $op i32)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 2)))
    (call $gs16 (global.get $esp) (i32.and (global.get $ebp) (i32.const 0xFFFF)))
    (call $set_reg16 (i32.const 5) (i32.and (global.get $esp) (i32.const 0xFFFF)))
    (global.set $esp (i32.sub (global.get $esp) (i32.and (local.get $op) (i32.const 0xFFFF))))
    (return_call $next))

  ;; 384: LEAVE — SP = BP, then pop BP. SP comes back through the SS base
  ;; because BP holds an offset, not a linear address.
  (func $th_leave16 (param $op i32)
    (global.set $esp (i32.add (global.get $seg_base_ss)
                              (i32.and (global.get $ebp) (i32.const 0xFFFF))))
    (call $set_reg16 (i32.const 5) (call $gl16 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 2)))
    (return_call $next))

  ;; 385: PUSH imm16 — the operand is the immediate, already fetched.
  ;;
  ;; 0x68/0x6A always emitted the 32-bit push, which fetched the right number
  ;; of immediate bytes but stored four of them. In flat code that is invisible
  ;; because every push and pop agrees; it shows up in a 16-bit task at the
  ;; first Pascal API call, where the extra two bytes shift the whole argument
  ;; frame by one word and, say, LoadString reads its buffer selector where its
  ;; id should be. Native 16-bit code reaches here through $code16; 32-bit code
  ;; reaches it through a real 0x66 prefix, where the same narrowing is right.
  (func $th_push_imm16 (param $op i32)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 2)))
    (call $gs16 (global.get $esp) (i32.and (local.get $op) (i32.const 0xFFFF)))
    (return_call $next))

  ;; 386: 16-bit string operation.
  ;;
  ;; The 32-bit side spends eighteen handlers on these because they sit in the
  ;; inner loop of every memcpy a flat program makes. In a 16-bit task they run
  ;; at startup and inside the odd string helper, and every one of them does
  ;; the same segmented address arithmetic, so one parameterised loop is the
  ;; better trade. The operand packs everything it needs:
  ;;
  ;;   bits 0-2    element size in bytes, 1 or 2
  ;;   bits 4-6    kind: 0 MOVS, 1 STOS, 2 LODS, 3 CMPS, 4 SCAS
  ;;   bits 8-9    repeat: 0 none, 1 REP/REPE, 2 REPNE
  ;;   bits 12-13  source segment, for a prefix override; ES:DI is fixed
  ;;
  ;; SI and DI are offsets within their segments, so they wrap at 16 bits
  ;; rather than running into the next segment's arena slot — a `rep stosw`
  ;; that walks off the end of a segment is a guest bug, and wrapping is what
  ;; the hardware does with it.
  (func $th_string16 (param $op i32)
    (local $size i32) (local $kind i32) (local $rep i32)
    (local $src_base i32) (local $dst_base i32) (local $step i32)
    (local $si i32) (local $di i32) (local $a i32) (local $b i32)
    (local.set $size (i32.and (local.get $op) (i32.const 7)))
    (local.set $kind (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 7)))
    (local.set $rep  (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 3)))
    (local.set $src_base (call $seg16_base
      (i32.and (i32.shr_u (local.get $op) (i32.const 12)) (i32.const 3))))
    (local.set $dst_base (global.get $seg_base_es))
    (local.set $step (select (i32.sub (i32.const 0) (local.get $size)) (local.get $size)
                             (global.get $df)))
    (local.set $si (i32.and (global.get $esi) (i32.const 0xFFFF)))
    (local.set $di (i32.and (global.get $edi) (i32.const 0xFFFF)))

    (block $done (loop $step_one
      (if (local.get $rep)
        (then (br_if $done (i32.eqz (i32.and (global.get $ecx) (i32.const 0xFFFF))))))

      ;; The element itself. $a is what was read from the source side, $b what
      ;; the destination side holds, so CMPS and SCAS share one comparison.
      (if (i32.eq (local.get $kind) (i32.const 0))            ;; MOVS
        (then
          (if (i32.eq (local.get $size) (i32.const 1))
            (then (call $gs8 (i32.add (local.get $dst_base) (local.get $di))
                    (call $gl8 (i32.add (local.get $src_base) (local.get $si)))))
            (else (call $gs16 (i32.add (local.get $dst_base) (local.get $di))
                    (call $gl16 (i32.add (local.get $src_base) (local.get $si))))))))
      (if (i32.eq (local.get $kind) (i32.const 1))            ;; STOS
        (then
          (if (i32.eq (local.get $size) (i32.const 1))
            (then (call $gs8 (i32.add (local.get $dst_base) (local.get $di))
                    (i32.and (global.get $eax) (i32.const 0xFF))))
            (else (call $gs16 (i32.add (local.get $dst_base) (local.get $di))
                    (i32.and (global.get $eax) (i32.const 0xFFFF)))))))
      (if (i32.eq (local.get $kind) (i32.const 2))            ;; LODS
        (then
          (if (i32.eq (local.get $size) (i32.const 1))
            (then (call $set_reg8 (i32.const 0)
                    (call $gl8 (i32.add (local.get $src_base) (local.get $si)))))
            (else (call $set_reg16 (i32.const 0)
                    (call $gl16 (i32.add (local.get $src_base) (local.get $si))))))))
      (if (i32.ge_u (local.get $kind) (i32.const 3))          ;; CMPS, SCAS
        (then
          (if (i32.eq (local.get $kind) (i32.const 3))
            (then (local.set $a (if (result i32) (i32.eq (local.get $size) (i32.const 1))
                    (then (call $gl8 (i32.add (local.get $src_base) (local.get $si))))
                    (else (call $gl16 (i32.add (local.get $src_base) (local.get $si)))))))
            (else (local.set $a (i32.and (global.get $eax)
                    (select (i32.const 0xFF) (i32.const 0xFFFF)
                            (i32.eq (local.get $size) (i32.const 1)))))))
          (local.set $b (if (result i32) (i32.eq (local.get $size) (i32.const 1))
            (then (call $gl8 (i32.add (local.get $dst_base) (local.get $di))))
            (else (call $gl16 (i32.add (local.get $dst_base) (local.get $di))))))
          (global.set $flag_sign_shift
            (select (i32.const 7) (i32.const 15) (i32.eq (local.get $size) (i32.const 1))))
          (call $set_flags_sub (local.get $a) (local.get $b)
            (i32.sub (local.get $a) (local.get $b)))))

      ;; SI advances for everything that reads a source, DI for everything that
      ;; touches the destination.
      (if (i32.or (i32.eq (local.get $kind) (i32.const 0))
                  (i32.or (i32.eq (local.get $kind) (i32.const 2))
                          (i32.eq (local.get $kind) (i32.const 3))))
        (then (local.set $si (i32.and (i32.add (local.get $si) (local.get $step))
                                      (i32.const 0xFFFF)))))
      (if (i32.ne (local.get $kind) (i32.const 2))
        (then (local.set $di (i32.and (i32.add (local.get $di) (local.get $step))
                                      (i32.const 0xFFFF)))))

      (br_if $done (i32.eqz (local.get $rep)))
      (call $set_reg16 (i32.const 1)
        (i32.sub (i32.and (global.get $ecx) (i32.const 0xFFFF)) (i32.const 1)))
      ;; A repeated compare also stops on the flag the prefix names: REPE runs
      ;; while equal, REPNE while not.
      (if (i32.ge_u (local.get $kind) (i32.const 3))
        (then
          (if (i32.eq (local.get $rep) (i32.const 1))
            (then (br_if $done (i32.eqz (call $get_zf)))))
          (if (i32.eq (local.get $rep) (i32.const 2))
            (then (br_if $done (call $get_zf))))))
      (br $step_one)))

    (call $set_reg16 (i32.const 6) (local.get $si))
    (call $set_reg16 (i32.const 7) (local.get $di))
    (return_call $next))

  ;; 387: XLAT — AL = DS:[BX + AL], with the same segment override the string
  ;; ops take. The operand carries the segment id.
  (func $th_xlat16 (param $op i32)
    (call $set_reg8 (i32.const 0)
      (call $gl8 (i32.add (call $seg16_base (local.get $op))
        (i32.and (i32.add (i32.and (global.get $ebx) (i32.const 0xFFFF))
                          (i32.and (global.get $eax) (i32.const 0xFF)))
                 (i32.const 0xFFFF)))))
    (return_call $next))
