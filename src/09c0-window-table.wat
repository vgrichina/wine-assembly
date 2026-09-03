  ;; ============================================================
  ;; WINDOW AND CLASS TABLES
  ;; WND_RECORDS and its accessors, the parallel per-slot tables, GWL/cbWndExtra,
  ;; dialog state, sibling walks, style accessors, the class table, WAT-native
  ;; wndproc dispatch and focus.
  ;; 
  ;; This is the most central windowing data structure in the project. It lived in
  ;; a file named 09c-help.wat, which the CLAUDE.md file table had to apologize for.
  ;; ============================================================

  ;; The per-window record. 256 of these live in $WND_RECORDS (0x7000..0x8800),
  ;; one per slot; $wnd_record_addr below is the only thing that computes one's
  ;; address, so this declaration is the single statement of where its fields
  ;; are. See docs/watx-layout-migration-design.md §5.2.
  ;;
  ;; MEANINGS, which a layout cannot carry:
  ;;   hwnd       0 means the slot is EMPTY. It is also the publication word:
  ;;              $wnd_table_set builds the record while it is still invisible
  ;;              and stores hwnd last, and readers scan it with i32.atomic.load,
  ;;              which is why the offset-0 accesses are not all load.field.
  ;;   userdata   GWL_USERDATA.
  ;;   state_ptr  heap pointer to the per-class WndState, 0 if the class has none.
  ;;
  ;; Most per-window state is NOT here: it lives in ~20 PARALLEL per-slot tables
  ;; ($WND_Z_ORDER_TABLE, $WND_HINSTANCE_TABLE, $MENU_DATA_TABLE, ...), each with
  ;; its own stride and its own reset. A layout does not describe that shape and
  ;; making it would be a redesign, not a migration — deliberately out of scope.
  (layout WndRecord
    (field hwnd      i32)     ;; +0
    (field wndproc   i32)     ;; +4
    (field parent    i32)     ;; +8
    (field userdata  i32)     ;; +12
    (field style     i32)     ;; +16
    (field state_ptr i32))    ;; +20, record ends at +24

  ;; Address of window record N: WND_RECORDS + slot * size-of WndRecord
  (func $wnd_record_addr (param $slot i32) (result i32)
    (i32.add (global.get $WND_RECORDS) (i32.mul (local.get $slot) (size-of WndRecord))))

  (func $wnd_thread_addr (param $slot i32) (result i32)
    (i32.add (global.get $WND_THREAD_TABLE) (i32.mul (local.get $slot) (i32.const 4))))

  (func $wnd_thread_reset_slot (param $slot i32)
    (i32.store (call $wnd_thread_addr (local.get $slot)) (i32.const 0)))

  (func $wnd_z_addr_for_slot (param $slot i32) (result i32)
    (i32.add (global.get $WND_Z_ORDER_TABLE)
      (i32.shl (local.get $slot) (i32.const 2))))

  (func $wnd_z_reset_slot (param $slot i32)
    (i32.store (call $wnd_z_addr_for_slot (local.get $slot)) (i32.const 0)))

  (func $wnd_z_init_slot (param $slot i32)
    (global.set $wnd_z_next
      (i32.add (global.get $wnd_z_next) (i32.const 1024)))
    (i32.store (call $wnd_z_addr_for_slot (local.get $slot))
      (global.get $wnd_z_next)))

  (func $wnd_z_get (param $hwnd i32) (result i32)
    (local $slot i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.lt_s (local.get $slot) (i32.const 0))
      (then (return (i32.const 0))))
    (i32.load (call $wnd_z_addr_for_slot (local.get $slot))))

  (func $wnd_z_raise (param $hwnd i32)
    (local $slot i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.lt_s (local.get $slot) (i32.const 0)) (then (return)))
    (global.set $wnd_z_next
      (i32.add (global.get $wnd_z_next) (i32.const 1024)))
    (i32.store (call $wnd_z_addr_for_slot (local.get $slot))
      (global.get $wnd_z_next)))

  (func $wnd_z_is_above_sibling (param $hwnd i32) (param $sibling i32) (result i32)
    (i32.and
      (i32.and (i32.ne (local.get $sibling) (i32.const 0))
               (i32.ne (local.get $sibling) (local.get $hwnd)))
      (i32.and
        (i32.and
          (i32.eq (call $wnd_get_parent (local.get $sibling))
                  (call $wnd_get_parent (local.get $hwnd)))
          (i32.gt_s (call $wnd_z_get (local.get $sibling))
                    (call $wnd_z_get (local.get $hwnd))))
        (i32.ne (i32.and (call $wnd_get_style (local.get $sibling))
                         (i32.const 0x10000000)) (i32.const 0)))))

  ;; Apply SetWindowPos hWndInsertAfter semantics to the WAT-owned sibling
  ;; stack. hwndAfter is already a 32-bit HWND or one of HWND_TOP(0),
  ;; HWND_BOTTOM(1), HWND_TOPMOST(-1), HWND_NOTOPMOST(-2).
  (func $wnd_z_set_after (param $hwnd i32) (param $hwnd_after i32)
    (local $slot i32) (local $parent i32) (local $after_rank i32)
    (local $i i32) (local $sib i32) (local $rank i32) (local $min_rank i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.lt_s (local.get $slot) (i32.const 0)) (then (return)))
    (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
    (if (i32.or
          (i32.or (i32.eqz (local.get $hwnd_after))
                  (i32.eq (local.get $hwnd_after) (i32.const -1)))
          (i32.eq (local.get $hwnd_after) (i32.const -2)))
      (then (call $wnd_z_raise (local.get $hwnd)) (return)))
    (if (i32.eq (local.get $hwnd_after) (i32.const 1))
      (then
        (local.set $min_rank (call $wnd_z_get (local.get $hwnd)))
        (local.set $i (i32.const 0))
        (block $bottom_done (loop $bottom_scan
          (br_if $bottom_done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
          (local.set $sib (call $wnd_slot_hwnd (local.get $i)))
          (if (i32.and
                (i32.and (i32.ne (local.get $sib) (i32.const 0))
                         (i32.ne (local.get $sib) (local.get $hwnd)))
                (i32.eq (call $wnd_get_parent (local.get $sib)) (local.get $parent)))
            (then
              (local.set $rank (call $wnd_z_get (local.get $sib)))
              (if (i32.lt_s (local.get $rank) (local.get $min_rank))
                (then (local.set $min_rank (local.get $rank))))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $bottom_scan)))
        (i32.store (call $wnd_z_addr_for_slot (local.get $slot))
          (i32.sub (local.get $min_rank) (i32.const 1)))
        (return)))
    ;; An invalid or cross-parent insert target behaves like HWND_TOP here.
    (if (i32.ne (call $wnd_get_parent (local.get $hwnd_after)) (local.get $parent))
      (then (call $wnd_z_raise (local.get $hwnd)) (return)))
    (local.set $after_rank (call $wnd_z_get (local.get $hwnd_after)))
    ;; Make a unique rank immediately below hwndAfter. Moving every lower
    ;; sibling down one leaves after_rank-1 free without an auxiliary sort.
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $sib (call $wnd_slot_hwnd (local.get $i)))
      (if (i32.and
            (i32.and (i32.ne (local.get $sib) (i32.const 0))
                     (i32.ne (local.get $sib) (local.get $hwnd)))
            (i32.eq (call $wnd_get_parent (local.get $sib)) (local.get $parent)))
        (then
          (local.set $rank (call $wnd_z_get (local.get $sib)))
          (if (i32.lt_s (local.get $rank) (local.get $after_rank))
            (then
              (i32.store (call $wnd_z_addr_for_slot (local.get $i))
                (i32.sub (local.get $rank) (i32.const 1)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.store (call $wnd_z_addr_for_slot (local.get $slot))
      (i32.sub (local.get $after_rank) (i32.const 1))))

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

  (func $wnd_hinstance_reset_slot (param $slot i32)
    (i32.store
      (i32.add (global.get $WND_HINSTANCE_TABLE)
        (i32.shl (local.get $slot) (i32.const 2)))
      (i32.const -1)))

  (func $wnd_set_hinstance (param $hwnd i32) (param $hinstance i32)
    (local $slot i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        (i32.store
          (i32.add (global.get $WND_HINSTANCE_TABLE)
            (i32.shl (local.get $slot) (i32.const 2)))
          (local.get $hinstance)))))

  (func $wnd_get_hinstance (param $hwnd i32) (result i32)
    (local $slot i32) (local $hinstance i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.lt_s (local.get $slot) (i32.const 0))
      (then (return (i32.const 0))))
    (local.set $hinstance
      (i32.load (i32.add (global.get $WND_HINSTANCE_TABLE)
        (i32.shl (local.get $slot) (i32.const 2)))))
    (if (result i32) (i32.eq (local.get $hinstance) (i32.const -1))
      (then (global.get $image_base))
      (else (local.get $hinstance))))

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
    (call $wnd_z_reset_slot (local.get $slot))
    (call $wnd_bg_brush_reset_slot (local.get $slot))
    (call $wnd_class_cursor_reset_slot (local.get $slot))
    (call $wnd_class_icon_reset_slot (local.get $slot))
    (call $wnd_class_slot_reset_slot (local.get $slot))
    (call $nc_flags_reset_slot (local.get $slot))
    (call $title_table_reset_slot (local.get $slot))
    (call $client_rect_reset_slot (local.get $slot))
    (call $wnd_region_reset_slot (local.get $slot))
    (call $paint_flag_reset_slot (local.get $slot))
    (call $ctrl_table_reset_slot (local.get $slot))
    (call $richedit_format_reset_slot (local.get $slot))
    (call $wnd_owner_reset_slot (local.get $slot))
    (call $wnd_own_dc_reset_slot (local.get $slot))
    (call $wnd_thread_reset_slot (local.get $slot))
    (call $wnd_hinstance_reset_slot (local.get $slot))
    (call $menu_data_reset_slot (local.get $slot))
    (call $dialog_state_reset_slot (local.get $slot))
    (call $wnd_unicode_reset_slot (local.get $slot))
    (call $wnd_extra_reset_slot (local.get $slot))
    ;; Added with this registry — see the note above.
    (call $scroll_reset_slot (local.get $slot))
    (i32.store8 (i32.add (global.get $FLASH_TABLE) (local.get $slot)) (i32.const 0))
    (i32.store8 (i32.add (global.get $SHOW_STATE_TABLE) (local.get $slot)) (i32.const 0))
    (call $zero_memory (call $update_rect_addr_for_slot (local.get $slot)) (i32.const 16))
    (i32.store8 (call $update_flag_addr_for_slot (local.get $slot)) (i32.const 0)))

  ;; Locked, because this is a scan-then-claim over a table every guest thread's
  ;; instance shares: two threads creating a window at the same instant can both
  ;; settle on the same empty slot, and the second overwrites the first. The
  ;; loser's window is then a handle nothing can resolve — no error, no trace,
  ;; just a window that stops existing. Measured with the lock removed: two OS
  ;; threads claiming 100 windows each lost windows in 12 of 40 rounds, worst
  ;; round 138 of 200 (test/test-wat-window-tables.js).
  ;;
  ;; The whole body is table arithmetic and the per-slot resets, none of which
  ;; calls a host import, so a spinlock is safe here (rule 1 on $lock_acquire).
  (func $wnd_table_set (param $hwnd i32) (param $wndproc i32)
    (local $i i32) (local $ptr i32) (local $empty i32)
    (local.set $empty (i32.const -1))
    (local.set $i (i32.const 0))
    (call $lock_wnd_acquire)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      (if (i32.eq (i32.atomic.load (local.get $ptr)) (local.get $hwnd))
        (then
          (store.field.memarg WndRecord wndproc (local.get $ptr) (local.get $wndproc))
          (call $lock_wnd_release)
          (return)))
      (if (i32.and (i32.eqz (i32.atomic.load (local.get $ptr)))
                   (i32.eq (local.get $empty) (i32.const -1)))
        (then (local.set $empty (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.ne (local.get $empty) (i32.const -1))
      (then
        (local.set $ptr (call $wnd_record_addr (local.get $empty)))
        ;; Zero the entire 24-byte record so a recycled slot does not inherit
        ;; stale parent/userdata/style/state_ptr from a previous window.
        ;; Build the record while it is still invisible.  Readers use hwnd as
        ;; the publication word, so it must be stored last.
        (store.field.memarg WndRecord wndproc (local.get $ptr) (local.get $wndproc))
        (store.field.memarg WndRecord parent (local.get $ptr) (i32.const 0))
        (store.field.memarg WndRecord userdata (local.get $ptr) (i32.const 0))
        (store.field.memarg WndRecord style (local.get $ptr) (i32.const 0))
        (store.field.memarg WndRecord state_ptr (local.get $ptr) (i32.const 0))
        (call $wnd_slot_reset (local.get $empty))
        (call $wnd_z_init_slot (local.get $empty))
        (i32.store (call $wnd_thread_addr (local.get $empty))
          (global.get $current_thread_id))
        (i32.atomic.store (local.get $ptr) (local.get $hwnd))))
    (call $lock_wnd_release)
  )

  ;; True when the HWND allocator could have issued this handle. Every window
  ;; we create takes its handle from $next_hwnd, so anything below the base or
  ;; at/above the high-water mark was never a window -- a plug-in reading a
  ;; stale local as an HWND, or a caller that guessed. Say nothing about
  ;; whether the window is still alive: a destroyed handle stays "issued", and
  ;; the callers that care check the window table itself.
  ;; HWND_BROADCAST (0xFFFF) is a real target and is not covered here.
  (func $wnd_hwnd_was_issued (param $hwnd i32) (result i32)
    (i32.and
      (i32.ge_u (local.get $hwnd) (i32.const 0x10001))
      (i32.lt_u (local.get $hwnd) (global.get $next_hwnd)))
  )

  ;; Look up wndproc for hwnd; returns 0 if not found
  (func $wnd_table_get (param $hwnd i32) (result i32)
    (local $i i32) (local $ptr i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      (if (i32.eq (i32.atomic.load (local.get $ptr)) (local.get $hwnd))
        (then (return (load.field.memarg WndRecord wndproc (local.get $ptr)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0)
  )

  ;; Owning Win32 thread for HWND, or 0 for an unknown/destroyed handle.
  (func $wnd_get_thread (param $hwnd i32) (result i32)
    (local $i i32) (local $ptr i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      (if (i32.eq (i32.atomic.load (local.get $ptr)) (local.get $hwnd))
        (then (return (i32.load (call $wnd_thread_addr (local.get $i))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; Remove hwnd from window table — zeroes the whole record.
  ;;
  ;; The teardown itself CANNOT hold $LOCK_WND: it releases the window's GDI
  ;; surface, which is a host import, and a spinlock held across one of those
  ;; deadlocks worker mode — the import blocks in Atomics.wait for the main
  ;; thread, which may be spinning for this very lock (rule 1 on $lock_acquire).
  ;; So only the final zeroing is locked, which is what publishes the slot as
  ;; free; the record keeps its hwnd through the teardown, exactly as before,
  ;; and a concurrent claim cannot take a slot that is not empty yet.
  (func $wnd_table_remove (param $hwnd i32)
    (local $i i32) (local $ptr i32) (local $state i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      (if (i32.eq (i32.atomic.load (local.get $ptr)) (local.get $hwnd))
        (then
          ;; A top-level window owns its canonical software-GDI presentation.
          ;; Child removal is a no-op because child DCs resolve to that owner.
          (call $gdi_window_surface_release (local.get $hwnd))
          ;; Free control state if any
          (local.set $state (load.field.memarg WndRecord state_ptr (local.get $ptr)))
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
          (call $wnd_z_reset_slot (local.get $i))
          ;; Clear the whole 24-byte record, under the lock: zeroing the hwnd
          ;; is what publishes the slot as free, and a claim that read it
          ;; half-cleared would inherit this window's parent and style.
          (call $lock_wnd_acquire)
          ;; Unpublish first while holding the writer lock.  A reader can no
          ;; longer match this slot before any metadata becomes reusable.
          (i32.atomic.store (local.get $ptr) (i32.const 0))
          (store.field.memarg WndRecord wndproc (local.get $ptr) (i32.const 0))
          (store.field.memarg WndRecord parent (local.get $ptr) (i32.const 0))
          (store.field.memarg WndRecord userdata (local.get $ptr) (i32.const 0))
          (store.field.memarg WndRecord style (local.get $ptr) (i32.const 0))
          (store.field.memarg WndRecord state_ptr (local.get $ptr) (i32.const 0))
          (call $wnd_thread_reset_slot (local.get $i))
          (call $lock_wnd_release)
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
      (local.set $other (i32.atomic.load (local.get $ptr)))
      (if (i32.and (i32.ne (local.get $other) (i32.const 0))
                   (i32.eq (load.field.memarg WndRecord parent (local.get $ptr)) (local.get $hwnd)))
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
    ;; A destroyed window cannot keep the focus or the capture. USER drops both
    ;; as the HWND dies; we used to clear focus only in $handle_DestroyWindow,
    ;; and only when the *named* window held it — so a dialog's focused child
    ;; left $focus_hwnd pointing at a dead HWND. The next SetFocus then posted
    ;; WM_KILLFOCUS to it, GetMessage handed that message to the app, and MFC's
    ;; CWnd::WalkPreTranslateTree looked the dead HWND up in its permanent
    ;; handle map and called a virtual on a CWnd whose stack frame was gone
    ;; (WordPad File>New + Cancel, mfc42 6.00).
    (if (i32.eq (global.get $focus_hwnd) (local.get $hwnd))
      (then (global.set $focus_hwnd (i32.const 0))))
    (if (i32.eq (global.get $active_hwnd) (local.get $hwnd))
      (then (global.set $active_hwnd (i32.const 0))))
    (if (i32.eq (global.get $capture_hwnd) (local.get $hwnd))
      (then (global.set $capture_hwnd (i32.const 0))))
    (call $post_queue_purge_hwnd (local.get $hwnd))
    ;; Notify host to remove from its table (for each child too)
    (call $host_destroy_window (local.get $hwnd))
    ;; Finally, remove the window itself from guest table
    (call $wnd_table_remove (local.get $hwnd))
  )

  ;; The two slots this instance resolved most recently, or -1. This lookup is
  ;; on the GDI blit path -- every DC bound to a window resolves its clip
  ;; through here -- and the scan below is 256 iterations with a call in each
  ;; one, so an unaided miss-shaped hit is expensive out of all proportion to
  ;; what it computes. Measured in Chrome on Diablo's Choose Class screen (a
  ;; screen that is 90% GDI rasterization), $wnd_table_find alone was **25.4%
  ;; of all CPU time**, ahead of every rasterizer function and 15x the x86
  ;; interpreter's $next.
  ;;
  ;; Two entries rather than one because the painting pattern alternates: a
  ;; control's clip resolves the child and then its parent, and a single hint
  ;; thrashes between them and never hits.
  ;;
  ;; A stale hint is harmless -- the hwnd stored in the slot is compared before
  ;; the slot is returned, so a recycled or destroyed slot simply misses and
  ;; falls through to the scan. That is what makes this safe without any
  ;; invalidation hook in $wnd_table_set / $wnd_table_remove.
  (global $wnd_find_hint0 (mut i32) (i32.const -1))
  (global $wnd_find_hint1 (mut i32) (i32.const -1))

  ;; Find window table slot index for hwnd; returns -1 if not found
  (func $wnd_table_find (param $hwnd i32) (result i32)
    (local $i i32) (local $ptr i32) (local $hint i32)
    ;; hwnd 0 keeps the original exhaustive semantics. A caller passing it is
    ;; asking for the first *empty* slot, which is a position in the table and
    ;; not a window, so it must never be answered from a hint.
    (if (local.get $hwnd) (then
      (local.set $hint (global.get $wnd_find_hint0))
      (if (i32.ge_s (local.get $hint) (i32.const 0)) (then
        (if (i32.eq (load.field WndRecord hwnd (call $wnd_record_addr (local.get $hint))) (local.get $hwnd))
          (then (return (local.get $hint))))))
      (local.set $hint (global.get $wnd_find_hint1))
      (if (i32.ge_s (local.get $hint) (i32.const 0)) (then
        (if (i32.eq (load.field WndRecord hwnd (call $wnd_record_addr (local.get $hint))) (local.get $hwnd))
          (then
            ;; Promote: the two windows swap roles as painting moves between a
            ;; parent and its children, and the hot one should stay in hint0.
            (global.set $wnd_find_hint1 (global.get $wnd_find_hint0))
            (global.set $wnd_find_hint0 (local.get $hint))
            (return (local.get $hint))))))))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      ;; Atomic load (threads branch) + main's find-hint cache. The load stays
      ;; atomic because another instance can be publishing this slot's hwnd
      ;; while we scan; the hints are per-instance globals and only ever steer
      ;; the next scan's starting guess, so they need no synchronization.
      (if (i32.eq (i32.atomic.load (local.get $ptr)) (local.get $hwnd))
        (then
          (if (local.get $hwnd) (then
            (global.set $wnd_find_hint1 (global.get $wnd_find_hint0))
            (global.set $wnd_find_hint0 (local.get $i))))
          (return (local.get $i))))
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
    (load.field.memarg WndRecord userdata (call $wnd_record_addr (local.get $idx)))
  )

  ;; Set per-window userdata; returns old value
  (func $wnd_set_userdata (param $hwnd i32) (param $value i32) (result i32)
    (local $idx i32) (local $ptr i32) (local $old i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (local.set $ptr (call $wnd_record_addr (local.get $idx)))
    (local.set $old (load.field.memarg WndRecord userdata (local.get $ptr)))
    (store.field.memarg WndRecord userdata (local.get $ptr) (local.get $value))
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
    (load.field.memarg WndRecord parent (call $wnd_record_addr (local.get $idx)))
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
        (store.field.memarg WndRecord parent (call $wnd_record_addr (local.get $idx)) (local.get $parent))))
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

  ;; Has the application replaced this WAT-native control's window procedure?
  ;;
  ;; A control that has been subclassed is no longer ours to draw. Storm's
  ;; DiabloUI creates ordinary "Button" and "SDlgStatic" children and then hands
  ;; each one its own WNDPROC with SetWindowLongA(GWL_WNDPROC), blanks the
  ;; window text, and renders the label from its own art in its own WM_PAINT.
  ;; Painting the built-in grey 3D button face for those windows is not a
  ;; default the subclass can undo, because the native drain consumes the
  ;; WM_PAINT before the subclass ever sees it -- the Diablo menus came out as
  ;; rows of blank grey slabs over the artwork.
  ;;
  ;; A subclass that does want the built-in look still gets it: chaining to
  ;; CallWindowProc or DefWindowProc lands back in $control_wndproc_dispatch.
  (func $ctrl_is_subclassed (param $hwnd i32) (result i32)
    (local $proc i32)
    (if (i32.eqz (call $ctrl_table_get_class (local.get $hwnd)))
      (then (return (i32.const 0))))
    (local.set $proc (call $wnd_table_get (local.get $hwnd)))
    ;; 0 = never registered, >= 0xFFFE0000 = one of our own sentinels
    ;; (WNDPROC_BUILTIN, WNDPROC_DIALOG, the WAT-native procs).
    (i32.and
      (i32.ne (local.get $proc) (i32.const 0))
      (i32.lt_u (local.get $proc) (i32.const 0xFFFE0000))))

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

  ;; ---- Class icon, per window ----
  (func $wnd_class_icon_reset_slot (param $slot i32)
    (i32.store
      (i32.add (global.get $WND_CLASS_ICON_TABLE) (i32.mul (local.get $slot) (i32.const 4)))
      (i32.const 0)))

  (func $wnd_set_class_icon (param $hwnd i32) (param $icon i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.ne (local.get $idx) (i32.const -1))
      (then
        (i32.store
          (i32.add (global.get $WND_CLASS_ICON_TABLE) (i32.mul (local.get $idx) (i32.const 4)))
          (local.get $icon)))))

  (func $wnd_get_class_icon (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load (i32.add (global.get $WND_CLASS_ICON_TABLE) (i32.mul (local.get $idx) (i32.const 4)))))

  ;; ---- Which class a window belongs to ----
  ;;
  ;; Resolved once at creation, like the brush and the cursor above, and for
  ;; the same reason. It is what lets GetClassWord/SetClassWord reach the
  ;; class's own extra bytes from an hwnd; -1 means the class was gone by the
  ;; time the window was made, which is not an error for a builtin control.
  (func $wnd_class_slot_reset_slot (param $slot i32)
    (i32.store8 (i32.add (global.get $WND_CLASS_SLOT_TABLE) (local.get $slot))
      (i32.const 0xFF)))

  (func $wnd_get_class_slot (param $hwnd i32) (result i32)
    (local $idx i32) (local $slot i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return (i32.const -1))))
    (local.set $slot
      (i32.load8_u (i32.add (global.get $WND_CLASS_SLOT_TABLE) (local.get $idx))))
    (select (i32.const -1) (local.get $slot) (i32.eq (local.get $slot) (i32.const 0xFF))))

  ;; Real USER decides what a nonnegative Get/SetWindowLong index means from
  ;; the class, not from who is calling: a class that reserves at least
  ;; DLGWINDOWEXTRA (30) bytes owns a dialog's per-window block, so index 4
  ;; there is DWLP_DLGPROC. Storm registers SDlgDialog that way and installs
  ;; Diablo's DLGPROC from WM_NCCREATE, long before anything reaches
  ;; DefDlgProcA -- without this the write is filed as ordinary window extra
  ;; data and the dialog never gets WM_INITDIALOG.
  (func $wnd_class_is_dialog (param $hwnd i32) (result i32)
    (local $slot i32)
    (local.set $slot (call $wnd_get_class_slot (local.get $hwnd)))
    (if (i32.lt_s (local.get $slot) (i32.const 0)) (then (return (i32.const 0))))
    (i32.ge_u
      (i32.load offset=12 (call $class_wndclass_addr (local.get $slot)))
      (i32.const 30)))

  (func $wnd_set_class_slot_from_name (param $hwnd i32) (param $class_name_guest i32)
    (local $idx i32) (local $slot i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return)))
    (local.set $slot (call $class_find_slot (call $class_name_key (local.get $class_name_guest))))
    (if (i32.or (i32.lt_s (local.get $slot) (i32.const 0))
                (i32.ge_u (local.get $slot) (global.get $MAX_CLASSES)))
      (then (local.set $slot (i32.const 0xFF))))
    (i32.store8 (i32.add (global.get $WND_CLASS_SLOT_TABLE) (local.get $idx))
      (local.get $slot)))

  ;; ---- GetClassLong / SetClassLong ----
  ;;
  ;; The negative GCL_* indices name fields of the class's own WNDCLASSA;
  ;; non-negative ones index its extra bytes. Returns the WASM address of the
  ;; dword, or 0 when this hwnd has no class record or the index names nothing.
  (func $class_long_offset (param $index i32) (result i32)
    (if (i32.eq (local.get $index) (i32.const -26)) (then (return (i32.const 0))))   ;; GCL_STYLE
    (if (i32.eq (local.get $index) (i32.const -24)) (then (return (i32.const 4))))   ;; GCL_WNDPROC
    (if (i32.eq (local.get $index) (i32.const -20)) (then (return (i32.const 8))))   ;; GCL_CBCLSEXTRA
    (if (i32.eq (local.get $index) (i32.const -18)) (then (return (i32.const 12))))  ;; GCL_CBWNDEXTRA
    (if (i32.eq (local.get $index) (i32.const -16)) (then (return (i32.const 16))))  ;; GCL_HMODULE
    (if (i32.eq (local.get $index) (i32.const -14)) (then (return (i32.const 20))))  ;; GCL_HICON
    (if (i32.eq (local.get $index) (i32.const -12)) (then (return (i32.const 24))))  ;; GCL_HCURSOR
    (if (i32.eq (local.get $index) (i32.const -10)) (then (return (i32.const 28))))  ;; GCL_HBRBACKGROUND
    (if (i32.eq (local.get $index) (i32.const -8))  (then (return (i32.const 32))))  ;; GCL_MENUNAME
    (i32.const -1))

  (func $class_long_addr (param $hwnd i32) (param $index i32) (result i32)
    (local $slot i32) (local $off i32)
    (local.set $slot (call $wnd_get_class_slot (local.get $hwnd)))
    (if (i32.lt_s (local.get $slot) (i32.const 0)) (then (return (i32.const 0))))
    (if (i32.ge_s (local.get $index) (i32.const 0))
      (then (return (call $class_extra_addr (local.get $slot) (local.get $index)))))
    (local.set $off (call $class_long_offset (local.get $index)))
    (if (i32.lt_s (local.get $off) (i32.const 0)) (then (return (i32.const 0))))
    (i32.add (call $class_wndclass_addr (local.get $slot)) (local.get $off)))

  ;; The brush, cursor and icon each have a per-window copy taken at creation,
  ;; so a class value changed afterwards has to reach the windows already made
  ;; from it — otherwise SetClassLong is a write nothing ever reads. Storm
  ;; nulls GCL_HBRBACKGROUND around every dialog paint precisely so the default
  ;; erase draws nothing over Diablo's DirectDraw frame.
  (func $class_long_propagate (param $slot i32) (param $index i32) (param $value i32)
    (local $i i32) (local $table i32)
    (if (i32.eq (local.get $index) (i32.const -10))
      (then (local.set $table (global.get $WND_BG_BRUSH_TABLE)))
      (else (if (i32.eq (local.get $index) (i32.const -12))
        (then (local.set $table (global.get $WND_CLASS_CURSOR_TABLE)))
        (else (if (i32.eq (local.get $index) (i32.const -14))
          (then (local.set $table (global.get $WND_CLASS_ICON_TABLE)))
          (else (return)))))))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (if (i32.and
            (i32.ne (load.field WndRecord hwnd (call $wnd_record_addr (local.get $i))) (i32.const 0))
            (i32.eq (i32.load8_u (i32.add (global.get $WND_CLASS_SLOT_TABLE) (local.get $i)))
                    (local.get $slot)))
        (then
          (i32.store (i32.add (local.get $table) (i32.mul (local.get $i) (i32.const 4)))
            (local.get $value))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan))))

  (func $class_long_get (param $hwnd i32) (param $index i32) (result i32)
    (local $addr i32)
    (local.set $addr (call $class_long_addr (local.get $hwnd) (local.get $index)))
    (if (i32.eqz (local.get $addr)) (then (return (i32.const 0))))
    (i32.load (local.get $addr)))

  (func $class_long_set (param $hwnd i32) (param $index i32) (param $value i32) (result i32)
    (local $addr i32) (local $prev i32)
    (local.set $addr (call $class_long_addr (local.get $hwnd) (local.get $index)))
    (if (i32.eqz (local.get $addr)) (then (return (i32.const 0))))
    (local.set $prev (i32.load (local.get $addr)))
    (i32.store (local.get $addr) (local.get $value))
    (call $class_long_propagate
      (call $wnd_get_class_slot (local.get $hwnd)) (local.get $index) (local.get $value))
    (local.get $prev))

  ;; One word of a class's extra bytes. `off` is the byte offset the app asked
  ;; for; a class that never declared that many gets nothing rather than the
  ;; next class's storage.
  (func $class_extra_addr (param $slot i32) (param $off i32) (result i32)
    (if (i32.lt_s (local.get $slot) (i32.const 0)) (then (return (i32.const 0))))
    (if (i32.ge_u (local.get $slot) (global.get $MAX_CLASSES)) (then (return (i32.const 0))))
    (if (i32.gt_u (i32.add (local.get $off) (i32.const 2)) (global.get $CLASS_EXTRA_STRIDE))
      (then (return (i32.const 0))))
    (i32.add (i32.add (global.get $CLASS_EXTRA_TABLE)
                      (i32.mul (local.get $slot) (global.get $CLASS_EXTRA_STRIDE)))
             (local.get $off)))

  (func $class_extra_get_word (param $slot i32) (param $off i32) (result i32)
    (local $a i32)
    (local.set $a (call $class_extra_addr (local.get $slot) (local.get $off)))
    (if (i32.eqz (local.get $a)) (then (return (i32.const 0))))
    (i32.load16_u (local.get $a)))

  (func $class_extra_set_word (param $slot i32) (param $off i32) (param $v i32)
    (local $a i32)
    (local.set $a (call $class_extra_addr (local.get $slot) (local.get $off)))
    (if (local.get $a)
      (then (i32.store16 (local.get $a) (i32.and (local.get $v) (i32.const 0xFFFF))))))

  (func $wnd_set_class_cursor_from_name (param $hwnd i32) (param $class_name_guest i32)
    (local $slot i32)
    (local.set $slot (call $class_find_slot (call $class_name_key (local.get $class_name_guest))))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        ;; WNDCLASSA.hCursor is at +24 inside WNDCLASSA, i.e. class record +32.
        (call $wnd_set_class_cursor
          (local.get $hwnd)
          (i32.load offset=32 (call $class_record_addr (local.get $slot)))))))

  ;; ---- CS_OWNDC private device contexts ----
  ;;
  ;; Resolved per window at creation like the class brush and cursor above,
  ;; and for the same reason. The slot holds -1 from creation until the first
  ;; GetDC/BeginPaint, then the DC handle itself; $host_alloc_window_dc hands
  ;; that same handle back on every later request so the objects the app
  ;; selected into it stay selected.
  (func $wnd_own_dc_addr_for_slot (param $slot i32) (result i32)
    (i32.add (global.get $WND_OWN_DC_TABLE) (i32.mul (local.get $slot) (i32.const 4))))

  (func $wnd_own_dc_reset_slot (param $slot i32)
    (local $addr i32) (local $hdc i32)
    (local.set $addr (call $wnd_own_dc_addr_for_slot (local.get $slot)))
    (local.set $hdc (i32.load (local.get $addr)))
    ;; Clear the slot before releasing, so the release does not see the handle
    ;; as still privately owned and decline to free it.
    (i32.store (local.get $addr) (i32.const 0))
    (if (i32.gt_s (local.get $hdc) (i32.const 0))
      (then (drop (call $host_release_dc (local.get $hdc))))))

  (func $wnd_set_own_dc (param $hwnd i32) (param $hdc i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.ne (local.get $idx) (i32.const -1))
      (then (i32.store (call $wnd_own_dc_addr_for_slot (local.get $idx)) (local.get $hdc)))))

  (func $wnd_get_own_dc (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load (call $wnd_own_dc_addr_for_slot (local.get $idx))))

  ;; Is this DC some window's private one? ReleaseDC/EndPaint asks, because a
  ;; private DC outlives both.
  (func $wnd_own_dc_is_private (param $hdc i32) (result i32)
    (local $i i32)
    (if (i32.le_s (local.get $hdc) (i32.const 0))
      (then (return (i32.const 0))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (if (i32.eq (i32.load (call $wnd_own_dc_addr_for_slot (local.get $i)))
                  (local.get $hdc))
        (then (return (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  (func $wnd_set_own_dc_from_name (param $hwnd i32) (param $class_name_guest i32)
    (local $slot i32)
    (local.set $slot (call $class_find_slot (call $class_name_key (local.get $class_name_guest))))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        ;; WNDCLASSA.style is at +0 inside WNDCLASSA, i.e. class record +8.
        (if (i32.and (i32.load offset=8 (call $class_record_addr (local.get $slot)))
                     (i32.const 0x0020))  ;; CS_OWNDC
          (then (call $wnd_set_own_dc (local.get $hwnd) (i32.const -1)))))))

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
      (local.set $h (i32.atomic.load (local.get $ptr)))
      (if (i32.and (i32.ne (local.get $h) (i32.const 0))
                   (i32.eq (load.field.memarg WndRecord parent (local.get $ptr)) (local.get $parent)))
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
      (local.set $h (i32.atomic.load (local.get $ptr)))
      (if (i32.and (i32.ne (local.get $h) (i32.const 0))
                   (i32.eq (load.field.memarg WndRecord parent (local.get $ptr)) (local.get $parent)))
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
    (local.set $parent (load.field.memarg WndRecord parent (call $wnd_record_addr (local.get $idx))))
    (local.set $i (i32.add (local.get $idx) (i32.const 1)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      (local.set $h (i32.atomic.load (local.get $ptr)))
      (if (i32.and (i32.ne (local.get $h) (i32.const 0))
                   (i32.eq (load.field.memarg WndRecord parent (local.get $ptr)) (local.get $parent)))
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
    (local.set $parent (load.field.memarg WndRecord parent (call $wnd_record_addr (local.get $idx))))
    (local.set $i (i32.sub (local.get $idx) (i32.const 1)))
    (block $done (loop $scan
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      (local.set $h (i32.atomic.load (local.get $ptr)))
      (if (i32.and (i32.ne (local.get $h) (i32.const 0))
                   (i32.eq (load.field.memarg WndRecord parent (local.get $ptr)) (local.get $parent)))
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
    (load.field.memarg WndRecord style (call $wnd_record_addr (local.get $idx)))
  )

  ;; Set window style; returns old value
  (func $wnd_set_style (param $hwnd i32) (param $style i32) (result i32)
    (local $idx i32) (local $ptr i32) (local $old i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (local.set $ptr (call $wnd_record_addr (local.get $idx)))
    (local.set $old (load.field.memarg WndRecord style (local.get $ptr)))
    (store.field.memarg WndRecord style (local.get $ptr) (local.get $style))
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
    (load.field.memarg WndRecord state_ptr (call $wnd_record_addr (local.get $idx)))
  )

  ;; Set per-window state pointer
  (func $wnd_set_state_ptr (param $hwnd i32) (param $value i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.ne (local.get $idx) (i32.const -1))
      (then
        (store.field.memarg WndRecord state_ptr (call $wnd_record_addr (local.get $idx)) (local.get $value))))
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

  ;; The classes comctl32 and riched register. Unlike USER's six these have no
  ;; predefined atom -- an app can only name them -- so they are matched as
  ;; strings, on the lowercased LE dwords the rest of this file uses.
  ;;
  ;; Matching is by prefix, deliberately and unchanged from when these lived
  ;; inline in CreateWindowExA: the real class names carry a version suffix
  ;; ("SysTreeView32", "SysListView32") and Win9x shipped A/W aliases of
  ;; several. $wa is a WASM address, never an atom.
  (func $comctl_class_ctrl_id (param $wa i32) (result i32)
    (local $d0 i32) (local $d1 i32)
    (local.set $d0 (i32.or (i32.load (local.get $wa)) (i32.const 0x20202020)))
    (local.set $d1 (i32.or (i32.load offset=4 (local.get $wa)) (i32.const 0x20202020)))
    ;; "syst"+"reev" -> TreeView
    (if (i32.and (i32.eq (local.get $d0) (i32.const 0x74737973))
                 (i32.eq (local.get $d1) (i32.const 0x76656572)))
      (then (return (i32.const 8))))
    ;; "sysl"+"istv" -> ListView
    (if (i32.and (i32.eq (local.get $d0) (i32.const 0x6c737973))
                 (i32.eq (local.get $d1) (i32.const 0x76747369)))
      (then (return (i32.const 18))))
    ;; "sysl"+"ink\0" -> SysLink. The NUL in the mask is what keeps this from
    ;; also matching SysListView32 above.
    (if (i32.and (i32.eq (local.get $d0) (i32.const 0x6c737973))
                 (i32.eq (i32.or (i32.load offset=4 (local.get $wa)) (i32.const 0x00202020))
                         (i32.const 0x006b6e69)))
      (then (return (i32.const 28))))
    ;; "tool"+"tips" -> Tooltip
    (if (i32.and (i32.eq (local.get $d0) (i32.const 0x6c6f6f74))
                 (i32.eq (local.get $d1) (i32.const 0x73706974)))
      (then (return (i32.const 20))))
    ;; "tool"+"barw"+"indo" -> Toolbar
    (if (i32.and (i32.eq (local.get $d0) (i32.const 0x6c6f6f74))
          (i32.and (i32.eq (local.get $d1) (i32.const 0x77726162))
                   (i32.eq (i32.or (i32.load offset=8 (local.get $wa)) (i32.const 0x20202020))
                           (i32.const 0x6f646e69))))
      (then (return (i32.const 21))))
    ;; "msct"+"ls_t" -> the trackbar, and "slid"+"er" -> its Win9x alias.
    ;; 0x747f736c is "ls_t" after the same ASCII-lowercase OR, since '_' is not
    ;; a letter and the mask moves it.
    (if (i32.or
          (i32.and (i32.eq (local.get $d0) (i32.const 0x7463736d))
                   (i32.eq (local.get $d1) (i32.const 0x747f736c)))
          (i32.and (i32.eq (local.get $d0) (i32.const 0x64696c73))
                   (i32.eq (i32.or (i32.load16_u offset=4 (local.get $wa)) (i32.const 0x2020))
                           (i32.const 0x7265))))
      (then (return (i32.const 19))))
    ;; "comb"+"olbo"+"x\0" -> the popup list a combobox drops down, which some
    ;; apps create directly. Same control as a ListBox.
    (if (i32.and (i32.eq (local.get $d0) (i32.const 0x626d6f63))
          (i32.and (i32.eq (local.get $d1) (i32.const 0x6f626c6f))
            (i32.and
              (i32.eq (i32.or (i32.load8_u offset=8 (local.get $wa)) (i32.const 0x20))
                      (i32.const 0x78))
              (i32.eqz (i32.load8_u offset=9 (local.get $wa))))))
      (then (return (i32.const 4))))
    (i32.const 0))

  ;; The one control-class resolver. Give it whatever an app passed as a class
  ;; name -- an atom or a pointer -- and it answers with the
  ;; $control_wndproc_dispatch id, or 0 if this is not a class we implement.
  ;;
  ;; The order matters in one place only: RichEdit is checked before the
  ;; comctl32 names because $richedit_class_version distinguishes 1.0 from
  ;; 2.0+, which a single prefix test cannot. Everything else is disjoint.
  (func $class_name_to_ctrl_id (param $guest i32) (result i32)
    (local $id i32)
    (local.set $id (call $builtin_ctrl_class_id (local.get $guest)))
    (if (local.get $id) (then (return (local.get $id))))
    ;; Past here a class must have a name: nothing below has an atom.
    (if (i32.lt_u (local.get $guest) (i32.const 0x10000))
      (then (return (i32.const 0))))
    (local.set $id (call $richedit_class_version (local.get $guest)))
    (if (i32.eq (local.get $id) (i32.const 1)) (then (return (i32.const 24))))
    (if (i32.eq (local.get $id) (i32.const 2)) (then (return (i32.const 25))))
    (call $comctl_class_ctrl_id (call $g2w (local.get $guest))))

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

  ;; Allocate or replace a class slot for $name_wa. Returns the class atom.
  ;; Locked: the scan and the claim have to be one step, or two threads
  ;; registering different classes at the same moment both take the slot the
  ;; other just took. The atom comes from a shared counter for the same reason —
  ;; as a mutable global it was a private copy per instance, so two threads
  ;; registering two DIFFERENT classes both got 0xC001, and CreateWindowA by
  ;; atom would then build the wrong class's window. Nothing on this path calls
  ;; a host import, which is what makes a spinlock safe here.
  (func $class_table_register_data (param $name_wa i32) (param $wndclass_wa i32) (result i32)
    (local $hash i32) (local $i i32) (local $ptr i32) (local $empty i32) (local $atom i32)
    (local.set $hash (call $class_name_hash (local.get $name_wa)))
    (local.set $empty (i32.const -1))
    (local.set $i (i32.const 0))
    (call $lock_wnd_acquire)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_CLASSES)))
      (local.set $ptr (call $class_record_addr (local.get $i)))
      ;; Existing class — return its atom (caller will overwrite WNDCLASSA via memcpy)
      (if (i32.eq (i32.atomic.load (local.get $ptr)) (local.get $hash))
        (then
          (local.set $atom (i32.load offset=4 (local.get $ptr)))
          (i32.atomic.store (local.get $ptr) (i32.const 0))
          (if (local.get $wndclass_wa)
            (then (call $memcpy (i32.add (local.get $ptr) (i32.const 8))
              (local.get $wndclass_wa) (i32.const 40)))
            (else (call $zero_memory (i32.add (local.get $ptr) (i32.const 8)) (i32.const 40))))
          (i32.atomic.store (local.get $ptr) (local.get $hash))
          (call $lock_wnd_release)
          (return (local.get $atom))))
      ;; Track first empty
      (if (i32.and (i32.eqz (i32.atomic.load (local.get $ptr)))
                   (i32.eq (local.get $empty) (i32.const -1)))
        (then (local.set $empty (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    ;; Insert new class
    (if (i32.ne (local.get $empty) (i32.const -1))
      (then
        (local.set $ptr (call $class_record_addr (local.get $empty)))
        (local.set $atom (i32.add (global.get $CLASS_ATOM_BASE)
          (i32.add (i32.atomic.rmw.add (global.get $SHARED_COUNTERS) (i32.const 1))
                   (i32.const 1))))
        (i32.store offset=4 (local.get $ptr) (local.get $atom))
        (if (local.get $wndclass_wa)
          (then (call $memcpy (i32.add (local.get $ptr) (i32.const 8))
            (local.get $wndclass_wa) (i32.const 40)))
          (else (call $zero_memory (i32.add (local.get $ptr) (i32.const 8)) (i32.const 40))))
        ;; name_hash is the publication word and is written last.
        (i32.atomic.store (local.get $ptr) (local.get $hash))
        (call $lock_wnd_release)
        (return (local.get $atom))))
    (call $lock_wnd_release)
    (i32.const 0)
  )

  (func $class_table_register (param $name_wa i32) (result i32)
    (call $class_table_register_data (local.get $name_wa) (i32.const 0)))

  ;; Find class slot index by name hash; returns slot or -1
  (func $class_find_slot (param $name_wa i32) (result i32)
    (local $hash i32) (local $i i32) (local $ptr i32)
    (local.set $hash (call $class_name_hash (local.get $name_wa)))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_CLASSES)))
      (local.set $ptr (call $class_record_addr (local.get $i)))
      (if (i32.eq (i32.atomic.load (local.get $ptr)) (local.get $hash))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    ;; A small key that named no class by hash is the atom RegisterClass gave
    ;; back, which is a class name everywhere the API takes one. Windows
    ;; returns one and half the world stores it rather than the string: Pipe
    ;; Dream registers "Winpipe", keeps the atom, and creates its window with
    ;; that — and with no atom column consulted the class was not found, so
    ;; the window got the built-in procedure and every message it was sent
    ;; came back to the queue instead of reaching the game.
    ;;
    ;; After the hash scan rather than before it, because a built-in class
    ;; keys on its USER atom in the hash column and must keep answering there.
    (if (i32.lt_u (local.get $name_wa) (i32.const 0x10000))
      (then
        (local.set $i (i32.const 0))
        (block $adone (loop $ascan
          (br_if $adone (i32.ge_u (local.get $i) (global.get $MAX_CLASSES)))
          (local.set $ptr (call $class_record_addr (local.get $i)))
          (if (i32.and (i32.ne (i32.atomic.load (local.get $ptr)) (i32.const 0))
                       (i32.eq (i32.load offset=4 (local.get $ptr))
                               (local.get $name_wa)))
            (then (return (local.get $i))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $ascan)))))
    (i32.const -1))

  ;; Remove an application-registered class. Returns ERROR_SUCCESS, or the
  ;; documented USER error that explains why the class remains registered.
  ;;
  ;; The class and window tables share $LOCK_WND, so the live-window scan and
  ;; removal are one transaction with respect to window/class writers. The
  ;; hash is the class record's publication word and is cleared first; readers
  ;; can no longer discover the record while the remaining fields are reset.
  (func $class_table_unregister (param $name_wa i32) (param $hinstance i32) (result i32)
    (local $hash i32) (local $slot i32) (local $i i32)
    (local $ptr i32) (local $wnd_ptr i32)
    ;; USER's built-in control classes belong to the system, not the caller.
    (if (call $builtin_ctrl_class_id_key (local.get $name_wa))
      (then (return (i32.const 1411)))) ;; ERROR_CLASS_DOES_NOT_EXIST
    (local.set $hash (call $class_name_hash (local.get $name_wa)))
    (local.set $slot (i32.const -1))
    (call $lock_wnd_acquire)
    (block $class_done (loop $class_scan
      (br_if $class_done (i32.ge_u (local.get $i) (global.get $MAX_CLASSES)))
      (local.set $ptr (call $class_record_addr (local.get $i)))
      (if (i32.or
            (i32.eq (i32.atomic.load (local.get $ptr)) (local.get $hash))
            (i32.and
              (i32.lt_u (local.get $name_wa) (i32.const 0x10000))
              (i32.and
                (i32.ne (i32.atomic.load (local.get $ptr)) (i32.const 0))
                (i32.eq (i32.load offset=4 (local.get $ptr))
                        (local.get $name_wa)))))
        (then
          (local.set $slot (local.get $i))
          (br $class_done)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $class_scan)))
    (if (i32.lt_s (local.get $slot) (i32.const 0))
      (then
        (call $lock_wnd_release)
        (return (i32.const 1411)))) ;; ERROR_CLASS_DOES_NOT_EXIST
    (local.set $ptr (call $class_record_addr (local.get $slot)))
    ;; WNDCLASS.hInstance is +16 in the embedded record at +8.
    (if (i32.ne (i32.load offset=24 (local.get $ptr)) (local.get $hinstance))
      (then
        (call $lock_wnd_release)
        (return (i32.const 1411)))) ;; ERROR_CLASS_DOES_NOT_EXIST
    (local.set $i (i32.const 0))
    (block $window_done (loop $window_scan
      (br_if $window_done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $wnd_ptr (call $wnd_record_addr (local.get $i)))
      (if (i32.and
            (i32.ne (i32.atomic.load (local.get $wnd_ptr)) (i32.const 0))
            (i32.eq
              (i32.load8_u (i32.add (global.get $WND_CLASS_SLOT_TABLE) (local.get $i)))
              (local.get $slot)))
        (then
          (call $lock_wnd_release)
          (return (i32.const 1412)))) ;; ERROR_CLASS_HAS_WINDOWS
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $window_scan)))
    (i32.atomic.store (local.get $ptr) (i32.const 0))
    (call $zero_memory (i32.add (local.get $ptr) (i32.const 4)) (i32.const 44))
    (call $zero_memory
      (i32.add (global.get $CLASS_EXTRA_TABLE)
        (i32.mul (local.get $slot) (global.get $CLASS_EXTRA_STRIDE)))
      (global.get $CLASS_EXTRA_STRIDE))
    (call $lock_wnd_release)
    (i32.const 0))

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
        ;; Built-in controls use DefWindowProc for the legacy geometry-message
        ;; epilog after their own WM_WINDOWPOSCHANGED handling.
        (if (i32.eq (local.get $msg) (i32.const 0x0047))
          (then
            (call $windowpos_defproc_geometry
              (local.get $hwnd) (local.get $lParam))))
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
        (if (i32.eq (local.get $msg) (i32.const 0x0047))
          (then
            (call $windowpos_defproc_geometry
              (local.get $hwnd) (local.get $lParam))
            (return (i32.const 0))))
        (return (call $console_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; WM_NCPAINT / WM_NCCALCSIZE default chrome for WAT-native top-levels.
    ;; Help wndproc never overrides these so we take the default directly.
    (if (i32.eq (local.get $msg) (i32.const 0x0047))
      (then
        (call $windowpos_defproc_geometry
          (local.get $hwnd) (local.get $lParam))
        (return (i32.const 0))))
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

  ;; $focus_restore_after_modal(owner) — hand focus back when a modal dialog
  ;; is torn down. USER returns activation to the dialog's owner, and the owner
  ;; hears WM_SETFOCUS; an app that paused itself on the WM_KILLFOCUS the
  ;; dialog caused depends on that message to start again. EmPipe kills its
  ;; game timer on WM_KILLFOCUS and only re-arms it from WM_SETFOCUS (and only
  ;; when GetFocus() already names its own window), so without this every
  ;; "Stage cleared!" box left the game frozen on the stage it had just
  ;; cleared — the app looked like it could not get past level one.
  ;;
  ;; The focus hwnd is set before the message goes out because that is the
  ;; order the app observes: its WM_SETFOCUS handler calls GetFocus() and
  ;; compares. WM_SETFOCUS is posted rather than sent, matching
  ;; $handle_SetFocus, so a teardown running inside a control's wndproc does
  ;; not nest a guest call underneath itself.
  (func $focus_restore_after_modal (param $owner i32)
    (if (i32.eqz (local.get $owner))
      (then (local.set $owner (global.get $main_hwnd))))
    (if (i32.eqz (local.get $owner)) (then (return)))
    ;; Owner must still be a live window.
    (if (i32.eqz (call $wnd_table_get (local.get $owner))) (then (return)))
    ;; Something live already holds the focus — a dialog that deliberately
    ;; handed focus elsewhere before closing keeps it.
    (if (i32.and (i32.ne (global.get $focus_hwnd) (i32.const 0))
                 (i32.ne (call $wnd_table_get (global.get $focus_hwnd)) (i32.const 0)))
      (then (return)))
    (global.set $focus_hwnd (local.get $owner))
    (if (i32.ge_u (call $wnd_table_get (local.get $owner)) (i32.const 0xFFFF0000))
      (then
        (drop (call $wnd_send_message
                (local.get $owner) (i32.const 0x0007) (i32.const 0) (i32.const 0))))
      (else
        (drop (call $post_queue_push
                (local.get $owner) (i32.const 0x0007) (i32.const 0) (i32.const 0)))))
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

  ;; EnableScrollBar state is packed into one byte per window. $vert selects
  ;; the high or low two-bit ESB_* field; the stored values intentionally use
  ;; the public constants so testing one arrow is just testing bit 0 or bit 1.
  (func $scroll_arrow_mask_slot (param $slot i32) (param $vert i32) (result i32)
    (i32.and
      (i32.shr_u
        (i32.load8_u (i32.add (global.get $SCROLL_ARROW_TABLE) (local.get $slot)))
        (select (i32.const 2) (i32.const 0) (local.get $vert)))
      (i32.const 3)))

  (func $scroll_arrow_mask (param $hwnd i32) (param $vert i32) (result i32)
    (local $slot i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.lt_s (local.get $slot) (i32.const 0))
      (then (return (i32.const 0))))
    (call $scroll_arrow_mask_slot (local.get $slot) (local.get $vert)))

  ;; Store one ESB_* field without disturbing the perpendicular bar. Returns
  ;; TRUE only when the state changed, matching EnableScrollBar's contract.
  (func $scroll_arrow_set_slot (param $slot i32) (param $vert i32)
      (param $arrows i32) (result i32)
    (local $addr i32) (local $old_byte i32) (local $shift i32)
    (local $field_mask i32) (local $new_byte i32)
    (local.set $addr (i32.add (global.get $SCROLL_ARROW_TABLE) (local.get $slot)))
    (local.set $old_byte (i32.load8_u (local.get $addr)))
    (local.set $shift (select (i32.const 2) (i32.const 0) (local.get $vert)))
    (local.set $field_mask (i32.shl (i32.const 3) (local.get $shift)))
    (local.set $new_byte
      (i32.or
        (i32.and (local.get $old_byte) (i32.xor (local.get $field_mask) (i32.const -1)))
        (i32.shl (i32.and (local.get $arrows) (i32.const 3)) (local.get $shift))))
    (if (i32.eq (local.get $new_byte) (local.get $old_byte))
      (then (return (i32.const 0))))
    (i32.store8 (local.get $addr) (local.get $new_byte))
    (i32.const 1))

  ;; Turn a geometric scrollbar hit into no hit when EnableScrollBar disabled
  ;; that arrow. Track/page/thumb input remains available, as on USER32.
  (func $scroll_arrow_filter_hit (param $hwnd i32) (param $vert i32)
      (param $part i32) (result i32)
    (local $mask i32)
    (local.set $mask (call $scroll_arrow_mask (local.get $hwnd) (local.get $vert)))
    (if (i32.and
          (i32.eq (local.get $part) (i32.const 1))
          (i32.ne (i32.and (local.get $mask) (i32.const 1)) (i32.const 0)))
      (then (return (i32.const 0))))
    (if (i32.and
          (i32.eq (local.get $part) (i32.const 2))
          (i32.ne (i32.and (local.get $mask) (i32.const 2)) (i32.const 0)))
      (then (return (i32.const 0))))
    (local.get $part))

  ;; Publish a control-owned vertical viewport through the standard Win32
  ;; scrollbar APIs. Common controls keep their row state privately, but
  ;; GetScrollPos/GetScrollRange/GetScrollInfo still read these shared tables.
  (func $scroll_publish_vertical_info (param $hwnd i32) (param $pos i32)
      (param $total i32) (param $visible i32)
    (local $slot i32) (local $base i32) (local $aux i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.lt_s (local.get $slot) (i32.const 0)) (then (return)))
    (if (i32.lt_s (local.get $total) (i32.const 1))
      (then (local.set $total (i32.const 1))))
    (if (i32.lt_s (local.get $visible) (i32.const 1))
      (then (local.set $visible (i32.const 1))))
    (local.set $base (call $scroll_bar_addr (local.get $slot) (i32.const 1)))
    (local.set $aux (call $scroll_aux_bar_addr (local.get $slot) (i32.const 1)))
    (i32.store          (local.get $base) (local.get $pos))
    (i32.store offset=4 (local.get $base) (i32.const 0))
    (i32.store offset=8 (local.get $base) (i32.sub (local.get $total) (i32.const 1)))
    (i32.store          (local.get $aux) (local.get $visible))
    (i32.store offset=4 (local.get $aux) (local.get $pos)))

  ;; Zero one slot's scroll state. Called from the slot-reset path so a reused
  ;; hwnd does not inherit the previous window's scroll range.
  (func $scroll_reset_slot (param $slot i32)
    (call $zero_memory (call $scroll_record_addr (local.get $slot)) (i32.const 24))
    (call $zero_memory (call $scroll_aux_addr (local.get $slot)) (i32.const 16))
    (i32.store8 (i32.add (global.get $SCROLL_ARROW_TABLE) (local.get $slot)) (i32.const 0)))
