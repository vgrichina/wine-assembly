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

  ;; ---- loca / glyf ------------------------------------------------------
  ;;
  ;; `loca` holds numGlyphs+1 offsets into `glyf`, either as u16 halves (short
  ;; format) or u32 (long). Consecutive equal entries mean the glyph has no
  ;; outline at all, which is how space is stored: an empty glyph is normal
  ;; data, not a damaged file, and it still has an advance.
  ;;
  ;; Only the glyph record's header is read here — bounds and contour count.
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
  ;; a horizontal edge has no crossing to contribute — keeping them would only
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

  ;; ---- ABC widths -------------------------------------------------------
  ;;
  ;; GetCharABCWidths splits the advance into left bearing, black width, and
  ;; right bearing. A and C are signed and routinely negative — 'j' overhangs
  ;; to its left, italic faces overhang to their right — and code that clamps
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
