  ;; ============================================================
  ;; WINDOW AND CLASS TABLES
  ;; WND_RECORDS and its accessors, the parallel per-slot tables, GWL/cbWndExtra,
  ;; dialog state, sibling walks, style accessors, the class table, WAT-native
  ;; wndproc dispatch and focus.
  ;; 
  ;; This is the most central windowing data structure in the project. It lived in
  ;; a file named 09c-help.wat, which the CLAUDE.md file table had to apologize for.
  ;; ============================================================

  ;; Address of window record N: WND_RECORDS + slot * 24
  (func $wnd_record_addr (param $slot i32) (result i32)
    (i32.add (global.get $WND_RECORDS) (i32.mul (local.get $slot) (i32.const 24))))

  ;; MENU_DATA_TABLE is parallel to WND_RECORDS. Clear it while the slot is
  ;; still known; host_destroy_window runs after wnd_table_remove and can no
  ;; longer resolve hwnd back to the slot. Leaving this pointer behind makes a
  ;; later CheckMenuItem walk freed menu memory when the slot is reused.
  (func $menu_data_reset_slot (param $slot i32)
    (local $addr i32) (local $old i32)
    (local.set $addr
      (i32.add (global.get $MENU_DATA_TABLE) (i32.mul (local.get $slot) (i32.const 4))))
    (local.set $old (i32.load (local.get $addr)))
    ;; Persistent menu table entries point four bytes past their allocation;
    ;; the private prefix stores the blob length for safe offset traversal.
    (if (local.get $old)
      (then (call $heap_free (i32.sub (local.get $old) (i32.const 4)))))
    (i32.store (local.get $addr) (i32.const 0)))

  ;; Add or update hwnd→wndproc mapping. Allocates a fresh slot for a new
  ;; hwnd, or updates the existing slot's wndproc field.

  ;; Clear every per-slot table for a recycled WND_RECORDS slot.
  ;;
  ;; This was a hand-written list of 13 calls inlined in $wnd_table_set, and a
  ;; per-slot table that was not on it left stale state on the next window to
  ;; land in that slot — silent and timing-dependent, since it only shows up
  ;; after enough windows have been created and destroyed to recycle. Four
  ;; tables were in fact missing when this was collected here: the scroll
  ;; record and its aux fields, the flash bit, the maximized bit, and the
  ;; update rect. A new window inherited the previous occupant's scroll range,
  ;; and could start life flashing or believing it was maximized.
  ;;
  ;; Anything keyed by WND_RECORDS slot belongs in this one function.
  (func $wnd_slot_reset (param $slot i32)
    (call $wnd_bg_brush_reset_slot (local.get $slot))
    (call $wnd_class_cursor_reset_slot (local.get $slot))
    (call $nc_flags_reset_slot (local.get $slot))
    (call $title_table_reset_slot (local.get $slot))
    (call $client_rect_reset_slot (local.get $slot))
    (call $wnd_region_reset_slot (local.get $slot))
    (call $paint_flag_reset_slot (local.get $slot))
    (call $ctrl_table_reset_slot (local.get $slot))
    (call $richedit_format_reset_slot (local.get $slot))
    (call $wnd_owner_reset_slot (local.get $slot))
    (call $menu_data_reset_slot (local.get $slot))
    (call $dialog_state_reset_slot (local.get $slot))
    (call $wnd_unicode_reset_slot (local.get $slot))
    (call $wnd_extra_reset_slot (local.get $slot))
    ;; Added with this registry — see the note above.
    (call $scroll_reset_slot (local.get $slot))
    (i32.store8 (i32.add (global.get $FLASH_TABLE) (local.get $slot)) (i32.const 0))
    (i32.store8 (i32.add (global.get $MAX_TABLE) (local.get $slot)) (i32.const 0))
    (call $zero_memory (call $update_rect_addr_for_slot (local.get $slot)) (i32.const 16))
    (i32.store8 (call $update_flag_addr_for_slot (local.get $slot)) (i32.const 0)))

  (func $wnd_table_set (param $hwnd i32) (param $wndproc i32)
    (local $i i32) (local $ptr i32) (local $empty i32)
    (local.set $empty (i32.const -1))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      (if (i32.eq (i32.load (local.get $ptr)) (local.get $hwnd))
        (then (i32.store offset=4 (local.get $ptr) (local.get $wndproc)) (return)))
      (if (i32.and (i32.eqz (i32.load (local.get $ptr)))
                   (i32.eq (local.get $empty) (i32.const -1)))
        (then (local.set $empty (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.ne (local.get $empty) (i32.const -1))
      (then
        (local.set $ptr (call $wnd_record_addr (local.get $empty)))
        ;; Zero the entire 24-byte record so a recycled slot does not inherit
        ;; stale parent/userdata/style/state_ptr from a previous window.
        (i32.store         (local.get $ptr) (local.get $hwnd))
        (i32.store offset=4  (local.get $ptr) (local.get $wndproc))
        (i32.store offset=8  (local.get $ptr) (i32.const 0))
        (i32.store offset=12 (local.get $ptr) (i32.const 0))
        (i32.store offset=16 (local.get $ptr) (i32.const 0))
        (i32.store offset=20 (local.get $ptr) (i32.const 0))
        (call $wnd_slot_reset (local.get $empty))))
  )

  ;; Look up wndproc for hwnd; returns 0 if not found
  (func $wnd_table_get (param $hwnd i32) (result i32)
    (local $i i32) (local $ptr i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      (if (i32.eq (i32.load (local.get $ptr)) (local.get $hwnd))
        (then (return (i32.load offset=4 (local.get $ptr)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0)
  )

  ;; Remove hwnd from window table — zeroes the whole record.
  (func $wnd_table_remove (param $hwnd i32)
    (local $i i32) (local $ptr i32) (local $state i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      (if (i32.eq (i32.load (local.get $ptr)) (local.get $hwnd))
        (then
          ;; A top-level window owns its canonical software-GDI presentation.
          ;; Child removal is a no-op because child DCs resolve to that owner.
          (call $gdi_window_surface_release (local.get $hwnd))
          ;; Free control state if any
          (local.set $state (i32.load offset=20 (local.get $ptr)))
          (if (local.get $state) (then (call $heap_free (local.get $state))))
          ;; Drop parallel-table state tied to this slot.
          (call $wnd_bg_brush_reset_slot (local.get $i))
          (call $wnd_class_cursor_reset_slot (local.get $i))
          (call $nc_flags_reset_slot (local.get $i))
          (call $title_table_reset_slot (local.get $i))
          (call $client_rect_reset_slot (local.get $i))
          (call $wnd_region_reset_slot (local.get $i))
          (call $paint_flag_reset_slot (local.get $i))
          (call $ctrl_table_reset_slot (local.get $i))
          (call $richedit_format_reset_slot (local.get $i))
          (call $wnd_owner_reset_slot (local.get $i))
          (call $menu_data_reset_slot (local.get $i))
          (call $dialog_state_reset_slot (local.get $i))
          (call $wnd_unicode_reset_slot (local.get $i))
          (call $wnd_extra_reset_slot (local.get $i))
          ;; Clear the whole 24-byte record
          (i32.store         (local.get $ptr) (i32.const 0))
          (i32.store offset=4  (local.get $ptr) (i32.const 0))
          (i32.store offset=8  (local.get $ptr) (i32.const 0))
          (i32.store offset=12 (local.get $ptr) (i32.const 0))
          (i32.store offset=16 (local.get $ptr) (i32.const 0))
          (i32.store offset=20 (local.get $ptr) (i32.const 0))
          (return)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
  )

  ;; Recursively destroy a window and all its children. Real DestroyWindow
  ;; notifies the wndproc before the HWND finally disappears; MFC relies on
  ;; WM_NCDESTROY to run PostNcDestroy / auto-delete frame objects, which may
  ;; flush profile or registry state.
  (func $wnd_destroy_recursive (param $hwnd i32)
    (local $i i32) (local $ptr i32) (local $other i32)
    (if (i32.eqz (local.get $hwnd)) (then (return)))
    ;; First, find all children and destroy them
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      (local.set $other (i32.load (local.get $ptr)))
      (if (i32.and (i32.ne (local.get $other) (i32.const 0))
                   (i32.eq (i32.load offset=8 (local.get $ptr)) (local.get $hwnd)))
        (then (call $wnd_destroy_recursive (local.get $other))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    ;; Notify the app/control proc before removing the record.
    (drop (call $wnd_send_message (local.get $hwnd)
      (i32.const 0x0002)  ;; WM_DESTROY
      (i32.const 0) (i32.const 0)))
    (drop (call $wnd_send_message (local.get $hwnd)
      (i32.const 0x0082)  ;; WM_NCDESTROY
      (i32.const 0) (i32.const 0)))
    (call $timer_kill_hwnd (local.get $hwnd))
    ;; Notify host to remove from its table (for each child too)
    (call $host_destroy_window (local.get $hwnd))
    ;; Finally, remove the window itself from guest table
    (call $wnd_table_remove (local.get $hwnd))
  )

  ;; Find window table slot index for hwnd; returns -1 if not found
  (func $wnd_table_find (param $hwnd i32) (result i32)
    (local $i i32) (local $ptr i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      (if (i32.eq (i32.load (local.get $ptr)) (local.get $hwnd))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1)
  )

  ;; Get per-window userdata (record+12)
  (func $wnd_get_userdata (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load offset=12 (call $wnd_record_addr (local.get $idx)))
  )

  ;; Set per-window userdata; returns old value
  (func $wnd_set_userdata (param $hwnd i32) (param $value i32) (result i32)
    (local $idx i32) (local $ptr i32) (local $old i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (local.set $ptr (call $wnd_record_addr (local.get $idx)))
    (local.set $old (i32.load offset=12 (local.get $ptr)))
    (i32.store offset=12 (local.get $ptr) (local.get $value))
    (local.get $old)
  )

  ;; Registered classes may reserve cbWndExtra bytes addressed by nonnegative
  ;; Get/SetWindowLong indices. Keep the first four LONG slots independent of
  ;; GWL_USERDATA; authentic WinHelp uses offsets 4, 8, and 12 concurrently.
  (func $wnd_extra_addr (param $slot i32) (param $index i32) (result i32)
    (i32.add (global.get $WINDOW_EXTRA_TABLE)
      (i32.add (i32.mul (local.get $slot) (i32.const 16)) (local.get $index))))

  (func $wnd_extra_reset_slot (param $slot i32)
    (local $p i32)
    (local.set $p (call $wnd_extra_addr (local.get $slot) (i32.const 0)))
    (i32.store (local.get $p) (i32.const 0))
    (i32.store offset=4 (local.get $p) (i32.const 0))
    (i32.store offset=8 (local.get $p) (i32.const 0))
    (i32.store offset=12 (local.get $p) (i32.const 0)))

  (func $wnd_extra_get (param $hwnd i32) (param $index i32) (result i32)
    (local $slot i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.or
          (i32.lt_s (local.get $slot) (i32.const 0))
          (i32.or
            (i32.gt_u (local.get $index) (i32.const 12))
            (i32.ne (i32.and (local.get $index) (i32.const 3)) (i32.const 0))))
      (then (return (i32.const 0))))
    (i32.load (call $wnd_extra_addr (local.get $slot) (local.get $index))))

  (func $wnd_extra_set (param $hwnd i32) (param $index i32) (param $value i32) (result i32)
    (local $slot i32) (local $p i32) (local $old i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.or
          (i32.lt_s (local.get $slot) (i32.const 0))
          (i32.or
            (i32.gt_u (local.get $index) (i32.const 12))
            (i32.ne (i32.and (local.get $index) (i32.const 3)) (i32.const 0))))
      (then (return (i32.const 0))))
    (local.set $p (call $wnd_extra_addr (local.get $slot) (local.get $index)))
    (local.set $old (i32.load (local.get $p)))
    (i32.store (local.get $p) (local.get $value))
    (local.get $old))

  ;; Dialog procedures are not window procedures. USER installs DefDlgProc as
  ;; the WNDPROC and keeps the application DLGPROC plus dialog extra bytes in
  ;; separate per-window state. MFC relies on this distinction when it
  ;; subclasses property sheets and calls the previous WNDPROC.
  (func $dialog_state_addr (param $slot i32) (result i32)
    (i32.add (global.get $DIALOG_STATE_TABLE)
      (i32.mul (local.get $slot) (i32.const 16))))

  (func $dialog_state_reset_slot (param $slot i32)
    (local $p i32)
    (local.set $p (call $dialog_state_addr (local.get $slot)))
    (i32.store (local.get $p) (i32.const 0))
    (i32.store offset=4 (local.get $p) (i32.const 0))
    (i32.store offset=8 (local.get $p) (i32.const 0))
    (i32.store offset=12 (local.get $p) (i32.const 0)))

  (func $dialog_proc_get (param $hwnd i32) (result i32)
    (local $slot i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.lt_s (local.get $slot) (i32.const 0))
      (then (return (i32.const 0))))
    (i32.load (call $dialog_state_addr (local.get $slot))))

  (func $dialog_proc_set (param $hwnd i32) (param $proc i32) (result i32)
    (local $slot i32) (local $p i32) (local $old i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.lt_s (local.get $slot) (i32.const 0))
      (then (return (i32.const 0))))
    (local.set $p (call $dialog_state_addr (local.get $slot)))
    (local.set $old (i32.load (local.get $p)))
    (i32.store (local.get $p) (local.get $proc))
    (local.get $old))

  (func $dialog_extra_get (param $hwnd i32) (param $index i32) (result i32)
    (local $slot i32) (local $p i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.lt_s (local.get $slot) (i32.const 0))
      (then (return (i32.const 0))))
    (local.set $p (call $dialog_state_addr (local.get $slot)))
    (if (i32.eq (local.get $index) (i32.const 0))
      (then (return (i32.load offset=4 (local.get $p)))))
    (if (i32.eq (local.get $index) (i32.const 4))
      (then (return (i32.load (local.get $p)))))
    (if (i32.eq (local.get $index) (i32.const 8))
      (then (return (i32.load offset=12 (local.get $p)))))
    (i32.const 0))

  (func $dialog_extra_set (param $hwnd i32) (param $index i32) (param $value i32) (result i32)
    (local $slot i32) (local $p i32) (local $old i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.lt_s (local.get $slot) (i32.const 0))
      (then (return (i32.const 0))))
    (local.set $p (call $dialog_state_addr (local.get $slot)))
    (if (i32.eq (local.get $index) (i32.const 0))
      (then
        (local.set $old (i32.load offset=4 (local.get $p)))
        (i32.store offset=4 (local.get $p) (local.get $value))
        (return (local.get $old))))
    (if (i32.eq (local.get $index) (i32.const 4))
      (then (return (call $dialog_proc_set (local.get $hwnd) (local.get $value)))))
    (if (i32.eq (local.get $index) (i32.const 8))
      (then
        (local.set $old (i32.load offset=12 (local.get $p)))
        (i32.store offset=12 (local.get $p) (local.get $value))
        (return (local.get $old))))
    (i32.const 0))

  (func $wnd_unicode_reset_slot (param $slot i32)
    (i32.store8 (i32.add (global.get $WINDOW_UNICODE_TABLE) (local.get $slot))
      (i32.const 0)))

  (func $wnd_unicode_get (param $hwnd i32) (result i32)
    (local $slot i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.lt_s (local.get $slot) (i32.const 0))
      (then (return (i32.const 0))))
    (i32.load8_u (i32.add (global.get $WINDOW_UNICODE_TABLE) (local.get $slot))))

  (func $wnd_unicode_set (param $hwnd i32) (param $unicode i32)
    (local $slot i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        (i32.store8 (i32.add (global.get $WINDOW_UNICODE_TABLE) (local.get $slot))
          (i32.ne (local.get $unicode) (i32.const 0))))))

  ;; Get parent hwnd (record+8)
  (func $wnd_get_parent (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load offset=8 (call $wnd_record_addr (local.get $idx)))
  )

  ;; Return the host-assigned Win32 process ID. Standalone embedders that do
  ;; not assign one retain the historical PID 1000 fallback.
  (func $current_process_id (result i32)
    (local $pid i32)
    (local.set $pid (i32.load (global.get $SHARED_PROCESS_ID)))
    (if (result i32) (local.get $pid)
      (then (local.get $pid))
      (else (i32.const 1000))))

  ;; Set parent hwnd for a window
  (func $wnd_set_parent (param $hwnd i32) (param $parent i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.ne (local.get $idx) (i32.const -1))
      (then
        (i32.store offset=8 (call $wnd_record_addr (local.get $idx)) (local.get $parent))))
  )

  ;; Per-window copy of WNDCLASS.hbrBackground. Win98 stores class metadata in
  ;; USER and default WM_ERASEBKGND uses the class belonging to that hwnd, not a
  ;; process-global "last registered class" value.
  (func $wnd_bg_brush_reset_slot (param $slot i32)
    (i32.store
      (i32.add (global.get $WND_BG_BRUSH_TABLE) (i32.mul (local.get $slot) (i32.const 4)))
      (i32.const 0)))

  (func $wnd_set_bg_brush (param $hwnd i32) (param $brush i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.ne (local.get $idx) (i32.const -1))
      (then
        (i32.store
          (i32.add (global.get $WND_BG_BRUSH_TABLE) (i32.mul (local.get $idx) (i32.const 4)))
          (local.get $brush)))))

  (func $wnd_get_bg_brush (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load (i32.add (global.get $WND_BG_BRUSH_TABLE) (i32.mul (local.get $idx) (i32.const 4)))))

  (func $wnd_set_class_bg_brush_from_name (param $hwnd i32) (param $class_name_guest i32)
    (local $slot i32)
    (local.set $slot (call $class_find_slot (call $class_name_key (local.get $class_name_guest))))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        ;; WNDCLASSA.hbrBackground is at +28 inside WNDCLASSA, i.e. class record +36.
        (call $wnd_set_bg_brush
          (local.get $hwnd)
          (i32.load offset=36 (call $class_record_addr (local.get $slot)))))))

  ;; ---- Class cursor, resolved per window at creation ----
  ;;
  ;; Same shape as the background brush above, and for the same reason: the
  ;; class record can be re-registered or its slot reused, so the value a
  ;; window was created with is captured once rather than looked up later.
  (func $wnd_class_cursor_reset_slot (param $slot i32)
    (i32.store
      (i32.add (global.get $WND_CLASS_CURSOR_TABLE) (i32.mul (local.get $slot) (i32.const 4)))
      (i32.const 0)))

  (func $wnd_set_class_cursor (param $hwnd i32) (param $cursor i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.ne (local.get $idx) (i32.const -1))
      (then
        (i32.store
          (i32.add (global.get $WND_CLASS_CURSOR_TABLE) (i32.mul (local.get $idx) (i32.const 4)))
          (local.get $cursor)))))

  (func $wnd_get_class_cursor (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load (i32.add (global.get $WND_CLASS_CURSOR_TABLE) (i32.mul (local.get $idx) (i32.const 4)))))

  (func $wnd_set_class_cursor_from_name (param $hwnd i32) (param $class_name_guest i32)
    (local $slot i32)
    (local.set $slot (call $class_find_slot (call $class_name_key (local.get $class_name_guest))))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        ;; WNDCLASSA.hCursor is at +24 inside WNDCLASSA, i.e. class record +32.
        (call $wnd_set_class_cursor
          (local.get $hwnd)
          (i32.load offset=32 (call $class_record_addr (local.get $slot)))))))

  ;; Owner hwnd for owned popup/top-level windows. This is deliberately
  ;; separate from parent: only WS_CHILD windows inherit geometry from parent.
  (func $wnd_owner_reset_slot (param $slot i32)
    (i32.store (i32.add (global.get $OWNER_TABLE) (i32.mul (local.get $slot) (i32.const 4))) (i32.const 0)))

  (func $wnd_get_owner (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load (i32.add (global.get $OWNER_TABLE) (i32.mul (local.get $idx) (i32.const 4)))))

  (func $wnd_set_owner (param $hwnd i32) (param $owner i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.ne (local.get $idx) (i32.const -1))
      (then
        (i32.store (i32.add (global.get $OWNER_TABLE) (i32.mul (local.get $idx) (i32.const 4)))
                   (local.get $owner)))))

  ;; Win32 GetParent returns a child parent for WS_CHILD, otherwise the owner
  ;; for owned popups/dialogs.
  (func $wnd_get_parent_api (param $hwnd i32) (result i32)
    (local $style i32)
    (local.set $style (call $wnd_get_style (local.get $hwnd)))
    (if (i32.and (local.get $style) (i32.const 0x40000000))
      (then (return (call $wnd_get_parent (local.get $hwnd)))))
    (call $wnd_get_owner (local.get $hwnd)))

  ;; USER32 built-in controls must keep their native WAT wndprocs. This guard
  ;; prevents registered-class fallback from stealing common classes like Edit.
  (func $is_builtin_control_class (param $class_name i32) (result i32)
    (local $name_w i32)
    (if (i32.and (i32.ge_u (local.get $class_name) (i32.const 0x0080))
                 (i32.le_u (local.get $class_name) (i32.const 0x0085)))
      (then (return (i32.const 1))))
    (if (i32.lt_u (local.get $class_name) (i32.const 0x10000))
      (then (return (i32.const 0))))
    (local.set $name_w (call $g2w (local.get $class_name)))
    (if (i32.eq (i32.or (i32.load (local.get $name_w)) (i32.const 0x20202020)) (i32.const 0x74696465))
      (then (return (i32.const 1)))) ;; edit
    (if (i32.eq (i32.or (i32.load (local.get $name_w)) (i32.const 0x20202020)) (i32.const 0x68636972))
      (then (return (i32.const 1)))) ;; rich*
    (if (i32.eq (i32.or (i32.load (local.get $name_w)) (i32.const 0x20202020)) (i32.const 0x74747562))
      (then (return (i32.const 1)))) ;; butt*
    (if (i32.eq (i32.or (i32.load (local.get $name_w)) (i32.const 0x20202020)) (i32.const 0x74617473))
      (then (return (i32.const 1)))) ;; stat*
    (if (i32.eq (i32.or (i32.load (local.get $name_w)) (i32.const 0x20202020)) (i32.const 0x7473696c))
      (then (return (i32.const 1)))) ;; list*
    (if (i32.eq (i32.or (i32.load (local.get $name_w)) (i32.const 0x20202020)) (i32.const 0x626d6f63))
      (then (return (i32.const 1)))) ;; comb*
    (if (i32.eq (i32.or (i32.load (local.get $name_w)) (i32.const 0x20202020)) (i32.const 0x6f726373))
      (then (return (i32.const 1)))) ;; scro*
    (if (i32.eq (i32.or (i32.load (local.get $name_w)) (i32.const 0x20202020)) (i32.const 0x74737973))
      (then (return (i32.const 1)))) ;; syst*
    (if (i32.and
          (i32.eq (i32.or (i32.load (local.get $name_w)) (i32.const 0x20202020)) (i32.const 0x6c737973))
          (i32.eq (i32.or (i32.load offset=4 (local.get $name_w)) (i32.const 0x20202020)) (i32.const 0x76747369)))
      (then (return (i32.const 1)))) ;; syslistview*
    (if (i32.eq (i32.or (i32.load (local.get $name_w)) (i32.const 0x20202020)) (i32.const 0x6c6f6f74))
      (then (return (i32.const 1)))) ;; tool*
    (if (i32.eq (i32.or (i32.load (local.get $name_w)) (i32.const 0x20202020)) (i32.const 0x7463736d))
      (then (return (i32.const 1)))) ;; msct*
    (if (i32.eq (i32.or (i32.load (local.get $name_w)) (i32.const 0x20202020)) (i32.const 0x64696c73))
      (then (return (i32.const 1)))) ;; slid*
    (i32.const 0))

  ;; Identify the two pre-msftedit RichEdit class contracts used by Win9x
  ;; applications. RICHEDIT is the Riched32/RichEdit 1.0 class; RichEdit20A
  ;; and RichEdit20W are the Riched20/RichEdit 2.0+ classes. Return 0 for a
  ;; non-RichEdit name, 1 for 1.0, and 2 for 2.0+. Comparisons are ASCII
  ;; case-insensitive because USER class lookup is case-insensitive.
  (func $richedit_class_version (param $class_name i32) (result i32)
    (local $name_w i32) (local $tail i32)
    (if (i32.lt_u (local.get $class_name) (i32.const 0x10000))
      (then (return (i32.const 0))))
    (local.set $name_w (call $g2w (local.get $class_name)))
    (if (i32.ne
          (i32.or (i32.load (local.get $name_w)) (i32.const 0x20202020))
          (i32.const 0x68636972)) ;; "rich"
      (then (return (i32.const 0))))
    (if (i32.ne
          (i32.or (i32.load offset=4 (local.get $name_w)) (i32.const 0x20202020))
          (i32.const 0x74696465)) ;; "edit"
      (then (return (i32.const 0))))
    ;; Exact legacy class name: "RICHEDIT\0".
    (if (i32.eqz (i32.load8_u offset=8 (local.get $name_w)))
      (then (return (i32.const 1))))
    ;; Versioned classes: "RichEdit20A\0" and "RichEdit20W\0".
    (local.set $tail
      (i32.or (i32.load8_u offset=10 (local.get $name_w)) (i32.const 0x20)))
    (if (i32.and
          (i32.eq (i32.load16_u offset=8 (local.get $name_w)) (i32.const 0x3032))
          (i32.and
            (i32.or (i32.eq (local.get $tail) (i32.const 0x61))
                    (i32.eq (local.get $tail) (i32.const 0x77)))
            (i32.eqz (i32.load8_u offset=11 (local.get $name_w)))))
      (then (return (i32.const 2))))
    ;; Preserve the historical edit-like fallback for other rich* aliases,
    ;; but bound them to the conservative 1.0 message contract.
    (i32.const 1))

  ;; First child of $parent in slot order (z-order proxy). 0 if none.
  ;; parent=0 means "find first top-level window".
  (func $wnd_find_first_child (param $parent i32) (result i32)
    (local $i i32) (local $ptr i32) (local $h i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      (local.set $h (i32.load (local.get $ptr)))
      (if (i32.and (i32.ne (local.get $h) (i32.const 0))
                   (i32.eq (i32.load offset=8 (local.get $ptr)) (local.get $parent)))
        (then (return (local.get $h))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0)
  )

  ;; Last child of $parent in slot order. 0 if none.
  (func $wnd_find_last_child (param $parent i32) (result i32)
    (local $i i32) (local $ptr i32) (local $h i32) (local $last i32)
    (local.set $last (i32.const 0))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      (local.set $h (i32.load (local.get $ptr)))
      (if (i32.and (i32.ne (local.get $h) (i32.const 0))
                   (i32.eq (i32.load offset=8 (local.get $ptr)) (local.get $parent)))
        (then (local.set $last (local.get $h))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $last)
  )

  ;; Next sibling of $hwnd (same parent, later slot). 0 if none.
  (func $wnd_find_next_sibling (param $hwnd i32) (result i32)
    (local $idx i32) (local $parent i32) (local $i i32) (local $ptr i32) (local $h i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return (i32.const 0))))
    (local.set $parent (i32.load offset=8 (call $wnd_record_addr (local.get $idx))))
    (local.set $i (i32.add (local.get $idx) (i32.const 1)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      (local.set $h (i32.load (local.get $ptr)))
      (if (i32.and (i32.ne (local.get $h) (i32.const 0))
                   (i32.eq (i32.load offset=8 (local.get $ptr)) (local.get $parent)))
        (then (return (local.get $h))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0)
  )

  ;; Previous sibling of $hwnd (same parent, earlier slot). 0 if none.
  (func $wnd_find_prev_sibling (param $hwnd i32) (result i32)
    (local $idx i32) (local $parent i32) (local $i i32) (local $ptr i32) (local $h i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return (i32.const 0))))
    (if (i32.eqz (local.get $idx)) (then (return (i32.const 0))))
    (local.set $parent (i32.load offset=8 (call $wnd_record_addr (local.get $idx))))
    (local.set $i (i32.sub (local.get $idx) (i32.const 1)))
    (block $done (loop $scan
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      (local.set $h (i32.load (local.get $ptr)))
      (if (i32.and (i32.ne (local.get $h) (i32.const 0))
                   (i32.eq (i32.load offset=8 (local.get $ptr)) (local.get $parent)))
        (then (return (local.get $h))))
      (br_if $done (i32.eqz (local.get $i)))
      (local.set $i (i32.sub (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0)
  )

  ;; Get window style (record+16)
  (func $wnd_get_style (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load offset=16 (call $wnd_record_addr (local.get $idx)))
  )

  ;; Set window style; returns old value
  (func $wnd_set_style (param $hwnd i32) (param $style i32) (result i32)
    (local $idx i32) (local $ptr i32) (local $old i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (local.set $ptr (call $wnd_record_addr (local.get $idx)))
    (local.set $old (i32.load offset=16 (local.get $ptr)))
    (i32.store offset=16 (local.get $ptr) (local.get $style))
    (if (i32.ne
          (i32.and (local.get $old) (i32.const 0x10000000))
          (i32.and (local.get $style) (i32.const 0x10000000)))
      (then (call $gdi_refresh_window_dc_system_clips)))
    (local.get $old)
  )

  ;; Get per-window state pointer (record+20). Heap ptr to a class-specific
  ;; WndState struct (EditState, ButtonState, ...). 0 = no state.
  (func $wnd_get_state_ptr (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load offset=20 (call $wnd_record_addr (local.get $idx)))
  )

  ;; Set per-window state pointer
  (func $wnd_set_state_ptr (param $hwnd i32) (param $value i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.ne (local.get $idx) (i32.const -1))
      (then
        (i32.store offset=20 (call $wnd_record_addr (local.get $idx)) (local.get $value))))
  )

  ;; ---- Class table helpers ----
  ;; Convert a class-name guest pointer to the key used throughout the class
  ;; table. If the guest value is a MAKEINTATOM (low 16-bit integer), pass it
  ;; through unchanged — $g2w would otherwise map it to NULL_SENTINEL and
  ;; collapse all atom-named classes onto one slot. Otherwise translate the
  ;; guest string pointer to its WASM address as usual.
  (func $class_name_key (param $guest i32) (result i32)
    (if (i32.lt_u (local.get $guest) (i32.const 0x10000))
      (then (return (local.get $guest))))
    (call $g2w (local.get $guest)))

  ;; Convert a UTF-16 class-name guest pointer to the byte-string key used by
  ;; the class table. Most Win32 class names are ASCII; keeping one canonical
  ;; hash lets RegisterClassW/CreateWindowExW use the same table as A calls.
  (func $class_wide_name_key (param $guest i32) (result i32)
    (local $src i32) (local $i i32) (local $ch i32)
    (if (i32.lt_u (local.get $guest) (i32.const 0x10000))
      (then (return (local.get $guest))))
    (local.set $src (call $g2w (local.get $guest)))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (i32.const 255)))
      (local.set $ch (i32.load16_u (i32.add (local.get $src)
        (i32.shl (local.get $i) (i32.const 1)))))
      (br_if $done (i32.eqz (local.get $ch)))
      (i32.store8 (i32.add (global.get $TEXT_SCRATCH) (local.get $i))
        (i32.and (local.get $ch) (i32.const 0xFF)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (i32.store8 (i32.add (global.get $TEXT_SCRATCH) (local.get $i)) (i32.const 0))
    (global.get $TEXT_SCRATCH))

  ;; The six classes USER registers into every process at init, with the atoms
  ;; it gives them. They are not ours to choose: 0x0080-0x0085 are the values
  ;; baked into every dialog template ever compiled, which is why a template
  ;; writes 0xFFFF followed by 0x0080 where a custom class writes a name.
  ;;
  ;; Returns 0 for anything else. Case-insensitive, and exact -- "buttonBar" is
  ;; not BUTTON. Compared as lowercased LE dwords, the same trick the callers
  ;; use, with the tail checked per byte because OR 0x20202020 over a dword
  ;; that spans the NUL would turn the terminator into a space.
  ;;
  ;; This exists so that the name form and the atom form of a built-in class
  ;; produce the SAME class-table key. Before it they were two different keys
  ;; for one class: CreateWindowExA("BUTTON") hashed the string, while
  ;; CreateWindowExA(MAKEINTATOM(0x0080)) keyed on 0x0080 and could never find
  ;; a record the string form had registered. In Win98 there is no such split --
  ;; RegisterClass calls AddAtom and CreateWindowEx calls FindAtom, so both
  ;; forms are already the same atom before the class list is ever walked.
  (func $builtin_class_atom (param $wa i32) (result i32)
    (local $d0 i32)
    (if (i32.lt_u (local.get $wa) (i32.const 0x10000)) (then (return (i32.const 0))))
    (local.set $d0 (i32.or (i32.load (local.get $wa)) (i32.const 0x20202020)))
    ;; "edit" — 4 chars, so the NUL is the whole tail.
    (if (i32.eq (local.get $d0) (i32.const 0x74696465))
      (then (return (select (i32.const 0x0081) (i32.const 0)
        (i32.eqz (i32.load8_u offset=4 (local.get $wa)))))))
    ;; "butt" + "on"
    (if (i32.eq (local.get $d0) (i32.const 0x74747562))
      (then (return (select (i32.const 0x0080) (i32.const 0)
        (i32.and
          (i32.eq (i32.or (i32.load16_u offset=4 (local.get $wa)) (i32.const 0x2020))
                  (i32.const 0x6e6f))
          (i32.eqz (i32.load8_u offset=6 (local.get $wa))))))))
    ;; "stat" + "ic"
    (if (i32.eq (local.get $d0) (i32.const 0x74617473))
      (then (return (select (i32.const 0x0082) (i32.const 0)
        (i32.and
          (i32.eq (i32.or (i32.load16_u offset=4 (local.get $wa)) (i32.const 0x2020))
                  (i32.const 0x6369))
          (i32.eqz (i32.load8_u offset=6 (local.get $wa))))))))
    ;; "list" + "box"
    (if (i32.eq (local.get $d0) (i32.const 0x7473696c))
      (then (return (select (i32.const 0x0083) (i32.const 0)
        (i32.and
          (i32.and
            (i32.eq (i32.or (i32.load16_u offset=4 (local.get $wa)) (i32.const 0x2020))
                    (i32.const 0x6f62))
            (i32.eq (i32.or (i32.load8_u offset=6 (local.get $wa)) (i32.const 0x20))
                    (i32.const 0x78)))
          (i32.eqz (i32.load8_u offset=7 (local.get $wa))))))))
    ;; "scro" + "llba" + "r"
    (if (i32.eq (local.get $d0) (i32.const 0x6f726373))
      (then (return (select (i32.const 0x0084) (i32.const 0)
        (i32.and
          (i32.and
            (i32.eq (i32.or (i32.load offset=4 (local.get $wa)) (i32.const 0x20202020))
                    (i32.const 0x61626c6c))
            (i32.eq (i32.or (i32.load8_u offset=8 (local.get $wa)) (i32.const 0x20))
                    (i32.const 0x72)))
          (i32.eqz (i32.load8_u offset=9 (local.get $wa))))))))
    ;; "comb" + "obox"
    (if (i32.eq (local.get $d0) (i32.const 0x626d6f63))
      (then (return (select (i32.const 0x0085) (i32.const 0)
        (i32.and
          (i32.eq (i32.or (i32.load offset=4 (local.get $wa)) (i32.const 0x20202020))
                  (i32.const 0x786f626f))
          (i32.eqz (i32.load8_u offset=8 (local.get $wa))))))))
    (i32.const 0))

  ;; Which control a built-in class name or atom denotes, as one answer for
  ;; both spellings. $guest is CreateWindowEx's lpClassName: either
  ;; MAKEINTATOM(0x0080..0x0085), which a compiled dialog template uses, or a
  ;; pointer to the class name, which source code uses. Returns a
  ;; $control_wndproc_dispatch class id, or 0 for anything that is not one of
  ;; USER's six.
  ;;
  ;; The ids are not the atoms and never were -- ScrollBar is atom 0x0084 but
  ;; control 7, ComboBox is atom 0x0085 but control 5 -- so the mapping has to
  ;; be written down somewhere. Before this it was written down twice, as
  ;; twelve separate compares in CreateWindowExA, and the id list existed only
  ;; in a comment above them.
  (func $builtin_ctrl_class_id (param $guest i32) (result i32)
    (call $builtin_ctrl_class_id_key (call $class_name_key (local.get $guest))))

  ;; Same answer for a caller that already holds a class key rather than the
  ;; raw guest pointer -- an atom, or the WASM address of the name. The W
  ;; entry points arrive this way, since their UTF-16 name has to be narrowed
  ;; into a byte string before anything can compare it.
  (func $builtin_ctrl_class_id_key (param $key i32) (result i32)
    (local $atom i32)
    (local.set $atom
      (if (result i32) (i32.lt_u (local.get $key) (i32.const 0x10000))
        (then (local.get $key))
        (else (call $builtin_class_atom (local.get $key)))))
    (if (i32.eq (local.get $atom) (i32.const 0x0080)) (then (return (i32.const 1))))   ;; Button
    (if (i32.eq (local.get $atom) (i32.const 0x0081)) (then (return (i32.const 2))))   ;; Edit
    (if (i32.eq (local.get $atom) (i32.const 0x0082)) (then (return (i32.const 3))))   ;; Static
    (if (i32.eq (local.get $atom) (i32.const 0x0083)) (then (return (i32.const 4))))   ;; ListBox
    (if (i32.eq (local.get $atom) (i32.const 0x0084)) (then (return (i32.const 7))))   ;; ScrollBar
    (if (i32.eq (local.get $atom) (i32.const 0x0085)) (then (return (i32.const 5))))   ;; ComboBox
    (i32.const 0))

  ;; Simple FNV-1a hash of NUL-terminated string at WASM addr
  (func $class_name_hash (param $wa i32) (result i32)
    (local $h i32) (local $ch i32)
    ;; A built-in class answers with its USER atom, so that the name form and
    ;; the MAKEINTATOM form of the same class key on the same record.
    (local.set $h (call $builtin_class_atom (local.get $wa)))
    (if (local.get $h) (then (return (local.get $h))))
    ;; If class name is a small integer (ATOM), return it directly
    (if (i32.lt_u (local.get $wa) (i32.const 0x10000))
      (then (return (local.get $wa))))
    (local.set $h (i32.const 0x811c9dc5))
    (block $done (loop $next
      (local.set $ch (i32.load8_u (local.get $wa)))
      (br_if $done (i32.eqz (local.get $ch)))
      ;; Lowercase
      (if (i32.and (i32.ge_u (local.get $ch) (i32.const 65))
                   (i32.le_u (local.get $ch) (i32.const 90)))
        (then (local.set $ch (i32.add (local.get $ch) (i32.const 32)))))
      (local.set $h (i32.mul (i32.xor (local.get $h) (local.get $ch)) (i32.const 0x01000193)))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1)))
      (br $next)))
    (local.get $h)
  )

  ;; Address of class record N: CLASS_RECORDS + slot * 48
  (func $class_record_addr (param $slot i32) (result i32)
    (i32.add (global.get $CLASS_RECORDS) (i32.mul (local.get $slot) (i32.const 48))))

  ;; Address of the embedded WNDCLASSA inside record N (record + 8)
  (func $class_wndclass_addr (param $slot i32) (result i32)
    (i32.add (call $class_record_addr (local.get $slot)) (i32.const 8)))

  ;; Allocate or find a class slot for $name_wa. Returns the class atom.
  ;; The caller is responsible for memcpy'ing the WNDCLASSA into
  ;; $class_wndclass_addr(slot) immediately afterwards.
  (func $class_table_register (param $name_wa i32) (result i32)
    (local $hash i32) (local $i i32) (local $ptr i32) (local $empty i32)
    (local.set $hash (call $class_name_hash (local.get $name_wa)))
    (local.set $empty (i32.const -1))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_CLASSES)))
      (local.set $ptr (call $class_record_addr (local.get $i)))
      ;; Existing class — return its atom (caller will overwrite WNDCLASSA via memcpy)
      (if (i32.eq (i32.load (local.get $ptr)) (local.get $hash))
        (then (return (i32.load offset=4 (local.get $ptr)))))
      ;; Track first empty
      (if (i32.and (i32.eqz (i32.load (local.get $ptr)))
                   (i32.eq (local.get $empty) (i32.const -1)))
        (then (local.set $empty (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    ;; Insert new class
    (if (i32.ne (local.get $empty) (i32.const -1))
      (then
        (local.set $ptr (call $class_record_addr (local.get $empty)))
        (i32.store (local.get $ptr) (local.get $hash))
        (global.set $class_atom_counter (i32.add (global.get $class_atom_counter) (i32.const 1)))
        (i32.store offset=4 (local.get $ptr) (global.get $class_atom_counter))
        (return (global.get $class_atom_counter))))
    (i32.const 0)
  )

  ;; Find class slot index by name hash; returns slot or -1
  (func $class_find_slot (param $name_wa i32) (result i32)
    (local $hash i32) (local $i i32) (local $ptr i32)
    (local.set $hash (call $class_name_hash (local.get $name_wa)))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_CLASSES)))
      (local.set $ptr (call $class_record_addr (local.get $i)))
      (if (i32.eq (i32.load (local.get $ptr)) (local.get $hash))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  ;; Look up wndproc by class name (WASM addr); returns 0 if not found.
  ;; Reads WNDCLASSA.lpfnWndProc which lives at record + 12.
  (func $class_table_lookup (param $name_wa i32) (result i32)
    (local $slot i32)
    (local.set $slot (call $class_find_slot (local.get $name_wa)))
    (if (i32.lt_s (local.get $slot) (i32.const 0))
      (then (return (i32.const 0))))
    (i32.load offset=12 (call $class_record_addr (local.get $slot)))
  )

  ;; ---- WAT-native WndProc dispatch ----
  ;; Called from DispatchMessageA/SendMessageA for WAT-native windows (wndproc >= 0xFFFF0000)
  ;; Dispatches to the correct WAT wndproc based on the ID encoded in the low bits
  (func $wat_wndproc_dispatch (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $wp i32) (local $ret i32)
    (local.set $wp (call $wnd_table_get (local.get $hwnd)))
    ;; 0xFFFF0002 = built-in control wndproc
    (if (i32.eq (local.get $wp) (global.get $WNDPROC_CTRL_NATIVE))
      (then
        (local.set $ret (call $control_wndproc_dispatch (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))
        ;; WM_SETCURSOR: zero means the control did not claim the cursor, which
        ;; in Win32 is the caller's cue to fall through to DefWindowProc. Only
        ;; the edit control's HTCLIENT branch sets one, so without this its
        ;; I-beam stayed on out over its own HTVSCROLL/HTHSCROLL strips.
        (if (i32.and (i32.eq (local.get $msg) (i32.const 0x0020)) (i32.eqz (local.get $ret)))
          (then (return (call $defwndproc_do_setcursor (local.get $hwnd)
                          (i32.and (local.get $lParam) (i32.const 0xFFFF))))))
        (return (local.get $ret))))
    ;; 0xFFFF0004 = dialog box. DefDlgProc owns the whole message set including
    ;; the non-client chrome, so route before the default NCPAINT/NCCALCSIZE.
    (if (i32.eq (local.get $wp) (global.get $WNDPROC_DIALOG))
      (then (return (call $dialog_default_proc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; 0xFFFF0003 = console window. Its own wndproc handles the client; the
    ;; default chrome below still draws its frame and caption.
    (if (i32.eq (local.get $wp) (global.get $WNDPROC_CONSOLE_NATIVE))
      (then
        (if (i32.eq (local.get $msg) (i32.const 0x0085))
          (then (call $defwndproc_do_ncpaint (local.get $hwnd)) (return (i32.const 0))))
        (if (i32.eq (local.get $msg) (i32.const 0x0083))
          (then (call $defwndproc_do_nccalcsize (local.get $hwnd)) (return (i32.const 0))))
        (return (call $console_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; WM_NCPAINT / WM_NCCALCSIZE default chrome for WAT-native top-levels.
    ;; Help wndproc never overrides these so we take the default directly.
    (if (i32.eq (local.get $msg) (i32.const 0x0085))
      (then (call $defwndproc_do_ncpaint (local.get $hwnd)) (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0083))
      (then (call $defwndproc_do_nccalcsize (local.get $hwnd)) (return (i32.const 0))))
    ;; 0xFFFF0001 = help wndproc
    (call $help_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam))
  )

  ;; ---- Focus management ----
  ;;
  ;; $set_focus(new_hwnd) is the single entry point for focus changes.
  ;; Sends WM_KILLFOCUS to the previously focused hwnd (if any) and
  ;; WM_SETFOCUS to the new one. Each control's wndproc updates its
  ;; per-class focus bit and invalidates itself; the global $focus_hwnd
  ;; is also updated by those handlers.
  (func $set_focus (param $new_hwnd i32)
    (local $old i32)
    (local.set $old (global.get $focus_hwnd))
    (if (i32.eq (local.get $old) (local.get $new_hwnd)) (then (return)))
    (if (local.get $old)
      (then (drop (call $wnd_send_message (local.get $old) (i32.const 0x0008) (local.get $new_hwnd) (i32.const 0)))))
    (if (local.get $new_hwnd)
      (then (drop (call $wnd_send_message (local.get $new_hwnd) (i32.const 0x0007) (local.get $old) (i32.const 0)))))
  )

  ;; ---- SCROLL_TABLE / SCROLL_AUX_TABLE accessors ----
  ;;
  ;; Both tables are per-WND_RECORDS-slot, and they use *different* strides —
  ;; 24 bytes for the legacy low-memory record, 16 for the SCROLLINFO fields
  ;; that did not fit in it. That is exactly the mistake `base + slot*N` spread
  ;; over four files invites, so the address arithmetic lives here now. Field
  ;; layout is documented at $SCROLL_TABLE in 01-header.wat.
  (func $scroll_record_addr (param $slot i32) (result i32)
    (i32.add (global.get $SCROLL_TABLE) (i32.mul (local.get $slot) (i32.const 24))))

  (func $scroll_aux_addr (param $slot i32) (result i32)
    (i32.add (global.get $SCROLL_AUX_TABLE) (i32.mul (local.get $slot) (i32.const 16))))

  ;; $bar is SB_HORZ(0) / SB_VERT(1); the vertical triple sits 12 bytes after
  ;; the horizontal one, and the aux pair 8 bytes after its horizontal one.
  (func $scroll_bar_addr (param $slot i32) (param $vert i32) (result i32)
    (i32.add (call $scroll_record_addr (local.get $slot))
             (select (i32.const 12) (i32.const 0) (local.get $vert))))

  (func $scroll_aux_bar_addr (param $slot i32) (param $vert i32) (result i32)
    (i32.add (call $scroll_aux_addr (local.get $slot))
             (select (i32.const 8) (i32.const 0) (local.get $vert))))

  ;; Zero one slot's scroll state. Called from the slot-reset path so a reused
  ;; hwnd does not inherit the previous window's scroll range.
  (func $scroll_reset_slot (param $slot i32)
    (call $zero_memory (call $scroll_record_addr (local.get $slot)) (i32.const 24))
    (call $zero_memory (call $scroll_aux_addr (local.get $slot)) (i32.const 16)))
