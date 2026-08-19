  ;; ============================================================
  ;; CONTROL TABLE + BUILT-IN CONTROL WNDPROCS
  ;; ============================================================
  ;;
  ;; Two parallel mechanisms exist during the controls refactor:
  ;;
  ;;   (a) CONTROL_TABLE at WASM 0x2980 — legacy parallel array
  ;;       indexed by window slot. Holds (ctrl_class, ctrl_id, check_state).
  ;;       Populated by handle_CreateDialogParamA when JS creates a dialog
  ;;       template; consulted by BM_GETCHECK / BM_SETCHECK as a fallback.
  ;;       Slated for deletion in STEP 5+ once dialogs are built from WAT.
  ;;
  ;;   (b) Per-window state struct (ButtonState / StaticState / ...)
  ;;       allocated in $heap_alloc and pointed to by WND_RECORDS.state_ptr
  ;;       (via $wnd_set_state_ptr). Allocated in WM_CREATE, freed in
  ;;       WM_DESTROY. This is the new model — when state_ptr != 0 the
  ;;       wndproc treats this control as fully owned by WAT.
  ;;
  ;; ctrl_class values: 0=not a control, 1=Button, 2=Edit, 3=Static,
  ;;                    4=ListBox, 5=ComboBox, 6=ColorGrid, 7=ScrollBar,
  ;;                    8=TreeView, 9=Combo popup, 10+=WAT-built dialogs,
  ;;                    17=ProgressBar, 18=ListView, 19=TrackBar,
  ;;                    20=Tooltip, 21=Toolbar

  ;; ---- Per-class state struct layouts ----
  ;;
  ;; ButtonState (72 bytes, allocated in WM_CREATE)
  ;;   +0   text_buf_ptr   guest ptr from $heap_alloc (0 = no text)
  ;;   +4   text_len       chars, no NUL
  ;;   +8   flags          bit0=pressed   bit1=checked
  ;;                       bit2=default   (current paint default — flips on focus)
  ;;                       bit3=focused
  ;;   +12  ctrl_id
  ;;   +16..+63  legacy embedded DRAWITEMSTRUCT scratch
  ;;   +64  image_type     IMAGE_BITMAP=0
  ;;   +68  image_handle   HBITMAP from BM_SETIMAGE
  ;;
  ;; StaticState (16 bytes)
  ;;   +0   text_buf_ptr
  ;;   +4   text_len
  ;;   +8   style          (SS_LEFT=0, SS_CENTER=1, SS_RIGHT=2, SS_ICON=3 ...)
  ;;   +12  image resource ordinal (SS_ICON/SS_BITMAP), or 0
  ;;
  ;; ProgressState (16 bytes)
  ;;   +0   min
  ;;   +4   max
  ;;   +8   pos
  ;;   +12  step
  ;;
  ;; The wndproc that allocates the state struct in WM_CREATE is responsible
  ;; for freeing it AND any sub-allocations (text_buf_ptr) in WM_DESTROY,
  ;; then calling $wnd_set_state_ptr(hwnd, 0).

  ;; Dialog mouse capture for WAT-managed buttons. Browser mouseup coordinates
  ;; can drift from the mousedown point; deliver the release to the pressed
  ;; button so owner-draw controls always clear ODS_SELECTED.
  (global $dialog_button_capture_parent (mut i32) (i32.const 0))
  (global $dialog_button_capture_hwnd (mut i32) (i32.const 0))
  (global $edit_sb_drag_anchor_y (mut i32) (i32.const 0))
  (global $edit_sb_drag_anchor_top (mut i32) (i32.const 0))
  (global $lv_debug_notify_count (mut i32) (i32.const 0))
  (global $lv_debug_notify_code (mut i32) (i32.const 0))
  (global $lv_debug_notify_item (mut i32) (i32.const -1))
  (global $lv_debug_notify_old_state (mut i32) (i32.const 0))
  (global $lv_debug_notify_new_state (mut i32) (i32.const 0))

  ;; Copy a NUL-terminated string from a WASM-linear address into a fresh
  ;; heap-allocated guest buffer. Returns the guest pointer (suitable for
  ;; passing as $text_wa to $ctrl_create_child, which then ends up in
  ;; CREATESTRUCT.lpszName for the wndproc to read in WM_CREATE).
  ;; $len excludes NUL.
  (func $wat_str_to_heap (param $wa i32) (param $len i32) (result i32)
    (local $buf i32) (local $bw i32) (local $i i32)
    (local.set $buf (call $heap_alloc (i32.add (local.get $len) (i32.const 1))))
    (local.set $bw (call $g2w (local.get $buf)))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (i32.store8 (i32.add (local.get $bw) (local.get $i))
        (i32.load8_u (i32.add (local.get $wa) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (i32.store8 (i32.add (local.get $bw) (local.get $len)) (i32.const 0))
    (local.get $buf))

  ;; ---- Control geometry table helpers (CONTROL_GEOM) ----
  ;; Each entry: 8 bytes = (i16 x, i16 y, i16 w, i16 h), parent-relative.
  ;; Indexed by window slot (same index as CONTROL_TABLE / WND_RECORDS).

  (func $ctrl_geom_addr (param $slot i32) (result i32)
    (i32.add (global.get $CONTROL_GEOM) (i32.mul (local.get $slot) (i32.const 8))))

  (func $ctrl_geom_set
    (param $slot i32) (param $x i32) (param $y i32) (param $w i32) (param $h i32)
    (local $a i32)
    (local.set $a (call $ctrl_geom_addr (local.get $slot)))
    (i32.store16        (local.get $a) (local.get $x))
    (i32.store16 offset=2 (local.get $a) (local.get $y))
    (i32.store16 offset=4 (local.get $a) (local.get $w))
    (i32.store16 offset=6 (local.get $a) (local.get $h)))

  ;; Keep CONTROL_GEOM in sync with MoveWindow/SetWindowPos for WAT-managed
  ;; controls and child dialogs. $flags uses SWP_NOSIZE(1) / SWP_NOMOVE(2)
  ;; like SetWindowPos; MoveWindow callers pass 0. No-op only for true
  ;; top-level/non-WAT windows. Dialog windows have class==0 but a parent.
  (func $ctrl_geom_sync
        (param $hwnd i32) (param $x i32) (param $y i32) (param $w i32) (param $h i32) (param $flags i32)
    (local $idx i32) (local $a i32) (local $parent i32) (local $moved i32)
    (local $ox i32) (local $oy i32) (local $ow i32) (local $oh i32)
    (local $hdc i32) (local $brush i32) (local $slot i32)
    (if (i32.and
          (i32.eqz (call $ctrl_table_get_class (local.get $hwnd)))
          (i32.eqz (call $wnd_get_parent (local.get $hwnd))))
      (then (return)))
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return)))
    (local.set $a (call $ctrl_geom_addr (local.get $idx)))
    (if (i32.eqz (i32.and (local.get $flags) (i32.const 2)))
      (then
        ;; A control that moves leaves its old pixels behind: children have no
        ;; surface of their own, they draw onto the parent's back-canvas, so
        ;; nothing repaints the rectangle it vacated. Win32 erases the parent
        ;; over the uncovered region for exactly this reason. fontview.exe
        ;; right-aligns its Print button on startup, and the strip it moved off
        ;; stayed on screen as a slice of a second button.
        ;;
        ;; Only for WAT-native controls, whose pixels WAT owns and must
        ;; therefore clean up after. An application's own child window paints
        ;; itself from its own WM_PAINT and lays itself out against siblings
        ;; this code knows nothing about; erasing under one of those with the
        ;; parent's brush wipes application output that nothing will redraw.
        ;; mspaint moves its canvas and toolbars during startup layout and the
        ;; ungated erase blanked its client area.
        (local.set $ox (i32.load16_s (local.get $a)))
        (local.set $oy (i32.load16_s offset=2 (local.get $a)))
        (local.set $ow (i32.load16_u offset=4 (local.get $a)))
        (local.set $oh (i32.load16_u offset=6 (local.get $a)))
        (local.set $moved (i32.or
          (i32.ne (local.get $ox) (local.get $x))
          (i32.ne (local.get $oy) (local.get $y))))
        (i32.store16        (local.get $a) (local.get $x))
        (i32.store16 offset=2 (local.get $a) (local.get $y))
        (if (i32.and
              (i32.and
                (local.get $moved)
                (i32.ne (call $ctrl_table_get_class (local.get $hwnd)) (i32.const 0)))
              (i32.and (i32.gt_s (local.get $ow) (i32.const 0))
                       (i32.gt_s (local.get $oh) (i32.const 0))))
          (then
            (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
            (if (local.get $parent)
              (then
                ;; CONTROL_GEOM is parent-client relative, which is what a
                ;; client DC on the parent draws in.
                (local.set $hdc
                  (call $host_alloc_window_dc (local.get $parent) (i32.const 0)))
                (if (local.get $hdc)
                  (then
                    (local.set $brush (call $wnd_get_bg_brush (local.get $parent)))
                    (if (i32.eqz (local.get $brush))
                      (then (local.set $brush (i32.const 0x30011)))) ;; COLOR_3DFACE
                    (drop (call $host_gdi_fill_rect (local.get $hdc)
                      (local.get $ox) (local.get $oy)
                      (i32.add (local.get $ox) (local.get $ow))
                      (i32.add (local.get $oy) (local.get $oh))
                      (local.get $brush)))
                    (drop (call $host_release_dc (local.get $hdc)))))
                (call $invalidate_hwnd (local.get $parent))
                ;; A sibling may overlap what was just erased, so repaint the
                ;; whole set rather than leaving a hole where one of them was.
                (local.set $slot (i32.const 0))
                (block $sib_done (loop $sib
                  (local.set $slot
                    (call $wnd_next_child_slot (local.get $parent) (local.get $slot)))
                  (br_if $sib_done (i32.eq (local.get $slot) (i32.const -1)))
                  (call $invalidate_hwnd (call $wnd_slot_hwnd (local.get $slot)))
                  (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
                  (br $sib)))))))))
    (if (i32.eqz (i32.and (local.get $flags) (i32.const 1)))
      (then
        (i32.store16 offset=4 (local.get $a) (local.get $w))
        (i32.store16 offset=6 (local.get $a) (local.get $h)))))

  ;; Pack x|y<<16 / w|h<<16 for export to JS.
  (func $ctrl_get_xy_packed (param $hwnd i32) (result i32)
    (local $idx i32) (local $a i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return (i32.const 0))))
    (local.set $a (call $ctrl_geom_addr (local.get $idx)))
    (i32.or (i32.load16_u (local.get $a))
            (i32.shl (i32.load16_u offset=2 (local.get $a)) (i32.const 16))))

  (func $ctrl_get_wh_packed (param $hwnd i32) (result i32)
    (local $idx i32) (local $a i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return (i32.const 0))))
    (local.set $a (call $ctrl_geom_addr (local.get $idx)))
    (i32.or (i32.load16_u offset=4 (local.get $a))
            (i32.shl (i32.load16_u offset=6 (local.get $a)) (i32.const 16))))

  ;; The width and height halves of $ctrl_get_wh_packed. Nearly every control
  ;; wndproc starts by unpacking that word into two locals with the same two
  ;; shifts and masks, ~30 times across this file; a caller that only wants one
  ;; dimension had to write both. Named accessors so the packing is stated once.
  (func $ctrl_get_w (param $hwnd i32) (result i32)
    (i32.and (call $ctrl_get_wh_packed (local.get $hwnd)) (i32.const 0xFFFF)))

  (func $ctrl_get_h (param $hwnd i32) (result i32)
    (i32.shr_u (call $ctrl_get_wh_packed (local.get $hwnd)) (i32.const 16)))

  ;; ---- Control table helpers (legacy CONTROL_TABLE) ----

  ;; Mark a registered native status-bar window without classifying it as a
  ;; WAT control. Its guest comctl32/MFC wndproc must remain authoritative for
  ;; CCS_BOTTOM layout, while the shared renderer surface still needs WAT to
  ;; cover stale pixels when WM_PAINT is dispatched.
  (func $statusbar_native_mark_slot (param $slot i32) (param $marked i32)
    (local $addr i32) (local $mask i32) (local $value i32)
    (if (i32.or (i32.lt_s (local.get $slot) (i32.const 0))
                (i32.ge_u (local.get $slot) (global.get $MAX_WINDOWS)))
      (then (return)))
    (local.set $addr
      (i32.add (global.get $NATIVE_STATUS_BITS)
        (i32.shr_u (local.get $slot) (i32.const 3))))
    (local.set $mask
      (i32.shl (i32.const 1) (i32.and (local.get $slot) (i32.const 7))))
    (local.set $value (i32.load8_u (local.get $addr)))
    (i32.store8 (local.get $addr)
      (if (result i32) (local.get $marked)
        (then (i32.or (local.get $value) (local.get $mask)))
        (else (i32.and (local.get $value) (i32.xor (local.get $mask) (i32.const 0xFF)))))))

  (func $statusbar_native_is (param $hwnd i32) (result i32)
    (local $slot i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.lt_s (local.get $slot) (i32.const 0))
      (then (return (i32.const 0))))
    (i32.and
      (i32.shr_u
        (i32.load8_u
          (i32.add (global.get $NATIVE_STATUS_BITS)
            (i32.shr_u (local.get $slot) (i32.const 3))))
        (i32.and (local.get $slot) (i32.const 7)))
      (i32.const 1)))

  ;; Hybrid SysTabControl32 marker. The real COMCTL32 wndproc remains installed
  ;; for TCM_ADJUSTRECT, page switching, and hit-testing; WAT mirrors only the
  ;; short tab labels/selection needed to paint Win98 chrome on the shared
  ;; parent surface.
  (func $tab_native_mark_slot (param $slot i32) (param $marked i32)
    (local $addr i32) (local $mask i32) (local $value i32)
    (if (i32.or (i32.lt_s (local.get $slot) (i32.const 0))
                (i32.ge_u (local.get $slot) (global.get $MAX_WINDOWS)))
      (then (return)))
    (local.set $addr
      (i32.add (global.get $NATIVE_TAB_BITS)
        (i32.shr_u (local.get $slot) (i32.const 3))))
    (local.set $mask
      (i32.shl (i32.const 1) (i32.and (local.get $slot) (i32.const 7))))
    (local.set $value (i32.load8_u (local.get $addr)))
    (i32.store8 (local.get $addr)
      (if (result i32) (local.get $marked)
        (then (i32.or (local.get $value) (local.get $mask)))
        (else (i32.and (local.get $value) (i32.xor (local.get $mask) (i32.const 0xFF)))))))

  (func $tab_native_is (param $hwnd i32) (result i32)
    (local $slot i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.lt_s (local.get $slot) (i32.const 0))
      (then (return (i32.const 0))))
    (i32.and
      (i32.shr_u
        (i32.load8_u
          (i32.add (global.get $NATIVE_TAB_BITS)
            (i32.shr_u (local.get $slot) (i32.const 3))))
        (i32.and (local.get $slot) (i32.const 7)))
      (i32.const 1)))

  ;; COMCTL32 owns the ordinary per-window state pointer. Keep our paint mirror
  ;; separate so observing TCM_* messages cannot corrupt its WM_CREATE state.
  (func $tab_native_state_get (param $hwnd i32) (param $create i32) (result i32)
    (local $i i32) (local $addr i32) (local $empty i32) (local $state i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (i32.const 32)))
      (local.set $addr (i32.add (global.get $TAB_NATIVE_STATE_TABLE)
        (i32.mul (local.get $i) (i32.const 8))))
      (if (i32.eq (i32.load (local.get $addr)) (local.get $hwnd))
        (then (return (i32.load offset=4 (local.get $addr)))))
      (if (i32.and (i32.eqz (local.get $empty))
                   (i32.eqz (i32.load (local.get $addr))))
        (then (local.set $empty (local.get $addr))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.or (i32.eqz (local.get $create)) (i32.eqz (local.get $empty)))
      (then (return (i32.const 0))))
    (local.set $state (call $heap_alloc (i32.const 128)))
    (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
    (call $zero_memory (call $g2w (local.get $state)) (i32.const 128))
    (i32.store (local.get $empty) (local.get $hwnd))
    (i32.store offset=4 (local.get $empty) (local.get $state))
    (local.get $state))

  ;; Selected tab, or -1 when this window has no mirror state yet. The mirror
  ;; is updated by $tab_native_note_message before any wndproc sees the click,
  ;; so a WAT-owned tab strip can read its own new selection on WM_LBUTTONDOWN.
  (func $tab_native_cursel (param $hwnd i32) (result i32)
    (local $state i32)
    (local.set $state (call $tab_native_state_get (local.get $hwnd) (i32.const 0)))
    (if (i32.eqz (local.get $state)) (then (return (i32.const -1))))
    (i32.load offset=4 (call $g2w (local.get $state))))

  (func $tab_native_state_release (param $hwnd i32)
    (local $i i32) (local $addr i32) (local $state i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (i32.const 32)))
      (local.set $addr (i32.add (global.get $TAB_NATIVE_STATE_TABLE)
        (i32.mul (local.get $i) (i32.const 8))))
      (if (i32.eq (i32.load (local.get $addr)) (local.get $hwnd))
        (then
          (local.set $state (i32.load offset=4 (local.get $addr)))
          (if (local.get $state) (then (call $heap_free (local.get $state))))
          (i64.store (local.get $addr) (i64.const 0))
          (return)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan))))

  ;; Tab mirror state is 128 inline bytes: count@0, selected@4, followed by
  ;; eight 15-byte records {len:u8, text[14]}. No secondary allocations are
  ;; needed. It lives in TAB_NATIVE_STATE_TABLE, not COMCTL32's window state.
  (func $tab_native_note_message
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32)
    (local $state i32) (local $sw i32) (local $item_w i32)
    (local $count i32) (local $index i32) (local $i i32) (local $j i32)
    (local $src i32) (local $dst i32) (local $text_g i32) (local $text_w i32)
    (local $len i32) (local $x i32) (local $left i32) (local $right i32)
    (if (i32.eqz (call $tab_native_is (local.get $hwnd))) (then (return)))
    ;; Do not allocate while forwarding WM_CREATE or unrelated private traffic.
    ;; TCM_INSERTITEMW (0x133E) matters as much as the A form: a Unicode app
    ;; adds its tabs through it and only through it, so mirroring just the A
    ;; message left the state at zero tabs and $tab_native_paint drew an empty
    ;; strip -- XP Sound Recorder's File > Properties showed no "Details" tab.
    (if (i32.and
          (i32.and
            (i32.ne (local.get $msg) (i32.const 0x1307))
            (i32.ne (local.get $msg) (i32.const 0x133E)))
          (i32.and
            (i32.ne (local.get $msg) (i32.const 0x1309))
            (i32.and
              (i32.ne (local.get $msg) (i32.const 0x130C))
              (i32.ne (local.get $msg) (i32.const 0x0201)))))
      (then (return)))
    (local.set $state (call $tab_native_state_get (local.get $hwnd) (i32.const 1)))
    (if (i32.eqz (local.get $state)) (then (return)))
    (local.set $sw (call $g2w (local.get $state)))
    (local.set $count (i32.load (local.get $sw)))
    ;; TCM_INSERTITEMA / TCM_INSERTITEMW — TCITEMA and TCITEMW share their
    ;; layout (pszText at +12); only the string's width differs.
    (if (i32.or (i32.eq (local.get $msg) (i32.const 0x1307))
                (i32.eq (local.get $msg) (i32.const 0x133E)))
      (then
        (if (i32.ge_u (local.get $count) (i32.const 8)) (then (return)))
        (local.set $index (local.get $wParam))
        (if (i32.gt_u (local.get $index) (local.get $count))
          (then (local.set $index (local.get $count))))
        ;; Shift later fixed records back one slot. Copy each record from its
        ;; last byte so the overlapping inline move is safe.
        (local.set $i (local.get $count))
        (block $shift_done (loop $shift
          (br_if $shift_done (i32.le_u (local.get $i) (local.get $index)))
          (local.set $src (i32.add (i32.add (local.get $sw) (i32.const 8))
            (i32.mul (i32.sub (local.get $i) (i32.const 1)) (i32.const 15))))
          (local.set $dst (i32.add (local.get $src) (i32.const 15)))
          (local.set $j (i32.const 14))
          (block $bytes_done (loop $bytes
            (i32.store8 (i32.add (local.get $dst) (local.get $j))
              (i32.load8_u (i32.add (local.get $src) (local.get $j))))
            (br_if $bytes_done (i32.eqz (local.get $j)))
            (local.set $j (i32.sub (local.get $j) (i32.const 1)))
            (br $bytes)))
          (local.set $i (i32.sub (local.get $i) (i32.const 1)))
          (br $shift)))
        (local.set $dst (i32.add (i32.add (local.get $sw) (i32.const 8))
          (i32.mul (local.get $index) (i32.const 15))))
        (call $zero_memory (local.get $dst) (i32.const 15))
        (if (local.get $lParam)
          (then
            (local.set $item_w (call $g2w (local.get $lParam)))
            (if (i32.and (i32.load (local.get $item_w)) (i32.const 1)) ;; TCIF_TEXT
              (then
                (local.set $text_g (i32.load offset=12 (local.get $item_w)))
                (if (local.get $text_g)
                  (then
                    (local.set $text_w (call $g2w (local.get $text_g)))
                    (if (i32.eq (local.get $msg) (i32.const 0x133E))
                      (then
                        ;; Narrow the label straight into the fixed record.
                        (local.set $len (call $guest_wcslen (local.get $text_g)))
                        (if (i32.gt_u (local.get $len) (i32.const 14))
                          (then (local.set $len (i32.const 14))))
                        (i32.store8 (local.get $dst) (local.get $len))
                        (local.set $j (i32.const 0))
                        (block $wdone (loop $wcopy
                          (br_if $wdone (i32.ge_u (local.get $j) (local.get $len)))
                          (i32.store8
                            (i32.add (i32.add (local.get $dst) (i32.const 1)) (local.get $j))
                            (call $gl16 (i32.add (local.get $text_g)
                              (i32.mul (local.get $j) (i32.const 2)))))
                          (local.set $j (i32.add (local.get $j) (i32.const 1)))
                          (br $wcopy))))
                      (else
                        (local.set $len (call $strlen (local.get $text_w)))
                        (if (i32.gt_u (local.get $len) (i32.const 14))
                          (then (local.set $len (i32.const 14))))
                        (i32.store8 (local.get $dst) (local.get $len))
                        (if (local.get $len)
                          (then (call $memcpy (i32.add (local.get $dst) (i32.const 1))
                            (local.get $text_w) (local.get $len))))))))))))
        (i32.store (local.get $sw) (i32.add (local.get $count) (i32.const 1)))
        (call $paint_flag_set_inv (local.get $hwnd))
        (return)))
    ;; TCM_DELETEALLITEMS
    (if (i32.eq (local.get $msg) (i32.const 0x1309))
      (then
        (i32.store (local.get $sw) (i32.const 0))
        (i32.store offset=4 (local.get $sw) (i32.const 0))
        (call $paint_flag_set_inv (local.get $hwnd))
        (return)))
    ;; TCM_SETCURSEL
    (if (i32.eq (local.get $msg) (i32.const 0x130C))
      (then
        (if (i32.lt_u (local.get $wParam) (local.get $count))
          (then (i32.store offset=4 (local.get $sw) (local.get $wParam))))
        (call $paint_flag_set_inv (local.get $hwnd))
        (return)))
    ;; Mirror direct mouse selection while the guest proc remains authoritative.
    (if (i32.eq (local.get $msg) (i32.const 0x0201))
      (then
        (local.set $x (i32.and (local.get $lParam) (i32.const 0xFFFF)))
        (local.set $i (i32.const 0))
        (local.set $left (i32.const 0))
        (block $hit_done (loop $hit
          (br_if $hit_done (i32.ge_u (local.get $i) (local.get $count)))
          (local.set $src (i32.add (i32.add (local.get $sw) (i32.const 8))
            (i32.mul (local.get $i) (i32.const 15))))
          (local.set $right (i32.add (local.get $left)
            (i32.add (i32.mul (i32.load8_u (local.get $src)) (i32.const 5)) (i32.const 16))))
          (if (i32.and (i32.ge_u (local.get $x) (local.get $left))
                       (i32.lt_u (local.get $x) (local.get $right)))
            (then
              (i32.store offset=4 (local.get $sw) (local.get $i))
              (call $paint_flag_set_inv (local.get $hwnd))
              (br $hit_done)))
          (local.set $left (local.get $right))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $hit)))))
    )

  (func $tab_native_paint (param $hwnd i32) (result i32)
    (local $state i32) (local $sw i32) (local $hdc i32) (local $sz i32)
    (local $w i32) (local $h i32) (local $count i32) (local $selected i32)
    (local $i i32) (local $rec i32) (local $len i32)
    (local $left i32) (local $right i32) (local $top i32)
    (local.set $state (call $tab_native_state_get (local.get $hwnd) (i32.const 0)))
    (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
    (local.set $sw (call $g2w (local.get $state)))
    (local.set $count (i32.load (local.get $sw)))
    (local.set $selected (i32.load offset=4 (local.get $sw)))
    (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
    (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
    (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
    (if (i32.or (i32.eqz (local.get $w)) (i32.eqz (local.get $h)))
      (then (return (i32.const 0))))
    (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
    ;; Only clear the chrome strip. Child pages paint into this common backing
    ;; surface too, and a late tab repaint must not erase their topic tree.
    (drop (call $host_gdi_fill_rect (local.get $hdc)
      (i32.const 0) (i32.const 0) (local.get $w) (i32.const 21) (i32.const 0x30011)))
    ;; Native Win98 tabs use a 20px row and merge the selected tab into the
    ;; raised page frame beneath it.
    (drop (call $host_gdi_draw_edge (local.get $hdc)
      (i32.const 0) (i32.const 19) (local.get $w) (local.get $h)
      (i32.const 0x05) (i32.const 0x0F)))
    (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))
    (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))
    (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0)))
    (local.set $i (i32.const 0))
    (local.set $left (i32.const 0))
    (block $done (loop $tabs
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $rec (i32.add (i32.add (local.get $sw) (i32.const 8))
        (i32.mul (local.get $i) (i32.const 15))))
      (local.set $len (i32.load8_u (local.get $rec)))
      (local.set $right (i32.add (local.get $left)
        (i32.add (i32.mul (local.get $len) (i32.const 5)) (i32.const 16))))
      (local.set $top (select (i32.const 0) (i32.const 2)
        (i32.eq (local.get $i) (local.get $selected))))
      (drop (call $host_gdi_fill_rect (local.get $hdc)
        (local.get $left) (local.get $top) (local.get $right) (i32.const 20)
        (i32.const 0x30011)))
      (drop (call $host_gdi_draw_edge (local.get $hdc)
        (local.get $left) (local.get $top) (local.get $right) (i32.const 20)
        (i32.const 0x05) (i32.const 0x07))) ;; BF_LEFT|TOP|RIGHT
      (if (i32.eq (local.get $i) (local.get $selected))
        (then
          ;; Erase the page's top edge under the selected tab.
          (drop (call $host_gdi_fill_rect (local.get $hdc)
            (i32.add (local.get $left) (i32.const 2)) (i32.const 18)
            (i32.sub (local.get $right) (i32.const 2)) (i32.const 21)
            (i32.const 0x30011)))))
      (if (local.get $len)
        (then
          (drop (call $host_gdi_text_out (local.get $hdc)
            (i32.add (local.get $left) (i32.const 8))
            (i32.add (local.get $top) (i32.const 3))
            (i32.add (local.get $rec) (i32.const 1)) (local.get $len) (i32.const 0)))))
      (local.set $left (local.get $right))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $tabs)))
    (i32.const 1))

  ;; Set control class and ID for a window table slot
  (func $ctrl_table_set (param $slot i32) (param $class i32) (param $ctrl_id i32)
    (local $addr i32)
    (local.set $addr (i32.add (global.get $CONTROL_TABLE) (i32.mul (local.get $slot) (i32.const 16))))
    (i32.store (local.get $addr) (local.get $class))
    (i32.store (i32.add (local.get $addr) (i32.const 4)) (local.get $ctrl_id))
    (i32.store (i32.add (local.get $addr) (i32.const 8)) (i32.const 0))  ;; check_state = 0
    (i32.store (i32.add (local.get $addr) (i32.const 12)) (i32.const 0)) ;; ex_style
  )

  ;; Clear per-slot WAT control metadata when WND_RECORDS reuses a slot.
  (func $ctrl_table_reset_slot (param $slot i32)
    (local $addr i32)
    (call $tab_native_state_release (call $wnd_slot_hwnd (local.get $slot)))
    (call $statusbar_native_mark_slot (local.get $slot) (i32.const 0))
    (call $tab_native_mark_slot (local.get $slot) (i32.const 0))
    (local.set $addr (i32.add (global.get $CONTROL_TABLE) (i32.mul (local.get $slot) (i32.const 16))))
    (i64.store (local.get $addr) (i64.const 0))
    (i64.store offset=8 (local.get $addr) (i64.const 0))
    (local.set $addr (i32.add (global.get $CONTROL_GEOM) (i32.mul (local.get $slot) (i32.const 8))))
    (i64.store (local.get $addr) (i64.const 0)))

  ;; Per-control WS_EX_* flags. Stored in CONTROL_TABLE+12 by $dlg_load
  ;; so static_wndproc / button_wndproc can render WS_EX_CLIENTEDGE etc.
  (func $ctrl_set_ex_style (param $hwnd i32) (param $ex i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.ne (local.get $idx) (i32.const -1))
      (then
        (i32.store (i32.add (i32.add (global.get $CONTROL_TABLE)
                              (i32.mul (local.get $idx) (i32.const 16)))
                            (i32.const 12))
          (local.get $ex)))))
  (func $ctrl_get_ex_style (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return (i32.const 0))))
    (i32.load (i32.add (i32.add (global.get $CONTROL_TABLE)
                                  (i32.mul (local.get $idx) (i32.const 16)))
                              (i32.const 12))))

  ;; Get control class for a hwnd (returns 0 if not a control)
  (func $ctrl_table_get_class (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load (i32.add (global.get $CONTROL_TABLE) (i32.mul (local.get $idx) (i32.const 16))))
  )

  (func $ctrl_table_get_id (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load offset=4
      (i32.add (global.get $CONTROL_TABLE) (i32.mul (local.get $idx) (i32.const 16)))))

  ;; Change a child window's control/menu ID and return its previous value.
  ;; MFC temporarily renames views while installing Print Preview, then finds
  ;; the saved view by its replacement ID when preview closes.
  (func $ctrl_table_set_id (param $hwnd i32) (param $ctrl_id i32) (result i32)
    (local $idx i32) (local $addr i32) (local $old i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (local.set $addr
      (i32.add (global.get $CONTROL_TABLE)
        (i32.mul (local.get $idx) (i32.const 16))))
    (local.set $old (i32.load offset=4 (local.get $addr)))
    (i32.store offset=4 (local.get $addr) (local.get $ctrl_id))
    (local.get $old))

  ;; Get check state for a control hwnd (legacy CONTROL_TABLE path)
  (func $ctrl_get_check_state (param $hwnd i32) (result i32)
    (local $idx i32) (local $state i32)
    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (local.get $state)
      (then
        (return (i32.and
          (i32.shr_u (i32.load offset=8 (call $g2w (local.get $state))) (i32.const 1))
          (i32.const 1)))))
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load (i32.add (i32.add (global.get $CONTROL_TABLE) (i32.mul (local.get $idx) (i32.const 16))) (i32.const 8)))
  )

  ;; Set check state for a control hwnd (legacy CONTROL_TABLE path)
  (func $ctrl_set_check_state (param $hwnd i32) (param $state i32)
    (local $idx i32) (local $btn_state i32) (local $btn_state_w i32) (local $flags i32)
    (local.set $btn_state (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (local.get $btn_state)
      (then
        (local.set $btn_state_w (call $g2w (local.get $btn_state)))
        (local.set $flags (i32.and (i32.load offset=8 (local.get $btn_state_w)) (i32.const 0xFFFFFFFD)))
        (if (local.get $state)
          (then (local.set $flags (i32.or (local.get $flags) (i32.const 0x02)))))
        (i32.store offset=8 (local.get $btn_state_w) (local.get $flags))))
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.ne (local.get $idx) (i32.const -1))
      (then
        (i32.store (i32.add (i32.add (global.get $CONTROL_TABLE) (i32.mul (local.get $idx) (i32.const 16))) (i32.const 8))
          (local.get $state))))
  )

  ;; Enumerate WAT-managed child windows of a parent. Caller starts with
  ;; $start_slot=0 and gets back (hwnd, next_slot) packed: hwnd in low
  ;; bits, but we use a single i32 hwnd return + a side-channel for the
  ;; next slot via $ctrl_enum_next_slot. Simpler API: the caller passes
  ;; a starting slot index, and the result is the next-occupied slot whose
  ;; parent matches, or -1 if no more. The caller separately reads hwnd
  ;; via $wnd_slot_hwnd. Cheap because slot iteration is O(MAX_WINDOWS).
  (func $wnd_next_child_slot (param $parent i32) (param $start i32) (result i32)
    (local $i i32) (local $addr i32) (local $hwnd i32)
    (local.set $i (local.get $start))
    (block $done
      (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
        (local.set $addr (call $wnd_record_addr (local.get $i)))
        (local.set $hwnd (i32.load (local.get $addr)))
        (if (i32.and (i32.ne (local.get $hwnd) (i32.const 0))
                     (i32.eq (i32.load offset=8 (local.get $addr)) (local.get $parent)))
          (then (return (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (i32.const -1))

  (func $wnd_slot_hwnd (param $slot i32) (result i32)
    (i32.load (call $wnd_record_addr (local.get $slot))))

  ;; Find child control hwnd by parent and control ID
  (func $ctrl_find_by_id (param $parent_hwnd i32) (param $ctrl_id i32) (result i32)
    (local $i i32)
    (local $addr i32)
    (local $hwnd i32)
    (local $ctrl_addr i32)
    (local.set $i (i32.const 0))
    (block $done
      (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
        (local.set $addr (call $wnd_record_addr (local.get $i)))
        (local.set $hwnd (i32.load (local.get $addr)))
        (if (i32.ne (local.get $hwnd) (i32.const 0))
          (then
            (local.set $ctrl_addr (i32.add (global.get $CONTROL_TABLE) (i32.mul (local.get $i) (i32.const 16))))
            (if (i32.and
                  (i32.eq (call $wnd_get_parent (local.get $hwnd)) (local.get $parent_hwnd))
                  (i32.eq (i32.load (i32.add (local.get $ctrl_addr) (i32.const 4))) (local.get $ctrl_id)))
              (then (return (local.get $hwnd))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (i32.const 0)
  )

  ;; Mark every child control of $parent_hwnd as needing repaint.
  ;;
  ;; Erasing a parent's client area paints over whatever its children have
  ;; already put there, and a control that painted before the erase has
  ;; already cleared its own update flag -- nothing will ask it to paint
  ;; again, so its pixels are gone for the life of the window. sndvol32's
  ;; Properties dialog hits this: CheckRadioButton in WM_INITDIALOG drives
  ;; BM_SETCHECK, which repaints the three radios immediately, and the
  ;; dialog's first WM_ERASEBKGND then wipes them.
  (func $invalidate_child_controls (param $parent_hwnd i32)
    (local $i i32) (local $hwnd i32)
    (local.set $i (i32.const 0))
    (block $done
      (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
        (local.set $hwnd (i32.load (call $wnd_record_addr (local.get $i))))
        (if (i32.and
              (i32.ne (local.get $hwnd) (i32.const 0))
              (i32.eq (call $wnd_get_parent (local.get $hwnd)) (local.get $parent_hwnd)))
          (then (call $invalidate_hwnd (local.get $hwnd))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
  )

  ;; Fill a freshly-registered dialog's client area on its back-canvas with
  ;; COLOR_BTNFACE. Called right after $host_register_dialog_frame so the
  ;; dialog face shows in gaps between child controls. Equivalent to the
  ;; default WM_ERASEBKGND handler for a class with hbrBackground = BTNFACE.
  (func $dlg_fill_bkgnd (param $hwnd i32)
    (call $nc_flags_set (local.get $hwnd) (i32.const 2)))

  ;; ---- Control WndProc dispatch ----

  ;; One --trace-ctrl line for a WAT-native control. $reason is 0 when the
  ;; control is about to paint, and otherwise says why it will not:
  ;;   1 = an ancestor still owes an erase or a paint
  ;;   2 = the control (or an ancestor) is not effectively visible
  ;;   3 = its update rect is empty
  ;;   4 = it has no CONTROL_TABLE class, so this drain never paints it
  ;; A control that never appears in this trace at all was never asked --
  ;; nothing invalidated it, which is a different bug from any of the above.
  ;;
  ;; Two controls painting the same pixels, or one painting twice at
  ;; different origins, is invisible in --trace-gdi now that the GDI
  ;; primitives rasterize inside WAT. JS drops this unless --trace-ctrl.
  (func $ctrl_paint_trace_emit (param $hwnd i32) (param $class i32) (param $reason i32)
    (local $wh i32)
    (local.set $wh (call $ctrl_get_wh_packed (local.get $hwnd)))
    (call $host_ctrl_paint_trace
      (local.get $hwnd)
      ;; Reason rides above the class byte -- the packed word below is full.
      (i32.or (local.get $class) (i32.shl (local.get $reason) (i32.const 8)))
      (call $wnd_window_screen_x (local.get $hwnd))
      (call $wnd_window_screen_y (local.get $hwnd))
      (i32.and (local.get $wh) (i32.const 0xFFFF))
      (i32.or (i32.shl (i32.shr_u (local.get $wh) (i32.const 16)) (i32.const 1))
              (call $wnd_is_effectively_visible (local.get $hwnd)))
      ;; Paint order alone cannot say which surface a control lands on --
      ;; that is decided by its top-level ancestor. A child whose parent is
      ;; not the window it appears over paints onto the wrong back-canvas
      ;; and vanishes under whatever is stacked above.
      ;;
      ;; Everything reported here is a pure read. Resolving the control's
      ;; hwnd+0x40000 DC would say whether its surface exists yet, which is
      ;; the other way to paint no pixels -- but $gdi_surface_descriptor
      ;; ENSURES the window surface, so asking the question changes the
      ;; answer, and a trace call sits on every control paint.
      (i32.or
          (call $wnd_get_parent (local.get $hwnd))
          ;; state=0 is another way to paint nothing: most control
          ;; wndprocs bail out of WM_PAINT before their first primitive
          ;; when the hwnd has no state record.
          (i32.or
            (i32.shl (i32.ne (call $wnd_get_state_ptr (local.get $hwnd))
                             (i32.const 0))
                     (i32.const 25))
            ;; Low style nibble. Every class that composes its face from
            ;; primitives dispatches on it, and a value no branch claims
            ;; draws nothing at all -- indistinguishable, from the
            ;; outside, from a control that never got asked to paint.
            (i32.shl (i32.and (call $wnd_get_style (local.get $hwnd))
                              (i32.const 0x0F))
                     (i32.const 26))))))

  ;; Dispatch to the correct control wndproc based on control class
  (func $control_wndproc_dispatch (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $class i32)
    (local.set $class (call $ctrl_table_get_class (local.get $hwnd)))
    (if (i32.and (i32.eq (local.get $msg) (i32.const 0x000F))
          (i32.ne (local.get $class) (i32.const 0)))
      (then (call $ctrl_paint_trace_emit
              (local.get $hwnd) (local.get $class) (i32.const 0))))
    ;; Class 1 = Button
    (if (i32.eq (local.get $class) (i32.const 1))
      (then (return (call $button_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 2 = Edit; 24 = RichEdit 1.0; 25 = RichEdit 2.0+.
    ;; They share editing/painting state, while $edit_wndproc gates messages
    ;; that did not exist in the 1.0 contract.
    (if (i32.or
          (i32.eq (local.get $class) (i32.const 2))
          (i32.or (i32.eq (local.get $class) (i32.const 24))
                  (i32.eq (local.get $class) (i32.const 25))))
      (then (return (call $edit_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 3 = Static
    (if (i32.eq (local.get $class) (i32.const 3))
      (then (return (call $static_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 4 = ListBox
    (if (i32.eq (local.get $class) (i32.const 4))
      (then (return (call $listbox_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 5 = ComboBox
    (if (i32.eq (local.get $class) (i32.const 5))
      (then (return (call $combobox_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 6 = ColorGrid (ChooseColor swatches)
    (if (i32.eq (local.get $class) (i32.const 6))
      (then (return (call $colorgrid_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 7 = ScrollBar control
    (if (i32.eq (local.get $class) (i32.const 7))
      (then (return (call $scrollbar_ctrl_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 8 = TreeView (SysTreeView32)
    (if (i32.eq (local.get $class) (i32.const 8))
      (then (return (call $treeview_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 9 = ComboBox dropdown popup shell (WS_POPUP top-level owned by a combobox)
    (if (i32.eq (local.get $class) (i32.const 9))
      (then (return (call $combo_popup_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 10 = Find/Replace dialog parent (WAT-built)
    (if (i32.eq (local.get $class) (i32.const 10))
      (then (return (call $findreplace_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 11 = ShellAbout dialog parent (WAT-built)
    (if (i32.eq (local.get $class) (i32.const 11))
      (then (return (call $about_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 12 = Open / Save common dialog parent (WAT-built)
    (if (i32.eq (local.get $class) (i32.const 12))
      (then (return (call $opendlg_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 13 = Generic stub dialog (Page Setup / Print / Color / Font)
    (if (i32.eq (local.get $class) (i32.const 13))
      (then (return (call $stub_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 14 = Font (ChooseFont) dialog parent
    (if (i32.eq (local.get $class) (i32.const 14))
      (then (return (call $fontdlg_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 15 = Color (ChooseColor) dialog parent
    (if (i32.eq (local.get $class) (i32.const 15))
      (then (return (call $colordlg_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 16 = MessageBox modal dialog
    (if (i32.eq (local.get $class) (i32.const 16))
      (then (return (call $msgbox_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 17 = ProgressBar (msctls_progress32)
    (if (i32.eq (local.get $class) (i32.const 17))
      (then (return (call $progress_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 18 = ListView (SysListView32)
    (if (i32.eq (local.get $class) (i32.const 18))
      (then (return (call $listview_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 19 = TrackBar/Slider (Slider1, msctls_trackbar32)
    (if (i32.eq (local.get $class) (i32.const 19))
      (then (return (call $trackbar_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 20 = Tooltip (tooltips_class32)
    (if (i32.eq (local.get $class) (i32.const 20))
      (then (return (call $tooltip_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 21 = Toolbar (ToolbarWindow32)
    (if (i32.eq (local.get $class) (i32.const 21))
      (then (return (call $toolbar_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 22 = StatusBar (msctls_statusbar32)
    (if (i32.eq (local.get $class) (i32.const 22))
      (then (return (call $statusbar_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 23 = ChooseColor hue/saturation and luminance picker
    (if (i32.eq (local.get $class) (i32.const 23))
      (then (return (call $colorspectrum_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 26 = ChooseColor current/solid preview
    (if (i32.eq (local.get $class) (i32.const 26))
      (then (return (call $colorpreview_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 27 = Help Topics tab strip (WAT-owned SysTabControl32 page)
    (if (i32.eq (local.get $class) (i32.const 27))
      (then (return (call $help_topics_tab_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 28 = SysLink
    (if (i32.eq (local.get $class) (i32.const 28))
      (then (return (call $syslink_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 29 = Shell Run / Shut Down dialog parent (WAT-built)
    (if (i32.eq (local.get $class) (i32.const 29))
      (then (return (call $shelldlg_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; 30 = OLEDLG's Insert Object dialog; the proc lives in 09a7b-ole.wat with
    ;; the rest of OLE.
    (if (i32.eq (local.get $class) (i32.const 30))
      (then (return (call $insertobj_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Other classes: return 0 (DefWindowProc)
    (i32.const 0)
  )

  ;; ---- Shell dialogs: Run (SHELL32 #61) and Shut Down (SHELL32 #60) ----
  ;;
  ;; These are the two commands on Task Manager's File menu, and both were
  ;; no-op stubs that popped their arguments and returned -- so the menu items
  ;; existed, did nothing, and reported nothing. They are shell-owned dialogs:
  ;; the app supplies at most a title, and every control belongs to SHELL32,
  ;; which is us. So they are built here the way ShellAbout's dialog is, out of
  ;; $host_register_dialog_frame plus $ctrl_create_child.
  (global $shelldlg_kind (mut i32) (i32.const 0))        ;; 1 = Run, 2 = Shut Down
  (global $shelldlg_edit_hwnd (mut i32) (i32.const 0))
  (global $shelldlg_owner (mut i32) (i32.const 0))

  (data (i32.const 0x11F00) "Run\00")
  (data (i32.const 0x11F04) "Type the name of a program, folder, or\00")
  (data (i32.const 0x11F2B) "document, and Windows will open it for you.\00")
  (data (i32.const 0x11F57) "Open:\00")
  (data (i32.const 0x11F5D) "Browse...\00")
  (data (i32.const 0x11F67) "Shut Down Windows\00")
  (data (i32.const 0x11F79) "Shut down the computer\00")
  (data (i32.const 0x11F90) "Restart the computer\00")

  ;; Shared frame setup for both dialogs. $title_wa is a linear address.
  (func $shelldlg_frame (param $dlg i32) (param $owner i32)
                        (param $title_wa i32) (param $w i32) (param $h i32)
    (call $host_register_dialog_frame
      (local.get $dlg) (local.get $owner) (local.get $title_wa)
      (local.get $w) (local.get $h) (i32.const 1))
    (call $wnd_table_set (local.get $dlg) (global.get $WNDPROC_CTRL_NATIVE))
    (call $title_table_set (local.get $dlg) (local.get $title_wa)
      (call $strlen (local.get $title_wa)))
    (call $wnd_set_owner (local.get $dlg) (local.get $owner))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x90C80000)))
    ;; Client geometry must exist before the first WM_NCPAINT, or the frame
    ;; repaint erases the child controls (the same ordering ShellAbout needs).
    (call $defwndproc_do_nccalcsize (local.get $dlg))
    (call $ctrl_table_set (call $wnd_table_find (local.get $dlg))
      (i32.const 29) (i32.const 0))
    (call $nc_flags_set (local.get $dlg) (i32.const 3))
    (call $dlg_fill_bkgnd (local.get $dlg)))

  ;; RunFileDlg's dialog. $title_g / $desc_g are guest pointers and may be 0,
  ;; in which case the shell's own wording is used -- which is what the real
  ;; one does when an app passes NULL.
  (func $create_run_dialog (param $dlg i32) (param $owner i32)
                           (param $title_g i32) (param $desc_g i32)
    (local $title_wa i32)
    (local.set $title_wa (i32.const 0x11F00))
    (if (local.get $title_g)
      (then
        (if (i32.load8_u (call $g2w (local.get $title_g)))
          (then (local.set $title_wa (call $g2w (local.get $title_g)))))))
    (global.set $shelldlg_kind (i32.const 1))
    (global.set $shelldlg_owner (local.get $owner))
    (call $shelldlg_frame (local.get $dlg) (local.get $owner)
      (local.get $title_wa) (i32.const 400) (i32.const 176))
    ;; Prompt. A caller-supplied description replaces the first line; the
    ;; standard text is two lines because a STATIC does not wrap.
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
            (i32.const 14) (i32.const 14) (i32.const 366) (i32.const 18)
            (i32.const 0x50000000)
            (if (result i32) (local.get $desc_g)
              (then (local.get $desc_g))
              (else (call $wat_str_to_heap (i32.const 0x11F04) (i32.const 38))))))
    (if (i32.eqz (local.get $desc_g))
      (then
        (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
                (i32.const 14) (i32.const 32) (i32.const 366) (i32.const 18)
                (i32.const 0x50000000)
                (call $wat_str_to_heap (i32.const 0x11F2B) (i32.const 43))))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
            (i32.const 14) (i32.const 66) (i32.const 44) (i32.const 18)
            (i32.const 0x50000000)
            (call $wat_str_to_heap (i32.const 0x11F57) (i32.const 5))))
    (global.set $shelldlg_edit_hwnd
      (call $ctrl_create_child (local.get $dlg) (i32.const 2) (i32.const 1001)
        (i32.const 60) (i32.const 62) (i32.const 320) (i32.const 22)
        (i32.const 0x50810080) (i32.const 0)))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 1)
            (i32.const 148) (i32.const 108) (i32.const 72) (i32.const 24)
            (i32.const 0x50010001)
            (call $wat_str_to_heap (i32.const 0x1D9) (i32.const 2))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 2)
            (i32.const 228) (i32.const 108) (i32.const 72) (i32.const 24)
            (i32.const 0x50010000)
            (call $wat_str_to_heap (i32.const 0x1D2) (i32.const 6))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 1002)
            (i32.const 308) (i32.const 108) (i32.const 72) (i32.const 24)
            (i32.const 0x50010000)
            (call $wat_str_to_heap (i32.const 0x11F5D) (i32.const 9)))))

  (func $create_shutdown_dialog (param $dlg i32) (param $owner i32)
    (local $first i32)
    (global.set $shelldlg_kind (i32.const 2))
    (global.set $shelldlg_owner (local.get $owner))
    (global.set $shelldlg_edit_hwnd (i32.const 0))
    (call $shelldlg_frame (local.get $dlg) (local.get $owner)
      (i32.const 0x11F67) (i32.const 300) (i32.const 160))
    ;; BS_AUTORADIOBUTTON = 9. The first carries WS_GROUP so the pair behaves
    ;; as one group, which is what makes the selection exclusive.
    (local.set $first (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 1010)
            (i32.const 20) (i32.const 20) (i32.const 250) (i32.const 20)
            (i32.const 0x50030009)
            (call $wat_str_to_heap (i32.const 0x11F79) (i32.const 22))))
    ;; Windows opens this dialog with the first option already chosen, so OK
    ;; is immediately meaningful. BM_SETCHECK = 0x00F1.
    (drop (call $wnd_send_message (local.get $first) (i32.const 0x00F1)
            (i32.const 1) (i32.const 0)))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 1011)
            (i32.const 20) (i32.const 44) (i32.const 250) (i32.const 20)
            (i32.const 0x50010009)
            (call $wat_str_to_heap (i32.const 0x11F90) (i32.const 20))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 1)
            (i32.const 66) (i32.const 96) (i32.const 72) (i32.const 24)
            (i32.const 0x50010001)
            (call $wat_str_to_heap (i32.const 0x1D9) (i32.const 2))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 2)
            (i32.const 152) (i32.const 96) (i32.const 72) (i32.const 24)
            (i32.const 0x50010000)
            (call $wat_str_to_heap (i32.const 0x1D2) (i32.const 6)))))

  ;; Class 29. Frame painting and the title-bar-X translation are the same as
  ;; every other WAT-built dialog; what differs is what OK means.
  (func $shelldlg_wndproc
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $cmd i32) (local $close i32)
    (local $state i32) (local $state_w i32) (local $len i32) (local $text_g i32)
    (local.set $close (i32.const 0))
    (if (i32.eq (local.get $msg) (i32.const 0x0085))
      (then (call $defwndproc_do_ncpaint (local.get $hwnd)) (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0014))
      (then (return (call $host_erase_background (local.get $hwnd) (i32.const 16)))))
    (if (i32.eq (local.get $msg) (i32.const 0x0010))
      (then (local.set $close (i32.const 1))))
    (if (i32.and
          (i32.eq (local.get $msg) (i32.const 0x00A1))
          (i32.eq (local.get $wParam) (i32.const 20)))     ;; HTCLOSE
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
    (if (i32.eq (local.get $msg) (i32.const 0x0111))
      (then
        (local.set $cmd (i32.and (local.get $wParam) (i32.const 0xFFFF)))
        ;; Cancel, and Browse until there is a file dialog to open from here.
        (if (i32.eq (local.get $cmd) (i32.const 2))
          (then (local.set $close (i32.const 1))))
        (if (i32.eq (local.get $cmd) (i32.const 1))
          (then
            (if (i32.eq (global.get $shelldlg_kind) (i32.const 1))
              (then
                ;; Run: hand the typed command to the same shell-execute path
                ;; ShellExecuteA uses. An EDIT keeps its text pointer at +0 of
                ;; its state block and the length at +4.
                (local.set $state (call $wnd_get_state_ptr (global.get $shelldlg_edit_hwnd)))
                (if (local.get $state)
                  (then
                    (local.set $state_w (call $g2w (local.get $state)))
                    (local.set $len (i32.load offset=4 (local.get $state_w)))
                    (local.set $text_g (i32.load (local.get $state_w)))
                    (if (local.get $text_g)
                      (then (if (local.get $len)
                        (then (drop (call $host_shell_execute
                          (global.get $shelldlg_owner)
                          (i32.const 0) (call $g2w (local.get $text_g))
                          (i32.const 0) (i32.const 0) (i32.const 1)))))))))))
            (if (i32.eq (global.get $shelldlg_kind) (i32.const 2))
              (then (global.set $quit_flag (i32.const 1))))
            (local.set $close (i32.const 1))))))
    (if (local.get $close)
      (then
        (global.set $shelldlg_kind (i32.const 0))
        (global.set $shelldlg_edit_hwnd (i32.const 0))
        (call $wnd_destroy_tree (local.get $hwnd))
        (call $host_destroy_window (local.get $hwnd))
        (return (i32.const 0))))
    (i32.const 0))

  ;; ---- Find/Replace dialog parent wndproc ----
  ;;
  ;; Handles WM_COMMAND posted by child buttons (Find Next id=1, Cancel id=2).
  ;; Reads the FINDREPLACE struct guest ptr from the dialog's userdata
  ;; (stashed by $create_findreplace_dialog), populates the buffer + flags
  ;; the way commdlg's real find dialog does, and posts the registered
  ;; message (matching the JS-side _handleFindDialogButton path) to the
  ;; owner. Owner is typically notepad's main window — so $wnd_send_message
  ;; will queue this via post_queue and notepad's GetMessage loop picks it
  ;; up just like a PostMessage.
  ;;
  ;; FINDREPLACE struct (offsets we touch):
  ;;   +0x04  hwndOwner
  ;;   +0x0C  Flags          (read-modify-write)
  ;;   +0x10  lpstrFindWhat  (guest ptr)
  ;;   +0x18  wFindWhatLen   (u16, max chars in lpstrFindWhat buffer)
  ;;
  ;; Flags constants:
  ;;   FR_DOWN        = 0x0001
  ;;   FR_MATCHCASE   = 0x0004
  ;;   FR_FINDNEXT    = 0x0008
  ;;   FR_REPLACE     = 0x0010
  ;;   FR_REPLACEALL  = 0x0020
  ;;   FR_DIALOGTERM  = 0x0040
  (func $findreplace_copy_edit_to_buffer
    (param $edit_h i32) (param $fr_w i32) (param $ptr_off i32) (param $len_off i32)
    (local $state i32) (local $state_w i32) (local $src_w i32)
    (local $buf_g i32) (local $buf_w i32) (local $text_len i32) (local $max_len i32)
    (local.set $state (call $wnd_get_state_ptr (local.get $edit_h)))
    (if (i32.eqz (local.get $state)) (then (return)))
    (local.set $state_w (call $g2w (local.get $state)))
    (local.set $buf_g (i32.load (i32.add (local.get $fr_w) (local.get $ptr_off))))
    (local.set $max_len (i32.load16_u (i32.add (local.get $fr_w) (local.get $len_off))))
    (if (i32.or (i32.eqz (local.get $buf_g)) (i32.eqz (local.get $max_len))) (then (return)))
    (local.set $text_len (i32.load offset=4 (local.get $state_w)))
    (if (i32.ge_u (local.get $text_len) (local.get $max_len))
      (then (local.set $text_len (i32.sub (local.get $max_len) (i32.const 1)))))
    (local.set $buf_w (call $g2w (local.get $buf_g)))
    ;; Do not combine the length and guest pointer with bitwise i32.and:
    ;; a one-byte replacement plus an even pointer would incorrectly skip.
    (if (local.get $text_len)
      (then
        (if (i32.load (local.get $state_w))
          (then
            (local.set $src_w (call $g2w (i32.load (local.get $state_w))))
            (call $memcpy (local.get $buf_w) (local.get $src_w) (local.get $text_len))))))
    (i32.store8 (i32.add (local.get $buf_w) (local.get $text_len)) (i32.const 0)))

  (func $findreplace_native_richedit_replace
    (param $owner i32) (param $fr_w i32) (result i32)
    (local $replace_g i32) (local $state i32) (local $empty_g i32)
    (if (i32.or
          (i32.ne (call $ctrl_table_get_class (local.get $owner)) (i32.const 0))
          (i32.eqz (call $wnd_get_parent (local.get $owner))))
      (then (return (i32.const 0))))
    ;; Use the live dialog edit buffer for the immediate native operation.
    ;; MFC may clear its temporary FINDREPLACE lpstrReplaceWith field after
    ;; ReplaceTextA returns, while the modeless WAT edit remains authoritative.
    (local.set $state (call $wnd_get_state_ptr (global.get $findreplace_replace_hwnd)))
    (if (local.get $state)
      (then (local.set $replace_g (i32.load (call $g2w (local.get $state))))))
    (if (i32.eqz (local.get $replace_g))
      (then (local.set $replace_g (i32.load offset=20 (local.get $fr_w)))))
    ;; Empty replacement is valid and means delete the selected match.
    (if (i32.eqz (local.get $replace_g))
      (then
        (local.set $empty_g (call $heap_alloc (i32.const 1)))
        (i32.store8 (call $g2w (local.get $empty_g)) (i32.const 0))
        (local.set $replace_g (local.get $empty_g))))
    (drop (call $wnd_send_message
      (local.get $owner) (i32.const 0x00C2) (i32.const 1) (local.get $replace_g)))
    (if (local.get $empty_g) (then (call $heap_free (local.get $empty_g))))
    (call $paint_flag_set_inv (local.get $owner))
    (i32.const 1))

  (func $findreplace_native_richedit_find
    (param $owner i32) (param $fr_w i32) (param $flags i32) (result i32)
    (local $find_g i32) (local $range_g i32) (local $range_w i32)
    (local $sel_a i32) (local $sel_b i32) (local $start i32) (local $ret i32)
    ;; A class-0 child with a real native wndproc is the shape used by
    ;; RichEdit20A. Plain WAT Edit owners (Notepad) continue through their
    ;; application FINDMSGSTRING handler below.
    (if (i32.or
          (i32.ne (call $ctrl_table_get_class (local.get $owner)) (i32.const 0))
          (i32.eqz (call $wnd_get_parent (local.get $owner))))
      (then (return (i32.const 0))))
    (local.set $find_g (i32.load offset=16 (local.get $fr_w)))
    (if (i32.eqz (local.get $find_g)) (then (return (i32.const 0))))
    (local.set $range_g (call $heap_alloc (i32.const 20)))
    (if (i32.eqz (local.get $range_g)) (then (return (i32.const 0))))
    (local.set $range_w (call $g2w (local.get $range_g)))
    (call $zero_memory (local.get $range_w) (i32.const 20))
    ;; Use the current selection end for a downward Find Next and the start
    ;; for an upward search. FINDTEXTEXA is CHARRANGE + lpstrText + result
    ;; CHARRANGE; all pointers passed to native RichEdit stay in guest space.
    (drop (call $wnd_send_message
      (local.get $owner) (i32.const 0x00B0)
      (local.get $range_g) (i32.add (local.get $range_g) (i32.const 4))))
    (local.set $sel_a (i32.load (local.get $range_w)))
    (local.set $sel_b (i32.load offset=4 (local.get $range_w)))
    (if (i32.and (local.get $flags) (i32.const 0x01))
      (then
        (local.set $start (local.get $sel_a))
        (if (i32.gt_s (local.get $sel_b) (local.get $start))
          (then (local.set $start (local.get $sel_b))))
        (i32.store (local.get $range_w) (local.get $start))
        (i32.store offset=4 (local.get $range_w) (i32.const -1)))
      (else
        (local.set $start (local.get $sel_a))
        (if (i32.lt_s (local.get $sel_b) (local.get $start))
          (then (local.set $start (local.get $sel_b))))
        (i32.store (local.get $range_w) (i32.const 0))
        (i32.store offset=4 (local.get $range_w) (local.get $start))))
    (i32.store offset=8 (local.get $range_w) (local.get $find_g))
    (local.set $ret (call $wnd_send_message
      (local.get $owner) (i32.const 0x044F) (local.get $flags) (local.get $range_g))) ;; EM_FINDTEXTEXA
    (if (i32.ge_s (local.get $ret) (i32.const 0))
      (then
        (drop (call $wnd_send_message
          (local.get $owner) (i32.const 0x00B1)
          (i32.load offset=12 (local.get $range_w))
          (i32.load offset=16 (local.get $range_w))))
        (call $paint_flag_set_inv (local.get $owner))))
    (call $heap_free (local.get $range_g))
    (i32.ge_s (local.get $ret) (i32.const 0)))

  (func $findreplace_wndproc
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $cmd i32) (local $fr i32) (local $fr_w i32)
    (local $owner i32) (local $flags i32)
    (local $edit_h i32) (local $edit_state i32) (local $edit_sw i32)
    (local $text_src_w i32) (local $text_len i32) (local $max_len i32)
    (local $find_buf_g i32) (local $find_buf_w i32) (local $i i32)
    (local $mc_h i32) (local $rd_h i32)
    (local $main_edit_h i32) (local $main_state i32) (local $main_state_w i32)
    (local $main_len i32) (local $start_g i32) (local $end_g i32)
    (local $sel_start i32) (local $sel_end i32) (local $replace_count i32)
    (local $replace_ready i32)

    ;; WM_NCPAINT → paint chrome (title bar + border) on back-canvas.
    (if (i32.eq (local.get $msg) (i32.const 0x0085))
      (then (call $defwndproc_do_ncpaint (local.get $hwnd)) (return (i32.const 0))))
    ;; WM_ERASEBKGND → fill client with COLOR_BTNFACE (index 16).
    (if (i32.eq (local.get $msg) (i32.const 0x0014))
      (then (return (call $host_erase_background (local.get $hwnd) (i32.const 16)))))

    ;; Recover FR ptr stashed at userdata, owner from FR+4. Both WM_CLOSE
    ;; (title-bar X) and WM_COMMAND (Cancel/Find Next) need this.
    (local.set $fr (call $wnd_get_userdata (local.get $hwnd)))
    (if (i32.eqz (local.get $fr)) (then (return (i32.const 0))))
    (local.set $fr_w (call $g2w (local.get $fr)))
    ;; Some MFC callers release/clear their temporary FINDREPLACE wrapper
    ;; fields after FindTextA returns. The modeless dialog's owner relationship
    ;; remains authoritative for the dialog lifetime.
    (local.set $owner (call $wnd_get_owner (local.get $hwnd)))

    ;; ---- WM_CLOSE (0x0010) — title-bar X click ----
    ;; Real commdlg routes a title-bar close through IDCANCEL; do the same.
    (if (i32.eq (local.get $msg) (i32.const 0x0010))
      (then
        (local.set $cmd (i32.const 2))))  ;; fall through into the Cancel branch below
    ;; Title-bar close starts as WM_NCLBUTTONDOWN/HTCLOSE from the WAT
    ;; nonclient sysbutton tracker, then normally flows through
    ;; DefWindowProc to SC_CLOSE/WM_CLOSE. Find's custom dialog proc is the
    ;; whole dispatch target here, so mirror DefWindowProc's close mapping.
    (if (i32.and (i32.eq (local.get $msg) (i32.const 0x00A1))
                 (i32.eq (local.get $wParam) (i32.const 20)))
      (then
        (local.set $cmd (i32.const 2))))
    (if (i32.and (i32.eq (local.get $msg) (i32.const 0x0112))
                 (i32.eq (i32.and (local.get $wParam) (i32.const 0xFFF0)) (i32.const 0xF060)))
      (then
        (local.set $cmd (i32.const 2))))

    ;; WM_COMMAND only past this point
    (if (i32.and
          (i32.and (i32.ne (local.get $msg) (i32.const 0x0111))
                   (i32.ne (local.get $msg) (i32.const 0x0010)))
          (i32.and (i32.ne (local.get $msg) (i32.const 0x00A1))
                   (i32.ne (local.get $msg) (i32.const 0x0112))))
      (then (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0111))
      (then (local.set $cmd (i32.and (local.get $wParam) (i32.const 0xFFFF)))))

    ;; ---- Cancel (id=2) ----
    (if (i32.eq (local.get $cmd) (i32.const 2))
      (then
        (local.set $flags (i32.load offset=12 (local.get $fr_w)))
        ;; clear FR_FINDNEXT(0x08), set FR_DIALOGTERM(0x40)
        (local.set $flags (i32.or (i32.and (local.get $flags) (i32.const 0xFFFFFFB7))
                                  (i32.const 0x40)))
        (i32.store offset=12 (local.get $fr_w) (local.get $flags))
        (drop (call $post_queue_push (local.get $owner)
                (select (global.get $findreplace_message) (i32.const 0xC000)
                        (i32.ne (global.get $findreplace_message) (i32.const 0)))
                (i32.const 0) (local.get $fr)))
        ;; Tear down the dialog: free child WAT state via WM_DESTROY,
        ;; release the WND_RECORDS slots, drop the visible JS window,
        ;; and clear the globals so the next FindTextA opens fresh state.
        (call $wnd_destroy_tree (local.get $hwnd))
        (call $host_destroy_window (local.get $hwnd))
        (global.set $findreplace_dlg_hwnd  (i32.const 0))
        (global.set $findreplace_edit_hwnd (i32.const 0))
        (global.set $findreplace_replace_hwnd (i32.const 0))
        (global.set $findreplace_is_replace (i32.const 0))
        (return (i32.const 0))))

    ;; ---- Replace / Replace All (ids 0x400 / 0x401) ----
    (if (i32.and (global.get $findreplace_is_replace)
          (i32.or (i32.eq (local.get $cmd) (i32.const 0x400))
                  (i32.eq (local.get $cmd) (i32.const 0x401))))
      (then
        (local.set $flags
          (select (i32.const 0x20) (i32.const 0x10)
                  (i32.eq (local.get $cmd) (i32.const 0x401))))
        (local.set $mc_h (call $ctrl_find_by_id (local.get $hwnd) (i32.const 0x411)))
        (if (i32.and
              (i32.ne (local.get $mc_h) (i32.const 0))
              (i32.ne
                (i32.and (call $button_get_flags_internal (local.get $mc_h)) (i32.const 0x02))
                (i32.const 0)))
          (then (local.set $flags (i32.or (local.get $flags) (i32.const 0x04)))))
        (i32.store offset=12 (local.get $fr_w) (local.get $flags))
        (call $findreplace_copy_edit_to_buffer
          (global.get $findreplace_edit_hwnd) (local.get $fr_w) (i32.const 16) (i32.const 24))
        (call $findreplace_copy_edit_to_buffer
          (global.get $findreplace_replace_hwnd) (local.get $fr_w) (i32.const 20) (i32.const 26))
        (if (i32.eq (local.get $cmd) (i32.const 0x400))
          (then
            ;; Replace the active match. If there is no selection yet, find
            ;; the first match. Then select the following match, matching the
            ;; classic modeless dialog's repeated Replace workflow.
            (local.set $start_g (call $heap_alloc (i32.const 8)))
            (local.set $end_g (i32.add (local.get $start_g) (i32.const 4)))
            (drop (call $wnd_send_message (local.get $owner) (i32.const 0x00B0)
              (local.get $start_g) (local.get $end_g)))
            (local.set $sel_start (i32.load (call $g2w (local.get $start_g))))
            (local.set $sel_end (i32.load (call $g2w (local.get $end_g))))
            (if (i32.eq (local.get $sel_start) (local.get $sel_end))
              (then (local.set $replace_ready (call $findreplace_native_richedit_find
                (local.get $owner) (local.get $fr_w)
                (i32.or (i32.and (local.get $flags) (i32.const 0x04)) (i32.const 0x01)))))
              (else (local.set $replace_ready (i32.const 1))))
            (if (local.get $replace_ready)
              (then
                (drop (call $findreplace_native_richedit_replace (local.get $owner) (local.get $fr_w)))
                (drop (call $findreplace_native_richedit_find
                  (local.get $owner) (local.get $fr_w)
                  (i32.or (i32.and (local.get $flags) (i32.const 0x04)) (i32.const 0x01))))))
            (call $heap_free (local.get $start_g)))
          (else
            ;; Replace All always scans forward from the document start.
            (drop (call $wnd_send_message
              (local.get $owner) (i32.const 0x00B1) (i32.const 0) (i32.const 0)))
            (block $replace_all_done (loop $replace_all_loop
              (br_if $replace_all_done (i32.ge_u (local.get $replace_count) (i32.const 65535)))
              (br_if $replace_all_done (i32.eqz (call $findreplace_native_richedit_find
                (local.get $owner) (local.get $fr_w)
                (i32.or (i32.and (local.get $flags) (i32.const 0x04)) (i32.const 0x01)))))
              (br_if $replace_all_done (i32.eqz (call $findreplace_native_richedit_replace
                (local.get $owner) (local.get $fr_w))))
              (local.set $replace_count (i32.add (local.get $replace_count) (i32.const 1)))
              (br $replace_all_loop)))))
        ;; Native RichEdit owners are operated directly above. Posting the
        ;; same FR_REPLACE notification would make their framework perform the
        ;; operation a second time. Plain WAT/application owners still receive
        ;; the standard registered common-dialog notification.
        (if (i32.or
              (i32.ne (call $ctrl_table_get_class (local.get $owner)) (i32.const 0))
              (i32.eqz (call $wnd_get_parent (local.get $owner))))
          (then
            (drop (call $post_queue_push (local.get $owner)
              (select (global.get $findreplace_message) (i32.const 0xC000)
                      (i32.ne (global.get $findreplace_message) (i32.const 0)))
              (i32.const 0) (local.get $fr)))))
        (return (i32.const 0))))

    ;; ---- Find Next (id=1) ----
    (if (i32.eq (local.get $cmd) (i32.const 1))
      (then
        ;; Build flags = FR_FINDNEXT | (matchCase ? FR_MATCHCASE : 0) | (down ? FR_DOWN : 0)
        (local.set $flags (i32.const 0x08))
        (local.set $mc_h (call $ctrl_find_by_id (local.get $hwnd) (i32.const 0x411)))
        (if (local.get $mc_h)
          (then (if (i32.and (call $button_get_flags_internal (local.get $mc_h)) (i32.const 0x02))
                  (then (local.set $flags (i32.or (local.get $flags) (i32.const 0x04)))))))
        (local.set $rd_h (call $ctrl_find_by_id (local.get $hwnd) (i32.const 0x421)))
        (if (local.get $rd_h)
          (then (if (i32.and (call $button_get_flags_internal (local.get $rd_h)) (i32.const 0x02))
                  (then (local.set $flags (i32.or (local.get $flags) (i32.const 0x01)))))))
        ;; Replace dialogs do not expose direction controls; Win98 common
        ;; dialog Find Next always searches downward in this mode.
        (if (global.get $findreplace_is_replace)
          (then (local.set $flags (i32.or (local.get $flags) (i32.const 0x01)))))
        (i32.store offset=12 (local.get $fr_w) (local.get $flags))
        ;; Copy edit text into FR.lpstrFindWhat (clamped to wFindWhatLen-1).
        (local.set $edit_h (global.get $findreplace_edit_hwnd))
        (local.set $edit_state (call $wnd_get_state_ptr (local.get $edit_h)))
        (if (local.get $edit_state)
          (then
            (local.set $edit_sw (call $g2w (local.get $edit_state)))
            (local.set $text_len (i32.load offset=4 (local.get $edit_sw)))
            (local.set $find_buf_g (i32.load offset=16 (local.get $fr_w)))
            (local.set $max_len (i32.load16_u offset=24 (local.get $fr_w)))
            ;; Nested ifs — do NOT use i32.and as logical AND on pointer/length
            ;; pairs. find_buf_g typically has bit 0 = 0, so a bitwise AND with
            ;; (max_len > 0) would silently zero out the guard.
            (if (local.get $find_buf_g)
              (then (if (i32.gt_u (local.get $max_len) (i32.const 0))
              (then
                (local.set $find_buf_w (call $g2w (local.get $find_buf_g)))
                (if (i32.ge_u (local.get $text_len) (local.get $max_len))
                  (then (local.set $text_len (i32.sub (local.get $max_len) (i32.const 1)))))
                (if (i32.load (local.get $edit_sw))
                  (then
                    (local.set $text_src_w (call $g2w (i32.load (local.get $edit_sw))))
                (if (local.get $text_len)
                  (then (call $memcpy (local.get $find_buf_w)
                                          (local.get $text_src_w)
                                          (local.get $text_len))))))
                (i32.store8 (i32.add (local.get $find_buf_w) (local.get $text_len)) (i32.const 0))))))))
        (drop (call $findreplace_native_richedit_find
          (local.get $owner) (local.get $fr_w) (local.get $flags)))
        ;; Win98 Notepad's Find starts at the current caret. In the web UI
        ;; the common case is: type text, open Find, search for text that is
        ;; before the caret. When the main edit is exactly at EOF with no
        ;; selection, treat the first downward search as starting at top so
        ;; the visible document is searchable without requiring Home first.
        (if (i32.and (local.get $flags) (i32.const 0x01))
          (then
            (local.set $main_edit_h (call $ctrl_find_by_id (local.get $owner) (i32.const 15)))
            (local.set $main_state (call $wnd_get_state_ptr (local.get $main_edit_h)))
            (if (local.get $main_state)
              (then
                (local.set $main_state_w (call $g2w (local.get $main_state)))
                (local.set $main_len (i32.load offset=4 (local.get $main_state_w)))
                (if (i32.and
                      (i32.gt_u (local.get $main_len) (i32.const 0))
                      (i32.and
                        (i32.eq (i32.load offset=12 (local.get $main_state_w)) (local.get $main_len))
                        (i32.eq (i32.load offset=16 (local.get $main_state_w)) (local.get $main_len))))
                  (then (drop (call $wnd_send_message
                    (local.get $main_edit_h) (i32.const 0x00B1) (i32.const 0) (i32.const 0)))))))))
        ;; Native RichEdit was handled synchronously above; avoid duplicating
        ;; Find Next in the application after selecting the same match here.
        (if (i32.or
              (i32.ne (call $ctrl_table_get_class (local.get $owner)) (i32.const 0))
              (i32.eqz (call $wnd_get_parent (local.get $owner))))
          (then
            (drop (call $post_queue_push (local.get $owner)
                    (select (global.get $findreplace_message) (i32.const 0xC000)
                            (i32.ne (global.get $findreplace_message) (i32.const 0)))
                    (i32.const 0) (local.get $fr)))))
        (return (i32.const 0))))

    (i32.const 0)
  )

  ;; ---- ShellAbout dialog parent wndproc ----
  ;;
  ;; Handles WM_COMMAND posted by the OK button (id=IDOK=1) and WM_CLOSE
  ;; from the title-bar X. Both close the dialog: free child WAT state,
  ;; release the WND_RECORDS slots, drop the visible JS-side window.
  ;; The About dialog has no struct-back-fill the way commdlg's find
  ;; dialog does — it's purely informational, so close = teardown.
  (func $about_wndproc
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $cmd i32) (local $close i32)
    (local.set $close (i32.const 0))
    ;; WM_NCPAINT → paint chrome (title bar + border) on back-canvas.
    ;; Without this the dialog has no frame: ShellAbout doesn't run the
    ;; modal pump (which would drain nc_flags directly), so paint messages
    ;; come via the main GetMessageA loop and must be handled here.
    (if (i32.eq (local.get $msg) (i32.const 0x0085))
      (then (call $defwndproc_do_ncpaint (local.get $hwnd)) (return (i32.const 0))))
    ;; WM_ERASEBKGND → fill client with COLOR_BTNFACE (index 16).
    (if (i32.eq (local.get $msg) (i32.const 0x0014))
      (then (return (call $host_erase_background (local.get $hwnd) (i32.const 16)))))
    ;; WM_CLOSE → close
    (if (i32.eq (local.get $msg) (i32.const 0x0010))
      (then (local.set $close (i32.const 1))))
    ;; Title-bar X follows the normal DefWindowProc route:
    ;; WM_NCLBUTTONDOWN/HTCLOSE -> WM_SYSCOMMAND/SC_CLOSE -> WM_CLOSE.
    ;; ShellAbout's dialog proc is WAT-native, so handle that translation
    ;; here instead of dropping the NC click on the floor.
    (if (i32.and
          (i32.eq (local.get $msg) (i32.const 0x00A1))
          (i32.eq (local.get $wParam) (i32.const 20))) ;; HTCLOSE
      (then
        (drop (call $wnd_send_message
          (local.get $hwnd) (i32.const 0x0112) (i32.const 0xF060) (i32.const 0))) ;; SC_CLOSE
        (return (i32.const 0))))
    (if (i32.and
          (i32.eq (local.get $msg) (i32.const 0x0112))
          (i32.eq (i32.and (local.get $wParam) (i32.const 0xFFF0)) (i32.const 0xF060))) ;; SC_CLOSE
      (then
        (drop (call $wnd_send_message
          (local.get $hwnd) (i32.const 0x0010) (i32.const 0) (i32.const 0)))
        (return (i32.const 0))))
    ;; WM_COMMAND with id=IDOK → close
    (if (i32.eq (local.get $msg) (i32.const 0x0111))
      (then
        (local.set $cmd (i32.and (local.get $wParam) (i32.const 0xFFFF)))
        (if (i32.eq (local.get $cmd) (i32.const 1))
          (then (local.set $close (i32.const 1))))))
    (if (local.get $close)
      (then
        (call $wnd_destroy_tree (local.get $hwnd))
        (call $host_destroy_window (local.get $hwnd))
        (return (i32.const 0))))
    (i32.const 0))

  ;; Build the ShellAbout dialog. Called from $handle_ShellAboutA after
  ;; allocating the dlg hwnd. All strings come from the original guest
  ;; ShellAbout call:
  ;;   $app_g   = arg1, "Notepad" or whatever the app passed for szApp
  ;;   $other_g = arg2, free-form line(s) supplied by the guest
  ;;              (may be 0)
  ;; The title shown in the caption is "About <appname>", built in WAT
  ;; via memcpy. Lines are: app, then up to two newline-split chunks of
  ;; other_g.
  (func $create_about_dialog
    (param $dlg i32) (param $owner i32)
    (param $app_g i32) (param $other_g i32)
    (local $w i32) (local $h i32)
    (local $title_w i32) (local $title_buf_w i32) (local $app_len i32)
    (local $body_g i32) (local $body_w i32) (local $app_h i32)
    (local $line1_w i32) (local $line2_w i32) (local $line3_w i32)
    (local $other_w i32) (local $i i32) (local $nl i32)
    (local.set $w (i32.const 260))
    (local.set $h (i32.const 160))
    ;; Title = "About " + app. Six chars from data segment 0x1DC, then
    ;; the app string + NUL. Built in a fresh heap allocation; the
    ;; renderer reads it once during host_register_dialog_frame and
    ;; copies it into renderer.windows[].title — we own the buffer here.
    (local.set $app_len (call $strlen (call $g2w (local.get $app_g))))
    (local.set $title_buf_w
      (call $g2w (call $heap_alloc (i32.add (local.get $app_len) (i32.const 7)))))
    (call $memcpy (local.get $title_buf_w) (i32.const 0x1DC) (i32.const 6))
    (call $memcpy (i32.add (local.get $title_buf_w) (i32.const 6))
                  (call $g2w (local.get $app_g)) (local.get $app_len))
    (i32.store8 (i32.add (local.get $title_buf_w) (i32.add (local.get $app_len) (i32.const 6)))
                (i32.const 0))
    (call $host_register_dialog_frame
      (local.get $dlg) (local.get $owner)
      (local.get $title_buf_w)
      (local.get $w) (local.get $h)
      (i32.const 1))  ;; kind bit 0 = isAboutDialog
    (call $wnd_table_set (local.get $dlg) (global.get $WNDPROC_CTRL_NATIVE))
    (call $title_table_set (local.get $dlg) (local.get $title_buf_w)
      (i32.add (local.get $app_len) (i32.const 6)))
    (call $wnd_set_owner (local.get $dlg) (local.get $owner))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x90C80000)))
    ;; USER calculates the client rect before the first WM_NCPAINT. The NC
    ;; painter's clip is window minus client; without this, ShellAbout's
    ;; frame repaint erases the child STATIC/BUTTON controls.
    (call $defwndproc_do_nccalcsize (local.get $dlg))
    ;; Tag the parent dialog as control class 11 so $control_wndproc_dispatch
    ;; routes WM_COMMAND from the OK button (and WM_CLOSE from the title-bar X)
    ;; to $about_wndproc.
    (call $ctrl_table_set (call $wnd_table_find (local.get $dlg))
      (i32.const 11) (i32.const 0))
    ;; Queue WM_NCPAINT + WM_ERASEBKGND on the now-registered slot so the
    ;; main GetMessageA loop dispatches chrome + background fill to
    ;; $about_wndproc. Must run AFTER wnd_table_set — nc_flags_set is a
    ;; no-op when the slot doesn't exist yet.
    (call $nc_flags_set (local.get $dlg) (i32.const 3))  ;; bits 0+1
    (call $dlg_fill_bkgnd (local.get $dlg))
    (local.set $app_h (i32.const 18))
    (if (i32.eqz (local.get $other_g))
      (then
        (local.set $body_g (call $heap_alloc (i32.add (local.get $app_len) (i32.const 71))))
        (local.set $body_w (call $g2w (local.get $body_g)))
        (call $memcpy (local.get $body_w) (call $g2w (local.get $app_g)) (local.get $app_len))
        (i32.store8 (i32.add (local.get $body_w) (local.get $app_len)) (i32.const 10))
        (call $memcpy
          (i32.add (local.get $body_w) (i32.add (local.get $app_len) (i32.const 1)))
          (i32.const 0x110C6) (i32.const 68))
        (i32.store8
          (i32.add (local.get $body_w) (i32.add (local.get $app_len) (i32.const 69)))
          (i32.const 0))
        (local.set $app_g (local.get $body_g))
        (local.set $app_h (i32.const 74))))
    ;; Line 1: appname static
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
            (i32.const 12) (i32.const 10) (i32.const 236) (local.get $app_h)
            (i32.const 0x50000000) (local.get $app_g)))
    ;; OK button — id=IDOK=1, BS_DEFPUSHBUTTON style. Centered horizontally,
    ;; near the bottom of the 160px dialog.
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 1)
            (i32.const 90) (i32.sub (local.get $h) (i32.const 56))
            (i32.const 80) (i32.const 24)
            (i32.const 0x50010001)
            (call $wat_str_to_heap (i32.const 0x1D9) (i32.const 2)))))
    ;; Lines 2 + 3: split other_g on the first '\n'. If the app passes
    ;; NULL, ShellAbout still fills the dialog with the standard Windows
    ;; version/copyright block.
    (if (local.get $other_g)
      (then
        (local.set $other_w (call $g2w (local.get $other_g)))
        ;; Find newline position. -1 if none.
        (local.set $nl (i32.const -1))
        (local.set $i (i32.const 0))
        (block $done (loop $scan
          (br_if $done (i32.eqz (i32.load8_u (i32.add (local.get $other_w) (local.get $i)))))
          (if (i32.eq (i32.load8_u (i32.add (local.get $other_w) (local.get $i))) (i32.const 10))
            (then (local.set $nl (local.get $i)) (br $done)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $scan)))
        (if (i32.eq (local.get $nl) (i32.const -1))
          (then
            ;; Single line — render as line 2.
            (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
                    (i32.const 12) (i32.const 32) (i32.const 236) (i32.const 18)
                    (i32.const 0x50000000) (local.get $other_g))))
          (else
            ;; Two lines — split on '\n' into two heap copies so each
            ;; static_wndproc sees a clean NUL-terminated guest string.
            (local.set $line2_w
              (call $ctrl_text_dup (local.get $other_g) (local.get $nl)))
            (local.set $line3_w
              (call $ctrl_text_dup
                (i32.add (local.get $other_g) (i32.add (local.get $nl) (i32.const 1)))
                (call $strlen (i32.add (local.get $other_w) (i32.add (local.get $nl) (i32.const 1))))))
            (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
                    (i32.const 12) (i32.const 32) (i32.const 236) (i32.const 18)
                    (i32.const 0x50000000) (local.get $line2_w)))
            (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
                    (i32.const 12) (i32.const 50) (i32.const 236) (i32.const 18)
                    (i32.const 0x50000000) (local.get $line3_w)))))))
      ))
    ;; ShellAbout is a modal shell-owned dialog on Win98: by the time the
    ;; caller observes it, USER has already exposed/erased the dialog and
    ;; delivered paint to built-in child controls. Our ShellAbout handler is
    ;; WAT-side and returns through the guest's normal message loop, so run
    ;; that initial exposure pass here to keep child STATIC/BUTTON controls
    ;; visible without JS special-casing control drawing.
    (call $nc_flags_clear (local.get $dlg) (i32.const 2))
    (if (local.get $other_g)
      (then (drop (call $host_erase_background (local.get $dlg) (i32.const 16)))))
    (drop (call $paint_flush_visible_native_children (local.get $dlg))))

  ;; ============================================================
  ;; Common-dialog parent (control class 13)
  ;; ============================================================
  ;;
  ;; Generic fallbacks still show a compact message, while Print and Page
  ;; Setup use concrete controls and commit their fields on IDOK.
  (func $ctrl_decimal_value (param $parent i32) (param $id i32) (param $fallback i32) (result i32)
    (local $h i32) (local $state i32) (local $sw i32) (local $buf i32)
    (local $i i32) (local $n i32) (local $c i32) (local $value i32)
    (local.set $h (call $ctrl_find_by_id (local.get $parent) (local.get $id)))
    (if (i32.eqz (local.get $h)) (then (return (local.get $fallback))))
    (local.set $state (call $wnd_get_state_ptr (local.get $h)))
    (if (i32.eqz (local.get $state)) (then (return (local.get $fallback))))
    (local.set $sw (call $g2w (local.get $state)))
    (local.set $buf (i32.load (local.get $sw)))
    (local.set $n (i32.load offset=4 (local.get $sw)))
    (if (i32.eqz (local.get $buf)) (then (return (local.get $fallback))))
    (local.set $buf (call $g2w (local.get $buf)))
    (block $done (loop $digits
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $c (i32.load8_u (i32.add (local.get $buf) (local.get $i))))
      (br_if $done (i32.or (i32.lt_u (local.get $c) (i32.const 48))
                           (i32.gt_u (local.get $c) (i32.const 57))))
      (local.set $value (i32.add (i32.mul (local.get $value) (i32.const 10))
                                (i32.sub (local.get $c) (i32.const 48))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $digits)))
    (if (i32.eqz (local.get $i)) (then (return (local.get $fallback))))
    (local.get $value))

  ;; Parse an edit containing inches (for example "1.25") to thousandths.
  (func $ctrl_inches_milli (param $parent i32) (param $id i32) (result i32)
    (local $h i32) (local $state i32) (local $sw i32) (local $buf i32)
    (local $i i32) (local $n i32) (local $c i32) (local $whole i32)
    (local $frac i32) (local $digits i32) (local $dot i32)
    (local.set $h (call $ctrl_find_by_id (local.get $parent) (local.get $id)))
    (if (local.get $h) (then (local.set $state (call $wnd_get_state_ptr (local.get $h)))))
    (if (i32.eqz (local.get $state)) (then (return (i32.const 1000))))
    (local.set $sw (call $g2w (local.get $state)))
    (local.set $buf (i32.load (local.get $sw)))
    (local.set $n (i32.load offset=4 (local.get $sw)))
    (if (i32.eqz (local.get $buf)) (then (return (i32.const 1000))))
    (local.set $buf (call $g2w (local.get $buf)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $c (i32.load8_u (i32.add (local.get $buf) (local.get $i))))
      (if (i32.eq (local.get $c) (i32.const 46))
        (then (local.set $dot (i32.const 1)))
        (else
          (br_if $done (i32.or (i32.lt_u (local.get $c) (i32.const 48))
                               (i32.gt_u (local.get $c) (i32.const 57))))
          (if (local.get $dot)
            (then
              (if (i32.lt_u (local.get $digits) (i32.const 3))
                (then
                  (local.set $frac (i32.add (i32.mul (local.get $frac) (i32.const 10))
                                           (i32.sub (local.get $c) (i32.const 48))))
                  (local.set $digits (i32.add (local.get $digits) (i32.const 1))))))
            (else (local.set $whole (i32.add (i32.mul (local.get $whole) (i32.const 10))
                                             (i32.sub (local.get $c) (i32.const 48))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.eq (local.get $digits) (i32.const 1)) (then (local.set $frac (i32.mul (local.get $frac) (i32.const 100)))))
    (if (i32.eq (local.get $digits) (i32.const 2)) (then (local.set $frac (i32.mul (local.get $frac) (i32.const 10)))))
    (i32.add (i32.mul (local.get $whole) (i32.const 1000)) (local.get $frac)))

  ;; Both buttons call $modal_done; OK records result=1 and Cancel 0.
  ;; Apps that see result=1 typically act on the corresponding struct
  ;; (e.g. PAGESETUPDLG.rtMargin) but these are already zero-initialized
  ;; by the app, so returning 1 from an empty dialog is harmless for
  ;; non-printing paths and lets us visually prove the modal mechanism
  ;; without implementing the real form.
  (func $stub_wndproc
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $cmd i32)
    (if (i32.eq (local.get $msg) (i32.const 0x0085))   ;; WM_NCPAINT
      (then (call $defwndproc_do_ncpaint (local.get $hwnd)) (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0014))   ;; WM_ERASEBKGND
      (then (return (call $host_erase_background (local.get $hwnd) (i32.const 16)))))
    (if (i32.eq (local.get $msg) (i32.const 0x0010))   ;; WM_CLOSE
      (then (call $modal_done (i32.const 0)) (return (i32.const 0))))
    (if (i32.ne (local.get $msg) (i32.const 0x0111)) (then (return (i32.const 0))))
    (local.set $cmd (i32.and (local.get $wParam) (i32.const 0xFFFF)))
    (if (i32.eq (local.get $cmd) (i32.const 1))
      (then
        (if (i32.eq (global.get $common_dialog_kind) (i32.const 1))
          (then
            (local.set $cmd (call $ctrl_inches_milli (local.get $hwnd) (i32.const 1155)))
            (if (i32.and (call $gl32 (i32.add (global.get $common_dialog_struct) (i32.const 16))) (i32.const 8))
              (then (local.set $cmd (i32.div_u (i32.add (i32.mul (local.get $cmd) (i32.const 254)) (i32.const 50)) (i32.const 100)))))
            (call $gs32 (i32.add (global.get $common_dialog_struct) (i32.const 44)) (local.get $cmd))
            (local.set $cmd (call $ctrl_inches_milli (local.get $hwnd) (i32.const 1156)))
            (if (i32.and (call $gl32 (i32.add (global.get $common_dialog_struct) (i32.const 16))) (i32.const 8))
              (then (local.set $cmd (i32.div_u (i32.add (i32.mul (local.get $cmd) (i32.const 254)) (i32.const 50)) (i32.const 100)))))
            (call $gs32 (i32.add (global.get $common_dialog_struct) (i32.const 48)) (local.get $cmd))
            (local.set $cmd (call $ctrl_inches_milli (local.get $hwnd) (i32.const 1157)))
            (if (i32.and (call $gl32 (i32.add (global.get $common_dialog_struct) (i32.const 16))) (i32.const 8))
              (then (local.set $cmd (i32.div_u (i32.add (i32.mul (local.get $cmd) (i32.const 254)) (i32.const 50)) (i32.const 100)))))
            (call $gs32 (i32.add (global.get $common_dialog_struct) (i32.const 52)) (local.get $cmd))
            (local.set $cmd (call $ctrl_inches_milli (local.get $hwnd) (i32.const 1158)))
            (if (i32.and (call $gl32 (i32.add (global.get $common_dialog_struct) (i32.const 16))) (i32.const 8))
              (then (local.set $cmd (i32.div_u (i32.add (i32.mul (local.get $cmd) (i32.const 254)) (i32.const 50)) (i32.const 100)))))
            (call $gs32 (i32.add (global.get $common_dialog_struct) (i32.const 56)) (local.get $cmd))))
        (if (i32.eq (global.get $common_dialog_kind) (i32.const 2))
          (then
            (call $gs16 (i32.add (global.get $common_dialog_struct) (i32.const 24))
              (call $ctrl_decimal_value (local.get $hwnd) (i32.const 1152) (i32.const 1)))
            (call $gs16 (i32.add (global.get $common_dialog_struct) (i32.const 26))
              (call $ctrl_decimal_value (local.get $hwnd) (i32.const 1153) (i32.const 1)))
            (call $gs16 (i32.add (global.get $common_dialog_struct) (i32.const 32))
              (call $ctrl_decimal_value (local.get $hwnd) (i32.const 1154) (i32.const 1)))))
        (call $modal_done (i32.const 1)) (return (i32.const 0))))
    (if (i32.eq (local.get $cmd) (i32.const 2))
      (then (call $modal_done (i32.const 0)) (return (i32.const 0))))
    (i32.const 0))

  (func $create_print_dialog (param $dlg i32) (param $owner i32)
    (call $host_register_dialog_frame (local.get $dlg) (local.get $owner)
      (i32.const 0x24C) (i32.const 330) (i32.const 235) (i32.const 1))
    (call $wnd_table_set (local.get $dlg) (global.get $WNDPROC_CTRL_NATIVE))
    (call $title_table_set (local.get $dlg) (i32.const 0x24C) (i32.const 5))
    (call $wnd_set_owner (local.get $dlg) (local.get $owner))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x90C80000)))
    (call $defwndproc_do_nccalcsize (local.get $dlg))
    (call $ctrl_table_set (call $wnd_table_find (local.get $dlg)) (i32.const 13) (i32.const 0))
    (call $nc_flags_set (local.get $dlg) (i32.const 3))
    (call $dlg_fill_bkgnd (local.get $dlg))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
      (i32.const 14) (i32.const 14) (i32.const 290) (i32.const 18) (i32.const 0x50000000)
      (call $wat_str_to_heap (i32.const 0x11188) (i32.const 20))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
      (i32.const 14) (i32.const 42) (i32.const 100) (i32.const 18) (i32.const 0x50000000)
      (call $wat_str_to_heap (i32.const 0x1119D) (i32.const 10))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 1056)
      (i32.const 24) (i32.const 64) (i32.const 56) (i32.const 20) (i32.const 0x50010009)
      (call $wat_str_to_heap (i32.const 0x111A8) (i32.const 3))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 1057)
      (i32.const 92) (i32.const 64) (i32.const 70) (i32.const 20) (i32.const 0x50010009)
      (call $wat_str_to_heap (i32.const 0x11208) (i32.const 5))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
      (i32.const 24) (i32.const 94) (i32.const 42) (i32.const 18) (i32.const 0x50000000)
      (call $wat_str_to_heap (i32.const 0x111AC) (i32.const 5))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 2) (i32.const 1152)
      (i32.const 68) (i32.const 91) (i32.const 48) (i32.const 22) (i32.const 0x50810080)
      (call $wat_str_to_heap (i32.const 0x1120E) (i32.const 1))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
      (i32.const 130) (i32.const 94) (i32.const 25) (i32.const 18) (i32.const 0x50000000)
      (call $wat_str_to_heap (i32.const 0x111B2) (i32.const 3))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 2) (i32.const 1153)
      (i32.const 158) (i32.const 91) (i32.const 48) (i32.const 22) (i32.const 0x50810080)
      (call $wat_str_to_heap (i32.const 0x11210) (i32.const 4))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
      (i32.const 24) (i32.const 128) (i32.const 48) (i32.const 18) (i32.const 0x50000000)
      (call $wat_str_to_heap (i32.const 0x111B6) (i32.const 7))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 2) (i32.const 1154)
      (i32.const 76) (i32.const 125) (i32.const 48) (i32.const 22) (i32.const 0x50810080)
      (call $wat_str_to_heap (i32.const 0x1120E) (i32.const 1))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 1)
      (i32.const 154) (i32.const 170) (i32.const 72) (i32.const 24) (i32.const 0x50010001)
      (call $wat_str_to_heap (i32.const 0x1D9) (i32.const 2))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 2)
      (i32.const 238) (i32.const 170) (i32.const 72) (i32.const 24) (i32.const 0x50010000)
      (call $wat_str_to_heap (i32.const 0x1D2) (i32.const 6)))))

  (func $create_page_setup_dialog (param $dlg i32) (param $owner i32)
    (local $i i32)
    (call $host_register_dialog_frame (local.get $dlg) (local.get $owner)
      (i32.const 0x241) (i32.const 350) (i32.const 245) (i32.const 1))
    (call $wnd_table_set (local.get $dlg) (global.get $WNDPROC_CTRL_NATIVE))
    (call $title_table_set (local.get $dlg) (i32.const 0x241) (i32.const 10))
    (call $wnd_set_owner (local.get $dlg) (local.get $owner))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x90C80000)))
    (call $defwndproc_do_nccalcsize (local.get $dlg))
    (call $ctrl_table_set (call $wnd_table_find (local.get $dlg)) (i32.const 13) (i32.const 0))
    (call $nc_flags_set (local.get $dlg) (i32.const 3))
    (call $dlg_fill_bkgnd (local.get $dlg))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
      (i32.const 14) (i32.const 14) (i32.const 310) (i32.const 18) (i32.const 0x50000000)
      (call $wat_str_to_heap (i32.const 0x111E9) (i32.const 25))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
      (i32.const 14) (i32.const 44) (i32.const 150) (i32.const 18) (i32.const 0x50000000)
      (call $wat_str_to_heap (i32.const 0x111BE) (i32.const 16))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
      (i32.const 24) (i32.const 76) (i32.const 40) (i32.const 18) (i32.const 0x50000000)
      (call $wat_str_to_heap (i32.const 0x111CF) (i32.const 5))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 2) (i32.const 1155)
      (i32.const 70) (i32.const 73) (i32.const 58) (i32.const 22) (i32.const 0x50810080)
      (call $wat_str_to_heap (i32.const 0x11203) (i32.const 4))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
      (i32.const 180) (i32.const 76) (i32.const 34) (i32.const 18) (i32.const 0x50000000)
      (call $wat_str_to_heap (i32.const 0x111D5) (i32.const 4))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 2) (i32.const 1156)
      (i32.const 220) (i32.const 73) (i32.const 58) (i32.const 22) (i32.const 0x50810080)
      (call $wat_str_to_heap (i32.const 0x11203) (i32.const 4))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
      (i32.const 24) (i32.const 112) (i32.const 40) (i32.const 18) (i32.const 0x50000000)
      (call $wat_str_to_heap (i32.const 0x111DA) (i32.const 6))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 2) (i32.const 1157)
      (i32.const 70) (i32.const 109) (i32.const 58) (i32.const 22) (i32.const 0x50810080)
      (call $wat_str_to_heap (i32.const 0x11203) (i32.const 4))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
      (i32.const 180) (i32.const 112) (i32.const 48) (i32.const 18) (i32.const 0x50000000)
      (call $wat_str_to_heap (i32.const 0x111E1) (i32.const 7))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 2) (i32.const 1158)
      (i32.const 234) (i32.const 109) (i32.const 58) (i32.const 22) (i32.const 0x50810080)
      (call $wat_str_to_heap (i32.const 0x11203) (i32.const 4))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 1)
      (i32.const 174) (i32.const 168) (i32.const 72) (i32.const 24) (i32.const 0x50010001)
      (call $wat_str_to_heap (i32.const 0x1D9) (i32.const 2))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 2)
      (i32.const 258) (i32.const 168) (i32.const 72) (i32.const 24) (i32.const 0x50010000)
      (call $wat_str_to_heap (i32.const 0x1D2) (i32.const 6)))))

  ;; ============================================================
  ;; MessageBox dialog — control class 15 ($msgbox_wndproc)
  ;; ============================================================
  ;;
  ;; $msgbox_wndproc is its own class because it needs to map every
  ;; WM_COMMAND id (1=IDOK ... 11=IDCONTINUE) directly into modal_done's
  ;; result. The stub_wndproc only knows IDOK/IDCANCEL.
  (func $msgbox_wndproc
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $cmd i32)
    (if (i32.eq (local.get $msg) (i32.const 0x0085))   ;; WM_NCPAINT
      (then (call $defwndproc_do_ncpaint (local.get $hwnd)) (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0014))   ;; WM_ERASEBKGND
      (then (return (call $host_erase_background (local.get $hwnd) (i32.const 16)))))
    (if (i32.eq (local.get $msg) (i32.const 0x0010))   ;; WM_CLOSE
      (then (call $modal_done (i32.const 2)) (return (i32.const 0))))  ;; IDCANCEL
    (if (i32.ne (local.get $msg) (i32.const 0x0111)) (then (return (i32.const 0))))
    (local.set $cmd (i32.and (local.get $wParam) (i32.const 0xFFFF)))
    ;; Any of IDOK..IDCONTINUE: report the id verbatim. Unknown cmds drop.
    (if (i32.and (i32.ge_u (local.get $cmd) (i32.const 1))
                 (i32.le_u (local.get $cmd) (i32.const 11)))
      (then (call $modal_done (local.get $cmd)) (return (i32.const 0))))
    (i32.const 0))

  ;; Append a button at $bx,$by, recording it in the dialog so the row
  ;; can be centered after all buttons are placed.
  (func $msgbox_btn (param $dlg i32) (param $id i32) (param $x i32) (param $y i32)
                    (param $label_wa i32) (param $label_len i32) (param $is_default i32)
    (local $style i32)
    ;; BS_PUSHBUTTON=0, BS_DEFPUSHBUTTON=1; WS_TABSTOP|WS_VISIBLE|WS_CHILD
    (local.set $style (i32.const 0x50010000))
    (if (local.get $is_default)
      (then (local.set $style (i32.or (local.get $style) (i32.const 1)))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (local.get $id)
            (local.get $x) (local.get $y) (i32.const 72) (i32.const 24)
            (local.get $style)
            (call $wat_str_to_heap (local.get $label_wa) (local.get $label_len)))))

  ;; Builds a dialog whose static text is the caller's message string and
  ;; whose title is the caller's caption. Decodes the MB_* button mask
  ;; (low nibble of $uType) into the matching button row. NULL caption
  ;; is tolerated (renders empty).
  ;; $text_wa / $caption_wa are WASM linear addresses (already $g2w'd).
  (func $create_msgbox_dialog
    (param $dlg i32) (param $owner i32) (param $caption_wa i32) (param $text_wa i32)
    (param $uType i32)
    (local $text_len i32) (local $cap_len i32)
    (local $text_g i32) (local $w i32) (local $h i32)
    (local $btn_kind i32) (local $n_btn i32) (local $row_w i32)
    (local $bx i32) (local $by i32) (local $longest i32)
    (local $slot i32) (local $ch i32)
    (local.set $text_len (call $strlen (local.get $text_wa)))
    (if (i32.eqz (local.get $caption_wa))
      (then (local.set $cap_len (i32.const 0)))
      (else (local.set $cap_len (call $strlen (local.get $caption_wa)))))
    (local.set $btn_kind (i32.and (local.get $uType) (i32.const 0xF)))
    ;; Decide button count up front so we can size the dialog.
    (local.set $n_btn
      (select (i32.const 1)                                    ;; default
        (select (i32.const 2)                                  ;; OKCANCEL/RETRYCANCEL/YESNO
          (select (i32.const 3)                                ;; ABORTRETRYIGNORE/YESNOCANCEL/CANCELTRYCONTINUE
            (i32.const 0)
            (i32.or (i32.or
              (i32.eq (local.get $btn_kind) (i32.const 2))
              (i32.eq (local.get $btn_kind) (i32.const 3)))
              (i32.eq (local.get $btn_kind) (i32.const 6))))
          (i32.or (i32.or
            (i32.eq (local.get $btn_kind) (i32.const 1))
            (i32.eq (local.get $btn_kind) (i32.const 4)))
            (i32.eq (local.get $btn_kind) (i32.const 5))))
        (i32.eqz (local.get $btn_kind))))
    (if (i32.eqz (local.get $n_btn)) (then (local.set $n_btn (i32.const 1))))
    (local.set $row_w (i32.add
      (i32.mul (local.get $n_btn) (i32.const 76))
      (i32.const 8)))
    ;; Pick width: max of (longer string * 6 + 60), button row + 32, 220 floor.
    (local.set $longest (select (local.get $text_len) (local.get $cap_len)
      (i32.gt_u (local.get $text_len) (local.get $cap_len))))
    (local.set $w (i32.add (i32.mul (local.get $longest) (i32.const 6)) (i32.const 60)))
    (if (i32.lt_u (local.get $w) (i32.add (local.get $row_w) (i32.const 32)))
      (then (local.set $w (i32.add (local.get $row_w) (i32.const 32)))))
    (if (i32.lt_u (local.get $w) (i32.const 220)) (then (local.set $w (i32.const 220))))
    (if (i32.gt_u (local.get $w) (i32.const 420)) (then (local.set $w (i32.const 420))))
    (local.set $h (i32.const 140))
    (call $host_register_dialog_frame
      (local.get $dlg) (local.get $owner)
      (local.get $caption_wa)
      (local.get $w) (local.get $h)
      (i32.const 1))
    (call $wnd_table_set (local.get $dlg) (global.get $WNDPROC_CTRL_NATIVE))
    (if (local.get $caption_wa)
      (then (call $title_table_set (local.get $dlg) (local.get $caption_wa)
              (local.get $cap_len))))
    (call $wnd_set_owner (local.get $dlg) (local.get $owner))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x90C80000)))
    (call $ctrl_table_set (call $wnd_table_find (local.get $dlg))
      (i32.const 16) (i32.const 0))
    ;; Match the normal dialog path: establish client geometry before any
    ;; erase/background/child paints. Otherwise the browser compositor can
    ;; see only the frame while child controls are painted against stale
    ;; window-local client bounds.
    (call $defwndproc_do_nccalcsize (local.get $dlg))
    ;; Paint the frame/background immediately. MessageBox can be created
    ;; inside a synchronous button click; if it waits for the modal pump's
    ;; first paint pass, the browser mouse-up from the original click can
    ;; arrive first and leave the user staring at the disabled owner.
    (drop (call $host_erase_background (local.get $dlg) (i32.const 16)))
    (call $defwndproc_do_ncpaint (local.get $dlg))
    ;; Message text static.
    (local.set $text_g (call $wat_str_to_heap (local.get $text_wa) (local.get $text_len)))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
            (i32.const 16) (i32.const 24)
            (i32.sub (local.get $w) (i32.const 32)) (i32.const 45)
            (i32.const 0x50000000)
            (local.get $text_g)))
    ;; Button row, left edge centered around dialog midpoint.
    ;; Child controls use client coordinates. MessageBox has a captioned
    ;; 3px frame, 19px caption/client separator, and 4px bottom border, so
    ;; place the row relative to the client bottom rather than the outer
    ;; window bottom.
    (local.set $bx (i32.div_u (i32.sub (local.get $w) (local.get $row_w)) (i32.const 2)))
    (local.set $by (i32.sub (local.get $h) (i32.const 63)))
    ;; Layout per MB_* mask. IDs match winuser.h.
    (block $done
      ;; MB_OK (0)
      (if (i32.eqz (local.get $btn_kind))
        (then
          (call $msgbox_btn (local.get $dlg) (i32.const 1)
            (local.get $bx) (local.get $by) (i32.const 0x11000) (i32.const 2) (i32.const 1))
          (br $done)))
      ;; MB_OKCANCEL (1)
      (if (i32.eq (local.get $btn_kind) (i32.const 1))
        (then
          (call $msgbox_btn (local.get $dlg) (i32.const 1)
            (local.get $bx) (local.get $by) (i32.const 0x11000) (i32.const 2) (i32.const 1))
          (call $msgbox_btn (local.get $dlg) (i32.const 2)
            (i32.add (local.get $bx) (i32.const 76)) (local.get $by)
            (i32.const 0x11003) (i32.const 6) (i32.const 0))
          (br $done)))
      ;; MB_ABORTRETRYIGNORE (2)
      (if (i32.eq (local.get $btn_kind) (i32.const 2))
        (then
          (call $msgbox_btn (local.get $dlg) (i32.const 3)
            (local.get $bx) (local.get $by) (i32.const 0x1100A) (i32.const 5) (i32.const 1))
          (call $msgbox_btn (local.get $dlg) (i32.const 4)
            (i32.add (local.get $bx) (i32.const 76)) (local.get $by)
            (i32.const 0x11010) (i32.const 5) (i32.const 0))
          (call $msgbox_btn (local.get $dlg) (i32.const 5)
            (i32.add (local.get $bx) (i32.const 152)) (local.get $by)
            (i32.const 0x11016) (i32.const 6) (i32.const 0))
          (br $done)))
      ;; MB_YESNOCANCEL (3)
      (if (i32.eq (local.get $btn_kind) (i32.const 3))
        (then
          (call $msgbox_btn (local.get $dlg) (i32.const 6)
            (local.get $bx) (local.get $by) (i32.const 0x1101D) (i32.const 3) (i32.const 1))
          (call $msgbox_btn (local.get $dlg) (i32.const 7)
            (i32.add (local.get $bx) (i32.const 76)) (local.get $by)
            (i32.const 0x11021) (i32.const 2) (i32.const 0))
          (call $msgbox_btn (local.get $dlg) (i32.const 2)
            (i32.add (local.get $bx) (i32.const 152)) (local.get $by)
            (i32.const 0x11003) (i32.const 6) (i32.const 0))
          (br $done)))
      ;; MB_YESNO (4)
      (if (i32.eq (local.get $btn_kind) (i32.const 4))
        (then
          (call $msgbox_btn (local.get $dlg) (i32.const 6)
            (local.get $bx) (local.get $by) (i32.const 0x1101D) (i32.const 3) (i32.const 1))
          (call $msgbox_btn (local.get $dlg) (i32.const 7)
            (i32.add (local.get $bx) (i32.const 76)) (local.get $by)
            (i32.const 0x11021) (i32.const 2) (i32.const 0))
          (br $done)))
      ;; MB_RETRYCANCEL (5)
      (if (i32.eq (local.get $btn_kind) (i32.const 5))
        (then
          (call $msgbox_btn (local.get $dlg) (i32.const 4)
            (local.get $bx) (local.get $by) (i32.const 0x11010) (i32.const 5) (i32.const 1))
          (call $msgbox_btn (local.get $dlg) (i32.const 2)
            (i32.add (local.get $bx) (i32.const 76)) (local.get $by)
            (i32.const 0x11003) (i32.const 6) (i32.const 0))
          (br $done)))
      ;; MB_CANCELTRYCONTINUE (6)
      (if (i32.eq (local.get $btn_kind) (i32.const 6))
        (then
          (call $msgbox_btn (local.get $dlg) (i32.const 2)
            (local.get $bx) (local.get $by) (i32.const 0x11003) (i32.const 6) (i32.const 1))
          (call $msgbox_btn (local.get $dlg) (i32.const 10)
            (i32.add (local.get $bx) (i32.const 76)) (local.get $by)
            (i32.const 0x11024) (i32.const 9) (i32.const 0))
          (call $msgbox_btn (local.get $dlg) (i32.const 11)
            (i32.add (local.get $bx) (i32.const 152)) (local.get $by)
            (i32.const 0x1102E) (i32.const 8) (i32.const 0))
          (br $done)))
      ;; Fallback: lone OK.
      (call $msgbox_btn (local.get $dlg) (i32.const 1)
        (local.get $bx) (local.get $by) (i32.const 0x11000) (i32.const 2) (i32.const 1)))
    ;; Static text + buttons. Used by renderer-input.js for Enter/Esc
    ;; handling on the message box.
    (i32.store offset=28 (call $dlg_record_for_hwnd (local.get $dlg))
               (i32.add (local.get $n_btn) (i32.const 1)))
    ;; Paint the WAT-built children immediately for the same reason as the
    ;; frame/background above.
    (local.set $slot (i32.const 0))
    (block $paint_done (loop $paint_children
      (local.set $slot (call $wnd_next_child_slot (local.get $dlg) (local.get $slot)))
      (br_if $paint_done (i32.eq (local.get $slot) (i32.const -1)))
      (local.set $ch (call $wnd_slot_hwnd (local.get $slot)))
      (if (local.get $ch)
        (then (drop (call $wnd_send_message
          (local.get $ch) (i32.const 0x000F) (i32.const 0) (i32.const 0)))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $paint_children)))
    (call $dlg_seed_focus (local.get $dlg))
    ;; Focus seeding can repaint the default button and touch the dialog
    ;; background. Repaint children once more so non-focused sibling buttons
    ;; are not left partially covered in the first visible modal frame.
    (local.set $slot (i32.const 0))
    (block $paint_done2 (loop $paint_children2
      (local.set $slot (call $wnd_next_child_slot (local.get $dlg) (local.get $slot)))
      (br_if $paint_done2 (i32.eq (local.get $slot) (i32.const -1)))
      (local.set $ch (call $wnd_slot_hwnd (local.get $slot)))
      (if (local.get $ch)
        (then (drop (call $wnd_send_message
          (local.get $ch) (i32.const 0x000F) (i32.const 0) (i32.const 0)))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $paint_children2))))

  ;; ============================================================
  ;; Font (ChooseFont) dialog — control class 14
  ;; ============================================================
  ;;
  ;; Three listboxes (face / style / size) + OK / Cancel. The CHOOSEFONT
  ;; guest ptr is stashed in userdata so the IDOK handler can write the
  ;; selected face/style/size back into CHOOSEFONT.lpLogFont plus the
  ;; CHOOSEFONT output fields that apps commonly consume (notably
  ;; iPointSize). WordPad builds its RichEdit CHARFORMAT from that result.
  ;;
  ;; Listbox control IDs: face=0x450, style=0x451, size=0x452.
  (func $fontdlg_wndproc
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $cmd i32) (local $cf i32) (local $cf_w i32)
    (local $lf_g i32) (local $lf_w i32)
    (local $face_h i32) (local $size_h i32)
    (local $size_sel i32) (local $size_buf_g i32) (local $size_buf_w i32)
    (local $size_val i32) (local $i i32) (local $c i32)

    (if (i32.eq (local.get $msg) (i32.const 0x0085))   ;; WM_NCPAINT
      (then (call $defwndproc_do_ncpaint (local.get $hwnd)) (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0014))   ;; WM_ERASEBKGND
      (then (return (call $host_erase_background (local.get $hwnd) (i32.const 16)))))
    (if (i32.eq (local.get $msg) (i32.const 0x0010))   ;; WM_CLOSE
      (then (call $modal_done (i32.const 0)) (return (i32.const 0))))
    (if (i32.ne (local.get $msg) (i32.const 0x0111)) (then (return (i32.const 0))))
    (local.set $cmd (i32.and (local.get $wParam) (i32.const 0xFFFF)))

    ;; ---- Cancel ----
    (if (i32.eq (local.get $cmd) (i32.const 2))
      (then (call $modal_done (i32.const 0)) (return (i32.const 0))))

    ;; ---- OK: write selected face/style/size back to CHOOSEFONT ----
    (if (i32.eq (local.get $cmd) (i32.const 1))
      (then
        (call $fontdlg_writeback (local.get $hwnd))
        (call $modal_done (i32.const 1))
        (return (i32.const 0))))
    (i32.const 0))

  ;; Helper: read selected face/style/size from the dialog listboxes and
  ;; populate the CHOOSEFONT output fields that legacy apps expect:
  ;;
  ;;   CHOOSEFONT.lpLogFont (+0x0C) -> LOGFONTA
  ;;   CHOOSEFONT.iPointSize (+0x10) = selected point size * 10
  ;;   CHOOSEFONT.lpszStyle (+0x2C), if provided
  ;;   CHOOSEFONT.nFontType (+0x30) style flags + TRUETYPE_FONTTYPE
  ;;
  ;; LOGFONT.lfHeight remains a simple negative point-size proxy. iPointSize
  ;; gives MFC/WordPad the standard tenths-of-points value for
  ;; CHARFORMAT.yHeight; RichEdit's latest-size reporting/rendering cache is
  ;; tracked separately from this common-dialog writeback.
  (func $fontdlg_writeback (param $hwnd i32)
    (local $cf i32) (local $cf_w i32) (local $lf_g i32) (local $lf_w i32)
    (local $face_h i32) (local $style_h i32) (local $size_h i32)
    (local $face_sel i32) (local $style_sel i32) (local $size_sel i32)
    (local $buf_g i32) (local $buf_w i32)
    (local $style_dst_g i32) (local $font_type i32)
    (local $val i32) (local $i i32) (local $c i32)
    (local.set $cf (call $wnd_get_userdata (local.get $hwnd)))
    (if (i32.eqz (local.get $cf)) (then (return)))
    (local.set $cf_w (call $g2w (local.get $cf)))
    (local.set $lf_g (i32.load offset=12 (local.get $cf_w)))
    (if (i32.eqz (local.get $lf_g)) (then (return)))
    (local.set $lf_w (call $g2w (local.get $lf_g)))

    ;; Style selection -> LOGFONT weight/italic + CHOOSEFONT.nFontType.
    (local.set $style_h (call $ctrl_find_by_id (local.get $hwnd) (i32.const 0x451)))
    (local.set $style_sel (i32.const 0))
    (if (local.get $style_h)
      (then
        (local.set $style_sel (call $wnd_send_message
          (local.get $style_h) (i32.const 0x0188) (i32.const 0) (i32.const 0)))
        (if (i32.lt_s (local.get $style_sel) (i32.const 0))
          (then (local.set $style_sel (i32.const 0))))))
    (i32.store offset=16 (local.get $lf_w) (i32.const 400))
    (if (i32.or (i32.eq (local.get $style_sel) (i32.const 1))
                (i32.eq (local.get $style_sel) (i32.const 3)))
      (then (i32.store offset=16 (local.get $lf_w) (i32.const 700))))
    (i32.store8 offset=20 (local.get $lf_w) (i32.const 0))
    (if (i32.or (i32.eq (local.get $style_sel) (i32.const 2))
                (i32.eq (local.get $style_sel) (i32.const 3)))
      (then (i32.store8 offset=20 (local.get $lf_w) (i32.const 1))))
    (i32.store8 offset=21 (local.get $lf_w) (i32.const 0)) ;; lfUnderline
    (i32.store8 offset=22 (local.get $lf_w) (i32.const 0)) ;; lfStrikeOut
    (local.set $font_type (i32.const 0x0404)) ;; REGULAR_FONTTYPE | TRUETYPE_FONTTYPE
    (if (i32.eq (local.get $style_sel) (i32.const 1))
      (then (local.set $font_type (i32.const 0x0104)))) ;; BOLD | TRUETYPE
    (if (i32.eq (local.get $style_sel) (i32.const 2))
      (then (local.set $font_type (i32.const 0x0204)))) ;; ITALIC | TRUETYPE
    (if (i32.eq (local.get $style_sel) (i32.const 3))
      (then (local.set $font_type (i32.const 0x0304)))) ;; BOLD | ITALIC | TRUETYPE
    (i32.store16 offset=48 (local.get $cf_w) (local.get $font_type))
    (local.set $style_dst_g (i32.load offset=44 (local.get $cf_w)))
    (if (local.get $style_h)
      (then
        (if (local.get $style_dst_g)
          (then
            (drop (call $wnd_send_message
              (local.get $style_h) (i32.const 0x0189)
              (local.get $style_sel) (local.get $style_dst_g)))))))

    ;; Face selection -> LOGFONT.lfFaceName (32-byte ANSI buffer).
    (local.set $face_h (call $ctrl_find_by_id (local.get $hwnd) (i32.const 0x450)))
    (local.set $face_sel (i32.const 0))
    (if (local.get $face_h)
      (then
        (local.set $face_sel (call $wnd_send_message
          (local.get $face_h) (i32.const 0x0188) (i32.const 0) (i32.const 0)))
        (if (i32.lt_s (local.get $face_sel) (i32.const 0))
          (then (local.set $face_sel (i32.const 0))))
        (call $zero_memory (i32.add (local.get $lf_w) (i32.const 28)) (i32.const 32))
        (drop (call $wnd_send_message
          (local.get $face_h) (i32.const 0x0189)
          (local.get $face_sel) (i32.add (local.get $lf_g) (i32.const 28))))))

    ;; Size selection -> LOGFONT.lfHeight and CHOOSEFONT.iPointSize.
    (local.set $size_h (call $ctrl_find_by_id (local.get $hwnd) (i32.const 0x452)))
    (if (i32.eqz (local.get $size_h)) (then (return)))
    (local.set $size_sel (call $wnd_send_message (local.get $size_h) (i32.const 0x0188) (i32.const 0) (i32.const 0)))
    (if (i32.lt_s (local.get $size_sel) (i32.const 0)) (then (return)))
    (local.set $buf_g (call $heap_alloc (i32.const 16)))
    (local.set $buf_w (call $g2w (local.get $buf_g)))
    (drop (call $wnd_send_message (local.get $size_h) (i32.const 0x0189) (local.get $size_sel) (local.get $buf_g)))
    (local.set $val (i32.const 0))
    (local.set $i (i32.const 0))
    (block $end (loop $digit
      (local.set $c (i32.load8_u (i32.add (local.get $buf_w) (local.get $i))))
      (br_if $end (i32.or (i32.lt_s (local.get $c) (i32.const 0x30))
                          (i32.gt_s (local.get $c) (i32.const 0x39))))
      (local.set $val (i32.add (i32.mul (local.get $val) (i32.const 10))
                               (i32.sub (local.get $c) (i32.const 0x30))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $digit)))
    (call $heap_free (local.get $buf_g))
    (if (i32.gt_s (local.get $val) (i32.const 0))
      (then
        (i32.store (local.get $lf_w) (i32.sub (i32.const 0) (local.get $val)))
        (i32.store offset=16 (local.get $cf_w)
          (i32.mul (local.get $val) (i32.const 10))))))

  (func $create_font_dialog (param $dlg i32) (param $owner i32) (param $cf i32)
    (local $face_lb i32) (local $style_lb i32) (local $size_lb i32)
    (call $host_register_dialog_frame
      (local.get $dlg) (local.get $owner)
      (i32.const 0x258)   ;; "Font"
      (i32.const 420) (i32.const 260)
      (i32.const 1))
    (call $wnd_table_set (local.get $dlg) (global.get $WNDPROC_CTRL_NATIVE))
    (call $title_table_set (local.get $dlg) (i32.const 0x258) (i32.const 4))
    (call $wnd_set_owner (local.get $dlg) (local.get $owner))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x90C80000)))
    (call $defwndproc_do_nccalcsize (local.get $dlg))
    (call $ctrl_table_set (call $wnd_table_find (local.get $dlg))
      (i32.const 14) (i32.const 0))
    (call $nc_flags_set (local.get $dlg) (i32.const 3))
    (call $dlg_fill_bkgnd (local.get $dlg))
    (drop (call $wnd_set_userdata (local.get $dlg) (local.get $cf)))

    ;; Face label + listbox
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
            (i32.const 12) (i32.const 8) (i32.const 40) (i32.const 14)
            (i32.const 0x50000000)
            (call $wat_str_to_heap (i32.const 0x25D) (i32.const 5))))
    (local.set $face_lb (call $ctrl_create_child (local.get $dlg) (i32.const 4) (i32.const 0x450)
                          (i32.const 12) (i32.const 24) (i32.const 160) (i32.const 120)
                          (i32.const 0x50810001) (i32.const 0)))
    (drop (call $wnd_send_message (local.get $face_lb) (i32.const 0x0180) (i32.const 0)
            (call $wat_str_to_heap (i32.const 0x270) (i32.const 13))))
    (drop (call $wnd_send_message (local.get $face_lb) (i32.const 0x0180) (i32.const 0)
            (call $wat_str_to_heap (i32.const 0x27E) (i32.const 5))))
    (drop (call $wnd_send_message (local.get $face_lb) (i32.const 0x0180) (i32.const 0)
            (call $wat_str_to_heap (i32.const 0x284) (i32.const 11))))
    (drop (call $wnd_send_message (local.get $face_lb) (i32.const 0x0180) (i32.const 0)
            (call $wat_str_to_heap (i32.const 0x290) (i32.const 15))))
    (drop (call $wnd_send_message (local.get $face_lb) (i32.const 0x0186) (i32.const 0) (i32.const 0)))

    ;; Style label + listbox
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
            (i32.const 180) (i32.const 8) (i32.const 40) (i32.const 14)
            (i32.const 0x50000000)
            (call $wat_str_to_heap (i32.const 0x263) (i32.const 6))))
    (local.set $style_lb (call $ctrl_create_child (local.get $dlg) (i32.const 4) (i32.const 0x451)
                           (i32.const 180) (i32.const 24) (i32.const 100) (i32.const 120)
                           (i32.const 0x50810001) (i32.const 0)))
    (drop (call $wnd_send_message (local.get $style_lb) (i32.const 0x0180) (i32.const 0)
            (call $wat_str_to_heap (i32.const 0x2A0) (i32.const 7))))
    (drop (call $wnd_send_message (local.get $style_lb) (i32.const 0x0180) (i32.const 0)
            (call $wat_str_to_heap (i32.const 0x2A8) (i32.const 4))))
    (drop (call $wnd_send_message (local.get $style_lb) (i32.const 0x0180) (i32.const 0)
            (call $wat_str_to_heap (i32.const 0x2AD) (i32.const 6))))
    (drop (call $wnd_send_message (local.get $style_lb) (i32.const 0x0180) (i32.const 0)
            (call $wat_str_to_heap (i32.const 0x2B4) (i32.const 11))))
    (drop (call $wnd_send_message (local.get $style_lb) (i32.const 0x0186) (i32.const 0) (i32.const 0)))

    ;; Size label + listbox
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
            (i32.const 288) (i32.const 8) (i32.const 40) (i32.const 14)
            (i32.const 0x50000000)
            (call $wat_str_to_heap (i32.const 0x26A) (i32.const 5))))
    (local.set $size_lb (call $ctrl_create_child (local.get $dlg) (i32.const 4) (i32.const 0x452)
                          (i32.const 288) (i32.const 24) (i32.const 60) (i32.const 120)
                          (i32.const 0x50810001) (i32.const 0)))
    (drop (call $wnd_send_message (local.get $size_lb) (i32.const 0x0180) (i32.const 0)
            (call $wat_str_to_heap (i32.const 0x2C0) (i32.const 1))))
    (drop (call $wnd_send_message (local.get $size_lb) (i32.const 0x0180) (i32.const 0)
            (call $wat_str_to_heap (i32.const 0x2C2) (i32.const 2))))
    (drop (call $wnd_send_message (local.get $size_lb) (i32.const 0x0180) (i32.const 0)
            (call $wat_str_to_heap (i32.const 0x2C5) (i32.const 2))))
    (drop (call $wnd_send_message (local.get $size_lb) (i32.const 0x0180) (i32.const 0)
            (call $wat_str_to_heap (i32.const 0x2C8) (i32.const 2))))
    (drop (call $wnd_send_message (local.get $size_lb) (i32.const 0x0180) (i32.const 0)
            (call $wat_str_to_heap (i32.const 0x2CB) (i32.const 2))))
    (drop (call $wnd_send_message (local.get $size_lb) (i32.const 0x0180) (i32.const 0)
            (call $wat_str_to_heap (i32.const 0x2CE) (i32.const 2))))
    (drop (call $wnd_send_message (local.get $size_lb) (i32.const 0x0186) (i32.const 1) (i32.const 0)))

    ;; OK / Cancel
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 1)
            (i32.const 358) (i32.const 24) (i32.const 52) (i32.const 22)
            (i32.const 0x50010001)
            (call $wat_str_to_heap (i32.const 0x1D9) (i32.const 2))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 2)
            (i32.const 358) (i32.const 52) (i32.const 52) (i32.const 22)
            (i32.const 0x50010000)
            (call $wat_str_to_heap (i32.const 0x1D2) (i32.const 6)))))

  ;; ============================================================
  ;; ColorGrid control (class 6) + Color (ChooseColor) dialog (class 15)
  ;; ============================================================
  ;;
  ;; ColorGrid renders either the standard 8x6 basic-color table (id 0x460)
  ;; or the CHOOSECOLOR-owned 8x2 custom-color table (id 0x461). Cells use
  ;; the classic common-dialog spacing: a bordered swatch followed by a small
  ;; COLOR_BTNFACE gutter. Clicks pick a cell and notify the parent through
  ;; WM_COMMAND + LBN_SELCHANGE (we reuse notification code 1).
  ;;
  ;; ColorGridState (8 bytes, allocated in WM_CREATE)
  ;;   +0   sel_idx       selected cell, -1 = none
  ;;   +4   ctrl_id
  ;;
  ;; The predefined values match the classic comdlg32 6x8 palette. Custom
  ;; colors are read directly from CHOOSECOLOR.lpCustColors so the application's
  ;; persistent 16-entry array is reflected every time the grid repaints.
  ;; Build the few labels used only by the expanded custom-color pane at
  ;; runtime. Keeping them here avoids reserving more global static-string
  ;; addresses for a pane that most callers never open.
  (global $colordlg_syncing (mut i32) (i32.const 0))

  (func $colordlg_make_label (param $kind i32) (result i32)
    (local $buf i32) (local $bw i32)
    (local.set $buf (call $heap_alloc (i32.const 21)))
    (local.set $bw (call $g2w (local.get $buf)))
    (call $zero_memory (local.get $bw) (i32.const 21))
    (if (i32.eq (local.get $kind) (i32.const 0))
      (then
        (i32.store (local.get $bw) (i32.const 0x3A646552)) ;; "Red:"
        (i32.store8 offset=4 (local.get $bw) (i32.const 0)))
      (else (if (i32.eq (local.get $kind) (i32.const 1))
        (then
          (i32.store (local.get $bw) (i32.const 0x65657247)) ;; "Gree"
          (i32.store16 offset=4 (local.get $bw) (i32.const 0x3A6E)) ;; "n:"
          (i32.store8 offset=6 (local.get $bw) (i32.const 0)))
        (else (if (i32.eq (local.get $kind) (i32.const 2))
          (then
            (i32.store (local.get $bw) (i32.const 0x65756C42)) ;; "Blue"
            (i32.store8 offset=4 (local.get $bw) (i32.const 0x3A))
            (i32.store8 offset=5 (local.get $bw) (i32.const 0)))
          (else (if (i32.eq (local.get $kind) (i32.const 3))
            (then
              (i32.store         (local.get $bw) (i32.const 0x20646441)) ;; "Add "
              (i32.store offset=4  (local.get $bw) (i32.const 0x43206F74)) ;; "to C"
              (i32.store offset=8  (local.get $bw) (i32.const 0x6F747375)) ;; "usto"
              (i32.store offset=12 (local.get $bw) (i32.const 0x6F43206D)) ;; "m Co"
              (i32.store offset=16 (local.get $bw) (i32.const 0x73726F6C))) ;; "lors"
            (else (if (i32.eq (local.get $kind) (i32.const 4))
              (then (i32.store (local.get $bw) (i32.const 0x3A657548))) ;; "Hue:"
              (else (if (i32.eq (local.get $kind) (i32.const 5))
                (then (i32.store (local.get $bw) (i32.const 0x3A746153))) ;; "Sat:"
                (else (if (i32.eq (local.get $kind) (i32.const 6))
                  (then (i32.store (local.get $bw) (i32.const 0x3A6D754C))) ;; "Lum:"
                  (else (if (i32.eq (local.get $kind) (i32.const 7))
                    (then
                      (i32.store (local.get $bw) (i32.const 0x6F6C6F43)) ;; "Colo"
                      (i32.store8 offset=4 (local.get $bw) (i32.const 0x72))) ;; "r"
                    (else
                      (i32.store (local.get $bw) (i32.const 0x6C6F537C)) ;; "|Sol"
                      (i32.store16 offset=4 (local.get $bw) (i32.const 0x6469))))))))))))))))))
    (local.get $buf))

  (func $colordlg_set_u8_text (param $hwnd i32) (param $value i32)
    (local $buf i32) (local $bw i32) (local $n i32) (local $was_syncing i32)
    (if (i32.gt_u (local.get $value) (i32.const 255))
      (then (local.set $value (i32.const 255))))
    (local.set $buf (call $heap_alloc (i32.const 4)))
    (local.set $bw (call $g2w (local.get $buf)))
    (if (i32.ge_u (local.get $value) (i32.const 100))
      (then
        (i32.store8 (local.get $bw)
          (i32.add (i32.div_u (local.get $value) (i32.const 100)) (i32.const 48)))
        (i32.store8 offset=1 (local.get $bw)
          (i32.add (i32.rem_u (i32.div_u (local.get $value) (i32.const 10)) (i32.const 10)) (i32.const 48)))
        (i32.store8 offset=2 (local.get $bw)
          (i32.add (i32.rem_u (local.get $value) (i32.const 10)) (i32.const 48)))
        (local.set $n (i32.const 3)))
      (else (if (i32.ge_u (local.get $value) (i32.const 10))
        (then
          (i32.store8 (local.get $bw)
            (i32.add (i32.div_u (local.get $value) (i32.const 10)) (i32.const 48)))
          (i32.store8 offset=1 (local.get $bw)
            (i32.add (i32.rem_u (local.get $value) (i32.const 10)) (i32.const 48)))
          (local.set $n (i32.const 2)))
        (else
          (i32.store8 (local.get $bw) (i32.add (local.get $value) (i32.const 48)))
          (local.set $n (i32.const 1))))))
    (i32.store8 (i32.add (local.get $bw) (local.get $n)) (i32.const 0))
    ;; EDIT sends EN_UPDATE/EN_CHANGE for WM_SETTEXT. Suppress only the
    ;; common-dialog's own synchronization response so updating one field
    ;; cannot recursively rebuild all six fields.
    (local.set $was_syncing (global.get $colordlg_syncing))
    (global.set $colordlg_syncing (i32.const 1))
    (drop (call $wnd_send_message
      (local.get $hwnd) (i32.const 0x000C) (i32.const 0) (local.get $buf)))
    (global.set $colordlg_syncing (local.get $was_syncing))
    (call $heap_free (local.get $buf)))

  (func $colordlg_sync_rgb_fields (param $dlg i32) (param $rgb i32)
    (local $edit i32)
    (local.set $edit (call $ctrl_find_by_id (local.get $dlg) (i32.const 0x463)))
    (if (local.get $edit)
      (then (call $colordlg_set_u8_text
        (local.get $edit) (i32.and (local.get $rgb) (i32.const 0xFF)))))
    (local.set $edit (call $ctrl_find_by_id (local.get $dlg) (i32.const 0x464)))
    (if (local.get $edit)
      (then (call $colordlg_set_u8_text (local.get $edit)
        (i32.and (i32.shr_u (local.get $rgb) (i32.const 8)) (i32.const 0xFF)))))
    (local.set $edit (call $ctrl_find_by_id (local.get $dlg) (i32.const 0x465)))
    (if (local.get $edit)
      (then (call $colordlg_set_u8_text (local.get $edit)
        (i32.and (i32.shr_u (local.get $rgb) (i32.const 16)) (i32.const 0xFF))))))

  ;; Convert COLORREF to the 0..240 HSL units used by the classic common
  ;; dialog. Return h | (s << 8) | (l << 16).
  (func $colordlg_rgb_to_hsl (param $rgb i32) (result i32)
    (local $r i32) (local $g i32) (local $b i32)
    (local $max i32) (local $min i32) (local $sum i32) (local $delta i32)
    (local $h i32) (local $s i32) (local $l i32)
    (local.set $r (i32.and (local.get $rgb) (i32.const 0xFF)))
    (local.set $g (i32.and (i32.shr_u (local.get $rgb) (i32.const 8)) (i32.const 0xFF)))
    (local.set $b (i32.and (i32.shr_u (local.get $rgb) (i32.const 16)) (i32.const 0xFF)))
    (local.set $max (local.get $r))
    (if (i32.gt_u (local.get $g) (local.get $max)) (then (local.set $max (local.get $g))))
    (if (i32.gt_u (local.get $b) (local.get $max)) (then (local.set $max (local.get $b))))
    (local.set $min (local.get $r))
    (if (i32.lt_u (local.get $g) (local.get $min)) (then (local.set $min (local.get $g))))
    (if (i32.lt_u (local.get $b) (local.get $min)) (then (local.set $min (local.get $b))))
    (local.set $sum (i32.add (local.get $max) (local.get $min)))
    (local.set $delta (i32.sub (local.get $max) (local.get $min)))
    (local.set $l (i32.div_u (i32.mul (local.get $sum) (i32.const 120)) (i32.const 255)))
    (if (local.get $delta)
      (then
        (local.set $s
          (if (result i32) (i32.le_u (local.get $sum) (i32.const 255))
            (then (i32.div_u (i32.mul (local.get $delta) (i32.const 240)) (local.get $sum)))
            (else (i32.div_u (i32.mul (local.get $delta) (i32.const 240))
              (i32.sub (i32.const 510) (local.get $sum))))))
        (if (i32.eq (local.get $max) (local.get $r))
          (then (local.set $h (i32.div_s
            (i32.mul (i32.sub (local.get $g) (local.get $b)) (i32.const 40))
            (local.get $delta))))
          (else (if (i32.eq (local.get $max) (local.get $g))
            (then (local.set $h (i32.add (i32.const 80) (i32.div_s
              (i32.mul (i32.sub (local.get $b) (local.get $r)) (i32.const 40))
              (local.get $delta)))))
            (else (local.set $h (i32.add (i32.const 160) (i32.div_s
              (i32.mul (i32.sub (local.get $r) (local.get $g)) (i32.const 40))
              (local.get $delta))))))))
        (if (i32.lt_s (local.get $h) (i32.const 0))
          (then (local.set $h (i32.add (local.get $h) (i32.const 240)))))
        (if (i32.ge_s (local.get $h) (i32.const 240))
          (then (local.set $h (i32.sub (local.get $h) (i32.const 240)))))))
    (i32.or (local.get $h)
      (i32.or (i32.shl (local.get $s) (i32.const 8))
              (i32.shl (local.get $l) (i32.const 16)))))

  (func $colordlg_sync_hsl_fields
    (param $dlg i32) (param $h i32) (param $s i32) (param $l i32)
    (local $edit i32)
    (local.set $edit (call $ctrl_find_by_id (local.get $dlg) (i32.const 0x468)))
    (if (local.get $edit) (then (call $colordlg_set_u8_text (local.get $edit) (local.get $h))))
    (local.set $edit (call $ctrl_find_by_id (local.get $dlg) (i32.const 0x469)))
    (if (local.get $edit) (then (call $colordlg_set_u8_text (local.get $edit) (local.get $s))))
    (local.set $edit (call $ctrl_find_by_id (local.get $dlg) (i32.const 0x46A)))
    (if (local.get $edit) (then (call $colordlg_set_u8_text (local.get $edit) (local.get $l)))))

  (func $colordlg_invalidate_preview (param $dlg i32)
    (local $preview i32)
    (local.set $preview (call $ctrl_find_by_id (local.get $dlg) (i32.const 0x46B)))
    (if (local.get $preview) (then (call $invalidate_hwnd (local.get $preview)))))

  (func $colordlg_sync_spectrum_from_rgb (param $dlg i32) (param $rgb i32)
    (local $packed i32) (local $picker i32) (local $state i32) (local $sw i32)
    (local.set $packed (call $colordlg_rgb_to_hsl (local.get $rgb)))
    (local.set $picker (call $ctrl_find_by_id (local.get $dlg) (i32.const 0x467)))
    (if (local.get $picker)
      (then
        (local.set $state (call $wnd_get_state_ptr (local.get $picker)))
        (if (local.get $state)
          (then
            (local.set $sw (call $g2w (local.get $state)))
            (i32.store (local.get $sw) (i32.and (local.get $packed) (i32.const 0xFF)))
            (i32.store offset=4 (local.get $sw)
              (i32.and (i32.shr_u (local.get $packed) (i32.const 8)) (i32.const 0xFF)))
            (i32.store offset=8 (local.get $sw)
              (i32.and (i32.shr_u (local.get $packed) (i32.const 16)) (i32.const 0xFF)))))
        (call $invalidate_hwnd (local.get $picker))))
    (call $colordlg_sync_hsl_fields
      (local.get $dlg)
      (i32.and (local.get $packed) (i32.const 0xFF))
      (i32.and (i32.shr_u (local.get $packed) (i32.const 8)) (i32.const 0xFF))
      (i32.and (i32.shr_u (local.get $packed) (i32.const 16)) (i32.const 0xFF)))
    (call $colordlg_invalidate_preview (local.get $dlg)))

  (func $colordlg_sync_from_rgb (param $dlg i32) (param $rgb i32)
    (call $colordlg_sync_rgb_fields (local.get $dlg) (local.get $rgb))
    (call $colordlg_sync_spectrum_from_rgb (local.get $dlg) (local.get $rgb)))

  ;; Convert classic common-dialog HSL units (0..240) to one RGB channel.
  (func $colordlg_hue_component
    (param $p i32) (param $q i32) (param $t i32) (result i32)
    (local $v i32)
    (if (i32.lt_s (local.get $t) (i32.const 0))
      (then (local.set $t (i32.add (local.get $t) (i32.const 240)))))
    (if (i32.gt_s (local.get $t) (i32.const 240))
      (then (local.set $t (i32.sub (local.get $t) (i32.const 240)))))
    (local.set $v
      (if (result i32) (i32.lt_s (local.get $t) (i32.const 40))
        (then (i32.add (local.get $p)
          (i32.div_s
            (i32.mul (i32.sub (local.get $q) (local.get $p)) (local.get $t))
            (i32.const 40))))
        (else (if (result i32) (i32.lt_s (local.get $t) (i32.const 120))
          (then (local.get $q))
          (else (if (result i32) (i32.lt_s (local.get $t) (i32.const 160))
            (then (i32.add (local.get $p)
              (i32.div_s
                (i32.mul (i32.sub (local.get $q) (local.get $p))
                  (i32.sub (i32.const 160) (local.get $t)))
                (i32.const 40))))
            (else (local.get $p))))))))
    (i32.div_s (i32.mul (local.get $v) (i32.const 255)) (i32.const 240)))

  (func $colordlg_hsl_to_rgb
    (param $h i32) (param $s i32) (param $l i32) (result i32)
    (local $p i32) (local $q i32)
    (local $r i32) (local $g i32) (local $b i32)
    (if (i32.eqz (local.get $s))
      (then
        (local.set $r (i32.div_s
          (i32.mul (local.get $l) (i32.const 255)) (i32.const 240)))
        (return (i32.or (local.get $r)
          (i32.or (i32.shl (local.get $r) (i32.const 8))
                  (i32.shl (local.get $r) (i32.const 16)))))))
    (local.set $q
      (if (result i32) (i32.lt_s (local.get $l) (i32.const 120))
        (then (i32.div_s
          (i32.mul (local.get $l) (i32.add (i32.const 240) (local.get $s)))
          (i32.const 240)))
        (else (i32.sub
          (i32.add (local.get $l) (local.get $s))
          (i32.div_s (i32.mul (local.get $l) (local.get $s)) (i32.const 240))))))
    (local.set $p (i32.sub (i32.mul (local.get $l) (i32.const 2)) (local.get $q)))
    (local.set $r (call $colordlg_hue_component
      (local.get $p) (local.get $q) (i32.add (local.get $h) (i32.const 80))))
    (local.set $g (call $colordlg_hue_component
      (local.get $p) (local.get $q) (local.get $h)))
    (local.set $b (call $colordlg_hue_component
      (local.get $p) (local.get $q) (i32.sub (local.get $h) (i32.const 80))))
    (i32.or (local.get $r)
      (i32.or (i32.shl (local.get $g) (i32.const 8))
              (i32.shl (local.get $b) (i32.const 16)))))

  ;; State: hue, saturation, luminosity (all 0..240).
  (func $colorspectrum_commit (param $hwnd i32) (param $sw i32)
    (local $dlg i32) (local $cc i32) (local $rgb i32)
    (local.set $rgb (call $colordlg_hsl_to_rgb
      (i32.load (local.get $sw))
      (i32.load offset=4 (local.get $sw))
      (i32.load offset=8 (local.get $sw))))
    (local.set $dlg (call $wnd_get_parent (local.get $hwnd)))
    (local.set $cc (call $wnd_get_userdata (local.get $dlg)))
    (if (local.get $cc)
      (then (i32.store offset=12 (call $g2w (local.get $cc)) (local.get $rgb))))
    (call $colordlg_sync_rgb_fields (local.get $dlg) (local.get $rgb))
    (call $colordlg_sync_hsl_fields
      (local.get $dlg)
      (i32.load (local.get $sw))
      (i32.load offset=4 (local.get $sw))
      (i32.load offset=8 (local.get $sw)))
    (call $colordlg_invalidate_preview (local.get $dlg))
    (call $invalidate_hwnd (local.get $hwnd)))

  (func $colorspectrum_wndproc
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $state i32) (local $sw i32) (local $hdc i32)
    (local $x i32) (local $y i32)
    (local $row i32) (local $seg i32) (local $sat i32) (local $lum i32)
    (local $x0 i32) (local $x1 i32) (local $c0 i32) (local $c1 i32)
    (local $mark_x i32) (local $mark_y i32)
    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))

    (if (i32.eq (local.get $msg) (i32.const 0x0001))
      (then
        (local.set $state (call $heap_alloc (i32.const 12)))
        (local.set $sw (call $g2w (local.get $state)))
        (i32.store (local.get $sw) (i32.const 0))
        (i32.store offset=4 (local.get $sw) (i32.const 0))
        (i32.store offset=8 (local.get $sw) (i32.const 0))
        (call $wnd_set_state_ptr (local.get $hwnd) (local.get $state))
        (return (i32.const 0))))

    (if (i32.eq (local.get $msg) (i32.const 0x0002))
      (then
        (if (local.get $state)
          (then (call $heap_free (local.get $state))
                (call $wnd_set_state_ptr (local.get $hwnd) (i32.const 0))))
        (return (i32.const 0))))
    (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
    (local.set $sw (call $g2w (local.get $state)))

    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        (drop (call $host_gdi_fill_rect (local.get $hdc)
          (i32.const 0) (i32.const 0) (i32.const 196) (i32.const 140)
          (i32.const 0x30011)))
        (drop (call $host_gdi_draw_edge (local.get $hdc)
          (i32.const 0) (i32.const 0) (i32.const 164) (i32.const 124)
          (i32.const 0x0A) (i32.const 0x0F)))
        (drop (call $host_gdi_draw_edge (local.get $hdc)
          (i32.const 174) (i32.const 0) (i32.const 194) (i32.const 124)
          (i32.const 0x0A) (i32.const 0x0F)))
        (local.set $row (i32.const 0))
        (block $paint_done (loop $paint_rows
          (br_if $paint_done (i32.ge_u (local.get $row) (i32.const 120)))
          (local.set $sat (i32.sub (i32.const 240)
            (i32.div_u (i32.mul (local.get $row) (i32.const 240)) (i32.const 119))))
          (local.set $seg (i32.const 0))
          (block $segments_done (loop $paint_segments
            (br_if $segments_done (i32.ge_u (local.get $seg) (i32.const 6)))
            (local.set $x0 (i32.add (i32.const 2)
              (i32.div_u (i32.mul (local.get $seg) (i32.const 160)) (i32.const 6))))
            (local.set $x1 (i32.add (i32.const 2)
              (i32.div_u (i32.mul (i32.add (local.get $seg) (i32.const 1)) (i32.const 160)) (i32.const 6))))
            (local.set $c0 (call $colordlg_hsl_to_rgb
              (i32.mul (local.get $seg) (i32.const 40)) (local.get $sat) (i32.const 120)))
            (local.set $c1 (call $colordlg_hsl_to_rgb
              (i32.mul (i32.add (local.get $seg) (i32.const 1)) (i32.const 40))
              (local.get $sat) (i32.const 120)))
            (drop (call $host_gdi_gradient_fill_h (local.get $hdc)
              (local.get $x0) (i32.add (local.get $row) (i32.const 2))
              (local.get $x1) (i32.add (local.get $row) (i32.const 3))
              (local.get $c0) (local.get $c1)))
            (local.set $seg (i32.add (local.get $seg) (i32.const 1)))
            (br $paint_segments)))
          (local.set $lum (i32.sub (i32.const 240)
            (i32.div_u (i32.mul (local.get $row) (i32.const 240)) (i32.const 119))))
          (local.set $c0 (call $colordlg_hsl_to_rgb
            (i32.load (local.get $sw)) (i32.load offset=4 (local.get $sw)) (local.get $lum)))
          (drop (call $host_gdi_gradient_fill_h (local.get $hdc)
            (i32.const 176) (i32.add (local.get $row) (i32.const 2))
            (i32.const 192) (i32.add (local.get $row) (i32.const 3))
            (local.get $c0) (local.get $c0)))
          (local.set $row (i32.add (local.get $row) (i32.const 1)))
          (br $paint_rows)))
        (local.set $mark_x (i32.add (i32.const 2)
          (i32.div_u (i32.mul (i32.load (local.get $sw)) (i32.const 159)) (i32.const 240))))
        (local.set $mark_y (i32.add (i32.const 2)
          (i32.div_u
            (i32.mul (i32.sub (i32.const 240) (i32.load offset=4 (local.get $sw))) (i32.const 119))
            (i32.const 240))))
        (drop (call $host_gdi_draw_focus_rect (local.get $hdc)
          (i32.sub (local.get $mark_x) (i32.const 3))
          (i32.sub (local.get $mark_y) (i32.const 3))
          (i32.add (local.get $mark_x) (i32.const 4))
          (i32.add (local.get $mark_y) (i32.const 4))))
        (local.set $mark_y (i32.add (i32.const 2)
          (i32.div_u
            (i32.mul (i32.sub (i32.const 240) (i32.load offset=8 (local.get $sw))) (i32.const 119))
            (i32.const 240))))
        (drop (call $host_gdi_draw_focus_rect (local.get $hdc)
          (i32.const 174) (i32.sub (local.get $mark_y) (i32.const 2))
          (i32.const 195) (i32.add (local.get $mark_y) (i32.const 3))))
        (return (i32.const 0))))

    (if (i32.eq (local.get $msg) (i32.const 0x0201))
      (then
        (local.set $x (i32.and (local.get $lParam) (i32.const 0xFFFF)))
        (local.set $y (i32.and (i32.shr_u (local.get $lParam) (i32.const 16)) (i32.const 0xFFFF)))
        (if (i32.and
              (i32.and (i32.ge_u (local.get $x) (i32.const 2))
                       (i32.lt_u (local.get $x) (i32.const 162)))
              (i32.and (i32.ge_u (local.get $y) (i32.const 2))
                       (i32.lt_u (local.get $y) (i32.const 122))))
          (then
            (i32.store (local.get $sw)
              (i32.div_u (i32.mul (i32.sub (local.get $x) (i32.const 2)) (i32.const 240)) (i32.const 159)))
            (i32.store offset=4 (local.get $sw)
              (i32.sub (i32.const 240)
                (i32.div_u (i32.mul (i32.sub (local.get $y) (i32.const 2)) (i32.const 240)) (i32.const 119))))
            ;; A first spectrum click should produce a visible color even when
            ;; the caller's initial black selected luminosity zero.
            (if (i32.eqz (i32.load offset=8 (local.get $sw)))
              (then (i32.store offset=8 (local.get $sw) (i32.const 120))))
            (call $colorspectrum_commit (local.get $hwnd) (local.get $sw))))
        (if (i32.and
              (i32.and (i32.ge_u (local.get $x) (i32.const 176))
                       (i32.lt_u (local.get $x) (i32.const 192)))
              (i32.and (i32.ge_u (local.get $y) (i32.const 2))
                       (i32.lt_u (local.get $y) (i32.const 122))))
          (then
            (i32.store offset=8 (local.get $sw)
              (i32.sub (i32.const 240)
                (i32.div_u (i32.mul (i32.sub (local.get $y) (i32.const 2)) (i32.const 240)) (i32.const 119))))
            (call $colorspectrum_commit (local.get $hwnd) (local.get $sw))))
        (return (i32.const 0))))
    (i32.const 0))

  ;; The classic dialog presents the selected RGB value as a two-half
  ;; "Color|Solid" swatch. On our true-color surface both halves are the same
  ;; exact color; retaining the split and labels matches Win98 while leaving a
  ;; future palette-mode nearest-solid conversion straightforward.
  (func $colorpreview_wndproc
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $dlg i32) (local $cc i32) (local $rgb i32) (local $hdc i32)
    (local $sz i32) (local $w i32) (local $h i32) (local $brush i32)
    (if (i32.ne (local.get $msg) (i32.const 0x000F))
      (then (return (i32.const 0))))
    (local.set $dlg (call $wnd_get_parent (local.get $hwnd)))
    (local.set $cc (call $wnd_get_userdata (local.get $dlg)))
    (if (local.get $cc)
      (then (local.set $rgb (i32.load offset=12 (call $g2w (local.get $cc))))))
    (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
    (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
    (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
    (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
    (drop (call $host_gdi_fill_rect (local.get $hdc)
      (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
      (i32.const 0x30014))) ;; black frame
    (local.set $brush (call $host_gdi_create_solid_brush (local.get $rgb)))
    (drop (call $host_gdi_fill_rect (local.get $hdc)
      (i32.const 2) (i32.const 2)
      (i32.sub (local.get $w) (i32.const 2))
      (i32.sub (local.get $h) (i32.const 2))
      (local.get $brush)))
    (drop (call $host_gdi_delete_object (local.get $brush)))
    ;; Preserve the visible Color/Solid split even when both true-color halves
    ;; resolve identically.
    (drop (call $host_gdi_fill_rect (local.get $hdc)
      (i32.sub (i32.div_u (local.get $w) (i32.const 2)) (i32.const 1))
      (i32.const 1)
      (i32.div_u (local.get $w) (i32.const 2))
      (i32.sub (local.get $h) (i32.const 1))
      (i32.const 0x30014)))
    (i32.const 0))

  (func $colordlg_commit_rgb_edits (param $dlg i32)
    (local $cc i32) (local $r i32) (local $g i32) (local $b i32) (local $rgb i32)
    (local.set $cc (call $wnd_get_userdata (local.get $dlg)))
    (if (i32.eqz (local.get $cc)) (then (return)))
    (local.set $r (call $ctrl_decimal_value (local.get $dlg) (i32.const 0x463) (i32.const 0)))
    (local.set $g (call $ctrl_decimal_value (local.get $dlg) (i32.const 0x464) (i32.const 0)))
    (local.set $b (call $ctrl_decimal_value (local.get $dlg) (i32.const 0x465) (i32.const 0)))
    (if (i32.gt_u (local.get $r) (i32.const 255)) (then (local.set $r (i32.const 255))))
    (if (i32.gt_u (local.get $g) (i32.const 255)) (then (local.set $g (i32.const 255))))
    (if (i32.gt_u (local.get $b) (i32.const 255)) (then (local.set $b (i32.const 255))))
    (local.set $rgb (i32.or (local.get $r)
      (i32.or (i32.shl (local.get $g) (i32.const 8))
              (i32.shl (local.get $b) (i32.const 16)))))
    (i32.store offset=12 (call $g2w (local.get $cc)) (local.get $rgb))
    (call $colordlg_sync_spectrum_from_rgb (local.get $dlg) (local.get $rgb)))

  (func $colordlg_commit_hsl_edits (param $dlg i32)
    (local $cc i32) (local $picker i32) (local $state i32) (local $sw i32)
    (local $h i32) (local $s i32) (local $l i32) (local $rgb i32)
    (local.set $cc (call $wnd_get_userdata (local.get $dlg)))
    (local.set $picker (call $ctrl_find_by_id (local.get $dlg) (i32.const 0x467)))
    (if (i32.or (i32.eqz (local.get $cc)) (i32.eqz (local.get $picker))) (then (return)))
    (local.set $state (call $wnd_get_state_ptr (local.get $picker)))
    (if (i32.eqz (local.get $state)) (then (return)))
    (local.set $h (call $ctrl_decimal_value (local.get $dlg) (i32.const 0x468) (i32.const 0)))
    (local.set $s (call $ctrl_decimal_value (local.get $dlg) (i32.const 0x469) (i32.const 0)))
    (local.set $l (call $ctrl_decimal_value (local.get $dlg) (i32.const 0x46A) (i32.const 0)))
    (if (i32.gt_u (local.get $h) (i32.const 240)) (then (local.set $h (i32.const 240))))
    (if (i32.gt_u (local.get $s) (i32.const 240)) (then (local.set $s (i32.const 240))))
    (if (i32.gt_u (local.get $l) (i32.const 240)) (then (local.set $l (i32.const 240))))
    (local.set $sw (call $g2w (local.get $state)))
    (i32.store (local.get $sw) (local.get $h))
    (i32.store offset=4 (local.get $sw) (local.get $s))
    (i32.store offset=8 (local.get $sw) (local.get $l))
    (local.set $rgb (call $colordlg_hsl_to_rgb
      (local.get $h) (local.get $s) (local.get $l)))
    (i32.store offset=12 (call $g2w (local.get $cc)) (local.get $rgb))
    (call $colordlg_sync_rgb_fields (local.get $dlg) (local.get $rgb))
    (call $colordlg_sync_hsl_fields
      (local.get $dlg) (local.get $h) (local.get $s) (local.get $l))
    (call $colordlg_invalidate_preview (local.get $dlg))
    (call $invalidate_hwnd (local.get $picker)))

  (func $colordlg_expand_custom (param $dlg i32)
    (local $rect i32) (local $cc i32) (local $rgb i32)
    (local $label i32) (local $edit i32)
    (local $slot i32) (local $child i32)
    ;; Presence of the first RGB edit is also the expanded-state flag.
    (if (call $ctrl_find_by_id (local.get $dlg) (i32.const 0x463)) (then (return)))
    (local.set $rect (global.get $PAINT_SCRATCH))
    (call $host_get_window_rect (local.get $dlg) (local.get $rect))
    (call $host_move_window
      (local.get $dlg)
      (i32.load (local.get $rect)) (i32.load offset=4 (local.get $rect))
      (i32.const 436) (i32.const 330) (i32.const 0))
    (call $defwndproc_do_nccalcsize (local.get $dlg))
    ;; Allocate/fill the resized back-canvas now. If its first allocation is
    ;; deferred until a newly-created right-pane child paints, that resize
    ;; clears the left palette children that were already painted this pass.
    (drop (call $host_erase_background (local.get $dlg) (i32.const 16)))

    (local.set $cc (call $wnd_get_userdata (local.get $dlg)))
    (if (local.get $cc)
      (then (local.set $rgb (i32.load offset=12 (call $g2w (local.get $cc))))))

    ;; Win98's full ChooseColor pane starts with an interactive hue/saturation
    ;; square and a luminance strip. The RGB fields sit below this visual
    ;; picker rather than occupying its space.
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 23) (i32.const 0x467)
      (i32.const 226) (i32.const 10) (i32.const 196) (i32.const 140)
      (i32.const 0x50000000) (i32.const 0)))

    ;; Current/nearest-solid preview and its split caption. On a true-color
    ;; display the two halves intentionally match.
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 26) (i32.const 0x46B)
      (i32.const 226) (i32.const 142) (i32.const 58) (i32.const 34)
      (i32.const 0x50000000) (i32.const 0)))
    (local.set $label (call $colordlg_make_label (i32.const 7)))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
      (i32.const 226) (i32.const 178) (i32.const 29) (i32.const 16)
      (i32.const 0x50000000) (local.get $label)))
    (call $heap_free (local.get $label))
    (local.set $label (call $colordlg_make_label (i32.const 8)))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
      (i32.const 255) (i32.const 178) (i32.const 29) (i32.const 16)
      (i32.const 0x50000000) (local.get $label)))
    (call $heap_free (local.get $label))

    ;; Hue, saturation, and luminance share the classic 0..240 scale.
    (local.set $label (call $colordlg_make_label (i32.const 4)))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
      (i32.const 292) (i32.const 148) (i32.const 32) (i32.const 18)
      (i32.const 0x50000000) (local.get $label)))
    (call $heap_free (local.get $label))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 2) (i32.const 0x468)
      (i32.const 324) (i32.const 144) (i32.const 28) (i32.const 22)
      (i32.const 0x50812080) (i32.const 0)))
    (local.set $label (call $colordlg_make_label (i32.const 5)))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
      (i32.const 292) (i32.const 178) (i32.const 32) (i32.const 18)
      (i32.const 0x50000000) (local.get $label)))
    (call $heap_free (local.get $label))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 2) (i32.const 0x469)
      (i32.const 324) (i32.const 174) (i32.const 28) (i32.const 22)
      (i32.const 0x50812080) (i32.const 0)))
    (local.set $label (call $colordlg_make_label (i32.const 6)))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
      (i32.const 292) (i32.const 208) (i32.const 32) (i32.const 18)
      (i32.const 0x50000000) (local.get $label)))
    (call $heap_free (local.get $label))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 2) (i32.const 0x46A)
      (i32.const 324) (i32.const 204) (i32.const 28) (i32.const 22)
      (i32.const 0x50812080) (i32.const 0)))

    (local.set $label (call $colordlg_make_label (i32.const 0)))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
      (i32.const 356) (i32.const 148) (i32.const 34) (i32.const 18)
      (i32.const 0x50000000) (local.get $label)))
    (call $heap_free (local.get $label))
    (local.set $edit (call $ctrl_create_child (local.get $dlg) (i32.const 2) (i32.const 0x463)
      (i32.const 390) (i32.const 144) (i32.const 32) (i32.const 22)
      (i32.const 0x50812080) (i32.const 0)))

    (local.set $label (call $colordlg_make_label (i32.const 1)))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
      (i32.const 356) (i32.const 178) (i32.const 34) (i32.const 18)
      (i32.const 0x50000000) (local.get $label)))
    (call $heap_free (local.get $label))
    (local.set $edit (call $ctrl_create_child (local.get $dlg) (i32.const 2) (i32.const 0x464)
      (i32.const 390) (i32.const 174) (i32.const 32) (i32.const 22)
      (i32.const 0x50812080) (i32.const 0)))

    (local.set $label (call $colordlg_make_label (i32.const 2)))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
      (i32.const 356) (i32.const 208) (i32.const 34) (i32.const 18)
      (i32.const 0x50000000) (local.get $label)))
    (call $heap_free (local.get $label))
    (local.set $edit (call $ctrl_create_child (local.get $dlg) (i32.const 2) (i32.const 0x465)
      (i32.const 390) (i32.const 204) (i32.const 32) (i32.const 22)
      (i32.const 0x50812080) (i32.const 0)))

    (call $colordlg_sync_from_rgb (local.get $dlg) (local.get $rgb))

    (local.set $label (call $colordlg_make_label (i32.const 3)))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 0x466)
      (i32.const 226) (i32.const 250) (i32.const 196) (i32.const 24)
      (i32.const 0x50010000) (local.get $label)))
    (call $heap_free (local.get $label))
    ;; Resizing reallocates and clears the dialog's shared back-canvas. Paint
    ;; every child now so the existing left palette is restored along with the
    ;; new RGB controls; invalidating only the parent leaves a blank gray pane.
    (local.set $slot (i32.const 0))
    (block $paint_done (loop $paint_children
      (local.set $slot (call $wnd_next_child_slot (local.get $dlg) (local.get $slot)))
      (br_if $paint_done (i32.eq (local.get $slot) (i32.const -1)))
      (local.set $child (call $wnd_slot_hwnd (local.get $slot)))
      (if (local.get $child)
        (then (drop (call $wnd_send_message
          (local.get $child) (i32.const 0x000F) (i32.const 0) (i32.const 0)))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $paint_children)))
    (call $invalidate_hwnd (local.get $dlg)))

  (func $colordlg_add_custom (param $dlg i32)
    (local $cc i32) (local $custom i32) (local $rgb i32)
    (local $r i32) (local $g i32) (local $b i32) (local $idx i32)
    (local $grid i32) (local $state i32) (local $basic i32)
    (local.set $cc (call $wnd_get_userdata (local.get $dlg)))
    (if (i32.eqz (local.get $cc)) (then (return)))
    (local.set $custom (i32.load offset=16 (call $g2w (local.get $cc))))
    (if (i32.eqz (local.get $custom)) (then (return)))
    (local.set $r (call $ctrl_decimal_value (local.get $dlg) (i32.const 0x463) (i32.const 0)))
    (local.set $g (call $ctrl_decimal_value (local.get $dlg) (i32.const 0x464) (i32.const 0)))
    (local.set $b (call $ctrl_decimal_value (local.get $dlg) (i32.const 0x465) (i32.const 0)))
    (if (i32.gt_u (local.get $r) (i32.const 255)) (then (local.set $r (i32.const 255))))
    (if (i32.gt_u (local.get $g) (i32.const 255)) (then (local.set $g (i32.const 255))))
    (if (i32.gt_u (local.get $b) (i32.const 255)) (then (local.set $b (i32.const 255))))
    (local.set $rgb
      (i32.or (local.get $r)
        (i32.or (i32.shl (local.get $g) (i32.const 8))
                (i32.shl (local.get $b) (i32.const 16)))))
    (local.set $grid (call $ctrl_find_by_id (local.get $dlg) (i32.const 0x461)))
    (if (local.get $grid)
      (then
        (local.set $state (call $wnd_get_state_ptr (local.get $grid)))
        (if (local.get $state) (then (local.set $idx (i32.load (call $g2w (local.get $state))))))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_s (local.get $idx) (i32.const 16)))
          (then (local.set $idx (i32.const 0))))
        (i32.store (i32.add (call $g2w (local.get $custom))
          (i32.mul (local.get $idx) (i32.const 4))) (local.get $rgb))
        (if (local.get $state) (then (i32.store (call $g2w (local.get $state)) (local.get $idx))))
        (call $invalidate_hwnd (local.get $grid))))
    (local.set $basic (call $ctrl_find_by_id (local.get $dlg) (i32.const 0x460)))
    (if (local.get $basic)
      (then
        (local.set $state (call $wnd_get_state_ptr (local.get $basic)))
        (if (local.get $state) (then (i32.store (call $g2w (local.get $state)) (i32.const -1))))
        (call $invalidate_hwnd (local.get $basic))))
    (i32.store offset=12 (call $g2w (local.get $cc)) (local.get $rgb))
    (call $colordlg_sync_from_rgb (local.get $dlg) (local.get $rgb)))

  (func $colorgrid_color_for_idx (param $idx i32) (result i32)
    ;; Values are COLORREF (0x00BBGGRR), indexed row-major.
    (if (i32.eq (local.get $idx) (i32.const  0)) (then (return (i32.const 0x008080FF))))
    (if (i32.eq (local.get $idx) (i32.const  1)) (then (return (i32.const 0x0080FFFF))))
    (if (i32.eq (local.get $idx) (i32.const  2)) (then (return (i32.const 0x0080FF80))))
    (if (i32.eq (local.get $idx) (i32.const  3)) (then (return (i32.const 0x0080FF00))))
    (if (i32.eq (local.get $idx) (i32.const  4)) (then (return (i32.const 0x00FFFF80))))
    (if (i32.eq (local.get $idx) (i32.const  5)) (then (return (i32.const 0x00FF8000))))
    (if (i32.eq (local.get $idx) (i32.const  6)) (then (return (i32.const 0x00C080FF))))
    (if (i32.eq (local.get $idx) (i32.const  7)) (then (return (i32.const 0x00FF80FF))))
    (if (i32.eq (local.get $idx) (i32.const  8)) (then (return (i32.const 0x000000FF))))
    (if (i32.eq (local.get $idx) (i32.const  9)) (then (return (i32.const 0x0000FFFF))))
    (if (i32.eq (local.get $idx) (i32.const 10)) (then (return (i32.const 0x0000FF80))))
    (if (i32.eq (local.get $idx) (i32.const 11)) (then (return (i32.const 0x0040FF00))))
    (if (i32.eq (local.get $idx) (i32.const 12)) (then (return (i32.const 0x00FFFF00))))
    (if (i32.eq (local.get $idx) (i32.const 13)) (then (return (i32.const 0x00C08000))))
    (if (i32.eq (local.get $idx) (i32.const 14)) (then (return (i32.const 0x00C08080))))
    (if (i32.eq (local.get $idx) (i32.const 15)) (then (return (i32.const 0x00FF00FF))))
    (if (i32.eq (local.get $idx) (i32.const 16)) (then (return (i32.const 0x00404080))))
    (if (i32.eq (local.get $idx) (i32.const 17)) (then (return (i32.const 0x004080FF))))
    (if (i32.eq (local.get $idx) (i32.const 18)) (then (return (i32.const 0x0000FF00))))
    (if (i32.eq (local.get $idx) (i32.const 19)) (then (return (i32.const 0x00808000))))
    (if (i32.eq (local.get $idx) (i32.const 20)) (then (return (i32.const 0x00804000))))
    (if (i32.eq (local.get $idx) (i32.const 21)) (then (return (i32.const 0x00FF8080))))
    (if (i32.eq (local.get $idx) (i32.const 22)) (then (return (i32.const 0x00400080))))
    (if (i32.eq (local.get $idx) (i32.const 23)) (then (return (i32.const 0x008000FF))))
    (if (i32.eq (local.get $idx) (i32.const 24)) (then (return (i32.const 0x00000080))))
    (if (i32.eq (local.get $idx) (i32.const 25)) (then (return (i32.const 0x000080FF))))
    (if (i32.eq (local.get $idx) (i32.const 26)) (then (return (i32.const 0x00008000))))
    (if (i32.eq (local.get $idx) (i32.const 27)) (then (return (i32.const 0x00408000))))
    (if (i32.eq (local.get $idx) (i32.const 28)) (then (return (i32.const 0x00FF0000))))
    (if (i32.eq (local.get $idx) (i32.const 29)) (then (return (i32.const 0x00A00000))))
    (if (i32.eq (local.get $idx) (i32.const 30)) (then (return (i32.const 0x00800080))))
    (if (i32.eq (local.get $idx) (i32.const 31)) (then (return (i32.const 0x00FF0080))))
    (if (i32.eq (local.get $idx) (i32.const 32)) (then (return (i32.const 0x00000040))))
    (if (i32.eq (local.get $idx) (i32.const 33)) (then (return (i32.const 0x00004080))))
    (if (i32.eq (local.get $idx) (i32.const 34)) (then (return (i32.const 0x00004000))))
    (if (i32.eq (local.get $idx) (i32.const 35)) (then (return (i32.const 0x00404000))))
    (if (i32.eq (local.get $idx) (i32.const 36)) (then (return (i32.const 0x00800000))))
    (if (i32.eq (local.get $idx) (i32.const 37)) (then (return (i32.const 0x00400000))))
    (if (i32.eq (local.get $idx) (i32.const 38)) (then (return (i32.const 0x00400040))))
    (if (i32.eq (local.get $idx) (i32.const 39)) (then (return (i32.const 0x00800040))))
    (if (i32.eq (local.get $idx) (i32.const 40)) (then (return (i32.const 0x00000000))))
    (if (i32.eq (local.get $idx) (i32.const 41)) (then (return (i32.const 0x00008080))))
    (if (i32.eq (local.get $idx) (i32.const 42)) (then (return (i32.const 0x00408080))))
    (if (i32.eq (local.get $idx) (i32.const 43)) (then (return (i32.const 0x00808080))))
    (if (i32.eq (local.get $idx) (i32.const 44)) (then (return (i32.const 0x00808040))))
    (if (i32.eq (local.get $idx) (i32.const 45)) (then (return (i32.const 0x00C0C0C0))))
    (if (i32.eq (local.get $idx) (i32.const 46)) (then (return (i32.const 0x00400040))))
    (if (i32.eq (local.get $idx) (i32.const 47)) (then (return (i32.const 0x00FFFFFF))))
    (i32.const 0x00FFFFFF))

  (func $colorgrid_color_for_hwnd (param $hwnd i32) (param $idx i32) (result i32)
    (local $state i32) (local $ctrl_id i32) (local $parent i32)
    (local $cc i32) (local $custom i32)
    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $state)) (then (return (i32.const 0x00FFFFFF))))
    (local.set $ctrl_id (i32.load offset=4 (call $g2w (local.get $state))))
    (if (i32.ne (local.get $ctrl_id) (i32.const 0x461))
      (then (return (call $colorgrid_color_for_idx (local.get $idx)))))
    (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
    (local.set $cc (call $wnd_get_userdata (local.get $parent)))
    (if (i32.eqz (local.get $cc)) (then (return (i32.const 0x00FFFFFF))))
    (local.set $custom (i32.load offset=16 (call $g2w (local.get $cc))))
    (if (i32.eqz (local.get $custom)) (then (return (i32.const 0x00FFFFFF))))
    (i32.load (i32.add (call $g2w (local.get $custom))
              (i32.mul (local.get $idx) (i32.const 4)))))

  (func $colorgrid_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $state i32) (local $sw i32) (local $cs_w i32)
    (local $x i32) (local $y i32) (local $col i32) (local $row i32)
    (local $idx i32) (local $parent i32) (local $ctrl_id i32)
    (local $hdc i32) (local $sel i32) (local $brush i32)
    (local $cx i32) (local $cy i32) (local $row_count i32)
    (local $other i32) (local $other_state i32) (local $cc i32) (local $rgb i32)

    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))

    (if (i32.eq (local.get $msg) (i32.const 0x0001))
      (then
        (local.set $cs_w (call $g2w (local.get $lParam)))
        (local.set $state (call $heap_alloc (i32.const 8)))
        (local.set $sw (call $g2w (local.get $state)))
        (i32.store        (local.get $sw) (i32.const -1))                              ;; sel_idx
        (i32.store offset=4 (local.get $sw) (i32.load offset=8 (local.get $cs_w)))    ;; ctrl_id from hMenu
        (call $wnd_set_state_ptr (local.get $hwnd) (local.get $state))
        (return (i32.const 0))))

    (if (i32.eq (local.get $msg) (i32.const 0x0002))
      (then
        (if (local.get $state)
          (then (call $heap_free (local.get $state))
                (call $wnd_set_state_ptr (local.get $hwnd) (i32.const 0))))
        (return (i32.const 0))))

    (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
    (local.set $sw (call $g2w (local.get $state)))

    ;; ---------- WM_PAINT (0x000F) ----------
    ;; Basic grid = 8x6; custom grid = 8x2. Each 26x22 cell contains a
    ;; 22x18 bordered swatch and a four-pixel gutter, matching the spacing in
    ;; the classic common-dialog template.
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        (local.set $sel (i32.load (local.get $sw)))
        (local.set $ctrl_id (i32.load offset=4 (local.get $sw)))
        (local.set $row_count
          (select (i32.const 2) (i32.const 6)
            (i32.eq (local.get $ctrl_id) (i32.const 0x461))))
        (drop (call $host_gdi_fill_rect (local.get $hdc)
                (i32.const 0) (i32.const 0) (i32.const 208)
                (i32.mul (local.get $row_count) (i32.const 22))
                (i32.const 0x30011)))  ;; LTGRAY_BRUSH / COLOR_BTNFACE
        (local.set $row (i32.const 0))
        (block $rows_done (loop $rows
          (br_if $rows_done (i32.ge_u (local.get $row) (local.get $row_count)))
          (local.set $col (i32.const 0))
          (block $cols_done (loop $cols
            (br_if $cols_done (i32.ge_u (local.get $col) (i32.const 8)))
            (local.set $idx (i32.add (i32.mul (local.get $row) (i32.const 8)) (local.get $col)))
            (local.set $cx (i32.mul (local.get $col) (i32.const 26)))
            (local.set $cy (i32.mul (local.get $row) (i32.const 22)))
            ;; 1-px black border = full cell painted black, then color fill 1px in
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (local.get $cx) (local.get $cy)
                    (i32.add (local.get $cx) (i32.const 22))
                    (i32.add (local.get $cy) (i32.const 18))
                    (i32.const 0x30014)))  ;; BLACK_BRUSH
            (local.set $brush (call $host_gdi_create_solid_brush
                                (call $colorgrid_color_for_hwnd
                                  (local.get $hwnd) (local.get $idx))))
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.add (local.get $cx) (i32.const 1))
                    (i32.add (local.get $cy) (i32.const 1))
                    (i32.add (local.get $cx) (i32.const 21))
                    (i32.add (local.get $cy) (i32.const 17))
                    (local.get $brush)))
            (drop (call $host_gdi_delete_object (local.get $brush)))
            ;; Selection: white ring 2 px in from the border
            (if (i32.eq (local.get $idx) (local.get $sel))
              (then
                (drop (call $host_gdi_draw_edge (local.get $hdc)
                        (i32.add (local.get $cx) (i32.const 2))
                        (i32.add (local.get $cy) (i32.const 2))
                        (i32.add (local.get $cx) (i32.const 20))
                        (i32.add (local.get $cy) (i32.const 16))
                        (i32.const 0x05) (i32.const 0x0F)))))  ;; raised
            (local.set $col (i32.add (local.get $col) (i32.const 1)))
            (br $cols)))
          (local.set $row (i32.add (local.get $row) (i32.const 1)))
          (br $rows)))
        (return (i32.const 0))))

    (if (i32.eq (local.get $msg) (i32.const 0x0201))   ;; WM_LBUTTONDOWN
      (then
        (local.set $x (i32.and (local.get $lParam) (i32.const 0xFFFF)))
        (local.set $y (i32.shr_u (local.get $lParam) (i32.const 16)))
        (local.set $ctrl_id (i32.load offset=4 (local.get $sw)))
        (local.set $row_count
          (select (i32.const 2) (i32.const 6)
            (i32.eq (local.get $ctrl_id) (i32.const 0x461))))
        (local.set $col (i32.div_s (local.get $x) (i32.const 26)))
        (local.set $row (i32.div_s (local.get $y) (i32.const 22)))
        (if (i32.or (i32.or (i32.lt_s (local.get $col) (i32.const 0))
                            (i32.ge_s (local.get $col) (i32.const 8)))
                    (i32.or (i32.lt_s (local.get $row) (i32.const 0))
                            (i32.ge_s (local.get $row) (local.get $row_count))))
          (then (return (i32.const 0))))
        ;; Ignore the four-pixel gutter after each visible swatch.
        (if (i32.or
              (i32.ge_u (i32.rem_u (local.get $x) (i32.const 26)) (i32.const 22))
              (i32.ge_u (i32.rem_u (local.get $y) (i32.const 22)) (i32.const 18)))
          (then (return (i32.const 0))))
        (local.set $idx (i32.add (i32.mul (local.get $row) (i32.const 8)) (local.get $col)))
        (i32.store (local.get $sw) (local.get $idx))
        (call $invalidate_hwnd (local.get $hwnd))
        (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
        (if (local.get $parent)
          (then
            ;; Only one of the two palettes owns the focus ring.
            (local.set $other (call $ctrl_find_by_id (local.get $parent)
              (select (i32.const 0x460) (i32.const 0x461)
                (i32.eq (local.get $ctrl_id) (i32.const 0x461)))))
            (if (local.get $other)
              (then
                (local.set $other_state (call $wnd_get_state_ptr (local.get $other)))
                (if (local.get $other_state)
                  (then (i32.store (call $g2w (local.get $other_state)) (i32.const -1))))
                (call $invalidate_hwnd (local.get $other))))
            ;; Keep rgbResult current for both basic and custom selections.
            (local.set $cc (call $wnd_get_userdata (local.get $parent)))
            (if (local.get $cc)
              (then
                (local.set $rgb (call $colorgrid_color_for_hwnd
                  (local.get $hwnd) (local.get $idx)))
                (i32.store offset=12 (call $g2w (local.get $cc)) (local.get $rgb))
                (call $colordlg_sync_from_rgb (local.get $parent) (local.get $rgb))))
            (drop (call $wnd_send_message (local.get $parent) (i32.const 0x0111)
                    (i32.or (local.get $ctrl_id) (i32.const 0x10000))   ;; HIWORD=1 (LBN_SELCHANGE reused)
                    (local.get $hwnd)))))
        (return (i32.const 0))))

    (i32.const 0))

  (func $colordlg_wndproc
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $cmd i32) (local $notif i32)

    ;; CC_ENABLEHOOK lets applications customize the common dialog. Paint's
    ;; hook changes the stock "Color" caption to "Edit Colors" and expects to
    ;; observe the normal dialog message stream. A nonzero hook result consumes
    ;; the message before the common-dialog default behavior.
    (if (call $colordlg_call_hook
          (local.get $hwnd) (local.get $msg)
          (local.get $wParam) (local.get $lParam))
      (then (return (i32.const 1))))

    (if (i32.eq (local.get $msg) (i32.const 0x0085))   ;; WM_NCPAINT
      (then (call $defwndproc_do_ncpaint (local.get $hwnd)) (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0014))   ;; WM_ERASEBKGND
      (then (return (call $host_erase_background (local.get $hwnd) (i32.const 16)))))
    (if (i32.eq (local.get $msg) (i32.const 0x0010))   ;; WM_CLOSE
      (then (call $modal_done (i32.const 0)) (return (i32.const 0))))
    (if (i32.ne (local.get $msg) (i32.const 0x0111)) (then (return (i32.const 0))))
    (local.set $cmd (i32.and (local.get $wParam) (i32.const 0xFFFF)))
    (local.set $notif (i32.and (i32.shr_u (local.get $wParam) (i32.const 16)) (i32.const 0xFFFF)))

    (if (i32.eq (local.get $notif) (i32.const 0x0300)) ;; EN_CHANGE
      (then
        (if (global.get $colordlg_syncing) (then (return (i32.const 0))))
        (if (i32.and (i32.ge_u (local.get $cmd) (i32.const 0x463))
                     (i32.le_u (local.get $cmd) (i32.const 0x465)))
          (then (call $colordlg_commit_rgb_edits (local.get $hwnd)) (return (i32.const 0))))
        (if (i32.and (i32.ge_u (local.get $cmd) (i32.const 0x468))
                     (i32.le_u (local.get $cmd) (i32.const 0x46A)))
          (then (call $colordlg_commit_hsl_edits (local.get $hwnd)) (return (i32.const 0))))))

    (if (i32.eq (local.get $cmd) (i32.const 2))
      (then (call $modal_done (i32.const 0)) (return (i32.const 0))))

    (if (i32.eq (local.get $cmd) (i32.const 1))
      (then
        ;; A palette click already wrote the chosen basic/custom color into
        ;; CHOOSECOLOR.rgbResult; IDOK only commits the modal result.
        (call $modal_done (i32.const 1))
        (return (i32.const 0))))
    (if (i32.eq (local.get $cmd) (i32.const 0x462))
      (then
        (call $colordlg_expand_custom (local.get $hwnd))
        (return (i32.const 0))))
    (if (i32.eq (local.get $cmd) (i32.const 0x466))
      (then
        (call $colordlg_add_custom (local.get $hwnd))
        (return (i32.const 0))))
    (i32.const 0))

  (func $colordlg_call_hook
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $cc i32) (local $cc_w i32) (local $flags i32) (local $proc i32)
    (local $installed i32) (local $result i32)
    (local.set $cc (call $wnd_get_userdata (local.get $hwnd)))
    (if (i32.eqz (local.get $cc)) (then (return (i32.const 0))))
    (local.set $cc_w (call $g2w (local.get $cc)))
    (local.set $flags (i32.load offset=20 (local.get $cc_w)))
    (if (i32.eqz (i32.and (local.get $flags) (i32.const 0x10)))
      (then (return (i32.const 0))))
    (local.set $proc (i32.load offset=28 (local.get $cc_w)))
    (if (i32.eqz (local.get $proc)) (then (return (i32.const 0))))
    ;; Hooks commonly chain unhandled messages to DefWindowProc. That call
    ;; re-enters this WAT common-dialog proc, so suppress the hook while its
    ;; callback is active or the same message recursively invokes the hook
    ;; until the host WebAssembly stack overflows. Preserve every caller flag
    ;; and restore them before inspecting whether the callback destroyed the
    ;; dialog.
    (i32.store offset=20 (local.get $cc_w)
      (i32.and (local.get $flags) (i32.const -17))) ;; ~CC_ENABLEHOOK
    ;; Reuse the bounded synchronous x86 wndproc bridge. The dialog remains a
    ;; WAT-native common dialog before and after the callback.
    (local.set $installed (call $wnd_table_get (local.get $hwnd)))
    (call $wnd_table_set (local.get $hwnd) (local.get $proc))
    (local.set $result (call $wnd_send_message
      (local.get $hwnd) (local.get $msg)
      (local.get $wParam) (local.get $lParam)))
    (i32.store offset=20 (local.get $cc_w) (local.get $flags))
    (if (i32.lt_s (call $wnd_table_find (local.get $hwnd)) (i32.const 0))
      (then (return (i32.const 1))))
    (call $wnd_table_set (local.get $hwnd) (local.get $installed))
    (local.get $result))

  (func $create_color_dialog (param $dlg i32) (param $owner i32) (param $cc i32)
    (local $grid i32) (local $custom_grid i32) (local $rgb i32)
    (local $i i32) (local $sw i32) (local $flags i32)
    (local $custom i32) (local $found i32)
    (call $host_register_dialog_frame
      (local.get $dlg) (local.get $owner)
      (i32.const 0x252)   ;; "Color"
      (i32.const 236) (i32.const 330)
      (i32.const 1))
    (call $wnd_table_set (local.get $dlg) (global.get $WNDPROC_CTRL_NATIVE))
    (call $title_table_set (local.get $dlg) (i32.const 0x252) (i32.const 5))
    (call $wnd_set_owner (local.get $dlg) (local.get $owner))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x90C80000)))
    (call $defwndproc_do_nccalcsize (local.get $dlg))
    (call $ctrl_table_set (call $wnd_table_find (local.get $dlg))
      (i32.const 15) (i32.const 0))
    (call $nc_flags_set (local.get $dlg) (i32.const 3))
    (call $dlg_fill_bkgnd (local.get $dlg))
    (drop (call $wnd_set_userdata (local.get $dlg) (local.get $cc)))

    ;; The left/partial half of the stock Win98 color.dlg template.
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
            (i32.const 8) (i32.const 6) (i32.const 208) (i32.const 16)
            (i32.const 0x50000000)
            (call $wat_str_to_heap (i32.const 0x11235) (i32.const 13))))
    ;; Basic swatches: 8 columns * 26px, 6 rows * 22px.
    (local.set $grid (call $ctrl_create_child (local.get $dlg) (i32.const 6) (i32.const 0x460)
            (i32.const 8) (i32.const 24) (i32.const 208) (i32.const 132)
            (i32.const 0x50000000) (i32.const 0)))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
            (i32.const 8) (i32.const 164) (i32.const 208) (i32.const 16)
            (i32.const 0x50000000)
            (call $wat_str_to_heap (i32.const 0x11243) (i32.const 14))))
    ;; Custom swatches reflect the caller's persistent lpCustColors[16].
    (local.set $custom_grid (call $ctrl_create_child
            (local.get $dlg) (i32.const 6) (i32.const 0x461)
            (i32.const 8) (i32.const 182) (i32.const 208) (i32.const 44)
            (i32.const 0x50000000) (i32.const 0)))

    ;; CC_RGBINIT controls whether rgbResult is used initially; without it,
    ;; the documented default is black. Highlight either the matching basic
    ;; swatch or the matching caller-provided custom swatch.
    (if (local.get $cc)
      (then
        (local.set $flags (i32.load offset=20 (call $g2w (local.get $cc))))
        (if (i32.and (local.get $flags) (i32.const 1))
          (then (local.set $rgb (i32.load offset=12 (call $g2w (local.get $cc)))))
          (else
            (local.set $rgb (i32.const 0))
            (i32.store offset=12 (call $g2w (local.get $cc)) (i32.const 0))))
        (local.set $i (i32.const 0))
        (block $basic_done (loop $scan_basic
          (br_if $basic_done (i32.ge_u (local.get $i) (i32.const 48)))
          (if (i32.eq (call $colorgrid_color_for_idx (local.get $i)) (local.get $rgb))
            (then
              (local.set $sw (call $wnd_get_state_ptr (local.get $grid)))
              (if (local.get $sw)
                (then (i32.store (call $g2w (local.get $sw)) (local.get $i))))
              (local.set $found (i32.const 1))
              (br $basic_done)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $scan_basic)))
        (if (i32.eqz (local.get $found))
          (then
            (local.set $custom (i32.load offset=16 (call $g2w (local.get $cc))))
            (if (local.get $custom)
              (then
                (local.set $i (i32.const 0))
                (block $custom_done (loop $scan_custom
                  (br_if $custom_done (i32.ge_u (local.get $i) (i32.const 16)))
                  (if (i32.eq
                        (i32.load (i32.add (call $g2w (local.get $custom))
                          (i32.mul (local.get $i) (i32.const 4))))
                        (local.get $rgb))
                    (then
                      (local.set $sw (call $wnd_get_state_ptr (local.get $custom_grid)))
                      (if (local.get $sw)
                        (then (i32.store (call $g2w (local.get $sw)) (local.get $i))))
                      (br $custom_done)))
                  (local.set $i (i32.add (local.get $i) (i32.const 1)))
                  (br $scan_custom)))))))))
    ;; The stock partial dialog exposes custom-color expansion below the
    ;; persistent swatches. Keep OK/Cancel below it so controls never overlap.
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 0x462)
            (i32.const 8) (i32.const 234) (i32.const 208) (i32.const 24)
            (i32.const 0x50010000)
            (call $wat_str_to_heap (i32.const 0x11252) (i32.const 23))))
    ;; OK + Cancel
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 1)
            (i32.const 8) (i32.const 266) (i32.const 68) (i32.const 24)
            (i32.const 0x50010001)
            (call $wat_str_to_heap (i32.const 0x1D9) (i32.const 2))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 2)
            (i32.const 82) (i32.const 266) (i32.const 68) (i32.const 24)
            (i32.const 0x50010000)
            (call $wat_str_to_heap (i32.const 0x1D2) (i32.const 6))))
    ;; CCHookProc receives WM_INITDIALOG with lParam pointing at CHOOSECOLOR.
    ;; Paint uses this to install the expected "Edit Colors" caption.
    (drop (call $colordlg_call_hook
      (local.get $dlg) (i32.const 0x0110) (i32.const 0) (local.get $cc))))

  ;; ============================================================
  ;; Open / Save common dialog (control class 12)
  ;; ============================================================
  ;;
  ;; Built by $create_open_dialog (called from $handle_GetOpenFileNameA
  ;; and $handle_GetSaveFileNameA — same UI, different title + button
  ;; label + IDOK semantics). Children:
  ;;
  ;;   id 0xFFFF "Look in:" static
  ;;   id 0x440  current-directory edit (read-only, displays current path)
  ;;   id 0x441  file listbox (LB_ADDSTRING-populated from fs_find_*)
  ;;   id 0xFFFF "File name:" static
  ;;   id 0x442  filename edit
  ;;   id 0xFFFF "Files of type:" static (when OFN.lpstrFilter exists)
  ;;   id 0x445  filter combobox (when OFN.lpstrFilter exists)
  ;;   id 1      Open / Save button (IDOK)
  ;;   id 2      Cancel button (IDCANCEL)
  ;;
  ;; Userdata stores the guest OFN ptr so the OK handler can write back
  ;; the chosen filename to OFN.lpstrFile.
  ;;
  ;; OPENFILENAME (offsets we touch):
  ;;   +0x00  lStructSize
  ;;   +0x04  hwndOwner
  ;;   +0x0C  lpstrFilter
  ;;   +0x18  nFilterIndex     — 1-based selected filter
  ;;   +0x1C  lpstrFile        — guest ptr to writable buffer
  ;;   +0x20  nMaxFile         — capacity
  ;;   +0x24  lpstrFileTitle
  ;;   +0x28  nMaxFileTitle
  ;;   +0x2C  lpstrInitialDir
  ;;   +0x30  lpstrTitle

  ;; ---- Listbox population helper ----
  ;;
  ;; Walks fs_find_first_file/next from a given pattern (e.g. "C:\*"),
  ;; LB_ADDSTRINGs each entry, prepending "[" and appending "]" for
  ;; directories so they sort first visually. Adds ".." as the first
  ;; entry unconditionally so the user can navigate up.
  ;;
  ;; Reuses PAINT_SCRATCH (above GUEST_BASE) for the WIN32_FIND_DATA
  ;; (320 bytes) plus a temporary 280-byte string slot for the bracketed
  ;; directory entry.
  (func $opendlg_populate_listbox (param $lb i32) (param $pattern_g i32)
    (local $find_handle i32) (local $fd_g i32) (local $fd_w i32)
    (local $name_g i32) (local $name_w i32) (local $attrs i32)
    (local $tmp_g i32) (local $tmp_w i32) (local $name_len i32)
    ;; Reset listbox first.
    (drop (call $wnd_send_message (local.get $lb) (i32.const 0x0184) (i32.const 0) (i32.const 0)))
    ;; Add ".." entry as the first row so the user can navigate up.
    ;; Skipped at the C:\ root (where ".." has no meaningful target) so
    ;; the listbox doesn't show a no-op entry.
    (if (i32.gt_u (call $strlen (call $g2w (global.get $opendlg_current_dir))) (i32.const 3))
      (then
        (drop (call $wnd_send_message (local.get $lb) (i32.const 0x0180) (i32.const 0)
                (call $wat_str_to_heap (i32.const 0x11066) (i32.const 2))))))
    ;; FIND_DATA buffer + tmp string buffer in heap.
    (local.set $fd_g (call $heap_alloc (i32.const 320)))
    (local.set $fd_w (call $g2w (local.get $fd_g)))
    (local.set $tmp_g (call $heap_alloc (i32.const 280)))
    (local.set $tmp_w (call $g2w (local.get $tmp_g)))
    (local.set $find_handle (call $host_fs_find_first_file
      (call $g2w (local.get $pattern_g)) (local.get $fd_g) (i32.const 0)))
    (if (i32.eq (local.get $find_handle) (i32.const -1))
      (then
        (call $heap_free (local.get $tmp_g))
        (call $heap_free (local.get $fd_g))
        (return)))
    (block $done (loop $next
      ;; Skip "." and ".."
      (local.set $name_w (i32.add (local.get $fd_w) (i32.const 44)))
      (local.set $attrs (i32.load (local.get $fd_w)))
      (if (i32.eqz (i32.and
              (i32.eq (i32.load8_u (local.get $name_w)) (i32.const 46))   ;; '.'
              (i32.or (i32.eqz (i32.load8_u (i32.add (local.get $name_w) (i32.const 1))))
                      (i32.and (i32.eq (i32.load8_u (i32.add (local.get $name_w) (i32.const 1))) (i32.const 46))
                               (i32.eqz (i32.load8_u (i32.add (local.get $name_w) (i32.const 2))))))))
        (then
          (if (i32.and (local.get $attrs) (i32.const 0x10))
            (then
              ;; Directory: render as "[name]" so it sorts/looks distinct.
              (local.set $name_len (call $strlen (local.get $name_w)))
              (i32.store8 (local.get $tmp_w) (i32.const 0x5B))  ;; '['
              (call $memcpy (i32.add (local.get $tmp_w) (i32.const 1))
                            (local.get $name_w) (local.get $name_len))
              (i32.store8 (i32.add (local.get $tmp_w) (i32.add (local.get $name_len) (i32.const 1)))
                          (i32.const 0x5D))  ;; ']'
              (i32.store8 (i32.add (local.get $tmp_w) (i32.add (local.get $name_len) (i32.const 2)))
                          (i32.const 0))
              (drop (call $wnd_send_message (local.get $lb) (i32.const 0x0180) (i32.const 0)
                      (local.get $tmp_g))))
            (else
              ;; File: add as-is via the FIND_DATA's cFileName guest ptr.
              (drop (call $wnd_send_message (local.get $lb) (i32.const 0x0180) (i32.const 0)
                      (i32.add (local.get $fd_g) (i32.const 44))))))))
      (br_if $done (i32.eqz (call $host_fs_find_next_file
                              (local.get $find_handle) (local.get $fd_g) (i32.const 0))))
      (br $next)))
    (drop (call $host_fs_find_close (local.get $find_handle)))
    (call $heap_free (local.get $tmp_g))
    (call $heap_free (local.get $fd_g)))

  ;; Populate the common-dialog filter combobox from OPENFILENAME.lpstrFilter.
  ;; The filter buffer is a double-NUL-terminated sequence of display/pattern
  ;; pairs: "Rich Text Format\0*.rtf\0Text Document\0*.txt\0\0". The combobox
  ;; shows only display strings and mirrors OPENFILENAME.nFilterIndex, which is
  ;; 1-based in Win32.
  (func $opendlg_populate_filter_combo (param $cb i32) (param $ofn i32)
    (local $ofn_w i32) (local $filter_g i32) (local $p_g i32) (local $p_w i32)
    (local $slen i32) (local $count i32) (local $sel i32) (local $label_g i32)
    (if (i32.or (i32.eqz (local.get $cb)) (i32.eqz (local.get $ofn)))
      (then (return)))
    (local.set $ofn_w (call $g2w (local.get $ofn)))
    (local.set $filter_g (i32.load offset=12 (local.get $ofn_w)))
    (if (i32.eqz (local.get $filter_g)) (then (return)))
    (local.set $p_g (local.get $filter_g))
    (local.set $p_w (call $g2w (local.get $p_g)))
    (local.set $count (i32.const 0))
    (block $done (loop $scan
      ;; Empty display string marks the double-NUL terminator.
      (br_if $done
        (if (result i32) (global.get $opendlg_wide)
          (then (i32.eqz (i32.load16_u (local.get $p_w))))
          (else (i32.eqz (i32.load8_u (local.get $p_w))))))
      (if (global.get $opendlg_wide)
        (then
          (local.set $slen (call $guest_wcslen (local.get $p_g)))
          (local.set $label_g (call $heap_alloc (i32.add (local.get $slen) (i32.const 1))))
          (drop (call $wide_to_ansi (local.get $p_g) (local.get $label_g)
                  (i32.add (local.get $slen) (i32.const 1))))
          (drop (call $wnd_send_message (local.get $cb) (i32.const 0x0143)
                  (i32.const 0) (local.get $label_g)))
          (call $heap_free (local.get $label_g)))
        (else
          (drop (call $wnd_send_message (local.get $cb) (i32.const 0x0143)
                  (i32.const 0) (local.get $p_g)))))
      (local.set $count (i32.add (local.get $count) (i32.const 1)))
      ;; Skip display string.
      (local.set $slen
        (if (result i32) (global.get $opendlg_wide)
          (then (call $guest_wcslen (local.get $p_g)))
          (else (call $strlen (local.get $p_w)))))
      (local.set $p_g (i32.add (local.get $p_g)
        (if (result i32) (global.get $opendlg_wide)
          (then (i32.shl (i32.add (local.get $slen) (i32.const 1)) (i32.const 1)))
          (else (i32.add (local.get $slen) (i32.const 1))))))
      (local.set $p_w (call $g2w (local.get $p_g)))
      ;; Skip pattern string. Malformed filter lists with a missing pattern end
      ;; at the same double-NUL sentinel on the next loop.
      (local.set $slen
        (if (result i32) (global.get $opendlg_wide)
          (then (call $guest_wcslen (local.get $p_g)))
          (else (call $strlen (local.get $p_w)))))
      (local.set $p_g (i32.add (local.get $p_g)
        (if (result i32) (global.get $opendlg_wide)
          (then (i32.shl (i32.add (local.get $slen) (i32.const 1)) (i32.const 1)))
          (else (i32.add (local.get $slen) (i32.const 1))))))
      (local.set $p_w (call $g2w (local.get $p_g)))
      (br $scan)))
    (if (i32.eqz (local.get $count)) (then (return)))
    (local.set $sel (i32.load offset=24 (local.get $ofn_w))) ;; nFilterIndex, 1-based
    (if (i32.or (i32.eqz (local.get $sel)) (i32.gt_u (local.get $sel) (local.get $count)))
      (then (local.set $sel (i32.const 1))))
    (drop (call $wnd_send_message (local.get $cb) (i32.const 0x014E) ;; CB_SETCURSEL
            (i32.sub (local.get $sel) (i32.const 1)) (i32.const 0))))

  ;; ---- Open dialog wndproc ----
  (func $opendlg_wndproc
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $cmd i32) (local $notif i32) (local $ofn i32) (local $ofn_w i32)
    (local $edit_h i32) (local $edit_state i32) (local $edit_sw i32)
    (local $text_len i32) (local $text_src_w i32)
    (local $dst_g i32) (local $dst_w i32) (local $max_len i32)
    (local $filter_cb i32) (local $filter_sel i32)

    (if (i32.eq (local.get $msg) (i32.const 0x0085))   ;; WM_NCPAINT
      (then (call $defwndproc_do_ncpaint (local.get $hwnd)) (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0014))   ;; WM_ERASEBKGND
      (then (return (call $host_erase_background (local.get $hwnd) (i32.const 16)))))

    ;; ---- WM_CLOSE → Cancel ----
    (if (i32.eq (local.get $msg) (i32.const 0x0010))
      (then
        (call $modal_done (i32.const 0))
        (return (i32.const 0))))

    (if (i32.ne (local.get $msg) (i32.const 0x0111))  ;; only WM_COMMAND past here
      (then (return (i32.const 0))))

    (local.set $cmd   (i32.and (local.get $wParam) (i32.const 0xFFFF)))
    (local.set $notif (i32.shr_u (local.get $wParam) (i32.const 16)))

    ;; ---- Cancel ----
    (if (i32.eq (local.get $cmd) (i32.const 2))
      (then
        (call $modal_done (i32.const 0))
        (return (i32.const 0))))

    ;; ---- OK / Open / Save: copy filename edit text into OFN.lpstrFile ----
    (if (i32.eq (local.get $cmd) (i32.const 1))
      (then
        (local.set $ofn (call $wnd_get_userdata (local.get $hwnd)))
        (if (i32.eqz (local.get $ofn))
          (then (call $modal_done (i32.const 0)) (return (i32.const 0))))
        (local.set $ofn_w (call $g2w (local.get $ofn)))
        (local.set $dst_g (i32.load offset=28 (local.get $ofn_w)))         ;; lpstrFile
        (local.set $max_len (i32.load offset=32 (local.get $ofn_w)))       ;; nMaxFile
        (local.set $edit_h (call $ctrl_find_by_id (local.get $hwnd) (i32.const 0x442)))
        ;; i32.and is bitwise: must coerce $dst_g and $edit_h pointers to 0/1
        ;; (their bit 0 is normally clear and would zero the AND silently).
        (if (i32.and
              (i32.and (i32.ne (local.get $dst_g) (i32.const 0))
                       (i32.gt_u (local.get $max_len) (i32.const 0)))
              (i32.ne (local.get $edit_h) (i32.const 0)))
          (then
            (local.set $edit_state (call $wnd_get_state_ptr (local.get $edit_h)))
            (if (local.get $edit_state)
              (then
                (local.set $edit_sw (call $g2w (local.get $edit_state)))
                (local.set $text_len (i32.load offset=4 (local.get $edit_sw)))
                (local.set $dst_w (call $g2w (local.get $dst_g)))
                (if (i32.ge_u (local.get $text_len) (local.get $max_len))
                  (then (local.set $text_len (i32.sub (local.get $max_len) (i32.const 1)))))
                (if (i32.load (local.get $edit_sw))
                  (then
                    (local.set $text_src_w (call $g2w (i32.load (local.get $edit_sw))))
                    (if (local.get $text_len)
                      (then
                        (if (global.get $opendlg_wide)
                          (then
                            (drop (call $ansi_to_wide
                              (i32.load (local.get $edit_sw)) (local.get $dst_g)
                              (local.get $max_len))))
                          (else
                            (call $memcpy (local.get $dst_w)
                              (local.get $text_src_w) (local.get $text_len))))))))
                (if (global.get $opendlg_wide)
                  (then (i32.store16 (i32.add (local.get $dst_w)
                          (i32.shl (local.get $text_len) (i32.const 1))) (i32.const 0)))
                  (else (i32.store8 (i32.add (local.get $dst_w) (local.get $text_len)) (i32.const 0))))))))
        (local.set $filter_cb (call $ctrl_find_by_id (local.get $hwnd) (i32.const 0x445)))
        (if (local.get $filter_cb)
          (then
            (local.set $filter_sel (call $wnd_send_message
              (local.get $filter_cb) (i32.const 0x0147) ;; CB_GETCURSEL
              (i32.const 0) (i32.const 0)))
            (if (i32.ge_s (local.get $filter_sel) (i32.const 0))
              (then
                (i32.store offset=24 (local.get $ofn_w)
                  (i32.add (local.get $filter_sel) (i32.const 1)))))))
        (call $modal_done (i32.const 1))
        (return (i32.const 0))))

    ;; ---- Upload (id 0x443) ----
    ;; Trigger native file picker. The dialog stays open; on pick the JS
    ;; side writes the file into VFS and calls $opendlg_refresh_listbox
    ;; (exported below) to repopulate.
    (if (i32.eq (local.get $cmd) (i32.const 0x443))
      (then
        (call $host_pick_file_upload (local.get $hwnd) (global.get $opendlg_current_dir))
        (return (i32.const 0))))

    ;; ---- Download (id 0x444) ----
    ;; Read filename edit, build "C:\<name>", trigger Blob download.
    (if (i32.eq (local.get $cmd) (i32.const 0x444))
      (then
        (call $opendlg_trigger_download (local.get $hwnd))
        (return (i32.const 0))))

    ;; ---- Listbox notifications: id 0x441, LBN_SELCHANGE / LBN_DBLCLK ----
    (if (i32.eq (local.get $cmd) (i32.const 0x441))
      (then
        (if (i32.eq (local.get $notif) (i32.const 2))   ;; LBN_DBLCLK
          (then
            ;; If selection is a directory ([NAME]) or "..", navigate
            ;; instead of triggering IDOK. $opendlg_try_navigate returns
            ;; 1 when it consumed the dblclk by changing dirs.
            (if (i32.eqz (call $opendlg_try_navigate (local.get $hwnd)))
              (then
                (call $opendlg_copy_listbox_to_edit (local.get $hwnd))
                (drop (call $wnd_send_message (local.get $hwnd) (i32.const 0x0111) (i32.const 1) (i32.const 0)))))
            (return (i32.const 0))))
        ;; Plain selection change → copy item text into filename edit.
        (call $opendlg_copy_listbox_to_edit (local.get $hwnd))
        (return (i32.const 0))))

    (i32.const 0))

  ;; Helper: read the listbox's currently-selected item and write it into
  ;; the filename edit (id 0x442). Strips '[' / ']' from directory entries.
  ;; Used by both LBN_SELCHANGE and the IDOK preview.
  (func $opendlg_copy_listbox_to_edit (param $dlg i32)
    (local $lb i32) (local $edit i32) (local $sel i32) (local $buf_g i32)
    (local $buf_w i32) (local $n i32) (local $start i32)
    (local.set $lb   (call $ctrl_find_by_id (local.get $dlg) (i32.const 0x441)))
    (local.set $edit (call $ctrl_find_by_id (local.get $dlg) (i32.const 0x442)))
    (if (i32.or (i32.eqz (local.get $lb)) (i32.eqz (local.get $edit))) (then (return)))
    (local.set $sel (call $wnd_send_message (local.get $lb) (i32.const 0x0188) (i32.const 0) (i32.const 0)))
    (if (i32.lt_s (local.get $sel) (i32.const 0)) (then (return)))
    (local.set $buf_g (call $heap_alloc (i32.const 280)))
    (local.set $buf_w (call $g2w (local.get $buf_g)))
    (local.set $n (call $wnd_send_message (local.get $lb) (i32.const 0x0189)
                    (local.get $sel) (local.get $buf_g)))
    ;; Strip "[...]" wrapper for directory entries
    (local.set $start (local.get $buf_w))
    (if (i32.eq (i32.load8_u (local.get $buf_w)) (i32.const 0x5B))
      (then
        (local.set $start (i32.add (local.get $buf_w) (i32.const 1)))
        (if (i32.gt_u (local.get $n) (i32.const 1))
          (then (i32.store8 (i32.add (local.get $buf_w) (i32.sub (local.get $n) (i32.const 1)))
                            (i32.const 0))))))
    ;; Drop the edit's old text and reload via WM_SETTEXT — pass the
    ;; (possibly start-shifted) buffer as a guest ptr.
    (drop (call $wnd_send_message (local.get $edit) (i32.const 0x000C)
            (i32.const 0)
            (i32.add (local.get $buf_g) (i32.sub (local.get $start) (local.get $buf_w)))))
    (call $heap_free (local.get $buf_g)))

  ;; If the current listbox selection is "[name]" (a directory) or "..",
  ;; navigate the dialog into / out of that directory by updating
  ;; $opendlg_current_dir + repopulating the listbox. Returns 1 if it
  ;; navigated, 0 otherwise (e.g. selection is a regular file).
  (func $opendlg_try_navigate (param $dlg i32) (result i32)
    (local $lb i32) (local $sel i32) (local $buf_g i32) (local $buf_w i32)
    (local $n i32) (local $cur_g i32) (local $cur_w i32) (local $cur_len i32)
    (local $new_g i32) (local $new_w i32) (local $name_len i32) (local $i i32)
    (local.set $lb (call $ctrl_find_by_id (local.get $dlg) (i32.const 0x441)))
    (if (i32.eqz (local.get $lb)) (then (return (i32.const 0))))
    (local.set $sel (call $wnd_send_message (local.get $lb) (i32.const 0x0188) (i32.const 0) (i32.const 0)))
    (if (i32.lt_s (local.get $sel) (i32.const 0)) (then (return (i32.const 0))))
    (local.set $buf_g (call $heap_alloc (i32.const 280)))
    (local.set $buf_w (call $g2w (local.get $buf_g)))
    (local.set $n (call $wnd_send_message (local.get $lb) (i32.const 0x0189) (local.get $sel) (local.get $buf_g)))
    (local.set $cur_g (global.get $opendlg_current_dir))
    (local.set $cur_w (call $g2w (local.get $cur_g)))
    (local.set $cur_len (call $strlen (local.get $cur_w)))
    ;; Case 1: ".." → strip last component (if any). At "C:\" we already
    ;; suppress this entry, so we don't need a special root guard here.
    (if (i32.and (i32.eq (i32.load8_u (local.get $buf_w)) (i32.const 0x2E))
                 (i32.eq (i32.load8_u offset=1 (local.get $buf_w)) (i32.const 0x2E)))
      (then
        ;; Walk back from end past trailing '\\', then strip until next '\\'.
        (local.set $i (i32.sub (local.get $cur_len) (i32.const 1)))
        (if (i32.and (i32.gt_s (local.get $i) (i32.const 0))
                     (i32.eq (i32.load8_u (i32.add (local.get $cur_w) (local.get $i))) (i32.const 0x5C)))
          (then (local.set $i (i32.sub (local.get $i) (i32.const 1)))))
        (block $found (loop $scan
          (br_if $found (i32.le_s (local.get $i) (i32.const 0)))
          (br_if $found (i32.eq (i32.load8_u (i32.add (local.get $cur_w) (local.get $i))) (i32.const 0x5C)))
          (local.set $i (i32.sub (local.get $i) (i32.const 1)))
          (br $scan)))
        ;; Build new dir = cur[0..i+1]   (keep the trailing '\\')
        (local.set $new_g (call $heap_alloc (i32.add (local.get $i) (i32.const 2))))
        (local.set $new_w (call $g2w (local.get $new_g)))
        (call $memcpy (local.get $new_w) (local.get $cur_w) (i32.add (local.get $i) (i32.const 1)))
        (i32.store8 (i32.add (local.get $new_w) (i32.add (local.get $i) (i32.const 1))) (i32.const 0))
        (call $opendlg_set_dir (local.get $dlg) (local.get $new_g))
        (call $heap_free (local.get $new_g))
        (call $heap_free (local.get $buf_g))
        (return (i32.const 1))))
    ;; Case 2: "[name]" → enter subdir. Strip brackets, append "<name>\\".
    (if (i32.eq (i32.load8_u (local.get $buf_w)) (i32.const 0x5B))
      (then
        ;; Trim trailing ']' (n was the count returned from LB_GETTEXT)
        (local.set $name_len (i32.sub (local.get $n) (i32.const 2)))
        ;; New dir = cur + ("\\" if !ends_with_slash) + name + "\\"
        (local.set $new_g (call $heap_alloc (i32.add (i32.add (local.get $cur_len) (local.get $name_len)) (i32.const 3))))
        (local.set $new_w (call $g2w (local.get $new_g)))
        (call $memcpy (local.get $new_w) (local.get $cur_w) (local.get $cur_len))
        (local.set $i (local.get $cur_len))
        (if (i32.ne (i32.load8_u (i32.add (local.get $cur_w) (i32.sub (local.get $cur_len) (i32.const 1)))) (i32.const 0x5C))
          (then
            (i32.store8 (i32.add (local.get $new_w) (local.get $i)) (i32.const 0x5C))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))))
        (call $memcpy (i32.add (local.get $new_w) (local.get $i))
                      (i32.add (local.get $buf_w) (i32.const 1))
                      (local.get $name_len))
        (local.set $i (i32.add (local.get $i) (local.get $name_len)))
        (i32.store8 (i32.add (local.get $new_w) (local.get $i)) (i32.const 0x5C))
        (i32.store8 (i32.add (local.get $new_w) (i32.add (local.get $i) (i32.const 1))) (i32.const 0))
        (call $opendlg_set_dir (local.get $dlg) (local.get $new_g))
        (call $heap_free (local.get $new_g))
        (call $heap_free (local.get $buf_g))
        (return (i32.const 1))))
    (call $heap_free (local.get $buf_g))
    (i32.const 0))

  ;; Set $opendlg_current_dir to a new heap-allocated copy of the
  ;; given guest string, freeing the old one. Updates the path edit
  ;; (id 0x440) and re-populates the listbox via the "<dir>\*" pattern.
  ;; Caller is responsible for the source string lifetime — we copy.
  (func $opendlg_set_dir (param $dlg i32) (param $new_dir_g i32)
    (local $len i32) (local $buf_g i32) (local $buf_w i32)
    (local $pat_g i32) (local $pat_w i32)
    (local $path_edit i32) (local $lb i32)
    (local.set $len (call $strlen (call $g2w (local.get $new_dir_g))))
    (local.set $buf_g (call $heap_alloc (i32.add (local.get $len) (i32.const 1))))
    (local.set $buf_w (call $g2w (local.get $buf_g)))
    (call $memcpy (local.get $buf_w) (call $g2w (local.get $new_dir_g)) (local.get $len))
    (i32.store8 (i32.add (local.get $buf_w) (local.get $len)) (i32.const 0))
    (call $heap_free (global.get $opendlg_current_dir))
    (global.set $opendlg_current_dir (local.get $buf_g))
    ;; Update path edit
    (local.set $path_edit (call $ctrl_find_by_id (local.get $dlg) (i32.const 0x440)))
    (if (local.get $path_edit)
      (then (drop (call $wnd_send_message (local.get $path_edit) (i32.const 0x000C)
              (i32.const 0) (local.get $buf_g)))))
    ;; Build "<dir>\*" pattern for fs_find_first_file. If dir already ends
    ;; with '\\' (root), just append '*'; else append "\\*".
    (local.set $pat_g (call $heap_alloc (i32.add (local.get $len) (i32.const 4))))
    (local.set $pat_w (call $g2w (local.get $pat_g)))
    (call $memcpy (local.get $pat_w) (local.get $buf_w) (local.get $len))
    (if (i32.eq (i32.load8_u (i32.add (local.get $buf_w) (i32.sub (local.get $len) (i32.const 1))))
                (i32.const 0x5C))   ;; ends with '\\'
      (then
        (i32.store8 (i32.add (local.get $pat_w) (local.get $len)) (i32.const 0x2A))   ;; '*'
        (i32.store8 (i32.add (local.get $pat_w) (i32.add (local.get $len) (i32.const 1))) (i32.const 0)))
      (else
        (i32.store8 (i32.add (local.get $pat_w) (local.get $len)) (i32.const 0x5C))   ;; '\\'
        (i32.store8 (i32.add (local.get $pat_w) (i32.add (local.get $len) (i32.const 1))) (i32.const 0x2A))   ;; '*'
        (i32.store8 (i32.add (local.get $pat_w) (i32.add (local.get $len) (i32.const 2))) (i32.const 0))))
    (local.set $lb (call $ctrl_find_by_id (local.get $dlg) (i32.const 0x441)))
    (if (local.get $lb)
      (then (call $opendlg_populate_listbox (local.get $lb) (local.get $pat_g))))
    (call $heap_free (local.get $pat_g))
    (call $invalidate_hwnd (local.get $dlg)))

  ;; Trigger a Blob download for the current filename edit value (if any).
  ;; Builds "C:\<filename>" in a heap buffer and hands the WASM addr to
  ;; $host_file_download which reads the VFS bytes + creates the Blob.
  (func $opendlg_trigger_download (param $dlg i32)
    (local $edit i32) (local $state i32) (local $sw i32)
    (local $name_len i32) (local $name_src_w i32)
    (local $path_g i32) (local $path_w i32)
    (local.set $edit (call $ctrl_find_by_id (local.get $dlg) (i32.const 0x442)))
    (if (i32.eqz (local.get $edit)) (then (return)))
    (local.set $state (call $wnd_get_state_ptr (local.get $edit)))
    (if (i32.eqz (local.get $state)) (then (return)))
    (local.set $sw (call $g2w (local.get $state)))
    (local.set $name_len (i32.load offset=4 (local.get $sw)))
    (if (i32.eqz (local.get $name_len)) (then (return)))
    (local.set $name_src_w (call $g2w (i32.load (local.get $sw))))
    ;; Buffer = "C:\" + name + "\0"
    (local.set $path_g (call $heap_alloc (i32.add (local.get $name_len) (i32.const 4))))
    (local.set $path_w (call $g2w (local.get $path_g)))
    (i32.store8        (local.get $path_w) (i32.const 0x43))                  ;; 'C'
    (i32.store8 offset=1 (local.get $path_w) (i32.const 0x3A))                 ;; ':'
    (i32.store8 offset=2 (local.get $path_w) (i32.const 0x5C))                 ;; '\\'
    (call $memcpy (i32.add (local.get $path_w) (i32.const 3)) (local.get $name_src_w) (local.get $name_len))
    (i32.store8 (i32.add (local.get $path_w) (i32.add (local.get $name_len) (i32.const 3))) (i32.const 0))
    (call $host_file_download (local.get $path_w))
    (call $heap_free (local.get $path_g)))

  ;; ---- Build the open/save dialog ----
  ;;
  ;;   $kind: 0 = Open, 1 = Save As (controls title + IDOK button label)
  ;;   $ofn:  guest ptr to OPENFILENAME — stashed in dialog userdata so the
  ;;          OK handler can write back lpstrFile.
  (func $create_open_dialog (param $dlg i32) (param $owner i32) (param $kind i32) (param $ofn i32)
    (local $w i32) (local $h i32) (local $title_wa i32) (local $btn_g i32)
    (local $lb i32) (local $ofn_w i32) (local $filter_g i32) (local $filter_cb i32)
    (local.set $w (i32.const 360))
    (local.set $h (i32.const 240))
    ;; Title goes to JS (WASM offset). Button text goes through
    ;; $wat_str_to_heap → guest ptr that ctrl_create_child stores in
    ;; CREATESTRUCT.lpszName for $button_wndproc to read in WM_CREATE.
    (if (i32.eq (local.get $kind) (i32.const 1))
      (then
        (local.set $title_wa (i32.const 0x1103C))                                    ;; "Save As"
        (local.set $btn_g   (call $wat_str_to_heap (i32.const 0x11044) (i32.const 4))))  ;; "Save"
      (else
        (local.set $title_wa (i32.const 0x11037))                                    ;; "Open"
        (local.set $btn_g   (call $wat_str_to_heap (i32.const 0x11037) (i32.const 4))))) ;; "Open"
    (call $host_register_dialog_frame
      (local.get $dlg) (local.get $owner)
      (local.get $title_wa)
      (local.get $w) (local.get $h)
      (i32.const 1))  ;; isAboutDialog flag (modal indicator) — reused for now
    (call $wnd_table_set (local.get $dlg) (global.get $WNDPROC_CTRL_NATIVE))
    (call $title_table_set (local.get $dlg) (local.get $title_wa)
      (call $strlen (local.get $title_wa)))
    (call $wnd_set_owner (local.get $dlg) (local.get $owner))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x90C80000)))
    (call $ctrl_table_set (call $wnd_table_find (local.get $dlg))
      (i32.const 12) (i32.const 0))
    ;; Match USER's create order: establish the dialog frame/client rect before
    ;; painting the client area or any child controls. Otherwise child-control
    ;; DCs see a zero client offset and draw into the title bar.
    (call $defwndproc_do_nccalcsize (local.get $dlg))
    (call $defwndproc_do_ncpaint (local.get $dlg))
    (call $nc_flags_set (local.get $dlg) (i32.const 3))
    (call $dlg_fill_bkgnd (local.get $dlg))
    ;; Stash OFN ptr for the OK handler.
    (drop (call $wnd_set_userdata (local.get $dlg) (local.get $ofn)))

    ;; "Look in:" static
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
            (i32.const 12) (i32.const 10) (i32.const 60) (i32.const 16)
            (i32.const 0x50000000)
            (call $wat_str_to_heap (i32.const 0x11054) (i32.const 8))))
    ;; Current directory display (read-only-ish edit at id 0x440)
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 2) (i32.const 0x440)
            (i32.const 76) (i32.const 8) (i32.const 200) (i32.const 18)
            (i32.const 0x50810000)
            (call $wat_str_to_heap (i32.const 0x11062) (i32.const 3))))  ;; "C:\"
    ;; File listbox (id 0x441) — WS_VSCROLL so the scrollbar strip renders.
    (local.set $lb (call $ctrl_create_child (local.get $dlg) (i32.const 4) (i32.const 0x441)
                     (i32.const 12) (i32.const 32) (i32.const 264) (i32.const 130)
                     (i32.const 0x50A10001) (i32.const 0)))
    ;; "File name:" static
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
            (i32.const 12) (i32.const 168) (i32.const 60) (i32.const 16)
            (i32.const 0x50000000)
            (call $wat_str_to_heap (i32.const 0x11049) (i32.const 10))))
    ;; Filename edit (id 0x442)
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 2) (i32.const 0x442)
            (i32.const 76) (i32.const 166) (i32.const 200) (i32.const 18)
            (i32.const 0x50810000) (i32.const 0)))
    (if (local.get $ofn)
      (then
        (local.set $ofn_w (call $g2w (local.get $ofn)))
        (local.set $filter_g (i32.load offset=12 (local.get $ofn_w)))))
    (if (local.get $filter_g)
      (then
        ;; "Files of type:" static + dropdownlist populated from OFN.lpstrFilter.
        (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
                (i32.const 12) (i32.const 194) (i32.const 80) (i32.const 16)
                (i32.const 0x50000000)
                (call $wat_str_to_heap (i32.const 0x1107C) (i32.const 14))))
        (local.set $filter_cb
          (call $ctrl_create_child (local.get $dlg) (i32.const 5) (i32.const 0x445)
            (i32.const 96) (i32.const 190) (i32.const 180) (i32.const 72)
            (i32.const 0x50010003) (i32.const 0)))
        (call $opendlg_populate_filter_combo (local.get $filter_cb) (local.get $ofn))))
    ;; Open / Save button (id IDOK = 1)
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 1)
            (i32.const 286) (i32.const 8) (i32.const 64) (i32.const 22)
            (i32.const 0x50010001)
            (local.get $btn_g)))
    ;; Cancel button (id IDCANCEL = 2)
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 2)
            (i32.const 286) (i32.const 36) (i32.const 64) (i32.const 22)
            (i32.const 0x50010000)
            (call $wat_str_to_heap (i32.const 0x11003) (i32.const 6))))   ;; "Cancel"
    ;; Upload (Open) / Download (Save As) button — only in browser mode.
    ;; Open  → "Upload..." (id 0x443) which triggers a <input type="file">
    ;;         picker, writes the chosen bytes into VFS, refreshes the listbox.
    ;; Save  → "Download" (id 0x444) which writes the VFS bytes for the
    ;;         filename to a Blob and clicks an <a download> link.
    (if (call $host_has_dom)
      (then
        (if (i32.eq (local.get $kind) (i32.const 1))
          (then
            (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 0x444)
                    (i32.const 286) (i32.const 80) (i32.const 64) (i32.const 22)
                    (i32.const 0x50010000)
                    (call $wat_str_to_heap (i32.const 0x11073) (i32.const 8)))))   ;; "Download"
          (else
            (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 0x443)
                    (i32.const 286) (i32.const 80) (i32.const 64) (i32.const 22)
                    (i32.const 0x50010000)
                    (call $wat_str_to_heap (i32.const 0x11069) (i32.const 9))))))))   ;; "Upload..."

    ;; Initialize current dir to "C:\\" and populate the listbox via
    ;; $opendlg_set_dir which builds the pattern + path edit too.
    (call $heap_free (global.get $opendlg_current_dir))
    (global.set $opendlg_current_dir (call $wat_str_to_heap (i32.const 0x11062) (i32.const 3)))
    (call $opendlg_populate_listbox (local.get $lb)
      (call $wat_str_to_heap (i32.const 0x1105D) (i32.const 4))))

  ;; Internal helper for $findreplace_wndproc — reads ButtonState.flags
  ;; without the export-layer wrapping.
  (func $button_get_flags_internal (param $hwnd i32) (result i32)
    (local $s i32)
    (local.set $s (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $s)) (then (return (i32.const 0))))
    (i32.load offset=8 (call $g2w (local.get $s))))

  ;; ---- Shared text-buffer helper for state structs ----
  ;;
  ;; Allocate a text buffer in $heap_alloc and copy len bytes from a guest
  ;; source pointer. Returns the new guest pointer (or 0 if src_guest_ptr=0
  ;; or len=0). Caller is responsible for $heap_free on the returned ptr.
  (func $ctrl_text_dup (param $src_guest_ptr i32) (param $len i32) (result i32)
    (local $buf i32)
    (if (i32.or (i32.eqz (local.get $src_guest_ptr)) (i32.eqz (local.get $len)))
      (then (return (i32.const 0))))
    (local.set $buf (call $heap_alloc (i32.add (local.get $len) (i32.const 1))))
    (call $memcpy (call $g2w (local.get $buf)) (call $g2w (local.get $src_guest_ptr)) (local.get $len))
    (i32.store8 (i32.add (call $g2w (local.get $buf)) (local.get $len)) (i32.const 0))
    (local.get $buf)
  )

  ;; Clear the "checked" bit on every BS_AUTORADIOBUTTON in $hwnd's WS_GROUP,
  ;; then let the caller set $hwnd itself. A group begins at the nearest
  ;; preceding sibling (including self) with WS_GROUP and ends before the next
  ;; WS_GROUP sibling. Paint's Flip/Rotate dialog has an operation group and a
  ;; nested angle group under the same parent; treating all sibling radios as
  ;; one mutex makes choosing 180 degrees clear "Rotate by angle".
  (func $autoradio_clear_siblings (param $hwnd i32)
    (local $parent i32) (local $i i32) (local $rec i32)
    (local $other i32) (local $st i32) (local $stw i32) (local $flags i32)
    (local $target_slot i32) (local $group_start i32) (local $group_end i32)
    (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
    (if (i32.eqz (local.get $parent)) (then (return)))
    (local.set $target_slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.lt_s (local.get $target_slot) (i32.const 0)) (then (return)))
    ;; Locate the nearest WS_GROUP boundary at or before the target.
    (local.set $i (i32.const 0))
    (block $start_done (loop $start_scan
      (br_if $start_done (i32.gt_u (local.get $i) (local.get $target_slot)))
      (local.set $rec (call $wnd_record_addr (local.get $i)))
      (if (i32.and
            (i32.eq (i32.load offset=8 (local.get $rec)) (local.get $parent))
            (i32.ne
              (i32.and (i32.load offset=16 (local.get $rec)) (i32.const 0x00020000))
              (i32.const 0)))
        (then (local.set $group_start (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $start_scan)))
    ;; The next WS_GROUP sibling starts a different mutex group.
    (local.set $group_end (global.get $MAX_WINDOWS))
    (local.set $i (i32.add (local.get $target_slot) (i32.const 1)))
    (block $end_done (loop $end_scan
      (br_if $end_done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $rec (call $wnd_record_addr (local.get $i)))
      (if (i32.and
            (i32.eq (i32.load offset=8 (local.get $rec)) (local.get $parent))
            (i32.ne
              (i32.and (i32.load offset=16 (local.get $rec)) (i32.const 0x00020000))
              (i32.const 0)))
        (then
          (local.set $group_end (local.get $i))
          (br $end_done)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $end_scan)))
    (local.set $i (local.get $group_start))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $group_end)))
      (local.set $rec (call $wnd_record_addr (local.get $i)))
      (local.set $other (i32.load (local.get $rec)))
      (if (i32.and
            (i32.and (i32.ne (local.get $other) (i32.const 0))
                     (i32.eq (i32.load offset=8 (local.get $rec)) (local.get $parent)))
            ;; kind == BS_AUTORADIOBUTTON (9)
            (i32.eq (i32.and (i32.load offset=16 (local.get $rec)) (i32.const 0x0F))
                    (i32.const 9)))
        (then
          (local.set $st (i32.load offset=20 (local.get $rec)))
          (if (local.get $st)
            (then
              (local.set $stw (call $g2w (local.get $st)))
              (local.set $flags (i32.load offset=8 (local.get $stw)))
              ;; Clear bit1 (checked) on every autoradio sibling — including
              ;; $hwnd itself; the caller will re-set it after this returns.
              (i32.store offset=8 (local.get $stw)
                (i32.and (local.get $flags) (i32.const 0xFFFFFFFD)))
              (call $invalidate_hwnd (local.get $other))
              ;; The browser compositor does not always get another child
              ;; paint before the next frame. Paint cleared siblings now so
              ;; stale radio dots cannot remain visible.
              (if (i32.and (local.get $flags) (i32.const 0x02))
                (then
                  (drop (call $wnd_send_message
                    (local.get $other) (i32.const 0x000F)
                    (i32.const 0) (i32.const 0)))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
  )

  ;; Walk siblings under the same parent and clear bit2 ("default") on any
  ;; button that has it set. Used when a non-default button gains focus —
  ;; real Win98 promotes the focused button to the temporary default, so
  ;; the originally-default button must lose its border.
  (func $btn_clear_sibling_default (param $hwnd i32) (param $except i32)
    (local $parent i32) (local $i i32) (local $rec i32)
    (local $other i32) (local $st i32) (local $stw i32)
    (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
    (if (i32.eqz (local.get $parent)) (then (return)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $rec (call $wnd_record_addr (local.get $i)))
      (local.set $other (i32.load (local.get $rec)))
      (if (i32.and
            (i32.and (i32.ne (local.get $other) (i32.const 0))
                     (i32.eq (i32.load offset=8 (local.get $rec)) (local.get $parent)))
            (i32.ne (local.get $other) (local.get $except)))
        (then
          (if (i32.eq (call $ctrl_table_get_class (local.get $other)) (i32.const 1))
            (then
              (local.set $st (i32.load offset=20 (local.get $rec)))
              (if (local.get $st)
                (then
                  (local.set $stw (call $g2w (local.get $st)))
                  (if (i32.and (i32.load offset=8 (local.get $stw)) (i32.const 0x04))
                    (then
                      (i32.store offset=8 (local.get $stw)
                        (i32.and (i32.load offset=8 (local.get $stw)) (i32.const 0xFFFFFFFB)))
                      (call $invalidate_hwnd (local.get $other))))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
  )

  ;; Find sibling button under same parent whose style&0xF == 1 (real
  ;; BS_DEFPUSHBUTTON), set bit2 on it, invalidate. Used on KILLFOCUS so
  ;; the originally-default button regains its border.
  (func $btn_restore_real_default (param $hwnd i32)
    (local $parent i32) (local $i i32) (local $rec i32)
    (local $other i32) (local $st i32) (local $stw i32)
    (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
    (if (i32.eqz (local.get $parent)) (then (return)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $rec (call $wnd_record_addr (local.get $i)))
      (local.set $other (i32.load (local.get $rec)))
      (if (i32.and
            (i32.and (i32.ne (local.get $other) (i32.const 0))
                     (i32.eq (i32.load offset=8 (local.get $rec)) (local.get $parent)))
            (i32.eq (i32.and (call $wnd_get_style (local.get $other)) (i32.const 0x0F))
                    (i32.const 1)))
        (then
          (local.set $st (i32.load offset=20 (local.get $rec)))
          (if (local.get $st)
            (then
              (local.set $stw (call $g2w (local.get $st)))
              (i32.store offset=8 (local.get $stw)
                (i32.or (i32.load offset=8 (local.get $stw)) (i32.const 0x04)))
              (call $invalidate_hwnd (local.get $other))
              (return)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
  )

  ;; ---- Owner-draw WM_DRAWITEM dispatch ----
  ;; Build a DRAWITEMSTRUCT on the heap, send WM_DRAWITEM to the parent so
  ;; the owning wndproc paints the button face, then free. Called on state
  ;; transitions (mousedown/up) for BS_OWNERDRAW buttons; the WM_PAINT
  ;; handler skips drawing for that kind.
  ;;
  ;; DRAWITEMSTRUCT (48 bytes):
  ;;   +0x00 CtlType=ODT_BUTTON(4)   +0x04 CtlID
  ;;   +0x08 itemID=0                +0x0C itemAction=ODA_DRAWENTIRE(1)
  ;;   +0x10 itemState (ODS_SELECTED 0x01 | ODS_FOCUS 0x10 | ODS_DEFAULT 0x20)
  ;;   +0x14 hwndItem                +0x18 hDC
  ;;   +0x1C..+0x2B RECT rcItem      +0x2C itemData=0
  (func $btn_send_drawitem (param $hwnd i32) (param $state_w i32) (param $flags i32)
    (local $dis i32) (local $disw i32) (local $sz i32) (local $w i32) (local $h i32)
    (local $ctrl_id i32) (local $hdc i32) (local $state_bits i32)
    (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
    (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
    (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
    (local.set $ctrl_id (i32.and (i32.load offset=12 (local.get $state_w)) (i32.const 0xFFFF)))
    (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
    (drop (call $host_gdi_select_clip_rgn (local.get $hdc) (i32.const 0)))
    (local.set $state_bits
      (i32.or
        (i32.or
          (select (i32.const 0x0001) (i32.const 0) (i32.and (local.get $flags) (i32.const 0x01)))
          (select (i32.const 0x0010) (i32.const 0) (i32.and (local.get $flags) (i32.const 0x08))))
        (select (i32.const 0x0020) (i32.const 0) (i32.and (local.get $flags) (i32.const 0x04)))))
    (local.set $dis (call $heap_alloc (i32.const 48)))
    (local.set $disw (call $g2w (local.get $dis)))
    (i32.store           (local.get $disw) (i32.const 4))
    (i32.store offset=4  (local.get $disw) (local.get $ctrl_id))
    (i32.store offset=8  (local.get $disw) (i32.const 0))
    (i32.store offset=12 (local.get $disw) (i32.const 1))
    (i32.store offset=16 (local.get $disw) (local.get $state_bits))
    (i32.store offset=20 (local.get $disw) (local.get $hwnd))
    (i32.store offset=24 (local.get $disw) (local.get $hdc))
    (i32.store offset=28 (local.get $disw) (i32.const 0))
    (i32.store offset=32 (local.get $disw) (i32.const 0))
    (i32.store offset=36 (local.get $disw) (local.get $w))
    (i32.store offset=40 (local.get $disw) (local.get $h))
    (i32.store offset=44 (local.get $disw) (i32.const 0))
    ;; Calc owner-draw button labels move by 1px while pressed. Its draw code
    ;; uses transparent text, so clear the child DC first or stale glyph pixels
    ;; from the previous offset remain visible.
    (drop (call $host_gdi_fill_rect (local.get $hdc)
            (i32.const 0) (i32.const 0)
            (local.get $w) (local.get $h)
            (i32.const 0x30011)))
    (drop (call $wnd_send_message
            (call $wnd_get_parent (local.get $hwnd))
            (i32.const 0x002B)
            (local.get $ctrl_id)
            (local.get $dis)))
    (call $heap_free (local.get $dis)))

  (func $dialog_default_idok_close (param $parent i32)
    (local $dlg_rec i32)
    ;; Only DialogBoxParamA's modal pump supplies a default IDOK close.
    ;; CreateDialogParamA dialogs are modeless: their application owns the
    ;; lifetime even when the dialog proc returns FALSE for WM_COMMAND.
    ;; WAT-native dialogs (FindReplace/About/etc.) have their own class
    ;; handlers, so leave those alone.
    (if (i32.eqz (local.get $parent)) (then (return)))
    (if (i32.ne (global.get $dlg_pump_hwnd) (local.get $parent)) (then (return)))
    (if (i32.eqz (call $wnd_table_get (local.get $parent))) (then (return)))
    (if (call $ctrl_table_get_class (local.get $parent)) (then (return)))
    (local.set $dlg_rec (call $dlg_record_for_hwnd (local.get $parent)))
    (if (i32.eqz (local.get $dlg_rec)) (then (return)))
    (if (i32.eqz (i32.load offset=4 (local.get $dlg_rec))) (then (return)))
    (global.set $dlg_ended (i32.const 1))
    (global.set $dlg_result (i32.const 1))
    (i32.store (global.get $SHARED_DLG_ENDED) (i32.const 1))
    (i32.store (global.get $SHARED_DLG_RESULT) (i32.const 1))
    (call $wnd_destroy_tree (local.get $parent))
    (call $host_destroy_window (local.get $parent)))

  ;; ---- Button WndProc ----
  ;;
  ;; Test path NOT YET WIRED: dialog buttons today receive only BM_GETCHECK
  ;; / BM_SETCHECK via SendMessageA from x86 dialog procs. They never get
  ;; WM_CREATE because the JS-side dialog framework owns control creation.
  ;; STEP 5 will create dialogs from WAT, at which point WM_CREATE/WM_PAINT
  ;; below become live. Until then, the legacy CONTROL_TABLE path is the
  ;; only thing exercised by tests.

  (func $button_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $state i32) (local $state_w i32)
    (local $cs_w i32) (local $hdc i32) (local $sz i32)
    (local $w i32) (local $h i32) (local $flags i32)
    (local $edge_flags i32) (local $text_w i32) (local $text_len i32)
    (local $brush i32) (local $name_ptr i32) (local $hmenu i32)
    (local $kind i32) (local $box_y i32) (local $tw i32)
    (local $img i32) (local $img_w i32) (local $img_h i32) (local $img_x i32) (local $img_y i32)
    (local $parent i32) (local $cmd_id i32)

    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))

    ;; EDIT scrollbars are standard non-client strips. Messages sent through
    ;; the control dispatcher do not pass through DefWindowProc automatically,
    ;; so paint the border and both scrollbar styles here instead of leaving
    ;; their backing-surface pixels black.
    (if (i32.and
          (i32.eq (local.get $msg) (i32.const 0x0085)) ;; WM_NCPAINT
          (i32.ne
            (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00300000))
            (i32.const 0)))
      (then
        (call $defwndproc_do_ncpaint (local.get $hwnd))
        (return (i32.const 0))))

    ;; ---------- WM_CREATE (0x0001) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0001))
      (then
        ;; lParam = guest ptr to CREATESTRUCT
        ;; CREATESTRUCT: hMenu(+8) hwndParent(+12) cy(+16) cx(+20) y(+24) x(+28)
        ;;               style(+32) lpszName(+36) lpszClass(+40) dwExStyle(+44)
        (local.set $cs_w (call $g2w (local.get $lParam)))
        (local.set $hmenu    (i32.load offset=8  (local.get $cs_w)))
        (local.set $name_ptr (i32.load offset=36 (local.get $cs_w)))
        ;; Allocate ButtonState
        (local.set $state (call $heap_alloc (i32.const 72)))
        (local.set $state_w (call $g2w (local.get $state)))
        (i32.store        (local.get $state_w) (i32.const 0)) ;; text_buf_ptr
        (i32.store offset=4  (local.get $state_w) (i32.const 0)) ;; text_len
        ;; flags: bit2=default if BS_DEFPUSHBUTTON (style&0xF == 1).
        ;; The control's style is already on the WND record via $dlg_load /
        ;; $ctrl_create_child, so $wnd_get_style returns the right value.
        (i32.store offset=8  (local.get $state_w)
          (select (i32.const 0x04) (i32.const 0)
                  (i32.eq (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x0F))
                          (i32.const 1))))
        (i32.store offset=12 (local.get $state_w) (local.get $hmenu)) ;; ctrl_id
        (i32.store offset=64 (local.get $state_w) (i32.const 0)) ;; image_type = IMAGE_BITMAP
        (i32.store offset=68 (local.get $state_w) (i32.const 0)) ;; image_handle
        ;; Copy initial text from CREATESTRUCT.lpszName
        (if (local.get $name_ptr)
          (then
            (local.set $text_len (call $strlen (call $g2w (local.get $name_ptr))))
            (i32.store        (local.get $state_w) (call $ctrl_text_dup (local.get $name_ptr) (local.get $text_len)))
            (i32.store offset=4  (local.get $state_w) (local.get $text_len))))
        (call $wnd_set_state_ptr (local.get $hwnd) (local.get $state))
        (return (i32.const 0))))

    ;; ---------- WM_DESTROY (0x0002) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0002))
      (then
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            (call $heap_free (i32.load (local.get $state_w))) ;; free text buf
            (call $heap_free (local.get $state))
            (call $wnd_set_state_ptr (local.get $hwnd) (i32.const 0))))
        (return (i32.const 0))))

    ;; ---------- WM_SETFOCUS (0x0007) ----------
    ;; Mark focused (bit3) and become the temporary default (bit2). If
    ;; this button isn't the real default, clear bit2 on whichever
    ;; sibling currently has it.
    (if (i32.eq (local.get $msg) (i32.const 0x0007))
      (then
        (global.set $focus_hwnd (local.get $hwnd))
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            (call $btn_clear_sibling_default (local.get $hwnd) (local.get $hwnd))
            (i32.store offset=8 (local.get $state_w)
              (i32.or (i32.load offset=8 (local.get $state_w)) (i32.const 0x0C))) ;; focused | default
            (call $invalidate_hwnd (local.get $hwnd))))
        (return (i32.const 0))))

    ;; ---------- WM_KILLFOCUS (0x0008) ----------
    ;; Clear focused. If this button isn't the real default but currently
    ;; has bit2 (because it was the temp-default), clear it and restore
    ;; bit2 on the real default.
    (if (i32.eq (local.get $msg) (i32.const 0x0008))
      (then
        (if (i32.eq (global.get $focus_hwnd) (local.get $hwnd))
          (then (global.set $focus_hwnd (i32.const 0))))
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            ;; Always clear focused bit3.
            (i32.store offset=8 (local.get $state_w)
              (i32.and (i32.load offset=8 (local.get $state_w)) (i32.const 0xFFFFFFF7)))
            ;; If we aren't the real default, drop bit2 and restore the
            ;; real default's border. wnd style&0xF == 1 means real
            ;; BS_DEFPUSHBUTTON.
            (if (i32.ne (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x0F))
                        (i32.const 1))
              (then
                (i32.store offset=8 (local.get $state_w)
                  (i32.and (i32.load offset=8 (local.get $state_w)) (i32.const 0xFFFFFFFB)))
                (call $btn_restore_real_default (local.get $hwnd))))
            (call $invalidate_hwnd (local.get $hwnd))))
        (return (i32.const 0))))

    ;; ---------- WM_KEYDOWN (0x0100) ----------
    ;; Space/Enter activate the button — post WM_COMMAND(BN_CLICKED) to
    ;; the parent dialog. Mirrors WM_LBUTTONUP's parent-notify path.
    (if (i32.eq (local.get $msg) (i32.const 0x0100))
      (then
        (if (i32.or (i32.eq (local.get $wParam) (i32.const 0x20))   ;; VK_SPACE
                    (i32.eq (local.get $wParam) (i32.const 0x0D)))  ;; VK_RETURN
          (then
            (if (local.get $state)
              (then
                (local.set $state_w (call $g2w (local.get $state)))
                (drop (call $post_queue_push
                  (call $wnd_get_parent (local.get $hwnd))
                  (i32.const 0x0111)
                  (i32.and (i32.load offset=12 (local.get $state_w)) (i32.const 0xFFFF))
                  (local.get $hwnd)))))))
        (return (i32.const 0))))

    ;; ---------- WM_SETTEXT (0x000C) ----------
    ;; lParam = guest ptr to NUL-terminated string. Replace text buffer.
    (if (i32.eq (local.get $msg) (i32.const 0x000C))
      (then
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            (call $heap_free (i32.load (local.get $state_w)))
            (i32.store        (local.get $state_w) (i32.const 0))
            (i32.store offset=4 (local.get $state_w) (i32.const 0))
            (if (local.get $lParam)
              (then
                (local.set $text_len (call $strlen (call $g2w (local.get $lParam))))
                (i32.store        (local.get $state_w) (call $ctrl_text_dup (local.get $lParam) (local.get $text_len)))
                (i32.store offset=4 (local.get $state_w) (local.get $text_len))))
            (if (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x10000000))
              (then (call $invalidate_hwnd (local.get $hwnd))))
            (return (i32.const 1)))) ;; TRUE
        (return (i32.const 0))))

    ;; ---------- WM_GETTEXT (0x000D) ----------
    ;; wParam = max chars (incl. NUL), lParam = guest dest buffer.
    (if (i32.eq (local.get $msg) (i32.const 0x000D))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (if (i32.eqz (local.get $wParam)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $text_len (i32.load offset=4 (local.get $state_w)))
        (if (i32.ge_u (local.get $text_len) (local.get $wParam))
          (then (local.set $text_len (i32.sub (local.get $wParam) (i32.const 1)))))
        (if (i32.load (local.get $state_w))
          (then (call $memcpy (call $g2w (local.get $lParam))
                              (call $g2w (i32.load (local.get $state_w)))
                              (local.get $text_len))))
        (i32.store8 (i32.add (call $g2w (local.get $lParam)) (local.get $text_len)) (i32.const 0))
        (return (local.get $text_len))))

    ;; ---------- WM_GETTEXTLENGTH (0x000E) ----------
    ;; Answering only WM_GETTEXT is not enough. VCL's TControl.GetText asks for
    ;; the length first and sizes the result string from it, so a button that
    ;; reports 0 hands every caller an empty caption however correct its
    ;; WM_GETTEXT reply is. TetriNET compares its Connect button's caption
    ;; against "Connect" to decide whether it is connecting or disconnecting,
    ;; and with an empty string it always chose disconnect.
    (if (i32.eq (local.get $msg) (i32.const 0x000E))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (return (i32.load offset=4 (call $g2w (local.get $state))))))

    ;; ---------- WM_LBUTTONDOWN (0x0201) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0201))
      (then
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            (local.set $flags
              (i32.or (i32.load offset=8 (local.get $state_w)) (i32.const 0x01))) ;; pressed
            (i32.store offset=8 (local.get $state_w) (local.get $flags))
            (global.set $capture_hwnd (local.get $hwnd))
            ;; BS_OWNERDRAW: ask parent to repaint via WM_DRAWITEM. Other
            ;; kinds rely on WM_PAINT → button_wndproc drawing the bevel.
            (if (i32.eq (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x0F))
                        (i32.const 0x0B))
              (then (call $btn_send_drawitem (local.get $hwnd) (local.get $state_w) (local.get $flags)))
              (else
                (drop (call $wnd_send_message
                  (local.get $hwnd) (i32.const 0x000F) (i32.const 0) (i32.const 0)))))))
        (return (i32.const 0))))

    ;; ---------- WM_LBUTTONUP (0x0202) ----------
    ;; Clear pressed flag, derive button kind from style&0xF (BS_*), toggle
    ;; check state for checkbox/radio kinds, then post WM_COMMAND with
    ;; BN_CLICKED to the parent so a future $wndproc_dialog (or an existing
    ;; x86 dialog proc) can react.
    (if (i32.eq (local.get $msg) (i32.const 0x0202))
      (then
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            (local.set $flags (i32.load offset=8 (local.get $state_w)))
            ;; clear pressed
            (local.set $flags (i32.and (local.get $flags) (i32.const 0xFFFFFFFE)))
            (if (i32.eq (global.get $capture_hwnd) (local.get $hwnd))
              (then (global.set $capture_hwnd (i32.const 0))))
            ;; Toggle checked for BS_CHECKBOX(2)/BS_AUTOCHECKBOX(3)/
            ;; BS_3STATE(5)/BS_AUTO3STATE(6). BS_AUTORADIOBUTTON(9) clears
            ;; sibling autoradios then forces this one ON (radio mutex).
            ;; Push buttons (0,1), plain BS_RADIOBUTTON(4) and groupbox (7)
            ;; do not auto-toggle — the parent dialog code is expected to
            ;; manage their state in response to BN_CLICKED.
            (local.set $w (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x0F)))
            (if (i32.or
                  (i32.or (i32.eq (local.get $w) (i32.const 2))
                          (i32.eq (local.get $w) (i32.const 3)))
                  (i32.or (i32.eq (local.get $w) (i32.const 5))
                          (i32.eq (local.get $w) (i32.const 6))))
              (then (local.set $flags (i32.xor (local.get $flags) (i32.const 0x02)))))
            (if (i32.eq (local.get $w) (i32.const 9))
              (then
                (call $autoradio_clear_siblings (local.get $hwnd))
                ;; $autoradio_clear_siblings cleared $hwnd's bit too — set it
                ;; back on. Use the freshly-cleared flags from the state struct.
                (local.set $flags
                  (i32.or (i32.load offset=8 (local.get $state_w)) (i32.const 0x02)))))
            (i32.store offset=8 (local.get $state_w) (local.get $flags))
            ;; BS_OWNERDRAW: dispatch WM_DRAWITEM to repaint the unpressed
            ;; face. Other kinds use button_wndproc's WM_PAINT.
            (if (i32.eq (local.get $w) (i32.const 0x0B))
              (then (call $btn_send_drawitem (local.get $hwnd) (local.get $state_w) (local.get $flags)))
              (else
                (drop (call $wnd_send_message
                  (local.get $hwnd) (i32.const 0x000F) (i32.const 0) (i32.const 0)))))
            ;; Send WM_COMMAND(MAKEWPARAM(ctrl_id, BN_CLICKED=0), button_hwnd)
            ;; to parent. Native BUTTON controls notify parents synchronously;
            ;; dialog procs often update caller-owned structs before the click
            ;; returns. Skip groupbox (kind 7) — it's not interactive.
            (if (i32.ne (local.get $w) (i32.const 7))
              (then
                (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
                (local.set $cmd_id (i32.and (i32.load offset=12 (local.get $state_w)) (i32.const 0xFFFF)))
                (global.set $dialog_last_proc_handled (i32.const 0))
                (drop (call $wnd_send_message
                  (local.get $parent)
                  (i32.const 0x0111)  ;; WM_COMMAND
                  ;; wParam: low 16 = ctrl_id (from ButtonState+12), high 16 = BN_CLICKED (0)
                  (local.get $cmd_id)
                  (local.get $hwnd))) ;; lParam = button hwnd
                ;; USER's default IDOK close applies only when the dialog proc
                ;; did not handle the command itself. A handled command may
                ;; intentionally post follow-up work while keeping the dialog.
                (if (i32.and
                      (i32.eq (local.get $cmd_id) (i32.const 1))
                      (i32.eqz (global.get $dialog_last_proc_handled)))
                  (then (call $dialog_default_idok_close (local.get $parent))))))
            ))
        (return (i32.const 0))))

    ;; ---------- WM_PAINT (0x000F) ----------
    ;; Compose a Win98 button face from GDI primitives. hdc encoding matches
    ;; BeginPaint: hwnd + 0x40000. Dispatches by BS_* kind (style & 0x0F):
    ;;   0,1     = push button / default push button
    ;;   2,3,5,6 = checkbox-style (small box + check + label)
    ;;   4,9     = radio-style (small circle + dot + label)
    ;;   7       = groupbox (etched border + label notch)
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        ;; A real BUTTON window proc paints inside BeginPaint/EndPaint, which
        ;; validates the update region. Our WAT-native painter draws directly
        ;; through host GDI primitives, so clear the pending region here or a
        ;; pressed button can keep the message pump returning child WM_PAINT.
        (call $update_clear_hwnd (local.get $hwnd))
        (call $paint_flag_clear_hwnd (local.get $hwnd))
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $flags (i32.load offset=8 (local.get $state_w)))
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        ;; Native controls paint with a fresh BeginPaint DC. Our synthetic
        ;; hwnd+0x40000 DC can retain a clip region from a previous draw,
        ;; which clipped Spider's MessageBox "No" button top edge.
        (drop (call $host_gdi_select_clip_rgn (local.get $hdc) (i32.const 0)))
        ;; ctrl_get_wh_packed reads CONTROL_GEOM (works for WAT-only children
        ;; that have no JS-side window record).
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        (local.set $kind (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x0F)))

        ;; Common DC setup: select DEFAULT_GUI_FONT and switch to TRANSPARENT
        ;; bk mode so text glyphs don't get an opaque white background box.
        (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))
        (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))
        (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x00000000)))
        (if (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x08000000))
          (then
            (drop (call $host_gdi_set_text_color
              (local.get $hdc) (i32.const 0x00808080)))))

        ;; Resolve text pointer/length once (used by every kind that has a label).
        (if (i32.load (local.get $state_w))
          (then
            (local.set $text_w (call $g2w (i32.load (local.get $state_w))))
            (local.set $text_len (i32.load offset=4 (local.get $state_w)))))

        ;; ---- Bitmap button (BS_BITMAP 0x80) ----
        ;; Funtris uses BM_SETIMAGE on BS_BITMAP|BS_AUTOCHECKBOX controls for
        ;; the nine brick previews. Draw the stored HBITMAP centered in the
        ;; control before considering the low-nibble button kind.
        (if (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x0080))
          (then
            (local.set $img (i32.load offset=68 (local.get $state_w)))
            (if (local.get $img)
              (then
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 0) (i32.const 0)
                        (local.get $w) (local.get $h)
                        (i32.const 0x30011)))
                (local.set $img_w (call $host_gdi_get_object_w (local.get $img)))
                (local.set $img_h (call $host_gdi_get_object_h (local.get $img)))
                (if (i32.gt_s (local.get $img_w) (i32.const 0))
                  (then
                    (if (i32.gt_s (local.get $img_h) (i32.const 0))
                      (then
                        (local.set $img_x
                          (i32.div_s (i32.sub (local.get $w) (local.get $img_w)) (i32.const 2)))
                        (local.set $img_y
                          (i32.div_s (i32.sub (local.get $h) (local.get $img_h)) (i32.const 2)))
                        (if (i32.lt_s (local.get $img_x) (i32.const 0))
                          (then (local.set $img_x (i32.const 0))))
                        (if (i32.lt_s (local.get $img_y) (i32.const 0))
                          (then (local.set $img_y (i32.const 0))))
                        (local.set $brush (call $host_gdi_create_compat_dc (local.get $hdc)))
                        (drop (call $host_gdi_select_object (local.get $brush) (local.get $img)))
                        (drop (call $host_gdi_bitblt
                                (local.get $hdc)
                                (local.get $img_x) (local.get $img_y)
                                (local.get $img_w) (local.get $img_h)
                                (local.get $brush)
                                (i32.const 0) (i32.const 0)
                                (i32.const 0x00CC0020))) ;; SRCCOPY
                        (drop (call $host_gdi_delete_dc (local.get $brush)))))))
                (if (i32.and (local.get $flags) (i32.const 0x08))
                  (then
                    (drop (call $host_gdi_draw_focus_rect (local.get $hdc)
                            (i32.const 2) (i32.const 2)
                            (i32.sub (local.get $w) (i32.const 2))
                            (i32.sub (local.get $h) (i32.const 2))))))
                (return (i32.const 0))))))

        ;; ---- Push button (kinds 0, 1) ----
        (if (i32.lt_u (local.get $kind) (i32.const 2))
          (then
            ;; If currently the default (bit2), draw a 1px black border
            ;; around the outer edge and inset the bevel by 1 px.
            (local.set $box_y (i32.and (local.get $flags) (i32.const 0x04))) ;; reuse $box_y as "is default"
            (if (local.get $box_y)
              (then
                ;; 1px black frame via 4 fill_rect strokes (BLACK_BRUSH=0x30014).
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 0) (i32.const 0)
                        (local.get $w) (i32.const 1) (i32.const 0x30014)))
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 0) (i32.sub (local.get $h) (i32.const 1))
                        (local.get $w) (local.get $h) (i32.const 0x30014)))
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 0) (i32.const 0)
                        (i32.const 1) (local.get $h) (i32.const 0x30014)))
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.sub (local.get $w) (i32.const 1)) (i32.const 0)
                        (local.get $w) (local.get $h) (i32.const 0x30014)))))
            ;; Fill face with LTGRAY_BRUSH (stock object 1 = 0x30011)
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (select (i32.const 1) (i32.const 0) (local.get $box_y))
                    (select (i32.const 1) (i32.const 0) (local.get $box_y))
                    (select (i32.sub (local.get $w) (i32.const 1)) (local.get $w) (local.get $box_y))
                    (select (i32.sub (local.get $h) (i32.const 1)) (local.get $h) (local.get $box_y))
                    (i32.const 0x30011)))
            ;; Bevel: BF_RECT(0x0F) | BDR_RAISEDOUTER(0x01)|BDR_RAISEDINNER(0x04) = 0x05
            ;;        or pressed: BDR_SUNKENOUTER(0x02)|BDR_SUNKENINNER(0x08) = 0x0A
            (local.set $edge_flags (select (i32.const 0x0A) (i32.const 0x05)
                                           (i32.and (local.get $flags) (i32.const 0x01))))
            (drop (call $host_gdi_draw_edge (local.get $hdc)
                    (select (i32.const 1) (i32.const 0) (local.get $box_y))
                    (select (i32.const 1) (i32.const 0) (local.get $box_y))
                    (select (i32.sub (local.get $w) (i32.const 1)) (local.get $w) (local.get $box_y))
                    (select (i32.sub (local.get $h) (i32.const 1)) (local.get $h) (local.get $box_y))
                    (local.get $edge_flags) (i32.const 0x0F)))
            (if (local.get $text_w)
              (then
                (i32.store           (global.get $PAINT_SCRATCH) (i32.const 0))
                (i32.store offset=4  (global.get $PAINT_SCRATCH) (i32.const 0))
                (i32.store offset=8  (global.get $PAINT_SCRATCH) (local.get $w))
                (i32.store offset=12 (global.get $PAINT_SCRATCH) (local.get $h))
                ;; DT_CENTER(0x01)|DT_VCENTER(0x04)|DT_SINGLELINE(0x20) = 0x25
                (drop (call $host_gdi_draw_text (local.get $hdc)
                        (local.get $text_w) (local.get $text_len)
                        (global.get $PAINT_SCRATCH)
                        (i32.const 0x25) (i32.const 0)))))
            ;; Focus rect (bit3): inset 4px from outer edge.
            (if (i32.and (local.get $flags) (i32.const 0x08))
              (then
                (drop (call $host_gdi_draw_focus_rect (local.get $hdc)
                        (i32.const 4) (i32.const 4)
                        (i32.sub (local.get $w) (i32.const 4))
                        (i32.sub (local.get $h) (i32.const 4))))))
            (return (i32.const 0))))

        ;; ---- Checkbox-style (kinds 2, 3, 5, 6) ----
        ;; 12x12 sunken white box, optional check glyph, label to the right.
        (if (i32.or
              (i32.or (i32.eq (local.get $kind) (i32.const 2))
                      (i32.eq (local.get $kind) (i32.const 3)))
              (i32.or (i32.eq (local.get $kind) (i32.const 5))
                      (i32.eq (local.get $kind) (i32.const 6))))
          (then
            ;; Background — face color so a re-paint doesn't leave stale pixels
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
                    (i32.const 0x30011)))
            ;; One 13x13 check box, shared with the list-view state images.
            (local.set $box_y (i32.div_u (i32.sub (local.get $h) (i32.const 13)) (i32.const 2)))
            (call $paint_check_box (local.get $hdc)
              (i32.const 0) (local.get $box_y)
              (i32.and (local.get $flags) (i32.const 0x02)))  ;; flags bit 1 = checked
            (if (local.get $text_w)
              (then
                (i32.store           (global.get $PAINT_SCRATCH) (i32.const 16))
                (i32.store offset=4  (global.get $PAINT_SCRATCH) (i32.const 0))
                (i32.store offset=8  (global.get $PAINT_SCRATCH) (local.get $w))
                (i32.store offset=12 (global.get $PAINT_SCRATCH) (local.get $h))
                ;; DT_VCENTER(0x04)|DT_SINGLELINE(0x20) = 0x24
                (drop (call $host_gdi_draw_text (local.get $hdc)
                        (local.get $text_w) (local.get $text_len)
                        (global.get $PAINT_SCRATCH)
                        (i32.const 0x24) (i32.const 0)))))
            ;; Focus rect (bit3) around the label.
            (if (i32.and (local.get $flags) (i32.const 0x08))
              (then
                (drop (call $host_gdi_draw_focus_rect (local.get $hdc)
                        (i32.const 14) (i32.const 1)
                        (i32.sub (local.get $w) (i32.const 1))
                        (i32.sub (local.get $h) (i32.const 1))))))
            (return (i32.const 0))))

        ;; ---- Radio-style (kinds 4, 9) ----
        (if (i32.or (i32.eq (local.get $kind) (i32.const 4))
                    (i32.eq (local.get $kind) (i32.const 9)))
          (then
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
                    (i32.const 0x30011)))
            (local.set $box_y (i32.sub (i32.div_u (local.get $h) (i32.const 2)) (i32.const 6)))
            ;; Outline circle: BLACK_PEN + WHITE_BRUSH
            (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30017)))
            (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30010)))
            (drop (call $host_gdi_ellipse (local.get $hdc)
                    (i32.const 0) (local.get $box_y)
                    (i32.const 12) (i32.add (local.get $box_y) (i32.const 12))))
            (if (i32.and (local.get $flags) (i32.const 0x02))
              (then
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 4) (i32.add (local.get $box_y) (i32.const 4))
                        (i32.const 8) (i32.add (local.get $box_y) (i32.const 8))
                        (i32.const 0x30014)))))
            (if (local.get $text_w)
              (then
                (i32.store           (global.get $PAINT_SCRATCH) (i32.const 16))
                (i32.store offset=4  (global.get $PAINT_SCRATCH) (i32.const 0))
                (i32.store offset=8  (global.get $PAINT_SCRATCH) (local.get $w))
                (i32.store offset=12 (global.get $PAINT_SCRATCH) (local.get $h))
                (drop (call $host_gdi_draw_text (local.get $hdc)
                        (local.get $text_w) (local.get $text_len)
                        (global.get $PAINT_SCRATCH)
                        (i32.const 0x24) (i32.const 0)))))
            ;; Focus rect (bit3) around the label.
            (if (i32.and (local.get $flags) (i32.const 0x08))
              (then
                (drop (call $host_gdi_draw_focus_rect (local.get $hdc)
                        (i32.const 14) (i32.const 1)
                        (i32.sub (local.get $w) (i32.const 1))
                        (i32.sub (local.get $h) (i32.const 1))))))
            (return (i32.const 0))))

        ;; ---- Groupbox (kind 7) ----
        ;; Etched rectangle with a label notched into the top stroke. The label
        ;; width is measured via DT_CALCRECT so we know how wide a hole to clear.
        ;; Do NOT fill the interior — the dialog face is already painted by
        ;; $dlg_fill_bkgnd (WM_ERASEBKGND), and an interior fill here would
        ;; overpaint any siblings created before the groupbox in the template
        ;; (pinball's Player Controls lists groupboxes last; an inner fill
        ;; erases its static labels and combos).
        (if (i32.eq (local.get $kind) (i32.const 7))
          (then
            ;; EDGE_ETCHED = 0x06 (BDR_SUNKENOUTER|BDR_RAISEDINNER), BF_RECT = 0x0F.
            ;; Top edge sits at y=6 so the label can overlap it.
            (drop (call $host_gdi_draw_edge (local.get $hdc)
                    (i32.const 0) (i32.const 6) (local.get $w) (local.get $h)
                    (i32.const 0x06) (i32.const 0x0F)))
            (if (local.get $text_w)
              (then
                ;; Measure with DT_CALCRECT(0x400) | DT_SINGLELINE(0x20) = 0x420
                (i32.store           (global.get $PAINT_SCRATCH) (i32.const 12))
                (i32.store offset=4  (global.get $PAINT_SCRATCH) (i32.const 0))
                (i32.store offset=8  (global.get $PAINT_SCRATCH) (local.get $w))
                (i32.store offset=12 (global.get $PAINT_SCRATCH) (i32.const 13))
                (drop (call $host_gdi_draw_text (local.get $hdc)
                        (local.get $text_w) (local.get $text_len)
                        (global.get $PAINT_SCRATCH)
                        (i32.const 0x420) (i32.const 0)))
                (local.set $tw (i32.sub
                                 (i32.load offset=8 (global.get $PAINT_SCRATCH))
                                 (i32.const 12)))
                ;; Clear the slot under the label so the etched stroke is hidden
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 8) (i32.const 0)
                        (i32.add (i32.const 16) (local.get $tw)) (i32.const 13)
                        (i32.const 0x30011)))
                ;; Real draw at left=12, y=0..13
                (i32.store           (global.get $PAINT_SCRATCH) (i32.const 12))
                (i32.store offset=4  (global.get $PAINT_SCRATCH) (i32.const 0))
                (i32.store offset=8  (global.get $PAINT_SCRATCH) (local.get $w))
                (i32.store offset=12 (global.get $PAINT_SCRATCH) (i32.const 13))
                (drop (call $host_gdi_draw_text (local.get $hdc)
                        (local.get $text_w) (local.get $text_len)
                        (global.get $PAINT_SCRATCH)
                        (i32.const 0x20) (i32.const 0)))))
            (return (i32.const 0))))

        ;; ---- Owner-draw (kind 0x0B = BS_OWNERDRAW) ----
        ;; Post WM_DRAWITEM to parent so the x86 dialog proc can paint.
        ;; DRAWITEMSTRUCT (48 bytes) is embedded at ButtonState+16.
        (if (i32.eq (local.get $kind) (i32.const 0x0B))
          (then
            ;; Owner-draw controls must repaint on every WM_PAINT. Unlike
            ;; real Win32 child windows, our children share the top-level
            ;; back-canvas, so a later parent erase can wipe their pixels.
            (if (i32.ge_u (global.get $post_queue_count) (i32.const 64))
              (then (return (i32.const 0))))
            ;; Fill DRAWITEMSTRUCT at ButtonState+16
            ;; Reuse $edge_flags as WASM address of the struct
            (local.set $edge_flags (call $g2w (i32.add (local.get $state) (i32.const 16))))
            (i32.store         (local.get $edge_flags) (i32.const 4))  ;; CtlType = ODT_BUTTON
            (i32.store offset=4  (local.get $edge_flags)
              (i32.load offset=12 (local.get $state_w)))               ;; CtlID
            (i32.store offset=8  (local.get $edge_flags) (i32.const 0)) ;; itemID
            (i32.store offset=12 (local.get $edge_flags) (i32.const 1)) ;; itemAction = ODA_DRAWENTIRE
            (i32.store offset=16 (local.get $edge_flags)
              (select (i32.const 1) (i32.const 0)
                      (i32.and (local.get $flags) (i32.const 0x01))))   ;; itemState
            (i32.store offset=20 (local.get $edge_flags) (local.get $hwnd)) ;; hwndItem
            (i32.store offset=24 (local.get $edge_flags)
              (i32.add (local.get $hwnd) (i32.const 0x40000)))          ;; hDC
            (i32.store offset=28 (local.get $edge_flags) (i32.const 0)) ;; rcItem.left
            (i32.store offset=32 (local.get $edge_flags) (i32.const 0)) ;; rcItem.top
            (i32.store offset=36 (local.get $edge_flags) (local.get $w)) ;; rcItem.right
            (i32.store offset=40 (local.get $edge_flags) (local.get $h)) ;; rcItem.bottom
            (i32.store offset=44 (local.get $edge_flags) (i32.const 0)) ;; itemData
            ;; Clear stale transparent text before delegating to the owner.
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.const 0) (i32.const 0)
                    (local.get $w) (local.get $h)
                    (i32.const 0x30011)))
            ;; Post WM_DRAWITEM (0x002B) to parent
            (drop (call $wnd_send_message
              (call $wnd_get_parent (local.get $hwnd))
              (i32.const 0x002B)
              (i32.load offset=12 (local.get $state_w))
              (i32.add (local.get $state) (i32.const 16))))
            ;; This WM_PAINT was handled by delegating WM_DRAWITEM to the
            ;; owner. Keep validation in WAT so owner-draw buttons do not
            ;; re-enter the paint pump without a fresh invalidation.
            (call $update_clear_hwnd (local.get $hwnd))
            (call $paint_flag_clear_hwnd (local.get $hwnd))
            (return (i32.const 0))))

        (return (i32.const 0))))

    ;; ---------- BM_GETCHECK (0x00F0) ----------
    ;; Prefer ButtonState.flags bit 1 (checked); fall back to legacy CONTROL_TABLE.
    (if (i32.eq (local.get $msg) (i32.const 0x00F0))
      (then
        (if (local.get $state)
          (then (return (i32.and (i32.shr_u
                                   (i32.load offset=8 (call $g2w (local.get $state)))
                                   (i32.const 1))
                                 (i32.const 1)))))
        (return (call $ctrl_get_check_state (local.get $hwnd)))))

    ;; ---------- BM_SETCHECK (0x00F1) ----------
    ;; For BS_AUTORADIOBUTTON (kind 9) with wParam=1, enforce radio mutex
    ;; by clearing sibling autoradios first — arrow-key navigation in
    ;; renderer-input.js posts BM_SETCHECK directly without going through
    ;; the click path, so without this two radios end up "checked".
    (if (i32.eq (local.get $msg) (i32.const 0x00F1))
      (then
        (if (i32.and
              (i32.ne (local.get $wParam) (i32.const 0))
              (i32.eq (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x0F))
                      (i32.const 9)))
          (then (call $autoradio_clear_siblings (local.get $hwnd))))
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            (local.set $flags (i32.load offset=8 (local.get $state_w)))
            (local.set $flags (i32.and (local.get $flags) (i32.const 0xFFFFFFFD))) ;; clear checked
            (if (local.get $wParam)
              (then (local.set $flags (i32.or (local.get $flags) (i32.const 0x02)))))
            (i32.store offset=8 (local.get $state_w) (local.get $flags))
            (call $invalidate_hwnd (local.get $hwnd))
            (drop (call $wnd_send_message
              (local.get $hwnd) (i32.const 0x000F) (i32.const 0) (i32.const 0)))
            (return (i32.const 0))))
        (call $ctrl_set_check_state (local.get $hwnd) (local.get $wParam))
        (return (i32.const 0))))

    ;; ---------- BM_SETIMAGE (0x00F7) ----------
    ;; wParam=image type (IMAGE_BITMAP=0), lParam=image handle. Return previous.
    (if (i32.eq (local.get $msg) (i32.const 0x00F7))
      (then
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            (local.set $img (i32.load offset=68 (local.get $state_w)))
            (if (i32.eq (local.get $wParam) (i32.const 0))
              (then
                (i32.store offset=64 (local.get $state_w) (local.get $wParam))
                (i32.store offset=68 (local.get $state_w) (local.get $lParam))
                (call $invalidate_hwnd (local.get $hwnd))))
            (return (local.get $img))))
        (return (i32.const 0))))

    ;; ---------- BM_GETIMAGE (0x00F6) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x00F6))
      (then
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            (if (i32.eq (local.get $wParam) (i32.load offset=64 (local.get $state_w)))
              (then (return (i32.load offset=68 (local.get $state_w)))))))
        (return (i32.const 0))))

    ;; Default: return 0
    (i32.const 0)
  )

  ;; ---- Static WndProc ----
  ;;
  ;; Paint-only control. No input handling. Same dormancy caveat as
  ;; $button_wndproc — runs when STEP 5 wires WAT dialog creation.

  (func $static_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $state i32) (local $state_w i32) (local $cs_w i32)
    (local $hdc i32) (local $sz i32) (local $w i32) (local $h i32)
    (local $name_ptr i32) (local $text_len i32) (local $style i32)
    (local $fmt i32) (local $ex i32) (local $tx_l i32) (local $tx_t i32)
    (local $tx_r i32) (local $tx_b i32) (local $brush i32) (local $ctrl_id i32)
    (local $origin_clip i32)

    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))

    ;; ---------- WM_SETFOCUS (0x0007) / WM_KILLFOCUS (0x0008) ----------
    ;; Statics aren't tabstops, but if focus lands here (e.g. an app calls
    ;; SetFocus on a label) keep the global $focus_hwnd consistent.
    (if (i32.eq (local.get $msg) (i32.const 0x0007))
      (then (global.set $focus_hwnd (local.get $hwnd)) (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0008))
      (then
        (if (i32.eq (global.get $focus_hwnd) (local.get $hwnd))
          (then (global.set $focus_hwnd (i32.const 0))))
        (return (i32.const 0))))

    ;; ---------- WM_CREATE (0x0001) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0001))
      (then
        (local.set $cs_w (call $g2w (local.get $lParam)))
        (local.set $name_ptr (i32.load offset=36 (local.get $cs_w)))
        (local.set $style    (i32.load offset=32 (local.get $cs_w)))
        (local.set $state (call $heap_alloc (i32.const 16)))
        (local.set $state_w (call $g2w (local.get $state)))
        (i32.store        (local.get $state_w) (i32.const 0)) ;; text_buf_ptr
        (i32.store offset=4  (local.get $state_w) (i32.const 0)) ;; text_len
        (i32.store offset=8  (local.get $state_w) (local.get $style))
        (i32.store offset=12 (local.get $state_w) (i32.const 0))
        (if (local.get $name_ptr)
          (then
            (if (i32.lt_u (local.get $name_ptr) (i32.const 0x10000))
              (then
                (i32.store offset=12 (local.get $state_w) (local.get $name_ptr)))
              (else
                (local.set $text_len (call $strlen (call $g2w (local.get $name_ptr))))
                (i32.store        (local.get $state_w) (call $ctrl_text_dup (local.get $name_ptr) (local.get $text_len)))
                (i32.store offset=4 (local.get $state_w) (local.get $text_len))))))
        (call $wnd_set_state_ptr (local.get $hwnd) (local.get $state))
        (return (i32.const 0))))

    ;; ---------- WM_DESTROY ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0002))
      (then
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            (call $heap_free (i32.load (local.get $state_w)))
            (call $heap_free (local.get $state))
            (call $wnd_set_state_ptr (local.get $hwnd) (i32.const 0))))
        (return (i32.const 0))))

    ;; ---------- WM_SETTEXT ----------
    (if (i32.eq (local.get $msg) (i32.const 0x000C))
      (then
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            (call $heap_free (i32.load (local.get $state_w)))
            (i32.store       (local.get $state_w) (i32.const 0))
            (i32.store offset=4 (local.get $state_w) (i32.const 0))
            (if (local.get $lParam)
              (then
                (local.set $text_len (call $strlen (call $g2w (local.get $lParam))))
                (i32.store       (local.get $state_w) (call $ctrl_text_dup (local.get $lParam) (local.get $text_len)))
                (i32.store offset=4 (local.get $state_w) (local.get $text_len))))
            (if (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x10000000))
              (then (call $invalidate_hwnd (local.get $hwnd))))
            (return (i32.const 1))))
        (return (i32.const 0))))

    ;; ---------- WM_GETTEXT ----------
    (if (i32.eq (local.get $msg) (i32.const 0x000D))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (if (i32.eqz (local.get $wParam)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $text_len (i32.load offset=4 (local.get $state_w)))
        (if (i32.ge_u (local.get $text_len) (local.get $wParam))
          (then (local.set $text_len (i32.sub (local.get $wParam) (i32.const 1)))))
        (if (i32.load (local.get $state_w))
          (then (if (local.get $text_len)
                  (then (call $memcpy (call $g2w (local.get $lParam))
                                      (call $g2w (i32.load (local.get $state_w)))
                                      (local.get $text_len))))))
        (i32.store8 (i32.add (call $g2w (local.get $lParam)) (local.get $text_len)) (i32.const 0))
        (return (local.get $text_len))))

    ;; ---------- WM_GETTEXTLENGTH ----------
    (if (i32.eq (local.get $msg) (i32.const 0x000E))
      (then
        (if (local.get $state)
          (then (return (i32.load offset=4 (call $g2w (local.get $state))))))
        (return (i32.const 0))))

    ;; ---------- WM_PAINT ----------
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        ;; NSIS installer branding label. It is decorative, and with the
        ;; emulator's current font metrics it collides with the wizard
        ;; buttons; suppress it instead of painting unreadable overlap.
        (if (i32.eq (call $ctrl_table_get_id (local.get $hwnd)) (i32.const 1028))
          (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        ;; Geometry from CONTROL_GEOM (parent has already painted the
        ;; dialog face background via WM_ERASEBKGND, so no fill here).
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        (local.set $style (i32.and (i32.load offset=8 (local.get $state_w)) (i32.const 0x0F)))
        (local.set $ex (call $ctrl_get_ex_style (local.get $hwnd)))
        (local.set $ctrl_id (call $ctrl_table_get_id (local.get $hwnd)))
        ;; Default text rect = full client.
        (local.set $tx_l (i32.const 0))
        (local.set $tx_t (i32.const 0))
        (local.set $tx_r (local.get $w))
        (local.set $tx_b (local.get $h))
        ;; WS_EX_CLIENTEDGE (0x200): paint white interior + sunken edge
        ;; (calc's display "0." field + memory indicator both use this).
        ;; Inset the text rect so glyphs don't touch the sunken edge.
        ;; Calc's display is a right-aligned client-edge static; Win98
        ;; leaves a few pixels of inner padding there.
        (if (i32.and (local.get $ex) (i32.const 0x200))
          (then
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.const 0) (i32.const 0)
                    (local.get $w) (local.get $h)
                    (i32.const 0x30010)))  ;; WHITE_BRUSH
            (drop (call $host_gdi_draw_edge (local.get $hdc)
                    (i32.const 0) (i32.const 0)
                    (local.get $w) (local.get $h)
                    (i32.const 0x0A) (i32.const 0x0F)))  ;; EDGE_SUNKEN | BF_RECT
            (local.set $tx_l (i32.const 4))
            (local.set $tx_t (i32.const 1))
            (local.set $tx_r (i32.sub (local.get $w) (i32.const 4)))
            (local.set $tx_b (i32.sub (local.get $h) (i32.const 1))))
          (else
            ;; SS_BLACKRECT/SS_GRAYRECT/SS_WHITERECT paint their whole client
            ;; rect and do not render label text.
            (local.set $brush (i32.const 0))
            (if (i32.eq (local.get $style) (i32.const 4))
              (then (local.set $brush (i32.const 0x30014)))) ;; BLACK_BRUSH
            (if (i32.eq (local.get $style) (i32.const 5))
              (then (local.set $brush (i32.const 0x30012)))) ;; GRAY_BRUSH
            (if (i32.eq (local.get $style) (i32.const 6))
              (then (local.set $brush (i32.const 0x30010)))) ;; WHITE_BRUSH
            (if (local.get $brush)
              (then
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 0) (i32.const 0)
                        (local.get $w) (local.get $h)
                        (local.get $brush)))
                (return (i32.const 0))))
            ;; SS_BLACKFRAME/SS_GRAYFRAME/SS_WHITEFRAME paint a one-pixel
            ;; rectangle frame and do not render label text.
            (local.set $brush (i32.const 0))
            (if (i32.eq (local.get $style) (i32.const 7))
              (then (local.set $brush (i32.const 0x30014)))) ;; BLACK_BRUSH
            (if (i32.eq (local.get $style) (i32.const 8))
              (then (local.set $brush (i32.const 0x30012)))) ;; GRAY_BRUSH
            (if (i32.eq (local.get $style) (i32.const 9))
              (then (local.set $brush (i32.const 0x30010)))) ;; WHITE_BRUSH
            (if (local.get $brush)
              (then
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 0) (i32.const 0)
                        (local.get $w) (i32.const 1)
                        (local.get $brush)))
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 0) (i32.sub (local.get $h) (i32.const 1))
                        (local.get $w) (local.get $h)
                        (local.get $brush)))
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 0) (i32.const 0)
                        (i32.const 1) (local.get $h)
                        (local.get $brush)))
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.sub (local.get $w) (i32.const 1)) (i32.const 0)
                        (local.get $w) (local.get $h)
                        (local.get $brush)))
                (return (i32.const 0))))
            ;; Erase the static's rect for label types. Parent's WM_ERASEBKGND
            ;; ran once at create time, but subsequent SetWindowText invalidates
            ;; only the static — without this fill, new text composites on top of
            ;; the previous text (visible in calc's display as digit pile-up).
            (if (i32.or (i32.lt_u (local.get $style) (i32.const 4))
                        (i32.gt_u (local.get $style) (i32.const 9)))
              (then
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 0) (i32.const 0)
                        (local.get $w) (local.get $h)
                        (i32.const 0x30011)))))))  ;; LTGRAY_BRUSH ≈ COLOR_3DFACE (stock obj 1)
        ;; Select DEFAULT_GUI_FONT (8pt MS Sans Serif) for the dialog look.
        ;; TRANSPARENT bk mode so the label glyphs let the fill color show
        ;; through instead of painting an opaque white box behind every word.
        (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))
        (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))
        ;; SS_ICON dialog controls preserve their RT_GROUP_ICON ordinal in the
        ;; static state. Decode the color plane and transparency mask through
        ;; the canonical WAT raster path.
        (if (i32.and
              (i32.eq (local.get $style) (i32.const 3))
              (i32.ne (i32.load offset=12 (local.get $state_w)) (i32.const 0)))
          (then
            ;; Compact Win9x statics commonly clip a padded 32x32 icon DIB at
            ;; its origin; larger illustration controls use centered layout.
            (local.set $origin_clip
              (i32.and (i32.le_u (local.get $w) (i32.const 16))
                       (i32.le_u (local.get $h) (i32.const 16))))
            (if (call $gdi_icon_draw_resource
                  (local.get $hdc)
                  (i32.load offset=12 (local.get $state_w))
                  (local.get $w) (local.get $h)
                  (local.get $origin_clip))
              (then (return (i32.const 0))))))
        ;; A few mixer builds reference absent speaker resources 301/302.
        ;; Preserve the compact monochrome fallback for those missing icons.
        (if (i32.and
              (i32.eq (local.get $style) (i32.const 3))
              (i32.and
                (i32.and (i32.ge_u (local.get $w) (i32.const 10))
                         (i32.le_u (local.get $w) (i32.const 16)))
                (i32.and
                  (i32.and (i32.ge_u (local.get $h) (i32.const 10))
                           (i32.le_u (local.get $h) (i32.const 16)))
                  (i32.or
                    (i32.eq (i32.load offset=12 (local.get $state_w)) (i32.const 301))
                    (i32.eq (i32.load offset=12 (local.get $state_w)) (i32.const 302))))))
          (then
            (if (i32.eq (i32.load offset=12 (local.get $state_w)) (i32.const 301))
              (then
                ;; Left-facing speaker.
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 1) (i32.const 5) (i32.const 4) (i32.const 10)
                        (i32.const 0x30014)))
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 4) (i32.const 3) (i32.const 6) (i32.const 12)
                        (i32.const 0x30014)))
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 6) (i32.const 2) (i32.const 7) (i32.const 13)
                        (i32.const 0x30014)))
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 9) (i32.const 5) (i32.const 10) (i32.const 10)
                        (i32.const 0x30014))))
              (else
                ;; Mirrored right-facing speaker.
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 8) (i32.const 5) (i32.const 11) (i32.const 10)
                        (i32.const 0x30014)))
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 6) (i32.const 3) (i32.const 8) (i32.const 12)
                        (i32.const 0x30014)))
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 5) (i32.const 2) (i32.const 6) (i32.const 13)
                        (i32.const 0x30014)))
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 2) (i32.const 5) (i32.const 3) (i32.const 10)
                        (i32.const 0x30014)))))
            (return (i32.const 0))))
        ;; SS_ICON(3), SS_BITMAP(0x0E): skip text — these display images, not labels
        (if (i32.and
              (i32.ne (local.get $style) (i32.const 3))
              (i32.ne (local.get $style) (i32.const 0x0E)))
          (then
          (if (i32.load (local.get $state_w))
            (then
              ;; SS_LEFT(0)/SS_CENTER(1)/SS_RIGHT(2) use DT_WORDBREAK for multi-line.
              ;; Text statics also expand tabs; Paint's Attributes dialog uses
              ;; them to align the two "Not Available" values.
              ;; SS_SIMPLE(0x0B), SS_LEFTNOWORDWRAP(0x0C) use DT_SINGLELINE.
              (local.set $fmt (if (result i32) (i32.le_u (local.get $style) (i32.const 2))
                (then (i32.const 0x10))    ;; DT_WORDBREAK
                (else (i32.const 0x24))))  ;; DT_VCENTER|DT_SINGLELINE
              (if (i32.eq (local.get $style) (i32.const 1))
                (then (local.set $fmt (i32.or (local.get $fmt) (i32.const 0x01))))) ;; DT_CENTER
              (if (i32.eq (local.get $style) (i32.const 2))
                (then (local.set $fmt (i32.or (local.get $fmt) (i32.const 0x02))))) ;; DT_RIGHT
              (if (i32.and (local.get $ex) (i32.const 0x200))
                (then (local.set $fmt
                  (i32.or
                    (i32.and (local.get $fmt) (i32.const 0x03)) ;; keep horizontal alignment
                    (i32.const 0x24))))) ;; DT_VCENTER|DT_SINGLELINE
              (if (i32.or
                    (i32.le_u (local.get $style) (i32.const 2))
                    (i32.eq (local.get $style) (i32.const 0x0C)))
                (then (local.set $fmt
                  (i32.or (local.get $fmt) (i32.const 0x40))))) ;; DT_EXPANDTABS
              (i32.store        (global.get $PAINT_SCRATCH) (local.get $tx_l))
              (i32.store offset=4  (global.get $PAINT_SCRATCH) (local.get $tx_t))
              (i32.store offset=8  (global.get $PAINT_SCRATCH) (local.get $tx_r))
              (i32.store offset=12 (global.get $PAINT_SCRATCH) (local.get $tx_b))
              (drop (call $host_gdi_draw_text (local.get $hdc)
                      (call $g2w (i32.load (local.get $state_w)))
                      (i32.load offset=4 (local.get $state_w))
                      (global.get $PAINT_SCRATCH)
                      (local.get $fmt) (i32.const 0)))))))
        (return (i32.const 0))))

    ;; Default
    (i32.const 0)
  )

  ;; ---- SysLink WndProc ----
  ;;
  ;; SysLink understands a small markup subset: text outside <a ...>...</a>
  ;; paints as an ordinary label, the anchor run paints in the Win32 hyperlink
  ;; blue with an underline. DrawText cannot express two colors within one
  ;; wrapped paragraph, so the word-wrap loop lives here: measure each word,
  ;; break when it would overflow the client width, emit it with the colour the
  ;; current markup state calls for.
  ;;
  ;; A click falls through to the default: NM_CLICK exists so the owner can
  ;; hand a URL to ShellExecute, and there is no browser here to hand it to.
  (func $syslink_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $state i32) (local $state_w i32) (local $cs_w i32)
    (local $name_ptr i32) (local $text_len i32) (local $style i32)
    (local $hdc i32) (local $sz i32) (local $w i32) (local $h i32)
    (local $tw i32) (local $n i32) (local $i i32) (local $j i32)
    (local $c i32) (local $x i32) (local $y i32) (local $lh i32)
    (local $sp i32) (local $ww i32) (local $in_link i32) (local $brush i32)
    (local $closing i32)

    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))

    ;; ---------- WM_CREATE ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0001))
      (then
        (local.set $cs_w (call $g2w (local.get $lParam)))
        (local.set $name_ptr (i32.load offset=36 (local.get $cs_w)))
        (local.set $style    (i32.load offset=32 (local.get $cs_w)))
        (local.set $state (call $heap_alloc (i32.const 16)))
        (local.set $state_w (call $g2w (local.get $state)))
        (i32.store           (local.get $state_w) (i32.const 0))
        (i32.store offset=4  (local.get $state_w) (i32.const 0))
        (i32.store offset=8  (local.get $state_w) (local.get $style))
        (i32.store offset=12 (local.get $state_w) (i32.const 0))
        ;; A SysLink caption is always a real string; ordinal captions are a
        ;; static-only convention and would be a template authoring error here.
        (if (i32.gt_u (local.get $name_ptr) (i32.const 0xFFFF))
          (then
            (local.set $text_len (call $strlen (call $g2w (local.get $name_ptr))))
            (i32.store          (local.get $state_w) (call $ctrl_text_dup (local.get $name_ptr) (local.get $text_len)))
            (i32.store offset=4 (local.get $state_w) (local.get $text_len))))
        (call $wnd_set_state_ptr (local.get $hwnd) (local.get $state))
        (return (i32.const 0))))

    ;; ---------- WM_DESTROY ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0002))
      (then
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            (call $heap_free (i32.load (local.get $state_w)))
            (call $heap_free (local.get $state))
            (call $wnd_set_state_ptr (local.get $hwnd) (i32.const 0))))
        (return (i32.const 0))))

    ;; ---------- WM_SETTEXT ----------
    (if (i32.eq (local.get $msg) (i32.const 0x000C))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (call $heap_free (i32.load (local.get $state_w)))
        (i32.store          (local.get $state_w) (i32.const 0))
        (i32.store offset=4 (local.get $state_w) (i32.const 0))
        (if (local.get $lParam)
          (then
            (local.set $text_len (call $strlen (call $g2w (local.get $lParam))))
            (i32.store          (local.get $state_w) (call $ctrl_text_dup (local.get $lParam) (local.get $text_len)))
            (i32.store offset=4 (local.get $state_w) (local.get $text_len))))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 1))))

    ;; ---------- WM_GETTEXTLENGTH ----------
    (if (i32.eq (local.get $msg) (i32.const 0x000E))
      (then
        (if (local.get $state)
          (then (return (i32.load offset=4 (call $g2w (local.get $state))))))
        (return (i32.const 0))))

    ;; ---------- WM_GETTEXT ----------
    (if (i32.eq (local.get $msg) (i32.const 0x000D))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (if (i32.eqz (local.get $wParam)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $text_len (i32.load offset=4 (local.get $state_w)))
        (if (i32.ge_u (local.get $text_len) (local.get $wParam))
          (then (local.set $text_len (i32.sub (local.get $wParam) (i32.const 1)))))
        (if (i32.and (i32.load (local.get $state_w)) (i32.ne (local.get $text_len) (i32.const 0)))
          (then (call $memcpy (call $g2w (local.get $lParam))
                              (call $g2w (i32.load (local.get $state_w)))
                              (local.get $text_len))))
        (i32.store8 (i32.add (call $g2w (local.get $lParam)) (local.get $text_len)) (i32.const 0))
        (return (local.get $text_len))))

    ;; ---------- WM_PAINT ----------
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (if (i32.eqz (i32.load (local.get $state_w))) (then (return (i32.const 0))))
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        (drop (call $host_gdi_fill_rect (local.get $hdc)
                (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
                (i32.const 0x30011)))  ;; LTGRAY_BRUSH ≈ COLOR_3DFACE
        (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))
        (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))
        (local.set $lh (i32.and (call $host_get_text_metrics (local.get $hdc)) (i32.const 0xFFFF)))
        (if (i32.eqz (local.get $lh)) (then (local.set $lh (i32.const 13))))
        (local.set $sp (call $host_measure_text (local.get $hdc) (i32.const 0x11E48) (i32.const 1) (i32.const 0)))
        (local.set $tw (call $g2w (i32.load (local.get $state_w))))
        (local.set $n (i32.load offset=4 (local.get $state_w)))
        (local.set $i (i32.const 0))
        (local.set $x (i32.const 0))
        (local.set $y (i32.const 0))
        (local.set $in_link (i32.const 0))
        (block $done (loop $word
          (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
          (local.set $c (i32.load8_u (i32.add (local.get $tw) (local.get $i))))
          ;; Whitespace: one space of advance, collapsed like HTML.
          (if (i32.or (i32.eq (local.get $c) (i32.const 32))
                      (i32.or (i32.eq (local.get $c) (i32.const 9))
                              (i32.or (i32.eq (local.get $c) (i32.const 13))
                                      (i32.eq (local.get $c) (i32.const 10)))))
            (then
              (if (local.get $x) (then (local.set $x (i32.add (local.get $x) (local.get $sp)))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $word)))
          ;; Markup tag: <a ...> opens a link run, </a> closes it. Anything
          ;; else in angle brackets is skipped the same way.
          (if (i32.eq (local.get $c) (i32.const 60))
            (then
              (local.set $j (i32.add (local.get $i) (i32.const 1)))
              (local.set $closing
                (i32.eq (i32.load8_u (i32.add (local.get $tw) (local.get $j))) (i32.const 47)))
              (block $tagend (loop $tagscan
                (br_if $tagend (i32.ge_u (local.get $j) (local.get $n)))
                (br_if $tagend (i32.eq (i32.load8_u (i32.add (local.get $tw) (local.get $j)))
                                       (i32.const 62)))
                (local.set $j (i32.add (local.get $j) (i32.const 1)))
                (br $tagscan)))
              (local.set $in_link (i32.eqz (local.get $closing)))
              (local.set $i (i32.add (local.get $j) (i32.const 1)))
              (br $word)))
          ;; Word: runs to the next space or tag.
          (local.set $j (local.get $i))
          (block $wend (loop $wscan
            (br_if $wend (i32.ge_u (local.get $j) (local.get $n)))
            (local.set $c (i32.load8_u (i32.add (local.get $tw) (local.get $j))))
            (br_if $wend (i32.eq (local.get $c) (i32.const 32)))
            (br_if $wend (i32.eq (local.get $c) (i32.const 9)))
            (br_if $wend (i32.eq (local.get $c) (i32.const 13)))
            (br_if $wend (i32.eq (local.get $c) (i32.const 10)))
            (br_if $wend (i32.eq (local.get $c) (i32.const 60)))
            (local.set $j (i32.add (local.get $j) (i32.const 1)))
            (br $wscan)))
          (local.set $ww (call $host_measure_text (local.get $hdc)
                           (i32.add (local.get $tw) (local.get $i))
                           (i32.sub (local.get $j) (local.get $i))
                           (i32.const 0)))
          (if (i32.and (i32.gt_u (i32.add (local.get $x) (local.get $ww)) (local.get $w))
                       (i32.ne (local.get $x) (i32.const 0)))
            (then
              (local.set $x (i32.const 0))
              (local.set $y (i32.add (local.get $y) (local.get $lh)))))
          (br_if $done (i32.gt_u (i32.add (local.get $y) (local.get $lh)) (local.get $h)))
          (drop (call $host_gdi_set_text_color (local.get $hdc)
                  (select (i32.const 0x00CC6600) (i32.const 0x00000000) (local.get $in_link))))
          (drop (call $host_gdi_text_out (local.get $hdc)
                  (local.get $x) (local.get $y)
                  (i32.add (local.get $tw) (local.get $i))
                  (i32.sub (local.get $j) (local.get $i))
                  (i32.const 0)))
          (if (local.get $in_link)
            (then
              (local.set $brush (call $host_gdi_create_solid_brush (i32.const 0x00CC6600)))
              (drop (call $host_gdi_fill_rect (local.get $hdc)
                      (local.get $x) (i32.sub (i32.add (local.get $y) (local.get $lh)) (i32.const 2))
                      (i32.add (local.get $x) (local.get $ww))
                      (i32.sub (i32.add (local.get $y) (local.get $lh)) (i32.const 1))
                      (local.get $brush)))
              (drop (call $host_gdi_delete_object (local.get $brush)))))
          (local.set $x (i32.add (local.get $x) (local.get $ww)))
          (local.set $i (local.get $j))
          (br $word)))
        (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x00000000)))
        (return (i32.const 0))))

    (i32.const 0)
  )

  ;; ---- StatusBar WndProc ----
  ;;
  ;; Paint a compact Win9x status line into the shared top-level surface.
  ;; Leaving this class as a no-op exposed pixels from the MDI view's initial
  ;; full-height horizontal scrollbar after Paint docked the view above the
  ;; status bar.  The title table is the authoritative text store because MFC
  ;; updates its prompt with SetWindowTextA.

  ;; Paint's MFC status bar is distinguishable without inspecting its title:
  ;; ID 0xE801 is accompanied by the 0xE900 scroll view in the same frame.
  ;; Other applications keep the generic one-pane common-control rendering.
  (func $statusbar_is_paint (param $hwnd i32) (result i32)
    (local $parent i32)
    (if (i32.ne (call $ctrl_table_get_id (local.get $hwnd)) (i32.const 0xE801))
      (then (return (i32.const 0))))
    (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
    (i32.ne (call $ctrl_find_by_id (local.get $parent) (i32.const 0xE900)) (i32.const 0)))

  ;; Write an unsigned decimal value into WAT memory and return its length.
  ;; Paint coordinates are clamped before this helper is called.
  (func $statusbar_write_uint (param $dst i32) (param $value i32) (result i32)
    (local $digits i32) (local $remaining i32) (local $i i32)
    (local.set $remaining (local.get $value))
    (local.set $digits (i32.const 1))
    (block $count_done
      (loop $count
        (br_if $count_done (i32.lt_u (local.get $remaining) (i32.const 10)))
        (local.set $remaining (i32.div_u (local.get $remaining) (i32.const 10)))
        (local.set $digits (i32.add (local.get $digits) (i32.const 1)))
        (br $count)))
    (local.set $remaining (local.get $value))
    (local.set $i (local.get $digits))
    (block $write_done
      (loop $write
        (local.set $i (i32.sub (local.get $i) (i32.const 1)))
        (i32.store8
          (i32.add (local.get $dst) (local.get $i))
          (i32.add (i32.rem_u (local.get $remaining) (i32.const 10)) (i32.const 48)))
        (local.set $remaining (i32.div_u (local.get $remaining) (i32.const 10)))
        (br_if $write_done (i32.eqz (local.get $i)))
        (br $write)))
    (local.get $digits))

  ;; Win98's sizing grip is a right triangle of diagonal ribs in the bar's
  ;; bottom-right corner. Counting back from the corner as dx/dy, a pixel is
  ;; part of the grip while dx + dy <= 11, and its color cycles on
  ;; (dx + dy) mod 4: 3 is 3DHILIGHT, 2 and 1 are 3DSHADOW, 0 is bare face.
  ;; That produces three ribs of one highlight and two shadow pixels, spaced
  ;; four apart, each running from the bottom edge up to the right edge.
  ;;
  ;; Measured off real Windows 98 under v86 with
  ;; `node tools/png-crop.js <shot> --probe=X,Y,W,H`. The previous six-mark
  ;; staircase used DKGRAY_BRUSH (#404040), a color the Win98 grip never
  ;; contains, and covered about a third of the area.
  (func $statusbar_draw_size_grip (param $hdc i32) (param $w i32) (param $h i32)
    (local $dx i32) (local $dy i32) (local $step i32) (local $brush i32)
    (local $x i32) (local $y i32)
    (local.set $dy (i32.const 0))
    (block $rows_done
      (loop $rows
        (br_if $rows_done (i32.gt_u (local.get $dy) (i32.const 11)))
        (local.set $dx (i32.const 0))
        (block $cols_done
          (loop $cols
            (br_if $cols_done (i32.gt_u
              (i32.add (local.get $dx) (local.get $dy)) (i32.const 11)))
            (local.set $step
              (i32.rem_u (i32.add (local.get $dx) (local.get $dy)) (i32.const 4)))
            (local.set $brush (i32.const 0))
            (if (i32.eq (local.get $step) (i32.const 3))
              (then (local.set $brush (i32.const 0x30010))))  ;; WHITE_BRUSH
            (if (i32.or (i32.eq (local.get $step) (i32.const 1))
                        (i32.eq (local.get $step) (i32.const 2)))
              (then (local.set $brush (i32.const 0x30012))))  ;; GRAY_BRUSH
            (if (local.get $brush)
              (then
                (local.set $x (i32.sub (i32.sub (local.get $w) (i32.const 1))
                                       (local.get $dx)))
                (local.set $y (i32.sub (i32.sub (local.get $h) (i32.const 1))
                                       (local.get $dy)))
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                  (local.get $x) (local.get $y)
                  (i32.add (local.get $x) (i32.const 1))
                  (i32.add (local.get $y) (i32.const 1))
                  (local.get $brush)))))
            (local.set $dx (i32.add (local.get $dx) (i32.const 1)))
            (br $cols)))
        (local.set $dy (i32.add (local.get $dy) (i32.const 1)))
        (br $rows))))

  (func $statusbar_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $hdc i32) (local $sz i32) (local $w i32) (local $h i32)
    (local $text_w i32) (local $text_len i32) (local $right i32)
    (local $is_paint i32)
    (local $parent i32) (local $view i32) (local $view_sz i32) (local $slot i32)
    (local $mouse i32) (local $coord_x i32) (local $coord_y i32)
    (local $coord_w i32) (local $coord_len i32) (local $part_len i32)
    ;; WM_SETTEXT and SB_SETTEXTA. Paint uses the former for its help prompt;
    ;; accepting part zero/simple-mode SB_SETTEXTA also covers common callers.
    (if (i32.or
          (i32.eq (local.get $msg) (i32.const 0x000C))
          (i32.eq (local.get $msg) (i32.const 0x0401)))
      (then
        (if (i32.or
              (i32.eq (local.get $msg) (i32.const 0x000C))
              (i32.or
                (i32.eqz (i32.and (local.get $wParam) (i32.const 0xFF)))
                (i32.eq (i32.and (local.get $wParam) (i32.const 0xFF)) (i32.const 0xFF))))
          (then
            (local.set $text_len
              (if (result i32) (local.get $lParam)
                (then (call $guest_strlen (local.get $lParam)))
                (else (i32.const 0))))
            (call $title_table_set
              (local.get $hwnd)
              (if (result i32) (local.get $lParam)
                (then (call $g2w (local.get $lParam)))
                (else (i32.const 0)))
              (local.get $text_len))
            (call $invalidate_hwnd (local.get $hwnd))))
        (return (i32.const 1))))
    ;; SB_SETPARTS / SB_SIMPLE: retain API success. The Paint/MFC status bar
    ;; presents its active prompt through the whole first pane.
    (if (i32.or
          (i32.eq (local.get $msg) (i32.const 0x0404))
          (i32.eq (local.get $msg) (i32.const 0x0409)))
      (then
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 1))))
    ;; WM_PAINT
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        (drop (call $host_gdi_select_clip_rgn (local.get $hdc) (i32.const 0)))
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        (local.set $is_paint (call $statusbar_is_paint (local.get $hwnd)))
        (if (i32.and (i32.gt_s (local.get $w) (i32.const 0))
                     (i32.gt_s (local.get $h) (i32.const 0)))
          (then
            (drop (call $host_gdi_fill_rect (local.get $hdc)
              (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
              (i32.const 0x30011))) ;; COLOR_3DFACE
            ;; Paint's MFC bar has a fixed 166px help pane and a coordinate
            ;; pane extending beneath its size grip. Generic status bars keep
            ;; the SBARS_SIZEGRIP reservation used by comctl32.
            (local.set $right
              (if (result i32)
                  (local.get $is_paint)
                (then (i32.const 167))
                (else
                  (if (result i32)
                      (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x100))
                    (then (i32.sub (local.get $w) (i32.const 17)))
                    (else (i32.sub (local.get $w) (i32.const 2)))))))
            (if (i32.gt_s (local.get $right) (i32.const 3))
              (then
                (drop (call $host_gdi_draw_edge (local.get $hdc)
                  (i32.const 1) (i32.const 2) (local.get $right) (i32.sub (local.get $h) (i32.const 2))
                  (i32.const 0x0A) (i32.const 0x0F))) ;; EDGE_SUNKEN | BF_RECT
                (local.set $text_w (call $title_table_get_ptr (local.get $hwnd)))
                (local.set $text_len (call $title_table_get_len (local.get $hwnd)))
                (if (i32.and (local.get $text_w) (local.get $text_len))
                  (then
                    (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))
                    (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))
                    (i32.store        (global.get $PAINT_SCRATCH) (i32.const 4))
                    (i32.store offset=4  (global.get $PAINT_SCRATCH) (i32.const 2))
                    (i32.store offset=8  (global.get $PAINT_SCRATCH) (i32.sub (local.get $right) (i32.const 3)))
                    (i32.store offset=12 (global.get $PAINT_SCRATCH) (i32.sub (local.get $h) (i32.const 2)))
                    (drop (call $host_gdi_draw_text
                      (local.get $hdc) (local.get $text_w) (local.get $text_len)
                      (global.get $PAINT_SCRATCH) (i32.const 0x824) (i32.const 0)))))))
            (if (i32.and (local.get $is_paint) (i32.gt_s (local.get $w) (i32.const 171)))
              (then
                (drop (call $host_gdi_draw_edge (local.get $hdc)
                  (i32.const 169) (i32.const 2) (i32.sub (local.get $w) (i32.const 2))
                  (i32.sub (local.get $h) (i32.const 2))
                  (i32.const 0x0A) (i32.const 0x0F)))
                ;; Paint exposes image coordinates in its second pane while
                ;; the pointer is over the scroll view. The renderer requests
                ;; this small repaint on each relevant pointer movement.
                (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
                (local.set $view (call $ctrl_find_by_id (local.get $parent) (i32.const 0xE900)))
                (local.set $mouse (call $host_get_mouse_position))
                (local.set $coord_x
                  (i32.sub
                    (i32.and (local.get $mouse) (i32.const 0xFFFF))
                    (call $wnd_client_screen_x (local.get $view))))
                (local.set $coord_y
                  (i32.sub
                    (i32.and (i32.shr_u (local.get $mouse) (i32.const 16)) (i32.const 0xFFFF))
                    (call $wnd_client_screen_y (local.get $view))))
                (local.set $view_sz (call $ctrl_get_wh_packed (local.get $view)))
                (if (i32.and
                      ;; Paint's visible image view carries WS_CLIPCHILDREN;
                      ;; MFC's print-preview replacement reuses ID 0xE900
                      ;; without it and is not an image coordinate space.
                      (i32.eq
                        (i32.and (call $wnd_get_style (local.get $view)) (i32.const 0x12000000))
                        (i32.const 0x12000000))
                      (i32.and
                        (i32.and (i32.ge_s (local.get $coord_x) (i32.const 0))
                                 (i32.ge_s (local.get $coord_y) (i32.const 0)))
                        (i32.and
                          (i32.lt_s (local.get $coord_x)
                            (i32.sub (i32.and (local.get $view_sz) (i32.const 0xFFFF)) (i32.const 16)))
                          (i32.lt_s (local.get $coord_y)
                            (i32.sub (i32.shr_u (local.get $view_sz) (i32.const 16)) (i32.const 16))))))
                  (then
                    (local.set $slot (call $wnd_table_find (local.get $view)))
                    (if (i32.ne (local.get $slot) (i32.const -1))
                      (then
                        (local.set $coord_x
                          (i32.add (local.get $coord_x)
                            (i32.load (call $scroll_record_addr (local.get $slot)))))
                        (local.set $coord_y
                          (i32.add (local.get $coord_y)
                            (i32.load offset=12 (call $scroll_record_addr (local.get $slot)))))))
                    (if (i32.gt_u (local.get $coord_x) (i32.const 99999))
                      (then (local.set $coord_x (i32.const 99999))))
                    (if (i32.gt_u (local.get $coord_y) (i32.const 99999))
                      (then (local.set $coord_y (i32.const 99999))))
                    ;; The 16 bytes immediately after PAINT_SCRATCH are free;
                    ;; +32 is MENU_DATA_TABLE and corrupts Paint's main menu.
                    (local.set $coord_w (i32.add (global.get $PAINT_SCRATCH) (i32.const 16)))
                    (local.set $coord_len
                      (call $statusbar_write_uint (local.get $coord_w) (local.get $coord_x)))
                    (i32.store8 (i32.add (local.get $coord_w) (local.get $coord_len)) (i32.const 44))
                    (local.set $coord_len (i32.add (local.get $coord_len) (i32.const 1)))
                    (local.set $part_len
                      (call $statusbar_write_uint
                        (i32.add (local.get $coord_w) (local.get $coord_len)) (local.get $coord_y)))
                    (local.set $coord_len (i32.add (local.get $coord_len) (local.get $part_len)))
                    (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))
                    (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))
                    (drop (call $host_gdi_text_out (local.get $hdc)
                      (i32.const 173) (i32.const 5)
                      (local.get $coord_w) (local.get $coord_len) (i32.const 0)))))
                (call $statusbar_draw_size_grip (local.get $hdc) (local.get $w) (local.get $h)))
              (else
                ;; Minimal generic Win9x size grip for SBARS_SIZEGRIP bars.
                (if (i32.and
                      (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x100))
                      (i32.and (i32.ge_s (local.get $w) (i32.const 16))
                               (i32.ge_s (local.get $h) (i32.const 12))))
                  (then
                    (call $statusbar_draw_size_grip
                      (local.get $hdc) (local.get $w) (local.get $h))))))))))
        (return (i32.const 0))))
    (i32.const 0))

  ;; ---- ProgressBar WndProc ----
  ;;
  ;; Minimal native common-control progress bar. Enough for NSIS installers:
  ;; it owns its HWND, tracks Win32 PBM_* range/position state, paints a Win98
  ;; sunken progress well, and invalidates on state changes.

  (func $progress_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $hdc i32) (local $sz i32) (local $w i32) (local $h i32)
    (local $state i32) (local $sw i32) (local $old i32)
    (local $min i32) (local $max i32) (local $pos i32) (local $range i32) (local $inner_w i32) (local $fill_w i32)
    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))
    ;; WM_CREATE
    (if (i32.eq (local.get $msg) (i32.const 0x0001))
      (then
        (local.set $state (call $heap_alloc (i32.const 16)))
        (local.set $sw (call $g2w (local.get $state)))
        (i32.store        (local.get $sw) (i32.const 0))
        (i32.store offset=4  (local.get $sw) (i32.const 100))
        (i32.store offset=8  (local.get $sw) (i32.const 0))
        (i32.store offset=12 (local.get $sw) (i32.const 10))
        (call $wnd_set_state_ptr (local.get $hwnd) (local.get $state))
        (return (i32.const 0))))
    ;; WM_DESTROY
    (if (i32.eq (local.get $msg) (i32.const 0x0002))
      (then
        (if (local.get $state)
          (then
            (call $heap_free (local.get $state))
            (call $wnd_set_state_ptr (local.get $hwnd) (i32.const 0))))
        (return (i32.const 0))))
    ;; Some template-created common controls can receive PBM_* before WM_CREATE
    ;; state exists in older paths. Initialise lazily rather than dropping the
    ;; update.
    (if (i32.eqz (local.get $state))
      (then
        (local.set $state (call $heap_alloc (i32.const 16)))
        (local.set $sw (call $g2w (local.get $state)))
        (i32.store        (local.get $sw) (i32.const 0))
        (i32.store offset=4  (local.get $sw) (i32.const 100))
        (i32.store offset=8  (local.get $sw) (i32.const 0))
        (i32.store offset=12 (local.get $sw) (i32.const 10))
        (call $wnd_set_state_ptr (local.get $hwnd) (local.get $state))))
    (local.set $sw (call $g2w (local.get $state)))
    ;; PBM_SETRANGE(0x0401): lParam low=min, high=max.
    (if (i32.eq (local.get $msg) (i32.const 0x0401))
      (then
        (local.set $min (i32.shr_s (i32.shl (local.get $lParam) (i32.const 16)) (i32.const 16)))
        (local.set $max (i32.shr_s (local.get $lParam) (i32.const 16)))
        (if (i32.le_s (local.get $max) (local.get $min))
          (then (local.set $max (i32.add (local.get $min) (i32.const 1)))))
        (i32.store        (local.get $sw) (local.get $min))
        (i32.store offset=4  (local.get $sw) (local.get $max))
        (local.set $pos (i32.load offset=8 (local.get $sw)))
        (if (i32.lt_s (local.get $pos) (local.get $min)) (then (i32.store offset=8 (local.get $sw) (local.get $min))))
        (if (i32.gt_s (local.get $pos) (local.get $max)) (then (i32.store offset=8 (local.get $sw) (local.get $max))))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 0))))
    ;; PBM_SETPOS(0x0402): return previous position.
    (if (i32.eq (local.get $msg) (i32.const 0x0402))
      (then
        (local.set $old (i32.load offset=8 (local.get $sw)))
        (local.set $min (i32.load (local.get $sw)))
        (local.set $max (i32.load offset=4 (local.get $sw)))
        (local.set $pos (local.get $wParam))
        (if (i32.lt_s (local.get $pos) (local.get $min)) (then (local.set $pos (local.get $min))))
        (if (i32.gt_s (local.get $pos) (local.get $max)) (then (local.set $pos (local.get $max))))
        (i32.store offset=8 (local.get $sw) (local.get $pos))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (local.get $old))))
    ;; PBM_DELTAPOS(0x0403): return previous position.
    (if (i32.eq (local.get $msg) (i32.const 0x0403))
      (then
        (local.set $old (i32.load offset=8 (local.get $sw)))
        (local.set $min (i32.load (local.get $sw)))
        (local.set $max (i32.load offset=4 (local.get $sw)))
        (local.set $pos (i32.add (local.get $old) (local.get $wParam)))
        (if (i32.lt_s (local.get $pos) (local.get $min)) (then (local.set $pos (local.get $min))))
        (if (i32.gt_s (local.get $pos) (local.get $max)) (then (local.set $pos (local.get $max))))
        (i32.store offset=8 (local.get $sw) (local.get $pos))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (local.get $old))))
    ;; PBM_SETSTEP(0x0404), PBM_STEPIT(0x0405), PBM_SETRANGE32(0x0406).
    (if (i32.eq (local.get $msg) (i32.const 0x0404))
      (then
        (local.set $old (i32.load offset=12 (local.get $sw)))
        (i32.store offset=12 (local.get $sw) (local.get $wParam))
        (return (local.get $old))))
    (if (i32.eq (local.get $msg) (i32.const 0x0405))
      (then
        (local.set $old (i32.load offset=8 (local.get $sw)))
        (local.set $min (i32.load (local.get $sw)))
        (local.set $max (i32.load offset=4 (local.get $sw)))
        (local.set $pos (i32.add (local.get $old) (i32.load offset=12 (local.get $sw))))
        (if (i32.gt_s (local.get $pos) (local.get $max)) (then (local.set $pos (local.get $min))))
        (i32.store offset=8 (local.get $sw) (local.get $pos))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (local.get $old))))
    (if (i32.eq (local.get $msg) (i32.const 0x0406))
      (then
        (local.set $min (local.get $wParam))
        (local.set $max (local.get $lParam))
        (if (i32.le_s (local.get $max) (local.get $min))
          (then (local.set $max (i32.add (local.get $min) (i32.const 1)))))
        (i32.store        (local.get $sw) (local.get $min))
        (i32.store offset=4  (local.get $sw) (local.get $max))
        (local.set $pos (i32.load offset=8 (local.get $sw)))
        (if (i32.lt_s (local.get $pos) (local.get $min)) (then (i32.store offset=8 (local.get $sw) (local.get $min))))
        (if (i32.gt_s (local.get $pos) (local.get $max)) (then (i32.store offset=8 (local.get $sw) (local.get $max))))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 0))))
    ;; WM_PAINT
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        (if (i32.and (i32.gt_s (local.get $w) (i32.const 0))
                     (i32.gt_s (local.get $h) (i32.const 0)))
          (then
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.const 0) (i32.const 0)
                    (local.get $w) (local.get $h)
                    (i32.const 0x30010))) ;; WHITE_BRUSH
            (local.set $min (i32.load (local.get $sw)))
            (local.set $max (i32.load offset=4 (local.get $sw)))
            (local.set $pos (i32.load offset=8 (local.get $sw)))
            (if (i32.lt_s (local.get $pos) (local.get $min)) (then (local.set $pos (local.get $min))))
            (if (i32.gt_s (local.get $pos) (local.get $max)) (then (local.set $pos (local.get $max))))
            (local.set $range (i32.sub (local.get $max) (local.get $min)))
            (local.set $inner_w (i32.sub (local.get $w) (i32.const 4)))
            (if (i32.and (i32.gt_s (local.get $range) (i32.const 0))
                         (i32.gt_s (local.get $inner_w) (i32.const 0)))
              (then
                (local.set $fill_w
                  (i32.div_s
                    (i32.mul (i32.sub (local.get $pos) (local.get $min)) (local.get $inner_w))
                    (local.get $range)))
                (if (i32.gt_s (local.get $fill_w) (i32.const 0))
                  (then
                    (drop (call $host_gdi_fill_rect (local.get $hdc)
                      (i32.const 2) (i32.const 2)
                      (i32.add (i32.const 2) (local.get $fill_w))
                      (i32.sub (local.get $h) (i32.const 2))
                      (i32.const 14))))))) ;; COLOR_HIGHLIGHT
            (drop (call $host_gdi_draw_edge (local.get $hdc)
                    (i32.const 0) (i32.const 0)
                    (local.get $w) (local.get $h)
                    (i32.const 0x0A) (i32.const 0x0F))))) ;; EDGE_SUNKEN | BF_RECT
        (return (i32.const 0))))
    (i32.const 0))

  ;; ---- ListView WndProc ----
  ;;
  ;; Bounded SysListView32 subset for report/list panes. This is intentionally
  ;; smaller than a full common-control clone: it stores columns, fixed 8-slot
  ;; subitem text rows, a single selected row, and a vertical top index. That is
  ;; enough for RegEdit/installer details panes to become stateful and for the
  ;; shared Win98 scrollbar helpers to be reused here.
  ;;
  ;; ListViewState (72 bytes, allocated in WM_CREATE)
  ;;   +0   item_count
  ;;   +4   item_cap
  ;;   +8   item_cells_ptr   guest ptr to item_cap * 40-byte rows:
  ;;                          +0..+31 8 x u32 subitem text pointers,
  ;;                          +32 iImage, +36 lParam
  ;;   +12  reserved
  ;;   +16  col_count
  ;;   +20  col_cap
  ;;   +24  col_widths_ptr   guest ptr to u32[]
  ;;   +28  col_texts_ptr    guest ptr to u32[] heap string pointers
  ;;   +32  selected_index   -1 = none
  ;;   +36  top_index
  ;;   +40  ctrl_id
  ;;   +44  extended_style   LVM_SETEXTENDEDLISTVIEWSTYLE shadow
  ;;   +48  drag_anchor_y
  ;;   +52  drag_anchor_top
  ;;   +56  small_image_list handle from LVM_SETIMAGELIST
  ;;   +60  bk_color COLORREF
  ;;   +64  text_color COLORREF
  ;;   +68  text_bk_color COLORREF or CLR_NONE

  (func $lv_header_h (param $sw i32) (result i32)
    (if (result i32) (i32.gt_s (i32.load offset=16 (local.get $sw)) (i32.const 0))
      (then (i32.const 18))
      (else (i32.const 0))))

  (func $lv_visible_rows_for_h (param $sw i32) (param $h i32) (result i32)
    (local $avail i32) (local $rows i32)
    (local.set $avail (i32.sub (local.get $h) (call $lv_header_h (local.get $sw))))
    (if (i32.lt_s (local.get $avail) (i32.const 16))
      (then (local.set $avail (i32.const 16))))
    (local.set $rows (i32.div_u (local.get $avail) (i32.const 16)))
    (if (i32.eqz (local.get $rows))
      (then (local.set $rows (i32.const 1))))
    (local.get $rows))

  (func $lv_max_scroll_for_h (param $sw i32) (param $h i32) (result i32)
    (local $max i32)
    (local.set $max
      (i32.sub (i32.load (local.get $sw))
               (call $lv_visible_rows_for_h (local.get $sw) (local.get $h))))
    (if (i32.lt_s (local.get $max) (i32.const 0))
      (then (local.set $max (i32.const 0))))
    (local.get $max))

  (func $lv_content_right_for_size (param $sw i32) (param $w i32) (param $h i32) (result i32)
    (if (i32.and
          (i32.gt_s (call $lv_max_scroll_for_h (local.get $sw) (local.get $h)) (i32.const 0))
          (i32.gt_s (local.get $w) (i32.const 16)))
      (then (return (i32.sub (local.get $w) (i32.const 16)))))
    (local.get $w))

  (func $lv_report_col_width (param $sw i32) (param $idx i32) (result i32)
    (local $col_count i32) (local $width i32)
    (local.set $col_count (i32.load offset=16 (local.get $sw)))
    (if (i32.eqz (local.get $col_count))
      (then
        (if (i32.eq (local.get $idx) (i32.const 0))
          (then (return (i32.const 120))))
        (return (i32.const 0))))
    (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                (i32.ge_s (local.get $idx) (local.get $col_count)))
      (then (return (i32.const 0))))
    (local.set $width
      (i32.load
        (i32.add (call $g2w (i32.load offset=24 (local.get $sw)))
                 (i32.mul (local.get $idx) (i32.const 4)))))
    (if (i32.le_s (local.get $width) (i32.const 0))
      (then (local.set $width (i32.const 80))))
    (local.get $width))

  (func $lv_report_col_left (param $sw i32) (param $idx i32) (result i32)
    (local $i i32) (local $x i32) (local $width i32)
    (local.set $i (i32.const 0))
    (local.set $x (i32.const 0))
    (block $done (loop $cols
      (br_if $done (i32.ge_s (local.get $i) (local.get $idx)))
      (local.set $width (call $lv_report_col_width (local.get $sw) (local.get $i)))
      (if (i32.le_s (local.get $width) (i32.const 0))
        (then (return (local.get $x))))
      (local.set $x (i32.add (local.get $x) (local.get $width)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cols)))
    (local.get $x))

  (func $lv_report_total_width (param $sw i32) (result i32)
    (local $col_count i32) (local $i i32) (local $x i32) (local $width i32)
    (local.set $col_count (i32.load offset=16 (local.get $sw)))
    (if (i32.eqz (local.get $col_count))
      (then (return (i32.const 120))))
    (local.set $i (i32.const 0))
    (local.set $x (i32.const 0))
    (block $done (loop $cols
      (br_if $done (i32.ge_s (local.get $i) (local.get $col_count)))
      (local.set $width (call $lv_report_col_width (local.get $sw) (local.get $i)))
      (if (i32.le_s (local.get $width) (i32.const 0))
        (then (local.set $width (i32.const 80))))
      (local.set $x (i32.add (local.get $x) (local.get $width)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cols)))
    (local.get $x))

  (func $lv_cell_text_matches (param $cell_g i32) (param $needle_g i32) (param $partial i32) (result i32)
    (local $hay_w i32) (local $needle_w i32) (local $i i32) (local $hc i32) (local $nc i32)
    (if (i32.or (i32.eqz (local.get $cell_g)) (i32.eqz (local.get $needle_g)))
      (then (return (i32.const 0))))
    (local.set $hay_w (call $g2w (local.get $cell_g)))
    (local.set $needle_w (call $g2w (local.get $needle_g)))
    (block $done (loop $scan
      (local.set $hc (i32.load8_u (i32.add (local.get $hay_w) (local.get $i))))
      (local.set $nc (i32.load8_u (i32.add (local.get $needle_w) (local.get $i))))
      (if (i32.eqz (local.get $nc))
        (then
          (if (local.get $partial) (then (return (i32.const 1))))
          (return (select (i32.const 1) (i32.const 0) (i32.eqz (local.get $hc))))))
      (if (i32.eqz (local.get $hc))
        (then (return (i32.const 0))))
      (if (i32.ne (call $tolower (local.get $hc)) (call $tolower (local.get $nc)))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; Per-item record, 44 bytes: 8 subitem text pointers, then image (+32),
  ;; lParam (+36) and state (+40). $lv_ensure_item_capacity, the insert and
  ;; delete shifts and the LVM_SETITEMCOUNT clear all stride by 44 too --
  ;; a WAT global would read better, but lib/compile-wat.js only parses
  ;; globals ahead of the functions and silently loses every definition
  ;; after one declared here.
  (func $lv_cell_addr (param $sw i32) (param $item i32) (param $sub i32) (result i32)
    (i32.add
      (call $g2w (i32.load offset=8 (local.get $sw)))
      (i32.add
        (i32.mul (local.get $item) (i32.const 44))
        (i32.mul (local.get $sub) (i32.const 4)))))

  (func $lv_item_image_addr (param $sw i32) (param $item i32) (result i32)
    (i32.add
      (call $g2w (i32.load offset=8 (local.get $sw)))
      (i32.add (i32.mul (local.get $item) (i32.const 44)) (i32.const 32))))

  (func $lv_item_param_addr (param $sw i32) (param $item i32) (result i32)
    (i32.add
      (call $g2w (i32.load offset=8 (local.get $sw)))
      (i32.add (i32.mul (local.get $item) (i32.const 44)) (i32.const 36))))

  ;; THE Win98 check box: a 13x13 sunken well with a black tick. Used by the
  ;; BUTTON painter (BS_CHECKBOX/BS_AUTOCHECKBOX/BS_3STATE) and by list-view
  ;; state images alike — an app supplies the latter as a two-image LVSIL_STATE
  ;; list, but the images are comctl32's own standard check boxes.
  ;;
  ;; This used to be two implementations: this one, and a 12x12 pen-stroked
  ;; copy inside $button_wndproc whose own comment promised to "compose them the
  ;; way the BUTTON painter does". One pixel apart is a visible mismatch when a
  ;; dialog puts a check box and a checked list-view row on the same line.
  (func $paint_check_box (param $hdc i32) (param $x i32) (param $y i32) (param $checked i32)
    (local $i i32)
    (drop (call $host_gdi_fill_rect (local.get $hdc)
      (local.get $x) (local.get $y)
      (i32.add (local.get $x) (i32.const 13)) (i32.add (local.get $y) (i32.const 13))
      (i32.const 0x30010)))
    ;; EDGE_SUNKEN (0x0A), BF_RECT (0x0F).
    (drop (call $host_gdi_draw_edge (local.get $hdc)
      (local.get $x) (local.get $y)
      (i32.add (local.get $x) (i32.const 13)) (i32.add (local.get $y) (i32.const 13))
      (i32.const 0x0A) (i32.const 0x0F)))
    (if (local.get $checked)
      (then
        ;; Six 2px strokes: down-right to the elbow, then up-right.
        (block $done (loop $tick
          (br_if $done (i32.ge_s (local.get $i) (i32.const 6)))
          (drop (call $host_gdi_fill_rect (local.get $hdc)
            (i32.add (local.get $x) (i32.add (local.get $i) (i32.const 3)))
            (i32.add (local.get $y)
              (select (i32.add (local.get $i) (i32.const 4))
                      (i32.sub (i32.const 10) (local.get $i))
                      (i32.lt_s (local.get $i) (i32.const 3))))
            (i32.add (local.get $x) (i32.add (local.get $i) (i32.const 4)))
            (i32.add (local.get $y)
              (select (i32.add (local.get $i) (i32.const 6))
                      (i32.sub (i32.const 12) (local.get $i))
                      (i32.lt_s (local.get $i) (i32.const 3))))
            (i32.const 0x30014)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $tick))))))

  ;; LVIS_* state bits for one item. Only the state-image field (0xF000) is
  ;; kept here; selection lives in the control's own "selected index" slot.
  (func $lv_item_state_addr (param $sw i32) (param $item i32) (result i32)
    (i32.add
      (call $g2w (i32.load offset=8 (local.get $sw)))
      (i32.add (i32.mul (local.get $item) (i32.const 44)) (i32.const 40))))

  (func $lv_ensure_item_capacity (param $sw i32) (param $want i32)
    (local $cap i32) (local $new_cap i32) (local $new_bytes i32)
    (local $old_buf i32) (local $new_buf i32) (local $count i32)
    (local.set $cap (i32.load offset=4 (local.get $sw)))
    (if (i32.le_u (local.get $want) (local.get $cap))
      (then (return)))
    (local.set $new_cap (local.get $cap))
    (if (i32.eqz (local.get $new_cap))
      (then (local.set $new_cap (i32.const 16))))
    (block $grown (loop $grow
      (br_if $grown (i32.le_u (local.get $want) (local.get $new_cap)))
      (local.set $new_cap (i32.mul (local.get $new_cap) (i32.const 2)))
      (br $grow)))
    (local.set $new_bytes (i32.mul (local.get $new_cap) (i32.const 44)))
    (local.set $new_buf (call $heap_alloc (local.get $new_bytes)))
    (call $zero_memory (call $g2w (local.get $new_buf)) (local.get $new_bytes))
    (local.set $old_buf (i32.load offset=8 (local.get $sw)))
    (local.set $count (i32.load (local.get $sw)))
    (if (local.get $old_buf)
      (then
        (if (local.get $count)
          (then
            (call $memcpy (call $g2w (local.get $new_buf))
                          (call $g2w (local.get $old_buf))
                          (i32.mul (local.get $count) (i32.const 44)))))))
    (call $heap_free (local.get $old_buf))
    (i32.store offset=4 (local.get $sw) (local.get $new_cap))
    (i32.store offset=8 (local.get $sw) (local.get $new_buf)))

  (func $lv_ensure_col_capacity (param $sw i32) (param $want i32)
    (local $cap i32) (local $new_cap i32) (local $new_bytes i32)
    (local $old_widths i32) (local $old_texts i32)
    (local $new_widths i32) (local $new_texts i32) (local $count i32)
    (local.set $cap (i32.load offset=20 (local.get $sw)))
    (if (i32.le_u (local.get $want) (local.get $cap))
      (then (return)))
    (local.set $new_cap (local.get $cap))
    (if (i32.eqz (local.get $new_cap))
      (then (local.set $new_cap (i32.const 4))))
    (block $grown (loop $grow
      (br_if $grown (i32.le_u (local.get $want) (local.get $new_cap)))
      (local.set $new_cap (i32.mul (local.get $new_cap) (i32.const 2)))
      (br $grow)))
    (local.set $new_bytes (i32.mul (local.get $new_cap) (i32.const 4)))
    (local.set $new_widths (call $heap_alloc (local.get $new_bytes)))
    (local.set $new_texts (call $heap_alloc (local.get $new_bytes)))
    (call $zero_memory (call $g2w (local.get $new_widths)) (local.get $new_bytes))
    (call $zero_memory (call $g2w (local.get $new_texts)) (local.get $new_bytes))
    (local.set $old_widths (i32.load offset=24 (local.get $sw)))
    (local.set $old_texts (i32.load offset=28 (local.get $sw)))
    (local.set $count (i32.load offset=16 (local.get $sw)))
    (if (local.get $old_widths)
      (then
        (if (local.get $count)
          (then
            (call $memcpy (call $g2w (local.get $new_widths))
                          (call $g2w (local.get $old_widths))
                          (i32.mul (local.get $count) (i32.const 4)))))))
    (if (local.get $old_texts)
      (then
        (if (local.get $count)
          (then
            (call $memcpy (call $g2w (local.get $new_texts))
                          (call $g2w (local.get $old_texts))
                          (i32.mul (local.get $count) (i32.const 4)))))))
    (call $heap_free (local.get $old_widths))
    (call $heap_free (local.get $old_texts))
    (i32.store offset=20 (local.get $sw) (local.get $new_cap))
    (i32.store offset=24 (local.get $sw) (local.get $new_widths))
    (i32.store offset=28 (local.get $sw) (local.get $new_texts)))

  (func $lv_set_cell_text (param $sw i32) (param $item i32) (param $sub i32) (param $src_g i32)
    (local $cell i32) (local $old i32) (local $src_w i32) (local $len i32) (local $copy_g i32)
    (if (i32.or
          (i32.or (i32.lt_s (local.get $item) (i32.const 0))
                  (i32.ge_s (local.get $item) (i32.load (local.get $sw))))
          (i32.or (i32.lt_s (local.get $sub) (i32.const 0))
                  (i32.ge_s (local.get $sub) (i32.const 8))))
      (then (return)))
    (local.set $cell (call $lv_cell_addr (local.get $sw) (local.get $item) (local.get $sub)))
    (local.set $old (i32.load (local.get $cell)))
    (if (local.get $old)
      (then (call $heap_free (local.get $old))))
    (i32.store (local.get $cell) (i32.const 0))
    (if (i32.or (i32.eqz (local.get $src_g)) (i32.eq (local.get $src_g) (i32.const -1)))
      (then (return)))
    (local.set $src_w (call $g2w (local.get $src_g)))
    (local.set $len (call $strlen (local.get $src_w)))
    (local.set $copy_g (call $heap_alloc (i32.add (local.get $len) (i32.const 1))))
    (call $memcpy (call $g2w (local.get $copy_g)) (local.get $src_w) (local.get $len))
    (i32.store8 (i32.add (call $g2w (local.get $copy_g)) (local.get $len)) (i32.const 0))
    (i32.store (local.get $cell) (local.get $copy_g)))

  (func $lv_set_col_text (param $sw i32) (param $idx i32) (param $src_g i32)
    (local $cell i32) (local $old i32) (local $src_w i32) (local $len i32) (local $copy_g i32)
    (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                (i32.ge_s (local.get $idx) (i32.load offset=16 (local.get $sw))))
      (then (return)))
    (if (i32.eqz (i32.load offset=28 (local.get $sw)))
      (then (return)))
    (local.set $cell
      (i32.add (call $g2w (i32.load offset=28 (local.get $sw)))
               (i32.mul (local.get $idx) (i32.const 4))))
    (local.set $old (i32.load (local.get $cell)))
    (if (local.get $old)
      (then (call $heap_free (local.get $old))))
    (i32.store (local.get $cell) (i32.const 0))
    (if (i32.or (i32.eqz (local.get $src_g)) (i32.eq (local.get $src_g) (i32.const -1)))
      (then (return)))
    (local.set $src_w (call $g2w (local.get $src_g)))
    (local.set $len (call $strlen (local.get $src_w)))
    (local.set $copy_g (call $heap_alloc (i32.add (local.get $len) (i32.const 1))))
    (call $memcpy (call $g2w (local.get $copy_g)) (local.get $src_w) (local.get $len))
    (i32.store8 (i32.add (call $g2w (local.get $copy_g)) (local.get $len)) (i32.const 0))
    (i32.store (local.get $cell) (local.get $copy_g)))

  (func $lv_copy_cell_text
    (param $sw i32) (param $item i32) (param $sub i32) (param $dest_g i32) (param $max i32) (result i32)
    (local $src_g i32) (local $src_w i32) (local $dest_w i32) (local $len i32)
    (if (i32.or
          (i32.or (i32.le_u (local.get $max) (i32.const 0))
                  (i32.eqz (local.get $dest_g)))
          (i32.or (i32.lt_s (local.get $item) (i32.const 0))
                  (i32.ge_s (local.get $item) (i32.load (local.get $sw)))))
      (then (return (i32.const 0))))
    (if (i32.or (i32.lt_s (local.get $sub) (i32.const 0))
                (i32.ge_s (local.get $sub) (i32.const 8)))
      (then (return (i32.const 0))))
    (local.set $dest_w (call $g2w (local.get $dest_g)))
    (local.set $src_g (i32.load (call $lv_cell_addr (local.get $sw) (local.get $item) (local.get $sub))))
    (if (i32.eqz (local.get $src_g))
      (then
        (i32.store8 (local.get $dest_w) (i32.const 0))
        (return (i32.const 0))))
    (local.set $src_w (call $g2w (local.get $src_g)))
    (local.set $len (call $strlen (local.get $src_w)))
    (if (i32.ge_u (local.get $len) (local.get $max))
      (then (local.set $len (i32.sub (local.get $max) (i32.const 1)))))
    (if (local.get $len)
      (then (call $memcpy (local.get $dest_w) (local.get $src_w) (local.get $len))))
    (i32.store8 (i32.add (local.get $dest_w) (local.get $len)) (i32.const 0))
    (local.get $len))

  (func $lv_clear_items (param $sw i32)
    (local $count i32) (local $i i32) (local $sub i32) (local $cell i32) (local $ptr i32)
    (local.set $count (i32.load (local.get $sw)))
    (local.set $i (i32.const 0))
    (block $done (loop $items
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $sub (i32.const 0))
      (block $subs_done (loop $subs
        (br_if $subs_done (i32.ge_u (local.get $sub) (i32.const 8)))
        (local.set $cell (call $lv_cell_addr (local.get $sw) (local.get $i) (local.get $sub)))
        (local.set $ptr (i32.load (local.get $cell)))
        (if (local.get $ptr) (then (call $heap_free (local.get $ptr))))
        (i32.store (local.get $cell) (i32.const 0))
        (local.set $sub (i32.add (local.get $sub) (i32.const 1)))
        (br $subs)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $items)))
    (i32.store        (local.get $sw) (i32.const 0))
    (i32.store offset=32 (local.get $sw) (i32.const -1))
    (i32.store offset=36 (local.get $sw) (i32.const 0)))

  (func $lv_free_row_text (param $sw i32) (param $idx i32)
    (local $sub i32) (local $cell i32) (local $ptr i32)
    (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                (i32.ge_s (local.get $idx) (i32.load (local.get $sw))))
      (then (return)))
    (local.set $sub (i32.const 0))
    (block $done (loop $subs
      (br_if $done (i32.ge_u (local.get $sub) (i32.const 8)))
      (local.set $cell (call $lv_cell_addr (local.get $sw) (local.get $idx) (local.get $sub)))
      (local.set $ptr (i32.load (local.get $cell)))
      (if (local.get $ptr) (then (call $heap_free (local.get $ptr))))
      (i32.store (local.get $cell) (i32.const 0))
      (local.set $sub (i32.add (local.get $sub) (i32.const 1)))
      (br $subs))))

  (func $lv_delete_item (param $hwnd i32) (param $sw i32) (param $idx i32) (result i32)
    (local $count i32) (local $tail i32) (local $selected i32) (local $h i32)
    (local.set $count (i32.load (local.get $sw)))
    (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                (i32.ge_s (local.get $idx) (local.get $count)))
      (then (return (i32.const 0))))
    (if (i32.eq (i32.load offset=32 (local.get $sw)) (local.get $idx))
      (then (drop (call $lv_select_item (local.get $hwnd) (local.get $sw) (i32.const -1)))))
    (call $lv_free_row_text (local.get $sw) (local.get $idx))
    (local.set $tail (i32.sub (i32.sub (local.get $count) (local.get $idx)) (i32.const 1)))
    (if (i32.gt_s (local.get $tail) (i32.const 0))
      (then
        (call $memcpy
          (call $lv_cell_addr (local.get $sw) (local.get $idx) (i32.const 0))
          (call $lv_cell_addr (local.get $sw) (i32.add (local.get $idx) (i32.const 1)) (i32.const 0))
          (i32.mul (local.get $tail) (i32.const 44)))))
    (call $zero_memory
      (call $lv_cell_addr (local.get $sw) (i32.sub (local.get $count) (i32.const 1)) (i32.const 0))
      (i32.const 44))
    (i32.store (local.get $sw) (i32.sub (local.get $count) (i32.const 1)))
    (local.set $selected (i32.load offset=32 (local.get $sw)))
    (if (i32.gt_s (local.get $selected) (local.get $idx))
      (then (i32.store offset=32 (local.get $sw) (i32.sub (local.get $selected) (i32.const 1)))))
    (local.set $h (call $ctrl_get_h (local.get $hwnd)))
    (drop (call $lv_scroll_to_for_h (local.get $sw) (local.get $h) (i32.load offset=36 (local.get $sw))))
    (call $paint_flag_set_inv (local.get $hwnd))
    (i32.const 1))

  (func $lv_clear_columns (param $sw i32)
    (local $count i32) (local $i i32) (local $texts_w i32) (local $ptr i32)
    (local.set $count (i32.load offset=16 (local.get $sw)))
    (if (i32.eqz (i32.load offset=28 (local.get $sw)))
      (then
        (i32.store offset=16 (local.get $sw) (i32.const 0))
        (return)))
    (local.set $texts_w (call $g2w (i32.load offset=28 (local.get $sw))))
    (local.set $i (i32.const 0))
    (block $done (loop $cols
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $ptr (i32.load (i32.add (local.get $texts_w) (i32.mul (local.get $i) (i32.const 4)))))
      (if (local.get $ptr) (then (call $heap_free (local.get $ptr))))
      (i32.store (i32.add (local.get $texts_w) (i32.mul (local.get $i) (i32.const 4))) (i32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cols)))
    (i32.store offset=16 (local.get $sw) (i32.const 0)))

  (func $lv_delete_column (param $hwnd i32) (param $sw i32) (param $idx i32) (result i32)
    (local $col_count i32) (local $row_count i32) (local $i i32) (local $sub i32)
    (local $widths_w i32) (local $texts_w i32) (local $ptr i32)
    (local.set $col_count (i32.load offset=16 (local.get $sw)))
    (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                (i32.ge_s (local.get $idx) (local.get $col_count)))
      (then (return (i32.const 0))))
    (local.set $widths_w (call $g2w (i32.load offset=24 (local.get $sw))))
    (local.set $texts_w (call $g2w (i32.load offset=28 (local.get $sw))))
    (local.set $ptr (i32.load (i32.add (local.get $texts_w) (i32.mul (local.get $idx) (i32.const 4)))))
    (if (local.get $ptr) (then (call $heap_free (local.get $ptr))))
    (local.set $i (local.get $idx))
    (block $col_shift_done (loop $col_shift
      (br_if $col_shift_done (i32.ge_s (local.get $i) (i32.sub (local.get $col_count) (i32.const 1))))
      (i32.store
        (i32.add (local.get $widths_w) (i32.mul (local.get $i) (i32.const 4)))
        (i32.load (i32.add (local.get $widths_w) (i32.mul (i32.add (local.get $i) (i32.const 1)) (i32.const 4)))))
      (i32.store
        (i32.add (local.get $texts_w) (i32.mul (local.get $i) (i32.const 4)))
        (i32.load (i32.add (local.get $texts_w) (i32.mul (i32.add (local.get $i) (i32.const 1)) (i32.const 4)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $col_shift)))
    (i32.store
      (i32.add (local.get $widths_w) (i32.mul (i32.sub (local.get $col_count) (i32.const 1)) (i32.const 4)))
      (i32.const 0))
    (i32.store
      (i32.add (local.get $texts_w) (i32.mul (i32.sub (local.get $col_count) (i32.const 1)) (i32.const 4)))
      (i32.const 0))
    (if (i32.lt_s (local.get $idx) (i32.const 8))
      (then
        (local.set $row_count (i32.load (local.get $sw)))
        (local.set $i (i32.const 0))
        (block $rows_done (loop $rows
          (br_if $rows_done (i32.ge_s (local.get $i) (local.get $row_count)))
          (local.set $ptr (i32.load (call $lv_cell_addr (local.get $sw) (local.get $i) (local.get $idx))))
          (if (local.get $ptr) (then (call $heap_free (local.get $ptr))))
          (local.set $sub (local.get $idx))
          (block $subs_done (loop $subs
            (br_if $subs_done (i32.ge_s (local.get $sub) (i32.const 7)))
            (i32.store
              (call $lv_cell_addr (local.get $sw) (local.get $i) (local.get $sub))
              (i32.load (call $lv_cell_addr (local.get $sw) (local.get $i) (i32.add (local.get $sub) (i32.const 1)))))
            (local.set $sub (i32.add (local.get $sub) (i32.const 1)))
            (br $subs)))
          (i32.store (call $lv_cell_addr (local.get $sw) (local.get $i) (i32.const 7)) (i32.const 0))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $rows)))))
    (i32.store offset=16 (local.get $sw) (i32.sub (local.get $col_count) (i32.const 1)))
    (call $paint_flag_set_inv (local.get $hwnd))
    (i32.const 1))

  (func $lv_scroll_to_for_h (param $sw i32) (param $h i32) (param $row i32) (result i32)
    (local $max i32)
    (local.set $max (call $lv_max_scroll_for_h (local.get $sw) (local.get $h)))
    (if (i32.lt_s (local.get $row) (i32.const 0))
      (then (local.set $row (i32.const 0))))
    (if (i32.gt_s (local.get $row) (local.get $max))
      (then (local.set $row (local.get $max))))
    (i32.store offset=36 (local.get $sw) (local.get $row))
    (local.get $row))

  (func $lv_scroll_by (param $hwnd i32) (param $delta i32) (result i32)
    (local $state i32) (local $sw i32) (local $sz i32) (local $h i32)
    (local $old_top i32) (local $new_top i32)
    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
    (local.set $sw (call $g2w (local.get $state)))
    (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
    (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
    (local.set $old_top (i32.load offset=36 (local.get $sw)))
    (local.set $new_top
      (call $lv_scroll_to_for_h
        (local.get $sw) (local.get $h)
        (i32.add (local.get $old_top) (local.get $delta))))
    (if (i32.ne (local.get $new_top) (local.get $old_top))
      (then (call $paint_flag_set_inv (local.get $hwnd))))
    (local.get $new_top))

  (func $lv_notify_simple (param $hwnd i32) (param $code i32)
    (local $parent i32) (local $notify_g i32) (local $notify_w i32)
    (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
    (if (i32.eqz (local.get $parent)) (then (return)))
    (local.set $notify_g (call $heap_alloc (i32.const 12)))
    (if (i32.eqz (local.get $notify_g)) (then (return)))
    (local.set $notify_w (call $g2w (local.get $notify_g)))
    (i32.store          (local.get $notify_w) (local.get $hwnd))
    (i32.store offset=4 (local.get $notify_w) (call $ctrl_table_get_id (local.get $hwnd)))
    (i32.store offset=8 (local.get $notify_w) (local.get $code))
    (global.set $lv_debug_notify_count (i32.add (global.get $lv_debug_notify_count) (i32.const 1)))
    (global.set $lv_debug_notify_code (local.get $code))
    (global.set $lv_debug_notify_item (i32.const -1))
    (global.set $lv_debug_notify_old_state (i32.const 0))
    (global.set $lv_debug_notify_new_state (i32.const 0))
    (drop (call $wnd_send_message
      (local.get $parent) (i32.const 0x004E)
      (call $ctrl_table_get_id (local.get $hwnd))
      (local.get $notify_g)))
    (call $heap_free (local.get $notify_g)))

  (func $lv_notify_item_state
    (param $hwnd i32) (param $item i32) (param $old_state i32) (param $new_state i32) (param $code i32) (result i32)
    (local $parent i32) (local $notify_g i32) (local $notify_w i32) (local $ret i32)
    (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
    (if (i32.eqz (local.get $parent)) (then (return (i32.const 0))))
    (local.set $notify_g (call $heap_alloc (i32.const 44)))
    (if (i32.eqz (local.get $notify_g)) (then (return (i32.const 0))))
    (local.set $notify_w (call $g2w (local.get $notify_g)))
    (call $zero_memory (local.get $notify_w) (i32.const 44))
    (i32.store          (local.get $notify_w) (local.get $hwnd))
    (i32.store offset=4 (local.get $notify_w) (call $ctrl_table_get_id (local.get $hwnd)))
    (i32.store offset=8 (local.get $notify_w) (local.get $code))
    (i32.store offset=12 (local.get $notify_w) (local.get $item))
    (i32.store offset=16 (local.get $notify_w) (i32.const 0))
    (i32.store offset=20 (local.get $notify_w) (local.get $new_state))
    (i32.store offset=24 (local.get $notify_w) (local.get $old_state))
    (i32.store offset=28 (local.get $notify_w) (i32.const 0x0008)) ;; LVIF_STATE
    (global.set $lv_debug_notify_count (i32.add (global.get $lv_debug_notify_count) (i32.const 1)))
    (global.set $lv_debug_notify_code (local.get $code))
    (global.set $lv_debug_notify_item (local.get $item))
    (global.set $lv_debug_notify_old_state (local.get $old_state))
    (global.set $lv_debug_notify_new_state (local.get $new_state))
    (local.set $ret (call $wnd_send_message
      (local.get $parent) (i32.const 0x004E)
      (call $ctrl_table_get_id (local.get $hwnd))
      (local.get $notify_g)))
    (call $heap_free (local.get $notify_g))
    (local.get $ret))

  (func $lv_select_item (param $hwnd i32) (param $sw i32) (param $idx i32) (result i32)
    (local $old_idx i32)
    (if (i32.and
          (i32.ne (local.get $idx) (i32.const -1))
          (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                  (i32.ge_s (local.get $idx) (i32.load (local.get $sw)))))
      (then (return (i32.const 0))))
    (local.set $old_idx (i32.load offset=32 (local.get $sw)))
    (if (i32.eq (local.get $old_idx) (local.get $idx))
      (then (return (i32.const 1))))
    (if (i32.ge_s (local.get $idx) (i32.const 0))
      (then
        (if (call $lv_notify_item_state
              (local.get $hwnd) (local.get $idx)
              (i32.const 0) (i32.const 0x0002) (i32.const -100))
          (then (return (i32.const 0))))))
    (if (i32.ge_s (local.get $old_idx) (i32.const 0))
      (then
        (drop (call $lv_notify_item_state
          (local.get $hwnd) (local.get $old_idx)
          (i32.const 0x0002) (i32.const 0) (i32.const -101)))))
    (i32.store offset=32 (local.get $sw) (local.get $idx))
    (if (i32.ge_s (local.get $idx) (i32.const 0))
      (then
        (drop (call $lv_notify_item_state
          (local.get $hwnd) (local.get $idx)
          (i32.const 0) (i32.const 0x0002) (i32.const -101)))))
    (i32.const 1))

  (func $lv_paint_report_icon
    (param $hdc i32) (param $sw i32) (param $row i32) (param $x i32) (param $y i32) (result i32)
    (local $img_list i32) (local $img_idx i32) (local $img_sw i32)
    (local $img_cx i32) (local $img_cy i32) (local $img_count i32) (local $img_bmp i32)
    (local $img_bmp_w i32) (local $img_bmp_h i32) (local $img_src_x i32)
    (local $img_draw_w i32) (local $img_draw_h i32) (local $img_dst_y i32)
    (local $img_memdc i32) (local $ret i32)
    (local.set $img_list (i32.load offset=56 (local.get $sw)))
    (if (i32.eqz (local.get $img_list)) (then (return (i32.const 0))))
    (local.set $img_idx (i32.load (call $lv_item_image_addr (local.get $sw) (local.get $row))))
    (if (i32.lt_s (local.get $img_idx) (i32.const 0)) (then (return (i32.const 0))))
    (local.set $img_sw (call $g2w (local.get $img_list)))
    (local.set $img_cx (i32.load (local.get $img_sw)))
    (local.set $img_cy (i32.load offset=4 (local.get $img_sw)))
    (local.set $img_count (i32.load offset=12 (local.get $img_sw)))
    (local.set $img_bmp (i32.load offset=16 (local.get $img_sw)))
    (if (i32.or
          (i32.or (i32.le_s (local.get $img_cx) (i32.const 0))
                  (i32.le_s (local.get $img_cy) (i32.const 0)))
          (i32.or (i32.le_s (local.get $img_count) (local.get $img_idx))
                  (i32.eqz (local.get $img_bmp))))
      (then (return (i32.const 0))))
    (local.set $img_bmp_w (call $host_gdi_get_object_w (local.get $img_bmp)))
    (local.set $img_bmp_h (call $host_gdi_get_object_h (local.get $img_bmp)))
    (local.set $img_src_x (i32.mul (local.get $img_idx) (local.get $img_cx)))
    (if (i32.or
          (i32.gt_s (i32.add (local.get $img_src_x) (local.get $img_cx)) (local.get $img_bmp_w))
          (i32.gt_s (local.get $img_cy) (local.get $img_bmp_h)))
      (then (return (i32.const 0))))
    (local.set $img_draw_w (local.get $img_cx))
    (if (i32.gt_s (local.get $img_draw_w) (i32.const 16))
      (then (local.set $img_draw_w (i32.const 16))))
    (local.set $img_draw_h (local.get $img_cy))
    (if (i32.gt_s (local.get $img_draw_h) (i32.const 16))
      (then (local.set $img_draw_h (i32.const 16))))
    (local.set $img_dst_y
      (i32.add (local.get $y)
        (i32.div_s (i32.sub (i32.const 16) (local.get $img_draw_h)) (i32.const 2))))
    (local.set $img_memdc (call $host_gdi_create_compat_dc (local.get $hdc)))
    (if (i32.eqz (local.get $img_memdc)) (then (return (i32.const 0))))
    (drop (call $host_gdi_select_object (local.get $img_memdc) (local.get $img_bmp)))
    (local.set $ret
      (call $host_gdi_transparent_blt
        (local.get $hdc)
        (i32.add (local.get $x) (i32.const 4)) (local.get $img_dst_y)
        (local.get $img_draw_w) (local.get $img_draw_h)
        (local.get $img_memdc)
        (local.get $img_src_x) (i32.const 0)
        (i32.load offset=20 (local.get $img_sw))))
    (drop (call $host_gdi_delete_dc (local.get $img_memdc)))
    (local.get $ret))

  ;; Does this LVM_* message change what the control looks like?
  ;;
  ;; A real SysListView32 invalidates itself whenever its content, columns
  ;; or colours change; ours only ever painted when something else happened
  ;; to invalidate it. sndvol32 fills its "Show the following volume
  ;; controls" list from WM_INITDIALOG, after the dialog's one paint pass,
  ;; so the list stayed empty for the life of the window. Enumerated rather
  ;; than range-tested on purpose: the LVM_GET* messages outnumber these and
  ;; repainting on a query would be a repaint per redraw.
  (func $lv_msg_repaints (param $msg i32) (result i32)
    (i32.or
      (i32.or
        (i32.or
          (i32.or (i32.eq (local.get $msg) (i32.const 0x1001))  ;; SETBKCOLOR
                  (i32.eq (local.get $msg) (i32.const 0x1003))) ;; SETIMAGELIST
          (i32.or (i32.eq (local.get $msg) (i32.const 0x1006))  ;; SETITEMA
                  (i32.eq (local.get $msg) (i32.const 0x1007)))) ;; INSERTITEMA
        (i32.or
          (i32.or (i32.eq (local.get $msg) (i32.const 0x1008))  ;; DELETEITEM
                  (i32.eq (local.get $msg) (i32.const 0x1009))) ;; DELETEALLITEMS
          (i32.or (i32.eq (local.get $msg) (i32.const 0x100F))  ;; SETITEMPOSITION
                  (i32.eq (local.get $msg) (i32.const 0x1013))))) ;; ENSUREVISIBLE
      (i32.or
        (i32.or
          (i32.or (i32.eq (local.get $msg) (i32.const 0x101A))  ;; SETCOLUMNA
                  (i32.eq (local.get $msg) (i32.const 0x101B))) ;; INSERTCOLUMNA
          (i32.or (i32.eq (local.get $msg) (i32.const 0x101C))  ;; DELETECOLUMN
                  (i32.eq (local.get $msg) (i32.const 0x101E)))) ;; SETCOLUMNWIDTH
        (i32.or
          (i32.or (i32.eq (local.get $msg) (i32.const 0x1024))  ;; SETTEXTCOLOR
                  (i32.eq (local.get $msg) (i32.const 0x1026))) ;; SETTEXTBKCOLOR
          (i32.or
            (i32.or (i32.eq (local.get $msg) (i32.const 0x102B))  ;; SETITEMSTATE
                    (i32.eq (local.get $msg) (i32.const 0x102E))) ;; SETITEMTEXTA
            (i32.or (i32.eq (local.get $msg) (i32.const 0x1030))  ;; SORTITEMS
                    (i32.eq (local.get $msg) (i32.const 0x1036)))))))) ;; SETEXTENDEDLISTVIEWSTYLE

  (func $listview_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $state i32) (local $sw i32) (local $cs_w i32)
    (local $hdc i32) (local $sz i32) (local $w i32) (local $h i32)
    (local $mask i32) (local $idx i32) (local $sub i32) (local $count i32)
    (local $lvi_w i32) (local $col_w i32) (local $width i32) (local $ptr i32)
    (local $i i32) (local $src i32) (local $dst i32) (local $old i32)
    (local $top i32) (local $visible i32) (local $max i32) (local $hit i32)
    (local $x i32) (local $y i32) (local $row i32) (local $new_top i32)
    (local $header_h i32) (local $content_right i32) (local $draw_row i32)
    (local $cell_g i32) (local $cell_w i32) (local $text_len i32) (local $icon_brush i32)
    (local $bk_brush i32)
    (local $col_count i32) (local $col_x i32) (local $col_idx i32)
    (local $widths_w i32) (local $texts_w i32) (local $pressed_part i32)
    (local $delta i32) (local $code i32)
    (local $indent i32) (local $icon_x i32)

    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))

    ;; WM_CREATE
    (if (i32.eq (local.get $msg) (i32.const 0x0001))
      (then
        (local.set $cs_w (call $g2w (local.get $lParam)))
        (local.set $state (call $heap_alloc (i32.const 76)))
        (local.set $sw (call $g2w (local.get $state)))
        (call $zero_memory (local.get $sw) (i32.const 76))
        (i32.store offset=32 (local.get $sw) (i32.const -1))
        (i32.store offset=40 (local.get $sw) (i32.load offset=8 (local.get $cs_w)))
        (i32.store offset=60 (local.get $sw) (i32.const 0x00FFFFFF))
        (i32.store offset=64 (local.get $sw) (i32.const 0x00000000))
        (i32.store offset=68 (local.get $sw) (i32.const 0x00FFFFFF))
        (call $wnd_set_state_ptr (local.get $hwnd) (local.get $state))
        (return (i32.const 0))))

    ;; WM_DESTROY
    (if (i32.eq (local.get $msg) (i32.const 0x0002))
      (then
        (if (local.get $state)
          (then
            (local.set $sw (call $g2w (local.get $state)))
            (call $lv_clear_items (local.get $sw))
            (call $lv_clear_columns (local.get $sw))
            (call $heap_free (i32.load offset=8 (local.get $sw)))
            (call $heap_free (i32.load offset=24 (local.get $sw)))
            (call $heap_free (i32.load offset=28 (local.get $sw)))
            (call $heap_free (local.get $state))
            (call $wnd_set_state_ptr (local.get $hwnd) (i32.const 0))))
        (return (i32.const 0))))

    (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
    (local.set $sw (call $g2w (local.get $state)))

    (if (call $lv_msg_repaints (local.get $msg))
      (then (call $invalidate_hwnd (local.get $hwnd))))

    ;; LVM_GETIMAGELIST / LVM_SETIMAGELIST. Keep the assigned small-image
    ;; list handle so report rows reserve authentic icon space.
    (if (i32.eq (local.get $msg) (i32.const 0x1002))
      (then (return (i32.load offset=56 (local.get $sw)))))
    (if (i32.eq (local.get $msg) (i32.const 0x1003))
      (then
        ;; LVSIL_STATE (2) is how a pre-XP app asks for check boxes: it hands
        ;; over a two-image list and then sets each item's state-image index.
        ;; Keep it apart from the small-icon list -- what it selects is not an
        ;; icon to draw but a check box to compose, and only its presence
        ;; matters to the painter.
        (if (i32.eq (local.get $wParam) (i32.const 2))
          (then
            (local.set $old (i32.load offset=72 (local.get $sw)))
            (i32.store offset=72 (local.get $sw) (local.get $lParam))
            (return (local.get $old))))
        (local.set $old (i32.load offset=56 (local.get $sw)))
        (i32.store offset=56 (local.get $sw) (local.get $lParam))
        (return (local.get $old))))

    ;; LVM_GETITEMCOUNT
    (if (i32.eq (local.get $msg) (i32.const 0x1004))
      (then (return (i32.load (local.get $sw)))))

    ;; LVM_GETSTRINGWIDTHA
    (if (i32.eq (local.get $msg) (i32.const 0x1011))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (return (i32.add
          (i32.mul (call $strlen (call $g2w (local.get $lParam))) (i32.const 6))
          (i32.const 8)))))

    ;; LVM_GETITEMPOSITION / LVM_SETITEMPOSITION
    (if (i32.eq (local.get $msg) (i32.const 0x1010))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $idx (local.get $wParam))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_s (local.get $idx) (i32.load (local.get $sw))))
          (then (return (i32.const 0))))
        (local.set $ptr (call $g2w (local.get $lParam)))
        (i32.store (local.get $ptr) (i32.const 0))
        (i32.store offset=4 (local.get $ptr)
          (i32.add (call $lv_header_h (local.get $sw))
                   (i32.mul (i32.sub (local.get $idx) (i32.load offset=36 (local.get $sw))) (i32.const 16))))
        (return (i32.const 1))))
    (if (i32.eq (local.get $msg) (i32.const 0x100F))
      (then
        ;; Report mode owns row layout; accept the message as a compatibility
        ;; no-op so apps that cache icon positions can continue.
        (call $paint_flag_set_inv (local.get $hwnd))
        (return (i32.const 1))))

    ;; LVM_FINDITEMA
    (if (i32.eq (local.get $msg) (i32.const 0x100D))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const -1))))
        (local.set $ptr (call $g2w (local.get $lParam)))
        (local.set $mask (i32.load (local.get $ptr)))
        (local.set $idx (i32.add (local.get $wParam) (i32.const 1)))
        (if (i32.lt_s (local.get $idx) (i32.const 0))
          (then (local.set $idx (i32.const 0))))
        (block $find_done (loop $find
          (br_if $find_done (i32.ge_s (local.get $idx) (i32.load (local.get $sw))))
          (if (i32.and (local.get $mask) (i32.const 0x0002)) ;; LVFI_STRING
            (then
              (if (call $lv_cell_text_matches
                    (i32.load (call $lv_cell_addr (local.get $sw) (local.get $idx) (i32.const 0)))
                    (i32.load offset=4 (local.get $ptr))
                    (i32.and (local.get $mask) (i32.const 0x0008)))
                (then (return (local.get $idx))))))
          (if (i32.and (local.get $mask) (i32.const 0x0001)) ;; LVFI_PARAM
            (then
              (if (i32.eq (i32.load (call $lv_item_param_addr (local.get $sw) (local.get $idx)))
                          (i32.load offset=8 (local.get $ptr)))
                (then (return (local.get $idx))))))
          (local.set $idx (i32.add (local.get $idx) (i32.const 1)))
          (br $find)))
        (return (i32.const -1))))

    ;; LVM_GETORIGIN / LVM_GETVIEWRECT / LVM_GETITEMSPACING
    (if (i32.eq (local.get $msg) (i32.const 0x1029))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $ptr (call $g2w (local.get $lParam)))
        (i32.store (local.get $ptr) (i32.const 0))
        (i32.store offset=4 (local.get $ptr)
          (i32.sub (i32.const 0) (i32.mul (i32.load offset=36 (local.get $sw)) (i32.const 16))))
        (return (i32.const 1))))
    (if (i32.eq (local.get $msg) (i32.const 0x1022))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $ptr (call $g2w (local.get $lParam)))
        (i32.store (local.get $ptr) (i32.const 0))
        (i32.store offset=4 (local.get $ptr) (i32.const 0))
        (i32.store offset=8 (local.get $ptr) (call $lv_report_total_width (local.get $sw)))
        (i32.store offset=12 (local.get $ptr)
          (i32.add (call $lv_header_h (local.get $sw))
                   (i32.mul (i32.load (local.get $sw)) (i32.const 16))))
        (return (i32.const 1))))
    (if (i32.eq (local.get $msg) (i32.const 0x1033))
      (then
        (return (i32.or (i32.const 120) (i32.shl (i32.const 16) (i32.const 16))))))

    ;; LVM_UPDATE / LVM_REDRAWITEMS. The WAT control repaints as one surface;
    ;; accept these range invalidation hints and schedule a repaint.
    (if (i32.or (i32.eq (local.get $msg) (i32.const 0x102A))
                (i32.eq (local.get $msg) (i32.const 0x1015)))
      (then
        (call $paint_flag_set_inv (local.get $hwnd))
        (return (i32.const 1))))

    ;; LVM_DELETEITEM / LVM_DELETEALLITEMS
    (if (i32.eq (local.get $msg) (i32.const 0x1008))
      (then
        (return (call $lv_delete_item (local.get $hwnd) (local.get $sw) (local.get $wParam)))))
    (if (i32.eq (local.get $msg) (i32.const 0x1009))
      (then
        (call $lv_clear_items (local.get $sw))
        (call $paint_flag_set_inv (local.get $hwnd))
        (return (i32.const 1))))

    ;; LVM_SETITEMCOUNT
    (if (i32.eq (local.get $msg) (i32.const 0x102F))
      (then
        (if (i32.lt_s (local.get $wParam) (i32.const 0))
          (then (local.set $wParam (i32.const 0))))
        (local.set $count (i32.load (local.get $sw)))
        (if (i32.lt_s (local.get $wParam) (local.get $count))
          (then
            (local.set $i (local.get $wParam))
            (block $done (loop $items
              (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
              (local.set $sub (i32.const 0))
              (block $subs_done (loop $subs
                (br_if $subs_done (i32.ge_u (local.get $sub) (i32.const 8)))
                (local.set $ptr (i32.load (call $lv_cell_addr (local.get $sw) (local.get $i) (local.get $sub))))
                (if (local.get $ptr) (then (call $heap_free (local.get $ptr))))
                (i32.store (call $lv_cell_addr (local.get $sw) (local.get $i) (local.get $sub)) (i32.const 0))
                (local.set $sub (i32.add (local.get $sub) (i32.const 1)))
                (br $subs)))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $items)))))
        (if (i32.gt_s (local.get $wParam) (local.get $count))
          (then
            (call $lv_ensure_item_capacity (local.get $sw) (local.get $wParam))
            (local.set $i (local.get $count))
            (block $done2 (loop $clear_new
              (br_if $done2 (i32.ge_u (local.get $i) (local.get $wParam)))
              (call $zero_memory (call $lv_cell_addr (local.get $sw) (local.get $i) (i32.const 0)) (i32.const 44))
              (i32.store (call $lv_item_image_addr (local.get $sw) (local.get $i)) (i32.const -1))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $clear_new)))))
        (i32.store (local.get $sw) (local.get $wParam))
        (if (i32.ge_s (i32.load offset=32 (local.get $sw)) (local.get $wParam))
          (then (i32.store offset=32 (local.get $sw) (i32.const -1))))
        (drop (call $lv_scroll_to_for_h
          (local.get $sw)
          (call $ctrl_get_h (local.get $hwnd))
          (i32.load offset=36 (local.get $sw))))
        (call $paint_flag_set_inv (local.get $hwnd))
        (return (i32.const 1))))

    ;; LVM_INSERTCOLUMNA
    (if (i32.eq (local.get $msg) (i32.const 0x101B))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const -1))))
        (local.set $idx (local.get $wParam))
        (local.set $count (i32.load offset=16 (local.get $sw)))
        (if (i32.lt_s (local.get $idx) (i32.const 0)) (then (local.set $idx (i32.const 0))))
        (if (i32.gt_s (local.get $idx) (local.get $count)) (then (local.set $idx (local.get $count))))
        (call $lv_ensure_col_capacity (local.get $sw) (i32.add (local.get $count) (i32.const 1)))
        (local.set $widths_w (call $g2w (i32.load offset=24 (local.get $sw))))
        (local.set $texts_w (call $g2w (i32.load offset=28 (local.get $sw))))
        (local.set $i (local.get $count))
        (block $shift_done (loop $shift
          (br_if $shift_done (i32.le_s (local.get $i) (local.get $idx)))
          (i32.store
            (i32.add (local.get $widths_w) (i32.mul (local.get $i) (i32.const 4)))
            (i32.load (i32.add (local.get $widths_w) (i32.mul (i32.sub (local.get $i) (i32.const 1)) (i32.const 4)))))
          (i32.store
            (i32.add (local.get $texts_w) (i32.mul (local.get $i) (i32.const 4)))
            (i32.load (i32.add (local.get $texts_w) (i32.mul (i32.sub (local.get $i) (i32.const 1)) (i32.const 4)))))
          (local.set $i (i32.sub (local.get $i) (i32.const 1)))
          (br $shift)))
        (local.set $col_w (call $g2w (local.get $lParam)))
        (local.set $mask (i32.load (local.get $col_w)))
        (local.set $width (i32.const 80))
        (if (i32.and (local.get $mask) (i32.const 0x0002))
          (then (local.set $width (i32.load offset=8 (local.get $col_w)))))
        (if (i32.le_s (local.get $width) (i32.const 0))
          (then (local.set $width (i32.const 80))))
        (i32.store (i32.add (local.get $widths_w) (i32.mul (local.get $idx) (i32.const 4))) (local.get $width))
        (i32.store (i32.add (local.get $texts_w) (i32.mul (local.get $idx) (i32.const 4))) (i32.const 0))
        (if (i32.and (local.get $mask) (i32.const 0x0004))
          (then
            (local.set $ptr (i32.load offset=12 (local.get $col_w)))
            (if (local.get $ptr)
              (then
                (if (i32.ne (local.get $ptr) (i32.const -1))
                  (then
                    (local.set $old (call $wat_str_to_heap (call $g2w (local.get $ptr)) (call $strlen (call $g2w (local.get $ptr)))))
                    (i32.store (i32.add (local.get $texts_w) (i32.mul (local.get $idx) (i32.const 4))) (local.get $old))))))))
        (i32.store offset=16 (local.get $sw) (i32.add (local.get $count) (i32.const 1)))
        (call $paint_flag_set_inv (local.get $hwnd))
        (return (local.get $idx))))

    ;; LVM_DELETECOLUMN
    (if (i32.eq (local.get $msg) (i32.const 0x101C))
      (then
        (return (call $lv_delete_column (local.get $hwnd) (local.get $sw) (local.get $wParam)))))

    ;; LVM_GETCOLUMNA / LVM_SETCOLUMNA
    (if (i32.eq (local.get $msg) (i32.const 0x1019))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $idx (local.get $wParam))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_s (local.get $idx) (i32.load offset=16 (local.get $sw))))
          (then (return (i32.const 0))))
        (local.set $col_w (call $g2w (local.get $lParam)))
        (local.set $mask (i32.load (local.get $col_w)))
        (if (i32.and (local.get $mask) (i32.const 0x0001))
          (then (i32.store offset=4 (local.get $col_w) (i32.const 0))))
        (if (i32.and (local.get $mask) (i32.const 0x0002))
          (then (i32.store offset=8 (local.get $col_w)
            (call $lv_report_col_width (local.get $sw) (local.get $idx)))))
        (if (i32.and (local.get $mask) (i32.const 0x0004))
          (then
            (local.set $dst (i32.load offset=12 (local.get $col_w)))
            (local.set $max (i32.load offset=16 (local.get $col_w)))
            (if (i32.and (i32.ne (local.get $dst) (i32.const 0))
                         (i32.gt_s (local.get $max) (i32.const 0)))
              (then
                (local.set $dst (call $g2w (local.get $dst)))
                (local.set $ptr
                  (i32.load
                    (i32.add (call $g2w (i32.load offset=28 (local.get $sw)))
                             (i32.mul (local.get $idx) (i32.const 4)))))
                (if (local.get $ptr)
                  (then
                    (local.set $src (call $g2w (local.get $ptr)))
                    (local.set $text_len (call $strlen (local.get $src)))
                    (if (i32.ge_u (local.get $text_len) (local.get $max))
                      (then (local.set $text_len (i32.sub (local.get $max) (i32.const 1)))))
                    (if (local.get $text_len)
                      (then (call $memcpy (local.get $dst) (local.get $src) (local.get $text_len))))
                    (i32.store8 (i32.add (local.get $dst) (local.get $text_len)) (i32.const 0)))
                  (else
                    (i32.store8 (local.get $dst) (i32.const 0))))))))
        (if (i32.and (local.get $mask) (i32.const 0x0008))
          (then (i32.store offset=20 (local.get $col_w) (local.get $idx))))
        (return (i32.const 1))))
    (if (i32.eq (local.get $msg) (i32.const 0x101A))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $idx (local.get $wParam))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_s (local.get $idx) (i32.load offset=16 (local.get $sw))))
          (then (return (i32.const 0))))
        (local.set $col_w (call $g2w (local.get $lParam)))
        (local.set $mask (i32.load (local.get $col_w)))
        (if (i32.and (local.get $mask) (i32.const 0x0002))
          (then
            (local.set $width (i32.load offset=8 (local.get $col_w)))
            (if (i32.le_s (local.get $width) (i32.const 0))
              (then (local.set $width (i32.const 80))))
            (i32.store
              (i32.add (call $g2w (i32.load offset=24 (local.get $sw)))
                       (i32.mul (local.get $idx) (i32.const 4)))
              (local.get $width))))
        (if (i32.and (local.get $mask) (i32.const 0x0004))
          (then
            (call $lv_set_col_text (local.get $sw) (local.get $idx) (i32.load offset=12 (local.get $col_w)))))
        (call $paint_flag_set_inv (local.get $hwnd))
        (return (i32.const 1))))

    ;; LVM_GETCOLUMNWIDTH / LVM_SETCOLUMNWIDTH
    (if (i32.eq (local.get $msg) (i32.const 0x101D))
      (then
        (local.set $idx (local.get $wParam))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_s (local.get $idx) (i32.load offset=16 (local.get $sw))))
          (then (return (i32.const 0))))
        (return (i32.load (i32.add (call $g2w (i32.load offset=24 (local.get $sw))) (i32.mul (local.get $idx) (i32.const 4)))))))
    (if (i32.eq (local.get $msg) (i32.const 0x101E))
      (then
        (local.set $idx (local.get $wParam))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_s (local.get $idx) (i32.load offset=16 (local.get $sw))))
          (then (return (i32.const 0))))
        (local.set $width (local.get $lParam))
        (if (i32.le_s (local.get $width) (i32.const 0)) (then (local.set $width (i32.const 80))))
        (i32.store (i32.add (call $g2w (i32.load offset=24 (local.get $sw))) (i32.mul (local.get $idx) (i32.const 4))) (local.get $width))
        (call $paint_flag_set_inv (local.get $hwnd))
        (return (i32.const 1))))

    ;; LVM_GETHEADER plus a bounded pseudo-Header message surface. Returning
    ;; the ListView hwnd lets apps that only query/send HDM_* messages proceed
    ;; without a real child SysHeader32 window yet.
    (if (i32.eq (local.get $msg) (i32.const 0x101F))
      (then
        (if (i32.gt_s (i32.load offset=16 (local.get $sw)) (i32.const 0))
          (then (return (local.get $hwnd))))
        (return (i32.const 0))))
    ;; HDM_GETITEMCOUNT
    (if (i32.eq (local.get $msg) (i32.const 0x1200))
      (then (return (i32.load offset=16 (local.get $sw)))))
    ;; HDM_GETITEMA
    (if (i32.eq (local.get $msg) (i32.const 0x1203))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $idx (local.get $wParam))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_s (local.get $idx) (i32.load offset=16 (local.get $sw))))
          (then (return (i32.const 0))))
        (local.set $ptr (call $g2w (local.get $lParam)))
        (local.set $mask (i32.load (local.get $ptr)))
        (if (i32.and (local.get $mask) (i32.const 0x0001))
          (then (i32.store offset=4 (local.get $ptr)
            (call $lv_report_col_width (local.get $sw) (local.get $idx)))))
        (if (i32.and (local.get $mask) (i32.const 0x0002))
          (then
            (local.set $dst (i32.load offset=8 (local.get $ptr)))
            (local.set $max (i32.load offset=16 (local.get $ptr)))
            (if (i32.and (i32.ne (local.get $dst) (i32.const 0))
                         (i32.gt_s (local.get $max) (i32.const 0)))
              (then
                (local.set $dst (call $g2w (local.get $dst)))
                (local.set $src
                  (i32.load
                    (i32.add (call $g2w (i32.load offset=28 (local.get $sw)))
                             (i32.mul (local.get $idx) (i32.const 4)))))
                (if (local.get $src)
                  (then
                    (local.set $src (call $g2w (local.get $src)))
                    (local.set $text_len (call $strlen (local.get $src)))
                    (if (i32.ge_u (local.get $text_len) (local.get $max))
                      (then (local.set $text_len (i32.sub (local.get $max) (i32.const 1)))))
                    (if (local.get $text_len)
                      (then (call $memcpy (local.get $dst) (local.get $src) (local.get $text_len))))
                    (i32.store8 (i32.add (local.get $dst) (local.get $text_len)) (i32.const 0)))
                  (else
                    (i32.store8 (local.get $dst) (i32.const 0))))))))
        (if (i32.and (local.get $mask) (i32.const 0x0004))
          (then (i32.store offset=20 (local.get $ptr) (i32.const 0))))
        (if (i32.and (local.get $mask) (i32.const 0x0080))
          (then (i32.store offset=32 (local.get $ptr) (local.get $idx))))
        (return (i32.const 1))))
    ;; HDM_SETITEMA. Update the same bounded report-column backing state used
    ;; by LVM_SETCOLUMNA. Header reordering is still identity-only.
    (if (i32.eq (local.get $msg) (i32.const 0x1204))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $idx (local.get $wParam))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_s (local.get $idx) (i32.load offset=16 (local.get $sw))))
          (then (return (i32.const 0))))
        (local.set $ptr (call $g2w (local.get $lParam)))
        (local.set $mask (i32.load (local.get $ptr)))
        (if (i32.and (local.get $mask) (i32.const 0x0080))
          (then
            (if (i32.ne (i32.load offset=32 (local.get $ptr)) (local.get $idx))
              (then (return (i32.const 0))))))
        (if (i32.and (local.get $mask) (i32.const 0x0001))
          (then
            (local.set $width (i32.load offset=4 (local.get $ptr)))
            (if (i32.le_s (local.get $width) (i32.const 0))
              (then (local.set $width (i32.const 80))))
            (i32.store
              (i32.add (call $g2w (i32.load offset=24 (local.get $sw)))
                       (i32.mul (local.get $idx) (i32.const 4)))
              (local.get $width))))
        (if (i32.and (local.get $mask) (i32.const 0x0002))
          (then
            (call $lv_set_col_text (local.get $sw) (local.get $idx) (i32.load offset=8 (local.get $ptr)))))
        (call $paint_flag_set_inv (local.get $hwnd))
        (return (i32.const 1))))
    ;; HDM_LAYOUT
    (if (i32.eq (local.get $msg) (i32.const 0x1205))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $ptr (call $g2w (local.get $lParam)))
        (local.set $src (i32.load (local.get $ptr))) ;; RECT*
        (local.set $dst (i32.load offset=4 (local.get $ptr))) ;; WINDOWPOS*
        (if (i32.eqz (local.get $dst)) (then (return (i32.const 0))))
        (local.set $header_h (call $lv_header_h (local.get $sw)))
        (if (i32.eqz (local.get $header_h)) (then (local.set $header_h (i32.const 18))))
        (if (local.get $src)
          (then
            (local.set $src (call $g2w (local.get $src)))
            (local.set $x (i32.load (local.get $src)))
            (local.set $y (i32.load offset=4 (local.get $src)))
            (local.set $width (i32.sub (i32.load offset=8 (local.get $src)) (local.get $x)))
            (i32.store offset=4 (local.get $src) (i32.add (local.get $y) (local.get $header_h))))
          (else
            (local.set $x (i32.const 0))
            (local.set $y (i32.const 0))
            (local.set $width (call $ctrl_get_w (local.get $hwnd)))))
        (local.set $dst (call $g2w (local.get $dst)))
        (i32.store          (local.get $dst) (local.get $hwnd))
        (i32.store offset=4 (local.get $dst) (i32.const 0))
        (i32.store offset=8 (local.get $dst) (local.get $x))
        (i32.store offset=12 (local.get $dst) (local.get $y))
        (i32.store offset=16 (local.get $dst) (local.get $width))
        (i32.store offset=20 (local.get $dst) (local.get $header_h))
        (i32.store offset=24 (local.get $dst) (i32.const 0x0014)) ;; SWP_NOZORDER | SWP_NOACTIVATE
        (return (i32.const 1))))
    ;; HDM_ORDERTOINDEX / HDM_GETORDERARRAY / HDM_SETORDERARRAY. The pseudo
    ;; header exposes only identity order until real header reordering lands.
    (if (i32.eq (local.get $msg) (i32.const 0x120F))
      (then
        (if (i32.or (i32.lt_s (local.get $wParam) (i32.const 0))
                    (i32.ge_s (local.get $wParam) (i32.load offset=16 (local.get $sw))))
          (then (return (i32.const -1))))
        (return (local.get $wParam))))
    (if (i32.eq (local.get $msg) (i32.const 0x1211))
      (then
        (local.set $count (i32.load offset=16 (local.get $sw)))
        (if (i32.or (i32.eqz (local.get $lParam))
                    (i32.lt_u (local.get $wParam) (local.get $count)))
          (then (return (i32.const 0))))
        (local.set $ptr (call $g2w (local.get $lParam)))
        (local.set $i (i32.const 0))
        (block $order_get_done (loop $order_get
          (br_if $order_get_done (i32.ge_u (local.get $i) (local.get $count)))
          (i32.store (i32.add (local.get $ptr) (i32.mul (local.get $i) (i32.const 4))) (local.get $i))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $order_get)))
        (return (i32.const 1))))
    (if (i32.eq (local.get $msg) (i32.const 0x1212))
      (then
        (local.set $count (i32.load offset=16 (local.get $sw)))
        (if (i32.or (i32.eqz (local.get $lParam))
                    (i32.lt_u (local.get $wParam) (local.get $count)))
          (then (return (i32.const 0))))
        (local.set $ptr (call $g2w (local.get $lParam)))
        (local.set $i (i32.const 0))
        (block $order_set_done (loop $order_set
          (br_if $order_set_done (i32.ge_u (local.get $i) (local.get $count)))
          (if (i32.ne (i32.load (i32.add (local.get $ptr) (i32.mul (local.get $i) (i32.const 4)))) (local.get $i))
            (then (return (i32.const 0))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $order_set)))
        (return (i32.const 1))))
    ;; HDM_HITTEST
    (if (i32.eq (local.get $msg) (i32.const 0x1206))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const -1))))
        (local.set $ptr (call $g2w (local.get $lParam)))
        (local.set $x (i32.load (local.get $ptr)))
        (local.set $y (i32.load offset=4 (local.get $ptr)))
        (local.set $header_h (call $lv_header_h (local.get $sw)))
        (if (i32.or (i32.lt_s (local.get $y) (i32.const 0))
                    (i32.ge_s (local.get $y) (local.get $header_h)))
          (then
            (i32.store offset=8 (local.get $ptr) (i32.const 0x0001))
            (i32.store offset=12 (local.get $ptr) (i32.const -1))
            (return (i32.const -1))))
        (local.set $col_idx (i32.const 0))
        (local.set $col_x (i32.const 0))
        (block $hd_hit_done (loop $hd_hit_cols
          (br_if $hd_hit_done (i32.ge_s (local.get $col_idx) (i32.load offset=16 (local.get $sw))))
          (local.set $width (call $lv_report_col_width (local.get $sw) (local.get $col_idx)))
          (if (i32.and
                (i32.ge_s (local.get $x) (local.get $col_x))
                (i32.lt_s (local.get $x) (i32.add (local.get $col_x) (local.get $width))))
            (then
              (i32.store offset=8 (local.get $ptr) (i32.const 0x0002))
              (i32.store offset=12 (local.get $ptr) (local.get $col_idx))
              (return (local.get $col_idx))))
          (local.set $col_x (i32.add (local.get $col_x) (local.get $width)))
          (local.set $col_idx (i32.add (local.get $col_idx) (i32.const 1)))
          (br $hd_hit_cols)))
        (i32.store offset=8 (local.get $ptr) (i32.const 0x0001))
        (i32.store offset=12 (local.get $ptr) (i32.const -1))
        (return (i32.const -1))))
    ;; HDM_GETITEMRECT
    (if (i32.eq (local.get $msg) (i32.const 0x1207))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $idx (local.get $wParam))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_s (local.get $idx) (i32.load offset=16 (local.get $sw))))
          (then (return (i32.const 0))))
        (local.set $ptr (call $g2w (local.get $lParam)))
        (local.set $col_x (call $lv_report_col_left (local.get $sw) (local.get $idx)))
        (local.set $width (call $lv_report_col_width (local.get $sw) (local.get $idx)))
        (i32.store (local.get $ptr) (local.get $col_x))
        (i32.store offset=4 (local.get $ptr) (i32.const 0))
        (i32.store offset=8 (local.get $ptr) (i32.add (local.get $col_x) (local.get $width)))
        (i32.store offset=12 (local.get $ptr) (call $lv_header_h (local.get $sw)))
        (return (i32.const 1))))

    ;; LVM_INSERTITEMA
    (if (i32.eq (local.get $msg) (i32.const 0x1007))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const -1))))
        (local.set $lvi_w (call $g2w (local.get $lParam)))
        (local.set $mask (i32.load (local.get $lvi_w)))
        (local.set $idx (i32.load offset=4 (local.get $lvi_w)))
        (local.set $count (i32.load (local.get $sw)))
        (if (i32.lt_s (local.get $idx) (i32.const 0)) (then (local.set $idx (i32.const 0))))
        (if (i32.gt_s (local.get $idx) (local.get $count)) (then (local.set $idx (local.get $count))))
        (call $lv_ensure_item_capacity (local.get $sw) (i32.add (local.get $count) (i32.const 1)))
        (local.set $i (local.get $count))
        (block $item_shift_done (loop $item_shift
          (br_if $item_shift_done (i32.le_s (local.get $i) (local.get $idx)))
          (call $memcpy
            (call $lv_cell_addr (local.get $sw) (local.get $i) (i32.const 0))
            (call $lv_cell_addr (local.get $sw) (i32.sub (local.get $i) (i32.const 1)) (i32.const 0))
            (i32.const 44))
          (local.set $i (i32.sub (local.get $i) (i32.const 1)))
          (br $item_shift)))
        (call $zero_memory (call $lv_cell_addr (local.get $sw) (local.get $idx) (i32.const 0)) (i32.const 44))
        (i32.store (call $lv_item_image_addr (local.get $sw) (local.get $idx)) (i32.const -1))
        (i32.store (local.get $sw) (i32.add (local.get $count) (i32.const 1)))
        (if (i32.and (local.get $mask) (i32.const 0x0001))
          (then
            (local.set $sub (i32.load offset=8 (local.get $lvi_w)))
            (call $lv_set_cell_text (local.get $sw) (local.get $idx) (local.get $sub) (i32.load offset=20 (local.get $lvi_w)))))
        (if (i32.and (local.get $mask) (i32.const 0x0002))
          (then
            (i32.store
              (call $lv_item_image_addr (local.get $sw) (local.get $idx))
              (i32.load offset=28 (local.get $lvi_w)))))
        (if (i32.and (local.get $mask) (i32.const 0x0004))
          (then
            (i32.store
              (call $lv_item_param_addr (local.get $sw) (local.get $idx))
              (i32.load offset=36 (local.get $lvi_w)))))
        (if (i32.and (local.get $mask) (i32.const 0x0008))
          (then
            (if (i32.and (i32.load offset=16 (local.get $lvi_w)) (i32.const 0x0002))
              (then
                (if (i32.and (i32.load offset=12 (local.get $lvi_w)) (i32.const 0x0002))
                  (then (drop (call $lv_select_item (local.get $hwnd) (local.get $sw) (local.get $idx)))))))))
        (call $paint_flag_set_inv (local.get $hwnd))
        (return (local.get $idx))))

    ;; LVM_SETITEMA / LVM_SETITEMTEXTA
    (if (i32.or (i32.eq (local.get $msg) (i32.const 0x1006))
                (i32.eq (local.get $msg) (i32.const 0x102E)))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $lvi_w (call $g2w (local.get $lParam)))
        (local.set $idx
          (select (i32.load offset=4 (local.get $lvi_w)) (local.get $wParam)
                  (i32.eq (local.get $msg) (i32.const 0x1006))))
        (local.set $sub (i32.load offset=8 (local.get $lvi_w)))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_s (local.get $idx) (i32.load (local.get $sw))))
          (then (return (i32.const 0))))
        (if (i32.or (i32.eq (local.get $msg) (i32.const 0x102E))
                    (i32.and (i32.load (local.get $lvi_w)) (i32.const 0x0001)))
          (then (call $lv_set_cell_text (local.get $sw) (local.get $idx) (local.get $sub) (i32.load offset=20 (local.get $lvi_w)))))
        (if (i32.and (i32.load (local.get $lvi_w)) (i32.const 0x0002))
          (then
            (i32.store
              (call $lv_item_image_addr (local.get $sw) (local.get $idx))
              (i32.load offset=28 (local.get $lvi_w)))))
        (if (i32.and (i32.load (local.get $lvi_w)) (i32.const 0x0004))
          (then
            (i32.store
              (call $lv_item_param_addr (local.get $sw) (local.get $idx))
              (i32.load offset=36 (local.get $lvi_w)))))
        (if (i32.and (i32.load (local.get $lvi_w)) (i32.const 0x0008))
          (then
            (if (i32.and (i32.load offset=16 (local.get $lvi_w)) (i32.const 0x0002))
              (then
                (if (i32.and (i32.load offset=12 (local.get $lvi_w)) (i32.const 0x0002))
                  (then
                    (if (i32.eqz (call $lv_select_item (local.get $hwnd) (local.get $sw) (local.get $idx)))
                      (then (return (i32.const 0)))))
                  (else
                    (if (i32.eq (i32.load offset=32 (local.get $sw)) (local.get $idx))
                      (then
                        (if (i32.eqz (call $lv_select_item (local.get $hwnd) (local.get $sw) (i32.const -1)))
                          (then (return (i32.const 0))))))))))))
        (call $paint_flag_set_inv (local.get $hwnd))
        (return (i32.const 1))))

    ;; LVM_GETITEMTEXTA / LVM_GETITEMA
    (if (i32.or (i32.eq (local.get $msg) (i32.const 0x102D))
                (i32.eq (local.get $msg) (i32.const 0x1005)))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $lvi_w (call $g2w (local.get $lParam)))
        (local.set $idx
          (select (i32.load offset=4 (local.get $lvi_w)) (local.get $wParam)
                  (i32.eq (local.get $msg) (i32.const 0x1005))))
        (local.set $sub (i32.load offset=8 (local.get $lvi_w)))
        (if (i32.eq (local.get $msg) (i32.const 0x1005))
          (then
            (if (i32.and (i32.load (local.get $lvi_w)) (i32.const 0x0002))
              (then
                (i32.store offset=28 (local.get $lvi_w)
                  (i32.load (call $lv_item_image_addr (local.get $sw) (local.get $idx))))))
            (if (i32.and (i32.load (local.get $lvi_w)) (i32.const 0x0004))
              (then
                (i32.store offset=36 (local.get $lvi_w)
                  (i32.load (call $lv_item_param_addr (local.get $sw) (local.get $idx))))))
            (if (i32.and (i32.load (local.get $lvi_w)) (i32.const 0x0008))
              (then
                (i32.store offset=12 (local.get $lvi_w)
                  (select (i32.const 0x0002) (i32.const 0)
                          (i32.eq (i32.load offset=32 (local.get $sw)) (local.get $idx))))))))
        (return (call $lv_copy_cell_text
          (local.get $sw) (local.get $idx) (local.get $sub)
          (i32.load offset=20 (local.get $lvi_w))
          (i32.load offset=24 (local.get $lvi_w))))))

    ;; LVM_SETITEMSTATE / LVM_GETITEMSTATE / LVM_GETSELECTEDCOUNT / LVM_GETNEXTITEM
    (if (i32.eq (local.get $msg) (i32.const 0x102B))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $idx (local.get $wParam))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_s (local.get $idx) (i32.load (local.get $sw))))
          (then (return (i32.const 0))))
        (local.set $lvi_w (call $g2w (local.get $lParam)))
        ;; LVIS_STATEIMAGEMASK -- the check box. Index 1 is unchecked and 2 is
        ;; checked by the convention every caller of LVSIL_STATE follows.
        (if (i32.and (i32.load offset=16 (local.get $lvi_w)) (i32.const 0xF000))
          (then
            (i32.store (call $lv_item_state_addr (local.get $sw) (local.get $idx))
              (i32.or
                (i32.and (i32.load (call $lv_item_state_addr (local.get $sw) (local.get $idx)))
                         (i32.const 0xFFFF0FFF))
                (i32.and (i32.load offset=12 (local.get $lvi_w)) (i32.const 0xF000))))))
        (if (i32.and (i32.load offset=16 (local.get $lvi_w)) (i32.const 0x0002))
          (then
            (if (i32.and (i32.load offset=12 (local.get $lvi_w)) (i32.const 0x0002))
              (then
                (if (i32.eqz (call $lv_select_item (local.get $hwnd) (local.get $sw) (local.get $idx)))
                  (then (return (i32.const 0))))))
            (if (i32.and
                  (i32.eqz (i32.and (i32.load offset=12 (local.get $lvi_w)) (i32.const 0x0002)))
                  (i32.eq (i32.load offset=32 (local.get $sw)) (local.get $idx)))
              (then
                (if (i32.eqz (call $lv_select_item (local.get $hwnd) (local.get $sw) (i32.const -1)))
                  (then (return (i32.const 0))))))))
        (call $paint_flag_set_inv (local.get $hwnd))
        (return (i32.const 1))))
    (if (i32.eq (local.get $msg) (i32.const 0x102C))
      (then
        (local.set $old (i32.const 0))
        (if (i32.and (local.get $lParam) (i32.const 0x0002))
          (then
            (if (i32.eq (i32.load offset=32 (local.get $sw)) (local.get $wParam))
              (then (local.set $old (i32.const 0x0002))))))
        ;; ListView_GetCheckState is this message masked to 0xF000, so the
        ;; check box has to answer here or every app reads back "unchecked".
        (if (i32.and (local.get $lParam) (i32.const 0xF000))
          (then
            (if (i32.and (i32.ge_s (local.get $wParam) (i32.const 0))
                         (i32.lt_s (local.get $wParam) (i32.load (local.get $sw))))
              (then
                (local.set $old (i32.or (local.get $old)
                  (i32.and (i32.load (call $lv_item_state_addr (local.get $sw) (local.get $wParam)))
                           (i32.const 0xF000))))))))
        (return (local.get $old))))
    (if (i32.eq (local.get $msg) (i32.const 0x1032))
      (then
        (return (select (i32.const 1) (i32.const 0)
                  (i32.ge_s (i32.load offset=32 (local.get $sw)) (i32.const 0))))))
    (if (i32.eq (local.get $msg) (i32.const 0x100C))
      (then
        (local.set $idx (i32.add (local.get $wParam) (i32.const 1)))
        (if (i32.and (local.get $lParam) (i32.const 0x0002))
          (then
            (if (i32.and
                  (i32.ge_s (i32.load offset=32 (local.get $sw)) (local.get $idx))
                  (i32.lt_s (i32.load offset=32 (local.get $sw)) (i32.load (local.get $sw))))
              (then (return (i32.load offset=32 (local.get $sw)))))
            (return (i32.const -1))))
        (if (i32.lt_s (local.get $idx) (i32.load (local.get $sw)))
          (then (return (local.get $idx))))
        (return (i32.const -1))))

    ;; LVM_GETITEMRECT
    (if (i32.eq (local.get $msg) (i32.const 0x100E))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $idx (local.get $wParam))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_s (local.get $idx) (i32.load (local.get $sw))))
          (then (return (i32.const 0))))
        (local.set $ptr (call $g2w (local.get $lParam)))
        (local.set $code (i32.load (local.get $ptr)))
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        (local.set $header_h (call $lv_header_h (local.get $sw)))
        (local.set $content_right (call $lv_content_right_for_size (local.get $sw) (local.get $w) (local.get $h)))
        (local.set $y
          (i32.add (local.get $header_h)
            (i32.mul
              (i32.sub (local.get $idx) (i32.load offset=36 (local.get $sw)))
              (i32.const 16))))
        (local.set $col_w (call $lv_report_col_width (local.get $sw) (i32.const 0)))
        (if (i32.le_s (local.get $col_w) (i32.const 0))
          (then (local.set $col_w (local.get $content_right))))
        (if (i32.or (i32.eq (local.get $code) (i32.const 1))
                    (i32.eq (local.get $code) (i32.const 2)))
          (then
            (i32.store (local.get $ptr)
              (select (i32.const 4) (i32.const 0)
                      (i32.gt_s (local.get $content_right) (i32.const 4))))
            (i32.store offset=8 (local.get $ptr)
              (select (local.get $col_w) (local.get $content_right)
                      (i32.lt_s (local.get $col_w) (local.get $content_right)))))
          (else
            (i32.store (local.get $ptr) (i32.const 0))
            (i32.store offset=8 (local.get $ptr) (local.get $content_right))))
        (i32.store offset=4 (local.get $ptr) (local.get $y))
        (i32.store offset=12 (local.get $ptr) (i32.add (local.get $y) (i32.const 16)))
        (return (i32.const 1))))

    ;; LVM_GETSUBITEMRECT
    (if (i32.eq (local.get $msg) (i32.const 0x1038))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $idx (local.get $wParam))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_s (local.get $idx) (i32.load (local.get $sw))))
          (then (return (i32.const 0))))
        (local.set $ptr (call $g2w (local.get $lParam)))
        (local.set $code (i32.load (local.get $ptr)))
        (local.set $sub (i32.load offset=4 (local.get $ptr)))
        (local.set $col_w (call $lv_report_col_width (local.get $sw) (local.get $sub)))
        (if (i32.le_s (local.get $col_w) (i32.const 0))
          (then (return (i32.const 0))))
        (local.set $col_x (call $lv_report_col_left (local.get $sw) (local.get $sub)))
        (local.set $header_h (call $lv_header_h (local.get $sw)))
        (local.set $y
          (i32.add (local.get $header_h)
            (i32.mul
              (i32.sub (local.get $idx) (i32.load offset=36 (local.get $sw)))
              (i32.const 16))))
        (if (i32.or (i32.eq (local.get $code) (i32.const 1))
                    (i32.eq (local.get $code) (i32.const 2)))
          (then
            (i32.store (local.get $ptr) (i32.add (local.get $col_x) (i32.const 4))))
          (else
            (i32.store (local.get $ptr) (local.get $col_x))))
        (i32.store offset=4 (local.get $ptr) (local.get $y))
        (i32.store offset=8 (local.get $ptr) (i32.add (local.get $col_x) (local.get $col_w)))
        (i32.store offset=12 (local.get $ptr) (i32.add (local.get $y) (i32.const 16)))
        (return (i32.const 1))))

    ;; LVM_GETTOPINDEX / LVM_GETCOUNTPERPAGE / LVM_ENSUREVISIBLE / LVM_SCROLL
    (if (i32.eq (local.get $msg) (i32.const 0x1027))
      (then (return (i32.load offset=36 (local.get $sw)))))
    (if (i32.eq (local.get $msg) (i32.const 0x1028))
      (then
        (return (call $lv_visible_rows_for_h
          (local.get $sw)
          (call $ctrl_get_h (local.get $hwnd))))))
    (if (i32.eq (local.get $msg) (i32.const 0x1013))
      (then
        (local.set $idx (local.get $wParam))
        (if (i32.lt_s (local.get $idx) (i32.const 0)) (then (return (i32.const 0))))
        (if (i32.ge_s (local.get $idx) (i32.load (local.get $sw))) (then (return (i32.const 0))))
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        (local.set $top (i32.load offset=36 (local.get $sw)))
        (local.set $visible (call $lv_visible_rows_for_h (local.get $sw) (local.get $h)))
        (if (i32.lt_s (local.get $idx) (local.get $top))
          (then (drop (call $lv_scroll_to_for_h (local.get $sw) (local.get $h) (local.get $idx)))))
        (if (i32.ge_s (local.get $idx) (i32.add (local.get $top) (local.get $visible)))
          (then
            (drop (call $lv_scroll_to_for_h
              (local.get $sw) (local.get $h)
              (i32.sub (i32.add (local.get $idx) (i32.const 1)) (local.get $visible))))))
        (call $paint_flag_set_inv (local.get $hwnd))
        (return (i32.const 1))))
    (if (i32.eq (local.get $msg) (i32.const 0x1014))
      (then
        (local.set $delta (i32.div_s (local.get $lParam) (i32.const 16)))
        (if (i32.and (i32.eqz (local.get $delta)) (i32.ne (local.get $lParam) (i32.const 0)))
          (then (local.set $delta (select (i32.const 1) (i32.const -1) (i32.gt_s (local.get $lParam) (i32.const 0))))))
        (drop (call $lv_scroll_by (local.get $hwnd) (local.get $delta)))
        (return (i32.const 1))))

    ;; LVM_HITTEST
    (if (i32.eq (local.get $msg) (i32.const 0x1012))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const -1))))
        (local.set $ptr (call $g2w (local.get $lParam)))
        (local.set $x (i32.load (local.get $ptr)))
        (local.set $y (i32.load offset=4 (local.get $ptr)))
        (local.set $header_h (call $lv_header_h (local.get $sw)))
        (local.set $row
          (i32.add (i32.load offset=36 (local.get $sw))
            (i32.div_s (i32.sub (local.get $y) (local.get $header_h)) (i32.const 16))))
        (if (i32.or
              (i32.lt_s (local.get $y) (local.get $header_h))
              (i32.or (i32.lt_s (local.get $row) (i32.const 0))
                      (i32.ge_s (local.get $row) (i32.load (local.get $sw)))))
          (then
            (i32.store offset=8 (local.get $ptr) (i32.const 0))
            (i32.store offset=12 (local.get $ptr) (i32.const -1))
            (i32.store offset=16 (local.get $ptr) (i32.const 0))
            (return (i32.const -1))))
        (local.set $sub (i32.const 0))
        (local.set $col_count (i32.load offset=16 (local.get $sw)))
        (if (i32.eqz (local.get $col_count))
          (then (local.set $col_count (i32.const 1))))
        (local.set $col_x (i32.const 0))
        (local.set $col_idx (i32.const 0))
        (block $hit_col_done (loop $hit_cols
          (br_if $hit_col_done (i32.ge_u (local.get $col_idx) (local.get $col_count)))
          (local.set $width (call $lv_report_col_width (local.get $sw) (local.get $col_idx)))
          (if (i32.le_s (local.get $width) (i32.const 0))
            (then (local.set $width (i32.const 120))))
          (if (i32.and
                (i32.ge_s (local.get $x) (local.get $col_x))
                (i32.lt_s (local.get $x) (i32.add (local.get $col_x) (local.get $width))))
            (then
              (local.set $sub (local.get $col_idx))
              (br $hit_col_done)))
          (local.set $col_x (i32.add (local.get $col_x) (local.get $width)))
          (local.set $col_idx (i32.add (local.get $col_idx) (i32.const 1)))
          (br $hit_cols)))
        (i32.store offset=8 (local.get $ptr) (i32.const 0x0004))
        (i32.store offset=12 (local.get $ptr) (local.get $row))
        (i32.store offset=16 (local.get $ptr) (local.get $sub))
        (return (local.get $row))))

    ;; WM_MOUSEWHEEL
    (if (i32.eq (local.get $msg) (i32.const 0x020A))
      (then
        (local.set $delta
          (i32.div_s
            (i32.sub (i32.const 0) (i32.shr_s (local.get $wParam) (i32.const 16)))
            (i32.const 40)))
        (drop (call $lv_scroll_by (local.get $hwnd) (local.get $delta)))
        (return (i32.const 0))))

    ;; WM_VSCROLL
    (if (i32.eq (local.get $msg) (i32.const 0x0115))
      (then
        (local.set $code (i32.and (local.get $wParam) (i32.const 0xFFFF)))
        (if (i32.eq (local.get $code) (i32.const 0))
          (then (drop (call $lv_scroll_by (local.get $hwnd) (i32.const -1)))))
        (if (i32.eq (local.get $code) (i32.const 1))
          (then (drop (call $lv_scroll_by (local.get $hwnd) (i32.const 1)))))
        (if (i32.or (i32.eq (local.get $code) (i32.const 2))
                    (i32.eq (local.get $code) (i32.const 3)))
          (then
            (local.set $h (call $ctrl_get_h (local.get $hwnd)))
            (local.set $delta (call $lv_visible_rows_for_h (local.get $sw) (local.get $h)))
            (if (i32.eq (local.get $code) (i32.const 2))
              (then (local.set $delta (i32.sub (i32.const 0) (local.get $delta)))))
            (drop (call $lv_scroll_by (local.get $hwnd) (local.get $delta)))))
        (if (i32.or (i32.eq (local.get $code) (i32.const 4))
                    (i32.eq (local.get $code) (i32.const 5)))
          (then
            (local.set $h (call $ctrl_get_h (local.get $hwnd)))
            (drop (call $lv_scroll_to_for_h
              (local.get $sw) (local.get $h)
              (i32.shr_s (local.get $wParam) (i32.const 16))))
            (call $paint_flag_set_inv (local.get $hwnd))))
        (if (i32.eq (local.get $code) (i32.const 6))
          (then (drop (call $lv_scroll_by (local.get $hwnd) (i32.sub (i32.const 0) (i32.load offset=36 (local.get $sw)))))))
        (if (i32.eq (local.get $code) (i32.const 7))
          (then
            (local.set $h (call $ctrl_get_h (local.get $hwnd)))
            (drop (call $lv_scroll_by
              (local.get $hwnd)
              (i32.sub (call $lv_max_scroll_for_h (local.get $sw) (local.get $h)) (i32.load offset=36 (local.get $sw)))))))
        (return (i32.const 0))))

    ;; Shared scrollbar mouse handling.
    (if (i32.and
          (i32.eq (local.get $msg) (i32.const 0x0202))
          (i32.eq (global.get $sb_pressed_hwnd) (local.get $hwnd)))
      (then
        (global.set $sb_pressed_hwnd (i32.const 0))
        (global.set $sb_pressed_part (i32.const 0))
        (if (i32.eq (global.get $capture_hwnd) (local.get $hwnd))
          (then (global.set $capture_hwnd (i32.const 0))))
        (call $paint_flag_set_inv (local.get $hwnd))
        (return (i32.const 1))))

    (if (i32.eq (local.get $msg) (i32.const 0x0202))
      (then
        (local.set $y (i32.shr_s (local.get $lParam) (i32.const 16)))
        (local.set $header_h (call $lv_header_h (local.get $sw)))
        (if (i32.lt_s (local.get $y) (local.get $header_h))
          (then (return (i32.const 0))))
        (local.set $row
          (i32.add (i32.load offset=36 (local.get $sw))
            (i32.div_s (i32.sub (local.get $y) (local.get $header_h)) (i32.const 16))))
        (if (i32.and (i32.ge_s (local.get $row) (i32.const 0))
                     (i32.lt_s (local.get $row) (i32.load (local.get $sw))))
          (then
            (call $lv_notify_simple (local.get $hwnd) (i32.const -2))))
        (return (i32.const 0))))

    (if (i32.eq (local.get $msg) (i32.const 0x0200))
      (then
        (if (i32.and
              (i32.eq (global.get $sb_pressed_hwnd) (local.get $hwnd))
              (i32.eq (global.get $sb_pressed_part) (i32.const 5)))
          (then
            (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
            (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
            (local.set $max (call $lv_max_scroll_for_h (local.get $sw) (local.get $h)))
            (if (i32.gt_s (local.get $max) (i32.const 0))
              (then
                (local.set $y (i32.shr_s (local.get $lParam) (i32.const 16)))
                (local.set $new_top
                  (call $scrollbar_drag_pos
                    (local.get $h) (local.get $y)
                    (i32.load offset=48 (local.get $sw))
                    (i32.load offset=52 (local.get $sw))
                    (i32.const 0) (local.get $max)))
                (if (i32.ne (local.get $new_top) (i32.load offset=36 (local.get $sw)))
                  (then
                    (i32.store offset=36 (local.get $sw) (local.get $new_top))
                    (call $paint_flag_set_inv (local.get $hwnd))))))
            (return (i32.const 1))))
        (return (i32.const 0))))

    (if (i32.eq (local.get $msg) (i32.const 0x0201))
      (then
        (local.set $x (i32.and (local.get $lParam) (i32.const 0xFFFF)))
        (local.set $y (i32.shr_s (local.get $lParam) (i32.const 16)))
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        (local.set $max (call $lv_max_scroll_for_h (local.get $sw) (local.get $h)))
        (if (i32.and
              (i32.gt_s (local.get $max) (i32.const 0))
              (i32.and (i32.gt_s (local.get $w) (i32.const 16))
                       (i32.ge_s (local.get $x) (i32.sub (local.get $w) (i32.const 16)))))
          (then
            (local.set $hit (call $scrollbar_hit_part
              (local.get $h) (local.get $y)
              (i32.load offset=36 (local.get $sw)) (i32.const 0) (local.get $max)))
            (if (local.get $hit)
              (then
                (global.set $sb_pressed_hwnd (local.get $hwnd))
                (global.set $sb_pressed_part (local.get $hit))
                (local.set $visible (call $lv_visible_rows_for_h (local.get $sw) (local.get $h)))
                (if (i32.eq (local.get $hit) (i32.const 1))
                  (then (drop (call $lv_scroll_by (local.get $hwnd) (i32.const -1)))))
                (if (i32.eq (local.get $hit) (i32.const 2))
                  (then (drop (call $lv_scroll_by (local.get $hwnd) (i32.const 1)))))
                (if (i32.eq (local.get $hit) (i32.const 3))
                  (then (drop (call $lv_scroll_by
                    (local.get $hwnd) (i32.sub (i32.const 0) (local.get $visible))))))
                (if (i32.eq (local.get $hit) (i32.const 4))
                  (then (drop (call $lv_scroll_by (local.get $hwnd) (local.get $visible)))))
                (if (i32.eq (local.get $hit) (i32.const 5))
                  (then
                    (i32.store offset=48 (local.get $sw) (local.get $y))
                    (i32.store offset=52 (local.get $sw) (i32.load offset=36 (local.get $sw)))
                    (global.set $capture_hwnd (local.get $hwnd))))
                (call $paint_flag_set_inv (local.get $hwnd))
                (return (i32.const 1))))))
        (local.set $header_h (call $lv_header_h (local.get $sw)))
        (if (i32.lt_s (local.get $y) (local.get $header_h))
          (then (return (i32.const 0))))
        (local.set $row
          (i32.add (i32.load offset=36 (local.get $sw))
            (i32.div_s (i32.sub (local.get $y) (local.get $header_h)) (i32.const 16))))
        (if (i32.and (i32.ge_s (local.get $row) (i32.const 0))
                     (i32.lt_s (local.get $row) (i32.load (local.get $sw))))
          (then
            (if (i32.eqz (call $lv_select_item (local.get $hwnd) (local.get $sw) (local.get $row)))
              (then (return (i32.const 0))))
            (call $paint_flag_set_inv (local.get $hwnd))
            (return (i32.const 1))))
        (return (i32.const 0))))

    ;; LVM_SETEXTENDEDLISTVIEWSTYLE / LVM_GETEXTENDEDLISTVIEWSTYLE
    (if (i32.eq (local.get $msg) (i32.const 0x1036))
      (then
        (local.set $old (i32.load offset=44 (local.get $sw)))
        (if (local.get $wParam)
          (then
            (i32.store offset=44 (local.get $sw)
              (i32.or (i32.and (local.get $old) (i32.xor (local.get $wParam) (i32.const -1)))
                      (i32.and (local.get $lParam) (local.get $wParam)))))
          (else
            (i32.store offset=44 (local.get $sw) (local.get $lParam))))
        (return (local.get $old))))
    (if (i32.eq (local.get $msg) (i32.const 0x1037))
      (then (return (i32.load offset=44 (local.get $sw)))))

    ;; LVM_GET/SETBKCOLOR, LVM_GET/SETTEXTCOLOR, LVM_GET/SETTEXTBKCOLOR.
    ;; Store caller-provided COLORREF values exactly so CLR_NONE round-trips.
    (if (i32.eq (local.get $msg) (i32.const 0x1000))
      (then (return (i32.load offset=60 (local.get $sw)))))
    (if (i32.eq (local.get $msg) (i32.const 0x1001))
      (then
        (local.set $old (i32.load offset=60 (local.get $sw)))
        (i32.store offset=60 (local.get $sw) (local.get $lParam))
        (call $paint_flag_set_inv (local.get $hwnd))
        (return (local.get $old))))
    (if (i32.eq (local.get $msg) (i32.const 0x1023))
      (then (return (i32.load offset=64 (local.get $sw)))))
    (if (i32.eq (local.get $msg) (i32.const 0x1024))
      (then
        (local.set $old (i32.load offset=64 (local.get $sw)))
        (i32.store offset=64 (local.get $sw) (local.get $lParam))
        (call $paint_flag_set_inv (local.get $hwnd))
        (return (local.get $old))))
    (if (i32.eq (local.get $msg) (i32.const 0x1025))
      (then (return (i32.load offset=68 (local.get $sw)))))
    (if (i32.eq (local.get $msg) (i32.const 0x1026))
      (then
        (local.set $old (i32.load offset=68 (local.get $sw)))
        (i32.store offset=68 (local.get $sw) (local.get $lParam))
        (call $paint_flag_set_inv (local.get $hwnd))
        (return (local.get $old))))

    ;; WM_ERASEBKGND
    (if (i32.eq (local.get $msg) (i32.const 0x0014))
      (then (return (call $host_erase_background (local.get $hwnd) (i32.const 0)))))

    ;; WM_PAINT
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        (if (i32.or (i32.le_s (local.get $w) (i32.const 0))
                    (i32.le_s (local.get $h) (i32.const 0)))
          (then (return (i32.const 0))))
        (local.set $max (call $lv_max_scroll_for_h (local.get $sw) (local.get $h)))
        (if (i32.and (i32.gt_s (local.get $max) (i32.const 0))
                     (i32.le_s (local.get $w) (i32.const 16)))
          (then (local.set $max (i32.const 0))))
        (if (i32.gt_s (local.get $max) (i32.const 0))
          (then
            (drop (call $lv_scroll_to_for_h (local.get $sw) (local.get $h) (i32.load offset=36 (local.get $sw)))))
          (else
            (i32.store offset=36 (local.get $sw) (i32.const 0))))
        (local.set $top (i32.load offset=36 (local.get $sw)))
        (local.set $header_h (call $lv_header_h (local.get $sw)))
        (local.set $content_right (local.get $w))
        (if (i32.gt_s (local.get $max) (i32.const 0))
          (then (local.set $content_right (i32.sub (local.get $w) (i32.const 16)))))
        (local.set $bk_brush (i32.const 0))
        (if (i32.ne (i32.load offset=60 (local.get $sw)) (i32.const -1))
          (then
            (local.set $bk_brush
              (call $host_gdi_create_solid_brush
                (i32.and (i32.load offset=60 (local.get $sw)) (i32.const 0x00FFFFFF))))))
        (drop (call $host_gdi_fill_rect (local.get $hdc)
                (i32.const 0) (i32.const 0)
                (local.get $w) (local.get $h)
                (select (local.get $bk_brush) (i32.const 0x30010) (i32.ne (local.get $bk_brush) (i32.const 0)))))
        (if (local.get $bk_brush)
          (then (drop (call $host_gdi_delete_object (local.get $bk_brush)))))
        (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))
        (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))
        (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x00000000)))

        ;; Header.
        (local.set $col_count (i32.load offset=16 (local.get $sw)))
        (if (i32.gt_s (local.get $col_count) (i32.const 0))
          (then
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.const 0) (i32.const 0)
                    (local.get $content_right) (local.get $header_h)
                    (i32.const 0x30011)))
            (local.set $widths_w (call $g2w (i32.load offset=24 (local.get $sw))))
            (local.set $texts_w (call $g2w (i32.load offset=28 (local.get $sw))))
            (local.set $col_x (i32.const 0))
            (local.set $col_idx (i32.const 0))
            (block $header_done (loop $header_cols
              (br_if $header_done (i32.or
                (i32.ge_u (local.get $col_idx) (local.get $col_count))
                (i32.ge_s (local.get $col_x) (local.get $content_right))))
              (local.set $width (i32.load (i32.add (local.get $widths_w) (i32.mul (local.get $col_idx) (i32.const 4)))))
              (if (i32.le_s (local.get $width) (i32.const 0))
                (then (local.set $width (i32.const 80))))
              (drop (call $host_gdi_draw_edge (local.get $hdc)
                      (local.get $col_x) (i32.const 0)
                      (select (i32.add (local.get $col_x) (local.get $width)) (local.get $content_right)
                              (i32.lt_s (i32.add (local.get $col_x) (local.get $width)) (local.get $content_right)))
                      (local.get $header_h)
                      (i32.const 0x05) (i32.const 0x0F)))
              (local.set $cell_g (i32.load (i32.add (local.get $texts_w) (i32.mul (local.get $col_idx) (i32.const 4)))))
              (if (local.get $cell_g)
                (then
                  (local.set $cell_w (call $g2w (local.get $cell_g)))
                  (local.set $text_len (call $strlen (local.get $cell_w)))
                  (drop (call $host_gdi_text_out (local.get $hdc)
                    (i32.add (local.get $col_x) (i32.const 4)) (i32.const 3)
                    (local.get $cell_w) (local.get $text_len) (i32.const 0)))))
              (local.set $col_x (i32.add (local.get $col_x) (local.get $width)))
              (local.set $col_idx (i32.add (local.get $col_idx) (i32.const 1)))
              (br $header_cols)))))

        ;; Rows.
        (if (i32.load offset=56 (local.get $sw))
          (then
            (local.set $icon_brush
              (call $host_gdi_create_solid_brush (i32.const 0x00800000)))))
        (local.set $draw_row (i32.const 0))
        (local.set $visible (call $lv_visible_rows_for_h (local.get $sw) (local.get $h)))
        (block $rows_done (loop $rows
          (br_if $rows_done (i32.ge_u (local.get $draw_row) (local.get $visible)))
          (local.set $row (i32.add (local.get $top) (local.get $draw_row)))
          (br_if $rows_done (i32.ge_u (local.get $row) (i32.load (local.get $sw))))
          (local.set $y (i32.add (local.get $header_h) (i32.mul (local.get $draw_row) (i32.const 16))))
          (if (i32.lt_s (local.get $y) (local.get $h))
            (then
              (if (i32.eq (local.get $row) (i32.load offset=32 (local.get $sw)))
                (then
                  (drop (call $host_gdi_fill_rect (local.get $hdc)
                          (i32.const 0) (local.get $y)
                          (local.get $content_right) (select (i32.add (local.get $y) (i32.const 16)) (local.get $h)
                            (i32.lt_s (i32.add (local.get $y) (i32.const 16)) (local.get $h)))
                          (i32.const 14)))
                  (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x00FFFFFF)))
                  (drop (call $host_gdi_set_bk_color (local.get $hdc) (i32.const 0x00800000)))
                  (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 2))))
                (else
                  (drop (call $host_gdi_set_text_color
                    (local.get $hdc)
                    (i32.and (i32.load offset=64 (local.get $sw)) (i32.const 0x00FFFFFF))))
                  (if (i32.eq (i32.load offset=68 (local.get $sw)) (i32.const -1))
                    (then
                      (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1))))
                    (else
                      (drop (call $host_gdi_set_bk_color
                        (local.get $hdc)
                        (i32.and (i32.load offset=68 (local.get $sw)) (i32.const 0x00FFFFFF))))
                      (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 2)))))))
              (local.set $col_count (i32.load offset=16 (local.get $sw)))
              (if (i32.eqz (local.get $col_count))
                (then (local.set $col_count (i32.const 1))))
              (local.set $col_x (i32.const 0))
              (local.set $col_idx (i32.const 0))
              (block $row_cols_done (loop $row_cols
                (br_if $row_cols_done (i32.or
                  (i32.ge_u (local.get $col_idx) (local.get $col_count))
                  (i32.ge_s (local.get $col_x) (local.get $content_right))))
                (local.set $width (i32.const 120))
                (if (i32.gt_s (i32.load offset=16 (local.get $sw)) (i32.const 0))
                  (then
                    (local.set $widths_w (call $g2w (i32.load offset=24 (local.get $sw))))
                    (local.set $width (i32.load (i32.add (local.get $widths_w) (i32.mul (local.get $col_idx) (i32.const 4)))))))
                (if (i32.le_s (local.get $width) (i32.const 0))
                  (then (local.set $width (i32.const 80))))
                (local.set $cell_g (i32.load (call $lv_cell_addr (local.get $sw) (local.get $row) (local.get $col_idx))))
                (if (local.get $cell_g)
                  (then
                    (local.set $cell_w (call $g2w (local.get $cell_g)))
                    (local.set $text_len (call $strlen (local.get $cell_w)))
                    ;; Column 0 carries the check box (LVSIL_STATE) and then the
                    ;; small icon, each claiming 17px, and the text starts after
                    ;; whichever of them are present.
                    (local.set $indent (i32.const 4))
                    ;; A row with a state-image index gets a check box, which is
                    ;; what that index selects out of an LVSIL_STATE list. The
                    ;; list itself is not consulted: sndvol32 hands us a NULL
                    ;; one and then sets indices anyway, and the images every
                    ;; caller means are comctl32's own two check boxes.
                    (if (i32.and (i32.eqz (local.get $col_idx))
                          (i32.ne (i32.and
                                    (i32.load (call $lv_item_state_addr (local.get $sw) (local.get $row)))
                                    (i32.const 0xF000))
                                  (i32.const 0)))
                      (then
                        (call $paint_check_box (local.get $hdc)
                          (i32.add (local.get $col_x) (i32.const 3))
                          (i32.add (local.get $y) (i32.const 1))
                          ;; Index 2 is the checked box, 1 the empty one.
                          (i32.eq (i32.and
                                    (i32.load (call $lv_item_state_addr (local.get $sw) (local.get $row)))
                                    (i32.const 0xF000))
                                  (i32.const 0x2000)))
                        (local.set $indent (i32.add (local.get $indent) (i32.const 17)))))
                    (local.set $icon_x
                      (i32.add (local.get $col_x) (i32.sub (local.get $indent) (i32.const 4))))
                    (if (i32.eqz (local.get $col_idx))
                      (then
                        (if (i32.load offset=56 (local.get $sw))
                          (then
                            (if (i32.eqz (call $lv_paint_report_icon
                                  (local.get $hdc) (local.get $sw) (local.get $row)
                                  (local.get $icon_x) (local.get $y)))
                              (then
                                ;; Fallback registry/document glyph: outlined page
                                ;; with the blue Win98 registry mark inside.
                                (drop (call $host_gdi_fill_rect (local.get $hdc)
                                  (i32.add (local.get $icon_x) (i32.const 4)) (i32.add (local.get $y) (i32.const 2))
                                  (i32.add (local.get $icon_x) (i32.const 16)) (i32.add (local.get $y) (i32.const 15))
                                  (i32.const 0x30014)))
                                (drop (call $host_gdi_fill_rect (local.get $hdc)
                                  (i32.add (local.get $icon_x) (i32.const 5)) (i32.add (local.get $y) (i32.const 3))
                                  (i32.add (local.get $icon_x) (i32.const 15)) (i32.add (local.get $y) (i32.const 14))
                                  (i32.const 0x30010)))
                                (drop (call $host_gdi_fill_rect (local.get $hdc)
                                  (i32.add (local.get $icon_x) (i32.const 7)) (i32.add (local.get $y) (i32.const 6))
                                  (i32.add (local.get $icon_x) (i32.const 13)) (i32.add (local.get $y) (i32.const 11))
                                  (local.get $icon_brush)))))
                        (local.set $indent (i32.add (local.get $indent) (i32.const 17)))))))
                    (drop (call $host_gdi_text_out (local.get $hdc)
                      (i32.add (local.get $col_x) (local.get $indent))
                      (i32.add (local.get $y) (i32.const 2))
                      (local.get $cell_w) (local.get $text_len) (i32.const 0)))))
                (local.set $col_x (i32.add (local.get $col_x) (local.get $width)))
                (local.set $col_idx (i32.add (local.get $col_idx) (i32.const 1)))
                (br $row_cols)))
              (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x00000000)))
              (drop (call $host_gdi_set_bk_color (local.get $hdc) (i32.const 0x00FFFFFF)))
              (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))))
          (local.set $draw_row (i32.add (local.get $draw_row) (i32.const 1)))
          (br $rows)))
        (if (local.get $icon_brush)
          (then (drop (call $host_gdi_delete_object (local.get $icon_brush)))))

        (if (i32.gt_s (local.get $max) (i32.const 0))
          (then
            (local.set $pressed_part
              (select (global.get $sb_pressed_part) (i32.const 0)
                      (i32.eq (global.get $sb_pressed_hwnd) (local.get $hwnd))))
            (call $paint_vscrollbar_rect (local.get $hdc)
              (i32.sub (local.get $w) (i32.const 16)) (i32.const 0)
              (i32.const 16) (local.get $h)
              (local.get $top) (local.get $max) (local.get $pressed_part))))
        (if (i32.and (call $ctrl_get_ex_style (local.get $hwnd)) (i32.const 0x200))
          (then
            (drop (call $host_gdi_draw_edge (local.get $hdc)
                    (i32.const 0) (i32.const 0)
                    (local.get $w) (local.get $h)
                    (i32.const 0x0A) (i32.const 0x0F)))))
        (return (i32.const 0))))

    (i32.const 0))

  ;; ---- Toolbar WndProc ----
  ;;
  ;; Minimal ToolbarWindow32 common-control default proc. WordPad subclasses
  ;; this child with MFC's CToolBar proc, then chains TB_* messages to the
  ;; previous wndproc through CallWindowProcA. Returning a real button count and
  ;; button geometry is enough for MFC's WM_SIZEPARENT layout to allocate a
  ;; visible toolbar instead of collapsing it to its border height.
  ;;
  ;; ToolbarState (80 bytes):
  ;; +0 button_count, +4 button_w, +8 button_h, +12 bitmap_w, +16 bitmap_h,
  ;; +20 rows, +24 tbutton_struct_size, +28 bitmap_count,
  ;; +32 buttons_guest (20-byte TBBUTTON snapshots), +36 capacity,
  ;; +40 pressed_index, +44 hwnd, +48 bitmap_handle,
  ;; +52 image_list, +56 hot_image_list, +60 disabled_image_list,
  ;; +64 style, +68 extended_style, +72 padding packed, +76 hot_index.

  (func $toolbar_ensure_state (param $hwnd i32) (result i32)
    (local $state i32) (local $sw i32)
    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $state))
      (then
        (local.set $state (call $heap_alloc (i32.const 80)))
        (local.set $sw (call $g2w (local.get $state)))
        (call $zero_memory (local.get $sw) (i32.const 80))
        (i32.store offset=4  (local.get $sw) (i32.const 23)) ;; default dxButton
        (i32.store offset=8  (local.get $sw) (i32.const 22)) ;; default dyButton
        (i32.store offset=12 (local.get $sw) (i32.const 16)) ;; default dxBitmap
        (i32.store offset=16 (local.get $sw) (i32.const 15)) ;; default dyBitmap
        (i32.store offset=20 (local.get $sw) (i32.const 1))  ;; one row
        (i32.store offset=24 (local.get $sw) (i32.const 20)) ;; sizeof(TBBUTTON)
        (i32.store offset=40 (local.get $sw) (i32.const -1))
        (i32.store offset=76 (local.get $sw) (i32.const -1))
        (call $wnd_set_state_ptr (local.get $hwnd) (local.get $state))))
    (local.set $sw (call $g2w (local.get $state)))
    (i32.store offset=44 (local.get $sw) (local.get $hwnd))
    (local.get $state))

  (func $toolbar_button_ptr (param $sw i32) (param $idx i32) (result i32)
    (i32.add
      (call $g2w (i32.load offset=32 (local.get $sw)))
      (i32.mul (local.get $idx) (i32.const 20))))

  (func $toolbar_memmove_right (param $src i32) (param $n i32) (param $shift i32)
    ;; Move n bytes from src to src+shift. Copy backward so the button-array
    ;; insert path is safe for overlapping ranges.
    (local $i i32)
    (if (i32.or (i32.eqz (local.get $n)) (i32.eqz (local.get $shift)))
      (then (return)))
    (local.set $i (local.get $n))
    (block $done (loop $copy
      (br_if $done (i32.eqz (local.get $i)))
      (local.set $i (i32.sub (local.get $i) (i32.const 1)))
      (i32.store8
        (i32.add (i32.add (local.get $src) (local.get $i)) (local.get $shift))
        (i32.load8_u (i32.add (local.get $src) (local.get $i))))
      (br $copy))))

  (func $toolbar_child_combo_raw_width_by_cmd
    (param $toolbar_hwnd i32) (param $cmd i32) (result i32)
    (local $slot i32) (local $ch i32) (local $wh i32)
    (local.set $slot (i32.const 0))
    (block $done (loop $scan
      (local.set $slot (call $wnd_next_child_slot (local.get $toolbar_hwnd) (local.get $slot)))
      (br_if $done (i32.lt_s (local.get $slot) (i32.const 0)))
      (local.set $ch (call $wnd_slot_hwnd (local.get $slot)))
      (if (i32.and
            (i32.eq (call $ctrl_table_get_class (local.get $ch)) (i32.const 5))
            (i32.eq (call $ctrl_table_get_id (local.get $ch)) (local.get $cmd)))
        (then
          (local.set $wh (call $ctrl_get_wh_packed (local.get $ch)))
          (return (i32.and (local.get $wh) (i32.const 0xFFFF)))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; Return an item's unconstrained width without recursing through the
  ;; large-combo negotiation below. This lets one large embedded control sum
  ;; any large siblings safely before choosing its own cap.
  (func $toolbar_button_raw_width (param $sw i32) (param $idx i32) (result i32)
    (local $count i32) (local $rec i32) (local $width i32) (local $combo_width i32)
    (local.set $width (i32.load offset=4 (local.get $sw)))
    (if (i32.le_s (local.get $width) (i32.const 0))
      (then (local.set $width (i32.const 23))))
    (local.set $count (i32.load (local.get $sw)))
    (if (i32.or
          (i32.eqz (i32.load offset=32 (local.get $sw)))
          (i32.ge_u (local.get $idx) (local.get $count)))
      (then (return (local.get $width))))
    (local.set $rec (call $toolbar_button_ptr (local.get $sw) (local.get $idx)))
    (if (i32.and (i32.load8_u offset=9 (local.get $rec)) (i32.const 0x01))
      (then
        (local.set $combo_width
          (call $toolbar_child_combo_raw_width_by_cmd
            (i32.load offset=44 (local.get $sw))
            (i32.load offset=4 (local.get $rec))))
        (if (i32.gt_s (local.get $combo_width) (i32.const 0))
          (then (return (local.get $combo_width))))
        (local.set $width (i32.load (local.get $rec)))
        (if (i32.or
              (i32.lt_s (local.get $width) (i32.const 4))
              (i32.gt_s (local.get $width) (i32.const 512)))
          (then (local.set $width (i32.const 8))))))
    (local.get $width))

  (func $toolbar_child_combo_width_by_cmd (param $sw i32) (param $cmd i32) (result i32)
    (local $toolbar_hwnd i32) (local $combo_width i32)
    (local $parent i32) (local $parent_w i32) (local $cap i32)
    (local $i i32) (local $count i32) (local $rec i32) (local $fixed_width i32)
    (local.set $toolbar_hwnd (i32.load offset=44 (local.get $sw)))
    (if (i32.eqz (local.get $toolbar_hwnd)) (then (return (i32.const 0))))
    (local.set $combo_width
      (call $toolbar_child_combo_raw_width_by_cmd
        (local.get $toolbar_hwnd) (local.get $cmd)))
    ;; Some MFC toolbars create a wide combo before the containing control bar
    ;; receives its final narrow width. Native common controls negotiate the
    ;; embedded item against its sibling TBBUTTON widths. Do the same for large
    ;; toolbar-hosted combos, leaving small combos and wide windows unchanged.
    (if (i32.gt_s (local.get $combo_width) (i32.const 160))
      (then
        (local.set $parent (call $wnd_get_parent (local.get $toolbar_hwnd)))
        (if (local.get $parent)
          (then
            (local.set $parent_w (call $wnd_client_w_for_clip (local.get $parent)))))
        (if (i32.gt_s (local.get $parent_w) (i32.const 0))
          (then
            ;; Layout starts at x=2. Sum every raw sibling width, skipping only
            ;; this combo's separator slot, so the last button remains in bounds.
            (local.set $fixed_width (i32.const 2))
            (local.set $count (i32.load (local.get $sw)))
            (local.set $i (i32.const 0))
            (block $widths_done (loop $widths
              (br_if $widths_done (i32.ge_u (local.get $i) (local.get $count)))
              (local.set $rec (call $toolbar_button_ptr (local.get $sw) (local.get $i)))
              (if (i32.eqz
                    (i32.and
                      (i32.and (i32.load8_u offset=9 (local.get $rec)) (i32.const 0x01))
                      (i32.eq (i32.load offset=4 (local.get $rec)) (local.get $cmd))))
                (then
                  (local.set $fixed_width
                    (i32.add
                      (local.get $fixed_width)
                      (call $toolbar_button_raw_width (local.get $sw) (local.get $i))))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $widths)))
            (local.set $cap (i32.sub (local.get $parent_w) (local.get $fixed_width)))
            (if (i32.lt_s (local.get $cap) (i32.const 80))
              (then (local.set $cap (i32.const 80))))
            (if (i32.gt_s (local.get $combo_width) (local.get $cap))
              (then (local.set $combo_width (local.get $cap))))))))
    (local.get $combo_width))

  (func $toolbar_ensure_capacity (param $sw i32) (param $want i32) (result i32)
    (local $cap i32) (local $new_cap i32) (local $new_items i32)
    (local.set $cap (i32.load offset=36 (local.get $sw)))
    (if (i32.le_u (local.get $want) (local.get $cap))
      (then (return (i32.const 1))))
    (local.set $new_cap (local.get $cap))
    (if (i32.eqz (local.get $new_cap))
      (then (local.set $new_cap (i32.const 8))))
    (block $done (loop $grow
      (br_if $done (i32.ge_u (local.get $new_cap) (local.get $want)))
      (local.set $new_cap (i32.mul (local.get $new_cap) (i32.const 2)))
      (br $grow)))
    (local.set $new_items
      (call $heap_realloc
        (i32.load offset=32 (local.get $sw))
        (i32.mul (local.get $new_cap) (i32.const 20))
        (i32.const 0x40)))
    (if (i32.eqz (local.get $new_items))
      (then (return (i32.const 0))))
    (i32.store offset=32 (local.get $sw) (local.get $new_items))
    (i32.store offset=36 (local.get $sw) (local.get $new_cap))
    (i32.const 1))

  (func $toolbar_init_button (param $dst i32) (param $idx i32)
    (call $zero_memory (local.get $dst) (i32.const 20))
    (i32.store        (local.get $dst) (local.get $idx)) ;; iBitmap fallback
    (i32.store8 offset=8 (local.get $dst) (i32.const 4)) ;; TBSTATE_ENABLED
    (i32.store8 offset=9 (local.get $dst) (i32.const 0))) ;; TBSTYLE_BUTTON

  (func $toolbar_copy_button_in
    (param $dst i32) (param $src_guest i32) (param $src_size i32) (param $idx i32)
    (local $src i32) (local $copy i32)
    (call $toolbar_init_button (local.get $dst) (local.get $idx))
    (if (i32.eqz (local.get $src_guest)) (then (return)))
    (local.set $copy (local.get $src_size))
    (if (i32.gt_u (local.get $copy) (i32.const 20))
      (then (local.set $copy (i32.const 20))))
    (if (i32.eqz (local.get $copy)) (then (return)))
    (local.set $src (call $g2w (local.get $src_guest)))
    (call $memcpy (local.get $dst) (local.get $src) (local.get $copy)))

  (func $toolbar_find_command_index (param $sw i32) (param $cmd i32) (result i32)
    (local $i i32) (local $count i32) (local $rec i32)
    (if (i32.eqz (i32.load offset=32 (local.get $sw)))
      (then (return (i32.const -1))))
    (local.set $count (i32.load (local.get $sw)))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $rec (call $toolbar_button_ptr (local.get $sw) (local.get $i)))
      (if (i32.eq (i32.load offset=4 (local.get $rec)) (local.get $cmd))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  (func $toolbar_button_width (param $sw i32) (param $idx i32) (result i32)
    (local $count i32) (local $rec i32) (local $width i32) (local $combo_width i32)
    (local.set $width (i32.load offset=4 (local.get $sw)))
    (if (i32.le_s (local.get $width) (i32.const 0))
      (then (local.set $width (i32.const 23))))
    (local.set $count (i32.load (local.get $sw)))
    (if (i32.or
          (i32.eqz (i32.load offset=32 (local.get $sw)))
          (i32.ge_u (local.get $idx) (local.get $count)))
      (then (return (local.get $width))))
    (local.set $rec (call $toolbar_button_ptr (local.get $sw) (local.get $idx)))
    ;; TBSTYLE_SEP uses TBBUTTON.iBitmap as the separator/control-slot width.
    ;; WordPad embeds font and size comboboxes in these slots, so fixed button
    ;; widths make MFC place both controls over the first button.
    (if (i32.and (i32.load8_u offset=9 (local.get $rec)) (i32.const 0x01))
      (then
        (local.set $combo_width
          (call $toolbar_child_combo_width_by_cmd
            (local.get $sw)
            (i32.load offset=4 (local.get $rec))))
        (if (i32.gt_s (local.get $combo_width) (i32.const 0))
          (then (return (local.get $combo_width))))
        (local.set $width (i32.load (local.get $rec)))
        (if (i32.or
              (i32.lt_s (local.get $width) (i32.const 4))
              (i32.gt_s (local.get $width) (i32.const 512)))
          (then (local.set $width (i32.const 8))))))
    (local.get $width))

  (func $toolbar_layout_width (param $sw i32) (result i32)
    (local $hwnd i32) (local $parent i32) (local $wh i32) (local $w i32) (local $parent_w i32)
    (local.set $hwnd (i32.load offset=44 (local.get $sw)))
    (if (local.get $hwnd)
      (then
        (local.set $wh (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $wh) (i32.const 0xFFFF)))
        (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
        (if (local.get $parent)
          (then
            (local.set $parent_w (call $wnd_client_w_for_clip (local.get $parent)))))
        (if (i32.gt_s (local.get $parent_w) (i32.const 0))
          (then
            (if (i32.or
                  (i32.le_s (local.get $w) (i32.const 0))
                  (i32.gt_s (local.get $w) (i32.add (local.get $parent_w) (i32.const 8))))
              (then (local.set $w (local.get $parent_w))))))))
    (if (i32.le_s (local.get $w) (i32.const 0))
      (then (local.set $w (i32.const 160))))
    (local.get $w))

  (func $toolbar_button_rect (param $sw i32) (param $idx i32) (param $rect i32) (result i32)
    (local $i i32) (local $count i32) (local $left i32) (local $top i32)
    (local $bw i32) (local $bh i32) (local $limit i32)
    (local.set $count (i32.load (local.get $sw)))
    (if (i32.or
          (i32.eqz (local.get $rect))
          (i32.ge_u (local.get $idx) (local.get $count)))
      (then (return (i32.const 0))))
    (local.set $bh (i32.load offset=8 (local.get $sw)))
    (if (i32.le_s (local.get $bh) (i32.const 0))
      (then (local.set $bh (i32.const 22))))
    (local.set $limit (call $toolbar_layout_width (local.get $sw)))
    (if (i32.lt_s (local.get $limit) (i32.const 24))
      (then (local.set $limit (i32.const 24))))
    (local.set $left (i32.const 2))
    (local.set $top (i32.const 2))
    (local.set $i (i32.const 0))
    (block $done (loop $sum
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $bw (call $toolbar_button_width (local.get $sw) (local.get $i)))
      (if (i32.and
            (i32.gt_s (local.get $left) (i32.const 2))
            (i32.gt_s (i32.add (local.get $left) (local.get $bw)) (local.get $limit)))
        (then
          (local.set $left (i32.const 2))
          (local.set $top (i32.add (local.get $top) (i32.add (local.get $bh) (i32.const 2))))))
      (if (i32.eq (local.get $i) (local.get $idx))
        (then
          (i32.store        (local.get $rect) (local.get $left))
          (i32.store offset=4  (local.get $rect) (local.get $top))
          (i32.store offset=8  (local.get $rect) (i32.add (local.get $left) (local.get $bw)))
          (i32.store offset=12 (local.get $rect) (i32.add (local.get $top) (local.get $bh)))
          (return (i32.const 1))))
      (local.set $left (i32.add (local.get $left) (local.get $bw)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $sum)))
    (i32.const 0))

  (func $toolbar_calc_rows (param $sw i32) (result i32)
    (local $i i32) (local $count i32) (local $left i32) (local $bw i32)
    (local $limit i32) (local $rows i32)
    (local.set $count (i32.load (local.get $sw)))
    (local.set $limit (call $toolbar_layout_width (local.get $sw)))
    (if (i32.lt_s (local.get $limit) (i32.const 24))
      (then (local.set $limit (i32.const 24))))
    (local.set $left (i32.const 2))
    (local.set $rows (i32.const 1))
    (local.set $i (i32.const 0))
    (block $done (loop $sum
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $bw (call $toolbar_button_width (local.get $sw) (local.get $i)))
      (if (i32.and
            (i32.gt_s (local.get $left) (i32.const 2))
            (i32.gt_s (i32.add (local.get $left) (local.get $bw)) (local.get $limit)))
        (then
          (local.set $left (i32.const 2))
          (local.set $rows (i32.add (local.get $rows) (i32.const 1)))))
      (local.set $left (i32.add (local.get $left) (local.get $bw)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $sum)))
    (local.get $rows))

  (func $toolbar_sync_child_combos (param $sw i32)
    (local $toolbar_hwnd i32) (local $slot i32) (local $ch i32) (local $child_id i32)
    (local $i i32) (local $count i32) (local $rec i32)
    (local $left i32) (local $top i32) (local $right i32)
    (local.set $toolbar_hwnd (i32.load offset=44 (local.get $sw)))
    (if (i32.eqz (local.get $toolbar_hwnd)) (then (return)))
    (if (i32.eqz (i32.load offset=32 (local.get $sw))) (then (return)))
    (local.set $count (i32.load (local.get $sw)))
    (local.set $slot (i32.const 0))
    (block $children_done (loop $children
      (local.set $slot
        (call $wnd_next_child_slot (local.get $toolbar_hwnd) (local.get $slot)))
      (br_if $children_done (i32.lt_s (local.get $slot) (i32.const 0)))
      (local.set $ch (call $wnd_slot_hwnd (local.get $slot)))
      (if (i32.eq (call $ctrl_table_get_class (local.get $ch)) (i32.const 5))
        (then
          (local.set $child_id (call $ctrl_table_get_id (local.get $ch)))
          (local.set $i (i32.const 0))
          (block $matched (loop $buttons
            (br_if $matched (i32.ge_u (local.get $i) (local.get $count)))
            (local.set $rec (call $toolbar_button_ptr (local.get $sw) (local.get $i)))
            (if (i32.and
                  (i32.and
                    (i32.and (i32.load8_u offset=9 (local.get $rec)) (i32.const 0x01))
                    (i32.eq (i32.load offset=4 (local.get $rec)) (local.get $child_id)))
                  (call $toolbar_button_rect (local.get $sw) (local.get $i) (global.get $PAINT_SCRATCH)))
              (then
                (local.set $left (i32.load (global.get $PAINT_SCRATCH)))
                (local.set $top (i32.load offset=4 (global.get $PAINT_SCRATCH)))
                (local.set $right (i32.load offset=8 (global.get $PAINT_SCRATCH)))
                (call $host_move_window
                  (local.get $ch)
                  (local.get $left)
                  (local.get $top)
                  (i32.sub (local.get $right) (local.get $left))
                  (i32.const 200)
                  (i32.const 0))
                (call $ctrl_geom_sync
                  (local.get $ch)
                  (local.get $left)
                  (local.get $top)
                  (i32.sub (local.get $right) (local.get $left))
                  (i32.const 200)
                  (i32.const 0))
                (call $defwndproc_do_nccalcsize (local.get $ch))
                (br $matched)))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $buttons)))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $children))))

  (func $toolbar_update_state_bit
    (param $sw i32) (param $cmd i32) (param $mask i32) (param $on i32) (result i32)
    (local $idx i32) (local $rec i32) (local $state i32)
    (local.set $idx (call $toolbar_find_command_index (local.get $sw) (local.get $cmd)))
    (if (i32.lt_s (local.get $idx) (i32.const 0))
      (then (return (i32.const 0))))
    (local.set $rec (call $toolbar_button_ptr (local.get $sw) (local.get $idx)))
    (local.set $state (i32.load8_u offset=8 (local.get $rec)))
    (if (i32.and (local.get $on) (i32.const 0xFFFF))
      (then
        (local.set $state (i32.or (local.get $state) (local.get $mask))))
      (else
        (local.set $state
          (i32.and (local.get $state) (i32.xor (local.get $mask) (i32.const -1))))))
    (i32.store8 offset=8 (local.get $rec) (local.get $state))
    (i32.const 1))

  (func $toolbar_hit_test (param $sw i32) (param $x i32) (param $y i32) (result i32)
    (local $idx i32) (local $left i32) (local $top i32) (local $right i32) (local $bottom i32)
    (local $rec i32)
    (if (i32.or (i32.lt_s (local.get $x) (i32.const 2))
                (i32.lt_s (local.get $y) (i32.const 2)))
      (then (return (i32.const -1))))
    (local.set $idx (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $idx) (i32.load (local.get $sw))))
      (if (i32.eqz (call $toolbar_button_rect (local.get $sw) (local.get $idx) (global.get $PAINT_SCRATCH)))
        (then (return (i32.const -1))))
      (local.set $left (i32.load (global.get $PAINT_SCRATCH)))
      (local.set $top (i32.load offset=4 (global.get $PAINT_SCRATCH)))
      (local.set $right (i32.load offset=8 (global.get $PAINT_SCRATCH)))
      (local.set $bottom (i32.load offset=12 (global.get $PAINT_SCRATCH)))
      (if (i32.and
            (i32.and
              (i32.ge_s (local.get $x) (local.get $left))
              (i32.lt_s (local.get $x) (local.get $right)))
            (i32.and
              (i32.ge_s (local.get $y) (local.get $top))
              (i32.lt_s (local.get $y) (local.get $bottom))))
        (then
          (if (i32.load offset=32 (local.get $sw))
            (then
              (local.set $rec (call $toolbar_button_ptr (local.get $sw) (local.get $idx)))
              (if (i32.or
                    (i32.and (i32.load8_u offset=8 (local.get $rec)) (i32.const 0x08))
                    (i32.and (i32.load8_u offset=9 (local.get $rec)) (i32.const 0x01)))
                (then (return (i32.const -1))))))
          (return (local.get $idx))))
      (local.set $idx (i32.add (local.get $idx) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  ;; Image-list handles in this runtime are guest pointers to the bounded
  ;; 24-byte ImageList record created by ImageList_Create/LoadImage. Toolbar
  ;; messages are also used by probes that pass opaque sentinel handles, so
  ;; validate both the translated address and record geometry before painting.
  (func $toolbar_imagelist_ptr (param $himl i32) (result i32)
    (local $wa i32) (local $cx i32) (local $cy i32)
    (if (i32.eqz (local.get $himl)) (then (return (i32.const 0))))
    (if (i32.lt_u (local.get $himl) (global.get $image_base))
      (then (return (i32.const 0))))
    (local.set $wa (call $g2w (local.get $himl)))
    (if (i32.gt_u
          (local.get $wa)
          (i32.sub (i32.shl (memory.size) (i32.const 16)) (i32.const 24)))
      (then (return (i32.const 0))))
    (local.set $cx (i32.load (local.get $wa)))
    (local.set $cy (i32.load offset=4 (local.get $wa)))
    (if (i32.or
          (i32.or (i32.le_s (local.get $cx) (i32.const 0))
                  (i32.gt_s (local.get $cx) (i32.const 256)))
          (i32.or (i32.le_s (local.get $cy) (i32.const 0))
                  (i32.gt_s (local.get $cy) (i32.const 256))))
      (then (return (i32.const 0))))
    (local.get $wa))

  (func $toolbar_repaint_now (param $hwnd i32)
    ;; Queue the common-control repaint through USER instead of drawing it
    ;; synchronously during layout. A direct child draw can be overwritten by
    ;; a still-dirty application-owned control-bar ancestor; the paint pump
    ;; orders that ancestor first and then drains this native child.
    (call $paint_flag_set_inv (local.get $hwnd)))

  (func $toolbar_autosize (param $hwnd i32)
    (local $idx i32) (local $state i32) (local $sw i32) (local $parent i32)
    (local $xy i32) (local $wh i32) (local $x i32) (local $y i32)
    (local $w i32) (local $h i32) (local $parent_w i32) (local $rows i32) (local $bh i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return)))
    (local.set $state (call $toolbar_ensure_state (local.get $hwnd)))
    (local.set $sw (call $g2w (local.get $state)))
    (local.set $xy (call $ctrl_get_xy_packed (local.get $hwnd)))
    (local.set $wh (call $ctrl_get_wh_packed (local.get $hwnd)))
    (local.set $x (i32.shr_s (i32.shl (local.get $xy) (i32.const 16)) (i32.const 16)))
    (local.set $y (i32.shr_s (local.get $xy) (i32.const 16)))
    (local.set $w (i32.and (local.get $wh) (i32.const 0xFFFF)))
    (local.set $h (i32.shr_u (local.get $wh) (i32.const 16)))
    (if (i32.le_s (local.get $w) (i32.const 0))
      (then
        (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
        (if (local.get $parent)
          (then (local.set $w (call $wnd_client_w_for_clip (local.get $parent)))))))
    (if (i32.le_s (local.get $w) (i32.const 0)) (then (local.set $w (i32.const 160))))
    ;; MFC control bars can cache the toolbar's ideal button span, then move
    ;; the child with SWP_NOSIZE. Keep the real child surface bounded by the
    ;; containing bar so oversized formatting toolbars do not allocate/dump as
    ;; multi-screen-wide children while still letting button positions extend
    ;; within the clipped parent.
    (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
    (if (local.get $parent)
      (then
        (local.set $parent_w (call $wnd_client_w_for_clip (local.get $parent)))
        (if (i32.and
              (i32.gt_s (local.get $parent_w) (i32.const 0))
              (i32.gt_s (local.get $w) (i32.add (local.get $parent_w) (i32.const 8))))
          (then (local.set $w (local.get $parent_w))))))
    (local.set $rows (call $toolbar_calc_rows (local.get $sw)))
    (if (i32.lt_s (local.get $rows) (i32.const 1))
      (then (local.set $rows (i32.const 1))))
    (i32.store offset=20 (local.get $sw) (local.get $rows))
    (local.set $bh (i32.load offset=8 (local.get $sw)))
    (if (i32.le_s (local.get $bh) (i32.const 0))
      (then (local.set $bh (i32.const 22))))
    (local.set $h
      (i32.add
        (i32.add
          (i32.mul (local.get $rows) (local.get $bh))
          (i32.mul (i32.sub (local.get $rows) (i32.const 1)) (i32.const 2)))
        (i32.const 6)))
    (if (i32.lt_s (local.get $h) (i32.const 24)) (then (local.set $h (i32.const 24))))
    (call $host_move_window (local.get $hwnd) (local.get $x) (local.get $y) (local.get $w) (local.get $h) (i32.const 0))
    (call $ctrl_geom_set (local.get $idx) (local.get $x) (local.get $y) (local.get $w) (local.get $h))
    (call $defwndproc_do_nccalcsize (local.get $hwnd))
    (call $toolbar_sync_child_combos (local.get $sw))
    (call $paint_flag_set_inv (local.get $hwnd))
    (call $toolbar_repaint_now (local.get $hwnd)))

  (func $toolbar_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $state i32) (local $sw i32) (local $hdc i32)
    (local $sz i32) (local $w i32) (local $h i32)
    (local $count i32) (local $i i32) (local $left i32) (local $top i32)
    (local $bw i32) (local $bh i32) (local $old i32) (local $rect i32)
    (local $src i32) (local $dst i32) (local $copy i32) (local $idx i32)
    (local $rec i32) (local $cmd i32) (local $parent i32)
    (local $x i32) (local $y i32) (local $state_byte i32) (local $hit i32)
    (local $bmp i32) (local $bmp_w i32) (local $bmp_h i32)
    (local $bmp_draw_w i32) (local $bmp_draw_h i32) (local $bmp_src_x i32)
    (local $bmp_dst_x i32) (local $bmp_dst_y i32) (local $memdc i32)
    (local $drawn i32) (local $image_list i32) (local $image_sw i32)
    (local $mask_color i32) (local $use_disabled_effect i32) (local $is_hot i32)

    ;; WM_DESTROY
    (if (i32.eq (local.get $msg) (i32.const 0x0002))
      (then
        (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))
        (if (local.get $state)
          (then
            (local.set $sw (call $g2w (local.get $state)))
            (if (i32.load offset=32 (local.get $sw))
              (then (call $heap_free (i32.load offset=32 (local.get $sw)))))
            (call $heap_free (local.get $state))
            (call $wnd_set_state_ptr (local.get $hwnd) (i32.const 0))))
        (return (i32.const 0))))

    (local.set $state (call $toolbar_ensure_state (local.get $hwnd)))
    (local.set $sw (call $g2w (local.get $state)))

    ;; WM_CREATE
    (if (i32.eq (local.get $msg) (i32.const 0x0001))
      (then
        (call $toolbar_autosize (local.get $hwnd))
        (return (i32.const 0))))

    ;; WM_ERASEBKGND
    (if (i32.eq (local.get $msg) (i32.const 0x0014))
      (then
        (drop (call $host_erase_background (local.get $hwnd) (i32.const 16)))
        (return (i32.const 1))))

    ;; TB_BUTTONSTRUCTSIZE (WM_USER+30): remember caller's TBBUTTON size.
    (if (i32.eq (local.get $msg) (i32.const 0x041E))
      (then
        (if (local.get $wParam)
          (then (i32.store offset=24 (local.get $sw) (local.get $wParam))))
        (return (i32.const 1))))

    ;; TB_ADDBITMAP (WM_USER+19): remember the caller's bitmap strip and
    ;; return the first allocated bitmap index.
    (if (i32.eq (local.get $msg) (i32.const 0x0413))
      (then
        (local.set $old (i32.load offset=28 (local.get $sw)))
        (local.set $bmp (i32.const 0))
        (if (local.get $lParam)
          (then
            (local.set $src (call $g2w (local.get $lParam)))
            (if (i32.eqz (i32.load (local.get $src)))
              (then
                ;; hInst == NULL: nID is already an HBITMAP.
                (local.set $bmp (i32.load offset=4 (local.get $src))))
              (else
                ;; hInst == HINST_COMMCTRL (-1) names a built-in common-control
                ;; strip; other non-NULL hInst values name app/DLL resources.
                (local.set $cmd (i32.load offset=4 (local.get $src)))
                (if (i32.le_u (local.get $cmd) (i32.const 0xFFFF))
                  (then
                    (local.set $cmd (i32.and (local.get $cmd) (i32.const 0xFFFF)))))
                (local.set $bmp
                  (call $host_gdi_load_bitmap
                    (i32.load (local.get $src))
                    (local.get $cmd)))))))
        (if (local.get $bmp)
          (then
            (local.set $bmp_w (call $host_gdi_get_object_w (local.get $bmp)))
            (if (i32.gt_s (local.get $bmp_w) (i32.const 0))
              (then
                ;; Bounded toolbar model: one strip per toolbar. Keep the
                ;; first valid strip so returned iBitmap bases keep indexing
                ;; into the original image list.
                (if (i32.eqz (i32.load offset=48 (local.get $sw)))
                  (then (i32.store offset=48 (local.get $sw) (local.get $bmp))))))))
        (i32.store offset=28 (local.get $sw)
          (i32.add (local.get $old) (local.get $wParam)))
        (call $toolbar_repaint_now (local.get $hwnd))
        (return (local.get $old))))

    ;; TB_ADDBUTTONSA / TB_ADDBUTTONSW: TBBUTTON itself contains no encoded
    ;; text, so both messages share the same record-copy path. Media Player 32
    ;; uses the Unicode message even for image-only buttons.
    (if (i32.or
          (i32.eq (local.get $msg) (i32.const 0x0414))
          (i32.eq (local.get $msg) (i32.const 0x0444)))
      (then
        (if (i32.gt_u (local.get $wParam) (i32.const 0))
          (then
            (local.set $count (i32.load (local.get $sw)))
            (if (i32.eqz
                  (call $toolbar_ensure_capacity
                    (local.get $sw)
                    (i32.add (local.get $count) (local.get $wParam))))
              (then (return (i32.const 0))))
            (local.set $i (i32.const 0))
            (block $done (loop $copy_buttons
              (br_if $done (i32.ge_u (local.get $i) (local.get $wParam)))
              (local.set $dst
                (call $toolbar_button_ptr
                  (local.get $sw)
                  (i32.add (local.get $count) (local.get $i))))
              (local.set $src (i32.const 0))
              (if (local.get $lParam)
                (then
                  (local.set $src
                    (i32.add
                      (local.get $lParam)
                      (i32.mul (local.get $i) (i32.load offset=24 (local.get $sw)))))))
              (call $toolbar_copy_button_in
                (local.get $dst)
                (local.get $src)
                (i32.load offset=24 (local.get $sw))
                (i32.add (local.get $count) (local.get $i)))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $copy_buttons)))
            (i32.store (local.get $sw)
              (i32.add (local.get $count) (local.get $wParam)))))
        (call $toolbar_autosize (local.get $hwnd))
        (return (i32.const 1))))

    ;; TB_INSERTBUTTONA/W: insert one TBBUTTON at wParam. TBBUTTON itself is
    ;; encoding-neutral; only optional text pointers differ, which this control
    ;; does not dereference while copying the record.
    (if (i32.or
          (i32.eq (local.get $msg) (i32.const 0x0415))
          (i32.eq (local.get $msg) (i32.const 0x0443)))
      (then
        (local.set $count (i32.load (local.get $sw)))
        (local.set $idx (local.get $wParam))
        (if (i32.gt_u (local.get $idx) (local.get $count))
          (then (local.set $idx (local.get $count))))
        (if (i32.eqz
              (call $toolbar_ensure_capacity
                (local.get $sw)
                (i32.add (local.get $count) (i32.const 1))))
          (then (return (i32.const 0))))
        (local.set $dst (call $toolbar_button_ptr (local.get $sw) (local.get $idx)))
        (if (i32.lt_u (local.get $idx) (local.get $count))
          (then
            (call $toolbar_memmove_right
              (local.get $dst)
              (i32.mul (i32.sub (local.get $count) (local.get $idx)) (i32.const 20))
              (i32.const 20))))
        (call $toolbar_copy_button_in
          (local.get $dst)
          (local.get $lParam)
          (i32.load offset=24 (local.get $sw))
          (local.get $idx))
        (i32.store (local.get $sw) (i32.add (local.get $count) (i32.const 1)))
        (call $toolbar_autosize (local.get $hwnd))
        (return (i32.const 1))))

    ;; TB_DELETEBUTTON (WM_USER+22): remove button by index.
    (if (i32.eq (local.get $msg) (i32.const 0x0416))
      (then
        (local.set $count (i32.load (local.get $sw)))
        (if (i32.ge_u (local.get $wParam) (local.get $count))
          (then (return (i32.const 0))))
        (local.set $dst (call $toolbar_button_ptr (local.get $sw) (local.get $wParam)))
        (if (i32.lt_u (i32.add (local.get $wParam) (i32.const 1)) (local.get $count))
          (then
            (call $memcpy
              (local.get $dst)
              (i32.add (local.get $dst) (i32.const 20))
              (i32.mul
                (i32.sub (i32.sub (local.get $count) (local.get $wParam)) (i32.const 1))
                (i32.const 20)))))
        (i32.store (local.get $sw) (i32.sub (local.get $count) (i32.const 1)))
        (if (i32.eq (i32.load offset=40 (local.get $sw)) (local.get $wParam))
          (then (i32.store offset=40 (local.get $sw) (i32.const -1))))
        (call $toolbar_autosize (local.get $hwnd))
        (return (i32.const 1))))

    ;; TB_GETBUTTON (WM_USER+23): copy the stored TBBUTTON by index.
    (if (i32.eq (local.get $msg) (i32.const 0x0417))
      (then
        (if (i32.or
              (i32.eqz (local.get $lParam))
              (i32.ge_u (local.get $wParam) (i32.load (local.get $sw))))
          (then (return (i32.const 0))))
        (local.set $rect (call $g2w (local.get $lParam)))
        (local.set $copy (i32.load offset=24 (local.get $sw)))
        (if (i32.gt_u (local.get $copy) (i32.const 20))
          (then (local.set $copy (i32.const 20))))
        (if (i32.eqz (local.get $copy))
          (then (return (i32.const 0))))
        (if (i32.load offset=32 (local.get $sw))
          (then
            (call $memcpy
              (local.get $rect)
              (call $toolbar_button_ptr (local.get $sw) (local.get $wParam))
              (local.get $copy)))
          (else
            (call $toolbar_init_button (local.get $rect) (local.get $wParam))))
        (return (i32.const 1))))

    ;; TB_GETRECT (WM_USER+51): command ID -> RECT.
    (if (i32.eq (local.get $msg) (i32.const 0x0433))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $idx (call $toolbar_find_command_index (local.get $sw) (local.get $wParam)))
        (if (i32.lt_s (local.get $idx) (i32.const 0)) (then (return (i32.const 0))))
        (local.set $rect (call $g2w (local.get $lParam)))
        (return (call $toolbar_button_rect (local.get $sw) (local.get $idx) (local.get $rect)))))

    ;; TB_GETBITMAP / TB_GETBUTTONTEXTA. The bounded toolbar stores command
    ;; records but not string tables, so text lookup is an empty successful
    ;; copy when a buffer is supplied.
    (if (i32.eq (local.get $msg) (i32.const 0x042C))
      (then
        (local.set $idx (call $toolbar_find_command_index (local.get $sw) (local.get $wParam)))
        (if (i32.lt_s (local.get $idx) (i32.const 0)) (then (return (i32.const -1))))
        (local.set $rec (call $toolbar_button_ptr (local.get $sw) (local.get $idx)))
        (return (i32.load (local.get $rec)))))
    (if (i32.eq (local.get $msg) (i32.const 0x042D))
      (then
        (if (local.get $lParam)
          (then (i32.store8 (call $g2w (local.get $lParam)) (i32.const 0))))
        (return (i32.const 0))))

    ;; TB_BUTTONCOUNT (WM_USER+24), TB_GETROWS (WM_USER+40).
    (if (i32.eq (local.get $msg) (i32.const 0x0418))
      (then (return (i32.load (local.get $sw)))))
    (if (i32.eq (local.get $msg) (i32.const 0x0428))
      (then (return (i32.load offset=20 (local.get $sw)))))
    ;; TB_COMMANDTOINDEX (WM_USER+25): map command ID to button index.
    (if (i32.eq (local.get $msg) (i32.const 0x0419))
      (then (return (call $toolbar_find_command_index (local.get $sw) (local.get $wParam)))))

    ;; TB_GETITEMRECT (WM_USER+29): lParam -> RECT for button index wParam.
    (if (i32.eq (local.get $msg) (i32.const 0x041D))
      (then
        (if (i32.or
              (i32.eqz (local.get $lParam))
              (i32.ge_u (local.get $wParam) (i32.load (local.get $sw))))
          (then (return (i32.const 0))))
        (local.set $rect (call $g2w (local.get $lParam)))
        (local.set $hit (call $toolbar_button_rect
          (local.get $sw)
          (local.get $wParam)
          (local.get $rect)))
        (return (local.get $hit))))

    ;; TB_SETBUTTONSIZE / TB_SETBITMAPSIZE / TB_AUTOSIZE.
    (if (i32.eq (local.get $msg) (i32.const 0x041F))
      (then
        (local.set $bw (i32.and (local.get $lParam) (i32.const 0xFFFF)))
        (local.set $bh (i32.shr_u (local.get $lParam) (i32.const 16)))
        (if (i32.gt_u (local.get $bw) (i32.const 0)) (then (i32.store offset=4 (local.get $sw) (local.get $bw))))
        (if (i32.gt_u (local.get $bh) (i32.const 0)) (then (i32.store offset=8 (local.get $sw) (local.get $bh))))
        (call $toolbar_autosize (local.get $hwnd))
        (return (i32.const 1))))
    (if (i32.eq (local.get $msg) (i32.const 0x0420))
      (then
        (local.set $bw (i32.and (local.get $lParam) (i32.const 0xFFFF)))
        (local.set $bh (i32.shr_u (local.get $lParam) (i32.const 16)))
        (if (i32.gt_u (local.get $bw) (i32.const 0)) (then (i32.store offset=12 (local.get $sw) (local.get $bw))))
        (if (i32.gt_u (local.get $bh) (i32.const 0)) (then (i32.store offset=16 (local.get $sw) (local.get $bh))))
        (return (i32.const 1))))
    (if (i32.eq (local.get $msg) (i32.const 0x0421))
      (then
        (call $toolbar_autosize (local.get $hwnd))
        (return (i32.const 0))))

    ;; TB_GETBUTTONSIZE (WM_USER+58), TB_SETROWS (WM_USER+39).
    (if (i32.eq (local.get $msg) (i32.const 0x043A))
      (then
        (return
          (i32.or
            (i32.and (i32.load offset=4 (local.get $sw)) (i32.const 0xFFFF))
            (i32.shl (i32.load offset=8 (local.get $sw)) (i32.const 16))))))
    (if (i32.eq (local.get $msg) (i32.const 0x0427))
      (then
        (if (i32.gt_u (i32.and (local.get $wParam) (i32.const 0xFFFF)) (i32.const 0))
          (then (i32.store offset=20 (local.get $sw) (i32.and (local.get $wParam) (i32.const 0xFFFF)))))
        (call $toolbar_autosize (local.get $hwnd))
        (return (i32.const 0))))

    ;; TB_SETIMAGELIST / TB_GETIMAGELIST and hot/disabled variants.
    (if (i32.eq (local.get $msg) (i32.const 0x0430))
      (then
        (local.set $old (i32.load offset=52 (local.get $sw)))
        (i32.store offset=52 (local.get $sw) (local.get $lParam))
        (call $toolbar_repaint_now (local.get $hwnd))
        (return (local.get $old))))
    (if (i32.eq (local.get $msg) (i32.const 0x0431))
      (then (return (i32.load offset=52 (local.get $sw)))))
    (if (i32.eq (local.get $msg) (i32.const 0x0434))
      (then
        (local.set $old (i32.load offset=56 (local.get $sw)))
        (i32.store offset=56 (local.get $sw) (local.get $lParam))
        (call $toolbar_repaint_now (local.get $hwnd))
        (return (local.get $old))))
    (if (i32.eq (local.get $msg) (i32.const 0x0435))
      (then (return (i32.load offset=56 (local.get $sw)))))
    (if (i32.eq (local.get $msg) (i32.const 0x0436))
      (then
        (local.set $old (i32.load offset=60 (local.get $sw)))
        (i32.store offset=60 (local.get $sw) (local.get $lParam))
        (call $toolbar_repaint_now (local.get $hwnd))
        (return (local.get $old))))
    (if (i32.eq (local.get $msg) (i32.const 0x0437))
      (then (return (i32.load offset=60 (local.get $sw)))))

    ;; TB_GETHOTITEM / TB_SETHOTITEM. The hot item is an index, not a command
    ;; id. Return the previous index exactly as the common-control contract
    ;; requires and repaint so flat toolbar edges/image lists switch at once.
    (if (i32.eq (local.get $msg) (i32.const 0x0447))
      (then (return (i32.load offset=76 (local.get $sw)))))
    (if (i32.eq (local.get $msg) (i32.const 0x0448))
      (then
        (local.set $old (i32.load offset=76 (local.get $sw)))
        (local.set $idx (local.get $wParam))
        (if (i32.and
              (i32.ne (local.get $idx) (i32.const -1))
              (i32.ge_u (local.get $idx) (i32.load (local.get $sw))))
          (then (local.set $idx (i32.const -1))))
        (i32.store offset=76 (local.get $sw) (local.get $idx))
        (if (i32.ne (local.get $idx) (local.get $old))
          (then (call $toolbar_repaint_now (local.get $hwnd))))
        (return (local.get $old))))

    ;; TB_SETSTYLE / TB_GETSTYLE / TB_SETEXTENDEDSTYLE / TB_GETEXTENDEDSTYLE.
    (if (i32.eq (local.get $msg) (i32.const 0x0438))
      (then
        (i32.store offset=64 (local.get $sw) (local.get $lParam))
        (call $paint_flag_set_inv (local.get $hwnd))
        (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0439))
      (then (return (i32.load offset=64 (local.get $sw)))))
    (if (i32.eq (local.get $msg) (i32.const 0x0454))
      (then
        (local.set $old (i32.load offset=68 (local.get $sw)))
        (if (local.get $wParam)
          (then
            (i32.store offset=68 (local.get $sw)
              (i32.or (i32.and (local.get $old) (i32.xor (local.get $wParam) (i32.const -1)))
                      (i32.and (local.get $lParam) (local.get $wParam)))))
          (else
            (i32.store offset=68 (local.get $sw) (local.get $lParam))))
        (return (local.get $old))))
    (if (i32.eq (local.get $msg) (i32.const 0x0455))
      (then (return (i32.load offset=68 (local.get $sw)))))

    ;; TB_SETPADDING / TB_GETPADDING.
    (if (i32.eq (local.get $msg) (i32.const 0x0457))
      (then
        (local.set $old (i32.load offset=72 (local.get $sw)))
        (i32.store offset=72 (local.get $sw) (local.get $lParam))
        (return (local.get $old))))
    (if (i32.eq (local.get $msg) (i32.const 0x0456))
      (then (return (i32.load offset=72 (local.get $sw)))))

    ;; Basic state/probe messages by command ID.
    (if (i32.or
          (i32.or (i32.eq (local.get $msg) (i32.const 0x0409)) ;; TB_ISBUTTONENABLED
                  (i32.eq (local.get $msg) (i32.const 0x040A))) ;; TB_ISBUTTONCHECKED
          (i32.or
            (i32.or (i32.eq (local.get $msg) (i32.const 0x040B)) ;; TB_ISBUTTONPRESSED
                    (i32.eq (local.get $msg) (i32.const 0x040C))) ;; TB_ISBUTTONHIDDEN
            (i32.or (i32.eq (local.get $msg) (i32.const 0x040D)) ;; TB_ISBUTTONINDETERMINATE
                    (i32.eq (local.get $msg) (i32.const 0x0412))))) ;; TB_GETSTATE
      (then
        (local.set $idx (call $toolbar_find_command_index (local.get $sw) (local.get $wParam)))
        (if (i32.lt_s (local.get $idx) (i32.const 0))
          (then
            (if (i32.eq (local.get $msg) (i32.const 0x0412))
              (then (return (i32.const -1))))
            (return (i32.const 0))))
        (local.set $rec (call $toolbar_button_ptr (local.get $sw) (local.get $idx)))
        (local.set $state_byte (i32.load8_u offset=8 (local.get $rec)))
        (if (i32.eq (local.get $msg) (i32.const 0x0412))
          (then (return (local.get $state_byte))))
        (if (i32.eq (local.get $msg) (i32.const 0x0409))
          (then (return (select (i32.const 1) (i32.const 0)
            (i32.ne (i32.and (local.get $state_byte) (i32.const 0x04)) (i32.const 0))))))
        (if (i32.eq (local.get $msg) (i32.const 0x040A))
          (then (return (select (i32.const 1) (i32.const 0)
            (i32.ne (i32.and (local.get $state_byte) (i32.const 0x01)) (i32.const 0))))))
        (if (i32.eq (local.get $msg) (i32.const 0x040B))
          (then (return (select (i32.const 1) (i32.const 0)
            (i32.ne (i32.and (local.get $state_byte) (i32.const 0x02)) (i32.const 0))))))
        (if (i32.eq (local.get $msg) (i32.const 0x040C))
          (then (return (select (i32.const 1) (i32.const 0)
            (i32.ne (i32.and (local.get $state_byte) (i32.const 0x08)) (i32.const 0))))))
        (return (select (i32.const 1) (i32.const 0)
          (i32.ne (i32.and (local.get $state_byte) (i32.const 0x10)) (i32.const 0))))))

    ;; TB_ENABLEBUTTON / TB_CHECKBUTTON / TB_PRESSBUTTON /
    ;; TB_HIDEBUTTON / TB_INDETERMINATE.
    (if (i32.or
          (i32.or (i32.eq (local.get $msg) (i32.const 0x0401))
                  (i32.eq (local.get $msg) (i32.const 0x0402)))
          (i32.or
            (i32.or (i32.eq (local.get $msg) (i32.const 0x0403))
                    (i32.eq (local.get $msg) (i32.const 0x0404)))
            (i32.eq (local.get $msg) (i32.const 0x0405))))
      (then
        (local.set $state_byte (i32.const 0x04))
        (if (i32.eq (local.get $msg) (i32.const 0x0402)) (then (local.set $state_byte (i32.const 0x01))))
        (if (i32.eq (local.get $msg) (i32.const 0x0403)) (then (local.set $state_byte (i32.const 0x02))))
        (if (i32.eq (local.get $msg) (i32.const 0x0404)) (then (local.set $state_byte (i32.const 0x08))))
        (if (i32.eq (local.get $msg) (i32.const 0x0405)) (then (local.set $state_byte (i32.const 0x10))))
        (drop (call $toolbar_update_state_bit
          (local.get $sw)
          (local.get $wParam)
          (local.get $state_byte)
          (local.get $lParam)))
        (call $paint_flag_set_inv (local.get $hwnd))
        (call $toolbar_repaint_now (local.get $hwnd))
        (return (i32.const 1))))

    ;; TB_SETSTATE (WM_USER+17): replace fsState for command ID.
    (if (i32.eq (local.get $msg) (i32.const 0x0411))
      (then
        (local.set $idx (call $toolbar_find_command_index (local.get $sw) (local.get $wParam)))
        (if (i32.lt_s (local.get $idx) (i32.const 0))
          (then (return (i32.const 0))))
        (local.set $rec (call $toolbar_button_ptr (local.get $sw) (local.get $idx)))
        (i32.store8 offset=8 (local.get $rec) (local.get $lParam))
        (call $paint_flag_set_inv (local.get $hwnd))
        (call $toolbar_repaint_now (local.get $hwnd))
        (return (i32.const 1))))

    ;; TB_HITTEST (WM_USER+69): lParam points to a POINT in toolbar coords.
    (if (i32.eq (local.get $msg) (i32.const 0x0445))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const -1))))
        (local.set $rect (call $g2w (local.get $lParam)))
        (return
          (call $toolbar_hit_test
            (local.get $sw)
            (i32.load (local.get $rect))
            (i32.load offset=4 (local.get $rect))))))

    ;; WM_MOUSEMOVE / WM_MOUSELEAVE maintain the hot index used by flat edges
    ;; and the optional hot image list. Disabled buttons do not become hot.
    (if (i32.eq (local.get $msg) (i32.const 0x0200))
      (then
        (local.set $x (i32.shr_s (i32.shl (local.get $lParam) (i32.const 16)) (i32.const 16)))
        (local.set $y (i32.shr_s (local.get $lParam) (i32.const 16)))
        (local.set $hit (call $toolbar_hit_test (local.get $sw) (local.get $x) (local.get $y)))
        (if (i32.ge_s (local.get $hit) (i32.const 0))
          (then
            (local.set $rec (call $toolbar_button_ptr (local.get $sw) (local.get $hit)))
            (if (i32.eqz (i32.and (i32.load8_u offset=8 (local.get $rec)) (i32.const 0x04)))
              (then (local.set $hit (i32.const -1))))))
        (if (i32.ne (local.get $hit) (i32.load offset=76 (local.get $sw)))
          (then
            (i32.store offset=76 (local.get $sw) (local.get $hit))
            (call $toolbar_repaint_now (local.get $hwnd))))
        (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x02A3))
      (then
        (if (i32.ne (i32.load offset=76 (local.get $sw)) (i32.const -1))
          (then
            (i32.store offset=76 (local.get $sw) (i32.const -1))
            (call $toolbar_repaint_now (local.get $hwnd))))
        (return (i32.const 0))))

    ;; WM_LBUTTONDOWN: remember the pressed button by hit-tested index.
    (if (i32.eq (local.get $msg) (i32.const 0x0201))
      (then
        (local.set $x (i32.shr_s (i32.shl (local.get $lParam) (i32.const 16)) (i32.const 16)))
        (local.set $y (i32.shr_s (local.get $lParam) (i32.const 16)))
        (local.set $hit (call $toolbar_hit_test (local.get $sw) (local.get $x) (local.get $y)))
        (i32.store offset=40 (local.get $sw) (local.get $hit))
        (if (i32.ge_s (local.get $hit) (i32.const 0))
          (then
            (local.set $rec (call $toolbar_button_ptr (local.get $sw) (local.get $hit)))
            (if (i32.eqz (i32.and (i32.load8_u offset=8 (local.get $rec)) (i32.const 0x04)))
              (then
                (i32.store offset=40 (local.get $sw) (i32.const -1))
                (return (i32.const 0))))
            (i32.store8 offset=8 (local.get $rec)
              (i32.or (i32.load8_u offset=8 (local.get $rec)) (i32.const 0x02)))
            (global.set $capture_hwnd (local.get $hwnd))
            (call $paint_flag_set_inv (local.get $hwnd))
            (call $toolbar_repaint_now (local.get $hwnd))))
        (return (i32.const 0))))

    ;; WM_LBUTTONUP: clear pressed state and send WM_COMMAND(idCommand, hwnd).
    (if (i32.eq (local.get $msg) (i32.const 0x0202))
      (then
        (local.set $x (i32.shr_s (i32.shl (local.get $lParam) (i32.const 16)) (i32.const 16)))
        (local.set $y (i32.shr_s (local.get $lParam) (i32.const 16)))
        (local.set $hit (call $toolbar_hit_test (local.get $sw) (local.get $x) (local.get $y)))
        (local.set $idx (i32.load offset=40 (local.get $sw)))
        (i32.store offset=40 (local.get $sw) (i32.const -1))
        (if (i32.eq (global.get $capture_hwnd) (local.get $hwnd))
          (then (global.set $capture_hwnd (i32.const 0))))
        (if (i32.ge_s (local.get $idx) (i32.const 0))
          (then
            (local.set $rec (call $toolbar_button_ptr (local.get $sw) (local.get $idx)))
            (i32.store8 offset=8 (local.get $rec)
              (i32.and (i32.load8_u offset=8 (local.get $rec)) (i32.const 0xFD)))
            (call $paint_flag_set_inv (local.get $hwnd))
            (call $toolbar_repaint_now (local.get $hwnd))
            (if (i32.and
                  (i32.eq (local.get $idx) (local.get $hit))
                  (i32.and
                    (i32.ne (i32.load offset=4 (local.get $rec)) (i32.const 0))
                    (i32.ne (i32.and (i32.load8_u offset=8 (local.get $rec)) (i32.const 0x04)) (i32.const 0))))
              (then
                (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
                (if (local.get $parent)
                  (then
                    (drop (call $wnd_send_message
                      (local.get $parent)
                      (i32.const 0x0111)
                      (i32.and (i32.load offset=4 (local.get $rec)) (i32.const 0xFFFF))
                      (local.get $hwnd)))))))))
        (return (i32.const 0))))

    ;; WM_PAINT
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        ;; Native toolbar paints start with a fresh BeginPaint-style clip.
        ;; Synthetic hwnd+0x40000 DCs can retain an empty clip from prior MFC
        ;; control-bar drawing, erasing the row while clipping every button.
        (drop (call $host_gdi_select_clip_rgn (local.get $hdc) (i32.const 0)))
        (call $dc_apply_client_clip (local.get $hdc) (local.get $hwnd))
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        (if (i32.and (i32.gt_s (local.get $w) (i32.const 0))
                     (i32.gt_s (local.get $h) (i32.const 0)))
          (then
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.const 0) (i32.const 0)
                    (local.get $w) (local.get $h)
                    (i32.const 0x30011))) ;; COLOR_BTNFACE approximation.
            (drop (call $host_gdi_draw_edge (local.get $hdc)
                    (i32.const 0) (i32.const 0)
                    (local.get $w) (local.get $h)
                    (i32.const 0x04) (i32.const 0x08))) ;; BDR_RAISEDINNER | BF_BOTTOM
            (local.set $count (i32.load (local.get $sw)))
            (local.set $bh (i32.load offset=8 (local.get $sw)))
            (if (i32.lt_s (local.get $count) (i32.const 1))
              (then (local.set $count (i32.const 1))))
            (local.set $i (i32.const 0))
            (block $done (loop $buttons
              (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
              (if (i32.eqz (call $toolbar_button_rect (local.get $sw) (local.get $i) (global.get $PAINT_SCRATCH)))
                (then (br $done)))
              (local.set $left (i32.load (global.get $PAINT_SCRATCH)))
              (local.set $top (i32.load offset=4 (global.get $PAINT_SCRATCH)))
              (local.set $bw (i32.sub
                (i32.load offset=8 (global.get $PAINT_SCRATCH))
                (local.get $left)))
              (local.set $bh (i32.sub
                (i32.load offset=12 (global.get $PAINT_SCRATCH))
                (local.get $top)))
              (br_if $done (i32.ge_s (local.get $top) (i32.sub (local.get $h) (i32.const 2))))
              (local.set $state_byte (i32.const 4))
              (if (i32.load offset=32 (local.get $sw))
                (then
                  (local.set $rec (call $toolbar_button_ptr (local.get $sw) (local.get $i)))
                  (local.set $state_byte (i32.load8_u offset=8 (local.get $rec)))))
              (local.set $hit
                (i32.ne
                  (i32.and (local.get $state_byte) (i32.const 0x03)) ;; CHECKED | PRESSED
                  (i32.const 0)))
              (local.set $is_hot
                (i32.eq (local.get $i) (i32.load offset=76 (local.get $sw))))
              (if (i32.and (local.get $state_byte) (i32.const 0x08))
                (then
                  (local.set $i (i32.add (local.get $i) (i32.const 1)))
                  (br $buttons)))
              (if (i32.and
                    (i32.and (i32.ne (i32.load offset=32 (local.get $sw)) (i32.const 0))
                      (i32.ne (local.get $rec) (i32.const 0)))
                    (i32.and (i32.load8_u offset=9 (local.get $rec)) (i32.const 0x01)))
                (then
                  (if (i32.gt_s (local.get $bw) (i32.const 8))
                    (then
                      (drop (call $host_gdi_draw_edge (local.get $hdc)
                        (i32.add (local.get $left) (i32.const 3))
                        (i32.add (local.get $top) (i32.const 3))
                        (i32.add (local.get $left) (i32.const 5))
                        (i32.sub (i32.add (local.get $top) (local.get $bh)) (i32.const 3))
                        (i32.const 0x0A)
                        (i32.const 0x04)))))
                  (local.set $i (i32.add (local.get $i) (i32.const 1)))
                  (br $buttons)))
              ;; TBSTYLE_FLAT keeps idle/disabled button faces borderless.
              ;; The Win98 common control raises a flat button while it is hot
              ;; and sinks it while pressed/checked.
              (if (i32.or
                    (i32.or (local.get $hit) (local.get $is_hot))
                    (i32.eqz (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x0800))))
                (then
                  (drop (call $host_gdi_draw_edge (local.get $hdc)
                          (local.get $left) (local.get $top)
                          (i32.add (local.get $left) (local.get $bw))
                          (i32.add (local.get $top) (local.get $bh))
                          (select (i32.const 0x0A) (i32.const 0x05) (local.get $hit))
                          (i32.const 0x0F))))) ;; EDGE_RAISED/SUNKEN | BF_RECT
              (local.set $drawn (i32.const 0))
              (local.set $bmp (i32.load offset=48 (local.get $sw)))
              (local.set $bmp_draw_w (i32.load offset=12 (local.get $sw)))
              (local.set $bmp_draw_h (i32.load offset=16 (local.get $sw)))
              (local.set $mask_color (i32.const 0x00C0C0C0))
              (local.set $use_disabled_effect
                (i32.eqz (i32.and (local.get $state_byte) (i32.const 0x04))))
              ;; Prefer a state-specific image list, then the normal image
              ;; list, then the legacy TB_ADDBITMAP strip. A disabled image
              ;; list already contains its intended pixels and must not be
              ;; embossed a second time.
              (local.set $image_list (i32.const 0))
              (if (local.get $use_disabled_effect)
                (then (local.set $image_list (i32.load offset=60 (local.get $sw))))
                (else
                  (if (local.get $is_hot)
                    (then (local.set $image_list (i32.load offset=56 (local.get $sw)))))))
              (local.set $image_sw
                (call $toolbar_imagelist_ptr (local.get $image_list)))
              (if (i32.eqz (local.get $image_sw))
                (then
                  (local.set $image_list (i32.load offset=52 (local.get $sw)))
                  (local.set $image_sw
                    (call $toolbar_imagelist_ptr (local.get $image_list)))))
              (if (local.get $image_sw)
                (then
                  (local.set $bmp (i32.load offset=16 (local.get $image_sw)))
                  (local.set $bmp_draw_w (i32.load (local.get $image_sw)))
                  (local.set $bmp_draw_h (i32.load offset=4 (local.get $image_sw)))
                  (local.set $mask_color (i32.load offset=20 (local.get $image_sw)))
                  (if (i32.ne
                        (local.get $image_list)
                        (i32.load offset=52 (local.get $sw)))
                    (then (local.set $use_disabled_effect (i32.const 0))))))
              (if (i32.and
                    (i32.and
                      (i32.ne (i32.load offset=32 (local.get $sw)) (i32.const 0))
                      (i32.ne (local.get $rec) (i32.const 0)))
                    (i32.and
                      (i32.ge_s (i32.load (local.get $rec)) (i32.const 0))
                      (i32.ne (local.get $bmp) (i32.const 0))))
                (then
                  (local.set $bmp_w (call $host_gdi_get_object_w (local.get $bmp)))
                  (local.set $bmp_h (call $host_gdi_get_object_h (local.get $bmp)))
                  (if (i32.le_s (local.get $bmp_draw_w) (i32.const 0))
                    (then (local.set $bmp_draw_w (i32.const 16))))
                  (if (i32.le_s (local.get $bmp_draw_h) (i32.const 0))
                    (then (local.set $bmp_draw_h (i32.const 16))))
                  (local.set $bmp_src_x
                    (i32.mul (i32.load (local.get $rec)) (local.get $bmp_draw_w)))
                  (if (i32.and
                        (i32.and
                          (i32.gt_s (local.get $bmp_w) (i32.const 0))
                          (i32.gt_s (local.get $bmp_h) (i32.const 0)))
                        (i32.and
                          (i32.le_s (i32.add (local.get $bmp_src_x) (local.get $bmp_draw_w)) (local.get $bmp_w))
                          (i32.le_s (local.get $bmp_draw_h) (local.get $bmp_h))))
                    (then
                      (local.set $bmp_dst_x
                        (i32.add
                          (i32.add
                            (local.get $left)
                            (i32.div_s
                              (i32.sub (local.get $bw) (local.get $bmp_draw_w))
                              (i32.const 2)))
                          (local.get $hit)))
                      (local.set $bmp_dst_y
                        (i32.add
                          (i32.add
                            (local.get $top)
                            (i32.div_s
                              (i32.sub (local.get $bh) (local.get $bmp_draw_h))
                              (i32.const 2)))
                          (local.get $hit)))
                      (local.set $memdc (call $host_gdi_create_compat_dc (local.get $hdc)))
                      (if (local.get $memdc)
                        (then
                          (drop (call $host_gdi_select_object (local.get $memdc) (local.get $bmp)))
                          (local.set $drawn
                            (if (result i32)
                              (i32.eqz (local.get $use_disabled_effect))
                              (then
                                (call $host_gdi_transparent_blt
                                  (local.get $hdc)
                                  (local.get $bmp_dst_x) (local.get $bmp_dst_y)
                                  (local.get $bmp_draw_w) (local.get $bmp_draw_h)
                                  (local.get $memdc)
                                  (local.get $bmp_src_x) (i32.const 0)
                                  (local.get $mask_color)))
                              (else
                                (call $host_gdi_disabled_blt
                                  (local.get $hdc)
                                  (local.get $bmp_dst_x) (local.get $bmp_dst_y)
                                  (local.get $bmp_draw_w) (local.get $bmp_draw_h)
                                  (local.get $memdc)
                                  (local.get $bmp_src_x) (i32.const 0)
                                  (local.get $mask_color)))))
                          (drop (call $host_gdi_delete_dc (local.get $memdc)))))))))
              (if (i32.eqz (local.get $drawn))
                (then
                  ;; Fallback glyph: a small dark mark inside each button, so
                  ;; screenshots still distinguish toolbar buttons from a plain
                  ;; gray band when no app bitmap strip is available.
                  (drop (call $host_gdi_fill_rect (local.get $hdc)
                          (i32.add (i32.add (local.get $left) (i32.const 8)) (local.get $hit))
                          (i32.add (i32.add (local.get $top) (i32.const 7)) (local.get $hit))
                          (i32.add (i32.add (local.get $left) (i32.const 15)) (local.get $hit))
                          (i32.add (i32.add (local.get $top) (i32.const 14)) (local.get $hit))
                          (i32.const 0x30012)))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $buttons)))))
        (return (i32.const 0))))

    (i32.const 0))

  ;; ---- Tooltip WndProc ----
  ;;
  ;; Stateful tooltips_class32 subset. State layout:
  ;; +0 items_guest (array of 48-byte TOOLINFOA snapshots)
  ;; +4 count, +8 capacity, +12 active flag, +16 current index
  ;; +20 bk color, +24 text color, +28 max tip width, +32 autopop delay
  ;; +36 initial delay, +40 reshow delay, +44 margin l/t/r/b.
  (func $tooltip_item_ptr (param $sw i32) (param $idx i32) (result i32)
    (i32.add (call $g2w (i32.load (local.get $sw)))
             (i32.mul (local.get $idx) (i32.const 48))))

  (func $tooltip_find_tool (param $sw i32) (param $tool_hwnd i32) (param $tool_id i32) (result i32)
    (local $i i32) (local $count i32) (local $rec i32)
    (local.set $count (i32.load offset=4 (local.get $sw)))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $rec (call $tooltip_item_ptr (local.get $sw) (local.get $i)))
      (if (i32.and
            (i32.eq (i32.load offset=8 (local.get $rec)) (local.get $tool_hwnd))
            (i32.eq (i32.load offset=12 (local.get $rec)) (local.get $tool_id)))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  (func $tooltip_hit_test (param $sw i32) (param $tool_hwnd i32) (param $x i32) (param $y i32) (result i32)
    (local $i i32) (local $count i32) (local $rec i32)
    (local.set $count (i32.load offset=4 (local.get $sw)))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $rec (call $tooltip_item_ptr (local.get $sw) (local.get $i)))
      (if (i32.and
            (i32.eq (i32.load offset=8 (local.get $rec)) (local.get $tool_hwnd))
            (i32.and
              (i32.ge_s (local.get $x) (i32.load offset=16 (local.get $rec)))
              (i32.and
                (i32.lt_s (local.get $x) (i32.load offset=24 (local.get $rec)))
                (i32.and
                  (i32.ge_s (local.get $y) (i32.load offset=20 (local.get $rec)))
                  (i32.lt_s (local.get $y) (i32.load offset=28 (local.get $rec)))))))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  (func $tooltip_copy_in (param $dst i32) (param $src_guest i32)
    (local $src i32) (local $size i32)
    (local.set $src (call $g2w (local.get $src_guest)))
    (call $zero_memory (local.get $dst) (i32.const 48))
    (if (i32.eqz (local.get $src_guest)) (then (return)))
    (local.set $size (i32.load (local.get $src)))
    (if (i32.gt_u (local.get $size) (i32.const 48)) (then (local.set $size (i32.const 48))))
    (if (i32.lt_u (local.get $size) (i32.const 40)) (then (local.set $size (i32.const 40))))
    (call $memcpy (local.get $dst) (local.get $src) (local.get $size)))

  (func $tooltip_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $state i32) (local $sw i32) (local $items i32) (local $new_items i32)
    (local $count i32) (local $cap i32) (local $idx i32) (local $rec i32)
    (local $src i32) (local $dst i32) (local $text_src i32) (local $text_dst i32)
    (local $len i32) (local $ti i32) (local $x i32) (local $y i32) (local $old i32)

    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $state))
      (then
        (local.set $state (call $heap_alloc (i32.const 64)))
        (local.set $sw (call $g2w (local.get $state)))
        (call $zero_memory (local.get $sw) (i32.const 64))
        (local.set $items (call $heap_alloc (i32.mul (i32.const 4) (i32.const 48))))
        (call $zero_memory (call $g2w (local.get $items)) (i32.mul (i32.const 4) (i32.const 48)))
        (i32.store (local.get $sw) (local.get $items))
        (i32.store offset=8 (local.get $sw) (i32.const 4))
        (i32.store offset=12 (local.get $sw) (i32.const 1))
        (i32.store offset=16 (local.get $sw) (i32.const -1))
        (i32.store offset=20 (local.get $sw) (i32.const 0x00FFFFE1))
        (i32.store offset=24 (local.get $sw) (i32.const 0x00000000))
        (i32.store offset=28 (local.get $sw) (i32.const -1))
        (i32.store offset=32 (local.get $sw) (i32.const 5000))
        (i32.store offset=36 (local.get $sw) (i32.const 500))
        (i32.store offset=40 (local.get $sw) (i32.const 100))
        (call $wnd_set_state_ptr (local.get $hwnd) (local.get $state))))
    (local.set $sw (call $g2w (local.get $state)))

    ;; WM_CREATE
    (if (i32.eq (local.get $msg) (i32.const 0x0001)) (then (return (i32.const 0))))
    ;; WM_DESTROY
    (if (i32.eq (local.get $msg) (i32.const 0x0002))
      (then
        (call $heap_free (i32.load (local.get $sw)))
        (call $heap_free (local.get $state))
        (call $wnd_set_state_ptr (local.get $hwnd) (i32.const 0))
        (return (i32.const 0))))

    ;; TTM_ACTIVATE
    (if (i32.eq (local.get $msg) (i32.const 0x0401))
      (then
        (i32.store offset=12 (local.get $sw) (select (i32.const 1) (i32.const 0) (i32.ne (local.get $wParam) (i32.const 0))))
        (return (i32.const 0))))

    ;; TTM_SETDELAYTIME / TTM_GETDELAYTIME
    (if (i32.eq (local.get $msg) (i32.const 0x0403))
      (then
        (if (i32.eq (local.get $wParam) (i32.const 1)) (then (i32.store offset=40 (local.get $sw) (local.get $lParam))))
        (if (i32.eq (local.get $wParam) (i32.const 2)) (then (i32.store offset=32 (local.get $sw) (local.get $lParam))))
        (if (i32.eq (local.get $wParam) (i32.const 3)) (then (i32.store offset=36 (local.get $sw) (local.get $lParam))))
        (if (i32.eq (local.get $wParam) (i32.const 0))
          (then
            (i32.store offset=36 (local.get $sw) (local.get $lParam))
            (i32.store offset=40 (local.get $sw) (i32.div_s (local.get $lParam) (i32.const 5)))
            (i32.store offset=32 (local.get $sw) (i32.mul (local.get $lParam) (i32.const 10)))))
        (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0415))
      (then
        (if (i32.eq (local.get $wParam) (i32.const 1)) (then (return (i32.load offset=40 (local.get $sw)))))
        (if (i32.eq (local.get $wParam) (i32.const 2)) (then (return (i32.load offset=32 (local.get $sw)))))
        (if (i32.eq (local.get $wParam) (i32.const 3)) (then (return (i32.load offset=36 (local.get $sw)))))
        (return (i32.load offset=36 (local.get $sw)))))

    ;; TTM_ADDTOOLA
    (if (i32.eq (local.get $msg) (i32.const 0x0404))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $src (call $g2w (local.get $lParam)))
        (local.set $idx (call $tooltip_find_tool (local.get $sw)
          (i32.load offset=8 (local.get $src)) (i32.load offset=12 (local.get $src))))
        (if (i32.ge_s (local.get $idx) (i32.const 0))
          (then
            (call $tooltip_copy_in (call $tooltip_item_ptr (local.get $sw) (local.get $idx)) (local.get $lParam))
            (return (i32.const 1))))
        (local.set $count (i32.load offset=4 (local.get $sw)))
        (local.set $cap (i32.load offset=8 (local.get $sw)))
        (if (i32.ge_u (local.get $count) (local.get $cap))
          (then
            (local.set $new_items (call $heap_alloc (i32.mul (i32.mul (local.get $cap) (i32.const 2)) (i32.const 48))))
            (call $zero_memory (call $g2w (local.get $new_items)) (i32.mul (i32.mul (local.get $cap) (i32.const 2)) (i32.const 48)))
            (call $memcpy (call $g2w (local.get $new_items)) (call $g2w (i32.load (local.get $sw))) (i32.mul (local.get $count) (i32.const 48)))
            (call $heap_free (i32.load (local.get $sw)))
            (i32.store (local.get $sw) (local.get $new_items))
            (i32.store offset=8 (local.get $sw) (i32.mul (local.get $cap) (i32.const 2)))))
        (call $tooltip_copy_in (call $tooltip_item_ptr (local.get $sw) (local.get $count)) (local.get $lParam))
        (i32.store offset=4 (local.get $sw) (i32.add (local.get $count) (i32.const 1)))
        (if (i32.lt_s (i32.load offset=16 (local.get $sw)) (i32.const 0))
          (then (i32.store offset=16 (local.get $sw) (local.get $count))))
        (return (i32.const 1))))

    ;; TTM_DELTOOLA
    (if (i32.eq (local.get $msg) (i32.const 0x0405))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $src (call $g2w (local.get $lParam)))
        (local.set $idx (call $tooltip_find_tool (local.get $sw)
          (i32.load offset=8 (local.get $src)) (i32.load offset=12 (local.get $src))))
        (if (i32.lt_s (local.get $idx) (i32.const 0)) (then (return (i32.const 0))))
        (local.set $count (i32.load offset=4 (local.get $sw)))
        (local.set $rec (call $tooltip_item_ptr (local.get $sw) (local.get $idx)))
        (if (i32.lt_u (i32.add (local.get $idx) (i32.const 1)) (local.get $count))
          (then
            (call $memcpy (local.get $rec)
              (i32.add (local.get $rec) (i32.const 48))
              (i32.mul (i32.sub (i32.sub (local.get $count) (local.get $idx)) (i32.const 1)) (i32.const 48)))))
        (i32.store offset=4 (local.get $sw) (i32.sub (local.get $count) (i32.const 1)))
        (if (i32.ge_s (i32.load offset=16 (local.get $sw)) (i32.sub (local.get $count) (i32.const 1)))
          (then (i32.store offset=16 (local.get $sw) (i32.sub (i32.load offset=4 (local.get $sw)) (i32.const 1)))))
        (return (i32.const 1))))

    ;; TTM_NEWTOOLRECTA / TTM_SETTOOLINFOA / TTM_UPDATETIPTEXTA
    (if (i32.or (i32.eq (local.get $msg) (i32.const 0x0406))
                (i32.or (i32.eq (local.get $msg) (i32.const 0x0409))
                        (i32.eq (local.get $msg) (i32.const 0x040C))))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $src (call $g2w (local.get $lParam)))
        (local.set $idx (call $tooltip_find_tool (local.get $sw)
          (i32.load offset=8 (local.get $src)) (i32.load offset=12 (local.get $src))))
        (if (i32.lt_s (local.get $idx) (i32.const 0)) (then (return (i32.const 0))))
        (local.set $rec (call $tooltip_item_ptr (local.get $sw) (local.get $idx)))
        (if (i32.eq (local.get $msg) (i32.const 0x0406))
          (then (call $memcpy (i32.add (local.get $rec) (i32.const 16)) (i32.add (local.get $src) (i32.const 16)) (i32.const 16)))
          (else
            (if (i32.eq (local.get $msg) (i32.const 0x040C))
              (then (i32.store offset=36 (local.get $rec) (i32.load offset=36 (local.get $src))))
              (else (call $tooltip_copy_in (local.get $rec) (local.get $lParam))))))
        (return (i32.const 1))))

    ;; TTM_GETTOOLINFOA / TTM_ENUMTOOLSA / TTM_GETCURRENTTOOLA
    (if (i32.or (i32.eq (local.get $msg) (i32.const 0x0408))
                (i32.or (i32.eq (local.get $msg) (i32.const 0x040E))
                        (i32.eq (local.get $msg) (i32.const 0x040F))))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $dst (call $g2w (local.get $lParam)))
        (if (i32.eq (local.get $msg) (i32.const 0x040E))
          (then (local.set $idx (local.get $wParam)))
          (else
            (if (i32.eq (local.get $msg) (i32.const 0x040F))
              (then (local.set $idx (i32.load offset=16 (local.get $sw))))
              (else
                (local.set $idx (call $tooltip_find_tool (local.get $sw)
                  (i32.load offset=8 (local.get $dst)) (i32.load offset=12 (local.get $dst))))))))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_u (local.get $idx) (i32.load offset=4 (local.get $sw))))
          (then (return (i32.const 0))))
        (call $memcpy (local.get $dst) (call $tooltip_item_ptr (local.get $sw) (local.get $idx)) (i32.const 48))
        (return (i32.const 1))))

    ;; TTM_GETTEXTA
    (if (i32.eq (local.get $msg) (i32.const 0x040B))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $ti (call $g2w (local.get $lParam)))
        (local.set $idx (call $tooltip_find_tool (local.get $sw)
          (i32.load offset=8 (local.get $ti)) (i32.load offset=12 (local.get $ti))))
        (if (i32.lt_s (local.get $idx) (i32.const 0)) (then (return (i32.const 0))))
        (local.set $rec (call $tooltip_item_ptr (local.get $sw) (local.get $idx)))
        (local.set $text_dst (call $g2w (i32.load offset=36 (local.get $ti))))
        (local.set $text_src (call $g2w (i32.load offset=36 (local.get $rec))))
        (if (i32.and
              (i32.ne (local.get $text_dst) (i32.const 0))
              (i32.ne (local.get $text_src) (i32.const 0)))
          (then
            (local.set $len (call $strlen (local.get $text_src)))
            (if (i32.gt_u (local.get $len) (i32.const 255)) (then (local.set $len (i32.const 255))))
            (call $memcpy (local.get $text_dst) (local.get $text_src) (local.get $len))
            (i32.store8 (i32.add (local.get $text_dst) (local.get $len)) (i32.const 0))))
        (return (i32.const 1))))

    ;; TTM_GETTOOLCOUNT
    (if (i32.eq (local.get $msg) (i32.const 0x040D))
      (then (return (i32.load offset=4 (local.get $sw)))))

    ;; TTM_HITTESTA. TTHITTESTINFOA: hwnd(+0), pt(+4,+8), ti(+12).
    (if (i32.eq (local.get $msg) (i32.const 0x040A))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $src (call $g2w (local.get $lParam)))
        (local.set $idx (call $tooltip_hit_test (local.get $sw)
          (i32.load (local.get $src)) (i32.load offset=4 (local.get $src)) (i32.load offset=8 (local.get $src))))
        (if (i32.lt_s (local.get $idx) (i32.const 0)) (then (return (i32.const 0))))
        (call $memcpy (i32.add (local.get $src) (i32.const 12))
          (call $tooltip_item_ptr (local.get $sw) (local.get $idx)) (i32.const 48))
        (return (i32.const 1))))

    ;; TTM_RELAYEVENT. MSG: hwnd,msg,wParam,lParam,time,pt.x,pt.y.
    (if (i32.eq (local.get $msg) (i32.const 0x0407))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $src (call $g2w (local.get $lParam)))
        (local.set $x (i32.shr_s (i32.shl (i32.load offset=12 (local.get $src)) (i32.const 16)) (i32.const 16)))
        (local.set $y (i32.shr_s (i32.load offset=12 (local.get $src)) (i32.const 16)))
        (local.set $idx (call $tooltip_hit_test (local.get $sw)
          (i32.load (local.get $src)) (local.get $x) (local.get $y)))
        (i32.store offset=16 (local.get $sw) (local.get $idx))
        (return (i32.const 0))))

    ;; TTM_WINDOWFROMPOINT: return current matched hwnd if available.
    (if (i32.eq (local.get $msg) (i32.const 0x0410))
      (then
        (local.set $idx (i32.load offset=16 (local.get $sw)))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_u (local.get $idx) (i32.load offset=4 (local.get $sw))))
          (then (return (i32.const 0))))
        (return (i32.load offset=8 (call $tooltip_item_ptr (local.get $sw) (local.get $idx))))))

    ;; TTM_TRACKACTIVATE / TTM_POP / TTM_UPDATE
    (if (i32.or (i32.eq (local.get $msg) (i32.const 0x0411))
                (i32.or (i32.eq (local.get $msg) (i32.const 0x041C))
                        (i32.eq (local.get $msg) (i32.const 0x041D))))
      (then (return (i32.const 1))))
    ;; TTM_TRACKPOSITION
    (if (i32.eq (local.get $msg) (i32.const 0x0412)) (then (return (i32.const 0))))

    ;; Colors / max width / margin.
    (if (i32.eq (local.get $msg) (i32.const 0x0413)) (then (i32.store offset=20 (local.get $sw) (local.get $wParam)) (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0414)) (then (i32.store offset=24 (local.get $sw) (local.get $wParam)) (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0416)) (then (return (i32.load offset=20 (local.get $sw)))))
    (if (i32.eq (local.get $msg) (i32.const 0x0417)) (then (return (i32.load offset=24 (local.get $sw)))))
    (if (i32.eq (local.get $msg) (i32.const 0x0418))
      (then
        (local.set $old (i32.load offset=28 (local.get $sw)))
        (i32.store offset=28 (local.get $sw) (local.get $lParam))
        (return (local.get $old))))
    (if (i32.eq (local.get $msg) (i32.const 0x0419)) (then (return (i32.load offset=28 (local.get $sw)))))
    (if (i32.eq (local.get $msg) (i32.const 0x041A))
      (then
        (if (local.get $lParam) (then (call $memcpy (i32.add (local.get $sw) (i32.const 44)) (call $g2w (local.get $lParam)) (i32.const 16))))
        (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x041B))
      (then
        (if (local.get $lParam) (then (call $memcpy (call $g2w (local.get $lParam)) (i32.add (local.get $sw) (i32.const 44)) (i32.const 16))))
        (return (i32.const 0))))

    (i32.const 0))

  ;; ---- TrackBar / Slider WndProc ----
  ;;
  ;; Minimal common-control trackbar for Funpack dialogs. State:
  ;; +0 min, +4 max, +8 pos, +12 line, +16 page, +20 thumb length.
  (func $trackbar_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $state i32) (local $sw i32) (local $min i32) (local $max i32) (local $pos i32)
    (local $old i32) (local $hdc i32) (local $sz i32) (local $w i32) (local $h i32)
    (local $style i32) (local $vert i32) (local $range i32) (local $track_len i32)
    (local $thumb_len i32) (local $thumb_pos i32) (local $cx i32) (local $cy i32)
    (local $coord i32) (local $long_dim i32) (local $parent i32) (local $scroll_msg i32)
    (local $i i32)

    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $state))
      (then
        (local.set $state (call $heap_alloc (i32.const 24)))
        (local.set $sw (call $g2w (local.get $state)))
        (i32.store        (local.get $sw) (i32.const 0))
        (i32.store offset=4  (local.get $sw) (i32.const 100))
        (i32.store offset=8  (local.get $sw) (i32.const 0))
        (i32.store offset=12 (local.get $sw) (i32.const 1))
        (i32.store offset=16 (local.get $sw) (i32.const 10))
        (i32.store offset=20 (local.get $sw) (i32.const 16))
        (call $wnd_set_state_ptr (local.get $hwnd) (local.get $state))))
    (local.set $sw (call $g2w (local.get $state)))

    ;; WM_CREATE
    (if (i32.eq (local.get $msg) (i32.const 0x0001))
      (then (return (i32.const 0))))
    ;; WM_DESTROY
    (if (i32.eq (local.get $msg) (i32.const 0x0002))
      (then
        (call $heap_free (local.get $state))
        (call $wnd_set_state_ptr (local.get $hwnd) (i32.const 0))
        (return (i32.const 0))))

    ;; TBM_GETPOS / TBM_GETRANGEMIN / TBM_GETRANGEMAX
    (if (i32.eq (local.get $msg) (i32.const 0x0400))
      (then (return (i32.load offset=8 (local.get $sw)))))
    (if (i32.eq (local.get $msg) (i32.const 0x0401))
      (then (return (i32.load (local.get $sw)))))
    (if (i32.eq (local.get $msg) (i32.const 0x0402))
      (then (return (i32.load offset=4 (local.get $sw)))))
    ;; TBM_SETPOS(fRedraw, pos)
    (if (i32.eq (local.get $msg) (i32.const 0x0405))
      (then
        (local.set $min (i32.load (local.get $sw)))
        (local.set $max (i32.load offset=4 (local.get $sw)))
        (local.set $pos (local.get $lParam))
        (if (i32.lt_s (local.get $pos) (local.get $min)) (then (local.set $pos (local.get $min))))
        (if (i32.gt_s (local.get $pos) (local.get $max)) (then (local.set $pos (local.get $max))))
        (i32.store offset=8 (local.get $sw) (local.get $pos))
        (if (local.get $wParam) (then (call $invalidate_hwnd (local.get $hwnd))))
        (return (i32.const 0))))
    ;; TBM_SETRANGE(fRedraw, MAKELONG(min,max))
    (if (i32.eq (local.get $msg) (i32.const 0x0406))
      (then
        (local.set $min (i32.shr_s (i32.shl (local.get $lParam) (i32.const 16)) (i32.const 16)))
        (local.set $max (i32.shr_s (local.get $lParam) (i32.const 16)))
        (if (i32.le_s (local.get $max) (local.get $min))
          (then (local.set $max (i32.add (local.get $min) (i32.const 1)))))
        (i32.store        (local.get $sw) (local.get $min))
        (i32.store offset=4  (local.get $sw) (local.get $max))
        (local.set $pos (i32.load offset=8 (local.get $sw)))
        (if (i32.lt_s (local.get $pos) (local.get $min)) (then (i32.store offset=8 (local.get $sw) (local.get $min))))
        (if (i32.gt_s (local.get $pos) (local.get $max)) (then (i32.store offset=8 (local.get $sw) (local.get $max))))
        (if (local.get $wParam) (then (call $invalidate_hwnd (local.get $hwnd))))
        (return (i32.const 0))))
    ;; TBM_SETRANGEMIN / TBM_SETRANGEMAX
    (if (i32.eq (local.get $msg) (i32.const 0x0407))
      (then
        (i32.store (local.get $sw) (local.get $lParam))
        (if (local.get $wParam) (then (call $invalidate_hwnd (local.get $hwnd))))
        (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0408))
      (then
        (i32.store offset=4 (local.get $sw) (local.get $lParam))
        (if (local.get $wParam) (then (call $invalidate_hwnd (local.get $hwnd))))
        (return (i32.const 0))))
    ;; TBM_SETPAGESIZE / GETPAGESIZE / SETLINESIZE / GETLINESIZE
    (if (i32.eq (local.get $msg) (i32.const 0x0415))
      (then
        (local.set $old (i32.load offset=16 (local.get $sw)))
        (i32.store offset=16 (local.get $sw) (local.get $lParam))
        (return (local.get $old))))
    (if (i32.eq (local.get $msg) (i32.const 0x0416))
      (then (return (i32.load offset=16 (local.get $sw)))))
    (if (i32.eq (local.get $msg) (i32.const 0x0417))
      (then
        (local.set $old (i32.load offset=12 (local.get $sw)))
        (i32.store offset=12 (local.get $sw) (local.get $lParam))
        (return (local.get $old))))
    (if (i32.eq (local.get $msg) (i32.const 0x0418))
      (then (return (i32.load offset=12 (local.get $sw)))))
    ;; TBM_SETTHUMBLENGTH / GETTHUMBLENGTH
    (if (i32.eq (local.get $msg) (i32.const 0x041B))
      (then
        (i32.store offset=20 (local.get $sw) (local.get $wParam))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x041C))
      (then (return (i32.load offset=20 (local.get $sw)))))

    ;; Mouse tracking. Native trackbars capture the thumb and synchronously
    ;; notify their parent with WM_HSCROLL/WM_VSCROLL while it moves.
    (if (i32.or
          (i32.eq (local.get $msg) (i32.const 0x0201))
          (i32.and (i32.eq (local.get $msg) (i32.const 0x0200))
                   (i32.eq (global.get $capture_hwnd) (local.get $hwnd))))
      (then
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xffff)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        (local.set $style (call $wnd_get_style (local.get $hwnd)))
        (local.set $vert (i32.and (local.get $style) (i32.const 0x0002)))
        (local.set $long_dim (select (local.get $h) (local.get $w) (local.get $vert)))
        (local.set $coord
          (select
            (i32.shr_s (local.get $lParam) (i32.const 16))
            (i32.shr_s (i32.shl (local.get $lParam) (i32.const 16)) (i32.const 16))
            (local.get $vert)))
        (local.set $thumb_len (i32.load offset=20 (local.get $sw)))
        (if (i32.lt_s (local.get $thumb_len) (i32.const 8))
          (then (local.set $thumb_len (i32.const 8))))
        (local.set $track_len (i32.sub (local.get $long_dim) (local.get $thumb_len)))
        (if (i32.lt_s (local.get $track_len) (i32.const 1))
          (then (local.set $track_len (i32.const 1))))
        (local.set $coord (i32.sub (local.get $coord) (i32.div_s (local.get $thumb_len) (i32.const 2))))
        (if (i32.lt_s (local.get $coord) (i32.const 0)) (then (local.set $coord (i32.const 0))))
        (if (i32.gt_s (local.get $coord) (local.get $track_len)) (then (local.set $coord (local.get $track_len))))
        (local.set $min (i32.load (local.get $sw)))
        (local.set $max (i32.load offset=4 (local.get $sw)))
        (local.set $range (i32.sub (local.get $max) (local.get $min)))
        (if (i32.le_s (local.get $range) (i32.const 0)) (then (local.set $range (i32.const 1))))
        (local.set $pos
          (i32.add (local.get $min)
            (i32.div_s (i32.mul (local.get $coord) (local.get $range)) (local.get $track_len))))
        (i32.store offset=8 (local.get $sw) (local.get $pos))
        (if (i32.eq (local.get $msg) (i32.const 0x0201))
          (then (global.set $capture_hwnd (local.get $hwnd))))
        (call $invalidate_hwnd (local.get $hwnd))
        (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
        (local.set $scroll_msg (select (i32.const 0x0115) (i32.const 0x0114) (local.get $vert)))
        (drop (call $wnd_send_message
          (local.get $parent) (local.get $scroll_msg)
          (i32.or (i32.const 5) (i32.shl (i32.and (local.get $pos) (i32.const 0xffff)) (i32.const 16)))
          (local.get $hwnd)))
        (return (i32.const 0))))

    (if (i32.eq (local.get $msg) (i32.const 0x0202))
      (then
        (if (i32.eq (global.get $capture_hwnd) (local.get $hwnd))
          (then
            (global.set $capture_hwnd (i32.const 0))
            (local.set $pos (i32.load offset=8 (local.get $sw)))
            (local.set $vert (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x0002)))
            (local.set $scroll_msg (select (i32.const 0x0115) (i32.const 0x0114) (local.get $vert)))
            (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
            (drop (call $wnd_send_message
              (local.get $parent) (local.get $scroll_msg)
              (i32.or (i32.const 4) (i32.shl (i32.and (local.get $pos) (i32.const 0xffff)) (i32.const 16)))
              (local.get $hwnd)))
            (drop (call $wnd_send_message
              (local.get $parent) (local.get $scroll_msg) (i32.const 8) (local.get $hwnd)))))
        (return (i32.const 0))))

    ;; WM_PAINT
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        (local.set $style (call $wnd_get_style (local.get $hwnd)))
        (local.set $vert (i32.and (local.get $style) (i32.const 0x0002)))
        (drop (call $host_gdi_fill_rect (local.get $hdc)
                (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
                (i32.const 0x30011))) ;; LTGRAY_BRUSH / COLOR_BTNFACE.
        (local.set $min (i32.load (local.get $sw)))
        (local.set $max (i32.load offset=4 (local.get $sw)))
        (local.set $pos (i32.load offset=8 (local.get $sw)))
        (local.set $range (i32.sub (local.get $max) (local.get $min)))
        (if (i32.le_s (local.get $range) (i32.const 0)) (then (local.set $range (i32.const 1))))
        (local.set $thumb_len (i32.load offset=20 (local.get $sw)))
        (if (i32.lt_s (local.get $thumb_len) (i32.const 8)) (then (local.set $thumb_len (i32.const 8))))
        (if (local.get $vert)
          (then
            (local.set $track_len (i32.sub (local.get $h) (local.get $thumb_len)))
            (if (i32.lt_s (local.get $track_len) (i32.const 1)) (then (local.set $track_len (i32.const 1))))
            (local.set $thumb_pos
              (i32.div_s
                (i32.mul (i32.sub (local.get $pos) (local.get $min)) (local.get $track_len))
                (local.get $range)))
            (local.set $cx (i32.div_s (local.get $w) (i32.const 2)))
            (drop (call $host_gdi_draw_edge (local.get $hdc)
                    (i32.sub (local.get $cx) (i32.const 2)) (i32.const 4)
                    (i32.add (local.get $cx) (i32.const 2)) (i32.sub (local.get $h) (i32.const 4))
                    (i32.const 0x0A) (i32.const 0x0F)))
            ;; Vertical Win9x mixer faders show evenly spaced tick marks on
            ;; both sides of the groove unless TBS_NOTICKS is requested.
            (if (i32.eqz (i32.and (local.get $style) (i32.const 0x0010)))
              (then
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 2) (i32.const 4) (i32.const 5) (i32.const 5)
                        (i32.const 0x30014)))
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.sub (local.get $w) (i32.const 5)) (i32.const 4)
                        (i32.sub (local.get $w) (i32.const 2)) (i32.const 5)
                        (i32.const 0x30014)))
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 2) (i32.div_u (local.get $h) (i32.const 2))
                        (i32.const 5) (i32.add (i32.div_u (local.get $h) (i32.const 2)) (i32.const 1))
                        (i32.const 0x30014)))
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.sub (local.get $w) (i32.const 5)) (i32.div_u (local.get $h) (i32.const 2))
                        (i32.sub (local.get $w) (i32.const 2))
                        (i32.add (i32.div_u (local.get $h) (i32.const 2)) (i32.const 1))
                        (i32.const 0x30014)))
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.const 2) (i32.sub (local.get $h) (i32.const 5))
                        (i32.const 5) (i32.sub (local.get $h) (i32.const 4))
                        (i32.const 0x30014)))
                (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.sub (local.get $w) (i32.const 5)) (i32.sub (local.get $h) (i32.const 5))
                        (i32.sub (local.get $w) (i32.const 2)) (i32.sub (local.get $h) (i32.const 4))
                        (i32.const 0x30014)))))
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.sub (local.get $cx) (i32.const 8)) (local.get $thumb_pos)
                    (i32.add (local.get $cx) (i32.const 8)) (i32.add (local.get $thumb_pos) (local.get $thumb_len))
                    (i32.const 0x30011)))
            (drop (call $host_gdi_draw_edge (local.get $hdc)
                    (i32.sub (local.get $cx) (i32.const 8)) (local.get $thumb_pos)
                    (i32.add (local.get $cx) (i32.const 8)) (i32.add (local.get $thumb_pos) (local.get $thumb_len))
                    (i32.const 0x05) (i32.const 0x0F))))
          (else
            (local.set $track_len (i32.sub (local.get $w) (local.get $thumb_len)))
            (if (i32.lt_s (local.get $track_len) (i32.const 1)) (then (local.set $track_len (i32.const 1))))
            (local.set $thumb_pos
              (i32.div_s
                (i32.mul (i32.sub (local.get $pos) (local.get $min)) (local.get $track_len))
                (local.get $range)))
            (local.set $cy (i32.div_s (local.get $h) (i32.const 2)))
            (drop (call $host_gdi_draw_edge (local.get $hdc)
                    (i32.const 4) (i32.sub (local.get $cy) (i32.const 2))
                    (i32.sub (local.get $w) (i32.const 4)) (i32.add (local.get $cy) (i32.const 2))
                    (i32.const 0x0A) (i32.const 0x0F)))
            ;; TBS_AUTOTICKS is the horizontal default. The Win98 control
            ;; chooses a readable interval as the range grows; ten divisions
            ;; reproduce that automatic density for Media Player's time line.
            (if (i32.eqz (i32.and (local.get $style) (i32.const 0x0010)))
              (then
                (local.set $i (i32.const 0))
                (block $ticks_done (loop $ticks
                  (br_if $ticks_done (i32.gt_u (local.get $i) (i32.const 10)))
                  (local.set $cx
                    (i32.add (i32.const 4)
                      (i32.div_u
                        (i32.mul (i32.sub (local.get $w) (i32.const 8)) (local.get $i))
                        (i32.const 10))))
                  (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (local.get $cx) (i32.add (local.get $cy) (i32.const 9))
                    (i32.add (local.get $cx) (i32.const 1))
                    (i32.add (local.get $cy) (i32.const 11))
                    (i32.const 0x30014)))
                  (local.set $i (i32.add (local.get $i) (i32.const 1)))
                  (br $ticks)))))
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (local.get $thumb_pos) (i32.sub (local.get $cy) (i32.const 8))
                    (i32.add (local.get $thumb_pos) (local.get $thumb_len)) (i32.add (local.get $cy) (i32.const 8))
                    (i32.const 0x30011)))
            (drop (call $host_gdi_draw_edge (local.get $hdc)
                    (local.get $thumb_pos) (i32.sub (local.get $cy) (i32.const 8))
                    (i32.add (local.get $thumb_pos) (local.get $thumb_len)) (i32.add (local.get $cy) (i32.const 8))
                    (i32.const 0x05) (i32.const 0x0F)))))
        (return (i32.const 0))))
    (i32.const 0))

  ;; Case-insensitive memcmp of $n bytes at WASM-linear $a / $b. Returns 1
  ;; if equal (treating ASCII A-Z and a-z as equivalent), 0 otherwise.
  ;; Used by LB_FINDSTRING / LB_FINDSTRINGEXACT.
  (func $listbox_strncmpi (param $a i32) (param $b i32) (param $n i32) (result i32)
    (local $ca i32) (local $cb i32)
    (block $done (loop $lp
      (br_if $done (i32.eqz (local.get $n)))
      (local.set $ca (i32.load8_u (local.get $a)))
      (local.set $cb (i32.load8_u (local.get $b)))
      (if (i32.and (i32.ge_u (local.get $ca) (i32.const 0x41))
                   (i32.le_u (local.get $ca) (i32.const 0x5A)))
        (then (local.set $ca (i32.or (local.get $ca) (i32.const 0x20)))))
      (if (i32.and (i32.ge_u (local.get $cb) (i32.const 0x41))
                   (i32.le_u (local.get $cb) (i32.const 0x5A)))
        (then (local.set $cb (i32.or (local.get $cb) (i32.const 0x20)))))
      (if (i32.ne (local.get $ca) (local.get $cb))
        (then (return (i32.const 0))))
      (local.set $a (i32.add (local.get $a) (i32.const 1)))
      (local.set $b (i32.add (local.get $b) (i32.const 1)))
      (local.set $n (i32.sub (local.get $n) (i32.const 1)))
      (br $lp)))
    (i32.const 1))

  ;; ============================================================
  ;; ListBox WndProc  (control class 4)
  ;; ============================================================
  ;;
  ;; ListBoxState (52 bytes, allocated in WM_CREATE)
  ;;   +0   items_buf_ptr    guest ptr to flat NUL-separated string buffer
  ;;                         ("item1\0item2\0item3\0", or 0 if empty)
  ;;   +4   items_used       bytes in items_buf actually used (incl. NULs)
  ;;   +8   items_cap        bytes allocated for items_buf
  ;;   +12  count            number of items
  ;;   +16  cur_sel          current selection (-1 = none)
  ;;   +20  top_index        first visible row (vertical scroll)
  ;;   +24  ctrl_id          control id (notification target uses this)
  ;;   +28  drag_anchor_y
  ;;   +32  drag_anchor_top
  ;;   +36  data_buf_ptr     guest ptr to u32[] parallel item-data array (LB_SETITEMDATA)
  ;;   +40  data_cap         capacity of data array, in u32 slots
  ;;   +44  sel_buf_ptr      guest ptr to u8[] multi-selection flags
  ;;   +48  sel_cap          capacity of selection array, in bytes
  ;;
  ;; Items are stored as concatenated NUL-terminated strings. LB_ADDSTRING
  ;; appends; LB_RESETCONTENT zeros count + items_used (keeps the buffer for
  ;; reuse). LB_GETTEXT walks NULs to find item N. There's no per-item index
  ;; array — for the workloads we care about (file dialogs, font picker)
  ;; the count is small enough that linear walks are cheap.
  ;;
  ;; Click → set cur_sel + post WM_COMMAND (HIWORD=LBN_SELCHANGE=1, LOWORD=ctrl_id).
  ;; Double-click → post WM_COMMAND (HIWORD=LBN_DBLCLK=2). Item height = 16px.
  ;;
  ;; Drawing is done by the renderer (lib/renderer.js _drawWatChildren) via
  ;; the listbox_get_* exports. WM_PAINT here is a no-op (the WAT control
  ;; pipeline doesn't go through WM_PAINT — drawing is GDI-bypass).
  (func $listbox_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $state i32) (local $sw i32) (local $cs_w i32)
    (local $items i32) (local $items_w i32) (local $used i32) (local $cap i32)
    (local $count i32) (local $idx i32) (local $i i32) (local $p i32)
    (local $src_g i32) (local $src_w i32) (local $slen i32)
    (local $need i32) (local $new_buf i32) (local $new_w i32)
    (local $dest_g i32) (local $dest_w i32) (local $max i32)
    (local $row i32) (local $parent i32) (local $notif i32) (local $sz i32)
    (local $w i32) (local $h i32) (local $hdc i32) (local $sel i32)
    (local $top i32) (local $visible i32) (local $row_y i32) (local $row_h i32)
    (local $brush i32)
    (local $find_handle i32) (local $fd_g i32) (local $fd_w i32) (local $attrs i32)
    (local $last i32) (local $tmp_g i32) (local $tmp_w i32)

    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))

    ;; ---------- WM_CREATE (0x0001) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0001))
      (then
        (local.set $cs_w (call $g2w (local.get $lParam)))
        (local.set $state (call $heap_alloc (i32.const 52)))
        (local.set $sw (call $g2w (local.get $state)))
        (i32.store        (local.get $sw) (i32.const 0)) ;; items_buf_ptr
        (i32.store offset=4  (local.get $sw) (i32.const 0)) ;; items_used
        (i32.store offset=8  (local.get $sw) (i32.const 0)) ;; items_cap
        (i32.store offset=12 (local.get $sw) (i32.const 0)) ;; count
        (i32.store offset=16 (local.get $sw) (i32.const -1)) ;; cur_sel
        (i32.store offset=20 (local.get $sw) (i32.const 0)) ;; top_index
        (i32.store offset=24 (local.get $sw) (i32.load offset=8 (local.get $cs_w))) ;; ctrl_id from CREATESTRUCT.hMenu
        (i32.store offset=28 (local.get $sw) (i32.const 0)) ;; drag_anchor_y (thumb drag)
        (i32.store offset=32 (local.get $sw) (i32.const 0)) ;; drag_anchor_top
        (i32.store offset=36 (local.get $sw) (i32.const 0)) ;; data_buf_ptr
        (i32.store offset=40 (local.get $sw) (i32.const 0)) ;; data_cap
        (i32.store offset=44 (local.get $sw) (i32.const 0)) ;; sel_buf_ptr
        (i32.store offset=48 (local.get $sw) (i32.const 0)) ;; sel_cap
        (call $wnd_set_state_ptr (local.get $hwnd) (local.get $state))
        (return (i32.const 0))))

    ;; ---------- WM_DESTROY (0x0002) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0002))
      (then
        (if (local.get $state)
          (then
            (local.set $sw (call $g2w (local.get $state)))
            (call $heap_free (i32.load (local.get $sw)))
            (call $heap_free (i32.load offset=36 (local.get $sw)))
            (call $heap_free (i32.load offset=44 (local.get $sw)))
            (call $heap_free (local.get $state))
            (call $wnd_set_state_ptr (local.get $hwnd) (i32.const 0))))
        (return (i32.const 0))))

    (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
    (local.set $sw (call $g2w (local.get $state)))

    ;; ---------- LB_ADDSTRING (0x0180) ----------
    ;; lParam = guest ptr to NUL-terminated string. Returns new index, or
    ;; LB_ERR(-1) on failure (we never fail here).
    (if (i32.eq (local.get $msg) (i32.const 0x0180))
      (then
        (local.set $src_g (local.get $lParam))
        (if (i32.eqz (local.get $src_g)) (then (return (i32.const -1))))
        (local.set $src_w (call $g2w (local.get $src_g)))
        (local.set $slen (call $strlen (local.get $src_w)))
        (local.set $used (i32.load offset=4 (local.get $sw)))
        (local.set $cap  (i32.load offset=8 (local.get $sw)))
        (local.set $need (i32.add (local.get $used) (i32.add (local.get $slen) (i32.const 1))))
        ;; Grow buffer if needed: alloc max(256, need*2), copy old, free old.
        (if (i32.gt_u (local.get $need) (local.get $cap))
          (then
            (local.set $cap (i32.mul (local.get $need) (i32.const 2)))
            (if (i32.lt_u (local.get $cap) (i32.const 256))
              (then (local.set $cap (i32.const 256))))
            (local.set $new_buf (call $heap_alloc (local.get $cap)))
            (local.set $new_w (call $g2w (local.get $new_buf)))
            (if (local.get $used)
              (then (call $memcpy (local.get $new_w)
                                  (call $g2w (i32.load (local.get $sw)))
                                  (local.get $used))))
            (call $heap_free (i32.load (local.get $sw)))
            (i32.store       (local.get $sw) (local.get $new_buf))
            (i32.store offset=8 (local.get $sw) (local.get $cap))))
        ;; Append the new string + NUL at items[used].
        (local.set $items_w (call $g2w (i32.load (local.get $sw))))
        (call $memcpy (i32.add (local.get $items_w) (local.get $used))
                      (local.get $src_w) (local.get $slen))
        (i32.store8 (i32.add (i32.add (local.get $items_w) (local.get $used)) (local.get $slen))
                    (i32.const 0))
        (local.set $count (i32.load offset=12 (local.get $sw)))
        (i32.store offset=4  (local.get $sw)
          (i32.add (local.get $used) (i32.add (local.get $slen) (i32.const 1))))
        (i32.store offset=12 (local.get $sw) (i32.add (local.get $count) (i32.const 1)))
        ;; Grow parallel data array if needed; default new slot to 0.
        (local.set $cap (i32.load offset=40 (local.get $sw)))
        (if (i32.ge_u (local.get $count) (local.get $cap))
          (then
            (local.set $cap (i32.mul (i32.add (local.get $count) (i32.const 1)) (i32.const 2)))
            (if (i32.lt_u (local.get $cap) (i32.const 16))
              (then (local.set $cap (i32.const 16))))
            (local.set $new_buf (call $heap_alloc (i32.mul (local.get $cap) (i32.const 4))))
            (local.set $new_w (call $g2w (local.get $new_buf)))
            (if (local.get $count)
              (then (call $memcpy (local.get $new_w)
                                  (call $g2w (i32.load offset=36 (local.get $sw)))
                                  (i32.mul (local.get $count) (i32.const 4)))))
            (call $heap_free (i32.load offset=36 (local.get $sw)))
            (i32.store offset=36 (local.get $sw) (local.get $new_buf))
            (i32.store offset=40 (local.get $sw) (local.get $cap))))
        (i32.store
          (i32.add (call $g2w (i32.load offset=36 (local.get $sw)))
                   (i32.mul (local.get $count) (i32.const 4)))
          (i32.const 0))
        ;; Grow the byte-per-row multi-selection array in parallel.
        (local.set $cap (i32.load offset=48 (local.get $sw)))
        (if (i32.ge_u (local.get $count) (local.get $cap))
          (then
            (local.set $cap (i32.mul (i32.add (local.get $count) (i32.const 1)) (i32.const 2)))
            (if (i32.lt_u (local.get $cap) (i32.const 16))
              (then (local.set $cap (i32.const 16))))
            (local.set $new_buf (call $heap_alloc (local.get $cap)))
            (local.set $new_w (call $g2w (local.get $new_buf)))
            (if (local.get $count)
              (then (call $memcpy (local.get $new_w)
                                  (call $g2w (i32.load offset=44 (local.get $sw)))
                                  (local.get $count))))
            (call $heap_free (i32.load offset=44 (local.get $sw)))
            (i32.store offset=44 (local.get $sw) (local.get $new_buf))
            (i32.store offset=48 (local.get $sw) (local.get $cap))))
        (i32.store8
          (i32.add (call $g2w (i32.load offset=44 (local.get $sw))) (local.get $count))
          (i32.const 0))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (local.get $count))))  ;; index of newly inserted item

    ;; ---------- LB_RESETCONTENT (0x0184) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0184))
      (then
        (i32.store offset=4  (local.get $sw) (i32.const 0))   ;; items_used
        (i32.store offset=12 (local.get $sw) (i32.const 0))   ;; count
        (i32.store offset=16 (local.get $sw) (i32.const -1))  ;; cur_sel
        (i32.store offset=20 (local.get $sw) (i32.const 0))   ;; top_index
        (local.set $p (call $g2w (i32.load offset=44 (local.get $sw))))
        (local.set $i (i32.const 0))
        (block $reset_sel_done (loop $reset_sel
          (br_if $reset_sel_done (i32.ge_u (local.get $i) (i32.load offset=48 (local.get $sw))))
          (i32.store8 (i32.add (local.get $p) (local.get $i)) (i32.const 0))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $reset_sel)))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 0))))

    ;; ---------- LB_DIR (0x018D) ----------
    ;; wParam = DDL_* attribute flags, lParam = wildcard path. Adds matching
    ;; files to the listbox and, when DDL_DIRECTORY is set, matching
    ;; directories too. Returns the last inserted index or LB_ERR(-1).
    (if (i32.eq (local.get $msg) (i32.const 0x018D))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const -1))))
        (local.set $fd_g (call $heap_alloc (i32.const 320)))
        (local.set $fd_w (call $g2w (local.get $fd_g)))
        (local.set $tmp_g (call $heap_alloc (i32.const 280)))
        (local.set $tmp_w (call $g2w (local.get $tmp_g)))
        (local.set $last (i32.const -1))
        (local.set $find_handle (call $host_fs_find_first_file
          (call $g2w (local.get $lParam)) (local.get $fd_g) (i32.const 0)))
        (if (i32.eq (local.get $find_handle) (i32.const -1))
          (then
            (call $heap_free (local.get $tmp_g))
            (call $heap_free (local.get $fd_g))
            (return (i32.const -1))))
        (block $lbdir_done (loop $lbdir_loop
          (local.set $attrs (i32.load (local.get $fd_w)))
          (if (i32.or
                (i32.eqz (i32.and (local.get $attrs) (i32.const 0x10)))
                (i32.and (local.get $wParam) (i32.const 0x10)))
            (then
              (local.set $slen (call $strlen (i32.add (local.get $fd_w) (i32.const 44))))
              (call $memcpy (local.get $tmp_w)
                            (i32.add (local.get $fd_w) (i32.const 44))
                            (local.get $slen))
              (i32.store8 (i32.add (local.get $tmp_w) (local.get $slen)) (i32.const 0))
              (local.set $last (call $listbox_wndproc (local.get $hwnd)
                (i32.const 0x0180) (i32.const 0)
                (local.get $tmp_g)))))
          (br_if $lbdir_done (i32.eqz (call $host_fs_find_next_file
                                        (local.get $find_handle)
                                        (local.get $fd_g)
                                        (i32.const 0))))
          (br $lbdir_loop)))
        (drop (call $host_fs_find_close (local.get $find_handle)))
        (call $heap_free (local.get $tmp_g))
        (call $heap_free (local.get $fd_g))
        (return (local.get $last))))

    ;; ---------- LB_GETCOUNT (0x018B) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x018B))
      (then (return (i32.load offset=12 (local.get $sw)))))

    ;; ---------- LB_GETCURSEL (0x0188) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0188))
      (then (return (i32.load offset=16 (local.get $sw)))))

    ;; ---------- LB_SETSEL (0x0185) / LB_GETSEL (0x0187) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0185))
      (then
        (local.set $idx (local.get $lParam))
        (local.set $count (i32.load offset=12 (local.get $sw)))
        (if (i32.eq (local.get $idx) (i32.const -1))
          (then
            (local.set $i (i32.const 0))
            (block $set_all_done (loop $set_all
              (br_if $set_all_done (i32.ge_u (local.get $i) (local.get $count)))
              (i32.store8
                (i32.add (call $g2w (i32.load offset=44 (local.get $sw))) (local.get $i))
                (i32.ne (local.get $wParam) (i32.const 0)))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $set_all))))
          (else
            (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                        (i32.ge_s (local.get $idx) (local.get $count)))
              (then (return (i32.const -1))))
            (i32.store8
              (i32.add (call $g2w (i32.load offset=44 (local.get $sw))) (local.get $idx))
              (i32.ne (local.get $wParam) (i32.const 0)))))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 0))))

    (if (i32.eq (local.get $msg) (i32.const 0x0187))
      (then
        (local.set $idx (local.get $wParam))
        (local.set $count (i32.load offset=12 (local.get $sw)))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_s (local.get $idx) (local.get $count)))
          (then (return (i32.const -1))))
        (if (i32.load offset=44 (local.get $sw))
          (then (return (i32.load8_u
            (i32.add (call $g2w (i32.load offset=44 (local.get $sw))) (local.get $idx))))))
        (return (i32.eq (local.get $idx) (i32.load offset=16 (local.get $sw))))))

    ;; ---------- LB_GETSELCOUNT (0x0190) / LB_GETSELITEMS (0x0191) ----------
    (if (i32.or (i32.eq (local.get $msg) (i32.const 0x0190))
                (i32.eq (local.get $msg) (i32.const 0x0191)))
      (then
        (local.set $count (i32.load offset=12 (local.get $sw)))
        (local.set $i (i32.const 0))
        (local.set $sel (i32.const 0))
        (if (i32.eq (local.get $msg) (i32.const 0x0191))
          (then (local.set $dest_w (call $g2w (local.get $lParam)))))
        (block $get_sels_done (loop $get_sels
          (br_if $get_sels_done (i32.ge_u (local.get $i) (local.get $count)))
          (if (i32.load8_u
                (i32.add (call $g2w (i32.load offset=44 (local.get $sw))) (local.get $i)))
            (then
              (if (i32.eq (local.get $msg) (i32.const 0x0191))
                (then
                  (br_if $get_sels_done (i32.ge_u (local.get $sel) (local.get $wParam)))
                  (i32.store
                    (i32.add (local.get $dest_w) (i32.mul (local.get $sel) (i32.const 4)))
                    (local.get $i))))
              (local.set $sel (i32.add (local.get $sel) (i32.const 1)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $get_sels)))
        (return (local.get $sel))))

    ;; ---------- LB_GETITEMHEIGHT (0x01A1) ----------
    ;; The renderer and mouse hit-testing use the Win98 default 16px row.
    (if (i32.eq (local.get $msg) (i32.const 0x01A1))
      (then (return (i32.const 16))))

    ;; ---------- LB_SETCURSEL (0x0186) ----------
    ;; wParam = index (-1 to clear). Clamp to count-1 if out of range.
    (if (i32.eq (local.get $msg) (i32.const 0x0186))
      (then
        (local.set $idx (local.get $wParam))
        (local.set $count (i32.load offset=12 (local.get $sw)))
        (if (i32.ge_s (local.get $idx) (local.get $count))
          (then (local.set $idx (i32.const -1))))
        (i32.store offset=16 (local.get $sw) (local.get $idx))
        (local.set $i (i32.const 0))
        (block $setcur_clear_done (loop $setcur_clear
          (br_if $setcur_clear_done (i32.ge_u (local.get $i) (local.get $count)))
          (i32.store8 (i32.add (call $g2w (i32.load offset=44 (local.get $sw))) (local.get $i))
            (i32.eq (local.get $i) (local.get $idx)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $setcur_clear)))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (local.get $idx))))

    ;; ---------- LB_GETTEXT (0x0189) ----------
    ;; wParam = index, lParam = guest dest buffer. Returns chars copied (excl NUL),
    ;; or LB_ERR(-1) if index out of range.
    (if (i32.eq (local.get $msg) (i32.const 0x0189))
      (then
        (local.set $idx (local.get $wParam))
        (local.set $count (i32.load offset=12 (local.get $sw)))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_s (local.get $idx) (local.get $count)))
          (then (return (i32.const -1))))
        ;; Walk NUL-separated buffer to item $idx.
        (local.set $items_w (call $g2w (i32.load (local.get $sw))))
        (local.set $p (local.get $items_w))
        (local.set $i (i32.const 0))
        (block $found (loop $skip
          (br_if $found (i32.eq (local.get $i) (local.get $idx)))
          (local.set $p (i32.add (local.get $p)
                          (i32.add (call $strlen (local.get $p)) (i32.const 1))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $skip)))
        (local.set $slen (call $strlen (local.get $p)))
        (local.set $dest_w (call $g2w (local.get $lParam)))
        (call $memcpy (local.get $dest_w) (local.get $p) (local.get $slen))
        (i32.store8 (i32.add (local.get $dest_w) (local.get $slen)) (i32.const 0))
        (return (local.get $slen))))

    ;; ---------- LB_GETTEXTLEN (0x018A) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x018A))
      (then
        (local.set $idx (local.get $wParam))
        (local.set $count (i32.load offset=12 (local.get $sw)))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_s (local.get $idx) (local.get $count)))
          (then (return (i32.const -1))))
        (local.set $items_w (call $g2w (i32.load (local.get $sw))))
        (local.set $p (local.get $items_w))
        (local.set $i (i32.const 0))
        (block $found2 (loop $skip2
          (br_if $found2 (i32.eq (local.get $i) (local.get $idx)))
          (local.set $p (i32.add (local.get $p)
                          (i32.add (call $strlen (local.get $p)) (i32.const 1))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $skip2)))
        (return (call $strlen (local.get $p)))))

    ;; ---------- WM_LBUTTONDOWN (0x0201) / WM_LBUTTONDBLCLK (0x0203) ----------
    ;; lParam = MAKELPARAM(x, y) within the listbox client. Compute row =
    ;; top_index + y/16, clamp to count-1, set cur_sel, post WM_COMMAND
    ;; with notification = LBN_SELCHANGE (single click) or LBN_DBLCLK (dbl).
    (if (i32.or (i32.eq (local.get $msg) (i32.const 0x0201))
                (i32.eq (local.get $msg) (i32.const 0x0203)))
      (then
        (local.set $count (i32.load offset=12 (local.get $sw)))
        ;; --- WS_VSCROLL strip hit-test (arrows only) ---
        ;; If the click lands in the right-edge 16px scrollbar strip, adjust
        ;; top_index and short-circuit before the row-select path.
        (if (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00200000))
          (then
            (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
            (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
            (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
            (local.set $row (i32.shr_s (i32.shl (local.get $lParam) (i32.const 16)) (i32.const 16)))
            (local.set $row_y (i32.shr_s (local.get $lParam) (i32.const 16)))
            (if (i32.ge_s (local.get $row) (i32.sub (local.get $w) (i32.const 16)))
              (then
                ;; visible rows based on strip-reduced client
                (local.set $visible (i32.div_u (i32.sub (local.get $h) (i32.const 4)) (i32.const 16)))
                (local.set $top (i32.load offset=20 (local.get $sw)))
                (local.set $max (i32.sub (local.get $count) (local.get $visible)))
                (if (i32.lt_s (local.get $max) (i32.const 0))
                  (then (local.set $max (i32.const 0))))
                (if (i32.lt_s (local.get $row_y) (i32.const 16))
                  (then ;; up arrow
                    (if (i32.gt_s (local.get $top) (i32.const 0))
                      (then (i32.store offset=20 (local.get $sw)
                              (i32.sub (local.get $top) (i32.const 1)))))
                    (global.set $sb_pressed_hwnd (local.get $hwnd))
                    (global.set $sb_pressed_part (i32.const 1)))
                  (else (if (i32.ge_s (local.get $row_y) (i32.sub (local.get $h) (i32.const 16)))
                    (then ;; down arrow
                      (if (i32.lt_s (local.get $top) (local.get $max))
                        (then (i32.store offset=20 (local.get $sw)
                                (i32.add (local.get $top) (i32.const 1)))))
                      (global.set $sb_pressed_hwnd (local.get $hwnd))
                      (global.set $sb_pressed_part (i32.const 2)))
                    (else ;; track click — page or thumb-drag start
                      (if (i32.gt_s (local.get $max) (i32.const 0))
                        (then
                          (if (i32.eq
                                (call $listbox_page_hit
                                  (local.get $hwnd) (local.get $sw)
                                  (local.get $row_y) (local.get $h)
                                  (local.get $top) (local.get $max)
                                  (local.get $visible))
                                (i32.const 3))
                            (then
                              ;; Thumb hit — take mouse capture so WM_MOUSEMOVE
                              ;; and WM_LBUTTONUP are routed to this listbox
                              ;; even when the cursor leaves it. sb_pressed
                              ;; drives the thumb-pressed paint visual.
                              (global.set $capture_hwnd (local.get $hwnd))
                              (global.set $sb_pressed_hwnd (local.get $hwnd))
                              (global.set $sb_pressed_part (i32.const 5))))))))))
                (drop (call $wnd_send_message
                  (local.get $hwnd) (i32.const 0x000F) (i32.const 0) (i32.const 0)))
                (call $invalidate_hwnd (local.get $hwnd))
                (return (i32.const 0))))))
        (if (i32.eqz (local.get $count)) (then (return (i32.const 0))))
        ;; y from hi 16 bits of lParam
        (local.set $row (i32.shr_u (i32.and (local.get $lParam) (i32.const 0xFFFF0000)) (i32.const 16)))
        (local.set $row (i32.div_s (local.get $row) (i32.const 16)))
        (local.set $row (i32.add (local.get $row) (i32.load offset=20 (local.get $sw))))
        (if (i32.lt_s (local.get $row) (i32.const 0))
          (then (local.set $row (i32.const 0))))
        (if (i32.ge_s (local.get $row) (local.get $count))
          (then (local.set $row (i32.sub (local.get $count) (i32.const 1)))))
        (if (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00000800))
          (then
            ;; LBS_EXTENDEDSEL: Ctrl toggles a row; Shift selects the range
            ;; from the previous caret; an unmodified click replaces all.
            (local.set $sel (i32.load offset=16 (local.get $sw)))
            (if (i32.and (local.get $wParam) (i32.const 0x0008)) ;; MK_CONTROL
              (then
                (i32.store8
                  (i32.add (call $g2w (i32.load offset=44 (local.get $sw))) (local.get $row))
                  (i32.eqz (i32.load8_u
                    (i32.add (call $g2w (i32.load offset=44 (local.get $sw))) (local.get $row))))))
              (else
                (local.set $i (i32.const 0))
                (block $click_sel_done (loop $click_sel
                  (br_if $click_sel_done (i32.ge_u (local.get $i) (local.get $count)))
                  (if (i32.and (local.get $wParam) (i32.const 0x0004)) ;; MK_SHIFT
                    (then
                      (i32.store8
                        (i32.add (call $g2w (i32.load offset=44 (local.get $sw))) (local.get $i))
                        (i32.or
                          (i32.and (i32.ge_s (local.get $i) (local.get $sel))
                                   (i32.le_s (local.get $i) (local.get $row)))
                          (i32.and (i32.ge_s (local.get $i) (local.get $row))
                                   (i32.le_s (local.get $i) (local.get $sel))))))
                    (else
                      (i32.store8
                        (i32.add (call $g2w (i32.load offset=44 (local.get $sw))) (local.get $i))
                        (i32.eq (local.get $i) (local.get $row)))))
                  (local.set $i (i32.add (local.get $i) (i32.const 1)))
                  (br $click_sel))))))
          (else
            (local.set $i (i32.const 0))
            (block $click_single_done (loop $click_single
              (br_if $click_single_done (i32.ge_u (local.get $i) (local.get $count)))
              (i32.store8
                (i32.add (call $g2w (i32.load offset=44 (local.get $sw))) (local.get $i))
                (i32.eq (local.get $i) (local.get $row)))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $click_single)))))
        (i32.store offset=16 (local.get $sw) (local.get $row))
        ;; Post WM_COMMAND to parent: HIWORD = notification, LOWORD = ctrl_id.
        (local.set $notif (i32.const 1))  ;; LBN_SELCHANGE
        (if (i32.eq (local.get $msg) (i32.const 0x0203))
          (then (local.set $notif (i32.const 2))))  ;; LBN_DBLCLK
        (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
        (if (local.get $parent)
          (then
            (drop (call $wnd_send_message (local.get $parent) (i32.const 0x0111)
                    (i32.or (i32.load offset=24 (local.get $sw))
                            (i32.shl (local.get $notif) (i32.const 16)))
                    (local.get $hwnd)))))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 0))))

    ;; ---------- WM_LBUTTONUP (0x0202) — release scrollbar press ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0202))
      (then
        (if (i32.eq (global.get $sb_pressed_hwnd) (local.get $hwnd))
          (then
            (global.set $sb_pressed_hwnd (i32.const 0))
            (global.set $sb_pressed_part (i32.const 0))
            (call $invalidate_hwnd (local.get $hwnd))))
        ;; Release mouse capture if we owned it (thumb drag). Harmless if
        ;; another hwnd holds capture — we only clear our own.
        (if (i32.eq (global.get $capture_hwnd) (local.get $hwnd))
          (then (global.set $capture_hwnd (i32.const 0))))
        (return (i32.const 0))))

    ;; ---------- WM_MOUSEMOVE (0x0200) — thumb drag ----------
    ;; Active only when this hwnd owns sb_pressed with part=5 (thumb).
    ;; Recomputes top from anchor_top + delta_y mapped to [0,max] using
    ;; the same arrow=16 / track=h-32 geometry as $paint_vscrollbar_rect.
    (if (i32.eq (local.get $msg) (i32.const 0x0200))
      (then
        (if (i32.and (i32.eq (global.get $sb_pressed_hwnd) (local.get $hwnd))
                     (i32.eq (global.get $sb_pressed_part) (i32.const 5)))
          (then
            (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
            (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
            (local.set $row_y (i32.shr_s (local.get $lParam) (i32.const 16)))
            (local.set $count (i32.load offset=12 (local.get $sw)))
            (local.set $visible (i32.div_u (i32.sub (local.get $h) (i32.const 4)) (i32.const 16)))
            (local.set $max (i32.sub (local.get $count) (local.get $visible)))
            (if (i32.lt_s (local.get $max) (i32.const 0))
              (then (local.set $max (i32.const 0))))
            (if (i32.gt_s (local.get $max) (i32.const 0))
              (then
                (call $listbox_drag_to (local.get $hwnd) (local.get $sw)
                  (local.get $row_y) (local.get $h) (local.get $max))
                (call $invalidate_hwnd (local.get $hwnd))))))
        (return (i32.const 0))))

    ;; ---------- WM_KEYDOWN (0x0100) ----------
    ;; VK_UP/DOWN/HOME/END/PRIOR/NEXT navigate the listbox; each fires
    ;; LBN_SELCHANGE to the parent. Used by the combobox popup to drive
    ;; the inner listbox via keyboard.
    (if (i32.eq (local.get $msg) (i32.const 0x0100))
      (then
        (local.set $count (i32.load offset=12 (local.get $sw)))
        (if (i32.eqz (local.get $count)) (then (return (i32.const 0))))
        (local.set $sel (i32.load offset=16 (local.get $sw)))
        ;; Compute visible rows for PGUP/PGDN
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        (local.set $visible (i32.div_u (i32.sub (local.get $h) (i32.const 4)) (i32.const 16)))
        (if (i32.lt_s (local.get $visible) (i32.const 1))
          (then (local.set $visible (i32.const 1))))
        (local.set $row (local.get $sel))
        (if (i32.eq (local.get $wParam) (i32.const 0x24)) ;; VK_HOME
          (then (local.set $row (i32.const 0)))
          (else (if (i32.eq (local.get $wParam) (i32.const 0x23)) ;; VK_END
            (then (local.set $row (i32.sub (local.get $count) (i32.const 1))))
            (else (if (i32.eq (local.get $wParam) (i32.const 0x28)) ;; VK_DOWN
              (then
                (if (i32.lt_s (local.get $row) (i32.const 0))
                  (then (local.set $row (i32.const 0)))
                  (else
                    (local.set $row (i32.add (local.get $row) (i32.const 1)))
                    (if (i32.ge_s (local.get $row) (local.get $count))
                      (then (local.set $row (i32.sub (local.get $count) (i32.const 1))))))))
              (else (if (i32.eq (local.get $wParam) (i32.const 0x26)) ;; VK_UP
                (then
                  (if (i32.le_s (local.get $row) (i32.const 0))
                    (then (local.set $row (i32.const 0)))
                    (else (local.set $row (i32.sub (local.get $row) (i32.const 1))))))
                (else (if (i32.eq (local.get $wParam) (i32.const 0x21)) ;; VK_PRIOR
                  (then
                    (if (i32.lt_s (local.get $row) (i32.const 0))
                      (then (local.set $row (i32.const 0)))
                      (else
                        (local.set $row (i32.sub (local.get $row) (local.get $visible)))
                        (if (i32.lt_s (local.get $row) (i32.const 0))
                          (then (local.set $row (i32.const 0)))))))
                  (else (if (i32.eq (local.get $wParam) (i32.const 0x22)) ;; VK_NEXT
                    (then
                      (if (i32.lt_s (local.get $row) (i32.const 0))
                        (then (local.set $row (i32.const 0)))
                        (else
                          (local.set $row (i32.add (local.get $row) (local.get $visible)))
                          (if (i32.ge_s (local.get $row) (local.get $count))
                            (then (local.set $row (i32.sub (local.get $count) (i32.const 1))))))))
                    (else (return (i32.const 0))))))))))))))
        (i32.store offset=16 (local.get $sw) (local.get $row))
        (local.set $i (i32.const 0))
        (block $key_sel_done (loop $key_sel
          (br_if $key_sel_done (i32.ge_u (local.get $i) (local.get $count)))
          (i32.store8
            (i32.add (call $g2w (i32.load offset=44 (local.get $sw))) (local.get $i))
            (i32.eq (local.get $i) (local.get $row)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $key_sel)))
        ;; Adjust top_index so $row stays visible.
        (local.set $top (i32.load offset=20 (local.get $sw)))
        (if (i32.lt_s (local.get $row) (local.get $top))
          (then (i32.store offset=20 (local.get $sw) (local.get $row)))
          (else
            (if (i32.ge_s (local.get $row) (i32.add (local.get $top) (local.get $visible)))
              (then (i32.store offset=20 (local.get $sw)
                      (i32.add (i32.sub (local.get $row) (local.get $visible)) (i32.const 1)))))))
        (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
        (if (local.get $parent)
          (then (drop (call $wnd_send_message (local.get $parent) (i32.const 0x0111)
                  (i32.or (i32.load offset=24 (local.get $sw))
                          (i32.shl (i32.const 1) (i32.const 16)))  ;; LBN_SELCHANGE
                  (local.get $hwnd)))))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 0))))

    ;; ---------- LB_INSERTSTRING (0x0181) — wParam=index, lParam=string ptr ----------
    ;; -1 (or any index past the end) means "append" — LB_ADDSTRING semantics.
    ;; A real mid-list insert matters beyond sorted listboxes: an app that keeps
    ;; a parallel array of its own records indexes both by row, so appending a
    ;; string the caller asked to insert at N silently shifts every row past N
    ;; out of step with that array. Task Manager does exactly this (its rows
    ;; pair with a comctl32 DSA), and End Task then acted on the wrong window.
    ;;
    ;; Strategy: let LB_ADDSTRING do the appending and all three buffer grows,
    ;; then rotate that last item down into place.
    (if (i32.eq (local.get $msg) (i32.const 0x0181))
      (then
        (local.set $idx (local.get $wParam))
        (local.set $count (i32.load offset=12 (local.get $sw)))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_s (local.get $idx) (local.get $count)))
          (then (return (call $listbox_wndproc (local.get $hwnd)
                          (i32.const 0x0180) (i32.const 0) (local.get $lParam)))))
        (if (i32.lt_s (call $listbox_wndproc (local.get $hwnd)
                        (i32.const 0x0180) (i32.const 0) (local.get $lParam))
                      (i32.const 0))
          (then (return (i32.const -1))))
        (local.set $items_w (call $g2w (i32.load (local.get $sw))))
        (local.set $used (i32.load offset=4 (local.get $sw)))
        ;; Byte offset of item $idx, then of the item just appended.
        (local.set $p (local.get $items_w))
        (local.set $i (i32.const 0))
        (block $ins_at (loop $ins_skip
          (br_if $ins_at (i32.eq (local.get $i) (local.get $idx)))
          (local.set $p (i32.add (local.get $p)
                          (i32.add (call $strlen (local.get $p)) (i32.const 1))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $ins_skip)))
        (local.set $dest_g (i32.sub (local.get $p) (local.get $items_w)))
        (local.set $tmp_w (local.get $p))
        (block $ins_last (loop $ins_walk
          (br_if $ins_last (i32.ge_s (local.get $i) (local.get $count)))
          (local.set $tmp_w (i32.add (local.get $tmp_w)
                              (i32.add (call $strlen (local.get $tmp_w)) (i32.const 1))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $ins_walk)))
        (local.set $last (i32.sub (local.get $tmp_w) (local.get $items_w)))
        (local.set $slen (i32.sub (local.get $used) (local.get $last)))
        ;; Park the appended string, open the gap, drop it in. memory.copy is
        ;; memmove-like, so the overlapping shift up is safe.
        (local.set $tmp_g (call $heap_alloc (local.get $slen)))
        (memory.copy (call $g2w (local.get $tmp_g))
                     (i32.add (local.get $items_w) (local.get $last))
                     (local.get $slen))
        (memory.copy (i32.add (local.get $items_w)
                       (i32.add (local.get $dest_g) (local.get $slen)))
                     (i32.add (local.get $items_w) (local.get $dest_g))
                     (i32.sub (local.get $last) (local.get $dest_g)))
        (memory.copy (i32.add (local.get $items_w) (local.get $dest_g))
                     (call $g2w (local.get $tmp_g))
                     (local.get $slen))
        (call $heap_free (local.get $tmp_g))
        ;; Rotate the parallel item-data array the same way. LB_ADDSTRING
        ;; zeroed the appended slot, so $idx ends up with a fresh 0.
        (if (i32.load offset=36 (local.get $sw))
          (then
            (local.set $dest_w (call $g2w (i32.load offset=36 (local.get $sw))))
            (local.set $sz (i32.load
              (i32.add (local.get $dest_w) (i32.mul (local.get $count) (i32.const 4)))))
            (memory.copy
              (i32.add (local.get $dest_w)
                (i32.mul (i32.add (local.get $idx) (i32.const 1)) (i32.const 4)))
              (i32.add (local.get $dest_w) (i32.mul (local.get $idx) (i32.const 4)))
              (i32.mul (i32.sub (local.get $count) (local.get $idx)) (i32.const 4)))
            (i32.store (i32.add (local.get $dest_w) (i32.mul (local.get $idx) (i32.const 4)))
              (local.get $sz))))
        ;; And the byte-per-row multi-selection flags.
        (if (i32.load offset=44 (local.get $sw))
          (then
            (local.set $dest_w (call $g2w (i32.load offset=44 (local.get $sw))))
            (local.set $sz (i32.load8_u
              (i32.add (local.get $dest_w) (local.get $count))))
            (memory.copy
              (i32.add (local.get $dest_w) (i32.add (local.get $idx) (i32.const 1)))
              (i32.add (local.get $dest_w) (local.get $idx))
              (i32.sub (local.get $count) (local.get $idx)))
            (i32.store8 (i32.add (local.get $dest_w) (local.get $idx)) (local.get $sz))))
        ;; A selection at or after the insert point moves down a row.
        (local.set $sel (i32.load offset=16 (local.get $sw)))
        (if (i32.ge_s (local.get $sel) (local.get $idx))
          (then (i32.store offset=16 (local.get $sw)
                  (i32.add (local.get $sel) (i32.const 1)))))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (local.get $idx))))

    ;; ---------- LB_DELETESTRING (0x0182) ----------
    ;; wParam = index. Removes the item; returns new count, or LB_ERR(-1).
    (if (i32.eq (local.get $msg) (i32.const 0x0182))
      (then
        (local.set $idx (local.get $wParam))
        (local.set $count (i32.load offset=12 (local.get $sw)))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_s (local.get $idx) (local.get $count)))
          (then (return (i32.const -1))))
        (local.set $items_w (call $g2w (i32.load (local.get $sw))))
        (local.set $p (local.get $items_w))
        (local.set $i (i32.const 0))
        (block $delfound (loop $delskip
          (br_if $delfound (i32.eq (local.get $i) (local.get $idx)))
          (local.set $p (i32.add (local.get $p)
                          (i32.add (call $strlen (local.get $p)) (i32.const 1))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $delskip)))
        (local.set $slen (i32.add (call $strlen (local.get $p)) (i32.const 1)))
        ;; Shift tail down by $slen bytes
        (local.set $used (i32.load offset=4 (local.get $sw)))
        (local.set $i (i32.sub (local.get $p) (local.get $items_w)))
        (call $memcpy (local.get $p)
                      (i32.add (local.get $p) (local.get $slen))
                      (i32.sub (local.get $used) (i32.add (local.get $i) (local.get $slen))))
        (i32.store offset=4 (local.get $sw) (i32.sub (local.get $used) (local.get $slen)))
        (i32.store offset=12 (local.get $sw) (i32.sub (local.get $count) (i32.const 1)))
        ;; Shift parallel data array down by one slot at $idx.
        (if (i32.load offset=36 (local.get $sw))
          (then
            (local.set $dest_w
              (i32.add (call $g2w (i32.load offset=36 (local.get $sw)))
                       (i32.mul (local.get $idx) (i32.const 4))))
            (call $memcpy (local.get $dest_w)
                          (i32.add (local.get $dest_w) (i32.const 4))
                          (i32.mul (i32.sub (i32.sub (local.get $count) (local.get $idx))
                                            (i32.const 1))
                                   (i32.const 4)))))
        ;; Shift parallel multi-selection flags down by one row.
        (if (i32.load offset=44 (local.get $sw))
          (then
            (local.set $dest_w
              (i32.add (call $g2w (i32.load offset=44 (local.get $sw))) (local.get $idx)))
            (call $memcpy (local.get $dest_w)
                          (i32.add (local.get $dest_w) (i32.const 1))
                          (i32.sub (i32.sub (local.get $count) (local.get $idx)) (i32.const 1)))
            (i32.store8
              (i32.add (call $g2w (i32.load offset=44 (local.get $sw)))
                       (i32.sub (local.get $count) (i32.const 1)))
              (i32.const 0))))
        ;; Adjust cur_sel if affected
        (local.set $sel (i32.load offset=16 (local.get $sw)))
        (if (i32.eq (local.get $sel) (local.get $idx))
          (then (i32.store offset=16 (local.get $sw) (i32.const -1)))
          (else (if (i32.gt_s (local.get $sel) (local.get $idx))
            (then (i32.store offset=16 (local.get $sw) (i32.sub (local.get $sel) (i32.const 1)))))))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.sub (local.get $count) (i32.const 1)))))

    ;; ---------- LB_GETITEMDATA (0x0199) / LB_SETITEMDATA (0x019A) ----------
    ;; wParam = index. SETITEMDATA's lParam is the new u32. Out-of-range → -1.
    (if (i32.or (i32.eq (local.get $msg) (i32.const 0x0199))
                (i32.eq (local.get $msg) (i32.const 0x019A)))
      (then
        (local.set $idx (local.get $wParam))
        (local.set $count (i32.load offset=12 (local.get $sw)))
        (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                    (i32.ge_s (local.get $idx) (local.get $count)))
          (then (return (i32.const -1))))
        (if (i32.eqz (i32.load offset=36 (local.get $sw)))
          (then (return (i32.const 0))))
        (local.set $dest_w
          (i32.add (call $g2w (i32.load offset=36 (local.get $sw)))
                   (i32.mul (local.get $idx) (i32.const 4))))
        (if (i32.eq (local.get $msg) (i32.const 0x019A))
          (then
            (i32.store (local.get $dest_w) (local.get $lParam))
            (return (i32.const 0))))
        (return (i32.load (local.get $dest_w)))))

    ;; ---------- LB_FINDSTRING (0x018F) / LB_FINDSTRINGEXACT (0x01A2) ----------
    ;; wParam = start index (-1 = from 0); lParam = NUL-terminated query.
    ;; FINDSTRING does prefix match (case-insensitive); FINDSTRINGEXACT
    ;; requires equal length AND case-insensitive match. Wraps around.
    ;; Returns first index found, or LB_ERR(-1).
    (if (i32.or (i32.eq (local.get $msg) (i32.const 0x018F))
                (i32.eq (local.get $msg) (i32.const 0x01A2)))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const -1))))
        (local.set $count (i32.load offset=12 (local.get $sw)))
        (if (i32.eqz (local.get $count)) (then (return (i32.const -1))))
        (local.set $src_w (call $g2w (local.get $lParam)))
        (local.set $slen (call $strlen (local.get $src_w)))
        ;; Walk all items starting at (start+1) % count, wrapping back.
        (local.set $idx (local.get $wParam))
        (if (i32.lt_s (local.get $idx) (i32.const 0))
          (then (local.set $idx (i32.sub (local.get $count) (i32.const 1)))))
        (local.set $items_w (call $g2w (i32.load (local.get $sw))))
        (local.set $i (i32.const 0))
        (block $fsdone (loop $fsloop
          (br_if $fsdone (i32.ge_s (local.get $i) (local.get $count)))
          (local.set $idx (i32.add (local.get $idx) (i32.const 1)))
          (if (i32.ge_s (local.get $idx) (local.get $count))
            (then (local.set $idx (i32.const 0))))
          ;; Walk to item $idx
          (local.set $p (local.get $items_w))
          (local.set $row (i32.const 0))
          (block $fsskip (loop $fssk
            (br_if $fsskip (i32.eq (local.get $row) (local.get $idx)))
            (local.set $p (i32.add (local.get $p)
                            (i32.add (call $strlen (local.get $p)) (i32.const 1))))
            (local.set $row (i32.add (local.get $row) (i32.const 1)))
            (br $fssk)))
          (local.set $row_y (call $strlen (local.get $p))) ;; reuse $row_y as item-len
          ;; FINDSTRINGEXACT requires equal length; FINDSTRING needs item len >= query len
          (if (i32.eq (local.get $msg) (i32.const 0x01A2))
            (then (if (i32.ne (local.get $row_y) (local.get $slen))
                    (then (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $fsloop))))
            (else (if (i32.lt_u (local.get $row_y) (local.get $slen))
                    (then (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $fsloop)))))
          ;; Case-insensitive compare $slen bytes
          (if (call $listbox_strncmpi (local.get $p) (local.get $src_w) (local.get $slen))
            (then (return (local.get $idx))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $fsloop)))
        (return (i32.const -1))))

    ;; ---------- LB_SELECTSTRING (0x018C) ----------
    ;; FINDSTRING + SETCURSEL. Returns selected index or LB_ERR.
    (if (i32.eq (local.get $msg) (i32.const 0x018C))
      (then
        (local.set $idx (call $listbox_wndproc (local.get $hwnd)
                          (i32.const 0x018F) (local.get $wParam) (local.get $lParam)))
        (if (i32.lt_s (local.get $idx) (i32.const 0)) (then (return (i32.const -1))))
        (drop (call $listbox_wndproc (local.get $hwnd)
                (i32.const 0x0186) (local.get $idx) (i32.const 0)))
        (return (local.get $idx))))

    ;; ---------- LB_GETTOPINDEX (0x018E) / LB_SETTOPINDEX (0x0197) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x018E))
      (then (return (i32.load offset=20 (local.get $sw)))))
    (if (i32.eq (local.get $msg) (i32.const 0x0197))
      (then
        (local.set $idx (local.get $wParam))
        (local.set $count (i32.load offset=12 (local.get $sw)))
        (if (i32.lt_s (local.get $idx) (i32.const 0)) (then (local.set $idx (i32.const 0))))
        (if (i32.ge_s (local.get $idx) (local.get $count))
          (then (local.set $idx (i32.sub (local.get $count) (i32.const 1)))))
        (if (i32.lt_s (local.get $idx) (i32.const 0)) (then (local.set $idx (i32.const 0))))
        (i32.store offset=20 (local.get $sw) (local.get $idx))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 0))))

    ;; ---------- WM_PAINT (0x000F) ----------
    ;; Draw inset frame, white interior, and visible item rows. Selected
    ;; item is rendered with the system highlight (blue background +
    ;; white text). Item height is fixed at 16 px. If WS_VSCROLL is set,
    ;; a 16px scrollbar strip is reserved at the right edge.
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        ;; Skip paint when not WS_VISIBLE — combobox dropdowns rely on this:
        ;; their inner listbox child is invisible until $combobox_open_dropdown
        ;; sets WS_VISIBLE. Without this guard, LB_ADDSTRING's invalidate path
        ;; would paint the invisible dropped-area onto the parent every time
        ;; the combobox is populated.
        (if (i32.eqz (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x10000000)))
          (then (return (i32.const 0))))
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))
        (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))
        ;; Reserve right strip for WS_VSCROLL (0x00200000). Content uses w'=w-16.
        (if (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00200000))
          (then (local.set $w (i32.sub (local.get $w) (i32.const 16)))))
        ;; White interior + sunken edge (content rect only).
        (drop (call $host_gdi_fill_rect (local.get $hdc)
                (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
                (i32.const 0x30010)))
        (drop (call $host_gdi_draw_edge (local.get $hdc)
                (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
                (i32.const 0x0A) (i32.const 0x0F)))
        (local.set $count (i32.load offset=12 (local.get $sw)))
        (local.set $sel   (i32.load offset=16 (local.get $sw)))
        (local.set $top   (i32.load offset=20 (local.get $sw)))
        (local.set $row_h (i32.const 16))
        (local.set $visible (i32.div_u (i32.sub (local.get $h) (i32.const 4)) (local.get $row_h)))
        ;; Walk to the first visible item.
        (local.set $items_w (call $g2w (i32.load (local.get $sw))))
        (local.set $p (local.get $items_w))
        (local.set $i (i32.const 0))
        (block $skip_done (loop $skip
          (br_if $skip_done (i32.ge_u (local.get $i) (local.get $top)))
          (br_if $skip_done (i32.ge_u (local.get $i) (local.get $count)))
          (local.set $p (i32.add (local.get $p)
                          (i32.add (call $strlen (local.get $p)) (i32.const 1))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $skip)))
        ;; Render visible rows.
        (local.set $row (i32.const 0))
        (block $rows_done (loop $rows
          (br_if $rows_done (i32.ge_u (local.get $row) (local.get $visible)))
          (local.set $idx (i32.add (local.get $top) (local.get $row)))
          (br_if $rows_done (i32.ge_u (local.get $idx) (local.get $count)))
          (local.set $row_y (i32.add (i32.const 2) (i32.mul (local.get $row) (local.get $row_h))))
          (local.set $slen (call $strlen (local.get $p)))
          (if (i32.load8_u
                (i32.add (call $g2w (i32.load offset=44 (local.get $sw))) (local.get $idx)))
            (then
              ;; Highlight bar (system blue) + white text. We use a fresh
              ;; solid brush each time so we don't depend on COLOR_HIGHLIGHT
              ;; being mapped in the stock-brush table.
              (local.set $brush (call $host_gdi_create_solid_brush (i32.const 0x00800000)))
              (drop (call $host_gdi_fill_rect (local.get $hdc)
                      (i32.const 2) (local.get $row_y)
                      (i32.sub (local.get $w) (i32.const 2))
                      (i32.add (local.get $row_y) (local.get $row_h))
                      (local.get $brush)))
              (drop (call $host_gdi_delete_object (local.get $brush)))
              (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x00FFFFFF)))
              (if (local.get $slen)
                (then (drop (call $host_gdi_text_out (local.get $hdc)
                              (i32.const 4) (i32.add (local.get $row_y) (i32.const 2))
                              (local.get $p) (local.get $slen) (i32.const 0)))))
              (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x00000000))))
            (else
              (if (local.get $slen)
                (then (drop (call $host_gdi_text_out (local.get $hdc)
                              (i32.const 4) (i32.add (local.get $row_y) (i32.const 2))
                              (local.get $p) (local.get $slen) (i32.const 0)))))))
          (local.set $p (i32.add (local.get $p) (i32.add (local.get $slen) (i32.const 1))))
          (local.set $row (i32.add (local.get $row) (i32.const 1)))
          (br $rows)))
        ;; WS_VSCROLL strip. $w here is already reduced; full width is via sz.
        (if (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00200000))
          (then
            (local.set $visible (i32.div_u (i32.sub (local.get $h) (i32.const 4)) (i32.const 16)))
            (local.set $max (i32.sub (local.get $count) (local.get $visible)))
            (if (i32.lt_s (local.get $max) (i32.const 0))
              (then (local.set $max (i32.const 0))))
            (call $paint_vscrollbar_rect (local.get $hdc)
              (local.get $w) (i32.const 0) (i32.const 16) (local.get $h)
              (i32.load offset=20 (local.get $sw)) (local.get $max)
              (select (global.get $sb_pressed_part) (i32.const 0)
                      (i32.eq (global.get $sb_pressed_hwnd) (local.get $hwnd))))))
        (return (i32.const 0))))

    ;; Default
    (i32.const 0)
  )

  ;; ============================================================
  ;; ComboBox WndProc  (control class 5)
  ;; ============================================================
  ;;
  ;; Real combobox: item storage delegates to an inner listbox child (class 4).
  ;; The listbox is created at WM_CREATE sized to fill (0, FIELD_H, w, h-FIELD_H)
  ;; — using the cy budget from the dialog template, which always reserves
  ;; enough height for the dropped state. Toggling the dropdown shows/hides
  ;; the listbox (via WS_VISIBLE).
  ;;
  ;; CBS_* variants (style & 0x3):
  ;;   1=CBS_SIMPLE       listbox is always WS_VISIBLE
  ;;   2=CBS_DROPDOWN     listbox toggled by click/F4/Alt+Down; field is editable
  ;;   3=CBS_DROPDOWNLIST listbox toggled, field shows selection (read-only)
  ;;
  ;; ComboBoxState (40 bytes, allocated in WM_CREATE)
  ;;   +0   text_buf_ptr   guest ptr to selected/typed item text
  ;;   +4   text_len
  ;;   +8   style          full window style
  ;;   +12  ctrl_id        from CREATESTRUCT.hMenu
  ;;   +16  cur_sel        mirror of listbox cur_sel; -1 = none
  ;;   +20  lb_hwnd        inner listbox hwnd
  ;;   +24  popup_hwnd     reserved for future WS_POPUP escape (0 today)
  ;;   +28  edit_hwnd      CBS_DROPDOWN inner edit child; 0 for SIMPLE/DROPDOWNLIST
  ;;   +32  is_dropped     0/1 — CB_GETDROPPEDSTATE
  ;;   +36  variant        1=SIMPLE 2=DROPDOWN 3=DROPDOWNLIST
  ;;
  ;; FIELD_H = 21 px; arrow box = 16 px wide on right edge.

  ;; ============================================================
  ;; ComboBox dropdown popup shell — class 9, WS_POPUP top-level.
  ;; Hosts the inner listbox child for CBS_DROPDOWN/DROPDOWNLIST.
  ;; Owns no state of its own; userdata stores the owner combobox hwnd
  ;; so messages can be forwarded back. Outside-click dismissal happens
  ;; here (combobox SetCapture's the popup). Inside clicks fall through
  ;; to the listbox child via normal hit-testing.
  ;;
  ;;   userdata = owner combo hwnd
  ;; ============================================================
  (func $combo_popup_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $owner i32) (local $rect i32) (local $w i32) (local $h i32)
    (local $mx i32) (local $my i32) (local $sw i32) (local $lb i32)
    (local.set $owner (call $wnd_get_userdata (local.get $hwnd)))
    ;; WM_LBUTTONDOWN / WM_LBUTTONUP / WM_MOUSEMOVE / WM_LBUTTONDBLCLK:
    ;; outside-rect → ask owner combo to close as cancel; inside → forward
    ;; to inner listbox child (which lives at popup-local (0,0), so lParam
    ;; passes through unchanged). The listbox isn't a renderer-known
    ;; window, so the renderer can't deep-hit-test it — forwarding here
    ;; makes click-to-select work for CBS_DROPDOWNLIST popups.
    (if (i32.or
          (i32.or (i32.eq (local.get $msg) (i32.const 0x0201))   ;; WM_LBUTTONDOWN
                  (i32.eq (local.get $msg) (i32.const 0x0202)))  ;; WM_LBUTTONUP
          (i32.or (i32.eq (local.get $msg) (i32.const 0x0200))   ;; WM_MOUSEMOVE
                  (i32.eq (local.get $msg) (i32.const 0x0203)))) ;; WM_LBUTTONDBLCLK
      (then
        (local.set $mx (i32.shr_s (i32.shl (local.get $lParam) (i32.const 16)) (i32.const 16)))
        (local.set $my (i32.shr_s (local.get $lParam) (i32.const 16)))
        (local.set $rect (global.get $PAINT_SCRATCH))
        (call $host_get_window_rect (local.get $hwnd) (local.get $rect))
        (local.set $w (i32.sub (i32.load offset=8  (local.get $rect))
                                (i32.load          (local.get $rect))))
        (local.set $h (i32.sub (i32.load offset=12 (local.get $rect))
                                (i32.load offset=4 (local.get $rect))))
        (if (i32.or
              (i32.or (i32.lt_s (local.get $mx) (i32.const 0))
                      (i32.lt_s (local.get $my) (i32.const 0)))
              (i32.or (i32.ge_s (local.get $mx) (local.get $w))
                      (i32.ge_s (local.get $my) (local.get $h))))
          (then
            ;; Outside rect: only LBUTTONDOWN dismisses the dropdown.
            ;; (UP/MOVE outside should be ignored, not trigger close.)
            (if (i32.eq (local.get $msg) (i32.const 0x0201))
              (then
                (if (local.get $owner)
                  (then (call $combobox_close_dropdown (local.get $owner) (i32.const 0))))))
            (return (i32.const 0))))
        ;; Inside: forward to listbox child (state offset +20).
        (if (local.get $owner)
          (then
            (local.set $sw (call $wnd_get_state_ptr (local.get $owner)))
            (if (local.get $sw)
              (then
                (local.set $lb (i32.load offset=20 (call $g2w (local.get $sw))))
                (if (local.get $lb)
                  (then (drop (call $wnd_send_message (local.get $lb)
                                (local.get $msg) (local.get $wParam) (local.get $lParam)))))))))
        (return (i32.const 0))))
    ;; WM_COMMAND from inner listbox child — forward to owner combo so its
    ;; existing LBN_SELCHANGE / LBN_DBLCLK handling fires.
    (if (i32.eq (local.get $msg) (i32.const 0x0111))
      (then
        (if (local.get $owner)
          (then (return (call $wnd_send_message (local.get $owner)
                              (local.get $msg) (local.get $wParam) (local.get $lParam)))))
        (return (i32.const 0))))
    ;; WM_KEYDOWN: forward to owner combo (it already handles VK_ESC/RETURN/UP/DOWN).
    (if (i32.eq (local.get $msg) (i32.const 0x0100))
      (then
        (if (local.get $owner)
          (then (return (call $wnd_send_message (local.get $owner)
                              (local.get $msg) (local.get $wParam) (local.get $lParam)))))
        (return (i32.const 0))))
    ;; WM_CAPTURECHANGED (0x0215): popup lost capture → close as cancel.
    (if (i32.eq (local.get $msg) (i32.const 0x0215))
      (then
        (if (local.get $owner)
          (then (call $combobox_close_dropdown (local.get $owner) (i32.const 0))))
        (return (i32.const 0))))
    ;; All others: DefWindowProc (return 0).
    (i32.const 0)
  )

  ;; Allocate + register a WS_POPUP top-level dropdown shell owned by the
  ;; given combobox. Returns the popup hwnd. Created hidden — caller (or
  ;; $combobox_open_dropdown) ShowWindows it later. Userdata stores the
  ;; owner combo hwnd so $combo_popup_wndproc can forward messages back.
  (func $combo_create_popup (param $combo i32) (param $w i32) (param $h i32) (result i32)
    (local $popup i32) (local $slot i32)
    (local.set $popup (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    ;; Register a JS-side window record (no chrome — kind bit 2 = isPopup).
    (call $host_register_dialog_frame
      (local.get $popup) (local.get $combo)
      (i32.const 0)              ;; no title
      (local.get $w) (local.get $h)
      (i32.const 4))             ;; kind = 4 (isPopup)
    (call $wnd_table_set (local.get $popup) (global.get $WNDPROC_CTRL_NATIVE))
    (call $wnd_set_parent (local.get $popup) (local.get $combo))
    ;; WS_POPUP — explicitly hidden until open_dropdown shows it.
    (drop (call $wnd_set_style (local.get $popup) (i32.const 0x80000000)))
    (local.set $slot (call $wnd_table_find (local.get $popup)))
    (call $ctrl_table_set (local.get $slot) (i32.const 9) (i32.const 0))
    (drop (call $wnd_set_userdata (local.get $popup) (local.get $combo)))
    (local.get $popup))

  ;; Helper: open the dropdown (show inner listbox, fire CBN_DROPDOWN, set
  ;; capture so outside clicks dismiss). Idempotent.
  ;;
  ;; CBS_DROPDOWN/CBS_DROPDOWNLIST (variants 2/3): the listbox is migrated
  ;; under the pre-allocated WS_POPUP shell (offset=24) and the shell is
  ;; positioned in screen coords directly below the combo's field, then shown
  ;; via host_move_window(SWP_SHOWWINDOW). This lets the dropdown extend past
  ;; the parent dialog's clip rect — a real top-level window.
  (func $combobox_open_dropdown (param $hwnd i32)
    (local $state i32) (local $sw i32) (local $lb i32) (local $style i32) (local $parent i32)
    (local $popup i32) (local $rect i32) (local $lb_wh i32) (local $lb_w i32) (local $lb_h i32)
    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $state)) (then (return)))
    (local.set $sw (call $g2w (local.get $state)))
    (if (i32.load offset=32 (local.get $sw)) (then (return)))  ;; already dropped
    ;; Another combo already dropped on the same dialog? Close it (cancel) before
    ;; opening this one — Win32 only allows one expanded combo dropdown at a time.
    (if (i32.and
          (i32.ne (global.get $combo_open_hwnd) (i32.const 0))
          (i32.ne (global.get $combo_open_hwnd) (local.get $hwnd)))
      (then (call $combobox_close_dropdown (global.get $combo_open_hwnd) (i32.const 0))))
    (local.set $lb (i32.load offset=20 (local.get $sw)))
    (if (i32.eqz (local.get $lb)) (then (return)))
    (local.set $popup (i32.load offset=24 (local.get $sw)))
    ;; Dropdown variants with a pre-allocated popup: migrate listbox under popup,
    ;; position popup at combo screen pos + (0, FIELD_H), show it.
    (if (i32.and
          (i32.ne (i32.load offset=36 (local.get $sw)) (i32.const 1))
          (i32.ne (local.get $popup) (i32.const 0)))
      (then
        (local.set $lb_wh (call $ctrl_get_wh_packed (local.get $lb)))
        (local.set $lb_w (i32.and (local.get $lb_wh) (i32.const 0xFFFF)))
        (local.set $lb_h (i32.shr_u (local.get $lb_wh) (i32.const 16)))
        ;; Reparent listbox under popup (WAT side + renderer side).
        (call $wnd_set_parent (local.get $lb) (local.get $popup))
        (call $host_set_parent (local.get $lb) (local.get $popup))
        ;; Listbox is now top-left of popup interior.
        (call $ctrl_geom_set (call $wnd_table_find (local.get $lb))
          (i32.const 0) (i32.const 0) (local.get $lb_w) (local.get $lb_h))
        ;; Position popup directly below combo's field area in screen coords.
        (local.set $rect (global.get $PAINT_SCRATCH))
        (call $host_get_window_rect (local.get $hwnd) (local.get $rect))
        (call $host_move_window (local.get $popup)
          (i32.load          (local.get $rect))           ;; left
          (i32.add (i32.load offset=4 (local.get $rect)) (i32.const 21)) ;; top + FIELD_H
          (local.get $lb_w) (local.get $lb_h)
          (i32.const 0x40))                               ;; SWP_SHOWWINDOW
        ;; host_move_window updates renderer geometry/visibility, while USER
        ;; effective-visibility checks read the WAT style. Keep both sides in
        ;; sync so the reparented listbox is eligible for WM_PAINT.
        (drop (call $wnd_set_style (local.get $popup)
          (i32.or (call $wnd_get_style (local.get $popup)) (i32.const 0x10000000))))))
    (local.set $style (call $wnd_get_style (local.get $lb)))
    (drop (call $wnd_set_style (local.get $lb) (i32.or (local.get $style) (i32.const 0x10000000))))
    (i32.store offset=32 (local.get $sw) (i32.const 1))
    (global.set $combo_open_hwnd (local.get $hwnd))
    ;; Capture: prefer the popup so DOWN+UP both flow through
    ;; $combo_popup_wndproc, which forwards inside-rect events to the inner
    ;; listbox. Without this, UP gets routed via capture to the combo and
    ;; misses the listbox entirely. Falls back to combo for variants without
    ;; a popup shell (CBS_SIMPLE).
    (if (local.get $popup)
      (then  (global.set $capture_hwnd (local.get $popup)))
      (else  (global.set $capture_hwnd (local.get $hwnd))))
    ;; CBN_DROPDOWN(7) → parent
    (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
    (if (local.get $parent)
      (then (drop (call $wnd_send_message (local.get $parent) (i32.const 0x0111)
              (i32.or (i32.and (i32.load offset=12 (local.get $sw)) (i32.const 0xFFFF))
                      (i32.shl (i32.const 7) (i32.const 16)))
              (local.get $hwnd)))))
    (call $invalidate_hwnd (local.get $hwnd))
    (call $invalidate_hwnd (local.get $lb)))

  ;; Helper: close the dropdown. $accept=1 fires CBN_SELENDOK; 0 → CBN_SELENDCANCEL.
  ;; Always fires CBN_CLOSEUP. Releases capture.
  (func $combobox_close_dropdown (param $hwnd i32) (param $accept i32)
    (local $state i32) (local $sw i32) (local $lb i32) (local $style i32)
    (local $parent i32) (local $ctrl_id i32) (local $notif i32)
    (local $popup i32) (local $lb_wh i32) (local $lb_w i32) (local $lb_h i32)
    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $state)) (then (return)))
    (local.set $sw (call $g2w (local.get $state)))
    (if (i32.eqz (i32.load offset=32 (local.get $sw))) (then (return)))  ;; not dropped
    (local.set $lb (i32.load offset=20 (local.get $sw)))
    (local.set $popup (i32.load offset=24 (local.get $sw)))
    ;; Dropdown variant with popup: reparent listbox back under combo, restore its
    ;; original geom (y=FIELD_H), and hide popup via SWP_HIDEWINDOW. Symmetric
    ;; with $combobox_open_dropdown.
    (if (i32.and
          (i32.ne (i32.load offset=36 (local.get $sw)) (i32.const 1))
          (i32.and (i32.ne (local.get $popup) (i32.const 0))
                   (i32.ne (local.get $lb) (i32.const 0))))
      (then
        (local.set $lb_wh (call $ctrl_get_wh_packed (local.get $lb)))
        (local.set $lb_w (i32.and (local.get $lb_wh) (i32.const 0xFFFF)))
        (local.set $lb_h (i32.shr_u (local.get $lb_wh) (i32.const 16)))
        (call $wnd_set_parent (local.get $lb) (local.get $hwnd))
        (call $host_set_parent (local.get $lb) (local.get $hwnd))
        (call $ctrl_geom_set (call $wnd_table_find (local.get $lb))
          (i32.const 0) (i32.const 21) (local.get $lb_w) (local.get $lb_h))
        (call $host_move_window (local.get $popup)
          (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)
          (i32.const 0x83))                               ;; SWP_NOMOVE|SWP_NOSIZE|SWP_HIDEWINDOW
        (drop (call $wnd_set_style (local.get $popup)
          (i32.and (call $wnd_get_style (local.get $popup)) (i32.const 0xEFFFFFFF))))))
    ;; Hide listbox (CBS_SIMPLE keeps it visible — variant=1 means "always open")
    (if (i32.ne (i32.load offset=36 (local.get $sw)) (i32.const 1))
      (then
        (if (local.get $lb)
          (then
            (local.set $style (call $wnd_get_style (local.get $lb)))
            (drop (call $wnd_set_style (local.get $lb)
                    (i32.and (local.get $style) (i32.const 0xEFFFFFFF))))))))
    (i32.store offset=32 (local.get $sw) (i32.const 0))
    (if (i32.eq (global.get $combo_open_hwnd) (local.get $hwnd))
      (then (global.set $combo_open_hwnd (i32.const 0))))
    (if (i32.or (i32.eq (global.get $capture_hwnd) (local.get $hwnd))
                (i32.and (i32.ne (local.get $popup) (i32.const 0))
                         (i32.eq (global.get $capture_hwnd) (local.get $popup))))
      (then (global.set $capture_hwnd (i32.const 0))))
    (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
    (local.set $ctrl_id (i32.and (i32.load offset=12 (local.get $sw)) (i32.const 0xFFFF)))
    (if (local.get $parent)
      (then
        ;; CBN_SELENDOK(9) or CBN_SELENDCANCEL(10) — POSTED, not sent.
        ;; Real Win32 sends these synchronously, but doing so here means
        ;; the row-pick click (which already runs nested under JS-driven
        ;; $wnd_send_message into our popup wndproc) recursively reenters
        ;; the dialog wndproc one frame deep. In pinball.exe specifically,
        ;; the dialog wndproc returns through a stack-pop sequence that
        ;; depends on x86 callee-save state established by its outer
        ;; PeekMessage caller — when reentered nested, the saved ESI on
        ;; the dialog's stack frame is the recursive-run scratch (0),
        ;; and after the wndproc's pop esi the outer pump calls esi=0
        ;; (EIP=0 freeze). Posting defers the notification to the next
        ;; PeekMessage iteration, where the dialog wndproc runs as a
        ;; first-class dispatch instead of nested-reentry.
        (local.set $notif (select (i32.const 9) (i32.const 10) (local.get $accept)))
        (drop (call $post_queue_push (local.get $parent) (i32.const 0x0111)
                (i32.or (local.get $ctrl_id) (i32.shl (local.get $notif) (i32.const 16)))
                (local.get $hwnd)))
        ;; CBN_CLOSEUP(8) — also posted for the same reason.
        (drop (call $post_queue_push (local.get $parent) (i32.const 0x0111)
                (i32.or (local.get $ctrl_id) (i32.shl (i32.const 8) (i32.const 16)))
                (local.get $hwnd)))))
    (call $invalidate_hwnd (local.get $hwnd))
    ;; The inner listbox was painted into the parent's back-canvas while
    ;; visible; hiding it via WS_VISIBLE removal stops future paints but
    ;; leaves stale dropdown pixels on the canvas. Repaint the parent
    ;; (dialog) AND every sibling so the gray background reappears under
    ;; the dropdown area and other controls (labels, buttons, other combos)
    ;; aren't left as gaps. The renderer doesn't cascade parent → children
    ;; on its own — child paint flags are tracked per-slot.
    (if (local.get $parent)
      (then
        (call $invalidate_hwnd (local.get $parent))
        (call $combobox_invalidate_siblings (local.get $parent) (local.get $hwnd)))))

  ;; Mark every direct child of $parent (including $hwnd, harmless) as
  ;; needing WM_PAINT, so closing a dropdown doesn't leave the dialog's
  ;; other controls unpainted after the parent's background re-erase.
  (func $combobox_invalidate_siblings (param $parent i32) (param $hwnd i32)
    (local $slot i32) (local $ch i32)
    (local.set $slot (i32.const 0))
    (block $done (loop $walk
      (local.set $slot (call $wnd_next_child_slot (local.get $parent) (local.get $slot)))
      (br_if $done (i32.eq (local.get $slot) (i32.const -1)))
      (local.set $ch (call $wnd_slot_hwnd (local.get $slot)))
      (if (local.get $ch)
        (then (call $paint_flag_set_inv (local.get $ch))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $walk))))

  ;; Helper: copy the inner listbox's selected item text into combobox text_buf.
  ;; Called after CB_SETCURSEL or LBN_SELCHANGE so WM_GETTEXT returns the right thing.
  ;; CBS_DROPDOWN has a real inner EDIT, which owns the visible field text, so
  ;; keep that child synchronized with the same selection as well.
  (func $combobox_sync_text (param $sw i32)
    (local $lb i32) (local $sel i32) (local $buf_g i32) (local $slen i32)
    (local.set $lb (i32.load offset=20 (local.get $sw)))
    (if (i32.eqz (local.get $lb)) (then (return)))
    (local.set $sel (call $wnd_send_message (local.get $lb) (i32.const 0x0188) (i32.const 0) (i32.const 0)))
    (i32.store offset=16 (local.get $sw) (local.get $sel))
    ;; Free old text_buf
    (call $heap_free (i32.load (local.get $sw)))
    (i32.store         (local.get $sw) (i32.const 0))
    (i32.store offset=4 (local.get $sw) (i32.const 0))
    (if (i32.lt_s (local.get $sel) (i32.const 0))
      (then
        (if (i32.and
              (i32.eq (i32.load offset=36 (local.get $sw)) (i32.const 2))
              (i32.ne (i32.load offset=28 (local.get $sw)) (i32.const 0)))
          (then (drop (call $wnd_send_message
            (i32.load offset=28 (local.get $sw))
            (i32.const 0x000C) (i32.const 0) (i32.const 0)))))
        (return)))
    ;; Get LB_GETTEXTLEN, alloc buf, LB_GETTEXT into it, store.
    (local.set $slen (call $wnd_send_message (local.get $lb) (i32.const 0x018A) (local.get $sel) (i32.const 0)))
    (if (i32.lt_s (local.get $slen) (i32.const 0)) (then (return)))
    (local.set $buf_g (call $heap_alloc (i32.add (local.get $slen) (i32.const 1))))
    (drop (call $wnd_send_message (local.get $lb) (i32.const 0x0189) (local.get $sel) (local.get $buf_g)))
    (i32.store         (local.get $sw) (local.get $buf_g))
    (i32.store offset=4 (local.get $sw) (local.get $slen))
    (if (i32.and
          (i32.eq (i32.load offset=36 (local.get $sw)) (i32.const 2))
          (i32.ne (i32.load offset=28 (local.get $sw)) (i32.const 0)))
      (then (drop (call $wnd_send_message
        (i32.load offset=28 (local.get $sw))
        (i32.const 0x000C) (i32.const 0) (local.get $buf_g))))))

  (func $combobox_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $state i32) (local $state_w i32) (local $cs_w i32)
    (local $hdc i32) (local $sz i32) (local $w i32) (local $h i32)
    (local $name_ptr i32) (local $text_len i32)
    (local $idx i32) (local $slen i32) (local $count i32)
    (local $arrow_x i32) (local $variant i32) (local $lb i32)
    (local $style i32) (local $cy i32) (local $cmd i32) (local $notif i32)
    (local $parent i32) (local $ctrl_id i32) (local $field_h i32)
    (local $px i32) (local $py i32)
    (local $scan_slot i32) (local $sibling_hwnd i32)
    (local $combo_max_x i32) (local $sibling_right i32)
    (local $paint_state_w i32)

    (local.set $field_h (i32.const 21))
    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))

    ;; ---------- WM_CREATE ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0001))
      (then
        (local.set $cs_w (call $g2w (local.get $lParam)))
        (local.set $name_ptr (i32.load offset=36 (local.get $cs_w)))
        (local.set $style (i32.load offset=32 (local.get $cs_w)))
        (local.set $variant (i32.and (local.get $style) (i32.const 0x3)))
        (if (i32.eqz (local.get $variant)) (then (local.set $variant (i32.const 3))))
        (local.set $state (call $heap_alloc (i32.const 40)))
        (local.set $state_w (call $g2w (local.get $state)))
        (i32.store          (local.get $state_w) (i32.const 0))      ;; text_buf_ptr
        (i32.store offset=4 (local.get $state_w) (i32.const 0))      ;; text_len
        (i32.store offset=8 (local.get $state_w) (local.get $style)) ;; style
        (i32.store offset=12 (local.get $state_w)
          (i32.and (i32.load offset=8 (local.get $cs_w)) (i32.const 0xFFFF))) ;; ctrl_id
        (i32.store offset=16 (local.get $state_w) (i32.const -1))   ;; cur_sel
        (i32.store offset=20 (local.get $state_w) (i32.const 0))    ;; lb_hwnd
        (i32.store offset=24 (local.get $state_w) (i32.const 0))    ;; popup_hwnd
        (i32.store offset=28 (local.get $state_w) (i32.const 0))    ;; edit_hwnd
        (i32.store offset=32 (local.get $state_w) (i32.const 0))    ;; is_dropped
        (i32.store offset=36 (local.get $state_w) (local.get $variant)) ;; variant
        (if (local.get $name_ptr)
          (then
            (local.set $text_len (call $strlen (call $g2w (local.get $name_ptr))))
            (i32.store          (local.get $state_w)
              (call $ctrl_text_dup (local.get $name_ptr) (local.get $text_len)))
            (i32.store offset=4 (local.get $state_w) (local.get $text_len))))
        (call $wnd_set_state_ptr (local.get $hwnd) (local.get $state))
        ;; Create inner listbox child filling the dropped area. Geometry from
        ;; CREATESTRUCT: cx at +20, cy at +16. Listbox is at (0, FIELD_H, cx, cy-FIELD_H).
        ;; CBS_SIMPLE keeps it always visible; others start hidden.
        (local.set $w (i32.load offset=20 (local.get $cs_w)))
        (local.set $cy (i32.load offset=16 (local.get $cs_w)))
        (local.set $h (i32.sub (local.get $cy) (local.get $field_h)))
        (if (i32.lt_s (local.get $h) (i32.const 32))
          (then (local.set $h (i32.const 64)))) ;; minimum sensible dropdown
        ;; Listbox style: WS_CHILD(0x40000000) | WS_VSCROLL(0x00200000) | WS_BORDER(0x00800000)
        ;; + WS_VISIBLE(0x10000000) only for CBS_SIMPLE.
        (local.set $style (i32.const 0x40A00000))
        (if (i32.eq (local.get $variant) (i32.const 1))
          (then (local.set $style (i32.or (local.get $style) (i32.const 0x10000000)))))
        (local.set $lb (call $ctrl_create_child (local.get $hwnd) (i32.const 4)
                          (i32.const 1000) ;; synthetic ctrl_id for inner listbox
                          (i32.const 0)
                          (select (i32.const 0) (local.get $field_h) (i32.eq (local.get $variant) (i32.const 1)))
                          (local.get $w)
                          (select (local.get $cy) (local.get $h) (i32.eq (local.get $variant) (i32.const 1)))
                          (local.get $style) (i32.const 0)))
        (i32.store offset=20 (local.get $state_w) (local.get $lb))
        ;; CBS_SIMPLE: always-dropped state.
        (if (i32.eq (local.get $variant) (i32.const 1))
          (then (i32.store offset=32 (local.get $state_w) (i32.const 1))))
        ;; CBS_DROPDOWN (variant=2): create EDIT child filling the field
        ;; area minus the arrow box (18px wide on right). Style: WS_CHILD |
        ;; WS_VISIBLE | ES_AUTOHSCROLL(0x80). Field width = w - 18 to leave
        ;; room for the arrow.
        (if (i32.eq (local.get $variant) (i32.const 2))
          (then
            (i32.store offset=28 (local.get $state_w)
              (call $ctrl_create_child (local.get $hwnd) (i32.const 2)
                (i32.const 1001) ;; synthetic ctrl_id for inner edit
                (i32.const 2) (i32.const 2)
                (i32.sub (local.get $w) (i32.const 20))
                (i32.sub (local.get $field_h) (i32.const 4))
                (i32.const 0x50000080)  ;; WS_CHILD|WS_VISIBLE|ES_AUTOHSCROLL
                (i32.load offset=36 (local.get $cs_w)))))) ;; pass initial title
        ;; Dropdown variants (2/3): pre-allocate a WS_POPUP shell sized to the
        ;; listbox area. Hidden until $combobox_open_dropdown shows it. The
        ;; listbox is still parented to the combo until then.
        (if (i32.ne (local.get $variant) (i32.const 1))
          (then
            (i32.store offset=24 (local.get $state_w)
              (call $combo_create_popup (local.get $hwnd) (local.get $w) (local.get $h)))))
        ;; MFC toolbar-hosted combo boxes are often created at (0,0) and then
        ;; left for common-control layout to position. Keep additional direct
        ;; COMBOBOX children of the same ToolbarWindow32 from covering the
        ;; first combo field when no explicit move has arrived yet.
        (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
        (if (i32.and
              (i32.and
                (i32.eq (call $ctrl_table_get_class (local.get $parent)) (i32.const 21))
                (i32.eq (call $ctrl_get_x_s (local.get $hwnd)) (i32.const 0)))
              (i32.eq (call $ctrl_get_y_s (local.get $hwnd)) (i32.const 0)))
          (then
            (local.set $scan_slot (i32.const 0))
            (local.set $combo_max_x (i32.const 0))
            (block $combo_scan_done (loop $combo_scan
              (local.set $scan_slot
                (call $wnd_next_child_slot (local.get $parent) (local.get $scan_slot)))
              (br_if $combo_scan_done (i32.lt_s (local.get $scan_slot) (i32.const 0)))
              (local.set $sibling_hwnd (call $wnd_slot_hwnd (local.get $scan_slot)))
              (if (i32.and
                    (i32.ne (local.get $sibling_hwnd) (local.get $hwnd))
                    (i32.eq (call $ctrl_table_get_class (local.get $sibling_hwnd)) (i32.const 5)))
                (then
                  (local.set $sibling_right
                    (i32.add
                      (i32.add
                        (call $ctrl_get_x_s (local.get $sibling_hwnd))
                        (i32.and
                          (call $ctrl_get_wh_packed (local.get $sibling_hwnd))
                          (i32.const 0xFFFF)))
                      (i32.const 4)))
                  (if (i32.gt_s (local.get $sibling_right) (local.get $combo_max_x))
                    (then (local.set $combo_max_x (local.get $sibling_right))))))
              (local.set $scan_slot (i32.add (local.get $scan_slot) (i32.const 1)))
              (br $combo_scan)))
            (if (i32.gt_s (local.get $combo_max_x) (i32.const 0))
              (then
                (call $host_move_window
                  (local.get $hwnd)
                  (local.get $combo_max_x)
                  (i32.const 0)
                  (local.get $w)
                  (local.get $cy)
                  (i32.const 0))
                (call $ctrl_geom_sync
                  (local.get $hwnd)
                  (local.get $combo_max_x)
                  (i32.const 0)
                  (local.get $w)
                  (local.get $field_h)
                  (i32.const 0))
                (call $defwndproc_do_nccalcsize (local.get $hwnd))))))
        (return (i32.const 0))))

    ;; ---------- WM_DESTROY ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0002))
      (then
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            ;; Inner listbox is destroyed by the parent's $wnd_destroy_tree pass.
            ;; Popup top-level is NOT a child (no parent walk reaches it) so
            ;; remove its window-table slot explicitly.
            (if (i32.load offset=24 (local.get $state_w))
              (then (call $wnd_table_remove (i32.load offset=24 (local.get $state_w)))))
            (call $heap_free (i32.load (local.get $state_w))) ;; text_buf
            (call $heap_free (local.get $state))
            (call $wnd_set_state_ptr (local.get $hwnd) (i32.const 0))))
        (if (i32.eq (global.get $combo_open_hwnd) (local.get $hwnd))
          (then (global.set $combo_open_hwnd (i32.const 0))))
        (return (i32.const 0))))

    (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
    (local.set $state_w (call $g2w (local.get $state)))
    (local.set $variant (i32.load offset=36 (local.get $state_w)))
    (local.set $lb      (i32.load offset=20 (local.get $state_w)))

    ;; ---------- WM_SETTEXT ----------
    ;; CBS_DROPDOWN (variant=2): forward to inner edit; the edit owns the text.
    (if (i32.eq (local.get $msg) (i32.const 0x000C))
      (then
        (if (i32.eq (local.get $variant) (i32.const 2))
          (then
            ;; WordPad converts RichEdit 2.0's empty-document 32767-twip
            ;; sentinel to literal point-size text "1638.5". Normalize that
            ;; exact value only in its toolbar size combo (control id 166).
            (if (i32.and
                  (i32.eq (i32.load offset=12 (local.get $state_w)) (i32.const 166))
                  (i32.and
                    (i32.eq (call $strlen (call $g2w (local.get $lParam))) (i32.const 6))
                    (i32.and
                      (i32.eq (i32.load (call $g2w (local.get $lParam))) (i32.const 0x38333631))
                      (i32.eq (i32.load16_u offset=4 (call $g2w (local.get $lParam))) (i32.const 0x352E)))))
              (then
                (local.set $name_ptr (call $heap_alloc (i32.const 3)))
                (i32.store16 (call $g2w (local.get $name_ptr)) (i32.const 0x3031))
                (i32.store8 offset=2 (call $g2w (local.get $name_ptr)) (i32.const 0))
                (local.set $idx (call $wnd_send_message
                  (i32.load offset=28 (local.get $state_w))
                  (i32.const 0x000C) (local.get $wParam) (local.get $name_ptr)))
                (call $heap_free (local.get $name_ptr))
                (return (local.get $idx))))
            (return (call $wnd_send_message
                      (i32.load offset=28 (local.get $state_w))
                      (i32.const 0x000C) (local.get $wParam) (local.get $lParam)))))
        (call $heap_free (i32.load (local.get $state_w)))
        (i32.store          (local.get $state_w) (i32.const 0))
        (i32.store offset=4 (local.get $state_w) (i32.const 0))
        (if (local.get $lParam)
          (then
            (local.set $text_len (call $strlen (call $g2w (local.get $lParam))))
            (i32.store (local.get $state_w)
              (call $ctrl_text_dup (local.get $lParam) (local.get $text_len)))
            (i32.store offset=4 (local.get $state_w) (local.get $text_len))))
        (call $invalidate_hwnd (local.get $hwnd))
        (if (call $wnd_is_effectively_visible (local.get $hwnd))
          (then
            (drop (call $edit_wndproc
              (local.get $hwnd) (i32.const 0x000F)
              (i32.const 0) (i32.const 0)))
            (call $update_clear_hwnd (local.get $hwnd))
            (call $paint_flag_clear_hwnd (local.get $hwnd))))
        (return (i32.const 1))))

    ;; ---------- WM_GETTEXT ----------
    (if (i32.eq (local.get $msg) (i32.const 0x000D))
      (then
        (if (i32.eq (local.get $variant) (i32.const 2))
          (then (return (call $wnd_send_message
                          (i32.load offset=28 (local.get $state_w))
                          (i32.const 0x000D) (local.get $wParam) (local.get $lParam)))))
        (if (i32.eqz (local.get $wParam)) (then (return (i32.const 0))))
        (local.set $text_len (i32.load offset=4 (local.get $state_w)))
        (if (i32.ge_u (local.get $text_len) (local.get $wParam))
          (then (local.set $text_len (i32.sub (local.get $wParam) (i32.const 1)))))
        (if (i32.load (local.get $state_w))
          (then (if (local.get $text_len)
                  (then (call $memcpy (call $g2w (local.get $lParam))
                                      (call $g2w (i32.load (local.get $state_w)))
                                      (local.get $text_len))))))
        (i32.store8 (i32.add (call $g2w (local.get $lParam)) (local.get $text_len)) (i32.const 0))
        (return (local.get $text_len))))

    ;; ---------- WM_GETTEXTLENGTH ----------
    (if (i32.eq (local.get $msg) (i32.const 0x000E))
      (then
        (if (i32.eq (local.get $variant) (i32.const 2))
          (then (return (call $wnd_send_message
                          (i32.load offset=28 (local.get $state_w))
                          (i32.const 0x000E) (i32.const 0) (i32.const 0)))))
        (return (i32.load offset=4 (local.get $state_w)))))

    ;; ---------- WM_SETFOCUS (0x0007) — fire CBN_SETFOCUS(3) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0007))
      (then
        (global.set $focus_hwnd (local.get $hwnd))
        (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
        (if (local.get $parent)
          (then (drop (call $wnd_send_message (local.get $parent) (i32.const 0x0111)
                  (i32.or (i32.and (i32.load offset=12 (local.get $state_w)) (i32.const 0xFFFF))
                          (i32.shl (i32.const 3) (i32.const 16)))
                  (local.get $hwnd)))))
        (return (i32.const 0))))

    ;; ---------- WM_KILLFOCUS (0x0008) — close dropdown + fire CBN_KILLFOCUS(4) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0008))
      (then
        (if (i32.load offset=32 (local.get $state_w))
          (then (call $combobox_close_dropdown (local.get $hwnd) (i32.const 0))))
        (if (i32.eq (global.get $focus_hwnd) (local.get $hwnd))
          (then (global.set $focus_hwnd (i32.const 0))))
        (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
        (if (local.get $parent)
          (then (drop (call $wnd_send_message (local.get $parent) (i32.const 0x0111)
                  (i32.or (i32.and (i32.load offset=12 (local.get $state_w)) (i32.const 0xFFFF))
                          (i32.shl (i32.const 4) (i32.const 16)))
                  (local.get $hwnd)))))
        (return (i32.const 0))))

    ;; ---------- CB_RESETCONTENT (0x014B) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x014B))
      (then
        (if (local.get $lb)
          (then (drop (call $wnd_send_message (local.get $lb) (i32.const 0x0184) (i32.const 0) (i32.const 0)))))
        (i32.store offset=16 (local.get $state_w) (i32.const -1))
        (call $heap_free (i32.load (local.get $state_w)))
        (i32.store          (local.get $state_w) (i32.const 0))
        (i32.store offset=4 (local.get $state_w) (i32.const 0))
        (if (i32.and
              (i32.eq (local.get $variant) (i32.const 2))
              (i32.ne (i32.load offset=28 (local.get $state_w)) (i32.const 0)))
          (then (drop (call $wnd_send_message
            (i32.load offset=28 (local.get $state_w))
            (i32.const 0x000C) (i32.const 0) (i32.const 0)))))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 0))))

    ;; ---------- CB_GETCOUNT (0x0146) — forward to listbox LB_GETCOUNT (0x018B) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0146))
      (then (return (call $wnd_send_message (local.get $lb) (i32.const 0x018B) (i32.const 0) (i32.const 0)))))

    ;; ---------- CB_GETCURSEL (0x0147) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0147))
      (then (return (i32.load offset=16 (local.get $state_w)))))

    ;; ---------- CB_ADDSTRING (0x0143) → LB_ADDSTRING (0x0180) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0143))
      (then (return (call $wnd_send_message (local.get $lb) (i32.const 0x0180) (i32.const 0) (local.get $lParam)))))

    ;; ---------- CB_INSERTSTRING (0x014A) → LB_INSERTSTRING (0x0181) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x014A))
      (then (return (call $wnd_send_message (local.get $lb) (i32.const 0x0181) (local.get $wParam) (local.get $lParam)))))

    ;; ---------- CB_DELETESTRING (0x0144) → LB_DELETESTRING (0x0182) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0144))
      (then (return (call $wnd_send_message (local.get $lb) (i32.const 0x0182) (local.get $wParam) (i32.const 0)))))

    ;; ---------- CB_FINDSTRING (0x014C) / CB_FINDSTRINGEXACT (0x0158) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x014C))
      (then (return (call $wnd_send_message (local.get $lb) (i32.const 0x018F) (local.get $wParam) (local.get $lParam)))))
    (if (i32.eq (local.get $msg) (i32.const 0x0158))
      (then (return (call $wnd_send_message (local.get $lb) (i32.const 0x01A2) (local.get $wParam) (local.get $lParam)))))

    ;; ---------- CB_SELECTSTRING (0x014D) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x014D))
      (then
        (local.set $idx (call $wnd_send_message (local.get $lb) (i32.const 0x018C) (local.get $wParam) (local.get $lParam)))
        (if (i32.ge_s (local.get $idx) (i32.const 0))
          (then (call $combobox_sync_text (local.get $state_w))
                (call $invalidate_hwnd (local.get $hwnd))))
        (return (local.get $idx))))

    ;; ---------- CB_GETLBTEXT (0x0148) → LB_GETTEXT (0x0189) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0148))
      (then (return (call $wnd_send_message (local.get $lb) (i32.const 0x0189) (local.get $wParam) (local.get $lParam)))))

    ;; ---------- CB_GETLBTEXTLEN (0x0149) → LB_GETTEXTLEN (0x018A) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0149))
      (then (return (call $wnd_send_message (local.get $lb) (i32.const 0x018A) (local.get $wParam) (i32.const 0)))))

    ;; ---------- CB_SETCURSEL (0x014E) → LB_SETCURSEL + sync text ----------
    (if (i32.eq (local.get $msg) (i32.const 0x014E))
      (then
        (drop (call $wnd_send_message (local.get $lb) (i32.const 0x0186) (local.get $wParam) (i32.const 0)))
        (call $combobox_sync_text (local.get $state_w))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (local.get $wParam))))

    ;; ---------- CB_GETDROPPEDSTATE (0x0157) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0157))
      (then (return (i32.load offset=32 (local.get $state_w)))))

    ;; ---------- CB_SHOWDROPDOWN (0x014F) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x014F))
      (then
        (if (local.get $wParam)
          (then (call $combobox_open_dropdown (local.get $hwnd)))
          (else (call $combobox_close_dropdown (local.get $hwnd) (i32.const 0))))
        (return (i32.const 1))))

    ;; ---------- CB_GETDROPPEDCONTROLRECT (0x0152) ----------
    ;; lParam = guest RECT* (filled with screen coords of dropped popup area).
    ;; Our dropdown is in-rect: report the listbox's rect translated to screen coords.
    ;; For simplicity, compute (0, FIELD_H, w, full_h) in window-local coords; caller
    ;; can translate via ClientToScreen. (Real Win32 returns screen coords; many apps
    ;; only check w/h though.)
    (if (i32.eq (local.get $msg) (i32.const 0x0152))
      (then
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        (i32.store          (call $g2w (local.get $lParam)) (i32.const 0))
        (i32.store offset=4 (call $g2w (local.get $lParam)) (local.get $field_h))
        (i32.store offset=8 (call $g2w (local.get $lParam)) (local.get $w))
        (i32.store offset=12 (call $g2w (local.get $lParam)) (local.get $h))
        (return (i32.const 1))))

    ;; ---------- CB_LIMITTEXT (0x0141) → EM_SETLIMITTEXT (0x00C5) ----------
    ;; Only meaningful for CBS_DROPDOWN; CBS_DROPDOWNLIST/SIMPLE return TRUE no-op.
    (if (i32.eq (local.get $msg) (i32.const 0x0141))
      (then
        (if (i32.eq (local.get $variant) (i32.const 2))
          (then (drop (call $wnd_send_message
                        (i32.load offset=28 (local.get $state_w))
                        (i32.const 0x00C5) (local.get $wParam) (i32.const 0)))))
        (return (i32.const 1))))

    ;; ---------- CB_GETEDITSEL (0x0140) → EM_GETSEL (0x00B0) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0140))
      (then
        (if (i32.eq (local.get $variant) (i32.const 2))
          (then (return (call $wnd_send_message
                          (i32.load offset=28 (local.get $state_w))
                          (i32.const 0x00B0) (local.get $wParam) (local.get $lParam)))))
        (return (i32.const 0))))

    ;; ---------- CB_SETEDITSEL (0x0142) → EM_SETSEL (0x00B1) ----------
    ;; Win32: lParam packs (start | end<<16); EM_SETSEL takes wParam=start, lParam=end.
    (if (i32.eq (local.get $msg) (i32.const 0x0142))
      (then
        (if (i32.eq (local.get $variant) (i32.const 2))
          (then (return (call $wnd_send_message
                          (i32.load offset=28 (local.get $state_w))
                          (i32.const 0x00B1)
                          (i32.and (local.get $lParam) (i32.const 0xFFFF))
                          (i32.shr_u (local.get $lParam) (i32.const 16))))))
        (return (i32.const 0))))

    ;; ---------- CB_SETEXTENDEDUI / CB_GETEXTENDEDUI ----------
    ;; Stash in a high bit of state+8 (style word). We use bit 31 as a flag.
    (if (i32.eq (local.get $msg) (i32.const 0x0155))
      (then
        (i32.store offset=8 (local.get $state_w)
          (select (i32.or  (i32.load offset=8 (local.get $state_w)) (i32.const 0x80000000))
                  (i32.and (i32.load offset=8 (local.get $state_w)) (i32.const 0x7FFFFFFF))
                  (local.get $wParam)))
        (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0156))
      (then (return (i32.shr_u (i32.and (i32.load offset=8 (local.get $state_w)) (i32.const 0x80000000)) (i32.const 31)))))

    ;; ---------- CB_GETITEMDATA (0x0150) → LB_GETITEMDATA (0x0199) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0150))
      (then (return (call $wnd_send_message (local.get $lb) (i32.const 0x0199) (local.get $wParam) (i32.const 0)))))
    ;; ---------- CB_SETITEMDATA (0x0151) → LB_SETITEMDATA (0x019A) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0151))
      (then (return (call $wnd_send_message (local.get $lb) (i32.const 0x019A) (local.get $wParam) (local.get $lParam)))))

    ;; ---------- CB_SETITEMHEIGHT / CB_GETITEMHEIGHT ----------
    ;; WordPad's MFC toolbar combo setup adjusts the editable field/item
    ;; height once the CComboBox wrapper is attached. We keep a fixed Win98-ish
    ;; field height for now, but report success/height so setup can continue.
    (if (i32.eq (local.get $msg) (i32.const 0x0153))
      (then (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0154))
      (then
        (return
          (select
            (local.get $field_h)
            (i32.const 16)
            (i32.eq (local.get $wParam) (i32.const -1))))))

    ;; ---------- CB_DIR / ownerdraw paths ----------
    ;; Fail-fast (memory: feedback_fail_fast_stubs).
    (if (i32.eq (local.get $msg) (i32.const 0x0145))   ;; CB_DIR
      (then (call $crash_unimplemented (i32.const 0x100))))

    ;; ---------- WM_LBUTTONDOWN (0x0201) — toggle dropdown ----------
    ;; While dropped with capture, lParam is in our window-local coords. We
    ;; only swallow clicks on the field; clicks below FIELD_H land on the
    ;; child listbox via z-order routing (or, when dropped with capture,
    ;; we route them to the listbox manually).
    (if (i32.eq (local.get $msg) (i32.const 0x0201))
      (then
        (local.set $px (i32.shr_s (i32.shl (local.get $lParam) (i32.const 16)) (i32.const 16)))
        (local.set $py (i32.shr_s (local.get $lParam) (i32.const 16)))
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        ;; If dropped, click below field area → forward to listbox in lb-local coords.
        (if (i32.load offset=32 (local.get $state_w))
          (then
            (if (i32.ge_s (local.get $py) (local.get $field_h))
              (then
                (if (i32.and
                      (i32.ge_s (local.get $px) (i32.const 0))
                      (i32.lt_s (local.get $px) (local.get $w)))
                  (then
                    (drop (call $wnd_send_message (local.get $lb) (i32.const 0x0201)
                            (local.get $wParam)
                            (i32.or (i32.and (local.get $px) (i32.const 0xFFFF))
                                    (i32.shl (i32.sub (local.get $py) (local.get $field_h)) (i32.const 16)))))
                    ;; Real Windows: clicking an item in the dropdown selects it
                    ;; AND closes the dropdown (accept). The listbox already
                    ;; updated cur_sel and fired LBN_SELCHANGE; close as accept.
                    ;; CBS_SIMPLE (variant=1) keeps its always-visible listbox
                    ;; embedded — close_dropdown is a no-op for it.
                    (if (i32.ne (local.get $variant) (i32.const 1))
                      (then (call $combobox_close_dropdown (local.get $hwnd) (i32.const 1))))
                    (return (i32.const 0)))
                  (else
                    ;; Click outside field, outside listbox → cancel-close.
                    (call $combobox_close_dropdown (local.get $hwnd) (i32.const 0))
                    (return (i32.const 0)))))))
          (else
            ;; Not dropped: any click on the field opens the dropdown (CBS_DROPDOWNLIST/
            ;; CBS_DROPDOWN). CBS_SIMPLE has no toggle behavior.
            (if (i32.ne (local.get $variant) (i32.const 1))
              (then
                (call $combobox_open_dropdown (local.get $hwnd))
                (return (i32.const 0))))))
        ;; Toggle when click hits field area while already dropped (closes via outside-test
        ;; above; but if click is INSIDE field, toggle close as cancel).
        (if (i32.load offset=32 (local.get $state_w))
          (then (call $combobox_close_dropdown (local.get $hwnd) (i32.const 0))))
        (return (i32.const 0))))

    ;; ---------- WM_LBUTTONUP — when dropped with capture, route to listbox ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0202))
      (then
        (if (i32.load offset=32 (local.get $state_w))
          (then
            (local.set $py (i32.shr_s (local.get $lParam) (i32.const 16)))
            (if (i32.ge_s (local.get $py) (local.get $field_h))
              (then
                (local.set $px (i32.shr_s (i32.shl (local.get $lParam) (i32.const 16)) (i32.const 16)))
                (drop (call $wnd_send_message (local.get $lb) (i32.const 0x0202)
                        (local.get $wParam)
                        (i32.or (i32.and (local.get $px) (i32.const 0xFFFF))
                                (i32.shl (i32.sub (local.get $py) (local.get $field_h)) (i32.const 16)))))))))
        (return (i32.const 0))))

    ;; ---------- WM_KEYDOWN (0x0100) ----------
    ;; F4 (0x73) or Alt+Down (we approximate by VK_F4 since we don't have
    ;; modifier key state cleanly here): toggle dropdown.
    ;; Esc (0x1B): cancel-close. Enter (0x0D): accept-close (if dropped).
    ;; Arrow/PgUp/PgDn/Home/End: forward to listbox (which fires LBN_SELCHANGE
    ;; back to us via WM_COMMAND, where we'll sync_text + relay CBN_SELCHANGE).
    (if (i32.eq (local.get $msg) (i32.const 0x0100))
      (then
        (if (i32.eq (local.get $wParam) (i32.const 0x73))  ;; VK_F4
          (then
            (if (i32.load offset=32 (local.get $state_w))
              (then (call $combobox_close_dropdown (local.get $hwnd) (i32.const 1)))
              (else (call $combobox_open_dropdown  (local.get $hwnd))))
            (return (i32.const 0))))
        (if (i32.eq (local.get $wParam) (i32.const 0x1B))  ;; VK_ESCAPE
          (then
            (if (i32.load offset=32 (local.get $state_w))
              (then (call $combobox_close_dropdown (local.get $hwnd) (i32.const 0))))
            (return (i32.const 0))))
        ;; VK_TAB: dismiss dropdown (cancel) so focus-change leaves no stranded
        ;; popup. Real dialog tabstop navigation isn't wired up here, but at
        ;; least the dropdown shouldn't linger.
        (if (i32.eq (local.get $wParam) (i32.const 0x09))  ;; VK_TAB
          (then
            (if (i32.load offset=32 (local.get $state_w))
              (then (call $combobox_close_dropdown (local.get $hwnd) (i32.const 0))))))
        (if (i32.eq (local.get $wParam) (i32.const 0x0D))  ;; VK_RETURN
          (then
            (if (i32.load offset=32 (local.get $state_w))
              (then (call $combobox_close_dropdown (local.get $hwnd) (i32.const 1))))
            (return (i32.const 0))))
        ;; Navigation keys → forward to listbox.
        (if (i32.or
              (i32.or (i32.eq (local.get $wParam) (i32.const 0x28))   ;; VK_DOWN
                      (i32.eq (local.get $wParam) (i32.const 0x26)))  ;; VK_UP
              (i32.or
                (i32.or (i32.eq (local.get $wParam) (i32.const 0x24))  ;; VK_HOME
                        (i32.eq (local.get $wParam) (i32.const 0x23))) ;; VK_END
                (i32.or (i32.eq (local.get $wParam) (i32.const 0x21))  ;; VK_PRIOR
                        (i32.eq (local.get $wParam) (i32.const 0x22))))) ;; VK_NEXT
          (then
            ;; Suppress click-driven close: keyboard nav fires LBN_SELCHANGE
            ;; via the listbox synchronously, but we don't want that to close
            ;; the dropdown.
            (global.set $combo_kbd_nav_active (i32.const 1))
            (drop (call $wnd_send_message (local.get $lb) (i32.const 0x0100)
                    (local.get $wParam) (local.get $lParam)))
            (global.set $combo_kbd_nav_active (i32.const 0))
            (return (i32.const 0))))
        (return (i32.const 0))))

    ;; ---------- WM_COMMAND (0x0111) from inner listbox or edit ----------
    ;; Listbox: LBN_SELCHANGE/LBN_DBLCLK → sync_text + relay CBN_SELCHANGE.
    ;; Edit (variant=2 only): EN_CHANGE(0x0300) → CBN_EDITCHANGE(5);
    ;;                        EN_UPDATE(0x0400) → CBN_EDITUPDATE(6).
    (if (i32.eq (local.get $msg) (i32.const 0x0111))
      (then
        ;; Edit notification path
        (if (i32.and (i32.eq (local.get $variant) (i32.const 2))
                     (i32.eq (local.get $lParam)
                             (i32.load offset=28 (local.get $state_w))))
          (then
            (local.set $notif (i32.shr_u (local.get $wParam) (i32.const 16)))
            (local.set $cmd (i32.const 0))  ;; CBN_* code
            (if (i32.eq (local.get $notif) (i32.const 0x0300))  ;; EN_CHANGE
              (then (local.set $cmd (i32.const 5))))           ;; CBN_EDITCHANGE
            (if (i32.eq (local.get $notif) (i32.const 0x0400))  ;; EN_UPDATE
              (then (local.set $cmd (i32.const 6))))           ;; CBN_EDITUPDATE
            (if (local.get $cmd)
              (then
                (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
                (local.set $ctrl_id (i32.and (i32.load offset=12 (local.get $state_w)) (i32.const 0xFFFF)))
                (if (local.get $parent)
                  (then (drop (call $wnd_send_message (local.get $parent) (i32.const 0x0111)
                          (i32.or (local.get $ctrl_id) (i32.shl (local.get $cmd) (i32.const 16)))
                          (local.get $hwnd)))))))
            (return (i32.const 0))))
        (if (i32.eq (local.get $lParam) (local.get $lb))
          (then
            (local.set $notif (i32.shr_u (local.get $wParam) (i32.const 16)))
            ;; LBN_SELCHANGE(1) or LBN_DBLCLK(2) → sync text + relay CBN_SELCHANGE
            (if (i32.or (i32.eq (local.get $notif) (i32.const 1))
                        (i32.eq (local.get $notif) (i32.const 2)))
              (then
                (call $combobox_sync_text (local.get $state_w))
                (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
                (local.set $ctrl_id (i32.and (i32.load offset=12 (local.get $state_w)) (i32.const 0xFFFF)))
                ;; CBN_SELCHANGE(1) → parent dialog. POSTED for the same
                ;; reentrancy reason as CBN_SELENDOK below (close_dropdown).
                (if (local.get $parent)
                  (then (drop (call $post_queue_push (local.get $parent) (i32.const 0x0111)
                          (i32.or (local.get $ctrl_id) (i32.shl (i32.const 1) (i32.const 16)))
                          (local.get $hwnd)))))
                (call $invalidate_hwnd (local.get $hwnd))
                ;; Click-driven LBN_SELCHANGE/LBN_DBLCLK while dropped →
                ;; accept-close. Keyboard nav suppresses this via
                ;; $combo_kbd_nav_active so VK_DOWN/UP can scroll the listbox
                ;; without dismissing the dropdown. CBS_SIMPLE (variant=1)
                ;; has no dropdown to close.
                (if (i32.and
                      (i32.ne (i32.load offset=32 (local.get $state_w)) (i32.const 0))
                      (i32.eqz (global.get $combo_kbd_nav_active)))
                  (then
                    (if (i32.ne (local.get $variant) (i32.const 1))
                      (then (call $combobox_close_dropdown (local.get $hwnd) (i32.const 1))))))
                (return (i32.const 0))))))
        (return (i32.const 0))))

    ;; ---------- WM_PAINT ----------
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (local.get $field_h))
        ;; Skip field paint for CBS_SIMPLE — entire window is the listbox.
        (if (i32.ne (local.get $variant) (i32.const 1))
          (then
            ;; Toolbar-hosted CBS_DROPDOWN inner EDIT children are not
            ;; independently composited, so paint the field here for both
            ;; editable and read-only dropdown variants.
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.const 0) (i32.const 0)
                    (local.get $w) (local.get $h)
                    (i32.const 0x30010)))  ;; WHITE_BRUSH
            (drop (call $host_gdi_draw_edge (local.get $hdc)
                    (i32.const 0) (i32.const 0)
                    (local.get $w) (local.get $h)
                    (i32.const 0x0A) (i32.const 0x0F)))  ;; EDGE_SUNKEN | BF_RECT
            (local.set $arrow_x (i32.sub (local.get $w) (i32.const 18)))
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (local.get $arrow_x) (i32.const 2)
                    (i32.sub (local.get $w) (i32.const 2))
                    (i32.sub (local.get $h) (i32.const 2))
                    (i32.const 0x30011)))  ;; LTGRAY_BRUSH
            ;; Arrow box edge: pressed (sunken) when dropped, raised when closed.
            (drop (call $host_gdi_draw_edge (local.get $hdc)
                    (local.get $arrow_x) (i32.const 2)
                    (i32.sub (local.get $w) (i32.const 2))
                    (i32.sub (local.get $h) (i32.const 2))
                    (select (i32.const 0x0A) (i32.const 0x05) (i32.load offset=32 (local.get $state_w)))
                    (i32.const 0x0F)))
            ;; Triangle ▼
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.add (local.get $arrow_x) (i32.const 4)) (i32.const 9)
                    (i32.add (local.get $arrow_x) (i32.const 11)) (i32.const 10)
                    (i32.const 0x30014)))
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.add (local.get $arrow_x) (i32.const 5)) (i32.const 10)
                    (i32.add (local.get $arrow_x) (i32.const 10)) (i32.const 11)
                    (i32.const 0x30014)))
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.add (local.get $arrow_x) (i32.const 6)) (i32.const 11)
                    (i32.add (local.get $arrow_x) (i32.const 9)) (i32.const 12)
                    (i32.const 0x30014)))
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.add (local.get $arrow_x) (i32.const 7)) (i32.const 12)
                    (i32.add (local.get $arrow_x) (i32.const 8)) (i32.const 13)
                    (i32.const 0x30014)))
            (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))
            (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))
            ;; CBS_DROPDOWN delegates text ownership to its inner EDIT. Paint
            ;; from that same state so WM_PAINT agrees with WM_GETTEXT.
            (local.set $paint_state_w (local.get $state_w))
            (if (i32.eq (local.get $variant) (i32.const 2))
              (then
                (local.set $paint_state_w
                  (call $wnd_get_state_ptr (i32.load offset=28 (local.get $state_w))))
                (if (local.get $paint_state_w)
                  (then (local.set $paint_state_w (call $g2w (local.get $paint_state_w)))))))
            (if (i32.and
                  (i32.ne (local.get $paint_state_w) (i32.const 0))
                  (i32.ne (i32.load (local.get $paint_state_w)) (i32.const 0)))
              (then
                (i32.store          (global.get $PAINT_SCRATCH) (i32.const 4))
                (i32.store offset=4 (global.get $PAINT_SCRATCH) (i32.const 2))
                (i32.store offset=8 (global.get $PAINT_SCRATCH)
                  (i32.sub (local.get $arrow_x) (i32.const 2)))
                (i32.store offset=12 (global.get $PAINT_SCRATCH)
                  (i32.sub (local.get $h) (i32.const 2)))
                (drop (call $host_gdi_draw_text (local.get $hdc)
                        (call $g2w (i32.load (local.get $paint_state_w)))
                        (i32.load offset=4 (local.get $paint_state_w))
                        (global.get $PAINT_SCRATCH)
                        (i32.const 0x24) (i32.const 0)))))))
        (return (i32.const 0))))

    ;; Default
    (i32.const 0)
  )

  ;; ============================================================
  ;; Edit WndProc
  ;; ============================================================
  ;; Status: STEP 4 — dormant. No path delivers WM_CREATE to an EDIT
  ;; class hwnd today; the new code is unreachable until STEP 5 wires
  ;; WAT-side dialog creation through $create_findreplace_dialog.
  ;;
  ;; EditState (32 bytes, allocated in WM_CREATE)
  ;;   +0   text_buf_ptr   guest ptr (NUL-terminated)
  ;;   +4   text_len       chars (excluding NUL)
  ;;   +8   text_cap       allocated capacity (excluding NUL slot)
  ;;   +12  cursor         char position
  ;;   +16  sel_anchor     selection anchor (== cursor → no selection)
  ;;   +20  scroll_top     reserved for multi-line (0 in single-line)
  ;;   +24  flags          bit0=multiline bit1=password bit2=readonly bit3=focused
  ;;                       bit4=dragging selection bit5=caret visible
  ;;   +28  max_length     0 = unlimited

  ;; Keep the caret inside the viewport, which is what USER's EM_SCROLLCARET
  ;; does and what every EDIT operation that moves the caret ends with. Without
  ;; it, typing past the last visible line keeps editing text nobody can see:
  ;; the buffer grows, the caret advances, and the window still shows line 1.
  ;; Returns 1 when the viewport moved, so callers can tell a scroll from a
  ;; plain edit if they ever need to.
  (func $edit_scroll_caret_into_view (param $hwnd i32) (result i32)
    (local $state i32) (local $state_w i32) (local $style i32)
    (local $sz i32) (local $w i32) (local $h i32)
    (local $visible i32) (local $line i32) (local $top i32)
    (local $total i32) (local $max i32)
    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
    (local.set $state_w (call $g2w (local.get $state)))
    (local.set $style (call $wnd_get_style (local.get $hwnd)))
    ;; ES_MULTILINE only: a single-line edit scrolls horizontally, and that is
    ;; handled by the painter's own left-clamp.
    (if (i32.eqz (i32.and (local.get $style) (i32.const 0x00000004)))
      (then (return (i32.const 0))))
    (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
    (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
    (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
    (if (i32.and (local.get $style) (i32.const 0x00200000)) ;; WS_VSCROLL
      (then
        (if (i32.gt_u (local.get $w) (i32.const 16))
          (then (local.set $w (i32.sub (local.get $w) (i32.const 16)))))))
    (if (i32.and (local.get $style) (i32.const 0x00100000)) ;; WS_HSCROLL
      (then
        (if (i32.gt_u (local.get $h) (i32.const 16))
          (then (local.set $h (i32.sub (local.get $h) (i32.const 16)))))))
    ;; Same viewport arithmetic the wheel handler and the painter use.
    (local.set $visible (i32.div_u (i32.sub (local.get $h) (i32.const 8)) (i32.const 16)))
    (if (i32.eqz (local.get $visible)) (then (local.set $visible (i32.const 1))))
    (if (i32.and
          (i32.ne (i32.and (local.get $style) (i32.const 0x00200000)) (i32.const 0))
          (i32.eqz (i32.and (local.get $style) (i32.const 0x00000080)))) ;; not ES_AUTOHSCROLL
      (then
        ;; Wrapped: visual lines, so a wrapped paragraph counts for each row.
        (local.set $total (call $edit_layout_build (local.get $state_w)
          (i32.add (local.get $hwnd) (i32.const 0x40000)) (local.get $w)))
        (local.set $line (call $edit_layout_line_for_char (local.get $total)
          (i32.load offset=12 (local.get $state_w)))))
      (else
        (local.set $total (i32.add
          (call $edit_line_from_char (local.get $state_w)
            (i32.load offset=4 (local.get $state_w)))
          (i32.const 1)))
        (local.set $line (call $edit_line_from_char (local.get $state_w)
          (i32.load offset=12 (local.get $state_w))))))
    (local.set $top (i32.load offset=20 (local.get $state_w)))
    (if (i32.lt_s (local.get $line) (local.get $top))
      (then (local.set $top (local.get $line))))
    (if (i32.ge_s (local.get $line) (i32.add (local.get $top) (local.get $visible)))
      (then (local.set $top (i32.add (i32.sub (local.get $line) (local.get $visible))
                                     (i32.const 1)))))
    (local.set $max (i32.sub (local.get $total) (local.get $visible)))
    (if (i32.lt_s (local.get $max) (i32.const 0)) (then (local.set $max (i32.const 0))))
    (if (i32.gt_s (local.get $top) (local.get $max)) (then (local.set $top (local.get $max))))
    (if (i32.lt_s (local.get $top) (i32.const 0)) (then (local.set $top (i32.const 0))))
    (call $edit_publish_scroll_info (local.get $hwnd)
      (local.get $top) (local.get $total) (local.get $visible))
    (if (i32.eq (local.get $top) (i32.load offset=20 (local.get $state_w)))
      (then (return (i32.const 0))))
    (i32.store offset=20 (local.get $state_w) (local.get $top))
    (i32.const 1))

  ;; Publish the viewport into the window's scrollbar state, which is what an
  ;; EDIT does with SetScrollInfo after every change. $defwndproc_ncpaint
  ;; paints the strip straight out of SCROLL_TABLE, so without this the thumb
  ;; sits at the top of the track no matter where the text is scrolled to --
  ;; and a click on that stale thumb gets classified as a page, not a drag.
  (func $edit_publish_scroll_info (param $hwnd i32)
        (param $pos i32) (param $total i32) (param $visible i32)
    (local $slot i32) (local $base i32) (local $aux i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.lt_s (local.get $slot) (i32.const 0)) (then (return)))
    (local.set $base (call $scroll_record_addr (local.get $slot)))
    (local.set $aux (call $scroll_aux_addr (local.get $slot)))
    (if (i32.lt_s (local.get $total) (i32.const 1)) (then (local.set $total (i32.const 1))))
    (if (i32.lt_s (local.get $visible) (i32.const 1)) (then (local.set $visible (i32.const 1))))
    (i32.store offset=12 (local.get $base) (local.get $pos))
    (i32.store offset=16 (local.get $base) (i32.const 0))
    (i32.store offset=20 (local.get $base) (i32.sub (local.get $total) (i32.const 1)))
    (i32.store offset=8 (local.get $aux) (local.get $visible)))

  ;; Total lines and visible rows for a multiline edit, packed visible<<16 |
  ;; total. The wheel handler, the scrollbar click, the thumb drag and the
  ;; painter each computed this inline, and any drift between the four showed
  ;; up as a scrollbar that scrolled somewhere the text was not. It runs per
  ;; input event, not per pixel, so sharing it costs nothing measurable.
  (func $edit_view_metrics (param $hwnd i32) (param $state_w i32) (result i32)
    (local $style i32) (local $sz i32) (local $w i32) (local $h i32)
    (local $total i32) (local $visible i32)
    (local.set $style (call $wnd_get_style (local.get $hwnd)))
    (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
    (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
    (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
    (if (i32.and (local.get $style) (i32.const 0x00200000)) ;; WS_VSCROLL
      (then
        (if (i32.gt_u (local.get $w) (i32.const 16))
          (then (local.set $w (i32.sub (local.get $w) (i32.const 16)))))))
    (if (i32.and (local.get $style) (i32.const 0x00100000)) ;; WS_HSCROLL
      (then
        (if (i32.gt_u (local.get $h) (i32.const 16))
          (then (local.set $h (i32.sub (local.get $h) (i32.const 16)))))))
    (local.set $visible (i32.div_u
      (select (i32.sub (local.get $h) (i32.const 8)) (i32.const 1)
              (i32.gt_u (local.get $h) (i32.const 8)))
      (i32.const 16)))
    (if (i32.eqz (local.get $visible)) (then (local.set $visible (i32.const 1))))
    (if (i32.and
          (i32.ne (i32.and (local.get $style) (i32.const 0x00200000)) (i32.const 0))
          (i32.eqz (i32.and (local.get $style) (i32.const 0x00000080))))
      (then (local.set $total (call $edit_layout_build (local.get $state_w)
        (i32.add (local.get $hwnd) (i32.const 0x40000)) (local.get $w))))
      (else (local.set $total (i32.add
        (call $edit_line_from_char (local.get $state_w)
          (i32.load offset=4 (local.get $state_w)))
        (i32.const 1)))))
    (if (i32.lt_s (local.get $total) (i32.const 1)) (then (local.set $total (i32.const 1))))
    (i32.or (i32.and (local.get $total) (i32.const 0xFFFF))
            (i32.shl (local.get $visible) (i32.const 16))))

  ;; Clamp and store a new first-visible line, publishing it to the scrollbar.
  ;; Returns 1 when the viewport actually moved.
  (func $edit_scroll_to (param $hwnd i32) (param $state_w i32) (param $top i32)
        (param $total i32) (param $visible i32) (result i32)
    (local $max i32)
    (local.set $max (i32.sub (local.get $total) (local.get $visible)))
    (if (i32.lt_s (local.get $max) (i32.const 0)) (then (local.set $max (i32.const 0))))
    (if (i32.gt_s (local.get $top) (local.get $max)) (then (local.set $top (local.get $max))))
    (if (i32.lt_s (local.get $top) (i32.const 0)) (then (local.set $top (i32.const 0))))
    (call $edit_publish_scroll_info (local.get $hwnd)
      (local.get $top) (local.get $total) (local.get $visible))
    (if (i32.eq (local.get $top) (i32.load offset=20 (local.get $state_w)))
      (then (return (i32.const 0))))
    (i32.store offset=20 (local.get $state_w) (local.get $top))
    (i32.const 1))

  ;; Drop-in for $invalidate_hwnd at the sites where the user moved the caret.
  (func $edit_invalidate_caret (param $hwnd i32)
    (drop (call $edit_scroll_caret_into_view (local.get $hwnd)))
    (call $invalidate_hwnd (local.get $hwnd)))

  (func $edit_reset_caret_timer (param $hwnd i32) (param $state_w i32)
    (global.set $tick_count (call $host_get_ticks))
    (i32.store offset=24 (local.get $state_w)
      (i32.or (i32.load offset=24 (local.get $state_w)) (i32.const 0x20)))
    (call $timer_set (local.get $hwnd) (i32.const 0xCA47) (i32.const 530) (i32.const 0)))

  (func $edit_stop_caret_timer (param $hwnd i32) (param $state_w i32)
    (drop (call $timer_kill (local.get $hwnd) (i32.const 0xCA47)))
    (i32.store offset=24 (local.get $state_w)
      (i32.and (i32.load offset=24 (local.get $state_w)) (i32.const 0xFFFFFFDF))))

  ;; Right-shift n bytes by 1 (memmove src→src+1). Reverse copy so overlap is safe.
  (func $edit_memmove_right (param $src i32) (param $n i32)
    (local $i i32)
    (local.set $i (local.get $n))
    (block $done (loop $lp
      (br_if $done (i32.eqz (local.get $i)))
      (local.set $i (i32.sub (local.get $i) (i32.const 1)))
      (i32.store8 (i32.add (i32.add (local.get $src) (local.get $i)) (i32.const 1))
                  (i32.load8_u (i32.add (local.get $src) (local.get $i))))
      (br $lp)))
  )

  ;; Ensure EditState has capacity for at least $need_cap chars (excl NUL).
  (func $edit_ensure_cap (param $state_w i32) (param $need_cap i32)
    (local $cap i32) (local $new_cap i32) (local $old_buf i32) (local $new_buf i32) (local $len i32)
    (local.set $cap (i32.load offset=8 (local.get $state_w)))
    (if (i32.le_u (local.get $need_cap) (local.get $cap)) (then (return)))
    (local.set $new_cap (i32.shl (local.get $cap) (i32.const 1)))
    (if (i32.lt_u (local.get $new_cap) (local.get $need_cap))
      (then (local.set $new_cap (local.get $need_cap))))
    (if (i32.lt_u (local.get $new_cap) (i32.const 32))
      (then (local.set $new_cap (i32.const 32))))
    (local.set $new_buf (call $heap_alloc (i32.add (local.get $new_cap) (i32.const 1))))
    (local.set $old_buf (i32.load (local.get $state_w)))
    (local.set $len (i32.load offset=4 (local.get $state_w)))
    (if (local.get $old_buf)
      (then (if (local.get $len)
              (then (call $memcpy (call $g2w (local.get $new_buf))
                                  (call $g2w (local.get $old_buf))
                                  (local.get $len))))))
    (i32.store8 (i32.add (call $g2w (local.get $new_buf)) (local.get $len)) (i32.const 0))
    (if (local.get $old_buf) (then (call $heap_free (local.get $old_buf))))
    (i32.store        (local.get $state_w) (local.get $new_buf))
    (i32.store offset=8 (local.get $state_w) (local.get $new_cap))
  )

  (func $edit_sel_lo (param $state_w i32) (result i32)
    (local $a i32) (local $b i32)
    (local.set $a (i32.load offset=12 (local.get $state_w)))
    (local.set $b (i32.load offset=16 (local.get $state_w)))
    (select (local.get $a) (local.get $b) (i32.lt_u (local.get $a) (local.get $b))))

  (func $edit_sel_hi (param $state_w i32) (result i32)
    (local $a i32) (local $b i32)
    (local.set $a (i32.load offset=12 (local.get $state_w)))
    (local.set $b (i32.load offset=16 (local.get $state_w)))
    (select (local.get $a) (local.get $b) (i32.gt_u (local.get $a) (local.get $b))))

  ;; Delete characters in [lo..hi). Updates text_len, cursor, sel_anchor → lo.
  (func $edit_delete_range (param $state_w i32) (param $lo i32) (param $hi i32)
    (local $buf_w i32) (local $len i32) (local $tail i32)
    (if (i32.ge_u (local.get $lo) (local.get $hi)) (then (return)))
    (local.set $len (i32.load offset=4 (local.get $state_w)))
    (if (i32.gt_u (local.get $hi) (local.get $len)) (then (local.set $hi (local.get $len))))
    (local.set $buf_w (call $g2w (i32.load (local.get $state_w))))
    (local.set $tail (i32.sub (local.get $len) (local.get $hi)))
    (if (local.get $tail)
      (then (call $memcpy
              (i32.add (local.get $buf_w) (local.get $lo))
              (i32.add (local.get $buf_w) (local.get $hi))
              (local.get $tail))))
    (local.set $len (i32.sub (local.get $len) (i32.sub (local.get $hi) (local.get $lo))))
    (i32.store offset=4  (local.get $state_w) (local.get $len))
    (i32.store8 (i32.add (local.get $buf_w) (local.get $len)) (i32.const 0))
    (i32.store offset=12 (local.get $state_w) (local.get $lo))
    (i32.store offset=16 (local.get $state_w) (local.get $lo))
  )

  ;; Insert one byte at cursor (delete selection first).
  (func $edit_insert_char (param $state_w i32) (param $ch i32)
    (local $lo i32) (local $hi i32) (local $cur i32) (local $len i32) (local $buf_w i32) (local $tail i32) (local $maxlen i32)
    (local.set $lo (call $edit_sel_lo (local.get $state_w)))
    (local.set $hi (call $edit_sel_hi (local.get $state_w)))
    (if (i32.ne (local.get $lo) (local.get $hi))
      (then (call $edit_delete_range (local.get $state_w) (local.get $lo) (local.get $hi))))
    (local.set $len (i32.load offset=4 (local.get $state_w)))
    (local.set $maxlen (i32.load offset=28 (local.get $state_w)))
    (if (local.get $maxlen)
      (then (if (i32.ge_u (local.get $len) (local.get $maxlen))
              (then (return)))))
    (call $edit_ensure_cap (local.get $state_w) (i32.add (local.get $len) (i32.const 1)))
    (local.set $cur (i32.load offset=12 (local.get $state_w)))
    (local.set $buf_w (call $g2w (i32.load (local.get $state_w))))
    (local.set $tail (i32.sub (local.get $len) (local.get $cur)))
    (if (local.get $tail)
      (then (call $edit_memmove_right
              (i32.add (local.get $buf_w) (local.get $cur))
              (local.get $tail))))
    (i32.store8 (i32.add (local.get $buf_w) (local.get $cur)) (local.get $ch))
    (local.set $cur (i32.add (local.get $cur) (i32.const 1)))
    (local.set $len (i32.add (local.get $len) (i32.const 1)))
    (i32.store offset=4  (local.get $state_w) (local.get $len))
    (i32.store offset=12 (local.get $state_w) (local.get $cur))
    (i32.store offset=16 (local.get $state_w) (local.get $cur))
    (i32.store8 (i32.add (local.get $buf_w) (local.get $len)) (i32.const 0))
  )

  ;; Insert $n bytes from guest-ptr $src at cursor (delete selection first).
  ;; Used by WM_PASTE / Ctrl+V to bulk-insert clipboard text in one pass
  ;; (avoids per-char memmove storms on large pastes).
  (func $edit_insert_bytes (param $state_w i32) (param $src_g i32) (param $n i32)
    (local $lo i32) (local $hi i32) (local $cur i32) (local $len i32) (local $buf_w i32) (local $tail i32) (local $maxlen i32) (local $src_w i32) (local $room i32)
    (if (i32.eqz (local.get $n)) (then (return)))
    (local.set $lo (call $edit_sel_lo (local.get $state_w)))
    (local.set $hi (call $edit_sel_hi (local.get $state_w)))
    (if (i32.ne (local.get $lo) (local.get $hi))
      (then (call $edit_delete_range (local.get $state_w) (local.get $lo) (local.get $hi))))
    (local.set $len (i32.load offset=4 (local.get $state_w)))
    (local.set $maxlen (i32.load offset=28 (local.get $state_w)))
    (if (local.get $maxlen)
      (then
        (local.set $room (i32.sub (local.get $maxlen) (local.get $len)))
        (if (i32.lt_s (local.get $room) (i32.const 0)) (then (local.set $room (i32.const 0))))
        (if (i32.gt_u (local.get $n) (local.get $room))
          (then (local.set $n (local.get $room))))))
    (if (i32.eqz (local.get $n)) (then (return)))
    (call $edit_ensure_cap (local.get $state_w) (i32.add (local.get $len) (local.get $n)))
    (local.set $cur (i32.load offset=12 (local.get $state_w)))
    (local.set $buf_w (call $g2w (i32.load (local.get $state_w))))
    ;; Shift tail right by $n bytes (reverse copy for overlap safety)
    (local.set $tail (i32.sub (local.get $len) (local.get $cur)))
    (if (local.get $tail)
      (then
        (block $md (loop $ml
          (br_if $md (i32.eqz (local.get $tail)))
          (local.set $tail (i32.sub (local.get $tail) (i32.const 1)))
          (i32.store8
            (i32.add (local.get $buf_w) (i32.add (local.get $cur) (i32.add (local.get $tail) (local.get $n))))
            (i32.load8_u (i32.add (local.get $buf_w) (i32.add (local.get $cur) (local.get $tail)))))
          (br $ml)))))
    (local.set $src_w (call $g2w (local.get $src_g)))
    (call $memcpy
      (i32.add (local.get $buf_w) (local.get $cur))
      (local.get $src_w)
      (local.get $n))
    (local.set $cur (i32.add (local.get $cur) (local.get $n)))
    (local.set $len (i32.add (local.get $len) (local.get $n)))
    (i32.store offset=4  (local.get $state_w) (local.get $len))
    (i32.store offset=12 (local.get $state_w) (local.get $cur))
    (i32.store offset=16 (local.get $state_w) (local.get $cur))
    (i32.store8 (i32.add (local.get $buf_w) (local.get $len)) (i32.const 0))
  )

  ;; Copy [lo..hi) from edit to the global clipboard, reallocating to fit.
  ;; No-op when lo >= hi (empty selection — leaves clipboard untouched so
  ;; Ctrl+C on nothing doesn't wipe a prior copy).
  (func $edit_copy_range (param $state_w i32) (param $lo i32) (param $hi i32)
    (local $len i32) (local $src_g i32) (local $dst_g i32) (local $cap i32) (local $need i32)
    (if (i32.ge_u (local.get $lo) (local.get $hi)) (then (return)))
    (local.set $len (i32.sub (local.get $hi) (local.get $lo)))
    (local.set $need (i32.add (local.get $len) (i32.const 1)))
    (local.set $src_g (i32.load (local.get $state_w)))
    (if (i32.eqz (local.get $src_g)) (then (return)))
    ;; Grow capacity if needed (round up to multiple of 64).
    (if (i32.gt_u (local.get $need) (global.get $clipboard_cap))
      (then
        (if (global.get $clipboard_ptr)
          (then (call $heap_free (global.get $clipboard_ptr))
                (global.set $clipboard_ptr (i32.const 0))))
        (local.set $cap (i32.and (i32.add (local.get $need) (i32.const 63)) (i32.const -64)))
        (global.set $clipboard_ptr (call $heap_alloc (local.get $cap)))
        (global.set $clipboard_cap (local.get $cap))))
    (local.set $dst_g (global.get $clipboard_ptr))
    (if (i32.eqz (local.get $dst_g)) (then (return)))
    (call $memcpy
      (call $g2w (local.get $dst_g))
      (i32.add (call $g2w (local.get $src_g)) (local.get $lo))
      (local.get $len))
    (i32.store8 (i32.add (call $g2w (local.get $dst_g)) (local.get $len)) (i32.const 0))
    (global.set $clipboard_len (local.get $len))
    (call $richedit_clipboard_clear_format)
    (call $clipboard_clear_rtf_data)
  )

  ;; Convert click (x,y) in edit client coords to a char offset.
  ;; Uses $host_measure_text to binary-ish-search the column within a line.
  ;; y-based line pick clamps to last line; x-based col picks the half-char
  ;; the click falls into (standard Win32 caret behavior).
  (func $edit_xy_to_offset (param $state_w i32) (param $hdc i32) (param $x i32) (param $y i32) (result i32)
    (local $line_num i32) (local $line_start i32) (local $line_len i32)
    (local $text_len i32) (local $buf_g i32) (local $line_w i32)
    (local $i i32) (local $w i32) (local $prev_w i32) (local $mid i32)
    (local $total_lines i32)
    (local.set $text_len (i32.load offset=4 (local.get $state_w)))
    (local.set $buf_g (i32.load (local.get $state_w)))
    (if (i32.eqz (local.get $buf_g)) (then (return (i32.const 0))))
    ;; Subtract 4px text margin, clamp x>=0, y>=0.
    (local.set $x (i32.sub (local.get $x) (i32.const 4)))
    (if (i32.lt_s (local.get $x) (i32.const 0)) (then (local.set $x (i32.const 0))))
    (local.set $y (i32.sub (local.get $y) (i32.const 4)))
    (if (i32.lt_s (local.get $y) (i32.const 0)) (then (local.set $y (i32.const 0))))
    (local.set $line_num (i32.div_s (local.get $y) (i32.const 16)))
    (local.set $line_num (i32.add (local.get $line_num) (i32.load offset=20 (local.get $state_w))))
    ;; Clamp to last line: total_lines = edit_line_from_char(text_len) + 1
    (local.set $total_lines (i32.add
      (call $edit_line_from_char (local.get $state_w) (local.get $text_len))
      (i32.const 1)))
    (if (i32.ge_u (local.get $line_num) (local.get $total_lines))
      (then (local.set $line_num (i32.sub (local.get $total_lines) (i32.const 1)))))
    (local.set $line_start (call $edit_line_index (local.get $state_w) (local.get $line_num)))
    (local.set $line_len (call $edit_line_len (local.get $state_w) (local.get $line_start)))
    (local.set $line_w (i32.add (call $g2w (local.get $buf_g)) (local.get $line_start)))
    (local.set $prev_w (i32.const 0))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $line_len)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $w (call $host_measure_text
        (local.get $hdc) (local.get $line_w) (local.get $i) (i32.const 0)))
      (local.set $mid (i32.shr_s (i32.add (local.get $prev_w) (local.get $w)) (i32.const 1)))
      (if (i32.gt_s (local.get $mid) (local.get $x))
        (then (return (i32.add (local.get $line_start) (i32.sub (local.get $i) (i32.const 1))))))
      (local.set $prev_w (local.get $w))
      (br $scan)))
    (i32.add (local.get $line_start) (local.get $line_len)))

  (func $edit_layout_store (param $idx i32) (param $start i32) (param $len i32)
    (local $p i32)
    (if (i32.ge_u (local.get $idx) (global.get $EDIT_LAYOUT_MAX)) (then (return)))
    (local.set $p (i32.add (global.get $EDIT_LAYOUT_SCRATCH)
                    (i32.mul (local.get $idx) (i32.const 8))))
    (i32.store (local.get $p) (local.get $start))
    (i32.store offset=4 (local.get $p) (local.get $len)))

  (func $edit_layout_start (param $idx i32) (result i32)
    (i32.load (i32.add (global.get $EDIT_LAYOUT_SCRATCH)
              (i32.mul (local.get $idx) (i32.const 8)))))

  (func $edit_layout_len (param $idx i32) (result i32)
    (i32.load offset=4 (i32.add (global.get $EDIT_LAYOUT_SCRATCH)
                       (i32.mul (local.get $idx) (i32.const 8)))))

  ;; Build the visual-line table used by wrapped multiline edits. This is the
  ;; WAT-side equivalent of USER32 EDIT's internal line layout: explicit CR/LF
  ;; breaks plus simple word wrapping against the edit client width.
  (func $edit_layout_build (param $state_w i32) (param $hdc i32) (param $text_w i32) (result i32)
    (local $buf_g i32) (local $buf_w i32) (local $text_len i32)
    (local $count i32) (local $line_start i32) (local $pos i32)
    (local $ch i32) (local $next_ch i32) (local $max_w i32)
    (local $candidate_len i32) (local $width i32)
    (local $last_space i32) (local $break_len i32) (local $next_start i32)

    (local.set $buf_g (i32.load (local.get $state_w)))
    (local.set $text_len (i32.load offset=4 (local.get $state_w)))
    (if (i32.eqz (local.get $buf_g))
      (then
        (call $edit_layout_store (i32.const 0) (i32.const 0) (i32.const 0))
        (return (i32.const 1))))
    (local.set $buf_w (call $g2w (local.get $buf_g)))
    (local.set $max_w (i32.sub (local.get $text_w) (i32.const 8)))
    (if (i32.lt_s (local.get $max_w) (i32.const 8))
      (then (local.set $max_w (i32.const 8))))
    (local.set $line_start (i32.const 0))
    (local.set $count (i32.const 0))

    (block $done (loop $outer
      (br_if $done (i32.ge_u (local.get $count) (global.get $EDIT_LAYOUT_MAX)))
      (if (i32.gt_u (local.get $line_start) (local.get $text_len))
        (then (br $done)))

      (local.set $pos (local.get $line_start))
      (local.set $last_space (i32.const -1))
      (block $line_done (loop $scan
        (br_if $line_done (i32.ge_u (local.get $pos) (local.get $text_len)))
        (local.set $ch (i32.load8_u (i32.add (local.get $buf_w) (local.get $pos))))
        (if (i32.or (i32.eq (local.get $ch) (i32.const 10))
                    (i32.eq (local.get $ch) (i32.const 13)))
          (then
            (local.set $break_len (i32.sub (local.get $pos) (local.get $line_start)))
            (call $edit_layout_store (local.get $count) (local.get $line_start) (local.get $break_len))
            (local.set $count (i32.add (local.get $count) (i32.const 1)))
            (local.set $next_start (i32.add (local.get $pos) (i32.const 1)))
            (if (i32.and
                  (i32.eq (local.get $ch) (i32.const 13))
                  (i32.lt_u (local.get $next_start) (local.get $text_len)))
              (then
                (local.set $next_ch (i32.load8_u (i32.add (local.get $buf_w) (local.get $next_start))))
                (if (i32.eq (local.get $next_ch) (i32.const 10))
                  (then (local.set $next_start (i32.add (local.get $next_start) (i32.const 1)))))))
            (local.set $line_start (local.get $next_start))
            (br $line_done)))
        (if (i32.eq (local.get $ch) (i32.const 32))
          (then (local.set $last_space (local.get $pos))))
        (local.set $candidate_len (i32.add (i32.sub (local.get $pos) (local.get $line_start)) (i32.const 1)))
        (local.set $width (call $host_measure_text
          (local.get $hdc)
          (i32.add (local.get $buf_w) (local.get $line_start))
          (local.get $candidate_len) (i32.const 0)))
        (if (i32.and (i32.gt_s (local.get $width) (local.get $max_w))
                     (i32.gt_u (local.get $candidate_len) (i32.const 1)))
          (then
            (if (i32.and (i32.ge_s (local.get $last_space) (local.get $line_start))
                         (i32.gt_u (local.get $last_space) (local.get $line_start)))
              (then
                (local.set $break_len (i32.sub (local.get $last_space) (local.get $line_start)))
                (local.set $next_start (i32.add (local.get $last_space) (i32.const 1))))
              (else
                (local.set $break_len (i32.sub (local.get $pos) (local.get $line_start)))
                (local.set $next_start (local.get $pos))))
            (call $edit_layout_store (local.get $count) (local.get $line_start) (local.get $break_len))
            (local.set $count (i32.add (local.get $count) (i32.const 1)))
            (local.set $line_start (local.get $next_start))
            (br $line_done)))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
        (br $scan)))

      (if (i32.ge_u (local.get $pos) (local.get $text_len))
        (then
          (call $edit_layout_store
            (local.get $count)
            (local.get $line_start)
            (i32.sub (local.get $text_len) (local.get $line_start)))
          (local.set $count (i32.add (local.get $count) (i32.const 1)))
          (br $done)))
      (br $outer)))
    (if (i32.eqz (local.get $count))
      (then
        (call $edit_layout_store (i32.const 0) (i32.const 0) (i32.const 0))
        (return (i32.const 1))))
    (local.get $count))

  (func $edit_layout_line_for_char (param $line_count i32) (param $cur i32) (result i32)
    (local $i i32) (local $s i32) (local $e i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $line_count)))
      (local.set $s (call $edit_layout_start (local.get $i)))
      (local.set $e (i32.add (local.get $s) (call $edit_layout_len (local.get $i))))
      (if (i32.and (i32.ge_u (local.get $cur) (local.get $s))
                   (i32.le_u (local.get $cur) (local.get $e)))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (select (i32.sub (local.get $line_count) (i32.const 1)) (i32.const 0)
            (i32.gt_u (local.get $line_count) (i32.const 0))))

  (func $edit_layout_xy_to_offset
        (param $state_w i32) (param $hdc i32) (param $text_w i32) (param $x i32) (param $y i32) (result i32)
    (local $line_count i32) (local $line_num i32) (local $line_start i32) (local $line_len i32)
    (local $buf_w i32) (local $i i32) (local $w i32) (local $prev_w i32) (local $mid i32)
    (local.set $line_count (call $edit_layout_build (local.get $state_w) (local.get $hdc) (local.get $text_w)))
    (local.set $x (i32.sub (local.get $x) (i32.const 4)))
    (if (i32.lt_s (local.get $x) (i32.const 0)) (then (local.set $x (i32.const 0))))
    (local.set $y (i32.sub (local.get $y) (i32.const 4)))
    (if (i32.lt_s (local.get $y) (i32.const 0)) (then (local.set $y (i32.const 0))))
    (local.set $line_num (i32.add
      (i32.div_s (local.get $y) (i32.const 16))
      (i32.load offset=20 (local.get $state_w))))
    (if (i32.ge_u (local.get $line_num) (local.get $line_count))
      (then (local.set $line_num (i32.sub (local.get $line_count) (i32.const 1)))))
    (local.set $line_start (call $edit_layout_start (local.get $line_num)))
    (local.set $line_len (call $edit_layout_len (local.get $line_num)))
    (local.set $buf_w (call $g2w (i32.load (local.get $state_w))))
    (local.set $prev_w (i32.const 0))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $line_len)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $w (call $host_measure_text
        (local.get $hdc) (i32.add (local.get $buf_w) (local.get $line_start))
        (local.get $i) (i32.const 0)))
      (if (i32.eqz (local.get $w))
        (then (local.set $w (i32.mul (local.get $i) (i32.const 8)))))
      (local.set $mid (i32.shr_s (i32.add (local.get $prev_w) (local.get $w)) (i32.const 1)))
      (if (i32.gt_s (local.get $mid) (local.get $x))
        (then (return (i32.add (local.get $line_start) (i32.sub (local.get $i) (i32.const 1))))))
      (local.set $prev_w (local.get $w))
      (br $scan)))
    (i32.add (local.get $line_start) (local.get $line_len)))

  ;; Word-boundary classification: 1 if $ch is part of a word (alnum/underscore),
  ;; else 0. Matches Win32 default word break for ASCII.
  (func $edit_is_word_char (param $ch i32) (result i32)
    (if (i32.eq (local.get $ch) (i32.const 0x5F)) (then (return (i32.const 1))))  ;; _
    (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x30))
                 (i32.le_u (local.get $ch) (i32.const 0x39)))
      (then (return (i32.const 1))))  ;; 0-9
    (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x41))
                 (i32.le_u (local.get $ch) (i32.const 0x5A)))
      (then (return (i32.const 1))))  ;; A-Z
    (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x61))
                 (i32.le_u (local.get $ch) (i32.const 0x7A)))
      (then (return (i32.const 1))))  ;; a-z
    (i32.const 0))

  (func $edit_word_start (param $state_w i32) (param $pos i32) (result i32)
    (local $buf_w i32) (local $ch i32)
    (local.set $buf_w (i32.load (local.get $state_w)))
    (if (i32.eqz (local.get $buf_w)) (then (return (local.get $pos))))
    (local.set $buf_w (call $g2w (local.get $buf_w)))
    (block $done (loop $scan
      (br_if $done (i32.le_s (local.get $pos) (i32.const 0)))
      (local.set $ch (i32.load8_u (i32.add (local.get $buf_w) (i32.sub (local.get $pos) (i32.const 1)))))
      (br_if $done (i32.eqz (call $edit_is_word_char (local.get $ch))))
      (local.set $pos (i32.sub (local.get $pos) (i32.const 1)))
      (br $scan)))
    (local.get $pos))

  (func $edit_word_end (param $state_w i32) (param $pos i32) (result i32)
    (local $buf_w i32) (local $text_len i32) (local $ch i32)
    (local.set $buf_w (i32.load (local.get $state_w)))
    (if (i32.eqz (local.get $buf_w)) (then (return (local.get $pos))))
    (local.set $buf_w (call $g2w (local.get $buf_w)))
    (local.set $text_len (i32.load offset=4 (local.get $state_w)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $pos) (local.get $text_len)))
      (local.set $ch (i32.load8_u (i32.add (local.get $buf_w) (local.get $pos))))
      (br_if $done (i32.eqz (call $edit_is_word_char (local.get $ch))))
      (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
      (br $scan)))
    (local.get $pos))

  ;; True if VK_SHIFT/VK_CONTROL are physically down (uses host async state).
  (func $edit_shift_down (result i32)
    (i32.and (call $host_get_async_key_state (i32.const 0x10)) (i32.const 0x8000)))
  (func $edit_ctrl_down (result i32)
    (i32.and (call $host_get_async_key_state (i32.const 0x11)) (i32.const 0x8000)))

  (func $edit_notify (param $hwnd i32) (param $code i32)
    (local $parent i32) (local $id i32)
    (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
    (if (local.get $parent)
      (then
        (local.set $id (call $ctrl_table_get_id (local.get $hwnd)))
        (drop (call $wnd_send_message
          (local.get $parent)
          (i32.const 0x0111)  ;; WM_COMMAND
          (i32.or (i32.and (local.get $id) (i32.const 0xFFFF))
                  (i32.shl (local.get $code) (i32.const 16)))
          (local.get $hwnd))))))

  (func $edit_notify_change (param $hwnd i32)
    ;; A standard multiline EDIT sends EN_UPDATE immediately before repaint,
    ;; followed by EN_CHANGE once its text has changed. Paint consumes the
    ;; update notification to refresh the text object that is later committed.
    (call $edit_notify (local.get $hwnd) (i32.const 0x0400)) ;; EN_UPDATE
    (call $edit_notify (local.get $hwnd) (i32.const 0x0300))) ;; EN_CHANGE

  (func $edit_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $state i32) (local $state_w i32) (local $cs_w i32)
    (local $name_ptr i32) (local $text_len i32) (local $hdc i32)
    (local $sz i32) (local $w i32) (local $h i32) (local $buf i32)
    (local $cur i32) (local $px i32) (local $lo i32) (local $hi i32)
    (local $vk i32) (local $flags i32)
    (local $sel_lo i32) (local $sel_hi i32) (local $a i32) (local $b i32)
    (local $line_end i32) (local $pre_w i32) (local $sel_w i32)
    (local $line_y i32) (local $line_buf_w i32) (local $brush i32)
    (local $full_w i32) (local $total_lines i32) (local $visible_lines i32) (local $max_scroll i32)

    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))

    ;; ---------- WM_CREATE (0x0001) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0001))
      (then
        ;; EditState additionally keeps the font installed by WM_SETFONT at
        ;; +32.  Paint replaces this font whenever its floating Fonts palette
        ;; changes, and queries it back with WM_GETFONT for text metrics.
        (local.set $state (call $heap_alloc (i32.const 36)))
        (local.set $state_w (call $g2w (local.get $state)))
        (i32.store         (local.get $state_w) (i32.const 0))
        (i32.store offset=4  (local.get $state_w) (i32.const 0))
        (i32.store offset=8  (local.get $state_w) (i32.const 0))
        (i32.store offset=12 (local.get $state_w) (i32.const 0))
        (i32.store offset=16 (local.get $state_w) (i32.const 0))
        (i32.store offset=20 (local.get $state_w) (i32.const 0))
        (i32.store offset=24 (local.get $state_w) (i32.const 0))
        ;; Plain EDIT keeps the existing unlimited internal default. Both
        ;; Win9x RichEdit generations start at the documented 32,767-character
        ;; input limit until the application explicitly changes it.
        (i32.store offset=28 (local.get $state_w)
          (select (i32.const 32767) (i32.const 0)
            (i32.or
              (i32.eq (call $ctrl_table_get_class (local.get $hwnd)) (i32.const 24))
              (i32.eq (call $ctrl_table_get_class (local.get $hwnd)) (i32.const 25)))))
        (i32.store offset=32 (local.get $state_w) (i32.const 0))
        ;; Copy initial text from CREATESTRUCT if provided (lParam may be 0
        ;; when WM_CREATE is delivered via pending_child_create from GetMessageA)
        (if (local.get $lParam)
          (then
            (local.set $cs_w (call $g2w (local.get $lParam)))
            (local.set $name_ptr (i32.load offset=36 (local.get $cs_w)))
            (if (local.get $name_ptr)
              (then
                (local.set $text_len (call $strlen (call $g2w (local.get $name_ptr))))
                (call $edit_ensure_cap (local.get $state_w) (local.get $text_len))
                (if (local.get $text_len)
                  (then (call $memcpy (call $g2w (i32.load (local.get $state_w)))
                                      (call $g2w (local.get $name_ptr))
                                      (local.get $text_len))))
                (i32.store offset=4  (local.get $state_w) (local.get $text_len))
                (i32.store offset=12 (local.get $state_w) (local.get $text_len))
                (i32.store offset=16 (local.get $state_w) (local.get $text_len))
                (if (i32.load (local.get $state_w))
                  (then (i32.store8 (i32.add (call $g2w (i32.load (local.get $state_w))) (local.get $text_len))
                                    (i32.const 0))))))))
        ;; Set flags from window style: ES_MULTILINE(0x04)→bit0, ES_PASSWORD(0x20)→bit1, ES_READONLY(0x800)→bit2
        (local.set $flags (call $wnd_get_style (local.get $hwnd)))
        (if (i32.and (local.get $flags) (i32.const 0x04))
          (then (i32.store offset=24 (local.get $state_w)
            (i32.or (i32.load offset=24 (local.get $state_w)) (i32.const 0x01)))))
        (if (i32.and (local.get $flags) (i32.const 0x0020))
          (then (i32.store offset=24 (local.get $state_w)
            (i32.or (i32.load offset=24 (local.get $state_w)) (i32.const 0x02)))))
        (if (i32.and (local.get $flags) (i32.const 0x0800))
          (then (i32.store offset=24 (local.get $state_w)
            (i32.or (i32.load offset=24 (local.get $state_w)) (i32.const 0x04)))))
        (call $wnd_set_state_ptr (local.get $hwnd) (local.get $state))
        (return (i32.const 0))))

    ;; ---------- WM_SETFONT (0x0030) / WM_GETFONT (0x0031) ----------
    ;; MFC's CWnd::SetFont sends these through the application's EDIT
    ;; subclass. Keep the handle in native EditState so Paint's font toolbar
    ;; can both retrieve it for metrics and use it during control painting.
    (if (i32.eq (local.get $msg) (i32.const 0x0030))
      (then
        (if (local.get $state)
          (then
            (i32.store offset=32 (call $g2w (local.get $state)) (local.get $wParam))
            (if (local.get $lParam)
              (then (call $invalidate_hwnd (local.get $hwnd))))))
        (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0031))
      (then
        (if (local.get $state)
          (then (return (i32.load offset=32 (call $g2w (local.get $state))))))
        (return (i32.const 0))))

    ;; ---------- WM_DESTROY (0x0002) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0002))
      (then
        (if (local.get $state)
          (then
            (drop (call $timer_kill (local.get $hwnd) (i32.const 0xCA47)))
            (local.set $state_w (call $g2w (local.get $state)))
            (if (i32.load (local.get $state_w))
              (then (call $heap_free (i32.load (local.get $state_w)))))
            (call $heap_free (local.get $state))
            (call $wnd_set_state_ptr (local.get $hwnd) (i32.const 0))))
        (if (i32.eq (global.get $focus_hwnd) (local.get $hwnd))
          (then (global.set $focus_hwnd (i32.const 0))))
        (return (i32.const 0))))

    ;; ---------- WM_SETCURSOR (0x0020) ----------
    ;; Show the I-beam over the edit client area (HTCLIENT=1).
    (if (i32.eq (local.get $msg) (i32.const 0x0020))
      (then
        (if (i32.eq (i32.and (local.get $lParam) (i32.const 0xFFFF)) (i32.const 1))
          (then
            (drop (call $set_cursor_internal (i32.const 0x67F01))) ;; IDC_IBEAM
            (return (i32.const 1))))
        (return (i32.const 0))))

    ;; ---------- WM_SETTEXT (0x000C) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x000C))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (i32.store offset=4  (local.get $state_w) (i32.const 0))
        (i32.store offset=12 (local.get $state_w) (i32.const 0))
        (i32.store offset=16 (local.get $state_w) (i32.const 0))
        (if (local.get $lParam)
          (then
            (local.set $text_len (call $strlen (call $g2w (local.get $lParam))))
            (call $edit_ensure_cap (local.get $state_w) (local.get $text_len))
            (if (local.get $text_len)
              (then (call $memcpy (call $g2w (i32.load (local.get $state_w)))
                                  (call $g2w (local.get $lParam))
                                  (local.get $text_len))))
            (i32.store offset=4  (local.get $state_w) (local.get $text_len))
            (i32.store offset=12 (local.get $state_w) (local.get $text_len))
            (i32.store offset=16 (local.get $state_w) (local.get $text_len))
            (if (i32.load (local.get $state_w))
              (then (i32.store8 (i32.add (call $g2w (i32.load (local.get $state_w))) (local.get $text_len))
                                (i32.const 0))))))
        (if (i32.and (i32.load offset=24 (local.get $state_w)) (i32.const 0x08))
          (then
            (call $edit_reset_caret_timer (local.get $hwnd) (local.get $state_w))))
        (call $edit_notify_change (local.get $hwnd))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 1))))

    ;; ---------- WM_GETTEXT (0x000D) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x000D))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (if (i32.eqz (local.get $wParam)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $text_len (i32.load offset=4 (local.get $state_w)))
        (if (i32.ge_u (local.get $text_len) (local.get $wParam))
          (then (local.set $text_len (i32.sub (local.get $wParam) (i32.const 1)))))
        (if (i32.load (local.get $state_w))
          (then (if (local.get $text_len)
                  (then (call $memcpy (call $g2w (local.get $lParam))
                                      (call $g2w (i32.load (local.get $state_w)))
                                      (local.get $text_len))))))
        (i32.store8 (i32.add (call $g2w (local.get $lParam)) (local.get $text_len)) (i32.const 0))
        (return (local.get $text_len))))

    ;; ---------- WM_GETTEXTLENGTH (0x000E) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x000E))
      (then
        (if (local.get $state)
          (then (return (i32.load offset=4 (call $g2w (local.get $state))))))
        (return (i32.const 0))))

    ;; ---------- EM_STREAMIN (0x0449) ----------
    ;; RichEdit license controls in NSIS pass an EDITSTREAM whose dwCookie
    ;; points at the source text buffer. For our edit-like RichEdit shim,
    ;; copying that text into EditState is enough to render the license body.
    (if (i32.eq (local.get $msg) (i32.const 0x0449))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (if (i32.eqz (local.get $lParam)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $name_ptr (i32.load (call $g2w (local.get $lParam))))
        (i32.store offset=4  (local.get $state_w) (i32.const 0))
        (i32.store offset=12 (local.get $state_w) (i32.const 0))
        (i32.store offset=16 (local.get $state_w) (i32.const 0))
        (if (local.get $name_ptr)
          (then
            (local.set $text_len (call $strlen (call $g2w (local.get $name_ptr))))
            (call $edit_ensure_cap (local.get $state_w) (local.get $text_len))
            (if (local.get $text_len)
              (then (call $memcpy (call $g2w (i32.load (local.get $state_w)))
                                  (call $g2w (local.get $name_ptr))
                                  (local.get $text_len))))
            (i32.store offset=4  (local.get $state_w) (local.get $text_len))
            (i32.store offset=12 (local.get $state_w) (local.get $text_len))
            (i32.store offset=16 (local.get $state_w) (local.get $text_len))
            (if (i32.load (local.get $state_w))
              (then (i32.store8 (i32.add (call $g2w (i32.load (local.get $state_w))) (local.get $text_len))
                                (i32.const 0))))))
        (call $invalidate_hwnd (local.get $hwnd))
        (if (call $wnd_is_effectively_visible (local.get $hwnd))
          (then
            (drop (call $edit_wndproc
              (local.get $hwnd) (i32.const 0x000F)
              (i32.const 0) (i32.const 0)))
            (call $update_clear_hwnd (local.get $hwnd))
            (call $paint_flag_clear_hwnd (local.get $hwnd))))
        (return (i32.load offset=4 (local.get $state_w)))))

    ;; ---------- WM_SETFOCUS (0x0007) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0007))
      (then
        (global.set $focus_hwnd (local.get $hwnd))
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            (i32.store offset=24 (local.get $state_w)
              (i32.or (i32.load offset=24 (local.get $state_w)) (i32.const 0x08)))
            (call $edit_reset_caret_timer (local.get $hwnd) (local.get $state_w))))
        (call $edit_notify (local.get $hwnd) (i32.const 0x0100)) ;; EN_SETFOCUS
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 0))))

    ;; ---------- WM_KILLFOCUS (0x0008) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0008))
      (then
        (if (i32.eq (global.get $focus_hwnd) (local.get $hwnd))
          (then (global.set $focus_hwnd (i32.const 0))))
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            (call $edit_stop_caret_timer (local.get $hwnd) (local.get $state_w))
            (i32.store offset=24 (local.get $state_w)
              (i32.and (i32.load offset=24 (local.get $state_w)) (i32.const 0xFFFFFFF7)))))
        (call $edit_notify (local.get $hwnd) (i32.const 0x0200)) ;; EN_KILLFOCUS
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 0))))

    ;; ---------- WM_SIZE (0x0005) ----------
    ;; Wrapped multiline edits derive max_scroll from current control geometry.
    ;; Clamp immediately on resize so EM_GETFIRSTVISIBLELINE cannot expose a
    ;; stale top line after a window/control grows wider or taller.
    (if (i32.eq (local.get $msg) (i32.const 0x0005))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (if (i32.eqz (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00000004)))
          (then (return (i32.const 0))))
        ;; $edit_view_metrics is the one place that knows a WS_HSCROLL edit
        ;; loses 16px of height to its own scrollbar. This site used to
        ;; re-derive the viewport inline and omit exactly that, so a horizontal
        ;; scrollbar bought the control one extra "visible" line it does not have.
        (local.set $sz (call $edit_view_metrics (local.get $hwnd) (local.get $state_w)))
        (local.set $total_lines (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $visible_lines (i32.shr_u (local.get $sz) (i32.const 16)))
        (local.set $max_scroll (i32.sub (local.get $total_lines) (local.get $visible_lines)))
        (if (i32.lt_s (local.get $max_scroll) (i32.const 0))
          (then (local.set $max_scroll (i32.const 0))))
        (if (i32.gt_s (i32.load offset=20 (local.get $state_w)) (local.get $max_scroll))
          (then (i32.store offset=20 (local.get $state_w) (local.get $max_scroll))))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 0))))

    ;; ---------- WM_TIMER (0x0113) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0113))
      (then
        (if (i32.ne (local.get $wParam) (i32.const 0xCA47))
          (then (return (i32.const 0))))
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $flags (i32.load offset=24 (local.get $state_w)))
        (if (i32.eqz (i32.and (local.get $flags) (i32.const 0x08)))
          (then
            (call $edit_stop_caret_timer (local.get $hwnd) (local.get $state_w))
            (call $invalidate_hwnd (local.get $hwnd))
            (return (i32.const 0))))
        (i32.store offset=24 (local.get $state_w)
          (i32.xor (local.get $flags) (i32.const 0x20)))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 0))))

    ;; ---------- WM_CHAR (0x0102) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0102))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (if (i32.and (i32.load offset=24 (local.get $state_w)) (i32.const 0x04))
          (then (return (i32.const 0))))
        ;; VK_BACK = 0x08 — backspace
        (if (i32.eq (local.get $wParam) (i32.const 0x08))
          (then
            (local.set $lo (call $edit_sel_lo (local.get $state_w)))
            (local.set $hi (call $edit_sel_hi (local.get $state_w)))
            (if (i32.ne (local.get $lo) (local.get $hi))
              (then (call $edit_delete_range (local.get $state_w) (local.get $lo) (local.get $hi)))
              (else
                (if (local.get $lo)
                  (then (call $edit_delete_range (local.get $state_w)
                          (i32.sub (local.get $lo) (i32.const 1))
                          (local.get $lo))))))
            (call $edit_reset_caret_timer (local.get $hwnd) (local.get $state_w))
            (call $edit_notify_change (local.get $hwnd))
            (call $edit_invalidate_caret (local.get $hwnd))
            (return (i32.const 0))))
        ;; CR (0x0D) — Enter key: insert newline only for multiline edits (bit 0 of flags)
        (if (i32.eq (local.get $wParam) (i32.const 0x0D))
          (then
            (if (i32.and (i32.load offset=24 (local.get $state_w)) (i32.const 0x01))
              (then
                (call $edit_insert_char (local.get $state_w) (i32.const 0x0A))
                (i32.store offset=24 (local.get $state_w)
                  (i32.or (i32.load offset=24 (local.get $state_w)) (i32.const 0x08)))
                (call $edit_reset_caret_timer (local.get $hwnd) (local.get $state_w))
                (call $edit_notify_change (local.get $hwnd))
                (call $edit_invalidate_caret (local.get $hwnd))))
            (return (i32.const 0))))
        (if (i32.lt_u (local.get $wParam) (i32.const 0x20))
          (then (return (i32.const 0))))
        (call $edit_insert_char (local.get $state_w) (local.get $wParam))
        (i32.store offset=24 (local.get $state_w)
          (i32.or (i32.load offset=24 (local.get $state_w)) (i32.const 0x08)))
        (call $edit_reset_caret_timer (local.get $hwnd) (local.get $state_w))
        (call $edit_notify_change (local.get $hwnd))
        (call $edit_invalidate_caret (local.get $hwnd))
        (return (i32.const 0))))

    ;; ---------- WM_KEYDOWN (0x0100) ----------
    ;; Keyboard navigation + editing. Shift-held keeps sel_anchor so arrows
    ;; extend the selection; plain arrows collapse. Ctrl+A/C/X/V handle
    ;; select-all / copy / cut / paste. Ctrl+Left/Right jump word boundaries;
    ;; Ctrl+Home/End jump to start/end of text. $a = shift_down, $b = ctrl_down
    ;; (high bit of host_get_async_key_state, read once at top).
    (if (i32.eq (local.get $msg) (i32.const 0x0100))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $vk (local.get $wParam))
        (local.set $cur (i32.load offset=12 (local.get $state_w)))
        (local.set $text_len (i32.load offset=4 (local.get $state_w)))
        (local.set $a (call $edit_shift_down))
        (local.set $b (call $edit_ctrl_down))
        ;; ---- Ctrl combos ----
        (if (local.get $b)
          (then
            ;; Ctrl+A (0x41) — select all
            (if (i32.eq (local.get $vk) (i32.const 0x41))
              (then
                (i32.store offset=16 (local.get $state_w) (i32.const 0))
                (i32.store offset=12 (local.get $state_w) (local.get $text_len))
                (call $edit_invalidate_caret (local.get $hwnd))
                (return (i32.const 0))))
            ;; Ctrl+C (0x43) — copy
            (if (i32.eq (local.get $vk) (i32.const 0x43))
              (then
                (call $edit_copy_range (local.get $state_w)
                  (call $edit_sel_lo (local.get $state_w))
                  (call $edit_sel_hi (local.get $state_w)))
                (return (i32.const 0))))
            ;; Ctrl+X (0x58) — cut (read-only blocks deletion but copy still fires)
            (if (i32.eq (local.get $vk) (i32.const 0x58))
              (then
                (local.set $lo (call $edit_sel_lo (local.get $state_w)))
                (local.set $hi (call $edit_sel_hi (local.get $state_w)))
                (call $edit_copy_range (local.get $state_w) (local.get $lo) (local.get $hi))
                (if (i32.eqz (i32.and (i32.load offset=24 (local.get $state_w)) (i32.const 0x04)))
                  (then
                    (call $edit_delete_range (local.get $state_w) (local.get $lo) (local.get $hi))
                    (call $edit_notify_change (local.get $hwnd))
                    (call $edit_invalidate_caret (local.get $hwnd))))
                (return (i32.const 0))))
            ;; Ctrl+V (0x56) — paste
            (if (i32.eq (local.get $vk) (i32.const 0x56))
              (then
                (if (i32.eqz (i32.and (i32.load offset=24 (local.get $state_w)) (i32.const 0x04)))
                  (then
                    (if (global.get $clipboard_len)
                      (then (call $edit_insert_bytes (local.get $state_w)
                              (global.get $clipboard_ptr) (global.get $clipboard_len))
                            (call $edit_notify_change (local.get $hwnd))))
                    (call $edit_invalidate_caret (local.get $hwnd))))
                (return (i32.const 0))))))
        ;; VK_LEFT 0x25
        (if (i32.eq (local.get $vk) (i32.const 0x25))
          (then
            (if (local.get $cur)
              (then
                (if (local.get $b)
                  (then (local.set $cur (call $edit_word_start (local.get $state_w)
                          (i32.sub (local.get $cur) (i32.const 1)))))
                  (else (local.set $cur (i32.sub (local.get $cur) (i32.const 1)))))
                (i32.store offset=12 (local.get $state_w) (local.get $cur))
                (if (i32.eqz (local.get $a))
                  (then (i32.store offset=16 (local.get $state_w) (local.get $cur))))
                (call $edit_invalidate_caret (local.get $hwnd))))
            (return (i32.const 0))))
        ;; VK_RIGHT 0x27
        (if (i32.eq (local.get $vk) (i32.const 0x27))
          (then
            (if (i32.lt_u (local.get $cur) (local.get $text_len))
              (then
                (if (local.get $b)
                  (then (local.set $cur (call $edit_word_end (local.get $state_w)
                          (i32.add (local.get $cur) (i32.const 1)))))
                  (else (local.set $cur (i32.add (local.get $cur) (i32.const 1)))))
                (i32.store offset=12 (local.get $state_w) (local.get $cur))
                (if (i32.eqz (local.get $a))
                  (then (i32.store offset=16 (local.get $state_w) (local.get $cur))))
                (call $edit_invalidate_caret (local.get $hwnd))))
            (return (i32.const 0))))
        ;; VK_HOME 0x24 — start of line (or start of text with Ctrl)
        (if (i32.eq (local.get $vk) (i32.const 0x24))
          (then
            (if (local.get $b)
              (then (local.set $cur (i32.const 0)))
              (else (local.set $cur (call $edit_line_start (local.get $state_w) (local.get $cur)))))
            (i32.store offset=12 (local.get $state_w) (local.get $cur))
            (if (i32.eqz (local.get $a))
              (then (i32.store offset=16 (local.get $state_w) (local.get $cur))))
            (call $edit_invalidate_caret (local.get $hwnd))
            (return (i32.const 0))))
        ;; VK_END 0x23 — end of line (or end of text with Ctrl)
        (if (i32.eq (local.get $vk) (i32.const 0x23))
          (then
            (if (local.get $b)
              (then (local.set $cur (local.get $text_len)))
              (else
                (local.set $lo (call $edit_line_start (local.get $state_w) (local.get $cur)))
                (local.set $cur (i32.add (local.get $lo)
                  (call $edit_line_len (local.get $state_w) (local.get $lo))))))
            (i32.store offset=12 (local.get $state_w) (local.get $cur))
            (if (i32.eqz (local.get $a))
              (then (i32.store offset=16 (local.get $state_w) (local.get $cur))))
            (call $edit_invalidate_caret (local.get $hwnd))
            (return (i32.const 0))))
        ;; VK_BACK 0x08 — backspace. Browsers don't fire keypress for VK_BACK,
        ;; so WM_CHAR 0x08 never arrives for WAT-native edits; handle it here.
        (if (i32.eq (local.get $vk) (i32.const 0x08))
          (then
            (if (i32.and (i32.load offset=24 (local.get $state_w)) (i32.const 0x04))
              (then (return (i32.const 0))))
            (local.set $lo (call $edit_sel_lo (local.get $state_w)))
            (local.set $hi (call $edit_sel_hi (local.get $state_w)))
            (if (i32.ne (local.get $lo) (local.get $hi))
              (then (call $edit_delete_range (local.get $state_w) (local.get $lo) (local.get $hi)))
              (else
                (if (local.get $cur)
                  (then (call $edit_delete_range (local.get $state_w)
                          (i32.sub (local.get $cur) (i32.const 1))
                          (local.get $cur))))))
            (call $edit_notify_change (local.get $hwnd))
            (call $edit_invalidate_caret (local.get $hwnd))
            (return (i32.const 0))))
        ;; VK_DELETE 0x2E
        (if (i32.eq (local.get $vk) (i32.const 0x2E))
          (then
            (if (i32.and (i32.load offset=24 (local.get $state_w)) (i32.const 0x04))
              (then (return (i32.const 0))))
            (local.set $lo (call $edit_sel_lo (local.get $state_w)))
            (local.set $hi (call $edit_sel_hi (local.get $state_w)))
            (if (i32.ne (local.get $lo) (local.get $hi))
              (then (call $edit_delete_range (local.get $state_w) (local.get $lo) (local.get $hi)))
              (else
                (if (i32.lt_u (local.get $cur) (local.get $text_len))
                  (then (call $edit_delete_range (local.get $state_w)
                          (local.get $cur)
                          (i32.add (local.get $cur) (i32.const 1)))))))
            (call $edit_notify_change (local.get $hwnd))
            (call $edit_invalidate_caret (local.get $hwnd))
            (return (i32.const 0))))
        ;; VK_UP 0x26
        (if (i32.eq (local.get $vk) (i32.const 0x26))
          (then
            (local.set $lo (call $edit_line_start (local.get $state_w) (local.get $cur)))
            (if (local.get $lo)  ;; not on first line
              (then
                ;; col = cur - line_start
                (local.set $hi (i32.sub (local.get $cur) (local.get $lo)))
                ;; find start of previous line
                (local.set $lo (call $edit_line_start (local.get $state_w) (i32.sub (local.get $lo) (i32.const 1))))
                ;; prev line length
                (local.set $px (call $edit_line_len (local.get $state_w) (local.get $lo)))
                ;; clamp col to prev line length
                (if (i32.gt_u (local.get $hi) (local.get $px))
                  (then (local.set $hi (local.get $px))))
                (local.set $cur (i32.add (local.get $lo) (local.get $hi)))
                (i32.store offset=12 (local.get $state_w) (local.get $cur))
                (if (i32.eqz (local.get $a))
                  (then (i32.store offset=16 (local.get $state_w) (local.get $cur))))
                (call $edit_invalidate_caret (local.get $hwnd))))
            (return (i32.const 0))))
        ;; VK_DOWN 0x28
        (if (i32.eq (local.get $vk) (i32.const 0x28))
          (then
            ;; col = cur - line_start
            (local.set $lo (call $edit_line_start (local.get $state_w) (local.get $cur)))
            (local.set $hi (i32.sub (local.get $cur) (local.get $lo)))
            ;; find end of current line (next \n or text_len)
            (local.set $px (i32.add (local.get $lo) (call $edit_line_len (local.get $state_w) (local.get $lo))))
            (if (i32.lt_u (local.get $px) (local.get $text_len))
              (then
                ;; next line starts after the \n
                (local.set $lo (i32.add (local.get $px) (i32.const 1)))
                ;; next line length
                (local.set $px (call $edit_line_len (local.get $state_w) (local.get $lo)))
                ;; clamp col
                (if (i32.gt_u (local.get $hi) (local.get $px))
                  (then (local.set $hi (local.get $px))))
                (local.set $cur (i32.add (local.get $lo) (local.get $hi)))
                (i32.store offset=12 (local.get $state_w) (local.get $cur))
                (if (i32.eqz (local.get $a))
                  (then (i32.store offset=16 (local.get $state_w) (local.get $cur))))
                (call $edit_invalidate_caret (local.get $hwnd))))
            (return (i32.const 0))))
        (return (i32.const 0))))

    ;; ---------- WM_LBUTTONDOWN (0x0201) / WM_LBUTTONDBLCLK (0x0203) ----------
    ;; Click: hit-test via $edit_xy_to_offset, move cursor there. Shift-held
    ;; keeps the anchor (extends selection); plain click collapses both.
    ;; Double-click selects the word under the cursor. lParam = x | y<<16.
    (if (i32.or (i32.eq (local.get $msg) (i32.const 0x0201))
                (i32.eq (local.get $msg) (i32.const 0x0203)))
      (then
        ;; Focus transfer: mirror SetFocus's WM_KILLFOCUS to the previous
        ;; focus window. Without this, the old edit keeps its 0x08 focus
        ;; flag and keeps drawing a caret after the user clicks another
        ;; control. WAT-native wndprocs dispatch synchronously; x86 ones
        ;; fall back to the post queue (matches $handle_SetFocus).
        (if (i32.and (i32.ne (global.get $focus_hwnd) (local.get $hwnd))
                     (i32.ne (global.get $focus_hwnd) (i32.const 0)))
          (then
            (if (i32.ge_u (call $wnd_table_get (global.get $focus_hwnd))
                          (i32.const 0xFFFF0000))
              (then (drop (call $wat_wndproc_dispatch
                      (global.get $focus_hwnd) (i32.const 0x0008)
                      (local.get $hwnd) (i32.const 0))))
              (else (drop (call $post_queue_push
                      (global.get $focus_hwnd) (i32.const 0x0008)
                      (local.get $hwnd) (i32.const 0)))))))
        (global.set $focus_hwnd (local.get $hwnd))
        ;; Grab mouse capture so the renderer routes WM_MOUSEMOVE here
        ;; with MK_LBUTTON while the user drags — needed for selection
        ;; extension. Released on WM_LBUTTONUP below.
        (global.set $capture_hwnd (local.get $hwnd))
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        ;; Mark focused + drag-tracking bit 4 (0x10).
        (i32.store offset=24 (local.get $state_w)
          (i32.or (i32.load offset=24 (local.get $state_w)) (i32.const 0x18)))
        (call $edit_reset_caret_timer (local.get $hwnd) (local.get $state_w))
	        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
	        (local.set $w (i32.shr_s (i32.shl (local.get $lParam) (i32.const 16)) (i32.const 16)))
	        (local.set $h (i32.shr_s (local.get $lParam) (i32.const 16)))
	        (if (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00200000))
	          (then
	            (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
	            (local.set $full_w (i32.and (local.get $sz) (i32.const 0xFFFF)))
	            (local.set $line_y (i32.shr_u (local.get $sz) (i32.const 16)))
	            ;; Inside the vertical strip: classify with the same geometry
	            ;; $defwndproc_paint_standard_scrollbar painted it with, so a
	            ;; press on the thumb the user can see starts a drag rather than
	            ;; a page. This used to be a fourth private copy of the thumb
	            ;; arithmetic, which sized the thumb at 16px while the painter
	            ;; sized it by nPage -- so most of the visible thumb paged.
	            (if (i32.ge_s (local.get $w) (i32.sub (local.get $full_w) (i32.const 16)))
	              (then
	                (local.set $a (call $edit_view_metrics (local.get $hwnd) (local.get $state_w)))
	                (local.set $total_lines (i32.and (local.get $a) (i32.const 0xFFFF)))
	                (local.set $visible_lines (i32.shr_u (local.get $a) (i32.const 16)))
	                (local.set $lo (i32.load offset=20 (local.get $state_w)))
	                (local.set $b (call $sb_page_hit_part
	                  (local.get $line_y) (local.get $h) (local.get $lo)
	                  (i32.const 0) (i32.sub (local.get $total_lines) (i32.const 1))
	                  (local.get $visible_lines)))
	                (if (i32.eq (local.get $b) (i32.const 1))
	                  (then (drop (call $edit_scroll_to (local.get $hwnd) (local.get $state_w)
	                    (i32.sub (local.get $lo) (i32.const 1))
	                    (local.get $total_lines) (local.get $visible_lines)))))
	                (if (i32.eq (local.get $b) (i32.const 2))
	                  (then (drop (call $edit_scroll_to (local.get $hwnd) (local.get $state_w)
	                    (i32.add (local.get $lo) (i32.const 1))
	                    (local.get $total_lines) (local.get $visible_lines)))))
	                (if (i32.eq (local.get $b) (i32.const 3))
	                  (then (drop (call $edit_scroll_to (local.get $hwnd) (local.get $state_w)
	                    (i32.sub (local.get $lo) (local.get $visible_lines))
	                    (local.get $total_lines) (local.get $visible_lines)))))
	                (if (i32.eq (local.get $b) (i32.const 4))
	                  (then (drop (call $edit_scroll_to (local.get $hwnd) (local.get $state_w)
	                    (i32.add (local.get $lo) (local.get $visible_lines))
	                    (local.get $total_lines) (local.get $visible_lines)))))
	                (if (i32.eq (local.get $b) (i32.const 5))
	                  (then
	                    (global.set $edit_sb_drag_anchor_y (local.get $h))
	                    (global.set $edit_sb_drag_anchor_top (local.get $lo))))
	                (if (local.get $b)
	                  (then
	                    (global.set $sb_pressed_hwnd (local.get $hwnd))
	                    (global.set $sb_pressed_part (local.get $b))))
	                ;; A press on the scrollbar is not the start of a text
	                ;; selection. WM_LBUTTONDOWN arms tracking bit 0x10 before it
	                ;; knows where the click landed, so clear it here or every
	                ;; following WM_MOUSEMOVE extends a selection while the user
	                ;; is only dragging the thumb.
	                (i32.store offset=24 (local.get $state_w)
	                  (i32.and (i32.load offset=24 (local.get $state_w)) (i32.const 0xFFFFFFEF)))
	                (drop (call $wnd_send_message
	                  (local.get $hwnd) (i32.const 0x000F) (i32.const 0) (i32.const 0)))
	                (call $invalidate_hwnd (local.get $hwnd))
	                (return (i32.const 0))))))
	        (if (i32.and
	              (i32.ne (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00200000)) (i32.const 0))
	              (i32.eqz (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00000080))))
	          (then
	            (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
	            (local.set $cur (call $edit_layout_xy_to_offset
	              (local.get $state_w) (local.get $hdc)
	              (i32.sub (i32.and (local.get $sz) (i32.const 0xFFFF)) (i32.const 16))
	              (local.get $w) (local.get $h))))
	          (else
	            (local.set $cur (call $edit_xy_to_offset
	              (local.get $state_w) (local.get $hdc) (local.get $w) (local.get $h)))))
        (if (i32.eq (local.get $msg) (i32.const 0x0203))
          (then
            ;; Double-click: select word spanning $cur
            (local.set $lo (call $edit_word_start (local.get $state_w) (local.get $cur)))
            (local.set $hi (call $edit_word_end (local.get $state_w) (local.get $cur)))
            (i32.store offset=16 (local.get $state_w) (local.get $lo))
            (i32.store offset=12 (local.get $state_w) (local.get $hi)))
          (else
            (i32.store offset=12 (local.get $state_w) (local.get $cur))
            ;; Only collapse anchor when Shift is NOT held (extends existing selection).
            (if (i32.eqz (call $edit_shift_down))
              (then (i32.store offset=16 (local.get $state_w) (local.get $cur))))))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 0))))

    ;; ---------- WM_MOUSEMOVE (0x0200) ----------
    ;; Extend selection while the left button is held (tracking bit 0x10
    ;; set by LBUTTONDOWN). MK_LBUTTON in wParam confirms the button is
    ;; actually down — guards against stray moves after a button-up we
    ;; didn't see.
    (if (i32.eq (local.get $msg) (i32.const 0x0200))
      (then
	        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
	        (local.set $state_w (call $g2w (local.get $state)))
	        (if (i32.and (i32.eq (global.get $sb_pressed_hwnd) (local.get $hwnd))
	                     (i32.eq (global.get $sb_pressed_part) (i32.const 5)))
	          (then
	            (if (i32.eqz (i32.and (local.get $wParam) (i32.const 0x0001)))
	              (then
	                (global.set $sb_pressed_hwnd (i32.const 0))
	                (global.set $sb_pressed_part (i32.const 0))
	                (if (i32.eq (global.get $capture_hwnd) (local.get $hwnd))
	                  (then (global.set $capture_hwnd (i32.const 0))))
	                (return (i32.const 0))))
	            ;; Thumb drag through the shared geometry, so the thumb tracks
	            ;; the pointer instead of the private 16px thumb this used to
	            ;; assume while the painter drew one sized by nPage.
	            (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
	            (local.set $line_y (i32.shr_u (local.get $sz) (i32.const 16)))
	            (local.set $h (i32.shr_s (local.get $lParam) (i32.const 16)))
	            (local.set $a (call $edit_view_metrics (local.get $hwnd) (local.get $state_w)))
	            (local.set $total_lines (i32.and (local.get $a) (i32.const 0xFFFF)))
	            (local.set $visible_lines (i32.shr_u (local.get $a) (i32.const 16)))
	            (drop (call $edit_scroll_to (local.get $hwnd) (local.get $state_w)
	              (call $sb_page_drag_pos
	                (local.get $line_y) (local.get $h)
	                (global.get $edit_sb_drag_anchor_y) (global.get $edit_sb_drag_anchor_top)
	                (i32.const 0) (i32.sub (local.get $total_lines) (i32.const 1))
	                (local.get $visible_lines))
	              (local.get $total_lines) (local.get $visible_lines)))
	            (call $invalidate_hwnd (local.get $hwnd))
	            (return (i32.const 0))))
	        (local.set $flags (i32.load offset=24 (local.get $state_w)))
        (if (i32.eqz (i32.and (local.get $flags) (i32.const 0x10)))
          (then (return (i32.const 0))))
        (if (i32.eqz (i32.and (local.get $wParam) (i32.const 0x0001)))
          (then
            ;; Lost the button without a WM_LBUTTONUP — clear drag flag.
            (i32.store offset=24 (local.get $state_w)
              (i32.and (local.get $flags) (i32.const 0xFFFFFFEF)))
            (return (i32.const 0))))
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        (local.set $w (i32.shr_s (i32.shl (local.get $lParam) (i32.const 16)) (i32.const 16)))
        (local.set $h (i32.shr_s (local.get $lParam) (i32.const 16)))
        (if (i32.and
              (i32.ne (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00200000)) (i32.const 0))
              (i32.eqz (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00000080))))
          (then
            (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
            (local.set $cur (call $edit_layout_xy_to_offset
              (local.get $state_w) (local.get $hdc)
              (i32.sub (i32.and (local.get $sz) (i32.const 0xFFFF)) (i32.const 16))
              (local.get $w) (local.get $h))))
          (else
            (local.set $cur (call $edit_xy_to_offset
              (local.get $state_w) (local.get $hdc) (local.get $w) (local.get $h)))))
        (if (i32.ne (local.get $cur) (i32.load offset=12 (local.get $state_w)))
          (then
            (i32.store offset=12 (local.get $state_w) (local.get $cur))
            (call $invalidate_hwnd (local.get $hwnd))))
        (return (i32.const 0))))

    ;; ---------- WM_LBUTTONUP (0x0202) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0202))
      (then
	        (if (local.get $state)
	          (then
	            (local.set $state_w (call $g2w (local.get $state)))
	            (i32.store offset=24 (local.get $state_w)
	              (i32.and (i32.load offset=24 (local.get $state_w)) (i32.const 0xFFFFFFEF)))))
	        (if (i32.eq (global.get $sb_pressed_hwnd) (local.get $hwnd))
	          (then
	            (global.set $sb_pressed_hwnd (i32.const 0))
	            (global.set $sb_pressed_part (i32.const 0))
	            (call $invalidate_hwnd (local.get $hwnd))))
	        ;; Release capture grabbed on WM_LBUTTONDOWN.
        (if (i32.eq (global.get $capture_hwnd) (local.get $hwnd))
          (then (global.set $capture_hwnd (i32.const 0))))
        (return (i32.const 0))))

    ;; ---------- WM_PAINT (0x000F) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        ;; Paint commits a text object by asking its EDIT to render into the
        ;; picture memory DC via SendMessage(WM_PAINT, hdc, 0). Honor that
        ;; Win9x control convention; ordinary paints still use the window DC.
        (local.set $hdc
          (select (local.get $wParam)
                  (i32.add (local.get $hwnd) (i32.const 0x40000))
                  (i32.ne (local.get $wParam) (i32.const 0))))
        ;; Native control paints don't call BeginPaint, so establish the
        ;; child-client clip explicitly before drawing wrapped/scrolling text.
        ;; Preserve an explicitly supplied DC's clip and viewport: its caller
        ;; owns both and may have translated them into a backing bitmap.
        (if (i32.eqz (local.get $wParam))
          (then
            (drop (call $host_gdi_select_clip_rgn (local.get $hdc) (i32.const 0)))
            (call $dc_apply_client_clip (local.get $hdc) (local.get $hwnd))))
        ;; ctrl_get_wh_packed reads CONTROL_GEOM (works for WAT-only children
        ;; that have no JS-side window record).
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        (local.set $full_w (local.get $w))
        ;; Reserve the right strip for multiline edits created with WS_VSCROLL.
        (if (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00200000))
          (then
            (if (i32.gt_u (local.get $w) (i32.const 16))
              (then (local.set $w (i32.sub (local.get $w) (i32.const 16)))))))
        ;; And the bottom strip for WS_HSCROLL. Without this the last row of
        ;; text and its caret are drawn underneath the horizontal scrollbar,
        ;; which only became visible once the caret could reach the last row.
        (if (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00100000))
          (then
            (if (i32.gt_u (local.get $h) (i32.const 16))
              (then (local.set $h (i32.sub (local.get $h) (i32.const 16)))))))
        ;; Use the font installed with WM_SETFONT, falling back to the default
        ;; GUI font. Paint relies on this when committing its text object into
        ;; the picture memory DC.
        (drop (call $host_gdi_select_object
          (local.get $hdc)
          (select
            (i32.load offset=32 (local.get $state_w))
            (i32.const 0x30021)
            (i32.ne (i32.load offset=32 (local.get $state_w)) (i32.const 0)))))
        (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))
        ;; 1) White background (WHITE_BRUSH stock obj 0 = 0x30010)
        (drop (call $host_gdi_fill_rect (local.get $hdc)
                (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
                (i32.const 0x30010)))
        ;; 2) Sunken edge: BDR_SUNKENOUTER(0x02)|BDR_SUNKENINNER(0x08) = 0x0A; BF_RECT = 0x0F
        (if (i32.eqz (local.get $wParam))
          (then
            (drop (call $host_gdi_draw_edge (local.get $hdc)
                    (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
                    (i32.const 0x0A) (i32.const 0x0F)))))
        ;; 3) Text — draw line by line, splitting on \n. Each line is split
        ;; into up to three segments (pre-sel / sel / post-sel) so selected
        ;; text renders white-on-blue while unselected text stays black.
        (local.set $buf (i32.load (local.get $state_w)))
        (local.set $text_len (i32.load offset=4 (local.get $state_w)))
        (local.set $sel_lo (call $edit_sel_lo (local.get $state_w)))
        (local.set $sel_hi (call $edit_sel_hi (local.get $state_w)))
        ;; Multiline edits with a vertical scrollbar and no ES_AUTOHSCROLL
        ;; behave like RichEdit license viewers: word-wrap text inside the
        ;; client rect.
        (if (i32.and
              (i32.ne (local.get $buf) (i32.const 0))
              (i32.and
                (i32.ne
                  (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00200000))
                  (i32.const 0))
                (i32.eqz (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00000080)))))
          (then
            (local.set $total_lines
              (call $edit_layout_build
                (local.get $state_w) (local.get $hdc) (local.get $w)))
            (local.set $visible_lines (i32.div_u
              (select (i32.sub (local.get $h) (i32.const 8)) (i32.const 1)
                      (i32.gt_u (local.get $h) (i32.const 8)))
              (i32.const 16)))
            (if (i32.eqz (local.get $visible_lines))
              (then (local.set $visible_lines (i32.const 1))))
            (local.set $max_scroll (i32.sub (local.get $total_lines) (local.get $visible_lines)))
            (if (i32.lt_s (local.get $max_scroll) (i32.const 0))
              (then (local.set $max_scroll (i32.const 0))))
            (if (i32.gt_s (i32.load offset=20 (local.get $state_w)) (local.get $max_scroll))
              (then (i32.store offset=20 (local.get $state_w) (local.get $max_scroll))))
            (local.set $lo (i32.load offset=20 (local.get $state_w)))
            (local.set $line_y (i32.const 4))
            (block $wrapped_done (loop $wrapped_loop
              (br_if $wrapped_done (i32.ge_u (local.get $lo) (local.get $total_lines)))
              (br_if $wrapped_done (i32.ge_s (local.get $line_y) (local.get $h)))
              (local.set $line_buf_w (call $edit_layout_start (local.get $lo)))
              (local.set $hi (call $edit_layout_len (local.get $lo)))
              (local.set $line_end (i32.add (local.get $line_buf_w) (local.get $hi)))
              (local.set $a (i32.const 0))
              (local.set $b (i32.const 0))
              (if (i32.and (i32.lt_u (local.get $sel_lo) (local.get $sel_hi))
                           (i32.and (i32.le_u (local.get $sel_lo) (local.get $line_end))
                                    (i32.ge_u (local.get $sel_hi) (local.get $line_buf_w))))
                (then
                  (local.set $a (local.get $sel_lo))
                  (if (i32.lt_u (local.get $a) (local.get $line_buf_w))
                    (then (local.set $a (local.get $line_buf_w))))
                  (local.set $a (i32.sub (local.get $a) (local.get $line_buf_w)))
                  (local.set $b (local.get $sel_hi))
                  (if (i32.gt_u (local.get $b) (local.get $line_end))
                    (then (local.set $b (local.get $line_end))))
                  (local.set $b (i32.sub (local.get $b) (local.get $line_buf_w)))))
              (local.set $line_buf_w (i32.add (call $g2w (local.get $buf)) (local.get $line_buf_w)))
              (if (i32.lt_u (local.get $a) (local.get $b))
                (then
                  (local.set $pre_w (i32.const 0))
                  (if (local.get $a)
                    (then (local.set $pre_w
                      (call $host_measure_text (local.get $hdc) (local.get $line_buf_w)
                        (local.get $a) (i32.const 0)))))
                  (local.set $sel_w (i32.sub
                    (call $host_measure_text (local.get $hdc) (local.get $line_buf_w)
                      (local.get $b) (i32.const 0))
                    (local.get $pre_w)))
                  (if (i32.eqz (local.get $sel_w))
                    (then (local.set $sel_w (i32.mul (i32.sub (local.get $b) (local.get $a)) (i32.const 8)))))
                  (local.set $brush (call $host_gdi_create_solid_brush (i32.const 0x00800000)))
                  (drop (call $host_gdi_fill_rect (local.get $hdc)
                          (i32.add (local.get $pre_w) (i32.const 4))
                          (i32.sub (local.get $line_y) (i32.const 2))
                          (i32.add (i32.add (local.get $pre_w) (local.get $sel_w)) (i32.const 4))
                          (i32.add (local.get $line_y) (i32.const 13))
                          (local.get $brush)))
                  (drop (call $host_gdi_delete_object (local.get $brush)))
                  (if (local.get $a)
                    (then (drop (call $host_gdi_text_out
                      (local.get $hdc) (i32.const 4) (local.get $line_y)
                      (local.get $line_buf_w) (local.get $a) (i32.const 0)))))
                  (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x00FFFFFF)))
                  (drop (call $host_gdi_text_out
                    (local.get $hdc) (i32.add (local.get $pre_w) (i32.const 4)) (local.get $line_y)
                    (i32.add (local.get $line_buf_w) (local.get $a))
                    (i32.sub (local.get $b) (local.get $a)) (i32.const 0)))
                  (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x00000000)))
                  (if (i32.lt_u (local.get $b) (local.get $hi))
                    (then (drop (call $host_gdi_text_out
                      (local.get $hdc)
                      (i32.add (i32.add (local.get $pre_w) (local.get $sel_w)) (i32.const 4))
                      (local.get $line_y)
                      (i32.add (local.get $line_buf_w) (local.get $b))
                      (i32.sub (local.get $hi) (local.get $b)) (i32.const 0))))))
                (else
                  (if (local.get $hi)
                    (then (drop (call $host_gdi_text_out
                      (local.get $hdc) (i32.const 4) (local.get $line_y)
                      (local.get $line_buf_w) (local.get $hi) (i32.const 0)))))))
              (local.set $lo (i32.add (local.get $lo) (i32.const 1)))
              (local.set $line_y (i32.add (local.get $line_y) (i32.const 16)))
              (br $wrapped_loop)))

            (local.set $flags (i32.load offset=24 (local.get $state_w)))
            (if (i32.eq
                  (i32.and (local.get $flags) (i32.const 0x28))
                  (i32.const 0x28))
              (then
                (local.set $cur (i32.load offset=12 (local.get $state_w)))
                (local.set $lo (call $edit_layout_line_for_char (local.get $total_lines) (local.get $cur)))
                (local.set $a (i32.sub (local.get $lo) (i32.load offset=20 (local.get $state_w))))
                (local.set $hi (i32.mul (local.get $a) (i32.const 16)))
                (local.set $px (i32.const 0))
                (local.set $line_end (call $edit_layout_start (local.get $lo)))
                (if (i32.gt_u (local.get $cur) (local.get $line_end))
                  (then
                    (local.set $px (call $host_measure_text
                      (local.get $hdc)
                      (i32.add (call $g2w (local.get $buf)) (local.get $line_end))
                      (i32.sub (local.get $cur) (local.get $line_end))
                      (i32.const 0)))))
                (if (i32.and (i32.eqz (local.get $px)) (i32.gt_u (local.get $cur) (local.get $line_end)))
                  (then
                    (local.set $px
                      (i32.mul (i32.sub (local.get $cur) (local.get $line_end)) (i32.const 8)))))
                (if (i32.and
                      (i32.ge_s (local.get $a) (i32.const 0))
                      (i32.lt_s (local.get $hi) (local.get $h)))
                  (then
                    (drop (call $host_gdi_fill_rect (local.get $hdc)
                            (i32.add (local.get $px) (i32.const 4))
                            (i32.add (local.get $hi) (i32.const 2))
                            (i32.add (local.get $px) (i32.const 6))
                            (i32.add (local.get $hi) (i32.const 17))
                            (i32.const 0x30014)))))))
            (if (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00200000))
              (then
                (call $paint_vscrollbar_rect (local.get $hdc)
                  (i32.sub (local.get $full_w) (i32.const 16)) (i32.const 0)
                  (i32.const 16) (local.get $h)
                  (i32.load offset=20 (local.get $state_w)) (local.get $max_scroll)
                  (select (global.get $sb_pressed_part) (i32.const 0)
                          (i32.eq (global.get $sb_pressed_hwnd) (local.get $hwnd))))))
            ;; Refresh non-client chrome after the edit reaches its final
            ;; size. Notepad does not send another WM_NCPAINT after sizing its
            ;; child, and client clipping intentionally excludes these strips.
            (if (i32.and
                  (i32.eqz (local.get $wParam))
                  (i32.ne
                    (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00300000))
                    (i32.const 0)))
              (then (call $defwndproc_do_ncpaint (local.get $hwnd))))
            (return (i32.const 0))))
        (if (local.get $buf)
          (then
            ;; Start at the scroll_top line (multi-line scroll). scroll_top is
            ;; 0 for single-line and by default for multi-line.
            (local.set $lo (call $edit_line_index (local.get $state_w)
                             (i32.load offset=20 (local.get $state_w))))
            (local.set $line_y (i32.const 4))
            (block $lines_done (loop $line_loop
              (br_if $lines_done (i32.gt_u (local.get $lo) (local.get $text_len)))
              (local.set $hi (call $edit_line_len (local.get $state_w) (local.get $lo)))
              (local.set $line_end (i32.add (local.get $lo) (local.get $hi)))
              (local.set $line_buf_w (i32.add (call $g2w (local.get $buf)) (local.get $lo)))
              ;; Selection intersection within this line (relative to line start).
              (local.set $a (i32.const 0))
              (local.set $b (i32.const 0))
              (if (i32.and (i32.lt_u (local.get $sel_lo) (local.get $sel_hi))
                           (i32.and (i32.le_u (local.get $sel_lo) (local.get $line_end))
                                    (i32.ge_u (local.get $sel_hi) (local.get $lo))))
                (then
                  (local.set $a (local.get $sel_lo))
                  (if (i32.lt_u (local.get $a) (local.get $lo)) (then (local.set $a (local.get $lo))))
                  (local.set $a (i32.sub (local.get $a) (local.get $lo)))
                  (local.set $b (local.get $sel_hi))
                  (if (i32.gt_u (local.get $b) (local.get $line_end)) (then (local.set $b (local.get $line_end))))
                  (local.set $b (i32.sub (local.get $b) (local.get $lo)))))
              (if (i32.lt_u (local.get $a) (local.get $b))
                (then
                  ;; Highlight rect: measure widths up to $a and up to $b.
                  (local.set $pre_w (i32.const 0))
                  (if (local.get $a)
                    (then (local.set $pre_w (call $host_measure_text
                            (local.get $hdc) (local.get $line_buf_w)
                            (local.get $a) (i32.const 0)))))
                  (local.set $sel_w (i32.sub
                    (call $host_measure_text (local.get $hdc) (local.get $line_buf_w)
                      (local.get $b) (i32.const 0))
                    (local.get $pre_w)))
                  ;; If sel extends past the \n (to the next line), pad to right edge.
                  (if (i32.gt_u (local.get $sel_hi) (local.get $line_end))
                    (then (local.set $sel_w (i32.sub (local.get $w)
                            (i32.add (local.get $pre_w) (i32.const 4))))))
                  (local.set $brush (call $host_gdi_create_solid_brush (i32.const 0x00800000)))
	                  (drop (call $host_gdi_fill_rect (local.get $hdc)
	                          (i32.add (local.get $pre_w) (i32.const 4))
	                          (i32.sub (local.get $line_y) (i32.const 2))
	                          (i32.add (i32.add (local.get $pre_w) (local.get $sel_w)) (i32.const 4))
	                          (i32.add (local.get $line_y) (i32.const 13))
	                          (local.get $brush)))
                  (drop (call $host_gdi_delete_object (local.get $brush)))
                  ;; pre-sel text (black)
                  (if (local.get $a)
                    (then (drop (call $host_gdi_text_out (local.get $hdc)
                                  (i32.const 4) (local.get $line_y)
                                  (local.get $line_buf_w) (local.get $a) (i32.const 0)))))
                  ;; selected text (white)
                  (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x00FFFFFF)))
                  (drop (call $host_gdi_text_out (local.get $hdc)
                          (i32.add (local.get $pre_w) (i32.const 4)) (local.get $line_y)
                          (i32.add (local.get $line_buf_w) (local.get $a))
                          (i32.sub (local.get $b) (local.get $a)) (i32.const 0)))
                  (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x00000000)))
                  ;; post-sel text (black)
                  (if (i32.lt_u (local.get $b) (local.get $hi))
                    (then (drop (call $host_gdi_text_out (local.get $hdc)
                                  (i32.add (i32.add (local.get $pre_w) (local.get $sel_w)) (i32.const 4))
                                  (local.get $line_y)
                                  (i32.add (local.get $line_buf_w) (local.get $b))
                                  (i32.sub (local.get $hi) (local.get $b)) (i32.const 0))))))
                (else
                  (if (local.get $hi)
                    (then (drop (call $host_gdi_text_out (local.get $hdc)
                                  (i32.const 4) (local.get $line_y)
                                  (local.get $line_buf_w) (local.get $hi) (i32.const 0)))))))
              (local.set $lo (i32.add (local.get $line_end) (i32.const 1)))
              (local.set $line_y (i32.add (local.get $line_y) (i32.const 16)))
              (br $line_loop)))))
        ;; 4) Caret (only if focused — bit 3 of flags)
        (local.set $flags (i32.load offset=24 (local.get $state_w)))
        (if (i32.eq
              (i32.and (local.get $flags) (i32.const 0x28))
              (i32.const 0x28))
          (then
            (local.set $cur (i32.load offset=12 (local.get $state_w)))
            ;; Find which line the cursor is on and the offset within that line.
            ;; Subtract scroll_top so the caret tracks the visible viewport.
            (local.set $lo (call $edit_line_start (local.get $state_w) (local.get $cur)))
            (local.set $a (i32.sub
                            (call $edit_line_from_char (local.get $state_w) (local.get $cur))
                            (i32.load offset=20 (local.get $state_w))))
            (local.set $hi (i32.mul (local.get $a) (i32.const 16)))
            (local.set $px (i32.const 0))
            (if (i32.and (i32.ne (local.get $buf) (i32.const 0)) (i32.gt_u (local.get $cur) (local.get $lo)))
              (then (local.set $px (call $host_measure_text (local.get $hdc)
                                        (i32.add (call $g2w (local.get $buf)) (local.get $lo))
                                        (i32.sub (local.get $cur) (local.get $lo))
                                        (i32.const 0)))))
            (if (i32.and (i32.eqz (local.get $px)) (i32.gt_u (local.get $cur) (local.get $lo)))
              (then (local.set $px
                (i32.mul (i32.sub (local.get $cur) (local.get $lo)) (i32.const 8)))))
            (if (i32.and
                  (i32.ge_s (local.get $a) (i32.const 0))
                  (i32.const 1))
              (then
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.add (local.get $px) (i32.const 4))
                    (i32.add (local.get $hi) (i32.const 2))
                    (i32.add (local.get $px) (i32.const 6))
                    (i32.add (local.get $hi) (i32.const 17))
                    (i32.const 0x30014))))))) ;; BLACK_BRUSH
        ;; 5) Optional vertical scrollbar strip. Scrolling state is line-based.
        (if (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00200000))
          (then
            (local.set $total_lines
              (i32.add (call $edit_line_from_char (local.get $state_w) (local.get $text_len))
                       (i32.const 1)))
            (local.set $visible_lines (i32.div_u
              (select (i32.sub (local.get $h) (i32.const 8)) (i32.const 1)
                      (i32.gt_u (local.get $h) (i32.const 8)))
              (i32.const 16)))
            (if (i32.eqz (local.get $visible_lines))
              (then (local.set $visible_lines (i32.const 1))))
            (local.set $max_scroll (i32.sub (local.get $total_lines) (local.get $visible_lines)))
            (if (i32.lt_s (local.get $max_scroll) (i32.const 0))
              (then (local.set $max_scroll (i32.const 0))))
            (call $paint_vscrollbar_rect (local.get $hdc)
              (i32.sub (local.get $full_w) (i32.const 16)) (i32.const 0)
              (i32.const 16) (local.get $h)
              (i32.load offset=20 (local.get $state_w)) (local.get $max_scroll)
              (select (global.get $sb_pressed_part) (i32.const 0)
                      (i32.eq (global.get $sb_pressed_hwnd) (local.get $hwnd))))))
        (if (i32.and
              (i32.eqz (local.get $wParam))
              (i32.ne
                (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00300000))
                (i32.const 0)))
          (then (call $defwndproc_do_ncpaint (local.get $hwnd))))
        (return (i32.const 0))))

    ;; ---------- EM_SETLIMITTEXT / EM_LIMITTEXT (0x00C5) ----------
    ;; wParam = max chars (0 → unlimited; semantics differ across versions —
    ;; we treat 0 as unlimited as the Win9x docs state). No return value.
    (if (i32.eq (local.get $msg) (i32.const 0x00C5))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $text_len (local.get $wParam))
        ;; For both RichEdit generations, zero selects the documented 64,000
        ;; compatibility limit. Plain EDIT retains the emulator's unlimited
        ;; zero sentinel.
        (if (i32.and
              (i32.eqz (local.get $text_len))
              (i32.or
                (i32.eq (call $ctrl_table_get_class (local.get $hwnd)) (i32.const 24))
                (i32.eq (call $ctrl_table_get_class (local.get $hwnd)) (i32.const 25))))
          (then (local.set $text_len (i32.const 64000))))
        (i32.store offset=28 (call $g2w (local.get $state)) (local.get $text_len))
        (return (i32.const 0))))

    ;; ---------- EM_GETLIMITTEXT (0x00D5) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x00D5))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (return (i32.load offset=28 (call $g2w (local.get $state))))))

    ;; ---------- RichEdit 2.0+ extended range/limit messages ----------
    ;; RichEdit 1.0 intentionally leaves these unsupported and continues to
    ;; expose EM_GETSEL/EM_SETSEL/EM_LIMITTEXT, which are shared with EDIT.
    (if (i32.and
          (i32.eq (call $ctrl_table_get_class (local.get $hwnd)) (i32.const 25))
          (i32.eq (local.get $msg) (i32.const 0x0434))) ;; EM_EXGETSEL
      (then
        (if (i32.or (i32.eqz (local.get $state)) (i32.eqz (local.get $lParam)))
          (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (call $gs32 (local.get $lParam) (call $edit_sel_lo (local.get $state_w)))
        (call $gs32 (i32.add (local.get $lParam) (i32.const 4))
          (call $edit_sel_hi (local.get $state_w)))
        (return (i32.const 0))))

    (if (i32.and
          (i32.eq (call $ctrl_table_get_class (local.get $hwnd)) (i32.const 25))
          (i32.eq (local.get $msg) (i32.const 0x0435))) ;; EM_EXLIMITTEXT
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $text_len (local.get $lParam))
        (if (i32.eqz (local.get $text_len))
          (then (local.set $text_len (i32.const 64000))))
        (i32.store offset=28 (call $g2w (local.get $state)) (local.get $text_len))
        (return (i32.const 0))))

    (if (i32.and
          (i32.eq (call $ctrl_table_get_class (local.get $hwnd)) (i32.const 25))
          (i32.eq (local.get $msg) (i32.const 0x0437))) ;; EM_EXSETSEL
      (then
        (if (i32.or (i32.eqz (local.get $state)) (i32.eqz (local.get $lParam)))
          (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $text_len (i32.load offset=4 (local.get $state_w)))
        (local.set $lo (call $gl32 (local.get $lParam)))
        (local.set $hi (call $gl32 (i32.add (local.get $lParam) (i32.const 4))))
        (if (i32.eq (local.get $lo) (i32.const -1))
          (then (local.set $lo (local.get $text_len))))
        (if (i32.eq (local.get $hi) (i32.const -1))
          (then (local.set $hi (local.get $text_len))))
        (if (i32.gt_u (local.get $lo) (local.get $text_len))
          (then (local.set $lo (local.get $text_len))))
        (if (i32.gt_u (local.get $hi) (local.get $text_len))
          (then (local.set $hi (local.get $text_len))))
        (i32.store offset=16 (local.get $state_w) (local.get $lo))
        (i32.store offset=12 (local.get $state_w) (local.get $hi))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (local.get $hi))))

    ;; ---------- EM_GETSEL (0x00B0) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x00B0))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $lo (call $edit_sel_lo (local.get $state_w)))
        (local.set $hi (call $edit_sel_hi (local.get $state_w)))
        (if (local.get $wParam)
          (then (call $gs32 (local.get $wParam) (local.get $lo))))
        (if (local.get $lParam)
          (then (call $gs32 (local.get $lParam) (local.get $hi))))
        (return (i32.or (i32.and (local.get $lo) (i32.const 0xFFFF))
                        (i32.shl (local.get $hi) (i32.const 16))))))

    ;; ---------- WM_COPY (0x0301) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0301))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (call $edit_copy_range (local.get $state_w)
          (call $edit_sel_lo (local.get $state_w))
          (call $edit_sel_hi (local.get $state_w)))
        (return (i32.const 0))))

    ;; ---------- WM_CUT (0x0300) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0300))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $lo (call $edit_sel_lo (local.get $state_w)))
        (local.set $hi (call $edit_sel_hi (local.get $state_w)))
        (call $edit_copy_range (local.get $state_w) (local.get $lo) (local.get $hi))
        (if (i32.eqz (i32.and (i32.load offset=24 (local.get $state_w)) (i32.const 0x04)))
          (then
            (call $edit_delete_range (local.get $state_w) (local.get $lo) (local.get $hi))
            (call $edit_notify_change (local.get $hwnd))
            (call $invalidate_hwnd (local.get $hwnd))))
        (return (i32.const 0))))

    ;; ---------- WM_PASTE (0x0302) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0302))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (if (i32.and (i32.load offset=24 (local.get $state_w)) (i32.const 0x04))
          (then (return (i32.const 0))))
        (if (global.get $clipboard_len)
          (then (call $edit_insert_bytes (local.get $state_w)
                  (global.get $clipboard_ptr) (global.get $clipboard_len))
                (call $edit_notify_change (local.get $hwnd))))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 0))))

    ;; ---------- WM_CLEAR (0x0303) — delete selection without copying ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0303))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (if (i32.and (i32.load offset=24 (local.get $state_w)) (i32.const 0x04))
          (then (return (i32.const 0))))
        (local.set $lo (call $edit_sel_lo (local.get $state_w)))
        (local.set $hi (call $edit_sel_hi (local.get $state_w)))
        (if (i32.ne (local.get $lo) (local.get $hi))
          (then
            (call $edit_delete_range (local.get $state_w) (local.get $lo) (local.get $hi))
            (call $edit_notify_change (local.get $hwnd))
            (call $invalidate_hwnd (local.get $hwnd))))
        (return (i32.const 0))))

    ;; ---------- EM_SETSEL (0x00B1) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x00B1))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $text_len (i32.load offset=4 (local.get $state_w)))
        ;; wParam = start, lParam = end (-1 = end of text)
        (local.set $lo (local.get $wParam))
        (local.set $hi (local.get $lParam))
        ;; EM_SETSEL(-1, 0) removes the current selection. Paint uses this
        ;; immediately before rendering the edit into its backing bitmap.
        (if (i32.eq (local.get $lo) (i32.const -1))
          (then
            (i32.store offset=16 (local.get $state_w) (local.get $text_len))
            (i32.store offset=12 (local.get $state_w) (local.get $text_len))
            (call $invalidate_hwnd (local.get $hwnd))
            (return (i32.const 0))))
        (if (i32.eq (local.get $hi) (i32.const -1))
          (then (local.set $hi (local.get $text_len))))
        (if (i32.gt_u (local.get $lo) (local.get $text_len))
          (then (local.set $lo (local.get $text_len))))
        (if (i32.gt_u (local.get $hi) (local.get $text_len))
          (then (local.set $hi (local.get $text_len))))
        (i32.store offset=16 (local.get $state_w) (local.get $lo))  ;; sel_anchor = start
        (i32.store offset=12 (local.get $state_w) (local.get $hi))  ;; cursor = end
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 0))))

    ;; ---------- EM_REPLACESEL (0x00C2) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x00C2))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        ;; Delete current selection
        (local.set $lo (call $edit_sel_lo (local.get $state_w)))
        (local.set $hi (call $edit_sel_hi (local.get $state_w)))
        (if (i32.ne (local.get $lo) (local.get $hi))
          (then (call $edit_delete_range (local.get $state_w) (local.get $lo) (local.get $hi))))
        ;; Insert replacement text char by char
        (if (local.get $lParam)
          (then
            (local.set $buf (call $g2w (local.get $lParam)))
            (block $done (loop $ins
              (local.set $vk (i32.load8_u (local.get $buf)))
              (br_if $done (i32.eqz (local.get $vk)))
              (call $edit_insert_char (local.get $state_w) (local.get $vk))
              (local.set $buf (i32.add (local.get $buf) (i32.const 1)))
              (br $ins)))))
        (i32.store offset=24 (local.get $state_w)
          (i32.or (i32.load offset=24 (local.get $state_w)) (i32.const 0x08)))
        (call $edit_reset_caret_timer (local.get $hwnd) (local.get $state_w))
        (call $edit_notify_change (local.get $hwnd))
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 0))))

    ;; ---------- EM_LINEFROMCHAR (0x00C9) ----------
    ;; wParam = char index (-1 = cursor). Returns 0-based line number.
    (if (i32.eq (local.get $msg) (i32.const 0x00C9))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $cur (local.get $wParam))
        (if (i32.eq (local.get $cur) (i32.const -1))
          (then (local.set $cur (i32.load offset=12 (local.get $state_w)))))
        (return (call $edit_line_from_char (local.get $state_w) (local.get $cur)))))

    ;; ---------- EM_LINEINDEX (0x00BB) ----------
    ;; wParam = line number (-1 = current line). Returns char index of line start.
    (if (i32.eq (local.get $msg) (i32.const 0x00BB))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $lo (local.get $wParam))
        (if (i32.eq (local.get $lo) (i32.const -1))
          (then (local.set $lo (call $edit_line_from_char (local.get $state_w)
                                 (i32.load offset=12 (local.get $state_w))))))
        (return (call $edit_line_index (local.get $state_w) (local.get $lo)))))

    ;; ---------- EM_GETLINECOUNT (0x00BA) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x00BA))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 1))))
        (local.set $state_w (call $g2w (local.get $state)))
        (return (i32.add (call $edit_line_from_char (local.get $state_w)
                           (i32.load offset=4 (local.get $state_w)))
                         (i32.const 1)))))

    ;; ---------- EM_LINELENGTH (0x00C1) ----------
    ;; wParam = char index. Returns length of line containing that char.
    (if (i32.eq (local.get $msg) (i32.const 0x00C1))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $lo (call $edit_line_start (local.get $state_w) (local.get $wParam)))
        (return (call $edit_line_len (local.get $state_w) (local.get $lo)))))

    ;; ---------- EM_SCROLLCARET (0x00B7) ----------
    ;; The EM_SETSEL + EM_SCROLLCARET pair is how an app (notepad's Find, for
    ;; one) brings a selection into view, so this has to do the scrolling that
    ;; EM_SETSEL deliberately does not.
    (if (i32.eq (local.get $msg) (i32.const 0x00B7))
      (then
        (if (call $edit_scroll_caret_into_view (local.get $hwnd))
          (then (call $invalidate_hwnd (local.get $hwnd))))
        (return (i32.const 0))))

    ;; ---------- EM_GETFIRSTVISIBLELINE (0x00CE) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x00CE))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (return (i32.load offset=20 (call $g2w (local.get $state))))))

    ;; ---------- WM_MOUSEWHEEL (0x020A) ----------
    ;; wParam hi-word = signed wheel delta (120 per notch, positive = scroll up).
    ;; Only multi-line edits (flags bit 0) scroll; otherwise no-op.
    (if (i32.eq (local.get $msg) (i32.const 0x020A))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (if (i32.eqz (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00000004)))
          (then (return (i32.const 0))))
        ;; lines_delta = -delta_raw / 40  (120/3 = 40 → 3 lines per notch)
        (local.set $vk (i32.div_s
                         (i32.sub (i32.const 0)
                           (i32.shr_s (local.get $wParam) (i32.const 16)))
                         (i32.const 40)))
        (local.set $text_len (i32.load offset=4 (local.get $state_w)))
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        (if (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00200000))
          (then
            (if (i32.gt_u (local.get $w) (i32.const 16))
              (then (local.set $w (i32.sub (local.get $w) (i32.const 16)))))))
        ;; visible_lines = max(1, (h - 8) / 16)
        (local.set $a (i32.div_u (i32.sub (local.get $h) (i32.const 8)) (i32.const 16)))
        (if (i32.eqz (local.get $a)) (then (local.set $a (i32.const 1))))
        (if (i32.and
              (i32.ne (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00200000)) (i32.const 0))
              (i32.eqz (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00000080))))
          (then
            (local.set $b (call $edit_layout_build
              (local.get $state_w) (i32.add (local.get $hwnd) (i32.const 0x40000))
              (local.get $w))))
          (else
            ;; total_lines = edit_line_from_char(text_len) + 1
            (local.set $b (i32.add (call $edit_line_from_char (local.get $state_w) (local.get $text_len))
                                   (i32.const 1)))))
        ;; max_scroll = max(0, total_lines - visible_lines)
        (local.set $lo (i32.sub (local.get $b) (local.get $a)))
        (if (i32.lt_s (local.get $lo) (i32.const 0)) (then (local.set $lo (i32.const 0))))
        ;; new_scroll = clamp(scroll_top + lines_delta, 0, max_scroll)
        (local.set $hi (i32.add (i32.load offset=20 (local.get $state_w)) (local.get $vk)))
        (if (i32.lt_s (local.get $hi) (i32.const 0)) (then (local.set $hi (i32.const 0))))
        (if (i32.gt_s (local.get $hi) (local.get $lo)) (then (local.set $hi (local.get $lo))))
        (if (i32.ne (local.get $hi) (i32.load offset=20 (local.get $state_w)))
          (then
            (i32.store offset=20 (local.get $state_w) (local.get $hi))
            (call $invalidate_hwnd (local.get $hwnd))))
        (return (i32.const 0))))

    ;; Default
    (i32.const 0)
  )

  ;; ---- Multiline edit helpers ----
  ;; Find start of line containing char at $pos. Scans backward for \n.
  (func $edit_line_start (param $state_w i32) (param $pos i32) (result i32)
    (local $buf_w i32) (local $i i32)
    (local.set $buf_w (i32.load (local.get $state_w)))
    (if (i32.eqz (local.get $buf_w)) (then (return (i32.const 0))))
    (local.set $buf_w (call $g2w (local.get $buf_w)))
    (local.set $i (local.get $pos))
    (block $done (loop $scan
      (br_if $done (i32.le_s (local.get $i) (i32.const 0)))
      (if (i32.eq (i32.load8_u (i32.add (local.get $buf_w) (i32.sub (local.get $i) (i32.const 1))))
                  (i32.const 0x0A))
        (then (return (local.get $i))))
      (local.set $i (i32.sub (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; Length of line starting at $line_start (chars until \n or end of text).
  (func $edit_line_len (param $state_w i32) (param $line_start i32) (result i32)
    (local $buf_w i32) (local $text_len i32) (local $i i32)
    (local.set $buf_w (i32.load (local.get $state_w)))
    (if (i32.eqz (local.get $buf_w)) (then (return (i32.const 0))))
    (local.set $buf_w (call $g2w (local.get $buf_w)))
    (local.set $text_len (i32.load offset=4 (local.get $state_w)))
    (local.set $i (local.get $line_start))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $text_len)))
      (br_if $done (i32.eq (i32.load8_u (i32.add (local.get $buf_w) (local.get $i)))
                           (i32.const 0x0A)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.sub (local.get $i) (local.get $line_start)))

  ;; Return 0-based line number containing char at $pos.
  (func $edit_line_from_char (param $state_w i32) (param $pos i32) (result i32)
    (local $buf_w i32) (local $i i32) (local $line i32)
    (local.set $buf_w (i32.load (local.get $state_w)))
    (if (i32.eqz (local.get $buf_w)) (then (return (i32.const 0))))
    (local.set $buf_w (call $g2w (local.get $buf_w)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $pos)))
      (if (i32.eq (i32.load8_u (i32.add (local.get $buf_w) (local.get $i))) (i32.const 0x0A))
        (then (local.set $line (i32.add (local.get $line) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $line))

  ;; Return char index of the first character on line $line_num (0-based).
  (func $edit_line_index (param $state_w i32) (param $line_num i32) (result i32)
    (local $buf_w i32) (local $text_len i32) (local $i i32) (local $line i32)
    (local.set $buf_w (i32.load (local.get $state_w)))
    (if (i32.eqz (local.get $buf_w)) (then (return (i32.const 0))))
    (local.set $buf_w (call $g2w (local.get $buf_w)))
    (local.set $text_len (i32.load offset=4 (local.get $state_w)))
    (if (i32.eqz (local.get $line_num)) (then (return (i32.const 0))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $text_len)))
      (if (i32.eq (i32.load8_u (i32.add (local.get $buf_w) (local.get $i))) (i32.const 0x0A))
        (then
          (local.set $line (i32.add (local.get $line) (i32.const 1)))
          (if (i32.eq (local.get $line) (local.get $line_num))
            (then (return (i32.add (local.get $i) (i32.const 1)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $text_len))

  ;; ============================================================
  ;; STEP 5 dormant additions: $wnd_send_message + $create_findreplace_dialog
  ;; ============================================================
  ;; Status: STEP 5 — dormant. The helpers below compile and are reachable
  ;; only by future code. $handle_FindTextA still calls $host_show_find_dialog,
  ;; the JS-side find dialog is unchanged, and the test gate is unaffected.
  ;; STEP 8 will (a) flip $handle_FindTextA to $create_findreplace_dialog,
  ;; (b) delete the JS path, and (c) rewire the test bridge.

  ;; Send a message to a window. Routes WAT-native wndprocs (wndproc >=
  ;; 0xFFFF0000) directly through $wat_wndproc_dispatch. For x86 wndprocs
  ;; the message is queued via the existing PostMessage queue (PostMessage
  ;; semantics, not synchronous SendMessage — return value is always 0).
  ;; True synchronous WAT->x86 SendMessage would require a nested $run
  ;; invocation; defer that until a consumer actually needs the return.
  (func $wnd_send_message
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $wp i32) (local $slot i32) (local $ctrl_class i32)
    (local $old_eip i32) (local $old_esp i32) (local $old_eax i32) (local $old_ecx i32) (local $old_edx i32)
    (local $old_ebx i32) (local $old_esi i32) (local $old_edi i32) (local $old_ebp i32)
    (local $old_handler_set_eip i32) (local $old_steps i32)
    (local $old_yield_reason i32) (local $old_yield_flag i32)
    (local $result i32) (local $edit_state i32) (local $edit_len_before i32)
    (local $sync_rounds i32)
    (local.set $wp (call $wnd_table_get (local.get $hwnd)))
    (if (i32.eqz (local.get $wp)) (then (return (i32.const 0))))
    (local.set $ctrl_class (call $ctrl_table_get_class (local.get $hwnd)))
    (if (call $tab_native_is (local.get $hwnd))
      (then
        (call $tab_native_note_message
          (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam))
        (if (i32.eq (local.get $msg) (i32.const 0x000F))
          (then (return (call $tab_native_paint (local.get $hwnd)))))))
    ;; A registered status bar keeps ctrl_class=0 so its guest wndproc can
    ;; perform MFC layout. Its shared-surface paint and WM_SETTEXT invalidation
    ;; are WAT-owned; otherwise Print Preview can leave the old prompt visible
    ;; after MFC changes the status title to "Page 1".
    (if (i32.and (call $statusbar_native_is (local.get $hwnd))
                 (i32.or
                   (i32.eq (local.get $msg) (i32.const 0x000F))
                   (i32.eq (local.get $msg) (i32.const 0x000C))))
      (then (return (call $statusbar_wndproc
        (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Keep the exported/test-driver path consistent with SendMessageA and
    ;; DispatchMessageA: WAT-owned controls paint through the native control
    ;; proc even if the app has subclassed the window.
    (if (i32.and (i32.ne (local.get $ctrl_class) (i32.const 0))
                 (i32.eq (local.get $msg) (i32.const 0x000F)))
      (then (return (call $control_wndproc_dispatch
        (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Do not bypass an app-installed EDIT subclass here. In particular,
    ;; Paint's CEdit wrapper consumes WM_CHAR before chaining to the native
    ;; control proc; skipping that wrapper leaves its text object empty even
    ;; though the WAT edit visibly contains the typed characters. Unsubclassed
    ;; EDIT and RichEdit controls continue through the WAT-native branch below.
    ;; Standard Edit menu/command ids should act on the focused edit control
    ;; before app frameworks forward them into native RichEdit's rich/OLE
    ;; clipboard path. Non-edit command ids fall through to the app wndproc.
    (if (i32.eq (local.get $msg) (i32.const 0x0111)) ;; WM_COMMAND
      (then
        (if (call $menu_try_edit_command (i32.and (local.get $wParam) (i32.const 0xFFFF)))
          (then (return (i32.const 0))))))
    ;; Dialog HWNDs install a USER DefDlgProc marker rather than exposing the
    ;; application DLGPROC as their window procedure.
    (if (i32.eq (local.get $wp) (global.get $WNDPROC_DIALOG))
      (then (return (call $dialog_default_proc
        (local.get $hwnd) (local.get $msg)
        (local.get $wParam) (local.get $lParam)))))
    ;; WAT-native (>= 0xFFFF0000)
    (if (i32.ge_u (local.get $wp) (i32.const 0xFFFF0000))
      (then (return (call $wat_wndproc_dispatch
                      (local.get $hwnd) (local.get $msg)
                      (local.get $wParam) (local.get $lParam)))))
    ;; Paint subclasses its multiline text EDIT and handles WM_CHAR before
    ;; chaining. Its wrapper consumes Return without reaching the built-in
    ;; EDIT proc, so remember the native state and supply the standard newline
    ;; only if the subclass leaves it unchanged. Subclasses that already chain
    ;; get exactly one newline.
    (if (i32.and
          (i32.and (i32.eq (local.get $ctrl_class) (i32.const 2))
                   (i32.eq (local.get $msg) (i32.const 0x0102)))
          (i32.and
            (i32.eq (local.get $wParam) (i32.const 0x0D))
            (i32.ne
              (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x00000004))
              (i32.const 0))))
      (then
        (local.set $edit_state (call $wnd_get_state_ptr (local.get $hwnd)))
        (if (local.get $edit_state)
          (then (local.set $edit_len_before
            (i32.load offset=4 (call $g2w (local.get $edit_state))))))))
    ;; A 16-bit task's window procedure cannot be entered this way. The frame
    ;; built below is stdcall with 32-bit arguments and a near return thunk,
    ;; and $wp is a packed selector:offset rather than a linear address — the
    ;; recursive run would decode whatever those bits happen to point at.
    ;; Posting is both safe and closer to what Win16 does: an app pumps its own
    ;; messages, so the procedure still sees this one, on its next iteration
    ;; and with the Pascal frame it expects. See $win16_enter_wndproc in
    ;; src/09e-win16-api.wat for the path that does call it.
    (if (global.get $code16)
      (then
        (drop (call $post_queue_push (local.get $hwnd) (local.get $msg)
                (local.get $wParam) (local.get $lParam)))
        (return (i32.const 0))))

    ;; x86 wndproc — synchronous dispatch via recursive $run.
    ;; Save full guest register context: this is invoked between message-pump
    ;; iterations (often via JS test driver or WAT control-side $wnd_send_message
    ;; from a WAT child wndproc), so when we resume the pump's EIP must see the
    ;; same register state it had before the recursive run. The wndproc's EAX
    ;; return value is extracted separately and returned as the WAT result.
    (local.set $old_eip (global.get $eip))
    (local.set $old_esp (global.get $esp))
    (local.set $old_eax (global.get $eax))
    (local.set $old_ecx (global.get $ecx))
    (local.set $old_edx (global.get $edx))
    (local.set $old_ebx (global.get $ebx))
    (local.set $old_esi (global.get $esi))
    (local.set $old_edi (global.get $edi))
    (local.set $old_ebp (global.get $ebp))
    (local.set $old_handler_set_eip (global.get $handler_set_eip))
    (local.set $old_steps (global.get $steps))
    (local.set $old_yield_reason (global.get $yield_reason))
    (local.set $old_yield_flag (global.get $yield_flag))
    ;; Push args + return thunk on guest stack. Wndproc is stdcall ret 0x10
    ;; so it pops these on return; ESP returns to its current value.
    (global.set $esp (i32.sub (global.get $esp) (i32.const 16)))
    (call $gs32 (i32.add (global.get $esp) (i32.const 12)) (local.get $lParam))
    (call $gs32 (i32.add (global.get $esp) (i32.const 8)) (local.get $wParam))
    (call $gs32 (i32.add (global.get $esp) (i32.const 4)) (local.get $msg))
    (call $gs32 (global.get $esp) (local.get $hwnd))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $sync_msg_ret_thunk))
    (global.set $eip (local.get $wp))
    (global.set $steps (i32.const 0))
    (global.set $yield_reason (i32.const 0))
    (global.set $yield_flag (i32.const 0))
    (global.set $sync_msg_depth (i32.add (global.get $sync_msg_depth) (i32.const 1)))
    ;; A synchronous native-control procedure may legitimately execute more
    ;; than one interpreter slice (property-sheet Cancel walks every tab/page
    ;; before destroying the frame). Continue bounded slices until the return
    ;; thunk sets EIP=0 instead of silently abandoning the guest call midway.
    (local.set $sync_rounds (i32.const 0))
    (block $sync_done (loop $sync_run
      (call $run (i32.const 1000000))
      (br_if $sync_done (i32.eqz (global.get $eip)))
      (local.set $sync_rounds (i32.add (local.get $sync_rounds) (i32.const 1)))
      (br_if $sync_done (i32.ge_u (local.get $sync_rounds) (i32.const 64)))
      (br $sync_run)))
    (global.set $sync_msg_depth (i32.sub (global.get $sync_msg_depth) (i32.const 1)))
    ;; Capture wndproc result (its EAX) before restoring caller's regs.
    (local.set $result (global.get $eax))
    (global.set $eip (local.get $old_eip))
    (global.set $esp (local.get $old_esp))
    (global.set $eax (local.get $old_eax))
    (global.set $ecx (local.get $old_ecx))
    (global.set $edx (local.get $old_edx))
    (global.set $ebx (local.get $old_ebx))
    (global.set $esi (local.get $old_esi))
    (global.set $edi (local.get $old_edi))
    (global.set $ebp (local.get $old_ebp))
    (global.set $handler_set_eip (local.get $old_handler_set_eip))
    (global.set $steps (local.get $old_steps))
    (global.set $yield_reason (local.get $old_yield_reason))
    (global.set $yield_flag (local.get $old_yield_flag))
    (if (i32.and
          (i32.ne (local.get $edit_state) (i32.const 0))
          (i32.eq
            (i32.load offset=4 (call $g2w (local.get $edit_state)))
            (local.get $edit_len_before)))
      (then
        (drop (call $control_wndproc_dispatch
          (local.get $hwnd) (local.get $msg)
          (local.get $wParam) (local.get $lParam)))))
    (local.get $result)
  )

  ;; The most recent dialog-procedure handled BOOL is separate from the
  ;; message LRESULT returned by DefDlgProc. In particular, a DLGPROC can
  ;; handle WM_COMMAND (TRUE) while leaving DWL_MSGRESULT at zero. Control-side
  ;; default behavior must consult this immediately after synchronous dispatch.
  (global $dialog_last_proc_handled (mut i32) (i32.const 0))

  ;; Minimal DefDlgProc semantics around the stored per-window DLGPROC.
  ;; The DLGPROC returns BOOL; when TRUE, the actual message result comes from
  ;; DWL_MSGRESULT. Temporarily exposing the guest proc lets the established
  ;; synchronous sender execute it without duplicating the interpreter-state
  ;; save/restore machinery. Restore only if the proc did not destroy the HWND.
  (func $dialog_default_proc
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $installed i32) (local $proc i32) (local $handled i32)
    (global.set $dialog_last_proc_handled (i32.const 0))
    (local.set $installed (call $wnd_table_get (local.get $hwnd)))
    (local.set $proc (call $dialog_proc_get (local.get $hwnd)))
    (if (i32.eqz (local.get $proc)) (then (return (i32.const 0))))
    (call $wnd_table_set (local.get $hwnd) (local.get $proc))
    (local.set $handled (call $wnd_send_message
      (local.get $hwnd) (local.get $msg)
      (local.get $wParam) (local.get $lParam)))
    ;; Set this after the callback returns so any nested dialog dispatch cannot
    ;; overwrite the outer message's handled state.
    (global.set $dialog_last_proc_handled (i32.ne (local.get $handled) (i32.const 0)))
    (if (i32.ge_s (call $wnd_table_find (local.get $hwnd)) (i32.const 0))
      (then (call $wnd_table_set (local.get $hwnd) (local.get $installed))))
    (if (local.get $handled)
      (then (return (call $dialog_extra_get (local.get $hwnd) (i32.const 0)))))
    (i32.const 0))

  ;; Route a client-relative mouse event to the first WAT-managed child
  ;; under (x,y). Returns 1 if a child was hit and the message dispatched,
  ;; 0 otherwise. lParam is the client-relative cursor position packed as
  ;; x|(y<<16); the child receives a child-relative lParam. Button kind=7
  ;; (group-box) is skipped as non-interactive. Used by JS to avoid
  ;; reimplementing CONTROL_GEOM hit-testing for WAT-managed dialogs.
  ;; NSIS wizard pages are child dialogs inside an outer dialog frame, so
  ;; recurse into child windows before delivering the mouse event to the page.
  (func $dialog_route_mouse (export "dialog_route_mouse")
    (param $parent i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $slot i32) (local $ch i32) (local $cls i32)
    (local $xy i32) (local $wh i32)
    (local $cx i32) (local $cy i32) (local $cw i32) (local $chh i32)
    (local $px i32) (local $py i32) (local $style i32) (local $ch_lp i32)
    (local $hit i32) (local $dispatchable i32)
    (local.set $px (i32.shr_s (i32.shl (local.get $lParam) (i32.const 16)) (i32.const 16)))
    (local.set $py (i32.shr_s (local.get $lParam) (i32.const 16)))
    (if (i32.and
          (i32.eq (local.get $msg) (i32.const 0x0202))
          (i32.and
            (i32.eq (global.get $dialog_button_capture_parent) (local.get $parent))
            (i32.ne (global.get $dialog_button_capture_hwnd) (i32.const 0))))
      (then
        (local.set $ch (global.get $dialog_button_capture_hwnd))
        (global.set $dialog_button_capture_parent (i32.const 0))
        (global.set $dialog_button_capture_hwnd (i32.const 0))
        (local.set $xy (call $ctrl_get_xy_packed (local.get $ch)))
        (local.set $cx (i32.shr_s (i32.shl (local.get $xy) (i32.const 16)) (i32.const 16)))
        (local.set $cy (i32.shr_s (local.get $xy) (i32.const 16)))
        (local.set $ch_lp (i32.or
          (i32.and (i32.sub (local.get $px) (local.get $cx)) (i32.const 0xFFFF))
          (i32.shl
            (i32.and (i32.sub (local.get $py) (local.get $cy)) (i32.const 0xFFFF))
            (i32.const 16))))
        (drop (call $wnd_send_message (local.get $ch)
                (local.get $msg) (local.get $wParam) (local.get $ch_lp)))
        (return (i32.const 1))))
    (block $done (loop $walk
      (local.set $slot (call $wnd_next_child_slot (local.get $parent) (local.get $slot)))
      (br_if $done (i32.eq (local.get $slot) (i32.const -1)))
      (local.set $ch (call $wnd_slot_hwnd (local.get $slot)))
      (local.set $cls (call $ctrl_table_get_class (local.get $ch)))
      (local.set $style (call $wnd_get_style (local.get $ch)))
      ;; Win98 hit-testing ignores effectively hidden child windows. NSIS
      ;; wizard pages keep prior-page controls WS_VISIBLE under a hidden page.
      (if (i32.eqz (call $wnd_is_effectively_visible (local.get $ch)))
        (then
          (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
          (br $walk)))
      (if (i32.and (local.get $style) (i32.const 0x08000000))
        (then
          (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
          (br $walk)))
      (local.set $xy (call $ctrl_get_xy_packed (local.get $ch)))
      (local.set $wh (call $ctrl_get_wh_packed (local.get $ch)))
      (local.set $cx (i32.shr_s (i32.shl (local.get $xy) (i32.const 16)) (i32.const 16)))
      (local.set $cy (i32.shr_s (local.get $xy) (i32.const 16)))
      (local.set $cw (i32.and (local.get $wh) (i32.const 0xFFFF)))
      (local.set $chh (i32.shr_u (local.get $wh) (i32.const 16)))
      (local.set $hit (i32.and
        (i32.and (i32.ge_s (local.get $px) (local.get $cx))
                 (i32.lt_s (local.get $px) (i32.add (local.get $cx) (local.get $cw))))
        (i32.and (i32.ge_s (local.get $py) (local.get $cy))
                 (i32.lt_s (local.get $py) (i32.add (local.get $cy) (local.get $chh))))))
      ;; Button group-box (kind=7) is non-interactive; ignore hits on it.
        (if (i32.and (i32.ne (local.get $hit) (i32.const 0))
                     (i32.eq (local.get $cls) (i32.const 1)))
        (then
          (if (i32.eq (i32.and (local.get $style) (i32.const 0x0F)) (i32.const 7))
            (then (local.set $hit (i32.const 0))))))
      (if (local.get $hit)
        (then
          (local.set $ch_lp (i32.or
            (i32.and (i32.sub (local.get $px) (local.get $cx)) (i32.const 0xFFFF))
            (i32.shl
              (i32.and (i32.sub (local.get $py) (local.get $cy)) (i32.const 0xFFFF))
              (i32.const 16))))
          (if (call $dialog_route_mouse
                (local.get $ch) (local.get $msg) (local.get $wParam) (local.get $ch_lp))
            (then (return (i32.const 1))))
          ;; Click on a sibling control while another combo is dropped → cancel
          ;; that combo first (matches Win98: any click outside the dropdown's
          ;; field/listbox dismisses it). Skip when the hit IS the open combo
          ;; itself — its wndproc handles open/close internally.
          (if (i32.and
                (i32.eq (local.get $msg) (i32.const 0x0201))
                (i32.and
                  (i32.ne (global.get $combo_open_hwnd) (i32.const 0))
                  (i32.ne (global.get $combo_open_hwnd) (local.get $ch))))
            (then (call $combobox_close_dropdown (global.get $combo_open_hwnd) (i32.const 0))))
          (local.set $dispatchable
            (i32.or
              (i32.or
                (i32.or (i32.eq (local.get $cls) (i32.const 1))
                        (i32.eq (local.get $cls) (i32.const 2)))
                (i32.or (i32.eq (local.get $cls) (i32.const 4))
                        (i32.eq (local.get $cls) (i32.const 5))))
              (i32.or
                (i32.or (i32.eq (local.get $cls) (i32.const 6))
                        (i32.eq (local.get $cls) (i32.const 7)))
                (i32.or (i32.eq (local.get $cls) (i32.const 8))
                        (i32.or (i32.eq (local.get $cls) (i32.const 9))
                          (i32.or (i32.eq (local.get $cls) (i32.const 19))
                                  (i32.eq (local.get $cls) (i32.const 27))))))))
          (if (local.get $dispatchable)
            (then
              (if (i32.and
                    (i32.eq (local.get $msg) (i32.const 0x0201))
                    (i32.eq (local.get $cls) (i32.const 1)))
                (then
                  (global.set $dialog_button_capture_parent (local.get $parent))
                  (global.set $dialog_button_capture_hwnd (local.get $ch))))
              (drop (call $wnd_send_message (local.get $ch)
                      (local.get $msg) (local.get $wParam) (local.get $ch_lp)))
              (return (i32.const 1))))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $walk)))
    ;; No child hit. If a combo is dropped, an empty-area click on the dialog
    ;; should still dismiss it.
    (if (i32.and
          (i32.eq (local.get $msg) (i32.const 0x0201))
          (i32.ne (global.get $combo_open_hwnd) (i32.const 0)))
      (then (call $combobox_close_dropdown (global.get $combo_open_hwnd) (i32.const 0))))
    (i32.const 0))

  ;; Recursively destroy a window and all of its WAT-managed descendants.
  ;; For each descendant (depth-first), sends WM_DESTROY so the wndproc
  ;; can free its per-window state struct + sub-allocations, then clears
  ;; the WND_RECORDS slot. The caller is responsible for calling
  ;; $host_destroy_window if the window was visible to the renderer.
  ;;
  ;; The scan restarts after each recursive descend because slot indices
  ;; can shift as $wnd_table_remove zeroes records — simpler than tracking
  ;; a worklist, and MAX_WINDOWS is small enough that the O(N²) cost is
  ;; irrelevant for the small subtrees this is currently used on
  ;; (find dialog: 1 parent + 8 children).
  (func $wnd_destroy_tree (param $hwnd i32)
    (local $i i32) (local $addr i32) (local $child i32)
    (if (i32.eqz (local.get $hwnd)) (then (return)))
    (call $wnd_destroy_children (local.get $hwnd))
    ;; All children gone — let the wndproc free per-window state, then drop the slot.
    (drop (call $wnd_send_message (local.get $hwnd) (i32.const 0x0002)
            (i32.const 0) (i32.const 0)))
    (call $timer_kill_hwnd (local.get $hwnd))
    (call $wnd_table_remove (local.get $hwnd)))

  ;; Destroy all children of a window (depth-first) but not the window itself.
  (func $wnd_destroy_children (export "wnd_destroy_children") (param $hwnd i32)
    (local $i i32) (local $addr i32) (local $child i32)
    (if (i32.eqz (local.get $hwnd)) (then (return)))
    (block $outer
      (loop $rescan
        (local.set $i (i32.const 0))
        (loop $scan
          (br_if $outer (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
          (local.set $addr (call $wnd_record_addr (local.get $i)))
          (local.set $child (i32.load (local.get $addr)))
          (if (i32.and (i32.ne (local.get $child) (i32.const 0))
                       (i32.eq (i32.load offset=8 (local.get $addr)) (local.get $hwnd)))
            (then
              (call $wnd_destroy_tree (local.get $child))
              (br $rescan)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $scan)))))

  ;; ============================================================
  ;; Modal common-dialog scaffolding
  ;; ============================================================
  ;;
  ;; Wraps the CACA0006 thunk pump from $win32_dispatch. Used by
  ;; $handle_GetOpenFileNameA / GetSaveFileNameA / ChooseColorA / etc.
  ;;
  ;;   $modal_begin(dlg_hwnd, esp_adjust):
  ;;     Save current ret addr ([esp]), esp, and the post-call esp delta.
  ;;     Park EIP at the modal_loop_thunk so subsequent interpreter passes
  ;;     hit the CACA0006 case until the dialog is destroyed.
  ;;     $steps=0 prevents th_call_ind (or whatever called us) from
  ;;     overriding our EIP redirect.
  ;;
  ;;   $modal_done_ok(result_hint) / $modal_done_cancel():
  ;;     Called by the dialog's wndproc on OK or Cancel/X. Records the
  ;;     result, tears the dialog down, and clears $modal_dlg_hwnd which
  ;;     unblocks the CACA0006 pump on the next interpreter iteration.
  (func $modal_capture_nonvolatile
    (global.set $modal_restore_pending (i32.const 1))
    (global.set $modal_saved_ebx (global.get $ebx))
    (global.set $modal_saved_esi (global.get $esi))
    (global.set $modal_saved_edi (global.get $edi))
    (global.set $modal_saved_ebp (global.get $ebp)))

  (func $modal_begin (param $dlg i32) (param $esp_adjust i32)
    (global.set $modal_dlg_hwnd  (local.get $dlg))
    (global.set $modal_result    (i32.const 0))
    (global.set $modal_ret_addr  (call $gl32 (global.get $esp)))
    (global.set $modal_saved_esp (global.get $esp))
    (global.set $modal_esp_adjust (local.get $esp_adjust))
    ;; Direct exported test helpers may call modal_begin without entering a
    ;; guest ABI handler. Do not restore stale register state in that case.
    (if (i32.eqz (global.get $modal_restore_pending))
      (then
        (global.set $modal_saved_ebx (global.get $ebx))
        (global.set $modal_saved_esi (global.get $esi))
        (global.set $modal_saved_edi (global.get $edi))
        (global.set $modal_saved_ebp (global.get $ebp))))
    (global.set $eip             (global.get $modal_loop_thunk))
    (global.set $yield_flag      (i32.const 1))
    (global.set $yield_reason    (i32.const 6))
    (global.set $steps           (i32.const 0)))

  ;; One pass of the modal pump, shared by the 32-bit CACA0006 thunk and the
  ;; 16-bit one. Returns 1 while the dialog is still up — EIP has been re-parked
  ;; at `pump_eip`, or the caller should yield — and 0 once it has been
  ;; dismissed, which is when the API call it belongs to can be spliced back
  ;; together. The two worlds differ only in how that splice works, which is why
  ;; the splice stays with each caller and only this part is shared.
  (func $modal_pump_step (param $pump_eip i32) (result i32)
    (local $flags i32) (local $hwnd i32) (local $proc i32)
    (if (i32.eqz (global.get $modal_dlg_hwnd)) (then (return (i32.const 0))))
    ;; Drain nc_flags for the dialog hwnd only: child controls have no
    ;; non-client chrome and would leave spurious fragments.
    (if (global.get $nc_flags_count)
      (then
        (local.set $flags (call $nc_flags_test (global.get $modal_dlg_hwnd)))
        (if (i32.and (local.get $flags) (i32.const 1))          ;; WM_NCPAINT
          (then
            (call $nc_flags_clear (global.get $modal_dlg_hwnd) (i32.const 1))
            (call $defwndproc_do_ncpaint (global.get $modal_dlg_hwnd))
            (global.set $eip (local.get $pump_eip))
            (global.set $steps (i32.const 0))
            (return (i32.const 1))))
        (if (i32.and (local.get $flags) (i32.const 2))          ;; WM_ERASEBKGND
          (then
            (call $nc_flags_clear (global.get $modal_dlg_hwnd) (i32.const 2))
            (drop (call $host_erase_background (global.get $modal_dlg_hwnd) (i32.const 16)))
            (global.set $eip (local.get $pump_eip))
            (global.set $steps (i32.const 0))
            (return (i32.const 1))))))
    ;; WM_PAINT for the child controls. The dialog was built from WAT controls,
    ;; so every valid target here is a WAT-native window procedure.
    (if (call $paint_flag_any)
      (then
        (local.set $hwnd (call $paint_flag_take))
        (local.set $proc (call $wnd_table_get (local.get $hwnd)))
        (if (i32.ge_u (local.get $proc) (i32.const 0xFFFF0000))
          (then
            (drop (call $wat_wndproc_dispatch
              (local.get $hwnd) (i32.const 0x000F) (i32.const 0) (i32.const 0)))
            (global.set $eip (local.get $pump_eip))
            (global.set $steps (i32.const 0))
            (return (i32.const 1))))))
    (global.set $yield_flag (i32.const 1))
    (i32.const 1))

  (func $modal_done (param $result i32)
    (global.set $modal_result (local.get $result))
    (call $wnd_destroy_tree (global.get $modal_dlg_hwnd))
    (call $host_destroy_window (global.get $modal_dlg_hwnd))
    (global.set $modal_dlg_hwnd (i32.const 0)))

  ;; Allocate a new control hwnd, register it as WNDPROC_CTRL_NATIVE,
  ;; populate CONTROL_TABLE with class+id, set parent, then deliver
  ;; WM_CREATE to trigger the wndproc's state allocation.
  ;;
  ;; STEP 6 note: this does NOT call $host_create_window. The renderer
  ;; doesn't see these child windows yet — they're WAT-internal state
  ;; only. The JS-side find dialog (still created by $host_show_find_dialog)
  ;; provides the visible UI. Visual unification is STEP 8.
  ;;
  ;; ctrl_class: 1=Button, 2=Edit, 3=Static (matches $control_wndproc_dispatch)
  (func $ctrl_create_child
    (param $parent i32) (param $ctrl_class i32) (param $ctrl_id i32)
    (param $x i32) (param $y i32) (param $w i32) (param $h i32)
    (param $style i32) (param $text_wa i32) (result i32)
    (local $hwnd i32) (local $cs i32)
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_CTRL_NATIVE))
    (call $wnd_set_parent (local.get $hwnd) (local.get $parent))
    (drop (call $wnd_set_style (local.get $hwnd) (local.get $style)))
    (call $ctrl_table_set
      (call $wnd_table_find (local.get $hwnd))
      (local.get $ctrl_class) (local.get $ctrl_id))
    (call $ctrl_geom_set
      (call $wnd_table_find (local.get $hwnd))
      (local.get $x) (local.get $y) (local.get $w) (local.get $h))
    ;; Build a minimal CREATESTRUCT on the heap and deliver WM_CREATE.
    (local.set $cs (call $heap_alloc (i32.const 48)))
    (i32.store         (call $g2w (local.get $cs)) (i32.const 0))
    (i32.store offset=4  (call $g2w (local.get $cs)) (i32.const 0))
    (i32.store offset=8  (call $g2w (local.get $cs)) (local.get $ctrl_id))
    (i32.store offset=12 (call $g2w (local.get $cs)) (local.get $parent))
    (i32.store offset=16 (call $g2w (local.get $cs)) (local.get $h))
    (i32.store offset=20 (call $g2w (local.get $cs)) (local.get $w))
    (i32.store offset=24 (call $g2w (local.get $cs)) (local.get $y))
    (i32.store offset=28 (call $g2w (local.get $cs)) (local.get $x))
    (i32.store offset=32 (call $g2w (local.get $cs)) (local.get $style))
    (i32.store offset=36 (call $g2w (local.get $cs)) (local.get $text_wa))
    (i32.store offset=40 (call $g2w (local.get $cs)) (i32.const 0))
    (i32.store offset=44 (call $g2w (local.get $cs)) (i32.const 0))
    (drop (call $wnd_send_message
            (local.get $hwnd) (i32.const 0x0001) (i32.const 0) (local.get $cs)))
    (call $heap_free (local.get $cs))
    ;; Queue an initial WM_PAINT so the control draws on next GetMessage
    ;; cycle — same path CreateWindowExA takes for guest-created children.
    (if (i32.and (local.get $style) (i32.const 0x10000000))  ;; WS_VISIBLE
      (then (call $paint_flag_set_inv (local.get $hwnd))))
    (local.get $hwnd)
  )

  ;; Build WAT-side state for the Find/Replace dialog as a parallel shadow
  ;; of the JS-side find dialog. The JS dialog (created by show_find_dialog)
  ;; remains the visible UI and the legacy test path still works through
  ;; renderer.windows[]. The new WAT side provides EditState that the test
  ;; bridge queries via get_findreplace_edit + get_edit_text exports.
  ;;
  ;; $dlg is pre-allocated by the caller (typically $handle_FindTextA's
  ;; $hwnd, the same hwnd handed to the renderer). We register it in the
  ;; window table as WNDPROC_CTRL_NATIVE so $wnd_send_message routes
  ;; messages to it via $control_wndproc_dispatch.
  (func $create_findreplace_dialog (param $dlg i32) (param $owner i32) (param $fr_guest i32) (param $is_replace i32)
    (local $edit i32) (local $replace_edit i32) (local $down i32) (local $slot i32) (local $ch i32)
    ;; Frame (renderer.windows[] entry, isFindDialog flag for hit-test path).
    ;; Same pattern as $create_about_dialog: WAT calls into JS via the
    ;; bare host_register_dialog_frame import — JS does no Win32 logic.
    (call $host_register_dialog_frame
      (local.get $dlg) (local.get $owner)
      (select (i32.const 0x11180) (i32.const 0x1117B) (local.get $is_replace))
      (i32.const 340) (select (i32.const 160) (i32.const 128) (local.get $is_replace))
      (i32.const 2))      ;; kind bit 1 = isFindDialog
    (call $wnd_table_set (local.get $dlg) (global.get $WNDPROC_CTRL_NATIVE))
    (call $title_table_set (local.get $dlg)
      (select (i32.const 0x11180) (i32.const 0x1117B) (local.get $is_replace))
      (select (i32.const 7) (i32.const 4) (local.get $is_replace)))
    (call $wnd_set_owner (local.get $dlg) (local.get $owner))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x90C80000)))
    ;; Tag the parent dialog as control class 10 so $control_wndproc_dispatch
    ;; routes WM_COMMAND from child buttons to $findreplace_wndproc.
    (call $ctrl_table_set (call $wnd_table_find (local.get $dlg))
      (i32.const 10) (i32.const 0))
    ;; Establish the dialog client rect before creating/painting children.
    ;; Child geometry is client-relative; without NCCALCSIZE it is treated
    ;; as window-relative until the later message pump catches up.
    (call $defwndproc_do_nccalcsize (local.get $dlg))
    ;; Paint the dialog chrome/background before child creation. The modeless
    ;; Find dialog shares one back-canvas with its WAT children, so a later
    ;; queued parent paint would cover the children.
    (drop (call $host_erase_background (local.get $dlg) (i32.const 16)))
    (call $defwndproc_do_ncpaint (local.get $dlg))
    ;; Static "Find what:"
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
            (i32.const 8) (i32.const 10) (i32.const 64) (i32.const 14)
            (i32.const 0x50000000)
            (call $wat_str_to_heap (i32.const 0x11120) (i32.const 10))))
    ;; Edit (the one the test cares about)
    (local.set $edit (call $ctrl_create_child (local.get $dlg) (i32.const 2) (i32.const 0x480)
                       (i32.const 74) (i32.const 8) (i32.const 164) (i32.const 18)
                       (i32.const 0x50810000) (i32.const 0)))
    (global.set $findreplace_edit_hwnd (local.get $edit))
    (global.set $findreplace_replace_hwnd (i32.const 0))
    (global.set $findreplace_is_replace (local.get $is_replace))
    (if (local.get $is_replace)
      (then
        (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
                (i32.const 8) (i32.const 38) (i32.const 74) (i32.const 14)
                (i32.const 0x50000000)
                (call $wat_str_to_heap (i32.const 0x1112B) (i32.const 13))))
        (local.set $replace_edit (call $ctrl_create_child
          (local.get $dlg) (i32.const 2) (i32.const 0x481)
          (i32.const 84) (i32.const 34) (i32.const 154) (i32.const 18)
          (i32.const 0x50810000) (i32.const 0)))
        (global.set $findreplace_replace_hwnd (local.get $replace_edit))))
    ;; Match case checkbox
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 0x411)
            (i32.const 8) (select (i32.const 64) (i32.const 38) (local.get $is_replace))
            (i32.const 80) (i32.const 14)
            (i32.const 0x50010003)
            (call $wat_str_to_heap (i32.const 0x11139) (i32.const 10))))
    ;; Direction groupbox + radios
    (if (i32.eqz (local.get $is_replace))
      (then
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 0x440)
            (i32.const 128) (i32.const 28) (i32.const 110) (i32.const 38)
            (i32.const 0x50000007)
            (call $wat_str_to_heap (i32.const 0x11144) (i32.const 9))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 0x420)
            (i32.const 136) (i32.const 40) (i32.const 42) (i32.const 14)
            (i32.const 0x50010009)
            (call $wat_str_to_heap (i32.const 0x1114E) (i32.const 2))))
    (local.set $down (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 0x421)
            (i32.const 184) (i32.const 40) (i32.const 48) (i32.const 14)
            (i32.const 0x50010009)
            (call $wat_str_to_heap (i32.const 0x11151) (i32.const 4))))
    ;; Default: Down direction checked (matches Win98 Notepad Find dialog).
    (drop (call $wnd_send_message (local.get $down) (i32.const 0x00F1) (i32.const 1) (i32.const 0)))))
    ;; Find Next + Cancel buttons
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 1)
            (i32.const 248) (i32.const 6) (i32.const 80) (i32.const 24)
            (i32.const 0x50010001)
            (call $wat_str_to_heap (i32.const 0x11156) (i32.const 9))))
    (if (local.get $is_replace)
      (then
        (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 0x400)
                (i32.const 248) (i32.const 34) (i32.const 80) (i32.const 24)
                (i32.const 0x50010000)
                (call $wat_str_to_heap (i32.const 0x11160) (i32.const 7))))
        (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 0x401)
                (i32.const 248) (i32.const 62) (i32.const 80) (i32.const 24)
                (i32.const 0x50010000)
                (call $wat_str_to_heap (i32.const 0x11168) (i32.const 11))))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 2)
            (i32.const 248) (select (i32.const 90) (i32.const 34) (local.get $is_replace))
            (i32.const 80) (i32.const 24)
            (i32.const 0x50010000)
            (call $wat_str_to_heap (i32.const 0x11174) (i32.const 6))))
    ;; Stash FR struct ptr in dialog userdata for a future $wndproc_dialog.
    (drop (call $wnd_set_userdata (local.get $dlg) (local.get $fr_guest)))
    (global.set $findreplace_dlg_hwnd (local.get $dlg))
    ;; Publish ctrl_count in WND_DLG_RECORDS so renderer-input.js's Tab
    ;; traversal (gated on dlg_get_ctrl_count > 0) recognises this hwnd as
    ;; a dialog. $dlg_load writes this for resource dialogs; WAT-built
    ;; dialogs must do it themselves. Find has 8 controls; Replace has 9.
    (i32.store offset=28 (call $dlg_record_for_hwnd (local.get $dlg))
               (select (i32.const 9) (i32.const 8) (local.get $is_replace)))
    ;; Modeless Find has no modal child-paint drain. Paint the WAT-built
    ;; children once now so the dialog opens with labels/buttons visible.
    (local.set $slot (i32.const 0))
    (block $paint_done (loop $paint_children
      (local.set $slot (call $wnd_next_child_slot (local.get $dlg) (local.get $slot)))
      (br_if $paint_done (i32.eq (local.get $slot) (i32.const -1)))
      (local.set $ch (call $wnd_slot_hwnd (local.get $slot)))
      (if (local.get $ch)
        (then (drop (call $wnd_send_message
          (local.get $ch) (i32.const 0x000F) (i32.const 0) (i32.const 0)))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $paint_children)))
    ;; Seed initial focus on the first tabstop child (the "Find what" edit)
    ;; so Tab/Shift+Tab traversal works without a prior click.
    (call $dlg_seed_focus (local.get $dlg))
  )

  ;; Draw a scrollbar arrow button: edge box + 4-row triangle glyph.
  ;; dir: 0=up, 1=down, 2=left, 3=right
  ;; (bit0 = apex-trailing, bit1 = horizontal axis)
  ;; pressed: 0 = raised, 1 = sunken + glyph shifted 1px down/right
  (func $draw_sb_arrow (param $hdc i32) (param $bx i32) (param $by i32)
                       (param $bw i32) (param $bh i32) (param $dir i32) (param $pressed i32)
    (local $cx i32) (local $cy i32) (local $i i32) (local $u i32) (local $half i32)
    ;; Background fill + 3D edge (raised normally, sunken when pressed).
    (drop (call $host_gdi_fill_rect (local.get $hdc)
            (local.get $bx) (local.get $by)
            (i32.add (local.get $bx) (local.get $bw))
            (i32.add (local.get $by) (local.get $bh))
            (i32.const 0x30011))) ;; LTGRAY_BRUSH
    (drop (call $host_gdi_draw_edge (local.get $hdc)
            (local.get $bx) (local.get $by)
            (i32.add (local.get $bx) (local.get $bw))
            (i32.add (local.get $by) (local.get $bh))
            (select (i32.const 0x0A) (i32.const 0x05) (local.get $pressed)) ;; BDR_SUNKEN : BDR_RAISED
            (i32.const 0x0F))) ;; BF_RECT
    ;; Glyph center (shift 1px down/right when pressed for the classic Win98 look).
    (local.set $cx (i32.add (i32.add (local.get $bx) (i32.div_s (local.get $bw) (i32.const 2))) (local.get $pressed)))
    (local.set $cy (i32.add (i32.add (local.get $by) (i32.div_s (local.get $bh) (i32.const 2))) (local.get $pressed)))
    ;; 4 1-thick scanlines forming a triangle (1,3,5,7 wide).
    (local.set $i (i32.const 0))
    (block $end (loop $next
      (br_if $end (i32.ge_s (local.get $i) (i32.const 4)))
      (local.set $u (i32.sub (local.get $i) (i32.const 2)))
      ;; half-extent: bit0=0 → i (apex first); bit0=1 → 3-i (apex last)
      (if (i32.and (local.get $dir) (i32.const 1))
        (then (local.set $half (i32.sub (i32.const 3) (local.get $i))))
        (else (local.set $half (local.get $i))))
      (if (i32.and (local.get $dir) (i32.const 2))
        (then ;; horizontal: u→x, half→y
          (drop (call $host_gdi_fill_rect (local.get $hdc)
                  (i32.add (local.get $cx) (local.get $u))
                  (i32.sub (local.get $cy) (local.get $half))
                  (i32.add (i32.add (local.get $cx) (local.get $u)) (i32.const 1))
                  (i32.add (i32.add (local.get $cy) (local.get $half)) (i32.const 1))
                  (i32.const 0x30014)))) ;; BLACK_BRUSH
        (else ;; vertical: u→y, half→x
          (drop (call $host_gdi_fill_rect (local.get $hdc)
                  (i32.sub (local.get $cx) (local.get $half))
                  (i32.add (local.get $cy) (local.get $u))
                  (i32.add (i32.add (local.get $cx) (local.get $half)) (i32.const 1))
                  (i32.add (i32.add (local.get $cy) (local.get $u)) (i32.const 1))
                  (i32.const 0x30014)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next))))

  ;; Paint a vertical scrollbar strip (track + two arrows + thumb) inside
  ;; (bx, by, bw, bh). Used by WS_VSCROLL-decorated controls (listbox, edit);
  ;; the standalone SCROLLBAR control does its own inline drawing.
  ;;
  ;; pos      — scroll position in [0, range]
  ;; range    — max scrollable units (0 = no thumb, arrows only)
  ;; pressed  — 0=none, 1=up arrow held, 2=down arrow held
  ;; One scrollbar thumb: light-gray face with a raised edge. Both the shared
  ;; strip painter and the standalone SCROLLBAR control draw through this, so
  ;; they cannot disagree about it again — the control used to inset the thumb
  ;; 2px on the cross axis while the strip painter drew it full width, which is
  ;; visible whenever both appear on screen. Win98 draws the thumb the full
  ;; width of the strip.
  (func $paint_sb_thumb (param $hdc i32) (param $l i32) (param $t i32) (param $r i32) (param $b i32)
    (drop (call $host_gdi_fill_rect (local.get $hdc)
            (local.get $l) (local.get $t) (local.get $r) (local.get $b)
            (i32.const 0x30011)))   ;; LTGRAY_BRUSH
    (drop (call $host_gdi_draw_edge (local.get $hdc)
            (local.get $l) (local.get $t) (local.get $r) (local.get $b)
            (i32.const 0x05) (i32.const 0x0F))))  ;; BDR_RAISED, BF_RECT

  (func $paint_vscrollbar_rect
        (param $hdc i32) (param $bx i32) (param $by i32)
        (param $bw i32) (param $bh i32)
        (param $pos i32) (param $range i32) (param $pressed i32)
    (local $arrow i32) (local $track_y i32) (local $track_h i32)
    (local $thumb_size i32) (local $thumb_pos i32)
    ;; Track background + sunken edge.
    (drop (call $host_gdi_fill_rect (local.get $hdc)
            (local.get $bx) (local.get $by)
            (i32.add (local.get $bx) (local.get $bw))
            (i32.add (local.get $by) (local.get $bh))
            (i32.const 0x30011))) ;; LTGRAY_BRUSH
    ;; Arrows: 16px at each end, suppressed if strip too short.
    (local.set $arrow (call $scrollbar_arrow_size (local.get $bh)))
    (if (local.get $arrow)
      (then
        (call $draw_sb_arrow (local.get $hdc)
          (local.get $bx) (local.get $by)
          (local.get $bw) (local.get $arrow)
          (i32.const 0) ;; up
          (i32.eq (local.get $pressed) (i32.const 1)))
        (call $draw_sb_arrow (local.get $hdc)
          (local.get $bx) (i32.sub (i32.add (local.get $by) (local.get $bh)) (local.get $arrow))
          (local.get $bw) (local.get $arrow)
          (i32.const 1) ;; down
          (i32.eq (local.get $pressed) (i32.const 2)))))
    ;; Thumb. Skip when range is empty (nothing to scroll).
    (if (i32.gt_s (local.get $range) (i32.const 0))
      (then
        (local.set $thumb_size (call $scrollbar_thumb_size (local.get $bh) (local.get $range)))
        (if (local.get $thumb_size)
          (then
            (local.set $thumb_pos
              (i32.add (local.get $by)
                (call $scrollbar_thumb_pos
                  (local.get $bh) (local.get $pos) (i32.const 0) (local.get $range))))
            (call $paint_sb_thumb (local.get $hdc)
              (local.get $bx) (local.get $thumb_pos)
              (i32.add (local.get $bx) (local.get $bw))
              (i32.add (local.get $thumb_pos) (local.get $thumb_size)))))))
  )

  ;; Track-click classifier for a WS_VSCROLL listbox strip. Computes the
  ;; thumb position using the same geometry as $paint_vscrollbar_rect
  ;; (arrow=16, track = h - 32). Returns:
  ;;   0 — geometry degenerate, caller ignores
  ;;   1 — click above thumb: pages up (top -= visible, mutated + stored)
  ;;   2 — click below thumb: pages down (top += visible, mutated + stored)
  ;;   3 — click ON the thumb: caller should begin a drag. Stashes
  ;;       drag_anchor_y (= row_y) and drag_anchor_top (= current top)
  ;;       at ListBoxState+28 / +32 so WM_MOUSEMOVE can recompute top
  ;;       from the cursor delta.
  (func $scrollbar_arrow_size (param $long_dim i32) (result i32)
    (if (result i32) (i32.lt_s (local.get $long_dim) (i32.const 36))
      (then (i32.const 0))
      (else (i32.const 16))))

  (func $scrollbar_thumb_size (param $long_dim i32) (param $range i32) (result i32)
    (local $arrow i32) (local $track_len i32) (local $thumb_size i32)
    (if (i32.le_s (local.get $range) (i32.const 0)) (then (return (i32.const 0))))
    (local.set $arrow (call $scrollbar_arrow_size (local.get $long_dim)))
    (local.set $track_len
      (i32.sub (local.get $long_dim)
        (select (i32.mul (local.get $arrow) (i32.const 2))
                (i32.const 4)
                (local.get $arrow))))
    (if (i32.le_s (local.get $track_len) (i32.const 0)) (then (return (i32.const 0))))
    (local.set $thumb_size (i32.div_u (local.get $track_len) (i32.add (local.get $range) (i32.const 1))))
    (if (i32.lt_u (local.get $thumb_size) (i32.const 16))
      (then (local.set $thumb_size (i32.const 16))))
    (if (i32.gt_u (local.get $thumb_size) (local.get $track_len))
      (then (local.set $thumb_size (local.get $track_len))))
    (local.get $thumb_size))

  (func $scrollbar_thumb_pos (param $long_dim i32) (param $pos i32) (param $smin i32) (param $smax i32) (result i32)
    (local $arrow i32) (local $track_len i32) (local $thumb_size i32) (local $range i32)
    (local.set $range (i32.sub (local.get $smax) (local.get $smin)))
    (local.set $arrow (call $scrollbar_arrow_size (local.get $long_dim)))
    (local.set $track_len
      (i32.sub (local.get $long_dim)
        (select (i32.mul (local.get $arrow) (i32.const 2))
                (i32.const 4)
                (local.get $arrow))))
    (local.set $thumb_size (call $scrollbar_thumb_size (local.get $long_dim) (local.get $range)))
    (if (i32.eqz (local.get $thumb_size))
      (then (return (select (local.get $arrow) (i32.const 2) (local.get $arrow)))))
    (if (i32.le_s (local.get $range) (i32.const 0))
      (then (return (select (local.get $arrow) (i32.const 2) (local.get $arrow)))))
    (i32.add (select (local.get $arrow) (i32.const 2) (local.get $arrow))
      (i32.div_u
        (i32.mul
          (i32.sub (local.get $pos) (local.get $smin))
          (i32.sub (local.get $track_len) (local.get $thumb_size)))
        (local.get $range))))

  ;; ---- SCROLLINFO scrollbar geometry ----------------------------------
  ;; The helpers below this block predate SCROLLINFO: they size the thumb from
  ;; the range alone, which is what TreeView and ListView still expect. USER's
  ;; own scrollbars size it from nPage instead -- the thumb is as big a
  ;; fraction of the track as the visible page is of the document -- and the
  ;; last valid position is smax - (nPage - 1), not smax.
  ;;
  ;; $defwndproc_paint_standard_scrollbar drew the frame scrollbars with that
  ;; second model inline, so nothing else could hit-test what it painted.
  ;; These are that model, factored out, so the painter and the hit test agree
  ;; by construction rather than by two people doing the same arithmetic.
  (func $sb_track_len (param $long_dim i32) (result i32)
    (i32.sub (local.get $long_dim)
      (i32.mul (call $scrollbar_arrow_size (local.get $long_dim)) (i32.const 2))))

  ;; Thumb length in pixels. total = smax - smin + 1 scroll units.
  (func $sb_page_thumb (param $track i32) (param $page i32) (param $total i32) (result i32)
    (local $thumb i32)
    (if (i32.or (i32.le_s (local.get $track) (i32.const 0))
                (i32.le_s (local.get $total) (i32.const 0)))
      (then (return (i32.const 0))))
    (local.set $thumb
      (if (result i32) (i32.gt_u (local.get $page) (i32.const 0))
        (then (i32.div_u (i32.mul (local.get $track) (local.get $page)) (local.get $total)))
        (else (i32.const 16))))
    (if (i32.lt_u (local.get $thumb) (i32.const 16)) (then (local.set $thumb (i32.const 16))))
    (if (i32.gt_u (local.get $thumb) (local.get $track)) (then (local.set $thumb (local.get $track))))
    (local.get $thumb))

  ;; Highest position the thumb can represent: a full page is always visible.
  (func $sb_page_max_pos (param $smin i32) (param $smax i32) (param $page i32) (result i32)
    (local $max_pos i32)
    (local.set $max_pos (local.get $smax))
    (if (i32.gt_u (local.get $page) (i32.const 1))
      (then (local.set $max_pos
        (i32.sub (local.get $smax) (i32.sub (local.get $page) (i32.const 1))))))
    (if (i32.lt_s (local.get $max_pos) (local.get $smin))
      (then (local.set $max_pos (local.get $smin))))
    (local.get $max_pos))

  ;; Offset of the thumb from the start of the long axis (past the low arrow).
  (func $sb_page_thumb_pos (param $long_dim i32) (param $pos i32)
        (param $smin i32) (param $smax i32) (param $page i32) (result i32)
    (local $arrow i32) (local $track i32) (local $thumb i32)
    (local $max_pos i32) (local $range i32) (local $travel i32)
    (local.set $arrow (call $scrollbar_arrow_size (local.get $long_dim)))
    (local.set $track (call $sb_track_len (local.get $long_dim)))
    (local.set $thumb (call $sb_page_thumb (local.get $track) (local.get $page)
      (i32.add (i32.sub (local.get $smax) (local.get $smin)) (i32.const 1))))
    (local.set $max_pos (call $sb_page_max_pos
      (local.get $smin) (local.get $smax) (local.get $page)))
    (local.set $range (i32.sub (local.get $max_pos) (local.get $smin)))
    (local.set $travel (i32.sub (local.get $track) (local.get $thumb)))
    (if (i32.or (i32.le_s (local.get $range) (i32.const 0))
                (i32.le_s (local.get $travel) (i32.const 0)))
      (then (return (local.get $arrow))))
    (i32.add (local.get $arrow)
      (i32.div_u
        (i32.mul (i32.sub (local.get $pos) (local.get $smin)) (local.get $travel))
        (local.get $range))))

  ;; Which part of a SCROLLINFO scrollbar a coordinate lands on. Same return
  ;; codes as $scrollbar_hit_part: 0 none, 1 low arrow, 2 high arrow,
  ;; 3 page towards min, 4 page towards max, 5 thumb.
  (func $sb_page_hit_part (param $long_dim i32) (param $coord i32)
        (param $pos i32) (param $smin i32) (param $smax i32) (param $page i32)
        (result i32)
    (local $arrow i32) (local $thumb i32) (local $thumb_pos i32)
    (local.set $arrow (call $scrollbar_arrow_size (local.get $long_dim)))
    (if (local.get $arrow)
      (then
        (if (i32.lt_s (local.get $coord) (local.get $arrow))
          (then (return (i32.const 1))))
        (if (i32.ge_s (local.get $coord) (i32.sub (local.get $long_dim) (local.get $arrow)))
          (then (return (i32.const 2))))))
    (if (i32.le_s (i32.sub (local.get $smax) (local.get $smin)) (i32.const 0))
      (then (return (i32.const 0))))
    (local.set $thumb (call $sb_page_thumb
      (call $sb_track_len (local.get $long_dim)) (local.get $page)
      (i32.add (i32.sub (local.get $smax) (local.get $smin)) (i32.const 1))))
    (if (i32.eqz (local.get $thumb)) (then (return (i32.const 0))))
    (local.set $thumb_pos (call $sb_page_thumb_pos (local.get $long_dim)
      (local.get $pos) (local.get $smin) (local.get $smax) (local.get $page)))
    (if (i32.lt_s (local.get $coord) (local.get $thumb_pos))
      (then (return (i32.const 3))))
    (if (i32.ge_s (local.get $coord) (i32.add (local.get $thumb_pos) (local.get $thumb)))
      (then (return (i32.const 4))))
    (i32.const 5))

  ;; Position for a thumb dragged to $coord, given where the drag started.
  (func $sb_page_drag_pos (param $long_dim i32) (param $coord i32)
        (param $anchor_coord i32) (param $anchor_pos i32)
        (param $smin i32) (param $smax i32) (param $page i32) (result i32)
    (local $track i32) (local $thumb i32) (local $max_pos i32)
    (local $range i32) (local $travel i32) (local $pos i32)
    (local.set $track (call $sb_track_len (local.get $long_dim)))
    (local.set $thumb (call $sb_page_thumb (local.get $track) (local.get $page)
      (i32.add (i32.sub (local.get $smax) (local.get $smin)) (i32.const 1))))
    (local.set $max_pos (call $sb_page_max_pos
      (local.get $smin) (local.get $smax) (local.get $page)))
    (local.set $range (i32.sub (local.get $max_pos) (local.get $smin)))
    (local.set $travel (i32.sub (local.get $track) (local.get $thumb)))
    (if (i32.or (i32.le_s (local.get $range) (i32.const 0))
                (i32.le_s (local.get $travel) (i32.const 0)))
      (then (return (local.get $anchor_pos))))
    (local.set $pos (i32.add (local.get $anchor_pos)
      (i32.div_s
        (i32.mul (i32.sub (local.get $coord) (local.get $anchor_coord)) (local.get $range))
        (local.get $travel))))
    (if (i32.lt_s (local.get $pos) (local.get $smin)) (then (local.set $pos (local.get $smin))))
    (if (i32.gt_s (local.get $pos) (local.get $max_pos)) (then (local.set $pos (local.get $max_pos))))
    (local.get $pos))

  ;; Generic scrollbar hit test on the long axis. Returns:
  ;; 0=none/disabled, 1=low arrow, 2=high arrow, 3=low page, 4=high page, 5=thumb.
  (func $scrollbar_hit_part
        (param $long_dim i32) (param $coord i32)
        (param $pos i32) (param $smin i32) (param $smax i32) (result i32)
    (local $arrow i32) (local $range i32) (local $thumb_size i32) (local $thumb_pos i32)
    (local.set $arrow (call $scrollbar_arrow_size (local.get $long_dim)))
    (if (local.get $arrow)
      (then
        (if (i32.lt_s (local.get $coord) (local.get $arrow))
          (then (return (i32.const 1))))
        (if (i32.ge_s (local.get $coord) (i32.sub (local.get $long_dim) (local.get $arrow)))
          (then (return (i32.const 2))))))
    (local.set $range (i32.sub (local.get $smax) (local.get $smin)))
    (if (i32.le_s (local.get $range) (i32.const 0)) (then (return (i32.const 0))))
    (local.set $thumb_size (call $scrollbar_thumb_size (local.get $long_dim) (local.get $range)))
    (if (i32.eqz (local.get $thumb_size)) (then (return (i32.const 0))))
    (local.set $thumb_pos (call $scrollbar_thumb_pos
      (local.get $long_dim) (local.get $pos) (local.get $smin) (local.get $smax)))
    (if (i32.lt_s (local.get $coord) (local.get $thumb_pos))
      (then (return (i32.const 3))))
    (if (i32.ge_s (local.get $coord) (i32.add (local.get $thumb_pos) (local.get $thumb_size)))
      (then (return (i32.const 4))))
    (i32.const 5))

  (func $scrollbar_drag_pos
        (param $long_dim i32) (param $coord i32)
        (param $anchor_coord i32) (param $anchor_pos i32)
        (param $smin i32) (param $smax i32) (result i32)
    (local $arrow i32) (local $track_len i32) (local $thumb_size i32)
    (local $range i32) (local $travel i32) (local $new_pos i32)
    (local.set $range (i32.sub (local.get $smax) (local.get $smin)))
    (if (i32.le_s (local.get $range) (i32.const 0)) (then (return (local.get $smin))))
    (local.set $arrow (call $scrollbar_arrow_size (local.get $long_dim)))
    (local.set $track_len
      (i32.sub (local.get $long_dim)
        (select (i32.mul (local.get $arrow) (i32.const 2))
                (i32.const 4)
                (local.get $arrow))))
    (local.set $thumb_size (call $scrollbar_thumb_size (local.get $long_dim) (local.get $range)))
    (local.set $travel (i32.sub (local.get $track_len) (local.get $thumb_size)))
    (if (i32.le_s (local.get $travel) (i32.const 0)) (then (return (local.get $anchor_pos))))
    (local.set $new_pos
      (i32.add (local.get $anchor_pos)
        (i32.div_s
          (i32.mul (i32.sub (local.get $coord) (local.get $anchor_coord)) (local.get $range))
          (local.get $travel))))
    (if (i32.lt_s (local.get $new_pos) (local.get $smin))
      (then (local.set $new_pos (local.get $smin))))
    (if (i32.gt_s (local.get $new_pos) (local.get $smax))
      (then (local.set $new_pos (local.get $smax))))
    (local.get $new_pos))

  (func $listbox_page_hit
        (param $hwnd i32) (param $sw i32)
        (param $row_y i32) (param $h i32)
        (param $top i32) (param $max i32) (param $visible i32) (result i32)
    (local $hit i32) (local $new_top i32)
    (if (i32.lt_s (local.get $visible) (i32.const 1))
      (then (local.set $visible (i32.const 1))))
    (local.set $hit (call $scrollbar_hit_part
      (local.get $h) (local.get $row_y) (local.get $top) (i32.const 0) (local.get $max)))
    (if (i32.eq (local.get $hit) (i32.const 3))
      (then
        (local.set $new_top (i32.sub (local.get $top) (local.get $visible)))
        (if (i32.lt_s (local.get $new_top) (i32.const 0))
          (then (local.set $new_top (i32.const 0))))
        (i32.store offset=20 (local.get $sw) (local.get $new_top))
        (return (i32.const 1))))
    (if (i32.eq (local.get $hit) (i32.const 4))
      (then
        (local.set $new_top (i32.add (local.get $top) (local.get $visible)))
        (if (i32.gt_s (local.get $new_top) (local.get $max))
          (then (local.set $new_top (local.get $max))))
        (i32.store offset=20 (local.get $sw) (local.get $new_top))
        (return (i32.const 2))))
    (if (i32.eq (local.get $hit) (i32.const 5))
      (then
        (i32.store offset=28 (local.get $sw) (local.get $row_y))
        (i32.store offset=32 (local.get $sw) (local.get $top))
        (return (i32.const 3))))
    (i32.const 0))

  ;; Recompute top_index from the current cursor y during a thumb drag.
  ;; Anchors (drag_anchor_y at +28, drag_anchor_top at +32) were stashed
  ;; when the drag started. new_top = anchor_top + delta_y * max / range,
  ;; clamped to [0, max], where range = track_h - thumb_size. Uses the
  ;; same geometry as $paint_vscrollbar_rect.
  (func $listbox_drag_to
        (param $hwnd i32) (param $sw i32)
        (param $row_y i32) (param $h i32) (param $max i32)
    (i32.store offset=20 (local.get $sw)
      (call $scrollbar_drag_pos
        (local.get $h) (local.get $row_y)
        (i32.load offset=28 (local.get $sw))
        (i32.load offset=32 (local.get $sw))
        (i32.const 0) (local.get $max))))

  ;; ScrollBar control wndproc (class 7).
  ;; Draws a Win98-style scrollbar: arrow button at each end + sunken track + raised thumb.
  ;; Reads position/range from SCROLL_TABLE (set via SetScrollPos/SetScrollRange).
  (func $scrollbar_ctrl_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $hdc i32) (local $sz i32) (local $w i32) (local $h i32)
    (local $slot i32) (local $base i32) (local $pos i32) (local $smin i32) (local $smax i32)
    (local $style i32) (local $is_vert i32) (local $track_len i32) (local $thumb_size i32)
    (local $thumb_pos i32) (local $range i32) (local $brush i32)
    (local $arrow i32) (local $long_dim i32)
    (local $mx i32) (local $my i32) (local $part i32) (local $parent i32)
    (local $sb_msg i32) (local $sb_code i32)
    (local $is_pressed i32) (local $coord i32) (local $new_pos i32)

    ;; --- Mouse input: arrows, page regions, and thumb drag ---
    ;; WM_LBUTTONDOWN
    (if (i32.eq (local.get $msg) (i32.const 0x0201))
      (then
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        (local.set $style (call $wnd_get_style (local.get $hwnd)))
        (local.set $is_vert (i32.and (local.get $style) (i32.const 1)))
        (local.set $long_dim (select (local.get $h) (local.get $w) (local.get $is_vert)))
        (local.set $arrow (i32.const 16))
        (if (i32.lt_s (local.get $long_dim) (i32.const 36))
          (then (local.set $arrow (i32.const 0))))
        ;; lParam: low word = x, high word = y (signed 16-bit)
        (local.set $mx (i32.shr_s (i32.shl (local.get $lParam) (i32.const 16)) (i32.const 16)))
        (local.set $my (i32.shr_s (local.get $lParam) (i32.const 16)))
        (local.set $coord (select (local.get $my) (local.get $mx) (local.get $is_vert)))
        (local.set $slot (call $wnd_table_find (local.get $hwnd)))
        (if (i32.ge_s (local.get $slot) (i32.const 0))
          (then
            (local.set $base (call $scroll_bar_addr (local.get $slot) (local.get $is_vert)))
            (local.set $pos (i32.load (local.get $base)))
            (local.set $smin (i32.load offset=4 (local.get $base)))
            (local.set $smax (i32.load offset=8 (local.get $base)))))
        (local.set $part (call $scrollbar_hit_part
          (local.get $long_dim) (local.get $coord)
          (local.get $pos) (local.get $smin) (local.get $smax)))
        (if (local.get $part)
          (then
            (global.set $sb_pressed_hwnd (local.get $hwnd))
            (global.set $sb_pressed_part (local.get $part))
            (if (i32.eq (local.get $part) (i32.const 5))
              (then
                (global.set $capture_hwnd (local.get $hwnd))
                (global.set $sb_drag_anchor_coord (local.get $coord))
                (global.set $sb_drag_anchor_pos (local.get $pos))))
            (drop (call $wnd_send_message
              (local.get $hwnd) (i32.const 0x000F) (i32.const 0) (i32.const 0)))
            (call $invalidate_hwnd (local.get $hwnd))
            ;; Send WM_VSCROLL (0x115) / WM_HSCROLL (0x114) to parent.
            ;; SB_LINE*=0/1, SB_PAGE*=2/3. Thumb sends while dragging.
            (local.set $sb_code
              (if (result i32) (i32.eq (local.get $part) (i32.const 1))
                (then (i32.const 0))
                (else (if (result i32) (i32.eq (local.get $part) (i32.const 2))
                  (then (i32.const 1))
                  (else (if (result i32) (i32.eq (local.get $part) (i32.const 3))
                    (then (i32.const 2))
                    (else (if (result i32) (i32.eq (local.get $part) (i32.const 4))
                      (then (i32.const 3))
                      (else (i32.const 5))))))))))
            (if (i32.ne (local.get $part) (i32.const 5))
              (then
                (local.set $sb_msg (select (i32.const 0x115) (i32.const 0x114) (local.get $is_vert)))
                (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
                (drop (call $wnd_send_message (local.get $parent) (local.get $sb_msg)
                        (local.get $sb_code) (local.get $hwnd)))))))
        (return (i32.const 0))))

    ;; WM_MOUSEMOVE — update SCROLL_TABLE and notify parent while dragging thumb.
    (if (i32.eq (local.get $msg) (i32.const 0x0200))
      (then
        (if (i32.and (i32.eq (global.get $sb_pressed_hwnd) (local.get $hwnd))
                     (i32.eq (global.get $sb_pressed_part) (i32.const 5)))
          (then
            (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
            (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
            (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
            (local.set $style (call $wnd_get_style (local.get $hwnd)))
            (local.set $is_vert (i32.and (local.get $style) (i32.const 1)))
            (local.set $long_dim (select (local.get $h) (local.get $w) (local.get $is_vert)))
            (local.set $mx (i32.shr_s (i32.shl (local.get $lParam) (i32.const 16)) (i32.const 16)))
            (local.set $my (i32.shr_s (local.get $lParam) (i32.const 16)))
            (local.set $coord (select (local.get $my) (local.get $mx) (local.get $is_vert)))
            (local.set $slot (call $wnd_table_find (local.get $hwnd)))
            (if (i32.ge_s (local.get $slot) (i32.const 0))
              (then
                (local.set $base (call $scroll_record_addr (local.get $slot)))
                (if (local.get $is_vert)
                  (then (local.set $base (i32.add (local.get $base) (i32.const 12)))))
                (local.set $smin (i32.load offset=4 (local.get $base)))
                (local.set $smax (i32.load offset=8 (local.get $base)))
                (local.set $new_pos (call $scrollbar_drag_pos
                  (local.get $long_dim) (local.get $coord)
                  (global.get $sb_drag_anchor_coord)
                  (global.get $sb_drag_anchor_pos)
                  (local.get $smin) (local.get $smax)))
                (i32.store (local.get $base) (local.get $new_pos))
                (call $invalidate_hwnd (local.get $hwnd))
                (local.set $sb_msg (select (i32.const 0x115) (i32.const 0x114) (local.get $is_vert)))
                (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
                (drop (call $wnd_send_message (local.get $parent) (local.get $sb_msg)
                  (i32.or (i32.const 5) (i32.shl (i32.and (local.get $new_pos) (i32.const 0xFFFF)) (i32.const 16)))
                  (local.get $hwnd)))))))
        (return (i32.const 0))))

    ;; WM_LBUTTONUP — clear pressed state, send SB_ENDSCROLL.
    (if (i32.eq (local.get $msg) (i32.const 0x0202))
      (then
        (if (i32.eq (global.get $sb_pressed_hwnd) (local.get $hwnd))
          (then
            (local.set $style (call $wnd_get_style (local.get $hwnd)))
            (local.set $is_vert (i32.and (local.get $style) (i32.const 1)))
            (local.set $sb_msg (select (i32.const 0x115) (i32.const 0x114) (local.get $is_vert)))
            (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
            (if (i32.eq (global.get $sb_pressed_part) (i32.const 5))
              (then
                (local.set $slot (call $wnd_table_find (local.get $hwnd)))
                (if (i32.ge_s (local.get $slot) (i32.const 0))
                  (then
                    (local.set $base (call $scroll_record_addr (local.get $slot)))
                    (if (local.get $is_vert)
                      (then (local.set $base (i32.add (local.get $base) (i32.const 12)))))
                    (local.set $pos (i32.load (local.get $base)))
                    (drop (call $wnd_send_message (local.get $parent) (local.get $sb_msg)
                      (i32.or (i32.const 4) (i32.shl (i32.and (local.get $pos) (i32.const 0xFFFF)) (i32.const 16)))
                      (local.get $hwnd)))))))
            (global.set $sb_pressed_hwnd (i32.const 0))
            (global.set $sb_pressed_part (i32.const 0))
            (if (i32.eq (global.get $capture_hwnd) (local.get $hwnd))
              (then (global.set $capture_hwnd (i32.const 0))))
            (call $invalidate_hwnd (local.get $hwnd))
            (drop (call $wnd_send_message (local.get $parent) (local.get $sb_msg)
                    (i32.const 8) (local.get $hwnd))))) ;; SB_ENDSCROLL
        (return (i32.const 0))))

    ;; WM_PAINT
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        (local.set $style (call $wnd_get_style (local.get $hwnd)))
        ;; SBS_VERT = 0x01
        (local.set $is_vert (i32.and (local.get $style) (i32.const 1)))

        ;; Arrow button size: 16px (Win98 SM_CXVSCROLL). Skip arrows if the
        ;; scrollbar's long axis is too short to fit two arrows + any thumb.
        (local.set $long_dim (select (local.get $h) (local.get $w) (local.get $is_vert)))
        (local.set $arrow (call $scrollbar_arrow_size (local.get $long_dim)))
        ;; This window's pressed flag = 1 if we own the press.
        (local.set $is_pressed
          (i32.eq (global.get $sb_pressed_hwnd) (local.get $hwnd)))

        ;; Fill track with scrollbar background (COLOR_SCROLLBAR = light gray)
        (drop (call $host_gdi_fill_rect (local.get $hdc)
                (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
                (i32.const 0x30011))) ;; LTGRAY_BRUSH
        ;; Sunken edge around track
        (drop (call $host_gdi_draw_edge (local.get $hdc)
                (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
                (i32.const 0x0A) (i32.const 0x0F))) ;; BDR_SUNKEN, BF_RECT

        ;; Arrow buttons at each end of the long axis.
        ;; $sb_pressed_part: 1=up, 2=down, 3=left, 4=right.
        (if (local.get $arrow)
          (then
            (if (local.get $is_vert)
              (then
                (call $draw_sb_arrow (local.get $hdc)
                  (i32.const 0) (i32.const 0) (local.get $w) (local.get $arrow)
                  (i32.const 0) ;; up
                  (i32.and (local.get $is_pressed)
                           (i32.eq (global.get $sb_pressed_part) (i32.const 1))))
                (call $draw_sb_arrow (local.get $hdc)
                  (i32.const 0) (i32.sub (local.get $h) (local.get $arrow))
                  (local.get $w) (local.get $arrow)
                  (i32.const 1) ;; down
                  (i32.and (local.get $is_pressed)
                           (i32.eq (global.get $sb_pressed_part) (i32.const 2)))))
              (else
                (call $draw_sb_arrow (local.get $hdc)
                  (i32.const 0) (i32.const 0) (local.get $arrow) (local.get $h)
                  (i32.const 2) ;; left
                  (i32.and (local.get $is_pressed)
                           (i32.or
                             (i32.eq (global.get $sb_pressed_part) (i32.const 1))
                             (i32.eq (global.get $sb_pressed_part) (i32.const 3)))))
                (call $draw_sb_arrow (local.get $hdc)
                  (i32.sub (local.get $w) (local.get $arrow)) (i32.const 0)
                  (local.get $arrow) (local.get $h)
                  (i32.const 3) ;; right
                  (i32.and (local.get $is_pressed)
                           (i32.or
                             (i32.eq (global.get $sb_pressed_part) (i32.const 2))
                             (i32.eq (global.get $sb_pressed_part) (i32.const 4)))))))))

        ;; Read scroll state
        (local.set $slot (call $wnd_table_find (local.get $hwnd)))
        (if (i32.ge_s (local.get $slot) (i32.const 0))
          (then
            (local.set $base (call $scroll_record_addr (local.get $slot)))
            ;; Vertical scrollbar: use offset +12
            (if (local.get $is_vert)
              (then (local.set $base (i32.add (local.get $base) (i32.const 12)))))
            (local.set $pos (i32.load (local.get $base)))
            (local.set $smin (i32.load offset=4 (local.get $base)))
            (local.set $smax (i32.load offset=8 (local.get $base)))
            (local.set $range (i32.sub (local.get $smax) (local.get $smin)))
            (if (i32.gt_s (local.get $range) (i32.const 0))
              (then
                (local.set $thumb_size (call $scrollbar_thumb_size (local.get $long_dim) (local.get $range)))
                (local.set $thumb_pos (call $scrollbar_thumb_pos
                  (local.get $long_dim) (local.get $pos) (local.get $smin) (local.get $smax)))
                ;; Draw thumb
                (if (local.get $is_vert)
                  (then
                    ;; Vertical: thumb fills the strip width, moves in Y
                    (call $paint_sb_thumb (local.get $hdc)
                      (i32.const 0) (local.get $thumb_pos)
                      (local.get $w)
                      (i32.add (local.get $thumb_pos) (local.get $thumb_size))))
                  (else
                    ;; Horizontal: thumb fills the strip height, moves in X
                    (call $paint_sb_thumb (local.get $hdc)
                      (local.get $thumb_pos) (i32.const 0)
                      (i32.add (local.get $thumb_pos) (local.get $thumb_size))
                      (local.get $h))))))))
        (return (i32.const 0))))
    (i32.const 0))
