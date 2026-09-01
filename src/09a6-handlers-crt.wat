  ;; ============================================================
  ;; C RUNTIME / STRING FUNCTION HANDLERS
  ;; ============================================================

  (global $msvcrt_errno_ptr (mut i32) (i32.const 0))
  (global $msvcrt_signal_table (mut i32) (i32.const 0))
  (global $msvcrt_tm_ptr (mut i32) (i32.const 0))

  ;; __mb_cur_max() — cdecl. The default Win98 ANSI code page is single-byte in
  ;; this emulator, so old MSVCRT callers see the same max character width as C.
  (func $handle___mb_cur_max (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; _getdrive() — cdecl, returns 1 for A:, 2 for B:, 3 for C:, etc.
  (func $handle__getdrive (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 3))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; _iob() — cdecl, returns the CRT stdin/stdout/stderr FILE table.
  (func $handle__iob (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (global.get $msvcrt_iob_ptr))
      (then
        (global.set $msvcrt_iob_ptr (call $heap_alloc (i32.const 96)))
        (call $zero_memory (call $g2w (global.get $msvcrt_iob_ptr)) (i32.const 96))))
    (global.set $eax (global.get $msvcrt_iob_ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; _mbschr(str, ch) — cdecl, find first occurrence of byte in MBCS string
  (func $handle__mbschr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $ch i32) (local $cur i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (local.set $ch (i32.and (local.get $arg1) (i32.const 0xFF)))
    (block $d (loop $l
      (local.set $cur (i32.load8_u (local.get $wa)))
      (if (i32.eq (local.get $cur) (local.get $ch))
        (then
          (global.set $eax (i32.add (i32.sub (local.get $wa) (region.addr $GUEST_BASE 0)) (global.get $image_base)))
          (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
          (return)))
      (br_if $d (i32.eqz (local.get $cur)))
      (local.set $wa
        (i32.add (local.get $wa)
          (select
            (i32.const 2)
            (i32.const 1)
            (i32.and
              (call $is_dbcs_lead_byte (local.get $cur))
              (i32.ne (i32.load8_u (i32.add (local.get $wa) (i32.const 1))) (i32.const 0))))))
      (br $l)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 720: _mbsrchr(str, ch) — cdecl, find last occurrence of byte in MBCS string
  (func $handle__mbsrchr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $last i32) (local $ch i32) (local $cur i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (local.set $last (i32.const 0))
    (local.set $ch (i32.and (local.get $arg1) (i32.const 0xFF)))
    (block $d (loop $l
      (local.set $cur (i32.load8_u (local.get $wa)))
      (if (i32.eq (local.get $cur) (local.get $ch))
        (then (local.set $last (local.get $wa))))
      (br_if $d (i32.eqz (local.get $cur)))
      (local.set $wa
        (i32.add (local.get $wa)
          (select
            (i32.const 2)
            (i32.const 1)
            (i32.and
              (call $is_dbcs_lead_byte (local.get $cur))
              (i32.ne (i32.load8_u (i32.add (local.get $wa) (i32.const 1))) (i32.const 0))))))
      (br $l)))
    ;; Convert WASM addr back to guest addr, or 0 if not found
    (if (local.get $last)
      (then (global.set $eax (i32.add (i32.sub (local.get $last) (region.addr $GUEST_BASE 0)) (global.get $image_base))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 781: _mbsnbcmp(s1, s2, n) — cdecl, compare n bytes (ASCII memcmp)
  (func $handle__mbsnbcmp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa1 i32) (local $wa2 i32) (local $n i32) (local $b1 i32) (local $b2 i32)
    (local.set $wa1 (call $g2w (local.get $arg0)))
    (local.set $wa2 (call $g2w (local.get $arg1)))
    (local.set $n (local.get $arg2))
    (block $done (loop $cmp
      (br_if $done (i32.eqz (local.get $n)))
      (local.set $b1 (i32.load8_u (local.get $wa1)))
      (local.set $b2 (i32.load8_u (local.get $wa2)))
      (if (i32.ne (local.get $b1) (local.get $b2))
        (then
          (global.set $eax (i32.sub (local.get $b1) (local.get $b2)))
          (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
          (return)))
      (local.set $wa1 (i32.add (local.get $wa1) (i32.const 1)))
      (local.set $wa2 (i32.add (local.get $wa2) (i32.const 1)))
      (local.set $n (i32.sub (local.get $n) (i32.const 1)))
      (br $cmp)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; memcmp(s1, s2, n) — cdecl, compare raw bytes as unsigned chars.
  (func $handle_memcmp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa1 i32) (local $wa2 i32) (local $n i32) (local $b1 i32) (local $b2 i32)
    (local.set $wa1 (call $g2w (local.get $arg0)))
    (local.set $wa2 (call $g2w (local.get $arg1)))
    (local.set $n (local.get $arg2))
    (block $done (loop $cmp
      (br_if $done (i32.eqz (local.get $n)))
      (local.set $b1 (i32.load8_u (local.get $wa1)))
      (local.set $b2 (i32.load8_u (local.get $wa2)))
      (if (i32.ne (local.get $b1) (local.get $b2))
        (then
          (global.set $eax (i32.sub (local.get $b1) (local.get $b2)))
          (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
          (return)))
      (local.set $wa1 (i32.add (local.get $wa1) (i32.const 1)))
      (local.set $wa2 (i32.add (local.get $wa2) (i32.const 1)))
      (local.set $n (i32.sub (local.get $n) (i32.const 1)))
      (br $cmp)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; memchr(buf, ch, n) — cdecl, return a guest pointer to the first byte match.
  (func $handle_memchr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $i i32) (local $ch i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (local.set $ch (i32.and (local.get $arg1) (i32.const 0xFF)))
    (global.set $eax (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (if (i32.eq (i32.load8_u (i32.add (local.get $wa) (local.get $i))) (local.get $ch))
        (then
          (global.set $eax (i32.add (local.get $arg0) (local.get $i)))
          (br $done)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 783: SHGetFileInfoA(pszPath, dwFileAttributes, psfi, cbFileInfo, uFlags) — 5 args stdcall
  ;; This returned 0 — "the shell knows nothing about that file" — while the W
  ;; spelling filled in szDisplayName, so an ANSI app that titles its window
  ;; with the display name got an empty caption. Same core, ANSI struct.
  (func $handle_SHGetFileInfoA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $sh_file_info_display_name
      (local.get $arg0) (local.get $arg2) (local.get $arg3) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 721: _mbsinc(ptr) — cdecl, advance to next MBCS character
  (func $handle__mbsinc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $mbsinc_ptr (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 722: _strdup(str) — cdecl, allocate copy of string
  (func $handle__strdup (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $len i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    ;; strlen
    (local.set $len (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.eqz (i32.load8_u (i32.add (local.get $wa) (local.get $len)))))
      (local.set $len (i32.add (local.get $len) (i32.const 1))) (br $l)))
    (local.set $len (i32.add (local.get $len) (i32.const 1))) ;; include NUL
    (global.set $eax (call $heap_alloc (local.get $len)))
    (memory.copy (call $g2w (global.get $eax)) (local.get $wa) (local.get $len))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 723: _stricmp(s1, s2) — cdecl, case-insensitive compare
  (func $handle__stricmp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa1 i32) (local $wa2 i32) (local $c1 i32) (local $c2 i32)
    (local.set $wa1 (call $g2w (local.get $arg0)))
    (local.set $wa2 (call $g2w (local.get $arg1)))
    (block $d (loop $l
      (local.set $c1 (i32.load8_u (local.get $wa1)))
      (local.set $c2 (i32.load8_u (local.get $wa2)))
      ;; tolower
      (if (i32.and (i32.ge_u (local.get $c1) (i32.const 0x41)) (i32.le_u (local.get $c1) (i32.const 0x5A)))
        (then (local.set $c1 (i32.or (local.get $c1) (i32.const 0x20)))))
      (if (i32.and (i32.ge_u (local.get $c2) (i32.const 0x41)) (i32.le_u (local.get $c2) (i32.const 0x5A)))
        (then (local.set $c2 (i32.or (local.get $c2) (i32.const 0x20)))))
      (br_if $d (i32.ne (local.get $c1) (local.get $c2)))
      (br_if $d (i32.eqz (local.get $c1)))
      (local.set $wa1 (i32.add (local.get $wa1) (i32.const 1)))
      (local.set $wa2 (i32.add (local.get $wa2) (i32.const 1)))
      (br $l)))
    (global.set $eax (i32.sub (local.get $c1) (local.get $c2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; _strnicmp(s1, s2, count) — cdecl, ASCII case-insensitive bounded compare.
  (func $handle__strnicmp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa1 i32) (local $wa2 i32) (local $i i32)
    (local $c1 i32) (local $c2 i32)
    (global.set $eax (i32.const 0))
    (if (i32.eqz (local.get $arg2))
      (then
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $wa1 (call $g2w (local.get $arg0)))
    (local.set $wa2 (call $g2w (local.get $arg1)))
    (block $done (loop $compare
      (local.set $c1 (i32.load8_u (i32.add (local.get $wa1) (local.get $i))))
      (local.set $c2 (i32.load8_u (i32.add (local.get $wa2) (local.get $i))))
      (if (i32.and (i32.ge_u (local.get $c1) (i32.const 0x41))
                   (i32.le_u (local.get $c1) (i32.const 0x5a)))
        (then (local.set $c1 (i32.or (local.get $c1) (i32.const 0x20)))))
      (if (i32.and (i32.ge_u (local.get $c2) (i32.const 0x41))
                   (i32.le_u (local.get $c2) (i32.const 0x5a)))
        (then (local.set $c2 (i32.or (local.get $c2) (i32.const 0x20)))))
      (if (i32.ne (local.get $c1) (local.get $c2))
        (then
          (global.set $eax (i32.sub (local.get $c1) (local.get $c2)))
          (br $done)))
      (br_if $done (i32.eqz (local.get $c1)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $compare (i32.lt_u (local.get $i) (local.get $arg2)))))
    ;; cdecl: the caller removes all three arguments.
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 724: strlen(str) — cdecl
  (func $handle_strlen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $len i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (block $d (loop $l
      (br_if $d (i32.eqz (i32.load8_u (i32.add (local.get $wa) (local.get $len)))))
      (local.set $len (i32.add (local.get $len) (i32.const 1))) (br $l)))
    (global.set $eax (local.get $len))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; mbstowcs(dst, src, count) — cdecl, single-byte codepage approximation.
  ;; Returns converted WCHAR count excluding the terminating NUL.
  (func $handle_mbstowcs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32) (local $src i32) (local $i i32) (local $ch i32)
    (local.set $src (call $g2w (local.get $arg1)))
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (call $strlen (local.get $src)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $dst (call $g2w (local.get $arg0)))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $ch (i32.load8_u (i32.add (local.get $src) (local.get $i))))
      (i32.store16 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 1))) (local.get $ch))
      (br_if $done (i32.eqz (local.get $ch)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (global.set $eax (local.get $i))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; wcstombs(dst, src, count) — cdecl, maps low byte of each WCHAR.
  ;; Returns converted byte count excluding the terminating NUL.
  (func $handle_wcstombs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32) (local $src i32) (local $i i32) (local $ch i32)
    (local.set $src (call $g2w (local.get $arg1)))
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (call $strlen_w (local.get $src)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $dst (call $g2w (local.get $arg0)))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $ch (i32.load16_u (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 1)))))
      (i32.store8 (i32.add (local.get $dst) (local.get $i)) (local.get $ch))
      (br_if $done (i32.eqz (local.get $ch)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (global.set $eax (local.get $i))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 725: strrchr(str, ch) — cdecl
  (func $handle_strrchr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $last i32) (local $ch i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (local.set $ch (i32.and (local.get $arg1) (i32.const 0xFF)))
    (block $d (loop $l
      (if (i32.eq (i32.load8_u (local.get $wa)) (local.get $ch))
        (then (local.set $last (local.get $wa))))
      (br_if $d (i32.eqz (i32.load8_u (local.get $wa))))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1)))
      (br $l)))
    (if (local.get $last)
      (then (global.set $eax (i32.add (i32.sub (local.get $last) (region.addr $GUEST_BASE 0)) (global.get $image_base))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; Is $ch one of the NUL-terminated characters at $set_wa? The span family
  ;; below all reduce to this question.
  (func $crt_char_in_set (param $set_wa i32) (param $ch i32) (result i32)
    (local $c i32)
    (block $d (loop $l
      (local.set $c (i32.load8_u (local.get $set_wa)))
      (br_if $d (i32.eqz (local.get $c)))
      (if (i32.eq (local.get $c) (local.get $ch)) (then (return (i32.const 1))))
      (local.set $set_wa (i32.add (local.get $set_wa) (i32.const 1)))
      (br $l)))
    (i32.const 0))

  ;; strspn(s, accept) — length of the initial run of s made only of accept
  ;; characters. cdecl, so only the return address comes off here.
  (func $handle_strspn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $set i32) (local $n i32) (local $c i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (local.set $set (call $g2w (local.get $arg1)))
    (block $d (loop $l
      (local.set $c (i32.load8_u (i32.add (local.get $wa) (local.get $n))))
      (br_if $d (i32.eqz (local.get $c)))
      (br_if $d (i32.eqz (call $crt_char_in_set (local.get $set) (local.get $c))))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br $l)))
    (global.set $eax (local.get $n))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; strcspn(s, reject) — the complement: length of the initial run containing
  ;; none of the reject characters.
  (func $handle_strcspn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $set i32) (local $n i32) (local $c i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (local.set $set (call $g2w (local.get $arg1)))
    (block $d (loop $l
      (local.set $c (i32.load8_u (i32.add (local.get $wa) (local.get $n))))
      (br_if $d (i32.eqz (local.get $c)))
      (br_if $d (call $crt_char_in_set (local.get $set) (local.get $c)))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br $l)))
    (global.set $eax (local.get $n))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; strpbrk(s, accept) — pointer to the first accept character in s, or NULL.
  (func $handle_strpbrk (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $set i32) (local $c i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (local.set $set (call $g2w (local.get $arg1)))
    (global.set $eax (i32.const 0))
    (block $d (loop $l
      (local.set $c (i32.load8_u (local.get $wa)))
      (br_if $d (i32.eqz (local.get $c)))
      (if (call $crt_char_in_set (local.get $set) (local.get $c))
        (then
          (global.set $eax (call $w2g (local.get $wa)))
          (br $d)))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1)))
      (br $l)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 726: strcmp(s1, s2) — cdecl
  (func $handle_strcmp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa1 i32) (local $wa2 i32) (local $c1 i32) (local $c2 i32)
    (local.set $wa1 (call $g2w (local.get $arg0)))
    (local.set $wa2 (call $g2w (local.get $arg1)))
    (block $d (loop $l
      (local.set $c1 (i32.load8_u (local.get $wa1)))
      (local.set $c2 (i32.load8_u (local.get $wa2)))
      (br_if $d (i32.ne (local.get $c1) (local.get $c2)))
      (br_if $d (i32.eqz (local.get $c1)))
      (local.set $wa1 (i32.add (local.get $wa1) (i32.const 1)))
      (local.set $wa2 (i32.add (local.get $wa2) (i32.const 1)))
      (br $l)))
    (global.set $eax (i32.sub (local.get $c1) (local.get $c2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; strncmp(s1, s2, count) — cdecl. Compare bytes as unsigned characters,
  ;; stopping at the first difference, a shared NUL, or count bytes.
  (func $handle_strncmp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa1 i32) (local $wa2 i32) (local $i i32)
    (local $c1 i32) (local $c2 i32)
    (global.set $eax (i32.const 0))
    (if (i32.eqz (local.get $arg2))
      (then
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $wa1 (call $g2w (local.get $arg0)))
    (local.set $wa2 (call $g2w (local.get $arg1)))
    (block $done (loop $compare
      (local.set $c1 (i32.load8_u (i32.add (local.get $wa1) (local.get $i))))
      (local.set $c2 (i32.load8_u (i32.add (local.get $wa2) (local.get $i))))
      (if (i32.ne (local.get $c1) (local.get $c2))
        (then
          (global.set $eax (i32.sub (local.get $c1) (local.get $c2)))
          (br $done)))
      (br_if $done (i32.eqz (local.get $c1)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $compare (i32.lt_u (local.get $i) (local.get $arg2)))))
    ;; cdecl: the caller removes all three arguments.
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 727: strcpy(dest, src) — cdecl
  (func $handle_strcpy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32) (local $src i32) (local $ch i32) (local $i i32)
    (local.set $dst (call $g2w (local.get $arg0)))
    (local.set $src (call $g2w (local.get $arg1)))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 65536)))
      (local.set $ch (i32.load8_u (local.get $src)))
      (i32.store8 (local.get $dst) (local.get $ch))
      (br_if $d (i32.eqz (local.get $ch)))
      (local.set $dst (i32.add (local.get $dst) (i32.const 1)))
      (local.set $src (i32.add (local.get $src) (i32.const 1)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (i32.store8 (local.get $dst) (i32.const 0))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 728: strncpy(dest, src, count) — cdecl
  (func $handle_strncpy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32) (local $src i32) (local $i i32) (local $ch i32)
    (local.set $dst (call $g2w (local.get $arg0)))
    (local.set $src (call $g2w (local.get $arg1)))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $ch (i32.load8_u (i32.add (local.get $src) (local.get $i))))
      (i32.store8 (i32.add (local.get $dst) (local.get $i)) (local.get $ch))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $l (local.get $ch))
      ;; pad with zeros
      (block $d2 (loop $l2
        (br_if $d2 (i32.ge_u (local.get $i) (local.get $arg2)))
        (i32.store8 (i32.add (local.get $dst) (local.get $i)) (i32.const 0))
        (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l2)))))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 729: strcat(dest, src) — cdecl
  (func $handle_strcat (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32) (local $src i32) (local $ch i32) (local $i i32)
    (local.set $dst (call $g2w (local.get $arg0)))
    ;; find end of dest
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 65536)))
      (br_if $d (i32.eqz (i32.load8_u (local.get $dst))))
      (local.set $dst (i32.add (local.get $dst) (i32.const 1)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    ;; copy src
    (local.set $src (call $g2w (local.get $arg1)))
    (local.set $i (i32.const 0))
    (block $d2 (loop $l2
      (br_if $d2 (i32.ge_u (local.get $i) (i32.const 65536)))
      (local.set $ch (i32.load8_u (local.get $src)))
      (i32.store8 (local.get $dst) (local.get $ch))
      (br_if $d2 (i32.eqz (local.get $ch)))
      (local.set $dst (i32.add (local.get $dst) (i32.const 1)))
      (local.set $src (i32.add (local.get $src) (i32.const 1)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2)))
    (i32.store8 (local.get $dst) (i32.const 0))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 730: atoi(str) — cdecl
  (func $handle_atoi (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $val i32) (local $neg i32) (local $ch i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    ;; skip whitespace
    (block $d (loop $l
      (local.set $ch (i32.load8_u (local.get $wa)))
      (br_if $d (i32.gt_u (local.get $ch) (i32.const 0x20)))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1))) (br $l)))
    ;; sign
    (if (i32.eq (local.get $ch) (i32.const 0x2D)) ;; '-'
      (then (local.set $neg (i32.const 1))
            (local.set $wa (i32.add (local.get $wa) (i32.const 1))))
      (else (if (i32.eq (local.get $ch) (i32.const 0x2B))
        (then (local.set $wa (i32.add (local.get $wa) (i32.const 1)))))))
    ;; digits
    (block $d2 (loop $l2
      (local.set $ch (i32.load8_u (local.get $wa)))
      (br_if $d2 (i32.lt_u (local.get $ch) (i32.const 0x30)))
      (br_if $d2 (i32.gt_u (local.get $ch) (i32.const 0x39)))
      (local.set $val (i32.add (i32.mul (local.get $val) (i32.const 10)) (i32.sub (local.get $ch) (i32.const 0x30))))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1))) (br $l2)))
    (if (local.get $neg) (then (local.set $val (i32.sub (i32.const 0) (local.get $val)))))
    (global.set $eax (local.get $val))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $crt_digit_value (param $ch i32) (result i32)
    (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x30)) (i32.le_u (local.get $ch) (i32.const 0x39)))
      (then (return (i32.sub (local.get $ch) (i32.const 0x30)))))
    (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x41)) (i32.le_u (local.get $ch) (i32.const 0x5a)))
      (then (return (i32.add (i32.sub (local.get $ch) (i32.const 0x41)) (i32.const 10)))))
    (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x61)) (i32.le_u (local.get $ch) (i32.const 0x7a)))
      (then (return (i32.add (i32.sub (local.get $ch) (i32.const 0x61)) (i32.const 10)))))
    (i32.const -1))

  (func $crt_strto32 (param $nptr i32) (param $endptr i32) (param $base_arg i32) (result i32)
    (local $start_wa i32) (local $wa i32) (local $digits_start i32)
    (local $base i32) (local $ch i32) (local $digit i32)
    (local $neg i32) (local $any i32) (local $value i32)
    (local.set $start_wa (call $g2w (local.get $nptr)))
    (local.set $wa (local.get $start_wa))
    (block $space_done (loop $skip_space
      (local.set $ch (i32.load8_u (local.get $wa)))
      (br_if $space_done (i32.eqz (call $crt_is_space (local.get $ch))))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1)))
      (br $skip_space)))
    (local.set $ch (i32.load8_u (local.get $wa)))
    (if (i32.eq (local.get $ch) (i32.const 0x2d))
      (then
        (local.set $neg (i32.const 1))
        (local.set $wa (i32.add (local.get $wa) (i32.const 1))))
      (else
        (if (i32.eq (local.get $ch) (i32.const 0x2b))
          (then (local.set $wa (i32.add (local.get $wa) (i32.const 1)))))))
    (local.set $base (local.get $base_arg))
    (if (i32.and
          (i32.or (i32.eq (local.get $base) (i32.const 0)) (i32.eq (local.get $base) (i32.const 16)))
          (i32.and
            (i32.eq (i32.load8_u (local.get $wa)) (i32.const 0x30))
            (i32.or
              (i32.eq (i32.load8_u (i32.add (local.get $wa) (i32.const 1))) (i32.const 0x78))
              (i32.eq (i32.load8_u (i32.add (local.get $wa) (i32.const 1))) (i32.const 0x58)))))
      (then
        (local.set $base (i32.const 16))
        (local.set $wa (i32.add (local.get $wa) (i32.const 2)))))
    (if (i32.eqz (local.get $base))
      (then
        (local.set $base (i32.const 10))
        (if (i32.eq (i32.load8_u (local.get $wa)) (i32.const 0x30))
          (then (local.set $base (i32.const 8))))))
    (local.set $digits_start (local.get $wa))
    (block $done (loop $digits
      (local.set $digit (call $crt_digit_value (i32.load8_u (local.get $wa))))
      (br_if $done (i32.lt_s (local.get $digit) (i32.const 0)))
      (br_if $done (i32.ge_u (local.get $digit) (local.get $base)))
      (local.set $value (i32.add (i32.mul (local.get $value) (local.get $base)) (local.get $digit)))
      (local.set $any (i32.const 1))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1)))
      (br $digits)))
    (if (i32.eqz (local.get $any)) (then (local.set $wa (local.get $digits_start))))
    (if (local.get $endptr)
      (then (call $gs32 (local.get $endptr)
        (i32.add (local.get $nptr) (i32.sub (local.get $wa) (local.get $start_wa))))))
    (if (local.get $neg)
      (then (local.set $value (i32.sub (i32.const 0) (local.get $value)))))
    (local.get $value))

  (func $handle_strtol (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $crt_strto32 (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_strtoul (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $crt_strto32 (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $crt_strtod_simple (param $nptr i32) (result f64)
    (local $s i32) (local $ch i32) (local $val i32)
    (local $neg i32) (local $digits i32) (local $exp_neg i32) (local $exp i32)
    (local $fval f64) (local $frac f64)
    (local.set $s (call $g2w (local.get $nptr)))
    (block $space_done (loop $skip_space
      (local.set $ch (i32.load8_u (local.get $s)))
      (br_if $space_done (i32.eqz (call $crt_is_space (local.get $ch))))
      (local.set $s (i32.add (local.get $s) (i32.const 1)))
      (br $skip_space)))
    (local.set $ch (i32.load8_u (local.get $s)))
    (if (i32.or (i32.eq (local.get $ch) (i32.const 0x2D)) (i32.eq (local.get $ch) (i32.const 0x2B)))
      (then
        (local.set $neg (i32.eq (local.get $ch) (i32.const 0x2D)))
        (local.set $s (i32.add (local.get $s) (i32.const 1)))))
    (local.set $fval (f64.const 0))
    (block $ip_done (loop $ip
      (local.set $val (call $crt_digit_value (i32.load8_u (local.get $s))))
      (br_if $ip_done (i32.or (i32.lt_s (local.get $val) (i32.const 0)) (i32.gt_u (local.get $val) (i32.const 9))))
      (local.set $fval (f64.add (f64.mul (local.get $fval) (f64.const 10))
                                (f64.convert_i32_s (local.get $val))))
      (local.set $digits (i32.add (local.get $digits) (i32.const 1)))
      (local.set $s (i32.add (local.get $s) (i32.const 1)))
      (br $ip)))
    (if (i32.eq (i32.load8_u (local.get $s)) (i32.const 0x2E))
      (then
        (local.set $s (i32.add (local.get $s) (i32.const 1)))
        (local.set $frac (f64.const 1))
        (block $fp_done (loop $fp
          (local.set $val (call $crt_digit_value (i32.load8_u (local.get $s))))
          (br_if $fp_done (i32.or (i32.lt_s (local.get $val) (i32.const 0)) (i32.gt_u (local.get $val) (i32.const 9))))
          (local.set $frac (f64.div (local.get $frac) (f64.const 10)))
          (local.set $fval (f64.add (local.get $fval)
            (f64.mul (f64.convert_i32_s (local.get $val)) (local.get $frac))))
          (local.set $digits (i32.add (local.get $digits) (i32.const 1)))
          (local.set $s (i32.add (local.get $s) (i32.const 1)))
          (br $fp)))))
    (if (local.get $digits)
      (then
        (local.set $ch (i32.load8_u (local.get $s)))
        (if (i32.or (i32.eq (local.get $ch) (i32.const 0x65)) (i32.eq (local.get $ch) (i32.const 0x45)))
          (then
            (local.set $s (i32.add (local.get $s) (i32.const 1)))
            (local.set $ch (i32.load8_u (local.get $s)))
            (if (i32.or (i32.eq (local.get $ch) (i32.const 0x2D)) (i32.eq (local.get $ch) (i32.const 0x2B)))
              (then
                (local.set $exp_neg (i32.eq (local.get $ch) (i32.const 0x2D)))
                (local.set $s (i32.add (local.get $s) (i32.const 1)))))
            (block $ex_done (loop $ex
              (local.set $val (call $crt_digit_value (i32.load8_u (local.get $s))))
              (br_if $ex_done (i32.or (i32.lt_s (local.get $val) (i32.const 0)) (i32.gt_u (local.get $val) (i32.const 9))))
              (local.set $exp (i32.add (i32.mul (local.get $exp) (i32.const 10)) (local.get $val)))
              (local.set $s (i32.add (local.get $s) (i32.const 1)))
              (br $ex)))
            (block $scale_done (loop $scale
              (br_if $scale_done (i32.eqz (local.get $exp)))
              (if (local.get $exp_neg)
                (then (local.set $fval (f64.div (local.get $fval) (f64.const 10))))
                (else (local.set $fval (f64.mul (local.get $fval) (f64.const 10)))))
              (local.set $exp (i32.sub (local.get $exp) (i32.const 1)))
              (br $scale)))))))
    (if (local.get $neg) (then (return (f64.neg (local.get $fval)))))
    (local.get $fval))

  (func $handle_atof (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $fpu_push (call $crt_strtod_simple (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_strtod (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $fpu_push (call $crt_strtod_simple (local.get $arg0)))
    (if (local.get $arg1)
      (then (call $gs32 (local.get $arg1) (local.get $arg0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_clock (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_get_ticks))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; MSVCRT double math returns through x87 ST(0). These are cdecl, so the
  ;; callee only pops the return address; the caller removes stack arguments.
  (func $handle_ceil (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $fpu_push (f64.ceil (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 4))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_sqrt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $fpu_push (f64.sqrt (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 4))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_sin (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $fpu_push (call $host_math_sin (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 4))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_cos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $fpu_push (call $host_math_cos (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 4))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_tan (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $fpu_push (call $host_math_tan (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 4))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_atan2 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $fpu_push
      (call $host_math_atan2
        (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 4))))
        (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 12))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_atan (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $fpu_push
      (call $host_math_atan2
        (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 4))))
        (f64.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_asin (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $x f64) (local $root f64)
    (local.set $x (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 4)))))
    (local.set $root (f64.sub (f64.const 1) (f64.mul (local.get $x) (local.get $x))))
    (if (f64.lt (local.get $root) (f64.const 0))
      (then (local.set $root (f64.const nan))))
    (call $fpu_push
      (call $host_math_atan2
        (local.get $x)
        (f64.sqrt (local.get $root))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_acos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $x f64) (local $root f64)
    (local.set $x (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 4)))))
    (local.set $root (f64.sub (f64.const 1) (f64.mul (local.get $x) (local.get $x))))
    (if (f64.lt (local.get $root) (f64.const 0))
      (then (local.set $root (f64.const nan))))
    (call $fpu_push
      (call $host_math_atan2
        (f64.sqrt (local.get $root))
        (local.get $x)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_floor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $fpu_push (f64.floor (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 4))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_fabs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $fpu_push (f64.abs (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 4))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_log (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $fpu_push
      (f64.mul
        (call $host_math_log2 (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 4)))))
        (f64.const 0.69314718055994530942)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_exp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $fpu_push
      (call $host_math_pow2
        (f64.div
          (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 4))))
          (f64.const 0.69314718055994530942))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_fmod (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $x f64) (local $y f64)
    (local.set $x (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 4)))))
    (local.set $y (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 12)))))
    (call $fpu_push
      (f64.sub
        (local.get $x)
        (f64.mul
          (f64.trunc (f64.div (local.get $x) (local.get $y)))
          (local.get $y))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_frexp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $x f64) (local $absx f64) (local $exp i32)
    (local.set $x (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 4)))))
    (local.set $absx (f64.abs (local.get $x)))
    (if (f64.eq (local.get $x) (f64.const 0))
      (then
        (if (local.get $arg1) (then (call $gs32 (local.get $arg1) (i32.const 0))))
        (call $fpu_push (f64.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $exp
      (i32.add
        (i32.trunc_f64_s
          (f64.floor (call $host_math_log2 (local.get $absx))))
        (i32.const 1)))
    (if (local.get $arg1) (then (call $gs32 (local.get $arg1) (local.get $exp))))
    (call $fpu_push
      (f64.div
        (local.get $x)
        (call $host_math_pow2 (f64.convert_i32_s (local.get $exp)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_ldexp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $fpu_push
      (f64.mul
        (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 4))))
        (call $host_math_pow2
          (f64.convert_i32_s (i32.load (call $g2w (i32.add (global.get $esp) (i32.const 12))))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_log10 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $fpu_push
      (f64.div
        (call $host_math_log2 (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 4)))))
        (f64.const 3.32192809488736234787)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_pow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $fpu_push
      (call $host_math_pow
        (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 4))))
        (f64.load (call $g2w (i32.add (global.get $esp) (i32.const 12))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; _CIpow is MSVC's x87-stack helper: ST(1)=base, ST(0)=exponent.
  (func $handle__CIpow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $exponent f64) (local $base f64)
    (local.set $exponent (call $fpu_pop))
    (local.set $base (call $fpu_pop))
    (call $fpu_push (call $host_math_pow (local.get $base) (local.get $exponent)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 759: _ftol — cdecl MSVC helper, ST(0) -> signed i64 in EDX:EAX.
  ;;
  ;; Win98 MSVCRT saves the caller's control word, temporarily selects truncate
  ;; rounding, executes FISTP qword, restores the control word, then returns the
  ;; two halves.  Keep those observable semantics here; callers commonly use
  ;; only EAX, but returning a 32-bit value and leaving stale EDX is not the ABI.
  (func $handle__ftol (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $saved_cw i32) (local $value i64)
    (local.set $saved_cw (global.get $fpu_cw))
    (global.set $fpu_cw (i32.or (local.get $saved_cw) (i32.const 0x0C00)))
    (local.set $value (call $fpu_to_i64 (call $fpu_pop)))
    (global.set $fpu_cw (local.get $saved_cw))
    (global.set $eax (i32.wrap_i64 (local.get $value)))
    (global.set $edx
      (i32.wrap_i64 (i64.shr_u (local.get $value) (i64.const 32))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 732: sprintf(buf, fmt, ...) — cdecl, same as wsprintfA
  (func $handle_sprintf (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $wsprintf_impl
      (local.get $arg0) (local.get $arg1) (i32.add (global.get $esp) (i32.const 12))))
    ;; cdecl: only pop return address
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; CRTDLL _vsnprintf(buffer, count, format, argptr) — cdecl.
  ;;
  ;; The shared formatter writes an unbounded temporary result. Copy at most
  ;; count bytes into the caller's buffer and preserve the Win9x CRT behavior:
  ;; a truncated result is not NUL-terminated and returns -1.
  (func $handle__vsnprintf (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $scratch i32) (local $written i32) (local $copy_len i32)
    (if (i32.or (i32.eqz (local.get $arg0)) (i32.eqz (local.get $arg2)))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    ;; Installer-era CRT log messages are small; 64 KiB gives the existing
    ;; unbounded formatter ample headroom before the bounded copy below.
    (local.set $scratch (call $heap_alloc (i32.const 65536)))
    (if (i32.eqz (local.get $scratch))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $written
      (call $wsprintf_impl (local.get $scratch) (local.get $arg2) (local.get $arg3)))
    (local.set $copy_len
      (select (local.get $arg1) (local.get $written)
        (i32.gt_u (local.get $written) (local.get $arg1))))
    (if (local.get $copy_len)
      (then
        (call $memcpy (call $g2w (local.get $arg0))
          (call $g2w (local.get $scratch)) (local.get $copy_len))))
    (if (i32.lt_u (local.get $written) (local.get $arg1))
      (then
        (call $gs8 (i32.add (local.get $arg0) (local.get $written)) (i32.const 0))
        (global.set $eax (local.get $written)))
      (else (global.set $eax (i32.const -1))))
    (call $heap_free (local.get $scratch))
    ;; cdecl: the caller removes all four arguments.
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; Minimal MSVCRT FILE* stream support. We use the VFS handle itself as the
  ;; stream pointer, which is sufficient for old games that only log and load
  ;; byte streams through their matching CRT imports.
  (func $handle_fopen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $mode i32) (local $access i32) (local $creation i32) (local $handle i32)
    (local.set $mode (if (result i32) (local.get $arg1)
      (then (call $gl8 (local.get $arg1))) (else (i32.const 0))))
    (local.set $access (i32.const 0xC0000000)) ;; GENERIC_READ | GENERIC_WRITE
    (local.set $creation (i32.const 3))        ;; OPEN_EXISTING
    (if (i32.eq (local.get $mode) (i32.const 0x77)) ;; w
      (then (local.set $creation (i32.const 2))))   ;; CREATE_ALWAYS
    (if (i32.eq (local.get $mode) (i32.const 0x61)) ;; a
      (then (local.set $creation (i32.const 4))))   ;; OPEN_ALWAYS
    (local.set $handle (call $host_fs_create_file
      (call $g2w (local.get $arg0))
      (local.get $access)
      (local.get $creation)
      (i32.const 0x80)
      (i32.const 0)))
    (if (i32.eq (local.get $handle) (i32.const -1))
      (then (local.set $handle (i32.const 0)))
      (else
        (if (i32.eq (local.get $mode) (i32.const 0x61))
          (then (drop (call $host_fs_set_file_pointer
            (local.get $handle) (i32.const 0) (i32.const 2)))))))
    (global.set $eax (local.get $handle))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_freopen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $mode i32) (local $access i32) (local $creation i32) (local $handle i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (local.get $arg2))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $mode (if (result i32) (local.get $arg1)
      (then (call $gl8 (local.get $arg1))) (else (i32.const 0))))
    (local.set $access (i32.const 0xC0000000)) ;; GENERIC_READ | GENERIC_WRITE
    (local.set $creation (i32.const 3))        ;; OPEN_EXISTING
    (if (i32.eq (local.get $mode) (i32.const 0x77))
      (then (local.set $creation (i32.const 2))))
    (if (i32.eq (local.get $mode) (i32.const 0x61))
      (then (local.set $creation (i32.const 4))))
    (local.set $handle (call $host_fs_create_file
      (call $g2w (local.get $arg0))
      (local.get $access)
      (local.get $creation)
      (i32.const 0x80)
      (i32.const 0)))
    (if (i32.eq (local.get $handle) (i32.const -1))
      (then
        ;; Console pseudo-files (CONOUT$/CONIN$) are not VFS files. Keep the
        ;; caller's stream alive so console redirection remains harmless.
        (local.set $handle (local.get $arg2)))
      (else
        (if (i32.eq (local.get $mode) (i32.const 0x61))
          (then (drop (call $host_fs_set_file_pointer
            (local.get $handle) (i32.const 0) (i32.const 2)))))))
    (global.set $eax (local.get $handle))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $crt_stream_write (param $stream i32) (param $buf i32) (param $len i32) (result i32)
    (local $bytes_ga i32) (local $bytes_wa i32)
    (local.set $bytes_ga (i32.sub (global.get $esp) (i32.const 4)))
    (local.set $bytes_wa (call $g2w (local.get $bytes_ga)))
    (i32.store (local.get $bytes_wa) (i32.const 0))
    (if (i32.or (i32.eqz (local.get $stream)) (i32.eqz (local.get $buf)))
      (then (return (i32.const -1))))
    (if (call $host_fs_write_file
          (local.get $stream) (local.get $buf) (local.get $len)
          (local.get $bytes_ga))
      (then (return (i32.load (local.get $bytes_wa)))))
    (i32.const -1)
  )

  (func $handle_fclose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (if (result i32) (call $host_fs_close_handle (local.get $arg0))
        (then (i32.const 0))
        (else (i32.const -1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_feof (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp_ga i32) (local $bytes_ga i32) (local $bytes_wa i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $tmp_ga (i32.sub (global.get $esp) (i32.const 8)))
    (local.set $bytes_ga (i32.sub (global.get $esp) (i32.const 4)))
    (local.set $bytes_wa (call $g2w (local.get $bytes_ga)))
    (i32.store (local.get $bytes_wa) (i32.const 0))
    (if (call $host_fs_read_file
          (local.get $arg0) (local.get $tmp_ga) (i32.const 1)
          (local.get $bytes_ga))
      (then
        (if (i32.load (local.get $bytes_wa))
          (then
            (drop (call $host_fs_set_file_pointer
              (local.get $arg0) (i32.const -1) (i32.const 1)))
            (global.set $eax (i32.const 0)))
          (else (global.set $eax (i32.const 1)))))
      (else (global.set $eax (i32.const 1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_ferror (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (if (result i32) (local.get $arg0)
        (then (i32.const 0))
        (else (i32.const 1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_fgets (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $count i32) (local $bytes_ga i32) (local $bytes_wa i32) (local $ch i32)
    (if (i32.or
          (i32.or (i32.eqz (local.get $arg0)) (i32.le_s (local.get $arg1) (i32.const 0)))
          (i32.eqz (local.get $arg2)))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $bytes_ga (i32.sub (global.get $esp) (i32.const 4)))
    (local.set $bytes_wa (call $g2w (local.get $bytes_ga)))
    (block $done (loop $read
      (br_if $done (i32.ge_u (local.get $count) (i32.sub (local.get $arg1) (i32.const 1))))
      (i32.store (local.get $bytes_wa) (i32.const 0))
      (if (i32.eqz (call $host_fs_read_file
            (local.get $arg2)
            (i32.add (local.get $arg0) (local.get $count))
            (i32.const 1)
            (local.get $bytes_ga)))
        (then (br $done)))
      (br_if $done (i32.eqz (i32.load (local.get $bytes_wa))))
      (local.set $ch (call $gl8 (i32.add (local.get $arg0) (local.get $count))))
      (local.set $count (i32.add (local.get $count) (i32.const 1)))
      (br_if $done (i32.eq (local.get $ch) (i32.const 0x0a)))
      (br $read)))
    (if (local.get $count)
      (then
        (call $gs8 (i32.add (local.get $arg0) (local.get $count)) (i32.const 0))
        (global.set $eax (local.get $arg0)))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_fread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $total i32) (local $bytes_ga i32) (local $bytes_wa i32) (local $read i32)
    (if (i32.or
          (i32.or (i32.eqz (local.get $arg0)) (i32.eqz (local.get $arg1)))
          (i32.or (i32.eqz (local.get $arg2)) (i32.eqz (local.get $arg3))))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $total (i32.mul (local.get $arg1) (local.get $arg2)))
    (local.set $bytes_ga (i32.sub (global.get $esp) (i32.const 4)))
    (local.set $bytes_wa (call $g2w (local.get $bytes_ga)))
    (i32.store (local.get $bytes_wa) (i32.const 0))
    (if (call $host_fs_read_file
          (local.get $arg3) (local.get $arg0) (local.get $total)
          (local.get $bytes_ga))
      (then (local.set $read (i32.load (local.get $bytes_wa))))
      (else (local.set $read (i32.const 0))))
    (global.set $eax (i32.div_u (local.get $read) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_ftell (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (if (result i32) (local.get $arg0)
        (then (call $host_fs_set_file_pointer
          (local.get $arg0) (i32.const 0) (i32.const 1)))
        (else (i32.const -1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_fseek (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (if (result i32) (i32.and
            (local.get $arg0)
            (i32.ne
              (call $host_fs_set_file_pointer
                (local.get $arg0) (local.get $arg1) (local.get $arg2))
              (i32.const -1)))
        (then (i32.const 0))
        (else (i32.const -1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $crt_open_access (param $flags i32) (result i32)
    (if (result i32) (i32.and (local.get $flags) (i32.const 2)) ;; _O_RDWR
      (then (i32.const 0xC0000000)) ;; GENERIC_READ | GENERIC_WRITE
      (else
        (if (result i32) (i32.and (local.get $flags) (i32.const 1)) ;; _O_WRONLY
          (then (i32.const 0x40000000)) ;; GENERIC_WRITE
          (else (i32.const 0x80000000)))))) ;; GENERIC_READ

  (func $crt_open_creation (param $flags i32) (result i32)
    (if (result i32) (i32.and (local.get $flags) (i32.const 0x100)) ;; _O_CREAT
      (then
        (if (result i32) (i32.and (local.get $flags) (i32.const 0x400)) ;; _O_EXCL
          (then (i32.const 1)) ;; CREATE_NEW
          (else
            (if (result i32) (i32.and (local.get $flags) (i32.const 0x200)) ;; _O_TRUNC
              (then (i32.const 2)) ;; CREATE_ALWAYS
              (else (i32.const 4)))))) ;; OPEN_ALWAYS
      (else
        (if (result i32) (i32.and (local.get $flags) (i32.const 0x200)) ;; _O_TRUNC
          (then (i32.const 5)) ;; TRUNCATE_EXISTING
          (else (i32.const 3)))))) ;; OPEN_EXISTING

  (func $handle__open (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $handle i32)
    (local.set $handle (call $host_fs_create_file
      (call $g2w (local.get $arg0))
      (call $crt_open_access (local.get $arg1))
      (call $crt_open_creation (local.get $arg1))
      (i32.const 0x80)
      (i32.const 0)))
    (if (i32.eq (local.get $handle) (i32.const -1))
      (then (local.set $handle (i32.const -1)))
      (else
        (if (i32.and (local.get $arg1) (i32.const 8)) ;; _O_APPEND
          (then (drop (call $host_fs_set_file_pointer
            (local.get $handle) (i32.const 0) (i32.const 2)))))))
    (global.set $eax (local.get $handle))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle__close (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (if (result i32) (call $host_fs_close_handle (local.get $arg0))
        (then (i32.const 0))
        (else (i32.const -1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle__dup (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (if (result i32) (i32.ge_s (local.get $arg0) (i32.const 0))
        (then (local.get $arg0))
        (else (i32.const -1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle__unlink (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (if (result i32) (call $host_fs_delete_file (call $g2w (local.get $arg0)) (i32.const 0))
        (then (i32.const 0))
        (else (i32.const -1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle__read (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $bytes_ga i32) (local $bytes_wa i32)
    (local.set $bytes_ga (i32.sub (global.get $esp) (i32.const 4)))
    (local.set $bytes_wa (call $g2w (local.get $bytes_ga)))
    (i32.store (local.get $bytes_wa) (i32.const 0))
    (global.set $eax
      (if (result i32) (call $host_fs_read_file
            (local.get $arg0) (local.get $arg1) (local.get $arg2)
            (local.get $bytes_ga))
        (then (i32.load (local.get $bytes_wa)))
        (else (i32.const -1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle__write (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $crt_stream_write
      (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle__lseek (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_fs_set_file_pointer
      (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle__filelength (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $pos i32) (local $end i32)
    (local.set $pos (call $host_fs_set_file_pointer
      (local.get $arg0) (i32.const 0) (i32.const 1)))
    (local.set $end (call $host_fs_set_file_pointer
      (local.get $arg0) (i32.const 0) (i32.const 2)))
    (if (i32.ne (local.get $pos) (i32.const -1))
      (then (drop (call $host_fs_set_file_pointer
        (local.get $arg0) (local.get $pos) (i32.const 0)))))
    (global.set $eax (local.get $end))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_fflush (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg0)
      (then
        (global.set $eax
          (select
            (i32.const 0)
            (i32.const -1)
            (i32.ne
              (call $host_fs_set_file_pointer
                (local.get $arg0) (i32.const 0) (i32.const 1))
              (i32.const -1)))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_fputs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $len i32) (local $written i32)
    (local.set $len (if (result i32) (local.get $arg0)
      (then (call $guest_strlen (local.get $arg0))) (else (i32.const 0))))
    (local.set $written (call $crt_stream_write
      (local.get $arg1) (local.get $arg0) (local.get $len)))
    (global.set $eax
      (select (i32.const 0) (i32.const -1) (i32.ge_s (local.get $written) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_fwrite (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $total i32) (local $written i32)
    (if (i32.or (i32.eqz (local.get $arg1)) (i32.eqz (local.get $arg2)))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $total (i32.mul (local.get $arg1) (local.get $arg2)))
    (local.set $written (call $crt_stream_write
      (local.get $arg3) (local.get $arg0) (local.get $total)))
    (global.set $eax
      (if (result i32) (i32.lt_s (local.get $written) (i32.const 0))
        (then (i32.const 0))
        (else (i32.div_u (local.get $written) (local.get $arg1)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_fprintf (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $scratch i32) (local $written i32)
    (if (i32.eqz (local.get $arg1))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $scratch (call $heap_alloc (i32.const 65536)))
    (if (i32.eqz (local.get $scratch))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $written
      (call $wsprintf_impl (local.get $scratch) (local.get $arg1)
        (i32.add (global.get $esp) (i32.const 12))))
    (if (i32.ge_s (local.get $written) (i32.const 0))
      (then (local.set $written (call $crt_stream_write
        (local.get $arg0) (local.get $scratch) (local.get $written)))))
    (call $heap_free (local.get $scratch))
    (global.set $eax (local.get $written))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_printf (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $scratch i32) (local $written i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $scratch (call $heap_alloc (i32.const 65536)))
    (if (i32.eqz (local.get $scratch))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $written
      (call $wsprintf_impl (local.get $scratch) (local.get $arg0)
        (i32.add (global.get $esp) (i32.const 8))))
    (call $heap_free (local.get $scratch))
    (global.set $eax (local.get $written))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_vfprintf (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $scratch i32) (local $written i32)
    (if (i32.eqz (local.get $arg1))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $scratch (call $heap_alloc (i32.const 65536)))
    (if (i32.eqz (local.get $scratch))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $written
      (call $wsprintf_impl (local.get $scratch) (local.get $arg1) (local.get $arg2)))
    (local.set $written
      (if (result i32) (i32.lt_s (call $crt_stream_write
            (local.get $arg0) (local.get $scratch) (local.get $written)) (i32.const 0))
        (then (i32.const -1))
        (else (local.get $written))))
    (call $heap_free (local.get $scratch))
    (global.set $eax (local.get $written))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_vsprintf (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (call $wsprintf_impl (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle__errno (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (global.get $msvcrt_errno_ptr))
      (then
        (global.set $msvcrt_errno_ptr (call $heap_alloc (i32.const 4)))
        (call $gs32 (global.get $msvcrt_errno_ptr) (i32.const 0))))
    (global.set $eax (global.get $msvcrt_errno_ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_strerror (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (global.get $msvcrt_strerror_ptr))
      (then
        (global.set $msvcrt_strerror_ptr (call $heap_alloc (i32.const 14)))
        (call $gs8 (global.get $msvcrt_strerror_ptr) (i32.const 0x55))
        (call $gs8 (i32.add (global.get $msvcrt_strerror_ptr) (i32.const 1)) (i32.const 0x6e))
        (call $gs8 (i32.add (global.get $msvcrt_strerror_ptr) (i32.const 2)) (i32.const 0x6b))
        (call $gs8 (i32.add (global.get $msvcrt_strerror_ptr) (i32.const 3)) (i32.const 0x6e))
        (call $gs8 (i32.add (global.get $msvcrt_strerror_ptr) (i32.const 4)) (i32.const 0x6f))
        (call $gs8 (i32.add (global.get $msvcrt_strerror_ptr) (i32.const 5)) (i32.const 0x77))
        (call $gs8 (i32.add (global.get $msvcrt_strerror_ptr) (i32.const 6)) (i32.const 0x6e))
        (call $gs8 (i32.add (global.get $msvcrt_strerror_ptr) (i32.const 7)) (i32.const 0x20))
        (call $gs8 (i32.add (global.get $msvcrt_strerror_ptr) (i32.const 8)) (i32.const 0x65))
        (call $gs8 (i32.add (global.get $msvcrt_strerror_ptr) (i32.const 9)) (i32.const 0x72))
        (call $gs8 (i32.add (global.get $msvcrt_strerror_ptr) (i32.const 10)) (i32.const 0x72))
        (call $gs8 (i32.add (global.get $msvcrt_strerror_ptr) (i32.const 11)) (i32.const 0x6f))
        (call $gs8 (i32.add (global.get $msvcrt_strerror_ptr) (i32.const 12)) (i32.const 0x72))
        (call $gs8 (i32.add (global.get $msvcrt_strerror_ptr) (i32.const 13)) (i32.const 0))))
    (global.set $eax (global.get $msvcrt_strerror_ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $crt_write_tmpnam (param $dst i32)
    (call $gs8 (local.get $dst) (i32.const 0x43)) ;; C
    (call $gs8 (i32.add (local.get $dst) (i32.const 1)) (i32.const 0x3a)) ;; :
    (call $gs8 (i32.add (local.get $dst) (i32.const 2)) (i32.const 0x5c)) ;; backslash
    (call $gs8 (i32.add (local.get $dst) (i32.const 3)) (i32.const 0x54)) ;; T
    (call $gs8 (i32.add (local.get $dst) (i32.const 4)) (i32.const 0x45)) ;; E
    (call $gs8 (i32.add (local.get $dst) (i32.const 5)) (i32.const 0x4d)) ;; M
    (call $gs8 (i32.add (local.get $dst) (i32.const 6)) (i32.const 0x50)) ;; P
    (call $gs8 (i32.add (local.get $dst) (i32.const 7)) (i32.const 0x5c))
    (call $gs8 (i32.add (local.get $dst) (i32.const 8)) (i32.const 0x57)) ;; W
    (call $gs8 (i32.add (local.get $dst) (i32.const 9)) (i32.const 0x41)) ;; A
    (call $gs8 (i32.add (local.get $dst) (i32.const 10)) (i32.const 0x30)) ;; 0
    (call $gs8 (i32.add (local.get $dst) (i32.const 11)) (i32.const 0x30))
    (call $gs8 (i32.add (local.get $dst) (i32.const 12)) (i32.const 0x30))
    (call $gs8 (i32.add (local.get $dst) (i32.const 13)) (i32.const 0x30))
    (call $gs8 (i32.add (local.get $dst) (i32.const 14)) (i32.const 0x30))
    (call $gs8 (i32.add (local.get $dst) (i32.const 15)) (i32.const 0x30))
    (call $gs8 (i32.add (local.get $dst) (i32.const 16)) (i32.const 0x2e)) ;; .
    (call $gs8 (i32.add (local.get $dst) (i32.const 17)) (i32.const 0x54)) ;; T
    (call $gs8 (i32.add (local.get $dst) (i32.const 18)) (i32.const 0x4d)) ;; M
    (call $gs8 (i32.add (local.get $dst) (i32.const 19)) (i32.const 0x50)) ;; P
    (call $gs8 (i32.add (local.get $dst) (i32.const 20)) (i32.const 0)))

  (func $handle_tmpnam (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32)
    (local.set $dst (local.get $arg0))
    (if (i32.eqz (local.get $dst))
      (then
        (if (i32.eqz (global.get $msvcrt_tmpnam_ptr))
          (then (global.set $msvcrt_tmpnam_ptr (call $heap_alloc (i32.const 21)))))
        (local.set $dst (global.get $msvcrt_tmpnam_ptr))))
    (call $crt_write_tmpnam (local.get $dst))
    (global.set $eax (local.get $dst))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; _lock/_unlock guard MSVCRT's process-local tables. The startup paths that
  ;; import them run on one guest thread here, so the lock index is only a
  ;; compatibility token.
  (func $handle__lock (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle__unlock (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; __lconv_init initializes MSVCRT's locale-conversion cache. The emulator's
  ;; locale APIs already provide the C/en-US data SDL2 expects, so this reports
  ;; success without allocating a separate lconv object.
  (func $handle___lconv_init (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_tolower (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg0))
    (if (i32.and
          (i32.ge_s (local.get $arg0) (i32.const 0x41))
          (i32.le_s (local.get $arg0) (i32.const 0x5a)))
      (then (global.set $eax (i32.add (local.get $arg0) (i32.const 0x20)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_toupper (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg0))
    (if (i32.and
          (i32.ge_s (local.get $arg0) (i32.const 0x61))
          (i32.le_s (local.get $arg0) (i32.const 0x7a)))
      (then (global.set $eax (i32.sub (local.get $arg0) (i32.const 0x20)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_towlower (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_tolower (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr)))

  (func $handle_towupper (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_toupper (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr)))

  (func $crt_is_alpha (param $ch i32) (result i32)
    (i32.or
      (i32.and (i32.ge_u (local.get $ch) (i32.const 0x41)) (i32.le_u (local.get $ch) (i32.const 0x5a)))
      (i32.and (i32.ge_u (local.get $ch) (i32.const 0x61)) (i32.le_u (local.get $ch) (i32.const 0x7a)))))

  (func $crt_is_digit (param $ch i32) (result i32)
    (i32.and (i32.ge_u (local.get $ch) (i32.const 0x30)) (i32.le_u (local.get $ch) (i32.const 0x39))))

  (func $crt_is_space (param $ch i32) (result i32)
    (i32.or (i32.eq (local.get $ch) (i32.const 0x20))
      (i32.and (i32.ge_u (local.get $ch) (i32.const 0x09)) (i32.le_u (local.get $ch) (i32.const 0x0d)))))

  (func $crt_ctype_return (param $value i32)
    (global.set $eax (local.get $value)))

  (func $handle_isalpha (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crt_ctype_return (call $crt_is_alpha (i32.and (local.get $arg0) (i32.const 0xff))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  (func $handle_isdigit (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crt_ctype_return (call $crt_is_digit (i32.and (local.get $arg0) (i32.const 0xff))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  (func $handle_isalnum (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crt_ctype_return
      (i32.or
        (call $crt_is_alpha (i32.and (local.get $arg0) (i32.const 0xff)))
        (call $crt_is_digit (i32.and (local.get $arg0) (i32.const 0xff)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  (func $handle_isupper (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crt_ctype_return
      (i32.and
        (i32.ge_u (i32.and (local.get $arg0) (i32.const 0xff)) (i32.const 0x41))
        (i32.le_u (i32.and (local.get $arg0) (i32.const 0xff)) (i32.const 0x5a))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  (func $handle_islower (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crt_ctype_return
      (i32.and
        (i32.ge_u (i32.and (local.get $arg0) (i32.const 0xff)) (i32.const 0x61))
        (i32.le_u (i32.and (local.get $arg0) (i32.const 0xff)) (i32.const 0x7a))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  (func $handle_isspace (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crt_ctype_return (call $crt_is_space (i32.and (local.get $arg0) (i32.const 0xff))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  (func $handle_iscntrl (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crt_ctype_return
      (i32.or
        (i32.lt_u (i32.and (local.get $arg0) (i32.const 0xff)) (i32.const 0x20))
        (i32.eq (i32.and (local.get $arg0) (i32.const 0xff)) (i32.const 0x7f))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  (func $handle_isprint (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crt_ctype_return
      (i32.and
        (i32.ge_u (i32.and (local.get $arg0) (i32.const 0xff)) (i32.const 0x20))
        (i32.le_u (i32.and (local.get $arg0) (i32.const 0xff)) (i32.const 0x7e))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  (func $handle_ispunct (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ch i32)
    (local.set $ch (i32.and (local.get $arg0) (i32.const 0xff)))
    (call $crt_ctype_return
      (i32.and
        (i32.and
          (i32.ge_u (local.get $ch) (i32.const 0x21))
          (i32.le_u (local.get $ch) (i32.const 0x7e)))
          (i32.eqz
            (i32.or
              (i32.or (call $crt_is_alpha (local.get $ch)) (call $crt_is_digit (local.get $ch)))
              (call $crt_is_space (local.get $ch))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  (func $handle_isxdigit (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ch i32)
    (local.set $ch (i32.and (local.get $arg0) (i32.const 0xff)))
    (call $crt_ctype_return
      (i32.or
        (call $crt_is_digit (local.get $ch))
        (i32.or
          (i32.and (i32.ge_u (local.get $ch) (i32.const 0x41)) (i32.le_u (local.get $ch) (i32.const 0x46)))
          (i32.and (i32.ge_u (local.get $ch) (i32.const 0x61)) (i32.le_u (local.get $ch) (i32.const 0x66))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  (func $handle__isctype (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ch i32) (local $flags i32)
    (local.set $ch (i32.and (local.get $arg0) (i32.const 0xff)))
    (local.set $flags (call $ctype1_ascii_flags (local.get $ch)))
    (if (i32.eq (local.get $ch) (i32.const 0x20))
      (then (local.set $flags (i32.or (local.get $flags) (i32.const 0x40)))))
    (if (i32.or
          (call $crt_is_digit (local.get $ch))
          (i32.or
            (i32.and (i32.ge_u (local.get $ch) (i32.const 0x41)) (i32.le_u (local.get $ch) (i32.const 0x46)))
            (i32.and (i32.ge_u (local.get $ch) (i32.const 0x61)) (i32.le_u (local.get $ch) (i32.const 0x66)))))
      (then (local.set $flags (i32.or (local.get $flags) (i32.const 0x80)))))
    (global.set $eax (i32.and (local.get $flags) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  (func $msvcrt_ctype_flags (param $ch i32) (result i32)
    (local $flags i32)
    (local.set $flags (call $ctype1_ascii_flags (i32.and (local.get $ch) (i32.const 0xff))))
    (if (i32.eq (i32.and (local.get $ch) (i32.const 0xff)) (i32.const 0x20))
      (then (local.set $flags (i32.or (local.get $flags) (i32.const 0x40)))))
    (if (i32.or
          (call $crt_is_digit (i32.and (local.get $ch) (i32.const 0xff)))
          (i32.or
            (i32.and
              (i32.ge_u (i32.and (local.get $ch) (i32.const 0xff)) (i32.const 0x41))
              (i32.le_u (i32.and (local.get $ch) (i32.const 0xff)) (i32.const 0x46)))
            (i32.and
              (i32.ge_u (i32.and (local.get $ch) (i32.const 0xff)) (i32.const 0x61))
              (i32.le_u (i32.and (local.get $ch) (i32.const 0xff)) (i32.const 0x66)))))
      (then (local.set $flags (i32.or (local.get $flags) (i32.const 0x80)))))
    (local.get $flags))

  ;; _pctype() — cdecl, returns the CRT ctype table. Entry zero is EOF; byte
  ;; values are indexed at table[ch + 1].
  (func $handle__pctype (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $i i32)
    (if (i32.eqz (global.get $msvcrt_pctype_ptr))
      (then
        (global.set $msvcrt_pctype_ptr (call $heap_alloc (i32.const 514)))
        (call $zero_memory (call $g2w (global.get $msvcrt_pctype_ptr)) (i32.const 514))
        (local.set $i (i32.const 0))
        (block $done (loop $fill
          (br_if $done (i32.ge_u (local.get $i) (i32.const 256)))
          (call $gs16
            (i32.add (global.get $msvcrt_pctype_ptr)
              (i32.shl (i32.add (local.get $i) (i32.const 1)) (i32.const 1)))
            (call $msvcrt_ctype_flags (local.get $i)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $fill)))))
    (global.set $eax (global.get $msvcrt_pctype_ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  ;; _setmode(fd, mode) — cdecl. The emulator does not distinguish text and
  ;; binary stdio streams; return the previous text mode.
  (func $handle__setmode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x4000))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  (func $handle_abort (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
    (call $host_exit (i32.const 3))
    (global.set $eip (i32.const 0))
    (global.set $yield_flag (i32.const 1))
    (global.set $steps (i32.const 0)))

  (func $handle_iswctype (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crt_ctype_return (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_signal (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $slot i32)
    ;; Keep handlers for the usual small MSVCRT signal numbers. Invalid signal
    ;; ids return SIG_ERR (-1); valid registrations return the previous handler.
    (if (i32.or (i32.lt_s (local.get $arg0) (i32.const 0)) (i32.ge_s (local.get $arg0) (i32.const 32)))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (if (i32.eqz (global.get $msvcrt_signal_table))
      (then
        (global.set $msvcrt_signal_table (call $heap_alloc (i32.const 128)))
        (memory.fill (call $g2w (global.get $msvcrt_signal_table)) (i32.const 0) (i32.const 128))))
    (local.set $slot
      (i32.add (global.get $msvcrt_signal_table) (i32.shl (local.get $arg0) (i32.const 2))))
    (global.set $eax (call $gl32 (local.get $slot)))
    (call $gs32 (local.get $slot) (local.get $arg1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_localtime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return a stable static struct tm:
    ;; sec, min, hour, mday, mon, year-since-1900, wday, yday, isdst.
    (if (i32.eqz (global.get $msvcrt_tm_ptr))
      (then
        (global.set $msvcrt_tm_ptr (call $heap_alloc (i32.const 36)))
        (call $gs32 (global.get $msvcrt_tm_ptr) (i32.const 0))
        (call $gs32 (i32.add (global.get $msvcrt_tm_ptr) (i32.const 4)) (i32.const 0))
        (call $gs32 (i32.add (global.get $msvcrt_tm_ptr) (i32.const 8)) (i32.const 0))
        (call $gs32 (i32.add (global.get $msvcrt_tm_ptr) (i32.const 12)) (i32.const 1))
        (call $gs32 (i32.add (global.get $msvcrt_tm_ptr) (i32.const 16)) (i32.const 0))
        (call $gs32 (i32.add (global.get $msvcrt_tm_ptr) (i32.const 20)) (i32.const 100))
        (call $gs32 (i32.add (global.get $msvcrt_tm_ptr) (i32.const 24)) (i32.const 6))
        (call $gs32 (i32.add (global.get $msvcrt_tm_ptr) (i32.const 28)) (i32.const 0))
        (call $gs32 (i32.add (global.get $msvcrt_tm_ptr) (i32.const 32)) (i32.const 0))))
    (global.set $eax (global.get $msvcrt_tm_ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $crt_copy_finddata_a (param $dst i32) (param $src i32)
    (local $i i32) (local $ch i32)
    (if (i32.or (i32.eqz (local.get $dst)) (i32.eqz (local.get $src)))
      (then (return)))
    ;; struct _finddata_t: attrib, time_create/access/write, size, name[260].
    ;; WIN32_FIND_DATAA: attrs at +0, size high/low at +28/+32, cFileName at +44.
    (call $gs32 (local.get $dst) (call $gl32 (local.get $src)))
    (call $gs32 (i32.add (local.get $dst) (i32.const 4)) (i32.const 0))
    (call $gs32 (i32.add (local.get $dst) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $dst) (i32.const 12)) (i32.const 0))
    (call $gs32 (i32.add (local.get $dst) (i32.const 16))
      (call $gl32 (i32.add (local.get $src) (i32.const 32))))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (i32.const 260)))
      (local.set $ch (call $gl8
        (i32.add (i32.add (local.get $src) (i32.const 44)) (local.get $i))))
      (call $gs8
        (i32.add (i32.add (local.get $dst) (i32.const 20)) (local.get $i))
        (local.get $ch))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $copy (local.get $ch))))
  )

  (func $handle__findfirst (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $scratch i32) (local $handle i32)
    (local.set $scratch (call $heap_alloc (i32.const 320)))
    (if (i32.eqz (local.get $scratch))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $handle (call $host_fs_find_first_file
      (call $g2w (local.get $arg0)) (local.get $scratch) (i32.const 0)))
    (if (i32.eq (local.get $handle) (i32.const -1))
      (then
        (call $heap_free (local.get $scratch))
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (call $crt_copy_finddata_a (local.get $arg1) (local.get $scratch))
    (call $heap_free (local.get $scratch))
    (global.set $eax (local.get $handle))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle__findnext (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $scratch i32) (local $ok i32)
    (local.set $scratch (call $heap_alloc (i32.const 320)))
    (if (i32.eqz (local.get $scratch))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $ok (call $host_fs_find_next_file
      (local.get $arg0) (local.get $scratch) (i32.const 0)))
    (if (local.get $ok)
      (then
        (call $crt_copy_finddata_a (local.get $arg1) (local.get $scratch))
        (global.set $eax (i32.const 0)))
      (else (global.set $eax (i32.const -1))))
    (call $heap_free (local.get $scratch))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle__findclose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (if (result i32) (call $host_fs_find_close (local.get $arg0))
        (then (i32.const 0))
        (else (i32.const -1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle_getenv (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (local.set $entry (call $env_find (local.get $arg0) (i32.const 0)))
    (global.set $eax
      (if (result i32) (local.get $entry)
        (then (i32.add (i32.add (local.get $entry)
          (call $env_name_len (local.get $entry))) (i32.const 1)))
        (else (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle__stat (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $attrs i32) (local $scratch i32) (local $find i32)
    (if (i32.or (i32.eqz (local.get $arg0)) (i32.eqz (local.get $arg1)))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $attrs (call $host_fs_get_file_attributes
      (call $g2w (local.get $arg0)) (i32.const 0)))
    (if (i32.eq (local.get $attrs) (i32.const -1))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (memory.fill (call $g2w (local.get $arg1)) (i32.const 0) (i32.const 64))
    ;; _stat: st_mode at +6, st_size at +20, times at +24/+28/+32.
    (call $gs16 (i32.add (local.get $arg1) (i32.const 6))
      (if (result i32) (i32.and (local.get $attrs) (i32.const 0x10))
        (then (i32.const 0x41ff)) ;; _S_IFDIR | broad rwx perms
        (else (i32.const 0x81b6)))) ;; _S_IFREG | 0666
    (local.set $scratch (call $heap_alloc (i32.const 320)))
    (if (local.get $scratch)
      (then
        (local.set $find (call $host_fs_find_first_file
          (call $g2w (local.get $arg0)) (local.get $scratch) (i32.const 0)))
        (if (i32.ne (local.get $find) (i32.const -1))
          (then
            (call $gs32 (i32.add (local.get $arg1) (i32.const 20))
              (call $gl32 (i32.add (local.get $scratch) (i32.const 32))))
            (drop (call $host_fs_find_close (local.get $find)))))
        (call $heap_free (local.get $scratch))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle__access (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $attrs i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $attrs (call $host_fs_get_file_attributes
      (call $g2w (local.get $arg0)) (i32.const 0)))
    (if (i32.eq (local.get $attrs) (i32.const -1))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (if (i32.and
          (i32.and (local.get $arg1) (i32.const 0x02))
          (i32.and (local.get $attrs) (i32.const 0x01)))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle__beginthread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_create_thread
      (local.get $arg0) (local.get $arg2) (local.get $arg1)
      (i32.const 0) (i32.const 0)))
    (if (i32.eqz (global.get $eax))
      (then (global.set $eax (i32.const -1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle__beginthreadex (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $thread_id_ptr i32)
    (global.set $eax (call $host_create_thread
      (local.get $arg2) (local.get $arg3) (local.get $arg1)
      (local.get $arg4) (i32.const 0)))
    (local.set $thread_id_ptr (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (if (local.get $thread_id_ptr)
      (then (call $gs32 (local.get $thread_id_ptr) (global.get $eax))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle__endthreadex (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_exit_thread (local.get $arg0))
    (global.set $yield_reason (i32.const 2))
    (global.set $eip (i32.const 0))
    (global.set $steps (i32.const 0))
  )

  ;; _itoa / _itow(value, buffer, radix) — cdecl, returns the buffer.
  ;; Radix 10 is the only one MSVC formats as signed; every other radix prints
  ;; the raw 32-bit pattern, which is what a caller asking for hex expects.
  ;; Digits come out least-significant first, so the run is reversed in place.
  (func $crt_itoa (param $value i32) (param $buf i32) (param $radix i32) (param $wide i32) (result i32)
    (local $i i32) (local $neg i32) (local $u i32) (local $d i32)
    (local $lo i32) (local $hi i32) (local $a i32) (local $b i32)
    (if (i32.eqz (local.get $buf)) (then (return (i32.const 0))))
    (if (i32.or (i32.lt_s (local.get $radix) (i32.const 2))
                (i32.gt_s (local.get $radix) (i32.const 36)))
      (then
        (if (local.get $wide)
          (then (call $gs16 (local.get $buf) (i32.const 0)))
          (else (call $gs8 (local.get $buf) (i32.const 0))))
        (return (local.get $buf))))
    (local.set $u (local.get $value))
    (if (i32.and (i32.eq (local.get $radix) (i32.const 10))
                 (i32.lt_s (local.get $value) (i32.const 0)))
      (then
        (local.set $neg (i32.const 1))
        (local.set $u (i32.sub (i32.const 0) (local.get $value)))))
    (block $done (loop $emit
      (local.set $d (i32.rem_u (local.get $u) (local.get $radix)))
      (local.set $d
        (if (result i32) (i32.lt_u (local.get $d) (i32.const 10))
          (then (i32.add (local.get $d) (i32.const 48)))       ;; '0'
          (else (i32.add (local.get $d) (i32.const 87)))))     ;; 'a' - 10
      (if (local.get $wide)
        (then (call $gs16 (i32.add (local.get $buf) (i32.shl (local.get $i) (i32.const 1))) (local.get $d)))
        (else (call $gs8 (i32.add (local.get $buf) (local.get $i)) (local.get $d))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $u (i32.div_u (local.get $u) (local.get $radix)))
      (br_if $emit (local.get $u))
      (br $done)))
    (if (local.get $neg)
      (then
        (if (local.get $wide)
          (then (call $gs16 (i32.add (local.get $buf) (i32.shl (local.get $i) (i32.const 1))) (i32.const 45)))
          (else (call $gs8 (i32.add (local.get $buf) (local.get $i)) (i32.const 45))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))))
    (if (local.get $wide)
      (then (call $gs16 (i32.add (local.get $buf) (i32.shl (local.get $i) (i32.const 1))) (i32.const 0)))
      (else (call $gs8 (i32.add (local.get $buf) (local.get $i)) (i32.const 0))))
    ;; Reverse the digits (and the sign) into their printed order.
    (local.set $lo (i32.const 0))
    (local.set $hi (i32.sub (local.get $i) (i32.const 1)))
    (block $rdone (loop $rev
      (br_if $rdone (i32.ge_s (local.get $lo) (local.get $hi)))
      (if (local.get $wide)
        (then
          (local.set $a (call $gl16 (i32.add (local.get $buf) (i32.shl (local.get $lo) (i32.const 1)))))
          (local.set $b (call $gl16 (i32.add (local.get $buf) (i32.shl (local.get $hi) (i32.const 1)))))
          (call $gs16 (i32.add (local.get $buf) (i32.shl (local.get $lo) (i32.const 1))) (local.get $b))
          (call $gs16 (i32.add (local.get $buf) (i32.shl (local.get $hi) (i32.const 1))) (local.get $a)))
        (else
          (local.set $a (call $gl8 (i32.add (local.get $buf) (local.get $lo))))
          (local.set $b (call $gl8 (i32.add (local.get $buf) (local.get $hi))))
          (call $gs8 (i32.add (local.get $buf) (local.get $lo)) (local.get $b))
          (call $gs8 (i32.add (local.get $buf) (local.get $hi)) (local.get $a))))
      (local.set $lo (i32.add (local.get $lo) (i32.const 1)))
      (local.set $hi (i32.sub (local.get $hi) (i32.const 1)))
      (br $rev)))
    (local.get $buf))

  ;; _getcwd(buffer, maxlen) — cdecl. With a NULL buffer the CRT allocates one
  ;; of at least maxlen bytes; otherwise it fills the caller's. Returns the
  ;; buffer, or NULL when the path will not fit, matching the C runtime.
  (func $handle__getcwd (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32) (local $len i32) (local $cap i32)
    (local.set $cap (local.get $arg1))
    (if (i32.le_s (local.get $cap) (i32.const 0)) (then (local.set $cap (i32.const 260))))
    (local.set $buf (local.get $arg0))
    (if (i32.eqz (local.get $buf))
      (then (local.set $buf (call $heap_alloc (local.get $cap)))))
    (if (i32.eqz (local.get $buf))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $len (call $host_fs_get_current_directory
      (local.get $cap) (local.get $buf) (i32.const 0)))
    ;; GetCurrentDirectory returns the needed size when the buffer is too
    ;; small; _getcwd reports that as failure.
    (global.set $eax
      (if (result i32)
        (i32.and (i32.ne (local.get $len) (i32.const 0))
                 (i32.lt_u (local.get $len) (local.get $cap)))
        (then (local.get $buf))
        (else (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle__chdir (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (if (result i32) (call $host_fs_set_current_directory
            (call $g2w (local.get $arg0)) (i32.const 0))
        (then (i32.const 0))
        (else (i32.const -1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; _fullpath(absPath, relPath, maxLength) — cdecl. The VFS owns DOS drive,
  ;; root-relative, current-directory, and dot-component normalization, so use
  ;; the same resolver as GetFullPathNameA. A NULL destination asks the CRT to
  ;; allocate the result buffer.
  (func $handle__fullpath (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32) (local $cap i32) (local $len i32) (local $owned i32)
    (local.set $cap (local.get $arg2))
    (if (i32.le_s (local.get $cap) (i32.const 0))
      (then (local.set $cap (i32.const 260))))
    (local.set $buf (local.get $arg0))
    (if (i32.eqz (local.get $buf))
      (then
        (local.set $buf (call $heap_alloc (local.get $cap)))
        (local.set $owned (i32.const 1))))
    (if (i32.and (i32.ne (local.get $buf) (i32.const 0))
                 (i32.ne (local.get $arg1) (i32.const 0)))
      (then
        (local.set $len (call $host_fs_get_full_path_name
          (call $g2w (local.get $arg1)) (local.get $cap) (local.get $buf)
          (i32.const 0) (i32.const 0)))))
    (if (i32.or (i32.eqz (local.get $len))
                (i32.ge_u (local.get $len) (local.get $cap)))
      (then
        (if (local.get $owned) (then (call $heap_free (local.get $buf))))
        (global.set $eax (i32.const 0)))
      (else (global.set $eax (local.get $buf))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle__itoa (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $crt_itoa (local.get $arg0) (local.get $arg1) (local.get $arg2) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $handle__ltoa (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $crt_itoa (local.get $arg0) (local.get $arg1) (local.get $arg2) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; ============================================================
  ;; sscanf — the inverse of the wsprintf in 12-wsprintf.wat
  ;; ============================================================
  ;; cdplayer.exe parses its stored disc/track database with it. Supported
  ;; directives: %d %i %u %x %o %c %s %e %f %g %[...] %%, each with an optional
  ;; '*' suppression flag, a field width, and h/l/L length modifiers.
  ;; Whitespace in the format matches any run of input whitespace; any other
  ;; format character must match the input exactly. The return value is the
  ;; number of items assigned, or -1 (EOF) when input ran out before the first
  ;; conversion, exactly as the C runtime reports it.

  (func $scan_is_space (param $ch i32) (result i32)
    (i32.or
      (i32.eq (local.get $ch) (i32.const 0x20))
      (i32.and (i32.ge_u (local.get $ch) (i32.const 0x09))
               (i32.le_u (local.get $ch) (i32.const 0x0D)))))

  ;; Digit value of $ch in $base, or -1.
  (func $scan_digit (param $ch i32) (param $base i32) (result i32)
    (local $v i32)
    (local.set $v (i32.const -1))
    (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x30))
                 (i32.le_u (local.get $ch) (i32.const 0x39)))
      (then (local.set $v (i32.sub (local.get $ch) (i32.const 0x30)))))
    (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x61))
                 (i32.le_u (local.get $ch) (i32.const 0x7A)))
      (then (local.set $v (i32.add (i32.sub (local.get $ch) (i32.const 0x61)) (i32.const 10)))))
    (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x41))
                 (i32.le_u (local.get $ch) (i32.const 0x5A)))
      (then (local.set $v (i32.add (i32.sub (local.get $ch) (i32.const 0x41)) (i32.const 10)))))
    (if (i32.ge_u (local.get $v) (local.get $base)) (then (local.set $v (i32.const -1))))
    (local.get $v))

  ;; Store an integer through the next vararg pointer, honouring 'h' (short)
  ;; and 'l' (long, same 32 bits here). $len: 0 = int, 1 = short, 2 = long.
  (func $scan_store_int (param $dst i32) (param $val i32) (param $len i32)
    (if (i32.eqz (local.get $dst)) (then (return)))
    (if (i32.eq (local.get $len) (i32.const 1))
      (then (call $gs16 (local.get $dst) (local.get $val)) (return)))
    (call $gs32 (local.get $dst) (local.get $val)))

  ;; Is $ch a member of the scanset starting at $set (just past the '[')?
  ;; $set_end is the index of the closing ']'. Handles a leading '^' negation
  ;; and a-z style ranges.
  (func $scan_set_match (param $set i32) (param $set_end i32) (param $ch i32) (result i32)
    (local $i i32) (local $neg i32) (local $hit i32) (local $c i32) (local $next i32)
    (local.set $i (local.get $set))
    (if (i32.eq (call $gl8 (local.get $i)) (i32.const 0x5E)) ;; '^'
      (then (local.set $neg (i32.const 1))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $set_end)))
      (local.set $c (call $gl8 (local.get $i)))
      (local.set $next (call $gl8 (i32.add (local.get $i) (i32.const 1))))
      ;; "a-z": a range, but only when the '-' is not the last set character.
      (if (i32.and (i32.eq (local.get $next) (i32.const 0x2D))
                   (i32.lt_u (i32.add (local.get $i) (i32.const 2)) (local.get $set_end)))
        (then
          (if (i32.and
                (i32.ge_u (local.get $ch) (local.get $c))
                (i32.le_u (local.get $ch) (call $gl8 (i32.add (local.get $i) (i32.const 2)))))
            (then (local.set $hit (i32.const 1))))
          (local.set $i (i32.add (local.get $i) (i32.const 3)))
          (br $scan)))
      (if (i32.eq (local.get $ch) (local.get $c)) (then (local.set $hit (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (local.get $neg) (then (return (i32.eqz (local.get $hit)))))
    (local.get $hit))

  ;; $src, $fmt: guest pointers. $va: guest address of the first vararg slot.
  (func $sscanf_impl (param $src i32) (param $fmt i32) (param $va i32) (result i32)
    (local $s i32) (local $f i32) (local $assigned i32) (local $ch i32) (local $fc i32)
    (local $suppress i32) (local $width i32) (local $len i32) (local $conv i32)
    (local $base i32) (local $neg i32) (local $val i32) (local $digits i32)
    (local $dst i32) (local $count i32) (local $set_start i32) (local $set_end i32)
    (local $fval f64) (local $frac f64) (local $any i32) (local $consumed i32)
    (local.set $s (local.get $src))
    (local.set $f (local.get $fmt))
    (if (i32.or (i32.eqz (local.get $src)) (i32.eqz (local.get $fmt)))
      (then (return (i32.const -1))))
    (block $stop (loop $next_fmt
      (local.set $fc (call $gl8 (local.get $f)))
      (br_if $stop (i32.eqz (local.get $fc)))

      ;; Whitespace in the format: match any amount, including none.
      (if (call $scan_is_space (local.get $fc))
        (then
          (local.set $f (i32.add (local.get $f) (i32.const 1)))
          (block $ws_done (loop $ws
            (br_if $ws_done (i32.eqz (call $scan_is_space (call $gl8 (local.get $s)))))
            (local.set $s (i32.add (local.get $s) (i32.const 1)))
            (br $ws)))
          (br $next_fmt)))

      ;; Ordinary character: must match exactly.
      (if (i32.ne (local.get $fc) (i32.const 0x25)) ;; '%'
        (then
          (br_if $stop (i32.ne (call $gl8 (local.get $s)) (local.get $fc)))
          (local.set $s (i32.add (local.get $s) (i32.const 1)))
          (local.set $f (i32.add (local.get $f) (i32.const 1)))
          (br $next_fmt)))

      ;; --- a directive ---
      (local.set $f (i32.add (local.get $f) (i32.const 1)))
      (local.set $suppress (i32.const 0))
      (local.set $width (i32.const 0))
      (local.set $len (i32.const 0))
      (if (i32.eq (call $gl8 (local.get $f)) (i32.const 0x2A)) ;; '*'
        (then (local.set $suppress (i32.const 1))
              (local.set $f (i32.add (local.get $f) (i32.const 1)))))
      (block $w_done (loop $w
        (local.set $ch (call $gl8 (local.get $f)))
        (br_if $w_done (i32.or (i32.lt_u (local.get $ch) (i32.const 0x30))
                               (i32.gt_u (local.get $ch) (i32.const 0x39))))
        (local.set $width (i32.add (i32.mul (local.get $width) (i32.const 10))
                                   (i32.sub (local.get $ch) (i32.const 0x30))))
        (local.set $f (i32.add (local.get $f) (i32.const 1)))
        (br $w)))
      (block $len_done (loop $lm
        (local.set $ch (call $gl8 (local.get $f)))
        (if (i32.eq (local.get $ch) (i32.const 0x68)) ;; 'h'
          (then (local.set $len (i32.const 1))
                (local.set $f (i32.add (local.get $f) (i32.const 1))) (br $lm)))
        (if (i32.or (i32.eq (local.get $ch) (i32.const 0x6C))    ;; 'l'
                    (i32.eq (local.get $ch) (i32.const 0x4C)))   ;; 'L'
          (then (local.set $len (i32.const 2))
                (local.set $f (i32.add (local.get $f) (i32.const 1))) (br $lm)))
        (br $len_done)))
      (local.set $conv (call $gl8 (local.get $f)))
      (local.set $f (i32.add (local.get $f) (i32.const 1)))

      ;; "%%" matches a literal percent and assigns nothing.
      (if (i32.eq (local.get $conv) (i32.const 0x25))
        (then
          (br_if $stop (i32.ne (call $gl8 (local.get $s)) (i32.const 0x25)))
          (local.set $s (i32.add (local.get $s) (i32.const 1)))
          (br $next_fmt)))

      ;; The vararg slot for this directive, unless assignment is suppressed.
      (local.set $dst (i32.const 0))
      (if (i32.eqz (local.get $suppress))
        (then
          (local.set $dst (call $gl32 (local.get $va)))
          (local.set $va (i32.add (local.get $va) (i32.const 4)))))

      ;; %c — exactly $width characters (default 1), no whitespace skipping.
      (if (i32.eq (local.get $conv) (i32.const 0x63))
        (then
          (if (i32.eqz (local.get $width)) (then (local.set $width (i32.const 1))))
          (local.set $count (i32.const 0))
          (block $c_done (loop $c
            (br_if $c_done (i32.ge_u (local.get $count) (local.get $width)))
            (local.set $ch (call $gl8 (local.get $s)))
            (br_if $c_done (i32.eqz (local.get $ch)))
            (if (local.get $dst)
              (then (call $gs8 (i32.add (local.get $dst) (local.get $count)) (local.get $ch))))
            (local.set $s (i32.add (local.get $s) (i32.const 1)))
            (local.set $count (i32.add (local.get $count) (i32.const 1)))
            (br $c)))
          (br_if $stop (i32.lt_u (local.get $count) (local.get $width)))
          (if (i32.eqz (local.get $suppress))
            (then (local.set $assigned (i32.add (local.get $assigned) (i32.const 1)))))
          (br $next_fmt)))

      ;; %[...] — a scanset, also without leading whitespace skipping.
      (if (i32.eq (local.get $conv) (i32.const 0x5B))
        (then
          (local.set $set_start (local.get $f))
          ;; A ']' immediately after '[' or '[^' is a literal member.
          (local.set $set_end (local.get $f))
          (if (i32.eq (call $gl8 (local.get $set_end)) (i32.const 0x5E))
            (then (local.set $set_end (i32.add (local.get $set_end) (i32.const 1)))))
          (if (i32.eq (call $gl8 (local.get $set_end)) (i32.const 0x5D))
            (then (local.set $set_end (i32.add (local.get $set_end) (i32.const 1)))))
          (block $set_done (loop $find
            (local.set $ch (call $gl8 (local.get $set_end)))
            (br_if $stop (i32.eqz (local.get $ch)))
            (br_if $set_done (i32.eq (local.get $ch) (i32.const 0x5D)))
            (local.set $set_end (i32.add (local.get $set_end) (i32.const 1)))
            (br $find)))
          (local.set $f (i32.add (local.get $set_end) (i32.const 1)))
          (local.set $count (i32.const 0))
          (block $sset_done (loop $sset
            (if (local.get $width)
              (then (br_if $sset_done (i32.ge_u (local.get $count) (local.get $width)))))
            (local.set $ch (call $gl8 (local.get $s)))
            (br_if $sset_done (i32.eqz (local.get $ch)))
            (br_if $sset_done
              (i32.eqz (call $scan_set_match (local.get $set_start) (local.get $set_end) (local.get $ch))))
            (if (local.get $dst)
              (then (call $gs8 (i32.add (local.get $dst) (local.get $count)) (local.get $ch))))
            (local.set $s (i32.add (local.get $s) (i32.const 1)))
            (local.set $count (i32.add (local.get $count) (i32.const 1)))
            (br $sset)))
          (br_if $stop (i32.eqz (local.get $count)))
          (if (local.get $dst)
            (then (call $gs8 (i32.add (local.get $dst) (local.get $count)) (i32.const 0))))
          (if (i32.eqz (local.get $suppress))
            (then (local.set $assigned (i32.add (local.get $assigned) (i32.const 1)))))
          (br $next_fmt)))

      ;; Every remaining conversion skips leading whitespace first.
      (block $ws2_done (loop $ws2
        (br_if $ws2_done (i32.eqz (call $scan_is_space (call $gl8 (local.get $s)))))
        (local.set $s (i32.add (local.get $s) (i32.const 1)))
        (br $ws2)))

      ;; %s — a run of non-whitespace.
      (if (i32.eq (local.get $conv) (i32.const 0x73))
        (then
          (local.set $count (i32.const 0))
          (block $s_done (loop $sl
            (if (local.get $width)
              (then (br_if $s_done (i32.ge_u (local.get $count) (local.get $width)))))
            (local.set $ch (call $gl8 (local.get $s)))
            (br_if $s_done (i32.eqz (local.get $ch)))
            (br_if $s_done (call $scan_is_space (local.get $ch)))
            (if (local.get $dst)
              (then (call $gs8 (i32.add (local.get $dst) (local.get $count)) (local.get $ch))))
            (local.set $s (i32.add (local.get $s) (i32.const 1)))
            (local.set $count (i32.add (local.get $count) (i32.const 1)))
            (br $sl)))
          (br_if $stop (i32.eqz (local.get $count)))
          (if (local.get $dst)
            (then (call $gs8 (i32.add (local.get $dst) (local.get $count)) (i32.const 0))))
          (if (i32.eqz (local.get $suppress))
            (then (local.set $assigned (i32.add (local.get $assigned) (i32.const 1)))))
          (br $next_fmt)))

      ;; %e %f %g — a decimal float, optionally with an exponent.
      (if (i32.or (i32.eq (local.get $conv) (i32.const 0x66))   ;; 'f'
            (i32.or (i32.eq (local.get $conv) (i32.const 0x65)) ;; 'e'
                    (i32.eq (local.get $conv) (i32.const 0x67)))) ;; 'g'
        (then
          (local.set $neg (i32.const 0))
          (local.set $ch (call $gl8 (local.get $s)))
          (if (i32.or (i32.eq (local.get $ch) (i32.const 0x2D)) (i32.eq (local.get $ch) (i32.const 0x2B)))
            (then
              (local.set $neg (i32.eq (local.get $ch) (i32.const 0x2D)))
              (local.set $s (i32.add (local.get $s) (i32.const 1)))))
          (local.set $fval (f64.const 0))
          (local.set $digits (i32.const 0))
          (block $ip_done (loop $ip
            (local.set $val (call $scan_digit (call $gl8 (local.get $s)) (i32.const 10)))
            (br_if $ip_done (i32.lt_s (local.get $val) (i32.const 0)))
            (local.set $fval (f64.add (f64.mul (local.get $fval) (f64.const 10))
                                      (f64.convert_i32_s (local.get $val))))
            (local.set $digits (i32.add (local.get $digits) (i32.const 1)))
            (local.set $s (i32.add (local.get $s) (i32.const 1)))
            (br $ip)))
          (if (i32.eq (call $gl8 (local.get $s)) (i32.const 0x2E)) ;; '.'
            (then
              (local.set $s (i32.add (local.get $s) (i32.const 1)))
              (local.set $frac (f64.const 1))
              (block $fp_done (loop $fp
                (local.set $val (call $scan_digit (call $gl8 (local.get $s)) (i32.const 10)))
                (br_if $fp_done (i32.lt_s (local.get $val) (i32.const 0)))
                (local.set $frac (f64.div (local.get $frac) (f64.const 10)))
                (local.set $fval (f64.add (local.get $fval)
                  (f64.mul (f64.convert_i32_s (local.get $val)) (local.get $frac))))
                (local.set $digits (i32.add (local.get $digits) (i32.const 1)))
                (local.set $s (i32.add (local.get $s) (i32.const 1)))
                (br $fp)))))
          (br_if $stop (i32.eqz (local.get $digits)))
          ;; Exponent, only when it is actually well formed.
          (local.set $ch (call $gl8 (local.get $s)))
          (if (i32.or (i32.eq (local.get $ch) (i32.const 0x65)) (i32.eq (local.get $ch) (i32.const 0x45)))
            (then
              (local.set $consumed (i32.const 1))
              (local.set $any (i32.const 0))
              (local.set $count (i32.const 0))
              (local.set $ch (call $gl8 (i32.add (local.get $s) (local.get $consumed))))
              (if (i32.or (i32.eq (local.get $ch) (i32.const 0x2D)) (i32.eq (local.get $ch) (i32.const 0x2B)))
                (then
                  (local.set $any (i32.eq (local.get $ch) (i32.const 0x2D)))
                  (local.set $consumed (i32.add (local.get $consumed) (i32.const 1)))))
              (local.set $digits (i32.const 0))
              (block $ex_done (loop $ex
                (local.set $val (call $scan_digit
                  (call $gl8 (i32.add (local.get $s) (local.get $consumed))) (i32.const 10)))
                (br_if $ex_done (i32.lt_s (local.get $val) (i32.const 0)))
                (local.set $count (i32.add (i32.mul (local.get $count) (i32.const 10)) (local.get $val)))
                (local.set $digits (i32.add (local.get $digits) (i32.const 1)))
                (local.set $consumed (i32.add (local.get $consumed) (i32.const 1)))
                (br $ex)))
              (if (local.get $digits)
                (then
                  (local.set $s (i32.add (local.get $s) (local.get $consumed)))
                  (block $sc_done (loop $sc
                    (br_if $sc_done (i32.eqz (local.get $count)))
                    (if (local.get $any)
                      (then (local.set $fval (f64.div (local.get $fval) (f64.const 10))))
                      (else (local.set $fval (f64.mul (local.get $fval) (f64.const 10)))))
                    (local.set $count (i32.sub (local.get $count) (i32.const 1)))
                    (br $sc)))))))
          (if (local.get $neg) (then (local.set $fval (f64.neg (local.get $fval)))))
          (if (local.get $dst)
            (then
              ;; 'l'/'L' means double; a bare %f is a float.
              (if (i32.eq (local.get $len) (i32.const 2))
                (then (f64.store (call $g2w (local.get $dst)) (local.get $fval)))
                (else (f32.store (call $g2w (local.get $dst))
                        (f32.demote_f64 (local.get $fval)))))))
          (if (i32.eqz (local.get $suppress))
            (then (local.set $assigned (i32.add (local.get $assigned) (i32.const 1)))))
          (br $next_fmt)))

      ;; %d %i %u %x %X %o — integers.
      (local.set $base (i32.const 10))
      (if (i32.or (i32.eq (local.get $conv) (i32.const 0x78))    ;; 'x'
                  (i32.eq (local.get $conv) (i32.const 0x58)))   ;; 'X'
        (then (local.set $base (i32.const 16))))
      (if (i32.eq (local.get $conv) (i32.const 0x6F)) (then (local.set $base (i32.const 8)))) ;; 'o'
      (br_if $stop
        (i32.eqz (i32.or (i32.eq (local.get $conv) (i32.const 0x64))   ;; 'd'
          (i32.or (i32.eq (local.get $conv) (i32.const 0x69))          ;; 'i'
            (i32.or (i32.eq (local.get $conv) (i32.const 0x75))        ;; 'u'
              (i32.or (i32.eq (local.get $conv) (i32.const 0x78))
                (i32.or (i32.eq (local.get $conv) (i32.const 0x58))
                        (i32.eq (local.get $conv) (i32.const 0x6F)))))))))
      (local.set $neg (i32.const 0))
      (local.set $ch (call $gl8 (local.get $s)))
      (if (i32.or (i32.eq (local.get $ch) (i32.const 0x2D)) (i32.eq (local.get $ch) (i32.const 0x2B)))
        (then
          (local.set $neg (i32.eq (local.get $ch) (i32.const 0x2D)))
          (local.set $s (i32.add (local.get $s) (i32.const 1)))))
      ;; A 0x prefix is part of %x, and of %i's base detection.
      (if (i32.and (i32.eq (call $gl8 (local.get $s)) (i32.const 0x30))
                   (i32.or (i32.eq (local.get $base) (i32.const 16))
                           (i32.eq (local.get $conv) (i32.const 0x69))))
        (then
          (local.set $ch (call $gl8 (i32.add (local.get $s) (i32.const 1))))
          (if (i32.or (i32.eq (local.get $ch) (i32.const 0x78)) (i32.eq (local.get $ch) (i32.const 0x58)))
            (then
              (local.set $base (i32.const 16))
              (local.set $s (i32.add (local.get $s) (i32.const 2)))))))
      (local.set $val (i32.const 0))
      (local.set $digits (i32.const 0))
      (block $int_done (loop $int
        (if (local.get $width)
          (then (br_if $int_done (i32.ge_u (local.get $digits) (local.get $width)))))
        (local.set $count (call $scan_digit (call $gl8 (local.get $s)) (local.get $base)))
        (br_if $int_done (i32.lt_s (local.get $count) (i32.const 0)))
        (local.set $val (i32.add (i32.mul (local.get $val) (local.get $base)) (local.get $count)))
        (local.set $digits (i32.add (local.get $digits) (i32.const 1)))
        (local.set $s (i32.add (local.get $s) (i32.const 1)))
        (br $int)))
      (br_if $stop (i32.eqz (local.get $digits)))
      (if (local.get $neg) (then (local.set $val (i32.sub (i32.const 0) (local.get $val)))))
      (call $scan_store_int (local.get $dst) (local.get $val) (local.get $len))
      (if (i32.eqz (local.get $suppress))
        (then (local.set $assigned (i32.add (local.get $assigned) (i32.const 1)))))
      (br $next_fmt)))
    ;; Input exhausted before anything was converted is EOF, not "zero items".
    (if (i32.and (i32.eqz (local.get $assigned))
                 (i32.eqz (call $gl8 (local.get $src))))
      (then (return (i32.const -1))))
    (local.get $assigned))

  ;; sscanf(buffer, format, ...) — cdecl
  (func $handle_sscanf (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $sscanf_impl
      (local.get $arg0) (local.get $arg1) (i32.add (global.get $esp) (i32.const 12))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 733: realloc(ptr, size) — cdecl
  (func $handle_realloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $new_ptr i32) (local $old_size i32)
    ;; realloc(NULL, size) = malloc(size)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (call $heap_alloc (local.get $arg1)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    ;; realloc(ptr, 0) = free(ptr)
    (if (i32.eqz (local.get $arg1))
      (then
        (call $heap_free (local.get $arg0))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    ;; Read old block size from header (ptr-4 in guest space)
    (local.set $old_size (call $gl32 (i32.sub (local.get $arg0) (i32.const 4))))
    (local.set $new_ptr (call $heap_alloc (local.get $arg1)))
    ;; Copy min(old_size, new_size) bytes
    (if (i32.gt_u (local.get $old_size) (local.get $arg1))
      (then (local.set $old_size (local.get $arg1))))
    (memory.copy (call $g2w (local.get $new_ptr)) (call $g2w (local.get $arg0)) (local.get $old_size))
    (call $heap_free (local.get $arg0))
    (global.set $eax (local.get $new_ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 734: _strlwr(str) — cdecl, lowercase string in-place
  (func $handle__strlwr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $guest i32) (local $ch i32)
    (local.set $guest (local.get $arg0))
    (block $d (loop $l
      (local.set $ch (call $gl8 (local.get $guest)))
      (br_if $d (i32.eqz (local.get $ch)))
      (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x41)) (i32.le_u (local.get $ch) (i32.const 0x5A)))
        (then (call $gs8 (local.get $guest) (i32.or (local.get $ch) (i32.const 0x20)))))
      (local.set $guest (i32.add (local.get $guest) (i32.const 1))) (br $l)))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; _strupr(str) — cdecl, uppercase ASCII string in-place. Storm uses this
  ;; during DllMain to normalize its app-local search path.
  (func $handle__strupr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $guest i32) (local $ch i32)
    (local.set $guest (local.get $arg0))
    (block $d (loop $l
      (local.set $ch (call $gl8 (local.get $guest)))
      (br_if $d (i32.eqz (local.get $ch)))
      (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x61)) (i32.le_u (local.get $ch) (i32.const 0x7A)))
        (then (call $gs8 (local.get $guest) (i32.sub (local.get $ch) (i32.const 0x20)))))
      (local.set $guest (i32.add (local.get $guest) (i32.const 1)))
      (br $l)))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; bsearch(key, base, nmemb, size, compar) — cdecl, guest-callback comparator.
  ;; Drives the binary search step-by-step: each probe pushes (key, elem) on the
  ;; stack plus the CACA000C return thunk, then jumps to compar. The continuation
  ;; handler in 09b-dispatch.wat narrows [low, high) based on the returned eax and
  ;; re-enters this helper until the range collapses or a match is found.
  (func $bsearch_probe
    (local $mid i32) (local $elem i32)
    ;; range empty → return NULL to caller
    (if (i32.ge_u (global.get $bsearch_low) (global.get $bsearch_high))
      (then
        (global.set $eax (i32.const 0))
        (global.set $eip (global.get $bsearch_ret))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (local.set $mid (i32.div_u
      (i32.add (global.get $bsearch_low) (global.get $bsearch_high))
      (i32.const 2)))
    (global.set $bsearch_mid (local.get $mid))
    (local.set $elem (i32.add (global.get $bsearch_base)
      (i32.mul (local.get $mid) (global.get $bsearch_size))))
    ;; Push compar args (cdecl: right-to-left) then return thunk.
    ;; [esp-4]=thunk, [esp-8]=key, [esp-12]=elem
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $elem))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $bsearch_key))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $bsearch_thunk))
    (global.set $eip (global.get $bsearch_compar))
    (global.set $steps (i32.const 0))
  )

  (func $handle_bsearch (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; arg0=key, arg1=base, arg2=nmemb, arg3=size, arg4=compar. cdecl → caller
    ;; pops the 5 args; we only save the return address and leave args in place.
    (global.set $bsearch_ret    (call $gl32 (global.get $esp)))
    (global.set $bsearch_key    (local.get $arg0))
    (global.set $bsearch_base   (local.get $arg1))
    (global.set $bsearch_size   (local.get $arg3))
    (global.set $bsearch_compar (local.get $arg4))
    (global.set $bsearch_low    (i32.const 0))
    (global.set $bsearch_high   (local.get $arg2))
    ;; Empty array or NULL comparator → return NULL immediately.
    (if (i32.or (i32.eqz (local.get $arg2)) (i32.eqz (local.get $arg4)))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (call $bsearch_probe)
  )

  ;; qsort(base, nmemb, size, compar) — cdecl. A callback-driven adjacent sort
  ;; is intentionally simple but complete; the guest comparator defines the
  ;; ordering, and byte swaps remain correct when an element crosses sparse
  ;; guest-page backing boundaries.
  (func $qsort_finish
    (global.set $eax (i32.const 0))
    (global.set $eip (global.get $qsort_ret))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $qsort_probe
    (local $limit i32) (local $left i32) (local $right i32)
    (if (i32.or
          (i32.or (i32.lt_u (global.get $qsort_count) (i32.const 2))
                  (i32.eqz (global.get $qsort_size)))
          (i32.eqz (global.get $qsort_compar)))
      (then (call $qsort_finish) (return)))
    (if (i32.ge_u (global.get $qsort_pass)
                   (i32.sub (global.get $qsort_count) (i32.const 1)))
      (then (call $qsort_finish) (return)))
    (local.set $limit
      (i32.sub (global.get $qsort_count) (global.get $qsort_pass)))
    (if (i32.ge_u (i32.add (global.get $qsort_index) (i32.const 1))
                   (local.get $limit))
      (then
        (global.set $qsort_pass (i32.add (global.get $qsort_pass) (i32.const 1)))
        (global.set $qsort_index (i32.const 0))
        (call $qsort_probe)
        (return)))
    (local.set $left (i32.add (global.get $qsort_base)
      (i32.mul (global.get $qsort_index) (global.get $qsort_size))))
    (local.set $right (i32.add (local.get $left) (global.get $qsort_size)))
    ;; compar(left, right), cdecl: push right-to-left and leave its two args
    ;; for CACA002D to discard after the callback's plain RET.
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $right))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $left))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $qsort_thunk))
    (global.set $eip (global.get $qsort_compar))
    (global.set $steps (i32.const 0))
  )

  (func $qsort_continue
    (local $left i32) (local $right i32) (local $i i32) (local $byte i32)
    ;; The comparator's RET consumed the thunk; discard its cdecl arguments.
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (if (i32.gt_s (global.get $eax) (i32.const 0))
      (then
        (local.set $left (i32.add (global.get $qsort_base)
          (i32.mul (global.get $qsort_index) (global.get $qsort_size))))
        (local.set $right (i32.add (local.get $left) (global.get $qsort_size)))
        (block $done (loop $swap
          (br_if $done (i32.ge_u (local.get $i) (global.get $qsort_size)))
          (local.set $byte (call $gl8 (i32.add (local.get $left) (local.get $i))))
          (call $gs8 (i32.add (local.get $left) (local.get $i))
            (call $gl8 (i32.add (local.get $right) (local.get $i))))
          (call $gs8 (i32.add (local.get $right) (local.get $i)) (local.get $byte))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $swap)))))
    (global.set $qsort_index (i32.add (global.get $qsort_index) (i32.const 1)))
    (call $qsort_probe)
  )

  (func $handle_qsort (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.or
          (i32.or (i32.lt_u (local.get $arg1) (i32.const 2))
                  (i32.eqz (local.get $arg2)))
          (i32.eqz (local.get $arg3)))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    (global.set $qsort_ret (call $gl32 (global.get $esp)))
    (global.set $qsort_base (local.get $arg0))
    (global.set $qsort_count (local.get $arg1))
    (global.set $qsort_size (local.get $arg2))
    (global.set $qsort_compar (local.get $arg3))
    (global.set $qsort_pass (i32.const 0))
    (global.set $qsort_index (i32.const 0))
    (call $qsort_probe)
  )

  ;; IsEqualGUID(rguid1, rguid2) — compare all 16 bytes of the two GUIDs.
  ;; The Windows headers commonly expose this as an inline/macro, but some
  ;; Win9x-era runtimes import the helper from OLE32.
  (func $handle_IsEqualGUID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa0 i32) (local $wa1 i32)
    (global.set $eax (i32.const 0))
    (if (i32.eq (local.get $arg0) (local.get $arg1))
      (then (global.set $eax (i32.const 1)))
      (else
        (if (i32.and
              (i32.ne (local.get $arg0) (i32.const 0))
              (i32.ne (local.get $arg1) (i32.const 0)))
          (then
            (local.set $wa0 (call $g2w (local.get $arg0)))
            (local.set $wa1 (call $g2w (local.get $arg1)))
            (global.set $eax
              (i32.and
                (i32.and
                  (i32.eq (i32.load (local.get $wa0))
                          (i32.load (local.get $wa1)))
                  (i32.eq (i32.load offset=4 (local.get $wa0))
                          (i32.load offset=4 (local.get $wa1))))
                (i32.and
                  (i32.eq (i32.load offset=8 (local.get $wa0))
                          (i32.load offset=8 (local.get $wa1)))
                  (i32.eq (i32.load offset=12 (local.get $wa0))
                          (i32.load offset=12 (local.get $wa1))))))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; Register one CRT termination callback. Returns 0 on success and -1 for a
  ;; NULL callback or allocation failure, matching the Microsoft CRT contract.
  (func $crt_atexit_register (param $fn i32) (result i32)
    (local $new_capacity i32) (local $new_table i32)
    (if (i32.eqz (local.get $fn))
      (then (return (i32.const -1))))
    (if (i32.eqz (global.get $atexit_table))
      (then
        (global.set $atexit_capacity (i32.const 32))
        (global.set $atexit_table (call $heap_alloc (i32.const 128)))
        (if (i32.eqz (global.get $atexit_table))
          (then
            (global.set $atexit_capacity (i32.const 0))
            (return (i32.const -1))))))
    (if (i32.ge_u (global.get $atexit_count) (global.get $atexit_capacity))
      (then
        (local.set $new_capacity
          (i32.shl (global.get $atexit_capacity) (i32.const 1)))
        ;; Keep size arithmetic bounded even for a hostile registration loop.
        (if (i32.gt_u (local.get $new_capacity) (i32.const 0x10000000))
          (then (return (i32.const -1))))
        (local.set $new_table
          (call $heap_alloc (i32.shl (local.get $new_capacity) (i32.const 2))))
        (if (i32.eqz (local.get $new_table))
          (then (return (i32.const -1))))
        (call $memcpy
          (call $g2w (local.get $new_table))
          (call $g2w (global.get $atexit_table))
          (i32.shl (global.get $atexit_count) (i32.const 2)))
        (call $heap_free (global.get $atexit_table))
        (global.set $atexit_table (local.get $new_table))
        (global.set $atexit_capacity (local.get $new_capacity))))
    (call $gs32
      (i32.add (global.get $atexit_table)
        (i32.shl (global.get $atexit_count) (i32.const 2)))
      (local.get $fn))
    (global.set $atexit_count
      (i32.add (global.get $atexit_count) (i32.const 1)))
    (i32.const 0)
  )

  ;; Continue a normal exit() sequence. Callbacks are cdecl void(void), so the
  ;; only stack word pushed here is their continuation return address.
  (func $crt_atexit_run_next
    (local $fn i32)
    (block $done (loop $scan
      (if (i32.eqz (global.get $atexit_count))
        (then (br $done)))
      (global.set $atexit_count
        (i32.sub (global.get $atexit_count) (i32.const 1)))
      (local.set $fn
        (call $gl32
          (i32.add (global.get $atexit_table)
            (i32.shl (global.get $atexit_count) (i32.const 2)))))
      ;; Be defensive about a corrupt/cleared slot while still draining the
      ;; rest of the registry.
      (if (i32.eqz (local.get $fn))
        (then (br $scan)))
      (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
      (call $gs32 (global.get $esp) (global.get $atexit_ret_thunk))
      (global.set $eip (local.get $fn))
      (global.set $steps (i32.const 0))
      (return)))
    (call $host_exit (global.get $atexit_exit_code))
    (global.set $eip (i32.const 0))
    (global.set $yield_flag (i32.const 1))
    (global.set $yield_reason (i32.const 2))
    (global.set $steps (i32.const 0))
  )

  ;; atexit(fn) — cdecl, so the caller retains the argument word.
  (func $handle_atexit (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $crt_atexit_register (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; strstr(haystack, needle) — cdecl. Return the guest pointer to the first
  ;; exact byte substring, haystack for an empty needle, or NULL if absent.
  (func $handle_strstr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hay_base i32) (local $hay i32) (local $needle i32)
    (local $h i32) (local $n i32)
    (global.set $eax (i32.const 0))
    (block $done
      (if (i32.and (i32.ne (local.get $arg0) (i32.const 0))
                    (i32.ne (local.get $arg1) (i32.const 0)))
        (then
        (local.set $hay_base (call $g2w (local.get $arg0)))
        (local.set $hay (local.get $hay_base))
        (local.set $needle (call $g2w (local.get $arg1)))
        (if (i32.eqz (i32.load8_u (local.get $needle)))
          (then (global.set $eax (local.get $arg0)))
          (else
            (block $absent (loop $candidate
              (br_if $absent (i32.eqz (i32.load8_u (local.get $hay))))
              (local.set $h (local.get $hay))
              (local.set $n (local.get $needle))
              (block $mismatch (loop $compare
                (br_if $mismatch
                  (i32.ne (i32.load8_u (local.get $h))
                          (i32.load8_u (local.get $n))))
                (local.set $n (i32.add (local.get $n) (i32.const 1)))
                (if (i32.eqz (i32.load8_u (local.get $n)))
                  (then
                    (global.set $eax
                      (i32.add (local.get $arg0)
                        (i32.sub (local.get $hay) (local.get $hay_base))))
                    (br $done)))
                (local.set $h (i32.add (local.get $h) (i32.const 1)))
                ;; The haystack ended while the needle still has bytes.
                (br_if $mismatch (i32.eqz (i32.load8_u (local.get $h))))
                (br $compare)))
              (local.set $hay (i32.add (local.get $hay) (i32.const 1)))
              (br $candidate))))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; _setjmp3(jmp_buf, ...) — cdecl. First return from setjmp is zero; the
  ;; caller retains varargs cleanup. Store a conservative zeroed frame so code
  ;; that inspects the buffer does not see stale heap/stack bytes.
  (func $handle__setjmp3 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg0)
      (then (call $zero_memory (call $g2w (local.get $arg0)) (i32.const 64))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; fallback: unknown API — crash with full details
  (func $handle_fallback (param $name_ptr i32) (param $api_id i32)
    (call $host_log_i32 (local.get $api_id))
    (call $host_crash_unimplemented
      (local.get $name_ptr)
      (global.get $esp)
      (global.get $eip)
      (global.get $ebp))
    (unreachable)
  )
