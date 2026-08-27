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
  ;; LUT_RUN and COPY_RUN have independent gates. The role-proved LUT lowering
  ;; is on by default; COPY remains off while its historical Storm divergence
  ;; is investigated. set_loop_emit still controls both for compatibility.
  (global $loop_lut_emit_enabled (mut i32) (i32.const 1))
  ;; Benchmark/rollback gate for the Heroes III stack-table extension only.
  (global $loop_lut16_stack_emit_enabled (mut i32) (i32.const 1))
  (global $loop_copy_emit_enabled (mut i32) (i32.const 0))

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
  ;; Header operand bit 0 selects the optional two-moving-source extension:
  ;;  22 src2_reg   23 src2_stride 24 src2_disp
  ;;  25 aux_reg    26 table_disp  27 term_stream (0=src1, 1=src2)
  ;; In that form the lookup index is `(src1_byte << index_shift) + src2_byte`.
  ;; tbl_reg may be -1 for an absolute table rooted at table_disp. Version zero
  ;; remains the original 22-word descriptor byte-for-byte. Bit 1 selects the
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
    (local $tbl_reg i32) (local $lut_cnt i32) (local $lut_idx i32)
    (local $st_reg i32) (local $st_base i32) (local $st_disp i32) (local $st_idx i32) (local $st_cnt i32)
    (local $m0_addr i32) (local $m0_reg i32) (local $m0_idx i32)
    (local $m1_addr i32) (local $m1_reg i32) (local $m1_idx i32)
    (local $mir_cnt i32) (local $written i32) (local $info i32) (local $b i32) (local $x i32)
    (local $fall i32)

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
            (local.set $ld_cnt (i32.add (local.get $ld_cnt) (i32.const 1)))
            (local.set $ld_base (i32.and (local.get $op) (i32.const 0xF)))
            (local.set $ld_reg (i32.shr_u (local.get $op) (i32.const 4)))
            (local.set $ld_disp (i32.load offset=8 (local.get $p)))
            (local.set $ld_idx (local.get $i))
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
    (if (i32.ne (local.get $ld_cnt) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $lut_cnt) (i32.const 1)) (then (return (i32.const 0))))
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
      (then (return (i32.const 0))))

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
    (call $te (global.get $LOOP_SUPEROP_LUT) (i32.const 0))
    (call $te_raw (local.get $iv_reg))
    (call $te_raw (local.get $iv_stride))
    (call $te_raw (local.get $ld_disp))
    (call $te_raw (local.get $iv_reg))
    (call $te_raw (local.get $iv_stride))
    (call $te_raw (local.get $st_disp))
    (call $te_raw (local.get $tbl_reg))
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
  ;;   6 byte_reg 7 ctr_kind (0 reg, 1 mem)  8 ctr_loc  9 ctr_disp
  ;;  10 ctr_step 11 fall_eip  12 back_eip  13 steps_per_iter
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
    (if (i32.eqz (global.get $loop_copy_emit_enabled)) (then (return (i32.const 0))))

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
    (if (local.get $ctr_kind)
      (then
        (local.set $ctr_addr
          (i32.add (call $get_reg (local.get $ctr_loc)) (local.get $ctr_disp)))
        (local.set $ctr (call $gl32 (local.get $ctr_addr))))
      (else (local.set $ctr (call $get_reg (local.get $ctr_loc)))))

    ;; A memory counter has to be written back per iteration in general: the
    ;; destination range is allowed to cover the counter's own address, and a
    ;; deferred write would then lose whatever the copy put there. But that is
    ;; a pathological shape, and it is cheap to rule out here, where the run
    ;; length is known: at most $ctr bytes starting at the destination cursor.
    ;; When the counter sits outside that span, write it once at exit.
    (local.set $store_ctr (local.get $ctr_kind))
    (if (i32.and (i32.ne (local.get $ctr_kind) (i32.const 0))
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
        (local.set $allowed
          (i32.div_u
            (i32.add
              (select (global.get $steps) (i32.const 0)
                      (i32.gt_s (global.get $steps) (i32.const 0)))
              (i32.sub (local.get $cost) (i32.const 1)))
            (local.get $cost)))
        (if (i32.eqz (local.get $allowed)) (then (local.set $allowed (i32.const 1))))

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
        (call $invalidate_code_write
          (i32.and (local.get $dst_ga) (i32.const 0xFFFFF000)) (i32.const 4096))

        (local.set $n (local.get $chunk))
        (loop $inner
          (local.set $b (i32.load8_u (local.get $src_wa)))
          (i32.store8 (local.get $dst_wa) (local.get $b))
          (local.set $src_wa (i32.add (local.get $src_wa) (local.get $src_stride)))
          (local.set $dst_wa (i32.add (local.get $dst_wa) (local.get $dst_stride)))
          (local.set $n (i32.sub (local.get $n) (i32.const 1)))
          (br_if $inner (local.get $n)))

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
        (global.set $steps
          (i32.sub (global.get $steps) (i32.mul (local.get $chunk) (local.get $cost))))
        (br_if $exit (i32.eqz (local.get $ctr)))
        (br_if $exit (i32.le_s (global.get $steps) (i32.const 0)))
        (br $outer)))

    (call $set_reg (local.get $src_reg) (local.get $src))
    (call $set_reg (local.get $dst_reg) (local.get $dst))
    (call $set_reg8 (local.get $byte_reg) (local.get $b))
    (if (i32.eqz (local.get $ctr_kind))
      (then (call $set_reg (local.get $ctr_loc) (local.get $ctr)))
      (else (if (i32.eqz (local.get $store_ctr))
        (then (call $gs32 (local.get $ctr_addr) (local.get $ctr))))))
    (if (i32.eq (local.get $ctr_step) (i32.const -1))
      (then (call $set_flags_dec (local.get $old) (local.get $ctr)))
      (else (call $set_flags_inc (local.get $old) (local.get $ctr))))
    (global.set $eip
      (select (local.get $back) (local.get $fall) (i32.ne (local.get $ctr) (i32.const 0)))))

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
    (if (call $loop_try_lut16_counted (local.get $start_eip) (local.get $tstart))
      (then (return)))
    (if (call $loop_try_lut (local.get $start_eip) (local.get $tstart)) (then (return)))
    (if (call $loop_try_lut_bounded (local.get $start_eip) (local.get $tstart)) (then (return)))
    (if (call $loop_try_lut_blend_bounded (local.get $start_eip) (local.get $tstart))
      (then (return)))
    (drop (call $loop_try_copy (local.get $start_eip) (local.get $tstart))))

  ;; ------------------------------------------------------------------
  ;; 418: the universal LUT_RUN super-op.
  ;; ------------------------------------------------------------------
  ;; Both recognizers emit the descriptor documented above. Cursors advance
  ;; after each access; match time folds any original pre-access increment into
  ;; the displacement. term_kind selects count-to-zero or unsigned source-bound
  ;; termination. The optional shift/add pair covers 64K row lookup tables;
  ;; descriptor version 1 adds a second moving byte source for blend tables.
  (func $th_lut_run (param $op i32)
    (local $version i32)
    (local $wide16 i32)
    (local $table_stack i32)
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
    (local.set $version (i32.and (local.get $op) (i32.const 1)))
    (local.set $wide16
      (i32.and (i32.shr_u (local.get $op) (i32.const 1)) (i32.const 1)))
    (local.set $table_stack
      (i32.and (i32.shr_u (local.get $op) (i32.const 2)) (i32.const 1)))
    (local.set $tp (global.get $ip))
    (global.set $ip (i32.add (local.get $tp)
      (select (i32.const 112)
        (select
          (select (i32.const 96) (i32.const 92) (local.get $table_stack))
          (i32.const 88) (local.get $wide16))
        (local.get $version))))
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
    (if (local.get $version)
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
    (if (local.get $version)
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
        (if (i32.ge_s (local.get $tbl_reg) (i32.const 0))
          (then
            (local.set $tbl_base (call $get_reg (local.get $tbl_reg)))
            (local.set $tbl (i32.add (local.get $tbl_base) (local.get $table_disp))))
          (else (local.set $tbl (local.get $table_disp))))))
    (if (i32.ge_s (local.get $add_reg) (i32.const 0))
      (then (local.set $add (call $get_reg (local.get $add_reg)))))

    ;; Translate the complete lookup range once when it is the normal affine
    ;; guest window. Version 1 indexes all 64KB; the two-endpoint guard keeps
    ;; sparse mappings on gl8.
    (local.set $tbl_wa (i32.const 0))
    (if (i32.and
          (i32.and (i32.eqz (local.get $version)) (i32.eqz (local.get $wide16)))
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
        (if (local.get $version)
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
                (i32.and (local.get $version) (local.get $term_stream))))
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
        (if (local.get $version)
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
        (if (local.get $version)
          (then (local.set $src2_wa (call $g2w (local.get $src2_ga)))))
        (if (i32.or
              (i32.eq (local.get $src_wa) (global.get $NULL_SENTINEL))
              (i32.or
                (i32.eq (local.get $dst_wa) (global.get $NULL_SENTINEL))
                (i32.and (local.get $version)
                  (i32.eq (local.get $src2_wa) (global.get $NULL_SENTINEL)))))
          (then (local.set $chunk (i32.const 1))))
        (call $invalidate_code_write
          (i32.and (local.get $dst_ga) (i32.const 0xFFFFF000)) (i32.const 4096))

        (local.set $n (local.get $chunk))
        (loop $inner
          (if (i32.eq (local.get $src_wa) (global.get $NULL_SENTINEL))
            (then (local.set $src_b (call $gl8 (local.get $src_ga))))
            (else (local.set $src_b (i32.load8_u (local.get $src_wa)))))
          (if (local.get $version)
            (then
              (if (i32.eq (local.get $src2_wa) (global.get $NULL_SENTINEL))
                (then (local.set $aux (call $gl8 (local.get $src2_ga))))
                (else (local.set $aux (i32.load8_u (local.get $src2_wa)))))))
          (local.set $index (i32.shl (local.get $src_b) (local.get $index_shift)))
          (if (local.get $version)
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
          (if (local.get $version)
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
        (if (local.get $version)
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
            (i32.and (local.get $version) (local.get $term_stream))))
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
        (local.get $version)))
    (if (local.get $table_stack)
      (then (call $set_reg (local.get $tbl_reg) (local.get $tbl_base))))
    (if (local.get $version)
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
