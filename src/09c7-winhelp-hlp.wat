  ;; ---- Bounded HLP outer-file and directory B+tree parser ------------

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

  ;; Copy caller bytes before parsing. No caller/guest pointer survives this
  ;; call, which is also the rule used by the future async continuation.
  (func $help_document_load_buffer
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
    (local.set $meta_ga (call $heap_alloc (i32.const 32)))
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

  (func (export "test_help_load_buffer")
    (param $source_wa i32) (param $source_size i32) (result i32)
    (call $help_document_load_buffer (local.get $source_wa) (local.get $source_size)))
  (func (export "test_help_load_vfs") (param $path_wa i32) (result i32)
    (call $help_document_load_vfs (local.get $path_wa)))
