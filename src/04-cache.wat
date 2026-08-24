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
    ;; Compiled chunks live in the same arena $thread_arena_flush_if_safe
    ;; rewinds, and every caller of $clear_cache is either that flush or the
    ;; corruption recovery in $next. Both mean no chunk pointer can be trusted.
    (call $page_dir_reset)
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
    ;; O(1), unlike the 4096-slot sweep below: a compiled page owns its chunk,
    ;; so retiring it is one directory entry.
    (call $page_dir_drop (local.get $page))
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

  ;; ============================================================
  ;; PAGE COMPILATION -- see docs/page-compile-design.md
  ;; ============================================================
  ;; A compiled page owns one 8KB index (4096 u16 entries, guest page offset ->
  ;; offset within the page's threaded-code chunk) and one contiguous chunk in
  ;; this thread's arena. Nothing here is required for correctness: every path
  ;; that cannot page an address falls back to the hash cache above, which is
  ;; untouched. That is the property that makes each sizing constant a tuning
  ;; knob rather than a correctness constraint.

  (func $page_dir_slot (param $page_base i32) (result i32)
    (i32.add (global.get $PAGE_DIR)
      (i32.mul
        (i32.and (i32.shr_u (local.get $page_base) (i32.const 12))
                 (global.get $PAGE_DIR_MASK))
        (i32.const 16))))

  ;; Forget every compiled page for this thread. Used at thread init and
  ;; whenever the arena the chunks live in is recycled underneath them.
  (func $page_dir_reset
    (local $i i32) (local $slot i32)
    (global.set $cur_page_base (i32.const 0))
    (global.set $cur_page_index (i32.const 0))
    (global.set $cur_page_chunk (i32.const 0))
    (global.set $page_index_next (i32.const 0))
    (global.set $page_index_free (i32.const 0))
    (local.set $i (i32.const 0))
    (block $d (loop $s
      (br_if $d (i32.ge_u (local.get $i) (global.get $PAGE_DIR_ENTRIES)))
      (local.set $slot
        (i32.add (global.get $PAGE_DIR) (i32.mul (local.get $i) (i32.const 16))))
      (i32.store (local.get $slot) (i32.const 0))
      (i32.store offset=4 (local.get $slot) (i32.const 0))
      (i32.store offset=8 (local.get $slot) (i32.const 0))
      (i32.store offset=12 (local.get $slot) (i32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $s))))

  ;; Hand out an 8KB index, preferring the free list. Returns 0 when this
  ;; thread's index arena is exhausted, which simply means the page does not
  ;; get compiled.
  (func $page_index_alloc (result i32)
    (local $p i32)
    (if (global.get $page_index_free)
      (then
        (local.set $p (global.get $page_index_free))
        (global.set $page_index_free (i32.load (local.get $p)))
        (return (local.get $p))))
    (if (i32.ge_u (global.get $page_index_next) (global.get $PAGE_INDEX_SLOTS))
      (then (return (i32.const 0))))
    (local.set $p
      (i32.add (global.get $PAGE_INDEX)
        (i32.mul (global.get $page_index_next) (global.get $PAGE_INDEX_BYTES))))
    (global.set $page_index_next (i32.add (global.get $page_index_next) (i32.const 1)))
    (local.get $p))

  ;; Every entry starts as PAGE_INDEX_NONE: an offset that was never written is
  ;; either a mid-instruction byte or code pass 1 never reached, and both must
  ;; miss rather than resolve to chunk offset 0.
  (func $page_index_clear (param $p i32)
    (local $i i32)
    (local.set $i (i32.const 0))
    (block $d (loop $s
      (br_if $d (i32.ge_u (local.get $i) (global.get $PAGE_INDEX_BYTES)))
      (i32.store (i32.add (local.get $p) (local.get $i)) (i32.const 0xFFFFFFFF))
      (local.set $i (i32.add (local.get $i) (i32.const 4)))
      (br $s))))

  ;; Retire one page. This is what makes the fast path safe without a
  ;; generation counter: a dropped page can no longer be named by the page
  ;; registers, so a stale chunk pointer is unreachable rather than merely
  ;; unlikely.
  (func $page_dir_drop (param $page_base i32)
    (local $slot i32) (local $idx i32)
    (local.set $slot (call $page_dir_slot (local.get $page_base)))
    (if (i32.ne (i32.load (local.get $slot)) (local.get $page_base)) (then (return)))
    (local.set $idx (i32.load offset=4 (local.get $slot)))
    (if (local.get $idx)
      (then
        (i32.store (local.get $idx) (global.get $page_index_free))
        (global.set $page_index_free (local.get $idx))))
    (i32.store (local.get $slot) (i32.const 0))
    (i32.store offset=4 (local.get $slot) (i32.const 0))
    (i32.store offset=8 (local.get $slot) (i32.const 0))
    (i32.store offset=12 (local.get $slot) (i32.const 0))
    (if (i32.eq (global.get $cur_page_base) (local.get $page_base))
      (then
        (global.set $cur_page_base (i32.const 0))
        (global.set $cur_page_index (i32.const 0))
        (global.set $cur_page_chunk (i32.const 0)))))

  ;; Give $page_base an index and a chunk, and leave the page registers loaded
  ;; on it. Returns 0 (and compiles nothing) if either resource is exhausted.
  ;; The chunk is bumped off $thread_alloc rather than out of a private arena so
  ;; that $thread_arena_flush_if_safe and $clear_cache — which already know when
  ;; recycling decoded code is safe — keep covering it; $clear_cache calls
  ;; $page_dir_reset for exactly that reason.
  (func $page_create (param $page_base i32) (result i32)
    (local $slot i32) (local $idx i32) (local $chunk i32)
    (local.set $slot (call $page_dir_slot (local.get $page_base)))
    ;; The directory is direct-mapped, so a live page can be sitting in the slot
    ;; this one wants. Retire it properly instead of overwriting its index
    ;; pointer, which would leak the 8KB and leave $cur_page_* naming it.
    (if (i32.load (local.get $slot))
      (then (call $page_dir_drop (i32.load (local.get $slot)))))
    (local.set $idx (call $page_index_alloc))
    (if (i32.eqz (local.get $idx)) (then (return (i32.const 0))))
    (if (i32.gt_u
          (i32.add (global.get $thread_alloc) (global.get $PAGE_CHUNK_BYTES))
          (i32.sub (global.get $THREAD_END) (i32.const 16384)))
      (then
        ;; No room for a chunk. Hand the index straight back rather than
        ;; stranding it: the arena is about to be flushed anyway.
        (i32.store (local.get $idx) (global.get $page_index_free))
        (global.set $page_index_free (local.get $idx))
        (return (i32.const 0))))
    (local.set $chunk (global.get $thread_alloc))
    (global.set $thread_alloc
      (i32.add (global.get $thread_alloc) (global.get $PAGE_CHUNK_BYTES)))
    (call $page_index_clear (local.get $idx))
    (i32.store (local.get $slot) (local.get $page_base))
    (i32.store offset=4 (local.get $slot) (local.get $idx))
    (i32.store offset=8 (local.get $slot) (local.get $chunk))
    (i32.store offset=12 (local.get $slot) (i32.const 0))
    (global.set $page_compiles (i32.add (global.get $page_compiles) (i32.const 1)))
    (global.set $cur_page_base (local.get $page_base))
    (global.set $cur_page_index (local.get $idx))
    (global.set $cur_page_chunk (local.get $chunk))
    (i32.const 1))

  ;; Copy a freshly decoded block out of the arena into its page's chunk and
  ;; index it. Threaded code is position-independent — every operand a handler
  ;; reads is a guest address, an immediate or a register number, never a
  ;; pointer into the thread stream — so a block can be relocated with a plain
  ;; byte copy. That is what lets the decoder stay exactly as it is: it emits
  ;; where it always did, and this runs afterwards.
  (func $page_publish (param $start_eip i32) (param $tstart i32) (param $tend i32)
    (local $base i32) (local $slot i32) (local $used i32) (local $len i32)
    (local $src i32) (local $dst i32)
    (local.set $len (i32.sub (local.get $tend) (local.get $tstart)))
    (if (i32.le_s (local.get $len) (i32.const 0)) (then (return)))
    (local.set $base (i32.and (local.get $start_eip) (i32.const 0xFFFFF000)))
    ;; A block whose x86 runs off the end of its page has instructions that a
    ;; write to the *next* page would have to retire, and $invalidate_page only
    ;; ever hears about one page. Leaving those to the ordinary path costs a
    ;; handful of blocks per page boundary and keeps invalidation honest.
    (if (i32.ne (i32.and (i32.sub (global.get $d_pc) (i32.const 1)) (i32.const 0xFFFFF000))
                (local.get $base))
      (then (return)))
    (if (i32.ne (local.get $base) (global.get $cur_page_base))
      (then
        (if (i32.eqz (call $page_enter (local.get $base)))
          (then
            (if (i32.eqz (call $page_create (local.get $base))) (then (return)))))))
    (local.set $slot (call $page_dir_slot (local.get $base)))
    (local.set $used (i32.load offset=12 (local.get $slot)))
    (if (i32.gt_u (i32.add (local.get $used) (local.get $len))
                  (global.get $PAGE_CHUNK_BYTES))
      (then
        ;; The chunk is full. Retiring the page is the whole recovery: the next
        ;; entry compiles it again from scratch, this time holding only the
        ;; blocks still being executed.
        (call $page_dir_drop (local.get $base))
        (return)))
    (local.set $src (local.get $tstart))
    (local.set $dst (i32.add (global.get $cur_page_chunk) (local.get $used)))
    (block $cdone (loop $copy
      (br_if $cdone (i32.ge_u (local.get $src) (local.get $tend)))
      (i32.store (local.get $dst) (i32.load (local.get $src)))
      (local.set $src (i32.add (local.get $src) (i32.const 4)))
      (local.set $dst (i32.add (local.get $dst) (i32.const 4)))
      (br $copy)))
    (i32.store16
      (i32.add (global.get $cur_page_index)
        (i32.shl (i32.and (local.get $start_eip) (i32.const 0xFFF)) (i32.const 1)))
      (local.get $used))
    (i32.store offset=12 (local.get $slot) (i32.add (local.get $used) (local.get $len))))

  ;; Load the page registers for $page_base if it is already compiled.
  (func $page_enter (param $page_base i32) (result i32)
    (local $slot i32)
    (local.set $slot (call $page_dir_slot (local.get $page_base)))
    (if (i32.ne (i32.load (local.get $slot)) (local.get $page_base))
      (then (return (i32.const 0))))
    (global.set $cur_page_base (local.get $page_base))
    (global.set $cur_page_index (i32.load offset=4 (local.get $slot)))
    (global.set $cur_page_chunk (i32.load offset=8 (local.get $slot)))
    (i32.const 1))

  ;; The hot path. Resolve a guest address to a threaded-code pointer without
  ;; touching the hash, or 0 to mean "use the ordinary path". Straight-line
  ;; execution inside one page costs one compare and one load; only a
  ;; page-crossing transfer consults PAGE_DIR, and it caches the result.
  (func $page_resolve (param $dest i32) (result i32)
    (local $base i32) (local $off i32)
    (local.set $base (i32.and (local.get $dest) (i32.const 0xFFFFF000)))
    (if (i32.ne (local.get $base) (global.get $cur_page_base))
      (then
        (if (i32.eqz (call $page_enter (local.get $base)))
          (then
            (global.set $page_misses (i32.add (global.get $page_misses) (i32.const 1)))
            (return (i32.const 0))))))
    (local.set $off
      (i32.load16_u
        (i32.add (global.get $cur_page_index)
          (i32.shl (i32.and (local.get $dest) (i32.const 0xFFF)) (i32.const 1)))))
    (if (i32.eq (local.get $off) (global.get $PAGE_INDEX_NONE))
      (then
        (global.set $page_misses (i32.add (global.get $page_misses) (i32.const 1)))
        (return (i32.const 0))))
    (global.set $page_hits (i32.add (global.get $page_hits) (i32.const 1)))
    (i32.add (global.get $cur_page_chunk) (local.get $off)))

  ;; Every block-terminating handler ends by tail-calling this instead of
  ;; returning. Returning is what costs: it unwinds to the top of $run, which
  ;; re-runs the whole guard preamble before it can look the destination up.
  ;; When the destination is already compiled and none of those guards has
  ;; anything to say, the guards are exactly the work being removed, so this
  ;; hands the thread straight to $next.
  ;;
  ;; The five tests below are the guards that can actually fire; each is a
  ;; global that is zero in a plain run, and any non-zero one falls back to the
  ;; desk rather than trying to reproduce what the desk does:
  ;;   $dbg_any      OR of the six debug arming flags (watchpoint, breakpoint,
  ;;                 hit counters, trace-esp, trace-eip, handler histogram)
  ;;   $code16       16-bit tasks get two extra checks and a separate dispatch
  ;;   $yield_flag   a handler asked the host for control
  ;;   $yield_reason a blocking API is parked; $run decides whether to halt
  ;;   $sbh_eip_a/b  the decoder recognised an MSVC small-block-heap entry, and
  ;;                 $run runs a scan ahead of those two addresses
  ;; The thunk zone needs no test here: a thunk page is never compiled, so
  ;; $page_resolve cannot name one.
  (func $branch_end
    (local $t i32)
    (if (i32.or (global.get $dbg_any)
        (i32.or (global.get $code16)
        (i32.or (global.get $yield_flag) (global.get $yield_reason))))
      (then (return)))
    (if (i32.le_s (global.get $block_budget) (i32.const 0)) (then (return)))
    ;; No test on $steps here. Running out is now a resume, not a restart:
    ;; $next parks $ip in $resume_ip and $run picks the block up where it left
    ;; off, without spending a second block from the budget for it.
    (if (i32.or (i32.eq (global.get $eip) (global.get $sbh_eip_a))
                (i32.eq (global.get $eip) (global.get $sbh_eip_b)))
      (then (return)))
    (local.set $t (call $page_resolve (global.get $eip)))
    (if (i32.eqz (local.get $t)) (then (return)))
    (global.set $block_budget (i32.sub (global.get $block_budget) (i32.const 1)))
    (global.set $page_fast (i32.add (global.get $page_fast) (i32.const 1)))
    ;; Kept even on the fast path: these two are what a crash log reads to say
    ;; which block produced a bad transfer, and a stale answer there is worse
    ;; than the two stores are expensive.
    (global.set $dbg_prev2_eip (global.get $dbg_prev_eip))
    (global.set $dbg_prev_eip (global.get $eip))
    (global.set $ip (local.get $t))
    ;; $steps is deliberately NOT refilled. It is the wasm-stack bound: each
    ;; dispatch adds a frame that only unwinds when the chain ends, so letting
    ;; one refill of 1000 span a whole fast chain keeps the depth exactly where
    ;; it is today.
    (return_call $next))

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
    (if (i32.le_s (global.get $steps) (i32.const 0))
      (then
        ;; Hand $run the op we are declining to run, so it resumes the block
        ;; instead of restarting it. See $resume_ip in 01-header.wat.
        (global.set $resume_ip (global.get $ip))
        (return)))
    (local.set $fn (i32.load (global.get $ip)))
    (local.set $op (i32.load offset=4 (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 8)))
    ;; Defensive: if cache is corrupted (bad handler index), drop the
    ;; whole cache and restart at $eip. The fresh decode will produce
    ;; valid threaded code. This recovers from rare corruption rather
    ;; than trapping with wasm "table index out of bounds".
    (if (i32.ge_u (local.get $fn) (i32.const 423))
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
