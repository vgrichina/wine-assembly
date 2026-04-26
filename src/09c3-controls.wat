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
  ;;                    10=Find dialog parent, 11=About dialog parent

  ;; ---- Per-class state struct layouts ----
  ;;
  ;; ButtonState (16 bytes, allocated in WM_CREATE)
  ;;   +0   text_buf_ptr   guest ptr from $heap_alloc (0 = no text)
  ;;   +4   text_len       chars, no NUL
  ;;   +8   flags          bit0=pressed bit1=checked bit2=default bit3=focused
  ;;                       bit4..7 = button kind (0=push 1=checkbox 2=radio 3=groupbox)
  ;;   +12  ctrl_id
  ;;
  ;; StaticState (16 bytes)
  ;;   +0   text_buf_ptr
  ;;   +4   text_len
  ;;   +8   style          (SS_LEFT=0, SS_CENTER=1, SS_RIGHT=2, SS_ICON=3 ...)
  ;;   +12  reserved
  ;;
  ;; The wndproc that allocates the state struct in WM_CREATE is responsible
  ;; for freeing it AND any sub-allocations (text_buf_ptr) in WM_DESTROY,
  ;; then calling $wnd_set_state_ptr(hwnd, 0).

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
  ;; controls. $flags uses SWP_NOSIZE(1) / SWP_NOMOVE(2) like SetWindowPos;
  ;; MoveWindow callers pass 0. No-op if $hwnd isn't a control (class==0).
  (func $ctrl_geom_sync
        (param $hwnd i32) (param $x i32) (param $y i32) (param $w i32) (param $h i32) (param $flags i32)
    (local $idx i32) (local $a i32)
    (if (i32.eqz (call $ctrl_table_get_class (local.get $hwnd)))
      (then (return)))
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return)))
    (local.set $a (call $ctrl_geom_addr (local.get $idx)))
    (if (i32.eqz (i32.and (local.get $flags) (i32.const 2)))
      (then
        (i32.store16        (local.get $a) (local.get $x))
        (i32.store16 offset=2 (local.get $a) (local.get $y))))
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

  ;; ---- Control table helpers (legacy CONTROL_TABLE) ----

  ;; Set control class and ID for a window table slot
  (func $ctrl_table_set (param $slot i32) (param $class i32) (param $ctrl_id i32)
    (local $addr i32)
    (local.set $addr (i32.add (global.get $CONTROL_TABLE) (i32.mul (local.get $slot) (i32.const 16))))
    (i32.store (local.get $addr) (local.get $class))
    (i32.store (i32.add (local.get $addr) (i32.const 4)) (local.get $ctrl_id))
    (i32.store (i32.add (local.get $addr) (i32.const 8)) (i32.const 0))  ;; check_state = 0
    (i32.store (i32.add (local.get $addr) (i32.const 12)) (i32.const 0)) ;; ex_style
  )

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

  ;; Get check state for a control hwnd (legacy CONTROL_TABLE path)
  (func $ctrl_get_check_state (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load (i32.add (i32.add (global.get $CONTROL_TABLE) (i32.mul (local.get $idx) (i32.const 16))) (i32.const 8)))
  )

  ;; Set check state for a control hwnd (legacy CONTROL_TABLE path)
  (func $ctrl_set_check_state (param $hwnd i32) (param $state i32)
    (local $idx i32)
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

  ;; Fill a freshly-registered dialog's client area on its back-canvas with
  ;; COLOR_BTNFACE. Called right after $host_register_dialog_frame so the
  ;; dialog face shows in gaps between child controls. Equivalent to the
  ;; default WM_ERASEBKGND handler for a class with hbrBackground = BTNFACE.
  (func $dlg_fill_bkgnd (param $hwnd i32)
    (call $nc_flags_set (local.get $hwnd) (i32.const 2)))

  ;; ---- Control WndProc dispatch ----

  ;; Dispatch to the correct control wndproc based on control class
  (func $control_wndproc_dispatch (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $class i32)
    (local.set $class (call $ctrl_table_get_class (local.get $hwnd)))
    ;; Class 1 = Button
    (if (i32.eq (local.get $class) (i32.const 1))
      (then (return (call $button_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 2 = Edit
    (if (i32.eq (local.get $class) (i32.const 2))
      (then (return (call $edit_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 3 = Static
    (if (i32.eq (local.get $class) (i32.const 3))
      (then (return (call $static_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 4 = ListBox
    (if (i32.eq (local.get $class) (i32.const 4))
      (then (return (call $listbox_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 6 = ColorGrid (ChooseColor swatches)
    (if (i32.eq (local.get $class) (i32.const 6))
      (then (return (call $colorgrid_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 7 = ScrollBar control
    (if (i32.eq (local.get $class) (i32.const 7))
      (then (return (call $scrollbar_ctrl_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 8 = TreeView (SysTreeView32)
    (if (i32.eq (local.get $class) (i32.const 8))
      (then (return (call $treeview_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
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
    ;; Other classes: return 0 (DefWindowProc)
    (i32.const 0)
  )

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
  ;;   FR_DIALOGTERM  = 0x0040
  (func $findreplace_wndproc
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $cmd i32) (local $fr i32) (local $fr_w i32)
    (local $owner i32) (local $flags i32)
    (local $edit_h i32) (local $edit_state i32) (local $edit_sw i32)
    (local $text_src_w i32) (local $text_len i32) (local $max_len i32)
    (local $find_buf_g i32) (local $find_buf_w i32) (local $i i32)
    (local $mc_h i32) (local $rd_h i32)

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
    (local.set $owner (i32.load offset=4 (local.get $fr_w)))

    ;; ---- WM_CLOSE (0x0010) — title-bar X click ----
    ;; Real commdlg routes a title-bar close through IDCANCEL; do the same.
    (if (i32.eq (local.get $msg) (i32.const 0x0010))
      (then
        (local.set $cmd (i32.const 2))))  ;; fall through into the Cancel branch below

    ;; WM_COMMAND only past this point
    (if (i32.and (i32.ne (local.get $msg) (i32.const 0x0111))
                 (i32.ne (local.get $msg) (i32.const 0x0010)))
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
        (drop (call $wnd_send_message (local.get $owner)
                (i32.const 0xC000) (i32.const 0) (local.get $fr)))
        ;; Tear down the dialog: free child WAT state via WM_DESTROY,
        ;; release the WND_RECORDS slots, drop the visible JS window,
        ;; and clear the globals so the next FindTextA opens fresh state.
        (call $wnd_destroy_tree (local.get $hwnd))
        (call $host_destroy_window (local.get $hwnd))
        (global.set $findreplace_dlg_hwnd  (i32.const 0))
        (global.set $findreplace_edit_hwnd (i32.const 0))
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
        (drop (call $wnd_send_message (local.get $owner)
                (i32.const 0xC000) (i32.const 0) (local.get $fr)))
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
  ;;   $other_g = arg2, free-form line(s) like "Version 4.10\nCopyright"
  ;;              (may be 0)
  ;; The title shown in the caption is "About <appname>", built in WAT
  ;; via memcpy. Lines are: app, then up to two newline-split chunks of
  ;; other_g.
  (func $create_about_dialog
    (param $dlg i32) (param $owner i32)
    (param $app_g i32) (param $other_g i32)
    (local $w i32) (local $h i32)
    (local $title_w i32) (local $title_buf_w i32) (local $app_len i32)
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
    (call $wnd_set_parent (local.get $dlg) (local.get $owner))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x80C80000)))
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
    ;; Line 1: appname static
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
            (i32.const 12) (i32.const 10) (i32.const 236) (i32.const 18)
            (i32.const 0x50000000) (local.get $app_g)))
    ;; Lines 2 + 3: split other_g on the first '\n'. Real ShellAbout
    ;; would also linewrap further; for now we cap at two lines because
    ;; the dialog is only 160px tall.
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
    ;; OK button — id=IDOK=1, BS_DEFPUSHBUTTON style. Centered horizontally,
    ;; near the bottom of the 160px dialog.
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 1)
            (i32.const 90) (i32.sub (local.get $h) (i32.const 56))
            (i32.const 80) (i32.const 24)
            (i32.const 0x50010001)
            (call $wat_str_to_heap (i32.const 0x1D9) (i32.const 2)))))

  ;; ============================================================
  ;; Generic "stub" common-dialog parent (control class 13)
  ;; ============================================================
  ;;
  ;; Placeholder dialog used by $handle_PageSetupDlgA / PrintDlgA /
  ;; ChooseColorA / ChooseFontA until proper UIs are built. Shows the
  ;; title + a "Not implemented yet" static + OK / Cancel buttons.
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
      (then (call $modal_done (i32.const 1)) (return (i32.const 0))))
    (if (i32.eq (local.get $cmd) (i32.const 2))
      (then (call $modal_done (i32.const 0)) (return (i32.const 0))))
    (i32.const 0))

  ;; Build a minimal stub dialog with title + "Not implemented yet" static
  ;; + OK / Cancel. Used by the four common-dialog API handlers below.
  (func $create_stub_dialog (param $dlg i32) (param $owner i32) (param $title_wa i32)
    (call $host_register_dialog_frame
      (local.get $dlg) (local.get $owner)
      (local.get $title_wa)
      (i32.const 260) (i32.const 140)
      (i32.const 1))   ;; isAboutDialog modal flag
    (call $wnd_table_set (local.get $dlg) (global.get $WNDPROC_CTRL_NATIVE))
    (call $title_table_set (local.get $dlg) (local.get $title_wa)
      (call $strlen (local.get $title_wa)))
    (call $wnd_set_parent (local.get $dlg) (local.get $owner))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x80C80000)))
    (call $ctrl_table_set (call $wnd_table_find (local.get $dlg))
      (i32.const 13) (i32.const 0))
    (call $nc_flags_set (local.get $dlg) (i32.const 3))
    (call $dlg_fill_bkgnd (local.get $dlg))
    ;; "Not implemented yet" static
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
            (i32.const 12) (i32.const 20) (i32.const 236) (i32.const 20)
            (i32.const 0x50000001)  ;; SS_CENTER
            (call $wat_str_to_heap (i32.const 0x22D) (i32.const 19))))
    ;; OK button
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 1)
            (i32.const 40) (i32.const 68) (i32.const 72) (i32.const 24)
            (i32.const 0x50010001)
            (call $wat_str_to_heap (i32.const 0x1D9) (i32.const 2))))
    ;; Cancel button
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 2)
            (i32.const 148) (i32.const 68) (i32.const 72) (i32.const 24)
            (i32.const 0x50010000)
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
    (call $wnd_set_parent (local.get $dlg) (local.get $owner))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x80C80000)))
    (call $ctrl_table_set (call $wnd_table_find (local.get $dlg))
      (i32.const 16) (i32.const 0))
    (call $nc_flags_set (local.get $dlg) (i32.const 3))
    (call $dlg_fill_bkgnd (local.get $dlg))
    ;; Message text static.
    (local.set $text_g (call $wat_str_to_heap (local.get $text_wa) (local.get $text_len)))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
            (i32.const 16) (i32.const 24)
            (i32.sub (local.get $w) (i32.const 32)) (i32.const 60)
            (i32.const 0x50000000)
            (local.get $text_g)))
    ;; Button row, left edge centered around dialog midpoint.
    (local.set $bx (i32.div_u (i32.sub (local.get $w) (local.get $row_w)) (i32.const 2)))
    (local.set $by (i32.sub (local.get $h) (i32.const 36)))
    ;; Layout per MB_* mask. IDs match winuser.h.
    (block $done
      ;; MB_OK (0)
      (if (i32.eqz (local.get $btn_kind))
        (then
          (call $msgbox_btn (local.get $dlg) (i32.const 1)
            (local.get $bx) (local.get $by) (i32.const 0x1D9) (i32.const 2) (i32.const 1))
          (br $done)))
      ;; MB_OKCANCEL (1)
      (if (i32.eq (local.get $btn_kind) (i32.const 1))
        (then
          (call $msgbox_btn (local.get $dlg) (i32.const 1)
            (local.get $bx) (local.get $by) (i32.const 0x1D9) (i32.const 2) (i32.const 1))
          (call $msgbox_btn (local.get $dlg) (i32.const 2)
            (i32.add (local.get $bx) (i32.const 76)) (local.get $by)
            (i32.const 0x1D2) (i32.const 6) (i32.const 0))
          (br $done)))
      ;; MB_ABORTRETRYIGNORE (2)
      (if (i32.eq (local.get $btn_kind) (i32.const 2))
        (then
          (call $msgbox_btn (local.get $dlg) (i32.const 3)
            (local.get $bx) (local.get $by) (i32.const 0x340) (i32.const 5) (i32.const 1))
          (call $msgbox_btn (local.get $dlg) (i32.const 4)
            (i32.add (local.get $bx) (i32.const 76)) (local.get $by)
            (i32.const 0x346) (i32.const 5) (i32.const 0))
          (call $msgbox_btn (local.get $dlg) (i32.const 5)
            (i32.add (local.get $bx) (i32.const 152)) (local.get $by)
            (i32.const 0x34C) (i32.const 6) (i32.const 0))
          (br $done)))
      ;; MB_YESNOCANCEL (3)
      (if (i32.eq (local.get $btn_kind) (i32.const 3))
        (then
          (call $msgbox_btn (local.get $dlg) (i32.const 6)
            (local.get $bx) (local.get $by) (i32.const 0x353) (i32.const 3) (i32.const 1))
          (call $msgbox_btn (local.get $dlg) (i32.const 7)
            (i32.add (local.get $bx) (i32.const 76)) (local.get $by)
            (i32.const 0x357) (i32.const 2) (i32.const 0))
          (call $msgbox_btn (local.get $dlg) (i32.const 2)
            (i32.add (local.get $bx) (i32.const 152)) (local.get $by)
            (i32.const 0x1D2) (i32.const 6) (i32.const 0))
          (br $done)))
      ;; MB_YESNO (4)
      (if (i32.eq (local.get $btn_kind) (i32.const 4))
        (then
          (call $msgbox_btn (local.get $dlg) (i32.const 6)
            (local.get $bx) (local.get $by) (i32.const 0x353) (i32.const 3) (i32.const 1))
          (call $msgbox_btn (local.get $dlg) (i32.const 7)
            (i32.add (local.get $bx) (i32.const 76)) (local.get $by)
            (i32.const 0x357) (i32.const 2) (i32.const 0))
          (br $done)))
      ;; MB_RETRYCANCEL (5)
      (if (i32.eq (local.get $btn_kind) (i32.const 5))
        (then
          (call $msgbox_btn (local.get $dlg) (i32.const 4)
            (local.get $bx) (local.get $by) (i32.const 0x346) (i32.const 5) (i32.const 1))
          (call $msgbox_btn (local.get $dlg) (i32.const 2)
            (i32.add (local.get $bx) (i32.const 76)) (local.get $by)
            (i32.const 0x1D2) (i32.const 6) (i32.const 0))
          (br $done)))
      ;; MB_CANCELTRYCONTINUE (6)
      (if (i32.eq (local.get $btn_kind) (i32.const 6))
        (then
          (call $msgbox_btn (local.get $dlg) (i32.const 2)
            (local.get $bx) (local.get $by) (i32.const 0x1D2) (i32.const 6) (i32.const 1))
          (call $msgbox_btn (local.get $dlg) (i32.const 10)
            (i32.add (local.get $bx) (i32.const 76)) (local.get $by)
            (i32.const 0x35A) (i32.const 9) (i32.const 0))
          (call $msgbox_btn (local.get $dlg) (i32.const 11)
            (i32.add (local.get $bx) (i32.const 152)) (local.get $by)
            (i32.const 0x364) (i32.const 8) (i32.const 0))
          (br $done)))
      ;; Fallback: lone OK.
      (call $msgbox_btn (local.get $dlg) (i32.const 1)
        (local.get $bx) (local.get $by) (i32.const 0x1D9) (i32.const 2) (i32.const 1))))

  ;; ============================================================
  ;; Font (ChooseFont) dialog — control class 14
  ;; ============================================================
  ;;
  ;; Three listboxes (face / style / size) + OK / Cancel. The CHOOSEFONT
  ;; guest ptr is stashed in userdata so the IDOK handler can write the
  ;; selected face/style/size back into CHOOSEFONT.lpLogFont. For V1 the
  ;; write-back is a best-effort: we set lfHeight from the size index and
  ;; zero out the face name since copying a variable face into LOGFONT
  ;; requires the name string from the listbox and a 32-byte buffer.
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

    ;; ---- OK: write size back to LOGFONT.lfHeight via helper ----
    (if (i32.eq (local.get $cmd) (i32.const 1))
      (then
        (call $fontdlg_writeback_size (local.get $hwnd))
        (call $modal_done (i32.const 1))
        (return (i32.const 0))))
    (i32.const 0))

  ;; Helper: read selected size from the 0x452 listbox, parse to int,
  ;; write negative value into CHOOSEFONT.lpLogFont[lfHeight=+0]. Split
  ;; out from $fontdlg_wndproc so the latter stays stack-balanced.
  (func $fontdlg_writeback_size (param $hwnd i32)
    (local $cf i32) (local $cf_w i32) (local $lf_g i32) (local $lf_w i32)
    (local $size_h i32) (local $size_sel i32)
    (local $buf_g i32) (local $buf_w i32)
    (local $val i32) (local $i i32) (local $c i32)
    (local.set $cf (call $wnd_get_userdata (local.get $hwnd)))
    (if (i32.eqz (local.get $cf)) (then (return)))
    (local.set $cf_w (call $g2w (local.get $cf)))
    (local.set $lf_g (i32.load offset=12 (local.get $cf_w)))
    (if (i32.eqz (local.get $lf_g)) (then (return)))
    (local.set $lf_w (call $g2w (local.get $lf_g)))
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
    (i32.store (local.get $lf_w) (i32.sub (i32.const 0) (local.get $val))))

  (func $create_font_dialog (param $dlg i32) (param $owner i32) (param $cf i32)
    (local $face_lb i32) (local $style_lb i32) (local $size_lb i32)
    (call $host_register_dialog_frame
      (local.get $dlg) (local.get $owner)
      (i32.const 0x258)   ;; "Font"
      (i32.const 420) (i32.const 260)
      (i32.const 1))
    (call $wnd_table_set (local.get $dlg) (global.get $WNDPROC_CTRL_NATIVE))
    (call $title_table_set (local.get $dlg) (i32.const 0x258) (i32.const 4))
    (call $wnd_set_parent (local.get $dlg) (local.get $owner))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x80C80000)))
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
  ;; ColorGrid is an 8x3 grid of Windows basic colors. 24 cells at a
  ;; fixed cell size (24x20 by default) — the control window must be
  ;; sized ≥ 192x60 to fit the grid. Clicks pick a cell and notify the
  ;; parent via WM_COMMAND + LBN_SELCHANGE (we reuse notification code 1).
  ;;
  ;; ColorGridState (8 bytes, allocated in WM_CREATE)
  ;;   +0   sel_idx       selected cell 0..23, -1 = none
  ;;   +4   ctrl_id
  ;;
  ;; Cell colors are hardcoded — the real Windows basic color palette.
  ;; Looked up by index via $colorgrid_color_for_idx.
  (func $colorgrid_color_for_idx (param $idx i32) (result i32)
    ;; 24 basic colors, row-major (8 cols × 3 rows). Values are 0x00BBGGRR
    ;; (COLORREF) per standard Win32.
    (if (i32.eq (local.get $idx) (i32.const  0)) (then (return (i32.const 0x00FFFFFF))))  ;; white
    (if (i32.eq (local.get $idx) (i32.const  1)) (then (return (i32.const 0x00C0C0C0))))  ;; lt gray
    (if (i32.eq (local.get $idx) (i32.const  2)) (then (return (i32.const 0x00808080))))  ;; gray
    (if (i32.eq (local.get $idx) (i32.const  3)) (then (return (i32.const 0x00404040))))  ;; dk gray
    (if (i32.eq (local.get $idx) (i32.const  4)) (then (return (i32.const 0x00000000))))  ;; black
    (if (i32.eq (local.get $idx) (i32.const  5)) (then (return (i32.const 0x000000FF))))  ;; red
    (if (i32.eq (local.get $idx) (i32.const  6)) (then (return (i32.const 0x000080FF))))  ;; orange
    (if (i32.eq (local.get $idx) (i32.const  7)) (then (return (i32.const 0x0000FFFF))))  ;; yellow
    (if (i32.eq (local.get $idx) (i32.const  8)) (then (return (i32.const 0x0000FF80))))  ;; lime
    (if (i32.eq (local.get $idx) (i32.const  9)) (then (return (i32.const 0x0000FF00))))  ;; green
    (if (i32.eq (local.get $idx) (i32.const 10)) (then (return (i32.const 0x0080FF00))))  ;; teal
    (if (i32.eq (local.get $idx) (i32.const 11)) (then (return (i32.const 0x00FFFF00))))  ;; cyan
    (if (i32.eq (local.get $idx) (i32.const 12)) (then (return (i32.const 0x00FF8000))))  ;; sky
    (if (i32.eq (local.get $idx) (i32.const 13)) (then (return (i32.const 0x00FF0000))))  ;; blue
    (if (i32.eq (local.get $idx) (i32.const 14)) (then (return (i32.const 0x00FF0080))))  ;; indigo
    (if (i32.eq (local.get $idx) (i32.const 15)) (then (return (i32.const 0x00FF00FF))))  ;; magenta
    (if (i32.eq (local.get $idx) (i32.const 16)) (then (return (i32.const 0x008000FF))))  ;; pink
    (if (i32.eq (local.get $idx) (i32.const 17)) (then (return (i32.const 0x000000A0))))  ;; dk red
    (if (i32.eq (local.get $idx) (i32.const 18)) (then (return (i32.const 0x000050A0))))  ;; brown
    (if (i32.eq (local.get $idx) (i32.const 19)) (then (return (i32.const 0x00008080))))  ;; olive
    (if (i32.eq (local.get $idx) (i32.const 20)) (then (return (i32.const 0x00008000))))  ;; dk grn
    (if (i32.eq (local.get $idx) (i32.const 21)) (then (return (i32.const 0x00808000))))  ;; dk cyan
    (if (i32.eq (local.get $idx) (i32.const 22)) (then (return (i32.const 0x00800000))))  ;; dk blue
    (if (i32.eq (local.get $idx) (i32.const 23)) (then (return (i32.const 0x00800080))))  ;; dk magenta
    (i32.const 0x00FFFFFF))

  (func $colorgrid_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $state i32) (local $sw i32) (local $cs_w i32)
    (local $x i32) (local $y i32) (local $col i32) (local $row i32)
    (local $idx i32) (local $parent i32) (local $ctrl_id i32)
    (local $hdc i32) (local $sel i32) (local $brush i32)
    (local $cx i32) (local $cy i32)

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
    ;; 8 cols × 3 rows of basic colors. Each cell is 24×20 with a 1-px black
    ;; border and a 2-px white selection ring drawn over the picked cell.
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        (local.set $sel (i32.load (local.get $sw)))
        (local.set $row (i32.const 0))
        (block $rows_done (loop $rows
          (br_if $rows_done (i32.ge_u (local.get $row) (i32.const 3)))
          (local.set $col (i32.const 0))
          (block $cols_done (loop $cols
            (br_if $cols_done (i32.ge_u (local.get $col) (i32.const 8)))
            (local.set $idx (i32.add (i32.mul (local.get $row) (i32.const 8)) (local.get $col)))
            (local.set $cx (i32.mul (local.get $col) (i32.const 24)))
            (local.set $cy (i32.mul (local.get $row) (i32.const 20)))
            ;; 1-px black border = full cell painted black, then color fill 1px in
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (local.get $cx) (local.get $cy)
                    (i32.add (local.get $cx) (i32.const 24))
                    (i32.add (local.get $cy) (i32.const 20))
                    (i32.const 0x30014)))  ;; BLACK_BRUSH
            (local.set $brush (call $host_gdi_create_solid_brush
                                (call $colorgrid_color_for_idx (local.get $idx))))
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.add (local.get $cx) (i32.const 1))
                    (i32.add (local.get $cy) (i32.const 1))
                    (i32.add (local.get $cx) (i32.const 23))
                    (i32.add (local.get $cy) (i32.const 19))
                    (local.get $brush)))
            (drop (call $host_gdi_delete_object (local.get $brush)))
            ;; Selection: white ring 2 px in from the border
            (if (i32.eq (local.get $idx) (local.get $sel))
              (then
                (drop (call $host_gdi_draw_edge (local.get $hdc)
                        (i32.add (local.get $cx) (i32.const 2))
                        (i32.add (local.get $cy) (i32.const 2))
                        (i32.add (local.get $cx) (i32.const 22))
                        (i32.add (local.get $cy) (i32.const 18))
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
        (local.set $col (i32.div_s (local.get $x) (i32.const 24)))
        (local.set $row (i32.div_s (local.get $y) (i32.const 20)))
        (if (i32.or (i32.or (i32.lt_s (local.get $col) (i32.const 0))
                            (i32.ge_s (local.get $col) (i32.const 8)))
                    (i32.or (i32.lt_s (local.get $row) (i32.const 0))
                            (i32.ge_s (local.get $row) (i32.const 3))))
          (then (return (i32.const 0))))
        (local.set $idx (i32.add (i32.mul (local.get $row) (i32.const 8)) (local.get $col)))
        (i32.store (local.get $sw) (local.get $idx))
        (call $invalidate_hwnd (local.get $hwnd))
        (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
        (local.set $ctrl_id (i32.load offset=4 (local.get $sw)))
        (if (local.get $parent)
          (then
            (drop (call $wnd_send_message (local.get $parent) (i32.const 0x0111)
                    (i32.or (local.get $ctrl_id) (i32.const 0x10000))   ;; HIWORD=1 (LBN_SELCHANGE reused)
                    (local.get $hwnd)))))
        (return (i32.const 0))))

    (i32.const 0))

  (func $colordlg_wndproc
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $cmd i32) (local $cc i32) (local $cc_w i32) (local $grid i32)
    (local $sw i32) (local $idx i32)

    (if (i32.eq (local.get $msg) (i32.const 0x0085))   ;; WM_NCPAINT
      (then (call $defwndproc_do_ncpaint (local.get $hwnd)) (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0014))   ;; WM_ERASEBKGND
      (then (return (call $host_erase_background (local.get $hwnd) (i32.const 16)))))
    (if (i32.eq (local.get $msg) (i32.const 0x0010))   ;; WM_CLOSE
      (then (call $modal_done (i32.const 0)) (return (i32.const 0))))
    (if (i32.ne (local.get $msg) (i32.const 0x0111)) (then (return (i32.const 0))))
    (local.set $cmd (i32.and (local.get $wParam) (i32.const 0xFFFF)))

    (if (i32.eq (local.get $cmd) (i32.const 2))
      (then (call $modal_done (i32.const 0)) (return (i32.const 0))))

    (if (i32.eq (local.get $cmd) (i32.const 1))
      (then
        ;; Write selected color into CHOOSECOLOR.rgbResult (+0x0C).
        (local.set $cc (call $wnd_get_userdata (local.get $hwnd)))
        (if (local.get $cc)
          (then
            (local.set $cc_w (call $g2w (local.get $cc)))
            (local.set $grid (call $ctrl_find_by_id (local.get $hwnd) (i32.const 0x460)))
            (if (local.get $grid)
              (then
                (local.set $sw (call $wnd_get_state_ptr (local.get $grid)))
                (if (local.get $sw)
                  (then
                    (local.set $idx (i32.load (call $g2w (local.get $sw))))
                    (if (i32.ge_s (local.get $idx) (i32.const 0))
                      (then
                        (i32.store offset=12 (local.get $cc_w)
                          (call $colorgrid_color_for_idx (local.get $idx)))))))))))
        (call $modal_done (i32.const 1))
        (return (i32.const 0))))
    (i32.const 0))

  (func $create_color_dialog (param $dlg i32) (param $owner i32) (param $cc i32)
    (local $grid i32) (local $rgb i32) (local $i i32) (local $sw i32)
    (call $host_register_dialog_frame
      (local.get $dlg) (local.get $owner)
      (i32.const 0x252)   ;; "Color"
      (i32.const 260) (i32.const 160)
      (i32.const 1))
    (call $wnd_table_set (local.get $dlg) (global.get $WNDPROC_CTRL_NATIVE))
    (call $title_table_set (local.get $dlg) (i32.const 0x252) (i32.const 5))
    (call $wnd_set_parent (local.get $dlg) (local.get $owner))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x80C80000)))
    (call $ctrl_table_set (call $wnd_table_find (local.get $dlg))
      (i32.const 15) (i32.const 0))
    (call $nc_flags_set (local.get $dlg) (i32.const 3))
    (call $dlg_fill_bkgnd (local.get $dlg))
    (drop (call $wnd_set_userdata (local.get $dlg) (local.get $cc)))
    ;; Swatch grid: 8 cols * 24px = 192, 3 rows * 20px = 60
    (local.set $grid (call $ctrl_create_child (local.get $dlg) (i32.const 6) (i32.const 0x460)
            (i32.const 12) (i32.const 12) (i32.const 192) (i32.const 60)
            (i32.const 0x50000000) (i32.const 0)))
    ;; Pre-highlight the cell matching CHOOSECOLOR.rgbResult (+12) so the
    ;; dialog opens with the app's current color already selected.
    (if (local.get $cc)
      (then
        (local.set $rgb (i32.load offset=12 (call $g2w (local.get $cc))))
        (local.set $i (i32.const 0))
        (block $done (loop $scan
          (br_if $done (i32.ge_u (local.get $i) (i32.const 24)))
          (if (i32.eq (call $colorgrid_color_for_idx (local.get $i)) (local.get $rgb))
            (then
              (local.set $sw (call $wnd_get_state_ptr (local.get $grid)))
              (if (local.get $sw)
                (then (i32.store (call $g2w (local.get $sw)) (local.get $i))))
              (br $done)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $scan)))))
    ;; OK + Cancel
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 1)
            (i32.const 30) (i32.const 92) (i32.const 80) (i32.const 24)
            (i32.const 0x50010001)
            (call $wat_str_to_heap (i32.const 0x1D9) (i32.const 2))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 2)
            (i32.const 130) (i32.const 92) (i32.const 80) (i32.const 24)
            (i32.const 0x50010000)
            (call $wat_str_to_heap (i32.const 0x1D2) (i32.const 6)))))

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
  ;;   +0x18  lpstrFile        — guest ptr to writable buffer
  ;;   +0x1C  nMaxFile         — capacity
  ;;   +0x24  lpstrInitialDir
  ;;   +0x28  lpstrTitle

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
                (call $wat_str_to_heap (i32.const 0x217) (i32.const 2))))))
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

  ;; ---- Open dialog wndproc ----
  (func $opendlg_wndproc
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $cmd i32) (local $notif i32) (local $ofn i32) (local $ofn_w i32)
    (local $edit_h i32) (local $edit_state i32) (local $edit_sw i32)
    (local $text_len i32) (local $text_src_w i32)
    (local $dst_g i32) (local $dst_w i32) (local $max_len i32)

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
                      (then (call $memcpy (local.get $dst_w)
                                          (local.get $text_src_w)
                                          (local.get $text_len))))))
                (i32.store8 (i32.add (local.get $dst_w) (local.get $text_len)) (i32.const 0))))))
        (call $modal_done (i32.const 1))
        (return (i32.const 0))))

    ;; ---- Upload (id 0x443) ----
    ;; Trigger native file picker. The dialog stays open; on pick the JS
    ;; side writes the file into VFS and calls $opendlg_refresh_listbox
    ;; (exported below) to repopulate.
    (if (i32.eq (local.get $cmd) (i32.const 0x443))
      (then
        (call $host_pick_file_upload (local.get $hwnd) (i32.const 0x213))   ;; "C:\"
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
    (local $lb i32)
    (local.set $w (i32.const 360))
    (local.set $h (i32.const 240))
    ;; Title goes to JS (WASM offset). Button text goes through
    ;; $wat_str_to_heap → guest ptr that ctrl_create_child stores in
    ;; CREATESTRUCT.lpszName for $button_wndproc to read in WM_CREATE.
    (if (i32.eq (local.get $kind) (i32.const 1))
      (then
        (local.set $title_wa (i32.const 0x1ED))                                 ;; "Save As"
        (local.set $btn_g   (call $wat_str_to_heap (i32.const 0x1F5) (i32.const 4))))  ;; "Save"
      (else
        (local.set $title_wa (i32.const 0x1E8))                                 ;; "Open"
        (local.set $btn_g   (call $wat_str_to_heap (i32.const 0x1E8) (i32.const 4))))) ;; "Open"
    (call $host_register_dialog_frame
      (local.get $dlg) (local.get $owner)
      (local.get $title_wa)
      (local.get $w) (local.get $h)
      (i32.const 1))  ;; isAboutDialog flag (modal indicator) — reused for now
    (call $wnd_table_set (local.get $dlg) (global.get $WNDPROC_CTRL_NATIVE))
    (call $title_table_set (local.get $dlg) (local.get $title_wa)
      (call $strlen (local.get $title_wa)))
    (call $wnd_set_parent (local.get $dlg) (local.get $owner))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x80C80000)))
    (call $ctrl_table_set (call $wnd_table_find (local.get $dlg))
      (i32.const 12) (i32.const 0))
    (call $nc_flags_set (local.get $dlg) (i32.const 3))
    (call $dlg_fill_bkgnd (local.get $dlg))
    ;; Stash OFN ptr for the OK handler.
    (drop (call $wnd_set_userdata (local.get $dlg) (local.get $ofn)))

    ;; "Look in:" static
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
            (i32.const 12) (i32.const 10) (i32.const 60) (i32.const 16)
            (i32.const 0x50000000)
            (call $wat_str_to_heap (i32.const 0x205) (i32.const 8))))
    ;; Current directory display (read-only-ish edit at id 0x440)
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 2) (i32.const 0x440)
            (i32.const 76) (i32.const 8) (i32.const 200) (i32.const 18)
            (i32.const 0x50810000)
            (call $wat_str_to_heap (i32.const 0x213) (i32.const 3))))  ;; "C:\"
    ;; File listbox (id 0x441) — WS_VSCROLL so the scrollbar strip renders.
    (local.set $lb (call $ctrl_create_child (local.get $dlg) (i32.const 4) (i32.const 0x441)
                     (i32.const 12) (i32.const 32) (i32.const 264) (i32.const 130)
                     (i32.const 0x50A10001) (i32.const 0)))
    ;; "File name:" static
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
            (i32.const 12) (i32.const 168) (i32.const 60) (i32.const 16)
            (i32.const 0x50000000)
            (call $wat_str_to_heap (i32.const 0x1FA) (i32.const 10))))
    ;; Filename edit (id 0x442)
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 2) (i32.const 0x442)
            (i32.const 76) (i32.const 166) (i32.const 200) (i32.const 18)
            (i32.const 0x50810000) (i32.const 0)))
    ;; Open / Save button (id IDOK = 1)
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 1)
            (i32.const 286) (i32.const 8) (i32.const 64) (i32.const 22)
            (i32.const 0x50010001)
            (local.get $btn_g)))
    ;; Cancel button (id IDCANCEL = 2)
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 2)
            (i32.const 286) (i32.const 36) (i32.const 64) (i32.const 22)
            (i32.const 0x50010000)
            (call $wat_str_to_heap (i32.const 0x1D2) (i32.const 6))))   ;; "Cancel"
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
                    (call $wat_str_to_heap (i32.const 0x224) (i32.const 8)))))   ;; "Download"
          (else
            (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 0x443)
                    (i32.const 286) (i32.const 80) (i32.const 64) (i32.const 22)
                    (i32.const 0x50010000)
                    (call $wat_str_to_heap (i32.const 0x21A) (i32.const 9))))))))   ;; "Upload..."

    ;; Initialize current dir to "C:\\" and populate the listbox via
    ;; $opendlg_set_dir which builds the pattern + path edit too.
    (call $heap_free (global.get $opendlg_current_dir))
    (global.set $opendlg_current_dir (call $wat_str_to_heap (i32.const 0x213) (i32.const 3)))
    (call $opendlg_populate_listbox (local.get $lb)
      (call $wat_str_to_heap (i32.const 0x20E) (i32.const 4))))

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

  ;; Clear the "checked" bit on every BS_AUTORADIOBUTTON sibling of $hwnd
  ;; (same parent), then set the checked bit on $hwnd itself. Win32 radio
  ;; mutex behavior. Group boundaries (WS_GROUP) are not yet honored — we
  ;; treat all sibling autoradios as one group, which is correct for every
  ;; dialog with a single radio group and incorrect only when a parent
  ;; contains two independent radio groups (none of our test apps do today).
  (func $autoradio_clear_siblings (param $hwnd i32)
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
            ;; kind == BS_AUTORADIOBUTTON (9)
            (i32.eq (i32.and (i32.load offset=16 (local.get $rec)) (i32.const 0x0F))
                    (i32.const 9)))
        (then
          (local.set $st (i32.load offset=20 (local.get $rec)))
          (if (local.get $st)
            (then
              (local.set $stw (call $g2w (local.get $st)))
              ;; Clear bit1 (checked) on every autoradio sibling — including
              ;; $hwnd itself; the caller will re-set it after this returns.
              (i32.store offset=8 (local.get $stw)
                (i32.and (i32.load offset=8 (local.get $stw)) (i32.const 0xFFFFFFFD)))
              (call $invalidate_hwnd (local.get $other))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
  )

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

    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))

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
        (local.set $state (call $heap_alloc (i32.const 64)))
        (local.set $state_w (call $g2w (local.get $state)))
        (i32.store        (local.get $state_w) (i32.const 0)) ;; text_buf_ptr
        (i32.store offset=4  (local.get $state_w) (i32.const 0)) ;; text_len
        (i32.store offset=8  (local.get $state_w) (i32.const 0)) ;; flags
        (i32.store offset=12 (local.get $state_w) (local.get $hmenu)) ;; ctrl_id
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
            (call $invalidate_hwnd (local.get $hwnd))
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

    ;; ---------- WM_LBUTTONDOWN (0x0201) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0201))
      (then
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            (i32.store offset=8 (local.get $state_w)
              (i32.or (i32.load offset=8 (local.get $state_w)) (i32.const 0x01))) ;; pressed
            (call $invalidate_hwnd (local.get $hwnd))))
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
            (call $invalidate_hwnd (local.get $hwnd))
            ;; Post WM_COMMAND(MAKEWPARAM(ctrl_id, BN_CLICKED=0), button_hwnd)
            ;; to parent. Skip groupbox (kind 7) — it's not interactive.
            (if (i32.ne (local.get $w) (i32.const 7))
              (then
                (drop (call $wnd_send_message
                  (call $wnd_get_parent (local.get $hwnd))
                  (i32.const 0x0111)  ;; WM_COMMAND
                  ;; wParam: low 16 = ctrl_id (from ButtonState+12), high 16 = BN_CLICKED (0)
                  (i32.and (i32.load offset=12 (local.get $state_w)) (i32.const 0xFFFF))
                  (local.get $hwnd))))) ;; lParam = button hwnd
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
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $flags (i32.load offset=8 (local.get $state_w)))
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
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

        ;; Resolve text pointer/length once (used by every kind that has a label).
        (if (i32.load (local.get $state_w))
          (then
            (local.set $text_w (call $g2w (i32.load (local.get $state_w))))
            (local.set $text_len (i32.load offset=4 (local.get $state_w)))))

        ;; ---- Push button (kinds 0, 1) ----
        (if (i32.lt_u (local.get $kind) (i32.const 2))
          (then
            ;; Fill face with LTGRAY_BRUSH (stock object 1 = 0x30011)
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
                    (i32.const 0x30011)))
            ;; Bevel: BF_RECT(0x0F) | BDR_RAISEDOUTER(0x01)|BDR_RAISEDINNER(0x04) = 0x05
            ;;        or pressed: BDR_SUNKENOUTER(0x02)|BDR_SUNKENINNER(0x08) = 0x0A
            (local.set $edge_flags (select (i32.const 0x0A) (i32.const 0x05)
                                           (i32.and (local.get $flags) (i32.const 0x01))))
            (drop (call $host_gdi_draw_edge (local.get $hdc)
                    (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
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
            (local.set $box_y (i32.div_u (i32.sub (local.get $h) (i32.const 12)) (i32.const 2)))
            ;; White interior
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.const 0) (local.get $box_y)
                    (i32.const 12) (i32.add (local.get $box_y) (i32.const 12))
                    (i32.const 0x30010)))
            ;; Sunken edge — EDGE_SUNKEN = 0x0A, BF_RECT = 0x0F
            (drop (call $host_gdi_draw_edge (local.get $hdc)
                    (i32.const 0) (local.get $box_y)
                    (i32.const 12) (i32.add (local.get $box_y) (i32.const 12))
                    (i32.const 0x0A) (i32.const 0x0F)))
            ;; Check glyph if checked (flags bit 1)
            (if (i32.and (local.get $flags) (i32.const 0x02))
              (then
                (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30017)))
                (drop (call $host_gdi_move_to (local.get $hdc)
                        (i32.const 3) (i32.add (local.get $box_y) (i32.const 5))))
                (drop (call $host_gdi_line_to (local.get $hdc)
                        (i32.const 5) (i32.add (local.get $box_y) (i32.const 8))))
                (drop (call $host_gdi_line_to (local.get $hdc)
                        (i32.const 9) (i32.add (local.get $box_y) (i32.const 3))))
                ;; Second pass 1px down for thickness
                (drop (call $host_gdi_move_to (local.get $hdc)
                        (i32.const 3) (i32.add (local.get $box_y) (i32.const 6))))
                (drop (call $host_gdi_line_to (local.get $hdc)
                        (i32.const 5) (i32.add (local.get $box_y) (i32.const 9))))
                (drop (call $host_gdi_line_to (local.get $hdc)
                        (i32.const 9) (i32.add (local.get $box_y) (i32.const 4))))))
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
                (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30014)))
                (drop (call $host_gdi_ellipse (local.get $hdc)
                        (i32.const 4) (i32.add (local.get $box_y) (i32.const 4))
                        (i32.const 8) (i32.add (local.get $box_y) (i32.const 8))))))
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
            (return (i32.const 0))))

        ;; ---- Groupbox (kind 7) ----
        ;; Etched rectangle with a label notched into the top stroke. The label
        ;; width is measured via DT_CALCRECT so we know how wide a hole to clear.
        (if (i32.eq (local.get $kind) (i32.const 7))
          (then
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
                    (i32.const 0x30011)))
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
            ;; Skip if already drawn (flags bit 2) or queue full
            (if (i32.and (local.get $flags) (i32.const 0x04))
              (then (return (i32.const 0))))
            (if (i32.ge_u (global.get $post_queue_count) (i32.const 64))
              (then (return (i32.const 0))))
            ;; Set drawn flag
            (i32.store offset=8 (local.get $state_w)
              (i32.or (local.get $flags) (i32.const 0x04)))
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
            ;; Post WM_DRAWITEM (0x002B) to parent
            (drop (call $wnd_send_message
              (call $wnd_get_parent (local.get $hwnd))
              (i32.const 0x002B)
              (i32.load offset=12 (local.get $state_w))
              (i32.add (local.get $state) (i32.const 16))))
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
    (if (i32.eq (local.get $msg) (i32.const 0x00F1))
      (then
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            (local.set $flags (i32.load offset=8 (local.get $state_w)))
            (local.set $flags (i32.and (local.get $flags) (i32.const 0xFFFFFFFD))) ;; clear checked
            (if (local.get $wParam)
              (then (local.set $flags (i32.or (local.get $flags) (i32.const 0x02)))))
            (i32.store offset=8 (local.get $state_w) (local.get $flags))
            (call $invalidate_hwnd (local.get $hwnd))
            (return (i32.const 0))))
        (call $ctrl_set_check_state (local.get $hwnd) (local.get $wParam))
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
    (local $tx_r i32) (local $tx_b i32)

    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))

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
            (local.set $text_len (call $strlen (call $g2w (local.get $name_ptr))))
            (i32.store        (local.get $state_w) (call $ctrl_text_dup (local.get $name_ptr) (local.get $text_len)))
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
            (call $invalidate_hwnd (local.get $hwnd))
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
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        ;; Geometry from CONTROL_GEOM (parent has already painted the
        ;; dialog face background via WM_ERASEBKGND, so no fill here).
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        (local.set $style (i32.and (i32.load offset=8 (local.get $state_w)) (i32.const 0x0F)))
        (local.set $ex (call $ctrl_get_ex_style (local.get $hwnd)))
        ;; Default text rect = full client.
        (local.set $tx_l (i32.const 0))
        (local.set $tx_t (i32.const 0))
        (local.set $tx_r (local.get $w))
        (local.set $tx_b (local.get $h))
        ;; WS_EX_CLIENTEDGE (0x200): paint white interior + sunken edge
        ;; (calc's display "0." field + memory indicator both use this).
        ;; Inset the text rect by 2px so glyphs don't touch the sunken edge.
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
            (local.set $tx_l (i32.const 2))
            (local.set $tx_t (i32.const 2))
            (local.set $tx_r (i32.sub (local.get $w) (i32.const 2)))
            (local.set $tx_b (i32.sub (local.get $h) (i32.const 2))))
          (else
            ;; Erase the static's rect for label types. Parent's WM_ERASEBKGND
            ;; ran once at create time, but subsequent SetWindowText invalidates
            ;; only the static — without this fill, new text composites on top of
            ;; the previous text (visible in calc's display as digit pile-up).
            ;; SS_BLACKRECT(4)/SS_GRAYRECT(5)/SS_WHITERECT(6) and the matching
            ;; FRAME variants own their fill color, so skip those.
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
        ;; SS_ICON(3), SS_BITMAP(0x0E): skip text — these display images, not labels
        (if (i32.and
              (i32.ne (local.get $style) (i32.const 3))
              (i32.ne (local.get $style) (i32.const 0x0E)))
          (then
          (if (i32.load (local.get $state_w))
            (then
              ;; SS_LEFT(0)/SS_CENTER(1)/SS_RIGHT(2) use DT_WORDBREAK for multi-line.
              ;; SS_SIMPLE(0x0B), SS_LEFTNOWORDWRAP(0x0C) use DT_SINGLELINE.
              (local.set $fmt (if (result i32) (i32.le_u (local.get $style) (i32.const 2))
                (then (i32.const 0x10))    ;; DT_WORDBREAK
                (else (i32.const 0x24))))  ;; DT_VCENTER|DT_SINGLELINE
              (if (i32.eq (local.get $style) (i32.const 1))
                (then (local.set $fmt (i32.or (local.get $fmt) (i32.const 0x01))))) ;; DT_CENTER
              (if (i32.eq (local.get $style) (i32.const 2))
                (then (local.set $fmt (i32.or (local.get $fmt) (i32.const 0x02))))) ;; DT_RIGHT
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

  ;; ============================================================
  ;; ListBox WndProc  (control class 4)
  ;; ============================================================
  ;;
  ;; ListBoxState (28 bytes, allocated in WM_CREATE)
  ;;   +0   items_buf_ptr    guest ptr to flat NUL-separated string buffer
  ;;                         ("item1\0item2\0item3\0", or 0 if empty)
  ;;   +4   items_used       bytes in items_buf actually used (incl. NULs)
  ;;   +8   items_cap        bytes allocated for items_buf
  ;;   +12  count            number of items
  ;;   +16  cur_sel          current selection (-1 = none)
  ;;   +20  top_index        first visible row (vertical scroll)
  ;;   +24  ctrl_id          control id (notification target uses this)
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

    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))

    ;; ---------- WM_CREATE (0x0001) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0001))
      (then
        (local.set $cs_w (call $g2w (local.get $lParam)))
        (local.set $state (call $heap_alloc (i32.const 36)))
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
        (call $wnd_set_state_ptr (local.get $hwnd) (local.get $state))
        (return (i32.const 0))))

    ;; ---------- WM_DESTROY (0x0002) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0002))
      (then
        (if (local.get $state)
          (then
            (local.set $sw (call $g2w (local.get $state)))
            (call $heap_free (i32.load (local.get $sw)))
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
        (call $invalidate_hwnd (local.get $hwnd))
        (return (local.get $count))))  ;; index of newly inserted item

    ;; ---------- LB_RESETCONTENT (0x0184) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0184))
      (then
        (i32.store offset=4  (local.get $sw) (i32.const 0))   ;; items_used
        (i32.store offset=12 (local.get $sw) (i32.const 0))   ;; count
        (i32.store offset=16 (local.get $sw) (i32.const -1))  ;; cur_sel
        (i32.store offset=20 (local.get $sw) (i32.const 0))   ;; top_index
        (call $invalidate_hwnd (local.get $hwnd))
        (return (i32.const 0))))

    ;; ---------- LB_GETCOUNT (0x018B) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x018B))
      (then (return (i32.load offset=12 (local.get $sw)))))

    ;; ---------- LB_GETCURSEL (0x0188) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0188))
      (then (return (i32.load offset=16 (local.get $sw)))))

    ;; ---------- LB_SETCURSEL (0x0186) ----------
    ;; wParam = index (-1 to clear). Clamp to count-1 if out of range.
    (if (i32.eq (local.get $msg) (i32.const 0x0186))
      (then
        (local.set $idx (local.get $wParam))
        (local.set $count (i32.load offset=12 (local.get $sw)))
        (if (i32.ge_s (local.get $idx) (local.get $count))
          (then (local.set $idx (i32.const -1))))
        (i32.store offset=16 (local.get $sw) (local.get $idx))
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

    ;; ---------- WM_PAINT (0x000F) ----------
    ;; Draw inset frame, white interior, and visible item rows. Selected
    ;; item is rendered with the system highlight (blue background +
    ;; white text). Item height is fixed at 16 px. If WS_VSCROLL is set,
    ;; a 16px scrollbar strip is reserved at the right edge.
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
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
          (if (i32.eq (local.get $idx) (local.get $sel))
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
  ;;   +28  max_length     0 = unlimited

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
    (local $len i32) (local $src_g i32) (local $dst_g i32) (local $cap i32)
    (if (i32.ge_u (local.get $lo) (local.get $hi)) (then (return)))
    (local.set $len (i32.sub (local.get $hi) (local.get $lo)))
    (local.set $src_g (i32.load (local.get $state_w)))
    (if (i32.eqz (local.get $src_g)) (then (return)))
    ;; Grow capacity if needed (round up to multiple of 64).
    (if (i32.gt_u (local.get $len) (global.get $clipboard_cap))
      (then
        (if (global.get $clipboard_ptr)
          (then (call $heap_free (global.get $clipboard_ptr))
                (global.set $clipboard_ptr (i32.const 0))))
        (local.set $cap (i32.and (i32.add (local.get $len) (i32.const 63)) (i32.const -64)))
        (global.set $clipboard_ptr (call $heap_alloc (local.get $cap)))
        (global.set $clipboard_cap (local.get $cap))))
    (local.set $dst_g (global.get $clipboard_ptr))
    (if (i32.eqz (local.get $dst_g)) (then (return)))
    (call $memcpy
      (call $g2w (local.get $dst_g))
      (i32.add (call $g2w (local.get $src_g)) (local.get $lo))
      (local.get $len))
    (global.set $clipboard_len (local.get $len))
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
      (local.set $w (call $host_measure_text (local.get $hdc) (local.get $line_w) (local.get $i)))
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

  (func $edit_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $state i32) (local $state_w i32) (local $cs_w i32)
    (local $name_ptr i32) (local $text_len i32) (local $hdc i32)
    (local $sz i32) (local $w i32) (local $h i32) (local $buf i32)
    (local $cur i32) (local $px i32) (local $lo i32) (local $hi i32)
    (local $vk i32) (local $flags i32)
    (local $sel_lo i32) (local $sel_hi i32) (local $a i32) (local $b i32)
    (local $line_end i32) (local $pre_w i32) (local $sel_w i32)
    (local $line_y i32) (local $line_buf_w i32) (local $brush i32)

    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))

    ;; ---------- WM_CREATE (0x0001) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0001))
      (then
        (local.set $state (call $heap_alloc (i32.const 32)))
        (local.set $state_w (call $g2w (local.get $state)))
        (i32.store         (local.get $state_w) (i32.const 0))
        (i32.store offset=4  (local.get $state_w) (i32.const 0))
        (i32.store offset=8  (local.get $state_w) (i32.const 0))
        (i32.store offset=12 (local.get $state_w) (i32.const 0))
        (i32.store offset=16 (local.get $state_w) (i32.const 0))
        (i32.store offset=20 (local.get $state_w) (i32.const 0))
        (i32.store offset=24 (local.get $state_w) (i32.const 0))
        (i32.store offset=28 (local.get $state_w) (i32.const 0))
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

    ;; ---------- WM_DESTROY (0x0002) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0002))
      (then
        (if (local.get $state)
          (then
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

    ;; ---------- WM_SETFOCUS (0x0007) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0007))
      (then
        (global.set $focus_hwnd (local.get $hwnd))
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            (i32.store offset=24 (local.get $state_w)
              (i32.or (i32.load offset=24 (local.get $state_w)) (i32.const 0x08)))))
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
            (i32.store offset=24 (local.get $state_w)
              (i32.and (i32.load offset=24 (local.get $state_w)) (i32.const 0xFFFFFFF7)))))
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
            (call $invalidate_hwnd (local.get $hwnd))
            (return (i32.const 0))))
        ;; CR (0x0D) — Enter key: insert newline only for multiline edits (bit 0 of flags)
        (if (i32.eq (local.get $wParam) (i32.const 0x0D))
          (then
            (if (i32.and (i32.load offset=24 (local.get $state_w)) (i32.const 0x01))
              (then
                (call $edit_insert_char (local.get $state_w) (i32.const 0x0A))
                (call $invalidate_hwnd (local.get $hwnd))))
            (return (i32.const 0))))
        (if (i32.lt_u (local.get $wParam) (i32.const 0x20))
          (then (return (i32.const 0))))
        (call $edit_insert_char (local.get $state_w) (local.get $wParam))
        (call $invalidate_hwnd (local.get $hwnd))
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
                (call $invalidate_hwnd (local.get $hwnd))
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
                    (call $invalidate_hwnd (local.get $hwnd))))
                (return (i32.const 0))))
            ;; Ctrl+V (0x56) — paste
            (if (i32.eq (local.get $vk) (i32.const 0x56))
              (then
                (if (i32.eqz (i32.and (i32.load offset=24 (local.get $state_w)) (i32.const 0x04)))
                  (then
                    (if (global.get $clipboard_len)
                      (then (call $edit_insert_bytes (local.get $state_w)
                              (global.get $clipboard_ptr) (global.get $clipboard_len))))
                    (call $invalidate_hwnd (local.get $hwnd))))
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
                (call $invalidate_hwnd (local.get $hwnd))))
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
                (call $invalidate_hwnd (local.get $hwnd))))
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
            (call $invalidate_hwnd (local.get $hwnd))
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
            (call $invalidate_hwnd (local.get $hwnd))
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
            (call $invalidate_hwnd (local.get $hwnd))
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
            (call $invalidate_hwnd (local.get $hwnd))
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
                (call $invalidate_hwnd (local.get $hwnd))))
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
                (call $invalidate_hwnd (local.get $hwnd))))
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
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        (local.set $w (i32.shr_s (i32.shl (local.get $lParam) (i32.const 16)) (i32.const 16)))
        (local.set $h (i32.shr_s (local.get $lParam) (i32.const 16)))
        (local.set $cur (call $edit_xy_to_offset
          (local.get $state_w) (local.get $hdc) (local.get $w) (local.get $h)))
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
        (local.set $cur (call $edit_xy_to_offset
          (local.get $state_w) (local.get $hdc) (local.get $w) (local.get $h)))
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
        ;; Release capture grabbed on WM_LBUTTONDOWN.
        (if (i32.eq (global.get $capture_hwnd) (local.get $hwnd))
          (then (global.set $capture_hwnd (i32.const 0))))
        (return (i32.const 0))))

    ;; ---------- WM_PAINT (0x000F) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        ;; ctrl_get_wh_packed reads CONTROL_GEOM (works for WAT-only children
        ;; that have no JS-side window record).
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        ;; Default GUI font + transparent bk mode so glyphs don't paint over
        ;; the white edit area with an opaque white box.
        (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))
        (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))
        ;; 1) White background (WHITE_BRUSH stock obj 0 = 0x30010)
        (drop (call $host_gdi_fill_rect (local.get $hdc)
                (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
                (i32.const 0x30010)))
        ;; 2) Sunken edge: BDR_SUNKENOUTER(0x02)|BDR_SUNKENINNER(0x08) = 0x0A; BF_RECT = 0x0F
        (drop (call $host_gdi_draw_edge (local.get $hdc)
                (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
                (i32.const 0x0A) (i32.const 0x0F)))
        ;; 3) Text — draw line by line, splitting on \n. Each line is split
        ;; into up to three segments (pre-sel / sel / post-sel) so selected
        ;; text renders white-on-blue while unselected text stays black.
        (local.set $buf (i32.load (local.get $state_w)))
        (local.set $text_len (i32.load offset=4 (local.get $state_w)))
        (local.set $sel_lo (call $edit_sel_lo (local.get $state_w)))
        (local.set $sel_hi (call $edit_sel_hi (local.get $state_w)))
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
                            (local.get $hdc) (local.get $line_buf_w) (local.get $a)))))
                  (local.set $sel_w (i32.sub
                    (call $host_measure_text (local.get $hdc) (local.get $line_buf_w) (local.get $b))
                    (local.get $pre_w)))
                  ;; If sel extends past the \n (to the next line), pad to right edge.
                  (if (i32.gt_u (local.get $sel_hi) (local.get $line_end))
                    (then (local.set $sel_w (i32.sub (local.get $w)
                            (i32.add (local.get $pre_w) (i32.const 4))))))
                  (local.set $brush (call $host_gdi_create_solid_brush (i32.const 0x00800000)))
                  (drop (call $host_gdi_fill_rect (local.get $hdc)
                          (i32.add (local.get $pre_w) (i32.const 4))
                          (local.get $line_y)
                          (i32.add (i32.add (local.get $pre_w) (local.get $sel_w)) (i32.const 4))
                          (i32.add (local.get $line_y) (i32.const 16))
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
        (if (i32.and (local.get $flags) (i32.const 0x08))
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
                                        (i32.sub (local.get $cur) (local.get $lo))))))
            (if (i32.ge_s (local.get $a) (i32.const 0))
              (then
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.add (local.get $px) (i32.const 4))
                    (i32.add (local.get $hi) (i32.const 5))
                    (i32.add (local.get $px) (i32.const 5))
                    (i32.add (local.get $hi) (i32.const 18))
                    (i32.const 0x30014))))))) ;; BLACK_BRUSH
        (return (i32.const 0))))

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
                  (global.get $clipboard_ptr) (global.get $clipboard_len))))
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
    (if (i32.eq (local.get $msg) (i32.const 0x00B7))
      (then (return (i32.const 0))))

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
        (if (i32.eqz (i32.and (i32.load offset=24 (local.get $state_w)) (i32.const 0x01)))
          (then (return (i32.const 0))))
        ;; lines_delta = -delta_raw / 40  (120/3 = 40 → 3 lines per notch)
        (local.set $vk (i32.div_s
                         (i32.sub (i32.const 0)
                           (i32.shr_s (local.get $wParam) (i32.const 16)))
                         (i32.const 40)))
        (local.set $text_len (i32.load offset=4 (local.get $state_w)))
        (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        ;; visible_lines = max(1, (h - 8) / 16)
        (local.set $a (i32.div_u (i32.sub (local.get $h) (i32.const 8)) (i32.const 16)))
        (if (i32.eqz (local.get $a)) (then (local.set $a (i32.const 1))))
        ;; total_lines = edit_line_from_char(text_len) + 1
        (local.set $b (i32.add (call $edit_line_from_char (local.get $state_w) (local.get $text_len))
                               (i32.const 1)))
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
    (local $wp i32) (local $slot i32)
    (local $old_eip i32) (local $old_eax i32) (local $old_ecx i32) (local $old_edx i32)
    (local $old_ebx i32) (local $old_esi i32) (local $old_edi i32) (local $old_ebp i32)
    (local $result i32)
    (local.set $wp (call $wnd_table_get (local.get $hwnd)))
    (if (i32.eqz (local.get $wp)) (then (return (i32.const 0))))
    ;; WAT-native (>= 0xFFFF0000)
    (if (i32.ge_u (local.get $wp) (i32.const 0xFFFF0000))
      (then (return (call $wat_wndproc_dispatch
                      (local.get $hwnd) (local.get $msg)
                      (local.get $wParam) (local.get $lParam)))))
    ;; x86 wndproc — synchronous dispatch via recursive $run.
    ;; Save full guest register context: this is invoked between message-pump
    ;; iterations (often via JS test driver or WAT control-side $wnd_send_message
    ;; from a WAT child wndproc), so when we resume the pump's EIP must see the
    ;; same register state it had before the recursive run. The wndproc's EAX
    ;; return value is extracted separately and returned as the WAT result.
    (local.set $old_eip (global.get $eip))
    (local.set $old_eax (global.get $eax))
    (local.set $old_ecx (global.get $ecx))
    (local.set $old_edx (global.get $edx))
    (local.set $old_ebx (global.get $ebx))
    (local.set $old_esi (global.get $esi))
    (local.set $old_edi (global.get $edi))
    (local.set $old_ebp (global.get $ebp))
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
    (call $run (i32.const 1000000))
    ;; Capture wndproc result (its EAX) before restoring caller's regs.
    (local.set $result (global.get $eax))
    (global.set $eip (local.get $old_eip))
    (global.set $eax (local.get $old_eax))
    (global.set $ecx (local.get $old_ecx))
    (global.set $edx (local.get $old_edx))
    (global.set $ebx (local.get $old_ebx))
    (global.set $esi (local.get $old_esi))
    (global.set $edi (local.get $old_edi))
    (global.set $ebp (local.get $old_ebp))
    (global.set $steps (i32.const 0))
    (local.get $result)
  )

  ;; Route a client-relative mouse event to the first WAT-managed child
  ;; under (x,y). Returns 1 if a child was hit and the message dispatched,
  ;; 0 otherwise. lParam is the client-relative cursor position packed as
  ;; x|(y<<16); the child receives a child-relative lParam. Button kind=7
  ;; (group-box) is skipped as non-interactive. Used by JS to avoid
  ;; reimplementing CONTROL_GEOM hit-testing for WAT-managed dialogs.
  (func $dialog_route_mouse (export "dialog_route_mouse")
    (param $parent i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $slot i32) (local $ch i32) (local $cls i32)
    (local $xy i32) (local $wh i32)
    (local $cx i32) (local $cy i32) (local $cw i32) (local $chh i32)
    (local $px i32) (local $py i32) (local $style i32) (local $ch_lp i32)
    (local $hit i32)
    (local.set $px (i32.shr_s (i32.shl (local.get $lParam) (i32.const 16)) (i32.const 16)))
    (local.set $py (i32.shr_s (local.get $lParam) (i32.const 16)))
    (block $done (loop $walk
      (local.set $slot (call $wnd_next_child_slot (local.get $parent) (local.get $slot)))
      (br_if $done (i32.eq (local.get $slot) (i32.const -1)))
      (local.set $ch (call $wnd_slot_hwnd (local.get $slot)))
      (local.set $cls (call $ctrl_table_get_class (local.get $ch)))
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
      (if (i32.and (local.get $hit) (i32.eq (local.get $cls) (i32.const 1)))
        (then
          (local.set $style (call $wnd_get_style (local.get $ch)))
          (if (i32.eq (i32.and (local.get $style) (i32.const 0x0F)) (i32.const 7))
            (then (local.set $hit (i32.const 0))))))
      (if (local.get $hit)
        (then
          (local.set $ch_lp (i32.or
            (i32.and (i32.sub (local.get $px) (local.get $cx)) (i32.const 0xFFFF))
            (i32.shl
              (i32.and (i32.sub (local.get $py) (local.get $cy)) (i32.const 0xFFFF))
              (i32.const 16))))
          (drop (call $wnd_send_message (local.get $ch)
                  (local.get $msg) (local.get $wParam) (local.get $ch_lp)))
          (return (i32.const 1))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $walk)))
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
  (func $modal_begin (param $dlg i32) (param $esp_adjust i32)
    (global.set $modal_dlg_hwnd  (local.get $dlg))
    (global.set $modal_result    (i32.const 0))
    (global.set $modal_ret_addr  (call $gl32 (global.get $esp)))
    (global.set $modal_saved_esp (global.get $esp))
    (global.set $modal_esp_adjust (local.get $esp_adjust))
    (global.set $eip             (global.get $modal_loop_thunk))
    (global.set $yield_flag      (i32.const 1))
    (global.set $yield_reason    (i32.const 6))
    (global.set $steps           (i32.const 0)))

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
      (then (call $paint_queue_push (local.get $hwnd))))
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
  (func $create_findreplace_dialog (param $dlg i32) (param $owner i32) (param $fr_guest i32)
    (local $edit i32) (local $down i32)
    ;; Frame (renderer.windows[] entry, isFindDialog flag for hit-test path).
    ;; Same pattern as $create_about_dialog: WAT calls into JS via the
    ;; bare host_register_dialog_frame import — JS does no Win32 logic.
    (call $host_register_dialog_frame
      (local.get $dlg) (local.get $owner)
      (i32.const 0x1E3)   ;; "Find" title constant
      (i32.const 340) (i32.const 128)
      (i32.const 2))      ;; kind bit 1 = isFindDialog
    (call $wnd_table_set (local.get $dlg) (global.get $WNDPROC_CTRL_NATIVE))
    (call $title_table_set (local.get $dlg) (i32.const 0x1E3) (i32.const 4))
    (call $wnd_set_parent (local.get $dlg) (local.get $owner))
    (drop (call $wnd_set_style (local.get $dlg) (i32.const 0x80C80000)))
    ;; Tag the parent dialog as control class 10 so $control_wndproc_dispatch
    ;; routes WM_COMMAND from child buttons to $findreplace_wndproc.
    (call $ctrl_table_set (call $wnd_table_find (local.get $dlg))
      (i32.const 10) (i32.const 0))
    ;; Queue WM_NCPAINT + WM_ERASEBKGND on the registered slot so the main
    ;; GetMessageA loop dispatches chrome + background fill. Must run AFTER
    ;; wnd_table_set — nc_flags_set is a no-op when the slot doesn't exist.
    (call $nc_flags_set (local.get $dlg) (i32.const 3))  ;; bits 0+1
    (call $dlg_fill_bkgnd (local.get $dlg))
    ;; Static "Find what:"
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 3) (i32.const 0xFFFF)
            (i32.const 8) (i32.const 10) (i32.const 64) (i32.const 14)
            (i32.const 0x50000000)
            (call $wat_str_to_heap (i32.const 0x1A0) (i32.const 10))))
    ;; Edit (the one the test cares about)
    (local.set $edit (call $ctrl_create_child (local.get $dlg) (i32.const 2) (i32.const 0x480)
                       (i32.const 74) (i32.const 8) (i32.const 164) (i32.const 18)
                       (i32.const 0x50810000) (i32.const 0)))
    (global.set $findreplace_edit_hwnd (local.get $edit))
    ;; Match case checkbox
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 0x411)
            (i32.const 8) (i32.const 38) (i32.const 80) (i32.const 14)
            (i32.const 0x50010003)
            (call $wat_str_to_heap (i32.const 0x1AB) (i32.const 10))))
    ;; Direction groupbox + radios
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 0x440)
            (i32.const 128) (i32.const 28) (i32.const 110) (i32.const 38)
            (i32.const 0x50000007)
            (call $wat_str_to_heap (i32.const 0x1B6) (i32.const 9))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 0x420)
            (i32.const 136) (i32.const 40) (i32.const 42) (i32.const 14)
            (i32.const 0x50010009)
            (call $wat_str_to_heap (i32.const 0x1C0) (i32.const 2))))
    (local.set $down (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 0x421)
            (i32.const 184) (i32.const 40) (i32.const 48) (i32.const 14)
            (i32.const 0x50010009)
            (call $wat_str_to_heap (i32.const 0x1C3) (i32.const 4))))
    ;; Default: Down direction checked (matches Win98 Notepad Find dialog).
    (drop (call $wnd_send_message (local.get $down) (i32.const 0x00F1) (i32.const 1) (i32.const 0)))
    ;; Find Next + Cancel buttons
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 1)
            (i32.const 248) (i32.const 6) (i32.const 80) (i32.const 24)
            (i32.const 0x50010001)
            (call $wat_str_to_heap (i32.const 0x1C8) (i32.const 9))))
    (drop (call $ctrl_create_child (local.get $dlg) (i32.const 1) (i32.const 2)
            (i32.const 248) (i32.const 34) (i32.const 80) (i32.const 24)
            (i32.const 0x50010000)
            (call $wat_str_to_heap (i32.const 0x1D2) (i32.const 6))))
    ;; Stash FR struct ptr in dialog userdata for a future $wndproc_dialog.
    (drop (call $wnd_set_userdata (local.get $dlg) (local.get $fr_guest)))
    (global.set $findreplace_dlg_hwnd (local.get $dlg))
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
    (local.set $arrow (i32.const 16))
    (if (i32.lt_s (local.get $bh) (i32.const 36))
      (then (local.set $arrow (i32.const 0))))
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
        (local.set $track_y (i32.add (local.get $by) (local.get $arrow)))
        (local.set $track_h (i32.sub (local.get $bh) (i32.mul (local.get $arrow) (i32.const 2))))
        (if (i32.gt_s (local.get $track_h) (i32.const 0))
          (then
            (local.set $thumb_size (i32.div_u (local.get $track_h) (i32.add (local.get $range) (i32.const 1))))
            (if (i32.lt_u (local.get $thumb_size) (i32.const 16))
              (then (local.set $thumb_size (i32.const 16))))
            (if (i32.gt_u (local.get $thumb_size) (local.get $track_h))
              (then (local.set $thumb_size (local.get $track_h))))
            (local.set $thumb_pos
              (i32.add (local.get $track_y)
                (i32.div_u
                  (i32.mul (local.get $pos)
                           (i32.sub (local.get $track_h) (local.get $thumb_size)))
                  (local.get $range))))
            (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (local.get $bx) (local.get $thumb_pos)
                    (i32.add (local.get $bx) (local.get $bw))
                    (i32.add (local.get $thumb_pos) (local.get $thumb_size))
                    (i32.const 0x30011))) ;; LTGRAY_BRUSH
            (drop (call $host_gdi_draw_edge (local.get $hdc)
                    (local.get $bx) (local.get $thumb_pos)
                    (i32.add (local.get $bx) (local.get $bw))
                    (i32.add (local.get $thumb_pos) (local.get $thumb_size))
                    (i32.const 0x05) (i32.const 0x0F))))))) ;; BDR_RAISED, BF_RECT
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
  (func $listbox_page_hit
        (param $hwnd i32) (param $sw i32)
        (param $row_y i32) (param $h i32)
        (param $top i32) (param $max i32) (param $visible i32) (result i32)
    (local $arrow i32) (local $track_y i32) (local $track_h i32)
    (local $thumb_size i32) (local $thumb_pos i32) (local $new_top i32)
    (local.set $arrow (i32.const 16))
    (local.set $track_y (local.get $arrow))
    (local.set $track_h (i32.sub (local.get $h) (i32.mul (local.get $arrow) (i32.const 2))))
    (if (i32.le_s (local.get $track_h) (i32.const 0)) (then (return (i32.const 0))))
    (local.set $thumb_size (i32.div_u (local.get $track_h) (i32.add (local.get $max) (i32.const 1))))
    (if (i32.lt_u (local.get $thumb_size) (i32.const 16))
      (then (local.set $thumb_size (i32.const 16))))
    (if (i32.gt_u (local.get $thumb_size) (local.get $track_h))
      (then (local.set $thumb_size (local.get $track_h))))
    (local.set $thumb_pos
      (i32.add (local.get $track_y)
        (i32.div_u
          (i32.mul (local.get $top)
                   (i32.sub (local.get $track_h) (local.get $thumb_size)))
          (local.get $max))))
    (if (i32.lt_s (local.get $visible) (i32.const 1))
      (then (local.set $visible (i32.const 1))))
    (if (i32.lt_s (local.get $row_y) (local.get $thumb_pos))
      (then
        (local.set $new_top (i32.sub (local.get $top) (local.get $visible)))
        (if (i32.lt_s (local.get $new_top) (i32.const 0))
          (then (local.set $new_top (i32.const 0))))
        (i32.store offset=20 (local.get $sw) (local.get $new_top))
        (return (i32.const 1))))
    (if (i32.ge_s (local.get $row_y) (i32.add (local.get $thumb_pos) (local.get $thumb_size)))
      (then
        (local.set $new_top (i32.add (local.get $top) (local.get $visible)))
        (if (i32.gt_s (local.get $new_top) (local.get $max))
          (then (local.set $new_top (local.get $max))))
        (i32.store offset=20 (local.get $sw) (local.get $new_top))
        (return (i32.const 2))))
    ;; On the thumb — stash anchors for the drag loop.
    (i32.store offset=28 (local.get $sw) (local.get $row_y))
    (i32.store offset=32 (local.get $sw) (local.get $top))
    (i32.const 3))

  ;; Recompute top_index from the current cursor y during a thumb drag.
  ;; Anchors (drag_anchor_y at +28, drag_anchor_top at +32) were stashed
  ;; when the drag started. new_top = anchor_top + delta_y * max / range,
  ;; clamped to [0, max], where range = track_h - thumb_size. Uses the
  ;; same geometry as $paint_vscrollbar_rect.
  (func $listbox_drag_to
        (param $hwnd i32) (param $sw i32)
        (param $row_y i32) (param $h i32) (param $max i32)
    (local $arrow i32) (local $track_h i32)
    (local $thumb_size i32) (local $range i32)
    (local $anchor_y i32) (local $anchor_top i32)
    (local $delta i32) (local $new_top i32)
    (local.set $arrow (i32.const 16))
    (local.set $track_h (i32.sub (local.get $h) (i32.mul (local.get $arrow) (i32.const 2))))
    (if (i32.le_s (local.get $track_h) (i32.const 0)) (then (return)))
    (local.set $thumb_size (i32.div_u (local.get $track_h) (i32.add (local.get $max) (i32.const 1))))
    (if (i32.lt_u (local.get $thumb_size) (i32.const 16))
      (then (local.set $thumb_size (i32.const 16))))
    (if (i32.gt_u (local.get $thumb_size) (local.get $track_h))
      (then (local.set $thumb_size (local.get $track_h))))
    (local.set $range (i32.sub (local.get $track_h) (local.get $thumb_size)))
    (if (i32.le_s (local.get $range) (i32.const 0)) (then (return)))
    (local.set $anchor_y   (i32.load offset=28 (local.get $sw)))
    (local.set $anchor_top (i32.load offset=32 (local.get $sw)))
    (local.set $delta (i32.sub (local.get $row_y) (local.get $anchor_y)))
    (local.set $new_top
      (i32.add (local.get $anchor_top)
        (i32.div_s (i32.mul (local.get $delta) (local.get $max))
                   (local.get $range))))
    (if (i32.lt_s (local.get $new_top) (i32.const 0))
      (then (local.set $new_top (i32.const 0))))
    (if (i32.gt_s (local.get $new_top) (local.get $max))
      (then (local.set $new_top (local.get $max))))
    (i32.store offset=20 (local.get $sw) (local.get $new_top)))

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
    (local $is_pressed i32)

    ;; --- Mouse input: arrow buttons only (page regions / thumb drag TODO) ---
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
        ;; part: 0=none, 1=up, 2=down, 3=left, 4=right
        (local.set $part (i32.const 0))
        (if (local.get $arrow)
          (then
            (if (local.get $is_vert)
              (then
                (if (i32.lt_s (local.get $my) (local.get $arrow))
                  (then (local.set $part (i32.const 1))))
                (if (i32.ge_s (local.get $my) (i32.sub (local.get $h) (local.get $arrow)))
                  (then (local.set $part (i32.const 2)))))
              (else
                (if (i32.lt_s (local.get $mx) (local.get $arrow))
                  (then (local.set $part (i32.const 3))))
                (if (i32.ge_s (local.get $mx) (i32.sub (local.get $w) (local.get $arrow)))
                  (then (local.set $part (i32.const 4))))))))
        (if (local.get $part)
          (then
            (global.set $sb_pressed_hwnd (local.get $hwnd))
            (global.set $sb_pressed_part (local.get $part))
            (call $invalidate_hwnd (local.get $hwnd))
            ;; Send WM_VSCROLL (0x115) / WM_HSCROLL (0x114) to parent.
            ;; SB_LINEUP=0, SB_LINEDOWN=1, SB_LINELEFT=0, SB_LINERIGHT=1.
            (local.set $sb_code
              (select (i32.const 0) (i32.const 1)
                      (i32.or (i32.eq (local.get $part) (i32.const 1))
                              (i32.eq (local.get $part) (i32.const 3)))))
            (local.set $sb_msg (select (i32.const 0x115) (i32.const 0x114) (local.get $is_vert)))
            (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
            (drop (call $wnd_send_message (local.get $parent) (local.get $sb_msg)
                    (local.get $sb_code) (local.get $hwnd)))))
        (return (i32.const 0))))

    ;; WM_LBUTTONUP — clear pressed state, send SB_ENDSCROLL.
    (if (i32.eq (local.get $msg) (i32.const 0x0202))
      (then
        (if (i32.eq (global.get $sb_pressed_hwnd) (local.get $hwnd))
          (then
            (global.set $sb_pressed_hwnd (i32.const 0))
            (global.set $sb_pressed_part (i32.const 0))
            (call $invalidate_hwnd (local.get $hwnd))
            (local.set $style (call $wnd_get_style (local.get $hwnd)))
            (local.set $is_vert (i32.and (local.get $style) (i32.const 1)))
            (local.set $sb_msg (select (i32.const 0x115) (i32.const 0x114) (local.get $is_vert)))
            (local.set $parent (call $wnd_get_parent (local.get $hwnd)))
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
        (local.set $arrow (i32.const 16))
        (if (i32.lt_s (local.get $long_dim) (i32.const 36))
          (then (local.set $arrow (i32.const 0))))
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
                           (i32.eq (global.get $sb_pressed_part) (i32.const 3))))
                (call $draw_sb_arrow (local.get $hdc)
                  (i32.sub (local.get $w) (local.get $arrow)) (i32.const 0)
                  (local.get $arrow) (local.get $h)
                  (i32.const 3) ;; right
                  (i32.and (local.get $is_pressed)
                           (i32.eq (global.get $sb_pressed_part) (i32.const 4))))))))

        ;; Read scroll state
        (local.set $slot (call $wnd_table_find (local.get $hwnd)))
        (if (i32.ge_s (local.get $slot) (i32.const 0))
          (then
            (local.set $base (i32.add (global.get $SCROLL_TABLE)
              (i32.mul (local.get $slot) (i32.const 24))))
            ;; Vertical scrollbar: use offset +12
            (if (local.get $is_vert)
              (then (local.set $base (i32.add (local.get $base) (i32.const 12)))))
            (local.set $pos (i32.load (local.get $base)))
            (local.set $smin (i32.load offset=4 (local.get $base)))
            (local.set $smax (i32.load offset=8 (local.get $base)))
            (local.set $range (i32.sub (local.get $smax) (local.get $smin)))
            (if (i32.gt_s (local.get $range) (i32.const 0))
              (then
                ;; Track lives between the two arrow buttons (or +/-2px sunken
                ;; inset when arrows aren't drawn).
                (local.set $track_len
                  (i32.sub (local.get $long_dim)
                    (select (i32.mul (local.get $arrow) (i32.const 2))
                            (i32.const 4)
                            (local.get $arrow))))
                (local.set $thumb_size (i32.div_u (local.get $track_len) (i32.add (local.get $range) (i32.const 1))))
                (if (i32.lt_u (local.get $thumb_size) (i32.const 16))
                  (then (local.set $thumb_size (i32.const 16))))
                ;; Thumb position (origin = arrow_size, or 2 if no arrows)
                (local.set $thumb_pos
                  (i32.add (select (local.get $arrow) (i32.const 2) (local.get $arrow))
                    (i32.div_u
                      (i32.mul
                        (i32.sub (local.get $pos) (local.get $smin))
                        (i32.sub (local.get $track_len) (local.get $thumb_size)))
                      (local.get $range))))
                ;; Draw thumb
                (if (local.get $is_vert)
                  (then
                    ;; Vertical: thumb fills width, moves in Y
                    (drop (call $host_gdi_fill_rect (local.get $hdc)
                            (i32.const 2) (local.get $thumb_pos)
                            (i32.sub (local.get $w) (i32.const 2))
                            (i32.add (local.get $thumb_pos) (local.get $thumb_size))
                            (i32.const 0x30011))) ;; LTGRAY_BRUSH
                    (drop (call $host_gdi_draw_edge (local.get $hdc)
                            (i32.const 2) (local.get $thumb_pos)
                            (i32.sub (local.get $w) (i32.const 2))
                            (i32.add (local.get $thumb_pos) (local.get $thumb_size))
                            (i32.const 0x05) (i32.const 0x0F)))) ;; BDR_RAISED, BF_RECT
                  (else
                    ;; Horizontal: thumb fills height, moves in X
                    (drop (call $host_gdi_fill_rect (local.get $hdc)
                            (local.get $thumb_pos) (i32.const 2)
                            (i32.add (local.get $thumb_pos) (local.get $thumb_size))
                            (i32.sub (local.get $h) (i32.const 2))
                            (i32.const 0x30011))) ;; LTGRAY_BRUSH
                    (drop (call $host_gdi_draw_edge (local.get $hdc)
                            (local.get $thumb_pos) (i32.const 2)
                            (i32.add (local.get $thumb_pos) (local.get $thumb_size))
                            (i32.sub (local.get $h) (i32.const 2))
                            (i32.const 0x05) (i32.const 0x0F))))))))) ;; BDR_RAISED, BF_RECT
        (return (i32.const 0))))
    (i32.const 0))


