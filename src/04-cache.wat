  ;; ============================================================
  ;; BLOCK CACHE
  ;; ============================================================
  ;; Executed sparse VirtualAlloc pages are a second self-modifying-code
  ;; domain. StarCraft builds and rewrites its palette blitters immediately
  ;; below 0x50000000; the older generated_code_* range only covers pages
  ;; inside the PE image and therefore left those decoded blocks stale.
  (global $generated_sparse_code_start (mut i32) (i32.const 0))
  (global $generated_sparse_code_end   (mut i32) (i32.const 0))

  ;; Page-granular record of where code has actually been decoded from. The
  ;; two ranges above are min/max spans, so they cannot describe generated code
  ;; that lands in the middle of the ordinary heap without also covering every
  ;; framebuffer and data allocation between the ends of the span — which would
  ;; put a full cache scan on every pixel write. A bitmap costs one byte load
  ;; per store and is exact.
  (func $code_page_mark (param $ga i32)
    (local $pi i32) (local $ba i32)
    (local.set $pi (i32.shr_u (local.get $ga) (i32.const 12)))
    (if (i32.ge_u (local.get $pi) (global.get $CODE_PAGE_BITMAP_PAGES)) (then (return)))
    (local.set $ba (i32.add (global.get $CODE_PAGE_BITMAP) (i32.shr_u (local.get $pi) (i32.const 3))))
    (i32.store8 (local.get $ba)
      (i32.or (i32.load8_u (local.get $ba))
              (i32.shl (i32.const 1) (i32.and (local.get $pi) (i32.const 7))))))

  (func $code_page_test (param $ga i32) (result i32)
    (local $pi i32)
    (local.set $pi (i32.shr_u (local.get $ga) (i32.const 12)))
    (if (i32.ge_u (local.get $pi) (global.get $CODE_PAGE_BITMAP_PAGES))
      (then (return (i32.const 0))))
    (i32.and
      (i32.shr_u
        (i32.load8_u (i32.add (global.get $CODE_PAGE_BITMAP) (i32.shr_u (local.get $pi) (i32.const 3))))
        (i32.and (local.get $pi) (i32.const 7)))
      (i32.const 1)))

  ;; Slot for a guest address. This used to be (ga>>2)&MASK, which throws away
  ;; the two low bits -- fine for a machine with 4-byte instructions, wrong for
  ;; x86, where basic blocks start on any byte. Blocks 1-3 bytes apart shared a
  ;; slot and evicted each other on every entry: in Liquid War the pair
  ;; 0x466874/0x466877, 6.2M entries each, accounted for most of 14.4M block
  ;; decodes in a 9000-batch run, and the arena those re-decodes burn (a
  ;; re-decode allocates fresh space and never reclaims the old copy) drove
  ;; 147 full cache wipes on top. Index on the whole address, folding the bits
  ;; above the index width back in so a fixed 16KB stride does not alias
  ;; either.
  (func $cache_slot (param $ga i32) (result i32)
    (i32.add (global.get $CACHE_INDEX)
      (i32.mul
        (i32.and
          (i32.xor (local.get $ga) (i32.shr_u (local.get $ga) (i32.const 12)))
          (global.get $CACHE_MASK))
        (i32.const 8))))

  (func $cache_lookup (param $ga i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $cache_slot (local.get $ga)))
    (if (result i32) (i32.eq (i32.load (local.get $idx)) (local.get $ga))
      (then (i32.load offset=4 (local.get $idx)))
      (else (i32.const 0))))
  (func $cache_store (param $ga i32) (param $off i32)
    (local $idx i32) (local $page i32) (local $page_end i32) (local $should_track i32)
    (local.set $idx (call $cache_slot (local.get $ga)))
    ;; Tells conflict/capacity misses (slot held a different block) apart from
    ;; compulsory ones (slot empty -- code being decoded for the first time,
    ;; e.g. a runtime-generated blitter). Both re-fill the arena, but only the
    ;; first is fixable by making the cache bigger or its index smarter.
    (global.set $cache_stores (i32.add (global.get $cache_stores) (i32.const 1)))
    (if (i32.and (i32.ne (i32.load (local.get $idx)) (i32.const 0))
                 (i32.ne (i32.load (local.get $idx)) (local.get $ga)))
      (then (global.set $cache_evicts (i32.add (global.get $cache_evicts) (i32.const 1)))))
    (i32.store (local.get $idx) (local.get $ga))
    (i32.store offset=4 (local.get $idx) (local.get $off))
    (call $code_page_mark (local.get $ga))
    (local.set $should_track
      (i32.and
        (i32.ne (global.get $exe_size_of_image) (i32.const 0))
        (i32.and
          (i32.ge_u (local.get $ga) (global.get $image_base))
          (i32.and
            (i32.lt_u (local.get $ga) (i32.add (global.get $image_base) (global.get $exe_size_of_image)))
            (i32.or (i32.lt_u (local.get $ga) (global.get $code_start))
                    (i32.ge_u (local.get $ga) (global.get $code_end)))))))
    (if (local.get $should_track)
      (then
        (local.set $page (i32.and (local.get $ga) (i32.const 0xFFFFF000)))
        (local.set $page_end (i32.add (local.get $page) (i32.const 0x1000)))
        (if (i32.or (i32.eqz (global.get $generated_code_start))
                    (i32.lt_u (local.get $page) (global.get $generated_code_start)))
          (then (global.set $generated_code_start (local.get $page))))
        (if (i32.gt_u (local.get $page_end) (global.get $generated_code_end))
          (then (global.set $generated_code_end (local.get $page_end))))))
    ;; Sparse VirtualAlloc code sits outside image_base..SizeOfImage, so track
    ;; it independently rather than widening generated_code_* across hundreds
    ;; of megabytes of ordinary heap/framebuffer writes.
    (if (i32.and
          (i32.ge_u (local.get $ga) (global.get $VIRTUAL_ALLOC_MIN))
          (i32.lt_u (local.get $ga) (global.get $VIRTUAL_ALLOC_TOP_INIT)))
      (then
        (local.set $page (i32.and (local.get $ga) (i32.const 0xFFFFF000)))
        (local.set $page_end (i32.add (local.get $page) (i32.const 0x1000)))
        (if (i32.or (i32.eqz (global.get $generated_sparse_code_start))
                    (i32.lt_u (local.get $page) (global.get $generated_sparse_code_start)))
          (then (global.set $generated_sparse_code_start (local.get $page))))
        (if (i32.gt_u (local.get $page_end) (global.get $generated_sparse_code_end))
          (then (global.set $generated_sparse_code_end (local.get $page_end)))))))
  ;; Every full cache wipe throws away all decoded code and forces the whole
  ;; working set to be re-decoded. One at startup is normal; thousands mean the
  ;; arena is too small for the app's hot set and the interpreter is spending
  ;; its time in the decoder. Nothing else in the emulator reports that, so
  ;; count it and export the count.
  (global $cache_clears (mut i32) (i32.const 0))
  (global $cache_stores (mut i32) (i32.const 0))
  (global $cache_evicts (mut i32) (i32.const 0))

  (func $clear_cache
    (local $i i32)
    (global.set $cache_clears (i32.add (global.get $cache_clears) (i32.const 1)))
    (local.set $i (i32.const 0))
    (block $d (loop $s
      (br_if $d (i32.ge_u (local.get $i) (global.get $CACHE_SIZE)))
      (i32.store (i32.add (global.get $CACHE_INDEX) (i32.mul (local.get $i) (i32.const 8))) (i32.const 0))
      (i32.store offset=4 (i32.add (global.get $CACHE_INDEX) (i32.mul (local.get $i) (i32.const 8))) (i32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $s))))
  (func $code_page_clear (param $ga i32)
    (local $pi i32) (local $ba i32)
    (local.set $pi (i32.shr_u (local.get $ga) (i32.const 12)))
    (if (i32.ge_u (local.get $pi) (global.get $CODE_PAGE_BITMAP_PAGES)) (then (return)))
    (local.set $ba (i32.add (global.get $CODE_PAGE_BITMAP) (i32.shr_u (local.get $pi) (i32.const 3))))
    (i32.store8 (local.get $ba)
      (i32.and (i32.load8_u (local.get $ba))
               (i32.xor (i32.shl (i32.const 1) (i32.and (local.get $pi) (i32.const 7)))
                        (i32.const 0xFF)))))

  ;; Companion to $cache_clears: a page invalidation is cheap on its own, but a
  ;; data variable that happens to share a 4KB page with hot code turns every
  ;; write to it into a re-decode of that code, and the arena it burns is never
  ;; reclaimed. $cache_inval_hits counts only the invalidations that actually
  ;; dropped a cached block, which is the number that costs something;
  ;; $cache_inval_page keeps the last such page so the culprit can be named.
  (global $cache_invals (mut i32) (i32.const 0))
  (global $cache_inval_hits (mut i32) (i32.const 0))
  (global $cache_inval_page (mut i32) (i32.const 0))

  (func $invalidate_page (param $ga i32)
    (local $page i32) (local $i i32) (local $idx i32) (local $hit i32)
    (local.set $page (i32.and (local.get $ga) (i32.const 0xFFFFF000)))
    (global.set $cache_invals (i32.add (global.get $cache_invals) (i32.const 1)))
    ;; NOTE: the page bit is deliberately NOT cleared here. $CACHE_INDEX is
    ;; per-thread (0x07152000 + tid*0x8000) while CODE_PAGE_BITMAP lives in
    ;; shared linear memory, so this sweep retires only the writing thread's
    ;; blocks. Clearing the shared bit would tell every other thread that the
    ;; page holds no code, and their stale blocks would never be invalidated
    ;; again. Storm/Smacker rewrite their generated blitters in place, so that
    ;; is a real case, not a theoretical one. The cost of keeping the bit set
    ;; is one extra sweep per write to a page that has stopped holding code.
    (local.set $i (i32.const 0))
    (block $d (loop $s
      (br_if $d (i32.ge_u (local.get $i) (global.get $CACHE_SIZE)))
      (local.set $idx (i32.add (global.get $CACHE_INDEX) (i32.mul (local.get $i) (i32.const 8))))
      (if (i32.eq (i32.and (i32.load (local.get $idx)) (i32.const 0xFFFFF000)) (local.get $page))
        (then
          (local.set $hit (i32.const 1))
          (i32.store (local.get $idx) (i32.const 0)) (i32.store offset=4 (local.get $idx) (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $s)))
    (if (local.get $hit)
      (then
        (global.set $cache_inval_hits (i32.add (global.get $cache_inval_hits) (i32.const 1)))
        (global.set $cache_inval_page (local.get $page)))))

  ;; Recycling the decoded-code arena means resetting $thread_alloc to the base
  ;; and invalidating every cached block. That is only safe between blocks.
  ;; While a synchronous wndproc runs nested inside a handler — SendMessage,
  ;; a control's default processing, WM_WINDOWPOSCHANGED — the caller's decoded
  ;; block is still live in the arena, and reusing that memory rewrites the
  ;; code the outer frame is about to return into. The symptom is a jump to a
  ;; garbage EIP some distance after the flush, which resembles its cause not
  ;; at all: what you see is a runaway decoding nonsense, several more
  ;; overflows in a row, and then a wild EIP.
  ;;
  ;; So defer while nested, and flush at the next block boundary instead.
  (global $thread_flush_pending (mut i32) (i32.const 0))

  (func $thread_arena_flush_if_safe (result i32)
    (if (global.get $sync_msg_depth)
      (then
        (global.set $thread_flush_pending (i32.const 1))
        (return (i32.const 0))))
    (global.set $thread_flush_pending (i32.const 0))
    (global.set $thread_alloc (global.get $THREAD_BASE))
    (call $clear_cache)
    (i32.const 1))

  ;; Thread emit helpers
  (func $te (param $fn i32) (param $op i32)
    ;; Backstop only: $decode_block reserves far more headroom than a single
    ;; block needs, so reaching this mid-emit means something unusual. Never
    ;; recycle from here — $tstart is already captured and a reset would leave
    ;; the half-emitted block pointing into reused storage.
    ;; Report the overflow once per episode, not once per opcode. $te runs for
    ;; every emitted operand, so an unconditional log here is a per-instruction
    ;; log on the hottest path in the emulator: it produced nine million host
    ;; calls in a single batch and exhausted the harness's heap long before
    ;; anything else went wrong.
    (if (i32.ge_u (global.get $thread_alloc) (i32.sub (global.get $THREAD_END) (i32.const 4096)))
      (then
        (if (i32.eqz (global.get $thread_flush_pending))
          (then (call $host_log_i32 (i32.const 0xCA00F10F))))  ;; cache overflow
        (global.set $thread_flush_pending (i32.const 1))))
    ;; Record where this op starts, before the bump. The thread stream is not
    ;; self-describing -- a word is 8 bytes but some handlers pull extra ones
    ;; with $read_thread_word -- and $te is the single choke point through
    ;; which all 376 decoder emit sites pass, so this is the one place that
    ;; knows an op boundary without anyone having to declare it. Decode-time
    ;; only; see docs/loop-idiom-superops-design.md 6.1.
    (if (i32.lt_u (global.get $op_index_n) (global.get $OP_INDEX_MAX))
      (then
        (i32.store
          (i32.add (global.get $OP_INDEX)
            (i32.shl (global.get $op_index_n) (i32.const 2)))
          (global.get $thread_alloc))
        (global.set $op_index_n (i32.add (global.get $op_index_n) (i32.const 1))))
      (else (global.set $op_index_poison (i32.const 1))))
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
    (if (i32.ge_u (local.get $fn) (i32.const 420))
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
    ;; The dense pair matrix predates handlers 361+ and is intentionally
    ;; bounded to HANDLER_HIST_COUNT. Keep individual counts for newer
    ;; handlers, but never alias their pairs into another matrix row.
    (if (i32.and
          (i32.and
            (i32.ge_s (local.get $prev) (i32.const 0))
            (i32.lt_u (local.get $prev) (global.get $HANDLER_HIST_COUNT)))
          (i32.lt_u (local.get $fn) (global.get $HANDLER_HIST_COUNT)))
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
