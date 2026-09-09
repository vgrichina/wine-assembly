  ;; ============================================================
  ;; x86 DECODER — Full i486 with ModR/M + SIB
  ;; ============================================================

  ;; Decode ModR/M + optional SIB + displacement.
  ;; Returns the effective address as a guest virtual address.
  ;; Advances $d_pc (decoder PC, guest addr).
  ;; $d_pc is a global used during decoding.
  (global $d_pc (mut i32) (i32.const 0))

  ;; Where $decode_block's last block landed in its page chunk: the offset it
  ;; starts at, and the offset one past its end. Both are -1 when the block was
  ;; not published at all. $decode_run reads them to decide whether two
  ;; successive blocks really are adjacent in the chunk, which is the whole
  ;; licence for treating a not-taken branch as free.
  (global $d_pub_off (mut i32) (i32.const -1))
  (global $d_pub_end (mut i32) (i32.const -1))

  ;; Where the last block stopped emitting, which is NOT the same thing as
  ;; $thread_alloc once $decode_block has returned: publishing a block that
  ;; opens a page makes $page_create reserve a whole chunk off the same bump
  ;; pointer, so $thread_alloc can be a chunk's width past the block's real end.
  ;; Reading the terminator back out of the stream needs the real end.
  (global $d_block_end (mut i32) (i32.const 0))

  ;; --no-sib-fusion: emit the unfused compute_ea_sib + consumer pair instead
  ;; of the fused single handler. On by default. This exists because
  ;; docs/interpreter-dispatch-perf.md's rule for keeping a fusion is an
  ;; op-count delta AND a zero png-diff AND a timing run — and a fusion that
  ;; needs a rebuild to switch off cannot be A/B'd on one box in one sitting.
  ;; Decode-time only, so the flag itself costs nothing on the hot path.
  (global $sib_fusion_enabled (mut i32) (i32.const 1))
  ;; Where $sib_store_at leaves the operands of the store it just matched. Not
  ;; return values because there are three of them and one is the length.
  (global $fuse_info (mut i32) (i32.const 0))
  (global $fuse_disp (mut i32) (i32.const 0))
  ;; The unrolled-rectangle fold, on its own switch so it can be A/B'd against
  ;; the per-pair fold it sits on top of without a rebuild.
  (global $rect_run_enabled (mut i32) (i32.const 1))
  ;; $th_case_chain's switch-ladder fold. Off switch is for A/B only -- the
  ;; fold is exact, not a heuristic, so there is no correctness reason to run
  ;; without it.
  (global $case_chain_enabled (mut i32) (i32.const 1))
  ;; Below four cases the descriptor costs more than the block ends it saves.
  ;; Caesar's ladder is sixteen.
  (global $CASE_CHAIN_MIN i32 (i32.const 4))
  ;; Bounded so one descriptor cannot eat the decoder's 16KB emit headroom.
  (global $CASE_CHAIN_MAX i32 (i32.const 64))

  ;; $th_rle_run's run-length blit fold. Off switch for A/B; see
  ;; $try_emit_rle_run for what it matches and $th_rle_run for what it runs.
  (global $rle_run_enabled (mut i32) (i32.const 1))
  ;; Under four cases it is a switch, not a run-length ladder.
  (global $RLE_MIN_CASES i32 (i32.const 4))
  ;; A descriptor is 8 words a case; keep the whole thing inside the emit
  ;; headroom $decode_block reserves.
  (global $RLE_MAX_CASES i32 (i32.const 32))
  ;; $rle_body's out-params: what one case of the ladder does, in the same
  ;; eight fields $th_rle_run replays.
  (global $rb_kind    (mut i32) (i32.const 0))   ;; 0 = literal run, 1 = skip run
  (global $rb_insn    (mut i32) (i32.const 0))   ;; dispatches the body cost
  (global $rb_src_off (mut i32) (i32.const 0))
  (global $rb_dst_off (mut i32) (i32.const 0))
  (global $rb_bytes   (mut i32) (i32.const 0))   ;; literal: bytes; skip: multiplier
  (global $rb_src_adv (mut i32) (i32.const 0))
  (global $rb_dst_adv (mut i32) (i32.const 0))
  (global $rb_cnt_dec (mut i32) (i32.const 0))
  (global $rb_dst_reg (mut i32) (i32.const 0))   ;; learned from the first literal run
  ;; $rle_pair's out-params: one `cmp T8,imm8 / jz case` of the ladder.
  (global $rp_imm    (mut i32) (i32.const 0))
  (global $rp_target (mut i32) (i32.const 0))

  ;; Decoder-time, nonterminal LUT spans. Unlike H418 these are not loops:
  ;; an indirect jump has already selected one suffix of a fully unrolled
  ;; renderer, and execution continues into the ordinary row tail afterwards.
  ;; Keep separate counters so a real profile can distinguish the two shapes
  ;; even though both belong to the LUT_RUN family semantically.
  (global $lut_span_matches (mut i32) (i32.const 0))
  (global $lut_span_runs    (mut i32) (i32.const 0))
  (global $lut_span_bytes   (mut i64) (i64.const 0))
  ;; Raw-instruction scanners return several fields through these globals.
  (global $ls_base       (mut i32) (i32.const 0))
  (global $ls_index      (mut i32) (i32.const 0))
  (global $ls_table      (mut i32) (i32.const 0))
  (global $ls_disp       (mut i32) (i32.const 0))
  (global $ls_len        (mut i32) (i32.const 0))

  ;; How many `cmp al,imm8 / jz target` pairs start at $pc, counting only
  ;; those that lie wholly inside $page. Both jz encodings are accepted --
  ;; Caesar's ladder mixes one rel8 in among fifteen rel32s, so refusing
  ;; either form would split the ladder in two.
  (func $case_chain_count (param $pc i32) (param $page i32) (result i32)
    (local $n i32) (local $b i32)
    (block $stop (loop $l
      (br_if $stop (i32.ge_u (local.get $n) (global.get $CASE_CHAIN_MAX)))
      (br_if $stop (i32.ne (call $gl8 (local.get $pc)) (i32.const 0x3C)))
      (local.set $b (call $gl8 (i32.add (local.get $pc) (i32.const 2))))
      (if (i32.eq (local.get $b) (i32.const 0x74))
        (then (local.set $pc (i32.add (local.get $pc) (i32.const 4))))
        (else
          (if (i32.and (i32.eq (local.get $b) (i32.const 0x0F))
                       (i32.eq (call $gl8 (i32.add (local.get $pc) (i32.const 3)))
                               (i32.const 0x84)))
            (then (local.set $pc (i32.add (local.get $pc) (i32.const 8))))
            (else (br $stop)))))
      ;; The pair's last byte must still be in this page: a block belongs to
      ;; exactly one compiled page, same rule as the page-edge cut below.
      (br_if $stop (i32.ne
        (i32.and (i32.sub (local.get $pc) (i32.const 1)) (i32.const 0xFFFFF000))
        (local.get $page)))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br $l)))
    (local.get $n))

  ;; Emit the fold for the $n pairs at $d_pc and leave $d_pc one past the
  ;; ladder, which is also the default target.
  (func $emit_case_chain (param $n i32)
    (local $i i32) (local $imm i32) (local $b i32) (local $tgt i32) (local $end i32)
    ;; Pass one: where the ladder ends. The header word has to be written
    ;; before the pairs, and it names the default, so the end is needed first.
    (local.set $end (global.get $d_pc))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $end (i32.add (local.get $end)
        (if (result i32)
          (i32.eq (call $gl8 (i32.add (local.get $end) (i32.const 2)))
                  (i32.const 0x74))
          (then (i32.const 4)) (else (i32.const 8)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (call $te (i32.const 428) (local.get $n))
    (call $te_raw (local.get $end))
    ;; Pass two: the (imm, target) pairs, consuming $d_pc as it goes.
    (local.set $i (i32.const 0))
    (block $d2 (loop $l2
      (br_if $d2 (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $imm (call $gl8 (i32.add (global.get $d_pc) (i32.const 1))))
      (local.set $b (call $gl8 (i32.add (global.get $d_pc) (i32.const 2))))
      (if (i32.eq (local.get $b) (i32.const 0x74))
        (then
          (local.set $tgt (i32.add (i32.add (global.get $d_pc) (i32.const 4))
            (call $sign_ext8 (call $gl8 (i32.add (global.get $d_pc) (i32.const 3))))))
          (global.set $d_pc (i32.add (global.get $d_pc) (i32.const 4))))
        (else
          (local.set $tgt (i32.add (i32.add (global.get $d_pc) (i32.const 8))
            (call $gl32 (i32.add (global.get $d_pc) (i32.const 4)))))
          (global.set $d_pc (i32.add (global.get $d_pc) (i32.const 8)))))
      (call $te_raw (local.get $imm))
      (call $te_raw (local.get $tgt))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2))))
  ;; ---- the run-length blit fold ($th_rle_run) --------------------------
  ;; One `cmp T8,imm8 / jz case` of the ladder at $pc: its length, or 0. Both
  ;; jz encodings, same grammar $case_chain_count counts.
  (func $rle_pair (param $pc i32) (result i32)
    (local $b i32)
    (if (i32.ne (call $gl8 (local.get $pc)) (i32.const 0x3C))
      (then (return (i32.const 0))))
    (global.set $rp_imm (call $gl8 (i32.add (local.get $pc) (i32.const 1))))
    (local.set $b (call $gl8 (i32.add (local.get $pc) (i32.const 2))))
    (if (i32.eq (local.get $b) (i32.const 0x74))
      (then
        (global.set $rp_target (i32.add (i32.add (local.get $pc) (i32.const 4))
          (call $sign_ext8 (call $gl8 (i32.add (local.get $pc) (i32.const 3))))))
        (return (i32.const 4))))
    (if (i32.and (i32.eq (local.get $b) (i32.const 0x0F))
                 (i32.eq (call $gl8 (i32.add (local.get $pc) (i32.const 3)))
                         (i32.const 0x84)))
      (then
        (global.set $rp_target (i32.add (i32.add (local.get $pc) (i32.const 8))
          (call $gl32 (i32.add (local.get $pc) (i32.const 4)))))
        (return (i32.const 8))))
    (i32.const 0))

  ;; ModRM with no SIB: bytes consumed from the ModRM byte on, and the
  ;; displacement it encodes. Callers reject rm==4 (SIB) and mod==0/rm==5
  ;; (disp32-absolute) first, so those forms never reach here.
  (func $rle_ea_len (param $m i32) (result i32)
    (local $mod i32)
    (local.set $mod (i32.shr_u (local.get $m) (i32.const 6)))
    (if (i32.eq (local.get $mod) (i32.const 1)) (then (return (i32.const 2))))
    (if (i32.eq (local.get $mod) (i32.const 2)) (then (return (i32.const 5))))
    (i32.const 1))
  (func $rle_ea_disp (param $pc i32) (param $m i32) (result i32)
    (local $mod i32)
    (local.set $mod (i32.shr_u (local.get $m) (i32.const 6)))
    (if (i32.eq (local.get $mod) (i32.const 1))
      (then (return (call $sign_ext8
        (call $gl8 (i32.add (local.get $pc) (i32.const 1)))))))
    (if (i32.eq (local.get $mod) (i32.const 2))
      (then (return (call $gl32 (i32.add (local.get $pc) (i32.const 1))))))
    (i32.const 0))
  ;; Is this ModRM `[base]`-addressed with register $reg on the register side?
  (func $rle_mem_ok (param $m i32) (param $reg i32) (param $base i32) (result i32)
    (local $mod i32) (local $rm i32)
    (local.set $mod (i32.shr_u (local.get $m) (i32.const 6)))
    (local.set $rm (i32.and (local.get $m) (i32.const 7)))
    (if (i32.eq (local.get $mod) (i32.const 3)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $rm) (i32.const 4)) (then (return (i32.const 0))))
    (if (i32.and (i32.eqz (local.get $mod)) (i32.eq (local.get $rm) (i32.const 5)))
      (then (return (i32.const 0))))
    (if (i32.ne (local.get $rm) (local.get $base)) (then (return (i32.const 0))))
    (i32.eq (i32.and (i32.shr_u (local.get $m) (i32.const 3)) (i32.const 7))
            (local.get $reg)))

  ;; The transparent-run case: `xor T,T / mov T8,[S+d] / add D,T (x mul) /
  ;; add S,imm / sub C,T / jmp head`. The three tail ops in any order.
  (func $rle_skip_body (param $pc i32) (param $S i32) (param $C i32)
                       (param $T i32) (param $D i32) (param $head i32) (result i32)
    (local $b i32) (local $m i32) (local $insn i32) (local $mul i32)
    (local $seen_s i32) (local $seen_c i32) (local $tgt i32)
    (if (i32.ne (call $gl8 (local.get $pc)) (i32.const 0x33))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl8 (i32.add (local.get $pc) (i32.const 1)))
                (i32.or (i32.const 0xC0)
                  (i32.or (i32.shl (local.get $T) (i32.const 3)) (local.get $T))))
      (then (return (i32.const 0))))
    (local.set $pc (i32.add (local.get $pc) (i32.const 2)))
    (local.set $insn (i32.const 1))
    ;; the count byte
    (if (i32.ne (call $gl8 (local.get $pc)) (i32.const 0x8A))
      (then (return (i32.const 0))))
    (local.set $m (call $gl8 (i32.add (local.get $pc) (i32.const 1))))
    (if (i32.eqz (call $rle_mem_ok (local.get $m) (local.get $T) (local.get $S)))
      (then (return (i32.const 0))))
    (global.set $rb_src_off
      (call $rle_ea_disp (i32.add (local.get $pc) (i32.const 1)) (local.get $m)))
    (local.set $pc (i32.add (i32.add (local.get $pc) (i32.const 1))
                            (call $rle_ea_len (local.get $m))))
    (local.set $insn (i32.add (local.get $insn) (i32.const 1)))
    (block $tail (loop $tl
      (local.set $b (call $gl8 (local.get $pc)))
      (local.set $m (call $gl8 (i32.add (local.get $pc) (i32.const 1))))
      ;; add D,T -- twice for a 16bpp destination, so the multiplier is counted
      (if (i32.and (i32.eq (local.get $b) (i32.const 0x03))
            (i32.eq (local.get $m) (i32.or (i32.const 0xC0)
              (i32.or (i32.shl (local.get $D) (i32.const 3)) (local.get $T)))))
        (then
          (local.set $mul (i32.add (local.get $mul) (i32.const 1)))
          (local.set $pc (i32.add (local.get $pc) (i32.const 2)))
          (local.set $insn (i32.add (local.get $insn) (i32.const 1)))
          (br $tl)))
      ;; sub C,T
      (if (i32.and (i32.eq (local.get $b) (i32.const 0x2B))
            (i32.eq (local.get $m) (i32.or (i32.const 0xC0)
              (i32.or (i32.shl (local.get $C) (i32.const 3)) (local.get $T)))))
        (then
          (local.set $seen_c (i32.add (local.get $seen_c) (i32.const 1)))
          (local.set $pc (i32.add (local.get $pc) (i32.const 2)))
          (local.set $insn (i32.add (local.get $insn) (i32.const 1)))
          (br $tl)))
      ;; add S,imm8
      (if (i32.and (i32.eq (local.get $b) (i32.const 0x83))
            (i32.eq (local.get $m) (i32.or (i32.const 0xC0) (local.get $S))))
        (then
          (global.set $rb_src_adv (call $sign_ext8
            (call $gl8 (i32.add (local.get $pc) (i32.const 2)))))
          (local.set $seen_s (i32.add (local.get $seen_s) (i32.const 1)))
          (local.set $pc (i32.add (local.get $pc) (i32.const 3)))
          (local.set $insn (i32.add (local.get $insn) (i32.const 1)))
          (br $tl)))
      (br $tail)))
    (if (i32.eqz (local.get $mul)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $seen_s) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $seen_c) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.le_s (global.get $rb_src_adv) (i32.const 0)) (then (return (i32.const 0))))
    ;; back to the head
    (local.set $b (call $gl8 (local.get $pc)))
    (if (i32.eq (local.get $b) (i32.const 0xE9))
      (then (local.set $tgt (i32.add (i32.add (local.get $pc) (i32.const 5))
              (call $gl32 (i32.add (local.get $pc) (i32.const 1))))))
      (else
        (if (i32.eq (local.get $b) (i32.const 0xEB))
          (then (local.set $tgt (i32.add (i32.add (local.get $pc) (i32.const 2))
                  (call $sign_ext8 (call $gl8 (i32.add (local.get $pc) (i32.const 1)))))))
          (else (return (i32.const 0))))))
    (if (i32.ne (local.get $tgt) (local.get $head)) (then (return (i32.const 0))))
    (global.set $rb_kind (i32.const 1))
    (global.set $rb_bytes (local.get $mul))
    (global.set $rb_insn (i32.add (local.get $insn) (i32.const 1)))
    (i32.const 1))

  ;; The literal-run case: k unrolled `mov X,[S+d] / mov [D+d],X` pairs (a
  ;; 16-bit pair may close an odd one out), then `add S,a / add D,b /
  ;; sub C,c / jmp head`. Every displacement is checked against the one
  ;; predicted from its predecessor, so an accepted run is one the
  ;; instruction stream spelled out contiguously -- same rule as $sprite_scan.
  ;; $Din is 0xFF on the pass that learns which register the destination is.
  (func $rle_copy_body (param $pc i32) (param $S i32) (param $C i32)
                       (param $T i32) (param $Din i32) (param $head i32) (result i32)
    (local $b i32) (local $m i32) (local $m2 i32) (local $q i32) (local $D i32)
    (local $disp i32) (local $disp2 i32) (local $step i32) (local $o16 i32)
    (local $bytes i32) (local $insn i32) (local $pairs i32) (local $started i32)
    (local $srcn i32) (local $dstn i32) (local $imm i32) (local $tgt i32)
    (local $seen_s i32) (local $seen_d i32) (local $seen_c i32) (local $reg i32)
    (local.set $D (local.get $Din))
    (block $pdone (loop $pl
      (local.set $o16 (i32.eq (call $gl8 (local.get $pc)) (i32.const 0x66)))
      (br_if $pdone (i32.ne
        (call $gl8 (i32.add (local.get $pc) (local.get $o16))) (i32.const 0x8B)))
      (local.set $m (call $gl8
        (i32.add (i32.add (local.get $pc) (local.get $o16)) (i32.const 1))))
      (br_if $pdone (i32.eqz
        (call $rle_mem_ok (local.get $m) (local.get $T) (local.get $S))))
      (local.set $disp (call $rle_ea_disp
        (i32.add (i32.add (local.get $pc) (local.get $o16)) (i32.const 1))
        (local.get $m)))
      (local.set $q (i32.add
        (i32.add (i32.add (local.get $pc) (local.get $o16)) (i32.const 1))
        (call $rle_ea_len (local.get $m))))
      ;; the store of the same register, same operand size
      (if (local.get $o16)
        (then
          (br_if $pdone (i32.ne (call $gl8 (local.get $q)) (i32.const 0x66)))
          (local.set $q (i32.add (local.get $q) (i32.const 1)))))
      (br_if $pdone (i32.ne (call $gl8 (local.get $q)) (i32.const 0x89)))
      (local.set $m2 (call $gl8 (i32.add (local.get $q) (i32.const 1))))
      ;; The destination register is whatever the first store names; every
      ;; later store in every later case has to name the same one.
      (if (i32.eq (local.get $D) (i32.const 0xFF))
        (then
          (local.set $D (i32.and (local.get $m2) (i32.const 7)))
          (br_if $pdone (i32.or
            (i32.eq (local.get $D) (local.get $S))
            (i32.or (i32.eq (local.get $D) (local.get $C))
                    (i32.eq (local.get $D) (local.get $T)))))))
      (br_if $pdone (i32.eqz
        (call $rle_mem_ok (local.get $m2) (local.get $T) (local.get $D))))
      (local.set $disp2 (call $rle_ea_disp
        (i32.add (local.get $q) (i32.const 1)) (local.get $m2)))
      (local.set $step (if (result i32) (local.get $o16)
        (then (i32.const 2)) (else (i32.const 4))))
      (if (local.get $started)
        (then
          (br_if $pdone (i32.ne (local.get $disp) (local.get $srcn)))
          (br_if $pdone (i32.ne (local.get $disp2) (local.get $dstn))))
        (else
          (global.set $rb_src_off (local.get $disp))
          (global.set $rb_dst_off (local.get $disp2))
          (local.set $started (i32.const 1))))
      (local.set $srcn (i32.add (local.get $disp) (local.get $step)))
      (local.set $dstn (i32.add (local.get $disp2) (local.get $step)))
      (local.set $bytes (i32.add (local.get $bytes) (local.get $step)))
      (local.set $pairs (i32.add (local.get $pairs) (i32.const 1)))
      (local.set $insn (i32.add (local.get $insn) (i32.const 2)))
      (local.set $pc (i32.add (i32.add (local.get $q) (i32.const 1))
                              (call $rle_ea_len (local.get $m2))))
      ;; a 16-bit pair is the odd pixel at the end of a run, never the middle
      (br_if $pdone (local.get $o16))
      (br $pl)))
    (if (i32.eqz (local.get $pairs)) (then (return (i32.const 0))))
    ;; the three advances, in any order, each exactly once
    (block $adone (loop $al
      (br_if $adone (i32.ne (call $gl8 (local.get $pc)) (i32.const 0x83)))
      (local.set $m (call $gl8 (i32.add (local.get $pc) (i32.const 1))))
      (br_if $adone (i32.ne (i32.shr_u (local.get $m) (i32.const 6)) (i32.const 3)))
      (local.set $reg (i32.and (i32.shr_u (local.get $m) (i32.const 3)) (i32.const 7)))
      (local.set $imm (call $sign_ext8
        (call $gl8 (i32.add (local.get $pc) (i32.const 2)))))
      (if (i32.and (i32.eqz (local.get $reg))
                   (i32.eq (i32.and (local.get $m) (i32.const 7)) (local.get $S)))
        (then (global.set $rb_src_adv (local.get $imm))
              (local.set $seen_s (i32.add (local.get $seen_s) (i32.const 1))))
        (else
          (if (i32.and (i32.eqz (local.get $reg))
                       (i32.eq (i32.and (local.get $m) (i32.const 7)) (local.get $D)))
            (then (global.set $rb_dst_adv (local.get $imm))
                  (local.set $seen_d (i32.add (local.get $seen_d) (i32.const 1))))
            (else
              (if (i32.and (i32.eq (local.get $reg) (i32.const 5))
                           (i32.eq (i32.and (local.get $m) (i32.const 7)) (local.get $C)))
                (then (global.set $rb_cnt_dec (local.get $imm))
                      (local.set $seen_c (i32.add (local.get $seen_c) (i32.const 1))))
                (else (br $adone)))))))
      (local.set $pc (i32.add (local.get $pc) (i32.const 3)))
      (local.set $insn (i32.add (local.get $insn) (i32.const 1)))
      (br $al)))
    (if (i32.ne (local.get $seen_s) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $seen_d) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.ne (local.get $seen_c) (i32.const 1)) (then (return (i32.const 0))))
    ;; A run that does not shorten the row is one this fold would spin on.
    (if (i32.le_s (global.get $rb_cnt_dec) (i32.const 0)) (then (return (i32.const 0))))
    (if (i32.le_s (global.get $rb_src_adv) (i32.const 0)) (then (return (i32.const 0))))
    (local.set $b (call $gl8 (local.get $pc)))
    (if (i32.eq (local.get $b) (i32.const 0xE9))
      (then (local.set $tgt (i32.add (i32.add (local.get $pc) (i32.const 5))
              (call $gl32 (i32.add (local.get $pc) (i32.const 1))))))
      (else
        (if (i32.eq (local.get $b) (i32.const 0xEB))
          (then (local.set $tgt (i32.add (i32.add (local.get $pc) (i32.const 2))
                  (call $sign_ext8 (call $gl8 (i32.add (local.get $pc) (i32.const 1)))))))
          (else (return (i32.const 0))))))
    (if (i32.ne (local.get $tgt) (local.get $head)) (then (return (i32.const 0))))
    (global.set $rb_kind (i32.const 0))
    (global.set $rb_bytes (local.get $bytes))
    (global.set $rb_dst_reg (local.get $D))
    (global.set $rb_insn (i32.add (local.get $insn) (i32.const 1)))
    (i32.const 1))

  ;; One case of the ladder, either kind. Clears the out-params first so a
  ;; field a kind does not set can never carry over from the previous case.
  (func $rle_body (param $pc i32) (param $S i32) (param $C i32) (param $T i32)
                  (param $D i32) (param $head i32) (result i32)
    (global.set $rb_kind (i32.const 0)) (global.set $rb_insn (i32.const 0))
    (global.set $rb_src_off (i32.const 0)) (global.set $rb_dst_off (i32.const 0))
    (global.set $rb_bytes (i32.const 0)) (global.set $rb_src_adv (i32.const 0))
    (global.set $rb_dst_adv (i32.const 0)) (global.set $rb_cnt_dec (i32.const 0))
    (if (i32.ne (local.get $D) (i32.const 0xFF))
      (then
        (if (call $rle_skip_body (local.get $pc) (local.get $S) (local.get $C)
                                 (local.get $T) (local.get $D) (local.get $head))
          (then (return (i32.const 1))))))
    (call $rle_copy_body (local.get $pc) (local.get $S) (local.get $C)
                         (local.get $T) (local.get $D) (local.get $head)))

  ;; Fold the whole nest into $th_rle_run. Called at a block start, because
  ;; the head is one: `cmp C,imm / jle EXIT` is entered afresh once a token.
  (func $try_emit_rle_run (param $start_eip i32) (result i32)
    (local $pc i32) (local $b i32) (local $m i32) (local $S i32) (local $C i32)
    (local $T i32) (local $D i32) (local $cmp_imm i32) (local $exit_eip i32)
    (local $head i32) (local $lad i32) (local $dflt i32) (local $n i32)
    (local $i i32) (local $len i32) (local $tgt i32)
    (if (i32.eqz (global.get $rle_run_enabled)) (then (return (i32.const 0))))
    (if (i32.or (global.get $code16) (global.get $d_addr16))
      (then (return (i32.const 0))))
    (if (global.get $d_seg) (then (return (i32.const 0))))
    (local.set $head (global.get $d_pc))
    (local.set $pc (local.get $head))
    ;; cmp C, imm8
    (if (i32.ne (call $gl8 (local.get $pc)) (i32.const 0x83))
      (then (return (i32.const 0))))
    (local.set $m (call $gl8 (i32.add (local.get $pc) (i32.const 1))))
    (if (i32.ne (i32.shr_u (local.get $m) (i32.const 6)) (i32.const 3))
      (then (return (i32.const 0))))
    (if (i32.ne (i32.and (i32.shr_u (local.get $m) (i32.const 3)) (i32.const 7))
                (i32.const 7))
      (then (return (i32.const 0))))
    (local.set $C (i32.and (local.get $m) (i32.const 7)))
    (local.set $cmp_imm (call $sign_ext8
      (call $gl8 (i32.add (local.get $pc) (i32.const 2)))))
    (local.set $pc (i32.add (local.get $pc) (i32.const 3)))
    ;; jle EXIT -- the row's only way out
    (local.set $b (call $gl8 (local.get $pc)))
    (if (i32.eq (local.get $b) (i32.const 0x7E))
      (then
        (local.set $exit_eip (i32.add (i32.add (local.get $pc) (i32.const 2))
          (call $sign_ext8 (call $gl8 (i32.add (local.get $pc) (i32.const 1))))))
        (local.set $pc (i32.add (local.get $pc) (i32.const 2))))
      (else
        (if (i32.and (i32.eq (local.get $b) (i32.const 0x0F))
                     (i32.eq (call $gl8 (i32.add (local.get $pc) (i32.const 1)))
                             (i32.const 0x8E)))
          (then
            (local.set $exit_eip (i32.add (i32.add (local.get $pc) (i32.const 6))
              (call $gl32 (i32.add (local.get $pc) (i32.const 2)))))
            (local.set $pc (i32.add (local.get $pc) (i32.const 6))))
          (else (return (i32.const 0))))))
    ;; mov T8, [S]
    (if (i32.ne (call $gl8 (local.get $pc)) (i32.const 0x8A))
      (then (return (i32.const 0))))
    (local.set $m (call $gl8 (i32.add (local.get $pc) (i32.const 1))))
    (if (i32.ne (i32.shr_u (local.get $m) (i32.const 6)) (i32.const 0))
      (then (return (i32.const 0))))
    (local.set $S (i32.and (local.get $m) (i32.const 7)))
    (if (i32.or (i32.eq (local.get $S) (i32.const 4))
                (i32.eq (local.get $S) (i32.const 5)))
      (then (return (i32.const 0))))
    (local.set $T (i32.and (i32.shr_u (local.get $m) (i32.const 3)) (i32.const 7)))
    ;; a byte read into AH..BH is a different register than the copy bodies use
    (if (i32.ge_u (local.get $T) (i32.const 4)) (then (return (i32.const 0))))
    (if (i32.or (i32.eq (local.get $T) (local.get $S))
                (i32.eq (local.get $T) (local.get $C)))
      (then (return (i32.const 0))))
    (if (i32.eq (local.get $S) (local.get $C)) (then (return (i32.const 0))))
    (local.set $pc (i32.add (local.get $pc) (i32.const 2)))

    ;; the ladder
    (local.set $lad (local.get $pc))
    (local.set $n (call $case_chain_count (local.get $lad)
      (i32.and (local.get $start_eip) (i32.const 0xFFFFF000))))
    (if (i32.lt_u (local.get $n) (global.get $RLE_MIN_CASES))
      (then (return (i32.const 0))))
    ;; Truncating would leave the tail of the ladder unconsumed and name the
    ;; wrong default, so an over-long one declines rather than folds partly.
    (if (i32.gt_u (local.get $n) (global.get $RLE_MAX_CASES))
      (then (return (i32.const 0))))
    (local.set $i (i32.const 0))
    (block $ldone (loop $ll
      (br_if $ldone (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $len (call $rle_pair (local.get $pc)))
      (if (i32.eqz (local.get $len)) (then (return (i32.const 0))))
      (local.set $pc (i32.add (local.get $pc) (local.get $len)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $ll)))
    ;; the default arm: a jmp to it, or the body sitting right here
    (local.set $b (call $gl8 (local.get $pc)))
    (if (i32.eq (local.get $b) (i32.const 0xE9))
      (then (local.set $dflt (i32.add (i32.add (local.get $pc) (i32.const 5))
              (call $gl32 (i32.add (local.get $pc) (i32.const 1))))))
      (else
        (if (i32.eq (local.get $b) (i32.const 0xEB))
          (then (local.set $dflt (i32.add (i32.add (local.get $pc) (i32.const 2))
                  (call $sign_ext8 (call $gl8 (i32.add (local.get $pc) (i32.const 1)))))))
          (else (local.set $dflt (local.get $pc))))))

    ;; Pass one learns the destination register from the first literal run.
    (local.set $D (i32.const 0xFF))
    (local.set $pc (local.get $lad))
    (local.set $i (i32.const 0))
    (block $done1 (loop $l1
      (if (i32.ge_u (local.get $i) (local.get $n))
        (then
          (if (call $rle_body (local.get $dflt) (local.get $S) (local.get $C)
                              (local.get $T) (i32.const 0xFF) (local.get $head))
            (then (local.set $D (global.get $rb_dst_reg))))
          (br $done1)))
      (local.set $len (call $rle_pair (local.get $pc)))
      (if (call $rle_body (global.get $rp_target) (local.get $S) (local.get $C)
                          (local.get $T) (i32.const 0xFF) (local.get $head))
        (then (local.set $D (global.get $rb_dst_reg)) (br $done1)))
      (local.set $pc (i32.add (local.get $pc) (local.get $len)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l1)))
    (if (i32.eq (local.get $D) (i32.const 0xFF)) (then (return (i32.const 0))))

    ;; Pass two: every case must classify with that destination, or nothing
    ;; folds -- a case this decoder cannot read is a case it cannot run.
    (local.set $pc (local.get $lad))
    (local.set $i (i32.const 0))
    (block $done2 (loop $l2
      (br_if $done2 (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $len (call $rle_pair (local.get $pc)))
      (if (i32.eqz (call $rle_body (global.get $rp_target) (local.get $S)
            (local.get $C) (local.get $T) (local.get $D) (local.get $head)))
        (then
          (return (i32.const 0))))
      (local.set $pc (i32.add (local.get $pc) (local.get $len)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2)))
    (if (i32.eqz (call $rle_body (local.get $dflt) (local.get $S) (local.get $C)
                                 (local.get $T) (local.get $D) (local.get $head)))
      (then (return (i32.const 0))))

    ;; Emit: header, then one 8-word record a case, the default last.
    (call $te (i32.const 429) (i32.or
      (i32.or (local.get $S) (i32.shl (local.get $D) (i32.const 4)))
      (i32.or (i32.shl (local.get $C) (i32.const 8))
        (i32.or (i32.shl (local.get $T) (i32.const 12))
                (i32.shl (local.get $n) (i32.const 16))))))
    (call $te_raw (local.get $exit_eip))
    (call $te_raw (local.get $cmp_imm))
    ;; what the head costs a token: cmp, jle, mov T8,[S]
    (call $te_raw (i32.const 3))
    (call $te_raw (local.get $head))
    (local.set $pc (local.get $lad))
    (local.set $i (i32.const 0))
    (block $done3 (loop $l3
      (if (i32.ge_u (local.get $i) (local.get $n))
        (then
          (drop (call $rle_body (local.get $dflt) (local.get $S) (local.get $C)
                                (local.get $T) (local.get $D) (local.get $head)))
          ;; 0x1FF can never equal a byte, so the default record is only ever
          ;; reached by the scan falling off the end.
          (call $te_raw (i32.const 0x1FF))
          (call $rle_emit_body)
          (br $done3)))
      (local.set $len (call $rle_pair (local.get $pc)))
      (local.set $tgt (global.get $rp_target))
      (local.set $b (global.get $rp_imm))
      (drop (call $rle_body (local.get $tgt) (local.get $S) (local.get $C)
                            (local.get $T) (local.get $D) (local.get $head)))
      (call $te_raw (local.get $b))
      (call $rle_emit_body)
      (local.set $pc (i32.add (local.get $pc) (local.get $len)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l3)))
    (i32.const 1))

  ;; MechWarrior 3's menu compositor is one branchy RGB565 alpha row. Its
  ;; three alpha arms split the back-edge across four basic blocks, so the
  ;; self-loop matcher cannot see the loop as a unit. Keep this exact and
  ;; opt-in under COPY_RUN's existing rollback gate.
  ;;
  ;; The executor takes the trip count from [EBP-0x18] on every entry. That
  ;; bound is the game's clipped row width; no screen-size guess is involved.
  (func $try_emit_rgb565_alpha_run (param $start_eip i32) (result i32)
    (local $p i32) (local $end i32) (local $hash i32)
    (if (i32.or
          (i32.eqz (call $loop_copy_emit_get))
          (global.get $code16))
      (then (return (i32.const 0))))
    ;; Exact head and exact induction/back-edge tail. Checking both ends keeps
    ;; a partially patched binary on the ordinary decoder path.
    (if (i32.or
          (i32.ne (call $gl32 (local.get $start_eip)) (i32.const 0x8A0C4D8B))
          (i32.or
            (i32.ne (call $gl32 (i32.add (local.get $start_eip) (i32.const 4)))
              (i32.const 0x03F98009))
            (i32.or
              (i32.ne (call $gl32 (i32.add (local.get $start_eip) (i32.const 0x93)))
                (i32.const 0x8B0C758B))
              (i32.ne (call $gl32 (i32.add (local.get $start_eip) (i32.const 0xA7)))
                (i32.const 0xFF53850F)))))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl16 (i32.add (local.get $start_eip) (i32.const 0xAB)))
                (i32.const 0xFFFF))
      (then (return (i32.const 0))))
    ;; The old matcher sampled only the head and induction tail because the
    ;; original VA was also part of the predicate. Once relocation is allowed,
    ;; prove every byte of the 173-byte branch-split body. FNV is a decode-time
    ;; rejection filter layered on the sampled structural checks above.
    (local.set $p (local.get $start_eip))
    (local.set $end (i32.add (local.get $start_eip) (i32.const 0xAD)))
    (local.set $hash (i32.const 0x811c9dc5))
    (loop $hash_bytes
      (local.set $hash
        (i32.mul
          (i32.xor (local.get $hash) (call $gl8 (local.get $p)))
          (i32.const 0x01000193)))
      (local.set $p (i32.add (local.get $p) (i32.const 1)))
      (br_if $hash_bytes (i32.lt_u (local.get $p) (local.get $end))))
    (if (i32.ne (local.get $hash) (i32.const 0xe93ce905))
      (then (return (i32.const 0))))
    (global.set $loop_rgb565_alpha_matches
      (i32.add (global.get $loop_rgb565_alpha_matches) (i32.const 1)))
    (call $te (i32.const 436) (i32.const 0))
    (call $te_raw (i32.add (local.get $start_eip) (i32.const 0xAD))) ;; fall
    (call $te_raw (local.get $start_eip))                            ;; back
    (global.set $d_pc (i32.add (local.get $start_eip) (i32.const 0xAD)))
    (i32.const 1))

  ;; MW3's transparent RGB565 row has a conditional store between its compare
  ;; and induction back edge, so no single emitted self-loop block contains the
  ;; whole operation. Match the complete authentic 19-byte sequence at its one
  ;; verified encoding and keep it under MW3's process-wide COPY_RUN opt-in.
  ;; The back/fall addresses are derived from the matched location so another
  ;; game build can use the same exact loop at a different VA.
  (func $try_emit_rgb565_colorkey_run (param $start_eip i32) (result i32)
    (if (i32.or (i32.eqz (call $loop_copy_emit_get)) (global.get $code16))
      (then (return (i32.const 0))))
    (if (i32.or
          (i32.ne (call $gl32 (local.get $start_eip))
            (i32.const 0x66088b66))
          (i32.or
            (i32.ne (call $gl32
              (i32.add (local.get $start_eip) (i32.const 4)))
              (i32.const 0x740c4d3b))
            (i32.or
              (i32.ne (call $gl32
                (i32.add (local.get $start_eip) (i32.const 8)))
                (i32.const 0x0c896604))
              (i32.ne (call $gl32
                (i32.add (local.get $start_eip) (i32.const 12)))
                (i32.const 0x02c08318)))))
      (then (return (i32.const 0))))
    (if (i32.or
          (i32.ne (call $gl16
            (i32.add (local.get $start_eip) (i32.const 16)))
            (i32.const 0x754e))
          (i32.ne (call $gl8
            (i32.add (local.get $start_eip) (i32.const 18)))
            (i32.const 0xed)))
      (then (return (i32.const 0))))
    (global.set $loop_rgb565_colorkey_matches
      (i32.add (global.get $loop_rgb565_colorkey_matches) (i32.const 1)))
    (call $te (i32.const 440) (i32.const 0))
    (call $te_raw (i32.add (local.get $start_eip) (i32.const 19))) ;; fall
    (call $te_raw (local.get $start_eip))                          ;; back
    (global.set $d_pc (i32.add (local.get $start_eip) (i32.const 19)))
    (i32.const 1))

  ;; MW3's in-place 16-bit terrain/grid filter. This single basic block is a
  ;; 101-byte, 37-instruction counted loop, so ordinary execution pays a
  ;; changing indirect threaded dispatch for every scalar load/add/store.
  ;; Prove the complete authentic body and derive its control-flow addresses
  ;; from the match so differently linked copies remain eligible.
  (func $try_emit_mw3_grid_filter_run (param $start_eip i32) (result i32)
    (local $p i32) (local $end i32) (local $hash i32)
    (if (i32.or (i32.eqz (call $loop_copy_emit_get)) (global.get $code16))
      (then (return (i32.const 0))))
    (if (i32.or
          (i32.ne (call $gl32 (local.get $start_eip))
            (i32.const 0x2024548b))
          (i32.or
            (i32.ne (call $gl32
              (i32.add (local.get $start_eip) (i32.const 95)))
              (i32.const 0x14244c8b))
            (i32.ne (call $gl16
              (i32.add (local.get $start_eip) (i32.const 99)))
              (i32.const 0x9b75))))
      (then (return (i32.const 0))))
    (local.set $p (local.get $start_eip))
    (local.set $end (i32.add (local.get $start_eip) (i32.const 101)))
    (local.set $hash (i32.const 0x811c9dc5))
    (loop $hash_bytes
      (local.set $hash
        (i32.mul
          (i32.xor (local.get $hash) (call $gl8 (local.get $p)))
          (i32.const 0x01000193)))
      (local.set $p (i32.add (local.get $p) (i32.const 1)))
      (br_if $hash_bytes (i32.lt_u (local.get $p) (local.get $end))))
    (if (i32.ne (local.get $hash) (i32.const 0x11ad09b2))
      (then (return (i32.const 0))))
    (global.set $loop_mw3_grid_filter_matches
      (i32.add (global.get $loop_mw3_grid_filter_matches) (i32.const 1)))
    (call $te (i32.const 441) (i32.const 0))
    (call $te_raw (i32.add (local.get $start_eip) (i32.const 101))) ;; fall
    (call $te_raw (local.get $start_eip))                           ;; back
    (global.set $d_pc (i32.add (local.get $start_eip) (i32.const 101)))
    (i32.const 1))

  ;; The seven words after a case record's token byte.
  (func $rle_emit_body
    (call $te_raw (i32.or (global.get $rb_kind)
                          (i32.shl (global.get $rb_insn) (i32.const 16))))
    (call $te_raw (global.get $rb_src_off))
    (call $te_raw (global.get $rb_dst_off))
    (call $te_raw (global.get $rb_bytes))
    (call $te_raw (global.get $rb_src_adv))
    (call $te_raw (global.get $rb_dst_adv))
    (call $te_raw (global.get $rb_cnt_dec)))

  ;; ---- fully unrolled LUT/blend spans (handler 431) ------------------
  ;; These helpers inspect exact, unprefixed 32-bit encodings. Returning zero
  ;; is always a conservative decline; accepted memory operands have no
  ;; segment/address-size ambiguity and remain wholly in this compiled page.

  ;; `xor r,r`, for a register with an addressable low byte. Return r+1 so
  ;; EAX is distinguishable from a miss.
  (func $lut_xor_at (param $p i32) (result i32)
    (local $op i32) (local $m i32) (local $r i32)
    (local.set $op (call $gl8 (local.get $p)))
    (if (i32.and (i32.ne (local.get $op) (i32.const 0x31))
                 (i32.ne (local.get $op) (i32.const 0x33)))
      (then (return (i32.const 0))))
    (local.set $m (call $gl8 (i32.add (local.get $p) (i32.const 1))))
    (if (i32.ne (i32.shr_u (local.get $m) (i32.const 6)) (i32.const 3))
      (then (return (i32.const 0))))
    (local.set $r (i32.and (local.get $m) (i32.const 7)))
    (if (i32.or (i32.ge_u (local.get $r) (i32.const 4))
                (i32.ne (i32.and (i32.shr_u (local.get $m) (i32.const 3))
                                 (i32.const 7))
                        (local.get $r)))
      (then (return (i32.const 0))))
    (i32.add (local.get $r) (i32.const 1)))

  ;; `mov r8,[base+disp]`, no SIB and no absolute form.
  (func $lut_base_load8_at (param $p i32) (param $reg i32) (result i32)
    (local $m i32) (local $mod i32) (local $base i32)
    (if (i32.ne (call $gl8 (local.get $p)) (i32.const 0x8A))
      (then (return (i32.const 0))))
    (local.set $m (call $gl8 (i32.add (local.get $p) (i32.const 1))))
    (if (i32.ne (i32.and (i32.shr_u (local.get $m) (i32.const 3))
                         (i32.const 7))
                (local.get $reg))
      (then (return (i32.const 0))))
    (local.set $mod (i32.shr_u (local.get $m) (i32.const 6)))
    (local.set $base (i32.and (local.get $m) (i32.const 7)))
    (if (i32.or (i32.eq (local.get $mod) (i32.const 3))
          (i32.or (i32.eq (local.get $base) (i32.const 4))
                  (i32.and (i32.eqz (local.get $mod))
                           (i32.eq (local.get $base) (i32.const 5)))))
      (then (return (i32.const 0))))
    (global.set $ls_base (local.get $base))
    (global.set $ls_len (i32.add (i32.const 1) (call $rle_ea_len (local.get $m))))
    (global.set $ls_disp
      (call $rle_ea_disp (i32.add (local.get $p) (i32.const 1)) (local.get $m)))
    (i32.const 1))

  ;; One-source table lookup: `mov acc8,[acc+table]`, scale 1, no displacement.
  (func $lut_table1_at (param $p i32) (param $acc i32) (result i32)
    (local $m i32) (local $sib i32) (local $base i32) (local $idx i32)
    (if (i32.ne (call $gl8 (local.get $p)) (i32.const 0x8A))
      (then (return (i32.const 0))))
    (local.set $m (call $gl8 (i32.add (local.get $p) (i32.const 1))))
    (if (i32.or (i32.ne (local.get $m)
          (i32.or (i32.const 0x04) (i32.shl (local.get $acc) (i32.const 3))))
        (i32.ne (i32.shr_u (local.get $m) (i32.const 6)) (i32.const 0)))
      (then (return (i32.const 0))))
    (local.set $sib (call $gl8 (i32.add (local.get $p) (i32.const 2))))
    (if (i32.ne (i32.shr_u (local.get $sib) (i32.const 6)) (i32.const 0))
      (then (return (i32.const 0))))
    (local.set $base (i32.and (local.get $sib) (i32.const 7)))
    (local.set $idx (i32.and (i32.shr_u (local.get $sib) (i32.const 3)) (i32.const 7)))
    (if (i32.eq (local.get $base) (local.get $acc))
      (then (global.set $ls_table (local.get $idx)))
      (else
        (if (i32.eq (local.get $idx) (local.get $acc))
          (then (global.set $ls_table (local.get $base)))
          (else (return (i32.const 0))))))
    (if (i32.or (i32.eq (global.get $ls_table) (i32.const 4))
                (i32.eq (global.get $ls_table) (local.get $acc)))
      (then (return (i32.const 0))))
    (global.set $ls_len (i32.const 3))
    (i32.const 1))

  ;; One-source result store: `mov [base+disp],acc8`, no SIB.
  (func $lut_store1_at (param $p i32) (param $acc i32) (result i32)
    (local $m i32) (local $mod i32) (local $base i32)
    (if (i32.ne (call $gl8 (local.get $p)) (i32.const 0x88))
      (then (return (i32.const 0))))
    (local.set $m (call $gl8 (i32.add (local.get $p) (i32.const 1))))
    (if (i32.ne (i32.and (i32.shr_u (local.get $m) (i32.const 3))
                         (i32.const 7))
                (local.get $acc))
      (then (return (i32.const 0))))
    (local.set $mod (i32.shr_u (local.get $m) (i32.const 6)))
    (local.set $base (i32.and (local.get $m) (i32.const 7)))
    (if (i32.or (i32.eq (local.get $mod) (i32.const 3))
          (i32.or (i32.eq (local.get $base) (i32.const 4))
                  (i32.and (i32.eqz (local.get $mod))
                           (i32.eq (local.get $base) (i32.const 5)))))
      (then (return (i32.const 0))))
    (global.set $ls_base (local.get $base))
    (global.set $ls_len (i32.add (i32.const 1) (call $rle_ea_len (local.get $m))))
    (global.set $ls_disp
      (call $rle_ea_disp (i32.add (local.get $p) (i32.const 1)) (local.get $m)))
    (i32.const 1))

  ;; Blend table lookup: `mov acc8,[acc+aux+disp]`, scale 1.
  (func $lut_blend_table_at (param $p i32) (param $acc i32) (param $aux i32)
                            (result i32)
    (local $m i32) (local $mod i32) (local $sib i32)
    (local $base i32) (local $idx i32)
    (if (i32.ne (call $gl8 (local.get $p)) (i32.const 0x8A))
      (then (return (i32.const 0))))
    (local.set $m (call $gl8 (i32.add (local.get $p) (i32.const 1))))
    (if (i32.or
          (i32.ne (i32.and (i32.shr_u (local.get $m) (i32.const 3))
                           (i32.const 7)) (local.get $acc))
          (i32.ne (i32.and (local.get $m) (i32.const 7)) (i32.const 4)))
      (then (return (i32.const 0))))
    (local.set $mod (i32.shr_u (local.get $m) (i32.const 6)))
    (if (i32.or (i32.eqz (local.get $mod))
                (i32.eq (local.get $mod) (i32.const 3)))
      (then (return (i32.const 0))))
    (local.set $sib (call $gl8 (i32.add (local.get $p) (i32.const 2))))
    (if (i32.ne (i32.shr_u (local.get $sib) (i32.const 6)) (i32.const 0))
      (then (return (i32.const 0))))
    (local.set $base (i32.and (local.get $sib) (i32.const 7)))
    (local.set $idx (i32.and (i32.shr_u (local.get $sib) (i32.const 3)) (i32.const 7)))
    (if (i32.eqz (i32.or
          (i32.and (i32.eq (local.get $base) (local.get $acc))
                   (i32.eq (local.get $idx) (local.get $aux)))
          (i32.and (i32.eq (local.get $base) (local.get $aux))
                   (i32.eq (local.get $idx) (local.get $acc)))))
      (then (return (i32.const 0))))
    (global.set $ls_len
      (select (i32.const 4) (i32.const 7) (i32.eq (local.get $mod) (i32.const 1))))
    (global.set $ls_disp
      (select
        (call $sign_ext8 (call $gl8 (i32.add (local.get $p) (i32.const 3))))
        (call $gl32 (i32.add (local.get $p) (i32.const 3)))
        (i32.eq (local.get $mod) (i32.const 1))))
    (i32.const 1))

  ;; Blend destination store: `mov [base+index+disp],acc8`, scale 1.
  (func $lut_blend_store_at (param $p i32) (param $acc i32) (result i32)
    (local $m i32) (local $mod i32) (local $sib i32)
    (if (i32.ne (call $gl8 (local.get $p)) (i32.const 0x88))
      (then (return (i32.const 0))))
    (local.set $m (call $gl8 (i32.add (local.get $p) (i32.const 1))))
    (if (i32.or
          (i32.ne (i32.and (i32.shr_u (local.get $m) (i32.const 3))
                           (i32.const 7)) (local.get $acc))
          (i32.ne (i32.and (local.get $m) (i32.const 7)) (i32.const 4)))
      (then (return (i32.const 0))))
    (local.set $mod (i32.shr_u (local.get $m) (i32.const 6)))
    (if (i32.eq (local.get $mod) (i32.const 3))
      (then (return (i32.const 0))))
    (local.set $sib (call $gl8 (i32.add (local.get $p) (i32.const 2))))
    (if (i32.ne (i32.shr_u (local.get $sib) (i32.const 6)) (i32.const 0))
      (then (return (i32.const 0))))
    (global.set $ls_base (i32.and (local.get $sib) (i32.const 7)))
    (global.set $ls_index
      (i32.and (i32.shr_u (local.get $sib) (i32.const 3)) (i32.const 7)))
    (if (i32.or (i32.eq (global.get $ls_index) (i32.const 4))
                (i32.and (i32.eqz (local.get $mod))
                         (i32.eq (global.get $ls_base) (i32.const 5))))
      (then (return (i32.const 0))))
    (global.set $ls_len
      (select (i32.const 3)
        (select (i32.const 4) (i32.const 7)
                (i32.eq (local.get $mod) (i32.const 1)))
        (i32.eqz (local.get $mod))))
    (global.set $ls_disp
      (select (i32.const 0)
        (select
          (call $sign_ext8 (call $gl8 (i32.add (local.get $p) (i32.const 3))))
          (call $gl32 (i32.add (local.get $p) (i32.const 3)))
          (i32.eq (local.get $mod) (i32.const 1)))
        (i32.eqz (local.get $mod))))
    (i32.const 1))

  (func $lut_shl8_at (param $p i32) (param $reg i32) (result i32)
    (i32.and
      (i32.eq (call $gl8 (local.get $p)) (i32.const 0xC1))
      (i32.and
        (i32.eq (call $gl8 (i32.add (local.get $p) (i32.const 1)))
                (i32.or (i32.const 0xE0) (local.get $reg)))
        (i32.eq (call $gl8 (i32.add (local.get $p) (i32.const 2)))
                (i32.const 8)))))

  ;; Jazz 2's hottest lighting pass has already been unrolled by its compiler:
  ;; eight in-place pixels become eight reads from two selected 256-byte rows
  ;; of a 64K lookup table, then two packed dword stores. It is a fixed span,
  ;; not the surrounding row loop, so keep it in nonterminal H431. The exact
  ;; byte proof is intentionally local: mode 2 can later accept another
  ;; structurally equivalent producer without weakening the ordinary H431
  ;; one/two-stream predicates.
  (func $try_emit_lut_span8_rows (result i32)
    (local $p i32)
    (local.set $p (global.get $d_pc))
    ;; The compiled block may not own instruction bytes from the next page.
    (if (i32.gt_u (i32.and (local.get $p) (i32.const 0xFFF)) (i32.const 0xF96))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (local.get $p)) (i32.const 0xD233C033))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 4)))
                (i32.const 0xFF00E181)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 8)))
                (i32.const 0x758B0000)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 12)))
                (i32.const 0x01E683F8)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 16)))
                (i32.const 0x8B02478A)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 20)))
                (i32.const 0xFF44B59C)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 24)))
                (i32.const 0xB18DFFFF)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 28)))
                (i32.const 0x0057BAE0)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 32)))
                (i32.const 0x5F8AE38A)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 36)))
                (i32.const 0x06148A03)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 40)))
                (i32.const 0x348A078A)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 44)))
                (i32.const 0x015F8A1E)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 48)))
                (i32.const 0x148ACA8B)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 52)))
                (i32.const 0x10E1C106)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 56)))
                (i32.const 0x8A06478A)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 60)))
                (i32.const 0x5F8A1E34)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 64)))
                (i32.const 0x8ACA0B07)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 68)))
                (i32.const 0x0F890614)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 72)))
                (i32.const 0x8B1E348A)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 76)))
                (i32.const 0x04478ACA)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 80)))
                (i32.const 0x8A10E1C1)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 84)))
                (i32.const 0x148A055F)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 88)))
                (i32.const 0xD0458B06)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 92)))
                (i32.const 0x8B1E348A)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 96)))
                (i32.const 0xD10BDC5D)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 100)))
                (i32.const 0x89E84D8B)) (then (return (i32.const 0))))
    (if (i32.ne (call $gl16 (i32.add (local.get $p) (i32.const 104)))
                (i32.const 0x0457)) (then (return (i32.const 0))))

    ;; op nibbles: pixel/dst EDI, absolute table, EAX result, mode 2,
    ;; frame EBP, packed result EDX, table-base result ESI.
    (call $te (i32.const 431) (i32.const 0x62520F77))
    (call $te_raw (i32.const -8))          ;; selector at [ebp-8]
    (call $te_raw (i32.const -188))        ;; row offsets at [ebp+4*s-0xbc]
    (call $te_raw (i32.const 35))          ;; original x86 instruction cost
    (call $te_raw (i32.const 0x57BAE0))    ;; absolute lookup-table base
    (call $te_raw (i32.const -48))         ;; final EAX from [ebp-0x30]
    (call $te_raw (i32.const -36))         ;; final EBX from [ebp-0x24]
    (call $te_raw (i32.const -24))         ;; final ECX from [ebp-0x18]
    (global.set $d_pc (i32.add (local.get $p) (i32.const 106)))
    (global.set $lut_span_matches
      (i32.add (global.get $lut_span_matches) (i32.const 1)))
    (i32.const 1))

  ;; dst[d..] = table[src[d..]], with all displacements descending by one.
  (func $try_emit_lut_span1 (result i32)
    (local $p i32) (local $end i32) (local $limit i32) (local $x i32)
    (local $acc i32) (local $src i32) (local $dst i32) (local $tbl i32)
    (local $disp i32) (local $start i32) (local $n i32) (local $first i32)
    (local.set $p (global.get $d_pc))
    (local.set $limit (i32.add (i32.and (local.get $p) (i32.const 0xFFFFF000))
                              (i32.const 0x1000)))
    (local.set $src (i32.const -1))
    (local.set $dst (i32.const -1))
    (local.set $tbl (i32.const -1))
    (local.set $first (i32.const 1))
    (block $stop (loop $scan
      ;; Longest exact unit is eleven bytes. Never make a compiled page own
      ;; guest bytes from its neighbour.
      (br_if $stop (i32.gt_u (local.get $p) (i32.sub (local.get $limit) (i32.const 11))))
      (local.set $x (call $lut_xor_at (local.get $p)))
      (br_if $stop (i32.eqz (local.get $x)))
      (local.set $x (i32.sub (local.get $x) (i32.const 1)))
      (if (local.get $first)
        (then (local.set $acc (local.get $x)))
        (else (br_if $stop (i32.ne (local.get $x) (local.get $acc)))))
      (local.set $p (i32.add (local.get $p) (i32.const 2)))
      (br_if $stop (i32.eqz (call $lut_base_load8_at (local.get $p) (local.get $acc))))
      (local.set $disp (global.get $ls_disp))
      (if (local.get $first)
        (then
          (local.set $src (global.get $ls_base))
          (local.set $start (local.get $disp)))
        (else
          (br_if $stop (i32.ne (global.get $ls_base) (local.get $src)))
          (br_if $stop (i32.ne (local.get $disp)
            (i32.sub (local.get $start) (local.get $n))))))
      (local.set $p (i32.add (local.get $p) (global.get $ls_len)))
      (br_if $stop (i32.eqz (call $lut_table1_at (local.get $p) (local.get $acc))))
      (if (local.get $first)
        (then (local.set $tbl (global.get $ls_table)))
        (else (br_if $stop (i32.ne (global.get $ls_table) (local.get $tbl)))))
      (local.set $p (i32.add (local.get $p) (global.get $ls_len)))
      (br_if $stop (i32.eqz (call $lut_store1_at (local.get $p) (local.get $acc))))
      (br_if $stop (i32.ne (global.get $ls_disp) (local.get $disp)))
      (if (local.get $first)
        (then
          (local.set $dst (global.get $ls_base))
          ;; The handler snapshots every address role before publishing acc.
          (br_if $stop (i32.or
            (i32.eq (local.get $acc) (local.get $src))
            (i32.or (i32.eq (local.get $acc) (local.get $dst))
                    (i32.eq (local.get $acc) (local.get $tbl)))))
          (local.set $first (i32.const 0)))
        (else (br_if $stop (i32.ne (global.get $ls_base) (local.get $dst)))))
      (local.set $p (i32.add (local.get $p) (global.get $ls_len)))
      (local.set $end (local.get $p))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br_if $stop (i32.ge_u (local.get $n) (i32.const 64)))
      (br $scan)))
    (if (i32.lt_u (local.get $n) (i32.const 4)) (then (return (i32.const 0))))
    (call $te (i32.const 431)
      (i32.or (local.get $src)
        (i32.or (i32.shl (local.get $dst) (i32.const 4))
          (i32.or (i32.shl (local.get $tbl) (i32.const 8))
            (i32.or (i32.shl (local.get $acc) (i32.const 12))
              (i32.or (i32.shl (i32.const 0xF) (i32.const 20))
                (i32.or (i32.shl (i32.const 0xF) (i32.const 24))
                        (i32.shl (i32.const 0xF) (i32.const 28)))))))))
    (call $te_raw (local.get $start))
    (call $te_raw (local.get $n))
    (call $te_raw (i32.shl (local.get $n) (i32.const 2)))
    (call $te_raw (i32.const 0))
    (call $te_raw (i32.const 0))
    (call $te_raw (i32.const 0))
    (global.set $d_pc (local.get $end))
    (global.set $lut_span_matches
      (i32.add (global.get $lut_span_matches) (i32.const 1)))
    (i32.const 1))

  ;; Symbolically validate a scheduled two-source blend. Loads for the next
  ;; pixel may move across the preceding store, so this is a tiny data-flow
  ;; recognizer rather than a byte signature. A checkpoint is accepted only
  ;; after a store whose last flag-setting instruction was XOR; the handler can
  ;; then publish exact scratch registers and lazy flags without a liveness
  ;; assumption about the following row tail.
  (func $try_emit_lut_span2 (result i32)
    (local $p i32) (local $limit i32) (local $x i32)
    (local $acc i32) (local $aux i32) (local $acc_state i32) (local $aux_state i32)
    (local $acc_disp i32) (local $aux_disp i32) (local $last_zero i32)
    (local $src1 i32) (local $src2 i32) (local $dst i32) (local $didx i32)
    (local $table_disp i32) (local $start i32) (local $n i32) (local $cost i32)
    (local $cp_end i32) (local $cp_n i32) (local $cp_cost i32)
    (local $cp_aux_kind i32) (local $cp_aux_disp i32)
    (local.set $p (global.get $d_pc))
    (local.set $limit (i32.add (i32.and (local.get $p) (i32.const 0xFFFFF000))
                              (i32.const 0x1000)))
    ;; A self-contained scheduled group starts by clearing both byte/index
    ;; registers. Later entry points reach another such group naturally.
    (local.set $x (call $lut_xor_at (local.get $p)))
    (if (i32.eqz (local.get $x)) (then (return (i32.const 0))))
    (local.set $acc (i32.sub (local.get $x) (i32.const 1)))
    (local.set $x (call $lut_xor_at (i32.add (local.get $p) (i32.const 2))))
    (if (i32.eqz (local.get $x)) (then (return (i32.const 0))))
    (local.set $aux (i32.sub (local.get $x) (i32.const 1)))
    (if (i32.eq (local.get $acc) (local.get $aux)) (then (return (i32.const 0))))
    (local.set $p (i32.add (local.get $p) (i32.const 4)))
    (local.set $acc_state (i32.const 1)) ;; zero
    (local.set $aux_state (i32.const 1))
    (local.set $last_zero (i32.const 1))
    (local.set $cost (i32.const 2))
    (local.set $src1 (i32.const -1))
    (local.set $src2 (i32.const -1))
    (local.set $dst (i32.const -1))
    (local.set $didx (i32.const -1))
    (block $stop (loop $scan
      (br_if $stop (i32.gt_u (local.get $p) (i32.sub (local.get $limit) (i32.const 7))))

      ;; Either scratch register may be cleared between scheduled loads.
      (local.set $x (call $lut_xor_at (local.get $p)))
      (if (i32.ne (local.get $x) (i32.const 0))
        (then
          (local.set $x (i32.sub (local.get $x) (i32.const 1)))
          (if (i32.eq (local.get $x) (local.get $acc))
            (then (local.set $acc_state (i32.const 1)))
            (else
              (if (i32.eq (local.get $x) (local.get $aux))
                (then (local.set $aux_state (i32.const 1)))
                (else (br $stop)))))
          (local.set $last_zero (i32.const 1))
          (local.set $cost (i32.add (local.get $cost) (i32.const 1)))
          (local.set $p (i32.add (local.get $p) (i32.const 2)))
          (br $scan)))

      (if (i32.and (i32.eq (local.get $acc_state) (i32.const 1))
                    (call $lut_base_load8_at (local.get $p) (local.get $acc)))
        (then
          (if (i32.lt_s (local.get $src1) (i32.const 0))
            (then (local.set $src1 (global.get $ls_base)))
            (else (br_if $stop (i32.ne (local.get $src1) (global.get $ls_base)))))
          (local.set $acc_disp (global.get $ls_disp))
          (local.set $acc_state (i32.const 2)) ;; source byte
          (local.set $cost (i32.add (local.get $cost) (i32.const 1)))
          (local.set $p (i32.add (local.get $p) (global.get $ls_len)))
          (br $scan)))

      (if (i32.and (i32.eq (local.get $aux_state) (i32.const 1))
                    (call $lut_base_load8_at (local.get $p) (local.get $aux)))
        (then
          (if (i32.lt_s (local.get $src2) (i32.const 0))
            (then (local.set $src2 (global.get $ls_base)))
            (else (br_if $stop (i32.ne (local.get $src2) (global.get $ls_base)))))
          (local.set $aux_disp (global.get $ls_disp))
          (local.set $aux_state (i32.const 2))
          (local.set $cost (i32.add (local.get $cost) (i32.const 1)))
          (local.set $p (i32.add (local.get $p) (global.get $ls_len)))
          (br $scan)))

      (if (i32.and (i32.eq (local.get $acc_state) (i32.const 2))
                    (call $lut_shl8_at (local.get $p) (local.get $acc)))
        (then
          (local.set $acc_state (i32.const 3)) ;; source byte << 8
          (local.set $last_zero (i32.const 0))
          (local.set $cost (i32.add (local.get $cost) (i32.const 1)))
          (local.set $p (i32.add (local.get $p) (i32.const 3)))
          (br $scan)))

      (if (i32.and
            (i32.and (i32.eq (local.get $acc_state) (i32.const 3))
                     (i32.eq (local.get $aux_state) (i32.const 2)))
            (call $lut_blend_table_at (local.get $p) (local.get $acc) (local.get $aux)))
        (then
          (br_if $stop (i32.ne (local.get $acc_disp) (local.get $aux_disp)))
          (if (i32.eqz (local.get $n))
            (then (local.set $table_disp (global.get $ls_disp)))
            (else (br_if $stop (i32.ne (local.get $table_disp) (global.get $ls_disp)))))
          (local.set $acc_state (i32.const 4)) ;; table result in low byte
          (local.set $cost (i32.add (local.get $cost) (i32.const 1)))
          (local.set $p (i32.add (local.get $p) (global.get $ls_len)))
          (br $scan)))

      (if (i32.and (i32.eq (local.get $acc_state) (i32.const 4))
                    (call $lut_blend_store_at (local.get $p) (local.get $acc)))
        (then
          (br_if $stop (i32.ne (global.get $ls_disp) (local.get $acc_disp)))
          (if (i32.eqz (local.get $n))
            (then
              (local.set $start (local.get $acc_disp))
              (local.set $dst (global.get $ls_base))
              (local.set $didx (global.get $ls_index))
              ;; Scratch writes must not change an address role the handler
              ;; snapshots once. Source/destination roles may alias each other.
              (br_if $stop (i32.or
                (i32.or (i32.eq (local.get $acc) (local.get $src1))
                        (i32.eq (local.get $acc) (local.get $src2)))
                (i32.or
                  (i32.or (i32.eq (local.get $acc) (local.get $dst))
                          (i32.eq (local.get $acc) (local.get $didx)))
                    (i32.or
                      (i32.or (i32.eq (local.get $aux) (local.get $src1))
                              (i32.eq (local.get $aux) (local.get $src2)))
                      (i32.or (i32.eq (local.get $aux) (local.get $dst))
                              (i32.eq (local.get $aux) (local.get $didx))))))))
            (else
              (br_if $stop (i32.ne (global.get $ls_base) (local.get $dst)))
              (br_if $stop (i32.ne (global.get $ls_index) (local.get $didx)))
              (br_if $stop (i32.ne (local.get $acc_disp)
                (i32.sub (local.get $start) (local.get $n))))))
          (local.set $p (i32.add (local.get $p) (global.get $ls_len)))
          (local.set $cost (i32.add (local.get $cost) (i32.const 1)))
          (local.set $n (i32.add (local.get $n) (i32.const 1)))
          (if (i32.and (i32.ge_u (local.get $n) (i32.const 4))
                       (local.get $last_zero))
            (then
              (local.set $cp_end (local.get $p))
              (local.set $cp_n (local.get $n))
              (local.set $cp_cost (local.get $cost))
              (local.set $cp_aux_kind (local.get $aux_state))
              (local.set $cp_aux_disp (local.get $aux_disp))))
          (br_if $stop (i32.ge_u (local.get $n) (i32.const 64)))
          (br $scan)))
      (br $stop)))

    (if (i32.lt_u (local.get $cp_n) (i32.const 4))
      (then (return (i32.const 0))))
    (call $te (i32.const 431)
      (i32.or (local.get $src1)
        (i32.or (i32.shl (local.get $dst) (i32.const 4))
          (i32.or (i32.shl (i32.const 0xF) (i32.const 8))
            (i32.or (i32.shl (local.get $acc) (i32.const 12))
              (i32.or (i32.shl (i32.const 1) (i32.const 16))
                (i32.or (i32.shl (local.get $src2) (i32.const 20))
                  (i32.or (i32.shl (local.get $didx) (i32.const 24))
                          (i32.shl (local.get $aux) (i32.const 28))))))))))
    (call $te_raw (local.get $start))
    (call $te_raw (local.get $cp_n))
    (call $te_raw (local.get $cp_cost))
    (call $te_raw (local.get $table_disp))
    (call $te_raw (local.get $cp_aux_kind))
    (call $te_raw (local.get $cp_aux_disp))
    (global.set $d_pc (local.get $cp_end))
    (global.set $lut_span_matches
      (i32.add (global.get $lut_span_matches) (i32.const 1)))
    (i32.const 1))

  (func $try_emit_lut_span (result i32)
    (if (i32.or (i32.eqz (global.get $loop_lut_emit_enabled))
                (global.get $code16))
      (then (return (i32.const 0))))
    (if (call $try_emit_lut_span8_rows) (then (return (i32.const 1))))
    (if (call $try_emit_lut_span1) (then (return (i32.const 1))))
    (call $try_emit_lut_span2))

  ;; $sprite_scan's out-params: where the run ended, how many dwords it moved,
  ;; and which register the row step adds.
  (global $sr_end (mut i32) (i32.const 0))
  (global $sr_pairs (mut i32) (i32.const 0))
  (global $sr_step (mut i32) (i32.const 0))

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
    (i32.extend8_s (local.get $v)))
  (func $sign_ext16 (param $v i32) (result i32)
    (i32.extend16_s (local.get $v)))

  ;; Target of a relative branch from the current $d_pc. In a 16-bit task the
  ;; sum wraps inside the code segment — a backwards jump near the start of a
  ;; segment must land at its top, not in the segment below — and the segment
  ;; base is read off $d_pc itself rather than $seg_base_cs, because decoding
  ;; happens for whatever address the cache asked for, not necessarily the one
  ;; CS currently names.
  (func $branch_target (param $disp i32) (result i32)
    (if (global.get $code16)
      (then (return (i32.or
        (i32.and (global.get $d_pc) (i32.const 0xFFFF0000))
        (i32.and (i32.add (global.get $d_pc) (local.get $disp)) (i32.const 0xFFFF))))))
    (i32.add (global.get $d_pc) (local.get $disp)))

  ;; Opcodes that only mean anything in a segmented task. Reaching one from
  ;; flat 32-bit code means the decoder has lost the instruction stream, and
  ;; saying so here beats emitting a segment load that corrupts addressing
  ;; from that point on.
  (func $win16_only (param $op i32)
    (if (i32.eqz (global.get $code16))
      (then
        (call $host_log_i32 (i32.const 0xCA165E00)) ;; segmented opcode in flat code
        (call $host_log_i32 (local.get $op))
        (call $host_log_i32 (global.get $d_pc))
        (unreachable))))

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
  ;; Segment the EA belongs to, in ModRM sreg encoding (0=ES 1=CS 2=SS 3=DS).
  ;; Only meaningful while $code16 — a flat 32-bit EA has no segment.
  (global $mr_seg   (mut i32) (i32.const 3))

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

    ;; mod=11: register direct — no EA, no segment adj
    (if (i32.eq (local.get $mod) (i32.const 3))
      (then (global.set $mr_val (local.get $rm)) (return)))

    ;; 16-bit addressing. The ModRM byte means something else entirely: rm
    ;; selects one of the [BX+SI]-style pairs rather than a 32-bit base/SIB.
    ;;
    ;; In a 16-bit task ($code16) every form is decoded, onto the same
    ;; base/index machinery the 32-bit path uses — [BX+SI] is exactly
    ;; base=EBX index=ESI scale=1 — and $mr_seg carries the segment the
    ;; address belongs to.
    ;;
    ;; In 32-bit code the prefix is rare and means something narrower, so only
    ;; the register-free form stays implemented: mod=00 with rm=6, a plain
    ;; 16-bit displacement, which is what Borland emits for `mov edx, fs:[4]`
    ;; (64 67 8b 16 04 00). The register forms there would need the effective
    ;; address truncated to 16 bits with no segment to wrap inside, so they
    ;; keep trapping rather than computing a wrong address.
    (if (global.get $d_addr16)
      (then
        (if (global.get $code16)
          (then (call $decode_modrm16 (local.get $mod) (local.get $rm)) (return)))
        (if (i32.and (i32.eq (local.get $mod) (i32.const 0)) (i32.eq (local.get $rm) (i32.const 6)))
          (then
            (global.set $mr_disp (call $d_fetch16))
            (call $apply_seg_override)
            (return)))
        (call $host_log_i32 (i32.const 0xCA5E1667)) ;; addr16 ModRM form
        (call $host_log_i32 (local.get $modrm))
        (call $host_log_i32 (global.get $d_pc))
        (unreachable)))

    (block $ea_done
      ;; mod=00
      (if (i32.eq (local.get $mod) (i32.const 0))
        (then
          (if (i32.eq (local.get $rm) (i32.const 4)) ;; SIB
            (then (call $decode_sib_info (i32.const 0)) (br $ea_done)))
          (if (i32.eq (local.get $rm) (i32.const 5)) ;; disp32 only
            (then (global.set $mr_disp (call $d_fetch32)) (br $ea_done)))
          ;; [reg] only
          (global.set $mr_base (local.get $rm))
          (br $ea_done)))

      ;; mod=01: [rm + disp8]
      (if (i32.eq (local.get $mod) (i32.const 1))
        (then
          (if (i32.eq (local.get $rm) (i32.const 4))
            (then (call $decode_sib_info (i32.const 1)))
            (else (global.set $mr_base (local.get $rm))))
          (global.set $mr_disp (i32.add (global.get $mr_disp) (call $sign_ext8 (call $d_fetch8))))
          (br $ea_done)))

      ;; mod=10: [rm + disp32]
      (if (i32.eq (local.get $rm) (i32.const 4))
        (then (call $decode_sib_info (i32.const 2)))
        (else (global.set $mr_base (local.get $rm))))
      (global.set $mr_disp (i32.add (global.get $mr_disp) (call $d_fetch32))))

    ;; A 32-bit address-size override in 16-bit code still uses segmented
    ;; addressing. Its default is SS for an EBP/ESP base and DS otherwise;
    ;; importantly this must replace, not inherit, $mr_seg. Civ II puts an
    ;; FS:[BX] access immediately before 67 [ESI-4], so retaining the prior
    ;; decode's FS selector reads its clipping table as bitmap metadata.
    (if (global.get $code16)
      (then
        (global.set $mr_seg
          (if (result i32)
            (i32.or (i32.eq (global.get $mr_base) (i32.const 4))
                    (i32.eq (global.get $mr_base) (i32.const 5)))
            (then (i32.const 2)) (else (i32.const 3))))
        (call $modrm16_apply_seg))
      (else
        ;; Centralized segment-override application for flat memory EAs.
        ;; Emitter-side calls remain in place but become idempotent no-ops.
        (call $apply_seg_override))))

  ;; 16-bit ModRM addressing, for a 16-bit task. The eight rm forms map onto
  ;; base/index directly:
  ;;
  ;;   0 [BX+SI]  1 [BX+DI]  2 [BP+SI]  3 [BP+DI]
  ;;   4 [SI]     5 [DI]     6 [BP] or disp16 when mod=00     7 [BX]
  ;;
  ;; The default segment is DS except where BP is the base, which is SS —
  ;; BP addresses a stack frame, and getting this wrong reads the data segment
  ;; at a frame offset, which is plausible garbage rather than a crash.
  (func $decode_modrm16 (param $mod i32) (param $rm i32)
    (global.set $mr_scale (i32.const 0))
    (global.set $mr_seg (i32.const 3)) ;; DS
    (if (i32.lt_u (local.get $rm) (i32.const 4))
      (then
        ;; [BX|BP + SI|DI]: bit 1 selects the base, bit 0 the index.
        (global.set $mr_base
          (if (result i32) (i32.and (local.get $rm) (i32.const 2)) (then (i32.const 5)) (else (i32.const 3))))
        (global.set $mr_index
          (if (result i32) (i32.and (local.get $rm) (i32.const 1)) (then (i32.const 7)) (else (i32.const 6))))
        (if (i32.and (local.get $rm) (i32.const 2)) (then (global.set $mr_seg (i32.const 2)))))
      (else
        (if (i32.eq (local.get $rm) (i32.const 4)) (then (global.set $mr_base (i32.const 6))))  ;; [SI]
        (if (i32.eq (local.get $rm) (i32.const 5)) (then (global.set $mr_base (i32.const 7))))  ;; [DI]
        (if (i32.eq (local.get $rm) (i32.const 7)) (then (global.set $mr_base (i32.const 3))))  ;; [BX]
        (if (i32.eq (local.get $rm) (i32.const 6))
          (then
            (if (i32.eqz (local.get $mod))
              (then (global.set $mr_disp (call $d_fetch16)))   ;; disp16, no base
              (else (global.set $mr_base (i32.const 5))        ;; [BP]
                    (global.set $mr_seg (i32.const 2))))))))

    (if (i32.eq (local.get $mod) (i32.const 1))
      (then (global.set $mr_disp (i32.add (global.get $mr_disp) (call $sign_ext8 (call $d_fetch8))))))
    (if (i32.eq (local.get $mod) (i32.const 2))
      (then (global.set $mr_disp (i32.add (global.get $mr_disp) (call $d_fetch16)))))

    (call $modrm16_apply_seg))

  ;; A segment override replaces the default outright. $d_seg uses the prefix
  ;; numbering (1=ES 2=CS 3=SS 4=DS), one more than the sreg one. Shared with
  ;; the moffs forms, which carry a segment for the same reason a ModRM does.
  (func $modrm16_apply_seg
    (if (global.get $d_seg)
      (then
        (if (i32.gt_u (global.get $d_seg) (i32.const 5))
          (then
            (call $host_log_i32 (i32.const 0xCA165E67)) ;; GS in a 16-bit task
            (call $host_log_i32 (global.get $d_seg))
            (unreachable)))
        (global.set $mr_seg (i32.sub (global.get $d_seg) (i32.const 1)))
        (global.set $d_seg (i32.const 0)))))

  ;; Apply segment override to mr_disp. Idempotent — clears $d_seg after
  ;; applying, so redundant calls from emitters are safe. Now invoked
  ;; centrally from $decode_modrm; emitter call sites act as a guard.
  ;; FS (5): add fs_base. GS (6): trap (no Win32 use of GS in this emu).
  ;; CS/SS/DS/ES (1-4): no base, treated as flat.
  (func $apply_seg_override
    (if (i32.eq (global.get $d_seg) (i32.const 5))
      (then
        (global.set $mr_disp (i32.add (global.get $mr_disp) (global.get $fs_base)))
        (global.set $d_seg (i32.const 0))
        (return)))
    (if (i32.eq (global.get $d_seg) (i32.const 6))
      (then
        (call $host_log_i32 (i32.const 0xCA5E9006)) ;; GS override unsupported
        (unreachable)))
    (global.set $d_seg (i32.const 0)))

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
  ;; If SIB (index set) or base-only [reg+disp]: emits compute_ea_sib handler and returns sentinel 0xEADEAD.
  ;; If absolute: returns mr_disp directly.
  ;; (callers that want a fast [reg+disp] opcode check $mr_simple_base before calling this.)
  ;; Pack the EA registers for the segmented compute handler: base | index<<4 |
  ;; seg<<8, with 0xF standing for "no register". Bit 11 distinguishes a
  ;; 32-bit address-size override in a 16-bit code segment: the selector base
  ;; still applies, but the offset must not wrap at 16 bits.
  (func $ea16_info (result i32)
    (i32.or
      (i32.or
        (i32.or
          (if (result i32) (i32.ne (global.get $mr_base) (i32.const -1))
            (then (global.get $mr_base)) (else (i32.const 0xF)))
          (i32.shl
            (if (result i32) (i32.ne (global.get $mr_index) (i32.const -1))
              (then (global.get $mr_index)) (else (i32.const 0xF)))
            (i32.const 4)))
        (i32.shl (global.get $mr_seg) (i32.const 8)))
      (if (result i32) (i32.eqz (global.get $d_addr16))
        (then (i32.const 0x800)) (else (i32.const 0)))))

  ;; Pack the EA registers for the 32-bit SIB handlers: base | index<<4 |
  ;; scale<<8, with 0xF standing for "no register" — the word handlers 149,
  ;; 389 and 400-402 all read. (The emitters that predate this helper still
  ;; spell it out inline; they build the identical word.)
  (func $sib_info_word (result i32)
    (i32.or
      (if (result i32) (i32.ne (global.get $mr_base) (i32.const -1))
        (then (global.get $mr_base)) (else (i32.const 0xF)))
      (i32.or (i32.shl (global.get $mr_index) (i32.const 4))
              (i32.shl (global.get $mr_scale) (i32.const 8)))))

  (func $emit_sib_or_abs (result i32)
    ;; A 16-bit task always resolves its address at runtime, even an absolute
    ;; one: `[0x1234]` still means DS:0x1234, and DS moves.
    (if (global.get $code16)
      (then
        (call $te (i32.const 363) (i32.const 0))
        (call $te_raw (call $ea16_info))
        (call $te_raw (global.get $mr_disp))
        (return (global.get $SIB_SENTINEL))))
    (if (i32.or (i32.ne (global.get $mr_index) (i32.const -1))
                (i32.ne (global.get $mr_base) (i32.const -1)))
      (then
        (call $te (i32.const 149) (i32.const 0))
        (call $te_raw (i32.or
          (if (result i32) (i32.ne (global.get $mr_base) (i32.const -1))
            (then (global.get $mr_base)) (else (i32.const 0xF)))
          (i32.or (i32.shl (global.get $mr_index) (i32.const 4))
                  (i32.shl (global.get $mr_scale) (i32.const 8)))))
        (call $te_raw (global.get $mr_disp))
        (return (global.get $SIB_SENTINEL))))
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
  ;; The [reg+disp] fast path emits handlers that add a register to a
  ;; displacement and call it an address. In a 16-bit task that is never the
  ;; address: the sum has to wrap inside the segment and then be added to the
  ;; segment base. Refusing the fast path here sends every memory operand in
  ;; every emitter through $emit_sib_or_abs, which is the one place that knows
  ;; how — rather than teaching each of the two dozen emitters separately.
  (func $mr_simple_base (result i32)
    (if (global.get $code16) (then (return (i32.const 0))))
    (i32.and (i32.ne (global.get $mr_base) (i32.const -1)) (i32.eq (global.get $mr_index) (i32.const -1))))
  ;; Helper: absolute address (no base, no index)?
  (func $mr_absolute (result i32)
    (i32.and (i32.eq (global.get $mr_base) (i32.const -1)) (i32.eq (global.get $mr_index) (i32.const -1))))

  ;; Emit one register-only byte MOV, folding the immediately following one
  ;; when it is another unprefixed 88/8A mod=11 instruction. The pair is fully
  ;; generic and flag-neutral; memory forms and prefixed instructions retain
  ;; their ordinary decoder paths.
  (func $emit_mov_r8_r8 (param $first i32)
    (local $look i32) (local $opcode i32) (local $modrm i32)
    (local $second i32) (local $reg i32) (local $rm i32)
    (local.set $look (call $gl16 (global.get $d_pc)))
    (local.set $opcode (i32.and (local.get $look) (i32.const 0xFF)))
    (local.set $modrm (i32.shr_u (local.get $look) (i32.const 8)))
    (if (i32.and
          (i32.or (i32.eq (local.get $opcode) (i32.const 0x88))
                  (i32.eq (local.get $opcode) (i32.const 0x8A)))
          (i32.eq (i32.and (local.get $modrm) (i32.const 0xC0)) (i32.const 0xC0)))
      (then
        (local.set $reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
        (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
        (local.set $second
          (if (result i32) (i32.eq (local.get $opcode) (i32.const 0x8A))
            (then (i32.or (i32.shl (local.get $reg) (i32.const 4)) (local.get $rm)))
            (else (i32.or (i32.shl (local.get $rm) (i32.const 4)) (local.get $reg)))))
        (call $te (i32.const 155)
          (i32.or (local.get $first)
            (i32.or (i32.const 0x100) (i32.shl (local.get $second) (i32.const 9)))))
        (global.set $d_pc (i32.add (global.get $d_pc) (i32.const 2)))
        (return)))
    (call $te (i32.const 155) (local.get $first)))

  ;; Match `mov rP,[abs] / inc rP / mov [abs],rP` and, when it is there, the
  ;; `mov rD8,[rP+disp8]` that reads the byte just stepped over -- the
  ;; post-increment fetch through a pointer variable that Heroes II's ICN
  ;; decoder is built out of. Emits handler 403 and returns 1 on a match; the
  ;; caller falls through to its ordinary encoding otherwise.
  ;;
  ;; The match is on raw bytes and unprefixed forms only, so an operand-size,
  ;; address-size or segment prefix anywhere in the group declines it. A
  ;; branch into the middle of the group is not a hazard: blocks are keyed by
  ;; EIP, so that target decodes as its own block with the ordinary handlers.
  (func $try_emit_ptrvar_fetch8 (param $dst i32) (result i32)
    (local $p i32) (local $abs i32) (local $b i32) (local $modrm i32) (local $op i32)
    (if (i32.or (global.get $code16) (global.get $d_addr16)) (then (return (i32.const 0))))
    (if (i32.eqz (call $mr_absolute)) (then (return (i32.const 0))))
    (local.set $abs (global.get $mr_disp))
    (local.set $p (global.get $d_pc))
    ;; inc rP
    (if (i32.ne (call $gl8 (local.get $p)) (i32.add (i32.const 0x40) (local.get $dst)))
      (then (return (i32.const 0))))
    (local.set $p (i32.add (local.get $p) (i32.const 1)))
    ;; mov [abs],rP -- A3 for EAX, else 89 with mod=00 rm=101.
    (local.set $b (call $gl8 (local.get $p)))
    (if (i32.and (i32.eq (local.get $b) (i32.const 0xA3)) (i32.eqz (local.get $dst)))
      (then
        (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 1))) (local.get $abs))
          (then (return (i32.const 0))))
        (local.set $p (i32.add (local.get $p) (i32.const 5))))
      (else
        (if (i32.ne (local.get $b) (i32.const 0x89)) (then (return (i32.const 0))))
        (if (i32.ne (call $gl8 (i32.add (local.get $p) (i32.const 1)))
              (i32.or (i32.const 0x05) (i32.shl (local.get $dst) (i32.const 3))))
          (then (return (i32.const 0))))
        (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 2))) (local.get $abs))
          (then (return (i32.const 0))))
        (local.set $p (i32.add (local.get $p) (i32.const 6)))))
    (local.set $op (local.get $dst))
    ;; Optional byte load through the freshly stored pointer. The compiler
    ;; drops a padding NOP in front of it often enough to be worth stepping
    ;; over -- and the NOP is only consumed if the byte load really follows.
    (block $no_tail
      (local.set $b (local.get $p))
      (if (i32.eq (call $gl8 (local.get $b)) (i32.const 0x90))
        (then (local.set $b (i32.add (local.get $b) (i32.const 1)))))
      (br_if $no_tail (i32.ne (call $gl8 (local.get $b)) (i32.const 0x8A)))
      (br_if $no_tail (i32.eq (local.get $dst) (i32.const 4)))  ;; rm=100 is a SIB, not ESP
      (local.set $modrm (call $gl8 (i32.add (local.get $b) (i32.const 1))))
      (br_if $no_tail (i32.ne (i32.and (local.get $modrm) (i32.const 0xC0)) (i32.const 0x40)))
      (br_if $no_tail (i32.ne (i32.and (local.get $modrm) (i32.const 7)) (local.get $dst)))
      (local.set $op (i32.or (local.get $op)
        (i32.or (i32.const 0x100)
          (i32.shl (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)) (i32.const 4)))))
      (call $te (i32.const 403) (local.get $op))
      (call $te_raw (local.get $abs))
      (call $te_raw (call $sign_ext8 (call $gl8 (i32.add (local.get $b) (i32.const 2)))))
      (global.set $d_pc (i32.add (local.get $b) (i32.const 3)))
      (return (i32.const 1)))
    (call $te (i32.const 403) (local.get $op))
    (call $te_raw (local.get $abs))
    (global.set $d_pc (local.get $p))
    (i32.const 1))

  ;; A register-register TEST whose next instruction is a Jcc: the branch is
  ;; the only thing that reads those flags, and the pair is the single largest
  ;; adjacent handler pair in Heroes II's blitter. Called with the ModRM of the
  ;; TEST already decoded (mod==3); emits handler 404 and returns 1 on a match,
  ;; consuming the Jcc, so the caller must end the block.
  (func $try_emit_test_jcc (param $byteform i32) (result i32)
    (local $b i32) (local $b2 i32) (local $cc i32) (local $disp i32)
    (if (global.get $code16) (then (return (i32.const 0))))
    (local.set $b (call $gl8 (global.get $d_pc)))
    (if (i32.and (i32.ge_u (local.get $b) (i32.const 0x70))
                 (i32.le_u (local.get $b) (i32.const 0x7F)))
      (then
        (local.set $cc (i32.and (local.get $b) (i32.const 0xF)))
        (local.set $disp
          (call $sign_ext8 (call $gl8 (i32.add (global.get $d_pc) (i32.const 1)))))
        (global.set $d_pc (i32.add (global.get $d_pc) (i32.const 2))))
      (else
        (local.set $b2 (call $gl8 (i32.add (global.get $d_pc) (i32.const 1))))
        (if (i32.and
              (i32.eq (local.get $b) (i32.const 0x0F))
              (i32.and (i32.ge_u (local.get $b2) (i32.const 0x80))
                       (i32.le_u (local.get $b2) (i32.const 0x8F))))
          (then
            (local.set $cc (i32.and (local.get $b2) (i32.const 0xF)))
            (local.set $disp (call $gl32 (i32.add (global.get $d_pc) (i32.const 2))))
            (global.set $d_pc (i32.add (global.get $d_pc) (i32.const 6))))
          (else (return (i32.const 0))))))
    (call $te (i32.const 404)
      (i32.or
        (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))
        (i32.or (i32.shl (local.get $cc) (i32.const 8))
                (i32.shl (local.get $byteform) (i32.const 12)))))
    (call $te_raw (global.get $d_pc))
    (call $te_raw (call $branch_target (local.get $disp)))
    (i32.const 1))

  ;; Called immediately after decoding DF E0 (FNSTSW AX). Recognize the exact
  ;; MSVC x87 condition tail `F6 C4 imm8; Jcc`, consume it, and replace all
  ;; three instructions with handler 439. Other TEST forms remain ordinary x86
  ;; so the fold cannot capture code which observes AX between the operations.
  (func $try_emit_fnstsw_test_ah_jcc (result i32)
    (local $p i32) (local $b i32) (local $b2 i32)
    (local $imm i32) (local $cc i32) (local $disp i32)
    (if (global.get $code16) (then (return (i32.const 0))))
    (local.set $p (global.get $d_pc))
    (if (i32.ne (call $gl8 (local.get $p)) (i32.const 0xF6))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl8 (i32.add (local.get $p) (i32.const 1))) (i32.const 0xC4))
      (then (return (i32.const 0))))
    (local.set $imm (call $gl8 (i32.add (local.get $p) (i32.const 2))))
    (local.set $p (i32.add (local.get $p) (i32.const 3)))
    (local.set $b (call $gl8 (local.get $p)))
    (if (i32.and
          (i32.ge_u (local.get $b) (i32.const 0x70))
          (i32.le_u (local.get $b) (i32.const 0x7F)))
      (then
        (local.set $cc (i32.and (local.get $b) (i32.const 0xF)))
        (local.set $disp
          (call $sign_ext8 (call $gl8 (i32.add (local.get $p) (i32.const 1)))))
        (local.set $p (i32.add (local.get $p) (i32.const 2))))
      (else
        (local.set $b2 (call $gl8 (i32.add (local.get $p) (i32.const 1))))
        (if (i32.and
              (i32.eq (local.get $b) (i32.const 0x0F))
              (i32.and
                (i32.ge_u (local.get $b2) (i32.const 0x80))
                (i32.le_u (local.get $b2) (i32.const 0x8F))))
          (then
            (local.set $cc (i32.and (local.get $b2) (i32.const 0xF)))
            (local.set $disp (call $gl32 (i32.add (local.get $p) (i32.const 2))))
            (local.set $p (i32.add (local.get $p) (i32.const 6))))
          (else (return (i32.const 0))))))
    (global.set $d_pc (local.get $p))
    (call $te (i32.const 439)
      (i32.or (local.get $imm) (i32.shl (local.get $cc) (i32.const 8))))
    (call $te_raw (global.get $d_pc))
    (call $te_raw (call $branch_target (local.get $disp)))
    (i32.const 1))

  ;; `OP dword [base+disp], imm32` whose next instruction is the Jcc reading
  ;; its flags — the compare-a-local-and-branch shape, and the largest adjacent
  ;; handler pair left in the Heroes II gameplay histogram. Called after the
  ;; ModRM and the immediate of the ALU instruction have been consumed; emits
  ;; handler 407 and returns 1 on a match, having eaten the Jcc, so the caller
  ;; must end the block. Only the fast [base+disp] form is folded: the SIB and
  ;; absolute forms go through $emit_sib_or_abs and keep handler 51.
  (func $try_emit_alu_m32_i_jcc (param $alu_op i32) (param $imm i32) (result i32)
    (local $b i32) (local $b2 i32) (local $cc i32) (local $disp i32)
    (if (i32.or (global.get $code16) (global.get $d_addr16)) (then (return (i32.const 0))))
    (if (i32.eqz (call $mr_simple_base)) (then (return (i32.const 0))))
    (local.set $b (call $gl8 (global.get $d_pc)))
    (if (i32.and (i32.ge_u (local.get $b) (i32.const 0x70))
                 (i32.le_u (local.get $b) (i32.const 0x7F)))
      (then
        (local.set $cc (i32.and (local.get $b) (i32.const 0xF)))
        (local.set $disp
          (call $sign_ext8 (call $gl8 (i32.add (global.get $d_pc) (i32.const 1)))))
        (global.set $d_pc (i32.add (global.get $d_pc) (i32.const 2))))
      (else
        (local.set $b2 (call $gl8 (i32.add (global.get $d_pc) (i32.const 1))))
        (if (i32.and
              (i32.eq (local.get $b) (i32.const 0x0F))
              (i32.and (i32.ge_u (local.get $b2) (i32.const 0x80))
                       (i32.le_u (local.get $b2) (i32.const 0x8F))))
          (then
            (local.set $cc (i32.and (local.get $b2) (i32.const 0xF)))
            (local.set $disp (call $gl32 (i32.add (global.get $d_pc) (i32.const 2))))
            (global.set $d_pc (i32.add (global.get $d_pc) (i32.const 6))))
          (else (return (i32.const 0))))))
    (call $te (i32.const 407)
      (i32.or
        (i32.or (i32.shl (local.get $alu_op) (i32.const 8)) (global.get $mr_base))
        (i32.shl (local.get $cc) (i32.const 12))))
    (call $te_raw (global.get $mr_disp))
    (call $te_raw (local.get $imm))
    (call $te_raw (global.get $d_pc))
    (call $te_raw (call $branch_target (local.get $disp)))
    (i32.const 1))

  ;; One `mov reg,[abs32]` / `mov [abs32],reg` at $p, in its two encodings:
  ;; the EAX short forms (A1/A3, five bytes) and the ModRM forms with mod=00
  ;; rm=101 (8B/89, six bytes). Returns (length<<4)|reg, or 0 when the bytes are
  ;; anything else — a prefix byte in front declines by construction, which is
  ;; what keeps operand-size, address-size and segment forms out of the run.
  (func $abs_mov_at (param $p i32) (param $store i32) (result i32)
    (local $b i32) (local $modrm i32)
    (local.set $b (call $gl8 (local.get $p)))
    (if (i32.eq (local.get $b)
          (if (result i32) (local.get $store) (then (i32.const 0xA3)) (else (i32.const 0xA1))))
      (then (return (i32.const 0x50))))  ;; five bytes, EAX
    (if (i32.ne (local.get $b)
          (if (result i32) (local.get $store) (then (i32.const 0x89)) (else (i32.const 0x8B))))
      (then (return (i32.const 0))))
    (local.set $modrm (call $gl8 (i32.add (local.get $p) (i32.const 1))))
    (if (i32.ne (i32.and (local.get $modrm) (i32.const 0xC7)) (i32.const 0x05))
      (then (return (i32.const 0))))
    (i32.or (i32.const 0x60) (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7))))

  ;; Fold a run of up to four absolute MOVs of the same direction into handler
  ;; 405/406. Called with the first one already decoded (its address, already
  ;; segment-adjusted, in $addr0); returns 1 once at least one more followed.
  (func $try_emit_abs_run (param $store i32) (param $reg0 i32) (param $addr0 i32) (result i32)
    (local $p i32) (local $n i32) (local $i i32) (local $m i32) (local $len i32) (local $op i32)
    (if (i32.or (global.get $code16) (global.get $d_addr16)) (then (return (i32.const 0))))
    ;; how many follow
    (local.set $p (global.get $d_pc))
    (local.set $n (i32.const 1))
    (block $stop (loop $l
      (br_if $stop (i32.ge_u (local.get $n) (i32.const 4)))
      (local.set $m (call $abs_mov_at (local.get $p) (local.get $store)))
      (br_if $stop (i32.eqz (local.get $m)))
      (local.set $p (i32.add (local.get $p) (i32.shr_u (local.get $m) (i32.const 4))))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br $l)))
    (if (i32.lt_u (local.get $n) (i32.const 2)) (then (return (i32.const 0))))
    ;; the op word needs every register before the first word can be written
    (local.set $op (i32.or (local.get $n) (i32.shl (local.get $reg0) (i32.const 4))))
    (local.set $p (global.get $d_pc))
    (local.set $i (i32.const 1))
    (block $d2 (loop $l2
      (br_if $d2 (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $m (call $abs_mov_at (local.get $p) (local.get $store)))
      (local.set $op (i32.or (local.get $op)
        (i32.shl (i32.and (local.get $m) (i32.const 0xF))
                 (i32.add (i32.const 4) (i32.shl (local.get $i) (i32.const 2))))))
      (local.set $p (i32.add (local.get $p) (i32.shr_u (local.get $m) (i32.const 4))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2)))
    (call $te
      (if (result i32) (local.get $store) (then (i32.const 405)) (else (i32.const 406)))
      (local.get $op))
    (call $te_raw (local.get $addr0))
    (local.set $p (global.get $d_pc))
    (local.set $i (i32.const 1))
    (block $d3 (loop $l3
      (br_if $d3 (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $m (call $abs_mov_at (local.get $p) (local.get $store)))
      (local.set $len (i32.shr_u (local.get $m) (i32.const 4)))
      (call $te_raw
        (call $gl32 (i32.add (local.get $p) (i32.sub (local.get $len) (i32.const 4)))))
      (local.set $p (i32.add (local.get $p) (local.get $len)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l3)))
    (global.set $d_pc (local.get $p))
    (i32.const 1))

  ;; One unprefixed `mov r32,[base+disp]` at $p over the given base register,
  ;; in its three flat encodings: mod=00 (no displacement), mod=01 (disp8) and
  ;; mod=10 (disp32). ESP's mandatory SIB is admitted only in its canonical
  ;; 0x24 form (scale 1, no index, base ESP), so `[esp+index]` cannot be
  ;; mistaken for the base-only shape handler 408 executes. Returns
  ;; (length<<4)|reg, or 0 for anything else — a prefix byte in front declines
  ;; by construction, which keeps operand-size, address-size and segment forms
  ;; out of the run.
  (func $base_mov_at (param $p i32) (param $base i32) (result i32)
    (local $modrm i32) (local $mod i32) (local $sib i32)
    (if (i32.ne (call $gl8 (local.get $p)) (i32.const 0x8B))
      (then (return (i32.const 0))))
    (local.set $modrm (call $gl8 (i32.add (local.get $p) (i32.const 1))))
    (if (i32.ne (i32.and (local.get $modrm) (i32.const 7)) (local.get $base))
      (then (return (i32.const 0))))
    (local.set $mod (i32.shr_u (local.get $modrm) (i32.const 6)))
    (if (i32.eq (local.get $mod) (i32.const 3)) (then (return (i32.const 0))))
    ;; ESP is encoded through a SIB even without an index. Accept precisely
    ;; that no-index spelling; every other SIB remains outside this matcher.
    (if (i32.eq (local.get $base) (i32.const 4))
      (then
        (local.set $sib (call $gl8 (i32.add (local.get $p) (i32.const 2))))
        (if (i32.ne (local.get $sib) (i32.const 0x24))
          (then (return (i32.const 0))))))
    (if (i32.and (i32.eqz (local.get $mod)) (i32.eq (local.get $base) (i32.const 5)))
      (then (return (i32.const 0))))
    (i32.or
      (i32.shl
        (if (result i32) (i32.eqz (local.get $mod))
          (then (select (i32.const 3) (i32.const 2)
                        (i32.eq (local.get $base) (i32.const 4))))
          (else (if (result i32) (i32.eq (local.get $mod) (i32.const 1))
                  (then (select (i32.const 4) (i32.const 3)
                                (i32.eq (local.get $base) (i32.const 4))))
                  (else (select (i32.const 7) (i32.const 6)
                                (i32.eq (local.get $base) (i32.const 4)))))))
        (i32.const 4))
      (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7))))

  ;; The displacement of the instruction $base_mov_at just matched, sign
  ;; extended for the disp8 form and zero for the no-displacement form. ESP's
  ;; displacement begins one byte later because of its mandatory SIB.
  (func $base_mov_disp (param $p i32) (param $len i32) (result i32)
    (if (i32.eq (i32.and (call $gl8 (i32.add (local.get $p) (i32.const 1)))
                         (i32.const 7))
                (i32.const 4))
      (then
        (if (i32.eq (local.get $len) (i32.const 3)) (then (return (i32.const 0))))
        (if (i32.eq (local.get $len) (i32.const 4))
          (then (return (call $sign_ext8
            (call $gl8 (i32.add (local.get $p) (i32.const 3)))))))
        (return (call $gl32 (i32.add (local.get $p) (i32.const 3))))))
    (if (i32.eq (local.get $len) (i32.const 2)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $len) (i32.const 3))
      (then (return (call $sign_ext8 (call $gl8 (i32.add (local.get $p) (i32.const 2)))))))
    (call $gl32 (i32.add (local.get $p) (i32.const 2))))

  ;; Fold a run of up to four `mov r32,[base+disp]` over one base register into
  ;; handler 408. Called with the first one already decoded (its destination in
  ;; $dst, its already-segment-adjusted displacement in $disp0); returns 1 once
  ;; at least one more followed.
  ;;
  ;; The aliasing hazard the absolute-address run does not have: once an
  ;; element writes the base register itself, every later address changes. Such
  ;; an element is admitted as the LAST one — the handler reads the base once
  ;; before the first load — and the run ends there.
  (func $try_emit_base_run (param $dst i32) (param $disp0 i32) (result i32)
    (local $base i32) (local $p i32) (local $n i32) (local $i i32)
    (local $m i32) (local $len i32) (local $op i32)
    (if (i32.or (global.get $code16) (global.get $d_addr16)) (then (return (i32.const 0))))
    (local.set $base (global.get $mr_base))
    ;; the first element already clobbers the base: nothing after it can join
    (if (i32.eq (local.get $dst) (local.get $base)) (then (return (i32.const 0))))
    ;; how many follow
    (local.set $p (global.get $d_pc))
    (local.set $n (i32.const 1))
    (block $stop (loop $l
      (br_if $stop (i32.ge_u (local.get $n) (i32.const 4)))
      (local.set $m (call $base_mov_at (local.get $p) (local.get $base)))
      (br_if $stop (i32.eqz (local.get $m)))
      (local.set $p (i32.add (local.get $p) (i32.shr_u (local.get $m) (i32.const 4))))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      ;; an element that writes the base ends the run after itself
      (br_if $stop (i32.eq (i32.and (local.get $m) (i32.const 0xF)) (local.get $base)))
      (br $l)))
    (if (i32.lt_u (local.get $n) (i32.const 2)) (then (return (i32.const 0))))
    ;; the op word needs every register before the first word can be written
    (local.set $op (i32.or
      (i32.or (local.get $n) (i32.shl (local.get $base) (i32.const 4)))
      (i32.shl (local.get $dst) (i32.const 8))))
    (local.set $p (global.get $d_pc))
    (local.set $i (i32.const 1))
    (block $d2 (loop $l2
      (br_if $d2 (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $m (call $base_mov_at (local.get $p) (local.get $base)))
      (local.set $op (i32.or (local.get $op)
        (i32.shl (i32.and (local.get $m) (i32.const 0xF))
                 (i32.add (i32.const 8) (i32.shl (local.get $i) (i32.const 2))))))
      (local.set $p (i32.add (local.get $p) (i32.shr_u (local.get $m) (i32.const 4))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2)))
    (call $te (i32.const 408) (local.get $op))
    (call $te_raw (local.get $disp0))
    (local.set $p (global.get $d_pc))
    (local.set $i (i32.const 1))
    (block $d3 (loop $l3
      (br_if $d3 (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $m (call $base_mov_at (local.get $p) (local.get $base)))
      (local.set $len (i32.shr_u (local.get $m) (i32.const 4)))
      (call $te_raw (call $base_mov_disp (local.get $p) (local.get $len)))
      (local.set $p (i32.add (local.get $p) (local.get $len)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l3)))
    (global.set $d_pc (local.get $p))
    (i32.const 1))

  ;; One unprefixed `mov [base+index*scale+disp], r32` at $p storing the given
  ;; register: 89 /r with rm=4 (a SIB byte) and mod != 3. Returns the encoded
  ;; length in the high bits and 1 in the low bit, or 0 for anything else -- a
  ;; prefix byte in front declines by construction, which keeps operand-size,
  ;; address-size and segment forms out of the fusion. The info word and the
  ;; displacement land in $fuse_info / $fuse_disp rather than in the result,
  ;; because a matcher that returned them would need three return values.
  ;;
  ;; Declines the absolute form (no base and no index) for the same reason
  ;; $emit_store32 does: handler 420's operand encoding is the indexed one.
  (func $sib_store_at (param $p i32) (param $reg i32) (result i32)
    (local $modrm i32) (local $mod i32) (local $sib i32)
    (local $base i32) (local $index i32) (local $nobase i32)
    (if (i32.ne (call $gl8 (local.get $p)) (i32.const 0x89))
      (then (return (i32.const 0))))
    (local.set $modrm (call $gl8 (i32.add (local.get $p) (i32.const 1))))
    (if (i32.ne (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7))
                (local.get $reg))
      (then (return (i32.const 0))))
    (if (i32.ne (i32.and (local.get $modrm) (i32.const 7)) (i32.const 4))
      (then (return (i32.const 0))))
    (local.set $mod (i32.shr_u (local.get $modrm) (i32.const 6)))
    (if (i32.eq (local.get $mod) (i32.const 3)) (then (return (i32.const 0))))
    (local.set $sib (call $gl8 (i32.add (local.get $p) (i32.const 2))))
    (local.set $base (i32.and (local.get $sib) (i32.const 7)))
    (local.set $index (i32.and (i32.shr_u (local.get $sib) (i32.const 3)) (i32.const 7)))
    ;; index=4 means "no index"; base=5 with mod=00 means "no base, disp32"
    (if (i32.eq (local.get $index) (i32.const 4))
      (then (local.set $index (i32.const 0xF))))
    (local.set $nobase (i32.and (i32.eqz (local.get $mod))
                                (i32.eq (local.get $base) (i32.const 5))))
    (if (i32.and (local.get $nobase) (i32.eq (local.get $index) (i32.const 0xF)))
      (then (return (i32.const 0))))
    (if (local.get $nobase) (then (local.set $base (i32.const 0xF))))
    (global.set $fuse_info (i32.or (local.get $base)
      (i32.or (i32.shl (local.get $index) (i32.const 4))
              (i32.shl (i32.and (i32.shr_u (local.get $sib) (i32.const 6)) (i32.const 3))
                       (i32.const 8)))))
    (if (i32.eq (local.get $mod) (i32.const 1))
      (then
        (global.set $fuse_disp
          (call $sign_ext8 (call $gl8 (i32.add (local.get $p) (i32.const 3)))))
        (return (i32.const 0x41))))
    (if (i32.or (i32.eq (local.get $mod) (i32.const 2)) (local.get $nobase))
      (then
        (global.set $fuse_disp (call $gl32 (i32.add (local.get $p) (i32.const 3))))
        (return (i32.const 0x71))))
    (global.set $fuse_disp (i32.const 0))
    (i32.const 0x31))

  ;; Fold `mov r32,[base+disp]` and the `mov [base+index*scale+disp],r32` that
  ;; immediately follows it into handler 421. Called with the load already
  ;; decoded (its base in $mr_base, its segment-adjusted displacement in
  ;; $disp0); returns 1 once the store matched.
  (func $try_emit_copy_sib (param $dst i32) (param $disp0 i32) (result i32)
    (local $m i32)
    (if (i32.eqz (global.get $sib_fusion_enabled)) (then (return (i32.const 0))))
    (if (i32.or (global.get $code16) (global.get $d_addr16))
      (then (return (i32.const 0))))
    (if (global.get $d_seg) (then (return (i32.const 0))))
    (local.set $m (call $sib_store_at (global.get $d_pc) (local.get $dst)))
    (if (i32.eqz (local.get $m)) (then (return (i32.const 0))))
    (call $te (i32.const 421)
      (i32.or (global.get $mr_base) (i32.shl (local.get $dst) (i32.const 4))))
    (call $te_raw (local.get $disp0))
    (call $te_raw (global.get $fuse_info))
    (call $te_raw (global.get $fuse_disp))
    (global.set $d_pc (i32.add (global.get $d_pc) (i32.shr_u (local.get $m) (i32.const 4))))
    (i32.const 1))

  ;; Walk a sprite run starting at $p0 -- the byte just after row 0's first
  ;; store -- and either measure it ($emit=0) or write out its per-row
  ;; (cols, dst_disp) words ($emit=1). Returns the row count, and leaves the
  ;; end position in $sr_end, the total dword count in $sr_pairs and the
  ;; row-step register in $sr_step.
  ;;
  ;; The grammar is one straight line of
  ;;   mov scratch, [src_base + srcd]
  ;;   mov [dst_base + idx*scale + dstd], scratch
  ;; pairs with an `add idx, step` between rows. Source displacements run
  ;; contiguously across the whole run; each row's destination displacements
  ;; restart at whatever that row's first store says, which is what lets the
  ;; rows have different widths -- Caesar's sprites are diamonds, 1, 3, 5, 7
  ;; dwords wide, not rectangles.
  ;;
  ;; Every displacement is *predicted* and then compared against the literal
  ;; encoding, never deduced from it. That is the whole reason this fold does
  ;; not need COPY_RUN's caution: a run it accepts is one the instruction
  ;; stream spelled out.
  (func $sprite_scan (param $p0 i32) (param $src_base i32) (param $scratch i32)
                     (param $info i32) (param $dstd0 i32) (param $disp0 i32)
                     (param $idx i32) (param $dbase i32) (param $emit i32)
                     (result i32)
    (local $p i32) (local $q i32) (local $m i32) (local $len i32)
    (local $cols i32) (local $pairs i32) (local $nrows i32)
    (local $rowdst i32) (local $srcnext i32) (local $sep i32) (local $step i32)
    (local $b i32)
    (local.set $p (local.get $p0))
    (local.set $cols (i32.const 1))
    (local.set $pairs (i32.const 1))
    (local.set $nrows (i32.const 0))
    (local.set $rowdst (local.get $dstd0))
    (local.set $srcnext (i32.add (local.get $disp0) (i32.const 4)))
    (local.set $sep (i32.const -1))
    (block $done (loop $rl
      ;; extend the row we are in
      (block $cdone (loop $cl
        (br_if $cdone (i32.ge_u (local.get $pairs) (i32.const 65536)))
        (local.set $m (call $base_mov_at (local.get $p) (local.get $src_base)))
        (br_if $cdone (i32.eqz (local.get $m)))
        (br_if $cdone (i32.ne (i32.and (local.get $m) (i32.const 0xF))
                              (local.get $scratch)))
        (local.set $len (i32.shr_u (local.get $m) (i32.const 4)))
        (br_if $cdone (i32.ne (call $base_mov_disp (local.get $p) (local.get $len))
                              (local.get $srcnext)))
        (local.set $q (i32.add (local.get $p) (local.get $len)))
        (local.set $m (call $sib_store_at (local.get $q) (local.get $scratch)))
        (br_if $cdone (i32.eqz (local.get $m)))
        (br_if $cdone (i32.ne (global.get $fuse_info) (local.get $info)))
        (br_if $cdone (i32.ne (global.get $fuse_disp)
          (i32.add (local.get $rowdst) (i32.shl (local.get $cols) (i32.const 2)))))
        (local.set $p (i32.add (local.get $q) (i32.shr_u (local.get $m) (i32.const 4))))
        (local.set $cols (i32.add (local.get $cols) (i32.const 1)))
        (local.set $pairs (i32.add (local.get $pairs) (i32.const 1)))
        (local.set $srcnext (i32.add (local.get $srcnext) (i32.const 4)))
        (br $cl)))
      (if (local.get $emit)
        (then (call $te_raw (local.get $cols))
              (call $te_raw (local.get $rowdst))))
      (local.set $nrows (i32.add (local.get $nrows) (i32.const 1)))
      ;; The descriptor has to fit the headroom $decode_block reserves.
      (br_if $done (i32.ge_u (local.get $nrows) (i32.const 512)))

      ;; the row step -- register form, writing the index register, and
      ;; byte-identical at every row boundary
      (br_if $done (i32.ne (call $gl8 (local.get $p)) (i32.const 0x03)))
      (local.set $b (call $gl8 (i32.add (local.get $p) (i32.const 1))))
      (if (i32.eq (local.get $sep) (i32.const -1))
        (then
          (br_if $done (i32.ne (i32.shr_u (local.get $b) (i32.const 6)) (i32.const 3)))
          (br_if $done (i32.ne
            (i32.and (i32.shr_u (local.get $b) (i32.const 3)) (i32.const 7))
            (local.get $idx)))
          (local.set $step (i32.and (local.get $b) (i32.const 7)))
          ;; The handler reads the step once, up front, like every other
          ;; register here -- so nothing the run writes may be one of them,
          ;; and stepping the index by itself is not the arithmetic it does.
          (br_if $done (i32.or (i32.eq (local.get $step) (local.get $idx))
                       (i32.or (i32.eq (local.get $step) (local.get $scratch))
                       (i32.or (i32.eq (local.get $step) (local.get $src_base))
                               (i32.eq (local.get $step) (local.get $dbase))))))
          (local.set $sep (local.get $b)))
        (else (br_if $done (i32.ne (local.get $b) (local.get $sep)))))

      ;; A separator only opens a new row if a whole pair follows it; an `add`
      ;; that ends the sprite stays outside the fold.
      (local.set $m (call $base_mov_at (i32.add (local.get $p) (i32.const 2))
        (local.get $src_base)))
      (br_if $done (i32.eqz (local.get $m)))
      (br_if $done (i32.ne (i32.and (local.get $m) (i32.const 0xF))
                           (local.get $scratch)))
      (local.set $len (i32.shr_u (local.get $m) (i32.const 4)))
      (br_if $done (i32.ne
        (call $base_mov_disp (i32.add (local.get $p) (i32.const 2)) (local.get $len))
        (local.get $srcnext)))
      (local.set $q (i32.add (i32.add (local.get $p) (i32.const 2)) (local.get $len)))
      (local.set $m (call $sib_store_at (local.get $q) (local.get $scratch)))
      (br_if $done (i32.eqz (local.get $m)))
      (br_if $done (i32.ne (global.get $fuse_info) (local.get $info)))
      (local.set $rowdst (global.get $fuse_disp))
      (local.set $p (i32.add (local.get $q) (i32.shr_u (local.get $m) (i32.const 4))))
      (local.set $cols (i32.const 1))
      (local.set $pairs (i32.add (local.get $pairs) (i32.const 1)))
      (local.set $srcnext (i32.add (local.get $srcnext) (i32.const 4)))
      (br $rl)))
    (global.set $sr_end (local.get $p))
    (global.set $sr_pairs (local.get $pairs))
    (global.set $sr_step (local.get $step))
    (local.get $nrows))

  ;; Fold a fully unrolled sprite blit into $th_rect_run. Called with the
  ;; first load already decoded, exactly like $try_emit_copy_sib, and tried
  ;; before it: when this declines, that one still folds the leading pair, so a
  ;; near-miss costs nothing but the scan.
  (func $try_emit_rect_run (param $scratch i32) (param $disp0 i32) (result i32)
    (local $src_base i32) (local $p i32) (local $q i32) (local $m i32)
    (local $len i32) (local $info i32) (local $dbase i32) (local $idx i32)
    (local $dstd i32) (local $cols i32) (local $rows i32) (local $step i32)
    (local $sep i32) (local $stride i32) (local $n i32)
    (if (i32.eqz (global.get $rect_run_enabled)) (then (return (i32.const 0))))
    (if (i32.eqz (global.get $sib_fusion_enabled)) (then (return (i32.const 0))))
    (if (i32.or (global.get $code16) (global.get $d_addr16))
      (then (return (i32.const 0))))
    (if (global.get $d_seg) (then (return (i32.const 0))))
    (local.set $src_base (global.get $mr_base))
    (if (i32.eq (local.get $src_base) (i32.const 4)) (then (return (i32.const 0))))

    ;; The first pair's store fixes the destination form every later store has
    ;; to repeat.
    (local.set $p (global.get $d_pc))
    (local.set $m (call $sib_store_at (local.get $p) (local.get $scratch)))
    (if (i32.eqz (local.get $m)) (then (return (i32.const 0))))
    (local.set $info (global.get $fuse_info))
    (local.set $dstd (global.get $fuse_disp))
    (local.set $dbase (i32.and (local.get $info) (i32.const 0xF)))
    (local.set $idx (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF)))
    ;; A rectangle needs both a row cursor and a base to hang it off.
    (if (i32.or (i32.eq (local.get $dbase) (i32.const 0xF))
                (i32.eq (local.get $idx) (i32.const 0xF)))
      (then (return (i32.const 0))))
    ;; The handler reads all four address registers once, up front. That is
    ;; only equivalent to the unrolled instructions if none of the copy's own
    ;; writes can reach them -- so the scratch register must not be one.
    (if (i32.or (i32.eq (local.get $scratch) (local.get $src_base))
        (i32.or (i32.eq (local.get $scratch) (local.get $dbase))
                (i32.eq (local.get $scratch) (local.get $idx))))
      (then (return (i32.const 0))))
    (local.set $p (i32.add (local.get $p) (i32.shr_u (local.get $m) (i32.const 4))))

    ;; Pass one measures the run, pass two writes it out. Two passes because
    ;; the descriptor's length is the thing being measured -- the same reason
    ;; $try_emit_base_run counts its MOVs before it emits any of them.
    (local.set $rows (call $sprite_scan (local.get $p) (local.get $src_base)
      (local.get $scratch) (local.get $info) (local.get $dstd) (local.get $disp0)
      (local.get $idx) (local.get $dbase) (i32.const 0)))
    ;; One row is not a run, and a handful of dwords does not repay a
    ;; variable-length descriptor -- 421 already has those at one dispatch a
    ;; pair, and it costs four words instead of 2*rows + 4.
    (if (i32.lt_u (local.get $rows) (i32.const 2)) (then (return (i32.const 0))))
    (if (i32.lt_u (global.get $sr_pairs) (i32.const 8)) (then (return (i32.const 0))))
    (local.set $step (global.get $sr_step))
    (local.set $cols (global.get $sr_pairs))

    (call $te (i32.const 427) (i32.or
      (i32.or (local.get $src_base) (i32.shl (local.get $scratch) (i32.const 4)))
      (i32.or
        (i32.or (i32.shl (local.get $dbase) (i32.const 8))
                (i32.shl (local.get $idx) (i32.const 12)))
        (i32.or (i32.shl (local.get $step) (i32.const 16))
                (i32.shl (i32.and (i32.shr_u (local.get $info) (i32.const 8)) (i32.const 3))
                         (i32.const 20))))))
    (call $te_raw (local.get $rows))
    (call $te_raw (local.get $disp0))
    (call $te_raw (local.get $cols))
    ;; What the unrolled form billed: three steps a copied dword (load, EA,
    ;; store) and one for each `add` between rows.
    (call $te_raw (i32.add (i32.mul (local.get $cols) (i32.const 3))
      (i32.sub (local.get $rows) (i32.const 1))))
    (drop (call $sprite_scan (local.get $p) (local.get $src_base)
      (local.get $scratch) (local.get $info) (local.get $dstd) (local.get $disp0)
      (local.get $idx) (local.get $dbase) (i32.const 1)))
    (global.set $d_pc (global.get $sr_end))
    (i32.const 1))

  ;; $fuse says whether the bytes after $d_pc are the next instruction. They
  ;; are for `mov r32,r/m32`, and every fusion below peeks at them; they are
  ;; NOT for `imul r32,r/m32,imm`, whose immediate the decoder has already
  ;; consumed, so folding there would hoist a later instruction in front of
  ;; the IMUL that is about to be emitted.
  (func $emit_load32 (param $dst i32) (param $fuse i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then
        ;; Smacker's Huffman builder repeatedly emits exactly
        ;;   mov eax,[edx+disp] / test eax,imm32
        ;; Fuse the flag-neutral load with its TEST. Keep the match exact and
        ;; flat/unprefixed so segmented and address-size forms retain their
        ;; ordinary decoder paths.
        (if (i32.and
              (i32.and
                (i32.ne (local.get $fuse) (i32.const 0))
                (i32.and
                  (i32.eqz (global.get $code16))
                  (i32.eqz (global.get $d_addr16))))
              (i32.and
                (i32.eqz (global.get $d_seg))
                (i32.and
                  (i32.eq (local.get $dst) (i32.const 0))
                  (i32.and
                    (i32.eq (global.get $mr_base) (i32.const 2))
                    (i32.eq (call $gl8 (global.get $d_pc)) (i32.const 0xA9))))))
          (then
            (call $te (i32.const 391) (i32.const 0))
            (call $te_raw (global.get $mr_disp))
            (call $te_raw (call $gl32 (i32.add (global.get $d_pc) (i32.const 1))))
            (global.set $d_pc (i32.add (global.get $d_pc) (i32.const 5)))
            (return)))
        (if (local.get $fuse)
          (then
            ;; The copied dword: this load and the indexed store of the same
            ;; register that follows it. Tried before the load run, because a
            ;; run of loads is not what this code is -- Caesar's unrolled copy
            ;; cases alternate load/store and $try_emit_base_run declines them
            ;; anyway (the byte after the load is 0x89, not another 0x8B).
            ;; The whole unrolled rectangle first, the single pair second: a
            ;; rectangle that folds is 128 pairs Caesar's tile blit no longer
            ;; dispatches one at a time, and a rectangle that declines leaves
            ;; the pair fold to pick up its first pair unchanged.
            (if (call $try_emit_rect_run (local.get $dst) (global.get $mr_disp))
              (then (return)))
            (if (call $try_emit_copy_sib (local.get $dst) (global.get $mr_disp))
              (then (return)))
            (if (call $try_emit_base_run (local.get $dst) (global.get $mr_disp))
              (then (return)))))
        (call $te (i32.add (i32.const 339) (global.get $mr_base)) (local.get $dst))
        (call $te_raw (global.get $mr_disp))
        (return)))
    ;; Indexed SIB loads dominate generated Smacker conversion loops. Encode
    ;; the load in compute_ea_sib so the hot path needs one threaded dispatch
    ;; and no SIB_SENTINEL word. Absolute and segmented forms stay unchanged.
    (if (i32.and
          (i32.eqz (global.get $code16))
          (i32.eqz (call $mr_absolute)))
      (then
        (call $te (i32.const 389) (local.get $dst))
        (call $te_raw (i32.or
          (if (result i32) (i32.ne (global.get $mr_base) (i32.const -1))
            (then (global.get $mr_base)) (else (i32.const 0xF)))
          (i32.or (i32.shl (global.get $mr_index) (i32.const 4))
                  (i32.shl (global.get $mr_scale) (i32.const 8)))))
        (call $te_raw (global.get $mr_disp))
        (return)))
    (if (local.get $fuse)
      (then
        (if (call $try_emit_ptrvar_fetch8 (local.get $dst)) (then (return)))
        (if (call $mr_absolute)
          (then
            (local.set $a (global.get $mr_disp))
            (if (call $try_emit_abs_run (i32.const 0) (local.get $dst) (local.get $a))
              (then (return)))))))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 20) (local.get $dst)) (call $te_raw (local.get $a)))

  (func $emit_store32 (param $src i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.add (i32.const 347) (global.get $mr_base)) (local.get $src))
            (call $te_raw (global.get $mr_disp)) (return)))
    (if (call $mr_absolute)
      (then
        (local.set $a (global.get $mr_disp))
        (if (call $try_emit_abs_run (i32.const 1) (local.get $src) (local.get $a))
          (then (return)))))
    ;; Indexed SIB dword stores dominate Caesar III's RLE sprite decoder the
    ;; way indexed loads dominate StarCraft's Smacker converter: 96.66% of the
    ;; SIB EAs its city view computes are consumed by exactly this. Fuse the
    ;; compute_ea_sib + store32(SIB_SENTINEL) pair into handler 420, which
    ;; keeps the 149 operand encoding. Absolute and segmented forms are
    ;; unchanged and still go through $emit_sib_or_abs below.
    (if (i32.and
          (global.get $sib_fusion_enabled)
          (i32.and
            (i32.eqz (global.get $code16))
            (i32.eqz (call $mr_absolute))))
      (then
        (call $te (i32.const 420) (local.get $src))
        (call $te_raw (call $sib_info_word))
        (call $te_raw (global.get $mr_disp))
        (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 21) (local.get $src)) (call $te_raw (local.get $a)))

  (func $emit_load8 (param $dst i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 28) (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    ;; A 32-bit indexed SIB byte load used to emit compute_ea_sib followed by
    ;; load8(SIB_SENTINEL). Fuse that exact generic pair: it is a dominant
    ;; generated-code pattern and needs neither a temporary consumer dispatch
    ;; nor the sentinel thread word. Absolute and 16-bit segmented addresses
    ;; retain their existing encodings below.
    (if (i32.and
          (i32.eqz (global.get $code16))
          (i32.eqz (call $mr_absolute)))
      (then
        (call $te (i32.const 149) (i32.or (i32.const 0x100) (local.get $dst)))
        (call $te_raw (i32.or
          (if (result i32) (i32.ne (global.get $mr_base) (i32.const -1))
            (then (global.get $mr_base)) (else (i32.const 0xF)))
          (i32.or (i32.shl (global.get $mr_index) (i32.const 4))
                  (i32.shl (global.get $mr_scale) (i32.const 8)))))
        (call $te_raw (global.get $mr_disp))
        (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 24) (local.get $dst)) (call $te_raw (local.get $a)))

  (func $emit_store8 (param $src i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 29) (i32.or (i32.shl (local.get $src) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    ;; Indexed byte stores are the second-heaviest SIB consumer in a sprite
    ;; blitter (24.3% of Heroes II's). Fuse them into handler 401 for the same
    ;; reason emit_load8 fuses its own: one dispatch, no sentinel word.
    (if (i32.and
          (i32.eqz (global.get $code16))
          (i32.eqz (call $mr_absolute)))
      (then
        (call $te (i32.const 401) (local.get $src))
        (call $te_raw (call $sib_info_word))
        (call $te_raw (global.get $mr_disp))
        (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 25) (local.get $src)) (call $te_raw (local.get $a)))

  ;; Emit an indexed SIB LEA, folding a following unprefixed indexed SIB LEA.
  ;; This bounded lookahead handles the ordinary mod=00/01/10 encodings and
  ;; leaves prefixes, register operands, and non-SIB forms to the main decoder.
  (func $emit_lea_sib (param $dst i32)
    (local $info1 i32) (local $disp1 i32) (local $opcode i32) (local $modrm i32)
    (local $mod i32) (local $sib i32) (local $base i32) (local $index i32)
    (local $info2 i32) (local $disp2 i32) (local $len i32) (local $dst2 i32)
    (local.set $info1 (i32.or
      (if (result i32) (i32.ne (global.get $mr_base) (i32.const -1))
        (then (global.get $mr_base)) (else (i32.const 0xF)))
      (i32.or (i32.shl (global.get $mr_index) (i32.const 4))
              (i32.shl (global.get $mr_scale) (i32.const 8)))))
    (local.set $disp1 (global.get $mr_disp))
    (local.set $opcode (call $gl8 (global.get $d_pc)))
    (local.set $modrm (call $gl8 (i32.add (global.get $d_pc) (i32.const 1))))
    (local.set $mod (i32.shr_u (local.get $modrm) (i32.const 6)))
    (if (i32.and
          (i32.and
            (i32.eq (local.get $opcode) (i32.const 0x8D))
            (i32.ne (local.get $mod) (i32.const 3)))
          (i32.eq (i32.and (local.get $modrm) (i32.const 7)) (i32.const 4)))
      (then
        (local.set $sib (call $gl8 (i32.add (global.get $d_pc) (i32.const 2))))
        (local.set $index (i32.and (i32.shr_u (local.get $sib) (i32.const 3)) (i32.const 7)))
        (if (i32.ne (local.get $index) (i32.const 4))
          (then
            (local.set $base (i32.and (local.get $sib) (i32.const 7)))
            (local.set $info2 (i32.or
              (if (result i32) (i32.and
                    (i32.eqz (local.get $mod))
                    (i32.eq (local.get $base) (i32.const 5)))
                (then (i32.const 0xF)) (else (local.get $base)))
              (i32.or (i32.shl (local.get $index) (i32.const 4))
                      (i32.shl (i32.and (local.get $sib) (i32.const 0xC0)) (i32.const 2)))))
            (local.set $len (i32.const 3))
            (if (i32.eq (local.get $mod) (i32.const 1))
              (then
                (local.set $disp2 (i32.extend8_s (call $gl8 (i32.add (global.get $d_pc) (i32.const 3)))))
                (local.set $len (i32.const 4))))
            (if (i32.or
                  (i32.eq (local.get $mod) (i32.const 2))
                  (i32.and (i32.eqz (local.get $mod)) (i32.eq (local.get $base) (i32.const 5))))
              (then
                (local.set $disp2 (call $gl32 (i32.add (global.get $d_pc) (i32.const 3))))
                (local.set $len (i32.const 7))))
            (local.set $dst2 (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
            (call $te (i32.const 390) (i32.or (local.get $dst) (i32.shl (local.get $dst2) (i32.const 4))))
            (call $te_raw (local.get $info1))
            (call $te_raw (local.get $disp1))
            (call $te_raw (local.get $info2))
            (call $te_raw (local.get $disp2))
            (global.set $d_pc (i32.add (global.get $d_pc) (local.get $len)))
            (return)))))
    (call $te (i32.const 148) (local.get $dst))
    (call $te_raw (local.get $info1))
    (call $te_raw (local.get $disp1)))

  (func $emit_lea (param $dst i32)
    ;; LEA computes address without memory access
    (call $apply_seg_override)
    ;; In a 16-bit task LEA yields the offset, not the linear address: the
    ;; guest is about to use it as one half of a far pointer or as an index.
    (if (global.get $code16)
      (then
        (call $te (i32.const 364) (local.get $dst))
        (call $te_raw (call $ea16_info))
        (call $te_raw (global.get $mr_disp))
        (return)))
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
        (call $emit_lea_sib (local.get $dst))
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
    ;; Alpha Centauri's hottest palette/conversion loops use these exact
    ;; base-free SIB ADDs. Keep every prefixed/segmented/16-bit/general SIB
    ;; form on the ordinary path; handlers 444-446 consume only the disp.
    (if (i32.and
          (i32.and
            (i32.eqz (global.get $code16))
            (i32.eqz (local.get $alu_op)))
          (i32.and
            (i32.eq (global.get $mr_base) (i32.const -1))
            (i32.and
              (i32.eqz (global.get $mr_index))
              (i32.and
                (i32.eq (global.get $mr_scale) (i32.const 1))
                (i32.or
                  (i32.or (i32.eq (local.get $reg) (i32.const 2))
                          (i32.eq (local.get $reg) (i32.const 5)))
                  (i32.eq (local.get $reg) (i32.const 6)))))))
      (then
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (call $te (i32.const 444) (global.get $mr_disp)))
          (else (if (i32.eq (local.get $reg) (i32.const 5))
            (then (call $te (i32.const 445) (global.get $mr_disp)))
            (else (call $te (i32.const 446) (global.get $mr_disp))))))
        (return)))
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
    ;; 16-bit ALU [mem], imm16 — handler 220 for base+disp, handler 122 for abs/SIB
    (if (call $mr_simple_base)
      (then (call $te (i32.const 220) (i32.or (i32.shl (local.get $alu_op) (i32.const 8)) (global.get $mr_base)))
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
    (if (i32.and
          (i32.eqz (global.get $code16))
          (i32.eqz (call $mr_absolute)))
      (then
        (call $te (i32.const 402) (local.get $imm))
        (call $te_raw (call $sib_info_word))
        (call $te_raw (global.get $mr_disp))
        (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 77) (local.get $imm))
    (call $te_raw (local.get $a)))

  ;; The instruction after a memory unary, when it is an unprefixed Group 1
  ;; ALU-with-immediate (0x81 or 0x83) against the very same [base+disp]: the
  ;; `inc dword [ebp-8] / cmp dword [ebp-8],imm` loop counter. Called with the
  ;; unary's ModRM already decoded and $mr_simple_base true, so the first EA is
  ;; reg[$mr_base] + $mr_disp and the write cannot disturb its own base
  ;; register. The second operand is matched on raw bytes in its plain ModRM
  ;; form only — rm==4 (SIB) and mod==00/rm==101 (absolute) decline, and any
  ;; operand-size, address-size, segment or LOCK prefix in front declines by
  ;; construction, since the first byte must be 0x81/0x83. Emits handler 409
  ;; and consumes the second instruction; returns 0 to leave the ordinary
  ;; encoding to the caller. A branch into the middle of the pair is safe:
  ;; blocks are keyed by EIP, so that target decodes as its own block.
  (func $try_emit_unary_alu_m32 (param $uop i32) (result i32)
    (local $p i32) (local $b i32) (local $modrm i32) (local $mod i32)
    (local $rm i32) (local $disp i32) (local $imm i32)
    (if (i32.or (global.get $code16) (global.get $d_addr16)) (then (return (i32.const 0))))
    (local.set $p (global.get $d_pc))
    (local.set $b (call $gl8 (local.get $p)))
    (if (i32.and (i32.ne (local.get $b) (i32.const 0x81))
                 (i32.ne (local.get $b) (i32.const 0x83)))
      (then (return (i32.const 0))))
    (local.set $modrm (call $gl8 (i32.add (local.get $p) (i32.const 1))))
    (local.set $mod (i32.and (local.get $modrm) (i32.const 0xC0)))
    (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
    (if (i32.eq (local.get $mod) (i32.const 0xC0)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $rm) (i32.const 4)) (then (return (i32.const 0))))
    (if (i32.and (i32.eqz (local.get $mod)) (i32.eq (local.get $rm) (i32.const 5)))
      (then (return (i32.const 0))))
    (if (i32.ne (local.get $rm) (global.get $mr_base)) (then (return (i32.const 0))))
    (local.set $p (i32.add (local.get $p) (i32.const 2)))
    (if (i32.eq (local.get $mod) (i32.const 0x40))
      (then
        (local.set $disp (call $sign_ext8 (call $gl8 (local.get $p))))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))))
    (if (i32.eq (local.get $mod) (i32.const 0x80))
      (then
        (local.set $disp (call $gl32 (local.get $p)))
        (local.set $p (i32.add (local.get $p) (i32.const 4)))))
    (if (i32.ne (local.get $disp) (global.get $mr_disp)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $b) (i32.const 0x83))
      (then
        (local.set $imm (call $sign_ext8 (call $gl8 (local.get $p))))
        (local.set $p (i32.add (local.get $p) (i32.const 1))))
      (else
        (local.set $imm (call $gl32 (local.get $p)))
        (local.set $p (i32.add (local.get $p) (i32.const 4)))))
    (call $te (i32.const 409)
      (i32.or
        (i32.shl (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7))
                 (i32.const 8))
        (i32.or (i32.shl (local.get $uop) (i32.const 4)) (global.get $mr_base))))
    (call $te_raw (global.get $mr_disp))
    (call $te_raw (local.get $imm))
    (global.set $d_pc (local.get $p))
    (i32.const 1))

  ;; Unary (inc/dec/not/neg) [mem32]
  (func $emit_unary_m32 (param $uop i32) (local $a i32)
    (if (call $mr_simple_base)
      (then
            (if (call $try_emit_unary_alu_m32 (local.get $uop)) (then (return)))
            (call $te (i32.const 135) (i32.or (i32.shl (local.get $uop) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 68) (local.get $uop))
    (call $te_raw (local.get $a)))

  (func $emit_unary_m8 (param $uop i32) (local $a i32)
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 69) (local.get $uop))
    (call $te_raw (local.get $a)))

  ;; 16-bit memory unary (inc/dec/not/neg word [mem]) — used for 0x66 prefix on FF /0, FF /1, F7 /2, F7 /3
  (func $emit_unary_m16 (param $uop i32) (local $a i32)
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 281) (local.get $uop))
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

  ;; TEST [mem16], reg16
  (func $emit_test_m16_r (param $reg i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 274) (i32.or (i32.shl (local.get $reg) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 273) (local.get $reg))
    (call $te_raw (local.get $a)))

  ;; TEST [mem16], imm16
  (func $emit_test_m16_i (param $imm i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 276) (global.get $mr_base))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $imm)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 275) (i32.const 0))
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
    ;; Direct-address handlers carry the count in bits 16..23; the RO
    ;; handlers below read the decoder's compact type<<8|count word.
    (call $te (i32.const 54)
      (i32.or (i32.and (local.get $shift_info) (i32.const 0xFF00))
              (i32.shl (i32.and (local.get $shift_info) (i32.const 0xFF)) (i32.const 16))))
    (call $te_raw (local.get $a)))

  ;; Shift [mem8] — 8-bit, with simple base check
  (func $emit_shift_m8 (param $shift_info i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 245) (global.get $mr_base))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $shift_info)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 192)
      (i32.or (i32.and (local.get $shift_info) (i32.const 0xFF00))
              (i32.shl (i32.and (local.get $shift_info) (i32.const 0xFF)) (i32.const 16))))
    (call $te_raw (local.get $a)))
  ;; Shift [mem16] — 16-bit, with simple base check
  (func $emit_shift_m16 (param $shift_info i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 246) (global.get $mr_base))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $shift_info)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 194)
      (i32.or (i32.and (local.get $shift_info) (i32.const 0xFF00))
              (i32.shl (i32.and (local.get $shift_info) (i32.const 0xFF)) (i32.const 16))))
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
    (if (i32.and
          (i32.and (i32.eq (global.get $mr_base) (i32.const -1))
                   (i32.eq (global.get $mr_index) (i32.const 0)))
          (i32.eq (global.get $mr_scale) (i32.const 2)))
      (then
        (call $te (i32.const 355) (i32.const 0))
        (call $te_raw (global.get $mr_disp))
        (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 125) (i32.const 0))
    (call $te_raw (local.get $a)))

  ;; PUSH [mem32]
  (func $emit_push_m32 (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 142) (global.get $mr_base))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 121) (i32.const 0))
    (call $te_raw (local.get $a)))

  ;; POP [mem32]
  (func $emit_pop_m32 (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 232) (global.get $mr_base))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 231) (i32.const 0))
    (call $te_raw (local.get $a)))

  ;; MOVZX reg, byte [mem]. $w16 = the 0x66 form, which writes only the low
  ;; half of the destination (handlers 414/416 instead of 78/143).
  (func $emit_movzx8 (param $dst i32) (param $w16 i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (if (result i32) (local.get $w16) (then (i32.const 416)) (else (i32.const 143)))
                      (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (if (result i32) (local.get $w16) (then (i32.const 414)) (else (i32.const 78))) (local.get $dst))
    (call $te_raw (local.get $a)))

  ;; MOVSX reg, byte [mem]
  (func $emit_movsx8 (param $dst i32) (param $w16 i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (if (result i32) (local.get $w16) (then (i32.const 417)) (else (i32.const 144)))
                      (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    ;; MOVSX r32, byte [base+index] is the single hottest SIB consumer in an
    ;; 8bpp sprite blitter — 37.7% of every SIB EA Heroes II computes on its
    ;; adventure map. Fuse it into handler 400.
    (if (i32.and
          (i32.and
            (i32.eqz (global.get $code16))
            (i32.eqz (local.get $w16)))
          (i32.eqz (call $mr_absolute)))
      (then
        (call $te (i32.const 400) (local.get $dst))
        (call $te_raw (call $sib_info_word))
        (call $te_raw (global.get $mr_disp))
        (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (if (result i32) (local.get $w16) (then (i32.const 415)) (else (i32.const 79))) (local.get $dst))
    (call $te_raw (local.get $a)))

  ;; MOVZX reg, word [mem]. Under 0x66 both source and destination are 16 bits,
  ;; so the instruction is just mov r16, [mem] — handlers 164/166.
  (func $emit_movzx16 (param $dst i32) (param $w16 i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (if (result i32) (local.get $w16) (then (i32.const 166)) (else (i32.const 145)))
                      (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (if (result i32) (local.get $w16) (then (i32.const 164)) (else (i32.const 80))) (local.get $dst))
    (call $te_raw (local.get $a)))

  ;; MOVSX reg, word [mem] — same degeneration under 0x66.
  (func $emit_movsx16 (param $dst i32) (param $w16 i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (if (result i32) (local.get $w16) (then (i32.const 166)) (else (i32.const 146)))
                      (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (if (result i32) (local.get $w16) (then (i32.const 164)) (else (i32.const 81))) (local.get $dst))
    (call $te_raw (local.get $a)))

  ;; MUL/IMUL/DIV/IDIV [mem32]. type: 0=mul,1=imul,2=div,3=idiv
  (func $emit_muldiv_m32 (param $mtype i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 147) (i32.or (i32.shl (local.get $mtype) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (if (i32.eq (local.get $mtype) (i32.const 0)) (then (call $te (i32.const 60) (i32.const 0)) (call $te_raw (local.get $a)) (return)))
    (if (i32.eq (local.get $mtype) (i32.const 1)) (then (call $te (i32.const 61) (i32.const 0)) (call $te_raw (local.get $a)) (return)))
    (if (i32.eq (local.get $mtype) (i32.const 2)) (then (call $te (i32.const 62) (i32.const 0)) (call $te_raw (local.get $a)) (return)))
    (call $te (i32.const 63) (i32.const 0)) (call $te_raw (local.get $a)))

  ;; MUL/IMUL/DIV/IDIV [mem16]. type: 0=mul,1=imul,2=div,3=idiv
  (func $emit_muldiv_m16 (param $mtype i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 287) (i32.or (i32.shl (local.get $mtype) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 286) (local.get $mtype))
    (call $te_raw (local.get $a)))

  ;; MUL/IMUL/DIV/IDIV [mem8]. type: 0=mul,1=imul,2=div,3=idiv
  (func $emit_muldiv_m8 (param $mtype i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 244) (i32.or (i32.shl (local.get $mtype) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 243) (local.get $mtype))
    (call $te_raw (local.get $a)))

  ;; PUSH [mem16]
  (func $emit_push_m16 (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 269) (global.get $mr_base))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 267) (i32.const 0))
    (call $te_raw (local.get $a)))

  ;; Match the exact 40 bytes following Smacker's leading FE opcode. Keeping
  ;; the signature in one helper makes the hot decoder branch readable and
  ;; ensures a near-match always falls back to ordinary i486 decoding.
  (func $match_smack_huff_walk (result i32)
    (local $counter_addr i32)
    (if (i32.ne (call $gl8 (global.get $d_pc)) (i32.const 0x0D))
      (then (return (i32.const 0))))
    (local.set $counter_addr
      (call $gl32 (i32.add (global.get $d_pc) (i32.const 1))))
    (if (i32.ne (call $gl8 (i32.add (global.get $d_pc) (i32.const 5))) (i32.const 0x75))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl8 (i32.add (global.get $d_pc) (i32.const 6))) (i32.const 0x0C))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl16 (i32.add (global.get $d_pc) (i32.const 7))) (i32.const 0x2E8B))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (global.get $d_pc) (i32.const 9))) (i32.const 0xC604C683))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl8 (i32.add (global.get $d_pc) (i32.const 13))) (i32.const 0x05))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (global.get $d_pc) (i32.const 14))) (local.get $counter_addr))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl8 (i32.add (global.get $d_pc) (i32.const 18))) (i32.const 0x20))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (global.get $d_pc) (i32.const 19))) (i32.const 0x7201EDC1))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl8 (i32.add (global.get $d_pc) (i32.const 23))) (i32.const 0x05))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl8 (i32.add (global.get $d_pc) (i32.const 24))) (i32.const 0xB8))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (global.get $d_pc) (i32.const 25))) (i32.const 4))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (global.get $d_pc) (i32.const 29))) (i32.const 0x028BD003))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl8 (i32.add (global.get $d_pc) (i32.const 33))) (i32.const 0xA9))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (global.get $d_pc) (i32.const 34))) (i32.const 0x80000000))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl16 (i32.add (global.get $d_pc) (i32.const 38))) (i32.const 0xD774))
      (then (return (i32.const 0))))
    (i32.const 1))

  ;; Match Storm.dll's 144-byte PKWARE bit-reservoir helper. The signature has
  ;; no relocated addresses: check its complete prologue/fast path and the
  ;; entire common slow-path tail. This is deliberately an exact compiler-code
  ;; superinstruction, not a general CALL peephole.
  (func $match_storm_bitreader (result i32)
    (local $p i32)
    (local.set $p (global.get $d_pc))
    (if (i32.ne (call $gl32 (local.get $p)) (i32.const 0x748B5653))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 4))) (i32.const 0x8B570C24))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 8))) (i32.const 0x8B14245C))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 12))) (i32.const 0xC33B1846))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 16))) (i32.const 0xCB8A1072))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 20))) (i32.const 0x895FC32B))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 24))) (i32.const 0x6ED31846))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 28))) (i32.const 0x5EC03314))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 32))) (i32.const 0xC88AC35B))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 36))) (i32.const 0xD31C7E8D))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 40))) (i32.const 0x468B146E))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 44))) (i32.const 0x75073920))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 96))) (i32.const 0x8AD23307))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 100))) (i32.const 0x22340694))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 104))) (i32.const 0x8B400000))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 108))) (i32.const 0x08E2C1CB))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 112))) (i32.const 0x560B0789))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 116))) (i32.const 0x18468B14))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 120))) (i32.const 0x5689C82A))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 124))) (i32.const 0x5FC32B14))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 128))) (i32.const 0xC083EAD3))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 132))) (i32.const 0x14568908))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 136))) (i32.const 0x33184689))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gl32 (i32.add (local.get $p) (i32.const 140))) (i32.const 0xC35B5EC0))
      (then (return (i32.const 0))))
    (i32.const 1))

  ;; ============================================================
  ;; DECODE BLOCK
  ;; ============================================================
  (func $decode_block (param $start_eip i32) (result i32)
    (local $tstart i32)
    (local $op i32)
    (local $done i32) (local $icount i32)
    (local $cc_n i32)          ;; matched length of a cmp/jz switch ladder
    (local $prefix_rep i32)    ;; 0=none, 1=REP/REPE, 2=REPNE
    (local $prefix_66 i32)     ;; operand-size override
    (local $prefix_67 i32)     ;; address-size override
    (local $prefix_seg i32)    ;; segment override (ignored but consumed)
    (local $imm i32)
    (local $disp i32)
    (local $a i32)
    (local $insn_start i32)  ;; d_pc before prefixes/opcode for interior matchers
    (local $mmxsub i32)        ;; MMX subop id, or -1 when this 0F op is not MMX
    (local $mmxpc i32)         ;; d_pc before an MMX ModRM, to rewind on a reject

    ;; Proactive overflow check BEFORE capturing $tstart. If $te triggers a
    ;; mid-decode reset of $thread_alloc, $tstart would still hold the pre-reset
    ;; address, and $cache_store at the end would record a stale offset pointing
    ;; into reused thread storage. Headroom of 16KB is far larger than any
    ;; single block needs.
    ;; Also the point where a flush deferred by a nested wndproc is taken:
    ;; here we are between blocks, which is the only place recycling the arena
    ;; cannot pull the ground out from under a live frame.
    (if (i32.or
          (global.get $thread_flush_pending)
          (i32.ge_u (global.get $thread_alloc)
            (i32.sub (global.get $THREAD_END) (i32.const 16384))))
      (then
        (if (call $thread_arena_flush_if_safe)
          (then (call $host_log_i32 (i32.const 0xCA00F10F))))))
    (local.set $tstart (global.get $thread_alloc))
    ;; Start a fresh op-start index for this block. Reset here rather than at
    ;; the end so an early return (the stack-packet path below, a 16-bit
    ;; bail-out) leaves a consistent -- if unused -- index behind.
    (global.set $op_index_n (i32.const 0))
    (global.set $op_index_poison (i32.const 0))
    ;; Ask once, here, whether this block entry is the MSVC small-block-heap
    ;; scan loop. The run loop then only has to compare EIP with the answer.
    (call $sbh_note_candidate (local.get $start_eip))
    (global.set $d_pc (local.get $start_eip))
    (local.set $done (i32.const 0))

    (if (i32.and
          (global.get $stack_packet_enabled)
          (i32.eq (local.get $start_eip) (global.get $stack_packet_addr)))
      (then
        ;; Which variant of the packet handler to emit is decided by whoever
        ;; armed the prototype, not by a guest address compiled into the
        ;; decoder. This used to test two literal EIPs from one particular
        ;; build of one particular game, in the decoder every app runs.
        (call $te (i32.const 356) (global.get $stack_packet_variant))
        (return
          (call $publish_block (local.get $start_eip) (local.get $tstart)
                (i32.add (local.get $start_eip) (i32.const 1))))))

    ;; A 16-bit task can only execute inside the selector arena. Landing
    ;; outside it means a far pointer was used as a linear address somewhere,
    ;; and this has to be checked before the zeros test below: the runaway
    ;; usually lands in zeros, and decoding on into them overwrites
    ;; $dbg_prev_eip with the runaway's own addresses within two blocks, which
    ;; is exactly the information needed to find the transfer that caused it.
    (if (global.get $code16)
      (then
        (if (i32.or
              (i32.lt_u (local.get $start_eip) (global.get $WIN16_ARENA))
              (i32.ge_u (local.get $start_eip)
                (i32.add (global.get $WIN16_ARENA)
                  (i32.mul (global.get $WIN16_SEG_MAX) (i32.const 0x10000)))))
          (then
            (call $host_log_i32 (i32.const 0xCA165E20))  ;; 16-bit EIP outside the arena
            (call $host_log_i32 (local.get $start_eip))
            (call $host_log_i32 (global.get $dbg_prev2_eip))
            (unreachable)))))

    ;; A block entry pointing at eight zero bytes is not code. Real entries are
    ;; call-return landings, branch targets or function prologues, none of which
    ;; begin `add [eax],al` eight times over. This happens when a call lands in
    ;; an uninitialised region — Explorer's SHELL32 does it by entering the
    ;; INSTDATA 16-bit thunk block that ThunkConnect32 never filled here.
    ;; Without this the emulator grinds through the whole page and any pages
    ;; after it, which reads as a hang rather than a missing feature.
    (if (i32.and
          (i32.eqz (i32.load (call $g2w (global.get $d_pc))))
          (i32.eqz (i32.load (call $g2w (i32.add (global.get $d_pc) (i32.const 4))))))
      (then
        (call $host_log_i32 (i32.const 0xCA002E20))  ;; execution entered zeros
        (call $host_log_i32 (local.get $start_eip))
        ;; Where it came from matters more than where it landed: zeros are
        ;; never the bug, the transfer into them is.
        (call $host_log_i32 (global.get $dbg_prev2_eip))
        (unreachable)))

    (block $exit (loop $decode
      (br_if $exit (local.get $done))

      ;; Storm's scalar MPQ decompressor calls this tiny helper tens of
      ;; thousands of times per rendered frame load. It is always entered at a
      ;; basic-block boundary, so recognize the whole exact helper before the
      ;; ordinary per-instruction decoder consumes its first PUSH.
      (if (i32.and
            (i32.eqz (local.get $icount))
            (i32.eqz (global.get $code16)))
        (then
          (if (call $match_storm_bitreader)
            (then
              (call $te (i32.const 396)
                (i32.add (global.get $d_pc) (i32.const 0x31)))
              (local.set $done (i32.const 1))
              (br $decode)))))

      ;; A run-length sprite blit is a loop NEST, so it is only ever entered
      ;; at its head -- try it at a block start, before the ladder fold below
      ;; gets to the ladder that sits inside it. Declining costs one scan and
      ;; leaves that fold to do its (smaller) job.
      (if (i32.and (i32.eqz (local.get $icount))
                   (i32.eqz (global.get $code16)))
        (then
          (if (call $try_emit_aoe_span_prefix (local.get $start_eip))
            (then
              (local.set $done (i32.const 1))
              (br $decode)))
          (if (call $try_emit_rgb565_alpha_run (local.get $start_eip))
            (then
              (local.set $done (i32.const 1))
              (br $decode)))
          (if (call $try_emit_rgb565_colorkey_run (local.get $start_eip))
            (then
              (local.set $done (i32.const 1))
              (br $decode)))
          (if (call $try_emit_mw3_grid_filter_run (local.get $start_eip))
            (then
              (local.set $done (i32.const 1))
              (br $decode)))
          (if (call $try_emit_colorkey8_run (local.get $start_eip))
            (then
              (local.set $done (i32.const 1))
              (br $decode)))
          (if (call $try_emit_rle_run (local.get $start_eip))
            (then
              (local.set $done (i32.const 1))
              (br $decode)))))

      ;; A `switch` a compiler declined to build a jump table for comes out as
      ;; a run of `cmp al,imm8 / jz case`, and every jz ends a block, so
      ;; reaching case k costs k dispatches, k eip stores and k cache lookups.
      ;; Caesar III's RLE sprite decoder opens with a sixteen-wide one at
      ;; 0x40f725 that is 24.0% of all block entries in a gameplay window.
      ;; Unlike the Storm helper above this is not gated on icount==0: Caesar's
      ;; ladder starts after a `mov al,[esi]`, mid-block.
      (if (i32.and (global.get $case_chain_enabled)
                   (i32.eqz (global.get $code16)))
        (then
          (local.set $cc_n (call $case_chain_count (global.get $d_pc)
            (i32.and (local.get $start_eip) (i32.const 0xFFFFF000))))
          (if (i32.ge_u (local.get $cc_n) (global.get $CASE_CHAIN_MIN))
            (then
              (call $emit_case_chain (local.get $cc_n))
              (local.set $done (i32.const 1))
              (br $decode)))))

      ;; Most compiler basic blocks are short, but runtime generators can emit
      ;; thousands of straight-line instructions. $next has a 1000-handler
      ;; preemption quantum and does not retain $ip after it returns; allowing
      ;; a decoded block to exceed that quantum replays it from start_eip on
      ;; every host turn. Split at a real instruction boundary with ordinary
      ;; block_end semantics. 256 guest instructions leave ample room for the
      ;; few instructions that emit two or three threaded handlers.
      (local.set $icount (i32.add (local.get $icount) (i32.const 1)))
      (if (i32.gt_u (local.get $icount) (i32.const 256))
        (then
          (call $te (i32.const 45) (global.get $d_pc))
          (br $exit)))

      ;; Stop at the page edge. A block belongs to exactly one compiled page --
      ;; that page owns the chunk it lives in and the index that names its
      ;; guest bytes -- so a block that decoded on into the next page could not
      ;; be indexed for the bytes it covers there, and a write to those bytes
      ;; would not retire it. The hash cache used to absorb such blocks; with it
      ;; deleted (docs/page-compile-design.md section 4) an unindexable block is
      ;; a block re-decoded on every single entry, so cap here instead.
      ;;
      ;; The cost is one $th_block_end dispatch per page seam, which section 6
      ;; already accepted as the price of not doing cross-page discovery. On the
      ;; first iteration $d_pc is $start_eip, so this can never fire before an
      ;; instruction has been emitted.
      (if (i32.ne (i32.and (global.get $d_pc) (i32.const 0xFFFFF000))
                  (i32.and (local.get $start_eip) (i32.const 0xFFFFF000)))
        (then
          (call $te (i32.const 45) (global.get $d_pc))
          (br $exit)))

      ;; A Duff-style jump table lands on one suffix of a fully unrolled
      ;; renderer. Recognize a contiguous LUT/blend span at any instruction
      ;; boundary and continue decoding its ordinary row tail afterwards.
      (if (call $try_emit_lut_span) (then (br $decode)))

      (local.set $insn_start (global.get $d_pc))
      ;; Reset prefixes
      (local.set $prefix_rep (i32.const 0))
      (local.set $prefix_66 (i32.const 0))
      (local.set $prefix_67 (i32.const 0))
      (local.set $prefix_seg (i32.const 0))

      ;; Consume prefixes
      (block $pfx_done (loop $pfx
        (local.set $op (call $d_fetch8))
        (if (i32.eq (local.get $op) (i32.const 0xF3)) (then (local.set $prefix_rep (i32.const 1)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0xF2)) (then (local.set $prefix_rep (i32.const 2)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x66)) (then (local.set $prefix_66 (i32.const 1)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x67)) (then (local.set $prefix_67 (i32.const 1)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x26)) (then (local.set $prefix_seg (i32.const 1)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x2E)) (then (local.set $prefix_seg (i32.const 2)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x36)) (then (local.set $prefix_seg (i32.const 3)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x3E)) (then (local.set $prefix_seg (i32.const 4)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x64)) (then (local.set $prefix_seg (i32.const 5)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x65)) (then (local.set $prefix_seg (i32.const 6)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0xF0)) (then (br $pfx))) ;; LOCK — ignore
        (br $pfx_done)
      ))

      ;; In a 16-bit code segment the defaults are the other way round: 16-bit
      ;; operands and 16-bit addresses, with 0x66/0x67 selecting 32. Inverting
      ;; the two flags here means every `if prefix_66` test further down —
      ;; there are hundreds — reads correctly for both modes without being
      ;; touched.
      (if (global.get $code16)
        (then
          (local.set $prefix_66 (i32.xor (local.get $prefix_66) (i32.const 1)))
          (local.set $prefix_67 (i32.xor (local.get $prefix_67) (i32.const 1)))))

      ;; Propagate segment prefix to global for ModRM decoder
      (global.set $d_seg (local.get $prefix_seg))
      (global.set $d_addr16 (local.get $prefix_67))

      ;; 0x67 (address-size override) changes how an instruction forms its
      ;; effective address, so every opcode has to opt in deliberately —
      ;; decoding 16-bit addressing as 32-bit ModRM/SIB silently corrupts EAs.
      ;; Anything not listed here still traps, and the log carries the opcode
      ;; so the next case is easy to add.
      ;;   0xE0..0xE3  LOOP/LOOPE/LOOPNE/JCXZ — no ModRM; the prefix only
      ;;               swaps the implicit counter ECX→CX, passed through to
      ;;               handlers 46 / 216.
      ;;   0x88..0x8B  MOV r/m,r and MOV r,r/m — $decode_modrm handles the
      ;;               16-bit form and traps on the ones it cannot model.
      ;;   0xA0..0xA3  MOV AL/eAX ↔ moffs — the offset itself becomes 16-bit.
      (if (i32.and (local.get $prefix_67) (i32.eqz (global.get $code16)))
        (then
          (if (i32.or
                (i32.and (i32.ge_u (local.get $op) (i32.const 0xE0)) (i32.le_u (local.get $op) (i32.const 0xE3)))
                (i32.or
                  (i32.and (i32.ge_u (local.get $op) (i32.const 0x88)) (i32.le_u (local.get $op) (i32.const 0x8B)))
                  (i32.and (i32.ge_u (local.get $op) (i32.const 0xA0)) (i32.le_u (local.get $op) (i32.const 0xA3)))))
            (then) ;; allow — handled below
            (else
              (call $host_log_i32 (i32.const 0xCA5E0067))
              (call $host_log_i32 (local.get $op))
              (call $host_log_i32 (global.get $d_pc))
              (unreachable)))))

      ;; Jazz enters each masked 32-byte MMX row copy through setup code in the
      ;; same x86 basic block (`mov ebx,[ebp+disp]` immediately precedes the
      ;; loop head). Checking only start_eip made the focused head-entry test
      ;; pass while authentic execution decoded the ordinary MMX body first.
      ;; The signature starts with unprefixed `add ebx,ebx` (03 DB), so ask the
      ;; exact raw matcher only for that opcode. A hit terminates this enclosing
      ;; block because H419 owns both successors; a near miss consumes/emits
      ;; nothing and falls through to ordinary ADD decoding.
      (if (i32.and
            (i32.eq (local.get $op) (i32.const 0x03))
            (i32.and
              (i32.eqz (local.get $prefix_rep))
              (i32.and
                (i32.eqz (local.get $prefix_66))
                (i32.and
                  (i32.eqz (local.get $prefix_67))
                  (i32.eqz (local.get $prefix_seg))))))
        (then
          (if (call $try_emit_mmx_mask_copy32 (local.get $insn_start))
            (then
              (local.set $done (i32.const 1))
              (br $decode)))))

      ;; ---- NOP (0x90) ----
      (if (i32.eq (local.get $op) (i32.const 0x90)) (then (call $te (i32.const 0) (i32.const 0)) (br $decode)))

      ;; ---- PUSH reg (0x50-0x57) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x50)) (i32.le_u (local.get $op) (i32.const 0x57)))
        (then (if (local.get $prefix_66)
          (then (call $te (i32.const 181) (i32.sub (local.get $op) (i32.const 0x50))))
          (else (call $te (i32.add (i32.const 323) (i32.sub (local.get $op) (i32.const 0x50))) (i32.const 0))))
          (br $decode)))
      ;; ---- POP reg (0x58-0x5F) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x58)) (i32.le_u (local.get $op) (i32.const 0x5F)))
        (then (if (local.get $prefix_66)
          (then (call $te (i32.const 182) (i32.sub (local.get $op) (i32.const 0x58))))
          (else (call $te (i32.add (i32.const 331) (i32.sub (local.get $op) (i32.const 0x58))) (i32.const 0))))
          (br $decode)))
      ;; ---- PUSH/POP segment register (ES/CS/SS/DS) ----
      ;; Win32 uses a flat address space, but generated bitmap code still saves
      ;; and restores ES. Keep conventional selectors for observable PUSHes and
      ;; preserve the 66h-controlled 16/32-bit stack width.
      (if (i32.or
            (i32.or (i32.eq (local.get $op) (i32.const 0x06)) (i32.eq (local.get $op) (i32.const 0x0E)))
            (i32.or (i32.eq (local.get $op) (i32.const 0x16)) (i32.eq (local.get $op) (i32.const 0x1E))))
        (then
          ;; In a 16-bit task the pushed value is the real selector, and code
          ;; does `push ds / pop es` to alias segments.
          (if (global.get $code16)
            (then
              (call $te (i32.const 374) (i32.and (i32.shr_u (local.get $op) (i32.const 3)) (i32.const 3)))
              (br $decode)))
          (local.set $imm (i32.const 0x23)) ;; ES/SS/DS
          (if (i32.eq (local.get $op) (i32.const 0x0E))
            (then (local.set $imm (i32.const 0x1B)))) ;; CS
          (if (local.get $prefix_66)
            (then (local.set $imm (i32.or (local.get $imm) (i32.const 0x10000)))))
          (call $te (i32.const 359) (local.get $imm))
          (br $decode)))
      (if (i32.or
            (i32.or (i32.eq (local.get $op) (i32.const 0x07)) (i32.eq (local.get $op) (i32.const 0x17)))
            (i32.eq (local.get $op) (i32.const 0x1F)))
        (then
          (if (global.get $code16)
            (then
              (call $te (i32.const 375) (i32.and (i32.shr_u (local.get $op) (i32.const 3)) (i32.const 3)))
              (br $decode)))
          (call $te (i32.const 360) (local.get $prefix_66))
          (br $decode)))
      ;; ---- INC reg (0x40-0x47) / INC r16 with 66h ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x40)) (i32.le_u (local.get $op) (i32.const 0x47)))
        (then (if (local.get $prefix_66)
          (then (call $te (i32.const 202) (i32.sub (local.get $op) (i32.const 0x40))))
          (else (call $te (i32.const 64) (i32.sub (local.get $op) (i32.const 0x40)))))
          (br $decode)))
      ;; ---- DEC reg (0x48-0x4F) / DEC r16 with 66h ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x48)) (i32.le_u (local.get $op) (i32.const 0x4F)))
        (then (if (local.get $prefix_66)
          (then (call $te (i32.const 203) (i32.sub (local.get $op) (i32.const 0x48))))
          (else (call $te (i32.const 65) (i32.sub (local.get $op) (i32.const 0x48)))))
          (br $decode)))
      ;; ---- MOV reg, imm32 (0xB8-0xBF) / MOV reg, imm16 with 0x66 ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0xB8)) (i32.le_u (local.get $op) (i32.const 0xBF)))
        (then
          (if (local.get $prefix_66)
            (then (call $te (i32.const 236) (i32.sub (local.get $op) (i32.const 0xB8)))
                  (call $te_raw (call $d_fetch16)))
            (else (call $te (i32.const 2) (i32.sub (local.get $op) (i32.const 0xB8)))
                  (call $te_raw (call $d_fetch32))))
          (br $decode)))
      ;; ---- MOV reg8, imm8 (0xB0-0xB7) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0xB0)) (i32.le_u (local.get $op) (i32.const 0xB7)))
        (then
          (call $te (i32.const 156) (i32.sub (local.get $op) (i32.const 0xB0)))
          (call $te_raw (call $d_fetch8)) (br $decode)))
      ;; ---- XCHG eax, reg (0x91-0x97) / XCHG ax, r16 with 66h ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x91)) (i32.le_u (local.get $op) (i32.const 0x97)))
        (then (if (local.get $prefix_66)
          (then (call $te (i32.const 255) (i32.sub (local.get $op) (i32.const 0x90))))
          (else (call $te (i32.const 116) (i32.sub (local.get $op) (i32.const 0x90)))))
          (br $decode)))

      ;; ---- CALL far (0x9A ptr16:32) ----
      ;; Flat-mode emulation: ignore the selector, treat as near CALL to offset.
      ;; Real x86 would push (CS, EIP) but Win32 user-mode code that uses 0x9A
      ;; in flat memory just round-trips CS=0x1B, so the selector word is dead.
      (if (i32.eq (local.get $op) (i32.const 0x9A))
        (then
          ;; In a 16-bit task this is ptr16:16 and the selector is the whole
          ;; point: it says which segment, and a selector equal to the import
          ;; thunk segment says this is an API call.
          (if (global.get $code16)
            (then
              (local.set $disp (call $d_fetch16))  ;; offset
              (local.set $imm (call $d_fetch16))   ;; selector
              (call $te (i32.const 367) (global.get $d_pc))
              (call $te_raw (local.get $disp))
              (call $te_raw (local.get $imm))
              (local.set $done (i32.const 1)) (br $decode)))
          (local.set $disp (call $d_fetch32))   ;; offset
          (drop (call $d_fetch16))              ;; selector — ignored
          (call $te (i32.const 39) (global.get $d_pc)) ;; ret_addr = next_eip
          (call $te_raw (local.get $disp))
          (local.set $done (i32.const 1)) (br $decode)))

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
                      (then
                        ;; Smacker's hottest tree walk is the exact unprefixed
                        ;; sequence 03 d0 / 8b 02 / a9 imm32. TEST overwrites
                        ;; ADD's flags, so one handler can preserve all live
                        ;; register, memory, and final-flag state.
                        (if (i32.and
                              (i32.and
                                (i32.eqz (local.get $prefix_rep))
                                (i32.eqz (local.get $prefix_seg)))
                              (i32.and
                                (i32.eqz (local.get $prefix_67))
                                (i32.and
                                  (i32.eqz (local.get $imm))
                                  (i32.and
                                    (i32.eq (global.get $mr_reg) (i32.const 2))
                                    (i32.and
                                      (i32.eqz (global.get $mr_val))
                                      (i32.and
                                        (i32.eq (call $gl16 (global.get $d_pc)) (i32.const 0x028B))
                                        (i32.eq (call $gl8 (i32.add (global.get $d_pc) (i32.const 2))) (i32.const 0xA9))))))))
                          (then
                            (call $te (i32.const 392) (i32.const 0))
                            (call $te_raw (call $gl32 (i32.add (global.get $d_pc) (i32.const 3))))
                            (global.set $d_pc (i32.add (global.get $d_pc) (i32.const 7))))
                          (else
                            (call $te (i32.add (i32.const 12) (local.get $imm))
                              (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))))
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
          ;; imm: 0x81=imm32 (or imm16 with 0x66), 0x83=sign-extended imm8.
          ;; 0x80/0x82 are byte operations; keep the immediate as 0..255.
          (if (i32.eq (local.get $op) (i32.const 0x81))
            (then (if (local.get $prefix_66)
              (then (local.set $imm (call $d_fetch16)))
              (else (local.set $imm (call $d_fetch32)))))
            (else (if (i32.eq (local.get $op) (i32.const 0x83))
              (then (local.set $imm (call $sign_ext8 (call $d_fetch8))))
              (else (local.set $imm (i32.and (call $d_fetch8) (i32.const 0xFF)))))))
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
                  (else
                    (if (call $try_emit_alu_m32_i_jcc (global.get $mr_reg) (local.get $imm))
                      (then (local.set $done (i32.const 1)))
                      (else (call $emit_alu_m32_i (global.get $mr_reg) (local.get $imm))))))))))
          (br $decode)))

      ;; ---- 0x84: TEST r/m8, r8 ----
      (if (i32.eq (local.get $op) (i32.const 0x84))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then
              (if (call $try_emit_test_jcc (i32.const 1))
                (then (local.set $done (i32.const 1)) (br $decode)))
              (call $te (i32.const 150) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
            (else (call $emit_test_m8_r (global.get $mr_reg))))
          (br $decode)))

      ;; ---- 0x85: TEST r/m32, r (or r/m16, r16 with 0x66) ----
      (if (i32.eq (local.get $op) (i32.const 0x85))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (if (local.get $prefix_66)
              (then (call $te (i32.const 204) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
              (else
                (if (call $try_emit_test_jcc (i32.const 0))
                  (then (local.set $done (i32.const 1)) (br $decode)))
                (call $te (i32.const 72) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))))
            (else (if (local.get $prefix_66)
              (then (call $emit_test_m16_r (global.get $mr_reg)))
              (else (call $emit_test_m32_r (global.get $mr_reg))))))
          (br $decode)))

      ;; ---- 0x88/0x89: MOV r/m, r ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0x88)) (i32.eq (local.get $op) (i32.const 0x89)))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then
              (if (i32.eq (local.get $op) (i32.const 0x88))
                (then (call $emit_mov_r8_r8 (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
                (else (if (local.get $prefix_66)
                  (then (call $te (i32.const 210) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
                  (else (call $te (i32.const 11) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))))))
            (else
              (if (i32.eq (local.get $op) (i32.const 0x89))
                (then (if (local.get $prefix_66)
                  (then (call $emit_store16 (global.get $mr_reg)))
                  (else (call $emit_store32 (global.get $mr_reg)))))
                (else (call $emit_store8 (global.get $mr_reg))))))
          (br $decode)))

      ;; ---- 0x62: BOUND r32, m32&32 ----
      ;; Only the memory form exists; mod=11 is an invalid encoding and is
      ;; left to the unknown-opcode trap rather than silently decoded. The
      ;; 16-bit form goes the same way: no Borland output uses it, and a
      ;; wrong range check is worse than a loud one.
      (if (i32.and (i32.eq (local.get $op) (i32.const 0x62))
                   (i32.eqz (local.get $prefix_66)))
        (then
          (call $decode_modrm)
          (if (i32.ne (global.get $mr_mod) (i32.const 3))
            (then
              (call $apply_seg_override)
              (local.set $imm (call $emit_sib_or_abs))
              (call $te (i32.const 362) (global.get $mr_reg))
              (call $te_raw (local.get $imm))
              (br $decode)))))

      ;; ---- 0x8A/0x8B: MOV r, r/m ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0x8A)) (i32.eq (local.get $op) (i32.const 0x8B)))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then
              (if (i32.eq (local.get $op) (i32.const 0x8A))
                (then (call $emit_mov_r8_r8 (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                (else (if (local.get $prefix_66)
                  (then (call $te (i32.const 210) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                  (else (call $te (i32.const 11) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))))))
            (else
              (if (i32.eq (local.get $op) (i32.const 0x8B))
                (then (if (local.get $prefix_66)
                  (then (call $emit_load16 (global.get $mr_reg)))
                  (else (call $emit_load32 (global.get $mr_reg) (i32.const 1)))))
                (else (call $emit_load8 (global.get $mr_reg))))))
          (br $decode)))

      ;; ---- 0x8C: MOV r/m16, Sreg ----
      ;; Flat Win32 code occasionally snapshots SS/CS/FS selectors during CRT
      ;; startup. Report conventional ring-3 selector values; the emulator
      ;; still uses flat linear addressing for actual memory accesses.
      (if (i32.eq (local.get $op) (i32.const 0x8C))
        (then
          (call $decode_modrm)
          ;; A 16-bit task reports the selector it is actually using.
          (if (global.get $code16)
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 377)
                        (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                (else
                  (local.set $a (call $emit_sib_or_abs))
                  (call $te (i32.const 378) (global.get $mr_reg))
                  (call $te_raw (local.get $a))))
              (br $decode)))
          (local.set $imm (i32.const 0x23)) ;; ES/SS/DS
          (if (i32.eq (global.get $mr_reg) (i32.const 1))
            (then (local.set $imm (i32.const 0x1B)))) ;; CS
          (if (i32.eq (global.get $mr_reg) (i32.const 4))
            (then (local.set $imm (i32.const 0x3B)))) ;; FS
          (if (i32.eq (global.get $mr_reg) (i32.const 5))
            (then (local.set $imm (i32.const 0)))) ;; GS unused
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then
              (call $te (i32.const 236) (global.get $mr_val))
              (call $te_raw (local.get $imm)))
            (else (call $emit_store16_imm (local.get $imm))))
          (br $decode)))

      ;; ---- 0x8D: LEA ----
      (if (i32.eq (local.get $op) (i32.const 0x8D))
        (then
          (call $decode_modrm)
          (call $emit_lea (global.get $mr_reg))
          (br $decode)))

      ;; ---- 0x8E: MOV Sreg, r/m16 ----
      ;; Segment loads are ignored in flat mode. Decode ModRM so displacements
      ;; are consumed and execution continues at the correct next EIP. In a
      ;; 16-bit task they are the addressing, so they are performed.
      (if (i32.eq (local.get $op) (i32.const 0x8E))
        (then
          (call $decode_modrm)
          (if (global.get $code16)
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 372)
                        (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                (else
                  (local.set $a (call $emit_sib_or_abs))
                  (call $te (i32.const 373) (global.get $mr_reg))
                  (call $te_raw (local.get $a))))))
          (br $decode)))

      ;; ---- 0xC4: LES r16, m16:16 / 0xC5: LDS r16, m16:16 ----
      ;; The bread and butter of far-pointer code: load an offset into a
      ;; register and its selector into ES or DS in one instruction.
      ;;
      ;; A flat 32-bit task can reach one too — Watcom's va_arg walker emits
      ;; `les eax, [edx-8]`, which is how Fallout's demo gets here — so this is
      ;; not a $win16_only opcode. There the operand is m16:32 and every
      ;; selector is flat, so op 430 takes the offset and drops the selector.
      (if (i32.or (i32.eq (local.get $op) (i32.const 0xC4)) (i32.eq (local.get $op) (i32.const 0xC5)))
        (then
          (if (i32.eqz (global.get $code16))
            (then
              (call $decode_modrm)
              (local.set $a (call $emit_sib_or_abs))
              (call $te (i32.const 430)
                (i32.or (i32.shl (local.get $prefix_66) (i32.const 4))
                        (global.get $mr_reg)))
              (call $te_raw (local.get $a))
              (br $decode)))
          (call $decode_modrm)
          (local.set $a (call $emit_sib_or_abs))
          ;; 0xC4 loads ES (sreg 0), 0xC5 loads DS (sreg 3).
          (call $te (i32.const 376)
            (i32.or
              (i32.shl (if (result i32) (i32.eq (local.get $op) (i32.const 0xC4))
                         (then (i32.const 0)) (else (i32.const 3))) (i32.const 4))
              (global.get $mr_reg)))
          (call $te_raw (local.get $a))
          (br $decode)))

      ;; ---- 0xA0-0xA3: MOV AL/EAX, [abs] / MOV [abs], AL/EAX ----
      ;; Apply FS base if segment override is active. The operand here is a
      ;; moffs, not a ModRM, so the 0x67 prefix shrinks the offset itself to
      ;; 16 bits — Borland emits `mov eax, fs:[0]` as 64 67 a1 00 00.
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0xA0)) (i32.le_u (local.get $op) (i32.const 0xA3)))
        (then
          ;; In a 16-bit task the moffs is an offset within a segment, not a
          ;; linear address: `mov [0x1b4], ax` means DS:0x1b4 and DS moves, so
          ;; it has to resolve at runtime exactly as a ModRM disp16 does. Left
          ;; as a bare address it wrote below the guest image, and Solitaire —
          ;; which stores its three card bitmaps this way and then tests them
          ;; for zero — read back nothing and put up its load-failure box.
          (if (global.get $code16)
            (then
              (global.set $mr_base (i32.const -1))
              (global.set $mr_index (i32.const -1))
              (global.set $mr_seg (i32.const 3))          ;; DS
              (call $modrm16_apply_seg)
              (global.set $mr_disp
                (if (result i32) (local.get $prefix_67)
                  (then (call $d_fetch16)) (else (call $d_fetch32))))
              (local.set $imm (call $emit_sib_or_abs)))
            (else (local.set $imm (call $seg_adj
              (if (result i32) (local.get $prefix_67) (then (call $d_fetch16)) (else (call $d_fetch32)))
              (local.get $prefix_seg)))))))
      (if (i32.eq (local.get $op) (i32.const 0xA0)) (then (call $te (i32.const 24) (i32.const 0)) (call $te_raw (local.get $imm)) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xA1)) (then
        (if (local.get $prefix_66)
          (then (call $te (i32.const 164) (i32.const 0)) (call $te_raw (local.get $imm)))  ;; mov ax, [addr]
          (else
            (if (call $try_emit_abs_run (i32.const 0) (i32.const 0) (local.get $imm))
              (then (br $decode)))
            (call $te (i32.const 20) (i32.const 0)) (call $te_raw (local.get $imm))))   ;; mov eax, [addr]
        (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xA2)) (then (call $te (i32.const 25) (i32.const 0)) (call $te_raw (local.get $imm)) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xA3)) (then
        (if (local.get $prefix_66)
          (then (call $te (i32.const 163) (i32.const 0)) (call $te_raw (local.get $imm)))  ;; mov [addr], ax
          (else
            (if (call $try_emit_abs_run (i32.const 1) (i32.const 0) (local.get $imm))
              (then (br $decode)))
            (call $te (i32.const 21) (i32.const 0)) (call $te_raw (local.get $imm))))   ;; mov [addr], eax
        (br $decode)))

      ;; ---- 0xC6: MOV r/m8, imm8 ----
      (if (i32.eq (local.get $op) (i32.const 0xC6))
        (then
          (call $decode_modrm)
          (local.set $imm (call $d_fetch8))
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 156) (global.get $mr_val)) (call $te_raw (local.get $imm)))
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
            (then (if (local.get $prefix_66)
              (then (call $te (i32.const 236) (global.get $mr_val)) (call $te_raw (local.get $imm)))
              (else (call $te (i32.const 2) (global.get $mr_val)) (call $te_raw (local.get $imm)))))
            (else (if (local.get $prefix_66)
              (then (call $emit_store16_imm (local.get $imm)))
              (else (call $emit_store32_imm (local.get $imm))))))
          (br $decode)))

      ;; ---- 0xA8: TEST AL, imm8 ----
      (if (i32.eq (local.get $op) (i32.const 0xA8))
        (then (call $te (i32.const 217) (i32.const 0)) (call $te_raw (call $d_fetch8)) (br $decode)))
      ;; ---- 0xA9: TEST EAX, imm32 / TEST AX, imm16 (with 66h prefix) ----
      (if (i32.eq (local.get $op) (i32.const 0xA9))
        (then
          (if (local.get $prefix_66)
            (then (call $te (i32.const 205) (i32.const 0)) (call $te_raw (call $d_fetch16)))
            (else (call $te (i32.const 73) (i32.const 0)) (call $te_raw (call $d_fetch32))))
          (br $decode)))

      ;; ---- 0xF6/0xF7: Unary group 3 ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0xF6)) (i32.eq (local.get $op) (i32.const 0xF7)))
        (then
          (call $decode_modrm)
          ;; mr_reg: 0=TEST,1=TEST,2=NOT,3=NEG,4=MUL,5=IMUL,6=DIV,7=IDIV
          (if (i32.le_u (global.get $mr_reg) (i32.const 1)) ;; TEST
            (then
              (if (i32.eq (local.get $op) (i32.const 0xF6))
                (then (local.set $imm (call $d_fetch8)))
                (else (if (local.get $prefix_66)
                  (then (local.set $imm (call $d_fetch16)))
                  (else (local.set $imm (call $d_fetch32))))))
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then
                  (if (i32.eq (local.get $op) (i32.const 0xF6))
                    (then (call $te (i32.const 217) (global.get $mr_val)) (call $te_raw (local.get $imm)))
                    (else (if (local.get $prefix_66)
                      (then (call $te (i32.const 279) (global.get $mr_val)) (call $te_raw (local.get $imm)))
                      (else (call $te (i32.const 73) (global.get $mr_val)) (call $te_raw (local.get $imm)))))))
                (else
                  (if (i32.eq (local.get $op) (i32.const 0xF7))
                    (then (if (local.get $prefix_66)
                      (then (call $emit_test_m16_i (local.get $imm)))
                      (else (call $emit_test_m32_i (local.get $imm)))))
                    (else (call $emit_test_m8_i (local.get $imm))))))

              (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 2)) ;; NOT
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (if (i32.eq (local.get $op) (i32.const 0xF6))
                  (then (call $te (i32.const 215) (global.get $mr_val)))
                  (else (if (local.get $prefix_66)
                    (then (call $te (i32.const 410) (global.get $mr_val)))
                    (else (call $te (i32.const 66) (global.get $mr_val)))))))
                (else (if (i32.eq (local.get $op) (i32.const 0xF6))
                  (then (call $emit_unary_m8 (i32.const 2)))
                  (else (if (local.get $prefix_66)
                    (then (call $emit_unary_m16 (i32.const 2)))
                    (else (call $emit_unary_m32 (i32.const 2))))))))
              (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 3)) ;; NEG
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (if (i32.eq (local.get $op) (i32.const 0xF6))
                  (then (call $te (i32.const 214) (global.get $mr_val)))
                  (else (if (local.get $prefix_66)
                    (then (call $te (i32.const 411) (global.get $mr_val)))
                    (else (call $te (i32.const 67) (global.get $mr_val)))))))
                (else (if (i32.eq (local.get $op) (i32.const 0xF6))
                  (then (call $emit_unary_m8 (i32.const 3)))
                  (else (if (local.get $prefix_66)
                    (then (call $emit_unary_m16 (i32.const 3)))
                    (else (call $emit_unary_m32 (i32.const 3))))))))
              (br $decode)))
          ;; MUL/IMUL/DIV/IDIV: handle group-3 /4../7 explicitly so matched
          ;; forms cannot fall through to the unrecognized-opcode path.
          (if (i32.eq (global.get $mr_reg) (i32.const 4))
            (then
              (if (i32.eq (local.get $op) (i32.const 0xF6))
                (then
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 239) (global.get $mr_val)))
                    (else (call $emit_muldiv_m8 (i32.const 0)))))
                (else
                  (if (local.get $prefix_66)
                    (then
                      (if (i32.eq (global.get $mr_mod) (i32.const 3))
                        (then (call $te (i32.const 282) (global.get $mr_val)))
                        (else (call $emit_muldiv_m16 (i32.const 0)))))
                    (else
                      (if (i32.eq (global.get $mr_mod) (i32.const 3))
                        (then (call $te (i32.const 55) (global.get $mr_val)))
                        (else (call $emit_muldiv_m32 (i32.const 0))))))))
              (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 5))
            (then
              (if (i32.eq (local.get $op) (i32.const 0xF6))
                (then
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 240) (global.get $mr_val)))
                    (else (call $emit_muldiv_m8 (i32.const 1)))))
                (else
                  (if (local.get $prefix_66)
                    (then
                      (if (i32.eq (global.get $mr_mod) (i32.const 3))
                        (then (call $te (i32.const 283) (global.get $mr_val)))
                        (else (call $emit_muldiv_m16 (i32.const 1)))))
                    (else
                      (if (i32.eq (global.get $mr_mod) (i32.const 3))
                        (then (call $te (i32.const 56) (global.get $mr_val)))
                        (else (call $emit_muldiv_m32 (i32.const 1))))))))
              (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 6))
            (then
              (if (i32.eq (local.get $op) (i32.const 0xF6))
                (then
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 241) (global.get $mr_val)))
                    (else (call $emit_muldiv_m8 (i32.const 2)))))
                (else
                  (if (local.get $prefix_66)
                    (then
                      (if (i32.eq (global.get $mr_mod) (i32.const 3))
                        (then (call $te (i32.const 284) (global.get $mr_val)))
                        (else (call $emit_muldiv_m16 (i32.const 2)))))
                    (else
                      (if (i32.eq (global.get $mr_mod) (i32.const 3))
                        (then (call $te (i32.const 57) (global.get $mr_val)))
                        (else (call $emit_muldiv_m32 (i32.const 2))))))))
              (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 7))
            (then
              (if (i32.eq (local.get $op) (i32.const 0xF6))
                (then
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 242) (global.get $mr_val)))
                    (else (call $emit_muldiv_m8 (i32.const 3)))))
                (else
                  (if (local.get $prefix_66)
                    (then
                      (if (i32.eq (global.get $mr_mod) (i32.const 3))
                        (then (call $te (i32.const 285) (global.get $mr_val)))
                        (else (call $emit_muldiv_m16 (i32.const 3)))))
                    (else
                      (if (i32.eq (global.get $mr_mod) (i32.const 3))
                        (then (call $te (i32.const 58) (global.get $mr_val)))
                        (else (call $emit_muldiv_m32 (i32.const 3))))))))
              (br $decode)))
          (br $decode)))

      ;; ---- 0xFE: Group 4 (INC/DEC r/m8) ----
      (if (i32.eq (local.get $op) (i32.const 0xFE))
        (then
          ;; Four Smacker decode paths contain the same complete Huffman walk.
          ;; It starts at this FE and ends 40 following bytes later. Execute
          ;; it through the bounded handler before considering the shorter
          ;; DEC/JNZ pair below.
          (if (i32.and
                (i32.and
                  (i32.eqz (global.get $code16))
                  (i32.and (i32.eqz (local.get $prefix_66))
                           (i32.eqz (local.get $prefix_67))))
                (i32.and
                  (i32.and (i32.eqz (local.get $prefix_rep))
                           (i32.eqz (local.get $prefix_seg)))
                  (call $match_smack_huff_walk)))
            (then
              (local.set $a (call $gl32 (i32.add (global.get $d_pc) (i32.const 1))))
              (local.set $imm (i32.sub (global.get $d_pc) (i32.const 1)))
              (global.set $d_pc (i32.add (global.get $d_pc) (i32.const 40)))
              (call $te (i32.const 395) (local.get $a))
              (call $te_raw (local.get $imm))
              (call $te_raw (global.get $d_pc))
              (local.set $done (i32.const 1))
              (br $decode)))
          ;; Exact unprefixed `FE 0D abs32 / 75 rel8`: Smacker's bit-count
          ;; refill loop. DEC defines the ZF consumed by JNZ, so this pair can
          ;; end the block in one handler while retaining every DEC flag.
          (if (i32.and
                (i32.and
                  (i32.eqz (global.get $code16))
                  (i32.and (i32.eqz (local.get $prefix_66))
                           (i32.eqz (local.get $prefix_67))))
                (i32.and
                  (i32.and (i32.eqz (local.get $prefix_rep))
                           (i32.eqz (local.get $prefix_seg)))
                  (i32.and
                    (i32.eq (call $gl8 (global.get $d_pc)) (i32.const 0x0D))
                    (i32.eq (call $gl8 (i32.add (global.get $d_pc) (i32.const 5)))
                            (i32.const 0x75)))))
            (then
              (local.set $a (call $gl32 (i32.add (global.get $d_pc) (i32.const 1))))
              (local.set $disp
                (call $sign_ext8
                  (call $gl8 (i32.add (global.get $d_pc) (i32.const 6)))))
              (global.set $d_pc (i32.add (global.get $d_pc) (i32.const 7)))
              (call $te (i32.const 393) (local.get $a))
              (call $te_raw (global.get $d_pc))
              (call $te_raw (call $branch_target (local.get $disp)))
              (local.set $done (i32.const 1))
              (br $decode)))
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_reg) (i32.const 0)) ;; INC r/m8
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 234) (global.get $mr_val)))
                (else (call $emit_unary_m8 (i32.const 0))))
              (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 1)) ;; DEC r/m8
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 235) (global.get $mr_val)))
                (else (call $emit_unary_m8 (i32.const 1))))
              (br $decode)))
          (br $decode)))
      ;; ---- 0xFF: Group 5 (INC/DEC/CALL/JMP/PUSH r/m32) ----
      (if (i32.eq (local.get $op) (i32.const 0xFF))
        (then
          (call $decode_modrm)
          ;; 0=INC, 1=DEC, 2=CALL, 3=CALL far, 4=JMP, 5=JMP far, 6=PUSH
          (if (i32.eq (global.get $mr_reg) (i32.const 0)) ;; INC r/m32 (or r/m16 with 66h)
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (if (local.get $prefix_66)
                  (then (call $te (i32.const 202) (global.get $mr_val)))
                  (else (call $te (i32.const 64) (global.get $mr_val)))))
                (else (if (local.get $prefix_66)
                  (then (call $emit_unary_m16 (i32.const 0)))
                  (else (call $emit_unary_m32 (i32.const 0))))))
              (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 1)) ;; DEC r/m32 (or r/m16 with 66h)
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (if (local.get $prefix_66)
                  (then (call $te (i32.const 203) (global.get $mr_val)))
                  (else (call $te (i32.const 65) (global.get $mr_val)))))
                (else (if (local.get $prefix_66)
                  (then (call $emit_unary_m16 (i32.const 1)))
                  (else (call $emit_unary_m32 (i32.const 1))))))
              (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 2)) ;; CALL r/m32 (r/m16 near in a 16-bit task)
            (then
              (if (global.get $code16)
                (then
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 379) (global.get $d_pc))
                          (call $te_raw (global.get $mr_val)))
                    (else
                      (local.set $a (call $emit_sib_or_abs))
                      (call $te (i32.const 380) (global.get $d_pc))
                      (call $te_raw (local.get $a))))
                  (local.set $done (i32.const 1)) (br $decode)))
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 119) (global.get $d_pc))
                      (call $te_raw (global.get $mr_val)))
                (else (call $emit_call_ind (global.get $d_pc))))
              (local.set $done (i32.const 1)) (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 3)) ;; CALL FAR m16:16
            (then
              (call $win16_only (local.get $op))
              (local.set $a (call $emit_sib_or_abs))
              (call $te (i32.const 369) (global.get $d_pc))
              (call $te_raw (local.get $a))
              (local.set $done (i32.const 1)) (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 4)) ;; JMP r/m32 (r/m16 near in a 16-bit task)
            (then
              (if (global.get $code16)
                (then
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 381) (global.get $mr_val)))
                    (else
                      (local.set $a (call $emit_sib_or_abs))
                      (call $te (i32.const 382) (i32.const 0))
                      (call $te_raw (local.get $a))))
                  (local.set $done (i32.const 1)) (br $decode)))
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 120) (global.get $mr_val)))
                (else (call $emit_jmp_ind)))
              (local.set $done (i32.const 1)) (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 5)) ;; JMP FAR m16:16
            (then
              (call $win16_only (local.get $op))
              (local.set $a (call $emit_sib_or_abs))
              (call $te (i32.const 370) (i32.const 0))
              (call $te_raw (local.get $a))
              (local.set $done (i32.const 1)) (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 6)) ;; PUSH r/m32 (or r/m16 with 66h)
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (if (local.get $prefix_66)
                  (then (call $te (i32.const 181) (global.get $mr_val)))
                  (else (call $te (i32.const 32) (global.get $mr_val)))))
                (else (if (local.get $prefix_66)
                  (then (call $emit_push_m16))
                  (else (call $emit_push_m32)))))
              (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 7)) ;; POP r/m32 (or r/m16 with 66h)
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (if (local.get $prefix_66)
                  (then (call $te (i32.const 182) (global.get $mr_val)))
                  (else (call $te (i32.const 33) (global.get $mr_val)))))
                (else (if (local.get $prefix_66)
                  (then (local.set $a (call $emit_sib_or_abs)) (call $te (i32.const 268) (i32.const 0)) (call $te_raw (local.get $a)))
                  (else (call $emit_pop_m32)))))
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
                (else (call $emit_shift_m8 (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (local.get $imm))))))
            (else (if (local.get $prefix_66)
              (then ;; 16-bit shifts
                (if (i32.eq (global.get $mr_mod) (i32.const 3))
                  (then (call $te (i32.const 193) (i32.or (global.get $mr_val) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16))))))
                  (else (call $emit_shift_m16 (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (local.get $imm))))))
              (else ;; 32-bit shifts
                (if (i32.eq (global.get $mr_mod) (i32.const 3))
                  (then (call $te (i32.const 53) (i32.or (global.get $mr_val) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16))))))
                  (else (call $emit_shift_m32 (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (local.get $imm)))))))))
          (br $decode)))

      ;; ---- 0xC0/0xC1: Shift group 2, imm8 ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0xC0)) (i32.eq (local.get $op) (i32.const 0xC1)))
        (then
          ;; Exact unprefixed `C1 ED 01 / 72|73 rel8`: SHR EBP,1 followed by
          ;; JB/JAE in Smacker's Huffman walkers. Both successors observe the
          ;; same shift flags, so the pair is safely block-ending.
          (if (i32.and
                (i32.eq (local.get $op) (i32.const 0xC1))
                (i32.and
                  (i32.and
                    (i32.eqz (global.get $code16))
                    (i32.and (i32.eqz (local.get $prefix_66))
                             (i32.eqz (local.get $prefix_67))))
                  (i32.and
                    (i32.and (i32.eqz (local.get $prefix_rep))
                             (i32.eqz (local.get $prefix_seg)))
                    (i32.and
                      (i32.and
                        (i32.eq (call $gl8 (global.get $d_pc)) (i32.const 0xED))
                        (i32.eq (call $gl8 (i32.add (global.get $d_pc) (i32.const 1)))
                                (i32.const 1)))
                      (i32.and
                        (i32.ge_u (call $gl8 (i32.add (global.get $d_pc) (i32.const 2)))
                                  (i32.const 0x72))
                        (i32.le_u (call $gl8 (i32.add (global.get $d_pc) (i32.const 2)))
                                  (i32.const 0x73)))))))
            (then
              (local.set $imm
                (call $gl8 (i32.add (global.get $d_pc) (i32.const 2))))
              (local.set $disp
                (call $sign_ext8
                  (call $gl8 (i32.add (global.get $d_pc) (i32.const 3)))))
              (global.set $d_pc (i32.add (global.get $d_pc) (i32.const 4)))
              (call $te (i32.const 394) (i32.sub (local.get $imm) (i32.const 0x72)))
              (call $te_raw (global.get $d_pc))
              (call $te_raw (call $branch_target (local.get $disp)))
              (local.set $done (i32.const 1))
              (br $decode)))
          (call $decode_modrm)
          (local.set $imm (call $d_fetch8))
          (if (i32.eq (local.get $op) (i32.const 0xC0))
            (then ;; 8-bit shift
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 191) (i32.or (global.get $mr_val) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16))))))
                (else (call $emit_shift_m8 (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (local.get $imm))))))
            (else (if (local.get $prefix_66)
              (then ;; 16-bit shift
                (if (i32.eq (global.get $mr_mod) (i32.const 3))
                  (then (call $te (i32.const 193) (i32.or (global.get $mr_val) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16))))))
                  (else (call $emit_shift_m16 (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (local.get $imm))))))
              (else ;; 32-bit shift
                (if (i32.eq (global.get $mr_mod) (i32.const 3))
                  (then (call $te (i32.const 53) (i32.or (global.get $mr_val) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16))))))
                  (else (call $emit_shift_m32 (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (local.get $imm)))))))))
          (br $decode)))

      ;; ---- PUSH imm32 (0x68) / PUSH imm8 (0x6A) ----
      ;; The immediate is fetched at the operand size, and so is the push: a
      ;; 16-bit PUSH moves ESP by two, not four. Handler 34 does the 32-bit
      ;; half, 385 the 16-bit one.
      (if (i32.eq (local.get $op) (i32.const 0x68))
        (then
          (if (local.get $prefix_66)
            (then (call $te (i32.const 385) (call $d_fetch16)))
            (else (call $te (i32.const 34) (i32.const 0)) (call $te_raw (call $d_fetch32))))
          (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0x6A))
        (then
          (local.set $imm (call $sign_ext8 (call $d_fetch8)))
          (if (local.get $prefix_66)
            (then (call $te (i32.const 385) (i32.and (local.get $imm) (i32.const 0xFFFF))))
            (else (call $te (i32.const 34) (i32.const 0)) (call $te_raw (local.get $imm))))
          (br $decode)))

      ;; ---- IMUL r32, r/m32, imm (0x69/0x6B) / IMUL r16, r/m16, imm with 66h ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0x69)) (i32.eq (local.get $op) (i32.const 0x6B)))
        (then
          (call $decode_modrm)
          (if (i32.eq (local.get $op) (i32.const 0x69))
            (then (if (local.get $prefix_66)
              (then (local.set $imm (call $d_fetch16)))
              (else (local.set $imm (call $d_fetch32)))))
            (else (local.set $imm (call $sign_ext8 (call $d_fetch8)))))
          (if (local.get $prefix_66)
            (then ;; 16-bit IMUL
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 251) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val)))
                      (call $te_raw (local.get $imm)))
                (else (call $emit_load16 (global.get $mr_reg))
                      (call $te (i32.const 251) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_reg)))
                      (call $te_raw (local.get $imm)))))
            (else ;; 32-bit IMUL
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 59) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val)))
                      (call $te_raw (local.get $imm)))
                (else (call $emit_load32 (global.get $mr_reg) (i32.const 0))
                      (call $te (i32.const 59) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_reg)))
                      (call $te_raw (local.get $imm))))))
          (br $decode)))

      ;; ---- CALL rel32 (0xE8) / CALL rel16 with 66h ----
      (if (i32.eq (local.get $op) (i32.const 0xE8))
        (then
          (if (local.get $prefix_66)
            (then
              (local.set $disp (call $d_fetch16))
              ;; Sign-extend 16-bit displacement
              (if (i32.ge_u (local.get $disp) (i32.const 0x8000))
                (then (local.set $disp (i32.or (local.get $disp) (i32.const 0xFFFF0000)))))
              (call $te (i32.const 266) (global.get $d_pc))
              ;; A 16-bit task needs the linear target, since that is what EIP
              ;; is; flat 32-bit code that took a 0x66 prefix here has always
              ;; truncated, and is left alone.
              (if (global.get $code16)
                (then (call $te_raw (call $branch_target (local.get $disp))))
                (else (call $te_raw (i32.and (call $branch_target (local.get $disp)) (i32.const 0xFFFF))))))
            (else
              (local.set $disp (call $d_fetch32))
              (call $te (i32.const 39) (global.get $d_pc))
              (call $te_raw (call $branch_target (local.get $disp)))))
          (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- RET (0xC3) / RET imm16 (0xC2) ----
      ;; A near return in a 16-bit segment pops IP, not a linear address, so
      ;; the address has to be rebuilt from the CS base.
      (if (i32.eq (local.get $op) (i32.const 0xC3))
        (then (call $te (if (result i32) (global.get $code16) (then (i32.const 365)) (else (i32.const 41))) (i32.const 0))
              (local.set $done (i32.const 1)) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xC2))
        (then (call $te (if (result i32) (global.get $code16) (then (i32.const 366)) (else (i32.const 42))) (call $d_fetch16))
              (local.set $done (i32.const 1)) (br $decode)))
      ;; ---- RETF (0xCB) / RETF imm16 (0xCA) ----
      (if (i32.eq (local.get $op) (i32.const 0xCB))
        (then (call $win16_only (local.get $op))
              (call $te (i32.const 371) (i32.const 0)) (local.set $done (i32.const 1)) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xCA))
        (then (call $win16_only (local.get $op))
              (call $te (i32.const 371) (call $d_fetch16)) (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- JMP rel8 (0xEB) / JMP rel32 (0xE9) ----
      (if (i32.eq (local.get $op) (i32.const 0xEB))
        (then (local.set $disp (call $sign_ext8 (call $d_fetch8)))
              (call $te (i32.const 43) (i32.const 0)) (call $te_raw (call $branch_target (local.get $disp)))
              (local.set $done (i32.const 1)) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xE9))
        ;; JMP rel is rel16 in a 16-bit segment. Flat 32-bit code that takes a
        ;; 0x66 prefix here keeps reading rel32 as it always has — correcting
        ;; that is a separate change with its own blast radius.
        (then (local.set $disp
                (if (result i32) (global.get $code16)
                  (then (call $sign_ext16 (call $d_fetch16)))
                  (else (call $d_fetch32))))
              (call $te (i32.const 43) (i32.const 0)) (call $te_raw (call $branch_target (local.get $disp)))
              (local.set $done (i32.const 1)) (br $decode)))
      ;; ---- JMP far (0xEA ptr16:32) ----
      ;; Flat-mode emulation: ignore the selector, treat as near JMP to offset.
      (if (i32.eq (local.get $op) (i32.const 0xEA))
        (then
          (if (global.get $code16)
            (then
              (local.set $disp (call $d_fetch16))  ;; offset
              (local.set $imm (call $d_fetch16))   ;; selector
              (call $te (i32.const 368) (i32.const 0))
              (call $te_raw (local.get $disp))
              (call $te_raw (local.get $imm))
              (local.set $done (i32.const 1)) (br $decode)))
          (local.set $disp (call $d_fetch32))   ;; offset
          (drop (call $d_fetch16))              ;; selector — ignored
          (call $te (i32.const 43) (i32.const 0))
          (call $te_raw (local.get $disp))
          (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- Jcc rel8 (0x70-0x7F) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x70)) (i32.le_u (local.get $op) (i32.const 0x7F)))
        (then
          (local.set $disp (call $sign_ext8 (call $d_fetch8)))
          (call $te
            (i32.add (i32.const 307) (i32.and (local.get $op) (i32.const 0xF)))
            (i32.const 0))
          (call $te_raw (global.get $d_pc)) ;; fall-through
          (call $te_raw (call $branch_target (local.get $disp))) ;; target
          (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- LOOP/LOOPE/LOOPNE (0xE0-0xE2) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0xE0)) (i32.le_u (local.get $op) (i32.const 0xE2)))
        (then
          (local.set $disp (call $sign_ext8 (call $d_fetch8)))
          ;; E2=LOOP, E1=LOOPE, E0=LOOPNE
          (local.set $imm (i32.sub (i32.const 0xE2) (local.get $op))) ;; 0=LOOP, 1=LOOPE, 2=LOOPNE
          ;; bit 4 = addr16 (0x67 prefix): use CX instead of ECX as counter
          (if (local.get $prefix_67) (then (local.set $imm (i32.or (local.get $imm) (i32.const 0x10)))))
          (call $te (i32.const 46) (local.get $imm))
          (call $te_raw (call $branch_target (local.get $disp)))
          (call $te_raw (global.get $d_pc))
          (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- JECXZ (0xE3) ----
      (if (i32.eq (local.get $op) (i32.const 0xE3))
        (then
          (local.set $disp (call $sign_ext8 (call $d_fetch8)))
          ;; bit 0 = addr16 (0x67 prefix → JCXZ tests CX instead of ECX)
          (call $te (i32.const 216) (if (result i32) (local.get $prefix_67) (then (i32.const 1)) (else (i32.const 0))))
          (call $te_raw (call $branch_target (local.get $disp)))
          (call $te_raw (global.get $d_pc))
          (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- String ops ----
      ;; These handlers treat ESI and EDI as linear addresses. In a 16-bit task
      ;; they are DS:SI and ES:DI, so every one of them would read and write
      ;; somewhere plausible and wrong. Refuse until they have segmented forms,
      ;; rather than let a REP MOVSW quietly scribble over the arena.
      ;; XLAT is here for the same reason: it reads DS:BX+AL.
      (if (i32.and (global.get $code16)
                   (i32.or
                     (i32.eq (local.get $op) (i32.const 0xD7))
                     (i32.or
                       (i32.and (i32.ge_u (local.get $op) (i32.const 0xA4)) (i32.le_u (local.get $op) (i32.const 0xA7)))
                       (i32.and (i32.ge_u (local.get $op) (i32.const 0xAA)) (i32.le_u (local.get $op) (i32.const 0xAF))))))
        (then
          ;; XLAT reads DS:BX+AL and is the same segment question, so it shares
          ;; the override handling and nothing else.
          (global.set $mr_seg (i32.const 3))
          (call $modrm16_apply_seg)
          (if (i32.eq (local.get $op) (i32.const 0xD7))
            (then (call $te (i32.const 387) (global.get $mr_seg)) (br $decode)))
          ;; size: the B forms are 1, the others follow the operand size, which
          ;; $code16 has already inverted to 16-bit unless a real 0x66 asks
          ;; otherwise. kind is fixed by the opcode; repeat comes from F3/F2.
          (call $te (i32.const 386) (i32.or
            (i32.or
              (if (result i32) (i32.and (local.get $op) (i32.const 1))
                (then (select (i32.const 2) (i32.const 4) (local.get $prefix_66)))
                (else (i32.const 1)))
              (i32.shl
                (if (result i32) (i32.lt_u (local.get $op) (i32.const 0xA8))
                  (then (select (i32.const 3) (i32.const 0)
                                (i32.ge_u (local.get $op) (i32.const 0xA6))))
                  (else (if (result i32) (i32.lt_u (local.get $op) (i32.const 0xAC))
                    (then (i32.const 1))
                    (else (select (i32.const 4) (i32.const 2)
                                  (i32.ge_u (local.get $op) (i32.const 0xAE)))))))
                (i32.const 4)))
            (i32.or
              (i32.shl (local.get $prefix_rep) (i32.const 8))
              (i32.shl (global.get $mr_seg) (i32.const 12)))))
          (br $decode)))
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
      (if (i32.eq (local.get $op) (i32.const 0xA7)) ;; CMPSD / CMPSW with 66h
        (then (if (local.get $prefix_66)
          (then (if (local.get $prefix_rep) (then (call $te (i32.const 248) (i32.sub (local.get $prefix_rep) (i32.const 1)))) (else (call $te (i32.const 247) (i32.const 0)))))
          (else (if (local.get $prefix_rep) (then (call $te (i32.const 169) (i32.sub (local.get $prefix_rep) (i32.const 1)))) (else (call $te (i32.const 171) (i32.const 0))))))
          (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xAE)) ;; SCASB
        (then (if (local.get $prefix_rep) (then (call $te (i32.const 93) (i32.sub (local.get $prefix_rep) (i32.const 1)))) (else (call $te (i32.const 95) (i32.const 0)))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xAF)) ;; SCASD / SCASW with 66h
        (then (if (local.get $prefix_66)
          (then (if (local.get $prefix_rep) (then (call $te (i32.const 250) (i32.sub (local.get $prefix_rep) (i32.const 1)))) (else (call $te (i32.const 249) (i32.const 0)))))
          (else (if (local.get $prefix_rep) (then (call $te (i32.const 170) (i32.sub (local.get $prefix_rep) (i32.const 1)))) (else (call $te (i32.const 172) (i32.const 0))))))
          (br $decode)))

      ;; ---- Misc single-byte ----
      (if (i32.eq (local.get $op) (i32.const 0x60)) (then (call $te (i32.const 35) (i32.const 0)) (br $decode))) ;; PUSHAD
      (if (i32.eq (local.get $op) (i32.const 0x61)) (then (call $te (i32.const 36) (i32.const 0)) (br $decode))) ;; POPAD
      (if (i32.eq (local.get $op) (i32.const 0x9C)) ;; PUSHFD / PUSHF with 66h
        (then (if (local.get $prefix_66)
          (then (call $te (i32.const 253) (i32.const 0)))
          (else (call $te (i32.const 37) (i32.const 0))))
          (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0x9D)) ;; POPFD / POPF with 66h
        (then (if (local.get $prefix_66)
          (then (call $te (i32.const 254) (i32.const 0)))
          (else (call $te (i32.const 38) (i32.const 0))))
          (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0x9E)) (then (call $te (i32.const 212) (i32.const 0)) (br $decode))) ;; SAHF
      (if (i32.eq (local.get $op) (i32.const 0x9F)) (then (call $te (i32.const 213) (i32.const 0)) (br $decode))) ;; LAHF
      (if (i32.eq (local.get $op) (i32.const 0xD4)) (then (call $te (i32.const 397) (call $d_fetch8)) (br $decode))) ;; AAM imm8
      (if (i32.eq (local.get $op) (i32.const 0xD7)) (then (call $te (i32.const 280) (i32.const 0)) (br $decode))) ;; XLAT
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
      ;; IN/OUT accumulator forms. Immediate-port opcodes E4..E7 carry the
      ;; port in bits 8..15; EC..EF read DX at execution time. Bit 16 records
      ;; the operand-size override for AX versus EAX.
      (if (i32.and
            (i32.ge_u (local.get $op) (i32.const 0xE4))
            (i32.le_u (local.get $op) (i32.const 0xEF)))
        (then
          (if (i32.or
                (i32.lt_u (local.get $op) (i32.const 0xE8))
                (i32.ge_u (local.get $op) (i32.const 0xEC)))
            (then
              (local.set $imm
                (i32.or
                  (local.get $op)
                  (i32.shl (local.get $prefix_66) (i32.const 16))))
              (if (i32.lt_u (local.get $op) (i32.const 0xE8))
                (then
                  (local.set $imm
                    (i32.or
                      (local.get $imm)
                      (i32.shl (call $d_fetch8) (i32.const 8))))))
              (call $te (i32.const 398) (local.get $imm))
              (br $decode)))))
      ;; ---- 0xC8: ENTER imm16, imm8 ----
      ;; The standard 16-bit compiled prologue. A non-zero nesting level would
      ;; additionally copy the display, which no compiler of this era emits and
      ;; which is better refused than approximated.
      (if (i32.eq (local.get $op) (i32.const 0xC8))
        (then
          (local.set $imm (call $d_fetch16))
          (local.set $disp (call $d_fetch8))
          (if (local.get $disp)
            (then
              (call $host_log_i32 (i32.const 0xCA165E0C)) ;; ENTER with nesting level
              (call $host_log_i32 (global.get $d_pc))
              (unreachable)))
          (call $te
            (if (result i32) (global.get $code16)
              (then (i32.const 383))
              (else (i32.const 399)))
            (local.get $imm))
          (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xC9))
        (then (call $te (if (result i32) (global.get $code16) (then (i32.const 384)) (else (i32.const 113)))
                (i32.const 0))
              (br $decode))) ;; LEAVE
      (if (i32.eq (local.get $op) (i32.const 0xCC)) (then (call $te (i32.const 45) (global.get $d_pc)) (local.set $done (i32.const 1)) (br $decode))) ;; INT3
      ;; INT imm8. The number matters — a 16-bit task reaches DOS through INT
      ;; 21h for everything the Windows API does not cover, and Klotski and
      ;; Chess both read their data files that way — so it is kept as the
      ;; operand and the resume address follows it, which is what $th_block_end
      ;; would have carried on its own.
      (if (i32.eq (local.get $op) (i32.const 0xCD))
        (then (call $te (i32.const 388) (call $d_fetch8))
              (call $te_raw (global.get $d_pc))
              (local.set $done (i32.const 1)) (br $decode))) ;; INT imm8
      (if (i32.eq (local.get $op) (i32.const 0xF4)) (then (call $te (i32.const 45) (global.get $d_pc)) (local.set $done (i32.const 1)) (br $decode))) ;; HLT
      ;; CLI/STI — ignore (no interrupt emulation)
      (if (i32.eq (local.get $op) (i32.const 0xFA)) (then (call $te (i32.const 0) (i32.const 0)) (br $decode))) ;; CLI
      (if (i32.eq (local.get $op) (i32.const 0xFB)) (then (call $te (i32.const 0) (i32.const 0)) (br $decode))) ;; STI

      ;; ---- 0x8F: POP r/m32 (/0) ----
      (if (i32.eq (local.get $op) (i32.const 0x8F))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then
              (if (local.get $prefix_66)
                (then (call $te (i32.const 182) (global.get $mr_val)))
                (else (call $te (i32.const 33) (global.get $mr_val)))))
            (else
              (if (local.get $prefix_66)
                (then (local.set $a (call $emit_sib_or_abs)) (call $te (i32.const 268) (i32.const 0)) (call $te_raw (local.get $a)))
                (else (call $emit_pop_m32)))))
          (br $decode)))

      ;; ---- 0x0F: Two-byte opcodes ----
      (if (i32.eq (local.get $op) (i32.const 0x0F))
        (then
          (local.set $op (call $d_fetch8))

          ;; 0x0F 0x02: LAR r16/32, r/m16. The source is always a selector
          ;; word; prefix_66 (already inverted for a 16-bit code segment)
          ;; selects the destination width.
          (if (i32.eq (local.get $op) (i32.const 0x02))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then
                  (call $te (i32.const 442)
                    (i32.or
                      (i32.shl (local.get $prefix_66) (i32.const 9))
                      (i32.or (i32.shl (global.get $mr_reg) (i32.const 4))
                              (global.get $mr_val)))))
                (else
                  (call $apply_seg_override)
                  (local.set $a (call $emit_sib_or_abs))
                  (call $te (i32.const 442)
                    (i32.or (i32.const 0x100)
                      (i32.or
                        (i32.shl (local.get $prefix_66) (i32.const 9))
                        (i32.shl (global.get $mr_reg) (i32.const 4)))))
                  (call $te_raw (local.get $a))))
              (br $decode)))

          ;; 0x0F 0xB4: LFS r16, m16:16. The WinG runtime distributed on the
          ;; Civilization II CD uses this to walk a far bitmap pointer. FS is
          ;; a normal protected-mode data selector here, not Win32's TIB.
          (if (i32.and (global.get $code16)
                       (i32.eq (local.get $op) (i32.const 0xB4)))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then
                  (call $host_log_i32 (i32.const 0x0FB4))
                  (call $host_log_i32 (i32.const 0xBADC0DE0))
                  (unreachable)))
              (local.set $a (call $emit_sib_or_abs))
              (call $te (i32.const 376)
                (i32.or (i32.const 0x40) (global.get $mr_reg)))
              (call $te_raw (local.get $a))
              (br $decode)))

          ;; 0x0F 0x40-0x4F: CMOVcc r32, r/m32 (or r16 with 66h)
          (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x40)) (i32.le_u (local.get $op) (i32.const 0x4F)))
            (then
              (call $decode_modrm)
              (if (local.get $prefix_66)
                (then ;; 16-bit CMOVcc
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 256)
                          (i32.or (i32.shl (i32.and (local.get $op) (i32.const 0xF)) (i32.const 8))
                            (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val)))))
                    (else (call $apply_seg_override)
                          (local.set $a (call $emit_sib_or_abs))
                          (call $te (i32.const 257)
                            (i32.or (i32.shl (i32.and (local.get $op) (i32.const 0xF)) (i32.const 4))
                                    (global.get $mr_reg)))
                          (call $te_raw (local.get $a)))))
                (else ;; 32-bit CMOVcc
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 221)
                          (i32.or (i32.shl (i32.and (local.get $op) (i32.const 0xF)) (i32.const 8))
                            (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val)))))
                    (else (call $apply_seg_override)
                          (local.set $a (call $emit_sib_or_abs))
                          (call $te (i32.const 222)
                            (i32.or (i32.shl (i32.and (local.get $op) (i32.const 0xF)) (i32.const 4))
                                    (global.get $mr_reg)))
                          (call $te_raw (local.get $a))))))
              (br $decode)))

          ;; 0x0F 0x80-0x8F: Jcc rel32, or rel16 in a 16-bit segment
          (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x80)) (i32.le_u (local.get $op) (i32.const 0x8F)))
            (then
              (local.set $disp
                (if (result i32) (global.get $code16)
                  (then (call $sign_ext16 (call $d_fetch16)))
                  (else (call $d_fetch32))))
              (call $te
                (i32.add (i32.const 307) (i32.and (local.get $op) (i32.const 0xF)))
                (i32.const 0))
              (call $te_raw (global.get $d_pc))
              (call $te_raw (call $branch_target (local.get $disp)))
              (local.set $done (i32.const 1)) (br $decode)))

          ;; 0x0F 0x90-0x9F: SETcc r/m8
          (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x90)) (i32.le_u (local.get $op) (i32.const 0x9F)))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then
                  (call $te (i32.const 102) (i32.and (local.get $op) (i32.const 0xF)))
                  (call $te_raw (global.get $mr_val)))
                (else
                  (call $apply_seg_override)
                  (if (call $mr_simple_base)
                    (then
                      ;; SETcc [base+disp] — handler 218, op=(cc<<4)|base, disp in next word
                      (call $te (i32.const 218)
                            (i32.or (i32.shl (i32.and (local.get $op) (i32.const 0xF)) (i32.const 4))
                                    (global.get $mr_base)))
                      (call $te_raw (global.get $mr_disp)))
                    (else
                      ;; SETcc [absolute] or SIB — handler 211, op=cc, addr (or sentinel) in next word
                      (local.set $a (call $emit_sib_or_abs))
                      (call $te (i32.const 211) (i32.and (local.get $op) (i32.const 0xF)))
                      (call $te_raw (local.get $a))))))
              (br $decode)))

          ;; 0x0F 0xA3: BT r/m32, r32 (or r/m16, r16 with 66h)
          (if (i32.eq (local.get $op) (i32.const 0xA3))
            (then (call $decode_modrm)
              (if (local.get $prefix_66)
                (then
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 295) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
                    (else (call $apply_seg_override)
                          (local.set $a (call $emit_sib_or_abs))
                          (call $te (i32.const 303) (global.get $mr_reg))
                          (call $te_raw (local.get $a)))))
                (else
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 198) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
                    (else (call $apply_seg_override)
                          (local.set $a (call $emit_sib_or_abs))
                          (call $te (i32.const 227) (global.get $mr_reg))
                          (call $te_raw (local.get $a))))))
              (br $decode)))
          ;; 0x0F 0xAB: BTS r/m32, r32 (or r/m16, r16 with 66h)
          (if (i32.eq (local.get $op) (i32.const 0xAB))
            (then (call $decode_modrm)
              (if (local.get $prefix_66)
                (then
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 296) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
                    (else (call $apply_seg_override)
                          (local.set $a (call $emit_sib_or_abs))
                          (call $te (i32.const 304) (global.get $mr_reg))
                          (call $te_raw (local.get $a)))))
                (else
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 199) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
                    (else (call $apply_seg_override)
                          (local.set $a (call $emit_sib_or_abs))
                          (call $te (i32.const 228) (global.get $mr_reg))
                          (call $te_raw (local.get $a))))))
              (br $decode)))
          ;; 0x0F 0xB3: BTR r/m32, r32 (or r/m16, r16 with 66h)
          (if (i32.eq (local.get $op) (i32.const 0xB3))
            (then (call $decode_modrm)
              (if (local.get $prefix_66)
                (then
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 297) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
                    (else (call $apply_seg_override)
                          (local.set $a (call $emit_sib_or_abs))
                          (call $te (i32.const 305) (global.get $mr_reg))
                          (call $te_raw (local.get $a)))))
                (else
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 200) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
                    (else (call $apply_seg_override)
                          (local.set $a (call $emit_sib_or_abs))
                          (call $te (i32.const 229) (global.get $mr_reg))
                          (call $te_raw (local.get $a))))))
              (br $decode)))
          ;; 0x0F 0xBB: BTC r/m32, r32 (or r/m16, r16 with 66h)
          (if (i32.eq (local.get $op) (i32.const 0xBB))
            (then (call $decode_modrm)
              (if (local.get $prefix_66)
                (then
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 298) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
                    (else (call $apply_seg_override)
                          (local.set $a (call $emit_sib_or_abs))
                          (call $te (i32.const 306) (global.get $mr_reg))
                          (call $te_raw (local.get $a)))))
                (else
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 201) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
                    (else (call $apply_seg_override)
                          (local.set $a (call $emit_sib_or_abs))
                          (call $te (i32.const 230) (global.get $mr_reg))
                          (call $te_raw (local.get $a))))))
              (br $decode)))

          ;; 0x0F 0xAF: IMUL r32, r/m32 (or r16, r/m16 with 66h)
          (if (i32.eq (local.get $op) (i32.const 175))
            (then
              (call $decode_modrm)
              (if (local.get $prefix_66)
                (then
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then
                      (call $te (i32.const 288) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val)))
                      (call $te (i32.const 45) (global.get $d_pc))
                      (local.set $done (i32.const 1)) (br $decode))
                    (else (call $apply_seg_override)
                      (if (call $mr_simple_base)
                        (then
                          (call $te (i32.const 290) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_base)))
                          (call $te_raw (global.get $mr_disp))
                          (call $te (i32.const 45) (global.get $d_pc))
                          (local.set $done (i32.const 1)) (br $decode))
                        (else (local.set $imm (call $emit_sib_or_abs))
                              (call $te (i32.const 289) (global.get $mr_reg))
                              (call $te_raw (local.get $imm))
                              (call $te (i32.const 45) (global.get $d_pc))
                              (local.set $done (i32.const 1)) (br $decode))))))
                (else
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then
                      (call $te (i32.const 118) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val)))
                      (call $te (i32.const 45) (global.get $d_pc))
                      (local.set $done (i32.const 1)) (br $decode))
                    (else ;; imul reg, [mem] — dedicated opcodes to avoid clobbering dst
                      (if (call $mr_simple_base)
                        (then
                          (call $te (i32.const 157) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_base)))
                          (call $te_raw (global.get $mr_disp))
                          (call $te (i32.const 45) (global.get $d_pc))
                          (local.set $done (i32.const 1)) (br $decode))
                        (else (local.set $imm (call $emit_sib_or_abs))
                              (call $te (i32.const 158) (global.get $mr_reg))
                              (call $te_raw (local.get $imm))
                              (call $te (i32.const 45) (global.get $d_pc))
                              (local.set $done (i32.const 1)) (br $decode)))))))))

          ;; 0x0F 0xB6: MOVZX r32, r/m8 (with 66h → r16, low half only)
          (if (i32.eq (local.get $op) (i32.const 0xB6))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then ;; movzx r32, reg8 — handler 208 (412 for the 16-bit form)
                  (call $te (if (result i32) (local.get $prefix_66)
                              (then (i32.const 412)) (else (i32.const 208)))
                            (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                (else (call $emit_movzx8 (global.get $mr_reg) (local.get $prefix_66))))
              (br $decode)))

          ;; 0x0F 0xB7: MOVZX r32, r/m16 (with 66h it degenerates to mov r16, r16)
          (if (i32.eq (local.get $op) (i32.const 0xB7))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (if (result i32) (local.get $prefix_66)
                                   (then (i32.const 210)) (else (i32.const 357)))
                  (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                (else (call $emit_movzx16 (global.get $mr_reg) (local.get $prefix_66))))
              (br $decode)))

          ;; 0x0F 0xBE: MOVSX r32, r/m8
          (if (i32.eq (local.get $op) (i32.const 0xBE))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then ;; movsx r32, reg8 — handler 209 (413 for the 16-bit form)
                  (call $te (if (result i32) (local.get $prefix_66)
                              (then (i32.const 413)) (else (i32.const 209)))
                            (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                (else (call $emit_movsx8 (global.get $mr_reg) (local.get $prefix_66))))
              (br $decode)))

          ;; 0x0F 0xBF: MOVSX r32, r/m16
          (if (i32.eq (local.get $op) (i32.const 0xBF))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (if (result i32) (local.get $prefix_66)
                                   (then (i32.const 210)) (else (i32.const 358)))
                  (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                (else (call $emit_movsx16 (global.get $mr_reg) (local.get $prefix_66))))
              (br $decode)))

          ;; 0x0F 0xA4/0xA5: SHLD, 0x0F 0xAC/0xAD: SHRD (with 66h → 16-bit)
          (if (i32.or (i32.eq (local.get $op) (i32.const 0xA4)) (i32.eq (local.get $op) (i32.const 0xA5)))
            (then
              (call $decode_modrm)
              (if (i32.eq (local.get $op) (i32.const 0xA4))
                (then (local.set $imm (call $d_fetch8)))
                (else (local.set $imm (i32.and (global.get $ecx) (i32.const 31)))))
              (if (local.get $prefix_66)
                (then ;; 16-bit SHLD
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 258) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))
                          (call $te_raw (local.get $imm)))
                    (else (call $apply_seg_override)
                          (local.set $a (call $emit_sib_or_abs))
                          (call $te (i32.const 260) (global.get $mr_reg))
                          (call $te_raw (local.get $a))
                          (call $te_raw (local.get $imm)))))
                (else ;; 32-bit SHLD
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 103) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))
                          (call $te_raw (local.get $imm)))
                    (else (call $apply_seg_override)
                          (local.set $a (call $emit_sib_or_abs))
                          (call $te (i32.const 223) (global.get $mr_reg))
                          (call $te_raw (local.get $a))
                          (call $te_raw (local.get $imm))))))
              (br $decode)))
          (if (i32.or (i32.eq (local.get $op) (i32.const 0xAC)) (i32.eq (local.get $op) (i32.const 0xAD)))
            (then
              (call $decode_modrm)
              (if (i32.eq (local.get $op) (i32.const 0xAC))
                (then (local.set $imm (call $d_fetch8)))
                (else (local.set $imm (i32.and (global.get $ecx) (i32.const 31)))))
              (if (local.get $prefix_66)
                (then ;; 16-bit SHRD
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 259) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))
                          (call $te_raw (local.get $imm)))
                    (else (call $apply_seg_override)
                          (local.set $a (call $emit_sib_or_abs))
                          (call $te (i32.const 261) (global.get $mr_reg))
                          (call $te_raw (local.get $a))
                          (call $te_raw (local.get $imm)))))
                (else ;; 32-bit SHRD
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 104) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))
                          (call $te_raw (local.get $imm)))
                    (else (call $apply_seg_override)
                          (local.set $a (call $emit_sib_or_abs))
                          (call $te (i32.const 224) (global.get $mr_reg))
                          (call $te_raw (local.get $a))
                          (call $te_raw (local.get $imm))))))
              (br $decode)))

          ;; 0x0F 0xBA: BT/BTS/BTR/BTC r/m32, imm8 (or r/m16 with 66h)
          (if (i32.eq (local.get $op) (i32.const 0xBA))
            (then
              (call $decode_modrm)
              (local.set $imm (call $d_fetch8))
              ;; mr_reg: 4=BT, 5=BTS, 6=BTR, 7=BTC
              (if (local.get $prefix_66)
                (then
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then
                      (call $te (i32.add (i32.const 287) (global.get $mr_reg)) (global.get $mr_val)) ;; 291-294
                      (call $te_raw (local.get $imm)))
                    (else
                      (call $apply_seg_override)
                      (local.set $a (call $emit_sib_or_abs))
                      (call $te (i32.add (i32.const 295) (global.get $mr_reg)) (i32.const 0)) ;; 299-302
                      (call $te_raw (local.get $a))
                      (call $te_raw (local.get $imm)))))
                (else
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then
                      (call $te (i32.add (i32.const 92) (global.get $mr_reg)) (global.get $mr_val)) ;; 96-99
                      (call $te_raw (local.get $imm)))
                    (else
                      ;; Memory BT/BTS/BTR/BTC: mr_reg 4=BT,5=BTS,6=BTR,7=BTC -> handler 176-179
                      (local.set $a (call $emit_sib_or_abs))
                      (call $te (i32.add (i32.const 172) (global.get $mr_reg)) (i32.const 0))
                      (call $te_raw (local.get $a))
                      (call $te_raw (local.get $imm))))))
              (br $decode)))

          ;; 0x0F 0xBC: BSF, 0x0F 0xBD: BSR (with 66h → 16-bit)
          (if (i32.eq (local.get $op) (i32.const 0xBC))
            (then (call $decode_modrm)
              (if (local.get $prefix_66)
                (then (if (i32.eq (global.get $mr_mod) (i32.const 3))
                  (then (call $te (i32.const 262) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                  (else (call $apply_seg_override)
                        (local.set $a (call $emit_sib_or_abs))
                        (call $te (i32.const 264) (global.get $mr_reg))
                        (call $te_raw (local.get $a)))))
                (else (if (i32.eq (global.get $mr_mod) (i32.const 3))
                  (then (call $te (i32.const 100) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                  (else (call $apply_seg_override)
                        (local.set $a (call $emit_sib_or_abs))
                        (call $te (i32.const 225) (global.get $mr_reg))
                        (call $te_raw (local.get $a))))))
              (br $decode)))
          (if (i32.eq (local.get $op) (i32.const 0xBD))
            (then (call $decode_modrm)
              (if (local.get $prefix_66)
                (then (if (i32.eq (global.get $mr_mod) (i32.const 3))
                  (then (call $te (i32.const 263) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                  (else (call $apply_seg_override)
                        (local.set $a (call $emit_sib_or_abs))
                        (call $te (i32.const 265) (global.get $mr_reg))
                        (call $te_raw (local.get $a)))))
                (else (if (i32.eq (global.get $mr_mod) (i32.const 3))
                  (then (call $te (i32.const 101) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                  (else (call $apply_seg_override)
                        (local.set $a (call $emit_sib_or_abs))
                        (call $te (i32.const 226) (global.get $mr_reg))
                        (call $te_raw (local.get $a))))))
              (br $decode)))

          ;; 0x0F 0xC8-0xCF: BSWAP reg
          (if (i32.and (i32.ge_u (local.get $op) (i32.const 0xC8)) (i32.le_u (local.get $op) (i32.const 0xCF)))
            (then (call $te (i32.const 115) (i32.sub (local.get $op) (i32.const 0xC8))) (br $decode)))

          ;; 0x0F 0x18 /0-/3: PREFETCHNTA/T0/T1/T2. These are explicitly
          ;; non-faulting cache hints, so the guest-visible operation is a NOP.
          ;; decode_modrm still has to consume any SIB and displacement bytes;
          ;; otherwise the following byte is decoded as a new instruction.
          (if (i32.eq (local.get $op) (i32.const 0x18))
            (then (call $decode_modrm) (call $te (i32.const 0) (i32.const 0)) (br $decode)))

          ;; 0x0F 0x1F: multi-byte NOP (NOP r/m32)
          (if (i32.eq (local.get $op) (i32.const 0x1F))
            (then (call $decode_modrm) (call $te (i32.const 0) (i32.const 0)) (br $decode)))

          ;; 0x0F 0x31: RDTSC — real monotonic counter (see $th_rdtsc)
          (if (i32.eq (local.get $op) (i32.const 0x31))
            (then (call $te (i32.const 426) (i32.const 0)) (br $decode)))

          ;; 0x0F 0x77: EMMS
          (if (i32.eq (local.get $op) (i32.const 0x77))
            (then (call $te (i32.const 233) (i32.const 0)) (br $decode)))

          ;; 0x0F 0xB0: CMPXCHG r/m8, r8
          (if (i32.eq (local.get $op) (i32.const 0xB0))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 252) (i32.or (i32.const 0x80) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))
                (else (local.set $a (call $emit_sib_or_abs)) (call $te (i32.const 252) (global.get $mr_reg)) (call $te_raw (local.get $a))))
              (br $decode)))

          ;; 0x0F 0xB1: CMPXCHG r/m32, r32 (or r/m16, r16 with 66h)
          (if (i32.eq (local.get $op) (i32.const 0xB1))
            (then
              (call $decode_modrm)
              (if (local.get $prefix_66)
                (then
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 277) (i32.or (i32.const 0x80) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))
                    (else (local.set $a (call $emit_sib_or_abs)) (call $te (i32.const 277) (global.get $mr_reg)) (call $te_raw (local.get $a)))))
                (else
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 173) (i32.or (i32.const 0x80) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))
                    (else (local.set $a (call $emit_sib_or_abs)) (call $te (i32.const 173) (global.get $mr_reg)) (call $te_raw (local.get $a))))))
              (br $decode)))

          ;; 0x0F 0xC1: XADD r/m32, r32 (or r/m16, r16 with 66h)
          (if (i32.eq (local.get $op) (i32.const 0xC1))
            (then
              (call $decode_modrm)
              (if (local.get $prefix_66)
                (then
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 278) (i32.or (i32.const 0x80) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))
                    (else (local.set $a (call $emit_sib_or_abs)) (call $te (i32.const 278) (global.get $mr_reg)) (call $te_raw (local.get $a)))))
                (else
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then (call $te (i32.const 174) (i32.or (i32.const 0x80) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))
                    (else (local.set $a (call $emit_sib_or_abs)) (call $te (i32.const 174) (global.get $mr_reg)) (call $te_raw (local.get $a))))))
              (br $decode)))

          ;; 0x0F 0xC7: CMPXCHG8B m64 (ModRM reg field must be 1)
          (if (i32.eq (local.get $op) (i32.const 0xC7))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_reg) (i32.const 1))
                (then (local.set $a (call $emit_sib_or_abs)) (call $te (i32.const 195) (i32.const 0)) (call $te_raw (local.get $a))))
              (br $decode)))

          ;; 0x0F 0xA2: CPUID
          (if (i32.eq (local.get $op) (i32.const 0xA2))
            (then (call $te (i32.const 175) (i32.const 0)) (br $decode)))

          ;; ---- 0x0F 0xA0/0xA8: PUSH FS/GS, 0x0F 0xA1/0xA9: POP FS/GS ----
          ;; The one-byte segment pushes (06/0E/16/1E) were handled but not
          ;; these. Allegro's bank-switched bitmap code saves FS alongside ES
          ;; at the top of its inner loops, so every Allegro game reached this
          ;; and stopped. Flat mode: the selector is decorative, but the stack
          ;; width is not, and 66h makes it a 2-byte push.
          (if (i32.or (i32.eq (local.get $op) (i32.const 0xA0))
                      (i32.eq (local.get $op) (i32.const 0xA8)))
            (then
              (local.set $imm (select (i32.const 0x00) (i32.const 0x3B)
                                (i32.eq (local.get $op) (i32.const 0xA8))))  ;; GS : FS
              (if (local.get $prefix_66)
                (then (local.set $imm (i32.or (local.get $imm) (i32.const 0x10000)))))
              (call $te (i32.const 359) (local.get $imm))
              (br $decode)))
          (if (i32.or (i32.eq (local.get $op) (i32.const 0xA1))
                      (i32.eq (local.get $op) (i32.const 0xA9)))
            (then
              (call $te (i32.const 360) (local.get $prefix_66))
              (br $decode)))

          ;; ---- SSE base ----
          ;; SDL2's Win32 video bootstrap is built with baseline SSE and uses
          ;; these exact bitwise/move forms before it has created a window.
          ;; F3 0F10/11 are scalar MOVSS; 0F14 is UNPCKLPS; 0F16/17 are the
          ;; MOVHPS/MOVLHPS lane moves; 0FC6 is SHUFPS. 0F2C and F3 0F2C are
          ;; truncating packed and scalar float-to-integer conversions.
          ;; 66/F2 variants remain unsupported.
          (if (i32.and
                (i32.and
                  (i32.eqz (local.get $prefix_66))
                  (i32.or
                    (i32.eqz (local.get $prefix_rep))
                    (i32.and
                      (i32.eq (local.get $prefix_rep) (i32.const 1))
                      (i32.or
                        (i32.eq (local.get $op) (i32.const 0x10))
                        (i32.or
                          (i32.eq (local.get $op) (i32.const 0x11))
                          (i32.eq (local.get $op) (i32.const 0x2c)))))))
                (i32.or
                  (i32.or
                    (i32.or
                      (i32.eq (local.get $op) (i32.const 0x10))
                      (i32.eq (local.get $op) (i32.const 0x11)))
                    (i32.or
                      (i32.eq (local.get $op) (i32.const 0x14))
                      (i32.or
                        (i32.eq (local.get $op) (i32.const 0x16))
                        (i32.eq (local.get $op) (i32.const 0x17)))))
                  (i32.or
                    (i32.or
                      (i32.eq (local.get $op) (i32.const 0x28))
                      (i32.eq (local.get $op) (i32.const 0x29)))
                    (i32.or
                      (i32.eq (local.get $op) (i32.const 0x2c))
                      (i32.or
                        (i32.eq (local.get $op) (i32.const 0x57))
                        (i32.or
                          (i32.eq (local.get $op) (i32.const 0x58))
                          (i32.or
                            (i32.eq (local.get $op) (i32.const 0x59))
                            (i32.eq (local.get $op) (i32.const 0xC6)))))))))
            (then
              (call $decode_modrm)
              (local.set $imm (i32.const 0))
              (if (local.get $prefix_rep)
                (then
                  (local.set $imm
                    (select (i32.const 6) (i32.const 2)
                      (i32.eq (local.get $op) (i32.const 0x2c)))))
                (else
                  (if (i32.eq (local.get $op) (i32.const 0x57))
                    (then (local.set $imm (i32.const 1))))
                  (if (i32.eq (local.get $op) (i32.const 0x58))
                    (then (local.set $imm (i32.const 8))))
                  (if (i32.eq (local.get $op) (i32.const 0x59))
                    (then (local.set $imm (i32.const 9))))
                  (if (i32.eq (local.get $op) (i32.const 0x14))
                    (then (local.set $imm (i32.const 3))))
                  (if (i32.or (i32.eq (local.get $op) (i32.const 0x16))
                              (i32.eq (local.get $op) (i32.const 0x17)))
                    (then (local.set $imm (i32.const 4))))
                  (if (i32.eq (local.get $op) (i32.const 0x2c))
                    (then (local.set $imm (i32.const 5))))
                  (if (i32.eq (local.get $op) (i32.const 0xC6))
                    (then (local.set $imm (i32.const 7))))))
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then
                  (if (i32.eq (local.get $op) (i32.const 0xC6))
                    (then (local.set $imm
                      (i32.or (local.get $imm)
                        (i32.shl (call $d_fetch8) (i32.const 8))))))
                  (if (i32.eq (local.get $op) (i32.const 0x17))
                    (then
                      (call $host_log_i32 (i32.const 0xCA5E0F17))
                      (unreachable)))
                  (if (i32.or (i32.eq (local.get $op) (i32.const 0x11))
                              (i32.eq (local.get $op) (i32.const 0x29)))
                    (then (call $te (i32.const 432)
                      (i32.or (i32.shl (local.get $imm) (i32.const 8))
                        (i32.or (i32.shl (global.get $mr_val) (i32.const 4))
                                (global.get $mr_reg)))))
                    (else (call $te (i32.const 432)
                      (i32.or (i32.shl (local.get $imm) (i32.const 8))
                        (i32.or (i32.shl (global.get $mr_reg) (i32.const 4))
                                (global.get $mr_val)))))))
                (else
                  (call $apply_seg_override)
                  (local.set $a (call $emit_sib_or_abs))
                  (if (i32.eq (local.get $op) (i32.const 0xC6))
                    (then (local.set $imm
                      (i32.or (local.get $imm)
                        (i32.shl (call $d_fetch8) (i32.const 8))))))
                  (if (i32.or (i32.eq (local.get $op) (i32.const 0x11))
                              (i32.or (i32.eq (local.get $op) (i32.const 0x29))
                                      (i32.eq (local.get $op) (i32.const 0x17))))
                    (then (call $te (i32.const 434)
                      (i32.or (i32.shl (local.get $imm) (i32.const 8))
                              (i32.shl (global.get $mr_reg) (i32.const 4)))))
                    (else (call $te (i32.const 433)
                      (i32.or (i32.shl (local.get $imm) (i32.const 8))
                              (i32.shl (global.get $mr_reg) (i32.const 4))))))
                  (call $te_raw (local.get $a))))
              (br $decode)))

          ;; ---- MMX ----
          ;; A 66/F2/F3 prefix in front of the 0F turns every one of these
          ;; opcodes into its xmm form, which is a different register file we
          ;; do not have. Those must keep falling through to the trap below, so
          ;; a crash report says "SSE2" honestly instead of quietly computing
          ;; the right answer in the wrong 64 bits.
          (if (i32.and (i32.eqz (local.get $prefix_66)) (i32.eqz (local.get $prefix_rep)))
            (then
              ;; 0x71/0x72/0x73: shift-by-immediate group. The operation is in
              ;; the ModRM reg field and the count is an imm8 after it, so this
              ;; has to look at the ModRM before it can tell whether the opcode
              ;; is even ours -- hence the d_pc rewind on the reject path.
              (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x71))
                           (i32.le_u (local.get $op) (i32.const 0x73)))
                (then
                  (local.set $mmxpc (global.get $d_pc))
                  (call $decode_modrm)
                  (local.set $mmxsub (call $mmx_group_subop (local.get $op) (global.get $mr_reg)))
                  (if (i32.and (i32.ne (local.get $mmxsub) (i32.const -1))
                               (i32.eq (global.get $mr_mod) (i32.const 3)))
                    (then
                      (call $te (i32.const 425)
                        (i32.or (i32.shl (local.get $mmxsub) (i32.const 12))
                          (i32.or (i32.shl (global.get $mr_val) (i32.const 8))
                                  (call $d_fetch8))))
                      (br $decode)))
                  (global.set $d_pc (local.get $mmxpc))))

              (local.set $mmxsub (call $mmx_opcode_subop (local.get $op)))
              (if (i32.ne (local.get $mmxsub) (i32.const -1))
                (then
                  (local.set $mmxpc (global.get $d_pc))
                  (call $decode_modrm)
                  ;; 0x7E (movd r/m32, mm) and 0x7F (movq mm/m64, mm) are the
                  ;; only two that write the r/m operand; everything else reads
                  ;; it and writes the reg field.
                  (if (i32.eq (global.get $mr_mod) (i32.const 3))
                    (then
                      (if (i32.or (i32.eq (local.get $op) (i32.const 0x7E))
                                  (i32.eq (local.get $op) (i32.const 0x7F)))
                        (then (call $te (i32.const 422)
                                (i32.or (i32.shl (local.get $mmxsub) (i32.const 8))
                                  (i32.or (i32.shl (global.get $mr_val) (i32.const 4))
                                          (global.get $mr_reg)))))
                        (else (call $te (i32.const 422)
                                (i32.or (i32.shl (local.get $mmxsub) (i32.const 8))
                                  (i32.or (i32.shl (global.get $mr_reg) (i32.const 4))
                                          (global.get $mr_val))))))
                      (br $decode)))
                  ;; pmovmskb has no memory form; anything else takes m64 (or
                  ;; m32 for the two movd encodings).
                  (if (i32.ne (local.get $op) (i32.const 0xD7))
                    (then
                      (local.set $a (call $emit_sib_or_abs))
                      (call $te
                        (select (i32.const 424) (i32.const 423)
                          (i32.or (i32.eq (local.get $op) (i32.const 0x7E))
                                  (i32.eq (local.get $op) (i32.const 0x7F))))
                        (i32.or (i32.shl (local.get $mmxsub) (i32.const 8))
                                (i32.shl (global.get $mr_reg) (i32.const 4))))
                      (call $te_raw (local.get $a))
                      (br $decode)))
                  (global.set $d_pc (local.get $mmxpc))))))

          ;; Unknown 0x0F xx — trap rather than loop on it.
          (call $host_log_i32 (i32.or (i32.const 0x0F00) (local.get $op)))
          (call $te (i32.const 361) (i32.sub (global.get $d_pc) (i32.const 2)))
          (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- XCHG r/m32, r32 (0x87) / XCHG r/m8 (0x86) ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0x86)) (i32.eq (local.get $op) (i32.const 0x87)))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then
              (if (i32.eq (local.get $op) (i32.const 0x86))
                (then (call $te (i32.const 71) (i32.or (i32.const 0x100)
                        (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))
                (else
                  (if (local.get $prefix_66)
                    (then (call $te (i32.const 272)
                            (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
                    (else (call $te (i32.const 71)
                            (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))))))
            (else
              (if (i32.eq (local.get $op) (i32.const 0x86))
                (then ;; 8-bit memory XCHG
                  (if (call $mr_simple_base)
                    (then (call $te (i32.const 238) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_base)))
                          (call $te_raw (global.get $mr_disp)))
                    (else (local.set $a (call $emit_sib_or_abs))
                          (call $te (i32.const 237) (global.get $mr_reg))
                          (call $te_raw (local.get $a)))))
                (else
                  (if (local.get $prefix_66)
                    (then ;; 16-bit memory XCHG
                      (if (call $mr_simple_base)
                        (then (call $te (i32.const 271) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_base)))
                              (call $te_raw (global.get $mr_disp)))
                        (else (local.set $a (call $emit_sib_or_abs))
                              (call $te (i32.const 270) (global.get $mr_reg))
                              (call $te_raw (local.get $a)))))
                    (else ;; 32-bit memory XCHG
                      (if (call $mr_simple_base)
                        (then (call $te (i32.const 197) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_base)))
                              (call $te_raw (global.get $mr_disp)))
                        (else (local.set $a (call $emit_sib_or_abs))
                              (call $te (i32.const 196) (global.get $mr_reg))
                              (call $te_raw (local.get $a))))))))))
          (br $decode)))

      ;; ---- FWAIT (0x9B) — NOP, wait for FPU exceptions (we don't generate any) ----
      (if (i32.eq (local.get $op) (i32.const 0x9B))
        (then (br $decode)))

      ;; ---- x87 FPU (D8-DF) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0xD8)) (i32.le_u (local.get $op) (i32.const 0xDF)))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then
              ;; DF E0 / FNSTSW AX is almost always immediately consumed by
              ;; TEST AH + Jcc. The fused branch ends this decoded block.
              (if (i32.and
                    (i32.eq (local.get $op) (i32.const 0xDF))
                    (i32.and
                      (i32.eq (global.get $mr_reg) (i32.const 4))
                      (i32.eqz (global.get $mr_val))))
                (then
                  (if (call $try_emit_fnstsw_test_ah_jcc)
                    (then
                      (local.set $done (i32.const 1))
                      (br $decode)))))
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
          ;; FPU instructions do NOT end blocks — continue decoding
          (br $decode)))

      ;; ---- Unrecognized opcode ----
      (call $host_log_i32 (local.get $op))
      (call $te (i32.const 361) (i32.sub (global.get $d_pc) (i32.const 1)))
      (local.set $done (i32.const 1))
      (br $decode)
    ))

    ;; Loop-idiom matcher runs on the ops just emitted, before the block is
    ;; published. See src/07b-loop-match.wat.
    (call $loop_match_block (local.get $start_eip) (local.get $tstart))
    (call $publish_block (local.get $start_eip) (local.get $tstart) (global.get $d_pc))
  )

  ;; Move a freshly emitted block out of the emit scratch and into its page's
  ;; chunk, and hand back the address it will actually run from.
  ;;
  ;; The scratch is reclaimed. That is new, and it is what deleting the hash
  ;; cache bought: there used to be two permanent copies of every block -- the
  ;; arena one the hash pointed at and the chunk one the index pointed at -- and
  ;; the first execution ran the arena copy while every later one ran the chunk
  ;; copy. With only the index left there is one copy, the arena is pure scratch,
  ;; and $thread_alloc rewinds to where the block started.
  ;;
  ;; The rewind is conditional for a reason that is easy to miss: $page_publish
  ;; may itself allocate a 16KB chunk out of $thread_alloc when it opens a new
  ;; page, and that chunk sits *after* the scratch. Rewinding over it would hand
  ;; the next block's emit the same memory the page is about to run from. So
  ;; rewind only when publishing left $thread_alloc exactly where the block
  ;; ended; otherwise the scratch is simply abandoned, once per compiled page.
  (func $publish_block (param $start_eip i32) (param $tstart i32) (param $guest_end i32)
                       (result i32)
    (call $code_note_decode (local.get $start_eip))
    ;; After the matcher, because it rewrites the ops in place and may shorten
    ;; the block; $thread_alloc is the truth about where the block ends either
    ;; way. Captured before publishing, which is the call that can move
    ;; $thread_alloc for reasons of its own.
    (global.set $d_block_end (global.get $thread_alloc))
    (global.set $d_pub_off
      (call $page_publish (local.get $start_eip) (local.get $tstart)
            (global.get $thread_alloc) (local.get $guest_end)))
    (if (i32.lt_s (global.get $d_pub_off) (i32.const 0))
      (then
        ;; Nothing to fall back on now: this block has no home and will be
        ;; decoded again on every entry. Count it -- a non-trivial number here
        ;; means PAGE_INDEX_SLOTS or PAGE_CHUNK_BYTES is undersized, and the
        ;; symptom would otherwise be nothing but a slow run.
        (global.set $page_unpublished
          (i32.add (global.get $page_unpublished) (i32.const 1)))
        (global.set $d_pub_end (i32.const -1))
        (return (local.get $tstart))))
    (global.set $d_pub_end
      (i32.add (global.get $d_pub_off)
        (i32.sub (global.get $d_block_end) (local.get $tstart))))
    (if (i32.eq (global.get $thread_alloc) (global.get $d_block_end))
      (then (global.set $thread_alloc (local.get $tstart))))
    (i32.add (global.get $cur_page_chunk) (global.get $d_pub_off)))

  ;; ============================================================
  ;; ADDRESS-ORDERED RUNS
  ;; ============================================================
  ;;
  ;; What $run asks for. A block whose terminator is a conditional branch has
  ;; two successors, and one of them -- the fall-through -- is the very next
  ;; byte of x86. Compiling only the block leaves that successor to be found by
  ;; address at runtime, every single time the branch is not taken:
  ;;
  ;;   x86        0x401003 jne 0x401020
  ;;              0x401005 mov ...          <- the not-taken successor
  ;;
  ;;   one block  [ ... jcc ] ......?......  eip=0x401005, then go look it up
  ;;
  ;; So keep decoding. Each call to $decode_block emits at $thread_alloc and
  ;; $page_publish appends to the same chunk, so consecutive calls for the same
  ;; page are already laid out end to end in both places -- the arena copy the
  ;; first execution runs from, and the chunk copy every later one does:
  ;;
  ;;   a run      [ ... jcc ][ mov ... ]     the successor IS the next op
  ;;
  ;; and then the branch's not-taken side is a fall-through in the threaded code
  ;; too. $jcc_end reads the bit this sets and simply carries on.
  ;;
  ;; "Already laid out end to end" is checked, never assumed. Three things can
  ;; break the adjacency between one call and the next -- the arena filling up
  ;; and being recycled, the page's chunk filling up, the block being declined
  ;; because its x86 crosses a page boundary -- and each of them would leave the
  ;; first block's not-taken branch running into whatever landed there instead.
  ;; The offsets $page_publish reports are the proof: the flag is only set once
  ;; the second block is known to start exactly where the first one ended.
  ;;
  ;; Discovery is the two-pass scheme of docs/page-compile-design.md section 3
  ;; with the passes fused. Following fall-throughs only means the addresses are
  ;; produced in ascending order to begin with, so there is nothing to sort, and
  ;; the section 3.1 gap invariant holds by construction rather than by
  ;; assertion: the next block starts at the previous one's $d_pc, so the
  ;; emitted address sequence is contiguous with no gap to justify. Branch
  ;; *targets* are still compiled on demand, as their own runs appended to the
  ;; same chunk -- that is section 3.2, and it is why a run stops the moment it
  ;; reaches code that has been decoded once already.
  (func $decode_run (param $start_eip i32) (result i32)
    (local $t0 i32) (local $page i32) (local $n i32)
    (local $alloc i32) (local $jfn i32) (local $fall i32) (local $prev_end i32)
    (local $tb i32) (local $optr i32) (local $old_chunk i32)
    (local.set $t0 (call $decode_block (local.get $start_eip)))
    (local.set $page (i32.and (local.get $start_eip) (i32.const 0xFFFFF000)))
    (block $stop (loop $ext
      ;; A run of 64 blocks is already far more than a 4KB page holds in
      ;; practice; the bound is here so a pathological page cannot turn one
      ;; block miss into an unbounded decode.
      (br_if $stop (i32.ge_u (local.get $n) (i32.const 64)))
      ;; The terminator has to be one of the specialised Jcc handlers, whose
      ;; layout is exactly $te(fn, 0) followed by the fall-through and target
      ;; words. Finding it by counting 16 bytes back from the end is NOT safe:
      ;; a shorter terminator -- $th_jmp is 12 bytes -- puts the *previous* op's
      ;; operand where the handler index would be, and an operand is an
      ;; arbitrary integer that can perfectly well land in 307..322. That
      ;; misreads a random word as a fall-through address and, worse, writes a
      ;; 1 into the middle of a live block.
      ;;
      ;; So use the op-start index $te maintains for exactly this problem: the
      ;; thread stream is not self-describing, and OP_INDEX is the one record of
      ;; where each op really begins. The last entry is the terminator. Both
      ;; conditions below are then checks rather than assumptions -- the handler
      ;; index says which op it is, and its distance to the block end says the
      ;; two raw words really are there.
      (local.set $alloc (global.get $d_block_end))
      (br_if $stop (global.get $op_index_poison))
      (br_if $stop (i32.eqz (global.get $op_index_n)))
      (local.set $optr
        (i32.load
          (i32.add (global.get $OP_INDEX)
            (i32.shl (i32.sub (global.get $op_index_n) (i32.const 1)) (i32.const 2)))))
      (br_if $stop (i32.ne (i32.add (local.get $optr) (i32.const 16)) (local.get $alloc)))
      (local.set $jfn (i32.load (local.get $optr)))
      (br_if $stop (i32.lt_u (local.get $jfn) (i32.const 307)))
      (br_if $stop (i32.gt_u (local.get $jfn) (i32.const 322)))
      (local.set $fall (i32.load offset=8 (local.get $optr)))
      ;; One page per run: the index, the chunk and $invalidate_page are all
      ;; per-page, so a run that wandered into the next page would be indexed
      ;; against the wrong one.
      (br_if $stop (i32.ne (i32.and (local.get $fall) (i32.const 0xFFFFF000))
                           (local.get $page)))
      ;; Already compiled: appending a second copy here would be correct but
      ;; wasteful, and it would repoint the index at the copy. $page_probe
      ;; rather than $page_resolve, because this must not move the page
      ;; registers out from under the run being appended.
      (br_if $stop (call $page_probe (local.get $fall)))
      ;; The block we are about to extend has to be in the chunk itself, or
      ;; there is nothing for the next one to be adjacent to.
      (local.set $prev_end (global.get $d_pub_end))
      (br_if $stop (i32.lt_s (local.get $prev_end) (i32.const 0)))
      ;; Never let the arena recycle in the middle of a run: $decode_block does
      ;; that at its head, and it would move the ground out from under the block
      ;; whose branch we are about to mark. Leave the same 16KB headroom it
      ;; checks, doubled, so the check below cannot pass and then fire inside.
      (br_if $stop (global.get $thread_flush_pending))
      (br_if $stop (i32.ge_u (global.get $thread_alloc)
                             (i32.sub (global.get $THREAD_END) (i32.const 32768))))
      (local.set $old_chunk (global.get $cur_page_chunk))
      (local.set $tb (call $decode_block (local.get $fall)))
      ;; Growing a size-class chunk relocates every already-published block.
      ;; $t0 is the one pointer decode_run keeps across those publications, so
      ;; carry its offset to the new base before returning it to $run.
      (if (i32.and
            (i32.ne (local.get $old_chunk) (i32.const 0))
            (i32.and
              (i32.ne (global.get $cur_page_chunk) (i32.const 0))
              (i32.ne (local.get $old_chunk) (global.get $cur_page_chunk))))
        (then
          (local.set $t0
            (i32.add (global.get $cur_page_chunk)
              (i32.sub (local.get $t0) (local.get $old_chunk))))))
      ;; The proof. There is only one copy of a run now -- the chunk -- and the
      ;; offsets $page_publish reports are its witness: anything that went wrong
      ;; (a page swap, a full chunk, a declined publish) shows up as an offset
      ;; that is not where the previous block ended. The emit scratch used to
      ;; need a second, separate witness because the first execution ran from
      ;; it; $publish_block reclaims it now, so there is nothing left to check.
      (br_if $stop (i32.ne (global.get $d_pub_off) (local.get $prev_end)))
      ;; Set the adjacency bit in the chunk, which is the only place the run
      ;; exists. The operand of the previous block's Jcc terminator sits 12
      ;; bytes back from where that block ended.
      (i32.store
        (i32.add (global.get $cur_page_chunk) (i32.sub (local.get $prev_end) (i32.const 12)))
        (i32.const 1))
      (global.set $page_ft_blocks (i32.add (global.get $page_ft_blocks) (i32.const 1)))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br $ext)))
    (if (local.get $n)
      (then (global.set $page_ft_chains (i32.add (global.get $page_ft_chains) (i32.const 1)))))
    (local.get $t0)
  )
