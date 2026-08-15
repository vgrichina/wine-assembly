  ;; ---- TrueType metrics ------------------------------------------------
  ;;
  ;; Milestone 1 of docs/scalable-font-design.md: WAT reads scalable font
  ;; metrics out of the font file itself, so advance widths and TEXTMETRIC
  ;; stop depending on a host Canvas measuring a host font. This layer is
  ;; pure parsing over a caller-supplied buffer; it opens no files, owns no
  ;; arena, and holds no state. Loading and caching arrive with the arena.
  ;;
  ;; Scope is TrueType `glyf` outlines. `OTTO` (CFF/Type2) is rejected on
  ;; purpose: Windows 98 GDI rasterized TrueType natively and had no CFF
  ;; rasterizer, so accepting CFF here would be less faithful, not more.
  ;;
  ;; Font files are untrusted input. Every read is bounds-checked against the
  ;; buffer size and returns zero when it would leave the buffer, so a
  ;; truncated or hostile file degrades to .notdef and zero metrics instead of
  ;; trapping. Offsets are compared as unsigned without ever forming an
  ;; out-of-range sum.

  (func $tt_u8 (param $data i32) (param $size i32) (param $off i32) (result i32)
    (if (i32.ge_u (local.get $off) (local.get $size))
      (then (return (i32.const 0))))
    (i32.load8_u (i32.add (local.get $data) (local.get $off))))

  (func $tt_u16 (param $data i32) (param $size i32) (param $off i32) (result i32)
    (if (i32.or (i32.ge_u (local.get $off) (local.get $size))
          (i32.lt_u (i32.sub (local.get $size) (local.get $off)) (i32.const 2)))
      (then (return (i32.const 0))))
    (i32.or
      (i32.shl (i32.load8_u (i32.add (local.get $data) (local.get $off)))
        (i32.const 8))
      (i32.load8_u (i32.add (local.get $data)
        (i32.add (local.get $off) (i32.const 1))))))

  ;; Signed 16-bit. Font units are frequently negative (descender, lsb).
  (func $tt_s16 (param $data i32) (param $size i32) (param $off i32) (result i32)
    (i32.shr_s
      (i32.shl (call $tt_u16 (local.get $data) (local.get $size) (local.get $off))
        (i32.const 16))
      (i32.const 16)))

  (func $tt_u32 (param $data i32) (param $size i32) (param $off i32) (result i32)
    (if (i32.or (i32.ge_u (local.get $off) (local.get $size))
          (i32.lt_u (i32.sub (local.get $size) (local.get $off)) (i32.const 4)))
      (then (return (i32.const 0))))
    (i32.or
      (i32.or
        (i32.shl (i32.load8_u (i32.add (local.get $data) (local.get $off)))
          (i32.const 24))
        (i32.shl (i32.load8_u (i32.add (local.get $data)
            (i32.add (local.get $off) (i32.const 1)))) (i32.const 16)))
      (i32.or
        (i32.shl (i32.load8_u (i32.add (local.get $data)
            (i32.add (local.get $off) (i32.const 2)))) (i32.const 8))
        (i32.load8_u (i32.add (local.get $data)
          (i32.add (local.get $off) (i32.const 3)))))))

  ;; Accept only sfnt versions that carry `glyf` outlines: 0x00010000 and the
  ;; older Apple 'true'. 'OTTO' is CFF and 'ttcf' is a collection; both are
  ;; refused rather than half-parsed.
  (func $tt_is_truetype (param $data i32) (param $size i32) (result i32)
    (local $version i32)
    (if (i32.lt_u (local.get $size) (i32.const 12))
      (then (return (i32.const 0))))
    (local.set $version
      (call $tt_u32 (local.get $data) (local.get $size) (i32.const 0)))
    (i32.or
      (i32.eq (local.get $version) (i32.const 0x00010000))
      (i32.eq (local.get $version) (i32.const 0x74727565))))

  ;; Offset of the 16-byte table record for a tag, or 0 when the table is
  ;; absent or its declared extent leaves the buffer.
  (func $tt_table_entry (param $data i32) (param $size i32) (param $tag i32)
        (result i32)
    (local $count i32) (local $index i32) (local $record i32)
    (local $offset i32) (local $length i32)
    (if (i32.eqz (call $tt_is_truetype (local.get $data) (local.get $size)))
      (then (return (i32.const 0))))
    (local.set $count
      (call $tt_u16 (local.get $data) (local.get $size) (i32.const 4)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $index) (local.get $count)))
      (local.set $record
        (i32.add (i32.const 12) (i32.mul (local.get $index) (i32.const 16))))
      (if (i32.eq
            (call $tt_u32 (local.get $data) (local.get $size) (local.get $record))
            (local.get $tag))
        (then
          (local.set $offset (call $tt_u32 (local.get $data) (local.get $size)
            (i32.add (local.get $record) (i32.const 8))))
          (local.set $length (call $tt_u32 (local.get $data) (local.get $size)
            (i32.add (local.get $record) (i32.const 12))))
          (if (i32.and (i32.lt_u (local.get $offset) (local.get $size))
                (i32.le_u (local.get $length)
                  (i32.sub (local.get $size) (local.get $offset))))
            (then (return (local.get $record))))
          (return (i32.const 0))))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; A table at file offset 0 would overlap the sfnt header, so 0 is an
  ;; unambiguous "missing" for both accessors.
  (func $tt_table_off (param $data i32) (param $size i32) (param $tag i32)
        (result i32)
    (local $record i32)
    (local.set $record
      (call $tt_table_entry (local.get $data) (local.get $size) (local.get $tag)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (call $tt_u32 (local.get $data) (local.get $size)
      (i32.add (local.get $record) (i32.const 8))))

  (func $tt_table_len (param $data i32) (param $size i32) (param $tag i32)
        (result i32)
    (local $record i32)
    (local.set $record
      (call $tt_table_entry (local.get $data) (local.get $size) (local.get $tag)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (call $tt_u32 (local.get $data) (local.get $size)
      (i32.add (local.get $record) (i32.const 12))))

  ;; ---- head / hhea / maxp ----------------------------------------------

  (func $tt_units_per_em (param $data i32) (param $size i32) (result i32)
    (local $head i32)
    (local.set $head (call $tt_table_off (local.get $data) (local.get $size)
      (i32.const 0x68656164)))
    (if (i32.eqz (local.get $head)) (then (return (i32.const 0))))
    (call $tt_u16 (local.get $data) (local.get $size)
      (i32.add (local.get $head) (i32.const 18))))

  (func $tt_index_to_loc_format (param $data i32) (param $size i32) (result i32)
    (local $head i32)
    (local.set $head (call $tt_table_off (local.get $data) (local.get $size)
      (i32.const 0x68656164)))
    (if (i32.eqz (local.get $head)) (then (return (i32.const 0))))
    (call $tt_s16 (local.get $data) (local.get $size)
      (i32.add (local.get $head) (i32.const 50))))

  (func $tt_num_glyphs (param $data i32) (param $size i32) (result i32)
    (local $maxp i32)
    (local.set $maxp (call $tt_table_off (local.get $data) (local.get $size)
      (i32.const 0x6D617870)))
    (if (i32.eqz (local.get $maxp)) (then (return (i32.const 0))))
    (call $tt_u16 (local.get $data) (local.get $size)
      (i32.add (local.get $maxp) (i32.const 4))))

  (func $tt_hhea_field (param $data i32) (param $size i32) (param $field i32)
        (result i32)
    (local $hhea i32)
    (local.set $hhea (call $tt_table_off (local.get $data) (local.get $size)
      (i32.const 0x68686561)))
    (if (i32.eqz (local.get $hhea)) (then (return (i32.const 0))))
    (call $tt_s16 (local.get $data) (local.get $size)
      (i32.add (local.get $hhea) (local.get $field))))

  (func $tt_ascender (param $data i32) (param $size i32) (result i32)
    (call $tt_hhea_field (local.get $data) (local.get $size) (i32.const 4)))

  (func $tt_descender (param $data i32) (param $size i32) (result i32)
    (call $tt_hhea_field (local.get $data) (local.get $size) (i32.const 6)))

  (func $tt_line_gap (param $data i32) (param $size i32) (result i32)
    (call $tt_hhea_field (local.get $data) (local.get $size) (i32.const 8)))

  (func $tt_num_h_metrics (param $data i32) (param $size i32) (result i32)
    (local $hhea i32)
    (local.set $hhea (call $tt_table_off (local.get $data) (local.get $size)
      (i32.const 0x68686561)))
    (if (i32.eqz (local.get $hhea)) (then (return (i32.const 0))))
    (call $tt_u16 (local.get $data) (local.get $size)
      (i32.add (local.get $hhea) (i32.const 34))))

  ;; ---- OS/2 -------------------------------------------------------------

  (func $tt_os2_u16 (param $data i32) (param $size i32) (param $field i32)
        (result i32)
    (local $os2 i32)
    (local.set $os2 (call $tt_table_off (local.get $data) (local.get $size)
      (i32.const 0x4F532F32)))
    (if (i32.eqz (local.get $os2)) (then (return (i32.const 0))))
    (call $tt_u16 (local.get $data) (local.get $size)
      (i32.add (local.get $os2) (local.get $field))))

  (func $tt_os2_s16 (param $data i32) (param $size i32) (param $field i32)
        (result i32)
    (local $os2 i32)
    (local.set $os2 (call $tt_table_off (local.get $data) (local.get $size)
      (i32.const 0x4F532F32)))
    (if (i32.eqz (local.get $os2)) (then (return (i32.const 0))))
    (call $tt_s16 (local.get $data) (local.get $size)
      (i32.add (local.get $os2) (local.get $field))))

  (func $tt_weight_class (param $data i32) (param $size i32) (result i32)
    (call $tt_os2_u16 (local.get $data) (local.get $size) (i32.const 4)))

  ;; usWinAscent/usWinDescent are what GDI reports as tmAscent/tmDescent, not
  ;; the hhea or sTypo pair. Fall back to hhea only when OS/2 is absent.
  (func $tt_win_ascent (param $data i32) (param $size i32) (result i32)
    (local $value i32)
    (local.set $value
      (call $tt_os2_u16 (local.get $data) (local.get $size) (i32.const 74)))
    (if (i32.eqz (local.get $value))
      (then (return (call $tt_ascender (local.get $data) (local.get $size)))))
    (local.get $value))

  (func $tt_win_descent (param $data i32) (param $size i32) (result i32)
    (local $value i32)
    (local.set $value
      (call $tt_os2_u16 (local.get $data) (local.get $size) (i32.const 76)))
    (if (i32.eqz (local.get $value))
      (then (return (i32.sub (i32.const 0)
        (call $tt_descender (local.get $data) (local.get $size))))))
    (local.get $value))

  ;; sxHeight and sCapHeight exist only from OS/2 version 2 onward.
  (func $tt_x_height (param $data i32) (param $size i32) (result i32)
    (if (i32.lt_u (call $tt_os2_u16 (local.get $data) (local.get $size)
          (i32.const 0)) (i32.const 2))
      (then (return (i32.const 0))))
    (call $tt_os2_s16 (local.get $data) (local.get $size) (i32.const 86)))

  (func $tt_cap_height (param $data i32) (param $size i32) (result i32)
    (if (i32.lt_u (call $tt_os2_u16 (local.get $data) (local.get $size)
          (i32.const 0)) (i32.const 2))
      (then (return (i32.const 0))))
    (call $tt_os2_s16 (local.get $data) (local.get $size) (i32.const 88)))

  (func $tt_is_italic (param $data i32) (param $size i32) (result i32)
    (i32.ne (i32.and
        (call $tt_os2_u16 (local.get $data) (local.get $size) (i32.const 62))
        (i32.const 1))
      (i32.const 0)))

  ;; ---- name -------------------------------------------------------------
  ;;
  ;; Only the family name (name ID 1) is read, and only to answer "what face
  ;; did the guest just install?" for AddFontResourceA. Everything else in the
  ;; stack is keyed by a face name the guest already supplied.

  ;; Rank a name record as a source for the family name. Higher wins; 0 means
  ;; unusable. Windows records are preferred over Macintosh ones because a
  ;; Windows record is what GDI itself reported, and an English-language
  ;; record over any other because the family name is a lookup key that the
  ;; guest will spell the English way.
  (func $tt_name_rank (param $platform i32) (param $encoding i32)
        (param $language i32) (result i32)
    (if (i32.eq (local.get $platform) (i32.const 3))
      (then
        ;; Unicode BMP (1) and Symbol (0) both store the name as UTF-16BE.
        (if (i32.gt_u (local.get $encoding) (i32.const 1))
          (then (return (i32.const 0))))
        (return (select (i32.const 4) (i32.const 3)
          (i32.eq (local.get $language) (i32.const 0x0409))))))
    (if (i32.eq (local.get $platform) (i32.const 1))
      (then
        (if (i32.ne (local.get $encoding) (i32.const 0))
          (then (return (i32.const 0))))
        (return (select (i32.const 2) (i32.const 1)
          (i32.eqz (local.get $language))))))
    (i32.const 0))

  ;; Copy the family name into $out as a NUL-terminated Latin-1 string and
  ;; return its length, or 0 when the font declares none that fits.
  ;;
  ;; A code unit outside Latin-1 fails the whole call rather than being
  ;; substituted: the result is a lookup key, and a key that is subtly wrong
  ;; finds nothing in a way that reads as "the font failed to load" while the
  ;; font loaded fine.
  (func $tt_family_name (param $data i32) (param $size i32) (param $out i32)
        (param $out_max i32) (result i32)
    (local $name i32) (local $count i32) (local $strings i32) (local $index i32)
    (local $record i32) (local $rank i32) (local $best i32) (local $best_rec i32)
    (local $platform i32) (local $length i32) (local $offset i32)
    (local $units i32) (local $unit i32) (local $wide i32)
    (if (i32.or (i32.eqz (local.get $out)) (i32.lt_s (local.get $out_max) (i32.const 2)))
      (then (return (i32.const 0))))
    (local.set $name (call $tt_table_off (local.get $data) (local.get $size)
      (i32.const 0x6E616D65)))
    (if (i32.eqz (local.get $name)) (then (return (i32.const 0))))
    (local.set $count
      (call $tt_u16 (local.get $data) (local.get $size)
        (i32.add (local.get $name) (i32.const 2))))
    (local.set $strings (i32.add (local.get $name)
      (call $tt_u16 (local.get $data) (local.get $size)
        (i32.add (local.get $name) (i32.const 4)))))

    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $index) (local.get $count)))
      (local.set $record (i32.add (local.get $name)
        (i32.add (i32.const 6) (i32.mul (local.get $index) (i32.const 12)))))
      (if (i32.eq (call $tt_u16 (local.get $data) (local.get $size)
            (i32.add (local.get $record) (i32.const 6))) (i32.const 1))
        (then
          (local.set $rank (call $tt_name_rank
            (call $tt_u16 (local.get $data) (local.get $size) (local.get $record))
            (call $tt_u16 (local.get $data) (local.get $size)
              (i32.add (local.get $record) (i32.const 2)))
            (call $tt_u16 (local.get $data) (local.get $size)
              (i32.add (local.get $record) (i32.const 4)))))
          (if (i32.gt_u (local.get $rank) (local.get $best))
            (then
              (local.set $best (local.get $rank))
              (local.set $best_rec (local.get $record))))))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $scan)))
    (if (i32.eqz (local.get $best)) (then (return (i32.const 0))))

    (local.set $platform
      (call $tt_u16 (local.get $data) (local.get $size) (local.get $best_rec)))
    (local.set $wide (i32.eq (local.get $platform) (i32.const 3)))
    (local.set $length (call $tt_u16 (local.get $data) (local.get $size)
      (i32.add (local.get $best_rec) (i32.const 8))))
    (local.set $offset (i32.add (local.get $strings)
      (call $tt_u16 (local.get $data) (local.get $size)
        (i32.add (local.get $best_rec) (i32.const 10)))))
    (if (i32.or (i32.eqz (local.get $length))
          (i32.gt_u (i32.add (local.get $offset) (local.get $length))
            (local.get $size)))
      (then (return (i32.const 0))))
    (local.set $units (select
      (i32.shr_u (local.get $length) (i32.const 1)) (local.get $length)
      (local.get $wide)))
    ;; One byte of the destination belongs to the terminator.
    (if (i32.gt_u (local.get $units)
          (i32.sub (local.get $out_max) (i32.const 1)))
      (then (return (i32.const 0))))

    (local.set $index (i32.const 0))
    (block $copied (loop $copy
      (br_if $copied (i32.ge_u (local.get $index) (local.get $units)))
      (local.set $unit
        (if (result i32) (local.get $wide)
          (then (call $tt_u16 (local.get $data) (local.get $size)
            (i32.add (local.get $offset)
              (i32.mul (local.get $index) (i32.const 2)))))
          (else (call $tt_u8 (local.get $data) (local.get $size)
            (i32.add (local.get $offset) (local.get $index))))))
      (if (i32.or (i32.eqz (local.get $unit))
            (i32.gt_u (local.get $unit) (i32.const 0xFF)))
        (then (return (i32.const 0))))
      (i32.store8 (i32.add (local.get $out) (local.get $index)) (local.get $unit))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $copy)))
    (i32.store8 (i32.add (local.get $out) (local.get $units)) (i32.const 0))
    (local.get $units))

  ;; ---- hmtx -------------------------------------------------------------
  ;;
  ;; hmtx stores numberOfHMetrics {advance, lsb} pairs followed by lsb-only
  ;; entries. Monospaced tails rely on the final advance repeating for every
  ;; glyph past that count, which is why the clamp below is the spec behaviour
  ;; and not a fallback.

  (func $tt_advance_fu (param $data i32) (param $size i32) (param $gid i32)
        (result i32)
    (local $hmtx i32) (local $count i32)
    (local.set $hmtx (call $tt_table_off (local.get $data) (local.get $size)
      (i32.const 0x686D7478)))
    (local.set $count (call $tt_num_h_metrics (local.get $data) (local.get $size)))
    (if (i32.or (i32.eqz (local.get $hmtx)) (i32.eqz (local.get $count)))
      (then (return (i32.const 0))))
    (if (i32.ge_u (local.get $gid) (local.get $count))
      (then (local.set $gid (i32.sub (local.get $count) (i32.const 1)))))
    (call $tt_u16 (local.get $data) (local.get $size)
      (i32.add (local.get $hmtx) (i32.mul (local.get $gid) (i32.const 4)))))

  (func $tt_lsb_fu (param $data i32) (param $size i32) (param $gid i32)
        (result i32)
    (local $hmtx i32) (local $count i32)
    (local.set $hmtx (call $tt_table_off (local.get $data) (local.get $size)
      (i32.const 0x686D7478)))
    (local.set $count (call $tt_num_h_metrics (local.get $data) (local.get $size)))
    (if (i32.or (i32.eqz (local.get $hmtx)) (i32.eqz (local.get $count)))
      (then (return (i32.const 0))))
    (if (i32.lt_u (local.get $gid) (local.get $count))
      (then (return (call $tt_s16 (local.get $data) (local.get $size)
        (i32.add (local.get $hmtx)
          (i32.add (i32.mul (local.get $gid) (i32.const 4)) (i32.const 2)))))))
    (call $tt_s16 (local.get $data) (local.get $size)
      (i32.add (local.get $hmtx)
        (i32.add (i32.mul (local.get $count) (i32.const 4))
          (i32.mul (i32.sub (local.get $gid) (local.get $count))
            (i32.const 2))))))

  ;; ---- loca / glyf ------------------------------------------------------
  ;;
  ;; `loca` holds numGlyphs+1 offsets into `glyf`, either as u16 halves (short
  ;; format) or u32 (long). Consecutive equal entries mean the glyph has no
  ;; outline at all, which is how space is stored: an empty glyph is normal
  ;; data, not a damaged file, and it still has an advance.
  ;;
  ;; Only the glyph record's header is read here - bounds and contour count.
  ;; That is everything ABC widths need, and it is what the scan converter
  ;; will need to size its bitmap before it walks any points.

  (func $tt_loca_entry (param $data i32) (param $size i32) (param $index i32)
        (result i32)
    (local $loca i32)
    (local.set $loca (call $tt_table_off (local.get $data) (local.get $size)
      (i32.const 0x6C6F6361)))
    (if (i32.eqz (local.get $loca)) (then (return (i32.const 0))))
    (if (call $tt_index_to_loc_format (local.get $data) (local.get $size))
      (then (return (call $tt_u32 (local.get $data) (local.get $size)
        (i32.add (local.get $loca) (i32.mul (local.get $index) (i32.const 4)))))))
    ;; Short loca stores half the real offset, which is why every glyph in a
    ;; short-loca font is padded to an even length.
    (i32.mul (call $tt_u16 (local.get $data) (local.get $size)
        (i32.add (local.get $loca) (i32.mul (local.get $index) (i32.const 2))))
      (i32.const 2)))

  ;; Absolute file offset of a glyph record, or 0 when the glyph is empty,
  ;; out of range, or described by a `loca` pair that leaves `glyf`. `glyf`
  ;; itself never starts at 0, so 0 is unambiguous.
  (func $tt_glyph_offset (param $data i32) (param $size i32) (param $gid i32)
        (result i32)
    (local $glyf i32) (local $start i32) (local $end i32)
    (local.set $glyf (call $tt_table_off (local.get $data) (local.get $size)
      (i32.const 0x676C7966)))
    (if (i32.eqz (local.get $glyf)) (then (return (i32.const 0))))
    (if (i32.ge_u (local.get $gid)
          (call $tt_num_glyphs (local.get $data) (local.get $size)))
      (then (return (i32.const 0))))
    (local.set $start
      (call $tt_loca_entry (local.get $data) (local.get $size) (local.get $gid)))
    (local.set $end (call $tt_loca_entry (local.get $data) (local.get $size)
      (i32.add (local.get $gid) (i32.const 1))))
    (if (i32.le_u (local.get $end) (local.get $start))
      (then (return (i32.const 0))))
    (if (i32.gt_u (local.get $end)
          (call $tt_table_len (local.get $data) (local.get $size)
            (i32.const 0x676C7966)))
      (then (return (i32.const 0))))
    (i32.add (local.get $glyf) (local.get $start)))

  (func $tt_glyph_length (param $data i32) (param $size i32) (param $gid i32)
        (result i32)
    (if (i32.eqz (call $tt_glyph_offset (local.get $data) (local.get $size)
          (local.get $gid)))
      (then (return (i32.const 0))))
    (i32.sub
      (call $tt_loca_entry (local.get $data) (local.get $size)
        (i32.add (local.get $gid) (i32.const 1)))
      (call $tt_loca_entry (local.get $data) (local.get $size) (local.get $gid))))

  ;; Field 0 is numberOfContours, then xMin, yMin, xMax, yMax. A negative
  ;; contour count marks a composite; its bounding box is still stored here,
  ;; so ABC widths never have to recurse into the components.
  (func $tt_glyph_header (param $data i32) (param $size i32) (param $gid i32)
        (param $field i32) (result i32)
    (local $record i32)
    (local.set $record
      (call $tt_glyph_offset (local.get $data) (local.get $size) (local.get $gid)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (call $tt_s16 (local.get $data) (local.get $size)
      (i32.add (local.get $record) (i32.mul (local.get $field) (i32.const 2)))))

  (func $tt_glyph_num_contours (param $data i32) (param $size i32) (param $gid i32)
        (result i32)
    (call $tt_glyph_header (local.get $data) (local.get $size) (local.get $gid)
      (i32.const 0)))

  (func $tt_glyph_is_composite (param $data i32) (param $size i32) (param $gid i32)
        (result i32)
    (i32.lt_s (call $tt_glyph_num_contours (local.get $data) (local.get $size)
        (local.get $gid))
      (i32.const 0)))

  (func $tt_glyph_x_min (param $data i32) (param $size i32) (param $gid i32)
        (result i32)
    (call $tt_glyph_header (local.get $data) (local.get $size) (local.get $gid)
      (i32.const 1)))

  (func $tt_glyph_y_min (param $data i32) (param $size i32) (param $gid i32)
        (result i32)
    (call $tt_glyph_header (local.get $data) (local.get $size) (local.get $gid)
      (i32.const 2)))

  (func $tt_glyph_x_max (param $data i32) (param $size i32) (param $gid i32)
        (result i32)
    (call $tt_glyph_header (local.get $data) (local.get $size) (local.get $gid)
      (i32.const 3)))

  (func $tt_glyph_y_max (param $data i32) (param $size i32) (param $gid i32)
        (result i32)
    (call $tt_glyph_header (local.get $data) (local.get $size) (local.get $gid)
      (i32.const 4)))

  ;; ---- outline points ---------------------------------------------------
  ;;
  ;; A simple glyph stores its points in three run-length-ish encodings that
  ;; have to be walked in order: flags with a repeat byte, then all x deltas,
  ;; then all y deltas. The x array cannot be located without decoding every
  ;; flag first, and the y array cannot be located without measuring the x
  ;; array, so a single pass is not available however tempting it looks.
  ;;
  ;; Points are written to a caller-supplied buffer as 6-byte records:
  ;;
  ;;   +0 i16 x        font units, absolute (deltas are accumulated here)
  ;;   +2 i16 y
  ;;   +4 u8  on-curve
  ;;   +5 u8  last point of its contour
  ;;
  ;; The contour-end bit is carried per point rather than as a separate array
  ;; because every consumer walks points in order and needs to know where to
  ;; close the loop; a parallel array would have to be passed alongside and
  ;; kept in step.
  ;;
  ;; The output buffer is emulator-owned, not guest input, so its capacity is
  ;; trusted; the font bytes are not, and every read of them is bounds-checked
  ;; like the rest of this layer.

  (func $tt_glyph_point_count (param $data i32) (param $size i32) (param $gid i32)
        (result i32)
    (local $record i32) (local $contours i32)
    (local.set $record
      (call $tt_glyph_offset (local.get $data) (local.get $size) (local.get $gid)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (local.set $contours
      (call $tt_glyph_num_contours (local.get $data) (local.get $size)
        (local.get $gid)))
    (if (i32.le_s (local.get $contours) (i32.const 0))
      (then (return (i32.const 0))))
    ;; endPtsOfContours is indexed from the last entry: the final end point
    ;; plus one is the count, and there is no separate count field.
    (i32.add (call $tt_u16 (local.get $data) (local.get $size)
        (i32.add (local.get $record) (i32.add (i32.const 10)
          (i32.mul (i32.sub (local.get $contours) (i32.const 1))
            (i32.const 2)))))
      (i32.const 1)))

  (func $tt_glyph_load_points (param $data i32) (param $size i32) (param $gid i32)
        (param $out i32) (param $capacity i32) (result i32)
    (local $record i32) (local $contours i32) (local $count i32) (local $ends i32)
    (local $cursor i32) (local $index i32) (local $flag i32) (local $repeat i32)
    (local $value i32) (local $slot i32)
    (local.set $record
      (call $tt_glyph_offset (local.get $data) (local.get $size) (local.get $gid)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (local.set $contours
      (call $tt_glyph_num_contours (local.get $data) (local.get $size)
        (local.get $gid)))
    ;; Composites are not points and must be recursed into by the caller.
    (if (i32.le_s (local.get $contours) (i32.const 0))
      (then (return (i32.const 0))))
    (local.set $count
      (call $tt_glyph_point_count (local.get $data) (local.get $size)
        (local.get $gid)))
    (if (i32.or (i32.eqz (local.get $count))
          (i32.gt_u (local.get $count) (local.get $capacity)))
      (then (return (i32.const 0))))
    (local.set $ends (i32.add (local.get $record) (i32.const 10)))
    ;; Skip the endPts array, the instruction length, and the hinting program
    ;; itself: this layer never runs bytecode.
    (local.set $cursor (i32.add (local.get $ends)
      (i32.add (i32.mul (local.get $contours) (i32.const 2))
        (i32.add (i32.const 2)
          (call $tt_u16 (local.get $data) (local.get $size)
            (i32.add (local.get $ends)
              (i32.mul (local.get $contours) (i32.const 2))))))))

    ;; Pass 1: flags, with bit 3 repeating the previous flag. The raw byte is
    ;; parked in the record's on-curve slot and narrowed at the end.
    (block $flags_done (loop $flags
      (br_if $flags_done (i32.ge_u (local.get $index) (local.get $count)))
      (local.set $flag
        (call $tt_u8 (local.get $data) (local.get $size) (local.get $cursor)))
      (local.set $cursor (i32.add (local.get $cursor) (i32.const 1)))
      (i32.store8 (i32.add (local.get $out)
          (i32.add (i32.mul (local.get $index) (i32.const 6)) (i32.const 4)))
        (local.get $flag))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (if (i32.and (local.get $flag) (i32.const 0x08))
        (then
          (local.set $repeat
            (call $tt_u8 (local.get $data) (local.get $size) (local.get $cursor)))
          (local.set $cursor (i32.add (local.get $cursor) (i32.const 1)))
          (block $repeat_done (loop $repeats
            (br_if $repeat_done (i32.eqz (local.get $repeat)))
            (br_if $repeat_done (i32.ge_u (local.get $index) (local.get $count)))
            (i32.store8 (i32.add (local.get $out)
                (i32.add (i32.mul (local.get $index) (i32.const 6)) (i32.const 4)))
              (local.get $flag))
            (local.set $index (i32.add (local.get $index) (i32.const 1)))
            (local.set $repeat (i32.sub (local.get $repeat) (i32.const 1)))
            (br $repeats)))))
      (br $flags)))

    ;; Pass 2: x deltas. Bit 1 means a one-byte delta whose sign lives in bit
    ;; 4; with bit 1 clear, bit 4 instead means "same as previous", which is
    ;; how a vertical run costs nothing.
    (local.set $index (i32.const 0))
    (local.set $value (i32.const 0))
    (block $x_done (loop $xs
      (br_if $x_done (i32.ge_u (local.get $index) (local.get $count)))
      (local.set $slot
        (i32.add (local.get $out) (i32.mul (local.get $index) (i32.const 6))))
      (local.set $flag (i32.load8_u (i32.add (local.get $slot) (i32.const 4))))
      (if (i32.and (local.get $flag) (i32.const 0x02))
        (then
          (local.set $repeat
            (call $tt_u8 (local.get $data) (local.get $size) (local.get $cursor)))
          (local.set $cursor (i32.add (local.get $cursor) (i32.const 1)))
          (if (i32.eqz (i32.and (local.get $flag) (i32.const 0x10)))
            (then (local.set $repeat (i32.sub (i32.const 0) (local.get $repeat)))))
          (local.set $value (i32.add (local.get $value) (local.get $repeat))))
        (else
          (if (i32.eqz (i32.and (local.get $flag) (i32.const 0x10)))
            (then
              (local.set $value (i32.add (local.get $value)
                (call $tt_s16 (local.get $data) (local.get $size)
                  (local.get $cursor))))
              (local.set $cursor (i32.add (local.get $cursor) (i32.const 2)))))))
      (i32.store16 (local.get $slot) (local.get $value))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $xs)))

    ;; Pass 3: y deltas, same encoding one bit over.
    (local.set $index (i32.const 0))
    (local.set $value (i32.const 0))
    (block $y_done (loop $ys
      (br_if $y_done (i32.ge_u (local.get $index) (local.get $count)))
      (local.set $slot
        (i32.add (local.get $out) (i32.mul (local.get $index) (i32.const 6))))
      (local.set $flag (i32.load8_u (i32.add (local.get $slot) (i32.const 4))))
      (if (i32.and (local.get $flag) (i32.const 0x04))
        (then
          (local.set $repeat
            (call $tt_u8 (local.get $data) (local.get $size) (local.get $cursor)))
          (local.set $cursor (i32.add (local.get $cursor) (i32.const 1)))
          (if (i32.eqz (i32.and (local.get $flag) (i32.const 0x20)))
            (then (local.set $repeat (i32.sub (i32.const 0) (local.get $repeat)))))
          (local.set $value (i32.add (local.get $value) (local.get $repeat))))
        (else
          (if (i32.eqz (i32.and (local.get $flag) (i32.const 0x20)))
            (then
              (local.set $value (i32.add (local.get $value)
                (call $tt_s16 (local.get $data) (local.get $size)
                  (local.get $cursor))))
              (local.set $cursor (i32.add (local.get $cursor) (i32.const 2)))))))
      (i32.store16 (i32.add (local.get $slot) (i32.const 2)) (local.get $value))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $ys)))

    ;; Narrow the parked flag byte to the on-curve bit and clear the contour
    ;; marker, then set it on each contour's last point.
    (local.set $index (i32.const 0))
    (block $narrow_done (loop $narrow
      (br_if $narrow_done (i32.ge_u (local.get $index) (local.get $count)))
      (local.set $slot (i32.add (local.get $out)
        (i32.add (i32.mul (local.get $index) (i32.const 6)) (i32.const 4))))
      (i32.store8 (local.get $slot)
        (i32.and (i32.load8_u (local.get $slot)) (i32.const 1)))
      (i32.store8 (i32.add (local.get $slot) (i32.const 1)) (i32.const 0))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $narrow)))

    (local.set $index (i32.const 0))
    (block $ends_done (loop $mark
      (br_if $ends_done (i32.ge_u (local.get $index) (local.get $contours)))
      (local.set $value (call $tt_u16 (local.get $data) (local.get $size)
        (i32.add (local.get $ends) (i32.mul (local.get $index) (i32.const 2)))))
      (if (i32.lt_u (local.get $value) (local.get $count))
        (then (i32.store8 (i32.add (local.get $out)
            (i32.add (i32.mul (local.get $value) (i32.const 6)) (i32.const 5)))
          (i32.const 1))))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $mark)))

    (local.get $count))

  ;; ---- composite glyphs -------------------------------------------------
  ;;
  ;; A composite names other glyphs and places them, which is how nearly every
  ;; accented character is stored: 'Á' is 'A' at the origin plus an acute
  ;; shifted right. Treating a composite as an empty glyph renders accented
  ;; text as blanks, so the recursion is not optional for a Western corpus.
  ;;
  ;; Placement comes either as an explicit offset or, when ARGS_ARE_XY_VALUES
  ;; is clear, as a pair of point indices to be brought into coincidence —
  ;; one already placed, one in the component. Point matching happens after
  ;; the component's own 2x2 transform, because matching first would align
  ;; points that then move.
  ;;
  ;; Depth is bounded explicitly: a font is untrusted input and a composite
  ;; that names itself would otherwise recurse until the stack gives out.

  (func $tt_s8 (param $data i32) (param $size i32) (param $off i32) (result i32)
    (i32.shr_s
      (i32.shl (call $tt_u8 (local.get $data) (local.get $size) (local.get $off))
        (i32.const 24))
      (i32.const 24)))

  ;; F2Dot14: a signed 16-bit fraction with 14 bits after the point, so 0x4000
  ;; is exactly 1.0.
  (func $tt_f2dot14 (param $data i32) (param $size i32) (param $off i32)
        (result i32)
    (call $tt_s16 (local.get $data) (local.get $size) (local.get $off)))

  (func $tt_apply_2x2 (param $out i32) (param $count i32)
        (param $a i32) (param $b i32) (param $c i32) (param $d i32)
    (local $index i32) (local $x i32) (local $y i32) (local $slot i32)
    (if (i32.and
          (i32.and (i32.eq (local.get $a) (i32.const 0x4000))
            (i32.eq (local.get $d) (i32.const 0x4000)))
          (i32.and (i32.eqz (local.get $b)) (i32.eqz (local.get $c))))
      (then (return)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $index) (local.get $count)))
      (local.set $slot
        (i32.add (local.get $out) (i32.mul (local.get $index) (i32.const 6))))
      (local.set $x (call $tt_point_x (local.get $out) (local.get $index)))
      (local.set $y (call $tt_point_y (local.get $out) (local.get $index)))
      (i32.store16 (local.get $slot) (call $gdi_round_ratio
        (i64.add
          (i64.mul (i64.extend_i32_s (local.get $a)) (i64.extend_i32_s (local.get $x)))
          (i64.mul (i64.extend_i32_s (local.get $c)) (i64.extend_i32_s (local.get $y))))
        (i64.const 16384)))
      (i32.store16 (i32.add (local.get $slot) (i32.const 2))
        (call $gdi_round_ratio
          (i64.add
            (i64.mul (i64.extend_i32_s (local.get $b)) (i64.extend_i32_s (local.get $x)))
            (i64.mul (i64.extend_i32_s (local.get $d)) (i64.extend_i32_s (local.get $y))))
          (i64.const 16384)))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $scan))))

  (func $tt_translate (param $out i32) (param $count i32) (param $dx i32)
        (param $dy i32)
    (local $index i32) (local $slot i32)
    (if (i32.and (i32.eqz (local.get $dx)) (i32.eqz (local.get $dy)))
      (then (return)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $index) (local.get $count)))
      (local.set $slot
        (i32.add (local.get $out) (i32.mul (local.get $index) (i32.const 6))))
      (i32.store16 (local.get $slot)
        (i32.add (call $tt_point_x (local.get $out) (local.get $index))
          (local.get $dx)))
      (i32.store16 (i32.add (local.get $slot) (i32.const 2))
        (i32.add (call $tt_point_y (local.get $out) (local.get $index))
          (local.get $dy)))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $scan))))

  (func $tt_glyph_load_outline (param $data i32) (param $size i32) (param $gid i32)
        (param $out i32) (param $capacity i32) (param $depth i32) (result i32)
    (local $contours i32) (local $cursor i32) (local $flags i32) (local $part i32)
    (local $arg1 i32) (local $arg2 i32) (local $a i32) (local $b i32)
    (local $c i32) (local $d i32) (local $total i32) (local $added i32)
    (local $dx i32) (local $dy i32) (local $slot i32)
    (if (i32.gt_u (local.get $depth) (i32.const 4))
      (then (return (i32.const 0))))
    (local.set $contours
      (call $tt_glyph_num_contours (local.get $data) (local.get $size)
        (local.get $gid)))
    (if (i32.gt_s (local.get $contours) (i32.const 0))
      (then (return (call $tt_glyph_load_points (local.get $data) (local.get $size)
        (local.get $gid) (local.get $out) (local.get $capacity)))))
    (if (i32.eqz (local.get $contours)) (then (return (i32.const 0))))

    (local.set $cursor
      (i32.add (call $tt_glyph_offset (local.get $data) (local.get $size)
          (local.get $gid))
        (i32.const 10)))
    (block $done (loop $components
      (local.set $flags
        (call $tt_u16 (local.get $data) (local.get $size) (local.get $cursor)))
      (local.set $part (call $tt_u16 (local.get $data) (local.get $size)
        (i32.add (local.get $cursor) (i32.const 2))))
      (local.set $cursor (i32.add (local.get $cursor) (i32.const 4)))
      (if (i32.and (local.get $flags) (i32.const 0x0001))
        (then
          (local.set $arg1
            (call $tt_s16 (local.get $data) (local.get $size) (local.get $cursor)))
          (local.set $arg2 (call $tt_s16 (local.get $data) (local.get $size)
            (i32.add (local.get $cursor) (i32.const 2))))
          (local.set $cursor (i32.add (local.get $cursor) (i32.const 4))))
        (else
          (local.set $arg1
            (call $tt_s8 (local.get $data) (local.get $size) (local.get $cursor)))
          (local.set $arg2 (call $tt_s8 (local.get $data) (local.get $size)
            (i32.add (local.get $cursor) (i32.const 1))))
          (local.set $cursor (i32.add (local.get $cursor) (i32.const 2)))))
      (local.set $a (i32.const 0x4000))
      (local.set $b (i32.const 0))
      (local.set $c (i32.const 0))
      (local.set $d (i32.const 0x4000))
      (if (i32.and (local.get $flags) (i32.const 0x0008))
        (then
          (local.set $a
            (call $tt_f2dot14 (local.get $data) (local.get $size) (local.get $cursor)))
          (local.set $d (local.get $a))
          (local.set $cursor (i32.add (local.get $cursor) (i32.const 2))))
        (else (if (i32.and (local.get $flags) (i32.const 0x0040))
          (then
            (local.set $a (call $tt_f2dot14 (local.get $data) (local.get $size)
              (local.get $cursor)))
            (local.set $d (call $tt_f2dot14 (local.get $data) (local.get $size)
              (i32.add (local.get $cursor) (i32.const 2))))
            (local.set $cursor (i32.add (local.get $cursor) (i32.const 4))))
          (else (if (i32.and (local.get $flags) (i32.const 0x0080))
            (then
              (local.set $a (call $tt_f2dot14 (local.get $data) (local.get $size)
                (local.get $cursor)))
              (local.set $b (call $tt_f2dot14 (local.get $data) (local.get $size)
                (i32.add (local.get $cursor) (i32.const 2))))
              (local.set $c (call $tt_f2dot14 (local.get $data) (local.get $size)
                (i32.add (local.get $cursor) (i32.const 4))))
              (local.set $d (call $tt_f2dot14 (local.get $data) (local.get $size)
                (i32.add (local.get $cursor) (i32.const 6))))
              (local.set $cursor (i32.add (local.get $cursor) (i32.const 8)))))))))

      ;; A composite that only half fits is worse than none: a caller cannot
      ;; tell an acute with no 'A' under it from a real glyph, so running out
      ;; of room, exceeding the depth limit, or hitting a malformed component
      ;; refuses the whole glyph rather than returning part of it. A component
      ;; that is genuinely empty contributes nothing and is not a failure.
      (if (i32.ge_u (local.get $total) (local.get $capacity))
        (then (return (i32.const 0))))
      (local.set $slot
        (i32.add (local.get $out) (i32.mul (local.get $total) (i32.const 6))))
      (local.set $added (call $tt_glyph_load_outline (local.get $data)
        (local.get $size) (local.get $part) (local.get $slot)
        (i32.sub (local.get $capacity) (local.get $total))
        (i32.add (local.get $depth) (i32.const 1))))
      (if (i32.eqz (local.get $added))
        (then
          (if (call $tt_glyph_num_contours (local.get $data) (local.get $size)
                (local.get $part))
            (then (return (i32.const 0))))))
      (if (local.get $added)
        (then
          (call $tt_apply_2x2 (local.get $slot) (local.get $added)
            (local.get $a) (local.get $b) (local.get $c) (local.get $d))
          (if (i32.and (local.get $flags) (i32.const 0x0002))
            (then
              (local.set $dx (local.get $arg1))
              (local.set $dy (local.get $arg2)))
            (else
              ;; Point matching. Out-of-range indices mean a malformed font;
              ;; placing the component at the origin is the bounded answer.
              (local.set $dx (i32.const 0))
              (local.set $dy (i32.const 0))
              (if (i32.and (i32.lt_u (local.get $arg1) (local.get $total))
                    (i32.lt_u (local.get $arg2) (local.get $added)))
                (then
                  (local.set $dx (i32.sub
                    (call $tt_point_x (local.get $out) (local.get $arg1))
                    (call $tt_point_x (local.get $slot) (local.get $arg2))))
                  (local.set $dy (i32.sub
                    (call $tt_point_y (local.get $out) (local.get $arg1))
                    (call $tt_point_y (local.get $slot) (local.get $arg2))))))))
          (call $tt_translate (local.get $slot) (local.get $added)
            (local.get $dx) (local.get $dy))
          (local.set $total (i32.add (local.get $total) (local.get $added)))))
      (br_if $done (i32.eqz (i32.and (local.get $flags) (i32.const 0x0020))))
      (br $components)))
    (local.get $total))

  ;; Signed accessors for the packed records, so callers never re-derive the
  ;; stride or forget that coordinates are signed.
  (func $tt_point_x (param $out i32) (param $index i32) (result i32)
    (i32.load16_s (i32.add (local.get $out)
      (i32.mul (local.get $index) (i32.const 6)))))

  (func $tt_point_y (param $out i32) (param $index i32) (result i32)
    (i32.load16_s (i32.add (local.get $out)
      (i32.add (i32.mul (local.get $index) (i32.const 6)) (i32.const 2)))))

  (func $tt_point_on_curve (param $out i32) (param $index i32) (result i32)
    (i32.load8_u (i32.add (local.get $out)
      (i32.add (i32.mul (local.get $index) (i32.const 6)) (i32.const 4)))))

  (func $tt_point_ends_contour (param $out i32) (param $index i32) (result i32)
    (i32.load8_u (i32.add (local.get $out)
      (i32.add (i32.mul (local.get $index) (i32.const 6)) (i32.const 5)))))

  ;; ---- flattening -------------------------------------------------------
  ;;
  ;; Contours become a list of straight edges in 26.6 fixed point (1/64 pixel),
  ;; which is the unit GDI itself works in and enough precision that rounding
  ;; never decides a pixel at UI sizes.
  ;;
  ;; TrueType stores quadratics with the on-curve point *between* two
  ;; consecutive off-curve points left implied at their midpoint. Omitting
  ;; that reconstruction does not produce a slightly wrong curve; it produces
  ;; a curve through the wrong points entirely, and a contour that may not
  ;; even close.
  ;;
  ;; Edge records are four i32: x0, y0, x1, y1. Horizontal edges are dropped
  ;; because scan conversion crosses edges against horizontal sample lines and
  ;; a horizontal edge has no crossing to contribute - keeping them would only
  ;; add a division by a zero height later.

  (func $tt_fu_to_26_6 (param $value i32) (param $ppem i32) (param $upem i32)
        (result i32)
    (if (i32.le_s (local.get $upem) (i32.const 0))
      (then (return (i32.const 0))))
    (call $gdi_round_ratio
      (i64.mul (i64.extend_i32_s (local.get $value))
        (i64.extend_i32_s (i32.mul (local.get $ppem) (i32.const 64))))
      (i64.extend_i32_s (local.get $upem))))

  ;; Returns the new edge count, or -1 when the buffer is full. -1 propagates
  ;; so a truncated edge list can never be mistaken for a complete outline.
  (func $tt_emit_edge (param $edges i32) (param $capacity i32) (param $count i32)
        (param $x0 i32) (param $y0 i32) (param $x1 i32) (param $y1 i32)
        (result i32)
    (local $slot i32)
    (if (i32.lt_s (local.get $count) (i32.const 0))
      (then (return (i32.const -1))))
    (if (i32.eq (local.get $y0) (local.get $y1))
      (then (return (local.get $count))))
    (if (i32.ge_u (local.get $count) (local.get $capacity))
      (then (return (i32.const -1))))
    (local.set $slot
      (i32.add (local.get $edges) (i32.mul (local.get $count) (i32.const 16))))
    (i32.store (local.get $slot) (local.get $x0))
    (i32.store offset=4 (local.get $slot) (local.get $y0))
    (i32.store offset=8 (local.get $slot) (local.get $x1))
    (i32.store offset=12 (local.get $slot) (local.get $y1))
    (i32.add (local.get $count) (i32.const 1)))

  ;; Fixed subdivision, sized from the control polygon so a tight curve gets
  ;; more segments than a shallow one. Adaptive subdivision by deviation only
  ;; pays off well above UI sizes, where the hinted strike ladder no longer
  ;; applies.
  (func $tt_quad_segments (param $x0 i32) (param $y0 i32) (param $cx i32)
        (param $cy i32) (param $x1 i32) (param $y1 i32) (result i32)
    (local $span i32)
    (local.set $span (i32.add
      (i32.add (call $tt_abs (i32.sub (local.get $cx) (local.get $x0)))
        (call $tt_abs (i32.sub (local.get $cy) (local.get $y0))))
      (i32.add (call $tt_abs (i32.sub (local.get $x1) (local.get $cx)))
        (call $tt_abs (i32.sub (local.get $y1) (local.get $cy))))))
    (local.set $span
      (i32.add (i32.const 2) (i32.shr_u (local.get $span) (i32.const 8))))
    (select (i32.const 16) (local.get $span)
      (i32.gt_u (local.get $span) (i32.const 16))))

  (func $tt_abs (param $value i32) (result i32)
    (select (i32.sub (i32.const 0) (local.get $value)) (local.get $value)
      (i32.lt_s (local.get $value) (i32.const 0))))

  ;; de Casteljau evaluated as an exact rational at t = step/segments, so the
  ;; endpoints land on the real curve rather than on an accumulated sum.
  (func $tt_quad_at (param $p0 i32) (param $control i32) (param $p1 i32)
        (param $step i32) (param $segments i32) (result i32)
    (local $rest i32)
    (local.set $rest (i32.sub (local.get $segments) (local.get $step)))
    (call $gdi_round_ratio
      (i64.add
        (i64.add
          (i64.mul (i64.extend_i32_s (i32.mul (local.get $rest) (local.get $rest)))
            (i64.extend_i32_s (local.get $p0)))
          (i64.mul (i64.extend_i32_s
              (i32.mul (i32.const 2) (i32.mul (local.get $rest) (local.get $step))))
            (i64.extend_i32_s (local.get $control))))
        (i64.mul (i64.extend_i32_s (i32.mul (local.get $step) (local.get $step)))
          (i64.extend_i32_s (local.get $p1))))
      (i64.extend_i32_s (i32.mul (local.get $segments) (local.get $segments)))))

  (func $tt_emit_quad (param $edges i32) (param $capacity i32) (param $count i32)
        (param $x0 i32) (param $y0 i32) (param $cx i32) (param $cy i32)
        (param $x1 i32) (param $y1 i32) (result i32)
    (local $segments i32) (local $step i32) (local $px i32) (local $py i32)
    (local $nx i32) (local $ny i32)
    (local.set $segments (call $tt_quad_segments (local.get $x0) (local.get $y0)
      (local.get $cx) (local.get $cy) (local.get $x1) (local.get $y1)))
    (local.set $px (local.get $x0))
    (local.set $py (local.get $y0))
    (local.set $step (i32.const 1))
    (block $done (loop $walk
      (br_if $done (i32.gt_u (local.get $step) (local.get $segments)))
      (local.set $nx (call $tt_quad_at (local.get $x0) (local.get $cx)
        (local.get $x1) (local.get $step) (local.get $segments)))
      (local.set $ny (call $tt_quad_at (local.get $y0) (local.get $cy)
        (local.get $y1) (local.get $step) (local.get $segments)))
      (local.set $count (call $tt_emit_edge (local.get $edges) (local.get $capacity)
        (local.get $count) (local.get $px) (local.get $py)
        (local.get $nx) (local.get $ny)))
      (local.set $px (local.get $nx))
      (local.set $py (local.get $ny))
      (local.set $step (i32.add (local.get $step) (i32.const 1)))
      (br $walk)))
    (local.get $count))

  ;; Point accessors in 26.6 pixels, so the contour walk never mixes units.
  (func $tt_point_x_26_6 (param $points i32) (param $index i32) (param $ppem i32)
        (param $upem i32) (result i32)
    (call $tt_fu_to_26_6 (call $tt_point_x (local.get $points) (local.get $index))
      (local.get $ppem) (local.get $upem)))

  (func $tt_point_y_26_6 (param $points i32) (param $index i32) (param $ppem i32)
        (param $upem i32) (result i32)
    (call $tt_fu_to_26_6 (call $tt_point_y (local.get $points) (local.get $index))
      (local.get $ppem) (local.get $upem)))

  (func $tt_glyph_edges (param $data i32) (param $size i32) (param $gid i32)
        (param $ppem i32) (param $points i32) (param $points_cap i32)
        (param $edges i32) (param $edges_cap i32) (result i32)
    (local $count i32) (local $upem i32) (local $start i32) (local $end i32)
    (local $length i32) (local $first i32) (local $index i32) (local $step i32)
    (local $edge_count i32) (local $sx i32) (local $sy i32) (local $cur_x i32)
    (local $cur_y i32) (local $ctrl_x i32) (local $ctrl_y i32) (local $pending i32)
    (local $px i32) (local $py i32) (local $mid_x i32) (local $mid_y i32)
    (local.set $count (call $tt_glyph_load_outline (local.get $data)
      (local.get $size) (local.get $gid) (local.get $points) (local.get $points_cap)
      (i32.const 0)))
    (if (i32.eqz (local.get $count)) (then (return (i32.const 0))))
    (local.set $upem (call $tt_units_per_em (local.get $data) (local.get $size)))

    (block $contours_done (loop $contours
      (br_if $contours_done (i32.ge_u (local.get $start) (local.get $count)))
      ;; Find this contour's last point. A missing end marker would run to the
      ;; end of the glyph, which is the bounded reading of a malformed font.
      (local.set $end (local.get $start))
      (block $end_found (loop $seek
        (br_if $end_found (i32.ge_u (local.get $end)
          (i32.sub (local.get $count) (i32.const 1))))
        (br_if $end_found
          (call $tt_point_ends_contour (local.get $points) (local.get $end)))
        (local.set $end (i32.add (local.get $end) (i32.const 1)))
        (br $seek)))
      (local.set $length
        (i32.add (i32.sub (local.get $end) (local.get $start)) (i32.const 1)))

      ;; The contour must begin at an on-curve point. When neither the first
      ;; nor the last point is on-curve the real start is their midpoint,
      ;; which is the same implied-point rule applied to the seam.
      (if (call $tt_point_on_curve (local.get $points) (local.get $start))
        (then
          (local.set $sx (call $tt_point_x_26_6 (local.get $points)
            (local.get $start) (local.get $ppem) (local.get $upem)))
          (local.set $sy (call $tt_point_y_26_6 (local.get $points)
            (local.get $start) (local.get $ppem) (local.get $upem)))
          (local.set $first (i32.add (local.get $start) (i32.const 1))))
        (else (if (call $tt_point_on_curve (local.get $points) (local.get $end))
          (then
            (local.set $sx (call $tt_point_x_26_6 (local.get $points)
              (local.get $end) (local.get $ppem) (local.get $upem)))
            (local.set $sy (call $tt_point_y_26_6 (local.get $points)
              (local.get $end) (local.get $ppem) (local.get $upem)))
            (local.set $first (local.get $start)))
          (else
            (local.set $sx (i32.shr_s (i32.add
              (call $tt_point_x_26_6 (local.get $points) (local.get $start)
                (local.get $ppem) (local.get $upem))
              (call $tt_point_x_26_6 (local.get $points) (local.get $end)
                (local.get $ppem) (local.get $upem))) (i32.const 1)))
            (local.set $sy (i32.shr_s (i32.add
              (call $tt_point_y_26_6 (local.get $points) (local.get $start)
                (local.get $ppem) (local.get $upem))
              (call $tt_point_y_26_6 (local.get $points) (local.get $end)
                (local.get $ppem) (local.get $upem))) (i32.const 1)))
            (local.set $first (local.get $start))))))
      (local.set $cur_x (local.get $sx))
      (local.set $cur_y (local.get $sy))
      (local.set $pending (i32.const 0))

      (local.set $step (i32.const 0))
      (block $walk_done (loop $walk
        (br_if $walk_done (i32.ge_u (local.get $step) (local.get $length)))
        (local.set $index (i32.add (local.get $start)
          (i32.rem_u (i32.add (i32.sub (local.get $first) (local.get $start))
              (local.get $step))
            (local.get $length))))
        (local.set $px (call $tt_point_x_26_6 (local.get $points) (local.get $index)
          (local.get $ppem) (local.get $upem)))
        (local.set $py (call $tt_point_y_26_6 (local.get $points) (local.get $index)
          (local.get $ppem) (local.get $upem)))
        (if (call $tt_point_on_curve (local.get $points) (local.get $index))
          (then
            (if (local.get $pending)
              (then
                (local.set $edge_count (call $tt_emit_quad (local.get $edges)
                  (local.get $edges_cap) (local.get $edge_count)
                  (local.get $cur_x) (local.get $cur_y)
                  (local.get $ctrl_x) (local.get $ctrl_y)
                  (local.get $px) (local.get $py)))
                (local.set $pending (i32.const 0)))
              (else
                (local.set $edge_count (call $tt_emit_edge (local.get $edges)
                  (local.get $edges_cap) (local.get $edge_count)
                  (local.get $cur_x) (local.get $cur_y)
                  (local.get $px) (local.get $py)))))
            (local.set $cur_x (local.get $px))
            (local.set $cur_y (local.get $py)))
          (else
            ;; Two off-curve points in a row imply an on-curve point at their
            ;; midpoint; that implied point ends one quadratic and starts the
            ;; next.
            (if (local.get $pending)
              (then
                (local.set $mid_x (i32.shr_s
                  (i32.add (local.get $ctrl_x) (local.get $px)) (i32.const 1)))
                (local.set $mid_y (i32.shr_s
                  (i32.add (local.get $ctrl_y) (local.get $py)) (i32.const 1)))
                (local.set $edge_count (call $tt_emit_quad (local.get $edges)
                  (local.get $edges_cap) (local.get $edge_count)
                  (local.get $cur_x) (local.get $cur_y)
                  (local.get $ctrl_x) (local.get $ctrl_y)
                  (local.get $mid_x) (local.get $mid_y)))
                (local.set $cur_x (local.get $mid_x))
                (local.set $cur_y (local.get $mid_y))))
            (local.set $ctrl_x (local.get $px))
            (local.set $ctrl_y (local.get $py))
            (local.set $pending (i32.const 1))))
        (local.set $step (i32.add (local.get $step) (i32.const 1)))
        (br $walk)))

      ;; Close the contour. An unclosed contour makes the winding rule read
      ;; the outside of the glyph as inside.
      (if (local.get $pending)
        (then (local.set $edge_count (call $tt_emit_quad (local.get $edges)
          (local.get $edges_cap) (local.get $edge_count)
          (local.get $cur_x) (local.get $cur_y) (local.get $ctrl_x)
          (local.get $ctrl_y) (local.get $sx) (local.get $sy))))
        (else (local.set $edge_count (call $tt_emit_edge (local.get $edges)
          (local.get $edges_cap) (local.get $edge_count)
          (local.get $cur_x) (local.get $cur_y) (local.get $sx) (local.get $sy)))))

      (local.set $start (i32.add (local.get $end) (i32.const 1)))
      (br $contours)))

    (if (i32.lt_s (local.get $edge_count) (i32.const 0))
      (then (return (i32.const 0))))
    (local.get $edge_count))

  (func $tt_edge_field (param $edges i32) (param $index i32) (param $field i32)
        (result i32)
    (i32.load (i32.add (local.get $edges)
      (i32.add (i32.mul (local.get $index) (i32.const 16))
        (i32.mul (local.get $field) (i32.const 4))))))

  ;; ---- scan conversion --------------------------------------------------
  ;;
  ;; Edges become a one-bit glyph bitmap in the *same* column-major layout
  ;; `$gdi_bitmap_font_glyph_pixel` already reads for FNT strikes: byte
  ;; (x >> 3) * height + y, bit 0x80 >> (x & 7). Matching that layout is what
  ;; makes a rasterized glyph indistinguishable from a strike glyph to every
  ;; consumer above, which is the whole reason this produces bitmaps rather
  ;; than a new drawing path.
  ;;
  ;; Filling is nonzero winding: a counter is cut out because its contour runs
  ;; the opposite direction, not because it is the second contour. Coverage is
  ;; accumulated rather than sampled to a single bit per pixel, so the 50%
  ;; threshold at the end is the only place the answer becomes binary and real
  ;; antialiasing stays available if Win98's "smooth edges of screen fonts" is
  ;; ever emulated.
  ;;
  ;; Vertical is sampled at four sub-rows and horizontal is computed exactly
  ;; as span overlap. Sampling both axes would need 16 passes for the same
  ;; horizontal precision one subtraction gives, and the pixel-center rule the
  ;; TrueType specification describes needs intricate drop-out control that
  ;; accumulated coverage sidesteps entirely.

  (global $TT_SUBROWS i32 (i32.const 4))
  (global $TT_RASTER_POINTS i32 (i32.const 256))
  (global $TT_RASTER_EDGES i32 (i32.const 1024))
  (global $TT_RASTER_CROSSINGS i32 (i32.const 256))

  ;; Scratch is one caller-supplied block partitioned here, so callers size it
  ;; from this function rather than re-deriving four capacities.
  (func $tt_raster_scratch_bytes (param $width i32) (result i32)
    (i32.add
      (i32.add (i32.mul (global.get $TT_RASTER_POINTS) (i32.const 6))
        (i32.mul (global.get $TT_RASTER_EDGES) (i32.const 16)))
      (i32.add (i32.mul (global.get $TT_RASTER_CROSSINGS) (i32.const 8))
        (i32.mul (local.get $width) (i32.const 4)))))

  ;; Arithmetic shift is floor division for negatives, which is what pixel
  ;; boundaries need; truncation toward zero would move the box under the
  ;; baseline by a pixel for any glyph with a descender.
  (func $tt_floor_px (param $value_26_6 i32) (result i32)
    (i32.shr_s (local.get $value_26_6) (i32.const 6)))

  (func $tt_ceil_px (param $value_26_6 i32) (result i32)
    (i32.sub (i32.const 0)
      (i32.shr_s (i32.sub (i32.const 0) (local.get $value_26_6)) (i32.const 6))))

  (func $tt_glyph_box_left (param $data i32) (param $size i32) (param $gid i32)
        (param $ppem i32) (result i32)
    (call $tt_floor_px (call $tt_fu_to_26_6
      (call $tt_glyph_x_min (local.get $data) (local.get $size) (local.get $gid))
      (local.get $ppem)
      (call $tt_units_per_em (local.get $data) (local.get $size)))))

  (func $tt_glyph_box_top (param $data i32) (param $size i32) (param $gid i32)
        (param $ppem i32) (result i32)
    (call $tt_ceil_px (call $tt_fu_to_26_6
      (call $tt_glyph_y_max (local.get $data) (local.get $size) (local.get $gid))
      (local.get $ppem)
      (call $tt_units_per_em (local.get $data) (local.get $size)))))

  (func $tt_glyph_box_width (param $data i32) (param $size i32) (param $gid i32)
        (param $ppem i32) (result i32)
    (i32.sub
      (call $tt_ceil_px (call $tt_fu_to_26_6
        (call $tt_glyph_x_max (local.get $data) (local.get $size) (local.get $gid))
        (local.get $ppem)
        (call $tt_units_per_em (local.get $data) (local.get $size))))
      (call $tt_glyph_box_left (local.get $data) (local.get $size) (local.get $gid)
        (local.get $ppem))))

  (func $tt_glyph_box_height (param $data i32) (param $size i32) (param $gid i32)
        (param $ppem i32) (result i32)
    (i32.sub
      (call $tt_glyph_box_top (local.get $data) (local.get $size) (local.get $gid)
        (local.get $ppem))
      (call $tt_floor_px (call $tt_fu_to_26_6
        (call $tt_glyph_y_min (local.get $data) (local.get $size) (local.get $gid))
        (local.get $ppem)
        (call $tt_units_per_em (local.get $data) (local.get $size))))))

  ;; Insertion sort: crossings per scan line are few and nearly sorted from
  ;; one line to the next, which is the case insertion sort is good at and
  ;; quicksort is not.
  (func $tt_sort_crossings (param $crossings i32) (param $count i32)
    (local $index i32) (local $probe i32) (local $x i32) (local $dir i32)
    (local.set $index (i32.const 1))
    (block $done (loop $outer
      (br_if $done (i32.ge_u (local.get $index) (local.get $count)))
      (local.set $x (i32.load
        (i32.add (local.get $crossings) (i32.mul (local.get $index) (i32.const 8)))))
      (local.set $dir (i32.load offset=4
        (i32.add (local.get $crossings) (i32.mul (local.get $index) (i32.const 8)))))
      (local.set $probe (local.get $index))
      (block $placed (loop $shift
        (br_if $placed (i32.eqz (local.get $probe)))
        (br_if $placed (i32.le_s
          (i32.load (i32.add (local.get $crossings)
            (i32.mul (i32.sub (local.get $probe) (i32.const 1)) (i32.const 8))))
          (local.get $x)))
        (i64.store
          (i32.add (local.get $crossings) (i32.mul (local.get $probe) (i32.const 8)))
          (i64.load (i32.add (local.get $crossings)
            (i32.mul (i32.sub (local.get $probe) (i32.const 1)) (i32.const 8)))))
        (local.set $probe (i32.sub (local.get $probe) (i32.const 1)))
        (br $shift)))
      (i32.store
        (i32.add (local.get $crossings) (i32.mul (local.get $probe) (i32.const 8)))
        (local.get $x))
      (i32.store offset=4
        (i32.add (local.get $crossings) (i32.mul (local.get $probe) (i32.const 8)))
        (local.get $dir))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $outer))))

  ;; Add a span's exact horizontal overlap, in 64ths of a pixel, to each pixel
  ;; it touches. A span narrower than one pixel lands entirely in that pixel's
  ;; accumulator rather than being rounded away, which is what keeps thin
  ;; stems from disappearing.
  (func $tt_add_span (param $coverage i32) (param $width i32) (param $left i32)
        (param $x_start i32) (param $x_end i32)
    (local $first i32) (local $last i32) (local $pixel i32)
    (local $lo i32) (local $hi i32)
    (local.set $x_start (i32.sub (local.get $x_start) (local.get $left)))
    (local.set $x_end (i32.sub (local.get $x_end) (local.get $left)))
    (if (i32.le_s (local.get $x_end) (i32.const 0)) (then (return)))
    (if (i32.ge_s (local.get $x_start)
          (i32.mul (local.get $width) (i32.const 64)))
      (then (return)))
    (if (i32.lt_s (local.get $x_start) (i32.const 0))
      (then (local.set $x_start (i32.const 0))))
    (if (i32.gt_s (local.get $x_end) (i32.mul (local.get $width) (i32.const 64)))
      (then (local.set $x_end (i32.mul (local.get $width) (i32.const 64)))))
    (if (i32.ge_s (local.get $x_start) (local.get $x_end)) (then (return)))
    (local.set $first (i32.shr_s (local.get $x_start) (i32.const 6)))
    (local.set $last
      (i32.shr_s (i32.sub (local.get $x_end) (i32.const 1)) (i32.const 6)))
    (local.set $pixel (local.get $first))
    (block $done (loop $scan
      (br_if $done (i32.gt_s (local.get $pixel) (local.get $last)))
      (local.set $lo (i32.mul (local.get $pixel) (i32.const 64)))
      (local.set $hi (i32.add (local.get $lo) (i32.const 64)))
      (if (i32.lt_s (local.get $lo) (local.get $x_start))
        (then (local.set $lo (local.get $x_start))))
      (if (i32.gt_s (local.get $hi) (local.get $x_end))
        (then (local.set $hi (local.get $x_end))))
      (i32.store (i32.add (local.get $coverage)
          (i32.mul (local.get $pixel) (i32.const 4)))
        (i32.add
          (i32.load (i32.add (local.get $coverage)
            (i32.mul (local.get $pixel) (i32.const 4))))
          (i32.sub (local.get $hi) (local.get $lo))))
      (local.set $pixel (i32.add (local.get $pixel) (i32.const 1)))
      (br $scan))))

  (func $tt_rasterize_glyph (param $data i32) (param $size i32) (param $gid i32)
        (param $ppem i32) (param $bitmap i32) (param $width i32) (param $height i32)
        (param $left i32) (param $top i32) (param $scratch i32)
        (param $scratch_size i32) (result i32)
    (local $points i32) (local $edges i32) (local $crossings i32)
    (local $coverage i32) (local $edge_count i32) (local $row i32)
    (local $sub i32) (local $index i32) (local $count i32) (local $sample i32)
    (local $x0 i32) (local $y0 i32) (local $x1 i32) (local $y1 i32)
    (local $lo i32) (local $hi i32) (local $winding i32) (local $span_start i32)
    (local $slot i32) (local $value i32) (local $column i32)
    (if (i32.or (i32.le_s (local.get $width) (i32.const 0))
          (i32.le_s (local.get $height) (i32.const 0)))
      (then (return (i32.const 0))))
    (if (i32.lt_u (local.get $scratch_size)
          (call $tt_raster_scratch_bytes (local.get $width)))
      (then (return (i32.const 0))))
    (local.set $points (local.get $scratch))
    (local.set $edges (i32.add (local.get $points)
      (i32.mul (global.get $TT_RASTER_POINTS) (i32.const 6))))
    (local.set $crossings (i32.add (local.get $edges)
      (i32.mul (global.get $TT_RASTER_EDGES) (i32.const 16))))
    (local.set $coverage (i32.add (local.get $crossings)
      (i32.mul (global.get $TT_RASTER_CROSSINGS) (i32.const 8))))

    (local.set $edge_count (call $tt_glyph_edges (local.get $data) (local.get $size)
      (local.get $gid) (local.get $ppem) (local.get $points)
      (global.get $TT_RASTER_POINTS) (local.get $edges)
      (global.get $TT_RASTER_EDGES)))
    ;; An empty glyph is a legal, blank bitmap, not a failure: the caller
    ;; still needs the cell cleared before it composites.
    (memory.fill (local.get $bitmap) (i32.const 0)
      (i32.mul (i32.shr_u (i32.add (local.get $width) (i32.const 7)) (i32.const 3))
        (local.get $height)))
    (if (i32.eqz (local.get $edge_count)) (then (return (i32.const 1))))

    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_s (local.get $row) (local.get $height)))
      (memory.fill (local.get $coverage) (i32.const 0)
        (i32.mul (local.get $width) (i32.const 4)))

      (local.set $sub (i32.const 0))
      (block $subs_done (loop $subs
        (br_if $subs_done (i32.ge_s (local.get $sub) (global.get $TT_SUBROWS)))
        ;; Sample at the centre of each sub-row. Sampling at its edge would
        ;; put the sample exactly on a horizontal join between contours, the
        ;; one place the crossing count is ambiguous.
        (local.set $sample (i32.sub
          (i32.sub (local.get $top) (i32.mul (local.get $row) (i32.const 64)))
          (i32.div_s
            (i32.mul (i32.add (i32.mul (local.get $sub) (i32.const 2))
                (i32.const 1)) (i32.const 32))
            (global.get $TT_SUBROWS))))

        (local.set $count (i32.const 0))
        (local.set $index (i32.const 0))
        (block $edges_done (loop $walk
          (br_if $edges_done (i32.ge_s (local.get $index) (local.get $edge_count)))
          (local.set $x0
            (call $tt_edge_field (local.get $edges) (local.get $index) (i32.const 0)))
          (local.set $y0
            (call $tt_edge_field (local.get $edges) (local.get $index) (i32.const 1)))
          (local.set $x1
            (call $tt_edge_field (local.get $edges) (local.get $index) (i32.const 2)))
          (local.set $y1
            (call $tt_edge_field (local.get $edges) (local.get $index) (i32.const 3)))
          (local.set $lo (select (local.get $y1) (local.get $y0)
            (i32.lt_s (local.get $y1) (local.get $y0))))
          (local.set $hi (select (local.get $y0) (local.get $y1)
            (i32.lt_s (local.get $y1) (local.get $y0))))
          ;; Half-open in y: an edge is counted at its lower end and not at
          ;; its upper one, so a vertex shared by two edges is crossed once
          ;; rather than twice or not at all.
          (if (i32.and (i32.le_s (local.get $lo) (local.get $sample))
                (i32.lt_s (local.get $sample) (local.get $hi)))
            (then
              (if (i32.lt_s (local.get $count) (global.get $TT_RASTER_CROSSINGS))
                (then
                  (local.set $slot (i32.add (local.get $crossings)
                    (i32.mul (local.get $count) (i32.const 8))))
                  (i32.store (local.get $slot)
                    (i32.add (local.get $x0) (call $gdi_round_ratio
                      (i64.mul
                        (i64.extend_i32_s (i32.sub (local.get $x1) (local.get $x0)))
                        (i64.extend_i32_s
                          (i32.sub (local.get $sample) (local.get $y0))))
                      (i64.extend_i32_s (i32.sub (local.get $y1) (local.get $y0))))))
                  (i32.store offset=4 (local.get $slot)
                    (select (i32.const 1) (i32.const -1)
                      (i32.gt_s (local.get $y1) (local.get $y0))))
                  (local.set $count (i32.add (local.get $count) (i32.const 1)))))))
          (local.set $index (i32.add (local.get $index) (i32.const 1)))
          (br $walk)))

        (call $tt_sort_crossings (local.get $crossings) (local.get $count))

        ;; Nonzero winding: a span is inside while the running direction sum
        ;; is not zero. The even-odd rule would fill the counter of every
        ;; 'o' whose contours happen to wind the same way.
        (local.set $winding (i32.const 0))
        (local.set $index (i32.const 0))
        (block $fill_done (loop $fill
          (br_if $fill_done (i32.ge_s (local.get $index) (local.get $count)))
          (local.set $slot (i32.add (local.get $crossings)
            (i32.mul (local.get $index) (i32.const 8))))
          (if (i32.eqz (local.get $winding))
            (then (local.set $span_start (i32.load (local.get $slot)))))
          (local.set $winding
            (i32.add (local.get $winding) (i32.load offset=4 (local.get $slot))))
          (if (i32.eqz (local.get $winding))
            (then (call $tt_add_span (local.get $coverage) (local.get $width)
              (local.get $left) (local.get $span_start)
              (i32.load (local.get $slot)))))
          (local.set $index (i32.add (local.get $index) (i32.const 1)))
          (br $fill)))

        (local.set $sub (i32.add (local.get $sub) (i32.const 1)))
        (br $subs)))

      ;; A pixel is ink when it is at least half covered, summed over the
      ;; sub-rows: full coverage is 64 * TT_SUBROWS.
      (local.set $column (i32.const 0))
      (block $emit_done (loop $emit
        (br_if $emit_done (i32.ge_s (local.get $column) (local.get $width)))
        (local.set $value (i32.load (i32.add (local.get $coverage)
          (i32.mul (local.get $column) (i32.const 4)))))
        (if (i32.ge_s (i32.mul (local.get $value) (i32.const 2))
              (i32.mul (i32.const 64) (global.get $TT_SUBROWS)))
          (then
            (local.set $slot (i32.add (local.get $bitmap)
              (i32.add
                (i32.mul (i32.shr_u (local.get $column) (i32.const 3))
                  (local.get $height))
                (local.get $row))))
            (i32.store8 (local.get $slot) (i32.or (i32.load8_u (local.get $slot))
              (i32.shr_u (i32.const 0x80)
                (i32.and (local.get $column) (i32.const 7)))))))
        (local.set $column (i32.add (local.get $column) (i32.const 1)))
        (br $emit)))

      (local.set $row (i32.add (local.get $row) (i32.const 1)))
      (br $rows)))
    (i32.const 1))

  ;; Read back a rasterized pixel with the same addressing the FNT accessor
  ;; uses, so a caller cannot pair the wrong reader with this producer.
  (func $tt_bitmap_pixel (param $bitmap i32) (param $height i32) (param $x i32)
        (param $y i32) (result i32)
    (i32.ne (i32.and
        (i32.load8_u (i32.add (local.get $bitmap)
          (i32.add (i32.mul (i32.shr_u (local.get $x) (i32.const 3))
              (local.get $height))
            (local.get $y))))
        (i32.shr_u (i32.const 0x80) (i32.and (local.get $x) (i32.const 7))))
      (i32.const 0)))

  ;; ---- ABC widths -------------------------------------------------------
  ;;
  ;; GetCharABCWidths splits the advance into left bearing, black width, and
  ;; right bearing. A and C are signed and routinely negative - 'j' overhangs
  ;; to its left, italic faces overhang to their right - and code that clamps
  ;; them to zero is exactly what clips the overhanging edge of a glyph.
  ;; An empty glyph has no black box, so its whole advance is bearing A.

  (func $tt_abc_a_fu (param $data i32) (param $size i32) (param $gid i32)
        (result i32)
    (call $tt_lsb_fu (local.get $data) (local.get $size) (local.get $gid)))

  (func $tt_abc_b_fu (param $data i32) (param $size i32) (param $gid i32)
        (result i32)
    (i32.sub
      (call $tt_glyph_x_max (local.get $data) (local.get $size) (local.get $gid))
      (call $tt_glyph_x_min (local.get $data) (local.get $size) (local.get $gid))))

  (func $tt_abc_c_fu (param $data i32) (param $size i32) (param $gid i32)
        (result i32)
    (i32.sub
      (i32.sub
        (call $tt_advance_fu (local.get $data) (local.get $size) (local.get $gid))
        (call $tt_abc_a_fu (local.get $data) (local.get $size) (local.get $gid)))
      (call $tt_abc_b_fu (local.get $data) (local.get $size) (local.get $gid))))

  ;; ---- cmap -------------------------------------------------------------

  (func $tt_cmap_subtable (param $data i32) (param $size i32)
        (param $platform i32) (param $encoding i32) (result i32)
    (local $cmap i32) (local $count i32) (local $index i32) (local $record i32)
    (local $offset i32)
    (local.set $cmap (call $tt_table_off (local.get $data) (local.get $size)
      (i32.const 0x636D6170)))
    (if (i32.eqz (local.get $cmap)) (then (return (i32.const 0))))
    (local.set $count (call $tt_u16 (local.get $data) (local.get $size)
      (i32.add (local.get $cmap) (i32.const 2))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $index) (local.get $count)))
      (local.set $record (i32.add (local.get $cmap)
        (i32.add (i32.const 4) (i32.mul (local.get $index) (i32.const 8)))))
      (if (i32.and
            (i32.eq (call $tt_u16 (local.get $data) (local.get $size)
                (local.get $record)) (local.get $platform))
            (i32.eq (call $tt_u16 (local.get $data) (local.get $size)
                (i32.add (local.get $record) (i32.const 2))) (local.get $encoding)))
        (then
          (local.set $offset (call $tt_u32 (local.get $data) (local.get $size)
            (i32.add (local.get $record) (i32.const 4))))
          (if (i32.ge_u (local.get $offset)
                (i32.sub (local.get $size) (local.get $cmap)))
            (then (return (i32.const 0))))
          (return (i32.add (local.get $cmap) (local.get $offset)))))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; A face is a symbol face when it offers the Microsoft Symbol encoding and
  ;; no Unicode BMP encoding. Wingdings, Webdings, Symbol, and Marlett are all
  ;; addressed this way, through the 0xF000 private-use block.
  (func $tt_cmap_is_symbol (param $data i32) (param $size i32) (result i32)
    (i32.and
      (i32.ne (call $tt_cmap_subtable (local.get $data) (local.get $size)
          (i32.const 3) (i32.const 0)) (i32.const 0))
      (i32.eqz (call $tt_cmap_subtable (local.get $data) (local.get $size)
          (i32.const 3) (i32.const 1)))))

  (func $tt_cmap_best (param $data i32) (param $size i32) (result i32)
    (local $offset i32)
    (local.set $offset (call $tt_cmap_subtable (local.get $data) (local.get $size)
      (i32.const 3) (i32.const 1)))
    (if (local.get $offset) (then (return (local.get $offset))))
    (local.set $offset (call $tt_cmap_subtable (local.get $data) (local.get $size)
      (i32.const 3) (i32.const 0)))
    (if (local.get $offset) (then (return (local.get $offset))))
    (local.set $offset (call $tt_cmap_subtable (local.get $data) (local.get $size)
      (i32.const 0) (i32.const 3)))
    (if (local.get $offset) (then (return (local.get $offset))))
    (local.set $offset (call $tt_cmap_subtable (local.get $data) (local.get $size)
      (i32.const 0) (i32.const 0)))
    (if (local.get $offset) (then (return (local.get $offset))))
    (call $tt_cmap_subtable (local.get $data) (local.get $size)
      (i32.const 1) (i32.const 0)))

  ;; Format 4: segmented mapping. idRangeOffset is relative to its own slot,
  ;; so the glyph address is computed from the slot address rather than from
  ;; the subtable base.
  (func $tt_cmap_lookup_f4 (param $data i32) (param $size i32) (param $sub i32)
        (param $code i32) (result i32)
    (local $seg_x2 i32) (local $index i32) (local $end i32) (local $start i32)
    (local $delta i32) (local $range_slot i32) (local $range i32) (local $gid i32)
    (local.set $seg_x2 (call $tt_u16 (local.get $data) (local.get $size)
      (i32.add (local.get $sub) (i32.const 6))))
    (if (i32.or (i32.eqz (local.get $seg_x2))
          (i32.and (local.get $seg_x2) (i32.const 1)))
      (then (return (i32.const 0))))
    (block $found (loop $scan
      (br_if $found (i32.ge_u (local.get $index) (local.get $seg_x2)))
      (local.set $end (call $tt_u16 (local.get $data) (local.get $size)
        (i32.add (local.get $sub) (i32.add (i32.const 14) (local.get $index)))))
      (br_if $found (i32.ge_u (local.get $end) (local.get $code)))
      (local.set $index (i32.add (local.get $index) (i32.const 2)))
      (br $scan)))
    (if (i32.ge_u (local.get $index) (local.get $seg_x2))
      (then (return (i32.const 0))))
    (local.set $start (call $tt_u16 (local.get $data) (local.get $size)
      (i32.add (local.get $sub) (i32.add (i32.const 16)
        (i32.add (local.get $seg_x2) (local.get $index))))))
    (if (i32.gt_u (local.get $start) (local.get $code))
      (then (return (i32.const 0))))
    (local.set $delta (call $tt_u16 (local.get $data) (local.get $size)
      (i32.add (local.get $sub) (i32.add (i32.const 16)
        (i32.add (i32.mul (local.get $seg_x2) (i32.const 2)) (local.get $index))))))
    (local.set $range_slot (i32.add (local.get $sub) (i32.add (i32.const 16)
      (i32.add (i32.mul (local.get $seg_x2) (i32.const 3)) (local.get $index)))))
    (local.set $range
      (call $tt_u16 (local.get $data) (local.get $size) (local.get $range_slot)))
    (if (i32.eqz (local.get $range))
      (then (return (i32.and (i32.add (local.get $code) (local.get $delta))
        (i32.const 0xFFFF)))))
    (local.set $gid (call $tt_u16 (local.get $data) (local.get $size)
      (i32.add (local.get $range_slot)
        (i32.add (local.get $range)
          (i32.mul (i32.sub (local.get $code) (local.get $start))
            (i32.const 2))))))
    (if (i32.eqz (local.get $gid)) (then (return (i32.const 0))))
    (i32.and (i32.add (local.get $gid) (local.get $delta)) (i32.const 0xFFFF)))

  ;; Format 0: byte-indexed 256-entry table, used by Mac Roman subtables.
  (func $tt_cmap_lookup_f0 (param $data i32) (param $size i32) (param $sub i32)
        (param $code i32) (result i32)
    (if (i32.gt_u (local.get $code) (i32.const 0xFF))
      (then (return (i32.const 0))))
    (call $tt_u8 (local.get $data) (local.get $size)
      (i32.add (local.get $sub) (i32.add (i32.const 6) (local.get $code)))))

  ;; Format 6: a single trimmed contiguous range.
  (func $tt_cmap_lookup_f6 (param $data i32) (param $size i32) (param $sub i32)
        (param $code i32) (result i32)
    (local $first i32) (local $count i32)
    (local.set $first (call $tt_u16 (local.get $data) (local.get $size)
      (i32.add (local.get $sub) (i32.const 6))))
    (local.set $count (call $tt_u16 (local.get $data) (local.get $size)
      (i32.add (local.get $sub) (i32.const 8))))
    (if (i32.lt_u (local.get $code) (local.get $first))
      (then (return (i32.const 0))))
    (if (i32.ge_u (i32.sub (local.get $code) (local.get $first)) (local.get $count))
      (then (return (i32.const 0))))
    (call $tt_u16 (local.get $data) (local.get $size)
      (i32.add (local.get $sub) (i32.add (i32.const 10)
        (i32.mul (i32.sub (local.get $code) (local.get $first)) (i32.const 2))))))

  (func $tt_cmap_lookup_at (param $data i32) (param $size i32) (param $sub i32)
        (param $code i32) (result i32)
    (local $format i32)
    (if (i32.eqz (local.get $sub)) (then (return (i32.const 0))))
    (local.set $format
      (call $tt_u16 (local.get $data) (local.get $size) (local.get $sub)))
    (if (i32.eq (local.get $format) (i32.const 4))
      (then (return (call $tt_cmap_lookup_f4 (local.get $data) (local.get $size)
        (local.get $sub) (local.get $code)))))
    (if (i32.eq (local.get $format) (i32.const 0))
      (then (return (call $tt_cmap_lookup_f0 (local.get $data) (local.get $size)
        (local.get $sub) (local.get $code)))))
    (if (i32.eq (local.get $format) (i32.const 6))
      (then (return (call $tt_cmap_lookup_f6 (local.get $data) (local.get $size)
        (local.get $sub) (local.get $code)))))
    (i32.const 0))

  ;; Symbol faces map byte values into the 0xF000 private-use block. Try that
  ;; first for single-byte input, then the raw value, so a face that stores
  ;; either layout still resolves.
  (func $tt_glyph_index (param $data i32) (param $size i32) (param $code i32)
        (result i32)
    (local $sub i32) (local $gid i32)
    (local.set $sub (call $tt_cmap_best (local.get $data) (local.get $size)))
    (if (i32.eqz (local.get $sub)) (then (return (i32.const 0))))
    (if (i32.and
          (call $tt_cmap_is_symbol (local.get $data) (local.get $size))
          (i32.le_u (local.get $code) (i32.const 0xFF)))
      (then
        (local.set $gid (call $tt_cmap_lookup_at (local.get $data) (local.get $size)
          (local.get $sub) (i32.or (local.get $code) (i32.const 0xF000))))
        (if (local.get $gid) (then (return (local.get $gid))))))
    (call $tt_cmap_lookup_at (local.get $data) (local.get $size)
      (local.get $sub) (local.get $code)))

  ;; ---- CP1252 -----------------------------------------------------------
  ;;
  ;; Guest text arrives as bytes, but `cmap` is keyed by Unicode, so an ANSI
  ;; face needs a codepage hop in between. CP1252 is Latin-1 except for
  ;; 0x80-0x9F, where Windows puts typographic punctuation instead of C1
  ;; controls; the five codes Microsoft's table leaves undefined (0x81, 0x8D,
  ;; 0x8F, 0x90, 0x9D) map to their C1 control identity, which is what
  ;; MultiByteToWideChar does rather than failing the conversion.
  ;;
  ;; This is written as comparisons rather than a data segment on purpose:
  ;; this layer owns no memory yet, and a 32-entry table that only high bytes
  ;; ever reach is not worth an arena allocation to consult.
  ;;
  ;; OEM CP437 is deliberately absent. The faces that use it (Terminal) are
  ;; bitmap strikes served by the .FON path, and no scalable face in the
  ;; corpus is requested with OEM_CHARSET yet.

  (func $tt_cp1252_to_unicode (param $byte i32) (result i32)
    (if (i32.or (i32.lt_u (local.get $byte) (i32.const 0x80))
          (i32.gt_u (local.get $byte) (i32.const 0x9F)))
      (then (return (i32.and (local.get $byte) (i32.const 0xFF)))))
    (if (i32.eq (local.get $byte) (i32.const 0x80)) (then (return (i32.const 0x20AC))))
    (if (i32.eq (local.get $byte) (i32.const 0x82)) (then (return (i32.const 0x201A))))
    (if (i32.eq (local.get $byte) (i32.const 0x83)) (then (return (i32.const 0x0192))))
    (if (i32.eq (local.get $byte) (i32.const 0x84)) (then (return (i32.const 0x201E))))
    (if (i32.eq (local.get $byte) (i32.const 0x85)) (then (return (i32.const 0x2026))))
    (if (i32.eq (local.get $byte) (i32.const 0x86)) (then (return (i32.const 0x2020))))
    (if (i32.eq (local.get $byte) (i32.const 0x87)) (then (return (i32.const 0x2021))))
    (if (i32.eq (local.get $byte) (i32.const 0x88)) (then (return (i32.const 0x02C6))))
    (if (i32.eq (local.get $byte) (i32.const 0x89)) (then (return (i32.const 0x2030))))
    (if (i32.eq (local.get $byte) (i32.const 0x8A)) (then (return (i32.const 0x0160))))
    (if (i32.eq (local.get $byte) (i32.const 0x8B)) (then (return (i32.const 0x2039))))
    (if (i32.eq (local.get $byte) (i32.const 0x8C)) (then (return (i32.const 0x0152))))
    (if (i32.eq (local.get $byte) (i32.const 0x8E)) (then (return (i32.const 0x017D))))
    (if (i32.eq (local.get $byte) (i32.const 0x91)) (then (return (i32.const 0x2018))))
    (if (i32.eq (local.get $byte) (i32.const 0x92)) (then (return (i32.const 0x2019))))
    (if (i32.eq (local.get $byte) (i32.const 0x93)) (then (return (i32.const 0x201C))))
    (if (i32.eq (local.get $byte) (i32.const 0x94)) (then (return (i32.const 0x201D))))
    (if (i32.eq (local.get $byte) (i32.const 0x95)) (then (return (i32.const 0x2022))))
    (if (i32.eq (local.get $byte) (i32.const 0x96)) (then (return (i32.const 0x2013))))
    (if (i32.eq (local.get $byte) (i32.const 0x97)) (then (return (i32.const 0x2014))))
    (if (i32.eq (local.get $byte) (i32.const 0x98)) (then (return (i32.const 0x02DC))))
    (if (i32.eq (local.get $byte) (i32.const 0x99)) (then (return (i32.const 0x2122))))
    (if (i32.eq (local.get $byte) (i32.const 0x9A)) (then (return (i32.const 0x0161))))
    (if (i32.eq (local.get $byte) (i32.const 0x9B)) (then (return (i32.const 0x203A))))
    (if (i32.eq (local.get $byte) (i32.const 0x9C)) (then (return (i32.const 0x0153))))
    (if (i32.eq (local.get $byte) (i32.const 0x9E)) (then (return (i32.const 0x017E))))
    (if (i32.eq (local.get $byte) (i32.const 0x9F)) (then (return (i32.const 0x0178))))
    ;; 0x81, 0x8D, 0x8F, 0x90, 0x9D: undefined in CP1252, identity in Windows.
    (local.get $byte))

  ;; Glyph for a guest ANSI byte. Symbol faces are addressed by byte through
  ;; the 0xF000 block and must not take the codepage hop: running 0x93 through
  ;; CP1252 would ask Wingdings for a left double quote and get .notdef.
  (func $tt_ansi_glyph_index (param $data i32) (param $size i32) (param $byte i32)
        (result i32)
    (if (call $tt_cmap_is_symbol (local.get $data) (local.get $size))
      (then (return (call $tt_glyph_index (local.get $data) (local.get $size)
        (i32.and (local.get $byte) (i32.const 0xFF))))))
    (call $tt_glyph_index (local.get $data) (local.get $size)
      (call $tt_cp1252_to_unicode (local.get $byte))))

  ;; ---- scaling ----------------------------------------------------------
  ;;
  ;; Font units scale to pixels through the same signed round-half-up helper
  ;; the bitmap path uses, so a face that crosses between a generated strike
  ;; and an outline keeps identical advances and text does not re-flow.

  (func $tt_scale (param $value i32) (param $ppem i32) (param $upem i32)
        (result i32)
    (if (i32.le_s (local.get $upem) (i32.const 0))
      (then (return (i32.const 0))))
    (call $gdi_round_ratio
      (i64.mul (i64.extend_i32_s (local.get $value))
        (i64.extend_i32_s (local.get $ppem)))
      (i64.extend_i32_s (local.get $upem))))

  (func $tt_advance_px (param $data i32) (param $size i32) (param $gid i32)
        (param $ppem i32) (result i32)
    (call $tt_scale
      (call $tt_advance_fu (local.get $data) (local.get $size) (local.get $gid))
      (local.get $ppem)
      (call $tt_units_per_em (local.get $data) (local.get $size))))

  ;; Advance for a character code, resolving through cmap. Unmapped codes fall
  ;; to glyph 0, whose advance is the .notdef box width, matching GDI.
  (func $tt_char_advance_px (param $data i32) (param $size i32) (param $code i32)
        (param $ppem i32) (result i32)
    (call $tt_advance_px (local.get $data) (local.get $size)
      (call $tt_glyph_index (local.get $data) (local.get $size) (local.get $code))
      (local.get $ppem)))

  ;; Advance for a guest ANSI byte, the form GetCharWidth32A asks for.
  (func $tt_ansi_advance_px (param $data i32) (param $size i32) (param $byte i32)
        (param $ppem i32) (result i32)
    (call $tt_advance_px (local.get $data) (local.get $size)
      (call $tt_ansi_glyph_index (local.get $data) (local.get $size)
        (local.get $byte))
      (local.get $ppem)))

  ;; Sum advances for a byte string. Widths are accumulated in font units and
  ;; scaled once at the end: scaling per character would round every advance
  ;; independently and drift several pixels across a long run.
  (func $tt_text_width_px (param $data i32) (param $size i32) (param $text i32)
        (param $count i32) (param $ppem i32) (result i32)
    (local $index i32) (local $total i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $index) (local.get $count)))
      (local.set $total (i32.add (local.get $total)
        (call $tt_advance_fu (local.get $data) (local.get $size)
          (call $tt_ansi_glyph_index (local.get $data) (local.get $size)
            (i32.load8_u (i32.add (local.get $text) (local.get $index)))))))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $scan)))
    (call $tt_scale (local.get $total) (local.get $ppem)
      (call $tt_units_per_em (local.get $data) (local.get $size))))

  ;; ---- TEXTMETRIC -------------------------------------------------------
  ;;
  ;; GDI reports metrics in pixels, derived from the font tables at the ppem
  ;; the guest asked for. The derivations below follow what GDI does rather
  ;; than what the OpenType specification recommends for new typography:
  ;; tmAscent/tmDescent come from OS/2 usWinAscent/usWinDescent, not from the
  ;; sTypo pair or hhea. Choosing sTypo here would look more "correct" and
  ;; would shift every baseline in every dialog.

  (func $tt_hhea_u16 (param $data i32) (param $size i32) (param $field i32)
        (result i32)
    (local $hhea i32)
    (local.set $hhea (call $tt_table_off (local.get $data) (local.get $size)
      (i32.const 0x68686561)))
    (if (i32.eqz (local.get $hhea)) (then (return (i32.const 0))))
    (call $tt_u16 (local.get $data) (local.get $size)
      (i32.add (local.get $hhea) (local.get $field))))

  ;; `post` isFixedPitch is the authority on pitch, not a width comparison:
  ;; a monospaced face with one wide glyph is still monospaced to GDI.
  (func $tt_is_fixed_pitch (param $data i32) (param $size i32) (result i32)
    (local $post i32)
    (local.set $post (call $tt_table_off (local.get $data) (local.get $size)
      (i32.const 0x706F7374)))
    (if (i32.eqz (local.get $post)) (then (return (i32.const 0))))
    (i32.ne (call $tt_u32 (local.get $data) (local.get $size)
        (i32.add (local.get $post) (i32.const 12)))
      (i32.const 0)))

  ;; LOGFONT.lfHeight is signed with two meanings. Negative is the em size in
  ;; pixels, which is ppem directly. Positive is the *cell* height, so ppem is
  ;; recovered by inverting the ascent+descent scaling; treating a positive
  ;; lfHeight as ppem is the classic way to render text ~20% too large.
  (func $tt_ppem_from_lfheight (param $data i32) (param $size i32)
        (param $lf_height i32) (result i32)
    (local $cell i32) (local $ppem i32)
    (if (i32.lt_s (local.get $lf_height) (i32.const 0))
      (then (return (i32.sub (i32.const 0) (local.get $lf_height)))))
    ;; lfHeight 0 means "any height"; GDI picks a device default, and 12 is
    ;; the Win98 shell's default logical height.
    (if (i32.eqz (local.get $lf_height)) (then (return (i32.const 12))))
    (local.set $cell
      (i32.add (call $tt_win_ascent (local.get $data) (local.get $size))
        (call $tt_win_descent (local.get $data) (local.get $size))))
    (if (i32.le_s (local.get $cell) (i32.const 0))
      (then (return (local.get $lf_height))))
    (local.set $ppem (call $gdi_round_ratio
      (i64.mul (i64.extend_i32_s (local.get $lf_height))
        (i64.extend_i32_s (call $tt_units_per_em (local.get $data) (local.get $size))))
      (i64.extend_i32_s (local.get $cell))))
    (if (i32.lt_s (local.get $ppem) (i32.const 1))
      (then (return (i32.const 1))))
    (local.get $ppem))

  (func $tt_tm_ascent (param $data i32) (param $size i32) (param $ppem i32)
        (result i32)
    (call $tt_scale (call $tt_win_ascent (local.get $data) (local.get $size))
      (local.get $ppem)
      (call $tt_units_per_em (local.get $data) (local.get $size))))

  (func $tt_tm_descent (param $data i32) (param $size i32) (param $ppem i32)
        (result i32)
    (call $tt_scale (call $tt_win_descent (local.get $data) (local.get $size))
      (local.get $ppem)
      (call $tt_units_per_em (local.get $data) (local.get $size))))

  (func $tt_tm_height (param $data i32) (param $size i32) (param $ppem i32)
        (result i32)
    (i32.add (call $tt_tm_ascent (local.get $data) (local.get $size) (local.get $ppem))
      (call $tt_tm_descent (local.get $data) (local.get $size) (local.get $ppem))))

  ;; Internal leading is the part of the cell above the em box, so it is the
  ;; cell height less the em size. It is what a guest subtracts to convert a
  ;; point size into the negative lfHeight it passes back to CreateFont.
  (func $tt_tm_internal_leading (param $data i32) (param $size i32)
        (param $ppem i32) (result i32)
    (local $leading i32)
    (local.set $leading
      (i32.sub (call $tt_tm_height (local.get $data) (local.get $size)
          (local.get $ppem))
        (local.get $ppem)))
    (if (i32.lt_s (local.get $leading) (i32.const 0))
      (then (return (i32.const 0))))
    (local.get $leading))

  ;; External leading is the line gap that hhea asks for beyond what the
  ;; usWin cell already provides, clamped at zero: many faces have a usWin
  ;; cell taller than the hhea one, and a negative gap would overlap lines.
  (func $tt_tm_external_leading (param $data i32) (param $size i32)
        (param $ppem i32) (result i32)
    (local $gap i32)
    (local.set $gap
      (i32.sub (call $tt_line_gap (local.get $data) (local.get $size))
        (i32.sub
          (i32.add (call $tt_win_ascent (local.get $data) (local.get $size))
            (call $tt_win_descent (local.get $data) (local.get $size)))
          (i32.sub (call $tt_ascender (local.get $data) (local.get $size))
            (call $tt_descender (local.get $data) (local.get $size))))))
    (if (i32.le_s (local.get $gap) (i32.const 0))
      (then (return (i32.const 0))))
    (call $tt_scale (local.get $gap) (local.get $ppem)
      (call $tt_units_per_em (local.get $data) (local.get $size))))

  ;; OS/2 xAvgCharWidth is the designer's own figure and is what GDI reports.
  ;; Faces that leave it zero fall back to the advance of 'x', the historical
  ;; definition the field replaced.
  (func $tt_tm_ave_char_width (param $data i32) (param $size i32) (param $ppem i32)
        (result i32)
    (local $units i32)
    (local.set $units
      (call $tt_os2_s16 (local.get $data) (local.get $size) (i32.const 2)))
    (if (i32.le_s (local.get $units) (i32.const 0))
      (then (local.set $units (call $tt_advance_fu (local.get $data) (local.get $size)
        (call $tt_glyph_index (local.get $data) (local.get $size)
          (i32.const 0x78))))))
    (call $tt_scale (local.get $units) (local.get $ppem)
      (call $tt_units_per_em (local.get $data) (local.get $size))))

  (func $tt_tm_max_char_width (param $data i32) (param $size i32) (param $ppem i32)
        (result i32)
    (call $tt_scale (call $tt_hhea_u16 (local.get $data) (local.get $size)
        (i32.const 10))
      (local.get $ppem)
      (call $tt_units_per_em (local.get $data) (local.get $size))))

  (func $tt_tm_weight (param $data i32) (param $size i32) (result i32)
    (local $weight i32)
    (local.set $weight (call $tt_weight_class (local.get $data) (local.get $size)))
    (if (i32.eqz (local.get $weight)) (then (return (i32.const 400))))
    (local.get $weight))

  ;; tmPitchAndFamily packs pitch in the low bits and family in the high
  ;; nibble. Bit 0 is set for *variable* pitch, which reads backwards from its
  ;; TMPF_FIXED_PITCH name and is a standing source of inverted conditions.
  ;; TMPF_VECTOR|TMPF_TRUETYPE are both set: every face reaching this layer is
  ;; a scalable outline by construction.
  (func $tt_tm_pitch_and_family (param $data i32) (param $size i32) (result i32)
    (local $value i32) (local $serif i32)
    (local.set $value (i32.const 0x06))
    (if (call $tt_is_fixed_pitch (local.get $data) (local.get $size))
      (then (return (i32.or (local.get $value) (i32.const 0x30)))))
    (local.set $value (i32.or (local.get $value) (i32.const 0x01)))
    ;; PANOSE starts at OS/2 +32, so bSerifStyle is the low byte of that word.
    ;; Serif classes are 2..10; anything else is treated as sans.
    (local.set $serif (i32.and
      (call $tt_os2_u16 (local.get $data) (local.get $size) (i32.const 32))
      (i32.const 0xFF)))
    (if (i32.and (i32.ge_u (local.get $serif) (i32.const 2))
          (i32.le_u (local.get $serif) (i32.const 10)))
      (then (return (i32.or (local.get $value) (i32.const 0x10)))))
    (i32.or (local.get $value) (i32.const 0x20)))

  (func $tt_tm_first_char (param $data i32) (param $size i32) (result i32)
    (call $tt_os2_u16 (local.get $data) (local.get $size) (i32.const 64)))

  (func $tt_tm_last_char (param $data i32) (param $size i32) (result i32)
    (call $tt_os2_u16 (local.get $data) (local.get $size) (i32.const 66)))

  ;; ---- kern -------------------------------------------------------------
  ;;
  ;; GetKerningPairs reads the legacy `kern` table, not GPOS: Win98 GDI had no
  ;; OpenType layout engine, so a face whose kerning lives only in GPOS simply
  ;; kerns nothing on Win98, and reaching into GPOS here would render text the
  ;; guest never could have produced.
  ;;
  ;; Only format 0 horizontal, non-minimum subtables are honoured. Pairs are
  ;; sorted by (left, right) as a single 32-bit key, which is what makes the
  ;; binary search below legal rather than merely convenient.

  (func $tt_kern_subtable_lookup (param $data i32) (param $size i32)
        (param $sub i32) (param $key i32) (result i32)
    (local $pairs i32) (local $low i32) (local $high i32) (local $mid i32)
    (local $entry i32) (local $probe i32)
    (local.set $pairs
      (call $tt_u16 (local.get $data) (local.get $size)
        (i32.add (local.get $sub) (i32.const 6))))
    (local.set $high (local.get $pairs))
    (block $done (loop $search
      (br_if $done (i32.ge_u (local.get $low) (local.get $high)))
      (local.set $mid (i32.shr_u
        (i32.add (local.get $low) (local.get $high)) (i32.const 1)))
      (local.set $entry (i32.add (local.get $sub)
        (i32.add (i32.const 14) (i32.mul (local.get $mid) (i32.const 6)))))
      (local.set $probe (i32.or
        (i32.shl (call $tt_u16 (local.get $data) (local.get $size)
            (local.get $entry)) (i32.const 16))
        (call $tt_u16 (local.get $data) (local.get $size)
          (i32.add (local.get $entry) (i32.const 2)))))
      (if (i32.eq (local.get $probe) (local.get $key))
        (then (return (call $tt_s16 (local.get $data) (local.get $size)
          (i32.add (local.get $entry) (i32.const 4))))))
      (if (i32.lt_u (local.get $probe) (local.get $key))
        (then (local.set $low (i32.add (local.get $mid) (i32.const 1))))
        (else (local.set $high (local.get $mid))))
      (br $search)))
    (i32.const 0))

  (func $tt_kern_pair_fu (param $data i32) (param $size i32) (param $left i32)
        (param $right i32) (result i32)
    (local $kern i32) (local $count i32) (local $index i32) (local $sub i32)
    (local $length i32) (local $coverage i32) (local $value i32) (local $key i32)
    (local.set $kern (call $tt_table_off (local.get $data) (local.get $size)
      (i32.const 0x6B65726E)))
    (if (i32.eqz (local.get $kern)) (then (return (i32.const 0))))
    (local.set $count (call $tt_u16 (local.get $data) (local.get $size)
      (i32.add (local.get $kern) (i32.const 2))))
    (local.set $key (i32.or
      (i32.shl (i32.and (local.get $left) (i32.const 0xFFFF)) (i32.const 16))
      (i32.and (local.get $right) (i32.const 0xFFFF))))
    (local.set $sub (i32.add (local.get $kern) (i32.const 4)))
    (block $done (loop $tables
      (br_if $done (i32.ge_u (local.get $index) (local.get $count)))
      (local.set $length (call $tt_u16 (local.get $data) (local.get $size)
        (i32.add (local.get $sub) (i32.const 2))))
      ;; A zero-length subtable would loop forever on a corrupt file.
      (br_if $done (i32.lt_u (local.get $length) (i32.const 14)))
      (local.set $coverage (call $tt_u16 (local.get $data) (local.get $size)
        (i32.add (local.get $sub) (i32.const 4))))
      ;; coverage: high byte is the format, bit 0 is horizontal, bit 1 marks a
      ;; minimum table whose values are floors rather than adjustments.
      (if (i32.and
            (i32.eqz (i32.shr_u (local.get $coverage) (i32.const 8)))
            (i32.eq (i32.and (local.get $coverage) (i32.const 3)) (i32.const 1)))
        (then
          (local.set $value (call $tt_kern_subtable_lookup (local.get $data)
            (local.get $size) (local.get $sub) (local.get $key)))
          (if (local.get $value) (then (return (local.get $value))))))
      (local.set $sub (i32.add (local.get $sub) (local.get $length)))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $tables)))
    (i32.const 0))

  (func $tt_kern_pair_px (param $data i32) (param $size i32) (param $left i32)
        (param $right i32) (param $ppem i32) (result i32)
    (call $tt_scale
      (call $tt_kern_pair_fu (local.get $data) (local.get $size)
        (local.get $left) (local.get $right))
      (local.get $ppem)
      (call $tt_units_per_em (local.get $data) (local.get $size))))

  ;; ---- face registry ----------------------------------------------------
  ;;
  ;; Everything above is a pure function of a buffer. This is the part that
  ;; owns state: which font files are resident, and which glyphs have already
  ;; been rasterized.
  ;;
  ;; Storage comes from `$heap_alloc` rather than a fixed region in the memory
  ;; map. Font files vary from 60 KB to 400 KB and the glyph cache grows with
  ;; what the guest actually draws, so a fixed reservation would either waste
  ;; a megabyte on a guest that never asks for a scalable face or run out on
  ;; one that does. The roots below are the only fixed cost, and they are
  ;; three globals.
  ;;
  ;; Faces are keyed by path hash so opening the same file twice returns the
  ;; same slot instead of a second copy of a 400 KB file.

  ;; Every style of every substituted face is 18 files, and a guest may also
  ;; name a face by path. 16 slots looked generous until the substitution
  ;; table existed and the last two faces silently failed to open.
  (global $TT_MAX_FACES i32 (i32.const 32))
  (global $TT_FACE_STRIDE i32 (i32.const 32))
  (global $TT_CACHE_SLOTS i32 (i32.const 1024))
  (global $TT_CACHE_STRIDE i32 (i32.const 24))
  ;; Widest glyph the shared raster scratch can take. Beyond this the caller
  ;; gets no bitmap rather than a truncated one.
  (global $TT_SCRATCH_WIDTH i32 (i32.const 256))
  ;; A font larger than this is refused outright: the guest cannot have named
  ;; a Win98 face this big, so it is a sign of a wrong path, not a big font.
  (global $TT_MAX_FONT_BYTES i32 (i32.const 0x00400000))

  (global $tt_faces (mut i32) (i32.const 0))
  (global $tt_cache (mut i32) (i32.const 0))
  (global $tt_scratch (mut i32) (i32.const 0))
  (global $tt_cache_used (mut i32) (i32.const 0))

  ;; FNV-1a over a NUL-terminated path, case-folded so the same file opened as
  ;; FONTS\ and fonts\ is one face rather than two copies.
  (func $tt_path_hash (param $path i32) (result i32)
    (local $hash i32) (local $byte i32)
    (local.set $hash (i32.const 0x811C9DC5))
    (block $done (loop $scan
      (local.set $byte (i32.load8_u (local.get $path)))
      (br_if $done (i32.eqz (local.get $byte)))
      (if (i32.and (i32.ge_u (local.get $byte) (i32.const 65))
            (i32.le_u (local.get $byte) (i32.const 90)))
        (then (local.set $byte (i32.add (local.get $byte) (i32.const 32)))))
      (local.set $hash (i32.mul (i32.xor (local.get $hash) (local.get $byte))
        (i32.const 16777619)))
      (local.set $path (i32.add (local.get $path) (i32.const 1)))
      (br $scan)))
    (local.get $hash))

  ;; Returns the WASM address of the face table, allocating it on first use.
  (func $tt_faces_ensure (result i32)
    (local $guest i32) (local $bytes i32)
    (if (global.get $tt_faces)
      (then (return (call $g2w (global.get $tt_faces)))))
    (local.set $bytes
      (i32.mul (global.get $TT_MAX_FACES) (global.get $TT_FACE_STRIDE)))
    (local.set $guest (call $heap_alloc (local.get $bytes)))
    (if (i32.eqz (local.get $guest)) (then (return (i32.const 0))))
    (memory.fill (call $g2w (local.get $guest)) (i32.const 0) (local.get $bytes))
    (global.set $tt_faces (local.get $guest))
    (call $g2w (local.get $guest)))

  (func $tt_face_record (param $face i32) (result i32)
    (local $table i32)
    (if (i32.ge_u (local.get $face) (global.get $TT_MAX_FACES))
      (then (return (i32.const 0))))
    (local.set $table (call $tt_faces_ensure))
    (if (i32.eqz (local.get $table)) (then (return (i32.const 0))))
    (i32.add (local.get $table)
      (i32.mul (local.get $face) (global.get $TT_FACE_STRIDE))))

  (func $tt_face_data (param $face i32) (result i32)
    (local $record i32)
    (local.set $record (call $tt_face_record (local.get $face)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (if (i32.eqz (i32.load offset=16 (local.get $record)))
      (then (return (i32.const 0))))
    (call $g2w (i32.load offset=4 (local.get $record))))

  (func $tt_face_size (param $face i32) (result i32)
    (local $record i32)
    (local.set $record (call $tt_face_record (local.get $face)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (if (i32.eqz (i32.load offset=16 (local.get $record)))
      (then (return (i32.const 0))))
    (i32.load offset=8 (local.get $record)))

  ;; Open a font file by guest path. Returns a face index, or -1 on any
  ;; failure: a missing file, a file that is not glyf TrueType, a full table,
  ;; or no heap. Callers fall back to whatever they would have done before,
  ;; so a bad path degrades to the old behaviour instead of trapping.
  (func $tt_face_open (param $path_guest i32) (result i32)
    (local $path i32) (local $hash i32) (local $table i32) (local $record i32)
    (local $index i32) (local $free i32) (local $handle i32) (local $size i32)
    (local $data_guest i32) (local $data i32) (local $read i32)
    (if (i32.eqz (local.get $path_guest)) (then (return (i32.const -1))))
    (local.set $path (call $g2w (local.get $path_guest)))
    (local.set $hash (call $tt_path_hash (local.get $path)))
    (local.set $table (call $tt_faces_ensure))
    (if (i32.eqz (local.get $table)) (then (return (i32.const -1))))

    (local.set $free (i32.const -1))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $index) (global.get $TT_MAX_FACES)))
      (local.set $record (i32.add (local.get $table)
        (i32.mul (local.get $index) (global.get $TT_FACE_STRIDE))))
      (if (i32.load offset=16 (local.get $record))
        (then
          (if (i32.eq (i32.load (local.get $record)) (local.get $hash))
            (then (return (local.get $index)))))
        (else (if (i32.eq (local.get $free) (i32.const -1))
          (then (local.set $free (local.get $index))))))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $scan)))
    (if (i32.eq (local.get $free) (i32.const -1)) (then (return (i32.const -1))))

    ;; GENERIC_READ, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL: the same call the
    ;; bitmap-font loader makes, so both paths see one filesystem.
    (local.set $handle (call $host_fs_create_file (local.get $path)
      (i32.const 0x80000000) (i32.const 3) (i32.const 0x80) (i32.const 0)))
    (if (i32.eq (local.get $handle) (i32.const -1)) (then (return (i32.const -1))))
    (local.set $size (call $host_fs_get_file_size (local.get $handle)))
    (if (i32.or (i32.le_s (local.get $size) (i32.const 0))
          (i32.gt_u (local.get $size) (global.get $TT_MAX_FONT_BYTES)))
      (then
        (drop (call $host_fs_close_handle (local.get $handle)))
        (return (i32.const -1))))
    (local.set $data_guest (call $heap_alloc (local.get $size)))
    (if (i32.eqz (local.get $data_guest))
      (then
        (drop (call $host_fs_close_handle (local.get $handle)))
        (return (i32.const -1))))
    (local.set $data (call $g2w (local.get $data_guest)))
    ;; The filesystem bridge reports the byte count through guest memory, so
    ;; the count word is borrowed from the front of the buffer being filled
    ;; and overwritten by the read itself.
    (local.set $read (call $heap_alloc (i32.const 4)))
    (if (i32.eqz (local.get $read))
      (then
        (drop (call $host_fs_close_handle (local.get $handle)))
        (call $heap_free (local.get $data_guest))
        (return (i32.const -1))))
    (i32.store (call $g2w (local.get $read)) (i32.const 0))
    (if (i32.eqz (call $host_fs_read_file (local.get $handle)
          (local.get $data_guest) (local.get $size) (local.get $read)))
      (then
        (drop (call $host_fs_close_handle (local.get $handle)))
        (call $heap_free (local.get $data_guest))
        (call $heap_free (local.get $read))
        (return (i32.const -1))))
    (drop (call $host_fs_close_handle (local.get $handle)))
    (if (i32.ne (i32.load (call $g2w (local.get $read))) (local.get $size))
      (then
        (call $heap_free (local.get $data_guest))
        (call $heap_free (local.get $read))
        (return (i32.const -1))))
    (call $heap_free (local.get $read))

    ;; Refuse anything that is not a glyf TrueType here rather than letting
    ;; every accessor below rediscover it one zero at a time.
    (if (i32.eqz (call $tt_is_truetype (local.get $data) (local.get $size)))
      (then
        (call $heap_free (local.get $data_guest))
        (return (i32.const -1))))

    (local.set $record (i32.add (local.get $table)
      (i32.mul (local.get $free) (global.get $TT_FACE_STRIDE))))
    (i32.store (local.get $record) (local.get $hash))
    (i32.store offset=4 (local.get $record) (local.get $data_guest))
    (i32.store offset=8 (local.get $record) (local.get $size))
    (i32.store offset=12 (local.get $record)
      (call $tt_units_per_em (local.get $data) (local.get $size)))
    (i32.store offset=16 (local.get $record) (i32.const 1))
    (local.get $free))

  ;; ---- glyph cache ------------------------------------------------------
  ;;
  ;; Rasterization is once per glyph, face, and size - not once per TextOut.
  ;; Without this the scan converter would re-flatten and re-fill every
  ;; character of every repaint, which is the one way this path could end up
  ;; slower than the Canvas mask it replaces.
  ;;
  ;; Entries are 24 bytes:
  ;;
  ;;   +0  owner   face + 1, so zero means empty
  ;;   +4  gid
  ;;   +8  ppem
  ;;   +12 bitmap  guest pointer, 0 for a glyph with no ink
  ;;   +16 width | height << 16
  ;;   +20 left, +22 top   signed, in pixels, relative to the pen origin

  (func $tt_cache_ensure (result i32)
    (local $guest i32) (local $bytes i32)
    (if (global.get $tt_cache)
      (then (return (call $g2w (global.get $tt_cache)))))
    (local.set $bytes
      (i32.mul (global.get $TT_CACHE_SLOTS) (global.get $TT_CACHE_STRIDE)))
    (local.set $guest (call $heap_alloc (local.get $bytes)))
    (if (i32.eqz (local.get $guest)) (then (return (i32.const 0))))
    (memory.fill (call $g2w (local.get $guest)) (i32.const 0) (local.get $bytes))
    (global.set $tt_cache (local.get $guest))
    (call $g2w (local.get $guest)))

  ;; Free every cached bitmap and start over. A rehashing eviction policy
  ;; would be better under memory pressure; this one is correct, and the cache
  ;; only fills when a guest uses more than a thousand distinct glyph-size
  ;; pairs, at which point it has already paid for the rasterization once.
  (func $tt_cache_flush
    (local $table i32) (local $index i32) (local $entry i32)
    (if (i32.eqz (global.get $tt_cache)) (then (return)))
    (local.set $table (call $g2w (global.get $tt_cache)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $index) (global.get $TT_CACHE_SLOTS)))
      (local.set $entry (i32.add (local.get $table)
        (i32.mul (local.get $index) (global.get $TT_CACHE_STRIDE))))
      (if (i32.load (local.get $entry))
        (then (if (i32.load offset=12 (local.get $entry))
          (then (call $heap_free (i32.load offset=12 (local.get $entry)))))))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $scan)))
    (memory.fill (local.get $table) (i32.const 0)
      (i32.mul (global.get $TT_CACHE_SLOTS) (global.get $TT_CACHE_STRIDE)))
    (global.set $tt_cache_used (i32.const 0)))

  (func $tt_cache_slot (param $face i32) (param $gid i32) (param $ppem i32)
        (result i32)
    (local $table i32) (local $index i32) (local $probe i32) (local $entry i32)
    (local.set $table (call $tt_cache_ensure))
    (if (i32.eqz (local.get $table)) (then (return (i32.const 0))))
    (local.set $index (i32.and
      (i32.add (i32.add (i32.mul (local.get $face) (i32.const 0x9E3779B1))
          (i32.mul (local.get $gid) (i32.const 0x85EBCA6B)))
        (i32.mul (local.get $ppem) (i32.const 0xC2B2AE35)))
      (i32.sub (global.get $TT_CACHE_SLOTS) (i32.const 1))))
    (block $done (loop $probe_loop
      (br_if $done (i32.ge_u (local.get $probe) (global.get $TT_CACHE_SLOTS)))
      (local.set $entry (i32.add (local.get $table)
        (i32.mul (local.get $index) (global.get $TT_CACHE_STRIDE))))
      ;; An empty slot ends the probe: with no deletions, a run of occupied
      ;; slots is unbroken, so nothing can hide past the first hole.
      (if (i32.eqz (i32.load (local.get $entry)))
        (then (return (local.get $entry))))
      (if (i32.and
            (i32.eq (i32.load (local.get $entry))
              (i32.add (local.get $face) (i32.const 1)))
            (i32.and (i32.eq (i32.load offset=4 (local.get $entry)) (local.get $gid))
              (i32.eq (i32.load offset=8 (local.get $entry)) (local.get $ppem))))
        (then (return (local.get $entry))))
      (local.set $index (i32.and (i32.add (local.get $index) (i32.const 1))
        (i32.sub (global.get $TT_CACHE_SLOTS) (i32.const 1))))
      (local.set $probe (i32.add (local.get $probe) (i32.const 1)))
      (br $probe_loop)))
    (i32.const 0))

  (func $tt_raster_scratch (result i32)
    (local $guest i32)
    (if (global.get $tt_scratch)
      (then (return (call $g2w (global.get $tt_scratch)))))
    (local.set $guest (call $heap_alloc
      (call $tt_raster_scratch_bytes (global.get $TT_SCRATCH_WIDTH))))
    (if (i32.eqz (local.get $guest)) (then (return (i32.const 0))))
    (global.set $tt_scratch (local.get $guest))
    (call $g2w (local.get $guest)))

  ;; Cached glyph for a face at a size, rasterizing on a miss. Returns the
  ;; entry address, or 0 when the glyph cannot be produced at all.
  (func $tt_glyph_ensure (param $face i32) (param $gid i32) (param $ppem i32)
        (result i32)
    (local $entry i32) (local $data i32) (local $size i32) (local $width i32)
    (local $height i32) (local $bytes i32) (local $bitmap_guest i32)
    (local $scratch i32)
    (local.set $data (call $tt_face_data (local.get $face)))
    (local.set $size (call $tt_face_size (local.get $face)))
    (if (i32.eqz (local.get $data)) (then (return (i32.const 0))))
    (if (i32.or (i32.le_s (local.get $ppem) (i32.const 0))
          (i32.gt_s (local.get $ppem) (i32.const 255)))
      (then (return (i32.const 0))))
    ;; Flush before the table fills so probing never degrades into a full
    ;; scan of a table that can no longer take an insert.
    (if (i32.ge_u (i32.mul (global.get $tt_cache_used) (i32.const 4))
          (i32.mul (global.get $TT_CACHE_SLOTS) (i32.const 3)))
      (then (call $tt_cache_flush)))
    (local.set $entry
      (call $tt_cache_slot (local.get $face) (local.get $gid) (local.get $ppem)))
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (if (i32.load (local.get $entry)) (then (return (local.get $entry))))

    (local.set $width (call $tt_glyph_box_width (local.get $data) (local.get $size)
      (local.get $gid) (local.get $ppem)))
    (local.set $height (call $tt_glyph_box_height (local.get $data) (local.get $size)
      (local.get $gid) (local.get $ppem)))
    (i32.store (local.get $entry) (i32.add (local.get $face) (i32.const 1)))
    (i32.store offset=4 (local.get $entry) (local.get $gid))
    (i32.store offset=8 (local.get $entry) (local.get $ppem))
    (i32.store offset=12 (local.get $entry) (i32.const 0))
    (i32.store offset=16 (local.get $entry) (i32.const 0))
    (i32.store16 offset=20 (local.get $entry) (i32.const 0))
    (i32.store16 offset=22 (local.get $entry) (i32.const 0))
    (global.set $tt_cache_used (i32.add (global.get $tt_cache_used) (i32.const 1)))

    ;; A blank glyph caches as a real entry with no bitmap. Space is the
    ;; common case and must not be re-attempted on every character.
    (if (i32.or (i32.le_s (local.get $width) (i32.const 0))
          (i32.le_s (local.get $height) (i32.const 0)))
      (then (return (local.get $entry))))
    (if (i32.gt_s (local.get $width) (global.get $TT_SCRATCH_WIDTH))
      (then (return (local.get $entry))))

    (local.set $scratch (call $tt_raster_scratch))
    (if (i32.eqz (local.get $scratch)) (then (return (local.get $entry))))
    (local.set $bytes (i32.mul
      (i32.shr_u (i32.add (local.get $width) (i32.const 7)) (i32.const 3))
      (local.get $height)))
    (local.set $bitmap_guest (call $heap_alloc (local.get $bytes)))
    (if (i32.eqz (local.get $bitmap_guest)) (then (return (local.get $entry))))
    (if (i32.eqz (call $tt_rasterize_glyph (local.get $data) (local.get $size)
          (local.get $gid) (local.get $ppem) (call $g2w (local.get $bitmap_guest))
          (local.get $width) (local.get $height)
          (i32.mul (call $tt_glyph_box_left (local.get $data) (local.get $size)
            (local.get $gid) (local.get $ppem)) (i32.const 64))
          (i32.mul (call $tt_glyph_box_top (local.get $data) (local.get $size)
            (local.get $gid) (local.get $ppem)) (i32.const 64))
          (local.get $scratch)
          (call $tt_raster_scratch_bytes (global.get $TT_SCRATCH_WIDTH))))
      (then
        (call $heap_free (local.get $bitmap_guest))
        (return (local.get $entry))))

    (i32.store offset=12 (local.get $entry) (local.get $bitmap_guest))
    (i32.store offset=16 (local.get $entry)
      (i32.or (local.get $width) (i32.shl (local.get $height) (i32.const 16))))
    (i32.store16 offset=20 (local.get $entry)
      (call $tt_glyph_box_left (local.get $data) (local.get $size)
        (local.get $gid) (local.get $ppem)))
    (i32.store16 offset=22 (local.get $entry)
      (call $tt_glyph_box_top (local.get $data) (local.get $size)
        (local.get $gid) (local.get $ppem)))
    (local.get $entry))

  (func $tt_entry_width (param $entry i32) (result i32)
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (i32.and (i32.load offset=16 (local.get $entry)) (i32.const 0xFFFF)))

  (func $tt_entry_height (param $entry i32) (result i32)
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (i32.shr_u (i32.load offset=16 (local.get $entry)) (i32.const 16)))

  (func $tt_entry_left (param $entry i32) (result i32)
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (i32.load16_s offset=20 (local.get $entry)))

  (func $tt_entry_top (param $entry i32) (result i32)
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (i32.load16_s offset=22 (local.get $entry)))

  ;; One pixel of a cached glyph, addressed exactly as the FNT accessor does.
  (func $tt_entry_pixel (param $entry i32) (param $x i32) (param $y i32)
        (result i32)
    (local $bitmap i32) (local $height i32)
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (local.set $bitmap (i32.load offset=12 (local.get $entry)))
    (if (i32.eqz (local.get $bitmap)) (then (return (i32.const 0))))
    (local.set $height (call $tt_entry_height (local.get $entry)))
    (if (i32.or (i32.ge_u (local.get $x) (call $tt_entry_width (local.get $entry)))
          (i32.ge_u (local.get $y) (local.get $height)))
      (then (return (i32.const 0))))
    (call $tt_bitmap_pixel (call $g2w (local.get $bitmap)) (local.get $height)
      (local.get $x) (local.get $y)))

  ;; ---- face-level API ---------------------------------------------------
  ;;
  ;; What a caller in the GDI layer needs, without ever handling a buffer:
  ;; open a face by path, then ask it for widths, metrics, and glyphs.

  (func $tt_face_ansi_glyph (param $face i32) (param $byte i32) (result i32)
    (call $tt_ansi_glyph_index (call $tt_face_data (local.get $face))
      (call $tt_face_size (local.get $face)) (local.get $byte)))

  (func $tt_face_text_width (param $face i32) (param $text i32) (param $count i32)
        (param $ppem i32) (result i32)
    (call $tt_text_width_px (call $tt_face_data (local.get $face))
      (call $tt_face_size (local.get $face)) (local.get $text) (local.get $count)
      (local.get $ppem)))

  (func $tt_face_char_width (param $face i32) (param $byte i32) (param $ppem i32)
        (result i32)
    (call $tt_ansi_advance_px (call $tt_face_data (local.get $face))
      (call $tt_face_size (local.get $face)) (local.get $byte) (local.get $ppem)))

  (func $tt_face_ppem (param $face i32) (param $lf_height i32) (result i32)
    (call $tt_ppem_from_lfheight (call $tt_face_data (local.get $face))
      (call $tt_face_size (local.get $face)) (local.get $lf_height)))

  ;; TEXTMETRIC fields by index, so the GDI layer fills its struct from one
  ;; call site instead of fourteen exported functions.
  (func $tt_face_metric (param $face i32) (param $ppem i32) (param $field i32)
        (result i32)
    (local $data i32) (local $size i32)
    (local.set $data (call $tt_face_data (local.get $face)))
    (local.set $size (call $tt_face_size (local.get $face)))
    (if (i32.eqz (local.get $data)) (then (return (i32.const 0))))
    (if (i32.eqz (local.get $field))
      (then (return (call $tt_tm_height (local.get $data) (local.get $size)
        (local.get $ppem)))))
    (if (i32.eq (local.get $field) (i32.const 1))
      (then (return (call $tt_tm_ascent (local.get $data) (local.get $size)
        (local.get $ppem)))))
    (if (i32.eq (local.get $field) (i32.const 2))
      (then (return (call $tt_tm_descent (local.get $data) (local.get $size)
        (local.get $ppem)))))
    (if (i32.eq (local.get $field) (i32.const 3))
      (then (return (call $tt_tm_internal_leading (local.get $data) (local.get $size)
        (local.get $ppem)))))
    (if (i32.eq (local.get $field) (i32.const 4))
      (then (return (call $tt_tm_external_leading (local.get $data) (local.get $size)
        (local.get $ppem)))))
    (if (i32.eq (local.get $field) (i32.const 5))
      (then (return (call $tt_tm_ave_char_width (local.get $data) (local.get $size)
        (local.get $ppem)))))
    (if (i32.eq (local.get $field) (i32.const 6))
      (then (return (call $tt_tm_max_char_width (local.get $data) (local.get $size)
        (local.get $ppem)))))
    (if (i32.eq (local.get $field) (i32.const 7))
      (then (return (call $tt_tm_weight (local.get $data) (local.get $size)))))
    (if (i32.eq (local.get $field) (i32.const 8))
      (then (return (call $tt_is_italic (local.get $data) (local.get $size)))))
    (if (i32.eq (local.get $field) (i32.const 9))
      (then (return (call $tt_tm_pitch_and_family (local.get $data) (local.get $size)))))
    (if (i32.eq (local.get $field) (i32.const 10))
      (then (return (call $tt_tm_first_char (local.get $data) (local.get $size)))))
    (if (i32.eq (local.get $field) (i32.const 11))
      (then (return (call $tt_tm_last_char (local.get $data) (local.get $size)))))
    (i32.const 0))

  ;; Cached glyph for a guest ANSI byte: the single call a TextOut loop makes
  ;; per character.
  (func $tt_face_glyph (param $face i32) (param $byte i32) (param $ppem i32)
        (result i32)
    (call $tt_glyph_ensure (local.get $face)
      (call $tt_face_ansi_glyph (local.get $face) (local.get $byte))
      (local.get $ppem)))

  ;; ---- face substitution ------------------------------------------------
  ;;
  ;; A LOGFONT names a Win98 face. WAT turns that into the file real GDI would
  ;; have opened and asks the VFS for it. Which vendored open font actually
  ;; answers `C:\WINDOWS\FONTS\ARIAL.TTF` is the host's decision, recorded in
  ;; fonts/substitutions.json and applied when the VFS is seeded. Keeping
  ;; substitution host-side means this layer carries no licensing knowledge and
  ;; resolves faces exactly the way the bundled `.FON` path already does.
  ;;
  ;; The table is a flat blob of NUL-terminated strings, five per record: the
  ;; face name, then the regular, bold, italic and bold-italic files. An empty
  ;; string means the face has no such file and the lookup falls back toward
  ;; regular. An empty face name ends the table. A blob rather than records of
  ;; pointers means inserting a face never renumbers an address, which is the
  ;; failure mode tools/data_offsets.js exists to catch.

  (global $TT_SUBST_TABLE i32 (i32.const 0x07F0B400))
  (global $TT_SUBST_TABLE_SIZE i32 (i32.const 0x00000800))

  (data (i32.const 0x07F0B400)
    "Arial\00"
      "C:\\WINDOWS\\FONTS\\ARIAL.TTF\00"
      "C:\\WINDOWS\\FONTS\\ARIALBD.TTF\00"
      "C:\\WINDOWS\\FONTS\\ARIALI.TTF\00"
      "C:\\WINDOWS\\FONTS\\ARIALBI.TTF\00"
    "Times New Roman\00"
      "C:\\WINDOWS\\FONTS\\TIMES.TTF\00"
      "C:\\WINDOWS\\FONTS\\TIMESBD.TTF\00"
      "C:\\WINDOWS\\FONTS\\TIMESI.TTF\00"
      "C:\\WINDOWS\\FONTS\\TIMESBI.TTF\00"
    "Courier New\00"
      "C:\\WINDOWS\\FONTS\\COUR.TTF\00"
      "C:\\WINDOWS\\FONTS\\COURBD.TTF\00"
      "C:\\WINDOWS\\FONTS\\COURI.TTF\00"
      "C:\\WINDOWS\\FONTS\\COURBI.TTF\00"
    "Tahoma\00"
      "C:\\WINDOWS\\FONTS\\TAHOMA.TTF\00"
      "C:\\WINDOWS\\FONTS\\TAHOMABD.TTF\00"
      "\00"
      "\00"
    "Marlett\00"
      "C:\\WINDOWS\\FONTS\\MARLETT.TTF\00"
      "\00" "\00" "\00"
    "Symbol\00"
      "C:\\WINDOWS\\FONTS\\SYMBOL.TTF\00"
      "\00" "\00" "\00"
    "Wingdings\00"
      "C:\\WINDOWS\\FONTS\\WINGDING.TTF\00"
      "\00" "\00" "\00"
    "Webdings\00"
      "C:\\WINDOWS\\FONTS\\WEBDINGS.TTF\00"
      "\00" "\00" "\00"
    "\00")

  (func $tt_subst_fold (param $byte i32) (result i32)
    (if (i32.and (i32.ge_u (local.get $byte) (i32.const 65))
          (i32.le_u (local.get $byte) (i32.const 90)))
      (then (return (i32.add (local.get $byte) (i32.const 32)))))
    (local.get $byte))

  ;; GDI matched face names without regard to case, and a guest is as likely
  ;; to write "arial" as "Arial".
  (func $tt_subst_name_equal (param $a i32) (param $b i32) (result i32)
    (local $ca i32) (local $cb i32)
    (block $done (loop $scan
      (local.set $ca (call $tt_subst_fold (i32.load8_u (local.get $a))))
      (local.set $cb (call $tt_subst_fold (i32.load8_u (local.get $b))))
      (if (i32.ne (local.get $ca) (local.get $cb))
        (then (return (i32.const 0))))
      (br_if $done (i32.eqz (local.get $ca)))
      (local.set $a (i32.add (local.get $a) (i32.const 1)))
      (local.set $b (i32.add (local.get $b) (i32.const 1)))
      (br $scan)))
    (i32.const 1))

  ;; Address just past one NUL-terminated string. Bounded by the table end so
  ;; a mis-edited blob walks off into a stop rather than into memory.
  (func $tt_subst_skip (param $p i32) (param $end i32) (result i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
      (br_if $done (i32.eqz (i32.load8_u (local.get $p))))
      (local.set $p (i32.add (local.get $p) (i32.const 1)))
      (br $scan)))
    (i32.add (local.get $p) (i32.const 1)))

  (func $tt_subst_pick (param $regular i32) (param $bold i32)
        (param $slanted i32) (param $bold_slanted i32)
        (param $weight i32) (param $italic i32) (result i32)
    (local $want_bold i32)
    (local.set $want_bold (i32.ge_s (local.get $weight) (i32.const 700)))
    (local.set $italic (i32.ne (local.get $italic) (i32.const 0)))
    (if (i32.and (local.get $want_bold) (local.get $italic))
      (then (if (i32.load8_u (local.get $bold_slanted))
        (then (return (local.get $bold_slanted))))))
    ;; A face with no italic file is not synthesized here. GDI would have
    ;; sheared the outline; until this layer does that, returning the upright
    ;; file is an honest approximation rather than a wrong glyph shape.
    (if (local.get $want_bold)
      (then (if (i32.load8_u (local.get $bold))
        (then (return (local.get $bold))))))
    (if (local.get $italic)
      (then (if (i32.load8_u (local.get $slanted))
        (then (return (local.get $slanted))))))
    (if (i32.load8_u (local.get $regular)) (then (return (local.get $regular))))
    (i32.const 0))

  ;; Font file for a face name, or 0 when the face has no substitute and the
  ;; caller should keep doing whatever it did before. `$name` is a WASM
  ;; address; face names live in a guest heap allocation, so GDI callers pass
  ;; `(call $g2w ...)`.
  (func $tt_subst_path (param $name i32) (param $weight i32) (param $italic i32)
        (result i32)
    (local $p i32) (local $end i32)
    (local $regular i32) (local $bold i32)
    (local $slanted i32) (local $bold_slanted i32) (local $registered i32)
    (if (i32.eqz (local.get $name)) (then (return (i32.const 0))))
    ;; A font the guest installed itself outranks the substitute for it.
    (local.set $registered (call $tt_reg_path (local.get $name)
      (local.get $weight) (local.get $italic)))
    (if (local.get $registered) (then (return (local.get $registered))))
    (local.set $p (global.get $TT_SUBST_TABLE))
    (local.set $end (i32.add (global.get $TT_SUBST_TABLE)
      (global.get $TT_SUBST_TABLE_SIZE)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
      (br_if $done (i32.eqz (i32.load8_u (local.get $p))))
      (local.set $regular (call $tt_subst_skip (local.get $p) (local.get $end)))
      (local.set $bold
        (call $tt_subst_skip (local.get $regular) (local.get $end)))
      (local.set $slanted
        (call $tt_subst_skip (local.get $bold) (local.get $end)))
      (local.set $bold_slanted
        (call $tt_subst_skip (local.get $slanted) (local.get $end)))
      (if (call $tt_subst_name_equal (local.get $name) (local.get $p))
        (then (return (call $tt_subst_pick (local.get $regular) (local.get $bold)
          (local.get $slanted) (local.get $bold_slanted)
          (local.get $weight) (local.get $italic)))))
      (local.set $p
        (call $tt_subst_skip (local.get $bold_slanted) (local.get $end)))
      (br $scan)))
    (i32.const 0))

  ;; Name of the nth substitution-table entry that actually has a file, as a
  ;; WASM address, or 0 once the table runs out. Entries with an empty regular
  ;; file are skipped: they name a face nothing is mounted for, and reporting
  ;; one to an enumerating application would offer a face that cannot be drawn.
  (func $tt_subst_enum_name (param $index i32) (result i32)
    (local $p i32) (local $end i32) (local $regular i32) (local $bold i32)
    (local $slanted i32) (local $bold_slanted i32) (local $seen i32)
    (local.set $p (global.get $TT_SUBST_TABLE))
    (local.set $end (i32.add (global.get $TT_SUBST_TABLE)
      (global.get $TT_SUBST_TABLE_SIZE)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
      (br_if $done (i32.eqz (i32.load8_u (local.get $p))))
      (local.set $regular (call $tt_subst_skip (local.get $p) (local.get $end)))
      (local.set $bold (call $tt_subst_skip (local.get $regular) (local.get $end)))
      (local.set $slanted (call $tt_subst_skip (local.get $bold) (local.get $end)))
      (local.set $bold_slanted
        (call $tt_subst_skip (local.get $slanted) (local.get $end)))
      (if (i32.load8_u (local.get $regular))
        (then
          (if (i32.eq (local.get $seen) (local.get $index))
            (then (return (local.get $p))))
          (local.set $seen (i32.add (local.get $seen) (i32.const 1)))))
      (local.set $p
        (call $tt_subst_skip (local.get $bold_slanted) (local.get $end)))
      (br $scan)))
    (i32.const 0))

  ;; ---- runtime-registered faces -----------------------------------------
  ;;
  ;; The table above is what Win98 shipped. A guest may also install a font of
  ;; its own with AddFontResourceA, naming a file that no table could know
  ;; about - fontview.exe does exactly this to display the file it was opened
  ;; on, and refuses to draw anything when the call fails.
  ;;
  ;; So registration is a small mutable table beside the static one, keyed by
  ;; the family name read out of the file rather than by the filename: the
  ;; guest installs ARIALBD.TTF by path and then asks for "Arial" bold, and
  ;; only the name table connects the two.
  ;;
  ;; Registered entries are consulted BEFORE the substitution table. A guest
  ;; that ships its own copy of a face means that copy, and the substitute
  ;; exists only to answer for files this emulator has no license to carry.

  ;; Matches the face table: a guest that installs more files than the face
  ;; cache can hold open would fail at the open rather than here, and a
  ;; registry smaller than the cache would fail first for no stated reason.
  (global $TT_REG_MAX i32 (i32.const 32))
  (global $TT_REG_NAME_MAX i32 (i32.const 64))
  (global $TT_REG_PATH_MAX i32 (i32.const 132))
  (global $TT_REG_STRIDE i32 (i32.const 208))
  (global $TT_REG_NAME_OFF i32 (i32.const 12))
  (global $TT_REG_PATH_OFF i32 (i32.const 76))
  (global $tt_reg (mut i32) (i32.const 0))

  (func $tt_reg_ensure (result i32)
    (local $guest i32) (local $bytes i32)
    (if (global.get $tt_reg)
      (then (return (call $g2w (global.get $tt_reg)))))
    (local.set $bytes
      (i32.mul (global.get $TT_REG_MAX) (global.get $TT_REG_STRIDE)))
    (local.set $guest (call $heap_alloc (local.get $bytes)))
    (if (i32.eqz (local.get $guest)) (then (return (i32.const 0))))
    (memory.fill (call $g2w (local.get $guest)) (i32.const 0) (local.get $bytes))
    (global.set $tt_reg (local.get $guest))
    (call $g2w (local.get $guest)))

  (func $tt_reg_record (param $table i32) (param $index i32) (result i32)
    (i32.add (local.get $table)
      (i32.mul (local.get $index) (global.get $TT_REG_STRIDE))))

  ;; Copy a NUL-terminated string, returning its length, or 0 when it does not
  ;; fit. A truncated path names a different file and a truncated face name
  ;; matches nothing, so neither is worth storing.
  (func $tt_reg_copy_str (param $dst i32) (param $src i32) (param $max i32)
        (result i32)
    (local $len i32) (local $byte i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $len) (local.get $max)))
      (local.set $byte (i32.load8_u (i32.add (local.get $src) (local.get $len))))
      (i32.store8 (i32.add (local.get $dst) (local.get $len)) (local.get $byte))
      (br_if $done (i32.eqz (local.get $byte)))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (br $scan)))
    (if (i32.ge_u (local.get $len) (local.get $max)) (then (return (i32.const 0))))
    (local.get $len))

  ;; Index of the entry holding this path, or -1. Paths are compared with the
  ;; same case-folding the face cache uses, so re-installing the same file
  ;; under a different spelling updates one entry rather than filling the
  ;; table with copies of it.
  (func $tt_reg_find_path (param $table i32) (param $path i32) (result i32)
    (local $index i32) (local $record i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $index) (global.get $TT_REG_MAX)))
      (local.set $record (call $tt_reg_record (local.get $table) (local.get $index)))
      (if (i32.load (local.get $record))
        (then (if (call $tt_subst_name_equal (local.get $path)
                (i32.add (local.get $record) (global.get $TT_REG_PATH_OFF)))
          (then (return (local.get $index))))))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  ;; Install a font file. Returns 1 when the file is a TrueType font whose
  ;; family name could be read, 0 otherwise - which is the AddFontResourceA
  ;; return value, a count of fonts added.
  (func $tt_reg_add (param $path_guest i32) (result i32)
    (local $table i32) (local $path i32) (local $face i32)
    (local $data i32) (local $size i32) (local $index i32) (local $free i32)
    (local $record i32) (local $weight i32)
    (if (i32.eqz (local.get $path_guest)) (then (return (i32.const 0))))
    (local.set $face (call $tt_face_open (local.get $path_guest)))
    (if (i32.lt_s (local.get $face) (i32.const 0)) (then (return (i32.const 0))))
    (local.set $data (call $tt_face_data (local.get $face)))
    (local.set $size (call $tt_face_size (local.get $face)))
    (if (i32.eqz (local.get $data)) (then (return (i32.const 0))))
    (local.set $table (call $tt_reg_ensure))
    (if (i32.eqz (local.get $table)) (then (return (i32.const 0))))
    (local.set $path (call $g2w (local.get $path_guest)))

    (local.set $index (call $tt_reg_find_path (local.get $table) (local.get $path)))
    (if (i32.ge_s (local.get $index) (i32.const 0))
      (then (return (i32.const 1))))

    (local.set $free (i32.const -1))
    (local.set $index (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $index) (global.get $TT_REG_MAX)))
      (local.set $record (call $tt_reg_record (local.get $table) (local.get $index)))
      (if (i32.eqz (i32.load (local.get $record)))
        (then (local.set $free (local.get $index)) (br $done)))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $scan)))
    (if (i32.lt_s (local.get $free) (i32.const 0)) (then (return (i32.const 0))))
    (local.set $record (call $tt_reg_record (local.get $table) (local.get $free)))

    (if (i32.eqz (call $tt_family_name (local.get $data) (local.get $size)
          (i32.add (local.get $record) (global.get $TT_REG_NAME_OFF))
          (global.get $TT_REG_NAME_MAX)))
      (then (return (i32.const 0))))
    (if (i32.eqz (call $tt_reg_copy_str
          (i32.add (local.get $record) (global.get $TT_REG_PATH_OFF))
          (local.get $path) (global.get $TT_REG_PATH_MAX)))
      (then (return (i32.const 0))))

    ;; A font with no OS/2 table reports weight 0, which would rank below
    ;; every real weight when a style is chosen. Regular is the honest reading.
    (local.set $weight (call $tt_weight_class (local.get $data) (local.get $size)))
    (i32.store offset=4 (local.get $record)
      (select (local.get $weight) (i32.const 400) (local.get $weight)))
    (i32.store offset=8 (local.get $record)
      (call $tt_is_italic (local.get $data) (local.get $size)))
    (i32.store (local.get $record) (i32.const 1))
    (i32.const 1))

  (func $tt_reg_remove (param $path_guest i32) (result i32)
    (local $table i32) (local $index i32)
    (if (i32.eqz (local.get $path_guest)) (then (return (i32.const 0))))
    (if (i32.eqz (global.get $tt_reg)) (then (return (i32.const 0))))
    (local.set $table (call $tt_reg_ensure))
    (if (i32.eqz (local.get $table)) (then (return (i32.const 0))))
    (local.set $index (call $tt_reg_find_path (local.get $table)
      (call $g2w (local.get $path_guest))))
    (if (i32.lt_s (local.get $index) (i32.const 0)) (then (return (i32.const 0))))
    (i32.store (call $tt_reg_record (local.get $table) (local.get $index))
      (i32.const 0))
    (i32.const 1))

  ;; Best registered file for a face name, or 0. Unlike the static table,
  ;; which has a named slot per style, registered entries arrive one file at a
  ;; time in any order - so the style is scored rather than indexed, and a
  ;; family installed regular-only still answers a bold request with the file
  ;; it has.
  (func $tt_reg_path (param $name i32) (param $weight i32) (param $italic i32)
        (result i32)
    (local $table i32) (local $index i32) (local $record i32)
    (local $want_bold i32) (local $score i32) (local $best i32) (local $found i32)
    (if (i32.eqz (local.get $name)) (then (return (i32.const 0))))
    (if (i32.eqz (global.get $tt_reg)) (then (return (i32.const 0))))
    (local.set $table (call $tt_reg_ensure))
    (if (i32.eqz (local.get $table)) (then (return (i32.const 0))))
    (local.set $want_bold (i32.ge_s (local.get $weight) (i32.const 700)))
    (local.set $italic (i32.ne (local.get $italic) (i32.const 0)))
    (local.set $best (i32.const -1))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $index) (global.get $TT_REG_MAX)))
      (local.set $record (call $tt_reg_record (local.get $table) (local.get $index)))
      (if (i32.load (local.get $record))
        (then (if (call $tt_subst_name_equal (local.get $name)
                (i32.add (local.get $record) (global.get $TT_REG_NAME_OFF)))
          (then
            ;; Weight is worth more than slant because a bold request answered
            ;; with an italic file is further from what was asked for than a
            ;; bold request answered upright.
            (local.set $score (i32.add
              (i32.mul (i32.const 2) (i32.eq (local.get $want_bold)
                (i32.ge_s (i32.load offset=4 (local.get $record)) (i32.const 700))))
              (i32.eq (local.get $italic)
                (i32.ne (i32.load offset=8 (local.get $record)) (i32.const 0)))))
            (if (i32.gt_s (local.get $score) (local.get $best))
              (then
                (local.set $best (local.get $score))
                (local.set $found
                  (i32.add (local.get $record) (global.get $TT_REG_PATH_OFF)))))))))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $scan)))
    (local.get $found))

  ;; ---- enumeration ------------------------------------------------------
  ;;
  ;; Scalable faces an application can ask for by name: every substitution
  ;; entry with a file, then every face the guest installed itself that the
  ;; table does not already name. An application that enumerates before it
  ;; picks — a font dialog, a word processor's face list — sees the same set of
  ;; names that CreateFontIndirect will actually honour, which is the whole
  ;; point of reporting them.
  ;;
  ;; The registry is searched by name against the substitution table so a guest
  ;; installing its own Arial does not produce two "Arial" entries; Win98
  ;; reports one family once.

  (func $tt_reg_enum_name (param $index i32) (result i32)
    (local $table i32) (local $i i32) (local $record i32) (local $name i32)
    (local $seen i32)
    (if (i32.eqz (global.get $tt_reg)) (then (return (i32.const 0))))
    (local.set $table (call $tt_reg_ensure))
    (if (i32.eqz (local.get $table)) (then (return (i32.const 0))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $TT_REG_MAX)))
      (local.set $record (call $tt_reg_record (local.get $table) (local.get $i)))
      (if (i32.load (local.get $record))
        (then
          (local.set $name
            (i32.add (local.get $record) (global.get $TT_REG_NAME_OFF)))
          ;; Skip a name the substitution table already reports, and a name an
          ;; earlier registry entry already reported (bold and italic files of
          ;; one family each carry that family's name).
          (if (i32.and
                (i32.eqz (call $tt_subst_enum_index (local.get $name)))
                (i32.eqz (call $tt_reg_enum_earlier
                  (local.get $table) (local.get $i) (local.get $name))))
            (then
              (if (i32.eq (local.get $seen) (local.get $index))
                (then (return (local.get $name))))
              (local.set $seen (i32.add (local.get $seen) (i32.const 1)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; 1 when the substitution table reports this name, else 0.
  (func $tt_subst_enum_index (param $name i32) (result i32)
    (local $i i32) (local $entry i32)
    (block $done (loop $scan
      (local.set $entry (call $tt_subst_enum_name (local.get $i)))
      (br_if $done (i32.eqz (local.get $entry)))
      (if (call $tt_subst_name_equal (local.get $name) (local.get $entry))
        (then (return (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  (func $tt_reg_enum_earlier (param $table i32) (param $limit i32)
        (param $name i32) (result i32)
    (local $i i32) (local $record i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $limit)))
      (local.set $record (call $tt_reg_record (local.get $table) (local.get $i)))
      (if (i32.load (local.get $record))
        (then (if (call $tt_subst_name_equal (local.get $name)
                (i32.add (local.get $record) (global.get $TT_REG_NAME_OFF)))
          (then (return (i32.const 1))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; The nth enumerable scalable face name, substitutes first, or 0 past the
  ;; end. One flat index so the GDI enumerator can walk it as candidates.
  (func $tt_enum_face_name (param $index i32) (result i32)
    (local $name i32) (local $count i32)
    (local.set $name (call $tt_subst_enum_name (local.get $index)))
    (if (local.get $name) (then (return (local.get $name))))
    (block $done (loop $scan
      (br_if $done (i32.eqz (call $tt_subst_enum_name (local.get $count))))
      (local.set $count (i32.add (local.get $count) (i32.const 1)))
      (br $scan)))
    (call $tt_reg_enum_name (i32.sub (local.get $index) (local.get $count))))

  ;; Cell metrics for an enumerated face at a nominal em, packed as
  ;; height | ascent<<8 | average<<16 | maximum<<24, or 0 when the file cannot
  ;; be opened or its head/hhea are unusable. Every field is a byte, which
  ;; holds for any em an enumeration would report.
  (func $tt_enum_face_metrics (param $name i32) (param $em i32) (result i32)
    (local $face i32) (local $data i32) (local $size i32) (local $upem i32)
    (local $ascent i32) (local $descent i32) (local $height i32)
    (local $average i32) (local $maximum i32)
    (local.set $face (call $tt_face_for_logfont
      (local.get $name) (i32.const 400) (i32.const 0)))
    (if (i32.lt_s (local.get $face) (i32.const 0)) (then (return (i32.const 0))))
    (local.set $data (call $tt_face_data (local.get $face)))
    (local.set $size (call $tt_face_size (local.get $face)))
    (if (i32.eqz (local.get $data)) (then (return (i32.const 0))))
    (local.set $upem (call $tt_units_per_em (local.get $data) (local.get $size)))
    (if (i32.le_s (local.get $upem) (i32.const 0)) (then (return (i32.const 0))))
    ;; usWinAscent/usWinDescent bound the inked cell, which is what a
    ;; TEXTMETRIC height means; hhea is the line box and would over-report.
    (local.set $ascent (call $tt_win_ascent (local.get $data) (local.get $size)))
    (local.set $descent (call $tt_win_descent (local.get $data) (local.get $size)))
    (if (i32.le_s (local.get $ascent) (i32.const 0))
      (then (local.set $ascent (call $tt_ascender (local.get $data) (local.get $size)))))
    (if (i32.le_s (local.get $ascent) (i32.const 0)) (then (return (i32.const 0))))
    (if (i32.lt_s (local.get $descent) (i32.const 0))
      (then (local.set $descent (i32.sub (i32.const 0) (local.get $descent)))))
    (local.set $ascent (i32.div_s
      (i32.add (i32.mul (local.get $ascent) (local.get $em))
        (i32.div_s (local.get $upem) (i32.const 2)))
      (local.get $upem)))
    (local.set $descent (i32.div_s
      (i32.add (i32.mul (local.get $descent) (local.get $em))
        (i32.div_s (local.get $upem) (i32.const 2)))
      (local.get $upem)))
    (local.set $height (i32.add (local.get $ascent) (local.get $descent)))
    ;; Advance of 'n' as the average character width, the same measure Win98's
    ;; tmAveCharWidth reports for a proportional face.
    (local.set $average (call $tt_advance_fu (local.get $data) (local.get $size)
      (call $tt_glyph_index (local.get $data) (local.get $size) (i32.const 110))))
    (local.set $average (i32.div_s
      (i32.add (i32.mul (local.get $average) (local.get $em))
        (i32.div_s (local.get $upem) (i32.const 2)))
      (local.get $upem)))
    (if (i32.le_s (local.get $average) (i32.const 0))
      (then (local.set $average (i32.div_s (local.get $em) (i32.const 2)))))
    (local.set $maximum (local.get $height))
    (if (i32.or (i32.gt_u (local.get $height) (i32.const 255))
          (i32.or (i32.gt_u (local.get $ascent) (i32.const 255))
                  (i32.gt_u (local.get $average) (i32.const 255))))
      (then (return (i32.const 0))))
    (i32.or
      (i32.or (local.get $height) (i32.shl (local.get $ascent) (i32.const 8)))
      (i32.or (i32.shl (local.get $average) (i32.const 16))
              (i32.shl (local.get $maximum) (i32.const 24)))))

  ;; Open the substitute for a LOGFONT face name. Returns a face index, or -1
  ;; when the face has no substitute or the file is not in the VFS.
  (func $tt_face_for_logfont (param $name i32) (param $weight i32)
        (param $italic i32) (result i32)
    (local $path i32)
    (local.set $path (call $tt_subst_path (local.get $name) (local.get $weight)
      (local.get $italic)))
    (if (i32.eqz (local.get $path)) (then (return (i32.const -1))))
    (call $tt_face_open (call $w2g (local.get $path))))

  ;; ---- synthetic strikes ------------------------------------------------
  ;;
  ;; The bitmap-font path already owns everything a text call needs: layout,
  ;; alignment, clipping, colours, background modes, paths, TA_UPDATECP,
  ;; justification, GetGlyphOutline. It reaches all of it through one parsed
  ;; FNT image. So a scalable face does not get a second renderer here - it
  ;; gets rasterized at one ppem into an FNT 3.00 image and installed as an
  ;; ordinary strike, after which nothing downstream cares that the glyphs
  ;; came from an outline.
  ;;
  ;; That the glyph cache already stores bitmaps in the FNT column-major bit
  ;; layout is what makes this a copy rather than a conversion.
  ;;
  ;; What is lost by going through a bitmap cell: a negative left bearing is
  ;; clipped, because an FNT cell starts at the pen. Win98 GDI clipped the
  ;; same way for its own bitmap fonts, and the alternative is a parallel
  ;; renderer that would have to re-derive every policy listed above.

  (global $TT_FNT_HEADER i32 (i32.const 148))
  (global $TT_FNT_ENTRY i32 (i32.const 6))
  ;; 0..255 plus the sentinel entry every FNT carries after the last glyph.
  (global $TT_FNT_ENTRIES i32 (i32.const 257))
  ;; A face this tall is not a Win98 UI font, and the image would be megabytes.
  (global $TT_FNT_MAX_HEIGHT i32 (i32.const 200))

  (func $tt_fnt_data_off (result i32)
    (i32.add (global.get $TT_FNT_HEADER)
      (i32.mul (global.get $TT_FNT_ENTRIES) (global.get $TT_FNT_ENTRY))))

  ;; Cell width for one code. In an FNT the char-table width IS the advance -
  ;; the renderer moves the pen by exactly this - so a cell widened to hold an
  ;; overhanging glyph would widen the letter spacing with it. Ink that runs
  ;; past the advance is clipped instead, which is what a bitmap font does.
  (func $tt_fnt_cell_width (param $face i32) (param $ppem i32) (param $code i32)
        (result i32)
    (local $width i32)
    (local.set $width
      (call $tt_face_char_width (local.get $face) (local.get $code)
        (local.get $ppem)))
    ;; A zero-width cell is rejected by the strike parser, and a control code
    ;; with no glyph still needs a slot, so an empty cell is one column wide.
    (select (local.get $width) (i32.const 1)
      (i32.gt_s (local.get $width) (i32.const 0))))

  (func $tt_fnt_cell_bytes (param $width i32) (param $height i32) (result i32)
    (i32.mul (i32.shr_u (i32.add (local.get $width) (i32.const 7)) (i32.const 3))
      (local.get $height)))

  ;; Byte length of the image this face and size would produce, or 0 when it
  ;; is not one this layer will build.
  (func $tt_fnt_size (param $face i32) (param $ppem i32) (param $name_len i32)
        (result i32)
    (local $height i32) (local $code i32) (local $total i32)
    (local.set $height (call $tt_face_metric (local.get $face) (local.get $ppem)
      (i32.const 0)))
    (if (i32.or (i32.le_s (local.get $height) (i32.const 0))
          (i32.gt_s (local.get $height) (global.get $TT_FNT_MAX_HEIGHT)))
      (then (return (i32.const 0))))
    (local.set $total (call $tt_fnt_data_off))
    (block $done (loop $scan
      (br_if $done (i32.gt_u (local.get $code) (i32.const 255)))
      (local.set $total (i32.add (local.get $total)
        (call $tt_fnt_cell_bytes
          (call $tt_fnt_cell_width (local.get $face) (local.get $ppem)
            (local.get $code))
          (local.get $height))))
      (local.set $code (i32.add (local.get $code) (i32.const 1)))
      (br $scan)))
    (i32.add (local.get $total) (i32.add (local.get $name_len) (i32.const 1))))

  ;; Blit one cached glyph into its FNT cell. The cache and the cell share a
  ;; bit layout, but not an origin: the cache stores ink with bearings, the
  ;; cell is a full box whose baseline sits at `ascent`.
  (func $tt_fnt_blit_cell (param $entry i32) (param $cell i32) (param $width i32)
        (param $height i32) (param $ascent i32)
    (local $gw i32) (local $gh i32) (local $ox i32) (local $oy i32)
    (local $gx i32) (local $gy i32) (local $dx i32) (local $dy i32)
    (local $slot i32)
    (if (i32.eqz (local.get $entry)) (then (return)))
    (local.set $gw (call $tt_entry_width (local.get $entry)))
    (local.set $gh (call $tt_entry_height (local.get $entry)))
    (local.set $ox (call $tt_entry_left (local.get $entry)))
    (local.set $oy (i32.sub (local.get $ascent)
      (call $tt_entry_top (local.get $entry))))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_u (local.get $gy) (local.get $gh)))
      (local.set $dy (i32.add (local.get $oy) (local.get $gy)))
      (if (i32.lt_u (local.get $dy) (local.get $height))
        (then
          (local.set $gx (i32.const 0))
          (block $cols_done (loop $cols
            (br_if $cols_done (i32.ge_u (local.get $gx) (local.get $gw)))
            (local.set $dx (i32.add (local.get $ox) (local.get $gx)))
            (if (i32.and (i32.lt_u (local.get $dx) (local.get $width))
                  (call $tt_entry_pixel (local.get $entry) (local.get $gx)
                    (local.get $gy)))
              (then
                (local.set $slot (i32.add (local.get $cell)
                  (i32.add (i32.mul (i32.shr_u (local.get $dx) (i32.const 3))
                      (local.get $height))
                    (local.get $dy))))
                (i32.store8 (local.get $slot)
                  (i32.or (i32.load8_u (local.get $slot))
                    (i32.shr_u (i32.const 0x80)
                      (i32.and (local.get $dx) (i32.const 7)))))))
            (local.set $gx (i32.add (local.get $gx) (i32.const 1)))
            (br $cols)))))
      (local.set $gy (i32.add (local.get $gy) (i32.const 1)))
      (br $rows))))

  ;; Write a complete FNT 3.00 image for one face at one ppem. Returns the
  ;; byte length written, or 0. `$name` is the face name the strike installs
  ;; under, so face matching keeps working on the Win98 name.
  (func $tt_fnt_build (param $face i32) (param $ppem i32) (param $name i32)
        (param $out i32) (param $capacity i32) (result i32)
    (local $height i32) (local $ascent i32) (local $name_len i32)
    (local $total i32) (local $code i32) (local $width i32)
    (local $entry i32) (local $data_off i32) (local $face_off i32)
    (local $table i32) (local $ch i32)
    (local.set $name_len (call $tt_strlen (local.get $name)))
    (local.set $total (call $tt_fnt_size (local.get $face) (local.get $ppem)
      (local.get $name_len)))
    (if (i32.or (i32.eqz (local.get $total))
          (i32.gt_u (local.get $total) (local.get $capacity)))
      (then (return (i32.const 0))))
    (local.set $height (call $tt_face_metric (local.get $face) (local.get $ppem)
      (i32.const 0)))
    (local.set $ascent (call $tt_face_metric (local.get $face) (local.get $ppem)
      (i32.const 1)))
    (memory.fill (local.get $out) (i32.const 0) (local.get $total))

    (local.set $data_off (call $tt_fnt_data_off))
    (local.set $table (i32.add (local.get $out) (global.get $TT_FNT_HEADER)))
    (block $done (loop $glyphs
      (br_if $done (i32.gt_u (local.get $code) (i32.const 255)))
      (local.set $width (call $tt_fnt_cell_width (local.get $face)
        (local.get $ppem) (local.get $code)))
      (i32.store16 (i32.add (local.get $table)
          (i32.mul (local.get $code) (global.get $TT_FNT_ENTRY)))
        (local.get $width))
      (i32.store (i32.add (i32.add (local.get $table)
            (i32.mul (local.get $code) (global.get $TT_FNT_ENTRY)))
          (i32.const 2))
        (local.get $data_off))
      (local.set $entry (call $tt_face_glyph (local.get $face) (local.get $code)
        (local.get $ppem)))
      (call $tt_fnt_blit_cell (local.get $entry)
        (i32.add (local.get $out) (local.get $data_off))
        (local.get $width) (local.get $height) (local.get $ascent))
      (local.set $data_off (i32.add (local.get $data_off)
        (call $tt_fnt_cell_bytes (local.get $width) (local.get $height))))
      (local.set $code (i32.add (local.get $code) (i32.const 1)))
      (br $glyphs)))

    (local.set $face_off (local.get $data_off))
    (local.set $code (i32.const 0))
    (block $name_done (loop $copy
      (br_if $name_done (i32.ge_u (local.get $code) (local.get $name_len)))
      (local.set $ch (i32.load8_u
        (i32.add (local.get $name) (local.get $code))))
      (i32.store8 (i32.add (local.get $out)
          (i32.add (local.get $face_off) (local.get $code)))
        (local.get $ch))
      (local.set $code (i32.add (local.get $code) (i32.const 1)))
      (br $copy)))

    ;; FNT 3.00 header. Only the fields the strike parser reads are meaningful
    ;; here; the rest stay zero rather than carrying invented values.
    (i32.store16 (local.get $out) (i32.const 0x0300))
    (i32.store offset=2 (local.get $out) (local.get $total))
    (i32.store16 offset=74 (local.get $out) (local.get $ascent))
    (i32.store16 offset=76 (local.get $out)
      (call $tt_face_metric (local.get $face) (local.get $ppem) (i32.const 3)))
    (i32.store16 offset=78 (local.get $out)
      (call $tt_face_metric (local.get $face) (local.get $ppem) (i32.const 4)))
    (i32.store8 offset=80 (local.get $out)
      (call $tt_face_metric (local.get $face) (local.get $ppem) (i32.const 8)))
    (i32.store16 offset=83 (local.get $out)
      (call $tt_face_metric (local.get $face) (local.get $ppem) (i32.const 7)))
    (i32.store8 offset=85 (local.get $out) (i32.const 0))
    (i32.store16 offset=88 (local.get $out) (local.get $height))
    (i32.store8 offset=90 (local.get $out)
      (call $tt_face_metric (local.get $face) (local.get $ppem) (i32.const 9)))
    (i32.store16 offset=91 (local.get $out)
      (call $tt_face_metric (local.get $face) (local.get $ppem) (i32.const 5)))
    (i32.store16 offset=93 (local.get $out)
      (call $tt_face_metric (local.get $face) (local.get $ppem) (i32.const 6)))
    (i32.store8 offset=95 (local.get $out) (i32.const 0))
    (i32.store8 offset=96 (local.get $out) (i32.const 255))
    ;; Both are stored relative to dfFirstChar, which is 0 here.
    (i32.store8 offset=97 (local.get $out) (i32.const 0x3F))
    (i32.store8 offset=99 (local.get $out) (i32.const 0x20))
    (i32.store offset=105 (local.get $out) (local.get $face_off))
    (i32.store offset=117 (local.get $out) (call $tt_fnt_data_off))
    (local.get $total))

  (func $tt_strlen (param $text i32) (result i32)
    (local $n i32)
    (if (i32.eqz (local.get $text)) (then (return (i32.const 0))))
    (block $done (loop $scan
      (br_if $done (i32.eqz (i32.load8_u (i32.add (local.get $text) (local.get $n)))))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br $scan)))
    (local.get $n))

  ;; One synthetic strike per (face name, ppem, weight, italic). Folding the
  ;; case here means "Arial" and "arial" share a strike the way they already
  ;; share a face.
  (func $tt_strike_hash (param $name i32) (param $ppem i32) (param $weight i32)
        (param $italic i32) (result i32)
    (local $hash i32) (local $byte i32)
    (local.set $hash (i32.const 0x811C9DC5))
    (block $done (loop $scan
      (local.set $byte (i32.load8_u (local.get $name)))
      (br_if $done (i32.eqz (local.get $byte)))
      (local.set $hash (i32.mul
        (i32.xor (local.get $hash) (call $tt_subst_fold (local.get $byte)))
        (i32.const 16777619)))
      (local.set $name (i32.add (local.get $name) (i32.const 1)))
      (br $scan)))
    (local.set $hash (i32.mul (i32.xor (local.get $hash) (local.get $ppem))
      (i32.const 16777619)))
    (local.set $hash (i32.mul (i32.xor (local.get $hash) (local.get $weight))
      (i32.const 16777619)))
    (local.set $hash (i32.mul (i32.xor (local.get $hash) (local.get $italic))
      (i32.const 16777619)))
    ;; Zero is the empty-slot marker in the strike table.
    (select (local.get $hash) (i32.const 1) (local.get $hash)))

  (func $tt_strike_find (param $hash i32) (result i32)
    (local $i i32) (local $record i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_BITMAP_FONT_COUNT)))
      (local.set $record (call $gdi_bitmap_font_record (local.get $i)))
      (if (i32.and (i32.ne (i32.load (local.get $record)) (i32.const 0))
            (i32.eq (i32.load offset=4 (local.get $record)) (local.get $hash)))
        (then (return (local.get $record))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; The strike for a LOGFONT, building it on first use. Returns a strike
  ;; record the ordinary bitmap text path can render from, or 0 when the face
  ;; has no scalable substitute and the caller should fall back as before.
  (func $tt_strike_ensure (param $name i32) (param $lf_height i32)
        (param $weight i32) (param $italic i32) (result i32)
    (local $face i32) (local $ppem i32) (local $hash i32) (local $found i32)
    (local $size i32) (local $buffer_guest i32) (local $buffer i32)
    (local $written i32) (local $ok i32)
    (if (i32.eqz (local.get $name)) (then (return (i32.const 0))))
    (local.set $face (call $tt_face_for_logfont (local.get $name)
      (local.get $weight) (local.get $italic)))
    (if (i32.lt_s (local.get $face) (i32.const 0)) (then (return (i32.const 0))))
    (local.set $ppem (call $tt_face_ppem (local.get $face) (local.get $lf_height)))
    (if (i32.le_s (local.get $ppem) (i32.const 0)) (then (return (i32.const 0))))

    (local.set $hash (call $tt_strike_hash (local.get $name) (local.get $ppem)
      (local.get $weight) (local.get $italic)))
    (local.set $found (call $tt_strike_find (local.get $hash)))
    (if (local.get $found) (then (return (local.get $found))))

    (local.set $size (call $tt_fnt_size (local.get $face) (local.get $ppem)
      (call $tt_strlen (local.get $name))))
    (if (i32.eqz (local.get $size)) (then (return (i32.const 0))))
    (local.set $buffer_guest (call $heap_alloc (local.get $size)))
    (if (i32.eqz (local.get $buffer_guest)) (then (return (i32.const 0))))
    (local.set $buffer (call $g2w (local.get $buffer_guest)))
    (local.set $written (call $tt_fnt_build (local.get $face) (local.get $ppem)
      (local.get $name) (local.get $buffer) (local.get $size)))
    (if (i32.eqz (local.get $written))
      (then
        (call $heap_free (local.get $buffer_guest))
        (return (i32.const 0))))
    ;; The strike parser validates the image and takes its own copy into the
    ;; DIB arena, so this scratch is freed either way. Going through the same
    ;; validation as a real .FON is deliberate: a synthetic image that would
    ;; not survive it is a bug worth failing on, not one worth trusting.
    (local.set $ok (call $gdi_bitmap_font_copy_strike (local.get $buffer)
      (local.get $written) (local.get $hash)))
    (call $heap_free (local.get $buffer_guest))
    (if (i32.eqz (local.get $ok)) (then (return (i32.const 0))))
    (local.set $found (call $tt_strike_find (local.get $hash)))
    ;; Mark it state 2: installed strikes are state 1. A rasterized substitute
    ;; must be reachable only through its exact (face, size, weight, italic)
    ;; key, never through face-and-nearest-height matching, or the first size a
    ;; guest asks for would be bound to every later size of the same face. It
    ;; is also not an installed bitmap font, so it stays out of enumeration.
    (if (local.get $found)
      (then (i32.store (local.get $found) (i32.const 2))))
    (local.get $found))

  ;; ---- test surface -----------------------------------------------------
  ;;
  ;; Exported here rather than in 13-exports.wat so this layer stays a single
  ;; self-contained file. Parameters are WASM linear-memory pointers.

  (func (export "test_tt_is_truetype") (param i32) (param i32) (result i32)
    (call $tt_is_truetype (local.get 0) (local.get 1)))

  (func (export "test_tt_table_off") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_table_off (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_table_len") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_table_len (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_units_per_em") (param i32) (param i32) (result i32)
    (call $tt_units_per_em (local.get 0) (local.get 1)))

  (func (export "test_tt_index_to_loc_format") (param i32) (param i32) (result i32)
    (call $tt_index_to_loc_format (local.get 0) (local.get 1)))

  (func (export "test_tt_num_glyphs") (param i32) (param i32) (result i32)
    (call $tt_num_glyphs (local.get 0) (local.get 1)))

  (func (export "test_tt_ascender") (param i32) (param i32) (result i32)
    (call $tt_ascender (local.get 0) (local.get 1)))

  (func (export "test_tt_descender") (param i32) (param i32) (result i32)
    (call $tt_descender (local.get 0) (local.get 1)))

  (func (export "test_tt_line_gap") (param i32) (param i32) (result i32)
    (call $tt_line_gap (local.get 0) (local.get 1)))

  (func (export "test_tt_num_h_metrics") (param i32) (param i32) (result i32)
    (call $tt_num_h_metrics (local.get 0) (local.get 1)))

  (func (export "test_tt_weight_class") (param i32) (param i32) (result i32)
    (call $tt_weight_class (local.get 0) (local.get 1)))

  (func (export "test_tt_win_ascent") (param i32) (param i32) (result i32)
    (call $tt_win_ascent (local.get 0) (local.get 1)))

  (func (export "test_tt_win_descent") (param i32) (param i32) (result i32)
    (call $tt_win_descent (local.get 0) (local.get 1)))

  (func (export "test_tt_x_height") (param i32) (param i32) (result i32)
    (call $tt_x_height (local.get 0) (local.get 1)))

  (func (export "test_tt_cap_height") (param i32) (param i32) (result i32)
    (call $tt_cap_height (local.get 0) (local.get 1)))

  (func (export "test_tt_is_italic") (param i32) (param i32) (result i32)
    (call $tt_is_italic (local.get 0) (local.get 1)))

  (func (export "test_tt_cmap_is_symbol") (param i32) (param i32) (result i32)
    (call $tt_cmap_is_symbol (local.get 0) (local.get 1)))

  (func (export "test_tt_glyph_index") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_glyph_index (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_advance_fu") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_advance_fu (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_lsb_fu") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_lsb_fu (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_scale") (param i32) (param i32) (param i32) (result i32)
    (call $tt_scale (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_char_advance_px") (param i32) (param i32) (param i32)
        (param i32) (result i32)
    (call $tt_char_advance_px (local.get 0) (local.get 1) (local.get 2)
      (local.get 3)))

  (func (export "test_tt_text_width_px") (param i32) (param i32) (param i32)
        (param i32) (param i32) (result i32)
    (call $tt_text_width_px (local.get 0) (local.get 1) (local.get 2)
      (local.get 3) (local.get 4)))

  (func (export "test_tt_cp1252_to_unicode") (param i32) (result i32)
    (call $tt_cp1252_to_unicode (local.get 0)))

  (func (export "test_tt_ansi_glyph_index") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_ansi_glyph_index (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_ansi_advance_px") (param i32) (param i32) (param i32)
        (param i32) (result i32)
    (call $tt_ansi_advance_px (local.get 0) (local.get 1) (local.get 2)
      (local.get 3)))

  (func (export "test_tt_is_fixed_pitch") (param i32) (param i32) (result i32)
    (call $tt_is_fixed_pitch (local.get 0) (local.get 1)))

  (func (export "test_tt_ppem_from_lfheight") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_ppem_from_lfheight (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_tm_ascent") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_tm_ascent (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_tm_descent") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_tm_descent (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_tm_height") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_tm_height (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_tm_internal_leading") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_tm_internal_leading (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_tm_external_leading") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_tm_external_leading (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_tm_ave_char_width") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_tm_ave_char_width (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_tm_max_char_width") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_tm_max_char_width (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_tm_weight") (param i32) (param i32) (result i32)
    (call $tt_tm_weight (local.get 0) (local.get 1)))

  (func (export "test_tt_tm_pitch_and_family") (param i32) (param i32) (result i32)
    (call $tt_tm_pitch_and_family (local.get 0) (local.get 1)))

  (func (export "test_tt_tm_first_char") (param i32) (param i32) (result i32)
    (call $tt_tm_first_char (local.get 0) (local.get 1)))

  (func (export "test_tt_tm_last_char") (param i32) (param i32) (result i32)
    (call $tt_tm_last_char (local.get 0) (local.get 1)))

  (func (export "test_tt_glyph_offset") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_glyph_offset (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_glyph_length") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_glyph_length (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_glyph_num_contours") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_glyph_num_contours (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_glyph_is_composite") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_glyph_is_composite (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_glyph_x_min") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_glyph_x_min (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_glyph_y_min") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_glyph_y_min (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_glyph_x_max") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_glyph_x_max (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_glyph_y_max") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_glyph_y_max (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_abc_a_fu") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_abc_a_fu (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_abc_b_fu") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_abc_b_fu (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_abc_c_fu") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_abc_c_fu (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_glyph_point_count") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_glyph_point_count (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_glyph_load_points") (param i32) (param i32) (param i32)
        (param i32) (param i32) (result i32)
    (call $tt_glyph_load_points (local.get 0) (local.get 1) (local.get 2)
      (local.get 3) (local.get 4)))

  (func (export "test_tt_glyph_load_outline") (param i32) (param i32) (param i32)
        (param i32) (param i32) (result i32)
    (call $tt_glyph_load_outline (local.get 0) (local.get 1) (local.get 2)
      (local.get 3) (local.get 4) (i32.const 0)))

  (func (export "test_tt_fu_to_26_6") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_fu_to_26_6 (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_glyph_edges") (param i32) (param i32) (param i32)
        (param i32) (param i32) (param i32) (param i32) (param i32) (result i32)
    (call $tt_glyph_edges (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (local.get 4) (local.get 5) (local.get 6) (local.get 7)))

  (func (export "test_tt_edge_field") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_edge_field (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_face_open") (param i32) (result i32)
    (call $tt_face_open (local.get 0)))

  (func (export "test_tt_face_size") (param i32) (result i32)
    (call $tt_face_size (local.get 0)))

  (func (export "test_tt_face_metric") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_face_metric (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_face_ppem") (param i32) (param i32) (result i32)
    (call $tt_face_ppem (local.get 0) (local.get 1)))

  (func (export "test_tt_face_text_width") (param i32) (param i32) (param i32)
        (param i32) (result i32)
    (call $tt_face_text_width (local.get 0) (local.get 1) (local.get 2)
      (local.get 3)))

  (func (export "test_tt_face_char_width") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_face_char_width (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_face_glyph") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_face_glyph (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_entry_width") (param i32) (result i32)
    (call $tt_entry_width (local.get 0)))

  (func (export "test_tt_entry_height") (param i32) (result i32)
    (call $tt_entry_height (local.get 0)))

  (func (export "test_tt_entry_left") (param i32) (result i32)
    (call $tt_entry_left (local.get 0)))

  (func (export "test_tt_entry_top") (param i32) (result i32)
    (call $tt_entry_top (local.get 0)))

  (func (export "test_tt_entry_pixel") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_entry_pixel (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_cache_used") (result i32)
    (global.get $tt_cache_used))

  (func (export "test_tt_cache_flush")
    (call $tt_cache_flush))

  (func (export "test_tt_raster_scratch_bytes") (param i32) (result i32)
    (call $tt_raster_scratch_bytes (local.get 0)))

  (func (export "test_tt_glyph_box_left") (param i32) (param i32) (param i32)
        (param i32) (result i32)
    (call $tt_glyph_box_left (local.get 0) (local.get 1) (local.get 2)
      (local.get 3)))

  (func (export "test_tt_glyph_box_top") (param i32) (param i32) (param i32)
        (param i32) (result i32)
    (call $tt_glyph_box_top (local.get 0) (local.get 1) (local.get 2)
      (local.get 3)))

  (func (export "test_tt_glyph_box_width") (param i32) (param i32) (param i32)
        (param i32) (result i32)
    (call $tt_glyph_box_width (local.get 0) (local.get 1) (local.get 2)
      (local.get 3)))

  (func (export "test_tt_glyph_box_height") (param i32) (param i32) (param i32)
        (param i32) (result i32)
    (call $tt_glyph_box_height (local.get 0) (local.get 1) (local.get 2)
      (local.get 3)))

  (func (export "test_tt_rasterize_glyph") (param i32) (param i32) (param i32)
        (param i32) (param i32) (param i32) (param i32) (param i32) (param i32)
        (param i32) (param i32) (result i32)
    (call $tt_rasterize_glyph (local.get 0) (local.get 1) (local.get 2)
      (local.get 3) (local.get 4) (local.get 5) (local.get 6) (local.get 7)
      (local.get 8) (local.get 9) (local.get 10)))

  (func (export "test_tt_bitmap_pixel") (param i32) (param i32) (param i32)
        (param i32) (result i32)
    (call $tt_bitmap_pixel (local.get 0) (local.get 1) (local.get 2)
      (local.get 3)))

  (func (export "test_tt_point_x") (param i32) (param i32) (result i32)
    (call $tt_point_x (local.get 0) (local.get 1)))

  (func (export "test_tt_point_y") (param i32) (param i32) (result i32)
    (call $tt_point_y (local.get 0) (local.get 1)))

  (func (export "test_tt_point_on_curve") (param i32) (param i32) (result i32)
    (call $tt_point_on_curve (local.get 0) (local.get 1)))

  (func (export "test_tt_point_ends_contour") (param i32) (param i32) (result i32)
    (call $tt_point_ends_contour (local.get 0) (local.get 1)))

  (func (export "test_tt_kern_pair_fu") (param i32) (param i32) (param i32)
        (param i32) (result i32)
    (call $tt_kern_pair_fu (local.get 0) (local.get 1) (local.get 2)
      (local.get 3)))

  (func (export "test_tt_kern_pair_px") (param i32) (param i32) (param i32)
        (param i32) (param i32) (result i32)
    (call $tt_kern_pair_px (local.get 0) (local.get 1) (local.get 2)
      (local.get 3) (local.get 4)))

  (func (export "test_tt_subst_path") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_subst_path (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_face_for_logfont") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_face_for_logfont (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_fnt_size") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_fnt_size (local.get 0) (local.get 1) (local.get 2)))

  (func (export "test_tt_fnt_build") (param i32) (param i32) (param i32)
        (param i32) (param i32) (result i32)
    (call $tt_fnt_build (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (local.get 4)))

  (func (export "test_tt_strike_ensure") (param i32) (param i32) (param i32)
        (param i32) (result i32)
    (call $tt_strike_ensure (local.get 0) (local.get 1) (local.get 2)
      (local.get 3)))

  (func (export "test_tt_family_name") (param i32) (param i32) (param i32)
        (param i32) (result i32)
    (call $tt_family_name (local.get 0) (local.get 1) (local.get 2)
      (local.get 3)))

  (func (export "test_tt_reg_path") (param i32) (param i32) (param i32)
        (result i32)
    (call $tt_reg_path (local.get 0) (local.get 1) (local.get 2)))





