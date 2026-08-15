  ;; ---- WAT-native WinHelp typed topic layout ------------------------

  ;; A positioned run is 40 bytes:
  ;;   kind, x, y, width, height, raw_off, raw_len, font_index, color, flags.
  ;; Text offsets remain relative to the immutable decoded LinkData2 arena.
  (global $HELP_LAYOUT_RUN_SIZE i32 (i32.const 40))
  (global $HELP_MAX_LAYOUT_RUNS i32 (i32.const 131072))
  (global $HELP_LAYOUT_TEXT i32 (i32.const 1))
  (global $HELP_LAYOUT_SPACE i32 (i32.const 2))
  (global $HELP_LAYOUT_BITMAP i32 (i32.const 9))

  (global $help_view_tokens_ga (mut i32) (i32.const 0))
  (global $help_view_tokens_wa (mut i32) (i32.const 0))
  (global $help_view_token_count (mut i32) (i32.const 0))
  (global $help_view_payload_ga (mut i32) (i32.const 0))
  (global $help_view_payload_wa (mut i32) (i32.const 0))
  (global $help_view_payload_len (mut i32) (i32.const 0))
  (global $help_view_runs_ga (mut i32) (i32.const 0))
  (global $help_view_runs_wa (mut i32) (i32.const 0))
  (global $help_view_run_count (mut i32) (i32.const 0))
  (global $help_view_extent_height (mut i32) (i32.const 0))
  (global $help_view_layout_width (mut i32) (i32.const 0))
  (global $help_view_bitmap_handles_ga (mut i32) (i32.const 0))
  (global $help_view_bitmap_handles_wa (mut i32) (i32.const 0))
  (global $help_view_bitmap_slot_count (mut i32) (i32.const 0))
  (global $help_view_bitmap_materialized_count (mut i32) (i32.const 0))
  (global $help_view_bitmap_dc (mut i32) (i32.const 0))
  (global $help_view_font_handles_ga (mut i32) (i32.const 0))
  (global $help_view_font_handles_wa (mut i32) (i32.const 0))
  (global $help_view_font_slot_count (mut i32) (i32.const 0))
  (global $help_view_font_materialized_count (mut i32) (i32.const 0))
  (global $help_view_font_hdc (mut i32) (i32.const 0))

  ;; A context popup owns a second top-level surface and typed view. The main
  ;; view is detached, rather than freed/re-decoded, while the popup is live.
  ;; This keeps dismissal transactional even when the retained view owns fonts,
  ;; bitmaps, a source DC, scroll state, and a populated Back stack.
  (global $help_popup_hwnd (mut i32) (i32.const 0))
  (global $help_popup_shadow_hwnd (mut i32) (i32.const 0))
  (global $help_popup_width (mut i32) (i32.const 0))
  (global $help_popup_height (mut i32) (i32.const 0))
  (global $help_popup_anchor_x (mut i32) (i32.const 180))
  (global $help_popup_anchor_y (mut i32) (i32.const 110))
  (global $help_popup_saved_valid (mut i32) (i32.const 0))
  (global $help_popup_saved_session_valid (mut i32) (i32.const 0))
  (global $help_popup_saved_doc_wa (mut i32) (i32.const 0))
  (global $help_popup_saved_topic_ref (mut i32) (i32.const -1))
  (global $help_popup_saved_topic_index (mut i32) (i32.const -1))
  (global $help_popup_saved_mode (mut i32) (i32.const 0))
  (global $help_popup_saved_command (mut i32) (i32.const 0))
  (global $help_popup_saved_status (mut i32) (i32.const 0))
  (global $help_popup_saved_cur_topic (mut i32) (i32.const 0))
  (global $help_popup_saved_scroll_y (mut i32) (i32.const 0))
  (global $help_popup_saved_back_count (mut i32) (i32.const 0))
  (global $help_popup_saved_topic_wa (mut i32) (i32.const 0))
  (global $help_popup_saved_topic_len (mut i32) (i32.const 0))
  (global $help_popup_saved_tokens_ga (mut i32) (i32.const 0))
  (global $help_popup_saved_tokens_wa (mut i32) (i32.const 0))
  (global $help_popup_saved_token_count (mut i32) (i32.const 0))
  (global $help_popup_saved_payload_ga (mut i32) (i32.const 0))
  (global $help_popup_saved_payload_wa (mut i32) (i32.const 0))
  (global $help_popup_saved_payload_len (mut i32) (i32.const 0))
  (global $help_popup_saved_runs_ga (mut i32) (i32.const 0))
  (global $help_popup_saved_runs_wa (mut i32) (i32.const 0))
  (global $help_popup_saved_run_count (mut i32) (i32.const 0))
  (global $help_popup_saved_extent_height (mut i32) (i32.const 0))
  (global $help_popup_saved_layout_width (mut i32) (i32.const 0))
  (global $help_popup_saved_bitmap_handles_ga (mut i32) (i32.const 0))
  (global $help_popup_saved_bitmap_handles_wa (mut i32) (i32.const 0))
  (global $help_popup_saved_bitmap_slot_count (mut i32) (i32.const 0))
  (global $help_popup_saved_bitmap_count (mut i32) (i32.const 0))
  (global $help_popup_saved_bitmap_dc (mut i32) (i32.const 0))
  (global $help_popup_saved_font_handles_ga (mut i32) (i32.const 0))
  (global $help_popup_saved_font_handles_wa (mut i32) (i32.const 0))
  (global $help_popup_saved_font_slot_count (mut i32) (i32.const 0))
  (global $help_popup_saved_font_count (mut i32) (i32.const 0))
  (global $help_popup_saved_font_hdc (mut i32) (i32.const 0))
  ;; -1 for same-document popups; otherwise the snapshot depth that existed
  ;; before an external popup suspended its source document.
  (global $help_popup_external_snapshot_base (mut i32) (i32.const -1))

  ;; Private result channel used while a replacement view is still local.
  (global $help_materialize_bitmap_dc (mut i32) (i32.const 0))
  (global $help_materialize_bitmap_count (mut i32) (i32.const 0))
  (global $help_materialize_font_count (mut i32) (i32.const 0))

  ;; Private two-pass layout channel. A zero output pointer counts and
  ;; validates exact run requirements without writing any records.
  (global $help_layout_out (mut i32) (i32.const 0))
  (global $help_layout_capacity (mut i32) (i32.const 0))
  (global $help_layout_count (mut i32) (i32.const 0))
  (global $help_layout_extent (mut i32) (i32.const 0))

  ;; Result channel for one retained PARAGRAPH header. Token slices point
  ;; directly at the exact header; value low 24 bits points at its complete
  ;; LinkData1 record so table columns remain available without rescanning
  ;; intervening character commands.
  (global $help_para_left (mut i32) (i32.const 0))
  (global $help_para_right (mut i32) (i32.const 0))
  (global $help_para_first (mut i32) (i32.const 0))
  (global $help_para_above (mut i32) (i32.const 0))
  (global $help_para_below (mut i32) (i32.const 0))
  (global $help_para_lines (mut i32) (i32.const 0))
  (global $help_para_align (mut i32) (i32.const 0))
  (global $help_para_cell_left (mut i32) (i32.const 8))
  (global $help_para_cell_right (mut i32) (i32.const 392))
  (global $help_para_tabs (mut i32) (i32.const 0))
  (global $help_para_tab_count (mut i32) (i32.const 0))
  (global $help_para_tabs_end (mut i32) (i32.const 0))

  (func $help_layout_metric_pixels (param $value i32) (result i32)
    (local $negative i32) (local $magnitude i32) (local $denominator i32)
    (if (i32.lt_s (local.get $value) (i32.const 0))
      (then
        (local.set $negative (i32.const 1))
        (local.set $magnitude (i32.sub (i32.const 0) (local.get $value))))
      (else (local.set $magnitude (local.get $value))))
    (local.set $denominator
      (select (i32.const 1440) (i32.const 144)
        (i32.ne (global.get $help_doc_font_metric_mode) (i32.const 0))))
    (local.set $magnitude (i32.div_u
      (i32.add (i32.mul (local.get $magnitude) (i32.const 96))
        (i32.shr_u (local.get $denominator) (i32.const 1)))
      (local.get $denominator)))
    (if (result i32) (local.get $negative)
      (then (i32.sub (i32.const 0) (local.get $magnitude)))
      (else (local.get $magnitude))))

  (func $help_layout_table_scale
    (param $value i32) (param $available i32) (result i32)
    (local $product i64)
    (local.set $product (i64.mul (i64.extend_i32_s (local.get $value))
      (i64.extend_i32_s (local.get $available))))
    (i32.wrap_i64 (i64.div_s
      (i64.add (local.get $product)
        (select (i64.const 16383) (i64.const -16383)
          (i64.ge_s (local.get $product) (i64.const 0))))
      (i64.const 32767))))

  (func $help_layout_decode_paragraph
    (param $payload i32) (param $payload_len i32)
    (param $off i32) (param $len i32) (param $value i32)
    (param $client_width i32) (result i32)
    (local $ptr i32) (local $end i32) (local $record i32) (local $record_end i32)
    (local $record_type i32) (local $columns i32) (local $table_type i32)
    (local $column_data i32) (local $column i32) (local $flags i32)
    (local $bit i32) (local $metric i32) (local $tab_count i32)
    (local $i i32) (local $tab i32) (local $gap i32) (local $width i32)
    (local $cursor i32) (local $available i32) (local $left i32)
    (local $min_width i32)
    (global.set $help_para_left (i32.const 0))
    (global.set $help_para_right (i32.const 0))
    (global.set $help_para_first (i32.const 0))
    (global.set $help_para_above (i32.const 0))
    (global.set $help_para_below (i32.const 0))
    (global.set $help_para_lines (i32.const 0))
    (global.set $help_para_align (i32.const 0))
    (global.set $help_para_cell_left (i32.const 8))
    (global.set $help_para_cell_right (i32.sub (local.get $client_width) (i32.const 8)))
    (global.set $help_para_tabs (i32.const 0))
    (global.set $help_para_tab_count (i32.const 0))
    (global.set $help_para_tabs_end (i32.const 0))
    (if (i32.or (i32.gt_u (local.get $off) (local.get $payload_len))
          (i32.gt_u (local.get $len) (i32.sub (local.get $payload_len) (local.get $off))))
      (then (return (i32.const 0))))
    (local.set $ptr (i32.add (local.get $payload) (local.get $off)))
    (local.set $end (i32.add (local.get $ptr) (local.get $len)))
    (local.set $record_type (i32.shr_u (local.get $value) (i32.const 24)))
    (local.set $record (i32.add (local.get $payload)
      (i32.and (local.get $value) (i32.const 0x00FFFFFF))))
    (local.set $record_end (i32.add (local.get $payload) (local.get $payload_len)))
    (if (i32.or (i32.lt_u (local.get $record) (local.get $payload))
          (i32.ge_u (local.get $record) (local.get $record_end)))
      (then (return (i32.const 0))))
    (if (i32.eqz (call $help_ld1_read_clong (local.get $record) (local.get $record_end)))
      (then (return (i32.const 0))))
    (local.set $record (global.get $help_ld1_next))
    (if (i32.or (i32.eq (local.get $record_type) (i32.const 0x20))
          (i32.eq (local.get $record_type) (i32.const 0x23)))
      (then
        (if (i32.eqz (call $help_ld1_read_cu16 (local.get $record) (local.get $record_end)))
          (then (return (i32.const 0))))
        (local.set $record (global.get $help_ld1_next))))
    (if (i32.eq (local.get $record_type) (i32.const 0x23))
      (then
        (if (i32.gt_u (i32.const 2) (i32.sub (local.get $record_end) (local.get $record)))
          (then (return (i32.const 0))))
        (local.set $columns (i32.load8_u (local.get $record)))
        (local.set $table_type (i32.load8_u offset=1 (local.get $record)))
        (local.set $record (i32.add (local.get $record) (i32.const 2)))
        (if (i32.or (i32.eqz (local.get $columns))
              (i32.gt_u (local.get $table_type) (i32.const 3)))
          (then (return (i32.const 0))))
        (if (i32.or (i32.eq (local.get $table_type) (i32.const 0))
              (i32.eq (local.get $table_type) (i32.const 2)))
          (then
            (if (i32.gt_u (i32.const 2) (i32.sub (local.get $record_end) (local.get $record)))
              (then (return (i32.const 0))))
            (local.set $min_width (call $help_layout_metric_pixels
              (i32.load16_s (local.get $record))))
            (local.set $record (i32.add (local.get $record) (i32.const 2)))))
        (local.set $column_data (local.get $record))
        (if (i32.gt_u (i32.mul (local.get $columns) (i32.const 4))
              (i32.sub (local.get $record_end) (local.get $column_data)))
          (then (return (i32.const 0))))
        (if (i32.gt_u (i32.const 5) (i32.sub (local.get $end) (local.get $ptr)))
          (then (return (i32.const 0))))
        (local.set $column (i32.load16_s (local.get $ptr)))
        (if (i32.or (i32.lt_s (local.get $column) (i32.const 0))
              (i32.ge_u (local.get $column) (local.get $columns)))
          (then (return (i32.const 0))))
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 5)))
        (local.set $available (i32.sub (local.get $client_width) (i32.const 16)))
        (if (i32.gt_s (local.get $min_width) (local.get $available))
          (then (local.set $available (local.get $min_width))))
        (local.set $cursor (i32.const 0))
        (local.set $i (i32.const 0))
        (block $columns_done (loop $columns_loop
          (br_if $columns_done (i32.gt_u (local.get $i) (local.get $column)))
          ;; Each column record is { width, gap }, in that order. It was read
          ;; the other way round, which made notepad.hlp's first two topics -
          ;; both single-column tables holding the whole topic - come out as a
          ;; 437-unit gap in front of a 1-unit-wide cell. A cell narrower than
          ;; its own margins fails the margin check below, so layout rejected
          ;; the entire topic and notepad's help opened on its third topic.
          (local.set $width (i32.load16_s (i32.add (local.get $column_data)
            (i32.mul (local.get $i) (i32.const 4)))))
          (local.set $gap (i32.load16_s (i32.add (local.get $column_data)
            (i32.add (i32.mul (local.get $i) (i32.const 4)) (i32.const 2)))))
          (if (i32.eq (local.get $i) (local.get $column))
            (then
              (local.set $left (i32.add (local.get $cursor) (local.get $gap)))
              (br $columns_done)))
          (local.set $cursor (i32.add (local.get $cursor)
            (i32.add (local.get $gap) (local.get $width))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $columns_loop)))
        (if (i32.or (i32.eq (local.get $table_type) (i32.const 0))
              (i32.eq (local.get $table_type) (i32.const 2)))
          (then
            (global.set $help_para_cell_left (i32.add (i32.const 8)
              (call $help_layout_table_scale (local.get $left) (local.get $available))))
            (global.set $help_para_cell_right (i32.add (global.get $help_para_cell_left)
              (call $help_layout_table_scale (local.get $width) (local.get $available)))))
          (else
            (global.set $help_para_cell_left (i32.add (i32.const 8)
              (call $help_layout_metric_pixels (local.get $left))))
            (global.set $help_para_cell_right (i32.add (global.get $help_para_cell_left)
              (call $help_layout_metric_pixels (local.get $width))))))))
    (if (i32.gt_u (i32.const 6) (i32.sub (local.get $end) (local.get $ptr)))
      (then (return (i32.const 0))))
    (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
    (local.set $flags (i32.load16_u (local.get $ptr)))
    (local.set $ptr (i32.add (local.get $ptr) (i32.const 2)))
    (if (i32.and (local.get $flags) (i32.const 1))
      (then
        (if (i32.eqz (call $help_ld1_read_clong (local.get $ptr) (local.get $end)))
          (then (return (i32.const 0))))
        (local.set $ptr (global.get $help_ld1_next))))
    (local.set $bit (i32.const 2))
    (block $metrics_done (loop $metrics
      (br_if $metrics_done (i32.gt_u (local.get $bit) (i32.const 0x40)))
      (if (i32.and (local.get $flags) (local.get $bit))
        (then
          (if (i32.eqz (call $help_ld1_read_ci16 (local.get $ptr) (local.get $end)))
            (then (return (i32.const 0))))
          (local.set $metric (call $help_layout_metric_pixels
            (global.get $help_ld1_value)))
          (if (i32.eq (local.get $bit) (i32.const 2))
            (then (global.set $help_para_above (local.get $metric))))
          (if (i32.eq (local.get $bit) (i32.const 4))
            (then (global.set $help_para_below (local.get $metric))))
          (if (i32.eq (local.get $bit) (i32.const 8))
            (then (global.set $help_para_lines (local.get $metric))))
          (if (i32.eq (local.get $bit) (i32.const 0x10))
            (then (global.set $help_para_left (local.get $metric))))
          (if (i32.eq (local.get $bit) (i32.const 0x20))
            (then (global.set $help_para_right (local.get $metric))))
          (if (i32.eq (local.get $bit) (i32.const 0x40))
            (then (global.set $help_para_first (local.get $metric))))
          (local.set $ptr (global.get $help_ld1_next))))
      (local.set $bit (i32.shl (local.get $bit) (i32.const 1)))
      (br $metrics)))
    (if (i32.and (local.get $flags) (i32.const 0x0100))
      (then
        (if (i32.gt_u (i32.const 3) (i32.sub (local.get $end) (local.get $ptr)))
          (then (return (i32.const 0))))
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 3)))))
    (if (i32.and (local.get $flags) (i32.const 0x0200))
      (then
        (if (i32.eqz (call $help_ld1_read_ci16 (local.get $ptr) (local.get $end)))
          (then (return (i32.const 0))))
        (local.set $tab_count (global.get $help_ld1_value))
        (local.set $ptr (global.get $help_ld1_next))
        (if (i32.lt_s (local.get $tab_count) (i32.const 0))
          (then (return (i32.const 0))))
        (global.set $help_para_tabs (local.get $ptr))
        (global.set $help_para_tab_count (local.get $tab_count))
        (local.set $i (i32.const 0))
        (block $tabs_done (loop $tabs
          (br_if $tabs_done (i32.ge_u (local.get $i) (local.get $tab_count)))
          (if (i32.eqz (call $help_ld1_read_cu16 (local.get $ptr) (local.get $end)))
            (then (return (i32.const 0))))
          (local.set $tab (global.get $help_ld1_value))
          (local.set $ptr (global.get $help_ld1_next))
          (if (i32.and (local.get $tab) (i32.const 0x4000))
            (then
              (if (i32.eqz (call $help_ld1_read_cu16 (local.get $ptr) (local.get $end)))
                (then (return (i32.const 0))))
              (local.set $ptr (global.get $help_ld1_next))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $tabs)))
        (global.set $help_para_tabs_end (local.get $ptr))))
    (if (i32.and (local.get $flags) (i32.const 0x0400))
      (then (global.set $help_para_align (i32.const 1))))
    (if (i32.and (local.get $flags) (i32.const 0x0800))
      (then (global.set $help_para_align (i32.const 2))))
    ;; 0x1000 is RTF-style "keep with next"; a continuously scrolling topic
    ;; has no page boundary at which that pagination hint can take effect.
    (i32.eq (local.get $ptr) (local.get $end)))

  (func $help_layout_emit
    (param $kind i32) (param $x i32) (param $y i32)
    (param $width i32) (param $height i32)
    (param $raw_off i32) (param $raw_len i32)
    (param $font_index i32) (param $color i32) (param $flags i32)
    (result i32)
    (local $run i32)
    (if (i32.ge_u (global.get $help_layout_count)
          (global.get $help_layout_capacity))
      (then (return (i32.const 0))))
    (if (global.get $help_layout_out)
      (then
        (local.set $run (i32.add (global.get $help_layout_out)
          (i32.mul (global.get $help_layout_count)
            (global.get $HELP_LAYOUT_RUN_SIZE))))
        (i32.store (local.get $run) (local.get $kind))
        (i32.store offset=4 (local.get $run) (local.get $x))
        (i32.store offset=8 (local.get $run) (local.get $y))
        (i32.store offset=12 (local.get $run) (local.get $width))
        (i32.store offset=16 (local.get $run) (local.get $height))
        (i32.store offset=20 (local.get $run) (local.get $raw_off))
        (i32.store offset=24 (local.get $run) (local.get $raw_len))
        (i32.store offset=28 (local.get $run) (local.get $font_index))
        (i32.store offset=32 (local.get $run) (local.get $color))
        ;; Low 28 bits retain hotspot begin-token identity. High bits retain
        ;; decorations so a failed replacement can keep painting the prior
        ;; view without consulting the newly loaded document's FONT table.
        (if (i32.lt_u (local.get $font_index) (global.get $help_doc_font_count))
          (then
            (local.set $flags (i32.or (local.get $flags)
              (i32.shl
                (i32.and (i32.load offset=12
                  (i32.add (global.get $help_doc_fonts_wa)
                    (i32.mul (local.get $font_index) (global.get $HELP_FONT_SIZE))))
                  (i32.const 0x0C))
                (i32.const 28))))))
        (i32.store offset=36 (local.get $run) (local.get $flags))))
    (global.set $help_layout_count
      (i32.add (global.get $help_layout_count) (i32.const 1)))
    (i32.const 1))

  (func $help_font_pixel_height (param $font_index i32) (result i32)
    (local $font i32) (local $height i32)
    (if (i32.ge_u (local.get $font_index) (global.get $help_doc_font_count))
      (then (return (i32.const 16))))
    (local.set $font (i32.add (global.get $help_doc_fonts_wa)
      (i32.mul (local.get $font_index) (global.get $HELP_FONT_SIZE))))
    (local.set $height (i32.load offset=4 (local.get $font)))
    (if (i32.lt_s (local.get $height) (i32.const 0))
      (then (local.set $height (i32.sub (i32.const 0) (local.get $height)))))
    (if (global.get $help_doc_font_metric_mode)
      (then
        ;; MVB heights are twips at 96 DPI.
        (local.set $height (i32.div_u
          (i32.add (i32.mul (local.get $height) (i32.const 96)) (i32.const 1439))
          (i32.const 1440))))
      (else
        ;; Older descriptors store half-points.
        (local.set $height (i32.div_u
          (i32.add (i32.mul (local.get $height) (i32.const 96)) (i32.const 143))
          (i32.const 144)))))
    (if (i32.lt_u (local.get $height) (i32.const 8))
      (then (local.set $height (i32.const 8))))
    (if (i32.gt_u (local.get $height) (i32.const 96))
      (then (local.set $height (i32.const 96))))
    (local.get $height))

  (func $help_layout_font_height (param $font_index i32) (result i32)
    (i32.add (call $help_font_pixel_height (local.get $font_index)) (i32.const 3)))

  (func $help_layout_select_font
    (param $hdc i32) (param $handles i32) (param $count i32)
    (param $font_index i32) (result i32)
    (local $handle i32) (local $metrics i32) (local $height i32)
    (if (i32.and (i32.ne (local.get $handles) (i32.const 0))
          (i32.lt_u (local.get $font_index) (local.get $count)))
      (then
        (local.set $handle (i32.load (i32.add (local.get $handles)
          (i32.shl (local.get $font_index) (i32.const 2)))))
        (if (local.get $handle)
          (then
            (drop (call $gdi_dc_select_owned_object
              (local.get $hdc) (local.get $handle)))
            (local.set $metrics (call $host_get_text_metrics (local.get $hdc)))
            (local.set $height (i32.and (local.get $metrics) (i32.const 0xFFFF)))
            (if (i32.and (i32.ge_u (local.get $height) (i32.const 1))
                  (i32.le_u (local.get $height) (i32.const 256)))
              (then (return (local.get $height))))))))
    (call $help_layout_font_height (local.get $font_index)))

  (func $help_layout_measure
    (param $hdc i32) (param $text i32) (param $length i32) (result i32)
    (local $width i32)
    (if (i32.eqz (local.get $length)) (then (return (i32.const 0))))
    (local.set $width (call $host_measure_text
      (local.get $hdc) (local.get $text) (local.get $length) (i32.const 0)))
    ;; Headless or not-yet-realized DCs still get deterministic geometry.
    (if (i32.le_s (local.get $width) (i32.const 0))
      (then (local.set $width (i32.mul (local.get $length) (i32.const 8)))))
    (local.get $width))

  (func $help_layout_fit_prefix
    (param $hdc i32) (param $text i32) (param $length i32)
    (param $available i32) (result i32)
    (local $lo i32) (local $hi i32) (local $mid i32) (local $width i32)
    (if (i32.eqz (local.get $length)) (then (return (i32.const 0))))
    (if (i32.le_s (local.get $available) (i32.const 0))
      (then (return (i32.const 1))))
    (local.set $lo (i32.const 1))
    (local.set $hi (local.get $length))
    (block $done (loop $search
      (br_if $done (i32.ge_u (local.get $lo) (local.get $hi)))
      (local.set $mid (i32.shr_u
        (i32.add (i32.add (local.get $lo) (local.get $hi)) (i32.const 1))
        (i32.const 1)))
      (local.set $width (call $help_layout_measure
        (local.get $hdc) (local.get $text) (local.get $mid)))
      (if (i32.le_u (local.get $width) (local.get $available))
        (then (local.set $lo (local.get $mid)))
        (else (local.set $hi (i32.sub (local.get $mid) (i32.const 1)))))
      (br $search)))
    (local.get $lo))

  (func $help_layout_align_line
    (param $first_run i32) (param $x i32) (param $right i32)
    (param $align i32)
    (local $shift i32) (local $i i32) (local $run i32)
    (if (i32.eqz (local.get $align)) (then (return)))
    (local.set $shift (i32.sub (local.get $right) (local.get $x)))
    (if (i32.lt_s (local.get $shift) (i32.const 0))
      (then (local.set $shift (i32.const 0))))
    (if (i32.eq (local.get $align) (i32.const 2))
      (then (local.set $shift (i32.shr_u (local.get $shift) (i32.const 1)))))
    (if (i32.or (i32.eqz (local.get $shift))
          (i32.eqz (global.get $help_layout_out)))
      (then (return)))
    (local.set $i (local.get $first_run))
    (block $done (loop $runs
      (br_if $done (i32.ge_u (local.get $i) (global.get $help_layout_count)))
      (local.set $run (i32.add (global.get $help_layout_out)
        (i32.mul (local.get $i) (global.get $HELP_LAYOUT_RUN_SIZE))))
      (i32.store offset=4 (local.get $run)
        (i32.add (i32.load offset=4 (local.get $run)) (local.get $shift)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $runs))))

  ;; RTF's paragraph \sl convention matches the retained WinHelp field:
  ;; positive values are a minimum line advance and negative values are exact.
  (func $help_layout_line_advance
    (param $line_height i32) (param $spacing i32) (result i32)
    (if (result i32) (i32.lt_s (local.get $spacing) (i32.const 0))
      (then (i32.sub (i32.const 0) (local.get $spacing)))
      (else (select (local.get $spacing) (local.get $line_height)
        (i32.gt_s (local.get $spacing) (local.get $line_height))))))

  (func $help_layout_tab_width
    (param $x i32) (param $base i32) (param $hdc i32)
    (param $raw i32) (param $tokens i32) (param $token_count i32)
    (param $token_index i32) (result i32)
    (local $ptr i32) (local $i i32) (local $encoded i32) (local $type i32)
    (local $target i32) (local $adjust i32) (local $next i32)
    (if (global.get $help_para_tab_count)
      (then
        (local.set $ptr (global.get $help_para_tabs))
        (block $done (loop $tabs
          (br_if $done (i32.ge_u (local.get $i) (global.get $help_para_tab_count)))
          (if (i32.eqz (call $help_ld1_read_cu16
                (local.get $ptr) (global.get $help_para_tabs_end)))
            (then (br $done)))
          (local.set $encoded (global.get $help_ld1_value))
          (local.set $ptr (global.get $help_ld1_next))
          (local.set $type (i32.const 0))
          (if (i32.and (local.get $encoded) (i32.const 0x4000))
            (then
              (if (i32.eqz (call $help_ld1_read_cu16
                    (local.get $ptr) (global.get $help_para_tabs_end)))
                (then (br $done)))
              (local.set $type (global.get $help_ld1_value))
              (local.set $ptr (global.get $help_ld1_next))))
          (local.set $target (i32.add (local.get $base)
            (call $help_layout_metric_pixels
              (i32.and (local.get $encoded) (i32.const 0x3FFF)))))
          (if (i32.gt_s (local.get $target) (local.get $x))
            (then
              (if (i32.and (i32.ne (local.get $type) (i32.const 0))
                    (i32.lt_u (i32.add (local.get $token_index) (i32.const 1))
                      (local.get $token_count)))
                (then
                  (local.set $next (i32.add (local.get $tokens)
                    (i32.mul (i32.add (local.get $token_index) (i32.const 1))
                      (global.get $HELP_TOPIC_TOKEN_SIZE))))
                  (if (i32.eq (i32.load (local.get $next)) (global.get $HELP_TOKEN_TEXT))
                    (then
                      (local.set $adjust (call $help_layout_measure
                        (local.get $hdc)
                        (i32.add (local.get $raw) (i32.load offset=4 (local.get $next)))
                        (i32.load offset=8 (local.get $next))))
                      (if (i32.eq (local.get $type) (i32.const 2))
                        (then (local.set $adjust
                          (i32.shr_u (local.get $adjust) (i32.const 1)))))))))
              (local.set $target (i32.sub (local.get $target) (local.get $adjust)))
              (if (i32.gt_s (local.get $target) (local.get $x))
                (then (return (i32.sub (local.get $target) (local.get $x)))))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $tabs)))))
    ;; WinHelp's default half-inch tab grid at 96 DPI.
    (local.set $target (i32.add (local.get $base)
      (i32.mul (i32.add
          (i32.div_u (i32.sub (local.get $x) (local.get $base)) (i32.const 48))
          (i32.const 1))
        (i32.const 48))))
    (i32.sub (local.get $target) (local.get $x)))

  ;; Layout rejects a topic by returning -1, and every rejection used to look
  ;; identical from the outside - a topic that would not render, with nothing
  ;; to say why. Each refusal now records a numbered reason and the token it
  ;; was looking at, readable through get_help_layout_fail_code /
  ;; get_help_layout_fail_token. Codes are positional within
  ;; $help_layout_tokens_core, in source order:
  ;;   1 bad width/token/run-capacity argument   2 raw/token/payload out of memory
  ;;   3 run buffer out of memory                4 END_TOPIC inside a hotspot
  ;;   5 paragraph record would not decode       6 paragraph margins invert
  ;;   7 font index out of range                 8 hotspot opens inside a hotspot
  ;;   9 hotspot ends with none open            10 run capacity, space token
  ;;  11 run capacity, bitmap token             12 text offset past raw buffer
  ;;  13 text length past raw buffer            14 run capacity, space in text
  ;;  15 run capacity, word in text             16 stream ended with no END_TOPIC
  (global $help_layout_fail_code (mut i32) (i32.const 0))
  (global $help_layout_fail_token (mut i32) (i32.const 0))

  (func $help_layout_fail (param $code i32) (param $token i32) (result i32)
    (global.set $help_layout_fail_code (local.get $code))
    (global.set $help_layout_fail_token (local.get $token))
    (i32.const -1))

  (func (export "test_help_para_metric") (param $which i32) (result i32)
    (if (i32.eq (local.get $which) (i32.const 0)) (then (return (global.get $help_para_left))))
    (if (i32.eq (local.get $which) (i32.const 1)) (then (return (global.get $help_para_right))))
    (if (i32.eq (local.get $which) (i32.const 2)) (then (return (global.get $help_para_first))))
    (if (i32.eq (local.get $which) (i32.const 3)) (then (return (global.get $help_para_cell_left))))
    (if (i32.eq (local.get $which) (i32.const 4)) (then (return (global.get $help_para_cell_right))))
    (i32.const 0))

  (func (export "get_help_layout_fail_code") (result i32)
    (global.get $help_layout_fail_code))
  (func (export "get_help_layout_fail_token") (result i32)
    (global.get $help_layout_fail_token))

  ;; Convert a validated formatted-token stream into deterministic positioned
  ;; runs. It owns wrapping, line state, font metadata, colors, and hotspot
  ;; membership; painting consumes the published records without reparsing.
  (func $help_layout_tokens_core
    (param $raw i32) (param $raw_len i32)
    (param $payload i32) (param $payload_len i32)
    (param $tokens i32) (param $token_count i32)
    (param $runs i32) (param $run_capacity i32)
    (param $client_width i32) (param $hdc i32)
    (param $font_handles i32) (param $font_count i32) (result i32)
    (local $memory_bytes i32) (local $token i32) (local $kind i32)
    (local $off i32) (local $len i32) (local $value i32)
    (local $i i32) (local $pos i32) (local $span i32) (local $ch i32)
    (local $x i32) (local $y i32) (local $right i32)
    (local $width i32) (local $height i32) (local $fit i32)
    (local $font_height i32) (local $line_height i32)
    (local $font_index i32) (local $color i32) (local $hotspot i32)
    (local $saw_content i32) (local $ended i32)
    (local $line_left i32) (local $continuation_left i32)
    (local $line_run_start i32) (local $paragraph_right i32)
    (local $paragraph_align i32) (local $paragraph_below i32)
    (local $paragraph_lines i32)
    (global.set $help_layout_count (i32.const 0))
    (global.set $help_layout_extent (i32.const 0))
    (global.set $help_layout_out (local.get $runs))
    (global.set $help_layout_capacity (local.get $run_capacity))
    ;; Counting and writing passes must start from identical default state;
    ;; the first pass may otherwise leave its final dynamic font selected.
    (if (local.get $font_handles)
      (then
        (drop (call $gdi_dc_set_field
          (local.get $hdc) (i32.const 88) (i32.const 0x3001D)
          (i32.const 0x3001D)))))
    (local.set $memory_bytes (i32.shl (memory.size) (i32.const 16)))
    (if (i32.or
          (i32.or (i32.lt_u (local.get $client_width) (i32.const 32))
                  (i32.gt_u (local.get $client_width) (i32.const 4096)))
          (i32.or
            (i32.gt_u (local.get $token_count) (global.get $HELP_MAX_TOPIC_TOKENS))
            (i32.gt_u (local.get $run_capacity) (global.get $HELP_MAX_LAYOUT_RUNS))))
      (then (return (call $help_layout_fail (i32.const 1) (local.get $i)))))
    (if (i32.or
          (i32.or
            (i32.or (i32.gt_u (local.get $raw) (local.get $memory_bytes))
                    (i32.gt_u (local.get $raw_len)
                      (i32.sub (local.get $memory_bytes) (local.get $raw))))
            (i32.or (i32.gt_u (local.get $tokens) (local.get $memory_bytes))
                    (i32.gt_u (local.get $token_count)
                      (i32.div_u (i32.sub (local.get $memory_bytes) (local.get $tokens))
                        (global.get $HELP_TOPIC_TOKEN_SIZE)))))
          (i32.or (i32.gt_u (local.get $payload) (local.get $memory_bytes))
                  (i32.gt_u (local.get $payload_len)
                    (i32.sub (local.get $memory_bytes) (local.get $payload)))))
      (then (return (call $help_layout_fail (i32.const 2) (local.get $i)))))
    (if (i32.and (local.get $runs)
          (i32.or (i32.gt_u (local.get $runs) (local.get $memory_bytes))
                  (i32.gt_u (local.get $run_capacity)
                    (i32.div_u (i32.sub (local.get $memory_bytes) (local.get $runs))
                      (global.get $HELP_LAYOUT_RUN_SIZE)))))
      (then (return (call $help_layout_fail (i32.const 3) (local.get $i)))))
    (local.set $x (i32.const 8))
    (local.set $y (i32.const 8))
    (local.set $right (i32.sub (local.get $client_width) (i32.const 8)))
    (local.set $line_left (i32.const 8))
    (local.set $continuation_left (i32.const 8))
    (local.set $paragraph_right (local.get $right))
    (local.set $font_height (i32.const 16))
    (local.set $line_height (i32.const 16))
    (local.set $font_index (i32.const -1))
    (local.set $color (i32.const 0))
    (block $done (loop $tokens_loop
      (br_if $done (i32.ge_u (local.get $i) (local.get $token_count)))
      (local.set $token (i32.add (local.get $tokens)
        (i32.mul (local.get $i) (global.get $HELP_TOPIC_TOKEN_SIZE))))
      (local.set $kind (i32.load (local.get $token)))
      (local.set $off (i32.load offset=4 (local.get $token)))
      (local.set $len (i32.load offset=8 (local.get $token)))
      (local.set $value (i32.load offset=12 (local.get $token)))
      (if (i32.eq (local.get $kind) (global.get $HELP_TOKEN_END_TOPIC))
        (then
          (if (local.get $hotspot) (then (return (call $help_layout_fail (i32.const 4) (local.get $i)))))
          (call $help_layout_align_line
            (local.get $line_run_start) (local.get $x)
            (local.get $paragraph_right) (local.get $paragraph_align))
          (local.set $ended (i32.const 1))
          (br $done)))
      (if (i32.eq (local.get $kind) (global.get $HELP_TOKEN_PARAGRAPH))
        (then
          (if (local.get $saw_content)
            (then
              (call $help_layout_align_line
                (local.get $line_run_start) (local.get $x)
                (local.get $paragraph_right) (local.get $paragraph_align))
              (local.set $y (i32.add (local.get $y)
                (i32.add
                  (call $help_layout_line_advance
                    (local.get $line_height) (local.get $paragraph_lines))
                  (local.get $paragraph_below))))))
          (if (i32.eqz (call $help_layout_decode_paragraph
                (local.get $payload) (local.get $payload_len)
                (local.get $off) (local.get $len) (local.get $value)
                (local.get $client_width)))
            (then (return (call $help_layout_fail (i32.const 5) (local.get $i)))))
          (local.set $y (i32.add (local.get $y) (global.get $help_para_above)))
          (local.set $continuation_left (i32.add (global.get $help_para_cell_left)
            (global.get $help_para_left)))
          (local.set $line_left (i32.add (local.get $continuation_left)
            (global.get $help_para_first)))
          (local.set $paragraph_right (i32.sub (global.get $help_para_cell_right)
            (global.get $help_para_right)))
          (if (i32.le_s (local.get $paragraph_right) (local.get $line_left))
            (then (return (call $help_layout_fail (i32.const 6) (local.get $i)))))
          (local.set $x (local.get $line_left))
          (local.set $right (local.get $paragraph_right))
          (local.set $paragraph_align (global.get $help_para_align))
          (local.set $paragraph_below (global.get $help_para_below))
          (local.set $paragraph_lines (global.get $help_para_lines))
          (local.set $line_run_start (global.get $help_layout_count))
          (local.set $line_height (local.get $font_height))))
      (if (i32.eq (local.get $kind) (global.get $HELP_TOKEN_FONT))
        (then
          (if (i32.ge_u (local.get $value) (global.get $help_doc_font_count))
            (then (return (call $help_layout_fail (i32.const 7) (local.get $i)))))
          (local.set $font_index (local.get $value))
          (local.set $font_height (call $help_layout_select_font
            (local.get $hdc) (local.get $font_handles) (local.get $font_count)
            (local.get $value)))
          (if (i32.gt_u (local.get $font_height) (local.get $line_height))
            (then (local.set $line_height (local.get $font_height))))
          (local.set $color (i32.load offset=20
            (i32.add (global.get $help_doc_fonts_wa)
              (i32.mul (local.get $value) (global.get $HELP_FONT_SIZE)))))))
      (if (i32.eq (local.get $kind) (global.get $HELP_TOKEN_COLOR))
        (then (local.set $color (local.get $value))))
      ;; A macro command opens a hotspot region exactly like a jump does: both
      ;; 0xC8 and its 0xCC without-font-change variant are closed by the same
      ;; 0x89 end command, so the run carries the macro token instead of a
      ;; topic selector and activation dispatches on the token kind.
      (if (i32.or
            (i32.eq (local.get $kind) (global.get $HELP_TOKEN_HOTSPOT_BEGIN))
            (i32.eq (local.get $kind) (global.get $HELP_TOKEN_MACRO)))
        (then
          (if (local.get $hotspot) (then (return (call $help_layout_fail (i32.const 8) (local.get $i)))))
          ;; Store token_index+1 in each run; zero remains "not a hotspot".
          (local.set $hotspot (i32.add (local.get $i) (i32.const 1)))))
      (if (i32.eq (local.get $kind) (global.get $HELP_TOKEN_HOTSPOT_END))
        (then
          (if (i32.eqz (local.get $hotspot)) (then (return (call $help_layout_fail (i32.const 9) (local.get $i)))))
          (local.set $hotspot (i32.const 0))))
      (if (i32.eq (local.get $kind) (global.get $HELP_TOKEN_LINE_BREAK))
        (then
          (call $help_layout_align_line
            (local.get $line_run_start) (local.get $x)
            (local.get $paragraph_right) (local.get $paragraph_align))
          (local.set $y (i32.add (local.get $y)
            (call $help_layout_line_advance
              (local.get $line_height) (local.get $paragraph_lines))))
          (local.set $x (local.get $continuation_left))
          (local.set $line_left (local.get $continuation_left))
          (local.set $line_run_start (global.get $help_layout_count))
          (local.set $line_height (local.get $font_height))
          (local.set $saw_content (i32.const 1))))
      (if (i32.eq (local.get $kind) (global.get $HELP_TOKEN_SPACE))
        (then
          (local.set $width
            (if (result i32) (i32.eq (local.get $value) (i32.const 0x83))
              (then (call $help_layout_tab_width
                (local.get $x) (local.get $continuation_left) (local.get $hdc)
                (local.get $raw) (local.get $tokens) (local.get $token_count)
                (local.get $i)))
              (else (select (i32.const 8) (i32.const 4)
                (i32.eq (local.get $value) (i32.const 0x8B))))))
          (if (i32.and (i32.gt_u (local.get $x) (local.get $line_left))
                (i32.gt_u (i32.add (local.get $x) (local.get $width)) (local.get $right)))
            (then
              (call $help_layout_align_line
                (local.get $line_run_start) (local.get $x)
                (local.get $paragraph_right) (local.get $paragraph_align))
              (local.set $y (i32.add (local.get $y)
                (call $help_layout_line_advance
                  (local.get $line_height) (local.get $paragraph_lines))))
              (local.set $x (local.get $continuation_left))
              (local.set $line_left (local.get $continuation_left))
              (local.set $line_run_start (global.get $help_layout_count))
              (local.set $line_height (local.get $font_height))))
          (if (i32.eqz (call $help_layout_emit
                (global.get $HELP_LAYOUT_SPACE) (local.get $x) (local.get $y)
                (local.get $width) (local.get $line_height)
                (i32.const 0) (i32.const 0) (local.get $font_index)
                (local.get $color) (local.get $hotspot)))
            (then (return (call $help_layout_fail (i32.const 10) (local.get $i)))))
          (local.set $x (i32.add (local.get $x) (local.get $width)))
          (local.set $saw_content (i32.const 1))))
      (if (i32.eq (local.get $kind) (global.get $HELP_TOKEN_BITMAP))
        (then
          ;; Canonical bitmap tokens store normalized index+1. Inline and
          ;; unsupported forms retain a bounded 16x16 placeholder.
          (local.set $off (i32.sub (local.get $value) (i32.const 1)))
          (local.set $width (i32.const 16))
          (local.set $height (i32.const 16))
          (if (i32.lt_u (local.get $off) (global.get $help_doc_bitmap_count))
            (then
              (local.set $token (i32.add (global.get $help_doc_bitmaps_wa)
                (i32.mul (local.get $off) (global.get $HELP_BITMAP_SIZE))))
              (local.set $width (i32.load offset=32 (local.get $token)))
              (local.set $height (i32.load offset=36 (local.get $token)))))
          (if (i32.and (i32.gt_u (local.get $x) (local.get $line_left))
                (i32.gt_u (i32.add (local.get $x) (local.get $width)) (local.get $right)))
            (then
              (call $help_layout_align_line
                (local.get $line_run_start) (local.get $x)
                (local.get $paragraph_right) (local.get $paragraph_align))
              (local.set $y (i32.add (local.get $y)
                (call $help_layout_line_advance
                  (local.get $line_height) (local.get $paragraph_lines))))
              (local.set $x (local.get $continuation_left))
              (local.set $line_left (local.get $continuation_left))
              (local.set $line_run_start (global.get $help_layout_count))
              (local.set $line_height (local.get $font_height))))
          (if (i32.eqz (call $help_layout_emit
                (global.get $HELP_LAYOUT_BITMAP) (local.get $x) (local.get $y)
                (local.get $width) (local.get $height) (local.get $off) (local.get $len)
                (local.get $font_index) (local.get $color) (local.get $hotspot)))
            (then (return (call $help_layout_fail (i32.const 11) (local.get $i)))))
          (local.set $x (i32.add (local.get $x) (local.get $width)))
          (if (i32.gt_u (local.get $height) (local.get $line_height))
            (then (local.set $line_height (local.get $height))))
          (local.set $saw_content (i32.const 1))))
      (if (i32.eq (local.get $kind) (global.get $HELP_TOKEN_TEXT))
        (then
          (if (i32.gt_u (local.get $off) (local.get $raw_len))
            (then (return (call $help_layout_fail (i32.const 12) (local.get $i)))))
          (if (i32.gt_u (local.get $len) (i32.sub (local.get $raw_len) (local.get $off)))
            (then (return (call $help_layout_fail (i32.const 13) (local.get $i)))))
          (local.set $pos (i32.const 0))
          (block $text_done (loop $text_loop
            (br_if $text_done (i32.ge_u (local.get $pos) (local.get $len)))
            (local.set $ch (i32.load8_u
              (i32.add (local.get $raw) (i32.add (local.get $off) (local.get $pos)))))
            (if (i32.eq (local.get $ch) (i32.const 0x20))
              (then
                (local.set $width (call $help_layout_measure (local.get $hdc)
                  (i32.add (local.get $raw) (i32.add (local.get $off) (local.get $pos)))
                  (i32.const 1)))
                (if (i32.and (i32.gt_u (local.get $x) (local.get $line_left))
                      (i32.gt_u (i32.add (local.get $x) (local.get $width)) (local.get $right)))
                  (then
                    (call $help_layout_align_line
                      (local.get $line_run_start) (local.get $x)
                      (local.get $paragraph_right) (local.get $paragraph_align))
                    (local.set $y (i32.add (local.get $y)
                      (call $help_layout_line_advance
                        (local.get $line_height) (local.get $paragraph_lines))))
                    (local.set $x (local.get $continuation_left))
                    (local.set $line_left (local.get $continuation_left))
                    (local.set $line_run_start (global.get $help_layout_count))
                    (local.set $line_height (local.get $font_height))))
                (if (i32.eqz (call $help_layout_emit
                      (global.get $HELP_LAYOUT_SPACE) (local.get $x) (local.get $y)
                      (local.get $width) (local.get $line_height)
                      (i32.add (local.get $off) (local.get $pos)) (i32.const 1)
                      (local.get $font_index) (local.get $color) (local.get $hotspot)))
                  (then (return (call $help_layout_fail (i32.const 14) (local.get $i)))))
                (local.set $x (i32.add (local.get $x) (local.get $width)))
                (local.set $pos (i32.add (local.get $pos) (i32.const 1))))
              (else
                (local.set $span (i32.const 0))
                (block $word_done (loop $word
                  (br_if $word_done
                    (i32.ge_u (i32.add (local.get $pos) (local.get $span)) (local.get $len)))
                  (br_if $word_done (i32.eq
                    (i32.load8_u (i32.add (local.get $raw)
                      (i32.add (local.get $off) (i32.add (local.get $pos) (local.get $span)))))
                    (i32.const 0x20)))
                  (local.set $span (i32.add (local.get $span) (i32.const 1)))
                  (br $word)))
                (block $span_done (loop $span_loop
                  (br_if $span_done (i32.eqz (local.get $span)))
                  (local.set $width (call $help_layout_measure (local.get $hdc)
                    (i32.add (local.get $raw) (i32.add (local.get $off) (local.get $pos)))
                    (local.get $span)))
                  (if (i32.and (i32.gt_u (local.get $x) (local.get $line_left))
                        (i32.gt_u (i32.add (local.get $x) (local.get $width)) (local.get $right)))
                    (then
                      (call $help_layout_align_line
                        (local.get $line_run_start) (local.get $x)
                        (local.get $paragraph_right) (local.get $paragraph_align))
                      (local.set $y (i32.add (local.get $y)
                        (call $help_layout_line_advance
                          (local.get $line_height) (local.get $paragraph_lines))))
                      (local.set $x (local.get $continuation_left))
                      (local.set $line_left (local.get $continuation_left))
                      (local.set $line_run_start (global.get $help_layout_count))
                      (local.set $line_height (local.get $font_height))))
                  (local.set $fit (local.get $span))
                  (if (i32.gt_u (i32.add (local.get $x) (local.get $width))
                        (local.get $right))
                    (then
                      (local.set $fit (call $help_layout_fit_prefix
                        (local.get $hdc)
                        (i32.add (local.get $raw) (i32.add (local.get $off) (local.get $pos)))
                        (local.get $span) (i32.sub (local.get $right) (local.get $x))))
                      (local.set $width (call $help_layout_measure (local.get $hdc)
                        (i32.add (local.get $raw) (i32.add (local.get $off) (local.get $pos)))
                        (local.get $fit)))))
                  (if (i32.eqz (call $help_layout_emit
                        (global.get $HELP_LAYOUT_TEXT) (local.get $x) (local.get $y)
                        (local.get $width) (local.get $line_height)
                        (i32.add (local.get $off) (local.get $pos)) (local.get $fit)
                        (local.get $font_index) (local.get $color) (local.get $hotspot)))
                    (then (return (call $help_layout_fail (i32.const 15) (local.get $i)))))
                  (local.set $x (i32.add (local.get $x) (local.get $width)))
                  (local.set $pos (i32.add (local.get $pos) (local.get $fit)))
                  (local.set $span (i32.sub (local.get $span) (local.get $fit)))
                  (local.set $saw_content (i32.const 1))
                  (if (local.get $span)
                    (then
                      (call $help_layout_align_line
                        (local.get $line_run_start) (local.get $x)
                        (local.get $paragraph_right) (local.get $paragraph_align))
                      (local.set $y (i32.add (local.get $y)
                        (call $help_layout_line_advance
                          (local.get $line_height) (local.get $paragraph_lines))))
                      (local.set $x (local.get $continuation_left))
                      (local.set $line_left (local.get $continuation_left))
                      (local.set $line_run_start (global.get $help_layout_count))
                      (local.set $line_height (local.get $font_height))))
                  (br $span_loop)))))
            (br $text_loop)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $tokens_loop)))
    (if (i32.eqz (local.get $ended)) (then (return (call $help_layout_fail (i32.const 16) (local.get $i)))))
    (global.set $help_layout_extent
      (i32.add (i32.add (local.get $y) (local.get $line_height))
        (local.get $paragraph_below)))
    (global.get $help_layout_count))

  ;; Public/internal entry point with an exact counting pass before any write.
  ;; Insufficient capacity therefore cannot leave a partial positioned list.
  (func $help_layout_tokens
    (param $raw i32) (param $raw_len i32)
    (param $payload i32) (param $payload_len i32)
    (param $tokens i32) (param $token_count i32)
    (param $runs i32) (param $run_capacity i32)
    (param $client_width i32) (param $hdc i32)
    (param $font_handles i32) (param $font_count i32) (result i32)
    (local $required i32)
    (if (local.get $runs)
      (then
        (local.set $required (call $help_layout_tokens_core
          (local.get $raw) (local.get $raw_len)
          (local.get $payload) (local.get $payload_len)
          (local.get $tokens) (local.get $token_count)
          (i32.const 0) (global.get $HELP_MAX_LAYOUT_RUNS)
          (local.get $client_width) (local.get $hdc)
          (local.get $font_handles) (local.get $font_count)))
        (if (i32.or (i32.lt_s (local.get $required) (i32.const 0))
              (i32.gt_u (local.get $required) (local.get $run_capacity)))
          (then (return (i32.const -1))))))
    (call $help_layout_tokens_core
      (local.get $raw) (local.get $raw_len)
      (local.get $payload) (local.get $payload_len)
      (local.get $tokens) (local.get $token_count)
      (local.get $runs) (local.get $run_capacity)
      (local.get $client_width) (local.get $hdc)
      (local.get $font_handles) (local.get $font_count)))

  (func $help_font_handles_release
    (param $handles i32) (param $count i32) (param $hdc i32)
    (local $i i32) (local $handle i32)
    ;; Never leave a DC pointing at an object that this transaction deletes.
    (if (i32.and (i32.ne (local.get $hdc) (i32.const 0))
          (i32.ne (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0))
            (i32.const 0)))
      (then
        (drop (call $gdi_dc_set_field
          (local.get $hdc) (i32.const 88) (i32.const 0x3001D)
          (i32.const 0x3001D)))))
    (if (local.get $handles)
      (then
        (block $done (loop $objects
          (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
          (local.set $handle (i32.load (i32.add (local.get $handles)
            (i32.shl (local.get $i) (i32.const 2)))))
          (if (local.get $handle)
            (then (drop (call $gdi_object_delete_full (local.get $handle)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $objects))))))

  ;; Create each distinct referenced logical font before layout. Face names
  ;; are copied through a bounded scratch buffer because an HLP face slot may
  ;; legally consume every byte without a trailing NUL.
  (func $help_materialize_view_fonts
    (param $tokens i32) (param $token_count i32)
    (param $handles i32) (param $slot_count i32) (result i32)
    (local $i i32) (local $token i32) (local $index i32)
    (local $font i32) (local $face_index i32) (local $face i32)
    (local $name i32) (local $name_len i32) (local $copy_len i32)
    (local $height i32) (local $attributes i32) (local $handle i32)
    (global.set $help_materialize_font_count (i32.const 0))
    (block $failed
      (block $done (loop $scan
        (br_if $done (i32.ge_u (local.get $i) (local.get $token_count)))
        (local.set $token (i32.add (local.get $tokens)
          (i32.mul (local.get $i) (global.get $HELP_TOPIC_TOKEN_SIZE))))
        (if (i32.ne (i32.load (local.get $token)) (global.get $HELP_TOKEN_FONT))
          (then
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $scan)))
        (local.set $index (i32.load offset=12 (local.get $token)))
        (if (i32.ge_u (local.get $index) (local.get $slot_count))
          (then
            (call $help_set_error (global.get $HELP_ERROR_FONT_TABLE)
              (i32.const 0))
            (br $failed)))
        (if (i32.load (i32.add (local.get $handles)
              (i32.shl (local.get $index) (i32.const 2))))
          (then
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $scan)))
        (local.set $font (i32.add (global.get $help_doc_fonts_wa)
          (i32.mul (local.get $index) (global.get $HELP_FONT_SIZE))))
        (local.set $face_index (i32.load (local.get $font)))
        (if (i32.ge_u (local.get $face_index) (global.get $help_doc_font_face_count))
          (then
            (call $help_set_error (global.get $HELP_ERROR_FONT_TABLE)
              (i32.const 0))
            (br $failed)))
        (local.set $face (i32.add (global.get $help_doc_font_faces_wa)
          (i32.mul (local.get $face_index) (global.get $HELP_FONT_FACE_SIZE))))
        (local.set $name (i32.add (global.get $help_doc_file_wa)
          (i32.load (local.get $face))))
        (local.set $name_len (i32.load offset=4 (local.get $face)))
        (local.set $copy_len (local.get $name_len))
        (if (i32.gt_u (local.get $copy_len) (i32.const 31))
          (then (local.set $copy_len (i32.const 31))))
        (memory.fill (global.get $TEXT_SCRATCH) (i32.const 0) (i32.const 32))
        (memory.copy (global.get $TEXT_SCRATCH) (local.get $name) (local.get $copy_len))
        (local.set $height (call $help_font_pixel_height (local.get $index)))
        (local.set $attributes (i32.load offset=12 (local.get $font)))
        (local.set $handle (call $gdi_font_create
          (i32.sub (i32.const 0) (local.get $height))
          (i32.load offset=16 (local.get $font))
          (i32.ne (i32.and (local.get $attributes) (i32.const 2)) (i32.const 0))
          (global.get $TEXT_SCRATCH)))
        (if (i32.eqz (local.get $handle))
          (then
            (call $help_set_error (global.get $HELP_ERROR_ALLOCATION)
              (i32.const 0))
            (br $failed)))
        (call $gdi_bitmap_font_bind (local.get $handle) (global.get $TEXT_SCRATCH))
        (i32.store (i32.add (local.get $handles)
          (i32.shl (local.get $index) (i32.const 2))) (local.get $handle))
        (global.set $help_materialize_font_count
          (i32.add (global.get $help_materialize_font_count) (i32.const 1)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $scan)))
      (return (i32.const 1)))
    (i32.const 0))

  (func $help_bitmap_handles_release
    (param $handles i32) (param $count i32) (param $dc i32)
    (local $i i32) (local $handle i32)
    (if (local.get $dc) (then (drop (call $gdi_dc_delete (local.get $dc)))))
    (if (local.get $handles)
      (then
        (block $done (loop $objects
          (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
          (local.set $handle (i32.load (i32.add (local.get $handles)
            (i32.shl (local.get $i) (i32.const 2)))))
          (if (local.get $handle)
            (then (drop (call $gdi_object_delete_full (local.get $handle)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $objects))))))

  ;; Decode each distinct referenced raster and copy its pixels/palette into a
  ;; canonical owned GDI bitmap. Metafiles and inline picture commands retain
  ;; layout placeholders until their separate formats are implemented.
  (func $help_materialize_view_bitmaps
    (param $runs i32) (param $run_count i32)
    (param $handles i32) (param $slot_count i32) (result i32)
    (local $i i32) (local $run i32) (local $index i32) (local $record i32)
    (local $picture_type i32) (local $decoded_size i32)
    (local $temporary_ga i32) (local $temporary_wa i32)
    (local $handle i32) (local $palette_count i32) (local $dc i32)
    (global.set $help_materialize_bitmap_dc (i32.const 0))
    (global.set $help_materialize_bitmap_count (i32.const 0))
    (block $failed
      (block $done (loop $scan
        (br_if $done (i32.ge_u (local.get $i) (local.get $run_count)))
        (local.set $run (i32.add (local.get $runs)
          (i32.mul (local.get $i) (global.get $HELP_LAYOUT_RUN_SIZE))))
        (if (i32.ne (i32.load (local.get $run)) (global.get $HELP_LAYOUT_BITMAP))
          (then
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $scan)))
        (local.set $index (i32.load offset=20 (local.get $run)))
        (if (i32.ge_u (local.get $index) (local.get $slot_count))
          (then
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $scan)))
        (if (i32.load (i32.add (local.get $handles)
              (i32.shl (local.get $index) (i32.const 2))))
          (then
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $scan)))
        (local.set $record (i32.add (global.get $help_doc_bitmaps_wa)
          (i32.mul (local.get $index) (global.get $HELP_BITMAP_SIZE))))
        (local.set $picture_type (i32.load offset=8 (local.get $record)))
        (if (i32.and (i32.ne (local.get $picture_type) (i32.const 5))
              (i32.ne (local.get $picture_type) (i32.const 6)))
          (then
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $scan)))
        (local.set $decoded_size (i32.load offset=72 (local.get $record)))
        (local.set $temporary_ga (call $dib_alloc (local.get $decoded_size)))
        (if (i32.eqz (local.get $temporary_ga))
          (then
            (call $help_set_error (global.get $HELP_ERROR_ALLOCATION)
              (i32.load offset=48 (local.get $record)))
            (br $failed)))
        (local.set $temporary_wa (call $g2w (local.get $temporary_ga)))
        (if (i32.ne (call $help_decode_bitmap
              (local.get $index) (local.get $temporary_wa) (local.get $decoded_size))
              (local.get $decoded_size))
          (then
            (call $dib_free_wasm (local.get $temporary_wa))
            (local.set $temporary_ga (i32.const 0))
            (br $failed)))
        (memory.fill (global.get $GDI_BITMAP_PLAN) (i32.const 0)
          (global.get $GDI_BITMAP_PLAN_SIZE))
        (i32.store (global.get $GDI_BITMAP_PLAN) (i32.load offset=32 (local.get $record)))
        (i32.store offset=4 (global.get $GDI_BITMAP_PLAN)
          (i32.load offset=36 (local.get $record)))
        (i32.store offset=8 (global.get $GDI_BITMAP_PLAN)
          (i32.load offset=28 (local.get $record)))
        (i32.store offset=16 (global.get $GDI_BITMAP_PLAN)
          (i32.div_u (local.get $decoded_size) (i32.load offset=36 (local.get $record))))
        (local.set $palette_count (i32.load offset=68 (local.get $record)))
        (if (local.get $palette_count)
          (then
            (i32.store offset=20 (global.get $GDI_BITMAP_PLAN)
              (i32.add (global.get $help_doc_file_wa)
                (i32.load offset=64 (local.get $record))))
            (i32.store offset=24 (global.get $GDI_BITMAP_PLAN) (local.get $palette_count))))
        (i32.store offset=32 (global.get $GDI_BITMAP_PLAN) (local.get $decoded_size))
        (local.set $handle (call $gdi_bitmap_create_owned
          (global.get $GDI_BITMAP_PLAN) (local.get $temporary_wa)
          (i32.const 1) (i32.ne (local.get $palette_count) (i32.const 0))
          (i32.const 0) (i32.const 0) (i32.const 0)))
        (call $dib_free_wasm (local.get $temporary_wa))
        (local.set $temporary_ga (i32.const 0))
        (if (i32.eqz (local.get $handle))
          (then
            (call $help_set_error (global.get $HELP_ERROR_ALLOCATION)
              (i32.load offset=48 (local.get $record)))
            (br $failed)))
        (i32.store (i32.add (local.get $handles)
          (i32.shl (local.get $index) (i32.const 2))) (local.get $handle))
        (global.set $help_materialize_bitmap_count
          (i32.add (global.get $help_materialize_bitmap_count) (i32.const 1)))
        (if (i32.eqz (local.get $dc))
          (then
            (local.set $dc (call $gdi_dc_alloc))
            (global.set $help_materialize_bitmap_dc (local.get $dc))
            (if (i32.eqz (local.get $dc))
              (then
                (call $help_set_error (global.get $HELP_ERROR_ALLOCATION)
                  (i32.load offset=48 (local.get $record)))
                (br $failed)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $scan)))
      (return (i32.const 1)))
    (if (local.get $temporary_ga)
      (then (call $dib_free_wasm (call $g2w (local.get $temporary_ga)))))
    (i32.const 0))

  (func $help_typed_view_release
    (call $help_font_handles_release
      (global.get $help_view_font_handles_wa)
      (global.get $help_view_font_slot_count)
      (global.get $help_view_font_hdc))
    (if (global.get $help_view_font_handles_ga)
      (then (call $heap_free (global.get $help_view_font_handles_ga))))
    (call $help_bitmap_handles_release
      (global.get $help_view_bitmap_handles_wa)
      (global.get $help_view_bitmap_slot_count)
      (global.get $help_view_bitmap_dc))
    (if (global.get $help_view_bitmap_handles_ga)
      (then (call $heap_free (global.get $help_view_bitmap_handles_ga))))
    (if (global.get $help_view_runs_ga)
      (then (call $heap_free (global.get $help_view_runs_ga))))
    (if (global.get $help_view_payload_ga)
      (then (call $heap_free (global.get $help_view_payload_ga))))
    (if (global.get $help_view_tokens_ga)
      (then (call $heap_free (global.get $help_view_tokens_ga))))
    (if (global.get $help_topic_wa)
      (then (call $heap_free (call $w2g (global.get $help_topic_wa)))))
    (global.set $help_view_runs_ga (i32.const 0))
    (global.set $help_view_runs_wa (i32.const 0))
    (global.set $help_view_run_count (i32.const 0))
    (global.set $help_view_payload_ga (i32.const 0))
    (global.set $help_view_payload_wa (i32.const 0))
    (global.set $help_view_payload_len (i32.const 0))
    (global.set $help_view_tokens_ga (i32.const 0))
    (global.set $help_view_tokens_wa (i32.const 0))
    (global.set $help_view_token_count (i32.const 0))
    (global.set $help_view_extent_height (i32.const 0))
    (global.set $help_view_layout_width (i32.const 0))
    (global.set $help_view_bitmap_handles_ga (i32.const 0))
    (global.set $help_view_bitmap_handles_wa (i32.const 0))
    (global.set $help_view_bitmap_slot_count (i32.const 0))
    (global.set $help_view_bitmap_materialized_count (i32.const 0))
    (global.set $help_view_bitmap_dc (i32.const 0))
    (global.set $help_view_font_handles_ga (i32.const 0))
    (global.set $help_view_font_handles_wa (i32.const 0))
    (global.set $help_view_font_slot_count (i32.const 0))
    (global.set $help_view_font_materialized_count (i32.const 0))
    (global.set $help_view_font_hdc (i32.const 0))
    (global.set $help_topic_wa (i32.const 0))
    (global.set $help_topic_len (i32.const 0)))

  ;; Capture the primary viewer state before a hotspot commits popup mode.
  ;; API-driven popups reach presentation after commit; detach fills the same
  ;; fields from the retained primary view in that case.
  (func $help_popup_capture_session
    (if (i32.or (global.get $help_popup_hwnd)
          (global.get $help_popup_saved_session_valid))
      (then (return)))
    (global.set $help_popup_saved_doc_wa (global.get $help_doc_file_wa))
    (global.set $help_popup_saved_topic_ref (global.get $help_session_topic_ref))
    (global.set $help_popup_saved_topic_index (global.get $help_session_topic_index))
    (global.set $help_popup_saved_mode (global.get $help_session_mode))
    (global.set $help_popup_saved_command (global.get $help_session_last_command))
    (global.set $help_popup_saved_status (global.get $help_session_status))
    (global.set $help_popup_saved_cur_topic (global.get $help_cur_topic))
    (global.set $help_popup_saved_scroll_y (global.get $help_scroll_y))
    (global.set $help_popup_saved_back_count (global.get $help_back_count))
    (global.set $help_popup_saved_session_valid (i32.const 1)))

  ;; Move every owned arena/resource root into the popup return slot, then
  ;; clear the active roots so the popup replacement cannot release them.
  (func $help_popup_detach_main_view
    (local $index i32) (local $record i32)
    (if (global.get $help_popup_saved_valid) (then (return)))
    (if (i32.eqz (global.get $help_popup_saved_session_valid))
      (then
        (global.set $help_popup_saved_doc_wa (global.get $help_doc_file_wa))
        (local.set $index (i32.sub (global.get $help_cur_topic) (i32.const 1)))
        (if (i32.and (i32.ge_s (local.get $index) (i32.const 0))
              (i32.lt_u (local.get $index) (global.get $help_doc_topic_count)))
          (then
            (local.set $record (i32.add (global.get $help_doc_topics_wa)
              (i32.mul (local.get $index) (global.get $HELP_TOPIC_SIZE))))
            (global.set $help_popup_saved_topic_ref (i32.load (local.get $record)))
            (global.set $help_popup_saved_topic_index (local.get $index))
            (global.set $help_popup_saved_mode (i32.const 1)))
          (else
            (global.set $help_popup_saved_topic_ref (i32.const -1))
            (global.set $help_popup_saved_topic_index (i32.const -1))
            (global.set $help_popup_saved_mode (i32.const 0))))
        (global.set $help_popup_saved_command (i32.const 0))
        (global.set $help_popup_saved_status (global.get $HELP_DISPATCH_ACCEPTED))
        (global.set $help_popup_saved_cur_topic (global.get $help_cur_topic))
        (global.set $help_popup_saved_scroll_y (global.get $help_scroll_y))
        (global.set $help_popup_saved_back_count (global.get $help_back_count))
        (global.set $help_popup_saved_session_valid (i32.const 1))))
    (global.set $help_popup_saved_topic_wa (global.get $help_topic_wa))
    (global.set $help_popup_saved_topic_len (global.get $help_topic_len))
    (global.set $help_popup_saved_tokens_ga (global.get $help_view_tokens_ga))
    (global.set $help_popup_saved_tokens_wa (global.get $help_view_tokens_wa))
    (global.set $help_popup_saved_token_count (global.get $help_view_token_count))
    (global.set $help_popup_saved_payload_ga (global.get $help_view_payload_ga))
    (global.set $help_popup_saved_payload_wa (global.get $help_view_payload_wa))
    (global.set $help_popup_saved_payload_len (global.get $help_view_payload_len))
    (global.set $help_popup_saved_runs_ga (global.get $help_view_runs_ga))
    (global.set $help_popup_saved_runs_wa (global.get $help_view_runs_wa))
    (global.set $help_popup_saved_run_count (global.get $help_view_run_count))
    (global.set $help_popup_saved_extent_height (global.get $help_view_extent_height))
    (global.set $help_popup_saved_layout_width (global.get $help_view_layout_width))
    (global.set $help_popup_saved_bitmap_handles_ga (global.get $help_view_bitmap_handles_ga))
    (global.set $help_popup_saved_bitmap_handles_wa (global.get $help_view_bitmap_handles_wa))
    (global.set $help_popup_saved_bitmap_slot_count (global.get $help_view_bitmap_slot_count))
    (global.set $help_popup_saved_bitmap_count (global.get $help_view_bitmap_materialized_count))
    (global.set $help_popup_saved_bitmap_dc (global.get $help_view_bitmap_dc))
    (global.set $help_popup_saved_font_handles_ga (global.get $help_view_font_handles_ga))
    (global.set $help_popup_saved_font_handles_wa (global.get $help_view_font_handles_wa))
    (global.set $help_popup_saved_font_slot_count (global.get $help_view_font_slot_count))
    (global.set $help_popup_saved_font_count (global.get $help_view_font_materialized_count))
    (global.set $help_popup_saved_font_hdc (global.get $help_view_font_hdc))
    (global.set $help_topic_wa (i32.const 0))
    (global.set $help_topic_len (i32.const 0))
    (global.set $help_view_tokens_ga (i32.const 0))
    (global.set $help_view_tokens_wa (i32.const 0))
    (global.set $help_view_token_count (i32.const 0))
    (global.set $help_view_payload_ga (i32.const 0))
    (global.set $help_view_payload_wa (i32.const 0))
    (global.set $help_view_payload_len (i32.const 0))
    (global.set $help_view_runs_ga (i32.const 0))
    (global.set $help_view_runs_wa (i32.const 0))
    (global.set $help_view_run_count (i32.const 0))
    (global.set $help_view_extent_height (i32.const 0))
    (global.set $help_view_layout_width (i32.const 0))
    (global.set $help_view_bitmap_handles_ga (i32.const 0))
    (global.set $help_view_bitmap_handles_wa (i32.const 0))
    (global.set $help_view_bitmap_slot_count (i32.const 0))
    (global.set $help_view_bitmap_materialized_count (i32.const 0))
    (global.set $help_view_bitmap_dc (i32.const 0))
    (global.set $help_view_font_handles_ga (i32.const 0))
    (global.set $help_view_font_handles_wa (i32.const 0))
    (global.set $help_view_font_slot_count (i32.const 0))
    (global.set $help_view_font_materialized_count (i32.const 0))
    (global.set $help_view_font_hdc (i32.const 0))
    (global.set $help_popup_saved_valid (i32.const 1)))

  ;; Release the active popup view and transfer the detached primary roots
  ;; back without decoding or reallocating anything.
  (func $help_popup_restore_main_view
    (if (i32.eqz (global.get $help_popup_saved_valid)) (then (return)))
    (call $help_typed_view_release)
    (global.set $help_topic_wa (global.get $help_popup_saved_topic_wa))
    (global.set $help_topic_len (global.get $help_popup_saved_topic_len))
    (global.set $help_view_tokens_ga (global.get $help_popup_saved_tokens_ga))
    (global.set $help_view_tokens_wa (global.get $help_popup_saved_tokens_wa))
    (global.set $help_view_token_count (global.get $help_popup_saved_token_count))
    (global.set $help_view_payload_ga (global.get $help_popup_saved_payload_ga))
    (global.set $help_view_payload_wa (global.get $help_popup_saved_payload_wa))
    (global.set $help_view_payload_len (global.get $help_popup_saved_payload_len))
    (global.set $help_view_runs_ga (global.get $help_popup_saved_runs_ga))
    (global.set $help_view_runs_wa (global.get $help_popup_saved_runs_wa))
    (global.set $help_view_run_count (global.get $help_popup_saved_run_count))
    (global.set $help_view_extent_height (global.get $help_popup_saved_extent_height))
    (global.set $help_view_layout_width (global.get $help_popup_saved_layout_width))
    (global.set $help_view_bitmap_handles_ga (global.get $help_popup_saved_bitmap_handles_ga))
    (global.set $help_view_bitmap_handles_wa (global.get $help_popup_saved_bitmap_handles_wa))
    (global.set $help_view_bitmap_slot_count (global.get $help_popup_saved_bitmap_slot_count))
    (global.set $help_view_bitmap_materialized_count (global.get $help_popup_saved_bitmap_count))
    (global.set $help_view_bitmap_dc (global.get $help_popup_saved_bitmap_dc))
    (global.set $help_view_font_handles_ga (global.get $help_popup_saved_font_handles_ga))
    (global.set $help_view_font_handles_wa (global.get $help_popup_saved_font_handles_wa))
    (global.set $help_view_font_slot_count (global.get $help_popup_saved_font_slot_count))
    (global.set $help_view_font_materialized_count (global.get $help_popup_saved_font_count))
    (global.set $help_view_font_hdc (global.get $help_popup_saved_font_hdc))
    (global.set $help_cur_topic (global.get $help_popup_saved_cur_topic))
    (global.set $help_scroll_y (global.get $help_popup_saved_scroll_y))
    (global.set $help_popup_saved_topic_wa (i32.const 0))
    (global.set $help_popup_saved_topic_len (i32.const 0))
    (global.set $help_popup_saved_tokens_ga (i32.const 0))
    (global.set $help_popup_saved_tokens_wa (i32.const 0))
    (global.set $help_popup_saved_token_count (i32.const 0))
    (global.set $help_popup_saved_payload_ga (i32.const 0))
    (global.set $help_popup_saved_payload_wa (i32.const 0))
    (global.set $help_popup_saved_payload_len (i32.const 0))
    (global.set $help_popup_saved_runs_ga (i32.const 0))
    (global.set $help_popup_saved_runs_wa (i32.const 0))
    (global.set $help_popup_saved_run_count (i32.const 0))
    (global.set $help_popup_saved_extent_height (i32.const 0))
    (global.set $help_popup_saved_layout_width (i32.const 0))
    (global.set $help_popup_saved_bitmap_handles_ga (i32.const 0))
    (global.set $help_popup_saved_bitmap_handles_wa (i32.const 0))
    (global.set $help_popup_saved_bitmap_slot_count (i32.const 0))
    (global.set $help_popup_saved_bitmap_count (i32.const 0))
    (global.set $help_popup_saved_bitmap_dc (i32.const 0))
    (global.set $help_popup_saved_font_handles_ga (i32.const 0))
    (global.set $help_popup_saved_font_handles_wa (i32.const 0))
    (global.set $help_popup_saved_font_slot_count (i32.const 0))
    (global.set $help_popup_saved_font_count (i32.const 0))
    (global.set $help_popup_saved_font_hdc (i32.const 0))
    (global.set $help_popup_saved_valid (i32.const 0)))

  ;; Decode, tokenize, lay out, and publish a topic as one viewer transaction.
  ;; Runtime rendering currently caps a single decoded topic at 64 KiB; the
  ;; parser's larger archival cap remains available to caller-owned APIs.
  (func $help_replace_typed_view
    (param $topic_index i32) (param $layout_width i32) (param $target_hwnd i32)
    (result i32)
    (local $raw_ga i32) (local $raw_wa i32) (local $raw_len i32)
    (local $tokens_ga i32) (local $tokens_wa i32) (local $token_count i32)
    (local $payload_ga i32) (local $payload_wa i32) (local $payload_len i32)
    (local $runs_ga i32) (local $runs_wa i32) (local $run_count i32)
    (local $bitmap_handles_ga i32) (local $bitmap_handles_wa i32)
    (local $bitmap_slot_count i32) (local $bitmap_materialized_count i32)
    (local $bitmap_dc i32)
    (local $font_handles_ga i32) (local $font_handles_wa i32)
    (local $font_slot_count i32) (local $font_materialized_count i32)
    (local $hdc i32) (local $ok i32)
    (block $cleanup
    (local.set $raw_ga (call $heap_alloc (i32.const 65536)))
    (if (i32.eqz (local.get $raw_ga))
      (then
        (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
        (return (i32.const 0))))
    (local.set $raw_wa (call $g2w (local.get $raw_ga)))
    (local.set $raw_len (call $help_decode_topic_raw
      (local.get $topic_index) (local.get $raw_wa) (i32.const 65536)))
    (if (i32.lt_s (local.get $raw_len) (i32.const 0)) (then (br $cleanup)))
    ;; Deliberately request zero output capacities: the formatted decoder's
    ;; first pass leaves exact token/payload requirements in its private channel.
    (drop (call $help_decode_topic_formatted
      (local.get $topic_index) (local.get $raw_wa) (i32.const 65536)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
    ;; Zero-capacity counting intentionally reports CAPACITY through the
    ;; public decoder. Do not let that expected probe mask a later build,
    ;; decode, or materialization error.
    (if (i32.eq (global.get $help_last_error) (global.get $HELP_ERROR_CAPACITY))
      (then
        (global.set $help_last_error (global.get $HELP_ERROR_NONE))
        (global.set $help_last_error_offset (i32.const 0))))
    (local.set $token_count (global.get $help_fmt_token_count))
    (local.set $payload_len (global.get $help_fmt_payload_used))
    (if (i32.or (i32.eqz (local.get $token_count))
          (i32.gt_u (local.get $token_count) (global.get $HELP_MAX_TOPIC_TOKENS)))
      (then (br $cleanup)))
    (local.set $tokens_ga (call $heap_alloc
      (i32.mul (local.get $token_count) (global.get $HELP_TOPIC_TOKEN_SIZE))))
    (if (i32.eqz (local.get $tokens_ga))
      (then
        (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
        (br $cleanup)))
    (local.set $tokens_wa (call $g2w (local.get $tokens_ga)))
    (if (local.get $payload_len)
      (then
        (local.set $payload_ga (call $heap_alloc (local.get $payload_len)))
        (if (i32.eqz (local.get $payload_ga))
          (then
            (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
            (br $cleanup)))
        (local.set $payload_wa (call $g2w (local.get $payload_ga)))))
    (if (i32.lt_s (call $help_decode_topic_formatted
          (local.get $topic_index) (local.get $raw_wa) (i32.const 65536)
          (local.get $tokens_wa) (local.get $token_count)
          (local.get $payload_wa) (local.get $payload_len)) (i32.const 0))
      (then (br $cleanup)))
    (local.set $hdc (i32.add (local.get $target_hwnd) (i32.const 0x40000)))
    (local.set $font_slot_count (global.get $help_doc_font_count))
    (if (local.get $font_slot_count)
      (then
        (local.set $font_handles_ga (call $heap_alloc
          (i32.shl (local.get $font_slot_count) (i32.const 2))))
        (if (i32.eqz (local.get $font_handles_ga))
          (then
            (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
            (br $cleanup)))
        (local.set $font_handles_wa (call $g2w (local.get $font_handles_ga)))
        (memory.fill (local.get $font_handles_wa) (i32.const 0)
          (i32.shl (local.get $font_slot_count) (i32.const 2)))))
    (if (i32.eqz (call $help_materialize_view_fonts
          (local.get $tokens_wa) (local.get $token_count)
          (local.get $font_handles_wa) (local.get $font_slot_count)))
      (then (br $cleanup)))
    (local.set $font_materialized_count
      (global.get $help_materialize_font_count))
    (local.set $run_count (call $help_layout_tokens
      (local.get $raw_wa) (local.get $raw_len)
      (local.get $payload_wa) (local.get $payload_len)
      (local.get $tokens_wa) (local.get $token_count)
      (i32.const 0) (global.get $HELP_MAX_LAYOUT_RUNS)
      (local.get $layout_width) (local.get $hdc)
      (local.get $font_handles_wa) (local.get $font_slot_count)))
    (if (i32.lt_s (local.get $run_count) (i32.const 0)) (then (br $cleanup)))
    (if (local.get $run_count)
      (then
        (local.set $runs_ga (call $heap_alloc
          (i32.mul (local.get $run_count) (global.get $HELP_LAYOUT_RUN_SIZE))))
        (if (i32.eqz (local.get $runs_ga))
          (then
            (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
            (br $cleanup)))
        (local.set $runs_wa (call $g2w (local.get $runs_ga)))))
    (if (i32.ne (call $help_layout_tokens
          (local.get $raw_wa) (local.get $raw_len)
          (local.get $payload_wa) (local.get $payload_len)
          (local.get $tokens_wa) (local.get $token_count)
          (local.get $runs_wa) (local.get $run_count)
          (local.get $layout_width) (local.get $hdc)
          (local.get $font_handles_wa) (local.get $font_slot_count))
          (local.get $run_count))
      (then (br $cleanup)))
    (local.set $bitmap_slot_count (global.get $help_doc_bitmap_count))
    (if (local.get $bitmap_slot_count)
      (then
        (local.set $bitmap_handles_ga (call $heap_alloc
          (i32.shl (local.get $bitmap_slot_count) (i32.const 2))))
        (if (i32.eqz (local.get $bitmap_handles_ga))
          (then
            (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
            (br $cleanup)))
        (local.set $bitmap_handles_wa (call $g2w (local.get $bitmap_handles_ga)))
        (memory.fill (local.get $bitmap_handles_wa) (i32.const 0)
          (i32.shl (local.get $bitmap_slot_count) (i32.const 2)))))
    (if (i32.eqz (call $help_materialize_view_bitmaps
          (local.get $runs_wa) (local.get $run_count)
          (local.get $bitmap_handles_wa) (local.get $bitmap_slot_count)))
      (then
        (local.set $bitmap_dc (global.get $help_materialize_bitmap_dc))
        (br $cleanup)))
    (local.set $bitmap_dc (global.get $help_materialize_bitmap_dc))
    (local.set $bitmap_materialized_count
      (global.get $help_materialize_bitmap_count))
    (call $help_typed_view_release)
    (global.set $help_topic_wa (local.get $raw_wa))
    (global.set $help_topic_len (local.get $raw_len))
    (global.set $help_view_tokens_ga (local.get $tokens_ga))
    (global.set $help_view_tokens_wa (local.get $tokens_wa))
    (global.set $help_view_token_count (local.get $token_count))
    (global.set $help_view_payload_ga (local.get $payload_ga))
    (global.set $help_view_payload_wa (local.get $payload_wa))
    (global.set $help_view_payload_len (local.get $payload_len))
    (global.set $help_view_runs_ga (local.get $runs_ga))
    (global.set $help_view_runs_wa (local.get $runs_wa))
    (global.set $help_view_run_count (local.get $run_count))
    (global.set $help_view_extent_height (global.get $help_layout_extent))
    (global.set $help_view_layout_width (local.get $layout_width))
    (global.set $help_view_bitmap_handles_ga (local.get $bitmap_handles_ga))
    (global.set $help_view_bitmap_handles_wa (local.get $bitmap_handles_wa))
    (global.set $help_view_bitmap_slot_count (local.get $bitmap_slot_count))
    (global.set $help_view_bitmap_materialized_count
      (local.get $bitmap_materialized_count))
    (global.set $help_view_bitmap_dc (local.get $bitmap_dc))
    (global.set $help_view_font_handles_ga (local.get $font_handles_ga))
    (global.set $help_view_font_handles_wa (local.get $font_handles_wa))
    (global.set $help_view_font_slot_count (local.get $font_slot_count))
    (global.set $help_view_font_materialized_count
      (local.get $font_materialized_count))
    (global.set $help_view_font_hdc (local.get $hdc))
    (global.set $help_last_error (global.get $HELP_ERROR_NONE))
    (global.set $help_last_error_offset (i32.const 0))
    (local.set $raw_ga (i32.const 0))
    (local.set $tokens_ga (i32.const 0))
    (local.set $payload_ga (i32.const 0))
    (local.set $runs_ga (i32.const 0))
    (local.set $bitmap_handles_ga (i32.const 0))
    (local.set $bitmap_dc (i32.const 0))
    (local.set $font_handles_ga (i32.const 0))
    (local.set $ok (i32.const 1)))
    (if (local.get $bitmap_handles_ga)
      (then
        (call $help_bitmap_handles_release
          (local.get $bitmap_handles_wa) (local.get $bitmap_slot_count)
          (local.get $bitmap_dc))
        (call $heap_free (local.get $bitmap_handles_ga))))
    (if (local.get $font_handles_ga)
      (then
        (call $help_font_handles_release
          (local.get $font_handles_wa) (local.get $font_slot_count)
          (local.get $hdc))
        (call $heap_free (local.get $font_handles_ga))))
    (if (local.get $runs_ga) (then (call $heap_free (local.get $runs_ga))))
    (if (local.get $payload_ga) (then (call $heap_free (local.get $payload_ga))))
    (if (local.get $tokens_ga) (then (call $heap_free (local.get $tokens_ga))))
    (if (local.get $raw_ga) (then (call $heap_free (local.get $raw_ga))))
    (local.get $ok))

  (func $help_paint_typed_view (param $hdc i32)
    (local $i i32) (local $run i32) (local $kind i32)
    (local $y i32) (local $height i32) (local $color i32)
    (local $index i32) (local $handle i32) (local $flags i32)
    (local $pixel_x i32) (local $line_y i32) (local $viewport_bottom i32)
    (local.set $viewport_bottom (i32.const 272))
    (if (i32.eq (i32.sub (local.get $hdc) (i32.const 0x40000))
          (global.get $help_popup_hwnd))
      (then (local.set $viewport_bottom (global.get $help_popup_height))))
    (block $done (loop $runs
      (br_if $done (i32.ge_u (local.get $i) (global.get $help_view_run_count)))
      (local.set $run (i32.add (global.get $help_view_runs_wa)
        (i32.mul (local.get $i) (global.get $HELP_LAYOUT_RUN_SIZE))))
      (local.set $kind (i32.load (local.get $run)))
      (local.set $y (i32.sub (i32.load offset=8 (local.get $run))
        (global.get $help_scroll_y)))
      (local.set $height (i32.load offset=16 (local.get $run)))
      (if (i32.and (i32.eq (local.get $kind) (global.get $HELP_LAYOUT_TEXT))
            (i32.and (i32.gt_s (i32.add (local.get $y) (local.get $height)) (i32.const 0))
                     (i32.lt_s (local.get $y) (local.get $viewport_bottom))))
        (then
          (local.set $index (i32.load offset=28 (local.get $run)))
          (if (i32.and
                (i32.lt_u (local.get $index) (global.get $help_view_font_slot_count))
                (i32.ne (global.get $help_view_font_handles_wa) (i32.const 0)))
            (then
              (local.set $handle (i32.load
                (i32.add (global.get $help_view_font_handles_wa)
                  (i32.shl (local.get $index) (i32.const 2)))))
              (if (local.get $handle)
                (then (drop (call $gdi_dc_select_owned_object
                  (local.get $hdc) (local.get $handle)))))))
          (local.set $color (i32.load offset=32 (local.get $run)))
          (local.set $flags (i32.load offset=36 (local.get $run)))
          (if (i32.and (local.get $flags) (i32.const 0x0FFFFFFF))
            (then (local.set $color (i32.const 0xFF0000))))
          (drop (call $host_gdi_set_text_color (local.get $hdc) (local.get $color)))
          (drop (call $host_gdi_text_out
            (local.get $hdc) (i32.load offset=4 (local.get $run)) (local.get $y)
            (i32.add (global.get $help_topic_wa) (i32.load offset=20 (local.get $run)))
            (i32.load offset=24 (local.get $run)) (i32.const 0)))
          (if (i32.and (local.get $flags) (i32.const 0x40000000))
            (then
              (local.set $line_y
                (i32.add (local.get $y) (i32.sub (local.get $height) (i32.const 2))))
              (local.set $pixel_x (i32.load offset=4 (local.get $run)))
              (block $underline_done (loop $underline
                (br_if $underline_done (i32.ge_u (local.get $pixel_x)
                  (i32.add (i32.load offset=4 (local.get $run))
                    (i32.load offset=12 (local.get $run)))))
                (drop (call $host_gdi_set_pixel
                  (local.get $hdc) (local.get $pixel_x) (local.get $line_y)
                  (local.get $color)))
                (local.set $pixel_x (i32.add (local.get $pixel_x) (i32.const 1)))
                (br $underline)))))
          (if (i32.and (local.get $flags) (i32.const 0x80000000))
            (then
              (local.set $line_y (i32.add (local.get $y)
                (i32.shr_u (local.get $height) (i32.const 1))))
              (local.set $pixel_x (i32.load offset=4 (local.get $run)))
              (block $strike_done (loop $strike
                (br_if $strike_done (i32.ge_u (local.get $pixel_x)
                  (i32.add (i32.load offset=4 (local.get $run))
                    (i32.load offset=12 (local.get $run)))))
                (drop (call $host_gdi_set_pixel
                  (local.get $hdc) (local.get $pixel_x) (local.get $line_y)
                  (local.get $color)))
                (local.set $pixel_x (i32.add (local.get $pixel_x) (i32.const 1)))
                (br $strike)))))))
      (if (i32.and (i32.eq (local.get $kind) (global.get $HELP_LAYOUT_BITMAP))
            (i32.and (i32.gt_s (i32.add (local.get $y) (local.get $height)) (i32.const 0))
                     (i32.lt_s (local.get $y) (local.get $viewport_bottom))))
        (then
          (local.set $index (i32.load offset=20 (local.get $run)))
          (if (i32.and
                (i32.lt_u (local.get $index) (global.get $help_view_bitmap_slot_count))
                (i32.ne (global.get $help_view_bitmap_dc) (i32.const 0)))
            (then
              (local.set $handle (i32.load
                (i32.add (global.get $help_view_bitmap_handles_wa)
                  (i32.shl (local.get $index) (i32.const 2)))))
              (if (local.get $handle)
                (then
                  (drop (call $gdi_dc_select_owned_object
                    (global.get $help_view_bitmap_dc) (local.get $handle)))
                  (drop (call $host_gdi_bitblt
                    (local.get $hdc)
                    (i32.load offset=4 (local.get $run)) (local.get $y)
                    (i32.load offset=12 (local.get $run)) (local.get $height)
                    (global.get $help_view_bitmap_dc) (i32.const 0) (i32.const 0)
                    (i32.const 0x00CC0020)))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $runs))))

  (func $help_view_hotspot_token_at
    (param $x i32) (param $y i32) (result i32)
    (local $i i32) (local $run i32) (local $id i32)
    (local $left i32) (local $top i32) (local $right i32) (local $bottom i32)
    (local $viewport_bottom i32)
    (local.set $viewport_bottom
      (select (global.get $help_popup_height) (i32.const 270)
        (i32.ne (global.get $help_popup_hwnd) (i32.const 0))))
    (if (i32.or (i32.lt_s (local.get $x) (i32.const 0))
          (i32.or (i32.lt_s (local.get $y) (i32.const 0))
                  (i32.ge_s (local.get $y) (local.get $viewport_bottom))))
      (then (return (i32.const -1))))
    (block $missing (loop $runs
      (br_if $missing (i32.ge_u (local.get $i) (global.get $help_view_run_count)))
      (local.set $run (i32.add (global.get $help_view_runs_wa)
        (i32.mul (local.get $i) (global.get $HELP_LAYOUT_RUN_SIZE))))
      (local.set $id (i32.and (i32.load offset=36 (local.get $run))
        (i32.const 0x0FFFFFFF)))
      (if (local.get $id)
        (then
          (local.set $left (i32.load offset=4 (local.get $run)))
          (local.set $top (i32.sub (i32.load offset=8 (local.get $run))
            (global.get $help_scroll_y)))
          (local.set $right (i32.add (local.get $left)
            (i32.load offset=12 (local.get $run))))
          (local.set $bottom (i32.add (local.get $top)
            (i32.load offset=16 (local.get $run))))
          (if (i32.and
                (i32.and (i32.ge_s (local.get $x) (local.get $left))
                         (i32.lt_s (local.get $x) (local.get $right)))
                (i32.and (i32.ge_s (local.get $y) (local.get $top))
                         (i32.lt_s (local.get $y) (local.get $bottom))))
            (then (return (i32.sub (local.get $id) (i32.const 1)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $runs)))
    (i32.const -1))

  ;; Copy a bounded external filename into an owned VFS path. Relative names
  ;; inherit the current document's final slash-delimited directory; absolute,
  ;; rooted, and drive-qualified names are retained exactly.
  (func $help_external_path_copy
    (param $name i32) (param $name_len i32) (result i32)
    (local $i i32) (local $ch i32) (local $absolute i32)
    (local $prefix_len i32) (local $total i32) (local $ga i32) (local $wa i32)
    (if (i32.or (i32.eqz (local.get $name_len))
                (i32.gt_u (local.get $name_len) (i32.const 1023)))
      (then (return (i32.const 0))))
    (local.set $ch (i32.load8_u (local.get $name)))
    (if (i32.or (i32.eq (local.get $ch) (i32.const 47))
                (i32.eq (local.get $ch) (i32.const 92)))
      (then (local.set $absolute (i32.const 1))))
    (block $name_done (loop $name_scan
      (br_if $name_done (i32.ge_u (local.get $i) (local.get $name_len)))
      (if (i32.eq (i32.load8_u (i32.add (local.get $name) (local.get $i)))
            (i32.const 58))
        (then (local.set $absolute (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $name_scan)))
    (if (i32.and (i32.eqz (local.get $absolute))
          (i32.ne (global.get $help_doc_path_wa) (i32.const 0)))
      (then
        (local.set $i (i32.const 0))
        (block $base_done (loop $base_scan
          (br_if $base_done
            (i32.ge_u (local.get $i) (global.get $help_doc_path_len)))
          (local.set $ch (i32.load8_u
            (i32.add (global.get $help_doc_path_wa) (local.get $i))))
          (if (i32.or (i32.eq (local.get $ch) (i32.const 47))
                      (i32.eq (local.get $ch) (i32.const 92)))
            (then (local.set $prefix_len
              (i32.add (local.get $i) (i32.const 1)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $base_scan)))))
    (local.set $total (i32.add (local.get $prefix_len) (local.get $name_len)))
    (if (i32.gt_u (local.get $total) (i32.const 1023))
      (then (return (i32.const 0))))
    (local.set $ga (call $heap_alloc (i32.add (local.get $total) (i32.const 1))))
    (if (i32.eqz (local.get $ga)) (then (return (i32.const 0))))
    (local.set $wa (call $g2w (local.get $ga)))
    (if (local.get $prefix_len)
      (then
        (memory.copy (local.get $wa) (global.get $help_doc_path_wa)
          (local.get $prefix_len))))
    (memory.copy (i32.add (local.get $wa) (local.get $prefix_len))
      (local.get $name) (local.get $name_len))
    (i32.store8 (i32.add (local.get $wa) (local.get $total)) (i32.const 0))
    (local.get $ga))

  ;; Direct E0/E1 commands carry canonical topic references. E2/E3/E6/E7
  ;; and the exact EA/EB/EE/EF structures carry context hashes. Even opcodes
  ;; are popups and odd opcodes navigate the main window, matching winhlp32.
  ;; ---- WinHelp macros ----------------------------------------------
  ;;
  ;; A macro region carries a macro string like `JumpContext(23)` or
  ;; `KL("printing")`. Only macros that map onto navigation this emulator
  ;; already performs are executed; everything else - and that includes every
  ;; macro that would run guest code, register a DLL routine, or touch the
  ;; host - reports UNSUPPORTED rather than being silently swallowed.
  ;;
  ;; Parsing is deliberately small: a name, then at most two arguments, each
  ;; either a quoted string or a decimal number. Nothing here evaluates
  ;; expressions or chains macros with ';'.
  (global $help_macro_arg_wa (mut i32) (i32.const 0))
  (global $help_macro_arg_len (mut i32) (i32.const 0))
  (global $help_macro_arg_number (mut i32) (i32.const 0))
  (global $help_macro_arg_is_string (mut i32) (i32.const 0))

  (func $help_macro_upper (param $ch i32) (result i32)
    (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x61))
                 (i32.le_u (local.get $ch) (i32.const 0x7A)))
      (then (return (i32.sub (local.get $ch) (i32.const 0x20)))))
    (local.get $ch))

  ;; Macro names are matched by FNV-1a over the upper-cased name - the same
  ;; hash $help_hash_bytes computes - so the allowlist needs no data segment of
  ;; string literals in a shared header file. The constants below come from
  ;; the names in the comments; test_help_macro_name_hash exists so a test can
  ;; prove each constant still belongs to its name rather than trusting a
  ;; number nobody can read.
  (func $help_macro_name_hash (param $wa i32) (param $len i32) (result i32)
    (local $i i32) (local $hash i32)
    (local.set $hash (i32.const 0x811C9DC5))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (local.set $hash
        (i32.mul
          (i32.xor (local.get $hash)
            (call $help_macro_upper
              (i32.load8_u (i32.add (local.get $wa) (local.get $i)))))
          (i32.const 0x01000193)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $hash))

  (func (export "test_help_macro_name_hash")
    (param $wa i32) (param $len i32) (result i32)
    (call $help_macro_name_hash (local.get $wa) (local.get $len)))

  ;; Read one argument starting at $wa (bounded by $end) into the arg globals.
  ;; Returns the position just past the argument, or 0 if it does not parse.
  (func $help_macro_read_arg (param $wa i32) (param $end i32) (result i32)
    (local $ch i32) (local $start i32) (local $negative i32) (local $digits i32)
    (global.set $help_macro_arg_wa (i32.const 0))
    (global.set $help_macro_arg_len (i32.const 0))
    (global.set $help_macro_arg_number (i32.const 0))
    (global.set $help_macro_arg_is_string (i32.const 0))
    (block $skipped (loop $skip
      (br_if $skipped (i32.ge_u (local.get $wa) (local.get $end)))
      (local.set $ch (i32.load8_u (local.get $wa)))
      (br_if $skipped (i32.and (i32.ne (local.get $ch) (i32.const 0x20))
                               (i32.ne (local.get $ch) (i32.const 0x09))))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1)))
      (br $skip)))
    (if (i32.ge_u (local.get $wa) (local.get $end)) (then (return (i32.const 0))))
    (local.set $ch (i32.load8_u (local.get $wa)))
    (if (i32.or (i32.eq (local.get $ch) (i32.const 0x22))    ;; "
                (i32.eq (local.get $ch) (i32.const 0x60)))   ;; ` (WinHelp's other quote)
      (then
        (local.set $wa (i32.add (local.get $wa) (i32.const 1)))
        (local.set $start (local.get $wa))
        (block $closed (loop $string
          (if (i32.ge_u (local.get $wa) (local.get $end))
            (then (return (i32.const 0))))
          (local.set $ch (i32.load8_u (local.get $wa)))
          (br_if $closed (i32.or (i32.eq (local.get $ch) (i32.const 0x22))
                                 (i32.eq (local.get $ch) (i32.const 0x27))))
          (local.set $wa (i32.add (local.get $wa) (i32.const 1)))
          (br $string)))
        (global.set $help_macro_arg_wa (local.get $start))
        (global.set $help_macro_arg_len (i32.sub (local.get $wa) (local.get $start)))
        (global.set $help_macro_arg_is_string (i32.const 1))
        (return (i32.add (local.get $wa) (i32.const 1)))))
    (if (i32.eq (local.get $ch) (i32.const 0x2D))            ;; -
      (then
        (local.set $negative (i32.const 1))
        (local.set $wa (i32.add (local.get $wa) (i32.const 1)))))
    (block $number_done (loop $number
      (br_if $number_done (i32.ge_u (local.get $wa) (local.get $end)))
      (local.set $ch (i32.load8_u (local.get $wa)))
      (br_if $number_done (i32.or (i32.lt_u (local.get $ch) (i32.const 0x30))
                                  (i32.gt_u (local.get $ch) (i32.const 0x39))))
      (global.set $help_macro_arg_number
        (i32.add (i32.mul (global.get $help_macro_arg_number) (i32.const 10))
          (i32.sub (local.get $ch) (i32.const 0x30))))
      (local.set $digits (i32.add (local.get $digits) (i32.const 1)))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1)))
      (br $number)))
    (if (i32.eqz (local.get $digits)) (then (return (i32.const 0))))
    (if (local.get $negative)
      (then (global.set $help_macro_arg_number
        (i32.sub (i32.const 0) (global.get $help_macro_arg_number)))))
    (local.get $wa))

  ;; Execute one macro string. Returns 1 when it dispatched, 0 otherwise, and
  ;; always leaves $help_session_status describing what happened.
  (func $help_macro_execute
    (param $caller i32) (param $wa i32) (param $len i32) (result i32)
    (local $end i32) (local $name i32) (local $name_len i32) (local $ch i32)
    (local $cursor i32) (local $arg_wa i32) (local $arg_len i32)
    (local $number i32) (local $is_string i32) (local $topic_ref i32)
    (local $name_hash i32)
    (local.set $end (i32.add (local.get $wa) (local.get $len)))
    ;; Leading whitespace is common in authored macro strings.
    (block $trimmed (loop $trim
      (br_if $trimmed (i32.ge_u (local.get $wa) (local.get $end)))
      (local.set $ch (i32.load8_u (local.get $wa)))
      (br_if $trimmed (i32.and (i32.ne (local.get $ch) (i32.const 0x20))
                               (i32.ne (local.get $ch) (i32.const 0x09))))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1)))
      (br $trim)))
    (local.set $name (local.get $wa))
    (block $name_done (loop $scan
      (br_if $name_done (i32.ge_u (local.get $wa) (local.get $end)))
      (local.set $ch (call $help_macro_upper (i32.load8_u (local.get $wa))))
      (br_if $name_done (i32.or (i32.lt_u (local.get $ch) (i32.const 0x41))
                                (i32.gt_u (local.get $ch) (i32.const 0x5A))))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1)))
      (br $scan)))
    (local.set $name_len (i32.sub (local.get $wa) (local.get $name)))
    (local.set $name_hash (call $help_macro_name_hash
      (local.get $name) (local.get $name_len)))
    (if (i32.eqz (local.get $name_len))
      (then
        (global.set $help_session_status (global.get $HELP_DISPATCH_BAD_DATA))
        (return (i32.const 0))))
    ;; Step over any space and then the '(' when the macro takes arguments.
    (block $opened (loop $open
      (br_if $opened (i32.ge_u (local.get $wa) (local.get $end)))
      (local.set $ch (i32.load8_u (local.get $wa)))
      (if (i32.eq (local.get $ch) (i32.const 0x28))
        (then
          (local.set $wa (i32.add (local.get $wa) (i32.const 1)))
          (br $opened)))
      (br_if $opened (i32.and (i32.ne (local.get $ch) (i32.const 0x20))
                              (i32.ne (local.get $ch) (i32.const 0x09))))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1)))
      (br $open)))
    ;; Contents / Index / Finder / Search open a whole-document view and take
    ;; no argument we need.
    (if (i32.or
          (i32.eq (local.get $name_hash) (i32.const 0x314DC863))                                     ;; "CONTENTS"
          (i32.eq (local.get $name_hash) (i32.const 0xB1744B0B)))                                    ;; "INDEX"
      (then (return (call $help_dispatch_loaded (local.get $caller)
        (global.get $HELP_COMMAND_CONTENTS) (i32.const 0)))))
    (if (i32.or
          (i32.eq (local.get $name_hash) (i32.const 0xBB4ED44D))                                     ;; "FINDER"
          (i32.eq (local.get $name_hash) (i32.const 0x36D11E29)))                                    ;; "SEARCH"
      (then (return (call $help_dispatch_loaded (local.get $caller)
        (global.get $HELP_COMMAND_FINDER) (i32.const 0)))))
    (if (i32.or
          (i32.eq (local.get $name_hash) (i32.const 0x79836105))                                     ;; "EXIT"
          (i32.eq (local.get $name_hash) (i32.const 0x8F96A703)))                                    ;; "CLOSE"
      (then (return (call $help_dispatch_loaded (local.get $caller)
        (global.get $HELP_COMMAND_QUIT) (i32.const 0)))))
    ;; Everything below needs its arguments. An unknown macro must report
    ;; UNSUPPORTED rather than BAD_DATA - it is not malformed, it is simply
    ;; not one this emulator performs - so the name is checked against the
    ;; argument-taking allowlist before anything is parsed.
    (if (i32.eqz (i32.or
          (i32.or
            (i32.or (i32.eq (local.get $name_hash) (i32.const 0x4C586124))
                    (i32.eq (local.get $name_hash) (i32.const 0x4DF12BFA)))
            (i32.or (i32.eq (local.get $name_hash) (i32.const 0xF5739554))
                    (i32.eq (local.get $name_hash) (i32.const 0x2E000424))))
          (i32.or
            (i32.or
              (i32.or (i32.eq (local.get $name_hash) (i32.const 0x367A77D8))
                      (i32.eq (local.get $name_hash) (i32.const 0x43F11C3C)))
              (i32.or (i32.eq (local.get $name_hash) (i32.const 0x599BC348))
                      (i32.eq (local.get $name_hash) (i32.const 0x27FFFAB2))))
            (i32.or
              (i32.or (i32.eq (local.get $name_hash) (i32.const 0x6C09F342))
                      (i32.eq (local.get $name_hash) (i32.const 0x22EEA9B2)))
              (i32.or (i32.eq (local.get $name_hash) (i32.const 0x9EC699AC))
                      (i32.eq (local.get $name_hash) (i32.const 0x45F11F62)))))))
      (then
        (global.set $help_session_status (global.get $HELP_DISPATCH_UNSUPPORTED))
        (return (i32.const 0))))
    (local.set $cursor (call $help_macro_read_arg (local.get $wa) (local.get $end)))
    (if (i32.eqz (local.get $cursor))
      (then
        (global.set $help_session_status (global.get $HELP_DISPATCH_BAD_DATA))
        (return (i32.const 0))))
    (local.set $arg_wa (global.get $help_macro_arg_wa))
    (local.set $arg_len (global.get $help_macro_arg_len))
    (local.set $number (global.get $help_macro_arg_number))
    (local.set $is_string (global.get $help_macro_arg_is_string))
    ;; JumpContext(n) / JC(n) and PopupContext(n) / PC(n) address a map id.
    (if (i32.or
          (i32.eq (local.get $name_hash) (i32.const 0x4C586124))                                     ;; "JUMPCONTEXT"
          (i32.eq (local.get $name_hash) (i32.const 0x4DF12BFA)))                                    ;; "JC"
      (then
        (if (local.get $is_string)
          (then
            (global.set $help_session_status (global.get $HELP_DISPATCH_BAD_DATA))
            (return (i32.const 0))))
        (return (call $help_dispatch_loaded (local.get $caller)
          (global.get $HELP_COMMAND_CONTEXT) (local.get $number)))))
    (if (i32.or
          (i32.eq (local.get $name_hash) (i32.const 0xF5739554))                                     ;; "POPUPCONTEXT"
          (i32.eq (local.get $name_hash) (i32.const 0x2E000424)))                                    ;; "PC"
      (then
        (if (local.get $is_string)
          (then
            (global.set $help_session_status (global.get $HELP_DISPATCH_BAD_DATA))
            (return (i32.const 0))))
        (return (call $help_dispatch_loaded (local.get $caller)
          (global.get $HELP_COMMAND_CONTEXTPOPUP) (local.get $number)))))
    ;; JumpId / JI and PopupId / PI name a context string, optionally after a
    ;; file argument. The last string argument is the context name.
    (if (i32.or
          (i32.or
            (i32.eq (local.get $name_hash) (i32.const 0x367A77D8))                                   ;; "JUMPID"
            (i32.eq (local.get $name_hash) (i32.const 0x43F11C3C)))                                  ;; "JI"
          (i32.or
            (i32.eq (local.get $name_hash) (i32.const 0x599BC348))                                   ;; "POPUPID"
            (i32.eq (local.get $name_hash) (i32.const 0x27FFFAB2))))                                 ;; "PI"
      (then
        (if (i32.eqz (local.get $is_string))
          (then
            (global.set $help_session_status (global.get $HELP_DISPATCH_BAD_DATA))
            (return (i32.const 0))))
        ;; A second string argument means the first was the help file name.
        ;; Only this document is in reach, so a foreign file is unsupported.
        (if (i32.lt_u (local.get $cursor) (local.get $end))
          (then
            (if (i32.eq (i32.load8_u (local.get $cursor)) (i32.const 0x2C))
              (then
                (if (i32.eqz (call $help_macro_read_arg
                      (i32.add (local.get $cursor) (i32.const 1)) (local.get $end)))
                  (then
                    (global.set $help_session_status (global.get $HELP_DISPATCH_BAD_DATA))
                    (return (i32.const 0))))
                (if (i32.eqz (global.get $help_macro_arg_is_string))
                  (then
                    (global.set $help_session_status (global.get $HELP_DISPATCH_BAD_DATA))
                    (return (i32.const 0))))
                (local.set $arg_wa (global.get $help_macro_arg_wa))
                (local.set $arg_len (global.get $help_macro_arg_len))))))
        (local.set $topic_ref (call $help_resolve_context_hash
          (call $help_hash_bytes (local.get $arg_wa) (local.get $arg_len))))
        (if (i32.lt_s (local.get $topic_ref) (i32.const 0))
          (then
            (global.set $help_session_status (global.get $HELP_DISPATCH_UNRESOLVED))
            (return (i32.const 0))))
        (return (call $help_session_commit_topic (local.get $caller)
          (global.get $HELP_COMMAND_CONTEXT) (local.get $topic_ref)
          (select (i32.const 2) (i32.const 1)
            (i32.eq (call $help_macro_upper (i32.load8_u (local.get $name)))
              (i32.const 0x50)))))))                                 ;; 'P' = popup
    ;; KLink / KL and JumpKeyword / JK look a keyword up in this document.
    ;; ALink / AL is deliberately absent: its keyword space is |AWBTREE, whose
    ;; postings are multi-match, and presenting those needs a Topics Found
    ;; list that does not exist yet. Reporting UNSUPPORTED is honest; jumping
    ;; to an arbitrary one of six postings would not be.
    (if (i32.or
          (i32.or
            (i32.eq (local.get $name_hash) (i32.const 0x6C09F342))                                   ;; "KLINK"
            (i32.eq (local.get $name_hash) (i32.const 0x22EEA9B2)))                                  ;; "KL"
          (i32.or
            (i32.eq (local.get $name_hash) (i32.const 0x9EC699AC))                                   ;; "JUMPKEYWORD"
            (i32.eq (local.get $name_hash) (i32.const 0x45F11F62))))                                 ;; "JK"
      (then
        (if (i32.eqz (local.get $is_string))
          (then
            (global.set $help_session_status (global.get $HELP_DISPATCH_BAD_DATA))
            (return (i32.const 0))))
        (local.set $topic_ref (call $help_resolve_keyword
          (local.get $arg_wa) (local.get $arg_len) (i32.const 0)))
        (if (i32.lt_s (local.get $topic_ref) (i32.const 0))
          (then
            (global.set $help_session_status (global.get $HELP_DISPATCH_UNRESOLVED))
            (return (i32.const 0))))
        (return (call $help_session_commit_topic (local.get $caller)
          (global.get $HELP_COMMAND_KEY) (local.get $topic_ref) (i32.const 1)))))
    (global.set $help_session_status (global.get $HELP_DISPATCH_UNSUPPORTED))
    (i32.const 0))

  (func (export "test_help_macro_execute")
    (param $caller i32) (param $wa i32) (param $len i32) (result i32)
    (call $help_macro_execute (local.get $caller) (local.get $wa) (local.get $len)))

  (func $help_activate_hotspot_at
    (param $caller i32) (param $x i32) (param $y i32) (result i32)
    (local $index i32) (local $token i32) (local $off i32) (local $len i32)
    (local $payload i32) (local $command i32) (local $hash i32)
    (local $topic_ref i32) (local $mode i32) (local $api_command i32)
    (local $external i32) (local $popup i32) (local $size i32)
    (local $structure i32) (local $type i32) (local $name i32) (local $name_len i32)
    (local $path_ga i32) (local $path_wa i32) (local $snapshot_base i32)
    (local $parse_error i32) (local $parse_error_offset i32) (local $accepted i32)
    (local $selected i32) (local $window_ga i32) (local $window_wa i32)
    (local $window_len i32)
    (local.set $index (call $help_view_hotspot_token_at
      (local.get $x) (local.get $y)))
    (if (i32.lt_s (local.get $index) (i32.const 0))
      (then (return (i32.const 0))))
    (if (i32.ge_u (local.get $index) (global.get $help_view_token_count))
      (then (return (i32.const 0))))
    (local.set $token (i32.add (global.get $help_view_tokens_wa)
      (i32.mul (local.get $index) (global.get $HELP_TOPIC_TOKEN_SIZE))))
    ;; Macro regions share the hotspot run representation but carry a macro
    ;; string rather than a topic selector. The payload is the command byte,
    ;; a u16 length, then the macro text.
    (if (i32.eq (i32.load (local.get $token)) (global.get $HELP_TOKEN_MACRO))
      (then
        (local.set $off (i32.load offset=4 (local.get $token)))
        (if (i32.or
              (i32.gt_u (i32.add (local.get $off) (i32.const 3))
                (global.get $help_view_payload_len))
              (i32.eqz (global.get $help_view_payload_wa)))
          (then
            (global.set $help_session_status (global.get $HELP_DISPATCH_BAD_DATA))
            (return (i32.const 0))))
        (local.set $payload (i32.add (global.get $help_view_payload_wa) (local.get $off)))
        (local.set $len (i32.load16_u offset=1 (local.get $payload)))
        (if (i32.gt_u (i32.add (i32.add (local.get $off) (i32.const 3)) (local.get $len))
              (global.get $help_view_payload_len))
          (then
            (global.set $help_session_status (global.get $HELP_DISPATCH_BAD_DATA))
            (return (i32.const 0))))
        (return (call $help_macro_execute (local.get $caller)
          (i32.add (local.get $payload) (i32.const 3)) (local.get $len)))))
    (if (i32.ne (i32.load (local.get $token))
          (global.get $HELP_TOKEN_HOTSPOT_BEGIN))
      (then (return (i32.const 0))))
    (local.set $off (i32.load offset=4 (local.get $token)))
    (local.set $len (i32.load offset=8 (local.get $token)))
    (if (i32.or (i32.eqz (local.get $len))
          (i32.or (i32.gt_u (local.get $off) (global.get $help_view_payload_len))
            (i32.gt_u (local.get $len)
              (i32.sub (global.get $help_view_payload_len) (local.get $off)))))
      (then
        (global.set $help_session_status (global.get $HELP_DISPATCH_BAD_DATA))
        (return (i32.const 0))))
    (local.set $payload (i32.add (global.get $help_view_payload_wa) (local.get $off)))
    (local.set $command (i32.load8_u (local.get $payload)))
    (local.set $external
      (i32.or
        (i32.or (i32.eq (local.get $command) (i32.const 0xEA))
                (i32.eq (local.get $command) (i32.const 0xEB)))
        (i32.or (i32.eq (local.get $command) (i32.const 0xEE))
                (i32.eq (local.get $command) (i32.const 0xEF)))))
    (if (i32.and (i32.eqz (local.get $external))
          (i32.and
            (i32.and (i32.ne (local.get $command) (i32.const 0xE0))
                     (i32.ne (local.get $command) (i32.const 0xE1)))
            (i32.and
              (i32.and (i32.ne (local.get $command) (i32.const 0xE2))
                       (i32.ne (local.get $command) (i32.const 0xE3)))
              (i32.and (i32.ne (local.get $command) (i32.const 0xE6))
                       (i32.ne (local.get $command) (i32.const 0xE7))))))
      (then
        (global.set $help_session_status (global.get $HELP_DISPATCH_UNSUPPORTED))
        (return (i32.const 0))))
    (local.set $popup (i32.eqz (i32.and (local.get $command) (i32.const 1))))
    (local.set $mode (i32.const 1))
    (local.set $api_command (global.get $HELP_COMMAND_CONTEXT))
    (if (local.get $popup)
      (then
        (global.set $help_popup_anchor_x
          (i32.add (call $wnd_client_screen_x (global.get $help_hwnd))
            (local.get $x)))
        (global.set $help_popup_anchor_y
          (i32.add (call $wnd_client_screen_y (global.get $help_hwnd))
            (local.get $y)))
        (local.set $mode (i32.const 2))
        (local.set $api_command (global.get $HELP_COMMAND_CONTEXTPOPUP))))

    (if (i32.eqz (local.get $external))
      (then
        (if (i32.ne (local.get $len) (i32.const 5))
          (then
            (global.set $help_session_status (global.get $HELP_DISPATCH_BAD_DATA))
            (return (i32.const 0))))
        (local.set $hash (i32.load offset=1 (local.get $payload)))
        (local.set $topic_ref
          (if (result i32)
            (i32.or (i32.eq (local.get $command) (i32.const 0xE0))
                    (i32.eq (local.get $command) (i32.const 0xE1)))
            (then (local.get $hash))
            (else (call $help_resolve_context_hash (local.get $hash)))))
        (if (i32.lt_s (local.get $topic_ref) (i32.const 0))
          (then
            (global.set $help_session_status (global.get $HELP_DISPATCH_UNRESOLVED))
            (return (i32.const 0))))
        (if (local.get $popup) (then (call $help_popup_capture_session)))
        (return (call $help_session_commit_topic (local.get $caller)
          (local.get $api_command) (local.get $topic_ref) (local.get $mode)))))

    ;; The tokenizer already proved the structure, but repeat its outer bounds
    ;; at the activation boundary because token arenas are independently owned.
    (if (i32.lt_u (local.get $len) (i32.const 8))
      (then
        (global.set $help_session_status (global.get $HELP_DISPATCH_BAD_DATA))
        (return (i32.const 0))))
    (local.set $size (i32.load16_u offset=1 (local.get $payload)))
    (if (i32.ne (i32.add (local.get $size) (i32.const 3)) (local.get $len))
      (then
        (global.set $help_session_status (global.get $HELP_DISPATCH_BAD_DATA))
        (return (i32.const 0))))
    (local.set $structure (i32.add (local.get $payload) (i32.const 3)))
    (local.set $type (i32.load8_u (local.get $structure)))
    (local.set $hash (i32.load offset=1 (local.get $structure)))
    ;; -1 keeps the canonical main presentation; a non-negative selector names
    ;; a normalized |SYSTEM record in the document that owns the target topic.
    (local.set $selected (i32.const -1))
    (if (i32.eq (local.get $type) (i32.const 1))
      (then
        (local.set $selected (call $help_window_index_for_number
          (i32.load8_u offset=5 (local.get $structure))))
        (if (i32.lt_s (local.get $selected) (i32.const -1))
          (then
            ;; A number this document has no window for is a hard failure
            ;; rather than a silent fall back to the main window.
            (global.set $help_session_status (global.get $HELP_DISPATCH_UNRESOLVED))
            (return (i32.const 0))))))
    (if (i32.or (i32.eqz (local.get $type))
                (i32.eq (local.get $type) (i32.const 1)))
      (then
        (local.set $topic_ref (call $help_resolve_context_hash (local.get $hash)))
        (if (i32.lt_s (local.get $topic_ref) (i32.const 0))
          (then
            (global.set $help_session_status (global.get $HELP_DISPATCH_UNRESOLVED))
            (return (i32.const 0))))
        (if (local.get $popup) (then (call $help_popup_capture_session)))
        (local.set $accepted (call $help_session_commit_topic (local.get $caller)
          (local.get $api_command) (local.get $topic_ref) (local.get $mode)))
        (if (i32.and (local.get $accepted) (i32.eqz (local.get $popup)))
          (then (global.set $help_session_window_index (local.get $selected))))
        (return (local.get $accepted))))
    (if (i32.and (i32.ne (local.get $type) (i32.const 4))
                 (i32.ne (local.get $type) (i32.const 6)))
      (then
        (global.set $help_session_status (global.get $HELP_DISPATCH_BAD_DATA))
        (return (i32.const 0))))
    (if (global.get $help_popup_hwnd)
      (then
        ;; A popup owns a detached primary typed view. Do not stack a second
        ;; document transaction on top of that ownership graph.
        (global.set $help_session_status (global.get $HELP_DISPATCH_UNSUPPORTED))
        (return (i32.const 0))))
    (local.set $name (i32.add (local.get $structure) (i32.const 5)))
    (local.set $name_len (i32.sub (local.get $size) (i32.const 6)))
    (if (i32.eq (local.get $type) (i32.const 6))
      (then
        ;; type 6 packs filename NUL window NUL inside the same structure.
        ;; The window belongs to the target file, so retain an owned copy of
        ;; its name and resolve it only after that document is live.
        (local.set $name_len (i32.const 0))
        (block $file_done (loop $file
          (if (i32.ge_u (i32.add (local.get $name_len) (i32.const 7))
                (local.get $size))
            (then
              (global.set $help_session_status (global.get $HELP_DISPATCH_BAD_DATA))
              (return (i32.const 0))))
          (br_if $file_done (i32.eqz (i32.load8_u
            (i32.add (local.get $name) (local.get $name_len)))))
          (local.set $name_len (i32.add (local.get $name_len) (i32.const 1)))
          (br $file)))
        (local.set $window_len
          (i32.sub (i32.sub (local.get $size) (i32.const 7)) (local.get $name_len)))
        (if (i32.or (i32.eqz (local.get $window_len))
              (i32.gt_u (local.get $window_len) (i32.const 63)))
          (then
            (global.set $help_session_status (global.get $HELP_DISPATCH_BAD_DATA))
            (return (i32.const 0))))
        (local.set $window_ga
          (call $heap_alloc (i32.add (local.get $window_len) (i32.const 1))))
        (if (i32.eqz (local.get $window_ga))
          (then
            (global.set $help_session_status (global.get $HELP_DISPATCH_LOAD_FAILED))
            (return (i32.const 0))))
        (local.set $window_wa (call $g2w (local.get $window_ga)))
        (memory.copy (local.get $window_wa)
          (i32.add (local.get $name) (i32.add (local.get $name_len) (i32.const 1)))
          (local.get $window_len))
        (i32.store8 (i32.add (local.get $window_wa) (local.get $window_len))
          (i32.const 0))))
    (local.set $path_ga
      (call $help_external_path_copy (local.get $name) (local.get $name_len)))
    (if (i32.eqz (local.get $path_ga))
      (then
        (if (local.get $window_ga) (then (call $heap_free (local.get $window_ga))))
        (global.set $help_session_status (global.get $HELP_DISPATCH_LOAD_FAILED))
        (return (i32.const 0))))
    (local.set $path_wa (call $g2w (local.get $path_ga)))
    (local.set $snapshot_base (global.get $help_document_snapshot_count))
    (if (local.get $popup) (then (call $help_popup_capture_session)))
    (if (i32.eqz (call $help_document_snapshot_push))
      (then
        (call $heap_free (local.get $path_ga))
        (if (local.get $window_ga) (then (call $heap_free (local.get $window_ga))))
        (if (local.get $popup)
          (then (global.set $help_popup_saved_session_valid (i32.const 0))))
        (global.set $help_session_status (global.get $HELP_DISPATCH_LOAD_FAILED))
        (return (i32.const 0))))
    (if (i32.eqz (call $help_document_load_vfs (local.get $path_wa)))
      (then
        (local.set $parse_error (global.get $help_last_error))
        (local.set $parse_error_offset (global.get $help_last_error_offset))
        (call $heap_free (local.get $path_ga))
        (if (local.get $window_ga) (then (call $heap_free (local.get $window_ga))))
        (drop (call $help_document_snapshot_restore_top))
        (global.set $help_last_error (local.get $parse_error))
        (global.set $help_last_error_offset (local.get $parse_error_offset))
        (if (local.get $popup)
          (then (global.set $help_popup_saved_session_valid (i32.const 0))))
        (global.set $help_session_status (global.get $HELP_DISPATCH_LOAD_FAILED))
        (return (i32.const 0))))
    (call $heap_free (local.get $path_ga))
    (if (local.get $window_ga)
      (then
        (local.set $selected (call $help_find_window_index
          (local.get $window_wa) (local.get $window_len)))
        (call $heap_free (local.get $window_ga))
        (local.set $window_ga (i32.const 0))
        (if (i32.lt_s (local.get $selected) (i32.const 0))
          (then
            (drop (call $help_document_snapshot_restore_top))
            (if (local.get $popup)
              (then (global.set $help_popup_saved_session_valid (i32.const 0))))
            (global.set $help_session_status (global.get $HELP_DISPATCH_UNRESOLVED))
            (return (i32.const 0))))))
    (local.set $topic_ref (call $help_resolve_context_hash (local.get $hash)))
    (if (i32.lt_s (local.get $topic_ref) (i32.const 0))
      (then
        (drop (call $help_document_snapshot_restore_top))
        (if (local.get $popup)
          (then (global.set $help_popup_saved_session_valid (i32.const 0))))
        (global.set $help_session_status (global.get $HELP_DISPATCH_UNRESOLVED))
        (return (i32.const 0))))
    (local.set $accepted (call $help_session_commit_topic (local.get $caller)
      (local.get $api_command) (local.get $topic_ref) (local.get $mode)))
    (if (i32.eqz (local.get $accepted))
      (then
        (drop (call $help_document_snapshot_restore_top))
        (if (local.get $popup)
          (then (global.set $help_popup_saved_session_valid (i32.const 0))))
        (return (i32.const 0))))
    (if (i32.eqz (local.get $popup))
      (then (global.set $help_session_window_index (local.get $selected))))
    (if (local.get $popup)
      (then
        (global.set $help_popup_external_snapshot_base (local.get $snapshot_base))))
    (local.get $accepted))

  (func (export "test_help_layout_tokens")
    (param $raw i32) (param $raw_len i32)
    (param $tokens i32) (param $token_count i32)
    (param $runs i32) (param $run_capacity i32)
    (param $width i32) (result i32)
    (call $help_layout_tokens
      (local.get $raw) (local.get $raw_len)
      (i32.const 0) (i32.const 0)
      (local.get $tokens) (local.get $token_count)
      (local.get $runs) (local.get $run_capacity)
      (local.get $width) (i32.const 0x40001)
      (i32.const 0) (i32.const 0)))
  (func (export "test_help_layout_tokens_with_payload")
    (param $raw i32) (param $raw_len i32)
    (param $payload i32) (param $payload_len i32)
    (param $tokens i32) (param $token_count i32)
    (param $runs i32) (param $run_capacity i32)
    (param $width i32) (result i32)
    (call $help_layout_tokens
      (local.get $raw) (local.get $raw_len)
      (local.get $payload) (local.get $payload_len)
      (local.get $tokens) (local.get $token_count)
      (local.get $runs) (local.get $run_capacity)
      (local.get $width) (i32.const 0x40001)
      (i32.const 0) (i32.const 0)))
  (func (export "get_help_layout_extent") (result i32)
    (global.get $help_layout_extent))
  (func (export "get_help_view_run_count") (result i32)
    (global.get $help_view_run_count))
  (func (export "get_help_view_run_ptr") (result i32)
    (global.get $help_view_runs_wa))
  (func (export "get_help_view_extent_height") (result i32)
    (global.get $help_view_extent_height))
  (func (export "get_help_view_bitmap_slot_count") (result i32)
    (global.get $help_view_bitmap_slot_count))
  (func (export "get_help_view_bitmap_count") (result i32)
    (global.get $help_view_bitmap_materialized_count))
  (func (export "get_help_view_bitmap_handle") (param $index i32) (result i32)
    (if (i32.ge_u (local.get $index) (global.get $help_view_bitmap_slot_count))
      (then (return (i32.const 0))))
    (i32.load (i32.add (global.get $help_view_bitmap_handles_wa)
      (i32.shl (local.get $index) (i32.const 2)))))
  (func (export "get_help_view_bitmap_dc") (result i32)
    (global.get $help_view_bitmap_dc))
  (func (export "get_help_view_font_slot_count") (result i32)
    (global.get $help_view_font_slot_count))
  (func (export "get_help_view_font_count") (result i32)
    (global.get $help_view_font_materialized_count))
  (func (export "get_help_view_font_handle") (param $index i32) (result i32)
    (if (i32.ge_u (local.get $index) (global.get $help_view_font_slot_count))
      (then (return (i32.const 0))))
    (i32.load (i32.add (global.get $help_view_font_handles_wa)
      (i32.shl (local.get $index) (i32.const 2)))))
  (func (export "get_help_view_font_hdc") (result i32)
    (global.get $help_view_font_hdc))
  (func (export "test_help_view_font_height") (param $index i32) (result i32)
    (call $gdi_font_height (call $get_help_view_font_handle_for_test
      (local.get $index))))
  (func $get_help_view_font_handle_for_test (param $index i32) (result i32)
    (if (i32.ge_u (local.get $index) (global.get $help_view_font_slot_count))
      (then (return (i32.const 0))))
    (i32.load (i32.add (global.get $help_view_font_handles_wa)
      (i32.shl (local.get $index) (i32.const 2)))))
  (func (export "test_help_view_font_weight") (param $index i32) (result i32)
    (call $gdi_font_weight (call $get_help_view_font_handle_for_test
      (local.get $index))))
  (func (export "test_help_view_font_italic") (param $index i32) (result i32)
    (call $gdi_font_italic (call $get_help_view_font_handle_for_test
      (local.get $index))))
  (func (export "test_help_view_font_face") (param $index i32) (result i32)
    (call $gdi_font_face (call $get_help_view_font_handle_for_test
      (local.get $index))))
  (func (export "test_help_replace_typed_view")
    (param $topic_index i32) (result i32)
    (call $help_replace_typed_view (local.get $topic_index) (i32.const 400)
      (select (global.get $help_hwnd) (global.get $next_hwnd)
        (i32.ne (global.get $help_hwnd) (i32.const 0)))))
  (func (export "test_help_paint_typed_view") (param $hdc i32)
    (call $help_paint_typed_view (local.get $hdc)))
  (func (export "test_help_paint_bitmap_probe")
    (param $width i32) (param $height i32) (result i32)
    (local $bitmap i32) (local $dc i32) (local $stride i32)
    (if (i32.or
          (i32.or (i32.eqz (local.get $width)) (i32.gt_u (local.get $width) (i32.const 512)))
          (i32.or (i32.eqz (local.get $height)) (i32.gt_u (local.get $height) (i32.const 512))))
      (then (return (i32.const 0))))
    (local.set $stride (i32.shl (local.get $width) (i32.const 2)))
    (memory.fill (global.get $GDI_BITMAP_PLAN) (i32.const 0)
      (global.get $GDI_BITMAP_PLAN_SIZE))
    (i32.store (global.get $GDI_BITMAP_PLAN) (local.get $width))
    (i32.store offset=4 (global.get $GDI_BITMAP_PLAN) (local.get $height))
    (i32.store offset=8 (global.get $GDI_BITMAP_PLAN) (i32.const 32))
    (i32.store offset=12 (global.get $GDI_BITMAP_PLAN) (i32.const 2))
    (i32.store offset=16 (global.get $GDI_BITMAP_PLAN) (local.get $stride))
    (i32.store offset=32 (global.get $GDI_BITMAP_PLAN)
      (i32.mul (local.get $stride) (local.get $height)))
    (local.set $bitmap (call $gdi_bitmap_create_owned
      (global.get $GDI_BITMAP_PLAN) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
    (if (i32.eqz (local.get $bitmap)) (then (return (i32.const 0))))
    (local.set $dc (call $gdi_dc_alloc))
    (if (i32.eqz (local.get $dc))
      (then
        (drop (call $gdi_object_delete_full (local.get $bitmap)))
        (return (i32.const 0))))
    (drop (call $gdi_dc_select_owned_object (local.get $dc) (local.get $bitmap)))
    (call $help_paint_typed_view (local.get $dc))
    (drop (call $gdi_dc_delete (local.get $dc)))
    (local.get $bitmap))
  (func (export "test_help_release_bitmap_probe") (param $bitmap i32) (result i32)
    (call $gdi_object_delete_full (local.get $bitmap)))
  (func (export "test_help_view_hotspot_token_at")
    (param $x i32) (param $y i32) (result i32)
    (call $help_view_hotspot_token_at (local.get $x) (local.get $y)))
  (func (export "test_help_activate_hotspot_at")
    (param $caller i32) (param $x i32) (param $y i32) (result i32)
    (call $help_activate_hotspot_at
      (local.get $caller) (local.get $x) (local.get $y)))
  (func (export "test_help_window_message")
    (param $msg i32) (param $wparam i32) (param $lparam i32) (result i32)
    (if (i32.eqz (global.get $help_hwnd)) (then (return (i32.const 0))))
    (call $help_wndproc (global.get $help_hwnd)
      (local.get $msg) (local.get $wparam) (local.get $lparam)))
  (func (export "get_help_popup_hwnd") (result i32)
    (global.get $help_popup_hwnd))
  (func (export "get_help_popup_shadow_hwnd") (result i32)
    (global.get $help_popup_shadow_hwnd))
  (func (export "get_help_popup_width") (result i32)
    (global.get $help_popup_width))
  (func (export "get_help_popup_height") (result i32)
    (global.get $help_popup_height))
  (func (export "test_help_popup_message")
    (param $msg i32) (param $wparam i32) (param $lparam i32) (result i32)
    (if (i32.eqz (global.get $help_popup_hwnd))
      (then (return (i32.const 0))))
    (call $help_wndproc (global.get $help_popup_hwnd)
      (local.get $msg) (local.get $wparam) (local.get $lparam)))

  ;; ---- WAT-native Help Topics window -------------------------------

  ;; The dialog is a real WAT dialog built from the controls every other
  ;; WAT-built dialog uses: a LISTBOX for the rows and BUTTONs for the tab
  ;; selector and the two commands. Nothing here paints a row, a button or a
  ;; tab by hand - $listbox_wndproc and $button_wndproc own their own drawing,
  ;; scrolling, selection and keyboard, and the renderer composites them.
  (global $help_topics_hwnd (mut i32) (i32.const 0))
  (global $help_topics_list_hwnd (mut i32) (i32.const 0))
  (global $help_topics_tab_hwnd (mut i32) (i32.const 0))
  (global $help_topics_labels_ga (mut i32) (i32.const 0))
  (global $help_topics_labels_wa (mut i32) (i32.const 0))
  ;; One reusable guest buffer for the row text handed to LB_ADDSTRING. The
  ;; listbox copies each string into its own item buffer, so a single scratch
  ;; allocation serves every row.
  (global $help_topics_row_ga (mut i32) (i32.const 0))
  (global $help_topics_row_wa (mut i32) (i32.const 0))

  ;; Control ids. IDOK/IDCANCEL keep their Win32 values so the buttons behave
  ;; like the default/cancel buttons of any other dialog.
  (global $HELP_TOPICS_ID_DISPLAY i32 (i32.const 1))
  (global $HELP_TOPICS_ID_CANCEL i32 (i32.const 2))
  (global $HELP_TOPICS_ID_LIST i32 (i32.const 0x501))
  (global $HELP_TOPICS_ID_TABS i32 (i32.const 0x502))

  (func $help_topics_init_labels (result i32)
    (local $ga i32) (local $wa i32)
    (if (global.get $help_topics_labels_wa) (then (return (i32.const 1))))
    (local.set $ga (call $heap_alloc (i32.const 64)))
    (if (i32.eqz (local.get $ga)) (then (return (i32.const 0))))
    (local.set $wa (call $g2w (local.get $ga)))
    (memory.fill (local.get $wa) (i32.const 0) (i32.const 64))
    ;; Help Topics, Contents, Index, Display, Cancel, +, -, >.
    (i64.store (local.get $wa) (i64.const 0x706f5420706c6548))
    (i32.store offset=8 (local.get $wa) (i32.const 0x00736369))
    (i64.store offset=16 (local.get $wa) (i64.const 0x73746e65746e6f43))
    (i64.store offset=28 (local.get $wa) (i64.const 0x0000007865646e49))
    (i64.store offset=36 (local.get $wa) (i64.const 0x0079616c70736944))
    (i64.store offset=44 (local.get $wa) (i64.const 0x00006c65636e6143))
    (i32.store8 offset=52 (local.get $wa) (i32.const 43))
    (i32.store8 offset=54 (local.get $wa) (i32.const 45))
    (i32.store8 offset=56 (local.get $wa) (i32.const 62))
    (global.set $help_topics_labels_ga (local.get $ga))
    (global.set $help_topics_labels_wa (local.get $wa))
    (i32.const 1))

  (func $help_topics_destroy_window
    (if (global.get $help_topics_hwnd)
      (then
        ;; The children are real control windows with their own heap state
        ;; (ListBoxState item buffer, ButtonState text). $wnd_destroy_tree
        ;; delivers WM_DESTROY to each so that state is freed, which a bare
        ;; $wnd_table_remove on the parent would leak.
        (call $wnd_destroy_tree (global.get $help_topics_hwnd))
        (call $host_destroy_window (global.get $help_topics_hwnd))
        (global.set $help_topics_hwnd (i32.const 0))))
    (global.set $help_topics_list_hwnd (i32.const 0))
    (global.set $help_topics_tab_hwnd (i32.const 0))
    (if (global.get $help_topics_labels_ga)
      (then (call $heap_free (global.get $help_topics_labels_ga))))
    (global.set $help_topics_labels_ga (i32.const 0))
    (global.set $help_topics_labels_wa (i32.const 0))
    (if (global.get $help_topics_row_ga)
      (then (call $heap_free (global.get $help_topics_row_ga))))
    (global.set $help_topics_row_ga (i32.const 0))
    (global.set $help_topics_row_wa (i32.const 0)))

  (func $help_topics_cancel
    (if (i32.or
          (i32.eq (global.get $help_session_mode) (i32.const 3))
          (i32.eq (global.get $help_session_mode) (i32.const 4)))
      (then (global.set $help_session_mode (global.get $help_topics_return_mode))))
    (call $help_topics_destroy_window))

  ;; Build one row of list text into the shared scratch buffer and return its
  ;; guest pointer. $marker is the leading glyph ('+', '-' or '>', 0 for the
  ;; keyword list, which has no hierarchy), $indent the number of leading
  ;; spaces. LB_ADDSTRING copies the bytes, so one buffer serves every row.
  (func $help_topics_row_text
    (param $marker i32) (param $indent i32) (param $src_wa i32) (param $len i32)
    (result i32)
    (local $w i32) (local $i i32)
    (local.set $w (global.get $help_topics_row_wa))
    (if (i32.eqz (local.get $w)) (then (return (i32.const 0))))
    (if (i32.gt_u (local.get $indent) (i32.const 32))
      (then (local.set $indent (i32.const 32))))
    (block $pad_done (loop $pad
      (br_if $pad_done (i32.ge_u (local.get $i) (local.get $indent)))
      (i32.store8 (i32.add (local.get $w) (local.get $i)) (i32.const 32))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $pad)))
    (if (local.get $marker)
      (then
        (i32.store8 (i32.add (local.get $w) (local.get $i)) (local.get $marker))
        (i32.store8 (i32.add (local.get $w) (i32.add (local.get $i) (i32.const 1)))
          (i32.const 32))
        (local.set $i (i32.add (local.get $i) (i32.const 2)))))
    (if (i32.gt_u (local.get $len) (i32.const 200))
      (then (local.set $len (i32.const 200))))
    (if (local.get $len)
      (then (call $memcpy (i32.add (local.get $w) (local.get $i))
        (local.get $src_wa) (local.get $len))))
    (i32.store8 (i32.add (local.get $w) (i32.add (local.get $i) (local.get $len)))
      (i32.const 0))
    (global.get $help_topics_row_ga))

  ;; Refill the listbox from whichever model the current tab shows, then push
  ;; the model's selection into the control. Called on open, on tab switch, and
  ;; after anything that changes which rows are visible (expand/collapse).
  (func $help_topics_fill_list
    (local $lb i32) (local $row i32) (local $index i32) (local $node i32)
    (local $marker i32) (local $sel i32) (local $rec i32) (local $level i32)
    (local.set $lb (global.get $help_topics_list_hwnd))
    (if (i32.eqz (local.get $lb)) (then (return)))
    (drop (call $wnd_send_message
      (local.get $lb) (i32.const 0x0184) (i32.const 0) (i32.const 0)))  ;; LB_RESETCONTENT
    (local.set $sel (i32.const -1))
    (if (i32.eq (global.get $help_session_mode) (i32.const 3))
      (then
        (block $done (loop $rows
          (local.set $index (call $help_cnt_visible_at (local.get $row)))
          (br_if $done (i32.lt_s (local.get $index) (i32.const 0)))
          (local.set $node (call $help_cnt_node_address (local.get $index)))
          (br_if $done (i32.eqz (local.get $node)))
          ;; A node with a child index is a book: it expands instead of
          ;; navigating, so it carries '+' or '-' rather than the topic mark.
          (local.set $marker
            (if (result i32) (i32.ge_s (i32.load offset=4 (local.get $node)) (i32.const 0))
              (then (select (i32.const 45) (i32.const 43)
                (i32.ne (i32.and (i32.load16_u offset=14 (local.get $node))
                  (global.get $HELP_CNT_EXPANDED)) (i32.const 0))))
              (else (i32.const 62))))
          (local.set $level (i32.load16_u offset=12 (local.get $node)))
          (drop (call $wnd_send_message (local.get $lb) (i32.const 0x0180) (i32.const 0)
            (call $help_topics_row_text (local.get $marker)
              (i32.mul (select (i32.sub (local.get $level) (i32.const 1)) (i32.const 0)
                (i32.gt_u (local.get $level) (i32.const 0))) (i32.const 2))
              (i32.load offset=16 (local.get $node))
              (i32.load offset=20 (local.get $node)))))
          (if (i32.eq (local.get $index) (global.get $help_topics_contents_selection))
            (then (local.set $sel (local.get $row))))
          (local.set $row (i32.add (local.get $row) (i32.const 1)))
          (br $rows))))
      (else
        (block $keys_done (loop $keys
          (br_if $keys_done
            (i32.ge_u (local.get $row) (global.get $help_doc_keyword_count)))
          (local.set $rec (i32.add (global.get $help_doc_keywords_wa)
            (i32.mul (local.get $row) (global.get $HELP_KEYWORD_SIZE))))
          (drop (call $wnd_send_message (local.get $lb) (i32.const 0x0180) (i32.const 0)
            (call $help_topics_row_text (i32.const 0) (i32.const 0)
              (i32.add (global.get $help_doc_file_wa) (i32.load (local.get $rec)))
              (i32.load offset=4 (local.get $rec)))))
          (local.set $row (i32.add (local.get $row) (i32.const 1)))
          (br $keys)))
        (local.set $sel (global.get $help_session_keyword_index))))
    (drop (call $wnd_send_message
      (local.get $lb) (i32.const 0x0186) (local.get $sel) (i32.const 0)))  ;; LB_SETCURSEL
    (call $invalidate_hwnd (local.get $lb)))

  ;; Copy the listbox's own selection back into the help model. The control is
  ;; authoritative once the user has clicked or arrowed within it.
  (func $help_topics_sync_from_list
    (local $lb i32) (local $row i32) (local $index i32)
    (local.set $lb (global.get $help_topics_list_hwnd))
    (if (i32.eqz (local.get $lb)) (then (return)))
    (local.set $row (call $wnd_send_message
      (local.get $lb) (i32.const 0x0188) (i32.const 0) (i32.const 0)))  ;; LB_GETCURSEL
    (if (i32.lt_s (local.get $row) (i32.const 0)) (then (return)))
    (if (i32.eq (global.get $help_session_mode) (i32.const 3))
      (then
        (local.set $index (call $help_cnt_visible_at (local.get $row)))
        (if (i32.ge_s (local.get $index) (i32.const 0))
          (then (drop (call $help_topics_select_contents (local.get $index))))))
      (else
        (if (i32.lt_u (local.get $row) (global.get $help_doc_keyword_count))
          (then (global.set $help_session_keyword_index (local.get $row)))))))

  ;; Push the model's current tab into the tab control, so a switch made from
  ;; the keyboard shows on the strip too.
  (func $help_topics_update_tab_control
    (if (i32.eqz (global.get $help_topics_tab_hwnd)) (then (return)))
    (drop (call $wnd_send_message (global.get $help_topics_tab_hwnd)
      (i32.const 0x130C)   ;; TCM_SETCURSEL
      (select (i32.const 0) (i32.const 1)
        (i32.eq (global.get $help_session_mode) (i32.const 3)))
      (i32.const 0))))

  (func $help_topics_apply_tab (param $tab i32)
    (if (i32.eqz (call $help_topics_set_tab (local.get $tab))) (then (return)))
    (call $help_topics_update_tab_control)
    (call $help_topics_fill_list)
    (call $invalidate_hwnd (global.get $help_topics_hwnd)))

  ;; Tab strip wndproc (control class 27). COMCTL32's tab mirror has already
  ;; recorded the new selection by the time any message reaches here -
  ;; $wnd_send_message routes every message for a native-tab window through
  ;; $tab_native_note_message first - so the click handler just reads it back
  ;; rather than repeating the hit-test arithmetic.
  (func $help_topics_tab_wndproc
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32)
    (result i32)
    (local $tab i32)
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then (return (call $tab_native_paint (local.get $hwnd)))))
    (if (i32.or (i32.eq (local.get $msg) (i32.const 0x0201))
                (i32.eq (local.get $msg) (i32.const 0x0203)))
      (then
        (local.set $tab (call $tab_native_cursel (local.get $hwnd)))
        (if (i32.ge_s (local.get $tab) (i32.const 0))
          (then
            (if (i32.ne (local.get $tab)
                  (select (i32.const 0) (i32.const 1)
                    (i32.eq (global.get $help_session_mode) (i32.const 3))))
              (then
                (drop (call $help_topics_set_tab (local.get $tab)))
                (call $help_topics_fill_list)
                (call $invalidate_hwnd (global.get $help_topics_hwnd))))))
        (return (i32.const 0))))
    (i32.const 0))

  ;; Add one tab. TCM_INSERTITEMA reads a TCITEM whose mask says TCIF_TEXT and
  ;; whose pszText is at +12.
  (func $help_topics_add_tab (param $tab_hwnd i32) (param $index i32) (param $text_ga i32)
    (local $item_ga i32) (local $item_wa i32)
    (local.set $item_ga (call $heap_alloc (i32.const 40)))
    (if (i32.eqz (local.get $item_ga)) (then (return)))
    (local.set $item_wa (call $g2w (local.get $item_ga)))
    (memory.fill (local.get $item_wa) (i32.const 0) (i32.const 40))
    (i32.store (local.get $item_wa) (i32.const 1))            ;; TCIF_TEXT
    (i32.store offset=12 (local.get $item_wa) (local.get $text_ga))
    (drop (call $wnd_send_message (local.get $tab_hwnd)
      (i32.const 0x1307) (local.get $index) (local.get $item_ga)))  ;; TCM_INSERTITEMA
    (call $heap_free (local.get $item_ga)))

  (func $help_topics_show
    (local $hwnd i32)
    (if (i32.eqz (call $help_topics_init_labels)) (then (return)))
    (if (global.get $help_topics_hwnd)
      (then
        (call $help_topics_fill_list)
        (call $invalidate_hwnd (global.get $help_topics_hwnd))
        (return)))
    (global.set $help_topics_row_ga (call $heap_alloc (i32.const 256)))
    (if (i32.eqz (global.get $help_topics_row_ga)) (then (return)))
    (global.set $help_topics_row_wa (call $g2w (global.get $help_topics_row_ga)))
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    ;; Same construction order every WAT-built dialog uses: register the frame
    ;; with the renderer, install the window record, establish the client rect
    ;; and chrome, then create children. Registering as a dialog frame is what
    ;; gives this window a caption, a border, a close box and - through
    ;; $dialog_route_mouse - mouse delivery to its child controls.
    (call $host_register_dialog_frame
      (local.get $hwnd) (global.get $help_session_owner)
      (global.get $help_topics_labels_wa)
      (i32.const 400) (i32.const 300)
      (i32.const 1))
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_WAT_NATIVE))
    (call $title_table_set (local.get $hwnd)
      (global.get $help_topics_labels_wa) (i32.const 11))
    (call $wnd_set_owner (local.get $hwnd) (global.get $help_session_owner))
    (drop (call $wnd_set_style (local.get $hwnd) (i32.const 0x90C80000)))
    (global.set $help_topics_hwnd (local.get $hwnd))
    (call $defwndproc_do_nccalcsize (local.get $hwnd))
    (call $defwndproc_do_ncpaint (local.get $hwnd))
    (call $nc_flags_set (local.get $hwnd) (i32.const 3))
    (call $dlg_fill_bkgnd (local.get $hwnd))
    ;; Tab strip. Control class 27 routes it to $help_topics_tab_wndproc; the
    ;; native-tab bit is what makes COMCTL32's mirror observe the TCM_* traffic
    ;; and paint the Win98 tab chrome.
    (global.set $help_topics_tab_hwnd
      (call $ctrl_create_child (local.get $hwnd) (i32.const 27)
        (global.get $HELP_TOPICS_ID_TABS)
        (i32.const 8) (i32.const 8) (i32.const 384) (i32.const 236)
        (i32.const 0x50000000) (i32.const 0)))
    (call $tab_native_mark_slot
      (call $wnd_table_find (global.get $help_topics_tab_hwnd)) (i32.const 1))
    (call $help_topics_add_tab (global.get $help_topics_tab_hwnd) (i32.const 0)
      (i32.add (global.get $help_topics_labels_ga) (i32.const 16)))
    (call $help_topics_add_tab (global.get $help_topics_tab_hwnd) (i32.const 1)
      (i32.add (global.get $help_topics_labels_ga) (i32.const 28)))
    ;; Row list - WS_VSCROLL so the listbox draws and drives its own scrollbar,
    ;; LBS_NOTIFY so selection and double-click reach this dialog as WM_COMMAND.
    ;; It sits inside the tab control's page area as a sibling, which is how
    ;; the renderer composites it above the page frame.
    (global.set $help_topics_list_hwnd
      (call $ctrl_create_child (local.get $hwnd) (i32.const 4)
        (global.get $HELP_TOPICS_ID_LIST)
        (i32.const 20) (i32.const 40) (i32.const 360) (i32.const 192)
        (i32.const 0x50A10001) (i32.const 0)))
    (drop (call $ctrl_create_child (local.get $hwnd) (i32.const 1)
      (global.get $HELP_TOPICS_ID_DISPLAY)
      (i32.const 216) (i32.const 252) (i32.const 80) (i32.const 24)
      (i32.const 0x50010001)
      (i32.add (global.get $help_topics_labels_ga) (i32.const 36))))
    (drop (call $ctrl_create_child (local.get $hwnd) (i32.const 1)
      (global.get $HELP_TOPICS_ID_CANCEL)
      (i32.const 304) (i32.const 252) (i32.const 80) (i32.const 24)
      (i32.const 0x50010000)
      (i32.add (global.get $help_topics_labels_ga) (i32.const 44))))
    (call $help_topics_update_tab_control)
    (call $help_topics_fill_list)
    (call $nc_flags_clear (local.get $hwnd) (i32.const 2))
    (drop (call $host_erase_background (local.get $hwnd) (i32.const 16)))
    (drop (call $paint_flush_visible_native_children (local.get $hwnd)))
    (call $invalidate_hwnd (local.get $hwnd)))

  (func $help_topics_present_activation (param $hwnd i32)
    (local $result i32)
    (local.set $result (call $help_topics_activate (global.get $help_session_owner)))
    (if (i32.eq (local.get $result) (i32.const 1))
      (then
        (call $help_topics_destroy_window)
        (call $help_present_dispatch (i32.const 1)
          (global.get $help_session_last_command))
        (return)))
    ;; 2 = the selection was a book, and activating it expanded or collapsed
    ;; it. That changes which rows exist, so the listbox is rebuilt.
    (if (i32.eq (local.get $result) (i32.const 2))
      (then
        (call $help_topics_fill_list)
        (call $invalidate_hwnd (local.get $hwnd)))))

  (func $help_topics_wndproc
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32)
    (result i32)
    (local $cmd i32) (local $notif i32)
    (local $node i32) (local $parent i32)
    ;; WM_ERASEBKGND - the dialog's own client area is a plain button-face
    ;; fill; every pixel that carries information belongs to a child control.
    (if (i32.eq (local.get $msg) (i32.const 0x0014))
      (then (return (call $host_erase_background (local.get $hwnd) (i32.const 16)))))
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then (return (i32.const 0))))
    ;; Title-bar X: WM_NCLBUTTONDOWN/HTCLOSE -> WM_SYSCOMMAND/SC_CLOSE ->
    ;; WM_CLOSE, the same translation $about_wndproc performs for a WAT dialog
    ;; that does not run through DefWindowProcA.
    (if (i32.and
          (i32.eq (local.get $msg) (i32.const 0x00A1))
          (i32.eq (local.get $wParam) (i32.const 20)))
      (then
        (drop (call $wnd_send_message
          (local.get $hwnd) (i32.const 0x0112) (i32.const 0xF060) (i32.const 0)))
        (return (i32.const 0))))
    (if (i32.and
          (i32.eq (local.get $msg) (i32.const 0x0112))
          (i32.eq (i32.and (local.get $wParam) (i32.const 0xFFF0)) (i32.const 0xF060)))
      (then
        (drop (call $wnd_send_message
          (local.get $hwnd) (i32.const 0x0010) (i32.const 0) (i32.const 0)))
        (return (i32.const 0))))
    ;; WM_COMMAND from the child controls: the tab buttons, the row list, and
    ;; Display / Cancel.
    (if (i32.eq (local.get $msg) (i32.const 0x0111))
      (then
        (local.set $cmd (i32.and (local.get $wParam) (i32.const 0xFFFF)))
        (local.set $notif (i32.shr_u (local.get $wParam) (i32.const 16)))
        (if (i32.eq (local.get $cmd) (global.get $HELP_TOPICS_ID_LIST))
          (then
            (call $help_topics_sync_from_list)
            ;; LBN_DBLCLK = 2. Double-clicking a row is the shortcut for
            ;; selecting it and pressing Display.
            (if (i32.eq (local.get $notif) (i32.const 2))
              (then (call $help_topics_present_activation (local.get $hwnd))))
            (return (i32.const 0))))
        (if (i32.eq (local.get $cmd) (global.get $HELP_TOPICS_ID_DISPLAY))
          (then
            (call $help_topics_sync_from_list)
            (call $help_topics_present_activation (local.get $hwnd))
            (return (i32.const 0))))
        (if (i32.eq (local.get $cmd) (global.get $HELP_TOPICS_ID_CANCEL))
          (then (call $help_topics_cancel) (return (i32.const 0))))
        (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0100))
      (then
        (if (i32.eq (local.get $wParam) (i32.const 0x26))
          (then (drop (call $help_topics_move_selection (i32.const -1)))))
        (if (i32.eq (local.get $wParam) (i32.const 0x28))
          (then (drop (call $help_topics_move_selection (i32.const 1)))))
        (if (i32.eq (local.get $wParam) (i32.const 0x21))
          (then (drop (call $help_topics_move_selection (i32.const -13)))))
        (if (i32.eq (local.get $wParam) (i32.const 0x22))
          (then (drop (call $help_topics_move_selection (i32.const 13)))))
        (if (i32.eq (local.get $wParam) (i32.const 0x09))
          (then (call $help_topics_apply_tab
            (select (i32.const 0) (i32.const 1)
              (i32.eq (global.get $help_session_mode) (i32.const 4))))))
        (if (i32.eq (local.get $wParam) (i32.const 0x27))
          (then
            (if (i32.eq (global.get $help_session_mode) (i32.const 3))
              (then (drop (call $help_topics_expand_contents
                (global.get $help_topics_contents_selection) (i32.const 2)))))))
        (if (i32.eq (local.get $wParam) (i32.const 0x25))
          (then
            (if (i32.eq (global.get $help_session_mode) (i32.const 3))
              (then
                (local.set $node (call $help_cnt_node_address
                  (global.get $help_topics_contents_selection)))
                (if (local.get $node)
                  (then
                    (if (i32.and
                          (i32.ne (i32.and (i32.load16_u offset=14 (local.get $node))
                            (global.get $HELP_CNT_EXPANDED)) (i32.const 0))
                          (i32.ge_s (i32.load offset=4 (local.get $node)) (i32.const 0)))
                      (then (drop (call $help_topics_expand_contents
                        (global.get $help_topics_contents_selection) (i32.const 1))))
                      (else
                        (local.set $parent (i32.load (local.get $node)))
                        (if (i32.ge_s (local.get $parent) (i32.const 0))
                          (then (drop (call $help_topics_select_contents
                            (local.get $parent)))))))))))))
        (if (i32.eq (local.get $wParam) (i32.const 0x0D))
          (then (call $help_topics_present_activation (local.get $hwnd))))
        (if (i32.eq (local.get $wParam) (i32.const 0x1B))
          (then (call $help_topics_cancel)))
        ;; Arrow keys, expand/collapse and Tab all change the model rather than
        ;; the control, so the listbox is rebuilt from it afterwards. Keys that
        ;; closed the dialog leave $help_topics_hwnd cleared - do not touch a
        ;; destroyed window.
        (if (global.get $help_topics_hwnd)
          (then
            (call $help_topics_fill_list)
            (call $invalidate_hwnd (local.get $hwnd))))
        (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0010))
      (then (call $help_topics_cancel) (return (i32.const 0))))
    (i32.const 0))

  (func (export "get_help_topics_hwnd") (result i32)
    (global.get $help_topics_hwnd))
  (func (export "get_help_topics_list_hwnd") (result i32)
    (global.get $help_topics_list_hwnd))
  (func (export "get_help_topics_control") (param $id i32) (result i32)
    (if (i32.eqz (global.get $help_topics_hwnd)) (then (return (i32.const 0))))
    (call $ctrl_find_by_id (global.get $help_topics_hwnd) (local.get $id)))
  (func (export "test_help_topics_message")
    (param $msg i32) (param $wparam i32) (param $lparam i32) (result i32)
    (if (i32.eqz (global.get $help_topics_hwnd))
      (then (return (i32.const 0))))
    (call $help_topics_wndproc (global.get $help_topics_hwnd)
      (local.get $msg) (local.get $wparam) (local.get $lparam)))
