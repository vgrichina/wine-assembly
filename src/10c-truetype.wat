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
          (call $tt_glyph_index (local.get $data) (local.get $size)
            (i32.load8_u (i32.add (local.get $text) (local.get $index)))))))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $scan)))
    (call $tt_scale (local.get $total) (local.get $ppem)
      (call $tt_units_per_em (local.get $data) (local.get $size))))

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
