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
  ;; Apply segment override to an address (FS=5 adds fs_base)
  (func $seg_adj (param $addr i32) (param $seg i32) (result i32)
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
  ;; Free-list allocator. Each allocated block has a 4-byte size header at ptr-4.
  ;; Free blocks: [size:4][next_guest_ptr:4][...]. Min block = 16 bytes.
  ;; Falls back to bump allocation when no free block fits.
  (func $heap_alloc (param $size i32) (result i32)
    (local $need i32) (local $ptr i32)
    (local $prev_w i32) (local $cur i32) (local $cur_w i32)
    (local $bsz i32) (local $rem i32)
    ;; need = align8(size + 4 header), minimum 16
    (local.set $need (i32.and (i32.add (i32.add (local.get $size) (i32.const 4)) (i32.const 7)) (i32.const 0xFFFFFFF8)))
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
      ;; OOM guard: refuse if the next heap byte would escape WASM linear
      ;; memory or land in the thunk zone (guest-code-facing thunks for
      ;; Win32 API imports). Pawn-style chess engines ask for 64 MB
      ;; transposition tables that could trip this; return 0 so the app
      ;; handles OOM. Both sides compared in WASM space.
      ;;
      ;; The LHS uses g2w so post-PE-load (heap_ptr is a guest address)
      ;; and pre-PE-load (heap_ptr holds the default guest 0x03D12000)
      ;; both resolve to the physical WASM offset the next byte will
      ;; occupy. The RHS THUNK_BASE is already a WASM-space constant.
      (if (i32.gt_u
            (call $g2w (i32.add (global.get $heap_ptr) (local.get $need)))
            (global.get $THUNK_BASE))
        (then (return (i32.const 0))))
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

  ;; DLL name compare: compare guest ANSI string at $name_ptr with WASM string at $cmp_ptr (case-insensitive)
  (func $dll_name_match (param $name_ptr i32) (param $cmp_ptr i32) (result i32)
    (local $a i32) (local $b i32) (local $i i32)
    (block $no (loop $l
      (local.set $a (call $tolower (call $gl8 (i32.add (local.get $name_ptr) (local.get $i)))))
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

  ;; Called from $wnd_table_remove and slot-recycle paths.
  (func $paint_flag_reset_slot (param $slot i32)
    (i32.store8 (i32.add (global.get $PAINT_FLAGS) (local.get $slot)) (i32.const 0)))

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
    (local $i i32) (local $ptr i32) (local $flags i32) (local $hwnd i32)
    (if (i32.eqz (global.get $nc_flags_count)) (then (return (i32.const 0))))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (i32.add (global.get $NC_FLAGS) (i32.mul (local.get $i) (i32.const 4))))
      (local.set $flags (i32.load (local.get $ptr)))
      (if (i32.and (local.get $flags) (local.get $mask))
        (then
          (local.set $hwnd (i32.load (call $wnd_record_addr (local.get $i))))
          (if (local.get $hwnd) (then (return (local.get $hwnd))))))
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

  (func $client_rect_reset_slot (param $slot i32)
    (local $rec i32)
    (local.set $rec (i32.add (global.get $CLIENT_RECT) (i32.mul (local.get $slot) (i32.const 16))))
    (i32.store          (local.get $rec) (i32.const 0))
    (i32.store offset=4  (local.get $rec) (i32.const 0))
    (i32.store offset=8  (local.get $rec) (i32.const 0))
    (i32.store offset=12 (local.get $rec) (i32.const 0)))

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
    (local $class_val i32) (local $class_enum i32)
    (local $text_ptr i32) (local $cs i32)
    ;; Find the dialog slot — caller must have inserted it already
    (local.set $dlg_slot (call $wnd_table_find (local.get $dlg_hwnd)))
    (if (i32.lt_s (local.get $dlg_slot) (i32.const 0)) (then (return (i32.const 0))))
    (local.set $dlg_rec (call $dlg_record_addr (local.get $dlg_slot)))
    ;; Walk PE directory; also captures $rsrc_matched_eid for named entries
    (local.set $data_entry (call $find_resource (i32.const 5) (local.get $dlg_id)))
    (if (i32.eqz (local.get $data_entry)) (then (return (i32.const 0))))
    (local.set $dlg_key (global.get $rsrc_matched_eid))
    ;; Read RVA from data entry → WASM linear address of template
    (local.set $rva (call $gl32 (i32.add (call $r_base) (local.get $data_entry))))
    (local.set $wa (call $g2w (i32.add (call $r_base) (local.get $rva))))
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
      ;; or a UTF-16 string we currently ignore (class_enum stays 0).
      ;; 0x80=Button,0x81=Edit,0x82=Static,0x83=ListBox,0x84=ScrollBar,0x85=ComboBox
      (local.set $class_enum (i32.const 0))
      (if (i32.eq (i32.load16_u (local.get $p)) (i32.const 0xFFFF))
        (then
          (local.set $class_val (i32.load16_u (i32.add (local.get $p) (i32.const 2))))
          (if (i32.eq (local.get $class_val) (i32.const 0x80)) (then (local.set $class_enum (i32.const 1))))
          (if (i32.eq (local.get $class_val) (i32.const 0x81)) (then (local.set $class_enum (i32.const 2))))
          (if (i32.eq (local.get $class_val) (i32.const 0x82)) (then (local.set $class_enum (i32.const 3))))
          (if (i32.eq (local.get $class_val) (i32.const 0x83)) (then (local.set $class_enum (i32.const 4))))
          (if (i32.eq (local.get $class_val) (i32.const 0x85)) (then (local.set $class_enum (i32.const 5))))
          (if (i32.eq (local.get $class_val) (i32.const 0x84)) (then (local.set $class_enum (i32.const 7))))))
      (local.set $p (call $dlg_skip_ord_or_sz (local.get $p)))
      ;; Text (UTF-16 → ASCII in heap; 0 for null/ordinal)
      (call $dlg_read_text (local.get $p))
      (local.set $text_ptr (global.get $dlg_text_ptr))
      (local.set $p (global.get $dlg_text_wa))
      ;; Extra data: u16 len followed by len bytes
      (local.set $p (i32.add (local.get $p)
        (i32.add (i32.const 2) (i32.load16_u (local.get $p)))))
      ;; Allocate control HWND
      (local.set $ctrl_hwnd (global.get $next_hwnd))
      (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
      (call $wnd_table_set (local.get $ctrl_hwnd) (global.get $WNDPROC_CTRL_NATIVE))
      (drop (call $wnd_set_style (local.get $ctrl_hwnd) (local.get $ctrl_style)))
      (call $wnd_set_parent (local.get $ctrl_hwnd) (local.get $dlg_hwnd))
      (local.set $ctrl_slot (call $wnd_table_find (local.get $ctrl_hwnd)))
      (if (i32.ge_s (local.get $ctrl_slot) (i32.const 0))
        (then
          (call $ctrl_table_set (local.get $ctrl_slot)
            (local.get $class_enum) (local.get $ctrl_id))
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
      ;; Build CREATESTRUCT and send WM_CREATE
      (i32.store         (call $g2w (local.get $cs)) (i32.const 0))
      (i32.store offset=4  (call $g2w (local.get $cs)) (i32.const 0))
      (i32.store offset=8  (call $g2w (local.get $cs)) (local.get $ctrl_id))
      (i32.store offset=12 (call $g2w (local.get $cs)) (local.get $dlg_hwnd))
      (i32.store offset=16 (call $g2w (local.get $cs)) (local.get $ch))
      (i32.store offset=20 (call $g2w (local.get $cs)) (local.get $cw))
      (i32.store offset=24 (call $g2w (local.get $cs)) (local.get $cy))
      (i32.store offset=28 (call $g2w (local.get $cs)) (local.get $cx))
      (i32.store offset=32 (call $g2w (local.get $cs)) (local.get $ctrl_style))
      (i32.store offset=36 (call $g2w (local.get $cs)) (local.get $text_ptr))
      (i32.store offset=40 (call $g2w (local.get $cs)) (i32.const 0))
      (i32.store offset=44 (call $g2w (local.get $cs)) (i32.const 0))
      (drop (call $wnd_send_message (local.get $ctrl_hwnd) (i32.const 0x0001) (i32.const 0) (local.get $cs)))
      ;; Control wndproc has copied text into its own state struct;
      ;; free the template-side copy to avoid leaking per dialog open.
      (if (local.get $text_ptr) (then (call $heap_free (local.get $text_ptr))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $ctrl_loop)))
    (call $heap_free (local.get $cs))
    (call $dlg_seed_focus (local.get $dlg_hwnd))
    (local.get $ctrl_count))


