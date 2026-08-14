  ;; ============================================================
  ;; HELPER FUNCTIONS
  ;; ============================================================

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
            (call $str_eq (local.get $name_wa) (i32.const 0x330)))
          (call $dll_name_match (local.get $dll_name_ga) (i32.const 0x325)))
      (then (return (call $lookup_api_id (i32.const 0x319)))))
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
  (func $fast_msvc_sbh_scan (result i32)
    (local $wa i32) (local $scan i32) (local $page i32)
    (local $first i32) (local $mode i32) (local $match i32)
    (local.set $wa (call $g2w (global.get $eip)))
    (local.set $mode (i32.const 0))

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
    (if (local.get $match)
      (then
        (local.set $mode (i32.const 1))
        (local.set $scan (global.get $esi))
        (local.set $page (global.get $edi))))

    ;; EDI scan / ESI page variant.
    (local.set $match (i32.eqz (local.get $mode)))
    (if (i32.ne (i32.load16_u (local.get $wa)) (i32.const 0x078B)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load16_u offset=2 (local.get $wa)) (i32.const 0xC33B)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load16_u offset=4 (local.get $wa)) (i32.const 0x1B7C)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load16_u offset=6 (local.get $wa)) (i32.const 0x5F39)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load8_u offset=8 (local.get $wa)) (i32.const 0x04)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load16_u offset=9 (local.get $wa)) (i32.const 0x1676)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load16_u offset=0x21 (local.get $wa)) (i32.const 0xC783)) (then (local.set $match (i32.const 0))))
    (if (i32.ne (i32.load16_u offset=0x2C (local.get $wa)) (i32.const 0xD272)) (then (local.set $match (i32.const 0))))
    (if (local.get $match)
      (then
        (local.set $mode (i32.const 2))
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

  ;; The high guest-address allocator is process-wide. Mutable WAT globals are
  ;; per instance, so a worker can otherwise reserve from a stale top and
  ;; overlap a range already owned by the main instance. Keep the authoritative
  ;; downward cursor in shared memory at VIRTUAL_MAP_STATE+8.
  (func $virtual_shared_top_observe (param $guest i32)
    (local $top i32)
    (local.set $top
      (i32.load (i32.add (global.get $VIRTUAL_MAP_STATE) (i32.const 8))))
    (if (i32.or (i32.eqz (local.get $top))
                (i32.lt_u (local.get $guest) (local.get $top)))
      (then
        (i32.store (i32.add (global.get $VIRTUAL_MAP_STATE) (i32.const 8))
          (local.get $guest)))))

  (func $virtual_reserve_down (param $size i32) (result i32)
    (local $top i32) (local $new_top i32)
    (local.set $top
      (i32.load (i32.add (global.get $VIRTUAL_MAP_STATE) (i32.const 8))))
    (if (i32.eqz (local.get $top))
      (then
        (local.set $top (global.get $virtual_alloc_top))
        (if (i32.eqz (local.get $top))
          (then (local.set $top (global.get $VIRTUAL_ALLOC_TOP_INIT))))))
    (local.set $new_top
      (i32.and (i32.sub (local.get $top) (local.get $size))
        (i32.const 0xFFFF0000)))
    (if (i32.lt_u (local.get $new_top) (global.get $VIRTUAL_ALLOC_MIN))
      (then (return (i32.const 0))))
    (i32.store (i32.add (global.get $VIRTUAL_MAP_STATE) (i32.const 8))
      (local.get $new_top))
    (global.set $virtual_alloc_top (local.get $new_top))
    (local.get $new_top))

  ;; Back a high guest VirtualAlloc commit with real WASM memory. Entries are
  ;; coalesced when the guest commits adjacent 64KB chunks in order, which keeps
  ;; g2w's sparse-map scan short for CRT small-block heap arenas.
  (func $virtual_map_commit (param $guest i32) (param $size i32) (result i32)
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
          (i32.store (i32.add (local.get $rec) (i32.const 4))
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
    (i32.store (global.get $VIRTUAL_MAP_STATE) (i32.add (local.get $count) (i32.const 1)))
    (i32.store (i32.add (global.get $VIRTUAL_MAP_STATE) (i32.const 4))
      (i32.add (local.get $backing_ptr) (local.get $size)))
    (call $virtual_shared_top_observe (local.get $guest))
    (global.set $virtual_alloc_top (local.get $guest))
    (local.get $guest))

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
      ;; No free block found — bump allocate.
      ;; OOM guard: refuse if the next heap byte would escape low guest
      ;; memory and land in emulator-private decoded-code/cache regions.
      ;; Pawn-style chess engines ask for 64 MB transposition tables that
      ;; could trip this; return 0 so the app handles OOM. VirtualAlloc
      ;; reservations are sparse address-space claims in this emulator and do
      ;; not cap HeapAlloc growth until they commit into real low memory.
      (if (i32.lt_u
            (i32.add (global.get $heap_ptr) (local.get $need))
            (global.get $heap_ptr))
        (then
          (local.set $ptr (call $heap_sparse_alloc (local.get $need)))
          (if (local.get $ptr) (then (br $found)) (else (return (i32.const 0))))))
      (if (i32.gt_u
            (call $g2w (i32.add (global.get $heap_ptr) (local.get $need)))
            (global.get $THREAD_CACHE_BASE))
        (then
          (local.set $ptr (call $heap_sparse_alloc (local.get $need)))
          (if (local.get $ptr) (then (br $found)) (else (return (i32.const 0))))))
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
    ;; (e.g., msvcrt sbh blocks that shouldn't reach our free list)
    (if (i32.lt_u (local.get $guest_ptr) (global.get $heap_base)) (then (return)))
    ;; Block starts 4 bytes before the user pointer
    (local.set $block (i32.sub (local.get $guest_ptr) (i32.const 4)))
    (local.set $w (call $g2w (local.get $block)))
    ;; Prepend to free list: store next = old head
    (i32.store (i32.add (local.get $w) (i32.const 4)) (global.get $free_list))
    (global.set $free_list (local.get $block)))

  ;; ---- WAT-owned GDI region registry ---------------------------------
  ;; Canonical regions are sorted, disjoint half-open rectangles grouped into
  ;; horizontal bands. JS only holds a derived Canvas presentation mirror.
  (func $gdi_rgn_record (param $hrgn i32) (result i32)
    (local $slot i32) (local $record i32)
    (if (i32.ne
          (i32.and (local.get $hrgn) (i32.const 0xFFFF0000))
          (i32.const 0x00500000))
      (then (return (i32.const 0))))
    (local.set $slot (i32.sub (i32.and (local.get $hrgn) (i32.const 0xFF)) (i32.const 1)))
    (if (i32.ge_u (local.get $slot) (i32.const 255))
      (then (return (i32.const 0))))
    (local.set $record
      (i32.add (global.get $GDI_REGION_TABLE) (i32.mul (local.get $slot) (i32.const 32))))
    (if (i32.eqz (i32.load (local.get $record)))
      (then (return (i32.const 0))))
    (if (i32.ne
          (i32.and (i32.load offset=4 (local.get $record)) (i32.const 0xFF))
          (i32.and (i32.shr_u (local.get $hrgn) (i32.const 8)) (i32.const 0xFF)))
      (then (return (i32.const 0))))
    (local.get $record))

  (func $gdi_rgn_host_handle (param $hrgn i32) (result i32)
    (local $record i32)
    (local.set $record (call $gdi_rgn_record (local.get $hrgn)))
    (if (result i32) (local.get $record)
      (then (i32.load offset=24 (local.get $record)))
      (else (local.get $hrgn))))

  (func $gdi_rgn_bands (param $record i32) (result i32)
    (i32.add (global.get $GDI_REGION_BANDS)
      (i32.mul
        (i32.shr_u (i32.sub (local.get $record) (global.get $GDI_REGION_TABLE)) (i32.const 5))
        (global.get $GDI_REGION_RECT_STRIDE))))

  (func $gdi_rgn_sync_mirror (param $record i32) (result i32)
    (if (i32.eqz (i32.load offset=24 (local.get $record)))
      (then (return (i32.const 1))))
    (call $host_gdi_set_region_bands
      (i32.load offset=24 (local.get $record))
      (call $gdi_rgn_bands (local.get $record))
      (i32.load offset=28 (local.get $record))))

  (func $gdi_rgn_complexity_record (param $record i32) (result i32)
    (if (i32.or
          (i32.ge_s (i32.load offset=8 (local.get $record)) (i32.load offset=16 (local.get $record)))
          (i32.ge_s (i32.load offset=12 (local.get $record)) (i32.load offset=20 (local.get $record))))
      (then (return (i32.const 1))))
    (if (result i32) (i32.eq (i32.load offset=28 (local.get $record)) (i32.const 1))
      (then (i32.const 2))
      (else (i32.const 3))))

  (func $gdi_rgn_update_bbox (param $record i32)
    (local $base i32) (local $count i32) (local $i i32) (local $p i32)
    (local $left i32) (local $top i32) (local $right i32) (local $bottom i32)
    (local.set $count (i32.load offset=28 (local.get $record)))
    (if (i32.eqz (local.get $count))
      (then
        (i32.store offset=8 (local.get $record) (i32.const 0))
        (i32.store offset=12 (local.get $record) (i32.const 0))
        (i32.store offset=16 (local.get $record) (i32.const 0))
        (i32.store offset=20 (local.get $record) (i32.const 0))
        (i32.store (local.get $record) (i32.const 1))
        (return)))
    (local.set $base (call $gdi_rgn_bands (local.get $record)))
    (local.set $left (i32.load (local.get $base)))
    (local.set $top (i32.load offset=4 (local.get $base)))
    (local.set $right (i32.load offset=8 (local.get $base)))
    (local.set $bottom (i32.load offset=12 (local.get $base)))
    (local.set $i (i32.const 1))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $p (i32.add (local.get $base) (i32.shl (local.get $i) (i32.const 4))))
      (if (i32.lt_s (i32.load (local.get $p)) (local.get $left))
        (then (local.set $left (i32.load (local.get $p)))))
      (if (i32.lt_s (i32.load offset=4 (local.get $p)) (local.get $top))
        (then (local.set $top (i32.load offset=4 (local.get $p)))))
      (if (i32.gt_s (i32.load offset=8 (local.get $p)) (local.get $right))
        (then (local.set $right (i32.load offset=8 (local.get $p)))))
      (if (i32.gt_s (i32.load offset=12 (local.get $p)) (local.get $bottom))
        (then (local.set $bottom (i32.load offset=12 (local.get $p)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.store offset=8 (local.get $record) (local.get $left))
    (i32.store offset=12 (local.get $record) (local.get $top))
    (i32.store offset=16 (local.get $record) (local.get $right))
    (i32.store offset=20 (local.get $record) (local.get $bottom))
    (i32.store (local.get $record)
      (select (i32.const 1) (i32.const 2) (i32.eq (local.get $count) (i32.const 1)))))

  (func $gdi_rgn_set_buffer (param $record i32) (param $source i32) (param $count i32) (result i32)
    (if (i32.gt_u (local.get $count) (global.get $GDI_REGION_MAX_RECTS))
      (then (return (i32.const 0))))
    (if (local.get $count)
      (then (memory.copy
        (call $gdi_rgn_bands (local.get $record))
        (local.get $source)
        (i32.shl (local.get $count) (i32.const 4)))))
    (i32.store offset=28 (local.get $record) (local.get $count))
    (call $gdi_rgn_update_bbox (local.get $record))
    (drop (call $gdi_rgn_sync_mirror (local.get $record)))
    (call $gdi_rgn_complexity_record (local.get $record)))

  (func $gdi_rgn_write_rect (param $record i32) (param $left i32) (param $top i32) (param $right i32) (param $bottom i32)
    (local $base i32)
    (local.set $base (call $gdi_rgn_bands (local.get $record)))
    (if (i32.or (i32.ge_s (local.get $left) (local.get $right))
          (i32.ge_s (local.get $top) (local.get $bottom)))
      (then (i32.store offset=28 (local.get $record) (i32.const 0)))
      (else
        (i32.store (local.get $base) (local.get $left))
        (i32.store offset=4 (local.get $base) (local.get $top))
        (i32.store offset=8 (local.get $base) (local.get $right))
        (i32.store offset=12 (local.get $base) (local.get $bottom))
        (i32.store offset=28 (local.get $record) (i32.const 1))))
    (call $gdi_rgn_update_bbox (local.get $record)))

  (func $gdi_rgn_alloc_rect (param $left_in i32) (param $top_in i32) (param $right_in i32) (param $bottom_in i32) (result i32)
    (local $left i32) (local $top i32) (local $right i32) (local $bottom i32)
    (local $slot i32) (local $record i32) (local $generation i32) (local $mirror i32)
    (local.set $left (local.get $left_in)) (local.set $top (local.get $top_in))
    (local.set $right (local.get $right_in)) (local.set $bottom (local.get $bottom_in))
    (if (i32.gt_s (local.get $left) (local.get $right))
      (then (local.set $left (local.get $right_in)) (local.set $right (local.get $left_in))))
    (if (i32.gt_s (local.get $top) (local.get $bottom))
      (then (local.set $top (local.get $bottom_in)) (local.set $bottom (local.get $top_in))))
    (local.set $slot (i32.const 0))
    (block $full
      (loop $scan
        (br_if $full (i32.ge_u (local.get $slot) (i32.const 255)))
        (local.set $record
          (i32.add (global.get $GDI_REGION_TABLE) (i32.mul (local.get $slot) (i32.const 32))))
        (if (i32.eqz (i32.load (local.get $record)))
          (then
            (local.set $generation
              (i32.and (i32.add (i32.load offset=4 (local.get $record)) (i32.const 1)) (i32.const 0xFF)))
            (if (i32.eqz (local.get $generation)) (then (local.set $generation (i32.const 1))))
            (local.set $mirror
              (i32.or (i32.const 0x00500000)
                (i32.or (i32.shl (local.get $generation) (i32.const 8))
                  (i32.add (local.get $slot) (i32.const 1)))))
            (i32.store (local.get $record) (i32.const 1))
            (i32.store offset=4 (local.get $record) (local.get $generation))
            (i32.store offset=8 (local.get $record) (local.get $left))
            (i32.store offset=12 (local.get $record) (local.get $top))
            (i32.store offset=16 (local.get $record) (local.get $right))
            (i32.store offset=20 (local.get $record) (local.get $bottom))
            (i32.store offset=24 (local.get $record) (local.get $mirror))
            (call $gdi_rgn_write_rect (local.get $record)
              (local.get $left) (local.get $top) (local.get $right) (local.get $bottom))
            (drop (call $gdi_rgn_sync_mirror (local.get $record)))
            (return (local.get $mirror))))
        (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
        (br $scan)))
    (i32.const 0))

  ;; Pixel-center ellipse coverage using the implicit equation
  ;; dx^2*h^2 + dy^2*w^2 <= w^2*h^2. All terms are i64 and dimensions are
  ;; capped so the doubled coordinates cannot overflow signed i32 first.
  (func $gdi_rgn_ellipse_inside (param $x i32) (param $y i32)
        (param $cx2 i32) (param $cy2 i32) (param $width i32) (param $height i32) (result i32)
    (local $dx i64) (local $dy i64) (local $w i64) (local $h i64)
    (local.set $dx (i64.extend_i32_s
      (i32.sub (i32.add (i32.shl (local.get $x) (i32.const 1)) (i32.const 1)) (local.get $cx2))))
    (local.set $dy (i64.extend_i32_s
      (i32.sub (i32.add (i32.shl (local.get $y) (i32.const 1)) (i32.const 1)) (local.get $cy2))))
    (local.set $w (i64.extend_i32_u (local.get $width)))
    (local.set $h (i64.extend_i32_u (local.get $height)))
    (i64.le_s
      (i64.add
        (i64.mul (i64.mul (local.get $dx) (local.get $dx)) (i64.mul (local.get $h) (local.get $h)))
        (i64.mul (i64.mul (local.get $dy) (local.get $dy)) (i64.mul (local.get $w) (local.get $w))))
      (i64.mul (i64.mul (local.get $w) (local.get $w)) (i64.mul (local.get $h) (local.get $h)))))

  (func $gdi_rgn_alloc_ellipse (param $left_in i32) (param $top_in i32) (param $right_in i32) (param $bottom_in i32) (result i32)
    (local $left i32) (local $top i32) (local $right i32) (local $bottom i32)
    (local $width i32) (local $height i32) (local $cx2 i32) (local $cy2 i32)
    (local $y i32) (local $lo i32) (local $hi i32) (local $mid i32) (local $center i32) (local $first i32) (local $last i32)
    (local $count i32) (local $p i32) (local $prev i32) (local $handle i32) (local $record i32)
    (local.set $left (local.get $left_in)) (local.set $top (local.get $top_in))
    (local.set $right (local.get $right_in)) (local.set $bottom (local.get $bottom_in))
    (if (i32.gt_s (local.get $left) (local.get $right))
      (then (local.set $left (local.get $right_in)) (local.set $right (local.get $left_in))))
    (if (i32.gt_s (local.get $top) (local.get $bottom))
      (then (local.set $top (local.get $bottom_in)) (local.set $bottom (local.get $top_in))))
    (local.set $width (i32.sub (local.get $right) (local.get $left)))
    (local.set $height (i32.sub (local.get $bottom) (local.get $top)))
    (if (i32.or (i32.le_s (local.get $width) (i32.const 0)) (i32.le_s (local.get $height) (i32.const 0)))
      (then (return (call $gdi_rgn_alloc_rect (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))))
    (if (i32.or (i32.gt_u (local.get $width) (i32.const 46340))
          (i32.gt_u (local.get $height) (i32.const 46340)))
      (then (return (i32.const 0))))
    (if (i32.or
          (i32.or (i32.lt_s (local.get $left) (i32.const -1073741824))
            (i32.gt_s (local.get $right) (i32.const 1073741823)))
          (i32.or (i32.lt_s (local.get $top) (i32.const -1073741824))
            (i32.gt_s (local.get $bottom) (i32.const 1073741823))))
      (then (return (i32.const 0))))
    (local.set $cx2 (i32.add (local.get $left) (local.get $right)))
    (local.set $cy2 (i32.add (local.get $top) (local.get $bottom)))
    (local.set $center (i32.add (local.get $left)
      (i32.shr_u (i32.sub (local.get $width) (i32.const 1)) (i32.const 1))))
    (local.set $y (local.get $top))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_s (local.get $y) (local.get $bottom)))
      (if (call $gdi_rgn_ellipse_inside
            (local.get $center) (local.get $y) (local.get $cx2) (local.get $cy2)
            (local.get $width) (local.get $height))
        (then
          ;; First covered x on the monotonic false-to-true left half.
          (local.set $lo (local.get $left))
          (local.set $hi (local.get $center))
          (block $left_done (loop $left_search
            (br_if $left_done (i32.ge_s (local.get $lo) (local.get $hi)))
            (local.set $mid (i32.add (local.get $lo)
              (i32.shr_u (i32.sub (local.get $hi) (local.get $lo)) (i32.const 1))))
            (if (call $gdi_rgn_ellipse_inside
                  (local.get $mid) (local.get $y) (local.get $cx2) (local.get $cy2)
                  (local.get $width) (local.get $height))
              (then (local.set $hi (local.get $mid)))
              (else (local.set $lo (i32.add (local.get $mid) (i32.const 1)))))
            (br $left_search)))
          (local.set $first (local.get $lo))
          ;; First uncovered x after the right half of the covered span.
          (local.set $lo (local.get $center))
          (local.set $hi (local.get $right))
          (block $right_done (loop $right_search
            (br_if $right_done (i32.ge_s (local.get $lo) (local.get $hi)))
            (local.set $mid (i32.add (local.get $lo)
              (i32.shr_u (i32.sub (local.get $hi) (local.get $lo)) (i32.const 1))))
            (if (call $gdi_rgn_ellipse_inside
                  (local.get $mid) (local.get $y) (local.get $cx2) (local.get $cy2)
                  (local.get $width) (local.get $height))
              (then (local.set $lo (i32.add (local.get $mid) (i32.const 1))))
              (else (local.set $hi (local.get $mid))))
            (br $right_search)))
          (local.set $last (local.get $lo))
          (if (i32.gt_u (local.get $count) (i32.const 0))
            (then (local.set $prev (i32.add (global.get $GDI_REGION_WORK)
              (i32.shl (i32.sub (local.get $count) (i32.const 1)) (i32.const 4))))))
          (if (i32.and (i32.gt_u (local.get $count) (i32.const 0))
                (i32.and (i32.eq (i32.load (local.get $prev)) (local.get $first))
                  (i32.and (i32.eq (i32.load offset=8 (local.get $prev)) (local.get $last))
                    (i32.eq (i32.load offset=12 (local.get $prev)) (local.get $y)))))
            (then (i32.store offset=12 (local.get $prev) (i32.add (local.get $y) (i32.const 1))))
            (else
              (if (i32.ge_u (local.get $count) (global.get $GDI_REGION_MAX_RECTS))
                (then (return (i32.const 0))))
              (local.set $p (i32.add (global.get $GDI_REGION_WORK)
                (i32.shl (local.get $count) (i32.const 4))))
              (i32.store (local.get $p) (local.get $first))
              (i32.store offset=4 (local.get $p) (local.get $y))
              (i32.store offset=8 (local.get $p) (local.get $last))
              (i32.store offset=12 (local.get $p) (i32.add (local.get $y) (i32.const 1)))
              (local.set $count (i32.add (local.get $count) (i32.const 1)))))))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows)))
    (local.set $handle (call $gdi_rgn_alloc_rect (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
    (if (i32.eqz (local.get $handle)) (then (return (i32.const 0))))
    (local.set $record (call $gdi_rgn_record (local.get $handle)))
    (drop (call $gdi_rgn_set_buffer
      (local.get $record) (global.get $GDI_REGION_WORK) (local.get $count)))
    (local.get $handle))

  (func $gdi_rgn_ceil_div_i64 (param $numerator i64) (param $denominator i64) (result i32)
    (local $q i64) (local $r i64)
    (local.set $q (i64.div_s (local.get $numerator) (local.get $denominator)))
    (local.set $r (i64.rem_s (local.get $numerator) (local.get $denominator)))
    (if (i64.gt_s (local.get $r) (i64.const 0))
      (then (local.set $q (i64.add (local.get $q) (i64.const 1)))))
    (i32.wrap_i64 (local.get $q)))

  (func $gdi_rgn_crossing_compare (param $a i32) (param $b i32) (result i32)
    (local $lhs i64) (local $rhs i64)
    (local.set $lhs (i64.mul (i64.load (local.get $a))
      (i64.extend_i32_u (i32.load offset=8 (local.get $b)))))
    (local.set $rhs (i64.mul (i64.load (local.get $b))
      (i64.extend_i32_u (i32.load offset=8 (local.get $a)))))
    (if (i64.lt_s (local.get $lhs) (local.get $rhs)) (then (return (i32.const -1))))
    (if (i64.gt_s (local.get $lhs) (local.get $rhs)) (then (return (i32.const 1))))
    (i32.const 0))

  ;; Scan convert one closed polygon at integer pixel centers. Horizontal
  ;; edges are omitted and the active interval is [minY,maxY), so shared
  ;; vertices contribute exactly once. Crossings retain rational numerators
  ;; and denominators until span endpoints are rounded.
  (func $gdi_rgn_alloc_polygon (param $points i32) (param $n i32) (param $fill_mode i32) (result i32)
    (local $out i32) (local $crossings i32) (local $row i32)
    (local $min_y i32) (local $max_y i32) (local $y i32) (local $i i32) (local $j i32)
    (local $x0 i32) (local $y0 i32) (local $x1 i32) (local $y1 i32)
    (local $low_x i32) (local $low_y i32) (local $high_x i32) (local $high_y i32)
    (local $dx i32) (local $dy i32) (local $wind i32) (local $cross_count i32)
    (local $p i32) (local $q i32) (local $k i32) (local $group_end i32)
    (local $group_wind i32) (local $inside i32) (local $next_inside i32)
    (local $boundary i32) (local $span_left i32) (local $row_count i32)
    (local $out_count i32) (local $prev_start i32) (local $prev_count i32) (local $same i32)
    (local $handle i32) (local $record i32) (local $numerator i64)
    (if (i32.or
          (i32.or (i32.eqz (local.get $points)) (i32.lt_u (local.get $n) (i32.const 3)))
          (i32.or (i32.gt_u (local.get $n) (global.get $GDI_REGION_MAX_RECTS))
            (i32.and (i32.ne (local.get $fill_mode) (i32.const 1))
              (i32.ne (local.get $fill_mode) (i32.const 2)))))
      (then
        (if (i32.and (i32.ne (local.get $points) (i32.const 0))
              (i32.lt_u (local.get $n) (i32.const 3)))
          (then (return (call $gdi_rgn_alloc_rect
            (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))))
        (return (i32.const 0))))
    (local.set $out (global.get $GDI_REGION_WORK))
    (local.set $crossings (i32.add (local.get $out) (global.get $GDI_REGION_RECT_STRIDE)))
    (local.set $row (i32.add (local.get $crossings) (global.get $GDI_REGION_RECT_STRIDE)))
    (local.set $min_y (i32.const 0x7FFFFFFF))
    (local.set $max_y (i32.const 0x80000000))
    (block $bounds_done (loop $bounds
      (br_if $bounds_done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $p (i32.add (local.get $points) (i32.shl (local.get $i) (i32.const 3))))
      (local.set $x0 (i32.load (local.get $p)))
      (local.set $y0 (i32.load offset=4 (local.get $p)))
      (if (i32.or
            (i32.or (i32.lt_s (local.get $x0) (i32.const -1000000))
              (i32.gt_s (local.get $x0) (i32.const 1000000)))
            (i32.or (i32.lt_s (local.get $y0) (i32.const -1000000))
              (i32.gt_s (local.get $y0) (i32.const 1000000))))
        (then (return (i32.const 0))))
      (if (i32.lt_s (local.get $y0) (local.get $min_y)) (then (local.set $min_y (local.get $y0))))
      (if (i32.gt_s (local.get $y0) (local.get $max_y)) (then (local.set $max_y (local.get $y0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $bounds)))
    (if (i32.gt_u (i32.sub (local.get $max_y) (local.get $min_y)) (i32.const 4096))
      (then (return (i32.const 0))))
    (local.set $prev_start (i32.const -1))
    (local.set $y (local.get $min_y))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_s (local.get $y) (local.get $max_y)))
      (local.set $cross_count (i32.const 0))
      (local.set $i (i32.const 0))
      (block $edges_done (loop $edges
        (br_if $edges_done (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $j (i32.add (local.get $i) (i32.const 1)))
        (if (i32.eq (local.get $j) (local.get $n)) (then (local.set $j (i32.const 0))))
        (local.set $p (i32.add (local.get $points) (i32.shl (local.get $i) (i32.const 3))))
        (local.set $q (i32.add (local.get $points) (i32.shl (local.get $j) (i32.const 3))))
        (local.set $x0 (i32.load (local.get $p)))
        (local.set $y0 (i32.load offset=4 (local.get $p)))
        (local.set $x1 (i32.load (local.get $q)))
        (local.set $y1 (i32.load offset=4 (local.get $q)))
        (if (i32.ne (local.get $y0) (local.get $y1))
          (then
            (if (i32.lt_s (local.get $y0) (local.get $y1))
              (then
                (local.set $low_x (local.get $x0)) (local.set $low_y (local.get $y0))
                (local.set $high_x (local.get $x1)) (local.set $high_y (local.get $y1))
                (local.set $wind (i32.const 1)))
              (else
                (local.set $low_x (local.get $x1)) (local.set $low_y (local.get $y1))
                (local.set $high_x (local.get $x0)) (local.set $high_y (local.get $y0))
                (local.set $wind (i32.const -1))))
            (if (i32.and (i32.ge_s (local.get $y) (local.get $low_y))
                  (i32.lt_s (local.get $y) (local.get $high_y)))
              (then
                (local.set $dx (i32.sub (local.get $high_x) (local.get $low_x)))
                (local.set $dy (i32.sub (local.get $high_y) (local.get $low_y)))
                (local.set $numerator
                  (i64.add
                    (i64.mul (i64.extend_i32_s (i32.shl (local.get $low_x) (i32.const 1)))
                      (i64.extend_i32_u (local.get $dy)))
                    (i64.mul
                      (i64.extend_i32_s (i32.sub
                        (i32.add (i32.shl (local.get $y) (i32.const 1)) (i32.const 1))
                        (i32.shl (local.get $low_y) (i32.const 1))))
                      (i64.extend_i32_s (local.get $dx)))))
                (local.set $p (i32.add (local.get $crossings)
                  (i32.shl (local.get $cross_count) (i32.const 4))))
                (i64.store (local.get $p) (local.get $numerator))
                (i32.store offset=8 (local.get $p) (local.get $dy))
                (i32.store offset=12 (local.get $p) (local.get $wind))
                ;; Stable insertion sort by exact rational x.
                (local.set $k (local.get $cross_count))
                (block $sort_done (loop $sort
                  (br_if $sort_done (i32.eqz (local.get $k)))
                  (local.set $q (i32.sub (local.get $p) (i32.const 16)))
                  (br_if $sort_done (i32.ge_s (call $gdi_rgn_crossing_compare
                    (local.get $p) (local.get $q)) (i32.const 0)))
                  (i64.store (i32.add (local.get $crossings)
                    (i32.shl (local.get $k) (i32.const 4))) (i64.load (local.get $q)))
                  (i32.store offset=8 (i32.add (local.get $crossings)
                    (i32.shl (local.get $k) (i32.const 4))) (i32.load offset=8 (local.get $q)))
                  (i32.store offset=12 (i32.add (local.get $crossings)
                    (i32.shl (local.get $k) (i32.const 4))) (i32.load offset=12 (local.get $q)))
                  (i64.store (local.get $q) (local.get $numerator))
                  (i32.store offset=8 (local.get $q) (local.get $dy))
                  (i32.store offset=12 (local.get $q) (local.get $wind))
                  (local.set $p (local.get $q))
                  (local.set $k (i32.sub (local.get $k) (i32.const 1)))
                  (br $sort)))
                (i64.store (local.get $p) (local.get $numerator))
                (i32.store offset=8 (local.get $p) (local.get $dy))
                (i32.store offset=12 (local.get $p) (local.get $wind))
                (local.set $cross_count (i32.add (local.get $cross_count) (i32.const 1)))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $edges)))
      (local.set $inside (i32.const 0))
      (local.set $row_count (i32.const 0))
      (local.set $i (i32.const 0))
      (block $groups_done (loop $groups
        (br_if $groups_done (i32.ge_u (local.get $i) (local.get $cross_count)))
        (local.set $p (i32.add (local.get $crossings) (i32.shl (local.get $i) (i32.const 4))))
        (local.set $group_end (i32.add (local.get $i) (i32.const 1)))
        (local.set $group_wind (i32.load offset=12 (local.get $p)))
        (block $group_done (loop $group
          (br_if $group_done (i32.ge_u (local.get $group_end) (local.get $cross_count)))
          (local.set $q (i32.add (local.get $crossings) (i32.shl (local.get $group_end) (i32.const 4))))
          (br_if $group_done (i32.ne (call $gdi_rgn_crossing_compare
            (local.get $p) (local.get $q)) (i32.const 0)))
          (local.set $group_wind (i32.add (local.get $group_wind) (i32.load offset=12 (local.get $q))))
          (local.set $group_end (i32.add (local.get $group_end) (i32.const 1)))
          (br $group)))
        (local.set $boundary (call $gdi_rgn_ceil_div_i64
          (i64.sub (i64.load (local.get $p)) (i64.extend_i32_u (i32.load offset=8 (local.get $p))))
          (i64.shl (i64.extend_i32_u (i32.load offset=8 (local.get $p))) (i64.const 1))))
        (if (i32.eq (local.get $fill_mode) (i32.const 1))
          (then (local.set $next_inside (i32.xor (local.get $inside)
            (i32.and (i32.sub (local.get $group_end) (local.get $i)) (i32.const 1)))))
          (else (local.set $next_inside (i32.add (local.get $inside) (local.get $group_wind)))))
        (if (i32.and (i32.eqz (local.get $inside)) (i32.ne (local.get $next_inside) (i32.const 0)))
          (then (local.set $span_left (local.get $boundary))))
        (if (i32.and (i32.ne (local.get $inside) (i32.const 0)) (i32.eqz (local.get $next_inside)))
          (then
            (if (i32.gt_s (local.get $boundary) (local.get $span_left))
              (then
                (if (i32.ge_u (local.get $row_count) (global.get $GDI_REGION_MAX_RECTS))
                  (then (return (i32.const 0))))
                (local.set $q (i32.add (local.get $row) (i32.shl (local.get $row_count) (i32.const 4))))
                (i32.store (local.get $q) (local.get $span_left))
                (i32.store offset=4 (local.get $q) (local.get $y))
                (i32.store offset=8 (local.get $q) (local.get $boundary))
                (i32.store offset=12 (local.get $q) (i32.add (local.get $y) (i32.const 1)))
                (local.set $row_count (i32.add (local.get $row_count) (i32.const 1)))))))
        (local.set $inside (local.get $next_inside))
        (local.set $i (local.get $group_end))
        (br $groups)))
      ;; Coalesce identical span sets on adjacent rows.
      (if (i32.eqz (local.get $row_count))
        (then (local.set $prev_start (i32.const -1)) (local.set $prev_count (i32.const 0)))
        (else
          (local.set $same (i32.and (i32.ge_s (local.get $prev_start) (i32.const 0))
            (i32.eq (local.get $prev_count) (local.get $row_count))))
          (local.set $i (i32.const 0))
          (block $compare_done (loop $compare
            (br_if $compare_done (i32.or (i32.eqz (local.get $same))
              (i32.ge_u (local.get $i) (local.get $row_count))))
            (local.set $p (i32.add (local.get $out)
              (i32.shl (i32.add (local.get $prev_start) (local.get $i)) (i32.const 4))))
            (local.set $q (i32.add (local.get $row) (i32.shl (local.get $i) (i32.const 4))))
            (if (i32.or (i32.ne (i32.load (local.get $p)) (i32.load (local.get $q)))
                  (i32.or (i32.ne (i32.load offset=8 (local.get $p)) (i32.load offset=8 (local.get $q)))
                    (i32.ne (i32.load offset=12 (local.get $p)) (local.get $y))))
              (then (local.set $same (i32.const 0))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $compare)))
          (if (local.get $same)
            (then
              (local.set $i (i32.const 0))
              (block $extend_done (loop $extend
                (br_if $extend_done (i32.ge_u (local.get $i) (local.get $row_count)))
                (i32.store offset=12 (i32.add (local.get $out)
                  (i32.shl (i32.add (local.get $prev_start) (local.get $i)) (i32.const 4)))
                  (i32.add (local.get $y) (i32.const 1)))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (br $extend))))
            (else
              (if (i32.gt_u (i32.add (local.get $out_count) (local.get $row_count))
                    (global.get $GDI_REGION_MAX_RECTS))
                (then (return (i32.const 0))))
              (memory.copy (i32.add (local.get $out) (i32.shl (local.get $out_count) (i32.const 4)))
                (local.get $row) (i32.shl (local.get $row_count) (i32.const 4)))
              (local.set $prev_start (local.get $out_count))
              (local.set $prev_count (local.get $row_count))
              (local.set $out_count (i32.add (local.get $out_count) (local.get $row_count)))))))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows)))
    (local.set $handle (call $gdi_rgn_alloc_rect (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
    (if (i32.eqz (local.get $handle)) (then (return (i32.const 0))))
    (local.set $record (call $gdi_rgn_record (local.get $handle)))
    (drop (call $gdi_rgn_set_buffer (local.get $record) (local.get $out) (local.get $out_count)))
    (local.get $handle))

  (func (export "test_gdi_rgn_alloc_polygon")
        (param $points i32) (param $n i32) (param $fill_mode i32) (result i32)
    (call $gdi_rgn_alloc_polygon
      (local.get $points) (local.get $n) (local.get $fill_mode)))

  (func $gdi_rgn_alloc_poly_polygon (param $points i32) (param $counts i32)
        (param $polygon_count i32) (param $fill_mode i32) (result i32)
    (local $result i32) (local $polygon i32) (local $count i32)
    (local $index i32) (local $point_offset i32) (local $complexity i32)
    (if (i32.or (i32.eqz (local.get $points))
          (i32.or (i32.eqz (local.get $counts))
            (i32.or (i32.le_s (local.get $polygon_count) (i32.const 0))
              (i32.or (i32.gt_u (local.get $polygon_count) (global.get $GDI_REGION_MAX_RECTS))
                (i32.and (i32.ne (local.get $fill_mode) (i32.const 1))
                  (i32.ne (local.get $fill_mode) (i32.const 2)))))))
      (then (return (i32.const 0))))
    (local.set $result (call $gdi_rgn_alloc_rect
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
    (if (i32.eqz (local.get $result)) (then (return (i32.const 0))))
    (block $done (loop $polygons
      (br_if $done (i32.ge_u (local.get $index) (local.get $polygon_count)))
      (local.set $count (i32.load
        (i32.add (local.get $counts) (i32.shl (local.get $index) (i32.const 2)))))
      (if (i32.gt_u (local.get $count) (global.get $GDI_REGION_MAX_RECTS))
        (then (drop (call $gdi_rgn_delete (local.get $result)))
          (return (i32.const 0))))
      (local.set $polygon (call $gdi_rgn_alloc_polygon
        (i32.add (local.get $points) (i32.shl (local.get $point_offset) (i32.const 3)))
        (local.get $count) (local.get $fill_mode)))
      (if (i32.eqz (local.get $polygon))
        (then (drop (call $gdi_rgn_delete (local.get $result)))
          (return (i32.const 0))))
      (local.set $complexity (call $gdi_rgn_combine
        (local.get $result) (local.get $result) (local.get $polygon) (i32.const 2)))
      (drop (call $gdi_rgn_delete (local.get $polygon)))
      (if (i32.eqz (local.get $complexity))
        (then (drop (call $gdi_rgn_delete (local.get $result)))
          (return (i32.const 0))))
      (if (i32.gt_u (local.get $point_offset)
            (i32.sub (i32.const 0x1FFFFFFF) (local.get $count)))
        (then (drop (call $gdi_rgn_delete (local.get $result)))
          (return (i32.const 0))))
      (local.set $point_offset (i32.add (local.get $point_offset) (local.get $count)))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $polygons)))
    (local.get $result))

  (func $gdi_rgn_point_in (param $hrgn i32) (param $x i32) (param $y i32) (result i32)
    (local $record i32)
    (local.set $record (call $gdi_rgn_record (local.get $hrgn)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (call $gdi_rgn_contains (call $gdi_rgn_bands (local.get $record))
      (i32.load offset=28 (local.get $record)) (local.get $x) (local.get $y)))

  (func $gdi_rgn_get_data (param $hrgn i32) (param $size i32)
        (param $data i32) (result i32)
    (local $record i32) (local $count i32) (local $rect_bytes i32) (local $required i32)
    (local.set $record (call $gdi_rgn_record (local.get $hrgn)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (local.set $count (i32.load offset=28 (local.get $record)))
    (local.set $rect_bytes (i32.shl (local.get $count) (i32.const 4)))
    (local.set $required (i32.add (i32.const 32) (local.get $rect_bytes)))
    (if (i32.or (i32.eqz (local.get $data)) (i32.eqz (local.get $size)))
      (then (return (local.get $required))))
    (if (i32.lt_u (local.get $size) (local.get $required))
      (then (return (i32.const 0))))
    (memory.fill (local.get $data) (i32.const 0) (local.get $required))
    (i32.store (local.get $data) (i32.const 32))
    (i32.store offset=4 (local.get $data) (i32.const 1))
    (i32.store offset=8 (local.get $data) (local.get $count))
    (i32.store offset=12 (local.get $data) (local.get $rect_bytes))
    (i32.store offset=16 (local.get $data) (i32.load offset=8 (local.get $record)))
    (i32.store offset=20 (local.get $data) (i32.load offset=12 (local.get $record)))
    (i32.store offset=24 (local.get $data) (i32.load offset=16 (local.get $record)))
    (i32.store offset=28 (local.get $data) (i32.load offset=20 (local.get $record)))
    (if (local.get $rect_bytes)
      (then (memory.copy (i32.add (local.get $data) (i32.const 32))
        (call $gdi_rgn_bands (local.get $record)) (local.get $rect_bytes))))
    (local.get $required))

  ;; ---- WAT-owned explicit HDC clipping -------------------------------
  (func $gdi_dc_clip_entry (param $hdc i32) (param $create i32) (result i32)
    (local $i i32) (local $p i32) (local $empty i32)
    (if (i32.eqz (local.get $hdc)) (then (return (i32.const 0))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_DC_CLIP_COUNT)))
      (local.set $p (i32.add (global.get $GDI_DC_CLIP_TABLE) (i32.shl (local.get $i) (i32.const 3))))
      (if (i32.eq (i32.load (local.get $p)) (local.get $hdc)) (then (return (local.get $p))))
      (if (i32.and (i32.eqz (local.get $empty)) (i32.eqz (i32.load (local.get $p))))
        (then (local.set $empty (local.get $p))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.and (i32.ne (local.get $create) (i32.const 0))
          (i32.ne (local.get $empty) (i32.const 0)))
      (then
        (i32.store (local.get $empty) (local.get $hdc))
        (i32.store offset=4 (local.get $empty) (i32.const 0))
        (return (local.get $empty))))
    (i32.const 0))

  (func $gdi_dc_clip_sync (param $hdc i32) (param $entry i32) (result i32)
    (local $hrgn i32)
    (local.set $hrgn (i32.load offset=4 (local.get $entry)))
    (call $gdi_rgn_get_box (local.get $hrgn) (i32.const 0)))

  (func $gdi_dc_clip_clear (param $hdc i32) (result i32)
    (local $entry i32) (local $hrgn i32)
    (local.set $entry (call $gdi_dc_clip_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $entry)
      (then
        (local.set $hrgn (i32.load offset=4 (local.get $entry)))
        (if (local.get $hrgn) (then (drop (call $gdi_rgn_delete (local.get $hrgn)))))
        (i32.store (local.get $entry) (i32.const 0))
        (i32.store offset=4 (local.get $entry) (i32.const 0))))
    (i32.const 1))

  (func $gdi_dc_clip_release (param $hdc i32)
    (local $entry i32) (local $hrgn i32)
    (local.set $entry (call $gdi_dc_clip_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $entry)
      (then
        (local.set $hrgn (i32.load offset=4 (local.get $entry)))
        (if (local.get $hrgn) (then (drop (call $gdi_rgn_delete (local.get $hrgn)))))
        (i32.store (local.get $entry) (i32.const 0))
        (i32.store offset=4 (local.get $entry) (i32.const 0))))
    (call $gdi_dc_system_clip_release (local.get $hdc)))

  ;; USER's visible region is derived from window hierarchy/style state. Keep
  ;; it independent from the application-selected clip so GetClipRgn and
  ;; SaveDC continue to expose only application state.
  (func $gdi_dc_system_clip_entry (param $hdc i32) (param $create i32) (result i32)
    (local $i i32) (local $entry i32) (local $empty i32)
    (if (i32.eqz (local.get $hdc)) (then (return (i32.const 0))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_DC_SYSTEM_CLIP_COUNT)))
      (local.set $entry (i32.add (global.get $GDI_DC_SYSTEM_CLIP_TABLE)
        (i32.shl (local.get $i) (i32.const 3))))
      (if (i32.eq (i32.load (local.get $entry)) (local.get $hdc))
        (then (return (local.get $entry))))
      (if (i32.and (i32.eqz (local.get $empty))
            (i32.eqz (i32.load (local.get $entry))))
        (then (local.set $empty (local.get $entry))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.and (i32.ne (local.get $create) (i32.const 0))
          (i32.ne (local.get $empty) (i32.const 0)))
      (then
        (i32.store (local.get $empty) (local.get $hdc))
        (i32.store offset=4 (local.get $empty) (i32.const 0))
        (return (local.get $empty))))
    (i32.const 0))

  (func $gdi_dc_system_clip_handle (param $hdc i32) (result i32)
    (local $entry i32)
    (local.set $entry (call $gdi_dc_system_clip_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $entry) (then (return (i32.load offset=4 (local.get $entry)))))
    (i32.const 0))

  (func $gdi_dc_system_clip_release (param $hdc i32)
    (local $entry i32) (local $clip i32)
    (local.set $entry (call $gdi_dc_system_clip_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $entry)
      (then
        (local.set $clip (i32.load offset=4 (local.get $entry)))
        (if (local.get $clip) (then (drop (call $gdi_rgn_delete (local.get $clip)))))
        (i64.store (local.get $entry) (i64.const 0)))))

  (func $gdi_dc_system_clip_reset (param $hdc i32) (result i32)
    (local $entry i32) (local $old i32) (local $clip i32)
    (local.set $clip (call $gdi_dc_clip_default_region (local.get $hdc)))
    (if (i32.eqz (local.get $clip)) (then (return (i32.const 0))))
    (local.set $entry (call $gdi_dc_system_clip_entry (local.get $hdc) (i32.const 1)))
    (if (i32.eqz (local.get $entry))
      (then
        (drop (call $gdi_rgn_delete (local.get $clip)))
        (return (i32.const 0))))
    (local.set $old (i32.load offset=4 (local.get $entry)))
    (i32.store offset=4 (local.get $entry) (local.get $clip))
    (if (local.get $old) (then (drop (call $gdi_rgn_delete (local.get $old)))))
    (call $gdi_rgn_get_box (local.get $clip) (i32.const 0)))

  (func $gdi_dc_system_clip_rect (param $hdc i32)
        (param $left i32) (param $top i32) (param $right i32) (param $bottom i32)
        (param $mode i32) (result i32)
    (local $entry i32) (local $clip i32) (local $rect i32) (local $result i32)
    (if (i32.and (i32.ne (local.get $mode) (i32.const 1))
          (i32.ne (local.get $mode) (i32.const 4)))
      (then (return (i32.const 0))))
    (local.set $entry (call $gdi_dc_system_clip_entry (local.get $hdc) (i32.const 0)))
    (if (i32.or (i32.eqz (local.get $entry))
          (i32.eqz (i32.load offset=4 (local.get $entry))))
      (then
        (if (i32.eqz (call $gdi_dc_system_clip_reset (local.get $hdc)))
          (then (return (i32.const 0))))
        (local.set $entry (call $gdi_dc_system_clip_entry (local.get $hdc) (i32.const 0)))))
    (local.set $clip (i32.load offset=4 (local.get $entry)))
    (local.set $rect (call $gdi_rgn_alloc_rect
      (local.get $left) (local.get $top) (local.get $right) (local.get $bottom)))
    (if (i32.eqz (local.get $rect)) (then (return (i32.const 0))))
    (local.set $result (call $gdi_rgn_combine
      (local.get $clip) (local.get $clip) (local.get $rect) (local.get $mode)))
    (drop (call $gdi_rgn_delete (local.get $rect)))
    (local.get $result))

  ;; Return a temporary owned HRGN for target bounds AND app clip AND USER
  ;; visible region. The caller must delete it. Raster hot paths avoid this
  ;; allocation and test the two retained regions directly.
  (func $gdi_dc_effective_clip_region (param $hdc i32) (result i32)
    (local $result i32) (local $entry i32) (local $app i32) (local $system i32)
    (local $size i32) (local $copied_app i32) (local $copied_system i32)
    (local.set $entry (call $gdi_dc_clip_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $entry) (then (local.set $app (i32.load offset=4 (local.get $entry)))))
    (local.set $system (call $gdi_dc_system_clip_handle (local.get $hdc)))
    (local.set $size (call $gdi_dc_target_size (local.get $hdc)))
    (if (local.get $size)
      (then (local.set $result (call $gdi_dc_clip_default_region (local.get $hdc))))
      (else
        ;; Region-only synthetic DCs have no target bounds. Preserve the
        ;; retained clip contract used by clip queries and unit harnesses.
        (local.set $result (call $gdi_rgn_alloc_rect
          (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
        (if (i32.and (i32.ne (local.get $result) (i32.const 0))
              (i32.ne (local.get $app) (i32.const 0)))
          (then
            (if (i32.eqz (call $gdi_rgn_combine
                  (local.get $result) (local.get $app) (i32.const 0) (i32.const 5)))
              (then
                (drop (call $gdi_rgn_delete (local.get $result)))
                (return (i32.const 0))))
            (local.set $copied_app (i32.const 1))))
        (if (i32.and (i32.ne (local.get $result) (i32.const 0))
              (i32.and (i32.eqz (local.get $app))
                (i32.ne (local.get $system) (i32.const 0))))
          (then
            (if (i32.eqz (call $gdi_rgn_combine
                  (local.get $result) (local.get $system) (i32.const 0) (i32.const 5)))
              (then
                (drop (call $gdi_rgn_delete (local.get $result)))
                (return (i32.const 0))))
            (local.set $copied_system (i32.const 1))))))
    (if (i32.eqz (local.get $result)) (then (return (i32.const 0))))
    (if (i32.and (i32.ne (local.get $app) (i32.const 0))
          (i32.eqz (local.get $copied_app)))
      (then
        (if (i32.eqz (call $gdi_rgn_combine
              (local.get $result) (local.get $result) (local.get $app) (i32.const 1)))
          (then
            (drop (call $gdi_rgn_delete (local.get $result)))
            (return (i32.const 0))))))
    (if (i32.and (i32.ne (local.get $system) (i32.const 0))
          (i32.eqz (local.get $copied_system)))
      (then
        (if (i32.eqz (call $gdi_rgn_combine
              (local.get $result) (local.get $result) (local.get $system) (i32.const 1)))
          (then
            (drop (call $gdi_rgn_delete (local.get $result)))
            (return (i32.const 0))))))
    (local.get $result))

  (func $gdi_dc_path_entry (param $hdc i32) (param $create i32) (result i32)
    (local $i i32) (local $entry i32) (local $empty i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_DC_PATH_COUNT)))
      (local.set $entry (i32.add (global.get $GDI_DC_PATH_TABLE)
        (i32.mul (local.get $i) (global.get $GDI_DC_PATH_STRIDE))))
      (if (i32.eq (i32.load (local.get $entry)) (local.get $hdc))
        (then (return (local.get $entry))))
      (if (i32.and (i32.eqz (local.get $empty))
            (i32.eqz (i32.load (local.get $entry))))
        (then (local.set $empty (local.get $entry))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.and (i32.ne (local.get $create) (i32.const 0))
          (i32.ne (local.get $empty) (i32.const 0)))
      (then
        (memory.fill (local.get $empty) (i32.const 0) (global.get $GDI_DC_PATH_STRIDE))
        (i32.store (local.get $empty) (local.get $hdc))
        (return (local.get $empty))))
    (i32.const 0))

  ;; Install a closed path by value. The caller may delete or mutate the source
  ;; HRGN without changing the path retained by the DC.
  (func $gdi_dc_path_set_region (param $hdc i32) (param $source i32) (result i32)
    (local $entry i32) (local $copy i32) (local $old i32)
    (if (i32.or
          (i32.eqz (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
          (i32.eqz (call $gdi_rgn_record (local.get $source))))
      (then (return (i32.const 0))))
    (local.set $copy (call $gdi_rgn_alloc_rect
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
    (if (i32.eqz (local.get $copy)) (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_rgn_combine
          (local.get $copy) (local.get $source) (i32.const 0) (i32.const 5)))
      (then
        (drop (call $gdi_rgn_delete (local.get $copy)))
        (return (i32.const 0))))
    (local.set $entry (call $gdi_dc_path_entry (local.get $hdc) (i32.const 1)))
    (if (i32.eqz (local.get $entry))
      (then
        (drop (call $gdi_rgn_delete (local.get $copy)))
        (return (i32.const 0))))
    (local.set $old (i32.load offset=4 (local.get $entry)))
    (i32.store offset=4 (local.get $entry) (local.get $copy))
    (i32.store offset=8 (local.get $entry) (i32.const 2))
    (if (local.get $old) (then (drop (call $gdi_rgn_delete (local.get $old)))))
    (i32.const 1))

  (func $gdi_dc_path_select_clip (param $hdc i32) (param $mode i32) (result i32)
    (local $entry i32) (local $result i32)
    (if (i32.or (i32.lt_u (local.get $mode) (i32.const 1))
          (i32.gt_u (local.get $mode) (i32.const 5)))
      (then (return (i32.const 0))))
    (local.set $entry (call $gdi_dc_path_entry (local.get $hdc) (i32.const 0)))
    (if (i32.or (i32.eqz (local.get $entry))
          (i32.or (i32.ne (i32.load offset=8 (local.get $entry)) (i32.const 2))
            (i32.eqz (call $gdi_rgn_record (i32.load offset=4 (local.get $entry))))))
      (then (return (i32.const 0))))
    (local.set $result (call $gdi_dc_clip_ext_select
      (local.get $hdc) (i32.load offset=4 (local.get $entry)) (local.get $mode)))
    (i32.ne (local.get $result) (i32.const 0)))

  (func $gdi_dc_path_release (param $hdc i32)
    (local $entry i32) (local $path i32)
    (local.set $entry (call $gdi_dc_path_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $entry)
      (then
        (local.set $path (i32.load offset=4 (local.get $entry)))
        (if (local.get $path) (then (drop (call $gdi_rgn_delete (local.get $path)))))
        (memory.fill (local.get $entry) (i32.const 0) (global.get $GDI_DC_PATH_STRIDE)))))

  (func $gdi_dc_clip_select (param $hdc i32) (param $source i32) (result i32)
    (local $entry i32) (local $clip i32) (local $source_record i32)
    (if (i32.eqz (local.get $source)) (then (return (call $gdi_dc_clip_clear (local.get $hdc)))))
    (local.set $source_record (call $gdi_rgn_record (local.get $source)))
    (if (i32.eqz (local.get $source_record)) (then (return (i32.const 0))))
    (local.set $entry (call $gdi_dc_clip_entry (local.get $hdc) (i32.const 1)))
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (local.set $clip (i32.load offset=4 (local.get $entry)))
    (if (i32.eqz (local.get $clip))
      (then
        (local.set $clip (call $gdi_rgn_alloc_rect
          (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
        (if (i32.eqz (local.get $clip)) (then (return (i32.const 0))))
        (i32.store offset=4 (local.get $entry) (local.get $clip))))
    (if (i32.eqz (call $gdi_rgn_combine
          (local.get $clip) (local.get $source) (i32.const 0) (i32.const 5)))
      (then (return (i32.const 0))))
    (drop (call $gdi_dc_clip_sync (local.get $hdc) (local.get $entry)))
    (call $gdi_rgn_get_box (local.get $clip) (i32.const 0)))

  (func $gdi_dc_clip_default_region (param $hdc i32) (result i32)
    (local $size i32)
    (local.set $size (call $gdi_dc_target_size (local.get $hdc)))
    (call $gdi_rgn_alloc_rect
      (i32.const 0) (i32.const 0)
      (i32.and (local.get $size) (i32.const 0xFFFF))
      (i32.shr_u (local.get $size) (i32.const 16))))

  (func $gdi_dc_clip_ext_select (param $hdc i32) (param $source i32) (param $mode i32) (result i32)
    (local $entry i32) (local $clip i32) (local $base i32) (local $result i32)
    (if (i32.eq (local.get $mode) (i32.const 5))
      (then (return (call $gdi_dc_clip_select (local.get $hdc) (local.get $source)))))
    (if (i32.or (i32.lt_u (local.get $mode) (i32.const 1)) (i32.gt_u (local.get $mode) (i32.const 4)))
      (then (return (i32.const 0))))
    (if (i32.eqz (local.get $source)) (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_rgn_record (local.get $source)))
      (then (return (i32.const 0))))
    (local.set $entry (call $gdi_dc_clip_entry (local.get $hdc) (i32.const 0)))
    (if (i32.or (i32.eqz (local.get $entry)) (i32.eqz (i32.load offset=4 (local.get $entry))))
      (then
        (local.set $base (call $gdi_dc_clip_default_region (local.get $hdc)))
        (if (i32.eqz (local.get $base)) (then (return (i32.const 0))))
        (local.set $result (call $gdi_rgn_combine
          (local.get $base) (local.get $base) (local.get $source) (local.get $mode)))
        (if (i32.eqz (local.get $result))
          (then
            (drop (call $gdi_rgn_delete (local.get $base)))
            (return (i32.const 0))))
        (local.set $result (call $gdi_dc_clip_select (local.get $hdc) (local.get $base)))
        (drop (call $gdi_rgn_delete (local.get $base)))
        (return (local.get $result))))
    (local.set $clip (i32.load offset=4 (local.get $entry)))
    (local.set $result (call $gdi_rgn_combine
      (local.get $clip) (local.get $clip) (local.get $source) (local.get $mode)))
    (if (i32.eqz (local.get $result)) (then (return (i32.const 0))))
    (drop (call $gdi_dc_clip_sync (local.get $hdc) (local.get $entry)))
    (local.get $result))

  ;; Explicit clips are retained in DC device coordinates, matching USER's
  ;; visible region and the canonical surface rasterizer. Logical rectangle
  ;; APIs transform once when the clip is changed; later map-mode changes do
  ;; not reinterpret the retained region.
  (func $gdi_dc_clip_map_x (param $hdc i32) (param $x i32) (result i32)
    (local $desc i32)
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc))
      (then (return (i32.sub
        (call $gdi_line_map_x (local.get $desc) (local.get $x))
        (i32.load offset=72 (local.get $desc))))))
    (local.get $x))

  (func $gdi_dc_clip_map_y (param $hdc i32) (param $y i32) (result i32)
    (local $desc i32)
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc))
      (then (return (i32.sub
        (call $gdi_line_map_y (local.get $desc) (local.get $y))
        (i32.load offset=76 (local.get $desc))))))
    (local.get $y))

  (func $gdi_dc_clip_intersect_rect (param $hdc i32) (param $left i32) (param $top i32)
        (param $right i32) (param $bottom i32) (result i32)
    (local $rect i32) (local $result i32) (local $swap i32)
    (local.set $left (call $gdi_dc_clip_map_x (local.get $hdc) (local.get $left)))
    (local.set $right (call $gdi_dc_clip_map_x (local.get $hdc) (local.get $right)))
    (local.set $top (call $gdi_dc_clip_map_y (local.get $hdc) (local.get $top)))
    (local.set $bottom (call $gdi_dc_clip_map_y (local.get $hdc) (local.get $bottom)))
    (if (i32.gt_s (local.get $left) (local.get $right))
      (then (local.set $swap (local.get $left))
        (local.set $left (local.get $right)) (local.set $right (local.get $swap))))
    (if (i32.gt_s (local.get $top) (local.get $bottom))
      (then (local.set $swap (local.get $top))
        (local.set $top (local.get $bottom)) (local.set $bottom (local.get $swap))))
    (local.set $rect (call $gdi_rgn_alloc_rect
      (local.get $left) (local.get $top) (local.get $right) (local.get $bottom)))
    (if (i32.eqz (local.get $rect)) (then (return (i32.const 0))))
    (local.set $result (call $gdi_dc_clip_ext_select
      (local.get $hdc) (local.get $rect) (i32.const 1)))
    (drop (call $gdi_rgn_delete (local.get $rect)))
    (local.get $result))

  (func $gdi_dc_clip_exclude_rect (param $hdc i32) (param $left i32) (param $top i32)
        (param $right i32) (param $bottom i32) (result i32)
    (local $cut i32) (local $result i32) (local $swap i32)
    (local.set $left (call $gdi_dc_clip_map_x (local.get $hdc) (local.get $left)))
    (local.set $right (call $gdi_dc_clip_map_x (local.get $hdc) (local.get $right)))
    (local.set $top (call $gdi_dc_clip_map_y (local.get $hdc) (local.get $top)))
    (local.set $bottom (call $gdi_dc_clip_map_y (local.get $hdc) (local.get $bottom)))
    (if (i32.gt_s (local.get $left) (local.get $right))
      (then (local.set $swap (local.get $left))
        (local.set $left (local.get $right)) (local.set $right (local.get $swap))))
    (if (i32.gt_s (local.get $top) (local.get $bottom))
      (then (local.set $swap (local.get $top))
        (local.set $top (local.get $bottom)) (local.set $bottom (local.get $swap))))
    (local.set $cut (call $gdi_rgn_alloc_rect
      (local.get $left) (local.get $top) (local.get $right) (local.get $bottom)))
    (if (i32.eqz (local.get $cut)) (then (return (i32.const 0))))
    (local.set $result (call $gdi_dc_clip_ext_select
      (local.get $hdc) (local.get $cut) (i32.const 4)))
    (drop (call $gdi_rgn_delete (local.get $cut)))
    (local.get $result))

  (func $gdi_dc_clip_offset (param $hdc i32) (param $dx i32) (param $dy i32) (result i32)
    (local $entry i32) (local $base i32) (local $result i32)
    (local.set $dx (i32.sub
      (call $gdi_dc_clip_map_x (local.get $hdc) (local.get $dx))
      (call $gdi_dc_clip_map_x (local.get $hdc) (i32.const 0))))
    (local.set $dy (i32.sub
      (call $gdi_dc_clip_map_y (local.get $hdc) (local.get $dy))
      (call $gdi_dc_clip_map_y (local.get $hdc) (i32.const 0))))
    (local.set $entry (call $gdi_dc_clip_entry (local.get $hdc) (i32.const 0)))
    (if (i32.or (i32.eqz (local.get $entry)) (i32.eqz (i32.load offset=4 (local.get $entry))))
      (then
        (local.set $base (call $gdi_dc_clip_default_region (local.get $hdc)))
        (if (i32.eqz (local.get $base)) (then (return (i32.const 0))))
        (local.set $result (call $gdi_rgn_offset
          (local.get $base) (local.get $dx) (local.get $dy)))
        (if (i32.eqz (local.get $result))
          (then
            (drop (call $gdi_rgn_delete (local.get $base)))
            (return (i32.const 0))))
        (local.set $result (call $gdi_dc_clip_select (local.get $hdc) (local.get $base)))
        (drop (call $gdi_rgn_delete (local.get $base)))
        (return (local.get $result))))
    (local.set $result (call $gdi_rgn_offset
      (i32.load offset=4 (local.get $entry)) (local.get $dx) (local.get $dy)))
    (if (local.get $result) (then (drop (call $gdi_dc_clip_sync (local.get $hdc) (local.get $entry)))))
    (local.get $result))

  (func $gdi_dc_clip_get (param $hdc i32) (param $dest i32) (result i32)
    (local $entry i32)
    (if (i32.eqz (call $gdi_rgn_record (local.get $dest)))
      (then (return (i32.const -1))))
    (local.set $entry (call $gdi_dc_clip_entry (local.get $hdc) (i32.const 0)))
    (if (i32.or (i32.eqz (local.get $entry)) (i32.eqz (i32.load offset=4 (local.get $entry))))
      (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_rgn_combine
          (local.get $dest) (i32.load offset=4 (local.get $entry)) (i32.const 0) (i32.const 5)))
      (then (return (i32.const -1))))
    (i32.const 1))

  (func $gdi_dc_clip_get_box (param $hdc i32) (param $rect i32) (result i32)
    (local $effective i32) (local $result i32) (local $desc i32)
    (local $left i32) (local $top i32) (local $right i32) (local $bottom i32) (local $swap i32)
    (local.set $effective (call $gdi_dc_effective_clip_region (local.get $hdc)))
    (if (i32.eqz (local.get $effective)) (then (return (i32.const 0))))
    (local.set $result (call $gdi_rgn_get_box (local.get $effective) (local.get $rect)))
    (drop (call $gdi_rgn_delete (local.get $effective)))
    ;; GetClipBox reports logical units even though the retained effective
    ;; region is device-space state.
    (if (i32.and (i32.ne (local.get $rect) (i32.const 0))
          (i32.ne (local.get $result) (i32.const 0)))
      (then
        (local.set $desc (global.get $GDI_LINE_DESC))
        (if (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc))
          (then
            (local.set $left (call $gdi_shape_unmap_x (local.get $desc)
              (i32.add (i32.load (local.get $rect)) (i32.load offset=72 (local.get $desc)))))
            (local.set $top (call $gdi_shape_unmap_y (local.get $desc)
              (i32.add (i32.load offset=4 (local.get $rect)) (i32.load offset=76 (local.get $desc)))))
            (local.set $right (call $gdi_shape_unmap_x (local.get $desc)
              (i32.add (i32.load offset=8 (local.get $rect)) (i32.load offset=72 (local.get $desc)))))
            (local.set $bottom (call $gdi_shape_unmap_y (local.get $desc)
              (i32.add (i32.load offset=12 (local.get $rect)) (i32.load offset=76 (local.get $desc)))))
            (if (i32.gt_s (local.get $left) (local.get $right))
              (then (local.set $swap (local.get $left))
                (local.set $left (local.get $right)) (local.set $right (local.get $swap))))
            (if (i32.gt_s (local.get $top) (local.get $bottom))
              (then (local.set $swap (local.get $top))
                (local.set $top (local.get $bottom)) (local.set $bottom (local.get $swap))))
            (i32.store (local.get $rect) (local.get $left))
            (i32.store offset=4 (local.get $rect) (local.get $top))
            (i32.store offset=8 (local.get $rect) (local.get $right))
            (i32.store offset=12 (local.get $rect) (local.get $bottom))))))
    (local.get $result))

  (func $gdi_dc_clip_device_point_visible (param $hdc i32) (param $x i32) (param $y i32) (result i32)
    (local $entry i32) (local $record i32) (local $size i32) (local $clip i32)
    ;; Surface bounds are always part of the effective clipping region.
    (local.set $size (call $gdi_dc_target_size (local.get $hdc)))
    (if (i32.and (local.get $size) (i32.eqz (i32.and
          (i32.and (i32.ge_s (local.get $x) (i32.const 0))
            (i32.lt_s (local.get $x) (i32.and (local.get $size) (i32.const 0xFFFF))))
          (i32.and (i32.ge_s (local.get $y) (i32.const 0))
            (i32.lt_s (local.get $y) (i32.shr_u (local.get $size) (i32.const 16)))))))
      (then (return (i32.const 0))))
    (local.set $entry (call $gdi_dc_clip_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $entry) (then (local.set $clip (i32.load offset=4 (local.get $entry)))))
    (if (local.get $clip)
      (then
        (local.set $record (call $gdi_rgn_record (local.get $clip)))
        (if (i32.or (i32.eqz (local.get $record))
              (i32.eqz (call $gdi_rgn_contains
                (call $gdi_rgn_bands (local.get $record))
                (i32.load offset=28 (local.get $record))
                (local.get $x) (local.get $y))))
          (then (return (i32.const 0))))))
    (local.set $clip (call $gdi_dc_system_clip_handle (local.get $hdc)))
    (if (local.get $clip)
      (then
        (local.set $record (call $gdi_rgn_record (local.get $clip)))
        (if (i32.or (i32.eqz (local.get $record))
              (i32.eqz (call $gdi_rgn_contains
                (call $gdi_rgn_bands (local.get $record))
                (i32.load offset=28 (local.get $record))
                (local.get $x) (local.get $y))))
          (then (return (i32.const 0))))))
    (i32.const 1))

  (func $gdi_dc_clip_point_visible (param $hdc i32) (param $x i32) (param $y i32) (result i32)
    (call $gdi_dc_clip_device_point_visible (local.get $hdc)
      (call $gdi_dc_clip_map_x (local.get $hdc) (local.get $x))
      (call $gdi_dc_clip_map_y (local.get $hdc) (local.get $y))))

  (func $gdi_dc_clip_rect_visible (param $hdc i32) (param $rect i32) (result i32)
    (local $effective i32) (local $record i32) (local $base i32) (local $count i32)
    (local $i i32) (local $p i32) (local $visible i32) (local $swap i32)
    (local $left i32) (local $top i32) (local $right i32) (local $bottom i32)
    (if (i32.eqz (local.get $rect)) (then (return (i32.const 0))))
    (local.set $left (call $gdi_dc_clip_map_x
      (local.get $hdc) (i32.load (local.get $rect))))
    (local.set $top (call $gdi_dc_clip_map_y
      (local.get $hdc) (i32.load offset=4 (local.get $rect))))
    (local.set $right (call $gdi_dc_clip_map_x
      (local.get $hdc) (i32.load offset=8 (local.get $rect))))
    (local.set $bottom (call $gdi_dc_clip_map_y
      (local.get $hdc) (i32.load offset=12 (local.get $rect))))
    (if (i32.gt_s (local.get $left) (local.get $right))
      (then (local.set $swap (local.get $left))
        (local.set $left (local.get $right)) (local.set $right (local.get $swap))))
    (if (i32.gt_s (local.get $top) (local.get $bottom))
      (then (local.set $swap (local.get $top))
        (local.set $top (local.get $bottom)) (local.set $bottom (local.get $swap))))
    (local.set $effective (call $gdi_dc_effective_clip_region (local.get $hdc)))
    (if (i32.eqz (local.get $effective)) (then (return (i32.const 0))))
    (local.set $record (call $gdi_rgn_record (local.get $effective)))
    (local.set $base (call $gdi_rgn_bands (local.get $record)))
    (local.set $count (i32.load offset=28 (local.get $record)))
    (block $miss (loop $scan
      (br_if $miss (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $p (i32.add (local.get $base) (i32.shl (local.get $i) (i32.const 4))))
      (if (i32.and
            (i32.and (i32.lt_s (i32.load (local.get $p)) (local.get $right))
              (i32.gt_s (i32.load offset=8 (local.get $p)) (local.get $left)))
            (i32.and (i32.lt_s (i32.load offset=4 (local.get $p)) (local.get $bottom))
              (i32.gt_s (i32.load offset=12 (local.get $p)) (local.get $top))))
        (then (local.set $visible (i32.const 1)) (br $miss)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (drop (call $gdi_rgn_delete (local.get $effective)))
    (local.get $visible))

  ;; ---- WAT-owned GDI objects and DC state ------------------------------
  ;; Object records use 48 bytes. Types are 1=pen, 2=brush, 3=bitmap,
  ;; 4=font, 5=palette, 6=WMF, 7=EMF. Font records keep height@8, weight@12, italic@16;
  ;; glyph data and face resolution remain in the Canvas text policy.
  ;; Bitmap fields are width@8, height@12, bpp@16, flags@20 (DIB/top-down),
  ;; bitsWa@24, stride@28, paletteWa@32, paletteCount@36, surfaceId@40.
  ;; Palette fields are count@8, capacity@12, version@16, flags@20,
  ;; PALETTEENTRY storage WA@24. Palette storage is always WAT-owned.
  (func $gdi_object_record (param $handle i32) (result i32)
    (local $i i32) (local $p i32)
    (if (i32.eqz (local.get $handle)) (then (return (i32.const 0))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_OBJECT_COUNT)))
      (local.set $p (i32.add (global.get $GDI_OBJECT_TABLE)
        (i32.mul (local.get $i) (global.get $GDI_OBJECT_STRIDE))))
      (if (i32.eq (i32.load (local.get $p)) (local.get $handle))
        (then (return (local.get $p))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  (func $gdi_object_adopt (param $handle i32) (param $type i32) (param $style i32)
        (param $width i32) (param $color i32) (param $flags i32) (result i32)
    (local $i i32) (local $p i32) (local $empty i32)
    (if (i32.or (i32.eqz (local.get $handle))
          (i32.or (i32.lt_u (local.get $type) (i32.const 1))
            (i32.gt_u (local.get $type) (i32.const 7))))
      (then (return (i32.const 0))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_OBJECT_COUNT)))
      (local.set $p (i32.add (global.get $GDI_OBJECT_TABLE)
        (i32.mul (local.get $i) (global.get $GDI_OBJECT_STRIDE))))
      (if (i32.eq (i32.load (local.get $p)) (local.get $handle))
        (then (local.set $empty (local.get $p)) (br $done)))
      (if (i32.and (i32.eqz (local.get $empty)) (i32.eqz (i32.load (local.get $p))))
        (then (local.set $empty (local.get $p))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.eqz (local.get $empty)) (then (return (i32.const 0))))
    (i32.store (local.get $empty) (local.get $handle))
    (i32.store offset=4 (local.get $empty) (local.get $type))
    (i32.store offset=8 (local.get $empty) (local.get $style))
    (i32.store offset=12 (local.get $empty) (local.get $width))
    (i32.store offset=16 (local.get $empty) (i32.and (local.get $color) (i32.const 0xFFFFFF)))
    (i32.store offset=20 (local.get $empty) (local.get $flags))
    (local.get $handle))

  (func $gdi_object_alloc (param $type i32) (param $a i32) (param $b i32)
        (param $c i32) (param $d i32) (result i32)
    (local $handle i32) (local $attempts i32)
    ;; Worker WASM instances share the process object table but begin with a
    ;; fresh copy of the handle-counter global. Skip handles already allocated
    ;; by another thread instead of letting gdi_object_adopt overwrite the live
    ;; record (notably the main thread's canonical screen bitmap).
    (block $available (loop $scan
      (if (i32.ge_u (local.get $attempts) (global.get $GDI_OBJECT_COUNT))
        (then (return (i32.const 0))))
      (local.set $handle (global.get $gdi_next_object_handle))
      (global.set $gdi_next_object_handle
        (i32.add (local.get $handle) (i32.const 1)))
      (if (i32.eqz (call $gdi_object_record (local.get $handle)))
        (then (br $available)))
      (local.set $attempts (i32.add (local.get $attempts) (i32.const 1)))
      (br $scan)))
    (if (i32.eqz (call $gdi_object_adopt (local.get $handle) (local.get $type)
          (local.get $a) (local.get $b) (local.get $c) (local.get $d)))
      (then (return (i32.const 0))))
    (local.get $handle))

  (func $gdi_palette_record (param $handle i32) (result i32)
    (local $record i32)
    (local.set $record (call $gdi_object_record (local.get $handle)))
    (if (i32.and (i32.ne (local.get $record) (i32.const 0))
          (i32.eq (i32.load offset=4 (local.get $record)) (i32.const 5)))
      (then (return (local.get $record))))
    (i32.const 0))

  ;; The stock DEFAULT_PALETTE contains the 20 static system colors. Values
  ;; use COLORREF/PALETTEENTRY byte order (0x00BBGGRR).
  (func $gdi_default_palette_colorref (param $index i32) (result i32)
    (if (i32.eq (local.get $index) (i32.const 0)) (then (return (i32.const 0x000000))))
    (if (i32.eq (local.get $index) (i32.const 1)) (then (return (i32.const 0x000080))))
    (if (i32.eq (local.get $index) (i32.const 2)) (then (return (i32.const 0x008000))))
    (if (i32.eq (local.get $index) (i32.const 3)) (then (return (i32.const 0x008080))))
    (if (i32.eq (local.get $index) (i32.const 4)) (then (return (i32.const 0x800000))))
    (if (i32.eq (local.get $index) (i32.const 5)) (then (return (i32.const 0x800080))))
    (if (i32.eq (local.get $index) (i32.const 6)) (then (return (i32.const 0x808000))))
    (if (i32.eq (local.get $index) (i32.const 7)) (then (return (i32.const 0xC0C0C0))))
    (if (i32.eq (local.get $index) (i32.const 8)) (then (return (i32.const 0xC0DCC0))))
    (if (i32.eq (local.get $index) (i32.const 9)) (then (return (i32.const 0xF0CAA6))))
    (if (i32.eq (local.get $index) (i32.const 10)) (then (return (i32.const 0xF0FBFF))))
    (if (i32.eq (local.get $index) (i32.const 11)) (then (return (i32.const 0xA4A0A0))))
    (if (i32.eq (local.get $index) (i32.const 12)) (then (return (i32.const 0x808080))))
    (if (i32.eq (local.get $index) (i32.const 13)) (then (return (i32.const 0x0000FF))))
    (if (i32.eq (local.get $index) (i32.const 14)) (then (return (i32.const 0x00FF00))))
    (if (i32.eq (local.get $index) (i32.const 15)) (then (return (i32.const 0x00FFFF))))
    (if (i32.eq (local.get $index) (i32.const 16)) (then (return (i32.const 0xFF0000))))
    (if (i32.eq (local.get $index) (i32.const 17)) (then (return (i32.const 0xFF00FF))))
    (if (i32.eq (local.get $index) (i32.const 18)) (then (return (i32.const 0xFFFF00))))
    (if (i32.eq (local.get $index) (i32.const 19)) (then (return (i32.const 0xFFFFFF))))
    (i32.const 0))

  (func $gdi_palette_count (param $handle i32) (result i32)
    (local $record i32)
    (if (i32.eq (local.get $handle) (i32.const 0x3001F))
      (then (return (i32.const 20))))
    (local.set $record (call $gdi_palette_record (local.get $handle)))
    (if (local.get $record) (then (return (i32.load offset=8 (local.get $record)))))
    (i32.const 0))

  (func $gdi_palette_colorref (param $handle i32) (param $index i32) (result i32)
    (local $record i32) (local $entries i32)
    (if (i32.eq (local.get $handle) (i32.const 0x3001F))
      (then
        (if (i32.lt_u (local.get $index) (i32.const 20))
          (then (return (call $gdi_default_palette_colorref (local.get $index)))))
        (return (i32.const -1))))
    (local.set $record (call $gdi_palette_record (local.get $handle)))
    (if (i32.or (i32.eqz (local.get $record))
          (i32.ge_u (local.get $index) (i32.load offset=8 (local.get $record))))
      (then (return (i32.const -1))))
    (local.set $entries (i32.load offset=24 (local.get $record)))
    (if (i32.eqz (local.get $entries)) (then (return (i32.const -1))))
    (i32.and (i32.load (i32.add (local.get $entries)
      (i32.shl (local.get $index) (i32.const 2)))) (i32.const 0x00FFFFFF)))

  (func $gdi_palette_alloc (param $entries i32) (param $count i32)
        (param $version i32) (result i32)
    (local $storage_ga i32) (local $storage i32) (local $handle i32) (local $record i32)
    (if (i32.gt_u (local.get $count) (i32.const 256))
      (then (return (i32.const 0))))
    (local.set $storage_ga (call $dib_alloc (i32.const 1024)))
    (if (i32.eqz (local.get $storage_ga)) (then (return (i32.const 0))))
    (local.set $storage (call $g2w (local.get $storage_ga)))
    (memory.fill (local.get $storage) (i32.const 0) (i32.const 1024))
    (if (i32.and (i32.ne (local.get $count) (i32.const 0))
          (i32.ne (local.get $entries) (i32.const 0)))
      (then (memory.copy (local.get $storage) (local.get $entries)
        (i32.shl (local.get $count) (i32.const 2)))))
    (local.set $handle (call $gdi_object_alloc (i32.const 5)
      (local.get $count) (i32.const 256) (local.get $version) (i32.const 4)))
    (if (i32.eqz (local.get $handle))
      (then
        (call $dib_free_wasm (local.get $storage))
        (return (i32.const 0))))
    (local.set $record (call $gdi_palette_record (local.get $handle)))
    (i32.store offset=24 (local.get $record) (local.get $storage))
    (local.get $handle))

  (func $gdi_palette_get_entries (param $handle i32) (param $start i32)
        (param $count_in i32) (param $dest i32) (result i32)
    (local $record i32) (local $total i32) (local $count i32) (local $i i32)
    (local.set $total (call $gdi_palette_count (local.get $handle)))
    (if (i32.eqz (local.get $dest)) (then (return (local.get $total))))
    (if (i32.ge_u (local.get $start) (local.get $total))
      (then (return (i32.const 0))))
    (local.set $count (local.get $count_in))
    (if (i32.gt_u (local.get $count) (i32.sub (local.get $total) (local.get $start)))
      (then (local.set $count (i32.sub (local.get $total) (local.get $start)))))
    (local.set $record (call $gdi_palette_record (local.get $handle)))
    (if (local.get $record)
      (then (memory.copy (local.get $dest)
        (i32.add (i32.load offset=24 (local.get $record))
          (i32.shl (local.get $start) (i32.const 2)))
        (i32.shl (local.get $count) (i32.const 2))))
      (else
        (block $done (loop $copy_stock
          (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
          (i32.store (i32.add (local.get $dest) (i32.shl (local.get $i) (i32.const 2)))
            (call $gdi_default_palette_colorref
              (i32.add (local.get $start) (local.get $i))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $copy_stock)))))
    (local.get $count))

  (func $gdi_palette_set_entries (param $handle i32) (param $start i32)
        (param $count_in i32) (param $src i32) (result i32)
    (local $record i32) (local $total i32) (local $count i32)
    (local.set $record (call $gdi_palette_record (local.get $handle)))
    (if (i32.or (i32.eqz (local.get $record)) (i32.eqz (local.get $src)))
      (then (return (i32.const 0))))
    (local.set $total (i32.load offset=8 (local.get $record)))
    (if (i32.ge_u (local.get $start) (local.get $total))
      (then (return (i32.const 0))))
    (local.set $count (local.get $count_in))
    (if (i32.gt_u (local.get $count) (i32.sub (local.get $total) (local.get $start)))
      (then (local.set $count (i32.sub (local.get $total) (local.get $start)))))
    (memory.copy (i32.add (i32.load offset=24 (local.get $record))
        (i32.shl (local.get $start) (i32.const 2)))
      (local.get $src) (i32.shl (local.get $count) (i32.const 2)))
    (local.get $count))

  (func $gdi_palette_animate (param $handle i32) (param $start i32)
        (param $count i32) (param $src i32) (result i32)
    (local $record i32) (local $total i32) (local $entries i32)
    (local $i i32) (local $old i32) (local $replacement i32)
    (local.set $record (call $gdi_palette_record (local.get $handle)))
    (if (i32.or (i32.eqz (local.get $record)) (i32.eqz (local.get $src)))
      (then (return (i32.const 0))))
    (local.set $total (i32.load offset=8 (local.get $record)))
    (if (i32.or (i32.gt_u (local.get $start) (local.get $total))
          (i32.gt_u (local.get $count) (i32.sub (local.get $total) (local.get $start))))
      (then (return (i32.const 0))))
    (local.set $entries (i32.load offset=24 (local.get $record)))
    (block $done (loop $animate
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $old (i32.load (i32.add (local.get $entries)
        (i32.shl (i32.add (local.get $start) (local.get $i)) (i32.const 2)))))
      (if (i32.ne (i32.and (i32.shr_u (local.get $old) (i32.const 24))
            (i32.const 1)) (i32.const 0))
        (then
          (local.set $replacement (i32.load (i32.add (local.get $src)
            (i32.shl (local.get $i) (i32.const 2)))))
          (i32.store (i32.add (local.get $entries)
              (i32.shl (i32.add (local.get $start) (local.get $i)) (i32.const 2)))
            (i32.or (i32.and (local.get $replacement) (i32.const 0x00FFFFFF))
              (i32.and (local.get $old) (i32.const 0xFF000000))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $animate)))
    (i32.const 1))

  (func $gdi_palette_resize (param $handle i32) (param $count i32) (result i32)
    (local $record i32) (local $old i32) (local $entries i32)
    (if (i32.gt_u (local.get $count) (i32.const 256))
      (then (return (i32.const 0))))
    (local.set $record (call $gdi_palette_record (local.get $handle)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (local.set $old (i32.load offset=8 (local.get $record)))
    (local.set $entries (i32.load offset=24 (local.get $record)))
    (if (i32.gt_u (local.get $count) (local.get $old))
      (then (memory.fill
        (i32.add (local.get $entries) (i32.shl (local.get $old) (i32.const 2)))
        (i32.const 0)
        (i32.shl (i32.sub (local.get $count) (local.get $old)) (i32.const 2)))))
    (i32.store offset=8 (local.get $record) (local.get $count))
    (i32.const 1))

  (func $gdi_palette_nearest_index (param $handle i32) (param $color i32) (result i32)
    (local $count i32) (local $i i32) (local $candidate i32)
    (local $dr i64) (local $dg i64) (local $db i64) (local $distance i64)
    (local $best_distance i64) (local $best i32)
    (local.set $count (call $gdi_palette_count (local.get $handle)))
    (if (i32.eqz (local.get $count)) (then (return (i32.const -1))))
    (local.set $best_distance (i64.const 0x7FFFFFFFFFFFFFFF))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $candidate (call $gdi_palette_colorref
        (local.get $handle) (local.get $i)))
      (local.set $dr (i64.extend_i32_s (i32.sub
        (i32.and (local.get $candidate) (i32.const 0xFF))
        (i32.and (local.get $color) (i32.const 0xFF)))))
      (local.set $dg (i64.extend_i32_s (i32.sub
        (i32.and (i32.shr_u (local.get $candidate) (i32.const 8)) (i32.const 0xFF))
        (i32.and (i32.shr_u (local.get $color) (i32.const 8)) (i32.const 0xFF)))))
      (local.set $db (i64.extend_i32_s (i32.sub
        (i32.and (i32.shr_u (local.get $candidate) (i32.const 16)) (i32.const 0xFF))
        (i32.and (i32.shr_u (local.get $color) (i32.const 16)) (i32.const 0xFF)))))
      (local.set $distance (i64.add (i64.add (i64.mul (local.get $dr) (local.get $dr))
        (i64.mul (local.get $dg) (local.get $dg))) (i64.mul (local.get $db) (local.get $db))))
      (if (i64.lt_u (local.get $distance) (local.get $best_distance))
        (then
          (local.set $best_distance (local.get $distance))
          (local.set $best (local.get $i))
          (if (i64.eqz (local.get $distance)) (then (return (local.get $i))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $best))

  ;; Per-DC cold metadata uses the former raster-mirror table. Each fixed
  ;; entry owns a 28-byte heap record: selected palette at +0, SaveDC stack
  ;; head guest pointer at +4, graphics mode at +8, system palette use at +12,
  ;; the immutable-once-set pixel format index at +16, and private recording
  ;; DC kind/owned bitmap fields at +20/+24. ROP2 already lives in the
  ;; canonical hot DC record, so no separate raster mirror remains.
  (func $gdi_dc_meta_entry (param $hdc i32) (param $create i32) (result i32)
    (local $i i32) (local $p i32) (local $empty i32)
    (local $meta_g i32)
    (if (i32.eqz (local.get $hdc)) (then (return (i32.const 0))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_DC_SAVE_COUNT)))
      (local.set $p (i32.add (global.get $GDI_DC_SAVE_TABLE)
        (i32.shl (local.get $i) (i32.const 3))))
      (if (i32.eq (i32.load (local.get $p)) (local.get $hdc))
        (then
          (local.set $meta_g (i32.load offset=4 (local.get $p)))
          (if (local.get $meta_g)
            (then (return (call $g2w (local.get $meta_g)))))
          (local.set $empty (local.get $p))
          (br $done)))
      (if (i32.and (i32.eqz (local.get $empty)) (i32.eqz (i32.load (local.get $p))))
        (then (local.set $empty (local.get $p))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.or (i32.eqz (local.get $create)) (i32.eqz (local.get $empty)))
      (then (return (i32.const 0))))
    (local.set $meta_g (call $heap_alloc (i32.const 28)))
    (if (i32.eqz (local.get $meta_g)) (then (return (i32.const 0))))
    (memory.fill (call $g2w (local.get $meta_g)) (i32.const 0) (i32.const 28))
    (i32.store offset=8 (call $g2w (local.get $meta_g)) (i32.const 1))
    (i32.store offset=12 (call $g2w (local.get $meta_g)) (i32.const 1))
    (i32.store (local.get $empty) (local.get $hdc))
    (i32.store offset=4 (local.get $empty) (local.get $meta_g))
    (call $g2w (local.get $meta_g)))

  (func $gdi_dc_selected_palette (param $hdc i32) (result i32)
    (local $meta i32) (local $palette i32)
    (local.set $meta (call $gdi_dc_meta_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $meta)
      (then (local.set $palette (i32.load (local.get $meta)))))
    (select (local.get $palette) (i32.const 0x3001F)
      (i32.ne (local.get $palette) (i32.const 0))))

  (func $gdi_dc_select_palette (param $hdc i32) (param $palette i32) (result i32)
    (local $meta i32) (local $previous i32)
    (if (i32.or (i32.eqz (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
          (i32.ne (call $gdi_object_type (local.get $palette)) (i32.const 5)))
      (then (return (i32.const -1))))
    (local.set $meta (call $gdi_dc_meta_entry (local.get $hdc) (i32.const 1)))
    (if (i32.eqz (local.get $meta)) (then (return (i32.const -1))))
    (local.set $previous (i32.load (local.get $meta)))
    (i32.store (local.get $meta) (local.get $palette))
    (select (local.get $previous) (i32.const 0x3001F)
      (i32.ne (local.get $previous) (i32.const 0))))

  (func $gdi_dc_meta_get (param $hdc i32) (param $offset i32)
        (param $default i32) (result i32)
    (local $meta i32)
    (local.set $meta (call $gdi_dc_meta_entry (local.get $hdc) (i32.const 0)))
    (if (result i32) (local.get $meta)
      (then (i32.load (i32.add (local.get $meta) (local.get $offset))))
      (else (local.get $default))))

  (func $gdi_dc_meta_set (param $hdc i32) (param $offset i32)
        (param $value i32) (param $default i32) (result i32)
    (local $meta i32) (local $previous i32)
    (if (i32.eqz (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
      (then (return (i32.const 0))))
    (local.set $meta (call $gdi_dc_meta_entry (local.get $hdc) (i32.const 1)))
    (if (i32.eqz (local.get $meta)) (then (return (i32.const 0))))
    (local.set $previous (i32.load (i32.add (local.get $meta) (local.get $offset))))
    (if (i32.eqz (local.get $previous)) (then (local.set $previous (local.get $default))))
    (i32.store (i32.add (local.get $meta) (local.get $offset)) (local.get $value))
    (local.get $previous))

  (func $gdi_bitmap_alloc (param $width i32) (param $height i32) (param $bpp i32)
        (param $flags i32) (param $bits i32) (param $stride i32)
        (param $palette i32) (param $palette_count i32) (result i32)
    (local $handle i32) (local $p i32)
    (local.set $handle (call $gdi_object_alloc (i32.const 3)
      (local.get $width) (local.get $height) (local.get $bpp) (local.get $flags)))
    (if (i32.eqz (local.get $handle)) (then (return (i32.const 0))))
    (local.set $p (call $gdi_object_record (local.get $handle)))
    (i32.store offset=24 (local.get $p) (local.get $bits))
    (i32.store offset=28 (local.get $p) (local.get $stride))
    (i32.store offset=32 (local.get $p) (local.get $palette))
    (i32.store offset=36 (local.get $p) (local.get $palette_count))
    (i32.store offset=40 (local.get $p) (local.get $handle))
    (if (i32.eqz (call $host_gdi_surface_create
          (local.get $handle) (local.get $width) (local.get $height)
          (local.get $bpp) (local.get $bits) (local.get $stride)
          (i32.and (i32.shr_u (local.get $flags) (i32.const 1)) (i32.const 1))
          (local.get $palette) (local.get $palette_count)
          (select (i32.load (local.get $palette)) (i32.const 0)
            (i32.and (i32.eq (local.get $bpp) (i32.const 16))
              (i32.eq (local.get $palette_count) (i32.const 3))))
          (select (i32.load offset=4 (local.get $palette)) (i32.const 0)
            (i32.and (i32.eq (local.get $bpp) (i32.const 16))
              (i32.eq (local.get $palette_count) (i32.const 3))))
          (select (i32.load offset=8 (local.get $palette)) (i32.const 0)
            (i32.and (i32.eq (local.get $bpp) (i32.const 16))
              (i32.eq (local.get $palette_count) (i32.const 3))))))
      (then
        (drop (call $gdi_object_delete (local.get $handle)))
        (return (i32.const 0))))
    (local.get $handle))

  (func $gdi_object_type (param $handle i32) (result i32)
    (local $p i32)
    ;; Compatible memory DCs start with a stock 1x1 monochrome bitmap.  MFC
    ;; selects it back after using a temporary DDB, so it must participate in
    ;; the same selection round trip even though it has no allocated record.
    (if (i32.or (i32.eq (local.get $handle) (i32.const 0x30007))
          (i32.eq (local.get $handle) (i32.const 0x30001)))
      (then (return (i32.const 3))))
    (if (i32.and (i32.ge_u (local.get $handle) (i32.const 0x30010))
          (i32.le_u (local.get $handle) (i32.const 0x30015)))
      (then (return (i32.const 2))))
    (if (i32.and (i32.ge_u (local.get $handle) (i32.const 0x30016))
          (i32.le_u (local.get $handle) (i32.const 0x30018)))
      (then (return (i32.const 1))))
    (if (i32.and (i32.ge_u (local.get $handle) (i32.const 0x3001A))
          (i32.le_u (local.get $handle) (i32.const 0x30022)))
      (then
        (if (i32.eq (local.get $handle) (i32.const 0x3001F))
          (then (return (i32.const 5))))
        (return (i32.const 4))))
    (local.set $p (call $gdi_object_record (local.get $handle)))
    (if (local.get $p) (then (return (i32.load offset=4 (local.get $p)))))
    (i32.const 0))

  (func $gdi_stock_object_color (param $handle i32) (result i32)
    (if (i32.eq (local.get $handle) (i32.const 0x30010)) (then (return (i32.const 0xFFFFFF))))
    (if (i32.eq (local.get $handle) (i32.const 0x30011)) (then (return (i32.const 0xC0C0C0))))
    (if (i32.eq (local.get $handle) (i32.const 0x30012)) (then (return (i32.const 0x808080))))
    (if (i32.eq (local.get $handle) (i32.const 0x30013)) (then (return (i32.const 0x404040))))
    (if (i32.eq (local.get $handle) (i32.const 0x30014)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $handle) (i32.const 0x30016)) (then (return (i32.const 0xFFFFFF))))
    (i32.const 0))

  (func $gdi_object_color (param $handle i32) (result i32)
    (local $p i32)
    (local.set $p (call $gdi_object_record (local.get $handle)))
    (if (local.get $p) (then (return (i32.load offset=16 (local.get $p)))))
    (call $gdi_stock_object_color (local.get $handle)))

  (func $gdi_object_style (param $handle i32) (result i32)
    (local $p i32)
    (local.set $p (call $gdi_object_record (local.get $handle)))
    (if (local.get $p) (then (return (i32.load offset=8 (local.get $p)))))
    (select (i32.const 5) (i32.const 0)
      (i32.eq (local.get $handle) (i32.const 0x30018))))

  (func $gdi_object_width (param $handle i32) (result i32)
    (local $p i32) (local $width i32)
    (local.set $p (call $gdi_object_record (local.get $handle)))
    (if (local.get $p)
      (then
        (local.set $width (i32.load offset=12 (local.get $p)))
        (if (i32.le_s (local.get $width) (i32.const 0))
          (then (local.set $width (i32.const 1))))
        (return (local.get $width))))
    (i32.const 1))

  (func $gdi_object_delete (param $handle i32) (result i32)
    (local $p i32)
    (if (call $gdi_object_type (local.get $handle))
      (then
        (local.set $p (call $gdi_object_record (local.get $handle)))
        (if (local.get $p) (then (memory.fill (local.get $p) (i32.const 0) (global.get $GDI_OBJECT_STRIDE))))
        (return (i32.const 1))))
    (i32.const 0))

  (func $gdi_bitmap_storage (param $handle i32) (result i32)
    (local $p i32)
    (local.set $p (call $gdi_object_record (local.get $handle)))
    (if (i32.and (i32.ne (local.get $p) (i32.const 0))
          (i32.eq (i32.load offset=4 (local.get $p)) (i32.const 3)))
      (then (return (i32.load offset=24 (local.get $p)))))
    (i32.const 0))

  (func $gdi_bitmap_public_bits (param $handle i32) (result i32)
    (local $p i32)
    (local.set $p (call $gdi_object_record (local.get $handle)))
    (if (i32.and (i32.ne (local.get $p) (i32.const 0))
          (i32.and (i32.eq (i32.load offset=4 (local.get $p)) (i32.const 3))
            (i32.ne (i32.and (i32.load offset=20 (local.get $p)) (i32.const 1)) (i32.const 0))))
      (then (return (i32.load offset=24 (local.get $p)))))
    (i32.const 0))

  (func $gdi_bitmap_bpp (param $handle i32) (result i32)
    (local $p i32)
    (local.set $p (call $gdi_object_record (local.get $handle)))
    (if (i32.and (i32.ne (local.get $p) (i32.const 0))
          (i32.eq (i32.load offset=4 (local.get $p)) (i32.const 3)))
      (then (return (i32.load offset=16 (local.get $p)))))
    (i32.const 0))

  ;; Opaque classic/enhanced metafile byte objects. Recording/playback support
  ;; may interpret these streams later; ownership and transport are canonical
  ;; WAT semantics now. Object types 6 and 7 denote WMF and EMF respectively.
  (func $gdi_metafile_create (param $type i32) (param $src i32)
        (param $size i32) (result i32)
    (local $allocation i32) (local $guest i32) (local $bits i32)
    (local $handle i32) (local $record i32)
    (if (i32.or
          (i32.and (i32.ne (local.get $type) (i32.const 6))
            (i32.ne (local.get $type) (i32.const 7)))
          (i32.or (i32.gt_u (local.get $size) (global.get $DIB_BACKING_BASE_SIZE))
            (i32.and (i32.gt_u (local.get $size) (i32.const 0))
              (i32.eqz (local.get $src)))))
      (then (return (i32.const 0))))
    (local.set $allocation (select (local.get $size) (i32.const 4)
      (i32.ne (local.get $size) (i32.const 0))))
    (local.set $guest (call $dib_alloc (local.get $allocation)))
    (if (i32.eqz (local.get $guest)) (then (return (i32.const 0))))
    (local.set $bits (call $g2w (local.get $guest)))
    (memory.fill (local.get $bits) (i32.const 0) (local.get $allocation))
    (if (local.get $size)
      (then (memory.copy (local.get $bits) (local.get $src) (local.get $size))))
    (local.set $handle (call $gdi_object_alloc (local.get $type)
      (local.get $size) (i32.const 0) (i32.const 0) (i32.const 4)))
    (if (i32.eqz (local.get $handle))
      (then (call $dib_free_wasm (local.get $bits)) (return (i32.const 0))))
    (local.set $record (call $gdi_object_record (local.get $handle)))
    (i32.store offset=24 (local.get $record) (local.get $bits))
    (local.get $handle))

  (func $gdi_metafile_record (param $handle i32) (param $type i32) (result i32)
    (local $record i32)
    (local.set $record (call $gdi_object_record (local.get $handle)))
    (if (result i32) (i32.and (i32.ne (local.get $record) (i32.const 0))
          (i32.eq (i32.load offset=4 (local.get $record)) (local.get $type)))
      (then (local.get $record)) (else (i32.const 0))))

  (func $gdi_metafile_bits (param $handle i32) (param $type i32)
        (param $size i32) (param $dst i32) (result i32)
    (local $record i32) (local $available i32) (local $copy i32)
    (local.set $record (call $gdi_metafile_record (local.get $handle) (local.get $type)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (local.set $available (i32.load offset=8 (local.get $record)))
    (if (i32.eqz (local.get $dst)) (then (return (local.get $available))))
    (local.set $copy (local.get $size))
    (if (i32.gt_u (local.get $copy) (local.get $available))
      (then (local.set $copy (local.get $available))))
    (if (local.get $copy)
      (then (memory.copy (local.get $dst) (i32.load offset=24 (local.get $record))
        (local.get $copy))))
    (local.get $copy))

  (func $gdi_metafile_copy (param $handle i32) (param $type i32) (result i32)
    (local $record i32)
    (local.set $record (call $gdi_metafile_record (local.get $handle) (local.get $type)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (call $gdi_metafile_create (local.get $type)
      (i32.load offset=24 (local.get $record)) (i32.load offset=8 (local.get $record))))

  (func $gdi_metafile_valid_wmf (param $data i32) (param $size i32) (result i32)
    (if (result i32) (i32.ge_u (local.get $size) (i32.const 18))
      (then (i32.and
        (i32.or (i32.eq (i32.load16_u (local.get $data)) (i32.const 1))
          (i32.eq (i32.load16_u (local.get $data)) (i32.const 2)))
        (i32.eq (i32.load16_u offset=2 (local.get $data)) (i32.const 9))))
      (else (i32.const 0))))

  (func $gdi_metafile_valid_emf (param $data i32) (param $size i32) (result i32)
    (if (result i32) (i32.ge_u (local.get $size) (i32.const 88))
      (then (i32.and
        (i32.and (i32.eq (i32.load (local.get $data)) (i32.const 1))
          (i32.ge_u (i32.load offset=4 (local.get $data)) (i32.const 88)))
        (i32.and (i32.eq (i32.load offset=40 (local.get $data)) (i32.const 0x464D4520))
          (i32.le_u (i32.load offset=48 (local.get $data)) (local.get $size)))))
      (else (i32.const 0))))

  (func $gdi_metafile_empty_wmf (result i32)
    (local $p i32)
    (local.set $p (global.get $GDI_BITMAP_PLAN))
    (memory.fill (local.get $p) (i32.const 0) (i32.const 24))
    (i32.store16 (local.get $p) (i32.const 1))
    (i32.store16 offset=2 (local.get $p) (i32.const 9))
    (i32.store16 offset=4 (local.get $p) (i32.const 0x0300))
    (i32.store offset=6 (local.get $p) (i32.const 12))
    (i32.store offset=12 (local.get $p) (i32.const 3))
    (i32.store offset=18 (local.get $p) (i32.const 3))
    (call $gdi_metafile_create (i32.const 6) (local.get $p) (i32.const 24)))

  (func $gdi_metafile_recording_bitmap (param $hdc i32) (result i32)
    (local $meta i32)
    (local.set $meta (call $gdi_dc_meta_entry (local.get $hdc) (i32.const 0)))
    (if (i32.and (i32.ne (local.get $meta) (i32.const 0))
          (i32.eq (i32.load offset=20 (local.get $meta)) (i32.const 0x4D464443)))
      (then (return (i32.load offset=24 (local.get $meta)))))
    (i32.const 0))

  ;; A classic recording DC has a bounded canonical surface. CloseMetaFile
  ;; serializes that surface as a standard device-independent META_STRETCHDIB
  ;; record, so the byte stream remains useful outside this emulator.
  (func $gdi_metafile_recording_dc_create (result i32)
    (local $bitmap i32) (local $record i32) (local $dc i32) (local $meta i32)
    (local.set $bitmap (call $gdi_create_compat_bitmap_internal
      (i32.const 640) (i32.const 480) (i32.const 0)))
    (if (i32.eqz (local.get $bitmap)) (then (return (i32.const 0))))
    (local.set $record (call $gdi_object_record (local.get $bitmap)))
    (memory.fill (i32.load offset=24 (local.get $record)) (i32.const 0xFF)
      (i32.mul (i32.load offset=28 (local.get $record))
        (i32.load offset=12 (local.get $record))))
    (drop (call $host_gdi_surface_upload (local.get $bitmap)
      (i32.const 0) (i32.const 0) (i32.const 640) (i32.const 480)))
    (local.set $dc (call $gdi_dc_alloc))
    (if (i32.eqz (local.get $dc))
      (then
        (drop (call $gdi_object_delete_full (local.get $bitmap)))
        (return (i32.const 0))))
    (if (i32.eq (call $gdi_dc_select_owned_object
          (local.get $dc) (local.get $bitmap)) (i32.const -1))
      (then
        (drop (call $gdi_dc_delete (local.get $dc)))
        (drop (call $gdi_object_delete_full (local.get $bitmap)))
        (return (i32.const 0))))
    (local.set $meta (call $gdi_dc_meta_entry (local.get $dc) (i32.const 1)))
    (if (i32.eqz (local.get $meta))
      (then
        (drop (call $gdi_dc_delete (local.get $dc)))
        (drop (call $gdi_object_delete_full (local.get $bitmap)))
        (return (i32.const 0))))
    (i32.store offset=20 (local.get $meta) (i32.const 0x4D464443))
    (i32.store offset=24 (local.get $meta) (local.get $bitmap))
    (local.get $dc))

  (func $gdi_metafile_snapshot_wmf (param $hdc i32) (result i32)
    (local $bitmap i32) (local $desc i32) (local $width i32) (local $height i32)
    (local $stride i32) (local $pixels i32) (local $total i32)
    (local $stretch_bytes i32) (local $scratch_g i32) (local $p i32)
    (local $record i32) (local $dib i32) (local $result i32)
    (local.set $bitmap (call $gdi_metafile_recording_bitmap (local.get $hdc)))
    (if (i32.eqz (local.get $bitmap)) (then (return (i32.const 0))))
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const 0))))
    (local.set $width (i32.load offset=4 (local.get $desc)))
    (local.set $height (i32.load offset=8 (local.get $desc)))
    (local.set $stride (i32.load offset=12 (local.get $desc)))
    (if (i32.or (i32.ne (i32.load offset=16 (local.get $desc)) (i32.const 32))
          (i32.or (i32.gt_u (local.get $width) (i32.const 32767))
            (i32.gt_u (local.get $height) (i32.const 32767))))
      (then (return (i32.const 0))))
    (local.set $pixels (i32.mul (local.get $stride) (local.get $height)))
    (local.set $total (i32.add (local.get $pixels) (i32.const 130)))
    (if (i32.or (i32.lt_u (local.get $total) (local.get $pixels))
          (i32.gt_u (local.get $total) (global.get $DIB_BACKING_BASE_SIZE)))
      (then (return (i32.const 0))))
    (local.set $scratch_g (call $dib_alloc (local.get $total)))
    (if (i32.eqz (local.get $scratch_g)) (then (return (i32.const 0))))
    (local.set $p (call $g2w (local.get $scratch_g)))
    (memory.fill (local.get $p) (i32.const 0) (local.get $total))
    ;; METAHEADER.
    (i32.store16 (local.get $p) (i32.const 1))
    (i32.store16 offset=2 (local.get $p) (i32.const 9))
    (i32.store16 offset=4 (local.get $p) (i32.const 0x0300))
    (i32.store offset=6 (local.get $p) (i32.shr_u (local.get $total) (i32.const 1)))
    (local.set $stretch_bytes (i32.add (local.get $pixels) (i32.const 68)))
    (i32.store offset=12 (local.get $p)
      (i32.shr_u (local.get $stretch_bytes) (i32.const 1)))
    ;; Set MM_ANISOTROPIC with matching logical window and device viewport
    ;; extents. Recording both extents keeps the standard stream independent
    ;; of the destination DC's preexisting mapping state.
    (i32.store offset=18 (local.get $p) (i32.const 4))
    (i32.store16 offset=22 (local.get $p) (i32.const 0x0103))
    (i32.store16 offset=24 (local.get $p) (i32.const 8))
    (i32.store offset=26 (local.get $p) (i32.const 5))
    (i32.store16 offset=30 (local.get $p) (i32.const 0x020B))
    (i32.store offset=36 (local.get $p) (i32.const 5))
    (i32.store16 offset=40 (local.get $p) (i32.const 0x020C))
    (i32.store16 offset=42 (local.get $p) (local.get $height))
    (i32.store16 offset=44 (local.get $p) (local.get $width))
    (i32.store offset=46 (local.get $p) (i32.const 5))
    (i32.store16 offset=50 (local.get $p) (i32.const 0x020E))
    (i32.store16 offset=52 (local.get $p) (local.get $height))
    (i32.store16 offset=54 (local.get $p) (local.get $width))
    ;; META_STRETCHDIB parameters followed by a top-down 32-bpp BI_RGB DIB.
    (local.set $record (i32.add (local.get $p) (i32.const 56)))
    (i32.store (local.get $record)
      (i32.shr_u (local.get $stretch_bytes) (i32.const 1)))
    (i32.store16 offset=4 (local.get $record) (i32.const 0x0F43))
    (i32.store offset=6 (local.get $record) (i32.const 0x00CC0020))
    (i32.store16 offset=12 (local.get $record) (local.get $height))
    (i32.store16 offset=14 (local.get $record) (local.get $width))
    (i32.store16 offset=20 (local.get $record) (local.get $height))
    (i32.store16 offset=22 (local.get $record) (local.get $width))
    (local.set $dib (i32.add (local.get $record) (i32.const 28)))
    (i32.store (local.get $dib) (i32.const 40))
    (i32.store offset=4 (local.get $dib) (local.get $width))
    (i32.store offset=8 (local.get $dib) (i32.sub (i32.const 0) (local.get $height)))
    (i32.store16 offset=12 (local.get $dib) (i32.const 1))
    (i32.store16 offset=14 (local.get $dib) (i32.const 32))
    (i32.store offset=20 (local.get $dib) (local.get $pixels))
    (memory.copy (i32.add (local.get $dib) (i32.const 40))
      (i32.load (local.get $desc)) (local.get $pixels))
    ;; META_EOF.
    (i32.store (i32.add (local.get $p) (i32.sub (local.get $total) (i32.const 6)))
      (i32.const 3))
    (local.set $result (call $gdi_metafile_create
      (i32.const 6) (local.get $p) (local.get $total)))
    (call $dib_free_wasm (local.get $p))
    (local.get $result))

  (func $gdi_metafile_wmf_object_add (param $table i32) (param $count i32)
        (param $handle i32) (result i32)
    (local $i i32) (local $slot i32)
    (if (i32.or (i32.eqz (local.get $table)) (i32.eqz (local.get $handle)))
      (then (return (i32.const 0))))
    (block $full (loop $scan
      (br_if $full (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $slot (i32.add (local.get $table) (i32.shl (local.get $i) (i32.const 2))))
      (if (i32.eqz (i32.load (local.get $slot)))
        (then
          (i32.store (local.get $slot) (local.get $handle))
          (return (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  (func $gdi_metafile_wmf_objects_delete (param $table i32) (param $count i32)
    (local $i i32) (local $handle i32)
    (if (i32.eqz (local.get $table)) (then (return)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $handle (i32.load
        (i32.add (local.get $table) (i32.shl (local.get $i) (i32.const 2)))))
      (if (local.get $handle)
        (then
          (if (call $gdi_rgn_record (local.get $handle))
            (then (drop (call $gdi_rgn_delete (local.get $handle))))
            (else (drop (call $gdi_object_delete_full (local.get $handle)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan))))

  (func $gdi_metafile_wmf_delete_object (param $handle i32) (result i32)
    (if (result i32) (call $gdi_rgn_record (local.get $handle))
      (then (call $gdi_rgn_delete (local.get $handle)))
      (else (call $gdi_object_delete_full (local.get $handle)))))

  ;; Decode the Win16 Region Object carried by META_CREATEREGION. Each Scan
  ;; contains one y band and an even list of left/right endpoints. Validate the
  ;; duplicated count and all bounds before publishing a canonical WAT HRGN.
  (func $gdi_metafile_wmf_create_region (param $record i32)
        (param $record_bytes i32) (result i32)
    (local $region_size i32) (local $scan_count i32) (local $max_scan i32)
    (local $cursor i32) (local $limit i32) (local $scan_index i32)
    (local $coord_count i32) (local $coord_index i32) (local $scan_bytes i32)
    (local $top i32) (local $bottom i32) (local $left i32) (local $right i32)
    (local $prev_bottom i32) (local $prev_right i32)
    (local $out_count i32) (local $out i32) (local $previous i32)
    (local $handle i32) (local $region i32)
    (if (i32.lt_u (local.get $record_bytes) (i32.const 28))
      (then (return (i32.const 0))))
    (if (i32.ne (i32.load16_s offset=8 (local.get $record)) (i32.const 6))
      (then (return (i32.const 0))))
    (local.set $region_size (i32.load16_s offset=14 (local.get $record)))
    (local.set $scan_count (i32.load16_s offset=16 (local.get $record)))
    (local.set $max_scan (i32.load16_s offset=18 (local.get $record)))
    (if (i32.or
          (i32.or (i32.lt_s (local.get $region_size) (i32.const 22))
            (i32.ne (local.get $region_size)
              (i32.sub (local.get $record_bytes) (i32.const 6))))
          (i32.or
            (i32.or (i32.lt_s (local.get $scan_count) (i32.const 0))
              (i32.lt_s (local.get $max_scan) (i32.const 0)))
            (i32.gt_u (local.get $scan_count) (global.get $GDI_REGION_MAX_RECTS))))
      (then (return (i32.const 0))))
    (local.set $cursor (i32.add (local.get $record) (i32.const 28)))
    (local.set $limit (i32.add (local.get $record) (local.get $record_bytes)))
    (local.set $out (global.get $GDI_REGION_WORK))
    (block $scans_done (loop $scans
      (br_if $scans_done (i32.ge_u (local.get $scan_index) (local.get $scan_count)))
      (if (i32.gt_u (i32.add (local.get $cursor) (i32.const 8)) (local.get $limit))
        (then (return (i32.const 0))))
      (local.set $coord_count (i32.load16_u (local.get $cursor)))
      (local.set $top (i32.load16_u offset=2 (local.get $cursor)))
      (local.set $bottom (i32.load16_u offset=4 (local.get $cursor)))
      (if (i32.or
            (i32.or (i32.lt_u (local.get $coord_count) (i32.const 2))
              (i32.ne (i32.and (local.get $coord_count) (i32.const 1)) (i32.const 0)))
            (i32.or (i32.gt_u (local.get $coord_count) (local.get $max_scan))
              (i32.ge_u (local.get $top) (local.get $bottom))))
        (then (return (i32.const 0))))
      (local.set $scan_bytes
        (i32.add (i32.const 8) (i32.shl (local.get $coord_count) (i32.const 1))))
      (if (i32.gt_u (local.get $scan_bytes)
            (i32.sub (local.get $limit) (local.get $cursor)))
        (then (return (i32.const 0))))
      (if (i32.and (i32.ne (local.get $scan_index) (i32.const 0))
            (i32.lt_u (local.get $top) (local.get $prev_bottom)))
        (then (return (i32.const 0))))
      (local.set $coord_index (i32.const 0))
      (local.set $prev_right (i32.const 0))
      (block $coords_done (loop $coords
        (br_if $coords_done
          (i32.ge_u (local.get $coord_index) (local.get $coord_count)))
        (local.set $left (i32.load16_u (i32.add (local.get $cursor)
          (i32.add (i32.const 6) (i32.shl (local.get $coord_index) (i32.const 1))))))
        (local.set $right (i32.load16_u (i32.add (local.get $cursor)
          (i32.add (i32.const 8) (i32.shl (local.get $coord_index) (i32.const 1))))))
        (if (i32.or (i32.ge_u (local.get $left) (local.get $right))
              (i32.and (i32.ne (local.get $coord_index) (i32.const 0))
                (i32.lt_u (local.get $left) (local.get $prev_right))))
          (then (return (i32.const 0))))
        ;; Adjacent spans describe one canonical rectangle.
        (if (i32.and (i32.ne (local.get $coord_index) (i32.const 0))
              (i32.eq (local.get $left) (local.get $prev_right)))
          (then
            (i32.store offset=8 (local.get $previous) (local.get $right)))
          (else
            (if (i32.ge_u (local.get $out_count) (global.get $GDI_REGION_MAX_RECTS))
              (then (return (i32.const 0))))
            (local.set $previous (i32.add (local.get $out)
              (i32.shl (local.get $out_count) (i32.const 4))))
            (i32.store (local.get $previous) (local.get $left))
            (i32.store offset=4 (local.get $previous) (local.get $top))
            (i32.store offset=8 (local.get $previous) (local.get $right))
            (i32.store offset=12 (local.get $previous) (local.get $bottom))
            (local.set $out_count (i32.add (local.get $out_count) (i32.const 1)))))
        (local.set $prev_right (local.get $right))
        (local.set $coord_index (i32.add (local.get $coord_index) (i32.const 2)))
        (br $coords)))
      (if (i32.ne (i32.load16_u (i32.add (local.get $cursor)
              (i32.add (i32.const 6) (i32.shl (local.get $coord_count) (i32.const 1)))))
            (local.get $coord_count))
        (then (return (i32.const 0))))
      (local.set $prev_bottom (local.get $bottom))
      (local.set $cursor (i32.add (local.get $cursor) (local.get $scan_bytes)))
      (local.set $scan_index (i32.add (local.get $scan_index) (i32.const 1)))
      (br $scans)))
    (if (i32.ne (local.get $cursor) (local.get $limit))
      (then (return (i32.const 0))))
    (local.set $handle (call $gdi_rgn_alloc_rect
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
    (if (i32.eqz (local.get $handle)) (then (return (i32.const 0))))
    (local.set $region (call $gdi_rgn_record (local.get $handle)))
    (if (i32.eqz (call $gdi_rgn_set_buffer
          (local.get $region) (local.get $out) (local.get $out_count)))
      (then
        (drop (call $gdi_rgn_delete (local.get $handle)))
        (return (i32.const 0))))
    (local.get $handle))

  ;; WMF regions remain logical objects so Fill/Frame/Paint can use current
  ;; mapping. Explicit DC clips are retained in device coordinates, therefore
  ;; selecting a WMF region maps a temporary union before copying it into the DC.
  (func $gdi_metafile_wmf_select_clip_region (param $hdc i32)
        (param $handle i32) (result i32)
    (local $source i32) (local $bands i32) (local $count i32) (local $i i32)
    (local $band i32) (local $mapped i32) (local $rect i32) (local $result i32)
    (local $left i32) (local $top i32) (local $right i32) (local $bottom i32)
    (local $swap i32)
    (local.set $source (call $gdi_rgn_record (local.get $handle)))
    (if (i32.eqz (local.get $source)) (then (return (i32.const 0))))
    (local.set $mapped (call $gdi_rgn_alloc_rect
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
    (if (i32.eqz (local.get $mapped)) (then (return (i32.const 0))))
    (local.set $bands (call $gdi_rgn_bands (local.get $source)))
    (local.set $count (i32.load offset=28 (local.get $source)))
    (block $done (loop $rectangles
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $band (i32.add (local.get $bands) (i32.shl (local.get $i) (i32.const 4))))
      (local.set $left (call $gdi_dc_clip_map_x
        (local.get $hdc) (i32.load (local.get $band))))
      (local.set $top (call $gdi_dc_clip_map_y
        (local.get $hdc) (i32.load offset=4 (local.get $band))))
      (local.set $right (call $gdi_dc_clip_map_x
        (local.get $hdc) (i32.load offset=8 (local.get $band))))
      (local.set $bottom (call $gdi_dc_clip_map_y
        (local.get $hdc) (i32.load offset=12 (local.get $band))))
      (if (i32.gt_s (local.get $left) (local.get $right))
        (then (local.set $swap (local.get $left))
          (local.set $left (local.get $right)) (local.set $right (local.get $swap))))
      (if (i32.gt_s (local.get $top) (local.get $bottom))
        (then (local.set $swap (local.get $top))
          (local.set $top (local.get $bottom)) (local.set $bottom (local.get $swap))))
      (if (i32.and (i32.lt_s (local.get $left) (local.get $right))
            (i32.lt_s (local.get $top) (local.get $bottom)))
        (then
          (local.set $rect (call $gdi_rgn_alloc_rect
            (local.get $left) (local.get $top) (local.get $right) (local.get $bottom)))
          (if (i32.eqz (local.get $rect))
            (then (drop (call $gdi_rgn_delete (local.get $mapped)))
              (return (i32.const 0))))
          (local.set $result (call $gdi_rgn_combine
            (local.get $mapped) (local.get $mapped) (local.get $rect) (i32.const 2)))
          (drop (call $gdi_rgn_delete (local.get $rect)))
          (if (i32.eqz (local.get $result))
            (then (drop (call $gdi_rgn_delete (local.get $mapped)))
              (return (i32.const 0))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $rectangles)))
    (local.set $result (call $gdi_dc_clip_select (local.get $hdc) (local.get $mapped)))
    (drop (call $gdi_rgn_delete (local.get $mapped)))
    (local.get $result))

  ;; Materialize the Win16 LOGFONT carried by META_CREATEFONTINDIRECT. The
  ;; public handle is registered with the text provider for scalable fallback,
  ;; while the canonical object and any installed FNT strike remain WAT-owned.
  (func $gdi_metafile_wmf_create_font (param $record i32)
        (param $record_bytes i32) (result i32)
    (local $handle i32)
    (if (i32.lt_u (local.get $record_bytes) (i32.const 56))
      (then (return (i32.const 0))))
    ;; LOGFONT16 has a fixed 32-byte face field which is not required to end in
    ;; NUL. Copy it into bounded scratch before the text provider reads it.
    (memory.copy (global.get $TEXT_SCRATCH)
      (i32.add (local.get $record) (i32.const 24)) (i32.const 32))
    (i32.store8 offset=32 (global.get $TEXT_SCRATCH) (i32.const 0))
    (local.set $handle (call $host_create_font
      (i32.load16_s offset=6 (local.get $record))
      (i32.load16_s offset=14 (local.get $record))
      (i32.load8_u offset=16 (local.get $record))
      (global.get $TEXT_SCRATCH)))
    (if (i32.eqz (local.get $handle)) (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_object_adopt (local.get $handle) (i32.const 4)
          (i32.load16_s offset=6 (local.get $record))
          (i32.load16_s offset=14 (local.get $record))
          (i32.load8_u offset=16 (local.get $record)) (i32.const 0)))
      (then (return (i32.const 0))))
    (call $gdi_bitmap_font_bind (local.get $handle) (global.get $TEXT_SCRATCH))
    (local.get $handle))

  ;; Parse and replay META_TEXTOUT / META_EXTTEXTOUT directly from the WMF
  ;; record. WMF uses signed 16-bit Dx entries; the canonical text rasterizer
  ;; consumes Win32 LONG entries, so widen them into bounded temporary storage.
  (func $gdi_metafile_wmf_text (param $hdc i32) (param $record i32)
        (param $record_bytes i32) (param $extended i32) (result i32)
    (local $count i32) (local $text i32) (local $x i32) (local $y i32)
    (local $options i32) (local $offset i32) (local $padded i32)
    (local $required i32) (local $remaining i32) (local $has_rect i32)
    (local $has_dx i32) (local $workspace_size i32)
    (local $workspace_g i32) (local $workspace i32)
    (local $rect i32) (local $dx_array i32) (local $i i32) (local $result i32)
    (if (local.get $extended)
      (then
        (if (i32.lt_u (local.get $record_bytes) (i32.const 14))
          (then (return (i32.const 0))))
        (local.set $y (i32.load16_s offset=6 (local.get $record)))
        (local.set $x (i32.load16_s offset=8 (local.get $record)))
        (local.set $count (i32.load16_s offset=10 (local.get $record)))
        (local.set $options (i32.load16_u offset=12 (local.get $record)))
        (local.set $has_rect (i32.ne
          (i32.and (local.get $options) (i32.const 6)) (i32.const 0)))
        (local.set $offset (select (i32.const 22) (i32.const 14)
          (local.get $has_rect))))
      (else
        (if (i32.lt_u (local.get $record_bytes) (i32.const 12))
          (then (return (i32.const 0))))
        (local.set $count (i32.load16_s offset=6 (local.get $record)))
        (local.set $offset (i32.const 8))))
    (if (i32.lt_s (local.get $count) (i32.const 0))
      (then (return (i32.const 0))))
    (local.set $padded (i32.and
      (i32.add (local.get $count) (i32.const 1)) (i32.const -2)))
    (local.set $required (i32.add (local.get $offset) (local.get $padded)))
    (if (i32.gt_u (local.get $required) (local.get $record_bytes))
      (then (return (i32.const 0))))
    (if (i32.and (i32.eqz (local.get $extended))
          (i32.gt_u (i32.add (local.get $required) (i32.const 4))
            (local.get $record_bytes)))
      (then (return (i32.const 0))))
    (local.set $text (i32.add (local.get $record) (local.get $offset)))
    (if (local.get $extended)
      (then
        (local.set $remaining
          (i32.sub (local.get $record_bytes) (local.get $required)))
        (if (local.get $remaining)
          (then
            (if (i32.ne (local.get $remaining)
                  (i32.shl (local.get $count) (i32.const 1)))
              (then (return (i32.const 0))))
            (local.set $has_dx (i32.const 1))))
        (local.set $workspace_size (i32.add
          (select (i32.const 16) (i32.const 0) (local.get $has_rect))
          (select (i32.shl (local.get $count) (i32.const 2))
            (i32.const 0) (local.get $has_dx))))
        (if (local.get $workspace_size)
          (then
            (local.set $workspace_g (call $heap_alloc (local.get $workspace_size)))
            (if (i32.eqz (local.get $workspace_g))
              (then (return (i32.const 0))))
            (local.set $workspace (call $g2w (local.get $workspace_g)))))
        (if (local.get $has_rect)
          (then
            (local.set $rect (local.get $workspace))
            (i32.store (local.get $rect)
              (i32.load16_s offset=14 (local.get $record)))
            (i32.store offset=4 (local.get $rect)
              (i32.load16_s offset=16 (local.get $record)))
            (i32.store offset=8 (local.get $rect)
              (i32.load16_s offset=18 (local.get $record)))
            (i32.store offset=12 (local.get $rect)
              (i32.load16_s offset=20 (local.get $record)))))
        (if (local.get $has_dx)
          (then
            (local.set $dx_array (i32.add (local.get $workspace)
              (select (i32.const 16) (i32.const 0) (local.get $has_rect))))
            (block $dx_done (loop $copy_dx
              (br_if $dx_done (i32.ge_u (local.get $i) (local.get $count)))
              (i32.store (i32.add (local.get $dx_array)
                  (i32.shl (local.get $i) (i32.const 2)))
                (i32.load16_s (i32.add (local.get $record)
                  (i32.add (local.get $required)
                    (i32.shl (local.get $i) (i32.const 1))))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $copy_dx)))))
        (local.set $result (call $host_gdi_ext_text_out
          (local.get $hdc) (local.get $x) (local.get $y)
          (local.get $options) (local.get $rect) (local.get $text)
          (local.get $count) (local.get $dx_array) (i32.const 0)))
        (if (local.get $workspace_g)
          (then (call $heap_free (local.get $workspace_g))))
        (return (local.get $result))))
    (local.set $y (i32.load16_s
      (i32.add (local.get $record) (local.get $required))))
    (local.set $x (i32.load16_s
      (i32.add (local.get $record) (i32.add (local.get $required) (i32.const 2)))))
    (call $host_gdi_text_out (local.get $hdc) (local.get $x) (local.get $y)
      (local.get $text) (local.get $count) (i32.const 0)))

  ;; Parse classic WMF state, object, vector, and bitmap records. Unknown
  ;; well-formed records remain skippable, while malformed supported records
  ;; fail atomically after restoring the caller's DC and deleting temporary
  ;; metafile objects.
  (func $gdi_metafile_play_wmf (param $hdc i32) (param $handle i32)
        (param $single_record i32) (param $external_table i32)
        (param $external_count i32) (result i32)
    (local $object i32) (local $data i32) (local $available i32) (local $words i32)
    (local $end i32) (local $record i32) (local $record_words i32)
    (local $record_bytes i32) (local $function i32) (local $bmi i32)
    (local $plan i32) (local $dst i32) (local $src i32) (local $bits i32)
    (local $rop i32) (local $sx i32) (local $sy i32) (local $sw i32) (local $sh i32)
    (local $dx i32) (local $dy i32) (local $dw i32) (local $dh i32)
    (local $mapped_x i32) (local $mapped_y i32) (local $mapped_w i32) (local $mapped_h i32)
    (local $right i32) (local $bottom i32) (local $left i32) (local $top i32)
    (local $saw_eof i32) (local $result i32) (local $outer_save i32) (local $save_depth i32)
    (local $object_count i32) (local $table_g i32) (local $table i32)
    (local $index i32) (local $created i32) (local $selected i32)
    (local $style i32) (local $width i32) (local $color i32) (local $hatch i32)
    (local $count i32) (local $points_g i32) (local $points i32)
    (local $point i32) (local $i i32) (local $from_x i32) (local $from_y i32)
    (local $to_x i32) (local $to_y i32) (local $level i32) (local $steps i32)
    (local $single i32)
    (local.set $single (i32.ne (local.get $single_record) (i32.const 0)))
    (if (local.get $single)
      (then
        (if (i32.or
              (i32.eqz (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
              (i32.or
                (i32.gt_u (local.get $external_count) (global.get $GDI_OBJECT_COUNT))
                (i32.and (i32.ne (local.get $external_count) (i32.const 0))
                  (i32.eqz (local.get $external_table)))))
          (then (return (i32.const 0))))
        (local.set $record (local.get $single_record))
        (local.set $record_words (i32.load (local.get $record)))
        (if (i32.or (i32.lt_u (local.get $record_words) (i32.const 3))
              (i32.gt_u (local.get $record_words) (i32.const 0x3FFFFFFF)))
          (then (return (i32.const 0))))
        (local.set $record_bytes (i32.shl (local.get $record_words) (i32.const 1)))
        (local.set $end (i32.add (local.get $record) (local.get $record_bytes)))
        (if (i32.lt_u (local.get $end) (local.get $record))
          (then (return (i32.const 0))))
        (local.set $object_count (local.get $external_count))
        (local.set $table (local.get $external_table)))
      (else
        (local.set $object (call $gdi_metafile_record (local.get $handle) (i32.const 6)))
        (if (i32.eqz (local.get $object)) (then (return (i32.const 0))))
        (local.set $data (i32.load offset=24 (local.get $object)))
        (local.set $available (i32.load offset=8 (local.get $object)))
        (if (i32.eqz (call $gdi_metafile_valid_wmf (local.get $data) (local.get $available)))
          (then (return (i32.const 0))))
        (local.set $words (i32.load offset=6 (local.get $data)))
        (if (i32.or (i32.lt_u (local.get $words) (i32.const 9))
              (i32.gt_u (local.get $words) (i32.shr_u (local.get $available) (i32.const 1))))
          (then (return (i32.const 0))))
        (local.set $object_count (i32.load16_u offset=10 (local.get $data)))
        (if (i32.gt_u (local.get $object_count) (global.get $GDI_OBJECT_COUNT))
          (then (return (i32.const 0))))
        (if (local.get $object_count)
          (then
            (local.set $table_g (call $heap_alloc (i32.shl (local.get $object_count) (i32.const 2))))
            (if (i32.eqz (local.get $table_g)) (then (return (i32.const 0))))
            (local.set $table (call $g2w (local.get $table_g)))
            (memory.fill (local.get $table) (i32.const 0)
              (i32.shl (local.get $object_count) (i32.const 2)))))
        (local.set $outer_save (call $gdi_dc_save (local.get $hdc)))
        (if (i32.eqz (local.get $outer_save))
          (then
            (if (local.get $table_g) (then (call $heap_free (local.get $table_g))))
            (return (i32.const 0))))
        (local.set $record (i32.add (local.get $data) (i32.const 18)))
        (local.set $end (i32.add (local.get $data)
          (i32.shl (local.get $words) (i32.const 1))))))
    (local.set $dst (global.get $GDI_BLIT_DST_DESC))
    (local.set $src (global.get $GDI_BLIT_SRC_DESC))
    (local.set $plan (global.get $GDI_BITMAP_PLAN))
    (block $finish (block $done (loop $records
      (br_if $finish (i32.ge_u (local.get $record) (local.get $end)))
      (if (i32.gt_u (i32.add (local.get $record) (i32.const 6)) (local.get $end))
        (then (br $finish)))
      (local.set $record_words (i32.load (local.get $record)))
      (if (i32.or (i32.lt_u (local.get $record_words) (i32.const 3))
            (i32.gt_u (local.get $record_words)
              (i32.shr_u (i32.sub (local.get $end) (local.get $record)) (i32.const 1))))
        (then (br $finish)))
      (local.set $record_bytes (i32.shl (local.get $record_words) (i32.const 1)))
      (local.set $function (i32.load16_u offset=4 (local.get $record)))
      (if (i32.eqz (local.get $function))
        (then
          (local.set $saw_eof (i32.const 1))
          (local.set $result (i32.const 1))
          (br $done)))

      ;; State records.
      (if (i32.or (i32.eq (local.get $function) (i32.const 0x0102))
            (i32.or (i32.eq (local.get $function) (i32.const 0x0103))
              (i32.or (i32.eq (local.get $function) (i32.const 0x0104))
                (i32.eq (local.get $function) (i32.const 0x0106)))))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 8)) (then (br $finish)))
          (local.set $level (i32.load16_u offset=6 (local.get $record)))
          (if (i32.eq (local.get $function) (i32.const 0x0102))
            (then
              (if (i32.or (i32.lt_u (local.get $level) (i32.const 1))
                    (i32.gt_u (local.get $level) (i32.const 2))) (then (br $finish)))
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 28)
                (local.get $level) (i32.const 2)))))
          (if (i32.eq (local.get $function) (i32.const 0x0103))
            (then
              (if (i32.or (i32.lt_u (local.get $level) (i32.const 1))
                    (i32.gt_u (local.get $level) (i32.const 8))) (then (br $finish)))
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 36)
                (local.get $level) (i32.const 1)))
              (if (i32.eq (local.get $level) (i32.const 1))
                (then
                  (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 48) (i32.const 1) (i32.const 1)))
                  (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 52) (i32.const 1) (i32.const 1)))
                  (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 64) (i32.const 1) (i32.const 1)))
                  (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 68) (i32.const 1) (i32.const 1)))))))
          (if (i32.eq (local.get $function) (i32.const 0x0104))
            (then
              (if (i32.eqz (call $gdi_dc_set_rop2 (local.get $hdc) (local.get $level)))
                (then (br $finish)))))
          (if (i32.eq (local.get $function) (i32.const 0x0106))
            (then
              (if (i32.or (i32.lt_u (local.get $level) (i32.const 1))
                    (i32.gt_u (local.get $level) (i32.const 2))) (then (br $finish)))
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 76)
                (local.get $level) (i32.const 1)))))))
      (if (i32.or (i32.eq (local.get $function) (i32.const 0x0201))
            (i32.eq (local.get $function) (i32.const 0x0209)))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 10)) (then (br $finish)))
          (drop (call $gdi_dc_set_field (local.get $hdc)
            (select (i32.const 20) (i32.const 24)
              (i32.eq (local.get $function) (i32.const 0x0209)))
            (i32.and (i32.load offset=6 (local.get $record)) (i32.const 0xFFFFFF))
            (i32.const 0)))))
      (if (i32.or (i32.eq (local.get $function) (i32.const 0x0108))
            (i32.eq (local.get $function) (i32.const 0x012E)))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 8))
            (then (br $finish)))
          (if (i32.eq (local.get $function) (i32.const 0x0108))
            (then
              (drop (call $gdi_dc_aux_set (local.get $hdc) (i32.const 20)
                (i32.load16_s offset=6 (local.get $record)) (i32.const 0))))
            (else
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 32)
                (i32.load16_u offset=6 (local.get $record)) (i32.const 0)))))))
      (if (i32.eq (local.get $function) (i32.const 0x020A))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 10))
            (then (br $finish)))
          ;; WMF stores BreakCount before BreakExtra (reverse API order).
          (drop (call $gdi_dc_aux_set (local.get $hdc) (i32.const 24)
            (i32.load16_s offset=8 (local.get $record)) (i32.const 0)))
          (drop (call $gdi_dc_aux_set (local.get $hdc) (i32.const 28)
            (i32.load16_s offset=6 (local.get $record)) (i32.const 0)))))
      (if (i32.or
            (i32.or (i32.eq (local.get $function) (i32.const 0x020B))
              (i32.eq (local.get $function) (i32.const 0x020C)))
            (i32.or (i32.eq (local.get $function) (i32.const 0x020D))
              (i32.eq (local.get $function) (i32.const 0x020E))))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 10)) (then (br $finish)))
          (local.set $to_y (i32.load16_s offset=6 (local.get $record)))
          (local.set $to_x (i32.load16_s offset=8 (local.get $record)))
          (if (i32.or (i32.eq (local.get $function) (i32.const 0x020C))
                (i32.eq (local.get $function) (i32.const 0x020E)))
            (then (if (i32.or (i32.eqz (local.get $to_x)) (i32.eqz (local.get $to_y)))
              (then (br $finish)))))
          (if (i32.eq (local.get $function) (i32.const 0x020B))
            (then
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 40) (local.get $to_x) (i32.const 0)))
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 44) (local.get $to_y) (i32.const 0)))))
          (if (i32.eq (local.get $function) (i32.const 0x020C))
            (then
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 48) (local.get $to_x) (i32.const 1)))
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 52) (local.get $to_y) (i32.const 1)))))
          (if (i32.eq (local.get $function) (i32.const 0x020D))
            (then
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 56) (local.get $to_x) (i32.const 0)))
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 60) (local.get $to_y) (i32.const 0)))))
          (if (i32.eq (local.get $function) (i32.const 0x020E))
            (then
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 64) (local.get $to_x) (i32.const 1)))
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 68) (local.get $to_y) (i32.const 1)))))))
      (if (i32.eq (local.get $function) (i32.const 0x0220))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 10)) (then (br $finish)))
          (if (i32.eqz (call $gdi_dc_clip_offset (local.get $hdc)
                (i32.load16_s offset=8 (local.get $record))
                (i32.load16_s offset=6 (local.get $record))))
            (then (br $finish)))))
      (if (i32.or (i32.eq (local.get $function) (i32.const 0x0415))
            (i32.eq (local.get $function) (i32.const 0x0416)))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 14)) (then (br $finish)))
          (if (i32.eqz
                (if (result i32) (i32.eq (local.get $function) (i32.const 0x0415))
                  (then (call $gdi_dc_clip_exclude_rect (local.get $hdc)
                    (i32.load16_s offset=12 (local.get $record))
                    (i32.load16_s offset=10 (local.get $record))
                    (i32.load16_s offset=8 (local.get $record))
                    (i32.load16_s offset=6 (local.get $record))))
                  (else (call $gdi_dc_clip_intersect_rect (local.get $hdc)
                    (i32.load16_s offset=12 (local.get $record))
                    (i32.load16_s offset=10 (local.get $record))
                    (i32.load16_s offset=8 (local.get $record))
                    (i32.load16_s offset=6 (local.get $record))))))
            (then (br $finish)))))
      (if (i32.eq (local.get $function) (i32.const 0x001E))
        (then
          (if (i32.eqz (call $gdi_dc_save (local.get $hdc))) (then (br $finish)))
          (local.set $save_depth (i32.add (local.get $save_depth) (i32.const 1)))))
      (if (i32.eq (local.get $function) (i32.const 0x0127))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 8)) (then (br $finish)))
          (local.set $level (i32.load16_s offset=6 (local.get $record)))
          (if (local.get $single)
            (then
              (if (i32.eqz (call $gdi_dc_restore (local.get $hdc) (local.get $level)))
                (then (br $finish))))
            (else
              (if (i32.lt_s (local.get $level) (i32.const 0))
                (then
                  (local.set $steps (i32.sub (i32.const 0) (local.get $level)))
                  (if (i32.or (i32.eqz (local.get $steps))
                        (i32.gt_u (local.get $steps) (local.get $save_depth)))
                    (then (br $finish)))
                  (if (i32.eqz (call $gdi_dc_restore
                        (local.get $hdc) (local.get $level)))
                    (then (br $finish)))
                  (local.set $save_depth
                    (i32.sub (local.get $save_depth) (local.get $steps))))
                (else
                  (if (i32.or (i32.eqz (local.get $level))
                        (i32.gt_u (local.get $level) (local.get $save_depth)))
                    (then (br $finish)))
                  (if (i32.eqz (call $gdi_dc_restore (local.get $hdc)
                        (i32.add (local.get $outer_save) (local.get $level))))
                    (then (br $finish)))
                  (local.set $save_depth
                    (i32.sub (local.get $level) (i32.const 1)))))))))

      ;; Object records use the WMF header's bounded object table.
      (if (i32.eq (local.get $function) (i32.const 0x02FA))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 16)) (then (br $finish)))
          (local.set $style (i32.load16_u offset=6 (local.get $record)))
          (local.set $width (i32.load16_s offset=8 (local.get $record)))
          (if (i32.lt_s (local.get $width) (i32.const 0))
            (then (local.set $width (i32.sub (i32.const 0) (local.get $width)))))
          (local.set $color (i32.and (i32.load offset=12 (local.get $record)) (i32.const 0xFFFFFF)))
          (local.set $created (call $gdi_object_alloc (i32.const 1)
            (local.get $style) (local.get $width) (local.get $color)
            (i32.eq (local.get $style) (i32.const 5))))
          (if (i32.eqz (call $gdi_metafile_wmf_object_add
                (local.get $table) (local.get $object_count) (local.get $created)))
            (then
              (if (local.get $created) (then (drop (call $gdi_object_delete_full (local.get $created)))))
              (br $finish)))))
      (if (i32.eq (local.get $function) (i32.const 0x02FB))
        (then
          (local.set $created (call $gdi_metafile_wmf_create_font
            (local.get $record) (local.get $record_bytes)))
          (if (i32.eqz (call $gdi_metafile_wmf_object_add
                (local.get $table) (local.get $object_count) (local.get $created)))
            (then
              (if (local.get $created)
                (then (drop (call $gdi_object_delete_full (local.get $created)))))
              (br $finish)))))
      (if (i32.eq (local.get $function) (i32.const 0x02FC))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 14)) (then (br $finish)))
          (local.set $style (i32.load16_u offset=6 (local.get $record)))
          (local.set $color (i32.and (i32.load offset=8 (local.get $record)) (i32.const 0xFFFFFF)))
          (local.set $hatch (i32.load16_u offset=12 (local.get $record)))
          (if (i32.or (i32.gt_u (local.get $style) (i32.const 2))
                (i32.and (i32.eq (local.get $style) (i32.const 2))
                  (i32.gt_u (local.get $hatch) (i32.const 5))))
            (then (br $finish)))
          (local.set $created (call $gdi_object_alloc (i32.const 2)
            (local.get $style) (local.get $hatch) (local.get $color) (i32.const 0)))
          (if (i32.eqz (call $gdi_metafile_wmf_object_add
                (local.get $table) (local.get $object_count) (local.get $created)))
            (then
              (if (local.get $created) (then (drop (call $gdi_object_delete_full (local.get $created)))))
              (br $finish)))))
      (if (i32.eq (local.get $function) (i32.const 0x06FF))
        (then
          (local.set $created (call $gdi_metafile_wmf_create_region
            (local.get $record) (local.get $record_bytes)))
          (if (i32.eqz (call $gdi_metafile_wmf_object_add
                (local.get $table) (local.get $object_count) (local.get $created)))
            (then
              (if (local.get $created)
                (then (drop (call $gdi_rgn_delete (local.get $created)))))
              (br $finish)))))
      (if (i32.eq (local.get $function) (i32.const 0x012D))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 8)) (then (br $finish)))
          (local.set $index (i32.load16_u offset=6 (local.get $record)))
          (if (i32.and (local.get $index) (i32.const 0x8000))
            (then (local.set $selected (i32.add (i32.const 0x30010)
              (i32.and (local.get $index) (i32.const 0x7FFF)))))
            (else
              (if (i32.ge_u (local.get $index) (local.get $object_count)) (then (br $finish)))
              (local.set $selected (i32.load (i32.add (local.get $table)
                (i32.shl (local.get $index) (i32.const 2)))))))
          (if (i32.or (i32.eqz (call $gdi_object_type (local.get $selected)))
                (i32.eq (call $gdi_dc_select_owned_object
                  (local.get $hdc) (local.get $selected)) (i32.const -1)))
            (then (br $finish)))))
      (if (i32.eq (local.get $function) (i32.const 0x012C))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 8)) (then (br $finish)))
          (local.set $index (i32.load16_u offset=6 (local.get $record)))
          (if (i32.ge_u (local.get $index) (local.get $object_count)) (then (br $finish)))
          (local.set $selected (i32.load (i32.add (local.get $table)
            (i32.shl (local.get $index) (i32.const 2)))))
          (if (i32.eqz (call $gdi_metafile_wmf_select_clip_region
                (local.get $hdc) (local.get $selected)))
            (then (br $finish)))))
      (if (i32.eq (local.get $function) (i32.const 0x01F0))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 8)) (then (br $finish)))
          (local.set $index (i32.load16_u offset=6 (local.get $record)))
          (if (i32.ge_u (local.get $index) (local.get $object_count)) (then (br $finish)))
          (local.set $point (i32.add (local.get $table)
            (i32.shl (local.get $index) (i32.const 2))))
          (local.set $selected (i32.load (local.get $point)))
          (if (i32.eqz (local.get $selected)) (then (br $finish)))
          (if (i32.eqz (call $gdi_metafile_wmf_delete_object (local.get $selected)))
            (then (br $finish)))
          (i32.store (local.get $point) (i32.const 0))))

      ;; WMF region drawing records address the region and optional brush by
      ;; object-table index; PAINTREGION uses the brush selected in the DC.
      (if (i32.eq (local.get $function) (i32.const 0x0228))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 10)) (then (br $finish)))
          (local.set $index (i32.load16_u offset=6 (local.get $record)))
          (local.set $count (i32.load16_u offset=8 (local.get $record)))
          (if (i32.or (i32.ge_u (local.get $index) (local.get $object_count))
                (i32.ge_u (local.get $count) (local.get $object_count)))
            (then (br $finish)))
          (local.set $selected (i32.load (i32.add (local.get $table)
            (i32.shl (local.get $index) (i32.const 2)))))
          (local.set $created (i32.load (i32.add (local.get $table)
            (i32.shl (local.get $count) (i32.const 2)))))
          (if (i32.or (i32.eqz (call $gdi_rgn_record (local.get $selected)))
                (i32.eqz (call $gdi_hdc_fill_rgn
                  (local.get $hdc) (local.get $selected) (local.get $created))))
            (then (br $finish)))))
      (if (i32.eq (local.get $function) (i32.const 0x0429))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 14)) (then (br $finish)))
          (local.set $index (i32.load16_u offset=6 (local.get $record)))
          (local.set $count (i32.load16_u offset=8 (local.get $record)))
          (if (i32.or (i32.ge_u (local.get $index) (local.get $object_count))
                (i32.ge_u (local.get $count) (local.get $object_count)))
            (then (br $finish)))
          (local.set $selected (i32.load (i32.add (local.get $table)
            (i32.shl (local.get $index) (i32.const 2)))))
          (local.set $created (i32.load (i32.add (local.get $table)
            (i32.shl (local.get $count) (i32.const 2)))))
          (if (i32.or (i32.eqz (call $gdi_rgn_record (local.get $selected)))
                (i32.eqz (call $gdi_hdc_frame_rgn
                  (local.get $hdc) (local.get $selected) (local.get $created)
                  (i32.load16_s offset=12 (local.get $record))
                  (i32.load16_s offset=10 (local.get $record)))))
            (then (br $finish)))))
      (if (i32.or (i32.eq (local.get $function) (i32.const 0x012A))
            (i32.eq (local.get $function) (i32.const 0x012B)))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 8)) (then (br $finish)))
          (local.set $index (i32.load16_u offset=6 (local.get $record)))
          (if (i32.ge_u (local.get $index) (local.get $object_count)) (then (br $finish)))
          (local.set $selected (i32.load (i32.add (local.get $table)
            (i32.shl (local.get $index) (i32.const 2)))))
          (if (i32.eqz
                (if (result i32) (i32.eq (local.get $function) (i32.const 0x012A))
                  (then (call $gdi_hdc_invert_rgn (local.get $hdc) (local.get $selected)))
                  (else (call $gdi_hdc_fill_rgn
                    (local.get $hdc) (local.get $selected) (i32.const 0)))))
            (then (br $finish)))))

      ;; Current-position line records.
      (if (i32.eq (local.get $function) (i32.const 0x0214))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 10)) (then (br $finish)))
          (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 12)
            (i32.load16_s offset=8 (local.get $record)) (i32.const 0)))
          (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 16)
            (i32.load16_s offset=6 (local.get $record)) (i32.const 0)))))
      (if (i32.eq (local.get $function) (i32.const 0x0213))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 10)) (then (br $finish)))
          (local.set $from_x (call $gdi_dc_get_field (local.get $hdc) (i32.const 12) (i32.const 0)))
          (local.set $from_y (call $gdi_dc_get_field (local.get $hdc) (i32.const 16) (i32.const 0)))
          (local.set $to_x (i32.load16_s offset=8 (local.get $record)))
          (local.set $to_y (i32.load16_s offset=6 (local.get $record)))
          (global.set $gdi_line_style_phase (i32.const 0))
          (if (i32.eqz (call $gdi_line_try (local.get $hdc)
                (local.get $from_x) (local.get $from_y) (local.get $to_x) (local.get $to_y)))
            (then (br $finish)))
          (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 12) (local.get $to_x) (i32.const 0)))
          (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 16) (local.get $to_y) (i32.const 0)))))

      ;; Text records share the public WAT FNT rasterizer and use Canvas only
      ;; when the selected face has no installed bitmap strike.
      (if (i32.or (i32.eq (local.get $function) (i32.const 0x0521))
            (i32.eq (local.get $function) (i32.const 0x0A32)))
        (then
          (if (i32.eqz (call $gdi_metafile_wmf_text
                (local.get $hdc) (local.get $record) (local.get $record_bytes)
                (i32.eq (local.get $function) (i32.const 0x0A32))))
            (then (br $finish)))))

      ;; Closed shapes use the selected WAT pen, brush, ROP2, and fill mode.
      (if (i32.or (i32.eq (local.get $function) (i32.const 0x0418))
            (i32.eq (local.get $function) (i32.const 0x041B)))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 14)) (then (br $finish)))
          (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $dst)))
            (then (br $finish)))
          (local.set $left (i32.load16_s offset=12 (local.get $record)))
          (local.set $top (i32.load16_s offset=10 (local.get $record)))
          (local.set $right (i32.load16_s offset=8 (local.get $record)))
          (local.set $bottom (i32.load16_s offset=6 (local.get $record)))
          (if (i32.eqz
                (if (result i32) (i32.eq (local.get $function) (i32.const 0x0418))
                  (then (call $gdi_ellipse_desc (local.get $hdc) (local.get $dst)
                    (local.get $left) (local.get $top) (local.get $right) (local.get $bottom)
                    (call $gdi_dc_get_field (local.get $hdc) (i32.const 4) (i32.const 0x30017))
                    (call $gdi_dc_get_field (local.get $hdc) (i32.const 8) (i32.const 0x30010))
                    (call $gdi_dc_get_rop2 (local.get $hdc))))
                  (else (call $gdi_rectangle_desc (local.get $hdc) (local.get $dst)
                    (local.get $left) (local.get $top) (local.get $right) (local.get $bottom)
                    (call $gdi_dc_get_field (local.get $hdc) (i32.const 4) (i32.const 0x30017))
                    (call $gdi_dc_get_field (local.get $hdc) (i32.const 8) (i32.const 0x30010))
                    (call $gdi_dc_get_rop2 (local.get $hdc))))))
            (then (br $finish)))))
      (if (i32.eq (local.get $function) (i32.const 0x061C))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 18)) (then (br $finish)))
          (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $dst)))
            (then (br $finish)))
          (if (i32.eqz (call $gdi_round_rect_desc (local.get $hdc) (local.get $dst)
                (i32.load16_s offset=16 (local.get $record))
                (i32.load16_s offset=14 (local.get $record))
                (i32.load16_s offset=12 (local.get $record))
                (i32.load16_s offset=10 (local.get $record))
                (i32.load16_s offset=8 (local.get $record))
                (i32.load16_s offset=6 (local.get $record))
                (call $gdi_dc_get_field (local.get $hdc) (i32.const 4) (i32.const 0x30017))
                (call $gdi_dc_get_field (local.get $hdc) (i32.const 8) (i32.const 0x30010))
                (call $gdi_dc_get_rop2 (local.get $hdc))))
            (then (br $finish)))))
      (if (i32.or (i32.eq (local.get $function) (i32.const 0x0324))
            (i32.eq (local.get $function) (i32.const 0x0325)))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 12)) (then (br $finish)))
          (local.set $count (i32.load16_u offset=6 (local.get $record)))
          (if (i32.or (i32.lt_u (local.get $count) (i32.const 2))
                (i32.gt_u (local.get $count) (global.get $GDI_REGION_MAX_RECTS)))
            (then (br $finish)))
          (if (i32.gt_u (i32.add (i32.const 8) (i32.shl (local.get $count) (i32.const 2)))
                (local.get $record_bytes)) (then (br $finish)))
          (local.set $points_g (call $heap_alloc (i32.shl (local.get $count) (i32.const 3))))
          (if (i32.eqz (local.get $points_g)) (then (br $finish)))
          (local.set $points (call $g2w (local.get $points_g)))
          (local.set $i (i32.const 0))
          (block $copied (loop $copy_points
            (br_if $copied (i32.ge_u (local.get $i) (local.get $count)))
            (local.set $point (i32.add (local.get $record)
              (i32.add (i32.const 8) (i32.shl (local.get $i) (i32.const 2)))))
            (i32.store (i32.add (local.get $points) (i32.shl (local.get $i) (i32.const 3)))
              (i32.load16_s (local.get $point)))
            (i32.store offset=4 (i32.add (local.get $points) (i32.shl (local.get $i) (i32.const 3)))
              (i32.load16_s offset=2 (local.get $point)))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $copy_points)))
          (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $dst)))
            (then (call $heap_free (local.get $points_g)) (local.set $points_g (i32.const 0)) (br $finish)))
          (if (i32.eq (local.get $function) (i32.const 0x0324))
            (then
              (if (i32.or (i32.lt_u (local.get $count) (i32.const 3))
                    (i32.eqz (call $gdi_polygon_desc (local.get $hdc) (local.get $dst)
                      (local.get $points) (local.get $count)
                      (call $gdi_dc_get_field (local.get $hdc) (i32.const 4) (i32.const 0x30017))
                      (call $gdi_dc_get_field (local.get $hdc) (i32.const 8) (i32.const 0x30010))
                      (call $gdi_dc_get_rop2 (local.get $hdc))
                      (call $gdi_dc_get_field (local.get $hdc) (i32.const 76) (i32.const 1)))))
                (then
                  (call $heap_free (local.get $points_g))
                  (local.set $points_g (i32.const 0))
                  (br $finish))))
            (else
              (local.set $i (i32.const 0))
              (block $preflight_done (loop $preflight
                (br_if $preflight_done (i32.ge_u (local.get $i)
                  (i32.sub (local.get $count) (i32.const 1))))
                (local.set $point (i32.add (local.get $points) (i32.shl (local.get $i) (i32.const 3))))
                (if (i32.eqz (call $gdi_line_desc_can_raster (local.get $dst)
                      (i32.load (local.get $point)) (i32.load offset=4 (local.get $point))
                      (i32.load offset=8 (local.get $point)) (i32.load offset=12 (local.get $point))
                      (call $gdi_dc_get_field (local.get $hdc) (i32.const 4) (i32.const 0x30017))
                      (call $gdi_dc_get_rop2 (local.get $hdc))))
                  (then
                    (call $heap_free (local.get $points_g))
                    (local.set $points_g (i32.const 0))
                    (br $finish)))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (br $preflight)))
              (global.set $gdi_line_style_phase (i32.const 0))
              (local.set $i (i32.const 0))
              (block $lines_done (loop $lines
                (br_if $lines_done (i32.ge_u (local.get $i)
                  (i32.sub (local.get $count) (i32.const 1))))
                (local.set $point (i32.add (local.get $points) (i32.shl (local.get $i) (i32.const 3))))
                (drop (call $gdi_line_desc (local.get $hdc) (local.get $dst)
                  (i32.load (local.get $point)) (i32.load offset=4 (local.get $point))
                  (i32.load offset=8 (local.get $point)) (i32.load offset=12 (local.get $point))
                  (call $gdi_dc_get_field (local.get $hdc) (i32.const 4) (i32.const 0x30017))
                  (call $gdi_dc_get_rop2 (local.get $hdc))))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (br $lines)))))
          (call $heap_free (local.get $points_g))
          (local.set $points_g (i32.const 0))))

      (if (i32.eq (local.get $function) (i32.const 0x0F43))
        (then
          (if (i32.lt_u (local.get $record_bytes) (i32.const 68))
            (then (br $finish)))
          (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $dst)))
            (then (br $finish)))
          (local.set $bmi (i32.add (local.get $record) (i32.const 28)))
          (if (i32.eqz (call $gdi_bitmap_parse_dib
                (local.get $bmi) (i32.sub (local.get $record_bytes) (i32.const 28))
                (local.get $plan)))
            (then (br $finish)))
          (local.set $bits (i32.load offset=28 (local.get $plan)))
          (if (i32.eqz (call $gdi_raster_desc_from_bmi
                (local.get $src) (local.get $bits) (local.get $bmi)))
            (then (br $finish)))
          (local.set $rop (i32.load offset=6 (local.get $record)))
          (local.set $sh (i32.load16_s offset=12 (local.get $record)))
          (local.set $sw (i32.load16_s offset=14 (local.get $record)))
          (local.set $sy (i32.load16_s offset=16 (local.get $record)))
          (local.set $sx (i32.load16_s offset=18 (local.get $record)))
          (local.set $dh (i32.load16_s offset=20 (local.get $record)))
          (local.set $dw (i32.load16_s offset=22 (local.get $record)))
          (local.set $dy (i32.load16_s offset=24 (local.get $record)))
          (local.set $dx (i32.load16_s offset=26 (local.get $record)))
          (local.set $mapped_x (call $gdi_line_map_x (local.get $dst) (local.get $dx)))
          (local.set $mapped_y (call $gdi_line_map_y (local.get $dst) (local.get $dy)))
          (local.set $mapped_w (i32.sub
            (call $gdi_line_map_x (local.get $dst) (i32.add (local.get $dx) (local.get $dw)))
            (local.get $mapped_x)))
          (local.set $mapped_h (i32.sub
            (call $gdi_line_map_y (local.get $dst) (i32.add (local.get $dy) (local.get $dh)))
            (local.get $mapped_y)))
          (if (i32.eqz (call $gdi_raster_stretch_blt
                (local.get $hdc) (i32.const 0) (local.get $dst)
                (local.get $mapped_x) (local.get $mapped_y)
                (local.get $mapped_w) (local.get $mapped_h)
                (local.get $src) (local.get $sx) (local.get $sy)
                (local.get $sw) (local.get $sh) (i32.const 0) (local.get $rop)))
            (then (br $finish)))
          (local.set $right (i32.add (local.get $mapped_x) (local.get $mapped_w)))
          (local.set $bottom (i32.add (local.get $mapped_y) (local.get $mapped_h)))
          (local.set $left (select (local.get $right) (local.get $mapped_x)
            (i32.lt_s (local.get $right) (local.get $mapped_x))))
          (local.set $top (select (local.get $bottom) (local.get $mapped_y)
            (i32.lt_s (local.get $bottom) (local.get $mapped_y))))
          (call $gdi_geometry_present (local.get $hdc) (local.get $dst)
            (local.get $left) (local.get $top)
            (select (local.get $mapped_x) (local.get $right)
              (i32.lt_s (local.get $right) (local.get $mapped_x)))
            (select (local.get $mapped_y) (local.get $bottom)
              (i32.lt_s (local.get $bottom) (local.get $mapped_y))))))
      (local.set $record (i32.add (local.get $record) (local.get $record_bytes)))
      (if (local.get $single) (then (local.set $result (i32.const 1))))
      (br $records))))
    (if (local.get $points_g) (then (call $heap_free (local.get $points_g))))
    (if (i32.eqz (local.get $single))
      (then
        (if (i32.eqz (call $gdi_dc_restore (local.get $hdc) (local.get $outer_save)))
          (then (local.set $result (i32.const 0))))
        (call $gdi_metafile_wmf_objects_delete (local.get $table) (local.get $object_count))
        (if (local.get $table_g) (then (call $heap_free (local.get $table_g))))))
    (if (result i32) (local.get $single)
      (then (local.get $result))
      (else (i32.and (local.get $result) (local.get $saw_eof)))))

  (func $gdi_metafile_play_wmf_record (param $hdc i32) (param $table i32)
        (param $record i32) (param $count i32) (result i32)
    (call $gdi_metafile_play_wmf (local.get $hdc) (i32.const 0)
      (local.get $record) (local.get $table) (local.get $count)))

  ;; EnumMetaFile uses a stack-resident callback context so nested enumeration
  ;; is naturally isolated. The callback receives the actual owned WMF record
  ;; bytes and a mutable HANDLETABLE consumed by PlayMetaFileRecord.
  (func $gdi_metafile_enum_finish (param $ctx i32) (param $result i32)
    (local $hdc i32) (local $outer_save i32) (local $table_g i32)
    (local $count i32)
    (local.set $hdc (call $gl32 (i32.add (local.get $ctx) (i32.const 20))))
    (local.set $outer_save (call $gl32 (i32.add (local.get $ctx) (i32.const 44))))
    (local.set $table_g (call $gl32 (i32.add (local.get $ctx) (i32.const 40))))
    (local.set $count (call $gl32 (i32.add (local.get $ctx) (i32.const 36))))
    (if (local.get $outer_save)
      (then
        (if (i32.eqz (call $gdi_dc_restore (local.get $hdc) (local.get $outer_save)))
          (then (local.set $result (i32.const 0))))))
    (if (local.get $table_g)
      (then (call $gdi_metafile_wmf_objects_delete
        (call $g2w (local.get $table_g)) (local.get $count))))
    (global.set $eip (call $gl32 (i32.add (local.get $ctx) (i32.const 12))))
    (global.set $esp (call $gl32 (i32.add (local.get $ctx) (i32.const 16))))
    (global.set $eax (local.get $result)))

  (func $gdi_metafile_enum_invoke (param $ctx i32)
    (local $record_g i32) (local $end_g i32) (local $record i32)
    (local $record_words i32) (local $record_bytes i32)
    (local.set $record_g (call $gl32 (i32.add (local.get $ctx) (i32.const 28))))
    (local.set $end_g (call $gl32 (i32.add (local.get $ctx) (i32.const 32))))
    (if (i32.or (i32.ge_u (local.get $record_g) (local.get $end_g))
          (i32.lt_u (i32.sub (local.get $end_g) (local.get $record_g)) (i32.const 6)))
      (then (call $gdi_metafile_enum_finish (local.get $ctx) (i32.const 0)) (return)))
    (local.set $record (call $g2w (local.get $record_g)))
    (local.set $record_words (i32.load (local.get $record)))
    (if (i32.or (i32.lt_u (local.get $record_words) (i32.const 3))
          (i32.gt_u (local.get $record_words)
            (i32.shr_u (i32.sub (local.get $end_g) (local.get $record_g)) (i32.const 1))))
      (then (call $gdi_metafile_enum_finish (local.get $ctx) (i32.const 0)) (return)))
    (local.set $record_bytes (i32.shl (local.get $record_words) (i32.const 1)))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 48)) (local.get $record_bytes))
    (global.set $esp (local.get $ctx))
    ;; MFENUMPROC(hdc, lpHTable, lpMFR, nObj, lParam), stdcall.
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp)
      (call $gl32 (i32.add (local.get $ctx) (i32.const 8))))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp)
      (call $gl32 (i32.add (local.get $ctx) (i32.const 36))))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $record_g))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp)
      (call $gl32 (i32.add (local.get $ctx) (i32.const 40))))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp)
      (call $gl32 (i32.add (local.get $ctx) (i32.const 20))))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $font_enum_ret_thunk))
    (global.set $eip (call $gl32 (i32.add (local.get $ctx) (i32.const 4))))
    (global.set $steps (i32.const 0)))

  (func $gdi_metafile_enum_continue
    (local $ctx i32) (local $record_g i32) (local $record i32)
    (local $next_g i32) (local $end_g i32)
    (local.set $ctx (global.get $esp))
    (if (i32.ne (call $gl32 (local.get $ctx)) (i32.const 0x4345464D))
      (then (return)))
    (if (i32.eqz (global.get $eax))
      (then (call $gdi_metafile_enum_finish (local.get $ctx) (i32.const 0)) (return)))
    (local.set $record_g (call $gl32 (i32.add (local.get $ctx) (i32.const 28))))
    (local.set $record (call $g2w (local.get $record_g)))
    (if (i32.eqz (i32.load16_u offset=4 (local.get $record)))
      (then (call $gdi_metafile_enum_finish (local.get $ctx) (i32.const 1)) (return)))
    (local.set $next_g (i32.add (local.get $record_g)
      (call $gl32 (i32.add (local.get $ctx) (i32.const 48)))))
    (local.set $end_g (call $gl32 (i32.add (local.get $ctx) (i32.const 32))))
    (if (i32.or (i32.le_u (local.get $next_g) (local.get $record_g))
          (i32.gt_u (local.get $next_g) (local.get $end_g)))
      (then (call $gdi_metafile_enum_finish (local.get $ctx) (i32.const 0)) (return)))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 28)) (local.get $next_g))
    (call $gdi_metafile_enum_invoke (local.get $ctx)))

  (func $gdi_metafile_enum_start (param $hdc i32) (param $handle i32)
        (param $callback i32) (param $lparam i32) (param $ret i32)
        (param $return_esp i32)
    (local $object i32) (local $data i32) (local $available i32)
    (local $words i32) (local $count i32) (local $ctx_size i32)
    (local $ctx i32) (local $outer_save i32)
    (if (i32.eqz (local.get $callback))
      (then
        (global.set $eax (i32.const 0))
        (global.set $eip (local.get $ret))
        (global.set $esp (local.get $return_esp))
        (return)))
    (local.set $object (call $gdi_metafile_record (local.get $handle) (i32.const 6)))
    (if (i32.eqz (local.get $object))
      (then
        (global.set $eax (i32.const 0))
        (global.set $eip (local.get $ret))
        (global.set $esp (local.get $return_esp))
        (return)))
    (local.set $data (i32.load offset=24 (local.get $object)))
    (local.set $available (i32.load offset=8 (local.get $object)))
    (local.set $words (i32.load offset=6 (local.get $data)))
    (local.set $count (i32.load16_u offset=10 (local.get $data)))
    (if (i32.or
          (i32.eqz (call $gdi_metafile_valid_wmf (local.get $data) (local.get $available)))
          (i32.or (i32.lt_u (local.get $words) (i32.const 12))
            (i32.or
              (i32.gt_u (local.get $words) (i32.shr_u (local.get $available) (i32.const 1)))
              (i32.gt_u (local.get $count) (global.get $GDI_OBJECT_COUNT)))))
      (then
        (global.set $eax (i32.const 0))
        (global.set $eip (local.get $ret))
        (global.set $esp (local.get $return_esp))
        (return)))
    (if (local.get $hdc)
      (then
        (local.set $outer_save (call $gdi_dc_save (local.get $hdc)))
        (if (i32.eqz (local.get $outer_save))
          (then
            (global.set $eax (i32.const 0))
            (global.set $eip (local.get $ret))
            (global.set $esp (local.get $return_esp))
            (return)))))
    (local.set $ctx_size (i32.and
      (i32.add (i32.add (i32.const 64) (i32.shl (local.get $count) (i32.const 2)))
        (i32.const 15)) (i32.const -16)))
    (global.set $esp (i32.sub (local.get $return_esp) (local.get $ctx_size)))
    (local.set $ctx (global.get $esp))
    (call $zero_memory (call $g2w (local.get $ctx)) (local.get $ctx_size))
    (call $gs32 (local.get $ctx) (i32.const 0x4345464D)) ;; "MFEC"
    (call $gs32 (i32.add (local.get $ctx) (i32.const 4)) (local.get $callback))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 8)) (local.get $lparam))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 12)) (local.get $ret))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 16)) (local.get $return_esp))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 20)) (local.get $hdc))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 24)) (local.get $handle))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 28))
      (call $w2g (i32.add (local.get $data) (i32.const 18))))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 32))
      (call $w2g (i32.add (local.get $data) (i32.shl (local.get $words) (i32.const 1)))))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 36)) (local.get $count))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 40))
      (select (i32.add (local.get $ctx) (i32.const 64)) (i32.const 0)
        (i32.ne (local.get $count) (i32.const 0))))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 44)) (local.get $outer_save))
    (call $gdi_metafile_enum_invoke (local.get $ctx)))

  (func $gdi_metafile_snapshot_emf (param $hdc i32) (result i32)
    (local $desc i32) (local $width i32) (local $height i32) (local $stride i32)
    (local $pixels i32) (local $record_size i32) (local $total i32)
    (local $scratch_g i32) (local $p i32) (local $record i32) (local $dib i32)
    (local $eof i32) (local $result i32)
    (if (i32.eqz (call $gdi_metafile_recording_bitmap (local.get $hdc)))
      (then (return (i32.const 0))))
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const 0))))
    (local.set $width (i32.load offset=4 (local.get $desc)))
    (local.set $height (i32.load offset=8 (local.get $desc)))
    (local.set $stride (i32.load offset=12 (local.get $desc)))
    (if (i32.ne (i32.load offset=16 (local.get $desc)) (i32.const 32))
      (then (return (i32.const 0))))
    (local.set $pixels (i32.mul (local.get $stride) (local.get $height)))
    (local.set $record_size (i32.add (local.get $pixels) (i32.const 120)))
    (local.set $total (i32.add (local.get $record_size) (i32.const 108)))
    (if (i32.or (i32.lt_u (local.get $total) (local.get $pixels))
          (i32.gt_u (local.get $total) (global.get $DIB_BACKING_BASE_SIZE)))
      (then (return (i32.const 0))))
    (local.set $scratch_g (call $dib_alloc (local.get $total)))
    (if (i32.eqz (local.get $scratch_g)) (then (return (i32.const 0))))
    (local.set $p (call $g2w (local.get $scratch_g)))
    (memory.fill (local.get $p) (i32.const 0) (local.get $total))
    ;; EMR_HEADER.
    (i32.store (local.get $p) (i32.const 1))
    (i32.store offset=4 (local.get $p) (i32.const 88))
    (i32.store offset=16 (local.get $p) (local.get $width))
    (i32.store offset=20 (local.get $p) (local.get $height))
    (i32.store offset=32 (local.get $p) (i32.const 16933))
    (i32.store offset=36 (local.get $p) (i32.const 12700))
    (i32.store offset=40 (local.get $p) (i32.const 0x464D4520))
    (i32.store offset=44 (local.get $p) (i32.const 0x00010000))
    (i32.store offset=48 (local.get $p) (local.get $total))
    (i32.store offset=52 (local.get $p) (i32.const 3))
    (i32.store16 offset=56 (local.get $p) (i32.const 1))
    (i32.store offset=72 (local.get $p) (local.get $width))
    (i32.store offset=76 (local.get $p) (local.get $height))
    (i32.store offset=80 (local.get $p) (i32.const 169))
    (i32.store offset=84 (local.get $p) (i32.const 127))
    ;; EMR_STRETCHDIBITS.
    (local.set $record (i32.add (local.get $p) (i32.const 88)))
    (i32.store (local.get $record) (i32.const 0x51))
    (i32.store offset=4 (local.get $record) (local.get $record_size))
    (i32.store offset=16 (local.get $record) (local.get $width))
    (i32.store offset=20 (local.get $record) (local.get $height))
    (i32.store offset=40 (local.get $record) (local.get $width))
    (i32.store offset=44 (local.get $record) (local.get $height))
    (i32.store offset=48 (local.get $record) (i32.const 80))
    (i32.store offset=52 (local.get $record) (i32.const 40))
    (i32.store offset=56 (local.get $record) (i32.const 120))
    (i32.store offset=60 (local.get $record) (local.get $pixels))
    (i32.store offset=68 (local.get $record) (i32.const 0x00CC0020))
    (i32.store offset=72 (local.get $record) (local.get $width))
    (i32.store offset=76 (local.get $record) (local.get $height))
    (local.set $dib (i32.add (local.get $record) (i32.const 80)))
    (i32.store (local.get $dib) (i32.const 40))
    (i32.store offset=4 (local.get $dib) (local.get $width))
    (i32.store offset=8 (local.get $dib) (i32.sub (i32.const 0) (local.get $height)))
    (i32.store16 offset=12 (local.get $dib) (i32.const 1))
    (i32.store16 offset=14 (local.get $dib) (i32.const 32))
    (i32.store offset=20 (local.get $dib) (local.get $pixels))
    (memory.copy (i32.add (local.get $record) (i32.const 120))
      (i32.load (local.get $desc)) (local.get $pixels))
    ;; EMR_EOF.
    (local.set $eof (i32.add (local.get $record) (local.get $record_size)))
    (i32.store (local.get $eof) (i32.const 14))
    (i32.store offset=4 (local.get $eof) (i32.const 20))
    (i32.store offset=16 (local.get $eof) (i32.const 20))
    (local.set $result (call $gdi_metafile_create
      (i32.const 7) (local.get $p) (local.get $total)))
    (call $dib_free_wasm (local.get $p))
    (local.get $result))

  (func $gdi_metafile_emf_object_set (param $table i32) (param $count i32)
        (param $index i32) (param $handle i32) (result i32)
    (local $slot i32)
    (if (i32.or
          (i32.or (i32.eqz (local.get $table)) (i32.eqz (local.get $handle)))
          (i32.or (i32.eqz (local.get $index))
            (i32.ge_u (local.get $index) (local.get $count))))
      (then (return (i32.const 0))))
    (local.set $slot (i32.add (local.get $table)
      (i32.shl (local.get $index) (i32.const 2))))
    (if (i32.load (local.get $slot)) (then (return (i32.const 0))))
    (i32.store (local.get $slot) (local.get $handle))
    (i32.const 1))

  (func $gdi_metafile_emf_target_coordinate (param $value i32)
        (param $source_origin i32) (param $source_extent i32)
        (param $target_origin i32) (param $target_extent i32) (result i32)
    (if (i32.eqz (local.get $source_extent))
      (then (return (local.get $value))))
    (call $gdi_map_coordinate (local.get $value)
      (local.get $source_origin) (local.get $source_extent)
      (local.get $target_origin) (local.get $target_extent)))

  (func $gdi_metafile_emf_target_delta (param $value i32)
        (param $source_extent i32) (param $target_extent i32) (result i32)
    (if (i32.eqz (local.get $source_extent))
      (then (return (local.get $value))))
    (call $gdi_round_ratio
      (i64.mul (i64.extend_i32_s (local.get $value))
        (i64.extend_i32_s (local.get $target_extent)))
      (i64.extend_i32_s (local.get $source_extent))))

  ;; Replay EMR_POLYGON/POLYLINE/POLYLINETO and their 16-bit variants through
  ;; the shared integer geometry kernels. POINTS payloads are widened into a
  ;; bounded guest buffer; POINTL payloads can be consumed in place.
  (func $gdi_metafile_emf_poly (param $hdc i32) (param $record i32)
        (param $record_size i32) (param $mode i32) (param $short_points i32)
        (result i32)
    (local $count i32) (local $required i32) (local $points i32)
    (local $points_g i32) (local $source i32) (local $point i32)
    (local $i i32) (local $first i32) (local $segments i32) (local $desc i32)
    (local $from_x i32) (local $from_y i32) (local $to_x i32) (local $to_y i32)
    (if (i32.lt_u (local.get $record_size) (i32.const 28))
      (then (return (i32.const 0))))
    (local.set $count (i32.load offset=24 (local.get $record)))
    (if (i32.or (i32.gt_u (local.get $count) (global.get $GDI_REGION_MAX_RECTS))
          (i32.or
            (i32.and (i32.eqz (local.get $mode))
              (i32.lt_u (local.get $count) (i32.const 3)))
            (i32.and (i32.eq (local.get $mode) (i32.const 1))
              (i32.lt_u (local.get $count) (i32.const 2)))))
      (then (return (i32.const 0))))
    (if (i32.and (i32.eq (local.get $mode) (i32.const 2))
          (i32.eqz (local.get $count)))
      (then (return (i32.const 0))))
    (local.set $required (i32.add (i32.const 28)
      (i32.mul (local.get $count)
        (select (i32.const 4) (i32.const 8) (local.get $short_points)))))
    (if (i32.gt_u (local.get $required) (local.get $record_size))
      (then (return (i32.const 0))))
    (if (local.get $short_points)
      (then
        (local.set $points_g (call $heap_alloc
          (i32.shl (local.get $count) (i32.const 3))))
        (if (i32.eqz (local.get $points_g)) (then (return (i32.const 0))))
        (local.set $points (call $g2w (local.get $points_g)))
        (local.set $source (i32.add (local.get $record) (i32.const 28)))
        (block $copy_done (loop $copy
          (br_if $copy_done (i32.ge_u (local.get $i) (local.get $count)))
          (local.set $point (i32.add (local.get $points)
            (i32.shl (local.get $i) (i32.const 3))))
          (i32.store (local.get $point) (i32.load16_s (i32.add (local.get $source)
            (i32.shl (local.get $i) (i32.const 2)))))
          (i32.store offset=4 (local.get $point) (i32.load16_s (i32.add (local.get $source)
            (i32.add (i32.shl (local.get $i) (i32.const 2)) (i32.const 2)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $copy))))
      (else (local.set $points (i32.add (local.get $record) (i32.const 28)))))
    (local.set $desc (global.get $GDI_BLIT_DST_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then
        (if (local.get $points_g) (then (call $heap_free (local.get $points_g))))
        (return (i32.const 0))))
    (if (i32.eqz (local.get $mode))
      (then
        (local.set $segments (call $gdi_polygon_desc
          (local.get $hdc) (local.get $desc) (local.get $points) (local.get $count)
          (call $gdi_dc_get_field (local.get $hdc) (i32.const 4) (i32.const 0x30017))
          (call $gdi_dc_get_field (local.get $hdc) (i32.const 8) (i32.const 0x30010))
          (call $gdi_dc_get_rop2 (local.get $hdc))
          (call $gdi_dc_get_field (local.get $hdc) (i32.const 76) (i32.const 1)))))
      (else
        (if (i32.eq (local.get $mode) (i32.const 2))
          (then
            (local.set $from_x (call $gdi_dc_get_field
              (local.get $hdc) (i32.const 12) (i32.const 0)))
            (local.set $from_y (call $gdi_dc_get_field
              (local.get $hdc) (i32.const 16) (i32.const 0)))
            (local.set $first (i32.const 0))
            (local.set $segments (local.get $count)))
          (else
            (local.set $from_x (i32.load (local.get $points)))
            (local.set $from_y (i32.load offset=4 (local.get $points)))
            (local.set $first (i32.const 1))
            (local.set $segments (i32.sub (local.get $count) (i32.const 1)))))
        ;; Validate every segment before writing the first pixel. A malformed
        ;; later segment must not leave a partially replayed polyline behind.
        (local.set $i (i32.const 0))
        (block $preflight_done (loop $preflight
          (br_if $preflight_done (i32.ge_u (local.get $i) (local.get $segments)))
          (local.set $point (i32.add (local.get $points)
            (i32.shl (i32.add (local.get $first) (local.get $i)) (i32.const 3))))
          (local.set $to_x (i32.load (local.get $point)))
          (local.set $to_y (i32.load offset=4 (local.get $point)))
          (if (i32.eqz (call $gdi_line_desc_can_raster (local.get $desc)
                (local.get $from_x) (local.get $from_y)
                (local.get $to_x) (local.get $to_y)
                (call $gdi_dc_get_field (local.get $hdc) (i32.const 4) (i32.const 0x30017))
                (call $gdi_dc_get_rop2 (local.get $hdc))))
            (then (local.set $segments (i32.const 0)) (br $preflight_done)))
          (local.set $from_x (local.get $to_x))
          (local.set $from_y (local.get $to_y))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $preflight)))
        (if (local.get $segments)
          (then
            (if (i32.eq (local.get $mode) (i32.const 2))
              (then
                (local.set $from_x (call $gdi_dc_get_field
                  (local.get $hdc) (i32.const 12) (i32.const 0)))
                (local.set $from_y (call $gdi_dc_get_field
                  (local.get $hdc) (i32.const 16) (i32.const 0))))
              (else
                (local.set $from_x (i32.load (local.get $points)))
                (local.set $from_y (i32.load offset=4 (local.get $points)))))
            (global.set $gdi_line_style_phase (i32.const 0))
            (local.set $i (i32.const 0))
            (block $lines_done (loop $lines
              (br_if $lines_done (i32.ge_u (local.get $i) (local.get $segments)))
              (local.set $point (i32.add (local.get $points)
                (i32.shl (i32.add (local.get $first) (local.get $i)) (i32.const 3))))
              (local.set $to_x (i32.load (local.get $point)))
              (local.set $to_y (i32.load offset=4 (local.get $point)))
          (drop (call $gdi_line_desc (local.get $hdc) (local.get $desc)
            (local.get $from_x) (local.get $from_y)
            (local.get $to_x) (local.get $to_y)
            (call $gdi_dc_get_field (local.get $hdc) (i32.const 4) (i32.const 0x30017))
            (call $gdi_dc_get_rop2 (local.get $hdc))))
              (local.set $from_x (local.get $to_x))
              (local.set $from_y (local.get $to_y))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $lines)))))
        (if (i32.and (i32.ne (local.get $segments) (i32.const 0))
              (i32.eq (local.get $mode) (i32.const 2)))
          (then
            (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 12)
              (local.get $from_x) (i32.const 0)))
            (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 16)
              (local.get $from_y) (i32.const 0)))))))
    (if (local.get $points_g) (then (call $heap_free (local.get $points_g))))
    (i32.ne (local.get $segments) (i32.const 0)))

  (func $gdi_metafile_play_emf (param $hdc i32) (param $handle i32)
        (param $target_rect i32) (result i32)
    (local $object i32) (local $data i32) (local $available i32) (local $declared i32)
    (local $header_size i32) (local $record i32) (local $record_size i32)
    (local $record_type i32) (local $end i32) (local $off_bmi i32)
    (local $cb_bmi i32) (local $off_bits i32) (local $cb_bits i32)
    (local $bmi i32) (local $bits i32) (local $plan i32) (local $dst i32) (local $src i32)
    (local $sx i32) (local $sy i32) (local $sw i32) (local $sh i32)
    (local $dx i32) (local $dy i32) (local $dw i32) (local $dh i32) (local $rop i32)
    (local $bounds_l i32) (local $bounds_t i32) (local $bounds_w i32) (local $bounds_h i32)
    (local $target_l i32) (local $target_t i32) (local $target_w i32) (local $target_h i32)
    (local $mapped_x i32) (local $mapped_y i32) (local $mapped_w i32) (local $mapped_h i32)
    (local $right i32) (local $bottom i32) (local $left i32) (local $top i32)
    (local $saw_eof i32) (local $result i32) (local $outer_save i32)
    (local $object_count i32) (local $table_g i32) (local $table i32)
    (local $index i32) (local $created i32) (local $selected i32)
    (local $style i32) (local $width i32) (local $color i32) (local $hatch i32)
    (local $count i32) (local $point i32) (local $i i32)
    (local $from_x i32) (local $from_y i32) (local $to_x i32) (local $to_y i32)
    (local $level i32) (local $save_depth i32) (local $steps i32)
    (local $declared_records i32) (local $records_seen i32)
    (local.set $object (call $gdi_metafile_record (local.get $handle) (i32.const 7)))
    (if (i32.eqz (local.get $object)) (then (return (i32.const 0))))
    (local.set $data (i32.load offset=24 (local.get $object)))
    (local.set $available (i32.load offset=8 (local.get $object)))
    (if (i32.eqz (call $gdi_metafile_valid_emf (local.get $data) (local.get $available)))
      (then (return (i32.const 0))))
    (local.set $header_size (i32.load offset=4 (local.get $data)))
    (local.set $declared (i32.load offset=48 (local.get $data)))
    (local.set $declared_records (i32.load offset=52 (local.get $data)))
    (if (i32.or (i32.lt_u (local.get $header_size) (i32.const 88))
          (i32.or (i32.gt_u (local.get $header_size) (local.get $declared))
            (i32.or (i32.gt_u (local.get $declared) (local.get $available))
              (i32.lt_u (local.get $declared_records) (i32.const 2)))))
      (then (return (i32.const 0))))
    (local.set $bounds_l (i32.load offset=8 (local.get $data)))
    (local.set $bounds_t (i32.load offset=12 (local.get $data)))
    (local.set $bounds_w (i32.sub (i32.load offset=16 (local.get $data)) (local.get $bounds_l)))
    (local.set $bounds_h (i32.sub (i32.load offset=20 (local.get $data)) (local.get $bounds_t)))
    ;; Empty and header-only EMFs commonly carry an empty rclBounds. Use the
    ;; declared reference-device extent so EOF-only playback still succeeds.
    (if (i32.eqz (local.get $bounds_w))
      (then
        (local.set $bounds_l (i32.const 0))
        (local.set $bounds_w (i32.load offset=72 (local.get $data)))
        (if (i32.eqz (local.get $bounds_w))
          (then (local.set $bounds_w (i32.const 1))))))
    (if (i32.eqz (local.get $bounds_h))
      (then
        (local.set $bounds_t (i32.const 0))
        (local.set $bounds_h (i32.load offset=76 (local.get $data)))
        (if (i32.eqz (local.get $bounds_h))
          (then (local.set $bounds_h (i32.const 1))))))
    (if (local.get $target_rect)
      (then
        (local.set $target_l (i32.load (local.get $target_rect)))
        (local.set $target_t (i32.load offset=4 (local.get $target_rect)))
        (local.set $target_w (i32.sub (i32.load offset=8 (local.get $target_rect)) (local.get $target_l)))
        (local.set $target_h (i32.sub (i32.load offset=12 (local.get $target_rect)) (local.get $target_t))))
      (else
        (local.set $target_l (local.get $bounds_l))
        (local.set $target_t (local.get $bounds_t))
        (local.set $target_w (local.get $bounds_w))
        (local.set $target_h (local.get $bounds_h))))
    (local.set $object_count (i32.load16_u offset=56 (local.get $data)))
    (if (i32.or
          (i32.or (i32.eqz (local.get $target_w)) (i32.eqz (local.get $target_h)))
          (i32.or (i32.eqz (local.get $object_count))
            (i32.gt_u (local.get $object_count) (global.get $GDI_OBJECT_COUNT))))
      (then (return (i32.const 0))))
    (local.set $dst (global.get $GDI_BLIT_DST_DESC))
    (local.set $src (global.get $GDI_BLIT_SRC_DESC))
    (local.set $plan (global.get $GDI_BITMAP_PLAN))
    (local.set $table_g (call $heap_alloc
      (i32.shl (local.get $object_count) (i32.const 2))))
    (if (i32.eqz (local.get $table_g)) (then (return (i32.const 0))))
    (local.set $table (call $g2w (local.get $table_g)))
    (memory.fill (local.get $table) (i32.const 0)
      (i32.shl (local.get $object_count) (i32.const 2)))
    (local.set $outer_save (call $gdi_dc_save (local.get $hdc)))
    (if (i32.eqz (local.get $outer_save))
      (then (call $heap_free (local.get $table_g)) (return (i32.const 0))))
    ;; Compose the EMF bounds-to-target transform into the playback DC. EMR
    ;; window/viewport state below mutates this private saved state only.
    (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 36) (i32.const 8) (i32.const 1)))
    (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 40) (local.get $bounds_l) (i32.const 0)))
    (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 44) (local.get $bounds_t) (i32.const 0)))
    (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 48) (local.get $bounds_w) (i32.const 1)))
    (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 52) (local.get $bounds_h) (i32.const 1)))
    (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 56) (local.get $target_l) (i32.const 0)))
    (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 60) (local.get $target_t) (i32.const 0)))
    (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 64) (local.get $target_w) (i32.const 1)))
    (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 68) (local.get $target_h) (i32.const 1)))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $dst)))
      (then
        (drop (call $gdi_dc_restore (local.get $hdc) (local.get $outer_save)))
        (call $heap_free (local.get $table_g))
        (return (i32.const 0))))
    (local.set $record (i32.add (local.get $data) (local.get $header_size)))
    (local.set $end (i32.add (local.get $data) (local.get $declared)))
    (local.set $records_seen (i32.const 1)) ;; EMR_HEADER
    (block $finish (block $done (loop $records
      (br_if $done (i32.ge_u (local.get $record) (local.get $end)))
      (if (i32.gt_u (i32.add (local.get $record) (i32.const 8)) (local.get $end))
        (then (br $finish)))
      (local.set $record_type (i32.load (local.get $record)))
      (local.set $record_size (i32.load offset=4 (local.get $record)))
      (local.set $records_seen (i32.add (local.get $records_seen) (i32.const 1)))
      (if (i32.or (i32.lt_u (local.get $record_size) (i32.const 8))
            (i32.or (i32.and (local.get $record_size) (i32.const 3))
              (i32.gt_u (local.get $record_size) (i32.sub (local.get $end) (local.get $record)))))
        (then (br $finish)))
      (if (i32.eq (local.get $record_type) (i32.const 14))
        (then
          (if (i32.or (i32.lt_u (local.get $record_size) (i32.const 20))
                (i32.or
                  (i32.ne (i32.load offset=16 (local.get $record))
                    (local.get $record_size))
                  (i32.ne (local.get $records_seen) (local.get $declared_records))))
            (then (br $finish)))
          (local.set $saw_eof (i32.const 1))
          (local.set $result (i32.const 1))
          (br $done)))

      ;; Core EMF state. The playback DC is private to this call because the
      ;; caller state was saved above; all state is restored at the common
      ;; exit, including failures.
      (if (i32.and (i32.ge_u (local.get $record_type) (i32.const 9))
            (i32.le_u (local.get $record_type) (i32.const 13)))
        (then
          (if (i32.lt_u (local.get $record_size) (i32.const 16))
            (then (br $finish)))
          (local.set $to_x (i32.load offset=8 (local.get $record)))
          (local.set $to_y (i32.load offset=12 (local.get $record)))
          (if (i32.or (i32.eq (local.get $record_type) (i32.const 9))
                (i32.eq (local.get $record_type) (i32.const 11)))
            (then
              (if (i32.or (i32.eqz (local.get $to_x)) (i32.eqz (local.get $to_y)))
                (then (br $finish)))))
          (if (i32.eq (local.get $record_type) (i32.const 9))
            (then
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 48)
                (local.get $to_x) (i32.const 1)))
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 52)
                (local.get $to_y) (i32.const 1)))))
          (if (i32.eq (local.get $record_type) (i32.const 10))
            (then
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 40)
                (local.get $to_x) (i32.const 0)))
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 44)
                (local.get $to_y) (i32.const 0)))))
          (if (i32.eq (local.get $record_type) (i32.const 11))
            (then
              (local.set $to_x (call $gdi_metafile_emf_target_delta
                (local.get $to_x) (local.get $bounds_w) (local.get $target_w)))
              (local.set $to_y (call $gdi_metafile_emf_target_delta
                (local.get $to_y) (local.get $bounds_h) (local.get $target_h)))
              (if (i32.or (i32.eqz (local.get $to_x)) (i32.eqz (local.get $to_y)))
                (then (br $finish)))
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 64)
                (local.get $to_x) (i32.const 1)))
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 68)
                (local.get $to_y) (i32.const 1)))))
          (if (i32.eq (local.get $record_type) (i32.const 12))
            (then
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 56)
                (call $gdi_metafile_emf_target_coordinate
                  (local.get $to_x) (local.get $bounds_l) (local.get $bounds_w)
                  (local.get $target_l) (local.get $target_w)) (i32.const 0)))
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 60)
                (call $gdi_metafile_emf_target_coordinate
                  (local.get $to_y) (local.get $bounds_t) (local.get $bounds_h)
                  (local.get $target_t) (local.get $target_h)) (i32.const 0)))))
          (if (i32.eq (local.get $record_type) (i32.const 13))
            (then
              (drop (call $gdi_dc_aux_set (local.get $hdc) (i32.const 8)
                (local.get $to_x) (i32.const 0)))
              (drop (call $gdi_dc_aux_set (local.get $hdc) (i32.const 12)
                (local.get $to_y) (i32.const 0)))))))
      (if (i32.eq (local.get $record_type) (i32.const 15))
        (then
          (if (i32.lt_u (local.get $record_size) (i32.const 20))
            (then (br $finish)))
          (if (i32.eq (call $gdi_hdc_set_pixel (local.get $hdc)
                (i32.load offset=8 (local.get $record))
                (i32.load offset=12 (local.get $record))
                (i32.and (i32.load offset=16 (local.get $record))
                  (i32.const 0xFFFFFF))) (i32.const -1))
            (then (br $finish)))))
      (if (i32.or
            (i32.and (i32.ge_u (local.get $record_type) (i32.const 17))
              (i32.le_u (local.get $record_type) (i32.const 22)))
            (i32.or (i32.eq (local.get $record_type) (i32.const 24))
              (i32.eq (local.get $record_type) (i32.const 25))))
        (then
          (if (i32.lt_u (local.get $record_size) (i32.const 12))
            (then (br $finish)))
          (local.set $level (i32.load offset=8 (local.get $record)))
          (if (i32.eq (local.get $record_type) (i32.const 17))
            (then
              (if (i32.or (i32.lt_u (local.get $level) (i32.const 1))
                    (i32.gt_u (local.get $level) (i32.const 8)))
                (then (br $finish)))
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 36)
                (local.get $level) (i32.const 1)))))
          (if (i32.eq (local.get $record_type) (i32.const 18))
            (then
              (if (i32.or (i32.lt_u (local.get $level) (i32.const 1))
                    (i32.gt_u (local.get $level) (i32.const 2)))
                (then (br $finish)))
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 28)
                (local.get $level) (i32.const 2)))))
          (if (i32.eq (local.get $record_type) (i32.const 19))
            (then
              (if (i32.or (i32.lt_u (local.get $level) (i32.const 1))
                    (i32.gt_u (local.get $level) (i32.const 2)))
                (then (br $finish)))
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 76)
                (local.get $level) (i32.const 1)))))
          (if (i32.eq (local.get $record_type) (i32.const 20))
            (then
              (if (i32.eqz (call $gdi_dc_set_rop2 (local.get $hdc)
                    (local.get $level)))
                (then (br $finish)))))
          (if (i32.eq (local.get $record_type) (i32.const 21))
            (then
              (if (i32.or (i32.lt_u (local.get $level) (i32.const 1))
                    (i32.gt_u (local.get $level) (i32.const 4)))
                (then (br $finish)))
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 80)
                (local.get $level) (i32.const 1)))))
          (if (i32.eq (local.get $record_type) (i32.const 22))
            (then (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 32)
              (local.get $level) (i32.const 0)))))
          (if (i32.eq (local.get $record_type) (i32.const 24))
            (then (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 20)
              (i32.and (local.get $level) (i32.const 0xFFFFFF)) (i32.const 0)))))
          (if (i32.eq (local.get $record_type) (i32.const 25))
            (then (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 24)
              (i32.and (local.get $level) (i32.const 0xFFFFFF))
              (i32.const 0xFFFFFF)))))))

      ;; Clip and current-position state.
      (if (i32.eq (local.get $record_type) (i32.const 26))
        (then
          (if (i32.lt_u (local.get $record_size) (i32.const 16))
            (then (br $finish)))
          (if (i32.eqz (call $gdi_dc_clip_offset (local.get $hdc)
                (i32.load offset=8 (local.get $record))
                (i32.load offset=12 (local.get $record))))
            (then (br $finish)))))
      (if (i32.eq (local.get $record_type) (i32.const 27))
        (then
          (if (i32.lt_u (local.get $record_size) (i32.const 16))
            (then (br $finish)))
          (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 12)
            (i32.load offset=8 (local.get $record)) (i32.const 0)))
          (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 16)
            (i32.load offset=12 (local.get $record)) (i32.const 0)))))
      (if (i32.or (i32.eq (local.get $record_type) (i32.const 29))
            (i32.eq (local.get $record_type) (i32.const 30)))
        (then
          (if (i32.lt_u (local.get $record_size) (i32.const 24))
            (then (br $finish)))
          (if (i32.eqz
                (if (result i32)
                  (i32.eq (local.get $record_type) (i32.const 29))
                  (then (call $gdi_dc_clip_exclude_rect (local.get $hdc)
                    (i32.load offset=8 (local.get $record))
                    (i32.load offset=12 (local.get $record))
                    (i32.load offset=16 (local.get $record))
                    (i32.load offset=20 (local.get $record))))
                  (else (call $gdi_dc_clip_intersect_rect (local.get $hdc)
                    (i32.load offset=8 (local.get $record))
                    (i32.load offset=12 (local.get $record))
                    (i32.load offset=16 (local.get $record))
                    (i32.load offset=20 (local.get $record))))))
            (then (br $finish)))))
      (if (i32.eq (local.get $record_type) (i32.const 33))
        (then
          (if (i32.eqz (call $gdi_dc_save (local.get $hdc)))
            (then (br $finish)))
          (local.set $save_depth (i32.add (local.get $save_depth) (i32.const 1)))))
      (if (i32.eq (local.get $record_type) (i32.const 34))
        (then
          (if (i32.lt_u (local.get $record_size) (i32.const 12))
            (then (br $finish)))
          (local.set $level (i32.load offset=8 (local.get $record)))
          (if (i32.lt_s (local.get $level) (i32.const 0))
            (then
              (local.set $steps (i32.sub (i32.const 0) (local.get $level)))
              (if (i32.or (i32.eqz (local.get $steps))
                    (i32.gt_u (local.get $steps) (local.get $save_depth)))
                (then (br $finish)))
              (if (i32.eqz (call $gdi_dc_restore (local.get $hdc)
                    (local.get $level)))
                (then (br $finish)))
              (local.set $save_depth
                (i32.sub (local.get $save_depth) (local.get $steps))))
            (else
              (if (i32.or (i32.eqz (local.get $level))
                    (i32.gt_u (local.get $level) (local.get $save_depth)))
                (then (br $finish)))
              (if (i32.eqz (call $gdi_dc_restore (local.get $hdc)
                    (i32.add (local.get $outer_save) (local.get $level))))
                (then (br $finish)))
              (local.set $save_depth
                (i32.sub (local.get $level) (i32.const 1)))))))

      ;; EMF object records use explicit DWORD table indices. Keep only the
      ;; canonical WAT handle in the playback table; no JS semantic mirror is
      ;; involved in creation, selection, deletion, or cleanup.
      (if (i32.eq (local.get $record_type) (i32.const 38))
        (then
          (if (i32.lt_u (local.get $record_size) (i32.const 28))
            (then (br $finish)))
          (local.set $index (i32.load offset=8 (local.get $record)))
          (local.set $style (i32.load offset=12 (local.get $record)))
          (local.set $width (i32.load offset=16 (local.get $record)))
          (if (i32.lt_s (local.get $width) (i32.const 0))
            (then (local.set $width (i32.sub (i32.const 0) (local.get $width)))))
          (local.set $color (i32.and (i32.load offset=24 (local.get $record))
            (i32.const 0xFFFFFF)))
          (local.set $created (call $gdi_object_alloc (i32.const 1)
            (local.get $style) (local.get $width) (local.get $color)
            (i32.eq (local.get $style) (i32.const 5))))
          (if (i32.eqz (call $gdi_metafile_emf_object_set
                (local.get $table) (local.get $object_count)
                (local.get $index) (local.get $created)))
            (then
              (if (local.get $created)
                (then (drop (call $gdi_object_delete_full (local.get $created)))))
              (br $finish)))))
      (if (i32.eq (local.get $record_type) (i32.const 39))
        (then
          (if (i32.lt_u (local.get $record_size) (i32.const 24))
            (then (br $finish)))
          (local.set $index (i32.load offset=8 (local.get $record)))
          (local.set $style (i32.load offset=12 (local.get $record)))
          (local.set $color (i32.and (i32.load offset=16 (local.get $record))
            (i32.const 0xFFFFFF)))
          (local.set $hatch (i32.load offset=20 (local.get $record)))
          (if (i32.or (i32.gt_u (local.get $style) (i32.const 2))
                (i32.and (i32.eq (local.get $style) (i32.const 2))
                  (i32.gt_u (local.get $hatch) (i32.const 5))))
            (then (br $finish)))
          (local.set $created (call $gdi_object_alloc (i32.const 2)
            (local.get $style) (local.get $hatch) (local.get $color)
            (i32.const 0)))
          (if (i32.eqz (call $gdi_metafile_emf_object_set
                (local.get $table) (local.get $object_count)
                (local.get $index) (local.get $created)))
            (then
              (if (local.get $created)
                (then (drop (call $gdi_object_delete_full (local.get $created)))))
              (br $finish)))))
      (if (i32.eq (local.get $record_type) (i32.const 37))
        (then
          (if (i32.lt_u (local.get $record_size) (i32.const 12))
            (then (br $finish)))
          (local.set $index (i32.load offset=8 (local.get $record)))
          (if (i32.and (local.get $index) (i32.const 0x80000000))
            (then
              (local.set $selected (i32.add (i32.const 0x30010)
                (i32.and (local.get $index) (i32.const 0x7FFFFFFF)))))
            (else
              (if (i32.or (i32.eqz (local.get $index))
                    (i32.ge_u (local.get $index) (local.get $object_count)))
                (then (br $finish)))
              (local.set $selected (i32.load (i32.add (local.get $table)
                (i32.shl (local.get $index) (i32.const 2)))))))
          (if (i32.or (i32.eqz (call $gdi_object_type (local.get $selected)))
                (i32.eq (call $gdi_dc_select_owned_object
                  (local.get $hdc) (local.get $selected)) (i32.const -1)))
            (then (br $finish)))))
      (if (i32.eq (local.get $record_type) (i32.const 40))
        (then
          (if (i32.lt_u (local.get $record_size) (i32.const 12))
            (then (br $finish)))
          (local.set $index (i32.load offset=8 (local.get $record)))
          (if (i32.or (i32.eqz (local.get $index))
                (i32.ge_u (local.get $index) (local.get $object_count)))
            (then (br $finish)))
          (local.set $point (i32.add (local.get $table)
            (i32.shl (local.get $index) (i32.const 2))))
          (local.set $selected (i32.load (local.get $point)))
          (if (i32.or (i32.eqz (local.get $selected))
                (i32.eqz (call $gdi_metafile_wmf_delete_object
                  (local.get $selected))))
            (then (br $finish)))
          (i32.store (local.get $point) (i32.const 0))))

      ;; Integer vector geometry. Descriptor mapping composes the current EMF
      ;; window/viewport state with the PlayEnhMetaFile target rectangle.
      (if (i32.eq (local.get $record_type) (i32.const 54))
        (then
          (if (i32.lt_u (local.get $record_size) (i32.const 16))
            (then (br $finish)))
          (local.set $from_x (call $gdi_dc_get_field
            (local.get $hdc) (i32.const 12) (i32.const 0)))
          (local.set $from_y (call $gdi_dc_get_field
            (local.get $hdc) (i32.const 16) (i32.const 0)))
          (local.set $to_x (i32.load offset=8 (local.get $record)))
          (local.set $to_y (i32.load offset=12 (local.get $record)))
          (global.set $gdi_line_style_phase (i32.const 0))
          (if (i32.eqz (call $gdi_line_try (local.get $hdc)
                (local.get $from_x) (local.get $from_y)
                (local.get $to_x) (local.get $to_y)))
            (then (br $finish)))
          (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 12)
            (local.get $to_x) (i32.const 0)))
          (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 16)
            (local.get $to_y) (i32.const 0)))))
      (if (i32.or (i32.eq (local.get $record_type) (i32.const 42))
            (i32.eq (local.get $record_type) (i32.const 43)))
        (then
          (if (i32.lt_u (local.get $record_size) (i32.const 24))
            (then (br $finish)))
          (if (i32.eqz (call $gdi_surface_descriptor
                (local.get $hdc) (local.get $dst)))
            (then (br $finish)))
          (local.set $left (i32.load offset=8 (local.get $record)))
          (local.set $top (i32.load offset=12 (local.get $record)))
          (local.set $right (i32.load offset=16 (local.get $record)))
          (local.set $bottom (i32.load offset=20 (local.get $record)))
          (if (i32.eqz
                (if (result i32)
                  (i32.eq (local.get $record_type) (i32.const 42))
                  (then (call $gdi_ellipse_desc (local.get $hdc) (local.get $dst)
                    (local.get $left) (local.get $top)
                    (local.get $right) (local.get $bottom)
                    (call $gdi_dc_get_field (local.get $hdc)
                      (i32.const 4) (i32.const 0x30017))
                    (call $gdi_dc_get_field (local.get $hdc)
                      (i32.const 8) (i32.const 0x30010))
                    (call $gdi_dc_get_rop2 (local.get $hdc))))
                  (else (call $gdi_rectangle_desc (local.get $hdc) (local.get $dst)
                    (local.get $left) (local.get $top)
                    (local.get $right) (local.get $bottom)
                    (call $gdi_dc_get_field (local.get $hdc)
                      (i32.const 4) (i32.const 0x30017))
                    (call $gdi_dc_get_field (local.get $hdc)
                      (i32.const 8) (i32.const 0x30010))
                    (call $gdi_dc_get_rop2 (local.get $hdc))))))
            (then (br $finish)))))
      (if (i32.eq (local.get $record_type) (i32.const 44))
        (then
          (if (i32.lt_u (local.get $record_size) (i32.const 32))
            (then (br $finish)))
          (if (i32.eqz (call $gdi_surface_descriptor
                (local.get $hdc) (local.get $dst)))
            (then (br $finish)))
          (if (i32.eqz (call $gdi_round_rect_desc
                (local.get $hdc) (local.get $dst)
                (i32.load offset=8 (local.get $record))
                (i32.load offset=12 (local.get $record))
                (i32.load offset=16 (local.get $record))
                (i32.load offset=20 (local.get $record))
                (i32.load offset=24 (local.get $record))
                (i32.load offset=28 (local.get $record))
                (call $gdi_dc_get_field (local.get $hdc)
                  (i32.const 4) (i32.const 0x30017))
                (call $gdi_dc_get_field (local.get $hdc)
                  (i32.const 8) (i32.const 0x30010))
                (call $gdi_dc_get_rop2 (local.get $hdc))))
            (then (br $finish)))))
      (if (i32.or
            (i32.or (i32.eq (local.get $record_type) (i32.const 3))
              (i32.eq (local.get $record_type) (i32.const 4)))
            (i32.eq (local.get $record_type) (i32.const 6)))
        (then
          (if (i32.eqz (call $gdi_metafile_emf_poly
                (local.get $hdc) (local.get $record) (local.get $record_size)
                (select (i32.const 2)
                  (select (i32.const 1) (i32.const 0)
                    (i32.eq (local.get $record_type) (i32.const 4)))
                  (i32.eq (local.get $record_type) (i32.const 6)))
                (i32.const 0)))
            (then (br $finish)))))
      (if (i32.or
            (i32.or (i32.eq (local.get $record_type) (i32.const 86))
              (i32.eq (local.get $record_type) (i32.const 87)))
            (i32.eq (local.get $record_type) (i32.const 89)))
        (then
          (if (i32.eqz (call $gdi_metafile_emf_poly
                (local.get $hdc) (local.get $record) (local.get $record_size)
                (select (i32.const 2)
                  (select (i32.const 1) (i32.const 0)
                    (i32.eq (local.get $record_type) (i32.const 87)))
                  (i32.eq (local.get $record_type) (i32.const 89)))
                (i32.const 1)))
            (then (br $finish)))))
      (if (i32.eq (local.get $record_type) (i32.const 0x51))
        (then
          (if (i32.lt_u (local.get $record_size) (i32.const 80))
            (then (br $finish)))
          (if (i32.eqz (call $gdi_surface_descriptor
                (local.get $hdc) (local.get $dst)))
            (then (br $finish)))
          (local.set $off_bmi (i32.load offset=48 (local.get $record)))
          (local.set $cb_bmi (i32.load offset=52 (local.get $record)))
          (local.set $off_bits (i32.load offset=56 (local.get $record)))
          (local.set $cb_bits (i32.load offset=60 (local.get $record)))
          (if (i32.or
                (i32.or (i32.lt_u (local.get $off_bmi) (i32.const 80))
                  (i32.gt_u (local.get $cb_bmi) (i32.sub (local.get $record_size) (local.get $off_bmi))))
                (i32.or (i32.lt_u (local.get $off_bits) (i32.const 80))
                  (i32.gt_u (local.get $cb_bits) (i32.sub (local.get $record_size) (local.get $off_bits)))))
            (then (br $finish)))
          (local.set $bmi (i32.add (local.get $record) (local.get $off_bmi)))
          (local.set $bits (i32.add (local.get $record) (local.get $off_bits)))
          (if (i32.eqz (call $gdi_bitmap_plan_info (local.get $bmi) (local.get $plan)))
            (then (br $finish)))
          (if (i32.gt_u (i32.load offset=32 (local.get $plan)) (local.get $cb_bits))
            (then (br $finish)))
          (if (i32.eqz (call $gdi_raster_desc_from_bmi
                (local.get $src) (local.get $bits) (local.get $bmi)))
            (then (br $finish)))
          (local.set $dx (i32.load offset=24 (local.get $record)))
          (local.set $dy (i32.load offset=28 (local.get $record)))
          (local.set $sx (i32.load offset=32 (local.get $record)))
          (local.set $sy (i32.load offset=36 (local.get $record)))
          (local.set $sw (i32.load offset=40 (local.get $record)))
          (local.set $sh (i32.load offset=44 (local.get $record)))
          (local.set $rop (i32.load offset=68 (local.get $record)))
          (local.set $dw (i32.load offset=72 (local.get $record)))
          (local.set $dh (i32.load offset=76 (local.get $record)))
          (local.set $mapped_x (call $gdi_line_map_x (local.get $dst) (local.get $dx)))
          (local.set $mapped_y (call $gdi_line_map_y (local.get $dst) (local.get $dy)))
          (local.set $mapped_w (i32.sub
            (call $gdi_line_map_x (local.get $dst) (i32.add (local.get $dx) (local.get $dw)))
            (local.get $mapped_x)))
          (local.set $mapped_h (i32.sub
            (call $gdi_line_map_y (local.get $dst) (i32.add (local.get $dy) (local.get $dh)))
            (local.get $mapped_y)))
          (if (i32.eqz (call $gdi_raster_stretch_blt
                (local.get $hdc) (i32.const 0) (local.get $dst)
                (local.get $mapped_x) (local.get $mapped_y)
                (local.get $mapped_w) (local.get $mapped_h)
                (local.get $src) (local.get $sx) (local.get $sy)
                (local.get $sw) (local.get $sh) (i32.const 0) (local.get $rop)))
            (then (br $finish)))
          (local.set $right (i32.add (local.get $mapped_x) (local.get $mapped_w)))
          (local.set $bottom (i32.add (local.get $mapped_y) (local.get $mapped_h)))
          (local.set $left (select (local.get $right) (local.get $mapped_x)
            (i32.lt_s (local.get $right) (local.get $mapped_x))))
          (local.set $top (select (local.get $bottom) (local.get $mapped_y)
            (i32.lt_s (local.get $bottom) (local.get $mapped_y))))
          (call $gdi_geometry_present (local.get $hdc) (local.get $dst)
            (local.get $left) (local.get $top)
            (select (local.get $mapped_x) (local.get $right)
              (i32.lt_s (local.get $right) (local.get $mapped_x)))
            (select (local.get $mapped_y) (local.get $bottom)
              (i32.lt_s (local.get $bottom) (local.get $mapped_y))))))
      (local.set $record (i32.add (local.get $record) (local.get $record_size)))
      (br $records))))
    (if (i32.eqz (call $gdi_dc_restore (local.get $hdc) (local.get $outer_save)))
      (then (local.set $result (i32.const 0))))
    (call $gdi_metafile_wmf_objects_delete (local.get $table) (local.get $object_count))
    (call $heap_free (local.get $table_g))
    (i32.and (local.get $result) (local.get $saw_eof)))

  (func $gdi_metafile_convert_wmf_to_emf (param $data i32) (param $size i32)
        (result i32)
    (local $wmf i32) (local $dc i32) (local $result i32)
    (local.set $wmf (call $gdi_metafile_create
      (i32.const 6) (local.get $data) (local.get $size)))
    (if (i32.eqz (local.get $wmf)) (then (return (i32.const 0))))
    (local.set $dc (call $gdi_metafile_recording_dc_create))
    (if (local.get $dc)
      (then
        (if (call $gdi_metafile_play_wmf (local.get $dc) (local.get $wmf)
              (i32.const 0) (i32.const 0) (i32.const 0))
          (then (local.set $result (call $gdi_metafile_snapshot_emf (local.get $dc)))))
        (drop (call $gdi_dc_delete (local.get $dc)))))
    (drop (call $gdi_object_delete_full (local.get $wmf)))
    (local.get $result))

  (func $gdi_metafile_convert_emf_to_wmf (param $handle i32) (result i32)
    (local $dc i32) (local $rect i32) (local $result i32)
    (if (i32.eqz (call $gdi_metafile_record (local.get $handle) (i32.const 7)))
      (then (return (i32.const 0))))
    (local.set $dc (call $gdi_metafile_recording_dc_create))
    (if (i32.eqz (local.get $dc)) (then (return (i32.const 0))))
    (local.set $rect (global.get $GDI_LINE_DESC))
    (memory.fill (local.get $rect) (i32.const 0) (i32.const 16))
    (i32.store offset=8 (local.get $rect) (i32.const 640))
    (i32.store offset=12 (local.get $rect) (i32.const 480))
    (if (call $gdi_metafile_play_emf
          (local.get $dc) (local.get $handle) (local.get $rect))
      (then (local.set $result (call $gdi_metafile_snapshot_wmf (local.get $dc)))))
    (drop (call $gdi_dc_delete (local.get $dc)))
    (local.get $result))

  (func $gdi_metafile_empty_emf (result i32)
    (local $p i32)
    (local.set $p (global.get $GDI_BITMAP_PLAN))
    (memory.fill (local.get $p) (i32.const 0) (i32.const 108))
    (i32.store (local.get $p) (i32.const 1))
    (i32.store offset=4 (local.get $p) (i32.const 88))
    (i32.store offset=40 (local.get $p) (i32.const 0x464D4520))
    (i32.store offset=44 (local.get $p) (i32.const 0x00010000))
    (i32.store offset=48 (local.get $p) (i32.const 108))
    (i32.store offset=52 (local.get $p) (i32.const 2))
    (i32.store16 offset=56 (local.get $p) (i32.const 1))
    (i32.store offset=72 (local.get $p) (i32.const 640))
    (i32.store offset=76 (local.get $p) (i32.const 480))
    (i32.store offset=80 (local.get $p) (i32.const 169))
    (i32.store offset=84 (local.get $p) (i32.const 127))
    (i32.store offset=88 (local.get $p) (i32.const 14))
    (i32.store offset=92 (local.get $p) (i32.const 20))
    (i32.store offset=104 (local.get $p) (i32.const 20))
    (call $gdi_metafile_create (i32.const 7) (local.get $p) (i32.const 108)))

  (func $gdi_enh_metafile_header (param $handle i32) (param $size i32)
        (param $dst i32) (result i32)
    (local $record i32) (local $data i32) (local $available i32) (local $needed i32)
    (local.set $record (call $gdi_metafile_record (local.get $handle) (i32.const 7)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (local.set $data (i32.load offset=24 (local.get $record)))
    (local.set $available (i32.load offset=8 (local.get $record)))
    (if (i32.eqz (call $gdi_metafile_valid_emf (local.get $data) (local.get $available)))
      (then (return (i32.const 0))))
    (local.set $needed (i32.load offset=4 (local.get $data)))
    (if (i32.gt_u (local.get $needed) (local.get $available))
      (then (local.set $needed (local.get $available))))
    (if (i32.eqz (local.get $dst)) (then (return (local.get $needed))))
    (if (i32.lt_u (local.get $size) (local.get $needed)) (then (return (i32.const 0))))
    (memory.copy (local.get $dst) (local.get $data) (local.get $needed))
    (local.get $needed))

  (func $gdi_object_delete_full (param $handle i32) (result i32)
    (local $p i32) (local $type i32) (local $bits i32) (local $flags i32) (local $surface i32)
    (local $owned_bitmap i32)
    (local.set $p (call $gdi_object_record (local.get $handle)))
    (if (i32.eqz (local.get $p))
      (then (return (select (i32.const 1) (i32.const 0)
        (i32.ne (call $gdi_object_type (local.get $handle)) (i32.const 0))))))
    (local.set $type (i32.load offset=4 (local.get $p)))
    (if (i32.eq (local.get $type) (i32.const 3))
      (then
        (local.set $bits (i32.load offset=24 (local.get $p)))
        (local.set $flags (i32.load offset=20 (local.get $p)))
        (local.set $surface (i32.load offset=40 (local.get $p)))
        (drop (call $host_gdi_surface_delete (local.get $surface)))))
    (if (i32.eq (local.get $type) (i32.const 5))
      (then
        (local.set $bits (i32.load offset=24 (local.get $p)))
        (local.set $flags (i32.load offset=20 (local.get $p)))))
    (if (i32.or (i32.eq (local.get $type) (i32.const 6))
          (i32.eq (local.get $type) (i32.const 7)))
      (then
        (local.set $bits (i32.load offset=24 (local.get $p)))
        (local.set $flags (i32.load offset=20 (local.get $p)))))
    (if (i32.and (i32.eq (i32.load offset=4 (local.get $p)) (i32.const 2))
          (i32.or (i32.eq (i32.load offset=8 (local.get $p)) (i32.const 3))
            (i32.eq (i32.load offset=8 (local.get $p)) (i32.const 6))))
      (then (local.set $owned_bitmap (i32.load offset=24 (local.get $p)))))
    (drop (call $gdi_object_delete (local.get $handle)))
    (if (local.get $owned_bitmap)
      (then (drop (call $gdi_object_delete_full (local.get $owned_bitmap)))))
    (if (i32.and (i32.ne (local.get $bits) (i32.const 0))
          (i32.ne (i32.and (local.get $flags) (i32.const 4)) (i32.const 0)))
      (then (call $dib_free_wasm (local.get $bits))))
    (i32.const 1))

  (func $gdi_create_compat_bitmap_internal
        (param $width i32) (param $height i32) (param $backing i32) (result i32)
    (local $size64 i64) (local $bits_ga i32) (local $bits i32) (local $handle i32)
    (if (i32.le_s (local.get $width) (i32.const 0)) (then (local.set $width (i32.const 1))))
    (if (i32.le_s (local.get $height) (i32.const 0)) (then (local.set $height (i32.const 1))))
    (local.set $size64 (i64.mul
      (i64.mul (i64.extend_i32_u (local.get $width)) (i64.extend_i32_u (local.get $height)))
      (i64.const 4)))
    (if (i64.gt_u (local.get $size64) (i64.extend_i32_u (global.get $DIB_BACKING_BASE_SIZE)))
      (then (return (i32.const 0))))
    (local.set $bits (local.get $backing))
    (if (i32.eqz (local.get $bits))
      (then
        (local.set $bits_ga (call $dib_alloc (i32.wrap_i64 (local.get $size64))))
        (if (i32.eqz (local.get $bits_ga)) (then (return (i32.const 0))))
        (local.set $bits (call $g2w (local.get $bits_ga)))))
    (local.set $handle (call $gdi_bitmap_alloc
      (local.get $width) (local.get $height) (i32.const 32) (i32.const 6)
      (local.get $bits) (i32.mul (local.get $width) (i32.const 4))
      (i32.const 0) (i32.const 0)))
    (if (i32.and (i32.eqz (local.get $handle)) (i32.eqz (local.get $backing)))
      (then (call $dib_free_wasm (local.get $bits))))
    (local.get $handle))

  ;; DC record offsets: hdc, pen, brush, pos x/y, text/bk colors, bk mode,
  ;; text align, map mode, window origin/extents, viewport origin/extents,
  ;; ROP2, polygon fill mode, stretch mode, bitmap, font, reserved.
  (func $gdi_dc_state_entry (param $hdc i32) (param $create i32) (result i32)
    (local $i i32) (local $p i32) (local $empty i32)
    (local $hwnd i32) (local $binding i32)
    (if (i32.eqz (local.get $hdc)) (then (return (i32.const 0))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_DC_STATE_COUNT)))
      (local.set $p (i32.add (global.get $GDI_DC_STATE_TABLE)
        (i32.mul (local.get $i) (global.get $GDI_DC_STATE_STRIDE))))
      (if (i32.eq (i32.load (local.get $p)) (local.get $hdc)) (then (return (local.get $p))))
      (if (i32.and (i32.eqz (local.get $empty)) (i32.eqz (i32.load (local.get $p))))
        (then (local.set $empty (local.get $p))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    ;; Recognize legacy internal window DC encodings during lookup itself so
    ;; a geometry operation can be the first consumer; adoption must not
    ;; depend on an earlier SelectObject/text-state call creating the record.
    (if (i32.and (i32.ge_u (local.get $hdc) (i32.const 0x00050000))
          (i32.lt_u (local.get $hdc) (i32.const 0x000D0000)))
      (then
        (local.set $hwnd (i32.sub (local.get $hdc) (i32.const 0x00040000)))
        (if (i32.ne (call $wnd_table_find (local.get $hwnd)) (i32.const -1))
          (then (local.set $binding (local.get $hwnd))))))
    (if (i32.and (i32.ge_u (local.get $hdc) (i32.const 0x000D0000))
          (i32.lt_u (local.get $hdc) (i32.const 0x001D0000)))
      (then
        (local.set $hwnd (i32.sub (local.get $hdc) (i32.const 0x000C0000)))
        (if (i32.ne (call $wnd_table_find (local.get $hwnd)) (i32.const -1))
          (then (local.set $binding
            (i32.or (local.get $hwnd) (i32.const 0x80000000)))))))
    (if (i32.and (i32.or (i32.ne (local.get $create) (i32.const 0))
                          (i32.ne (local.get $binding) (i32.const 0)))
          (i32.ne (local.get $empty) (i32.const 0)))
      (then
        (memory.fill (local.get $empty) (i32.const 0) (global.get $GDI_DC_STATE_STRIDE))
        (i32.store (local.get $empty) (local.get $hdc))
        (i32.store offset=4 (local.get $empty) (i32.const 0x30017))
        (i32.store offset=8 (local.get $empty) (i32.const 0x30010))
        (i32.store offset=24 (local.get $empty) (i32.const 0xFFFFFF))
        (i32.store offset=28 (local.get $empty) (i32.const 2))
        (i32.store offset=36 (local.get $empty) (i32.const 1))
        (i32.store offset=48 (local.get $empty) (i32.const 1))
        (i32.store offset=52 (local.get $empty) (i32.const 1))
        (i32.store offset=64 (local.get $empty) (i32.const 1))
        (i32.store offset=68 (local.get $empty) (i32.const 1))
        (i32.store offset=72 (local.get $empty) (i32.const 13))
        (i32.store offset=76 (local.get $empty) (i32.const 1))
        (i32.store offset=80 (local.get $empty) (i32.const 1))
        (i32.store offset=84 (local.get $empty) (i32.const 0x30007))
        (i32.store offset=88 (local.get $empty) (i32.const 0x3001D))
        ;; WAT-native controls historically used hwnd+0x40000 directly as a
        ;; client DC, while nonclient painters used hwnd+0xC0000. Adopt those
        ;; values into the same canonical table as GetDC/BeginPaint handles.
        ;; The encoding is only accepted when it resolves to a live WAT HWND,
        ;; so ordinary allocated DC/object namespaces cannot be misclassified.
        (if (local.get $binding)
          (then (i32.store offset=92 (local.get $empty) (local.get $binding))))
        (return (local.get $empty))))
    (i32.const 0))

  (func $gdi_dc_get_field (param $hdc i32) (param $offset i32) (param $default i32) (result i32)
    (local $entry i32)
    (local.set $entry (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
    (if (i32.eqz (local.get $entry)) (then (return (local.get $default))))
    (i32.load (i32.add (local.get $entry) (local.get $offset))))

  (func $gdi_dc_set_field (param $hdc i32) (param $offset i32) (param $value i32)
        (param $default i32) (result i32)
    (local $entry i32) (local $old i32)
    (local.set $entry (call $gdi_dc_state_entry (local.get $hdc) (i32.const 1)))
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (local.set $old (i32.load (i32.add (local.get $entry) (local.get $offset))))
    (i32.store (i32.add (local.get $entry) (local.get $offset)) (local.get $value))
    (local.get $old))

  ;; Extended per-DC state that does not fit the stable 96-byte hot record:
  ;; hdc, arc direction, brush origin x/y, mapper flags, character extra,
  ;; and justification extra/break count. COLORADJUSTMENT uses a parallel
  ;; fixed table indexed by this DC's canonical state slot.
  (func $gdi_dc_aux_entry (param $hdc i32) (param $create i32) (result i32)
    (local $i i32) (local $p i32) (local $empty i32)
    (if (i32.eqz (local.get $hdc)) (then (return (i32.const 0))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_DC_AUX_COUNT)))
      (local.set $p (i32.add (global.get $GDI_DC_AUX_TABLE)
        (i32.mul (local.get $i) (global.get $GDI_DC_AUX_STRIDE))))
      (if (i32.eq (i32.load (local.get $p)) (local.get $hdc))
        (then (return (local.get $p))))
      (if (i32.and (i32.eqz (local.get $empty)) (i32.eqz (i32.load (local.get $p))))
        (then (local.set $empty (local.get $p))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.and (i32.ne (local.get $create) (i32.const 0))
          (i32.ne (local.get $empty) (i32.const 0)))
      (then
        (memory.fill (local.get $empty) (i32.const 0) (global.get $GDI_DC_AUX_STRIDE))
        (i32.store (local.get $empty) (local.get $hdc))
        (i32.store offset=4 (local.get $empty) (i32.const 1))
        (return (local.get $empty))))
    (i32.const 0))

  (func $gdi_dc_aux_get (param $hdc i32) (param $offset i32) (param $default i32) (result i32)
    (local $p i32)
    (local.set $p (call $gdi_dc_aux_entry (local.get $hdc) (i32.const 0)))
    (if (i32.eqz (local.get $p)) (then (return (local.get $default))))
    (i32.load (i32.add (local.get $p) (local.get $offset))))

  (func $gdi_dc_aux_set (param $hdc i32) (param $offset i32) (param $value i32)
        (param $default i32) (result i32)
    (local $p i32) (local $old i32)
    (local.set $p (call $gdi_dc_aux_entry (local.get $hdc) (i32.const 1)))
    (if (i32.eqz (local.get $p)) (then (return (i32.const 0))))
    (local.set $old (i32.load (i32.add (local.get $p) (local.get $offset))))
    (i32.store (i32.add (local.get $p) (local.get $offset)) (local.get $value))
    (local.get $old))

  (func $gdi_dc_aux_release (param $hdc i32)
    (local $p i32)
    (local.set $p (call $gdi_dc_aux_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $p)
      (then (memory.fill (local.get $p) (i32.const 0) (global.get $GDI_DC_AUX_STRIDE)))))

  (func $gdi_color_adjustment_entry (param $hdc i32) (param $create i32) (result i32)
    (local $dc i32) (local $entry i32)
    (local.set $dc (call $gdi_dc_state_entry (local.get $hdc) (local.get $create)))
    (if (i32.eqz (local.get $dc)) (then (return (i32.const 0))))
    (local.set $entry (i32.add (global.get $GDI_COLOR_ADJUST_TABLE)
      (i32.div_u (i32.mul
        (i32.sub (local.get $dc) (global.get $GDI_DC_STATE_TABLE)) (i32.const 24))
        (global.get $GDI_DC_STATE_STRIDE))))
    (local.get $entry))

  (func $gdi_color_adjustment_init (param $entry i32)
    (if (i32.eqz (i32.load16_u (local.get $entry)))
      (then
        (i32.store16 (local.get $entry) (i32.const 24))
        (i32.store16 offset=2 (local.get $entry) (i32.const 0))
        (i32.store16 offset=4 (local.get $entry) (i32.const 0))
        (i32.store16 offset=6 (local.get $entry) (i32.const 10000))
        (i32.store16 offset=8 (local.get $entry) (i32.const 10000))
        (i32.store16 offset=10 (local.get $entry) (i32.const 10000))
        (i32.store16 offset=12 (local.get $entry) (i32.const 0))
        (i32.store16 offset=14 (local.get $entry) (i32.const 10000))
        (i32.store16 offset=16 (local.get $entry) (i32.const 0))
        (i32.store16 offset=18 (local.get $entry) (i32.const 0))
        (i32.store16 offset=20 (local.get $entry) (i32.const 0))
        (i32.store16 offset=22 (local.get $entry) (i32.const 0)))))

  (func $gdi_color_adjustment_set (param $hdc i32) (param $src i32) (result i32)
    (local $entry i32) (local $contrast i32) (local $brightness i32)
    (local $colorfulness i32) (local $tint i32) (local $illuminant i32)
    (local $flags i32) (local $red_gamma i32) (local $green_gamma i32)
    (local $blue_gamma i32) (local $black i32) (local $white i32)
    (if (i32.eqz (local.get $src)) (then (return (i32.const 0))))
    (if (i32.ne (i32.load16_u (local.get $src)) (i32.const 24))
      (then (return (i32.const 0))))
    (local.set $flags (i32.load16_u offset=2 (local.get $src)))
    (local.set $illuminant (i32.load16_u offset=4 (local.get $src)))
    (local.set $red_gamma (i32.load16_u offset=6 (local.get $src)))
    (local.set $green_gamma (i32.load16_u offset=8 (local.get $src)))
    (local.set $blue_gamma (i32.load16_u offset=10 (local.get $src)))
    (local.set $black (i32.load16_u offset=12 (local.get $src)))
    (local.set $white (i32.load16_u offset=14 (local.get $src)))
    (local.set $contrast (i32.load16_s offset=16 (local.get $src)))
    (local.set $brightness (i32.load16_s offset=18 (local.get $src)))
    (local.set $colorfulness (i32.load16_s offset=20 (local.get $src)))
    (local.set $tint (i32.load16_s offset=22 (local.get $src)))
    (if (i32.or (i32.gt_u (local.get $flags) (i32.const 3))
      (i32.or (i32.gt_u (local.get $illuminant) (i32.const 8))
      (i32.or (i32.lt_u (local.get $red_gamma) (i32.const 2500))
      (i32.or (i32.gt_u (local.get $red_gamma) (i32.const 65000))
      (i32.or (i32.lt_u (local.get $green_gamma) (i32.const 2500))
      (i32.or (i32.gt_u (local.get $green_gamma) (i32.const 65000))
      (i32.or (i32.lt_u (local.get $blue_gamma) (i32.const 2500))
      (i32.or (i32.gt_u (local.get $blue_gamma) (i32.const 65000))
      (i32.or (i32.gt_u (local.get $black) (i32.const 4000))
      (i32.or (i32.lt_u (local.get $white) (i32.const 6000))
      (i32.or (i32.gt_u (local.get $white) (i32.const 10000))
          (i32.or (i32.lt_s (local.get $contrast) (i32.const -100))
            (i32.or (i32.gt_s (local.get $contrast) (i32.const 100))
              (i32.or (i32.lt_s (local.get $brightness) (i32.const -100))
                (i32.or (i32.gt_s (local.get $brightness) (i32.const 100))
                  (i32.or (i32.lt_s (local.get $colorfulness) (i32.const -100))
                    (i32.or (i32.gt_s (local.get $colorfulness) (i32.const 100))
                      (i32.or (i32.lt_s (local.get $tint) (i32.const -100))
                        (i32.gt_s (local.get $tint) (i32.const 100))))))))))))))))))))
      (then (return (i32.const 0))))
    (local.set $entry (call $gdi_color_adjustment_entry (local.get $hdc) (i32.const 1)))
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (memory.copy (local.get $entry) (local.get $src) (i32.const 24))
    (i32.const 1))

  (func $gdi_color_adjustment_get (param $hdc i32) (param $dst i32) (result i32)
    (local $entry i32)
    (if (i32.eqz (local.get $dst)) (then (return (i32.const 0))))
    (local.set $entry (call $gdi_color_adjustment_entry (local.get $hdc) (i32.const 1)))
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (call $gdi_color_adjustment_init (local.get $entry))
    (memory.copy (local.get $dst) (local.get $entry) (i32.const 24))
    (i32.const 1))

  (func $gdi_gamma_ramp_set (param $hdc i32) (param $src i32) (result i32)
    (local $guest i32)
    (if (i32.or (i32.eqz (local.get $src))
          (i32.eqz (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0))))
      (then (return (i32.const 0))))
    (if (i32.eqz (global.get $gdi_gamma_ramp_guest))
      (then
        (local.set $guest (call $heap_alloc (i32.const 1536)))
        (if (i32.eqz (local.get $guest)) (then (return (i32.const 0))))
        (global.set $gdi_gamma_ramp_guest (local.get $guest))))
    (memory.copy (call $g2w (global.get $gdi_gamma_ramp_guest))
      (local.get $src) (i32.const 1536))
    (i32.const 1))

  (func $gdi_gamma_ramp_get (param $hdc i32) (param $dst i32) (result i32)
    (local $channel i32) (local $index i32)
    (if (i32.or (i32.eqz (local.get $dst))
          (i32.eqz (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0))))
      (then (return (i32.const 0))))
    (if (global.get $gdi_gamma_ramp_guest)
      (then
        (memory.copy (local.get $dst) (call $g2w (global.get $gdi_gamma_ramp_guest))
          (i32.const 1536))
        (return (i32.const 1))))
    (block $channels_done (loop $channels
      (br_if $channels_done (i32.ge_u (local.get $channel) (i32.const 3)))
      (local.set $index (i32.const 0))
      (block $entries_done (loop $entries
        (br_if $entries_done (i32.ge_u (local.get $index) (i32.const 256)))
        (i32.store16 (i32.add (local.get $dst)
            (i32.add (i32.mul (local.get $channel) (i32.const 512))
              (i32.shl (local.get $index) (i32.const 1))))
          (i32.mul (local.get $index) (i32.const 257)))
        (local.set $index (i32.add (local.get $index) (i32.const 1)))
        (br $entries)))
      (local.set $channel (i32.add (local.get $channel) (i32.const 1)))
      (br $channels)))
    (i32.const 1))

  (func $gdi_pixel_format_write (param $dst i32) (param $bytes i32)
        (result i32)
    (local $copy i32)
    (if (i32.eqz (local.get $dst)) (then (return (i32.const 1))))
    (local.set $copy (local.get $bytes))
    (if (i32.gt_u (local.get $copy) (i32.const 40))
      (then (local.set $copy (i32.const 40))))
    (memory.fill (local.get $dst) (i32.const 0) (local.get $copy))
    (if (i32.ge_u (local.get $copy) (i32.const 2))
      (then (i32.store16 (local.get $dst) (i32.const 40))))
    (if (i32.ge_u (local.get $copy) (i32.const 4))
      (then (i32.store16 offset=2 (local.get $dst) (i32.const 1))))
    (if (i32.ge_u (local.get $copy) (i32.const 8))
      (then (i32.store offset=4 (local.get $dst) (i32.const 0x00000025))))
    (if (i32.ge_u (local.get $copy) (i32.const 10))
      (then
        (i32.store8 offset=8 (local.get $dst) (i32.const 0))
        (i32.store8 offset=9 (local.get $dst) (i32.const 32))))
    (if (i32.ge_u (local.get $copy) (i32.const 18))
      (then
        (i32.store8 offset=10 (local.get $dst) (i32.const 8))
        (i32.store8 offset=11 (local.get $dst) (i32.const 16))
        (i32.store8 offset=12 (local.get $dst) (i32.const 8))
        (i32.store8 offset=13 (local.get $dst) (i32.const 8))
        (i32.store8 offset=14 (local.get $dst) (i32.const 8))
        (i32.store8 offset=15 (local.get $dst) (i32.const 0))
        (i32.store8 offset=16 (local.get $dst) (i32.const 8))
        (i32.store8 offset=17 (local.get $dst) (i32.const 24))))
    (if (i32.ge_u (local.get $copy) (i32.const 25))
      (then
        (i32.store8 offset=23 (local.get $dst) (i32.const 24))
        (i32.store8 offset=24 (local.get $dst) (i32.const 8))))
    (i32.const 1))

  (func $gdi_pixel_format_choose (param $hdc i32) (param $pfd i32) (result i32)
    (if (i32.or (i32.eqz (local.get $pfd))
          (i32.eqz (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0))))
      (then (return (i32.const 0))))
    (if (i32.or (i32.ne (i32.load16_u (local.get $pfd)) (i32.const 40))
          (i32.ne (i32.load16_u offset=2 (local.get $pfd)) (i32.const 1)))
      (then (return (i32.const 0))))
    (i32.const 1))

  (func $gdi_pixel_format_set (param $hdc i32) (param $format i32)
        (param $pfd i32) (result i32)
    (if (i32.or (i32.ne (local.get $format) (i32.const 1))
          (i32.eqz (call $gdi_pixel_format_choose (local.get $hdc) (local.get $pfd))))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gdi_dc_meta_get (local.get $hdc) (i32.const 16)
          (i32.const 0)) (i32.const 0))
      (then (return (i32.const 0))))
    (drop (call $gdi_dc_meta_set (local.get $hdc) (i32.const 16)
      (i32.const 1) (i32.const 0)))
    (i32.const 1))

  ;; A SaveDC node is 176 bytes in the guest heap:
  ;; next guest pointer, level, 96-byte hot state, 32-byte auxiliary state,
  ;; 24-byte COLORADJUSTMENT, selected palette, an owned clip snapshot,
  ;; graphics mode, and system-palette use.
  (func $gdi_dc_save_node_free (param $node_g i32)
    (local $node i32) (local $clip i32)
    (if (i32.eqz (local.get $node_g)) (then (return)))
    (local.set $node (call $g2w (local.get $node_g)))
    (local.set $clip (i32.load offset=164 (local.get $node)))
    (if (local.get $clip) (then (drop (call $gdi_rgn_delete (local.get $clip)))))
    (call $heap_free (local.get $node_g)))

  (func $gdi_dc_meta_release (param $hdc i32)
    (local $i i32) (local $p i32) (local $meta_g i32) (local $meta i32)
    (local $node_g i32) (local $next_g i32) (local $recording_bitmap i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_DC_SAVE_COUNT)))
      (local.set $p (i32.add (global.get $GDI_DC_SAVE_TABLE)
        (i32.shl (local.get $i) (i32.const 3))))
      (if (i32.eq (i32.load (local.get $p)) (local.get $hdc)) (then (br $done)))
      (local.set $p (i32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.eqz (local.get $p)) (then (return)))
    (local.set $meta_g (i32.load offset=4 (local.get $p)))
    (if (local.get $meta_g)
      (then
        (local.set $meta (call $g2w (local.get $meta_g)))
        (if (i32.eq (i32.load offset=20 (local.get $meta)) (i32.const 0x4D464443))
          (then (local.set $recording_bitmap (i32.load offset=24 (local.get $meta)))))
        (local.set $node_g (i32.load offset=4 (local.get $meta)))
        (block $freed (loop $free
          (br_if $freed (i32.eqz (local.get $node_g)))
          (local.set $next_g (i32.load (call $g2w (local.get $node_g))))
          (call $gdi_dc_save_node_free (local.get $node_g))
          (local.set $node_g (local.get $next_g))
          (br $free)))
        (call $heap_free (local.get $meta_g))))
    (i64.store (local.get $p) (i64.const 0))
    (if (local.get $recording_bitmap)
      (then (drop (call $gdi_object_delete_full (local.get $recording_bitmap))))))

  (func $gdi_dc_save (param $hdc i32) (result i32)
    (local $dc i32) (local $aux i32) (local $color i32) (local $meta i32)
    (local $clip_entry i32) (local $clip i32) (local $clip_copy i32)
    (local $head_g i32) (local $node_g i32) (local $node i32) (local $level i32)
    (local.set $dc (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
    (if (i32.eqz (local.get $dc)) (then (return (i32.const 0))))
    (local.set $meta (call $gdi_dc_meta_entry (local.get $hdc) (i32.const 1)))
    (if (i32.eqz (local.get $meta)) (then (return (i32.const 0))))
    (local.set $head_g (i32.load offset=4 (local.get $meta)))
    (local.set $level (i32.const 1))
    (if (local.get $head_g)
      (then (local.set $level (i32.add
        (i32.load offset=4 (call $g2w (local.get $head_g))) (i32.const 1)))))
    (local.set $clip_entry (call $gdi_dc_clip_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $clip_entry)
      (then (local.set $clip (i32.load offset=4 (local.get $clip_entry)))))
    (if (local.get $clip)
      (then
        (local.set $clip_copy (call $gdi_rgn_alloc_rect
          (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
        (if (i32.or (i32.eqz (local.get $clip_copy))
              (i32.eqz (call $gdi_rgn_combine
                (local.get $clip_copy) (local.get $clip) (i32.const 0) (i32.const 5))))
          (then
            (if (local.get $clip_copy)
              (then (drop (call $gdi_rgn_delete (local.get $clip_copy)))))
            (return (i32.const 0))))))
    (local.set $node_g (call $heap_alloc (i32.const 176)))
    (if (i32.eqz (local.get $node_g))
      (then
        (if (local.get $clip_copy)
          (then (drop (call $gdi_rgn_delete (local.get $clip_copy)))))
        (return (i32.const 0))))
    (local.set $node (call $g2w (local.get $node_g)))
    (memory.fill (local.get $node) (i32.const 0) (i32.const 176))
    (i32.store (local.get $node) (local.get $head_g))
    (i32.store offset=4 (local.get $node) (local.get $level))
    (memory.copy (i32.add (local.get $node) (i32.const 8))
      (local.get $dc) (global.get $GDI_DC_STATE_STRIDE))
    (local.set $aux (call $gdi_dc_aux_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $aux)
      (then (memory.copy (i32.add (local.get $node) (i32.const 104))
        (local.get $aux) (global.get $GDI_DC_AUX_STRIDE))))
    (local.set $color (call $gdi_color_adjustment_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $color)
      (then (memory.copy (i32.add (local.get $node) (i32.const 136))
        (local.get $color) (i32.const 24))))
    (i32.store offset=160 (local.get $node) (call $gdi_dc_selected_palette (local.get $hdc)))
    (i32.store offset=164 (local.get $node) (local.get $clip_copy))
    (i32.store offset=168 (local.get $node) (i32.load offset=8 (local.get $meta)))
    (i32.store offset=172 (local.get $node) (i32.load offset=12 (local.get $meta)))
    (i32.store offset=4 (local.get $meta) (local.get $node_g))
    (local.get $level))

  (func $gdi_dc_restore (param $hdc i32) (param $saved i32) (result i32)
    (local $dc i32) (local $meta i32) (local $head_g i32) (local $node_g i32) (local $node i32)
    (local $target_g i32) (local $target i32) (local $steps i32) (local $level i32)
    (local $aux i32) (local $color i32) (local $clip i32) (local $next_g i32)
    (local.set $dc (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
    (local.set $meta (call $gdi_dc_meta_entry (local.get $hdc) (i32.const 0)))
    (if (i32.or (i32.eqz (local.get $dc))
          (i32.or (i32.eqz (local.get $meta)) (i32.eqz (local.get $saved))))
      (then (return (i32.const 0))))
    (local.set $head_g (i32.load offset=4 (local.get $meta)))
    (local.set $node_g (local.get $head_g))
    (if (i32.lt_s (local.get $saved) (i32.const 0))
      (then
        (local.set $steps (i32.sub (i32.const 0) (local.get $saved)))
        (if (i32.le_s (local.get $steps) (i32.const 0))
          (then (return (i32.const 0))))
        (block $relative_done (loop $relative
          (br_if $relative_done (i32.eqz (local.get $node_g)))
          (local.set $steps (i32.sub (local.get $steps) (i32.const 1)))
          (if (i32.eqz (local.get $steps))
            (then (local.set $target_g (local.get $node_g)) (br $relative_done)))
          (local.set $node_g (i32.load (call $g2w (local.get $node_g))))
          (br $relative))))
      (else
        (local.set $level (local.get $saved))
        (block $absolute_done (loop $absolute
          (br_if $absolute_done (i32.eqz (local.get $node_g)))
          (local.set $node (call $g2w (local.get $node_g)))
          (if (i32.eq (i32.load offset=4 (local.get $node)) (local.get $level))
            (then (local.set $target_g (local.get $node_g)) (br $absolute_done)))
          (local.set $node_g (i32.load (local.get $node)))
          (br $absolute)))))
    (if (i32.eqz (local.get $target_g)) (then (return (i32.const 0))))
    (local.set $target (call $g2w (local.get $target_g)))
    (if (i32.load (i32.add (local.get $target) (i32.const 104)))
      (then
        (local.set $aux (call $gdi_dc_aux_entry (local.get $hdc) (i32.const 1)))
        (if (i32.eqz (local.get $aux)) (then (return (i32.const 0))))))
    (local.set $clip (i32.load offset=164 (local.get $target)))
    (if (i32.eqz
          (if (result i32) (local.get $clip)
            (then (call $gdi_dc_clip_select (local.get $hdc) (local.get $clip)))
            (else (call $gdi_dc_clip_clear (local.get $hdc)))))
      (then (return (i32.const 0))))
    (memory.copy (local.get $dc) (i32.add (local.get $target) (i32.const 8))
      (global.get $GDI_DC_STATE_STRIDE))
    (if (i32.load (i32.add (local.get $target) (i32.const 104)))
      (then
        (memory.copy (local.get $aux) (i32.add (local.get $target) (i32.const 104))
          (global.get $GDI_DC_AUX_STRIDE)))
      (else (call $gdi_dc_aux_release (local.get $hdc))))
    (local.set $color (call $gdi_color_adjustment_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $color)
      (then (memory.copy (local.get $color) (i32.add (local.get $target) (i32.const 136))
        (i32.const 24))))
    (i32.store (local.get $meta) (i32.load offset=160 (local.get $target)))
    (i32.store offset=8 (local.get $meta) (i32.load offset=168 (local.get $target)))
    (i32.store offset=12 (local.get $meta) (i32.load offset=172 (local.get $target)))
    (i32.store offset=4 (local.get $meta) (i32.load (local.get $target)))
    ;; The restored node and every newer node are discarded.
    (local.set $node_g (local.get $head_g))
    (block $purged (loop $purge
      (br_if $purged (i32.eqz (local.get $node_g)))
      (local.set $next_g (i32.load (call $g2w (local.get $node_g))))
      (call $gdi_dc_save_node_free (local.get $node_g))
      (if (i32.eq (local.get $node_g) (local.get $target_g)) (then (br $purged)))
      (local.set $node_g (local.get $next_g))
      (br $purge)))
    (i32.const 1))

  (func $gdi_dc_select_owned_object (param $hdc i32) (param $handle i32) (result i32)
    (local $type i32)
    (local.set $type (call $gdi_object_type (local.get $handle)))
    (if (i32.eq (local.get $type) (i32.const 1))
      (then (return (call $gdi_dc_set_field
        (local.get $hdc) (i32.const 4) (local.get $handle) (i32.const 0x30017)))))
    (if (i32.eq (local.get $type) (i32.const 2))
      (then (return (call $gdi_dc_set_field
        (local.get $hdc) (i32.const 8) (local.get $handle) (i32.const 0x30010)))))
    (if (i32.eq (local.get $type) (i32.const 3))
      (then (return (call $gdi_dc_set_field
        (local.get $hdc) (i32.const 84) (local.get $handle) (i32.const 0x30007)))))
    (if (i32.eq (local.get $type) (i32.const 4))
      (then (return (call $gdi_dc_set_field
        (local.get $hdc) (i32.const 88) (local.get $handle) (i32.const 0x3001D)))))
    (i32.const -1))

  (func $gdi_font_height (param $handle i32) (result i32)
    (local $p i32)
    (local.set $p (call $gdi_object_record (local.get $handle)))
    (if (i32.and (i32.ne (local.get $p) (i32.const 0))
          (i32.eq (i32.load offset=4 (local.get $p)) (i32.const 4)))
      (then (return (i32.load offset=8 (local.get $p)))))
    ;; OEM_FIXED_FONT is the native 8x12 Terminal stock object.
    (if (i32.eq (local.get $handle) (i32.const 0x3001A))
      (then (return (i32.const 12))))
    (if (i32.or (i32.eq (local.get $handle) (i32.const 0x3001B))
          (i32.eq (local.get $handle) (i32.const 0x30020)))
      (then (return (i32.const 16))))
    (if (i32.or (i32.eq (local.get $handle) (i32.const 0x30021))
          (i32.eq (local.get $handle) (i32.const 0x30022)))
      (then (return (i32.const 11))))
    (i32.const 12))

  (func $gdi_font_weight (param $handle i32) (result i32)
    (local $p i32)
    (local.set $p (call $gdi_object_record (local.get $handle)))
    (if (i32.and (i32.ne (local.get $p) (i32.const 0))
          (i32.eq (i32.load offset=4 (local.get $p)) (i32.const 4)))
      (then (return (i32.load offset=12 (local.get $p)))))
    (select (i32.const 700) (i32.const 400)
      (i32.eq (local.get $handle) (i32.const 0x30022))))

  (func $gdi_font_italic (param $handle i32) (result i32)
    (local $p i32)
    (local.set $p (call $gdi_object_record (local.get $handle)))
    (if (i32.and (i32.ne (local.get $p) (i32.const 0))
          (i32.eq (i32.load offset=4 (local.get $p)) (i32.const 4)))
      (then (return (i32.and (i32.load offset=16 (local.get $p)) (i32.const 1)))))
    (i32.const 0))

  ;; Serialize a stable Win98-compatible LOGFONT. The Canvas text boundary may
  ;; resolve a more specific face for rasterization, but GDI layout callers
  ;; receive deterministic metrics and "MS Sans Serif" here.
  (func $gdi_font_write_logfont (param $handle i32) (param $dest i32)
        (param $size i32) (param $wide i32) (result i32)
    (local $required i32) (local $i i32) (local $ch i32)
    (if (i32.ne (call $gdi_object_type (local.get $handle)) (i32.const 4))
      (then (return (i32.const 0))))
    (local.set $required (select (i32.const 92) (i32.const 60) (local.get $wide)))
    (if (i32.eqz (local.get $dest)) (then (return (local.get $required))))
    (if (i32.lt_u (local.get $size) (local.get $required)) (then (return (i32.const 0))))
    (memory.fill (local.get $dest) (i32.const 0) (local.get $required))
    (i32.store (local.get $dest) (call $gdi_font_height (local.get $handle)))
    (i32.store offset=16 (local.get $dest) (call $gdi_font_weight (local.get $handle)))
    (i32.store8 offset=20 (local.get $dest) (call $gdi_font_italic (local.get $handle)))
    (i32.store8 offset=27 (local.get $dest) (i32.const 0x22))
    ;; "MS Sans Serif" including its terminator.
    (local.set $i (i32.const 0))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (i32.const 14)))
      (local.set $ch
        (i32.load8_u (i32.add (i32.const 0x3288) (local.get $i))))
      (if (local.get $wide)
        (then (i32.store16 (i32.add (local.get $dest)
          (i32.add (i32.const 28) (i32.shl (local.get $i) (i32.const 1)))) (local.get $ch)))
        (else (i32.store8 (i32.add (local.get $dest)
          (i32.add (i32.const 28) (local.get $i))) (local.get $ch))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (local.get $required))

  ;; Serialize the fixed Win32 LOGPEN/LOGBRUSH contracts from canonical WAT
  ;; object records. Extended pens currently expose their base LOGPEN fields;
  ;; user-style arrays are added when their owned storage is implemented.
  (func $gdi_object_write_pen_brush (param $handle i32) (param $dest i32)
        (param $size i32) (result i32)
    (local $record i32) (local $type i32) (local $required i32)
    (local.set $record (call $gdi_object_record (local.get $handle)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (local.set $type (i32.load offset=4 (local.get $record)))
    (if (i32.eq (local.get $type) (i32.const 1))
      (then (local.set $required (i32.const 16)))
      (else (if (i32.eq (local.get $type) (i32.const 2))
        (then (local.set $required (i32.const 12)))
        (else (return (i32.const 0))))))
    (if (i32.eqz (local.get $dest)) (then (return (local.get $required))))
    (if (i32.lt_u (local.get $size) (local.get $required))
      (then (return (i32.const 0))))
    (memory.fill (local.get $dest) (i32.const 0) (local.get $required))
    (i32.store (local.get $dest) (i32.or
      (i32.load offset=8 (local.get $record))
      (i32.and (i32.load offset=20 (local.get $record)) (i32.const 0x000F0F00))))
    (if (i32.eq (local.get $type) (i32.const 1))
      (then
        (i32.store offset=4 (local.get $dest) (i32.load offset=12 (local.get $record)))
        (i32.store offset=12 (local.get $dest) (i32.load offset=16 (local.get $record))))
      (else
        (i32.store offset=4 (local.get $dest) (i32.load offset=16 (local.get $record)))
        (i32.store offset=8 (local.get $dest) (i32.load offset=12 (local.get $record)))))
    (local.get $required))

  (func $gdi_dc_alloc (result i32)
    (local $handle i32) (local $attempts i32)
    ;; DC records are process-shared as well. A worker's stale counter must not
    ;; select its printer bitmap into an active main-thread screen/window DC.
    (block $available (loop $scan
      (if (i32.ge_u (local.get $attempts) (global.get $GDI_DC_STATE_COUNT))
        (then (return (i32.const 0))))
      (local.set $handle (global.get $gdi_next_dc_handle))
      (global.set $gdi_next_dc_handle
        (i32.add (local.get $handle) (i32.const 1)))
      (if (i32.eqz (call $gdi_dc_state_entry (local.get $handle) (i32.const 0)))
        (then (br $available)))
      (local.set $attempts (i32.add (local.get $attempts) (i32.const 1)))
      (br $scan)))
    (if (i32.eqz (call $gdi_dc_state_entry (local.get $handle) (i32.const 1)))
      (then (return (i32.const 0))))
    (local.get $handle))

  (func $gdi_dc_delete (param $hdc i32) (result i32)
    (if (i32.eqz (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
      (then (return (i32.const 0))))
    (call $gdi_dc_clip_release (local.get $hdc))
    (call $gdi_dc_state_release (local.get $hdc))
    (i32.const 1))

  ;; Ensure a screen-sized canonical bitmap/DC for popup menus. Menu layout
  ;; and hit testing use desktop coordinates, so painting through an owning
  ;; window DC would apply its client origin a second time and clip the popup
  ;; at the window boundary. Attachment target zero is the compositor overlay
  ;; presentation; the pixels remain owned and rasterized entirely in WAT.
  (func $gdi_menu_overlay_ensure (result i32)
    (local $wh i32) (local $width i32) (local $height i32)
    (local $bitmap i32) (local $dc i32)
    (local.set $wh (call $host_get_screen_size))
    (local.set $width (i32.and (local.get $wh) (i32.const 0xFFFF)))
    (local.set $height (i32.shr_u (local.get $wh) (i32.const 16)))
    (if (i32.or (i32.le_s (local.get $width) (i32.const 0))
          (i32.le_s (local.get $height) (i32.const 0)))
      (then (return (i32.const 0))))
    (local.set $bitmap (global.get $gdi_menu_overlay_bitmap))
    (if (local.get $bitmap)
      (then
        (if (i32.and
              (i32.ne (call $gdi_object_record (local.get $bitmap)) (i32.const 0))
              (i32.and
                (i32.eq (global.get $gdi_menu_overlay_width) (local.get $width))
                (i32.eq (global.get $gdi_menu_overlay_height) (local.get $height))))
          (then
            (drop (call $host_gdi_surface_attach (local.get $bitmap) (i32.const 0)))
            (return (global.get $gdi_menu_overlay_dc))))
        (drop (call $gdi_object_delete_full (local.get $bitmap)))
        (global.set $gdi_menu_overlay_bitmap (i32.const 0))
        (global.set $gdi_menu_overlay_width (i32.const 0))
        (global.set $gdi_menu_overlay_height (i32.const 0))))
    (local.set $bitmap (call $gdi_create_compat_bitmap_internal
      (local.get $width) (local.get $height) (i32.const 0)))
    (if (i32.eqz (local.get $bitmap)) (then (return (i32.const 0))))
    (local.set $dc (global.get $gdi_menu_overlay_dc))
    (if (i32.eqz (local.get $dc))
      (then
        (local.set $dc (call $gdi_dc_alloc))
        (if (i32.eqz (local.get $dc))
          (then
            (drop (call $gdi_object_delete_full (local.get $bitmap)))
            (return (i32.const 0))))
        (global.set $gdi_menu_overlay_dc (local.get $dc))))
    (drop (call $gdi_dc_select_owned_object (local.get $dc) (local.get $bitmap)))
    (global.set $gdi_menu_overlay_bitmap (local.get $bitmap))
    (global.set $gdi_menu_overlay_width (local.get $width))
    (global.set $gdi_menu_overlay_height (local.get $height))
    (if (i32.eqz (call $host_gdi_surface_attach (local.get $bitmap) (i32.const 0)))
      (then
        (drop (call $gdi_object_delete_full (local.get $bitmap)))
        (global.set $gdi_menu_overlay_bitmap (i32.const 0))
        (global.set $gdi_menu_overlay_width (i32.const 0))
        (global.set $gdi_menu_overlay_height (i32.const 0))
        (return (i32.const 0))))
    (local.get $dc))

  ;; Bind a host-allocated screen HDC to a persistent canonical bitmap.
  ;; Attach target -1 means the renderer's desktop base presentation.
  (func $gdi_screen_dc_bind (param $hdc i32) (result i32)
    (local $wh i32) (local $width i32) (local $height i32)
    (local $bitmap i32) (local $record i32) (local $bits i32)
    (local.set $wh (call $host_get_screen_size))
    (local.set $width (i32.and (local.get $wh) (i32.const 0xFFFF)))
    (local.set $height (i32.shr_u (local.get $wh) (i32.const 16)))
    (if (i32.or (i32.eqz (local.get $width)) (i32.eqz (local.get $height)))
      (then (return (i32.const 0))))
    (local.set $bitmap (global.get $gdi_screen_bitmap))
    (if (i32.and (i32.ne (local.get $bitmap) (i32.const 0))
          (i32.or (i32.ne (global.get $gdi_screen_width) (local.get $width))
            (i32.ne (global.get $gdi_screen_height) (local.get $height))))
      (then
        (drop (call $gdi_object_delete_full (local.get $bitmap)))
        (global.set $gdi_screen_bitmap (i32.const 0))))
    (local.set $bitmap (global.get $gdi_screen_bitmap))
    (if (i32.eqz (local.get $bitmap))
      (then
        (local.set $bitmap (call $gdi_create_compat_bitmap_internal
          (local.get $width) (local.get $height) (i32.const 0)))
        (if (i32.eqz (local.get $bitmap)) (then (return (i32.const 0))))
        (global.set $gdi_screen_bitmap (local.get $bitmap))
        (global.set $gdi_screen_width (local.get $width))
        (global.set $gdi_screen_height (local.get $height))
        ;; COLOR_DESKTOP defaults to RGB(0,128,128), stored as packed raster RGB.
        (local.set $record (call $gdi_object_record (local.get $bitmap)))
        (local.set $bits (i32.load offset=24 (local.get $record)))
        (memory.fill (local.get $bits) (i32.const 0) (i32.mul
          (i32.load offset=28 (local.get $record)) (local.get $height)))
        (local.set $record (i32.const 0))
        (block $fill_done (loop $fill
          (br_if $fill_done (i32.ge_u (local.get $record)
            (i32.mul (local.get $width) (local.get $height))))
          (i32.store (i32.add (local.get $bits) (i32.shl (local.get $record) (i32.const 2)))
            (i32.const 0x00008080))
          (local.set $record (i32.add (local.get $record) (i32.const 1)))
          (br $fill)))))
    (if (i32.eqz (call $gdi_dc_state_entry (local.get $hdc) (i32.const 1)))
      (then (return (i32.const 0))))
    (drop (call $gdi_dc_select_owned_object (local.get $hdc) (local.get $bitmap)))
    ;; Headless printer DCs have no renderer to attach to; canonical storage is
    ;; still valid and text can use its presentation cache.
    (drop (call $host_gdi_surface_attach (local.get $bitmap) (i32.const -1)))
    (drop (call $host_gdi_surface_upload (local.get $bitmap)
      (i32.const 0) (i32.const 0) (local.get $width) (local.get $height)))
    (i32.const 1))

  (func $gdi_screen_dc_alloc (result i32)
    (local $hdc i32)
    (local.set $hdc (call $gdi_dc_alloc))
    (if (i32.eqz (local.get $hdc)) (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_screen_dc_bind (local.get $hdc)))
      (then
        (drop (call $gdi_dc_delete (local.get $hdc)))
        (return (i32.const 0))))
    (local.get $hdc))

  (func $host_alloc_screen_dc (result i32)
    (call $gdi_screen_dc_alloc))

  (func $gdi_printer_page_clear (param $hdc i32) (result i32)
    (local $record i32) (local $bits i32) (local $bytes i32)
    (if (i32.or
          (i32.ne (local.get $hdc) (global.get $printer_hdc))
          (i32.eqz (global.get $printer_bitmap)))
      (then (return (i32.const 0))))
    (local.set $record (call $gdi_object_record (global.get $printer_bitmap)))
    (if (i32.or (i32.eqz (local.get $record))
          (i32.ne (i32.load offset=4 (local.get $record)) (i32.const 3)))
      (then (return (i32.const 0))))
    (local.set $bits (i32.load offset=24 (local.get $record)))
    (local.set $bytes (i32.mul
      (i32.load offset=28 (local.get $record))
      (i32.load offset=12 (local.get $record))))
    (if (i32.or (i32.eqz (local.get $bits)) (i32.eqz (local.get $bytes)))
      (then (return (i32.const 0))))
    (memory.fill (local.get $bits) (i32.const 0xFF) (local.get $bytes))
    (drop (call $host_gdi_surface_upload (global.get $printer_bitmap)
      (i32.const 0) (i32.const 0) (i32.const 2400) (i32.const 3150)))
    (i32.const 1))

  (func $gdi_printer_dc_release (param $hdc i32) (result i32)
    (local $bitmap i32) (local $released i32)
    (if (i32.or (i32.eqz (local.get $hdc))
          (i32.ne (local.get $hdc) (global.get $printer_hdc)))
      (then (return (i32.const 0))))
    (local.set $bitmap (global.get $printer_bitmap))
    (global.set $printer_hdc (i32.const 0))
    (global.set $printer_bitmap (i32.const 0))
    (global.set $printer_doc_state (i32.const 0))
    (local.set $released (call $gdi_dc_delete (local.get $hdc)))
    (if (local.get $bitmap)
      (then (drop (call $gdi_object_delete_full (local.get $bitmap)))))
    (local.get $released))

  (func $gdi_printer_dc_alloc (result i32)
    (local $bitmap i32) (local $hdc i32)
    (if (global.get $printer_hdc)
      (then (drop (call $gdi_printer_dc_release (global.get $printer_hdc)))))
    (local.set $bitmap (call $gdi_create_compat_bitmap_internal
      (i32.const 2400) (i32.const 3150) (i32.const 0)))
    (if (i32.eqz (local.get $bitmap)) (then (return (i32.const 0))))
    (local.set $hdc (call $gdi_dc_alloc))
    (if (i32.eqz (local.get $hdc))
      (then
        (drop (call $gdi_object_delete_full (local.get $bitmap)))
        (return (i32.const 0))))
    (if (i32.eq (call $gdi_dc_select_owned_object
          (local.get $hdc) (local.get $bitmap)) (i32.const -1))
      (then
        (drop (call $gdi_dc_delete (local.get $hdc)))
        (drop (call $gdi_object_delete_full (local.get $bitmap)))
        (return (i32.const 0))))
    (global.set $printer_hdc (local.get $hdc))
    (global.set $printer_bitmap (local.get $bitmap))
    (global.set $printer_doc_state (i32.const 0))
    (if (i32.eqz (call $gdi_printer_page_clear (local.get $hdc)))
      (then
        (drop (call $gdi_printer_dc_release (local.get $hdc)))
        (return (i32.const 0))))
    (local.get $hdc))

  (func $gdi_dc_bitmap_record (param $hdc i32) (result i32)
    (local $dc i32) (local $bmp i32)
    (local.set $dc (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
    (if (i32.eqz (local.get $dc)) (then (return (i32.const 0))))
    (local.set $bmp (call $gdi_object_record (i32.load offset=84 (local.get $dc))))
    (if (i32.and (i32.ne (local.get $bmp) (i32.const 0))
          (i32.eq (i32.load offset=4 (local.get $bmp)) (i32.const 3)))
      (then (return (local.get $bmp))))
    (i32.const 0))

  (func $gdi_dc_target_size (param $hdc i32) (result i32)
    (local $bmp i32) (local $dc i32) (local $binding i32) (local $hwnd i32)
    (local $size i32) (local $surface i32)
    (local.set $bmp (call $gdi_dc_bitmap_record (local.get $hdc)))
    (if (local.get $bmp)
      (then (return (i32.or (i32.and (i32.load offset=8 (local.get $bmp)) (i32.const 0xFFFF))
        (i32.shl (i32.and (i32.load offset=12 (local.get $bmp)) (i32.const 0xFFFF))
          (i32.const 16))))))
    (local.set $dc (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $dc)
      (then
        (local.set $binding (i32.load offset=92 (local.get $dc)))
        (local.set $hwnd (i32.and (local.get $binding) (i32.const 0x7FFFFFFF)))
        (if (local.get $hwnd)
          (then
            (if (i32.lt_s (local.get $binding) (i32.const 0))
              (then
                ;; Child whole-window DCs have CONTROL_GEOM dimensions.
                ;; Top-level windows do not, so use the canonical owner
                ;; surface that gdi_window_dc_bind already ensured. Without
                ;; this fallback their finite default clip is empty and all
                ;; WAT nonclient geometry is rejected while text still draws.
                (local.set $size (call $ctrl_get_wh_packed (local.get $hwnd)))
                (if (local.get $size) (then (return (local.get $size))))
                (local.set $surface (call $gdi_window_surface_record
                  (call $wnd_top_level (local.get $hwnd)) (i32.const 0)))
                (if (local.get $surface)
                  (then (return (i32.or
                    (i32.and (i32.load offset=8 (local.get $surface)) (i32.const 0xFFFF))
                    (i32.shl
                      (i32.and (i32.load offset=12 (local.get $surface)) (i32.const 0xFFFF))
                      (i32.const 16))))))
                (return (i32.const 0)))
              (else (return (i32.or
                (i32.and (call $wnd_client_w_for_clip (local.get $hwnd)) (i32.const 0xFFFF))
                (i32.shl (i32.and (call $wnd_client_h_for_clip (local.get $hwnd)) (i32.const 0xFFFF))
                  (i32.const 16))))))))))
    (i32.const 0))

  ;; Persistent canonical backing for the top-level window composition target.
  ;; Record: owner hwnd, surface id, width, height, bitsWa, stride, reserved.
  (func $gdi_window_surface_record (param $owner i32) (param $create i32) (result i32)
    (local $i i32) (local $p i32) (local $empty i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_WINDOW_SURFACE_COUNT)))
      (local.set $p (i32.add (global.get $GDI_WINDOW_SURFACE_TABLE)
        (i32.mul (local.get $i) (global.get $GDI_WINDOW_SURFACE_STRIDE))))
      (if (i32.eq (i32.load (local.get $p)) (local.get $owner))
        (then (return (local.get $p))))
      (if (i32.and (i32.eqz (local.get $empty)) (i32.eqz (i32.load (local.get $p))))
        (then (local.set $empty (local.get $p))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.and (i32.ne (local.get $create) (i32.const 0))
          (i32.ne (local.get $empty) (i32.const 0)))
      (then
        (i32.store (local.get $empty) (local.get $owner))
        (i32.store offset=4 (local.get $empty)
          (i32.add (i32.const 0x00610001)
            (i32.div_u (i32.sub (local.get $empty) (global.get $GDI_WINDOW_SURFACE_TABLE))
              (global.get $GDI_WINDOW_SURFACE_STRIDE))))
        (return (local.get $empty))))
    (i32.const 0))

  (func $gdi_window_surface_dimensions (param $owner i32) (result i32)
    (local $wh i32) (local $rect i32) (local $w i32) (local $h i32)
    (local.set $wh (call $ctrl_get_wh_packed (local.get $owner)))
    (local.set $w (i32.and (local.get $wh) (i32.const 0xFFFF)))
    (local.set $h (i32.shr_u (local.get $wh) (i32.const 16)))
    (if (i32.and (i32.gt_s (local.get $w) (i32.const 0))
          (i32.gt_s (local.get $h) (i32.const 0)))
      (then (return (local.get $wh))))
    (local.set $rect (global.get $WINDOW_RECT_SCRATCH))
    (call $host_get_window_rect (local.get $owner) (local.get $rect))
    (local.set $w (i32.sub (i32.load offset=8 (local.get $rect)) (i32.load (local.get $rect))))
    (local.set $h (i32.sub (i32.load offset=12 (local.get $rect)) (i32.load offset=4 (local.get $rect))))
    (if (i32.or (i32.le_s (local.get $w) (i32.const 0))
          (i32.le_s (local.get $h) (i32.const 0)))
      (then (return (i32.const 0))))
    (i32.or (i32.and (local.get $w) (i32.const 0xFFFF))
      (i32.shl (i32.and (local.get $h) (i32.const 0xFFFF)) (i32.const 16))))

  (func $gdi_window_surface_ensure (param $hwnd i32) (result i32)
    (local $owner i32) (local $p i32) (local $wh i32) (local $w i32) (local $h i32)
    (local $size64 i64) (local $bits_ga i32) (local $bits i32) (local $id i32)
    (local.set $owner (call $wnd_top_level (local.get $hwnd)))
    (if (i32.eqz (local.get $owner)) (then (local.set $owner (local.get $hwnd))))
    (if (i32.eqz (local.get $owner)) (then (return (i32.const 0))))
    (local.set $wh (call $gdi_window_surface_dimensions (local.get $owner)))
    (local.set $w (i32.and (local.get $wh) (i32.const 0xFFFF)))
    (local.set $h (i32.shr_u (local.get $wh) (i32.const 16)))
    (if (i32.or (i32.eqz (local.get $w)) (i32.eqz (local.get $h)))
      (then (return (i32.const 0))))
    (local.set $p (call $gdi_window_surface_record (local.get $owner) (i32.const 1)))
    (if (i32.eqz (local.get $p)) (then (return (i32.const 0))))
    (local.set $id (i32.load offset=4 (local.get $p)))
    (if (i32.and (i32.eq (i32.load offset=8 (local.get $p)) (local.get $w))
          (i32.eq (i32.load offset=12 (local.get $p)) (local.get $h)))
      (then
        (drop (call $host_gdi_surface_attach (local.get $id) (local.get $owner)))
        (return (local.get $p))))
    (if (i32.load offset=16 (local.get $p))
      (then
        (drop (call $host_gdi_surface_delete (local.get $id)))
        (call $dib_free_wasm (i32.load offset=16 (local.get $p)))))
    (local.set $size64 (i64.mul
      (i64.mul (i64.extend_i32_u (local.get $w)) (i64.extend_i32_u (local.get $h)))
      (i64.const 4)))
    (if (i64.gt_u (local.get $size64) (i64.extend_i32_u (global.get $DIB_BACKING_BASE_SIZE)))
      (then (return (i32.const 0))))
    (local.set $bits_ga (call $dib_alloc (i32.wrap_i64 (local.get $size64))))
    (if (i32.eqz (local.get $bits_ga)) (then (return (i32.const 0))))
    (local.set $bits (call $g2w (local.get $bits_ga)))
    (i32.store offset=8 (local.get $p) (local.get $w))
    (i32.store offset=12 (local.get $p) (local.get $h))
    (i32.store offset=16 (local.get $p) (local.get $bits))
    (i32.store offset=20 (local.get $p) (i32.mul (local.get $w) (i32.const 4)))
    (if (i32.eqz (call $host_gdi_surface_create
          (local.get $id) (local.get $w) (local.get $h) (i32.const 32)
          (local.get $bits) (i32.load offset=20 (local.get $p)) (i32.const 1)
          (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0) (i32.const 0)))
      (then
        (call $dib_free_wasm (local.get $bits))
        (i32.store offset=8 (local.get $p) (i32.const 0))
        (i32.store offset=12 (local.get $p) (i32.const 0))
        (i32.store offset=16 (local.get $p) (i32.const 0))
        (return (i32.const 0))))
    (if (i32.eqz (call $host_gdi_surface_attach (local.get $id) (local.get $owner)))
      (then
        (drop (call $host_gdi_surface_delete (local.get $id)))
        (call $dib_free_wasm (local.get $bits))
        (i32.store offset=8 (local.get $p) (i32.const 0))
        (i32.store offset=12 (local.get $p) (i32.const 0))
        (i32.store offset=16 (local.get $p) (i32.const 0))
        (return (i32.const 0))))
    (local.get $p))

  (func $gdi_window_surface_release (param $hwnd i32)
    (local $p i32)
    (local.set $p (call $gdi_window_surface_record (local.get $hwnd) (i32.const 0)))
    (if (local.get $p)
      (then
        (drop (call $host_gdi_surface_delete (i32.load offset=4 (local.get $p))))
        (if (i32.load offset=16 (local.get $p))
          (then (call $dib_free_wasm (i32.load offset=16 (local.get $p)))))
        (memory.fill (local.get $p) (i32.const 0) (global.get $GDI_WINDOW_SURFACE_STRIDE)))))

  (func $gdi_window_dc_bind (param $hdc i32) (param $hwnd i32) (param $whole i32) (result i32)
    (local $dc i32)
    (local.set $dc (call $gdi_dc_state_entry (local.get $hdc) (i32.const 1)))
    (if (i32.eqz (local.get $dc)) (then (return (i32.const 0))))
    (i32.store offset=92 (local.get $dc)
      (i32.or (i32.and (local.get $hwnd) (i32.const 0x7FFFFFFF))
        (select (i32.const 0x80000000) (i32.const 0)
          (i32.ne (local.get $whole) (i32.const 0)))))
    (i32.ne (call $gdi_window_surface_ensure (local.get $hwnd)) (i32.const 0)))

  ;; DirectDraw HDCs address native DX_OBJECTS pixel storage directly. The
  ;; host surface registered here is only a Canvas text/presentation cache.
  (func $gdi_dx_surface_entry (param $hdc i32) (result i32)
    (local $slot i32) (local $entry i32)
    (if (i32.or (i32.lt_u (local.get $hdc) (i32.const 0x00200000))
          (i32.ge_u (local.get $hdc) (i32.const 0x00300000)))
      (then (return (i32.const 0))))
    (local.set $slot (i32.sub (local.get $hdc) (i32.const 0x00200000)))
    (if (i32.ge_u (local.get $slot) (global.get $DX_MAX))
      (then (return (i32.const 0))))
    (local.set $entry (i32.add (global.get $DX_OBJECTS)
      (i32.mul (local.get $slot) (global.get $DX_ENTRY_SIZE))))
    (if (i32.ne (i32.load (local.get $entry)) (i32.const 2))
      (then (return (i32.const 0))))
    (local.get $entry))

  (func $gdi_dx_dc_bind (param $hdc i32) (result i32)
    (local $entry i32) (local $bpp i32) (local $palette i32) (local $count i32)
    (local.set $entry (call $gdi_dx_surface_entry (local.get $hdc)))
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_dc_state_entry (local.get $hdc) (i32.const 1)))
      (then (return (i32.const 0))))
    (local.set $bpp (i32.load16_u offset=16 (local.get $entry)))
    (if (i32.le_u (local.get $bpp) (i32.const 8))
      (then
        (local.set $palette (global.get $dx_primary_pal_wa))
        (if (local.get $palette) (then (local.set $count (i32.const 256))))))
    (call $host_gdi_surface_create
      (local.get $hdc)
      (i32.load16_u offset=12 (local.get $entry))
      (i32.load16_u offset=14 (local.get $entry))
      (local.get $bpp)
      (i32.load offset=20 (local.get $entry))
      (i32.load16_u offset=18 (local.get $entry))
      (i32.const 1) (local.get $palette) (local.get $count)
      (select (i32.const 0xF800) (i32.const 0)
        (i32.eq (local.get $bpp) (i32.const 16)))
      (select (i32.const 0x07E0) (i32.const 0)
        (i32.eq (local.get $bpp) (i32.const 16)))
      (select (i32.const 0x001F) (i32.const 0)
        (i32.eq (local.get $bpp) (i32.const 16)))))

  (func $gdi_dx_dc_release (param $hdc i32)
    (call $gdi_dc_clip_release (local.get $hdc))
    (call $gdi_dc_state_release (local.get $hdc))
    (drop (call $host_gdi_surface_delete (local.get $hdc))))

  (func $host_alloc_window_dc (param $hwnd i32) (param $whole i32) (result i32)
    (local $hdc i32)
    (local.set $hdc (call $gdi_dc_alloc))
    (if (local.get $hdc)
      (then
        (if (i32.eqz (call $gdi_window_dc_bind
              (local.get $hdc) (local.get $hwnd) (local.get $whole)))
          (then
            (drop (call $gdi_dc_delete (local.get $hdc)))
            (local.set $hdc (i32.const 0))))))
    (local.get $hdc))

  (func $host_release_dc (param $hdc i32) (result i32)
    (call $gdi_dc_aux_release (local.get $hdc))
    (call $gdi_dc_clip_release (local.get $hdc))
    (call $gdi_dc_state_release (local.get $hdc))
    (i32.const 1))

  ;; Canvas remains the text rasterizer. WAT supplies an opaque presentation
  ;; token plus its canonical DC record; JS never creates a semantic DC mirror.
  (func $gdi_text_prepare (param $hdc i32) (result i32)
    (local $dc i32) (local $desc i32) (local $token i32)
    (local $origin_x i32) (local $origin_y i32) (local $aux i32)
    (local $clip_entry i32) (local $clip_record i32) (local $system_clip i32)
    (local $effective i32) (local $clip_bands i32) (local $clip_count i32)
    (local $bound i32)
    (local.set $dc (call $gdi_dc_state_entry (local.get $hdc) (i32.const 1)))
    (if (i32.eqz (local.get $dc)) (then (return (i32.const 0))))
    (local.set $token (local.get $hdc))
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc))
      (then
        (local.set $token (i32.load offset=68 (local.get $desc)))
        (local.set $origin_x (i32.load offset=72 (local.get $desc)))
        (local.set $origin_y (i32.load offset=76 (local.get $desc)))))
    (local.set $aux (call $gdi_dc_aux_entry (local.get $hdc) (i32.const 1)))
    (local.set $clip_entry (call $gdi_dc_clip_entry (local.get $hdc) (i32.const 0)))
    (local.set $system_clip (call $gdi_dc_system_clip_handle (local.get $hdc)))
    (if (i32.or
          (i32.and (i32.ne (local.get $clip_entry) (i32.const 0))
            (i32.ne (i32.load offset=4 (local.get $clip_entry)) (i32.const 0)))
          (i32.ne (local.get $system_clip) (i32.const 0)))
      (then
        (local.set $effective (call $gdi_dc_effective_clip_region (local.get $hdc)))
        (local.set $clip_record (call $gdi_rgn_record (local.get $effective)))
        (if (local.get $clip_record)
          (then
            (local.set $clip_bands (call $gdi_rgn_bands (local.get $clip_record)))
            (local.set $clip_count (i32.load offset=28 (local.get $clip_record)))))))
    (local.set $bound (call $host_gdi_text_bind_raw
      (local.get $token) (local.get $dc) (local.get $origin_x) (local.get $origin_y)
      (local.get $aux) (local.get $clip_bands) (local.get $clip_count)))
    (if (local.get $effective) (then (drop (call $gdi_rgn_delete (local.get $effective)))))
    (if (i32.eqz (local.get $bound))
      (then (return (i32.const 0))))
    (local.get $token))

  (func $host_gdi_set_text_color (param $hdc i32) (param $color i32) (result i32)
    (call $gdi_dc_set_field (local.get $hdc) (i32.const 20)
      (i32.and (local.get $color) (i32.const 0xFFFFFF)) (i32.const 0)))
  (func $host_gdi_get_text_color (param $hdc i32) (result i32)
    (call $gdi_dc_get_field (local.get $hdc) (i32.const 20) (i32.const 0)))
  (func $host_gdi_set_bk_color (param $hdc i32) (param $color i32) (result i32)
    (call $gdi_dc_set_field (local.get $hdc) (i32.const 24)
      (i32.and (local.get $color) (i32.const 0xFFFFFF)) (i32.const 0xFFFFFF)))
  (func $host_gdi_get_bk_color (param $hdc i32) (result i32)
    (call $gdi_dc_get_field (local.get $hdc) (i32.const 24) (i32.const 0xFFFFFF)))
  (func $host_gdi_set_bk_mode (param $hdc i32) (param $mode i32) (result i32)
    (if (i32.or (i32.eq (local.get $mode) (i32.const 1))
          (i32.eq (local.get $mode) (i32.const 2)))
      (then (return (call $gdi_dc_set_field (local.get $hdc) (i32.const 28)
        (local.get $mode) (i32.const 2)))))
    (i32.const 0))
  (func $host_gdi_get_bk_mode (param $hdc i32) (result i32)
    (call $gdi_dc_get_field (local.get $hdc) (i32.const 28) (i32.const 2)))
  (func $host_gdi_set_text_align (param $hdc i32) (param $align i32) (result i32)
    (call $gdi_dc_set_field (local.get $hdc) (i32.const 32) (local.get $align) (i32.const 0)))
  (func $host_gdi_get_text_align (param $hdc i32) (result i32)
    (call $gdi_dc_get_field (local.get $hdc) (i32.const 32) (i32.const 0)))

  (func $host_gdi_text_out (param $hdc i32) (param $x i32) (param $y i32)
        (param $text i32) (param $count i32) (param $wide i32) (result i32)
    (local $token i32) (local $bitmap_result i32)
    (local.set $bitmap_result (call $gdi_bitmap_text_out
      (local.get $hdc) (local.get $x) (local.get $y) (i32.const 0) (i32.const 0)
      (local.get $text) (local.get $count) (i32.const 0) (local.get $wide)))
    (if (i32.ge_s (local.get $bitmap_result) (i32.const 0))
      (then (return (local.get $bitmap_result))))
    (local.set $token (call $gdi_text_prepare (local.get $hdc)))
    (if (i32.eqz (local.get $token)) (then (return (i32.const 0))))
    (call $host_gdi_text_out_raw (local.get $token) (local.get $x) (local.get $y)
      (local.get $text) (local.get $count) (local.get $wide)))

  (func $host_measure_text (param $hdc i32) (param $text i32)
        (param $count i32) (param $wide i32) (result i32)
    (local $token i32) (local $bitmap_result i32)
    (if (i32.le_s (local.get $count) (i32.const 0))
      (then (return (i32.const 0))))
    (local.set $bitmap_result (call $gdi_bitmap_text_measure
      (local.get $hdc) (local.get $text) (local.get $count) (local.get $wide)))
    (if (i32.ge_s (local.get $bitmap_result) (i32.const 0))
      (then (return (local.get $bitmap_result))))
    (local.set $token (call $gdi_text_prepare (local.get $hdc)))
    (if (i32.eqz (local.get $token)) (then (return (i32.const 0))))
    (call $host_measure_text_raw (local.get $token) (local.get $text)
      (local.get $count) (local.get $wide)))

  (func $host_get_text_metrics (param $hdc i32) (result i32)
    (local $token i32) (local $bitmap_result i32)
    (local.set $bitmap_result (call $gdi_bitmap_text_metrics (local.get $hdc)))
    (if (i32.ge_s (local.get $bitmap_result) (i32.const 0))
      (then (return (local.get $bitmap_result))))
    (local.set $token (call $gdi_text_prepare (local.get $hdc)))
    (if (i32.eqz (local.get $token)) (then (return (i32.const 0))))
    (call $host_get_text_metrics_raw (local.get $token)))

  ;; Canvas supplies only glyph measurement. Prefix fitting and Win32 output
  ;; structures remain WAT-owned so ANSI and UTF-16 calls share exact state.
  (func $gdi_text_extent_ex (param $hdc i32) (param $text i32)
        (param $count i32) (param $max_extent i32) (param $fit i32)
        (param $dx i32) (param $size i32) (param $wide i32) (result i32)
    (local $metrics i32) (local $height i32) (local $i i32)
    (local $width i32) (local $fit_count i32)
    (if (i32.or (i32.eqz (local.get $size))
          (i32.or (i32.lt_s (local.get $count) (i32.const 0))
            (i32.or (i32.gt_u (local.get $count) (i32.const 65536))
              (i32.and (i32.gt_s (local.get $count) (i32.const 0))
                (i32.eqz (local.get $text))))))
      (then (return (i32.const 0))))
    (local.set $metrics (call $host_get_text_metrics (local.get $hdc)))
    (if (i32.eqz (local.get $metrics)) (then (return (i32.const 0))))
    (local.set $height (i32.and (local.get $metrics) (i32.const 0xFFFF)))
    (block $done (loop $prefix
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $width (call $host_measure_text (local.get $hdc)
        (local.get $text) (local.get $i) (local.get $wide)))
      (if (local.get $dx)
        (then (i32.store (i32.add (local.get $dx)
          (i32.shl (i32.sub (local.get $i) (i32.const 1)) (i32.const 2)))
          (local.get $width))))
      (if (i32.le_s (local.get $width) (local.get $max_extent))
        (then (local.set $fit_count (local.get $i))))
      (br $prefix)))
    (if (local.get $fit) (then (i32.store (local.get $fit) (local.get $fit_count))))
    (i32.store (local.get $size) (local.get $width))
    (i32.store offset=4 (local.get $size) (local.get $height))
    (i32.const 1))

  (func $gdi_char_abc_widths_a (param $hdc i32) (param $first i32)
        (param $last i32) (param $out i32) (result i32)
    (local $ch i32) (local $index i32) (local $width i32) (local $entry i32)
    (if (i32.or (i32.eqz (local.get $out))
          (i32.or (i32.gt_u (local.get $first) (local.get $last))
            (i32.gt_u (i32.sub (local.get $last) (local.get $first)) (i32.const 255))))
      (then (return (i32.const 0))))
    (local.set $ch (local.get $first))
    (block $done (loop $characters
      (br_if $done (i32.gt_u (local.get $ch) (local.get $last)))
      (i32.store8 (global.get $TEXT_SCRATCH) (local.get $ch))
      (i32.store8 offset=1 (global.get $TEXT_SCRATCH) (i32.const 0))
      (local.set $width (call $host_measure_text (local.get $hdc)
        (global.get $TEXT_SCRATCH) (i32.const 1) (i32.const 0)))
      (local.set $entry (i32.add (local.get $out)
        (i32.mul (local.get $index) (i32.const 12))))
      (i32.store (local.get $entry) (i32.const 0))
      (i32.store offset=4 (local.get $entry) (local.get $width))
      (i32.store offset=8 (local.get $entry) (i32.const 0))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (local.set $ch (i32.add (local.get $ch) (i32.const 1)))
      (br $characters)))
    (i32.const 1))

  (func $gdi_glyph_metrics_a (param $hdc i32) (param $character i32)
        (param $format i32) (param $metrics_out i32) (result i32)
    (local $packed i32) (local $height i32) (local $width i32)
    (if (i32.or (i32.ne (local.get $format) (i32.const 0))
          (i32.eqz (local.get $metrics_out)))
      (then (return (i32.const -1))))
    (i32.store8 (global.get $TEXT_SCRATCH) (local.get $character))
    (i32.store8 offset=1 (global.get $TEXT_SCRATCH) (i32.const 0))
    (local.set $width (call $host_measure_text (local.get $hdc)
      (global.get $TEXT_SCRATCH) (i32.const 1) (i32.const 0)))
    (local.set $packed (call $host_get_text_metrics (local.get $hdc)))
    (if (i32.eqz (local.get $packed)) (then (return (i32.const -1))))
    (local.set $height (i32.and (local.get $packed) (i32.const 0xFFFF)))
    (i32.store (local.get $metrics_out) (local.get $width))
    (i32.store offset=4 (local.get $metrics_out) (local.get $height))
    (i32.store offset=8 (local.get $metrics_out) (i32.const 0))
    (i32.store offset=12 (local.get $metrics_out) (local.get $height))
    (i32.store16 offset=16 (local.get $metrics_out) (local.get $width))
    (i32.store16 offset=18 (local.get $metrics_out) (i32.const 0))
    (i32.const 0))

  ;; Measure and optionally draw a tabbed string. WAT owns character parsing,
  ;; explicit/default tab-stop selection and packed SIZE construction; Canvas
  ;; only measures/rasterizes individual non-tab text runs.
  (func $gdi_tabbed_text (param $hdc i32) (param $x i32) (param $y i32)
        (param $text_g i32) (param $count i32) (param $tab_count i32)
        (param $stops_g i32) (param $origin i32) (param $wide i32)
        (param $draw i32) (result i32)
    (local $text i32) (local $stops i32) (local $metrics i32)
    (local $height i32) (local $average i32) (local $default_tab i32)
    (local $i i32) (local $run_start i32) (local $run_count i32)
    (local $cursor i32) (local $run_width i32) (local $ch i32)
    (local $tab_i i32) (local $next i32) (local $relative i32)
    (local $align i32)
    (if (i32.or (i32.lt_s (local.get $count) (i32.const 0))
          (i32.or (i32.lt_s (local.get $tab_count) (i32.const 0))
            (i32.and (i32.gt_s (local.get $count) (i32.const 0))
              (i32.eqz (local.get $text_g)))))
      (then (return (i32.const 0))))
    (if (i32.and (i32.gt_s (local.get $tab_count) (i32.const 0))
          (i32.eqz (local.get $stops_g)))
      (then (return (i32.const 0))))
    (if (local.get $text_g) (then (local.set $text (call $g2w (local.get $text_g)))))
    (if (local.get $stops_g) (then (local.set $stops (call $g2w (local.get $stops_g)))))
    (local.set $metrics (call $host_get_text_metrics (local.get $hdc)))
    (local.set $height (i32.and (local.get $metrics) (i32.const 0xFFFF)))
    (local.set $average (i32.shr_u (local.get $metrics) (i32.const 16)))
    (if (i32.eqz (local.get $height)) (then (local.set $height (i32.const 13))))
    (if (i32.eqz (local.get $average)) (then (local.set $average (i32.const 8))))
    (local.set $default_tab (i32.mul (local.get $average) (i32.const 8)))
    (local.set $align (call $gdi_dc_get_field
      (local.get $hdc) (i32.const 32) (i32.const 0)))
    (if (i32.and (local.get $draw) (i32.and (local.get $align) (i32.const 1)))
      (then
        (local.set $x (call $gdi_dc_get_field
          (local.get $hdc) (i32.const 12) (i32.const 0)))
        (local.set $y (call $gdi_dc_get_field
          (local.get $hdc) (i32.const 16) (i32.const 0)))))
    (local.set $cursor (local.get $x))
    (local.set $run_start (i32.const 0))
    (block $done (loop $scan
      (if (i32.lt_s (local.get $i) (local.get $count))
        (then
          (local.set $ch
            (if (result i32) (local.get $wide)
              (then (i32.load16_u (i32.add (local.get $text)
                (i32.shl (local.get $i) (i32.const 1)))))
              (else (i32.load8_u (i32.add (local.get $text) (local.get $i))))))
          (if (i32.ne (local.get $ch) (i32.const 9))
            (then
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $scan)))))
      (local.set $run_count (i32.sub (local.get $i) (local.get $run_start)))
      (if (i32.gt_s (local.get $run_count) (i32.const 0))
        (then
          (local.set $run_width (call $host_measure_text
            (local.get $hdc)
            (i32.add (local.get $text)
              (select (i32.shl (local.get $run_start) (i32.const 1))
                (local.get $run_start) (local.get $wide)))
            (local.get $run_count) (local.get $wide)))
          (if (local.get $draw)
            (then (drop (call $host_gdi_text_out
              (local.get $hdc) (local.get $cursor) (local.get $y)
              (i32.add (local.get $text)
                (select (i32.shl (local.get $run_start) (i32.const 1))
                  (local.get $run_start) (local.get $wide)))
              (local.get $run_count) (local.get $wide)))))
          (local.set $cursor (i32.add (local.get $cursor) (local.get $run_width)))))
      (br_if $done (i32.ge_s (local.get $i) (local.get $count)))
      ;; A tab advances to the first explicit stop strictly right of the
      ;; current position. Without usable explicit stops, repeat the Win32
      ;; default interval of eight average character cells from tab origin.
      (local.set $relative (i32.sub (local.get $cursor) (local.get $origin)))
      (local.set $next (i32.const 0x7FFFFFFF))
      (if (i32.eq (local.get $tab_count) (i32.const 1))
        (then
          (local.set $ch (i32.load (local.get $stops)))
          (if (i32.gt_s (local.get $ch) (i32.const 0))
            (then (local.set $next (i32.mul
              (i32.add (i32.div_s (select (local.get $relative) (i32.const 0)
                  (i32.gt_s (local.get $relative) (i32.const 0)))
                (local.get $ch)) (i32.const 1))
              (local.get $ch))))))
        (else
          (local.set $tab_i (i32.const 0))
          (block $stops_done (loop $stops_loop
            (br_if $stops_done (i32.ge_s (local.get $tab_i) (local.get $tab_count)))
            (local.set $ch (i32.load (i32.add (local.get $stops)
              (i32.shl (local.get $tab_i) (i32.const 2)))))
            (if (i32.and (i32.gt_s (local.get $ch) (local.get $relative))
                  (i32.lt_s (local.get $ch) (local.get $next)))
              (then (local.set $next (local.get $ch))))
            (local.set $tab_i (i32.add (local.get $tab_i) (i32.const 1)))
            (br $stops_loop)))))
      (if (i32.eq (local.get $next) (i32.const 0x7FFFFFFF))
        (then
          (local.set $next (i32.mul
            (i32.add (i32.div_s (select (local.get $relative) (i32.const 0)
                (i32.gt_s (local.get $relative) (i32.const 0)))
              (local.get $default_tab)) (i32.const 1))
            (local.get $default_tab)))))
      (local.set $cursor (i32.add (local.get $origin) (local.get $next)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $run_start (local.get $i))
      (br $scan)))
    (if (i32.and (local.get $draw) (i32.and (local.get $align) (i32.const 1)))
      (then
        (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 12)
          (local.get $cursor) (i32.const 0)))
        (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 16)
          (local.get $y) (i32.const 0)))))
    (i32.or (i32.and (i32.sub (local.get $cursor) (local.get $x)) (i32.const 0xFFFF))
      (i32.shl (i32.and (local.get $height) (i32.const 0xFFFF)) (i32.const 16))))
  (func $host_gdi_ext_text_out (param $hdc i32) (param $x i32) (param $y i32)
        (param $options i32) (param $rect i32) (param $text i32) (param $count i32)
        (param $dx_array i32) (param $wide i32) (result i32)
    (local $token i32) (local $bitmap_result i32)
    (local.set $bitmap_result (call $gdi_bitmap_text_out
      (local.get $hdc) (local.get $x) (local.get $y)
      (local.get $options) (local.get $rect) (local.get $text)
      (local.get $count) (local.get $dx_array) (local.get $wide)))
    (if (i32.ge_s (local.get $bitmap_result) (i32.const 0))
      (then (return (local.get $bitmap_result))))
    (local.set $token (call $gdi_text_prepare (local.get $hdc)))
    (if (i32.eqz (local.get $token)) (then (return (i32.const 0))))
    (call $host_gdi_ext_text_out_raw (local.get $token) (local.get $x) (local.get $y)
      (local.get $options) (local.get $rect) (local.get $text) (local.get $count) (local.get $wide)))
  (func $host_gdi_draw_text (param $hdc i32) (param $text i32) (param $count i32)
        (param $rect i32) (param $format i32) (param $wide i32) (result i32)
    (local $token i32) (local $bitmap_result i32)
    (local.set $bitmap_result (call $gdi_bitmap_draw_text
      (local.get $hdc) (local.get $text) (local.get $count)
      (local.get $rect) (local.get $format) (local.get $wide)))
    (if (i32.ge_s (local.get $bitmap_result) (i32.const 0))
      (then (return (local.get $bitmap_result))))
    (local.set $token (call $gdi_text_prepare (local.get $hdc)))
    (if (i32.eqz (local.get $token)) (then (return (i32.const 0))))
    (call $host_gdi_draw_text_raw (local.get $token) (local.get $text) (local.get $count)
      (local.get $rect) (local.get $format) (local.get $wide)))

  (func $gdi_surface_descriptor (param $hdc i32) (param $desc i32) (result i32)
    (local $dc i32) (local $bmp i32) (local $surface i32) (local $pen i32) (local $pen_handle i32)
    (local $pen_width i32) (local $pen_color i32) (local $pen_style i32)
    (local $wide i32) (local $binding i32) (local $hwnd i32) (local $owner i32)
    (local $bits i32) (local $width i32) (local $height i32) (local $stride i32) (local $dx i32)
    (local $bpp i32) (local $top_down i32) (local $surface_id i32)
    (local $origin_x i32) (local $origin_y i32)
    (local.set $dc (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
    (if (i32.eqz (local.get $dc)) (then (return (i32.const 0))))
    (local.set $dx (call $gdi_dx_surface_entry (local.get $hdc)))
    (local.set $bmp (call $gdi_dc_bitmap_record (local.get $hdc)))
    (if (local.get $dx)
      (then
        (local.set $bits (i32.load offset=20 (local.get $dx)))
        (local.set $width (i32.load16_u offset=12 (local.get $dx)))
        (local.set $height (i32.load16_u offset=14 (local.get $dx)))
        (local.set $stride (i32.load16_u offset=18 (local.get $dx)))
        (local.set $bpp (i32.load16_u offset=16 (local.get $dx)))
        (local.set $top_down (i32.const 1))
        (local.set $surface_id (local.get $hdc)))
      (else
        (if (local.get $bmp)
          (then
            (local.set $bits (i32.load offset=24 (local.get $bmp)))
            (local.set $width (i32.load offset=8 (local.get $bmp)))
            (local.set $height (i32.load offset=12 (local.get $bmp)))
            (local.set $stride (i32.load offset=28 (local.get $bmp)))
            (local.set $bpp (i32.load offset=16 (local.get $bmp)))
            (local.set $top_down
              (i32.and (i32.shr_u (i32.load offset=20 (local.get $bmp)) (i32.const 1)) (i32.const 1)))
            (local.set $surface_id (i32.load offset=40 (local.get $bmp))))
          (else
            (local.set $binding (i32.load offset=92 (local.get $dc)))
            (local.set $hwnd (i32.and (local.get $binding) (i32.const 0x7FFFFFFF)))
            (if (i32.eqz (local.get $hwnd)) (then (return (i32.const 0))))
            (local.set $surface (call $gdi_window_surface_ensure (local.get $hwnd)))
            (if (i32.eqz (local.get $surface)) (then (return (i32.const 0))))
            (local.set $owner (i32.load (local.get $surface)))
            (local.set $bits (i32.load offset=16 (local.get $surface)))
            (local.set $width (i32.load offset=8 (local.get $surface)))
            (local.set $height (i32.load offset=12 (local.get $surface)))
            (local.set $stride (i32.load offset=20 (local.get $surface)))
            (local.set $bpp (i32.const 32))
            (local.set $top_down (i32.const 1))
            (local.set $surface_id (i32.load offset=4 (local.get $surface)))
            (if (i32.lt_s (local.get $binding) (i32.const 0))
              (then
                (local.set $origin_x (i32.sub
                  (call $wnd_window_screen_x (local.get $hwnd))
                  (call $wnd_window_screen_x (local.get $owner))))
                (local.set $origin_y (i32.sub
                  (call $wnd_window_screen_y (local.get $hwnd))
                  (call $wnd_window_screen_y (local.get $owner)))))
              (else
                (local.set $origin_x (i32.sub
                  (call $wnd_client_screen_x (local.get $hwnd))
                  (call $wnd_window_screen_x (local.get $owner))))
                (local.set $origin_y (i32.sub
                  (call $wnd_client_screen_y (local.get $hwnd))
                  (call $wnd_window_screen_y (local.get $owner))))))))))
    (local.set $pen_handle (i32.load offset=4 (local.get $dc)))
    (if (i32.eq (local.get $pen_handle) (i32.const 0x30018))
      (then (local.set $pen_style (i32.const 5))))
    (local.set $pen (call $gdi_object_record (local.get $pen_handle)))
    (local.set $pen_width (i32.const 1))
    (if (local.get $pen)
      (then
        (local.set $pen_style (i32.load offset=8 (local.get $pen)))
        (local.set $pen_width (i32.load offset=12 (local.get $pen)))
        (local.set $pen_color (i32.load offset=16 (local.get $pen)))
        (if (i32.ne (i32.and (i32.load offset=20 (local.get $pen)) (i32.const 1)) (i32.const 0))
          (then (local.set $pen_style (i32.const 5))))))
    (if (i32.eqz (local.get $pen_width))
      (then (local.set $pen_width (i32.const 1))))
    (local.set $wide (i32.gt_s (local.get $pen_width) (i32.const 1)))
    (i32.store (local.get $desc) (local.get $bits))
    (i32.store offset=4 (local.get $desc) (local.get $width))
    (i32.store offset=8 (local.get $desc) (local.get $height))
    (i32.store offset=12 (local.get $desc) (local.get $stride))
    (i32.store offset=16 (local.get $desc) (local.get $bpp))
    (i32.store offset=20 (local.get $desc) (local.get $top_down))
    (i32.store offset=24 (local.get $desc) (local.get $pen_color))
    (i32.store offset=28 (local.get $desc) (local.get $pen_width))
    (i32.store offset=32 (local.get $desc) (i32.load offset=40 (local.get $dc)))
    (i32.store offset=36 (local.get $desc) (i32.load offset=44 (local.get $dc)))
    (i32.store offset=40 (local.get $desc) (i32.load offset=48 (local.get $dc)))
    (i32.store offset=44 (local.get $desc) (i32.load offset=52 (local.get $dc)))
    (i32.store offset=48 (local.get $desc) (i32.load offset=56 (local.get $dc)))
    (i32.store offset=52 (local.get $desc) (i32.load offset=60 (local.get $dc)))
    (i32.store offset=56 (local.get $desc) (i32.load offset=64 (local.get $dc)))
    (i32.store offset=60 (local.get $desc) (i32.load offset=68 (local.get $dc)))
    ;; Win98 geometric pens normalize the basic dash styles to a solid wide
    ;; footprint. Thin cosmetic pens retain their style for WAT dash stepping.
    (i32.store offset=64 (local.get $desc)
      (select (i32.const 0) (local.get $pen_style) (local.get $wide)))
    (i32.store offset=68 (local.get $desc) (local.get $surface_id))
    (i32.store offset=72 (local.get $desc) (local.get $origin_x))
    (i32.store offset=76 (local.get $desc) (local.get $origin_y))
    (i32.const 1))

  (func $gdi_line_descriptor_supported (param $desc i32) (result i32)
    (local $style i32) (local $width i32) (local $unit_mapping i32)
    (if (i32.and (i32.ne (i32.load offset=16 (local.get $desc)) (i32.const 16))
          (i32.and
            (i32.ne (i32.load offset=16 (local.get $desc)) (i32.const 24))
            (i32.ne (i32.load offset=16 (local.get $desc)) (i32.const 32))))
      (then (return (i32.const 0))))
    (local.set $style (i32.load offset=64 (local.get $desc)))
    (local.set $width (i32.load offset=28 (local.get $desc)))
    (if (i32.or
          (i32.or (i32.eq (local.get $style) (i32.const 5))
            (i32.and (i32.or (i32.lt_s (local.get $style) (i32.const 0))
              (i32.gt_s (local.get $style) (i32.const 4)))
              (i32.ne (local.get $style) (i32.const 6))))
          (i32.or (i32.lt_s (local.get $width) (i32.const 1))
            (i32.gt_s (local.get $width) (i32.const 64))))
      (then (return (i32.const 0))))
    (local.set $unit_mapping
      (i32.and
        (i32.or
          (i32.eq (i32.load offset=40 (local.get $desc)) (i32.load offset=56 (local.get $desc)))
          (i32.eq (i32.load offset=40 (local.get $desc))
            (i32.sub (i32.const 0) (i32.load offset=56 (local.get $desc)))))
        (i32.or
          (i32.eq (i32.load offset=44 (local.get $desc)) (i32.load offset=60 (local.get $desc)))
          (i32.eq (i32.load offset=44 (local.get $desc))
            (i32.sub (i32.const 0) (i32.load offset=60 (local.get $desc)))))))
    (if (i32.and (i32.gt_s (local.get $width) (i32.const 1))
          (i32.eqz (local.get $unit_mapping)))
      (then (return (i32.const 0))))
    (i32.const 1))

  (func $gdi_dc_state_release (param $hdc i32)
    (local $entry i32) (local $color i32)
    (local.set $entry (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $entry)
      (then
        (local.set $color (i32.add (global.get $GDI_COLOR_ADJUST_TABLE)
          (i32.div_u (i32.mul
            (i32.sub (local.get $entry) (global.get $GDI_DC_STATE_TABLE)) (i32.const 24))
            (global.get $GDI_DC_STATE_STRIDE))))
        (memory.fill (local.get $color) (i32.const 0) (i32.const 24))))
    (if (local.get $entry)
      (then (memory.fill (local.get $entry) (i32.const 0) (global.get $GDI_DC_STATE_STRIDE))))
    (call $gdi_dc_aux_release (local.get $hdc))
    (call $gdi_dc_path_release (local.get $hdc))
    (call $gdi_dc_meta_release (local.get $hdc)))

  ;; ---- WAT software line rasterization --------------------------------
  ;; ROP2 is part of the canonical DC record. Descriptor fields are
  ;; documented at the host import.

  (func $gdi_dc_get_rop2 (param $hdc i32) (result i32)
    (call $gdi_dc_get_field (local.get $hdc) (i32.const 72) (i32.const 13)))

  (func $gdi_dc_set_rop2 (param $hdc i32) (param $rop2 i32) (result i32)
    (local $entry i32) (local $old i32)
    (if (i32.or (i32.lt_u (local.get $rop2) (i32.const 1))
          (i32.gt_u (local.get $rop2) (i32.const 16)))
      (then (return (i32.const 0))))
    (local.set $entry (call $gdi_dc_state_entry (local.get $hdc) (i32.const 1)))
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (local.set $old (i32.load offset=72 (local.get $entry)))
    (i32.store offset=72 (local.get $entry) (local.get $rop2))
    (local.get $old))

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

  ;; floor(n / d), with d positive. WebAssembly signed division truncates, so
  ;; negative nonmultiples require one additional decrement.
  (func $gdi_floor_div_i64 (param $n i64) (param $d i64) (result i64)
    (local $q i64) (local $r i64)
    (local.set $q (i64.div_s (local.get $n) (local.get $d)))
    (local.set $r (i64.rem_s (local.get $n) (local.get $d)))
    (if (i32.and (i64.lt_s (local.get $n) (i64.const 0))
          (i64.ne (local.get $r) (i64.const 0)))
      (then (local.set $q (i64.sub (local.get $q) (i64.const 1)))))
    (local.get $q))

  ;; Match Math.round(numerator / denominator): ties move toward +infinity.
  (func $gdi_round_ratio (param $numerator i64) (param $denominator i64) (result i32)
    (if (i64.lt_s (local.get $denominator) (i64.const 0))
      (then
        (local.set $numerator (i64.sub (i64.const 0) (local.get $numerator)))
        (local.set $denominator (i64.sub (i64.const 0) (local.get $denominator)))))
    (i32.wrap_i64 (call $gdi_floor_div_i64
      (i64.add (i64.shl (local.get $numerator) (i64.const 1)) (local.get $denominator))
      (i64.shl (local.get $denominator) (i64.const 1)))))

  ;; Map one coordinate between logical/device spaces with Win32-style signed
  ;; rounding. Callers validate the non-zero source extent.
  (func $gdi_map_coordinate (param $value i32) (param $source_origin i32)
        (param $source_extent i32) (param $dest_origin i32) (param $dest_extent i32)
        (result i32)
    (i32.add (local.get $dest_origin)
      (call $gdi_round_ratio
        (i64.mul
          (i64.extend_i32_s (i32.sub (local.get $value) (local.get $source_origin)))
          (i64.extend_i32_s (local.get $dest_extent)))
        (i64.extend_i32_s (local.get $source_extent)))))

  (func (export "test_gdi_map_coordinate") (param i32) (param i32) (param i32)
        (param i32) (param i32) (result i32)
    (call $gdi_map_coordinate
      (local.get 0) (local.get 1) (local.get 2) (local.get 3) (local.get 4)))

  (func $gdi_line_map_x (param $desc i32) (param $x i32) (result i32)
    (i32.add (i32.load offset=72 (local.get $desc))
      (i32.add (i32.load offset=48 (local.get $desc))
        (call $gdi_round_ratio
          (i64.mul
            (i64.extend_i32_s (i32.sub (local.get $x) (i32.load offset=32 (local.get $desc))))
            (i64.extend_i32_s (i32.load offset=56 (local.get $desc))))
          (i64.extend_i32_s (i32.load offset=40 (local.get $desc)))))))

  (func $gdi_line_map_y (param $desc i32) (param $y i32) (result i32)
    (i32.add (i32.load offset=76 (local.get $desc))
      (i32.add (i32.load offset=52 (local.get $desc))
        (call $gdi_round_ratio
          (i64.mul
            (i64.extend_i32_s (i32.sub (local.get $y) (i32.load offset=36 (local.get $desc))))
            (i64.extend_i32_s (i32.load offset=60 (local.get $desc))))
          (i64.extend_i32_s (i32.load offset=44 (local.get $desc)))))))

  (func $gdi_apply_rop2 (param $rop2 i32) (param $pen i32) (param $dst i32) (result i32)
    (if (i32.eq (local.get $rop2) (i32.const 1))
      (then (return (i32.const 0))))
    (if (i32.eq (local.get $rop2) (i32.const 2))
      (then (return (i32.and (i32.xor (i32.or (local.get $dst) (local.get $pen))
        (i32.const -1)) (i32.const 0x00FFFFFF)))))
    (if (i32.eq (local.get $rop2) (i32.const 3))
      (then (return (i32.and (local.get $dst)
        (i32.xor (local.get $pen) (i32.const 0x00FFFFFF))))))
    (if (i32.eq (local.get $rop2) (i32.const 4))
      (then (return (i32.xor (local.get $pen) (i32.const 0x00FFFFFF)))))
    (if (i32.eq (local.get $rop2) (i32.const 5))
      (then (return (i32.and (local.get $pen)
        (i32.xor (local.get $dst) (i32.const 0x00FFFFFF))))))
    (if (i32.eq (local.get $rop2) (i32.const 6))
      (then (return (i32.xor (local.get $dst) (i32.const 0x00FFFFFF)))))
    (if (i32.eq (local.get $rop2) (i32.const 7))
      (then (return (i32.xor (local.get $pen) (local.get $dst)))))
    (if (i32.eq (local.get $rop2) (i32.const 8))
      (then (return (i32.xor (i32.and (local.get $pen) (local.get $dst))
        (i32.const 0x00FFFFFF)))))
    (if (i32.eq (local.get $rop2) (i32.const 9))
      (then (return (i32.and (local.get $pen) (local.get $dst)))))
    (if (i32.eq (local.get $rop2) (i32.const 10))
      (then (return (i32.xor (i32.xor (local.get $pen) (local.get $dst))
        (i32.const 0x00FFFFFF)))))
    (if (i32.eq (local.get $rop2) (i32.const 11))
      (then (return (local.get $dst))))
    (if (i32.eq (local.get $rop2) (i32.const 12))
      (then (return (i32.or (local.get $dst)
        (i32.xor (local.get $pen) (i32.const 0x00FFFFFF))))))
    (if (i32.eq (local.get $rop2) (i32.const 13))
      (then (return (local.get $pen))))
    (if (i32.eq (local.get $rop2) (i32.const 14))
      (then (return (i32.or (local.get $pen)
        (i32.xor (local.get $dst) (i32.const 0x00FFFFFF))))))
    (if (i32.eq (local.get $rop2) (i32.const 15))
      (then (return (i32.or (local.get $pen) (local.get $dst)))))
    (i32.const 0x00FFFFFF))

  ;; Default cosmetic-pen patterns use device-pixel major-axis steps. Values
  ;; match the Windows-compatible tables: dash {6,2}, dot {1,1}, dash-dot
  ;; {3,2,1,2}, and dash-dot-dot {3,1,1,1,1,1}.
  (func $gdi_pen_style_draw (param $style i32) (param $phase i32) (result i32)
    (if (i32.eq (local.get $style) (i32.const 1))
      (then (return (i32.lt_u (i32.rem_u (local.get $phase) (i32.const 8)) (i32.const 6)))))
    (if (i32.eq (local.get $style) (i32.const 2))
      (then (return (i32.eqz (i32.and (local.get $phase) (i32.const 1))))))
    (if (i32.eq (local.get $style) (i32.const 3))
      (then
        (local.set $phase (i32.rem_u (local.get $phase) (i32.const 8)))
        (return (i32.or (i32.lt_u (local.get $phase) (i32.const 3))
          (i32.eq (local.get $phase) (i32.const 5))))))
    (if (i32.eq (local.get $style) (i32.const 4))
      (then
        (local.set $phase (i32.rem_u (local.get $phase) (i32.const 8)))
        (return (i32.or (i32.lt_u (local.get $phase) (i32.const 3))
          (i32.and (i32.ge_u (local.get $phase) (i32.const 4))
            (i32.eqz (i32.and (local.get $phase) (i32.const 1))))))))
    (i32.const 1))

  (func $gdi_line_put_pixel (param $hdc i32) (param $desc i32)
        (param $x i32) (param $y i32) (param $rop2 i32) (result i32)
    (local $dst i32) (local $value i32) (local $pen i32)
    (if (i32.or
          (i32.or (i32.lt_s (local.get $x) (i32.const 0))
            (i32.ge_s (local.get $x) (i32.load offset=4 (local.get $desc))))
          (i32.or (i32.lt_s (local.get $y) (i32.const 0))
            (i32.ge_s (local.get $y) (i32.load offset=8 (local.get $desc)))))
      (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_dc_clip_device_point_visible
          (local.get $hdc)
          (i32.sub (local.get $x) (i32.load offset=72 (local.get $desc)))
          (i32.sub (local.get $y) (i32.load offset=76 (local.get $desc)))))
      (then (return (i32.const 0))))
    (local.set $dst (call $gdi_raster_read
      (local.get $desc) (local.get $x) (local.get $y)))
    (if (i32.eq (local.get $dst) (i32.const -1)) (then (return (i32.const 0))))
    ;; Convert COLORREF 0x00BBGGRR to the DIB byte-packed 0x00RRGGBB value.
    (local.set $pen (i32.load offset=24 (local.get $desc)))
    (local.set $pen (i32.or
      (i32.or (i32.shl (i32.and (local.get $pen) (i32.const 0xFF)) (i32.const 16))
        (i32.and (local.get $pen) (i32.const 0xFF00)))
      (i32.and (i32.shr_u (local.get $pen) (i32.const 16)) (i32.const 0xFF))))
    (local.set $value (call $gdi_apply_rop2
      (local.get $rop2) (local.get $pen) (local.get $dst)))
    (call $gdi_raster_write
      (local.get $desc) (local.get $x) (local.get $y) (local.get $value)))

  ;; Format-neutral pixel write for filled geometry. color is a COLORREF and
  ;; desc uses the line descriptor's surface/mapping layout. Geometry callers
  ;; own coverage; this helper owns native bytes, clip, and ROP2.
  (func $gdi_shape_clip_visible (param $hdc i32) (param $x i32) (param $y i32) (result i32)
    (call $gdi_dc_clip_device_point_visible
      (local.get $hdc) (local.get $x) (local.get $y)))

  (func $gdi_shape_unmap_x (param $desc i32) (param $x i32) (result i32)
    (i32.add (i32.load offset=32 (local.get $desc))
      (call $gdi_round_ratio
        (i64.mul
          (i64.extend_i32_s (i32.sub
            (i32.sub (local.get $x) (i32.load offset=72 (local.get $desc)))
            (i32.load offset=48 (local.get $desc))))
          (i64.extend_i32_s (i32.load offset=40 (local.get $desc))))
        (i64.extend_i32_s (i32.load offset=56 (local.get $desc))))))

  (func $gdi_shape_unmap_y (param $desc i32) (param $y i32) (result i32)
    (i32.add (i32.load offset=36 (local.get $desc))
      (call $gdi_round_ratio
        (i64.mul
          (i64.extend_i32_s (i32.sub
            (i32.sub (local.get $y) (i32.load offset=76 (local.get $desc)))
            (i32.load offset=52 (local.get $desc))))
          (i64.extend_i32_s (i32.load offset=44 (local.get $desc))))
        (i64.extend_i32_s (i32.load offset=60 (local.get $desc))))))

  (func $gdi_raster_clip_visible (param $hdc i32) (param $desc i32)
        (param $x i32) (param $y i32) (result i32)
    (if (i32.eqz (local.get $hdc)) (then (return (i32.const 1))))
    (call $gdi_shape_clip_visible (local.get $hdc)
      (i32.sub (local.get $x) (i32.load offset=72 (local.get $desc)))
      (i32.sub (local.get $y) (i32.load offset=76 (local.get $desc)))))

  ;; Presentation is deliberately the only host boundary used by software
  ;; geometry. The canonical surface layer can replace this adapter's HDC
  ;; lookup with its stable surface id without changing raster semantics.
  (func $gdi_geometry_present (param $hdc i32) (param $desc i32)
        (param $left i32) (param $top i32) (param $right i32) (param $bottom i32)
    (local $swap i32)
    ;; Signed StretchBlt extents can report either corner first. Upload the
    ;; normalized dirty rectangle without changing the canonical coordinates.
    (if (i32.gt_s (local.get $left) (local.get $right))
      (then
        (local.set $swap (i32.add (local.get $left) (i32.const 1)))
        (local.set $left (i32.add (local.get $right) (i32.const 1)))
        (local.set $right (local.get $swap))))
    (if (i32.gt_s (local.get $top) (local.get $bottom))
      (then
        (local.set $swap (i32.add (local.get $top) (i32.const 1)))
        (local.set $top (i32.add (local.get $bottom) (i32.const 1)))
        (local.set $bottom (local.get $swap))))
    (drop (call $host_gdi_surface_upload
      (i32.load offset=68 (local.get $desc)) (local.get $left) (local.get $top)
      (local.get $right) (local.get $bottom))))

  (func $gdi_shape_put_pixel (param $hdc i32) (param $desc i32)
        (param $x i32) (param $y i32) (param $color i32) (param $rop2 i32) (result i32)
    (local $dst i32) (local $value i32) (local $packed i32)
    (if (i32.or
          (i32.or (i32.lt_s (local.get $x) (i32.const 0))
            (i32.ge_s (local.get $x) (i32.load offset=4 (local.get $desc))))
          (i32.or (i32.lt_s (local.get $y) (i32.const 0))
            (i32.ge_s (local.get $y) (i32.load offset=8 (local.get $desc)))))
      (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_shape_clip_visible
          (local.get $hdc)
          (i32.sub (local.get $x) (i32.load offset=72 (local.get $desc)))
          (i32.sub (local.get $y) (i32.load offset=76 (local.get $desc)))))
      (then (return (i32.const 0))))
    (local.set $dst (call $gdi_raster_read
      (local.get $desc) (local.get $x) (local.get $y)))
    (if (i32.eq (local.get $dst) (i32.const -1)) (then (return (i32.const 0))))
    (local.set $packed (i32.or
      (i32.or (i32.shl (i32.and (local.get $color) (i32.const 0xFF)) (i32.const 16))
        (i32.and (local.get $color) (i32.const 0xFF00)))
      (i32.and (i32.shr_u (local.get $color) (i32.const 16)) (i32.const 0xFF))))
    (local.set $value (call $gdi_apply_rop2
      (local.get $rop2) (local.get $packed) (local.get $dst)))
    (call $gdi_raster_write
      (local.get $desc) (local.get $x) (local.get $y) (local.get $value)))

  (func $gdi_shape_desc_valid (param $desc i32) (result i32)
    (i32.and
      (i32.and
        (i32.and (i32.ne (i32.load (local.get $desc)) (i32.const 0))
          (i32.and (i32.gt_s (i32.load offset=4 (local.get $desc)) (i32.const 0))
            (i32.gt_s (i32.load offset=8 (local.get $desc)) (i32.const 0))))
        (i32.and
          (i32.and (i32.ne (i32.load offset=40 (local.get $desc)) (i32.const 0))
            (i32.ne (i32.load offset=44 (local.get $desc)) (i32.const 0)))
          (i32.and (i32.ne (i32.load offset=56 (local.get $desc)) (i32.const 0))
            (i32.ne (i32.load offset=60 (local.get $desc)) (i32.const 0)))))
      (i32.and
        (i32.or (i32.eq (i32.load offset=16 (local.get $desc)) (i32.const 16))
          (i32.or (i32.eq (i32.load offset=16 (local.get $desc)) (i32.const 24))
            (i32.eq (i32.load offset=16 (local.get $desc)) (i32.const 32))))
        (i32.ge_u (i32.load offset=12 (local.get $desc))
          (i32.mul (i32.load offset=4 (local.get $desc))
            (select (i32.const 2)
              (select (i32.const 3) (i32.const 4)
                (i32.eq (i32.load offset=16 (local.get $desc)) (i32.const 24)))
              (i32.eq (i32.load offset=16 (local.get $desc)) (i32.const 16))))))))

  (func $gdi_shape_fill_span (param $hdc i32) (param $desc i32)
        (param $y i32) (param $left i32) (param $right i32)
        (param $color i32) (param $rop2 i32) (result i32)
    (local $x i32) (local $wrote i32) (local $p i32) (local $packed i32)
    (local $size i32) (local $clip_left i32) (local $clip_top i32)
    (local $clip_right i32) (local $clip_bottom i32)
    (local $app_clip i32) (local $system_clip i32) (local $bound i32)
    ;; The classic UI and Paint spend most geometry time in solid COPYPEN
    ;; spans. Once surface bounds and retained clipping are known to be simple,
    ;; write the canonical XRGB words directly instead of re-running the full
    ;; format/clip/ROP pipeline for every pixel.
    (if (i32.and (i32.eq (i32.load offset=16 (local.get $desc)) (i32.const 32))
          (i32.eq (local.get $rop2) (i32.const 13)))
      (then
        (local.set $app_clip (call $gdi_raster_app_clip_record (local.get $hdc)))
        (local.set $system_clip (call $gdi_raster_system_clip_record (local.get $hdc)))))
    (if (i32.and
          (i32.and (i32.eq (i32.load offset=16 (local.get $desc)) (i32.const 32))
            (i32.eq (local.get $rop2) (i32.const 13)))
          (i32.and (i32.ne (local.get $app_clip) (i32.const 0))
            (i32.ne (local.get $system_clip) (i32.const 0))))
      (then
        (local.set $clip_right (i32.load offset=4 (local.get $desc)))
        (local.set $clip_bottom (i32.load offset=8 (local.get $desc)))
        (local.set $size (call $gdi_dc_target_size (local.get $hdc)))
        (if (local.get $size)
          (then
            (local.set $clip_left (i32.load offset=72 (local.get $desc)))
            (local.set $clip_top (i32.load offset=76 (local.get $desc)))
            (local.set $clip_right (i32.add (local.get $clip_left)
              (i32.and (local.get $size) (i32.const 0xFFFF))))
            (local.set $clip_bottom (i32.add (local.get $clip_top)
              (i32.shr_u (local.get $size) (i32.const 16))))))
        (if (i32.gt_u (local.get $app_clip) (i32.const 1))
          (then
            (local.set $bound (i32.add (i32.load offset=72 (local.get $desc))
              (i32.load offset=8 (local.get $app_clip))))
            (if (i32.gt_s (local.get $bound) (local.get $clip_left))
              (then (local.set $clip_left (local.get $bound))))
            (local.set $bound (i32.add (i32.load offset=76 (local.get $desc))
              (i32.load offset=12 (local.get $app_clip))))
            (if (i32.gt_s (local.get $bound) (local.get $clip_top))
              (then (local.set $clip_top (local.get $bound))))
            (local.set $bound (i32.add (i32.load offset=72 (local.get $desc))
              (i32.load offset=16 (local.get $app_clip))))
            (if (i32.lt_s (local.get $bound) (local.get $clip_right))
              (then (local.set $clip_right (local.get $bound))))
            (local.set $bound (i32.add (i32.load offset=76 (local.get $desc))
              (i32.load offset=20 (local.get $app_clip))))
            (if (i32.lt_s (local.get $bound) (local.get $clip_bottom))
              (then (local.set $clip_bottom (local.get $bound))))))
        (if (i32.gt_u (local.get $system_clip) (i32.const 1))
          (then
            (local.set $bound (i32.add (i32.load offset=72 (local.get $desc))
              (i32.load offset=8 (local.get $system_clip))))
            (if (i32.gt_s (local.get $bound) (local.get $clip_left))
              (then (local.set $clip_left (local.get $bound))))
            (local.set $bound (i32.add (i32.load offset=76 (local.get $desc))
              (i32.load offset=12 (local.get $system_clip))))
            (if (i32.gt_s (local.get $bound) (local.get $clip_top))
              (then (local.set $clip_top (local.get $bound))))
            (local.set $bound (i32.add (i32.load offset=72 (local.get $desc))
              (i32.load offset=16 (local.get $system_clip))))
            (if (i32.lt_s (local.get $bound) (local.get $clip_right))
              (then (local.set $clip_right (local.get $bound))))
            (local.set $bound (i32.add (i32.load offset=76 (local.get $desc))
              (i32.load offset=20 (local.get $system_clip))))
            (if (i32.lt_s (local.get $bound) (local.get $clip_bottom))
              (then (local.set $clip_bottom (local.get $bound))))))
        (if (i32.or (i32.lt_s (local.get $y) (local.get $clip_top))
              (i32.ge_s (local.get $y) (local.get $clip_bottom)))
          (then (return (i32.const 0))))
        (if (i32.lt_s (local.get $left) (local.get $clip_left))
          (then (local.set $left (local.get $clip_left))))
        (if (i32.gt_s (local.get $right) (local.get $clip_right))
          (then (local.set $right (local.get $clip_right))))
        (if (i32.ge_s (local.get $left) (local.get $right))
          (then (return (i32.const 0))))
        (local.set $packed (call $gdi_raster_swap_rb (local.get $color)))
        (local.set $p (call $gdi_raster_row_ptr_32
          (local.get $desc) (local.get $left) (local.get $y)))
        (local.set $x (local.get $left))
        (block $fast_done (loop $fast_pixels
          (br_if $fast_done (i32.ge_s (local.get $x) (local.get $right)))
          (i32.store (local.get $p) (local.get $packed))
          (local.set $p (i32.add (local.get $p) (i32.const 4)))
          (local.set $x (i32.add (local.get $x) (i32.const 1)))
          (br $fast_pixels)))
        (global.set $gdi_fast_span_hits
          (i32.add (global.get $gdi_fast_span_hits) (i32.const 1)))
        (return (i32.const 1))))
    (local.set $x (local.get $left))
    (block $done (loop $pixels
      (br_if $done (i32.ge_s (local.get $x) (local.get $right)))
      (local.set $wrote (i32.or (local.get $wrote)
        (call $gdi_shape_put_pixel (local.get $hdc) (local.get $desc)
          (local.get $x) (local.get $y) (local.get $color) (local.get $rop2))))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (br $pixels)))
    (local.get $wrote))

  (func $gdi_chrome_sys_color (param $idx i32) (result i32)
    (if (i32.eq (local.get $idx) (i32.const 1)) (then (return (i32.const 0x00808000))))
    (if (i32.eq (local.get $idx) (i32.const 2)) (then (return (i32.const 0x00800000))))
    (if (i32.eq (local.get $idx) (i32.const 5)) (then (return (i32.const 0x00FFFFFF))))
    (if (i32.or (i32.eq (local.get $idx) (i32.const 6))
          (i32.or (i32.eq (local.get $idx) (i32.const 7))
            (i32.or (i32.eq (local.get $idx) (i32.const 8))
              (i32.or (i32.eq (local.get $idx) (i32.const 18))
                (i32.eq (local.get $idx) (i32.const 19))))))
      (then (return (i32.const 0))))
    (if (i32.or (i32.eq (local.get $idx) (i32.const 12))
          (i32.or (i32.eq (local.get $idx) (i32.const 16))
            (i32.eq (local.get $idx) (i32.const 17))))
      (then (return (i32.const 0x00808080))))
    (if (i32.eq (local.get $idx) (i32.const 13)) (then (return (i32.const 0x00800000))))
    (if (i32.or (i32.eq (local.get $idx) (i32.const 9))
          (i32.or (i32.eq (local.get $idx) (i32.const 14))
            (i32.eq (local.get $idx) (i32.const 20))))
      (then (return (i32.const 0x00FFFFFF))))
    (i32.const 0x00C0C0C0))

  ;; Validate brushes independently from sampling them. 0x30015 is the stock
  ;; NULL_BRUSH and therefore valid even though it never produces a pixel.
  (func $gdi_brush_valid (param $brush i32) (result i32)
    (local $style i32) (local $record i32)
    (if (i32.and (i32.ge_u (local.get $brush) (i32.const 1))
          (i32.le_u (local.get $brush) (i32.const 23)))
      (then (return (i32.const 1))))
    (if (i32.and (i32.ge_u (local.get $brush) (i32.const 0x30010))
          (i32.le_u (local.get $brush) (i32.const 0x30015)))
      (then (return (i32.const 1))))
    (if (i32.ne (call $gdi_object_type (local.get $brush)) (i32.const 2))
      (then (return (i32.const 0))))
    (local.set $record (call $gdi_object_record (local.get $brush)))
    (local.set $style (call $gdi_object_style (local.get $brush)))
    (i32.or (i32.eqz (local.get $style))
      (i32.or (i32.eq (local.get $style) (i32.const 1))
        (i32.or (i32.eq (local.get $style) (i32.const 2))
          (i32.and
            (i32.or (i32.eq (local.get $style) (i32.const 3))
              (i32.eq (local.get $style) (i32.const 6)))
            (i32.eq (call $gdi_object_type (i32.load offset=24 (local.get $record)))
              (i32.const 3)))))))

  ;; Resolve one brush pixel in device coordinates. Values above COLORREF are
  ;; control sentinels: 0x01000000 is invalid and 0x01000001 is transparent.
  (func $gdi_brush_sample (param $hdc i32) (param $brush i32)
        (param $x i32) (param $y i32) (result i32)
    (local $record i32) (local $style i32) (local $hatch i32)
    (local $px i32) (local $py i32) (local $foreground i32)
    (local $bitmap i32) (local $bitmap_record i32) (local $desc i32)
    (local $color i32) (local $index i32) (local $logical_index i32)
    (if (i32.and (i32.ge_u (local.get $brush) (i32.const 1))
          (i32.le_u (local.get $brush) (i32.const 23)))
      (then (return (call $gdi_chrome_sys_color
        (i32.sub (local.get $brush) (i32.const 1))))))
    (if (i32.eq (local.get $brush) (i32.const 0x30015))
      (then (return (i32.const 0x01000001))))
    (if (i32.and (i32.ge_u (local.get $brush) (i32.const 0x30010))
          (i32.le_u (local.get $brush) (i32.const 0x30014)))
      (then (return (call $gdi_stock_object_color (local.get $brush)))))
    (local.set $record (call $gdi_object_record (local.get $brush)))
    (if (i32.or (i32.eqz (local.get $record))
          (i32.ne (i32.load offset=4 (local.get $record)) (i32.const 2)))
      (then (return (i32.const 0x01000000))))
    (local.set $style (i32.load offset=8 (local.get $record)))
    (if (i32.eqz (local.get $style))
      (then (return (i32.load offset=16 (local.get $record)))))
    (if (i32.eq (local.get $style) (i32.const 1))
      (then (return (i32.const 0x01000001))))
    (if (i32.or (i32.eq (local.get $style) (i32.const 3))
          (i32.eq (local.get $style) (i32.const 6)))
      (then
        (local.set $bitmap (i32.load offset=24 (local.get $record)))
        (local.set $desc (global.get $GDI_BRUSH_DESC))
        (if (i32.eqz (call $gdi_raster_desc_from_bitmap
              (local.get $bitmap) (local.get $desc)))
          (then (return (i32.const 0x01000000))))
        (local.set $px (i32.rem_s (i32.sub (local.get $x)
          (call $gdi_dc_aux_get (local.get $hdc) (i32.const 8) (i32.const 0)))
          (i32.load offset=4 (local.get $desc))))
        (local.set $py (i32.rem_s (i32.sub (local.get $y)
          (call $gdi_dc_aux_get (local.get $hdc) (i32.const 12) (i32.const 0)))
          (i32.load offset=8 (local.get $desc))))
        (if (i32.lt_s (local.get $px) (i32.const 0))
          (then (local.set $px (i32.add (local.get $px) (i32.load offset=4 (local.get $desc))))))
        (if (i32.lt_s (local.get $py) (i32.const 0))
          (then (local.set $py (i32.add (local.get $py) (i32.load offset=8 (local.get $desc))))))
        (local.set $bitmap_record (call $gdi_object_record (local.get $bitmap)))
        (if (i32.and (i32.ne (local.get $bitmap_record) (i32.const 0))
              (i32.ne (i32.and (i32.load offset=20 (local.get $bitmap_record))
                (i32.const 0x10)) (i32.const 0)))
          (then
            (local.set $index (call $gdi_raster_read_index
              (local.get $desc) (local.get $px) (local.get $py)))
            (if (i32.or (i32.lt_s (local.get $index) (i32.const 0))
                  (i32.ge_u (local.get $index)
                    (i32.load offset=36 (local.get $bitmap_record))))
              (then (return (i32.const 0x01000000))))
            (local.set $logical_index (i32.load
              (i32.add (i32.load offset=32 (local.get $bitmap_record))
                (i32.shl (local.get $index) (i32.const 2)))))
            (local.set $color (call $gdi_palette_colorref
              (call $gdi_dc_selected_palette (local.get $hdc))
              (local.get $logical_index)))
            (if (i32.eq (local.get $color) (i32.const -1))
              (then (return (i32.const 0x01000000))))
            (return (local.get $color))))
        (local.set $color (call $gdi_raster_read
          (local.get $desc) (local.get $px) (local.get $py)))
        (if (i32.eq (local.get $color) (i32.const -1))
          (then (return (i32.const 0x01000000))))
        (return (call $gdi_raster_swap_rb (local.get $color)))))
    (if (i32.ne (local.get $style) (i32.const 2))
      (then (return (i32.const 0x01000000))))
    (local.set $hatch (i32.load offset=12 (local.get $record)))
    (if (i32.gt_u (local.get $hatch) (i32.const 5))
      (then (return (i32.const 0x01000000))))
    (local.set $px (i32.and (i32.sub (local.get $x)
      (call $gdi_dc_aux_get (local.get $hdc) (i32.const 8) (i32.const 0))) (i32.const 7)))
    (local.set $py (i32.and (i32.sub (local.get $y)
      (call $gdi_dc_aux_get (local.get $hdc) (i32.const 12) (i32.const 0))) (i32.const 7)))
    (if (i32.eqz (local.get $hatch))
      (then (local.set $foreground (i32.eqz (local.get $py)))))
    (if (i32.eq (local.get $hatch) (i32.const 1))
      (then (local.set $foreground (i32.eqz (local.get $px)))))
    (if (i32.eq (local.get $hatch) (i32.const 2))
      (then (local.set $foreground (i32.eqz
        (i32.and (i32.add (local.get $px) (local.get $py)) (i32.const 7))))))
    (if (i32.eq (local.get $hatch) (i32.const 3))
      (then (local.set $foreground (i32.eqz
        (i32.and (i32.sub (local.get $px) (local.get $py)) (i32.const 7))))))
    (if (i32.eq (local.get $hatch) (i32.const 4))
      (then (local.set $foreground
        (i32.or (i32.eqz (local.get $px)) (i32.eqz (local.get $py))))))
    (if (i32.eq (local.get $hatch) (i32.const 5))
      (then (local.set $foreground (i32.or
        (i32.eqz (i32.and (i32.add (local.get $px) (local.get $py)) (i32.const 7)))
        (i32.eqz (i32.and (i32.sub (local.get $px) (local.get $py)) (i32.const 7)))))))
    (if (local.get $foreground)
      (then (return (i32.load offset=16 (local.get $record)))))
    (if (i32.eq (call $gdi_dc_get_field
          (local.get $hdc) (i32.const 28) (i32.const 2)) (i32.const 2))
      (then (return (call $gdi_dc_get_field
        (local.get $hdc) (i32.const 24) (i32.const 0xFFFFFF)))))
    (i32.const 0x01000001))

  (func $gdi_brush_fill_span (param $hdc i32) (param $desc i32)
        (param $y i32) (param $left i32) (param $right i32)
        (param $brush i32) (param $rop2 i32) (result i32)
    (local $x i32) (local $color i32) (local $wrote i32)
    (local.set $color (call $gdi_brush_solid_color (local.get $brush)))
    (if (i32.and (i32.le_u (local.get $color) (i32.const 0xFFFFFF))
          (i32.eq (local.get $rop2) (i32.const 13)))
      (then (return (call $gdi_shape_fill_span
        (local.get $hdc) (local.get $desc) (local.get $y)
        (local.get $left) (local.get $right) (local.get $color) (local.get $rop2)))))
    (local.set $x (local.get $left))
    (block $done (loop $pixels
      (br_if $done (i32.ge_s (local.get $x) (local.get $right)))
      (local.set $color (call $gdi_brush_sample
        (local.get $hdc) (local.get $brush) (local.get $x) (local.get $y)))
      (if (i32.eq (local.get $color) (i32.const 0x01000000))
        (then (return (i32.const 0))))
      (if (i32.le_u (local.get $color) (i32.const 0xFFFFFF))
        (then (local.set $wrote (i32.or (local.get $wrote)
          (call $gdi_shape_put_pixel (local.get $hdc) (local.get $desc)
            (local.get $x) (local.get $y) (local.get $color) (local.get $rop2))))))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (br $pixels)))
    (local.get $wrote))

  (func $gdi_fill_rect_desc (param $hdc i32) (param $desc i32)
        (param $left i32) (param $top i32) (param $right i32) (param $bottom i32)
        (param $brush i32) (result i32)
    (local $x0 i32) (local $y0 i32) (local $x1 i32) (local $y1 i32)
    (local $y i32) (local $wrote i32)
    (if (i32.eqz (call $gdi_shape_desc_valid (local.get $desc)))
      (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_brush_valid (local.get $brush)))
      (then (return (i32.const 0))))
    (local.set $x0 (call $gdi_line_map_x (local.get $desc) (local.get $left)))
    (local.set $y0 (call $gdi_line_map_y (local.get $desc) (local.get $top)))
    (local.set $x1 (call $gdi_line_map_x (local.get $desc) (local.get $right)))
    (local.set $y1 (call $gdi_line_map_y (local.get $desc) (local.get $bottom)))
    (if (i32.or (i32.le_s (local.get $x1) (local.get $x0))
          (i32.le_s (local.get $y1) (local.get $y0)))
      (then (return (i32.const 1))))
    (local.set $y (local.get $y0))
    (block $done (loop $rows
      (br_if $done (i32.ge_s (local.get $y) (local.get $y1)))
      (local.set $wrote (i32.or (local.get $wrote)
        (call $gdi_brush_fill_span (local.get $hdc) (local.get $desc)
          (local.get $y) (local.get $x0) (local.get $x1) (local.get $brush) (i32.const 13))))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows)))
    (if (local.get $wrote)
      (then (call $gdi_geometry_present (local.get $hdc) (local.get $desc)
        (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1))))
    (i32.const 1))

  (func $gdi_gradient_channel (param $a i32) (param $b i32)
        (param $step i32) (param $span i32) (result i32)
    (if (i32.le_s (local.get $span) (i32.const 1))
      (then (return (local.get $a))))
    (i32.add (local.get $a)
      (i32.div_s
        (i32.mul (i32.sub (local.get $b) (local.get $a)) (local.get $step))
        (i32.sub (local.get $span) (i32.const 1)))))

  (func $gdi_gradient_fill_h_desc (param $hdc i32) (param $desc i32)
        (param $left i32) (param $top i32) (param $right i32) (param $bottom i32)
        (param $color_left i32) (param $color_right i32) (result i32)
    (local $x0 i32) (local $y0 i32) (local $x1 i32) (local $y1 i32)
    (local $x i32) (local $y i32) (local $step i32) (local $span i32)
    (local $r i32) (local $g i32) (local $b i32) (local $color i32)
    (local $wrote i32)
    (if (i32.eqz (call $gdi_shape_desc_valid (local.get $desc)))
      (then (return (i32.const 0))))
    (local.set $x0 (call $gdi_line_map_x (local.get $desc) (local.get $left)))
    (local.set $y0 (call $gdi_line_map_y (local.get $desc) (local.get $top)))
    (local.set $x1 (call $gdi_line_map_x (local.get $desc) (local.get $right)))
    (local.set $y1 (call $gdi_line_map_y (local.get $desc) (local.get $bottom)))
    (if (i32.or (i32.le_s (local.get $x1) (local.get $x0))
          (i32.le_s (local.get $y1) (local.get $y0)))
      (then (return (i32.const 1))))
    (local.set $span (i32.sub (local.get $x1) (local.get $x0)))
    (local.set $x (local.get $x0))
    (block $columns_done (loop $columns
      (br_if $columns_done (i32.ge_s (local.get $x) (local.get $x1)))
      (local.set $step (i32.sub (local.get $x) (local.get $x0)))
      (local.set $r (call $gdi_gradient_channel
        (i32.and (local.get $color_left) (i32.const 0xFF))
        (i32.and (local.get $color_right) (i32.const 0xFF))
        (local.get $step) (local.get $span)))
      (local.set $g (call $gdi_gradient_channel
        (i32.and (i32.shr_u (local.get $color_left) (i32.const 8)) (i32.const 0xFF))
        (i32.and (i32.shr_u (local.get $color_right) (i32.const 8)) (i32.const 0xFF))
        (local.get $step) (local.get $span)))
      (local.set $b (call $gdi_gradient_channel
        (i32.and (i32.shr_u (local.get $color_left) (i32.const 16)) (i32.const 0xFF))
        (i32.and (i32.shr_u (local.get $color_right) (i32.const 16)) (i32.const 0xFF))
        (local.get $step) (local.get $span)))
      (local.set $color (i32.or (local.get $r)
        (i32.or (i32.shl (local.get $g) (i32.const 8))
          (i32.shl (local.get $b) (i32.const 16)))))
      (local.set $y (local.get $y0))
      (block $rows_done (loop $rows
        (br_if $rows_done (i32.ge_s (local.get $y) (local.get $y1)))
        (local.set $wrote (i32.or (local.get $wrote)
          (call $gdi_shape_put_pixel (local.get $hdc) (local.get $desc)
            (local.get $x) (local.get $y) (local.get $color) (i32.const 13))))
        (local.set $y (i32.add (local.get $y) (i32.const 1)))
        (br $rows)))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (br $columns)))
    (if (local.get $wrote)
      (then (call $gdi_geometry_present (local.get $hdc) (local.get $desc)
        (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1))))
    (i32.const 1))

  ;; Default WM_ERASEBKGND over the canonical window surface. Creating the DC
  ;; before filling guarantees that early dialog erases are not stranded on a
  ;; renderer canvas which a later WAT surface attachment would replace.
  (func $host_erase_background (param $hwnd i32) (param $brush i32) (result i32)
    (local $hdc i32) (local $desc i32) (local $w i32) (local $h i32)
    (if (i32.eqz (local.get $brush)) (then (return (i32.const 1))))
    (local.set $hdc (call $host_alloc_window_dc (local.get $hwnd) (i32.const 0)))
    (if (i32.eqz (local.get $hdc)) (then (return (i32.const 0))))
    (call $dc_apply_client_erase_clip (local.get $hdc) (local.get $hwnd))
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc))
      (then
        (local.set $w (call $wnd_client_w_for_clip (local.get $hwnd)))
        (local.set $h (call $wnd_client_h_for_clip (local.get $hwnd)))
        (drop (call $gdi_fill_rect_desc
          (local.get $hdc) (local.get $desc)
          (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
          (local.get $brush)))))
    (drop (call $host_release_dc (local.get $hdc)))
    (i32.const 1))

  (func $gdi_frame_rect_desc (param $hdc i32) (param $desc i32)
        (param $left i32) (param $top i32) (param $right i32) (param $bottom i32)
        (param $brush i32) (result i32)
    (local $x0 i32) (local $y0 i32) (local $x1 i32) (local $y1 i32)
    (local $y i32) (local $color i32) (local $wrote i32)
    (if (i32.eqz (call $gdi_shape_desc_valid (local.get $desc)))
      (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_brush_valid (local.get $brush)))
      (then (return (i32.const 0))))
    (local.set $x0 (call $gdi_line_map_x (local.get $desc) (local.get $left)))
    (local.set $y0 (call $gdi_line_map_y (local.get $desc) (local.get $top)))
    (local.set $x1 (call $gdi_line_map_x (local.get $desc) (local.get $right)))
    (local.set $y1 (call $gdi_line_map_y (local.get $desc) (local.get $bottom)))
    (if (i32.or (i32.le_s (local.get $x1) (local.get $x0))
          (i32.le_s (local.get $y1) (local.get $y0)))
      (then (return (i32.const 1))))
    (local.set $wrote (call $gdi_brush_fill_span (local.get $hdc) (local.get $desc)
      (local.get $y0) (local.get $x0) (local.get $x1) (local.get $brush) (i32.const 13)))
    (if (i32.gt_s (local.get $y1) (i32.add (local.get $y0) (i32.const 1)))
      (then (local.set $wrote (i32.or (local.get $wrote)
        (call $gdi_brush_fill_span (local.get $hdc) (local.get $desc)
          (i32.sub (local.get $y1) (i32.const 1)) (local.get $x0) (local.get $x1)
          (local.get $brush) (i32.const 13))))))
    (local.set $y (i32.add (local.get $y0) (i32.const 1)))
    (block $sides_done (loop $sides
      (br_if $sides_done (i32.ge_s (local.get $y) (i32.sub (local.get $y1) (i32.const 1))))
      (local.set $color (call $gdi_brush_sample
        (local.get $hdc) (local.get $brush) (local.get $x0) (local.get $y)))
      (if (i32.le_u (local.get $color) (i32.const 0xFFFFFF))
        (then (local.set $wrote (i32.or (local.get $wrote)
          (call $gdi_shape_put_pixel (local.get $hdc) (local.get $desc)
            (local.get $x0) (local.get $y) (local.get $color) (i32.const 13))))))
      (if (i32.gt_s (local.get $x1) (i32.add (local.get $x0) (i32.const 1)))
        (then
          (local.set $color (call $gdi_brush_sample
            (local.get $hdc) (local.get $brush)
            (i32.sub (local.get $x1) (i32.const 1)) (local.get $y)))
          (if (i32.le_u (local.get $color) (i32.const 0xFFFFFF))
            (then (local.set $wrote (i32.or (local.get $wrote)
              (call $gdi_shape_put_pixel (local.get $hdc) (local.get $desc)
                (i32.sub (local.get $x1) (i32.const 1)) (local.get $y)
                (local.get $color) (i32.const 13))))))))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $sides)))
    (if (local.get $wrote)
      (then (call $gdi_geometry_present (local.get $hdc) (local.get $desc)
        (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1))))
    (i32.const 1))

  ;; Draw one rectangular edge layer. sides uses BF_LEFT/TOP/RIGHT/BOTTOM.
  (func $gdi_edge_layer (param $hdc i32) (param $desc i32)
        (param $left i32) (param $top i32) (param $right i32) (param $bottom i32)
        (param $sides i32) (param $tl i32) (param $br i32) (result i32)
    (local $x i32) (local $y i32) (local $wrote i32)
    (if (i32.and (local.get $sides) (i32.const 2))
      (then (local.set $wrote (i32.or (local.get $wrote)
        (call $gdi_shape_fill_span (local.get $hdc) (local.get $desc)
          (local.get $top) (local.get $left) (local.get $right)
          (local.get $tl) (i32.const 13))))))
    (if (i32.and (local.get $sides) (i32.const 8))
      (then (local.set $wrote (i32.or (local.get $wrote)
        (call $gdi_shape_fill_span (local.get $hdc) (local.get $desc)
          (i32.sub (local.get $bottom) (i32.const 1)) (local.get $left) (local.get $right)
          (local.get $br) (i32.const 13))))))
    (local.set $y (local.get $top))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_s (local.get $y) (local.get $bottom)))
      (if (i32.and (local.get $sides) (i32.const 1))
        (then (local.set $wrote (i32.or (local.get $wrote)
          (call $gdi_shape_put_pixel (local.get $hdc) (local.get $desc)
            (local.get $left) (local.get $y) (local.get $tl) (i32.const 13))))))
      (if (i32.and (local.get $sides) (i32.const 4))
        (then (local.set $wrote (i32.or (local.get $wrote)
          (call $gdi_shape_put_pixel (local.get $hdc) (local.get $desc)
            (i32.sub (local.get $right) (i32.const 1)) (local.get $y)
            (local.get $br) (i32.const 13))))))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows)))
    (local.get $wrote))

  (func $gdi_draw_edge_desc (param $hdc i32) (param $desc i32)
        (param $left i32) (param $top i32) (param $right i32) (param $bottom i32)
        (param $edge i32) (param $flags i32) (param $adjust i32) (result i32)
    (local $x0 i32) (local $y0 i32) (local $x1 i32) (local $y1 i32)
    (local $sides i32) (local $layers i32) (local $wrote i32)
    (local $tl i32) (local $br i32)
    (if (i32.or (i32.eqz (call $gdi_shape_desc_valid (local.get $desc)))
          (i32.and (local.get $flags) (i32.const 0x10)))
      (then (return (i32.const 0))))
    (local.set $sides (i32.and (local.get $flags) (i32.const 15)))
    (local.set $x0 (call $gdi_line_map_x (local.get $desc) (local.get $left)))
    (local.set $y0 (call $gdi_line_map_y (local.get $desc) (local.get $top)))
    (local.set $x1 (call $gdi_line_map_x (local.get $desc) (local.get $right)))
    (local.set $y1 (call $gdi_line_map_y (local.get $desc) (local.get $bottom)))
    (if (i32.or (i32.le_s (local.get $x1) (local.get $x0))
          (i32.le_s (local.get $y1) (local.get $y0)))
      (then (return (i32.const 1))))
    ;; Outer layer. BF_MONO and BF_FLAT intentionally collapse to high/black
    ;; and face/shadow palettes used by Win98 classic chrome.
    (if (i32.and (local.get $edge) (i32.const 3))
      (then
        (local.set $layers (i32.const 1))
        (if (i32.and (local.get $edge) (i32.const 1))
          (then (local.set $tl (i32.const 0xFFFFFF)) (local.set $br (i32.const 0)))
          (else (local.set $tl (i32.const 0)) (local.set $br (i32.const 0xFFFFFF))))
        (if (i32.and (local.get $flags) (i32.const 0x4000))
          (then (local.set $tl (i32.const 0x808080)) (local.set $br (i32.const 0x808080))))
        (if (i32.and (local.get $flags) (i32.const 0x8000))
          (then (local.set $tl (i32.const 0xFFFFFF)) (local.set $br (i32.const 0))))
        (local.set $wrote (call $gdi_edge_layer (local.get $hdc) (local.get $desc)
          (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1)
          (local.get $sides) (local.get $tl) (local.get $br)))
        (if (i32.and (local.get $sides) (i32.const 1)) (then (local.set $x0 (i32.add (local.get $x0) (i32.const 1)))))
        (if (i32.and (local.get $sides) (i32.const 2)) (then (local.set $y0 (i32.add (local.get $y0) (i32.const 1)))))
        (if (i32.and (local.get $sides) (i32.const 4)) (then (local.set $x1 (i32.sub (local.get $x1) (i32.const 1)))))
        (if (i32.and (local.get $sides) (i32.const 8)) (then (local.set $y1 (i32.sub (local.get $y1) (i32.const 1)))))))
    ;; Inner layer.
    (if (i32.and (local.get $edge) (i32.const 12))
      (then
        (local.set $layers (i32.add (local.get $layers) (i32.const 1)))
        (if (i32.and (local.get $edge) (i32.const 4))
          (then (local.set $tl (i32.const 0xC0C0C0)) (local.set $br (i32.const 0x808080)))
          (else (local.set $tl (i32.const 0x808080)) (local.set $br (i32.const 0xC0C0C0))))
        (if (i32.and (local.get $flags) (i32.const 0x8000))
          (then (local.set $tl (i32.const 0xFFFFFF)) (local.set $br (i32.const 0))))
        (local.set $wrote (i32.or (local.get $wrote)
          (call $gdi_edge_layer (local.get $hdc) (local.get $desc)
            (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1)
            (local.get $sides) (local.get $tl) (local.get $br))))
        (if (i32.and (local.get $sides) (i32.const 1)) (then (local.set $x0 (i32.add (local.get $x0) (i32.const 1)))))
        (if (i32.and (local.get $sides) (i32.const 2)) (then (local.set $y0 (i32.add (local.get $y0) (i32.const 1)))))
        (if (i32.and (local.get $sides) (i32.const 4)) (then (local.set $x1 (i32.sub (local.get $x1) (i32.const 1)))))
        (if (i32.and (local.get $sides) (i32.const 8)) (then (local.set $y1 (i32.sub (local.get $y1) (i32.const 1)))))))
    (if (i32.and (local.get $flags) (i32.const 0x800))
      (then
        (local.set $y0 (select (local.get $y0)
          (call $gdi_line_map_y (local.get $desc) (local.get $top))
          (i32.and (local.get $sides) (i32.const 2))))
        (local.set $y1 (select (local.get $y1)
          (call $gdi_line_map_y (local.get $desc) (local.get $bottom))
          (i32.and (local.get $sides) (i32.const 8))))
        (block $middle_done (loop $middle
          (br_if $middle_done (i32.ge_s (local.get $y0) (local.get $y1)))
          (local.set $wrote (i32.or (local.get $wrote)
            (call $gdi_shape_fill_span (local.get $hdc) (local.get $desc)
              (local.get $y0) (local.get $x0) (local.get $x1)
              (i32.const 0xC0C0C0) (i32.const 13))))
          (local.set $y0 (i32.add (local.get $y0) (i32.const 1)))
          (br $middle)))))
    (if (i32.and
          (i32.ne (i32.and (local.get $flags) (i32.const 0x2000)) (i32.const 0))
          (i32.ne (local.get $adjust) (i32.const 0)))
      (then
        (if (i32.and (local.get $sides) (i32.const 1))
          (then (i32.store (local.get $adjust) (i32.add (local.get $left) (local.get $layers)))))
        (if (i32.and (local.get $sides) (i32.const 2))
          (then (i32.store offset=4 (local.get $adjust) (i32.add (local.get $top) (local.get $layers)))))
        (if (i32.and (local.get $sides) (i32.const 4))
          (then (i32.store offset=8 (local.get $adjust) (i32.sub (local.get $right) (local.get $layers)))))
        (if (i32.and (local.get $sides) (i32.const 8))
          (then (i32.store offset=12 (local.get $adjust) (i32.sub (local.get $bottom) (local.get $layers)))))))
    (if (local.get $wrote)
      (then (call $gdi_geometry_present (local.get $hdc) (local.get $desc)
        (call $gdi_line_map_x (local.get $desc) (local.get $left))
        (call $gdi_line_map_y (local.get $desc) (local.get $top))
        (call $gdi_line_map_x (local.get $desc) (local.get $right))
        (call $gdi_line_map_y (local.get $desc) (local.get $bottom)))))
    (i32.const 1))

  (func $gdi_focus_rect_desc (param $hdc i32) (param $desc i32)
        (param $left i32) (param $top i32) (param $right i32) (param $bottom i32) (result i32)
    (local $x0 i32) (local $y0 i32) (local $x1 i32) (local $y1 i32)
    (local $x i32) (local $y i32) (local $wrote i32) (local $edge i32)
    (if (i32.eqz (call $gdi_shape_desc_valid (local.get $desc)))
      (then (return (i32.const 0))))
    (local.set $x0 (call $gdi_line_map_x (local.get $desc) (local.get $left)))
    (local.set $y0 (call $gdi_line_map_y (local.get $desc) (local.get $top)))
    (local.set $x1 (call $gdi_line_map_x (local.get $desc) (local.get $right)))
    (local.set $y1 (call $gdi_line_map_y (local.get $desc) (local.get $bottom)))
    (if (i32.or (i32.le_s (local.get $x1) (local.get $x0))
          (i32.le_s (local.get $y1) (local.get $y0)))
      (then (return (i32.const 1))))
    (local.set $y (local.get $y0))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_s (local.get $y) (local.get $y1)))
      (local.set $x (local.get $x0))
      (block $cols_done (loop $cols
        (br_if $cols_done (i32.ge_s (local.get $x) (local.get $x1)))
        (local.set $edge (i32.or
          (i32.or (i32.eq (local.get $x) (local.get $x0))
            (i32.eq (local.get $x) (i32.sub (local.get $x1) (i32.const 1))))
          (i32.or (i32.eq (local.get $y) (local.get $y0))
            (i32.eq (local.get $y) (i32.sub (local.get $y1) (i32.const 1))))))
        (if (i32.and (local.get $edge)
              (i32.eqz (i32.and (i32.add (local.get $x) (local.get $y)) (i32.const 1))))
          (then (local.set $wrote (i32.or (local.get $wrote)
            (call $gdi_shape_put_pixel (local.get $hdc) (local.get $desc)
              (local.get $x) (local.get $y) (i32.const 0) (i32.const 6))))))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $cols)))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows)))
    (if (local.get $wrote)
      (then (call $gdi_geometry_present (local.get $hdc) (local.get $desc)
        (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1))))
    (i32.const 1))

  (func (export "test_gdi_fill_rect_desc")
        (param i32) (param i32) (param i32) (param i32) (param i32) (param i32) (param i32) (result i32)
    (call $gdi_fill_rect_desc (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (local.get 4) (local.get 5) (local.get 6)))
  (func (export "test_gdi_frame_rect_desc")
        (param i32) (param i32) (param i32) (param i32) (param i32) (param i32) (param i32) (result i32)
    (call $gdi_frame_rect_desc (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (local.get 4) (local.get 5) (local.get 6)))
  (func (export "test_gdi_draw_edge_desc")
        (param i32) (param i32) (param i32) (param i32) (param i32) (param i32)
        (param i32) (param i32) (param i32) (result i32)
    (call $gdi_draw_edge_desc (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (local.get 4) (local.get 5) (local.get 6) (local.get 7) (local.get 8)))
  (func (export "test_gdi_focus_rect_desc")
        (param i32) (param i32) (param i32) (param i32) (param i32) (param i32) (result i32)
    (call $gdi_focus_rect_desc (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (local.get 4) (local.get 5)))

  ;; Native Windows 98 DIB captures show that CreatePen widths 2..5 use an
  ;; exact rectangular footprint for horizontal and vertical LineTo calls,
  ;; including both endpoint caps.  Rasterize that coverage once so every ROP2
  ;; is safe; larger and diagonal wide strokes retain their existing kernel
  ;; until their independently captured integer coverage is implemented.
  (func $gdi_axis_wide_line_desc (param $hdc i32) (param $desc i32)
        (param $x0 i32) (param $y0 i32) (param $x1 i32) (param $y1 i32)
        (param $width i32) (param $color i32) (param $rop2 i32) (result i32)
    (local $half i32) (local $far i32) (local $left i32) (local $top i32)
    (local $right i32) (local $bottom i32) (local $x i32) (local $y i32)
    (local $wrote i32) (local $min_x i32) (local $min_y i32)
    (local $max_x i32) (local $max_y i32)
    (if (i32.or (i32.lt_u (local.get $width) (i32.const 2))
          (i32.gt_u (local.get $width) (i32.const 5)))
      (then (return (i32.const 0))))
    (if (i32.and (i32.ne (local.get $x0) (local.get $x1))
          (i32.ne (local.get $y0) (local.get $y1)))
      (then (return (i32.const 0))))
    (local.set $half (i32.shr_u (local.get $width) (i32.const 1)))
    (local.set $far (i32.sub (local.get $width) (local.get $half)))
    (if (i32.eq (local.get $y0) (local.get $y1))
      (then
        (local.set $left (i32.sub
          (select (local.get $x0) (local.get $x1) (i32.lt_s (local.get $x0) (local.get $x1)))
          (local.get $half)))
        (local.set $right (i32.add
          (select (local.get $x1) (local.get $x0) (i32.lt_s (local.get $x0) (local.get $x1)))
          (local.get $far)))
        (local.set $top (i32.sub (local.get $y0) (local.get $half)))
        (local.set $bottom (i32.add (local.get $top) (local.get $width))))
      (else
        (local.set $left (i32.sub (local.get $x0) (local.get $half)))
        (local.set $right (i32.add (local.get $left) (local.get $width)))
        (local.set $top (i32.sub
          (select (local.get $y0) (local.get $y1) (i32.lt_s (local.get $y0) (local.get $y1)))
          (local.get $half)))
        (local.set $bottom (i32.add
          (select (local.get $y1) (local.get $y0) (i32.lt_s (local.get $y0) (local.get $y1)))
          (local.get $far)))))
    (local.set $min_x (i32.const 0x7FFFFFFF))
    (local.set $min_y (i32.const 0x7FFFFFFF))
    (local.set $max_x (i32.const 0x80000000))
    (local.set $max_y (i32.const 0x80000000))
    (local.set $y (local.get $top))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_s (local.get $y) (local.get $bottom)))
      (local.set $x (local.get $left))
      (block $cols_done (loop $cols
        (br_if $cols_done (i32.ge_s (local.get $x) (local.get $right)))
        (if (call $gdi_shape_put_pixel (local.get $hdc) (local.get $desc)
              (local.get $x) (local.get $y) (local.get $color) (local.get $rop2))
          (then
            (local.set $wrote (i32.const 1))
            (if (i32.lt_s (local.get $x) (local.get $min_x))
              (then (local.set $min_x (local.get $x))))
            (if (i32.lt_s (local.get $y) (local.get $min_y))
              (then (local.set $min_y (local.get $y))))
            (if (i32.gt_s (local.get $x) (local.get $max_x))
              (then (local.set $max_x (local.get $x))))
            (if (i32.gt_s (local.get $y) (local.get $max_y))
              (then (local.set $max_y (local.get $y))))))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $cols)))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows)))
    (if (local.get $wrote)
      (then (call $gdi_geometry_present (local.get $hdc) (local.get $desc)
        (local.get $min_x) (local.get $min_y)
        (i32.add (local.get $max_x) (i32.const 1))
        (i32.add (local.get $max_y) (i32.const 1)))))
    (i32.const 1))

  (func $gdi_line_desc_can_raster (param $desc i32)
        (param $from_x i32) (param $from_y i32) (param $to_x i32) (param $to_y i32)
        (param $pen i32) (param $rop2 i32) (result i32)
    (local $x0 i32) (local $y0 i32) (local $x1 i32) (local $y1 i32)
    (local $dx i32) (local $dy i32) (local $span i32) (local $width i32)
    (if (i32.eqz (call $gdi_shape_desc_valid (local.get $desc)))
      (then (return (i32.const 0))))
    (if (i32.eq (local.get $pen) (i32.const 0x30018)) (then (return (i32.const 1))))
    (if (i32.ne (call $gdi_object_type (local.get $pen)) (i32.const 1))
      (then (return (i32.const 0))))
    (if (i32.gt_u (call $gdi_object_style (local.get $pen)) (i32.const 6))
      (then (return (i32.const 0))))
    (local.set $width (call $gdi_object_width (local.get $pen)))
    (if (i32.gt_u (local.get $width) (i32.const 64)) (then (return (i32.const 0))))
    (local.set $x0 (call $gdi_line_map_x (local.get $desc) (local.get $from_x)))
    (local.set $y0 (call $gdi_line_map_y (local.get $desc) (local.get $from_y)))
    (local.set $x1 (call $gdi_line_map_x (local.get $desc) (local.get $to_x)))
    (local.set $y1 (call $gdi_line_map_y (local.get $desc) (local.get $to_y)))
    (local.set $dx (select (i32.sub (local.get $x1) (local.get $x0))
      (i32.sub (local.get $x0) (local.get $x1)) (i32.ge_s (local.get $x1) (local.get $x0))))
    (local.set $dy (select (i32.sub (local.get $y1) (local.get $y0))
      (i32.sub (local.get $y0) (local.get $y1)) (i32.ge_s (local.get $y1) (local.get $y0))))
    (local.set $span (select (local.get $dx) (local.get $dy)
      (i32.ge_u (local.get $dx) (local.get $dy))))
    ;; Only the captured axis-aligned width-2..5 coverage has a one-write
    ;; region for non-idempotent ROP2 modes so far.
    (if (i32.and (i32.gt_u (local.get $width) (i32.const 1))
          (i32.and (i32.ne (local.get $rop2) (i32.const 13))
            (i32.or
              (i32.or (i32.lt_u (local.get $width) (i32.const 2))
                (i32.gt_u (local.get $width) (i32.const 5)))
              (i32.and (i32.ne (local.get $x0) (local.get $x1))
                (i32.ne (local.get $y0) (local.get $y1))))))
      (then (return (i32.const 0))))
    (if (i32.gt_u (local.get $span) (i32.const 65536)) (then (return (i32.const 0))))
    (if (i64.gt_u
          (i64.mul (i64.extend_i32_u (local.get $span))
            (i64.mul (i64.extend_i32_u (local.get $width))
              (i64.extend_i32_u (local.get $width))))
          (i64.const 4000000))
      (then (return (i32.const 0))))
    (i32.const 1))

  ;; Exact integer Bresenham walk. Like LineTo, the final endpoint is not
  ;; painted. Thick cosmetic pens use square integer stamps without Canvas.
  (func $gdi_line_desc (param $hdc i32) (param $desc i32)
        (param $from_x i32) (param $from_y i32) (param $to_x i32) (param $to_y i32)
        (param $pen i32) (param $rop2 i32) (result i32)
    (local $x0 i32) (local $y0 i32) (local $x1 i32) (local $y1 i32)
    (local $dx i32) (local $dy i32) (local $sx i32) (local $sy i32)
    (local $err i32) (local $e2 i32) (local $width i32) (local $style i32)
    (local $stamp_x i32) (local $stamp_y i32) (local $left i32) (local $top i32)
    (local $pixel_x i32) (local $pixel_y i32) (local $color i32) (local $wrote i32)
    (local $min_x i32) (local $min_y i32) (local $max_x i32) (local $max_y i32)
    (if (i32.eqz (call $gdi_line_desc_can_raster (local.get $desc)
          (local.get $from_x) (local.get $from_y) (local.get $to_x) (local.get $to_y)
          (local.get $pen) (local.get $rop2)))
      (then (return (i32.const 0))))
    (if (i32.eq (local.get $pen) (i32.const 0x30018)) (then (return (i32.const 1))))
    (local.set $x0 (call $gdi_line_map_x (local.get $desc) (local.get $from_x)))
    (local.set $y0 (call $gdi_line_map_y (local.get $desc) (local.get $from_y)))
    (local.set $x1 (call $gdi_line_map_x (local.get $desc) (local.get $to_x)))
    (local.set $y1 (call $gdi_line_map_y (local.get $desc) (local.get $to_y)))
    (if (i32.and (i32.eq (local.get $x0) (local.get $x1))
          (i32.eq (local.get $y0) (local.get $y1)))
      (then (return (i32.const 1))))
    (local.set $width (call $gdi_object_width (local.get $pen)))
    (local.set $style (call $gdi_object_style (local.get $pen)))
    (local.set $color (call $gdi_object_color (local.get $pen)))
    (if (call $gdi_axis_wide_line_desc (local.get $hdc) (local.get $desc)
          (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1)
          (local.get $width) (local.get $color) (local.get $rop2))
      (then (return (i32.const 1))))
    (local.set $min_x (i32.const 0x7FFFFFFF))
    (local.set $min_y (i32.const 0x7FFFFFFF))
    (local.set $max_x (i32.const 0x80000000))
    (local.set $max_y (i32.const 0x80000000))
    (if (i32.ge_s (local.get $x1) (local.get $x0))
      (then
        (local.set $dx (i32.sub (local.get $x1) (local.get $x0)))
        (local.set $sx (i32.const 1)))
      (else
        (local.set $dx (i32.sub (local.get $x0) (local.get $x1)))
        (local.set $sx (i32.const -1))))
    (if (i32.ge_s (local.get $y1) (local.get $y0))
      (then
        (local.set $dy (i32.sub (local.get $y0) (local.get $y1)))
        (local.set $sy (i32.const 1)))
      (else
        (local.set $dy (i32.sub (local.get $y1) (local.get $y0)))
        (local.set $sy (i32.const -1))))
    (local.set $err (i32.add (local.get $dx) (local.get $dy)))
    (block $done (loop $pixels
      (br_if $done (i32.and (i32.eq (local.get $x0) (local.get $x1))
        (i32.eq (local.get $y0) (local.get $y1))))
      (if (call $gdi_pen_style_draw (local.get $style) (global.get $gdi_line_style_phase))
        (then
          (local.set $left (i32.sub (local.get $x0)
            (i32.shr_u (local.get $width) (i32.const 1))))
          (local.set $top (i32.sub (local.get $y0)
            (i32.shr_u (local.get $width) (i32.const 1))))
          (local.set $stamp_y (i32.const 0))
          (block $stamp_rows_done (loop $stamp_rows
            (br_if $stamp_rows_done (i32.ge_u (local.get $stamp_y) (local.get $width)))
            (local.set $pixel_y (i32.add (local.get $top) (local.get $stamp_y)))
            (local.set $stamp_x (i32.const 0))
            (block $stamp_cols_done (loop $stamp_cols
              (br_if $stamp_cols_done (i32.ge_u (local.get $stamp_x) (local.get $width)))
              (local.set $pixel_x (i32.add (local.get $left) (local.get $stamp_x)))
              (if (call $gdi_shape_put_pixel (local.get $hdc) (local.get $desc)
                    (local.get $pixel_x) (local.get $pixel_y) (local.get $color) (local.get $rop2))
                (then
                  (local.set $wrote (i32.const 1))
                  (if (i32.lt_s (local.get $pixel_x) (local.get $min_x))
                    (then (local.set $min_x (local.get $pixel_x))))
                  (if (i32.lt_s (local.get $pixel_y) (local.get $min_y))
                    (then (local.set $min_y (local.get $pixel_y))))
                  (if (i32.gt_s (local.get $pixel_x) (local.get $max_x))
                    (then (local.set $max_x (local.get $pixel_x))))
                  (if (i32.gt_s (local.get $pixel_y) (local.get $max_y))
                    (then (local.set $max_y (local.get $pixel_y))))))
              (local.set $stamp_x (i32.add (local.get $stamp_x) (i32.const 1)))
              (br $stamp_cols)))
            (local.set $stamp_y (i32.add (local.get $stamp_y) (i32.const 1)))
            (br $stamp_rows)))))
      (global.set $gdi_line_style_phase
        (i32.add (global.get $gdi_line_style_phase) (i32.const 1)))
      (local.set $e2 (i32.shl (local.get $err) (i32.const 1)))
      (if (i32.ge_s (local.get $e2) (local.get $dy))
        (then
          (local.set $err (i32.add (local.get $err) (local.get $dy)))
          (local.set $x0 (i32.add (local.get $x0) (local.get $sx)))))
      (if (i32.le_s (local.get $e2) (local.get $dx))
        (then
          (local.set $err (i32.add (local.get $err) (local.get $dx)))
          (local.set $y0 (i32.add (local.get $y0) (local.get $sy)))))
      (br $pixels)))
    (if (local.get $wrote)
      (then (call $gdi_geometry_present
        (local.get $hdc) (local.get $desc) (local.get $min_x) (local.get $min_y)
        (i32.add (local.get $max_x) (i32.const 1))
        (i32.add (local.get $max_y) (i32.const 1)))))
    (i32.const 1))

  (func (export "test_gdi_line_desc")
        (param i32) (param i32) (param i32) (param i32) (param i32)
        (param i32) (param i32) (param i32) (result i32)
    (global.set $gdi_line_style_phase (i32.const 0))
    (call $gdi_line_desc (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (local.get 4) (local.get 5) (local.get 6) (local.get 7)))

  ;; Closed polygon fill reuses the canonical integer region scan converter.
  ;; The temporary mapped points live in the WAT heap and the resulting
  ;; canonical bands are consumed directly; no host polygon representation
  ;; participates in coverage.
  (func $gdi_polygon_desc (param $hdc i32) (param $desc i32)
        (param $points i32) (param $count i32) (param $pen i32) (param $brush i32)
        (param $rop2 i32) (param $fill_mode i32) (result i32)
    (local $guest_temp i32) (local $mapped i32) (local $src i32) (local $dst i32)
    (local $i i32) (local $j i32) (local $region i32) (local $record i32)
    (local $bands i32) (local $band i32) (local $band_count i32)
    (local $y i32) (local $wrote i32)
    (if (i32.or (i32.eqz (call $gdi_shape_desc_valid (local.get $desc)))
          (i32.or (i32.eqz (local.get $points))
            (i32.or (i32.lt_u (local.get $count) (i32.const 3))
              (i32.gt_u (local.get $count) (global.get $GDI_REGION_MAX_RECTS)))))
      (then (return (i32.const 0))))
    (if (i32.and (i32.ne (local.get $fill_mode) (i32.const 1))
          (i32.ne (local.get $fill_mode) (i32.const 2)))
      (then (return (i32.const 0))))
    (if (i32.and (i32.ne (local.get $pen) (i32.const 0x30018))
          (i32.ne (call $gdi_object_type (local.get $pen)) (i32.const 1)))
      (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_brush_valid (local.get $brush)))
      (then (return (i32.const 0))))
    ;; Preflight the complete closed outline before fill changes any byte.
    (if (i32.ne (local.get $pen) (i32.const 0x30018))
      (then
        (block $preflight_done (loop $preflight
          (br_if $preflight_done (i32.ge_u (local.get $i) (local.get $count)))
          (local.set $j (i32.add (local.get $i) (i32.const 1)))
          (if (i32.eq (local.get $j) (local.get $count)) (then (local.set $j (i32.const 0))))
          (local.set $src (i32.add (local.get $points) (i32.shl (local.get $i) (i32.const 3))))
          (local.set $dst (i32.add (local.get $points) (i32.shl (local.get $j) (i32.const 3))))
          (if (i32.eqz (call $gdi_line_desc_can_raster (local.get $desc)
                (i32.load (local.get $src)) (i32.load offset=4 (local.get $src))
                (i32.load (local.get $dst)) (i32.load offset=4 (local.get $dst))
                (local.get $pen) (local.get $rop2)))
            (then (return (i32.const 0))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $preflight)))))
    (if (i32.ne (local.get $brush) (i32.const 0x30015))
      (then
        (local.set $guest_temp (call $heap_alloc (i32.shl (local.get $count) (i32.const 3))))
        (if (i32.eqz (local.get $guest_temp)) (then (return (i32.const 0))))
        (local.set $mapped (call $g2w (local.get $guest_temp)))
        (local.set $i (i32.const 0))
        (block $map_done (loop $map
          (br_if $map_done (i32.ge_u (local.get $i) (local.get $count)))
          (local.set $src (i32.add (local.get $points) (i32.shl (local.get $i) (i32.const 3))))
          (local.set $dst (i32.add (local.get $mapped) (i32.shl (local.get $i) (i32.const 3))))
          (i32.store (local.get $dst)
            (call $gdi_line_map_x (local.get $desc) (i32.load (local.get $src))))
          (i32.store offset=4 (local.get $dst)
            (call $gdi_line_map_y (local.get $desc) (i32.load offset=4 (local.get $src))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $map)))
        (local.set $region (call $gdi_rgn_alloc_polygon
          (local.get $mapped) (local.get $count) (local.get $fill_mode)))
        (call $heap_free (local.get $guest_temp))
        (if (i32.eqz (local.get $region)) (then (return (i32.const 0))))
        (local.set $record (call $gdi_rgn_record (local.get $region)))
        (local.set $bands (call $gdi_rgn_bands (local.get $record)))
        (local.set $band_count (i32.load offset=28 (local.get $record)))
        (local.set $i (i32.const 0))
        (block $bands_done (loop $draw_bands
          (br_if $bands_done (i32.ge_u (local.get $i) (local.get $band_count)))
          (local.set $band (i32.add (local.get $bands) (i32.shl (local.get $i) (i32.const 4))))
          (local.set $y (i32.load offset=4 (local.get $band)))
          (block $band_rows_done (loop $band_rows
            (br_if $band_rows_done (i32.ge_s (local.get $y) (i32.load offset=12 (local.get $band))))
            (local.set $wrote (i32.or (local.get $wrote)
              (call $gdi_brush_fill_span (local.get $hdc) (local.get $desc)
                (local.get $y) (i32.load (local.get $band)) (i32.load offset=8 (local.get $band))
                (local.get $brush) (i32.const 13))))
            (local.set $y (i32.add (local.get $y) (i32.const 1)))
            (br $band_rows)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $draw_bands)))
        (if (local.get $wrote)
          (then (call $gdi_geometry_present (local.get $hdc) (local.get $desc)
            (i32.load offset=8 (local.get $record)) (i32.load offset=12 (local.get $record))
            (i32.load offset=16 (local.get $record)) (i32.load offset=20 (local.get $record)))))
        (drop (call $gdi_rgn_delete (local.get $region)))))
    (if (i32.ne (local.get $pen) (i32.const 0x30018))
      (then
        (global.set $gdi_line_style_phase (i32.const 0))
        (local.set $i (i32.const 0))
        (block $outline_done (loop $outline
          (br_if $outline_done (i32.ge_u (local.get $i) (local.get $count)))
          (local.set $j (i32.add (local.get $i) (i32.const 1)))
          (if (i32.eq (local.get $j) (local.get $count)) (then (local.set $j (i32.const 0))))
          (local.set $src (i32.add (local.get $points) (i32.shl (local.get $i) (i32.const 3))))
          (local.set $dst (i32.add (local.get $points) (i32.shl (local.get $j) (i32.const 3))))
          (drop (call $gdi_line_desc (local.get $hdc) (local.get $desc)
            (i32.load (local.get $src)) (i32.load offset=4 (local.get $src))
            (i32.load (local.get $dst)) (i32.load offset=4 (local.get $dst))
            (local.get $pen) (local.get $rop2)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $outline)))))
    (i32.const 1))

  (func (export "test_gdi_polygon_desc")
        (param i32) (param i32) (param i32) (param i32)
        (param i32) (param i32) (param i32) (param i32) (result i32)
    (call $gdi_polygon_desc (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (local.get 4) (local.get 5) (local.get 6) (local.get 7)))

  ;; Rectangle's lower/right edges are excluded by Win32. The brush fills the
  ;; interior first and the pen replaces coverage along the upper/left and
  ;; last included lower/right rows. Only solid/null pens and brushes are in
  ;; this milestone; unsupported styles fail before any byte is changed.
  (func $gdi_rectangle_desc (param $hdc i32) (param $desc i32)
        (param $left i32) (param $top i32) (param $right i32) (param $bottom i32)
        (param $pen i32) (param $brush i32) (param $rop2 i32) (result i32)
    (local $x0 i32) (local $y0 i32) (local $x1 i32) (local $y1 i32)
    (local $tmp i32) (local $y i32) (local $pen_color i32)
    (local $pen_width i32) (local $wrote i32)
    (if (i32.eqz (call $gdi_shape_desc_valid (local.get $desc)))
      (then (return (i32.const 0))))
    (if (i32.and (i32.ne (local.get $pen) (i32.const 0x30018))
          (i32.ne (call $gdi_object_type (local.get $pen)) (i32.const 1)))
      (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_brush_valid (local.get $brush)))
      (then (return (i32.const 0))))
    (if (i32.and (i32.ne (local.get $pen) (i32.const 0x30018))
          (i32.and
            (i32.ne (call $gdi_object_style (local.get $pen)) (i32.const 0))
            (i32.and
              (i32.ne (call $gdi_object_style (local.get $pen)) (i32.const 5))
              (i32.ne (call $gdi_object_style (local.get $pen)) (i32.const 6)))))
      (then (return (i32.const 0))))
    (local.set $x0 (call $gdi_line_map_x (local.get $desc) (local.get $left)))
    (local.set $y0 (call $gdi_line_map_y (local.get $desc) (local.get $top)))
    (local.set $x1 (call $gdi_line_map_x (local.get $desc) (local.get $right)))
    (local.set $y1 (call $gdi_line_map_y (local.get $desc) (local.get $bottom)))
    (if (i32.gt_s (local.get $x0) (local.get $x1))
      (then (local.set $tmp (local.get $x0)) (local.set $x0 (local.get $x1)) (local.set $x1 (local.get $tmp))))
    (if (i32.gt_s (local.get $y0) (local.get $y1))
      (then (local.set $tmp (local.get $y0)) (local.set $y0 (local.get $y1)) (local.set $y1 (local.get $tmp))))
    (if (i32.or (i32.le_s (local.get $x1) (local.get $x0))
          (i32.le_s (local.get $y1) (local.get $y0)))
      (then (return (i32.const 1))))
    (local.set $pen_color (call $gdi_object_color (local.get $pen)))
    (local.set $pen_width (call $gdi_object_width (local.get $pen)))
    (if (i32.or
          (i32.eq (local.get $pen) (i32.const 0x30018))
          (i32.eq (call $gdi_object_style (local.get $pen)) (i32.const 5)))
      (then (local.set $pen_width (i32.const 0))))
    (if (i32.gt_u (local.get $pen_width) (i32.const 64)) (then (return (i32.const 0))))
    (local.set $y (local.get $y0))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_s (local.get $y) (local.get $y1)))
      (if (i32.ne (local.get $brush) (i32.const 0x30015))
        (then (local.set $wrote (i32.or (local.get $wrote)
          (call $gdi_brush_fill_span (local.get $hdc) (local.get $desc)
            (local.get $y) (local.get $x0) (local.get $x1)
            (local.get $brush) (i32.const 13))))))
      (if (i32.gt_u (local.get $pen_width) (i32.const 0))
        (then
          (if (i32.or (i32.lt_s (i32.sub (local.get $y) (local.get $y0)) (local.get $pen_width))
                (i32.ge_s (local.get $y) (i32.sub (local.get $y1) (local.get $pen_width))))
            (then
              (local.set $wrote
                (i32.or (local.get $wrote)
                  (call $gdi_shape_fill_span (local.get $hdc) (local.get $desc)
                    (local.get $y) (local.get $x0) (local.get $x1)
                    (local.get $pen_color) (local.get $rop2)))))
            (else
              ;; Avoid applying non-idempotent ROP2 twice when the left and
              ;; right strips meet in a narrow rectangle.
              (if (i32.le_s (i32.sub (local.get $x1) (local.get $x0))
                    (i32.shl (local.get $pen_width) (i32.const 1)))
                (then
                  (local.set $wrote
                    (i32.or (local.get $wrote)
                      (call $gdi_shape_fill_span (local.get $hdc) (local.get $desc)
                        (local.get $y) (local.get $x0) (local.get $x1)
                        (local.get $pen_color) (local.get $rop2)))))
                (else
                  (local.set $wrote
                    (i32.or (local.get $wrote)
                      (call $gdi_shape_fill_span (local.get $hdc) (local.get $desc)
                        (local.get $y) (local.get $x0)
                        (i32.add (local.get $x0) (local.get $pen_width))
                        (local.get $pen_color) (local.get $rop2))))
                  (local.set $wrote
                    (i32.or (local.get $wrote)
                      (call $gdi_shape_fill_span (local.get $hdc) (local.get $desc)
                        (local.get $y) (i32.sub (local.get $x1) (local.get $pen_width))
                        (local.get $x1) (local.get $pen_color) (local.get $rop2))))))))))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows)))
    (if (local.get $wrote)
      (then (call $gdi_geometry_present
        (local.get $hdc) (local.get $desc)
        (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1))))
    (i32.const 1))

  ;; Pixel-center ellipse coverage. Fill is exact integer membership in the
  ;; half-open bounding box; the one-pixel outline is the filled set minus
  ;; pixels whose four axial neighbors are also inside.
  (func $gdi_ellipse_contains_device (param $x i32) (param $y i32)
        (param $left i32) (param $top i32) (param $right i32) (param $bottom i32) (result i32)
    (call $gdi_rgn_ellipse_inside
      (local.get $x) (local.get $y)
      (i32.add (local.get $left) (local.get $right))
      (i32.add (local.get $top) (local.get $bottom))
      (i32.sub (local.get $right) (local.get $left))
      (i32.sub (local.get $bottom) (local.get $top))))

  (func $gdi_ellipse_desc (param $hdc i32) (param $desc i32)
        (param $left i32) (param $top i32) (param $right i32) (param $bottom i32)
        (param $pen i32) (param $brush i32) (param $rop2 i32) (result i32)
    (local $x0 i32) (local $y0 i32) (local $x1 i32) (local $y1 i32)
    (local $tmp i32) (local $x i32) (local $y i32) (local $inside i32) (local $edge i32)
    (local $color i32) (local $wrote i32)
    (if (i32.eqz (call $gdi_shape_desc_valid (local.get $desc))) (then (return (i32.const 0))))
    (if (i32.and (i32.ne (local.get $pen) (i32.const 0x30018))
          (i32.ne (call $gdi_object_type (local.get $pen)) (i32.const 1)))
      (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_brush_valid (local.get $brush)))
      (then (return (i32.const 0))))
    ;; PS_INSIDEFRAME is solid coverage constrained to the shape interior;
    ;; this one-pixel outline already has that coverage.
    (if (i32.and (i32.ne (local.get $pen) (i32.const 0x30018))
          (i32.or (i32.and
              (i32.ne (call $gdi_object_style (local.get $pen)) (i32.const 0))
              (i32.ne (call $gdi_object_style (local.get $pen)) (i32.const 6)))
            (i32.ne (call $gdi_object_width (local.get $pen)) (i32.const 1))))
      (then (return (i32.const 0))))
    (local.set $x0 (call $gdi_line_map_x (local.get $desc) (local.get $left)))
    (local.set $y0 (call $gdi_line_map_y (local.get $desc) (local.get $top)))
    (local.set $x1 (call $gdi_line_map_x (local.get $desc) (local.get $right)))
    (local.set $y1 (call $gdi_line_map_y (local.get $desc) (local.get $bottom)))
    (if (i32.gt_s (local.get $x0) (local.get $x1))
      (then (local.set $tmp (local.get $x0)) (local.set $x0 (local.get $x1)) (local.set $x1 (local.get $tmp))))
    (if (i32.gt_s (local.get $y0) (local.get $y1))
      (then (local.set $tmp (local.get $y0)) (local.set $y0 (local.get $y1)) (local.set $y1 (local.get $tmp))))
    (if (i32.or (i32.le_s (local.get $x1) (local.get $x0))
          (i32.le_s (local.get $y1) (local.get $y0))) (then (return (i32.const 1))))
    (local.set $y (local.get $y0))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_s (local.get $y) (local.get $y1)))
      (local.set $x (local.get $x0))
      (block $cols_done (loop $cols
        (br_if $cols_done (i32.ge_s (local.get $x) (local.get $x1)))
        (local.set $inside (call $gdi_ellipse_contains_device
          (local.get $x) (local.get $y) (local.get $x0) (local.get $y0)
          (local.get $x1) (local.get $y1)))
        (if (local.get $inside)
          (then
            (local.set $edge (i32.and
              (i32.ne (local.get $pen) (i32.const 0x30018))
              (i32.eqz (i32.and
                (i32.and
                  (call $gdi_ellipse_contains_device (i32.sub (local.get $x) (i32.const 1)) (local.get $y)
                    (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1))
                  (call $gdi_ellipse_contains_device (i32.add (local.get $x) (i32.const 1)) (local.get $y)
                    (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1)))
                (i32.and
                  (call $gdi_ellipse_contains_device (local.get $x) (i32.sub (local.get $y) (i32.const 1))
                    (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1))
                  (call $gdi_ellipse_contains_device (local.get $x) (i32.add (local.get $y) (i32.const 1))
                    (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1)))))))
            (if (i32.or (local.get $edge) (i32.ne (local.get $brush) (i32.const 0x30015)))
              (then
                (if (local.get $edge)
                  (then
                    (local.set $wrote (i32.or (local.get $wrote)
                      (call $gdi_shape_put_pixel (local.get $hdc) (local.get $desc)
                        (local.get $x) (local.get $y)
                        (call $gdi_object_color (local.get $pen)) (local.get $rop2)))))
                  (else
                    (local.set $color (call $gdi_brush_sample
                      (local.get $hdc) (local.get $brush) (local.get $x) (local.get $y)))
                    (if (i32.le_u (local.get $color) (i32.const 0xFFFFFF))
                      (then (local.set $wrote (i32.or (local.get $wrote)
                        (call $gdi_shape_put_pixel (local.get $hdc) (local.get $desc)
                          (local.get $x) (local.get $y) (local.get $color) (i32.const 13))))))))))))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $cols)))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows)))
    (if (local.get $wrote)
      (then (call $gdi_geometry_present
        (local.get $hdc) (local.get $desc)
        (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1))))
    (i32.const 1))

  (func $gdi_round_rect_contains (param $x i32) (param $y i32)
        (param $left i32) (param $top i32) (param $right i32) (param $bottom i32)
        (param $round_w i32) (param $round_h i32) (result i32)
    (local $half_w i32) (local $half_h i32) (local $cx2 i32) (local $cy2 i32)
    (if (i32.or
          (i32.or (i32.lt_s (local.get $x) (local.get $left))
            (i32.ge_s (local.get $x) (local.get $right)))
          (i32.or (i32.lt_s (local.get $y) (local.get $top))
            (i32.ge_s (local.get $y) (local.get $bottom))))
      (then (return (i32.const 0))))
    (local.set $half_w (i32.shr_u (local.get $round_w) (i32.const 1)))
    (local.set $half_h (i32.shr_u (local.get $round_h) (i32.const 1)))
    (if (i32.or
          (i32.and (i32.ge_s (local.get $x) (i32.add (local.get $left) (local.get $half_w)))
            (i32.lt_s (local.get $x) (i32.sub (local.get $right) (local.get $half_w))))
          (i32.and (i32.ge_s (local.get $y) (i32.add (local.get $top) (local.get $half_h)))
            (i32.lt_s (local.get $y) (i32.sub (local.get $bottom) (local.get $half_h)))))
      (then (return (i32.const 1))))
    (local.set $cx2 (select
      (i32.add (i32.shl (local.get $left) (i32.const 1)) (local.get $round_w))
      (i32.sub (i32.shl (local.get $right) (i32.const 1)) (local.get $round_w))
      (i32.lt_s (local.get $x) (i32.add (local.get $left) (local.get $half_w)))))
    (local.set $cy2 (select
      (i32.add (i32.shl (local.get $top) (i32.const 1)) (local.get $round_h))
      (i32.sub (i32.shl (local.get $bottom) (i32.const 1)) (local.get $round_h))
      (i32.lt_s (local.get $y) (i32.add (local.get $top) (local.get $half_h)))))
    (call $gdi_rgn_ellipse_inside
      (local.get $x) (local.get $y) (local.get $cx2) (local.get $cy2)
      (local.get $round_w) (local.get $round_h)))

  (func $gdi_rgn_alloc_round_rect (param $left_in i32) (param $top_in i32)
        (param $right_in i32) (param $bottom_in i32)
        (param $ellipse_w_in i32) (param $ellipse_h_in i32) (result i32)
    (local $left i32) (local $top i32) (local $right i32) (local $bottom i32)
    (local $rw i32) (local $rh i32) (local $tmp i32) (local $y i32)
    (local $lo i32) (local $hi i32) (local $mid i32) (local $first i32) (local $last i32)
    (local $count i32) (local $p i32) (local $prev i32)
    (local $handle i32) (local $record i32)
    (local.set $left (local.get $left_in)) (local.set $top (local.get $top_in))
    (local.set $right (local.get $right_in)) (local.set $bottom (local.get $bottom_in))
    (if (i32.gt_s (local.get $left) (local.get $right))
      (then (local.set $tmp (local.get $left)) (local.set $left (local.get $right))
        (local.set $right (local.get $tmp))))
    (if (i32.gt_s (local.get $top) (local.get $bottom))
      (then (local.set $tmp (local.get $top)) (local.set $top (local.get $bottom))
        (local.set $bottom (local.get $tmp))))
    (if (i32.or (i32.ge_s (local.get $left) (local.get $right))
          (i32.ge_s (local.get $top) (local.get $bottom)))
      (then (return (call $gdi_rgn_alloc_rect
        (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))))
    (if (i32.or
          (i32.or (i32.lt_s (local.get $left) (i32.const -1073741824))
            (i32.gt_s (local.get $right) (i32.const 1073741823)))
          (i32.or (i32.lt_s (local.get $top) (i32.const -1073741824))
            (i32.gt_s (local.get $bottom) (i32.const 1073741823))))
      (then (return (i32.const 0))))
    (if (i32.gt_u (i32.sub (local.get $bottom) (local.get $top)) (i32.const 4096))
      (then (return (i32.const 0))))
    (local.set $rw (local.get $ellipse_w_in))
    (local.set $rh (local.get $ellipse_h_in))
    (if (i32.lt_s (local.get $rw) (i32.const 0))
      (then (local.set $rw (i32.sub (i32.const 0) (local.get $rw)))))
    (if (i32.lt_s (local.get $rh) (i32.const 0))
      (then (local.set $rh (i32.sub (i32.const 0) (local.get $rh)))))
    (if (i32.gt_u (local.get $rw) (i32.sub (local.get $right) (local.get $left)))
      (then (local.set $rw (i32.sub (local.get $right) (local.get $left)))))
    (if (i32.gt_u (local.get $rh) (i32.sub (local.get $bottom) (local.get $top)))
      (then (local.set $rh (i32.sub (local.get $bottom) (local.get $top)))))
    (if (i32.or (i32.le_s (local.get $rw) (i32.const 1))
          (i32.le_s (local.get $rh) (i32.const 1)))
      (then (return (call $gdi_rgn_alloc_rect
        (local.get $left) (local.get $top) (local.get $right) (local.get $bottom)))))
    (if (i32.or (i32.gt_u (local.get $rw) (i32.const 46340))
          (i32.gt_u (local.get $rh) (i32.const 46340)))
      (then (return (i32.const 0))))
    (local.set $y (local.get $top))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_s (local.get $y) (local.get $bottom)))
      (local.set $lo (local.get $left))
      (local.set $hi (i32.add (local.get $left)
        (i32.shr_u (i32.sub (local.get $right) (local.get $left)) (i32.const 1))))
      (block $left_done (loop $left_search
        (br_if $left_done (i32.ge_s (local.get $lo) (local.get $hi)))
        (local.set $mid (i32.add (local.get $lo)
          (i32.shr_u (i32.sub (local.get $hi) (local.get $lo)) (i32.const 1))))
        (if (call $gdi_round_rect_contains (local.get $mid) (local.get $y)
              (local.get $left) (local.get $top) (local.get $right) (local.get $bottom)
              (local.get $rw) (local.get $rh))
          (then (local.set $hi (local.get $mid)))
          (else (local.set $lo (i32.add (local.get $mid) (i32.const 1)))))
        (br $left_search)))
      (local.set $first (local.get $lo))
      (local.set $lo (i32.add (local.get $left)
        (i32.shr_u (i32.sub (local.get $right) (local.get $left)) (i32.const 1))))
      (local.set $hi (local.get $right))
      (block $right_done (loop $right_search
        (br_if $right_done (i32.ge_s (local.get $lo) (local.get $hi)))
        (local.set $mid (i32.add (local.get $lo)
          (i32.shr_u (i32.sub (local.get $hi) (local.get $lo)) (i32.const 1))))
        (if (call $gdi_round_rect_contains (local.get $mid) (local.get $y)
              (local.get $left) (local.get $top) (local.get $right) (local.get $bottom)
              (local.get $rw) (local.get $rh))
          (then (local.set $lo (i32.add (local.get $mid) (i32.const 1))))
          (else (local.set $hi (local.get $mid))))
        (br $right_search)))
      (local.set $last (local.get $lo))
      (if (local.get $count)
        (then (local.set $prev (i32.add (global.get $GDI_REGION_WORK)
          (i32.shl (i32.sub (local.get $count) (i32.const 1)) (i32.const 4))))))
      (if (i32.and (local.get $count)
            (i32.and (i32.eq (i32.load (local.get $prev)) (local.get $first))
              (i32.eq (i32.load offset=8 (local.get $prev)) (local.get $last))))
        (then (i32.store offset=12 (local.get $prev) (i32.add (local.get $y) (i32.const 1))))
        (else
          (if (i32.ge_u (local.get $count) (global.get $GDI_REGION_MAX_RECTS))
            (then (return (i32.const 0))))
          (local.set $p (i32.add (global.get $GDI_REGION_WORK)
            (i32.shl (local.get $count) (i32.const 4))))
          (i32.store (local.get $p) (local.get $first))
          (i32.store offset=4 (local.get $p) (local.get $y))
          (i32.store offset=8 (local.get $p) (local.get $last))
          (i32.store offset=12 (local.get $p) (i32.add (local.get $y) (i32.const 1)))
          (local.set $count (i32.add (local.get $count) (i32.const 1)))))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows)))
    (local.set $handle (call $gdi_rgn_alloc_rect
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
    (if (i32.eqz (local.get $handle)) (then (return (i32.const 0))))
    (local.set $record (call $gdi_rgn_record (local.get $handle)))
    (drop (call $gdi_rgn_set_buffer
      (local.get $record) (global.get $GDI_REGION_WORK) (local.get $count)))
    (local.get $handle))

  (func $gdi_round_rect_desc (param $hdc i32) (param $desc i32)
        (param $left i32) (param $top i32) (param $right i32) (param $bottom i32)
        (param $ellipse_w i32) (param $ellipse_h i32)
        (param $pen i32) (param $brush i32) (param $rop2 i32) (result i32)
    (local $x0 i32) (local $y0 i32) (local $x1 i32) (local $y1 i32)
    (local $tmp i32) (local $rw i32) (local $rh i32) (local $x i32) (local $y i32)
    (local $inside i32) (local $edge i32)
    (local $color i32) (local $wrote i32)
    (if (i32.eqz (call $gdi_shape_desc_valid (local.get $desc))) (then (return (i32.const 0))))
    (if (i32.and (i32.ne (local.get $pen) (i32.const 0x30018))
          (i32.ne (call $gdi_object_type (local.get $pen)) (i32.const 1)))
      (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_brush_valid (local.get $brush)))
      (then (return (i32.const 0))))
    (if (i32.and (i32.ne (local.get $pen) (i32.const 0x30018))
          (i32.or
            (i32.and (i32.ne (call $gdi_object_style (local.get $pen)) (i32.const 0))
              (i32.ne (call $gdi_object_style (local.get $pen)) (i32.const 6)))
            (i32.ne (call $gdi_object_width (local.get $pen)) (i32.const 1))))
      (then (return (i32.const 0))))
    (local.set $x0 (call $gdi_line_map_x (local.get $desc) (local.get $left)))
    (local.set $y0 (call $gdi_line_map_y (local.get $desc) (local.get $top)))
    (local.set $x1 (call $gdi_line_map_x (local.get $desc) (local.get $right)))
    (local.set $y1 (call $gdi_line_map_y (local.get $desc) (local.get $bottom)))
    (if (i32.gt_s (local.get $x0) (local.get $x1))
      (then (local.set $tmp (local.get $x0)) (local.set $x0 (local.get $x1)) (local.set $x1 (local.get $tmp))))
    (if (i32.gt_s (local.get $y0) (local.get $y1))
      (then (local.set $tmp (local.get $y0)) (local.set $y0 (local.get $y1)) (local.set $y1 (local.get $tmp))))
    (local.set $rw (i32.sub
      (call $gdi_line_map_x (local.get $desc) (local.get $ellipse_w))
      (call $gdi_line_map_x (local.get $desc) (i32.const 0))))
    (if (i32.lt_s (local.get $rw) (i32.const 0))
      (then (local.set $rw (i32.sub (i32.const 0) (local.get $rw)))))
    (local.set $rh (i32.sub
      (call $gdi_line_map_y (local.get $desc) (local.get $ellipse_h))
      (call $gdi_line_map_y (local.get $desc) (i32.const 0))))
    (if (i32.lt_s (local.get $rh) (i32.const 0))
      (then (local.set $rh (i32.sub (i32.const 0) (local.get $rh)))))
    (if (i32.gt_u (local.get $rw) (i32.sub (local.get $x1) (local.get $x0)))
      (then (local.set $rw (i32.sub (local.get $x1) (local.get $x0)))))
    (if (i32.gt_u (local.get $rh) (i32.sub (local.get $y1) (local.get $y0)))
      (then (local.set $rh (i32.sub (local.get $y1) (local.get $y0)))))
    (if (i32.or (i32.le_s (local.get $rw) (i32.const 1)) (i32.le_s (local.get $rh) (i32.const 1)))
      (then (return (call $gdi_rectangle_desc (local.get $hdc) (local.get $desc)
        (local.get $left) (local.get $top) (local.get $right) (local.get $bottom)
        (local.get $pen) (local.get $brush) (local.get $rop2)))))
    (local.set $y (local.get $y0))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_s (local.get $y) (local.get $y1)))
      (local.set $x (local.get $x0))
      (block $cols_done (loop $cols
        (br_if $cols_done (i32.ge_s (local.get $x) (local.get $x1)))
        (local.set $inside (call $gdi_round_rect_contains
          (local.get $x) (local.get $y) (local.get $x0) (local.get $y0)
          (local.get $x1) (local.get $y1) (local.get $rw) (local.get $rh)))
        (if (local.get $inside)
          (then
            (local.set $edge (i32.and (i32.ne (local.get $pen) (i32.const 0x30018))
              (i32.eqz (i32.and
                (i32.and
                  (call $gdi_round_rect_contains (i32.sub (local.get $x) (i32.const 1)) (local.get $y)
                    (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1)
                    (local.get $rw) (local.get $rh))
                  (call $gdi_round_rect_contains (i32.add (local.get $x) (i32.const 1)) (local.get $y)
                    (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1)
                    (local.get $rw) (local.get $rh)))
                (i32.and
                  (call $gdi_round_rect_contains (local.get $x) (i32.sub (local.get $y) (i32.const 1))
                    (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1)
                    (local.get $rw) (local.get $rh))
                  (call $gdi_round_rect_contains (local.get $x) (i32.add (local.get $y) (i32.const 1))
                    (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1)
                    (local.get $rw) (local.get $rh)))))))
            (if (i32.or (local.get $edge) (i32.ne (local.get $brush) (i32.const 0x30015)))
              (then
                (if (local.get $edge)
                  (then
                    (local.set $wrote (i32.or (local.get $wrote)
                      (call $gdi_shape_put_pixel (local.get $hdc) (local.get $desc)
                        (local.get $x) (local.get $y)
                        (call $gdi_object_color (local.get $pen)) (local.get $rop2)))))
                  (else
                    (local.set $color (call $gdi_brush_sample
                      (local.get $hdc) (local.get $brush) (local.get $x) (local.get $y)))
                    (if (i32.le_u (local.get $color) (i32.const 0xFFFFFF))
                      (then (local.set $wrote (i32.or (local.get $wrote)
                        (call $gdi_shape_put_pixel (local.get $hdc) (local.get $desc)
                          (local.get $x) (local.get $y) (local.get $color) (i32.const 13))))))))))))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $cols)))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows)))
    (if (local.get $wrote) (then (call $gdi_geometry_present
      (local.get $hdc) (local.get $desc) (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1))))
    (i32.const 1))

  (func $gdi_bezier_point (param $p0 i32) (param $p1 i32) (param $p2 i32)
        (param $p3 i32) (param $t i32) (result i32)
    (local $u i32) (local $value i64)
    (local.set $u (i32.sub (i32.const 32) (local.get $t)))
    (local.set $value
      (i64.add
        (i64.add
          (i64.mul (i64.extend_i32_s (local.get $p0))
            (i64.extend_i32_u (i32.mul (i32.mul (local.get $u) (local.get $u)) (local.get $u))))
          (i64.mul (i64.extend_i32_s (local.get $p1))
            (i64.extend_i32_u (i32.mul (i32.const 3)
              (i32.mul (i32.mul (local.get $u) (local.get $u)) (local.get $t))))))
        (i64.add
          (i64.mul (i64.extend_i32_s (local.get $p2))
            (i64.extend_i32_u (i32.mul (i32.const 3)
              (i32.mul (local.get $u) (i32.mul (local.get $t) (local.get $t))))))
          (i64.mul (i64.extend_i32_s (local.get $p3))
            (i64.extend_i32_u (i32.mul (i32.mul (local.get $t) (local.get $t)) (local.get $t)))))))
    (i32.wrap_i64 (i64.div_s (local.get $value) (i64.const 32768))))

  (func $gdi_poly_bezier (param $hdc i32) (param $points i32)
        (param $count i32) (param $from_current i32) (result i32)
    (local $index i32) (local $base i32) (local $p0x i32) (local $p0y i32)
    (local $p1x i32) (local $p1y i32) (local $p2x i32) (local $p2y i32)
    (local $p3x i32) (local $p3y i32) (local $x i32) (local $y i32)
    (local $prev_x i32) (local $prev_y i32) (local $step i32)
    (if (i32.or (i32.eqz (local.get $points))
          (select (i32.ne (i32.rem_u (local.get $count) (i32.const 3)) (i32.const 0))
            (i32.or (i32.lt_u (local.get $count) (i32.const 4))
              (i32.ne (i32.rem_u (i32.sub (local.get $count) (i32.const 1)) (i32.const 3)) (i32.const 0)))
            (local.get $from_current)))
      (then (return (i32.const 0))))
    (if (local.get $from_current)
      (then
        (local.set $p0x (call $gdi_dc_get_field (local.get $hdc) (i32.const 12) (i32.const 0)))
        (local.set $p0y (call $gdi_dc_get_field (local.get $hdc) (i32.const 16) (i32.const 0))))
      (else
        (local.set $p0x (i32.load (local.get $points)))
        (local.set $p0y (i32.load offset=4 (local.get $points)))
        (local.set $index (i32.const 1))))
    (block $done (loop $curves
      (br_if $done (i32.gt_u (i32.add (local.get $index) (i32.const 2))
        (i32.sub (local.get $count) (i32.const 1))))
      (local.set $base (i32.add (local.get $points) (i32.shl (local.get $index) (i32.const 3))))
      (local.set $p1x (i32.load (local.get $base)))
      (local.set $p1y (i32.load offset=4 (local.get $base)))
      (local.set $p2x (i32.load offset=8 (local.get $base)))
      (local.set $p2y (i32.load offset=12 (local.get $base)))
      (local.set $p3x (i32.load offset=16 (local.get $base)))
      (local.set $p3y (i32.load offset=20 (local.get $base)))
      (local.set $prev_x (local.get $p0x)) (local.set $prev_y (local.get $p0y))
      (local.set $step (i32.const 1))
      (block $steps_done (loop $steps
        (br_if $steps_done (i32.gt_u (local.get $step) (i32.const 32)))
        (local.set $x (call $gdi_bezier_point (local.get $p0x) (local.get $p1x)
          (local.get $p2x) (local.get $p3x) (local.get $step)))
        (local.set $y (call $gdi_bezier_point (local.get $p0y) (local.get $p1y)
          (local.get $p2y) (local.get $p3y) (local.get $step)))
        (if (i32.eqz (call $gdi_line_try (local.get $hdc)
              (local.get $prev_x) (local.get $prev_y) (local.get $x) (local.get $y)))
          (then (return (i32.const 0))))
        (local.set $prev_x (local.get $x)) (local.set $prev_y (local.get $y))
        (local.set $step (i32.add (local.get $step) (i32.const 1)))
        (br $steps)))
      (local.set $p0x (local.get $p3x)) (local.set $p0y (local.get $p3y))
      (local.set $index (i32.add (local.get $index) (i32.const 3)))
      (br $curves)))
    (if (local.get $from_current)
      (then
        (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 12) (local.get $p0x) (i32.const 0)))
        (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 16) (local.get $p0y) (i32.const 0)))))
    (i32.const 1))

  (func $gdi_poly_draw (param $hdc i32) (param $points i32)
        (param $types i32) (param $count i32) (result i32)
    (local $i i32) (local $p i32) (local $kind i32) (local $x i32) (local $y i32)
    (local $from_x i32) (local $from_y i32) (local $figure_x i32) (local $figure_y i32)
    (if (i32.or (i32.eqz (local.get $points))
          (i32.or (i32.eqz (local.get $types)) (i32.le_s (local.get $count) (i32.const 0))))
      (then (return (i32.const 0))))
    (local.set $from_x (call $gdi_dc_get_field (local.get $hdc) (i32.const 12) (i32.const 0)))
    (local.set $from_y (call $gdi_dc_get_field (local.get $hdc) (i32.const 16) (i32.const 0)))
    (local.set $figure_x (local.get $from_x))
    (local.set $figure_y (local.get $from_y))
    (block $done (loop $items
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $p (i32.add (local.get $points) (i32.shl (local.get $i) (i32.const 3))))
      (local.set $x (i32.load (local.get $p)))
      (local.set $y (i32.load offset=4 (local.get $p)))
      (local.set $kind (i32.and (i32.load8_u (i32.add (local.get $types) (local.get $i))) (i32.const 6)))
      (if (i32.eq (local.get $kind) (i32.const 6))
        (then
          (local.set $from_x (local.get $x)) (local.set $from_y (local.get $y))
          (local.set $figure_x (local.get $x)) (local.set $figure_y (local.get $y)))
        (else
          (if (i32.eq (local.get $kind) (i32.const 2))
            (then
              (if (i32.eqz (call $gdi_line_try (local.get $hdc)
                    (local.get $from_x) (local.get $from_y) (local.get $x) (local.get $y)))
                (then (return (i32.const 0))))
              (local.set $from_x (local.get $x)) (local.set $from_y (local.get $y)))
            (else
              (if (i32.eq (local.get $kind) (i32.const 4))
                (then
                  (if (i32.gt_u (i32.add (local.get $i) (i32.const 2))
                        (i32.sub (local.get $count) (i32.const 1)))
                    (then (return (i32.const 0))))
                  (if (i32.or
                        (i32.ne (i32.and (i32.load8_u (i32.add (local.get $types)
                          (i32.add (local.get $i) (i32.const 1)))) (i32.const 6)) (i32.const 4))
                        (i32.ne (i32.and (i32.load8_u (i32.add (local.get $types)
                          (i32.add (local.get $i) (i32.const 2)))) (i32.const 6)) (i32.const 4)))
                    (then (return (i32.const 0))))
                  (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 12)
                    (local.get $from_x) (i32.const 0)))
                  (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 16)
                    (local.get $from_y) (i32.const 0)))
                  (if (i32.eqz (call $gdi_poly_bezier
                        (local.get $hdc) (local.get $p) (i32.const 3) (i32.const 1)))
                    (then (return (i32.const 0))))
                  (local.set $i (i32.add (local.get $i) (i32.const 2)))
                  (local.set $p (i32.add (local.get $points) (i32.shl (local.get $i) (i32.const 3))))
                  (local.set $from_x (i32.load (local.get $p)))
                  (local.set $from_y (i32.load offset=4 (local.get $p))))
                (else (return (i32.const 0))))))))
      (if (i32.ne (i32.and (i32.load8_u (i32.add (local.get $types) (local.get $i)))
            (i32.const 1)) (i32.const 0))
        (then
          (if (i32.eqz (call $gdi_line_try (local.get $hdc)
                (local.get $from_x) (local.get $from_y)
                (local.get $figure_x) (local.get $figure_y)))
            (then (return (i32.const 0))))
          (local.set $from_x (local.get $figure_x)) (local.set $from_y (local.get $figure_y))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $items)))
    (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 12) (local.get $from_x) (i32.const 0)))
    (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 16) (local.get $from_y) (i32.const 0)))
    (i32.const 1))

  (func $gdi_arc (param $hdc i32) (param $left i32) (param $top i32)
        (param $right i32) (param $bottom i32) (param $start_x i32) (param $start_y i32)
        (param $end_x i32) (param $end_y i32) (param $to_mode i32) (result i32)
    (local $cx f64) (local $cy f64) (local $rx f64) (local $ry f64)
    (local $a0 f64) (local $a1 f64) (local $span f64) (local $a f64)
    (local $step i32) (local $x i32) (local $y i32) (local $px i32) (local $py i32)
    (if (i32.or (i32.eq (local.get $left) (local.get $right))
          (i32.eq (local.get $top) (local.get $bottom))) (then (return (i32.const 0))))
    (local.set $cx (f64.div (f64.convert_i32_s (i32.add (local.get $left) (local.get $right))) (f64.const 2)))
    (local.set $cy (f64.div (f64.convert_i32_s (i32.add (local.get $top) (local.get $bottom))) (f64.const 2)))
    (local.set $rx (f64.abs (f64.div (f64.convert_i32_s (i32.sub (local.get $right) (local.get $left))) (f64.const 2))))
    (local.set $ry (f64.abs (f64.div (f64.convert_i32_s (i32.sub (local.get $bottom) (local.get $top))) (f64.const 2))))
    (local.set $a0 (call $host_math_atan2
      (f64.div (f64.sub (f64.convert_i32_s (local.get $start_y)) (local.get $cy)) (local.get $ry))
      (f64.div (f64.sub (f64.convert_i32_s (local.get $start_x)) (local.get $cx)) (local.get $rx))))
    (local.set $a1 (call $host_math_atan2
      (f64.div (f64.sub (f64.convert_i32_s (local.get $end_y)) (local.get $cy)) (local.get $ry))
      (f64.div (f64.sub (f64.convert_i32_s (local.get $end_x)) (local.get $cx)) (local.get $rx))))
    (local.set $span (f64.sub (local.get $a1) (local.get $a0)))
    (if (i32.eq (call $gdi_dc_aux_get (local.get $hdc) (i32.const 4) (i32.const 1)) (i32.const 2))
      (then
        (if (f64.ge (local.get $span) (f64.const 0))
          (then (local.set $span (f64.sub (local.get $span) (f64.const 6.283185307179586))))))
      (else
        (if (f64.le (local.get $span) (f64.const 0))
          (then (local.set $span (f64.add (local.get $span) (f64.const 6.283185307179586)))))))
    (local.set $px (i32.trunc_f64_s (f64.nearest (f64.add (local.get $cx)
      (f64.mul (local.get $rx) (call $host_math_sin (f64.add (local.get $a0) (f64.const 1.5707963267948966))))))))
    (local.set $py (i32.trunc_f64_s (f64.nearest (f64.add (local.get $cy)
      (f64.mul (local.get $ry) (call $host_math_sin (local.get $a0)))))))
    (if (local.get $to_mode)
      (then
        (if (i32.eqz (call $gdi_line_try (local.get $hdc)
              (call $gdi_dc_get_field (local.get $hdc) (i32.const 12) (i32.const 0))
              (call $gdi_dc_get_field (local.get $hdc) (i32.const 16) (i32.const 0))
              (local.get $px) (local.get $py)))
          (then (return (i32.const 0))))))
    (local.set $step (i32.const 1))
    (block $done (loop $segments
      (br_if $done (i32.gt_u (local.get $step) (i32.const 64)))
      (local.set $a (f64.add (local.get $a0)
        (f64.mul (local.get $span) (f64.div (f64.convert_i32_u (local.get $step)) (f64.const 64)))))
      (local.set $x (i32.trunc_f64_s (f64.nearest (f64.add (local.get $cx)
        (f64.mul (local.get $rx) (call $host_math_sin (f64.add (local.get $a) (f64.const 1.5707963267948966))))))))
      (local.set $y (i32.trunc_f64_s (f64.nearest (f64.add (local.get $cy)
        (f64.mul (local.get $ry) (call $host_math_sin (local.get $a)))))))
      (if (i32.eqz (call $gdi_line_try
            (local.get $hdc) (local.get $px) (local.get $py) (local.get $x) (local.get $y)))
        (then (return (i32.const 0))))
      (local.set $px (local.get $x)) (local.set $py (local.get $y))
      (local.set $step (i32.add (local.get $step) (i32.const 1)))
      (br $segments)))
    (if (local.get $to_mode)
      (then
        (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 12) (local.get $px) (i32.const 0)))
        (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 16) (local.get $py) (i32.const 0)))))
    (i32.const 1))

  (func $gdi_scroll_window (param $hwnd i32) (param $dx i32) (param $dy i32)
        (param $scroll_rect i32) (param $clip_rect i32) (result i32)
    (local $hdc i32) (local $size i32) (local $left i32) (local $top i32)
    (local $right i32) (local $bottom i32) (local $src_x i32) (local $src_y i32)
    (local $dst_x i32) (local $dst_y i32) (local $copy_w i32) (local $copy_h i32)
    (local $desc i32)
    (if (i32.eqz (local.get $hwnd)) (then (return (i32.const 0))))
    (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x00040000)))
    (local.set $size (call $gdi_dc_target_size (local.get $hdc)))
    (local.set $right (i32.and (local.get $size) (i32.const 0xFFFF)))
    (local.set $bottom (i32.shr_u (local.get $size) (i32.const 16)))
    (if (local.get $scroll_rect)
      (then
        (local.set $left (i32.load (local.get $scroll_rect)))
        (local.set $top (i32.load offset=4 (local.get $scroll_rect)))
        (local.set $right (i32.load offset=8 (local.get $scroll_rect)))
        (local.set $bottom (i32.load offset=12 (local.get $scroll_rect)))))
    (if (local.get $clip_rect)
      (then
        (local.set $left (select (i32.load (local.get $clip_rect)) (local.get $left)
          (i32.lt_s (local.get $left) (i32.load (local.get $clip_rect)))))
        (local.set $top (select (i32.load offset=4 (local.get $clip_rect)) (local.get $top)
          (i32.lt_s (local.get $top) (i32.load offset=4 (local.get $clip_rect)))))
        (local.set $right (select (i32.load offset=8 (local.get $clip_rect)) (local.get $right)
          (i32.gt_s (local.get $right) (i32.load offset=8 (local.get $clip_rect)))))
        (local.set $bottom (select (i32.load offset=12 (local.get $clip_rect)) (local.get $bottom)
          (i32.gt_s (local.get $bottom) (i32.load offset=12 (local.get $clip_rect)))))))
    (if (i32.lt_s (local.get $left) (i32.const 0)) (then (local.set $left (i32.const 0))))
    (if (i32.lt_s (local.get $top) (i32.const 0)) (then (local.set $top (i32.const 0))))
    (if (i32.gt_s (local.get $right) (i32.and (local.get $size) (i32.const 0xFFFF)))
      (then (local.set $right (i32.and (local.get $size) (i32.const 0xFFFF)))))
    (if (i32.gt_s (local.get $bottom) (i32.shr_u (local.get $size) (i32.const 16)))
      (then (local.set $bottom (i32.shr_u (local.get $size) (i32.const 16)))))
    (if (i32.or (i32.ge_s (local.get $left) (local.get $right))
          (i32.ge_s (local.get $top) (local.get $bottom)))
      (then (return (i32.const 1))))
    (local.set $copy_w (i32.sub (i32.sub (local.get $right) (local.get $left))
      (select (i32.sub (i32.const 0) (local.get $dx)) (local.get $dx)
        (i32.lt_s (local.get $dx) (i32.const 0)))))
    (local.set $copy_h (i32.sub (i32.sub (local.get $bottom) (local.get $top))
      (select (i32.sub (i32.const 0) (local.get $dy)) (local.get $dy)
        (i32.lt_s (local.get $dy) (i32.const 0)))))
    (if (i32.and (i32.gt_s (local.get $copy_w) (i32.const 0))
          (i32.gt_s (local.get $copy_h) (i32.const 0)))
      (then
        (local.set $src_x (i32.add (local.get $left)
          (select (i32.sub (i32.const 0) (local.get $dx)) (i32.const 0)
            (i32.lt_s (local.get $dx) (i32.const 0)))))
        (local.set $src_y (i32.add (local.get $top)
          (select (i32.sub (i32.const 0) (local.get $dy)) (i32.const 0)
            (i32.lt_s (local.get $dy) (i32.const 0)))))
        (local.set $dst_x (i32.add (local.get $left)
          (select (local.get $dx) (i32.const 0) (i32.gt_s (local.get $dx) (i32.const 0)))))
        (local.set $dst_y (i32.add (local.get $top)
          (select (local.get $dy) (i32.const 0) (i32.gt_s (local.get $dy) (i32.const 0)))))
        (if (i32.eqz (call $gdi_hdc_bitblt
              (local.get $hdc) (local.get $dst_x) (local.get $dst_y)
              (local.get $copy_w) (local.get $copy_h) (local.get $hdc)
              (local.get $src_x) (local.get $src_y) (i32.const 0x00CC0020)))
          (then (return (i32.const 0))))))
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const 0))))
    ;; Win98 exposes the vacated strips in the window background color. The
    ;; emulator's default client background is white; invalidate the same
    ;; bounds so application WM_PAINT can replace it immediately.
    (if (i32.gt_s (local.get $dx) (i32.const 0))
      (then (drop (call $gdi_fill_rect_desc (local.get $hdc) (local.get $desc)
        (local.get $left) (local.get $top)
        (select (local.get $right) (i32.add (local.get $left) (local.get $dx))
          (i32.gt_s (i32.add (local.get $left) (local.get $dx)) (local.get $right)))
        (local.get $bottom) (i32.const 0x30010)))))
    (if (i32.lt_s (local.get $dx) (i32.const 0))
      (then (drop (call $gdi_fill_rect_desc (local.get $hdc) (local.get $desc)
        (select (local.get $left) (i32.add (local.get $right) (local.get $dx))
          (i32.lt_s (i32.add (local.get $right) (local.get $dx)) (local.get $left)))
        (local.get $top) (local.get $right) (local.get $bottom) (i32.const 0x30010)))))
    (if (i32.gt_s (local.get $dy) (i32.const 0))
      (then (drop (call $gdi_fill_rect_desc (local.get $hdc) (local.get $desc)
        (local.get $left) (local.get $top) (local.get $right)
        (select (local.get $bottom) (i32.add (local.get $top) (local.get $dy))
          (i32.gt_s (i32.add (local.get $top) (local.get $dy)) (local.get $bottom)))
        (i32.const 0x30010)))))
    (if (i32.lt_s (local.get $dy) (i32.const 0))
      (then (drop (call $gdi_fill_rect_desc (local.get $hdc) (local.get $desc)
        (local.get $left) (select (local.get $top) (i32.add (local.get $bottom) (local.get $dy))
          (i32.lt_s (i32.add (local.get $bottom) (local.get $dy)) (local.get $top)))
        (local.get $right) (local.get $bottom) (i32.const 0x30010)))))
    (call $update_invalidate_rect (local.get $hwnd)
      (local.get $left) (local.get $top) (local.get $right) (local.get $bottom))
    (call $paint_flag_set (local.get $hwnd))
    (call $host_invalidate (local.get $hwnd))
    (i32.const 1))

  (func (export "test_gdi_rectangle_desc")
        (param i32) (param i32) (param i32) (param i32) (param i32)
        (param i32) (param i32) (param i32) (param i32) (result i32)
    (call $gdi_rectangle_desc (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (local.get 4) (local.get 5) (local.get 6) (local.get 7) (local.get 8)))
  (func (export "test_gdi_ellipse_desc")
        (param i32) (param i32) (param i32) (param i32) (param i32)
        (param i32) (param i32) (param i32) (param i32) (result i32)
    (call $gdi_ellipse_desc (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (local.get 4) (local.get 5) (local.get 6) (local.get 7) (local.get 8)))
  (func (export "test_gdi_round_rect_desc")
        (param i32) (param i32) (param i32) (param i32) (param i32)
        (param i32) (param i32) (param i32) (param i32) (param i32) (param i32) (result i32)
    (call $gdi_round_rect_desc (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (local.get 4) (local.get 5) (local.get 6) (local.get 7) (local.get 8)
      (local.get 9) (local.get 10)))
  (func (export "test_gdi_poly_bezier")
        (param i32) (param i32) (param i32) (param i32) (result i32)
    (call $gdi_poly_bezier (local.get 0) (local.get 1) (local.get 2) (local.get 3)))
  (func (export "test_gdi_arc")
        (param i32) (param i32) (param i32) (param i32) (param i32)
        (param i32) (param i32) (param i32) (param i32) (result i32)
    (call $gdi_arc (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (local.get 4) (local.get 5) (local.get 6) (local.get 7) (local.get 8) (i32.const 0)))
  (func (export "test_gdi_scroll_window")
        (param i32) (param i32) (param i32) (param i32) (param i32) (result i32)
    (call $gdi_scroll_window
      (local.get 0) (local.get 1) (local.get 2) (local.get 3) (local.get 4)))

  ;; Side-effect-free admission check used to make multi-segment paths atomic:
  ;; every segment must be supported before the first pixel is changed.
  (func $gdi_line_can_raster (param $hdc i32) (param $from_x i32) (param $from_y i32)
        (param $to_x i32) (param $to_y i32) (result i32)
    (local $desc i32) (local $x0 i32) (local $y0 i32) (local $x1 i32) (local $y1 i32)
    (local $dx i32) (local $dy i32) (local $span i32) (local $pen_width i32)
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_line_descriptor_supported (local.get $desc)))
      (then (return (i32.const 0))))
    (local.set $x0 (call $gdi_line_map_x (local.get $desc) (local.get $from_x)))
    (local.set $y0 (call $gdi_line_map_y (local.get $desc) (local.get $from_y)))
    (local.set $x1 (call $gdi_line_map_x (local.get $desc) (local.get $to_x)))
    (local.set $y1 (call $gdi_line_map_y (local.get $desc) (local.get $to_y)))
    (local.set $dx (select (i32.sub (local.get $x1) (local.get $x0))
      (i32.sub (local.get $x0) (local.get $x1)) (i32.ge_s (local.get $x1) (local.get $x0))))
    (local.set $dy (select (i32.sub (local.get $y1) (local.get $y0))
      (i32.sub (local.get $y0) (local.get $y1)) (i32.ge_s (local.get $y1) (local.get $y0))))
    (local.set $span (select (local.get $dx) (local.get $dy)
      (i32.ge_u (local.get $dx) (local.get $dy))))
    (if (i32.gt_u (local.get $span) (i32.const 65536))
      (then (return (i32.const 0))))
    (local.set $pen_width (i32.load offset=28 (local.get $desc)))
    ;; Non-idempotent ROP2 modes are safe for the captured axis-aligned
    ;; width-2..5 region because that path writes each covered pixel once.
    (if (i32.and (i32.gt_u (local.get $pen_width) (i32.const 1))
          (i32.and (i32.ne (call $gdi_dc_get_rop2 (local.get $hdc)) (i32.const 13))
            (i32.or
              (i32.or (i32.lt_u (local.get $pen_width) (i32.const 2))
                (i32.gt_u (local.get $pen_width) (i32.const 5)))
              (i32.and (i32.ne (local.get $x0) (local.get $x1))
                (i32.ne (local.get $y0) (local.get $y1))))))
      (then (return (i32.const 0))))
    (if (i64.gt_u (i64.mul (i64.extend_i32_u (local.get $span))
          (i64.mul (i64.extend_i32_u (local.get $pen_width))
            (i64.extend_i32_u (local.get $pen_width))))
        (i64.const 4000000))
      (then (return (i32.const 0))))
    (i32.const 1))

  ;; Returns 1 when WAT handled the line and 0 when the caller must use the
  ;; named Canvas compatibility path. Like Win32 LineTo, the final endpoint is
  ;; not painted.
  (func $gdi_line_try (param $hdc i32) (param $from_x i32) (param $from_y i32)
        (param $to_x i32) (param $to_y i32) (result i32)
    (local $desc i32) (local $x0 i32) (local $y0 i32) (local $x1 i32) (local $y1 i32)
    (local $dx i32) (local $dy i32) (local $sx i32) (local $sy i32)
    (local $err i32) (local $e2 i32) (local $rop2 i32) (local $wrote i32)
    (local $min_x i32) (local $min_y i32) (local $max_x i32) (local $max_y i32)
    (local $pen_width i32) (local $stamp_x i32) (local $stamp_y i32)
    (local $stamp_left i32) (local $stamp_top i32) (local $pixel_x i32) (local $pixel_y i32)
    (local $pen_style i32)
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_line_descriptor_supported (local.get $desc)))
      (then (return (i32.const 0))))
    (local.set $x0 (call $gdi_line_map_x (local.get $desc) (local.get $from_x)))
    (local.set $y0 (call $gdi_line_map_y (local.get $desc) (local.get $from_y)))
    (local.set $x1 (call $gdi_line_map_x (local.get $desc) (local.get $to_x)))
    (local.set $y1 (call $gdi_line_map_y (local.get $desc) (local.get $to_y)))
    (if (i32.and (i32.eq (local.get $x0) (local.get $x1))
          (i32.eq (local.get $y0) (local.get $y1)))
      (then (return (i32.const 1))))
    (local.set $min_x (i32.const 0x7FFFFFFF)) (local.set $min_y (i32.const 0x7FFFFFFF))
    (local.set $max_x (i32.const 0x80000000)) (local.set $max_y (i32.const 0x80000000))
    (local.set $rop2 (call $gdi_dc_get_rop2 (local.get $hdc)))
    (local.set $pen_width (i32.load offset=28 (local.get $desc)))
    (local.set $pen_style (i32.load offset=64 (local.get $desc)))
    (if (call $gdi_axis_wide_line_desc (local.get $hdc) (local.get $desc)
          (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1)
          (local.get $pen_width) (i32.load offset=24 (local.get $desc))
          (local.get $rop2))
      (then (return (i32.const 1))))
    ;; Repeated square stamps are exact for COPYPEN because the operation is
    ;; idempotent. Other ROP2 modes need a coverage mask before wide strokes
    ;; can safely avoid applying the Boolean operation twice.
    (if (i32.and (i32.gt_u (local.get $pen_width) (i32.const 1))
          (i32.ne (local.get $rop2) (i32.const 13)))
      (then (return (i32.const 0))))
    (if (i32.ge_s (local.get $x1) (local.get $x0))
      (then (local.set $dx (i32.sub (local.get $x1) (local.get $x0))) (local.set $sx (i32.const 1)))
      (else (local.set $dx (i32.sub (local.get $x0) (local.get $x1))) (local.set $sx (i32.const -1))))
    (if (i32.ge_s (local.get $y1) (local.get $y0))
      (then (local.set $dy (i32.sub (local.get $y0) (local.get $y1))) (local.set $sy (i32.const 1)))
      (else (local.set $dy (i32.sub (local.get $y1) (local.get $y0))) (local.set $sy (i32.const -1))))
    ;; Avoid an unbounded walk for pathological off-screen coordinates. The
    ;; compatibility path receives the untouched request before any pixel is
    ;; written. Normal GDI surfaces are far below this span.
    (if (i32.or (i32.gt_u (local.get $dx) (i32.const 65536))
          (i32.gt_u (i32.sub (i32.const 0) (local.get $dy)) (i32.const 65536)))
      (then (return (i32.const 0))))
    ;; Bound stamp work as well as line length. Very large wide strokes stay on
    ;; the compatibility path until geometric clipping can reduce them first.
    (if (i64.gt_u
          (i64.mul
            (i64.extend_i32_u (select (local.get $dx)
              (i32.sub (i32.const 0) (local.get $dy))
              (i32.gt_u (local.get $dx) (i32.sub (i32.const 0) (local.get $dy)))))
            (i64.mul (i64.extend_i32_u (local.get $pen_width))
              (i64.extend_i32_u (local.get $pen_width))))
          (i64.const 4000000))
      (then (return (i32.const 0))))
    (local.set $err (i32.add (local.get $dx) (local.get $dy)))
    (block $done (loop $pixels
      (br_if $done (i32.and (i32.eq (local.get $x0) (local.get $x1))
        (i32.eq (local.get $y0) (local.get $y1))))
      (if (call $gdi_pen_style_draw (local.get $pen_style) (global.get $gdi_line_style_phase))
        (then
          (local.set $stamp_left (i32.sub (local.get $x0)
            (i32.shr_u (local.get $pen_width) (i32.const 1))))
          (local.set $stamp_top (i32.sub (local.get $y0)
            (i32.shr_u (local.get $pen_width) (i32.const 1))))
          (local.set $stamp_y (i32.const 0))
          (block $stamp_rows_done (loop $stamp_rows
            (br_if $stamp_rows_done (i32.ge_u (local.get $stamp_y) (local.get $pen_width)))
            (local.set $pixel_y (i32.add (local.get $stamp_top) (local.get $stamp_y)))
            (local.set $stamp_x (i32.const 0))
            (block $stamp_cols_done (loop $stamp_cols
              (br_if $stamp_cols_done (i32.ge_u (local.get $stamp_x) (local.get $pen_width)))
              (local.set $pixel_x (i32.add (local.get $stamp_left) (local.get $stamp_x)))
              (if (call $gdi_line_put_pixel (local.get $hdc) (local.get $desc)
                    (local.get $pixel_x) (local.get $pixel_y) (local.get $rop2))
                (then
                  (local.set $wrote (i32.const 1))
                  (if (i32.lt_s (local.get $pixel_x) (local.get $min_x))
                    (then (local.set $min_x (local.get $pixel_x))))
                  (if (i32.lt_s (local.get $pixel_y) (local.get $min_y))
                    (then (local.set $min_y (local.get $pixel_y))))
                  (if (i32.gt_s (local.get $pixel_x) (local.get $max_x))
                    (then (local.set $max_x (local.get $pixel_x))))
                  (if (i32.gt_s (local.get $pixel_y) (local.get $max_y))
                    (then (local.set $max_y (local.get $pixel_y))))))
              (local.set $stamp_x (i32.add (local.get $stamp_x) (i32.const 1)))
              (br $stamp_cols)))
            (local.set $stamp_y (i32.add (local.get $stamp_y) (i32.const 1)))
            (br $stamp_rows)))))
      (global.set $gdi_line_style_phase
        (i32.add (global.get $gdi_line_style_phase) (i32.const 1)))
      (local.set $e2 (i32.shl (local.get $err) (i32.const 1)))
      (if (i32.ge_s (local.get $e2) (local.get $dy))
        (then (local.set $err (i32.add (local.get $err) (local.get $dy)))
          (local.set $x0 (i32.add (local.get $x0) (local.get $sx)))))
      (if (i32.le_s (local.get $e2) (local.get $dx))
        (then (local.set $err (i32.add (local.get $err) (local.get $dx)))
          (local.set $y0 (i32.add (local.get $y0) (local.get $sy)))))
      (br $pixels)))
    (if (local.get $wrote)
      (then (drop (call $host_gdi_surface_upload (i32.load offset=68 (local.get $desc))
        (local.get $min_x) (local.get $min_y)
        (i32.add (local.get $max_x) (i32.const 1))
        (i32.add (local.get $max_y) (i32.const 1))))))
    (i32.const 1))

  ;; Draws an open point path after preflighting every segment. from_current=0
  ;; implements Polyline; from_current=1 implements PolylineTo.
  (func $gdi_polyline_try (param $hdc i32) (param $points i32)
        (param $count i32) (param $from_current i32) (result i32)
    (local $i i32) (local $from_x i32) (local $from_y i32)
    (local $to_x i32) (local $to_y i32)
    (if (i32.or (i32.gt_u (local.get $count) (i32.const 4096))
          (select (i32.eqz (local.get $count)) (i32.lt_u (local.get $count) (i32.const 2))
            (local.get $from_current)))
      (then (return (i32.const 0))))
    (if (local.get $from_current)
      (then
        (local.set $from_x (call $gdi_dc_get_field
          (local.get $hdc) (i32.const 12) (i32.const 0)))
        (local.set $from_y (call $gdi_dc_get_field
          (local.get $hdc) (i32.const 16) (i32.const 0))))
      (else
        (local.set $from_x (i32.load (local.get $points)))
        (local.set $from_y (i32.load offset=4 (local.get $points)))
        (local.set $i (i32.const 1))))
    ;; Admission pass: no raster memory changes are allowed here.
    (block $preflight_done (loop $preflight
      (br_if $preflight_done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $to_x (i32.load (i32.add (local.get $points) (i32.shl (local.get $i) (i32.const 3)))))
      (local.set $to_y (i32.load offset=4
        (i32.add (local.get $points) (i32.shl (local.get $i) (i32.const 3)))))
      (if (i32.eqz (call $gdi_line_can_raster (local.get $hdc)
            (local.get $from_x) (local.get $from_y) (local.get $to_x) (local.get $to_y)))
        (then (return (i32.const 0))))
      (local.set $from_x (local.get $to_x)) (local.set $from_y (local.get $to_y))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $preflight)))
    (global.set $gdi_line_style_phase (i32.const 0))
    (if (local.get $from_current)
      (then
        (local.set $from_x (call $gdi_dc_get_field
          (local.get $hdc) (i32.const 12) (i32.const 0)))
        (local.set $from_y (call $gdi_dc_get_field
          (local.get $hdc) (i32.const 16) (i32.const 0)))
        (local.set $i (i32.const 0)))
      (else
        (local.set $from_x (i32.load (local.get $points)))
        (local.set $from_y (i32.load offset=4 (local.get $points)))
        (local.set $i (i32.const 1))))
    (block $draw_done (loop $draw
      (br_if $draw_done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $to_x (i32.load (i32.add (local.get $points) (i32.shl (local.get $i) (i32.const 3)))))
      (local.set $to_y (i32.load offset=4
        (i32.add (local.get $points) (i32.shl (local.get $i) (i32.const 3)))))
      (drop (call $gdi_line_try (local.get $hdc)
        (local.get $from_x) (local.get $from_y) (local.get $to_x) (local.get $to_y)))
      (local.set $from_x (local.get $to_x)) (local.set $from_y (local.get $to_y))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $draw)))
    (i32.const 1))

  ;; PolyPolyline preserves each sub-polyline boundary and never updates the
  ;; DC current position. Preflight the entire call before changing pixels so
  ;; a malformed later count cannot leave an earlier path partially drawn.
  (func $gdi_poly_polyline_try (param $hdc i32) (param $points i32)
        (param $counts i32) (param $poly_count i32) (result i32)
    (local $poly i32) (local $point_index i32) (local $count i32) (local $i i32)
    (local $from i32) (local $to i32)
    (if (i32.or (i32.eqz (local.get $points))
          (i32.or (i32.eqz (local.get $counts))
            (i32.or (i32.eqz (local.get $poly_count))
              (i32.gt_u (local.get $poly_count) (i32.const 4096)))))
      (then (return (i32.const 0))))
    (block $preflight_done (loop $preflight_polys
      (br_if $preflight_done (i32.ge_u (local.get $poly) (local.get $poly_count)))
      (local.set $count
        (i32.load (i32.add (local.get $counts) (i32.shl (local.get $poly) (i32.const 2)))))
      (if (i32.or (i32.lt_u (local.get $count) (i32.const 2))
            (i32.gt_u (local.get $count)
              (i32.sub (i32.const 4096) (local.get $point_index))))
        (then (return (i32.const 0))))
      (local.set $i (i32.const 1))
      (block $segments_done (loop $preflight_segments
        (br_if $segments_done (i32.ge_u (local.get $i) (local.get $count)))
        (local.set $from (i32.add (local.get $points)
          (i32.shl (i32.add (local.get $point_index)
            (i32.sub (local.get $i) (i32.const 1))) (i32.const 3))))
        (local.set $to (i32.add (local.get $points)
          (i32.shl (i32.add (local.get $point_index) (local.get $i)) (i32.const 3))))
        (if (i32.eqz (call $gdi_line_can_raster (local.get $hdc)
              (i32.load (local.get $from)) (i32.load offset=4 (local.get $from))
              (i32.load (local.get $to)) (i32.load offset=4 (local.get $to))))
          (then (return (i32.const 0))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $preflight_segments)))
      (local.set $point_index (i32.add (local.get $point_index) (local.get $count)))
      (local.set $poly (i32.add (local.get $poly) (i32.const 1)))
      (br $preflight_polys)))
    (local.set $poly (i32.const 0))
    (local.set $point_index (i32.const 0))
    (block $draw_done (loop $draw_polys
      (br_if $draw_done (i32.ge_u (local.get $poly) (local.get $poly_count)))
      (local.set $count
        (i32.load (i32.add (local.get $counts) (i32.shl (local.get $poly) (i32.const 2)))))
      (global.set $gdi_line_style_phase (i32.const 0))
      (local.set $i (i32.const 1))
      (block $poly_done (loop $draw_segments
        (br_if $poly_done (i32.ge_u (local.get $i) (local.get $count)))
        (local.set $from (i32.add (local.get $points)
          (i32.shl (i32.add (local.get $point_index)
            (i32.sub (local.get $i) (i32.const 1))) (i32.const 3))))
        (local.set $to (i32.add (local.get $points)
          (i32.shl (i32.add (local.get $point_index) (local.get $i)) (i32.const 3))))
        (drop (call $gdi_line_try (local.get $hdc)
          (i32.load (local.get $from)) (i32.load offset=4 (local.get $from))
          (i32.load (local.get $to)) (i32.load offset=4 (local.get $to))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $draw_segments)))
      (local.set $point_index (i32.add (local.get $point_index) (local.get $count)))
      (local.set $poly (i32.add (local.get $poly) (i32.const 1)))
      (br $draw_polys)))
    (i32.const 1))

  (func (export "test_gdi_line_try")
        (param i32) (param i32) (param i32) (param i32) (param i32) (result i32)
    (local $result i32)
    (global.set $gdi_line_style_phase (i32.const 0))
    (local.set $result (call $gdi_line_try
      (local.get 0) (local.get 1) (local.get 2) (local.get 3) (local.get 4)))
    (local.get $result))
  (func (export "test_gdi_polyline_try")
        (param i32) (param i32) (param i32) (param i32) (result i32)
    (local $result i32)
    (local.set $result (call $gdi_polyline_try
      (local.get 0) (local.get 1) (local.get 2) (local.get 3)))
    (local.get $result))
  (func (export "test_gdi_current_pos_set") (param i32) (param i32) (param i32)
    (drop (call $gdi_dc_set_field (local.get 0) (i32.const 12) (local.get 1) (i32.const 0)))
    (drop (call $gdi_dc_set_field (local.get 0) (i32.const 16) (local.get 2) (i32.const 0))))
  (func (export "test_gdi_dc_set_rop2") (param i32) (param i32) (result i32)
    (local $result i32)
    (local.set $result (call $gdi_dc_set_rop2 (local.get 0) (local.get 1)))
    (local.get $result))
  (func (export "test_gdi_dc_get_rop2") (param i32) (result i32)
    (local $result i32)
    (local.set $result (call $gdi_dc_get_rop2 (local.get 0)))
    (local.get $result))
  (func (export "test_gdi_apply_rop2")
        (param i32) (param i32) (param i32) (result i32)
    (local $result i32)
    (local.set $result (call $gdi_apply_rop2
      (local.get 0) (local.get 1) (local.get 2)))
    (local.get $result))

  ;; ---- WAT software pixel/blit kernels --------------------------------
  ;; These consume the canonical 80-byte surface descriptor emitted by
  ;; $gdi_surface_descriptor. Only offsets 0..20 are required here:
  ;; {bits, width, height, stride, bpp, topDown}. Indexed palette metadata is
  ;; resolved from the canonical bitmap record named by surfaceId at +68.
  (global $gdi_fast_span_hits (mut i32) (i32.const 0))
  (global $gdi_fast_bitblt_hits (mut i32) (i32.const 0))
  (global $gdi_fast_stretch_hits (mut i32) (i32.const 0))

  ;; Return 1 for no clip, a canonical record for a single rectangle, or 0
  ;; when exact rasterization still requires per-pixel region membership.
  (func $gdi_raster_simple_clip_record (param $clip i32) (result i32)
    (local $record i32)
    (if (i32.eqz (local.get $clip)) (then (return (i32.const 1))))
    (local.set $record (call $gdi_rgn_record (local.get $clip)))
    (if (i32.or (i32.eqz (local.get $record))
          (i32.gt_u (i32.load offset=28 (local.get $record)) (i32.const 1)))
      (then (return (i32.const 0))))
    (local.get $record))

  (func $gdi_raster_app_clip_record (param $hdc i32) (result i32)
    (local $entry i32)
    (local.set $entry (call $gdi_dc_clip_entry (local.get $hdc) (i32.const 0)))
    (call $gdi_raster_simple_clip_record
      (if (result i32) (i32.ne (local.get $entry) (i32.const 0))
        (then (i32.load offset=4 (local.get $entry)))
        (else (i32.const 0)))))

  (func $gdi_raster_system_clip_record (param $hdc i32) (result i32)
    (call $gdi_raster_simple_clip_record
      (call $gdi_dc_system_clip_handle (local.get $hdc))))

  (func $gdi_raster_clip_bound (param $record i32) (param $desc i32)
        (param $side i32) (param $fallback i32) (result i32)
    (if (i32.le_u (local.get $record) (i32.const 1))
      (then (return (local.get $fallback))))
    (i32.add
      (i32.load (i32.add (local.get $record)
        (i32.add (i32.const 8) (i32.shl (local.get $side) (i32.const 2)))))
      (select
        (i32.load offset=72 (local.get $desc))
        (i32.load offset=76 (local.get $desc))
        (i32.eqz (i32.and (local.get $side) (i32.const 1))))))
  (func $gdi_raster_surface_valid (param $desc i32) (result i32)
    (i32.and (i32.ne (local.get $desc) (i32.const 0))
      (i32.and (i32.ne (i32.load (local.get $desc)) (i32.const 0))
        (i32.and
          (i32.and (i32.gt_s (i32.load offset=4 (local.get $desc)) (i32.const 0))
            (i32.gt_s (i32.load offset=8 (local.get $desc)) (i32.const 0)))
          (i32.or
            (i32.or (i32.eq (i32.load offset=16 (local.get $desc)) (i32.const 1))
              (i32.eq (i32.load offset=16 (local.get $desc)) (i32.const 4)))
            (i32.or (i32.eq (i32.load offset=16 (local.get $desc)) (i32.const 8))
              (i32.or (i32.eq (i32.load offset=16 (local.get $desc)) (i32.const 16))
                (i32.or (i32.eq (i32.load offset=16 (local.get $desc)) (i32.const 24))
                  (i32.eq (i32.load offset=16 (local.get $desc)) (i32.const 32))))))))))

  (func $gdi_raster_row_ptr_32 (param $desc i32) (param $x i32) (param $y i32)
        (result i32)
    (local $row i32)
    (local.set $row (select (local.get $y)
      (i32.sub (i32.sub (i32.load offset=8 (local.get $desc)) (i32.const 1)) (local.get $y))
      (i32.ne (i32.load offset=20 (local.get $desc)) (i32.const 0))))
    (i32.add (i32.load (local.get $desc))
      (i32.add (i32.mul (local.get $row) (i32.load offset=12 (local.get $desc)))
        (i32.shl (local.get $x) (i32.const 2)))))

  ;; Return one COLORREF for solid/system/stock brushes, or a value above the
  ;; COLORREF range when sampling must remain per pixel.
  (func $gdi_brush_solid_color (param $brush i32) (result i32)
    (local $record i32)
    (if (i32.and (i32.ge_u (local.get $brush) (i32.const 1))
          (i32.le_u (local.get $brush) (i32.const 23)))
      (then (return (call $gdi_chrome_sys_color
        (i32.sub (local.get $brush) (i32.const 1))))))
    (if (i32.and (i32.ge_u (local.get $brush) (i32.const 0x30010))
          (i32.le_u (local.get $brush) (i32.const 0x30014)))
      (then (return (call $gdi_stock_object_color (local.get $brush)))))
    (local.set $record (call $gdi_object_record (local.get $brush)))
    (if (i32.and (i32.ne (local.get $record) (i32.const 0))
          (i32.and (i32.eq (i32.load offset=4 (local.get $record)) (i32.const 2))
            (i32.eqz (i32.load offset=8 (local.get $record)))))
      (then (return (i32.and (i32.load offset=16 (local.get $record))
        (i32.const 0xFFFFFF)))))
    (i32.const 0x01000000))

  (func $gdi_raster_pixel_ptr (param $desc i32) (param $x i32) (param $y i32) (result i32)
    (local $row i32) (local $bpp i32) (local $offset i32)
    (if (i32.eqz (call $gdi_raster_surface_valid (local.get $desc)))
      (then (return (i32.const 0))))
    (if (i32.or
          (i32.or (i32.lt_s (local.get $x) (i32.const 0))
            (i32.ge_s (local.get $x) (i32.load offset=4 (local.get $desc))))
          (i32.or (i32.lt_s (local.get $y) (i32.const 0))
            (i32.ge_s (local.get $y) (i32.load offset=8 (local.get $desc)))))
      (then (return (i32.const 0))))
    (local.set $row (select (local.get $y)
      (i32.sub (i32.sub (i32.load offset=8 (local.get $desc)) (i32.const 1)) (local.get $y))
      (i32.ne (i32.load offset=20 (local.get $desc)) (i32.const 0))))
    (local.set $bpp (i32.load offset=16 (local.get $desc)))
    (local.set $offset
      (if (result i32) (i32.eq (local.get $bpp) (i32.const 1))
        (then (i32.shr_u (local.get $x) (i32.const 3)))
        (else (if (result i32) (i32.eq (local.get $bpp) (i32.const 4))
          (then (i32.shr_u (local.get $x) (i32.const 1)))
          (else (i32.mul (local.get $x)
            (i32.shr_u (local.get $bpp) (i32.const 3))))))))
    (i32.add (i32.load (local.get $desc))
      (i32.add (i32.mul (local.get $row) (i32.load offset=12 (local.get $desc)))
        (local.get $offset))))

  ;; Return the stored palette index without resolving it to RGB. This is
  ;; needed by DIB_PAL_COLORS pattern brushes, whose WORD table is interpreted
  ;; against the logical palette of the destination DC at use time.
  (func $gdi_raster_read_index (param $desc i32) (param $x i32) (param $y i32)
        (result i32)
    (local $p i32) (local $bpp i32) (local $value i32)
    (local.set $p (call $gdi_raster_pixel_ptr
      (local.get $desc) (local.get $x) (local.get $y)))
    (if (i32.eqz (local.get $p)) (then (return (i32.const -1))))
    (local.set $bpp (i32.load offset=16 (local.get $desc)))
    (if (i32.eq (local.get $bpp) (i32.const 1))
      (then (return (i32.and
        (i32.shr_u (i32.load8_u (local.get $p))
          (i32.sub (i32.const 7) (i32.and (local.get $x) (i32.const 7))))
        (i32.const 1)))))
    (if (i32.eq (local.get $bpp) (i32.const 4))
      (then
        (local.set $value (i32.load8_u (local.get $p)))
        (return (select
          (i32.and (local.get $value) (i32.const 15))
          (i32.shr_u (local.get $value) (i32.const 4))
          (i32.and (local.get $x) (i32.const 1))))))
    (if (i32.eq (local.get $bpp) (i32.const 8))
      (then (return (i32.load8_u (local.get $p)))))
    (i32.const -1))

  (func $gdi_raster_default_palette (param $bpp i32) (param $index i32) (result i32)
    (if (i32.eq (local.get $bpp) (i32.const 1))
      (then (return (select (i32.const 0xFFFFFF) (i32.const 0) (local.get $index)))))
    (if (i32.eq (local.get $bpp) (i32.const 8))
      (then (return (i32.mul (i32.and (local.get $index) (i32.const 0xFF))
        (i32.const 0x010101)))))
    (local.set $index (i32.and (local.get $index) (i32.const 15)))
    (if (i32.eq (local.get $index) (i32.const 0)) (then (return (i32.const 0x000000))))
    (if (i32.eq (local.get $index) (i32.const 1)) (then (return (i32.const 0x800000))))
    (if (i32.eq (local.get $index) (i32.const 2)) (then (return (i32.const 0x008000))))
    (if (i32.eq (local.get $index) (i32.const 3)) (then (return (i32.const 0x808000))))
    (if (i32.eq (local.get $index) (i32.const 4)) (then (return (i32.const 0x000080))))
    (if (i32.eq (local.get $index) (i32.const 5)) (then (return (i32.const 0x800080))))
    (if (i32.eq (local.get $index) (i32.const 6)) (then (return (i32.const 0x008080))))
    (if (i32.eq (local.get $index) (i32.const 7)) (then (return (i32.const 0xC0C0C0))))
    (if (i32.eq (local.get $index) (i32.const 8)) (then (return (i32.const 0x808080))))
    (if (i32.eq (local.get $index) (i32.const 9)) (then (return (i32.const 0xFF0000))))
    (if (i32.eq (local.get $index) (i32.const 10)) (then (return (i32.const 0x00FF00))))
    (if (i32.eq (local.get $index) (i32.const 11)) (then (return (i32.const 0xFFFF00))))
    (if (i32.eq (local.get $index) (i32.const 12)) (then (return (i32.const 0x0000FF))))
    (if (i32.eq (local.get $index) (i32.const 13)) (then (return (i32.const 0xFF00FF))))
    (if (i32.eq (local.get $index) (i32.const 14)) (then (return (i32.const 0x00FFFF))))
    (i32.const 0xFFFFFF))

  (func $gdi_raster_palette_color (param $desc i32) (param $index i32) (result i32)
    (local $record i32) (local $palette i32) (local $count i32) (local $p i32)
    ;; DirectDraw palette storage is PALETTEENTRY (R,G,B,flags), not RGBQUAD.
    (if (i32.and
          (i32.ge_u (i32.load offset=68 (local.get $desc)) (i32.const 0x00200000))
          (i32.lt_u (i32.load offset=68 (local.get $desc)) (i32.const 0x00300000)))
      (then
        (local.set $palette (global.get $dx_primary_pal_wa))
        (if (i32.and (i32.ne (local.get $palette) (i32.const 0))
              (i32.lt_u (local.get $index) (i32.const 256)))
          (then
            (local.set $p (i32.add (local.get $palette)
              (i32.shl (local.get $index) (i32.const 2))))
            (return (i32.or (i32.load8_u offset=2 (local.get $p))
              (i32.or (i32.shl (i32.load8_u offset=1 (local.get $p)) (i32.const 8))
                (i32.shl (i32.load8_u (local.get $p)) (i32.const 16)))))))))
    (local.set $record (call $gdi_object_record (i32.load offset=68 (local.get $desc))))
    (if (local.get $record)
      (then
        (local.set $palette (i32.load offset=32 (local.get $record)))
        (local.set $count (i32.load offset=36 (local.get $record)))
        (if (i32.and (i32.ne (local.get $palette) (i32.const 0))
              (i32.lt_u (local.get $index) (local.get $count)))
          (then
            (local.set $p (i32.add (local.get $palette) (i32.shl (local.get $index) (i32.const 2))))
            (return (i32.or (i32.load8_u (local.get $p))
              (i32.or (i32.shl (i32.load8_u offset=1 (local.get $p)) (i32.const 8))
                (i32.shl (i32.load8_u offset=2 (local.get $p)) (i32.const 16)))))))))
    ;; Transient BITMAPINFO descriptors have no object handle. They carry the
    ;; RGBQUAD table directly in the otherwise geometry-only +24/+28 fields.
    (local.set $palette (i32.load offset=24 (local.get $desc)))
    (local.set $count (i32.load offset=28 (local.get $desc)))
    (if (i32.and (i32.ne (local.get $palette) (i32.const 0))
          (i32.lt_u (local.get $index) (local.get $count)))
      (then
        (local.set $p (i32.add (local.get $palette) (i32.shl (local.get $index) (i32.const 2))))
        (return (i32.or (i32.load8_u (local.get $p))
          (i32.or (i32.shl (i32.load8_u offset=1 (local.get $p)) (i32.const 8))
            (i32.shl (i32.load8_u offset=2 (local.get $p)) (i32.const 16)))))))
    (call $gdi_raster_default_palette (i32.load offset=16 (local.get $desc)) (local.get $index)))

  (func (export "test_gdi_raster_palette_color") (param i32 i32) (result i32)
    (call $gdi_raster_palette_color (local.get 0) (local.get 1)))

  (func $gdi_raster_nearest_index (param $desc i32) (param $color i32) (result i32)
    (local $bpp i32) (local $count i32) (local $i i32) (local $candidate i32)
    (local $dr i64) (local $dg i64) (local $db i64) (local $distance i64)
    (local $best_distance i64) (local $best i32)
    (local.set $bpp (i32.load offset=16 (local.get $desc)))
    (local.set $count (i32.shl (i32.const 1) (local.get $bpp)))
    (if (i32.and (i32.ne (i32.load offset=24 (local.get $desc)) (i32.const 0))
          (i32.ne (i32.load offset=28 (local.get $desc)) (i32.const 0)))
      (then
        (if (i32.lt_u (i32.load offset=28 (local.get $desc)) (local.get $count))
          (then (local.set $count (i32.load offset=28 (local.get $desc)))))))
    (local.set $best_distance (i64.const 0x7FFFFFFFFFFFFFFF))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $candidate (call $gdi_raster_palette_color (local.get $desc) (local.get $i)))
      (local.set $dr (i64.extend_i32_s (i32.sub
        (i32.and (i32.shr_u (local.get $color) (i32.const 16)) (i32.const 0xFF))
        (i32.and (i32.shr_u (local.get $candidate) (i32.const 16)) (i32.const 0xFF)))))
      (local.set $dg (i64.extend_i32_s (i32.sub
        (i32.and (i32.shr_u (local.get $color) (i32.const 8)) (i32.const 0xFF))
        (i32.and (i32.shr_u (local.get $candidate) (i32.const 8)) (i32.const 0xFF)))))
      (local.set $db (i64.extend_i32_s (i32.sub
        (i32.and (local.get $color) (i32.const 0xFF))
        (i32.and (local.get $candidate) (i32.const 0xFF)))))
      (local.set $distance (i64.add (i64.mul (local.get $dr) (local.get $dr))
        (i64.add (i64.mul (local.get $dg) (local.get $dg))
          (i64.mul (local.get $db) (local.get $db)))))
      (if (i64.lt_u (local.get $distance) (local.get $best_distance))
        (then
          (local.set $best_distance (local.get $distance))
          (local.set $best (local.get $i))
          (if (i64.eqz (local.get $distance)) (then (return (local.get $i))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $best))

  ;; Packed raster colors are 0x00RRGGBB; COLORREF is 0x00BBGGRR.
  (func $gdi_raster_swap_rb (param $color i32) (result i32)
    (i32.or
      (i32.or (i32.shl (i32.and (local.get $color) (i32.const 0xFF)) (i32.const 16))
        (i32.and (local.get $color) (i32.const 0xFF00)))
      (i32.and (i32.shr_u (local.get $color) (i32.const 16)) (i32.const 0xFF))))

  (func $gdi_color_mask_contiguous (param $mask i32) (result i32)
    (local $low i32)
    (if (i32.or (i32.eqz (local.get $mask))
          (i32.ne (i32.and (local.get $mask) (i32.const 0xFFFF0000)) (i32.const 0)))
      (then (return (i32.const 0))))
    (local.set $low (i32.and (local.get $mask)
      (i32.sub (i32.const 0) (local.get $mask))))
    (i32.eqz (i32.and (i32.add (local.get $mask) (local.get $low))
      (local.get $mask))))

  (func $gdi_color_masks_valid (param $masks i32) (result i32)
    (local $r i32) (local $g i32) (local $b i32)
    (if (i32.eqz (local.get $masks)) (then (return (i32.const 0))))
    (local.set $r (i32.load (local.get $masks)))
    (local.set $g (i32.load offset=4 (local.get $masks)))
    (local.set $b (i32.load offset=8 (local.get $masks)))
    (i32.and
      (i32.and (call $gdi_color_mask_contiguous (local.get $r))
        (call $gdi_color_mask_contiguous (local.get $g)))
      (i32.and (call $gdi_color_mask_contiguous (local.get $b))
        (i32.eqz (i32.or
          (i32.and (local.get $r) (local.get $g))
          (i32.or (i32.and (local.get $r) (local.get $b))
            (i32.and (local.get $g) (local.get $b))))))))

  ;; Resolve one RGB channel mask for a 16-bpp descriptor. Bitmap-backed DIBs
  ;; own a three-DWORD table in record +32/+36. Transient BITMAPINFO sources
  ;; use descriptor +24/+28/+64. DirectDraw is explicitly RGB565; all other
  ;; maskless 16-bpp DIB descriptors use Win32 BI_RGB RGB555.
  (func $gdi_raster_channel_mask (param $desc i32) (param $channel i32) (result i32)
    (local $record i32) (local $masks i32) (local $surface i32)
    (local.set $surface (i32.load offset=68 (local.get $desc)))
    (local.set $record (call $gdi_object_record (local.get $surface)))
    (if (i32.and (i32.ne (local.get $record) (i32.const 0))
          (i32.and (i32.eq (i32.load offset=16 (local.get $record)) (i32.const 16))
            (i32.eq (i32.load offset=36 (local.get $record)) (i32.const 3))))
      (then
        (local.set $masks (i32.load offset=32 (local.get $record)))
        (if (call $gdi_color_masks_valid (local.get $masks))
          (then (return (i32.load (i32.add (local.get $masks)
            (i32.shl (local.get $channel) (i32.const 2)))))))))
    (if (i32.and (i32.eqz (local.get $surface))
          (i32.and (i32.ne (i32.load offset=24 (local.get $desc)) (i32.const 0))
            (i32.and (i32.ne (i32.load offset=28 (local.get $desc)) (i32.const 0))
              (i32.ne (i32.load offset=64 (local.get $desc)) (i32.const 0)))))
      (then
        (return (select (i32.load offset=64 (local.get $desc))
          (select (i32.load offset=24 (local.get $desc))
            (i32.load offset=28 (local.get $desc))
            (i32.eq (local.get $channel) (i32.const 0)))
          (i32.eq (local.get $channel) (i32.const 2))))))
    (if (i32.and (i32.ge_u (local.get $surface) (i32.const 0x00200000))
          (i32.lt_u (local.get $surface) (i32.const 0x00300000)))
      (then (return (select (i32.const 0x001F)
        (select (i32.const 0xF800) (i32.const 0x07E0)
          (i32.eq (local.get $channel) (i32.const 0)))
        (i32.eq (local.get $channel) (i32.const 2))))))
    (i32.load (i32.add (global.get $GDI_RGB555_MASKS)
      (i32.shl (local.get $channel) (i32.const 2)))))

  (func $gdi_raster_unpack_channel (param $value i32) (param $mask i32) (result i32)
    (local $shift i32) (local $max i32) (local $channel i32)
    (local.set $shift (i32.ctz (local.get $mask)))
    (local.set $max (i32.sub (i32.shl (i32.const 1) (i32.popcnt (local.get $mask)))
      (i32.const 1)))
    (local.set $channel (i32.shr_u (i32.and (local.get $value) (local.get $mask))
      (local.get $shift)))
    (i32.div_u (i32.add (i32.mul (local.get $channel) (i32.const 255))
      (i32.shr_u (local.get $max) (i32.const 1))) (local.get $max)))

  (func $gdi_raster_pack_channel (param $channel i32) (param $mask i32) (result i32)
    (local $max i32)
    (local.set $max (i32.sub (i32.shl (i32.const 1) (i32.popcnt (local.get $mask)))
      (i32.const 1)))
    (i32.and (i32.shl
      (i32.div_u (i32.add (i32.mul (i32.and (local.get $channel) (i32.const 0xFF))
        (local.get $max)) (i32.const 127)) (i32.const 255))
      (i32.ctz (local.get $mask))) (local.get $mask)))

  (func $gdi_raster_read (param $desc i32) (param $x i32) (param $y i32) (result i32)
    (local $p i32) (local $bpp i32) (local $value i32)
    (local $r_mask i32) (local $g_mask i32) (local $b_mask i32)
    (local.set $p (call $gdi_raster_pixel_ptr (local.get $desc) (local.get $x) (local.get $y)))
    (if (i32.eqz (local.get $p)) (then (return (i32.const -1))))
    (local.set $bpp (i32.load offset=16 (local.get $desc)))
    (if (i32.eq (local.get $bpp) (i32.const 1))
      (then (return (call $gdi_raster_palette_color (local.get $desc)
        (i32.and (i32.shr_u (i32.load8_u (local.get $p))
          (i32.sub (i32.const 7) (i32.and (local.get $x) (i32.const 7)))) (i32.const 1))))))
    (if (i32.eq (local.get $bpp) (i32.const 4))
      (then
        (local.set $value (i32.load8_u (local.get $p)))
        (return (call $gdi_raster_palette_color (local.get $desc)
          (select (i32.and (local.get $value) (i32.const 15))
            (i32.shr_u (local.get $value) (i32.const 4))
            (i32.and (local.get $x) (i32.const 1)))))))
    (if (i32.eq (local.get $bpp) (i32.const 8))
      (then (return (call $gdi_raster_palette_color
        (local.get $desc) (i32.load8_u (local.get $p))))))
    (if (i32.eq (local.get $bpp) (i32.const 16))
      (then
        (local.set $value (i32.load16_u (local.get $p)))
        (local.set $r_mask (call $gdi_raster_channel_mask (local.get $desc) (i32.const 0)))
        (local.set $g_mask (call $gdi_raster_channel_mask (local.get $desc) (i32.const 1)))
        (local.set $b_mask (call $gdi_raster_channel_mask (local.get $desc) (i32.const 2)))
        (return (i32.or
          (i32.shl (call $gdi_raster_unpack_channel
            (local.get $value) (local.get $r_mask)) (i32.const 16))
          (i32.or
            (i32.shl (call $gdi_raster_unpack_channel
              (local.get $value) (local.get $g_mask)) (i32.const 8))
            (call $gdi_raster_unpack_channel
              (local.get $value) (local.get $b_mask)))))))
    (i32.or (i32.load8_u (local.get $p))
      (i32.or (i32.shl (i32.load8_u offset=1 (local.get $p)) (i32.const 8))
        (i32.shl (i32.load8_u offset=2 (local.get $p)) (i32.const 16)))))

  ;; A monochrome DDB is a mask when copied into a color DC: zero bits use
  ;; the destination text color and one bits use its background color.  A
  ;; 1-bpp DIB keeps using its explicit color table instead.
  (func $gdi_raster_read_blt_source (param $dst_hdc i32) (param $src_hdc i32)
        (param $dst i32) (param $src i32) (param $x i32) (param $y i32) (result i32)
    (local $record i32) (local $p i32) (local $bit i32) (local $color i32)
    ;; A color DDB copied into a monochrome DDB is keyed against the source
    ;; DC background color.  Matching pixels become white; all others become
    ;; black before the raster operation is evaluated.  Classic Win32 icon
    ;; drawing (including Paint's tool palette) relies on this to build masks.
    (if (i32.and
          (i32.and (i32.ne (local.get $src_hdc) (i32.const 0))
            (i32.eq (i32.load offset=16 (local.get $dst)) (i32.const 1)))
          (i32.ne (i32.load offset=16 (local.get $src)) (i32.const 1)))
      (then
        (local.set $record (call $gdi_object_record (i32.load offset=68 (local.get $dst))))
        (if (i32.and (i32.ne (local.get $record) (i32.const 0))
              (i32.eqz (i32.and (i32.load offset=20 (local.get $record)) (i32.const 1))))
          (then
            (local.set $color (call $gdi_raster_read
              (local.get $src) (local.get $x) (local.get $y)))
            (if (i32.eq (local.get $color) (i32.const -1))
              (then (return (i32.const -1))))
            (return (select (i32.const 0xFFFFFF) (i32.const 0)
              (i32.eq (local.get $color) (call $gdi_raster_swap_rb
                (call $gdi_dc_get_field
                  (local.get $src_hdc) (i32.const 24) (i32.const 0xFFFFFF))))))))))
    (if (i32.and
          (i32.and (i32.ne (local.get $dst_hdc) (i32.const 0))
            (i32.ne (i32.load offset=16 (local.get $dst)) (i32.const 1)))
          (i32.eq (i32.load offset=16 (local.get $src)) (i32.const 1)))
      (then
        (local.set $record (call $gdi_object_record (i32.load offset=68 (local.get $src))))
        (if (i32.and (i32.ne (local.get $record) (i32.const 0))
              (i32.eqz (i32.and (i32.load offset=20 (local.get $record)) (i32.const 1))))
          (then
            (local.set $p (call $gdi_raster_pixel_ptr
              (local.get $src) (local.get $x) (local.get $y)))
            (if (i32.eqz (local.get $p)) (then (return (i32.const -1))))
            (local.set $bit (i32.and
              (i32.shr_u (i32.load8_u (local.get $p))
                (i32.sub (i32.const 7) (i32.and (local.get $x) (i32.const 7))))
              (i32.const 1)))
            (local.set $color (call $gdi_dc_get_field (local.get $dst_hdc)
              (select (i32.const 24) (i32.const 20) (local.get $bit))
              (select (i32.const 0xFFFFFF) (i32.const 0) (local.get $bit))))
            (return (call $gdi_raster_swap_rb (local.get $color)))))))
    (call $gdi_raster_read (local.get $src) (local.get $x) (local.get $y)))

  (func $gdi_raster_write (param $desc i32) (param $x i32) (param $y i32)
        (param $color i32) (result i32)
    (local $p i32) (local $bpp i32) (local $index i32) (local $old i32)
    (local $r_mask i32) (local $g_mask i32) (local $b_mask i32)
    (local.set $p (call $gdi_raster_pixel_ptr (local.get $desc) (local.get $x) (local.get $y)))
    (if (i32.eqz (local.get $p)) (then (return (i32.const 0))))
    (local.set $bpp (i32.load offset=16 (local.get $desc)))
    (if (i32.le_u (local.get $bpp) (i32.const 8))
      (then
        (local.set $index (call $gdi_raster_nearest_index (local.get $desc) (local.get $color)))
        (if (i32.eq (local.get $bpp) (i32.const 1))
          (then
            (local.set $old (i32.load8_u (local.get $p)))
            (local.set $index (i32.shl (i32.const 1)
              (i32.sub (i32.const 7) (i32.and (local.get $x) (i32.const 7)))))
            (i32.store8 (local.get $p) (select
              (i32.or (local.get $old) (local.get $index))
              (i32.and (local.get $old) (i32.xor (local.get $index) (i32.const 0xFF)))
              (call $gdi_raster_nearest_index (local.get $desc) (local.get $color)))))
          (else (if (i32.eq (local.get $bpp) (i32.const 4))
            (then
              (local.set $old (i32.load8_u (local.get $p)))
              (i32.store8 (local.get $p)
                (select (i32.or (i32.and (local.get $old) (i32.const 0xF0)) (local.get $index))
                  (i32.or (i32.and (local.get $old) (i32.const 0x0F))
                    (i32.shl (local.get $index) (i32.const 4)))
                  (i32.and (local.get $x) (i32.const 1)))))
            (else (i32.store8 (local.get $p) (local.get $index))))))
        (return (i32.const 1))))
    (if (i32.eq (local.get $bpp) (i32.const 16))
      (then
        (local.set $r_mask (call $gdi_raster_channel_mask (local.get $desc) (i32.const 0)))
        (local.set $g_mask (call $gdi_raster_channel_mask (local.get $desc) (i32.const 1)))
        (local.set $b_mask (call $gdi_raster_channel_mask (local.get $desc) (i32.const 2)))
        (i32.store16 (local.get $p) (i32.or
          (call $gdi_raster_pack_channel
            (i32.shr_u (local.get $color) (i32.const 16)) (local.get $r_mask))
          (i32.or (call $gdi_raster_pack_channel
              (i32.shr_u (local.get $color) (i32.const 8)) (local.get $g_mask))
            (call $gdi_raster_pack_channel
              (local.get $color) (local.get $b_mask)))))
        (return (i32.const 1))))
    (i32.store8 (local.get $p) (local.get $color))
    (i32.store8 offset=1 (local.get $p) (i32.shr_u (local.get $color) (i32.const 8)))
    (i32.store8 offset=2 (local.get $p) (i32.shr_u (local.get $color) (i32.const 16)))
    (if (i32.eq (i32.load offset=16 (local.get $desc)) (i32.const 32))
      (then (i32.store8 offset=3 (local.get $p) (i32.const 0))))
    (i32.const 1))

  (func $gdi_raster_get_pixel (param $desc i32) (param $x i32) (param $y i32) (result i32)
    (local $value i32)
    (local.set $value (call $gdi_raster_read (local.get $desc) (local.get $x) (local.get $y)))
    (if (i32.eq (local.get $value) (i32.const -1)) (then (return (i32.const -1))))
    (call $gdi_raster_swap_rb (local.get $value)))

  (func $gdi_raster_set_pixel (param $desc i32) (param $x i32) (param $y i32)
        (param $colorref i32) (result i32)
    (if (i32.eqz (call $gdi_raster_write (local.get $desc) (local.get $x) (local.get $y)
          (call $gdi_raster_swap_rb (local.get $colorref))))
      (then (return (i32.const -1))))
    (i32.and (local.get $colorref) (i32.const 0xFFFFFF)))

  ;; Bounded four-connected flood fill over authoritative WAT pixels. The
  ;; visited bitmap makes progress independent of the selected brush color.
  (func $gdi_raster_flood_fill (param $hdc i32) (param $desc i32)
        (param $logical_x i32) (param $logical_y i32) (param $colorref i32)
        (param $fill_type i32) (param $brush i32) (result i32)
    (local $width i32) (local $height i32) (local $area i32)
    (local $start_x i32) (local $start_y i32) (local $match i32) (local $fill i32)
    (local $queue_g i32) (local $queue i32) (local $visited_g i32) (local $visited i32)
    (local $visited_size i32) (local $head i32) (local $tail i32)
    (local $x i32) (local $y i32) (local $nx i32) (local $ny i32)
    (local $index i32) (local $mask i32) (local $value i32)
    (local $direction i32) (local $eligible i32)
    (local $min_x i32) (local $min_y i32) (local $max_x i32) (local $max_y i32)
    (if (i32.or (i32.eqz (call $gdi_raster_surface_valid (local.get $desc)))
          (i32.gt_u (local.get $fill_type) (i32.const 1)))
      (then (return (i32.const 0))))
    (local.set $width (i32.load offset=4 (local.get $desc)))
    (local.set $height (i32.load offset=8 (local.get $desc)))
    (local.set $area (i32.mul (local.get $width) (local.get $height)))
    (if (i32.or (i32.eqz (local.get $area))
          (i32.gt_u (local.get $area) (i32.const 4000000)))
      (then (return (i32.const 0))))
    (local.set $start_x (call $gdi_line_map_x (local.get $desc) (local.get $logical_x)))
    (local.set $start_y (call $gdi_line_map_y (local.get $desc) (local.get $logical_y)))
    (if (i32.or (i32.eq (call $gdi_raster_read
            (local.get $desc) (local.get $start_x) (local.get $start_y)) (i32.const -1))
          (i32.eqz (call $gdi_raster_clip_visible
            (local.get $hdc) (local.get $desc) (local.get $start_x) (local.get $start_y))))
      (then (return (i32.const 0))))
    (local.set $match (call $gdi_raster_swap_rb (local.get $colorref)))
    (if (i32.eqz (call $gdi_brush_valid (local.get $brush)))
      (then (return (i32.const 0))))
    (local.set $value (call $gdi_raster_read
      (local.get $desc) (local.get $start_x) (local.get $start_y)))
    (if (i32.or
          (i32.and (i32.eqz (local.get $fill_type)) (i32.eq (local.get $value) (local.get $match)))
          (i32.and (i32.eq (local.get $fill_type) (i32.const 1))
            (i32.ne (local.get $value) (local.get $match))))
      (then (return (i32.const 0))))
    (local.set $visited_size (i32.shr_u (i32.add (local.get $area) (i32.const 7)) (i32.const 3)))
    (local.set $visited_g (call $heap_alloc (local.get $visited_size)))
    (if (i32.eqz (local.get $visited_g)) (then (return (i32.const 0))))
    (local.set $queue_g (call $heap_alloc (i32.shl (local.get $area) (i32.const 3))))
    (if (i32.eqz (local.get $queue_g))
      (then (call $heap_free (local.get $visited_g)) (return (i32.const 0))))
    (local.set $visited (call $g2w (local.get $visited_g)))
    (local.set $queue (call $g2w (local.get $queue_g)))
    (memory.fill (local.get $visited) (i32.const 0) (local.get $visited_size))
    (local.set $index (i32.add (i32.mul (local.get $start_y) (local.get $width)) (local.get $start_x)))
    (i32.store8 (i32.add (local.get $visited) (i32.shr_u (local.get $index) (i32.const 3)))
      (i32.shl (i32.const 1) (i32.and (local.get $index) (i32.const 7))))
    (i32.store (local.get $queue) (local.get $start_x))
    (i32.store offset=4 (local.get $queue) (local.get $start_y))
    (local.set $tail (i32.const 1))
    (local.set $min_x (local.get $start_x))
    (local.set $min_y (local.get $start_y))
    (local.set $max_x (local.get $start_x))
    (local.set $max_y (local.get $start_y))
    (block $done (loop $work
      (br_if $done (i32.ge_u (local.get $head) (local.get $tail)))
      (local.set $x (i32.load (i32.add (local.get $queue) (i32.shl (local.get $head) (i32.const 3)))))
      (local.set $y (i32.load offset=4 (i32.add (local.get $queue) (i32.shl (local.get $head) (i32.const 3)))))
      (local.set $head (i32.add (local.get $head) (i32.const 1)))
      (local.set $fill (call $gdi_brush_sample
        (local.get $hdc) (local.get $brush) (local.get $x) (local.get $y)))
      (if (i32.le_u (local.get $fill) (i32.const 0xFFFFFF))
        (then (drop (call $gdi_raster_write
          (local.get $desc) (local.get $x) (local.get $y)
          (call $gdi_raster_swap_rb (local.get $fill))))))
      (local.set $min_x (select (local.get $x) (local.get $min_x) (i32.lt_s (local.get $x) (local.get $min_x))))
      (local.set $min_y (select (local.get $y) (local.get $min_y) (i32.lt_s (local.get $y) (local.get $min_y))))
      (local.set $max_x (select (local.get $x) (local.get $max_x) (i32.gt_s (local.get $x) (local.get $max_x))))
      (local.set $max_y (select (local.get $y) (local.get $max_y) (i32.gt_s (local.get $y) (local.get $max_y))))
      (local.set $direction (i32.const 0))
      (block $neighbors_done (loop $neighbors
        (br_if $neighbors_done (i32.ge_u (local.get $direction) (i32.const 4)))
        (local.set $nx (local.get $x))
        (local.set $ny (local.get $y))
        (if (i32.eq (local.get $direction) (i32.const 0)) (then (local.set $nx (i32.sub (local.get $x) (i32.const 1)))))
        (if (i32.eq (local.get $direction) (i32.const 1)) (then (local.set $nx (i32.add (local.get $x) (i32.const 1)))))
        (if (i32.eq (local.get $direction) (i32.const 2)) (then (local.set $ny (i32.sub (local.get $y) (i32.const 1)))))
        (if (i32.eq (local.get $direction) (i32.const 3)) (then (local.set $ny (i32.add (local.get $y) (i32.const 1)))))
        (if (i32.and
              (i32.and (i32.ge_s (local.get $nx) (i32.const 0))
                (i32.lt_s (local.get $nx) (local.get $width)))
              (i32.and (i32.ge_s (local.get $ny) (i32.const 0))
                (i32.lt_s (local.get $ny) (local.get $height))))
          (then
            (local.set $index (i32.add (i32.mul (local.get $ny) (local.get $width)) (local.get $nx)))
            (local.set $mask (i32.shl (i32.const 1) (i32.and (local.get $index) (i32.const 7))))
            (if (i32.eqz (i32.and
                  (i32.load8_u (i32.add (local.get $visited) (i32.shr_u (local.get $index) (i32.const 3))))
                  (local.get $mask)))
              (then
                (local.set $value (call $gdi_raster_read
                  (local.get $desc) (local.get $nx) (local.get $ny)))
                (local.set $eligible (select
                  (i32.ne (local.get $value) (local.get $match))
                  (i32.eq (local.get $value) (local.get $match))
                  (i32.eqz (local.get $fill_type))))
                (if (i32.and (local.get $eligible)
                      (call $gdi_raster_clip_visible
                        (local.get $hdc) (local.get $desc) (local.get $nx) (local.get $ny)))
                  (then
                    (i32.store8
                      (i32.add (local.get $visited) (i32.shr_u (local.get $index) (i32.const 3)))
                      (i32.or (i32.load8_u
                        (i32.add (local.get $visited) (i32.shr_u (local.get $index) (i32.const 3))))
                        (local.get $mask)))
                    (i32.store (i32.add (local.get $queue) (i32.shl (local.get $tail) (i32.const 3)))
                      (local.get $nx))
                    (i32.store offset=4 (i32.add (local.get $queue) (i32.shl (local.get $tail) (i32.const 3)))
                      (local.get $ny))
                    (local.set $tail (i32.add (local.get $tail) (i32.const 1)))))))))
        (local.set $direction (i32.add (local.get $direction) (i32.const 1)))
        (br $neighbors)))
      (br $work)))
    (call $heap_free (local.get $queue_g))
    (call $heap_free (local.get $visited_g))
    (call $gdi_geometry_present (local.get $hdc) (local.get $desc)
      (local.get $min_x) (local.get $min_y)
      (i32.add (local.get $max_x) (i32.const 1)) (i32.add (local.get $max_y) (i32.const 1)))
    (i32.const 1))

  ;; Full ternary raster-operation truth table. Bit index is P:S:D, which
  ;; makes SRCCOPY 0xCC, PATCOPY 0xF0, and DSTINVERT 0x55.
  (func $gdi_apply_rop3 (param $rop3 i32) (param $pattern i32)
        (param $source i32) (param $dest i32) (result i32)
    (local $i i32) (local $term i32) (local $value i32)
    (local.set $pattern (i32.and (local.get $pattern) (i32.const 0xFFFFFF)))
    (local.set $source (i32.and (local.get $source) (i32.const 0xFFFFFF)))
    (local.set $dest (i32.and (local.get $dest) (i32.const 0xFFFFFF)))
    (block $done (loop $each
      (br_if $done (i32.ge_u (local.get $i) (i32.const 8)))
      (if (i32.and (local.get $rop3) (i32.shl (i32.const 1) (local.get $i)))
        (then
          (local.set $term (select (local.get $pattern)
            (i32.xor (local.get $pattern) (i32.const 0xFFFFFF))
            (i32.and (local.get $i) (i32.const 4))))
          (local.set $term (i32.and (local.get $term) (select (local.get $source)
            (i32.xor (local.get $source) (i32.const 0xFFFFFF))
            (i32.and (local.get $i) (i32.const 2)))))
          (local.set $term (i32.and (local.get $term) (select (local.get $dest)
            (i32.xor (local.get $dest) (i32.const 0xFFFFFF))
            (i32.and (local.get $i) (i32.const 1)))))
          (local.set $value (i32.or (local.get $value) (local.get $term)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $each)))
    (i32.and (local.get $value) (i32.const 0xFFFFFF)))

  (func $gdi_rop3_uses_source (param $rop3 i32) (result i32)
    (i32.ne (i32.and
      (i32.xor (local.get $rop3) (i32.shr_u (local.get $rop3) (i32.const 2)))
      (i32.const 0x33)) (i32.const 0)))

  (func $gdi_rop3_uses_pattern (param $rop3 i32) (result i32)
    (i32.ne (i32.and
      (i32.xor (local.get $rop3) (i32.shr_u (local.get $rop3) (i32.const 4)))
      (i32.const 0x0F)) (i32.const 0)))

  ;; Return -1 when the generic format/region path is required, otherwise 1.
  ;; Direct XRGB loops preserve the generic kernel's zeroed reserved byte.
  (func $gdi_raster_bitblt_fast32 (param $hdc i32)
        (param $dst i32) (param $dx i32) (param $dy i32)
        (param $w i32) (param $h i32) (param $src i32) (param $sx i32) (param $sy i32)
        (param $pattern i32) (param $brush i32) (param $rop3 i32) (result i32)
    (local $x0 i32) (local $y0 i32) (local $x1 i32) (local $y1 i32)
    (local $x i32) (local $y i32) (local $limit i32) (local $size i32)
    (local $dp i32) (local $sp i32) (local $s i32) (local $d i32) (local $value i32)
    (local $color i32) (local $source_mode i32)
    (local $app_clip i32) (local $system_clip i32) (local $bound i32)
    (local.set $app_clip (call $gdi_raster_app_clip_record (local.get $hdc)))
    (local.set $system_clip (call $gdi_raster_system_clip_record (local.get $hdc)))
    (if (i32.or (i32.ne (i32.load offset=16 (local.get $dst)) (i32.const 32))
          (i32.or (i32.eqz (local.get $app_clip)) (i32.eqz (local.get $system_clip))))
      (then (return (i32.const -1))))
    (if (i32.or (i32.gt_u (local.get $w) (i32.const 0x0000FFFF))
          (i32.or (i32.gt_u (local.get $h) (i32.const 0x0000FFFF))
            (i32.or
              (i32.or (i32.lt_s (local.get $dx) (i32.const -1073741823))
                (i32.gt_s (local.get $dx) (i32.const 1073741823)))
              (i32.or (i32.lt_s (local.get $dy) (i32.const -1073741823))
                (i32.gt_s (local.get $dy) (i32.const 1073741823))))))
      (then (return (i32.const -1))))
    (local.set $source_mode (i32.or
      (i32.or (i32.eq (local.get $rop3) (i32.const 0xCC))
        (i32.eq (local.get $rop3) (i32.const 0x33)))
      (i32.or (i32.eq (local.get $rop3) (i32.const 0x66))
        (i32.or (i32.eq (local.get $rop3) (i32.const 0x88))
          (i32.eq (local.get $rop3) (i32.const 0xEE))))))
    (if (local.get $source_mode)
      (then
        (if (i32.or
              (i32.or (i32.lt_s (local.get $sx) (i32.const -1073741823))
                (i32.gt_s (local.get $sx) (i32.const 1073741823)))
              (i32.or (i32.lt_s (local.get $sy) (i32.const -1073741823))
                (i32.gt_s (local.get $sy) (i32.const 1073741823))))
          (then (return (i32.const -1))))
        (if (i32.or (i32.eqz (local.get $src))
              (i32.ne (i32.load offset=16 (local.get $src)) (i32.const 32)))
          (then (return (i32.const -1))))
        ;; Overlap requires direction-aware semantics; retain the proven generic
        ;; traversal until a row-level memmove path covers every orientation.
        (if (i32.eq (i32.load (local.get $dst)) (i32.load (local.get $src)))
          (then (return (i32.const -1)))))
      (else
        (if (i32.eqz (i32.or
              (i32.or (i32.eq (local.get $rop3) (i32.const 0x00))
                (i32.eq (local.get $rop3) (i32.const 0xFF)))
              (i32.or (i32.eq (local.get $rop3) (i32.const 0x55))
                (i32.eq (local.get $rop3) (i32.const 0xF0)))))
          (then (return (i32.const -1))))))
    (if (i32.eq (local.get $rop3) (i32.const 0xF0))
      (then
        (if (local.get $brush)
          (then
            (local.set $color (call $gdi_brush_solid_color (local.get $brush)))
            (if (i32.gt_u (local.get $color) (i32.const 0xFFFFFF))
              (then (return (i32.const -1))))
            (local.set $pattern (call $gdi_raster_swap_rb (local.get $color)))))
        (local.set $pattern (i32.and (local.get $pattern) (i32.const 0xFFFFFF)))))
    (local.set $x1 (local.get $w))
    (local.set $y1 (local.get $h))
    (if (i32.lt_s (local.get $dx) (i32.const 0))
      (then (local.set $x0 (i32.sub (i32.const 0) (local.get $dx)))))
    (if (i32.lt_s (local.get $dy) (i32.const 0))
      (then (local.set $y0 (i32.sub (i32.const 0) (local.get $dy)))))
    (local.set $limit (i32.sub (i32.load offset=4 (local.get $dst)) (local.get $dx)))
    (if (i32.lt_s (local.get $limit) (local.get $x1)) (then (local.set $x1 (local.get $limit))))
    (local.set $limit (i32.sub (i32.load offset=8 (local.get $dst)) (local.get $dy)))
    (if (i32.lt_s (local.get $limit) (local.get $y1)) (then (local.set $y1 (local.get $limit))))
    ;; A window/client DC can target a subrectangle inside the shared top-level
    ;; surface. Intersect that finite default clip even when no region is set.
    (local.set $size (call $gdi_dc_target_size (local.get $hdc)))
    (if (local.get $size)
      (then
        (local.set $limit (i32.sub (i32.load offset=72 (local.get $dst)) (local.get $dx)))
        (if (i32.gt_s (local.get $limit) (local.get $x0)) (then (local.set $x0 (local.get $limit))))
        (local.set $limit (i32.sub
          (i32.add (i32.load offset=72 (local.get $dst))
            (i32.and (local.get $size) (i32.const 0xFFFF))) (local.get $dx)))
        (if (i32.lt_s (local.get $limit) (local.get $x1)) (then (local.set $x1 (local.get $limit))))
        (local.set $limit (i32.sub (i32.load offset=76 (local.get $dst)) (local.get $dy)))
        (if (i32.gt_s (local.get $limit) (local.get $y0)) (then (local.set $y0 (local.get $limit))))
        (local.set $limit (i32.sub
          (i32.add (i32.load offset=76 (local.get $dst))
            (i32.shr_u (local.get $size) (i32.const 16))) (local.get $dy)))
        (if (i32.lt_s (local.get $limit) (local.get $y1)) (then (local.set $y1 (local.get $limit))))))
    (local.set $bound (call $gdi_raster_clip_bound
      (local.get $app_clip) (local.get $dst) (i32.const 0) (i32.const -1073741824)))
    (local.set $limit (i32.sub (local.get $bound) (local.get $dx)))
    (if (i32.gt_s (local.get $limit) (local.get $x0)) (then (local.set $x0 (local.get $limit))))
    (local.set $bound (call $gdi_raster_clip_bound
      (local.get $system_clip) (local.get $dst) (i32.const 0) (i32.const -1073741824)))
    (local.set $limit (i32.sub (local.get $bound) (local.get $dx)))
    (if (i32.gt_s (local.get $limit) (local.get $x0)) (then (local.set $x0 (local.get $limit))))
    (local.set $bound (call $gdi_raster_clip_bound
      (local.get $app_clip) (local.get $dst) (i32.const 1) (i32.const -1073741824)))
    (local.set $limit (i32.sub (local.get $bound) (local.get $dy)))
    (if (i32.gt_s (local.get $limit) (local.get $y0)) (then (local.set $y0 (local.get $limit))))
    (local.set $bound (call $gdi_raster_clip_bound
      (local.get $system_clip) (local.get $dst) (i32.const 1) (i32.const -1073741824)))
    (local.set $limit (i32.sub (local.get $bound) (local.get $dy)))
    (if (i32.gt_s (local.get $limit) (local.get $y0)) (then (local.set $y0 (local.get $limit))))
    (local.set $bound (call $gdi_raster_clip_bound
      (local.get $app_clip) (local.get $dst) (i32.const 2) (i32.const 1073741823)))
    (local.set $limit (i32.sub (local.get $bound) (local.get $dx)))
    (if (i32.lt_s (local.get $limit) (local.get $x1)) (then (local.set $x1 (local.get $limit))))
    (local.set $bound (call $gdi_raster_clip_bound
      (local.get $system_clip) (local.get $dst) (i32.const 2) (i32.const 1073741823)))
    (local.set $limit (i32.sub (local.get $bound) (local.get $dx)))
    (if (i32.lt_s (local.get $limit) (local.get $x1)) (then (local.set $x1 (local.get $limit))))
    (local.set $bound (call $gdi_raster_clip_bound
      (local.get $app_clip) (local.get $dst) (i32.const 3) (i32.const 1073741823)))
    (local.set $limit (i32.sub (local.get $bound) (local.get $dy)))
    (if (i32.lt_s (local.get $limit) (local.get $y1)) (then (local.set $y1 (local.get $limit))))
    (local.set $bound (call $gdi_raster_clip_bound
      (local.get $system_clip) (local.get $dst) (i32.const 3) (i32.const 1073741823)))
    (local.set $limit (i32.sub (local.get $bound) (local.get $dy)))
    (if (i32.lt_s (local.get $limit) (local.get $y1)) (then (local.set $y1 (local.get $limit))))
    (if (local.get $source_mode)
      (then
        (if (i32.lt_s (local.get $sx) (i32.const 0))
          (then
            (local.set $limit (i32.sub (i32.const 0) (local.get $sx)))
            (if (i32.gt_s (local.get $limit) (local.get $x0))
              (then (local.set $x0 (local.get $limit))))))
        (if (i32.lt_s (local.get $sy) (i32.const 0))
          (then
            (local.set $limit (i32.sub (i32.const 0) (local.get $sy)))
            (if (i32.gt_s (local.get $limit) (local.get $y0))
              (then (local.set $y0 (local.get $limit))))))
        (local.set $limit (i32.sub (i32.load offset=4 (local.get $src)) (local.get $sx)))
        (if (i32.lt_s (local.get $limit) (local.get $x1)) (then (local.set $x1 (local.get $limit))))
        (local.set $limit (i32.sub (i32.load offset=8 (local.get $src)) (local.get $sy)))
        (if (i32.lt_s (local.get $limit) (local.get $y1)) (then (local.set $y1 (local.get $limit))))))
    (if (i32.or (i32.ge_s (local.get $x0) (local.get $x1))
          (i32.ge_s (local.get $y0) (local.get $y1)))
      (then (return (i32.const 1))))
    (global.set $gdi_fast_bitblt_hits
      (i32.add (global.get $gdi_fast_bitblt_hits) (i32.const 1)))
    (local.set $y (local.get $y0))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_s (local.get $y) (local.get $y1)))
      (local.set $dp (call $gdi_raster_row_ptr_32 (local.get $dst)
        (i32.add (local.get $dx) (local.get $x0)) (i32.add (local.get $dy) (local.get $y))))
      (if (local.get $source_mode)
        (then (local.set $sp (call $gdi_raster_row_ptr_32 (local.get $src)
          (i32.add (local.get $sx) (local.get $x0)) (i32.add (local.get $sy) (local.get $y))))))
      (local.set $x (local.get $x0))
      (block $cols_done (loop $cols
        (br_if $cols_done (i32.ge_s (local.get $x) (local.get $x1)))
        (if (local.get $source_mode)
          (then (local.set $s (i32.and (i32.load (local.get $sp)) (i32.const 0xFFFFFF)))))
        (if (i32.or (i32.eq (local.get $rop3) (i32.const 0x55))
              (i32.or (i32.eq (local.get $rop3) (i32.const 0x66))
                (i32.or (i32.eq (local.get $rop3) (i32.const 0x88))
                  (i32.eq (local.get $rop3) (i32.const 0xEE)))))
          (then (local.set $d (i32.and (i32.load (local.get $dp)) (i32.const 0xFFFFFF)))))
        (local.set $value (local.get $s))
        (if (i32.eq (local.get $rop3) (i32.const 0x00))
          (then (local.set $value (i32.const 0))))
        (if (i32.eq (local.get $rop3) (i32.const 0xFF))
          (then (local.set $value (i32.const 0xFFFFFF))))
        (if (i32.eq (local.get $rop3) (i32.const 0xF0))
          (then (local.set $value (local.get $pattern))))
        (if (i32.eq (local.get $rop3) (i32.const 0x55))
          (then (local.set $value (i32.xor (local.get $d) (i32.const 0xFFFFFF)))))
        (if (i32.eq (local.get $rop3) (i32.const 0x33))
          (then (local.set $value (i32.xor (local.get $s) (i32.const 0xFFFFFF)))))
        (if (i32.eq (local.get $rop3) (i32.const 0x66))
          (then (local.set $value (i32.xor (local.get $s) (local.get $d)))))
        (if (i32.eq (local.get $rop3) (i32.const 0x88))
          (then (local.set $value (i32.and (local.get $s) (local.get $d)))))
        (if (i32.eq (local.get $rop3) (i32.const 0xEE))
          (then (local.set $value (i32.or (local.get $s) (local.get $d)))))
        (i32.store (local.get $dp) (local.get $value))
        (local.set $dp (i32.add (local.get $dp) (i32.const 4)))
        (if (local.get $source_mode) (then (local.set $sp (i32.add (local.get $sp) (i32.const 4)))))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $cols)))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows)))
    (i32.const 1))

  (func $gdi_raster_stretch_blt_fast32 (param $hdc i32)
        (param $dst i32) (param $dx i32) (param $dy i32)
        (param $dw i32) (param $dh i32) (param $src i32) (param $sx i32) (param $sy i32)
        (param $sw i32) (param $sh i32) (param $rop3 i32) (result i32)
    (local $x0 i32) (local $y0 i32) (local $x1 i32) (local $y1 i32)
    (local $x i32) (local $y i32) (local $ux i32) (local $uy i32)
    (local $dp i32) (local $sp i32) (local $limit i32) (local $size i32)
    (local $app_clip i32) (local $system_clip i32) (local $bound i32)
    (local.set $app_clip (call $gdi_raster_app_clip_record (local.get $hdc)))
    (local.set $system_clip (call $gdi_raster_system_clip_record (local.get $hdc)))
    (if (i32.or (i32.ne (local.get $rop3) (i32.const 0xCC))
          (i32.or (i32.eqz (local.get $src))
            (i32.or (i32.ne (i32.load offset=16 (local.get $dst)) (i32.const 32))
              (i32.ne (i32.load offset=16 (local.get $src)) (i32.const 32)))))
      (then (return (i32.const -1))))
    (if (i32.or (i32.eq (i32.load (local.get $dst)) (i32.load (local.get $src)))
          (i32.or (i32.eqz (local.get $app_clip)) (i32.eqz (local.get $system_clip))))
      (then (return (i32.const -1))))
    ;; Signed and out-of-source transforms retain the general snapshot path.
    (if (i32.or (i32.le_s (local.get $dw) (i32.const 0))
          (i32.or (i32.le_s (local.get $dh) (i32.const 0))
            (i32.or (i32.le_s (local.get $sw) (i32.const 0))
              (i32.le_s (local.get $sh) (i32.const 0)))))
      (then (return (i32.const -1))))
    (if (i32.or
          (i32.or (i32.gt_u (local.get $dw) (i32.const 0x0000FFFF))
            (i32.or (i32.gt_u (local.get $dh) (i32.const 0x0000FFFF))
              (i32.or (i32.gt_u (local.get $sw) (i32.const 0x0000FFFF))
                (i32.gt_u (local.get $sh) (i32.const 0x0000FFFF)))))
          (i32.or
            (i32.or (i32.lt_s (local.get $dx) (i32.const -1073741823))
              (i32.gt_s (local.get $dx) (i32.const 1073741823)))
            (i32.or (i32.lt_s (local.get $dy) (i32.const -1073741823))
              (i32.gt_s (local.get $dy) (i32.const 1073741823)))))
      (then (return (i32.const -1))))
    (if (i32.or (i32.lt_s (local.get $sx) (i32.const 0))
          (i32.or (i32.lt_s (local.get $sy) (i32.const 0))
            (i32.or (i32.gt_s (i32.add (local.get $sx) (local.get $sw))
                    (i32.load offset=4 (local.get $src)))
              (i32.gt_s (i32.add (local.get $sy) (local.get $sh))
                (i32.load offset=8 (local.get $src))))))
      (then (return (i32.const -1))))
    (local.set $x1 (local.get $dw))
    (local.set $y1 (local.get $dh))
    (if (i32.lt_s (local.get $dx) (i32.const 0))
      (then (local.set $x0 (i32.sub (i32.const 0) (local.get $dx)))))
    (if (i32.lt_s (local.get $dy) (i32.const 0))
      (then (local.set $y0 (i32.sub (i32.const 0) (local.get $dy)))))
    (local.set $limit (i32.sub (i32.load offset=4 (local.get $dst)) (local.get $dx)))
    (if (i32.lt_s (local.get $limit) (local.get $x1)) (then (local.set $x1 (local.get $limit))))
    (local.set $limit (i32.sub (i32.load offset=8 (local.get $dst)) (local.get $dy)))
    (if (i32.lt_s (local.get $limit) (local.get $y1)) (then (local.set $y1 (local.get $limit))))
    (local.set $size (call $gdi_dc_target_size (local.get $hdc)))
    (if (local.get $size)
      (then
        (local.set $limit (i32.sub (i32.load offset=72 (local.get $dst)) (local.get $dx)))
        (if (i32.gt_s (local.get $limit) (local.get $x0)) (then (local.set $x0 (local.get $limit))))
        (local.set $limit (i32.sub
          (i32.add (i32.load offset=72 (local.get $dst))
            (i32.and (local.get $size) (i32.const 0xFFFF))) (local.get $dx)))
        (if (i32.lt_s (local.get $limit) (local.get $x1)) (then (local.set $x1 (local.get $limit))))
        (local.set $limit (i32.sub (i32.load offset=76 (local.get $dst)) (local.get $dy)))
        (if (i32.gt_s (local.get $limit) (local.get $y0)) (then (local.set $y0 (local.get $limit))))
        (local.set $limit (i32.sub
          (i32.add (i32.load offset=76 (local.get $dst))
            (i32.shr_u (local.get $size) (i32.const 16))) (local.get $dy)))
        (if (i32.lt_s (local.get $limit) (local.get $y1)) (then (local.set $y1 (local.get $limit))))))
    (local.set $bound (call $gdi_raster_clip_bound
      (local.get $app_clip) (local.get $dst) (i32.const 0) (i32.const -1073741824)))
    (local.set $limit (i32.sub (local.get $bound) (local.get $dx)))
    (if (i32.gt_s (local.get $limit) (local.get $x0)) (then (local.set $x0 (local.get $limit))))
    (local.set $bound (call $gdi_raster_clip_bound
      (local.get $system_clip) (local.get $dst) (i32.const 0) (i32.const -1073741824)))
    (local.set $limit (i32.sub (local.get $bound) (local.get $dx)))
    (if (i32.gt_s (local.get $limit) (local.get $x0)) (then (local.set $x0 (local.get $limit))))
    (local.set $bound (call $gdi_raster_clip_bound
      (local.get $app_clip) (local.get $dst) (i32.const 1) (i32.const -1073741824)))
    (local.set $limit (i32.sub (local.get $bound) (local.get $dy)))
    (if (i32.gt_s (local.get $limit) (local.get $y0)) (then (local.set $y0 (local.get $limit))))
    (local.set $bound (call $gdi_raster_clip_bound
      (local.get $system_clip) (local.get $dst) (i32.const 1) (i32.const -1073741824)))
    (local.set $limit (i32.sub (local.get $bound) (local.get $dy)))
    (if (i32.gt_s (local.get $limit) (local.get $y0)) (then (local.set $y0 (local.get $limit))))
    (local.set $bound (call $gdi_raster_clip_bound
      (local.get $app_clip) (local.get $dst) (i32.const 2) (i32.const 1073741823)))
    (local.set $limit (i32.sub (local.get $bound) (local.get $dx)))
    (if (i32.lt_s (local.get $limit) (local.get $x1)) (then (local.set $x1 (local.get $limit))))
    (local.set $bound (call $gdi_raster_clip_bound
      (local.get $system_clip) (local.get $dst) (i32.const 2) (i32.const 1073741823)))
    (local.set $limit (i32.sub (local.get $bound) (local.get $dx)))
    (if (i32.lt_s (local.get $limit) (local.get $x1)) (then (local.set $x1 (local.get $limit))))
    (local.set $bound (call $gdi_raster_clip_bound
      (local.get $app_clip) (local.get $dst) (i32.const 3) (i32.const 1073741823)))
    (local.set $limit (i32.sub (local.get $bound) (local.get $dy)))
    (if (i32.lt_s (local.get $limit) (local.get $y1)) (then (local.set $y1 (local.get $limit))))
    (local.set $bound (call $gdi_raster_clip_bound
      (local.get $system_clip) (local.get $dst) (i32.const 3) (i32.const 1073741823)))
    (local.set $limit (i32.sub (local.get $bound) (local.get $dy)))
    (if (i32.lt_s (local.get $limit) (local.get $y1)) (then (local.set $y1 (local.get $limit))))
    (if (i32.or (i32.ge_s (local.get $x0) (local.get $x1))
          (i32.ge_s (local.get $y0) (local.get $y1)))
      (then (return (i32.const 1))))
    (global.set $gdi_fast_stretch_hits
      (i32.add (global.get $gdi_fast_stretch_hits) (i32.const 1)))
    (local.set $y (local.get $y0))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_s (local.get $y) (local.get $y1)))
      (local.set $uy (i32.add (local.get $sy)
        (i32.div_u (i32.mul (local.get $y) (local.get $sh)) (local.get $dh))))
      (local.set $dp (call $gdi_raster_row_ptr_32 (local.get $dst)
        (i32.add (local.get $dx) (local.get $x0)) (i32.add (local.get $dy) (local.get $y))))
      (local.set $x (local.get $x0))
      (block $cols_done (loop $cols
        (br_if $cols_done (i32.ge_s (local.get $x) (local.get $x1)))
        (local.set $ux (i32.add (local.get $sx)
          (i32.div_u (i32.mul (local.get $x) (local.get $sw)) (local.get $dw))))
        (local.set $sp (call $gdi_raster_row_ptr_32
          (local.get $src) (local.get $ux) (local.get $uy)))
        (i32.store (local.get $dp) (i32.and (i32.load (local.get $sp)) (i32.const 0xFFFFFF)))
        (local.set $dp (i32.add (local.get $dp) (i32.const 4)))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $cols)))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows)))
    (i32.const 1))

  ;; Signed-extent nearest-neighbor blit. A negative source or destination
  ;; extent walks that axis backwards; differing signs mirror it, matching
  ;; StretchBlt. Destination bounds clip. The source descriptor may be zero
  ;; for pattern/destination-only ROPs. Overlapping surfaces use one bulk
  ;; snapshot of the canonical bytes so scaling and mirroring never consume
  ;; pixels already replaced by this operation.
  (func $gdi_raster_stretch_blt (param $hdc i32) (param $src_hdc i32)
        (param $dst i32) (param $dx i32) (param $dy i32)
        (param $dw i32) (param $dh i32) (param $src i32) (param $sx i32) (param $sy i32)
        (param $sw i32) (param $sh i32) (param $pattern i32) (param $rop i32) (result i32)
    (local $x i32) (local $y i32) (local $tx i32) (local $ty i32)
    (local $ux i32) (local $uy i32) (local $s i32) (local $d i32) (local $rop3 i32)
    (local $dw_abs i32) (local $dh_abs i32) (local $sw_abs i32) (local $sh_abs i32)
    (local $dst_x0 i32) (local $dst_y0 i32) (local $src_x0 i32) (local $src_y0 i32)
    (local $dst_x_step i32) (local $dst_y_step i32)
    (local $src_x_step i32) (local $src_y_step i32)
    (local $same i32) (local $snapshot_guest i32) (local $snapshot i32)
    (local $snapshot_desc i32) (local $surface_size i32)
    (local $surface_size64 i64) (local $snapshot_size64 i64)
    (local $brush i32) (local $sample i32) (local $pixel_pattern i32) (local $fast i32)
    (if (i32.or (i32.eqz (call $gdi_raster_surface_valid (local.get $dst)))
          (i32.or (i32.eqz (local.get $dw)) (i32.eqz (local.get $dh))))
      (then (return (i32.const 0))))
    (if (i32.and (i32.ne (local.get $src) (i32.const 0))
          (i32.or (i32.eqz (call $gdi_raster_surface_valid (local.get $src)))
            (i32.or (i32.eqz (local.get $sw)) (i32.eqz (local.get $sh)))))
      (then (return (i32.const 0))))
    (local.set $same (i32.and (i32.ne (local.get $src) (i32.const 0))
      (i32.eq (i32.load (local.get $dst)) (i32.load (local.get $src)))))
    (local.set $rop3 (i32.and (i32.shr_u (local.get $rop) (i32.const 16)) (i32.const 0xFF)))
    (if (i32.and (i32.ne (local.get $hdc) (i32.const 0))
          (call $gdi_rop3_uses_pattern (local.get $rop3)))
      (then
        (local.set $brush (call $gdi_dc_get_field
          (local.get $hdc) (i32.const 8) (i32.const 0x30010)))
        (if (i32.eqz (call $gdi_brush_valid (local.get $brush)))
          (then (return (i32.const 0))))))
    (local.set $fast (call $gdi_raster_stretch_blt_fast32
      (local.get $hdc) (local.get $dst) (local.get $dx) (local.get $dy)
      (local.get $dw) (local.get $dh) (local.get $src) (local.get $sx) (local.get $sy)
      (local.get $sw) (local.get $sh) (local.get $rop3)))
    (if (i32.ge_s (local.get $fast) (i32.const 0)) (then (return (local.get $fast))))
    (local.set $dw_abs (select
      (i32.sub (i32.const 0) (local.get $dw)) (local.get $dw)
      (i32.lt_s (local.get $dw) (i32.const 0))))
    (local.set $dh_abs (select
      (i32.sub (i32.const 0) (local.get $dh)) (local.get $dh)
      (i32.lt_s (local.get $dh) (i32.const 0))))
    (local.set $sw_abs (select
      (i32.sub (i32.const 0) (local.get $sw)) (local.get $sw)
      (i32.lt_s (local.get $sw) (i32.const 0))))
    (local.set $sh_abs (select
      (i32.sub (i32.const 0) (local.get $sh)) (local.get $sh)
      (i32.lt_s (local.get $sh) (i32.const 0))))
    (local.set $dst_x_step (select (i32.const -1) (i32.const 1)
      (i32.lt_s (local.get $dw) (i32.const 0))))
    (local.set $dst_y_step (select (i32.const -1) (i32.const 1)
      (i32.lt_s (local.get $dh) (i32.const 0))))
    (local.set $src_x_step (select (i32.const -1) (i32.const 1)
      (i32.lt_s (local.get $sw) (i32.const 0))))
    (local.set $src_y_step (select (i32.const -1) (i32.const 1)
      (i32.lt_s (local.get $sh) (i32.const 0))))
    ;; Negative extents reverse traversal from the inclusive origin supplied by
    ;; the caller. Paint passes sx=width-1, sw=-width for an exact mirror.
    (local.set $dst_x0 (local.get $dx))
    (local.set $dst_y0 (local.get $dy))
    (local.set $src_x0 (local.get $sx))
    (local.set $src_y0 (local.get $sy))
    ;; Paint mirrors a selection by selecting the same bitmap into both DCs.
    ;; Preserve the source surface in the page-backed DIB arena, including a
    ;; private descriptor whose bits pointer names the snapshot. A bulk copy
    ;; is substantially cheaper than a second per-pixel pass for large images.
    (if (local.get $same)
      (then
        (local.set $surface_size64 (i64.mul
          (i64.extend_i32_u (i32.load offset=12 (local.get $src)))
          (i64.extend_i32_u (i32.load offset=8 (local.get $src)))))
        (local.set $snapshot_size64
          (i64.add (local.get $surface_size64) (i64.const 80)))
        (if (i32.or (i64.eqz (local.get $surface_size64))
              (i64.gt_u (local.get $snapshot_size64)
                (i64.extend_i32_u (global.get $DIB_BACKING_BASE_SIZE))))
          (then (return (i32.const 0))))
        (local.set $surface_size (i32.wrap_i64 (local.get $surface_size64)))
        (local.set $snapshot_guest
          (call $dib_alloc (i32.wrap_i64 (local.get $snapshot_size64))))
        (if (i32.eqz (local.get $snapshot_guest))
          (then (return (i32.const 0))))
        (local.set $snapshot (call $g2w (local.get $snapshot_guest)))
        (memory.copy (local.get $snapshot) (i32.load (local.get $src))
          (local.get $surface_size))
        (local.set $snapshot_desc
          (i32.add (local.get $snapshot) (local.get $surface_size)))
        (memory.copy (local.get $snapshot_desc) (local.get $src) (i32.const 80))
        (i32.store (local.get $snapshot_desc) (local.get $snapshot))
        (local.set $src (local.get $snapshot_desc))))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_u (local.get $y) (local.get $dh_abs)))
      (local.set $x (i32.const 0))
      (block $cols_done (loop $cols
        (br_if $cols_done (i32.ge_u (local.get $x) (local.get $dw_abs)))
        (local.set $tx (i32.add (local.get $dst_x0)
          (i32.mul (local.get $x) (local.get $dst_x_step))))
        (local.set $ty (i32.add (local.get $dst_y0)
          (i32.mul (local.get $y) (local.get $dst_y_step))))
        (if (i32.and
              (i32.ne (call $gdi_raster_pixel_ptr
                (local.get $dst) (local.get $tx) (local.get $ty)) (i32.const 0))
              (call $gdi_raster_clip_visible
                (local.get $hdc) (local.get $dst) (local.get $tx) (local.get $ty)))
          (then
            (local.set $d (call $gdi_raster_read (local.get $dst) (local.get $tx) (local.get $ty)))
            (local.set $pixel_pattern (local.get $pattern))
            (if (local.get $brush)
              (then
                (local.set $sample (call $gdi_brush_sample
                  (local.get $hdc) (local.get $brush) (local.get $tx) (local.get $ty)))
                (if (i32.eq (local.get $sample) (i32.const 0x01000000))
                  (then
                    (if (local.get $snapshot)
                      (then (call $dib_free_wasm (local.get $snapshot))))
                    (return (i32.const 0))))
                (if (i32.eq (local.get $sample) (i32.const 0x01000001))
                  (then
                    (local.set $x (i32.add (local.get $x) (i32.const 1)))
                    (br $cols)))
                (local.set $pixel_pattern (call $gdi_raster_swap_rb (local.get $sample)))))
            (local.set $s (i32.const 0))
            (if (local.get $src)
              (then
                (local.set $ux (i32.add (local.get $src_x0)
                  (i32.mul (local.get $src_x_step)
                    (i32.div_u (i32.mul (local.get $x) (local.get $sw_abs))
                      (local.get $dw_abs)))))
                (local.set $uy (i32.add (local.get $src_y0)
                  (i32.mul (local.get $src_y_step)
                    (i32.div_u (i32.mul (local.get $y) (local.get $sh_abs))
                      (local.get $dh_abs)))))
                (local.set $s (call $gdi_raster_read_blt_source
                  (local.get $hdc) (local.get $src_hdc) (local.get $dst) (local.get $src)
                  (local.get $ux) (local.get $uy)))
                (if (i32.eq (local.get $s) (i32.const -1))
                  (then
                    (if (local.get $snapshot)
                      (then (call $dib_free_wasm (local.get $snapshot))))
                    (return (i32.const 0))))))
            (drop (call $gdi_raster_write (local.get $dst) (local.get $tx) (local.get $ty)
              (call $gdi_apply_rop3 (local.get $rop3) (local.get $pixel_pattern)
                (local.get $s) (local.get $d))))))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $cols)))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows)))
    (if (local.get $snapshot)
      (then (call $dib_free_wasm (local.get $snapshot))))
    (i32.const 1))

  ;; Equal-size copy with memmove traversal for overlapping canonical bytes.
  (func $gdi_raster_bitblt (param $hdc i32) (param $src_hdc i32)
        (param $dst i32) (param $dx i32) (param $dy i32)
        (param $w i32) (param $h i32) (param $src i32) (param $sx i32) (param $sy i32)
        (param $pattern i32) (param $rop i32) (result i32)
    (local $x i32) (local $y i32) (local $step i32) (local $start i32)
    (local $s i32) (local $d i32) (local $rop3 i32) (local $same i32)
    (local $brush i32) (local $sample i32) (local $pixel_pattern i32) (local $fast i32)
    (if (i32.or (i32.eqz (call $gdi_raster_surface_valid (local.get $dst)))
          (i32.or (i32.le_s (local.get $w) (i32.const 0)) (i32.le_s (local.get $h) (i32.const 0))))
      (then (return (i32.const 0))))
    (if (i32.and (i32.ne (local.get $src) (i32.const 0))
          (i32.eqz (call $gdi_raster_surface_valid (local.get $src))))
      (then (return (i32.const 0))))
    (local.set $same (i32.and (i32.ne (local.get $src) (i32.const 0))
      (i32.eq (i32.load (local.get $dst)) (i32.load (local.get $src)))))
    (local.set $step (i32.const 1))
    (if (i32.and (local.get $same) (i32.or (i32.gt_s (local.get $dy) (local.get $sy))
          (i32.and (i32.eq (local.get $dy) (local.get $sy)) (i32.gt_s (local.get $dx) (local.get $sx)))))
      (then (local.set $step (i32.const -1)) (local.set $start (i32.const 1))))
    (local.set $rop3 (i32.and (i32.shr_u (local.get $rop) (i32.const 16)) (i32.const 0xFF)))
    (if (i32.and (i32.ne (local.get $hdc) (i32.const 0))
          (call $gdi_rop3_uses_pattern (local.get $rop3)))
      (then
        (local.set $brush (call $gdi_dc_get_field
          (local.get $hdc) (i32.const 8) (i32.const 0x30010)))
        (if (i32.eqz (call $gdi_brush_valid (local.get $brush)))
          (then (return (i32.const 0))))))
    (local.set $fast (call $gdi_raster_bitblt_fast32
      (local.get $hdc) (local.get $dst) (local.get $dx) (local.get $dy)
      (local.get $w) (local.get $h) (local.get $src) (local.get $sx) (local.get $sy)
      (local.get $pattern) (local.get $brush) (local.get $rop3)))
    (if (i32.ge_s (local.get $fast) (i32.const 0)) (then (return (local.get $fast))))
    (local.set $y (select (i32.sub (local.get $h) (i32.const 1)) (i32.const 0) (local.get $start)))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.or (i32.lt_s (local.get $y) (i32.const 0))
        (i32.ge_s (local.get $y) (local.get $h))))
      (local.set $x (select (i32.sub (local.get $w) (i32.const 1)) (i32.const 0) (local.get $start)))
      (block $cols_done (loop $cols
        (br_if $cols_done (i32.or (i32.lt_s (local.get $x) (i32.const 0))
          (i32.ge_s (local.get $x) (local.get $w))))
        (if (i32.and
              (i32.ne (call $gdi_raster_pixel_ptr (local.get $dst)
                (i32.add (local.get $dx) (local.get $x))
                (i32.add (local.get $dy) (local.get $y))) (i32.const 0))
              (call $gdi_raster_clip_visible (local.get $hdc) (local.get $dst)
                (i32.add (local.get $dx) (local.get $x))
                (i32.add (local.get $dy) (local.get $y))))
          (then
            (local.set $d (call $gdi_raster_read (local.get $dst)
              (i32.add (local.get $dx) (local.get $x)) (i32.add (local.get $dy) (local.get $y))))
            (local.set $pixel_pattern (local.get $pattern))
            (if (local.get $brush)
              (then
                (local.set $sample (call $gdi_brush_sample
                  (local.get $hdc) (local.get $brush)
                  (i32.add (local.get $dx) (local.get $x))
                  (i32.add (local.get $dy) (local.get $y))))
                (if (i32.eq (local.get $sample) (i32.const 0x01000000))
                  (then (return (i32.const 0))))
                (if (i32.eq (local.get $sample) (i32.const 0x01000001))
                  (then
                    (local.set $x (i32.add (local.get $x) (local.get $step)))
                    (br $cols)))
                (local.set $pixel_pattern (call $gdi_raster_swap_rb (local.get $sample)))))
            (local.set $s (i32.const 0))
            (if (local.get $src)
              (then (local.set $s (call $gdi_raster_read_blt_source
                (local.get $hdc) (local.get $src_hdc) (local.get $dst) (local.get $src)
                (i32.add (local.get $sx) (local.get $x)) (i32.add (local.get $sy) (local.get $y))))
                ;; BitBlt clips a source rectangle that extends beyond its
                ;; bitmap instead of rejecting the entire transfer. Paint's
                ;; thumbnail deliberately copies from (-3,-3), leaving a
                ;; three-pixel border before the in-bounds preview pixels.
                (if (i32.eq (local.get $s) (i32.const -1))
                  (then
                    (local.set $x (i32.add (local.get $x) (local.get $step)))
                    (br $cols)))))
            (drop (call $gdi_raster_write (local.get $dst)
              (i32.add (local.get $dx) (local.get $x)) (i32.add (local.get $dy) (local.get $y))
              (call $gdi_apply_rop3 (local.get $rop3) (local.get $pixel_pattern)
                (local.get $s) (local.get $d))))))
        (local.set $x (i32.add (local.get $x) (local.get $step)))
        (br $cols)))
      (local.set $y (i32.add (local.get $y) (local.get $step)))
      (br $rows)))
    (i32.const 1))

  ;; Shared HDC adapters keep public handlers and WAT-native controls on one
  ;; canonical mapping/clip/presentation path.
  (func $gdi_hdc_bitblt
        (param $dst_hdc i32) (param $dx_logical i32) (param $dy_logical i32)
        (param $w i32) (param $h i32) (param $src_hdc i32)
        (param $sx_logical i32) (param $sy_logical i32) (param $rop i32) (result i32)
    (local $dst i32) (local $src i32) (local $dx i32) (local $dy i32)
    (local $sx i32) (local $sy i32) (local $rop3 i32)
    (local $pattern i32) (local $ok i32)
    (local.set $dst (global.get $GDI_BLIT_DST_DESC))
    (local.set $src (global.get $GDI_BLIT_SRC_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $dst_hdc) (local.get $dst)))
      (then (return (i32.const 0))))
    (local.set $dx (call $gdi_line_map_x (local.get $dst) (local.get $dx_logical)))
    (local.set $dy (call $gdi_line_map_y (local.get $dst) (local.get $dy_logical)))
    (if (local.get $src_hdc)
      (then
        (if (i32.eqz (call $gdi_surface_descriptor (local.get $src_hdc) (local.get $src)))
          (then (local.set $src (i32.const 0))))
        (if (local.get $src)
          (then
            (local.set $sx (call $gdi_line_map_x (local.get $src) (local.get $sx_logical)))
            (local.set $sy (call $gdi_line_map_y (local.get $src) (local.get $sy_logical))))))
      (else (local.set $src (i32.const 0))))
    (local.set $rop3 (i32.and (i32.shr_u (local.get $rop) (i32.const 16)) (i32.const 0xFF)))
    (if (i32.and
          (i32.ne (i32.and
            (i32.xor (local.get $rop3) (i32.shr_u (local.get $rop3) (i32.const 2)))
            (i32.const 0x33)) (i32.const 0))
          (i32.eqz (local.get $src)))
      (then (return (i32.const 0))))
    (local.set $ok (call $gdi_raster_bitblt
      (local.get $dst_hdc) (local.get $src_hdc) (local.get $dst) (local.get $dx) (local.get $dy)
      (local.get $w) (local.get $h) (local.get $src) (local.get $sx) (local.get $sy)
      (local.get $pattern) (local.get $rop)))
    (if (local.get $ok)
      (then (call $gdi_geometry_present (local.get $dst_hdc) (local.get $dst)
        (local.get $dx) (local.get $dy)
        (i32.add (local.get $dx) (local.get $w))
        (i32.add (local.get $dy) (local.get $h)))))
    (local.get $ok))

  (func $gdi_hdc_stretch_blt
        (param $dst_hdc i32) (param $dx_logical i32) (param $dy_logical i32)
        (param $dw i32) (param $dh i32) (param $src_hdc i32)
        (param $sx_logical i32) (param $sy_logical i32)
        (param $sw i32) (param $sh i32) (param $rop i32) (result i32)
    (local $dst i32) (local $src i32) (local $dx i32) (local $dy i32)
    (local $sx i32) (local $sy i32) (local $rop3 i32)
    (local $pattern i32) (local $ok i32)
    (local.set $dst (global.get $GDI_BLIT_DST_DESC))
    (local.set $src (global.get $GDI_BLIT_SRC_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $dst_hdc) (local.get $dst)))
      (then (return (i32.const 0))))
    (local.set $dx (call $gdi_line_map_x (local.get $dst) (local.get $dx_logical)))
    (local.set $dy (call $gdi_line_map_y (local.get $dst) (local.get $dy_logical)))
    (if (local.get $src_hdc)
      (then
        (if (i32.eqz (call $gdi_surface_descriptor (local.get $src_hdc) (local.get $src)))
          (then (local.set $src (i32.const 0))))
        (if (local.get $src)
          (then
            (local.set $sx (call $gdi_line_map_x (local.get $src) (local.get $sx_logical)))
            (local.set $sy (call $gdi_line_map_y (local.get $src) (local.get $sy_logical))))))
      (else (local.set $src (i32.const 0))))
    (local.set $rop3 (i32.and (i32.shr_u (local.get $rop) (i32.const 16)) (i32.const 0xFF)))
    (if (i32.and
          (i32.ne (i32.and
            (i32.xor (local.get $rop3) (i32.shr_u (local.get $rop3) (i32.const 2)))
            (i32.const 0x33)) (i32.const 0))
          (i32.eqz (local.get $src)))
      (then (return (i32.const 0))))
    (local.set $ok (call $gdi_raster_stretch_blt
      (local.get $dst_hdc) (local.get $src_hdc) (local.get $dst) (local.get $dx) (local.get $dy)
      (local.get $dw) (local.get $dh) (local.get $src) (local.get $sx) (local.get $sy)
      (local.get $sw) (local.get $sh) (local.get $pattern) (local.get $rop)))
    (if (local.get $ok)
      (then (call $gdi_geometry_present (local.get $dst_hdc) (local.get $dst)
        (local.get $dx) (local.get $dy)
        (i32.add (local.get $dx) (local.get $dw))
        (i32.add (local.get $dy) (local.get $dh)))))
    (local.get $ok))

  (func $gdi_hdc_get_pixel (param $hdc i32) (param $logical_x i32)
        (param $logical_y i32) (result i32)
    (local $desc i32)
    (local.set $desc (global.get $GDI_BLIT_DST_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const -1))))
    (call $gdi_raster_get_pixel (local.get $desc)
      (call $gdi_line_map_x (local.get $desc) (local.get $logical_x))
      (call $gdi_line_map_y (local.get $desc) (local.get $logical_y))))

  (func $gdi_hdc_set_pixel (param $hdc i32) (param $logical_x i32)
        (param $logical_y i32) (param $color i32) (result i32)
    (local $desc i32) (local $x i32) (local $y i32) (local $result i32)
    (local.set $desc (global.get $GDI_BLIT_DST_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const -1))))
    (local.set $x (call $gdi_line_map_x (local.get $desc) (local.get $logical_x)))
    (local.set $y (call $gdi_line_map_y (local.get $desc) (local.get $logical_y)))
    (local.set $result (call $gdi_raster_set_pixel
      (local.get $desc) (local.get $x) (local.get $y) (local.get $color)))
    (if (i32.ne (local.get $result) (i32.const -1))
      (then (call $gdi_geometry_present (local.get $hdc) (local.get $desc)
        (local.get $x) (local.get $y)
        (i32.add (local.get $x) (i32.const 1))
        (i32.add (local.get $y) (i32.const 1)))))
    (local.get $result))

  (func $gdi_hdc_ext_flood_fill (param $hdc i32) (param $x i32) (param $y i32)
        (param $color i32) (param $fill_type i32) (result i32)
    (local $desc i32)
    (local.set $desc (global.get $GDI_BLIT_DST_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const 0))))
    (call $gdi_raster_flood_fill
      (local.get $hdc) (local.get $desc) (local.get $x) (local.get $y)
      (local.get $color) (local.get $fill_type)
      (call $gdi_dc_get_field (local.get $hdc) (i32.const 8) (i32.const 0x30010))))

  (func $gdi_hdc_fill_rgn (param $hdc i32) (param $hrgn i32)
        (param $brush_in i32) (result i32)
    (local $record i32) (local $base i32) (local $count i32) (local $i i32)
    (local $rect i32) (local $desc i32) (local $brush i32) (local $ok i32)
    (local.set $record (call $gdi_rgn_record (local.get $hrgn)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const 0))))
    (local.set $brush (local.get $brush_in))
    (if (i32.eqz (local.get $brush))
      (then (local.set $brush
        (call $gdi_dc_get_field (local.get $hdc) (i32.const 8) (i32.const 0x30010)))))
    (if (i32.eqz (call $gdi_brush_valid (local.get $brush)))
      (then (return (i32.const 0))))
    (local.set $base (call $gdi_rgn_bands (local.get $record)))
    (local.set $count (i32.load offset=28 (local.get $record)))
    (local.set $ok (i32.const 1))
    (block $done (loop $rects
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $rect (i32.add (local.get $base) (i32.shl (local.get $i) (i32.const 4))))
      (if (i32.eqz (call $gdi_fill_rect_desc
            (local.get $hdc) (local.get $desc)
            (i32.load (local.get $rect)) (i32.load offset=4 (local.get $rect))
            (i32.load offset=8 (local.get $rect)) (i32.load offset=12 (local.get $rect))
            (local.get $brush)))
        (then (local.set $ok (i32.const 0)) (br $done)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $rects)))
    (local.get $ok))

  (func $gdi_hdc_invert_rgn (param $hdc i32) (param $hrgn i32) (result i32)
    (local $record i32) (local $base i32) (local $count i32) (local $i i32)
    (local $rect i32) (local $desc i32) (local $left i32) (local $top i32)
    (local $right i32) (local $bottom i32) (local $swap i32)
    (local $dirty_left i32) (local $dirty_top i32)
    (local $dirty_right i32) (local $dirty_bottom i32)
    (local.set $record (call $gdi_rgn_record (local.get $hrgn)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const 0))))
    (local.set $base (call $gdi_rgn_bands (local.get $record)))
    (local.set $count (i32.load offset=28 (local.get $record)))
    (if (i32.eqz (local.get $count)) (then (return (i32.const 1))))
    (local.set $dirty_left (i32.const 0x7FFFFFFF))
    (local.set $dirty_top (i32.const 0x7FFFFFFF))
    (local.set $dirty_right (i32.const -2147483648))
    (local.set $dirty_bottom (i32.const -2147483648))
    (block $done (loop $rectangles
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $rect (i32.add (local.get $base) (i32.shl (local.get $i) (i32.const 4))))
      (local.set $left (call $gdi_line_map_x
        (local.get $desc) (i32.load (local.get $rect))))
      (local.set $top (call $gdi_line_map_y
        (local.get $desc) (i32.load offset=4 (local.get $rect))))
      (local.set $right (call $gdi_line_map_x
        (local.get $desc) (i32.load offset=8 (local.get $rect))))
      (local.set $bottom (call $gdi_line_map_y
        (local.get $desc) (i32.load offset=12 (local.get $rect))))
      (if (i32.gt_s (local.get $left) (local.get $right))
        (then
          (local.set $swap (local.get $left))
          (local.set $left (local.get $right))
          (local.set $right (local.get $swap))))
      (if (i32.gt_s (local.get $top) (local.get $bottom))
        (then
          (local.set $swap (local.get $top))
          (local.set $top (local.get $bottom))
          (local.set $bottom (local.get $swap))))
      (if (i32.and (i32.lt_s (local.get $left) (local.get $right))
            (i32.lt_s (local.get $top) (local.get $bottom)))
        (then
          (if (i32.eqz (call $gdi_raster_bitblt
                (local.get $hdc) (i32.const 0) (local.get $desc)
                (local.get $left) (local.get $top)
                (i32.sub (local.get $right) (local.get $left))
                (i32.sub (local.get $bottom) (local.get $top))
                (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)
                (i32.const 0x00550009)))
            (then (return (i32.const 0))))
          (if (i32.lt_s (local.get $left) (local.get $dirty_left))
            (then (local.set $dirty_left (local.get $left))))
          (if (i32.lt_s (local.get $top) (local.get $dirty_top))
            (then (local.set $dirty_top (local.get $top))))
          (if (i32.gt_s (local.get $right) (local.get $dirty_right))
            (then (local.set $dirty_right (local.get $right))))
          (if (i32.gt_s (local.get $bottom) (local.get $dirty_bottom))
            (then (local.set $dirty_bottom (local.get $bottom))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $rectangles)))
    (if (i32.lt_s (local.get $dirty_left) (local.get $dirty_right))
      (then (call $gdi_geometry_present (local.get $hdc) (local.get $desc)
        (local.get $dirty_left) (local.get $dirty_top)
        (local.get $dirty_right) (local.get $dirty_bottom))))
    (i32.const 1))

  (func $gdi_hdc_frame_rgn (param $hdc i32) (param $hrgn i32) (param $brush i32)
        (param $frame_w i32) (param $frame_h i32) (result i32)
    (local $record i32) (local $base i32) (local $count i32) (local $desc i32)
    (local $x i32) (local $y i32) (local $left i32) (local $top i32)
    (local $right i32) (local $bottom i32) (local $device_x i32) (local $device_y i32)
    (local $color i32)
    (local.set $record (call $gdi_rgn_record (local.get $hrgn)))
    (if (i32.or (i32.eqz (local.get $record))
          (i32.or (i32.le_s (local.get $frame_w) (i32.const 0))
            (i32.le_s (local.get $frame_h) (i32.const 0))))
      (then (return (i32.const 0))))
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_brush_valid (local.get $brush)))
      (then (return (i32.const 0))))
    (local.set $base (call $gdi_rgn_bands (local.get $record)))
    (local.set $count (i32.load offset=28 (local.get $record)))
    (local.set $left (i32.load offset=8 (local.get $record)))
    (local.set $top (i32.load offset=12 (local.get $record)))
    (local.set $right (i32.load offset=16 (local.get $record)))
    (local.set $bottom (i32.load offset=20 (local.get $record)))
    (local.set $y (local.get $top))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_s (local.get $y) (local.get $bottom)))
      (local.set $x (local.get $left))
      (block $cols_done (loop $cols
        (br_if $cols_done (i32.ge_s (local.get $x) (local.get $right)))
        (if (i32.and
              (call $gdi_rgn_contains (local.get $base) (local.get $count)
                (local.get $x) (local.get $y))
              (i32.or
                (i32.or
                  (i32.eqz (call $gdi_rgn_contains (local.get $base) (local.get $count)
                    (i32.sub (local.get $x) (local.get $frame_w)) (local.get $y)))
                  (i32.eqz (call $gdi_rgn_contains (local.get $base) (local.get $count)
                    (i32.add (local.get $x) (local.get $frame_w)) (local.get $y))))
                (i32.or
                  (i32.eqz (call $gdi_rgn_contains (local.get $base) (local.get $count)
                    (local.get $x) (i32.sub (local.get $y) (local.get $frame_h))))
                  (i32.eqz (call $gdi_rgn_contains (local.get $base) (local.get $count)
                    (local.get $x) (i32.add (local.get $y) (local.get $frame_h)))))))
          (then
            (local.set $device_x (call $gdi_line_map_x (local.get $desc) (local.get $x)))
            (local.set $device_y (call $gdi_line_map_y (local.get $desc) (local.get $y)))
            (local.set $color (call $gdi_brush_sample
              (local.get $hdc) (local.get $brush) (local.get $device_x) (local.get $device_y)))
            (if (i32.le_u (local.get $color) (i32.const 0xFFFFFF))
              (then (drop (call $gdi_raster_write (local.get $desc)
                (local.get $device_x) (local.get $device_y)
                (call $gdi_raster_swap_rb (local.get $color))))))))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $cols)))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows)))
    (call $gdi_geometry_present (local.get $hdc) (local.get $desc)
      (call $gdi_line_map_x (local.get $desc) (local.get $left))
      (call $gdi_line_map_y (local.get $desc) (local.get $top))
      (call $gdi_line_map_x (local.get $desc) (local.get $right))
      (call $gdi_line_map_y (local.get $desc) (local.get $bottom)))
    (i32.const 1))

  (func $gdi_hdc_transparent_blt
        (param $dst_hdc i32) (param $dx_logical i32) (param $dy_logical i32)
        (param $w i32) (param $h i32) (param $src_hdc i32)
        (param $sx_logical i32) (param $sy_logical i32) (param $color_key i32)
        (result i32)
    (local $dst i32) (local $src i32) (local $dx i32) (local $dy i32)
    (local $sx i32) (local $sy i32) (local $x i32) (local $y i32)
    (local $source i32) (local $key i32)
    (if (i32.or (i32.le_s (local.get $w) (i32.const 0))
          (i32.le_s (local.get $h) (i32.const 0)))
      (then (return (i32.const 1))))
    (local.set $dst (global.get $GDI_BLIT_DST_DESC))
    (local.set $src (global.get $GDI_BLIT_SRC_DESC))
    (if (i32.or
          (i32.eqz (call $gdi_surface_descriptor (local.get $dst_hdc) (local.get $dst)))
          (i32.eqz (call $gdi_surface_descriptor (local.get $src_hdc) (local.get $src))))
      (then (return (i32.const 0))))
    (local.set $dx (call $gdi_line_map_x (local.get $dst) (local.get $dx_logical)))
    (local.set $dy (call $gdi_line_map_y (local.get $dst) (local.get $dy_logical)))
    (local.set $sx (call $gdi_line_map_x (local.get $src) (local.get $sx_logical)))
    (local.set $sy (call $gdi_line_map_y (local.get $src) (local.get $sy_logical)))
    (local.set $key (call $gdi_raster_swap_rb (local.get $color_key)))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_u (local.get $y) (local.get $h)))
      (local.set $x (i32.const 0))
      (block $cols_done (loop $cols
        (br_if $cols_done (i32.ge_u (local.get $x) (local.get $w)))
        (local.set $source (call $gdi_raster_read (local.get $src)
          (i32.add (local.get $sx) (local.get $x))
          (i32.add (local.get $sy) (local.get $y))))
        (if (i32.and
              (i32.ne (local.get $source) (i32.const -1))
              (i32.and (i32.ne (local.get $source) (local.get $key))
                (call $gdi_raster_clip_visible (local.get $dst_hdc) (local.get $dst)
                  (i32.add (local.get $dx) (local.get $x))
                  (i32.add (local.get $dy) (local.get $y)))))
          (then (drop (call $gdi_raster_write (local.get $dst)
            (i32.add (local.get $dx) (local.get $x))
            (i32.add (local.get $dy) (local.get $y)) (local.get $source)))))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $cols)))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows)))
    (call $gdi_geometry_present (local.get $dst_hdc) (local.get $dst)
      (local.get $dx) (local.get $dy)
      (i32.add (local.get $dx) (local.get $w))
      (i32.add (local.get $dy) (local.get $h)))
    (i32.const 1))

  (func $gdi_hdc_disabled_blt
        (param $dst_hdc i32) (param $dx_logical i32) (param $dy_logical i32)
        (param $w i32) (param $h i32) (param $src_hdc i32)
        (param $sx_logical i32) (param $sy_logical i32) (param $color_key i32)
        (result i32)
    (local $dst i32) (local $src i32) (local $dx i32) (local $dy i32)
    (local $sx i32) (local $sy i32) (local $x i32) (local $y i32)
    (local $source i32) (local $key i32)
    (if (i32.or (i32.le_s (local.get $w) (i32.const 0))
          (i32.le_s (local.get $h) (i32.const 0)))
      (then (return (i32.const 1))))
    (local.set $dst (global.get $GDI_BLIT_DST_DESC))
    (local.set $src (global.get $GDI_BLIT_SRC_DESC))
    (if (i32.or
          (i32.eqz (call $gdi_surface_descriptor (local.get $dst_hdc) (local.get $dst)))
          (i32.eqz (call $gdi_surface_descriptor (local.get $src_hdc) (local.get $src))))
      (then (return (i32.const 0))))
    (local.set $dx (call $gdi_line_map_x (local.get $dst) (local.get $dx_logical)))
    (local.set $dy (call $gdi_line_map_y (local.get $dst) (local.get $dy_logical)))
    (local.set $sx (call $gdi_line_map_x (local.get $src) (local.get $sx_logical)))
    (local.set $sy (call $gdi_line_map_y (local.get $src) (local.get $sy_logical)))
    (local.set $key (call $gdi_raster_swap_rb (local.get $color_key)))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_u (local.get $y) (local.get $h)))
      (local.set $x (i32.const 0))
      (block $cols_done (loop $cols
        (br_if $cols_done (i32.ge_u (local.get $x) (local.get $w)))
        (local.set $source (call $gdi_raster_read (local.get $src)
          (i32.add (local.get $sx) (local.get $x))
          (i32.add (local.get $sy) (local.get $y))))
        (if (i32.and (i32.ne (local.get $source) (i32.const -1))
              (i32.ne (local.get $source) (local.get $key)))
          (then
            (if (call $gdi_raster_clip_visible (local.get $dst_hdc) (local.get $dst)
                  (i32.add (i32.add (local.get $dx) (local.get $x)) (i32.const 1))
                  (i32.add (i32.add (local.get $dy) (local.get $y)) (i32.const 1)))
              (then (drop (call $gdi_raster_write (local.get $dst)
                (i32.add (i32.add (local.get $dx) (local.get $x)) (i32.const 1))
                (i32.add (i32.add (local.get $dy) (local.get $y)) (i32.const 1))
                (i32.const 0xFFFFFF)))))
            (if (call $gdi_raster_clip_visible (local.get $dst_hdc) (local.get $dst)
                  (i32.add (local.get $dx) (local.get $x))
                  (i32.add (local.get $dy) (local.get $y)))
              (then (drop (call $gdi_raster_write (local.get $dst)
                (i32.add (local.get $dx) (local.get $x))
                (i32.add (local.get $dy) (local.get $y)) (i32.const 0x808080)))))))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $cols)))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows)))
    (call $gdi_geometry_present (local.get $dst_hdc) (local.get $dst)
      (local.get $dx) (local.get $dy)
      (i32.add (i32.add (local.get $dx) (local.get $w)) (i32.const 1))
      (i32.add (i32.add (local.get $dy) (local.get $h)) (i32.const 1)))
    (i32.const 1))

  (func (export "test_gdi_raster_get_pixel") (param i32 i32 i32) (result i32)
    (call $gdi_raster_get_pixel (local.get 0) (local.get 1) (local.get 2)))
  (func (export "test_gdi_raster_set_pixel") (param i32 i32 i32 i32) (result i32)
    (call $gdi_raster_set_pixel (local.get 0) (local.get 1) (local.get 2) (local.get 3)))
  (func (export "test_gdi_apply_rop3") (param i32 i32 i32 i32) (result i32)
    (call $gdi_apply_rop3 (local.get 0) (local.get 1) (local.get 2) (local.get 3)))
  (func (export "test_gdi_fast_reset")
    (global.set $gdi_fast_span_hits (i32.const 0))
    (global.set $gdi_fast_bitblt_hits (i32.const 0))
    (global.set $gdi_fast_stretch_hits (i32.const 0)))
  (func (export "test_gdi_fast_count") (param i32) (result i32)
    (if (result i32) (i32.eq (local.get 0) (i32.const 0))
      (then (global.get $gdi_fast_span_hits))
      (else (if (result i32) (i32.eq (local.get 0) (i32.const 1))
        (then (global.get $gdi_fast_bitblt_hits))
        (else (global.get $gdi_fast_stretch_hits))))))
  (func (export "test_gdi_raster_bitblt")
        (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)
    (call $gdi_raster_bitblt (i32.const 0) (i32.const 0)
      (local.get 0) (local.get 1) (local.get 2)
      (local.get 3) (local.get 4) (local.get 5) (local.get 6) (local.get 7)
      (local.get 8) (local.get 9)))
  (func (export "test_gdi_raster_stretch_blt")
        (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)
    (call $gdi_raster_stretch_blt (i32.const 0) (i32.const 0)
      (local.get 0) (local.get 1) (local.get 2)
      (local.get 3) (local.get 4) (local.get 5) (local.get 6) (local.get 7)
      (local.get 8) (local.get 9) (local.get 10) (local.get 11)))

  ;; Build a raster descriptor from BITMAPINFO plus guest-visible pixel bytes.
  ;; Supports uncompressed BI_RGB 1/4/8/24/32bpp. Indexed descriptors point
  ;; directly at their RGBQUAD table in +24/+28; they do not create a GDI
  ;; object merely to decode application-owned source pixels.
  (func $gdi_raster_desc_from_bmi (param $desc i32) (param $bits i32) (param $bmi i32)
        (result i32)
    (local $header_size i32) (local $w i32) (local $h i32) (local $bpp i32)
    (local $compression i32) (local $top_down i32) (local $palette_count i32)
    (local $masks i32)
    (if (i32.or (i32.eqz (local.get $desc))
          (i32.or (i32.eqz (local.get $bits)) (i32.eqz (local.get $bmi))))
      (then (return (i32.const 0))))
    (local.set $header_size (i32.load (local.get $bmi)))
    (if (i32.or (i32.lt_u (local.get $header_size) (i32.const 40))
          (i32.gt_u (local.get $header_size) (i32.const 124)))
      (then (return (i32.const 0))))
    (local.set $w (i32.load offset=4 (local.get $bmi)))
    (local.set $h (i32.load offset=8 (local.get $bmi)))
    (local.set $bpp (i32.load16_u offset=14 (local.get $bmi)))
    (local.set $compression (i32.load offset=16 (local.get $bmi)))
    (if (i32.or (i32.le_s (local.get $w) (i32.const 0))
          (i32.or (i32.eqz (local.get $h))
            (i32.and
              (i32.and (i32.ne (local.get $bpp) (i32.const 1))
                (i32.and (i32.ne (local.get $bpp) (i32.const 4))
                  (i32.ne (local.get $bpp) (i32.const 8))))
              (i32.and (i32.ne (local.get $bpp) (i32.const 24))
                (i32.and (i32.ne (local.get $bpp) (i32.const 16))
                  (i32.ne (local.get $bpp) (i32.const 32)))))))
      (then (return (i32.const 0))))
    (if (i32.or (i32.ne (i32.load16_u offset=12 (local.get $bmi)) (i32.const 1))
          (i32.and (i32.ne (local.get $compression) (i32.const 0))
            (i32.or (i32.ne (local.get $compression) (i32.const 3))
              (i32.ne (local.get $bpp) (i32.const 16)))))
      (then (return (i32.const 0))))
    (local.set $top_down (i32.lt_s (local.get $h) (i32.const 0)))
    (if (local.get $top_down) (then (local.set $h (i32.sub (i32.const 0) (local.get $h)))))
    (memory.fill (local.get $desc) (i32.const 0) (i32.const 80))
    (i32.store (local.get $desc) (local.get $bits))
    (i32.store offset=4 (local.get $desc) (local.get $w))
    (i32.store offset=8 (local.get $desc) (local.get $h))
    (i32.store offset=12 (local.get $desc)
      (i32.shl (i32.shr_u
        (i32.add (i32.mul (local.get $w) (local.get $bpp)) (i32.const 31))
        (i32.const 5)) (i32.const 2)))
    (i32.store offset=16 (local.get $desc) (local.get $bpp))
    (i32.store offset=20 (local.get $desc) (local.get $top_down))
    (if (i32.le_u (local.get $bpp) (i32.const 8))
      (then
        (local.set $palette_count (i32.load offset=32 (local.get $bmi)))
        (if (i32.eqz (local.get $palette_count))
          (then (local.set $palette_count (i32.shl (i32.const 1) (local.get $bpp)))))
        (if (i32.gt_u (local.get $palette_count)
              (i32.shl (i32.const 1) (local.get $bpp)))
          (then (return (i32.const 0))))
        (i32.store offset=24 (local.get $desc)
          (i32.add (local.get $bmi) (local.get $header_size)))
        (i32.store offset=28 (local.get $desc) (local.get $palette_count))))
    (if (i32.eq (local.get $bpp) (i32.const 16))
      (then
        (if (i32.eq (local.get $compression) (i32.const 3))
          (then
            (if (i32.and (i32.ne (local.get $header_size) (i32.const 40))
                  (i32.lt_u (local.get $header_size) (i32.const 52)))
              (then (return (i32.const 0))))
            (local.set $masks (i32.add (local.get $bmi) (i32.const 40)))
            (if (i32.eqz (call $gdi_color_masks_valid (local.get $masks)))
              (then (return (i32.const 0)))))
          (else (local.set $masks (global.get $GDI_RGB555_MASKS))))
        (i32.store offset=24 (local.get $desc) (i32.load (local.get $masks)))
        (i32.store offset=28 (local.get $desc) (i32.load offset=4 (local.get $masks)))
        (i32.store offset=64 (local.get $desc) (i32.load offset=8 (local.get $masks)))))
    (i32.const 1))

  ;; Build a transient source descriptor for APIs that accept a DIB color-use
  ;; mode. DIB_PAL_COLORS stores WORD indexes in bmiColors; resolve those
  ;; indexes through the logical palette selected in hdc into a synchronous
  ;; RGBQUAD scratch table consumed by the software rasterizer.
  (func $gdi_raster_desc_from_bmi_usage
        (param $desc i32) (param $bits i32) (param $bmi i32)
        (param $usage i32) (param $hdc i32) (result i32)
    (local $bpp i32) (local $count i32) (local $table i32)
    (local $palette i32) (local $i i32) (local $index i32) (local $color i32)
    (if (i32.gt_u (local.get $usage) (i32.const 1))
      (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_raster_desc_from_bmi
          (local.get $desc) (local.get $bits) (local.get $bmi)))
      (then (return (i32.const 0))))
    (local.set $bpp (i32.load offset=16 (local.get $desc)))
    (if (i32.or (i32.eqz (local.get $usage))
          (i32.gt_u (local.get $bpp) (i32.const 8)))
      (then (return (i32.const 1))))
    (local.set $count (i32.load offset=28 (local.get $desc)))
    (if (i32.gt_u (local.get $count) (i32.const 256))
      (then (return (i32.const 0))))
    (local.set $table (i32.add (local.get $bmi) (i32.load (local.get $bmi))))
    (local.set $palette (call $gdi_dc_selected_palette (local.get $hdc)))
    (block $done (loop $resolve
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $index (i32.load16_u
        (i32.add (local.get $table) (i32.shl (local.get $i) (i32.const 1)))))
      (local.set $color (call $gdi_palette_colorref
        (local.get $palette) (local.get $index)))
      ;; Win9x accepts DIB_PAL_COLORS tables that name slots beyond the
      ;; selected logical palette. Treat those unused slots as black instead
      ;; of rejecting an otherwise valid DIB (QBob supplies 256 identity
      ;; indexes with the system palette's 236 usable entries).
      (if (i32.eq (local.get $color) (i32.const -1))
        (then (local.set $color (i32.const 0))))
      (i32.store (i32.add (global.get $GDI_PALETTE_RESOLVE)
          (i32.shl (local.get $i) (i32.const 2)))
        (call $gdi_raster_swap_rb (local.get $color)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $resolve)))
    (i32.store offset=24 (local.get $desc) (global.get $GDI_PALETTE_RESOLVE))
    (i32.const 1))

  (func $gdi_raster_desc_from_bitmap (param $bitmap i32) (param $desc i32) (result i32)
    (local $record i32)
    (local.set $record (call $gdi_object_record (local.get $bitmap)))
    (if (i32.or (i32.eqz (local.get $desc))
          (i32.eqz (call $gdi_bitmap_record_valid (local.get $record))))
      (then (return (i32.const 0))))
    (memory.fill (local.get $desc) (i32.const 0) (i32.const 80))
    (i32.store (local.get $desc) (i32.load offset=24 (local.get $record)))
    (i32.store offset=4 (local.get $desc) (i32.load offset=8 (local.get $record)))
    (i32.store offset=8 (local.get $desc) (i32.load offset=12 (local.get $record)))
    (i32.store offset=12 (local.get $desc) (i32.load offset=28 (local.get $record)))
    (i32.store offset=16 (local.get $desc) (i32.load offset=16 (local.get $record)))
    (i32.store offset=20 (local.get $desc)
      (i32.and (i32.shr_u (i32.load offset=20 (local.get $record)) (i32.const 1)) (i32.const 1)))
    (i32.store offset=24 (local.get $desc) (i32.load offset=32 (local.get $record)))
    (i32.store offset=28 (local.get $desc) (i32.load offset=36 (local.get $record)))
    (i32.store offset=40 (local.get $desc) (i32.const 1))
    (i32.store offset=44 (local.get $desc) (i32.const 1))
    (i32.store offset=56 (local.get $desc) (i32.const 1))
    (i32.store offset=60 (local.get $desc) (i32.const 1))
    (i32.store offset=68 (local.get $desc) (i32.load offset=40 (local.get $record)))
    (i32.const 1))

  (func $gdi_get_dibits
        (param $hdc i32) (param $bitmap i32) (param $start_scan i32) (param $scan_count i32)
        (param $bits i32) (param $bmi i32) (param $color_use i32) (result i32)
    (local $src i32) (local $dst i32) (local $record i32)
    (local $width i32) (local $height i32) (local $bpp i32) (local $lines i32)
    (local $x i32) (local $y i32) (local $source_y i32) (local $color i32)
    (local $header_size i32) (local $palette_count i32) (local $table i32)
    (local $selected_palette i32) (local $index i32) (local $desired i32)
    (local $requested_bpp i32) (local $compression i32) (local $masks i32)
    (if (i32.or (i32.gt_u (local.get $color_use) (i32.const 1))
          (i32.eqz (local.get $bmi)))
      (then (return (i32.const 0))))
    (local.set $src (global.get $GDI_BLIT_SRC_DESC))
    (local.set $dst (global.get $GDI_BLIT_DST_DESC))
    (if (i32.eqz (call $gdi_raster_desc_from_bitmap (local.get $bitmap) (local.get $src)))
      (then (return (i32.const 0))))
    (local.set $record (call $gdi_object_record (local.get $bitmap)))
    (local.set $width (i32.load offset=4 (local.get $src)))
    (local.set $height (i32.load offset=8 (local.get $src)))
    (local.set $bpp (i32.load offset=16 (local.get $src)))
    (local.set $header_size (i32.load (local.get $bmi)))
    (if (i32.lt_u (local.get $header_size) (i32.const 40))
      (then (return (i32.const 0))))
    (i32.store offset=4 (local.get $bmi) (local.get $width))
    (if (i32.eqz (i32.load offset=8 (local.get $bmi)))
      (then (i32.store offset=8 (local.get $bmi) (local.get $height))))
    (i32.store16 offset=12 (local.get $bmi) (i32.const 1))
    (local.set $requested_bpp (i32.load16_u offset=14 (local.get $bmi)))
    (if (i32.eqz (local.get $requested_bpp))
      (then (i32.store16 offset=14 (local.get $bmi) (local.get $bpp))))
    (local.set $bpp (i32.load16_u offset=14 (local.get $bmi)))
    (local.set $compression (i32.load offset=16 (local.get $bmi)))
    (if (i32.eq (local.get $bpp) (i32.const 16))
      (then
        ;; A format-query for a non-RGB555 DIB section reports its owned masks.
        ;; An explicit caller request keeps and validates the supplied triplet.
        (if (i32.eqz (local.get $requested_bpp))
          (then
            (local.set $masks (i32.load offset=32 (local.get $record)))
            (if (i32.and (i32.eq (i32.load offset=36 (local.get $record)) (i32.const 3))
                  (call $gdi_color_masks_valid (local.get $masks)))
              (then
                (if (i32.or
                      (i32.ne (i32.load (local.get $masks)) (i32.const 0x7C00))
                      (i32.or
                        (i32.ne (i32.load offset=4 (local.get $masks)) (i32.const 0x03E0))
                        (i32.ne (i32.load offset=8 (local.get $masks)) (i32.const 0x001F))))
                  (then
                    (local.set $compression (i32.const 3))
                    (i32.store (i32.add (local.get $bmi) (i32.const 40))
                      (i32.load (local.get $masks)))
                    (i32.store (i32.add (local.get $bmi) (i32.const 44))
                      (i32.load offset=4 (local.get $masks)))
                    (i32.store (i32.add (local.get $bmi) (i32.const 48))
                      (i32.load offset=8 (local.get $masks)))))))))
        (if (i32.and (i32.ne (local.get $compression) (i32.const 0))
              (i32.ne (local.get $compression) (i32.const 3)))
          (then (return (i32.const 0))))
        (if (i32.and (i32.eq (local.get $compression) (i32.const 3))
              (i32.eqz (call $gdi_color_masks_valid
                (i32.add (local.get $bmi) (i32.const 40)))))
          (then (return (i32.const 0))))
        (i32.store offset=16 (local.get $bmi) (local.get $compression)))
      (else (i32.store offset=16 (local.get $bmi) (i32.const 0))))
    (if (i32.le_u (local.get $bpp) (i32.const 8))
      (then
        (local.set $palette_count (i32.load offset=32 (local.get $bmi)))
        (if (i32.eqz (local.get $palette_count))
          (then (local.set $palette_count
            (i32.shl (i32.const 1) (local.get $bpp)))))
        (if (i32.gt_u (local.get $palette_count)
              (i32.shl (i32.const 1) (local.get $bpp)))
          (then (return (i32.const 0))))
        (i32.store offset=32 (local.get $bmi) (local.get $palette_count))
        (local.set $table (i32.add (local.get $bmi) (local.get $header_size)))
        (if (i32.eqz (local.get $color_use))
          (then
            (local.set $x (i32.const 0))
            (block $rgb_done (loop $rgb_table
              (br_if $rgb_done (i32.ge_u (local.get $x) (local.get $palette_count)))
              (local.set $desired
                (if (result i32) (i32.and
                      (i32.le_u (i32.load offset=16 (local.get $src)) (i32.const 8))
                      (i32.lt_u (local.get $x) (i32.load offset=28 (local.get $src))))
                  (then (call $gdi_raster_palette_color (local.get $src) (local.get $x)))
                  (else (call $gdi_raster_default_palette
                    (local.get $bpp) (local.get $x)))))
              (i32.store (i32.add (local.get $table)
                  (i32.shl (local.get $x) (i32.const 2)))
                (local.get $desired))
              (local.set $x (i32.add (local.get $x) (i32.const 1)))
              (br $rgb_table))))
          (else
            (local.set $selected_palette
              (call $gdi_dc_selected_palette (local.get $hdc)))
            (local.set $x (i32.const 0))
            (block $pal_done (loop $pal_table
              (br_if $pal_done (i32.ge_u (local.get $x) (local.get $palette_count)))
              (local.set $desired
                (if (result i32) (i32.and
                      (i32.le_u (i32.load offset=16 (local.get $src)) (i32.const 8))
                      (i32.lt_u (local.get $x) (i32.load offset=28 (local.get $src))))
                  (then (call $gdi_raster_palette_color (local.get $src) (local.get $x)))
                  (else (call $gdi_raster_default_palette
                    (local.get $bpp) (local.get $x)))))
              (local.set $index (call $gdi_palette_nearest_index
                (local.get $selected_palette)
                (call $gdi_raster_swap_rb (local.get $desired))))
              (if (i32.eq (local.get $index) (i32.const -1))
                (then (return (i32.const 0))))
              (i32.store16 (i32.add (local.get $table)
                  (i32.shl (local.get $x) (i32.const 1)))
                (local.get $index))
              (local.set $x (i32.add (local.get $x) (i32.const 1)))
              (br $pal_table)))))))
    (if (i32.eqz (local.get $bits)) (then (return (local.get $height))))
    (if (i32.ge_u (local.get $start_scan) (local.get $height))
      (then (return (i32.const 0))))
    (local.set $lines (local.get $scan_count))
    (if (i32.gt_u (local.get $lines) (i32.sub (local.get $height) (local.get $start_scan)))
      (then (local.set $lines (i32.sub (local.get $height) (local.get $start_scan)))))
    (if (i32.eqz (call $gdi_raster_desc_from_bmi_usage
          (local.get $dst) (local.get $bits) (local.get $bmi)
          (local.get $color_use) (local.get $hdc)))
      (then (return (i32.const 0))))
    (i32.store offset=8 (local.get $dst) (local.get $lines))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_u (local.get $y) (local.get $lines)))
      (local.set $source_y (i32.sub (i32.sub (local.get $height) (local.get $start_scan))
        (i32.add (local.get $y) (i32.const 1))))
      (local.set $x (i32.const 0))
      (block $cols_done (loop $cols
        (br_if $cols_done (i32.ge_u (local.get $x) (local.get $width)))
        (local.set $color (call $gdi_raster_read
          (local.get $src) (local.get $x) (local.get $source_y)))
        (if (i32.eq (local.get $color) (i32.const -1)) (then (return (i32.const 0))))
        (drop (call $gdi_raster_write (local.get $dst) (local.get $x)
          (i32.sub (i32.sub (local.get $lines) (local.get $y)) (i32.const 1))
          (local.get $color)))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $cols)))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows)))
    (local.get $lines))

  (func $gdi_set_dibits
        (param $hdc i32) (param $bitmap i32) (param $start_scan i32) (param $scan_count i32)
        (param $bits i32) (param $bmi i32) (param $color_use i32) (result i32)
    (local $dst i32) (local $src i32) (local $height i32) (local $width i32)
    (local $lines i32) (local $x i32) (local $y i32) (local $dest_y i32) (local $color i32)
    (if (i32.or (i32.gt_u (local.get $color_use) (i32.const 1))
          (i32.or (i32.eqz (local.get $bits)) (i32.eqz (local.get $bmi))))
      (then (return (i32.const 0))))
    (local.set $dst (global.get $GDI_BLIT_DST_DESC))
    (local.set $src (global.get $GDI_BLIT_SRC_DESC))
    (if (i32.or
          (i32.eqz (call $gdi_raster_desc_from_bitmap (local.get $bitmap) (local.get $dst)))
          (i32.eqz (call $gdi_raster_desc_from_bmi_usage
            (local.get $src) (local.get $bits) (local.get $bmi)
            (local.get $color_use) (local.get $hdc))))
      (then (return (i32.const 0))))
    (local.set $width (i32.load offset=4 (local.get $dst)))
    (if (i32.gt_u (local.get $width) (i32.load offset=4 (local.get $src)))
      (then (local.set $width (i32.load offset=4 (local.get $src)))))
    (local.set $height (i32.load offset=8 (local.get $dst)))
    (if (i32.ge_u (local.get $start_scan) (local.get $height))
      (then (return (i32.const 0))))
    (local.set $lines (local.get $scan_count))
    (if (i32.gt_u (local.get $lines) (i32.sub (local.get $height) (local.get $start_scan)))
      (then (local.set $lines (i32.sub (local.get $height) (local.get $start_scan)))))
    (if (i32.gt_u (local.get $lines) (i32.load offset=8 (local.get $src)))
      (then (local.set $lines (i32.load offset=8 (local.get $src)))))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_u (local.get $y) (local.get $lines)))
      (local.set $dest_y (i32.sub (i32.sub (local.get $height) (local.get $start_scan))
        (i32.add (local.get $y) (i32.const 1))))
      (local.set $x (i32.const 0))
      (block $cols_done (loop $cols
        (br_if $cols_done (i32.ge_u (local.get $x) (local.get $width)))
        (local.set $color (call $gdi_raster_read
          (local.get $src) (local.get $x)
          (i32.sub (i32.sub (local.get $lines) (local.get $y)) (i32.const 1))))
        (if (i32.eq (local.get $color) (i32.const -1)) (then (return (i32.const 0))))
        (drop (call $gdi_raster_write
          (local.get $dst) (local.get $x) (local.get $dest_y) (local.get $color)))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $cols)))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows)))
    (drop (call $host_gdi_surface_upload (i32.load offset=68 (local.get $dst))
      (i32.const 0) (i32.sub (local.get $height) (i32.add (local.get $start_scan) (local.get $lines)))
      (local.get $width) (i32.sub (local.get $height) (local.get $start_scan))))
    (local.get $lines))

  (func $gdi_get_dib_color_table (param $hdc i32) (param $start i32)
        (param $count_in i32) (param $colors i32) (result i32)
    (local $record i32) (local $palette i32) (local $available i32) (local $count i32)
    (local $i i32) (local $color i32)
    (if (i32.eqz (local.get $colors)) (then (return (i32.const 0))))
    (local.set $record (call $gdi_dc_bitmap_record (local.get $hdc)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (local.set $palette (i32.load offset=32 (local.get $record)))
    (local.set $available (i32.load offset=36 (local.get $record)))
    (if (i32.ge_u (local.get $start) (local.get $available))
      (then (return (i32.const 0))))
    (local.set $count (local.get $count_in))
    (if (i32.gt_u (local.get $count) (i32.sub (local.get $available) (local.get $start)))
      (then (local.set $count (i32.sub (local.get $available) (local.get $start)))))
    (block $done (loop $entries
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (if (local.get $palette)
        (then (local.set $color (i32.load (i32.add (local.get $palette)
          (i32.shl (i32.add (local.get $start) (local.get $i)) (i32.const 2))))))
        (else (local.set $color (call $gdi_raster_default_palette
          (i32.load offset=16 (local.get $record))
          (i32.add (local.get $start) (local.get $i))))))
      (i32.store (i32.add (local.get $colors) (i32.shl (local.get $i) (i32.const 2)))
        (local.get $color))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $entries)))
    (local.get $count))

  (func $gdi_set_dib_color_table (param $hdc i32) (param $start i32)
        (param $count_in i32) (param $colors i32) (result i32)
    (local $record i32) (local $palette i32) (local $available i32) (local $count i32)
    (if (i32.eqz (local.get $colors)) (then (return (i32.const 0))))
    (local.set $record (call $gdi_dc_bitmap_record (local.get $hdc)))
    (if (i32.or (i32.eqz (local.get $record))
          (i32.or (i32.eqz (i32.and (i32.load offset=20 (local.get $record)) (i32.const 1)))
            (i32.gt_u (i32.load offset=16 (local.get $record)) (i32.const 8))))
      (then (return (i32.const 0))))
    (local.set $palette (i32.load offset=32 (local.get $record)))
    (local.set $available (i32.load offset=36 (local.get $record)))
    (if (i32.or (i32.eqz (local.get $palette))
          (i32.ge_u (local.get $start) (local.get $available)))
      (then (return (i32.const 0))))
    (local.set $count (local.get $count_in))
    (if (i32.gt_u (local.get $count) (i32.sub (local.get $available) (local.get $start)))
      (then (local.set $count (i32.sub (local.get $available) (local.get $start)))))
    (memory.copy (i32.add (local.get $palette)
        (i32.shl (local.get $start) (i32.const 2)))
      (local.get $colors) (i32.shl (local.get $count) (i32.const 2)))
    ;; Palette changes recolor every indexed pixel, even though the pixel bytes
    ;; themselves are unchanged.
    (drop (call $host_gdi_surface_upload (i32.load offset=40 (local.get $record))
      (i32.const 0) (i32.const 0)
      (i32.load offset=8 (local.get $record))
      (i32.load offset=12 (local.get $record))))
    (local.get $count))

  (func $gdi_stretch_dibits
        (param $hdc i32) (param $dx i32) (param $dy i32) (param $dw i32) (param $dh i32)
        (param $sx i32) (param $sy i32) (param $sw i32) (param $sh i32)
        (param $bits i32) (param $bmi i32) (param $usage i32) (param $rop i32) (result i32)
    (local $dst i32) (local $src i32) (local $mdx i32) (local $mdy i32)
    (local $pattern i32) (local $ok i32)
    (if (i32.gt_u (local.get $usage) (i32.const 1)) (then (return (i32.const 0))))
    (local.set $dst (global.get $GDI_BLIT_DST_DESC))
    (local.set $src (global.get $GDI_BLIT_SRC_DESC))
    (if (i32.or (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $dst)))
          (i32.eqz (call $gdi_raster_desc_from_bmi_usage
            (local.get $src) (local.get $bits) (local.get $bmi)
            (local.get $usage) (local.get $hdc))))
      (then (return (i32.const 0))))
    (local.set $mdx (call $gdi_line_map_x (local.get $dst) (local.get $dx)))
    (local.set $mdy (call $gdi_line_map_y (local.get $dst) (local.get $dy)))
    (local.set $ok (call $gdi_raster_stretch_blt
      (local.get $hdc) (i32.const 0) (local.get $dst) (local.get $mdx) (local.get $mdy)
      (local.get $dw) (local.get $dh) (local.get $src)
      (local.get $sx) (local.get $sy) (local.get $sw) (local.get $sh)
      (local.get $pattern) (local.get $rop)))
    (if (i32.eqz (local.get $ok)) (then (return (i32.const 0))))
    (call $gdi_geometry_present (local.get $hdc) (local.get $dst)
      (local.get $mdx) (local.get $mdy)
      (i32.add (local.get $mdx) (local.get $dw))
      (i32.add (local.get $mdy) (local.get $dh)))
    (local.get $sh))

  ;; SetDIBitsToDevice is a source decode plus SRCCOPY into the selected
  ;; canonical surface. JavaScript only receives the resulting dirty upload.
  (func $gdi_set_dib_to_device
        (param $hdc i32) (param $dx i32) (param $dy i32)
        (param $w i32) (param $h i32) (param $sx i32) (param $sy i32)
        (param $start_scan i32) (param $line_count i32)
        (param $bits i32) (param $bmi i32) (param $color_use i32) (result i32)
    (local $dst i32) (local $src i32) (local $mdx i32) (local $mdy i32)
    (local $lines i32) (local $ok i32)
    (if (i32.or (i32.gt_u (local.get $color_use) (i32.const 1))
          (i32.or (i32.le_s (local.get $w) (i32.const 0))
            (i32.or (i32.le_s (local.get $h) (i32.const 0))
              (i32.le_s (local.get $line_count) (i32.const 0)))))
      (then (return (i32.const 0))))
    (local.set $dst (global.get $GDI_BLIT_DST_DESC))
    (local.set $src (global.get $GDI_BLIT_SRC_DESC))
    (if (i32.or (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $dst)))
          (i32.eqz (call $gdi_raster_desc_from_bmi_usage
            (local.get $src) (local.get $bits) (local.get $bmi)
            (local.get $color_use) (local.get $hdc))))
      (then (return (i32.const 0))))
    (if (i32.ge_u (local.get $start_scan) (i32.load offset=8 (local.get $src)))
      (then (return (i32.const 0))))
    (local.set $mdx (call $gdi_line_map_x (local.get $dst) (local.get $dx)))
    (local.set $mdy (call $gdi_line_map_y (local.get $dst) (local.get $dy)))
    (local.set $lines (local.get $line_count))
    (if (i32.gt_u (local.get $lines)
          (i32.sub (i32.load offset=8 (local.get $src)) (local.get $start_scan)))
      (then (local.set $lines
        (i32.sub (i32.load offset=8 (local.get $src)) (local.get $start_scan)))))
    (if (i32.gt_u (local.get $lines) (local.get $h))
      (then (local.set $lines (local.get $h))))
    ;; lpvBits points at the first byte of the scanline slice supplied by this
    ;; call, not necessarily at the first byte of the full biHeight bitmap.
    ;; Winmine uses one 16-line pointer into a 256-line sprite sheet per call.
    (i32.store offset=8 (local.get $src) (local.get $lines))
    (local.set $ok (call $gdi_raster_bitblt
      (local.get $hdc) (i32.const 0) (local.get $dst) (local.get $mdx) (local.get $mdy)
      (local.get $w) (local.get $lines) (local.get $src)
      (local.get $sx) (local.get $sy)
      (i32.const 0) (i32.const 0x00CC0020)))
    (if (i32.eqz (local.get $ok)) (then (return (i32.const 0))))
    (call $gdi_geometry_present (local.get $hdc) (local.get $dst)
      (local.get $mdx) (local.get $mdy)
      (i32.add (local.get $mdx) (local.get $w))
      (i32.add (local.get $mdy) (local.get $lines)))
    (local.get $lines))

  ;; ROP4 combines foreground/background ROP3 bytes using a 1bpp mask. Mask
  ;; scanlines are DWORD aligned and top-down for this kernel fixture API.
  (func $gdi_raster_mask_blt (param $dst i32) (param $dx i32) (param $dy i32)
        (param $w i32) (param $h i32) (param $src i32) (param $sx i32) (param $sy i32)
        (param $mask i32) (param $mask_stride i32) (param $mx i32) (param $my i32)
        (param $pattern i32) (param $rop4 i32) (result i32)
    (local $x i32) (local $y i32) (local $m i32) (local $rop3 i32)
    (local $s i32) (local $d i32)
    (if (i32.or (i32.eqz (local.get $mask))
          (i32.or (i32.le_s (local.get $mask_stride) (i32.const 0))
            (i32.or (i32.le_s (local.get $w) (i32.const 0)) (i32.le_s (local.get $h) (i32.const 0)))))
      (then (return (i32.const 0))))
    (if (i32.or (i32.eqz (call $gdi_raster_surface_valid (local.get $dst)))
          (i32.eqz (call $gdi_raster_surface_valid (local.get $src))))
      (then (return (i32.const 0))))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_u (local.get $y) (local.get $h)))
      (local.set $x (i32.const 0))
      (block $cols_done (loop $cols
        (br_if $cols_done (i32.ge_u (local.get $x) (local.get $w)))
        (if (call $gdi_raster_pixel_ptr (local.get $dst)
              (i32.add (local.get $dx) (local.get $x)) (i32.add (local.get $dy) (local.get $y)))
          (then
            (local.set $m (i32.and (i32.load8_u (i32.add (local.get $mask)
              (i32.add (i32.mul (i32.add (local.get $my) (local.get $y)) (local.get $mask_stride))
                (i32.shr_u (i32.add (local.get $mx) (local.get $x)) (i32.const 3)))))
              (i32.shr_u (i32.const 0x80)
                (i32.and (i32.add (local.get $mx) (local.get $x)) (i32.const 7)))))
            (local.set $rop3 (select (i32.and (i32.shr_u (local.get $rop4) (i32.const 16)) (i32.const 0xFF))
              (i32.and (i32.shr_u (local.get $rop4) (i32.const 24)) (i32.const 0xFF))
              (i32.ne (local.get $m) (i32.const 0))))
            (local.set $s (call $gdi_raster_read (local.get $src)
              (i32.add (local.get $sx) (local.get $x)) (i32.add (local.get $sy) (local.get $y))))
            (if (i32.eq (local.get $s) (i32.const -1)) (then (return (i32.const 0))))
            (local.set $d (call $gdi_raster_read (local.get $dst)
              (i32.add (local.get $dx) (local.get $x)) (i32.add (local.get $dy) (local.get $y))))
            (drop (call $gdi_raster_write (local.get $dst)
              (i32.add (local.get $dx) (local.get $x)) (i32.add (local.get $dy) (local.get $y))
              (call $gdi_apply_rop3 (local.get $rop3) (local.get $pattern)
                (local.get $s) (local.get $d))))))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $cols)))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows)))
    (i32.const 1))

  (func (export "test_gdi_raster_desc_from_bmi") (param i32 i32 i32) (result i32)
    (call $gdi_raster_desc_from_bmi (local.get 0) (local.get 1) (local.get 2)))
  (func (export "test_gdi_raster_desc_from_bitmap") (param i32 i32) (result i32)
    (call $gdi_raster_desc_from_bitmap (local.get 0) (local.get 1)))
  (func (export "test_gdi_raster_mask_blt")
        (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)
    (call $gdi_raster_mask_blt (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (local.get 4) (local.get 5) (local.get 6) (local.get 7) (local.get 8)
      (local.get 9) (local.get 10) (local.get 11) (local.get 12) (local.get 13)))

  ;; Direct exports keep clip semantics independently testable without routing
  ;; through the x86 stdcall dispatcher.
  (func (export "test_gdi_dc_clip_select")
        (param i32) (param i32) (result i32)
    (local $result i32)
    (local.set $result (call $gdi_dc_clip_select (local.get 0) (local.get 1)))
    (local.get $result))
  (func (export "test_gdi_dc_clip_ext_select")
        (param i32) (param i32) (param i32) (result i32)
    (local $result i32)
    (local.set $result (call $gdi_dc_clip_ext_select (local.get 0) (local.get 1) (local.get 2)))
    (local.get $result))
  (func (export "test_gdi_dc_clip_intersect_rect")
        (param i32) (param i32) (param i32) (param i32) (param i32) (result i32)
    (local $result i32)
    (local.set $result (call $gdi_dc_clip_intersect_rect
      (local.get 0) (local.get 1) (local.get 2) (local.get 3) (local.get 4)))
    (local.get $result))
  (func (export "test_gdi_dc_clip_exclude_rect")
        (param i32) (param i32) (param i32) (param i32) (param i32) (result i32)
    (local $result i32)
    (local.set $result (call $gdi_dc_clip_exclude_rect
      (local.get 0) (local.get 1) (local.get 2) (local.get 3) (local.get 4)))
    (local.get $result))
  (func (export "test_gdi_dc_clip_offset")
        (param i32) (param i32) (param i32) (result i32)
    (local $result i32)
    (local.set $result (call $gdi_dc_clip_offset (local.get 0) (local.get 1) (local.get 2)))
    (local.get $result))
  (func (export "test_gdi_dc_clip_get")
        (param i32) (param i32) (result i32)
    (local $result i32)
    (local.set $result (call $gdi_dc_clip_get (local.get 0) (local.get 1)))
    (local.get $result))
  (func (export "test_gdi_dc_clip_get_box")
        (param i32) (param i32) (result i32)
    (local $result i32)
    (local.set $result (call $gdi_dc_clip_get_box (local.get 0) (local.get 1)))
    (local.get $result))
  (func (export "test_gdi_dc_clip_point_visible")
        (param i32) (param i32) (param i32) (result i32)
    (local $result i32)
    (local.set $result (call $gdi_dc_clip_point_visible (local.get 0) (local.get 1) (local.get 2)))
    (local.get $result))
  (func (export "test_gdi_dc_clip_rect_visible")
        (param i32) (param i32) (result i32)
    (local $result i32)
    (local.set $result (call $gdi_dc_clip_rect_visible (local.get 0) (local.get 1)))
    (local.get $result))
  (func (export "test_gdi_dc_clip_clear") (param i32) (result i32)
    (local $result i32)
    (local.set $result (call $gdi_dc_clip_clear (local.get 0)))
    (local.get $result))
  (func (export "test_gdi_dc_clip_release") (param i32)
    (call $gdi_dc_clip_release (local.get 0)))
  (func (export "test_gdi_dc_path_set_region") (param i32 i32) (result i32)
    (call $gdi_dc_path_set_region (local.get 0) (local.get 1)))
  (func (export "test_gdi_dc_path_select_clip") (param i32 i32) (result i32)
    (call $gdi_dc_path_select_clip (local.get 0) (local.get 1)))
  (func (export "test_gdi_dc_path_release") (param i32)
    (call $gdi_dc_path_release (local.get 0)))

  (func $gdi_rgn_set_rect (param $hrgn i32) (param $left_in i32) (param $top_in i32) (param $right_in i32) (param $bottom_in i32) (result i32)
    (local $record i32) (local $left i32) (local $top i32) (local $right i32) (local $bottom i32)
    (local.set $record (call $gdi_rgn_record (local.get $hrgn)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (local.set $left (local.get $left_in)) (local.set $top (local.get $top_in))
    (local.set $right (local.get $right_in)) (local.set $bottom (local.get $bottom_in))
    (if (i32.gt_s (local.get $left) (local.get $right))
      (then (local.set $left (local.get $right_in)) (local.set $right (local.get $left_in))))
    (if (i32.gt_s (local.get $top) (local.get $bottom))
      (then (local.set $top (local.get $bottom_in)) (local.set $bottom (local.get $top_in))))
    (call $gdi_rgn_write_rect (local.get $record)
      (local.get $left) (local.get $top) (local.get $right) (local.get $bottom))
    (drop (call $gdi_rgn_sync_mirror (local.get $record)))
    (i32.const 1))

  (func $gdi_rgn_get_box (param $hrgn i32) (param $rect i32) (result i32)
    (local $record i32)
    (local.set $record (call $gdi_rgn_record (local.get $hrgn)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (if (local.get $rect)
      (then
        (i32.store (local.get $rect) (i32.load offset=8 (local.get $record)))
        (i32.store offset=4 (local.get $rect) (i32.load offset=12 (local.get $record)))
        (i32.store offset=8 (local.get $rect) (i32.load offset=16 (local.get $record)))
        (i32.store offset=12 (local.get $rect) (i32.load offset=20 (local.get $record)))))
    (call $gdi_rgn_complexity_record (local.get $record)))

  (func $gdi_rgn_offset (param $hrgn i32) (param $dx i32) (param $dy i32) (result i32)
    (local $record i32) (local $base i32) (local $count i32) (local $i i32) (local $p i32)
    (local.set $record (call $gdi_rgn_record (local.get $hrgn)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (local.set $base (call $gdi_rgn_bands (local.get $record)))
    (local.set $count (i32.load offset=28 (local.get $record)))
    (block $done (loop $move
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $p (i32.add (local.get $base) (i32.shl (local.get $i) (i32.const 4))))
      (i32.store (local.get $p) (i32.add (i32.load (local.get $p)) (local.get $dx)))
      (i32.store offset=4 (local.get $p) (i32.add (i32.load offset=4 (local.get $p)) (local.get $dy)))
      (i32.store offset=8 (local.get $p) (i32.add (i32.load offset=8 (local.get $p)) (local.get $dx)))
      (i32.store offset=12 (local.get $p) (i32.add (i32.load offset=12 (local.get $p)) (local.get $dy)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $move)))
    (call $gdi_rgn_update_bbox (local.get $record))
    (drop (call $gdi_rgn_sync_mirror (local.get $record)))
    (call $gdi_rgn_complexity_record (local.get $record)))

  (func $gdi_rgn_first_y (param $base i32) (param $count i32) (result i32)
    (local $i i32) (local $best i32) (local $value i32)
    (local.set $best (i32.const 0x7FFFFFFF))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $value (i32.load offset=4
        (i32.add (local.get $base) (i32.shl (local.get $i) (i32.const 4)))))
      (if (i32.lt_s (local.get $value) (local.get $best)) (then (local.set $best (local.get $value))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $best))

  (func $gdi_rgn_next_y (param $base i32) (param $count i32) (param $y i32) (result i32)
    (local $i i32) (local $best i32) (local $p i32) (local $value i32)
    (local.set $best (i32.const 0x7FFFFFFF))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $p (i32.add (local.get $base) (i32.shl (local.get $i) (i32.const 4))))
      (local.set $value (i32.load offset=4 (local.get $p)))
      (if (i32.and (i32.gt_s (local.get $value) (local.get $y)) (i32.lt_s (local.get $value) (local.get $best)))
        (then (local.set $best (local.get $value))))
      (local.set $value (i32.load offset=12 (local.get $p)))
      (if (i32.and (i32.gt_s (local.get $value) (local.get $y)) (i32.lt_s (local.get $value) (local.get $best)))
        (then (local.set $best (local.get $value))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $best))

  (func $gdi_rgn_first_x (param $base i32) (param $count i32) (param $y i32) (result i32)
    (local $i i32) (local $best i32) (local $p i32) (local $value i32)
    (local.set $best (i32.const 0x7FFFFFFF))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $p (i32.add (local.get $base) (i32.shl (local.get $i) (i32.const 4))))
      (if (i32.and (i32.le_s (i32.load offset=4 (local.get $p)) (local.get $y))
            (i32.gt_s (i32.load offset=12 (local.get $p)) (local.get $y)))
        (then
          (local.set $value (i32.load (local.get $p)))
          (if (i32.lt_s (local.get $value) (local.get $best)) (then (local.set $best (local.get $value))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $best))

  (func $gdi_rgn_next_x (param $base i32) (param $count i32) (param $x i32) (param $y i32) (result i32)
    (local $i i32) (local $best i32) (local $p i32) (local $value i32)
    (local.set $best (i32.const 0x7FFFFFFF))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $p (i32.add (local.get $base) (i32.shl (local.get $i) (i32.const 4))))
      (if (i32.and (i32.le_s (i32.load offset=4 (local.get $p)) (local.get $y))
            (i32.gt_s (i32.load offset=12 (local.get $p)) (local.get $y)))
        (then
          (local.set $value (i32.load (local.get $p)))
          (if (i32.and (i32.gt_s (local.get $value) (local.get $x)) (i32.lt_s (local.get $value) (local.get $best)))
            (then (local.set $best (local.get $value))))
          (local.set $value (i32.load offset=8 (local.get $p)))
          (if (i32.and (i32.gt_s (local.get $value) (local.get $x)) (i32.lt_s (local.get $value) (local.get $best)))
            (then (local.set $best (local.get $value))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $best))

  (func $gdi_rgn_contains (param $base i32) (param $count i32) (param $x i32) (param $y i32) (result i32)
    (local $i i32) (local $p i32)
    (block $miss (loop $scan
      (br_if $miss (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $p (i32.add (local.get $base) (i32.shl (local.get $i) (i32.const 4))))
      (if (i32.and
            (i32.and (i32.le_s (i32.load (local.get $p)) (local.get $x))
              (i32.gt_s (i32.load offset=8 (local.get $p)) (local.get $x)))
            (i32.and (i32.le_s (i32.load offset=4 (local.get $p)) (local.get $y))
              (i32.gt_s (i32.load offset=12 (local.get $p)) (local.get $y))))
        (then (return (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  (func $gdi_rgn_mode_contains (param $mode i32) (param $a i32) (param $b i32) (result i32)
    (if (i32.eq (local.get $mode) (i32.const 1))
      (then (return (i32.and (local.get $a) (local.get $b)))))
    (if (i32.eq (local.get $mode) (i32.const 2))
      (then (return (i32.or (local.get $a) (local.get $b)))))
    (if (i32.eq (local.get $mode) (i32.const 3))
      (then (return (i32.xor (local.get $a) (local.get $b)))))
    (i32.and (local.get $a) (i32.eqz (local.get $b))))

  ;; Returns the canonical output RECT count, or -1 when the fixed arena cap
  ;; would be exceeded. Sources remain untouched, so dst may alias either one.
  (func $gdi_rgn_boolean_sweep (param $a_base i32) (param $a_count i32)
        (param $b_base i32) (param $b_count i32) (param $mode i32) (result i32)
    (local $out i32) (local $band i32) (local $out_count i32) (local $band_count i32)
    (local $prev_start i32) (local $prev_count i32) (local $same i32) (local $i i32)
    (local $y i32) (local $next_y i32) (local $x i32) (local $next_x i32)
    (local $candidate i32) (local $inside_a i32) (local $inside_b i32) (local $p i32)
    (local.set $out (global.get $GDI_REGION_WORK))
    (local.set $band (i32.add (global.get $GDI_REGION_WORK) (global.get $GDI_REGION_RECT_STRIDE)))
    (local.set $prev_start (i32.const -1))
    (local.set $y (call $gdi_rgn_first_y (local.get $a_base) (local.get $a_count)))
    (local.set $candidate (call $gdi_rgn_first_y (local.get $b_base) (local.get $b_count)))
    (if (i32.lt_s (local.get $candidate) (local.get $y)) (then (local.set $y (local.get $candidate))))
    (block $finished (loop $bands
      (br_if $finished (i32.eq (local.get $y) (i32.const 0x7FFFFFFF)))
      (local.set $next_y (call $gdi_rgn_next_y (local.get $a_base) (local.get $a_count) (local.get $y)))
      (local.set $candidate (call $gdi_rgn_next_y (local.get $b_base) (local.get $b_count) (local.get $y)))
      (if (i32.lt_s (local.get $candidate) (local.get $next_y)) (then (local.set $next_y (local.get $candidate))))
      (br_if $finished (i32.eq (local.get $next_y) (i32.const 0x7FFFFFFF)))
      (local.set $band_count (i32.const 0))
      (local.set $x (call $gdi_rgn_first_x (local.get $a_base) (local.get $a_count) (local.get $y)))
      (local.set $candidate (call $gdi_rgn_first_x (local.get $b_base) (local.get $b_count) (local.get $y)))
      (if (i32.lt_s (local.get $candidate) (local.get $x)) (then (local.set $x (local.get $candidate))))
      (block $x_done (loop $spans
        (br_if $x_done (i32.eq (local.get $x) (i32.const 0x7FFFFFFF)))
        (local.set $next_x (call $gdi_rgn_next_x
          (local.get $a_base) (local.get $a_count) (local.get $x) (local.get $y)))
        (local.set $candidate (call $gdi_rgn_next_x
          (local.get $b_base) (local.get $b_count) (local.get $x) (local.get $y)))
        (if (i32.lt_s (local.get $candidate) (local.get $next_x)) (then (local.set $next_x (local.get $candidate))))
        (br_if $x_done (i32.eq (local.get $next_x) (i32.const 0x7FFFFFFF)))
        (local.set $inside_a (call $gdi_rgn_contains
          (local.get $a_base) (local.get $a_count) (local.get $x) (local.get $y)))
        (local.set $inside_b (call $gdi_rgn_contains
          (local.get $b_base) (local.get $b_count) (local.get $x) (local.get $y)))
        (if (call $gdi_rgn_mode_contains (local.get $mode) (local.get $inside_a) (local.get $inside_b))
          (then
            (if (i32.and (i32.gt_u (local.get $band_count) (i32.const 0))
                  (i32.eq
                    (i32.load offset=8 (i32.add (local.get $band)
                      (i32.shl (i32.sub (local.get $band_count) (i32.const 1)) (i32.const 4))))
                    (local.get $x)))
              (then
                (i32.store offset=8 (i32.add (local.get $band)
                  (i32.shl (i32.sub (local.get $band_count) (i32.const 1)) (i32.const 4)))
                  (local.get $next_x)))
              (else
                (if (i32.ge_u (local.get $band_count) (global.get $GDI_REGION_MAX_RECTS))
                  (then (return (i32.const -1))))
                (local.set $p (i32.add (local.get $band) (i32.shl (local.get $band_count) (i32.const 4))))
                (i32.store (local.get $p) (local.get $x))
                (i32.store offset=4 (local.get $p) (local.get $y))
                (i32.store offset=8 (local.get $p) (local.get $next_x))
                (i32.store offset=12 (local.get $p) (local.get $next_y))
                (local.set $band_count (i32.add (local.get $band_count) (i32.const 1)))))))
        (local.set $x (local.get $next_x))
        (br $spans)))
      (if (i32.eqz (local.get $band_count))
        (then
          (local.set $prev_start (i32.const -1))
          (local.set $prev_count (i32.const 0)))
        (else
          (local.set $same (i32.and
            (i32.ge_s (local.get $prev_start) (i32.const 0))
            (i32.eq (local.get $prev_count) (local.get $band_count))))
          (local.set $i (i32.const 0))
          (block $compare_done (loop $compare
            (br_if $compare_done (i32.or (i32.eqz (local.get $same))
              (i32.ge_u (local.get $i) (local.get $band_count))))
            (if (i32.or
                  (i32.ne
                    (i32.load (i32.add (local.get $out)
                      (i32.shl (i32.add (local.get $prev_start) (local.get $i)) (i32.const 4))))
                    (i32.load (i32.add (local.get $band) (i32.shl (local.get $i) (i32.const 4)))))
                  (i32.or
                    (i32.ne
                      (i32.load offset=8 (i32.add (local.get $out)
                        (i32.shl (i32.add (local.get $prev_start) (local.get $i)) (i32.const 4))))
                      (i32.load offset=8 (i32.add (local.get $band) (i32.shl (local.get $i) (i32.const 4)))))
                    (i32.ne
                      (i32.load offset=12 (i32.add (local.get $out)
                        (i32.shl (i32.add (local.get $prev_start) (local.get $i)) (i32.const 4))))
                      (local.get $y))))
              (then (local.set $same (i32.const 0))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $compare)))
          (if (local.get $same)
            (then
              (local.set $i (i32.const 0))
              (block $extend_done (loop $extend
                (br_if $extend_done (i32.ge_u (local.get $i) (local.get $band_count)))
                (i32.store offset=12 (i32.add (local.get $out)
                  (i32.shl (i32.add (local.get $prev_start) (local.get $i)) (i32.const 4)))
                  (local.get $next_y))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (br $extend))))
            (else
              (if (i32.gt_u (i32.add (local.get $out_count) (local.get $band_count))
                    (global.get $GDI_REGION_MAX_RECTS))
                (then (return (i32.const -1))))
              (memory.copy
                (i32.add (local.get $out) (i32.shl (local.get $out_count) (i32.const 4)))
                (local.get $band)
                (i32.shl (local.get $band_count) (i32.const 4)))
              (local.set $prev_start (local.get $out_count))
              (local.set $prev_count (local.get $band_count))
              (local.set $out_count (i32.add (local.get $out_count) (local.get $band_count)))))))
      (local.set $y (local.get $next_y))
      (br $bands)))
    (local.get $out_count))

  (func $gdi_rgn_combine (param $dst i32) (param $src1 i32) (param $src2 i32) (param $mode i32) (result i32)
    (local $dst_record i32) (local $a i32) (local $b i32) (local $count i32)
    (local.set $dst_record (call $gdi_rgn_record (local.get $dst)))
    (local.set $a (call $gdi_rgn_record (local.get $src1)))
    (local.set $b (call $gdi_rgn_record (local.get $src2)))
    (if (i32.or (i32.lt_u (local.get $mode) (i32.const 1))
          (i32.gt_u (local.get $mode) (i32.const 5)))
      (then (return (i32.const 0))))
    ;; Canonical inputs use WAT Boolean algebra. COPY does not require src2.
    (if (i32.and
          (i32.ne (local.get $dst_record) (i32.const 0))
          (i32.and (i32.ne (local.get $a) (i32.const 0))
            (i32.and (i32.ne (i32.load (local.get $a)) (i32.const 3))
              (i32.or (i32.eq (local.get $mode) (i32.const 5))
                (i32.and (i32.ne (local.get $b) (i32.const 0))
                  (i32.ne (i32.load (local.get $b)) (i32.const 3)))))))
      (then
        (if (i32.eq (local.get $mode) (i32.const 5))
          (then
            (return (call $gdi_rgn_set_buffer
              (local.get $dst_record) (call $gdi_rgn_bands (local.get $a))
              (i32.load offset=28 (local.get $a))))))
        (local.set $count (call $gdi_rgn_boolean_sweep
          (call $gdi_rgn_bands (local.get $a)) (i32.load offset=28 (local.get $a))
          (call $gdi_rgn_bands (local.get $b)) (i32.load offset=28 (local.get $b))
          (local.get $mode)))
        (if (i32.ge_s (local.get $count) (i32.const 0))
          (then (return (call $gdi_rgn_set_buffer
            (local.get $dst_record) (global.get $GDI_REGION_WORK) (local.get $count)))))
        ;; Win32 permits CombineRgn to fail. Keep dst unchanged when the fixed
        ;; canonical arena cannot represent the result; never invoke JS region
        ;; algebra or corrupt a partially written destination.
        (return (i32.const 0))))
    (i32.const 0))

  (func $gdi_rgn_delete (param $hrgn i32) (result i32)
    (local $record i32)
    (local.set $record (call $gdi_rgn_record (local.get $hrgn)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (if (i32.load offset=24 (local.get $record))
      (then (drop (call $host_gdi_set_region_bands
        (i32.load offset=24 (local.get $record)) (i32.const 0) (i32.const -1)))))
    (i32.store (local.get $record) (i32.const 0))
    (i32.store offset=24 (local.get $record) (i32.const 0))
    (i32.store offset=28 (local.get $record) (i32.const 0))
    (i32.const 1))

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
    ;; Level 3: take first language entry
    (local.set $lang_off (i32.add (call $r_rva) (i32.and (local.get $d) (i32.const 0x7FFFFFFF))))
    (local.set $n (i32.add
      (i32.load16_u (call $g2w (i32.add (call $r_base) (i32.add (local.get $lang_off) (i32.const 12)))))
      (i32.load16_u (call $g2w (i32.add (call $r_base) (i32.add (local.get $lang_off) (i32.const 14)))))))
    (if (i32.eqz (local.get $n)) (then (return (i32.const 0))))
    ;; Return the data offset from first entry (skip directory header 16 bytes, read second dword)
    (local.set $d (call $gl32 (i32.add (call $r_base) (i32.add (local.get $lang_off) (i32.const 20)))))
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

  ;; Find DLL by UTF-16 name (WASM ptr), return guest load_addr or 0.
  (func $find_dll_by_wname (param $name_wa i32) (result i32)
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
          (if (call $wide_ascii_eq (local.get $name_wa) (local.get $exp_name_wa))
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

  (func $update_invalidate_full (param $hwnd i32)
    (local $cs i32) (local $wh i32) (local $w i32) (local $h i32)
    (if (i32.eqz (local.get $hwnd)) (then (return)))
    (local.set $cs (call $host_get_window_client_size (local.get $hwnd)))
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
              (local.set $cs (call $host_get_window_client_size (local.get $hwnd)))
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
                  (if (call $update_get_rect (local.get $hwnd) (global.get $PAINT_SCRATCH))
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
    (if (i32.eqz (call $update_get_rect (local.get $parent) (global.get $PAINT_SCRATCH)))
      (then (return (i32.const 0))))
    (local.set $pl (i32.load (global.get $PAINT_SCRATCH)))
    (local.set $pt (i32.load offset=4 (global.get $PAINT_SCRATCH)))
    (local.set $pr (i32.load offset=8 (global.get $PAINT_SCRATCH)))
    (local.set $pb (i32.load offset=12 (global.get $PAINT_SCRATCH)))
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
            (if (call $ctrl_table_get_class (local.get $hwnd))
              (then
                (if (i32.or
                      (call $wnd_has_pending_ancestor_erase (local.get $hwnd))
                      (call $wnd_has_pending_ancestor_paint (local.get $hwnd)))
                  (then
                    (local.set $i (i32.add (local.get $i) (i32.const 1)))
                    (br $scan)))
                (if (i32.eqz (call $wnd_is_effectively_visible (local.get $hwnd)))
                  (then
                    (call $paint_flag_clear_hwnd (local.get $hwnd))
                    (call $update_clear_hwnd (local.get $hwnd))
                    (br $found)))
                (if (call $update_get_rect (local.get $hwnd) (global.get $PAINT_SCRATCH))
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
  (func $paint_flush_shown_native_children (param $parent i32) (result i32)
    (local $slot i32) (local $ch i32) (local $style i32) (local $n i32)
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
      ;; Static/listbox/combobox/scrollbar controls are handled by the dialog
      ;; router/control wndprocs. They should not steal generic client clicks.
      (local.set $cls (call $ctrl_table_get_class (local.get $ch)))
      (if (i32.or
            (i32.or (i32.eq (local.get $cls) (i32.const 3))
                    (i32.eq (local.get $cls) (i32.const 5)))
            (i32.eq (local.get $cls) (i32.const 6)))
        (then
          (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
          (br $scan)))
      (local.set $x (call $wnd_window_screen_x (local.get $ch)))
      (local.set $y (call $wnd_window_screen_y (local.get $ch)))
      (local.set $w (call $wnd_screen_w (local.get $ch)))
      (local.set $h (call $wnd_screen_h (local.get $ch)))
      (if (i32.and
            (i32.and (i32.ge_s (local.get $sx) (local.get $x))
                     (i32.lt_s (local.get $sx) (i32.add (local.get $x) (local.get $w))))
            (i32.and (i32.ge_s (local.get $sy) (local.get $y))
                     (i32.lt_s (local.get $sy) (i32.add (local.get $y) (local.get $h)))))
        (then
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

  (func $clipboard_register_format_a (param $name_g i32) (result i32)
    (if (call $guest_str_is_rich_text_format_a (local.get $name_g))
      (then (return (call $clipboard_get_rtf_format_id))))
    (global.set $clipboard_fmt_counter
      (i32.add (global.get $clipboard_fmt_counter) (i32.const 1)))
    (i32.add (i32.const 0xC000) (global.get $clipboard_fmt_counter)))

  (func $clipboard_register_format_w (param $name_g i32) (result i32)
    (if (call $guest_str_is_rich_text_format_w (local.get $name_g))
      (then (return (call $clipboard_get_rtf_format_id))))
    (global.set $clipboard_fmt_counter
      (i32.add (global.get $clipboard_fmt_counter) (i32.const 1)))
    (i32.add (i32.const 0xC000) (global.get $clipboard_fmt_counter)))

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
    (if (i32.and
          (i32.ne (local.get $saved_dib) (i32.const 0))
          (i32.eq (local.get $len) (i32.const 1)))
      (then
        (local.set $selected_object
          (call $wordpad_richedit_selection_is_object (local.get $hwnd)))))
    (if (i32.eqz (local.get $saved_dib))
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
                (i32.const 4))))))))
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
                (i32.const 4))))))))
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
    (i32.const 1))

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
      (i32.div_u (i32.mul (local.get $dlg_y) (i32.const 7)) (i32.const 4))
      (i32.add
        (i32.div_u (i32.mul (local.get $dlg_cx) (i32.const 3)) (i32.const 2))
        (select
          (i32.const 8) (i32.const 0)
          (i32.eqz (i32.and (local.get $style) (i32.const 0x40000000)))))
      (i32.add
        (i32.div_u (i32.mul (local.get $dlg_cy) (i32.const 7)) (i32.const 4))
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
          (if (call $wide_ascii_prefix_eq (local.get $p) (i32.const 0x316B))
            (then (local.set $class_enum (i32.const 8))))
          (if (call $wide_ascii_prefix_eq (local.get $p) (i32.const 0x3141))
            (then (local.set $class_enum (i32.const 18))))
          (if (call $wide_ascii_eq (local.get $p) (i32.const 0x3150))
            (then (local.set $class_enum (i32.const 19))))
          (if (call $wide_ascii_prefix_eq (local.get $p) (i32.const 0x3158))
            (then (local.set $class_enum (i32.const 19))))
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
          ;; DLU → pixel geometry (x*3/2, y*7/4). For comboboxes (class 5),
          ;; the template's ch is the full dropped-down extent per Win32
          ;; convention — clamp the window/hit-test rect to the field
          ;; height (21px) unless CBS_SIMPLE so stacked combos don't
          ;; overlap each other and route clicks to the wrong combo
          ;; (pinball Player Controls: 6 combos at y=85/108/133 with
          ;; ch=70 each were all ~120px tall pre-clamp).
          (call $ctrl_geom_set (local.get $ctrl_slot)
            (i32.div_u (i32.mul (local.get $cx) (i32.const 3)) (i32.const 2))
            (i32.div_u (i32.mul (local.get $cy) (i32.const 7)) (i32.const 4))
            (i32.div_u (i32.mul (local.get $cw) (i32.const 3)) (i32.const 2))
            (select
              (i32.const 21)
              (i32.div_u (i32.mul (local.get $ch) (i32.const 7)) (i32.const 4))
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
      (i32.store offset=16 (call $g2w (local.get $cs)) (i32.div_u (i32.mul (local.get $ch) (i32.const 7)) (i32.const 4)))
      (i32.store offset=20 (call $g2w (local.get $cs)) (i32.div_u (i32.mul (local.get $cw) (i32.const 3)) (i32.const 2)))
      (i32.store offset=24 (call $g2w (local.get $cs)) (i32.div_u (i32.mul (local.get $cy) (i32.const 7)) (i32.const 4)))
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
