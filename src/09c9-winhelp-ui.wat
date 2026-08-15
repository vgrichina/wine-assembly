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

  ;; Private two-pass layout channel. A zero output pointer counts and
  ;; validates exact run requirements without writing any records.
  (global $help_layout_out (mut i32) (i32.const 0))
  (global $help_layout_capacity (mut i32) (i32.const 0))
  (global $help_layout_count (mut i32) (i32.const 0))
  (global $help_layout_extent (mut i32) (i32.const 0))

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
        (i32.store offset=36 (local.get $run) (local.get $flags))))
    (global.set $help_layout_count
      (i32.add (global.get $help_layout_count) (i32.const 1)))
    (i32.const 1))

  (func $help_layout_font_height (param $font_index i32) (result i32)
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
    (i32.add (local.get $height) (i32.const 3)))

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

  ;; Convert a validated formatted-token stream into deterministic positioned
  ;; runs. It owns wrapping, line state, font metadata, colors, and hotspot
  ;; membership; painting consumes the published records without reparsing.
  (func $help_layout_tokens_core
    (param $raw i32) (param $raw_len i32)
    (param $tokens i32) (param $token_count i32)
    (param $runs i32) (param $run_capacity i32)
    (param $client_width i32) (param $hdc i32) (result i32)
    (local $memory_bytes i32) (local $token i32) (local $kind i32)
    (local $off i32) (local $len i32) (local $value i32)
    (local $i i32) (local $pos i32) (local $span i32) (local $ch i32)
    (local $x i32) (local $y i32) (local $right i32)
    (local $width i32) (local $fit i32) (local $line_height i32)
    (local $font_index i32) (local $color i32) (local $hotspot i32)
    (local $saw_content i32) (local $ended i32)
    (global.set $help_layout_count (i32.const 0))
    (global.set $help_layout_extent (i32.const 0))
    (global.set $help_layout_out (local.get $runs))
    (global.set $help_layout_capacity (local.get $run_capacity))
    (local.set $memory_bytes (i32.shl (memory.size) (i32.const 16)))
    (if (i32.or
          (i32.or (i32.lt_u (local.get $client_width) (i32.const 32))
                  (i32.gt_u (local.get $client_width) (i32.const 4096)))
          (i32.or
            (i32.gt_u (local.get $token_count) (global.get $HELP_MAX_TOPIC_TOKENS))
            (i32.gt_u (local.get $run_capacity) (global.get $HELP_MAX_LAYOUT_RUNS))))
      (then (return (i32.const -1))))
    (if (i32.or
          (i32.or (i32.gt_u (local.get $raw) (local.get $memory_bytes))
                  (i32.gt_u (local.get $raw_len)
                    (i32.sub (local.get $memory_bytes) (local.get $raw))))
          (i32.or (i32.gt_u (local.get $tokens) (local.get $memory_bytes))
                  (i32.gt_u (local.get $token_count)
                    (i32.div_u (i32.sub (local.get $memory_bytes) (local.get $tokens))
                      (global.get $HELP_TOPIC_TOKEN_SIZE)))))
      (then (return (i32.const -1))))
    (if (i32.and (local.get $runs)
          (i32.or (i32.gt_u (local.get $runs) (local.get $memory_bytes))
                  (i32.gt_u (local.get $run_capacity)
                    (i32.div_u (i32.sub (local.get $memory_bytes) (local.get $runs))
                      (global.get $HELP_LAYOUT_RUN_SIZE)))))
      (then (return (i32.const -1))))
    (local.set $x (i32.const 8))
    (local.set $y (i32.const 8))
    (local.set $right (i32.sub (local.get $client_width) (i32.const 8)))
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
          (local.set $ended (i32.const 1))
          (br $done)))
      (if (i32.eq (local.get $kind) (global.get $HELP_TOKEN_PARAGRAPH))
        (then
          (if (local.get $saw_content)
            (then
              (local.set $y (i32.add (local.get $y) (local.get $line_height)))
              (local.set $x (i32.const 8))))
          (local.set $line_height (i32.const 16))))
      (if (i32.eq (local.get $kind) (global.get $HELP_TOKEN_FONT))
        (then
          (if (i32.ge_u (local.get $value) (global.get $help_doc_font_count))
            (then (return (i32.const -1))))
          (local.set $font_index (local.get $value))
          (local.set $line_height (call $help_layout_font_height (local.get $value)))
          (local.set $color (i32.load offset=20
            (i32.add (global.get $help_doc_fonts_wa)
              (i32.mul (local.get $value) (global.get $HELP_FONT_SIZE)))))))
      (if (i32.eq (local.get $kind) (global.get $HELP_TOKEN_COLOR))
        (then (local.set $color (local.get $value))))
      (if (i32.eq (local.get $kind) (global.get $HELP_TOKEN_HOTSPOT_BEGIN))
        (then (local.set $hotspot (i32.const 1))))
      (if (i32.eq (local.get $kind) (global.get $HELP_TOKEN_HOTSPOT_END))
        (then (local.set $hotspot (i32.const 0))))
      (if (i32.eq (local.get $kind) (global.get $HELP_TOKEN_LINE_BREAK))
        (then
          (local.set $y (i32.add (local.get $y) (local.get $line_height)))
          (local.set $x (i32.const 8))
          (local.set $saw_content (i32.const 1))))
      (if (i32.eq (local.get $kind) (global.get $HELP_TOKEN_SPACE))
        (then
          (local.set $width (select (i32.const 8) (i32.const 4)
            (i32.eq (local.get $value) (i32.const 0x8B))))
          (if (i32.and (i32.gt_u (local.get $x) (i32.const 8))
                (i32.gt_u (i32.add (local.get $x) (local.get $width)) (local.get $right)))
            (then
              (local.set $y (i32.add (local.get $y) (local.get $line_height)))
              (local.set $x (i32.const 8))))
          (if (i32.eqz (call $help_layout_emit
                (global.get $HELP_LAYOUT_SPACE) (local.get $x) (local.get $y)
                (local.get $width) (local.get $line_height)
                (i32.const 0) (i32.const 0) (local.get $font_index)
                (local.get $color) (local.get $hotspot)))
            (then (return (i32.const -1))))
          (local.set $x (i32.add (local.get $x) (local.get $width)))
          (local.set $saw_content (i32.const 1))))
      (if (i32.eq (local.get $kind) (global.get $HELP_TOKEN_BITMAP))
        (then
          ;; Preserve a positioned placeholder until bitmap materialization.
          (if (i32.gt_u (i32.add (local.get $x) (i32.const 16)) (local.get $right))
            (then
              (local.set $y (i32.add (local.get $y) (local.get $line_height)))
              (local.set $x (i32.const 8))))
          (if (i32.eqz (call $help_layout_emit
                (global.get $HELP_LAYOUT_BITMAP) (local.get $x) (local.get $y)
                (i32.const 16) (i32.const 16) (local.get $off) (local.get $len)
                (local.get $font_index) (local.get $color) (local.get $hotspot)))
            (then (return (i32.const -1))))
          (local.set $x (i32.add (local.get $x) (i32.const 16)))
          (local.set $saw_content (i32.const 1))))
      (if (i32.eq (local.get $kind) (global.get $HELP_TOKEN_TEXT))
        (then
          (if (i32.gt_u (local.get $off) (local.get $raw_len))
            (then (return (i32.const -1))))
          (if (i32.gt_u (local.get $len) (i32.sub (local.get $raw_len) (local.get $off)))
            (then (return (i32.const -1))))
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
                (if (i32.and (i32.gt_u (local.get $x) (i32.const 8))
                      (i32.gt_u (i32.add (local.get $x) (local.get $width)) (local.get $right)))
                  (then
                    (local.set $y (i32.add (local.get $y) (local.get $line_height)))
                    (local.set $x (i32.const 8))))
                (if (i32.eqz (call $help_layout_emit
                      (global.get $HELP_LAYOUT_SPACE) (local.get $x) (local.get $y)
                      (local.get $width) (local.get $line_height)
                      (i32.add (local.get $off) (local.get $pos)) (i32.const 1)
                      (local.get $font_index) (local.get $color) (local.get $hotspot)))
                  (then (return (i32.const -1))))
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
                  (if (i32.and (i32.gt_u (local.get $x) (i32.const 8))
                        (i32.gt_u (i32.add (local.get $x) (local.get $width)) (local.get $right)))
                    (then
                      (local.set $y (i32.add (local.get $y) (local.get $line_height)))
                      (local.set $x (i32.const 8))))
                  (local.set $fit (local.get $span))
                  (if (i32.gt_u (i32.add (local.get $x) (local.get $width)) (local.get $right))
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
                    (then (return (i32.const -1))))
                  (local.set $x (i32.add (local.get $x) (local.get $width)))
                  (local.set $pos (i32.add (local.get $pos) (local.get $fit)))
                  (local.set $span (i32.sub (local.get $span) (local.get $fit)))
                  (local.set $saw_content (i32.const 1))
                  (if (local.get $span)
                    (then
                      (local.set $y (i32.add (local.get $y) (local.get $line_height)))
                      (local.set $x (i32.const 8))))
                  (br $span_loop)))))
            (br $text_loop)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $tokens_loop)))
    (if (i32.eqz (local.get $ended)) (then (return (i32.const -1))))
    (global.set $help_layout_extent
      (i32.add (local.get $y) (local.get $line_height)))
    (global.get $help_layout_count))

  ;; Public/internal entry point with an exact counting pass before any write.
  ;; Insufficient capacity therefore cannot leave a partial positioned list.
  (func $help_layout_tokens
    (param $raw i32) (param $raw_len i32)
    (param $tokens i32) (param $token_count i32)
    (param $runs i32) (param $run_capacity i32)
    (param $client_width i32) (param $hdc i32) (result i32)
    (local $required i32)
    (if (local.get $runs)
      (then
        (local.set $required (call $help_layout_tokens_core
          (local.get $raw) (local.get $raw_len)
          (local.get $tokens) (local.get $token_count)
          (i32.const 0) (global.get $HELP_MAX_LAYOUT_RUNS)
          (local.get $client_width) (local.get $hdc)))
        (if (i32.or (i32.lt_s (local.get $required) (i32.const 0))
              (i32.gt_u (local.get $required) (local.get $run_capacity)))
          (then (return (i32.const -1))))))
    (call $help_layout_tokens_core
      (local.get $raw) (local.get $raw_len)
      (local.get $tokens) (local.get $token_count)
      (local.get $runs) (local.get $run_capacity)
      (local.get $client_width) (local.get $hdc)))

  (func $help_typed_view_release
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
    (global.set $help_topic_wa (i32.const 0))
    (global.set $help_topic_len (i32.const 0)))

  ;; Decode, tokenize, lay out, and publish a topic as one viewer transaction.
  ;; Runtime rendering currently caps a single decoded topic at 64 KiB; the
  ;; parser's larger archival cap remains available to caller-owned APIs.
  (func $help_replace_typed_view (param $topic_index i32) (result i32)
    (local $raw_ga i32) (local $raw_wa i32) (local $raw_len i32)
    (local $tokens_ga i32) (local $tokens_wa i32) (local $token_count i32)
    (local $payload_ga i32) (local $payload_wa i32) (local $payload_len i32)
    (local $runs_ga i32) (local $runs_wa i32) (local $run_count i32)
    (local $hdc i32) (local $ok i32)
    (block $cleanup
    (local.set $raw_ga (call $heap_alloc (i32.const 65536)))
    (if (i32.eqz (local.get $raw_ga)) (then (return (i32.const 0))))
    (local.set $raw_wa (call $g2w (local.get $raw_ga)))
    (local.set $raw_len (call $help_decode_topic_raw
      (local.get $topic_index) (local.get $raw_wa) (i32.const 65536)))
    (if (i32.lt_s (local.get $raw_len) (i32.const 0)) (then (br $cleanup)))
    ;; Deliberately request zero output capacities: the formatted decoder's
    ;; first pass leaves exact token/payload requirements in its private channel.
    (drop (call $help_decode_topic_formatted
      (local.get $topic_index) (local.get $raw_wa) (i32.const 65536)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
    (local.set $token_count (global.get $help_fmt_token_count))
    (local.set $payload_len (global.get $help_fmt_payload_used))
    (if (i32.or (i32.eqz (local.get $token_count))
          (i32.gt_u (local.get $token_count) (global.get $HELP_MAX_TOPIC_TOKENS)))
      (then (br $cleanup)))
    (local.set $tokens_ga (call $heap_alloc
      (i32.mul (local.get $token_count) (global.get $HELP_TOPIC_TOKEN_SIZE))))
    (if (i32.eqz (local.get $tokens_ga)) (then (br $cleanup)))
    (local.set $tokens_wa (call $g2w (local.get $tokens_ga)))
    (if (local.get $payload_len)
      (then
        (local.set $payload_ga (call $heap_alloc (local.get $payload_len)))
        (if (i32.eqz (local.get $payload_ga)) (then (br $cleanup)))
        (local.set $payload_wa (call $g2w (local.get $payload_ga)))))
    (if (i32.lt_s (call $help_decode_topic_formatted
          (local.get $topic_index) (local.get $raw_wa) (i32.const 65536)
          (local.get $tokens_wa) (local.get $token_count)
          (local.get $payload_wa) (local.get $payload_len)) (i32.const 0))
      (then (br $cleanup)))
    (local.set $hdc (i32.add
      (select (global.get $help_hwnd) (global.get $next_hwnd)
        (i32.ne (global.get $help_hwnd) (i32.const 0)))
      (i32.const 0x40000)))
    (local.set $run_count (call $help_layout_tokens
      (local.get $raw_wa) (local.get $raw_len)
      (local.get $tokens_wa) (local.get $token_count)
      (i32.const 0) (global.get $HELP_MAX_LAYOUT_RUNS)
      (i32.const 400) (local.get $hdc)))
    (if (i32.lt_s (local.get $run_count) (i32.const 0)) (then (br $cleanup)))
    (if (local.get $run_count)
      (then
        (local.set $runs_ga (call $heap_alloc
          (i32.mul (local.get $run_count) (global.get $HELP_LAYOUT_RUN_SIZE))))
        (if (i32.eqz (local.get $runs_ga)) (then (br $cleanup)))
        (local.set $runs_wa (call $g2w (local.get $runs_ga)))))
    (if (i32.ne (call $help_layout_tokens
          (local.get $raw_wa) (local.get $raw_len)
          (local.get $tokens_wa) (local.get $token_count)
          (local.get $runs_wa) (local.get $run_count)
          (i32.const 400) (local.get $hdc)) (local.get $run_count))
      (then (br $cleanup)))
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
    (global.set $help_view_layout_width (i32.const 400))
    (global.set $help_last_error (global.get $HELP_ERROR_NONE))
    (global.set $help_last_error_offset (i32.const 0))
    (local.set $raw_ga (i32.const 0))
    (local.set $tokens_ga (i32.const 0))
    (local.set $payload_ga (i32.const 0))
    (local.set $runs_ga (i32.const 0))
    (local.set $ok (i32.const 1)))
    (if (local.get $runs_ga) (then (call $heap_free (local.get $runs_ga))))
    (if (local.get $payload_ga) (then (call $heap_free (local.get $payload_ga))))
    (if (local.get $tokens_ga) (then (call $heap_free (local.get $tokens_ga))))
    (if (local.get $raw_ga) (then (call $heap_free (local.get $raw_ga))))
    (local.get $ok))

  (func $help_paint_typed_view (param $hdc i32)
    (local $i i32) (local $run i32) (local $kind i32)
    (local $y i32) (local $height i32) (local $color i32)
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
                     (i32.lt_s (local.get $y) (i32.const 272))))
        (then
          (local.set $color (i32.load offset=32 (local.get $run)))
          (if (i32.load offset=36 (local.get $run))
            (then (local.set $color (i32.const 0xFF0000))))
          (drop (call $host_gdi_set_text_color (local.get $hdc) (local.get $color)))
          (drop (call $host_gdi_text_out
            (local.get $hdc) (i32.load offset=4 (local.get $run)) (local.get $y)
            (i32.add (global.get $help_topic_wa) (i32.load offset=20 (local.get $run)))
            (i32.load offset=24 (local.get $run)) (i32.const 0)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $runs))))

  (func (export "test_help_layout_tokens")
    (param $raw i32) (param $raw_len i32)
    (param $tokens i32) (param $token_count i32)
    (param $runs i32) (param $run_capacity i32)
    (param $width i32) (result i32)
    (call $help_layout_tokens
      (local.get $raw) (local.get $raw_len)
      (local.get $tokens) (local.get $token_count)
      (local.get $runs) (local.get $run_capacity)
      (local.get $width) (i32.const 0x40001)))
  (func (export "get_help_layout_extent") (result i32)
    (global.get $help_layout_extent))
  (func (export "get_help_view_run_count") (result i32)
    (global.get $help_view_run_count))
  (func (export "get_help_view_run_ptr") (result i32)
    (global.get $help_view_runs_wa))
  (func (export "get_help_view_extent_height") (result i32)
    (global.get $help_view_extent_height))
