  ;; ============================================================
  ;; GDI API HANDLERS
  ;; ============================================================

  ;; 856: GetCurrentObject(hdc, uObjectType) → HGDIOBJ
  ;; OBJ_PEN=1, OBJ_BRUSH=2, OBJ_PAL=5, OBJ_FONT=6, OBJ_BITMAP=7
  (func $handle_GetCurrentObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_get_current_object (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 145: SelectObject(hdc, hObject) — delegate to host GDI
  (func $handle_SelectObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_select_object (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 146: DeleteObject(hObject) — delegate to host GDI
  (func $handle_DeleteObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_delete_object (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 147: DeleteDC(hdc) — delegate to host GDI
  (func $handle_DeleteDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_delete_dc (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 148: CreatePen(style, width, color) — delegate to host GDI
  (func $handle_CreatePen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_create_pen (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 149: CreateSolidBrush(color) — delegate to host GDI
  (func $handle_CreateSolidBrush (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_create_solid_brush (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; CreateBrushIndirect(LOGBRUSH*) — read color from struct, delegate to solid brush
  ;; LOGBRUSH = { UINT lbStyle; COLORREF lbColor; ULONG lbHatch; }
  (func $handle_CreateBrushIndirect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_create_solid_brush
      (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 4))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 150: CreateCompatibleDC(hdc) — delegate to host GDI
  (func $handle_CreateCompatibleDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_create_compat_dc (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 151: CreateCompatibleBitmap(hdc, w, h) — delegate to host GDI
  (func $handle_CreateCompatibleBitmap (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_create_compat_bitmap (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 152: GetViewportOrgEx(hdc, lpPoint)
  (func $handle_GetViewportOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.ne (local.get $arg1) (i32.const 0)) (then
      (call $gs32 (local.get $arg1)
        (call $host_gdi_get_viewport_org_x (local.get $arg0)))
      (call $gs32 (i32.add (local.get $arg1) (i32.const 4))
        (call $host_gdi_get_viewport_org_y (local.get $arg0)))
    ))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 153: Rectangle
  (func $handle_Rectangle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_rectangle
    (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 154: MoveToEx(hdc, x, y, lpPoint) — delegate to host GDI
  (func $handle_MoveToEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_move_to (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 155: LineTo(hdc, x, y) — delegate to host GDI
  (func $handle_LineTo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_line_to (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 156: Ellipse
  (func $handle_Ellipse (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_ellipse
    (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 157: Arc
  (func $handle_Arc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_arc
    (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
    (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 32)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 36)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 40))) (return)
  )

  ;; 158: BitBlt
  (func $handle_BitBlt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_bitblt
    (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
    (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 32)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 36)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 40))) (return)
  )

  ;; 159: PatBlt — hdc(arg0), x(arg1), y(arg2), w=[esp+16], h=[esp+20], rop=[esp+24]
  (func $handle_PatBlt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    (local.set $tmp (call $gl32 (i32.add (global.get $esp) (i32.const 24)))) ;; rop
    ;; Use BitBlt with no source DC for WHITENESS/BLACKNESS/PATCOPY
    (drop (call $host_gdi_bitblt
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (call $gl32 (i32.add (global.get $esp) (i32.const 16)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 20)))
      (i32.const 0) (i32.const 0) (i32.const 0)  ;; no source DC
      (local.get $tmp)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
  )

  ;; 160: CreateBitmap — nWidth(arg0), nHeight(arg1), nPlanes(arg2), nBitCount(arg3), lpBits(arg4)
  (func $handle_CreateBitmap (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (local.get $arg4))
      (then
        ;; NULL lpBits — create blank bitmap, pass bpp so host can mark monochrome
        (global.set $eax (call $host_gdi_create_bitmap
          (local.get $arg0) (local.get $arg1) (local.get $arg3) (i32.const 0))))
      (else
        ;; Has pixel data — convert via host
        (global.set $eax (call $host_gdi_create_bitmap
          (local.get $arg0) (local.get $arg1) (local.get $arg3)
          (call $g2w (local.get $arg4))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 161: TextOutA — hdc(arg0), x(arg1), y(arg2), lpString(arg3), nCount(arg4)
  (func $handle_TextOutA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_text_out
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (call $g2w (local.get $arg3)) (local.get $arg4) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 162: GetStockObject(index) → stock object handle (0x30010 + index)
  (func $handle_GetStockObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.add (i32.const 0x30010) (i32.and (local.get $arg0) (i32.const 0x1F))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 163: GetObjectA
  (func $handle_GetObjectA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    (if (i32.gt_u (local.get $arg1) (i32.const 0))
    (then (call $zero_memory (call $g2w (local.get $arg2)) (local.get $arg1))))
    ;; Try to fill BITMAP struct if it's a bitmap object
    (local.set $tmp (call $host_gdi_get_object_w (local.get $arg0)))
    (if (i32.ne (local.get $tmp) (i32.const 0))
    (then
    ;; BITMAP: bmType(0,4), bmWidth(+4,4), bmHeight(+8,4), bmWidthBytes(+12,4), bmPlanes(+16,2), bmBitsPixel(+18,2), bmBits(+20,4)
    (if (i32.ge_u (local.get $arg1) (i32.const 24))
    (then
    (call $gs32 (i32.add (local.get $arg2) (i32.const 4)) (local.get $tmp))  ;; bmWidth
    (call $gs32 (i32.add (local.get $arg2) (i32.const 8)) (call $host_gdi_get_object_h (local.get $arg0))) ;; bmHeight
    (call $gs32 (i32.add (local.get $arg2) (i32.const 12))
    (i32.mul (local.get $tmp) (i32.const 4))) ;; bmWidthBytes (assuming 32bpp)
    (call $gs16 (i32.add (local.get $arg2) (i32.const 16)) (i32.const 1))    ;; bmPlanes
    (call $gs16 (i32.add (local.get $arg2) (i32.const 18)) (i32.const 32))   ;; bmBitsPixel
    ))))
    (global.set $eax (local.get $arg1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 164: GetTextMetricsA — queries host for font-aware metrics
  (func $handle_GetTextMetricsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $w i32) (local $packed i32) (local $h i32) (local $aveW i32)
    (local.set $w (call $g2w (local.get $arg1)))
    (local.set $packed (call $host_get_text_metrics (local.get $arg0))) ;; hdc
    (local.set $h (i32.and (local.get $packed) (i32.const 0xFFFF)))
    (local.set $aveW (i32.shr_u (local.get $packed) (i32.const 16)))
    (call $zero_memory (local.get $w) (i32.const 56))
    (call $gs32 (local.get $arg1) (local.get $h))                                    ;; tmHeight
    (call $gs32 (i32.add (local.get $arg1) (i32.const 4))
      (i32.sub (local.get $h) (i32.const 3)))                                        ;; tmAscent ~= h-3
    (call $gs32 (i32.add (local.get $arg1) (i32.const 8)) (i32.const 3))             ;; tmDescent = 3
    (call $gs32 (i32.add (local.get $arg1) (i32.const 20)) (local.get $aveW))        ;; tmAveCharWidth
    (call $gs32 (i32.add (local.get $arg1) (i32.const 24))
      (i32.mul (local.get $aveW) (i32.const 2)))                                     ;; tmMaxCharWidth ~= 2*ave
    (call $gs32 (i32.add (local.get $arg1) (i32.const 28)) (i32.const 400))          ;; tmWeight = FW_NORMAL
    (i32.store8 (i32.add (local.get $w) (i32.const 40)) (i32.const 32))              ;; tmFirstChar = 0x20
    (i32.store8 (i32.add (local.get $w) (i32.const 41)) (i32.const 255))             ;; tmLastChar = 0xFF
    (i32.store8 (i32.add (local.get $w) (i32.const 42)) (i32.const 31))              ;; tmDefaultChar
    (i32.store8 (i32.add (local.get $w) (i32.const 44)) (i32.const 0x26))            ;; tmPitchAndFamily
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 165: GetTextExtentPointA — font-aware text measurement via host
  (func $handle_GetTextExtentPointA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $packed i32)
    (local.set $packed (call $host_get_text_metrics (local.get $arg0))) ;; get height from hdc font
    (call $gs32 (local.get $arg3)
      (call $host_measure_text (local.get $arg0) (call $g2w (local.get $arg1)) (local.get $arg2))) ;; cx
    (call $gs32 (i32.add (local.get $arg3) (i32.const 4))
      (i32.and (local.get $packed) (i32.const 0xFFFF)))                                            ;; cy
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 166: GetTextCharset(hdc) — return ANSI_CHARSET (0)
  (func $handle_GetTextCharset (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 167: CreateFontIndirectA — LOGFONT at arg0
  (func $handle_CreateFontIndirectA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $lf i32)
    (local.set $lf (call $g2w (local.get $arg0)))
    ;; LOGFONT: lfHeight(+0), lfWeight(+16), lfItalic(+20), lfFaceName(+28)
    (global.set $eax (call $host_create_font
      (i32.load (local.get $lf))                              ;; height
      (i32.load (i32.add (local.get $lf) (i32.const 16)))    ;; weight
      (i32.load8_u (i32.add (local.get $lf) (i32.const 20))) ;; italic
      (i32.add (local.get $lf) (i32.const 28))               ;; faceName WASM ptr
    ))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 168: CreateFontA — 14 params on stack
  (func $handle_CreateFontA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; arg0=nHeight, esp+16=fnWeight, esp+20=bItalic, esp+52=lpszFace
    (global.set $eax (call $host_create_font
      (local.get $arg0)                                              ;; height
      (call $gl32 (i32.add (global.get $esp) (i32.const 16)))       ;; weight
      (call $gl32 (i32.add (global.get $esp) (i32.const 20)))       ;; italic
      (call $g2w (call $gl32 (i32.add (global.get $esp) (i32.const 52)))) ;; faceName
    ))
    (global.set $esp (i32.add (global.get $esp) (i32.const 60))) (return)
  )

  ;; 169: CreateDCA — STUB: unimplemented
  ;; CreateDCA(lpszDriver, lpszDevice, lpszOutput, lpInitData) — 4 args stdcall.
  ;; Return the same fake screen DC as GetDC(NULL) (0x40000) for any driver; we don't
  ;; model per-device DCs, and callers (KVDD, printer probes) just query GetDeviceCaps.
  (func $handle_CreateDCA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x40000))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 170: SetAbortProc — STUB: unimplemented
  (func $handle_SetAbortProc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; ExtEscape(hdc, nEscape, cbInput, lpszInData, cbOutput, lpszOutData) — 6 args stdcall.
  ;; Return 0 (escape not implemented); KVDD and DirectX probes treat that as
  ;; "no special escape support" and fall back to generic GDI.
  (func $handle_ExtEscape (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 171: SetBkColor(hdc, color) → prev color
  (func $handle_SetBkColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_set_bk_color (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 172: SetBkMode(hdc, mode) → prev mode
  (func $handle_SetBkMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetBkMode(hdc, mode) → previous mode. mode: 1=TRANSPARENT, 2=OPAQUE
    (global.set $eax (call $host_gdi_set_bk_mode (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 173: SetTextColor(hdc, color) → prev color
  (func $handle_SetTextColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_set_text_color (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 174: SetMenu
  (func $handle_SetMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_set_menu
    (local.get $arg0)                                       ;; hWnd
    (i32.and (local.get $arg1) (i32.const 0xFFFF)))         ;; resource ID from HMENU
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 175: SetMapMode — STUB: unimplemented
  (func $handle_SetMapMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 176: SetWindowExtEx — STUB: unimplemented
  (func $handle_SetWindowExtEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 177: LPtoDP — STUB: unimplemented
  (func $handle_LPtoDP (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 178: StartDocA — STUB: unimplemented
  (func $handle_StartDocA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 179: StartPage — STUB: unimplemented
  (func $handle_StartPage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 180: EndPage — STUB: unimplemented
  (func $handle_EndPage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 181: EndPaint(hwnd, lpPaintStruct) — return TRUE
  (func $handle_EndPaint (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 182: EndDoc — STUB: unimplemented
  (func $handle_EndDoc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 183: AbortDoc — STUB: unimplemented
  (func $handle_AbortDoc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 184: SetCapture — STUB: unimplemented
  (func $handle_SetCapture (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetCapture(hwnd) → previous capture hwnd. 1 arg stdcall
    (global.set $eax (global.get $capture_hwnd))
    (global.set $capture_hwnd (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 185: ReleaseCapture() → BOOL. 0 args stdcall
  (func $handle_ReleaseCapture (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $capture_hwnd (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 186: ShowCursor — STUB: unimplemented
  (func $handle_ShowCursor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; ShowCursor(bShow) → display count. 1 arg stdcall
    ;; Track internal display count: show increments, hide decrements
    (if (local.get $arg0)
      (then (global.set $cursor_count (i32.add (global.get $cursor_count) (i32.const 1))))
      (else (global.set $cursor_count (i32.sub (global.get $cursor_count) (i32.const 1)))))
    (global.set $eax (global.get $cursor_count))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )
