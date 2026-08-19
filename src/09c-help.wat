  ;; ============================================================
  ;; WINDOW TABLE + HELP SYSTEM
  ;; ============================================================
  ;; WND_RECORDS at WASM 0x7000: 256 entries × 24 bytes (ends 0x8800).
  ;; Each record:
  ;;   +0   hwnd       (0 = empty slot)
  ;;   +4   wndproc    (guest VA, or 0xFFFFxxxx for WAT-native)
  ;;   +8   parent     (parent hwnd, 0 if top-level)
  ;;   +12  userdata   (GWL_USERDATA)
  ;;   +16  style
  ;;   +20  state_ptr  (heap ptr to per-class WndState, 0 if none)
  ;;
  ;; Class records at WASM 0xA000: 64 entries × 48 bytes (ends 0xAC00).
  ;; Each entry: [name_hash:i32, atom:i32, WNDCLASSA[40]]
  ;; lpfnWndProc lives at record+12 (offset 4 inside the embedded WNDCLASSA).
  ;; Both bases / counts are defined in 01-header.wat — see the memory map.

  ;; ---- Window record helpers ----

;; ---- Help system ----

  (func $help_command_data_is_pointer (param $command i32) (result i32)
    (i32.or
      (i32.or
        (i32.eq (local.get $command) (global.get $HELP_COMMAND_CONTEXTMENU))
        (i32.eq (local.get $command) (global.get $HELP_COMMAND_WM_HELP)))
      (i32.or
        (i32.or
          (i32.eq (local.get $command) (global.get $HELP_COMMAND_KEY))
          (i32.eq (local.get $command) (global.get $HELP_COMMAND_MACRO)))
        (i32.or
          (i32.or
            (i32.eq (local.get $command) (global.get $HELP_COMMAND_PARTIALKEY))
            (i32.eq (local.get $command) (global.get $HELP_COMMAND_MULTIKEY)))
          (i32.eq (local.get $command) (global.get $HELP_COMMAND_SETWINPOS))))))

  (func $help_command_data_is_string (param $command i32) (result i32)
    (i32.or
      (i32.or
        (i32.eq (local.get $command) (global.get $HELP_COMMAND_KEY))
        (i32.eq (local.get $command) (global.get $HELP_COMMAND_MACRO)))
      (i32.eq (local.get $command) (global.get $HELP_COMMAND_PARTIALKEY))))

  ;; Return an owned guest ANSI copy of a bounded UTF-16 guest string. The
  ;; caller frees it after synchronous dispatch. Zero means invalid/capacity or
  ;; allocation failure; an empty string still owns a one-byte allocation.
  (func $help_wide_string_to_ansi_heap
    (param $source_ga i32) (param $limit i32) (result i32)
    (local $length i32) (local $copy_ga i32) (local $ch i32)
    (if (i32.eqz (local.get $source_ga)) (then (return (i32.const 0))))
    (block $terminated (loop $scan
      (if (i32.ge_u (local.get $length) (local.get $limit))
        (then (return (i32.const 0))))
      (local.set $ch (call $gl16 (i32.add (local.get $source_ga)
        (i32.shl (local.get $length) (i32.const 1)))))
      (br_if $terminated (i32.eqz (local.get $ch)))
      (local.set $length (i32.add (local.get $length) (i32.const 1)))
      (br $scan)))
    (local.set $copy_ga (call $heap_alloc (i32.add (local.get $length) (i32.const 1))))
    (if (i32.eqz (local.get $copy_ga)) (then (return (i32.const 0))))
    (drop (call $wide_to_ansi
      (local.get $source_ga) (local.get $copy_ga)
      (i32.add (local.get $length) (i32.const 1))))
    (local.get $copy_ga))

  (func $help_dispatch_api_a
    (param $caller i32) (param $path_ga i32) (param $command i32)
    (param $data i32) (result i32)
    (local $path_wa i32) (local $data_wa i32)
    (if (i32.and (i32.ne (local.get $path_ga) (i32.const 0))
          (i32.ne (local.get $command) (global.get $HELP_COMMAND_QUIT)))
      (then (local.set $path_wa (call $g2w (local.get $path_ga)))))
    (local.set $data_wa (local.get $data))
    (if (i32.and (i32.ne (local.get $data) (i32.const 0))
          (call $help_command_data_is_pointer (local.get $command)))
      (then (local.set $data_wa (call $g2w (local.get $data)))))
    (call $help_dispatch
      (local.get $caller) (local.get $path_wa) (local.get $command)
      (local.get $data_wa) (i32.const 0)))

  (func $help_dispatch_api_w
    (param $caller i32) (param $path_ga i32) (param $command i32)
    (param $data i32) (result i32)
    (local $path_copy_ga i32) (local $data_copy_ga i32)
    (local $path_wa i32) (local $data_wa i32) (local $result i32)
    (if (i32.and (i32.ne (local.get $path_ga) (i32.const 0))
          (i32.ne (local.get $command) (global.get $HELP_COMMAND_QUIT)))
      (then
        (local.set $path_copy_ga (call $help_wide_string_to_ansi_heap
          (local.get $path_ga) (i32.const 1024)))
        (if (i32.eqz (local.get $path_copy_ga))
          (then
            (global.set $help_session_last_command (local.get $command))
            (global.set $help_session_status (global.get $HELP_DISPATCH_BAD_DATA))
            (return (i32.const 0))))
        (local.set $path_wa (call $g2w (local.get $path_copy_ga)))
        ;; Finish the synchronous path load before allocating command-string
        ;; storage. Document replacement releases prior heap blocks and must
        ;; not overlap either normalization buffer's lifetime.
        (call $help_document_snapshot_release_all)
        (if (i32.eqz (call $help_document_load_vfs (local.get $path_wa)))
          (then
            (call $heap_free (local.get $path_copy_ga))
            (global.set $help_session_last_command (local.get $command))
            (global.set $help_session_status (global.get $HELP_DISPATCH_LOAD_FAILED))
            (return (i32.const 0))))
        (call $heap_free (local.get $path_copy_ga))
        (local.set $path_copy_ga (i32.const 0))
        (local.set $path_wa (i32.const 0))))
    (local.set $data_wa (local.get $data))
    (if (i32.and (i32.ne (local.get $data) (i32.const 0))
          (call $help_command_data_is_string (local.get $command)))
      (then
        (local.set $data_copy_ga (call $help_wide_string_to_ansi_heap
          (local.get $data) (i32.const 512)))
        (if (i32.eqz (local.get $data_copy_ga))
          (then
            (if (local.get $path_copy_ga)
              (then (call $heap_free (local.get $path_copy_ga))))
            (global.set $help_session_last_command (local.get $command))
            (global.set $help_session_status (global.get $HELP_DISPATCH_BAD_DATA))
            (return (i32.const 0))))
        (local.set $data_wa (call $g2w (local.get $data_copy_ga))))
      (else
        (if (i32.and (i32.ne (local.get $data) (i32.const 0))
              (call $help_command_data_is_pointer (local.get $command)))
          (then (local.set $data_wa (call $g2w (local.get $data)))))))
    (local.set $result (call $help_dispatch
      (local.get $caller) (local.get $path_wa) (local.get $command)
      (local.get $data_wa) (i32.const 1)))
    (if (local.get $data_copy_ga) (then (call $heap_free (local.get $data_copy_ga))))
    (if (local.get $path_copy_ga) (then (call $heap_free (local.get $path_copy_ga))))
    (local.get $result))

  ;; Decode and publish the canonical formatted topic and positioned run list.
  ;; The typed-view builder retains the prior visible arenas until the complete
  ;; decode/tokenize/layout transaction succeeds.
  (func $help_prepare_wat_view_for
    (param $layout_width i32) (param $target_hwnd i32) (result i32)
    (local $copy_length i32) (local $title_ga i32) (local $stack_ga i32)
    (if (i32.lt_s (global.get $help_session_topic_index) (i32.const 0))
      (then (return (i32.const 0))))
    (if (i32.eqz (global.get $help_title_wa))
      (then
        (local.set $title_ga (call $heap_alloc (i32.const 256)))
        (if (i32.eqz (local.get $title_ga)) (then (return (i32.const 0))))
        (global.set $help_title_wa (call $g2w (local.get $title_ga)))))
    (if (i32.eqz (global.get $help_back_stack))
      (then
        (local.set $stack_ga (call $heap_alloc (i32.const 64)))
        (if (i32.eqz (local.get $stack_ga)) (then (return (i32.const 0))))
        (global.set $help_back_stack (call $g2w (local.get $stack_ga)))))
    (local.set $copy_length (global.get $help_doc_title_len))
    (if (i32.gt_u (local.get $copy_length) (i32.const 255))
      (then (local.set $copy_length (i32.const 255))))
    (if (local.get $copy_length)
      (then
        (memory.copy (global.get $help_title_wa)
          (i32.add (global.get $help_doc_file_wa) (global.get $help_doc_title_off))
          (local.get $copy_length))))
    (i32.store8 (i32.add (global.get $help_title_wa) (local.get $copy_length)) (i32.const 0))
    (global.set $help_title_len (local.get $copy_length))
    (if (i32.eqz (call $help_replace_typed_view
          (global.get $help_session_topic_index)
          (local.get $layout_width) (local.get $target_hwnd)))
      (then (return (i32.const 0))))
    (global.set $help_topic_count (global.get $help_doc_topic_count))
    (global.set $help_cur_topic
      (i32.add (global.get $help_session_topic_index) (i32.const 1)))
    (global.set $help_scroll_y (i32.const 0))
    (i32.const 1))

  (func $help_prepare_wat_view (result i32)
    (call $help_prepare_wat_view_for (call $help_window_present_metric (i32.const 2))
      (select (global.get $help_hwnd) (global.get $next_hwnd)
        (i32.ne (global.get $help_hwnd) (i32.const 0)))))

  (func $help_popup_measure
    (local $i i32) (local $run i32) (local $right i32) (local $maximum i32)
    (block $done (loop $runs
      (br_if $done (i32.ge_u (local.get $i) (global.get $help_view_run_count)))
      (local.set $run (i32.add (global.get $help_view_runs_wa)
        (i32.mul (local.get $i) (global.get $HELP_LAYOUT_RUN_SIZE))))
      (local.set $right (i32.add (i32.load offset=4 (local.get $run))
        (i32.load offset=12 (local.get $run))))
      (if (i32.gt_s (local.get $right) (local.get $maximum))
        (then (local.set $maximum (local.get $right))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $runs)))
    (global.set $help_popup_width (i32.add (local.get $maximum) (i32.const 12)))
    (if (i32.lt_s (global.get $help_popup_width) (i32.const 96))
      (then (global.set $help_popup_width (i32.const 96))))
    (if (i32.gt_s (global.get $help_popup_width) (i32.const 336))
      (then (global.set $help_popup_width (i32.const 336))))
    (global.set $help_popup_height
      (i32.add (global.get $help_view_extent_height) (i32.const 12)))
    (if (i32.lt_s (global.get $help_popup_height) (i32.const 32))
      (then (global.set $help_popup_height (i32.const 32))))
    (if (i32.gt_s (global.get $help_popup_height) (i32.const 240))
      (then (global.set $help_popup_height (i32.const 240)))))

  (func $help_popup_destroy_windows
    (if (global.get $help_popup_hwnd)
      (then
        (call $host_destroy_window (global.get $help_popup_hwnd))
        (call $wnd_table_remove (global.get $help_popup_hwnd))
        (global.set $help_popup_hwnd (i32.const 0))))
    (if (global.get $help_popup_shadow_hwnd)
      (then
        (call $host_destroy_window (global.get $help_popup_shadow_hwnd))
        (call $wnd_table_remove (global.get $help_popup_shadow_hwnd))
        (global.set $help_popup_shadow_hwnd (i32.const 0))))
    (global.set $help_popup_width (i32.const 0))
    (global.set $help_popup_height (i32.const 0)))

  ;; Close the popup and restore both the detached primary view and the exact
  ;; viewer/session/history state that preceded popup activation.
  (func $help_popup_close
    (call $help_popup_destroy_windows)
    (block $documents_restored (loop $restore_documents
      (br_if $documents_restored
        (i32.or
          (i32.lt_s (global.get $help_popup_external_snapshot_base) (i32.const 0))
          (i32.le_u (global.get $help_document_snapshot_count)
            (global.get $help_popup_external_snapshot_base))))
      (br_if $documents_restored
        (i32.eqz (call $help_document_snapshot_restore_top)))
      (br $restore_documents)))
    (global.set $help_popup_external_snapshot_base (i32.const -1))
    (call $help_popup_restore_main_view)
    (if (global.get $help_popup_saved_session_valid)
      (then
        (global.set $help_session_topic_ref (global.get $help_popup_saved_topic_ref))
        (global.set $help_session_topic_index (global.get $help_popup_saved_topic_index))
        (global.set $help_session_mode (global.get $help_popup_saved_mode))
        (global.set $help_session_last_command (global.get $help_popup_saved_command))
        (global.set $help_session_status (global.get $help_popup_saved_status))
        (global.set $help_cur_topic (global.get $help_popup_saved_cur_topic))
        (global.set $help_scroll_y (global.get $help_popup_saved_scroll_y))
        (global.set $help_back_count (global.get $help_popup_saved_back_count))))
    (global.set $help_popup_saved_session_valid (i32.const 0))
    (if (global.get $help_hwnd)
      (then (call $invalidate_hwnd (global.get $help_hwnd)))))

  ;; A normal navigation issued while the popup is live retains the detached
  ;; main view only long enough for the ordinary history transaction to see
  ;; its source. A newly loaded document suppresses cross-document history.
  (func $help_popup_abandon_for_navigation
    (local $same_document i32)
    (local.set $same_document
      (i32.eq (global.get $help_popup_saved_doc_wa) (global.get $help_doc_file_wa)))
    (call $help_popup_destroy_windows)
    (call $help_popup_restore_main_view)
    (if (i32.eqz (local.get $same_document))
      (then
        (global.set $help_cur_topic (i32.const 0))
        (global.set $help_scroll_y (i32.const 0))))
    (global.set $help_popup_external_snapshot_base (i32.const -1))
    (global.set $help_popup_saved_session_valid (i32.const 0)))

  ;; Used by HELP_QUIT/document teardown: reunite both owned views so the
  ;; existing typed-view release path frees each resource exactly once.
  (func $help_popup_shutdown
    (if (i32.or (global.get $help_popup_hwnd)
          (global.get $help_popup_saved_valid))
      (then
        (call $help_popup_destroy_windows)
        (call $help_popup_restore_main_view)))
    (global.set $help_popup_external_snapshot_base (i32.const -1))
    (global.set $help_popup_saved_session_valid (i32.const 0)))

  (func $help_popup_present
    (local $first i32) (local $owner i32) (local $x i32) (local $y i32)
    (local.set $first (i32.eqz (global.get $help_popup_hwnd)))
    (if (local.get $first)
      (then
        (call $help_popup_detach_main_view)
        (global.set $help_popup_hwnd (global.get $next_hwnd))
        (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
        (global.set $help_popup_shadow_hwnd (global.get $next_hwnd))
        (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
        (call $wnd_table_set (global.get $help_popup_hwnd)
          (global.get $WNDPROC_WAT_NATIVE))
        (drop (call $wnd_set_style (global.get $help_popup_hwnd) (i32.const 0x90800000)))
        (call $wnd_table_set (global.get $help_popup_shadow_hwnd)
          (global.get $WNDPROC_WAT_NATIVE))
        (drop (call $wnd_set_style (global.get $help_popup_shadow_hwnd) (i32.const 0x90000000)))))
    (if (i32.eqz (call $help_prepare_wat_view_for
          (i32.const 320) (global.get $help_popup_hwnd)))
      (then
        (if (local.get $first)
          (then (call $help_popup_close)))
        (return)))
    (call $help_popup_measure)
    (local.set $owner
      (select (global.get $help_hwnd) (global.get $help_session_owner)
        (i32.ne (global.get $help_hwnd) (i32.const 0))))
    (call $wnd_set_owner (global.get $help_popup_hwnd) (local.get $owner))
    (call $wnd_set_owner (global.get $help_popup_shadow_hwnd) (local.get $owner))
    (call $client_rect_set (global.get $help_popup_hwnd) (i32.const 0) (i32.const 0)
      (global.get $help_popup_width) (global.get $help_popup_height))
    (call $client_rect_set (global.get $help_popup_shadow_hwnd) (i32.const 0) (i32.const 0)
      (global.get $help_popup_width) (global.get $help_popup_height))
    (local.set $x (i32.add (global.get $help_popup_anchor_x) (i32.const 12)))
    (local.set $y (i32.add (global.get $help_popup_anchor_y) (i32.const 18)))
    (if (i32.gt_s (i32.add (local.get $x) (global.get $help_popup_width)) (i32.const 632))
      (then (local.set $x (i32.sub (i32.const 632) (global.get $help_popup_width)))))
    (if (i32.gt_s (i32.add (local.get $y) (global.get $help_popup_height)) (i32.const 472))
      (then (local.set $y (i32.sub (i32.const 472) (global.get $help_popup_height)))))
    (if (i32.lt_s (local.get $x) (i32.const 8)) (then (local.set $x (i32.const 8))))
    (if (i32.lt_s (local.get $y) (i32.const 8)) (then (local.set $y (i32.const 8))))
    (if (local.get $first)
      (then
        ;; Create the shadow first so the popup is above it in host z-order.
        (drop (call $host_create_window
          (global.get $help_popup_shadow_hwnd) (i32.const 0x90000000)
          (i32.add (local.get $x) (i32.const 4))
          (i32.add (local.get $y) (i32.const 4))
          (global.get $help_popup_width) (global.get $help_popup_height)
          (i32.const 0) (i32.const 0)))
        (drop (call $host_create_window
          (global.get $help_popup_hwnd) (i32.const 0x90800000)
          (local.get $x) (local.get $y)
          (global.get $help_popup_width) (global.get $help_popup_height)
          (i32.const 0) (i32.const 0))))
      (else
        (call $host_move_window (global.get $help_popup_shadow_hwnd)
          (i32.add (local.get $x) (i32.const 4))
          (i32.add (local.get $y) (i32.const 4))
          (global.get $help_popup_width) (global.get $help_popup_height) (i32.const 0))
        (call $host_move_window (global.get $help_popup_hwnd)
          (local.get $x) (local.get $y)
          (global.get $help_popup_width) (global.get $help_popup_height) (i32.const 0))))
    (drop (call $help_wndproc (global.get $help_popup_shadow_hwnd)
      (i32.const 0x000F) (i32.const 0) (i32.const 0)))
    (drop (call $help_wndproc (global.get $help_popup_hwnd)
      (i32.const 0x000F) (i32.const 0) (i32.const 0))))

  (func $help_present_dispatch (param $accepted i32) (param $command i32)
    (local $old_index i32) (local $stack_ptr i32)
    (if (i32.eqz (local.get $accepted))
      (then
        (if (i32.and
              (i32.eq (global.get $help_session_status) (global.get $HELP_DISPATCH_LOAD_FAILED))
              (i32.ne (global.get $help_hwnd) (i32.const 0)))
          (then (call $help_destroy)))
        (return)))
    (if (i32.eq (local.get $command) (global.get $HELP_COMMAND_QUIT))
      (then
        (if (global.get $help_hwnd) (then (call $help_destroy)))
        (call $help_topics_destroy_window)
        (return)))
    (if (i32.or
          (i32.eq (global.get $help_session_mode) (i32.const 3))
          (i32.eq (global.get $help_session_mode) (i32.const 4)))
      (then
        (call $help_topics_show)
        (return)))
    (if (i32.eq (global.get $help_session_mode) (i32.const 2))
      (then
        (call $help_popup_present)
        (return)))
    (if (i32.eq (global.get $help_session_mode) (i32.const 1))
      (then
        (if (global.get $help_popup_hwnd)
          (then (call $help_popup_abandon_for_navigation)))
        (local.set $old_index (i32.const -1))
        (if (i32.and (i32.ne (global.get $help_topic_wa) (i32.const 0))
              (i32.gt_u (global.get $help_cur_topic) (i32.const 0)))
          (then (local.set $old_index
            (i32.sub (global.get $help_cur_topic) (i32.const 1)))))
        (if (i32.and
              (i32.and
                (i32.ge_s (local.get $old_index) (i32.const 0))
                (i32.ne (local.get $old_index) (global.get $help_session_topic_index)))
              (i32.and (i32.ne (global.get $help_back_stack) (i32.const 0))
                (i32.lt_u (global.get $help_back_count) (i32.const 16))))
          (then
            (local.set $stack_ptr (i32.add (global.get $help_back_stack)
              (i32.shl (global.get $help_back_count) (i32.const 2))))
            (i32.store (local.get $stack_ptr) (local.get $old_index))
            (global.set $help_back_count
              (i32.add (global.get $help_back_count) (i32.const 1)))))
        (if (call $help_prepare_wat_view)
          (then
            (if (i32.eqz (global.get $help_hwnd))
              (then (call $help_create_window))
              (else
                (call $help_apply_window_presentation)
                (call $invalidate_hwnd (global.get $help_hwnd)))))))))

  ;; Scroll help window by delta pixels (positive = down, negative = up), clamp to 0
  (func $help_scroll_by (param $hwnd i32) (param $delta i32)
    (local $maximum i32)
    (global.set $help_scroll_y (i32.add (global.get $help_scroll_y) (local.get $delta)))
    (if (i32.lt_s (global.get $help_scroll_y) (i32.const 0))
      (then (global.set $help_scroll_y (i32.const 0))))
    (local.set $maximum (i32.sub (global.get $help_view_extent_height) (i32.const 264)))
    (if (i32.lt_s (local.get $maximum) (i32.const 0))
      (then (local.set $maximum (i32.const 0))))
    (if (i32.gt_s (global.get $help_scroll_y) (local.get $maximum))
      (then (global.set $help_scroll_y (local.get $maximum))))
    (call $invalidate_hwnd (local.get $hwnd)))

  ;; Help window WndProc (WAT-native, called directly — not via x86)
  (func $help_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $hdc i32) (local $y i32) (local $line_start i32) (local $line_len i32)
    (local $scan i32) (local $end i32) (local $ch i32) (local $vis_y i32)
    (local $click_x i32) (local $click_y i32) (local $click_line i32)
    (if (i32.eq (local.get $hwnd) (global.get $help_topics_hwnd))
      (then (return (call $help_topics_wndproc
        (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    (if (i32.eq (local.get $hwnd) (global.get $help_popup_shadow_hwnd))
      (then
        (if (i32.eq (local.get $msg) (i32.const 0x000F))
          (then
            (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
            (drop (call $host_gdi_fill_rect (local.get $hdc)
              (i32.const 0) (i32.const 0)
              (global.get $help_popup_width) (global.get $help_popup_height)
              (i32.const 0x30014)))))
        (return (i32.const 0))))
    ;; The primary back-canvas already contains its detached view. Do not let
    ;; a background paint replace it with the active popup arena.
    (if (i32.and
          (i32.eq (local.get $hwnd) (global.get $help_hwnd))
          (i32.and (i32.ne (global.get $help_popup_hwnd) (i32.const 0))
            (i32.eq (local.get $msg) (i32.const 0x000F))))
      (then (return (i32.const 0))))
    ;; WM_PAINT (0x000F): draw help text using GDI (window-relative)
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        ;; hdc = hwnd + 0x40000 (same encoding as BeginPaint)
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        ;; Context popups retain the same deterministic system white surface;
        ;; their border, sizing, ownership, and shadow distinguish the native
        ;; popup presentation without introducing a private color renderer.
        (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))  ;; OPAQUE
        (drop (call $host_gdi_set_bk_color (local.get $hdc) (i32.const 0xFFFFFF)))
        (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x000000)))
        ;; Fill the exact retained popup extent or the fixed primary viewport.
        (drop (call $host_gdi_fill_rect (local.get $hdc)
          (i32.const 0) (i32.const 0)
          (select (global.get $help_popup_width) (i32.const 400)
            (i32.eq (local.get $hwnd) (global.get $help_popup_hwnd)))
          (select (global.get $help_popup_height) (i32.const 300)
            (i32.eq (local.get $hwnd) (global.get $help_popup_hwnd)))
          (i32.const 0x30010)))
        ;; Paint only the visible positioned text runs. Layout is retained
        ;; across scrolling and is rebuilt only when the topic/width changes.
        (if (global.get $help_topic_wa)
          (then (call $help_paint_typed_view (local.get $hdc)))
          (else
            ;; No topic: draw placeholder
            (drop (call $host_gdi_text_out (local.get $hdc)
              (i32.const 8) (i32.const 8)
              (i32.const 0x108)  ;; "Help"
              (i32.const 4) (i32.const 0)))))
        (if (i32.eq (local.get $hwnd) (global.get $help_popup_hwnd))
          (then
            (drop (call $host_gdi_draw_edge (local.get $hdc)
              (i32.const 0) (i32.const 0)
              (global.get $help_popup_width) (global.get $help_popup_height)
              (i32.const 0x05) (i32.const 0x0F)))
            (return (i32.const 0))))
        ;; Draw nav bar at bottom (y=276)
        ;; Draw separator line
        (drop (call $host_gdi_fill_rect (local.get $hdc)
          (i32.const 0) (i32.const 272) (i32.const 400) (i32.const 273)
          (i32.const 0x30014))) ;; BLACK_BRUSH
        ;; "[Contents]" at 0x10C (10 chars)
        (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0xFF0000))) ;; blue (BGR)
        (drop (call $host_gdi_text_out (local.get $hdc)
          (i32.const 8) (i32.const 278) (i32.const 0x10C) (i32.const 10) (i32.const 0)))
        ;; "[Back]" at 0x117 (6 chars)
        (drop (call $host_gdi_text_out (local.get $hdc)
          (i32.const 100) (i32.const 278) (i32.const 0x117) (i32.const 6) (i32.const 0)))
        (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x000000)))
        (return (i32.const 0))))

    ;; WM_LBUTTONDOWN (0x0201)
    (if (i32.eq (local.get $msg) (i32.const 0x0201))
      (then
        (if (i32.and
              (i32.eq (local.get $hwnd) (global.get $help_hwnd))
              (i32.ne (global.get $help_popup_hwnd) (i32.const 0)))
          (then (call $help_popup_close) (return (i32.const 0))))
        ;; lParam: low word = x, high word = y
        (local.set $click_x (i32.and (local.get $lParam) (i32.const 0xFFFF)))
        (local.set $click_y (i32.shr_u (local.get $lParam) (i32.const 16)))
        (if (i32.eq (local.get $hwnd) (global.get $help_popup_hwnd))
          (then
            (if (call $help_activate_hotspot_at
                  (global.get $help_session_owner)
                  (local.get $click_x) (local.get $click_y))
              (then (call $help_present_dispatch
                (i32.const 1) (global.get $help_session_last_command)))
              (else (call $help_popup_close)))
            (return (i32.const 0))))
        ;; Nav bar click (y >= 270)
        (if (i32.ge_u (local.get $click_y) (i32.const 270))
          (then
            ;; Check x position: [Contents] at 8..90, [Back] at 100..150
            (if (i32.lt_u (i32.and (local.get $lParam) (i32.const 0xFFFF)) (i32.const 90))
              (then
                (local.set $click_line (call $help_dispatch_loaded
                  (global.get $help_session_owner)
                  (global.get $HELP_COMMAND_CONTENTS) (i32.const 0)))
                (call $help_present_dispatch
                  (local.get $click_line) (global.get $HELP_COMMAND_CONTENTS)))
              (else (call $help_go_back)))
            (return (i32.const 0))))
        (local.set $click_line (i32.and (local.get $lParam) (i32.const 0xFFFF)))
        (if (call $help_activate_hotspot_at
              (global.get $help_session_owner) (local.get $click_line) (local.get $click_y))
          (then (call $help_present_dispatch
            (i32.const 1) (global.get $help_session_last_command))))
        (return (i32.const 0))))

    ;; WM_KEYDOWN (0x0100)
    (if (i32.eq (local.get $msg) (i32.const 0x0100))
      (then
        (if (i32.eq (local.get $hwnd) (global.get $help_popup_hwnd))
          (then
            (if (i32.eq (local.get $wParam) (i32.const 0x1B))
              (then (call $help_popup_close)))
            (return (i32.const 0))))
        ;; VK_UP (0x26): scroll up 16px
        (if (i32.eq (local.get $wParam) (i32.const 0x26))
          (then (call $help_scroll_by (local.get $hwnd) (i32.const -16)) (return (i32.const 0))))
        ;; VK_DOWN (0x28): scroll down 16px
        (if (i32.eq (local.get $wParam) (i32.const 0x28))
          (then (call $help_scroll_by (local.get $hwnd) (i32.const 16)) (return (i32.const 0))))
        ;; VK_PRIOR / Page Up (0x21)
        (if (i32.eq (local.get $wParam) (i32.const 0x21))
          (then (call $help_scroll_by (local.get $hwnd) (i32.const -200)) (return (i32.const 0))))
        ;; VK_NEXT / Page Down (0x22)
        (if (i32.eq (local.get $wParam) (i32.const 0x22))
          (then (call $help_scroll_by (local.get $hwnd) (i32.const 200)) (return (i32.const 0))))
        ;; Escape closes the viewer, as it does every other help surface.
        (if (i32.eq (local.get $wParam) (i32.const 0x1B))
          (then
            (drop (call $wnd_send_message
              (local.get $hwnd) (i32.const 0x0010) (i32.const 0) (i32.const 0)))
            (return (i32.const 0))))
        (return (i32.const 0))))

    ;; Title-bar X. A WAT-native window never reaches DefWindowProcA, so the
    ;; standard WM_NCLBUTTONDOWN/HTCLOSE -> SC_CLOSE -> WM_CLOSE chain is made
    ;; here. Without it the viewer had no way to be closed at all.
    (if (i32.and
          (i32.eq (local.get $msg) (i32.const 0x00A1))
          (i32.eq (local.get $wParam) (i32.const 20)))  ;; HTCLOSE
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

    ;; Owned context popups dismiss when focus leaves them.
    (if (i32.and
          (i32.eq (local.get $hwnd) (global.get $help_popup_hwnd))
          (i32.eq (local.get $msg) (i32.const 0x0008)))
      (then (call $help_popup_close) (return (i32.const 0))))
    ;; WM_CLOSE (0x0010)
    (if (i32.eq (local.get $msg) (i32.const 0x0010))
      (then
        (if (i32.eq (local.get $hwnd) (global.get $help_popup_hwnd))
          (then (call $help_popup_close) (return (i32.const 0))))
        (call $help_destroy)
        (call $help_document_snapshot_release_all)
        (call $help_document_reset)
        (return (i32.const 0))))
    ;; Default: return 0
    (i32.const 0)
  )

  ;; Go back in navigation history
  (func $help_go_back
    (local $prev i32) (local $stack_ptr i32) (local $record i32)
    (local $restored_scroll i32)
    (if (i32.eqz (global.get $help_back_count))
      (then
        (if (i32.eqz (global.get $help_document_snapshot_count))
          (then (return)))
        (if (i32.eqz (call $help_document_snapshot_restore_top))
          (then (return)))
        (local.set $restored_scroll (global.get $help_scroll_y))
        (if (call $help_prepare_wat_view)
          (then
            (global.set $help_scroll_y (local.get $restored_scroll))
            (call $help_apply_window_presentation)
            (call $invalidate_hwnd (global.get $help_hwnd))))
        (return)))
    ;; Pop from back stack
    (global.set $help_back_count (i32.sub (global.get $help_back_count) (i32.const 1)))
    (local.set $stack_ptr (i32.add (global.get $help_back_stack)
      (i32.shl (global.get $help_back_count) (i32.const 2))))
    (local.set $prev (i32.load (local.get $stack_ptr)))
    (if (i32.ge_u (local.get $prev) (global.get $help_doc_topic_count))
      (then (return)))
    (local.set $record (i32.add (global.get $help_doc_topics_wa)
      (i32.mul (local.get $prev) (global.get $HELP_TOPIC_SIZE))))
    (if (call $help_session_commit_topic
          (global.get $help_session_owner) (i32.const 0)
          (i32.load (local.get $record)) (i32.const 1))
      (then
        (if (call $help_prepare_wat_view)
          (then
            (call $help_apply_window_presentation)
            (call $invalidate_hwnd (global.get $help_hwnd))))))
  )

  ;; |SYSTEM stores window geometry in 1024ths of the screen, matching the
  ;; HCW [WINDOWS] coordinate space. Scale against the live screen size and
  ;; fall back to the canonical 640x480 desktop before the first mode set.
  (func $help_window_screen_span (param $vertical i32) (result i32)
    (local $packed i32) (local $span i32)
    (local.set $packed (call $host_get_screen_size))
    (local.set $span
      (if (result i32) (local.get $vertical)
        (then (i32.shr_u (local.get $packed) (i32.const 16)))
        (else (i32.and (local.get $packed) (i32.const 0xFFFF)))))
    (if (i32.eqz (local.get $span))
      (then (local.set $span
        (select (i32.const 480) (i32.const 640) (local.get $vertical)))))
    (local.get $span))

  ;; field: 0 = x, 1 = y, 2 = width, 3 = height. Without a selected record,
  ;; or with one whose geometry flags are incomplete, every field keeps the
  ;; canonical 400x300 main-viewer presentation the layout width assumes.
  (func $help_window_present_metric (param $field i32) (result i32)
    (local $record i32) (local $vertical i32) (local $span i32)
    (local $value i32) (local $extent i32) (local $flags i32)
    (local.set $vertical (i32.and (local.get $field) (i32.const 1)))
    (local.set $record (call $help_active_window_record))
    (if (local.get $record)
      (then (local.set $flags (i32.load (local.get $record)))))
    (if (i32.ne (i32.and (local.get $flags) (global.get $HELP_WINDOW_FLAG_GEOMETRY))
                (global.get $HELP_WINDOW_FLAG_GEOMETRY))
      (then
        (if (i32.eq (local.get $field) (i32.const 0)) (then (return (i32.const 100))))
        (if (i32.eq (local.get $field) (i32.const 1)) (then (return (i32.const 50))))
        (if (i32.eq (local.get $field) (i32.const 2)) (then (return (i32.const 400))))
        (return (i32.const 300))))
    (local.set $span (call $help_window_screen_span (local.get $vertical)))
    (local.set $value (i32.div_s
      (i32.mul (i32.load offset=28
                 (i32.add (local.get $record) (i32.shl (local.get $field) (i32.const 2))))
        (local.get $span))
      (i32.const 1024)))
    (if (i32.lt_u (local.get $field) (i32.const 2))
      (then
        ;; Position: keep the window on the desktop without resizing it.
        (local.set $extent (call $help_window_present_metric
          (i32.add (local.get $field) (i32.const 2))))
        (if (i32.gt_s (i32.add (local.get $value) (local.get $extent)) (local.get $span))
          (then (local.set $value (i32.sub (local.get $span) (local.get $extent)))))
        (if (i32.lt_s (local.get $value) (i32.const 0))
          (then (local.set $value (i32.const 0))))
        (return (local.get $value))))
    ;; Extent: bounded below so a degenerate record cannot collapse the view.
    (local.set $extent (select (i32.const 120) (i32.const 160) (local.get $vertical)))
    (if (i32.lt_s (local.get $value) (local.get $extent))
      (then (local.set $value (local.get $extent))))
    (if (i32.gt_s (local.get $value) (local.get $span))
      (then (local.set $value (local.get $span))))
    (local.get $value))

  ;; The caption field is fixed-width and need not be terminated, so publish
  ;; an owned NUL-terminated copy. A record without one, or an allocation
  ;; failure, falls back to the document title and then the "Help" literal.
  (func $help_window_present_caption (result i32)
    (local $record i32) (local $length i32) (local $ga i32)
    (local.set $record (call $help_active_window_record))
    (if (local.get $record)
      (then
        (if (i32.and (i32.load (local.get $record))
              (global.get $HELP_WINDOW_FLAG_CAPTION))
          (then
            (local.set $length (i32.load offset=24 (local.get $record)))
            (if (i32.gt_u (local.get $length)
                  (i32.sub (global.get $HELP_WINDOW_CAPTION_BYTES) (i32.const 1)))
              (then (local.set $length
                (i32.sub (global.get $HELP_WINDOW_CAPTION_BYTES) (i32.const 1)))))
            (if (local.get $length)
              (then
                (if (i32.eqz (global.get $help_window_caption_wa))
                  (then
                    (local.set $ga (call $heap_alloc
                      (global.get $HELP_WINDOW_CAPTION_BYTES)))
                    (if (local.get $ga)
                      (then
                        (global.set $help_window_caption_ga (local.get $ga))
                        (global.set $help_window_caption_wa
                          (call $g2w (local.get $ga)))))))
                (if (global.get $help_window_caption_wa)
                  (then
                    (memory.copy (global.get $help_window_caption_wa)
                      (i32.add (global.get $help_doc_file_wa)
                        (i32.load offset=20 (local.get $record)))
                      (local.get $length))
                    (i32.store8
                      (i32.add (global.get $help_window_caption_wa) (local.get $length))
                      (i32.const 0))
                    (return (global.get $help_window_caption_wa))))))))))
    (if (i32.and (i32.ne (global.get $help_title_wa) (i32.const 0))
                 (i32.ne (global.get $help_title_len) (i32.const 0)))
      (then (return (global.get $help_title_wa))))
    (i32.const 0x108)) ;; "Help"

  ;; Push the selected presentation onto an existing viewer. The caption
  ;; tracks every document, but geometry moves only when the selector itself
  ;; changed, so a window the user repositioned survives ordinary jumps.
  (func $help_apply_window_presentation
    (if (i32.eqz (global.get $help_hwnd)) (then (return)))
    (call $host_set_window_text (global.get $help_hwnd)
      (call $help_window_present_caption))
    (if (i32.eq (global.get $help_window_applied_index)
                (global.get $help_session_window_index))
      (then (return)))
    (global.set $help_window_applied_index (global.get $help_session_window_index))
    (call $host_move_window (global.get $help_hwnd)
      (call $help_window_present_metric (i32.const 0))
      (call $help_window_present_metric (i32.const 1))
      (call $help_window_present_metric (i32.const 2))
      (call $help_window_present_metric (i32.const 3))
      (i32.const 1)))

  ;; Create help window via host
  (func $help_create_window
    (local $hwnd i32)
    ;; Allocate hwnd
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    ;; Register in the window table BEFORE the host creates the window.
    ;; $host_create_window composites immediately, and that pass paints this
    ;; window - the first GDI call on hwnd+0x40000 is what creates the DC
    ;; state record, and $gdi_dc_state_entry binds that record to an HWND only
    ;; if the HWND is already in WND_RECORDS. Registering afterwards left the
    ;; viewer's DC permanently unbound: every later paint drew into a record
    ;; with no window, so $gdi_surface_descriptor refused it and not one pixel
    ;; ever reached a surface. The window was there, sized and visible, and
    ;; completely blank.
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_WAT_NATIVE))
    ;; $wnd_table_set zeroes the record's style, and $paint_select_next_dirty
    ;; drops the paint bit of any window that is not WS_VISIBLE.
    (drop (call $wnd_set_style (local.get $hwnd) (i32.const 0x10CF0000)))
    (global.set $help_hwnd (local.get $hwnd))
    ;; Create via host: style=WS_OVERLAPPEDWINDOW|WS_VISIBLE (0x10CF0000)
    (drop (call $host_create_window
      (local.get $hwnd)
      (i32.const 0x10CF0000)  ;; WS_OVERLAPPEDWINDOW | WS_VISIBLE
      (call $help_window_present_metric (i32.const 0))
      (call $help_window_present_metric (i32.const 1))
      (call $help_window_present_metric (i32.const 2))
      (call $help_window_present_metric (i32.const 3))
      (call $help_window_present_caption)
      (i32.const 0)))         ;; no menu
    (global.set $help_window_applied_index (global.get $help_session_window_index))
    ;; USER establishes the client rect and paints the frame before the first
    ;; client paint; without this the client DC's origin is the window origin
    ;; and the content draws under the caption.
    ;; The NC painter draws the caption from the title table, not from the
    ;; string handed to the host, so both need it or the bar comes out blank.
    (call $title_table_set (local.get $hwnd)
      (call $help_window_present_caption)
      (call $strlen (call $help_window_present_caption)))
    (call $defwndproc_do_nccalcsize (local.get $hwnd))
    (call $defwndproc_do_ncpaint (local.get $hwnd))
    ;; Bind the client DC to this window explicitly. $gdi_dc_state_entry binds
    ;; a window DC only at the moment it first creates the record, so whoever
    ;; touches hwnd+0x40000 first decides whether it is bound for the rest of
    ;; the window's life. Doing it here is independent of that race.
    (drop (call $gdi_dc_set_field
      (i32.add (local.get $hwnd) (i32.const 0x40000))
      (i32.const 92) (local.get $hwnd) (i32.const 0)))
    ;; Trigger immediate paint so content shows right away
    (drop (call $help_wndproc (local.get $hwnd) (i32.const 0x000F) (i32.const 0) (i32.const 0)))
  )

  ;; Destroy help window and clean up
  (func $help_destroy
    (call $help_popup_shutdown)
    (call $help_topics_destroy_window)
    (if (global.get $help_hwnd)
      (then
        (call $host_destroy_window (global.get $help_hwnd))
        (call $wnd_table_remove (global.get $help_hwnd))
        (global.set $help_hwnd (i32.const 0))))
    (call $help_typed_view_release)
    (if (global.get $help_title_wa)
      (then (call $heap_free (call $w2g (global.get $help_title_wa)))))
    (if (global.get $help_back_stack)
      (then (call $heap_free (call $w2g (global.get $help_back_stack)))))
    (if (global.get $help_window_caption_ga)
      (then (call $heap_free (global.get $help_window_caption_ga))))
    (global.set $help_window_caption_ga (i32.const 0))
    (global.set $help_window_caption_wa (i32.const 0))
    (global.set $help_window_applied_index (i32.const -1))
    (global.set $help_title_wa (i32.const 0))
    (global.set $help_title_len (i32.const 0))
    (global.set $help_topic_count (i32.const 0))
    (global.set $help_cur_topic (i32.const 0))
    (global.set $help_scroll_y (i32.const 0))
    (global.set $help_back_stack (i32.const 0))
    (global.set $help_back_count (i32.const 0))
  )
