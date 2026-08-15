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
