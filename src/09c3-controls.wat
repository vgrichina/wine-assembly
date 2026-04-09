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
  ;;                    4=ListBox, 5=ComboBox

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

  ;; ---- Control table helpers (legacy CONTROL_TABLE) ----

  ;; Set control class and ID for a window table slot
  (func $ctrl_table_set (param $slot i32) (param $class i32) (param $ctrl_id i32)
    (local $addr i32)
    (local.set $addr (i32.add (global.get $CONTROL_TABLE) (i32.mul (local.get $slot) (i32.const 16))))
    (i32.store (local.get $addr) (local.get $class))
    (i32.store (i32.add (local.get $addr) (i32.const 4)) (local.get $ctrl_id))
    (i32.store (i32.add (local.get $addr) (i32.const 8)) (i32.const 0))  ;; check_state = 0
    (i32.store (i32.add (local.get $addr) (i32.const 12)) (i32.const 0)) ;; reserved
  )

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

  ;; ---- Control WndProc dispatch ----

  ;; Dispatch to the correct control wndproc based on control class
  (func $control_wndproc_dispatch (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $class i32)
    (local.set $class (call $ctrl_table_get_class (local.get $hwnd)))
    ;; Class 1 = Button
    (if (i32.eq (local.get $class) (i32.const 1))
      (then (return (call $button_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Class 3 = Static
    (if (i32.eq (local.get $class) (i32.const 3))
      (then (return (call $static_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Other classes: return 0 (DefWindowProc)
    (i32.const 0)
  )

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
        (local.set $state (call $heap_alloc (i32.const 16)))
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
            (call $host_invalidate (local.get $hwnd))
            (return (i32.const 1)))) ;; TRUE
        (return (i32.const 0))))

    ;; ---------- WM_GETTEXT (0x000D) ----------
    ;; wParam = max chars (incl. NUL), lParam = guest dest buffer.
    (if (i32.eq (local.get $msg) (i32.const 0x000D))
      (then
        (if (i32.and (local.get $state) (i32.gt_u (local.get $wParam) (i32.const 0)))
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            (local.set $text_len (i32.load offset=4 (local.get $state_w)))
            ;; clamp to wParam-1
            (if (i32.ge_u (local.get $text_len) (local.get $wParam))
              (then (local.set $text_len (i32.sub (local.get $wParam) (i32.const 1)))))
            (if (i32.load (local.get $state_w))
              (then (call $memcpy (call $g2w (local.get $lParam))
                                  (call $g2w (i32.load (local.get $state_w)))
                                  (local.get $text_len))))
            (i32.store8 (i32.add (call $g2w (local.get $lParam)) (local.get $text_len)) (i32.const 0))
            (return (local.get $text_len))))
        (return (i32.const 0))))

    ;; ---------- WM_LBUTTONDOWN (0x0201) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0201))
      (then
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            (i32.store offset=8 (local.get $state_w)
              (i32.or (i32.load offset=8 (local.get $state_w)) (i32.const 0x01))) ;; pressed
            (call $host_invalidate (local.get $hwnd))))
        (return (i32.const 0))))

    ;; ---------- WM_LBUTTONUP (0x0202) ----------
    (if (i32.eq (local.get $msg) (i32.const 0x0202))
      (then
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            (local.set $flags (i32.load offset=8 (local.get $state_w)))
            ;; clear pressed
            (local.set $flags (i32.and (local.get $flags) (i32.const 0xFFFFFFFE)))
            ;; toggle checked for checkbox (kind 1) / radio (kind 2)
            (if (i32.or
                  (i32.eq (i32.and (i32.shr_u (local.get $flags) (i32.const 4)) (i32.const 0x0F)) (i32.const 1))
                  (i32.eq (i32.and (i32.shr_u (local.get $flags) (i32.const 4)) (i32.const 0x0F)) (i32.const 2)))
              (then (local.set $flags (i32.xor (local.get $flags) (i32.const 0x02)))))
            (i32.store offset=8 (local.get $state_w) (local.get $flags))
            (call $host_invalidate (local.get $hwnd))
            ;; TODO STEP 5: post WM_COMMAND(MAKEWPARAM(ctrl_id,BN_CLICKED), hwnd) to parent.
            ;; Needs $wnd_send_message helper that handles WAT-native + x86 wndprocs.
            ))
        (return (i32.const 0))))

    ;; ---------- WM_PAINT (0x000F) ----------
    ;; Compose a Win98 button face from GDI primitives. hdc encoding matches
    ;; BeginPaint: hwnd + 0x40000.
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $flags (i32.load offset=8 (local.get $state_w)))
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        (local.set $sz (call $host_get_window_client_size (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        ;; 1) Fill face with LTGRAY_BRUSH (stock object 1 = 0x30011)
        (drop (call $host_gdi_fill_rect (local.get $hdc)
                (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
                (i32.const 0x30011)))
        ;; 2) Bevel: BF_RECT(0x0F) | BDR_RAISEDOUTER(0x01)|BDR_RAISEDINNER(0x04) = 0x05
        ;;          or pressed: BDR_SUNKENOUTER(0x02)|BDR_SUNKENINNER(0x08) = 0x0A
        (local.set $edge_flags (select (i32.const 0x0A) (i32.const 0x05)
                                       (i32.and (local.get $flags) (i32.const 0x01))))
        (drop (call $host_gdi_draw_edge (local.get $hdc)
                (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
                (local.get $edge_flags) (i32.const 0x0F)))
        ;; 3) Centered text: gdi_draw_text needs a WASM-linear RECT (use PAINT_SCRATCH)
        ;;    and a WASM-linear text pointer (g2w(text_buf_ptr)).
        (if (i32.load (local.get $state_w))
          (then
            (local.set $text_w (call $g2w (i32.load (local.get $state_w))))
            (local.set $text_len (i32.load offset=4 (local.get $state_w)))
            (i32.store        (global.get $PAINT_SCRATCH) (i32.const 0))
            (i32.store offset=4  (global.get $PAINT_SCRATCH) (i32.const 0))
            (i32.store offset=8  (global.get $PAINT_SCRATCH) (local.get $w))
            (i32.store offset=12 (global.get $PAINT_SCRATCH) (local.get $h))
            ;; DT_CENTER(0x01)|DT_VCENTER(0x04)|DT_SINGLELINE(0x20) = 0x25
            (drop (call $host_gdi_draw_text (local.get $hdc)
                    (local.get $text_w) (local.get $text_len)
                    (global.get $PAINT_SCRATCH)
                    (i32.const 0x25) (i32.const 0)))))
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
            (call $host_invalidate (local.get $hwnd))
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
    (local $fmt i32)

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
            (call $host_invalidate (local.get $hwnd))
            (return (i32.const 1))))
        (return (i32.const 0))))

    ;; ---------- WM_PAINT ----------
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
        (local.set $state_w (call $g2w (local.get $state)))
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        (local.set $sz (call $host_get_window_client_size (local.get $hwnd)))
        (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
        (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
        ;; Background: dialog face color via LTGRAY_BRUSH
        (drop (call $host_gdi_fill_rect (local.get $hdc)
                (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
                (i32.const 0x30011)))
        (if (i32.load (local.get $state_w))
          (then
            ;; Map SS_LEFT/CENTER/RIGHT (low 4 bits of style) → DT_LEFT(0)/CENTER(1)/RIGHT(2)
            (local.set $style (i32.and (i32.load offset=8 (local.get $state_w)) (i32.const 0x0F)))
            (local.set $fmt (i32.const 0x24)) ;; DT_VCENTER|DT_SINGLELINE
            (if (i32.eq (local.get $style) (i32.const 1))
              (then (local.set $fmt (i32.or (local.get $fmt) (i32.const 0x01))))) ;; DT_CENTER
            (if (i32.eq (local.get $style) (i32.const 2))
              (then (local.set $fmt (i32.or (local.get $fmt) (i32.const 0x02))))) ;; DT_RIGHT
            (i32.store        (global.get $PAINT_SCRATCH) (i32.const 2))
            (i32.store offset=4  (global.get $PAINT_SCRATCH) (i32.const 0))
            (i32.store offset=8  (global.get $PAINT_SCRATCH) (local.get $w))
            (i32.store offset=12 (global.get $PAINT_SCRATCH) (local.get $h))
            (drop (call $host_gdi_draw_text (local.get $hdc)
                    (call $g2w (i32.load (local.get $state_w)))
                    (i32.load offset=4 (local.get $state_w))
                    (global.get $PAINT_SCRATCH)
                    (local.get $fmt) (i32.const 0)))))
        (return (i32.const 0))))

    ;; Default
    (i32.const 0)
  )

