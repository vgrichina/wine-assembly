  ;; ---- Bounded HLP outer-file and directory B+tree parser ------------

  ;; Private result channel for semantic B+tree parsers. Results remain
  ;; candidates until $help_parse_semantic_indexes publishes all indexes.
  (global $help_semantic_result_ga (mut i32) (i32.const 0))
  (global $help_semantic_result_wa (mut i32) (i32.const 0))
  (global $help_semantic_result_count (mut i32) (i32.const 0))
  (global $help_phrase_result_offsets_ga (mut i32) (i32.const 0))
  (global $help_phrase_result_offsets_wa (mut i32) (i32.const 0))
  (global $help_phrase_result_image_ga (mut i32) (i32.const 0))
  (global $help_phrase_result_image_wa (mut i32) (i32.const 0))
  (global $help_phrase_result_count (mut i32) (i32.const 0))
  (global $help_phrase_result_image_size (mut i32) (i32.const 0))
  (global $help_font_result_faces_ga (mut i32) (i32.const 0))
  (global $help_font_result_faces_wa (mut i32) (i32.const 0))
  (global $help_font_result_fonts_ga (mut i32) (i32.const 0))
  (global $help_font_result_fonts_wa (mut i32) (i32.const 0))
  (global $help_font_result_face_count (mut i32) (i32.const 0))
  (global $help_font_result_font_count (mut i32) (i32.const 0))
  (global $help_font_result_metric_mode (mut i32) (i32.const 0))
  (global $help_bitmap_result_ga (mut i32) (i32.const 0))
  (global $help_bitmap_result_wa (mut i32) (i32.const 0))
  (global $help_bitmap_result_count (mut i32) (i32.const 0))
  (global $help_bitmap_decode_out_pos (mut i32) (i32.const 0))
  (global $help_bitmap_decode_rle_count (mut i32) (i32.const 0))
  (global $help_bitmap_decode_rle (mut i32) (i32.const 0))
  (global $help_bitmap_decode_lz_pos (mut i32) (i32.const 0))
  (global $help_keyword_result_keywords_ga (mut i32) (i32.const 0))
  (global $help_keyword_result_keywords_wa (mut i32) (i32.const 0))
  (global $help_keyword_result_keyword_count (mut i32) (i32.const 0))
  (global $help_keyword_result_postings_ga (mut i32) (i32.const 0))
  (global $help_keyword_result_postings_wa (mut i32) (i32.const 0))
  (global $help_keyword_result_posting_count (mut i32) (i32.const 0))
  (global $help_phrase_bit_position (mut i32) (i32.const 0))
  (global $help_topic_block_result_size (mut i32) (i32.const 0))
  (global $help_ld1_value (mut i32) (i32.const 0))
  (global $help_ld1_next (mut i32) (i32.const 0))
  ;; Private state for the two-pass formatted-topic builder. The first pass
  ;; counts exact output requirements; the second writes caller-owned arenas.
  (global $help_fmt_raw_out (mut i32) (i32.const 0))
  (global $help_fmt_tokens_out (mut i32) (i32.const 0))
  (global $help_fmt_payload_out (mut i32) (i32.const 0))
  (global $help_fmt_token_count (mut i32) (i32.const 0))
  (global $help_fmt_payload_used (mut i32) (i32.const 0))
  (global $help_fmt_emit (mut i32) (i32.const 0))

  (func $help_mark_btree_page
    (param $visited i32) (param $page i32) (result i32)
    (local $byte_ptr i32) (local $mask i32) (local $value i32)
    (local.set $byte_ptr (i32.add (local.get $visited) (i32.shr_u (local.get $page) (i32.const 3))))
    (local.set $mask (i32.shl (i32.const 1) (i32.and (local.get $page) (i32.const 7))))
    (local.set $value (i32.load8_u (local.get $byte_ptr)))
    (if (i32.and (local.get $value) (local.get $mask))
      (then (return (i32.const 0))))
    (i32.store8 (local.get $byte_ptr) (i32.or (local.get $value) (local.get $mask)))
    (i32.const 1))

  (func $help_validate_internal_file
    (param $root_slice i32) (param $file_off i32) (param $record i32)
    (result i32)
    (local $p i32) (local $reserved i32) (local $used i32)
    (local.set $p (call $help_slice_address
      (local.get $root_slice) (local.get $file_off) (i32.const 9)))
    (if (i32.eqz (local.get $p))
      (then
        (call $help_set_error (global.get $HELP_ERROR_BAD_FILE_HEADER) (local.get $file_off))
        (return (i32.const 0))))
    (local.set $reserved (i32.load (local.get $p)))
    (local.set $used (i32.load offset=4 (local.get $p)))
    (if (i32.lt_u (local.get $reserved) (i32.const 9))
      (then
        (call $help_set_error (global.get $HELP_ERROR_BAD_FILE_HEADER) (local.get $file_off))
        (return (i32.const 0))))
    (if (i32.gt_u (local.get $used) (i32.sub (local.get $reserved) (i32.const 9)))
      (then
        (call $help_set_error (global.get $HELP_ERROR_BAD_FILE_HEADER) (i32.add (local.get $file_off) (i32.const 4)))
        (return (i32.const 0))))
    (if (i32.eqz (call $help_slice_address
          (local.get $root_slice) (local.get $file_off) (local.get $reserved)))
      (then
        (call $help_set_error (global.get $HELP_ERROR_BAD_FILE_HEADER) (local.get $file_off))
        (return (i32.const 0))))
    (i32.store16 offset=10 (local.get $record) (i32.load8_u offset=8 (local.get $p)))
    (i32.store offset=12 (local.get $record) (i32.add (local.get $file_off) (i32.const 9)))
    (i32.store offset=16 (local.get $record) (local.get $used))
    (i32.const 1))

  (func $help_parse_directory (result i32)
    (local $root i32) (local $scratch i32) (local $outer i32)
    (local $entire_size i32) (local $dir_off i32) (local $dir_ifh i32)
    (local $reserved i32) (local $used i32) (local $bt i32)
    (local $page_size i32) (local $total_pages i32) (local $levels i32)
    (local $total_entries i32) (local $root_page i32) (local $page_bytes i32)
    (local $pages_off i32) (local $page_num i32) (local $page_ptr i32)
    (local $page_slice i32) (local $unused i32) (local $entries i32)
    (local $previous i32) (local $next i32) (local $depth i32)
    (local $entry_ptr i32) (local $entry_rel i32) (local $used_end i32)
    (local $name_len i32) (local $name_off i32) (local $file_off i32)
    (local $record i32) (local $prev_record i32) (local $count i32)
    (local $visited_ga i32) (local $visited_wa i32) (local $visited_bytes i32)
    (local $directory_ga i32) (local $ok i32)

    (local.set $root (global.get $help_doc_meta_wa))
    (local.set $scratch (i32.add (local.get $root) (i32.const 16)))

    (block $done
      (if (i32.lt_u (global.get $help_doc_file_size) (i32.const 16))
        (then
          (call $help_set_error (global.get $HELP_ERROR_BAD_OUTER_HEADER) (i32.const 0))
          (br $done)))
      (local.set $outer (call $help_slice_address (local.get $root) (i32.const 0) (i32.const 16)))
      (if (i32.ne (i32.load (local.get $outer)) (i32.const 0x00035F3F))
        (then
          (call $help_set_error (global.get $HELP_ERROR_BAD_OUTER_HEADER) (i32.const 0))
          (br $done)))
      (local.set $entire_size (i32.load offset=12 (local.get $outer)))
      (if (i32.or
            (i32.lt_u (local.get $entire_size) (i32.const 16))
            (i32.gt_u (local.get $entire_size) (global.get $help_doc_file_size)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_BAD_OUTER_HEADER) (i32.const 12))
          (br $done)))
      ;; Narrow the root slice to the logical EntireFileSize. Trailing caller
      ;; bytes cannot be reached by any subsequent parser operation.
      (i32.store offset=4 (local.get $root) (local.get $entire_size))
      (i32.store offset=12 (local.get $root) (local.get $entire_size))
      (global.set $help_doc_file_size (local.get $entire_size))

      (local.set $dir_off (i32.load offset=4 (local.get $outer)))
      (local.set $dir_ifh (call $help_slice_address
        (local.get $root) (local.get $dir_off) (i32.const 9)))
      (if (i32.eqz (local.get $dir_ifh))
        (then
          (call $help_set_error (global.get $HELP_ERROR_BAD_FILE_HEADER) (local.get $dir_off))
          (br $done)))
      (local.set $reserved (i32.load (local.get $dir_ifh)))
      (local.set $used (i32.load offset=4 (local.get $dir_ifh)))
      (if (i32.or
            (i32.lt_u (local.get $reserved) (i32.const 9))
            (i32.gt_u (local.get $used) (i32.sub (local.get $reserved) (i32.const 9))))
        (then
          (call $help_set_error (global.get $HELP_ERROR_BAD_FILE_HEADER) (local.get $dir_off))
          (br $done)))
      (if (i32.eqz (call $help_slice_address
            (local.get $root) (local.get $dir_off) (local.get $reserved)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_BAD_FILE_HEADER) (local.get $dir_off))
          (br $done)))
      (if (i32.lt_u (local.get $used) (i32.const 38))
        (then
          (call $help_set_error (global.get $HELP_ERROR_DIRECTORY_BTREE) (i32.add (local.get $dir_off) (i32.const 9)))
          (br $done)))
      (local.set $bt (i32.add (local.get $dir_ifh) (i32.const 9)))
      (if (i32.ne (i32.load16_u (local.get $bt)) (i32.const 0x293B))
        (then
          (call $help_set_error (global.get $HELP_ERROR_DIRECTORY_BTREE) (i32.add (local.get $dir_off) (i32.const 9)))
          (br $done)))
      (if (i32.ne
            (i32.and (i32.load16_u offset=2 (local.get $bt)) (i32.const 0x0402))
            (i32.const 0x0402))
        (then
          (call $help_set_error (global.get $HELP_ERROR_DIRECTORY_BTREE) (i32.add (local.get $dir_off) (i32.const 11)))
          (br $done)))
      ;; Directory keys are NUL strings and values are 32-bit file offsets.
      (if (i32.or
            (i32.ne (i32.load8_u offset=6 (local.get $bt)) (i32.const 0x7A))
            (i32.ne (i32.load8_u offset=7 (local.get $bt)) (i32.const 0x34)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_DIRECTORY_BTREE) (i32.add (local.get $dir_off) (i32.const 15)))
          (br $done)))
      (if (i32.or
            (i32.ne (i32.load16_u offset=22 (local.get $bt)) (i32.const 0))
            (i32.ne (i32.load16_u offset=28 (local.get $bt)) (i32.const 0xFFFF)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_DIRECTORY_BTREE) (i32.add (local.get $dir_off) (i32.const 31)))
          (br $done)))

      (local.set $page_size (i32.load16_u offset=4 (local.get $bt)))
      (local.set $root_page (i32.load16_u offset=26 (local.get $bt)))
      (local.set $total_pages (i32.load16_u offset=30 (local.get $bt)))
      (local.set $levels (i32.load16_u offset=32 (local.get $bt)))
      (local.set $total_entries (i32.load offset=34 (local.get $bt)))
      (if (i32.or
            (i32.or (i32.lt_u (local.get $page_size) (i32.const 512))
                    (i32.gt_u (local.get $page_size) (i32.const 4096)))
            (i32.ne (i32.and (local.get $page_size) (i32.sub (local.get $page_size) (i32.const 1))) (i32.const 0)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_DIRECTORY_BTREE) (i32.add (local.get $dir_off) (i32.const 13)))
          (br $done)))
      (if (i32.or
            (i32.or (i32.eqz (local.get $total_pages))
                    (i32.gt_u (local.get $total_pages) (global.get $HELP_MAX_BTREE_PAGES)))
            (i32.or (i32.eqz (local.get $levels))
                    (i32.gt_u (local.get $levels) (global.get $HELP_MAX_BTREE_DEPTH))))
        (then
          (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (i32.add (local.get $dir_off) (i32.const 39)))
          (br $done)))
      (if (i32.or
            (i32.eqz (local.get $total_entries))
            (i32.gt_u (local.get $total_entries) (global.get $HELP_MAX_DIRECTORY_ENTRIES)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (i32.add (local.get $dir_off) (i32.const 43)))
          (br $done)))
      (if (i32.and
            (i32.gt_u (local.get $levels) (i32.const 1))
            (i32.ge_u (local.get $root_page) (local.get $total_pages)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_DIRECTORY_BTREE) (i32.add (local.get $dir_off) (i32.const 35)))
          (br $done)))
      (if (i32.gt_u (local.get $total_pages) (i32.div_u (i32.const -1) (local.get $page_size)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (i32.add (local.get $dir_off) (i32.const 39)))
          (br $done)))
      (local.set $page_bytes (i32.mul (local.get $total_pages) (local.get $page_size)))
      (if (i32.gt_u (local.get $page_bytes) (i32.sub (local.get $used) (i32.const 38)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_DIRECTORY_BTREE) (i32.add (local.get $dir_off) (i32.const 39)))
          (br $done)))
      (local.set $pages_off (i32.add (local.get $dir_off) (i32.const 47)))

      (local.set $directory_ga
        (call $heap_alloc (i32.mul (local.get $total_entries) (global.get $HELP_INTERNAL_FILE_SIZE))))
      (if (i32.eqz (local.get $directory_ga))
        (then
          (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
          (br $done)))
      (global.set $help_doc_directory_ga (local.get $directory_ga))
      (global.set $help_doc_directory_wa (call $g2w (local.get $directory_ga)))
      (local.set $visited_bytes (i32.shr_u (i32.add (local.get $total_pages) (i32.const 7)) (i32.const 3)))
      (local.set $visited_ga (call $heap_alloc (local.get $visited_bytes)))
      (if (i32.eqz (local.get $visited_ga))
        (then
          (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
          (br $done)))
      (local.set $visited_wa (call $g2w (local.get $visited_ga)))
      (memory.fill (local.get $visited_wa) (i32.const 0) (local.get $visited_bytes))

      ;; Descend through PreviousPage links to the leftmost leaf.
      (if (i32.eq (local.get $levels) (i32.const 1))
        (then (local.set $page_num (i32.const 0)))
        (else (local.set $page_num (local.get $root_page))))
      (local.set $depth (i32.const 1))
      (block $at_leaf (loop $descend
        (br_if $at_leaf (i32.ge_u (local.get $depth) (local.get $levels)))
        (if (i32.or
              (i32.ge_u (local.get $page_num) (local.get $total_pages))
              (i32.eqz (call $help_mark_btree_page (local.get $visited_wa) (local.get $page_num))))
          (then
            (call $help_set_error (global.get $HELP_ERROR_DIRECTORY_BTREE)
              (i32.add (local.get $pages_off) (i32.mul (local.get $page_num) (local.get $page_size))))
            (br $done)))
        (local.set $page_ptr (i32.add (global.get $help_doc_file_wa)
          (i32.add (local.get $pages_off) (i32.mul (local.get $page_num) (local.get $page_size)))))
        (local.set $unused (i32.load16_u (local.get $page_ptr)))
        (if (i32.gt_u (local.get $unused) (i32.sub (local.get $page_size) (i32.const 6)))
          (then
            (call $help_set_error (global.get $HELP_ERROR_DIRECTORY_BTREE)
              (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa)))
            (br $done)))
        (local.set $page_num (i32.load16_u offset=4 (local.get $page_ptr)))
        (local.set $depth (i32.add (local.get $depth) (i32.const 1)))
        (br $descend)))

      ;; Traverse the sorted, doubly-linked leaf list.
      (local.set $previous (i32.const 0xFFFF))
      (block $leaves_done (loop $leaf
        (br_if $leaves_done (i32.eq (local.get $page_num) (i32.const 0xFFFF)))
        (if (i32.or
              (i32.ge_u (local.get $page_num) (local.get $total_pages))
              (i32.eqz (call $help_mark_btree_page (local.get $visited_wa) (local.get $page_num))))
          (then
            (call $help_set_error (global.get $HELP_ERROR_DIRECTORY_BTREE)
              (i32.add (local.get $pages_off) (i32.mul (local.get $page_num) (local.get $page_size))))
            (br $done)))
        (local.set $page_ptr (i32.add (global.get $help_doc_file_wa)
          (i32.add (local.get $pages_off) (i32.mul (local.get $page_num) (local.get $page_size)))))
        (local.set $unused (i32.load16_u (local.get $page_ptr)))
        (local.set $entries (i32.load16_u offset=2 (local.get $page_ptr)))
        (if (i32.or
              (i32.gt_u (local.get $unused) (i32.sub (local.get $page_size) (i32.const 8)))
              (i32.gt_u (local.get $entries) (i32.sub (local.get $total_entries) (local.get $count))))
          (then
            (call $help_set_error (global.get $HELP_ERROR_DIRECTORY_BTREE)
              (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa)))
            (br $done)))
        (if (i32.ne (i32.load16_u offset=4 (local.get $page_ptr)) (local.get $previous))
          (then
            (call $help_set_error (global.get $HELP_ERROR_DIRECTORY_BTREE)
              (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa)) (i32.const 4)))
            (br $done)))
        (local.set $next (i32.load16_u offset=6 (local.get $page_ptr)))
        (if (i32.and
              (i32.ne (local.get $next) (i32.const 0xFFFF))
              (i32.ge_u (local.get $next) (local.get $total_pages)))
          (then
            (call $help_set_error (global.get $HELP_ERROR_DIRECTORY_BTREE)
              (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa)) (i32.const 6)))
            (br $done)))
        (local.set $used_end (i32.sub (local.get $page_size) (local.get $unused)))
        (call $help_slice_init
          (local.get $scratch) (local.get $page_ptr) (local.get $page_size)
          (i32.const 0) (local.get $used_end))
        (local.set $entry_rel (i32.const 8))
        (local.set $entry_ptr (i32.const 0))
        (block $entries_done (loop $entry
          (br_if $entries_done (i32.ge_u (local.get $entry_ptr) (local.get $entries)))
          (local.set $name_len (call $help_read_cstring_length
            (local.get $scratch) (local.get $entry_rel) (i32.const 256)))
          (if (i32.or (i32.le_s (local.get $name_len) (i32.const 0))
                      (i32.gt_u (local.get $name_len) (i32.const 255)))
            (then
              (call $help_set_error (global.get $HELP_ERROR_DIRECTORY_BTREE)
                (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa)) (local.get $entry_rel)))
              (br $done)))
          (if (i32.gt_u
                (i32.add (i32.add (local.get $entry_rel) (local.get $name_len)) (i32.const 5))
                (local.get $used_end))
            (then
              (call $help_set_error (global.get $HELP_ERROR_DIRECTORY_BTREE)
                (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa)) (local.get $entry_rel)))
              (br $done)))
          (local.set $name_off (i32.add
            (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa)) (local.get $entry_rel)))
          (local.set $file_off (i32.load (i32.add (local.get $page_ptr)
            (i32.add (local.get $entry_rel) (i32.add (local.get $name_len) (i32.const 1))))))
          (local.set $record (i32.add (global.get $help_doc_directory_wa)
            (i32.mul (local.get $count) (global.get $HELP_INTERNAL_FILE_SIZE))))
          (i32.store (local.get $record)
            (call $help_hash_bytes (i32.add (global.get $help_doc_file_wa) (local.get $name_off)) (local.get $name_len)))
          (i32.store offset=4 (local.get $record) (local.get $name_off))
          (i32.store16 offset=8 (local.get $record) (local.get $name_len))
          (if (i32.eqz (call $help_validate_internal_file
                (local.get $root) (local.get $file_off) (local.get $record)))
            (then (br $done)))
          (if (local.get $count)
            (then
              (local.set $prev_record (i32.sub (local.get $record) (global.get $HELP_INTERNAL_FILE_SIZE)))
              (if (i32.ge_s
                    (call $help_bytes_compare
                      (i32.add (global.get $help_doc_file_wa) (i32.load offset=4 (local.get $prev_record)))
                      (i32.load16_u offset=8 (local.get $prev_record))
                      (i32.add (global.get $help_doc_file_wa) (local.get $name_off))
                      (local.get $name_len))
                    (i32.const 0))
                (then
                  (call $help_set_error (global.get $HELP_ERROR_DIRECTORY_BTREE) (local.get $name_off))
                  (br $done)))))
          (local.set $entry_rel
            (i32.add (local.get $entry_rel) (i32.add (local.get $name_len) (i32.const 5))))
          (local.set $entry_ptr (i32.add (local.get $entry_ptr) (i32.const 1)))
          (local.set $count (i32.add (local.get $count) (i32.const 1)))
          (br $entry)))
        (if (i32.ne (local.get $entry_rel) (local.get $used_end))
          (then
            (call $help_set_error (global.get $HELP_ERROR_DIRECTORY_BTREE)
              (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa)) (local.get $entry_rel)))
            (br $done)))
        (local.set $previous (local.get $page_num))
        (local.set $page_num (local.get $next))
        (br $leaf)))
      (if (i32.ne (local.get $count) (local.get $total_entries))
        (then
          (call $help_set_error (global.get $HELP_ERROR_DIRECTORY_BTREE) (i32.add (local.get $dir_off) (i32.const 43)))
          (br $done)))
      ;; Publish only after the complete tree and every internal header pass.
      (global.set $help_doc_directory_count (local.get $count))
      (local.set $ok (i32.const 1)))

    (if (local.get $visited_ga) (then (call $heap_free (local.get $visited_ga))))
    (if (i32.eqz (local.get $ok))
      (then
        (if (global.get $help_doc_directory_ga)
          (then (call $heap_free (global.get $help_doc_directory_ga))))
        (global.set $help_doc_directory_ga (i32.const 0))
        (global.set $help_doc_directory_wa (i32.const 0))
        (global.set $help_doc_directory_count (i32.const 0))))
    (local.get $ok))

  (func $help_parse_system (result i32)
    (local $index i32) (local $record i32) (local $data_off i32)
    (local $data_len i32) (local $data i32) (local $pos i32)
    (local $type i32) (local $size i32) (local $string_len i32)
    (local $title_off i32) (local $title_len i32)
    (local $contents_ref i32) (local $cnt_off i32) (local $cnt_len i32)
    (local $minor i32) (local $major i32) (local $flags i32)
    (local $date i32)
    (local.set $contents_ref (i32.const -1))
    (local.set $index (call $help_find_internal_literal (i32.const 1)))
    (if (i32.lt_s (local.get $index) (i32.const 0))
      (then
        (call $help_set_error (global.get $HELP_ERROR_MISSING_INTERNAL) (i32.const 0))
        (return (i32.const 0))))
    (local.set $record (i32.add (global.get $help_doc_directory_wa)
      (i32.mul (local.get $index) (global.get $HELP_INTERNAL_FILE_SIZE))))
    (local.set $data_off (i32.load offset=12 (local.get $record)))
    (local.set $data_len (i32.load offset=16 (local.get $record)))
    (if (i32.lt_u (local.get $data_len) (i32.const 12))
      (then
        (call $help_set_error (global.get $HELP_ERROR_SYSTEM) (local.get $data_off))
        (return (i32.const 0))))
    (local.set $data (i32.add (global.get $help_doc_file_wa) (local.get $data_off)))
    (if (i32.ne (i32.load16_u (local.get $data)) (i32.const 0x036C))
      (then
        (call $help_set_error (global.get $HELP_ERROR_SYSTEM) (local.get $data_off))
        (return (i32.const 0))))
    (local.set $minor (i32.load16_u offset=2 (local.get $data)))
    (local.set $major (i32.load16_u offset=4 (local.get $data)))
    (local.set $date (i32.load offset=6 (local.get $data)))
    (local.set $flags (i32.load16_u offset=10 (local.get $data)))
    (if (i32.le_u (local.get $minor) (i32.const 16))
      (then
        (call $help_slice_init
          (i32.add (global.get $help_doc_meta_wa) (i32.const 16))
          (local.get $data) (local.get $data_len)
          (i32.const 0) (local.get $data_len))
        (local.set $string_len (call $help_read_cstring_length
          (i32.add (global.get $help_doc_meta_wa) (i32.const 16))
          (i32.const 12) (i32.sub (local.get $data_len) (i32.const 12))))
        (if (i32.lt_s (local.get $string_len) (i32.const 0))
          (then
            (call $help_set_error (global.get $HELP_ERROR_SYSTEM)
              (i32.add (local.get $data_off) (i32.const 12)))
            (return (i32.const 0))))
        (local.set $title_off (i32.add (local.get $data_off) (i32.const 12)))
        (local.set $title_len (local.get $string_len)))
      (else
        (local.set $pos (i32.const 12))
        (block $records_done (loop $records
          (br_if $records_done (i32.eq (local.get $pos) (local.get $data_len)))
          (if (i32.gt_u (i32.const 4) (i32.sub (local.get $data_len) (local.get $pos)))
            (then
              (call $help_set_error (global.get $HELP_ERROR_SYSTEM)
                (i32.add (local.get $data_off) (local.get $pos)))
              (return (i32.const 0))))
          (local.set $type (i32.load16_u (i32.add (local.get $data) (local.get $pos))))
          (local.set $size (i32.load16_u offset=2 (i32.add (local.get $data) (local.get $pos))))
          (if (i32.gt_u (local.get $size)
                (i32.sub (i32.sub (local.get $data_len) (local.get $pos)) (i32.const 4)))
            (then
              (call $help_set_error (global.get $HELP_ERROR_SYSTEM)
                (i32.add (local.get $data_off) (i32.add (local.get $pos) (i32.const 2))))
              (return (i32.const 0))))
          (if (i32.or (i32.eq (local.get $type) (i32.const 1))
                      (i32.eq (local.get $type) (i32.const 10)))
            (then
              (call $help_slice_init
                (i32.add (global.get $help_doc_meta_wa) (i32.const 16))
                (local.get $data) (local.get $data_len)
                (i32.const 0) (local.get $data_len))
              (local.set $string_len (call $help_read_cstring_length
                (i32.add (global.get $help_doc_meta_wa) (i32.const 16))
                (i32.add (local.get $pos) (i32.const 4)) (local.get $size)))
              (if (i32.lt_s (local.get $string_len) (i32.const 0))
                (then
                  (call $help_set_error (global.get $HELP_ERROR_SYSTEM)
                    (i32.add (local.get $data_off) (i32.add (local.get $pos) (i32.const 4))))
                  (return (i32.const 0))))
              (if (i32.eq (local.get $type) (i32.const 1))
                (then
                  (local.set $title_off
                    (i32.add (local.get $data_off) (i32.add (local.get $pos) (i32.const 4))))
                  (local.set $title_len (local.get $string_len)))
                (else
                  (local.set $cnt_off
                    (i32.add (local.get $data_off) (i32.add (local.get $pos) (i32.const 4))))
                  (local.set $cnt_len (local.get $string_len))))))
          (if (i32.eq (local.get $type) (i32.const 3))
            (then
              (if (i32.ne (local.get $size) (i32.const 4))
                (then
                  (call $help_set_error (global.get $HELP_ERROR_SYSTEM)
                    (i32.add (local.get $data_off) (local.get $pos)))
                  (return (i32.const 0))))
              (local.set $contents_ref
                (i32.load offset=4 (i32.add (local.get $data) (local.get $pos))))))
          (local.set $pos (i32.add (local.get $pos)
            (i32.add (local.get $size) (i32.const 4))))
          (br $records)))))
    (global.set $help_doc_system_minor (local.get $minor))
    (global.set $help_doc_system_major (local.get $major))
    (global.set $help_doc_system_flags (local.get $flags))
    (global.set $help_doc_system_date (local.get $date))
    (global.set $help_doc_title_off (local.get $title_off))
    (global.set $help_doc_title_len (local.get $title_len))
    (global.set $help_doc_contents_ref (local.get $contents_ref))
    (global.set $help_doc_cnt_off (local.get $cnt_off))
    (global.set $help_doc_cnt_len (local.get $cnt_len))
    (i32.const 1))

  ;; Parse either |TTLBTREE (kind 1, Lz leaves) or |CONTEXT (kind 2,
  ;; L4 leaves). Index pages use fixed {long key, short child} entries.
  (func $help_parse_semantic_btree
    (param $internal_index i32) (param $kind i32)
    (param $topics_wa i32) (param $topic_count i32) (result i32)
    (local $record i32) (local $data_off i32) (local $data_len i32)
    (local $bt i32) (local $error_code i32) (local $page_size i32)
    (local $total_pages i32) (local $levels i32) (local $total_entries i32)
    (local $root_page i32) (local $page_bytes i32) (local $pages_off i32)
    (local $records_ga i32) (local $records_wa i32) (local $record_size i32)
    (local $visited_ga i32) (local $visited_wa i32) (local $visited_bytes i32)
    (local $page_num i32) (local $page_ptr i32) (local $depth i32)
    (local $unused i32) (local $entries i32) (local $used_end i32)
    (local $previous_page i32) (local $next_page i32)
    (local $entry_rel i32) (local $entry_index i32) (local $count i32)
    (local $value i32) (local $topic_ref i32) (local $title_len i32)
    (local $out_record i32) (local $topic_index i32) (local $topic_record i32)
    (local $prev_value i32) (local $has_prev_value i32) (local $ok i32)

    (global.set $help_semantic_result_ga (i32.const 0))
    (global.set $help_semantic_result_wa (i32.const 0))
    (global.set $help_semantic_result_count (i32.const 0))
    (if (i32.eq (local.get $kind) (i32.const 1))
      (then
        (local.set $error_code (global.get $HELP_ERROR_TOPIC_INDEX))
        (local.set $record_size (global.get $HELP_TOPIC_SIZE)))
      (else
        (local.set $error_code (global.get $HELP_ERROR_CONTEXT_INDEX))
        (local.set $record_size (global.get $HELP_CONTEXT_SIZE))))
    (local.set $record (i32.add (global.get $help_doc_directory_wa)
      (i32.mul (local.get $internal_index) (global.get $HELP_INTERNAL_FILE_SIZE))))
    (local.set $data_off (i32.load offset=12 (local.get $record)))
    (local.set $data_len (i32.load offset=16 (local.get $record)))
    (block $done
      (if (i32.lt_u (local.get $data_len) (i32.const 38))
        (then
          (call $help_set_error (local.get $error_code) (local.get $data_off))
          (br $done)))
      (local.set $bt (i32.add (global.get $help_doc_file_wa) (local.get $data_off)))
      (if (i32.ne (i32.load16_u (local.get $bt)) (i32.const 0x293B))
        (then
          (call $help_set_error (local.get $error_code) (local.get $data_off))
          (br $done)))
      (if (i32.ne (i32.and (i32.load16_u offset=2 (local.get $bt)) (i32.const 2)) (i32.const 2))
        (then
          (call $help_set_error (local.get $error_code) (i32.add (local.get $data_off) (i32.const 2)))
          (br $done)))
      (if (i32.or
            (i32.ne (i32.load8_u offset=6 (local.get $bt)) (i32.const 0x4C))
            (i32.ne (i32.load8_u offset=7 (local.get $bt))
              (if (result i32) (i32.eq (local.get $kind) (i32.const 1))
                (then (i32.const 0x7A)) (else (i32.const 0x34)))))
        (then
          (call $help_set_error (local.get $error_code) (i32.add (local.get $data_off) (i32.const 6)))
          (br $done)))
      (if (i32.or
            (i32.ne (i32.load16_u offset=22 (local.get $bt)) (i32.const 0))
            (i32.ne (i32.load16_u offset=28 (local.get $bt)) (i32.const 0xFFFF)))
        (then
          (call $help_set_error (local.get $error_code) (i32.add (local.get $data_off) (i32.const 22)))
          (br $done)))
      (local.set $page_size (i32.load16_u offset=4 (local.get $bt)))
      (local.set $root_page (i32.load16_u offset=26 (local.get $bt)))
      (local.set $total_pages (i32.load16_u offset=30 (local.get $bt)))
      (local.set $levels (i32.load16_u offset=32 (local.get $bt)))
      (local.set $total_entries (i32.load offset=34 (local.get $bt)))
      (if (i32.or
            (i32.or (i32.lt_u (local.get $page_size) (i32.const 512))
                    (i32.gt_u (local.get $page_size) (i32.const 4096)))
            (i32.ne (i32.and (local.get $page_size)
                      (i32.sub (local.get $page_size) (i32.const 1))) (i32.const 0)))
        (then
          (call $help_set_error (local.get $error_code) (i32.add (local.get $data_off) (i32.const 4)))
          (br $done)))
      (if (i32.or
            (i32.or (i32.eqz (local.get $total_pages))
                    (i32.gt_u (local.get $total_pages) (global.get $HELP_MAX_BTREE_PAGES)))
            (i32.or (i32.eqz (local.get $levels))
                    (i32.gt_u (local.get $levels) (global.get $HELP_MAX_BTREE_DEPTH))))
        (then
          (call $help_set_error (global.get $HELP_ERROR_CAPACITY)
            (i32.add (local.get $data_off) (i32.const 30)))
          (br $done)))
      (if (i32.or
            (i32.gt_u (local.get $total_entries) (global.get $HELP_MAX_TOPICS))
            (i32.and (i32.eq (local.get $kind) (i32.const 1))
                     (i32.eqz (local.get $total_entries))))
        (then
          (call $help_set_error (global.get $HELP_ERROR_CAPACITY)
            (i32.add (local.get $data_off) (i32.const 34)))
          (br $done)))
      (if (i32.and (i32.gt_u (local.get $levels) (i32.const 1))
                   (i32.ge_u (local.get $root_page) (local.get $total_pages)))
        (then
          (call $help_set_error (local.get $error_code) (i32.add (local.get $data_off) (i32.const 26)))
          (br $done)))
      (if (i32.gt_u (local.get $total_pages) (i32.div_u (i32.const -1) (local.get $page_size)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_CAPACITY)
            (i32.add (local.get $data_off) (i32.const 30)))
          (br $done)))
      (local.set $page_bytes (i32.mul (local.get $total_pages) (local.get $page_size)))
      (if (i32.gt_u (local.get $page_bytes) (i32.sub (local.get $data_len) (i32.const 38)))
        (then
          (call $help_set_error (local.get $error_code) (i32.add (local.get $data_off) (i32.const 30)))
          (br $done)))
      (local.set $pages_off (i32.add (local.get $data_off) (i32.const 38)))
      (if (local.get $total_entries)
        (then
          (local.set $records_ga (call $heap_alloc
            (i32.mul (local.get $total_entries) (local.get $record_size))))
          (if (i32.eqz (local.get $records_ga))
            (then
              (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
              (br $done)))
          (local.set $records_wa (call $g2w (local.get $records_ga)))
          (memory.fill (local.get $records_wa) (i32.const 0)
            (i32.mul (local.get $total_entries) (local.get $record_size)))))
      (local.set $visited_bytes
        (i32.shr_u (i32.add (local.get $total_pages) (i32.const 7)) (i32.const 3)))
      (local.set $visited_ga (call $heap_alloc (local.get $visited_bytes)))
      (if (i32.eqz (local.get $visited_ga))
        (then
          (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
          (br $done)))
      (local.set $visited_wa (call $g2w (local.get $visited_ga)))
      (memory.fill (local.get $visited_wa) (i32.const 0) (local.get $visited_bytes))

      (if (i32.eq (local.get $levels) (i32.const 1))
        (then (local.set $page_num (i32.const 0)))
        (else (local.set $page_num (local.get $root_page))))
      (local.set $depth (i32.const 1))
      (block $at_leaf (loop $descend
        (br_if $at_leaf (i32.ge_u (local.get $depth) (local.get $levels)))
        (if (i32.or
              (i32.ge_u (local.get $page_num) (local.get $total_pages))
              (i32.eqz (call $help_mark_btree_page (local.get $visited_wa) (local.get $page_num))))
          (then
            (call $help_set_error (local.get $error_code)
              (i32.add (local.get $pages_off) (i32.mul (local.get $page_num) (local.get $page_size))))
            (br $done)))
        (local.set $page_ptr (i32.add (global.get $help_doc_file_wa)
          (i32.add (local.get $pages_off) (i32.mul (local.get $page_num) (local.get $page_size)))))
        (local.set $unused (i32.load16_u (local.get $page_ptr)))
        (local.set $entries (i32.load16_u offset=2 (local.get $page_ptr)))
        (if (i32.or
              (i32.gt_u (local.get $unused) (i32.sub (local.get $page_size) (i32.const 6)))
              (i32.ne (i32.add (i32.const 6) (i32.mul (local.get $entries) (i32.const 6)))
                      (i32.sub (local.get $page_size) (local.get $unused))))
          (then
            (call $help_set_error (local.get $error_code)
              (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa)))
            (br $done)))
        (local.set $page_num (i32.load16_u offset=4 (local.get $page_ptr)))
        (local.set $depth (i32.add (local.get $depth) (i32.const 1)))
        (br $descend)))

      (local.set $previous_page (i32.const 0xFFFF))
      (block $leaves_done (loop $leaf
        (br_if $leaves_done (i32.eq (local.get $page_num) (i32.const 0xFFFF)))
        (if (i32.or
              (i32.ge_u (local.get $page_num) (local.get $total_pages))
              (i32.eqz (call $help_mark_btree_page (local.get $visited_wa) (local.get $page_num))))
          (then
            (call $help_set_error (local.get $error_code)
              (i32.add (local.get $pages_off) (i32.mul (local.get $page_num) (local.get $page_size))))
            (br $done)))
        (local.set $page_ptr (i32.add (global.get $help_doc_file_wa)
          (i32.add (local.get $pages_off) (i32.mul (local.get $page_num) (local.get $page_size)))))
        (local.set $unused (i32.load16_u (local.get $page_ptr)))
        (local.set $entries (i32.load16_u offset=2 (local.get $page_ptr)))
        (if (i32.or
              (i32.gt_u (local.get $unused) (i32.sub (local.get $page_size) (i32.const 8)))
              (i32.gt_u (local.get $entries) (i32.sub (local.get $total_entries) (local.get $count))))
          (then
            (call $help_set_error (local.get $error_code)
              (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa)))
            (br $done)))
        (if (i32.ne (i32.load16_u offset=4 (local.get $page_ptr)) (local.get $previous_page))
          (then
            (call $help_set_error (local.get $error_code)
              (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa)) (i32.const 4)))
            (br $done)))
        (local.set $next_page (i32.load16_u offset=6 (local.get $page_ptr)))
        (if (i32.and (i32.ne (local.get $next_page) (i32.const 0xFFFF))
                     (i32.ge_u (local.get $next_page) (local.get $total_pages)))
          (then
            (call $help_set_error (local.get $error_code)
              (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa)) (i32.const 6)))
            (br $done)))
        (local.set $used_end (i32.sub (local.get $page_size) (local.get $unused)))
        (call $help_slice_init
          (i32.add (global.get $help_doc_meta_wa) (i32.const 16))
          (local.get $page_ptr) (local.get $page_size)
          (i32.const 0) (local.get $used_end))
        (local.set $entry_rel (i32.const 8))
        (local.set $entry_index (i32.const 0))
        (block $entries_done (loop $entry
          (br_if $entries_done (i32.ge_u (local.get $entry_index) (local.get $entries)))
          (if (i32.eq (local.get $kind) (i32.const 1))
            (then
              (if (i32.gt_u (i32.const 5) (i32.sub (local.get $used_end) (local.get $entry_rel)))
                (then
                  (call $help_set_error (local.get $error_code)
                    (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa)) (local.get $entry_rel)))
                  (br $done)))
              (local.set $value (i32.load (i32.add (local.get $page_ptr) (local.get $entry_rel))))
              (local.set $title_len (call $help_read_cstring_length
                (i32.add (global.get $help_doc_meta_wa) (i32.const 16))
                (i32.add (local.get $entry_rel) (i32.const 4))
                (i32.sub (local.get $used_end) (i32.add (local.get $entry_rel) (i32.const 4)))))
              (if (i32.lt_s (local.get $title_len) (i32.const 0))
                (then
                  (call $help_set_error (local.get $error_code)
                    (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa))
                      (i32.add (local.get $entry_rel) (i32.const 4))))
                  (br $done)))
              (if (i32.and (local.get $has_prev_value)
                           (i32.ge_u (local.get $prev_value) (local.get $value)))
                (then
                  (call $help_set_error (local.get $error_code)
                    (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa)) (local.get $entry_rel)))
                  (br $done)))
              (local.set $out_record (i32.add (local.get $records_wa)
                (i32.mul (local.get $count) (global.get $HELP_TOPIC_SIZE))))
              (i32.store (local.get $out_record) (local.get $value))
              (i32.store offset=8 (local.get $out_record)
                (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa))
                  (i32.add (local.get $entry_rel) (i32.const 4))))
              (i32.store offset=12 (local.get $out_record) (local.get $title_len))
              (i32.store offset=20 (local.get $out_record) (i32.const -1))
              (i32.store offset=24 (local.get $out_record) (i32.const -1))
              (local.set $entry_rel (i32.add (local.get $entry_rel)
                (i32.add (local.get $title_len) (i32.const 5)))))
            (else
              (if (i32.gt_u (i32.const 8) (i32.sub (local.get $used_end) (local.get $entry_rel)))
                (then
                  (call $help_set_error (local.get $error_code)
                    (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa)) (local.get $entry_rel)))
                  (br $done)))
              (local.set $value (i32.load (i32.add (local.get $page_ptr) (local.get $entry_rel))))
              (local.set $topic_ref
                (i32.load offset=4 (i32.add (local.get $page_ptr) (local.get $entry_rel))))
              (if (i32.and (local.get $has_prev_value)
                           (i32.ge_s (local.get $prev_value) (local.get $value)))
                (then
                  (call $help_set_error (local.get $error_code)
                    (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa)) (local.get $entry_rel)))
                  (br $done)))
              (local.set $topic_index (call $help_find_topic_index_in
                (local.get $topics_wa) (local.get $topic_count) (local.get $topic_ref)))
              (if (i32.lt_s (local.get $topic_index) (i32.const 0))
                (then
                  (call $help_set_error (local.get $error_code)
                    (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa))
                      (i32.add (local.get $entry_rel) (i32.const 4))))
                  (br $done)))
              (local.set $out_record (i32.add (local.get $records_wa)
                (i32.mul (local.get $count) (global.get $HELP_CONTEXT_SIZE))))
              (i32.store (local.get $out_record) (local.get $value))
              (i32.store offset=4 (local.get $out_record) (local.get $topic_ref))
              (local.set $topic_record (i32.add (local.get $topics_wa)
                (i32.mul (local.get $topic_index) (global.get $HELP_TOPIC_SIZE))))
              (if (i32.eqz (i32.and (i32.load offset=28 (local.get $topic_record))
                                    (global.get $HELP_TOPIC_HAS_CONTEXT)))
                (then
                  (i32.store offset=16 (local.get $topic_record) (local.get $value))
                  (i32.store offset=28 (local.get $topic_record)
                    (i32.or (i32.load offset=28 (local.get $topic_record))
                            (global.get $HELP_TOPIC_HAS_CONTEXT)))))
              (local.set $entry_rel (i32.add (local.get $entry_rel) (i32.const 8)))))
          (local.set $prev_value (local.get $value))
          (local.set $has_prev_value (i32.const 1))
          (local.set $entry_index (i32.add (local.get $entry_index) (i32.const 1)))
          (local.set $count (i32.add (local.get $count) (i32.const 1)))
          (br $entry)))
        (if (i32.ne (local.get $entry_rel) (local.get $used_end))
          (then
            (call $help_set_error (local.get $error_code)
              (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa)) (local.get $entry_rel)))
            (br $done)))
        (local.set $previous_page (local.get $page_num))
        (local.set $page_num (local.get $next_page))
        (br $leaf)))
      (if (i32.ne (local.get $count) (local.get $total_entries))
        (then
          (call $help_set_error (local.get $error_code) (i32.add (local.get $data_off) (i32.const 34)))
          (br $done)))
      (global.set $help_semantic_result_ga (local.get $records_ga))
      (global.set $help_semantic_result_wa (local.get $records_wa))
      (global.set $help_semantic_result_count (local.get $count))
      (local.set $ok (i32.const 1)))
    (if (local.get $visited_ga) (then (call $heap_free (local.get $visited_ga))))
    (if (i32.eqz (local.get $ok))
      (then
        (if (local.get $records_ga) (then (call $heap_free (local.get $records_ga))))
        (global.set $help_semantic_result_ga (i32.const 0))
        (global.set $help_semantic_result_wa (i32.const 0))
        (global.set $help_semantic_result_count (i32.const 0))))
    (local.get $ok))

  (func $help_parse_context_map
    (param $internal_index i32) (param $topics_wa i32) (param $topic_count i32)
    (result i32)
    (local $record i32) (local $data_off i32) (local $data_len i32)
    (local $data i32) (local $count i32) (local $expected i32)
    (local $records_ga i32) (local $records_wa i32) (local $i i32)
    (local $source i32) (local $out i32) (local $topic_ref i32)
    (global.set $help_semantic_result_ga (i32.const 0))
    (global.set $help_semantic_result_wa (i32.const 0))
    (global.set $help_semantic_result_count (i32.const 0))
    (local.set $record (i32.add (global.get $help_doc_directory_wa)
      (i32.mul (local.get $internal_index) (global.get $HELP_INTERNAL_FILE_SIZE))))
    (local.set $data_off (i32.load offset=12 (local.get $record)))
    (local.set $data_len (i32.load offset=16 (local.get $record)))
    (if (i32.lt_u (local.get $data_len) (i32.const 2))
      (then
        (call $help_set_error (global.get $HELP_ERROR_CONTEXT_INDEX) (local.get $data_off))
        (return (i32.const 0))))
    (local.set $data (i32.add (global.get $help_doc_file_wa) (local.get $data_off)))
    (local.set $count (i32.load16_u (local.get $data)))
    (if (i32.gt_u (local.get $count) (global.get $HELP_MAX_TOPICS))
      (then
        (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (local.get $data_off))
        (return (i32.const 0))))
    (local.set $expected (i32.add (i32.const 2) (i32.mul (local.get $count) (i32.const 8))))
    (if (i32.ne (local.get $expected) (local.get $data_len))
      (then
        (call $help_set_error (global.get $HELP_ERROR_CONTEXT_INDEX) (local.get $data_off))
        (return (i32.const 0))))
    (if (local.get $count)
      (then
        (local.set $records_ga (call $heap_alloc (i32.mul (local.get $count) (i32.const 8))))
        (if (i32.eqz (local.get $records_ga))
          (then
            (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
            (return (i32.const 0))))
        (local.set $records_wa (call $g2w (local.get $records_ga)))))
    (block $done (loop $entries
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $source (i32.add (local.get $data)
        (i32.add (i32.const 2) (i32.mul (local.get $i) (i32.const 8)))))
      (local.set $topic_ref (i32.load offset=4 (local.get $source)))
      (if (i32.lt_s (call $help_find_topic_index_in
            (local.get $topics_wa) (local.get $topic_count) (local.get $topic_ref)) (i32.const 0))
        (then
          (call $help_set_error (global.get $HELP_ERROR_CONTEXT_INDEX)
            (i32.add (local.get $data_off)
              (i32.add (i32.const 6) (i32.mul (local.get $i) (i32.const 8)))))
          (if (local.get $records_ga) (then (call $heap_free (local.get $records_ga))))
          (return (i32.const 0))))
      (local.set $out (i32.add (local.get $records_wa) (i32.mul (local.get $i) (i32.const 8))))
      (i32.store (local.get $out) (i32.load (local.get $source)))
      (i32.store offset=4 (local.get $out) (local.get $topic_ref))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $entries)))
    (global.set $help_semantic_result_ga (local.get $records_ga))
    (global.set $help_semantic_result_wa (local.get $records_wa))
    (global.set $help_semantic_result_count (local.get $count))
    (i32.const 1))

  (func $help_phrase_get_bit
    (param $stream i32) (param $stream_len i32) (result i32)
    (local $position i32) (local $value i32)
    (local.set $position (global.get $help_phrase_bit_position))
    (if (i32.ge_u (i32.shr_u (local.get $position) (i32.const 3)) (local.get $stream_len))
      (then (return (i32.const -1))))
    (local.set $value
      (i32.and
        (i32.shr_u
          (i32.load8_u (i32.add (local.get $stream)
            (i32.shr_u (local.get $position) (i32.const 3))))
          (i32.and (local.get $position) (i32.const 7)))
        (i32.const 1)))
    (global.set $help_phrase_bit_position (i32.add (local.get $position) (i32.const 1)))
    (local.get $value))

  ;; Windows Help LZ77 uses one LSB-first control byte for up to eight
  ;; tokens. A back-reference packs a 12-bit backward distance and a 4-bit
  ;; length-minus-three into the following little-endian word.
  (func $help_lz77_expand
    (param $source i32) (param $source_len i32)
    (param $dest i32) (param $dest_len i32) (result i32)
    (local $source_pos i32) (local $dest_pos i32) (local $control i32)
    (local $bit i32) (local $word i32) (local $distance i32)
    (local $length i32) (local $i i32)
    (block $complete (loop $controls
      (br_if $complete (i32.ge_u (local.get $dest_pos) (local.get $dest_len)))
      (if (i32.ge_u (local.get $source_pos) (local.get $source_len))
        (then (return (i32.const 0))))
      (local.set $control (i32.load8_u (i32.add (local.get $source) (local.get $source_pos))))
      (local.set $source_pos (i32.add (local.get $source_pos) (i32.const 1)))
      (local.set $bit (i32.const 0))
      (block $control_done (loop $tokens
        (br_if $control_done (i32.ge_u (local.get $bit) (i32.const 8)))
        (br_if $complete (i32.ge_u (local.get $dest_pos) (local.get $dest_len)))
        (if (i32.eqz (i32.and (local.get $control)
                    (i32.shl (i32.const 1) (local.get $bit))))
          (then
            (if (i32.ge_u (local.get $source_pos) (local.get $source_len))
              (then (return (i32.const 0))))
            (i32.store8 (i32.add (local.get $dest) (local.get $dest_pos))
              (i32.load8_u (i32.add (local.get $source) (local.get $source_pos))))
            (local.set $source_pos (i32.add (local.get $source_pos) (i32.const 1)))
            (local.set $dest_pos (i32.add (local.get $dest_pos) (i32.const 1))))
          (else
            (if (i32.gt_u (i32.const 2) (i32.sub (local.get $source_len) (local.get $source_pos)))
              (then (return (i32.const 0))))
            (local.set $word (i32.load16_u (i32.add (local.get $source) (local.get $source_pos))))
            (local.set $source_pos (i32.add (local.get $source_pos) (i32.const 2)))
            (local.set $distance (i32.and (local.get $word) (i32.const 0x0FFF)))
            (local.set $length (i32.add (i32.shr_u (local.get $word) (i32.const 12)) (i32.const 3)))
            (if (i32.or
                  (i32.ge_u (local.get $distance) (local.get $dest_pos))
                  (i32.gt_u (local.get $length) (i32.sub (local.get $dest_len) (local.get $dest_pos))))
              (then (return (i32.const 0))))
            (local.set $i (i32.const 0))
            (block $copy_done (loop $copy
              (br_if $copy_done (i32.ge_u (local.get $i) (local.get $length)))
              (i32.store8 (i32.add (local.get $dest) (local.get $dest_pos))
                (i32.load8_u (i32.sub
                  (i32.add (local.get $dest) (local.get $dest_pos))
                  (i32.add (local.get $distance) (i32.const 1)))))
              (local.set $dest_pos (i32.add (local.get $dest_pos) (i32.const 1)))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $copy)))))
        (local.set $bit (i32.add (local.get $bit) (i32.const 1)))
        (br $tokens)))
      (br $controls)))
    (i32.and
      (i32.eq (local.get $source_pos) (local.get $source_len))
      (i32.eq (local.get $dest_pos) (local.get $dest_len))))

  ;; Topic blocks do not carry their expanded length. Decode until the fixed
  ;; physical block ends, allowing unused high control bits after the final
  ;; complete token, but never exceeding the 16 KiB logical block envelope.
  (func $help_lz77_expand_topic_block
    (param $source i32) (param $source_len i32)
    (param $dest i32) (param $dest_capacity i32) (result i32)
    (local $source_pos i32) (local $dest_pos i32) (local $control i32)
    (local $bit i32) (local $word i32) (local $distance i32)
    (local $length i32) (local $i i32) (local $ok i32)
    (global.set $help_topic_block_result_size (i32.const 0))
    (block $complete (loop $controls
      (br_if $complete (i32.ge_u (local.get $source_pos) (local.get $source_len)))
      (local.set $control (i32.load8_u (i32.add (local.get $source) (local.get $source_pos))))
      (local.set $source_pos (i32.add (local.get $source_pos) (i32.const 1)))
      (local.set $bit (i32.const 0))
      (block $control_done (loop $tokens
        (br_if $control_done (i32.ge_u (local.get $bit) (i32.const 8)))
        ;; A control byte may end with bits for which no token bytes exist.
        (br_if $complete (i32.ge_u (local.get $source_pos) (local.get $source_len)))
        (if (i32.eqz (i32.and (local.get $control)
                    (i32.shl (i32.const 1) (local.get $bit))))
          (then
            (if (i32.ge_u (local.get $dest_pos) (local.get $dest_capacity))
              (then (return (i32.const 0))))
            (i32.store8 (i32.add (local.get $dest) (local.get $dest_pos))
              (i32.load8_u (i32.add (local.get $source) (local.get $source_pos))))
            (local.set $source_pos (i32.add (local.get $source_pos) (i32.const 1)))
            (local.set $dest_pos (i32.add (local.get $dest_pos) (i32.const 1))))
          (else
            (if (i32.gt_u (i32.const 2)
                  (i32.sub (local.get $source_len) (local.get $source_pos)))
              (then (return (i32.const 0))))
            (local.set $word (i32.load16_u (i32.add (local.get $source) (local.get $source_pos))))
            (local.set $source_pos (i32.add (local.get $source_pos) (i32.const 2)))
            (local.set $distance (i32.and (local.get $word) (i32.const 0x0FFF)))
            (local.set $length (i32.add (i32.shr_u (local.get $word) (i32.const 12)) (i32.const 3)))
            (if (i32.or
                  (i32.ge_u (local.get $distance) (local.get $dest_pos))
                  (i32.gt_u (local.get $length)
                    (i32.sub (local.get $dest_capacity) (local.get $dest_pos))))
              (then (return (i32.const 0))))
            (local.set $i (i32.const 0))
            (block $copy_done (loop $copy
              (br_if $copy_done (i32.ge_u (local.get $i) (local.get $length)))
              (i32.store8 (i32.add (local.get $dest) (local.get $dest_pos))
                (i32.load8_u (i32.sub
                  (i32.add (local.get $dest) (local.get $dest_pos))
                  (i32.add (local.get $distance) (i32.const 1)))))
              (local.set $dest_pos (i32.add (local.get $dest_pos) (i32.const 1)))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $copy)))))
        (local.set $bit (i32.add (local.get $bit) (i32.const 1)))
        (br $tokens)))
      (br $controls)))
    (global.set $help_topic_block_result_size (local.get $dest_pos))
    (local.set $ok (i32.const 1))
    (local.get $ok))

  (func $help_topic_physical_block_size (result i32)
    (if (result i32) (i32.eq (global.get $help_doc_system_flags) (i32.const 8))
      (then (i32.const 2048))
      (else (i32.const 4096))))

  (func $help_topic_logical_block_size (result i32)
    (if (result i32)
      (i32.and
        (i32.ge_u (global.get $help_doc_system_minor) (i32.const 16))
        (i32.or
          (i32.eq (global.get $help_doc_system_flags) (i32.const 4))
          (i32.eq (global.get $help_doc_system_flags) (i32.const 8))))
      (then (i32.const 16384))
      (else (i32.sub (call $help_topic_physical_block_size) (i32.const 12)))))

  (func $help_topic_load_block
    (param $topic_record i32) (param $block_number i32) (param $dest i32)
    (result i32)
    (local $data_off i32) (local $data_len i32) (local $physical_size i32)
    (local $physical_off i32) (local $available i32) (local $source i32)
    (local $source_len i32) (local $compressed i32)
    (local.set $data_off (i32.load offset=12 (local.get $topic_record)))
    (local.set $data_len (i32.load offset=16 (local.get $topic_record)))
    (local.set $physical_size (call $help_topic_physical_block_size))
    (if (i32.or
          (i32.eqz (local.get $data_len))
          (i32.gt_u (local.get $block_number)
            (i32.div_u (i32.sub (local.get $data_len) (i32.const 1)) (local.get $physical_size))))
      (then
        (call $help_set_error (global.get $HELP_ERROR_TOPIC_RECORD) (local.get $data_off))
        (return (i32.const -1))))
    (local.set $physical_off (i32.mul (local.get $block_number) (local.get $physical_size)))
    (local.set $available (i32.sub (local.get $data_len) (local.get $physical_off)))
    (if (i32.gt_u (local.get $available) (local.get $physical_size))
      (then (local.set $available (local.get $physical_size))))
    (if (i32.lt_u (local.get $available) (i32.const 12))
      (then
        (call $help_set_error (global.get $HELP_ERROR_TOPIC_RECORD)
          (i32.add (local.get $data_off) (local.get $physical_off)))
        (return (i32.const -1))))
    (local.set $source (i32.add (global.get $help_doc_file_wa)
      (i32.add (local.get $data_off) (i32.add (local.get $physical_off) (i32.const 12)))))
    (local.set $source_len (i32.sub (local.get $available) (i32.const 12)))
    (local.set $compressed
      (i32.and
        (i32.ge_u (global.get $help_doc_system_minor) (i32.const 16))
        (i32.or
          (i32.eq (global.get $help_doc_system_flags) (i32.const 4))
          (i32.eq (global.get $help_doc_system_flags) (i32.const 8)))))
    (if (local.get $compressed)
      (then
        (if (i32.eqz (call $help_lz77_expand_topic_block
              (local.get $source) (local.get $source_len) (local.get $dest) (i32.const 16384)))
          (then
            (call $help_set_error (global.get $HELP_ERROR_TOPIC_RECORD)
              (i32.add (local.get $data_off) (local.get $physical_off)))
            (return (i32.const -1))))
        (return (global.get $help_topic_block_result_size)))
      (else
        (memory.copy (local.get $dest) (local.get $source) (local.get $source_len))
        (return (local.get $source_len))))
    (i32.const -1))

  (func $help_ld1_read_cu16 (param $ptr i32) (param $end i32) (result i32)
    (local $first i32)
    (global.set $help_ld1_next (i32.const 0))
    (if (i32.ge_u (local.get $ptr) (local.get $end)) (then (return (i32.const 0))))
    (local.set $first (i32.load8_u (local.get $ptr)))
    (if (i32.and (local.get $first) (i32.const 1))
      (then
        (if (i32.gt_u (i32.const 2) (i32.sub (local.get $end) (local.get $ptr)))
          (then (return (i32.const 0))))
        (global.set $help_ld1_value
          (i32.shr_u (i32.load16_u (local.get $ptr)) (i32.const 1)))
        (global.set $help_ld1_next (i32.add (local.get $ptr) (i32.const 2))))
      (else
        (global.set $help_ld1_value (i32.shr_u (local.get $first) (i32.const 1)))
        (global.set $help_ld1_next (i32.add (local.get $ptr) (i32.const 1)))))
    (i32.const 1))

  (func $help_ld1_read_ci16 (param $ptr i32) (param $end i32) (result i32)
    (local $first i32)
    (global.set $help_ld1_next (i32.const 0))
    (if (i32.ge_u (local.get $ptr) (local.get $end)) (then (return (i32.const 0))))
    (local.set $first (i32.load8_u (local.get $ptr)))
    (if (i32.and (local.get $first) (i32.const 1))
      (then
        (if (i32.gt_u (i32.const 2) (i32.sub (local.get $end) (local.get $ptr)))
          (then (return (i32.const 0))))
        (global.set $help_ld1_value
          (i32.sub (i32.shr_u (i32.load16_u (local.get $ptr)) (i32.const 1))
            (i32.const 0x4000)))
        (global.set $help_ld1_next (i32.add (local.get $ptr) (i32.const 2))))
      (else
        (global.set $help_ld1_value
          (i32.sub (i32.shr_u (local.get $first) (i32.const 1)) (i32.const 0x40)))
        (global.set $help_ld1_next (i32.add (local.get $ptr) (i32.const 1)))))
    (i32.const 1))

  (func $help_ld1_read_clong (param $ptr i32) (param $end i32) (result i32)
    (local $first i32)
    (global.set $help_ld1_next (i32.const 0))
    (if (i32.gt_u (local.get $ptr) (local.get $end))
      (then (return (i32.const 0))))
    (if (i32.gt_u (i32.const 2) (i32.sub (local.get $end) (local.get $ptr)))
      (then (return (i32.const 0))))
    (local.set $first (i32.load8_u (local.get $ptr)))
    (if (i32.and (local.get $first) (i32.const 1))
      (then
        (if (i32.gt_u (i32.const 4) (i32.sub (local.get $end) (local.get $ptr)))
          (then (return (i32.const 0))))
        (global.set $help_ld1_value
          (i32.sub (i32.shr_u (i32.load (local.get $ptr)) (i32.const 1))
            (i32.const 0x40000000)))
        (global.set $help_ld1_next (i32.add (local.get $ptr) (i32.const 4))))
      (else
        (global.set $help_ld1_value
          (i32.sub (i32.shr_u (i32.load16_u (local.get $ptr)) (i32.const 1))
            (i32.const 0x4000)))
        (global.set $help_ld1_next (i32.add (local.get $ptr) (i32.const 2)))))
    (i32.const 1))

  (func $help_read_culong (param $ptr i32) (param $end i32) (result i32)
    (local $first i32)
    (global.set $help_ld1_next (i32.const 0))
    (if (i32.gt_u (local.get $ptr) (local.get $end))
      (then (return (i32.const 0))))
    (if (i32.gt_u (i32.const 2) (i32.sub (local.get $end) (local.get $ptr)))
      (then (return (i32.const 0))))
    (local.set $first (i32.load16_u (local.get $ptr)))
    (if (i32.and (local.get $first) (i32.const 1))
      (then
        (if (i32.gt_u (i32.const 4) (i32.sub (local.get $end) (local.get $ptr)))
          (then (return (i32.const 0))))
        (global.set $help_ld1_value
          (i32.shr_u (i32.load (local.get $ptr)) (i32.const 1)))
        (global.set $help_ld1_next (i32.add (local.get $ptr) (i32.const 4))))
      (else
        (global.set $help_ld1_value (i32.shr_u (local.get $first) (i32.const 1)))
        (global.set $help_ld1_next (i32.add (local.get $ptr) (i32.const 2)))))
    (i32.const 1))

  (func $help_ld1_fail (param $topic_pos i32) (result i32)
    (call $help_set_error (global.get $HELP_ERROR_TOPIC_FORMAT) (local.get $topic_pos))
    (i32.const 0))

  (func $help_fmt_add_token
    (param $kind i32) (param $payload_off i32) (param $payload_len i32)
    (param $value i32) (result i32)
    (local $token i32)
    (if (i32.ge_u (global.get $help_fmt_token_count)
          (global.get $HELP_MAX_TOPIC_TOKENS))
      (then (return (i32.const 0))))
    (if (global.get $help_fmt_emit)
      (then
        (local.set $token (i32.add (global.get $help_fmt_tokens_out)
          (i32.mul (global.get $help_fmt_token_count)
            (global.get $HELP_TOPIC_TOKEN_SIZE))))
        (i32.store (local.get $token) (local.get $kind))
        (i32.store offset=4 (local.get $token) (local.get $payload_off))
        (i32.store offset=8 (local.get $token) (local.get $payload_len))
        (i32.store offset=12 (local.get $token) (local.get $value))))
    (global.set $help_fmt_token_count
      (i32.add (global.get $help_fmt_token_count) (i32.const 1)))
    (i32.const 1))

  ;; Convert one already-validated display record into typed tokens. Every
  ;; character command consumes exactly one NUL-terminated LinkData2 string.
  ;; The complete encoded LinkData1 record is copied once into payload_out;
  ;; structured tokens retain offsets into that stable caller-owned copy.
  (func $help_tokenize_linkdata1
    (param $link i32) (param $record_type i32) (param $topic_pos i32)
    (param $raw_start i32) (param $raw_len i32) (result i32)
    (local $ld1_start i32) (local $ptr i32) (local $end i32) (local $data_len1 i32)
    (local $record_payload_off i32) (local $record_payload_len i32)
    (local $columns i32) (local $table_type i32) (local $paragraph_index i32)
    (local $flags i32) (local $bit i32) (local $tab_count i32) (local $i i32)
    (local $tab_stop i32) (local $command i32) (local $command_start i32)
    (local $payload_size i32) (local $picture_type i32) (local $font_index i32)
    (local $raw_ptr i32) (local $raw_end i32) (local $string_start i32)
    (local $string_len i32) (local $token_kind i32) (local $token_value i32)
    (local.set $data_len1 (i32.load offset=16 (local.get $link)))
    (local.set $ld1_start (i32.add (local.get $link) (i32.const 21)))
    (local.set $ptr (local.get $ld1_start))
    (local.set $end (i32.add (local.get $link) (local.get $data_len1)))
    (local.set $record_payload_len (i32.sub (local.get $data_len1) (i32.const 21)))
    (if (i32.gt_u (local.get $record_payload_len)
          (i32.sub (global.get $HELP_MAX_DECOMPRESSED_TOPIC_BYTES)
            (global.get $help_fmt_payload_used)))
      (then
        (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (local.get $topic_pos))
        (return (i32.const 0))))
    (local.set $record_payload_off (global.get $help_fmt_payload_used))
    (global.set $help_fmt_payload_used
      (i32.add (global.get $help_fmt_payload_used) (local.get $record_payload_len)))
    (if (global.get $help_fmt_emit)
      (then
        (memory.copy
          (i32.add (global.get $help_fmt_payload_out) (local.get $record_payload_off))
          (local.get $ld1_start) (local.get $record_payload_len))))
    (local.set $raw_ptr (i32.add (global.get $help_fmt_raw_out) (local.get $raw_start)))
    (local.set $raw_end (i32.add (local.get $raw_ptr) (local.get $raw_len)))
    (if (i32.eqz (call $help_ld1_read_clong (local.get $ptr) (local.get $end)))
      (then (return (call $help_ld1_fail (local.get $topic_pos)))))
    (local.set $ptr (global.get $help_ld1_next))
    (if (i32.or
          (i32.eq (local.get $record_type) (i32.const 0x20))
          (i32.eq (local.get $record_type) (i32.const 0x23)))
      (then
        (if (i32.eqz (call $help_ld1_read_cu16 (local.get $ptr) (local.get $end)))
          (then (return (call $help_ld1_fail (local.get $topic_pos)))))
        (local.set $ptr (global.get $help_ld1_next))))
    (if (i32.eq (local.get $record_type) (i32.const 0x23))
      (then
        (if (i32.gt_u (i32.const 2) (i32.sub (local.get $end) (local.get $ptr)))
          (then (return (call $help_ld1_fail (local.get $topic_pos)))))
        (local.set $columns (i32.load8_u (local.get $ptr)))
        (local.set $table_type (i32.load8_u offset=1 (local.get $ptr)))
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 2)))
        (if (i32.or (i32.eq (local.get $table_type) (i32.const 0))
                    (i32.eq (local.get $table_type) (i32.const 2)))
          (then
            (if (i32.gt_u (i32.const 2) (i32.sub (local.get $end) (local.get $ptr)))
              (then (return (call $help_ld1_fail (local.get $topic_pos)))))
            (local.set $ptr (i32.add (local.get $ptr) (i32.const 2)))))
        (local.set $payload_size (i32.mul (local.get $columns) (i32.const 4)))
        (if (i32.gt_u (local.get $payload_size) (i32.sub (local.get $end) (local.get $ptr)))
          (then (return (call $help_ld1_fail (local.get $topic_pos)))))
        (local.set $ptr (i32.add (local.get $ptr) (local.get $payload_size)))))
    (block $paragraphs_done (loop $paragraphs
      (if (i32.eq (local.get $record_type) (i32.const 0x23))
        (then
          (if (i32.gt_u (i32.const 2) (i32.sub (local.get $end) (local.get $ptr)))
            (then (return (call $help_ld1_fail (local.get $topic_pos)))))
          (if (i32.eq (i32.load16_s (local.get $ptr)) (i32.const -1))
            (then
              (local.set $ptr (i32.add (local.get $ptr) (i32.const 2)))
              (br $paragraphs_done)))
          (if (i32.gt_u (i32.const 5) (i32.sub (local.get $end) (local.get $ptr)))
            (then (return (call $help_ld1_fail (local.get $topic_pos)))))
          (local.set $ptr (i32.add (local.get $ptr) (i32.const 5))))
        (else
          (br_if $paragraphs_done (i32.gt_u (local.get $paragraph_index) (i32.const 0)))))
      (if (i32.gt_u (i32.const 6) (i32.sub (local.get $end) (local.get $ptr)))
        (then (return (call $help_ld1_fail (local.get $topic_pos)))))
      (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
      (local.set $flags (i32.load16_u (local.get $ptr)))
      (local.set $ptr (i32.add (local.get $ptr) (i32.const 2)))
      (if (i32.and (local.get $flags) (i32.const 1))
        (then
          (if (i32.eqz (call $help_ld1_read_clong (local.get $ptr) (local.get $end)))
            (then (return (call $help_ld1_fail (local.get $topic_pos)))))
          (local.set $ptr (global.get $help_ld1_next))))
      (local.set $bit (i32.const 2))
      (block $metrics_done (loop $metrics
        (br_if $metrics_done (i32.gt_u (local.get $bit) (i32.const 0x40)))
        (if (i32.and (local.get $flags) (local.get $bit))
          (then
            (if (i32.eqz (call $help_ld1_read_ci16 (local.get $ptr) (local.get $end)))
              (then (return (call $help_ld1_fail (local.get $topic_pos)))))
            (local.set $ptr (global.get $help_ld1_next))))
        (local.set $bit (i32.shl (local.get $bit) (i32.const 1)))
        (br $metrics)))
      (if (i32.and (local.get $flags) (i32.const 0x0100))
        (then
          (if (i32.gt_u (i32.const 3) (i32.sub (local.get $end) (local.get $ptr)))
            (then (return (call $help_ld1_fail (local.get $topic_pos)))))
          (local.set $ptr (i32.add (local.get $ptr) (i32.const 3)))))
      (if (i32.and (local.get $flags) (i32.const 0x0200))
        (then
          (if (i32.eqz (call $help_ld1_read_ci16 (local.get $ptr) (local.get $end)))
            (then (return (call $help_ld1_fail (local.get $topic_pos)))))
          (local.set $tab_count (global.get $help_ld1_value))
          (local.set $ptr (global.get $help_ld1_next))
          (if (i32.lt_s (local.get $tab_count) (i32.const 0))
            (then (return (call $help_ld1_fail (local.get $topic_pos)))))
          (local.set $i (i32.const 0))
          (block $tabs_done (loop $tabs
            (br_if $tabs_done (i32.ge_u (local.get $i) (local.get $tab_count)))
            (if (i32.eqz (call $help_ld1_read_cu16 (local.get $ptr) (local.get $end)))
              (then (return (call $help_ld1_fail (local.get $topic_pos)))))
            (local.set $tab_stop (global.get $help_ld1_value))
            (local.set $ptr (global.get $help_ld1_next))
            (if (i32.and (local.get $tab_stop) (i32.const 0x4000))
              (then
                (if (i32.eqz (call $help_ld1_read_cu16 (local.get $ptr) (local.get $end)))
                  (then (return (call $help_ld1_fail (local.get $topic_pos)))))
                (local.set $ptr (global.get $help_ld1_next))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $tabs)))))
      (if (i32.eqz (call $help_fmt_add_token
            (global.get $HELP_TOKEN_PARAGRAPH)
            (local.get $record_payload_off) (local.get $record_payload_len)
            (i32.or (i32.shl (local.get $record_type) (i32.const 24))
              (local.get $paragraph_index))))
        (then
          (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (local.get $topic_pos))
          (return (i32.const 0))))
      (block $commands_done (loop $commands
        (if (i32.or (i32.ge_u (local.get $ptr) (local.get $end))
                    (i32.ge_u (local.get $raw_ptr) (local.get $raw_end)))
          (then (return (call $help_ld1_fail (local.get $topic_pos)))))
        (local.set $command_start (local.get $ptr))
        (local.set $command (i32.load8_u (local.get $ptr)))
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
        (local.set $string_start (local.get $raw_ptr))
        (block $string_done (loop $string
          (if (i32.ge_u (local.get $raw_ptr) (local.get $raw_end))
            (then (return (call $help_ld1_fail (local.get $topic_pos)))))
          (br_if $string_done (i32.eqz (i32.load8_u (local.get $raw_ptr))))
          (local.set $raw_ptr (i32.add (local.get $raw_ptr) (i32.const 1)))
          (br $string)))
        (local.set $string_len (i32.sub (local.get $raw_ptr) (local.get $string_start)))
        (local.set $raw_ptr (i32.add (local.get $raw_ptr) (i32.const 1)))
        (if (local.get $string_len)
          (then
            (if (i32.eqz (call $help_fmt_add_token
                  (global.get $HELP_TOKEN_TEXT)
                  (i32.sub (local.get $string_start) (global.get $help_fmt_raw_out))
                  (local.get $string_len) (i32.const 0)))
              (then
                (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (local.get $topic_pos))
                (return (i32.const 0))))))
        (br_if $commands_done (i32.eq (local.get $command) (i32.const 0xFF)))
        (local.set $token_kind (i32.const 0))
        (local.set $token_value (local.get $command))
        (block $handled
          (if (i32.eq (local.get $command) (i32.const 0x81))
            (then
              (local.set $token_kind (global.get $HELP_TOKEN_LINE_BREAK))
              (local.set $token_value (i32.const 0))
              (br $handled)))
          (if (i32.eq (local.get $command) (i32.const 0x82))
            (then
              (local.set $token_kind (global.get $HELP_TOKEN_LINE_BREAK))
              (local.set $token_value (i32.const 1))
              (br $handled)))
          (if (i32.or
                (i32.eq (local.get $command) (i32.const 0x83))
                (i32.or (i32.eq (local.get $command) (i32.const 0x8B))
                        (i32.eq (local.get $command) (i32.const 0x8C))))
            (then
              (local.set $token_kind (global.get $HELP_TOKEN_SPACE))
              (br $handled)))
          (if (i32.eq (local.get $command) (i32.const 0x89))
            (then
              (local.set $token_kind (global.get $HELP_TOKEN_HOTSPOT_END))
              (br $handled)))
          (if (i32.eq (local.get $command) (i32.const 0x20))
            (then
              (if (i32.gt_u (i32.const 4) (i32.sub (local.get $end) (local.get $ptr)))
                (then (return (call $help_ld1_fail (local.get $topic_pos)))))
              (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
              (br $handled)))
          (if (i32.eq (local.get $command) (i32.const 0x21))
            (then
              (if (i32.gt_u (i32.const 2) (i32.sub (local.get $end) (local.get $ptr)))
                (then (return (call $help_ld1_fail (local.get $topic_pos)))))
              (local.set $ptr (i32.add (local.get $ptr) (i32.const 2)))
              (br $handled)))
          (if (i32.eq (local.get $command) (i32.const 0x80))
            (then
              (if (i32.gt_u (i32.const 2) (i32.sub (local.get $end) (local.get $ptr)))
                (then (return (call $help_ld1_fail (local.get $topic_pos)))))
              (local.set $font_index (i32.load16_u (local.get $ptr)))
              (local.set $ptr (i32.add (local.get $ptr) (i32.const 2)))
              (local.set $token_kind (global.get $HELP_TOKEN_FONT))
              (local.set $token_value (local.get $font_index))
              (br $handled)))
          (if (i32.or
                (i32.or (i32.eq (local.get $command) (i32.const 0x86))
                        (i32.eq (local.get $command) (i32.const 0x87)))
                (i32.eq (local.get $command) (i32.const 0x88)))
            (then
              (if (i32.ge_u (local.get $ptr) (local.get $end))
                (then (return (call $help_ld1_fail (local.get $topic_pos)))))
              (local.set $picture_type (i32.load8_u (local.get $ptr)))
              (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
              (if (i32.eqz (call $help_ld1_read_clong (local.get $ptr) (local.get $end)))
                (then (return (call $help_ld1_fail (local.get $topic_pos)))))
              (local.set $payload_size (global.get $help_ld1_value))
              (local.set $ptr (global.get $help_ld1_next))
              (if (i32.eq (local.get $picture_type) (i32.const 0x22))
                (then
                  (if (i32.eqz (call $help_ld1_read_cu16 (local.get $ptr) (local.get $end)))
                    (then (return (call $help_ld1_fail (local.get $topic_pos)))))
                  (local.set $ptr (global.get $help_ld1_next))))
              (if (i32.gt_u (local.get $payload_size) (i32.sub (local.get $end) (local.get $ptr)))
                (then (return (call $help_ld1_fail (local.get $topic_pos)))))
              (local.set $ptr (i32.add (local.get $ptr) (local.get $payload_size)))
              (local.set $token_kind (global.get $HELP_TOKEN_BITMAP))
              (br $handled)))
          (if (i32.or (i32.eq (local.get $command) (i32.const 0xC8))
                      (i32.eq (local.get $command) (i32.const 0xCC)))
            (then
              (if (i32.gt_u (i32.const 2) (i32.sub (local.get $end) (local.get $ptr)))
                (then (return (call $help_ld1_fail (local.get $topic_pos)))))
              (local.set $payload_size (i32.load16_u (local.get $ptr)))
              (local.set $ptr (i32.add (local.get $ptr) (i32.const 2)))
              (if (i32.gt_u (local.get $payload_size) (i32.sub (local.get $end) (local.get $ptr)))
                (then (return (call $help_ld1_fail (local.get $topic_pos)))))
              (local.set $ptr (i32.add (local.get $ptr) (local.get $payload_size)))
              (local.set $token_kind (global.get $HELP_TOKEN_MACRO))
              (br $handled)))
          (if (i32.or
                (i32.or (i32.eq (local.get $command) (i32.const 0xEA))
                        (i32.eq (local.get $command) (i32.const 0xEB)))
                (i32.or (i32.eq (local.get $command) (i32.const 0xEE))
                        (i32.eq (local.get $command) (i32.const 0xEF))))
            (then
              (if (i32.gt_u (i32.const 2) (i32.sub (local.get $end) (local.get $ptr)))
                (then (return (call $help_ld1_fail (local.get $topic_pos)))))
              (local.set $payload_size (i32.load16_u (local.get $ptr)))
              (local.set $ptr (i32.add (local.get $ptr) (i32.const 2)))
              (if (i32.gt_u (local.get $payload_size) (i32.sub (local.get $end) (local.get $ptr)))
                (then (return (call $help_ld1_fail (local.get $topic_pos)))))
              (local.set $ptr (i32.add (local.get $ptr) (local.get $payload_size)))
              (local.set $token_kind (global.get $HELP_TOKEN_HOTSPOT_BEGIN))
              (br $handled)))
          (if (i32.or
                (i32.or
                  (i32.or (i32.eq (local.get $command) (i32.const 0xE0))
                          (i32.eq (local.get $command) (i32.const 0xE1)))
                  (i32.or (i32.eq (local.get $command) (i32.const 0xE2))
                          (i32.eq (local.get $command) (i32.const 0xE3))))
                (i32.or (i32.eq (local.get $command) (i32.const 0xE6))
                        (i32.eq (local.get $command) (i32.const 0xE7))))
            (then
              (if (i32.gt_u (i32.const 4) (i32.sub (local.get $end) (local.get $ptr)))
                (then (return (call $help_ld1_fail (local.get $topic_pos)))))
              (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
              (local.set $token_kind (global.get $HELP_TOKEN_HOTSPOT_BEGIN))
              (br $handled)))
          (return (call $help_ld1_fail (local.get $topic_pos))))
        (if (local.get $token_kind)
          (then
            (if (i32.eqz (call $help_fmt_add_token
                  (local.get $token_kind)
                  (i32.add (local.get $record_payload_off)
                    (i32.sub (local.get $command_start) (local.get $ld1_start)))
                  (i32.sub (local.get $ptr) (local.get $command_start))
                  (local.get $token_value)))
              (then
                (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (local.get $topic_pos))
                (return (i32.const 0))))))
        (br $commands)))
      (local.set $paragraph_index (i32.add (local.get $paragraph_index) (i32.const 1)))
      (br $paragraphs)))
    (if (i32.or (i32.ne (local.get $ptr) (local.get $end))
                (i32.ne (local.get $raw_ptr) (local.get $raw_end)))
      (then (return (call $help_ld1_fail (local.get $topic_pos)))))
    (i32.const 1))

  ;; Validate every conditional LinkData1 field before topic tokens refer to
  ;; it. This consumes the complete paragraph/table grammar and all documented
  ;; character-command payloads without retaining decompression-buffer pointers.
  (func $help_validate_linkdata1
    (param $link i32) (param $record_type i32) (param $topic_pos i32) (result i32)
    (local $ptr i32) (local $end i32) (local $data_len1 i32)
    (local $columns i32) (local $table_type i32) (local $paragraph_index i32)
    (local $flags i32) (local $bit i32) (local $tab_count i32) (local $i i32)
    (local $tab_stop i32) (local $command i32) (local $payload_size i32)
    (local $picture_type i32)
    (local.set $data_len1 (i32.load offset=16 (local.get $link)))
    (local.set $ptr (i32.add (local.get $link) (i32.const 21)))
    (local.set $end (i32.add (local.get $link) (local.get $data_len1)))
    (if (i32.ge_u (global.get $help_doc_display_record_count)
          (global.get $HELP_MAX_TOPIC_LINKS))
      (then
        (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (local.get $topic_pos))
        (return (i32.const 0))))
    (global.set $help_doc_display_record_count
      (i32.add (global.get $help_doc_display_record_count) (i32.const 1)))
    (if (i32.eqz (call $help_ld1_read_clong (local.get $ptr) (local.get $end)))
      (then (return (call $help_ld1_fail (local.get $topic_pos)))))
    (local.set $ptr (global.get $help_ld1_next))
    (if (i32.or
          (i32.eq (local.get $record_type) (i32.const 0x20))
          (i32.eq (local.get $record_type) (i32.const 0x23)))
      (then
        (if (i32.eqz (call $help_ld1_read_cu16 (local.get $ptr) (local.get $end)))
          (then (return (call $help_ld1_fail (local.get $topic_pos)))))
        (local.set $ptr (global.get $help_ld1_next))))
    (if (i32.eq (local.get $record_type) (i32.const 0x23))
      (then
        (if (i32.gt_u (i32.const 2) (i32.sub (local.get $end) (local.get $ptr)))
          (then (return (call $help_ld1_fail (local.get $topic_pos)))))
        (local.set $columns (i32.load8_u (local.get $ptr)))
        (local.set $table_type (i32.load8_u offset=1 (local.get $ptr)))
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 2)))
        (if (i32.or (i32.eq (local.get $table_type) (i32.const 0))
                    (i32.eq (local.get $table_type) (i32.const 2)))
          (then
            (if (i32.gt_u (i32.const 2) (i32.sub (local.get $end) (local.get $ptr)))
              (then (return (call $help_ld1_fail (local.get $topic_pos)))))
            (local.set $ptr (i32.add (local.get $ptr) (i32.const 2))))
          (else
            (if (i32.and
                  (i32.ne (local.get $table_type) (i32.const 1))
                  (i32.ne (local.get $table_type) (i32.const 3)))
              (then (return (call $help_ld1_fail (local.get $topic_pos)))))))
        (local.set $payload_size (i32.mul (local.get $columns) (i32.const 4)))
        (if (i32.gt_u (local.get $payload_size) (i32.sub (local.get $end) (local.get $ptr)))
          (then (return (call $help_ld1_fail (local.get $topic_pos)))))
        (local.set $ptr (i32.add (local.get $ptr) (local.get $payload_size)))
        (global.set $help_doc_table_count
          (i32.add (global.get $help_doc_table_count) (i32.const 1)))))
    (block $paragraphs_done (loop $paragraphs
      (if (i32.eq (local.get $record_type) (i32.const 0x23))
        (then
          (if (i32.gt_u (i32.const 2) (i32.sub (local.get $end) (local.get $ptr)))
            (then (return (call $help_ld1_fail (local.get $topic_pos)))))
          (if (i32.eq (i32.load16_s (local.get $ptr)) (i32.const -1))
            (then
              (local.set $ptr (i32.add (local.get $ptr) (i32.const 2)))
              (br $paragraphs_done)))
          (if (i32.gt_u (i32.const 5) (i32.sub (local.get $end) (local.get $ptr)))
            (then (return (call $help_ld1_fail (local.get $topic_pos)))))
          (local.set $ptr (i32.add (local.get $ptr) (i32.const 5))))
        (else
          (br_if $paragraphs_done (i32.gt_u (local.get $paragraph_index) (i32.const 0)))))
      (if (i32.ge_u (global.get $help_doc_paragraph_count)
            (global.get $HELP_MAX_TOPIC_TOKENS))
        (then
          (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (local.get $topic_pos))
          (return (i32.const 0))))
      (global.set $help_doc_paragraph_count
        (i32.add (global.get $help_doc_paragraph_count) (i32.const 1)))
      (if (i32.gt_u (i32.const 6) (i32.sub (local.get $end) (local.get $ptr)))
        (then (return (call $help_ld1_fail (local.get $topic_pos)))))
      (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
      (local.set $flags (i32.load16_u (local.get $ptr)))
      (local.set $ptr (i32.add (local.get $ptr) (i32.const 2)))
      (if (i32.and (local.get $flags) (i32.const 1))
        (then
          (if (i32.eqz (call $help_ld1_read_clong (local.get $ptr) (local.get $end)))
            (then (return (call $help_ld1_fail (local.get $topic_pos)))))
          (local.set $ptr (global.get $help_ld1_next))))
      (local.set $bit (i32.const 2))
      (block $metrics_done (loop $metrics
        (br_if $metrics_done (i32.gt_u (local.get $bit) (i32.const 0x40)))
        (if (i32.and (local.get $flags) (local.get $bit))
          (then
            (if (i32.eqz (call $help_ld1_read_ci16 (local.get $ptr) (local.get $end)))
              (then (return (call $help_ld1_fail (local.get $topic_pos)))))
            (local.set $ptr (global.get $help_ld1_next))))
        (local.set $bit (i32.shl (local.get $bit) (i32.const 1)))
        (br $metrics)))
      (if (i32.and (local.get $flags) (i32.const 0x0100))
        (then
          (if (i32.gt_u (i32.const 3) (i32.sub (local.get $end) (local.get $ptr)))
            (then (return (call $help_ld1_fail (local.get $topic_pos)))))
          (local.set $ptr (i32.add (local.get $ptr) (i32.const 3)))))
      (if (i32.and (local.get $flags) (i32.const 0x0200))
        (then
          (if (i32.eqz (call $help_ld1_read_ci16 (local.get $ptr) (local.get $end)))
            (then (return (call $help_ld1_fail (local.get $topic_pos)))))
          (local.set $tab_count (global.get $help_ld1_value))
          (local.set $ptr (global.get $help_ld1_next))
          (if (i32.or (i32.lt_s (local.get $tab_count) (i32.const 0))
                      (i32.gt_u (local.get $tab_count) (global.get $HELP_MAX_TOPIC_TOKENS)))
            (then (return (call $help_ld1_fail (local.get $topic_pos)))))
          (local.set $i (i32.const 0))
          (block $tabs_done (loop $tabs
            (br_if $tabs_done (i32.ge_u (local.get $i) (local.get $tab_count)))
            (if (i32.eqz (call $help_ld1_read_cu16 (local.get $ptr) (local.get $end)))
              (then (return (call $help_ld1_fail (local.get $topic_pos)))))
            (local.set $tab_stop (global.get $help_ld1_value))
            (local.set $ptr (global.get $help_ld1_next))
            (if (i32.and (local.get $tab_stop) (i32.const 0x4000))
              (then
                (if (i32.eqz (call $help_ld1_read_cu16 (local.get $ptr) (local.get $end)))
                  (then (return (call $help_ld1_fail (local.get $topic_pos)))))
                (local.set $ptr (global.get $help_ld1_next))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $tabs)))))
      (block $commands_done (loop $commands
        (if (i32.ge_u (local.get $ptr) (local.get $end))
          (then (return (call $help_ld1_fail (local.get $topic_pos)))))
        (local.set $command (i32.load8_u (local.get $ptr)))
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
        (if (i32.ge_u (global.get $help_doc_format_command_count)
              (global.get $HELP_MAX_FILE_BYTES))
          (then
            (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (local.get $topic_pos))
            (return (i32.const 0))))
        (global.set $help_doc_format_command_count
          (i32.add (global.get $help_doc_format_command_count) (i32.const 1)))
        (br_if $commands_done (i32.eq (local.get $command) (i32.const 0xFF)))
        (block $handled
          (if (i32.or
                (i32.or (i32.eq (local.get $command) (i32.const 0x81))
                        (i32.eq (local.get $command) (i32.const 0x82)))
                (i32.or
                  (i32.or (i32.eq (local.get $command) (i32.const 0x83))
                          (i32.eq (local.get $command) (i32.const 0x89)))
                  (i32.or
                    (i32.or (i32.eq (local.get $command) (i32.const 0x8B))
                            (i32.eq (local.get $command) (i32.const 0x8C)))
                    (i32.const 0))))
            (then (br $handled)))
          (if (i32.eq (local.get $command) (i32.const 0x20))
            (then
              (if (i32.gt_u (i32.const 4) (i32.sub (local.get $end) (local.get $ptr)))
                (then (return (call $help_ld1_fail (local.get $topic_pos)))))
              (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
              (br $handled)))
          (if (i32.or (i32.eq (local.get $command) (i32.const 0x21))
                      (i32.eq (local.get $command) (i32.const 0x80)))
            (then
              (if (i32.gt_u (i32.const 2) (i32.sub (local.get $end) (local.get $ptr)))
                (then (return (call $help_ld1_fail (local.get $topic_pos)))))
              (local.set $ptr (i32.add (local.get $ptr) (i32.const 2)))
              (br $handled)))
          (if (i32.or
                (i32.or (i32.eq (local.get $command) (i32.const 0x86))
                        (i32.eq (local.get $command) (i32.const 0x87)))
                (i32.eq (local.get $command) (i32.const 0x88)))
            (then
              (if (i32.ge_u (local.get $ptr) (local.get $end))
                (then (return (call $help_ld1_fail (local.get $topic_pos)))))
              (local.set $picture_type (i32.load8_u (local.get $ptr)))
              (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
              (if (i32.eqz (call $help_ld1_read_clong (local.get $ptr) (local.get $end)))
                (then (return (call $help_ld1_fail (local.get $topic_pos)))))
              (local.set $payload_size (global.get $help_ld1_value))
              (local.set $ptr (global.get $help_ld1_next))
              (if (i32.eq (local.get $picture_type) (i32.const 0x22))
                (then
                  (if (i32.eqz (call $help_ld1_read_cu16 (local.get $ptr) (local.get $end)))
                    (then (return (call $help_ld1_fail (local.get $topic_pos)))))
                  (local.set $ptr (global.get $help_ld1_next))))
              (if (i32.gt_u (local.get $payload_size) (i32.sub (local.get $end) (local.get $ptr)))
                (then (return (call $help_ld1_fail (local.get $topic_pos)))))
              (local.set $ptr (i32.add (local.get $ptr) (local.get $payload_size)))
              (br $handled)))
          (if (i32.or
                (i32.or
                  (i32.or (i32.eq (local.get $command) (i32.const 0xC8))
                          (i32.eq (local.get $command) (i32.const 0xCC)))
                  (i32.or (i32.eq (local.get $command) (i32.const 0xEA))
                          (i32.eq (local.get $command) (i32.const 0xEB))))
                (i32.or (i32.eq (local.get $command) (i32.const 0xEE))
                        (i32.eq (local.get $command) (i32.const 0xEF))))
            (then
              (if (i32.gt_u (i32.const 2) (i32.sub (local.get $end) (local.get $ptr)))
                (then (return (call $help_ld1_fail (local.get $topic_pos)))))
              (local.set $payload_size (i32.load16_u (local.get $ptr)))
              (local.set $ptr (i32.add (local.get $ptr) (i32.const 2)))
              (if (i32.gt_u (local.get $payload_size) (i32.sub (local.get $end) (local.get $ptr)))
                (then (return (call $help_ld1_fail (local.get $topic_pos)))))
              (local.set $ptr (i32.add (local.get $ptr) (local.get $payload_size)))
              (br $handled)))
          (if (i32.or
                (i32.or
                  (i32.or (i32.eq (local.get $command) (i32.const 0xE0))
                          (i32.eq (local.get $command) (i32.const 0xE1)))
                  (i32.or (i32.eq (local.get $command) (i32.const 0xE2))
                          (i32.eq (local.get $command) (i32.const 0xE3))))
                (i32.or (i32.eq (local.get $command) (i32.const 0xE6))
                        (i32.eq (local.get $command) (i32.const 0xE7))))
            (then
              (if (i32.gt_u (i32.const 4) (i32.sub (local.get $end) (local.get $ptr)))
                (then (return (call $help_ld1_fail (local.get $topic_pos)))))
              (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
              (br $handled)))
          (return (call $help_ld1_fail (local.get $topic_pos))))
        (br $commands)))
      (local.set $paragraph_index (i32.add (local.get $paragraph_index) (i32.const 1)))
      (br $paragraphs)))
    (if (i32.ne (local.get $ptr) (local.get $end))
      (then (return (call $help_ld1_fail (local.get $topic_pos)))))
    (i32.const 1))

  ;; Validate the complete WinHelp 3.1 TOPICLINK chain and bind each
  ;; canonical TTLBTREE entry to its type-2 topic-header TOPICPOS.
  (func $help_parse_topic_links
    (param $topic_internal i32) (param $topics_wa i32) (param $topic_count i32)
    (result i32)
    (local $internal_record i32) (local $temp_ga i32) (local $temp_wa i32)
    (local $logical_size i32) (local $current i32) (local $previous i32)
    (local $block_number i32) (local $loaded_block i32) (local $block_bytes i32)
    (local $relative i32) (local $link i32) (local $block_size i32)
    (local $data_len2 i32) (local $prev_link i32) (local $next_link i32)
    (local $data_len1 i32) (local $record_type i32)
    (local $link_count i32) (local $header_count i32) (local $topic_record i32)
    (local $ok i32)
    (global.set $help_doc_display_record_count (i32.const 0))
    (global.set $help_doc_paragraph_count (i32.const 0))
    (global.set $help_doc_table_count (i32.const 0))
    (global.set $help_doc_format_command_count (i32.const 0))
    (local.set $internal_record (i32.add (global.get $help_doc_directory_wa)
      (i32.mul (local.get $topic_internal) (global.get $HELP_INTERNAL_FILE_SIZE))))
    (local.set $temp_ga (call $heap_alloc (i32.const 16384)))
    (if (i32.eqz (local.get $temp_ga))
      (then
        (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
        (return (i32.const 0))))
    (local.set $temp_wa (call $g2w (local.get $temp_ga)))
    (local.set $logical_size (call $help_topic_logical_block_size))
    (local.set $current (i32.const 12))
    (local.set $previous (i32.const -1))
    (local.set $loaded_block (i32.const -1))
    (block $done (loop $links
      (if (i32.ge_u (local.get $link_count) (global.get $HELP_MAX_TOPIC_LINKS))
        (then
          (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (i32.const 0))
          (br $done)))
      (if (i32.lt_s (local.get $current) (i32.const 12))
        (then
          (call $help_set_error (global.get $HELP_ERROR_TOPIC_RECORD) (i32.const 0))
          (br $done)))
      (local.set $block_number
        (i32.div_u (i32.sub (local.get $current) (i32.const 12)) (local.get $logical_size)))
      (local.set $relative
        (i32.rem_u (i32.sub (local.get $current) (i32.const 12)) (local.get $logical_size)))
      (if (i32.ne (local.get $block_number) (local.get $loaded_block))
        (then
          (local.set $block_bytes (call $help_topic_load_block
            (local.get $internal_record) (local.get $block_number) (local.get $temp_wa)))
          (if (i32.lt_s (local.get $block_bytes) (i32.const 0)) (then (br $done)))
          (local.set $loaded_block (local.get $block_number))))
      (if (i32.or
            (i32.gt_u (local.get $relative) (local.get $block_bytes))
            (i32.gt_u (i32.const 21) (i32.sub (local.get $block_bytes) (local.get $relative))))
        (then
          (call $help_set_error (global.get $HELP_ERROR_TOPIC_RECORD) (local.get $current))
          (br $done)))
      (local.set $link (i32.add (local.get $temp_wa) (local.get $relative)))
      (local.set $block_size (i32.load (local.get $link)))
      (local.set $data_len2 (i32.load offset=4 (local.get $link)))
      (local.set $prev_link (i32.load offset=8 (local.get $link)))
      (local.set $next_link (i32.load offset=12 (local.get $link)))
      (local.set $data_len1 (i32.load offset=16 (local.get $link)))
      (local.set $record_type (i32.load8_u offset=20 (local.get $link)))
      (if (i32.or
            (i32.or (i32.lt_s (local.get $block_size) (i32.const 21))
                    (i32.lt_s (local.get $data_len1) (i32.const 21)))
            (i32.or (i32.gt_u (local.get $data_len1) (local.get $block_size))
                    (i32.lt_s (local.get $data_len2) (i32.const 0))))
        (then
          (call $help_set_error (global.get $HELP_ERROR_TOPIC_RECORD) (local.get $current))
          (br $done)))
      (if (i32.gt_u (local.get $block_size) (i32.sub (local.get $block_bytes) (local.get $relative)))
        (then
          ;; Cross-block link data is rejected until a bounded gather buffer
          ;; is added; no checked-in fixture relies on it.
          (call $help_set_error (global.get $HELP_ERROR_TOPIC_RECORD) (local.get $current))
          (br $done)))
      (if (i32.ne (local.get $prev_link) (local.get $previous))
        (then
          (call $help_set_error (global.get $HELP_ERROR_TOPIC_RECORD)
            (i32.add (local.get $current) (i32.const 8)))
          (br $done)))
      (if (i32.eq (local.get $record_type) (i32.const 2))
        (then
          (if (i32.ge_u (local.get $header_count) (local.get $topic_count))
            (then
              (call $help_set_error (global.get $HELP_ERROR_TOPIC_RECORD) (local.get $current))
              (br $done)))
          (local.set $topic_record (i32.add (local.get $topics_wa)
            (i32.mul (local.get $header_count) (global.get $HELP_TOPIC_SIZE))))
          (i32.store offset=4 (local.get $topic_record) (local.get $current))
          (local.set $header_count (i32.add (local.get $header_count) (i32.const 1))))
        (else
          (if (i32.and
                (i32.ne (local.get $record_type) (i32.const 0x20))
                (i32.ne (local.get $record_type) (i32.const 0x23)))
            (then
              (call $help_set_error (global.get $HELP_ERROR_TOPIC_RECORD)
                (i32.add (local.get $current) (i32.const 20)))
              (br $done)))))
      (if (i32.or
            (i32.eq (local.get $record_type) (i32.const 0x20))
            (i32.eq (local.get $record_type) (i32.const 0x23)))
        (then
          (if (i32.eqz (call $help_validate_linkdata1
                (local.get $link) (local.get $record_type) (local.get $current)))
            (then (br $done)))))
      (local.set $link_count (i32.add (local.get $link_count) (i32.const 1)))
      (if (i32.or (i32.eq (local.get $next_link) (i32.const -1))
                  (i32.eqz (local.get $next_link)))
        (then
          (if (i32.ne (local.get $header_count) (local.get $topic_count))
            (then
              (call $help_set_error (global.get $HELP_ERROR_TOPIC_RECORD) (local.get $current))
              (br $done)))
          (local.set $ok (i32.const 1))
          (br $done)))
      (if (i32.le_s (local.get $next_link) (local.get $current))
        (then
          (call $help_set_error (global.get $HELP_ERROR_TOPIC_RECORD)
            (i32.add (local.get $current) (i32.const 12)))
          (br $done)))
      (local.set $previous (local.get $current))
      (local.set $current (local.get $next_link))
      (br $links)))
    (call $heap_free (local.get $temp_ga))
    (local.get $ok))

  (func $help_decode_hall_topic_data
    (param $source i32) (param $source_len i32)
    (param $dest i32) (param $expected_len i32) (result i32)
    (local $source_pos i32) (local $dest_pos i32) (local $ch i32)
    (local $next i32) (local $phrase_index i32) (local $phrase_start i32)
    (local $phrase_end i32) (local $length i32) (local $fill i32)
    (block $decoded (loop $tokens
      (br_if $decoded (i32.ge_u (local.get $dest_pos) (local.get $expected_len)))
      (if (i32.ge_u (local.get $source_pos) (local.get $source_len))
        (then (return (i32.const 0))))
      (local.set $ch (i32.load8_u (i32.add (local.get $source) (local.get $source_pos))))
      (local.set $source_pos (i32.add (local.get $source_pos) (i32.const 1)))
      (block $classified
        (if (i32.eqz (i32.and (local.get $ch) (i32.const 1)))
          (then
            (local.set $phrase_index (i32.shr_u (local.get $ch) (i32.const 1)))
            (br $classified)))
        (if (i32.eq (i32.and (local.get $ch) (i32.const 3)) (i32.const 1))
          (then
            (if (i32.ge_u (local.get $source_pos) (local.get $source_len))
              (then (return (i32.const 0))))
            (local.set $next (i32.load8_u (i32.add (local.get $source) (local.get $source_pos))))
            (local.set $source_pos (i32.add (local.get $source_pos) (i32.const 1)))
            (local.set $phrase_index
              (i32.add (i32.shl (i32.add (local.get $ch) (i32.const 1)) (i32.const 6))
                       (local.get $next)))
            (br $classified)))
        (if (i32.eq (i32.and (local.get $ch) (i32.const 7)) (i32.const 3))
          (then
            (local.set $length (i32.add (i32.shr_u (local.get $ch) (i32.const 3)) (i32.const 1)))
            (if (i32.or
                  (i32.gt_u (local.get $length) (i32.sub (local.get $source_len) (local.get $source_pos)))
                  (i32.gt_u (local.get $length) (i32.sub (local.get $expected_len) (local.get $dest_pos))))
              (then (return (i32.const 0))))
            (memory.copy (i32.add (local.get $dest) (local.get $dest_pos))
              (i32.add (local.get $source) (local.get $source_pos)) (local.get $length))
            (local.set $source_pos (i32.add (local.get $source_pos) (local.get $length)))
            (local.set $dest_pos (i32.add (local.get $dest_pos) (local.get $length)))
            (br $tokens)))
        (local.set $length (i32.add (i32.shr_u (local.get $ch) (i32.const 4)) (i32.const 1)))
        (if (i32.gt_u (local.get $length) (i32.sub (local.get $expected_len) (local.get $dest_pos)))
          (then (return (i32.const 0))))
        (local.set $fill
          (if (result i32) (i32.eq (i32.and (local.get $ch) (i32.const 15)) (i32.const 7))
            (then (i32.const 0x20)) (else (i32.const 0))))
        (memory.fill (i32.add (local.get $dest) (local.get $dest_pos))
          (local.get $fill) (local.get $length))
        (local.set $dest_pos (i32.add (local.get $dest_pos) (local.get $length)))
        (br $tokens))
      ;; Phrase cases branch here with phrase_index populated. Literal/fill
      ;; cases branch directly back to the loop above.
      (if (i32.ge_u (local.get $phrase_index) (global.get $help_doc_phrase_count))
        (then (return (i32.const 0))))
      (local.set $phrase_start (i32.load (i32.add (global.get $help_doc_phrase_offsets_wa)
        (i32.mul (local.get $phrase_index) (i32.const 4)))))
      (local.set $phrase_end (i32.load (i32.add (global.get $help_doc_phrase_offsets_wa)
        (i32.mul (i32.add (local.get $phrase_index) (i32.const 1)) (i32.const 4)))))
      (local.set $length (i32.sub (local.get $phrase_end) (local.get $phrase_start)))
      (if (i32.gt_u (local.get $length) (i32.sub (local.get $expected_len) (local.get $dest_pos)))
        (then (return (i32.const 0))))
      (memory.copy (i32.add (local.get $dest) (local.get $dest_pos))
        (i32.add (global.get $help_doc_phrase_image_wa) (local.get $phrase_start))
        (local.get $length))
      (local.set $dest_pos (i32.add (local.get $dest_pos) (local.get $length)))
      (br $tokens)))
    (i32.and
      (i32.eq (local.get $source_pos) (local.get $source_len))
      (i32.eq (local.get $dest_pos) (local.get $expected_len))))

  (func $help_decode_old_topic_data
    (param $source i32) (param $source_len i32)
    (param $dest i32) (param $expected_len i32) (result i32)
    (local $source_pos i32) (local $dest_pos i32) (local $ch i32)
    (local $code i32) (local $phrase_index i32) (local $phrase_start i32)
    (local $phrase_end i32) (local $length i32)
    (block $decoded (loop $tokens
      (br_if $decoded (i32.ge_u (local.get $dest_pos) (local.get $expected_len)))
      (if (i32.ge_u (local.get $source_pos) (local.get $source_len))
        (then (return (i32.const 0))))
      (local.set $ch (i32.load8_u (i32.add (local.get $source) (local.get $source_pos))))
      (local.set $source_pos (i32.add (local.get $source_pos) (i32.const 1)))
      (if (i32.and (i32.gt_u (local.get $ch) (i32.const 0))
                    (i32.lt_u (local.get $ch) (i32.const 16)))
        (then
          (if (i32.ge_u (local.get $source_pos) (local.get $source_len))
            (then (return (i32.const 0))))
          (local.set $code
            (i32.add
              (i32.shl (i32.sub (local.get $ch) (i32.const 1)) (i32.const 8))
              (i32.load8_u (i32.add (local.get $source) (local.get $source_pos)))))
          (local.set $source_pos (i32.add (local.get $source_pos) (i32.const 1)))
          (local.set $phrase_index (i32.shr_u (local.get $code) (i32.const 1)))
          (if (i32.ge_u (local.get $phrase_index) (global.get $help_doc_phrase_count))
            (then (return (i32.const 0))))
          (local.set $phrase_start (i32.load (i32.add
            (global.get $help_doc_phrase_offsets_wa)
            (i32.mul (local.get $phrase_index) (i32.const 4)))))
          (local.set $phrase_end (i32.load (i32.add
            (global.get $help_doc_phrase_offsets_wa)
            (i32.mul (i32.add (local.get $phrase_index) (i32.const 1)) (i32.const 4)))))
          (local.set $length (i32.sub (local.get $phrase_end) (local.get $phrase_start)))
          (if (i32.gt_u (local.get $length)
                (i32.sub (local.get $expected_len) (local.get $dest_pos)))
            (then (return (i32.const 0))))
          (memory.copy (i32.add (local.get $dest) (local.get $dest_pos))
            (i32.add (global.get $help_doc_phrase_image_wa) (local.get $phrase_start))
            (local.get $length))
          (local.set $dest_pos (i32.add (local.get $dest_pos) (local.get $length)))
          (if (i32.and (local.get $code) (i32.const 1))
            (then
              (if (i32.ge_u (local.get $dest_pos) (local.get $expected_len))
                (then (return (i32.const 0))))
              (i32.store8 (i32.add (local.get $dest) (local.get $dest_pos)) (i32.const 0x20))
              (local.set $dest_pos (i32.add (local.get $dest_pos) (i32.const 1))))))
        (else
          (if (i32.ge_u (local.get $dest_pos) (local.get $expected_len))
            (then (return (i32.const 0))))
          (i32.store8 (i32.add (local.get $dest) (local.get $dest_pos)) (local.get $ch))
          (local.set $dest_pos (i32.add (local.get $dest_pos) (i32.const 1)))))
      (br $tokens)))
    (i32.and
      (i32.eq (local.get $source_pos) (local.get $source_len))
      (i32.eq (local.get $dest_pos) (local.get $expected_len))))

  ;; Decode the raw LinkData2 stream for one canonical topic. NUL paragraph
  ;; separators are retained for the formatted-token builder. Returns -1 on
  ;; malformed input or insufficient output capacity.
  (func $help_decode_topic_raw
    (param $topic_index i32) (param $out_wa i32) (param $capacity i32)
    (result i32)
    (local $memory_bytes i32) (local $topic_record i32) (local $internal_index i32)
    (local $internal_record i32) (local $temp_ga i32) (local $temp_wa i32)
    (local $logical_size i32) (local $current i32) (local $block_number i32)
    (local $loaded_block i32) (local $block_bytes i32) (local $relative i32)
    (local $link i32) (local $block_size i32) (local $data_len2 i32)
    (local $next_link i32) (local $data_len1 i32) (local $record_type i32)
    (local $source_len i32) (local $source i32) (local $total i32)
    (local $first_header i32) (local $link_count i32) (local $decoded_ok i32) (local $ok i32)
    (if (i32.ge_u (local.get $topic_index) (global.get $help_doc_topic_count))
      (then (return (i32.const -1))))
    (local.set $memory_bytes (i32.shl (memory.size) (i32.const 16)))
    (if (i32.or
          (i32.gt_u (local.get $out_wa) (local.get $memory_bytes))
          (i32.gt_u (local.get $capacity) (i32.sub (local.get $memory_bytes) (local.get $out_wa))))
      (then (return (i32.const -1))))
    (local.set $topic_record (i32.add (global.get $help_doc_topics_wa)
      (i32.mul (local.get $topic_index) (global.get $HELP_TOPIC_SIZE))))
    (local.set $current (i32.load offset=4 (local.get $topic_record)))
    (local.set $internal_index (call $help_find_internal_literal (i32.const 2)))
    (if (i32.lt_s (local.get $internal_index) (i32.const 0))
      (then (return (i32.const -1))))
    (local.set $internal_record (i32.add (global.get $help_doc_directory_wa)
      (i32.mul (local.get $internal_index) (global.get $HELP_INTERNAL_FILE_SIZE))))
    (local.set $temp_ga (call $heap_alloc (i32.const 16384)))
    (if (i32.eqz (local.get $temp_ga))
      (then
        (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
        (return (i32.const -1))))
    (local.set $temp_wa (call $g2w (local.get $temp_ga)))
    (local.set $logical_size (call $help_topic_logical_block_size))
    (local.set $loaded_block (i32.const -1))
    (local.set $first_header (i32.const 1))
    (block $done (loop $links
      (if (i32.ge_u (local.get $link_count) (global.get $HELP_MAX_TOPIC_LINKS))
        (then (br $done)))
      (local.set $block_number
        (i32.div_u (i32.sub (local.get $current) (i32.const 12)) (local.get $logical_size)))
      (local.set $relative
        (i32.rem_u (i32.sub (local.get $current) (i32.const 12)) (local.get $logical_size)))
      (if (i32.ne (local.get $block_number) (local.get $loaded_block))
        (then
          (local.set $block_bytes (call $help_topic_load_block
            (local.get $internal_record) (local.get $block_number) (local.get $temp_wa)))
          (if (i32.lt_s (local.get $block_bytes) (i32.const 0)) (then (br $done)))
          (local.set $loaded_block (local.get $block_number))))
      (if (i32.or
            (i32.gt_u (local.get $relative) (local.get $block_bytes))
            (i32.gt_u (i32.const 21) (i32.sub (local.get $block_bytes) (local.get $relative))))
        (then (br $done)))
      (local.set $link (i32.add (local.get $temp_wa) (local.get $relative)))
      (local.set $block_size (i32.load (local.get $link)))
      (local.set $data_len2 (i32.load offset=4 (local.get $link)))
      (local.set $next_link (i32.load offset=12 (local.get $link)))
      (local.set $data_len1 (i32.load offset=16 (local.get $link)))
      (local.set $record_type (i32.load8_u offset=20 (local.get $link)))
      (if (i32.or
            (i32.or (i32.lt_s (local.get $block_size) (i32.const 21))
                    (i32.lt_s (local.get $data_len1) (i32.const 21)))
            (i32.or (i32.gt_u (local.get $data_len1) (local.get $block_size))
                    (i32.gt_u (local.get $block_size) (i32.sub (local.get $block_bytes) (local.get $relative)))))
        (then (br $done)))
      (if (i32.eq (local.get $record_type) (i32.const 2))
        (then
          (if (i32.eqz (local.get $first_header))
            (then
              (local.set $ok (i32.const 1))
              (br $done)))
          (local.set $first_header (i32.const 0)))
        (else
          (if (i32.and
                (i32.ne (local.get $record_type) (i32.const 0x20))
                (i32.ne (local.get $record_type) (i32.const 0x23)))
            (then (br $done)))
          (if (i32.or
                (i32.gt_u (local.get $data_len2)
                  (i32.sub (global.get $HELP_MAX_DECOMPRESSED_TOPIC_BYTES) (local.get $total)))
                (i32.gt_u (local.get $data_len2) (i32.sub (local.get $capacity) (local.get $total))))
            (then
              (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (local.get $current))
              (br $done)))
          (local.set $source_len (i32.sub (local.get $block_size) (local.get $data_len1)))
          (local.set $source (i32.add (local.get $link) (local.get $data_len1)))
          (if (i32.le_u (local.get $data_len2) (local.get $source_len))
            (then
              (memory.copy (i32.add (local.get $out_wa) (local.get $total))
                (local.get $source) (local.get $data_len2)))
            (else
              (if (i32.eq (global.get $help_doc_phrase_mode) (i32.const 1))
                (then
                  (local.set $decoded_ok (call $help_decode_hall_topic_data
                    (local.get $source) (local.get $source_len)
                    (i32.add (local.get $out_wa) (local.get $total)) (local.get $data_len2))))
                (else
                  (if (i32.eq (global.get $help_doc_phrase_mode) (i32.const 2))
                    (then
                      (local.set $decoded_ok (call $help_decode_old_topic_data
                        (local.get $source) (local.get $source_len)
                        (i32.add (local.get $out_wa) (local.get $total)) (local.get $data_len2))))
                    (else (local.set $decoded_ok (i32.const 0))))))
              (if (i32.eqz (local.get $decoded_ok))
                (then
                  (call $help_set_error (global.get $HELP_ERROR_TOPIC_RECORD) (local.get $current))
                  (br $done)))))
          (local.set $total (i32.add (local.get $total) (local.get $data_len2)))))
      (local.set $link_count (i32.add (local.get $link_count) (i32.const 1)))
      (if (i32.or (i32.eq (local.get $next_link) (i32.const -1))
                  (i32.eqz (local.get $next_link)))
        (then
          (local.set $ok (i32.const 1))
          (br $done)))
      (local.set $current (local.get $next_link))
      (br $links)))
    (call $heap_free (local.get $temp_ga))
    (if (i32.eqz (local.get $ok)) (then (return (i32.const -1))))
    (local.get $total))

  ;; Preserve the NUL-delimited LinkData2 string boundaries as the stable
  ;; base layer for formatted-topic decoding. TEXT offsets are relative to
  ;; raw_out; the final record is END_TOPIC. Empty strings are formatting
  ;; boundaries and therefore do not fabricate empty text tokens.
  (func $help_decode_topic_strings
    (param $topic_index i32) (param $raw_out i32) (param $raw_capacity i32)
    (param $tokens_out i32) (param $token_capacity i32) (result i32)
    (local $memory_bytes i32) (local $raw_len i32) (local $i i32)
    (local $token_count i32) (local $in_string i32) (local $start i32)
    (local $token i32) (local $token_bytes i32) (local $ch i32)
    (local.set $memory_bytes (i32.shl (memory.size) (i32.const 16)))
    (if (i32.or
          (i32.gt_u (local.get $token_capacity) (global.get $HELP_MAX_TOPIC_TOKENS))
          (i32.or
            (i32.gt_u (local.get $tokens_out) (local.get $memory_bytes))
            (i32.gt_u (local.get $token_capacity)
              (i32.div_u (i32.sub (local.get $memory_bytes) (local.get $tokens_out))
                (global.get $HELP_TOPIC_TOKEN_SIZE)))))
      (then
        (call $help_set_error (global.get $HELP_ERROR_BAD_ARGUMENT) (i32.const 0))
        (return (i32.const -1))))
    (local.set $raw_len (call $help_decode_topic_raw
      (local.get $topic_index) (local.get $raw_out) (local.get $raw_capacity)))
    (if (i32.lt_s (local.get $raw_len) (i32.const 0))
      (then (return (i32.const -1))))
    (local.set $token_count (i32.const 1))
    (block $counted (loop $count
      (br_if $counted (i32.ge_u (local.get $i) (local.get $raw_len)))
      (local.set $ch (i32.load8_u (i32.add (local.get $raw_out) (local.get $i))))
      (if (i32.eqz (local.get $ch))
        (then (local.set $in_string (i32.const 0)))
        (else
          (if (i32.eqz (local.get $in_string))
            (then
              (if (i32.ge_u (local.get $token_count) (global.get $HELP_MAX_TOPIC_TOKENS))
                (then
                  (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (i32.const 0))
                  (return (i32.const -1))))
              (local.set $token_count (i32.add (local.get $token_count) (i32.const 1)))
              (local.set $in_string (i32.const 1))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $count)))
    (if (i32.gt_u (local.get $token_count) (local.get $token_capacity))
      (then
        (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (i32.const 0))
        (return (i32.const -1))))
    (local.set $token_bytes
      (i32.mul (local.get $token_count) (global.get $HELP_TOPIC_TOKEN_SIZE)))
    (if (i32.and
          (i32.lt_u (local.get $raw_out) (i32.add (local.get $tokens_out) (local.get $token_bytes)))
          (i32.lt_u (local.get $tokens_out) (i32.add (local.get $raw_out) (local.get $raw_len))))
      (then
        (call $help_set_error (global.get $HELP_ERROR_BAD_ARGUMENT) (i32.const 0))
        (return (i32.const -1))))
    (local.set $i (i32.const 0))
    (local.set $start (i32.const -1))
    (local.set $token_count (i32.const 0))
    (block $emitted (loop $emit
      (if (i32.eq (local.get $i) (local.get $raw_len))
        (then
          (if (i32.ge_s (local.get $start) (i32.const 0))
            (then
              (local.set $token (i32.add (local.get $tokens_out)
                (i32.mul (local.get $token_count) (global.get $HELP_TOPIC_TOKEN_SIZE))))
              (i32.store (local.get $token) (global.get $HELP_TOKEN_TEXT))
              (i32.store offset=4 (local.get $token) (local.get $start))
              (i32.store offset=8 (local.get $token) (i32.sub (local.get $i) (local.get $start)))
              (i32.store offset=12 (local.get $token) (i32.const 0))
              (local.set $token_count (i32.add (local.get $token_count) (i32.const 1)))))
          (br $emitted)))
      (local.set $ch (i32.load8_u (i32.add (local.get $raw_out) (local.get $i))))
      (if (i32.eqz (local.get $ch))
        (then
          (if (i32.ge_s (local.get $start) (i32.const 0))
            (then
              (local.set $token (i32.add (local.get $tokens_out)
                (i32.mul (local.get $token_count) (global.get $HELP_TOPIC_TOKEN_SIZE))))
              (i32.store (local.get $token) (global.get $HELP_TOKEN_TEXT))
              (i32.store offset=4 (local.get $token) (local.get $start))
              (i32.store offset=8 (local.get $token) (i32.sub (local.get $i) (local.get $start)))
              (i32.store offset=12 (local.get $token) (i32.const 0))
              (local.set $token_count (i32.add (local.get $token_count) (i32.const 1)))
              (local.set $start (i32.const -1)))))
        (else
          (if (i32.lt_s (local.get $start) (i32.const 0))
            (then (local.set $start (local.get $i))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $emit)))
    (local.set $token (i32.add (local.get $tokens_out)
      (i32.mul (local.get $token_count) (global.get $HELP_TOPIC_TOKEN_SIZE))))
    (i32.store (local.get $token) (global.get $HELP_TOKEN_END_TOPIC))
    (i32.store offset=4 (local.get $token) (local.get $raw_len))
    (i64.store offset=8 (local.get $token) (i64.const 0))
    (i32.add (local.get $token_count) (i32.const 1)))

  (func $help_walk_topic_format
    (param $topic_index i32) (param $raw_len i32) (param $emit i32) (result i32)
    (local $topic_record i32) (local $internal_index i32) (local $internal_record i32)
    (local $temp_ga i32) (local $temp_wa i32) (local $logical_size i32)
    (local $current i32) (local $block_number i32) (local $loaded_block i32)
    (local $block_bytes i32) (local $relative i32) (local $link i32)
    (local $block_size i32) (local $data_len1 i32) (local $data_len2 i32)
    (local $record_type i32) (local $next_link i32) (local $first_header i32)
    (local $link_count i32) (local $raw_cursor i32) (local $ok i32)
    (global.set $help_fmt_token_count (i32.const 0))
    (global.set $help_fmt_payload_used (i32.const 0))
    (global.set $help_fmt_emit (local.get $emit))
    (local.set $topic_record (i32.add (global.get $help_doc_topics_wa)
      (i32.mul (local.get $topic_index) (global.get $HELP_TOPIC_SIZE))))
    (local.set $current (i32.load offset=4 (local.get $topic_record)))
    (local.set $internal_index (call $help_find_internal_literal (i32.const 2)))
    (if (i32.lt_s (local.get $internal_index) (i32.const 0))
      (then (return (i32.const -1))))
    (local.set $internal_record (i32.add (global.get $help_doc_directory_wa)
      (i32.mul (local.get $internal_index) (global.get $HELP_INTERNAL_FILE_SIZE))))
    (local.set $temp_ga (call $heap_alloc (i32.const 16384)))
    (if (i32.eqz (local.get $temp_ga))
      (then
        (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
        (return (i32.const -1))))
    (local.set $temp_wa (call $g2w (local.get $temp_ga)))
    (local.set $logical_size (call $help_topic_logical_block_size))
    (local.set $loaded_block (i32.const -1))
    (local.set $first_header (i32.const 1))
    (block $done (loop $links
      (if (i32.ge_u (local.get $link_count) (global.get $HELP_MAX_TOPIC_LINKS))
        (then (br $done)))
      (local.set $block_number
        (i32.div_u (i32.sub (local.get $current) (i32.const 12)) (local.get $logical_size)))
      (local.set $relative
        (i32.rem_u (i32.sub (local.get $current) (i32.const 12)) (local.get $logical_size)))
      (if (i32.ne (local.get $block_number) (local.get $loaded_block))
        (then
          (local.set $block_bytes (call $help_topic_load_block
            (local.get $internal_record) (local.get $block_number) (local.get $temp_wa)))
          (if (i32.lt_s (local.get $block_bytes) (i32.const 0)) (then (br $done)))
          (local.set $loaded_block (local.get $block_number))))
      (if (i32.or
            (i32.gt_u (local.get $relative) (local.get $block_bytes))
            (i32.gt_u (i32.const 21) (i32.sub (local.get $block_bytes) (local.get $relative))))
        (then (br $done)))
      (local.set $link (i32.add (local.get $temp_wa) (local.get $relative)))
      (local.set $block_size (i32.load (local.get $link)))
      (local.set $data_len2 (i32.load offset=4 (local.get $link)))
      (local.set $next_link (i32.load offset=12 (local.get $link)))
      (local.set $data_len1 (i32.load offset=16 (local.get $link)))
      (local.set $record_type (i32.load8_u offset=20 (local.get $link)))
      (if (i32.or
            (i32.or (i32.lt_s (local.get $block_size) (i32.const 21))
                    (i32.lt_s (local.get $data_len1) (i32.const 21)))
            (i32.or (i32.gt_u (local.get $data_len1) (local.get $block_size))
                    (i32.gt_u (local.get $block_size)
                      (i32.sub (local.get $block_bytes) (local.get $relative)))))
        (then (br $done)))
      (if (i32.eq (local.get $record_type) (i32.const 2))
        (then
          (if (i32.eqz (local.get $first_header))
            (then
              (local.set $ok (i32.const 1))
              (br $done)))
          (local.set $first_header (i32.const 0)))
        (else
          (if (i32.and
                (i32.ne (local.get $record_type) (i32.const 0x20))
                (i32.ne (local.get $record_type) (i32.const 0x23)))
            (then (br $done)))
          (if (i32.gt_u (local.get $data_len2)
                (i32.sub (local.get $raw_len) (local.get $raw_cursor)))
            (then
              (call $help_set_error (global.get $HELP_ERROR_TOPIC_FORMAT) (local.get $current))
              (br $done)))
          (if (i32.eqz (call $help_tokenize_linkdata1
                (local.get $link) (local.get $record_type) (local.get $current)
                (local.get $raw_cursor) (local.get $data_len2)))
            (then (br $done)))
          (local.set $raw_cursor (i32.add (local.get $raw_cursor) (local.get $data_len2)))))
      (local.set $link_count (i32.add (local.get $link_count) (i32.const 1)))
      (if (i32.or (i32.eq (local.get $next_link) (i32.const -1))
                  (i32.eqz (local.get $next_link)))
        (then
          (local.set $ok (i32.const 1))
          (br $done)))
      (local.set $current (local.get $next_link))
      (br $links)))
    (if (i32.and (local.get $ok)
          (i32.ne (local.get $raw_cursor) (local.get $raw_len)))
      (then
        (call $help_set_error (global.get $HELP_ERROR_TOPIC_FORMAT) (local.get $current))
        (local.set $ok (i32.const 0))))
    (if (local.get $ok)
      (then
        (if (i32.eqz (call $help_fmt_add_token
              (global.get $HELP_TOKEN_END_TOPIC) (local.get $raw_len)
              (i32.const 0) (i32.const 0)))
          (then
            (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (local.get $current))
            (local.set $ok (i32.const 0))))))
    (call $heap_free (local.get $temp_ga))
    (if (i32.eqz (local.get $ok)) (then (return (i32.const -1))))
    (global.get $help_fmt_token_count))

  ;; Build the complete formatted topic IR transactionally. raw_out receives
  ;; exact decoded LinkData2 bytes, tokens_out receives 16-byte typed tokens,
  ;; and payload_out receives stable copies of each referenced LinkData1.
  (func $help_decode_topic_formatted
    (param $topic_index i32) (param $raw_out i32) (param $raw_capacity i32)
    (param $tokens_out i32) (param $token_capacity i32)
    (param $payload_out i32) (param $payload_capacity i32) (result i32)
    (local $memory_bytes i32) (local $raw_len i32) (local $required_tokens i32)
    (local $required_payload i32) (local $token_bytes i32) (local $result i32)
    (local.set $memory_bytes (i32.shl (memory.size) (i32.const 16)))
    (if (i32.or
          (i32.gt_u (local.get $token_capacity) (global.get $HELP_MAX_TOPIC_TOKENS))
          (i32.gt_u (local.get $payload_capacity)
            (global.get $HELP_MAX_DECOMPRESSED_TOPIC_BYTES)))
      (then
        (call $help_set_error (global.get $HELP_ERROR_BAD_ARGUMENT) (i32.const 0))
        (return (i32.const -1))))
    (if (i32.or
          (i32.or
            (i32.gt_u (local.get $tokens_out) (local.get $memory_bytes))
            (i32.gt_u (local.get $token_capacity)
              (i32.div_u (i32.sub (local.get $memory_bytes) (local.get $tokens_out))
                (global.get $HELP_TOPIC_TOKEN_SIZE))))
          (i32.or
            (i32.gt_u (local.get $payload_out) (local.get $memory_bytes))
            (i32.gt_u (local.get $payload_capacity)
              (i32.sub (local.get $memory_bytes) (local.get $payload_out)))))
      (then
        (call $help_set_error (global.get $HELP_ERROR_BAD_ARGUMENT) (i32.const 0))
        (return (i32.const -1))))
    (local.set $raw_len (call $help_decode_topic_raw
      (local.get $topic_index) (local.get $raw_out) (local.get $raw_capacity)))
    (if (i32.lt_s (local.get $raw_len) (i32.const 0))
      (then (return (i32.const -1))))
    (global.set $help_fmt_raw_out (local.get $raw_out))
    (global.set $help_fmt_tokens_out (local.get $tokens_out))
    (global.set $help_fmt_payload_out (local.get $payload_out))
    (local.set $result (call $help_walk_topic_format
      (local.get $topic_index) (local.get $raw_len) (i32.const 0)))
    (if (i32.lt_s (local.get $result) (i32.const 0))
      (then (return (i32.const -1))))
    (local.set $required_tokens (global.get $help_fmt_token_count))
    (local.set $required_payload (global.get $help_fmt_payload_used))
    (if (i32.or
          (i32.gt_u (local.get $required_tokens) (local.get $token_capacity))
          (i32.gt_u (local.get $required_payload) (local.get $payload_capacity)))
      (then
        (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (i32.const 0))
        (return (i32.const -1))))
    (local.set $token_bytes
      (i32.mul (local.get $required_tokens) (global.get $HELP_TOPIC_TOKEN_SIZE)))
    (if (i32.or
          (i32.or
            (i32.and
              (i32.and
                (i32.ne (local.get $raw_len) (i32.const 0))
                (i32.ne (local.get $token_bytes) (i32.const 0)))
              (i32.and
                (i32.lt_u (local.get $raw_out) (i32.add (local.get $tokens_out) (local.get $token_bytes)))
                (i32.lt_u (local.get $tokens_out) (i32.add (local.get $raw_out) (local.get $raw_len)))))
            (i32.and
              (i32.and
                (i32.ne (local.get $raw_len) (i32.const 0))
                (i32.ne (local.get $required_payload) (i32.const 0)))
              (i32.and
                (i32.lt_u (local.get $raw_out) (i32.add (local.get $payload_out) (local.get $required_payload)))
                (i32.lt_u (local.get $payload_out) (i32.add (local.get $raw_out) (local.get $raw_len))))))
          (i32.and
            (i32.and
              (i32.ne (local.get $token_bytes) (i32.const 0))
              (i32.ne (local.get $required_payload) (i32.const 0)))
            (i32.and
              (i32.lt_u (local.get $tokens_out) (i32.add (local.get $payload_out) (local.get $required_payload)))
              (i32.lt_u (local.get $payload_out) (i32.add (local.get $tokens_out) (local.get $token_bytes))))))
      (then
        (call $help_set_error (global.get $HELP_ERROR_BAD_ARGUMENT) (i32.const 0))
        (return (i32.const -1))))
    (local.set $result (call $help_walk_topic_format
      (local.get $topic_index) (local.get $raw_len) (i32.const 1)))
    (if (i32.or
          (i32.ne (local.get $result) (local.get $required_tokens))
          (i32.ne (global.get $help_fmt_payload_used) (local.get $required_payload)))
      (then
        (call $help_set_error (global.get $HELP_ERROR_TOPIC_FORMAT) (i32.const 0))
        (return (i32.const -1))))
    (local.get $result))

  (func $help_parse_hall_phrases
    (param $index_internal i32) (param $image_internal i32) (result i32)
    (local $index_record i32) (local $image_record i32)
    (local $index_off i32) (local $index_len i32) (local $index_data i32)
    (local $image_off i32) (local $image_len i32) (local $image_data i32)
    (local $count i32) (local $index_size i32) (local $decoded_size i32)
    (local $compressed_size i32) (local $bit_count i32)
    (local $bit_stream i32) (local $bit_stream_len i32)
    (local $offsets_ga i32) (local $offsets_wa i32)
    (local $decoded_ga i32) (local $decoded_wa i32)
    (local $i i32) (local $b i32) (local $bit i32)
    (local $length i32) (local $increment i32) (local $offset i32)
    (local $ok i32)
    (global.set $help_phrase_result_offsets_ga (i32.const 0))
    (global.set $help_phrase_result_offsets_wa (i32.const 0))
    (global.set $help_phrase_result_image_ga (i32.const 0))
    (global.set $help_phrase_result_image_wa (i32.const 0))
    (global.set $help_phrase_result_count (i32.const 0))
    (global.set $help_phrase_result_image_size (i32.const 0))
    (local.set $index_record (i32.add (global.get $help_doc_directory_wa)
      (i32.mul (local.get $index_internal) (global.get $HELP_INTERNAL_FILE_SIZE))))
    (local.set $image_record (i32.add (global.get $help_doc_directory_wa)
      (i32.mul (local.get $image_internal) (global.get $HELP_INTERNAL_FILE_SIZE))))
    (local.set $index_off (i32.load offset=12 (local.get $index_record)))
    (local.set $index_len (i32.load offset=16 (local.get $index_record)))
    (local.set $image_off (i32.load offset=12 (local.get $image_record)))
    (local.set $image_len (i32.load offset=16 (local.get $image_record)))
    (block $done
      (if (i32.lt_u (local.get $index_len) (i32.const 28))
        (then
          (call $help_set_error (global.get $HELP_ERROR_PHRASE_TABLE) (local.get $index_off))
          (br $done)))
      (local.set $index_data (i32.add (global.get $help_doc_file_wa) (local.get $index_off)))
      (local.set $image_data (i32.add (global.get $help_doc_file_wa) (local.get $image_off)))
      (if (i32.ne (i32.load (local.get $index_data)) (i32.const 1))
        (then
          (call $help_set_error (global.get $HELP_ERROR_PHRASE_TABLE) (local.get $index_off))
          (br $done)))
      (local.set $count (i32.load offset=4 (local.get $index_data)))
      (local.set $index_size (i32.load offset=8 (local.get $index_data)))
      (local.set $decoded_size (i32.load offset=12 (local.get $index_data)))
      (local.set $compressed_size (i32.load offset=16 (local.get $index_data)))
      (local.set $bit_count (i32.and (i32.load16_u offset=24 (local.get $index_data)) (i32.const 15)))
      (if (i32.or
            (i32.gt_u (local.get $count) (global.get $HELP_MAX_PHRASES))
            (i32.gt_u (local.get $decoded_size) (global.get $HELP_MAX_FILE_BYTES)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (i32.add (local.get $index_off) (i32.const 4)))
          (br $done)))
      (if (i32.or
            (i32.or (i32.lt_u (local.get $index_size) (i32.const 4))
                    (i32.ne (local.get $index_len) (i32.add (local.get $index_size) (i32.const 24))))
            (i32.or (i32.ne (i32.load offset=20 (local.get $index_data)) (i32.const 0))
                    (i32.or (i32.eqz (local.get $bit_count))
                            (i32.gt_u (local.get $bit_count) (i32.const 15)))))
        (then
          (call $help_set_error (global.get $HELP_ERROR_PHRASE_TABLE) (i32.add (local.get $index_off) (i32.const 8)))
          (br $done)))
      (if (i32.ne (local.get $compressed_size) (local.get $image_len))
        (then
          (call $help_set_error (global.get $HELP_ERROR_PHRASE_TABLE) (local.get $image_off))
          (br $done)))
      (local.set $offsets_ga (call $heap_alloc
        (i32.mul (i32.add (local.get $count) (i32.const 1)) (i32.const 4))))
      (if (i32.eqz (local.get $offsets_ga))
        (then
          (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
          (br $done)))
      (local.set $offsets_wa (call $g2w (local.get $offsets_ga)))
      (i32.store (local.get $offsets_wa) (i32.const 0))
      (if (local.get $decoded_size)
        (then
          (local.set $decoded_ga (call $heap_alloc (local.get $decoded_size)))
          (if (i32.eqz (local.get $decoded_ga))
            (then
              (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
              (br $done)))
          (local.set $decoded_wa (call $g2w (local.get $decoded_ga)))))
      (local.set $bit_stream (i32.add (local.get $index_data) (i32.const 28)))
      (local.set $bit_stream_len (i32.sub (local.get $index_size) (i32.const 4)))
      (global.set $help_phrase_bit_position (i32.const 0))
      (local.set $i (i32.const 0))
      (block $offsets_done (loop $offsets
        (br_if $offsets_done (i32.ge_u (local.get $i) (local.get $count)))
        (local.set $length (i32.const 1))
        (local.set $increment (i32.shl (i32.const 1) (local.get $bit_count)))
        (block $unary_done (loop $unary
          (local.set $bit (call $help_phrase_get_bit
            (local.get $bit_stream) (local.get $bit_stream_len)))
          (if (i32.lt_s (local.get $bit) (i32.const 0))
            (then
              (call $help_set_error (global.get $HELP_ERROR_PHRASE_TABLE) (local.get $index_off))
              (br $done)))
          (br_if $unary_done (i32.eqz (local.get $bit)))
          (if (i32.gt_u (local.get $length)
                (i32.sub (global.get $HELP_MAX_PHRASE_BYTES) (local.get $increment)))
            (then
              (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (local.get $index_off))
              (br $done)))
          (local.set $length (i32.add (local.get $length) (local.get $increment)))
          (br $unary)))
        (local.set $b (i32.const 0))
        (block $bits_done (loop $bits
          (br_if $bits_done (i32.ge_u (local.get $b) (local.get $bit_count)))
          (local.set $bit (call $help_phrase_get_bit
            (local.get $bit_stream) (local.get $bit_stream_len)))
          (if (i32.lt_s (local.get $bit) (i32.const 0))
            (then
              (call $help_set_error (global.get $HELP_ERROR_PHRASE_TABLE) (local.get $index_off))
              (br $done)))
          (if (local.get $bit)
            (then (local.set $length
              (i32.add (local.get $length) (i32.shl (i32.const 1) (local.get $b))))))
          (local.set $b (i32.add (local.get $b) (i32.const 1)))
          (br $bits)))
        (if (i32.or
              (i32.gt_u (local.get $length) (global.get $HELP_MAX_PHRASE_BYTES))
              (i32.gt_u (local.get $length) (i32.sub (local.get $decoded_size) (local.get $offset))))
          (then
            (call $help_set_error (global.get $HELP_ERROR_PHRASE_TABLE) (local.get $index_off))
            (br $done)))
        (local.set $offset (i32.add (local.get $offset) (local.get $length)))
        (i32.store (i32.add (local.get $offsets_wa)
          (i32.mul (i32.add (local.get $i) (i32.const 1)) (i32.const 4))) (local.get $offset))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $offsets)))
      (if (i32.ne (local.get $offset) (local.get $decoded_size))
        (then
          (call $help_set_error (global.get $HELP_ERROR_PHRASE_TABLE) (local.get $index_off))
          (br $done)))
      (if (i32.eq (local.get $compressed_size) (local.get $decoded_size))
        (then
          (if (local.get $decoded_size)
            (then (memory.copy (local.get $decoded_wa) (local.get $image_data) (local.get $decoded_size)))))
        (else
          (if (i32.eqz (call $help_lz77_expand
                (local.get $image_data) (local.get $compressed_size)
                (local.get $decoded_wa) (local.get $decoded_size)))
            (then
              (call $help_set_error (global.get $HELP_ERROR_PHRASE_TABLE) (local.get $image_off))
              (br $done)))))
      (global.set $help_phrase_result_offsets_ga (local.get $offsets_ga))
      (global.set $help_phrase_result_offsets_wa (local.get $offsets_wa))
      (global.set $help_phrase_result_image_ga (local.get $decoded_ga))
      (global.set $help_phrase_result_image_wa (local.get $decoded_wa))
      (global.set $help_phrase_result_count (local.get $count))
      (global.set $help_phrase_result_image_size (local.get $decoded_size))
      (local.set $ok (i32.const 1)))
    (if (i32.eqz (local.get $ok))
      (then
        (if (local.get $decoded_ga) (then (call $heap_free (local.get $decoded_ga))))
        (if (local.get $offsets_ga) (then (call $heap_free (local.get $offsets_ga))))))
    (local.get $ok))

  (func $help_parse_old_phrases (param $internal_index i32) (result i32)
    (local $record i32) (local $data_off i32) (local $data_len i32) (local $data i32)
    (local $first i32) (local $count i32) (local $header_size i32)
    (local $table_size i32) (local $decoded_size i32) (local $source_len i32)
    (local $offsets_source i32) (local $image_source i32) (local $before31 i32)
    (local $offsets_ga i32) (local $offsets_wa i32)
    (local $image_ga i32) (local $image_wa i32)
    (local $i i32) (local $stored i32) (local $offset i32) (local $previous i32)
    (local $ok i32)
    (global.set $help_phrase_result_offsets_ga (i32.const 0))
    (global.set $help_phrase_result_offsets_wa (i32.const 0))
    (global.set $help_phrase_result_image_ga (i32.const 0))
    (global.set $help_phrase_result_image_wa (i32.const 0))
    (global.set $help_phrase_result_count (i32.const 0))
    (global.set $help_phrase_result_image_size (i32.const 0))
    (local.set $record (i32.add (global.get $help_doc_directory_wa)
      (i32.mul (local.get $internal_index) (global.get $HELP_INTERNAL_FILE_SIZE))))
    (local.set $data_off (i32.load offset=12 (local.get $record)))
    (local.set $data_len (i32.load offset=16 (local.get $record)))
    (block $done
      (if (i32.lt_u (local.get $data_len) (i32.const 4))
        (then
          (call $help_set_error (global.get $HELP_ERROR_PHRASE_TABLE) (local.get $data_off))
          (br $done)))
      (local.set $data (i32.add (global.get $help_doc_file_wa) (local.get $data_off)))
      (local.set $first (i32.load16_u (local.get $data)))
      (if (i32.eq (local.get $first) (i32.const 0x0800))
        (then
          (if (i32.lt_u (local.get $data_len) (i32.const 40))
            (then
              (call $help_set_error (global.get $HELP_ERROR_PHRASE_TABLE) (local.get $data_off))
              (br $done)))
          (local.set $count (i32.load16_u offset=2 (local.get $data)))
          (if (i32.ne (i32.load16_u offset=4 (local.get $data)) (i32.const 0x0100))
            (then
              (call $help_set_error (global.get $HELP_ERROR_PHRASE_TABLE)
                (i32.add (local.get $data_off) (i32.const 4)))
              (br $done)))
          (local.set $decoded_size (i32.load offset=6 (local.get $data)))
          (local.set $header_size (i32.const 40)))
        (else
          (local.set $count (local.get $first))
          (if (i32.ne (i32.load16_u offset=2 (local.get $data)) (i32.const 0x0100))
            (then
              (call $help_set_error (global.get $HELP_ERROR_PHRASE_TABLE)
                (i32.add (local.get $data_off) (i32.const 2)))
              (br $done)))
          (local.set $before31
            (i32.lt_u (global.get $help_doc_system_minor) (i32.const 16)))
          (if (local.get $before31)
            (then (local.set $header_size (i32.const 4)))
            (else
              (if (i32.lt_u (local.get $data_len) (i32.const 8))
                (then
                  (call $help_set_error (global.get $HELP_ERROR_PHRASE_TABLE) (local.get $data_off))
                  (br $done)))
              (local.set $decoded_size (i32.load offset=4 (local.get $data)))
              (local.set $header_size (i32.const 8))))))
      ;; Legacy offsets are 16-bit and begin with the byte size of their own
      ;; table, so larger counts cannot be represented even though Hall can.
      (if (i32.gt_u (local.get $count) (i32.const 32766))
        (then
          (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (local.get $data_off))
          (br $done)))
      (local.set $table_size
        (i32.mul (i32.add (local.get $count) (i32.const 1)) (i32.const 2)))
      (if (i32.or
            (i32.gt_u (local.get $header_size) (local.get $data_len))
            (i32.gt_u (local.get $table_size)
              (i32.sub (local.get $data_len) (local.get $header_size))))
        (then
          (call $help_set_error (global.get $HELP_ERROR_PHRASE_TABLE) (local.get $data_off))
          (br $done)))
      (local.set $source_len
        (i32.sub (i32.sub (local.get $data_len) (local.get $header_size)) (local.get $table_size)))
      (if (local.get $before31)
        (then (local.set $decoded_size (local.get $source_len))))
      (if (i32.gt_u (local.get $decoded_size) (global.get $HELP_MAX_FILE_BYTES))
        (then
          (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (local.get $data_off))
          (br $done)))
      (local.set $offsets_source (i32.add (local.get $data) (local.get $header_size)))
      (local.set $image_source (i32.add (local.get $offsets_source) (local.get $table_size)))
      (local.set $offsets_ga (call $heap_alloc
        (i32.mul (i32.add (local.get $count) (i32.const 1)) (i32.const 4))))
      (if (i32.eqz (local.get $offsets_ga))
        (then
          (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
          (br $done)))
      (local.set $offsets_wa (call $g2w (local.get $offsets_ga)))
      (if (local.get $decoded_size)
        (then
          (local.set $image_ga (call $heap_alloc (local.get $decoded_size)))
          (if (i32.eqz (local.get $image_ga))
            (then
              (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
              (br $done)))
          (local.set $image_wa (call $g2w (local.get $image_ga)))))
      (block $offsets_done (loop $offsets
        (br_if $offsets_done (i32.gt_u (local.get $i) (local.get $count)))
        (local.set $stored (i32.load16_u (i32.add (local.get $offsets_source)
          (i32.mul (local.get $i) (i32.const 2)))))
        (if (i32.lt_u (local.get $stored) (local.get $table_size))
          (then
            (call $help_set_error (global.get $HELP_ERROR_PHRASE_TABLE) (local.get $data_off))
            (br $done)))
        (local.set $offset (i32.sub (local.get $stored) (local.get $table_size)))
        (if (i32.or
              (i32.lt_u (local.get $offset) (local.get $previous))
              (i32.gt_u (local.get $offset) (local.get $decoded_size)))
          (then
            (call $help_set_error (global.get $HELP_ERROR_PHRASE_TABLE) (local.get $data_off))
            (br $done)))
        (if (i32.and (i32.gt_u (local.get $i) (i32.const 0))
              (i32.gt_u (i32.sub (local.get $offset) (local.get $previous))
                (global.get $HELP_MAX_PHRASE_BYTES)))
          (then
            (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (local.get $data_off))
            (br $done)))
        (i32.store (i32.add (local.get $offsets_wa)
          (i32.mul (local.get $i) (i32.const 4))) (local.get $offset))
        (local.set $previous (local.get $offset))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $offsets)))
      (if (i32.or
            (i32.ne (i32.load (local.get $offsets_wa)) (i32.const 0))
            (i32.ne (local.get $previous) (local.get $decoded_size)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_PHRASE_TABLE) (local.get $data_off))
          (br $done)))
      (if (local.get $before31)
        (then
          (if (local.get $decoded_size)
            (then (memory.copy (local.get $image_wa) (local.get $image_source)
              (local.get $decoded_size)))))
        (else
          (if (local.get $decoded_size)
            (then
              (if (i32.eqz (call $help_lz77_expand
                    (local.get $image_source) (local.get $source_len)
                    (local.get $image_wa) (local.get $decoded_size)))
                (then
                  (call $help_set_error (global.get $HELP_ERROR_PHRASE_TABLE) (local.get $data_off))
                  (br $done)))))
          (if (i32.and (i32.eqz (local.get $decoded_size)) (local.get $source_len))
            (then
              (call $help_set_error (global.get $HELP_ERROR_PHRASE_TABLE) (local.get $data_off))
              (br $done)))))
      (global.set $help_phrase_result_offsets_ga (local.get $offsets_ga))
      (global.set $help_phrase_result_offsets_wa (local.get $offsets_wa))
      (global.set $help_phrase_result_image_ga (local.get $image_ga))
      (global.set $help_phrase_result_image_wa (local.get $image_wa))
      (global.set $help_phrase_result_count (local.get $count))
      (global.set $help_phrase_result_image_size (local.get $decoded_size))
      (local.set $ok (i32.const 1)))
    (if (i32.eqz (local.get $ok))
      (then
        (if (local.get $image_ga) (then (call $heap_free (local.get $image_ga))))
        (if (local.get $offsets_ga) (then (call $heap_free (local.get $offsets_ga))))))
    (local.get $ok))

  (func $help_font_pack_attributes
    (param $source i32) (param $italic_offset i32) (param $weight i32) (result i32)
    (local $attributes i32) (local $i i32)
    (if (i32.ge_u (local.get $weight) (i32.const 700))
      (then (local.set $attributes (i32.const 1))))
    (local.set $i (i32.const 0))
    (block $done (loop $flags
      (br_if $done (i32.ge_u (local.get $i) (i32.const 5)))
      (if (i32.load8_u (i32.add (local.get $source)
            (i32.add (local.get $italic_offset) (local.get $i))))
        (then
          (local.set $attributes (i32.or (local.get $attributes)
            (i32.shl (i32.const 1) (i32.add (local.get $i) (i32.const 1)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $flags)))
    (local.get $attributes))

  ;; Parse |FONT into normalized, WAT-owned face and descriptor records. Face
  ;; strings remain immutable offsets into the canonical HLP buffer. Old HCW
  ;; descriptors use half-points; new/MVB descriptors retain signed twips.
  (func $help_parse_font_table (param $internal_index i32) (result i32)
    (local $record i32) (local $data_off i32) (local $data_len i32) (local $data i32)
    (local $face_count i32) (local $font_count i32) (local $faces_off i32)
    (local $fonts_off i32) (local $face_bytes i32) (local $face_slot i32)
    (local $descriptor_size i32) (local $metric_mode i32)
    (local $faces_ga i32) (local $faces_wa i32) (local $fonts_ga i32) (local $fonts_wa i32)
    (local $i i32) (local $source i32) (local $dest i32) (local $name_len i32)
    (local $face_index i32) (local $height i32) (local $family i32)
    (local $attributes i32) (local $weight i32) (local $foreground i32) (local $background i32)
    (local $ok i32)
    (global.set $help_font_result_faces_ga (i32.const 0))
    (global.set $help_font_result_faces_wa (i32.const 0))
    (global.set $help_font_result_fonts_ga (i32.const 0))
    (global.set $help_font_result_fonts_wa (i32.const 0))
    (global.set $help_font_result_face_count (i32.const 0))
    (global.set $help_font_result_font_count (i32.const 0))
    (global.set $help_font_result_metric_mode (i32.const 0))
    (local.set $record (i32.add (global.get $help_doc_directory_wa)
      (i32.mul (local.get $internal_index) (global.get $HELP_INTERNAL_FILE_SIZE))))
    (local.set $data_off (i32.load offset=12 (local.get $record)))
    (local.set $data_len (i32.load offset=16 (local.get $record)))
    (block $done
      (if (i32.lt_u (local.get $data_len) (i32.const 8))
        (then
          (call $help_set_error (global.get $HELP_ERROR_FONT_TABLE) (local.get $data_off))
          (br $done)))
      (local.set $data (i32.add (global.get $help_doc_file_wa) (local.get $data_off)))
      (local.set $face_count (i32.load16_u (local.get $data)))
      (local.set $font_count (i32.load16_u offset=2 (local.get $data)))
      (local.set $faces_off (i32.load16_u offset=4 (local.get $data)))
      (local.set $fonts_off (i32.load16_u offset=6 (local.get $data)))
      (if (i32.or
            (i32.gt_u (local.get $face_count) (global.get $HELP_MAX_FONT_FACES))
            (i32.gt_u (local.get $font_count) (global.get $HELP_MAX_FONT_DESCRIPTORS)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (local.get $data_off))
          (br $done)))
      (if (i32.or
            (i32.or (i32.lt_u (local.get $faces_off) (i32.const 8))
                    (i32.gt_u (local.get $faces_off) (local.get $fonts_off)))
            (i32.gt_u (local.get $fonts_off) (local.get $data_len)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_FONT_TABLE) (local.get $data_off))
          (br $done)))
      (if (i32.eqz (local.get $face_count))
        (then
          (if (i32.or (local.get $font_count)
                      (i32.ne (local.get $faces_off) (local.get $fonts_off)))
            (then
              (call $help_set_error (global.get $HELP_ERROR_FONT_TABLE) (local.get $data_off))
              (br $done))))
        (else
          (local.set $face_bytes (i32.sub (local.get $fonts_off) (local.get $faces_off)))
          (if (i32.or
                (i32.eqz (local.get $face_bytes))
                (i32.rem_u (local.get $face_bytes) (local.get $face_count)))
            (then
              (call $help_set_error (global.get $HELP_ERROR_FONT_TABLE) (local.get $data_off))
              (br $done)))
          (local.set $face_slot (i32.div_u (local.get $face_bytes) (local.get $face_count)))))
      (if (i32.ge_u (local.get $faces_off) (i32.const 12))
        (then
          (local.set $descriptor_size (i32.const 42))
          (local.set $metric_mode (i32.const 1))
          (if (i32.lt_u (local.get $data_len) (i32.const 12))
            (then
              (call $help_set_error (global.get $HELP_ERROR_FONT_TABLE) (local.get $data_off))
              (br $done)))
          (if (i32.and
                (i32.ne (i32.load16_u offset=8 (local.get $data)) (i32.const 0))
                (i32.gt_u (i32.load16_u offset=10 (local.get $data)) (local.get $data_len)))
            (then
              (call $help_set_error (global.get $HELP_ERROR_FONT_TABLE) (local.get $data_off))
              (br $done)))
          (if (i32.and (i32.ge_u (local.get $faces_off) (i32.const 16))
                (i32.gt_u (i32.load16_u offset=14 (local.get $data)) (local.get $data_len)))
            (then
              (call $help_set_error (global.get $HELP_ERROR_FONT_TABLE) (local.get $data_off))
              (br $done))))
        (else (local.set $descriptor_size (i32.const 11))))
      (if (i32.gt_u (local.get $font_count)
            (i32.div_u (i32.sub (local.get $data_len) (local.get $fonts_off))
              (local.get $descriptor_size)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_FONT_TABLE) (local.get $data_off))
          (br $done)))
      (if (local.get $face_count)
        (then
          (local.set $faces_ga (call $heap_alloc
            (i32.mul (local.get $face_count) (global.get $HELP_FONT_FACE_SIZE))))
          (if (i32.eqz (local.get $faces_ga))
            (then
              (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (local.get $data_off))
              (br $done)))
          (local.set $faces_wa (call $g2w (local.get $faces_ga)))
          (memory.fill (local.get $faces_wa) (i32.const 0)
            (i32.mul (local.get $face_count) (global.get $HELP_FONT_FACE_SIZE)))))
      (if (local.get $font_count)
        (then
          (local.set $fonts_ga (call $heap_alloc
            (i32.mul (local.get $font_count) (global.get $HELP_FONT_SIZE))))
          (if (i32.eqz (local.get $fonts_ga))
            (then
              (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (local.get $data_off))
              (br $done)))
          (local.set $fonts_wa (call $g2w (local.get $fonts_ga)))
          (memory.fill (local.get $fonts_wa) (i32.const 0)
            (i32.mul (local.get $font_count) (global.get $HELP_FONT_SIZE)))))
      (local.set $i (i32.const 0))
      (block $faces_done (loop $faces
        (br_if $faces_done (i32.ge_u (local.get $i) (local.get $face_count)))
        (local.set $source (i32.add (local.get $data)
          (i32.add (local.get $faces_off) (i32.mul (local.get $i) (local.get $face_slot)))))
        (local.set $name_len (i32.const 0))
        (block $name_done (loop $name
          (br_if $name_done (i32.ge_u (local.get $name_len) (local.get $face_slot)))
          (br_if $name_done (i32.eqz (i32.load8_u
            (i32.add (local.get $source) (local.get $name_len)))))
          (local.set $name_len (i32.add (local.get $name_len) (i32.const 1)))
          (br $name)))
        (if (i32.eqz (local.get $name_len))
          (then
            (call $help_set_error (global.get $HELP_ERROR_FONT_TABLE)
              (i32.add (local.get $data_off) (local.get $faces_off)))
            (br $done)))
        (local.set $dest (i32.add (local.get $faces_wa)
          (i32.mul (local.get $i) (global.get $HELP_FONT_FACE_SIZE))))
        (i32.store (local.get $dest)
          (i32.add (local.get $data_off)
            (i32.add (local.get $faces_off) (i32.mul (local.get $i) (local.get $face_slot)))))
        (i32.store offset=4 (local.get $dest) (local.get $name_len))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $faces)))
      (local.set $i (i32.const 0))
      (block $fonts_done (loop $fonts
        (br_if $fonts_done (i32.ge_u (local.get $i) (local.get $font_count)))
        (local.set $source (i32.add (local.get $data)
          (i32.add (local.get $fonts_off) (i32.mul (local.get $i) (local.get $descriptor_size)))))
        (if (i32.eqz (local.get $metric_mode))
          (then
            (local.set $attributes (i32.load8_u (local.get $source)))
            (local.set $height (i32.load8_u offset=1 (local.get $source)))
            (local.set $family (i32.load8_u offset=2 (local.get $source)))
            (local.set $face_index (i32.load16_u offset=3 (local.get $source)))
            (if (i32.and (local.get $attributes) (i32.const 1))
              (then (local.set $weight (i32.const 700)))
              (else (local.set $weight (i32.const 400))))
            (local.set $foreground (i32.or
              (i32.load8_u offset=5 (local.get $source))
              (i32.or (i32.shl (i32.load8_u offset=6 (local.get $source)) (i32.const 8))
                      (i32.shl (i32.load8_u offset=7 (local.get $source)) (i32.const 16)))))
            (local.set $background (i32.or
              (i32.load8_u offset=8 (local.get $source))
              (i32.or (i32.shl (i32.load8_u offset=9 (local.get $source)) (i32.const 8))
                      (i32.shl (i32.load8_u offset=10 (local.get $source)) (i32.const 16))))))
          (else
            (if (i32.ge_u (local.get $faces_off) (i32.const 16))
              (then
                (local.set $face_index (i32.load16_s (local.get $source)))
                (local.set $height (i32.load offset=12 (local.get $source)))
                (local.set $weight (i32.load16_u offset=28 (local.get $source)))
                (local.set $foreground (i32.or
                  (i32.load8_u offset=6 (local.get $source))
                  (i32.or (i32.shl (i32.load8_u offset=7 (local.get $source)) (i32.const 8))
                          (i32.shl (i32.load8_u offset=8 (local.get $source)) (i32.const 16)))))
                (local.set $background (i32.or
                  (i32.load8_u offset=9 (local.get $source))
                  (i32.or (i32.shl (i32.load8_u offset=10 (local.get $source)) (i32.const 8))
                          (i32.shl (i32.load8_u offset=11 (local.get $source)) (i32.const 16)))))
                (local.set $attributes (call $help_font_pack_attributes
                  (local.get $source) (i32.const 32) (local.get $weight)))
                (local.set $family (i32.load8_u offset=39 (local.get $source))))
              (else
                (local.set $face_index (i32.load16_s offset=1 (local.get $source)))
                (local.set $height (i32.load offset=14 (local.get $source)))
                (local.set $weight (i32.load16_u offset=30 (local.get $source)))
                (local.set $foreground (i32.or
                  (i32.load8_u offset=3 (local.get $source))
                  (i32.or (i32.shl (i32.load8_u offset=4 (local.get $source)) (i32.const 8))
                          (i32.shl (i32.load8_u offset=5 (local.get $source)) (i32.const 16)))))
                (local.set $background (i32.or
                  (i32.load8_u offset=6 (local.get $source))
                  (i32.or (i32.shl (i32.load8_u offset=7 (local.get $source)) (i32.const 8))
                          (i32.shl (i32.load8_u offset=8 (local.get $source)) (i32.const 16)))))
                (local.set $attributes (call $help_font_pack_attributes
                  (local.get $source) (i32.const 34) (local.get $weight)))
                (local.set $family (i32.load8_u offset=41 (local.get $source)))))))
        (if (i32.or (i32.lt_s (local.get $face_index) (i32.const 0))
                    (i32.ge_u (local.get $face_index) (local.get $face_count)))
          (then
            (call $help_set_error (global.get $HELP_ERROR_FONT_TABLE)
              (i32.add (local.get $data_off) (local.get $fonts_off)))
            (br $done)))
        (local.set $dest (i32.add (local.get $fonts_wa)
          (i32.mul (local.get $i) (global.get $HELP_FONT_SIZE))))
        (i32.store (local.get $dest) (local.get $face_index))
        (i32.store offset=4 (local.get $dest) (local.get $height))
        (i32.store offset=8 (local.get $dest) (local.get $family))
        (i32.store offset=12 (local.get $dest) (local.get $attributes))
        (i32.store offset=16 (local.get $dest) (local.get $weight))
        (i32.store offset=20 (local.get $dest) (local.get $foreground))
        (i32.store offset=24 (local.get $dest) (local.get $background))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $fonts)))
      (global.set $help_font_result_faces_ga (local.get $faces_ga))
      (global.set $help_font_result_faces_wa (local.get $faces_wa))
      (global.set $help_font_result_fonts_ga (local.get $fonts_ga))
      (global.set $help_font_result_fonts_wa (local.get $fonts_wa))
      (global.set $help_font_result_face_count (local.get $face_count))
      (global.set $help_font_result_font_count (local.get $font_count))
      (global.set $help_font_result_metric_mode (local.get $metric_mode))
      (local.set $ok (i32.const 1)))
    (if (i32.eqz (local.get $ok))
      (then
        (if (local.get $fonts_ga) (then (call $heap_free (local.get $fonts_ga))))
        (if (local.get $faces_ga) (then (call $heap_free (local.get $faces_ga))))))
    (local.get $ok))

  (func $help_bitmap_resource_number (param $record i32) (result i32)
    (local $name i32) (local $length i32) (local $i i32) (local $ch i32)
    (local $number i32)
    (local.set $length (i32.load16_u offset=8 (local.get $record)))
    (local.set $name (i32.add (global.get $help_doc_file_wa)
      (i32.load offset=4 (local.get $record))))
    (if (i32.and
          (i32.ge_u (local.get $length) (i32.const 4))
          (i32.and
            (i32.eq (i32.load8_u (local.get $name)) (i32.const 0x7C))
            (i32.and
              (i32.eq (i32.load8_u offset=1 (local.get $name)) (i32.const 0x62))
              (i32.eq (i32.load8_u offset=2 (local.get $name)) (i32.const 0x6D)))))
      (then (local.set $i (i32.const 3)))
      (else
        (if (i32.and
              (i32.ge_u (local.get $length) (i32.const 3))
              (i32.and
                (i32.eq (i32.load8_u (local.get $name)) (i32.const 0x62))
                (i32.eq (i32.load8_u offset=1 (local.get $name)) (i32.const 0x6D))))
          (then (local.set $i (i32.const 2)))
          (else (return (i32.const -1))))))
    (block $done (loop $digits
      (br_if $done (i32.ge_u (local.get $i) (local.get $length)))
      (local.set $ch (i32.load8_u (i32.add (local.get $name) (local.get $i))))
      (if (i32.or (i32.lt_u (local.get $ch) (i32.const 0x30))
                  (i32.gt_u (local.get $ch) (i32.const 0x39)))
        (then (return (i32.const -1))))
      (if (i32.gt_u (local.get $number) (i32.const 6553))
        (then (return (i32.const -1))))
      (local.set $number (i32.add (i32.mul (local.get $number) (i32.const 10))
        (i32.sub (local.get $ch) (i32.const 0x30))))
      (if (i32.gt_u (local.get $number) (i32.const 65535))
        (then (return (i32.const -1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $digits)))
    (local.get $number))

  ;; Parse the default K-footnote index. |KWBTREE supplies sorted keyword
  ;; strings and bounded slices into |KWDATA; the latter supplies TOPICOFFSET
  ;; postings. A -1 posting names a future |Rose macro and is retained with an
  ;; explicit flag rather than mistaken for a topic reference.
  (func $help_parse_keyword_index
    (param $tree_internal i32) (param $data_internal i32)
    (param $topics_wa i32) (param $topic_count i32) (result i32)
    (local $tree_record i32) (local $data_record i32)
    (local $tree_off i32) (local $tree_len i32) (local $tree i32)
    (local $data_off i32) (local $data_len i32) (local $data i32)
    (local $page_size i32) (local $root_page i32) (local $total_pages i32)
    (local $levels i32) (local $total_entries i32) (local $page_bytes i32)
    (local $pages_off i32) (local $page_num i32) (local $page_ptr i32)
    (local $depth i32) (local $unused i32) (local $entries i32)
    (local $used_end i32) (local $entry_rel i32) (local $entry_index i32)
    (local $child i32) (local $previous_page i32) (local $next_page i32)
    (local $keyword_len i32) (local $keyword_ptr i32) (local $keyword_off i32)
    (local $prev_keyword_ptr i32) (local $prev_keyword_len i32)
    (local $has_prev_keyword i32) (local $occurrences i32) (local $posting_off i32)
    (local $keyword_count i32) (local $posting_count i32) (local $posting_index i32)
    (local $keywords_ga i32) (local $keywords_wa i32)
    (local $postings_ga i32) (local $postings_wa i32)
    (local $visited_ga i32) (local $visited_wa i32) (local $visited_bytes i32)
    (local $record i32) (local $posting i32) (local $topic_ref i32)
    (local $i i32) (local $j i32) (local $scratch i32) (local $ok i32)
    (global.set $help_keyword_result_keywords_ga (i32.const 0))
    (global.set $help_keyword_result_keywords_wa (i32.const 0))
    (global.set $help_keyword_result_keyword_count (i32.const 0))
    (global.set $help_keyword_result_postings_ga (i32.const 0))
    (global.set $help_keyword_result_postings_wa (i32.const 0))
    (global.set $help_keyword_result_posting_count (i32.const 0))
    (local.set $tree_record (i32.add (global.get $help_doc_directory_wa)
      (i32.mul (local.get $tree_internal) (global.get $HELP_INTERNAL_FILE_SIZE))))
    (local.set $data_record (i32.add (global.get $help_doc_directory_wa)
      (i32.mul (local.get $data_internal) (global.get $HELP_INTERNAL_FILE_SIZE))))
    (local.set $tree_off (i32.load offset=12 (local.get $tree_record)))
    (local.set $tree_len (i32.load offset=16 (local.get $tree_record)))
    (local.set $data_off (i32.load offset=12 (local.get $data_record)))
    (local.set $data_len (i32.load offset=16 (local.get $data_record)))
    (local.set $scratch (i32.add (global.get $help_doc_meta_wa) (i32.const 16)))
    (block $done
      (if (i32.or (i32.lt_u (local.get $tree_len) (i32.const 38))
                  (i32.ne (i32.rem_u (local.get $data_len) (i32.const 4)) (i32.const 0)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX) (local.get $tree_off))
          (br $done)))
      (local.set $tree (i32.add (global.get $help_doc_file_wa) (local.get $tree_off)))
      (local.set $data (i32.add (global.get $help_doc_file_wa) (local.get $data_off)))
      (if (i32.or
            (i32.ne (i32.load16_u (local.get $tree)) (i32.const 0x293b))
            (i32.ne (i32.and (i32.load16_u offset=2 (local.get $tree)) (i32.const 2))
              (i32.const 2)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX) (local.get $tree_off))
          (br $done)))
      (if (i32.or
            (i32.or
              (i32.and
                (i32.ne (i32.load8_u offset=6 (local.get $tree)) (i32.const 0x7a))
                (i32.and
                  (i32.ne (i32.load8_u offset=6 (local.get $tree)) (i32.const 0x69))
                  (i32.ne (i32.load8_u offset=6 (local.get $tree)) (i32.const 0x46))))
              (i32.ne (i32.load8_u offset=7 (local.get $tree)) (i32.const 0x32)))
            (i32.ne (i32.load8_u offset=8 (local.get $tree)) (i32.const 0x34)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
            (i32.add (local.get $tree_off) (i32.const 6)))
          (br $done)))
      (if (i32.or
            (i32.ne (i32.load16_u offset=22 (local.get $tree)) (i32.const 0))
            (i32.ne (i32.load16_u offset=28 (local.get $tree)) (i32.const 0xffff)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
            (i32.add (local.get $tree_off) (i32.const 22)))
          (br $done)))
      (local.set $page_size (i32.load16_u offset=4 (local.get $tree)))
      (local.set $root_page (i32.load16_u offset=26 (local.get $tree)))
      (local.set $total_pages (i32.load16_u offset=30 (local.get $tree)))
      (local.set $levels (i32.load16_u offset=32 (local.get $tree)))
      (local.set $total_entries (i32.load offset=34 (local.get $tree)))
      (if (i32.or
            (i32.or (i32.lt_u (local.get $page_size) (i32.const 512))
                    (i32.gt_u (local.get $page_size) (i32.const 4096)))
            (i32.ne (i32.and (local.get $page_size)
              (i32.sub (local.get $page_size) (i32.const 1))) (i32.const 0)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
            (i32.add (local.get $tree_off) (i32.const 4)))
          (br $done)))
      (if (i32.or
            (i32.or (i32.eqz (local.get $total_pages))
                    (i32.gt_u (local.get $total_pages) (global.get $HELP_MAX_BTREE_PAGES)))
            (i32.or (i32.eqz (local.get $levels))
                    (i32.gt_u (local.get $levels) (global.get $HELP_MAX_BTREE_DEPTH))))
        (then
          (call $help_set_error (global.get $HELP_ERROR_CAPACITY)
            (i32.add (local.get $tree_off) (i32.const 30)))
          (br $done)))
      (if (i32.gt_u (local.get $total_entries) (global.get $HELP_MAX_KEYWORDS))
        (then
          (call $help_set_error (global.get $HELP_ERROR_CAPACITY)
            (i32.add (local.get $tree_off) (i32.const 34)))
          (br $done)))
      (if (i32.and (i32.gt_u (local.get $levels) (i32.const 1))
                   (i32.ge_u (local.get $root_page) (local.get $total_pages)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
            (i32.add (local.get $tree_off) (i32.const 26)))
          (br $done)))
      (if (i32.gt_u (local.get $total_pages)
            (i32.div_u (i32.const -1) (local.get $page_size)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_CAPACITY)
            (i32.add (local.get $tree_off) (i32.const 30)))
          (br $done)))
      (local.set $page_bytes (i32.mul (local.get $total_pages) (local.get $page_size)))
      (if (i32.gt_u (local.get $page_bytes)
            (i32.sub (local.get $tree_len) (i32.const 38)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
            (i32.add (local.get $tree_off) (i32.const 30)))
          (br $done)))
      (local.set $pages_off (i32.add (local.get $tree_off) (i32.const 38)))
      (if (local.get $total_entries)
        (then
          (local.set $keywords_ga (call $heap_alloc
            (i32.mul (local.get $total_entries) (global.get $HELP_KEYWORD_SIZE))))
          (if (i32.eqz (local.get $keywords_ga))
            (then
              (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
              (br $done)))
          (local.set $keywords_wa (call $g2w (local.get $keywords_ga)))
          (memory.fill (local.get $keywords_wa) (i32.const 0)
            (i32.mul (local.get $total_entries) (global.get $HELP_KEYWORD_SIZE)))))
      (local.set $visited_bytes
        (i32.shr_u (i32.add (local.get $total_pages) (i32.const 7)) (i32.const 3)))
      (local.set $visited_ga (call $heap_alloc (local.get $visited_bytes)))
      (if (i32.eqz (local.get $visited_ga))
        (then
          (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
          (br $done)))
      (local.set $visited_wa (call $g2w (local.get $visited_ga)))
      (memory.fill (local.get $visited_wa) (i32.const 0) (local.get $visited_bytes))

      (if (i32.eq (local.get $levels) (i32.const 1))
        (then (local.set $page_num (i32.const 0)))
        (else (local.set $page_num (local.get $root_page))))
      (local.set $depth (i32.const 1))
      (block $at_leaf (loop $descend
        (br_if $at_leaf (i32.ge_u (local.get $depth) (local.get $levels)))
        (if (i32.or
              (i32.ge_u (local.get $page_num) (local.get $total_pages))
              (i32.eqz (call $help_mark_btree_page
                (local.get $visited_wa) (local.get $page_num))))
          (then
            (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
              (i32.add (local.get $pages_off)
                (i32.mul (local.get $page_num) (local.get $page_size))))
            (br $done)))
        (local.set $page_ptr (i32.add (global.get $help_doc_file_wa)
          (i32.add (local.get $pages_off)
            (i32.mul (local.get $page_num) (local.get $page_size)))))
        (local.set $unused (i32.load16_u (local.get $page_ptr)))
        (local.set $entries (i32.load16_u offset=2 (local.get $page_ptr)))
        (if (i32.gt_u (local.get $unused)
              (i32.sub (local.get $page_size) (i32.const 6)))
          (then
            (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
              (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa)))
            (br $done)))
        (local.set $used_end (i32.sub (local.get $page_size) (local.get $unused)))
        (local.set $child (i32.load16_u offset=4 (local.get $page_ptr)))
        (if (i32.ge_u (local.get $child) (local.get $total_pages))
          (then
            (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
              (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa))
                (i32.const 4)))
            (br $done)))
        (call $help_slice_init (local.get $scratch)
          (local.get $page_ptr) (local.get $page_size) (i32.const 0) (local.get $used_end))
        (local.set $entry_rel (i32.const 6))
        (local.set $entry_index (i32.const 0))
        (local.set $has_prev_keyword (i32.const 0))
        (block $index_entries_done (loop $index_entry
          (br_if $index_entries_done
            (i32.ge_u (local.get $entry_index) (local.get $entries)))
          (local.set $keyword_len (call $help_read_cstring_length
            (local.get $scratch) (local.get $entry_rel) (i32.const 512)))
          (if (i32.or (i32.le_s (local.get $keyword_len) (i32.const 0))
                      (i32.gt_u (i32.add (local.get $keyword_len) (i32.const 3))
                        (i32.sub (local.get $used_end) (local.get $entry_rel))))
            (then
              (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
                (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa))
                  (local.get $entry_rel)))
              (br $done)))
          (local.set $keyword_ptr (i32.add (local.get $page_ptr) (local.get $entry_rel)))
          (if (i32.and (local.get $has_prev_keyword)
                (i32.ge_s (call $help_keyword_bytes_compare
                  (local.get $prev_keyword_ptr) (local.get $prev_keyword_len)
                  (local.get $keyword_ptr) (local.get $keyword_len)) (i32.const 0)))
            (then
              (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
                (i32.sub (local.get $keyword_ptr) (global.get $help_doc_file_wa)))
              (br $done)))
          (local.set $child (i32.load16_u (i32.add (local.get $keyword_ptr)
            (i32.add (local.get $keyword_len) (i32.const 1)))))
          (if (i32.ge_u (local.get $child) (local.get $total_pages))
            (then
              (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
                (i32.sub (local.get $keyword_ptr) (global.get $help_doc_file_wa)))
              (br $done)))
          (local.set $prev_keyword_ptr (local.get $keyword_ptr))
          (local.set $prev_keyword_len (local.get $keyword_len))
          (local.set $has_prev_keyword (i32.const 1))
          (local.set $entry_rel (i32.add (local.get $entry_rel)
            (i32.add (local.get $keyword_len) (i32.const 3))))
          (local.set $entry_index (i32.add (local.get $entry_index) (i32.const 1)))
          (br $index_entry)))
        (if (i32.ne (local.get $entry_rel) (local.get $used_end))
          (then
            (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
              (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa))
                (local.get $entry_rel)))
            (br $done)))
        (local.set $page_num (i32.load16_u offset=4 (local.get $page_ptr)))
        (local.set $depth (i32.add (local.get $depth) (i32.const 1)))
        (br $descend)))

      (local.set $previous_page (i32.const 0xffff))
      (local.set $has_prev_keyword (i32.const 0))
      (block $leaves_done (loop $leaf
        (br_if $leaves_done (i32.eq (local.get $page_num) (i32.const 0xffff)))
        (if (i32.or
              (i32.ge_u (local.get $page_num) (local.get $total_pages))
              (i32.eqz (call $help_mark_btree_page
                (local.get $visited_wa) (local.get $page_num))))
          (then
            (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
              (i32.add (local.get $pages_off)
                (i32.mul (local.get $page_num) (local.get $page_size))))
            (br $done)))
        (local.set $page_ptr (i32.add (global.get $help_doc_file_wa)
          (i32.add (local.get $pages_off)
            (i32.mul (local.get $page_num) (local.get $page_size)))))
        (local.set $unused (i32.load16_u (local.get $page_ptr)))
        (local.set $entries (i32.load16_u offset=2 (local.get $page_ptr)))
        (if (i32.or
              (i32.gt_u (local.get $unused)
                (i32.sub (local.get $page_size) (i32.const 8)))
              (i32.gt_u (local.get $entries)
                (i32.sub (local.get $total_entries) (local.get $keyword_count))))
          (then
            (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
              (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa)))
            (br $done)))
        (if (i32.ne (i32.load16_u offset=4 (local.get $page_ptr))
              (local.get $previous_page))
          (then
            (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
              (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa))
                (i32.const 4)))
            (br $done)))
        (local.set $next_page (i32.load16_u offset=6 (local.get $page_ptr)))
        (if (i32.and (i32.ne (local.get $next_page) (i32.const 0xffff))
                     (i32.ge_u (local.get $next_page) (local.get $total_pages)))
          (then
            (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
              (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa))
                (i32.const 6)))
            (br $done)))
        (local.set $used_end (i32.sub (local.get $page_size) (local.get $unused)))
        (call $help_slice_init (local.get $scratch)
          (local.get $page_ptr) (local.get $page_size) (i32.const 0) (local.get $used_end))
        (local.set $entry_rel (i32.const 8))
        (local.set $entry_index (i32.const 0))
        (block $leaf_entries_done (loop $leaf_entry
          (br_if $leaf_entries_done
            (i32.ge_u (local.get $entry_index) (local.get $entries)))
          (local.set $keyword_len (call $help_read_cstring_length
            (local.get $scratch) (local.get $entry_rel) (i32.const 512)))
          (if (i32.or (i32.le_s (local.get $keyword_len) (i32.const 0))
                      (i32.gt_u (i32.add (local.get $keyword_len) (i32.const 7))
                        (i32.sub (local.get $used_end) (local.get $entry_rel))))
            (then
              (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
                (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa))
                  (local.get $entry_rel)))
              (br $done)))
          (local.set $keyword_ptr (i32.add (local.get $page_ptr) (local.get $entry_rel)))
          (if (i32.and (local.get $has_prev_keyword)
                (i32.ge_s (call $help_keyword_bytes_compare
                  (local.get $prev_keyword_ptr) (local.get $prev_keyword_len)
                  (local.get $keyword_ptr) (local.get $keyword_len)) (i32.const 0)))
            (then
              (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
                (i32.sub (local.get $keyword_ptr) (global.get $help_doc_file_wa)))
              (br $done)))
          (local.set $occurrences (i32.load16_u (i32.add (local.get $keyword_ptr)
            (i32.add (local.get $keyword_len) (i32.const 1)))))
          (local.set $posting_off (i32.load (i32.add (local.get $keyword_ptr)
            (i32.add (local.get $keyword_len) (i32.const 3)))))
          (if (i32.or
                (i32.eqz (local.get $occurrences))
                (i32.or
                  (i32.ne (i32.and (local.get $posting_off) (i32.const 3)) (i32.const 0))
                  (i32.or
                    (i32.gt_u (local.get $posting_off) (local.get $data_len))
                    (i32.gt_u (local.get $occurrences)
                      (i32.div_u (i32.sub (local.get $data_len) (local.get $posting_off))
                        (i32.const 4))))))
            (then
              (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
                (i32.sub (local.get $keyword_ptr) (global.get $help_doc_file_wa)))
              (br $done)))
          (if (i32.gt_u (local.get $occurrences)
                (i32.sub (global.get $HELP_MAX_KEYWORD_POSTINGS) (local.get $posting_count)))
            (then
              (call $help_set_error (global.get $HELP_ERROR_CAPACITY)
                (i32.sub (local.get $keyword_ptr) (global.get $help_doc_file_wa)))
              (br $done)))
          (local.set $keyword_off
            (i32.sub (local.get $keyword_ptr) (global.get $help_doc_file_wa)))
          (local.set $record (i32.add (local.get $keywords_wa)
            (i32.mul (local.get $keyword_count) (global.get $HELP_KEYWORD_SIZE))))
          (i32.store (local.get $record) (local.get $keyword_off))
          (i32.store offset=4 (local.get $record) (local.get $keyword_len))
          ;; Temporarily retain the |KWDATA byte offset until postings allocate.
          (i32.store offset=8 (local.get $record) (local.get $posting_off))
          (i32.store offset=12 (local.get $record) (local.get $occurrences))
          (local.set $posting_count
            (i32.add (local.get $posting_count) (local.get $occurrences)))
          (local.set $keyword_count (i32.add (local.get $keyword_count) (i32.const 1)))
          (local.set $prev_keyword_ptr (local.get $keyword_ptr))
          (local.set $prev_keyword_len (local.get $keyword_len))
          (local.set $has_prev_keyword (i32.const 1))
          (local.set $entry_rel (i32.add (local.get $entry_rel)
            (i32.add (local.get $keyword_len) (i32.const 7))))
          (local.set $entry_index (i32.add (local.get $entry_index) (i32.const 1)))
          (br $leaf_entry)))
        (if (i32.ne (local.get $entry_rel) (local.get $used_end))
          (then
            (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
              (i32.add (i32.sub (local.get $page_ptr) (global.get $help_doc_file_wa))
                (local.get $entry_rel)))
            (br $done)))
        (local.set $previous_page (local.get $page_num))
        (local.set $page_num (local.get $next_page))
        (br $leaf)))
      (if (i32.ne (local.get $keyword_count) (local.get $total_entries))
        (then
          (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
            (i32.add (local.get $tree_off) (i32.const 34)))
          (br $done)))
      (if (local.get $posting_count)
        (then
          (local.set $postings_ga (call $heap_alloc
            (i32.mul (local.get $posting_count) (global.get $HELP_KEYWORD_POSTING_SIZE))))
          (if (i32.eqz (local.get $postings_ga))
            (then
              (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
              (br $done)))
          (local.set $postings_wa (call $g2w (local.get $postings_ga)))
          (memory.fill (local.get $postings_wa) (i32.const 0)
            (i32.mul (local.get $posting_count) (global.get $HELP_KEYWORD_POSTING_SIZE)))))
      (local.set $i (i32.const 0))
      (block $keywords_done (loop $keywords
        (br_if $keywords_done (i32.ge_u (local.get $i) (local.get $keyword_count)))
        (local.set $record (i32.add (local.get $keywords_wa)
          (i32.mul (local.get $i) (global.get $HELP_KEYWORD_SIZE))))
        (local.set $posting_off (i32.load offset=8 (local.get $record)))
        (local.set $occurrences (i32.load offset=12 (local.get $record)))
        (i32.store offset=8 (local.get $record) (local.get $posting_index))
        (local.set $j (i32.const 0))
        (block $occurrences_done (loop $occurrence
          (br_if $occurrences_done (i32.ge_u (local.get $j) (local.get $occurrences)))
          (local.set $topic_ref (i32.load (i32.add (local.get $data)
            (i32.add (local.get $posting_off) (i32.mul (local.get $j) (i32.const 4))))))
          (if (i32.and (i32.ne (local.get $topic_ref) (i32.const -1))
                (i32.lt_s (call $help_find_topic_index_in
                  (local.get $topics_wa) (local.get $topic_count) (local.get $topic_ref))
                  (i32.const 0)))
            (then
              (call $help_set_error (global.get $HELP_ERROR_KEYWORD_INDEX)
                (i32.add (local.get $data_off)
                  (i32.add (local.get $posting_off) (i32.mul (local.get $j) (i32.const 4)))))
              (br $done)))
          (local.set $posting (i32.add (local.get $postings_wa)
            (i32.mul (local.get $posting_index) (global.get $HELP_KEYWORD_POSTING_SIZE))))
          (i32.store (local.get $posting) (local.get $topic_ref))
          (if (i32.eq (local.get $topic_ref) (i32.const -1))
            (then (i32.store offset=4 (local.get $posting)
              (global.get $HELP_KEYWORD_POSTING_MACRO))))
          (local.set $posting_index (i32.add (local.get $posting_index) (i32.const 1)))
          (local.set $j (i32.add (local.get $j) (i32.const 1)))
          (br $occurrence)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $keywords)))
      (global.set $help_keyword_result_keywords_ga (local.get $keywords_ga))
      (global.set $help_keyword_result_keywords_wa (local.get $keywords_wa))
      (global.set $help_keyword_result_keyword_count (local.get $keyword_count))
      (global.set $help_keyword_result_postings_ga (local.get $postings_ga))
      (global.set $help_keyword_result_postings_wa (local.get $postings_wa))
      (global.set $help_keyword_result_posting_count (local.get $posting_count))
      (local.set $ok (i32.const 1)))
    (if (local.get $visited_ga) (then (call $heap_free (local.get $visited_ga))))
    (if (i32.eqz (local.get $ok))
      (then
        (if (local.get $postings_ga) (then (call $heap_free (local.get $postings_ga))))
        (if (local.get $keywords_ga) (then (call $heap_free (local.get $keywords_ga))))))
    (local.get $ok))

  (func $help_parse_picture_record
    (param $data i32) (param $data_off i32) (param $data_len i32)
    (param $resource_number i32) (param $picture_index i32)
    (param $picture_off i32) (param $dest i32) (result i32)
    (local $picture i32) (local $ptr i32) (local $end i32)
    (local $picture_type i32) (local $packing i32) (local $xdpi i32) (local $ydpi i32)
    (local $planes i32) (local $bit_count i32) (local $width i32) (local $height i32)
    (local $colors_used i32) (local $colors_important i32) (local $palette_count i32)
    (local $compressed_size i32) (local $hotspot_size i32)
    (local $compressed_off i32) (local $hotspot_off i32) (local $palette_off i32)
    (local $decoded_size i32)
    (local $decoded_size64 i64)
    (if (i32.or
          (i32.gt_u (local.get $picture_off) (local.get $data_len))
          (i32.gt_u (i32.const 2) (i32.sub (local.get $data_len) (local.get $picture_off))))
      (then (return (i32.const 0))))
    (local.set $picture (i32.add (local.get $data) (local.get $picture_off)))
    (local.set $ptr (i32.add (local.get $picture) (i32.const 2)))
    (local.set $end (i32.add (local.get $data) (local.get $data_len)))
    (local.set $picture_type (i32.load8_u (local.get $picture)))
    (local.set $packing (i32.load8_u offset=1 (local.get $picture)))
    (if (i32.gt_u (local.get $packing) (i32.const 3))
      (then (return (i32.const 0))))
    ;; Device-dependent bitmaps only use raw or run-length packing. DIBs and
    ;; metafiles admit all four documented combinations.
    (if (i32.and
          (i32.eq (local.get $picture_type) (i32.const 5))
          (i32.gt_u (local.get $packing) (i32.const 1)))
      (then (return (i32.const 0))))
    (if (i32.or (i32.eq (local.get $picture_type) (i32.const 5))
                (i32.eq (local.get $picture_type) (i32.const 6)))
      (then
        (if (i32.eqz (call $help_read_culong (local.get $ptr) (local.get $end)))
          (then (return (i32.const 0))))
        (local.set $xdpi (global.get $help_ld1_value))
        (local.set $ptr (global.get $help_ld1_next))
        (if (i32.eqz (call $help_read_culong (local.get $ptr) (local.get $end)))
          (then (return (i32.const 0))))
        (local.set $ydpi (global.get $help_ld1_value))
        (local.set $ptr (global.get $help_ld1_next))
        (if (i32.eqz (call $help_ld1_read_cu16 (local.get $ptr) (local.get $end)))
          (then (return (i32.const 0))))
        (local.set $planes (global.get $help_ld1_value))
        (local.set $ptr (global.get $help_ld1_next))
        (if (i32.eqz (call $help_ld1_read_cu16 (local.get $ptr) (local.get $end)))
          (then (return (i32.const 0))))
        (local.set $bit_count (global.get $help_ld1_value))
        (local.set $ptr (global.get $help_ld1_next))
        (if (i32.eqz (call $help_read_culong (local.get $ptr) (local.get $end)))
          (then (return (i32.const 0))))
        (local.set $width (global.get $help_ld1_value))
        (local.set $ptr (global.get $help_ld1_next))
        (if (i32.eqz (call $help_read_culong (local.get $ptr) (local.get $end)))
          (then (return (i32.const 0))))
        (local.set $height (global.get $help_ld1_value))
        (local.set $ptr (global.get $help_ld1_next))
        (if (i32.eqz (call $help_read_culong (local.get $ptr) (local.get $end)))
          (then (return (i32.const 0))))
        (local.set $colors_used (global.get $help_ld1_value))
        (local.set $ptr (global.get $help_ld1_next))
        (if (i32.eqz (call $help_read_culong (local.get $ptr) (local.get $end)))
          (then (return (i32.const 0))))
        (local.set $colors_important (global.get $help_ld1_value))
        (local.set $ptr (global.get $help_ld1_next))
        (if (i32.eqz (call $help_read_culong (local.get $ptr) (local.get $end)))
          (then (return (i32.const 0))))
        (local.set $compressed_size (global.get $help_ld1_value))
        (local.set $ptr (global.get $help_ld1_next))
        (if (i32.eqz (call $help_read_culong (local.get $ptr) (local.get $end)))
          (then (return (i32.const 0))))
        (local.set $hotspot_size (global.get $help_ld1_value))
        (local.set $ptr (global.get $help_ld1_next))
        (if (i32.gt_u (i32.const 8) (i32.sub (local.get $end) (local.get $ptr)))
          (then (return (i32.const 0))))
        (local.set $compressed_off (i32.load (local.get $ptr)))
        (local.set $hotspot_off (i32.load offset=4 (local.get $ptr)))
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 8)))
        (if (i32.eq (local.get $picture_type) (i32.const 6))
          (then
            (local.set $palette_count (local.get $colors_used))
            (if (i32.and (i32.eqz (local.get $palette_count))
                          (i32.le_u (local.get $bit_count) (i32.const 8)))
              (then (local.set $palette_count
                (i32.shl (i32.const 1) (local.get $bit_count)))))
            (if (i32.gt_u (local.get $palette_count)
                  (i32.div_u (i32.sub (local.get $end) (local.get $ptr)) (i32.const 4)))
              (then (return (i32.const 0))))
            (local.set $palette_off
              (i32.add (local.get $data_off) (i32.sub (local.get $ptr) (local.get $data))))
            (local.set $ptr (i32.add (local.get $ptr)
              (i32.mul (local.get $palette_count) (i32.const 4))))))
        (if (i32.or
              (i32.or (i32.eqz (local.get $width)) (i32.eqz (local.get $height)))
              (i32.or (i32.eqz (local.get $planes)) (i32.eqz (local.get $bit_count))))
          (then (return (i32.const 0))))
        ;; DDB rows are WORD-aligned in the resource. DIB rows are DWORD-
        ;; aligned. Compute in i64 so hostile dimensions cannot wrap.
        (local.set $decoded_size64
          (i64.mul
            (if (result i64) (i32.eq (local.get $picture_type) (i32.const 5))
              (then
                (i64.shl
                  (i64.shr_u
                    (i64.add
                      (i64.mul (i64.extend_i32_u (local.get $width))
                        (i64.extend_i32_u (local.get $bit_count)))
                      (i64.const 15))
                    (i64.const 4))
                  (i64.const 1)))
              (else
                (i64.shl
                  (i64.shr_u
                    (i64.add
                      (i64.mul (i64.extend_i32_u (local.get $width))
                        (i64.extend_i32_u (local.get $bit_count)))
                      (i64.const 31))
                    (i64.const 5))
                  (i64.const 2))))
            (i64.extend_i32_u (local.get $height))))
        (if (i64.gt_u (local.get $decoded_size64)
              (i64.extend_i32_u (global.get $HELP_MAX_BITMAP_BYTES)))
          (then
            (call $help_set_error (global.get $HELP_ERROR_CAPACITY)
              (i32.add (local.get $data_off) (local.get $picture_off)))
            (return (i32.const 0))))
        (local.set $decoded_size (i32.wrap_i64 (local.get $decoded_size64))))
      (else
        (if (i32.ne (local.get $picture_type) (i32.const 8))
          (then (return (i32.const 0))))
        (if (i32.eqz (call $help_ld1_read_cu16 (local.get $ptr) (local.get $end)))
          (then (return (i32.const 0))))
        (local.set $xdpi (global.get $help_ld1_value))
        (local.set $ptr (global.get $help_ld1_next))
        (if (i32.gt_u (i32.const 4) (i32.sub (local.get $end) (local.get $ptr)))
          (then (return (i32.const 0))))
        (local.set $width (i32.load16_u (local.get $ptr)))
        (local.set $height (i32.load16_u offset=2 (local.get $ptr)))
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 4)))
        (if (i32.eqz (call $help_read_culong (local.get $ptr) (local.get $end)))
          (then (return (i32.const 0))))
        (local.set $decoded_size (global.get $help_ld1_value))
        (if (i32.or (i32.eqz (local.get $decoded_size))
                    (i32.gt_u (local.get $decoded_size)
                      (global.get $HELP_MAX_BITMAP_BYTES)))
          (then
            (call $help_set_error (global.get $HELP_ERROR_CAPACITY)
              (i32.add (local.get $data_off) (local.get $picture_off)))
            (return (i32.const 0))))
        (local.set $ptr (global.get $help_ld1_next))
        (if (i32.eqz (call $help_read_culong (local.get $ptr) (local.get $end)))
          (then (return (i32.const 0))))
        (local.set $compressed_size (global.get $help_ld1_value))
        (local.set $ptr (global.get $help_ld1_next))
        (if (i32.eqz (call $help_read_culong (local.get $ptr) (local.get $end)))
          (then (return (i32.const 0))))
        (local.set $hotspot_size (global.get $help_ld1_value))
        (local.set $ptr (global.get $help_ld1_next))
        (if (i32.gt_u (i32.const 8) (i32.sub (local.get $end) (local.get $ptr)))
          (then (return (i32.const 0))))
        (local.set $compressed_off (i32.load (local.get $ptr)))
        (local.set $hotspot_off (i32.load offset=4 (local.get $ptr)))
        (local.set $ptr (i32.add (local.get $ptr) (i32.const 8)))))
    (if (i32.or
          (i32.or
            (i32.lt_u (local.get $compressed_off)
              (i32.sub (local.get $ptr) (local.get $picture)))
            (i32.gt_u (local.get $compressed_off)
              (i32.sub (local.get $data_len) (local.get $picture_off))))
          (i32.gt_u (local.get $compressed_size)
            (i32.sub (i32.sub (local.get $data_len) (local.get $picture_off))
              (local.get $compressed_off))))
      (then (return (i32.const 0))))
    (if (i32.ne (i32.eqz (local.get $hotspot_size)) (i32.eqz (local.get $hotspot_off)))
      (then (return (i32.const 0))))
    (if (i32.and (i32.eqz (local.get $packing))
          (i32.ne (local.get $compressed_size) (local.get $decoded_size)))
      (then (return (i32.const 0))))
    (if (local.get $hotspot_size)
      (then
        (if (i32.or
              (i32.or
                (i32.lt_u (local.get $hotspot_off)
                  (i32.sub (local.get $ptr) (local.get $picture)))
                (i32.gt_u (local.get $hotspot_off)
                  (i32.sub (local.get $data_len) (local.get $picture_off))))
              (i32.gt_u (local.get $hotspot_size)
                (i32.sub (i32.sub (local.get $data_len) (local.get $picture_off))
                  (local.get $hotspot_off))))
          (then (return (i32.const 0))))))
    (if (local.get $dest)
      (then
        (i32.store (local.get $dest) (local.get $resource_number))
        (i32.store offset=4 (local.get $dest) (local.get $picture_index))
        (i32.store offset=8 (local.get $dest) (local.get $picture_type))
        (i32.store offset=12 (local.get $dest) (local.get $packing))
        (i32.store offset=16 (local.get $dest) (local.get $xdpi))
        (i32.store offset=20 (local.get $dest) (local.get $ydpi))
        (i32.store offset=24 (local.get $dest) (local.get $planes))
        (i32.store offset=28 (local.get $dest) (local.get $bit_count))
        (i32.store offset=32 (local.get $dest) (local.get $width))
        (i32.store offset=36 (local.get $dest) (local.get $height))
        (i32.store offset=40 (local.get $dest) (local.get $colors_used))
        (i32.store offset=44 (local.get $dest) (i32.ne (local.get $colors_important) (i32.const 0)))
        (i32.store offset=48 (local.get $dest) (i32.add (local.get $data_off)
          (i32.add (local.get $picture_off) (local.get $compressed_off))))
        (i32.store offset=52 (local.get $dest) (local.get $compressed_size))
        (i32.store offset=56 (local.get $dest)
          (if (result i32) (local.get $hotspot_size)
            (then (i32.add (local.get $data_off)
              (i32.add (local.get $picture_off) (local.get $hotspot_off))))
            (else (i32.const 0))))
        (i32.store offset=60 (local.get $dest) (local.get $hotspot_size))
        (i32.store offset=64 (local.get $dest) (local.get $palette_off))
        (i32.store offset=68 (local.get $dest) (local.get $palette_count))
        (i32.store offset=72 (local.get $dest) (local.get $decoded_size))
        (i32.store offset=76 (local.get $dest) (i32.const 0))))
    (i32.const 1))

  (func $help_parse_bitmap_resources (result i32)
    (local $i i32) (local $j i32) (local $record i32) (local $prior i32)
    (local $resource_number i32) (local $prior_number i32)
    (local $data_off i32) (local $data_len i32) (local $data i32)
    (local $picture_count i32) (local $header_size i32) (local $picture_off i32)
    (local $total i32) (local $out_index i32) (local $bitmaps_ga i32) (local $bitmaps_wa i32)
    (local $ok i32)
    (global.set $help_bitmap_result_ga (i32.const 0))
    (global.set $help_bitmap_result_wa (i32.const 0))
    (global.set $help_bitmap_result_count (i32.const 0))
    (block $done
      (block $counted (loop $files
        (br_if $counted (i32.ge_u (local.get $i) (global.get $help_doc_directory_count)))
        (local.set $record (i32.add (global.get $help_doc_directory_wa)
          (i32.mul (local.get $i) (global.get $HELP_INTERNAL_FILE_SIZE))))
        (local.set $resource_number (call $help_bitmap_resource_number (local.get $record)))
        (if (i32.ge_s (local.get $resource_number) (i32.const 0))
          (then
            (local.set $j (i32.const 0))
            (block $unique (loop $previous
              (br_if $unique (i32.ge_u (local.get $j) (local.get $i)))
              (local.set $prior (i32.add (global.get $help_doc_directory_wa)
                (i32.mul (local.get $j) (global.get $HELP_INTERNAL_FILE_SIZE))))
              (local.set $prior_number (call $help_bitmap_resource_number (local.get $prior)))
              (if (i32.eq (local.get $prior_number) (local.get $resource_number))
                (then
                  (call $help_set_error (global.get $HELP_ERROR_BITMAP_TABLE)
                    (i32.load offset=12 (local.get $record)))
                  (br $done)))
              (local.set $j (i32.add (local.get $j) (i32.const 1)))
              (br $previous)))
            (local.set $data_off (i32.load offset=12 (local.get $record)))
            (local.set $data_len (i32.load offset=16 (local.get $record)))
            (if (i32.lt_u (local.get $data_len) (i32.const 4))
              (then
                (call $help_set_error (global.get $HELP_ERROR_BITMAP_TABLE) (local.get $data_off))
                (br $done)))
            (local.set $data (i32.add (global.get $help_doc_file_wa) (local.get $data_off)))
            (if (i32.and
                  (i32.ne (i32.load16_u (local.get $data)) (i32.const 0x506C))
                  (i32.ne (i32.load16_u (local.get $data)) (i32.const 0x706C)))
              (then
                (call $help_set_error (global.get $HELP_ERROR_BITMAP_TABLE) (local.get $data_off))
                (br $done)))
            (local.set $picture_count (i32.load16_u offset=2 (local.get $data)))
            (if (i32.or (i32.eqz (local.get $picture_count))
                        (i32.gt_u (local.get $picture_count)
                          (i32.sub (global.get $HELP_MAX_BITMAP_RESOURCES) (local.get $total))))
              (then
                (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (local.get $data_off))
                (br $done)))
            (local.set $header_size (i32.add (i32.const 4)
              (i32.mul (local.get $picture_count) (i32.const 4))))
            (if (i32.gt_u (local.get $header_size) (local.get $data_len))
              (then
                (call $help_set_error (global.get $HELP_ERROR_BITMAP_TABLE) (local.get $data_off))
                (br $done)))
            (local.set $j (i32.const 0))
            (block $pictures_done (loop $pictures
              (br_if $pictures_done (i32.ge_u (local.get $j) (local.get $picture_count)))
              (local.set $picture_off (i32.load (i32.add (local.get $data)
                (i32.add (i32.const 4) (i32.mul (local.get $j) (i32.const 4))))))
              (if (i32.or
                    (i32.lt_u (local.get $picture_off) (local.get $header_size))
                    (i32.eqz (call $help_parse_picture_record
                      (local.get $data) (local.get $data_off) (local.get $data_len)
                      (local.get $resource_number) (local.get $j)
                      (local.get $picture_off) (i32.const 0))))
                (then
                  (call $help_set_error (global.get $HELP_ERROR_BITMAP_TABLE)
                    (i32.add (local.get $data_off) (local.get $picture_off)))
                  (br $done)))
              (local.set $j (i32.add (local.get $j) (i32.const 1)))
              (br $pictures)))
            (local.set $total (i32.add (local.get $total) (local.get $picture_count)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $files)))
      (if (local.get $total)
        (then
          (local.set $bitmaps_ga (call $heap_alloc
            (i32.mul (local.get $total) (global.get $HELP_BITMAP_SIZE))))
          (if (i32.eqz (local.get $bitmaps_ga))
            (then
              (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
              (br $done)))
          (local.set $bitmaps_wa (call $g2w (local.get $bitmaps_ga)))
          (memory.fill (local.get $bitmaps_wa) (i32.const 0)
            (i32.mul (local.get $total) (global.get $HELP_BITMAP_SIZE)))))
      (local.set $i (i32.const 0))
      (block $emitted (loop $files2
        (br_if $emitted (i32.ge_u (local.get $i) (global.get $help_doc_directory_count)))
        (local.set $record (i32.add (global.get $help_doc_directory_wa)
          (i32.mul (local.get $i) (global.get $HELP_INTERNAL_FILE_SIZE))))
        (local.set $resource_number (call $help_bitmap_resource_number (local.get $record)))
        (if (i32.ge_s (local.get $resource_number) (i32.const 0))
          (then
            (local.set $data_off (i32.load offset=12 (local.get $record)))
            (local.set $data_len (i32.load offset=16 (local.get $record)))
            (local.set $data (i32.add (global.get $help_doc_file_wa) (local.get $data_off)))
            (local.set $picture_count (i32.load16_u offset=2 (local.get $data)))
            (local.set $j (i32.const 0))
            (block $pictures2_done (loop $pictures2
              (br_if $pictures2_done (i32.ge_u (local.get $j) (local.get $picture_count)))
              (local.set $picture_off (i32.load (i32.add (local.get $data)
                (i32.add (i32.const 4) (i32.mul (local.get $j) (i32.const 4))))))
              (if (i32.eqz (call $help_parse_picture_record
                    (local.get $data) (local.get $data_off) (local.get $data_len)
                    (local.get $resource_number) (local.get $j) (local.get $picture_off)
                    (i32.add (local.get $bitmaps_wa)
                      (i32.mul (local.get $out_index) (global.get $HELP_BITMAP_SIZE)))))
                (then
                  (call $help_set_error (global.get $HELP_ERROR_BITMAP_TABLE)
                    (i32.add (local.get $data_off) (local.get $picture_off)))
                  (br $done)))
              (local.set $out_index (i32.add (local.get $out_index) (i32.const 1)))
              (local.set $j (i32.add (local.get $j) (i32.const 1)))
              (br $pictures2)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $files2)))
      (global.set $help_bitmap_result_ga (local.get $bitmaps_ga))
      (global.set $help_bitmap_result_wa (local.get $bitmaps_wa))
      (global.set $help_bitmap_result_count (local.get $total))
      (local.set $ok (i32.const 1)))
    (if (i32.eqz (local.get $ok))
      (then (if (local.get $bitmaps_ga) (then (call $heap_free (local.get $bitmaps_ga))))))
    (local.get $ok))

  ;; Consume one byte after the optional LZ77 layer. WinHelp's run-length
  ;; layer uses 0x81..0xff for literal runs and 0x01..0x7f for repeated-byte
  ;; runs. A zero low-seven-bit count is a control boundary, including 0x80
  ;; after the final literal in a run.
  (func $help_bitmap_decode_emit
    (param $ch i32) (param $dest i32) (param $expected i32) (param $write i32)
    (result i32)
    (local $count i32) (local $out_pos i32)
    (local.set $out_pos (global.get $help_bitmap_decode_out_pos))
    (if (global.get $help_bitmap_decode_rle)
      (then
        (local.set $count (global.get $help_bitmap_decode_rle_count))
        (if (i32.and (local.get $count) (i32.const 0x7f))
          (then
            (if (i32.and (local.get $count) (i32.const 0x80))
              (then
                (if (i32.ge_u (local.get $out_pos) (local.get $expected))
                  (then (return (i32.const 0))))
                (if (local.get $write)
                  (then (i32.store8 (i32.add (local.get $dest) (local.get $out_pos))
                    (local.get $ch))))
                (global.set $help_bitmap_decode_out_pos
                  (i32.add (local.get $out_pos) (i32.const 1)))
                (global.set $help_bitmap_decode_rle_count
                  (i32.and (i32.sub (local.get $count) (i32.const 1)) (i32.const 0xff))))
              (else
                (if (i32.gt_u (local.get $count)
                      (i32.sub (local.get $expected) (local.get $out_pos)))
                  (then (return (i32.const 0))))
                (if (local.get $write)
                  (then (memory.fill (i32.add (local.get $dest) (local.get $out_pos))
                    (local.get $ch) (local.get $count))))
                (global.set $help_bitmap_decode_out_pos
                  (i32.add (local.get $out_pos) (local.get $count)))
                (global.set $help_bitmap_decode_rle_count (i32.const 0)))))
          (else
            (global.set $help_bitmap_decode_rle_count (local.get $ch)))))
      (else
        (if (i32.ge_u (local.get $out_pos) (local.get $expected))
          (then (return (i32.const 0))))
        (if (local.get $write)
          (then (i32.store8 (i32.add (local.get $dest) (local.get $out_pos))
            (local.get $ch))))
        (global.set $help_bitmap_decode_out_pos
          (i32.add (local.get $out_pos) (i32.const 1)))))
    (i32.const 1))

  (func $help_bitmap_decode_lz_emit
    (param $ch i32) (param $window i32)
    (param $dest i32) (param $expected i32) (param $write i32) (result i32)
    (local $position i32)
    (local.set $position (global.get $help_bitmap_decode_lz_pos))
    (if (i32.ge_u (local.get $position) (global.get $HELP_MAX_BITMAP_INTERMEDIATE_BYTES))
      (then (return (i32.const 0))))
    (i32.store8 (i32.add (local.get $window)
      (i32.and (local.get $position) (i32.const 0x0fff))) (local.get $ch))
    (if (i32.eqz (call $help_bitmap_decode_emit
          (local.get $ch) (local.get $dest) (local.get $expected) (local.get $write)))
      (then (return (i32.const 0))))
    (global.set $help_bitmap_decode_lz_pos
      (i32.add (local.get $position) (i32.const 1)))
    (i32.const 1))

  ;; Decode one picture payload. Packing 3 means LZ77 first, then RLE, which
  ;; is the order used by the compiler and native reader. This pass is also
  ;; usable without writes, allowing the public entry point to validate the
  ;; complete stream before changing caller memory.
  (func $help_bitmap_decode_pass
    (param $source i32) (param $source_len i32) (param $packing i32)
    (param $dest i32) (param $expected i32) (param $window i32) (param $write i32)
    (result i32)
    (local $source_pos i32) (local $control i32) (local $bit i32)
    (local $word i32) (local $distance i32) (local $length i32)
    (local $i i32) (local $ch i32) (local $back i32)
    (global.set $help_bitmap_decode_out_pos (i32.const 0))
    (global.set $help_bitmap_decode_rle_count (i32.const 0))
    (global.set $help_bitmap_decode_rle (i32.and (local.get $packing) (i32.const 1)))
    (global.set $help_bitmap_decode_lz_pos (i32.const 0))
    (if (i32.and (local.get $packing) (i32.const 2))
      (then
        (block $lz_done (loop $controls
          (br_if $lz_done (i32.ge_u (local.get $source_pos) (local.get $source_len)))
          (local.set $control (i32.load8_u
            (i32.add (local.get $source) (local.get $source_pos))))
          (local.set $source_pos (i32.add (local.get $source_pos) (i32.const 1)))
          (local.set $bit (i32.const 0))
          (block $control_done (loop $tokens
            (br_if $control_done (i32.ge_u (local.get $bit) (i32.const 8)))
            ;; High control bits are unused when the physical stream ends.
            (br_if $control_done (i32.ge_u (local.get $source_pos) (local.get $source_len)))
            (if (i32.and (local.get $control)
                  (i32.shl (i32.const 1) (local.get $bit)))
              (then
                (if (i32.gt_u (i32.const 2)
                      (i32.sub (local.get $source_len) (local.get $source_pos)))
                  (then (return (i32.const 0))))
                (local.set $word (i32.load16_u
                  (i32.add (local.get $source) (local.get $source_pos))))
                (local.set $source_pos (i32.add (local.get $source_pos) (i32.const 2)))
                (local.set $distance (i32.and (local.get $word) (i32.const 0x0fff)))
                (local.set $length
                  (i32.add (i32.shr_u (local.get $word) (i32.const 12)) (i32.const 3)))
                (if (i32.ge_u (local.get $distance) (global.get $help_bitmap_decode_lz_pos))
                  (then (return (i32.const 0))))
                (local.set $i (i32.const 0))
                (block $copy_done (loop $copy
                  (br_if $copy_done (i32.ge_u (local.get $i) (local.get $length)))
                  (local.set $back (i32.sub
                    (i32.sub (global.get $help_bitmap_decode_lz_pos)
                      (local.get $distance))
                    (i32.const 1)))
                  (local.set $ch (i32.load8_u (i32.add (local.get $window)
                    (i32.and (local.get $back) (i32.const 0x0fff)))))
                  (if (i32.eqz (call $help_bitmap_decode_lz_emit
                        (local.get $ch) (local.get $window) (local.get $dest)
                        (local.get $expected) (local.get $write)))
                    (then (return (i32.const 0))))
                  (local.set $i (i32.add (local.get $i) (i32.const 1)))
                  (br $copy))))
              (else
                (local.set $ch (i32.load8_u
                  (i32.add (local.get $source) (local.get $source_pos))))
                (local.set $source_pos (i32.add (local.get $source_pos) (i32.const 1)))
                (if (i32.eqz (call $help_bitmap_decode_lz_emit
                      (local.get $ch) (local.get $window) (local.get $dest)
                      (local.get $expected) (local.get $write)))
                  (then (return (i32.const 0))))))
            (local.set $bit (i32.add (local.get $bit) (i32.const 1)))
            (br $tokens)))
          (br $controls))))
      (else
        (block $raw_done (loop $raw
          (br_if $raw_done (i32.ge_u (local.get $source_pos) (local.get $source_len)))
          (if (i32.eqz (call $help_bitmap_decode_emit
                (i32.load8_u (i32.add (local.get $source) (local.get $source_pos)))
                (local.get $dest) (local.get $expected) (local.get $write)))
            (then (return (i32.const 0))))
          (local.set $source_pos (i32.add (local.get $source_pos) (i32.const 1)))
          (br $raw)))))
    (i32.and
      (i32.eq (global.get $help_bitmap_decode_out_pos) (local.get $expected))
      (i32.eqz (i32.and (global.get $help_bitmap_decode_rle_count) (i32.const 0x7f)))))

  (func $help_decode_bitmap
    (param $bitmap_index i32) (param $out_wa i32) (param $capacity i32) (result i32)
    (local $memory_bytes i32) (local $record i32) (local $source_off i32)
    (local $source_len i32) (local $source i32) (local $packing i32)
    (local $expected i32) (local $window_ga i32) (local $window_wa i32)
    (local $table_bytes i32)
    (if (i32.ge_u (local.get $bitmap_index) (global.get $help_doc_bitmap_count))
      (then
        (call $help_set_error (global.get $HELP_ERROR_BAD_ARGUMENT) (i32.const 0))
        (return (i32.const -1))))
    (local.set $record (i32.add (global.get $help_doc_bitmaps_wa)
      (i32.mul (local.get $bitmap_index) (global.get $HELP_BITMAP_SIZE))))
    (local.set $source_off (i32.load offset=48 (local.get $record)))
    (local.set $source_len (i32.load offset=52 (local.get $record)))
    (local.set $packing (i32.load offset=12 (local.get $record)))
    (local.set $expected (i32.load offset=72 (local.get $record)))
    (local.set $memory_bytes (i32.shl (memory.size) (i32.const 16)))
    (if (i32.or
          (i32.gt_u (local.get $out_wa) (local.get $memory_bytes))
          (i32.gt_u (local.get $capacity)
            (i32.sub (local.get $memory_bytes) (local.get $out_wa))))
      (then
        (call $help_set_error (global.get $HELP_ERROR_BAD_ARGUMENT) (local.get $source_off))
        (return (i32.const -1))))
    (if (i32.gt_u (local.get $expected) (local.get $capacity))
      (then
        (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (local.get $source_off))
        (return (i32.const -1))))
    ;; Never permit a caller-owned output arena to corrupt the immutable HLP
    ;; image or the normalized bitmap table.
    (if (i32.and
          (i32.lt_u (local.get $out_wa)
            (i32.add (global.get $help_doc_file_wa) (global.get $help_doc_file_size)))
          (i32.lt_u (global.get $help_doc_file_wa)
            (i32.add (local.get $out_wa) (local.get $expected))))
      (then
        (call $help_set_error (global.get $HELP_ERROR_BAD_ARGUMENT) (local.get $source_off))
        (return (i32.const -1))))
    (local.set $table_bytes
      (i32.mul (global.get $help_doc_bitmap_count) (global.get $HELP_BITMAP_SIZE)))
    (if (i32.and
          (i32.lt_u (local.get $out_wa)
            (i32.add (global.get $help_doc_bitmaps_wa) (local.get $table_bytes)))
          (i32.lt_u (global.get $help_doc_bitmaps_wa)
            (i32.add (local.get $out_wa) (local.get $expected))))
      (then
        (call $help_set_error (global.get $HELP_ERROR_BAD_ARGUMENT) (local.get $source_off))
        (return (i32.const -1))))
    (local.set $source (i32.add (global.get $help_doc_file_wa) (local.get $source_off)))
    (local.set $window_ga (call $heap_alloc (i32.const 4096)))
    (if (i32.eqz (local.get $window_ga))
      (then
        (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (local.get $source_off))
        (return (i32.const -1))))
    (local.set $window_wa (call $g2w (local.get $window_ga)))
    (if (i32.eqz (call $help_bitmap_decode_pass
          (local.get $source) (local.get $source_len) (local.get $packing)
          (local.get $out_wa) (local.get $expected) (local.get $window_wa) (i32.const 0)))
      (then
        (call $heap_free (local.get $window_ga))
        (call $help_set_error (global.get $HELP_ERROR_BITMAP_TABLE) (local.get $source_off))
        (return (i32.const -1))))
    (if (i32.eqz (call $help_bitmap_decode_pass
          (local.get $source) (local.get $source_len) (local.get $packing)
          (local.get $out_wa) (local.get $expected) (local.get $window_wa) (i32.const 1)))
      (then
        (call $heap_free (local.get $window_ga))
        (call $help_set_error (global.get $HELP_ERROR_BITMAP_TABLE) (local.get $source_off))
        (return (i32.const -1))))
    (call $heap_free (local.get $window_ga))
    (local.get $expected))

  (func $help_parse_semantic_indexes (result i32)
    (local $topic_internal i32) (local $title_internal i32)
    (local $context_internal i32) (local $map_internal i32)
    (local $phrase_index_internal i32) (local $phrase_image_internal i32)
    (local $old_phrase_internal i32) (local $phrase_mode i32)
    (local $font_internal i32) (local $font_metric_mode i32)
    (local $keyword_tree_internal i32) (local $keyword_data_internal i32)
    (local $topics_ga i32) (local $topics_wa i32) (local $topic_count i32)
    (local $contexts_ga i32) (local $contexts_wa i32) (local $context_count i32)
    (local $maps_ga i32) (local $maps_wa i32) (local $map_count i32)
    (local $phrase_offsets_ga i32) (local $phrase_offsets_wa i32)
    (local $phrase_image_ga i32) (local $phrase_image_wa i32)
    (local $phrase_count i32) (local $phrase_image_size i32)
    (local $font_faces_ga i32) (local $font_faces_wa i32) (local $font_face_count i32)
    (local $fonts_ga i32) (local $fonts_wa i32) (local $font_count i32)
    (local $bitmaps_ga i32) (local $bitmaps_wa i32) (local $bitmap_count i32)
    (local $keywords_ga i32) (local $keywords_wa i32) (local $keyword_count i32)
    (local $postings_ga i32) (local $postings_wa i32) (local $posting_count i32)
    (local $ok i32)
    (block $done
      (if (i32.eqz (call $help_parse_system)) (then (br $done)))
      (local.set $topic_internal (call $help_find_internal_literal (i32.const 2)))
      (if (i32.lt_s (local.get $topic_internal) (i32.const 0))
        (then
          (call $help_set_error (global.get $HELP_ERROR_MISSING_INTERNAL) (i32.const 0))
          (br $done)))
      (local.set $title_internal (call $help_find_internal_literal (i32.const 3)))
      (if (i32.lt_s (local.get $title_internal) (i32.const 0))
        (then
          (call $help_set_error (global.get $HELP_ERROR_MISSING_INTERNAL) (i32.const 0))
          (br $done)))
      (if (i32.eqz (call $help_parse_semantic_btree
            (local.get $title_internal) (i32.const 1) (i32.const 0) (i32.const 0)))
        (then (br $done)))
      (local.set $topics_ga (global.get $help_semantic_result_ga))
      (local.set $topics_wa (global.get $help_semantic_result_wa))
      (local.set $topic_count (global.get $help_semantic_result_count))
      (global.set $help_semantic_result_ga (i32.const 0))

      (local.set $keyword_tree_internal (call $help_find_internal_literal (i32.const 10)))
      (local.set $keyword_data_internal (call $help_find_internal_literal (i32.const 11)))
      (if (i32.ne
            (i32.ge_s (local.get $keyword_tree_internal) (i32.const 0))
            (i32.ge_s (local.get $keyword_data_internal) (i32.const 0)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_MISSING_INTERNAL) (i32.const 0))
          (br $done)))
      (if (i32.ge_s (local.get $keyword_tree_internal) (i32.const 0))
        (then
          (if (i32.eqz (call $help_parse_keyword_index
                (local.get $keyword_tree_internal) (local.get $keyword_data_internal)
                (local.get $topics_wa) (local.get $topic_count)))
            (then (br $done)))
          (local.set $keywords_ga (global.get $help_keyword_result_keywords_ga))
          (local.set $keywords_wa (global.get $help_keyword_result_keywords_wa))
          (local.set $keyword_count (global.get $help_keyword_result_keyword_count))
          (local.set $postings_ga (global.get $help_keyword_result_postings_ga))
          (local.set $postings_wa (global.get $help_keyword_result_postings_wa))
          (local.set $posting_count (global.get $help_keyword_result_posting_count))
          (global.set $help_keyword_result_keywords_ga (i32.const 0))
          (global.set $help_keyword_result_postings_ga (i32.const 0))))

      (local.set $context_internal (call $help_find_internal_literal (i32.const 4)))
      (if (i32.ge_s (local.get $context_internal) (i32.const 0))
        (then
          (if (i32.eqz (call $help_parse_semantic_btree
                (local.get $context_internal) (i32.const 2)
                (local.get $topics_wa) (local.get $topic_count)))
            (then (br $done)))
          (local.set $contexts_ga (global.get $help_semantic_result_ga))
          (local.set $contexts_wa (global.get $help_semantic_result_wa))
          (local.set $context_count (global.get $help_semantic_result_count))
          (global.set $help_semantic_result_ga (i32.const 0))))

      (local.set $map_internal (call $help_find_internal_literal (i32.const 5)))
      (if (i32.ge_s (local.get $map_internal) (i32.const 0))
        (then
          (if (i32.eqz (call $help_parse_context_map
                (local.get $map_internal) (local.get $topics_wa) (local.get $topic_count)))
            (then (br $done)))
          (local.set $maps_ga (global.get $help_semantic_result_ga))
          (local.set $maps_wa (global.get $help_semantic_result_wa))
          (local.set $map_count (global.get $help_semantic_result_count))
          (global.set $help_semantic_result_ga (i32.const 0))))

      (local.set $phrase_index_internal (call $help_find_internal_literal (i32.const 6)))
      (local.set $phrase_image_internal (call $help_find_internal_literal (i32.const 7)))
      (if (i32.ne
            (i32.ge_s (local.get $phrase_index_internal) (i32.const 0))
            (i32.ge_s (local.get $phrase_image_internal) (i32.const 0)))
        (then
          (call $help_set_error (global.get $HELP_ERROR_MISSING_INTERNAL) (i32.const 0))
          (br $done)))
      (if (i32.ge_s (local.get $phrase_index_internal) (i32.const 0))
        (then
          (if (i32.eqz (call $help_parse_hall_phrases
                (local.get $phrase_index_internal) (local.get $phrase_image_internal)))
            (then (br $done)))
          (local.set $phrase_offsets_ga (global.get $help_phrase_result_offsets_ga))
          (local.set $phrase_offsets_wa (global.get $help_phrase_result_offsets_wa))
          (local.set $phrase_image_ga (global.get $help_phrase_result_image_ga))
          (local.set $phrase_image_wa (global.get $help_phrase_result_image_wa))
          (local.set $phrase_count (global.get $help_phrase_result_count))
          (local.set $phrase_image_size (global.get $help_phrase_result_image_size))
          (local.set $phrase_mode (i32.const 1))
          (global.set $help_phrase_result_offsets_ga (i32.const 0))
          (global.set $help_phrase_result_image_ga (i32.const 0))))
      (if (i32.lt_s (local.get $phrase_index_internal) (i32.const 0))
        (then
          (local.set $old_phrase_internal (call $help_find_internal_literal (i32.const 8)))
          (if (i32.ge_s (local.get $old_phrase_internal) (i32.const 0))
            (then
              (if (i32.eqz (call $help_parse_old_phrases (local.get $old_phrase_internal)))
                (then (br $done)))
              (local.set $phrase_offsets_ga (global.get $help_phrase_result_offsets_ga))
              (local.set $phrase_offsets_wa (global.get $help_phrase_result_offsets_wa))
              (local.set $phrase_image_ga (global.get $help_phrase_result_image_ga))
              (local.set $phrase_image_wa (global.get $help_phrase_result_image_wa))
              (local.set $phrase_count (global.get $help_phrase_result_count))
              (local.set $phrase_image_size (global.get $help_phrase_result_image_size))
              (local.set $phrase_mode (i32.const 2))
              (global.set $help_phrase_result_offsets_ga (i32.const 0))
              (global.set $help_phrase_result_image_ga (i32.const 0))))))

      (local.set $font_internal (call $help_find_internal_literal (i32.const 9)))
      (if (i32.ge_s (local.get $font_internal) (i32.const 0))
        (then
          (if (i32.eqz (call $help_parse_font_table (local.get $font_internal)))
            (then (br $done)))
          (local.set $font_faces_ga (global.get $help_font_result_faces_ga))
          (local.set $font_faces_wa (global.get $help_font_result_faces_wa))
          (local.set $font_face_count (global.get $help_font_result_face_count))
          (local.set $fonts_ga (global.get $help_font_result_fonts_ga))
          (local.set $fonts_wa (global.get $help_font_result_fonts_wa))
          (local.set $font_count (global.get $help_font_result_font_count))
          (local.set $font_metric_mode (global.get $help_font_result_metric_mode))
          (global.set $help_font_result_faces_ga (i32.const 0))
          (global.set $help_font_result_fonts_ga (i32.const 0))))

      (if (i32.eqz (call $help_parse_bitmap_resources))
        (then (br $done)))
      (local.set $bitmaps_ga (global.get $help_bitmap_result_ga))
      (local.set $bitmaps_wa (global.get $help_bitmap_result_wa))
      (local.set $bitmap_count (global.get $help_bitmap_result_count))
      (global.set $help_bitmap_result_ga (i32.const 0))

      (if (i32.eqz (call $help_parse_topic_links
            (local.get $topic_internal) (local.get $topics_wa) (local.get $topic_count)))
        (then (br $done)))

      (global.set $help_doc_topics_ga (local.get $topics_ga))
      (global.set $help_doc_topics_wa (local.get $topics_wa))
      (global.set $help_doc_topic_count (local.get $topic_count))
      (global.set $help_doc_contexts_ga (local.get $contexts_ga))
      (global.set $help_doc_contexts_wa (local.get $contexts_wa))
      (global.set $help_doc_context_count (local.get $context_count))
      (global.set $help_doc_maps_ga (local.get $maps_ga))
      (global.set $help_doc_maps_wa (local.get $maps_wa))
      (global.set $help_doc_map_count (local.get $map_count))
      (global.set $help_doc_phrase_offsets_ga (local.get $phrase_offsets_ga))
      (global.set $help_doc_phrase_offsets_wa (local.get $phrase_offsets_wa))
      (global.set $help_doc_phrase_image_ga (local.get $phrase_image_ga))
      (global.set $help_doc_phrase_image_wa (local.get $phrase_image_wa))
      (global.set $help_doc_phrase_count (local.get $phrase_count))
      (global.set $help_doc_phrase_image_size (local.get $phrase_image_size))
      (global.set $help_doc_phrase_mode (local.get $phrase_mode))
      (global.set $help_doc_font_faces_ga (local.get $font_faces_ga))
      (global.set $help_doc_font_faces_wa (local.get $font_faces_wa))
      (global.set $help_doc_font_face_count (local.get $font_face_count))
      (global.set $help_doc_fonts_ga (local.get $fonts_ga))
      (global.set $help_doc_fonts_wa (local.get $fonts_wa))
      (global.set $help_doc_font_count (local.get $font_count))
      (global.set $help_doc_font_metric_mode (local.get $font_metric_mode))
      (global.set $help_doc_bitmaps_ga (local.get $bitmaps_ga))
      (global.set $help_doc_bitmaps_wa (local.get $bitmaps_wa))
      (global.set $help_doc_bitmap_count (local.get $bitmap_count))
      (global.set $help_doc_keywords_ga (local.get $keywords_ga))
      (global.set $help_doc_keywords_wa (local.get $keywords_wa))
      (global.set $help_doc_keyword_count (local.get $keyword_count))
      (global.set $help_doc_keyword_postings_ga (local.get $postings_ga))
      (global.set $help_doc_keyword_postings_wa (local.get $postings_wa))
      (global.set $help_doc_keyword_posting_count (local.get $posting_count))
      (local.set $ok (i32.const 1)))
    (if (i32.eqz (local.get $ok))
      (then
        (if (local.get $postings_ga) (then (call $heap_free (local.get $postings_ga))))
        (if (local.get $keywords_ga) (then (call $heap_free (local.get $keywords_ga))))
        (if (local.get $maps_ga) (then (call $heap_free (local.get $maps_ga))))
        (if (local.get $phrase_image_ga) (then (call $heap_free (local.get $phrase_image_ga))))
        (if (local.get $phrase_offsets_ga) (then (call $heap_free (local.get $phrase_offsets_ga))))
        (if (local.get $fonts_ga) (then (call $heap_free (local.get $fonts_ga))))
        (if (local.get $font_faces_ga) (then (call $heap_free (local.get $font_faces_ga))))
        (if (local.get $bitmaps_ga) (then (call $heap_free (local.get $bitmaps_ga))))
        (if (local.get $contexts_ga) (then (call $heap_free (local.get $contexts_ga))))
        (if (local.get $topics_ga) (then (call $heap_free (local.get $topics_ga))))))
    (local.get $ok))

  ;; Copy caller bytes before parsing. No caller/guest pointer survives this
  ;; call, which is also the rule used by the future async continuation.
  (func $help_document_load_buffer_core
    (param $source_wa i32) (param $source_size i32) (result i32)
    (local $memory_bytes i32) (local $file_ga i32) (local $meta_ga i32)
    (call $help_document_reset)
    (if (i32.or (i32.eqz (local.get $source_wa)) (i32.eqz (local.get $source_size)))
      (then
        (call $help_set_error (global.get $HELP_ERROR_BAD_ARGUMENT) (i32.const 0))
        (return (i32.const 0))))
    (if (i32.gt_u (local.get $source_size) (global.get $HELP_MAX_FILE_BYTES))
      (then
        (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (i32.const 0))
        (return (i32.const 0))))
    (local.set $memory_bytes (i32.shl (memory.size) (i32.const 16)))
    (if (i32.or
          (i32.gt_u (local.get $source_wa) (local.get $memory_bytes))
          (i32.gt_u (local.get $source_size) (i32.sub (local.get $memory_bytes) (local.get $source_wa))))
      (then
        (call $help_set_error (global.get $HELP_ERROR_BAD_ARGUMENT) (i32.const 0))
        (return (i32.const 0))))
    (local.set $file_ga (call $heap_alloc (local.get $source_size)))
    (if (i32.eqz (local.get $file_ga))
      (then
        (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
        (return (i32.const 0))))
    (global.set $help_doc_file_ga (local.get $file_ga))
    (global.set $help_doc_file_wa (call $g2w (local.get $file_ga)))
    (global.set $help_doc_file_size (local.get $source_size))
    (memory.copy (global.get $help_doc_file_wa) (local.get $source_wa) (local.get $source_size))
    (local.set $meta_ga (call $heap_alloc (i32.const 64)))
    (if (i32.eqz (local.get $meta_ga))
      (then
        (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
        (call $help_document_release_storage)
        (return (i32.const 0))))
    (global.set $help_doc_meta_ga (local.get $meta_ga))
    (global.set $help_doc_meta_wa (call $g2w (local.get $meta_ga)))
    (call $help_slice_init
      (global.get $help_doc_meta_wa) (global.get $help_doc_file_wa)
      (local.get $source_size) (i32.const 0) (local.get $source_size))
    (if (i32.eqz (call $help_parse_directory))
      (then
        (call $help_document_release_storage)
        (return (i32.const 0))))
    (i32.const 1))

  (func $help_document_load_buffer
    (param $source_wa i32) (param $source_size i32) (result i32)
    (if (i32.eqz (call $help_document_load_buffer_core
          (local.get $source_wa) (local.get $source_size)))
      (then (return (i32.const 0))))
    (if (i32.eqz (call $help_parse_semantic_indexes))
      (then
        (call $help_document_release_storage)
        (return (i32.const 0))))
    (i32.const 1))

  ;; Load an already-mounted help file through the ordinary VFS boundary.
  ;; The host supplies only file bytes; parsing and ownership stay in WAT.
  (func $help_document_load_vfs
    (param $path_wa i32) (result i32)
    (local $handle i32) (local $size i32)
    (local $temp_ga i32) (local $temp_wa i32)
    (local $read_ga i32) (local $read_wa i32) (local $ok i32)
    (if (i32.eqz (local.get $path_wa))
      (then
        (call $help_document_reset)
        (call $help_set_error (global.get $HELP_ERROR_BAD_ARGUMENT) (i32.const 0))
        (return (i32.const 0))))
    (local.set $handle (call $host_fs_create_file
      (local.get $path_wa) (i32.const 0x80000000)
      (i32.const 3) (i32.const 0x80) (i32.const 0)))
    (if (i32.eq (local.get $handle) (i32.const -1))
      (then
        (call $help_document_reset)
        (call $help_set_error (global.get $HELP_ERROR_VFS) (i32.const 0))
        (return (i32.const 0))))
    (local.set $size (call $host_fs_get_file_size (local.get $handle)))
    (if (i32.or
          (i32.eq (local.get $size) (i32.const -1))
          (i32.eqz (local.get $size)))
      (then
        (drop (call $host_fs_close_handle (local.get $handle)))
        (call $help_document_reset)
        (call $help_set_error (global.get $HELP_ERROR_VFS) (i32.const 0))
        (return (i32.const 0))))
    (if (i32.gt_u (local.get $size) (global.get $HELP_MAX_FILE_BYTES))
      (then
        (drop (call $host_fs_close_handle (local.get $handle)))
        (call $help_document_reset)
        (call $help_set_error (global.get $HELP_ERROR_CAPACITY) (i32.const 0))
        (return (i32.const 0))))
    (local.set $temp_ga (call $heap_alloc (local.get $size)))
    (local.set $read_ga (call $heap_alloc (i32.const 4)))
    (if (i32.or (i32.eqz (local.get $temp_ga)) (i32.eqz (local.get $read_ga)))
      (then
        (drop (call $host_fs_close_handle (local.get $handle)))
        (if (local.get $temp_ga) (then (call $heap_free (local.get $temp_ga))))
        (if (local.get $read_ga) (then (call $heap_free (local.get $read_ga))))
        (call $help_document_reset)
        (call $help_set_error (global.get $HELP_ERROR_ALLOCATION) (i32.const 0))
        (return (i32.const 0))))
    (local.set $temp_wa (call $g2w (local.get $temp_ga)))
    (local.set $read_wa (call $g2w (local.get $read_ga)))
    (i32.store (local.get $read_wa) (i32.const 0))
    (local.set $ok (call $host_fs_read_file
      (local.get $handle) (local.get $temp_ga) (local.get $size) (local.get $read_ga)))
    (drop (call $host_fs_close_handle (local.get $handle)))
    (if (i32.or
          (i32.eqz (local.get $ok))
          (i32.ne (i32.load (local.get $read_wa)) (local.get $size)))
      (then
        (call $heap_free (local.get $read_ga))
        (call $heap_free (local.get $temp_ga))
        (call $help_document_reset)
        (call $help_set_error (global.get $HELP_ERROR_VFS) (i32.const 0))
        (return (i32.const 0))))
    (local.set $ok (call $help_document_load_buffer (local.get $temp_wa) (local.get $size)))
    (call $heap_free (local.get $read_ga))
    (call $heap_free (local.get $temp_ga))
    (local.get $ok))

  ;; Unified API engine. The A/W boundary owns normalization; path_wa and any
  ;; command-specific string data are bounded WA pointers by the time they
  ;; reach this function. source_is_wide remains part of the stable call shape
  ;; so both entry points can be audited through the same path.
  (func $help_dispatch
    (param $caller i32) (param $path_wa i32) (param $command i32)
    (param $data i32) (param $source_is_wide i32) (result i32)
    (drop (local.get $source_is_wide))
    (if (i32.eq (local.get $command) (global.get $HELP_COMMAND_QUIT))
      (then
        (return (call $help_dispatch_loaded
          (local.get $caller) (local.get $command) (local.get $data)))))
    (if (local.get $path_wa)
      (then
        (if (i32.eqz (call $help_document_load_vfs (local.get $path_wa)))
          (then
            (global.set $help_session_last_command (local.get $command))
            (global.set $help_session_status (global.get $HELP_DISPATCH_LOAD_FAILED))
            (return (i32.const 0))))))
    (call $help_dispatch_loaded
      (local.get $caller) (local.get $command) (local.get $data)))

  (func (export "test_help_load_buffer")
    (param $source_wa i32) (param $source_size i32) (result i32)
    (call $help_document_load_buffer (local.get $source_wa) (local.get $source_size)))
  (func (export "test_help_load_directory_buffer")
    (param $source_wa i32) (param $source_size i32) (result i32)
    (call $help_document_load_buffer_core (local.get $source_wa) (local.get $source_size)))
  (func (export "test_help_load_vfs") (param $path_wa i32) (result i32)
    (call $help_document_load_vfs (local.get $path_wa)))
  (func (export "test_help_dispatch")
    (param $caller i32) (param $path_wa i32) (param $command i32)
    (param $data i32) (param $source_is_wide i32) (result i32)
    (call $help_dispatch
      (local.get $caller) (local.get $path_wa) (local.get $command)
      (local.get $data) (local.get $source_is_wide)))
  (func (export "test_help_decode_bitmap")
    (param $bitmap_index i32) (param $out_wa i32) (param $capacity i32) (result i32)
    (call $help_decode_bitmap
      (local.get $bitmap_index) (local.get $out_wa) (local.get $capacity)))
  (func (export "test_help_decode_topic_raw")
    (param $topic_index i32) (param $out_wa i32) (param $capacity i32) (result i32)
    (call $help_decode_topic_raw
      (local.get $topic_index) (local.get $out_wa) (local.get $capacity)))
  (func (export "test_help_decode_topic_strings")
    (param $topic_index i32) (param $raw_out i32) (param $raw_capacity i32)
    (param $tokens_out i32) (param $token_capacity i32) (result i32)
    (call $help_decode_topic_strings
      (local.get $topic_index) (local.get $raw_out) (local.get $raw_capacity)
      (local.get $tokens_out) (local.get $token_capacity)))
  (func (export "test_help_decode_topic_formatted")
    (param $topic_index i32) (param $raw_out i32) (param $raw_capacity i32)
    (param $tokens_out i32) (param $token_capacity i32)
    (param $payload_out i32) (param $payload_capacity i32) (result i32)
    (call $help_decode_topic_formatted
      (local.get $topic_index) (local.get $raw_out) (local.get $raw_capacity)
      (local.get $tokens_out) (local.get $token_capacity)
      (local.get $payload_out) (local.get $payload_capacity)))
  (func (export "get_help_formatted_payload_size") (result i32)
    (global.get $help_fmt_payload_used))
