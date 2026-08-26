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

  ;; Bookkeeping that used to live inside $cache_store, kept when the hash it
  ;; belonged to was deleted (docs/page-compile-design.md section 4). None of it
  ;; ever had anything to do with the hash: it records *that* a guest address
  ;; was decoded, so that a later write to those bytes knows it is touching
  ;; code. That question is asked by $invalidate_code_write and is independent
  ;; of where the decoded code is stored, so this now runs once per decoded
  ;; block from $decode_block instead.
  (func $code_note_decode (param $ga i32)
    (local $page i32) (local $page_end i32) (local $should_track i32)
    (global.set $cache_stores (i32.add (global.get $cache_stores) (i32.const 1)))
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
  ;; Decoded blocks. Named for the export that has always reported it.
  (global $cache_stores (mut i32) (i32.const 0))
  ;; Compiled pages evicted by another page landing in their directory slot.
  (global $cache_evicts (mut i32) (i32.const 0))

  ;; Throw away every scrap of decoded code for this thread. Compiled chunks
  ;; live in the arena $thread_arena_flush_if_safe rewinds, and every caller is
  ;; either that flush or the corruption recovery in $next -- both mean no chunk
  ;; pointer can be trusted. With the hash gone, resetting the directory *is*
  ;; the whole job; there is no second index to sweep.
  (func $clear_cache
    (global.set $cache_clears (i32.add (global.get $cache_clears) (i32.const 1)))
    (call $page_dir_reset))
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

  ;; Occupancy of page chunks when they leave the directory. PAGE_CHUNK_BYTES
  ;; is deliberately a worst-case reservation, but without these counters an
  ;; app that exhausts the arena cannot tell us whether it needs more memory or
  ;; whether most of that memory is merely empty tail space. Samples include
  ;; collision/invalidation drops and every live page discarded by a full
  ;; cache clear. The four buckets are cumulative upper bounds.
  (global $page_chunk_samples (mut i32) (i32.const 0))
  (global $page_chunk_used_total (mut i64) (i64.const 0))
  (global $page_chunk_used_max (mut i32) (i32.const 0))
  (global $page_chunk_le_4k (mut i32) (i32.const 0))
  (global $page_chunk_le_8k (mut i32) (i32.const 0))
  (global $page_chunk_le_12k (mut i32) (i32.const 0))
  (global $page_chunk_le_16k (mut i32) (i32.const 0))
  ;; Four size-class free lists. A freed chunk stores the next pointer in its
  ;; first word. They are per-instance globals just like $thread_alloc; worker
  ;; instances share memory but never share a decoded-code arena.
  (global $page_chunk_free_4k (mut i32) (i32.const 0))
  (global $page_chunk_free_8k (mut i32) (i32.const 0))
  (global $page_chunk_free_12k (mut i32) (i32.const 0))
  (global $page_chunk_free_16k (mut i32) (i32.const 0))
  (global $page_chunk_grows (mut i32) (i32.const 0))
  (global $page_chunk_reuses (mut i32) (i32.const 0))
  (global $page_index_evict_cursor (mut i32) (i32.const 0))
  (global $page_chunk_deferred (mut i32) (i32.const 0))
  (global $page_chunk_deferred_class (mut i32) (i32.const 0))

  ;; PAGE_DIR offset 12 packs the used byte count in the low 16 bits and the
  ;; 4/8/12/16KB capacity class in bits 16..17. Used offsets remain u16 so the
  ;; page index's existing 14-bit chunk offsets stay unchanged.
  (func $page_desc_used (param $desc i32) (result i32)
    (i32.and (local.get $desc) (i32.const 0xFFFF)))

  (func $page_desc_class (param $desc i32) (result i32)
    (i32.and (i32.shr_u (local.get $desc) (i32.const 16)) (i32.const 3)))

  (func $page_chunk_bytes (param $class i32) (result i32)
    (i32.shl (i32.add (local.get $class) (i32.const 1)) (i32.const 12)))

  ;; Smallest class that can hold $needed, or -1 beyond the indexable 16KB.
  (func $page_chunk_class_for (param $needed i32) (result i32)
    (if (i32.le_u (local.get $needed) (i32.const 4096)) (then (return (i32.const 0))))
    (if (i32.le_u (local.get $needed) (i32.const 8192)) (then (return (i32.const 1))))
    (if (i32.le_u (local.get $needed) (i32.const 12288)) (then (return (i32.const 2))))
    (if (i32.le_u (local.get $needed) (global.get $PAGE_CHUNK_BYTES))
      (then (return (i32.const 3))))
    (i32.const -1))

  (func $page_chunk_put (param $chunk i32) (param $class i32)
    (if (i32.eq (local.get $class) (i32.const 0))
      (then
        (i32.store (local.get $chunk) (global.get $page_chunk_free_4k))
        (global.set $page_chunk_free_4k (local.get $chunk))
        (return)))
    (if (i32.eq (local.get $class) (i32.const 1))
      (then
        (i32.store (local.get $chunk) (global.get $page_chunk_free_8k))
        (global.set $page_chunk_free_8k (local.get $chunk))
        (return)))
    (if (i32.eq (local.get $class) (i32.const 2))
      (then
        (i32.store (local.get $chunk) (global.get $page_chunk_free_12k))
        (global.set $page_chunk_free_12k (local.get $chunk))
        (return)))
    (i32.store (local.get $chunk) (global.get $page_chunk_free_16k))
    (global.set $page_chunk_free_16k (local.get $chunk)))

  (func $page_chunk_alloc (param $class i32) (result i32)
    (local $p i32) (local $size i32)
    (if (i32.eq (local.get $class) (i32.const 0))
      (then
        (local.set $p (global.get $page_chunk_free_4k))
        (if (local.get $p)
          (then (global.set $page_chunk_free_4k (i32.load (local.get $p)))))))
    (if (i32.eq (local.get $class) (i32.const 1))
      (then
        (local.set $p (global.get $page_chunk_free_8k))
        (if (local.get $p)
          (then (global.set $page_chunk_free_8k (i32.load (local.get $p)))))))
    (if (i32.eq (local.get $class) (i32.const 2))
      (then
        (local.set $p (global.get $page_chunk_free_12k))
        (if (local.get $p)
          (then (global.set $page_chunk_free_12k (i32.load (local.get $p)))))))
    (if (i32.eq (local.get $class) (i32.const 3))
      (then
        (local.set $p (global.get $page_chunk_free_16k))
        (if (local.get $p)
          (then (global.set $page_chunk_free_16k (i32.load (local.get $p)))))))
    (if (local.get $p)
      (then
        (global.set $page_chunk_reuses
          (i32.add (global.get $page_chunk_reuses) (i32.const 1)))
        (return (local.get $p))))
    (local.set $size (call $page_chunk_bytes (local.get $class)))
    (if (i32.gt_u
          (i32.add (global.get $thread_alloc) (local.get $size))
          (i32.sub (global.get $THREAD_END) (i32.const 16384)))
      (then (return (i32.const 0))))
    (local.set $p (global.get $thread_alloc))
    (global.set $thread_alloc (i32.add (global.get $thread_alloc) (local.get $size)))
    (local.get $p))

  ;; Dropping a page can happen from a store inside the page's own decoded
  ;; block. Reusing that chunk before the block terminates would overwrite the
  ;; interpreter stream under $ip. Nested synchronous dispatch has the same
  ;; issue for the suspended outer block. Those rare chunks remain abandoned
  ;; until the next arena reset; every other drop is immediately reusable.
  (func $page_chunk_put_if_safe (param $chunk i32) (param $class i32)
    (local $end i32)
    (if (i32.eqz (local.get $chunk)) (then (return)))
    (if (global.get $sync_msg_depth) (then (return)))
    (local.set $end
      (i32.add (local.get $chunk) (call $page_chunk_bytes (local.get $class))))
    (if (i32.and
          (i32.ge_u (global.get $ip) (local.get $chunk))
          (i32.lt_u (global.get $ip) (local.get $end)))
      (then (return)))
    (call $page_chunk_put (local.get $chunk) (local.get $class)))

  ;; A page that fills while $decode_run is extending it can still contain the
  ;; first block that decode_run is about to execute. Retire the directory entry
  ;; now, but wait until that block returns to $run before putting its chunk on
  ;; a reusable free list. Only one can be pending: the failed publication ends
  ;; the run immediately. Nested synchronous execution abandons the chunk just
  ;; as the old bump allocator did, because an outer frame may still name it.
  (func $page_chunk_reclaim_deferred
    (if (i32.eqz (global.get $page_chunk_deferred)) (then (return)))
    (if (global.get $sync_msg_depth) (then (return)))
    (call $page_chunk_put
      (global.get $page_chunk_deferred) (global.get $page_chunk_deferred_class))
    (global.set $page_chunk_deferred (i32.const 0))
    (global.set $page_chunk_deferred_class (i32.const 0)))

  (func $page_chunk_sample (param $used i32)
    (global.set $page_chunk_samples
      (i32.add (global.get $page_chunk_samples) (i32.const 1)))
    (global.set $page_chunk_used_total
      (i64.add (global.get $page_chunk_used_total)
        (i64.extend_i32_u (local.get $used))))
    (if (i32.gt_u (local.get $used) (global.get $page_chunk_used_max))
      (then (global.set $page_chunk_used_max (local.get $used))))
    (if (i32.le_u (local.get $used) (i32.const 4096))
      (then (global.set $page_chunk_le_4k
        (i32.add (global.get $page_chunk_le_4k) (i32.const 1)))))
    (if (i32.le_u (local.get $used) (i32.const 8192))
      (then (global.set $page_chunk_le_8k
        (i32.add (global.get $page_chunk_le_8k) (i32.const 1)))))
    (if (i32.le_u (local.get $used) (i32.const 12288))
      (then (global.set $page_chunk_le_12k
        (i32.add (global.get $page_chunk_le_12k) (i32.const 1)))))
    (if (i32.le_u (local.get $used) (global.get $PAGE_CHUNK_BYTES))
      (then (global.set $page_chunk_le_16k
        (i32.add (global.get $page_chunk_le_16k) (i32.const 1))))))

  ;; Retire the one compiled block that covers guest offset $off of the page
  ;; whose directory slot is $slot. Returns the offset one past the retired
  ;; block's last guest byte, so a range walk can skip the bytes it just dealt
  ;; with; returns $off+1 when nothing covered it.
  ;;
  ;; Two things have to happen, and doing only the first is the trap this
  ;; design walks into (docs/page-compile-design.md section 5.1). Clearing the
  ;; index stops the block being *entered*. It does not stop it being *fallen
  ;; into*: a run's whole point is that the not-taken side of a branch is the
  ;; next word of the chunk, consulting nothing. So the chunk itself has to be
  ;; broken, by overwriting the retired block's 8-byte header in place with
  ;; $th_block_end and the block's own guest address.
  ;;
  ;; That handler already exists -- `eip = op; return_call $branch_end` -- and
  ;; it is exactly 8 bytes with no trailing word, so it fits over any header.
  ;; The design predicted a new opcode ($th_page_exit) would be needed here; it
  ;; is not, and the handler table does not move.
  (func $page_retire_at (param $slot i32) (param $off i32) (result i32)
    (local $idx i32) (local $chunk i32) (local $v i32) (local $coff i32)
    (local $lo i32) (local $hi i32)
    (local.set $idx (i32.load offset=4 (local.get $slot)))
    (local.set $v
      (i32.load16_u (i32.add (local.get $idx) (i32.shl (local.get $off) (i32.const 1)))))
    (if (i32.eq (local.get $v) (global.get $PAGE_INDEX_NONE))
      (then (return (i32.add (local.get $off) (i32.const 1)))))
    (local.set $coff (i32.and (local.get $v) (global.get $PAGE_INDEX_OFFMASK)))
    ;; Walk out to the block's guest extent. Every byte of it carries the same
    ;; chunk offset -- that is what $page_publish wrote -- so the extent is
    ;; readable from the index without an instruction-length table and without
    ;; storing a length anywhere.
    (local.set $lo (local.get $off))
    (block $ld (loop $ls
      (br_if $ld (i32.eqz (local.get $lo)))
      (local.set $v
        (i32.load16_u
          (i32.add (local.get $idx)
            (i32.shl (i32.sub (local.get $lo) (i32.const 1)) (i32.const 1)))))
      (br_if $ld (i32.eq (local.get $v) (global.get $PAGE_INDEX_NONE)))
      (br_if $ld (i32.ne (i32.and (local.get $v) (global.get $PAGE_INDEX_OFFMASK))
                         (local.get $coff)))
      (local.set $lo (i32.sub (local.get $lo) (i32.const 1)))
      (br $ls)))
    (local.set $hi (i32.add (local.get $off) (i32.const 1)))
    (block $hd (loop $hs
      (br_if $hd (i32.ge_u (local.get $hi) (i32.const 4096)))
      (local.set $v
        (i32.load16_u (i32.add (local.get $idx) (i32.shl (local.get $hi) (i32.const 1)))))
      (br_if $hd (i32.eq (local.get $v) (global.get $PAGE_INDEX_NONE)))
      (br_if $hd (i32.ne (i32.and (local.get $v) (global.get $PAGE_INDEX_OFFMASK))
                         (local.get $coff)))
      (local.set $hi (i32.add (local.get $hi) (i32.const 1)))
      (br $hs)))
    ;; Break the chunk before clearing the index, so there is no window in
    ;; which the block is unreachable by lookup but still fallen into.
    (local.set $chunk (i32.load offset=8 (local.get $slot)))
    (i32.store (i32.add (local.get $chunk) (local.get $coff)) (i32.const 45))
    (i32.store offset=4 (i32.add (local.get $chunk) (local.get $coff))
      (i32.or (i32.load (local.get $slot)) (local.get $lo)))
    (block $cd (loop $cs
      (br_if $cd (i32.ge_u (local.get $lo) (local.get $hi)))
      (i32.store16 (i32.add (local.get $idx) (i32.shl (local.get $lo) (i32.const 1)))
        (global.get $PAGE_INDEX_NONE))
      (local.set $lo (i32.add (local.get $lo) (i32.const 1)))
      (br $cs)))
    (global.set $page_retires (i32.add (global.get $page_retires) (i32.const 1)))
    (global.set $cache_inval_hits (i32.add (global.get $cache_inval_hits) (i32.const 1)))
    (global.set $cache_inval_page (i32.load (local.get $slot)))
    (local.get $hi))

  ;; A guest write of $len bytes starting at $ga landed on a page that has held
  ;; code. Retire exactly the blocks whose x86 those bytes are part of.
  ;;
  ;; This is docs/page-compile-design.md section 5, and it is the reason the
  ;; hash cache could go. The old code retired *every block in the 4KB page* and
  ;; had to sweep all 4096 hash slots to find them; a data variable sharing a
  ;; page with hot code therefore turned each write to it into a re-decode of
  ;; the code. The index is keyed by page offset, so a write to offset X names
  ;; the one block covering X in a single load, and the rest of the page keeps
  ;; running compiled.
  ;;
  ;; NOTE: the CODE_PAGE_BITMAP bit is deliberately never cleared. The page
  ;; directory is per-thread while the bitmap is shared, so this retires only
  ;; the writing thread's code. Clearing the shared bit would tell every other
  ;; thread the page holds none, and their stale blocks would never be
  ;; invalidated again -- Storm and Smacker rewrite generated blitters in place,
  ;; so that is a real case.
  (func $invalidate_code_range (param $ga i32) (param $len i32)
    (local $end i32) (local $page i32) (local $slot i32)
    (local $off i32) (local $stop i32)
    (global.set $cache_invals (i32.add (global.get $cache_invals) (i32.const 1)))
    (local.set $end (i32.add (local.get $ga) (local.get $len)))
    (local.set $page (i32.and (local.get $ga) (i32.const 0xFFFFF000)))
    (block $pd (loop $ps
      (br_if $pd (i32.ge_u (local.get $page) (local.get $end)))
      (local.set $slot (call $page_dir_slot (local.get $page)))
      (if (i32.eq (i32.load (local.get $slot)) (local.get $page))
        (then
          (local.set $off
            (if (result i32) (i32.gt_u (local.get $ga) (local.get $page))
              (then (i32.sub (local.get $ga) (local.get $page)))
              (else (i32.const 0))))
          (local.set $stop
            (if (result i32)
                (i32.lt_u (local.get $end) (i32.add (local.get $page) (i32.const 4096)))
              (then (i32.sub (local.get $end) (local.get $page)))
              (else (i32.const 4096))))
          ;; A wide write is not worth walking: past a few hundred bytes the
          ;; per-offset walk costs more than dropping the page and letting the
          ;; next entry rebuild only what is still executed. This is the same
          ;; bound the old whole-page behaviour had, kept for the pathological
          ;; case only -- a REP MOVS over a code page, not an app patching one
          ;; branch.
          (if (i32.gt_u (i32.sub (local.get $stop) (local.get $off)) (i32.const 512))
            (then
              (global.set $page_range_drops
                (i32.add (global.get $page_range_drops) (i32.const 1)))
              (global.set $cache_inval_hits
                (i32.add (global.get $cache_inval_hits) (i32.const 1)))
              (global.set $cache_inval_page (local.get $page))
              (call $page_dir_drop (local.get $page)))
            (else
              (block $od (loop $os
                (br_if $od (i32.ge_u (local.get $off) (local.get $stop)))
                (local.set $off (call $page_retire_at (local.get $slot) (local.get $off)))
                (br $os)))))))
      (local.set $page (i32.add (local.get $page) (i32.const 0x1000)))
      (br $ps))))

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
    (global.set $page_index_evict_cursor (i32.const 0))
    (global.set $page_chunk_free_4k (i32.const 0))
    (global.set $page_chunk_free_8k (i32.const 0))
    (global.set $page_chunk_free_12k (i32.const 0))
    (global.set $page_chunk_free_16k (i32.const 0))
    (global.set $page_chunk_deferred (i32.const 0))
    (global.set $page_chunk_deferred_class (i32.const 0))
    (local.set $i (i32.const 0))
    (block $d (loop $s
      (br_if $d (i32.ge_u (local.get $i) (global.get $PAGE_DIR_ENTRIES)))
      (local.set $slot
        (i32.add (global.get $PAGE_DIR) (i32.mul (local.get $i) (i32.const 16))))
      (if (i32.load (local.get $slot))
        (then (call $page_chunk_sample
          (call $page_desc_used (i32.load offset=12 (local.get $slot))))))
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
    (local $p i32) (local $n i32) (local $slot i32) (local $page i32)
    (if (global.get $page_index_free)
      (then
        (local.set $p (global.get $page_index_free))
        (global.set $page_index_free (i32.load (local.get $p)))
        (return (local.get $p))))
    (if (i32.ge_u (global.get $page_index_next) (global.get $PAGE_INDEX_SLOTS))
      (then
        ;; The old behaviour simply declined every new page once all 128
        ;; indexes were live. Frequent arena overflows accidentally hid that
        ;; on Diablo II by clearing the directory; compact chunks remove those
        ;; clears, so make index pressure explicit and bounded. Evict one
        ;; non-current directory entry with a clock walk, then consume the
        ;; index $page_dir_drop put on the free list.
        (block $found (loop $scan
          (br_if $found (i32.ge_u (local.get $n) (global.get $PAGE_DIR_ENTRIES)))
          (local.set $slot
            (i32.add (global.get $PAGE_DIR)
              (i32.mul (global.get $page_index_evict_cursor) (i32.const 16))))
          (global.set $page_index_evict_cursor
            (i32.and
              (i32.add (global.get $page_index_evict_cursor) (i32.const 1))
              (global.get $PAGE_DIR_MASK)))
          (local.set $page (i32.load (local.get $slot)))
          (if (i32.and
                (i32.ne (local.get $page) (i32.const 0))
                (i32.ne (local.get $page) (global.get $cur_page_base)))
            (then
              (global.set $cache_evicts
                (i32.add (global.get $cache_evicts) (i32.const 1)))
              (call $page_dir_drop (local.get $page))
              (br $found)))
          (local.set $n (i32.add (local.get $n) (i32.const 1)))
          (br $scan)))
        (if (i32.eqz (global.get $page_index_free))
          (then (return (i32.const 0))))
        (local.set $p (global.get $page_index_free))
        (global.set $page_index_free (i32.load (local.get $p)))
        (return (local.get $p))))
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
  (func $page_dir_drop_mode (param $page_base i32) (param $defer i32)
    (local $slot i32) (local $idx i32) (local $chunk i32) (local $desc i32)
    (local.set $slot (call $page_dir_slot (local.get $page_base)))
    (if (i32.ne (i32.load (local.get $slot)) (local.get $page_base)) (then (return)))
    (local.set $idx (i32.load offset=4 (local.get $slot)))
    (local.set $chunk (i32.load offset=8 (local.get $slot)))
    (local.set $desc (i32.load offset=12 (local.get $slot)))
    (call $page_chunk_sample (call $page_desc_used (local.get $desc)))
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
        (global.set $cur_page_chunk (i32.const 0))))
    (if (local.get $defer)
      (then
        (if (i32.and
              (i32.eqz (global.get $sync_msg_depth))
              (i32.eqz (global.get $page_chunk_deferred)))
          (then
            (global.set $page_chunk_deferred (local.get $chunk))
            (global.set $page_chunk_deferred_class (call $page_desc_class (local.get $desc))))))
      (else
        (call $page_chunk_put_if_safe
          (local.get $chunk) (call $page_desc_class (local.get $desc))))))

  (func $page_dir_drop (param $page_base i32)
    (call $page_dir_drop_mode (local.get $page_base) (i32.const 0)))

  (func $page_dir_drop_deferred (param $page_base i32)
    (call $page_dir_drop_mode (local.get $page_base) (i32.const 1)))

  ;; Give $page_base an index and a chunk, and leave the page registers loaded
  ;; on it. Returns 0 (and compiles nothing) if either resource is exhausted.
  ;; The chunk is bumped off $thread_alloc rather than out of a private arena so
  ;; that $thread_arena_flush_if_safe and $clear_cache — which already know when
  ;; recycling decoded code is safe — keep covering it; $clear_cache calls
  ;; $page_dir_reset for exactly that reason.
  (func $page_create (param $page_base i32) (param $needed i32) (result i32)
    (local $slot i32) (local $idx i32) (local $chunk i32) (local $class i32)
    (local.set $slot (call $page_dir_slot (local.get $page_base)))
    ;; The directory is direct-mapped, so a live page can be sitting in the slot
    ;; this one wants. Retire it properly instead of overwriting its index
    ;; pointer, which would leak the 8KB and leave $cur_page_* naming it.
    (if (i32.load (local.get $slot))
      (then
        (global.set $cache_evicts (i32.add (global.get $cache_evicts) (i32.const 1)))
        (call $page_dir_drop (i32.load (local.get $slot)))))
    (local.set $idx (call $page_index_alloc))
    (if (i32.eqz (local.get $idx)) (then (return (i32.const 0))))
    (local.set $class (call $page_chunk_class_for (local.get $needed)))
    (if (i32.lt_s (local.get $class) (i32.const 0))
      (then
        (i32.store (local.get $idx) (global.get $page_index_free))
        (global.set $page_index_free (local.get $idx))
        (return (i32.const 0))))
    (local.set $chunk (call $page_chunk_alloc (local.get $class)))
    (if (i32.eqz (local.get $chunk))
      (then
        ;; Hand the index straight back and ask the next safe block boundary to
        ;; recycle the arena. The just-decoded block still runs from scratch.
        (i32.store (local.get $idx) (global.get $page_index_free))
        (global.set $page_index_free (local.get $idx))
        (global.set $thread_flush_pending (i32.const 1))
        (return (i32.const 0))))
    (call $page_index_clear (local.get $idx))
    (i32.store (local.get $slot) (local.get $page_base))
    (i32.store offset=4 (local.get $slot) (local.get $idx))
    (i32.store offset=8 (local.get $slot) (local.get $chunk))
    (i32.store offset=12 (local.get $slot)
      (i32.shl (local.get $class) (i32.const 16)))
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
  ;;
  ;; Returns the chunk offset the block landed at, or -1 when nothing was
  ;; published. $decode_run needs that number: the only way it may treat one
  ;; block's not-taken branch as "just carry on down the stream" is if the next
  ;; block really did land immediately after this one, and a return of -1 (or of
  ;; an offset that is not where the previous block ended) is how a page swap, a
  ;; full chunk or an arena flush announces itself.
  (func $page_publish (param $start_eip i32) (param $tstart i32) (param $tend i32)
                      (param $guest_end i32) (result i32)
    (local $base i32) (local $slot i32) (local $used i32) (local $len i32)
    (local $desc i32) (local $class i32) (local $needed i32)
    (local $old_chunk i32) (local $new_chunk i32) (local $new_class i32)
    (local $src i32) (local $dst i32) (local $o i32) (local $olast i32)
    (local.set $len (i32.sub (local.get $tend) (local.get $tstart)))
    (if (i32.le_s (local.get $len) (i32.const 0)) (then (return (i32.const -1))))
    (local.set $base (i32.and (local.get $start_eip) (i32.const 0xFFFFF000)))
    ;; The decoder caps every block at its starting page (see the page-boundary
    ;; split in $decode_block), so a block's x86 is inside one page and its
    ;; whole extent is indexable here. Only the last *instruction* can spill a
    ;; few bytes over the edge; those bytes get no cover entry, exactly as they
    ;; got no hash entry before, and a write to them does not retire the block.
    ;; That hole is unchanged from the hash design, not introduced by this one.
    (if (i32.ne (local.get $base) (global.get $cur_page_base))
      (then
        (if (i32.eqz (call $page_enter (local.get $base)))
          (then
            (if (i32.eqz (call $page_create (local.get $base) (local.get $len)))
              (then (return (i32.const -1))))))))
    (local.set $slot (call $page_dir_slot (local.get $base)))
    (local.set $desc (i32.load offset=12 (local.get $slot)))
    (local.set $used (call $page_desc_used (local.get $desc)))
    (local.set $class (call $page_desc_class (local.get $desc)))
    (local.set $needed (i32.add (local.get $used) (local.get $len)))
    (if (i32.gt_u (local.get $needed) (global.get $PAGE_CHUNK_BYTES))
      (then
        ;; Rebuild around the still-hot subset on the next entry, as the fixed
        ;; allocator did. The old chunk cannot be reused until decode_run's
        ;; already-saved first block has executed, so retirement is deferred to
        ;; the next safe return to $run.
        (call $page_dir_drop_deferred (local.get $base))
        (return (i32.const -1))))
    (if (i32.gt_u (local.get $needed) (call $page_chunk_bytes (local.get $class)))
      (then
        ;; A synchronous nested guest dispatch can have an outer decoded block
        ;; suspended in this same chunk. Let this block run from scratch and
        ;; grow on a later top-level miss instead of moving that live stream.
        (if (global.get $sync_msg_depth) (then (return (i32.const -1))))
        (local.set $new_class (call $page_chunk_class_for (local.get $needed)))
        (local.set $new_chunk (call $page_chunk_alloc (local.get $new_class)))
        (if (i32.eqz (local.get $new_chunk))
          (then
            (global.set $thread_flush_pending (i32.const 1))
            (return (i32.const -1))))
        (local.set $old_chunk (global.get $cur_page_chunk))
        (memory.copy (local.get $new_chunk) (local.get $old_chunk) (local.get $used))
        (i32.store offset=8 (local.get $slot) (local.get $new_chunk))
        (i32.store offset=12 (local.get $slot)
          (i32.or (i32.shl (local.get $new_class) (i32.const 16)) (local.get $used)))
        (global.set $cur_page_chunk (local.get $new_chunk))
        ;; No decoded block is executing while a top-level miss is being
        ;; published. $decode_run adjusts its local first-block pointer when it
        ;; observes this relocation.
        (call $page_chunk_put (local.get $old_chunk) (local.get $class))
        (global.set $page_chunk_grows
          (i32.add (global.get $page_chunk_grows) (i32.const 1)))
        (local.set $class (local.get $new_class))))
    (local.set $src (local.get $tstart))
    (local.set $dst (i32.add (global.get $cur_page_chunk) (local.get $used)))
    (block $cdone (loop $copy
      (br_if $cdone (i32.ge_u (local.get $src) (local.get $tend)))
      (i32.store (local.get $dst) (i32.load (local.get $src)))
      (local.set $src (i32.add (local.get $src) (i32.const 4)))
      (local.set $dst (i32.add (local.get $dst) (i32.const 4)))
      (br $copy)))
    ;; Index the entry point, then mark every interior byte of the block's x86
    ;; as covered by it. The cover marks are what make section 5's invalidation
    ;; a single load: a write anywhere in the block's guest bytes names the
    ;; block. Interior bytes must be written even where the index already holds
    ;; NONE, and the walk stops at the page edge because the last instruction
    ;; may spill past it.
    (i32.store16
      (i32.add (global.get $cur_page_index)
        (i32.shl (i32.and (local.get $start_eip) (i32.const 0xFFF)) (i32.const 1)))
      (local.get $used))
    (local.set $o (i32.add (i32.and (local.get $start_eip) (i32.const 0xFFF)) (i32.const 1)))
    (local.set $olast (i32.sub (local.get $guest_end) (local.get $base)))
    (if (i32.gt_u (local.get $olast) (i32.const 4096))
      (then (local.set $olast (i32.const 4096))))
    (block $md (loop $ms
      (br_if $md (i32.ge_u (local.get $o) (local.get $olast)))
      (i32.store16
        (i32.add (global.get $cur_page_index) (i32.shl (local.get $o) (i32.const 1)))
        (i32.or (local.get $used) (global.get $PAGE_INDEX_COVER)))
      (local.set $o (i32.add (local.get $o) (i32.const 1)))
      (br $ms)))
    (i32.store offset=12 (local.get $slot)
      (i32.or
        (i32.shl (local.get $class) (i32.const 16))
        (i32.add (local.get $used) (local.get $len))))
    (local.get $used))

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
    ;; One test covers both misses: PAGE_INDEX_NONE (0xFFFF, nothing compiled
    ;; here) and a cover mark (bit 14 set, this byte is inside a block but is
    ;; not its entry point, so entering here would run from the middle of an
    ;; instruction).
    (if (i32.ge_u (local.get $off) (global.get $PAGE_INDEX_COVER))
      (then
        (global.set $page_misses (i32.add (global.get $page_misses) (i32.const 1)))
        (return (i32.const 0))))
    (global.set $page_hits (i32.add (global.get $page_hits) (i32.const 1)))
    (i32.add (global.get $cur_page_chunk) (local.get $off)))

  ;; "Is there already compiled code entered at this address?" -- the question
  ;; $decode_run asks before extending a run into the next block. Unlike
  ;; $page_resolve this moves no page registers and counts no hit or miss: it
  ;; is a decode-time query about a page that may not be the executing one, and
  ;; letting it swap $cur_page_* underneath a run in progress would repoint the
  ;; chunk the run is being appended to.
  (func $page_probe (param $ga i32) (result i32)
    (local $slot i32) (local $idx i32)
    (local.set $slot (call $page_dir_slot (i32.and (local.get $ga) (i32.const 0xFFFFF000))))
    (if (i32.ne (i32.load (local.get $slot)) (i32.and (local.get $ga) (i32.const 0xFFFFF000)))
      (then (return (i32.const 0))))
    (local.set $idx (i32.load offset=4 (local.get $slot)))
    (i32.lt_u
      (i32.load16_u
        (i32.add (local.get $idx)
          (i32.shl (i32.and (local.get $ga) (i32.const 0xFFF)) (i32.const 1))))
      (global.get $PAGE_INDEX_COVER)))

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
    (if (i32.ge_u (local.get $fn) (i32.const 432))
      (then
        (call $host_log_i32 (i32.const 0xCAC4BAD0))
        (call $host_log_i32 (local.get $fn))
        (call $host_log_i32 (global.get $eip))
        (global.set $thread_alloc (global.get $THREAD_BASE))
        (call $clear_cache)
        (return)))
    (if (global.get $handler_hist_enabled)
      (then (call $handler_hist_record (local.get $fn))))
    ;; A tail call, so the chain runs at constant stack depth. Nothing follows
    ;; the dispatch in this function, which is what makes it legal.
    ;;
    ;; This was measured at the fork point and rejected as worthless, for a
    ;; reason that was true there and is not true here: a chain used to be one
    ;; x86 basic block deep -- 151.5M dispatches over 30.0M blocks is 5.05 ops
    ;; -- so there were never enough frames for their cost to matter, and
    ;; $steps=1000 was a backstop nothing reached. Since $branch_end and
    ;; $jcc_end stopped unwinding at block terminators, $steps is no longer a
    ;; backstop: it *is* the chain length, and the same chain is now ~1000
    ;; frames instead of ~5. See docs/interpreter-dispatch-perf.md.
    (return_call_indirect (type $handler_t) (local.get $op) (local.get $fn)))

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
