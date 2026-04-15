  ;; ============================================================
  ;; WINDOW CREATION & MESSAGE DISPATCH HANDLERS
  ;; ============================================================

  ;; 67: CreateWindowExA
  (func $handle_CreateWindowExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $v i32) (local $i i32)
    ;; Auto-detect WndProc: scan code for WNDCLASSA setup referencing this className
    ;; Pattern: C7 44 24 XX [className] — the mov before it has the WndProc
    (if (i32.eqz (global.get $wndproc_addr))
    (then
    (local.set $i (global.get $GUEST_BASE))
    (local.set $v (i32.add (global.get $GUEST_BASE) (i32.const 0xA000)))
    (block $found (loop $scan
    (br_if $found (i32.ge_u (local.get $i) (local.get $v)))
    (if (i32.and
    (i32.eq (i32.load8_u (local.get $i)) (i32.const 0xC7))
    (i32.and
    (i32.eq (i32.load8_u (i32.add (local.get $i) (i32.const 1))) (i32.const 0x44))
    (i32.eq (i32.load8_u (i32.add (local.get $i) (i32.const 2))) (i32.const 0x24))))
    (then
    (if (i32.eq (i32.load (i32.add (local.get $i) (i32.const 4))) (local.get $arg1))
    (then
    (if (i32.and
    (i32.eq (i32.load8_u (i32.sub (local.get $i) (i32.const 8))) (i32.const 0xC7))
    (i32.eq (i32.load8_u (i32.sub (local.get $i) (i32.const 7))) (i32.const 0x44)))
    (then
    (local.set $tmp (i32.load (i32.sub (local.get $i) (i32.const 4))))
    (if (i32.and (i32.ge_u (local.get $tmp) (global.get $image_base))
    (i32.lt_u (local.get $tmp) (i32.add (global.get $image_base) (global.get $exe_size_of_image))))
    (then
    (global.set $wndproc_addr (local.get $tmp))
    (br $found)))))))))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $scan)))))
    ;; Set second wndproc for subsequent windows
    (if (i32.and (global.get $wndproc_addr) (i32.eqz (global.get $wndproc_addr2)))
    (then
    (if (global.get $main_hwnd)  ;; not the first window
    (then
    ;; Scan for second WndProc using same pattern
    (local.set $i (global.get $GUEST_BASE))
    (local.set $v (i32.add (global.get $GUEST_BASE) (i32.const 0xA000)))
    (block $found2 (loop $scan2
    (br_if $found2 (i32.ge_u (local.get $i) (local.get $v)))
    (if (i32.and
    (i32.eq (i32.load8_u (local.get $i)) (i32.const 0xC7))
    (i32.and
    (i32.eq (i32.load8_u (i32.add (local.get $i) (i32.const 1))) (i32.const 0x44))
    (i32.eq (i32.load8_u (i32.add (local.get $i) (i32.const 2))) (i32.const 0x24))))
    (then
    (if (i32.eq (i32.load (i32.add (local.get $i) (i32.const 4))) (local.get $arg1))
    (then
    (if (i32.and
    (i32.eq (i32.load8_u (i32.sub (local.get $i) (i32.const 8))) (i32.const 0xC7))
    (i32.eq (i32.load8_u (i32.sub (local.get $i) (i32.const 7))) (i32.const 0x44)))
    (then
    (local.set $tmp (i32.load (i32.sub (local.get $i) (i32.const 4))))
    (if (i32.and (i32.ge_u (local.get $tmp) (global.get $image_base))
    (i32.lt_u (local.get $tmp) (i32.add (global.get $image_base) (global.get $exe_size_of_image))))
    (then
    (global.set $wndproc_addr2 (local.get $tmp))
    (br $found2)))))))))
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br $scan2)))))))
    ;; Allocate HWND; first top-level window becomes main_hwnd
    (if (i32.eqz (global.get $main_hwnd))
    (then (global.set $main_hwnd (global.get $next_hwnd))))
    ;; Resolve menu: explicit hMenu arg wins; if 0, fall back to the class's
    ;; lpszMenuName (WNDCLASSA+32) when it's a MAKEINTRESOURCE integer
    ;; (high 16 bits zero). Real Win32 does the same fallback. Without it,
    ;; the JS renderer used to guess "first menu resource" which was wrong
    ;; for apps that have menu resources only for popup TrackPopupMenu use.
    (local.set $tmp (call $gl32 (i32.add (global.get $esp) (i32.const 40))))  ;; explicit hMenu
    (if (i32.eqz (local.get $tmp))
      (then
        (local.set $i (call $class_find_slot (call $class_name_key (local.get $arg1))))
        ;; Fallback: some EXEs pass a hard-coded class atom (e.g. EmPipe's
        ;; push 0x1F5) that doesn't match any atom the emulator allocated.
        ;; class_find_slot then returns -1. Walk the class table and pick
        ;; the first slot with an EXE-range wndproc AND a non-zero
        ;; lpszMenuName — matches the same heuristic the wndproc fallback
        ;; below uses, so menu routing lines up with message dispatch.
        (if (i32.lt_s (local.get $i) (i32.const 0))
          (then
            (local.set $i (i32.const 0))
            (block $mfound (loop $mscan
              (br_if $mfound (i32.ge_u (local.get $i) (global.get $MAX_CLASSES)))
              (local.set $v (i32.load offset=12 (call $class_record_addr (local.get $i)))) ;; lpfnWndProc
              (if (i32.and
                    (i32.and (i32.ge_u (local.get $v) (global.get $image_base))
                             (i32.lt_u (local.get $v) (i32.add (global.get $image_base) (global.get $exe_size_of_image))))
                    (i32.ne (i32.load offset=32 (call $class_wndclass_addr (local.get $i))) (i32.const 0)))
                (then (br $mfound)))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $mscan)))
            (if (i32.ge_u (local.get $i) (global.get $MAX_CLASSES))
              (then (local.set $i (i32.const -1))))))
        (if (i32.ge_s (local.get $i) (i32.const 0))
          (then
            (local.set $v (i32.load offset=32 (call $class_wndclass_addr (local.get $i)))) ;; lpszMenuName
            ;; Either MAKEINTRESOURCE (low 16-bit int) or a guest string
            ;; pointer naming the resource. $find_resource handles both
            ;; via $rsrc_find_entry's string-vs-id branch, so freecell-style
            ;; named menus work the same as integer-IDed ones.
            (if (i32.ne (local.get $v) (i32.const 0))
              (then (local.set $tmp (local.get $v))))))))
    ;; Call host: create_window(hwnd, style, x, y, cx, cy, title_ptr, menu_id)
    (drop (call $host_create_window
    (global.get $next_hwnd)                                    ;; hwnd
    (local.get $arg3)                                           ;; style
    (local.get $arg4)                                           ;; x
    (call $gl32 (i32.add (global.get $esp) (i32.const 24)))    ;; y
    (call $gl32 (i32.add (global.get $esp) (i32.const 28)))    ;; cx
    (call $gl32 (i32.add (global.get $esp) (i32.const 32)))    ;; cy
    (select (i32.const 0) (call $g2w (local.get $arg2)) (i32.eqz (local.get $arg2)))  ;; title_ptr (NULL→0)
    (local.get $tmp)                                            ;; resolved menu
    ))
    ;; Save resolved menu ID for nc_height calculation later ($tmp gets overwritten)
    (local.set $v (local.get $tmp))
    ;; Pass className to host so it knows the window type (e.g. "Edit")
    (call $host_set_window_class (global.get $next_hwnd) (call $g2w (local.get $arg1)))
    ;; Register hwnd→wndproc in window table (look up from class table by className)
    (local.set $tmp (call $class_table_lookup (call $class_name_key (local.get $arg1))))
    ;; If lookup failed and this isn't the first window, scan class table for an
    ;; EXE-range wndproc not already used by main_hwnd (handles rotating string
    ;; buffer mismatches where className was overwritten between RegisterClass and CreateWindow)
    (if (i32.and (i32.eqz (local.get $tmp)) (i32.ne (global.get $main_hwnd) (i32.const 0)))
      (then
        (local.set $i (i32.const 0))
        (block $found3 (loop $scan3
          (br_if $found3 (i32.ge_u (local.get $i) (global.get $MAX_CLASSES)))
          ;; Read WNDCLASSA.lpfnWndProc at class record + 12
          (local.set $v (i32.load offset=12 (call $class_record_addr (local.get $i))))
          (if (i32.and
            (i32.and (i32.ge_u (local.get $v) (global.get $image_base))
                     (i32.lt_u (local.get $v) (i32.add (global.get $image_base) (global.get $exe_size_of_image))))
            (i32.ne (local.get $v) (call $wnd_table_get (global.get $main_hwnd))))
            (then (local.set $tmp (local.get $v)) (br $found3)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $scan3)))))
    (if (local.get $tmp)
      (then (call $wnd_table_set (global.get $next_hwnd) (local.get $tmp)))
      (else
        ;; Check for system "Edit" class: atom 0x0081 or string "Edit"/"edit"/"EDIT"
        (if (i32.or
              (i32.eq (local.get $arg1) (i32.const 0x0081))
              (if (result i32) (i32.ge_u (local.get $arg1) (i32.const 0x10000))
                (then
                  ;; Case-insensitive 4-byte compare: OR with 0x20202020 → "edit" (LE: 0x74696465)
                  (i32.and
                    (i32.eq (i32.or (i32.load (call $g2w (local.get $arg1))) (i32.const 0x20202020))
                            (i32.const 0x74696465))
                    (i32.eqz (i32.load8_u (i32.add (call $g2w (local.get $arg1)) (i32.const 4))))))
                (else (i32.const 0))))
          (then
            ;; System Edit class → WAT-native edit control
            (call $wnd_table_set (global.get $next_hwnd) (global.get $WNDPROC_CTRL_NATIVE))
            (local.set $v (call $wnd_table_find (global.get $next_hwnd)))
            (call $ctrl_table_set (local.get $v) (i32.const 2)   ;; class=2 (Edit)
              (call $gl32 (i32.add (global.get $esp) (i32.const 40))))  ;; hMenu = ctrl_id for children
            (call $ctrl_geom_set (local.get $v)
              (local.get $arg4)                                          ;; x
              (call $gl32 (i32.add (global.get $esp) (i32.const 24)))   ;; y
              (call $gl32 (i32.add (global.get $esp) (i32.const 28)))   ;; cx
              (call $gl32 (i32.add (global.get $esp) (i32.const 32))))) ;; cy
          (else
            (call $wnd_table_set (global.get $next_hwnd) (global.get $WNDPROC_BUILTIN))))))
    ;; Store parent hwnd (hWndParent = [esp+36])
    (call $wnd_set_parent (global.get $next_hwnd)
      (call $gl32 (i32.add (global.get $esp) (i32.const 36))))
    ;; Store window style (dwStyle = arg3)
    (drop (call $wnd_set_style (global.get $next_hwnd) (local.get $arg3)))
    ;; Eagerly load the menu blob now that the WND_RECORDS slot exists —
    ;; otherwise a CheckMenuItem fired from WM_CREATE (e.g. FreeCell
    ;; initialising the Messages toggle) would see an empty blob and the
    ;; renderer's lazy _ensureWatMenu would later reload fresh bytes,
    ;; wiping the check state. $menu_load is idempotent: if the blob is
    ;; already installed, it returns early.
    (if (local.get $v)
      (then (call $menu_load (global.get $next_hwnd) (local.get $v))))
    ;; Send WM_CREATE synchronously for main window OR top-level windows with EXE-space wndproc.
    ;; Child windows (hWndParent != 0) use the pending_child_create/size path instead,
    ;; because the synchronous path overwrites pending_wm_size with child dimensions.
    (if (i32.and
      (i32.or
        (i32.eq (global.get $next_hwnd) (global.get $main_hwnd))
        (i32.and
          (i32.and (i32.ge_u (local.get $tmp) (global.get $image_base))
                   (i32.lt_u (local.get $tmp) (i32.add (global.get $image_base) (i32.const 0x200000))))
          (i32.ne (local.get $tmp) (i32.const 0))))
      (i32.eqz (call $gl32 (i32.add (global.get $esp) (i32.const 36)))))
    (then
    ;; Store window outer dimensions for WM_SIZE delivery later
    ;; Handle CW_USEDEFAULT (0x80000000) — use defaults matching renderer (400x300).
    ;; When cx=CW_USEDEFAULT, Windows ignores cy and defaults both — so also default cy.
    (global.set $main_win_cx (call $gl32 (i32.add (global.get $esp) (i32.const 28))))
    (global.set $main_win_cy (call $gl32 (i32.add (global.get $esp) (i32.const 32))))
    (if (i32.eq (global.get $main_win_cx) (i32.const 0x80000000))
      (then (global.set $main_win_cx (i32.const 400))
            (global.set $main_win_cy (i32.const 300))))
    (if (i32.eq (global.get $main_win_cy) (i32.const 0x80000000))
      (then (global.set $main_win_cy (i32.const 300))))
    ;; $v holds the resolved menu ID (from hMenu param or class lpszMenuName fallback)
    (global.set $main_nc_height (select (i32.const 45) (i32.const 25)
      (i32.ne (local.get $v) (i32.const 0))))
    (global.set $pending_wm_size (i32.or
      (i32.and (i32.sub (global.get $main_win_cx) (i32.const 6)) (i32.const 0xFFFF))
      (i32.shl (i32.sub (global.get $main_win_cy) (global.get $main_nc_height)) (i32.const 16))))
    ;; Save state for continuation thunk
    (global.set $createwnd_saved_hwnd (global.get $next_hwnd))
    (global.set $createwnd_saved_ret (call $gl32 (global.get $esp)))
    ;; Build CREATESTRUCT at scratch address image_base+0x100 (in DOS header area,
    ;; safe to overwrite). BEFORE cleaning frame — need stack args at esp+24..esp+48.
    ;; CREATESTRUCT: lpCreateParams(+0), hInstance(+4), hMenu(+8), hwndParent(+12),
    ;;   cy(+16), cx(+20), y(+24), x(+28), style(+32), lpszName(+36), lpszClass(+40), dwExStyle(+44)
    (call $gs32 (i32.add (global.get $image_base) (i32.const 0x100)) (call $gl32 (i32.add (global.get $esp) (i32.const 48)))) ;; lpCreateParams
    (call $gs32 (i32.add (global.get $image_base) (i32.const 0x104)) (call $gl32 (i32.add (global.get $esp) (i32.const 44)))) ;; hInstance
    (call $gs32 (i32.add (global.get $image_base) (i32.const 0x108)) (call $gl32 (i32.add (global.get $esp) (i32.const 40)))) ;; hMenu
    (call $gs32 (i32.add (global.get $image_base) (i32.const 0x10c)) (call $gl32 (i32.add (global.get $esp) (i32.const 36)))) ;; hwndParent
    (call $gs32 (i32.add (global.get $image_base) (i32.const 0x110)) (global.get $main_win_cy))                               ;; cy
    (call $gs32 (i32.add (global.get $image_base) (i32.const 0x114)) (global.get $main_win_cx))                               ;; cx
    (call $gs32 (i32.add (global.get $image_base) (i32.const 0x118)) (call $gl32 (i32.add (global.get $esp) (i32.const 24)))) ;; y
    (call $gs32 (i32.add (global.get $image_base) (i32.const 0x11c)) (local.get $arg4))                                       ;; x
    (call $gs32 (i32.add (global.get $image_base) (i32.const 0x120)) (local.get $arg3))                                       ;; style
    (call $gs32 (i32.add (global.get $image_base) (i32.const 0x124)) (local.get $arg2))                                       ;; lpszName
    (call $gs32 (i32.add (global.get $image_base) (i32.const 0x128)) (local.get $arg1))                                       ;; lpszClass
    (call $gs32 (i32.add (global.get $image_base) (i32.const 0x12c)) (local.get $arg0))                                       ;; dwExStyle
    ;; Clean CreateWindowExA frame (ret + 12 args = 52 bytes stdcall)
    (global.set $esp (i32.add (global.get $esp) (i32.const 52)))
    ;; If CBT hook is installed, call it first; it will chain to WM_CREATE via thunk
    (if (global.get $cbt_hook_proc)
    (then
    ;; Build CBT_CREATEWND at image_base+0x140 = { lpcs=&CREATESTRUCT, hwndInsertAfter=0 }
    (call $gs32 (i32.add (global.get $image_base) (i32.const 0x140)) (i32.add (global.get $image_base) (i32.const 0x100)))  ;; lpcs
    (call $gs32 (i32.add (global.get $image_base) (i32.const 0x144)) (i32.const 0))         ;; hwndInsertAfter = HWND_TOP
    ;; Push hook args (stdcall, 12 bytes): lParam, wParam, nCode
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.add (global.get $image_base) (i32.const 0x140)))     ;; lParam = &CBT_CREATEWND
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $next_hwnd))  ;; wParam = hwnd
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 3))            ;; nCode = HCBT_CREATEWND
    ;; Push CBT hook continuation thunk as return address
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $cbt_hook_ret_thunk))
    ;; Jump to CBT hook proc
    (global.set $eip (global.get $cbt_hook_proc))
    )
    (else
    ;; No CBT hook — dispatch WM_CREATE directly
    ;; Save hwnd+ret on stack below WndProc args (for nested CreateWindowExA)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $createwnd_saved_hwnd))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $createwnd_saved_ret))
    ;; Push WndProc args: lParam, wParam, msg, hwnd
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.add (global.get $image_base) (i32.const 0x100)))             ;; lParam = &CREATESTRUCT
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0))                    ;; wParam = 0
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0x0001))               ;; WM_CREATE
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $next_hwnd))          ;; hwnd
    ;; Push continuation thunk as return address
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $createwnd_ret_thunk))
    ;; Jump to WndProc (use class wndproc from lookup, not global wndproc_addr)
    (global.set $eip (local.get $tmp))
    ))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (global.set $steps (i32.const 0))
    (return))
    (else
    ;; Child window: flag pending WM_CREATE + WM_SIZE (delivered before main WM_SIZE)
    (global.set $pending_child_create (global.get $next_hwnd))
    (global.set $pending_child_size_hwnd (global.get $next_hwnd))
    (global.set $pending_child_size (i32.or
      (i32.and (call $gl32 (i32.add (global.get $esp) (i32.const 28))) (i32.const 0xFFFF))
      (i32.shl (call $gl32 (i32.add (global.get $esp) (i32.const 32))) (i32.const 16))))
    (call $paint_queue_push (global.get $next_hwnd))
    ))
    (global.set $eax (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 52))) (return)
  )

  ;; 68: CreateDialogParamA
  (func $handle_CreateDialogParamA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret_addr i32) (local $hwnd i32) (local $dlg_wndproc i32)
    (local $ctrl_count i32) (local $i i32) (local $ctrl_hwnd i32) (local $dlg_rec i32)
    ;; Allocate HWND from next_hwnd
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    ;; Save dialog hwnd for IsChild/SendMessage routing
    (global.set $dlg_hwnd (local.get $hwnd))
    ;; Clear quit_flag — dialog recreation (e.g. calc mode switch) cancels pending quit
    (global.set $quit_flag (i32.const 0))
    ;; Resolve the dialog's wndproc: prefer the supplied DlgProc (arg3); if
    ;; NULL, fall back to a registered class wndproc (calc.exe's RT_DIALOG
    ;; template specifies class="SciCalc" and passes NULL DlgProc — without
    ;; this fallback, $wnd_send_message(dlg, WM_DRAWITEM) from owner-draw
    ;; buttons finds a 0 wndproc and drops the message).
    (local.set $dlg_wndproc (local.get $arg3))
    (if (i32.eqz (local.get $dlg_wndproc))
      (then
        (if (global.get $wndproc_addr2)
          (then (local.set $dlg_wndproc (global.get $wndproc_addr2)))
          (else (local.set $dlg_wndproc (global.get $wndproc_addr))))))
    ;; Register dialog in wnd_table BEFORE $dlg_load so the walker can
    ;; find its slot for WND_DLG_RECORDS. SendMessageA routing looks at
    ;; this slot.
    (call $wnd_table_set (local.get $hwnd) (local.get $dlg_wndproc))
    ;; Record parent hwnd so GetParent returns the hosting window —
    ;; winamp's setup wizard calls GetParent(child_dlg) then
    ;; SetWindowText(parent, "Winamp Setup: ...") to set the outer title.
    (call $wnd_set_parent (local.get $hwnd) (local.get $arg2))
    ;; Parse RT_DIALOG template entirely in WAT: allocates child HWNDs,
    ;; fills CONTROL_TABLE + CONTROL_GEOM, sends WM_CREATE to each
    ;; control, stashes header state in WND_DLG_RECORDS[slot]. Handles
    ;; both integer template IDs and guest string pointers (named
    ;; entries) via $find_resource.
    (drop (call $dlg_load (local.get $hwnd) (local.get $arg1)))
    ;; Tell the renderer the dialog has been loaded; it builds its JS
    ;; window object by reading header + control state via the dlg_* /
    ;; ctrl_* exports. No template parsing on the JS side.
    (call $host_dialog_loaded (local.get $hwnd) (local.get $arg2))
    ;; Fill dialog client area with COLOR_BTNFACE (see DialogBoxParamA
    ;; for rationale — template DlgProcs rarely handle WM_PAINT).
    (call $dlg_fill_bkgnd (local.get $hwnd))
    ;; Enqueue WM_PAINT for each child control. Without this, owner-draw
    ;; buttons never receive their first WM_PAINT and so never post
    ;; WM_DRAWITEM to the dialog proc — calc.exe's 30-button keypad
    ;; would stay invisible after ShowWindow(dlg).
    (local.set $dlg_rec (call $dlg_record_for_hwnd (local.get $hwnd)))
    (if (local.get $dlg_rec)
      (then
        (local.set $ctrl_count (i32.load offset=28 (local.get $dlg_rec)))
        (local.set $i (i32.const 0))
        (block $done (loop $push_loop
          (br_if $done (i32.ge_u (local.get $i) (local.get $ctrl_count)))
          (local.set $ctrl_hwnd (i32.add (local.get $hwnd) (i32.add (local.get $i) (i32.const 1))))
          (call $paint_queue_push (local.get $ctrl_hwnd))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $push_loop)))))
    ;; If dlgProc is provided, dispatch WM_INITDIALOG
    (if (local.get $arg3)
      (then
        ;; Save return address for CACA0001 continuation
        (local.set $ret_addr (call $gl32 (global.get $esp)))
        ;; Pop CreateDialogParamA frame (ret + 5 args = 24 bytes)
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        ;; Push saved_ret + hwnd for CACA0001 continuation (below DlgProc args)
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (local.get $hwnd))  ;; saved_hwnd (eax after CACA0001)
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (local.get $ret_addr))  ;; saved_ret
        ;; Push DlgProc args: hwnd, WM_INITDIALOG(0x110), 0, lParam
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (local.get $arg4))  ;; lParam
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (i32.const 0))  ;; wParam (focus hwnd)
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (i32.const 0x110))  ;; WM_INITDIALOG
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (local.get $hwnd))  ;; hwnd
        ;; Push CACA0001 (createwnd_ret_thunk) as return address
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $createwnd_ret_thunk))
        ;; Jump to dialog proc
        (global.set $eip (local.get $arg3))
        (global.set $steps (i32.const 0))
        (return)))
    ;; No dlgProc — just return hwnd
    (global.set $eax (local.get $hwnd))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 69: MessageBoxA
  (func $handle_MessageBoxA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $w1 i32)
    ;; Disambiguate MessageBoxA vs MessageBeep
    (if (i32.eq (local.get $w1) (i32.const 0x42656761)) ;; "ageB" — MessageB...
    (then
    (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 8))) (i32.const 0x65)) ;; "e" — MessageBe(ep)
    (then ;; MessageBeep(1)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))))
    ;; MessageBoxA(4)
    (global.set $eax (call $host_message_box (local.get $arg0)
    (call $g2w (local.get $arg1)) (call $g2w (local.get $arg2)) (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 70: MessageBeep(uType) — play system sound via host
  (func $handle_MessageBeep (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_message_beep (local.get $arg0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 71: ShowWindow
  (func $handle_ShowWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $packed i32) (local $wndproc i32) (local $client_size i32)
    (local.set $client_size (call $host_show_window (local.get $arg0) (local.get $arg1)))
    ;; Showing a window should trigger WM_PAINT — invalidate it
    ;; cmd != SW_HIDE (0) → mark for paint
    (if (local.get $arg1)
      (then
        (if (i32.eq (local.get $arg0) (global.get $main_hwnd))
          (then (global.set $paint_pending (i32.const 1)))
          (else (call $paint_queue_push (local.get $arg0))))))
    ;; ShowWindow on main window delivers WM_SIZE synchronously,
    ;; matching real Win32 where ShowWindow → SetWindowPos → WM_SIZE.
    ;; For SW_MAXIMIZE (cmd=3), use the client size returned by the host
    ;; (which has already resized the window). Otherwise use pending_wm_size.
    (if (i32.and (i32.ne (local.get $arg1) (i32.const 0))
                 (i32.eq (local.get $arg0) (global.get $main_hwnd)))
      (then
        (if (i32.eq (local.get $arg1) (i32.const 3))
          (then
            (local.set $packed (local.get $client_size))
            (global.set $pending_wm_size (i32.const 0)))
          (else
            (local.set $packed (global.get $pending_wm_size))
            (global.set $pending_wm_size (i32.const 0))))
        (if (local.get $packed)
          (then
            (local.set $wndproc (call $wnd_table_get (global.get $main_hwnd)))
            (if (i32.and (i32.ne (local.get $wndproc) (i32.const 0))
                         (i32.lt_u (local.get $wndproc) (i32.const 0xFFFF0000)))
              (then
                ;; Redirect EIP to wndproc with WM_SIZE args, return to ShowWindow's caller.
                (global.set $esp (i32.add (global.get $esp) (i32.const 12))) ;; pop ShowWindow frame
                (global.set $esp (i32.sub (global.get $esp) (i32.const 20)))
                (call $gs32 (global.get $esp) (call $gl32 (i32.add (global.get $esp) (i32.const 8)))) ;; ret addr
                (call $gs32 (i32.add (global.get $esp) (i32.const 4)) (global.get $main_hwnd))
                (call $gs32 (i32.add (global.get $esp) (i32.const 8)) (i32.const 0x0005)) ;; WM_SIZE
                (call $gs32 (i32.add (global.get $esp) (i32.const 12)) (i32.const 0))     ;; wParam=SIZE_RESTORED
                (call $gs32 (i32.add (global.get $esp) (i32.const 16)) (local.get $packed)) ;; lParam=cx|(cy<<16)
                (global.set $eip (local.get $wndproc))
                (global.set $eax (i32.const 1))
                (global.set $steps (i32.const 0))
                (return)))))))
    ;; Deliver pending MoveWindow WM_SIZE for non-main windows
    (if (i32.and (i32.ne (local.get $arg1) (i32.const 0))
                 (i32.eq (local.get $arg0) (global.get $movewindow_pending_hwnd)))
      (then
        (local.set $packed (global.get $movewindow_pending_size))
        (global.set $movewindow_pending_hwnd (i32.const 0))
        (global.set $movewindow_pending_size (i32.const 0))
        (if (local.get $packed)
          (then
            (local.set $wndproc (call $wnd_table_get (local.get $arg0)))
            (if (i32.and (i32.ge_u (local.get $wndproc) (global.get $image_base))
                         (i32.lt_u (local.get $wndproc) (i32.add (global.get $image_base) (i32.const 0x200000))))
              (then
                (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
                (global.set $esp (i32.sub (global.get $esp) (i32.const 20)))
                (call $gs32 (global.get $esp) (call $gl32 (i32.add (global.get $esp) (i32.const 8))))
                (call $gs32 (i32.add (global.get $esp) (i32.const 4)) (local.get $arg0))
                (call $gs32 (i32.add (global.get $esp) (i32.const 8)) (i32.const 0x0005))
                (call $gs32 (i32.add (global.get $esp) (i32.const 12)) (i32.const 0))
                (call $gs32 (i32.add (global.get $esp) (i32.const 16)) (local.get $packed))
                (global.set $eip (local.get $wndproc))
                (global.set $eax (i32.const 1))
                (global.set $steps (i32.const 0))
                (return)))))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 72: UpdateWindow
  (func $handle_UpdateWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_invalidate (local.get $arg0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 73: GetMessageA
  (func $handle_GetMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $msg_ptr i32) (local $packed i32)
    (local.set $msg_ptr (local.get $arg0))
    ;; If quit flag set, return 0 (WM_QUIT)
    (if (global.get $quit_flag)
    (then
    ;; Fill MSG with WM_QUIT (0x0012)
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))          ;; hwnd
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0012)) ;; message=WM_QUIT
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))      ;; wParam
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))     ;; lParam
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Main WM_CREATE is now sent synchronously during CreateWindowExA (not deferred)
    ;; Deliver child WM_CREATE between main WM_CREATE and main WM_SIZE
    (if (global.get $pending_child_create)
    (then
    (local.set $tmp (global.get $pending_child_create))
    (global.set $pending_child_create (i32.const 0))
    (call $gs32 (local.get $msg_ptr) (local.get $tmp))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0001)) ;; WM_CREATE
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Deliver child WM_SIZE after child WM_CREATE
    (if (global.get $pending_child_size)
    (then
    (local.set $packed (global.get $pending_child_size))
    (global.set $pending_child_size (i32.const 0))
    (call $gs32 (local.get $msg_ptr) (global.get $pending_child_size_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0005)) ;; WM_SIZE
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (local.get $packed))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Drain posted message queue BEFORE pending WM_SIZE — apps like Solitaire
    ;; PostMessage(WM_COMMAND, Deal) during WM_CREATE to create game objects,
    ;; and the subsequent WM_SIZE needs those objects to exist for layout.
    (if (i32.gt_u (global.get $post_queue_count) (i32.const 0))
    (then
    ;; Dequeue first message (shift queue down)
    (local.set $tmp (i32.const 0x400))
    (call $gs32 (local.get $msg_ptr) (i32.load (local.get $tmp)))                        ;; hwnd
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.load (i32.add (local.get $tmp) (i32.const 4))))  ;; msg
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.load (i32.add (local.get $tmp) (i32.const 8))))  ;; wParam
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.load (i32.add (local.get $tmp) (i32.const 12)))) ;; lParam
    ;; Shift remaining messages down
    (global.set $post_queue_count (i32.sub (global.get $post_queue_count) (i32.const 1)))
    (if (i32.gt_u (global.get $post_queue_count) (i32.const 0))
    (then (call $memcpy (i32.const 0x400) (i32.const 0x410)
    (i32.mul (global.get $post_queue_count) (i32.const 16)))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Deliver pending WM_SIZE after posted messages are drained
    (if (global.get $pending_wm_size)
    (then
    (local.set $packed (global.get $pending_wm_size))
    (global.set $pending_wm_size (i32.const 0))
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0005)) ;; WM_SIZE
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))      ;; SIZE_RESTORED
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (local.get $packed)) ;; lParam=cx|(cy<<16)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Phase 0: send WM_ACTIVATEAPP (DirectDraw games gate on this to set bActive flag)
    (if (i32.eqz (global.get $msg_phase))
    (then
    (global.set $msg_phase (i32.const 1))
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x001C)) ;; WM_ACTIVATEAPP
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 1))      ;; TRUE (activating)
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))     ;; lParam = thread ID
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Phase 1: send WM_ACTIVATE (game needs activation before paint)
    (if (i32.eq (global.get $msg_phase) (i32.const 1))
    (then
    (global.set $msg_phase (i32.const 2))
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0006)) ;; WM_ACTIVATE
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 1))      ;; WA_ACTIVE
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (global.get $main_hwnd)) ;; lParam (non-zero)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Phase 2: send WM_SETFOCUS (pinball gates its game-running flag on this;
    ;; without it the game sits in a modal GetMessage loop and never animates)
    (if (i32.eq (global.get $msg_phase) (i32.const 2))
    (then
    (global.set $msg_phase (i32.const 3))
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0007)) ;; WM_SETFOCUS
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))      ;; hwndLoseFocus
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
    ;; (Pinball flag poke moved to PeekMessageA handler below)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Phase 3: send WM_ERASEBKGND (wParam = hdc)
    (if (i32.eq (global.get $msg_phase) (i32.const 3))
    (then
    (global.set $msg_phase (i32.const 4))
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0014)) ;; WM_ERASEBKGND
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.add (global.get $main_hwnd) (i32.const 0x40000))) ;; wParam = hdc
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Phase 4: send WM_PAINT
    (if (i32.eq (global.get $msg_phase) (i32.const 4))
    (then
    (global.set $msg_phase (i32.const 5))
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x000F)) ;; WM_PAINT
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Poll for input events — consume pending cache first, then host
    (if (i32.ne (global.get $pending_input_packed) (i32.const 0))
      (then
        (local.set $packed (global.get $pending_input_packed))
        (global.set $pending_input_packed (i32.const 0)))
      (else
        (local.set $packed (call $host_check_input))
        (if (i32.ne (local.get $packed) (i32.const 0))
          (then
            (global.set $pending_input_hwnd (call $host_check_input_hwnd))
            (global.set $pending_input_lparam (call $host_check_input_lparam))))))
    (if (i32.ne (local.get $packed) (i32.const 0))
    (then
    (local.set $tmp (global.get $pending_input_hwnd))
    (if (i32.eqz (local.get $tmp))
    (then (local.set $tmp (global.get $main_hwnd))))
    (call $gs32 (local.get $msg_ptr) (local.get $tmp))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4))
    (i32.and (local.get $packed) (i32.const 0xFFFF)))            ;; msg
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8))
    (i32.shr_u (local.get $packed) (i32.const 16)))              ;; wParam
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12))
    (global.get $pending_input_lparam))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; No input — deliver WM_PAINT if pending (lowest priority per Win32 spec)
    (if (global.get $paint_pending)
    (then
    (global.set $paint_pending (i32.const 0))
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x000F)) ;; WM_PAINT
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Deliver WM_PAINT to child window from paint queue
    (local.set $tmp (call $paint_queue_pop))
    (if (local.get $tmp)
    (then
    (call $gs32 (local.get $msg_ptr) (local.get $tmp))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x000F)) ;; WM_PAINT
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; No paint — deliver WM_TIMER if any timer is due (consume=1 for GetMessage)
    (if (call $timer_check_due (local.get $msg_ptr) (i32.const 1))
    (then
    (global.set $yield_flag (i32.const 1)) ;; yield to host after each timer
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; No timer due — return WM_NULL and yield to let browser process input events
    (global.set $yield_flag (i32.const 1))
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0))  ;; WM_NULL
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 74: PeekMessageA(lpMsg, hWnd, wMsgFilterMin, wMsgFilterMax, wRemoveMsg)
  ;; Returns 0 = no message available (non-blocking)
  (func $handle_PeekMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $packed i32) (local $msg i32) (local $tmp i32)
    ;; Deliver pending child WM_CREATE
    (if (global.get $pending_child_create)
    (then
    (local.set $tmp (global.get $pending_child_create))
    (if (i32.and (local.get $arg4) (i32.const 1)) ;; PM_REMOVE
      (then (global.set $pending_child_create (i32.const 0))))
    (call $gs32 (local.get $arg0) (local.get $tmp))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0x0001)) ;; WM_CREATE
    (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
    ;; Deliver pending child WM_SIZE
    (if (global.get $pending_child_size)
    (then
    (local.set $packed (global.get $pending_child_size))
    (if (i32.and (local.get $arg4) (i32.const 1))
      (then (global.set $pending_child_size (i32.const 0))))
    (call $gs32 (local.get $arg0) (global.get $pending_child_size_hwnd))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0x0005)) ;; WM_SIZE
    (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (local.get $packed))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
    ;; Deliver pending WM_SIZE for main window
    (if (global.get $pending_wm_size)
    (then
    (local.set $packed (global.get $pending_wm_size))
    (if (i32.and (local.get $arg4) (i32.const 1))
      (then (global.set $pending_wm_size (i32.const 0))))
    (call $gs32 (local.get $arg0) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0x0005)) ;; WM_SIZE
    (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (local.get $packed))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
    ;; Phase-based initial message delivery (same as GetMessageA)
    ;; Only deliver if main window exists
    ;; Phase 0: WM_ACTIVATEAPP
    (if (i32.and (i32.eqz (global.get $msg_phase)) (i32.ne (global.get $main_hwnd) (i32.const 0)))
    (then
    (if (i32.and (local.get $arg4) (i32.const 1)) (then (global.set $msg_phase (i32.const 1))))
    (call $gs32 (local.get $arg0) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0x001C)) ;; WM_ACTIVATEAPP
    (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (i32.const 1))      ;; TRUE
    (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
    ;; Phase 1: WM_ACTIVATE
    (if (i32.eq (global.get $msg_phase) (i32.const 1))
    (then
    (if (i32.and (local.get $arg4) (i32.const 1)) (then (global.set $msg_phase (i32.const 2))))
    (call $gs32 (local.get $arg0) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0x0006)) ;; WM_ACTIVATE
    (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (i32.const 1))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (global.get $main_hwnd))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
    ;; Phase 2: WM_ERASEBKGND
    (if (i32.eq (global.get $msg_phase) (i32.const 2))
    (then
    (if (i32.and (local.get $arg4) (i32.const 1)) (then (global.set $msg_phase (i32.const 3))))
    (call $gs32 (local.get $arg0) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0x0014)) ;; WM_ERASEBKGND
    (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (i32.add (global.get $main_hwnd) (i32.const 0x40000)))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
    ;; Phase 3: WM_PAINT
    (if (i32.eq (global.get $msg_phase) (i32.const 3))
    (then
    (if (i32.and (local.get $arg4) (i32.const 1)) (then (global.set $msg_phase (i32.const 4))))
    (call $gs32 (local.get $arg0) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0x000F)) ;; WM_PAINT
    (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
    ;; Check posted message queue
    (if (i32.gt_u (global.get $post_queue_count) (i32.const 0))
      (then
        ;; Dequeue into lpMsg
        (call $gs32 (local.get $arg0) (i32.load (i32.const 0x400)))                        ;; hwnd
        (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.load (i32.const 0x404)))  ;; msg
        (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (i32.load (i32.const 0x408)))  ;; wParam
        (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (i32.load (i32.const 0x40C))) ;; lParam
        ;; If PM_REMOVE (arg4 & 1), shift queue
        (if (i32.and (local.get $arg4) (i32.const 1))
          (then
            (global.set $post_queue_count (i32.sub (global.get $post_queue_count) (i32.const 1)))
            (if (i32.gt_u (global.get $post_queue_count) (i32.const 0))
              (then (call $memcpy (i32.const 0x400) (i32.const 0x410)
                (i32.mul (global.get $post_queue_count) (i32.const 16)))))
          )
        )
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; stdcall, 5 args
        (return)
      )
    )
    ;; Poll host for input events (with PM_NOREMOVE cache)
    ;; host_check_input always dequeues from JS. To support PM_NOREMOVE,
    ;; we cache the event in WAT globals; a subsequent PM_REMOVE consumes the cache.
    (if (i32.ne (global.get $pending_input_packed) (i32.const 0))
      (then
        ;; Cached event from a previous PM_NOREMOVE call
        (local.set $packed (global.get $pending_input_packed))
        ;; If PM_REMOVE, consume the cache
        (if (i32.and (local.get $arg4) (i32.const 1))
          (then (global.set $pending_input_packed (i32.const 0)))))
      (else
        ;; No cache — fetch from JS
        (local.set $packed (call $host_check_input))
        (if (i32.ne (local.get $packed) (i32.const 0))
          (then
            ;; Save hwnd and lparam immediately (only valid until next host_check_input)
            (global.set $pending_input_hwnd (call $host_check_input_hwnd))
            (global.set $pending_input_lparam (call $host_check_input_lparam))
            ;; If PM_NOREMOVE, keep the cache for next call
            (if (i32.eqz (i32.and (local.get $arg4) (i32.const 1)))
              (then (global.set $pending_input_packed (local.get $packed))))))))
    (if (i32.ne (local.get $packed) (i32.const 0))
      (then
        (local.set $msg (i32.and (local.get $packed) (i32.const 0xFFFF)))
        ;; Check message filter range (0,0 = accept all)
        (if (i32.or (i32.and (i32.eqz (local.get $arg2)) (i32.eqz (local.get $arg3)))
              (i32.and (i32.ge_u (local.get $msg) (local.get $arg2))
                       (i32.le_u (local.get $msg) (local.get $arg3))))
          (then
            (local.set $tmp (global.get $pending_input_hwnd))
            (if (i32.eqz (local.get $tmp))
              (then (local.set $tmp (global.get $main_hwnd))))
            (call $gs32 (local.get $arg0) (local.get $tmp))
            (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (local.get $msg))
            (call $gs32 (i32.add (local.get $arg0) (i32.const 8))
              (i32.shr_u (local.get $packed) (i32.const 16)))
            (call $gs32 (i32.add (local.get $arg0) (i32.const 12))
              (global.get $pending_input_lparam))
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
            (return)
          )
        )
      )
    )
    ;; WM_PAINT if pending (lowest priority)
    (if (global.get $paint_pending)
    (then
    (if (i32.and (local.get $arg4) (i32.const 1))
      (then (global.set $paint_pending (i32.const 0))))
    (call $gs32 (local.get $arg0) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0x000F)) ;; WM_PAINT
    (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
    ;; Child paint pending (from paint queue)
    (if (global.get $paint_queue_count)
    (then
    (local.set $tmp (if (result i32) (i32.and (local.get $arg4) (i32.const 1))
      (then (call $paint_queue_pop))
      (else (i32.load (global.get $PAINT_QUEUE)))))))  ;; peek without removing if PM_NOREMOVE
    (if (local.get $tmp)
    (then
    (call $gs32 (local.get $arg0) (local.get $tmp))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0x000F))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
    ;; No paint — deliver WM_TIMER if any timer is due
    ;; Pass PM_REMOVE flag (arg4 & 1) as consume param — PM_NOREMOVE peeks without resetting last_tick
    (if (call $timer_check_due (local.get $arg0) (i32.and (local.get $arg4) (i32.const 1)))
      (then
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
    ;; Pinball flag poke: game-active and commands-enabled are normally set by the
    ;; attract mode state machine which requires WM_WOM_DONE audio callbacks we
    ;; don't deliver.  Poke them once so the physics tick runs.
    (if (i32.ge_u (global.get $msg_phase) (i32.const 3))
      (then
        (if (i32.eqz (i32.load (call $g2w (i32.const 0x1024fe0))))
          (then
            (if (i32.eq (global.get $wndproc_addr) (i32.const 0x01007264))
              (then
                (i32.store (call $g2w (i32.const 0x1024fe0)) (i32.const 1))
                (i32.store (call $g2w (i32.const 0x1024ff8)) (i32.const 1))
              ))))))
    ;; Pinball ball-in-play poke: set [table+0x172] once the table object exists.
    ;; Without this, the attract mode text ("Careful...") keeps overwriting "Player 1".
    (if (i32.and
          (i32.eq (global.get $wndproc_addr) (i32.const 0x01007264))
          (i32.ne (i32.load (call $g2w (i32.const 0x1025658))) (i32.const 0)))
      (then
        (if (i32.eqz (i32.load (call $g2w (i32.add
              (i32.load (call $g2w (i32.const 0x1025658)))
              (i32.const 0x172)))))
          (then
            (i32.store (call $g2w (i32.add
              (i32.load (call $g2w (i32.const 0x1025658)))
              (i32.const 0x172))) (i32.const 1))))))
    (global.set $eax (i32.const 0))  ;; no message
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; stdcall, 5 args
  )

  ;; 75: DispatchMessageA
  (func $handle_DispatchMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $wndproc i32)
    ;; Skip WM_NULL — idle message, don't dispatch to WndProc
    (if (i32.eqz (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (then (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    ;; WM_TIMER with callback (lParam != 0): call callback(hwnd, WM_TIMER, timerID, tickcount)
    (if (i32.and (i32.eq (call $gl32 (i32.add (local.get $arg0) (i32.const 4))) (i32.const 0x0113))
    (i32.ne (call $gl32 (i32.add (local.get $arg0) (i32.const 12))) (i32.const 0)))
    (then
    (local.set $tmp (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    ;; Push callback args: GetTickCount, timerID, WM_TIMER, hwnd
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $tick_count)) ;; dwTime
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $gl32 (i32.add (local.get $arg0) (i32.const 8)))) ;; timerID
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0x0113)) ;; WM_TIMER
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $gl32 (local.get $arg0))) ;; hwnd
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $tmp))
    (global.set $eip (call $gl32 (i32.add (local.get $arg0) (i32.const 12)))) ;; callback addr
    (global.set $steps (i32.const 0))
    (return)))
    ;; Look up wndproc from window table
    (local.set $wndproc (call $wnd_table_get (call $gl32 (local.get $arg0))))
    ;; WAT-native WndProc dispatch (e.g. help window): wndproc >= 0xFFFF0000
    (if (i32.ge_u (local.get $wndproc) (i32.const 0xFFFF0000))
      (then
        (global.set $eax (call $wat_wndproc_dispatch
          (call $gl32 (local.get $arg0))
          (call $gl32 (i32.add (local.get $arg0) (i32.const 4)))
          (call $gl32 (i32.add (local.get $arg0) (i32.const 8)))
          (call $gl32 (i32.add (local.get $arg0) (i32.const 12)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    ;; Built-in control wndproc — act as DefWindowProc (return 0)
    (if (i32.eq (local.get $wndproc) (global.get $WNDPROC_BUILTIN))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    ;; x86 WndProc dispatch: use window table result, or fall back to globals
    (if (i32.eqz (local.get $wndproc))
      (then
        (if (i32.eq (call $gl32 (local.get $arg0)) (global.get $main_hwnd))
          (then (local.set $wndproc (global.get $wndproc_addr)))
          (else (if (global.get $wndproc_addr2)
            (then (local.set $wndproc (global.get $wndproc_addr2)))
            (else (local.set $wndproc (global.get $wndproc_addr))))))))
    ;; If no WndProc or null MSG ptr, return 0
    (if (i32.or (i32.eqz (local.get $wndproc)) (i32.eqz (local.get $arg0)))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    ;; Save the caller's return address before we modify the stack
    (local.set $tmp (call $gl32 (global.get $esp)))
    ;; Pop DispatchMessageA's own frame (ret + MSG* = 8 bytes)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    ;; Now push WndProc args: lParam, wParam, msg, hwnd (right to left)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $gl32 (i32.add (local.get $arg0) (i32.const 12)))) ;; lParam
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $gl32 (i32.add (local.get $arg0) (i32.const 8))))  ;; wParam
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))  ;; msg
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $gl32 (local.get $arg0)))                          ;; hwnd
    ;; Push return address — when WndProc returns, go back to DispatchMessage's caller
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $tmp))
    ;; Jump to WndProc
    (global.set $eip (local.get $wndproc))
    (global.set $steps (i32.const 0))
  )

  ;; 76: TranslateAcceleratorA(hwnd, hAccel, lpMsg) — return 0 (no accel match)
  ;; TODO: implement real accelerator table lookup
  (func $handle_TranslateAcceleratorA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 77: TranslateMessage(lpMsg) — translates virtual-key messages to char messages
  ;; We handle keyboard input in the renderer, so this is a no-op that returns success
  (func $handle_TranslateMessage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 78: DefWindowProcA
  (func $handle_DefWindowProcA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; WM_CLOSE (0x10): call DestroyWindow(hwnd) — only quit if main/dialog window
    (if (i32.eq (local.get $arg1) (i32.const 0x0010))
    (then
    (if (i32.or (i32.eq (local.get $arg0) (global.get $main_hwnd))
                (i32.eq (local.get $arg0) (global.get $dlg_hwnd)))
    (then (global.set $quit_flag (i32.const 1))))))
    ;; WM_ERASEBKGND (0x14): fill client area with background brush
    (if (i32.eq (local.get $arg1) (i32.const 0x0014))
    (then
    (global.set $eax (call $host_erase_background (local.get $arg0) (global.get $wndclass_bg_brush)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 79: PostQuitMessage
  (func $handle_PostQuitMessage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $quit_flag (i32.const 1))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 80: PostMessageA
  (func $handle_PostMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    ;; Queue if room (max 64 messages, 16 bytes each, at WASM addr 0x400)
    (if (i32.lt_u (global.get $post_queue_count) (i32.const 64))
    (then
    (local.set $tmp (i32.add (i32.const 0x400)
    (i32.mul (global.get $post_queue_count) (i32.const 16))))
    (i32.store (local.get $tmp) (local.get $arg0))                         ;; hwnd
    (i32.store (i32.add (local.get $tmp) (i32.const 4)) (local.get $arg1)) ;; msg
    (i32.store (i32.add (local.get $tmp) (i32.const 8)) (local.get $arg2)) ;; wParam
    (i32.store (i32.add (local.get $tmp) (i32.const 12)) (local.get $arg3));; lParam
    (global.set $post_queue_count (i32.add (global.get $post_queue_count) (i32.const 1)))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 81: SendMessageA(hwnd, msg, wParam, lParam) — 4 args stdcall
  ;; Synchronous: call WndProc(hwnd, msg, wParam, lParam) directly
  (func $handle_SendMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret_addr i32) (local $wndproc i32)
    ;; Intercept TreeView messages (0x1100-0x1150) — handle directly, bypass comctl32
    (if (i32.and (i32.ge_u (local.get $arg1) (i32.const 0x1100))
                 (i32.le_u (local.get $arg1) (i32.const 0x1150)))
      (then
        (global.set $eax (call $treeview_dispatch
          (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    ;; Look up wndproc from window table first
    (local.set $wndproc (call $wnd_table_get (local.get $arg0)))
    ;; WAT-native WndProc dispatch (e.g. help window)
    (if (i32.ge_u (local.get $wndproc) (i32.const 0xFFFF0000))
      (then
        (global.set $eax (call $wat_wndproc_dispatch
          (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    ;; Built-in control wndproc — act as DefWindowProc (return 0)
    (if (i32.eq (local.get $wndproc) (global.get $WNDPROC_BUILTIN))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    ;; Fall back to global wndproc if not in table (skip for child controls 0x20000+)
    (if (i32.and (i32.eqz (local.get $wndproc))
                 (i32.lt_u (local.get $arg0) (i32.const 0x20000)))
      (then
        (if (i32.eq (local.get $arg0) (global.get $main_hwnd))
          (then (local.set $wndproc (global.get $wndproc_addr)))
          (else (if (global.get $wndproc_addr2)
            (then (local.set $wndproc (global.get $wndproc_addr2)))
            (else (local.set $wndproc (global.get $wndproc_addr))))))))
    ;; If no WndProc, handle known child control messages or return 0
    (if (i32.eqz (local.get $wndproc))
      (then
        ;; EM_STREAMIN (0x449) — RichEdit text streaming
        (if (i32.eq (local.get $arg1) (i32.const 0x449))
          (then
            (call $host_richedit_stream
              (local.get $arg0)
              (call $g2w (call $gl32 (local.get $arg3))))
            (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
            (return)))
        ;; Route TreeView messages (0x1100-0x1150) to WAT-native TreeView
        (if (i32.and (i32.ge_u (local.get $arg1) (i32.const 0x1100))
                     (i32.le_u (local.get $arg1) (i32.const 0x1150)))
          (then
            (global.set $eax (call $treeview_dispatch
              (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
            (return)))
        ;; Forward progress bar / common control messages to renderer
        (if (i32.and (i32.ge_u (local.get $arg1) (i32.const 0x0401))
                     (i32.le_u (local.get $arg1) (i32.const 0x0440)))
          (then
            (call $host_send_ctrl_msg (local.get $arg0) (local.get $arg1)
              (local.get $arg2) (local.get $arg3))))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    ;; Save caller's return address
    (local.set $ret_addr (call $gl32 (global.get $esp)))
    ;; Pop SendMessageA frame (ret + 4 args = 20 bytes)
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
    ;; Push WndProc args right-to-left: lParam, wParam, msg, hwnd
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $arg3))  ;; lParam
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $arg2))  ;; wParam
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $arg1))  ;; msg
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $arg0))  ;; hwnd
    ;; Push return address
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $ret_addr))
    ;; Jump to WndProc
    (global.set $eip (local.get $wndproc))
    (global.set $steps (i32.const 0))
  )

  ;; 82: SendDlgItemMessageA — STUB: unimplemented
  ;; 82: SendDlgItemMessageA(hDlg, nIDDlgItem, Msg, wParam, lParam)
  ;; Equivalent to SendMessage(GetDlgItem(hDlg, nIDDlgItem), Msg, wParam, lParam)
  (func $handle_SendDlgItemMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $child_hwnd i32) (local $lParam i32)
    ;; Read lParam from stack (5th arg, at ESP+24)
    (local.set $lParam (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    ;; Try to find real control HWND
    (local.set $child_hwnd (call $ctrl_find_by_id (local.get $arg0) (local.get $arg1)))
    (if (local.get $child_hwnd)
      (then
        ;; Route through control wndproc dispatch
        (global.set $eax (call $control_wndproc_dispatch (local.get $child_hwnd) (local.get $arg2)
          (local.get $arg3) (local.get $lParam)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    ;; Fallback: construct synthetic child HWND
    (local.set $child_hwnd (i32.or (i32.const 0x20000) (i32.and (local.get $arg1) (i32.const 0xFFFF))))
    ;; Forward progress bar / common control messages to renderer
    (if (i32.and (i32.ge_u (local.get $arg2) (i32.const 0x0401))
                 (i32.le_u (local.get $arg2) (i32.const 0x0440)))
      (then (call $host_send_ctrl_msg (local.get $child_hwnd) (local.get $arg2)
              (local.get $arg3) (local.get $lParam))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))
