  ;; ============================================================
  ;; COMCTL32 HANDLERS
  ;; ImageList, toolbar and status-bar creation, up-down and property-sheet stubs,
  ;; MenuHelp, and the DSA/DPA dynamic-array and pointer-array APIs.
  ;; 
  ;; This was a 680-line slab of comctl32 sitting in the middle of
  ;; 09a-handlers.wat, the file for everything that had nowhere else to go.
  ;; ============================================================

  ;; InitCommonControls() — 0 args, void return, registers common control window classes
  (func $handle_InitCommonControls (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; No-op: our window creation handles class names directly
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; ImageList_Create(cx, cy, flags, cInitial, cGrow) — 5 args, returns HIMAGELIST handle
  (func $handle_ImageList_Create (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32)
    ;; ImageList struct:
    ;; +0 cx, +4 cy, +8 bk color, +12 count, +16 bitmap strip, +20 mask color.
    (local.set $buf (call $heap_alloc (i32.const 24)))
    (call $zero_memory (call $g2w (local.get $buf)) (i32.const 24))
    (i32.store (call $g2w (local.get $buf)) (local.get $arg0))           ;; cx
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 4))) (local.get $arg1))  ;; cy
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 8))) (i32.const -1))     ;; CLR_NONE
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 12))) (i32.const 0))     ;; count=0
    (global.set $eax (local.get $buf))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; stdcall, 5 args
  )

  ;; ImageList_Destroy(himl) — 1 arg, returns BOOL
  (func $handle_ImageList_Destroy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Free not implemented yet, just return TRUE
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; ImageList_LoadImageA(hi, lpbmp, cx, cGrow, crMask, uType, uFlags) — 7 args
  (func $handle_ImageList_LoadImageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32) (local $cx i32) (local $bmp i32) (local $bmp_w i32) (local $count i32)
    ;; LoadImage returns an image-list wrapper around a bitmap strip when host
    ;; resource loading can resolve the bitmap. If not, still return a valid
    ;; empty image list so callers can proceed.
    (local.set $cx (local.get $arg2))
    (if (i32.le_s (local.get $cx) (i32.const 0))
      (then (local.set $cx (i32.const 16))))
    (local.set $bmp (call $host_gdi_load_bitmap (local.get $arg0) (local.get $arg1)))
    (if (local.get $bmp)
      (then
        (local.set $bmp_w (call $host_gdi_get_object_w (local.get $bmp)))
        (if (i32.gt_s (local.get $bmp_w) (i32.const 0))
          (then
            (local.set $count (i32.div_u (local.get $bmp_w) (local.get $cx)))
            (if (i32.eqz (local.get $count))
              (then (local.set $count (i32.const 1))))))))
    (local.set $buf (call $heap_alloc (i32.const 24)))
    (call $zero_memory (call $g2w (local.get $buf)) (i32.const 24))
    (i32.store (call $g2w (local.get $buf)) (local.get $cx))           ;; cx
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 4))) (local.get $cx))  ;; cy=cx
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 8))) (i32.const -1))   ;; CLR_NONE
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 12))) (local.get $count))
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 16))) (local.get $bmp))
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 20))) (local.get $arg4))
    (global.set $eax (local.get $buf))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))  ;; stdcall, 7 args
  )

  ;; ImageList_LoadImageW — same as A, 7 args
  (func $handle_ImageList_LoadImageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32) (local $cx i32) (local $bmp i32) (local $bmp_w i32) (local $count i32)
    (local.set $cx (local.get $arg2))
    (if (i32.le_s (local.get $cx) (i32.const 0))
      (then (local.set $cx (i32.const 16))))
    (local.set $bmp (call $host_gdi_load_bitmap (local.get $arg0) (local.get $arg1)))
    (if (local.get $bmp)
      (then
        (local.set $bmp_w (call $host_gdi_get_object_w (local.get $bmp)))
        (if (i32.gt_s (local.get $bmp_w) (i32.const 0))
          (then
            (local.set $count (i32.div_u (local.get $bmp_w) (local.get $cx)))
            (if (i32.eqz (local.get $count))
              (then (local.set $count (i32.const 1))))))))
    (local.set $buf (call $heap_alloc (i32.const 24)))
    (call $zero_memory (call $g2w (local.get $buf)) (i32.const 24))
    (i32.store (call $g2w (local.get $buf)) (local.get $cx))
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 4))) (local.get $cx))
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 8))) (i32.const -1))
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 12))) (local.get $count))
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 16))) (local.get $bmp))
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 20))) (local.get $arg4))
    (global.set $eax (local.get $buf))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
  )

  ;; ImageList_AddMasked(himl, hbmImage, crMask) — 3 args, returns image index
  (func $handle_ImageList_AddMasked (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $count i32) (local $cx i32) (local $bmp_w i32) (local $add_count i32) (local $sw i32)
    (if (i32.or (i32.eqz (local.get $arg0)) (i32.eqz (local.get $arg1)))
      (then
        (global.set $eax (i32.const 0xffffffff))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $sw (call $g2w (local.get $arg0)))
    (local.set $count (i32.load offset=12 (local.get $sw)))
    (local.set $cx (i32.load (local.get $sw)))
    (if (i32.le_s (local.get $cx) (i32.const 0))
      (then (local.set $cx (i32.const 16))))
    (local.set $add_count (i32.const 1))
    (local.set $bmp_w (call $host_gdi_get_object_w (local.get $arg1)))
    (if (i32.gt_s (local.get $bmp_w) (i32.const 0))
      (then
        (local.set $add_count (i32.div_u (local.get $bmp_w) (local.get $cx)))
        (if (i32.eqz (local.get $add_count))
          (then (local.set $add_count (i32.const 1))))))
    (if (i32.eqz (i32.load offset=16 (local.get $sw)))
      (then
        (i32.store offset=16 (local.get $sw) (local.get $arg1))
        (i32.store offset=20 (local.get $sw) (local.get $arg2))))
    (i32.store offset=12 (local.get $sw) (i32.add (local.get $count) (local.get $add_count)))
    (global.set $eax (local.get $count))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  (func $create_status_window
    (param $style i32) (param $text_wa i32) (param $parent i32) (param $id i32)
    (result i32)
    (local $hwnd i32)
    (local.set $hwnd (call $ctrl_create_child
      (local.get $parent) (i32.const 22) (local.get $id)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 20)
      (local.get $style) (i32.const 0)))
    (drop (call $host_create_window
      (local.get $hwnd) (local.get $style)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 20)
      (local.get $text_wa) (local.get $id)))
    (call $host_set_parent (local.get $hwnd) (local.get $parent))
    (call $host_set_window_class (local.get $hwnd) (i32.const 0x3260))
    (local.get $hwnd))

  ;; CreateStatusWindowA(style, lpszText, hwndParent, wID) — 4 args, returns HWND
  (func $handle_CreateStatusWindowA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $create_status_window
      (local.get $arg0)
      (if (result i32) (local.get $arg1) (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (local.get $arg2) (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; CreateToolbarEx — 13 args, returns HWND of toolbar
  (func $handle_CreateToolbarEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CreateToolbarEx(hwndParent, ws, wID, nBitmaps, hBMInst, wBMID, lpButtons, iNumButtons, dxButton, dyButton, dxBitmap, dyBitmap, uStructSize)
    (local $wa_esp i32) (local $hwnd i32) (local $state i32) (local $sw i32)
    (local $buttons i32) (local $button_count i32) (local $button_w i32) (local $button_h i32)
    (local $bitmap_w i32) (local $bitmap_h i32) (local $struct_size i32) (local $bmp i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $buttons (i32.load offset=28 (local.get $wa_esp)))
    (local.set $button_count (i32.load offset=32 (local.get $wa_esp)))
    (local.set $button_w (i32.load offset=36 (local.get $wa_esp)))
    (local.set $button_h (i32.load offset=40 (local.get $wa_esp)))
    (local.set $bitmap_w (i32.load offset=44 (local.get $wa_esp)))
    (local.set $bitmap_h (i32.load offset=48 (local.get $wa_esp)))
    (local.set $struct_size (i32.load offset=52 (local.get $wa_esp)))
    ;; Win9x common controls treat these as requested image/button extents,
    ;; then retain the standard face padding around the bitmap. Media Player
    ;; passes equal 16x16 values and expects the familiar 23x22 transport
    ;; buttons, not tightly cropped 16x16 faces.
    (if (i32.le_u (local.get $button_w) (local.get $bitmap_w))
      (then (local.set $button_w (i32.add (local.get $bitmap_w) (i32.const 7)))))
    (if (i32.le_u (local.get $button_h) (local.get $bitmap_h))
      (then (local.set $button_h (i32.add (local.get $bitmap_h) (i32.const 6)))))
    ;; Create a real class-21 child so SendMessage routes through the toolbar
    ;; control model. The old renderer-only HWND had no parent/control state,
    ;; causing Media Player's layout messages to enter its application wndproc.
    (local.set $hwnd (call $ctrl_create_child
      (local.get $arg0) (i32.const 21) (local.get $arg2)
      (i32.const 0) (i32.const 0) (i32.const 100) (i32.const 30)
      (local.get $arg1) (i32.const 0)))
    (drop (call $host_create_window
      (local.get $hwnd) (local.get $arg1)
      (i32.const 0) (i32.const 0) (i32.const 100) (i32.const 30)
      (i32.const 0) (local.get $arg2)))
    (call $wnd_set_parent (local.get $hwnd) (local.get $arg0))
    (call $host_set_parent (local.get $hwnd) (local.get $arg0))
    (call $host_set_window_class (local.get $hwnd) (i32.const 0x3274))
    (local.set $state (call $toolbar_ensure_state (local.get $hwnd)))
    (local.set $sw (call $g2w (local.get $state)))
    (if (local.get $button_w) (then (i32.store offset=4 (local.get $sw) (local.get $button_w))))
    (if (local.get $button_h) (then (i32.store offset=8 (local.get $sw) (local.get $button_h))))
    (if (local.get $bitmap_w) (then (i32.store offset=12 (local.get $sw) (local.get $bitmap_w))))
    (if (local.get $bitmap_h) (then (i32.store offset=16 (local.get $sw) (local.get $bitmap_h))))
    (if (local.get $struct_size) (then (i32.store offset=24 (local.get $sw) (local.get $struct_size))))
    ;; CreateToolbarEx supplies the initial strip directly instead of sending
    ;; TB_ADDBITMAP. Load it here so the copied iBitmap indices have pixels.
    (if (local.get $arg3)
      (then
        (local.set $bmp (call $host_gdi_load_bitmap (local.get $arg4)
          (i32.and (i32.load offset=24 (local.get $wa_esp)) (i32.const 0xFFFF))))
        (if (local.get $bmp)
          (then
            (i32.store offset=48 (local.get $sw) (local.get $bmp))
            (i32.store offset=28 (local.get $sw) (local.get $arg3))))))
    (if (i32.and (local.get $buttons) (local.get $button_count))
      (then
        (drop (call $toolbar_ensure_capacity (local.get $sw) (local.get $button_count)))
        (local.set $state (i32.const 0))
        (block $done (loop $copy
          (br_if $done (i32.ge_u (local.get $state) (local.get $button_count)))
          (call $toolbar_copy_button_in
            (call $toolbar_button_ptr (local.get $sw) (local.get $state))
            (i32.add (local.get $buttons) (i32.mul (local.get $state) (local.get $struct_size)))
            (local.get $struct_size) (local.get $state))
          (local.set $state (i32.add (local.get $state) (i32.const 1)))
          (br $copy)))
        (i32.store (local.get $sw) (local.get $button_count))))
    (call $toolbar_autosize (local.get $hwnd))
    (global.set $eax (local.get $hwnd))
    (global.set $esp (i32.add (global.get $esp) (i32.const 56)))  ;; stdcall, 13 args
  )

  ;; CreateUpDownControl — 12 args, returns HWND
  (func $handle_CreateUpDownControl (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CreateUpDownControl(dwStyle, x, y, cx, cy, hParent, nID, hInst, hBuddy, nUpper, nLower, nPos)
    (global.set $eax (call $host_create_window
      (global.get $next_hwnd)
      (local.get $arg0) ;; style
      (local.get $arg1) ;; x
      (local.get $arg2) ;; y
      (local.get $arg3) ;; cx
      (local.get $arg4) ;; cy
      (i32.const 0) ;; no text
      (i32.const 0)))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 52)))  ;; stdcall, 12 args
  )

  ;; GetEffectiveClientRect(hWnd, lprc, lpInfo) — 3 args, void
  (func $handle_GetEffectiveClientRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Calculates the client rect excluding toolbars/status bars
    ;; For now, just call GetClientRect equivalent — fill rect with window client area
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    (i32.store (local.get $wa) (i32.const 0))          ;; left
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0))  ;; top
    (i32.store (i32.add (local.get $wa) (i32.const 8)) (i32.const 640))  ;; right
    (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.const 480)) ;; bottom
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; DrawStatusTextA(hDC, lprc, pszText, uFlags) — 4 args, void
  (func $handle_DrawStatusTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Draw text through the supplied HDC so the child-window origin and clip
    ;; match USER/GDI. Comctl32 DrawStatusText uses a recessed border; for now
    ;; preserve the app-provided rect and flags, but avoid the old global
    ;; renderer text path.
    (if (local.get $arg2)
      (then
        (drop (call $host_gdi_draw_text
          (local.get $arg0) ;; hDC
          (call $g2w (local.get $arg2)) ;; text
          (i32.const -1) ;; nCount=-1 (null terminated)
          (call $g2w (local.get $arg1)) ;; lpRect
          (i32.or (local.get $arg3) (i32.const 0x24)) ;; DT_SINGLELINE|DT_VCENTER
          (i32.const 0))))) ;; ANSI
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; DrawStatusTextW — 4 args, void. Same draw as the A spelling, with the
  ;; text read as UTF-16; it used to skip the draw entirely, so a wide app's
  ;; status bar stayed blank.
  (func $handle_DrawStatusTextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg2)
      (then
        (drop (call $host_gdi_draw_text
          (local.get $arg0)                              ;; hDC
          (call $g2w (local.get $arg2))                  ;; text
          (i32.const -1)                                 ;; nCount=-1 (null terminated)
          (call $g2w (local.get $arg1))                  ;; lpRect
          (i32.or (local.get $arg3) (i32.const 0x24))    ;; DT_SINGLELINE|DT_VCENTER
          (i32.const 1)))))                              ;; wide
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; MenuHelp(uMsg, wParam, lParam, hMainMenu, hInst) — 5 args, void
  (func $handle_MenuHelp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Processes WM_MENUSELECT and WM_COMMAND for status bar help text — no-op
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; ShowHideMenuCtl(hWnd, uFlags, lpInfo) — 3 args, returns BOOL
  (func $handle_ShowHideMenuCtl (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; CreateMappedBitmap(hInstance, idBitmap, wFlags, lpColorMap, iNumMaps) — 5 args, returns HBITMAP
  (func $handle_CreateMappedBitmap (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    ;; Bounded compatibility: load the requested RT_BITMAP and skip the
    ;; optional comctl32 color map for now. Returning a real HBITMAP matters
    ;; more than the previous fake handle because toolbar/image painters can
    ;; validate and blit it.
    (local.set $tmp
      (call $host_gdi_load_bitmap
        (local.get $arg0)
        (if (result i32) (i32.gt_u (local.get $arg1) (i32.const 0xFFFF))
          (then (local.get $arg1))
          (else (i32.and (local.get $arg1) (i32.const 0xFFFF))))))
    (if (i32.eqz (local.get $tmp))
      (then
        (local.set $tmp
          (call $host_gdi_create_compat_bitmap
            (i32.const 0) (i32.const 16) (i32.const 16) (i32.const 0)))))
    (global.set $eax (local.get $tmp))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; CreatePropertySheetPageA(lppsp) — 1 arg, returns HPROPSHEETPAGE
  (func $handle_CreatePropertySheetPageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return a fake handle
    (local.set $arg0 (call $heap_alloc (i32.const 4)))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; PropertySheetA(lppsph) — 1 arg, returns int (>0 if user clicked OK)
  (func $handle_PropertySheetA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return 0 (user cancelled / no change)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; ImageList_SetBkColor(himl, clrBk) — 2 args, returns old bk color
  (func $handle_ImageList_SetBkColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $old i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (local.set $old (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 8)))))
    (i32.store (call $g2w (i32.add (local.get $arg0) (i32.const 8))) (local.get $arg1))
    (global.set $eax (local.get $old))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; ImageList_GetBkColor(himl) — 1 arg
  (func $handle_ImageList_GetBkColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (global.set $eax (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 8)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; CreateStatusWindowW — same as A version, 4 args
  (func $handle_CreateStatusWindowW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; The renderer string bridge is ANSI; the app sets status text later via
    ;; messages, so create the Unicode control with an initially empty title.
    (global.set $eax (call $create_status_window
      (local.get $arg0) (i32.const 0) (local.get $arg2) (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; ============================================================
  ;; COMCTL32 internal heap functions (ordinal-only)
  ;; ============================================================

  ;; Comctl32_Alloc(dwSize) — 1 arg, returns pointer (zeroed)
  (func $handle_Comctl32_Alloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ptr i32)
    (local.set $ptr (call $heap_alloc (local.get $arg0)))
    ;; Zero the allocation
    (if (local.get $arg0)
      (then (memory.fill (call $g2w (local.get $ptr)) (i32.const 0) (local.get $arg0))))
    (global.set $eax (local.get $ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; Comctl32_ReAlloc(pv, cbNew) — 2 args, returns pointer
  (func $handle_Comctl32_ReAlloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Simple: allocate new, copy, return new (no free of old — heap doesn't support free yet)
    (local $new_ptr i32)
    (if (i32.eqz (local.get $arg0))
      (then
        ;; NULL input = just alloc
        (local.set $new_ptr (call $heap_alloc (local.get $arg1)))
        (if (local.get $arg1)
          (then (memory.fill (call $g2w (local.get $new_ptr)) (i32.const 0) (local.get $arg1)))))
      (else
        ;; Realloc: alloc new, copy old data
        (local.set $new_ptr (call $heap_alloc (local.get $arg1)))
        (if (local.get $arg1)
          (then (memory.copy (call $g2w (local.get $new_ptr)) (call $g2w (local.get $arg0)) (local.get $arg1))))))
    (global.set $eax (local.get $new_ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; Comctl32_Free(pv) — 1 arg, returns BOOL
  (func $handle_Comctl32_Free (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Our heap doesn't support free, just return TRUE
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; Comctl32_GetSize(pv) — 1 arg, returns DWORD size
  (func $handle_Comctl32_GetSize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Our heap doesn't track sizes, return a reasonable default
    (global.set $eax (i32.const 256))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; ============================================================
  ;; DSA (Dynamic Structure Array) — real implementation
  ;; DSA layout in memory: [item_size:4, count:4, capacity:4, data_ptr:4]
  ;; ============================================================

  ;; DSA_Create(cbItem, cItemGrow) — 2 args, returns HDSA
  (func $handle_DSA_Create (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dsa i32)
    (local $cap i32)
    (local.set $cap (select (local.get $arg1) (i32.const 8) (i32.gt_u (local.get $arg1) (i32.const 0))))
    (local.set $dsa (call $heap_alloc (i32.const 16)))
    (i32.store (call $g2w (local.get $dsa)) (local.get $arg0))           ;; item_size
    (i32.store (call $g2w (i32.add (local.get $dsa) (i32.const 4))) (i32.const 0))  ;; count
    (i32.store (call $g2w (i32.add (local.get $dsa) (i32.const 8))) (local.get $cap))  ;; capacity
    ;; Allocate data buffer: capacity * item_size
    (i32.store (call $g2w (i32.add (local.get $dsa) (i32.const 12)))
      (call $heap_alloc (i32.mul (local.get $cap) (local.get $arg0))))
    (global.set $eax (local.get $dsa))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; DSA_Destroy(hdsa) — 1 arg, returns BOOL
  (func $handle_DSA_Destroy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Can't free, just return TRUE
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; DSA_GetItem(hdsa, index, pitem) — 3 args, returns BOOL
  (func $handle_DSA_GetItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $item_size i32)
    (local $data_ptr i32)
    (local $count i32)
    (local.set $item_size (i32.load (call $g2w (local.get $arg0))))
    (local.set $count (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 4)))))
    (local.set $data_ptr (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 12)))))
    (if (i32.lt_u (local.get $arg1) (local.get $count))
      (then
        ;; Copy item_size bytes from data[index*item_size] to pitem
        (memory.copy (call $g2w (local.get $arg2))
          (call $g2w (i32.add (local.get $data_ptr) (i32.mul (local.get $arg1) (local.get $item_size))))
          (local.get $item_size))
        (global.set $eax (i32.const 1)))
      (else
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; DSA_GetItemPtr(hdsa, index) — 2 args, returns pointer to item
  (func $handle_DSA_GetItemPtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $item_size i32)
    (local $data_ptr i32)
    (local $count i32)
    (local.set $item_size (i32.load (call $g2w (local.get $arg0))))
    (local.set $count (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 4)))))
    (local.set $data_ptr (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 12)))))
    (if (i32.lt_u (local.get $arg1) (local.get $count))
      (then
        (global.set $eax (i32.add (local.get $data_ptr) (i32.mul (local.get $arg1) (local.get $item_size)))))
      (else
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; DSA_InsertItem(hdsa, index, pitem) — 3 args, returns index or -1
  ;; Callers index a DSA in lockstep with a parallel list control — Task
  ;; Manager reads row N of its listbox and asks the DSA for item N — so an
  ;; insert in the middle has to move the later items up rather than overwrite
  ;; the one already there, and has to grow the buffer instead of running off
  ;; the end of it once the initial capacity fills.
  (func $handle_DSA_InsertItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $item_size i32)
    (local $count i32)
    (local $cap i32)
    (local $data_ptr i32)
    (local $idx i32)
    (local $new_cap i32)
    (local $new_data i32)
    (local.set $item_size (i32.load (call $g2w (local.get $arg0))))
    (local.set $count (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 4)))))
    (local.set $cap (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 8)))))
    (local.set $data_ptr (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 12)))))
    ;; Clamp index: if index > count or DA_LAST (0x7FFFFFFF), append
    (local.set $idx (select (local.get $count) (local.get $arg1)
      (i32.gt_u (local.get $arg1) (local.get $count))))
    ;; Grow first so the extra slot exists before the shift.
    (if (i32.ge_u (local.get $count) (local.get $cap))
      (then
        (local.set $new_cap (i32.shl (local.get $cap) (i32.const 1)))
        (if (i32.lt_u (local.get $new_cap) (i32.const 8))
          (then (local.set $new_cap (i32.const 8))))
        (local.set $new_data (call $heap_alloc (i32.mul (local.get $new_cap) (local.get $item_size))))
        (if (local.get $count)
          (then
            (memory.copy (call $g2w (local.get $new_data)) (call $g2w (local.get $data_ptr))
              (i32.mul (local.get $count) (local.get $item_size)))))
        (if (local.get $data_ptr) (then (call $heap_free (local.get $data_ptr))))
        (local.set $data_ptr (local.get $new_data))
        (i32.store (call $g2w (i32.add (local.get $arg0) (i32.const 8))) (local.get $new_cap))
        (i32.store (call $g2w (i32.add (local.get $arg0) (i32.const 12))) (local.get $new_data))))
    ;; Shift [idx, count) up one slot. memory.copy is defined to behave like
    ;; memmove, so the overlap here is safe.
    (if (i32.gt_u (local.get $count) (local.get $idx))
      (then
        (memory.copy
          (call $g2w (i32.add (local.get $data_ptr)
            (i32.mul (i32.add (local.get $idx) (i32.const 1)) (local.get $item_size))))
          (call $g2w (i32.add (local.get $data_ptr) (i32.mul (local.get $idx) (local.get $item_size))))
          (i32.mul (i32.sub (local.get $count) (local.get $idx)) (local.get $item_size)))))
    ;; Copy item data to data[idx * item_size]
    (memory.copy
      (call $g2w (i32.add (local.get $data_ptr) (i32.mul (local.get $idx) (local.get $item_size))))
      (call $g2w (local.get $arg2))
      (local.get $item_size))
    ;; Increment count
    (i32.store (call $g2w (i32.add (local.get $arg0) (i32.const 4)))
      (i32.add (local.get $count) (i32.const 1)))
    (global.set $eax (local.get $idx))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; DSA_DeleteItem(hdsa, index) — 2 args, returns BOOL
  ;; Removing item N must close the gap. Only decrementing the count drops the
  ;; LAST item logically while every index from N on still reads its old
  ;; neighbour — which is how Task Manager's End Task came to act on the row
  ;; above the one the user had selected.
  (func $handle_DSA_DeleteItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $item_size i32)
    (local $count i32)
    (local $data_ptr i32)
    (local.set $item_size (i32.load (call $g2w (local.get $arg0))))
    (local.set $count (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 4)))))
    (local.set $data_ptr (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 12)))))
    (if (i32.lt_u (local.get $arg1) (local.get $count))
      (then
        ;; Shift (index, count) down over the removed slot.
        (if (i32.gt_u (i32.sub (local.get $count) (i32.const 1)) (local.get $arg1))
          (then
            (memory.copy
              (call $g2w (i32.add (local.get $data_ptr) (i32.mul (local.get $arg1) (local.get $item_size))))
              (call $g2w (i32.add (local.get $data_ptr)
                (i32.mul (i32.add (local.get $arg1) (i32.const 1)) (local.get $item_size))))
              (i32.mul (i32.sub (i32.sub (local.get $count) (i32.const 1)) (local.get $arg1))
                (local.get $item_size)))))
        (i32.store (call $g2w (i32.add (local.get $arg0) (i32.const 4)))
          (i32.sub (local.get $count) (i32.const 1)))
        (global.set $eax (i32.const 1)))
      (else
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; ============================================================
  ;; DPA (Dynamic Pointer Array) — real implementation
  ;; DPA layout: [count:4, capacity:4, ptrs_ptr:4]
  ;; ============================================================

  ;; DPA_Create(cItemGrow) — 1 arg, returns HDPA
  (func $handle_DPA_Create (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dpa i32)
    (local $cap i32)
    (local.set $cap (select (local.get $arg0) (i32.const 8) (i32.gt_u (local.get $arg0) (i32.const 0))))
    (local.set $dpa (call $heap_alloc (i32.const 12)))
    (i32.store (call $g2w (local.get $dpa)) (i32.const 0))           ;; count
    (i32.store (call $g2w (i32.add (local.get $dpa) (i32.const 4))) (local.get $cap))  ;; capacity
    (i32.store (call $g2w (i32.add (local.get $dpa) (i32.const 8)))
      (call $heap_alloc (i32.shl (local.get $cap) (i32.const 2))))   ;; ptrs array
    (global.set $eax (local.get $dpa))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; DPA_Destroy(hdpa) — 1 arg, returns BOOL
  (func $handle_DPA_Destroy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; DPA_GetPtr(hdpa, index) — 2 args, returns pointer at index
  (func $handle_DPA_GetPtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $count i32)
    (local $ptrs i32)
    (local.set $count (i32.load (call $g2w (local.get $arg0))))
    (local.set $ptrs (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 8)))))
    (if (i32.lt_u (local.get $arg1) (local.get $count))
      (then
        (global.set $eax (i32.load (call $g2w (i32.add (local.get $ptrs) (i32.shl (local.get $arg1) (i32.const 2)))))))
      (else
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; DPA_InsertPtr(hdpa, index, p) — 3 args, returns index or -1
  ;; A DPA is an ordered array, and callers index it in lockstep with a
  ;; parallel list control: Task Manager reads row N of its listbox and asks
  ;; the DPA for element N. So an insert must move the later elements up
  ;; rather than overwrite the one already at that slot, and must grow the
  ;; backing array instead of writing past it once the initial capacity fills.
  (func $handle_DPA_InsertPtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $count i32)
    (local $cap i32)
    (local $ptrs i32)
    (local $idx i32)
    (local $i i32)
    (local $new_cap i32)
    (local $new_ptrs i32)
    (local.set $count (i32.load (call $g2w (local.get $arg0))))
    (local.set $cap (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 4)))))
    (local.set $ptrs (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 8)))))
    ;; DPA_APPEND (0x7FFFFFFF) and any out-of-range index append.
    (local.set $idx (select (local.get $count) (local.get $arg1)
      (i32.gt_u (local.get $arg1) (local.get $count))))
    ;; Grow before the shift so the extra slot exists.
    (if (i32.ge_u (local.get $count) (local.get $cap))
      (then
        (local.set $new_cap (i32.shl (local.get $cap) (i32.const 1)))
        (if (i32.lt_u (local.get $new_cap) (i32.const 8))
          (then (local.set $new_cap (i32.const 8))))
        (local.set $new_ptrs (call $heap_alloc (i32.shl (local.get $new_cap) (i32.const 2))))
        (local.set $i (i32.const 0))
        (block $copy_done (loop $copy
          (br_if $copy_done (i32.ge_u (local.get $i) (local.get $count)))
          (i32.store
            (call $g2w (i32.add (local.get $new_ptrs) (i32.shl (local.get $i) (i32.const 2))))
            (i32.load (call $g2w (i32.add (local.get $ptrs) (i32.shl (local.get $i) (i32.const 2))))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $copy)))
        (if (local.get $ptrs) (then (call $heap_free (local.get $ptrs))))
        (local.set $ptrs (local.get $new_ptrs))
        (i32.store (call $g2w (i32.add (local.get $arg0) (i32.const 4))) (local.get $new_cap))
        (i32.store (call $g2w (i32.add (local.get $arg0) (i32.const 8))) (local.get $new_ptrs))))
    ;; Shift [idx, count) up one slot, walking down so the copy cannot
    ;; overwrite a source it has not read yet.
    (local.set $i (local.get $count))
    (block $shift_done (loop $shift
      (br_if $shift_done (i32.le_u (local.get $i) (local.get $idx)))
      (i32.store
        (call $g2w (i32.add (local.get $ptrs) (i32.shl (local.get $i) (i32.const 2))))
        (i32.load (call $g2w (i32.add (local.get $ptrs)
          (i32.shl (i32.sub (local.get $i) (i32.const 1)) (i32.const 2))))))
      (local.set $i (i32.sub (local.get $i) (i32.const 1)))
      (br $shift)))
    (i32.store (call $g2w (i32.add (local.get $ptrs) (i32.shl (local.get $idx) (i32.const 2))))
      (local.get $arg2))
    (i32.store (call $g2w (local.get $arg0)) (i32.add (local.get $count) (i32.const 1)))
    (global.set $eax (local.get $idx))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; DPA_DeletePtr(hdpa, index) — 2 args, returns removed pointer
  ;; Removing element N must close the gap. Only decrementing the count
  ;; drops the LAST element logically while leaving every index from N on
  ;; pointing at its old record — which is how Task Manager's End Task came
  ;; to post WM_CLOSE to a window belonging to an app that had already quit.
  (func $handle_DPA_DeletePtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $count i32)
    (local $ptrs i32)
    (local $removed i32)
    (local $i i32)
    (local.set $count (i32.load (call $g2w (local.get $arg0))))
    (local.set $ptrs (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 8)))))
    (if (i32.lt_u (local.get $arg1) (local.get $count))
      (then
        (local.set $removed (i32.load (call $g2w (i32.add (local.get $ptrs) (i32.shl (local.get $arg1) (i32.const 2))))))
        (local.set $i (local.get $arg1))
        (block $shift_done (loop $shift
          (br_if $shift_done (i32.ge_u (local.get $i) (i32.sub (local.get $count) (i32.const 1))))
          (i32.store
            (call $g2w (i32.add (local.get $ptrs) (i32.shl (local.get $i) (i32.const 2))))
            (i32.load (call $g2w (i32.add (local.get $ptrs)
              (i32.shl (i32.add (local.get $i) (i32.const 1)) (i32.const 2))))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $shift)))
        (i32.store (call $g2w (local.get $arg0)) (i32.sub (local.get $count) (i32.const 1)))
        (global.set $eax (local.get $removed)))
      (else
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; DPA_DeleteAllPtrs(hdpa) — 1 arg, returns BOOL
  (func $handle_DPA_DeleteAllPtrs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Set count to 0
    (i32.store (call $g2w (local.get $arg0)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )
