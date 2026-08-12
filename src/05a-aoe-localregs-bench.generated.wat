  ;; GENERATED focused benchmark; see tools/generate-aoe-localregs-dispatch.js.
  (func $run_aoe_brtable_globals (export "run_aoe_brtable_globals") (param $max_blocks i32)
    (local $blocks i32) (local $thread i32) (local $ip_v i32)
    (local $fn i32) (local $op i32) (local $addr i32) (local $a i32) (local $b i32) (local $r i32)
    (local.set $blocks (local.get $max_blocks))
    (block $all_done (loop $main
      (br_if $all_done (i32.le_s (local.get $blocks) (i32.const 0)))
      (br_if $all_done (i32.eqz (global.get $eip)))
      (local.set $blocks (i32.sub (local.get $blocks) (i32.const 1)))
      (local.set $thread (call $cache_lookup (global.get $eip)))
      (if (i32.eqz (local.get $thread))
        (then (local.set $thread (call $decode_block (global.get $eip)))))
      (local.set $ip_v (local.get $thread))
      (block $block_done (loop $dispatch
        (local.set $fn (i32.load (local.get $ip_v)))
        (local.set $op (i32.load offset=4 (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 8)))
        (block $fallback
          (block $case_355
          (block $case_319
          (block $case_312
          (block $case_128
          (block $case_65
          (block $case_64
          (block $case_53
          (block $case_48
          (block $case_43
          (block $case_28
          (block $case_21
          (block $case_20
          (block $case_18
          (block $case_12
          (block $case_11
          (block $case_7
            (br_table $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_7 $fallback $fallback $fallback $case_11 $case_12 $fallback $fallback $fallback $fallback $fallback $case_18 $fallback $case_20 $case_21 $fallback $fallback $fallback $fallback $fallback $fallback $case_28 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_43 $fallback $fallback $fallback $fallback $case_48 $fallback $fallback $fallback $fallback $case_53 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_64 $case_65 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_128 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_312 $fallback $fallback $fallback $fallback $fallback $fallback $case_319 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_355 $fallback (local.get $fn))
          ) ;; case 7
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $r (i32.and (local.get $a) (global.get $eax)))
          (global.set $eax (local.get $r))
          (call $set_flags_logic (local.get $r))
          (br $dispatch)
          ) ;; case 11
          (if (i32.eq (local.get $op) (i32.const 0x10)) (then (global.set $ecx (global.get $eax))) (else (global.set $edx (global.get $edi))))
          (br $dispatch)
          ) ;; case 12
          (local.set $a (if (result i32) (i32.eq (local.get $op) (i32.const 0x21)) (then (global.get $edx)) (else (global.get $edi))))
          (local.set $b (global.get $ecx))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (if (i32.eq (local.get $op) (i32.const 0x21)) (then (global.set $edx (local.get $r))) (else (global.set $edi (local.get $r))))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (br $dispatch)
          ) ;; case 18
          (global.set $eax (i32.const 0))
          (call $set_flags_logic (i32.const 0))
          (br $dispatch)
          ) ;; case 20
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $r (call $gl32 (local.get $a)))
          (if (i32.eq (local.get $op) (i32.const 3)) (then (global.set $ebx (local.get $r))) (else (global.set $edi (local.get $r))))
          (br $dispatch)
          ) ;; case 21
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (call $gs32 (local.get $a) (if (result i32) (i32.eq (local.get $op) (i32.const 6)) (then (global.get $esi)) (else (global.get $edi))))
          (br $dispatch)
          ) ;; case 28
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xffffff00)) (call $gl8 (i32.add (global.get $esi) (local.get $a)))))
          (br $dispatch)
          ) ;; case 43
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (global.set $eip (local.get $a))
          (br $block_done)
          (br $dispatch)
          ) ;; case 48
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $a (global.get $edi))
          (local.set $b (call $gl32 (local.get $addr)))
          (local.set $r (i32.sub (local.get $a) (local.get $b)))
          (global.set $edi (local.get $r))
          (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r))
          (br $dispatch)
          ) ;; case 53
          (local.set $a (global.get $ecx))
          (local.set $b (i32.const 4))
          (local.set $r (i32.shr_u (local.get $a) (local.get $b)))
          (global.set $ecx (local.get $r))
          (call $set_flags_shift (local.get $r) (i32.and (i32.shr_u (local.get $a) (i32.const 3)) (i32.const 1)))
          (br $dispatch)
          ) ;; case 64
          (local.set $a (global.get $esi))
          (local.set $r (i32.add (local.get $a) (i32.const 1)))
          (global.set $esi (local.get $r))
          (call $set_flags_inc (local.get $a) (local.get $r))
          (br $dispatch)
          ) ;; case 65
          (local.set $a (global.get $edx))
          (local.set $r (i32.sub (local.get $a) (i32.const 1)))
          (global.set $edx (local.get $r))
          (call $set_flags_dec (local.get $a) (local.get $r))
          (br $dispatch)
          ) ;; case 128
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $a (global.get $edx))
          (local.set $b (call $gl32 (i32.add (global.get $ebx) (local.get $addr))))
          (local.set $r (i32.sub (local.get $a) (local.get $b)))
          (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r))
          (br $dispatch)
          ) ;; case 312
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $b (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (global.set $eip (if (result i32) (global.get $flag_res) (then (local.get $b)) (else (local.get $a))))
          (br $block_done)
          (br $dispatch)
          ) ;; case 319
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $b (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (global.set $eip (if (result i32) (call $eval_cc (i32.const 12)) (then (local.get $b)) (else (local.get $a))))
          (br $block_done)
          (br $dispatch)
          ) ;; case 355
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (global.set $eip (call $gl32 (i32.add (local.get $a) (i32.shl (global.get $eax) (i32.const 2)))))
          (br $block_done)
          (br $dispatch)
        ) ;; fallback
        (call $host_log_i32 (i32.const 0x10CA1BAD))
        (global.set $eip (i32.const 0))
        (br $block_done)))
      (br $main)))
  )
  (func $run_aoe_brtable_locals (export "run_aoe_brtable_locals") (param $max_blocks i32)
    (local $blocks i32) (local $thread i32) (local $ip_v i32)
    (local $fn i32) (local $op i32) (local $addr i32) (local $a i32) (local $b i32) (local $r i32)
    (local $eax_v i32) (local $ecx_v i32) (local $edx_v i32) (local $ebx_v i32)
    (local $esp_v i32) (local $ebp_v i32) (local $esi_v i32) (local $edi_v i32) (local $eip_v i32)
    (local $flag_op_v i32) (local $flag_a_v i32) (local $flag_b_v i32) (local $flag_res_v i32)
    (local $flag_shift_v i32) (local $saved_cf_v i32)
    (local.set $eax_v (global.get $eax))
    (local.set $ecx_v (global.get $ecx))
    (local.set $edx_v (global.get $edx))
    (local.set $ebx_v (global.get $ebx))
    (local.set $esp_v (global.get $esp))
    (local.set $ebp_v (global.get $ebp))
    (local.set $esi_v (global.get $esi))
    (local.set $edi_v (global.get $edi))
    (local.set $eip_v (global.get $eip))
    (local.set $flag_op_v (global.get $flag_op))
    (local.set $flag_a_v (global.get $flag_a))
    (local.set $flag_b_v (global.get $flag_b))
    (local.set $flag_res_v (global.get $flag_res))
    (local.set $flag_shift_v (global.get $flag_sign_shift))
    (local.set $saved_cf_v (global.get $saved_cf))
    (local.set $blocks (local.get $max_blocks))
    (block $all_done (loop $main
      (br_if $all_done (i32.le_s (local.get $blocks) (i32.const 0)))
      (br_if $all_done (i32.eqz (local.get $eip_v)))
      (local.set $blocks (i32.sub (local.get $blocks) (i32.const 1)))
      (local.set $thread (call $cache_lookup (local.get $eip_v)))
      (if (i32.eqz (local.get $thread))
        (then (local.set $thread (call $decode_block (local.get $eip_v)))))
      (local.set $ip_v (local.get $thread))
      (block $block_done (loop $dispatch
        (local.set $fn (i32.load (local.get $ip_v)))
        (local.set $op (i32.load offset=4 (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 8)))
        (block $fallback
          (block $case_355
          (block $case_319
          (block $case_312
          (block $case_128
          (block $case_65
          (block $case_64
          (block $case_53
          (block $case_48
          (block $case_43
          (block $case_28
          (block $case_21
          (block $case_20
          (block $case_18
          (block $case_12
          (block $case_11
          (block $case_7
            (br_table $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_7 $fallback $fallback $fallback $case_11 $case_12 $fallback $fallback $fallback $fallback $fallback $case_18 $fallback $case_20 $case_21 $fallback $fallback $fallback $fallback $fallback $fallback $case_28 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_43 $fallback $fallback $fallback $fallback $case_48 $fallback $fallback $fallback $fallback $case_53 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_64 $case_65 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_128 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_312 $fallback $fallback $fallback $fallback $fallback $fallback $case_319 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_355 $fallback (local.get $fn))
          ) ;; case 7
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $r (i32.and (local.get $a) (local.get $eax_v)))
          (local.set $eax_v (local.get $r))
          (local.set $flag_op_v (i32.const 3))
          (local.set $flag_res_v (local.get $r))
          (local.set $flag_shift_v (i32.const 31))
          (br $dispatch)
          ) ;; case 11
          (if (i32.eq (local.get $op) (i32.const 0x10)) (then (local.set $ecx_v (local.get $eax_v))) (else (local.set $edx_v (local.get $edi_v))))
          (br $dispatch)
          ) ;; case 12
          (local.set $a (if (result i32) (i32.eq (local.get $op) (i32.const 0x21)) (then (local.get $edx_v)) (else (local.get $edi_v))))
          (local.set $b (local.get $ecx_v))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (if (i32.eq (local.get $op) (i32.const 0x21)) (then (local.set $edx_v (local.get $r))) (else (local.set $edi_v (local.get $r))))
          (local.set $flag_op_v (i32.const 1))
          (local.set $flag_res_v (local.get $r))
          (local.set $flag_shift_v (i32.const 31))
          (local.set $flag_a_v (local.get $a))
          (local.set $flag_b_v (local.get $b))
          (br $dispatch)
          ) ;; case 18
          (local.set $eax_v (i32.const 0))
          (local.set $flag_op_v (i32.const 3))
          (local.set $flag_res_v (i32.const 0))
          (local.set $flag_shift_v (i32.const 31))
          (br $dispatch)
          ) ;; case 20
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $r (call $gl32 (local.get $a)))
          (if (i32.eq (local.get $op) (i32.const 3)) (then (local.set $ebx_v (local.get $r))) (else (local.set $edi_v (local.get $r))))
          (br $dispatch)
          ) ;; case 21
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (call $gs32 (local.get $a) (if (result i32) (i32.eq (local.get $op) (i32.const 6)) (then (local.get $esi_v)) (else (local.get $edi_v))))
          (br $dispatch)
          ) ;; case 28
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $eax_v (i32.or (i32.and (local.get $eax_v) (i32.const 0xffffff00)) (call $gl8 (i32.add (local.get $esi_v) (local.get $a)))))
          (br $dispatch)
          ) ;; case 43
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $eip_v (local.get $a))
          (br $block_done)
          (br $dispatch)
          ) ;; case 48
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $a (local.get $edi_v))
          (local.set $b (call $gl32 (local.get $addr)))
          (local.set $r (i32.sub (local.get $a) (local.get $b)))
          (local.set $edi_v (local.get $r))
          (local.set $flag_op_v (i32.const 2))
          (local.set $flag_res_v (local.get $r))
          (local.set $flag_shift_v (i32.const 31))
          (local.set $flag_a_v (local.get $a))
          (local.set $flag_b_v (local.get $b))
          (br $dispatch)
          ) ;; case 53
          (local.set $a (local.get $ecx_v))
          (local.set $b (i32.const 4))
          (local.set $r (i32.shr_u (local.get $a) (local.get $b)))
          (local.set $ecx_v (local.get $r))
          (local.set $flag_op_v (i32.const 7))
          (local.set $flag_res_v (local.get $r))
          (local.set $flag_shift_v (i32.const 31))
          (local.set $flag_b_v (i32.and (i32.shr_u (local.get $a) (i32.const 3)) (i32.const 1)))
          (br $dispatch)
          ) ;; case 64
          (local.set $a (local.get $esi_v))
          (local.set $r (i32.add (local.get $a) (i32.const 1)))
          (local.set $esi_v (local.get $r))
          (local.set $flag_op_v (i32.const 4))
          (local.set $flag_res_v (local.get $r))
          (local.set $flag_shift_v (i32.const 31))
          (local.set $flag_a_v (local.get $a))
          (local.set $flag_b_v (i32.const 1))
          (br $dispatch)
          ) ;; case 65
          (local.set $a (local.get $edx_v))
          (local.set $r (i32.sub (local.get $a) (i32.const 1)))
          (local.set $edx_v (local.get $r))
          (local.set $flag_op_v (i32.const 5))
          (local.set $flag_res_v (local.get $r))
          (local.set $flag_shift_v (i32.const 31))
          (local.set $flag_a_v (local.get $a))
          (local.set $flag_b_v (i32.const 1))
          (br $dispatch)
          ) ;; case 128
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $a (local.get $edx_v))
          (local.set $b (call $gl32 (i32.add (local.get $ebx_v) (local.get $addr))))
          (local.set $r (i32.sub (local.get $a) (local.get $b)))
          (local.set $flag_op_v (i32.const 2))
          (local.set $flag_res_v (local.get $r))
          (local.set $flag_shift_v (i32.const 31))
          (local.set $flag_a_v (local.get $a))
          (local.set $flag_b_v (local.get $b))
          (br $dispatch)
          ) ;; case 312
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $b (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $eip_v (if (result i32) (local.get $flag_res_v) (then (local.get $b)) (else (local.get $a))))
          (br $block_done)
          (br $dispatch)
          ) ;; case 319
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $b (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $eip_v (if (result i32) (i32.lt_s (local.get $flag_a_v) (local.get $flag_b_v)) (then (local.get $b)) (else (local.get $a))))
          (br $block_done)
          (br $dispatch)
          ) ;; case 355
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $eip_v (call $gl32 (i32.add (local.get $a) (i32.shl (local.get $eax_v) (i32.const 2)))))
          (br $block_done)
          (br $dispatch)
        ) ;; fallback
        (call $host_log_i32 (i32.const 0x10CA1BAD))
        (local.set $eip_v (i32.const 0))
        (br $block_done)))
      (br $main)))
    (global.set $eax (local.get $eax_v))
    (global.set $ecx (local.get $ecx_v))
    (global.set $edx (local.get $edx_v))
    (global.set $ebx (local.get $ebx_v))
    (global.set $esp (local.get $esp_v))
    (global.set $ebp (local.get $ebp_v))
    (global.set $esi (local.get $esi_v))
    (global.set $edi (local.get $edi_v))
    (global.set $eip (local.get $eip_v))
    (global.set $flag_op (local.get $flag_op_v))
    (global.set $flag_a (local.get $flag_a_v))
    (global.set $flag_b (local.get $flag_b_v))
    (global.set $flag_res (local.get $flag_res_v))
    (global.set $flag_sign_shift (local.get $flag_shift_v))
    (global.set $saved_cf (local.get $saved_cf_v))
  )
