  ;; ============================================================
  ;; C RUNTIME / STRING FUNCTION HANDLERS
  ;; ============================================================

  ;; _mbschr(str, ch) — cdecl, find first occurrence of byte in MBCS string
  (func $handle__mbschr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $ch i32) (local $cur i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (local.set $ch (i32.and (local.get $arg1) (i32.const 0xFF)))
    (block $d (loop $l
      (local.set $cur (i32.load8_u (local.get $wa)))
      (if (i32.eq (local.get $cur) (local.get $ch))
        (then
          (global.set $eax (i32.add (i32.sub (local.get $wa) (i32.const 0x12000)) (global.get $image_base)))
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
      (then (global.set $eax (i32.add (i32.sub (local.get $last) (i32.const 0x12000)) (global.get $image_base))))
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

  ;; 783: SHGetFileInfoA(pszPath, dwFileAttributes, psfi, cbFileInfo, uFlags) — 5 args stdcall
  ;; Return 0 (failure) — no shell file info available
  (func $handle_SHGetFileInfoA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
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
      (then (global.set $eax (i32.add (i32.sub (local.get $last) (i32.const 0x12000)) (global.get $image_base))))
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

  ;; 731: _ftol — cdecl, convert float on FPU stack to i32 (special: no stack args, reads ST(0))
  (func $handle__ftol (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Pop ST(0) and truncate to i32
    (global.set $eax (i32.trunc_sat_f64_s (call $fpu_pop)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 732: sprintf(buf, fmt, ...) — cdecl, same as wsprintfA
  (func $handle_sprintf (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $wsprintf_impl
      (local.get $arg0) (local.get $arg1) (i32.add (global.get $esp) (i32.const 12))))
    ;; cdecl: only pop return address
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
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
    (local $wa i32) (local $ch i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (block $d (loop $l
      (local.set $ch (i32.load8_u (local.get $wa)))
      (br_if $d (i32.eqz (local.get $ch)))
      (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x41)) (i32.le_u (local.get $ch) (i32.const 0x5A)))
        (then (i32.store8 (local.get $wa) (i32.or (local.get $ch) (i32.const 0x20)))))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1))) (br $l)))
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

  ;; IsEqualGUID(rguid1, rguid2) — compare all 16 bytes of the two GUIDs.
  ;; The Windows headers commonly expose this as an inline/macro, but some
  ;; Win9x-era runtimes import the helper from OLE32.
  (func $handle_IsEqualGUID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa0 i32) (local $wa1 i32)
    (global.set $eax (i32.const 0))
    (if (i32.eq (local.get $arg0) (local.get $arg1))
      (then (global.set $eax (i32.const 1)))
      (else
        (if (i32.and (local.get $arg0) (local.get $arg1))
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
