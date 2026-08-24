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

  ;; Set from the host: test/run.js --trace-loopmatch[=0xEIP].
  (global $loop_trace (mut i32) (i32.const 0))
  (global $loop_trace_eip (mut i32) (i32.const 0))
  (global $loop_selfloop_blocks (mut i32) (i32.const 0))
  (global $loop_matched_blocks (mut i32) (i32.const 0))
  ;; Set from the host: --no-loop-superops, to A/B the lowering without a
  ;; rebuild. The matcher still runs and still counts, it just does not emit.
  (global $loop_emit_enabled (mut i32) (i32.const 1))

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
  ;; Parameter block, emitted as raw words after the super-op header:
  ;;   0 iv_reg      1 iv_stride   2 src_disp   3 dst_disp
  ;;   4 tbl_reg     5 acc_reg     6 ctr_reg    7 ctr_step
  ;;   8 m0_addr     9 m0_reg     10 m0_adj
  ;;  11 m1_addr    12 m1_reg     13 m1_adj
  ;;  14 fall_eip   15 back_eip   16 steps_per_iter
  (global $LOOP_SUPEROP_LUT i32 (i32.const 418))
  (global $LOOP_LUT_PARAMS i32 (i32.const 17))

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

    ;; Fold the cursor bump into the displacements. The super-op always bumps
    ;; the cursor first, so an access the original performed BEFORE the bump
    ;; saw a cursor one stride behind and needs its displacement pulled back
    ;; by that much. An access after the bump already agrees and is left alone.
    (if (i32.gt_u (local.get $iv_idx) (local.get $ld_idx))
      (then (local.set $ld_disp (i32.sub (local.get $ld_disp) (local.get $iv_stride)))))
    (if (i32.gt_u (local.get $iv_idx) (local.get $st_idx))
      (then (local.set $st_disp (i32.sub (local.get $st_disp) (local.get $iv_stride)))))

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
    (if (i32.eqz (global.get $loop_emit_enabled)) (then (return (i32.const 0))))

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
    (call $te_raw (local.get $st_disp))
    (call $te_raw (local.get $tbl_reg))
    (call $te_raw (local.get $acc_reg))
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
    (if (i32.eqz (global.get $loop_emit_enabled)) (then (return (i32.const 0))))

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
  ;; gather. Strides here are only ever +1 or -1: the ADDI role is inc/dec.
  (func $copy_page_room (param $ga i32) (param $stride i32) (result i32)
    (if (i32.eq (local.get $stride) (i32.const 1))
      (then
        (return (i32.sub (i32.const 0x1000)
                         (i32.and (local.get $ga) (i32.const 0xFFF))))))
    (i32.add (i32.and (local.get $ga) (i32.const 0xFFF)) (i32.const 1)))

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
        (call $invalidate_code_write (local.get $dst_ga))

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
    (if (call $loop_try_lut (local.get $start_eip) (local.get $tstart)) (then (return)))
    (drop (call $loop_try_copy (local.get $start_eip) (local.get $tstart))))

  ;; ------------------------------------------------------------------
  ;; 418: the LUT_RUN super-op.
  ;; ------------------------------------------------------------------
  ;; Runs the whole remap inside one handler invocation. It still charges
  ;; $steps per iteration -- at the op count of the body it replaced, so batch
  ;; granularity and the host's grip on the thread are unchanged -- and when
  ;; the budget runs out it republishes $eip at the loop entry and returns,
  ;; exactly as if the interpreter had reached the back edge.
  ;;
  ;; The spill stores are written on every exit, not every iteration. They are
  ;; observable only at a block boundary, and every path out of here is one.
  (func $th_lut_run (param $op i32)
    (local $iv_reg i32) (local $iv_stride i32) (local $src_disp i32) (local $dst_disp i32)
    (local $tbl_reg i32) (local $acc_reg i32) (local $ctr_reg i32) (local $ctr_step i32)
    (local $m0_addr i32) (local $m0_reg i32) (local $m0_adj i32)
    (local $m1_addr i32) (local $m1_reg i32) (local $m1_adj i32)
    (local $fall i32) (local $back i32) (local $cost i32)
    (local $iv i32) (local $ctr i32) (local $tbl i32) (local $old i32) (local $b i32)
    (local $src_ga i32) (local $dst_ga i32) (local $src_wa i32) (local $dst_wa i32)
    (local $tbl_wa i32) (local $chunk i32) (local $trips i32) (local $allowed i32)
    (local $n i32)

    (local.set $iv_reg    (call $read_thread_word))
    (local.set $iv_stride (call $read_thread_word))
    (local.set $src_disp  (call $read_thread_word))
    (local.set $dst_disp  (call $read_thread_word))
    (local.set $tbl_reg   (call $read_thread_word))
    (local.set $acc_reg   (call $read_thread_word))
    (local.set $ctr_reg   (call $read_thread_word))
    (local.set $ctr_step  (call $read_thread_word))
    (local.set $m0_addr   (call $read_thread_word))
    (local.set $m0_reg    (call $read_thread_word))
    (local.set $m0_adj    (call $read_thread_word))
    (local.set $m1_addr   (call $read_thread_word))
    (local.set $m1_reg    (call $read_thread_word))
    (local.set $m1_adj    (call $read_thread_word))
    (local.set $fall      (call $read_thread_word))
    (local.set $back      (call $read_thread_word))
    (local.set $cost      (call $read_thread_word))

    (local.set $iv  (call $get_reg (local.get $iv_reg)))
    (local.set $ctr (call $get_reg (local.get $ctr_reg)))
    (local.set $tbl (call $get_reg (local.get $tbl_reg)))

    ;; The lookup table is loop-invariant, so its translation can be resolved
    ;; once for the whole run instead of once per byte. Only when all 256
    ;; entries sit in one page: $g2w is affine within a map record and nothing
    ;; guarantees the page after the table's is backed adjacently. A table that
    ;; straddles a page keeps $gl8, whose page cache handles two pages fine.
    (local.set $tbl_wa (i32.const 0))
    (if (i32.le_u (i32.and (local.get $tbl) (i32.const 0xFFF)) (i32.const 0xF00))
      (then
        (local.set $n (call $g2w (local.get $tbl)))
        (if (i32.ne (local.get $n) (global.get $NULL_SENTINEL))
          (then (local.set $tbl_wa (local.get $n))))))

    ;; Same page-chunking as COPY_RUN: the two iv-driven streams are resolved
    ;; once per page rather than once per byte. Nothing can change a mapping
    ;; while this handler is on the stack -- new records come only from API
    ;; calls, and no guest code runs in here.
    (block $exit
      (loop $outer
        ;; iv is stepped at the TOP of the original's body, so the first
        ;; iteration of this chunk already works one stride along.
        (local.set $src_ga
          (i32.add (i32.add (local.get $iv) (local.get $iv_stride)) (local.get $src_disp)))
        (local.set $dst_ga
          (i32.add (i32.add (local.get $iv) (local.get $iv_stride)) (local.get $dst_disp)))

        (local.set $trips
          (select (local.get $ctr)
                  (i32.sub (i32.const 0) (local.get $ctr))
                  (i32.eq (local.get $ctr_step) (i32.const -1))))
        (if (i32.eqz (local.get $trips))
          (then (local.set $trips (i32.const -1))))
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
        (local.set $n (call $copy_page_room (local.get $src_ga) (local.get $iv_stride)))
        (local.set $chunk
          (select (local.get $n) (local.get $chunk)
                  (i32.lt_u (local.get $n) (local.get $chunk))))
        (local.set $n (call $copy_page_room (local.get $dst_ga) (local.get $iv_stride)))
        (local.set $chunk
          (select (local.get $n) (local.get $chunk)
                  (i32.lt_u (local.get $n) (local.get $chunk))))

        (local.set $src_wa (call $g2w (local.get $src_ga)))
        (local.set $dst_wa (call $g2w (local.get $dst_ga)))
        (if (i32.or
              (i32.eq (local.get $src_wa) (global.get $NULL_SENTINEL))
              (i32.eq (local.get $dst_wa) (global.get $NULL_SENTINEL)))
          (then (local.set $chunk (i32.const 1))))

        (call $invalidate_code_write (local.get $dst_ga))

        (local.set $n (local.get $chunk))
        (loop $inner
          (local.set $b (i32.load8_u (local.get $src_wa)))
          (if (local.get $tbl_wa)
            (then (local.set $b
              (i32.load8_u (i32.add (local.get $tbl_wa) (local.get $b)))))
            (else (local.set $b
              (call $gl8 (i32.add (local.get $b) (local.get $tbl))))))
          (i32.store8 (local.get $dst_wa) (local.get $b))
          (local.set $src_wa (i32.add (local.get $src_wa) (local.get $iv_stride)))
          (local.set $dst_wa (i32.add (local.get $dst_wa) (local.get $iv_stride)))
          (local.set $n (i32.sub (local.get $n) (i32.const 1)))
          (br_if $inner (local.get $n)))

        (local.set $iv
          (i32.add (local.get $iv) (i32.mul (local.get $chunk) (local.get $iv_stride))))
        (local.set $ctr
          (i32.add (local.get $ctr) (i32.mul (local.get $chunk) (local.get $ctr_step))))
        (local.set $old (i32.sub (local.get $ctr) (local.get $ctr_step)))
        (global.set $steps
          (i32.sub (global.get $steps) (i32.mul (local.get $chunk) (local.get $cost))))
        (br_if $exit (i32.eqz (local.get $ctr)))
        (br_if $exit (i32.le_s (global.get $steps) (i32.const 0)))
        (br $outer)))

    ;; The accumulator was zeroed at the top of every iteration, so after the
    ;; table load it holds the translated byte and nothing else -- and only the
    ;; last iteration's value is observable, since every path out of here is a
    ;; block boundary. Written before the cursor and counter, which is the
    ;; order the per-iteration version left behind if the three ever alias.
    (call $set_reg (local.get $acc_reg) (local.get $b))
    (call $set_reg (local.get $iv_reg) (local.get $iv))
    (call $set_reg (local.get $ctr_reg) (local.get $ctr))
    ;; The original computes these with DEC/INC, whose flags the branch reads.
    (if (i32.eq (local.get $ctr_step) (i32.const -1))
      (then (call $set_flags_dec (local.get $old) (local.get $ctr)))
      (else (call $set_flags_inc (local.get $old) (local.get $ctr))))
    (if (local.get $m0_addr)
      (then (call $gs32 (local.get $m0_addr)
              (i32.add (call $get_reg (local.get $m0_reg)) (local.get $m0_adj)))))
    (if (local.get $m1_addr)
      (then (call $gs32 (local.get $m1_addr)
              (i32.add (call $get_reg (local.get $m1_reg)) (local.get $m1_adj)))))
    (global.set $eip
      (select (local.get $back) (local.get $fall) (i32.ne (local.get $ctr) (i32.const 0)))))
