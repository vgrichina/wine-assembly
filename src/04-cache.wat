  ;; ============================================================
  ;; BLOCK CACHE
  ;; ============================================================
  (func $cache_lookup (param $ga i32) (result i32)
    (local $idx i32)
    (local.set $idx (i32.add (global.get $CACHE_INDEX)
      (i32.mul (i32.and (i32.shr_u (local.get $ga) (i32.const 2)) (global.get $CACHE_MASK)) (i32.const 8))))
    (if (result i32) (i32.eq (i32.load (local.get $idx)) (local.get $ga))
      (then (i32.load offset=4 (local.get $idx)))
      (else (i32.const 0))))
  (func $cache_store (param $ga i32) (param $off i32)
    (local $idx i32) (local $page i32) (local $page_end i32) (local $should_track i32)
    (local.set $idx (i32.add (global.get $CACHE_INDEX)
      (i32.mul (i32.and (i32.shr_u (local.get $ga) (i32.const 2)) (global.get $CACHE_MASK)) (i32.const 8))))
    (i32.store (local.get $idx) (local.get $ga))
    (i32.store offset=4 (local.get $idx) (local.get $off))
    (local.set $should_track
      (i32.and
        (i32.ne (global.get $exe_size_of_image) (i32.const 0))
        (i32.and
          (i32.ge_u (local.get $ga) (global.get $image_base))
          (i32.and
            (i32.lt_u (local.get $ga) (i32.add (global.get $image_base) (global.get $exe_size_of_image)))
            (i32.or (i32.lt_u (local.get $ga) (global.get $code_start))
                    (i32.ge_u (local.get $ga) (global.get $code_end))))))))
    (if (local.get $should_track)
      (then
        (local.set $page (i32.and (local.get $ga) (i32.const 0xFFFFF000)))
        (local.set $page_end (i32.add (local.get $page) (i32.const 0x1000)))
        (if (i32.or (i32.eqz (global.get $generated_code_start))
                    (i32.lt_u (local.get $page) (global.get $generated_code_start)))
          (then (global.set $generated_code_start (local.get $page))))
        (if (i32.gt_u (local.get $page_end) (global.get $generated_code_end))
          (then (global.set $generated_code_end (local.get $page_end))))))
  (func $clear_cache
    (local $i i32)
    (local.set $i (i32.const 0))
    (block $d (loop $s
      (br_if $d (i32.ge_u (local.get $i) (global.get $CACHE_SIZE)))
      (i32.store (i32.add (global.get $CACHE_INDEX) (i32.mul (local.get $i) (i32.const 8))) (i32.const 0))
      (i32.store offset=4 (i32.add (global.get $CACHE_INDEX) (i32.mul (local.get $i) (i32.const 8))) (i32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $s))))
  (func $invalidate_page (param $ga i32)
    (local $page i32) (local $i i32) (local $idx i32)
    (local.set $page (i32.and (local.get $ga) (i32.const 0xFFFFF000)))
    (local.set $i (i32.const 0))
    (block $d (loop $s
      (br_if $d (i32.ge_u (local.get $i) (global.get $CACHE_SIZE)))
      (local.set $idx (i32.add (global.get $CACHE_INDEX) (i32.mul (local.get $i) (i32.const 8))))
      (if (i32.eq (i32.and (i32.load (local.get $idx)) (i32.const 0xFFFFF000)) (local.get $page))
        (then (i32.store (local.get $idx) (i32.const 0)) (i32.store offset=4 (local.get $idx) (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $s))))

  ;; Thread emit helpers
  (func $te (param $fn i32) (param $op i32)
    ;; Inline overflow check — reset this thread's decoded arena before THREAD_END.
    (if (i32.ge_u (global.get $thread_alloc) (i32.sub (global.get $THREAD_END) (i32.const 4096)))
      (then
        (call $host_log_i32 (i32.const 0xCA00F10F))  ;; 0xCA00F10F = cache overflow marker
        (global.set $thread_alloc (global.get $THREAD_BASE))
        (call $clear_cache)))
    (i32.store (global.get $thread_alloc) (local.get $fn))
    (i32.store offset=4 (global.get $thread_alloc) (local.get $op))
    (global.set $thread_alloc (i32.add (global.get $thread_alloc) (i32.const 8))))
  (func $te_raw (param $v i32)
    (i32.store (global.get $thread_alloc) (local.get $v))
    (global.set $thread_alloc (i32.add (global.get $thread_alloc) (i32.const 4))))

  ;; ============================================================
  ;; FORTH INNER INTERPRETER
  ;; ============================================================
  (func $next
    (local $fn i32) (local $op i32)
    (global.set $steps (i32.sub (global.get $steps) (i32.const 1)))
    (if (i32.le_s (global.get $steps) (i32.const 0)) (then (return)))
    (local.set $fn (i32.load (global.get $ip)))
    (local.set $op (i32.load offset=4 (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 8)))
    ;; Defensive: if cache is corrupted (bad handler index), drop the
    ;; whole cache and restart at $eip. The fresh decode will produce
    ;; valid threaded code. This recovers from rare corruption rather
    ;; than trapping with wasm "table index out of bounds".
    (if (i32.ge_u (local.get $fn) (i32.const 356))
      (then
        (call $host_log_i32 (i32.const 0xCAC4BAD0))
        (call $host_log_i32 (local.get $fn))
        (call $host_log_i32 (global.get $eip))
        (global.set $thread_alloc (global.get $THREAD_BASE))
        (call $clear_cache)
        (return)))
    (if (global.get $handler_hist_enabled)
      (then (call $handler_hist_record (local.get $fn))))
    (call_indirect (type $handler_t) (local.get $op) (local.get $fn)))

  ;; Read next thread i32 and advance $ip
  (func $read_thread_word (result i32)
    (local $v i32)
    (local.set $v (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (local.get $v))

  (func $handler_hist_record (param $fn i32)
    (local $addr i32) (local $prev i32)
    (local.set $addr
      (i32.add (global.get $HANDLER_HIST_COUNTS)
        (i32.shl (local.get $fn) (i32.const 2))))
    (i32.store (local.get $addr)
      (i32.add (i32.load (local.get $addr)) (i32.const 1)))
    (local.set $prev (global.get $handler_hist_last))
    (if (i32.ge_s (local.get $prev) (i32.const 0))
      (then
        (local.set $addr
          (i32.add (global.get $HANDLER_PAIR_HIST_COUNTS)
            (i32.shl
              (i32.add
                (i32.mul (local.get $prev) (global.get $HANDLER_HIST_COUNT))
                (local.get $fn))
              (i32.const 2))))
        (i32.store (local.get $addr)
          (i32.add (i32.load (local.get $addr)) (i32.const 1)))))
    (if (i32.and
          (i32.ne (local.get $fn) (i32.const 44))
          (i32.or
            (i32.lt_u (local.get $fn) (i32.const 307))
            (i32.gt_u (local.get $fn) (i32.const 322))))
      (then (global.set $branch_hist_kind (i32.const 0))))
    (global.set $handler_hist_last (local.get $fn)))

  (func $hot_block_hist_record (param $addr i32)
    (local $slot i32) (local $ptr i32) (local $i i32) (local $cur i32)
    ;; Four-way direct bucket keyed by block-entry EIP.
    (local.set $slot
      (i32.and
        (i32.shr_u (local.get $addr) (i32.const 2))
        (i32.const 0x7FFC)))
    (local.set $ptr
      (i32.add (global.get $HOT_BLOCK_HIST)
        (i32.shl (local.get $slot) (i32.const 3))))
    (local.set $i (i32.const 0))
    (block $done (loop $probe
      (local.set $cur (i32.load (local.get $ptr)))
      (if (i32.or
            (i32.eq (local.get $cur) (local.get $addr))
            (i32.eqz (local.get $cur)))
        (then
          (if (i32.eqz (local.get $cur))
            (then (i32.store (local.get $ptr) (local.get $addr))))
          (i32.store offset=4 (local.get $ptr)
            (i32.add (i32.load offset=4 (local.get $ptr)) (i32.const 1)))
          (br $done)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $done (i32.ge_u (local.get $i) (i32.const 4)))
      (local.set $ptr (i32.add (local.get $ptr) (i32.const 8)))
      (br $probe)))
    (if (i32.ge_u (local.get $i) (i32.const 4))
      (then
        (global.set $hot_block_hist_collisions
          (i32.add (global.get $hot_block_hist_collisions) (i32.const 1))))))

  (func $sib_consumer_hist_record (param $fn i32) (param $op i32) (param $info i32)
    (local $key i32) (local $slot i32) (local $ptr i32) (local $i i32) (local $cur i32)
    (global.set $sib_consumer_hist_total
      (i32.add (global.get $sib_consumer_hist_total) (i32.const 1)))
    ;; key: fn:9 | op:9 | base:4 | index:4 | scale:2 | low marker bit
    (local.set $key (i32.const 1))
    (local.set $key
      (i32.or (local.get $key)
        (i32.shl (i32.and (local.get $fn) (i32.const 0x1FF)) (i32.const 23))))
    (local.set $key
      (i32.or (local.get $key)
        (i32.shl (i32.and (local.get $op) (i32.const 0x1FF)) (i32.const 14))))
    (local.set $key
      (i32.or (local.get $key)
        (i32.shl (i32.and (local.get $info) (i32.const 0xF)) (i32.const 10))))
    (local.set $key
      (i32.or (local.get $key)
        (i32.shl
          (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF))
          (i32.const 6))))
    (local.set $key
      (i32.or (local.get $key)
        (i32.shl
          (i32.and (i32.shr_u (local.get $info) (i32.const 8)) (i32.const 3))
          (i32.const 4))))
    (local.set $slot
      (i32.and
        (i32.xor (local.get $key) (i32.shr_u (local.get $key) (i32.const 16)))
        (i32.const 0x1FFC)))
    (local.set $ptr
      (i32.add (global.get $SIB_CONSUMER_HIST)
        (i32.shl (local.get $slot) (i32.const 3))))
    (local.set $i (i32.const 0))
    (block $done (loop $probe
      (local.set $cur (i32.load (local.get $ptr)))
      (if (i32.or
            (i32.eq (local.get $cur) (local.get $key))
            (i32.eqz (local.get $cur)))
        (then
          (if (i32.eqz (local.get $cur))
            (then (i32.store (local.get $ptr) (local.get $key))))
          (i32.store offset=4 (local.get $ptr)
            (i32.add (i32.load offset=4 (local.get $ptr)) (i32.const 1)))
          (br $done)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $done (i32.ge_u (local.get $i) (i32.const 4)))
      (local.set $ptr (i32.add (local.get $ptr) (i32.const 8)))
      (br $probe)))
    (if (i32.ge_u (local.get $i) (i32.const 4))
      (then
        (global.set $sib_consumer_hist_collisions
          (i32.add (global.get $sib_consumer_hist_collisions) (i32.const 1))))))

  (func $branch_hist_set (param $kind i32) (param $operand i32)
    (if (global.get $handler_hist_enabled)
      (then
        (global.set $branch_hist_kind (local.get $kind))
        (global.set $branch_hist_operand (local.get $operand)))))

  (func $branch_hist_record_jcc (param $cc i32)
    (local $base i32) (local $idx i32) (local $kind i32)
    (if (i32.eqz (global.get $handler_hist_enabled))
      (then (return)))
    (local.set $kind (global.get $branch_hist_kind))
    (if (i32.eq (local.get $kind) (i32.const 1))
      (then
        (local.set $base (global.get $BRANCH_CMP_JCC_HIST))
        (local.set $idx
          (i32.add
            (i32.shl (i32.and (local.get $cc) (i32.const 0xF)) (i32.const 6))
            (i32.and (global.get $branch_hist_operand) (i32.const 0x3F))))))
    (if (i32.eq (local.get $kind) (i32.const 2))
      (then
        (local.set $base (global.get $BRANCH_TEST_JCC_HIST))
        (local.set $idx
          (i32.add
            (i32.shl (i32.and (local.get $cc) (i32.const 0xF)) (i32.const 6))
            (i32.and (global.get $branch_hist_operand) (i32.const 0x3F))))))
    (if (i32.eq (local.get $kind) (i32.const 3))
      (then
        (local.set $base (global.get $BRANCH_ALU_M32_RO_JCC_HIST))
        (local.set $idx
          (i32.add
            (i32.shl (i32.and (local.get $cc) (i32.const 0xF)) (i32.const 9))
            (i32.and (global.get $branch_hist_operand) (i32.const 0x1FF))))))
    (if (local.get $base)
      (then
        (local.set $base (i32.add (local.get $base) (i32.shl (local.get $idx) (i32.const 2))))
        (i32.store (local.get $base)
          (i32.add (i32.load (local.get $base)) (i32.const 1)))))
    (global.set $branch_hist_kind (i32.const 0)))
