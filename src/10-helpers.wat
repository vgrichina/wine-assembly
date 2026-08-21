  ;; ============================================================
  ;; HELPER FUNCTIONS
  ;; ============================================================

  ;; ---- PAINT_SCRATCH ring ----
  ;;
  ;; Every rect-taking primitive in here wants a WASM linear address, so a
  ;; painter needs somewhere to put four i32s. That used to be one shared RECT,
  ;; and painting nests: a wndproc that fills the rect, then sends a message
  ;; that paints something else, got its rect back rewritten. Hand out one of
  ;; PAINT_SCRATCH_SLOTS rects instead.
  ;;
  ;; $paint_scratch_take is a bump allocator that wraps. Wrapping is the whole
  ;; safety story for the common shape — fill a rect, pass it to one call, never
  ;; look at it again — since a slot is only reused after 15 more takes. Callers
  ;; that hold a rect *across* a dispatch into other windows bracket the
  ;; dispatch with $paint_scratch_mark / $paint_scratch_reset: the inner frame's
  ;; slots are recycled on the way out, the outer frame's (allocated before the
  ;; mark) are not.
  (func $paint_scratch_take (result i32)
    (local $slot i32)
    (local.set $slot (global.get $paint_scratch_cursor))
    (global.set $paint_scratch_cursor
      (i32.rem_u (i32.add (local.get $slot) (i32.const 1))
                 (global.get $PAINT_SCRATCH_SLOTS)))
    (i32.add (global.get $PAINT_SCRATCH) (i32.mul (local.get $slot) (i32.const 16))))

  ;; Fill a fresh scratch rect and return its address, so a call site can build
  ;; the rect inline in the argument it is passing.
  (func $paint_rect (param $l i32) (param $t i32) (param $r i32) (param $b i32) (result i32)
    (local $p i32)
    (local.set $p (call $paint_scratch_take))
    (i32.store           (local.get $p) (local.get $l))
    (i32.store offset=4  (local.get $p) (local.get $t))
    (i32.store offset=8  (local.get $p) (local.get $r))
    (i32.store offset=12 (local.get $p) (local.get $b))
    (local.get $p))

  (func $paint_scratch_mark (result i32) (global.get $paint_scratch_cursor))

  (func $paint_scratch_reset (param $mark i32)
    (global.set $paint_scratch_cursor (local.get $mark)))

  ;; FNV-1a hash over null-terminated string at WASM address
  (func $hash_api_name (param $ptr i32) (result i32)
    (local $h i32) (local $ch i32)
    (local.set $h (i32.const 0x811c9dc5))
    (block $done (loop $next
      (local.set $ch (i32.load8_u (local.get $ptr)))
      (br_if $done (i32.eqz (local.get $ch)))
      (local.set $h (i32.xor (local.get $h) (local.get $ch)))
      (local.set $h (i32.mul (local.get $h) (i32.const 0x01000193)))
      (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
      (br $next)))
    (local.get $h))

  ;; Lookup API ID from static hash table. Returns 0xFFFF if not found.
  (func $lookup_api_id (param $name_ptr i32) (result i32)
    (local $h i32) (local $i i32) (local $entry_addr i32)
    (local.set $h (call $hash_api_name (local.get $name_ptr)))
    (local.set $i (i32.const 0))
    (block $notfound (loop $scan
      (br_if $notfound (i32.ge_u (local.get $i) (global.get $API_HASH_COUNT)))
      (local.set $entry_addr (i32.add (global.get $API_HASH_TABLE) (i32.mul (local.get $i) (i32.const 8))))
      (if (i32.eq (i32.load (local.get $entry_addr)) (local.get $h))
        (then (return (i32.load (i32.add (local.get $entry_addr) (i32.const 4))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0xFFFF))

  ;; Some Win9x-era binaries carry stale import-name strings but correct
  ;; export hints. Funtris imports USER32 hint 446 (MessageBoxA) with the
  ;; name string "GetMessageA"; resolving only by name sends its startup
  ;; message box through the message pump.
  (func $import_hint_override_api_id (param $dll_name_ga i32) (param $hint_name_wa i32) (result i32)
    (local $name_wa i32)
    (local.set $name_wa (i32.add (local.get $hint_name_wa) (i32.const 2)))
    (if (i32.and
          (i32.and
            (i32.eq (i32.load16_u (local.get $hint_name_wa)) (i32.const 446))
            (call $str_eq (local.get $name_wa) (i32.const 0x330))) ;; GetMessageA
          (call $dll_name_match (local.get $dll_name_ga) (i32.const 0x325))) ;; USER32.dll
      (then (return (call $lookup_api_id (i32.const 0x319))))) ;; MessageBoxA
    (i32.const -1))

  ;; Apply segment override to an address. FS=5 adds fs_base. GS=6 traps
  ;; (no Win32 use of GS in this emulator). Other segments treated flat.
  (func $seg_adj (param $addr i32) (param $seg i32) (result i32)
    (if (i32.eq (local.get $seg) (i32.const 6))
      (then
        (call $host_log_i32 (i32.const 0xCA5E9006))
        (unreachable)))
    (if (result i32) (i32.eq (local.get $seg) (i32.const 5))
      (then (i32.add (local.get $addr) (global.get $fs_base)))
      (else (local.get $addr))))

  (func $strlen (param $ptr i32) (result i32)
    (local $i i32)
    (block $d (loop $l
      (br_if $d (i32.eqz (i32.load8_u (i32.add (local.get $ptr) (local.get $i)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (local.get $i))
  ;; strlen for WASM-addressed byte strings (alias for $strlen)
  (func $strlen_a (param $ptr i32) (result i32)
    (call $strlen (local.get $ptr)))
  ;; wcslen for WASM-addressed UTF-16 strings, returns char count
  (func $strlen_w (param $ptr i32) (result i32)
    (local $i i32)
    (block $d (loop $l
      (br_if $d (i32.eqz (i32.load16_u (i32.add (local.get $ptr) (i32.mul (local.get $i) (i32.const 2))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (local.get $i))
  (func $memcpy (param $dst i32) (param $src i32) (param $len i32)
    (if (local.get $len) (then (memory.copy (local.get $dst) (local.get $src) (local.get $len)))))
  (func $zero_memory (param $ptr i32) (param $len i32)
    (if (local.get $len) (then (memory.fill (local.get $ptr) (i32.const 0) (local.get $len)))))

  ;; Page-aligned DIB allocation. The arena is intentionally separate from
  ;; HeapAlloc/VirtualAlloc so every guest store needs only one range check to
  ;; decide whether it can dirty a display bitmap.
  (func $dib_alloc (param $size i32) (result i32)
    (local $pages i32) (local $page i32) (local $run i32) (local $start i32)
    (local $i i32)
    (if (i32.eqz (local.get $size)) (then (return (i32.const 0))))
    (local.set $pages
      (i32.shr_u (i32.add (local.get $size) (i32.const 0xFFF)) (i32.const 12)))
    (if (i32.or
          (i32.eqz (local.get $pages))
          (i32.gt_u (local.get $pages) (global.get $DIB_PAGE_COUNT)))
      (then (return (i32.const 0))))
    (local.set $page (i32.const 0))
    (block $found (loop $scan
      (if (i32.ge_u (local.get $page) (global.get $DIB_PAGE_COUNT))
        (then (return (i32.const 0))))
      (if (i32.eqz (i32.load8_u
            (i32.add (global.get $DIB_PAGE_USED) (local.get $page))))
        (then
          (if (i32.eqz (local.get $run)) (then (local.set $start (local.get $page))))
          (local.set $run (i32.add (local.get $run) (i32.const 1)))
          (br_if $found (i32.eq (local.get $run) (local.get $pages))))
        (else (local.set $run (i32.const 0))))
      (local.set $page (i32.add (local.get $page) (i32.const 1)))
      (br $scan)))
    (i32.store16
      (i32.add (global.get $DIB_PAGE_RUNS) (i32.shl (local.get $start) (i32.const 1)))
      (local.get $pages))
    (local.set $i (i32.const 0))
    (block $marked (loop $mark
      (br_if $marked (i32.ge_u (local.get $i) (local.get $pages)))
      (i32.store8
        (i32.add (global.get $DIB_PAGE_USED) (i32.add (local.get $start) (local.get $i)))
        (i32.const 1))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $mark)))
    (call $zero_memory
      (i32.add (global.get $DIB_BACKING_BASE) (i32.shl (local.get $start) (i32.const 12)))
      (i32.shl (local.get $pages) (i32.const 12)))
    (i32.add (global.get $DIB_GUEST_BASE) (i32.shl (local.get $start) (i32.const 12))))

  (func $dib_free_wasm (param $wa i32)
    (local $page i32) (local $pages i32) (local $i i32)
    (if (i32.ge_u
          (i32.sub (local.get $wa) (global.get $DIB_BACKING_BASE))
          (global.get $DIB_BACKING_BASE_SIZE))
      (then (return)))
    (local.set $page
      (i32.shr_u (i32.sub (local.get $wa) (global.get $DIB_BACKING_BASE)) (i32.const 12)))
    (local.set $pages
      (i32.load16_u
        (i32.add (global.get $DIB_PAGE_RUNS) (i32.shl (local.get $page) (i32.const 1)))))
    (if (i32.eqz (local.get $pages)) (then (return)))
    (i32.store16
      (i32.add (global.get $DIB_PAGE_RUNS) (i32.shl (local.get $page) (i32.const 1)))
      (i32.const 0))
    (block $done (loop $clear
      (br_if $done (i32.ge_u (local.get $i) (local.get $pages)))
      (i32.store8
        (i32.add (global.get $DIB_PAGE_USED) (i32.add (local.get $page) (local.get $i)))
        (i32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $clear))))

  ;; Fast path for the MSVC CRT small-block heap descriptor scan:
  ;;
  ;;   mov eax,[scan]
  ;;   cmp eax,ebx
  ;;   jl  next
  ;;   cmp [scan+4],ebx
  ;;   jbe next
  ;;   ... allocate from page ...
  ;; next:
  ;;   add scan,8
  ;;   add page,0x1000
  ;;   cmp scan,ebp
  ;;   jb  loop
  ;;
  ;; Several statically linked MSVC apps use this loop in their CRT allocator.
  ;; Running it one x86 block per descriptor dominates large data-load phases.
  ;; This recognizes the exact byte pattern with either ESI or EDI as the scan
  ;; register, skips failing descriptors in WAT, and resumes at the normal x86
  ;; allocation path or loop exit.
  ;; Which variant of the loop begins at $wa: 0 = none, 1 = ESI scans / EDI
  ;; pages, 2 = the register-swapped twin.
  ;;
  ;; This used to run inline in the run loop, ahead of every single block
  ;; dispatch, for every app — 17 loads and 16 compares with no early-out, tens
  ;; of millions of times a second, to recognize one CRT loop that most
  ;; binaries do not even contain. The bytes are static code, so the question
  ;; only has to be asked when a block is decoded: $decode_block calls
  ;; $sbh_note_candidate below, and the run loop compares EIP against the one
  ;; or two addresses that answered yes.
  (func $sbh_match_mode (param $wa i32) (result i32)
    (local $match i32)
    ;; ESI scan / EDI page variant.
    (local.set $match (i32.const 1))
    (if (i32.ne (i32.load16_u (local.get $wa)) (i32.const 0x068B)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load16_u offset=2 (local.get $wa)) (i32.const 0xC33B)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load16_u offset=4 (local.get $wa)) (i32.const 0x1B7C)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load16_u offset=6 (local.get $wa)) (i32.const 0x5E39)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load8_u offset=8 (local.get $wa)) (i32.const 0x04)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load16_u offset=9 (local.get $wa)) (i32.const 0x1676)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load16_u offset=0x21 (local.get $wa)) (i32.const 0xC683)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load16_u offset=0x2C (local.get $wa)) (i32.const 0xD272)) (then (local.set $match (i32.const 0))))
    (if (local.get $match) (then (return (i32.const 1))))

    ;; EDI scan / ESI page variant.
    (local.set $match (i32.const 1))
    (if (i32.ne (i32.load16_u (local.get $wa)) (i32.const 0x078B)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load16_u offset=2 (local.get $wa)) (i32.const 0xC33B)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load16_u offset=4 (local.get $wa)) (i32.const 0x1B7C)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load16_u offset=6 (local.get $wa)) (i32.const 0x5F39)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load8_u offset=8 (local.get $wa)) (i32.const 0x04)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load16_u offset=9 (local.get $wa)) (i32.const 0x1676)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load16_u offset=0x21 (local.get $wa)) (i32.const 0xC783)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load16_u offset=0x2C (local.get $wa)) (i32.const 0xD272)) (then (local.set $match (i32.const 0))))
    (if (local.get $match) (then (return (i32.const 2))))
    (i32.const 0))

  ;; Called once per decoded block. Two slots is not a limit anyone will hit —
  ;; the pattern is one CRT allocator loop, and its two register variants
  ;; cannot both be the same address — but a third match is simply not
  ;; accelerated rather than mis-accelerated.
  (func $sbh_note_candidate (param $eip i32)
    (if (i32.or (i32.eq (global.get $sbh_eip_a) (local.get $eip))
                (i32.eq (global.get $sbh_eip_b) (local.get $eip)))
      (then (return)))
    (if (i32.eqz (call $sbh_match_mode (call $g2w (local.get $eip)))) (then (return)))
    (if (i32.eqz (global.get $sbh_eip_a))
      (then (global.set $sbh_eip_a (local.get $eip)) (return)))
    (if (i32.eqz (global.get $sbh_eip_b))
      (then (global.set $sbh_eip_b (local.get $eip)))))

  (func $fast_msvc_sbh_scan (result i32)
    (local $wa i32) (local $scan i32) (local $page i32)
    (local $first i32) (local $mode i32) (local $match i32)
    (local.set $wa (call $g2w (global.get $eip)))
    (local.set $mode (call $sbh_match_mode (local.get $wa)))
    (if (i32.eq (local.get $mode) (i32.const 1))
      (then
        (local.set $scan (global.get $esi))
        (local.set $page (global.get $edi))))
    (if (i32.eq (local.get $mode) (i32.const 2))
      (then
        (local.set $scan (global.get $edi))
        (local.set $page (global.get $esi))))

    (if (i32.eqz (local.get $mode)) (then (return (i32.const 0))))

    (block $done (loop $scan_loop
      (if (i32.ge_u (local.get $scan) (global.get $ebp))
        (then
          (if (i32.eq (local.get $mode) (i32.const 1))
            (then
              (global.set $esi (local.get $scan))
              (global.set $edi (local.get $page)))
            (else
              (global.set $edi (local.get $scan))
              (global.set $esi (local.get $page))))
          (global.set $eip (i32.add (global.get $eip) (i32.const 0x2E)))
          (return (i32.const 1))))

      (local.set $first (i32.load (call $g2w (local.get $scan))))
      (if (i32.and
            (i32.ge_s (local.get $first) (global.get $ebx))
            (i32.gt_u (i32.load offset=4 (call $g2w (local.get $scan))) (global.get $ebx)))
        (then
          (global.set $eax (local.get $first))
          (if (i32.eq (local.get $mode) (i32.const 1))
            (then
              (global.set $esi (local.get $scan))
              (global.set $edi (local.get $page)))
            (else
              (global.set $edi (local.get $scan))
              (global.set $esi (local.get $page))))
          (global.set $eip (i32.add (global.get $eip) (i32.const 0x0B)))
          (return (i32.const 1))))

      (local.set $scan (i32.add (local.get $scan) (i32.const 8)))
      (local.set $page (i32.add (local.get $page) (i32.const 0x1000)))
      (br $scan_loop)))
    (i32.const 1))

  ;; ---- Cross-instance mutex -------------------------------------------------
  ;; Spin, never park. `memory.atomic.wait32` is illegal on a browser main
  ;; thread, and the main thread does take these — so a lock that parks would
  ;; either trap there or need two implementations. Spinning is affordable only
  ;; because every critical section here is pure table arithmetic a few hundred
  ;; instructions long, and it is the reason for rule 1 in the header comment:
  ;; a section that called a host import could be parked in Atomics.wait waiting
  ;; for the very thread that is spinning for its lock.
  ;;
  ;; Recursive by owner id, so a critical section that reaches another function
  ;; taking the same lock deadlocks nothing. That is defence rather than a
  ;; feature: nothing here nests deliberately.
  (func $lock_acquire (param $lock i32)
    (local $me i32) (local $spins i32)
    (local.set $me (global.get $current_thread_id))
    (if (i32.eq (i32.atomic.load (local.get $lock)) (local.get $me))
      (then
        (i32.store (i32.add (local.get $lock) (i32.const 4))
          (i32.add (i32.load (i32.add (local.get $lock) (i32.const 4))) (i32.const 1)))
        (return)))
    (block $held (loop $spin
      (br_if $held
        (i32.eqz
          (i32.atomic.rmw.cmpxchg (local.get $lock) (i32.const 0) (local.get $me))))
      (local.set $spins (i32.add (local.get $spins) (i32.const 1)))
      ;; A holder that never releases is a bug we would otherwise experience as
      ;; a silent hang with no stack. Name it once, then keep spinning: the
      ;; alternative — breaking the lock — corrupts the table it protects.
      (if (i32.eq (local.get $spins) (i32.const 10000000))
        (then
          (call $host_log_i32 (i32.const 0xDEAD10CC))
          (call $host_log_i32 (local.get $lock))
          (call $host_log_i32 (i32.atomic.load (local.get $lock)))))
      (br $spin)))
    (i32.store (i32.add (local.get $lock) (i32.const 4)) (i32.const 1)))

  ;; The window/class/timer tables all take one lock, through this pair rather
  ;; than at each site: they are claimed from three files, and a lock whose
  ;; every use is spelled out by hand is a lock somebody eventually forgets to
  ;; release. It also makes the negative control one edit — turn these into
  ;; no-ops and test/test-wat-window-tables.js reports lost windows again.
  (func $lock_wnd_acquire (call $lock_acquire (global.get $LOCK_WND)))
  (func $lock_wnd_release (call $lock_release (global.get $LOCK_WND)))

  (func $lock_release (param $lock i32)
    (local $depth i32)
    (local.set $depth
      (i32.sub (i32.load (i32.add (local.get $lock) (i32.const 4))) (i32.const 1)))
    (i32.store (i32.add (local.get $lock) (i32.const 4)) (local.get $depth))
    (if (i32.le_s (local.get $depth) (i32.const 0))
      (then
        (i32.store (i32.add (local.get $lock) (i32.const 4)) (i32.const 0))
        ;; The atomic store is the release: every plain write in the critical
        ;; section is ordered before it, so the next holder sees a whole table.
        (i32.atomic.store (local.get $lock) (i32.const 0)))))

  ;; The high guest-address allocator is process-wide. Mutable WAT globals are
  ;; per instance, so a worker can otherwise reserve from a stale top and
  ;; overlap a range already owned by the main instance. Keep the authoritative
  ;; downward cursor in shared memory at VIRTUAL_MAP_STATE+8.
  ;; Lower the shared top to $guest if it is below it. A compare-and-swap loop
  ;; rather than a lock: the whole operation is one word, so there is nothing for
  ;; a lock to protect that the CAS does not, and no way to forget to release it.
  (func $virtual_shared_top_observe (param $guest i32)
    (local $cell i32) (local $top i32)
    (local.set $cell (i32.add (global.get $VIRTUAL_MAP_STATE) (i32.const 8)))
    (block $done (loop $retry
      (local.set $top (i32.atomic.load (local.get $cell)))
      (br_if $done
        (i32.and (i32.ne (local.get $top) (i32.const 0))
                 (i32.le_u (local.get $top) (local.get $guest))))
      (br_if $done
        (i32.eq (local.get $top)
          (i32.atomic.rmw.cmpxchg (local.get $cell) (local.get $top) (local.get $guest))))
      (br $retry))))

  (func $virtual_reserve_down (param $size i32) (result i32)
    (local $cell i32) (local $top i32) (local $new_top i32) (local $seen i32)
    (local.set $cell (i32.add (global.get $VIRTUAL_MAP_STATE) (i32.const 8)))
    ;; Reserve by CAS, and re-derive the new top from whatever the winner left
    ;; behind. Reading the cursor, subtracting and storing would let two
    ;; instances carve the same 64KB range out of one gap.
    (block $done (loop $retry
      (local.set $top (i32.atomic.load (local.get $cell)))
      (if (i32.eqz (local.get $top))
        (then
          (local.set $top (global.get $virtual_alloc_top))
          (if (i32.eqz (local.get $top))
            (then (local.set $top (global.get $VIRTUAL_ALLOC_TOP_INIT))))
          (local.set $seen (i32.const 0)))
        (else (local.set $seen (local.get $top))))
      (local.set $new_top
        (i32.and (i32.sub (local.get $top) (local.get $size))
          (i32.const 0xFFFF0000)))
      (if (i32.lt_u (local.get $new_top) (global.get $VIRTUAL_ALLOC_MIN))
        (then (return (i32.const 0))))
      (br_if $done
        (i32.eq (local.get $seen)
          (i32.atomic.rmw.cmpxchg (local.get $cell) (local.get $seen) (local.get $new_top))))
      (br $retry)))
    (global.set $virtual_alloc_top (local.get $new_top))
    (local.get $new_top))

  ;; Back a high guest VirtualAlloc commit with real WASM memory. Entries are
  ;; coalesced when the guest commits adjacent 64KB chunks in order, which keeps
  ;; g2w's sparse-map scan short for CRT small-block heap arenas.
  ;; Writers serialise; readers do not, and must not — $g2w consults this table
  ;; on every guest access that misses the direct window, millions of times a
  ;; second, so a reader-side lock would be the most expensive instruction in
  ;; the emulator. What makes the lock-free read safe is the publish order:
  ;;
  ;;   append:  fill the record → zero its backing → ATOMIC store count+1
  ;;   extend:  zero the new tail → ATOMIC store the larger size
  ;;
  ;; In both cases the count or size a reader can observe only ever names memory
  ;; that is already there. A reader that misses a just-published entry simply
  ;; behaves as it did a microsecond earlier.
  (func $virtual_map_commit (param $guest i32) (param $size i32) (result i32)
    (local $r i32)
    (call $lock_acquire (global.get $LOCK_VIRTUAL_MAP))
    (local.set $r (call $virtual_map_commit_locked (local.get $guest) (local.get $size)))
    (call $lock_release (global.get $LOCK_VIRTUAL_MAP))
    (local.get $r))

  (func $virtual_map_commit_locked (param $guest i32) (param $size i32) (result i32)
    (local $count i32) (local $backing_ptr i32) (local $guest_end i32)
    (local $i i32) (local $rec i32) (local $base i32) (local $map_size i32)
    (local $backing i32) (local $map_end i32) (local $backing_end i32)
    (local.set $guest_end (i32.add (local.get $guest) (local.get $size)))
    (local.set $count (i32.load (global.get $VIRTUAL_MAP_STATE)))
    (local.set $backing_ptr (i32.load (i32.add (global.get $VIRTUAL_MAP_STATE) (i32.const 4))))
    (if (i32.eqz (local.get $backing_ptr))
      (then (local.set $backing_ptr (global.get $VIRTUAL_BACKING_BASE))))

    (local.set $i (i32.const 0))
    (block $scan_done (loop $scan
      (br_if $scan_done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $rec (i32.add (global.get $VIRTUAL_MAP_TABLE) (i32.shl (local.get $i) (i32.const 4))))
      (local.set $base (i32.load (local.get $rec)))
      (local.set $map_size (i32.load (i32.add (local.get $rec) (i32.const 4))))
      (local.set $backing (i32.load (i32.add (local.get $rec) (i32.const 8))))
      (local.set $map_end (i32.add (local.get $base) (local.get $map_size)))
      (local.set $backing_end (i32.add (local.get $backing) (local.get $map_size)))
      (if (i32.and
            (i32.ge_u (local.get $guest) (local.get $base))
            (i32.le_u (local.get $guest_end) (local.get $map_end)))
        (then (return (local.get $guest))))
      (if (i32.and
            (i32.eq (local.get $guest) (local.get $map_end))
            (i32.eq (local.get $backing_ptr) (local.get $backing_end)))
        (then
          (if (i32.gt_u
                (i32.add (local.get $backing_ptr) (local.get $size))
                (i32.add (global.get $VIRTUAL_BACKING_BASE) (global.get $VIRTUAL_BACKING_BASE_SIZE)))
            (then (return (i32.const 0))))
          (call $zero_memory (local.get $backing_ptr) (local.get $size))
          ;; Published last, atomically: a reader that sees the larger size is
          ;; guaranteed the backing behind it exists and is zeroed.
          (i32.atomic.store (i32.add (local.get $rec) (i32.const 4))
            (i32.add (local.get $map_size) (local.get $size)))
          (i32.store (i32.add (global.get $VIRTUAL_MAP_STATE) (i32.const 4))
            (i32.add (local.get $backing_ptr) (local.get $size)))
          (return (local.get $guest))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))

    (if (i32.ge_u (local.get $count) (global.get $MAX_VIRTUAL_MAPS))
      (then (return (i32.const 0))))
    (if (i32.gt_u
          (i32.add (local.get $backing_ptr) (local.get $size))
          (i32.add (global.get $VIRTUAL_BACKING_BASE) (global.get $VIRTUAL_BACKING_BASE_SIZE)))
      (then (return (i32.const 0))))
    (local.set $rec (i32.add (global.get $VIRTUAL_MAP_TABLE) (i32.shl (local.get $count) (i32.const 4))))
    (i32.store (local.get $rec) (local.get $guest))
    (i32.store (i32.add (local.get $rec) (i32.const 4)) (local.get $size))
    (i32.store (i32.add (local.get $rec) (i32.const 8)) (local.get $backing_ptr))
    (i32.store (i32.add (local.get $rec) (i32.const 12)) (i32.const 0))
    (call $zero_memory (local.get $backing_ptr) (local.get $size))
    ;; The record is complete and its backing zeroed before the count that makes
    ;; it visible. Reversing these two lines is the whole bug this ordering
    ;; avoids: $g2w would map a guest address onto a record still being filled.
    (i32.atomic.store (global.get $VIRTUAL_MAP_STATE) (i32.add (local.get $count) (i32.const 1)))
    (i32.store (i32.add (global.get $VIRTUAL_MAP_STATE) (i32.const 4))
      (i32.add (local.get $backing_ptr) (local.get $size)))
    (call $virtual_shared_top_observe (local.get $guest))
    (global.set $virtual_alloc_top (local.get $guest))
    (local.get $guest))

  ;; Publish the process heap. Called by the PE loader on the instance that loads
  ;; the image; every other instance picks the same values up from HEAP_SHARED in
  ;; $init_thread, because a mutable global would give it a private copy.
  (func $heap_init (param $base i32)
    (global.set $heap_base (local.get $base))
    (global.set $heap_ptr (i32.const 0))
    (global.set $heap_end (i32.const 0))
    (i32.store (global.get $HEAP_SHARED) (local.get $base))
    (i32.store (i32.add (global.get $HEAP_SHARED) (i32.const 4)) (local.get $base)))

  ;; Top of everything the low heap has handed out, process-wide. 0 means the
  ;; heap has not been touched yet. The DLL loader needs this to place an image
  ;; clear of every arena; $heap_ptr would only tell it about one instance.
  (func $heap_low_watermark (result i32)
    (i32.atomic.load (global.get $HEAP_SHARED)))

  ;; Declare that the low heap must not hand out anything below $addr — a DLL
  ;; image now occupies that range. Only moves the cursor forward, so a DLL
  ;; loaded below the watermark (fixed preferred base) costs nothing.
  (func $heap_reserve_below (param $addr i32)
    (local $cursor i32) (local $moved i32)
    ;; Raise the cursor by CAS. A plain compare-then-store loses a concurrent
    ;; reservation: two instances loading the same cursor both write their own
    ;; value, and the loser's arena is handed out again by the winner.
    (block $done (loop $retry
      (local.set $cursor (i32.atomic.load (global.get $HEAP_SHARED)))
      (br_if $done (i32.le_u (local.get $addr) (local.get $cursor)))
      (if (i32.eq (local.get $cursor)
            (i32.atomic.rmw.cmpxchg (global.get $HEAP_SHARED)
              (local.get $cursor) (local.get $addr)))
        (then (local.set $moved (i32.const 1)) (br $done)))
      (br $retry)))
    (if (local.get $moved)
      (then
        (i32.store (i32.add (global.get $HEAP_SHARED) (i32.const 4)) (local.get $addr))
        (global.set $heap_base (local.get $addr))
        ;; This instance's arena ended at the old cursor, so it cannot reach into
        ;; the image — but drop it anyway rather than reason about that here.
        (global.set $heap_ptr (i32.const 0))
        (global.set $heap_end (i32.const 0)))))

  ;; Reserve this instance's next private chunk of the low guest heap window.
  ;; The cursor is shared; the arena handed back is exclusively ours, so the
  ;; per-allocation fast path in $heap_alloc needs no synchronization at all.
  ;;
  ;; The reservation is a compare-and-swap loop, so two instances allocating at
  ;; the same instant get different chunks rather than the same one. No lock: one
  ;; word, one CAS, and nothing to release on the early-return paths below.
  (func $heap_low_reserve (param $need i32) (result i32)
    (local $state i32) (local $cursor i32) (local $chunk i32) (local $seed i32)
    (local.set $state (global.get $HEAP_SHARED))
    (block $reserved (loop $retry
      (local.set $cursor (i32.atomic.load (local.get $state)))
      ;; Seed the process cursor on first use. $heap_init does this at PE load;
      ;; harnesses that drive the exports without an image never get there, so
      ;; fall back to the default heap base rather than failing every allocation.
      ;; Seeding by CAS means the loser adopts the winner's base instead of
      ;; overwriting it — two instances can disagree about what "no image" means.
      (if (i32.eqz (local.get $cursor))
        (then
          (local.set $seed
            (select (global.get $heap_base) (global.get $HEAP_DEFAULT_BASE)
              (i32.ne (global.get $heap_base) (i32.const 0))))
          (if (i32.eqz
                (i32.atomic.rmw.cmpxchg (local.get $state) (i32.const 0) (local.get $seed)))
            (then (i32.store (i32.add (local.get $state) (i32.const 4)) (local.get $seed))))
          (if (i32.eqz (global.get $heap_base))
            (then (global.set $heap_base
              (i32.load (i32.add (local.get $state) (i32.const 4))))))
          (br $retry)))
      ;; One chunk must satisfy this allocation outright, so an oversized request
      ;; takes an oversized chunk rather than failing against a 1MB granule.
      (local.set $chunk (global.get $HEAP_ARENA_CHUNK))
      (if (i32.gt_u (local.get $need) (local.get $chunk))
        (then (local.set $chunk
          (i32.and (i32.add (local.get $need) (i32.const 0xFFF)) (i32.const 0xFFFFF000)))))
      ;; Overflow, and the boundary where low guest memory would run into the
      ;; emulator's own decoded-code cache — either way the caller spills to the
      ;; sparse high arena instead.
      (if (i32.lt_u (i32.add (local.get $cursor) (local.get $chunk)) (local.get $cursor))
        (then (return (i32.const 0))))
      (if (i32.gt_u
            (call $g2w (i32.add (local.get $cursor) (local.get $chunk)))
            (global.get $THREAD_CACHE_BASE))
        (then (return (i32.const 0))))
      ;; Claim it, or lose the race and recompute against the winner's cursor.
      (br_if $reserved
        (i32.eq (local.get $cursor)
          (i32.atomic.rmw.cmpxchg (local.get $state) (local.get $cursor)
            (i32.add (local.get $cursor) (local.get $chunk)))))
      (br $retry)))
    (global.set $heap_ptr (local.get $cursor))
    (global.set $heap_end (i32.add (local.get $cursor) (local.get $chunk)))
    (local.get $cursor))

  ;; HeapAlloc starts in the low direct guest window for compatibility, then
  ;; spills to sparse high guest chunks when that window reaches emulator-private
  ;; memory. This keeps Windows heap pointers valid without moving code caches.
  (func $heap_sparse_alloc (param $need i32) (result i32)
    (local $chunk i32) (local $new_top i32) (local $ptr i32)
    (if (i32.or
          (i32.eqz (global.get $heap_sparse_ptr))
          (i32.gt_u
            (i32.add (global.get $heap_sparse_ptr) (local.get $need))
            (global.get $heap_sparse_end)))
      (then
        (local.set $chunk
          (i32.and
            (i32.add (local.get $need) (i32.const 0xFFF))
            (i32.const 0xFFFFF000)))
        (if (i32.lt_u (local.get $chunk) (i32.const 0x00100000))
          (then (local.set $chunk (i32.const 0x00100000))))
        (local.set $chunk
          (i32.and
            (i32.add (local.get $chunk) (i32.const 0xFFFF))
            (i32.const 0xFFFF0000)))
        (local.set $new_top (call $virtual_reserve_down (local.get $chunk)))
        (if (i32.eqz (local.get $new_top)) (then (return (i32.const 0))))
        (if (i32.eqz (call $virtual_map_commit (local.get $new_top) (local.get $chunk)))
          (then (return (i32.const 0))))
        (global.set $heap_sparse_ptr (local.get $new_top))
        (global.set $heap_sparse_end (i32.add (local.get $new_top) (local.get $chunk)))))
    (local.set $ptr (global.get $heap_sparse_ptr))
    (global.set $heap_sparse_ptr (i32.add (global.get $heap_sparse_ptr) (local.get $need)))
    (i32.store (call $g2w (local.get $ptr)) (local.get $need))
    (local.get $ptr))

  ;; Free-list allocator. Each allocated block has a 4-byte size header at ptr-4.
  ;; Free blocks: [size:4][next_guest_ptr:4][...]. Min block = 16 bytes.
  ;; Falls back to bump allocation when no free block fits.
  (func $heap_alloc (param $size i32) (result i32)
    (local $need i32) (local $ptr i32)
    (local $prev_w i32) (local $cur i32) (local $cur_w i32)
    (local $bsz i32) (local $rem i32)
    ;; Refuse huge/overflowing allocations before adding the block header.
    (if (i32.gt_u (local.get $size) (i32.const 0x7FFFFFF0))
      (then (return (i32.const 0))))
    ;; need = align8(size + 4 header), minimum 16
    (local.set $need (i32.and (i32.add (i32.add (local.get $size) (i32.const 4)) (i32.const 7)) (i32.const 0xFFFFFFF8)))
    (if (i32.lt_u (local.get $need) (local.get $size))
      (then (return (i32.const 0))))
    (if (i32.lt_u (local.get $need) (i32.const 16)) (then (local.set $need (i32.const 16))))
    ;; Walk free list (guest pointers)
    (local.set $prev_w (i32.const 0)) ;; 0 = scanning from head
    (local.set $cur (global.get $free_list))
    (block $found (block $scan (loop $fl
      (br_if $scan (i32.eqz (local.get $cur)))
      (local.set $cur_w (call $g2w (local.get $cur)))
      (local.set $bsz (i32.load (local.get $cur_w)))
      (if (i32.ge_u (local.get $bsz) (local.get $need))
        (then
          ;; Found a fit. Split if remainder >= 16, else use whole block.
          (local.set $rem (i32.sub (local.get $bsz) (local.get $need)))
          (if (i32.ge_u (local.get $rem) (i32.const 16))
            (then
              ;; Shrink free block from the end: free block keeps first (rem) bytes
              (i32.store (local.get $cur_w) (local.get $rem))
              ;; Allocated block starts at cur + rem
              (local.set $ptr (i32.add (local.get $cur) (local.get $rem)))
              (i32.store (call $g2w (local.get $ptr)) (local.get $need)))
            (else
              ;; Use whole block — unlink from free list
              (local.set $ptr (local.get $cur))
              (if (local.get $prev_w)
                (then (i32.store (i32.add (local.get $prev_w) (i32.const 4))
                  (i32.load (i32.add (local.get $cur_w) (i32.const 4)))))
                (else (global.set $free_list
                  (i32.load (i32.add (local.get $cur_w) (i32.const 4))))))))
          (br $found)))
      (local.set $prev_w (local.get $cur_w))
      (local.set $cur (i32.load (i32.add (local.get $cur_w) (i32.const 4))))
      (br $fl)))
      ;; No free block found — bump allocate inside this instance's arena.
      ;; When the arena is exhausted (or was never reserved) take another chunk
      ;; from the shared cursor. If the low window itself is spent, spill to the
      ;; sparse high arena: low guest memory must not run into the emulator's own
      ;; decoded-code cache. Pawn-style chess engines ask for 64 MB transposition
      ;; tables that land here; returning 0 lets the app handle OOM.
      (if (i32.or
            (i32.eqz (global.get $heap_ptr))
            (i32.or
              ;; overflow of ptr + need
              (i32.lt_u
                (i32.add (global.get $heap_ptr) (local.get $need))
                (global.get $heap_ptr))
              (i32.gt_u
                (i32.add (global.get $heap_ptr) (local.get $need))
                (global.get $heap_end))))
        (then
          (if (i32.eqz (call $heap_low_reserve (local.get $need)))
            (then
              (local.set $ptr (call $heap_sparse_alloc (local.get $need)))
              (if (local.get $ptr) (then (br $found)) (else (return (i32.const 0))))))))
      (local.set $ptr (global.get $heap_ptr))
      (i32.store (call $g2w (local.get $ptr)) (local.get $need))
      (global.set $heap_ptr (i32.add (global.get $heap_ptr) (local.get $need))))
    ;; Return guest pointer past the size header
    (i32.add (local.get $ptr) (i32.const 4)))

  ;; heap_free: return block to free list
  (func $heap_free (param $guest_ptr i32)
    (local $block i32) (local $w i32)
    (if (i32.eqz (local.get $guest_ptr)) (then (return)))
    ;; Only free blocks in our heap range — ignore foreign blocks
    ;; (e.g., msvcrt sbh blocks that shouldn't reach our free list). $heap_base
    ;; is per-instance and only the PE-loading instance sets it, so a zero here
    ;; would let a worker admit foreign blocks and then reissue them; read the
    ;; shared copy when this instance has none.
    (if (i32.eqz (global.get $heap_base))
      (then (global.set $heap_base
        (i32.load (i32.add (global.get $HEAP_SHARED) (i32.const 4))))))
    (if (i32.eqz (global.get $heap_base)) (then (return)))
    (if (i32.lt_u (local.get $guest_ptr) (global.get $heap_base)) (then (return)))
    ;; Block starts 4 bytes before the user pointer
    (local.set $block (i32.sub (local.get $guest_ptr) (i32.const 4)))
    (local.set $w (call $g2w (local.get $block)))
    ;; Prepend to free list: store next = old head
    (i32.store (i32.add (local.get $w) (i32.const 4)) (global.get $free_list))
    (global.set $free_list (local.get $block)))

;; DC record offsets: hdc, pen, brush, pos x/y, text/bk colors, bk mode,
  ;; text align, map mode, window origin/extents, viewport origin/extents,
  ;; ROP2, polygon fill mode, stretch mode, bitmap, font, reserved.
  (global $gdi_dc_state_hint (mut i32) (i32.const 0))
(func (export "test_gdi_object_adopt") (param i32) (param i32) (param i32)
        (param i32) (param i32) (param i32) (result i32)
    (call $gdi_object_adopt (local.get 0) (local.get 1) (local.get 2)
      (local.get 3) (local.get 4) (local.get 5)))
  (func (export "test_gdi_object_type") (param i32) (result i32)
    (call $gdi_object_type (local.get 0)))
  (func (export "test_gdi_object_delete") (param i32) (result i32)
    (call $gdi_object_delete (local.get 0)))
  (func (export "test_gdi_dc_get_field") (param i32) (param i32) (param i32) (result i32)
    (call $gdi_dc_get_field (local.get 0) (local.get 1) (local.get 2)))
  (func (export "test_gdi_dc_set_field") (param i32) (param i32) (param i32) (param i32) (result i32)
    (call $gdi_dc_set_field (local.get 0) (local.get 1) (local.get 2) (local.get 3)))
  (func (export "test_gdi_dc_aux_get") (param i32) (param i32) (param i32) (result i32)
    (call $gdi_dc_aux_get (local.get 0) (local.get 1) (local.get 2)))
  (func (export "test_gdi_dc_aux_set") (param i32) (param i32) (param i32) (param i32) (result i32)
    (call $gdi_dc_aux_set (local.get 0) (local.get 1) (local.get 2) (local.get 3)))
  (func (export "test_gdi_dc_select_owned_object") (param i32) (param i32) (result i32)
    (call $gdi_dc_select_owned_object (local.get 0) (local.get 1)))
  (func (export "test_gdi_dc_save") (param i32) (result i32)
    (call $gdi_dc_save (local.get 0)))
  (func (export "test_gdi_dc_restore") (param i32) (param i32) (result i32)
    (call $gdi_dc_restore (local.get 0) (local.get 1)))
  (func (export "test_gdi_surface_descriptor") (param i32) (param i32) (result i32)
    (call $gdi_surface_descriptor (local.get 0) (local.get 1)))
  (func (export "test_gdi_dx_dc_bind") (param i32) (result i32)
    (call $gdi_dx_dc_bind (local.get 0)))
  (func (export "test_gdi_dx_dc_release") (param i32)
    (call $gdi_dx_dc_release (local.get 0)))

;; heap_realloc: reallocate a heap block (guest ptrs)
  ;; Returns new guest pointer (or 0 on failure). Copies old data, frees old block.
  ;; flags: bit 6 = LMEM_ZEROINIT/GMEM_ZEROINIT
  (func $heap_realloc (param $old_ptr i32) (param $new_size i32) (param $flags i32) (result i32)
    (local $new_ptr i32) (local $old_block_size i32) (local $old_data_size i32) (local $copy_size i32)
    ;; If old_ptr is NULL, just allocate
    (if (i32.eqz (local.get $old_ptr))
      (then
        (local.set $new_ptr (call $heap_alloc (local.get $new_size)))
        (if (i32.and (local.get $flags) (i32.const 0x40))
          (then (if (local.get $new_ptr)
            (then (call $zero_memory (call $g2w (local.get $new_ptr)) (local.get $new_size))))))
        (return (local.get $new_ptr))))
    ;; Read old block size from header at [ptr-4] (includes 4-byte header)
    (local.set $old_block_size (call $gl32 (i32.sub (local.get $old_ptr) (i32.const 4))))
    (local.set $old_data_size (i32.sub (local.get $old_block_size) (i32.const 4)))
    ;; If already big enough, return same pointer
    (if (i32.le_u (local.get $new_size) (local.get $old_data_size))
      (then (return (local.get $old_ptr))))
    ;; Allocate new block
    (local.set $new_ptr (call $heap_alloc (local.get $new_size)))
    (if (i32.eqz (local.get $new_ptr)) (then (return (i32.const 0))))
    ;; Copy old data
    (local.set $copy_size (local.get $old_data_size))
    (if (i32.gt_u (local.get $copy_size) (local.get $new_size))
      (then (local.set $copy_size (local.get $new_size))))
    (call $memcpy (call $g2w (local.get $new_ptr)) (call $g2w (local.get $old_ptr)) (local.get $copy_size))
    ;; Zero new portion if ZEROINIT flag set
    (if (i32.and (local.get $flags) (i32.const 0x40))
      (then (call $zero_memory
        (i32.add (call $g2w (local.get $new_ptr)) (local.get $copy_size))
        (i32.sub (local.get $new_size) (local.get $copy_size)))))
    ;; Free old block
    (call $heap_free (local.get $old_ptr))
    (local.get $new_ptr))

  ;; Active resource-lookup base/RVA. During a Load*/FindResource* handler call
  ;; targeting a DLL, $push_rsrc_ctx sets these to the DLL's load_addr + rsrc_rva.
  ;; Otherwise, they fall back to the main EXE's $image_base / $rsrc_rva.
  (func $r_base (result i32)
    (if (result i32) (global.get $rsrc_ctx_base)
      (then (global.get $rsrc_ctx_base))
      (else (global.get $image_base))))
  (func $r_rva (result i32)
    (if (result i32) (global.get $rsrc_ctx_base)
      (then (global.get $rsrc_ctx_rva))
      (else (global.get $rsrc_rva))))

  ;; Locate a loaded DLL by its HMODULE (load_addr). Returns dll_idx or -1.
  (func $find_dll_by_base (param $ha i32) (result i32)
    (local $i i32)
    (block $notfound (loop $l
      (br_if $notfound (i32.ge_u (local.get $i) (global.get $dll_count)))
      (if (i32.eq
            (i32.load (i32.add (global.get $DLL_TABLE) (i32.mul (local.get $i) (i32.const 32))))
            (local.get $ha))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (i32.const -1))

  ;; True when an address belongs to the image range of a loaded guest DLL.
  ;; Registered common-control wndprocs use this to distinguish a real DLL
  ;; class implementation from USER's EXE-range fallback guesses.
  (func $address_in_loaded_dll (param $addr i32) (result i32)
    (local $i i32) (local $rec i32) (local $base i32) (local $size i32)
    (block $no (loop $scan
      (br_if $no (i32.ge_u (local.get $i) (global.get $dll_count)))
      (local.set $rec (i32.add (global.get $DLL_TABLE)
        (i32.mul (local.get $i) (i32.const 32))))
      (local.set $base (i32.load (local.get $rec)))
      (local.set $size (i32.load offset=4 (local.get $rec)))
      (if (i32.and
            (i32.ge_u (local.get $addr) (local.get $base))
            (i32.lt_u (local.get $addr) (i32.add (local.get $base) (local.get $size))))
        (then (return (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; Switch the resource-lookup context to the given hInstance (HMODULE).
  ;; 0 or the main EXE's image_base → main EXE (ctx cleared, fallback applies).
  ;; A DLL's load_addr → that DLL's rsrc dir. Unknown hInstance → main EXE.
  ;; Not reentrant; Load*/FindResource* handlers must pair with $pop_rsrc_ctx.
  (func $push_rsrc_ctx (param $hInstance i32)
    (local $idx i32) (local $rva i32)
    (global.set $rsrc_ctx_base (i32.const 0))
    (global.set $rsrc_ctx_rva  (i32.const 0))
    (if (i32.eqz (local.get $hInstance)) (then (return)))
    (if (i32.eq (local.get $hInstance) (global.get $image_base)) (then (return)))
    (local.set $idx (call $find_dll_by_base (local.get $hInstance)))
    (if (i32.lt_s (local.get $idx) (i32.const 0)) (then (return)))
    (local.set $rva (i32.load (i32.add (global.get $DLL_RSRC_TABLE)
      (i32.mul (local.get $idx) (i32.const 8)))))
    (if (i32.eqz (local.get $rva)) (then (return)))
    (global.set $rsrc_ctx_base (local.get $hInstance))
    (global.set $rsrc_ctx_rva  (local.get $rva)))

  (func $pop_rsrc_ctx
    (global.set $rsrc_ctx_base (i32.const 0))
    (global.set $rsrc_ctx_rva  (i32.const 0)))

  ;; Find resource entry in PE resource directory
  ;; Returns offset of data entry (relative to image_base) or 0
  ;; Compare ASCII string at guest $str_ptr with Unicode resource name at rsrc offset $name_off
  ;; Resource name format: u16 length, then u16[] chars. Returns 1 if match (case-insensitive).
  (func $rsrc_name_match (param $str_ptr i32) (param $name_off i32) (result i32)
    (local $str_wa i32) (local $name_wa i32) (local $len i32) (local $j i32)
    (local $ch_a i32) (local $ch_r i32)
    (local.set $str_wa (call $g2w (local.get $str_ptr)))
    (local.set $name_wa (call $g2w (i32.add (call $r_base)
      (i32.add (call $r_rva) (local.get $name_off)))))
    (local.set $len (i32.load16_u (local.get $name_wa)))
    (local.set $j (i32.const 0))
    (block $done (loop $cmp
      (br_if $done (i32.ge_u (local.get $j) (local.get $len)))
      (local.set $ch_a (i32.load8_u (i32.add (local.get $str_wa) (local.get $j))))
      (if (i32.eqz (local.get $ch_a)) (then (return (i32.const 0)))) ;; ASCII shorter
      (local.set $ch_r (i32.load16_u (i32.add (local.get $name_wa)
        (i32.add (i32.const 2) (i32.mul (local.get $j) (i32.const 2))))))
      ;; Uppercase both for case-insensitive compare
      (if (i32.and (i32.ge_u (local.get $ch_a) (i32.const 0x61)) (i32.le_u (local.get $ch_a) (i32.const 0x7a)))
        (then (local.set $ch_a (i32.sub (local.get $ch_a) (i32.const 0x20)))))
      (if (i32.and (i32.ge_u (local.get $ch_r) (i32.const 0x61)) (i32.le_u (local.get $ch_r) (i32.const 0x7a)))
        (then (local.set $ch_r (i32.sub (local.get $ch_r) (i32.const 0x20)))))
      (if (i32.ne (local.get $ch_a) (local.get $ch_r)) (then (return (i32.const 0))))
      (local.set $j (i32.add (local.get $j) (i32.const 1)))
      (br $cmp)))
    ;; Matched all $len resource chars — ensure ASCII string ends here too
    (i32.eqz (i32.load8_u (i32.add (local.get $str_wa) (local.get $len)))))

  ;; Raw eid (name-level directory entry dword, with 0x80000000 set for
  ;; named entries) of the most-recent successful name-level $rsrc_find_entry
  ;; match. Used by $rsrc_match_eid to give dialog/menu lookups a stable
  ;; integer key regardless of whether the app used MAKEINTRESOURCE or a
  ;; string template name. Not thread-safe; callers must read immediately
  ;; after the lookup that produced it.
  (global $rsrc_matched_eid (mut i32) (i32.const 0))

  (func $rsrc_find_entry (param $dir_off i32) (param $id i32) (result i32)
    (local $named i32) (local $ids i32) (local $total i32)
    (local $e i32) (local $i i32) (local $eid i32) (local $doff i32)
    ;; dir_off = offset from image_base to resource directory
    ;; Read number of named + id entries
    (local.set $named (i32.load16_u (call $g2w (i32.add (call $r_base)
      (i32.add (local.get $dir_off) (i32.const 12))))))
    (local.set $ids (i32.load16_u (call $g2w (i32.add (call $r_base)
      (i32.add (local.get $dir_off) (i32.const 14))))))
    (local.set $total (i32.add (local.get $named) (local.get $ids)))
    (local.set $e (i32.add (local.get $dir_off) (i32.const 16)))
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (local.get $total)))
      (local.set $eid (call $gl32 (i32.add (call $r_base) (local.get $e))))
      (local.set $doff (call $gl32 (i32.add (call $r_base) (i32.add (local.get $e) (i32.const 4)))))
      ;; If id is a string pointer (>= 0x10000) and entry is named (high bit set), compare strings
      (if (i32.and (i32.ge_u (local.get $id) (i32.const 0x10000))
                   (i32.ne (i32.and (local.get $eid) (i32.const 0x80000000)) (i32.const 0)))
        (then
          (if (call $rsrc_name_match (local.get $id)
                (i32.and (local.get $eid) (i32.const 0x7FFFFFFF)))
            (then
              (global.set $rsrc_matched_eid (local.get $eid))
              (return (local.get $doff))))))
      ;; Integer ID match
      (if (i32.and (i32.lt_u (local.get $id) (i32.const 0x10000))
                   (i32.eq (local.get $eid) (local.get $id)))
        (then
          (global.set $rsrc_matched_eid (local.get $eid))
          (return (local.get $doff))))
      (local.set $e (i32.add (local.get $e) (i32.const 8)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (i32.const 0))

  ;; Resolve a resource template name (either MAKEINTRESOURCE integer or
  ;; a guest pointer to an ASCII string) to a stable integer key that
  ;; matches how the JS-side resource parser indexes RT_DIALOG / RT_MENU
  ;; entries: small integer for ID-based, raw directory eid (with high
  ;; bit set) for named entries. Returns 0 if the resource doesn't exist.
  ;; This is the WAT-side shim that lets CreateDialogParamA /
  ;; DialogBoxParamA accept string template names (e.g. freecell's
  ;; "STATISTICS" dialog) without the JS renderer needing to do string
  ;; lookup of its own.
  (func $rsrc_match_eid (param $type_id i32) (param $name_id i32) (result i32)
    (if (i32.eqz (call $find_resource (local.get $type_id) (local.get $name_id)))
      (then (return (i32.const 0))))
    (global.get $rsrc_matched_eid))

  ;; Choose which language of a resource to load, given the level-3 directory.
  ;; Returns the data-entry offset (relative to the resource directory), or 0.
  ;;
  ;; This used to take whichever entry came first, and a multilingual binary
  ;; does not put the one you want first: Win98's sndrec32.exe carries Arabic
  ;; alongside English, Arabic sorts lower, and its Properties sheet came up
  ;; with "EH'AB" and "%D:'! 'D#E1" on the buttons -- Arabic text read as
  ;; CP1252. The entries are sorted by language id, so preference has to be
  ;; expressed as a search rather than as an ordering.
  ;;
  ;; We present an en-US environment, so the order is: exact en-US, then
  ;; language-neutral, then any English sublanguage, then whatever is first.
  ;; That last fallback matters -- a single-language binary in any language is
  ;; still the resource the app expects.
  (func $rsrc_pick_language (param $lang_off i32) (result i32)
    (local $n i32) (local $i i32) (local $e i32) (local $id i32)
    (local $first i32) (local $neutral i32) (local $english i32)
    (local.set $n (i32.add
      (i32.load16_u (call $g2w (i32.add (call $r_base) (i32.add (local.get $lang_off) (i32.const 12)))))
      (i32.load16_u (call $g2w (i32.add (call $r_base) (i32.add (local.get $lang_off) (i32.const 14)))))))
    (if (i32.eqz (local.get $n)) (then (return (i32.const 0))))
    (local.set $e (i32.add (local.get $lang_off) (i32.const 16)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $id (call $gl32 (i32.add (call $r_base) (local.get $e))))
      ;; A level-3 entry id is a plain LANGID; nothing here is a named entry.
      (if (i32.eqz (local.get $first))
        (then (local.set $first (call $gl32
          (i32.add (call $r_base) (i32.add (local.get $e) (i32.const 4)))))))
      (if (i32.eq (local.get $id) (i32.const 0x0409))          ;; en-US, exact
        (then (return (call $gl32
          (i32.add (call $r_base) (i32.add (local.get $e) (i32.const 4)))))))
      (if (i32.eqz (local.get $id))                            ;; LANG_NEUTRAL
        (then (if (i32.eqz (local.get $neutral))
          (then (local.set $neutral (call $gl32
            (i32.add (call $r_base) (i32.add (local.get $e) (i32.const 4)))))))))
      (if (i32.eq (i32.and (local.get $id) (i32.const 0x3FF)) (i32.const 0x09)) ;; any English
        (then (if (i32.eqz (local.get $english))
          (then (local.set $english (call $gl32
            (i32.add (call $r_base) (i32.add (local.get $e) (i32.const 4)))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $e (i32.add (local.get $e) (i32.const 8)))
      (br $scan)))
    (if (local.get $neutral) (then (return (local.get $neutral))))
    (if (local.get $english) (then (return (local.get $english))))
    (local.get $first))

  ;; FindResourceA: walk type→name→lang, return data entry offset
  (func $find_resource (param $type_id i32) (param $name_id i32) (result i32)
    (local $d i32) (local $lang_off i32) (local $n i32)
    ;; Bail cleanly when the active module has no resource directory (e.g. a DLL
    ;; with no .rsrc section, or an hInstance that didn't match any DLL).
    (if (i32.eqz (call $r_rva)) (then (return (i32.const 0))))
    ;; Level 1: find type
    (local.set $d (call $rsrc_find_entry (call $r_rva) (local.get $type_id)))
    (if (i32.eqz (local.get $d)) (then (return (i32.const 0))))
    ;; Level 2: find name (d has high bit set if subdirectory)
    (local.set $d (call $rsrc_find_entry
      (i32.add (call $r_rva) (i32.and (local.get $d) (i32.const 0x7FFFFFFF)))
      (local.get $name_id)))
    (if (i32.eqz (local.get $d)) (then (return (i32.const 0))))
    ;; Level 3: pick a language.
    (local.set $lang_off (i32.add (call $r_rva) (i32.and (local.get $d) (i32.const 0x7FFFFFFF))))
    (local.set $d (call $rsrc_pick_language (local.get $lang_off)))
    (if (i32.eqz (local.get $d)) (then (return (i32.const 0))))
    ;; d is now the offset of the data entry (RVA, size, codepage, reserved) relative to rsrc start
    ;; Return as offset from image_base (rsrc_rva + d)
    (i32.add (call $r_rva) (local.get $d)))

  ;; Find a WAVE resource by name ID. Walks L1 looking for named type "WAVE",
  ;; then L2 by integer name_id, then takes first lang entry.
  ;; Returns offset from image_base to data entry, or 0.
  (func $find_resource_named_type (param $name_id i32) (result i32)
    (local $base_wa i32) (local $total i32) (local $e i32) (local $i i32)
    (local $eid i32) (local $doff i32) (local $str_wa i32) (local $str_len i32)
    (local $type_subdir i32) (local $d i32) (local $lang_off i32) (local $n i32)
    ;; L1: scan entries for named type "WAVE"
    (if (i32.eqz (call $r_rva)) (then (return (i32.const 0))))
    (local.set $base_wa (call $g2w (i32.add (call $r_base) (call $r_rva))))
    (local.set $total (i32.add
      (i32.load16_u (i32.add (local.get $base_wa) (i32.const 12)))
      (i32.load16_u (i32.add (local.get $base_wa) (i32.const 14)))))
    (local.set $e (i32.add (call $r_rva) (i32.const 16)))
    (block $found_type
    (block $not_found
    (loop $l1
      (br_if $not_found (i32.ge_u (local.get $i) (local.get $total)))
      (local.set $eid (call $gl32 (i32.add (call $r_base) (local.get $e))))
      (local.set $doff (call $gl32 (i32.add (call $r_base) (i32.add (local.get $e) (i32.const 4)))))
      ;; Check if named entry (high bit set)
      (if (i32.and (local.get $eid) (i32.const 0x80000000))
        (then
          ;; String offset from rsrc start
          (local.set $str_wa (call $g2w (i32.add (call $r_base)
            (i32.add (call $r_rva) (i32.and (local.get $eid) (i32.const 0x7FFFFFFF))))))
          (local.set $str_len (i32.load16_u (local.get $str_wa)))
          ;; Check if "WAVE" (4 chars: W=0x57, A=0x41, V=0x56, E=0x45)
          (if (i32.and
                (i32.eq (local.get $str_len) (i32.const 4))
                (i32.and
                  (i32.eq (i32.load16_u (i32.add (local.get $str_wa) (i32.const 2))) (i32.const 0x57))
                  (i32.and
                    (i32.eq (i32.load16_u (i32.add (local.get $str_wa) (i32.const 4))) (i32.const 0x41))
                    (i32.and
                      (i32.eq (i32.load16_u (i32.add (local.get $str_wa) (i32.const 6))) (i32.const 0x56))
                      (i32.eq (i32.load16_u (i32.add (local.get $str_wa) (i32.const 8))) (i32.const 0x45))))))
            (then
              (local.set $type_subdir (local.get $doff))
              (br $found_type)))))
      (local.set $e (i32.add (local.get $e) (i32.const 8)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l1))
    ) ;; $not_found
    (return (i32.const 0))
    ) ;; $found_type
    ;; L2: find name by integer ID in the type subdirectory
    (local.set $d (call $rsrc_find_entry
      (i32.add (call $r_rva) (i32.and (local.get $type_subdir) (i32.const 0x7FFFFFFF)))
      (local.get $name_id)))
    (if (i32.eqz (local.get $d)) (then (return (i32.const 0))))
    ;; L3: take first language entry
    (local.set $lang_off (i32.add (call $r_rva) (i32.and (local.get $d) (i32.const 0x7FFFFFFF))))
    (local.set $n (i32.add
      (i32.load16_u (call $g2w (i32.add (call $r_base) (i32.add (local.get $lang_off) (i32.const 12)))))
      (i32.load16_u (call $g2w (i32.add (call $r_base) (i32.add (local.get $lang_off) (i32.const 14)))))))
    (if (i32.eqz (local.get $n)) (then (return (i32.const 0))))
    (local.set $d (call $gl32 (i32.add (call $r_base) (i32.add (local.get $lang_off) (i32.const 20)))))
    (i32.add (call $r_rva) (local.get $d)))

  ;; Optional extra args appended after the exe name. JS sets these via
  ;; (export "set_extra_cmdline") before the first GetCommandLineA call.
  ;; Buffer lives in low scratch memory at 0x300 (256 bytes), separate from
  ;; the exe_name buffer at $exe_name_wa.
  (global $extra_cmdline_len (mut i32) (i32.const 0))
  (func (export "set_extra_cmdline") (param $waddr i32) (param $len i32)
    (local $i i32)
    (if (i32.gt_u (local.get $len) (i32.const 200))
      (then (local.set $len (i32.const 200))))
    (global.set $extra_cmdline_len (local.get $len))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (i32.store8 (i32.add (i32.const 0x300) (local.get $i))
        (i32.load8_u (i32.add (local.get $waddr) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy))))

  (func $store_fake_cmdline
    (local $ptr i32) (local $dst i32) (local $i i32) (local $len i32) (local $extra i32)
    (local.set $ptr (call $heap_alloc (i32.const 512)))
    (global.set $fake_cmdline_addr (local.get $ptr))
    ;; Write "C:\<exe_name>" — full path matching GetModuleFileNameA
    (local.set $dst (call $g2w (local.get $ptr)))
    (i32.store8 (local.get $dst) (i32.const 0x43))  ;; 'C'
    (i32.store8 (i32.add (local.get $dst) (i32.const 1)) (i32.const 0x3A))  ;; ':'
    (i32.store8 (i32.add (local.get $dst) (i32.const 2)) (i32.const 0x5C))  ;; '\'
    (local.set $len (global.get $exe_name_len))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (i32.store8 (i32.add (local.get $dst) (i32.add (local.get $i) (i32.const 3)))
        (i32.load8_u (i32.add (global.get $exe_name_wa) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (local.set $len (i32.add (local.get $len) (i32.const 3)))
    ;; If extra args were set via $set_extra_cmdline, append " <args>".
    (local.set $extra (global.get $extra_cmdline_len))
    (if (i32.gt_u (local.get $extra) (i32.const 0))
      (then
        (i32.store8 (i32.add (local.get $dst) (local.get $len)) (i32.const 0x20)) ;; ' '
        (local.set $len (i32.add (local.get $len) (i32.const 1)))
        (local.set $i (i32.const 0))
        (block $done2 (loop $copy2
          (br_if $done2 (i32.ge_u (local.get $i) (local.get $extra)))
          (i32.store8 (i32.add (local.get $dst) (i32.add (local.get $len) (local.get $i)))
            (i32.load8_u (i32.add (i32.const 0x300) (local.get $i))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $copy2)))
        (local.set $len (i32.add (local.get $len) (local.get $extra)))))
    (i32.store8 (i32.add (local.get $dst) (local.get $len)) (i32.const 0)))

  (func $store_fake_wcmdline
    (local $ptr i32) (local $i i32) (local $len i32) (local $extra i32)
    (local.set $ptr (call $heap_alloc (i32.const 1024)))
    (global.set $msvcrt_wcmdln_ptr (local.get $ptr))
    ;; Write L"C:\<exe_name>" and mirror set_extra_cmdline as UTF-16.
    (call $gs16 (local.get $ptr) (i32.const 0x43))  ;; 'C'
    (call $gs16 (i32.add (local.get $ptr) (i32.const 2)) (i32.const 0x3A))  ;; ':'
    (call $gs16 (i32.add (local.get $ptr) (i32.const 4)) (i32.const 0x5C))  ;; '\'
    (local.set $len (global.get $exe_name_len))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (call $gs16
        (i32.add (local.get $ptr) (i32.shl (i32.add (local.get $i) (i32.const 3)) (i32.const 1)))
        (i32.load8_u (i32.add (global.get $exe_name_wa) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (local.set $len (i32.add (local.get $len) (i32.const 3)))
    (local.set $extra (global.get $extra_cmdline_len))
    (if (i32.gt_u (local.get $extra) (i32.const 0))
      (then
        (call $gs16 (i32.add (local.get $ptr) (i32.shl (local.get $len) (i32.const 1))) (i32.const 0x20))
        (local.set $len (i32.add (local.get $len) (i32.const 1)))
        (local.set $i (i32.const 0))
        (block $done2 (loop $copy2
          (br_if $done2 (i32.ge_u (local.get $i) (local.get $extra)))
          (call $gs16
            (i32.add (local.get $ptr) (i32.shl (i32.add (local.get $len) (local.get $i)) (i32.const 1)))
            (i32.load8_u (i32.add (i32.const 0x300) (local.get $i))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $copy2)))
        (local.set $len (i32.add (local.get $len) (local.get $extra)))))
    (call $gs16 (i32.add (local.get $ptr) (i32.shl (local.get $len) (i32.const 1))) (i32.const 0))
    ;; Scratch records used by __p__wcmdln and __wgetmainargs.
    (call $gs32 (i32.add (local.get $ptr) (i32.const 768)) (local.get $ptr))
    (call $gs32 (i32.add (local.get $ptr) (i32.const 776)) (local.get $ptr))
    (call $gs32 (i32.add (local.get $ptr) (i32.const 780)) (i32.const 0))
    (call $gs32 (i32.add (local.get $ptr) (i32.const 784)) (i32.const 0)))
  (func $guest_strlen (param $gp i32) (result i32)
    (local $len i32)
    (block $d (loop $l
      (br_if $d (i32.eqz (call $gl8 (i32.add (local.get $gp) (local.get $len)))))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (br_if $d (i32.ge_u (local.get $len) (i32.const 65536))) (br $l)))
    (local.get $len))
  (func $guest_strcpy (param $dst i32) (param $src i32)
    (local $i i32) (local $ch i32)
    (block $d (loop $l
      (local.set $ch (call $gl8 (i32.add (local.get $src) (local.get $i))))
      (call $gs8 (i32.add (local.get $dst) (local.get $i)) (local.get $ch))
      (br_if $d (i32.eqz (local.get $ch)))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l))))
  (func $guest_strncpy (param $dst i32) (param $src i32) (param $max i32)
    (local $i i32) (local $ch i32)
    (if (i32.le_s (local.get $max) (i32.const 0)) (then (return)))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.sub (local.get $max) (i32.const 1))))
      (local.set $ch (call $gl8 (i32.add (local.get $src) (local.get $i))))
      (call $gs8 (i32.add (local.get $dst) (local.get $i)) (local.get $ch))
      (br_if $d (i32.eqz (local.get $ch)))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    ;; Null-terminate
    (call $gs8 (i32.add (local.get $dst) (local.get $i)) (i32.const 0)))

  ;; Wide string helpers (UTF-16LE, 2 bytes per char)
  (func $guest_wcslen (param $gp i32) (result i32)
    (local $len i32)
    (block $d (loop $l
      (br_if $d (i32.eqz (call $gl16 (i32.add (local.get $gp) (i32.shl (local.get $len) (i32.const 1))))))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (br_if $d (i32.ge_u (local.get $len) (i32.const 32768))) (br $l)))
    (local.get $len))

  (func $guest_wcscpy (param $dst i32) (param $src i32)
    (local $i i32) (local $ch i32)
    (block $d (loop $l
      (local.set $ch (call $gl16 (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 1)))))
      (call $gs16 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 1))) (local.get $ch))
      (br_if $d (i32.eqz (local.get $ch)))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l))))

  (func $guest_wcsncpy (param $dst i32) (param $src i32) (param $max i32)
    (local $i i32) (local $ch i32)
    ;; lstrcpynW copies up to max-1 chars, NUL-terminates
    (if (i32.le_s (local.get $max) (i32.const 0)) (then (return)))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.sub (local.get $max) (i32.const 1))))
      (local.set $ch (call $gl16 (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 1)))))
      (call $gs16 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 1))) (local.get $ch))
      (br_if $d (i32.eqz (local.get $ch)))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (call $gs16 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 1))) (i32.const 0)))

  ;; Convert wide string at guest src to ANSI at guest dst, max bytes. Returns length.
  (func $wide_to_ansi (param $src i32) (param $dst i32) (param $max i32) (result i32)
    (local $i i32) (local $ch i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.sub (local.get $max) (i32.const 1))))
      (local.set $ch (call $gl16 (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 1)))))
      (br_if $d (i32.eqz (local.get $ch)))
      (call $gs8 (i32.add (local.get $dst) (local.get $i)) (i32.and (local.get $ch) (i32.const 0xFF)))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (call $gs8 (i32.add (local.get $dst) (local.get $i)) (i32.const 0))
    (local.get $i))

  ;; Convert ANSI string at guest src to wide string at guest dst, max wchars. Returns length.
  (func $ansi_to_wide (param $src i32) (param $dst i32) (param $max i32) (result i32)
    (local $i i32) (local $ch i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.sub (local.get $max) (i32.const 1))))
      (local.set $ch (call $gl8 (i32.add (local.get $src) (local.get $i))))
      (br_if $d (i32.eqz (local.get $ch)))
      (call $gs16 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 1))) (local.get $ch))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (call $gs16 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 1))) (i32.const 0))
    (local.get $i))

  (func $crash_unimplemented (param $name_ptr i32)
    (call $host_crash_unimplemented (local.get $name_ptr) (global.get $esp) (global.get $eip) (global.get $ebp))
    (unreachable))

  ;; Find DLL by name (WASM ptr to ASCII name), return guest load_addr or 0
  (func $find_dll_by_name (param $name_wa i32) (result i32)
    (local $i i32) (local $tbl_ptr i32) (local $la i32) (local $exp_rva i32)
    (local $exp_name_rva i32) (local $exp_name_wa i32)
    (local.set $i (i32.const 0))
    (block $notfound (loop $search
      (br_if $notfound (i32.ge_u (local.get $i) (global.get $dll_count)))
      (local.set $tbl_ptr (i32.add (global.get $DLL_TABLE) (i32.mul (local.get $i) (i32.const 32))))
      (local.set $la (i32.load (local.get $tbl_ptr)))
      (local.set $exp_rva (i32.load (i32.add (local.get $tbl_ptr) (i32.const 8))))
      (if (i32.ne (local.get $exp_rva) (i32.const 0))
        (then
          (local.set $exp_name_rva (i32.load (i32.add (call $g2w (i32.add (local.get $la) (local.get $exp_rva))) (i32.const 12))))
          (local.set $exp_name_wa (call $g2w (i32.add (local.get $la) (local.get $exp_name_rva))))
          (if (call $dll_name_match (local.get $name_wa) (local.get $exp_name_wa))
            (then (return (local.get $la))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $search)))
    (i32.const 0))

  ;; ASCII tolower: if A-Z, add 0x20
  (func $tolower (param $c i32) (result i32)
    (if (result i32) (i32.and (i32.ge_u (local.get $c) (i32.const 0x41)) (i32.le_u (local.get $c) (i32.const 0x5A)))
      (then (i32.add (local.get $c) (i32.const 0x20)))
      (else (local.get $c))))

  ;; Code page helpers. Default ANSI is CP1252, but tests/hosts can switch to
  ;; common DBCS pages so MBCS navigation skips trail bytes correctly.
  (func $resolve_code_page (param $cp i32) (result i32)
    ;; CP_ACP=0 and CP_THREAD_ACP=3 track the process ANSI page here.
    (if (i32.or (i32.eqz (local.get $cp)) (i32.eq (local.get $cp) (i32.const 3)))
      (then (return (global.get $ansi_code_page))))
    ;; CP_OEMCP=1 follows the console output page in this emulator.
    (if (i32.eq (local.get $cp) (i32.const 1))
      (then (return (global.get $console_output_cp))))
    (local.get $cp))

  (func $is_supported_code_page (param $cp i32) (result i32)
    (local.set $cp (call $resolve_code_page (local.get $cp)))
    (if (i32.eq (local.get $cp) (i32.const 1252)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $cp) (i32.const 437)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $cp) (i32.const 932)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $cp) (i32.const 936)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $cp) (i32.const 949)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $cp) (i32.const 950)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $cp) (i32.const 1361)) (then (return (i32.const 1))))
    (i32.const 0))

  (func $is_dbcs_code_page (param $cp i32) (result i32)
    (local.set $cp (call $resolve_code_page (local.get $cp)))
    (if (i32.eq (local.get $cp) (i32.const 932)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $cp) (i32.const 936)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $cp) (i32.const 949)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $cp) (i32.const 950)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $cp) (i32.const 1361)) (then (return (i32.const 1))))
    (i32.const 0))

  (func $is_dbcs_lead_byte_for_cp (param $cp i32) (param $ch i32) (result i32)
    (local.set $cp (call $resolve_code_page (local.get $cp)))
    (local.set $ch (i32.and (local.get $ch) (i32.const 0xFF)))
    ;; CP932 (Shift-JIS): 0x81-0x9F, 0xE0-0xFC.
    (if (i32.eq (local.get $cp) (i32.const 932))
      (then
        (return
          (i32.or
            (i32.and (i32.ge_u (local.get $ch) (i32.const 0x81))
                     (i32.le_u (local.get $ch) (i32.const 0x9F)))
            (i32.and (i32.ge_u (local.get $ch) (i32.const 0xE0))
                     (i32.le_u (local.get $ch) (i32.const 0xFC)))))))
    ;; CP936/949/950: 0x81-0xFE.
    (if (i32.or
          (i32.or (i32.eq (local.get $cp) (i32.const 936))
                  (i32.eq (local.get $cp) (i32.const 949)))
          (i32.eq (local.get $cp) (i32.const 950)))
      (then
        (return
          (i32.and (i32.ge_u (local.get $ch) (i32.const 0x81))
                   (i32.le_u (local.get $ch) (i32.const 0xFE))))))
    ;; CP1361 (Johab): documented lead ranges used by Windows.
    (if (i32.eq (local.get $cp) (i32.const 1361))
      (then
        (return
          (i32.or
            (i32.or
              (i32.and (i32.ge_u (local.get $ch) (i32.const 0x84))
                       (i32.le_u (local.get $ch) (i32.const 0xD3)))
              (i32.and (i32.ge_u (local.get $ch) (i32.const 0xD8))
                       (i32.le_u (local.get $ch) (i32.const 0xDE))))
            (i32.and (i32.ge_u (local.get $ch) (i32.const 0xE0))
                     (i32.le_u (local.get $ch) (i32.const 0xF9)))))))
    (i32.const 0))

  (func $is_dbcs_lead_byte (param $ch i32) (result i32)
    (call $is_dbcs_lead_byte_for_cp (global.get $ansi_code_page) (local.get $ch)))

  (func $mbsinc_ptr (param $gp i32) (result i32)
    (local $wa i32) (local $ch i32)
    (if (i32.eqz (local.get $gp)) (then (return (i32.const 0))))
    (local.set $wa (call $g2w (local.get $gp)))
    (local.set $ch (i32.load8_u (local.get $wa)))
    (i32.add (local.get $gp)
      (select
        (i32.const 2)
        (i32.const 1)
        (i32.and
          (call $is_dbcs_lead_byte (local.get $ch))
          (i32.ne (i32.load8_u (i32.add (local.get $wa) (i32.const 1))) (i32.const 0))))))

  ;; Wide case-insensitive compare
  (func $guest_wcsicmp (param $s1 i32) (param $s2 i32) (result i32)
    (local $i i32) (local $a i32) (local $b i32)
    (block $d (loop $l
      (local.set $a (call $tolower (call $gl16 (i32.add (local.get $s1) (i32.shl (local.get $i) (i32.const 1))))))
      (local.set $b (call $tolower (call $gl16 (i32.add (local.get $s2) (i32.shl (local.get $i) (i32.const 1))))))
      (if (i32.ne (local.get $a) (local.get $b))
        (then (return (i32.sub (local.get $a) (local.get $b)))))
      (br_if $d (i32.eqz (local.get $a)))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (i32.const 0))

  ;; Compare a UTF-16LE string at WASM addr $wide_wa with a NUL-terminated
  ;; ASCII string at WASM addr $ascii_wa, case-insensitive.
  (func $wide_ascii_eq (param $wide_wa i32) (param $ascii_wa i32) (result i32)
    (local $i i32) (local $a i32) (local $b i32)
    (block $no (loop $scan
      (local.set $a (call $tolower
        (i32.load16_u (i32.add (local.get $wide_wa)
          (i32.shl (local.get $i) (i32.const 1))))))
      (local.set $b (call $tolower
        (i32.load8_u (i32.add (local.get $ascii_wa) (local.get $i)))))
      (br_if $no (i32.ne (local.get $a) (local.get $b)))
      (if (i32.eqz (local.get $a)) (then (return (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; Prefix variant for common controls whose template class names can carry
  ;; suffixes/aliases while still selecting the same native class family.
  (func $wide_ascii_prefix_eq (param $wide_wa i32) (param $ascii_wa i32) (result i32)
    (local $i i32) (local $a i32) (local $b i32)
    (block $no (loop $scan
      (local.set $b (call $tolower
        (i32.load8_u (i32.add (local.get $ascii_wa) (local.get $i)))))
      (if (i32.eqz (local.get $b)) (then (return (i32.const 1))))
      (local.set $a (call $tolower
        (i32.load16_u (i32.add (local.get $wide_wa)
          (i32.shl (local.get $i) (i32.const 1))))))
      (br_if $no (i32.ne (local.get $a) (local.get $b)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; DLL name compare: compare guest ANSI string at $name_ptr with WASM string at $cmp_ptr (case-insensitive)
  (func $dll_name_match (param $name_ptr i32) (param $cmp_ptr i32) (result i32)
    (local $a i32) (local $b i32) (local $i i32) (local $scan i32) (local $start i32)
    ;; LoadLibrary often receives a path ("C:\Plugins\foo.dll"), while PE
    ;; export-directory names are bare filenames. Match on the basename.
    (block $base_done (loop $base
      (local.set $a (call $gl8 (i32.add (local.get $name_ptr) (local.get $scan))))
      (br_if $base_done (i32.eqz (local.get $a)))
      (if (i32.or
            (i32.or (i32.eq (local.get $a) (i32.const 92))  ;; '\'
                    (i32.eq (local.get $a) (i32.const 47))) ;; '/'
            (i32.eq (local.get $a) (i32.const 58)))         ;; ':'
        (then (local.set $start (i32.add (local.get $scan) (i32.const 1)))))
      (local.set $scan (i32.add (local.get $scan) (i32.const 1)))
      (br $base)))
    (block $no (loop $l
      (local.set $a (call $tolower (call $gl8
        (i32.add (local.get $name_ptr) (i32.add (local.get $start) (local.get $i))))))
      (local.set $b (call $tolower (i32.load8_u (i32.add (local.get $cmp_ptr) (local.get $i)))))
      (br_if $no (i32.ne (local.get $a) (local.get $b)))
      (if (i32.eqz (local.get $a)) (then (return (i32.const 1)))) ;; both null = match
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (i32.const 0))

  (func $guest_strcmp (param $s1 i32) (param $s2 i32) (result i32)
    (local $i i32) (local $a i32) (local $b i32)
    (block $d (loop $l
      (local.set $a (call $gl8 (i32.add (local.get $s1) (local.get $i))))
      (local.set $b (call $gl8 (i32.add (local.get $s2) (local.get $i))))
      (if (i32.ne (local.get $a) (local.get $b))
        (then (return (i32.sub (local.get $a) (local.get $b)))))
      (br_if $d (i32.eqz (local.get $a)))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (i32.const 0))

  (func $guest_stricmp (param $s1 i32) (param $s2 i32) (result i32)
    (local $i i32) (local $a i32) (local $b i32)
    (block $d (loop $l
      (local.set $a (call $tolower (call $gl8 (i32.add (local.get $s1) (local.get $i)))))
      (local.set $b (call $tolower (call $gl8 (i32.add (local.get $s2) (local.get $i)))))
      (if (i32.ne (local.get $a) (local.get $b))
        (then (return (i32.sub (local.get $a) (local.get $b)))))
      (br_if $d (i32.eqz (local.get $a))) ;; both null → equal
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (i32.const 0))

  ;; FlatSB entry points are optional comctl32 helpers. The loaded Win9x
  ;; comctl32 implementation expects native subclass state we do not model, so
  ;; callers should take their existing USER32 scrollbar fallback path.
  (func $guest_name_contains_flatsb (param $name_ptr i32) (result i32)
    (local $i i32) (local $c i32)
    (block $done (loop $scan
      (local.set $c (call $gl8 (i32.add (local.get $name_ptr) (local.get $i))))
      (br_if $done (i32.eqz (local.get $c)))
      (if (i32.and
            (i32.and
              (i32.and
                (i32.eq (call $tolower (local.get $c)) (i32.const 0x66)) ;; f
                (i32.eq (call $tolower
                  (call $gl8 (i32.add (local.get $name_ptr) (i32.add (local.get $i) (i32.const 1)))))
                  (i32.const 0x6c))) ;; l
              (i32.and
                (i32.eq (call $tolower
                  (call $gl8 (i32.add (local.get $name_ptr) (i32.add (local.get $i) (i32.const 2)))))
                  (i32.const 0x61)) ;; a
                (i32.eq (call $tolower
                  (call $gl8 (i32.add (local.get $name_ptr) (i32.add (local.get $i) (i32.const 3)))))
                  (i32.const 0x74)))) ;; t
            (i32.and
              (i32.eq (call $tolower
                (call $gl8 (i32.add (local.get $name_ptr) (i32.add (local.get $i) (i32.const 4)))))
                (i32.const 0x73)) ;; s
              (i32.eq (call $tolower
                (call $gl8 (i32.add (local.get $name_ptr) (i32.add (local.get $i) (i32.const 5)))))
                (i32.const 0x62)))) ;; b
        (then (return (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  (func $update_rect_addr_for_slot (param $slot i32) (result i32)
    (i32.add (global.get $UPDATE_RECT) (i32.mul (local.get $slot) (i32.const 16))))

  (func $update_flag_addr_for_slot (param $slot i32) (result i32)
    (i32.add (global.get $UPDATE_FLAGS) (local.get $slot)))

  (func $update_rect_is_empty_slot (param $slot i32) (result i32)
    (local $p i32)
    (local.set $p (call $update_rect_addr_for_slot (local.get $slot)))
    (i32.or
      (i32.le_s (i32.load offset=8 (local.get $p)) (i32.load (local.get $p)))
      (i32.le_s (i32.load offset=12 (local.get $p)) (i32.load offset=4 (local.get $p)))))

  (func $update_clear_hwnd (param $hwnd i32)
    (local $slot i32) (local $p i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $slot) (i32.const -1)) (then (return)))
    (local.set $p (call $update_rect_addr_for_slot (local.get $slot)))
    (i64.store (local.get $p) (i64.const 0))
    (i64.store offset=8 (local.get $p) (i64.const 0))
    (i32.store8 (call $update_flag_addr_for_slot (local.get $slot)) (i32.const 0)))

  (func $update_invalidate_rect (param $hwnd i32) (param $l i32) (param $t i32) (param $r i32) (param $b i32)
    (local $slot i32) (local $p i32)
    (if (i32.or
          (i32.eqz (local.get $hwnd))
          (i32.or (i32.le_s (local.get $r) (local.get $l))
                  (i32.le_s (local.get $b) (local.get $t))))
      (then (return)))
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $slot) (i32.const -1)) (then (return)))
    (local.set $p (call $update_rect_addr_for_slot (local.get $slot)))
    (if (i32.eqz (i32.load8_u (call $update_flag_addr_for_slot (local.get $slot))))
      (then
        (i32.store (local.get $p) (local.get $l))
        (i32.store offset=4 (local.get $p) (local.get $t))
        (i32.store offset=8 (local.get $p) (local.get $r))
        (i32.store offset=12 (local.get $p) (local.get $b)))
      (else
        (if (i32.lt_s (local.get $l) (i32.load (local.get $p)))
          (then (i32.store (local.get $p) (local.get $l))))
        (if (i32.lt_s (local.get $t) (i32.load offset=4 (local.get $p)))
          (then (i32.store offset=4 (local.get $p) (local.get $t))))
        (if (i32.gt_s (local.get $r) (i32.load offset=8 (local.get $p)))
          (then (i32.store offset=8 (local.get $p) (local.get $r))))
        (if (i32.gt_s (local.get $b) (i32.load offset=12 (local.get $p)))
          (then (i32.store offset=12 (local.get $p) (local.get $b))))))
    (i32.store8 (call $update_flag_addr_for_slot (local.get $slot)) (i32.const 1)))

  ;; Client size for the paint paths: the recorded client rect when there is
  ;; one, and only then the host. Same reasoning as $client_rect_wh_packed —
  ;; get_window_client_size answers by calling back into this module — but these
  ;; callers need a usable size rather than "0 = not recorded", so the fallback
  ;; lives here instead of at each site.
  (func $wnd_client_size_or_host (param $hwnd i32) (result i32)
    (local $wh i32)
    (local.set $wh (call $client_rect_wh_packed (local.get $hwnd)))
    (if (local.get $wh) (then (return (local.get $wh))))
    (call $host_get_window_client_size (local.get $hwnd)))

  (func $update_invalidate_full (param $hwnd i32)
    (local $cs i32) (local $wh i32) (local $w i32) (local $h i32)
    (if (i32.eqz (local.get $hwnd)) (then (return)))
    (local.set $cs (call $wnd_client_size_or_host (local.get $hwnd)))
    (local.set $w (i32.and (local.get $cs) (i32.const 0xFFFF)))
    (local.set $h (i32.shr_u (local.get $cs) (i32.const 16)))
    (if (i32.or (i32.eqz (local.get $w)) (i32.eqz (local.get $h)))
      (then
        (local.set $wh (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $wh) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $wh) (i32.const 16)))))
    (if (i32.or (i32.eqz (local.get $w)) (i32.eqz (local.get $h)))
      (then
        (local.set $w (i32.const 32767))
        (local.set $h (i32.const 32767))))
    (call $update_invalidate_rect (local.get $hwnd) (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)))

  (func $update_get_rect (param $hwnd i32) (param $dst i32) (result i32)
    (local $slot i32) (local $p i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $slot) (i32.const -1)) (then (return (i32.const 0))))
    (if (i32.eqz (i32.load8_u (call $update_flag_addr_for_slot (local.get $slot))))
      (then (return (i32.const 0))))
    (local.set $p (call $update_rect_addr_for_slot (local.get $slot)))
    (if (call $update_rect_is_empty_slot (local.get $slot))
      (then
        (call $update_clear_hwnd (local.get $hwnd))
        (return (i32.const 0))))
    (if (local.get $dst)
      (then
        (i32.store (local.get $dst) (i32.load (local.get $p)))
        (i32.store offset=4 (local.get $dst) (i32.load offset=4 (local.get $p)))
        (i32.store offset=8 (local.get $dst) (i32.load offset=8 (local.get $p)))
        (i32.store offset=12 (local.get $dst) (i32.load offset=12 (local.get $p)))))
    (i32.const 1))

  ;; Bounding-rect approximation of ValidateRect. Full validation clears the
  ;; WAT update state; partial validation only shrinks simple edge strips.
  (func $update_validate_rect (param $hwnd i32) (param $l i32) (param $t i32) (param $r i32) (param $b i32) (result i32)
    (local $slot i32) (local $p i32) (local $ul i32) (local $ut i32) (local $ur i32) (local $ub i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $slot) (i32.const -1)) (then (return (i32.const 1))))
    (if (i32.eqz (i32.load8_u (call $update_flag_addr_for_slot (local.get $slot))))
      (then (return (i32.const 1))))
    (local.set $p (call $update_rect_addr_for_slot (local.get $slot)))
    (local.set $ul (i32.load (local.get $p)))
    (local.set $ut (i32.load offset=4 (local.get $p)))
    (local.set $ur (i32.load offset=8 (local.get $p)))
    (local.set $ub (i32.load offset=12 (local.get $p)))
    (if (i32.and
          (i32.and (i32.le_s (local.get $l) (local.get $ul))
                   (i32.le_s (local.get $t) (local.get $ut)))
          (i32.and (i32.ge_s (local.get $r) (local.get $ur))
                   (i32.ge_s (local.get $b) (local.get $ub))))
      (then
        (call $update_clear_hwnd (local.get $hwnd))
        (return (i32.const 1))))
    (if (i32.and (i32.le_s (local.get $l) (local.get $ul))
                 (i32.and (i32.ge_s (local.get $r) (local.get $ur))
                          (i32.le_s (local.get $t) (local.get $ut))))
      (then
        (if (i32.gt_s (local.get $b) (local.get $ut))
          (then (i32.store offset=4 (local.get $p) (local.get $b))))))
    (if (call $update_rect_is_empty_slot (local.get $slot))
      (then (call $update_clear_hwnd (local.get $hwnd))))
    (select (i32.const 0) (i32.const 1)
      (i32.load8_u (call $update_flag_addr_for_slot (local.get $slot)))))

  ;; $invalidate_hwnd(hwnd): mark $hwnd dirty so a WM_PAINT gets delivered on
  ;; the next GetMessageA cycle. For the main top-level, GetMessageA reads
  ;; $paint_pending directly; for child controls we set the slot's PAINT_FLAGS
  ;; byte so GetMessageA's child-paint phase picks it up. Call $host_invalidate
  ;; too so the
  ;; JS-side renderer schedules a repaint composite. This mirrors what
  ;; $handle_InvalidateRect does, but as a helper for WAT-internal paint
  ;; triggers (WM_CHAR, button clicks, etc.) that don't go through the
  ;; Win32 InvalidateRect API.
  (func $invalidate_hwnd (param $hwnd i32)
    (if (i32.eqz (local.get $hwnd)) (then (return)))
    (if (i32.eq (local.get $hwnd) (global.get $main_hwnd))
      (then (global.set $paint_pending (i32.const 1)))
      (else (call $paint_flag_set (local.get $hwnd))))
    (call $update_invalidate_full (local.get $hwnd))
    (call $host_invalidate (local.get $hwnd)))

  ;; $wnd_uncover_parent(hwnd): the window is about to stop being visible —
  ;; hidden or destroyed — so hand the area it occupied back to its parent.
  ;; On Win98 a child owns a visible region carved out of its parent's, and
  ;; taking the child away turns that region into invalid area on the parent,
  ;; which erases and repaints it. We keep one back-canvas per top-level, so
  ;; a departing child's pixels are simply left on the parent's surface with
  ;; nothing that would ever overwrite them. Ask the parent for an erase and
  ;; a paint instead; the erase re-invalidates the surviving subtree.
  ;; NSIS's wizard swaps pages by destroying the old page dialog, and without
  ;; this the license text and the options checkboxes stayed on screen
  ;; underneath the Installing Files page.
  (func $wnd_uncover_parent (param $hwnd i32)
    (local $parent i32)
    (if (i32.eqz (local.get $hwnd)) (then (return)))
    (if (i32.eqz (call $wnd_is_effectively_visible (local.get $hwnd))) (then (return)))
    (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
    (if (i32.eqz (local.get $parent)) (then (return)))
    (if (i32.eq (call $wnd_table_find (local.get $parent)) (i32.const -1)) (then (return)))
    (call $nc_flags_set (local.get $parent) (i32.const 2))
    (call $invalidate_hwnd (local.get $parent)))

  ;; Paint flags table — 1 byte per WND slot at $PAINT_FLAGS. This mirrors
  ;; how real Win32 tracks paint state: a per-window pending bit, not a
  ;; central queue. No fixed capacity to overflow; CreateDialogParamA can
  ;; mark hundreds of children dirty without losing any.

  ;; $paint_flag_set(hwnd): mark slot dirty.
  (func $paint_flag_set (param $hwnd i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return)))
    (i32.store8 (i32.add (global.get $PAINT_FLAGS) (local.get $idx)) (i32.const 1)))

  ;; $paint_flag_set_inv(hwnd): mark slot dirty AND seed update rgn so the
  ;; WAT-owned region-driven WM_PAINT pump sees this hwnd. Use
  ;; this for WAT-internal paint triggers that don't go through Win32
  ;; InvalidateRect; using $paint_flag_set alone leaves the rgn empty and the
  ;; region pump silently drops the paint.
  (func $paint_flag_set_inv (param $hwnd i32)
    (if (i32.eqz (local.get $hwnd)) (then (return)))
    (call $paint_flag_set (local.get $hwnd))
    (call $update_invalidate_full (local.get $hwnd))
    (call $host_invalidate (local.get $hwnd)))

  ;; $paint_flag_clear_hwnd(hwnd): clear the slot bit for hwnd if any.
  (func $paint_flag_clear_hwnd (param $hwnd i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return)))
    (i32.store8 (i32.add (global.get $PAINT_FLAGS) (local.get $idx)) (i32.const 0)))

  ;; A Win32 child is effectively visible only when it and every ancestor
  ;; carry WS_VISIBLE. Hidden dialog pages keep child WS_VISIBLE bits, but
  ;; USER's visible-region walk still suppresses their paint and hit testing.
  (func $wnd_is_effectively_visible (param $hwnd i32) (result i32)
    (local $cur i32) (local $style i32)
    (local.set $cur (local.get $hwnd))
    (block $done (loop $walk
      (if (i32.eqz (local.get $cur)) (then (return (i32.const 1))))
      (local.set $style (call $wnd_get_style (local.get $cur)))
      (if (i32.eqz (i32.and (local.get $style) (i32.const 0x10000000)))
        (then (return (i32.const 0))))
      (local.set $cur (call $wnd_get_parent (local.get $cur)))
      (br $walk)))
    (i32.const 1))

  ;; True while any ancestor still has a queued WM_ERASEBKGND. Real USER/GDI
  ;; will not let a child's pixels become durable under a later parent erase;
  ;; defer WAT-native control paints until the ancestor erase has drained.
  (func $wnd_has_pending_ancestor_erase (param $hwnd i32) (result i32)
    (local $cur i32)
    (local.set $cur (call $wnd_get_parent (local.get $hwnd)))
    (block $done (loop $walk
      (if (i32.eqz (local.get $cur)) (then (return (i32.const 0))))
      (if (i32.and (call $nc_flags_test (local.get $cur)) (i32.const 2))
        (then (return (i32.const 1))))
      (local.set $cur (call $wnd_get_parent (local.get $cur)))
      (br $walk)))
    (i32.const 0))

  ;; A native child must not paint ahead of an application-owned ancestor
  ;; whose later WM_PAINT can overwrite the child's pixels on the shared
  ;; top-level backing canvas. Keep the child queued until USER selects and
  ;; consumes every dirty ancestor; the parent-selection path then propagates
  ;; its update region back down to the child before the next native drain.
  (func $wnd_has_pending_ancestor_paint (param $hwnd i32) (result i32)
    (local $cur i32) (local $slot i32)
    (local.set $cur (call $wnd_get_parent (local.get $hwnd)))
    (block $done (loop $walk
      (if (i32.eqz (local.get $cur)) (then (return (i32.const 0))))
      (if (i32.and
            (i32.eq (local.get $cur) (global.get $main_hwnd))
            (i32.ne (global.get $paint_pending) (i32.const 0)))
        (then (return (i32.const 1))))
      (local.set $slot (call $wnd_table_find (local.get $cur)))
      (if (i32.and
            (i32.ne (local.get $slot) (i32.const -1))
            (i32.ne
              (i32.load8_u (i32.add (global.get $PAINT_FLAGS) (local.get $slot)))
              (i32.const 0)))
        (then (return (i32.const 1))))
      (local.set $cur (call $wnd_get_parent (local.get $cur)))
      (br $walk)))
    (i32.const 0))

  ;; Clear pending WAT-owned paint/update state for a subtree. ShowWindow(SW_HIDE)
  ;; makes the whole child tree non-paintable even when descendants retain their
  ;; own WS_VISIBLE style.
  (func $paint_clear_subtree (param $hwnd i32)
    (local $slot i32) (local $ch i32)
    (if (i32.eqz (local.get $hwnd)) (then (return)))
    (call $paint_flag_clear_hwnd (local.get $hwnd))
    (call $update_clear_hwnd (local.get $hwnd))
    (local.set $slot (i32.const 0))
    (block $done (loop $scan
      (local.set $slot (call $wnd_next_child_slot (local.get $hwnd) (local.get $slot)))
      (br_if $done (i32.lt_s (local.get $slot) (i32.const 0)))
      (local.set $ch (call $wnd_slot_hwnd (local.get $slot)))
      (call $paint_clear_subtree (local.get $ch))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $scan))))

  ;; $paint_flag_first() → hwnd of first dirty slot (0 if none), no clear.
  (func $paint_flag_first (result i32)
    (local $i i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (if (i32.load8_u (i32.add (global.get $PAINT_FLAGS) (local.get $i)))
        (then (return (i32.load (call $wnd_record_addr (local.get $i))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; $paint_flag_take() → hwnd of first dirty slot (0 if none), clears it.
  (func $paint_flag_take (result i32)
    (local $i i32) (local $hwnd i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (if (i32.load8_u (i32.add (global.get $PAINT_FLAGS) (local.get $i)))
        (then
          (i32.store8 (i32.add (global.get $PAINT_FLAGS) (local.get $i)) (i32.const 0))
          (local.set $hwnd (i32.load (call $wnd_record_addr (local.get $i))))
          (return (local.get $hwnd))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; $paint_flag_any() → 1 if any slot dirty, else 0.
  (func $paint_flag_any (result i32)
    (local $i i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (if (i32.load8_u (i32.add (global.get $PAINT_FLAGS) (local.get $i)))
        (then (return (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; $paint_select_next_dirty(): WAT-owned WM_PAINT selection.
  ;; A window is paintable when WAT marked its paint bit and its WAT-owned
  ;; update rect is non-empty.
  (func $paint_select_next_dirty (result i32)
    (local $i i32) (local $hwnd i32) (local $style i32) (local $cs i32) (local $ctrl_wh i32)
    (local $status_fallback i32)
    ;; Main-window invalidation historically used $paint_pending while child
    ;; windows used PAINT_FLAGS. The region-driven selector is the single
    ;; paint source now, so mirror main pending into the same flag table.
    (if (i32.and
          (i32.ne (global.get $paint_pending) (i32.const 0))
          (i32.ne (global.get $main_hwnd) (i32.const 0)))
      (then (call $paint_flag_set (global.get $main_hwnd))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (if (i32.load8_u (i32.add (global.get $PAINT_FLAGS) (local.get $i)))
        (then
          (local.set $hwnd (i32.load (call $wnd_record_addr (local.get $i))))
          (local.set $style (call $wnd_get_style (local.get $hwnd)))
          (local.set $ctrl_wh (call $ctrl_get_wh_packed (local.get $hwnd)))
          ;; Hidden windows do not receive WM_PAINT. Effective visibility must
          ;; include ancestors: NSIS hides wizard pages while their children
          ;; keep WS_VISIBLE, and Win98 still suppresses those children.
          (if (i32.eqz (call $wnd_is_effectively_visible (local.get $hwnd)))
            (then
              (call $paint_flag_clear_hwnd (local.get $hwnd))
              (call $update_clear_hwnd (local.get $hwnd))
              (if (i32.eq (local.get $hwnd) (global.get $main_hwnd))
                (then (global.set $paint_pending (i32.const 0)))))
            (else
              (local.set $cs (call $wnd_client_size_or_host (local.get $hwnd)))
              (if (i32.and
                    (i32.or
                      (i32.eqz (i32.and (local.get $cs) (i32.const 0xFFFF)))
                      (i32.eqz (i32.shr_u (local.get $cs) (i32.const 16))))
                    (i32.or
                      (i32.eqz (i32.and (local.get $ctrl_wh) (i32.const 0xFFFF)))
                      (i32.eqz (i32.shr_u (local.get $ctrl_wh) (i32.const 16)))))
                (then
                  (call $paint_flag_clear_hwnd (local.get $hwnd))
                  (if (i32.eq (local.get $hwnd) (global.get $main_hwnd))
                    (then (global.set $paint_pending (i32.const 0)))))
                (else
                  (if (call $update_get_rect (local.get $hwnd) (call $paint_scratch_take))
                    (then
                      ;; Native status bars paint after their guest-owned
                      ;; siblings so late non-client work cannot cover them.
                      (if (call $statusbar_native_is (local.get $hwnd))
                        (then (local.set $status_fallback (local.get $hwnd)))
                        (else (return (local.get $hwnd)))))
                    (else
                      ;; A stale paint bit without an update rect must not
                      ;; keep the message pump spinning.
                      (call $paint_flag_clear_hwnd (local.get $hwnd))
                      (if (i32.eq (local.get $hwnd) (global.get $main_hwnd))
                        (then (global.set $paint_pending (i32.const 0))))))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $status_fallback))

  ;; $paint_seed_child_paints(parent): WAT-owned propagation of a parent's
  ;; update region into descendant children. This replaces host JS child-paint
  ;; policy; JS only stores region geometry and receives primitive draw calls.
  (func $paint_seed_child_paints (param $parent i32) (result i32)
    (local $slot i32) (local $ch i32) (local $style i32)
    (local $pl i32) (local $pt i32) (local $pr i32) (local $pb i32)
    (local $xy i32) (local $wh i32) (local $cx i32) (local $cy i32) (local $cw i32) (local $chh i32)
    (local $il i32) (local $it i32) (local $ir i32) (local $ib i32) (local $n i32)
    (local $rect i32)
    (local.set $rect (call $paint_scratch_take))
    (if (i32.eqz (call $update_get_rect (local.get $parent) (local.get $rect)))
      (then (return (i32.const 0))))
    (local.set $pl (i32.load (local.get $rect)))
    (local.set $pt (i32.load offset=4 (local.get $rect)))
    (local.set $pr (i32.load offset=8 (local.get $rect)))
    (local.set $pb (i32.load offset=12 (local.get $rect)))
    (local.set $slot (i32.const 0))
    (block $done (loop $scan
      (local.set $slot (call $wnd_next_child_slot (local.get $parent) (local.get $slot)))
      (br_if $done (i32.lt_s (local.get $slot) (i32.const 0)))
      (local.set $ch (call $wnd_slot_hwnd (local.get $slot)))
      (local.set $style (call $wnd_get_style (local.get $ch)))
      (if (call $wnd_is_effectively_visible (local.get $ch))
        (then
          (local.set $wh (call $ctrl_get_wh_packed (local.get $ch)))
          (local.set $cx (call $ctrl_get_x_s (local.get $ch)))
          (local.set $cy (call $ctrl_get_y_s (local.get $ch)))
          (local.set $cw (i32.and (local.get $wh) (i32.const 0xFFFF)))
          (local.set $chh (i32.shr_u (local.get $wh) (i32.const 16)))
          (if (i32.and (i32.gt_s (local.get $cw) (i32.const 0))
                       (i32.gt_s (local.get $chh) (i32.const 0)))
            (then
              (local.set $il (select (i32.sub (local.get $pl) (local.get $cx)) (i32.const 0)
                                      (i32.gt_s (i32.sub (local.get $pl) (local.get $cx)) (i32.const 0))))
              (local.set $it (select (i32.sub (local.get $pt) (local.get $cy)) (i32.const 0)
                                      (i32.gt_s (i32.sub (local.get $pt) (local.get $cy)) (i32.const 0))))
              (local.set $ir (select (i32.sub (local.get $pr) (local.get $cx)) (local.get $cw)
                                      (i32.lt_s (i32.sub (local.get $pr) (local.get $cx)) (local.get $cw))))
              (local.set $ib (select (i32.sub (local.get $pb) (local.get $cy)) (local.get $chh)
                                      (i32.lt_s (i32.sub (local.get $pb) (local.get $cy)) (local.get $chh))))
              (if (i32.and (i32.gt_s (local.get $ir) (local.get $il))
                           (i32.gt_s (local.get $ib) (local.get $it)))
                (then
                  (call $update_invalidate_rect (local.get $ch)
                    (local.get $il) (local.get $it) (local.get $ir) (local.get $ib))
                  (call $paint_flag_set (local.get $ch))
                  (call $host_invalidate (local.get $ch))
                  (local.set $n (i32.add (local.get $n) (i32.const 1)))
                  ;; A parent paint can cover any depth of WS_CHILD windows.
                  ;; Seed the child's newly-created update region into its own
                  ;; children before dispatch starts selecting dirty windows.
                  (local.set $n (i32.add (local.get $n)
                    (call $paint_seed_child_paints (local.get $ch))))))))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $scan)))
    (local.get $n))

  ;; Dispatch WAT-native control WM_PAINT internally. Win32 built-in
  ;; controls have their own wndprocs; app message pumps may retrieve a
  ;; child WM_PAINT, but DispatchMessage routes it to the control proc, not
  ;; to the parent's fallback WndProc. Keeping this inside WAT prevents JS
  ;; from owning control paint policy and ensures native controls validate
  ;; even though they paint through host GDI primitives without BeginPaint.
  (func $paint_drain_native_control_paints (result i32)
    (local $i i32) (local $hwnd i32) (local $n i32) (local $guard i32) (local $progress i32)
    (block $done (loop $again
      (br_if $done (i32.ge_u (local.get $guard) (global.get $MAX_WINDOWS)))
      (local.set $progress (i32.const 0))
      (local.set $i (i32.const 0))
      (block $found (loop $scan
        (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
        (if (i32.load8_u (i32.add (global.get $PAINT_FLAGS) (local.get $i)))
          (then
            (local.set $hwnd (i32.load (call $wnd_record_addr (local.get $i))))
            (if (i32.eqz (call $ctrl_table_get_class (local.get $hwnd)))
              (then
                ;; Dirty, but this drain only paints WAT-native controls, so a
                ;; window whose CONTROL_TABLE class never got set is passed over
                ;; in silence however often it is invalidated.
                (call $ctrl_paint_trace_emit
                  (local.get $hwnd) (i32.const 0) (i32.const 4))))
            (if (call $ctrl_table_get_class (local.get $hwnd))
              (then
                (if (i32.or
                      (call $wnd_has_pending_ancestor_erase (local.get $hwnd))
                      (call $wnd_has_pending_ancestor_paint (local.get $hwnd)))
                  (then
                    (call $ctrl_paint_trace_emit (local.get $hwnd)
                      (call $ctrl_table_get_class (local.get $hwnd)) (i32.const 1))
                    (local.set $i (i32.add (local.get $i) (i32.const 1)))
                    (br $scan)))
                (if (i32.eqz (call $wnd_is_effectively_visible (local.get $hwnd)))
                  (then
                    (call $ctrl_paint_trace_emit (local.get $hwnd)
                      (call $ctrl_table_get_class (local.get $hwnd)) (i32.const 2))
                    (call $paint_flag_clear_hwnd (local.get $hwnd))
                    (call $update_clear_hwnd (local.get $hwnd))
                    (br $found)))
                (if (call $update_get_rect (local.get $hwnd) (call $paint_scratch_take))
                  (then
                    ;; Descendants inherit this update before it is consumed.
                    ;; Clearing first loses the geometry needed to intersect
                    ;; nested controls such as toolbar-hosted combo boxes.
                    (drop (call $paint_seed_child_paints (local.get $hwnd)))
                    (call $paint_flag_clear_hwnd (local.get $hwnd))
                    (call $update_clear_hwnd (local.get $hwnd))
                    (drop (call $control_wndproc_dispatch
                      (local.get $hwnd) (i32.const 0x000F)
                      (i32.const 0) (i32.const 0)))
                    (local.set $n (i32.add (local.get $n) (i32.const 1)))
                    (local.set $progress (i32.const 1))
                    (local.set $guard (i32.add (local.get $guard) (i32.const 1)))
                    (br $found))
                  (else
                    (call $ctrl_paint_trace_emit (local.get $hwnd)
                      (call $ctrl_table_get_class (local.get $hwnd)) (i32.const 3))
                    (call $paint_flag_clear_hwnd (local.get $hwnd))))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $scan)))
      (br_if $done (i32.eqz (local.get $progress)))
      (br $again)))
    (local.get $n))

  ;; Paint visible WAT-native controls below a shown parent immediately.
  ;; This models the Win98 visible-region pass that exposes child controls
  ;; when a dialog/page is shown. It is intentionally WAT-only: JS still only
  ;; supplies canvases and primitive GDI operations.
  (func $paint_flush_visible_native_children (param $parent i32) (result i32)
    (local $slot i32) (local $ch i32) (local $style i32) (local $n i32)
    (block $done (loop $scan
      (local.set $slot (call $wnd_next_child_slot (local.get $parent) (local.get $slot)))
      (br_if $done (i32.eq (local.get $slot) (i32.const -1)))
      (local.set $ch (call $wnd_slot_hwnd (local.get $slot)))
      (local.set $style (call $wnd_get_style (local.get $ch)))
      (if (call $wnd_is_effectively_visible (local.get $ch))
        (then
          (if (call $ctrl_table_get_class (local.get $ch))
            (then
              (if (call $wnd_has_pending_ancestor_erase (local.get $ch))
                (then
                  (call $paint_flag_set_inv (local.get $ch))
                  (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
                  (br $scan)))
              (call $update_invalidate_full (local.get $ch))
              (drop (call $control_wndproc_dispatch
                (local.get $ch) (i32.const 0x000F)
                (i32.const 0) (i32.const 0)))
              ;; The immediate exposure draw makes a just-shown hierarchy
              ;; visible even before its message loop resumes. Keep one USER
              ;; repaint queued as well: later pending non-client/ancestor
              ;; work may still touch the shared top-level surface, and the
              ;; queued native paint must be the final compositor pass.
              (call $paint_flag_set_inv (local.get $ch))
              (local.set $n (i32.add (local.get $n) (i32.const 1))))
            (else
              (local.set $n (i32.add
                (local.get $n)
                (call $paint_flush_visible_native_children (local.get $ch))))))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $scan)))
    (local.get $n))

  ;; ShowWindow has just made $parent visible, so its descendants should be
  ;; paintable based on their own WS_VISIBLE bits even if ancestor style/state
  ;; is still settling in a nested dialog transition.
  ;;
  ;; That premise is the caller's to keep. $win32_dispatch also runs this when
  ;; CreateDialog's WM_INITDIALOG returns, and a dialog page is routinely built
  ;; hidden, positioned with SetWindowPos, and only then shown -- a property
  ;; sheet does exactly that. Its children keep WS_VISIBLE throughout, so
  ;; without this guard they paint at the pre-move origin onto the top-level
  ;; back-canvas, and since a child owns no surface nothing ever erases them:
  ;; Sound Recorder's File > Properties drew every control twice, offset by the
  ;; SetWindowPos delta. A parent that is not itself shown has no exposed
  ;; region to flush.
  (func $paint_flush_shown_native_children (param $parent i32) (result i32)
    (local $slot i32) (local $ch i32) (local $style i32) (local $n i32)
    (if (i32.eqz (i32.and (call $wnd_get_style (local.get $parent))
                          (i32.const 0x10000000)))  ;; WS_VISIBLE
      (then (return (i32.const 0))))
    (block $done (loop $scan
      (local.set $slot (call $wnd_next_child_slot (local.get $parent) (local.get $slot)))
      (br_if $done (i32.eq (local.get $slot) (i32.const -1)))
      (local.set $ch (call $wnd_slot_hwnd (local.get $slot)))
      (local.set $style (call $wnd_get_style (local.get $ch)))
      (if (i32.and (local.get $style) (i32.const 0x10000000)) ;; WS_VISIBLE
        (then
          (if (call $ctrl_table_get_class (local.get $ch))
            (then
              ;; host_show_window already attached/resized the canonical
              ;; surface. Draw now even if the newly shown parent still has a
              ;; queued client paint; EndPaint repeats the child-after-parent
              ;; pass if that later paint overwrites shared pixels.
              (call $update_invalidate_full (local.get $ch))
              (drop (call $control_wndproc_dispatch
                (local.get $ch) (i32.const 0x000F)
                (i32.const 0) (i32.const 0)))
              (call $update_clear_hwnd (local.get $ch))
              (call $paint_flag_clear_hwnd (local.get $ch))
              (local.set $n (i32.add (local.get $n) (i32.const 1))))
            (else
              (local.set $n (i32.add
                (local.get $n)
                (call $paint_flush_shown_native_children (local.get $ch))))))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $scan)))
    (local.get $n))

  ;; Called from $wnd_table_remove and slot-recycle paths.
  (func $paint_flag_reset_slot (param $slot i32)
    (i32.store8 (i32.add (global.get $PAINT_FLAGS) (local.get $slot)) (i32.const 0))
    (i64.store (call $update_rect_addr_for_slot (local.get $slot)) (i64.const 0))
    (i64.store offset=8 (call $update_rect_addr_for_slot (local.get $slot)) (i64.const 0))
    (i32.store8 (call $update_flag_addr_for_slot (local.get $slot)) (i32.const 0)))

  ;; RichEdit charformat compatibility cache. Each table entry is a guest heap
  ;; pointer to { yHeight, selectionLo, selectionHi, reserved }. The native
  ;; RichEdit path renders explicit CFM_SIZE but can return the 32767 sentinel;
  ;; keeping the formatted range prevents that fallback from falsely claiming
  ;; a larger mixed-size selection is uniformly the latest size.
  (func $richedit_formatrange_next (param $fr_guest i32) (result i32)
    (local $fr i32) (local $cp_min i32) (local $cp_max i32)
    (local $cols i32) (local $lines i32) (local $next_cp i32)
    (if (i32.eqz (local.get $fr_guest)) (then (return (i32.const 0))))
    (local.set $fr (call $g2w (local.get $fr_guest)))
    (local.set $cp_min (i32.load offset=40 (local.get $fr)))
    (local.set $cp_max (i32.load offset=44 (local.get $fr)))
    ;; Bounded 10pt printer model: average 120 twips/character and 240
    ;; twips/line. Clamp malformed/reversed rectangles to one cell.
    (if (i32.gt_s (i32.load offset=16 (local.get $fr)) (i32.load offset=8 (local.get $fr)))
      (then (local.set $cols (i32.div_u
        (i32.sub (i32.load offset=16 (local.get $fr)) (i32.load offset=8 (local.get $fr)))
        (i32.const 120)))))
    (if (i32.gt_s (i32.load offset=20 (local.get $fr)) (i32.load offset=12 (local.get $fr)))
      (then (local.set $lines (i32.div_u
        (i32.sub (i32.load offset=20 (local.get $fr)) (i32.load offset=12 (local.get $fr)))
        (i32.const 240)))))
    (if (i32.eqz (local.get $cols)) (then (local.set $cols (i32.const 1))))
    (if (i32.eqz (local.get $lines)) (then (local.set $lines (i32.const 1))))
    (local.set $next_cp (i32.add (local.get $cp_min) (i32.mul (local.get $cols) (local.get $lines))))
    (if (i32.and (i32.ne (local.get $cp_max) (i32.const -1))
                 (i32.gt_u (local.get $next_cp) (local.get $cp_max)))
      (then (local.set $next_cp (local.get $cp_max))))
    (local.get $next_cp))

  (func $richedit_format_addr_for_slot (param $slot i32) (result i32)
    (i32.add (global.get $RICHEDIT_FORMAT_TABLE)
             (i32.shl (local.get $slot) (i32.const 2))))

  (func $richedit_para_addr_for_slot (param $slot i32) (result i32)
    (i32.add (global.get $RICHEDIT_PARA_TABLE)
             (i32.shl (local.get $slot) (i32.const 2))))

  (func $richedit_para_reset_slot (param $slot i32)
    (local $addr i32) (local $ptr i32)
    (if (i32.ge_u (local.get $slot) (global.get $MAX_WINDOWS)) (then (return)))
    (local.set $addr (call $richedit_para_addr_for_slot (local.get $slot)))
    (local.set $ptr (i32.load (local.get $addr)))
    (if (local.get $ptr)
      (then (call $heap_free (local.get $ptr))))
    (i32.store (local.get $addr) (i32.const 0)))

  (func $richedit_format_reset_slot (param $slot i32)
    (local $addr i32) (local $ptr i32)
    (if (i32.ge_u (local.get $slot) (global.get $MAX_WINDOWS)) (then (return)))
    (local.set $addr (call $richedit_format_addr_for_slot (local.get $slot)))
    (local.set $ptr (i32.load (local.get $addr)))
    (if (local.get $ptr) (then (call $heap_free (local.get $ptr))))
    (i32.store (local.get $addr) (i32.const 0))
    (call $richedit_para_reset_slot (local.get $slot)))

  (func $richedit_format_reset_hwnd (param $hwnd i32)
    (local $slot i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $slot) (i32.const -1)) (then (return)))
    (call $richedit_format_reset_slot (local.get $slot)))

  (func $richedit_note_text_reset_message (param $hwnd i32) (param $msg i32)
    (if (i32.or
          (i32.eq (local.get $msg) (i32.const 0x000C)) ;; WM_SETTEXT
          (i32.eq (local.get $msg) (i32.const 0x0449))) ;; EM_STREAMIN
      (then
        (call $richedit_format_reset_hwnd (local.get $hwnd)))))

  (func $richedit_note_charformat_message
        (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32)
    (local $slot i32) (local $cf_w i32) (local $mask i32) (local $yHeight i32)
    (local $cache_g i32) (local $cache_w i32) (local $scratch_g i32)
    (local $lo i32) (local $hi i32) (local $tmp i32)
    (if (i32.ne (local.get $msg) (i32.const 0x0444)) (then (return))) ;; EM_SETCHARFORMAT
    (if (i32.eqz (local.get $lParam)) (then (return)))
    (local.set $cf_w (call $g2w (local.get $lParam)))
    (local.set $mask (i32.load offset=4 (local.get $cf_w)))
    (if (i32.eqz (i32.and (local.get $mask) (i32.const 0x80000000)))
      (then (return))) ;; CFM_SIZE
    (local.set $yHeight (i32.load offset=12 (local.get $cf_w)))
    (if (i32.or
          (i32.le_s (local.get $yHeight) (i32.const 0))
          (i32.ge_u (local.get $yHeight) (i32.const 32767)))
      (then (return)))
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $slot) (i32.const -1)) (then (return)))
    (local.set $cache_g
      (i32.load (call $richedit_format_addr_for_slot (local.get $slot))))
    (if (i32.eqz (local.get $cache_g))
      (then
        (local.set $cache_g (call $heap_alloc (i32.const 16)))
        (if (i32.eqz (local.get $cache_g)) (then (return)))
        (i32.store (call $richedit_format_addr_for_slot (local.get $slot))
          (local.get $cache_g))))
    (local.set $cache_w (call $g2w (local.get $cache_g)))
    (if (i32.and (local.get $wParam) (i32.const 1)) ;; SCF_SELECTION
      (then
        (local.set $scratch_g (call $heap_alloc (i32.const 8)))
        (if (i32.eqz (local.get $scratch_g)) (then (return)))
        (call $gs32 (local.get $scratch_g) (i32.const 0))
        (call $gs32 (i32.add (local.get $scratch_g) (i32.const 4)) (i32.const 0))
        (drop (call $wnd_send_message
          (local.get $hwnd) (i32.const 0x00B0)
          (local.get $scratch_g)
          (i32.add (local.get $scratch_g) (i32.const 4)))) ;; EM_GETSEL
        (local.set $lo (call $gl32 (local.get $scratch_g)))
        (local.set $hi (call $gl32 (i32.add (local.get $scratch_g) (i32.const 4))))
        (call $heap_free (local.get $scratch_g))
        (if (i32.gt_u (local.get $lo) (local.get $hi))
          (then
            (local.set $tmp (local.get $lo))
            (local.set $lo (local.get $hi))
            (local.set $hi (local.get $tmp)))))
      (else
        (local.set $lo (i32.const 0))
        (local.set $hi (call $wnd_send_message
          (local.get $hwnd) (i32.const 0x000E) (i32.const 0) (i32.const 0))))) ;; WM_GETTEXTLENGTH
    (i32.store (local.get $cache_w) (local.get $yHeight))
    (i32.store offset=4 (local.get $cache_w) (local.get $lo))
    (i32.store offset=8 (local.get $cache_w) (local.get $hi))
    (i32.store offset=12 (local.get $cache_w) (i32.const 0))
    (call $host_note_richedit_charformat_size
      (local.get $yHeight) (local.get $lo) (local.get $hi)))

  ;; RichEdit paragraph compatibility cache. Native RichEdit already handles
  ;; simple alignment for WordPad; this preserves the other explicitly set
  ;; PARAFORMAT fields across immediate EM_GETPARAFORMAT probes without trying
  ;; to model mixed paragraph runs.
  (func $richedit_note_paraformat_message
        (param $hwnd i32) (param $msg i32) (param $lParam i32)
    (local $slot i32) (local $pf_w i32) (local $mask i32)
    (local $cache_g i32) (local $cache_w i32)
    (if (i32.ne (local.get $msg) (i32.const 0x0447)) (then (return))) ;; EM_SETPARAFORMAT
    (if (i32.eqz (local.get $lParam)) (then (return)))
    (local.set $pf_w (call $g2w (local.get $lParam)))
    ;; PARAFORMAT: PFM_STARTINDENT | PFM_RIGHTINDENT | PFM_OFFSET |
    ;; PFM_ALIGNMENT | PFM_TABSTOPS | PFM_NUMBERING.
    (local.set $mask (i32.and (i32.load offset=4 (local.get $pf_w)) (i32.const 0x0000003F)))
    (if (i32.eqz (local.get $mask)) (then (return)))
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $slot) (i32.const -1)) (then (return)))
    (local.set $cache_g
      (i32.load (call $richedit_para_addr_for_slot (local.get $slot))))
    (if (i32.eqz (local.get $cache_g))
      (then
        (local.set $cache_g (call $heap_alloc (i32.const 188)))
        (local.set $cache_w (call $g2w (local.get $cache_g)))
        (call $zero_memory (local.get $cache_w) (i32.const 188))
        (i32.store (local.get $cache_w) (i32.const 188))
        (i32.store (call $richedit_para_addr_for_slot (local.get $slot))
          (local.get $cache_g)))
      (else
        (local.set $cache_w (call $g2w (local.get $cache_g)))))
    (i32.store offset=4 (local.get $cache_w)
      (i32.or (i32.load offset=4 (local.get $cache_w)) (local.get $mask)))
    (if (i32.and (local.get $mask) (i32.const 0x00000020)) ;; PFM_NUMBERING
      (then
        (i32.store16 offset=8 (local.get $cache_w)
          (i32.load16_u offset=8 (local.get $pf_w)))))
    (if (i32.and (local.get $mask) (i32.const 0x00000001)) ;; PFM_STARTINDENT
      (then
        (i32.store offset=12 (local.get $cache_w)
          (i32.load offset=12 (local.get $pf_w)))))
    (if (i32.and (local.get $mask) (i32.const 0x00000002)) ;; PFM_RIGHTINDENT
      (then
        (i32.store offset=16 (local.get $cache_w)
          (i32.load offset=16 (local.get $pf_w)))))
    (if (i32.and (local.get $mask) (i32.const 0x00000004)) ;; PFM_OFFSET
      (then
        (i32.store offset=20 (local.get $cache_w)
          (i32.load offset=20 (local.get $pf_w)))))
    (if (i32.and (local.get $mask) (i32.const 0x00000008)) ;; PFM_ALIGNMENT
      (then
        (i32.store16 offset=24 (local.get $cache_w)
          (i32.load16_u offset=24 (local.get $pf_w)))))
    (if (i32.and (local.get $mask) (i32.const 0x00000010)) ;; PFM_TABSTOPS
      (then
        (i32.store16 offset=26 (local.get $cache_w)
          (i32.load16_u offset=26 (local.get $pf_w)))
        (call $memcpy
          (i32.add (local.get $cache_w) (i32.const 28))
          (i32.add (local.get $pf_w) (i32.const 28))
          (i32.const 128)))))

  (func $richedit_patch_get_charformat_message
        (param $hwnd i32) (param $msg i32) (param $lParam i32)
    (local $slot i32) (local $yHeight i32) (local $cf_w i32) (local $native_yHeight i32)
    (local $cache_g i32) (local $cache_w i32) (local $scratch_g i32)
    (local $lo i32) (local $hi i32) (local $tmp i32)
    (if (i32.ne (local.get $msg) (i32.const 0x043A)) (then (return))) ;; EM_GETCHARFORMAT
    (if (i32.eqz (local.get $lParam)) (then (return)))
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $slot) (i32.const -1)) (then (return)))
    (local.set $cache_g
      (i32.load (call $richedit_format_addr_for_slot (local.get $slot))))
    ;; Native RichEdit 2.0 reports its mixed/unknown-size sentinel (32767
    ;; twips) for a brand-new empty document. WordPad treats the value as a
    ;; real point size and puts "1638.5" in its formatting toolbar. There is
    ;; no mixed run in an empty document, so report WordPad's 10pt default.
    ;; Keep the native sentinel for non-empty mixed selections.
    (if (i32.eqz (local.get $cache_g))
      (then
        (local.set $cf_w (call $g2w (local.get $lParam)))
        (local.set $native_yHeight (i32.load offset=12 (local.get $cf_w)))
        (if (i32.and
              (i32.ge_u (local.get $native_yHeight) (i32.const 32767))
              (i32.eqz (call $wnd_send_message
                (local.get $hwnd) (i32.const 0x000E)
                (i32.const 0) (i32.const 0)))) ;; WM_GETTEXTLENGTH
          (then
            (i32.store offset=4 (local.get $cf_w)
              (i32.or (i32.load offset=4 (local.get $cf_w))
                      (i32.const 0x80000000))) ;; CFM_SIZE
            (i32.store offset=12 (local.get $cf_w) (i32.const 200)))) ;; 10pt
        (return)))
    (local.set $cache_w (call $g2w (local.get $cache_g)))
    (local.set $yHeight (i32.load (local.get $cache_w)))
    (local.set $scratch_g (call $heap_alloc (i32.const 8)))
    (if (i32.eqz (local.get $scratch_g)) (then (return)))
    (call $gs32 (local.get $scratch_g) (i32.const 0))
    (call $gs32 (i32.add (local.get $scratch_g) (i32.const 4)) (i32.const 0))
    (drop (call $wnd_send_message
      (local.get $hwnd) (i32.const 0x00B0)
      (local.get $scratch_g)
      (i32.add (local.get $scratch_g) (i32.const 4)))) ;; EM_GETSEL
    (local.set $lo (call $gl32 (local.get $scratch_g)))
    (local.set $hi (call $gl32 (i32.add (local.get $scratch_g) (i32.const 4))))
    (call $heap_free (local.get $scratch_g))
    (if (i32.gt_u (local.get $lo) (local.get $hi))
      (then
        (local.set $tmp (local.get $lo))
        (local.set $lo (local.get $hi))
        (local.set $hi (local.get $tmp))))
    (if (i32.or
          (i32.ne (local.get $lo) (i32.load offset=4 (local.get $cache_w)))
          (i32.ne (local.get $hi) (i32.load offset=8 (local.get $cache_w))))
      (then (return)))
    (local.set $cf_w (call $g2w (local.get $lParam)))
    (local.set $native_yHeight (i32.load offset=12 (local.get $cf_w)))
    (if (i32.and
          (i32.gt_s (local.get $native_yHeight) (i32.const 0))
          (i32.lt_u (local.get $native_yHeight) (i32.const 32767)))
      (then (return)))
    (i32.store offset=4 (local.get $cf_w)
      (i32.or (i32.load offset=4 (local.get $cf_w)) (i32.const 0x80000000))) ;; CFM_SIZE
    (i32.store offset=12 (local.get $cf_w) (local.get $yHeight)))

  (func $richedit_patch_get_paraformat_message
        (param $hwnd i32) (param $msg i32) (param $lParam i32)
    (local $slot i32) (local $pf_w i32) (local $cache_g i32) (local $cache_w i32)
    (local $mask i32)
    (if (i32.ne (local.get $msg) (i32.const 0x043D)) (then (return))) ;; EM_GETPARAFORMAT
    (if (i32.eqz (local.get $lParam)) (then (return)))
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $slot) (i32.const -1)) (then (return)))
    (local.set $cache_g
      (i32.load (call $richedit_para_addr_for_slot (local.get $slot))))
    (if (i32.eqz (local.get $cache_g)) (then (return)))
    (local.set $cache_w (call $g2w (local.get $cache_g)))
    (local.set $mask (i32.load offset=4 (local.get $cache_w)))
    (if (i32.eqz (local.get $mask)) (then (return)))
    (local.set $pf_w (call $g2w (local.get $lParam)))
    (if (i32.and (local.get $mask) (i32.const 0x00000020)) ;; PFM_NUMBERING
      (then
        (i32.store16 offset=8 (local.get $pf_w)
          (i32.load16_u offset=8 (local.get $cache_w)))))
    (if (i32.and (local.get $mask) (i32.const 0x00000001)) ;; PFM_STARTINDENT
      (then
        (i32.store offset=12 (local.get $pf_w)
          (i32.load offset=12 (local.get $cache_w)))))
    (if (i32.and (local.get $mask) (i32.const 0x00000002)) ;; PFM_RIGHTINDENT
      (then
        (i32.store offset=16 (local.get $pf_w)
          (i32.load offset=16 (local.get $cache_w)))))
    (if (i32.and (local.get $mask) (i32.const 0x00000004)) ;; PFM_OFFSET
      (then
        (i32.store offset=20 (local.get $pf_w)
          (i32.load offset=20 (local.get $cache_w)))))
    (if (i32.and (local.get $mask) (i32.const 0x00000008)) ;; PFM_ALIGNMENT
      (then
        (i32.store16 offset=24 (local.get $pf_w)
          (i32.load16_u offset=24 (local.get $cache_w)))))
    (if (i32.and (local.get $mask) (i32.const 0x00000010)) ;; PFM_TABSTOPS
      (then
        (i32.store16 offset=26 (local.get $pf_w)
          (i32.load16_u offset=26 (local.get $cache_w)))
        (call $memcpy
          (i32.add (local.get $pf_w) (i32.const 28))
          (i32.add (local.get $cache_w) (i32.const 28))
          (i32.const 128))))
    (i32.store offset=4 (local.get $pf_w)
      (i32.or (i32.load offset=4 (local.get $pf_w)) (local.get $mask))))

  ;; ---- NC_FLAGS / TITLE_TABLE / CLIENT_RECT (parallel to WND_RECORDS) ----
  ;; All three are indexed by the WND_RECORDS slot (0..MAX_WINDOWS-1).
  ;; Values are kept in sync with the wnd slot lifecycle.

  ;; $nc_flags_set(hwnd, bits): OR $bits into the slot's flag word.
  ;; Bumps $nc_flags_count if the slot transitions from 0 → non-zero.
  (func $nc_flags_set (param $hwnd i32) (param $bits i32)
    (local $idx i32) (local $addr i32) (local $old i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return)))
    (local.set $addr (i32.add (global.get $NC_FLAGS) (i32.mul (local.get $idx) (i32.const 4))))
    (local.set $old (i32.load (local.get $addr)))
    (i32.store (local.get $addr) (i32.or (local.get $old) (local.get $bits)))
    (if (i32.and (i32.eqz (local.get $old))
                 (i32.ne (i32.load (local.get $addr)) (i32.const 0)))
      (then (global.set $nc_flags_count (i32.add (global.get $nc_flags_count) (i32.const 1))))))

  ;; $nc_flags_clear(hwnd, bits): clear the specified bits; adjust count.
  (func $nc_flags_clear (param $hwnd i32) (param $bits i32)
    (local $idx i32) (local $addr i32) (local $old i32) (local $new i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return)))
    (local.set $addr (i32.add (global.get $NC_FLAGS) (i32.mul (local.get $idx) (i32.const 4))))
    (local.set $old (i32.load (local.get $addr)))
    (local.set $new (i32.and (local.get $old) (i32.xor (local.get $bits) (i32.const -1))))
    (i32.store (local.get $addr) (local.get $new))
    (if (i32.and (i32.ne (local.get $old) (i32.const 0))
                 (i32.eqz (local.get $new)))
      (then (global.set $nc_flags_count (i32.sub (global.get $nc_flags_count) (i32.const 1))))))

  ;; $nc_flags_test(hwnd) → i32 flag word (0 if slot missing).
  (func $nc_flags_test (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return (i32.const 0))))
    (i32.load (i32.add (global.get $NC_FLAGS) (i32.mul (local.get $idx) (i32.const 4)))))

  ;; $nc_flags_scan(mask) → hwnd of first slot with any $mask bit set, else 0.
  (func $nc_flags_scan (param $mask i32) (result i32)
    (local $i i32) (local $ptr i32) (local $flags i32) (local $hwnd i32) (local $new i32)
    (if (i32.eqz (global.get $nc_flags_count)) (then (return (i32.const 0))))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (i32.add (global.get $NC_FLAGS) (i32.mul (local.get $i) (i32.const 4))))
      (local.set $flags (i32.load (local.get $ptr)))
      (if (i32.and (local.get $flags) (local.get $mask))
        (then
          (local.set $hwnd (i32.load (call $wnd_record_addr (local.get $i))))
          ;; Defensive cleanup: a corrupt/stale NC flag must not synthesize
          ;; WM_NCPAINT for an impossible HWND and jump through DispatchMessage.
          (if (i32.and
                (i32.and (i32.ge_u (local.get $hwnd) (i32.const 0x10000))
                         (i32.lt_u (local.get $hwnd) (global.get $next_hwnd)))
                (i32.ne (i32.load offset=4 (call $wnd_record_addr (local.get $i))) (i32.const 0)))
            (then
              (if (call $wnd_is_effectively_visible (local.get $hwnd))
                (then (return (local.get $hwnd))))
              (if (i32.and (local.get $mask) (i32.const 4))
                (then (call $defwndproc_do_nccalcsize (local.get $hwnd))))
              (local.set $new (i32.and (local.get $flags) (i32.xor (local.get $mask) (i32.const -1))))
              (i32.store (local.get $ptr) (local.get $new))
              (if (i32.and (i32.eqz (local.get $new))
                           (i32.gt_u (global.get $nc_flags_count) (i32.const 0)))
                (then (global.set $nc_flags_count (i32.sub (global.get $nc_flags_count) (i32.const 1))))))
            (else
              (i32.store (local.get $ptr) (i32.const 0))
              (if (i32.gt_u (global.get $nc_flags_count) (i32.const 0))
                (then (global.set $nc_flags_count (i32.sub (global.get $nc_flags_count) (i32.const 1)))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; Clear all NC_FLAGS for a window — called from $wnd_table_remove path.
  (func $nc_flags_reset_slot (param $slot i32)
    (local $addr i32)
    (local.set $addr (i32.add (global.get $NC_FLAGS) (i32.mul (local.get $slot) (i32.const 4))))
    (if (i32.load (local.get $addr))
      (then
        (i32.store (local.get $addr) (i32.const 0))
        (global.set $nc_flags_count (i32.sub (global.get $nc_flags_count) (i32.const 1))))))

  ;; $title_table_set(hwnd, wa_ptr, len): copy title bytes into a heap buffer
  ;; and store ptr/len in the slot. Frees any prior heap buffer. wa_ptr=0
  ;; clears the slot.
  (func $title_table_set (param $hwnd i32) (param $wa_ptr i32) (param $len i32)
    (local $idx i32) (local $rec i32) (local $old_ptr i32)
    (local $buf i32) (local $i i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return)))
    (local.set $rec (i32.add (global.get $TITLE_TABLE) (i32.mul (local.get $idx) (i32.const 8))))
    (local.set $old_ptr (i32.load (local.get $rec)))
    (if (local.get $old_ptr) (then (call $heap_free (local.get $old_ptr))))
    (if (i32.or (i32.eqz (local.get $wa_ptr)) (i32.eqz (local.get $len)))
      (then
        (i32.store         (local.get $rec) (i32.const 0))
        (i32.store offset=4 (local.get $rec) (i32.const 0))
        (return)))
    ;; Cap length to 255 to fit in a reasonable buffer.
    (if (i32.gt_u (local.get $len) (i32.const 255))
      (then (local.set $len (i32.const 255))))
    (local.set $buf (call $heap_alloc (i32.add (local.get $len) (i32.const 1))))
    (if (i32.eqz (local.get $buf)) (then (return)))
    ;; $buf is a guest pointer; convert to WASM for memory.copy.
    (memory.copy (call $g2w (local.get $buf)) (local.get $wa_ptr) (local.get $len))
    (i32.store8 (i32.add (call $g2w (local.get $buf)) (local.get $len)) (i32.const 0))
    (i32.store         (local.get $rec) (local.get $buf))
    (i32.store offset=4 (local.get $rec) (local.get $len)))

  ;; $title_table_get_ptr(hwnd) → WASM heap ptr to title bytes (0 if none).
  ;; The stored slot holds a guest pointer (from $heap_alloc); convert to WASM
  ;; here so callers can read bytes directly from linear memory.
  (func $title_table_get_ptr (param $hwnd i32) (result i32)
    (local $idx i32) (local $gp i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return (i32.const 0))))
    (local.set $gp (i32.load (i32.add (global.get $TITLE_TABLE) (i32.mul (local.get $idx) (i32.const 8)))))
    (if (i32.eqz (local.get $gp)) (then (return (i32.const 0))))
    (call $g2w (local.get $gp)))

  (func $title_table_get_len (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return (i32.const 0))))
    (i32.load (i32.add (i32.add (global.get $TITLE_TABLE) (i32.mul (local.get $idx) (i32.const 8))) (i32.const 4))))

  ;; Called from $wnd_table_remove slot teardown to drop the heap buffer.
  (func $title_table_reset_slot (param $slot i32)
    (local $rec i32) (local $ptr i32)
    (local.set $rec (i32.add (global.get $TITLE_TABLE) (i32.mul (local.get $slot) (i32.const 8))))
    (local.set $ptr (i32.load (local.get $rec)))
    (if (local.get $ptr) (then (call $heap_free (local.get $ptr))))
    (i32.store         (local.get $rec) (i32.const 0))
    (i32.store offset=4 (local.get $rec) (i32.const 0)))

  ;; $client_rect_set(hwnd, l, t, r, b): store window-local client rect.
  (func $client_rect_set (param $hwnd i32) (param $l i32) (param $t i32) (param $r i32) (param $b i32)
    (local $idx i32) (local $rec i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return)))
    (local.set $rec (i32.add (global.get $CLIENT_RECT) (i32.mul (local.get $idx) (i32.const 16))))
    (i32.store          (local.get $rec) (local.get $l))
    (i32.store offset=4  (local.get $rec) (local.get $t))
    (i32.store offset=8  (local.get $rec) (local.get $r))
    (i32.store offset=12 (local.get $rec) (local.get $b)))

  (func $client_rect_get_l (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return (i32.const 0))))
    (i32.load (i32.add (global.get $CLIENT_RECT) (i32.mul (local.get $idx) (i32.const 16)))))
  (func $client_rect_get_t (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return (i32.const 0))))
    (i32.load (i32.add (i32.add (global.get $CLIENT_RECT) (i32.mul (local.get $idx) (i32.const 16))) (i32.const 4))))
  (func $client_rect_get_r (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return (i32.const 0))))
    (i32.load (i32.add (i32.add (global.get $CLIENT_RECT) (i32.mul (local.get $idx) (i32.const 16))) (i32.const 8))))
  (func $client_rect_get_b (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return (i32.const 0))))
    (i32.load (i32.add (i32.add (global.get $CLIENT_RECT) (i32.mul (local.get $idx) (i32.const 16))) (i32.const 12))))

  ;; Regioned top-level windows (SetWindowRgn) are app-drawn skins. Track a
  ;; persistent bit so later MoveWindow/SetWindowPos NCCALCSIZE does not
  ;; overwrite their whole-surface client rect with standard caption offsets.
  (func $wnd_region_reset_slot (param $slot i32)
    (local $addr i32) (local $mask i32)
    (if (i32.or
          (i32.lt_s (local.get $slot) (i32.const 0))
          (i32.ge_s (local.get $slot) (global.get $MAX_WINDOWS)))
      (then (return)))
    (local.set $addr
      (i32.add (global.get $WINDOW_REGION_BITS)
               (i32.shr_u (local.get $slot) (i32.const 3))))
    (local.set $mask
      (i32.shl (i32.const 1)
               (i32.and (local.get $slot) (i32.const 7))))
    (i32.store8 (local.get $addr)
      (i32.and
        (i32.load8_u (local.get $addr))
        (i32.xor (local.get $mask) (i32.const -1)))))

  (func $wnd_region_set (param $hwnd i32) (param $val i32)
    (local $idx i32) (local $addr i32) (local $mask i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return)))
    (local.set $addr
      (i32.add (global.get $WINDOW_REGION_BITS)
               (i32.shr_u (local.get $idx) (i32.const 3))))
    (local.set $mask
      (i32.shl (i32.const 1)
               (i32.and (local.get $idx) (i32.const 7))))
    (if (local.get $val)
      (then
        (i32.store8 (local.get $addr)
          (i32.or (i32.load8_u (local.get $addr)) (local.get $mask))))
      (else
        (i32.store8 (local.get $addr)
          (i32.and
            (i32.load8_u (local.get $addr))
            (i32.xor (local.get $mask) (i32.const -1)))))))

  (func $wnd_region_get (param $hwnd i32) (result i32)
    (local $idx i32) (local $addr i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return (i32.const 0))))
    (local.set $addr
      (i32.add (global.get $WINDOW_REGION_BITS)
               (i32.shr_u (local.get $idx) (i32.const 3))))
    (i32.and
      (i32.shr_u
        (i32.load8_u (local.get $addr))
        (i32.and (local.get $idx) (i32.const 7)))
      (i32.const 1)))

  ;; WAT-owned absolute HWND geometry. JS owns only top-level canvas placement;
  ;; child HWND origins/parent walks stay here so GDI target offsets, clipping,
  ;; and input hit-testing all use the same Win32 window tree.
  (func $ctrl_get_x_s (param $hwnd i32) (result i32)
    (local $xy i32)
    (local.set $xy (call $ctrl_get_xy_packed (local.get $hwnd)))
    (i32.shr_s (i32.shl (local.get $xy) (i32.const 16)) (i32.const 16)))

  (func $ctrl_get_y_s (param $hwnd i32) (result i32)
    (i32.shr_s (call $ctrl_get_xy_packed (local.get $hwnd)) (i32.const 16)))

  (func $wnd_top_level (param $hwnd i32) (result i32)
    (local $cur i32) (local $parent i32) (local $guard i32)
    (local.set $cur (local.get $hwnd))
    (block $done (loop $walk
      (br_if $done (i32.eqz (local.get $cur)))
      (br_if $done (i32.ge_u (local.get $guard) (i32.const 32)))
      ;; Owned popup/dialog windows may have an owner in the parent slot for
      ;; GetParent-style APIs, but only WS_CHILD windows inherit geometry from
      ;; that relationship.
      (br_if $done (i32.eqz (i32.and (call $wnd_get_style (local.get $cur)) (i32.const 0x40000000))))
      (local.set $parent (call $wnd_get_parent (local.get $cur)))
      (br_if $done (i32.eqz (local.get $parent)))
      (local.set $cur (local.get $parent))
      (local.set $guard (i32.add (local.get $guard) (i32.const 1)))
      (br $walk)))
    (local.get $cur))

  (func $wnd_window_screen_x (param $hwnd i32) (result i32)
    (local $parent i32) (local $style i32)
    (if (i32.eqz (local.get $hwnd)) (then (return (i32.const 0))))
    (local.set $style (call $wnd_get_style (local.get $hwnd)))
    (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
    (if (i32.or
          (i32.eqz (local.get $parent))
          (i32.eqz (i32.and (local.get $style) (i32.const 0x40000000))))
      (then
        (call $host_get_window_rect (local.get $hwnd) (global.get $WINDOW_RECT_SCRATCH))
        (return (i32.load (global.get $WINDOW_RECT_SCRATCH)))))
    (i32.add
      (call $wnd_client_screen_x (local.get $parent))
      (call $ctrl_get_x_s (local.get $hwnd))))

  (func $wnd_window_screen_y (param $hwnd i32) (result i32)
    (local $parent i32) (local $style i32)
    (if (i32.eqz (local.get $hwnd)) (then (return (i32.const 0))))
    (local.set $style (call $wnd_get_style (local.get $hwnd)))
    (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
    (if (i32.or
          (i32.eqz (local.get $parent))
          (i32.eqz (i32.and (local.get $style) (i32.const 0x40000000))))
      (then
        (call $host_get_window_rect (local.get $hwnd) (global.get $WINDOW_RECT_SCRATCH))
        (return (i32.load offset=4 (global.get $WINDOW_RECT_SCRATCH)))))
    (i32.add
      (call $wnd_client_screen_y (local.get $parent))
      (call $ctrl_get_y_s (local.get $hwnd))))

  ;; Screen origin of an HWND's client area. Win32 coordinate conversion uses
  ;; this, not the window origin; top-level client origins include NC chrome,
  ;; while child controls/dialogs usually have a zero client offset.
  (func $wnd_client_screen_x (param $hwnd i32) (result i32)
    (i32.add
      (call $wnd_window_screen_x (local.get $hwnd))
      (call $client_rect_get_l (local.get $hwnd))))

  (func $wnd_client_screen_y (param $hwnd i32) (result i32)
    (i32.add
      (call $wnd_window_screen_y (local.get $hwnd))
      (call $client_rect_get_t (local.get $hwnd))))

  (func $wnd_screen_w (param $hwnd i32) (result i32)
    (local $parent i32) (local $wh i32) (local $style i32)
    (if (i32.eqz (local.get $hwnd)) (then (return (i32.const 0))))
    (local.set $style (call $wnd_get_style (local.get $hwnd)))
    (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
    (if (i32.and
          (i32.ne (local.get $parent) (i32.const 0))
          (i32.ne (i32.and (local.get $style) (i32.const 0x40000000)) (i32.const 0)))
      (then
        (local.set $wh (call $ctrl_get_wh_packed (local.get $hwnd)))
        (return (i32.and (local.get $wh) (i32.const 0xFFFF)))))
    (call $host_get_window_rect (local.get $hwnd) (global.get $WINDOW_RECT_SCRATCH))
    (i32.sub
      (i32.load offset=8 (global.get $WINDOW_RECT_SCRATCH))
      (i32.load (global.get $WINDOW_RECT_SCRATCH))))

  (func $wnd_screen_h (param $hwnd i32) (result i32)
    (local $parent i32) (local $wh i32) (local $style i32)
    (if (i32.eqz (local.get $hwnd)) (then (return (i32.const 0))))
    (local.set $style (call $wnd_get_style (local.get $hwnd)))
    (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
    (if (i32.and
          (i32.ne (local.get $parent) (i32.const 0))
          (i32.ne (i32.and (local.get $style) (i32.const 0x40000000)) (i32.const 0)))
      (then
        (local.set $wh (call $ctrl_get_wh_packed (local.get $hwnd)))
        (return (i32.shr_u (local.get $wh) (i32.const 16)))))
    (call $host_get_window_rect (local.get $hwnd) (global.get $WINDOW_RECT_SCRATCH))
    (i32.sub
      (i32.load offset=12 (global.get $WINDOW_RECT_SCRATCH))
      (i32.load offset=4 (global.get $WINDOW_RECT_SCRATCH))))

  ;; Mouse-message coordinate origin for captured input. Win32 mouse lParams
  ;; are client-relative for normal top-level windows, but child controls and
  ;; popup windows (combo/list dropdowns, menus) use their own window origin.
  (func $wnd_mouse_msg_origin_x (param $hwnd i32) (result i32)
    (local $top i32) (local $style i32)
    (if (i32.eqz (local.get $hwnd)) (then (return (i32.const 0))))
    (local.set $top (call $wnd_top_level (local.get $hwnd)))
    (local.set $style (call $wnd_get_style (local.get $hwnd)))
    (if (i32.or
          (i32.and (local.get $style) (i32.const 0x40000000))
          (i32.and (call $wnd_get_style (local.get $top)) (i32.const 0x80000000)))
      (then (return (call $wnd_window_screen_x (local.get $hwnd)))))
    (call $wnd_client_screen_x (local.get $top)))

  (func $wnd_mouse_msg_origin_y (param $hwnd i32) (result i32)
    (local $top i32) (local $style i32)
    (if (i32.eqz (local.get $hwnd)) (then (return (i32.const 0))))
    (local.set $top (call $wnd_top_level (local.get $hwnd)))
    (local.set $style (call $wnd_get_style (local.get $hwnd)))
    (if (i32.or
          (i32.and (local.get $style) (i32.const 0x40000000))
          (i32.and (call $wnd_get_style (local.get $top)) (i32.const 0x80000000)))
      (then (return (call $wnd_window_screen_y (local.get $hwnd)))))
    (call $wnd_client_screen_y (local.get $top)))

  ;; Fill MSG.time/MSG.pt for delivered input. Real Win32 records screen-space
  ;; cursor coordinates in MSG.pt and GetMessagePos(); client-relative lParam is
  ;; not enough for control/button tracking loops.
  (func $msg_store_input_tail (param $msg_ptr i32) (param $hwnd i32) (param $msg i32) (param $lparam i32)
    (local $x i32) (local $y i32)
    (local.set $x (global.get $last_msg_pos_x))
    (local.set $y (global.get $last_msg_pos_y))
    (if
      (i32.or
        (i32.and
          (i32.ge_u (local.get $msg) (i32.const 0x0200))
          (i32.le_u (local.get $msg) (i32.const 0x020D)))
        (i32.and
          (i32.ge_u (local.get $msg) (i32.const 0x00A0))
          (i32.le_u (local.get $msg) (i32.const 0x00AD))))
      (then
        (local.set $x
          (i32.add
            (call $wnd_mouse_msg_origin_x (local.get $hwnd))
            (i32.extend16_s (local.get $lparam))))
        (local.set $y
          (i32.add
            (call $wnd_mouse_msg_origin_y (local.get $hwnd))
            (i32.extend16_s (i32.shr_u (local.get $lparam) (i32.const 16)))))
        (global.set $last_msg_pos_x (local.get $x))
        (global.set $last_msg_pos_y (local.get $y))))
    (global.set $last_msg_time (call $host_get_ticks))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 16)) (global.get $last_msg_time))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 20)) (local.get $x))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 24)) (local.get $y)))

  ;; Deep child WindowFromPoint helper. JS supplies only the browser point and
  ;; current top-level candidate; USER-style child visibility/geometry/class
  ;; filtering stays in WAT with the rest of the HWND tree.
  (func $wnd_child_from_point_deep (param $parent i32) (param $sx i32) (param $sy i32) (result i32)
    (local $slot i32) (local $ch i32) (local $cls i32) (local $style i32)
    (local $x i32) (local $y i32) (local $w i32) (local $h i32) (local $deep i32)
    (local.set $slot (i32.const 0))
    (block $done (loop $scan
      (local.set $slot (call $wnd_next_child_slot (local.get $parent) (local.get $slot)))
      (br_if $done (i32.lt_s (local.get $slot) (i32.const 0)))
      (local.set $ch (call $wnd_slot_hwnd (local.get $slot)))
      (local.set $style (call $wnd_get_style (local.get $ch)))
      (if (i32.eqz (call $wnd_is_effectively_visible (local.get $ch)))
        (then
          (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
          (br $scan)))
      ;; A static and the colour grid are click-transparent wherever they sit,
      ;; so they never take a generic client click. A combobox is different: it
      ;; is skipped here because the DIALOG router delivers its clicks -- and
      ;; that router only exists when the parent is a dialog. WordPad's font and
      ;; size combos live on a toolbar, so skipping them there meant the click
      ;; landed on the toolbar and the list could never drop down.
      (local.set $cls (call $ctrl_table_get_class (local.get $ch)))
      (if (i32.or
            (i32.or (i32.eq (local.get $cls) (i32.const 3))
                    (i32.eq (local.get $cls) (i32.const 6)))
            (i32.and (i32.eq (local.get $cls) (i32.const 5))
              (i32.eq (call $wnd_table_get (local.get $parent))
                      (global.get $WNDPROC_DIALOG))))
        (then
          (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
          (br $scan)))
      (local.set $x (call $wnd_window_screen_x (local.get $ch)))
      (local.set $y (call $wnd_window_screen_y (local.get $ch)))
      (local.set $w (call $wnd_screen_w (local.get $ch)))
      (local.set $h (call $wnd_screen_h (local.get $ch)))
      ;; A closed combobox claims its field, not the whole dropped-height
      ;; window it was created with; see $combobox_hit_h.
      (if (i32.eq (local.get $cls) (i32.const 5))
        (then (local.set $h (call $combobox_hit_h (local.get $ch) (local.get $h)))))
      (if (i32.and
            (i32.and (i32.ge_s (local.get $sx) (local.get $x))
                     (i32.lt_s (local.get $sx) (i32.add (local.get $x) (local.get $w))))
            (i32.and (i32.ge_s (local.get $sy) (local.get $y))
                     (i32.lt_s (local.get $sy) (i32.add (local.get $y) (local.get $h)))))
        (then
          ;; A combobox owns its own edit field, button and list. The click
          ;; belongs to the combobox itself -- it is what drops the list down --
          ;; so stop here rather than descending into a part of it.
          (if (i32.eq (local.get $cls) (i32.const 5))
            (then (return (local.get $ch))))
          (local.set $deep (call $wnd_child_from_point_deep
            (local.get $ch) (local.get $sx) (local.get $sy)))
          (return (select (local.get $deep) (local.get $ch) (local.get $deep)))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; Screen-coordinate wrapper around dialog_route_mouse. JS should not know
  ;; whether the dialog/page origin is its window origin or client origin.
  (func $dialog_route_mouse_screen
    (param $parent i32) (param $msg i32) (param $wParam i32) (param $sx i32) (param $sy i32) (result i32)
    (local $ox i32) (local $oy i32)
    (local.set $ox (call $wnd_client_screen_x (local.get $parent)))
    (local.set $oy (call $wnd_client_screen_y (local.get $parent)))
    (call $dialog_route_mouse
      (local.get $parent)
      (local.get $msg)
      (local.get $wParam)
      (i32.or
        (i32.and (i32.sub (local.get $sx) (local.get $ox)) (i32.const 0xFFFF))
        (i32.shl
          (i32.and (i32.sub (local.get $sy) (local.get $oy)) (i32.const 0xFFFF))
          (i32.const 16)))))

  (func $dialog_ancestor (param $hwnd i32) (result i32)
    (local $cur i32) (local $guard i32) (local $rec i32)
    (local.set $cur (local.get $hwnd))
    (block $done (loop $walk
      (br_if $done (i32.eqz (local.get $cur)))
      (br_if $done (i32.ge_u (local.get $guard) (i32.const 32)))
      (local.set $rec (call $dlg_record_for_hwnd (local.get $cur)))
      (if (i32.and (i32.ne (local.get $rec) (i32.const 0)) (i32.ne (i32.load offset=28 (local.get $rec)) (i32.const 0)))
        (then (return (local.get $cur))))
      (local.set $cur (call $wnd_get_parent (local.get $cur)))
      (local.set $guard (i32.add (local.get $guard) (i32.const 1)))
      (br $walk)))
    (i32.const 0))

  (func $dialog_first_default_button (param $dlg i32) (result i32)
    (local $slot i32) (local $ch i32) (local $st i32) (local $state i32)
    (local.set $slot (i32.const 0))
    (block $done (loop $scan
      (local.set $slot (call $wnd_next_child_slot (local.get $dlg) (local.get $slot)))
      (br_if $done (i32.lt_s (local.get $slot) (i32.const 0)))
      (local.set $ch (call $wnd_slot_hwnd (local.get $slot)))
        (if (i32.and
              (i32.ne (call $wnd_is_effectively_visible (local.get $ch)) (i32.const 0))
              (i32.eq (call $ctrl_table_get_class (local.get $ch)) (i32.const 1)))
        (then
          (local.set $st (call $wnd_get_state_ptr (local.get $ch)))
          (if (local.get $st)
            (then
              (local.set $state (call $g2w (local.get $st)))
              (if (i32.and (i32.load offset=8 (local.get $state)) (i32.const 0x04))
                (then (return (local.get $ch))))))
          (if (i32.eq (i32.and (call $wnd_get_style (local.get $ch)) (i32.const 0x0F)) (i32.const 1))
            (then (return (local.get $ch))))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  (func $dialog_next_tabstop (param $dlg i32) (param $focus i32) (param $dir i32) (result i32)
    (local $slot i32) (local $ch i32) (local $style i32)
    (local $first i32) (local $last i32) (local $prev i32) (local $seen i32)
    (local.set $slot (i32.const 0))
    (block $done (loop $scan
      (local.set $slot (call $wnd_next_child_slot (local.get $dlg) (local.get $slot)))
      (br_if $done (i32.lt_s (local.get $slot) (i32.const 0)))
      (local.set $ch (call $wnd_slot_hwnd (local.get $slot)))
      (local.set $style (call $wnd_get_style (local.get $ch)))
      (if (i32.and
            (i32.and
              (i32.ne (call $wnd_is_effectively_visible (local.get $ch)) (i32.const 0))
              (i32.eqz (i32.and (local.get $style) (i32.const 0x08000000)))) ;; !WS_DISABLED
            (i32.ne (i32.and (local.get $style) (i32.const 0x00010000)) (i32.const 0))) ;; WS_TABSTOP
        (then
          (if (i32.eqz (local.get $first)) (then (local.set $first (local.get $ch))))
          (if (i32.gt_s (local.get $dir) (i32.const 0))
            (then
              (if (local.get $seen) (then (return (local.get $ch))))
              (if (i32.eq (local.get $ch) (local.get $focus)) (then (local.set $seen (i32.const 1)))))
            (else
              (if (i32.eq (local.get $ch) (local.get $focus))
                (then
                  (if (local.get $prev)
                    (then (return (local.get $prev))))
                  (local.set $seen (i32.const 1))))
              (local.set $prev (local.get $ch))))
          (local.set $last (local.get $ch))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $scan)))
    (if (i32.gt_s (local.get $dir) (i32.const 0))
      (then (return (select (local.get $first) (local.get $last) (local.get $first)))))
    (select (local.get $last) (local.get $first) (local.get $last)))

  (func $dialog_handle_key (param $dlg i32) (param $vk i32) (param $shift i32) (result i32)
    (local $focus i32) (local $target i32) (local $id i32) (local $style i32)
    (if (i32.eqz (local.get $dlg)) (then (return (i32.const 0))))
    (local.set $focus (global.get $focus_hwnd))
    ;; Esc: IDCANCEL
    (if (i32.eq (local.get $vk) (i32.const 27))
      (then
        (drop (call $wnd_send_message (local.get $dlg) (i32.const 0x0111) (i32.const 2) (i32.const 0)))
        (return (i32.const 1))))
    ;; Tab / Shift+Tab: next/previous visible tabstop.
    (if (i32.eq (local.get $vk) (i32.const 9))
      (then
        (local.set $target (call $dialog_next_tabstop
          (local.get $dlg) (local.get $focus)
          (select (i32.const -1) (i32.const 1) (local.get $shift))))
        (if (local.get $target)
          (then
            (call $set_focus (local.get $target))
            (return (i32.const 1))))))
    ;; Enter: current/default push button.
    (if (i32.eq (local.get $vk) (i32.const 13))
      (then
        (local.set $target (call $dialog_first_default_button (local.get $dlg)))
        (if (i32.eqz (local.get $target))
          (then (local.set $target (call $ctrl_find_by_id (local.get $dlg) (i32.const 1)))))
        (if (local.get $target)
          (then
            (local.set $id (call $ctrl_table_get_id (local.get $target)))
            (drop (call $wnd_send_message (local.get $dlg) (i32.const 0x0111)
              (local.get $id) (local.get $target)))
            (return (i32.const 1))))))
    ;; Space: click focused button.
    (if (i32.eq (local.get $vk) (i32.const 32))
      (then
        (if (i32.and
              (i32.ne (local.get $focus) (i32.const 0))
              (i32.eq (call $ctrl_table_get_class (local.get $focus)) (i32.const 1)))
          (then
            (local.set $id (call $ctrl_table_get_id (local.get $focus)))
            (drop (call $wnd_send_message (local.get $dlg) (i32.const 0x0111)
              (local.get $id) (local.get $focus)))
            (return (i32.const 1))))))
    (i32.const 0))

  (func $wnd_first_visible_control_class (param $cls i32) (result i32)
    (local $i i32) (local $hwnd i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $hwnd (i32.load (call $wnd_record_addr (local.get $i))))
      (if (i32.and
            (i32.and
              (i32.ne (local.get $hwnd) (i32.const 0))
              (i32.eq (call $ctrl_table_get_class (local.get $hwnd)) (local.get $cls)))
            (i32.ne (call $wnd_is_effectively_visible (local.get $hwnd)) (i32.const 0)))
        (then (return (local.get $hwnd))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  (func $edit_command_target (result i32)
    (local $target i32)
    (if (i32.and
          (i32.ne (global.get $focus_hwnd) (i32.const 0))
          (i32.eq (call $ctrl_table_get_class (global.get $focus_hwnd)) (i32.const 2)))
      (then (return (global.get $focus_hwnd))))
    (local.set $target (call $wnd_first_visible_control_class (i32.const 2)))
    (if (local.get $target) (then (call $set_focus (local.get $target))))
    (local.get $target))

  ;; WordPad's color toolbar builds a temporary owner-draw popup with command
  ;; ids 0x800e..0x801e. TrackPopupMenu is currently asynchronous in this
  ;; emulator, so WordPad destroys that temporary MFC menu state immediately
  ;; after opening it. Keep the user-visible behavior by applying the selected
  ;; color directly to the WordPad RichEdit child.
  (func $wordpad_colorref_for_index (param $idx i32) (result i32)
    (local $k i32) (local $c i32)
    (if (i32.lt_u (local.get $idx) (i32.const 8))
      (then
        (local.set $c (i32.const 0))
        (if (i32.and (local.get $idx) (i32.const 1))
          (then (local.set $c (i32.or (local.get $c) (i32.const 0x00000080)))))
        (if (i32.and (local.get $idx) (i32.const 2))
          (then (local.set $c (i32.or (local.get $c) (i32.const 0x00008000)))))
        (if (i32.and (local.get $idx) (i32.const 4))
          (then (local.set $c (i32.or (local.get $c) (i32.const 0x00800000)))))
        (return (local.get $c))))
    (if (i32.eq (local.get $idx) (i32.const 8))
      (then (return (i32.const 0x00C0C0C0))))
    (local.set $k (i32.sub (local.get $idx) (i32.const 8)))
    (local.set $c (i32.const 0))
    (if (i32.and (local.get $k) (i32.const 1))
      (then (local.set $c (i32.or (local.get $c) (i32.const 0x000000FF)))))
    (if (i32.and (local.get $k) (i32.const 2))
      (then (local.set $c (i32.or (local.get $c) (i32.const 0x0000FF00)))))
    (if (i32.and (local.get $k) (i32.const 4))
      (then (local.set $c (i32.or (local.get $c) (i32.const 0x00FF0000)))))
    (local.get $c))

  (func $wordpad_richedit_target (result i32)
    (local $top i32) (local $target i32)
    (if (i32.and
          (i32.ne (global.get $focus_hwnd) (i32.const 0))
          (i32.eq (call $ctrl_table_get_id (global.get $focus_hwnd)) (i32.const 0xE900)))
      (then (return (global.get $focus_hwnd))))
    (local.set $top (global.get $menu_open_hwnd))
    (if (i32.eqz (local.get $top))
      (then
        (if (global.get $focus_hwnd)
          (then (local.set $top (call $wnd_top_level (global.get $focus_hwnd)))))))
    (if (local.get $top)
      (then
        (local.set $target (call $ctrl_find_by_id (local.get $top) (i32.const 0xE900)))
        (if (local.get $target) (then (return (local.get $target))))))
    (i32.const 0))

  (func $native_text_logical_to_string_index
        (param $buf_g i32) (param $text_len i32) (param $logical_pos i32)
        (result i32)
    (local $i i32) (local $logical i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $text_len)))
      (br_if $done (i32.ge_u (local.get $logical) (local.get $logical_pos)))
      ;; Native RichEdit selection offsets count CRLF as one logical character;
      ;; WM_GETTEXT returns CRLF as two bytes. Match the renderer native-text
      ;; bridge so menu Copy/Cut handles multiline text sensibly.
      (if (i32.and
            (i32.eq
              (call $gl8 (i32.add (local.get $buf_g) (local.get $i)))
              (i32.const 13))
            (i32.and
              (i32.lt_u (i32.add (local.get $i) (i32.const 1)) (local.get $text_len))
              (i32.eq
                (call $gl8 (i32.add
                  (local.get $buf_g)
                  (i32.add (local.get $i) (i32.const 1))))
                (i32.const 10))))
        (then (local.set $i (i32.add (local.get $i) (i32.const 2))))
        (else (local.set $i (i32.add (local.get $i) (i32.const 1)))))
      (local.set $logical (i32.add (local.get $logical) (i32.const 1)))
      (br $scan)))
    (local.get $i))

  (func $clipboard_hex_nibble_ascii (param $n i32) (result i32)
    (if (result i32) (i32.lt_u (local.get $n) (i32.const 10))
      (then (i32.add (local.get $n) (i32.const 48)))
      (else (i32.add (local.get $n) (i32.const 87)))))

  (func $clipboard_rtf_name_char (param $i i32) (result i32)
    (local $ch i32)
    (if (i32.eq (local.get $i) (i32.const 0)) (then (local.set $ch (i32.const 82))))  ;; R
    (if (i32.eq (local.get $i) (i32.const 1)) (then (local.set $ch (i32.const 105)))) ;; i
    (if (i32.eq (local.get $i) (i32.const 2)) (then (local.set $ch (i32.const 99))))  ;; c
    (if (i32.eq (local.get $i) (i32.const 3)) (then (local.set $ch (i32.const 104)))) ;; h
    (if (i32.eq (local.get $i) (i32.const 4)) (then (local.set $ch (i32.const 32))))  ;; space
    (if (i32.eq (local.get $i) (i32.const 5)) (then (local.set $ch (i32.const 84))))  ;; T
    (if (i32.eq (local.get $i) (i32.const 6)) (then (local.set $ch (i32.const 101)))) ;; e
    (if (i32.eq (local.get $i) (i32.const 7)) (then (local.set $ch (i32.const 120)))) ;; x
    (if (i32.eq (local.get $i) (i32.const 8)) (then (local.set $ch (i32.const 116)))) ;; t
    (if (i32.eq (local.get $i) (i32.const 9)) (then (local.set $ch (i32.const 32))))  ;; space
    (if (i32.eq (local.get $i) (i32.const 10)) (then (local.set $ch (i32.const 70)))) ;; F
    (if (i32.eq (local.get $i) (i32.const 11)) (then (local.set $ch (i32.const 111)))) ;; o
    (if (i32.eq (local.get $i) (i32.const 12)) (then (local.set $ch (i32.const 114)))) ;; r
    (if (i32.eq (local.get $i) (i32.const 13)) (then (local.set $ch (i32.const 109)))) ;; m
    (if (i32.eq (local.get $i) (i32.const 14)) (then (local.set $ch (i32.const 97))))  ;; a
    (if (i32.eq (local.get $i) (i32.const 15)) (then (local.set $ch (i32.const 116)))) ;; t
    (local.get $ch))

  (func $guest_str_is_rich_text_format_a (param $gp i32) (result i32)
    (local $i i32)
    (if (i32.eqz (local.get $gp)) (then (return (i32.const 0))))
    (block $done (loop $scan
      (if (i32.ge_u (local.get $i) (i32.const 16))
        (then
          (return
            (if (result i32)
              (i32.eqz (call $gl8 (i32.add (local.get $gp) (local.get $i))))
              (then (i32.const 1))
              (else (i32.const 0))))))
      (if (i32.ne
            (call $gl8 (i32.add (local.get $gp) (local.get $i)))
            (call $clipboard_rtf_name_char (local.get $i)))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  (func $guest_str_is_rich_text_format_w (param $gp i32) (result i32)
    (local $i i32)
    (if (i32.eqz (local.get $gp)) (then (return (i32.const 0))))
    (block $done (loop $scan
      (if (i32.ge_u (local.get $i) (i32.const 16))
        (then
          (return
            (if (result i32)
              (i32.eqz (call $gl16 (i32.add (local.get $gp) (i32.shl (local.get $i) (i32.const 1)))))
              (then (i32.const 1))
              (else (i32.const 0))))))
      (if (i32.ne
            (call $gl16 (i32.add (local.get $gp) (i32.shl (local.get $i) (i32.const 1))))
            (call $clipboard_rtf_name_char (local.get $i)))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  (func $clipboard_get_rtf_format_id (result i32)
    (if (i32.eqz (global.get $clipboard_rtf_format_id))
      (then
        (global.set $clipboard_fmt_counter
          (i32.add (global.get $clipboard_fmt_counter) (i32.const 1)))
        (global.set $clipboard_rtf_format_id
          (i32.add (i32.const 0xC000) (global.get $clipboard_fmt_counter)))))
    (global.get $clipboard_rtf_format_id))

  ;; Intern one ANSI format name. Names are compared case-insensitively, as
  ;; RegisterClipboardFormat documents, and the id is stable for the life of the
  ;; process — registering is idempotent, there is no unregister.
  (func $clipfmt_intern (param $name_g i32) (result i32)
    (local $i i32) (local $e i32) (local $copy i32)
    (if (i32.eqz (local.get $name_g)) (then (return (i32.const 0))))
    (if (i32.eqz (call $gl8 (local.get $name_g))) (then (return (i32.const 0))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $CLIPFORMAT_SLOTS)))
      (local.set $e (i32.add (global.get $CLIPFORMAT_TABLE)
        (i32.mul (local.get $i) (i32.const 8))))
      (if (i32.eqz (i32.load (local.get $e))) (then (br $done)))
      (if (i32.eqz (call $guest_stricmp (i32.load (local.get $e)) (local.get $name_g)))
        (then (return (i32.load offset=4 (local.get $e)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    ;; Out of slots: still hand back a usable, unique id rather than failing the
    ;; call. It cannot be shared with a later registration of the same name, but
    ;; a zero return means "invalid format" and would be worse.
    (if (i32.ge_u (local.get $i) (global.get $CLIPFORMAT_SLOTS))
      (then
        (global.set $clipboard_fmt_counter
          (i32.add (global.get $clipboard_fmt_counter) (i32.const 1)))
        (return (i32.add (i32.const 0xC000) (global.get $clipboard_fmt_counter)))))
    (local.set $copy (call $heap_alloc
      (i32.add (call $guest_strlen (local.get $name_g)) (i32.const 1))))
    (if (i32.eqz (local.get $copy)) (then (return (i32.const 0))))
    (call $guest_strcpy (local.get $copy) (local.get $name_g))
    (global.set $clipboard_fmt_counter
      (i32.add (global.get $clipboard_fmt_counter) (i32.const 1)))
    (i32.store (local.get $e) (local.get $copy))
    (i32.store offset=4 (local.get $e)
      (i32.add (i32.const 0xC000) (global.get $clipboard_fmt_counter)))
    (i32.load offset=4 (local.get $e)))

  ;; The name of a registered format, or 0. GetClipboardFormatName reads this.
  (func $clipfmt_name_of (param $id i32) (result i32)
    (local $i i32) (local $e i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $CLIPFORMAT_SLOTS)))
      (local.set $e (i32.add (global.get $CLIPFORMAT_TABLE)
        (i32.mul (local.get $i) (i32.const 8))))
      (if (i32.eqz (i32.load (local.get $e))) (then (br $done)))
      (if (i32.eq (i32.load offset=4 (local.get $e)) (local.get $id))
        (then (return (i32.load (local.get $e)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  (func $clipboard_register_format_a (param $name_g i32) (result i32)
    (local $id i32)
    (local.set $id (call $clipfmt_intern (local.get $name_g)))
    ;; The RTF payload has its own storage and its own id global; keep that
    ;; global pointing at the interned value so both agree.
    (if (i32.and (i32.ne (local.get $id) (i32.const 0))
                 (call $guest_str_is_rich_text_format_a (local.get $name_g)))
      (then (global.set $clipboard_rtf_format_id (local.get $id))))
    (local.get $id))

  (func $clipboard_register_format_w (param $name_g i32) (result i32)
    (local $ansi i32) (local $id i32)
    (if (call $guest_str_is_rich_text_format_w (local.get $name_g))
      (then (return (call $clipboard_get_rtf_format_id))))
    ;; Intern through the same ANSI table: a W registration and an A
    ;; registration of the same name must produce the same id.
    (local.set $ansi (call $clipfmt_wide_to_ansi (local.get $name_g)))
    (if (i32.eqz (local.get $ansi)) (then (return (i32.const 0))))
    (local.set $id (call $clipfmt_intern (local.get $ansi)))
    (call $heap_free (local.get $ansi))
    (local.get $id))

  ;; NUL-terminated UTF-16 to a freshly allocated ANSI copy. Format names are
  ;; ASCII in every app we have met; a character above 0xFF becomes '?'.
  (func $clipfmt_wide_to_ansi (param $src i32) (result i32)
    (local $len i32) (local $dst i32) (local $i i32) (local $ch i32)
    (block $count (loop $scan
      (br_if $count (i32.eqz (call $gl16
        (i32.add (local.get $src) (i32.shl (local.get $len) (i32.const 1))))))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (br $scan)))
    (local.set $dst (call $heap_alloc (i32.add (local.get $len) (i32.const 1))))
    (if (i32.eqz (local.get $dst)) (then (return (i32.const 0))))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (local.set $ch (call $gl16
        (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 1)))))
      (if (i32.gt_u (local.get $ch) (i32.const 0xFF))
        (then (local.set $ch (i32.const 63))))
      (call $gs8 (i32.add (local.get $dst) (local.get $i)) (local.get $ch))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (call $gs8 (i32.add (local.get $dst) (local.get $len)) (i32.const 0))
    (local.get $dst))

  (func $clipboard_clear_rtf_data
    (global.set $clipboard_rtf_len (i32.const 0))
    (if (global.get $clipboard_rtf_ptr)
      (then (call $gs8 (global.get $clipboard_rtf_ptr) (i32.const 0)))))

  (func $clipboard_clear_binary_data
    ;; RichEdit static objects can retain a CF_DIB HGLOBAL after the clipboard
    ;; changes. Keep binary snapshots alive for the WASM instance lifetime;
    ;; otherwise a later Copy/EmptyClipboard turns an existing inline image's
    ;; presentation into a dangling heap pointer. Instance teardown reclaims
    ;; the small bounded snapshots together with the rest of linear memory.
    (global.set $clipboard_binary_format (i32.const 0))
    (global.set $clipboard_binary_ptr (i32.const 0))
    (global.set $clipboard_binary_len (i32.const 0)))

  (func $clipboard_clear_all_data
    (global.set $clipboard_len (i32.const 0))
    (if (global.get $clipboard_ptr)
      (then (call $gs8 (global.get $clipboard_ptr) (i32.const 0))))
    (call $clipboard_clear_rtf_data)
    (call $clipboard_clear_binary_data)
    (call $ole_clipboard_release_owner)
    (call $richedit_clipboard_clear_format))

  (func $clipboard_store_binary_data (param $fmt i32) (param $src_g i32) (result i32)
    (local $size i32) (local $dst i32)
    (if (i32.or (i32.eqz (local.get $fmt)) (i32.eqz (local.get $src_g)))
      (then (return (i32.const 0))))
    (local.set $size (i32.sub (call $gl32 (i32.sub (local.get $src_g) (i32.const 4))) (i32.const 4)))
    (local.set $dst (call $heap_alloc (local.get $size)))
    (if (i32.eqz (local.get $dst)) (then (return (i32.const 0))))
    (memory.copy (call $g2w (local.get $dst)) (call $g2w (local.get $src_g)) (local.get $size))
    (global.set $clipboard_binary_format (local.get $fmt))
    (global.set $clipboard_binary_ptr (local.get $dst))
    (global.set $clipboard_binary_len (local.get $size))
    (local.get $dst))

  (func $clipboard_store_rtf_data (param $src_g i32) (result i32)
    (local $len i32) (local $need i32) (local $cap i32)
    (if (i32.eqz (local.get $src_g)) (then (return (i32.const 0))))
    (local.set $len (call $guest_strlen (local.get $src_g)))
    (local.set $need (i32.add (local.get $len) (i32.const 1)))
    (if (i32.gt_u (local.get $need) (global.get $clipboard_rtf_cap))
      (then
        (if (global.get $clipboard_rtf_ptr)
          (then
            (call $heap_free (global.get $clipboard_rtf_ptr))
            (global.set $clipboard_rtf_ptr (i32.const 0))))
        (local.set $cap
          (i32.and (i32.add (local.get $need) (i32.const 63)) (i32.const -64)))
        (global.set $clipboard_rtf_ptr (call $heap_alloc (local.get $cap)))
        (global.set $clipboard_rtf_cap (local.get $cap))))
    (if (i32.eqz (global.get $clipboard_rtf_ptr))
      (then
        (global.set $clipboard_rtf_len (i32.const 0))
        (return (i32.const 0))))
    (drop (call $clipboard_get_rtf_format_id))
    (call $memcpy
      (call $g2w (global.get $clipboard_rtf_ptr))
      (call $g2w (local.get $src_g))
      (local.get $need))
    (global.set $clipboard_rtf_len (local.get $len))
    (global.get $clipboard_rtf_ptr))

  (func $clipboard_rtf_append_byte
        (param $dst_w i32) (param $pos i32) (param $ch i32) (result i32)
    (i32.store8 (i32.add (local.get $dst_w) (local.get $pos)) (local.get $ch))
    (i32.add (local.get $pos) (i32.const 1)))

  (func $clipboard_build_basic_rtf_from_text_clipboard
    (local $need i32) (local $cap i32) (local $dst_w i32)
    (local $pos i32) (local $i i32) (local $ch i32) (local $next i32)
    (if (i32.or (i32.eqz (global.get $clipboard_ptr)) (i32.eqz (global.get $clipboard_len)))
      (then (call $clipboard_clear_rtf_data) (return)))
    (local.set $need
      (i32.add (i32.mul (global.get $clipboard_len) (i32.const 5)) (i32.const 64)))
    (if (i32.gt_u (local.get $need) (global.get $clipboard_rtf_cap))
      (then
        (if (global.get $clipboard_rtf_ptr)
          (then
            (call $heap_free (global.get $clipboard_rtf_ptr))
            (global.set $clipboard_rtf_ptr (i32.const 0))))
        (local.set $cap
          (i32.and (i32.add (local.get $need) (i32.const 63)) (i32.const -64)))
        (global.set $clipboard_rtf_ptr (call $heap_alloc (local.get $cap)))
        (global.set $clipboard_rtf_cap (local.get $cap))))
    (if (i32.eqz (global.get $clipboard_rtf_ptr))
      (then (global.set $clipboard_rtf_len (i32.const 0)) (return)))
    (drop (call $clipboard_get_rtf_format_id))
    (local.set $dst_w (call $g2w (global.get $clipboard_rtf_ptr)))
    ;; "{\\rtf1\\ansi "
    (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 123)))
    (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 92)))
    (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 114)))
    (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 116)))
    (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 102)))
    (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 49)))
    (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 92)))
    (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 97)))
    (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 110)))
    (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 115)))
    (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 105)))
    (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 32)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $clipboard_len)))
      (local.set $ch (call $gl8 (i32.add (global.get $clipboard_ptr) (local.get $i))))
      (if (i32.eq (local.get $ch) (i32.const 13))
        (then
          (local.set $next (i32.const 0))
          (if (i32.lt_u (i32.add (local.get $i) (i32.const 1)) (global.get $clipboard_len))
            (then
              (local.set $next
                (call $gl8 (i32.add
                  (global.get $clipboard_ptr)
                  (i32.add (local.get $i) (i32.const 1)))))))
          (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 92)))
          (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 112)))
          (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 97)))
          (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 114)))
          (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 32)))
          (local.set $i
            (i32.add (local.get $i)
              (select (i32.const 2) (i32.const 1) (i32.eq (local.get $next) (i32.const 10)))))
          (br $scan)))
      (if (i32.eq (local.get $ch) (i32.const 10))
        (then
          (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 92)))
          (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 112)))
          (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 97)))
          (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 114)))
          (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 32)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $scan)))
      (if (i32.or
            (i32.eq (local.get $ch) (i32.const 92))
            (i32.or
              (i32.eq (local.get $ch) (i32.const 123))
              (i32.eq (local.get $ch) (i32.const 125))))
        (then
          (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 92)))
          (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (local.get $ch))))
        (else
          (if (i32.ge_u (local.get $ch) (i32.const 128))
            (then
              (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 92)))
              (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 39)))
              (local.set $pos
                (call $clipboard_rtf_append_byte
                  (local.get $dst_w) (local.get $pos)
                  (call $clipboard_hex_nibble_ascii (i32.shr_u (local.get $ch) (i32.const 4)))))
              (local.set $pos
                (call $clipboard_rtf_append_byte
                  (local.get $dst_w) (local.get $pos)
                  (call $clipboard_hex_nibble_ascii (i32.and (local.get $ch) (i32.const 15))))))
            (else
              (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (local.get $ch)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.set $pos (call $clipboard_rtf_append_byte (local.get $dst_w) (local.get $pos) (i32.const 125)))
    (i32.store8 (i32.add (local.get $dst_w) (local.get $pos)) (i32.const 0))
    (global.set $clipboard_rtf_len (local.get $pos)))

  (func $clipboard_count_formats (result i32)
    (local $n i32)
    (if (i32.gt_u (global.get $clipboard_len) (i32.const 0))
      (then (local.set $n (i32.add (local.get $n) (i32.const 1)))))
    (if (i32.gt_u (global.get $clipboard_rtf_len) (i32.const 0))
      (then (local.set $n (i32.add (local.get $n) (i32.const 1)))))
    (if (i32.and
          (i32.ne (global.get $clipboard_binary_format) (i32.const 0))
          (i32.ne (global.get $clipboard_binary_ptr) (i32.const 0)))
      (then (local.set $n (i32.add (local.get $n) (i32.const 1)))))
    ;; A data object left by OleSetClipboard is clipboard content too. Real GDI
    ;; publishes that object's formats on the clipboard with delayed rendering,
    ;; so they count; we do not enumerate its FORMATETCs, and one is enough for
    ;; what this number is asked for — every caller so far uses it as "is the
    ;; clipboard empty". WordPad gates both Paste and Paste Special on it, and
    ;; RichEdit's Copy publishes nothing else, so returning zero here disabled
    ;; pasting into the app that had just copied.
    (if (i32.ne (global.get $clipboard_ole_data_object) (i32.const 0))
      (then (local.set $n (i32.add (local.get $n) (i32.const 1)))))
    (local.get $n))

  (func $clipboard_is_format_available (param $fmt i32) (result i32)
    (if (i32.and
          (i32.or (i32.eq (local.get $fmt) (i32.const 1))  ;; CF_TEXT
                  (i32.eq (local.get $fmt) (i32.const 7))) ;; CF_OEMTEXT
          (i32.gt_u (global.get $clipboard_len) (i32.const 0)))
      (then (return (i32.const 1))))
    (if (i32.and
          (i32.eq (local.get $fmt) (global.get $clipboard_binary_format))
          (i32.ne (global.get $clipboard_binary_ptr) (i32.const 0)))
      (then (return (i32.const 1))))
    (if (i32.and
          (i32.ne (global.get $clipboard_rtf_format_id) (i32.const 0))
          (i32.and
            (i32.eq (local.get $fmt) (global.get $clipboard_rtf_format_id))
            (i32.gt_u (global.get $clipboard_rtf_len) (i32.const 0))))
      (then (return (i32.const 1))))
    (i32.const 0))

  (func $clipboard_get_data_handle (param $fmt i32) (result i32)
    (if (i32.and
          (i32.or (i32.eq (local.get $fmt) (i32.const 1))  ;; CF_TEXT
                  (i32.eq (local.get $fmt) (i32.const 7))) ;; CF_OEMTEXT
          (i32.gt_u (global.get $clipboard_len) (i32.const 0)))
      (then (return (global.get $clipboard_ptr))))
    (if (i32.and
          (i32.ne (global.get $clipboard_rtf_format_id) (i32.const 0))
          (i32.and
            (i32.eq (local.get $fmt) (global.get $clipboard_rtf_format_id))
            (i32.gt_u (global.get $clipboard_rtf_len) (i32.const 0))))
      (then (return (global.get $clipboard_rtf_ptr))))
    (if (i32.and
          (i32.eq (local.get $fmt) (global.get $clipboard_binary_format))
          (i32.ne (global.get $clipboard_binary_ptr) (i32.const 0)))
      (then (return (global.get $clipboard_binary_ptr))))
    (i32.const 0))

  (func $richedit_clipboard_clear_format
    (global.set $clipboard_richedit_cf_valid (i32.const 0))
    (global.set $clipboard_richedit_pf_valid (i32.const 0)))

  (func $richedit_clipboard_capture_format (param $hwnd i32)
    (local $cf_g i32) (local $cf_w i32)
    (local $pf_g i32) (local $pf_w i32)
    (call $richedit_clipboard_clear_format)
    ;; CHARFORMATA/CHARFORMAT2A prefix snapshot. Keep only app-useful basic
    ;; fields; do not replay offset/protected/link sentinels from EM_GETCHARFORMAT.
    (if (i32.eqz (global.get $clipboard_richedit_cf_ptr))
      (then
        (global.set $clipboard_richedit_cf_ptr
          (call $heap_alloc (i32.const 128)))))
    (local.set $cf_g (global.get $clipboard_richedit_cf_ptr))
    (if (local.get $cf_g)
      (then
        (local.set $cf_w (call $g2w (local.get $cf_g)))
        (call $zero_memory (local.get $cf_w) (i32.const 128))
        (i32.store (local.get $cf_w) (i32.const 60)) ;; CHARFORMATA cbSize
        (drop (call $wnd_send_message
          (local.get $hwnd) (i32.const 0x043A) (i32.const 1) (local.get $cf_g))) ;; EM_GETCHARFORMAT, SCF_SELECTION
        (call $richedit_patch_get_charformat_message
          (local.get $hwnd) (i32.const 0x043A) (local.get $cf_g))
        (i32.store offset=4 (local.get $cf_w)
          (i32.and (i32.load offset=4 (local.get $cf_w)) (i32.const 0xE0000007))) ;; CFM_SIZE|COLOR|FACE|B/I/U/S
        (if (i32.load offset=4 (local.get $cf_w))
          (then (global.set $clipboard_richedit_cf_valid (i32.const 1))))))
    ;; PARAFORMAT2A snapshot. Replay only the fields this bridge explicitly
    ;; supports so copied default/version-specific mask bits do not leak.
    (if (i32.eqz (global.get $clipboard_richedit_pf_ptr))
      (then
        (global.set $clipboard_richedit_pf_ptr
          (call $heap_alloc (i32.const 256)))))
    (local.set $pf_g (global.get $clipboard_richedit_pf_ptr))
    (if (local.get $pf_g)
      (then
        (local.set $pf_w (call $g2w (local.get $pf_g)))
        (call $zero_memory (local.get $pf_w) (i32.const 256))
        (i32.store (local.get $pf_w) (i32.const 188)) ;; PARAFORMAT2A cbSize
        (drop (call $wnd_send_message
          (local.get $hwnd) (i32.const 0x043D) (i32.const 0) (local.get $pf_g))) ;; EM_GETPARAFORMAT
        (call $richedit_patch_get_paraformat_message
          (local.get $hwnd) (i32.const 0x043D) (local.get $pf_g))
        (i32.store offset=4 (local.get $pf_w)
          (i32.and (i32.load offset=4 (local.get $pf_w)) (i32.const 0x0000003F))) ;; PFM_* basic fields
        (if (i32.load offset=4 (local.get $pf_w))
          (then (global.set $clipboard_richedit_pf_valid (i32.const 1))))))
  )

  (func $richedit_clipboard_apply_format_to_selection (param $hwnd i32)
    (if (global.get $clipboard_richedit_cf_valid)
      (then
        (call $richedit_note_charformat_message
          (local.get $hwnd) (i32.const 0x0444) (i32.const 1)
          (global.get $clipboard_richedit_cf_ptr)) ;; EM_SETCHARFORMAT
        (drop (call $wnd_send_message
          (local.get $hwnd) (i32.const 0x0444) (i32.const 1)
          (global.get $clipboard_richedit_cf_ptr))))) ;; SCF_SELECTION
    (if (global.get $clipboard_richedit_pf_valid)
      (then
        (call $richedit_note_paraformat_message
          (local.get $hwnd) (i32.const 0x0447)
          (global.get $clipboard_richedit_pf_ptr)) ;; EM_SETPARAFORMAT
        (drop (call $wnd_send_message
          (local.get $hwnd) (i32.const 0x0447) (i32.const 0)
          (global.get $clipboard_richedit_pf_ptr))))))

  ;; RichEdit's ANSI text surface flattens an inline object to one space. Its
  ;; UTF-16 selection surface retains the standard U+FFFC object replacement
  ;; character, allowing a real selected space to stay ordinary text.
  (func $wordpad_richedit_selection_is_object (param $hwnd i32) (result i32)
    (local $gt_g i32) (local $text_g i32) (local $n i32) (local $is_object i32)
    (local.set $gt_g (call $heap_alloc (i32.const 20)))
    (local.set $text_g (call $heap_alloc (i32.const 8)))
    (if (i32.or (i32.eqz (local.get $gt_g)) (i32.eqz (local.get $text_g)))
      (then
        (if (local.get $gt_g) (then (call $heap_free (local.get $gt_g))))
        (if (local.get $text_g) (then (call $heap_free (local.get $text_g))))
        (return (i32.const 0))))
    (call $zero_memory (call $g2w (local.get $gt_g)) (i32.const 20))
    (call $zero_memory (call $g2w (local.get $text_g)) (i32.const 8))
    (call $gs32 (local.get $gt_g) (i32.const 8)) ;; GETTEXTEX.cb, bytes
    (call $gs32 (i32.add (local.get $gt_g) (i32.const 4)) (i32.const 2)) ;; GT_SELECTION
    (call $gs32 (i32.add (local.get $gt_g) (i32.const 8)) (i32.const 1200)) ;; UTF-16LE
    (local.set $n
      (call $wnd_send_message
        (local.get $hwnd) (i32.const 0x045E) (local.get $gt_g) (local.get $text_g))) ;; EM_GETTEXTEX
    (local.set $is_object
      (i32.and
        (i32.eq (local.get $n) (i32.const 1))
        (i32.eq (call $gl16 (local.get $text_g)) (i32.const 0xFFFC))))
    (call $heap_free (local.get $gt_g))
    (call $heap_free (local.get $text_g))
    (local.get $is_object))

  (func $native_text_copy_selection_to_clipboard (param $hwnd i32) (result i32)
    (local $text_len i32) (local $cap i32) (local $text_g i32)
    (local $scratch_g i32) (local $lo i32) (local $hi i32) (local $tmp i32)
    (local $a i32) (local $b i32) (local $len i32) (local $need i32)
    (local $new_cap i32)
    (local $saved_dib i32) (local $selected_object i32)
    ;; Let native RichEdit exercise its normal copy path first, then keep the
    ;; durable emulator-owned text/RTF snapshots below. RichEdit's IDataObject
    ;; is DLL-private and tied to the source control, so it must not remain the
    ;; active clipboard owner after a later Clear/Cut destroys that source.
    ;; A static picture originally entered through CF_DIB. Snapshot that
    ;; value before WM_COPY replaces clipboard ownership; if the selection is
    ;; the one-character object placeholder, restore the eager DIB afterward.
    ;; This makes Cut value-based instead of leaving a clipboard IDataObject
    ;; tied to an object that is about to be deleted from the source control.
    (if (i32.and
          (i32.eq (global.get $clipboard_binary_format) (i32.const 8))
          (i32.ne (global.get $clipboard_binary_ptr) (i32.const 0)))
      (then
        (local.set $saved_dib
          (call $ole_copy_hglobal (global.get $clipboard_binary_ptr)))))
    (call $clipboard_clear_all_data)
    (local.set $text_len
      (call $wnd_send_message (local.get $hwnd) (i32.const 0x000E) (i32.const 0) (i32.const 0))) ;; WM_GETTEXTLENGTH
    (if (i32.lt_s (local.get $text_len) (i32.const 0))
      (then (local.set $text_len (i32.const 0))))
    (if (i32.gt_u (local.get $text_len) (i32.const 65534))
      (then (local.set $text_len (i32.const 65534))))
    (local.set $cap (i32.add (local.get $text_len) (i32.const 2)))
    (local.set $text_g (call $heap_alloc (local.get $cap)))
    (local.set $scratch_g (call $heap_alloc (i32.const 8)))
    (if (i32.or (i32.eqz (local.get $text_g)) (i32.eqz (local.get $scratch_g)))
      (then
        (if (local.get $text_g) (then (call $heap_free (local.get $text_g))))
        (if (local.get $scratch_g) (then (call $heap_free (local.get $scratch_g))))
        (return (i32.const 0))))
    (call $gs32 (local.get $scratch_g) (i32.const 0))
    (call $gs32 (i32.add (local.get $scratch_g) (i32.const 4)) (i32.const 0))
    (local.set $text_len
      (call $wnd_send_message (local.get $hwnd) (i32.const 0x000D) (local.get $cap) (local.get $text_g))) ;; WM_GETTEXT
    (if (i32.lt_s (local.get $text_len) (i32.const 0))
      (then (local.set $text_len (i32.const 0))))
    (if (i32.gt_u (local.get $text_len) (i32.sub (local.get $cap) (i32.const 1)))
      (then (local.set $text_len (i32.sub (local.get $cap) (i32.const 1)))))
    (drop (call $wnd_send_message
      (local.get $hwnd) (i32.const 0x00B0)
      (local.get $scratch_g)
      (i32.add (local.get $scratch_g) (i32.const 4)))) ;; EM_GETSEL
    (local.set $lo (call $gl32 (local.get $scratch_g)))
    (local.set $hi (call $gl32 (i32.add (local.get $scratch_g) (i32.const 4))))
    (if (i32.gt_u (local.get $lo) (local.get $hi))
      (then
        (local.set $tmp (local.get $lo))
        (local.set $lo (local.get $hi))
        (local.set $hi (local.get $tmp))))
    (local.set $a
      (call $native_text_logical_to_string_index
        (local.get $text_g) (local.get $text_len) (local.get $lo)))
    (local.set $b
      (call $native_text_logical_to_string_index
        (local.get $text_g) (local.get $text_len) (local.get $hi)))
    (if (i32.lt_u (local.get $b) (local.get $a))
      (then (local.set $b (local.get $a))))
    (local.set $len (i32.sub (local.get $b) (local.get $a)))
    (if (i32.eq (local.get $len) (i32.const 1))
      (then
        (local.set $selected_object
          (call $wordpad_richedit_selection_is_object (local.get $hwnd)))))
    ;; Plain/rich text is captured directly below. Do not invoke RichEdit's
    ;; OLE-backed WM_COPY path for it: the native IDataObject is transient and
    ;; the emulator-owned CF_TEXT/RTF snapshots are the durable clipboard.
    ;; Keep native WM_COPY only for a non-DIB inline object, whose data formats
    ;; cannot be represented by the text snapshot.
    (if (i32.and
          (i32.eqz (local.get $saved_dib))
          (local.get $selected_object))
      (then
        (drop (call $wnd_send_message
          (local.get $hwnd) (i32.const 0x0301) (i32.const 0) (i32.const 0))) ;; WM_COPY
        ;; OleSetClipboard above may have published a borrowed RichEdit
        ;; IDataObject. The value snapshots below are the durable clipboard.
        (call $ole_clipboard_release_owner)))
    (if (local.get $len)
      (then
        (local.set $need (i32.add (local.get $len) (i32.const 1)))
        (if (i32.gt_u (local.get $need) (global.get $clipboard_cap))
          (then
            (if (global.get $clipboard_ptr)
              (then
                (call $heap_free (global.get $clipboard_ptr))
                (global.set $clipboard_ptr (i32.const 0))))
            (local.set $new_cap
              (i32.and (i32.add (local.get $need) (i32.const 63)) (i32.const -64)))
            (global.set $clipboard_ptr (call $heap_alloc (local.get $new_cap)))
            (global.set $clipboard_cap (local.get $new_cap))))
        (if (global.get $clipboard_ptr)
          (then
            (call $memcpy
              (call $g2w (global.get $clipboard_ptr))
              (i32.add (call $g2w (local.get $text_g)) (local.get $a))
              (local.get $len))
            (call $gs8 (i32.add (global.get $clipboard_ptr) (local.get $len)) (i32.const 0))
            (global.set $clipboard_len (local.get $len))
            (call $richedit_clipboard_capture_format (local.get $hwnd))
            (call $clipboard_build_basic_rtf_from_text_clipboard)))))
    (if (i32.and
          (i32.ne (local.get $saved_dib) (i32.const 0))
          (local.get $selected_object))
      (then
        ;; Do not advertise the ANSI/RTF one-space projection beside CF_DIB.
        ;; RichEdit prefers RTF and would paste that placeholder as text.
        (global.set $clipboard_len (i32.const 0))
        (if (global.get $clipboard_ptr)
          (then (call $gs8 (global.get $clipboard_ptr) (i32.const 0))))
        (call $clipboard_clear_rtf_data)
        (call $richedit_clipboard_clear_format)
        (call $ole_clipboard_release_owner)
        (global.set $clipboard_binary_format (i32.const 8))
        (global.set $clipboard_binary_ptr (local.get $saved_dib))
        (global.set $clipboard_binary_len
          (i32.sub
            (call $gl32 (i32.sub (local.get $saved_dib) (i32.const 4)))
            (i32.const 4)))
        (local.set $saved_dib (i32.const 0))))
    (if (local.get $saved_dib) (then (call $heap_free (local.get $saved_dib))))
    (call $heap_free (local.get $text_g))
    (call $heap_free (local.get $scratch_g))
    (i32.const 1))

  (func $wordpad_richedit_replace_empty (param $hwnd i32) (result i32)
    (drop (call $wnd_send_message
      (local.get $hwnd) (i32.const 0x0303) (i32.const 0) (i32.const 0))) ;; WM_CLEAR
    (call $paint_flag_set_inv (local.get $hwnd))
    (i32.const 1))

  (func $wordpad_richedit_paste_clipboard (param $hwnd i32) (result i32)
    (local $paste_g i32) (local $need i32) (local $scratch_g i32)
    (local $insert_lo i32) (local $insert_hi i32) (local $tmp i32)
    (local $post_start i32) (local $post_end i32)
    ;; Native RichEdit consumes its own IDataObject with full run/object
    ;; fidelity. A USER CF_DIB seeded by the host also needs the native paste
    ;; path so RichEdit can construct the embedded static object.
    (if (i32.or
          (i32.ne (global.get $clipboard_ole_data_object) (i32.const 0))
          (i32.and
            (i32.eq (global.get $clipboard_binary_format) (i32.const 8))
            (i32.ne (global.get $clipboard_binary_ptr) (i32.const 0))))
      (then
        (drop (call $wnd_send_message
          (local.get $hwnd) (i32.const 0x0302) (i32.const 0) (i32.const 0))) ;; WM_PASTE
        (call $paint_flag_set_inv (local.get $hwnd))
        (return (i32.const 1))))
    (if (i32.or (i32.eqz (global.get $clipboard_ptr)) (i32.eqz (global.get $clipboard_len)))
      (then (return (i32.const 1))))
    (local.set $need (i32.add (global.get $clipboard_len) (i32.const 1)))
    (local.set $paste_g (call $heap_alloc (local.get $need)))
    (if (i32.eqz (local.get $paste_g)) (then (return (i32.const 0))))
    (local.set $scratch_g (call $heap_alloc (i32.const 8)))
    (if (i32.eqz (local.get $scratch_g))
      (then
        (call $heap_free (local.get $paste_g))
        (return (i32.const 0))))
    (call $gs32 (local.get $scratch_g) (i32.const 0))
    (call $gs32 (i32.add (local.get $scratch_g) (i32.const 4)) (i32.const 0))
    (drop (call $wnd_send_message
      (local.get $hwnd) (i32.const 0x00B0)
      (local.get $scratch_g)
      (i32.add (local.get $scratch_g) (i32.const 4)))) ;; EM_GETSEL before paste
    (local.set $insert_lo (call $gl32 (local.get $scratch_g)))
    (local.set $tmp (call $gl32 (i32.add (local.get $scratch_g) (i32.const 4))))
    (if (i32.lt_u (local.get $tmp) (local.get $insert_lo))
      (then (local.set $insert_lo (local.get $tmp))))
    (call $memcpy
      (call $g2w (local.get $paste_g))
      (call $g2w (global.get $clipboard_ptr))
      (global.get $clipboard_len))
    (call $gs8 (i32.add (local.get $paste_g) (global.get $clipboard_len)) (i32.const 0))
    (drop (call $wnd_send_message
      (local.get $hwnd) (i32.const 0x00C2) (i32.const 1) (local.get $paste_g))) ;; EM_REPLACESEL
    ;; Do not derive the inserted selection end from bytes. RichEdit owns the
    ;; logical position semantics for CRLF and ANSI high-byte text; query it
    ;; after EM_REPLACESEL and format exactly that inserted range.
    (call $gs32 (local.get $scratch_g) (i32.const 0))
    (call $gs32 (i32.add (local.get $scratch_g) (i32.const 4)) (i32.const 0))
    (drop (call $wnd_send_message
      (local.get $hwnd) (i32.const 0x00B0)
      (local.get $scratch_g)
      (i32.add (local.get $scratch_g) (i32.const 4)))) ;; EM_GETSEL after paste
    (local.set $post_start (call $gl32 (local.get $scratch_g)))
    (local.set $post_end (call $gl32 (i32.add (local.get $scratch_g) (i32.const 4))))
    (local.set $insert_hi (local.get $post_start))
    (if (i32.gt_u (local.get $post_end) (local.get $insert_hi))
      (then (local.set $insert_hi (local.get $post_end))))
    (if (i32.and
          (i32.gt_u (local.get $insert_hi) (local.get $insert_lo))
          (i32.or
            (global.get $clipboard_richedit_cf_valid)
            (global.get $clipboard_richedit_pf_valid)))
      (then
        (drop (call $wnd_send_message
          (local.get $hwnd) (i32.const 0x00B1)
          (local.get $insert_lo) (local.get $insert_hi))) ;; EM_SETSEL inserted range
        (call $richedit_clipboard_apply_format_to_selection (local.get $hwnd))
        (drop (call $wnd_send_message
          (local.get $hwnd) (i32.const 0x00B1)
          (local.get $post_start) (local.get $post_end))))) ;; restore caret/selection
    (call $heap_free (local.get $paste_g))
    (call $heap_free (local.get $scratch_g))
    (call $paint_flag_set_inv (local.get $hwnd))
    (i32.const 1))

  (func $wordpad_richedit_plain_edit_command (param $hwnd i32) (param $op i32) (result i32)
    (if (i32.eq (local.get $op) (i32.const 1)) ;; Select All
      (then
        (drop (call $wnd_send_message
          (local.get $hwnd) (i32.const 0x00B1) (i32.const 0) (i32.const -1))) ;; EM_SETSEL
        (call $paint_flag_set_inv (local.get $hwnd))
        (return (i32.const 1))))
    (if (i32.eq (local.get $op) (i32.const 3)) ;; Copy
      (then
        (drop (call $native_text_copy_selection_to_clipboard (local.get $hwnd)))
        (return (i32.const 1))))
    (if (i32.eq (local.get $op) (i32.const 4)) ;; Paste
      (then
        (drop (call $wordpad_richedit_paste_clipboard (local.get $hwnd)))
        (return (i32.const 1))))
    (if (i32.eq (local.get $op) (i32.const 2)) ;; Cut
      (then
        (drop (call $native_text_copy_selection_to_clipboard (local.get $hwnd)))
        (drop (call $wordpad_richedit_replace_empty (local.get $hwnd)))
        (return (i32.const 1))))
    (if (i32.eq (local.get $op) (i32.const 5)) ;; Clear
      (then
        (drop (call $wordpad_richedit_replace_empty (local.get $hwnd)))
        (return (i32.const 1))))
    (i32.const 0))

  (func $menu_try_wordpad_color_command (param $id i32) (result i32)
    (local $idx i32) (local $target i32) (local $cf_g i32) (local $cf_w i32)
    (local $color i32)
    (if (i32.or
          (i32.lt_u (local.get $id) (i32.const 0x800E))
          (i32.gt_u (local.get $id) (i32.const 0x801E)))
      (then (return (i32.const 0))))
    (local.set $target (call $wordpad_richedit_target))
    (if (i32.eqz (local.get $target)) (then (return (i32.const 0))))
    (local.set $idx (i32.sub (local.get $id) (i32.const 0x800E)))
    (local.set $cf_g (call $heap_alloc (i32.const 64)))
    (if (i32.eqz (local.get $cf_g)) (then (return (i32.const 0))))
    (local.set $cf_w (call $g2w (local.get $cf_g)))
    (call $zero_memory (local.get $cf_w) (i32.const 64))
    (i32.store         (local.get $cf_w) (i32.const 60))          ;; cbSize
    (i32.store offset=4 (local.get $cf_w) (i32.const 0x40000000)) ;; CFM_COLOR
    (if (i32.eq (local.get $idx) (i32.const 16))
      (then
        (i32.store offset=8  (local.get $cf_w) (i32.const 0x40000000)) ;; CFE_AUTOCOLOR
        (i32.store offset=20 (local.get $cf_w) (i32.const 0)))
      (else
        (local.set $color (call $wordpad_colorref_for_index (local.get $idx)))
        (i32.store offset=8  (local.get $cf_w) (i32.const 0))
        (i32.store offset=20 (local.get $cf_w) (local.get $color))))
    (drop (call $wnd_send_message
      (local.get $target) (i32.const 0x0444) (i32.const 1) (local.get $cf_g)))
    (call $heap_free (local.get $cf_g))
    (call $paint_flag_set_inv (local.get $target))
    (i32.const 1))

  (func $menu_try_edit_command (param $id i32) (result i32)
    (local $target i32) (local $msg i32) (local $lParam i32) (local $op i32)
    (if (call $menu_try_wordpad_color_command (local.get $id))
      (then (return (i32.const 1))))
    (if (i32.or
          (i32.eq (local.get $id) (i32.const 7))
          (i32.eq (local.get $id) (i32.const 0xE12A))) ;; MFC ID_EDIT_SELECT_ALL
      (then
        (local.set $op (i32.const 1))
        (local.set $msg (i32.const 0x00B1)) ;; EM_SETSEL
        (local.set $lParam (i32.const -1)))
      (else
        (if (i32.or
              (i32.eq (local.get $id) (i32.const 768))
              (i32.eq (local.get $id) (i32.const 0xE123))) ;; MFC ID_EDIT_CUT
          (then
            (local.set $op (i32.const 2))
            (local.set $msg (i32.const 0x0300))) ;; WM_CUT
          (else
            (if (i32.or
                  (i32.eq (local.get $id) (i32.const 769))
                  (i32.eq (local.get $id) (i32.const 0xE122))) ;; MFC ID_EDIT_COPY
              (then
                (local.set $op (i32.const 3))
                (local.set $msg (i32.const 0x0301))) ;; WM_COPY
              (else
                (if (i32.or
                      (i32.eq (local.get $id) (i32.const 770))
                      (i32.eq (local.get $id) (i32.const 0xE125))) ;; MFC ID_EDIT_PASTE
                  (then
                    (local.set $op (i32.const 4))
                    (local.set $msg (i32.const 0x0302))) ;; WM_PASTE
                  (else
                    (if (i32.or
                          (i32.eq (local.get $id) (i32.const 771))
                          (i32.eq (local.get $id) (i32.const 0xE120))) ;; MFC ID_EDIT_CLEAR
                      (then
                        (local.set $op (i32.const 5))
                        (local.set $msg (i32.const 0x0303))) ;; WM_CLEAR
                      (else (return (i32.const 0))))))))))))
    ;; WordPad's native RichEdit enters an OLE clipboard/storage path for
    ;; WM_COPY/WM_CUT. Until rich clipboard fidelity exists, keep menu commands
    ;; app-useful by bridging plain-text behavior with RichEdit text messages,
    ;; matching the renderer Ctrl+C/X/V bridge.
    (local.set $target (call $wordpad_richedit_target))
    (if (local.get $target)
      (then
        (drop (call $wordpad_richedit_plain_edit_command (local.get $target) (local.get $op)))
        (return (i32.const 1))))
    (local.set $target (call $edit_command_target))
    (if (i32.eqz (local.get $target)) (then (return (i32.const 0))))
    (drop (call $wnd_send_message (local.get $target) (local.get $msg) (i32.const 0) (local.get $lParam)))
    (call $paint_flag_set_inv (local.get $target))
    (i32.const 1))

  (func $client_rect_reset_slot (param $slot i32)
    (local $rec i32)
    (local.set $rec (i32.add (global.get $CLIENT_RECT) (i32.mul (local.get $slot) (i32.const 16))))
    (i32.store          (local.get $rec) (i32.const 0))
    (i32.store offset=4  (local.get $rec) (i32.const 0))
    (i32.store offset=8  (local.get $rec) (i32.const 0))
    (i32.store offset=12 (local.get $rec) (i32.const 0)))

  ;; ---- WAT-owned window DC clipping -------------------------------------
  ;; These helpers build the Win32 visible clip for window DCs. JS owns only
  ;; the target canvas and applies the resulting DC clip region.

  ;; Packed client width|height straight out of the WM_NCCALCSIZE-written client
  ;; rect. Zero means "no client rect recorded for this window yet", which is
  ;; the only case in which asking the host is worth a round trip.
  ;;
  ;; This exists because the host round trip was a loop back into ourselves.
  ;; host_imports' get_window_client_size answers by calling the WAT export
  ;; get_client_rect_wh first and only falls back to the renderer's own
  ;; geometry, so a top-level window DC's clip was resolved WAT -> JS -> WAT for
  ;; a value WAT already had. It is asked once per scanline, via
  ;; $gdi_clip_row_resolve -> $gdi_dc_target_size, and on CORBIS.SCR that one
  ;; import was 1196201 of 1200000 host calls -- around 60 crossings per
  ;; emulated x86 instruction.
  (func $client_rect_wh_packed (param $hwnd i32) (result i32)
    (i32.or
      (i32.and
        (i32.sub (call $client_rect_get_r (local.get $hwnd))
          (call $client_rect_get_l (local.get $hwnd)))
        (i32.const 0xFFFF))
      (i32.shl
        (i32.sub (call $client_rect_get_b (local.get $hwnd))
          (call $client_rect_get_t (local.get $hwnd)))
        (i32.const 16))))

  (func $wnd_client_w_for_clip (param $hwnd i32) (result i32)
    (local $style i32) (local $sz i32)
    (local $cl i32) (local $cr i32)
    (if (i32.eqz (local.get $hwnd)) (then (return (i32.const 0))))
    (local.set $style (call $wnd_get_style (local.get $hwnd)))
    (if (i32.and (local.get $style) (i32.const 0x40000000)) ;; WS_CHILD
      (then
        (local.set $cl (call $client_rect_get_l (local.get $hwnd)))
        (local.set $cr (call $client_rect_get_r (local.get $hwnd)))
        (if (i32.gt_s (local.get $cr) (local.get $cl))
          (then (return (i32.sub (local.get $cr) (local.get $cl)))))
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (return (i32.and (local.get $sz) (i32.const 0xFFFF)))))
    (local.set $sz (call $client_rect_wh_packed (local.get $hwnd)))
    (if (local.get $sz)
      (then (return (i32.and (local.get $sz) (i32.const 0xFFFF)))))
    (local.set $sz (call $host_get_window_client_size (local.get $hwnd)))
    (i32.and (local.get $sz) (i32.const 0xFFFF)))

  (func $wnd_client_h_for_clip (param $hwnd i32) (result i32)
    (local $style i32) (local $sz i32)
    (local $ct i32) (local $cb i32)
    (if (i32.eqz (local.get $hwnd)) (then (return (i32.const 0))))
    (local.set $style (call $wnd_get_style (local.get $hwnd)))
    (if (i32.and (local.get $style) (i32.const 0x40000000)) ;; WS_CHILD
      (then
        (local.set $ct (call $client_rect_get_t (local.get $hwnd)))
        (local.set $cb (call $client_rect_get_b (local.get $hwnd)))
        (if (i32.gt_s (local.get $cb) (local.get $ct))
          (then (return (i32.sub (local.get $cb) (local.get $ct)))))
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (return (i32.shr_u (local.get $sz) (i32.const 16)))))
    (local.set $sz (call $client_rect_wh_packed (local.get $hwnd)))
    (if (local.get $sz)
      (then (return (i32.shr_u (local.get $sz) (i32.const 16)))))
    (local.set $sz (call $host_get_window_client_size (local.get $hwnd)))
    (i32.shr_u (local.get $sz) (i32.const 16)))

  (func $dc_clip_to_parent_client (param $hdc i32) (param $hwnd i32)
    (local $current i32) (local $parent i32) (local $x i32) (local $y i32)
    (local $pw i32) (local $ph i32)
    (local.set $current (local.get $hwnd))
    (block $done (loop $ancestors
      (br_if $done (i32.eqz (i32.and
        (call $wnd_get_style (local.get $current)) (i32.const 0x40000000)))) ;; WS_CHILD
      (local.set $parent (call $wnd_get_parent (local.get $current)))
      (br_if $done (i32.eqz (local.get $parent)))
      (local.set $x (i32.add (local.get $x) (call $ctrl_get_x_s (local.get $current))))
      (local.set $y (i32.add (local.get $y) (call $ctrl_get_y_s (local.get $current))))
      (local.set $pw (call $wnd_client_w_for_clip (local.get $parent)))
      (local.set $ph (call $wnd_client_h_for_clip (local.get $parent)))
      (if (i32.and (i32.gt_s (local.get $pw) (i32.const 0))
                   (i32.gt_s (local.get $ph) (i32.const 0)))
        (then
          (drop (call $gdi_dc_system_clip_rect
            (local.get $hdc)
            (i32.sub (i32.const 0) (local.get $x))
            (i32.sub (i32.const 0) (local.get $y))
            (i32.sub (local.get $pw) (local.get $x))
            (i32.sub (local.get $ph) (local.get $y)) (i32.const 1)))))
      (local.set $current (local.get $parent))
      (br $ancestors))))

  (func $dc_exclude_children_for_clip (param $hdc i32) (param $hwnd i32) (param $origin_x i32) (param $origin_y i32)
    (local $style i32) (local $slot i32) (local $ch i32) (local $cstyle i32)
    (local $xy i32) (local $wh i32) (local $cx i32) (local $cy i32) (local $cw i32) (local $chh i32)
    (local.set $style (call $wnd_get_style (local.get $hwnd)))
    (if (i32.eqz (i32.and (local.get $style) (i32.const 0x02000000))) ;; WS_CLIPCHILDREN
      (then (return)))
    (local.set $slot (i32.const 0))
    (block $done (loop $scan
      (local.set $slot (call $wnd_next_child_slot (local.get $hwnd) (local.get $slot)))
      (br_if $done (i32.lt_s (local.get $slot) (i32.const 0)))
      (local.set $ch (call $wnd_slot_hwnd (local.get $slot)))
      (local.set $cstyle (call $wnd_get_style (local.get $ch)))
      (if (i32.and (local.get $cstyle) (i32.const 0x10000000)) ;; WS_VISIBLE
        (then
          (local.set $wh (call $ctrl_get_wh_packed (local.get $ch)))
          (local.set $cx (call $ctrl_get_x_s (local.get $ch)))
          (local.set $cy (call $ctrl_get_y_s (local.get $ch)))
          (local.set $cw (i32.and (local.get $wh) (i32.const 0xFFFF)))
          (local.set $chh (i32.shr_u (local.get $wh) (i32.const 16)))
          (if (i32.and (i32.gt_s (local.get $cw) (i32.const 0))
                       (i32.gt_s (local.get $chh) (i32.const 0)))
            (then
              (drop (call $gdi_dc_system_clip_rect
                (local.get $hdc)
                (i32.add (local.get $origin_x) (local.get $cx))
                (i32.add (local.get $origin_y) (local.get $cy))
                (i32.add (i32.add (local.get $origin_x) (local.get $cx)) (local.get $cw))
                (i32.add (i32.add (local.get $origin_y) (local.get $cy)) (local.get $chh))
                (i32.const 4)))))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br 0))))

  ;; WM_ERASEBKGND on a parent must not clear visible child windows. On real
  ;; USER/GDI this is enforced by the visible region. Our child dialogs and
  ;; WAT-native controls draw into the top-level backing canvas, so the erase
  ;; DC needs an explicit child exclusion even when the parent template did not
  ;; carry WS_CLIPCHILDREN.
  (func $dc_exclude_visible_children_for_erase (param $hdc i32) (param $hwnd i32) (param $origin_x i32) (param $origin_y i32)
    (local $slot i32) (local $ch i32) (local $cstyle i32)
    (local $xy i32) (local $wh i32) (local $cx i32) (local $cy i32) (local $cw i32) (local $chh i32)
    (local.set $slot (i32.const 0))
    (block $done (loop $scan
      (local.set $slot (call $wnd_next_child_slot (local.get $hwnd) (local.get $slot)))
      (br_if $done (i32.lt_s (local.get $slot) (i32.const 0)))
      (local.set $ch (call $wnd_slot_hwnd (local.get $slot)))
      (local.set $cstyle (call $wnd_get_style (local.get $ch)))
      (if (i32.and (local.get $cstyle) (i32.const 0x10000000)) ;; WS_VISIBLE
        (then
          (local.set $wh (call $ctrl_get_wh_packed (local.get $ch)))
          (local.set $cx (call $ctrl_get_x_s (local.get $ch)))
          (local.set $cy (call $ctrl_get_y_s (local.get $ch)))
          (local.set $cw (i32.and (local.get $wh) (i32.const 0xFFFF)))
          (local.set $chh (i32.shr_u (local.get $wh) (i32.const 16)))
          (if (i32.and (i32.gt_s (local.get $cw) (i32.const 0))
                       (i32.gt_s (local.get $chh) (i32.const 0)))
            (then
              (drop (call $gdi_dc_system_clip_rect
                (local.get $hdc)
                (i32.add (local.get $origin_x) (local.get $cx))
                (i32.add (local.get $origin_y) (local.get $cy))
                (i32.add (i32.add (local.get $origin_x) (local.get $cx)) (local.get $cw))
                (i32.add (i32.add (local.get $origin_y) (local.get $cy)) (local.get $chh))
                (i32.const 4)))))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br 0))))

  (func $dc_exclude_siblings_for_clip (param $hdc i32) (param $hwnd i32)
    (local $style i32) (local $parent i32) (local $myxy i32) (local $myx i32) (local $myy i32)
    (local $slot i32) (local $my_slot i32) (local $sib i32) (local $sstyle i32)
    (local $xy i32) (local $wh i32) (local $sx i32) (local $sy i32) (local $sw i32) (local $sh i32)
    (local.set $style (call $wnd_get_style (local.get $hwnd)))
    (if (i32.eqz (i32.and (local.get $style) (i32.const 0x04000000))) ;; WS_CLIPSIBLINGS
      (then (return)))
    (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
    (if (i32.eqz (local.get $parent)) (then (return)))
    (local.set $my_slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.lt_s (local.get $my_slot) (i32.const 0)) (then (return)))
    (local.set $myx (call $ctrl_get_x_s (local.get $hwnd)))
    (local.set $myy (call $ctrl_get_y_s (local.get $hwnd)))
    ;; Later slots are treated as above us; this matches existing WAT
    ;; sibling enumeration until an explicit z-order table exists.
    (local.set $slot (i32.add (local.get $my_slot) (i32.const 1)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $slot) (global.get $MAX_WINDOWS)))
      (local.set $sib (call $wnd_slot_hwnd (local.get $slot)))
      (if (i32.and
            (i32.ne (local.get $sib) (i32.const 0))
            (i32.eq (call $wnd_get_parent (local.get $sib)) (local.get $parent)))
        (then
          (local.set $sstyle (call $wnd_get_style (local.get $sib)))
          (if (i32.and (local.get $sstyle) (i32.const 0x10000000)) ;; WS_VISIBLE
            (then
              (local.set $wh (call $ctrl_get_wh_packed (local.get $sib)))
              (local.set $sx (call $ctrl_get_x_s (local.get $sib)))
              (local.set $sy (call $ctrl_get_y_s (local.get $sib)))
              (local.set $sw (i32.and (local.get $wh) (i32.const 0xFFFF)))
              (local.set $sh (i32.shr_u (local.get $wh) (i32.const 16)))
              (if (i32.and (i32.gt_s (local.get $sw) (i32.const 0))
                           (i32.gt_s (local.get $sh) (i32.const 0)))
                (then
                  (drop (call $gdi_dc_system_clip_rect
                    (local.get $hdc)
                    (i32.sub (local.get $sx) (local.get $myx))
                    (i32.sub (local.get $sy) (local.get $myy))
                    (i32.add (i32.sub (local.get $sx) (local.get $myx)) (local.get $sw))
                    (i32.add (i32.sub (local.get $sy) (local.get $myy)) (local.get $sh))
                    (i32.const 4))))))))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br 0))))

  (func $win98_sys_color (param $idx i32) (result i32)
    ;; COLORREF values for the stock Windows 98 classic palette.
    (if (i32.eq (local.get $idx) (i32.const 0)) (then (return (i32.const 0x00C0C0C0)))) ;; SCROLLBAR
    (if (i32.eq (local.get $idx) (i32.const 1)) (then (return (i32.const 0x00808000)))) ;; BACKGROUND
    (if (i32.eq (local.get $idx) (i32.const 2)) (then (return (i32.const 0x00800000)))) ;; ACTIVECAPTION
    (if (i32.eq (local.get $idx) (i32.const 3)) (then (return (i32.const 0x00C0C0C0)))) ;; INACTIVECAPTION
    (if (i32.eq (local.get $idx) (i32.const 4)) (then (return (i32.const 0x00C0C0C0)))) ;; MENU
    (if (i32.eq (local.get $idx) (i32.const 5)) (then (return (i32.const 0x00FFFFFF)))) ;; WINDOW
    (if (i32.eq (local.get $idx) (i32.const 6)) (then (return (i32.const 0x00000000)))) ;; WINDOWFRAME
    (if (i32.eq (local.get $idx) (i32.const 7)) (then (return (i32.const 0x00000000)))) ;; MENUTEXT
    (if (i32.eq (local.get $idx) (i32.const 8)) (then (return (i32.const 0x00000000)))) ;; WINDOWTEXT
    (if (i32.eq (local.get $idx) (i32.const 9)) (then (return (i32.const 0x00FFFFFF)))) ;; CAPTIONTEXT
    (if (i32.eq (local.get $idx) (i32.const 10)) (then (return (i32.const 0x00C0C0C0)))) ;; ACTIVEBORDER
    (if (i32.eq (local.get $idx) (i32.const 11)) (then (return (i32.const 0x00C0C0C0)))) ;; INACTIVEBORDER
    (if (i32.eq (local.get $idx) (i32.const 12)) (then (return (i32.const 0x00808080)))) ;; APPWORKSPACE
    (if (i32.eq (local.get $idx) (i32.const 13)) (then (return (i32.const 0x00800000)))) ;; HIGHLIGHT
    (if (i32.eq (local.get $idx) (i32.const 14)) (then (return (i32.const 0x00FFFFFF)))) ;; HIGHLIGHTTEXT
    (if (i32.eq (local.get $idx) (i32.const 15)) (then (return (i32.const 0x00C0C0C0)))) ;; BTNFACE
    (if (i32.eq (local.get $idx) (i32.const 16)) (then (return (i32.const 0x00808080)))) ;; BTNSHADOW
    (if (i32.eq (local.get $idx) (i32.const 17)) (then (return (i32.const 0x00808080)))) ;; GRAYTEXT
    (if (i32.eq (local.get $idx) (i32.const 18)) (then (return (i32.const 0x00000000)))) ;; BTNTEXT
    (if (i32.eq (local.get $idx) (i32.const 19)) (then (return (i32.const 0x00000000)))) ;; INACTIVECAPTIONTEXT
    (if (i32.eq (local.get $idx) (i32.const 20)) (then (return (i32.const 0x00FFFFFF)))) ;; BTNHIGHLIGHT
    ;; 21..24 are the Win95-era additions. Values come from the Plus! 98 theme
    ;; files (all 19 ship ButtonDkShadow=0 0 0, InfoText=0 0 0,
    ;; InfoWindow=255 255 225), which is also what $gdi_draw_edge_desc already
    ;; paints for a raised outer edge. 22 (3DLIGHT) keeps the C0C0C0 fallback
    ;; the edge painter uses for its inner light layer.
    (if (i32.eq (local.get $idx) (i32.const 21)) (then (return (i32.const 0x00000000)))) ;; 3DDKSHADOW
    (if (i32.eq (local.get $idx) (i32.const 23)) (then (return (i32.const 0x00000000)))) ;; INFOTEXT
    (if (i32.eq (local.get $idx) (i32.const 24)) (then (return (i32.const 0x00E1FFFF)))) ;; INFOBK
    (i32.const 0x00C0C0C0))

  (func $dc_apply_client_clip (param $hdc i32) (param $hwnd i32)
    (local $w i32) (local $h i32)
    (if (i32.eqz (call $gdi_dc_system_clip_reset (local.get $hdc))) (then (return)))
    (if (i32.eqz (call $wnd_is_effectively_visible (local.get $hwnd)))
      (then
        (drop (call $gdi_dc_system_clip_rect (local.get $hdc)
          (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 1)))
        (return)))
    (local.set $w (call $wnd_client_w_for_clip (local.get $hwnd)))
    (local.set $h (call $wnd_client_h_for_clip (local.get $hwnd)))
    (if (i32.and (i32.gt_s (local.get $w) (i32.const 0))
                 (i32.gt_s (local.get $h) (i32.const 0)))
      (then
        (drop (call $gdi_dc_system_clip_rect
          (local.get $hdc) (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
          (i32.const 1)))))
    (call $dc_clip_to_parent_client (local.get $hdc) (local.get $hwnd))
    (call $dc_exclude_children_for_clip
      (local.get $hdc) (local.get $hwnd) (i32.const 0) (i32.const 0))
    (call $dc_exclude_siblings_for_clip (local.get $hdc) (local.get $hwnd)))

  (func $dc_apply_client_erase_clip (param $hdc i32) (param $hwnd i32)
    (local $w i32) (local $h i32)
    (if (i32.eqz (call $gdi_dc_system_clip_reset (local.get $hdc))) (then (return)))
    (if (i32.eqz (call $wnd_is_effectively_visible (local.get $hwnd)))
      (then
        (drop (call $gdi_dc_system_clip_rect (local.get $hdc)
          (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 1)))
        (return)))
    (local.set $w (call $wnd_client_w_for_clip (local.get $hwnd)))
    (local.set $h (call $wnd_client_h_for_clip (local.get $hwnd)))
    (if (i32.and (i32.gt_s (local.get $w) (i32.const 0))
                 (i32.gt_s (local.get $h) (i32.const 0)))
      (then
        (drop (call $gdi_dc_system_clip_rect
          (local.get $hdc) (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
          (i32.const 1)))))
    (call $dc_clip_to_parent_client (local.get $hdc) (local.get $hwnd))
    (call $dc_exclude_visible_children_for_erase
      (local.get $hdc) (local.get $hwnd) (i32.const 0) (i32.const 0))
    (call $dc_exclude_siblings_for_clip (local.get $hdc) (local.get $hwnd)))

  (func $dc_apply_window_clip (param $hdc i32) (param $hwnd i32)
    (local $style i32) (local $wh i32)
    (if (i32.eqz (call $gdi_dc_system_clip_reset (local.get $hdc))) (then (return)))
    (if (i32.eqz (call $wnd_is_effectively_visible (local.get $hwnd)))
      (then
        (drop (call $gdi_dc_system_clip_rect (local.get $hdc)
          (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 1)))
        (return)))
    (local.set $style (call $wnd_get_style (local.get $hwnd)))
    (if (i32.and (local.get $style) (i32.const 0x40000000)) ;; WS_CHILD
      (then
        (local.set $wh (call $ctrl_get_wh_packed (local.get $hwnd)))
        (if (i32.and
              (i32.gt_s (i32.and (local.get $wh) (i32.const 0xFFFF)) (i32.const 0))
              (i32.gt_s (i32.shr_u (local.get $wh) (i32.const 16)) (i32.const 0)))
          (then
            (drop (call $gdi_dc_system_clip_rect
              (local.get $hdc) (i32.const 0) (i32.const 0)
              (i32.and (local.get $wh) (i32.const 0xFFFF))
              (i32.shr_u (local.get $wh) (i32.const 16)) (i32.const 1)))))))
    (call $dc_clip_to_parent_client (local.get $hdc) (local.get $hwnd))
    (call $dc_exclude_children_for_clip
      (local.get $hdc) (local.get $hwnd)
      (call $client_rect_get_l (local.get $hwnd))
      (call $client_rect_get_t (local.get $hwnd)))
    (call $dc_exclude_siblings_for_clip (local.get $hdc) (local.get $hwnd)))

  ;; A window DC may outlive the visibility state under which GetDC created
  ;; its USER clip. Rebuild all retained window clips when WS_VISIBLE changes;
  ;; parent/child/sibling visibility can affect DCs other than the changed
  ;; window itself. Visibility changes are rare, so the bounded table scan is
  ;; preferable to checking hierarchy state in every rasterized pixel.
  (func $gdi_refresh_window_dc_system_clips
    (local $i i32) (local $dc i32) (local $hdc i32)
    (local $binding i32) (local $hwnd i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_DC_STATE_COUNT)))
      (local.set $dc (i32.add (global.get $GDI_DC_STATE_TABLE)
        (i32.mul (local.get $i) (global.get $GDI_DC_STATE_STRIDE))))
      (local.set $hdc (i32.load (local.get $dc)))
      (local.set $binding (i32.load offset=92 (local.get $dc)))
      (local.set $hwnd (i32.and (local.get $binding) (i32.const 0x7FFFFFFF)))
      (if (i32.and (i32.ne (local.get $hdc) (i32.const 0))
            (i32.ne (local.get $hwnd) (i32.const 0)))
        (then
          (if (i32.lt_s (local.get $binding) (i32.const 0))
            (then (call $dc_apply_window_clip (local.get $hdc) (local.get $hwnd)))
            (else (call $dc_apply_client_clip (local.get $hdc) (local.get $hwnd))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan))))

  (func $dc_apply_nc_clip (param $hdc i32) (param $hwnd i32) (param $w i32) (param $h i32)
    (local $cr_l i32) (local $cr_t i32) (local $cr_r i32) (local $cr_b i32)
    (if (i32.eqz (call $gdi_dc_system_clip_reset (local.get $hdc))) (then (return)))
    (if (i32.eqz (call $wnd_is_effectively_visible (local.get $hwnd)))
      (then
        (drop (call $gdi_dc_system_clip_rect (local.get $hdc)
          (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 1)))
        (return)))
    (if (i32.and (i32.gt_s (local.get $w) (i32.const 0))
                 (i32.gt_s (local.get $h) (i32.const 0)))
      (then
        (drop (call $gdi_dc_system_clip_rect
          (local.get $hdc) (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
          (i32.const 1)))))
    (local.set $cr_l (call $client_rect_get_l (local.get $hwnd)))
    (local.set $cr_t (call $client_rect_get_t (local.get $hwnd)))
    (local.set $cr_r (call $client_rect_get_r (local.get $hwnd)))
    (local.set $cr_b (call $client_rect_get_b (local.get $hwnd)))
    (if (i32.and (i32.gt_s (i32.sub (local.get $cr_r) (local.get $cr_l)) (i32.const 0))
                 (i32.gt_s (i32.sub (local.get $cr_b) (local.get $cr_t)) (i32.const 0)))
      (then
        (drop (call $gdi_dc_system_clip_rect
          (local.get $hdc)
          (local.get $cr_l) (local.get $cr_t)
          (local.get $cr_r) (local.get $cr_b) (i32.const 4))))))

  ;; $post_queue_push(hwnd, msg, wParam, lParam): append to the ring at 0x400.
  ;; Same layout as PostMessageA. Returns 1 on success, 0 if full.
  (func $post_queue_push
        (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32)
        (result i32)
    (local $slot i32)
    (if (i32.ge_u (global.get $post_queue_count) (i32.const 64))
      (then (return (i32.const 0))))
    (local.set $slot (i32.add (i32.const 0x400)
      (i32.mul (global.get $post_queue_count) (i32.const 16))))
    (i32.store          (local.get $slot) (local.get $hwnd))
    (i32.store offset=4  (local.get $slot) (local.get $msg))
    (i32.store offset=8  (local.get $slot) (local.get $wParam))
    (i32.store offset=12 (local.get $slot) (local.get $lParam))
    (global.set $post_queue_count (i32.add (global.get $post_queue_count) (i32.const 1)))
    ;; --trace-win16 shows every posted message going in, which is the other
    ;; half of the dlg-pump/task-loop lines showing them come out. A message
    ;; delivered twice is either pushed twice or popped twice, and only both
    ;; halves together say which.
    (if (global.get $win16_trace)
      (then
        (call $host_log_i32 (i32.const 0xCA16A9EC))
        (call $host_log_i32 (local.get $hwnd))
        (call $host_log_i32 (local.get $msg))
        (call $host_log_i32 (local.get $wParam))
        (call $host_log_i32 (local.get $lParam))
        (call $host_log_i32 (global.get $post_queue_count))))
    (i32.const 1))

  ;; $post_queue_purge_hwnd(hwnd): drop every queued message aimed at a window
  ;; that is going away. USER discards a destroyed window's queued messages;
  ;; delivering one afterwards hands the app an HWND it has already torn its
  ;; own bookkeeping down for (MFC looks the dead HWND up in its permanent
  ;; handle map and calls a virtual on a freed CWnd).
  (func $post_queue_purge_hwnd (param $hwnd i32)
    (local $i i32) (local $slot i32)
    (if (i32.eqz (local.get $hwnd)) (then (return)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $post_queue_count)))
      (local.set $slot (i32.add (i32.const 0x400)
        (i32.mul (local.get $i) (i32.const 16))))
      (if (i32.eq (i32.load (local.get $slot)) (local.get $hwnd))
        (then
          (global.set $post_queue_count
            (i32.sub (global.get $post_queue_count) (i32.const 1)))
          (if (i32.lt_u (local.get $i) (global.get $post_queue_count))
            (then
              (call $memcpy
                (local.get $slot)
                (i32.add (local.get $slot) (i32.const 16))
                (i32.mul
                  (i32.sub (global.get $post_queue_count) (local.get $i))
                  (i32.const 16))))))
        (else (local.set $i (i32.add (local.get $i) (i32.const 1)))))
      (br $scan)))
  )

  ;; Skip a DLGTEMPLATE variable-length field (OrdOrString):
  ;;   0x0000 → null (skip 2 bytes)
  ;;   0xFFFF → ordinal (skip 4 bytes: 0xFFFF + u16 value)
  ;;   else   → UTF-16LE null-terminated string (skip to null + 2)
  ;; $wa = WASM address of field start. Returns WASM address past field.
  (func $dlg_skip_ord_or_sz (param $wa i32) (result i32)
    (local $ch i32)
    (local.set $ch (i32.load16_u (local.get $wa)))
    (if (i32.eqz (local.get $ch))
      (then (return (i32.add (local.get $wa) (i32.const 2)))))
    (if (i32.eq (local.get $ch) (i32.const 0xFFFF))
      (then (return (i32.add (local.get $wa) (i32.const 4)))))
    ;; UTF-16 string — scan for null terminator
    (block $done (loop $scan
      (local.set $ch (i32.load16_u (local.get $wa)))
      (local.set $wa (i32.add (local.get $wa) (i32.const 2)))
      (br_if $done (i32.eqz (local.get $ch)))
      (br $scan)))
    (local.get $wa))

  ;; Resource data accessor for JS: finds the given (type, name) via
  ;; $find_resource (which understands int IDs and guest ASCII string
  ;; pointers) and returns the WASM linear address of the data payload.
  ;; Sets $rsrc_last_size so callers can read the size in a paired
  ;; export call. Returns 0 on miss.
  (global $rsrc_last_size (mut i32) (i32.const 0))
  (func $rsrc_find_data_wa (param $type_id i32) (param $name_id i32) (result i32)
    (local $data_entry i32) (local $rva i32)
    (global.set $rsrc_last_size (i32.const 0))
    (local.set $data_entry (call $find_resource (local.get $type_id) (local.get $name_id)))
    (if (i32.eqz (local.get $data_entry)) (then (return (i32.const 0))))
    (local.set $rva (call $gl32 (i32.add (call $r_base) (local.get $data_entry))))
    (global.set $rsrc_last_size
      (call $gl32 (i32.add (call $r_base)
        (i32.add (local.get $data_entry) (i32.const 4)))))
    (call $g2w (i32.add (call $r_base) (local.get $rva))))

  ;; LoadStringA / LoadStringW backing — walks RT_STRING directly in WAT.
  ;; Win32 packs string resources into 16-entry bundles; string id N lives
  ;; in bundle (N >> 4) + 1 at index N & 0xF. Each entry is (u16 length
  ;; in UTF-16 chars) followed by `length` UTF-16LE code units. Empty
  ;; slots have length 0 and no chars.
  ;;
  ;; $buf_wa is the destination WASM linear address (caller already ran
  ;; the guest pointer through $g2w), $buf_len is the max chars including
  ;; the NUL terminator. Returns number of chars written (excluding NUL)
  ;; or 0 if the string can't be found / empty / buf_len is 0.
  (func $string_load_a (param $id i32) (param $buf_wa i32) (param $buf_len i32) (result i32)
    (local $bundle_id i32) (local $idx i32) (local $data_entry i32)
    (local $rva i32) (local $wa i32) (local $i i32) (local $entry_len i32)
    (local $copy i32) (local $j i32) (local $ch i32)
    (if (i32.le_s (local.get $buf_len) (i32.const 0)) (then (return (i32.const 0))))
    (local.set $bundle_id (i32.add (i32.shr_u (local.get $id) (i32.const 4)) (i32.const 1)))
    (local.set $idx (i32.and (local.get $id) (i32.const 0xF)))
    (local.set $data_entry (call $find_resource (i32.const 6) (local.get $bundle_id)))
    (if (i32.eqz (local.get $data_entry)) (then (return (i32.const 0))))
    (local.set $rva (call $gl32 (i32.add (call $r_base) (local.get $data_entry))))
    (local.set $wa (call $g2w (i32.add (call $r_base) (local.get $rva))))
    ;; Skip entries 0..idx-1
    (block $at_entry (loop $skip
      (br_if $at_entry (i32.ge_u (local.get $i) (local.get $idx)))
      (local.set $entry_len (i32.load16_u (local.get $wa)))
      (local.set $wa (i32.add (local.get $wa)
        (i32.add (i32.const 2) (i32.shl (local.get $entry_len) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $skip)))
    (local.set $entry_len (i32.load16_u (local.get $wa)))
    (local.set $wa (i32.add (local.get $wa) (i32.const 2)))
    (if (i32.eqz (local.get $entry_len)) (then (return (i32.const 0))))
    ;; Clamp to buf_len-1 to leave room for NUL
    (local.set $copy (local.get $entry_len))
    (if (i32.ge_u (local.get $copy) (local.get $buf_len))
      (then (local.set $copy (i32.sub (local.get $buf_len) (i32.const 1)))))
    ;; Convert UTF-16 → ASCII (low byte) into destination
    (local.set $j (i32.const 0))
    (block $done (loop $copy_loop
      (br_if $done (i32.ge_u (local.get $j) (local.get $copy)))
      (local.set $ch (i32.load16_u (i32.add (local.get $wa)
        (i32.shl (local.get $j) (i32.const 1)))))
      (i32.store8 (i32.add (local.get $buf_wa) (local.get $j))
        (i32.and (local.get $ch) (i32.const 0xFF)))
      (local.set $j (i32.add (local.get $j) (i32.const 1)))
      (br $copy_loop)))
    (i32.store8 (i32.add (local.get $buf_wa) (local.get $copy)) (i32.const 0))
    (local.get $copy))

  (func $string_load_w (param $id i32) (param $buf_wa i32) (param $buf_len i32) (result i32)
    (local $bundle_id i32) (local $idx i32) (local $data_entry i32)
    (local $rva i32) (local $wa i32) (local $i i32) (local $entry_len i32)
    (local $copy i32) (local $j i32)
    (if (i32.le_s (local.get $buf_len) (i32.const 0)) (then (return (i32.const 0))))
    (local.set $bundle_id (i32.add (i32.shr_u (local.get $id) (i32.const 4)) (i32.const 1)))
    (local.set $idx (i32.and (local.get $id) (i32.const 0xF)))
    (local.set $data_entry (call $find_resource (i32.const 6) (local.get $bundle_id)))
    (if (i32.eqz (local.get $data_entry)) (then (return (i32.const 0))))
    (local.set $rva (call $gl32 (i32.add (call $r_base) (local.get $data_entry))))
    (local.set $wa (call $g2w (i32.add (call $r_base) (local.get $rva))))
    (block $at_entry (loop $skip
      (br_if $at_entry (i32.ge_u (local.get $i) (local.get $idx)))
      (local.set $entry_len (i32.load16_u (local.get $wa)))
      (local.set $wa (i32.add (local.get $wa)
        (i32.add (i32.const 2) (i32.shl (local.get $entry_len) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $skip)))
    (local.set $entry_len (i32.load16_u (local.get $wa)))
    (local.set $wa (i32.add (local.get $wa) (i32.const 2)))
    (if (i32.eqz (local.get $entry_len)) (then (return (i32.const 0))))
    (local.set $copy (local.get $entry_len))
    (if (i32.ge_u (local.get $copy) (local.get $buf_len))
      (then (local.set $copy (i32.sub (local.get $buf_len) (i32.const 1)))))
    (local.set $j (i32.const 0))
    (block $done (loop $copy_loop
      (br_if $done (i32.ge_u (local.get $j) (local.get $copy)))
      (i32.store16
        (i32.add (local.get $buf_wa) (i32.shl (local.get $j) (i32.const 1)))
        (i32.load16_u (i32.add (local.get $wa) (i32.shl (local.get $j) (i32.const 1)))))
      (local.set $j (i32.add (local.get $j) (i32.const 1)))
      (br $copy_loop)))
    (i32.store16 (i32.add (local.get $buf_wa) (i32.shl (local.get $copy) (i32.const 1))) (i32.const 0))
    (local.get $copy))

  ;; Skip a UTF-16LE null-terminated string. Returns WASM address past null.
  (func $dlg_skip_sz (param $wa i32) (result i32)
    (block $done (loop $scan
      (if (i32.eqz (i32.load16_u (local.get $wa)))
        (then (return (i32.add (local.get $wa) (i32.const 2)))))
      (local.set $wa (i32.add (local.get $wa) (i32.const 2)))
      (br $scan)))
    (local.get $wa))

  ;; Convert UTF-16LE OrdOrString at WASM addr $wa to ASCII in guest buffer.
  ;; Returns guest ptr to NUL-terminated ASCII string (heap-allocated), or 0 if null/ordinal.
  ;; Also advances $wa past the field (caller must use returned $wa_out).
  ;; out[0] = guest text ptr (or 0), out[1] = new $wa position
  ;; We use two return values via a scratch global pair.
  (global $dlg_text_ptr (mut i32) (i32.const 0))
  (global $dlg_text_wa  (mut i32) (i32.const 0))
  (func $dlg_read_text (param $wa i32)
    (local $ch i32) (local $len i32) (local $start i32) (local $buf i32) (local $j i32)
    (local.set $ch (i32.load16_u (local.get $wa)))
    ;; null → skip 2 bytes, return 0
    (if (i32.eqz (local.get $ch))
      (then
        (global.set $dlg_text_ptr (i32.const 0))
        (global.set $dlg_text_wa (i32.add (local.get $wa) (i32.const 2)))
        (return)))
    ;; ordinal (0xFFFF) → skip 4 bytes, return 0
    (if (i32.eq (local.get $ch) (i32.const 0xFFFF))
      (then
        (global.set $dlg_text_ptr (i32.const 0))
        (global.set $dlg_text_wa (i32.add (local.get $wa) (i32.const 4)))
        (return)))
    ;; UTF-16 string — measure length first
    (local.set $start (local.get $wa))
    (local.set $len (i32.const 0))
    (block $m_done (loop $m_loop
      (br_if $m_done (i32.eqz (i32.load16_u (local.get $wa))))
      (local.set $wa (i32.add (local.get $wa) (i32.const 2)))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (br $m_loop)))
    (local.set $wa (i32.add (local.get $wa) (i32.const 2))) ;; skip null
    (global.set $dlg_text_wa (local.get $wa))
    ;; Allocate guest buffer and convert to ASCII
    (local.set $buf (call $heap_alloc (i32.add (local.get $len) (i32.const 1))))
    (local.set $j (i32.const 0))
    (block $c_done (loop $c_loop
      (br_if $c_done (i32.ge_u (local.get $j) (local.get $len)))
      (i32.store8 (call $g2w (i32.add (local.get $buf) (local.get $j)))
        (i32.and (i32.load16_u (i32.add (local.get $start)
          (i32.mul (local.get $j) (i32.const 2)))) (i32.const 0xFF)))
      (local.set $j (i32.add (local.get $j) (i32.const 1)))
      (br $c_loop)))
    (i32.store8 (call $g2w (i32.add (local.get $buf) (local.get $len))) (i32.const 0))
    (global.set $dlg_text_ptr (local.get $buf)))

  ;; ---- WND_DLG_RECORDS accessors ----
  ;; Indexed by window slot (same index as WND_RECORDS / CONTROL_TABLE /
  ;; MENU_DATA_TABLE). Each entry is 32 bytes; layout documented in
  ;; 01-header.wat alongside $WND_DLG_RECORDS.

  (func $dlg_record_addr (param $slot i32) (result i32)
    (i32.add (global.get $WND_DLG_RECORDS) (i32.mul (local.get $slot) (i32.const 32))))

  (func $dlg_record_for_hwnd (param $hwnd i32) (result i32)
    (local $slot i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.lt_s (local.get $slot) (i32.const 0)) (then (return (i32.const 0))))
    (call $dlg_record_addr (local.get $slot)))

  ;; Convert UTF-16LE OrdOrString at WASM addr $wa into a result value:
  ;;   null      → 0, advances 2 bytes
  ;;   ordinal   → the ordinal value (int), advances 4 bytes
  ;;   string    → guest heap ptr to NUL-terminated ASCII copy, advances past null
  ;; Uses $dlg_text_ptr/$dlg_text_wa globals for the two return values.
  ;; For the "menu" and "class" header fields we need the integer ordinal
  ;; preserved; for the title/control-text path ordinals aren't meaningful
  ;; and are already discarded by $dlg_read_text.
  (func $dlg_read_menu_or_class (param $wa i32)
    (local $ch i32)
    (local.set $ch (i32.load16_u (local.get $wa)))
    (if (i32.eqz (local.get $ch))
      (then
        (global.set $dlg_text_ptr (i32.const 0))
        (global.set $dlg_text_wa (i32.add (local.get $wa) (i32.const 2)))
        (return)))
    (if (i32.eq (local.get $ch) (i32.const 0xFFFF))
      (then
        ;; ordinal — stash the u16 value as-is
        (global.set $dlg_text_ptr (i32.load16_u (i32.add (local.get $wa) (i32.const 2))))
        (global.set $dlg_text_wa (i32.add (local.get $wa) (i32.const 4)))
        (return)))
    ;; Fall through to string handling — reuse $dlg_read_text
    (call $dlg_read_text (local.get $wa)))

  ;; Seed initial focus to the first WS_VISIBLE+WS_TABSTOP+!WS_DISABLED child
  ;; of $dlg_hwnd. Walks WND_RECORDS via $wnd_next_child_slot so the caller
  ;; doesn't need to know whether children were allocated contiguously.
  ;; Used by both resource-driven $dlg_load and WAT-built dialogs like
  ;; $create_findreplace_dialog so Tab/Shift+Tab works without a prior click.
  (func $dlg_seed_focus (param $dlg_hwnd i32)
    (local $slot i32) (local $ch i32) (local $style i32)
    (block $done (loop $walk
      (local.set $slot (call $wnd_next_child_slot (local.get $dlg_hwnd) (local.get $slot)))
      (br_if $done (i32.eq (local.get $slot) (i32.const -1)))
      (local.set $ch (call $wnd_slot_hwnd (local.get $slot)))
      (local.set $style (call $wnd_get_style (local.get $ch)))
      (if (i32.and
            (i32.and (i32.ne (i32.and (local.get $style) (i32.const 0x10000000)) (i32.const 0))   ;; WS_VISIBLE
                     (i32.eqz (i32.and (local.get $style) (i32.const 0x08000000))))             ;; !WS_DISABLED
            (i32.ne (i32.and (local.get $style) (i32.const 0x00010000)) (i32.const 0)))         ;; WS_TABSTOP
        (then
          (call $set_focus (local.get $ch))
          (return)))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $walk))))

  ;; $dlg_load(dlg_hwnd, dlg_id) → ctrl_count
  ;;
  ;; Single entry point for building a dialog from an RT_DIALOG template.
  ;; Walks the PE resource (via $find_resource — handles both integer IDs
  ;; and guest string pointers for named entries like freecell's
  ;; "STATISTICS"), stores the header fields in WND_DLG_RECORDS[slot],
  ;; allocates one HWND per control with $next_hwnd, fills CONTROL_TABLE,
  ;; sets CONTROL_GEOM, and sends WM_CREATE with a synthesised
  ;; CREATESTRUCT so native control wndprocs initialise their state.
  ;;
  ;; Returns the number of controls parsed (0 if template not found).
  ;; The caller is expected to have already registered $dlg_hwnd in
  ;; WND_RECORDS via $wnd_table_set — $dlg_load uses the slot index as
  ;; the key into WND_DLG_RECORDS.
  (func $dlg_load (param $dlg_hwnd i32) (param $dlg_id i32) (result i32)
    (local $data_entry i32) (local $rva i32) (local $wa i32) (local $p i32)
    (local $style i32) (local $ex_style i32) (local $ctrl_count i32)
    (local $dlg_x i32) (local $dlg_y i32) (local $dlg_cx i32) (local $dlg_cy i32)
    (local $title_ptr i32) (local $menu_key i32)
    (local $dlg_slot i32) (local $dlg_rec i32) (local $dlg_key i32)
    (local $i i32) (local $ctrl_hwnd i32) (local $ctrl_slot i32) (local $ctrl_rec i32)
    (local $cx i32) (local $cy i32) (local $cw i32) (local $ch i32)
    (local $is_ex i32) (local $ctrl_style i32) (local $ctrl_ex i32) (local $ctrl_id i32)
    (local $class_val i32) (local $class_enum i32) (local $class_ptr i32)
    (local $custom_wndproc i32) (local $native_tab i32)
    (local $text_ptr i32) (local $text_ord i32) (local $cs i32)
    ;; Find the dialog slot — caller must have inserted it already
    (local.set $dlg_slot (call $wnd_table_find (local.get $dlg_hwnd)))
    (if (i32.lt_s (local.get $dlg_slot) (i32.const 0)) (then (return (i32.const 0))))
    (local.set $dlg_rec (call $dlg_record_addr (local.get $dlg_slot)))
    (if (global.get $dlg_indirect_template_ptr)
      (then
        (local.set $dlg_key (i32.const 0))
        (local.set $wa (call $g2w (global.get $dlg_indirect_template_ptr)))
        (global.set $dlg_indirect_template_ptr (i32.const 0)))
      (else
        ;; Walk PE directory; also captures $rsrc_matched_eid for named entries
        (local.set $data_entry (call $find_resource (i32.const 5) (local.get $dlg_id)))
        (if (i32.eqz (local.get $data_entry)) (then (return (i32.const 0))))
        (local.set $dlg_key (global.get $rsrc_matched_eid))
        ;; Read RVA from data entry → WASM linear address of template
        (local.set $rva (call $gl32 (i32.add (call $r_base) (local.get $data_entry))))
        (local.set $wa (call $g2w (i32.add (call $r_base) (local.get $rva))))))
    (local.set $p (local.get $wa))
    ;; Detect DIALOGEX: sig=1 at +0, ver=0xFFFF at +2
    (local.set $is_ex (i32.and
      (i32.eq (i32.load16_u (local.get $p)) (i32.const 1))
      (i32.eq (i32.load16_u (i32.add (local.get $p) (i32.const 2))) (i32.const 0xFFFF))))
    ;; Header: style, exStyle
    (if (local.get $is_ex)
      (then
        ;; DIALOGEX: dlgVer(2) + signature(2) + helpID(4) + exStyle(4) + style(4)
        (local.set $ex_style (i32.load (i32.add (local.get $p) (i32.const 8))))
        (local.set $style    (i32.load (i32.add (local.get $p) (i32.const 12))))
        (local.set $p (i32.add (local.get $p) (i32.const 16))))
      (else
        ;; DLGTEMPLATE: style(4) + exStyle(4)
        (local.set $style    (i32.load (local.get $p)))
        (local.set $ex_style (i32.load (i32.add (local.get $p) (i32.const 4))))
        (local.set $p (i32.add (local.get $p) (i32.const 8)))))
    ;; cdit(2) + x(2) + y(2) + cx(2) + cy(2)
    (local.set $ctrl_count (i32.load16_u (local.get $p)))
    (local.set $dlg_x  (i32.load16_s (i32.add (local.get $p) (i32.const 2))))
    (local.set $dlg_y  (i32.load16_s (i32.add (local.get $p) (i32.const 4))))
    (local.set $dlg_cx (i32.load16_s (i32.add (local.get $p) (i32.const 6))))
    (local.set $dlg_cy (i32.load16_s (i32.add (local.get $p) (i32.const 8))))
    (local.set $p (i32.add (local.get $p) (i32.const 10)))
    ;; Menu (OrdOrString) — may be int id or guest ASCII copy
    (call $dlg_read_menu_or_class (local.get $p))
    (local.set $menu_key (global.get $dlg_text_ptr))
    (local.set $p (global.get $dlg_text_wa))
    ;; Class (OrdOrString) — ignored for dialogs, but must skip
    (local.set $p (call $dlg_skip_ord_or_sz (local.get $p)))
    ;; Title (UTF-16 sz)
    (call $dlg_read_text (local.get $p))
    (local.set $title_ptr (global.get $dlg_text_ptr))
    (local.set $p (global.get $dlg_text_wa))
    ;; If DS_SETFONT (0x40), skip font fields
    (if (i32.and (local.get $style) (i32.const 0x40))
      (then
        (local.set $p (i32.add (local.get $p) (i32.const 2)))  ;; pointsize
        (if (local.get $is_ex)
          (then (local.set $p (i32.add (local.get $p) (i32.const 4)))))  ;; weight+italic+charset
        (local.set $p (call $dlg_skip_sz (local.get $p)))))  ;; typeface
    ;; Propagate dialog style onto the hwnd so $wnd_get_style sees it —
    ;; needed by $defwndproc_do_ncpaint to recognise WS_CAPTION and draw
    ;; the title bar + sysbuttons. Without this, modal dialogs open but
    ;; ncpaint returns early and the back-canvas has no chrome.
    (drop (call $wnd_set_style (local.get $dlg_hwnd) (local.get $style)))
    ;; Also publish the title so $defwndproc_do_ncpaint can draw it in the
    ;; caption bar. $title_ptr is a guest heap pointer from $dlg_read_text.
    (if (local.get $title_ptr)
      (then (call $title_table_set (local.get $dlg_hwnd)
              (call $g2w (local.get $title_ptr))
              (call $strlen (call $g2w (local.get $title_ptr))))))
    ;; Stash header in WND_DLG_RECORDS[slot]
    (i32.store         (local.get $dlg_rec) (local.get $dlg_key))
    (i32.store offset=4  (local.get $dlg_rec) (local.get $style))
    (i32.store offset=8  (local.get $dlg_rec) (local.get $ex_style))
    (i32.store16 offset=12 (local.get $dlg_rec) (local.get $dlg_x))
    (i32.store16 offset=14 (local.get $dlg_rec) (local.get $dlg_y))
    (i32.store16 offset=16 (local.get $dlg_rec) (local.get $dlg_cx))
    (i32.store16 offset=18 (local.get $dlg_rec) (local.get $dlg_cy))
    (i32.store offset=20 (local.get $dlg_rec) (local.get $title_ptr))
    (i32.store offset=24 (local.get $dlg_rec) (local.get $menu_key))
    (i32.store offset=28 (local.get $dlg_rec) (local.get $ctrl_count))
    ;; Dialog HWNDs are real windows too. DLGTEMPLATE cx/cy describe the
    ;; client area for top-level dialogs, while CONTROL_GEOM describes the
    ;; whole window. Add the same approximate non-client extents used by the
    ;; renderer (frame/caption and optional menu), otherwise NCCALCSIZE removes
    ;; chrome from an already-client-sized rect. Apps that center the dialog
    ;; from GetWindowRect then preserve that undersized rect, clipping the
    ;; bottom row of controls (pinball's Player Controls buttons).
    ;;
    ;; Child dialog pages have no separately composed top-level chrome, so
    ;; their template dimensions remain unchanged.
    (call $ctrl_geom_set (local.get $dlg_slot)
      (i32.div_u (i32.mul (local.get $dlg_x) (i32.const 3)) (i32.const 2))
      (i32.div_u (i32.add (i32.mul (local.get $dlg_y) (i32.const 13)) (i32.const 4)) (i32.const 8))
      (i32.add
        (i32.div_u (i32.mul (local.get $dlg_cx) (i32.const 3)) (i32.const 2))
        (select
          (i32.const 8) (i32.const 0)
          (i32.eqz (i32.and (local.get $style) (i32.const 0x40000000)))))
      (i32.add
        (i32.div_u (i32.add (i32.mul (local.get $dlg_cy) (i32.const 13)) (i32.const 4)) (i32.const 8))
        (select
          (i32.add
            (i32.const 30)
            (select
              (i32.const 18) (i32.const 0)
              (i32.ne (local.get $menu_key) (i32.const 0))))
          (i32.const 0)
          (i32.eqz (i32.and (local.get $style) (i32.const 0x40000000))))))
    ;; Allocate one CREATESTRUCT on the heap, reused for every control
    (local.set $cs (call $heap_alloc (i32.const 48)))
    ;; Iterate DLGITEMTEMPLATE entries
    (local.set $i (i32.const 0))
    (block $done (loop $ctrl_loop
      (br_if $done (i32.ge_u (local.get $i) (local.get $ctrl_count)))
      ;; DWORD-align
      (local.set $p (i32.and (i32.add (local.get $p) (i32.const 3)) (i32.const -4)))
      (if (local.get $is_ex)
        (then
          ;; helpId(4) + exStyle(4) + style(4) + x,y,cx,cy + id(4)
          (local.set $ctrl_ex    (i32.load (i32.add (local.get $p) (i32.const 4))))
          (local.set $ctrl_style (i32.load (i32.add (local.get $p) (i32.const 8))))
          (local.set $cx (i32.load16_s (i32.add (local.get $p) (i32.const 12))))
          (local.set $cy (i32.load16_s (i32.add (local.get $p) (i32.const 14))))
          (local.set $cw (i32.load16_s (i32.add (local.get $p) (i32.const 16))))
          (local.set $ch (i32.load16_s (i32.add (local.get $p) (i32.const 18))))
          (local.set $ctrl_id (i32.load (i32.add (local.get $p) (i32.const 20))))
          (local.set $p (i32.add (local.get $p) (i32.const 24))))
        (else
          ;; style(4) + exStyle(4) + x,y,cx,cy + id(2)
          (local.set $ctrl_style (i32.load (local.get $p)))
          (local.set $ctrl_ex    (i32.load (i32.add (local.get $p) (i32.const 4))))
          (local.set $cx (i32.load16_s (i32.add (local.get $p) (i32.const 8))))
          (local.set $cy (i32.load16_s (i32.add (local.get $p) (i32.const 10))))
          (local.set $cw (i32.load16_s (i32.add (local.get $p) (i32.const 12))))
          (local.set $ch (i32.load16_s (i32.add (local.get $p) (i32.const 14))))
          (local.set $ctrl_id (i32.load16_u (i32.add (local.get $p) (i32.const 16))))
          (local.set $p (i32.add (local.get $p) (i32.const 18)))))
      ;; className: int (0xFFFF + u16 ordinal) → Win32 builtin class enum,
      ;; or a UTF-16 string. Treat RichEdit* as edit-like enough for
      ;; installer license pages; EM_STREAMIN is handled by $edit_wndproc.
      ;; 0x80=Button,0x81=Edit,0x82=Static,0x83=ListBox,0x84=ScrollBar,0x85=ComboBox
      (local.set $class_enum (i32.const 0))
      (local.set $class_ptr (i32.const 0))
      (local.set $custom_wndproc (i32.const 0))
      (local.set $native_tab (i32.const 0))
      (if (i32.eq (i32.load16_u (local.get $p)) (i32.const 0xFFFF))
        (then
          (local.set $class_val (i32.load16_u (i32.add (local.get $p) (i32.const 2))))
          (local.set $class_ptr (local.get $class_val))
          (if (i32.eq (local.get $class_val) (i32.const 0x80)) (then (local.set $class_enum (i32.const 1))))
          (if (i32.eq (local.get $class_val) (i32.const 0x81)) (then (local.set $class_enum (i32.const 2))))
          (if (i32.eq (local.get $class_val) (i32.const 0x82)) (then (local.set $class_enum (i32.const 3))))
          (if (i32.eq (local.get $class_val) (i32.const 0x83)) (then (local.set $class_enum (i32.const 4))))
          (if (i32.eq (local.get $class_val) (i32.const 0x85)) (then (local.set $class_enum (i32.const 5))))
          (if (i32.eq (local.get $class_val) (i32.const 0x84)) (then (local.set $class_enum (i32.const 7))))
          (local.set $p (call $dlg_skip_ord_or_sz (local.get $p))))
        (else
          ;; UTF-16 string classes. Templates may name both builtin classes
          ;; ("ListBox") and common controls ("msctls_progress32").
          (if (call $wide_ascii_eq (local.get $p) (i32.const 0x3100))
            (then (local.set $class_enum (i32.const 1))))
          (if (call $wide_ascii_eq (local.get $p) (i32.const 0x3108))
            (then (local.set $class_enum (i32.const 2))))
          (if (call $wide_ascii_eq (local.get $p) (i32.const 0x310D))
            (then (local.set $class_enum (i32.const 3))))
          (if (call $wide_ascii_eq (local.get $p) (i32.const 0x3114))
            (then (local.set $class_enum (i32.const 4))))
          (if (call $wide_ascii_eq (local.get $p) (i32.const 0x311C))
            (then (local.set $class_enum (i32.const 7))))
          (if (call $wide_ascii_eq (local.get $p) (i32.const 0x3126))
            (then (local.set $class_enum (i32.const 5))))
          (if (call $wide_ascii_prefix_eq (local.get $p) (i32.const 0x312F))
            (then (local.set $class_enum (i32.const 17))))
          (if (call $wide_ascii_prefix_eq (local.get $p) (i32.const 0x316A)) ;; SysTreeView32
            (then (local.set $class_enum (i32.const 8))))
          (if (call $wide_ascii_prefix_eq (local.get $p) (i32.const 0x3141))
            (then (local.set $class_enum (i32.const 18))))
          (if (call $wide_ascii_eq (local.get $p) (i32.const 0x3150))
            (then (local.set $class_enum (i32.const 19))))
          (if (call $wide_ascii_prefix_eq (local.get $p) (i32.const 0x3158))
            (then (local.set $class_enum (i32.const 19))))
          (if (call $wide_ascii_eq (local.get $p) (i32.const 0x3178))
            (then (local.set $class_enum (i32.const 28))))
          ;; "RichEdit", "RichEdit20A", etc. Compare the first four chars
          ;; case-insensitively: r i c h.
          (if (i32.and
                (i32.eq (i32.or (i32.load16_u (local.get $p)) (i32.const 0x20)) (i32.const 0x72))
                (i32.and
                  (i32.eq (i32.or (i32.load16_u (i32.add (local.get $p) (i32.const 2))) (i32.const 0x20)) (i32.const 0x69))
                  (i32.and
                    (i32.eq (i32.or (i32.load16_u (i32.add (local.get $p) (i32.const 4))) (i32.const 0x20)) (i32.const 0x63))
                    (i32.eq (i32.or (i32.load16_u (i32.add (local.get $p) (i32.const 6))) (i32.const 0x20)) (i32.const 0x68)))))
            (then (local.set $class_enum (i32.const 2))))
          ;; Preserve named application control classes. Resource dialogs can
          ;; use custom registered classes (Sound Recorder's shadowframe,
          ;; noflicker, and wave display controls); routing those through the
          ;; native-control sentinel suppresses their real WM_CREATE/WM_PAINT.
          (call $dlg_read_text (local.get $p))
          (local.set $class_ptr (global.get $dlg_text_ptr))
          (local.set $p (global.get $dlg_text_wa))
          ;; Dialog-template common controls bypass CreateWindowExA. Preserve
          ;; the registered COMCTL32 SysTabControl32 proc, but mark the HWND so
          ;; WAT can mirror TCM_* state and paint full-height Win98 tab chrome.
          (if (i32.and
                (i32.ge_u (local.get $class_ptr) (i32.const 0x10000))
                (i32.and
                  (i32.eq
                    (i32.or (i32.load (call $g2w (local.get $class_ptr))) (i32.const 0x20202020))
                    (i32.const 0x74737973)) ;; "syst"
                  (i32.eq
                    (i32.or (i32.load offset=4 (call $g2w (local.get $class_ptr))) (i32.const 0x20202020))
                    (i32.const 0x6f636261)))) ;; "abco"
            (then (local.set $native_tab (i32.const 1))))
          (if (i32.and
                (i32.eqz (local.get $class_enum))
                (i32.ne (local.get $class_ptr) (i32.const 0)))
            (then
              (local.set $custom_wndproc
                (call $class_table_lookup
                  (call $class_name_key (local.get $class_ptr))))))))
      ;; Text (UTF-16 → ASCII in heap). Preserve resource ordinals for image
      ;; statics: SS_ICON templates encode MAKEINTRESOURCE in lpszName.
      (local.set $text_ord (i32.const 0))
      (if (i32.eq (i32.load16_u (local.get $p)) (i32.const 0xFFFF))
        (then
          (local.set $text_ord
            (i32.load16_u (i32.add (local.get $p) (i32.const 2))))))
      (call $dlg_read_text (local.get $p))
      (local.set $text_ptr (global.get $dlg_text_ptr))
      (local.set $p (global.get $dlg_text_wa))
      ;; Extra data: u16 len followed by len bytes
      (local.set $p (i32.add (local.get $p)
        (i32.add (i32.const 2) (i32.load16_u (local.get $p)))))
      ;; Allocate control HWND
      (local.set $ctrl_hwnd (global.get $next_hwnd))
      (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
      (call $wnd_table_set (local.get $ctrl_hwnd)
        (select (local.get $custom_wndproc) (global.get $WNDPROC_CTRL_NATIVE)
          (local.get $custom_wndproc)))
      (drop (call $wnd_set_style (local.get $ctrl_hwnd) (local.get $ctrl_style)))
      (call $wnd_set_parent (local.get $ctrl_hwnd) (local.get $dlg_hwnd))
      (local.set $ctrl_slot (call $wnd_table_find (local.get $ctrl_hwnd)))
      (if (i32.ge_s (local.get $ctrl_slot) (i32.const 0))
        (then
          (call $ctrl_table_set (local.get $ctrl_slot)
            (local.get $class_enum) (local.get $ctrl_id))
          (if (local.get $native_tab)
            (then (call $tab_native_mark_slot
              (local.get $ctrl_slot) (i32.const 1))))
          (call $ctrl_set_ex_style (local.get $ctrl_hwnd) (local.get $ctrl_ex))
          ;; Per-control text is owned by each wndproc's state struct
          ;; (ButtonState.text_buf_ptr etc.) — populated from
          ;; CREATESTRUCT.lpszName in WM_CREATE below. Renderer reads
          ;; live text via existing button_get_text / edit / static
          ;; accessors, so we don't need to stash a parallel copy in
          ;; CONTROL_TABLE.
          ;; DLU → pixel geometry (x*3/2, y*13/8). The vertical factor is
          ;; tmHeight/8 for the dialog font, and a real Win98 probe measures
          ;; MS Sans Serif 8pt at tmHeight=13 (test/fixtures/font-metrics.json)
          ;; -- we used 7/4 for a long time, which is a 14px cell and made
          ;; every dialog ~8% too tall. The +4 rounds the way MapDialogRect's
          ;; MulDiv does; truncating turns the canonical 14-DLU button into
          ;; 22px instead of 23. For comboboxes (class 5),
          ;; the template's ch is the full dropped-down extent per Win32
          ;; convention — clamp the window/hit-test rect to the field
          ;; height (21px) unless CBS_SIMPLE so stacked combos don't
          ;; overlap each other and route clicks to the wrong combo
          ;; (pinball Player Controls: 6 combos at y=85/108/133 with
          ;; ch=70 each were all ~120px tall pre-clamp).
          (call $ctrl_geom_set (local.get $ctrl_slot)
            (i32.div_u (i32.mul (local.get $cx) (i32.const 3)) (i32.const 2))
            (i32.div_u (i32.add (i32.mul (local.get $cy) (i32.const 13)) (i32.const 4)) (i32.const 8))
            (i32.div_u (i32.mul (local.get $cw) (i32.const 3)) (i32.const 2))
            (select
              (i32.const 21)
              (i32.div_u (i32.add (i32.mul (local.get $ch) (i32.const 13)) (i32.const 4)) (i32.const 8))
              (i32.and
                (i32.eq (local.get $class_enum) (i32.const 5))
                (i32.ne (i32.and (local.get $ctrl_style) (i32.const 0x3))
                        (i32.const 1)))))))
      ;; Build CREATESTRUCT and send WM_CREATE. Per Win32 the x/y/cx/cy fields
      ;; are PIXELS, not dialog units — combobox WM_CREATE in particular reads
      ;; cs+16 (cy) to size its dropped listbox, and pinball's Player Controls
      ;; supplied raw DLU ch=22 (≈38 px) so the listbox dropped area was only
      ;; ~17 px tall, clipping to ~2 visible items.
      (i32.store         (call $g2w (local.get $cs)) (i32.const 0))
      (i32.store offset=4  (call $g2w (local.get $cs)) (i32.const 0))
      (i32.store offset=8  (call $g2w (local.get $cs)) (local.get $ctrl_id))
      (i32.store offset=12 (call $g2w (local.get $cs)) (local.get $dlg_hwnd))
      (i32.store offset=16 (call $g2w (local.get $cs)) (i32.div_u (i32.add (i32.mul (local.get $ch) (i32.const 13)) (i32.const 4)) (i32.const 8)))
      (i32.store offset=20 (call $g2w (local.get $cs)) (i32.div_u (i32.mul (local.get $cw) (i32.const 3)) (i32.const 2)))
      (i32.store offset=24 (call $g2w (local.get $cs)) (i32.div_u (i32.add (i32.mul (local.get $cy) (i32.const 13)) (i32.const 4)) (i32.const 8)))
      (i32.store offset=28 (call $g2w (local.get $cs)) (i32.div_u (i32.mul (local.get $cx) (i32.const 3)) (i32.const 2)))
      (i32.store offset=32 (call $g2w (local.get $cs)) (local.get $ctrl_style))
      (i32.store offset=36 (call $g2w (local.get $cs))
        (select
          (local.get $text_ord)
          (local.get $text_ptr)
          (i32.and
            (i32.eq (local.get $class_enum) (i32.const 3))
            (i32.ne (local.get $text_ord) (i32.const 0)))))
      (i32.store offset=40 (call $g2w (local.get $cs)) (local.get $class_ptr))
      (i32.store offset=44 (call $g2w (local.get $cs)) (i32.const 0))
      ;; USER owns the initial window text independently of any class-specific
      ;; state. Registered custom controls commonly query it during WM_PAINT;
      ;; native controls continue to keep their own state copy as well.
      (if (local.get $text_ptr)
        (then
          (call $title_table_set (local.get $ctrl_hwnd)
            (call $g2w (local.get $text_ptr))
            (call $strlen (call $g2w (local.get $text_ptr))))))
      (drop (call $wnd_send_message (local.get $ctrl_hwnd) (i32.const 0x0001) (i32.const 0) (local.get $cs)))
      ;; Control wndproc has copied text into its own state struct;
      ;; free the template-side copy to avoid leaking per dialog open.
      (if (local.get $text_ptr) (then (call $heap_free (local.get $text_ptr))))
      (if (i32.ge_u (local.get $class_ptr) (i32.const 0x10000))
        (then (call $heap_free (local.get $class_ptr))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $ctrl_loop)))
    (call $heap_free (local.get $cs))
    (call $dlg_seed_focus (local.get $dlg_hwnd))
    (return (local.get $ctrl_count)))

  ;; ============================================================
  ;; Process environment block
  ;; ============================================================
  ;; One ANSI block in guest memory, "NAME=VALUE\0"... terminated by a second
  ;; NUL, exactly the layout GetEnvironmentStrings hands back. Every
  ;; environment entry point reads or edits this one block, so the A and W
  ;; spellings cannot disagree about what the environment contains: the wide
  ;; ones widen on the way out and narrow on the way in.

  (func $env_ensure
    (local $i i32) (local $ch i32) (local $prev i32)
    (if (global.get $env_block) (then (return)))
    (global.set $env_block (call $heap_alloc (global.get $env_cap)))
    (local.set $prev (i32.const 1))
    (block $done (loop $copy
      (local.set $ch (i32.load8_u (i32.add (i32.const 0x3390) (local.get $i))))
      (call $gs8 (i32.add (global.get $env_block) (local.get $i)) (local.get $ch))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $done (i32.and (i32.eqz (local.get $ch)) (i32.eqz (local.get $prev))))
      (local.set $prev (local.get $ch))
      (br $copy))))

  ;; Total bytes in the block, including both terminating NULs.
  (func $env_size (result i32)
    (local $i i32) (local $ch i32) (local $prev i32)
    (call $env_ensure)
    (local.set $prev (i32.const 1))
    (block $done (loop $scan
      (local.set $ch (call $gl8 (i32.add (global.get $env_block) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $done (i32.and (i32.eqz (local.get $ch)) (i32.eqz (local.get $prev))))
      (local.set $prev (local.get $ch))
      (br $scan)))
    (local.get $i))

  ;; Guest address of the entry whose name matches, or 0. Names are compared
  ;; case-insensitively, as Win32 does.
  (func $env_find (param $name_g i32) (param $wide i32) (result i32)
    (local $p i32) (local $i i32) (local $a i32) (local $b i32) (local $step i32)
    (call $env_ensure)
    (local.set $step (select (i32.const 2) (i32.const 1) (local.get $wide)))
    (local.set $p (global.get $env_block))
    (block $miss (loop $entry
      (br_if $miss (i32.eqz (call $gl8 (local.get $p))))
      (local.set $i (i32.const 0))
      (block $next (block $hit (loop $cmp
        (local.set $a (call $tolower (call $gl8 (i32.add (local.get $p) (local.get $i)))))
        (local.set $b (call $tolower (call $gl_char
          (i32.add (local.get $name_g) (i32.mul (local.get $i) (local.get $step)))
          (local.get $wide))))
        ;; End of the caller's name: a match needs '=' on our side.
        (if (i32.eqz (local.get $b))
          (then (br_if $hit (i32.eq (local.get $a) (i32.const 0x3D))) (br $next)))
        (br_if $next (i32.ne (local.get $a) (local.get $b)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $cmp)))
        (return (local.get $p)))
      (local.set $p (i32.add (local.get $p)
        (i32.add (call $guest_strlen (local.get $p)) (i32.const 1))))
      (br $entry)))
    (i32.const 0))

  ;; GetEnvironmentVariable: characters written on success, or the buffer size
  ;; the caller needs (including the NUL) when the buffer is too small, or 0
  ;; when the variable does not exist.
  (func $env_get (param $name_g i32) (param $buf_g i32) (param $size i32) (param $wide i32) (result i32)
    (local $p i32) (local $len i32) (local $i i32) (local $step i32)
    (local.set $p (call $env_find (local.get $name_g) (local.get $wide)))
    (if (i32.eqz (local.get $p)) (then (return (i32.const 0))))
    ;; Skip past "NAME=".
    (local.set $p (i32.add (local.get $p)
      (i32.add (call $env_name_len (local.get $p)) (i32.const 1))))
    (local.set $len (call $guest_strlen (local.get $p)))
    (if (i32.or (i32.eqz (local.get $buf_g)) (i32.le_u (local.get $size) (local.get $len)))
      (then (return (i32.add (local.get $len) (i32.const 1)))))
    (local.set $step (select (i32.const 2) (i32.const 1) (local.get $wide)))
    (block $done (loop $copy
      (br_if $done (i32.gt_u (local.get $i) (local.get $len)))
      (call $store_char
        (i32.add (local.get $buf_g) (i32.mul (local.get $i) (local.get $step)))
        (call $gl8 (i32.add (local.get $p) (local.get $i))) (local.get $wide))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (local.get $len))

  ;; Length of the NAME part of an entry, i.e. the offset of its '='.
  (func $env_name_len (param $p i32) (result i32)
    (local $i i32) (local $ch i32)
    (block $done (loop $scan
      (local.set $ch (call $gl8 (i32.add (local.get $p) (local.get $i))))
      (br_if $done (i32.or (i32.eqz (local.get $ch)) (i32.eq (local.get $ch) (i32.const 0x3D))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $i))

  ;; SetEnvironmentVariable: replaces or removes one entry. A NULL value
  ;; deletes. Returns TRUE unless the block has no room left.
  (func $env_set (param $name_g i32) (param $val_g i32) (param $wide i32) (result i32)
    (local $p i32) (local $entry i32) (local $tail i32) (local $size i32)
    (local $i i32) (local $step i32) (local $ch i32) (local $name_len i32) (local $val_len i32)
    (if (i32.eqz (local.get $name_g)) (then (return (i32.const 0))))
    (local.set $step (select (i32.const 2) (i32.const 1) (local.get $wide)))
    (local.set $size (call $env_size))
    ;; Drop any existing entry by shifting the rest of the block over it.
    (local.set $entry (call $env_find (local.get $name_g) (local.get $wide)))
    (if (local.get $entry)
      (then
        (local.set $tail (i32.add (call $guest_strlen (local.get $entry)) (i32.const 1)))
        (local.set $i (i32.sub (local.get $entry) (global.get $env_block)))
        (block $moved (loop $shift
          (br_if $moved (i32.ge_u (i32.add (local.get $i) (local.get $tail)) (local.get $size)))
          (call $gs8 (i32.add (global.get $env_block) (local.get $i))
            (call $gl8 (i32.add (global.get $env_block)
              (i32.add (local.get $i) (local.get $tail)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $shift)))
        (local.set $size (i32.sub (local.get $size) (local.get $tail)))))
    (if (i32.eqz (local.get $val_g)) (then (return (i32.const 1))))
    ;; Append "NAME=VALUE\0" over the block's final NUL.
    (local.set $name_len (call $lstr_len (local.get $name_g) (local.get $wide)))
    (local.set $val_len (call $lstr_len (local.get $val_g) (local.get $wide)))
    (if (i32.gt_u (i32.add (local.get $size)
                     (i32.add (local.get $name_len)
                       (i32.add (local.get $val_len) (i32.const 2))))
                  (global.get $env_cap))
      (then (return (i32.const 0))))
    (local.set $p (i32.add (global.get $env_block) (i32.sub (local.get $size) (i32.const 1))))
    (local.set $i (i32.const 0))
    (block $names_done (loop $name
      (br_if $names_done (i32.ge_u (local.get $i) (local.get $name_len)))
      (call $gs8 (i32.add (local.get $p) (local.get $i))
        (call $gl_char (i32.add (local.get $name_g) (i32.mul (local.get $i) (local.get $step)))
          (local.get $wide)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $name)))
    (local.set $p (i32.add (local.get $p) (local.get $name_len)))
    (call $gs8 (local.get $p) (i32.const 0x3D))
    (local.set $p (i32.add (local.get $p) (i32.const 1)))
    (local.set $i (i32.const 0))
    (block $vals_done (loop $val
      (br_if $vals_done (i32.ge_u (local.get $i) (local.get $val_len)))
      (call $gs8 (i32.add (local.get $p) (local.get $i))
        (call $gl_char (i32.add (local.get $val_g) (i32.mul (local.get $i) (local.get $step)))
          (local.get $wide)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $val)))
    (local.set $p (i32.add (local.get $p) (local.get $val_len)))
    (call $gs8 (local.get $p) (i32.const 0))                      ;; end of this entry
    (call $gs8 (i32.add (local.get $p) (i32.const 1)) (i32.const 0))  ;; end of block
    (i32.const 1))

  ;; GetEnvironmentStrings: a fresh copy of the block in the caller's
  ;; encoding, owned by the caller until FreeEnvironmentStrings.
  (func $env_strings (param $wide i32) (result i32)
    (local $size i32) (local $out i32) (local $i i32) (local $step i32)
    (local.set $size (call $env_size))
    (local.set $step (select (i32.const 2) (i32.const 1) (local.get $wide)))
    (local.set $out (call $heap_alloc (i32.mul (local.get $size) (local.get $step))))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $size)))
      (call $store_char (i32.add (local.get $out) (i32.mul (local.get $i) (local.get $step)))
        (call $gl8 (i32.add (global.get $env_block) (local.get $i))) (local.get $wide))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (local.get $out))
