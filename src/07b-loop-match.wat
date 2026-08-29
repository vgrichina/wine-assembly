  ;; ============================================================
  ;; LOOP-IDIOM MATCHER (Design A)
  ;; ============================================================
  ;; docs/loop-idiom-superops-design.md
  ;;
  ;; Runs once per block, at the end of $decode_block, over the ops that block
  ;; just emitted. Decode-time only -- nothing here is on the $next path.
  ;;
  ;; Op boundaries come from $OP_INDEX, which $te fills in as it emits (design
  ;; 6.1). That is a RECORD of what the decoder did, so it cannot disagree with
  ;; the stream the way a declared word-count table could.
  ;;
  ;; The role table below is a different kind of thing, and is safe for a
  ;; different reason: it is a matcher-side classification whose default is
  ;; "unknown", and an unknown role declines the whole block. A handler this
  ;; file has never heard of costs a missed lowering, never a mis-walk. Extra
  ;; words are only ever read for handlers this file has classified, so the
  ;; walk cannot desynchronize either.

  ;; -- roles ---------------------------------------------------------------
  (global $LR_UNKNOWN i32 (i32.const 0))
  (global $LR_LOAD8   i32 (i32.const 1))  ;; reg8 = byte [base + disp]
  (global $LR_LOAD8S  i32 (i32.const 2))  ;; reg8 = byte [base + index*scale + disp]
  (global $LR_STORE8  i32 (i32.const 3))  ;; byte [base + disp] = reg8
  (global $LR_ADDI    i32 (i32.const 4))  ;; reg += constant
  (global $LR_ZERO    i32 (i32.const 5))  ;; reg = 0 (xor r,r / sub r,r)
  (global $LR_MIRROR  i32 (i32.const 6))  ;; [absolute] = reg
  (global $LR_JCC     i32 (i32.const 7))  ;; conditional branch
  (global $LR_MEMCTR  i32 (i32.const 8))  ;; inc/dec dword [base + disp]
  (global $LR_CMP     i32 (i32.const 9))  ;; compare two registers
  (global $LR_SHIFT   i32 (i32.const 10)) ;; shift/rotate a register
  (global $LR_ADD     i32 (i32.const 11)) ;; add one register to another

  ;; Set from the host: test/run.js --trace-loopmatch[=0xEIP].
  (global $loop_trace (mut i32) (i32.const 0))
  (global $loop_trace_eip (mut i32) (i32.const 0))
  (global $loop_selfloop_blocks (mut i32) (i32.const 0))
  (global $loop_matched_blocks (mut i32) (i32.const 0))
  (global $loop_lut_bounded_matches (mut i32) (i32.const 0))
  (global $loop_lut_runs (mut i32) (i32.const 0))
  (global $loop_lut_bytes (mut i64) (i64.const 0))
  (global $loop_lut16_matches (mut i32) (i32.const 0))
  (global $loop_lut16_runs (mut i32) (i32.const 0))
  (global $loop_lut16_bytes (mut i64) (i64.const 0))
  (global $loop_copy32_matches (mut i32) (i32.const 0))
  (global $loop_copy32_runs (mut i32) (i32.const 0))
  (global $loop_copy32_bytes (mut i64) (i64.const 0))
  (global $loop_avg_matches (mut i32) (i32.const 0))
  (global $loop_avg_runs (mut i32) (i32.const 0))
  (global $loop_avg_pixels (mut i64) (i64.const 0))
  (global $loop_rgb565_alpha_matches (mut i32) (i32.const 0))
  (global $loop_rgb565_alpha_runs (mut i32) (i32.const 0))
  (global $loop_rgb565_alpha_pixels (mut i64) (i64.const 0))
  (global $loop_aoe_fill_matches (mut i32) (i32.const 0))
  (global $loop_aoe_fill_runs (mut i32) (i32.const 0))
  (global $loop_aoe_fill_bytes (mut i64) (i64.const 0))
  (global $loop_aoe_span_matches (mut i32) (i32.const 0))
  (global $loop_aoe_span_runs (mut i32) (i32.const 0))
  ;; LUT_RUN and COPY_RUN have independent gates. The role-proved LUT lowering
  ;; is on by default; COPY remains off while its historical Storm divergence
  ;; is investigated. set_loop_emit still controls both for compatibility.
  (global $loop_lut_emit_enabled (mut i32) (i32.const 1))
  ;; Benchmark/rollback gate for the Heroes III stack-table extension only.
  (global $loop_lut16_stack_emit_enabled (mut i32) (i32.const 1))
  ;; COPY_RUN is app-opted-in on the main instance, but guest threads execute
  ;; in separate WebAssembly instances. Keep its process gate in shared memory
  ;; so every decoder sees the same value.
  (global $LOOP_PROCESS_STATE i32 (i32.const 0x07F0CEE0))
  (global $LOOP_PROCESS_STATE_SIZE i32 (i32.const 0x00000004))
  (func $loop_copy_emit_get (result i32)
    (i32.atomic.load (global.get $LOOP_PROCESS_STATE)))
  (func $loop_copy_emit_set (param $flag i32)
    (i32.atomic.store (global.get $LOOP_PROCESS_STATE) (local.get $flag)))
  ;; Exact six-op AoE grid-fill lowering. Independently switchable for
  ;; same-process semantic and timing A/Bs; the production default is on.
  (global $loop_aoe_fill_emit_enabled (mut i32) (i32.const 1))
  (global $loop_aoe_span_emit_enabled (mut i32) (i32.const 1))
  ;; Jazz 2 has three copies of one exact two-block masked MMX row loop. Keep
  ;; its gate and the two semantically identical store strategies separate
  ;; from the older scalar COPY_RUN gate: the benchmark can switch the latter
  ;; at runtime after one decoded H419 stream has been cached.
  (global $mmx_mask_copy_enabled (mut i32) (i32.const 1))
  ;; In larger same-process alternating runs, two v128 stores beat the bulk arm
  ;; by 22-32% for this exact 32-byte row: memory.copy rereads bytes already
  ;; loaded to preserve MMX state. Keep the measured winner as the default.
  (global $mmx_mask_copy_use_bulk (mut i32) (i32.const 0))
  (global $mmx_mask_copy_matches (mut i32) (i32.const 0))
  (global $mmx_mask_copy_runs (mut i32) (i32.const 0))
  (global $mmx_mask_copy_rows (mut i64) (i64.const 0))
  (global $mmx_mask_copy_bytes (mut i64) (i64.const 0))

  ;; Recognize the exact Jazz row-mask loop at 0x468892/0x468a04/0x468b7e.
  ;; This is deliberately a raw-byte proof rather than an extension of the
  ;; self-loop matcher: JAE splits the idiom into a mask head and a copy/tail
  ;; block, while Design A only sees one self-loop block at a time. A near miss
  ;; falls through to the ordinary decoder without consuming a byte.
  (func $try_emit_mmx_mask_copy32 (param $start_eip i32) (result i32)
    (if (i32.or (i32.eqz (global.get $mmx_mask_copy_enabled))
                (global.get $code16))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (local.get $start_eip)) (i32.const 0x1E73DB03))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $start_eip) (i32.const 4)))
                (i32.const 0x0F066F0F)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $start_eip) (i32.const 8)))
                (i32.const 0x0F084E6F)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $start_eip) (i32.const 12)))
                (i32.const 0x0F10566F)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $start_eip) (i32.const 16)))
                (i32.const 0x0F185E6F)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $start_eip) (i32.const 20)))
                (i32.const 0x7F0F077F)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $start_eip) (i32.const 24)))
                (i32.const 0x7F0F084F)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $start_eip) (i32.const 28)))
                (i32.const 0x7F0F1057)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $start_eip) (i32.const 32)))
                (i32.const 0xF803185F)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $start_eip) (i32.const 36)))
                (i32.const 0x4A20C683)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl16 (i32.add (local.get $start_eip) (i32.const 40)))
                (i32.const 0xD675)) (then (return (i32.const 0))))

    (global.set $mmx_mask_copy_matches
      (i32.add (global.get $mmx_mask_copy_matches) (i32.const 1)))
    ;; Reuse H419's otherwise-zero operand namespace. The high bit selects the
    ;; fixed masked-MMX descriptor; the normal scalar COPY_RUN remains op=0.
    (call $te (global.get $LOOP_SUPEROP_COPY) (i32.const 0x80000000))
    (call $te_raw (i32.add (local.get $start_eip) (i32.const 42)))
    (call $te_raw (local.get $start_eip))
    (global.set $d_pc (i32.add (local.get $start_eip) (i32.const 42)))
    (i32.const 1))

  ;; AoE I and II use the same span-list data structure and clipping algorithm,
  ;; but their MSVC builds assigned x/min/max registers differently and only
  ;; AoE I scales the row register before lookup. Recognize either exact prefix
  ;; and pass that register-layout mode to one parameterized handler. All exits
  ;; are entry-relative, so no binary address lives in core.
  (func $try_emit_aoe_span_prefix (param $start_eip i32) (result i32)
    (local $mode i32)
    (if (i32.or
          (i32.eqz (global.get $loop_aoe_span_emit_enabled))
          (global.get $code16))
      (then (return (i32.const 0))))
    ;; Shared push/mov/prologue bytes.
    (if (i32.or
          (i32.ne (call $gl32 (local.get $start_eip)) (i32.const 0x8B565553))
          (i32.ne (call $gl32 (i32.add (local.get $start_eip) (i32.const 4)))
                  (i32.const 0x7C8B57F1)))
      (then (return (i32.const 0))))

    ;; Mode 1: AoE I, EAX=x0 and EDI=row*4.
    (if (i32.and
          (i32.eq (call $gl32 (i32.add (local.get $start_eip) (i32.const 0x20)))
                  (i32.const 0x1424448B))
          (i32.and
            (i32.eq (call $gl32 (i32.add (local.get $start_eip) (i32.const 0x50)))
                    (i32.const 0x14244C89))
            (i32.and
              (i32.eq (call $gl32 (i32.add (local.get $start_eip) (i32.const 0x5e)))
                      (i32.const 0xC13C468B))
              (i32.eq (call $gl32 (i32.add (local.get $start_eip) (i32.const 0x67)))
                      (i32.const 0x3C75DB85)))))
      (then (local.set $mode (i32.const 1))))

    ;; Mode 2: AoE II, EBX=x0 and EDI=row.
    (if (i32.and
          (i32.eq (call $gl32 (i32.add (local.get $start_eip) (i32.const 0x20)))
                  (i32.const 0x18246C8B))
          (i32.and
            (i32.eq (call $gl32 (i32.add (local.get $start_eip) (i32.const 0x50)))
                    (i32.const 0x14244489))
            (i32.and
              (i32.eq (call $gl32 (i32.add (local.get $start_eip) (i32.const 0x60)))
                      (i32.const 0x8B3C468B))
              (i32.eq (call $gl16 (i32.add (local.get $start_eip) (i32.const 0x67)))
                      (i32.const 0x75C0)))))
      (then (local.set $mode (i32.const 2))))
    (if (i32.eqz (local.get $mode)) (then (return (i32.const 0))))

    (global.set $loop_aoe_span_matches
      (i32.add (global.get $loop_aoe_span_matches) (i32.const 1)))
    (call $te (i32.const 438) (local.get $mode))
    (call $te_raw (local.get $start_eip))
    (global.set $d_pc
      (i32.add (local.get $start_eip)
        (select (i32.const 0x6b) (i32.const 0x6a)
          (i32.eq (local.get $mode) (i32.const 1)))))
    (i32.const 1))

  ;; Is this handler index a conditional branch? 44 is the generic form
  ;; (operand = cc); 307..322 are the per-condition specializations. All read
  ;; the same two extra words: fall-through, then target.
  (func $loop_is_jcc (param $fn i32) (result i32)
    (i32.or
      (i32.eq (local.get $fn) (i32.const 44))
      (i32.and
        (i32.ge_u (local.get $fn) (i32.const 307))
        (i32.le_u (local.get $fn) (i32.const 322)))))

  ;; Classify one handler index. Everything not named here is UNKNOWN.
  (func $loop_role (param $fn i32) (param $op i32) (result i32)
    (if (i32.eq (local.get $fn) (i32.const 28))
      (then (return (global.get $LR_LOAD8))))
    ;; 149 computes a SIB effective address. With bit 8 of the operand set it
    ;; also performs the byte load itself -- the fused form the decoder emits
    ;; for the overwhelmingly common consumer, and the one a LUT lookup takes.
    ;; Without bit 8 the load lives in the NEXT op, which this matcher does not
    ;; model, so decline.
    (if (i32.eq (local.get $fn) (i32.const 149))
      (then
        (if (i32.and (local.get $op) (i32.const 0x100))
          (then (return (global.get $LR_LOAD8S))))
        (return (global.get $LR_UNKNOWN))))
    (if (i32.eq (local.get $fn) (i32.const 29))
      (then (return (global.get $LR_STORE8))))
    (if (i32.or (i32.eq (local.get $fn) (i32.const 64))
                (i32.eq (local.get $fn) (i32.const 65)))
      (then (return (global.get $LR_ADDI))))
    (if (i32.eq (local.get $fn) (i32.const 19))
      (then (return (global.get $LR_CMP))))
    (if (i32.eq (local.get $fn) (i32.const 53))
      (then (return (global.get $LR_SHIFT))))
    (if (i32.eq (local.get $fn) (i32.const 12))
      (then (return (global.get $LR_ADD))))
    ;; xor r,r and sub r,r are the zeroing idiom, not arithmetic (design 9.5),
    ;; but only when both operands name the same register.
    (if (i32.or (i32.eq (local.get $fn) (i32.const 18))
                (i32.eq (local.get $fn) (i32.const 17)))
      (then
        (if (i32.eq (i32.shr_u (local.get $op) (i32.const 4))
                    (i32.and (local.get $op) (i32.const 0xF)))
          (then (return (global.get $LR_ZERO))))
        (return (global.get $LR_UNKNOWN))))
    ;; STORE32 to an absolute address -- the spill-to-global "mirror" store.
    (if (i32.eq (local.get $fn) (i32.const 21))
      (then (return (global.get $LR_MIRROR))))
    ;; 135 is inc/dec/not/neg of a dword in memory; only the two counting forms
    ;; (uop 0 = inc, 1 = dec) are a role. A trip counter that lives on the
    ;; stack instead of in a register is the normal shape once a loop body has
    ;; run out of registers, which is exactly when the body is worth lowering.
    (if (i32.eq (local.get $fn) (i32.const 135))
      (then
        (if (i32.le_u (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF))
                      (i32.const 1))
          (then (return (global.get $LR_MEMCTR))))
        (return (global.get $LR_UNKNOWN))))
    (if (call $loop_is_jcc (local.get $fn))
      (then (return (global.get $LR_JCC))))
    (global.get $LR_UNKNOWN))

  ;; Address of op i in the block just emitted.
  (func $loop_op_at (param $i i32) (result i32)
    (i32.load
      (i32.add (global.get $OP_INDEX)
        (i32.shl (local.get $i) (i32.const 2)))))

  ;; Does this block end in a conditional branch back to its own entry?
  (func $loop_is_selfloop (param $start_eip i32) (result i32)
    (local $p i32)
    (if (i32.lt_u (global.get $op_index_n) (i32.const 2)) (then (return (i32.const 0))))
    (local.set $p (call $loop_op_at
      (i32.sub (global.get $op_index_n) (i32.const 1))))
    (if (i32.eqz (call $loop_is_jcc (i32.load (local.get $p))))
      (then (return (i32.const 0))))
    ;; words after the header: +8 fall-through, +12 target
    (i32.eq (i32.load offset=12 (local.get $p)) (local.get $start_eip)))

  ;; Flag-gated decode-time dump: marker, entry EIP, op count, then
  ;; (handler index, operand) per op. Decoded by tools/loopmatch-decode.js.
  (func $loop_trace_block (param $start_eip i32)
    (local $i i32) (local $p i32)
    (call $host_log_i32 (i32.const 0x100B0000))
    (call $host_log_i32 (local.get $start_eip))
    (call $host_log_i32 (global.get $op_index_n))
    (local.set $i (i32.const 0))
    (block $done
      (loop $each
        (br_if $done (i32.ge_u (local.get $i) (global.get $op_index_n)))
        (local.set $p (call $loop_op_at (local.get $i)))
        (call $host_log_i32 (i32.load (local.get $p)))
        (call $host_log_i32 (i32.load offset=4 (local.get $p)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $each))))

  ;; ------------------------------------------------------------------
  ;; LUT_RUN
  ;; ------------------------------------------------------------------
  ;;   dst[i] = table[src[i]] for a counted run, e.g. Heroes II's shadow
  ;;   remap at 0x004c755d:
  ;;
  ;;     xor eax,eax / inc esi / mov al,[esi-1] / mov [g0],esi
  ;;     dec edx     / mov [g1],ecx / mov al,[eax+ecx] / mov [esi-1],al / jnz ^
  ;;
  ;; The predicate below is written against ROLES, not against that sequence:
  ;; the registers, the two displacements, the induction stride, the direction
  ;; of the counter and the presence of the two spill stores are all
  ;; parameters. Order within the body does not matter except where it changes
  ;; meaning, and where it does (whether the cursor is bumped before or after
  ;; the memory access) it is folded into the displacement at match time.
  ;;
  ;; Both this counted recognizer and the bounded recognizer below emit one
  ;; universal descriptor. Execution is shared; recognition remains separate
  ;; because proving JNZ(counter) and JB(cursor,bound) safe needs different
  ;; predicates.
  ;;
  ;; Parameter block, emitted as raw words after the super-op header:
  ;;   0 src_reg     1 src_stride  2 src_disp
  ;;   3 dst_reg     4 dst_stride  5 dst_disp
  ;;   6 tbl_reg     7 acc_reg     8 index_shift  9 index_add_reg (-1 = none)
  ;;  10 term_kind (0=count NZ, 1=cursor below bound)
  ;;  11 term_reg    12 term_step
  ;;  13 m0_addr    14 m0_reg     15 m0_adj
  ;;  16 m1_addr    17 m1_reg     18 m1_adj
  ;;  19 fall_eip   20 back_eip   21 steps_per_iter
  ;;
  ;; Header operand value 1 selects the optional two-moving-source extension:
  ;;  22 src2_reg   23 src2_stride 24 src2_disp
  ;;  25 aux_reg    26 table_disp  27 term_stream (0=src1, 1=src2)
  ;; In that form the lookup index is `(src1_byte << index_shift) + src2_byte`.
  ;; tbl_reg may be -1 for an absolute table rooted at table_disp. Bit 3 is the
  ;; counted one-source absolute-table form: word 6 holds the table's guest
  ;; address instead of a register index, and the descriptor stays 22 words.
  ;; Bit 1 selects the
  ;; Heroes III wide-pixel form: its one extra word is table_disp, the source
  ;; and index remain bytes, and the table load/destination store are u16.
  ;; Bit 2 on the wide form adds a stack displacement: tbl_reg is initialized
  ;; from `[esp + stack_disp]` once per H418 entry and published at exit.
  (global $LOOP_SUPEROP_LUT i32 (i32.const 418))
  (global $LOOP_LUT_PARAMS i32 (i32.const 22))

  ;; Heroes III's unlit RGB565 blitters all use this nine-op counted body:
  ;;
  ;;   xor acc,acc / mov acc8,[src] / add|sub dst,2 / inc src / dec count
  ;;   mov acc16,[table+acc*2+disp] / mov [dst+disp],acc16 / jnz ^
  ;;
  ;; The generic role matcher intentionally knows only byte consumers. Keep
  ;; this proof local and exact rather than teaching every matcher that the
  ;; H149 effective-address op plus H164 is one semantic word load.
  (func $loop_try_lut16_counted
    (param $start_eip i32) (param $tstart i32) (result i32)
    (local $p i32) (local $op i32) (local $info i32) (local $sib_tbl i32)
    (local $acc i32) (local $src i32) (local $dst i32)
    (local $ctr i32) (local $tbl i32) (local $dst_stride i32)
    (local $src_disp i32) (local $dst_disp i32) (local $table_disp i32)
    (local $fall i32) (local $n i32) (local $first i32)
    (local $table_stack i32) (local $stack_disp i32)

    (local.set $n (global.get $op_index_n))
    (if (i32.eq (local.get $n) (i32.const 10))
      (then
        ;; The dominant H3 form reloads its invariant table pointer from a
        ;; stack local at the top of every pixel iteration.
        (local.set $p (call $loop_op_at (i32.const 0)))
        (if (i32.ne (i32.load (local.get $p)) (i32.const 343))
          (then (return (i32.const 0))))
        (local.set $tbl (i32.and (i32.load offset=4 (local.get $p)) (i32.const 0xF)))
        (local.set $stack_disp (i32.load offset=8 (local.get $p)))
        (local.set $table_stack (i32.const 1))
        (local.set $first (i32.const 1)))
      (else
        (if (i32.ne (local.get $n) (i32.const 9))
          (then (return (i32.const 0))))))

    ;; xor acc,acc
    (local.set $p (call $loop_op_at (local.get $first)))
    (if (i32.ne (i32.load (local.get $p)) (i32.const 18))
      (then (return (i32.const 0))))
    (local.set $op (i32.load offset=4 (local.get $p)))
    (local.set $acc (i32.and (local.get $op) (i32.const 0xF)))
    (if (i32.or
          (i32.gt_u (local.get $acc) (i32.const 3))
          (i32.ne (i32.shr_u (local.get $op) (i32.const 4)) (local.get $acc)))
      (then (return (i32.const 0))))

    ;; mov acc8,[src+disp]
    (local.set $p (call $loop_op_at (i32.add (local.get $first) (i32.const 1))))
    (if (i32.ne (i32.load (local.get $p)) (i32.const 28))
      (then (return (i32.const 0))))
    (local.set $op (i32.load offset=4 (local.get $p)))
    (if (i32.ne (i32.shr_u (local.get $op) (i32.const 4)) (local.get $acc))
      (then (return (i32.const 0))))
    (local.set $src (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $src_disp (i32.load offset=8 (local.get $p)))

    ;; add/sub dst,2. The store is after this instruction, so fold the bump
    ;; into its descriptor displacement below.
    (local.set $p (call $loop_op_at (i32.add (local.get $first) (i32.const 2))))
    (if (i32.and
          (i32.ne (i32.load (local.get $p)) (i32.const 3))
          (i32.ne (i32.load (local.get $p)) (i32.const 8)))
      (then (return (i32.const 0))))
    (if (i32.ne (i32.load offset=8 (local.get $p)) (i32.const 2))
      (then (return (i32.const 0))))
    (local.set $dst (i32.and (i32.load offset=4 (local.get $p)) (i32.const 0xF)))
    (local.set $dst_stride
      (select (i32.const 2) (i32.const -2)
        (i32.eq (i32.load (local.get $p)) (i32.const 3))))

    ;; inc src / dec count
    (local.set $p (call $loop_op_at (i32.add (local.get $first) (i32.const 3))))
    (if (i32.or
          (i32.ne (i32.load (local.get $p)) (i32.const 64))
          (i32.ne (i32.and (i32.load offset=4 (local.get $p)) (i32.const 0xF))
                  (local.get $src)))
      (then (return (i32.const 0))))
    (local.set $p (call $loop_op_at (i32.add (local.get $first) (i32.const 4))))
    (if (i32.ne (i32.load (local.get $p)) (i32.const 65))
      (then (return (i32.const 0))))
    (local.set $ctr (i32.and (i32.load offset=4 (local.get $p)) (i32.const 0xF)))

    ;; H149 computes table+acc*2+disp, and H164 consumes its SIB_SENTINEL as
    ;; a word load into acc.
    (local.set $p (call $loop_op_at (i32.add (local.get $first) (i32.const 5))))
    (if (i32.or
          (i32.ne (i32.load (local.get $p)) (i32.const 149))
          (i32.ne (i32.load offset=4 (local.get $p)) (i32.const 0)))
      (then (return (i32.const 0))))
    (local.set $info (i32.load offset=8 (local.get $p)))
    (local.set $sib_tbl (i32.and (local.get $info) (i32.const 0xF)))
    (if (i32.or
          (i32.eq (local.get $sib_tbl) (i32.const 0xF))
          (i32.or
            (i32.ne
              (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF))
              (local.get $acc))
            (i32.ne
              (i32.and (i32.shr_u (local.get $info) (i32.const 8)) (i32.const 3))
              (i32.const 1))))
      (then (return (i32.const 0))))
    (if (i32.and (local.get $table_stack)
          (i32.ne (local.get $tbl) (local.get $sib_tbl)))
      (then (return (i32.const 0))))
    (local.set $tbl (local.get $sib_tbl))
    (local.set $table_disp (i32.load offset=12 (local.get $p)))
    (local.set $p (call $loop_op_at (i32.add (local.get $first) (i32.const 6))))
    (if (i32.or
          (i32.ne (i32.load (local.get $p)) (i32.const 164))
          (i32.or
            (i32.ne (i32.and (i32.load offset=4 (local.get $p)) (i32.const 0xF))
                    (local.get $acc))
            (i32.ne (i32.load offset=8 (local.get $p)) (global.get $SIB_SENTINEL))))
      (then (return (i32.const 0))))

    ;; mov [dst+disp],acc16 / jnz ^
    (local.set $p (call $loop_op_at (i32.add (local.get $first) (i32.const 7))))
    (if (i32.ne (i32.load (local.get $p)) (i32.const 165))
      (then (return (i32.const 0))))
    (local.set $op (i32.load offset=4 (local.get $p)))
    (if (i32.or
          (i32.ne (i32.shr_u (local.get $op) (i32.const 4)) (local.get $acc))
          (i32.ne (i32.and (local.get $op) (i32.const 0xF)) (local.get $dst)))
      (then (return (i32.const 0))))
    (local.set $dst_disp
      (i32.add (i32.load offset=8 (local.get $p)) (local.get $dst_stride)))
    (local.set $p (call $loop_op_at (i32.add (local.get $first) (i32.const 8))))
    (if (i32.ne (i32.load (local.get $p)) (i32.const 312))
      (then (return (i32.const 0))))

    ;; All architectural roles are distinct in the observed family. Requiring
    ;; that property makes publishing registers once at exit order-equivalent.
    (if (i32.eq (local.get $acc) (local.get $src)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $acc) (local.get $dst)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $acc) (local.get $ctr)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $acc) (local.get $tbl)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $src) (local.get $dst)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $src) (local.get $ctr)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $src) (local.get $tbl)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $dst) (local.get $ctr)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $dst) (local.get $tbl)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $ctr) (local.get $tbl)) (then (return (i32.const 0))))

    (global.set $loop_matched_blocks
      (i32.add (global.get $loop_matched_blocks) (i32.const 1)))
    (global.set $loop_lut16_matches
      (i32.add (global.get $loop_lut16_matches) (i32.const 1)))
    (if (global.get $loop_trace)
      (then
        (call $host_log_i32 (i32.const 0x100B0001))
        (call $host_log_i32 (local.get $start_eip))))
    (if (i32.eqz (global.get $loop_lut_emit_enabled))
      (then (return (i32.const 0))))
    (if (i32.and (local.get $table_stack)
          (i32.eqz (global.get $loop_lut16_stack_emit_enabled)))
      (then (return (i32.const 0))))

    (local.set $fall (i32.load offset=8 (local.get $p)))
    (global.set $thread_alloc (local.get $tstart))
    (global.set $op_index_n (i32.const 0))
    (call $te (global.get $LOOP_SUPEROP_LUT)
      (select (i32.const 6) (i32.const 2) (local.get $table_stack)))
    (call $te_raw (local.get $src))
    (call $te_raw (i32.const 1))
    (call $te_raw (local.get $src_disp))
    (call $te_raw (local.get $dst))
    (call $te_raw (local.get $dst_stride))
    (call $te_raw (local.get $dst_disp))
    (call $te_raw (local.get $tbl))
    (call $te_raw (local.get $acc))
    (call $te_raw (i32.const 1))
    (call $te_raw (i32.const -1))
    (call $te_raw (i32.const 0))
    (call $te_raw (local.get $ctr))
    (call $te_raw (i32.const -1))
    (call $te_raw (i32.const 0)) (call $te_raw (i32.const 0)) (call $te_raw (i32.const 0))
    (call $te_raw (i32.const 0)) (call $te_raw (i32.const 0)) (call $te_raw (i32.const 0))
    (call $te_raw (local.get $fall))
    (call $te_raw (local.get $start_eip))
    (call $te_raw (local.get $n))
    (call $te_raw (local.get $table_disp))
    (if (local.get $table_stack)
      (then (call $te_raw (local.get $stack_disp))))
    (i32.const 1))

  (func $loop_try_lut (param $start_eip i32) (param $tstart i32) (result i32)
    (local $i i32) (local $n i32) (local $p i32) (local $fn i32) (local $op i32)
    (local $role i32)
    (local $iv_reg i32) (local $iv_stride i32) (local $iv_idx i32) (local $iv_cnt i32)
    (local $ctr_reg i32) (local $ctr_step i32) (local $ctr_idx i32) (local $ctr_cnt i32)
    (local $acc_reg i32) (local $zero_cnt i32)
    (local $ld_reg i32) (local $ld_base i32) (local $ld_disp i32) (local $ld_idx i32) (local $ld_cnt i32)
    (local $ald_reg i32) (local $ald_base i32) (local $ald_disp i32) (local $ald_idx i32)
    (local $tbl_reg i32) (local $lut_cnt i32) (local $lut_idx i32)
    (local $st_reg i32) (local $st_base i32) (local $st_disp i32) (local $st_idx i32) (local $st_cnt i32)
    (local $m0_addr i32) (local $m0_reg i32) (local $m0_idx i32)
    (local $m1_addr i32) (local $m1_reg i32) (local $m1_idx i32)
    (local $mir_cnt i32) (local $written i32) (local $info i32) (local $b i32) (local $x i32)
    (local $fall i32) (local $abs_table i32) (local $abs_lut i32)

    (local.set $n (global.get $op_index_n))
    ;; The shape needs at least zero/iv/load/lut/store/ctr/jcc.
    (if (i32.lt_u (local.get $n) (i32.const 7)) (then (return (i32.const 0))))
    (if (i32.gt_u (local.get $n) (i32.const 16)) (then (return (i32.const 0))))
    (local.set $iv_reg (i32.const -1))
    (local.set $ctr_reg (i32.const -1))
    (local.set $acc_reg (i32.const -1))
    (local.set $tbl_reg (i32.const -1))

    ;; ---- pass 1: roles, and the set of registers the body writes ----
    (local.set $i (i32.const 0))
    (block $p1_done
      (loop $p1
        (br_if $p1_done (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $p (call $loop_op_at (local.get $i)))
        (local.set $fn (i32.load (local.get $p)))
        (local.set $op (i32.load offset=4 (local.get $p)))
        (local.set $role (call $loop_role (local.get $fn) (local.get $op)))
        (if (i32.eq (local.get $role) (global.get $LR_UNKNOWN))
          (then (return (i32.const 0))))
        ;; MEMCTR is a role for COPY_RUN's sake, not this one. LUT_RUN models
        ;; no memory-resident counter, and its counting gates below would not
        ;; notice one -- so a block carrying it would lower to a super-op that
        ;; silently dropped the decrement. Decline explicitly.
        (if (i32.eq (local.get $role) (global.get $LR_MEMCTR))
          (then (return (i32.const 0))))

        (if (i32.eq (local.get $role) (global.get $LR_ADDI))
          (then
            ;; inc (64) / dec (65): operand is the register, step is +1 / -1.
            (local.set $written (i32.or (local.get $written)
              (i32.shl (i32.const 1) (i32.and (local.get $op) (i32.const 0xF)))))
            ;; The first ADDI whose register also appears as a memory base is
            ;; the induction variable; that is decided in pass 2, so record
            ;; both candidates here.
            (if (i32.eqz (local.get $iv_cnt))
              (then
                (local.set $iv_reg (i32.and (local.get $op) (i32.const 0xF)))
                (local.set $iv_stride
                  (select (i32.const 1) (i32.const -1) (i32.eq (local.get $fn) (i32.const 64))))
                (local.set $iv_idx (local.get $i))
                (local.set $iv_cnt (i32.const 1)))
              (else
                (if (i32.ne (local.get $ctr_cnt) (i32.const 0)) (then (return (i32.const 0))))
                (local.set $ctr_reg (i32.and (local.get $op) (i32.const 0xF)))
                (local.set $ctr_step
                  (select (i32.const 1) (i32.const -1) (i32.eq (local.get $fn) (i32.const 64))))
                (local.set $ctr_idx (local.get $i))
                (local.set $ctr_cnt (i32.const 1))))))

        (if (i32.eq (local.get $role) (global.get $LR_ZERO))
          (then
            (local.set $zero_cnt (i32.add (local.get $zero_cnt) (i32.const 1)))
            (local.set $acc_reg (i32.and (local.get $op) (i32.const 0xF)))
            (local.set $written (i32.or (local.get $written)
              (i32.shl (i32.const 1) (local.get $acc_reg))))))

        (if (i32.eq (local.get $role) (global.get $LR_LOAD8))
          (then
            (if (i32.eqz (local.get $ld_cnt))
              (then
                (local.set $ld_base (i32.and (local.get $op) (i32.const 0xF)))
                (local.set $ld_reg (i32.shr_u (local.get $op) (i32.const 4)))
                (local.set $ld_disp (i32.load offset=8 (local.get $p)))
                (local.set $ld_idx (local.get $i)))
              (else
                (if (i32.ne (local.get $ld_cnt) (i32.const 1))
                  (then (return (i32.const 0))))
                (local.set $ald_base (i32.and (local.get $op) (i32.const 0xF)))
                (local.set $ald_reg (i32.shr_u (local.get $op) (i32.const 4)))
                (local.set $ald_disp (i32.load offset=8 (local.get $p)))
                (local.set $ald_idx (local.get $i))))
            (local.set $ld_cnt (i32.add (local.get $ld_cnt) (i32.const 1)))
            ;; A byte load writes only the low 8 bits, but the accumulator is
            ;; required to have been zeroed in-block, so the whole register is
            ;; defined here.
            (local.set $written (i32.or (local.get $written)
              (i32.shl (i32.const 1) (local.get $ld_reg))))))

        (if (i32.eq (local.get $role) (global.get $LR_LOAD8S))
          (then
            (local.set $lut_cnt (i32.add (local.get $lut_cnt) (i32.const 1)))
            (local.set $lut_idx (local.get $i))
            (local.set $info (i32.load offset=8 (local.get $p)))
            ;; A LUT lookup indexes a table with the byte just loaded: scale 1,
            ;; no displacement, one operand the accumulator and the other a
            ;; register the body never writes.
            (if (i32.ne (i32.load offset=12 (local.get $p)) (i32.const 0))
              (then (return (i32.const 0))))
            (if (i32.ne (i32.and (i32.shr_u (local.get $info) (i32.const 8)) (i32.const 3))
                        (i32.const 0))
              (then (return (i32.const 0))))
            (local.set $b (i32.and (local.get $info) (i32.const 0xF)))
            (local.set $x (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF)))
            (if (i32.or (i32.eq (local.get $b) (i32.const 0xF))
                        (i32.eq (local.get $x) (i32.const 0xF)))
              (then (return (i32.const 0))))
            ;; destination byte register, from the fused-consumer operand
            (local.set $written (i32.or (local.get $written)
              (i32.shl (i32.const 1) (i32.and (local.get $op) (i32.const 7)))))))

        (if (i32.eq (local.get $role) (global.get $LR_STORE8))
          (then
            (local.set $st_cnt (i32.add (local.get $st_cnt) (i32.const 1)))
            (local.set $st_base (i32.and (local.get $op) (i32.const 0xF)))
            (local.set $st_reg (i32.shr_u (local.get $op) (i32.const 4)))
            (local.set $st_disp (i32.load offset=8 (local.get $p)))
            (local.set $st_idx (local.get $i))))

        (if (i32.eq (local.get $role) (global.get $LR_MIRROR))
          (then
            (if (i32.eqz (local.get $mir_cnt))
              (then
                (local.set $m0_addr (i32.load offset=8 (local.get $p)))
                (local.set $m0_reg (local.get $op))
                (local.set $m0_idx (local.get $i)))
              (else
                (if (i32.ge_u (local.get $mir_cnt) (i32.const 2)) (then (return (i32.const 0))))
                (local.set $m1_addr (i32.load offset=8 (local.get $p)))
                (local.set $m1_reg (local.get $op))
                (local.set $m1_idx (local.get $i))))
            (local.set $mir_cnt (i32.add (local.get $mir_cnt) (i32.const 1)))))

        ;; Only the final op may be the branch.
        (if (i32.eq (local.get $role) (global.get $LR_JCC))
          (then
            (if (i32.ne (local.get $i) (i32.sub (local.get $n) (i32.const 1)))
              (then (return (i32.const 0))))))

        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $p1)))

    ;; ---- pass 2: the predicate ----
    (if (i32.ne (local.get $iv_cnt) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $ctr_cnt) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $zero_cnt) (i32.const 1)) (then (return (i32.const 0))))
    ;; Most loops decode the table read as fused SIB LOAD8S. Jazz's hottest
    ;; palette loop uses `mov dl,[edx+absolute]`, whose simple-base decoder form
    ;; is a second LOAD8. Prove that exact dataflow and feed it to the same H418
    ;; executor with an absolute table descriptor.
    (if (i32.and (i32.eq (local.get $ld_cnt) (i32.const 2))
                  (i32.eqz (local.get $lut_cnt)))
      (then
        (if (i32.and (i32.eq (local.get $ld_base) (local.get $iv_reg))
                      (i32.eq (local.get $ald_base) (local.get $acc_reg)))
          (then
            (if (i32.ne (local.get $ald_reg) (local.get $acc_reg))
              (then (return (i32.const 0))))
            (local.set $lut_idx (local.get $ald_idx))
            (local.set $abs_table (local.get $ald_disp)))
          (else
            (if (i32.and (i32.eq (local.get $ald_base) (local.get $iv_reg))
                          (i32.eq (local.get $ld_base) (local.get $acc_reg)))
              (then
                (if (i32.ne (local.get $ld_reg) (local.get $acc_reg))
                  (then (return (i32.const 0))))
                (local.set $lut_idx (local.get $ld_idx))
                (local.set $abs_table (local.get $ld_disp))
                (local.set $ld_reg (local.get $ald_reg))
                (local.set $ld_base (local.get $ald_base))
                (local.set $ld_disp (local.get $ald_disp))
                (local.set $ld_idx (local.get $ald_idx)))
              (else (return (i32.const 0))))))
        (local.set $abs_lut (i32.const 1)))
      (else
        (if (i32.ne (local.get $ld_cnt) (i32.const 1))
          (then (return (i32.const 0))))
        (if (i32.ne (local.get $lut_cnt) (i32.const 1))
          (then (return (i32.const 0))))))
    (if (i32.ne (local.get $st_cnt) (i32.const 1)) (then (return (i32.const 0))))

    ;; The counter must be the register the exit test reads, and must not be
    ;; the cursor. We only accept the JNZ form: exit when the counter hits 0.
    (local.set $p (call $loop_op_at (i32.sub (local.get $n) (i32.const 1))))
    (if (i32.ne (i32.load (local.get $p)) (i32.const 312)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $ctr_reg) (local.get $iv_reg)) (then (return (i32.const 0))))
    ;; The counter must be the last flag-setting op before the branch, or the
    ;; condition is not the one we are modelling.
    (if (i32.ne (local.get $ctr_idx) (i32.sub (local.get $n) (i32.const 2)))
      (then
        ;; Tolerate mirror stores between the counter and the branch: a store
        ;; to an absolute address does not touch flags.
        (local.set $i (i32.add (local.get $ctr_idx) (i32.const 1)))
        (block $tail_ok
          (loop $tail
            (br_if $tail_ok (i32.ge_u (local.get $i) (i32.sub (local.get $n) (i32.const 1))))
            (local.set $x (call $loop_op_at (local.get $i)))
            (if (i32.ne (call $loop_role (i32.load (local.get $x))
                          (i32.load offset=4 (local.get $x)))
                        (global.get $LR_MIRROR))
              (then
                ;; A byte load or store leaves flags alone too.
                (if (i32.eqz (i32.or
                      (i32.eq (call $loop_role (i32.load (local.get $x))
                                (i32.load offset=4 (local.get $x)))
                              (global.get $LR_STORE8))
                      (i32.or
                        (i32.eq (call $loop_role (i32.load (local.get $x))
                                  (i32.load offset=4 (local.get $x)))
                                (global.get $LR_LOAD8))
                        (i32.eq (call $loop_role (i32.load (local.get $x))
                                  (i32.load offset=4 (local.get $x)))
                                (global.get $LR_LOAD8S)))))
                  (then (return (i32.const 0))))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $tail)))))

    ;; Source and destination must both stream off the cursor.
    (if (i32.ne (local.get $ld_base) (local.get $iv_reg)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $st_base) (local.get $iv_reg)) (then (return (i32.const 0))))
    ;; The accumulator is zeroed, loaded from the source, used as the table
    ;; index and stored to the destination -- one register throughout.
    (if (i32.ne (local.get $ld_reg) (local.get $acc_reg)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $st_reg) (local.get $acc_reg)) (then (return (i32.const 0))))
    ;; Byte-register indices above 3 name AH/CH/DH/BH, which are not the low
    ;; byte of the register the xor zeroed. Decline rather than model them.
    (if (i32.gt_u (local.get $acc_reg) (i32.const 3)) (then (return (i32.const 0))))
    ;; The universal executor publishes the accumulator, cursors and terminator
    ;; once at the block boundary. Aliasing those architectural roles would make
    ;; their original per-instruction write order observable, so decline it.
    (if (i32.or (i32.eq (local.get $acc_reg) (local.get $iv_reg))
                (i32.eq (local.get $acc_reg) (local.get $ctr_reg)))
      (then (return (i32.const 0))))
    (if (i32.eqz (local.get $abs_lut))
      (then
        ;; The fused SIB load's destination is its own operand's low 3 bits.
        (local.set $p (call $loop_op_at (local.get $ld_idx)))
        (local.set $i (i32.const 0))
        (block $find_lut_done
          (loop $find_lut
            (br_if $find_lut_done (i32.ge_u (local.get $i) (local.get $n)))
            (local.set $x (call $loop_op_at (local.get $i)))
            (if (i32.eq (call $loop_role (i32.load (local.get $x)) (i32.load offset=4 (local.get $x)))
                        (global.get $LR_LOAD8S))
              (then
                (if (i32.ne (i32.and (i32.load offset=4 (local.get $x)) (i32.const 7))
                            (local.get $acc_reg))
                  (then (return (i32.const 0))))
                (local.set $info (i32.load offset=8 (local.get $x)))
                (local.set $b (i32.and (local.get $info) (i32.const 0xF)))
                (local.set $x (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF)))
                (if (i32.eq (local.get $b) (local.get $acc_reg))
                  (then (local.set $tbl_reg (local.get $x)))
                  (else
                    (if (i32.ne (local.get $x) (local.get $acc_reg)) (then (return (i32.const 0))))
                    (local.set $tbl_reg (local.get $b))))
                (br $find_lut_done)))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $find_lut)))
        (if (i32.lt_s (local.get $tbl_reg) (i32.const 0)) (then (return (i32.const 0))))
        ;; The table base has to be loop-invariant, or it is not a table.
        (if (i32.and (local.get $written)
              (i32.shl (i32.const 1) (local.get $tbl_reg)))
          (then (return (i32.const 0))))))

    ;; The source byte must be read before it is used as an index, and the
    ;; result stored after. Anything else is a different loop.
    (if (i32.ge_u (local.get $ld_idx) (local.get $lut_idx)) (then (return (i32.const 0))))
    (if (i32.ge_u (local.get $lut_idx) (local.get $st_idx)) (then (return (i32.const 0))))

    ;; The universal executor bumps cursors after each access. An access the
    ;; original performed after its bump therefore needs one stride folded into
    ;; its displacement; an access before the bump already agrees.
    (if (i32.lt_u (local.get $iv_idx) (local.get $ld_idx))
      (then (local.set $ld_disp (i32.add (local.get $ld_disp) (local.get $iv_stride)))))
    (if (i32.lt_u (local.get $iv_idx) (local.get $st_idx))
      (then (local.set $st_disp (i32.add (local.get $st_disp) (local.get $iv_stride)))))

    ;; A mirror whose register the body writes, other than the cursor, would
    ;; need its own per-iteration value; decline instead of guessing.
    (if (i32.ne (local.get $m0_addr) (i32.const 0))
      (then
        (if (i32.and (i32.and (local.get $written)
                       (i32.shl (i32.const 1) (local.get $m0_reg)))
                     (i32.ne (local.get $m0_reg) (local.get $iv_reg)))
          (then (return (i32.const 0))))))
    (if (i32.ne (local.get $m1_addr) (i32.const 0))
      (then
        (if (i32.and (i32.and (local.get $written)
                       (i32.shl (i32.const 1) (local.get $m1_reg)))
                     (i32.ne (local.get $m1_reg) (local.get $iv_reg)))
          (then (return (i32.const 0))))))

    ;; ---- emit ----
    (global.set $loop_matched_blocks
      (i32.add (global.get $loop_matched_blocks) (i32.const 1)))
    ;; Which family claimed which block. The block dump alone cannot say: it is
    ;; printed before either predicate runs, so a 387-block trace with 2 matches
    ;; in it names neither. Marker 0x100B0001 = LUT_RUN, then the entry EIP.
    (if (global.get $loop_trace)
      (then
        (call $host_log_i32 (i32.const 0x100B0001))
        (call $host_log_i32 (local.get $start_eip))))
    (if (i32.eqz (global.get $loop_lut_emit_enabled)) (then (return (i32.const 0))))

    (local.set $fall (i32.load offset=8
      (call $loop_op_at (i32.sub (local.get $n) (i32.const 1)))))
    ;; Rewind over the ops just emitted and put the super-op in their place.
    ;; This is the only rewind of $thread_alloc in the decoder, and it happens
    ;; after every emit for this block, so nothing else can be pointing into
    ;; the range being reclaimed. The op index is reset with it.
    (global.set $thread_alloc (local.get $tstart))
    (global.set $op_index_n (i32.const 0))
    (call $te (global.get $LOOP_SUPEROP_LUT)
      (select (i32.const 8) (i32.const 0) (local.get $abs_lut)))
    (call $te_raw (local.get $iv_reg))
    (call $te_raw (local.get $iv_stride))
    (call $te_raw (local.get $ld_disp))
    (call $te_raw (local.get $iv_reg))
    (call $te_raw (local.get $iv_stride))
    (call $te_raw (local.get $st_disp))
    (call $te_raw (select (local.get $abs_table) (local.get $tbl_reg)
      (local.get $abs_lut)))
    (call $te_raw (local.get $acc_reg))
    (call $te_raw (i32.const 0))
    (call $te_raw (i32.const -1))
    (call $te_raw (i32.const 0))
    (call $te_raw (local.get $ctr_reg))
    (call $te_raw (local.get $ctr_step))
    (call $te_raw (local.get $m0_addr))
    (call $te_raw (local.get $m0_reg))
    ;; A spill of the cursor itself records whatever the cursor held at that
    ;; point in the body; the super-op writes it once, at exit, from the final
    ;; value, so a spill that ran before the bump is one stride behind.
    (call $te_raw (select (i32.sub (i32.const 0) (local.get $iv_stride)) (i32.const 0)
      (i32.and (i32.eq (local.get $m0_reg) (local.get $iv_reg))
               (i32.lt_u (local.get $m0_idx) (local.get $iv_idx)))))
    (call $te_raw (local.get $m1_addr))
    (call $te_raw (local.get $m1_reg))
    (call $te_raw (select (i32.sub (i32.const 0) (local.get $iv_stride)) (i32.const 0)
      (i32.and (i32.eq (local.get $m1_reg) (local.get $iv_reg))
               (i32.lt_u (local.get $m1_idx) (local.get $iv_idx)))))
    (call $te_raw (local.get $fall))
    (call $te_raw (local.get $start_eip))
    (call $te_raw (local.get $n))
    (i32.const 1))

  ;; ------------------------------------------------------------------
  ;; Bounded LUT_RUN
  ;; ------------------------------------------------------------------
  ;; Recognizes the role-equivalent forms used by Diablo II's software pixel
  ;; paths. The simple form is dst[i] = table[src[i]]; the row-table form adds
  ;; an optional `(byte << shift) + invariant_reg` index transform. Both end in
  ;; CMP source_cursor,bound / JB back. This is deliberately a separate proof
  ;; from the counted Heroes form above, but both emit the same descriptor and
  ;; execute in handler 418.
  (func $loop_try_lut_bounded (param $start_eip i32) (param $tstart i32) (result i32)
    (local $i i32) (local $n i32) (local $p i32) (local $fn i32) (local $op i32)
    (local $role i32) (local $written i32) (local $fall i32)
    (local $acc_reg i32) (local $zero_cnt i32) (local $zero_idx i32)
    (local $ld_reg i32) (local $ld_base i32) (local $ld_disp i32)
    (local $ld_cnt i32) (local $ld_idx i32)
    (local $st_reg i32) (local $st_base i32) (local $st_disp i32)
    (local $st_cnt i32) (local $st_idx i32)
    (local $lut_cnt i32) (local $lut_idx i32) (local $lut_info i32)
    (local $tbl_reg i32) (local $b i32) (local $x i32)
    (local $shift_cnt i32) (local $shift_idx i32) (local $shift_op i32)
    (local $index_shift i32)
    (local $add_cnt i32) (local $add_idx i32) (local $add_op i32)
    (local $add_reg i32)
    (local $cmp_cnt i32) (local $cmp_idx i32) (local $cmp_left i32) (local $bound_reg i32)
    (local $addi_cnt i32) (local $addi_last_idx i32)
    (local $src_inc_cnt i32) (local $src_inc_idx i32)
    (local $dst_inc_cnt i32) (local $dst_inc_idx i32)

    (local.set $n (global.get $op_index_n))
    ;; zero/load/[shift/add]/increments/cmp/lut/store/jb: eight to ten ops in
    ;; the two observed families. A larger body is computing something else.
    (if (i32.lt_u (local.get $n) (i32.const 8)) (then (return (i32.const 0))))
    (if (i32.gt_u (local.get $n) (i32.const 10)) (then (return (i32.const 0))))
    (local.set $acc_reg (i32.const -1))
    (local.set $tbl_reg (i32.const -1))
    (local.set $add_reg (i32.const -1))

    ;; Pass 1 records exact semantic roles. Unknown or extra work declines the
    ;; whole block; no instruction is silently dropped by the lowering.
    (local.set $i (i32.const 0))
    (block $p1_done
      (loop $p1
        (br_if $p1_done (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $p (call $loop_op_at (local.get $i)))
        (local.set $fn (i32.load (local.get $p)))
        (local.set $op (i32.load offset=4 (local.get $p)))
        (local.set $role (call $loop_role (local.get $fn) (local.get $op)))

        (if (i32.eq (local.get $role) (global.get $LR_ZERO))
          (then
            (local.set $zero_cnt (i32.add (local.get $zero_cnt) (i32.const 1)))
            (local.set $zero_idx (local.get $i))
            (local.set $acc_reg (i32.and (local.get $op) (i32.const 0xF)))
            (local.set $written (i32.or (local.get $written)
              (i32.shl (i32.const 1) (local.get $acc_reg))))))
        (if (i32.eq (local.get $role) (global.get $LR_LOAD8))
          (then
            (local.set $ld_cnt (i32.add (local.get $ld_cnt) (i32.const 1)))
            (local.set $ld_idx (local.get $i))
            (local.set $ld_base (i32.and (local.get $op) (i32.const 0xF)))
            (local.set $ld_reg (i32.shr_u (local.get $op) (i32.const 4)))
            (local.set $ld_disp (i32.load offset=8 (local.get $p)))
            (local.set $written (i32.or (local.get $written)
              (i32.shl (i32.const 1) (i32.and (local.get $ld_reg) (i32.const 3)))))))
        (if (i32.eq (local.get $role) (global.get $LR_LOAD8S))
          (then
            (local.set $lut_cnt (i32.add (local.get $lut_cnt) (i32.const 1)))
            (local.set $lut_idx (local.get $i))
            (local.set $lut_info (i32.load offset=8 (local.get $p)))
            (if (i32.ne (i32.load offset=12 (local.get $p)) (i32.const 0))
              (then (return (i32.const 0))))
            (local.set $written (i32.or (local.get $written)
              (i32.shl (i32.const 1) (i32.and (local.get $op) (i32.const 7)))))))
        (if (i32.eq (local.get $role) (global.get $LR_STORE8))
          (then
            (local.set $st_cnt (i32.add (local.get $st_cnt) (i32.const 1)))
            (local.set $st_idx (local.get $i))
            (local.set $st_base (i32.and (local.get $op) (i32.const 0xF)))
            (local.set $st_reg (i32.shr_u (local.get $op) (i32.const 4)))
            (local.set $st_disp (i32.load offset=8 (local.get $p)))))
        (if (i32.eq (local.get $role) (global.get $LR_ADDI))
          (then
            ;; Bounded streams are forward byte walks only.
            (if (i32.ne (local.get $fn) (i32.const 64)) (then (return (i32.const 0))))
            (local.set $addi_cnt (i32.add (local.get $addi_cnt) (i32.const 1)))
            (local.set $addi_last_idx (local.get $i))
            (local.set $written (i32.or (local.get $written)
              (i32.shl (i32.const 1) (i32.and (local.get $op) (i32.const 0xF)))))))
        (if (i32.eq (local.get $role) (global.get $LR_SHIFT))
          (then
            (local.set $shift_cnt (i32.add (local.get $shift_cnt) (i32.const 1)))
            (local.set $shift_idx (local.get $i))
            (local.set $shift_op (local.get $op))
            (local.set $written (i32.or (local.get $written)
              (i32.shl (i32.const 1) (i32.and (local.get $op) (i32.const 0xFF)))))))
        (if (i32.eq (local.get $role) (global.get $LR_ADD))
          (then
            (local.set $add_cnt (i32.add (local.get $add_cnt) (i32.const 1)))
            (local.set $add_idx (local.get $i))
            (local.set $add_op (local.get $op))
            (local.set $written (i32.or (local.get $written)
              (i32.shl (i32.const 1) (i32.shr_u (local.get $op) (i32.const 4)))))))
        (if (i32.eq (local.get $role) (global.get $LR_CMP))
          (then
            (local.set $cmp_cnt (i32.add (local.get $cmp_cnt) (i32.const 1)))
            (local.set $cmp_idx (local.get $i))
            (local.set $cmp_left (i32.shr_u (local.get $op) (i32.const 4)))
            (local.set $bound_reg (i32.and (local.get $op) (i32.const 0xF)))))
        (if (i32.eq (local.get $role) (global.get $LR_JCC))
          (then
            (if (i32.ne (local.get $i) (i32.sub (local.get $n) (i32.const 1)))
              (then (return (i32.const 0))))
            ;; JB/JC/JNAE is handler 309. No signed or equality variant is an
            ;; interchangeable bound check.
            (if (i32.ne (local.get $fn) (i32.const 309))
              (then (return (i32.const 0))))))
        (if (i32.or
              (i32.eq (local.get $role) (global.get $LR_UNKNOWN))
              (i32.or (i32.eq (local.get $role) (global.get $LR_MIRROR))
                      (i32.eq (local.get $role) (global.get $LR_MEMCTR))))
          (then (return (i32.const 0))))

        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $p1)))

    (if (i32.ne (local.get $zero_cnt) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $ld_cnt) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $lut_cnt) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $st_cnt) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $cmp_cnt) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.gt_u (local.get $shift_cnt) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.gt_u (local.get $add_cnt) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.gt_u (local.get $acc_reg) (i32.const 3)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $ld_reg) (local.get $acc_reg)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $st_reg) (local.get $acc_reg)) (then (return (i32.const 0))))

    ;; Zero -> source byte -> optional shift/add -> table byte -> destination.
    (if (i32.ge_u (local.get $zero_idx) (local.get $ld_idx)) (then (return (i32.const 0))))
    (if (i32.ge_u (local.get $ld_idx) (local.get $lut_idx)) (then (return (i32.const 0))))
    (if (i32.ge_u (local.get $lut_idx) (local.get $st_idx)) (then (return (i32.const 0))))
    (if (local.get $shift_cnt)
      (then
        (if (i32.or (i32.le_u (local.get $shift_idx) (local.get $ld_idx))
                    (i32.ge_u (local.get $shift_idx) (local.get $lut_idx)))
          (then (return (i32.const 0))))
        (if (i32.ne (i32.and (local.get $shift_op) (i32.const 0xFF)) (local.get $acc_reg))
          (then (return (i32.const 0))))
        (if (i32.eqz (i32.or
              (i32.eq (i32.and (i32.shr_u (local.get $shift_op) (i32.const 8)) (i32.const 0xFF)) (i32.const 4))
              (i32.eq (i32.and (i32.shr_u (local.get $shift_op) (i32.const 8)) (i32.const 0xFF)) (i32.const 6))))
          (then (return (i32.const 0))))
        (local.set $index_shift
          (i32.and (i32.shr_u (local.get $shift_op) (i32.const 16)) (i32.const 0xFF)))
        (if (i32.ne (local.get $index_shift) (i32.const 8))
          (then (return (i32.const 0))))))
    (if (local.get $add_cnt)
      (then
        (if (i32.or (i32.le_u (local.get $add_idx) (local.get $ld_idx))
                    (i32.ge_u (local.get $add_idx) (local.get $lut_idx)))
          (then (return (i32.const 0))))
        (if (i32.ne (i32.shr_u (local.get $add_op) (i32.const 4)) (local.get $acc_reg))
          (then (return (i32.const 0))))
        (local.set $add_reg (i32.and (local.get $add_op) (i32.const 0xF)))
        (if (i32.and (local.get $shift_cnt)
              (i32.le_u (local.get $add_idx) (local.get $shift_idx)))
          (then (return (i32.const 0))))))

    ;; The fused SIB lookup must be exactly [table + accumulator], scale 1,
    ;; displacement zero, and write the same low-byte accumulator.
    (local.set $p (call $loop_op_at (local.get $lut_idx)))
    (if (i32.ne (i32.and (i32.load offset=4 (local.get $p)) (i32.const 7))
                (local.get $acc_reg))
      (then (return (i32.const 0))))
    (if (i32.ne (i32.and (i32.shr_u (local.get $lut_info) (i32.const 8)) (i32.const 3))
                (i32.const 0))
      (then (return (i32.const 0))))
    (local.set $b (i32.and (local.get $lut_info) (i32.const 0xF)))
    (local.set $x (i32.and (i32.shr_u (local.get $lut_info) (i32.const 4)) (i32.const 0xF)))
    (if (i32.eq (local.get $b) (local.get $acc_reg))
      (then (local.set $tbl_reg (local.get $x)))
      (else
        (if (i32.ne (local.get $x) (local.get $acc_reg)) (then (return (i32.const 0))))
        (local.set $tbl_reg (local.get $b))))
    (if (i32.or (i32.eq (local.get $tbl_reg) (i32.const 0xF))
                (i32.lt_s (local.get $tbl_reg) (i32.const 0)))
      (then (return (i32.const 0))))

    ;; Sort the one or two INC ops by the memory-base roles.
    (local.set $i (i32.const 0))
    (block $incs_done
      (loop $incs
        (br_if $incs_done (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $p (call $loop_op_at (local.get $i)))
        (if (i32.eq (call $loop_role (i32.load (local.get $p)) (i32.load offset=4 (local.get $p)))
                    (global.get $LR_ADDI))
          (then
            (local.set $x (i32.and (i32.load offset=4 (local.get $p)) (i32.const 0xF)))
            (if (i32.eq (local.get $x) (local.get $ld_base))
              (then
                (local.set $src_inc_cnt (i32.add (local.get $src_inc_cnt) (i32.const 1)))
                (local.set $src_inc_idx (local.get $i))))
            (if (i32.eq (local.get $x) (local.get $st_base))
              (then
                (local.set $dst_inc_cnt (i32.add (local.get $dst_inc_cnt) (i32.const 1)))
                (local.set $dst_inc_idx (local.get $i))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $incs)))
    (if (i32.ne (local.get $src_inc_cnt) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $dst_inc_cnt) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $addi_cnt)
          (select (i32.const 1) (i32.const 2)
            (i32.eq (local.get $ld_base) (local.get $st_base))))
      (then (return (i32.const 0))))

    ;; CMP source,bound must be the final flag writer and JB must be the final
    ;; op. Bound/table/row are invariant; accumulator/cursors/terminator do not
    ;; alias, so publishing them once at exit preserves architectural state.
    (if (i32.ne (local.get $cmp_left) (local.get $ld_base)) (then (return (i32.const 0))))
    (if (i32.or (i32.le_u (local.get $cmp_idx) (local.get $zero_idx))
                (i32.le_u (local.get $cmp_idx) (local.get $addi_last_idx)))
      (then (return (i32.const 0))))
    (if (i32.and (local.get $shift_cnt) (i32.le_u (local.get $cmp_idx) (local.get $shift_idx)))
      (then (return (i32.const 0))))
    (if (i32.and (local.get $add_cnt) (i32.le_u (local.get $cmp_idx) (local.get $add_idx)))
      (then (return (i32.const 0))))
    (if (i32.or (i32.eq (local.get $acc_reg) (local.get $ld_base))
          (i32.or (i32.eq (local.get $acc_reg) (local.get $st_base))
                  (i32.eq (local.get $acc_reg) (local.get $bound_reg))))
      (then (return (i32.const 0))))
    (if (i32.and (local.get $written) (i32.shl (i32.const 1) (local.get $bound_reg)))
      (then (return (i32.const 0))))
    (if (i32.and (local.get $written) (i32.shl (i32.const 1) (local.get $tbl_reg)))
      (then (return (i32.const 0))))
    (if (i32.and (i32.ge_s (local.get $add_reg) (i32.const 0))
          (i32.and (local.get $written) (i32.shl (i32.const 1) (local.get $add_reg))))
      (then (return (i32.const 0))))

    ;; Convert original pre-access increments to the executor's post-access
    ;; cursor convention.
    (if (i32.lt_u (local.get $src_inc_idx) (local.get $ld_idx))
      (then (local.set $ld_disp (i32.add (local.get $ld_disp) (i32.const 1)))))
    (if (i32.lt_u (local.get $dst_inc_idx) (local.get $st_idx))
      (then (local.set $st_disp (i32.add (local.get $st_disp) (i32.const 1)))))

    (global.set $loop_matched_blocks
      (i32.add (global.get $loop_matched_blocks) (i32.const 1)))
    (global.set $loop_lut_bounded_matches
      (i32.add (global.get $loop_lut_bounded_matches) (i32.const 1)))
    (if (global.get $loop_trace)
      (then
        (call $host_log_i32 (i32.const 0x100B0003))
        (call $host_log_i32 (local.get $start_eip))))
    (if (i32.eqz (global.get $loop_lut_emit_enabled)) (then (return (i32.const 0))))

    (local.set $fall (i32.load offset=8
      (call $loop_op_at (i32.sub (local.get $n) (i32.const 1)))))
    (global.set $thread_alloc (local.get $tstart))
    (global.set $op_index_n (i32.const 0))
    (call $te (global.get $LOOP_SUPEROP_LUT) (i32.const 0))
    (call $te_raw (local.get $ld_base))
    (call $te_raw (i32.const 1))
    (call $te_raw (local.get $ld_disp))
    (call $te_raw (local.get $st_base))
    (call $te_raw (i32.const 1))
    (call $te_raw (local.get $st_disp))
    (call $te_raw (local.get $tbl_reg))
    (call $te_raw (local.get $acc_reg))
    (call $te_raw (local.get $index_shift))
    (call $te_raw (local.get $add_reg))
    (call $te_raw (i32.const 1))
    (call $te_raw (local.get $bound_reg))
    (call $te_raw (i32.const 0))
    (call $te_raw (i32.const 0))
    (call $te_raw (i32.const 0))
    (call $te_raw (i32.const 0))
    (call $te_raw (i32.const 0))
    (call $te_raw (i32.const 0))
    (call $te_raw (i32.const 0))
    (call $te_raw (local.get $fall))
    (call $te_raw (local.get $start_eip))
    (call $te_raw (local.get $n))
    (i32.const 1))

  ;; ------------------------------------------------------------------
  ;; Two-moving-source bounded LUT_RUN
  ;; ------------------------------------------------------------------
  ;; d2gfx's remaining blend loop builds a 16-bit index from two advancing
  ;; byte streams and stops on the second cursor:
  ;;
  ;;   xor acc,acc / xor aux,aux
  ;;   mov acc8,[src1] / mov aux8,[src2] / shl acc,8
  ;;   inc dst / inc src2 / mov acc8,[acc+aux+table]
  ;;   inc src1 / mov [dst-1],acc8 / cmp src2,bound / jb ^
  ;;
  ;; Recognition is intentionally separate from the one-source proof above,
  ;; while execution stays in universal H418 through descriptor version 1.
  ;; The role order is exact because every ordering point is architecturally
  ;; meaningful here; registers and displacements remain parameters.
  (func $loop_try_lut_blend_bounded
        (param $start_eip i32) (param $tstart i32) (result i32)
    (local $p i32) (local $op i32) (local $info i32) (local $fall i32)
    (local $acc i32) (local $aux i32)
    (local $src1 i32) (local $src1_disp i32) (local $src1_inc i32)
    (local $src2 i32) (local $src2_disp i32) (local $src2_inc i32)
    (local $dst i32) (local $dst_disp i32) (local $dst_inc i32)
    (local $bound i32) (local $table_disp i32)
    (local $r i32) (local $i i32) (local $mask i32) (local $want i32)

    (if (i32.ne (global.get $op_index_n) (i32.const 12))
      (then (return (i32.const 0))))

    ;; Two zeroing instructions establish exact full-register scratch state.
    (local.set $p (call $loop_op_at (i32.const 0)))
    (if (i32.ne (call $loop_role (i32.load (local.get $p))
                  (i32.load offset=4 (local.get $p))) (global.get $LR_ZERO))
      (then (return (i32.const 0))))
    (local.set $acc (i32.and (i32.load offset=4 (local.get $p)) (i32.const 0xF)))
    (local.set $p (call $loop_op_at (i32.const 1)))
    (if (i32.ne (call $loop_role (i32.load (local.get $p))
                  (i32.load offset=4 (local.get $p))) (global.get $LR_ZERO))
      (then (return (i32.const 0))))
    (local.set $aux (i32.and (i32.load offset=4 (local.get $p)) (i32.const 0xF)))
    (if (i32.or (i32.gt_u (local.get $acc) (i32.const 3))
                (i32.or (i32.gt_u (local.get $aux) (i32.const 3))
                        (i32.eq (local.get $acc) (local.get $aux))))
      (then (return (i32.const 0))))

    ;; Primary/high byte source.
    (local.set $p (call $loop_op_at (i32.const 2)))
    (if (i32.ne (call $loop_role (i32.load (local.get $p))
                  (i32.load offset=4 (local.get $p))) (global.get $LR_LOAD8))
      (then (return (i32.const 0))))
    (local.set $op (i32.load offset=4 (local.get $p)))
    (if (i32.ne (i32.and (i32.shr_u (local.get $op) (i32.const 4))
                         (i32.const 0xF)) (local.get $acc))
      (then (return (i32.const 0))))
    (local.set $src1 (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $src1_disp (i32.load offset=8 (local.get $p)))

    ;; Secondary/low byte source.
    (local.set $p (call $loop_op_at (i32.const 3)))
    (if (i32.ne (call $loop_role (i32.load (local.get $p))
                  (i32.load offset=4 (local.get $p))) (global.get $LR_LOAD8))
      (then (return (i32.const 0))))
    (local.set $op (i32.load offset=4 (local.get $p)))
    (if (i32.ne (i32.and (i32.shr_u (local.get $op) (i32.const 4))
                         (i32.const 0xF)) (local.get $aux))
      (then (return (i32.const 0))))
    (local.set $src2 (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $src2_disp (i32.load offset=8 (local.get $p)))

    ;; Exact `shl acc,8`.
    (local.set $p (call $loop_op_at (i32.const 4)))
    (if (i32.ne (call $loop_role (i32.load (local.get $p))
                  (i32.load offset=4 (local.get $p))) (global.get $LR_SHIFT))
      (then (return (i32.const 0))))
    (local.set $op (i32.load offset=4 (local.get $p)))
    (if (i32.ne (i32.and (local.get $op) (i32.const 0xFF)) (local.get $acc))
      (then (return (i32.const 0))))
    (if (i32.eqz (i32.or
          (i32.eq (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xFF))
                  (i32.const 4))
          (i32.eq (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xFF))
                  (i32.const 6))))
      (then (return (i32.const 0))))
    (if (i32.ne (i32.and (i32.shr_u (local.get $op) (i32.const 16))
                         (i32.const 0xFF)) (i32.const 8))
      (then (return (i32.const 0))))

    ;; The lookup writes acc8 and addresses exactly [acc+aux+table_disp].
    (local.set $p (call $loop_op_at (i32.const 7)))
    (if (i32.ne (call $loop_role (i32.load (local.get $p))
                  (i32.load offset=4 (local.get $p))) (global.get $LR_LOAD8S))
      (then (return (i32.const 0))))
    (local.set $op (i32.load offset=4 (local.get $p)))
    (if (i32.ne (i32.and (local.get $op) (i32.const 7)) (local.get $acc))
      (then (return (i32.const 0))))
    (local.set $info (i32.load offset=8 (local.get $p)))
    (if (i32.ne (i32.and (i32.shr_u (local.get $info) (i32.const 8))
                         (i32.const 3)) (i32.const 0))
      (then (return (i32.const 0))))
    (if (i32.eqz (i32.or
          (i32.and
            (i32.eq (i32.and (local.get $info) (i32.const 0xF)) (local.get $acc))
            (i32.eq (i32.and (i32.shr_u (local.get $info) (i32.const 4))
                             (i32.const 0xF)) (local.get $aux)))
          (i32.and
            (i32.eq (i32.and (local.get $info) (i32.const 0xF)) (local.get $aux))
            (i32.eq (i32.and (i32.shr_u (local.get $info) (i32.const 4))
                             (i32.const 0xF)) (local.get $acc)))))
      (then (return (i32.const 0))))
    (local.set $table_disp (i32.load offset=12 (local.get $p)))

    ;; Result store and final unsigned source2 bound check.
    (local.set $p (call $loop_op_at (i32.const 9)))
    (if (i32.ne (call $loop_role (i32.load (local.get $p))
                  (i32.load offset=4 (local.get $p))) (global.get $LR_STORE8))
      (then (return (i32.const 0))))
    (local.set $op (i32.load offset=4 (local.get $p)))
    (if (i32.ne (i32.and (i32.shr_u (local.get $op) (i32.const 4))
                         (i32.const 0xF)) (local.get $acc))
      (then (return (i32.const 0))))
    (local.set $dst (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $dst_disp (i32.load offset=8 (local.get $p)))
    (local.set $p (call $loop_op_at (i32.const 10)))
    (if (i32.ne (call $loop_role (i32.load (local.get $p))
                  (i32.load offset=4 (local.get $p))) (global.get $LR_CMP))
      (then (return (i32.const 0))))
    (local.set $op (i32.load offset=4 (local.get $p)))
    (if (i32.ne (i32.and (i32.shr_u (local.get $op) (i32.const 4))
                         (i32.const 0xF)) (local.get $src2))
      (then (return (i32.const 0))))
    (local.set $bound (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $p (call $loop_op_at (i32.const 11)))
    (if (i32.ne (i32.load (local.get $p)) (i32.const 309))
      (then (return (i32.const 0))))

    ;; Positions 5, 6 and 8 must be one INC for each distinct cursor. Record
    ;; where they occur so a pre-access increment can be folded into its disp.
    (if (i32.or (i32.eq (local.get $src1) (local.get $src2))
          (i32.or (i32.eq (local.get $src1) (local.get $dst))
                  (i32.eq (local.get $src2) (local.get $dst))))
      (then (return (i32.const 0))))
    (local.set $i (i32.const 5))
    (block $incs_done (loop $incs
      (local.set $p (call $loop_op_at (local.get $i)))
      (if (i32.ne (i32.load (local.get $p)) (i32.const 64))
        (then (return (i32.const 0))))
      (local.set $r (i32.and (i32.load offset=4 (local.get $p)) (i32.const 0xF)))
      (local.set $mask (i32.or (local.get $mask)
        (i32.shl (i32.const 1) (local.get $r))))
      (if (i32.eq (local.get $r) (local.get $src1))
        (then (local.set $src1_inc (local.get $i))))
      (if (i32.eq (local.get $r) (local.get $src2))
        (then (local.set $src2_inc (local.get $i))))
      (if (i32.eq (local.get $r) (local.get $dst))
        (then (local.set $dst_inc (local.get $i))))
      (local.set $i (select (i32.const 8) (i32.add (local.get $i) (i32.const 1))
                           (i32.eq (local.get $i) (i32.const 6))))
      (br_if $incs_done (i32.gt_u (local.get $i) (i32.const 8)))
      (br $incs)))
    (local.set $want (i32.or
      (i32.shl (i32.const 1) (local.get $src1))
      (i32.or (i32.shl (i32.const 1) (local.get $src2))
              (i32.shl (i32.const 1) (local.get $dst)))))
    (if (i32.ne (local.get $mask) (local.get $want))
      (then (return (i32.const 0))))

    ;; Scratch, cursors, bound and destination are independent. The executor
    ;; snapshots them all, but no accepted guest instruction aliases these
    ;; roles either, so final register publication is unambiguous.
    (local.set $mask (i32.or
      (i32.shl (i32.const 1) (local.get $src1))
      (i32.or (i32.shl (i32.const 1) (local.get $src2))
        (i32.or (i32.shl (i32.const 1) (local.get $dst))
                (i32.shl (i32.const 1) (local.get $bound))))))
    (if (i32.or
          (i32.and (local.get $mask) (i32.shl (i32.const 1) (local.get $acc)))
          (i32.and (local.get $mask) (i32.shl (i32.const 1) (local.get $aux))))
      (then (return (i32.const 0))))
    (if (i32.or (i32.eq (local.get $bound) (local.get $src1))
          (i32.or (i32.eq (local.get $bound) (local.get $src2))
                  (i32.eq (local.get $bound) (local.get $dst))))
      (then (return (i32.const 0))))

    (if (i32.lt_u (local.get $src1_inc) (i32.const 2))
      (then (local.set $src1_disp (i32.add (local.get $src1_disp) (i32.const 1)))))
    (if (i32.lt_u (local.get $src2_inc) (i32.const 3))
      (then (local.set $src2_disp (i32.add (local.get $src2_disp) (i32.const 1)))))
    (if (i32.lt_u (local.get $dst_inc) (i32.const 9))
      (then (local.set $dst_disp (i32.add (local.get $dst_disp) (i32.const 1)))))

    (global.set $loop_matched_blocks
      (i32.add (global.get $loop_matched_blocks) (i32.const 1)))
    (global.set $loop_lut_bounded_matches
      (i32.add (global.get $loop_lut_bounded_matches) (i32.const 1)))
    (if (global.get $loop_trace)
      (then
        (call $host_log_i32 (i32.const 0x100B0003))
        (call $host_log_i32 (local.get $start_eip))))
    (if (i32.eqz (global.get $loop_lut_emit_enabled))
      (then (return (i32.const 0))))

    (local.set $fall (i32.load offset=8 (call $loop_op_at (i32.const 11))))
    (global.set $thread_alloc (local.get $tstart))
    (global.set $op_index_n (i32.const 0))
    (call $te (global.get $LOOP_SUPEROP_LUT) (i32.const 1))
    (call $te_raw (local.get $src1))
    (call $te_raw (i32.const 1))
    (call $te_raw (local.get $src1_disp))
    (call $te_raw (local.get $dst))
    (call $te_raw (i32.const 1))
    (call $te_raw (local.get $dst_disp))
    (call $te_raw (i32.const -1))
    (call $te_raw (local.get $acc))
    (call $te_raw (i32.const 8))
    (call $te_raw (i32.const -1))
    (call $te_raw (i32.const 1))
    (call $te_raw (local.get $bound))
    (call $te_raw (i32.const 0))
    (call $te_raw (i32.const 0))
    (call $te_raw (i32.const 0))
    (call $te_raw (i32.const 0))
    (call $te_raw (i32.const 0))
    (call $te_raw (i32.const 0))
    (call $te_raw (i32.const 0))
    (call $te_raw (local.get $fall))
    (call $te_raw (local.get $start_eip))
    (call $te_raw (i32.const 12))
    (call $te_raw (local.get $src2))
    (call $te_raw (i32.const 1))
    (call $te_raw (local.get $src2_disp))
    (call $te_raw (local.get $aux))
    (call $te_raw (local.get $table_disp))
    (call $te_raw (i32.const 1))
    (i32.const 1))

  ;; Emit the common H435 stream descriptor. Keeping this mechanical packing
  ;; in one place lets recognizers focus on proving their guest instruction
  ;; order rather than duplicating a 21-word ABI.
  (func $loop_emit_avg
    (param $mode i32) (param $mask i32) (param $round_mask i32)
    (param $a_base i32) (param $a_index i32) (param $a_scale i32)
    (param $a_disp i32) (param $a_step i32)
    (param $b_base i32) (param $b_index i32) (param $b_scale i32)
    (param $b_disp i32) (param $b_step i32)
    (param $d_base i32) (param $d_index i32) (param $d_scale i32)
    (param $d_disp i32) (param $d_step i32)
    (param $ind i32) (param $ind_step i32) (param $term i32) (param $cost i32)
    (call $te (global.get $LOOP_SUPEROP_AVG) (local.get $mode))
    (call $te_raw (local.get $mask))
    (call $te_raw (local.get $round_mask))
    (call $te_raw (local.get $a_base))
    (call $te_raw (local.get $a_index))
    (call $te_raw (local.get $a_scale))
    (call $te_raw (local.get $a_disp))
    (call $te_raw (local.get $a_step))
    (call $te_raw (local.get $b_base))
    (call $te_raw (local.get $b_index))
    (call $te_raw (local.get $b_scale))
    (call $te_raw (local.get $b_disp))
    (call $te_raw (local.get $b_step))
    (call $te_raw (local.get $d_base))
    (call $te_raw (local.get $d_index))
    (call $te_raw (local.get $d_scale))
    (call $te_raw (local.get $d_disp))
    (call $te_raw (local.get $d_step))
    (call $te_raw (local.get $ind))
    (call $te_raw (local.get $ind_step))
    (call $te_raw (local.get $term))
    (call $te_raw (local.get $cost)))

  ;; The carry-wide form seen twice in Abe, generalized over all register
  ;; roles, SIB layouts, displacements and masks:
  ;;
  ;;   mov A,[baseA+index*scale+dispA]
  ;;   mov B,[baseB+index*scale+dispB]
  ;;   and A,mask / and B,mask / add A,B / rcr A,1
  ;;   mov [baseD+index*scale+dispD],A / dec index / jge ^
  (func $loop_try_avg_wide_indexed
    (param $start_eip i32) (param $tstart i32) (result i32)
    (local $p i32) (local $fn i32) (local $branch_op i32)
    (local $a i32) (local $b i32) (local $ind i32)
    (local $a_info i32) (local $b_info i32) (local $d_info i32)
    (local $a_base i32) (local $b_base i32) (local $d_base i32)
    (local $scale i32) (local $mask i32)
    (local $a_disp i32) (local $b_disp i32) (local $d_disp i32)
    (local $fall i32) (local $back i32) (local $regs i32)

    (if (i32.ne (global.get $op_index_n) (i32.const 9))
      (then (return (i32.const 0))))

    (local.set $p (call $loop_op_at (i32.const 0)))
    (if (i32.ne (i32.load (local.get $p)) (i32.const 389))
      (then (return (i32.const 0))))
    (local.set $a (i32.load offset=4 (local.get $p)))
    (local.set $a_info (i32.load offset=8 (local.get $p)))
    (local.set $a_disp (i32.load offset=12 (local.get $p)))

    (local.set $p (call $loop_op_at (i32.const 1)))
    (if (i32.ne (i32.load (local.get $p)) (i32.const 389))
      (then (return (i32.const 0))))
    (local.set $b (i32.load offset=4 (local.get $p)))
    (local.set $b_info (i32.load offset=8 (local.get $p)))
    (local.set $b_disp (i32.load offset=12 (local.get $p)))

    ;; Equal immediate masks on the two loaded values.
    (local.set $p (call $loop_op_at (i32.const 2)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 7))
                (i32.ne (i32.load offset=4 (local.get $p)) (local.get $a)))
      (then (return (i32.const 0))))
    (local.set $mask (i32.load offset=8 (local.get $p)))
    (local.set $p (call $loop_op_at (i32.const 3)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 7))
          (i32.or (i32.ne (i32.load offset=4 (local.get $p)) (local.get $b))
                  (i32.ne (i32.load offset=8 (local.get $p)) (local.get $mask))))
      (then (return (i32.const 0))))

    (local.set $p (call $loop_op_at (i32.const 4)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 12))
                (i32.ne (i32.load offset=4 (local.get $p))
                  (i32.or (i32.shl (local.get $a) (i32.const 4)) (local.get $b))))
      (then (return (i32.const 0))))
    (local.set $p (call $loop_op_at (i32.const 5)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 53))
                (i32.ne (i32.load offset=4 (local.get $p))
                  (i32.or (local.get $a) (i32.const 0x10300))))
      (then (return (i32.const 0))))

    (local.set $p (call $loop_op_at (i32.const 6)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 420))
                (i32.ne (i32.load offset=4 (local.get $p)) (local.get $a)))
      (then (return (i32.const 0))))
    (local.set $d_info (i32.load offset=8 (local.get $p)))
    (local.set $d_disp (i32.load offset=12 (local.get $p)))

    (local.set $p (call $loop_op_at (i32.const 7)))
    (if (i32.ne (i32.load (local.get $p)) (i32.const 65))
      (then (return (i32.const 0))))
    (local.set $ind (i32.load offset=4 (local.get $p)))
    (local.set $p (call $loop_op_at (i32.const 8)))
    (if (i32.ne (i32.load (local.get $p)) (i32.const 320))
      (then (return (i32.const 0))))
    (local.set $branch_op (i32.load offset=4 (local.get $p)))
    (local.set $fall (i32.load offset=8 (local.get $p)))
    (local.set $back (i32.load offset=12 (local.get $p)))

    (local.set $a_base (i32.and (local.get $a_info) (i32.const 0xF)))
    (local.set $b_base (i32.and (local.get $b_info) (i32.const 0xF)))
    (local.set $d_base (i32.and (local.get $d_info) (i32.const 0xF)))
    (local.set $scale (i32.and (i32.shr_u (local.get $a_info) (i32.const 8)) (i32.const 3)))
    ;; All streams use the induction register with one scale. Reject absent or
    ;; non-register bases and every alias that would make a load overwrite an
    ;; address component used later in the same original iteration.
    (if (i32.or
          (i32.or (i32.ge_u (local.get $a_base) (i32.const 8))
                  (i32.ge_u (local.get $b_base) (i32.const 8)))
          (i32.ge_u (local.get $d_base) (i32.const 8)))
      (then (return (i32.const 0))))
    (if (i32.or
          (i32.ne (i32.and (i32.shr_u (local.get $a_info) (i32.const 4)) (i32.const 0xF))
                  (local.get $ind))
          (i32.or
            (i32.ne (i32.and (i32.shr_u (local.get $b_info) (i32.const 4)) (i32.const 0xF))
                    (local.get $ind))
            (i32.ne (i32.and (i32.shr_u (local.get $d_info) (i32.const 4)) (i32.const 0xF))
                    (local.get $ind))))
      (then (return (i32.const 0))))
    (if (i32.or
          (i32.ne (i32.and (i32.shr_u (local.get $b_info) (i32.const 8)) (i32.const 3))
                  (local.get $scale))
          (i32.ne (i32.and (i32.shr_u (local.get $d_info) (i32.const 8)) (i32.const 3))
                  (local.get $scale)))
      (then (return (i32.const 0))))
    (local.set $regs
      (i32.or (i32.shl (i32.const 1) (local.get $a))
        (i32.or (i32.shl (i32.const 1) (local.get $b))
          (i32.or (i32.shl (i32.const 1) (local.get $ind))
            (i32.or (i32.shl (i32.const 1) (local.get $a_base))
              (i32.or (i32.shl (i32.const 1) (local.get $b_base))
                      (i32.shl (i32.const 1) (local.get $d_base))))))))
    (if (i32.ne (i32.popcnt (local.get $regs)) (i32.const 6))
      (then (return (i32.const 0))))

    (global.set $loop_matched_blocks
      (i32.add (global.get $loop_matched_blocks) (i32.const 1)))
    (global.set $loop_avg_matches
      (i32.add (global.get $loop_avg_matches) (i32.const 1)))
    (if (global.get $loop_trace)
      (then
        (call $host_log_i32 (i32.const 0x100B0004))
        (call $host_log_i32 (local.get $start_eip))))
    (if (i32.eqz (call $loop_copy_emit_get))
      (then (return (i32.const 0))))

    (global.set $thread_alloc (local.get $tstart))
    (global.set $op_index_n (i32.const 0))
    (call $loop_emit_avg
      (i32.const 0) (local.get $mask) (i32.const 0)
      (local.get $a_base) (local.get $ind) (local.get $scale) (local.get $a_disp) (i32.const 0)
      (local.get $b_base) (local.get $ind) (local.get $scale) (local.get $b_disp) (i32.const 0)
      (local.get $d_base) (local.get $ind) (local.get $scale) (local.get $d_disp) (i32.const 0)
      (local.get $ind) (i32.const -1) (i32.const 1) (i32.const 9))

    ;; Ordinary complete final iteration.
    (call $te (i32.const 389) (local.get $a))
    (call $te_raw (local.get $a_info)) (call $te_raw (local.get $a_disp))
    (call $te (i32.const 389) (local.get $b))
    (call $te_raw (local.get $b_info)) (call $te_raw (local.get $b_disp))
    (call $te (i32.const 7) (local.get $a)) (call $te_raw (local.get $mask))
    (call $te (i32.const 7) (local.get $b)) (call $te_raw (local.get $mask))
    (call $te (i32.const 12) (i32.or (i32.shl (local.get $a) (i32.const 4)) (local.get $b)))
    (call $te (i32.const 53) (i32.or (local.get $a) (i32.const 0x10300)))
    (call $te (i32.const 420) (local.get $a))
    (call $te_raw (local.get $d_info)) (call $te_raw (local.get $d_disp))
    (call $te (i32.const 65) (local.get $ind))
    (call $te (i32.const 320) (local.get $branch_op))
    (call $te_raw (local.get $fall)) (call $te_raw (local.get $back))
    (i32.const 1))

  ;; Advancing-cursor floor average used by Winamp AVS and VirtualDub-shaped
  ;; renderers: shift both lanes, apply one common mask, then add.
  (func $loop_try_avg_shift_cursor
    (param $start_eip i32) (param $tstart i32) (result i32)
    (local $p i32) (local $fn i32) (local $branch_op i32)
    (local $a i32) (local $b i32) (local $ind i32)
    (local $a_base i32) (local $b_base i32) (local $d_base i32)
    (local $a_disp i32) (local $b_disp i32) (local $d_disp i32)
    (local $mask i32) (local $fall i32) (local $back i32) (local $regs i32)

    (if (i32.ne (global.get $op_index_n) (i32.const 13))
      (then (return (i32.const 0))))
    (local.set $p (call $loop_op_at (i32.const 0)))
    (local.set $fn (i32.load (local.get $p)))
    (if (i32.or (i32.lt_u (local.get $fn) (i32.const 339))
                (i32.gt_u (local.get $fn) (i32.const 346)))
      (then (return (i32.const 0))))
    (local.set $a_base (i32.sub (local.get $fn) (i32.const 339)))
    (local.set $a (i32.load offset=4 (local.get $p)))
    (local.set $a_disp (i32.load offset=8 (local.get $p)))
    (local.set $p (call $loop_op_at (i32.const 1)))
    (local.set $fn (i32.load (local.get $p)))
    (if (i32.or (i32.lt_u (local.get $fn) (i32.const 339))
                (i32.gt_u (local.get $fn) (i32.const 346)))
      (then (return (i32.const 0))))
    (local.set $b_base (i32.sub (local.get $fn) (i32.const 339)))
    (local.set $b (i32.load offset=4 (local.get $p)))
    (local.set $b_disp (i32.load offset=8 (local.get $p)))

    (local.set $p (call $loop_op_at (i32.const 2)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 53))
                (i32.ne (i32.load offset=4 (local.get $p))
                  (i32.or (local.get $a) (i32.const 0x10500))))
      (then (return (i32.const 0))))
    (local.set $p (call $loop_op_at (i32.const 3)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 53))
                (i32.ne (i32.load offset=4 (local.get $p))
                  (i32.or (local.get $b) (i32.const 0x10500))))
      (then (return (i32.const 0))))
    (local.set $p (call $loop_op_at (i32.const 4)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 7))
                (i32.ne (i32.load offset=4 (local.get $p)) (local.get $a)))
      (then (return (i32.const 0))))
    (local.set $mask (i32.load offset=8 (local.get $p)))
    (local.set $p (call $loop_op_at (i32.const 5)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 7))
          (i32.or (i32.ne (i32.load offset=4 (local.get $p)) (local.get $b))
                  (i32.ne (i32.load offset=8 (local.get $p)) (local.get $mask))))
      (then (return (i32.const 0))))
    (local.set $p (call $loop_op_at (i32.const 6)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 12))
                (i32.ne (i32.load offset=4 (local.get $p))
                  (i32.or (i32.shl (local.get $a) (i32.const 4)) (local.get $b))))
      (then (return (i32.const 0))))

    (local.set $p (call $loop_op_at (i32.const 7)))
    (local.set $fn (i32.load (local.get $p)))
    (if (i32.or
          (i32.or (i32.lt_u (local.get $fn) (i32.const 347))
                  (i32.gt_u (local.get $fn) (i32.const 354)))
          (i32.ne (i32.load offset=4 (local.get $p)) (local.get $a)))
      (then (return (i32.const 0))))
    (local.set $d_base (i32.sub (local.get $fn) (i32.const 347)))
    (local.set $d_disp (i32.load offset=8 (local.get $p)))

    ;; Three cursor bumps by four bytes in stream order.
    (local.set $p (call $loop_op_at (i32.const 8)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 3))
          (i32.or (i32.ne (i32.load offset=4 (local.get $p)) (local.get $a_base))
                  (i32.ne (i32.load offset=8 (local.get $p)) (i32.const 4))))
      (then (return (i32.const 0))))
    (local.set $p (call $loop_op_at (i32.const 9)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 3))
          (i32.or (i32.ne (i32.load offset=4 (local.get $p)) (local.get $b_base))
                  (i32.ne (i32.load offset=8 (local.get $p)) (i32.const 4))))
      (then (return (i32.const 0))))
    (local.set $p (call $loop_op_at (i32.const 10)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 3))
          (i32.or (i32.ne (i32.load offset=4 (local.get $p)) (local.get $d_base))
                  (i32.ne (i32.load offset=8 (local.get $p)) (i32.const 4))))
      (then (return (i32.const 0))))
    (local.set $p (call $loop_op_at (i32.const 11)))
    (if (i32.ne (i32.load (local.get $p)) (i32.const 65))
      (then (return (i32.const 0))))
    (local.set $ind (i32.load offset=4 (local.get $p)))
    (local.set $p (call $loop_op_at (i32.const 12)))
    (if (i32.ne (i32.load (local.get $p)) (i32.const 312))
      (then (return (i32.const 0))))
    (local.set $branch_op (i32.load offset=4 (local.get $p)))
    (local.set $fall (i32.load offset=8 (local.get $p)))
    (local.set $back (i32.load offset=12 (local.get $p)))

    (local.set $regs
      (i32.or (i32.shl (i32.const 1) (local.get $a))
        (i32.or (i32.shl (i32.const 1) (local.get $b))
          (i32.or (i32.shl (i32.const 1) (local.get $ind))
            (i32.or (i32.shl (i32.const 1) (local.get $a_base))
              (i32.or (i32.shl (i32.const 1) (local.get $b_base))
                      (i32.shl (i32.const 1) (local.get $d_base))))))))
    (if (i32.ne (i32.popcnt (local.get $regs)) (i32.const 6))
      (then (return (i32.const 0))))

    (global.set $loop_matched_blocks
      (i32.add (global.get $loop_matched_blocks) (i32.const 1)))
    (global.set $loop_avg_matches
      (i32.add (global.get $loop_avg_matches) (i32.const 1)))
    (if (i32.eqz (call $loop_copy_emit_get))
      (then (return (i32.const 0))))
    (global.set $thread_alloc (local.get $tstart))
    (global.set $op_index_n (i32.const 0))
    (call $loop_emit_avg
      (i32.const 1) (local.get $mask) (i32.const 0)
      (local.get $a_base) (i32.const -1) (i32.const 0) (local.get $a_disp) (i32.const 4)
      (local.get $b_base) (i32.const -1) (i32.const 0) (local.get $b_disp) (i32.const 4)
      (local.get $d_base) (i32.const -1) (i32.const 0) (local.get $d_disp) (i32.const 4)
      (local.get $ind) (i32.const -1) (i32.const 0) (i32.const 13))

    (call $te (i32.add (i32.const 339) (local.get $a_base)) (local.get $a))
    (call $te_raw (local.get $a_disp))
    (call $te (i32.add (i32.const 339) (local.get $b_base)) (local.get $b))
    (call $te_raw (local.get $b_disp))
    (call $te (i32.const 53) (i32.or (local.get $a) (i32.const 0x10500)))
    (call $te (i32.const 53) (i32.or (local.get $b) (i32.const 0x10500)))
    (call $te (i32.const 7) (local.get $a)) (call $te_raw (local.get $mask))
    (call $te (i32.const 7) (local.get $b)) (call $te_raw (local.get $mask))
    (call $te (i32.const 12) (i32.or (i32.shl (local.get $a) (i32.const 4)) (local.get $b)))
    (call $te (i32.add (i32.const 347) (local.get $d_base)) (local.get $a))
    (call $te_raw (local.get $d_disp))
    (call $te (i32.const 3) (local.get $a_base)) (call $te_raw (i32.const 4))
    (call $te (i32.const 3) (local.get $b_base)) (call $te_raw (i32.const 4))
    (call $te (i32.const 3) (local.get $d_base)) (call $te_raw (i32.const 4))
    (call $te (i32.const 65) (local.get $ind))
    (call $te (i32.const 312) (local.get $branch_op))
    (call $te_raw (local.get $fall)) (call $te_raw (local.get $back))
    (i32.const 1))

  ;; Rounded packed average used by SDL/Smacker-shaped renderers. Preserve the
  ;; correction term in a third data register before shifting the two sources:
  ;;
  ;;   mov A,[baseA] / mov B,[baseB] / mov R,A / and R,B / and R,round_mask
  ;;   shr A,1 / shr B,1 / and A,mask / and B,mask
  ;;   add A,B / add A,R / mov [baseD],A
  ;;   add baseA,4 / add baseB,4 / add baseD,4 / dec count / jnz ^
  (func $loop_try_avg_round_cursor
    (param $start_eip i32) (param $tstart i32) (result i32)
    (local $p i32) (local $fn i32) (local $branch_op i32)
    (local $a i32) (local $b i32) (local $round i32) (local $ind i32)
    (local $a_base i32) (local $b_base i32) (local $d_base i32)
    (local $a_disp i32) (local $b_disp i32) (local $d_disp i32)
    (local $mask i32) (local $round_mask i32)
    (local $fall i32) (local $back i32) (local $regs i32)

    (if (i32.ne (global.get $op_index_n) (i32.const 17))
      (then (return (i32.const 0))))
    (local.set $p (call $loop_op_at (i32.const 0)))
    (local.set $fn (i32.load (local.get $p)))
    (if (i32.or (i32.lt_u (local.get $fn) (i32.const 339))
                (i32.gt_u (local.get $fn) (i32.const 346)))
      (then (return (i32.const 0))))
    (local.set $a_base (i32.sub (local.get $fn) (i32.const 339)))
    (local.set $a (i32.load offset=4 (local.get $p)))
    (local.set $a_disp (i32.load offset=8 (local.get $p)))
    (local.set $p (call $loop_op_at (i32.const 1)))
    (local.set $fn (i32.load (local.get $p)))
    (if (i32.or (i32.lt_u (local.get $fn) (i32.const 339))
                (i32.gt_u (local.get $fn) (i32.const 346)))
      (then (return (i32.const 0))))
    (local.set $b_base (i32.sub (local.get $fn) (i32.const 339)))
    (local.set $b (i32.load offset=4 (local.get $p)))
    (local.set $b_disp (i32.load offset=8 (local.get $p)))

    (local.set $p (call $loop_op_at (i32.const 2)))
    (if (i32.ne (i32.load (local.get $p)) (i32.const 11))
      (then (return (i32.const 0))))
    (local.set $round (i32.shr_u (i32.load offset=4 (local.get $p)) (i32.const 4)))
    (if (i32.ne (i32.load offset=4 (local.get $p))
          (i32.or (i32.shl (local.get $round) (i32.const 4)) (local.get $a)))
      (then (return (i32.const 0))))
    (local.set $p (call $loop_op_at (i32.const 3)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 16))
                (i32.ne (i32.load offset=4 (local.get $p))
                  (i32.or (i32.shl (local.get $round) (i32.const 4)) (local.get $b))))
      (then (return (i32.const 0))))
    (local.set $p (call $loop_op_at (i32.const 4)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 7))
                (i32.ne (i32.load offset=4 (local.get $p)) (local.get $round)))
      (then (return (i32.const 0))))
    (local.set $round_mask (i32.load offset=8 (local.get $p)))

    (local.set $p (call $loop_op_at (i32.const 5)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 53))
                (i32.ne (i32.load offset=4 (local.get $p))
                  (i32.or (local.get $a) (i32.const 0x10500))))
      (then (return (i32.const 0))))
    (local.set $p (call $loop_op_at (i32.const 6)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 53))
                (i32.ne (i32.load offset=4 (local.get $p))
                  (i32.or (local.get $b) (i32.const 0x10500))))
      (then (return (i32.const 0))))
    (local.set $p (call $loop_op_at (i32.const 7)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 7))
                (i32.ne (i32.load offset=4 (local.get $p)) (local.get $a)))
      (then (return (i32.const 0))))
    (local.set $mask (i32.load offset=8 (local.get $p)))
    (local.set $p (call $loop_op_at (i32.const 8)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 7))
          (i32.or (i32.ne (i32.load offset=4 (local.get $p)) (local.get $b))
                  (i32.ne (i32.load offset=8 (local.get $p)) (local.get $mask))))
      (then (return (i32.const 0))))
    (local.set $p (call $loop_op_at (i32.const 9)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 12))
                (i32.ne (i32.load offset=4 (local.get $p))
                  (i32.or (i32.shl (local.get $a) (i32.const 4)) (local.get $b))))
      (then (return (i32.const 0))))
    (local.set $p (call $loop_op_at (i32.const 10)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 12))
                (i32.ne (i32.load offset=4 (local.get $p))
                  (i32.or (i32.shl (local.get $a) (i32.const 4)) (local.get $round))))
      (then (return (i32.const 0))))

    (local.set $p (call $loop_op_at (i32.const 11)))
    (local.set $fn (i32.load (local.get $p)))
    (if (i32.or
          (i32.or (i32.lt_u (local.get $fn) (i32.const 347))
                  (i32.gt_u (local.get $fn) (i32.const 354)))
          (i32.ne (i32.load offset=4 (local.get $p)) (local.get $a)))
      (then (return (i32.const 0))))
    (local.set $d_base (i32.sub (local.get $fn) (i32.const 347)))
    (local.set $d_disp (i32.load offset=8 (local.get $p)))

    (local.set $p (call $loop_op_at (i32.const 12)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 3))
          (i32.or (i32.ne (i32.load offset=4 (local.get $p)) (local.get $a_base))
                  (i32.ne (i32.load offset=8 (local.get $p)) (i32.const 4))))
      (then (return (i32.const 0))))
    (local.set $p (call $loop_op_at (i32.const 13)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 3))
          (i32.or (i32.ne (i32.load offset=4 (local.get $p)) (local.get $b_base))
                  (i32.ne (i32.load offset=8 (local.get $p)) (i32.const 4))))
      (then (return (i32.const 0))))
    (local.set $p (call $loop_op_at (i32.const 14)))
    (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.const 3))
          (i32.or (i32.ne (i32.load offset=4 (local.get $p)) (local.get $d_base))
                  (i32.ne (i32.load offset=8 (local.get $p)) (i32.const 4))))
      (then (return (i32.const 0))))
    (local.set $p (call $loop_op_at (i32.const 15)))
    (if (i32.ne (i32.load (local.get $p)) (i32.const 65))
      (then (return (i32.const 0))))
    (local.set $ind (i32.load offset=4 (local.get $p)))
    (local.set $p (call $loop_op_at (i32.const 16)))
    (if (i32.ne (i32.load (local.get $p)) (i32.const 312))
      (then (return (i32.const 0))))
    (local.set $branch_op (i32.load offset=4 (local.get $p)))
    (local.set $fall (i32.load offset=8 (local.get $p)))
    (local.set $back (i32.load offset=12 (local.get $p)))

    ;; Seven distinct roles ensure neither data load nor cursor update changes
    ;; an address component or the private countdown used later in the body.
    (local.set $regs
      (i32.or (i32.shl (i32.const 1) (local.get $a))
        (i32.or (i32.shl (i32.const 1) (local.get $b))
          (i32.or (i32.shl (i32.const 1) (local.get $round))
            (i32.or (i32.shl (i32.const 1) (local.get $ind))
              (i32.or (i32.shl (i32.const 1) (local.get $a_base))
                (i32.or (i32.shl (i32.const 1) (local.get $b_base))
                        (i32.shl (i32.const 1) (local.get $d_base)))))))))
    (if (i32.ne (i32.popcnt (local.get $regs)) (i32.const 7))
      (then (return (i32.const 0))))

    (global.set $loop_matched_blocks
      (i32.add (global.get $loop_matched_blocks) (i32.const 1)))
    (global.set $loop_avg_matches
      (i32.add (global.get $loop_avg_matches) (i32.const 1)))
    (if (i32.eqz (call $loop_copy_emit_get))
      (then (return (i32.const 0))))
    (global.set $thread_alloc (local.get $tstart))
    (global.set $op_index_n (i32.const 0))
    (call $loop_emit_avg
      (i32.const 2) (local.get $mask) (local.get $round_mask)
      (local.get $a_base) (i32.const -1) (i32.const 0) (local.get $a_disp) (i32.const 4)
      (local.get $b_base) (i32.const -1) (i32.const 0) (local.get $b_disp) (i32.const 4)
      (local.get $d_base) (i32.const -1) (i32.const 0) (local.get $d_disp) (i32.const 4)
      (local.get $ind) (i32.const -1) (i32.const 0) (i32.const 17))

    ;; Retain the complete final iteration as ordinary threaded handlers.
    (call $te (i32.add (i32.const 339) (local.get $a_base)) (local.get $a))
    (call $te_raw (local.get $a_disp))
    (call $te (i32.add (i32.const 339) (local.get $b_base)) (local.get $b))
    (call $te_raw (local.get $b_disp))
    (call $te (i32.const 11)
      (i32.or (i32.shl (local.get $round) (i32.const 4)) (local.get $a)))
    (call $te (i32.const 16)
      (i32.or (i32.shl (local.get $round) (i32.const 4)) (local.get $b)))
    (call $te (i32.const 7) (local.get $round)) (call $te_raw (local.get $round_mask))
    (call $te (i32.const 53) (i32.or (local.get $a) (i32.const 0x10500)))
    (call $te (i32.const 53) (i32.or (local.get $b) (i32.const 0x10500)))
    (call $te (i32.const 7) (local.get $a)) (call $te_raw (local.get $mask))
    (call $te (i32.const 7) (local.get $b)) (call $te_raw (local.get $mask))
    (call $te (i32.const 12)
      (i32.or (i32.shl (local.get $a) (i32.const 4)) (local.get $b)))
    (call $te (i32.const 12)
      (i32.or (i32.shl (local.get $a) (i32.const 4)) (local.get $round)))
    (call $te (i32.add (i32.const 347) (local.get $d_base)) (local.get $a))
    (call $te_raw (local.get $d_disp))
    (call $te (i32.const 3) (local.get $a_base)) (call $te_raw (i32.const 4))
    (call $te (i32.const 3) (local.get $b_base)) (call $te_raw (i32.const 4))
    (call $te (i32.const 3) (local.get $d_base)) (call $te_raw (i32.const 4))
    (call $te (i32.const 65) (local.get $ind))
    (call $te (i32.const 312) (local.get $branch_op))
    (call $te_raw (local.get $fall)) (call $te_raw (local.get $back))
    (i32.const 1))

  ;; ------------------------------------------------------------------
  ;; Bounded dword COPY_RUN
  ;; ------------------------------------------------------------------
  ;; Abe's dominant row copier at 0x00496c31 is the six-op self-loop:
  ;;
  ;;   mov scratch,[src] / add src,4 / mov [dst],scratch / add dst,4
  ;;   cmp dst,bound / jb ^
  ;;
  ;; The bytes moved are the same as a forward byte stream whenever the source
  ;; and destination spans do not overlap. Reuse scalar H419 mode 0 with a
  ;; private, bound-derived byte count (ctr_kind=2), src/dst byte strides, and
  ;; a four-byte rounding quantum. H419 retains complete-dword budget
  ;; boundaries and takes an ordinary dword fallback for overlap. The final
  ;; scratch load and original CMP/JB remain ordinary threaded ops, so their
  ;; architectural register and flag results need no reimplementation here.
  ;;
  ;; This recognizer is exact in role order but register/displacement generic.
  ;; All four registers must differ: otherwise one of the cursor bumps or the
  ;; load would change a later address/bound in the same original iteration.
  (func $loop_try_copy32_bounded
    (param $start_eip i32) (param $tstart i32) (result i32)
    (local $p i32) (local $fn i32) (local $op i32)
    (local $src i32) (local $dst i32) (local $scratch i32) (local $bound i32)
    (local $src_disp i32) (local $dst_disp i32)
    (local $fall i32) (local $back i32) (local $mask i32)

    (if (i32.ne (global.get $op_index_n) (i32.const 6))
      (then (return (i32.const 0))))

    ;; mov scratch,[src+disp]
    (local.set $p (call $loop_op_at (i32.const 0)))
    (local.set $fn (i32.load (local.get $p)))
    (if (i32.or (i32.lt_u (local.get $fn) (i32.const 339))
                (i32.gt_u (local.get $fn) (i32.const 346)))
      (then (return (i32.const 0))))
    (local.set $src (i32.sub (local.get $fn) (i32.const 339)))
    (local.set $scratch (i32.load offset=4 (local.get $p)))
    (local.set $src_disp (i32.load offset=8 (local.get $p)))

    ;; add src,4
    (local.set $p (call $loop_op_at (i32.const 1)))
    (if (i32.or
          (i32.ne (i32.load (local.get $p)) (i32.const 3))
          (i32.or
            (i32.ne (i32.load offset=4 (local.get $p)) (local.get $src))
            (i32.ne (i32.load offset=8 (local.get $p)) (i32.const 4))))
      (then (return (i32.const 0))))

    ;; mov [dst+disp],scratch
    (local.set $p (call $loop_op_at (i32.const 2)))
    (local.set $fn (i32.load (local.get $p)))
    (if (i32.or (i32.lt_u (local.get $fn) (i32.const 347))
                (i32.gt_u (local.get $fn) (i32.const 354)))
      (then (return (i32.const 0))))
    (local.set $dst (i32.sub (local.get $fn) (i32.const 347)))
    (if (i32.ne (i32.load offset=4 (local.get $p)) (local.get $scratch))
      (then (return (i32.const 0))))
    (local.set $dst_disp (i32.load offset=8 (local.get $p)))

    ;; add dst,4
    (local.set $p (call $loop_op_at (i32.const 3)))
    (if (i32.or
          (i32.ne (i32.load (local.get $p)) (i32.const 3))
          (i32.or
            (i32.ne (i32.load offset=4 (local.get $p)) (local.get $dst))
            (i32.ne (i32.load offset=8 (local.get $p)) (i32.const 4))))
      (then (return (i32.const 0))))

    ;; cmp dst,bound / jb back
    (local.set $p (call $loop_op_at (i32.const 4)))
    (if (i32.ne (i32.load (local.get $p)) (i32.const 19))
      (then (return (i32.const 0))))
    (local.set $op (i32.load offset=4 (local.get $p)))
    (if (i32.ne (i32.shr_u (local.get $op) (i32.const 4)) (local.get $dst))
      (then (return (i32.const 0))))
    (local.set $bound (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $p (call $loop_op_at (i32.const 5)))
    (if (i32.ne (i32.load (local.get $p)) (i32.const 309))
      (then (return (i32.const 0))))
    (local.set $fall (i32.load offset=8 (local.get $p)))
    (local.set $back (i32.load offset=12 (local.get $p)))

    (local.set $mask
      (i32.or (i32.shl (i32.const 1) (local.get $src))
        (i32.or (i32.shl (i32.const 1) (local.get $dst))
          (i32.or (i32.shl (i32.const 1) (local.get $scratch))
                  (i32.shl (i32.const 1) (local.get $bound))))))
    ;; Four distinct registers set exactly four bits.
    (if (i32.ne (i32.popcnt (local.get $mask)) (i32.const 4))
      (then (return (i32.const 0))))

    (global.set $loop_matched_blocks
      (i32.add (global.get $loop_matched_blocks) (i32.const 1)))
    (global.set $loop_copy32_matches
      (i32.add (global.get $loop_copy32_matches) (i32.const 1)))
    (if (global.get $loop_trace)
      (then
        (call $host_log_i32 (i32.const 0x100B0003))
        (call $host_log_i32 (local.get $start_eip))))
    (if (i32.eqz (call $loop_copy_emit_get))
      (then (return (i32.const 0))))

    (global.set $thread_alloc (local.get $tstart))
    (global.set $op_index_n (i32.const 0))
    (call $te (global.get $LOOP_SUPEROP_COPY) (i32.const 0))
    (call $te_raw (local.get $src))
    (call $te_raw (i32.const 1))
    (call $te_raw (local.get $src_disp))
    (call $te_raw (local.get $dst))
    (call $te_raw (i32.const 1))
    (call $te_raw (local.get $dst_disp))
    (call $te_raw (i32.const -1))            ;; no byte scratch publication
    (call $te_raw (i32.const 2))             ;; private bound-derived counter
    (call $te_raw (local.get $bound))
    (call $te_raw (i32.const 4))             ;; byte-count rounding quantum
    (call $te_raw (i32.const -1))
    (call $te_raw (local.get $fall))
    (call $te_raw (local.get $back))
    (call $te_raw (i32.const 6))             ;; original ops per dword

    ;; Reconstruct the final full-width scratch value from the last destination
    ;; dword, then retain the exact terminator. Reading the destination (rather
    ;; than the possibly overwritten source) also preserves overlap semantics.
    (call $te (i32.add (i32.const 339) (local.get $dst)) (local.get $scratch))
    (call $te_raw (i32.sub (local.get $dst_disp) (i32.const 4)))
    (call $te (i32.const 19)
      (i32.or (i32.shl (local.get $dst) (i32.const 4)) (local.get $bound)))
    (call $te (i32.const 309) (i32.load offset=4 (local.get $p)))
    (call $te_raw (local.get $fall))
    (call $te_raw (local.get $back))
    (i32.const 1))

  ;; ------------------------------------------------------------------
  ;; COPY_RUN
  ;; ------------------------------------------------------------------
  ;;   dst[i] = src[i] for a counted run -- the byte-at-a-time memcpy every
  ;;   unpacker open-codes. Total Annihilation's is at 0x497948:
  ;;
  ;;     mov cl,[edx] / inc edx / mov [eax],cl / inc eax / dec [esp+d] / jnz ^
  ;;
  ;;   That single block is 8.7% of all block entries and 6.8% of all handler
  ;;   dispatches in a 3000-batch run, and today it is declined twice over: it
  ;;   is one op short of LUT_RUN's seven-op floor, and its trip counter lives
  ;;   on the stack rather than in a register. Both are accidents of LUT_RUN's
  ;;   shape, not of the idiom.
  ;;
  ;; Two cursors, two strides, two displacements, one byte register passing
  ;; through unchanged, and a counter in either a register or memory. The
  ;; source and destination bases must differ -- a copy through one cursor is
  ;; a different loop, and would alias.
  ;;
  ;; Parameter block:
  ;;   0 src_reg  1 src_stride  2 src_disp
  ;;   3 dst_reg  4 dst_stride  5 dst_disp
  ;;   6 byte_reg 7 ctr_kind (0 reg, 1 mem, 2 cursor bound)
  ;;   8 ctr_loc  9 ctr_disp
  ;;  10 ctr_step 11 fall_eip  12 back_eip  13 steps_per_iter
  ;;
  ;; Every form executes against a private local remaining count. Kinds 0/1
  ;; mirror that count into the architectural counter the guest loop updates.
  ;; Kind 2 instead derives byte count by rounding (bound-dst) up to a quantum,
  ;; where ctr_loc is the bound register and ctr_disp is that byte quantum; it has
  ;; no architectural counter to publish and continues into suffix ops.
  (global $LOOP_SUPEROP_COPY i32 (i32.const 419))

  (func $loop_try_copy (param $start_eip i32) (param $tstart i32) (result i32)
    (local $i i32) (local $n i32) (local $p i32) (local $fn i32) (local $op i32)
    (local $role i32) (local $reg i32) (local $step i32)
    (local $ld_base i32) (local $ld_reg i32) (local $ld_disp i32) (local $ld_idx i32) (local $ld_cnt i32)
    (local $st_base i32) (local $st_reg i32) (local $st_disp i32) (local $st_idx i32) (local $st_cnt i32)
    (local $mem_base i32) (local $mem_disp i32) (local $mem_step i32) (local $mem_idx i32) (local $mem_cnt i32)
    (local $addi_cnt i32) (local $written i32)
    (local $src_stride i32) (local $src_idx i32) (local $src_cnt i32)
    (local $dst_stride i32) (local $dst_idx i32) (local $dst_cnt i32)
    (local $ctr_kind i32) (local $ctr_loc i32) (local $ctr_disp i32)
    (local $ctr_step i32) (local $ctr_idx i32) (local $ctr_cnt i32)
    (local $fall i32)

    (local.set $n (global.get $op_index_n))
    ;; load / bump / store / bump / count / branch is the floor; anything
    ;; longer than a dozen ops is doing more than copying.
    (if (i32.lt_u (local.get $n) (i32.const 5)) (then (return (i32.const 0))))
    (if (i32.gt_u (local.get $n) (i32.const 12)) (then (return (i32.const 0))))

    ;; ---- pass 1: roles ----
    ;; Only the five roles this idiom is made of are tolerated. A ZERO, a
    ;; MIRROR or an indexed load means the body is computing something, and
    ;; whatever it is, it is not this.
    (local.set $i (i32.const 0))
    (block $p1_done
      (loop $p1
        (br_if $p1_done (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $p (call $loop_op_at (local.get $i)))
        (local.set $fn (i32.load (local.get $p)))
        (local.set $op (i32.load offset=4 (local.get $p)))
        (local.set $role (call $loop_role (local.get $fn) (local.get $op)))

        (if (i32.eq (local.get $role) (global.get $LR_LOAD8))
          (then
            (local.set $ld_cnt (i32.add (local.get $ld_cnt) (i32.const 1)))
            (local.set $ld_base (i32.and (local.get $op) (i32.const 0xF)))
            (local.set $ld_reg (i32.shr_u (local.get $op) (i32.const 4)))
            (local.set $ld_disp (i32.load offset=8 (local.get $p)))
            (local.set $ld_idx (local.get $i))
            (local.set $written (i32.or (local.get $written)
              (i32.shl (i32.const 1) (i32.and (local.get $ld_reg) (i32.const 3))))))
          (else (if (i32.eq (local.get $role) (global.get $LR_STORE8))
            (then
              (local.set $st_cnt (i32.add (local.get $st_cnt) (i32.const 1)))
              (local.set $st_base (i32.and (local.get $op) (i32.const 0xF)))
              (local.set $st_reg (i32.shr_u (local.get $op) (i32.const 4)))
              (local.set $st_disp (i32.load offset=8 (local.get $p)))
              (local.set $st_idx (local.get $i)))
          (else (if (i32.eq (local.get $role) (global.get $LR_ADDI))
            (then
              (local.set $addi_cnt (i32.add (local.get $addi_cnt) (i32.const 1)))
              (local.set $written (i32.or (local.get $written)
                (i32.shl (i32.const 1) (i32.and (local.get $op) (i32.const 0xF))))))
          (else (if (i32.eq (local.get $role) (global.get $LR_MEMCTR))
            (then
              (local.set $mem_cnt (i32.add (local.get $mem_cnt) (i32.const 1)))
              (local.set $mem_base (i32.and (local.get $op) (i32.const 0xF)))
              (local.set $mem_disp (i32.load offset=8 (local.get $p)))
              (local.set $mem_step (select (i32.const 1) (i32.const -1)
                (i32.eqz (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))))
              (local.set $mem_idx (local.get $i)))
          (else (if (i32.eq (local.get $role) (global.get $LR_JCC))
            (then
              (if (i32.ne (local.get $i) (i32.sub (local.get $n) (i32.const 1)))
                (then (return (i32.const 0)))))
            (else (return (i32.const 0))))))))))))

        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $p1)))

    ;; ---- pass 2: the predicate ----
    (if (i32.ne (local.get $ld_cnt) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $st_cnt) (i32.const 1)) (then (return (i32.const 0))))
    ;; The byte read is the byte written, untouched in between.
    (if (i32.ne (local.get $ld_reg) (local.get $st_reg)) (then (return (i32.const 0))))
    (if (i32.ge_u (local.get $ld_idx) (local.get $st_idx)) (then (return (i32.const 0))))
    ;; One cursor for the source, a different one for the destination.
    (if (i32.eq (local.get $ld_base) (local.get $st_base)) (then (return (i32.const 0))))
    ;; The byte register's parent must not be a cursor, or the load moves the
    ;; pointer it just read through.
    (if (i32.eq (i32.and (local.get $ld_reg) (i32.const 3)) (local.get $ld_base))
      (then (return (i32.const 0))))
    (if (i32.eq (i32.and (local.get $ld_reg) (i32.const 3)) (local.get $st_base))
      (then (return (i32.const 0))))

    ;; Sort the increments: one steps the source, one the destination, and a
    ;; third (if there is no memory counter) is the trip count.
    (local.set $i (i32.const 0))
    (block $p2_done
      (loop $p2
        (br_if $p2_done (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $p (call $loop_op_at (local.get $i)))
        (local.set $fn (i32.load (local.get $p)))
        (local.set $op (i32.load offset=4 (local.get $p)))
        (if (i32.eq (call $loop_role (local.get $fn) (local.get $op))
                    (global.get $LR_ADDI))
          (then
            (local.set $reg (i32.and (local.get $op) (i32.const 0xF)))
            (local.set $step
              (select (i32.const 1) (i32.const -1) (i32.eq (local.get $fn) (i32.const 64))))
            (if (i32.eq (local.get $reg) (local.get $ld_base))
              (then
                (local.set $src_cnt (i32.add (local.get $src_cnt) (i32.const 1)))
                (local.set $src_stride (local.get $step))
                (local.set $src_idx (local.get $i)))
              (else (if (i32.eq (local.get $reg) (local.get $st_base))
                (then
                  (local.set $dst_cnt (i32.add (local.get $dst_cnt) (i32.const 1)))
                  (local.set $dst_stride (local.get $step))
                  (local.set $dst_idx (local.get $i)))
                (else
                  (local.set $ctr_cnt (i32.add (local.get $ctr_cnt) (i32.const 1)))
                  (local.set $ctr_loc (local.get $reg))
                  (local.set $ctr_step (local.get $step))
                  (local.set $ctr_idx (local.get $i))))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $p2)))

    ;; Both cursors stepped exactly once; no fourth increment.
    (if (i32.ne (local.get $src_cnt) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $dst_cnt) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.ne (i32.add (local.get $ctr_cnt) (local.get $mem_cnt)) (i32.const 1))
      (then (return (i32.const 0))))
    (if (i32.ne (local.get $addi_cnt)
                (i32.add (i32.const 2) (local.get $ctr_cnt)))
      (then (return (i32.const 0))))

    ;; A counter in memory needs a loop-invariant address, or it is not one
    ;; counter but a walk over several.
    (if (local.get $mem_cnt)
      (then
        (if (i32.and (local.get $written)
              (i32.shl (i32.const 1) (local.get $mem_base)))
          (then (return (i32.const 0))))
        (local.set $ctr_kind (i32.const 1))
        (local.set $ctr_loc (local.get $mem_base))
        (local.set $ctr_disp (local.get $mem_disp))
        (local.set $ctr_step (local.get $mem_step))
        (local.set $ctr_idx (local.get $mem_idx))))

    ;; Only the count-down-to-zero form: the branch reads the counter's flags,
    ;; so the counter has to be the last thing that set them.
    (local.set $p (call $loop_op_at (i32.sub (local.get $n) (i32.const 1))))
    (if (i32.ne (i32.load (local.get $p)) (i32.const 312)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $ctr_idx) (i32.sub (local.get $n) (i32.const 2)))
      (then (return (i32.const 0))))

    ;; Fold the cursor bumps into the displacements. The super-op bumps AFTER
    ;; the access, so an access the original performed after its own bump saw
    ;; a cursor one stride ahead.
    (if (i32.lt_u (local.get $src_idx) (local.get $ld_idx))
      (then (local.set $ld_disp (i32.add (local.get $ld_disp) (local.get $src_stride)))))
    (if (i32.lt_u (local.get $dst_idx) (local.get $st_idx))
      (then (local.set $st_disp (i32.add (local.get $st_disp) (local.get $dst_stride)))))

    ;; ---- emit ----
    (global.set $loop_matched_blocks
      (i32.add (global.get $loop_matched_blocks) (i32.const 1)))
    ;; Marker 0x100B0002 = COPY_RUN, then the entry EIP. See the LUT_RUN one.
    (if (global.get $loop_trace)
      (then
        (call $host_log_i32 (i32.const 0x100B0002))
        (call $host_log_i32 (local.get $start_eip))))
    (if (i32.eqz (call $loop_copy_emit_get)) (then (return (i32.const 0))))

    (local.set $fall (i32.load offset=8
      (call $loop_op_at (i32.sub (local.get $n) (i32.const 1)))))
    (global.set $thread_alloc (local.get $tstart))
    (global.set $op_index_n (i32.const 0))
    (call $te (global.get $LOOP_SUPEROP_COPY) (i32.const 0))
    (call $te_raw (local.get $ld_base))
    (call $te_raw (local.get $src_stride))
    (call $te_raw (local.get $ld_disp))
    (call $te_raw (local.get $st_base))
    (call $te_raw (local.get $dst_stride))
    (call $te_raw (local.get $st_disp))
    (call $te_raw (local.get $ld_reg))
    (call $te_raw (local.get $ctr_kind))
    (call $te_raw (local.get $ctr_loc))
    (call $te_raw (local.get $ctr_disp))
    (call $te_raw (local.get $ctr_step))
    (call $te_raw (local.get $fall))
    (call $te_raw (local.get $start_eip))
    (call $te_raw (local.get $n))
    (i32.const 1))

  ;; Bytes a cursor can still touch before it leaves the 4 KB page it sits in,
  ;; counting the byte under it. $g2w is affine within a map record, and a
  ;; sparse reservation committed in pieces gets one record per commit, so a
  ;; page is the largest span whose guest->WASM delta is guaranteed constant.
  ;; This is the same invariant $gl32 relies on when it skips its cross-page
  ;; gather. LUT16 additionally uses +/-2 destination strides.
  (func $copy_page_room (param $ga i32) (param $stride i32) (result i32)
    (local $off i32)
    (local.set $off (i32.and (local.get $ga) (i32.const 0xFFF)))
    (if (i32.gt_s (local.get $stride) (i32.const 0))
      (then
        (return
          (i32.add
            (i32.div_u (i32.sub (i32.const 0xFFF) (local.get $off))
                       (local.get $stride))
            (i32.const 1)))))
    (i32.add
      (i32.div_u (local.get $off) (i32.sub (i32.const 0) (local.get $stride)))
      (i32.const 1)))

  ;; Fixed descriptor selected by H419 operand bit 31:
  ;;
  ;;   add ebx,ebx / jae tail
  ;;   movq mm0..3,[esi+0/8/16/24]
  ;;   movq [edi+0/8/16/24],mm0..3
  ;; tail: add edi,eax / add esi,32 / dec edx / jnz back
  ;;
  ;; Both fast store strategies preload the complete source row into two v128
  ;; values. That is required for overlap-safe x86 semantics and because the
  ;; routine returns without EMMS: the final mm0..mm3 values are architecturally
  ;; observable. The bulk arm then deliberately rereads those bytes through
  ;; memory.copy; the benchmark decides whether its optimized memmove beats two
  ;; v128 stores despite that extra read.
  (func $th_mmx_mask_copy32 (param $op i32)
    (local $tp i32) (local $fall i32) (local $back i32)
    (local $mask i32) (local $pitch i32) (local $src i32) (local $dst i32)
    (local $count i32) (local $old_src i32) (local $old_count i32)
    (local $src_wa i32) (local $dst_wa i32)
    (local $v0 v128) (local $v1 v128)
    (local $q0 i64) (local $q1 i64) (local $q2 i64) (local $q3 i64)
    (local $charge i32) (local $cost i32) (local $copied i32)
    (local $iterations i32) (local $copy_count i32)

    (local.set $tp (global.get $ip))
    (global.set $ip (i32.add (local.get $tp) (i32.const 8)))
    (local.set $fall (i32.load (local.get $tp)))
    (local.set $back (i32.load offset=4 (local.get $tp)))
    (local.set $mask (global.get $ebx))
    (local.set $pitch (global.get $eax))
    (local.set $src (global.get $esi))
    (local.set $dst (global.get $edi))
    (local.set $count (global.get $edx))
    (global.set $mmx_mask_copy_runs
      (i32.add (global.get $mmx_mask_copy_runs) (i32.const 1)))

    (block $done
      (loop $rows
        (local.set $old_src (local.get $src))
        (local.set $old_count (local.get $count))
        ;; ADD EBX,EBX; JAE selects the copy from the bit shifted into CF.
        (local.set $copied (i32.lt_s (local.get $mask) (i32.const 0)))
        (local.set $mask (i32.shl (local.get $mask) (i32.const 1)))
        (local.set $cost (select (i32.const 22) (i32.const 6) (local.get $copied)))

        (if (local.get $copied)
          (then
            (local.set $copy_count (i32.add (local.get $copy_count) (i32.const 1)))
            ;; A page-local translation is affine for the whole row. Sparse
            ;; commits and DIB backing are page-granular; anything crossing a
            ;; page or resolving to NULL uses the exact four MMX helpers below.
            (if (i32.and
                  (i32.le_u (i32.and (local.get $src) (i32.const 0xFFF)) (i32.const 0xFE0))
                  (i32.le_u (i32.and (local.get $dst) (i32.const 0xFFF)) (i32.const 0xFE0)))
              (then
                (local.set $src_wa (call $g2w (local.get $src)))
                (local.set $dst_wa (call $g2w (local.get $dst))))
              (else
                (local.set $src_wa (global.get $NULL_SENTINEL))
                (local.set $dst_wa (global.get $NULL_SENTINEL))))
            (if (i32.and
                  (i32.ne (local.get $src_wa) (global.get $NULL_SENTINEL))
                  (i32.ne (local.get $dst_wa) (global.get $NULL_SENTINEL)))
              (then
                ;; Preload before either store: this is also the MMX result.
                (local.set $v0 (v128.load (local.get $src_wa)))
                (local.set $v1 (v128.load offset=16 (local.get $src_wa)))
                (local.set $q0 (i64x2.extract_lane 0 (local.get $v0)))
                (local.set $q1 (i64x2.extract_lane 1 (local.get $v0)))
                (local.set $q2 (i64x2.extract_lane 0 (local.get $v1)))
                (local.set $q3 (i64x2.extract_lane 1 (local.get $v1)))
                (call $invalidate_code_write (local.get $dst) (i32.const 32))
                (if (global.get $mmx_mask_copy_use_bulk)
                  (then
                    (memory.copy (local.get $dst_wa) (local.get $src_wa) (i32.const 32)))
                  (else
                    (v128.store (local.get $dst_wa) (local.get $v0))
                    (v128.store offset=16 (local.get $dst_wa) (local.get $v1)))))
              (else
                ;; Load all four values before storing any, matching the eight
                ;; original MOVQs even for overlapping or split mappings.
                (local.set $q0 (call $mmx_load64 (local.get $src)))
                (local.set $q1 (call $mmx_load64
                  (i32.add (local.get $src) (i32.const 8))))
                (local.set $q2 (call $mmx_load64
                  (i32.add (local.get $src) (i32.const 16))))
                (local.set $q3 (call $mmx_load64
                  (i32.add (local.get $src) (i32.const 24))))
                (call $mmx_store64 (local.get $dst) (local.get $q0))
                (call $mmx_store64 (i32.add (local.get $dst) (i32.const 8)) (local.get $q1))
                (call $mmx_store64 (i32.add (local.get $dst) (i32.const 16)) (local.get $q2))
                (call $mmx_store64 (i32.add (local.get $dst) (i32.const 24)) (local.get $q3))))))

        ;; The tail executes for selected and transparent rows alike.
        (local.set $dst (i32.add (local.get $dst) (local.get $pitch)))
        (local.set $src (i32.add (local.get $src) (i32.const 32)))
        (local.set $count (i32.sub (local.get $count) (i32.const 1)))
        (local.set $iterations (i32.add (local.get $iterations) (i32.const 1)))
        (local.set $charge (i32.add (local.get $charge) (local.get $cost)))
        (br_if $done (i32.eqz (local.get $count)))
        ;; $next already charged one dispatch before entering H419. Stop after
        ;; the same iteration that would spend the remaining threaded budget.
        (br_if $done
          (i32.ge_u (i32.sub (local.get $charge) (i32.const 1))
                    (global.get $steps)))
        (br $rows)))

    (global.set $ebx (local.get $mask))
    (global.set $esi (local.get $src))
    (global.set $edi (local.get $dst))
    (global.set $edx (local.get $count))
    ;; DEC preserves the carry produced by the preceding ADD ESI,32.
    (call $set_flags_add (local.get $old_src) (i32.const 32) (local.get $src))
    (call $set_flags_dec (local.get $old_count) (local.get $count))
    (if (local.get $copy_count)
      (then
        (call $mmx_set (i32.const 0) (local.get $q0))
        (call $mmx_set (i32.const 1) (local.get $q1))
        (call $mmx_set (i32.const 2) (local.get $q2))
        (call $mmx_set (i32.const 3) (local.get $q3))))
    (global.set $mmx_exec_count
      (i32.add (global.get $mmx_exec_count)
        (i32.mul (local.get $copy_count) (i32.const 8))))
    (global.set $mmx_mask_copy_rows
      (i64.add (global.get $mmx_mask_copy_rows) (i64.extend_i32_u (local.get $iterations))))
    (global.set $mmx_mask_copy_bytes
      (i64.add (global.get $mmx_mask_copy_bytes)
        (i64.extend_i32_u
          (i32.mul (local.get $copy_count) (i32.const 32)))))
    (global.set $steps
      (i32.sub (global.get $steps) (i32.sub (local.get $charge) (i32.const 1))))
    (global.set $eip
      (select (local.get $back) (local.get $fall) (i32.ne (local.get $count) (i32.const 0)))))

  ;; ------------------------------------------------------------------
  ;; 419: the COPY_RUN super-op.
  ;; ------------------------------------------------------------------
  ;; Same contract as 418: charge $steps at the body's op count so batch
  ;; granularity is unchanged, and republish $eip at the loop entry when the
  ;; budget runs out.
  ;;
  ;; A memory-resident counter is written back on every iteration rather than
  ;; once at exit. It is one extra store against six eliminated dispatches, and
  ;; it means the destination range is allowed to cover the counter's own
  ;; address -- which is not a shape worth reasoning about at match time.
  (func $th_copy_run (param $op i32)
    (local $src_reg i32) (local $src_stride i32) (local $src_disp i32)
    (local $dst_reg i32) (local $dst_stride i32) (local $dst_disp i32)
    (local $byte_reg i32) (local $ctr_kind i32) (local $ctr_loc i32)
    (local $ctr_disp i32) (local $ctr_step i32)
    (local $fall i32) (local $back i32) (local $cost i32)
    (local $src i32) (local $dst i32) (local $ctr i32) (local $old i32)
    (local $ctr_addr i32) (local $b i32) (local $tp i32) (local $store_ctr i32)
    (local $lo i32) (local $hi i32)
    (local $src_ga i32) (local $dst_ga i32) (local $src_wa i32) (local $dst_wa i32)
    (local $chunk i32) (local $trips i32) (local $allowed i32) (local $n i32)
    (local $bound i32) (local $round_quantum i32) (local $private_bytes i32)
    (local $private_limit i32) (local $private_groups i32)
    (local $src_end i32) (local $dst_end i32) (local $copy32_overlap i32)

    (if (i32.lt_s (local.get $op) (i32.const 0))
      (then (return_call $th_mmx_mask_copy32 (local.get $op))))

    ;; Fourteen $read_thread_word calls would be fourteen calls and fourteen
    ;; global round trips on every entry, and this loop's measured average trip
    ;; count is about four iterations -- the parameter block is not amortized
    ;; over a long run the way a bulk memcpy's would be. Read it as offsets off
    ;; one base and bump $ip once.
    (local.set $tp (global.get $ip))
    (global.set $ip (i32.add (local.get $tp) (i32.const 56)))
    (local.set $src_reg    (i32.load          (local.get $tp)))
    (local.set $src_stride (i32.load offset=4  (local.get $tp)))
    (local.set $src_disp   (i32.load offset=8  (local.get $tp)))
    (local.set $dst_reg    (i32.load offset=12 (local.get $tp)))
    (local.set $dst_stride (i32.load offset=16 (local.get $tp)))
    (local.set $dst_disp   (i32.load offset=20 (local.get $tp)))
    (local.set $byte_reg   (i32.load offset=24 (local.get $tp)))
    (local.set $ctr_kind   (i32.load offset=28 (local.get $tp)))
    (local.set $ctr_loc    (i32.load offset=32 (local.get $tp)))
    (local.set $ctr_disp   (i32.load offset=36 (local.get $tp)))
    (local.set $ctr_step   (i32.load offset=40 (local.get $tp)))
    (local.set $fall       (i32.load offset=44 (local.get $tp)))
    (local.set $back       (i32.load offset=48 (local.get $tp)))
    (local.set $cost       (i32.load offset=52 (local.get $tp)))

    (local.set $src (call $get_reg (local.get $src_reg)))
    (local.set $dst (call $get_reg (local.get $dst_reg)))
    (if (i32.eq (local.get $ctr_kind) (i32.const 2))
      (then
        (local.set $round_quantum (local.get $ctr_disp))
        (local.set $bound (call $get_reg (local.get $ctr_loc)))
        ;; The original is do-while. At/above the bound it still performs one
        ;; element; below it, round the unsigned distance up to a whole element.
        ;; A near-4GB distance would overflow the round-up, so keep the safe
        ;; one-element progress form for that nonsensical mapping.
        (if (i32.and
              (i32.lt_u (local.get $dst) (local.get $bound))
              (i32.le_u (i32.sub (local.get $bound) (local.get $dst))
                        (i32.sub (i32.const -1)
                          (i32.sub (local.get $round_quantum) (i32.const 1)))))
          (then
            (local.set $ctr
              (i32.mul
                (i32.div_u
                  (i32.add (i32.sub (local.get $bound) (local.get $dst))
                    (i32.sub (local.get $round_quantum) (i32.const 1)))
                  (local.get $round_quantum))
                (local.get $round_quantum))))
          (else (local.set $ctr (local.get $round_quantum))))

        ;; Budget only at complete guest-element boundaries. The suffix owns
        ;; the final scratch/CMP/Jcc, so reserve its three threaded ops in the
        ;; accounting performed at exit below.
        (local.set $allowed
          (i32.div_u
            (i32.add
              (select (global.get $steps) (i32.const 0)
                (i32.gt_s (global.get $steps) (i32.const 0)))
              (i32.sub (local.get $cost) (i32.const 1)))
            (local.get $cost)))
        (if (i32.eqz (local.get $allowed))
          (then (local.set $allowed (i32.const 1))))
        (local.set $private_limit
          (i32.mul (local.get $allowed) (local.get $round_quantum)))
        (if (i32.gt_u (local.get $private_limit) (local.get $ctr))
          (then (local.set $private_limit (local.get $ctr))))

        ;; Byte-forward copy and dword-forward copy disagree for sub-dword
        ;; overlap. Use the shared byte kernel only for proved-disjoint spans;
        ;; the overlapping arm below executes one original-width load/store.
        (local.set $src_ga (i32.add (local.get $src) (local.get $src_disp)))
        (local.set $dst_ga (i32.add (local.get $dst) (local.get $dst_disp)))
        (local.set $src_end (i32.add (local.get $src_ga) (local.get $ctr)))
        (local.set $dst_end (i32.add (local.get $dst_ga) (local.get $ctr)))
        (local.set $copy32_overlap
          (i32.or
            (i32.or (i32.lt_u (local.get $src_end) (local.get $src_ga))
                    (i32.lt_u (local.get $dst_end) (local.get $dst_ga)))
            (i32.and (i32.lt_u (local.get $src_ga) (local.get $dst_end))
                     (i32.lt_u (local.get $dst_ga) (local.get $src_end)))))
        (global.set $loop_copy32_runs
          (i32.add (global.get $loop_copy32_runs) (i32.const 1))))
      (else (if (i32.eq (local.get $ctr_kind) (i32.const 1))
        (then
        (local.set $ctr_addr
          (i32.add (call $get_reg (local.get $ctr_loc)) (local.get $ctr_disp)))
        (local.set $ctr (call $gl32 (local.get $ctr_addr))))
        (else (local.set $ctr (call $get_reg (local.get $ctr_loc)))))))

    ;; A memory counter has to be written back per iteration in general: the
    ;; destination range is allowed to cover the counter's own address, and a
    ;; deferred write would then lose whatever the copy put there. But that is
    ;; a pathological shape, and it is cheap to rule out here, where the run
    ;; length is known: at most $ctr bytes starting at the destination cursor.
    ;; When the counter sits outside that span, write it once at exit.
    (local.set $store_ctr
      (select (i32.const 1) (i32.const 0)
        (i32.eq (local.get $ctr_kind) (i32.const 1))))
    (if (i32.and (i32.eq (local.get $ctr_kind) (i32.const 1))
                 (i32.and (i32.eq (local.get $ctr_step) (i32.const -1))
                          (i32.gt_s (local.get $ctr) (i32.const 0))))
      (then
        (local.set $lo (i32.add (local.get $dst) (local.get $dst_disp)))
        (local.set $hi (local.get $lo))
        (if (i32.eq (local.get $dst_stride) (i32.const 1))
          (then (local.set $hi (i32.add (local.get $lo)
                  (i32.sub (local.get $ctr) (i32.const 1)))))
          (else (local.set $lo (i32.sub (local.get $hi)
                  (i32.sub (local.get $ctr) (i32.const 1))))))
        ;; An address range that wrapped tells us nothing; leave it per-iteration.
        (if (i32.le_u (local.get $lo) (local.get $hi))
          (then
            (if (i32.or
                  (i32.lt_u (i32.add (local.get $ctr_addr) (i32.const 3)) (local.get $lo))
                  (i32.gt_u (local.get $ctr_addr) (local.get $hi)))
              (then (local.set $store_ctr (i32.const 0))))))))

    ;; The run is copied a page-chunk at a time rather than a byte at a time.
    ;; Per byte, $gl8 was a call plus a page-cache probe and $gs8 was a call
    ;; plus a full $g2w plus a code-page test; none of that can change inside a
    ;; chunk. Guest mappings are only created by API calls (VirtualAlloc, file
    ;; mapping, DLL load), no guest code runs while this handler is on the
    ;; stack, and map records are append-only -- so a translation resolved at
    ;; chunk entry stays valid for the whole chunk. What is left in the inner
    ;; loop is two raw accesses and two pointer bumps.
    (block $exit
      (loop $outer
        (local.set $src_ga (i32.add (local.get $src) (local.get $src_disp)))
        (local.set $dst_ga (i32.add (local.get $dst) (local.get $dst_disp)))

        ;; Iterations left before the counter reaches zero. The loop is
        ;; do-while, so a counter that is already zero runs the whole wrap.
        (local.set $trips
          (select (local.get $ctr)
                  (i32.sub (i32.const 0) (local.get $ctr))
                  (i32.eq (local.get $ctr_step) (i32.const -1))))
        (if (i32.eqz (local.get $trips))
          (then (local.set $trips (i32.const -1))))

        ;; Iterations the step budget still pays for. The original exits after
        ;; the first iteration that drives $steps to zero or below, so this is
        ;; a ceiling, and a budget already spent still buys one iteration.
        (if (i32.eq (local.get $ctr_kind) (i32.const 2))
          (then
            (local.set $allowed
              (i32.sub (local.get $private_limit) (local.get $private_bytes))))
          (else
            (local.set $allowed
              (i32.div_u
                (i32.add
                  (select (global.get $steps) (i32.const 0)
                          (i32.gt_s (global.get $steps) (i32.const 0)))
                  (i32.sub (local.get $cost) (i32.const 1)))
                (local.get $cost)))
            (if (i32.eqz (local.get $allowed))
              (then (local.set $allowed (i32.const 1))))))

        (local.set $chunk
          (select (local.get $trips) (local.get $allowed)
                  (i32.lt_u (local.get $trips) (local.get $allowed))))
        (local.set $n (call $copy_page_room (local.get $src_ga) (local.get $src_stride)))
        (local.set $chunk
          (select (local.get $n) (local.get $chunk)
                  (i32.lt_u (local.get $n) (local.get $chunk))))
        (local.set $n (call $copy_page_room (local.get $dst_ga) (local.get $dst_stride)))
        (local.set $chunk
          (select (local.get $n) (local.get $chunk)
                  (i32.lt_u (local.get $n) (local.get $chunk))))

        (local.set $src_wa (call $g2w (local.get $src_ga)))
        (local.set $dst_wa (call $g2w (local.get $dst_ga)))
        ;; An unmapped cursor resolves to the four-byte null sentinel, which is
        ;; not a page and must never be walked; and a counter that has to be
        ;; published every step has no chunked form. One iteration per chunk is
        ;; exactly the old per-byte behaviour in both cases.
        (if (i32.or
              (i32.ne (local.get $store_ctr) (i32.const 0))
              (i32.or
                (i32.eq (local.get $src_wa) (global.get $NULL_SENTINEL))
                (i32.eq (local.get $dst_wa) (global.get $NULL_SENTINEL))))
          (then (local.set $chunk (i32.const 1))))

        ;; One code-page test for the whole chunk. The chunk cannot leave the
        ;; destination page and nothing executes between its first and last
        ;; store, so invalidating up front is what invalidating per byte did.
        ;;
        ;; The destination stride can be negative and larger than one byte, so
        ;; the exact extent is not simply [dst_ga, dst_ga+chunk). Since the
        ;; chunk is known to stay inside one page, name the page instead: that
        ;; is what this call has always meant, and $invalidate_code_range turns
        ;; a span this wide into the page drop the old $invalidate_page did.
        (if (i32.and
              (i32.eq (local.get $ctr_kind) (i32.const 2))
              (i32.or (local.get $copy32_overlap)
                (i32.or
                  (i32.eq (local.get $src_wa) (global.get $NULL_SENTINEL))
                  (i32.eq (local.get $dst_wa) (global.get $NULL_SENTINEL)))))
          (then
            ;; Preserve the original load-before-store width on overlap and
            ;; on the unmapped four-byte sentinel. This arm completes exactly
            ;; one guest iteration even when either dword crosses a page.
            (local.set $chunk (local.get $round_quantum))
            (local.set $b (call $gl32 (local.get $src_ga)))
            (call $gs32 (local.get $dst_ga) (local.get $b)))
          (else
            (call $invalidate_code_write
              (i32.and (local.get $dst_ga) (i32.const 0xFFFFF000)) (i32.const 4096))

            (local.set $n (local.get $chunk))
            (loop $inner
              (local.set $b (i32.load8_u (local.get $src_wa)))
              (i32.store8 (local.get $dst_wa) (local.get $b))
              (local.set $src_wa (i32.add (local.get $src_wa) (local.get $src_stride)))
              (local.set $dst_wa (i32.add (local.get $dst_wa) (local.get $dst_stride)))
              (local.set $n (i32.sub (local.get $n) (i32.const 1)))
              (br_if $inner (local.get $n)))))

        (local.set $src
          (i32.add (local.get $src) (i32.mul (local.get $chunk) (local.get $src_stride))))
        (local.set $dst
          (i32.add (local.get $dst) (i32.mul (local.get $chunk) (local.get $dst_stride))))
        (local.set $ctr
          (i32.add (local.get $ctr) (i32.mul (local.get $chunk) (local.get $ctr_step))))
        ;; The flags the terminator reads belong to the last iteration only.
        (local.set $old (i32.sub (local.get $ctr) (local.get $ctr_step)))
        (if (local.get $store_ctr)
          (then (call $gs32 (local.get $ctr_addr) (local.get $ctr))))
        (if (i32.eq (local.get $ctr_kind) (i32.const 2))
          (then
            (local.set $private_bytes
              (i32.add (local.get $private_bytes) (local.get $chunk))))
          (else
            (global.set $steps
              (i32.sub (global.get $steps)
                (i32.mul (local.get $chunk) (local.get $cost))))))
        (br_if $exit (i32.eqz (local.get $ctr)))
        (if (i32.eq (local.get $ctr_kind) (i32.const 2))
          (then
            (br_if $exit
              (i32.ge_u (local.get $private_bytes) (local.get $private_limit))))
          (else
            (br_if $exit (i32.le_s (global.get $steps) (i32.const 0)))))
        (br $outer)))

    (call $set_reg (local.get $src_reg) (local.get $src))
    (call $set_reg (local.get $dst_reg) (local.get $dst))
    (if (i32.ge_s (local.get $byte_reg) (i32.const 0))
      (then (call $set_reg8 (local.get $byte_reg) (local.get $b))))
    (if (i32.eqz (local.get $ctr_kind))
      (then (call $set_reg (local.get $ctr_loc) (local.get $ctr)))
      (else (if (i32.and
                  (i32.eq (local.get $ctr_kind) (i32.const 1))
                  (i32.eqz (local.get $store_ctr)))
        (then (call $gs32 (local.get $ctr_addr) (local.get $ctr))))))
    (if (i32.eq (local.get $ctr_kind) (i32.const 2))
      (then
        (global.set $loop_copy32_bytes
          (i64.add (global.get $loop_copy32_bytes)
            (i64.extend_i32_u (local.get $private_bytes))))
        (local.set $private_groups
          (i32.div_u (local.get $private_bytes) (local.get $round_quantum)))
        ;; $next already charged H419 and will charge the retained scratch
        ;; load, CMP and Jcc. Charge the remaining original ops for N complete
        ;; six-op guest iterations, then account for the N-1 folded backedges.
        (if (i32.gt_u
              (i32.mul (local.get $private_groups) (local.get $cost))
              (i32.const 4))
          (then
            (global.set $steps
              (i32.sub (global.get $steps)
                (i32.sub
                  (i32.mul (local.get $private_groups) (local.get $cost))
                  (i32.const 4))))))
        (if (i32.gt_u (local.get $private_groups) (i32.const 1))
          (then
            (global.set $block_budget
              (i32.sub (global.get $block_budget)
                (i32.sub (local.get $private_groups) (i32.const 1))))))
        (return_call $next)))
    (if (i32.eq (local.get $ctr_step) (i32.const -1))
      (then (call $set_flags_dec (local.get $old) (local.get $ctr)))
      (else (call $set_flags_inc (local.get $old) (local.get $ctr))))
    (global.set $eip
      (select (local.get $back) (local.get $fall) (i32.ne (local.get $ctr) (i32.const 0)))))

  ;; ------------------------------------------------------------------
  ;; 435: PACKED_AVG_RUN
  ;; ------------------------------------------------------------------
  ;; Collapse every iteration before the final one, then continue into an
  ;; ordinary copy of the complete final guest iteration. That suffix owns all
  ;; architectural scratch registers and flags; this handler only publishes
  ;; stream cursors and the induction register at a guest-iteration boundary.
  ;;
  ;; op selects the arithmetic:
  ;;   0 WIDE_ADD_SHIFT:     u32((u64(a&mask) + u64(b&mask)) >> 1)
  ;;   1 SHIFT_MASK_ADD:     ((a>>1)&mask) + ((b>>1)&mask)
  ;;   2 SHIFT_MASK_ADD_LSB: mode 1 + (a&b&round_mask)
  ;;
  ;; Descriptor words:
  ;;   0 mask  1 round_mask
  ;;   2..6   src A: base_reg,index_reg(-1 none),scale,disp,base_step
  ;;   7..11  src B: base_reg,index_reg(-1 none),scale,disp,base_step
  ;;   12..16 dst:   base_reg,index_reg(-1 none),scale,disp,base_step
  ;;   17 induction_reg  18 induction_step
  ;;   19 termination (0 count-down/JNZ leaves 1, 1 signed-index/JGE leaves 0)
  ;;   20 original handlers per iteration
  (global $LOOP_SUPEROP_AVG i32 (i32.const 435))

  (func $packed_avg_addr
    (param $base i32) (param $index_reg i32) (param $ind_reg i32)
    (param $ind i32) (param $scale i32) (param $disp i32) (result i32)
    (local $index i32)
    (if (i32.ge_s (local.get $index_reg) (i32.const 0))
      (then
        (local.set $index
          (select (local.get $ind) (call $get_reg (local.get $index_reg))
            (i32.eq (local.get $index_reg) (local.get $ind_reg))))))
    (i32.add (i32.add (local.get $base)
      (i32.shl (local.get $index) (local.get $scale))) (local.get $disp)))

  (func $th_packed_avg_run (param $mode i32)
    (local $mask i32) (local $round_mask i32)
    (local $a_base_reg i32) (local $a_index i32) (local $a_scale i32)
    (local $a_disp i32) (local $a_step i32) (local $a_base i32)
    (local $b_base_reg i32) (local $b_index i32) (local $b_scale i32)
    (local $b_disp i32) (local $b_step i32) (local $b_base i32)
    (local $d_base_reg i32) (local $d_index i32) (local $d_scale i32)
    (local $d_disp i32) (local $d_step i32) (local $d_base i32)
    (local $ind_reg i32) (local $ind_step i32) (local $term i32)
    (local $cost i32) (local $ind i32) (local $remaining i32)
    (local $allowed i32) (local $n i32) (local $done i32)
    (local $a i32) (local $b i32) (local $v i32) (local $sum i64)

    (local.set $mask (call $read_thread_word))
    (local.set $round_mask (call $read_thread_word))
    (local.set $a_base_reg (call $read_thread_word))
    (local.set $a_index (call $read_thread_word))
    (local.set $a_scale (call $read_thread_word))
    (local.set $a_disp (call $read_thread_word))
    (local.set $a_step (call $read_thread_word))
    (local.set $b_base_reg (call $read_thread_word))
    (local.set $b_index (call $read_thread_word))
    (local.set $b_scale (call $read_thread_word))
    (local.set $b_disp (call $read_thread_word))
    (local.set $b_step (call $read_thread_word))
    (local.set $d_base_reg (call $read_thread_word))
    (local.set $d_index (call $read_thread_word))
    (local.set $d_scale (call $read_thread_word))
    (local.set $d_disp (call $read_thread_word))
    (local.set $d_step (call $read_thread_word))
    (local.set $ind_reg (call $read_thread_word))
    (local.set $ind_step (call $read_thread_word))
    (local.set $term (call $read_thread_word))
    (local.set $cost (call $read_thread_word))

    (local.set $a_base (call $get_reg (local.get $a_base_reg)))
    (local.set $b_base (call $get_reg (local.get $b_base_reg)))
    (local.set $d_base (call $get_reg (local.get $d_base_reg)))
    (local.set $ind (call $get_reg (local.get $ind_reg)))
    ;; The suffix executes one original iteration. Fold only the iterations
    ;; before it, so a zero/negative do-while entry naturally stays ordinary.
    (if (local.get $term)
      (then
        (if (i32.gt_s (local.get $ind) (i32.const 0))
          (then (local.set $remaining (local.get $ind)))))
      (else
        (if (i32.gt_u (local.get $ind) (i32.const 1))
          (then (local.set $remaining (i32.sub (local.get $ind) (i32.const 1)))))))

    (local.set $allowed
      (i32.div_u
        (i32.add
          (select (global.get $steps) (i32.const 0)
            (i32.gt_s (global.get $steps) (i32.const 0)))
          (i32.sub (local.get $cost) (i32.const 1)))
        (local.get $cost)))
    (local.set $n
      (select (local.get $remaining) (local.get $allowed)
        (i32.lt_u (local.get $remaining) (local.get $allowed))))
    (local.set $done (local.get $n))

    (block $finished
      (loop $pixels
        (br_if $finished (i32.eqz (local.get $done)))
        ;; Preserve the guest's load-A, load-B, store order for overlap.
        (local.set $a (call $gl32 (call $packed_avg_addr
          (local.get $a_base) (local.get $a_index) (local.get $ind_reg)
          (local.get $ind) (local.get $a_scale) (local.get $a_disp))))
        (local.set $b (call $gl32 (call $packed_avg_addr
          (local.get $b_base) (local.get $b_index) (local.get $ind_reg)
          (local.get $ind) (local.get $b_scale) (local.get $b_disp))))
        (if (i32.eqz (local.get $mode))
          (then
            (local.set $sum
              (i64.add
                (i64.extend_i32_u (i32.and (local.get $a) (local.get $mask)))
                (i64.extend_i32_u (i32.and (local.get $b) (local.get $mask)))))
            (local.set $v
              (i32.wrap_i64 (i64.shr_u (local.get $sum) (i64.const 1)))))
          (else
            (local.set $v
              (i32.add
                (i32.and (i32.shr_u (local.get $a) (i32.const 1)) (local.get $mask))
                (i32.and (i32.shr_u (local.get $b) (i32.const 1)) (local.get $mask))))
            (if (i32.eq (local.get $mode) (i32.const 2))
              (then (local.set $v (i32.add (local.get $v)
                (i32.and (i32.and (local.get $a) (local.get $b))
                  (local.get $round_mask))))))))
        (call $gs32 (call $packed_avg_addr
          (local.get $d_base) (local.get $d_index) (local.get $ind_reg)
          (local.get $ind) (local.get $d_scale) (local.get $d_disp)) (local.get $v))

        (local.set $a_base (i32.add (local.get $a_base) (local.get $a_step)))
        (local.set $b_base (i32.add (local.get $b_base) (local.get $b_step)))
        (local.set $d_base (i32.add (local.get $d_base) (local.get $d_step)))
        (local.set $ind (i32.add (local.get $ind) (local.get $ind_step)))
        (local.set $done (i32.sub (local.get $done) (i32.const 1)))
        (br $pixels)))

    (if (local.get $n)
      (then
        (if (local.get $a_step)
          (then (call $set_reg (local.get $a_base_reg) (local.get $a_base))))
        (if (local.get $b_step)
          (then (call $set_reg (local.get $b_base_reg) (local.get $b_base))))
        (if (local.get $d_step)
          (then (call $set_reg (local.get $d_base_reg) (local.get $d_base))))
        (call $set_reg (local.get $ind_reg) (local.get $ind))))
    (global.set $loop_avg_runs
      (i32.add (global.get $loop_avg_runs) (i32.const 1)))
    (global.set $loop_avg_pixels
      (i64.add (global.get $loop_avg_pixels) (i64.extend_i32_u (local.get $n))))
    ;; H435 and the ordinary suffix are charged automatically. Replace H435's
    ;; extra charge with the cost of the N folded guest iterations.
    (global.set $steps
      (i32.sub (global.get $steps)
        (i32.sub (i32.mul (local.get $n) (local.get $cost)) (i32.const 1))))
    (global.set $block_budget
      (i32.sub (global.get $block_budget) (local.get $n)))
    (return_call $next))

  ;; ------------------------------------------------------------------
  ;; 436: MW3 bound-derived RGB565 alpha row
  ;; ------------------------------------------------------------------
  ;; Replay the exact three-arm loop at mech3demo!0x528064. The row bound,
  ;; alpha cursor and destination cursor remain in the guest's own frame slots;
  ;; publishing them after every pixel preserves the ordinary loop's visible
  ;; state even when the 4096-pixel safety quantum hands control back early.
  (func $th_rgb565_alpha_run (param $op i32)
    (local $bp i32) (local $eax i32) (local $ecx i32) (local $edx i32)
    (local $ebx i32) (local $esi i32) (local $edi i32)
    (local $alpha i32) (local $count i32) (local $old_count i32)
    (local $iters i32) (local $cost i32) (local $cont i32)

    (local.set $bp (global.get $ebp))
    (local.set $eax (global.get $eax))
    (local.set $ecx (global.get $ecx))
    (local.set $edx (global.get $edx))
    (local.set $ebx (global.get $ebx))
    (local.set $esi (global.get $esi))
    (local.set $edi (global.get $edi))
    (local.set $count (call $gl32 (i32.add (local.get $bp) (i32.const -24))))

    (block $done (loop $pixels
      ;; A normal entry is dominated by TEST count / JLE exit. Keep a corrupt
      ;; or direct zero entry bounded instead of manufacturing 2^32 pixels.
      (br_if $done (i32.le_s (local.get $count) (i32.const 0)))
      (br_if $done (i32.ge_u (local.get $iters) (i32.const 4096)))

      ;; mov ecx,[ebp+0xc] / mov cl,[ecx]
      (local.set $ecx (call $gl32 (i32.add (local.get $bp) (i32.const 12))))
      (local.set $alpha (call $gl8 (local.get $ecx)))
      (local.set $ecx
        (i32.or (i32.and (local.get $ecx) (i32.const 0xFFFFFF00))
                (local.get $alpha)))
      (local.set $cost (i32.add (local.get $cost) (i32.const 13)))

      (if (i32.gt_u (local.get $alpha) (i32.const 3))
        (then
          (local.set $cost (i32.add (local.get $cost) (i32.const 5)))
          (if (i32.ge_u (local.get $alpha) (i32.const 0xFC))
            (then
              ;; Opaque arm: copy the source RGB565 word verbatim.
              (local.set $ecx
                (i32.or (i32.and (local.get $ecx) (i32.const 0xFFFF0000))
                  (call $gl16 (i32.add (local.get $eax) (local.get $edi)))))
              (call $gs16 (local.get $eax) (local.get $ecx)))
            (else
              ;; Interpolate each RGB565 lane with the exact signed shifts and
              ;; low-byte fixups emitted by MSVC 5. No host colour conversion.
              (local.set $cost (i32.add (local.get $cost) (i32.const 35)))
              (local.set $esi (i32.extend16_s (call $gl16 (local.get $eax))))
              (local.set $edx
                (i32.extend16_s (call $gl16
                  (i32.add (local.get $eax) (local.get $edi)))))
              (local.set $edi (local.get $ecx))
              (local.set $ecx (local.get $edx))
              (local.set $eax (local.get $esi))
              (local.set $ecx (i32.and (local.get $ecx) (i32.const 0xF800)))
              (local.set $eax (i32.and (local.get $eax) (i32.const 0xF800)))
              (local.set $ebx (local.get $esi))
              (local.set $ecx (i32.sub (local.get $ecx) (local.get $eax)))
              (local.set $eax (local.get $edx))
              (local.set $eax (i32.and (local.get $eax) (i32.const 0x07E0)))
              (local.set $ebx (i32.and (local.get $ebx) (i32.const 0x07E0)))
              (local.set $edi (i32.and (local.get $edi) (i32.const 0xFF)))
              (local.set $eax (i32.sub (local.get $eax) (local.get $ebx)))
              (local.set $eax (i32.mul (local.get $eax) (local.get $edi)))
              (local.set $ecx (i32.mul (local.get $ecx) (local.get $edi)))
              (local.set $eax (i32.shr_s (local.get $eax) (i32.const 8)))
              (local.set $ecx (i32.shr_s (local.get $ecx) (i32.const 8)))
              (local.set $eax (i32.and (local.get $eax) (i32.const 0xFFFFFFE0)))
              (local.set $ecx (i32.and (local.get $ecx) (i32.const 0xFFFFF800)))
              (if (i32.lt_s (local.get $eax) (i32.const 0))
                (then (local.set $eax (i32.or (local.get $eax) (i32.const 0x20))))
                (else (local.set $eax
                  (i32.and (local.get $eax) (i32.const 0xFFFFFFDF)))))
              (local.set $esi (i32.add (local.get $esi) (local.get $ecx)))
              (local.set $edx (i32.and (local.get $edx) (i32.const 0x1F)))
              (local.set $ecx (i32.and (local.get $esi) (i32.const 0x1F)))
              (local.set $ebx (call $gl32
                (i32.add (local.get $bp) (i32.const -12))))
              (local.set $edx (i32.sub (local.get $edx) (local.get $ecx)))
              (local.set $edx (i32.mul (local.get $edx) (local.get $edi)))
              (local.set $edi (call $gl32
                (i32.add (local.get $bp) (i32.const -28))))
              (local.set $edx (i32.shr_s (local.get $edx) (i32.const 8)))
              (local.set $edx (i32.add (local.get $edx) (local.get $eax)))
              (local.set $eax (call $gl32
                (i32.add (local.get $bp) (i32.const -32))))
              (local.set $esi (i32.add (local.get $esi) (local.get $edx)))
              (local.set $edx (call $gl32
                (i32.add (local.get $bp) (i32.const -20))))
              (call $gs16 (local.get $eax) (local.get $esi))))))

      ;; Common induction tail. These stores are deliberately per pixel: the
      ;; guest frame is the loop's architectural bound/cursor state.
      (local.set $esi (call $gl32 (i32.add (local.get $bp) (i32.const 12))))
      (local.set $count (call $gl32 (i32.add (local.get $bp) (i32.const -24))))
      (local.set $eax (i32.add (local.get $eax) (i32.const 2)))
      (local.set $esi (i32.add (local.get $esi) (i32.const 1)))
      (local.set $old_count (local.get $count))
      (local.set $count (i32.sub (local.get $count) (i32.const 1)))
      (call $gs32 (i32.add (local.get $bp) (i32.const -32)) (local.get $eax))
      (call $gs32 (i32.add (local.get $bp) (i32.const 12)) (local.get $esi))
      (call $gs32 (i32.add (local.get $bp) (i32.const -24)) (local.get $count))
      (local.set $iters (i32.add (local.get $iters) (i32.const 1)))
      (br_if $pixels (local.get $count))))

    (global.set $eax (local.get $eax))
    (global.set $ecx (local.get $count))
    (global.set $edx (local.get $edx))
    (global.set $ebx (local.get $ebx))
    (global.set $esi (local.get $esi))
    (global.set $edi (local.get $edi))
    (if (local.get $iters)
      (then (call $set_flags_dec (local.get $old_count) (local.get $count))))
    (global.set $steps
      (i32.sub (global.get $steps)
        (i32.sub (local.get $cost) (i32.const 1))))
    (global.set $block_budget
      (i32.sub (global.get $block_budget) (local.get $iters)))
    (global.set $loop_rgb565_alpha_runs
      (i32.add (global.get $loop_rgb565_alpha_runs) (i32.const 1)))
    (global.set $loop_rgb565_alpha_pixels
      (i64.add (global.get $loop_rgb565_alpha_pixels)
        (i64.extend_i32_u (local.get $iters))))
    (local.set $cont (i32.ne (local.get $count) (i32.const 0)))
    (global.set $eip
      (select (i32.const 0x00528064) (i32.const 0x00528111) (local.get $cont)))
    (return_call $branch_end))

  ;; Called from $decode_block just before $cache_store.
  (func $loop_match_block (param $start_eip i32) (param $tstart i32)
    (if (global.get $op_index_poison) (then (return)))
    (if (i32.eqz (call $loop_is_selfloop (local.get $start_eip))) (then (return)))
    (global.set $loop_selfloop_blocks
      (i32.add (global.get $loop_selfloop_blocks) (i32.const 1)))
    (if (global.get $loop_trace)
      (then
        (if (i32.or (i32.eqz (global.get $loop_trace_eip))
                    (i32.eq (global.get $loop_trace_eip) (local.get $start_eip)))
          (then (call $loop_trace_block (local.get $start_eip))))))
    ;; Ordered cheapest-to-decline first; the predicates are disjoint (LUT_RUN
    ;; requires an indexed load and a zeroing op, COPY_RUN forbids both), so
    ;; the order is a cost choice, not a precedence one.
    (if (call $loop_try_aoe_grid_fill (local.get $start_eip) (local.get $tstart))
      (then (return)))
    (if (call $loop_try_lut16_counted (local.get $start_eip) (local.get $tstart))
      (then (return)))
    (if (call $loop_try_lut (local.get $start_eip) (local.get $tstart)) (then (return)))
    (if (call $loop_try_lut_bounded (local.get $start_eip) (local.get $tstart)) (then (return)))
    (if (call $loop_try_lut_blend_bounded (local.get $start_eip) (local.get $tstart))
      (then (return)))
    (if (call $loop_try_avg_wide_indexed (local.get $start_eip) (local.get $tstart))
      (then (return)))
    (if (call $loop_try_avg_shift_cursor (local.get $start_eip) (local.get $tstart))
      (then (return)))
    (if (call $loop_try_avg_round_cursor (local.get $start_eip) (local.get $tstart))
      (then (return)))
    (if (call $loop_try_copy32_bounded (local.get $start_eip) (local.get $tstart))
      (then (return)))
    (drop (call $loop_try_copy (local.get $start_eip) (local.get $tstart))))

  ;; ------------------------------------------------------------------
  ;; 437: AoE byte-grid FILL_RUN
  ;; ------------------------------------------------------------------
  ;; AoE I/II clear rectangular pathfinding grids with this exact six-op
  ;; self-loop (AoE II 0x005def8e):
  ;;
  ;;   mov edi,[esi+0x408] / inc eax / cmp eax,edx
  ;;   mov edi,[edi+ecx*4] / mov byte [edi+eax-1],0xff / jl ^
  ;;
  ;; Prove the complete emitted form, including both SIB descriptors, rather
  ;; than keying the core on one game's EIP. A near miss remains ordinary x86.
  (func $loop_try_aoe_grid_fill
    (param $start_eip i32) (param $tstart i32) (result i32)
    (local $p i32) (local $fall i32) (local $back i32)

    (if (i32.ne (global.get $op_index_n) (i32.const 6))
      (then (return (i32.const 0))))

    (local.set $p (call $loop_op_at (i32.const 0)))
    (if (i32.or
          (i32.ne (i32.load (local.get $p)) (i32.const 345))
          (i32.or
            (i32.ne (i32.load offset=4 (local.get $p)) (i32.const 7))
            (i32.ne (i32.load offset=8 (local.get $p)) (i32.const 0x408))))
      (then (return (i32.const 0))))

    (local.set $p (call $loop_op_at (i32.const 1)))
    (if (i32.or
          (i32.ne (i32.load (local.get $p)) (i32.const 64))
          (i32.ne (i32.load offset=4 (local.get $p)) (i32.const 0)))
      (then (return (i32.const 0))))

    (local.set $p (call $loop_op_at (i32.const 2)))
    (if (i32.or
          (i32.ne (i32.load (local.get $p)) (i32.const 19))
          (i32.ne (i32.load offset=4 (local.get $p)) (i32.const 2)))
      (then (return (i32.const 0))))

    (local.set $p (call $loop_op_at (i32.const 3)))
    (if (i32.or
          (i32.ne (i32.load (local.get $p)) (i32.const 389))
          (i32.or
            (i32.ne (i32.load offset=4 (local.get $p)) (i32.const 7))
            (i32.or
              (i32.ne (i32.load offset=8 (local.get $p)) (i32.const 0x217))
              (i32.ne (i32.load offset=12 (local.get $p)) (i32.const 0)))))
      (then (return (i32.const 0))))

    (local.set $p (call $loop_op_at (i32.const 4)))
    (if (i32.or
          (i32.ne (i32.load (local.get $p)) (i32.const 402))
          (i32.or
            (i32.ne (i32.load offset=4 (local.get $p)) (i32.const 0xff))
            (i32.or
              (i32.ne (i32.load offset=8 (local.get $p)) (i32.const 7))
              (i32.ne (i32.load offset=12 (local.get $p)) (i32.const -1)))))
      (then (return (i32.const 0))))

    (local.set $p (call $loop_op_at (i32.const 5)))
    (if (i32.ne (i32.load (local.get $p)) (i32.const 319))
      (then (return (i32.const 0))))
    (local.set $fall (i32.load offset=8 (local.get $p)))
    (local.set $back (i32.load offset=12 (local.get $p)))
    (if (i32.ne (local.get $back) (local.get $start_eip))
      (then (return (i32.const 0))))

    (global.set $loop_aoe_fill_matches
      (i32.add (global.get $loop_aoe_fill_matches) (i32.const 1)))
    (if (i32.eqz (global.get $loop_aoe_fill_emit_enabled))
      (then (return (i32.const 0))))

    (global.set $loop_matched_blocks
      (i32.add (global.get $loop_matched_blocks) (i32.const 1)))
    (global.set $thread_alloc (local.get $tstart))
    (global.set $op_index_n (i32.const 0))
    (call $te (i32.const 437) (i32.const 0))
    (call $te_raw (local.get $fall))
    (call $te_raw (local.get $back))
    (i32.const 1))

  (func $th_aoe_grid_fill (param $op i32)
    (local $tp i32) (local $fall i32) (local $back i32)
    (local $old i32) (local $end i32) (local $next_index i32)
    (local $total i32) (local $n i32) (local $allowed i32)
    (local $table i32) (local $entry i32) (local $row i32)
    (local $dst i32) (local $wa i32) (local $fast i32)

    (local.set $tp (global.get $ip))
    (global.set $ip (i32.add (local.get $tp) (i32.const 8)))
    (local.set $fall (i32.load (local.get $tp)))
    (local.set $back (i32.load offset=4 (local.get $tp)))
    (local.set $old (global.get $eax))
    (local.set $end (global.get $edx))

    ;; The original is do-while. The bulk proof only covers the normal
    ;; monotonic interval; wrapped or reversed inputs execute the same six
    ;; operations below one iteration at a time.
    (local.set $total (i32.const 1))
    (if (i32.lt_s (local.get $old) (local.get $end))
      (then (local.set $total (i32.sub (local.get $end) (local.get $old)))))

    ;; Stop at the same guest-instruction and block budgets as the six-handler
    ;; loop. $next already charged H437 itself, hence cost-1 in this allowance.
    (local.set $allowed
      (i32.div_u
        (i32.add
          (select (global.get $steps) (i32.const 0)
            (i32.gt_s (global.get $steps) (i32.const 0)))
          (i32.const 5))
        (i32.const 6)))
    (if (i32.eqz (local.get $allowed))
      (then (local.set $allowed (i32.const 1))))
    (local.set $n
      (select (local.get $total) (local.get $allowed)
        (i32.lt_u (local.get $total) (local.get $allowed))))
    (local.set $allowed
      (select (i32.add (global.get $block_budget) (i32.const 1)) (i32.const 1)
        (i32.gt_s (global.get $block_budget) (i32.const 0))))
    (if (i32.gt_u (local.get $n) (local.get $allowed))
      (then (local.set $n (local.get $allowed))))

    (local.set $table (call $gl32 (i32.add (global.get $esi) (i32.const 0x408))))
    (local.set $entry
      (i32.add (local.get $table) (i32.shl (global.get $ecx) (i32.const 2))))
    (local.set $row (call $gl32 (local.get $entry)))
    (local.set $dst (i32.add (local.get $row) (local.get $old)))
    (local.set $wa (call $g2w_affine_span (local.get $dst) (local.get $n)))

    ;; Reloading the two pointers every original iteration is observable only
    ;; if the fill overwrites either pointer. Decline the bulk arm in that rare
    ;; alias case; the internal loop below retains the reload order exactly.
    (local.set $fast
      (i32.and
        (i32.lt_s (local.get $old) (local.get $end))
        (i32.and
          (i32.ne (local.get $wa) (global.get $NULL_SENTINEL))
          (i32.and
            (i32.or
              (i32.le_u (i32.add (local.get $dst) (local.get $n))
                        (i32.add (global.get $esi) (i32.const 0x408)))
              (i32.ge_u (local.get $dst)
                        (i32.add (global.get $esi) (i32.const 0x40c))))
            (i32.or
              (i32.le_u (i32.add (local.get $dst) (local.get $n)) (local.get $entry))
              (i32.ge_u (local.get $dst) (i32.add (local.get $entry) (i32.const 4))))))))

    (if (local.get $fast)
      (then
        (call $invalidate_code_write (local.get $dst) (local.get $n))
        (memory.fill (local.get $wa) (i32.const 0xff) (local.get $n))
        (local.set $next_index (i32.add (local.get $old) (local.get $n)))
        (global.set $eax (local.get $next_index))
        (global.set $edi (local.get $row))
        (call $set_flags_sub
          (local.get $next_index) (local.get $end)
          (i32.sub (local.get $next_index) (local.get $end))))
      (else
        (local.set $allowed (local.get $n))
        (loop $slow
          (local.set $table
            (call $gl32 (i32.add (global.get $esi) (i32.const 0x408))))
          (local.set $next_index (i32.add (global.get $eax) (i32.const 1)))
          (call $set_flags_sub
            (local.get $next_index) (local.get $end)
            (i32.sub (local.get $next_index) (local.get $end)))
          (local.set $row
            (call $gl32
              (i32.add (local.get $table) (i32.shl (global.get $ecx) (i32.const 2)))))
          (global.set $edi (local.get $row))
          (call $gs8 (i32.add (local.get $row) (global.get $eax)) (i32.const 0xff))
          (global.set $eax (local.get $next_index))
          (local.set $allowed (i32.sub (local.get $allowed) (i32.const 1)))
          (br_if $slow (local.get $allowed)))))

    (global.set $steps
      (i32.sub (global.get $steps)
        (i32.sub (i32.mul (local.get $n) (i32.const 6)) (i32.const 1))))
    (if (i32.gt_u (local.get $n) (i32.const 1))
      (then
        (global.set $block_budget
          (i32.sub (global.get $block_budget)
            (i32.sub (local.get $n) (i32.const 1))))))
    (global.set $loop_aoe_fill_runs
      (i32.add (global.get $loop_aoe_fill_runs) (i32.const 1)))
    (global.set $loop_aoe_fill_bytes
      (i64.add (global.get $loop_aoe_fill_bytes) (i64.extend_i32_u (local.get $n))))
    (global.set $eip
      (select (local.get $back) (local.get $fall)
        (i32.lt_s (global.get $eax) (local.get $end))))
    (return_call $branch_end))

  ;; 438: one span-prefix executor for both AoE builds. `op` selects only the
  ;; compiler register allocation: 1 = AoE I, 2 = AoE II. The clipping and
  ;; row-table algorithm, structure offsets, stack layout, and safety boundary
  ;; are shared.
  (func $th_aoe_span_prefix (param $op i32)
    (local $tp i32) (local $start i32) (local $reject_off i32)
    (local $old_esp i32) (local $esp_wa i32)
    (local $this i32) (local $this_wa i32)
    (local $row i32) (local $x0 i32) (local $x1 i32) (local $swap i32)
    (local $min_row i32) (local $max_row i32)
    (local $min_x i32) (local $max_x i32)
    (local $row_base i32) (local $row_head i32) (local $cost i32)

    (global.set $loop_aoe_span_runs
      (i32.add (global.get $loop_aoe_span_runs) (i32.const 1)))
    (local.set $tp (global.get $ip))
    (global.set $ip (i32.add (local.get $tp) (i32.const 4)))
    (local.set $start (i32.load (local.get $tp)))
    (local.set $reject_off
      (select (i32.const 0x38d) (i32.const 0x3b4)
        (i32.eq (local.get $op) (i32.const 1))))

    ;; push ebx/ebp/esi; mov esi,ecx; push edi; mov edi,[esp+1c]
    (local.set $cost (i32.const 6))
    (local.set $old_esp (global.get $esp))
    (local.set $esp_wa (call $g2w (i32.sub (local.get $old_esp) (i32.const 16))))
    (i32.store offset=12 (local.get $esp_wa) (global.get $ebx))
    (i32.store offset=8 (local.get $esp_wa) (global.get $ebp))
    (i32.store offset=4 (local.get $esp_wa) (global.get $esi))
    (i32.store (local.get $esp_wa) (global.get $edi))
    (global.set $esp (i32.sub (local.get $old_esp) (i32.const 16)))
    (local.set $this (global.get $ecx))
    (local.set $this_wa (call $g2w (local.get $this)))
    (global.set $esi (local.get $this))
    (local.set $row (i32.load offset=28 (local.get $esp_wa)))
    (global.set $edi (local.get $row))

    (local.set $cost (i32.add (local.get $cost) (i32.const 2)))
    (local.set $min_row (i32.load offset=0x60 (local.get $this_wa)))
    (if (i32.lt_s (local.get $row) (local.get $min_row))
      (then
        (call $set_flags_sub
          (local.get $row) (local.get $min_row)
          (i32.sub (local.get $row) (local.get $min_row)))
        (global.set $steps
          (i32.sub (global.get $steps) (i32.sub (local.get $cost) (i32.const 1))))
        (global.set $eip (i32.add (local.get $start) (local.get $reject_off)))
        (return)))

    (local.set $cost (i32.add (local.get $cost) (i32.const 2)))
    (local.set $max_row (i32.load offset=0x64 (local.get $this_wa)))
    (if (i32.gt_s (local.get $row) (local.get $max_row))
      (then
        (call $set_flags_sub
          (local.get $row) (local.get $max_row)
          (i32.sub (local.get $row) (local.get $max_row)))
        (global.set $steps
          (i32.sub (global.get $steps) (i32.sub (local.get $cost) (i32.const 1))))
        (global.set $eip (i32.add (local.get $start) (local.get $reject_off)))
        (return)))

    (local.set $cost (i32.add (local.get $cost) (i32.const 4)))
    (local.set $x0 (i32.load offset=20 (local.get $esp_wa)))
    (local.set $x1 (i32.load offset=24 (local.get $esp_wa)))
    (if (i32.gt_s (local.get $x0) (local.get $x1))
      (then
        (local.set $cost (i32.add (local.get $cost) (i32.const 4)))
        (i32.store offset=24 (local.get $esp_wa) (local.get $x0))
        (i32.store offset=20 (local.get $esp_wa) (local.get $x1))
        (local.set $swap (local.get $x0))
        (local.set $x0 (local.get $x1))
        (local.set $x1 (local.get $swap))))

    (if (i32.eq (local.get $op) (i32.const 1))
      (then
        (global.set $eax (local.get $x0))
        (global.set $ebp (local.get $x1)))
      (else
        (global.set $ebx (local.get $x0))
        (global.set $ebp (local.get $x1))))

    (local.set $cost (i32.add (local.get $cost) (i32.const 3)))
    (local.set $min_x (i32.load offset=0x58 (local.get $this_wa)))
    (if (i32.eq (local.get $op) (i32.const 1))
      (then (global.set $ecx (local.get $min_x)))
      (else (global.set $eax (local.get $min_x))))
    (if (i32.lt_s (local.get $x1) (local.get $min_x))
      (then
        (call $set_flags_sub
          (local.get $x1) (local.get $min_x)
          (i32.sub (local.get $x1) (local.get $min_x)))
        (global.set $steps
          (i32.sub (global.get $steps) (i32.sub (local.get $cost) (i32.const 1))))
        (global.set $eip (i32.add (local.get $start) (local.get $reject_off)))
        (return)))

    (local.set $cost (i32.add (local.get $cost) (i32.const 3)))
    (local.set $max_x (i32.load offset=0x5c (local.get $this_wa)))
    (if (i32.eq (local.get $op) (i32.const 1))
      (then (global.set $edx (local.get $max_x)))
      (else (global.set $ecx (local.get $max_x))))
    (if (i32.gt_s (local.get $x0) (local.get $max_x))
      (then
        (call $set_flags_sub
          (local.get $x0) (local.get $max_x)
          (i32.sub (local.get $x0) (local.get $max_x)))
        (global.set $steps
          (i32.sub (global.get $steps) (i32.sub (local.get $cost) (i32.const 1))))
        (global.set $eip (i32.add (local.get $start) (local.get $reject_off)))
        (return)))

    (local.set $cost (i32.add (local.get $cost) (i32.const 2)))
    (if (i32.lt_s (local.get $x0) (local.get $min_x))
      (then
        (i32.store offset=20 (local.get $esp_wa) (local.get $min_x))
        (if (i32.eq (local.get $op) (i32.const 2))
          (then
            (local.set $cost (i32.add (local.get $cost) (i32.const 2)))
            (local.set $x0 (local.get $min_x))
            (global.set $ebx (local.get $x0)))
          (else
            (local.set $cost (i32.add (local.get $cost) (i32.const 1)))))))

    (local.set $cost (i32.add (local.get $cost) (i32.const 2)))
    (if (i32.gt_s (local.get $x1) (local.get $max_x))
      (then
        (local.set $cost (i32.add (local.get $cost) (i32.const 2)))
        (local.set $x1 (local.get $max_x))
        (i32.store offset=24 (local.get $esp_wa) (local.get $x1))
        (global.set $ebp (local.get $x1))))

    (local.set $row_base (i32.load offset=0x3c (local.get $this_wa)))
    (if (i32.eq (local.get $op) (i32.const 1))
      (then
        (local.set $cost (i32.add (local.get $cost) (i32.const 5)))
        (local.set $row (i32.shl (local.get $row) (i32.const 2)))
        (global.set $edi (local.get $row))
        (global.set $eax (local.get $row_base))
        (local.set $row_head (call $gl32 (i32.add (local.get $row_base) (local.get $row))))
        (global.set $ebx (local.get $row_head)))
      (else
        (local.set $cost (i32.add (local.get $cost) (i32.const 4)))
        (local.set $row_head
          (call $gl32
            (i32.add (local.get $row_base) (i32.shl (local.get $row) (i32.const 2)))))
        (global.set $eax (local.get $row_head))))
    (call $set_flags_logic (local.get $row_head))
    (global.set $steps
      (i32.sub (global.get $steps) (i32.sub (local.get $cost) (i32.const 1))))
    (if (i32.eq (local.get $op) (i32.const 1))
      (then
        (if (local.get $row_head)
          (then (global.set $eip (i32.add (local.get $start) (i32.const 0xa7))))
          (else (global.set $eip (i32.add (local.get $start) (i32.const 0x6b))))))
      (else
        (if (local.get $row_head)
          (then (global.set $eip (i32.add (local.get $start) (i32.const 0xaf))))
          (else (global.set $eip (i32.add (local.get $start) (i32.const 0x6a)))))))
    (return_call $branch_end))

  ;; ------------------------------------------------------------------
  ;; 418: the universal LUT_RUN super-op.
  ;; ------------------------------------------------------------------
  ;; Both recognizers emit the descriptor documented above. Cursors advance
  ;; after each access; match time folds any original pre-access increment into
  ;; the displacement. term_kind selects count-to-zero or unsigned source-bound
  ;; termination. The optional shift/add pair covers 64K row lookup tables;
  ;; bit 0 adds a second moving byte source for blend tables, bit 1 selects a
  ;; u16 lookup/store, bit 2 loads the table register from the stack, and bit 3
  ;; makes word 6 an absolute byte-table address.
  (func $th_lut_run (param $op i32)
    (local $blend i32) (local $wide16 i32)
    (local $table_stack i32) (local $absolute8 i32)
    (local $src_reg i32) (local $src_stride i32) (local $src_disp i32)
    (local $dst_reg i32) (local $dst_stride i32) (local $dst_disp i32)
    (local $tbl_reg i32) (local $acc_reg i32) (local $index_shift i32)
    (local $add_reg i32) (local $term_kind i32) (local $term_reg i32)
    (local $term_step i32)
    (local $src2_reg i32) (local $src2_stride i32) (local $src2_disp i32)
    (local $aux_reg i32) (local $table_disp i32) (local $term_stream i32)
    (local $stack_disp i32)
    (local $m0_addr i32) (local $m0_reg i32) (local $m0_adj i32)
    (local $m1_addr i32) (local $m1_reg i32) (local $m1_adj i32)
    (local $fall i32) (local $back i32) (local $cost i32)
    (local $tp i32) (local $src i32) (local $src2 i32) (local $dst i32)
    (local $term i32) (local $cursor i32)
    (local $tbl i32) (local $tbl_base i32) (local $stack_ga i32)
    (local $stack_page0 i32) (local $stack_page1 i32)
    (local $add i32) (local $old i32)
    (local $b i32) (local $src_b i32) (local $aux i32)
    (local $src_ga i32) (local $dst_ga i32) (local $src_wa i32) (local $dst_wa i32)
    (local $src2_ga i32) (local $src2_wa i32)
    (local $tbl_wa i32)
    (local $chunk i32) (local $trips i32) (local $allowed i32)
    (local $n i32) (local $index i32) (local $cont i32)

    ;; Read the fixed descriptor off one base. These runs are often short, so
    ;; avoiding 22/28 helper calls matters to the cost this optimization is
    ;; meant to remove.
    (local.set $blend (i32.and (local.get $op) (i32.const 1)))
    (local.set $wide16
      (i32.and (i32.shr_u (local.get $op) (i32.const 1)) (i32.const 1)))
    (local.set $table_stack
      (i32.and (i32.shr_u (local.get $op) (i32.const 2)) (i32.const 1)))
    (local.set $absolute8
      (i32.and (i32.shr_u (local.get $op) (i32.const 3)) (i32.const 1)))
    (local.set $tp (global.get $ip))
    (global.set $ip (i32.add (local.get $tp)
      (select (i32.const 112)
        (select
          (select (i32.const 96) (i32.const 92) (local.get $table_stack))
          (i32.const 88) (local.get $wide16))
        (local.get $blend))))
    (local.set $src_reg     (i32.load           (local.get $tp)))
    (local.set $src_stride  (i32.load offset=4  (local.get $tp)))
    (local.set $src_disp    (i32.load offset=8  (local.get $tp)))
    (local.set $dst_reg     (i32.load offset=12 (local.get $tp)))
    (local.set $dst_stride  (i32.load offset=16 (local.get $tp)))
    (local.set $dst_disp    (i32.load offset=20 (local.get $tp)))
    (local.set $tbl_reg     (i32.load offset=24 (local.get $tp)))
    (local.set $acc_reg     (i32.load offset=28 (local.get $tp)))
    (local.set $index_shift (i32.load offset=32 (local.get $tp)))
    (local.set $add_reg     (i32.load offset=36 (local.get $tp)))
    (local.set $term_kind   (i32.load offset=40 (local.get $tp)))
    (local.set $term_reg    (i32.load offset=44 (local.get $tp)))
    (local.set $term_step   (i32.load offset=48 (local.get $tp)))
    (local.set $m0_addr     (i32.load offset=52 (local.get $tp)))
    (local.set $m0_reg      (i32.load offset=56 (local.get $tp)))
    (local.set $m0_adj      (i32.load offset=60 (local.get $tp)))
    (local.set $m1_addr     (i32.load offset=64 (local.get $tp)))
    (local.set $m1_reg      (i32.load offset=68 (local.get $tp)))
    (local.set $m1_adj      (i32.load offset=72 (local.get $tp)))
    (local.set $fall        (i32.load offset=76 (local.get $tp)))
    (local.set $back        (i32.load offset=80 (local.get $tp)))
    (local.set $cost        (i32.load offset=84 (local.get $tp)))
    (if (local.get $blend)
      (then
        (local.set $src2_reg    (i32.load offset=88  (local.get $tp)))
        (local.set $src2_stride (i32.load offset=92  (local.get $tp)))
        (local.set $src2_disp   (i32.load offset=96  (local.get $tp)))
        (local.set $aux_reg     (i32.load offset=100 (local.get $tp)))
        (local.set $table_disp  (i32.load offset=104 (local.get $tp)))
        (local.set $term_stream (i32.load offset=108 (local.get $tp)))))
    (if (local.get $wide16)
      (then (local.set $table_disp (i32.load offset=88 (local.get $tp)))))
    (if (local.get $table_stack)
      (then (local.set $stack_disp (i32.load offset=92 (local.get $tp)))))

    (local.set $src (call $get_reg (local.get $src_reg)))
    (local.set $dst (call $get_reg (local.get $dst_reg)))
    (local.set $term (call $get_reg (local.get $term_reg)))
    (if (local.get $blend)
      (then (local.set $src2 (call $get_reg (local.get $src2_reg)))))
    (if (local.get $table_stack)
      (then
        (local.set $stack_ga (i32.add (global.get $esp) (local.get $stack_disp)))
        (local.set $stack_page0
          (i32.and (local.get $stack_ga) (i32.const 0xFFFFF000)))
        (local.set $stack_page1
          (i32.and (i32.add (local.get $stack_ga) (i32.const 3))
                   (i32.const 0xFFFFF000)))
        (local.set $tbl_base
          (call $gl32 (local.get $stack_ga)))
        (local.set $tbl (i32.add (local.get $tbl_base) (local.get $table_disp))))
      (else
        (if (local.get $absolute8)
          (then (local.set $tbl (local.get $tbl_reg)))
          (else
            (if (i32.ge_s (local.get $tbl_reg) (i32.const 0))
              (then
                (local.set $tbl_base (call $get_reg (local.get $tbl_reg)))
                (local.set $tbl (i32.add (local.get $tbl_base) (local.get $table_disp))))
              (else (local.set $tbl (local.get $table_disp))))))))
    (if (i32.ge_s (local.get $add_reg) (i32.const 0))
      (then (local.set $add (call $get_reg (local.get $add_reg)))))

    ;; Translate the complete lookup range once when it is the normal affine
    ;; guest window. Version 1 indexes all 64KB; the two-endpoint guard keeps
    ;; sparse mappings on gl8.
    (local.set $tbl_wa (i32.const 0))
    (if (i32.and
          (i32.and (i32.eqz (local.get $blend)) (i32.eqz (local.get $wide16)))
          (i32.and (i32.eqz (local.get $index_shift))
                 (i32.lt_s (local.get $add_reg) (i32.const 0))))
      (then
        (if (i32.le_u (i32.and (local.get $tbl) (i32.const 0xFFF)) (i32.const 0xF00))
          (then
            (local.set $n (call $g2w (local.get $tbl)))
            (if (i32.ne (local.get $n) (global.get $NULL_SENTINEL))
              (then (local.set $tbl_wa (local.get $n))))))))
    ;; A wide table contains 256 u16 entries. Prove its complete 512-byte
    ;; extent once, retaining gl16 for non-affine sparse boundaries.
    (if (i32.and (local.get $wide16) (i32.eqz (local.get $table_stack)))
      (then
        (if (i32.le_u (i32.and (local.get $tbl) (i32.const 0xFFF)) (i32.const 0xE00))
          (then (local.set $tbl_wa (call $g2w (local.get $tbl))))
          (else (local.set $tbl_wa
            (call $g2w_affine_span (local.get $tbl) (i32.const 0x200)))))
        (if (i32.eq (local.get $tbl_wa) (global.get $NULL_SENTINEL))
          (then (local.set $tbl_wa (i32.const 0))))))
    (global.set $loop_lut_runs
      (i32.add (global.get $loop_lut_runs) (i32.const 1)))
    (if (local.get $wide16)
      (then (global.set $loop_lut16_runs
        (i32.add (global.get $loop_lut16_runs) (i32.const 1)))))
    (block $exit
      (loop $outer
        (local.set $src_ga (i32.add (local.get $src) (local.get $src_disp)))
        (local.set $dst_ga (i32.add (local.get $dst) (local.get $dst_disp)))
        ;; The stack-prefixed form semantically reloads the table register at
        ;; the start of every original iteration. A destination page distinct
        ;; from the stack slot proves that load invariant for this page chunk.
        ;; When they can alias below, chunk=1 makes this outer reload happen
        ;; before every store, preserving even self-modifying stack data.
        (if (local.get $table_stack)
          (then
            (local.set $tbl_base (call $gl32 (local.get $stack_ga)))
            (local.set $tbl (i32.add (local.get $tbl_base) (local.get $table_disp)))
            (if (i32.le_u (i32.and (local.get $tbl) (i32.const 0xFFF)) (i32.const 0xE00))
              (then (local.set $tbl_wa (call $g2w (local.get $tbl))))
              (else (local.set $tbl_wa
                (call $g2w_affine_span (local.get $tbl) (i32.const 0x200)))))
            (if (i32.eq (local.get $tbl_wa) (global.get $NULL_SENTINEL))
              (then (local.set $tbl_wa (i32.const 0))))))
        (if (local.get $blend)
          (then (local.set $src2_ga
            (i32.add (local.get $src2) (local.get $src2_disp)))))

        (if (i32.eqz (local.get $term_kind))
          (then
            (local.set $trips
              (select (local.get $term)
                      (i32.sub (i32.const 0) (local.get $term))
                      (i32.eq (local.get $term_step) (i32.const -1))))
            ;; Preserve do-while semantics for a zero/wrapped counter entry.
            (if (i32.eqz (local.get $trips))
              (then (local.set $trips (i32.const -1)))))
          (else
            ;; A normally reached back-edge guarantees src < bound. The one-trip
            ;; fallback preserves the original do-while behavior for a direct
            ;; entry whose precondition is false.
            (local.set $cursor
              (select (local.get $src2) (local.get $src)
                (i32.and (local.get $blend) (local.get $term_stream))))
            (local.set $trips
              (select (i32.sub (local.get $term) (local.get $cursor))
                      (i32.const 1)
                      (i32.lt_u (local.get $cursor) (local.get $term))))))
        (local.set $allowed
          (i32.div_u
            (i32.add
              (select (global.get $steps) (i32.const 0)
                      (i32.gt_s (global.get $steps) (i32.const 0)))
              (i32.sub (local.get $cost) (i32.const 1)))
            (local.get $cost)))
        (if (i32.eqz (local.get $allowed))
          (then (local.set $allowed (i32.const 1))))
        (local.set $chunk
          (select (local.get $trips) (local.get $allowed)
                  (i32.lt_u (local.get $trips) (local.get $allowed))))
        (local.set $n (call $copy_page_room (local.get $src_ga) (local.get $src_stride)))
        (local.set $chunk
          (select (local.get $n) (local.get $chunk)
                  (i32.lt_u (local.get $n) (local.get $chunk))))
        (local.set $n (call $copy_page_room (local.get $dst_ga) (local.get $dst_stride)))
        (local.set $chunk
          (select (local.get $n) (local.get $chunk)
                  (i32.lt_u (local.get $n) (local.get $chunk))))
        (if (i32.and (local.get $table_stack)
              (i32.or
                (i32.or
                  (i32.eq
                    (i32.and (local.get $dst_ga) (i32.const 0xFFFFF000))
                    (local.get $stack_page0))
                  (i32.eq
                    (i32.and (local.get $dst_ga) (i32.const 0xFFFFF000))
                    (local.get $stack_page1)))
                (i32.or
                  (i32.eq
                    (i32.and (i32.add (local.get $dst_ga) (i32.const 1))
                             (i32.const 0xFFFFF000))
                    (local.get $stack_page0))
                  (i32.eq
                    (i32.and (i32.add (local.get $dst_ga) (i32.const 1))
                             (i32.const 0xFFFFF000))
                    (local.get $stack_page1)))))
          (then (local.set $chunk (i32.const 1))))
        (if (local.get $blend)
          (then
            (local.set $n
              (call $copy_page_room (local.get $src2_ga) (local.get $src2_stride)))
            (local.set $chunk
              (select (local.get $n) (local.get $chunk)
                      (i32.lt_u (local.get $n) (local.get $chunk))))))

        (local.set $src_wa (call $g2w (local.get $src_ga)))
        (local.set $dst_wa (call $g2w (local.get $dst_ga)))
        ;; A word beginning at the final byte of a page may cross into a
        ;; different mapping. Route that one element through gs16.
        (if (i32.and (local.get $wide16)
              (i32.eq (i32.and (local.get $dst_ga) (i32.const 0xFFF)) (i32.const 0xFFF)))
          (then
            (local.set $dst_wa (global.get $NULL_SENTINEL))
            (local.set $chunk (i32.const 1))))
        (if (local.get $blend)
          (then (local.set $src2_wa (call $g2w (local.get $src2_ga)))))
        (if (i32.or
              (i32.eq (local.get $src_wa) (global.get $NULL_SENTINEL))
              (i32.or
                (i32.eq (local.get $dst_wa) (global.get $NULL_SENTINEL))
                (i32.and (local.get $blend)
                  (i32.eq (local.get $src2_wa) (global.get $NULL_SENTINEL)))))
          (then (local.set $chunk (i32.const 1))))
        (call $invalidate_code_write
          (i32.and (local.get $dst_ga) (i32.const 0xFFFFF000)) (i32.const 4096))

        (local.set $n (local.get $chunk))
        (loop $inner
          (if (i32.eq (local.get $src_wa) (global.get $NULL_SENTINEL))
            (then (local.set $src_b (call $gl8 (local.get $src_ga))))
            (else (local.set $src_b (i32.load8_u (local.get $src_wa)))))
          (if (local.get $blend)
            (then
              (if (i32.eq (local.get $src2_wa) (global.get $NULL_SENTINEL))
                (then (local.set $aux (call $gl8 (local.get $src2_ga))))
                (else (local.set $aux (i32.load8_u (local.get $src2_wa)))))))
          (local.set $index (i32.shl (local.get $src_b) (local.get $index_shift)))
          (if (local.get $blend)
            (then (local.set $index (i32.add (local.get $index) (local.get $aux))))
            (else (if (i32.ge_s (local.get $add_reg) (i32.const 0))
              (then (local.set $index (i32.add (local.get $index) (local.get $add)))))))
          (if (local.get $wide16)
            (then
              (if (local.get $tbl_wa)
                (then (local.set $b
                  (i32.load16_u (i32.add (local.get $tbl_wa) (local.get $index)))))
                (else (local.set $b
                  (call $gl16 (i32.add (local.get $tbl) (local.get $index))))))
              (if (i32.eq (local.get $dst_wa) (global.get $NULL_SENTINEL))
                (then (call $gs16 (local.get $dst_ga) (local.get $b)))
                (else (i32.store16 (local.get $dst_wa) (local.get $b)))))
            (else
              (if (local.get $tbl_wa)
                (then (local.set $b
                  (i32.load8_u (i32.add (local.get $tbl_wa) (local.get $index)))))
                (else (local.set $b
                  (call $gl8 (i32.add (local.get $tbl) (local.get $index))))))
              (if (i32.eq (local.get $dst_wa) (global.get $NULL_SENTINEL))
                (then (call $gs8 (local.get $dst_ga) (local.get $b)))
                (else (i32.store8 (local.get $dst_wa) (local.get $b))))))
          (local.set $src_ga (i32.add (local.get $src_ga) (local.get $src_stride)))
          (local.set $dst_ga (i32.add (local.get $dst_ga) (local.get $dst_stride)))
          (if (i32.ne (local.get $src_wa) (global.get $NULL_SENTINEL))
            (then (local.set $src_wa (i32.add (local.get $src_wa) (local.get $src_stride)))))
          (if (i32.ne (local.get $dst_wa) (global.get $NULL_SENTINEL))
            (then (local.set $dst_wa (i32.add (local.get $dst_wa) (local.get $dst_stride)))))
          (if (local.get $blend)
            (then
              (local.set $src2_ga
                (i32.add (local.get $src2_ga) (local.get $src2_stride)))
              (if (i32.ne (local.get $src2_wa) (global.get $NULL_SENTINEL))
                (then (local.set $src2_wa
                  (i32.add (local.get $src2_wa) (local.get $src2_stride)))))))
          (local.set $n (i32.sub (local.get $n) (i32.const 1)))
          (br_if $inner (local.get $n)))

        (local.set $src
          (i32.add (local.get $src) (i32.mul (local.get $chunk) (local.get $src_stride))))
        (if (local.get $blend)
          (then (local.set $src2
            (i32.add (local.get $src2)
              (i32.mul (local.get $chunk) (local.get $src2_stride))))))
        (if (i32.eq (local.get $src_reg) (local.get $dst_reg))
          (then (local.set $dst (local.get $src)))
          (else (local.set $dst
            (i32.add (local.get $dst) (i32.mul (local.get $chunk) (local.get $dst_stride))))))
        (if (i32.eqz (local.get $term_kind))
          (then
            (local.set $term
              (i32.add (local.get $term) (i32.mul (local.get $chunk) (local.get $term_step))))
            (local.set $old (i32.sub (local.get $term) (local.get $term_step)))))
        (global.set $loop_lut_bytes
          (i64.add (global.get $loop_lut_bytes) (i64.extend_i32_u (local.get $chunk))))
        (if (local.get $wide16)
          (then (global.set $loop_lut16_bytes
            (i64.add (global.get $loop_lut16_bytes)
              (i64.extend_i32_u (local.get $chunk))))))
        (global.set $steps
          (i32.sub (global.get $steps) (i32.mul (local.get $chunk) (local.get $cost))))
        (local.set $cursor
          (select (local.get $src2) (local.get $src)
            (i32.and (local.get $blend) (local.get $term_stream))))
        (local.set $cont
          (select (i32.ne (local.get $term) (i32.const 0))
                  (i32.lt_u (local.get $cursor) (local.get $term))
                  (i32.eqz (local.get $term_kind))))
        (br_if $exit (i32.eqz (local.get $cont)))
        (br_if $exit (i32.le_s (global.get $steps) (i32.const 0)))
        (br $outer)))

    (call $set_reg (local.get $acc_reg)
      (select
        (i32.or (i32.shl (local.get $src_b) (local.get $index_shift)) (local.get $b))
        (local.get $b)
        (local.get $blend)))
    (if (local.get $table_stack)
      (then (call $set_reg (local.get $tbl_reg) (local.get $tbl_base))))
    (if (local.get $blend)
      (then
        (call $set_reg (local.get $aux_reg) (local.get $aux))
        (call $set_reg (local.get $src2_reg) (local.get $src2))))
    (call $set_reg (local.get $src_reg) (local.get $src))
    (if (i32.ne (local.get $dst_reg) (local.get $src_reg))
      (then (call $set_reg (local.get $dst_reg) (local.get $dst))))
    (if (i32.eqz (local.get $term_kind))
      (then
        (call $set_reg (local.get $term_reg) (local.get $term))
        (if (i32.eq (local.get $term_step) (i32.const -1))
          (then (call $set_flags_dec (local.get $old) (local.get $term)))
          (else (call $set_flags_inc (local.get $old) (local.get $term)))))
      (else
        (call $set_flags_sub (local.get $cursor) (local.get $term)
          (i32.sub (local.get $cursor) (local.get $term)))))
    (if (local.get $m0_addr)
      (then (call $gs32 (local.get $m0_addr)
              (i32.add (call $get_reg (local.get $m0_reg)) (local.get $m0_adj)))))
    (if (local.get $m1_addr)
      (then (call $gs32 (local.get $m1_addr)
              (i32.add (call $get_reg (local.get $m1_reg)) (local.get $m1_adj)))))
    (global.set $eip (select (local.get $back) (local.get $fall) (local.get $cont))))
