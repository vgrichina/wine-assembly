  ;; ---- WAT-native WinHelp document core ------------------------------
  ;;
  ;; This is the first migration slice away from the semantic JS HLP
  ;; parser.  The canonical file bytes and directory index are WAT-owned.
  ;; UI cutover happens only after the remaining topic parsers are ready.

  (global $HELP_MAX_FILE_BYTES i32 (i32.const 0x02000000))
  (global $HELP_MAX_DIRECTORY_ENTRIES i32 (i32.const 4096))
  (global $HELP_MAX_BTREE_DEPTH i32 (i32.const 16))
  (global $HELP_MAX_BTREE_PAGES i32 (i32.const 65536))
  (global $HELP_MAX_TOPICS i32 (i32.const 65536))

  ;; Stable parser errors. Keep the first failure and its file offset.
  (global $HELP_ERROR_NONE i32 (i32.const 0))
  (global $HELP_ERROR_BAD_ARGUMENT i32 (i32.const 1))
  (global $HELP_ERROR_ALLOCATION i32 (i32.const 2))
  (global $HELP_ERROR_BAD_OUTER_HEADER i32 (i32.const 3))
  (global $HELP_ERROR_BAD_FILE_HEADER i32 (i32.const 4))
  (global $HELP_ERROR_DIRECTORY_BTREE i32 (i32.const 5))
  (global $HELP_ERROR_CAPACITY i32 (i32.const 6))
  (global $HELP_ERROR_VFS i32 (i32.const 7))
  (global $HELP_ERROR_MISSING_INTERNAL i32 (i32.const 8))
  (global $HELP_ERROR_SYSTEM i32 (i32.const 9))
  (global $HELP_ERROR_TOPIC_INDEX i32 (i32.const 10))
  (global $HELP_ERROR_CONTEXT_INDEX i32 (i32.const 11))

  ;; HelpDocument storage. Guest pointers are retained for HeapFree; the
  ;; corresponding WA pointers are used by the parser and test inspection.
  (global $help_doc_file_ga (mut i32) (i32.const 0))
  (global $help_doc_file_wa (mut i32) (i32.const 0))
  (global $help_doc_file_size (mut i32) (i32.const 0))
  (global $help_doc_meta_ga (mut i32) (i32.const 0))
  (global $help_doc_meta_wa (mut i32) (i32.const 0))
  (global $help_doc_directory_ga (mut i32) (i32.const 0))
  (global $help_doc_directory_wa (mut i32) (i32.const 0))
  (global $help_doc_directory_count (mut i32) (i32.const 0))
  (global $help_doc_topics_ga (mut i32) (i32.const 0))
  (global $help_doc_topics_wa (mut i32) (i32.const 0))
  (global $help_doc_topic_count (mut i32) (i32.const 0))
  (global $help_doc_contexts_ga (mut i32) (i32.const 0))
  (global $help_doc_contexts_wa (mut i32) (i32.const 0))
  (global $help_doc_context_count (mut i32) (i32.const 0))
  (global $help_doc_maps_ga (mut i32) (i32.const 0))
  (global $help_doc_maps_wa (mut i32) (i32.const 0))
  (global $help_doc_map_count (mut i32) (i32.const 0))
  (global $help_doc_system_minor (mut i32) (i32.const 0))
  (global $help_doc_system_major (mut i32) (i32.const 0))
  (global $help_doc_system_flags (mut i32) (i32.const 0))
  (global $help_doc_system_date (mut i32) (i32.const 0))
  (global $help_doc_title_off (mut i32) (i32.const 0))
  (global $help_doc_title_len (mut i32) (i32.const 0))
  (global $help_doc_contents_ref (mut i32) (i32.const -1))
  (global $help_doc_cnt_off (mut i32) (i32.const 0))
  (global $help_doc_cnt_len (mut i32) (i32.const 0))
  (global $help_last_error (mut i32) (i32.const 0))
  (global $help_last_error_offset (mut i32) (i32.const 0))

  ;; HelpInternalFile is 20 bytes:
  ;;   hash:u32, name_off:u32, name_len:u16, flags:u16,
  ;;   data_off:u32, data_len:u32.
  (global $HELP_INTERNAL_FILE_SIZE i32 (i32.const 20))

  ;; HelpTopic is 32 bytes:
  ;;   topic_ref, topic_record_off, title_off, title_len, context_hash,
  ;;   browse_prev_ref, browse_next_ref, flags.
  ;; Context hash and numeric-map records are both {key:u32, topic_ref:u32}.
  (global $HELP_TOPIC_SIZE i32 (i32.const 32))
  (global $HELP_CONTEXT_SIZE i32 (i32.const 8))
  (global $HELP_TOPIC_HAS_CONTEXT i32 (i32.const 1))

  ;; HelpSlice is 16 bytes:
  ;;   base_wa:u32, file_size:u32, offset:u32, length:u32.
  ;; The document metadata owns a root slice at +0 and page scratch at +16.
  (func $help_set_error (param $code i32) (param $file_off i32)
    (if (i32.eqz (global.get $help_last_error))
      (then
        (global.set $help_last_error (local.get $code))
        (global.set $help_last_error_offset (local.get $file_off)))))

  (func $help_document_release_storage
    (if (global.get $help_doc_maps_ga)
      (then (call $heap_free (global.get $help_doc_maps_ga))))
    (if (global.get $help_doc_contexts_ga)
      (then (call $heap_free (global.get $help_doc_contexts_ga))))
    (if (global.get $help_doc_topics_ga)
      (then (call $heap_free (global.get $help_doc_topics_ga))))
    (if (global.get $help_doc_directory_ga)
      (then (call $heap_free (global.get $help_doc_directory_ga))))
    (if (global.get $help_doc_meta_ga)
      (then (call $heap_free (global.get $help_doc_meta_ga))))
    (if (global.get $help_doc_file_ga)
      (then (call $heap_free (global.get $help_doc_file_ga))))
    (global.set $help_doc_file_ga (i32.const 0))
    (global.set $help_doc_file_wa (i32.const 0))
    (global.set $help_doc_file_size (i32.const 0))
    (global.set $help_doc_meta_ga (i32.const 0))
    (global.set $help_doc_meta_wa (i32.const 0))
    (global.set $help_doc_directory_ga (i32.const 0))
    (global.set $help_doc_directory_wa (i32.const 0))
    (global.set $help_doc_directory_count (i32.const 0))
    (global.set $help_doc_topics_ga (i32.const 0))
    (global.set $help_doc_topics_wa (i32.const 0))
    (global.set $help_doc_topic_count (i32.const 0))
    (global.set $help_doc_contexts_ga (i32.const 0))
    (global.set $help_doc_contexts_wa (i32.const 0))
    (global.set $help_doc_context_count (i32.const 0))
    (global.set $help_doc_maps_ga (i32.const 0))
    (global.set $help_doc_maps_wa (i32.const 0))
    (global.set $help_doc_map_count (i32.const 0))
    (global.set $help_doc_system_minor (i32.const 0))
    (global.set $help_doc_system_major (i32.const 0))
    (global.set $help_doc_system_flags (i32.const 0))
    (global.set $help_doc_system_date (i32.const 0))
    (global.set $help_doc_title_off (i32.const 0))
    (global.set $help_doc_title_len (i32.const 0))
    (global.set $help_doc_contents_ref (i32.const -1))
    (global.set $help_doc_cnt_off (i32.const 0))
    (global.set $help_doc_cnt_len (i32.const 0)))

  (func $help_document_reset
    (call $help_document_release_storage)
    (global.set $help_last_error (i32.const 0))
    (global.set $help_last_error_offset (i32.const 0)))

  (func $help_slice_init
    (param $slice i32) (param $base i32) (param $file_size i32)
    (param $offset i32) (param $length i32)
    (i32.store (local.get $slice) (local.get $base))
    (i32.store offset=4 (local.get $slice) (local.get $file_size))
    (i32.store offset=8 (local.get $slice) (local.get $offset))
    (i32.store offset=12 (local.get $slice) (local.get $length)))

  ;; Return the bounded WA address or zero. Subtraction-based checks avoid
  ;; overflow in offset+length and relative_offset+width.
  (func $help_slice_address
    (param $slice i32) (param $relative_offset i32) (param $width i32)
    (result i32)
    (local $base i32) (local $file_size i32) (local $offset i32) (local $length i32)
    (local.set $base (i32.load (local.get $slice)))
    (local.set $file_size (i32.load offset=4 (local.get $slice)))
    (local.set $offset (i32.load offset=8 (local.get $slice)))
    (local.set $length (i32.load offset=12 (local.get $slice)))
    (if (i32.gt_u (local.get $offset) (local.get $file_size))
      (then (return (i32.const 0))))
    (if (i32.gt_u (local.get $length) (i32.sub (local.get $file_size) (local.get $offset)))
      (then (return (i32.const 0))))
    (if (i32.gt_u (local.get $relative_offset) (local.get $length))
      (then (return (i32.const 0))))
    (if (i32.gt_u (local.get $width) (i32.sub (local.get $length) (local.get $relative_offset)))
      (then (return (i32.const 0))))
    (if (i32.gt_u (local.get $offset) (i32.sub (i32.const -1) (local.get $relative_offset)))
      (then (return (i32.const 0))))
    (if (i32.gt_u (local.get $base)
          (i32.sub (i32.const -1) (i32.add (local.get $offset) (local.get $relative_offset))))
      (then (return (i32.const 0))))
    (i32.add (local.get $base) (i32.add (local.get $offset) (local.get $relative_offset))))

  (func $help_subslice
    (param $slice i32) (param $relative_offset i32) (param $length i32)
    (param $out_slice i32) (result i32)
    (if (i32.eqz (call $help_slice_address
          (local.get $slice) (local.get $relative_offset) (local.get $length)))
      (then (return (i32.const 0))))
    (call $help_slice_init
      (local.get $out_slice)
      (i32.load (local.get $slice))
      (i32.load offset=4 (local.get $slice))
      (i32.add (i32.load offset=8 (local.get $slice)) (local.get $relative_offset))
      (local.get $length))
    (i32.const 1))

  ;; Return a bounded C-string length, or -1 if no terminator occurs inside
  ;; both max_length and the current slice.
  (func $help_read_cstring_length
    (param $slice i32) (param $relative_offset i32) (param $max_length i32)
    (result i32)
    (local $i i32) (local $p i32)
    (if (i32.eqz (local.get $max_length)) (then (return (i32.const -1))))
    (block $done (loop $scan
      (if (i32.ge_u (local.get $i) (local.get $max_length))
        (then (return (i32.const -1))))
      (local.set $p (call $help_slice_address
        (local.get $slice) (i32.add (local.get $relative_offset) (local.get $i)) (i32.const 1)))
      (if (i32.eqz (local.get $p)) (then (return (i32.const -1))))
      (br_if $done (i32.eqz (i32.load8_u (local.get $p))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $i))

  (func $help_hash_bytes (param $wa i32) (param $length i32) (result i32)
    (local $i i32) (local $hash i32)
    (local.set $hash (i32.const 0x811C9DC5))
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (local.get $length)))
      (local.set $hash
        (i32.mul
          (i32.xor (local.get $hash) (i32.load8_u (i32.add (local.get $wa) (local.get $i))))
          (i32.const 0x01000193)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (local.get $hash))

  (func $help_bytes_equal
    (param $a i32) (param $b i32) (param $length i32) (result i32)
    (local $i i32)
    (block $equal (loop $loop
      (br_if $equal (i32.ge_u (local.get $i) (local.get $length)))
      (if (i32.ne
            (i32.load8_u (i32.add (local.get $a) (local.get $i)))
            (i32.load8_u (i32.add (local.get $b) (local.get $i))))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (i32.const 1))

  ;; Lexicographic byte comparison used to ensure the published directory is
  ;; strictly sorted and contains no duplicate names.
  (func $help_bytes_compare
    (param $a i32) (param $alen i32) (param $b i32) (param $blen i32)
    (result i32)
    (local $i i32) (local $limit i32) (local $av i32) (local $bv i32)
    (local.set $limit (local.get $alen))
    (if (i32.lt_u (local.get $blen) (local.get $limit))
      (then (local.set $limit (local.get $blen))))
    (block $same_prefix (loop $loop
      (br_if $same_prefix (i32.ge_u (local.get $i) (local.get $limit)))
      (local.set $av (i32.load8_u (i32.add (local.get $a) (local.get $i))))
      (local.set $bv (i32.load8_u (i32.add (local.get $b) (local.get $i))))
      (if (i32.lt_u (local.get $av) (local.get $bv)) (then (return (i32.const -1))))
      (if (i32.gt_u (local.get $av) (local.get $bv)) (then (return (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (if (i32.lt_u (local.get $alen) (local.get $blen)) (then (return (i32.const -1))))
    (if (i32.gt_u (local.get $alen) (local.get $blen)) (then (return (i32.const 1))))
    (i32.const 0))

  ;; Lookup always verifies hash, length, and bytes. Hash collisions cannot
  ;; select an unrelated internal file.
  (func $help_find_internal_file
    (param $name_wa i32) (param $name_length i32) (result i32)
    (local $hash i32) (local $i i32) (local $rec i32) (local $stored_len i32)
    (if (i32.or (i32.eqz (local.get $name_wa)) (i32.gt_u (local.get $name_length) (i32.const 255)))
      (then (return (i32.const -1))))
    (local.set $hash (call $help_hash_bytes (local.get $name_wa) (local.get $name_length)))
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (global.get $help_doc_directory_count)))
      (local.set $rec (i32.add (global.get $help_doc_directory_wa)
        (i32.mul (local.get $i) (global.get $HELP_INTERNAL_FILE_SIZE))))
      (local.set $stored_len (i32.load16_u offset=8 (local.get $rec)))
      (if (i32.and
            (i32.and
              (i32.eq (i32.load (local.get $rec)) (local.get $hash))
              (i32.eq (local.get $stored_len) (local.get $name_length)))
            (call $help_bytes_equal
              (local.get $name_wa)
              (i32.add (global.get $help_doc_file_wa) (i32.load offset=4 (local.get $rec)))
              (local.get $name_length)))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (i32.const -1))

  ;; Resolve the fixed semantic internal files without reserving another
  ;; low-memory string table. The document metadata has sixteen bytes of
  ;; parser scratch beginning at +32.
  (func $help_find_internal_literal (param $kind i32) (result i32)
    (local $scratch i32) (local $length i32)
    (local.set $scratch (i32.add (global.get $help_doc_meta_wa) (i32.const 32)))
    (memory.fill (local.get $scratch) (i32.const 0) (i32.const 16))
    (if (i32.eq (local.get $kind) (i32.const 1))
      (then
        (i64.store (local.get $scratch) (i64.const 0x004D45545359537C))
        (local.set $length (i32.const 7)))
      (else (if (i32.eq (local.get $kind) (i32.const 2))
        (then
          (i64.store (local.get $scratch) (i64.const 0x00004349504F547C))
          (local.set $length (i32.const 6)))
        (else (if (i32.eq (local.get $kind) (i32.const 3))
          (then
            (i64.store (local.get $scratch) (i64.const 0x455254424C54547C))
            (i32.store8 offset=8 (local.get $scratch) (i32.const 0x45))
            (local.set $length (i32.const 9)))
          (else (if (i32.eq (local.get $kind) (i32.const 4))
            (then
              (i64.store (local.get $scratch) (i64.const 0x545845544E4F437C))
              (local.set $length (i32.const 8)))
            (else (if (i32.eq (local.get $kind) (i32.const 5))
              (then
                (i64.store (local.get $scratch) (i64.const 0x50414D4F5854437C))
                (local.set $length (i32.const 8)))
              (else (return (i32.const -1))))))))))))
    (call $help_find_internal_file (local.get $scratch) (local.get $length)))

  (func $help_find_topic_index_in
    (param $topics_wa i32) (param $count i32) (param $topic_ref i32)
    (result i32)
    (local $lo i32) (local $hi i32) (local $mid i32) (local $value i32)
    (local.set $hi (local.get $count))
    (block $missing (loop $search
      (br_if $missing (i32.ge_u (local.get $lo) (local.get $hi)))
      (local.set $mid
        (i32.add (local.get $lo)
          (i32.shr_u (i32.sub (local.get $hi) (local.get $lo)) (i32.const 1))))
      (local.set $value
        (i32.load (i32.add (local.get $topics_wa)
          (i32.mul (local.get $mid) (global.get $HELP_TOPIC_SIZE)))))
      (if (i32.eq (local.get $value) (local.get $topic_ref))
        (then (return (local.get $mid))))
      (if (i32.lt_u (local.get $value) (local.get $topic_ref))
        (then (local.set $lo (i32.add (local.get $mid) (i32.const 1))))
        (else (local.set $hi (local.get $mid))))
      (br $search)))
    (i32.const -1))

  ;; Focused parser/inspection exports. They expose immutable WAT-owned
  ;; records and never introduce an alternate host semantic path.
  (func (export "test_help_reset") (call $help_document_reset))
  (func (export "get_help_last_error") (result i32) (global.get $help_last_error))
  (func (export "get_help_last_error_offset") (result i32) (global.get $help_last_error_offset))
  (func (export "get_help_file_ptr") (result i32) (global.get $help_doc_file_wa))
  (func (export "get_help_file_size") (result i32) (global.get $help_doc_file_size))
  (func (export "get_help_directory_count") (result i32) (global.get $help_doc_directory_count))
  (func (export "get_help_directory_record") (param $index i32) (result i32)
    (if (i32.ge_u (local.get $index) (global.get $help_doc_directory_count))
      (then (return (i32.const 0))))
    (i32.add (global.get $help_doc_directory_wa)
      (i32.mul (local.get $index) (global.get $HELP_INTERNAL_FILE_SIZE))))
  (func (export "test_help_find_internal")
    (param $name_wa i32) (param $name_length i32) (result i32)
    (call $help_find_internal_file (local.get $name_wa) (local.get $name_length)))
  (func (export "get_help_system_minor") (result i32) (global.get $help_doc_system_minor))
  (func (export "get_help_system_major") (result i32) (global.get $help_doc_system_major))
  (func (export "get_help_system_flags") (result i32) (global.get $help_doc_system_flags))
  (func (export "get_help_system_date") (result i32) (global.get $help_doc_system_date))
  (func (export "get_help_title_ptr") (result i32)
    (if (result i32) (global.get $help_doc_title_off)
      (then (i32.add (global.get $help_doc_file_wa) (global.get $help_doc_title_off)))
      (else (i32.const 0))))
  (func (export "get_help_title_len") (result i32) (global.get $help_doc_title_len))
  (func (export "get_help_contents_ref") (result i32) (global.get $help_doc_contents_ref))
  (func (export "get_help_cnt_ptr") (result i32)
    (if (result i32) (global.get $help_doc_cnt_off)
      (then (i32.add (global.get $help_doc_file_wa) (global.get $help_doc_cnt_off)))
      (else (i32.const 0))))
  (func (export "get_help_cnt_len") (result i32) (global.get $help_doc_cnt_len))
  (func (export "get_help_topic_count") (result i32) (global.get $help_doc_topic_count))
  (func (export "get_help_topic_record") (param $index i32) (result i32)
    (if (i32.ge_u (local.get $index) (global.get $help_doc_topic_count))
      (then (return (i32.const 0))))
    (i32.add (global.get $help_doc_topics_wa)
      (i32.mul (local.get $index) (global.get $HELP_TOPIC_SIZE))))
  (func (export "get_help_context_count") (result i32) (global.get $help_doc_context_count))
  (func (export "get_help_context_record") (param $index i32) (result i32)
    (if (i32.ge_u (local.get $index) (global.get $help_doc_context_count))
      (then (return (i32.const 0))))
    (i32.add (global.get $help_doc_contexts_wa)
      (i32.mul (local.get $index) (global.get $HELP_CONTEXT_SIZE))))
  (func (export "get_help_map_count") (result i32) (global.get $help_doc_map_count))
  (func (export "get_help_map_record") (param $index i32) (result i32)
    (if (i32.ge_u (local.get $index) (global.get $help_doc_map_count))
      (then (return (i32.const 0))))
    (i32.add (global.get $help_doc_maps_wa)
      (i32.mul (local.get $index) (global.get $HELP_CONTEXT_SIZE))))
  (func (export "test_help_resolve_context_id") (param $map_id i32) (result i32)
    (local $i i32) (local $record i32)
    (block $missing (loop $scan
      (br_if $missing (i32.ge_u (local.get $i) (global.get $help_doc_map_count)))
      (local.set $record (i32.add (global.get $help_doc_maps_wa)
        (i32.mul (local.get $i) (global.get $HELP_CONTEXT_SIZE))))
      (if (i32.eq (i32.load (local.get $record)) (local.get $map_id))
        (then (return (i32.load offset=4 (local.get $record)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))
  (func (export "test_help_resolve_context_hash") (param $hash i32) (result i32)
    (local $lo i32) (local $hi i32) (local $mid i32)
    (local $record i32) (local $value i32)
    (local.set $hi (global.get $help_doc_context_count))
    (block $missing (loop $search
      (br_if $missing (i32.ge_u (local.get $lo) (local.get $hi)))
      (local.set $mid
        (i32.add (local.get $lo)
          (i32.shr_u (i32.sub (local.get $hi) (local.get $lo)) (i32.const 1))))
      (local.set $record (i32.add (global.get $help_doc_contexts_wa)
        (i32.mul (local.get $mid) (global.get $HELP_CONTEXT_SIZE))))
      (local.set $value (i32.load (local.get $record)))
      (if (i32.eq (local.get $value) (local.get $hash))
        (then (return (i32.load offset=4 (local.get $record)))))
      (if (i32.lt_s (local.get $value) (local.get $hash))
        (then (local.set $lo (i32.add (local.get $mid) (i32.const 1))))
        (else (local.set $hi (local.get $mid))))
      (br $search)))
    (i32.const -1))
