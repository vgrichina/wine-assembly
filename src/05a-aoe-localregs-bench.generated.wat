  ;; GENERATED focused benchmark; see tools/generate-aoe-localregs-dispatch.js.

  ;; Focused call_indirect microbenchmarks. The JS harness promotes only the
  ;; matching decoded AoE fixture words to these handler IDs.
  (func $th_bench_sub_r_m32_direct_alu (param $op i32)
    (local $a i32) (local $b i32) (local $r i32)
    (local.set $a (call $get_reg (i32.and (local.get $op) (i32.const 15))))
    (local.set $b (call $gl32 (call $read_thread_word)))
    (local.set $r (i32.sub (local.get $a) (local.get $b)))
    (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r))
    (call $set_reg (i32.and (local.get $op) (i32.const 15)) (local.get $r))
    (return_call $next))
  (func $th_bench_shr_r_direct_alu (param $op i32)
    (local $reg i32) (local $a i32) (local $count i32) (local $r i32)
    (local.set $reg (i32.and (local.get $op) (i32.const 255)))
    (local.set $a (call $get_reg (local.get $reg)))
    (local.set $count (i32.and (i32.shr_u (local.get $op) (i32.const 16)) (i32.const 31)))
    (local.set $r (i32.shr_u (local.get $a) (local.get $count)))
    (call $set_flags_shift (local.get $r)
      (i32.and (i32.shr_u (local.get $a) (i32.sub (local.get $count) (i32.const 1))) (i32.const 1)))
    (call $set_reg (local.get $reg) (local.get $r))
    (return_call $next))
  (func $th_bench_cmp_r_m32_ro_direct_alu (param $op i32)
    (local $a i32) (local $b i32) (local $r i32)
    (local.set $a (call $get_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15))))
    (local.set $b (call $gl32 (i32.add
      (call $get_reg (i32.and (local.get $op) (i32.const 15)))
      (call $read_thread_word))))
    (local.set $r (i32.sub (local.get $a) (local.get $b)))
    (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r))
    (return_call $next))
  (func $th_bench_jnz_direct (param $op i32)
    (local $fall i32) (local $target i32)
    (local.set $fall (call $read_thread_word))
    (local.set $target (call $read_thread_word))
    (global.set $eip (if (result i32) (global.get $flag_res)
      (then (local.get $target)) (else (local.get $fall)))))
  (func $th_bench_jl_direct (param $op i32)
    (local $fall i32) (local $target i32)
    (local.set $fall (call $read_thread_word))
    (local.set $target (call $read_thread_word))
    (global.set $eip (if (result i32)
      (i32.lt_s (global.get $flag_a) (global.get $flag_b))
      (then (local.get $target)) (else (local.get $fall)))))

  (func $th_bench_store_esi_abs (param $op i32)
    (call $gs32 (call $read_thread_word) (global.get $esi)) (return_call $next))
  (func $th_bench_xor_eax_eax (param $op i32)
    (global.set $eax (i32.const 0)) (call $set_flags_logic (i32.const 0)) (return_call $next))
  (func $th_bench_store_edi_abs (param $op i32)
    (call $gs32 (call $read_thread_word) (global.get $edi)) (return_call $next))
  (func $th_bench_load8_al_esi_disp (param $op i32)
    (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xffffff00))
      (call $gl8 (i32.add (global.get $esi) (call $read_thread_word)))))
    (return_call $next))
  (func $th_bench_sub_edi_m32_generic_alu (param $op i32)
    (global.set $edi (call $do_alu32 (i32.const 5) (global.get $edi)
      (call $gl32 (call $read_thread_word))))
    (return_call $next))
  (func $th_bench_mov_ecx_eax (param $op i32)
    (global.set $ecx (global.get $eax)) (return_call $next))
  (func $th_bench_inc_esi (param $op i32)
    (local $a i32) (local $r i32)
    (local.set $a (global.get $esi)) (local.set $r (i32.add (local.get $a) (i32.const 1)))
    (global.set $esi (local.get $r)) (call $set_flags_inc (local.get $a) (local.get $r)) (return_call $next))
  (func $th_bench_and_eax_i32 (param $op i32)
    (local $r i32) (local.set $r (i32.and (global.get $eax) (call $read_thread_word)))
    (global.set $eax (local.get $r)) (call $set_flags_logic (local.get $r)) (return_call $next))
  (func $th_bench_load_ebx_abs (param $op i32)
    (global.set $ebx (call $gl32 (call $read_thread_word))) (return_call $next))
  (func $th_bench_shr_ecx_generic_alu (param $op i32)
    (global.set $ecx (call $do_shift32 (i32.const 5) (global.get $ecx) (i32.const 4)))
    (return_call $next))
  (func $th_bench_mov_edx_edi (param $op i32)
    (global.set $edx (global.get $edi)) (return_call $next))
  (func $th_bench_add_edx_ecx (param $op i32)
    (local $a i32) (local $b i32) (local $r i32)
    (local.set $a (global.get $edx)) (local.set $b (global.get $ecx))
    (local.set $r (i32.add (local.get $a) (local.get $b)))
    (global.set $edx (local.get $r)) (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
    (return_call $next))
  (func $th_bench_dec_edx (param $op i32)
    (local $a i32) (local $r i32)
    (local.set $a (global.get $edx)) (local.set $r (i32.sub (local.get $a) (i32.const 1)))
    (global.set $edx (local.get $r)) (call $set_flags_dec (local.get $a) (local.get $r)) (return_call $next))
  (func $th_bench_cmp_edx_ebx_disp_generic_alu (param $op i32)
    (drop (call $do_alu32 (i32.const 7) (global.get $edx)
      (call $gl32 (i32.add (global.get $ebx) (call $read_thread_word)))))
    (return_call $next))
  (func $th_bench_load_edi_abs (param $op i32)
    (global.set $edi (call $gl32 (call $read_thread_word))) (return_call $next))
  (func $th_bench_add_edi_ecx (param $op i32)
    (local $a i32) (local $b i32) (local $r i32)
    (local.set $a (global.get $edi)) (local.set $b (global.get $ecx))
    (local.set $r (i32.add (local.get $a) (local.get $b)))
    (global.set $edi (local.get $r)) (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
    (return_call $next))

  (func $th_bench_sub_edi_m32_direct_alu (param $op i32)
    (local $a i32) (local $b i32) (local $r i32)
    (local.set $a (global.get $edi)) (local.set $b (call $gl32 (call $read_thread_word)))
    (local.set $r (i32.sub (local.get $a) (local.get $b)))
    (global.set $edi (local.get $r)) (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r))
    (return_call $next))
  (func $th_bench_shr_ecx_direct_alu (param $op i32)
    (local $a i32) (local $r i32)
    (local.set $a (global.get $ecx)) (local.set $r (i32.shr_u (local.get $a) (i32.const 4)))
    (global.set $ecx (local.get $r))
    (call $set_flags_shift (local.get $r) (i32.and (i32.shr_u (local.get $a) (i32.const 3)) (i32.const 1)))
    (return_call $next))
  (func $th_bench_cmp_edx_ebx_disp_direct_alu (param $op i32)
    (local $a i32) (local $b i32)
    (local.set $a (global.get $edx))
    (local.set $b (call $gl32 (i32.add (global.get $ebx) (call $read_thread_word))))
    (call $set_flags_sub (local.get $a) (local.get $b) (i32.sub (local.get $a) (local.get $b)))
    (return_call $next))

  ;; Classify the final emitted x86 packet once at cache-store time.
  (func $x86_hot_subset_classify_packet (param $start i32) (param $end i32) (result i32)
    (local $ptr i32) (local $fn i32) (local $count i32)
    (local.set $ptr (local.get $start))
    (block $cold (loop $scan
      (br_if $cold (i32.ge_u (local.get $ptr) (local.get $end)))
      (local.set $fn (i32.load (local.get $ptr)))
      (local.set $ptr (i32.add (local.get $ptr) (i32.const 8)))
      (block $fallback
        (block $class_384
        (block $class_383
        (block $class_382
        (block $class_378
        (block $class_374
        (block $class_373
        (block $class_368
        (block $class_355
        (block $class_334
        (block $class_333
        (block $class_319
        (block $class_312
        (block $class_149
        (block $class_129
        (block $class_128
        (block $class_127
        (block $class_94
        (block $class_65
        (block $class_64
        (block $class_53
        (block $class_48
        (block $class_47
        (block $class_43
        (block $class_28
        (block $class_21
        (block $class_20
        (block $class_18
        (block $class_12
        (block $class_11
        (block $class_7
          (br_table $fallback $fallback $fallback $fallback $fallback $fallback $fallback $class_7 $fallback $fallback $fallback $class_11 $class_12 $fallback $fallback $fallback $fallback $fallback $class_18 $fallback $class_20 $class_21 $fallback $fallback $fallback $fallback $fallback $fallback $class_28 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $class_43 $fallback $fallback $fallback $class_47 $class_48 $fallback $fallback $fallback $fallback $class_53 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $class_64 $class_65 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $class_94 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $class_127 $class_128 $class_129 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $class_149 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $class_312 $fallback $fallback $fallback $fallback $fallback $fallback $class_319 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $class_333 $class_334 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $class_355 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $class_368 $fallback $fallback $fallback $fallback $class_373 $class_374 $fallback $fallback $fallback $class_378 $fallback $fallback $fallback $class_382 $class_383 $class_384 $fallback (local.get $fn))
        ) ;; class 7
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 11
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 12
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 18
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 20
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 21
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 28
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 43
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
        (return (i32.const 1))
        ) ;; class 47
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 48
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 53
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 64
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 65
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 94
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 127
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 128
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 129
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 149
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 8)))
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 312
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 8)))
        (return (i32.const 1))
        ) ;; class 319
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 8)))
        (return (i32.const 1))
        ) ;; class 333
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 334
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 355
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
        (return (i32.const 1))
        ) ;; class 368
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 373
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 374
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 378
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 382
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 383
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
        ) ;; class 384
        (local.set $count (i32.add (local.get $count) (i32.const 1)))
        ;; $next executes at most 999 handlers after steps=1000. A
        ;; longer straight-line packet is eligible when that prefix
        ;; is supported, even if its eventual terminal is not reached.
        (if (i32.ge_u (local.get $count) (i32.const 999)) (then (return (i32.const 1))))
        (br $scan)
      ) ;; fallback
      (br $cold)
    ))
    (i32.const 0)
  )
  (func $run_x86_hot_subset_packet_generic (param $thread i32)
    (local $ip_v i32) (local $fn i32) (local $op i32) (local $budget i32)
    (local $addr i32) (local $a i32) (local $b i32) (local $r i32)
    (local.set $ip_v (local.get $thread))
    (local.set $budget (i32.const 999))
    (block $block_done (loop $dispatch
      (local.set $fn (i32.load (local.get $ip_v)))
      (local.set $op (i32.load offset=4 (local.get $ip_v)))
      (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 8)))
      (block $fallback
        (block $case_384
        (block $case_383
        (block $case_382
        (block $case_378
        (block $case_374
        (block $case_373
        (block $case_368
        (block $case_355
        (block $case_334
        (block $case_333
        (block $case_319
        (block $case_312
        (block $case_149
        (block $case_129
        (block $case_128
        (block $case_127
        (block $case_94
        (block $case_65
        (block $case_64
        (block $case_53
        (block $case_48
        (block $case_47
        (block $case_43
        (block $case_28
        (block $case_21
        (block $case_20
        (block $case_18
        (block $case_12
        (block $case_11
        (block $case_7
          (br_table $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_7 $fallback $fallback $fallback $case_11 $case_12 $fallback $fallback $fallback $fallback $fallback $case_18 $fallback $case_20 $case_21 $fallback $fallback $fallback $fallback $fallback $fallback $case_28 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_43 $fallback $fallback $fallback $case_47 $case_48 $fallback $fallback $fallback $fallback $case_53 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_64 $case_65 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_94 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_127 $case_128 $case_129 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_149 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_312 $fallback $fallback $fallback $fallback $fallback $fallback $case_319 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_333 $case_334 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_355 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_368 $fallback $fallback $fallback $fallback $case_373 $case_374 $fallback $fallback $fallback $case_378 $fallback $fallback $fallback $case_382 $case_383 $case_384 $fallback (local.get $fn))
        ) ;; case 7
        (local.set $b (i32.load (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
        (local.set $a (call $get_reg (local.get $op)))
        (local.set $r (i32.and (local.get $a) (local.get $b)))
        (call $set_reg (local.get $op) (local.get $r))
        (call $set_flags_logic (local.get $r))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 11
        (call $set_reg (i32.shr_u (local.get $op) (i32.const 4)) (call $get_reg (i32.and (local.get $op) (i32.const 15))))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 12
        (local.set $addr (i32.shr_u (local.get $op) (i32.const 4)))
        (local.set $a (call $get_reg (local.get $addr)))
        (local.set $b (call $get_reg (i32.and (local.get $op) (i32.const 15))))
        (local.set $r (i32.add (local.get $a) (local.get $b)))
        (call $set_reg (local.get $addr) (local.get $r))
        (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 18
        (local.set $addr (i32.shr_u (local.get $op) (i32.const 4)))
        (local.set $r (i32.xor (call $get_reg (local.get $addr)) (call $get_reg (i32.and (local.get $op) (i32.const 15)))))
        (call $set_reg (local.get $addr) (local.get $r))
        (call $set_flags_logic (local.get $r))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 20
        (local.set $addr (i32.load (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
        (call $set_reg (local.get $op) (call $gl32 (local.get $addr)))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 21
        (local.set $addr (i32.load (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
        (call $gs32 (local.get $addr) (call $get_reg (local.get $op)))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 28
        (local.set $addr (i32.load (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
        (call $set_reg8 (i32.shr_u (local.get $op) (i32.const 4)) (call $gl8 (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr))))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 43
        (local.set $a (i32.load (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
        (global.set $eip (local.get $a))
        (br $block_done)
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 47
        (local.set $addr (i32.load (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
        (if (i32.eq (local.get $addr) (global.get $SIB_SENTINEL)) (then (local.set $addr (global.get $ea_temp))))
        (local.set $a (i32.shr_u (local.get $op) (i32.const 4)))
        (local.set $b (i32.and (local.get $op) (i32.const 15)))
        (local.set $r (call $do_alu32 (local.get $a) (call $gl32 (local.get $addr)) (call $get_reg (local.get $b))))
        (if (i32.ne (local.get $a) (i32.const 7)) (then (call $gs32 (local.get $addr) (local.get $r))))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 48
        (local.set $addr (i32.load (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
        (local.set $a (call $get_reg (i32.and (local.get $op) (i32.const 15))))
        (local.set $b (call $gl32 (local.get $addr)))
        (local.set $r (call $do_alu32 (i32.shr_u (local.get $op) (i32.const 4)) (local.get $a) (local.get $b)))
        (if (i32.ne (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 7)) (then (call $set_reg (i32.and (local.get $op) (i32.const 15)) (local.get $r))))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 53
        (local.set $addr (i32.and (local.get $op) (i32.const 255)))
        (local.set $a (i32.and (i32.shr_u (local.get $op) (i32.const 16)) (i32.const 255)))
        (if (i32.eq (local.get $a) (i32.const 255)) (then (local.set $a (i32.and (global.get $ecx) (i32.const 31)))))
        (call $set_reg (local.get $addr) (call $do_shift32 (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 255)) (call $get_reg (local.get $addr)) (local.get $a)))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 64
        (local.set $a (call $get_reg (local.get $op)))
        (local.set $r (i32.add (local.get $a) (i32.const 1)))
        (call $set_reg (local.get $op) (local.get $r))
        (call $set_flags_inc (local.get $a) (local.get $r))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 65
        (local.set $a (call $get_reg (local.get $op)))
        (local.set $r (i32.sub (local.get $a) (i32.const 1)))
        (call $set_reg (local.get $op) (local.get $r))
        (call $set_flags_dec (local.get $a) (local.get $r))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 94
        (local.set $a (call $gl8 (global.get $esi)))
        (local.set $b (call $gl8 (global.get $edi)))
        (local.set $r (i32.sub (local.get $a) (local.get $b)))
        (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r))
        (if (global.get $df)
          (then (global.set $esi (i32.sub (global.get $esi) (i32.const 1))) (global.set $edi (i32.sub (global.get $edi) (i32.const 1))))
          (else (global.set $esi (i32.add (global.get $esi) (i32.const 1))) (global.set $edi (i32.add (global.get $edi) (i32.const 1)))))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 127
        (local.set $addr (i32.load (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
        (local.set $addr (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr)))
        (local.set $a (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)))
        (local.set $b (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15)))
        (local.set $r (call $do_alu32 (local.get $a) (call $gl32 (local.get $addr)) (call $get_reg (local.get $b))))
        (if (i32.ne (local.get $a) (i32.const 7)) (then (call $gs32 (local.get $addr) (local.get $r))))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 128
        (local.set $addr (i32.load (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
        (local.set $a (call $get_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15))))
        (local.set $b (call $gl32 (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr))))
        (local.set $r (call $do_alu32 (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)) (local.get $a) (local.get $b)))
        (if (i32.ne (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)) (i32.const 7)) (then (call $set_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15)) (local.get $r))))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 129
        (local.set $addr (i32.load (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
        (local.set $addr (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr)))
        (local.set $a (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)))
        (local.set $b (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15)))
        (local.set $r (call $do_alu32 (local.get $a) (call $gl8 (local.get $addr)) (call $get_reg8 (local.get $b))))
        (global.set $flag_sign_shift (i32.const 7))
        (if (i32.ne (local.get $a) (i32.const 7)) (then (call $gs8 (local.get $addr) (local.get $r))))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 149
        (local.set $a (i32.load (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
        (local.set $b (i32.load (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
        (local.set $addr (i32.const 0))
        (local.set $r (i32.const 0))
        (if (i32.ne (i32.and (local.get $a) (i32.const 15)) (i32.const 15)) (then (local.set $addr (call $get_reg (i32.and (local.get $a) (i32.const 15))))))
        (if (i32.ne (i32.and (i32.shr_u (local.get $a) (i32.const 4)) (i32.const 15)) (i32.const 15))
          (then (local.set $r (i32.shl (call $get_reg (i32.and (i32.shr_u (local.get $a) (i32.const 4)) (i32.const 15))) (i32.and (i32.shr_u (local.get $a) (i32.const 8)) (i32.const 3))))))
        (global.set $ea_temp (i32.add (i32.add (local.get $addr) (local.get $r)) (local.get $b)))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 312
        (local.set $a (i32.load (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
        (local.set $b (i32.load (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
        (global.set $eip (if (result i32) (call $eval_cc (i32.const 5)) (then (local.get $b)) (else (local.get $a))))
        (br $block_done)
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 319
        (local.set $a (i32.load (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
        (local.set $b (i32.load (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
        (global.set $eip (if (result i32) (call $eval_cc (i32.const 12)) (then (local.get $b)) (else (local.get $a))))
        (br $block_done)
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 333
        (global.set $edx (call $gl32 (global.get $esp)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 334
        (global.set $ebx (call $gl32 (global.get $esp)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 355
        (local.set $addr (i32.load (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
        (global.set $eip (call $gl32 (i32.add (local.get $addr) (i32.shl (global.get $eax) (i32.const 2)))))
        (br $block_done)
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 368
        (global.set $ecx (global.get $eax))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 373
        (global.set $edx (global.get $edi))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 374
        (local.set $a (global.get $edx))
        (local.set $b (global.get $ecx))
        (local.set $r (i32.add (local.get $a) (local.get $b)))
        (global.set $edx (local.get $r))
        (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 378
        (local.set $a (global.get $edi))
        (local.set $b (global.get $ecx))
        (local.set $r (i32.add (local.get $a) (local.get $b)))
        (global.set $edi (local.get $r))
        (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 382
        (local.set $addr (i32.load (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
        (local.set $addr (i32.add (global.get $eax) (local.get $addr)))
        (local.set $a (call $gl8 (local.get $addr)))
        (local.set $b (i32.and (global.get $eax) (i32.const 255)))
        (local.set $r (i32.add (local.get $a) (local.get $b)))
        (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
        (global.set $flag_sign_shift (i32.const 7))
        (call $gs8 (local.get $addr) (local.get $r))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 383
        (local.set $addr (i32.load (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
        (local.set $addr (i32.add (global.get $ecx) (local.get $addr)))
        (local.set $a (call $gl8 (local.get $addr)))
        (local.set $b (i32.and (global.get $eax) (i32.const 255)))
        (local.set $r (i32.add (local.get $a) (local.get $b)))
        (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
        (global.set $flag_sign_shift (i32.const 7))
        (call $gs8 (local.get $addr) (local.get $r))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
        ) ;; case 384
        (local.set $a (i32.and (global.get $edx) (i32.const 255)))
        (local.set $b (i32.and (i32.shr_u (global.get $edx) (i32.const 8)) (i32.const 255)))
        (local.set $r (i32.and (i32.add (local.get $a) (local.get $b)) (i32.const 255)))
        (global.set $edx (i32.or (i32.and (global.get $edx) (i32.const 0xffffff00)) (local.get $r)))
        (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
        (global.set $flag_sign_shift (i32.const 7))
        (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))
        (br_if $block_done (i32.eqz (local.get $budget)))
        (br $dispatch)
      ) ;; fallback
      ;; Cache-time classification makes this unreachable unless the
      ;; packet or metadata was corrupted after insertion.
      (call $host_log_i32 (i32.const 0x10CA1BAD))
      (global.set $eip (i32.const 0))
      (br $block_done)))
  )
  (func $run_aoe_brtable_generic_global_ip (export "run_aoe_brtable_generic_global_ip") (param $max_blocks i32)
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
      (global.set $ip (local.get $thread))
      (block $block_done (loop $dispatch
        (local.set $fn (i32.load (global.get $ip)))
        (local.set $op (i32.load offset=4 (global.get $ip)))
        (global.set $ip (i32.add (global.get $ip) (i32.const 8)))
        (block $fallback
          (block $case_384
          (block $case_383
          (block $case_382
          (block $case_378
          (block $case_374
          (block $case_373
          (block $case_368
          (block $case_355
          (block $case_334
          (block $case_333
          (block $case_319
          (block $case_312
          (block $case_149
          (block $case_129
          (block $case_128
          (block $case_127
          (block $case_94
          (block $case_65
          (block $case_64
          (block $case_53
          (block $case_48
          (block $case_47
          (block $case_43
          (block $case_28
          (block $case_21
          (block $case_20
          (block $case_18
          (block $case_12
          (block $case_11
          (block $case_7
            (br_table $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_7 $fallback $fallback $fallback $case_11 $case_12 $fallback $fallback $fallback $fallback $fallback $case_18 $fallback $case_20 $case_21 $fallback $fallback $fallback $fallback $fallback $fallback $case_28 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_43 $fallback $fallback $fallback $case_47 $case_48 $fallback $fallback $fallback $fallback $case_53 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_64 $case_65 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_94 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_127 $case_128 $case_129 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_149 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_312 $fallback $fallback $fallback $fallback $fallback $fallback $case_319 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_333 $case_334 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_355 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_368 $fallback $fallback $fallback $fallback $case_373 $case_374 $fallback $fallback $fallback $case_378 $fallback $fallback $fallback $case_382 $case_383 $case_384 $fallback (local.get $fn))
          ) ;; case 7
          (local.set $b (call $read_thread_word))
          (local.set $a (call $get_reg (local.get $op)))
          (local.set $r (i32.and (local.get $a) (local.get $b)))
          (call $set_reg (local.get $op) (local.get $r))
          (call $set_flags_logic (local.get $r))
          (br $dispatch)
          ) ;; case 11
          (call $set_reg (i32.shr_u (local.get $op) (i32.const 4)) (call $get_reg (i32.and (local.get $op) (i32.const 15))))
          (br $dispatch)
          ) ;; case 12
          (local.set $addr (i32.shr_u (local.get $op) (i32.const 4)))
          (local.set $a (call $get_reg (local.get $addr)))
          (local.set $b (call $get_reg (i32.and (local.get $op) (i32.const 15))))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (call $set_reg (local.get $addr) (local.get $r))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (br $dispatch)
          ) ;; case 18
          (local.set $addr (i32.shr_u (local.get $op) (i32.const 4)))
          (local.set $r (i32.xor (call $get_reg (local.get $addr)) (call $get_reg (i32.and (local.get $op) (i32.const 15)))))
          (call $set_reg (local.get $addr) (local.get $r))
          (call $set_flags_logic (local.get $r))
          (br $dispatch)
          ) ;; case 20
          (local.set $addr (call $read_thread_word))
          (call $set_reg (local.get $op) (call $gl32 (local.get $addr)))
          (br $dispatch)
          ) ;; case 21
          (local.set $addr (call $read_thread_word))
          (call $gs32 (local.get $addr) (call $get_reg (local.get $op)))
          (br $dispatch)
          ) ;; case 28
          (local.set $addr (call $read_thread_word))
          (call $set_reg8 (i32.shr_u (local.get $op) (i32.const 4)) (call $gl8 (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr))))
          (br $dispatch)
          ) ;; case 43
          (local.set $a (call $read_thread_word))
          (global.set $eip (local.get $a))
          (br $block_done)
          (br $dispatch)
          ) ;; case 47
          (local.set $addr (call $read_thread_word))
          (if (i32.eq (local.get $addr) (global.get $SIB_SENTINEL)) (then (local.set $addr (global.get $ea_temp))))
          (local.set $a (i32.shr_u (local.get $op) (i32.const 4)))
          (local.set $b (i32.and (local.get $op) (i32.const 15)))
          (local.set $r (call $do_alu32 (local.get $a) (call $gl32 (local.get $addr)) (call $get_reg (local.get $b))))
          (if (i32.ne (local.get $a) (i32.const 7)) (then (call $gs32 (local.get $addr) (local.get $r))))
          (br $dispatch)
          ) ;; case 48
          (local.set $addr (call $read_thread_word))
          (local.set $a (call $get_reg (i32.and (local.get $op) (i32.const 15))))
          (local.set $b (call $gl32 (local.get $addr)))
          (local.set $r (call $do_alu32 (i32.shr_u (local.get $op) (i32.const 4)) (local.get $a) (local.get $b)))
          (if (i32.ne (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 7)) (then (call $set_reg (i32.and (local.get $op) (i32.const 15)) (local.get $r))))
          (br $dispatch)
          ) ;; case 53
          (local.set $addr (i32.and (local.get $op) (i32.const 255)))
          (local.set $a (i32.and (i32.shr_u (local.get $op) (i32.const 16)) (i32.const 255)))
          (if (i32.eq (local.get $a) (i32.const 255)) (then (local.set $a (i32.and (global.get $ecx) (i32.const 31)))))
          (call $set_reg (local.get $addr) (call $do_shift32 (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 255)) (call $get_reg (local.get $addr)) (local.get $a)))
          (br $dispatch)
          ) ;; case 64
          (local.set $a (call $get_reg (local.get $op)))
          (local.set $r (i32.add (local.get $a) (i32.const 1)))
          (call $set_reg (local.get $op) (local.get $r))
          (call $set_flags_inc (local.get $a) (local.get $r))
          (br $dispatch)
          ) ;; case 65
          (local.set $a (call $get_reg (local.get $op)))
          (local.set $r (i32.sub (local.get $a) (i32.const 1)))
          (call $set_reg (local.get $op) (local.get $r))
          (call $set_flags_dec (local.get $a) (local.get $r))
          (br $dispatch)
          ) ;; case 94
          (local.set $a (call $gl8 (global.get $esi)))
          (local.set $b (call $gl8 (global.get $edi)))
          (local.set $r (i32.sub (local.get $a) (local.get $b)))
          (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r))
          (if (global.get $df)
            (then (global.set $esi (i32.sub (global.get $esi) (i32.const 1))) (global.set $edi (i32.sub (global.get $edi) (i32.const 1))))
            (else (global.set $esi (i32.add (global.get $esi) (i32.const 1))) (global.set $edi (i32.add (global.get $edi) (i32.const 1)))))
          (br $dispatch)
          ) ;; case 127
          (local.set $addr (call $read_thread_word))
          (local.set $addr (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr)))
          (local.set $a (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)))
          (local.set $b (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15)))
          (local.set $r (call $do_alu32 (local.get $a) (call $gl32 (local.get $addr)) (call $get_reg (local.get $b))))
          (if (i32.ne (local.get $a) (i32.const 7)) (then (call $gs32 (local.get $addr) (local.get $r))))
          (br $dispatch)
          ) ;; case 128
          (local.set $addr (call $read_thread_word))
          (local.set $a (call $get_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15))))
          (local.set $b (call $gl32 (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr))))
          (local.set $r (call $do_alu32 (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)) (local.get $a) (local.get $b)))
          (if (i32.ne (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)) (i32.const 7)) (then (call $set_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15)) (local.get $r))))
          (br $dispatch)
          ) ;; case 129
          (local.set $addr (call $read_thread_word))
          (local.set $addr (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr)))
          (local.set $a (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)))
          (local.set $b (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15)))
          (local.set $r (call $do_alu32 (local.get $a) (call $gl8 (local.get $addr)) (call $get_reg8 (local.get $b))))
          (global.set $flag_sign_shift (i32.const 7))
          (if (i32.ne (local.get $a) (i32.const 7)) (then (call $gs8 (local.get $addr) (local.get $r))))
          (br $dispatch)
          ) ;; case 149
          (local.set $a (call $read_thread_word))
          (local.set $b (call $read_thread_word))
          (local.set $addr (i32.const 0))
          (local.set $r (i32.const 0))
          (if (i32.ne (i32.and (local.get $a) (i32.const 15)) (i32.const 15)) (then (local.set $addr (call $get_reg (i32.and (local.get $a) (i32.const 15))))))
          (if (i32.ne (i32.and (i32.shr_u (local.get $a) (i32.const 4)) (i32.const 15)) (i32.const 15))
            (then (local.set $r (i32.shl (call $get_reg (i32.and (i32.shr_u (local.get $a) (i32.const 4)) (i32.const 15))) (i32.and (i32.shr_u (local.get $a) (i32.const 8)) (i32.const 3))))))
          (global.set $ea_temp (i32.add (i32.add (local.get $addr) (local.get $r)) (local.get $b)))
          (br $dispatch)
          ) ;; case 312
          (local.set $a (call $read_thread_word))
          (local.set $b (call $read_thread_word))
          (global.set $eip (if (result i32) (call $eval_cc (i32.const 5)) (then (local.get $b)) (else (local.get $a))))
          (br $block_done)
          (br $dispatch)
          ) ;; case 319
          (local.set $a (call $read_thread_word))
          (local.set $b (call $read_thread_word))
          (global.set $eip (if (result i32) (call $eval_cc (i32.const 12)) (then (local.get $b)) (else (local.get $a))))
          (br $block_done)
          (br $dispatch)
          ) ;; case 333
          (global.set $edx (call $gl32 (global.get $esp)))
          (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
          (br $dispatch)
          ) ;; case 334
          (global.set $ebx (call $gl32 (global.get $esp)))
          (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
          (br $dispatch)
          ) ;; case 355
          (local.set $addr (call $read_thread_word))
          (global.set $eip (call $gl32 (i32.add (local.get $addr) (i32.shl (global.get $eax) (i32.const 2)))))
          (br $block_done)
          (br $dispatch)
          ) ;; case 368
          (global.set $ecx (global.get $eax))
          (br $dispatch)
          ) ;; case 373
          (global.set $edx (global.get $edi))
          (br $dispatch)
          ) ;; case 374
          (local.set $a (global.get $edx))
          (local.set $b (global.get $ecx))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (global.set $edx (local.get $r))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (br $dispatch)
          ) ;; case 378
          (local.set $a (global.get $edi))
          (local.set $b (global.get $ecx))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (global.set $edi (local.get $r))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (br $dispatch)
          ) ;; case 382
          (local.set $addr (call $read_thread_word))
          (local.set $addr (i32.add (global.get $eax) (local.get $addr)))
          (local.set $a (call $gl8 (local.get $addr)))
          (local.set $b (i32.and (global.get $eax) (i32.const 255)))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (global.set $flag_sign_shift (i32.const 7))
          (call $gs8 (local.get $addr) (local.get $r))
          (br $dispatch)
          ) ;; case 383
          (local.set $addr (call $read_thread_word))
          (local.set $addr (i32.add (global.get $ecx) (local.get $addr)))
          (local.set $a (call $gl8 (local.get $addr)))
          (local.set $b (i32.and (global.get $eax) (i32.const 255)))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (global.set $flag_sign_shift (i32.const 7))
          (call $gs8 (local.get $addr) (local.get $r))
          (br $dispatch)
          ) ;; case 384
          (local.set $a (i32.and (global.get $edx) (i32.const 255)))
          (local.set $b (i32.and (i32.shr_u (global.get $edx) (i32.const 8)) (i32.const 255)))
          (local.set $r (i32.and (i32.add (local.get $a) (local.get $b)) (i32.const 255)))
          (global.set $edx (i32.or (i32.and (global.get $edx) (i32.const 0xffffff00)) (local.get $r)))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (global.set $flag_sign_shift (i32.const 7))
          (br $dispatch)
        ) ;; fallback
        (call $host_log_i32 (i32.const 0x10CA1BAD))
        (global.set $eip (i32.const 0))
        (br $block_done)))
      (br $main)))
  )
  (func $run_aoe_brtable_generic_local_ip (export "run_aoe_brtable_generic_local_ip") (param $max_blocks i32)
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
          (block $case_384
          (block $case_383
          (block $case_382
          (block $case_378
          (block $case_374
          (block $case_373
          (block $case_368
          (block $case_355
          (block $case_334
          (block $case_333
          (block $case_319
          (block $case_312
          (block $case_149
          (block $case_129
          (block $case_128
          (block $case_127
          (block $case_94
          (block $case_65
          (block $case_64
          (block $case_53
          (block $case_48
          (block $case_47
          (block $case_43
          (block $case_28
          (block $case_21
          (block $case_20
          (block $case_18
          (block $case_12
          (block $case_11
          (block $case_7
            (br_table $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_7 $fallback $fallback $fallback $case_11 $case_12 $fallback $fallback $fallback $fallback $fallback $case_18 $fallback $case_20 $case_21 $fallback $fallback $fallback $fallback $fallback $fallback $case_28 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_43 $fallback $fallback $fallback $case_47 $case_48 $fallback $fallback $fallback $fallback $case_53 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_64 $case_65 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_94 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_127 $case_128 $case_129 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_149 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_312 $fallback $fallback $fallback $fallback $fallback $fallback $case_319 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_333 $case_334 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_355 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_368 $fallback $fallback $fallback $fallback $case_373 $case_374 $fallback $fallback $fallback $case_378 $fallback $fallback $fallback $case_382 $case_383 $case_384 $fallback (local.get $fn))
          ) ;; case 7
          (local.set $b (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $a (call $get_reg (local.get $op)))
          (local.set $r (i32.and (local.get $a) (local.get $b)))
          (call $set_reg (local.get $op) (local.get $r))
          (call $set_flags_logic (local.get $r))
          (br $dispatch)
          ) ;; case 11
          (call $set_reg (i32.shr_u (local.get $op) (i32.const 4)) (call $get_reg (i32.and (local.get $op) (i32.const 15))))
          (br $dispatch)
          ) ;; case 12
          (local.set $addr (i32.shr_u (local.get $op) (i32.const 4)))
          (local.set $a (call $get_reg (local.get $addr)))
          (local.set $b (call $get_reg (i32.and (local.get $op) (i32.const 15))))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (call $set_reg (local.get $addr) (local.get $r))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (br $dispatch)
          ) ;; case 18
          (local.set $addr (i32.shr_u (local.get $op) (i32.const 4)))
          (local.set $r (i32.xor (call $get_reg (local.get $addr)) (call $get_reg (i32.and (local.get $op) (i32.const 15)))))
          (call $set_reg (local.get $addr) (local.get $r))
          (call $set_flags_logic (local.get $r))
          (br $dispatch)
          ) ;; case 20
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (call $set_reg (local.get $op) (call $gl32 (local.get $addr)))
          (br $dispatch)
          ) ;; case 21
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (call $gs32 (local.get $addr) (call $get_reg (local.get $op)))
          (br $dispatch)
          ) ;; case 28
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (call $set_reg8 (i32.shr_u (local.get $op) (i32.const 4)) (call $gl8 (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr))))
          (br $dispatch)
          ) ;; case 43
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (global.set $eip (local.get $a))
          (br $block_done)
          (br $dispatch)
          ) ;; case 47
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (if (i32.eq (local.get $addr) (global.get $SIB_SENTINEL)) (then (local.set $addr (global.get $ea_temp))))
          (local.set $a (i32.shr_u (local.get $op) (i32.const 4)))
          (local.set $b (i32.and (local.get $op) (i32.const 15)))
          (local.set $r (call $do_alu32 (local.get $a) (call $gl32 (local.get $addr)) (call $get_reg (local.get $b))))
          (if (i32.ne (local.get $a) (i32.const 7)) (then (call $gs32 (local.get $addr) (local.get $r))))
          (br $dispatch)
          ) ;; case 48
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $a (call $get_reg (i32.and (local.get $op) (i32.const 15))))
          (local.set $b (call $gl32 (local.get $addr)))
          (local.set $r (call $do_alu32 (i32.shr_u (local.get $op) (i32.const 4)) (local.get $a) (local.get $b)))
          (if (i32.ne (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 7)) (then (call $set_reg (i32.and (local.get $op) (i32.const 15)) (local.get $r))))
          (br $dispatch)
          ) ;; case 53
          (local.set $addr (i32.and (local.get $op) (i32.const 255)))
          (local.set $a (i32.and (i32.shr_u (local.get $op) (i32.const 16)) (i32.const 255)))
          (if (i32.eq (local.get $a) (i32.const 255)) (then (local.set $a (i32.and (global.get $ecx) (i32.const 31)))))
          (call $set_reg (local.get $addr) (call $do_shift32 (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 255)) (call $get_reg (local.get $addr)) (local.get $a)))
          (br $dispatch)
          ) ;; case 64
          (local.set $a (call $get_reg (local.get $op)))
          (local.set $r (i32.add (local.get $a) (i32.const 1)))
          (call $set_reg (local.get $op) (local.get $r))
          (call $set_flags_inc (local.get $a) (local.get $r))
          (br $dispatch)
          ) ;; case 65
          (local.set $a (call $get_reg (local.get $op)))
          (local.set $r (i32.sub (local.get $a) (i32.const 1)))
          (call $set_reg (local.get $op) (local.get $r))
          (call $set_flags_dec (local.get $a) (local.get $r))
          (br $dispatch)
          ) ;; case 94
          (local.set $a (call $gl8 (global.get $esi)))
          (local.set $b (call $gl8 (global.get $edi)))
          (local.set $r (i32.sub (local.get $a) (local.get $b)))
          (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r))
          (if (global.get $df)
            (then (global.set $esi (i32.sub (global.get $esi) (i32.const 1))) (global.set $edi (i32.sub (global.get $edi) (i32.const 1))))
            (else (global.set $esi (i32.add (global.get $esi) (i32.const 1))) (global.set $edi (i32.add (global.get $edi) (i32.const 1)))))
          (br $dispatch)
          ) ;; case 127
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $addr (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr)))
          (local.set $a (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)))
          (local.set $b (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15)))
          (local.set $r (call $do_alu32 (local.get $a) (call $gl32 (local.get $addr)) (call $get_reg (local.get $b))))
          (if (i32.ne (local.get $a) (i32.const 7)) (then (call $gs32 (local.get $addr) (local.get $r))))
          (br $dispatch)
          ) ;; case 128
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $a (call $get_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15))))
          (local.set $b (call $gl32 (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr))))
          (local.set $r (call $do_alu32 (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)) (local.get $a) (local.get $b)))
          (if (i32.ne (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)) (i32.const 7)) (then (call $set_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15)) (local.get $r))))
          (br $dispatch)
          ) ;; case 129
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $addr (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr)))
          (local.set $a (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)))
          (local.set $b (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15)))
          (local.set $r (call $do_alu32 (local.get $a) (call $gl8 (local.get $addr)) (call $get_reg8 (local.get $b))))
          (global.set $flag_sign_shift (i32.const 7))
          (if (i32.ne (local.get $a) (i32.const 7)) (then (call $gs8 (local.get $addr) (local.get $r))))
          (br $dispatch)
          ) ;; case 149
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $b (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $addr (i32.const 0))
          (local.set $r (i32.const 0))
          (if (i32.ne (i32.and (local.get $a) (i32.const 15)) (i32.const 15)) (then (local.set $addr (call $get_reg (i32.and (local.get $a) (i32.const 15))))))
          (if (i32.ne (i32.and (i32.shr_u (local.get $a) (i32.const 4)) (i32.const 15)) (i32.const 15))
            (then (local.set $r (i32.shl (call $get_reg (i32.and (i32.shr_u (local.get $a) (i32.const 4)) (i32.const 15))) (i32.and (i32.shr_u (local.get $a) (i32.const 8)) (i32.const 3))))))
          (global.set $ea_temp (i32.add (i32.add (local.get $addr) (local.get $r)) (local.get $b)))
          (br $dispatch)
          ) ;; case 312
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $b (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (global.set $eip (if (result i32) (call $eval_cc (i32.const 5)) (then (local.get $b)) (else (local.get $a))))
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
          ) ;; case 333
          (global.set $edx (call $gl32 (global.get $esp)))
          (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
          (br $dispatch)
          ) ;; case 334
          (global.set $ebx (call $gl32 (global.get $esp)))
          (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
          (br $dispatch)
          ) ;; case 355
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (global.set $eip (call $gl32 (i32.add (local.get $addr) (i32.shl (global.get $eax) (i32.const 2)))))
          (br $block_done)
          (br $dispatch)
          ) ;; case 368
          (global.set $ecx (global.get $eax))
          (br $dispatch)
          ) ;; case 373
          (global.set $edx (global.get $edi))
          (br $dispatch)
          ) ;; case 374
          (local.set $a (global.get $edx))
          (local.set $b (global.get $ecx))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (global.set $edx (local.get $r))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (br $dispatch)
          ) ;; case 378
          (local.set $a (global.get $edi))
          (local.set $b (global.get $ecx))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (global.set $edi (local.get $r))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (br $dispatch)
          ) ;; case 382
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $addr (i32.add (global.get $eax) (local.get $addr)))
          (local.set $a (call $gl8 (local.get $addr)))
          (local.set $b (i32.and (global.get $eax) (i32.const 255)))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (global.set $flag_sign_shift (i32.const 7))
          (call $gs8 (local.get $addr) (local.get $r))
          (br $dispatch)
          ) ;; case 383
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $addr (i32.add (global.get $ecx) (local.get $addr)))
          (local.set $a (call $gl8 (local.get $addr)))
          (local.set $b (i32.and (global.get $eax) (i32.const 255)))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (global.set $flag_sign_shift (i32.const 7))
          (call $gs8 (local.get $addr) (local.get $r))
          (br $dispatch)
          ) ;; case 384
          (local.set $a (i32.and (global.get $edx) (i32.const 255)))
          (local.set $b (i32.and (i32.shr_u (global.get $edx) (i32.const 8)) (i32.const 255)))
          (local.set $r (i32.and (i32.add (local.get $a) (local.get $b)) (i32.const 255)))
          (global.set $edx (i32.or (i32.and (global.get $edx) (i32.const 0xffffff00)) (local.get $r)))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (global.set $flag_sign_shift (i32.const 7))
          (br $dispatch)
        ) ;; fallback
        (call $host_log_i32 (i32.const 0x10CA1BAD))
        (global.set $eip (i32.const 0))
        (br $block_done)))
      (br $main)))
  )
  (func $run_aoe_brtable_direct_generic_alu (export "run_aoe_brtable_direct_generic_alu") (param $max_blocks i32)
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
          (local.set $r (call $do_alu32 (i32.const 4) (global.get $eax) (local.get $a)))
          (global.set $eax (local.get $r))
          (br $dispatch)
          ) ;; case 11
          (if (i32.eq (local.get $op) (i32.const 0x10)) (then (global.set $ecx (global.get $eax))) (else (global.set $edx (global.get $edi))))
          (br $dispatch)
          ) ;; case 12
          (local.set $a (if (result i32) (i32.eq (local.get $op) (i32.const 0x21)) (then (global.get $edx)) (else (global.get $edi))))
          (local.set $b (global.get $ecx))
          (local.set $r (call $do_alu32 (i32.const 0) (local.get $a) (local.get $b)))
          (if (i32.eq (local.get $op) (i32.const 0x21)) (then (global.set $edx (local.get $r))) (else (global.set $edi (local.get $r))))
          (br $dispatch)
          ) ;; case 18
          (local.set $r (call $do_alu32 (i32.const 6) (global.get $eax) (global.get $eax)))
          (global.set $eax (local.get $r))
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
          (local.set $r (call $do_alu32 (i32.const 5) (local.get $a) (local.get $b)))
          (global.set $edi (local.get $r))
          (br $dispatch)
          ) ;; case 53
          (local.set $a (global.get $ecx))
          (local.set $b (i32.const 4))
          (local.set $r (call $do_shift32 (i32.const 5) (local.get $a) (local.get $b)))
          (global.set $ecx (local.get $r))
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
          (local.set $r (call $do_alu32 (i32.const 7) (local.get $a) (local.get $b)))
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
  (func $run_aoe_brtable_subset_generic (export "run_aoe_brtable_subset_generic") (param $max_blocks i32)
    (local $blocks i32) (local $thread i32) (local $ip_v i32)
    (local $scan i32) (local $scan_fn i32) (local $scan_op i32) (local $scan_supported i32)
    (local $fn i32) (local $op i32) (local $addr i32) (local $a i32) (local $b i32) (local $r i32)
    (local.set $blocks (local.get $max_blocks))
    (block $all_done (loop $main
      (br_if $all_done (i32.le_s (local.get $blocks) (i32.const 0)))
      (br_if $all_done (i32.eqz (global.get $eip)))
      (local.set $blocks (i32.sub (local.get $blocks) (i32.const 1)))
      (local.set $thread (call $cache_lookup (global.get $eip)))
      (if (i32.eqz (local.get $thread))
        (then (local.set $thread (call $decode_block (global.get $eip)))))
      ;; Production-shaped fallback: validate the complete decoded block
      ;; before changing guest state. Unsupported blocks restart through $next.
      (local.set $scan (local.get $thread))
      (block $hot_ready
        (block $use_fallback
          (loop $scan_loop
            (local.set $scan_fn (i32.load (local.get $scan)))
            (local.set $scan_op (i32.load offset=4 (local.get $scan)))
            (local.set $scan (i32.add (local.get $scan) (i32.const 8)))
            (local.set $scan_supported (i32.const 0))
            (if (i32.eq (local.get $scan_fn) (i32.const 7))
              (then
                (local.set $scan_supported (i32.const 1))
                (local.set $scan (i32.add (local.get $scan) (i32.const 4)))
              ))
            (if (i32.eq (local.get $scan_fn) (i32.const 11))
              (then
                (local.set $scan_supported (i32.const 1))
              ))
            (if (i32.eq (local.get $scan_fn) (i32.const 12))
              (then
                (local.set $scan_supported (i32.const 1))
              ))
            (if (i32.eq (local.get $scan_fn) (i32.const 18))
              (then
                (local.set $scan_supported (i32.const 1))
              ))
            (if (i32.eq (local.get $scan_fn) (i32.const 20))
              (then
                (local.set $scan_supported (i32.const 1))
                (local.set $scan (i32.add (local.get $scan) (i32.const 4)))
              ))
            (if (i32.eq (local.get $scan_fn) (i32.const 21))
              (then
                (local.set $scan_supported (i32.const 1))
                (local.set $scan (i32.add (local.get $scan) (i32.const 4)))
              ))
            (if (i32.eq (local.get $scan_fn) (i32.const 28))
              (then
                (local.set $scan_supported (i32.const 1))
                (local.set $scan (i32.add (local.get $scan) (i32.const 4)))
              ))
            (if (i32.eq (local.get $scan_fn) (i32.const 43))
              (then
                (local.set $scan_supported (i32.const 1))
                (local.set $scan (i32.add (local.get $scan) (i32.const 4)))
                (br $hot_ready)
              ))
            (if (i32.eq (local.get $scan_fn) (i32.const 48))
              (then
                (local.set $scan_supported (i32.const 1))
                (local.set $scan (i32.add (local.get $scan) (i32.const 4)))
              ))
            (if (i32.eq (local.get $scan_fn) (i32.const 53))
              (then
                (local.set $scan_supported (i32.const 1))
              ))
            (if (i32.eq (local.get $scan_fn) (i32.const 64))
              (then
                (local.set $scan_supported (i32.const 1))
              ))
            (if (i32.eq (local.get $scan_fn) (i32.const 65))
              (then
                (local.set $scan_supported (i32.const 1))
              ))
            (if (i32.eq (local.get $scan_fn) (i32.const 128))
              (then
                (local.set $scan_supported (i32.const 1))
                (local.set $scan (i32.add (local.get $scan) (i32.const 4)))
              ))
            (if (i32.eq (local.get $scan_fn) (i32.const 312))
              (then
                (local.set $scan_supported (i32.const 1))
                (local.set $scan (i32.add (local.get $scan) (i32.const 8)))
                (br $hot_ready)
              ))
            (if (i32.eq (local.get $scan_fn) (i32.const 319))
              (then
                (local.set $scan_supported (i32.const 1))
                (local.set $scan (i32.add (local.get $scan) (i32.const 8)))
                (br $hot_ready)
              ))
            (if (i32.eq (local.get $scan_fn) (i32.const 355))
              (then
                (local.set $scan_supported (i32.const 1))
                (local.set $scan (i32.add (local.get $scan) (i32.const 4)))
                (br $hot_ready)
              ))
            (br_if $use_fallback (i32.eqz (local.get $scan_supported)))
            (br $scan_loop)))
        ;; No hot instruction ran, so only the thread IP needs restoring.
        (global.set $x86_hot_subset_fallback_blocks
          (i32.add (global.get $x86_hot_subset_fallback_blocks) (i32.const 1)))
        (global.set $ip (local.get $thread))
        (global.set $steps (i32.const 1000))
        (call $next)
        (br $main)
      ) ;; hot_ready
      (global.set $x86_hot_subset_hot_blocks
        (i32.add (global.get $x86_hot_subset_hot_blocks) (i32.const 1)))
      (local.set $ip_v (local.get $thread))
      (block $block_done (loop $dispatch
        (local.set $fn (i32.load (local.get $ip_v)))
        (local.set $op (i32.load offset=4 (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 8)))
        (block $fallback
          (block $case_384
          (block $case_383
          (block $case_382
          (block $case_378
          (block $case_374
          (block $case_373
          (block $case_368
          (block $case_355
          (block $case_334
          (block $case_333
          (block $case_319
          (block $case_312
          (block $case_149
          (block $case_129
          (block $case_128
          (block $case_127
          (block $case_94
          (block $case_65
          (block $case_64
          (block $case_53
          (block $case_48
          (block $case_47
          (block $case_43
          (block $case_28
          (block $case_21
          (block $case_20
          (block $case_18
          (block $case_12
          (block $case_11
          (block $case_7
            (br_table $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_7 $fallback $fallback $fallback $case_11 $case_12 $fallback $fallback $fallback $fallback $fallback $case_18 $fallback $case_20 $case_21 $fallback $fallback $fallback $fallback $fallback $fallback $case_28 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_43 $fallback $fallback $fallback $case_47 $case_48 $fallback $fallback $fallback $fallback $case_53 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_64 $case_65 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_94 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_127 $case_128 $case_129 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_149 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_312 $fallback $fallback $fallback $fallback $fallback $fallback $case_319 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_333 $case_334 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_355 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_368 $fallback $fallback $fallback $fallback $case_373 $case_374 $fallback $fallback $fallback $case_378 $fallback $fallback $fallback $case_382 $case_383 $case_384 $fallback (local.get $fn))
          ) ;; case 7
          (local.set $b (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $a (call $get_reg (local.get $op)))
          (local.set $r (i32.and (local.get $a) (local.get $b)))
          (call $set_reg (local.get $op) (local.get $r))
          (call $set_flags_logic (local.get $r))
          (br $dispatch)
          ) ;; case 11
          (call $set_reg (i32.shr_u (local.get $op) (i32.const 4)) (call $get_reg (i32.and (local.get $op) (i32.const 15))))
          (br $dispatch)
          ) ;; case 12
          (local.set $addr (i32.shr_u (local.get $op) (i32.const 4)))
          (local.set $a (call $get_reg (local.get $addr)))
          (local.set $b (call $get_reg (i32.and (local.get $op) (i32.const 15))))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (call $set_reg (local.get $addr) (local.get $r))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (br $dispatch)
          ) ;; case 18
          (local.set $addr (i32.shr_u (local.get $op) (i32.const 4)))
          (local.set $r (i32.xor (call $get_reg (local.get $addr)) (call $get_reg (i32.and (local.get $op) (i32.const 15)))))
          (call $set_reg (local.get $addr) (local.get $r))
          (call $set_flags_logic (local.get $r))
          (br $dispatch)
          ) ;; case 20
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (call $set_reg (local.get $op) (call $gl32 (local.get $addr)))
          (br $dispatch)
          ) ;; case 21
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (call $gs32 (local.get $addr) (call $get_reg (local.get $op)))
          (br $dispatch)
          ) ;; case 28
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (call $set_reg8 (i32.shr_u (local.get $op) (i32.const 4)) (call $gl8 (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr))))
          (br $dispatch)
          ) ;; case 43
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (global.set $eip (local.get $a))
          (br $block_done)
          (br $dispatch)
          ) ;; case 47
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (if (i32.eq (local.get $addr) (global.get $SIB_SENTINEL)) (then (local.set $addr (global.get $ea_temp))))
          (local.set $a (i32.shr_u (local.get $op) (i32.const 4)))
          (local.set $b (i32.and (local.get $op) (i32.const 15)))
          (local.set $r (call $do_alu32 (local.get $a) (call $gl32 (local.get $addr)) (call $get_reg (local.get $b))))
          (if (i32.ne (local.get $a) (i32.const 7)) (then (call $gs32 (local.get $addr) (local.get $r))))
          (br $dispatch)
          ) ;; case 48
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $a (call $get_reg (i32.and (local.get $op) (i32.const 15))))
          (local.set $b (call $gl32 (local.get $addr)))
          (local.set $r (call $do_alu32 (i32.shr_u (local.get $op) (i32.const 4)) (local.get $a) (local.get $b)))
          (if (i32.ne (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 7)) (then (call $set_reg (i32.and (local.get $op) (i32.const 15)) (local.get $r))))
          (br $dispatch)
          ) ;; case 53
          (local.set $addr (i32.and (local.get $op) (i32.const 255)))
          (local.set $a (i32.and (i32.shr_u (local.get $op) (i32.const 16)) (i32.const 255)))
          (if (i32.eq (local.get $a) (i32.const 255)) (then (local.set $a (i32.and (global.get $ecx) (i32.const 31)))))
          (call $set_reg (local.get $addr) (call $do_shift32 (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 255)) (call $get_reg (local.get $addr)) (local.get $a)))
          (br $dispatch)
          ) ;; case 64
          (local.set $a (call $get_reg (local.get $op)))
          (local.set $r (i32.add (local.get $a) (i32.const 1)))
          (call $set_reg (local.get $op) (local.get $r))
          (call $set_flags_inc (local.get $a) (local.get $r))
          (br $dispatch)
          ) ;; case 65
          (local.set $a (call $get_reg (local.get $op)))
          (local.set $r (i32.sub (local.get $a) (i32.const 1)))
          (call $set_reg (local.get $op) (local.get $r))
          (call $set_flags_dec (local.get $a) (local.get $r))
          (br $dispatch)
          ) ;; case 94
          (local.set $a (call $gl8 (global.get $esi)))
          (local.set $b (call $gl8 (global.get $edi)))
          (local.set $r (i32.sub (local.get $a) (local.get $b)))
          (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r))
          (if (global.get $df)
            (then (global.set $esi (i32.sub (global.get $esi) (i32.const 1))) (global.set $edi (i32.sub (global.get $edi) (i32.const 1))))
            (else (global.set $esi (i32.add (global.get $esi) (i32.const 1))) (global.set $edi (i32.add (global.get $edi) (i32.const 1)))))
          (br $dispatch)
          ) ;; case 127
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $addr (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr)))
          (local.set $a (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)))
          (local.set $b (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15)))
          (local.set $r (call $do_alu32 (local.get $a) (call $gl32 (local.get $addr)) (call $get_reg (local.get $b))))
          (if (i32.ne (local.get $a) (i32.const 7)) (then (call $gs32 (local.get $addr) (local.get $r))))
          (br $dispatch)
          ) ;; case 128
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $a (call $get_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15))))
          (local.set $b (call $gl32 (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr))))
          (local.set $r (call $do_alu32 (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)) (local.get $a) (local.get $b)))
          (if (i32.ne (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)) (i32.const 7)) (then (call $set_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15)) (local.get $r))))
          (br $dispatch)
          ) ;; case 129
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $addr (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr)))
          (local.set $a (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)))
          (local.set $b (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15)))
          (local.set $r (call $do_alu32 (local.get $a) (call $gl8 (local.get $addr)) (call $get_reg8 (local.get $b))))
          (global.set $flag_sign_shift (i32.const 7))
          (if (i32.ne (local.get $a) (i32.const 7)) (then (call $gs8 (local.get $addr) (local.get $r))))
          (br $dispatch)
          ) ;; case 149
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $b (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $addr (i32.const 0))
          (local.set $r (i32.const 0))
          (if (i32.ne (i32.and (local.get $a) (i32.const 15)) (i32.const 15)) (then (local.set $addr (call $get_reg (i32.and (local.get $a) (i32.const 15))))))
          (if (i32.ne (i32.and (i32.shr_u (local.get $a) (i32.const 4)) (i32.const 15)) (i32.const 15))
            (then (local.set $r (i32.shl (call $get_reg (i32.and (i32.shr_u (local.get $a) (i32.const 4)) (i32.const 15))) (i32.and (i32.shr_u (local.get $a) (i32.const 8)) (i32.const 3))))))
          (global.set $ea_temp (i32.add (i32.add (local.get $addr) (local.get $r)) (local.get $b)))
          (br $dispatch)
          ) ;; case 312
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $b (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (global.set $eip (if (result i32) (call $eval_cc (i32.const 5)) (then (local.get $b)) (else (local.get $a))))
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
          ) ;; case 333
          (global.set $edx (call $gl32 (global.get $esp)))
          (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
          (br $dispatch)
          ) ;; case 334
          (global.set $ebx (call $gl32 (global.get $esp)))
          (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
          (br $dispatch)
          ) ;; case 355
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (global.set $eip (call $gl32 (i32.add (local.get $addr) (i32.shl (global.get $eax) (i32.const 2)))))
          (br $block_done)
          (br $dispatch)
          ) ;; case 368
          (global.set $ecx (global.get $eax))
          (br $dispatch)
          ) ;; case 373
          (global.set $edx (global.get $edi))
          (br $dispatch)
          ) ;; case 374
          (local.set $a (global.get $edx))
          (local.set $b (global.get $ecx))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (global.set $edx (local.get $r))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (br $dispatch)
          ) ;; case 378
          (local.set $a (global.get $edi))
          (local.set $b (global.get $ecx))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (global.set $edi (local.get $r))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (br $dispatch)
          ) ;; case 382
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $addr (i32.add (global.get $eax) (local.get $addr)))
          (local.set $a (call $gl8 (local.get $addr)))
          (local.set $b (i32.and (global.get $eax) (i32.const 255)))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (global.set $flag_sign_shift (i32.const 7))
          (call $gs8 (local.get $addr) (local.get $r))
          (br $dispatch)
          ) ;; case 383
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $addr (i32.add (global.get $ecx) (local.get $addr)))
          (local.set $a (call $gl8 (local.get $addr)))
          (local.set $b (i32.and (global.get $eax) (i32.const 255)))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (global.set $flag_sign_shift (i32.const 7))
          (call $gs8 (local.get $addr) (local.get $r))
          (br $dispatch)
          ) ;; case 384
          (local.set $a (i32.and (global.get $edx) (i32.const 255)))
          (local.set $b (i32.and (i32.shr_u (global.get $edx) (i32.const 8)) (i32.const 255)))
          (local.set $r (i32.and (i32.add (local.get $a) (local.get $b)) (i32.const 255)))
          (global.set $edx (i32.or (i32.and (global.get $edx) (i32.const 0xffffff00)) (local.get $r)))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (global.set $flag_sign_shift (i32.const 7))
          (br $dispatch)
        ) ;; fallback
        (call $host_log_i32 (i32.const 0x10CA1BAD))
        (global.set $eip (i32.const 0))
        (br $block_done)))
      (br $main)))
  )
  (func $run_aoe_brtable_subset_direct (export "run_aoe_brtable_subset_direct") (param $max_blocks i32)
    (local $blocks i32) (local $thread i32) (local $ip_v i32)
    (local $scan i32) (local $scan_fn i32) (local $scan_op i32) (local $scan_supported i32)
    (local $fn i32) (local $op i32) (local $addr i32) (local $a i32) (local $b i32) (local $r i32)
    (local.set $blocks (local.get $max_blocks))
    (block $all_done (loop $main
      (br_if $all_done (i32.le_s (local.get $blocks) (i32.const 0)))
      (br_if $all_done (i32.eqz (global.get $eip)))
      (local.set $blocks (i32.sub (local.get $blocks) (i32.const 1)))
      (local.set $thread (call $cache_lookup (global.get $eip)))
      (if (i32.eqz (local.get $thread))
        (then (local.set $thread (call $decode_block (global.get $eip)))))
      ;; Production-shaped fallback: validate the complete decoded block
      ;; before changing guest state. Unsupported blocks restart through $next.
      (local.set $scan (local.get $thread))
      (block $hot_ready
        (block $use_fallback
          (loop $scan_loop
            (local.set $scan_fn (i32.load (local.get $scan)))
            (local.set $scan_op (i32.load offset=4 (local.get $scan)))
            (local.set $scan (i32.add (local.get $scan) (i32.const 8)))
            (local.set $scan_supported (i32.const 0))
            (if (i32.and (i32.eq (local.get $scan_fn) (i32.const 7)) (i32.eq (local.get $scan_op) (i32.const 0)))
              (then
                (local.set $scan_supported (i32.const 1))
                (local.set $scan (i32.add (local.get $scan) (i32.const 4)))
              ))
            (if (i32.and (i32.eq (local.get $scan_fn) (i32.const 11)) (i32.or (i32.eq (local.get $scan_op) (i32.const 16)) (i32.eq (local.get $scan_op) (i32.const 39))))
              (then
                (local.set $scan_supported (i32.const 1))
              ))
            (if (i32.and (i32.eq (local.get $scan_fn) (i32.const 12)) (i32.or (i32.eq (local.get $scan_op) (i32.const 33)) (i32.eq (local.get $scan_op) (i32.const 113))))
              (then
                (local.set $scan_supported (i32.const 1))
              ))
            (if (i32.and (i32.eq (local.get $scan_fn) (i32.const 18)) (i32.eq (local.get $scan_op) (i32.const 0)))
              (then
                (local.set $scan_supported (i32.const 1))
              ))
            (if (i32.and (i32.eq (local.get $scan_fn) (i32.const 20)) (i32.or (i32.eq (local.get $scan_op) (i32.const 3)) (i32.eq (local.get $scan_op) (i32.const 7))))
              (then
                (local.set $scan_supported (i32.const 1))
                (local.set $scan (i32.add (local.get $scan) (i32.const 4)))
              ))
            (if (i32.and (i32.eq (local.get $scan_fn) (i32.const 21)) (i32.or (i32.eq (local.get $scan_op) (i32.const 6)) (i32.eq (local.get $scan_op) (i32.const 7))))
              (then
                (local.set $scan_supported (i32.const 1))
                (local.set $scan (i32.add (local.get $scan) (i32.const 4)))
              ))
            (if (i32.and (i32.eq (local.get $scan_fn) (i32.const 28)) (i32.eq (local.get $scan_op) (i32.const 6)))
              (then
                (local.set $scan_supported (i32.const 1))
                (local.set $scan (i32.add (local.get $scan) (i32.const 4)))
              ))
            (if (i32.eq (local.get $scan_fn) (i32.const 43))
              (then
                (local.set $scan_supported (i32.const 1))
                (local.set $scan (i32.add (local.get $scan) (i32.const 4)))
                (br $hot_ready)
              ))
            (if (i32.and (i32.eq (local.get $scan_fn) (i32.const 48)) (i32.eq (local.get $scan_op) (i32.const 87)))
              (then
                (local.set $scan_supported (i32.const 1))
                (local.set $scan (i32.add (local.get $scan) (i32.const 4)))
              ))
            (if (i32.and (i32.eq (local.get $scan_fn) (i32.const 53)) (i32.eq (local.get $scan_op) (i32.const 263425)))
              (then
                (local.set $scan_supported (i32.const 1))
              ))
            (if (i32.and (i32.eq (local.get $scan_fn) (i32.const 64)) (i32.eq (local.get $scan_op) (i32.const 6)))
              (then
                (local.set $scan_supported (i32.const 1))
              ))
            (if (i32.and (i32.eq (local.get $scan_fn) (i32.const 65)) (i32.eq (local.get $scan_op) (i32.const 2)))
              (then
                (local.set $scan_supported (i32.const 1))
              ))
            (if (i32.and (i32.eq (local.get $scan_fn) (i32.const 128)) (i32.eq (local.get $scan_op) (i32.const 1827)))
              (then
                (local.set $scan_supported (i32.const 1))
                (local.set $scan (i32.add (local.get $scan) (i32.const 4)))
              ))
            (if (i32.and (i32.eq (local.get $scan_fn) (i32.const 312)) (i32.eq (local.get $scan_op) (i32.const 0)))
              (then
                (local.set $scan_supported (i32.const 1))
                (local.set $scan (i32.add (local.get $scan) (i32.const 8)))
                (br $hot_ready)
              ))
            (if (i32.and (i32.eq (local.get $scan_fn) (i32.const 319)) (i32.eq (local.get $scan_op) (i32.const 0)))
              (then
                (local.set $scan_supported (i32.const 1))
                (local.set $scan (i32.add (local.get $scan) (i32.const 8)))
                (br $hot_ready)
              ))
            (if (i32.eq (local.get $scan_fn) (i32.const 355))
              (then
                (local.set $scan_supported (i32.const 1))
                (local.set $scan (i32.add (local.get $scan) (i32.const 4)))
                (br $hot_ready)
              ))
            (br_if $use_fallback (i32.eqz (local.get $scan_supported)))
            (br $scan_loop)))
        ;; No hot instruction ran, so only the thread IP needs restoring.
        (global.set $x86_hot_subset_fallback_blocks
          (i32.add (global.get $x86_hot_subset_fallback_blocks) (i32.const 1)))
        (global.set $ip (local.get $thread))
        (global.set $steps (i32.const 1000))
        (call $next)
        (br $main)
      ) ;; hot_ready
      (global.set $x86_hot_subset_hot_blocks
        (i32.add (global.get $x86_hot_subset_hot_blocks) (i32.const 1)))
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
          (local.set $r (call $do_alu32 (i32.const 4) (global.get $eax) (local.get $a)))
          (global.set $eax (local.get $r))
          (br $dispatch)
          ) ;; case 11
          (if (i32.eq (local.get $op) (i32.const 0x10)) (then (global.set $ecx (global.get $eax))) (else (global.set $edx (global.get $edi))))
          (br $dispatch)
          ) ;; case 12
          (local.set $a (if (result i32) (i32.eq (local.get $op) (i32.const 0x21)) (then (global.get $edx)) (else (global.get $edi))))
          (local.set $b (global.get $ecx))
          (local.set $r (call $do_alu32 (i32.const 0) (local.get $a) (local.get $b)))
          (if (i32.eq (local.get $op) (i32.const 0x21)) (then (global.set $edx (local.get $r))) (else (global.set $edi (local.get $r))))
          (br $dispatch)
          ) ;; case 18
          (local.set $r (call $do_alu32 (i32.const 6) (global.get $eax) (global.get $eax)))
          (global.set $eax (local.get $r))
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
          (local.set $r (call $do_alu32 (i32.const 5) (local.get $a) (local.get $b)))
          (global.set $edi (local.get $r))
          (br $dispatch)
          ) ;; case 53
          (local.set $a (global.get $ecx))
          (local.set $b (i32.const 4))
          (local.set $r (call $do_shift32 (i32.const 5) (local.get $a) (local.get $b)))
          (global.set $ecx (local.get $r))
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
          (local.set $r (call $do_alu32 (i32.const 7) (local.get $a) (local.get $b)))
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
  (func $run_aoe_brtable_cached_generic (export "run_aoe_brtable_cached_generic") (param $max_blocks i32)
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
      ;; Benchmark-only classify-once selector. Bit 0 marks a packet
      ;; already proven compatible with this generated handler subset.
      (if (i32.eqz (i32.and (local.get $thread) (i32.const 1)))
        (then
          (global.set $ip (local.get $thread))
          (global.set $steps (i32.const 1000))
          (call $next)
          (br $main)))
      (local.set $thread (i32.and (local.get $thread) (i32.const -2)))
      (local.set $ip_v (local.get $thread))
      (block $block_done (loop $dispatch
        (local.set $fn (i32.load (local.get $ip_v)))
        (local.set $op (i32.load offset=4 (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 8)))
        (block $fallback
          (block $case_384
          (block $case_383
          (block $case_382
          (block $case_378
          (block $case_374
          (block $case_373
          (block $case_368
          (block $case_355
          (block $case_334
          (block $case_333
          (block $case_319
          (block $case_312
          (block $case_149
          (block $case_129
          (block $case_128
          (block $case_127
          (block $case_94
          (block $case_65
          (block $case_64
          (block $case_53
          (block $case_48
          (block $case_47
          (block $case_43
          (block $case_28
          (block $case_21
          (block $case_20
          (block $case_18
          (block $case_12
          (block $case_11
          (block $case_7
            (br_table $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_7 $fallback $fallback $fallback $case_11 $case_12 $fallback $fallback $fallback $fallback $fallback $case_18 $fallback $case_20 $case_21 $fallback $fallback $fallback $fallback $fallback $fallback $case_28 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_43 $fallback $fallback $fallback $case_47 $case_48 $fallback $fallback $fallback $fallback $case_53 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_64 $case_65 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_94 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_127 $case_128 $case_129 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_149 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_312 $fallback $fallback $fallback $fallback $fallback $fallback $case_319 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_333 $case_334 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_355 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_368 $fallback $fallback $fallback $fallback $case_373 $case_374 $fallback $fallback $fallback $case_378 $fallback $fallback $fallback $case_382 $case_383 $case_384 $fallback (local.get $fn))
          ) ;; case 7
          (local.set $b (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $a (call $get_reg (local.get $op)))
          (local.set $r (i32.and (local.get $a) (local.get $b)))
          (call $set_reg (local.get $op) (local.get $r))
          (call $set_flags_logic (local.get $r))
          (br $dispatch)
          ) ;; case 11
          (call $set_reg (i32.shr_u (local.get $op) (i32.const 4)) (call $get_reg (i32.and (local.get $op) (i32.const 15))))
          (br $dispatch)
          ) ;; case 12
          (local.set $addr (i32.shr_u (local.get $op) (i32.const 4)))
          (local.set $a (call $get_reg (local.get $addr)))
          (local.set $b (call $get_reg (i32.and (local.get $op) (i32.const 15))))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (call $set_reg (local.get $addr) (local.get $r))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (br $dispatch)
          ) ;; case 18
          (local.set $addr (i32.shr_u (local.get $op) (i32.const 4)))
          (local.set $r (i32.xor (call $get_reg (local.get $addr)) (call $get_reg (i32.and (local.get $op) (i32.const 15)))))
          (call $set_reg (local.get $addr) (local.get $r))
          (call $set_flags_logic (local.get $r))
          (br $dispatch)
          ) ;; case 20
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (call $set_reg (local.get $op) (call $gl32 (local.get $addr)))
          (br $dispatch)
          ) ;; case 21
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (call $gs32 (local.get $addr) (call $get_reg (local.get $op)))
          (br $dispatch)
          ) ;; case 28
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (call $set_reg8 (i32.shr_u (local.get $op) (i32.const 4)) (call $gl8 (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr))))
          (br $dispatch)
          ) ;; case 43
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (global.set $eip (local.get $a))
          (br $block_done)
          (br $dispatch)
          ) ;; case 47
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (if (i32.eq (local.get $addr) (global.get $SIB_SENTINEL)) (then (local.set $addr (global.get $ea_temp))))
          (local.set $a (i32.shr_u (local.get $op) (i32.const 4)))
          (local.set $b (i32.and (local.get $op) (i32.const 15)))
          (local.set $r (call $do_alu32 (local.get $a) (call $gl32 (local.get $addr)) (call $get_reg (local.get $b))))
          (if (i32.ne (local.get $a) (i32.const 7)) (then (call $gs32 (local.get $addr) (local.get $r))))
          (br $dispatch)
          ) ;; case 48
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $a (call $get_reg (i32.and (local.get $op) (i32.const 15))))
          (local.set $b (call $gl32 (local.get $addr)))
          (local.set $r (call $do_alu32 (i32.shr_u (local.get $op) (i32.const 4)) (local.get $a) (local.get $b)))
          (if (i32.ne (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 7)) (then (call $set_reg (i32.and (local.get $op) (i32.const 15)) (local.get $r))))
          (br $dispatch)
          ) ;; case 53
          (local.set $addr (i32.and (local.get $op) (i32.const 255)))
          (local.set $a (i32.and (i32.shr_u (local.get $op) (i32.const 16)) (i32.const 255)))
          (if (i32.eq (local.get $a) (i32.const 255)) (then (local.set $a (i32.and (global.get $ecx) (i32.const 31)))))
          (call $set_reg (local.get $addr) (call $do_shift32 (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 255)) (call $get_reg (local.get $addr)) (local.get $a)))
          (br $dispatch)
          ) ;; case 64
          (local.set $a (call $get_reg (local.get $op)))
          (local.set $r (i32.add (local.get $a) (i32.const 1)))
          (call $set_reg (local.get $op) (local.get $r))
          (call $set_flags_inc (local.get $a) (local.get $r))
          (br $dispatch)
          ) ;; case 65
          (local.set $a (call $get_reg (local.get $op)))
          (local.set $r (i32.sub (local.get $a) (i32.const 1)))
          (call $set_reg (local.get $op) (local.get $r))
          (call $set_flags_dec (local.get $a) (local.get $r))
          (br $dispatch)
          ) ;; case 94
          (local.set $a (call $gl8 (global.get $esi)))
          (local.set $b (call $gl8 (global.get $edi)))
          (local.set $r (i32.sub (local.get $a) (local.get $b)))
          (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r))
          (if (global.get $df)
            (then (global.set $esi (i32.sub (global.get $esi) (i32.const 1))) (global.set $edi (i32.sub (global.get $edi) (i32.const 1))))
            (else (global.set $esi (i32.add (global.get $esi) (i32.const 1))) (global.set $edi (i32.add (global.get $edi) (i32.const 1)))))
          (br $dispatch)
          ) ;; case 127
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $addr (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr)))
          (local.set $a (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)))
          (local.set $b (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15)))
          (local.set $r (call $do_alu32 (local.get $a) (call $gl32 (local.get $addr)) (call $get_reg (local.get $b))))
          (if (i32.ne (local.get $a) (i32.const 7)) (then (call $gs32 (local.get $addr) (local.get $r))))
          (br $dispatch)
          ) ;; case 128
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $a (call $get_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15))))
          (local.set $b (call $gl32 (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr))))
          (local.set $r (call $do_alu32 (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)) (local.get $a) (local.get $b)))
          (if (i32.ne (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)) (i32.const 7)) (then (call $set_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15)) (local.get $r))))
          (br $dispatch)
          ) ;; case 129
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $addr (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr)))
          (local.set $a (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)))
          (local.set $b (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15)))
          (local.set $r (call $do_alu32 (local.get $a) (call $gl8 (local.get $addr)) (call $get_reg8 (local.get $b))))
          (global.set $flag_sign_shift (i32.const 7))
          (if (i32.ne (local.get $a) (i32.const 7)) (then (call $gs8 (local.get $addr) (local.get $r))))
          (br $dispatch)
          ) ;; case 149
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $b (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $addr (i32.const 0))
          (local.set $r (i32.const 0))
          (if (i32.ne (i32.and (local.get $a) (i32.const 15)) (i32.const 15)) (then (local.set $addr (call $get_reg (i32.and (local.get $a) (i32.const 15))))))
          (if (i32.ne (i32.and (i32.shr_u (local.get $a) (i32.const 4)) (i32.const 15)) (i32.const 15))
            (then (local.set $r (i32.shl (call $get_reg (i32.and (i32.shr_u (local.get $a) (i32.const 4)) (i32.const 15))) (i32.and (i32.shr_u (local.get $a) (i32.const 8)) (i32.const 3))))))
          (global.set $ea_temp (i32.add (i32.add (local.get $addr) (local.get $r)) (local.get $b)))
          (br $dispatch)
          ) ;; case 312
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $b (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (global.set $eip (if (result i32) (call $eval_cc (i32.const 5)) (then (local.get $b)) (else (local.get $a))))
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
          ) ;; case 333
          (global.set $edx (call $gl32 (global.get $esp)))
          (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
          (br $dispatch)
          ) ;; case 334
          (global.set $ebx (call $gl32 (global.get $esp)))
          (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
          (br $dispatch)
          ) ;; case 355
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (global.set $eip (call $gl32 (i32.add (local.get $addr) (i32.shl (global.get $eax) (i32.const 2)))))
          (br $block_done)
          (br $dispatch)
          ) ;; case 368
          (global.set $ecx (global.get $eax))
          (br $dispatch)
          ) ;; case 373
          (global.set $edx (global.get $edi))
          (br $dispatch)
          ) ;; case 374
          (local.set $a (global.get $edx))
          (local.set $b (global.get $ecx))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (global.set $edx (local.get $r))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (br $dispatch)
          ) ;; case 378
          (local.set $a (global.get $edi))
          (local.set $b (global.get $ecx))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (global.set $edi (local.get $r))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (br $dispatch)
          ) ;; case 382
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $addr (i32.add (global.get $eax) (local.get $addr)))
          (local.set $a (call $gl8 (local.get $addr)))
          (local.set $b (i32.and (global.get $eax) (i32.const 255)))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (global.set $flag_sign_shift (i32.const 7))
          (call $gs8 (local.get $addr) (local.get $r))
          (br $dispatch)
          ) ;; case 383
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $addr (i32.add (global.get $ecx) (local.get $addr)))
          (local.set $a (call $gl8 (local.get $addr)))
          (local.set $b (i32.and (global.get $eax) (i32.const 255)))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (global.set $flag_sign_shift (i32.const 7))
          (call $gs8 (local.get $addr) (local.get $r))
          (br $dispatch)
          ) ;; case 384
          (local.set $a (i32.and (global.get $edx) (i32.const 255)))
          (local.set $b (i32.and (i32.shr_u (global.get $edx) (i32.const 8)) (i32.const 255)))
          (local.set $r (i32.and (i32.add (local.get $a) (local.get $b)) (i32.const 255)))
          (global.set $edx (i32.or (i32.and (global.get $edx) (i32.const 0xffffff00)) (local.get $r)))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (global.set $flag_sign_shift (i32.const 7))
          (br $dispatch)
        ) ;; fallback
        (call $host_log_i32 (i32.const 0x10CA1BAD))
        (global.set $eip (i32.const 0))
        (br $block_done)))
      (br $main)))
  )
  (func $run_x86_hot_subset_cached_generic (export "run_x86_hot_subset_cached_generic") (param $max_blocks i32)
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
      (if (i32.eqz (call $x86_hot_cache_is_hot (global.get $eip)))
        (then
          (global.set $x86_hot_subset_fallback_blocks
            (i32.add (global.get $x86_hot_subset_fallback_blocks) (i32.const 1)))
          (global.set $ip (local.get $thread))
          (global.set $steps (i32.const 1000))
          (call $next)
          (br $main)))
      (global.set $x86_hot_subset_hot_blocks
        (i32.add (global.get $x86_hot_subset_hot_blocks) (i32.const 1)))
      (local.set $ip_v (local.get $thread))
      (block $block_done (loop $dispatch
        (local.set $fn (i32.load (local.get $ip_v)))
        (local.set $op (i32.load offset=4 (local.get $ip_v)))
        (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 8)))
        (block $fallback
          (block $case_384
          (block $case_383
          (block $case_382
          (block $case_378
          (block $case_374
          (block $case_373
          (block $case_368
          (block $case_355
          (block $case_334
          (block $case_333
          (block $case_319
          (block $case_312
          (block $case_149
          (block $case_129
          (block $case_128
          (block $case_127
          (block $case_94
          (block $case_65
          (block $case_64
          (block $case_53
          (block $case_48
          (block $case_47
          (block $case_43
          (block $case_28
          (block $case_21
          (block $case_20
          (block $case_18
          (block $case_12
          (block $case_11
          (block $case_7
            (br_table $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_7 $fallback $fallback $fallback $case_11 $case_12 $fallback $fallback $fallback $fallback $fallback $case_18 $fallback $case_20 $case_21 $fallback $fallback $fallback $fallback $fallback $fallback $case_28 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_43 $fallback $fallback $fallback $case_47 $case_48 $fallback $fallback $fallback $fallback $case_53 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_64 $case_65 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_94 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_127 $case_128 $case_129 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_149 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_312 $fallback $fallback $fallback $fallback $fallback $fallback $case_319 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_333 $case_334 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_355 $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $fallback $case_368 $fallback $fallback $fallback $fallback $case_373 $case_374 $fallback $fallback $fallback $case_378 $fallback $fallback $fallback $case_382 $case_383 $case_384 $fallback (local.get $fn))
          ) ;; case 7
          (local.set $b (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $a (call $get_reg (local.get $op)))
          (local.set $r (i32.and (local.get $a) (local.get $b)))
          (call $set_reg (local.get $op) (local.get $r))
          (call $set_flags_logic (local.get $r))
          (br $dispatch)
          ) ;; case 11
          (call $set_reg (i32.shr_u (local.get $op) (i32.const 4)) (call $get_reg (i32.and (local.get $op) (i32.const 15))))
          (br $dispatch)
          ) ;; case 12
          (local.set $addr (i32.shr_u (local.get $op) (i32.const 4)))
          (local.set $a (call $get_reg (local.get $addr)))
          (local.set $b (call $get_reg (i32.and (local.get $op) (i32.const 15))))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (call $set_reg (local.get $addr) (local.get $r))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (br $dispatch)
          ) ;; case 18
          (local.set $addr (i32.shr_u (local.get $op) (i32.const 4)))
          (local.set $r (i32.xor (call $get_reg (local.get $addr)) (call $get_reg (i32.and (local.get $op) (i32.const 15)))))
          (call $set_reg (local.get $addr) (local.get $r))
          (call $set_flags_logic (local.get $r))
          (br $dispatch)
          ) ;; case 20
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (call $set_reg (local.get $op) (call $gl32 (local.get $addr)))
          (br $dispatch)
          ) ;; case 21
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (call $gs32 (local.get $addr) (call $get_reg (local.get $op)))
          (br $dispatch)
          ) ;; case 28
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (call $set_reg8 (i32.shr_u (local.get $op) (i32.const 4)) (call $gl8 (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr))))
          (br $dispatch)
          ) ;; case 43
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (global.set $eip (local.get $a))
          (br $block_done)
          (br $dispatch)
          ) ;; case 47
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (if (i32.eq (local.get $addr) (global.get $SIB_SENTINEL)) (then (local.set $addr (global.get $ea_temp))))
          (local.set $a (i32.shr_u (local.get $op) (i32.const 4)))
          (local.set $b (i32.and (local.get $op) (i32.const 15)))
          (local.set $r (call $do_alu32 (local.get $a) (call $gl32 (local.get $addr)) (call $get_reg (local.get $b))))
          (if (i32.ne (local.get $a) (i32.const 7)) (then (call $gs32 (local.get $addr) (local.get $r))))
          (br $dispatch)
          ) ;; case 48
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $a (call $get_reg (i32.and (local.get $op) (i32.const 15))))
          (local.set $b (call $gl32 (local.get $addr)))
          (local.set $r (call $do_alu32 (i32.shr_u (local.get $op) (i32.const 4)) (local.get $a) (local.get $b)))
          (if (i32.ne (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 7)) (then (call $set_reg (i32.and (local.get $op) (i32.const 15)) (local.get $r))))
          (br $dispatch)
          ) ;; case 53
          (local.set $addr (i32.and (local.get $op) (i32.const 255)))
          (local.set $a (i32.and (i32.shr_u (local.get $op) (i32.const 16)) (i32.const 255)))
          (if (i32.eq (local.get $a) (i32.const 255)) (then (local.set $a (i32.and (global.get $ecx) (i32.const 31)))))
          (call $set_reg (local.get $addr) (call $do_shift32 (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 255)) (call $get_reg (local.get $addr)) (local.get $a)))
          (br $dispatch)
          ) ;; case 64
          (local.set $a (call $get_reg (local.get $op)))
          (local.set $r (i32.add (local.get $a) (i32.const 1)))
          (call $set_reg (local.get $op) (local.get $r))
          (call $set_flags_inc (local.get $a) (local.get $r))
          (br $dispatch)
          ) ;; case 65
          (local.set $a (call $get_reg (local.get $op)))
          (local.set $r (i32.sub (local.get $a) (i32.const 1)))
          (call $set_reg (local.get $op) (local.get $r))
          (call $set_flags_dec (local.get $a) (local.get $r))
          (br $dispatch)
          ) ;; case 94
          (local.set $a (call $gl8 (global.get $esi)))
          (local.set $b (call $gl8 (global.get $edi)))
          (local.set $r (i32.sub (local.get $a) (local.get $b)))
          (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r))
          (if (global.get $df)
            (then (global.set $esi (i32.sub (global.get $esi) (i32.const 1))) (global.set $edi (i32.sub (global.get $edi) (i32.const 1))))
            (else (global.set $esi (i32.add (global.get $esi) (i32.const 1))) (global.set $edi (i32.add (global.get $edi) (i32.const 1)))))
          (br $dispatch)
          ) ;; case 127
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $addr (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr)))
          (local.set $a (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)))
          (local.set $b (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15)))
          (local.set $r (call $do_alu32 (local.get $a) (call $gl32 (local.get $addr)) (call $get_reg (local.get $b))))
          (if (i32.ne (local.get $a) (i32.const 7)) (then (call $gs32 (local.get $addr) (local.get $r))))
          (br $dispatch)
          ) ;; case 128
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $a (call $get_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15))))
          (local.set $b (call $gl32 (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr))))
          (local.set $r (call $do_alu32 (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)) (local.get $a) (local.get $b)))
          (if (i32.ne (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)) (i32.const 7)) (then (call $set_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15)) (local.get $r))))
          (br $dispatch)
          ) ;; case 129
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $addr (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 15))) (local.get $addr)))
          (local.set $a (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 15)))
          (local.set $b (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 15)))
          (local.set $r (call $do_alu32 (local.get $a) (call $gl8 (local.get $addr)) (call $get_reg8 (local.get $b))))
          (global.set $flag_sign_shift (i32.const 7))
          (if (i32.ne (local.get $a) (i32.const 7)) (then (call $gs8 (local.get $addr) (local.get $r))))
          (br $dispatch)
          ) ;; case 149
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $b (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $addr (i32.const 0))
          (local.set $r (i32.const 0))
          (if (i32.ne (i32.and (local.get $a) (i32.const 15)) (i32.const 15)) (then (local.set $addr (call $get_reg (i32.and (local.get $a) (i32.const 15))))))
          (if (i32.ne (i32.and (i32.shr_u (local.get $a) (i32.const 4)) (i32.const 15)) (i32.const 15))
            (then (local.set $r (i32.shl (call $get_reg (i32.and (i32.shr_u (local.get $a) (i32.const 4)) (i32.const 15))) (i32.and (i32.shr_u (local.get $a) (i32.const 8)) (i32.const 3))))))
          (global.set $ea_temp (i32.add (i32.add (local.get $addr) (local.get $r)) (local.get $b)))
          (br $dispatch)
          ) ;; case 312
          (local.set $a (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $b (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (global.set $eip (if (result i32) (call $eval_cc (i32.const 5)) (then (local.get $b)) (else (local.get $a))))
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
          ) ;; case 333
          (global.set $edx (call $gl32 (global.get $esp)))
          (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
          (br $dispatch)
          ) ;; case 334
          (global.set $ebx (call $gl32 (global.get $esp)))
          (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
          (br $dispatch)
          ) ;; case 355
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (global.set $eip (call $gl32 (i32.add (local.get $addr) (i32.shl (global.get $eax) (i32.const 2)))))
          (br $block_done)
          (br $dispatch)
          ) ;; case 368
          (global.set $ecx (global.get $eax))
          (br $dispatch)
          ) ;; case 373
          (global.set $edx (global.get $edi))
          (br $dispatch)
          ) ;; case 374
          (local.set $a (global.get $edx))
          (local.set $b (global.get $ecx))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (global.set $edx (local.get $r))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (br $dispatch)
          ) ;; case 378
          (local.set $a (global.get $edi))
          (local.set $b (global.get $ecx))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (global.set $edi (local.get $r))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (br $dispatch)
          ) ;; case 382
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $addr (i32.add (global.get $eax) (local.get $addr)))
          (local.set $a (call $gl8 (local.get $addr)))
          (local.set $b (i32.and (global.get $eax) (i32.const 255)))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (global.set $flag_sign_shift (i32.const 7))
          (call $gs8 (local.get $addr) (local.get $r))
          (br $dispatch)
          ) ;; case 383
          (local.set $addr (i32.load (local.get $ip_v)))
          (local.set $ip_v (i32.add (local.get $ip_v) (i32.const 4)))
          (local.set $addr (i32.add (global.get $ecx) (local.get $addr)))
          (local.set $a (call $gl8 (local.get $addr)))
          (local.set $b (i32.and (global.get $eax) (i32.const 255)))
          (local.set $r (i32.add (local.get $a) (local.get $b)))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (global.set $flag_sign_shift (i32.const 7))
          (call $gs8 (local.get $addr) (local.get $r))
          (br $dispatch)
          ) ;; case 384
          (local.set $a (i32.and (global.get $edx) (i32.const 255)))
          (local.set $b (i32.and (i32.shr_u (global.get $edx) (i32.const 8)) (i32.const 255)))
          (local.set $r (i32.and (i32.add (local.get $a) (local.get $b)) (i32.const 255)))
          (global.set $edx (i32.or (i32.and (global.get $edx) (i32.const 0xffffff00)) (local.get $r)))
          (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
          (global.set $flag_sign_shift (i32.const 7))
          (br $dispatch)
        ) ;; fallback
        (call $host_log_i32 (i32.const 0x10CA1BAD))
        (global.set $eip (i32.const 0))
        (br $block_done)))
      (br $main)))
  )
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
