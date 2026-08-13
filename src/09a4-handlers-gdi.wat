  ;; ============================================================
  ;; GDI API HANDLERS
  ;; ============================================================

  ;; 856: GetCurrentObject(hdc, uObjectType) → HGDIOBJ
  ;; OBJ_PEN=1, OBJ_BRUSH=2, OBJ_PAL=5, OBJ_FONT=6, OBJ_BITMAP=7
  (func $handle_GetCurrentObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (call $host_gdi_get_current_object (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 145: SelectObject(hdc, hObject) — canonical selection is WAT-owned.
  (func $handle_SelectObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $previous i32)
    (local.set $previous (call $gdi_dc_select_owned_object (local.get $arg0) (local.get $arg1)))
    (global.set $eax
      (if (result i32) (i32.ne (local.get $previous) (i32.const -1))
        (then (local.get $previous)) (else (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 146: DeleteObject(hObject) — destroy WAT state and derived presentation.
  (func $handle_DeleteObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (call $gdi_rgn_record (local.get $arg0))
      (then
        (global.set $eax (call $gdi_rgn_delete (local.get $arg0)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (global.set $eax (call $gdi_object_delete_full (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 147: DeleteDC(hdc) — release canonical WAT DC records.
  (func $handle_DeleteDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eq (local.get $arg0) (global.get $printer_hdc))
      (then
        (global.set $printer_hdc (i32.const 0))
        (global.set $printer_doc_state (i32.const 0))))
    (global.set $eax (call $gdi_dc_delete (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 148: CreatePen(style, width, color)
  (func $handle_CreatePen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $handle i32)
    (local.set $handle (call $gdi_object_alloc (i32.const 1)
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (i32.eq (local.get $arg0) (i32.const 5))))
    (global.set $eax (local.get $handle))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; CreatePenIndirect(LOGPEN*) — LOGPEN = { style, POINT width, color }.
  (func $handle_CreatePenIndirect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local $style i32)
    (local $width i32)
    (local $color i32)
    (if (i32.eqz (local.get $arg0))
      (then (global.set $eax (i32.const 0)))
      (else
        (local.set $wa (call $g2w (local.get $arg0)))
        (local.set $style (i32.load (local.get $wa)))
        (local.set $width (i32.load offset=4 (local.get $wa)))
        (local.set $color (i32.load offset=12 (local.get $wa)))
        (local.set $wa (call $gdi_object_alloc (i32.const 1)
          (local.get $style) (local.get $width) (local.get $color)
          (i32.eq (local.get $style) (i32.const 5))))
        (global.set $eax (local.get $wa))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 149: CreateSolidBrush(color)
  (func $handle_CreateSolidBrush (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $handle i32)
    (local.set $handle (call $gdi_object_alloc (i32.const 2)
      (i32.const 0) (i32.const 0) (local.get $arg0) (i32.const 0)))
    (global.set $eax (local.get $handle))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; CreateBrushIndirect(LOGBRUSH*) — preserve solid, null, and hatch styles.
  ;; LOGBRUSH = { UINT lbStyle; COLORREF lbColor; ULONG lbHatch; }
  (func $handle_CreateBrushIndirect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $handle i32) (local $wa i32) (local $style i32)
    (local $color i32) (local $hatch i32)
    (if (i32.eqz (local.get $arg0))
      (then (global.set $eax (i32.const 0)))
      (else
        (local.set $wa (call $g2w (local.get $arg0)))
        (local.set $style (i32.load (local.get $wa)))
        (local.set $color (i32.load offset=4 (local.get $wa)))
        (local.set $hatch (i32.load offset=8 (local.get $wa)))
        (if (i32.or (i32.gt_u (local.get $style) (i32.const 6))
              (i32.and (i32.eq (local.get $style) (i32.const 2))
                (i32.gt_u (local.get $hatch) (i32.const 5))))
          (then (global.set $eax (i32.const 0)))
          (else (if (i32.eq (local.get $style) (i32.const 3))
            (then (global.set $eax (call $gdi_bitmap_create_pattern_brush
              (local.get $hatch) (i32.const 1))))
          (else (if (i32.eq (local.get $style) (i32.const 6))
            (then (global.set $eax (call $gdi_bitmap_create_dib_pattern_brush
              (call $g2w (local.get $hatch)) (local.get $color))))
          (else (if (i32.or (i32.eq (local.get $style) (i32.const 4))
                (i32.eq (local.get $style) (i32.const 5)))
            (then (global.set $eax (i32.const 0)))
          (else
            (local.set $handle (call $gdi_object_alloc (i32.const 2)
              (local.get $style) (local.get $hatch) (local.get $color) (i32.const 0)))
            (global.set $eax (local.get $handle))))))))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 150: CreateCompatibleDC(hdc)
  (func $handle_CreateCompatibleDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_alloc))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 151: CreateCompatibleBitmap(hdc, w, h) — allocate canonical pixels in
  ;; the WAT bitmap arena, then let JS create the derived Canvas presentation.
  (func $handle_CreateCompatibleBitmap (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $w i32) (local $h i32) (local $size64 i64) (local $bits_ga i32) (local $handle i32)
    (local.set $w (local.get $arg1))
    (local.set $h (local.get $arg2))
    ;; Preserve the emulator's established zero/negative dimension behavior.
    (if (i32.le_s (local.get $w) (i32.const 0)) (then (local.set $w (i32.const 1))))
    (if (i32.le_s (local.get $h) (i32.const 0)) (then (local.set $h (i32.const 1))))
    (local.set $size64
      (i64.mul
        (i64.mul (i64.extend_i32_u (local.get $w)) (i64.extend_i32_u (local.get $h)))
        (i64.const 4)))
    (if (i64.gt_u (local.get $size64) (i64.extend_i32_u (global.get $DIB_BACKING_BASE_SIZE)))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $bits_ga (call $dib_alloc (i32.wrap_i64 (local.get $size64))))
    (if (i32.eqz (local.get $bits_ga))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $handle (call $gdi_bitmap_alloc
      (local.get $w) (local.get $h) (i32.const 32) (i32.const 6)
      (call $g2w (local.get $bits_ga)) (i32.mul (local.get $w) (i32.const 4))
      (i32.const 0) (i32.const 0)))
    (if (i32.eqz (local.get $handle))
      (then (call $dib_free_wasm (call $g2w (local.get $bits_ga)))))
    (global.set $eax (local.get $handle))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 152: GetViewportOrgEx(hdc, lpPoint)
  (func $handle_GetViewportOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.ne (local.get $arg1) (i32.const 0)) (then
      (call $gs32 (local.get $arg1)
        (call $gdi_dc_get_field (local.get $arg0) (i32.const 56) (i32.const 0)))
      (call $gs32 (i32.add (local.get $arg1) (i32.const 4))
        (call $gdi_dc_get_field (local.get $arg0) (i32.const 60) (i32.const 0)))
    ))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 153: Rectangle
  (func $handle_Rectangle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $desc i32)
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (call $gdi_surface_descriptor (local.get $arg0) (local.get $desc))
      (then (global.set $eax (call $gdi_rectangle_desc
        (local.get $arg0) (local.get $desc)
        (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
        (call $gdi_dc_get_field (local.get $arg0) (i32.const 4) (i32.const 0x30017))
        (call $gdi_dc_get_field (local.get $arg0) (i32.const 8) (i32.const 0x30010))
        (call $gdi_dc_get_rop2 (local.get $arg0)))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 154: MoveToEx(hdc, x, y, lpPoint) — current position is per-DC WAT state.
  (func $handle_MoveToEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $old_x i32) (local $old_y i32) (local $ok i32)
    (local.set $old_x (call $gdi_dc_get_field (local.get $arg0) (i32.const 12) (i32.const 0)))
    (local.set $old_y (call $gdi_dc_get_field (local.get $arg0) (i32.const 16) (i32.const 0)))
    (if (local.get $arg3) (then
      (call $gs32 (local.get $arg3) (local.get $old_x))
      (call $gs32 (i32.add (local.get $arg3) (i32.const 4)) (local.get $old_y))
    ))
    (local.set $ok (i32.const 1))
    (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 12) (local.get $arg1) (i32.const 0)))
    (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 16) (local.get $arg2) (i32.const 0)))
    (global.set $eax (local.get $ok))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 155: LineTo(hdc, x, y) — WAT rasterizes supported DIB targets exactly.
  (func $handle_LineTo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ok i32) (local $from_x i32) (local $from_y i32) (local $desc i32)
    (local.set $from_x (call $gdi_dc_get_field (local.get $arg0) (i32.const 12) (i32.const 0)))
    (local.set $from_y (call $gdi_dc_get_field (local.get $arg0) (i32.const 16) (i32.const 0)))
    ;; A standalone LineTo starts a fresh cosmetic style run.
    (global.set $gdi_line_style_phase (i32.const 0))
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (call $gdi_surface_descriptor (local.get $arg0) (local.get $desc))
      (then (local.set $ok (call $gdi_line_desc
        (local.get $arg0) (local.get $desc)
        (local.get $from_x) (local.get $from_y) (local.get $arg1) (local.get $arg2)
        (call $gdi_dc_get_field (local.get $arg0) (i32.const 4) (i32.const 0x30017))
        (call $gdi_dc_get_rop2 (local.get $arg0)))))
      (else (local.set $ok (i32.const 0))))
    (if (local.get $ok) (then
      (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 12) (local.get $arg1) (i32.const 0)))
      (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 16) (local.get $arg2) (i32.const 0)))
    ))
    (global.set $eax (local.get $ok))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 156: Ellipse
  (func $handle_Ellipse (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $desc i32)
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (call $gdi_surface_descriptor (local.get $arg0) (local.get $desc))
      (then (global.set $eax (call $gdi_ellipse_desc
        (local.get $arg0) (local.get $desc)
        (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
        (call $gdi_dc_get_field (local.get $arg0) (i32.const 4) (i32.const 0x30017))
        (call $gdi_dc_get_field (local.get $arg0) (i32.const 8) (i32.const 0x30010))
        (call $gdi_dc_get_rop2 (local.get $arg0)))))
      (else (global.set $eax (i32.const 0))))
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
    (local $dst i32) (local $src i32) (local $src_hdc i32)
    (local $sx i32) (local $sy i32) (local $rop i32) (local $rop3 i32)
    (local $dx i32) (local $dy i32) (local $pattern i32) (local $ok i32)
    (local.set $dst (global.get $GDI_BLIT_DST_DESC))
    (local.set $src (global.get $GDI_BLIT_SRC_DESC))
    (local.set $src_hdc (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (local.set $sx (call $gl32 (i32.add (global.get $esp) (i32.const 28))))
    (local.set $sy (call $gl32 (i32.add (global.get $esp) (i32.const 32))))
    (local.set $rop (call $gl32 (i32.add (global.get $esp) (i32.const 36))))
    (local.set $rop3 (i32.and (i32.shr_u (local.get $rop) (i32.const 16)) (i32.const 0xFF)))
    (if (call $gdi_surface_descriptor (local.get $arg0) (local.get $dst))
      (then
        (local.set $dx (call $gdi_line_map_x (local.get $dst) (local.get $arg1)))
        (local.set $dy (call $gdi_line_map_y (local.get $dst) (local.get $arg2)))
        (if (local.get $src_hdc)
          (then
            (if (i32.eqz (call $gdi_surface_descriptor (local.get $src_hdc) (local.get $src)))
              (then (local.set $src (i32.const 0)))
            (if (local.get $src)
              (then
                (local.set $sx (call $gdi_line_map_x (local.get $src) (local.get $sx)))
                (local.set $sy (call $gdi_line_map_y (local.get $src) (local.get $sy)))))))
          (else (local.set $src (i32.const 0))))
        (if (i32.and
              (i32.ne (i32.and
                (i32.xor (local.get $rop3) (i32.shr_u (local.get $rop3) (i32.const 2)))
                (i32.const 0x33)) (i32.const 0))
              (i32.eqz (local.get $src)))
          (then (local.set $ok (i32.const 0)))
          (else
            (local.set $ok (call $gdi_raster_bitblt
              (local.get $arg0) (local.get $src_hdc) (local.get $dst) (local.get $dx) (local.get $dy)
              (local.get $arg3) (local.get $arg4) (local.get $src)
              (local.get $sx) (local.get $sy) (local.get $pattern) (local.get $rop)))))
        (if (local.get $ok)
          (then (call $gdi_geometry_present (local.get $arg0) (local.get $dst)
            (local.get $dx) (local.get $dy)
            (i32.add (local.get $dx) (local.get $arg3))
            (i32.add (local.get $dy) (local.get $arg4))))))
      (else (local.set $ok (i32.const 0))))
    (global.set $eax (local.get $ok))
    (global.set $esp (i32.add (global.get $esp) (i32.const 40))) (return)
  )

  ;; 159: PatBlt — hdc(arg0), x(arg1), y(arg2), w=[esp+16], h=[esp+20], rop=[esp+24]
  (func $handle_PatBlt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $desc i32) (local $w i32) (local $h i32) (local $rop i32)
    (local $dx i32) (local $dy i32) (local $rop3 i32) (local $pattern i32) (local $ok i32)
    (local.set $w (call $gl32 (i32.add (global.get $esp) (i32.const 16))))
    (local.set $h (call $gl32 (i32.add (global.get $esp) (i32.const 20))))
    (local.set $rop (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (local.set $rop3 (i32.and (i32.shr_u (local.get $rop) (i32.const 16)) (i32.const 0xFF)))
    (local.set $desc (global.get $GDI_BLIT_DST_DESC))
    (if (call $gdi_surface_descriptor (local.get $arg0) (local.get $desc))
      (then
        (local.set $dx (call $gdi_line_map_x (local.get $desc) (local.get $arg1)))
        (local.set $dy (call $gdi_line_map_y (local.get $desc) (local.get $arg2)))
        (if (i32.ne (i32.and
              (i32.xor (local.get $rop3) (i32.shr_u (local.get $rop3) (i32.const 2)))
              (i32.const 0x33)) (i32.const 0))
          (then (local.set $ok (i32.const 0)))
          (else
            (local.set $ok (call $gdi_raster_bitblt
              (local.get $arg0) (i32.const 0) (local.get $desc) (local.get $dx) (local.get $dy)
              (local.get $w) (local.get $h) (i32.const 0)
              (i32.const 0) (i32.const 0) (local.get $pattern) (local.get $rop)))))
        (if (local.get $ok)
          (then (call $gdi_geometry_present (local.get $arg0) (local.get $desc)
            (local.get $dx) (local.get $dy)
            (i32.add (local.get $dx) (local.get $w))
            (i32.add (local.get $dy) (local.get $h))))))
      (else (local.set $ok (i32.const 0))))
    (global.set $eax (local.get $ok))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
  )

  ;; 160: CreateBitmap — nWidth(arg0), nHeight(arg1), nPlanes(arg2), nBitCount(arg3), lpBits(arg4)
  (func $handle_CreateBitmap (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_bitmap_create_bitmap
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)
      (if (result i32) (local.get $arg4)
        (then (call $g2w (local.get $arg4))) (else (i32.const 0)))))
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
    (local $record i32) (local $type i32) (local $dest i32)
    (local.set $record (call $gdi_object_record (local.get $arg0)))
    (local.set $type (call $gdi_object_type (local.get $arg0)))
    (if (local.get $arg2) (then (local.set $dest (call $g2w (local.get $arg2)))))
    (if (i32.eq (local.get $type) (i32.const 4))
      (then (global.set $eax (call $gdi_font_write_logfont (local.get $arg0)
        (local.get $dest)
        (local.get $arg1) (i32.const 0))))
      (else (if (i32.or (i32.eq (local.get $type) (i32.const 1))
            (i32.eq (local.get $type) (i32.const 2)))
        (then (global.set $eax (call $gdi_object_write_pen_brush
          (local.get $arg0) (local.get $dest) (local.get $arg1))))
        (else (global.set $eax (call $gdi_bitmap_write_object
          (local.get $record) (local.get $dest) (local.get $arg1)))))))
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
    (call $gs32 (i32.add (local.get $arg1) (i32.const 36)) (i32.const 96))           ;; tmDigitizedAspectX
    (call $gs32 (i32.add (local.get $arg1) (i32.const 40)) (i32.const 96))           ;; tmDigitizedAspectY
    ;; TEXTMETRICA byte fields start at +44 (after tmDigitizedAspectY at +40)
    (i32.store8 (i32.add (local.get $w) (i32.const 44)) (i32.const 32))              ;; tmFirstChar = 0x20
    (i32.store8 (i32.add (local.get $w) (i32.const 45)) (i32.const 255))             ;; tmLastChar = 0xFF
    (i32.store8 (i32.add (local.get $w) (i32.const 46)) (i32.const 31))              ;; tmDefaultChar
    (i32.store8 (i32.add (local.get $w) (i32.const 47)) (i32.const 32))              ;; tmBreakChar = ' '
    (i32.store8 (i32.add (local.get $w) (i32.const 51)) (i32.const 0x26))            ;; tmPitchAndFamily
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; GetCharWidthA(hdc, first, last, widths) — fill INT widths for a range.
  (func $handle_GetCharWidthA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $packed i32) (local $width i32) (local $count i32) (local $i i32)
    (if (i32.or (i32.eqz (local.get $arg3)) (i32.lt_u (local.get $arg2) (local.get $arg1)))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    (local.set $packed (call $host_get_text_metrics (local.get $arg0)))
    (local.set $width (i32.shr_u (local.get $packed) (i32.const 16)))
    (if (i32.eqz (local.get $width)) (then (local.set $width (i32.const 8))))
    (local.set $count (i32.add (i32.sub (local.get $arg2) (local.get $arg1)) (i32.const 1)))
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (call $gs32
        (i32.add (local.get $arg3) (i32.shl (local.get $i) (i32.const 2)))
        (local.get $width))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; GetOutlineTextMetricsA/W(hdc, cbData, lpOTM) — outline metrics unavailable.
  ;; Returning 0 makes callers use their bitmap-font fallback path.
  (func $handle_GetOutlineTextMetricsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  (func $handle_GetOutlineTextMetricsW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 165: GetTextExtentPointA — font-aware text measurement via host
  (func $handle_GetTextExtentPointA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $packed i32)
    (local.set $packed (call $host_get_text_metrics (local.get $arg0))) ;; get height from hdc font
    (call $gs32 (local.get $arg3)
      (call $host_measure_text (local.get $arg0) (call $g2w (local.get $arg1))
        (local.get $arg2) (i32.const 0))) ;; cx
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

  ;; GetTextCharsetInfo(hdc, lpSig, flags) — ANSI charset with no Unicode ranges.
  (func $handle_GetTextCharsetInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1)
      (then (call $zero_memory (call $g2w (local.get $arg1)) (i32.const 24))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; TranslateCharsetInfo(src, CHARSETINFO*, flags) — ANSI/Western defaults.
  (func $handle_TranslateCharsetInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1)
      (then
        (call $zero_memory (call $g2w (local.get $arg1)) (i32.const 32))
        (call $gs32 (local.get $arg1) (i32.const 0))       ;; ciCharset = ANSI_CHARSET
        (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 1252)))) ;; ciACP
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; GetTextFaceA(hdc, cch, face) — report the selected font face.
  ;; We do not expose host font names here; use a stable Win32-compatible face.
  (func $handle_GetTextFaceA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32) (local $limit i32)
    (if (i32.and (local.get $arg1) (local.get $arg2))
      (then
        (local.set $buf (call $g2w (local.get $arg2)))
        (local.set $limit (i32.sub (local.get $arg1) (i32.const 1)))
        (if (i32.gt_u (local.get $limit) (i32.const 5))
          (then (local.set $limit (i32.const 5))))
        (if (i32.gt_u (local.get $limit) (i32.const 0))
          (then (i32.store8 (local.get $buf) (i32.const 65))))        ;; A
        (if (i32.gt_u (local.get $limit) (i32.const 1))
          (then (i32.store8 (i32.add (local.get $buf) (i32.const 1)) (i32.const 114)))) ;; r
        (if (i32.gt_u (local.get $limit) (i32.const 2))
          (then (i32.store8 (i32.add (local.get $buf) (i32.const 2)) (i32.const 105)))) ;; i
        (if (i32.gt_u (local.get $limit) (i32.const 3))
          (then (i32.store8 (i32.add (local.get $buf) (i32.const 3)) (i32.const 97))))  ;; a
        (if (i32.gt_u (local.get $limit) (i32.const 4))
          (then (i32.store8 (i32.add (local.get $buf) (i32.const 4)) (i32.const 108)))) ;; l
        (i32.store8 (i32.add (local.get $buf) (local.get $limit)) (i32.const 0))))
    (global.set $eax (i32.const 5))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 167: CreateFontIndirectA — LOGFONT at arg0
  (func $handle_CreateFontIndirectA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $lf i32) (local $handle i32)
    (local.set $lf (call $g2w (local.get $arg0)))
    ;; LOGFONT: lfHeight(+0), lfWeight(+16), lfItalic(+20), lfFaceName(+28)
    (local.set $handle (call $host_create_font
      (i32.load (local.get $lf))                              ;; height
      (i32.load (i32.add (local.get $lf) (i32.const 16)))    ;; weight
      (i32.load8_u (i32.add (local.get $lf) (i32.const 20))) ;; italic
      (i32.add (local.get $lf) (i32.const 28))               ;; faceName WASM ptr
    ))
    (drop (call $gdi_object_adopt (local.get $handle) (i32.const 4)
      (i32.load (local.get $lf)) (i32.load offset=16 (local.get $lf))
      (i32.load8_u offset=20 (local.get $lf)) (i32.const 0)))
    (global.set $eax (local.get $handle))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 168: CreateFontA — 14 params on stack
  (func $handle_CreateFontA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $handle i32) (local $weight i32) (local $italic i32)
    ;; arg0=nHeight, esp+16=fnWeight, esp+20=bItalic, esp+52=lpszFace
    (local.set $weight (call $gl32 (i32.add (global.get $esp) (i32.const 16))))
    (local.set $italic (call $gl32 (i32.add (global.get $esp) (i32.const 20))))
    (local.set $handle (call $host_create_font
      (local.get $arg0)                                              ;; height
      (local.get $weight)                                            ;; weight
      (local.get $italic)                                            ;; italic
      (call $g2w (call $gl32 (i32.add (global.get $esp) (i32.const 52)))) ;; faceName
    ))
    (drop (call $gdi_object_adopt (local.get $handle) (i32.const 4)
      (local.get $arg0) (local.get $weight) (local.get $italic) (i32.const 0)))
    (global.set $eax (local.get $handle))
    (global.set $esp (i32.add (global.get $esp) (i32.const 60))) (return)
  )

  ;; CreateDCA(lpszDriver, lpszDevice, lpszOutput, lpInitData) — 4 args stdcall.
  ;; Allocate a real host DC record so native RichEdit can draw preview/print
  ;; bands through the normal canvas GDI path, then tag it for printer caps.
  (func $handle_CreateDCA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $printer_hdc (call $host_alloc_screen_dc))
    (global.set $eax (global.get $printer_hdc))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; SetAbortProc records no callback yet, but succeeds like a printer driver.
  (func $handle_SetAbortProc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; ExtEscape(hdc, nEscape, cbInput, lpszInData, cbOutput, lpszOutData) — 6 args stdcall.
  ;; Return 0 (escape not implemented); KVDD and DirectX probes treat that as
  ;; "no special escape support" and fall back to generic GDI.
  (func $handle_ExtEscape (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; UpdateColors(hdc) — palette refresh is a no-op for canvas-backed GDI.
  (func $handle_UpdateColors (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 171: SetBkColor(hdc, color) → prev color
  (func $handle_SetBkColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_set_field (local.get $arg0) (i32.const 24)
      (i32.and (local.get $arg1) (i32.const 0xFFFFFF)) (i32.const 0xFFFFFF)))
    (drop (call $host_gdi_set_bk_color (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 172: SetBkMode(hdc, mode) → prev mode
  (func $handle_SetBkMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetBkMode(hdc, mode) → previous mode. mode: 1=TRANSPARENT, 2=OPAQUE
    (if (i32.or (i32.eq (local.get $arg1) (i32.const 1))
          (i32.eq (local.get $arg1) (i32.const 2)))
      (then
        (global.set $eax (call $gdi_dc_set_field
          (local.get $arg0) (i32.const 28) (local.get $arg1) (i32.const 2)))
        (drop (call $host_gdi_set_bk_mode (local.get $arg0) (local.get $arg1))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 173: SetTextColor(hdc, color) → prev color
  (func $handle_SetTextColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_set_field (local.get $arg0) (i32.const 20)
      (i32.and (local.get $arg1) (i32.const 0xFFFFFF)) (i32.const 0)))
    (drop (call $host_gdi_set_text_color (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 174: SetMenu
  (func $handle_SetMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetMenu changes the non-client layout. Install the menu in WAT before
    ;; later GetDC/GetClientRect/ShowWindow paths ask for client geometry;
    ;; several WEP games attach their menu after CreateWindowExA and paint
    ;; immediately.
    (call $menu_load (local.get $arg0) (local.get $arg1))
    (call $defwndproc_do_nccalcsize (local.get $arg0))
    (call $host_set_menu
    (local.get $arg0)                                       ;; hWnd
    (i32.and (local.get $arg1) (i32.const 0xFFFF)))         ;; resource ID from HMENU
    (if (call $wnd_is_effectively_visible (local.get $arg0))
      (then
        (call $defwndproc_do_ncpaint (local.get $arg0))
        (call $paint_flag_set_inv (local.get $arg0))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 175: SetMapMode(hdc, fnMapMode) → previous map mode.
  (func $handle_SetMapMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.and (i32.ge_u (local.get $arg1) (i32.const 1))
          (i32.le_u (local.get $arg1) (i32.const 8)))
      (then (global.set $eax (call $gdi_dc_set_field
        (local.get $arg0) (i32.const 36) (local.get $arg1) (i32.const 1))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 176: SetWindowExtEx(hdc, x, y, lpSize) → BOOL
  (func $handle_SetWindowExtEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg3)
      (then
        (call $gs32 (local.get $arg3)
          (call $gdi_dc_get_field (local.get $arg0) (i32.const 48) (i32.const 1)))
        (call $gs32 (i32.add (local.get $arg3) (i32.const 4))
          (call $gdi_dc_get_field (local.get $arg0) (i32.const 52) (i32.const 1)))))
    (if (i32.and (local.get $arg1) (local.get $arg2))
      (then
        (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 48) (local.get $arg1) (i32.const 1)))
        (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 52) (local.get $arg2) (i32.const 1)))
        (global.set $eax (i32.const 1)))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 177: LPtoDP(hdc, lpPoints, nCount) → BOOL.
  (func $handle_LPtoDP (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $i i32) (local $p i32)
    (local $wx i32) (local $wy i32) (local $wex i32) (local $wey i32)
    (local $vx i32) (local $vy i32) (local $vex i32) (local $vey i32)
    (if (i32.or (i32.eqz (local.get $arg1)) (i32.lt_s (local.get $arg2) (i32.const 0)))
      (then (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (local.set $wx (call $gdi_dc_get_field (local.get $arg0) (i32.const 40) (i32.const 0)))
    (local.set $wy (call $gdi_dc_get_field (local.get $arg0) (i32.const 44) (i32.const 0)))
    (local.set $wex (call $gdi_dc_get_field (local.get $arg0) (i32.const 48) (i32.const 1)))
    (local.set $wey (call $gdi_dc_get_field (local.get $arg0) (i32.const 52) (i32.const 1)))
    (local.set $vx (call $gdi_dc_get_field (local.get $arg0) (i32.const 56) (i32.const 0)))
    (local.set $vy (call $gdi_dc_get_field (local.get $arg0) (i32.const 60) (i32.const 0)))
    (local.set $vex (call $gdi_dc_get_field (local.get $arg0) (i32.const 64) (i32.const 1)))
    (local.set $vey (call $gdi_dc_get_field (local.get $arg0) (i32.const 68) (i32.const 1)))
    (if (i32.or (i32.eqz (local.get $wex)) (i32.eqz (local.get $wey)))
      (then (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (block $done (loop $points
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $p (i32.add (local.get $arg1) (i32.shl (local.get $i) (i32.const 3))))
      (call $gs32 (local.get $p)
        (call $gdi_map_coordinate (call $gl32 (local.get $p))
          (local.get $wx) (local.get $wex) (local.get $vx) (local.get $vex)))
      (call $gs32 (i32.add (local.get $p) (i32.const 4))
        (call $gdi_map_coordinate (call $gl32 (i32.add (local.get $p) (i32.const 4)))
          (local.get $wy) (local.get $wey) (local.get $vy) (local.get $vey)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $points)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  (func $handle_StartDocA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.ne (global.get $printer_doc_state) (i32.const 0))
      (then (global.set $eax (i32.const -1)))
      (else
        (global.set $printer_doc_state (i32.const 1))
        (global.set $printer_page_count (i32.const 0))
        (global.set $eax (i32.const 1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  (func $handle_StartPage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.ne (global.get $printer_doc_state) (i32.const 1))
      (then (global.set $eax (i32.const -1)))
      (else
        (global.set $printer_doc_state (i32.const 2))
        (global.set $printer_page_count (i32.add (global.get $printer_page_count) (i32.const 1)))
        (global.set $eax (i32.const 1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  (func $handle_EndPage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.ne (global.get $printer_doc_state) (i32.const 2))
      (then (global.set $eax (i32.const -1)))
      (else
        (global.set $printer_doc_state (i32.const 1))
        (global.set $eax (i32.const 1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 181: EndPaint(hwnd, lpPaintStruct) — validate rcPaint and release its WAT DC.
  (func $handle_EndPaint (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $hdc i32)
    (if (i32.and (i32.ne (local.get $arg1) (i32.const 0)) (i32.ne (local.get $arg0) (i32.const 0)))
      (then
        (local.set $wa (i32.add (call $g2w (local.get $arg1)) (i32.const 8)))
        (drop (call $update_validate_rect
          (local.get $arg0)
          (i32.load (local.get $wa))
          (i32.load offset=4 (local.get $wa))
          (i32.load offset=8 (local.get $wa))
          (i32.load offset=12 (local.get $wa))))
        ;; PAINTSTRUCT.hdc is at +0
        (local.set $hdc (i32.load (call $g2w (local.get $arg1))))
        (drop (call $host_release_dc (local.get $hdc)))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  (func $handle_EndDoc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eq (global.get $printer_doc_state) (i32.const 1))
      (then
        (global.set $printer_doc_state (i32.const 0))
        (global.set $eax (i32.const 1)))
      (else (global.set $eax (i32.const -1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  (func $handle_AbortDoc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $printer_doc_state (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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
