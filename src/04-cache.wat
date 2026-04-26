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
    (local $idx i32)
    (local.set $idx (i32.add (global.get $CACHE_INDEX)
      (i32.mul (i32.and (i32.shr_u (local.get $ga) (i32.const 2)) (global.get $CACHE_MASK)) (i32.const 8))))
    (i32.store (local.get $idx) (local.get $ga))
    (i32.store offset=4 (local.get $idx) (local.get $off)))
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
    ;; Inline overflow check — reset cache if within 4KB of CACHE_INDEX
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
    (if (i32.ge_u (local.get $fn) (i32.const 281))
      (then
        (call $host_log_i32 (i32.const 0xCAC4BAD0))
        (call $host_log_i32 (local.get $fn))
        (call $host_log_i32 (global.get $eip))
        (global.set $thread_alloc (global.get $THREAD_BASE))
        (call $clear_cache)
        (return)))
    (call_indirect (type $handler_t) (local.get $op) (local.get $fn)))

  ;; Read next thread i32 and advance $ip
  (func $read_thread_word (result i32)
    (local $v i32)
    (local.set $v (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (local.get $v))

