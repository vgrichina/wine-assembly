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
      ;; No free block found — bump allocate
      (local.set $ptr (global.get $heap_ptr))
      (i32.store (call $g2w (local.get $ptr)) (local.get $need))
      (global.set $heap_ptr (i32.add (global.get $heap_ptr) (local.get $need))))
    ;; Return guest pointer past the size header
    (i32.add (local.get $ptr) (i32.const 4)))

  ;; heap_free: return block to free list
  (func $heap_free (param $guest_ptr i32)
    (local $block i32) (local $w i32)
    (if (i32.eqz (local.get $guest_ptr)) (then (return)))
    ;; Only free blocks in our heap range (0x01D12000+) — ignore foreign blocks
    ;; (e.g., msvcrt sbh blocks that shouldn't reach our free list)
    (if (i32.lt_u (local.get $guest_ptr) (i32.const 0x01D12000)) (then (return)))
    ;; Block starts 4 bytes before the user pointer
    (local.set $block (i32.sub (local.get $guest_ptr) (i32.const 4)))
    (local.set $w (call $g2w (local.get $block)))
    ;; Prepend to free list: store next = old head
    (i32.store (i32.add (local.get $w) (i32.const 4)) (global.get $free_list))
    (global.set $free_list (local.get $block)))
  ;; Find resource entry in PE resource directory
  ;; Returns offset of data entry (relative to image_base) or 0
  ;; Compare ASCII string at guest $str_ptr with Unicode resource name at rsrc offset $name_off
  ;; Resource name format: u16 length, then u16[] chars. Returns 1 if match (case-insensitive).
  (func $rsrc_name_match (param $str_ptr i32) (param $name_off i32) (result i32)
    (local $str_wa i32) (local $name_wa i32) (local $len i32) (local $j i32)
    (local $ch_a i32) (local $ch_r i32)
    (local.set $str_wa (call $g2w (local.get $str_ptr)))
    (local.set $name_wa (call $g2w (i32.add (global.get $image_base)
      (i32.add (global.get $rsrc_rva) (local.get $name_off)))))
    (local.set $len (i32.load16_u (local.get $name_wa)))
    (local.set $j (i32.const 0))
    (block $fail (loop $cmp
      (br_if $fail (i32.ge_u (local.get $j) (local.get $len)))
      (local.set $ch_a (i32.load8_u (i32.add (local.get $str_wa) (local.get $j))))
      (br_if $fail (i32.eqz (local.get $ch_a))) ;; ASCII string shorter
      (local.set $ch_r (i32.load16_u (i32.add (local.get $name_wa)
        (i32.add (i32.const 2) (i32.mul (local.get $j) (i32.const 2))))))
      ;; Uppercase both for case-insensitive compare
      (if (i32.and (i32.ge_u (local.get $ch_a) (i32.const 0x61)) (i32.le_u (local.get $ch_a) (i32.const 0x7a)))
        (then (local.set $ch_a (i32.sub (local.get $ch_a) (i32.const 0x20)))))
      (if (i32.and (i32.ge_u (local.get $ch_r) (i32.const 0x61)) (i32.le_u (local.get $ch_r) (i32.const 0x7a)))
        (then (local.set $ch_r (i32.sub (local.get $ch_r) (i32.const 0x20)))))
      (br_if $fail (i32.ne (local.get $ch_a) (local.get $ch_r)))
      (local.set $j (i32.add (local.get $j) (i32.const 1)))
      (br $cmp))
    (return (i32.const 0)))
    ;; Matched all chars — check ASCII string is also at end
    (i32.eqz (i32.load8_u (i32.add (local.get $str_wa) (local.get $len)))))

  (func $rsrc_find_entry (param $dir_off i32) (param $id i32) (result i32)
    (local $named i32) (local $ids i32) (local $total i32)
    (local $e i32) (local $i i32) (local $eid i32) (local $doff i32)
    ;; dir_off = offset from image_base to resource directory
    ;; Read number of named + id entries
    (local.set $named (i32.load16_u (call $g2w (i32.add (global.get $image_base)
      (i32.add (local.get $dir_off) (i32.const 12))))))
    (local.set $ids (i32.load16_u (call $g2w (i32.add (global.get $image_base)
      (i32.add (local.get $dir_off) (i32.const 14))))))
    (local.set $total (i32.add (local.get $named) (local.get $ids)))
    (local.set $e (i32.add (local.get $dir_off) (i32.const 16)))
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (local.get $total)))
      (local.set $eid (call $gl32 (i32.add (global.get $image_base) (local.get $e))))
      (local.set $doff (call $gl32 (i32.add (global.get $image_base) (i32.add (local.get $e) (i32.const 4)))))
      ;; If id is a string pointer (>= 0x10000) and entry is named (high bit set), compare strings
      (if (i32.and (i32.ge_u (local.get $id) (i32.const 0x10000))
                   (i32.ne (i32.and (local.get $eid) (i32.const 0x80000000)) (i32.const 0)))
        (then
          (if (call $rsrc_name_match (local.get $id)
                (i32.and (local.get $eid) (i32.const 0x7FFFFFFF)))
            (then (return (local.get $doff))))))
      ;; Integer ID match
      (if (i32.and (i32.lt_u (local.get $id) (i32.const 0x10000))
                   (i32.eq (local.get $eid) (local.get $id)))
        (then (return (local.get $doff))))
      (local.set $e (i32.add (local.get $e) (i32.const 8)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (i32.const 0))

  ;; FindResourceA: walk type→name→lang, return data entry offset
  (func $find_resource (param $type_id i32) (param $name_id i32) (result i32)
    (local $d i32) (local $lang_off i32) (local $n i32)
    ;; Level 1: find type
    (local.set $d (call $rsrc_find_entry (global.get $rsrc_rva) (local.get $type_id)))
    (if (i32.eqz (local.get $d)) (then (return (i32.const 0))))
    ;; Level 2: find name (d has high bit set if subdirectory)
    (local.set $d (call $rsrc_find_entry
      (i32.add (global.get $rsrc_rva) (i32.and (local.get $d) (i32.const 0x7FFFFFFF)))
      (local.get $name_id)))
    (if (i32.eqz (local.get $d)) (then (return (i32.const 0))))
    ;; Level 3: take first language entry
    (local.set $lang_off (i32.add (global.get $rsrc_rva) (i32.and (local.get $d) (i32.const 0x7FFFFFFF))))
    (local.set $n (i32.add
      (i32.load16_u (call $g2w (i32.add (global.get $image_base) (i32.add (local.get $lang_off) (i32.const 12)))))
      (i32.load16_u (call $g2w (i32.add (global.get $image_base) (i32.add (local.get $lang_off) (i32.const 14)))))))
    (if (i32.eqz (local.get $n)) (then (return (i32.const 0))))
    ;; Return the data offset from first entry (skip directory header 16 bytes, read second dword)
    (local.set $d (call $gl32 (i32.add (global.get $image_base) (i32.add (local.get $lang_off) (i32.const 20)))))
    ;; d is now the offset of the data entry (RVA, size, codepage, reserved) relative to rsrc start
    ;; Return as offset from image_base (rsrc_rva + d)
    (i32.add (global.get $rsrc_rva) (local.get $d)))

  ;; Find a WAVE resource by name ID. Walks L1 looking for named type "WAVE",
  ;; then L2 by integer name_id, then takes first lang entry.
  ;; Returns offset from image_base to data entry, or 0.
  (func $find_resource_named_type (param $name_id i32) (result i32)
    (local $base_wa i32) (local $total i32) (local $e i32) (local $i i32)
    (local $eid i32) (local $doff i32) (local $str_wa i32) (local $str_len i32)
    (local $type_subdir i32) (local $d i32) (local $lang_off i32) (local $n i32)
    ;; L1: scan entries for named type "WAVE"
    (local.set $base_wa (call $g2w (i32.add (global.get $image_base) (global.get $rsrc_rva))))
    (local.set $total (i32.add
      (i32.load16_u (i32.add (local.get $base_wa) (i32.const 12)))
      (i32.load16_u (i32.add (local.get $base_wa) (i32.const 14)))))
    (local.set $e (i32.add (global.get $rsrc_rva) (i32.const 16)))
    (block $found_type
    (block $not_found
    (loop $l1
      (br_if $not_found (i32.ge_u (local.get $i) (local.get $total)))
      (local.set $eid (call $gl32 (i32.add (global.get $image_base) (local.get $e))))
      (local.set $doff (call $gl32 (i32.add (global.get $image_base) (i32.add (local.get $e) (i32.const 4)))))
      ;; Check if named entry (high bit set)
      (if (i32.and (local.get $eid) (i32.const 0x80000000))
        (then
          ;; String offset from rsrc start
          (local.set $str_wa (call $g2w (i32.add (global.get $image_base)
            (i32.add (global.get $rsrc_rva) (i32.and (local.get $eid) (i32.const 0x7FFFFFFF))))))
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
      (i32.add (global.get $rsrc_rva) (i32.and (local.get $type_subdir) (i32.const 0x7FFFFFFF)))
      (local.get $name_id)))
    (if (i32.eqz (local.get $d)) (then (return (i32.const 0))))
    ;; L3: take first language entry
    (local.set $lang_off (i32.add (global.get $rsrc_rva) (i32.and (local.get $d) (i32.const 0x7FFFFFFF))))
    (local.set $n (i32.add
      (i32.load16_u (call $g2w (i32.add (global.get $image_base) (i32.add (local.get $lang_off) (i32.const 12)))))
      (i32.load16_u (call $g2w (i32.add (global.get $image_base) (i32.add (local.get $lang_off) (i32.const 14)))))))
    (if (i32.eqz (local.get $n)) (then (return (i32.const 0))))
    (local.set $d (call $gl32 (i32.add (global.get $image_base) (i32.add (local.get $lang_off) (i32.const 20)))))
    (i32.add (global.get $rsrc_rva) (local.get $d)))

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
    ;; Copy exe name from $exe_name_wa buffer
    (local.set $dst (call $g2w (local.get $ptr)))
    (local.set $len (global.get $exe_name_len))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (i32.store8 (i32.add (local.get $dst) (local.get $i))
        (i32.load8_u (i32.add (global.get $exe_name_wa) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
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

  ;; Paint queue: 16-entry array at PAINT_QUEUE (0xAD50), count in $paint_queue_count
  ;; $paint_queue_push(hwnd): add hwnd if not already in queue and queue not full
  (func $paint_queue_push (param $hwnd i32)
    (local $i i32) (local $addr i32)
    ;; Skip if already in queue
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $paint_queue_count)))
      (if (i32.eq (i32.load (i32.add (global.get $PAINT_QUEUE) (i32.mul (local.get $i) (i32.const 4))))
                  (local.get $hwnd))
        (then (return)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    ;; Add if room (max 16, at 0xB200 after MENU_DATA_TABLE)
    (if (i32.lt_u (global.get $paint_queue_count) (i32.const 16))
      (then
        (i32.store (i32.add (global.get $PAINT_QUEUE) (i32.mul (global.get $paint_queue_count) (i32.const 4)))
          (local.get $hwnd))
        (global.set $paint_queue_count (i32.add (global.get $paint_queue_count) (i32.const 1))))))

  ;; $paint_queue_pop() → hwnd (0 if empty)
  (func $paint_queue_pop (result i32)
    (local $hwnd i32) (local $i i32)
    (if (i32.eqz (global.get $paint_queue_count)) (then (return (i32.const 0))))
    ;; Take first entry
    (local.set $hwnd (i32.load (global.get $PAINT_QUEUE)))
    ;; Shift remaining entries down
    (global.set $paint_queue_count (i32.sub (global.get $paint_queue_count) (i32.const 1)))
    (local.set $i (i32.const 0))
    (block $done (loop $shift
      (br_if $done (i32.ge_u (local.get $i) (global.get $paint_queue_count)))
      (i32.store (i32.add (global.get $PAINT_QUEUE) (i32.mul (local.get $i) (i32.const 4)))
        (i32.load (i32.add (global.get $PAINT_QUEUE) (i32.mul (i32.add (local.get $i) (i32.const 1)) (i32.const 4)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $shift)))
    (local.get $hwnd))

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

  ;; Parse dialog resource template, set CONTROL_GEOM, and send WM_CREATE
  ;; to each control so it initialises its state (text, style, etc.).
  ;; $dlg_id     = dialog resource ID
  ;; $first_hwnd = HWND of the first control (sequential)
  ;; $count      = number of controls
  (func $dlg_set_ctrl_geom (param $dlg_id i32) (param $first_hwnd i32) (param $count i32)
    (local $data_entry i32) (local $rva i32) (local $wa i32) (local $p i32)
    (local $style i32) (local $ctrl_count i32)
    (local $i i32) (local $hwnd i32) (local $slot i32)
    (local $cx i32) (local $cy i32) (local $cw i32) (local $ch i32)
    (local $is_ex i32) (local $ctrl_style i32) (local $ctrl_id i32)
    (local $text_ptr i32) (local $cs i32)
    ;; Find RT_DIALOG resource (type 5)
    (local.set $data_entry (call $find_resource (i32.const 5) (local.get $dlg_id)))
    (if (i32.eqz (local.get $data_entry)) (then (return)))
    ;; Read RVA from data entry
    (local.set $rva (call $gl32 (i32.add (global.get $image_base) (local.get $data_entry))))
    (local.set $wa (call $g2w (i32.add (global.get $image_base) (local.get $rva))))
    (local.set $p (local.get $wa))
    ;; Detect extended dialog template: sig=1 at offset 0, ver=0xFFFF at offset 2
    (local.set $is_ex (i32.and
      (i32.eq (i32.load16_u (local.get $p)) (i32.const 1))
      (i32.eq (i32.load16_u (i32.add (local.get $p) (i32.const 2))) (i32.const 0xFFFF))))
    ;; Parse header — skip to control count field
    (if (local.get $is_ex)
      (then
        (local.set $style (i32.load (i32.add (local.get $p) (i32.const 12))))
        (local.set $p (i32.add (local.get $p) (i32.const 16))))
      (else
        (local.set $style (i32.load (local.get $p)))
        (local.set $p (i32.add (local.get $p) (i32.const 8)))))
    ;; Read count, skip x(2)+y(2)+cx(2)+cy(2) = 10 bytes
    (local.set $ctrl_count (i32.load16_u (local.get $p)))
    (local.set $p (i32.add (local.get $p) (i32.const 10)))
    ;; Skip variable header fields: menu, class, title
    (local.set $p (call $dlg_skip_ord_or_sz (local.get $p)))
    (local.set $p (call $dlg_skip_ord_or_sz (local.get $p)))
    (local.set $p (call $dlg_skip_sz (local.get $p)))
    ;; If DS_SETFONT (0x40), skip font fields
    (if (i32.and (local.get $style) (i32.const 0x40))
      (then
        (local.set $p (i32.add (local.get $p) (i32.const 2)))
        (if (local.get $is_ex)
          (then (local.set $p (i32.add (local.get $p) (i32.const 4)))))
        (local.set $p (call $dlg_skip_sz (local.get $p)))))
    ;; Allocate one CREATESTRUCT on the heap (48 bytes), reuse for all controls
    (local.set $cs (call $heap_alloc (i32.const 48)))
    ;; Iterate DLGITEMTEMPLATE entries
    (local.set $i (i32.const 0))
    (block $done (loop $ctrl_loop
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (br_if $done (i32.ge_u (local.get $i) (local.get $ctrl_count)))
      ;; DWORD-align
      (local.set $p (i32.and (i32.add (local.get $p) (i32.const 3)) (i32.const -4)))
      ;; Read control fields
      (if (local.get $is_ex)
        (then
          ;; Extended: helpId(4)+exStyle(4)+style(4) = 12, then x,y,cx,cy
          (local.set $ctrl_style (i32.load (i32.add (local.get $p) (i32.const 8))))
          (local.set $cx (i32.load16_s (i32.add (local.get $p) (i32.const 12))))
          (local.set $cy (i32.load16_s (i32.add (local.get $p) (i32.const 14))))
          (local.set $cw (i32.load16_s (i32.add (local.get $p) (i32.const 16))))
          (local.set $ch (i32.load16_s (i32.add (local.get $p) (i32.const 18))))
          (local.set $ctrl_id (i32.load (i32.add (local.get $p) (i32.const 20))))
          (local.set $p (i32.add (local.get $p) (i32.const 24))))
        (else
          ;; Standard: style(4)+exStyle(4)=8, then x,y,cx,cy,id
          (local.set $ctrl_style (i32.load (local.get $p)))
          (local.set $cx (i32.load16_s (i32.add (local.get $p) (i32.const 8))))
          (local.set $cy (i32.load16_s (i32.add (local.get $p) (i32.const 10))))
          (local.set $cw (i32.load16_s (i32.add (local.get $p) (i32.const 12))))
          (local.set $ch (i32.load16_s (i32.add (local.get $p) (i32.const 14))))
          (local.set $ctrl_id (i32.load16_u (i32.add (local.get $p) (i32.const 16))))
          (local.set $p (i32.add (local.get $p) (i32.const 18)))))
      ;; Skip className
      (local.set $p (call $dlg_skip_ord_or_sz (local.get $p)))
      ;; Read text (convert UTF-16 → ASCII, heap-allocate)
      (call $dlg_read_text (local.get $p))
      (local.set $text_ptr (global.get $dlg_text_ptr))
      (local.set $p (global.get $dlg_text_wa))
      ;; Skip extra data
      (local.set $p (i32.add (local.get $p)
        (i32.add (i32.const 2) (i32.load16_u (local.get $p)))))
      ;; Set geometry: DLU → pixels (x*3/2, y*7/4)
      (local.set $hwnd (i32.add (local.get $first_hwnd) (local.get $i)))
      (local.set $slot (call $wnd_table_find (local.get $hwnd)))
      (if (i32.ge_s (local.get $slot) (i32.const 0))
        (then
          (call $ctrl_geom_set (local.get $slot)
            (i32.div_u (i32.mul (local.get $cx) (i32.const 3)) (i32.const 2))
            (i32.div_u (i32.mul (local.get $cy) (i32.const 7)) (i32.const 4))
            (i32.div_u (i32.mul (local.get $cw) (i32.const 3)) (i32.const 2))
            (i32.div_u (i32.mul (local.get $ch) (i32.const 7)) (i32.const 4)))))
      ;; Build CREATESTRUCT and send WM_CREATE
      ;; CREATESTRUCT: +0 lpCreateParams, +4 hInstance, +8 hMenu(=ctrlId),
      ;;   +12 hwndParent, +16 cy, +20 cx, +24 y, +28 x, +32 style, +36 lpszName, +40 lpszClass, +44 dwExStyle
      (i32.store         (call $g2w (local.get $cs)) (i32.const 0))
      (i32.store offset=4  (call $g2w (local.get $cs)) (i32.const 0))
      (i32.store offset=8  (call $g2w (local.get $cs)) (local.get $ctrl_id))
      (i32.store offset=12 (call $g2w (local.get $cs)) (i32.const 0))
      (i32.store offset=16 (call $g2w (local.get $cs)) (local.get $ch))
      (i32.store offset=20 (call $g2w (local.get $cs)) (local.get $cw))
      (i32.store offset=24 (call $g2w (local.get $cs)) (local.get $cy))
      (i32.store offset=28 (call $g2w (local.get $cs)) (local.get $cx))
      (i32.store offset=32 (call $g2w (local.get $cs)) (local.get $ctrl_style))
      (i32.store offset=36 (call $g2w (local.get $cs)) (local.get $text_ptr))
      (i32.store offset=40 (call $g2w (local.get $cs)) (i32.const 0))
      (i32.store offset=44 (call $g2w (local.get $cs)) (i32.const 0))
      (drop (call $wnd_send_message (local.get $hwnd) (i32.const 0x0001) (i32.const 0) (local.get $cs)))
      ;; Free text buffer
      (if (local.get $text_ptr) (then (call $heap_free (local.get $text_ptr))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $ctrl_loop)))
    (call $heap_free (local.get $cs)))


