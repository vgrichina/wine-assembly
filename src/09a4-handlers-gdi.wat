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
        (global.set $eax (call $gdi_printer_dc_release (local.get $arg0)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
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
    (if (call $gdi_dc_path_is_open (local.get $arg0))
      (then
        (global.set $eax (call $gdi_dc_path_record_rectangle
          (local.get $arg0) (local.get $arg1) (local.get $arg2)
          (local.get $arg3) (local.get $arg4)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
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
    (if (call $gdi_dc_path_is_open (local.get $arg0))
      (then (local.set $ok (call $gdi_dc_path_record_move
        (local.get $arg0) (local.get $arg1) (local.get $arg2))))
      (else (local.set $ok (i32.ne
        (call $gdi_dc_state_entry (local.get $arg0) (i32.const 0)) (i32.const 0)))))
    (if (local.get $ok)
      (then
        (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 12) (local.get $arg1) (i32.const 0)))
        (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 16) (local.get $arg2) (i32.const 0)))))
    (global.set $eax (local.get $ok))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 155: LineTo(hdc, x, y) — WAT rasterizes supported DIB targets exactly.
  (func $handle_LineTo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ok i32) (local $from_x i32) (local $from_y i32) (local $desc i32)
    (local.set $from_x (call $gdi_dc_get_field (local.get $arg0) (i32.const 12) (i32.const 0)))
    (local.set $from_y (call $gdi_dc_get_field (local.get $arg0) (i32.const 16) (i32.const 0)))
    (if (call $gdi_dc_path_is_open (local.get $arg0))
      (then (local.set $ok (call $gdi_dc_path_record_line
        (local.get $arg0) (local.get $arg1) (local.get $arg2))))
      (else
        ;; A standalone LineTo starts a fresh cosmetic style run.
        (global.set $gdi_line_style_phase (i32.const 0))
        (local.set $desc (global.get $GDI_LINE_DESC))
        (if (call $gdi_surface_descriptor (local.get $arg0) (local.get $desc))
          (then (local.set $ok (call $gdi_line_desc
            (local.get $arg0) (local.get $desc)
            (local.get $from_x) (local.get $from_y) (local.get $arg1) (local.get $arg2)
            (call $gdi_dc_get_field (local.get $arg0) (i32.const 4) (i32.const 0x30017))
            (call $gdi_dc_get_rop2 (local.get $arg0)))))
          (else (local.set $ok (i32.const 0))))))
    (if (local.get $ok) (then
      (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 12) (local.get $arg1) (i32.const 0)))
      (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 16) (local.get $arg2) (i32.const 0)))
    ))
    (global.set $eax (local.get $ok))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  (func $handle_BeginPath (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_path_begin (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_EndPath (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_path_end (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_AbortPath (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_path_abort (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_CloseFigure (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_path_close_figure (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_GetPath (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_path_get
      (local.get $arg0)
      (if (result i32) (local.get $arg1) (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (if (result i32) (local.get $arg2) (then (call $g2w (local.get $arg2))) (else (i32.const 0)))
      (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  (func $handle_PathToRegion (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_path_to_region (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_FlattenPath (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_path_flatten (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_WidenPath (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_path_widen (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_FillPath (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_path_fill (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_StrokePath (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_path_stroke (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_StrokeAndFillPath (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_path_stroke_and_fill (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; 156: Ellipse
  (func $handle_Ellipse (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $desc i32)
    (if (call $gdi_dc_path_is_open (local.get $arg0))
      (then
        (global.set $eax (call $gdi_dc_path_record_ellipse
          (local.get $arg0) (local.get $arg1) (local.get $arg2)
          (local.get $arg3) (local.get $arg4)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
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
    (if (call $gdi_dc_path_is_open (local.get $arg0))
      (then
        (global.set $eax (call $gdi_dc_path_record_arc
          (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
          (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
          (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
          (call $gl32 (i32.add (global.get $esp) (i32.const 32)))
          (call $gl32 (i32.add (global.get $esp) (i32.const 36))) (i32.const 0)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 40)))
        (return)))
    (global.set $eax (call $host_gdi_arc
    (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
    (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 32)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 36)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 40))) (return)
  )

  ;; The remaining public arc-shape APIs share the canonical WAT path engine.
  (func $handle_AngleArc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
        (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_draw_angle_arc
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)
      (f64.promote_f32 (f32.reinterpret_i32 (local.get $arg4)))
      (f64.promote_f32 (f32.reinterpret_i32
        (call $gl32 (i32.add (global.get $esp) (i32.const 24)))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  (func $handle_Chord (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
        (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_draw_arc_shape
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4)
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 32)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 36))) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 40))))

  (func $handle_Pie (param $arg0 i32) (param $arg1 i32) (param $arg2 i32)
        (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_draw_arc_shape
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4)
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 32)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 36))) (i32.const 2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 40))))

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
              (then (local.set $src (i32.const 0))))
            (if (local.get $src)
              (then
                (local.set $sx (call $gdi_line_map_x (local.get $src) (local.get $sx)))
                (local.set $sy (call $gdi_line_map_y (local.get $src) (local.get $sy))))))
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
    (global.set $eax (call $gdi_font_char_widths
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (if (result i32) (local.get $arg3)
        (then (call $g2w (local.get $arg3))) (else (i32.const 0)))
      (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; GetOutlineTextMetricsA/W(hdc, cbData, lpOTM) — outline metrics unavailable.
  ;; Returning 0 makes callers use their bitmap-font fallback path.
  (func $handle_GetOutlineTextMetricsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  (func $handle_GetOutlineTextMetricsW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_GetOutlineTextMetricsA
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
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
    (global.set $eax (call $gdi_font_write_text_face
      (local.get $arg0) (local.get $arg1)
      (if (result i32) (local.get $arg2)
        (then (call $g2w (local.get $arg2))) (else (i32.const 0)))
      (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 167: CreateFontIndirectA — LOGFONT at arg0
  (func $handle_CreateFontIndirectA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $lf i32) (local $handle i32)
    (local.set $lf (call $g2w (local.get $arg0)))
    ;; LOGFONT: lfHeight(+0), lfWeight(+16), lfItalic(+20), lfFaceName(+28)
    (local.set $handle (call $gdi_font_create
      (i32.load (local.get $lf))                              ;; height
      (i32.load (i32.add (local.get $lf) (i32.const 16)))    ;; weight
      (i32.load8_u (i32.add (local.get $lf) (i32.const 20))) ;; italic
      (i32.add (local.get $lf) (i32.const 28))               ;; faceName WASM ptr
    ))
    (call $gdi_bitmap_font_bind (local.get $handle)
      (i32.add (local.get $lf) (i32.const 28)))
    (global.set $eax (local.get $handle))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 168: CreateFontA — 14 params on stack
  (func $handle_CreateFontA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $handle i32) (local $weight i32) (local $italic i32) (local $face i32)
    ;; CreateFontA takes fourteen arguments, so argument n sits at esp+4n:
    ;; nHeight is arg0, fnWeight is the 5th at esp+20, fdwItalic the 6th at
    ;; esp+24, and lpszFace the 14th at esp+56. These offsets used to be one
    ;; slot short each, which read weight out of nOrientation and the face
    ;; name out of fdwPitchAndFamily — always zero, so every CreateFontA font
    ;; was nameless and fell back to a stock face at its own size. fontview's
    ;; 30-point headline is drawn with this call.
    (local.set $weight (call $gl32 (i32.add (global.get $esp) (i32.const 20))))
    (local.set $italic (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (local.set $face (call $g2w (call $gl32
      (i32.add (global.get $esp) (i32.const 56)))))
    (local.set $handle (call $gdi_font_create
      (local.get $arg0)                                              ;; height
      (local.get $weight)                                            ;; weight
      (local.get $italic)                                            ;; italic
      (local.get $face)                                              ;; faceName
    ))
    (call $gdi_bitmap_font_bind (local.get $handle) (local.get $face))
    (global.set $eax (local.get $handle))
    (global.set $esp (i32.add (global.get $esp) (i32.const 60))) (return)
  )

  ;; CreateDCA(lpszDriver, lpszDevice, lpszOutput, lpInitData) — 4 args stdcall.
  ;; Allocate a WAT-owned printable Letter page and tag it for printer caps.
  (func $handle_CreateDCA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $printer_hdc (call $gdi_printer_dc_alloc))
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

  ;; UpdateColors(hdc) — canonical surfaces store true-color results, so no
  ;; physical palette remap is required after realizing a logical palette.
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
    (local $menu_key i32)
    ;; SetMenu changes the non-client layout. Install the menu in WAT before
    ;; later GetDC/GetClientRect/ShowWindow paths ask for client geometry;
    ;; several WEP games attach their menu after CreateWindowExA and paint
    ;; immediately.
    ;; LoadMenuA/W tag integer resource handles with 0x00BE0000; the legacy
    ;; menu_set fallback is 0x00080001. Named-resource keys returned by
    ;; GetMenu are guest pointers and must remain intact.
    (local.set $menu_key (local.get $arg1))
    (if (i32.or
          (i32.eq (local.get $menu_key) (i32.const 0x00080001))
          (i32.eq
            (i32.and (local.get $menu_key) (i32.const 0xFFFF0000))
            (i32.const 0x00BE0000)))
      (then
        (local.set $menu_key
          (i32.and (local.get $menu_key) (i32.const 0xFFFF)))))
    (call $menu_load (local.get $arg0) (local.get $menu_key))
    (call $defwndproc_do_nccalcsize (local.get $arg0))
    (call $host_set_menu
    (local.get $arg0)                                       ;; hWnd
    (local.get $menu_key))                                  ;; resource ID or named-resource pointer
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
      (then
        (global.set $eax (call $gdi_dc_set_field
          (local.get $arg0) (i32.const 36) (local.get $arg1) (i32.const 1)))
        ;; MM_TEXT is device-pixel identity mapping. Switching from an
        ;; anisotropic preview transform must stop applying its old extents;
        ;; MFC does exactly this while drawing the physical page frame.
        (if (i32.eq (local.get $arg1) (i32.const 1))
          (then
            (drop (call $gdi_dc_set_field
              (local.get $arg0) (i32.const 48) (i32.const 1) (i32.const 1)))
            (drop (call $gdi_dc_set_field
              (local.get $arg0) (i32.const 52) (i32.const 1) (i32.const 1)))
            (drop (call $gdi_dc_set_field
              (local.get $arg0) (i32.const 64) (i32.const 1) (i32.const 1)))
            (drop (call $gdi_dc_set_field
              (local.get $arg0) (i32.const 68) (i32.const 1) (i32.const 1))))))
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
    ;; Both extents have to be non-zero, and each is tested on its own: a raw
    ;; `i32.and` of the two is a bit mask, so SetWindowExtEx(hdc, 1, 2) — or any
    ;; other pair with no bit in common — used to be rejected as if it were zero.
    (if (i32.and (i32.ne (local.get $arg1) (i32.const 0))
                 (i32.ne (local.get $arg2) (i32.const 0)))
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
    (if (i32.or
          (i32.ne (local.get $arg0) (global.get $printer_hdc))
          (i32.ne (global.get $printer_doc_state) (i32.const 0)))
      (then (global.set $eax (i32.const -1)))
      (else
        (global.set $printer_doc_state (i32.const 1))
        (global.set $printer_page_count (i32.const 0))
        (global.set $eax (i32.const 1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  (func $handle_StartPage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.or
          (i32.ne (local.get $arg0) (global.get $printer_hdc))
          (i32.ne (global.get $printer_doc_state) (i32.const 1)))
      (then (global.set $eax (i32.const -1)))
      (else
        (if (i32.eqz (call $gdi_printer_page_clear (local.get $arg0)))
          (then (global.set $eax (i32.const -1)))
          (else
            (global.set $printer_doc_state (i32.const 2))
            (global.set $printer_page_count (i32.add (global.get $printer_page_count) (i32.const 1)))
            (global.set $eax (i32.const 1))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  (func $handle_EndPage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.or
          (i32.ne (local.get $arg0) (global.get $printer_hdc))
          (i32.ne (global.get $printer_doc_state) (i32.const 2)))
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
        (drop (call $host_release_dc (local.get $hdc)))
        ;; Child controls share the top-level canonical surface. Their queued
        ;; paint must run after the parent finishes, otherwise the parent's
        ;; background/client pass overwrites already-rendered controls.
        (drop (call $paint_flush_visible_native_children (local.get $arg0)))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  (func $handle_EndDoc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.and
          (i32.eq (local.get $arg0) (global.get $printer_hdc))
          (i32.eq (global.get $printer_doc_state) (i32.const 1)))
      (then
        (global.set $printer_doc_state (i32.const 0))
        (global.set $eax (i32.const 1)))
      (else (global.set $eax (i32.const -1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  (func $handle_AbortDoc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eq (local.get $arg0) (global.get $printer_hdc))
      (then
        (global.set $printer_doc_state (i32.const 0))
        (global.set $eax (i32.const 1)))
      (else (global.set $eax (i32.const -1))))
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

  (func $handle_CreateBitmapIndirect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_bitmap_create_indirect
      (if (result i32) (local.get $arg0)
        (then (call $g2w (local.get $arg0))) (else (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_GetBitmapBits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_bitmap_bits (local.get $arg0) (local.get $arg1)
      (if (result i32) (local.get $arg2)
        (then (call $g2w (local.get $arg2))) (else (i32.const 0))) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_SetBitmapBits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_bitmap_bits (local.get $arg0) (local.get $arg1)
      (if (result i32) (local.get $arg2)
        (then (call $g2w (local.get $arg2))) (else (i32.const 0))) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_GetBitmapDimensionEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.and (i32.ne (call $gdi_object_type (local.get $arg0)) (i32.const 3))
          (i32.ne (local.get $arg0) (i32.const 0x30007)))
      (then (global.set $eax (i32.const 0)))
      (else
        (if (local.get $arg1)
          (then
            (call $gs32 (local.get $arg1) (i32.const 0))
            (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))))
        (global.set $eax (i32.ne (local.get $arg1) (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_GetBrushOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.or (i32.eqz (local.get $arg1))
          (i32.eqz (call $gdi_dc_state_entry (local.get $arg0) (i32.const 0))))
      (then (global.set $eax (i32.const 0)))
      (else
        (call $gs32 (local.get $arg1)
          (call $gdi_dc_aux_get (local.get $arg0) (i32.const 8) (i32.const 0)))
        (call $gs32 (i32.add (local.get $arg1) (i32.const 4))
          (call $gdi_dc_aux_get (local.get $arg0) (i32.const 12) (i32.const 0)))
        (global.set $eax (i32.const 1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_CreateRoundRectRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_rgn_alloc_round_rect
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)
      (local.get $arg4) (call $gl32 (i32.add (global.get $esp) (i32.const 24)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  (func $handle_CreatePolyPolygonRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_rgn_alloc_poly_polygon
      (if (result i32) (local.get $arg0)
        (then (call $g2w (local.get $arg0))) (else (i32.const 0)))
      (if (result i32) (local.get $arg1)
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (local.get $arg2) (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  (func $handle_PtInRegion (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_rgn_point_in
      (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_GetRegionData (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_rgn_get_data
      (local.get $arg0) (local.get $arg1)
      (if (result i32) (local.get $arg2)
        (then (call $g2w (local.get $arg2))) (else (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_MaskBlt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32) (local $src i32) (local $mask i32) (local $src_hdc i32)
    (local $sx i32) (local $sy i32) (local $mask_bitmap i32)
    (local $mx i32) (local $my i32) (local $rop4 i32)
    (local $dx i32) (local $dy i32) (local $ok i32)
    (local.set $dst (global.get $GDI_BLIT_DST_DESC))
    (local.set $src (global.get $GDI_BLIT_SRC_DESC))
    (local.set $mask (global.get $GDI_BRUSH_DESC))
    (local.set $src_hdc (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (local.set $sx (call $gl32 (i32.add (global.get $esp) (i32.const 28))))
    (local.set $sy (call $gl32 (i32.add (global.get $esp) (i32.const 32))))
    (local.set $mask_bitmap (call $gl32 (i32.add (global.get $esp) (i32.const 36))))
    (local.set $mx (call $gl32 (i32.add (global.get $esp) (i32.const 40))))
    (local.set $my (call $gl32 (i32.add (global.get $esp) (i32.const 44))))
    (local.set $rop4 (call $gl32 (i32.add (global.get $esp) (i32.const 48))))
    (if (i32.and
          (i32.and (call $gdi_surface_descriptor (local.get $arg0) (local.get $dst))
            (call $gdi_surface_descriptor (local.get $src_hdc) (local.get $src)))
          (i32.and (call $gdi_raster_desc_from_bitmap (local.get $mask_bitmap) (local.get $mask))
            (i32.eq (i32.load offset=16 (local.get $mask)) (i32.const 1))))
      (then
        (local.set $dx (call $gdi_line_map_x (local.get $dst) (local.get $arg1)))
        (local.set $dy (call $gdi_line_map_y (local.get $dst) (local.get $arg2)))
        (local.set $sx (call $gdi_line_map_x (local.get $src) (local.get $sx)))
        (local.set $sy (call $gdi_line_map_y (local.get $src) (local.get $sy)))
        (local.set $ok (call $gdi_raster_mask_blt
          (local.get $dst) (local.get $dx) (local.get $dy) (local.get $arg3) (local.get $arg4)
          (local.get $src) (local.get $sx) (local.get $sy)
          (i32.load (local.get $mask)) (i32.load offset=12 (local.get $mask))
          (local.get $mx) (local.get $my) (i32.const 0) (local.get $rop4)))
        (if (local.get $ok)
          (then (call $gdi_geometry_present (local.get $arg0) (local.get $dst)
            (local.get $dx) (local.get $dy)
            (i32.add (local.get $dx) (local.get $arg3))
            (i32.add (local.get $dy) (local.get $arg4)))))))
    (global.set $eax (local.get $ok))
    (global.set $esp (i32.add (global.get $esp) (i32.const 52))))

  (func $handle_AnimatePalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_palette_animate
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (if (result i32) (local.get $arg3)
        (then (call $g2w (local.get $arg3))) (else (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  (func $handle_GetGraphicsMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (select
      (call $gdi_dc_meta_get (local.get $arg0) (i32.const 8) (i32.const 1))
      (i32.const 0)
      (i32.ne (call $gdi_dc_state_entry (local.get $arg0) (i32.const 0)) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_SetGraphicsMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.or (i32.lt_u (local.get $arg1) (i32.const 1))
          (i32.gt_u (local.get $arg1) (i32.const 2)))
      (then (global.set $eax (i32.const 0)))
      (else (global.set $eax (call $gdi_dc_meta_set
        (local.get $arg0) (i32.const 8) (local.get $arg1) (i32.const 1)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_GetSystemPaletteUse (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (select
      (call $gdi_dc_meta_get (local.get $arg0) (i32.const 12) (i32.const 1))
      (i32.const 0)
      (i32.ne (call $gdi_dc_state_entry (local.get $arg0) (i32.const 0)) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_GdiSetBatchLimit (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $gdi_batch_limit))
    (global.set $gdi_batch_limit
      (select (local.get $arg0) (i32.const 310) (i32.ne (local.get $arg0) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_SetDeviceGammaRamp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_gamma_ramp_set (local.get $arg0)
      (if (result i32) (local.get $arg1)
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_ChoosePixelFormat (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_pixel_format_choose (local.get $arg0)
      (if (result i32) (local.get $arg1)
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_DescribePixelFormat (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.or
          (i32.eqz (call $gdi_dc_state_entry (local.get $arg0) (i32.const 0)))
          (i32.ne (local.get $arg1) (i32.const 1)))
      (then (global.set $eax (i32.const 0)))
      (else
        (if (local.get $arg3)
          (then (drop (call $gdi_pixel_format_write
            (call $g2w (local.get $arg3)) (local.get $arg2)))))
        (global.set $eax (i32.const 1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  (func $handle_SetPixelFormat (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_pixel_format_set
      (local.get $arg0) (local.get $arg1)
      (if (result i32) (local.get $arg2)
        (then (call $g2w (local.get $arg2))) (else (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_GetPixelFormat (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (select
      (call $gdi_dc_meta_get (local.get $arg0) (i32.const 16) (i32.const 0))
      (i32.const 0)
      (i32.ne (call $gdi_dc_state_entry (local.get $arg0) (i32.const 0)) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_SwapBuffers (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $desc i32) (local $ok i32)
    (local.set $desc (global.get $GDI_BLIT_DST_DESC))
    (if (i32.and
          (i32.eq (call $gdi_dc_meta_get (local.get $arg0) (i32.const 16)
            (i32.const 0)) (i32.const 1))
          (call $gdi_surface_descriptor (local.get $arg0) (local.get $desc)))
      (then
        (call $gdi_geometry_present (local.get $arg0) (local.get $desc)
          (i32.const 0) (i32.const 0)
          (i32.load offset=4 (local.get $desc))
          (i32.load offset=8 (local.get $desc)))
        (local.set $ok (i32.const 1))))
    (global.set $eax (local.get $ok))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_GetTextExtentExPointA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dx_g i32) (local $size_g i32)
    (local.set $dx_g (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (local.set $size_g (call $gl32 (i32.add (global.get $esp) (i32.const 28))))
    (global.set $eax (call $gdi_text_extent_ex
      (local.get $arg0)
      (if (result i32) (local.get $arg1)
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (local.get $arg2) (local.get $arg3)
      (if (result i32) (local.get $arg4)
        (then (call $g2w (local.get $arg4))) (else (i32.const 0)))
      (if (result i32) (local.get $dx_g)
        (then (call $g2w (local.get $dx_g))) (else (i32.const 0)))
      (if (result i32) (local.get $size_g)
        (then (call $g2w (local.get $size_g))) (else (i32.const 0)))
      (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32))))

  (func $handle_GetTextExtentExPointW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dx_g i32) (local $size_g i32)
    (local.set $dx_g (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (local.set $size_g (call $gl32 (i32.add (global.get $esp) (i32.const 28))))
    (global.set $eax (call $gdi_text_extent_ex
      (local.get $arg0)
      (if (result i32) (local.get $arg1)
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (local.get $arg2) (local.get $arg3)
      (if (result i32) (local.get $arg4)
        (then (call $g2w (local.get $arg4))) (else (i32.const 0)))
      (if (result i32) (local.get $dx_g)
        (then (call $g2w (local.get $dx_g))) (else (i32.const 0)))
      (if (result i32) (local.get $size_g)
        (then (call $g2w (local.get $size_g))) (else (i32.const 0)))
      (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32))))

  (func $handle_GetCharABCWidthsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_char_abc_widths_a
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (if (result i32) (local.get $arg3)
        (then (call $g2w (local.get $arg3))) (else (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  (func $handle_GetGlyphOutlineA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buffer_g i32) (local $mat2_g i32) (local $result i32)
    (local.set $buffer_g (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (local.set $mat2_g (call $gl32 (i32.add (global.get $esp) (i32.const 28))))
    (local.set $result (call $gdi_bitmap_glyph_outline_a
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (if (result i32) (local.get $arg3)
        (then (call $g2w (local.get $arg3))) (else (i32.const 0)))
      (local.get $arg4)
      (if (result i32) (local.get $buffer_g)
        (then (call $g2w (local.get $buffer_g))) (else (i32.const 0)))
      (if (result i32) (local.get $mat2_g)
        (then (call $g2w (local.get $mat2_g))) (else (i32.const 0)))))
    (if (i32.eq (local.get $result) (i32.const -2))
      (then (local.set $result (call $gdi_glyph_metrics_a
        (local.get $arg0) (local.get $arg1) (local.get $arg2)
        (if (result i32) (local.get $arg3)
          (then (call $g2w (local.get $arg3))) (else (i32.const 0)))))))
    (global.set $eax (local.get $result))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32))))

  ;; GetFontData(hdc, dwTable, dwOffset, lpvBuffer, cbData) — read the sfnt
  ;; tables of the DC's selected font. dwTable carries the four-character tag
  ;; with its FIRST character in the low byte ('name' arrives as 0x656d616e),
  ;; the reverse of the big-endian order the table directory stores, so it is
  ;; byte-swapped before lookup. dwTable of zero addresses the whole file.
  ;;
  ;; Returning GDI_ERROR unconditionally, as this did while no font file was
  ;; reachable, costs more than a missing feature: fontview.exe asks for the
  ;; 'name' table to fill the block under its headline (Typeface name, File
  ;; size, Version, copyright) and silently drops all four lines when the call
  ;; fails. A bitmap font still gets GDI_ERROR, which is what Win98 does — the
  ;; tables genuinely do not exist.
  (func $handle_GetFontData (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dc i32) (local $handle i32) (local $face i32) (local $object i32)
    (local $data i32) (local $size i32) (local $tag i32)
    (local $off i32) (local $len i32) (local $avail i32) (local $n i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
    (global.set $eax (i32.const -1))
    (local.set $dc (call $gdi_dc_state_entry (local.get $arg0) (i32.const 0)))
    (if (i32.eqz (local.get $dc)) (then (return)))
    (local.set $handle (i32.load offset=88 (local.get $dc)))
    (if (i32.eqz (local.get $handle)) (then (return)))
    ;; A raster face has no sfnt tables and Win98 answered GDI_ERROR for one.
    ;; Check this before the substitution lookup: that lookup answers for every
    ;; face name, including one only an installed FNT carries, and would
    ;; otherwise hand the caller the default substitute's file for a font it
    ;; never selected.
    (local.set $object (call $gdi_object_record (local.get $handle)))
    (if (i32.and (i32.ne (local.get $object) (i32.const 0))
          (i32.ne (i32.load offset=24 (local.get $object)) (i32.const 0)))
      (then (return)))
    (local.set $face (call $tt_face_for_logfont
      (call $gdi_font_face (local.get $handle))
      (call $gdi_font_weight (local.get $handle))
      (call $gdi_font_italic (local.get $handle))))
    (if (i32.lt_s (local.get $face) (i32.const 0)) (then (return)))
    (local.set $data (call $tt_face_data (local.get $face)))
    (local.set $size (call $tt_face_size (local.get $face)))
    (if (i32.or (i32.eqz (local.get $data)) (i32.le_s (local.get $size) (i32.const 0)))
      (then (return)))
    (if (local.get $arg1)
      (then
        (local.set $tag (i32.or
          (i32.or (i32.shr_u (local.get $arg1) (i32.const 24))
                  (i32.and (i32.shr_u (local.get $arg1) (i32.const 8))
                           (i32.const 0x0000FF00)))
          (i32.or (i32.and (i32.shl (local.get $arg1) (i32.const 8))
                           (i32.const 0x00FF0000))
                  (i32.shl (local.get $arg1) (i32.const 24)))))
        (local.set $off (call $tt_table_off
          (local.get $data) (local.get $size) (local.get $tag)))
        (local.set $len (call $tt_table_len
          (local.get $data) (local.get $size) (local.get $tag)))
        (if (i32.or (i32.eqz (local.get $off)) (i32.eqz (local.get $len)))
          (then (return))))
      (else
        (local.set $off (i32.const 0))
        (local.set $len (local.get $size))))
    (if (i32.gt_u (local.get $arg2) (local.get $len)) (then (return)))
    (local.set $avail (i32.sub (local.get $len) (local.get $arg2)))
    ;; A null buffer asks how much there is to read.
    (if (i32.eqz (local.get $arg3))
      (then
        (global.set $eax (local.get $avail))
        (return)))
    (local.set $n (select (local.get $arg4) (local.get $avail)
      (i32.lt_u (local.get $arg4) (local.get $avail))))
    (if (local.get $n)
      (then
        (memory.copy
          (call $g2w (local.get $arg3))
          (i32.add (local.get $data)
            (i32.add (local.get $off) (local.get $arg2)))
          (local.get $n))))
    (global.set $eax (local.get $n)))

  ;; Install a font resource: Win16/Win9x bitmap strikes in the WAT text
  ;; rasterizer, or a TrueType file in the scalable face registry.
  ;;
  ;; A .TTF carries no FNT strikes, so the bitmap loader rejects it and the
  ;; call used to return 0 - and 0 is not a soft failure to a guest, it is
  ;; "no fonts were added". fontview.exe tests the result and destroys its own
  ;; window without painting, so the file it was launched on never appeared.
  (func $handle_AddFontResourceA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $added i32)
    (if (local.get $arg0)
      (then
        (local.set $added (call $gdi_bitmap_font_add_resource (local.get $arg0)))
        (if (i32.le_s (local.get $added) (i32.const 0))
          (then (local.set $added (call $tt_reg_add (local.get $arg0)))))))
    (global.set $eax (local.get $added))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_RemoveFontResourceA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $removed i32)
    (if (local.get $arg0)
      (then
        (local.set $removed
          (call $gdi_bitmap_font_remove_resource (local.get $arg0)))
        (if (i32.le_s (local.get $removed) (i32.const 0))
          (then (local.set $removed (call $tt_reg_remove (local.get $arg0)))))))
    (global.set $eax (local.get $removed))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_EnumFontsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret i32)
    (local.set $ret (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
    (call $gdi_font_enum_start (local.get $arg2) (local.get $arg3)
      (local.get $ret) (global.get $esp) (local.get $arg1)
      (i32.const 0) (i32.const 0xFF)))

  (func $handle_SetMetaFileBitsEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $data i32)
    (if (local.get $arg1) (then (local.set $data (call $g2w (local.get $arg1)))))
    (global.set $eax
      (if (result i32) (call $gdi_metafile_valid_wmf (local.get $data) (local.get $arg0))
        (then (call $gdi_metafile_create
          (i32.const 6) (local.get $data) (local.get $arg0)))
        (else (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_GetMetaFileBitsEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_metafile_bits
      (local.get $arg0) (i32.const 6) (local.get $arg1)
      (if (result i32) (local.get $arg2)
        (then (call $g2w (local.get $arg2))) (else (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_SetEnhMetaFileBits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $data i32)
    (if (local.get $arg1) (then (local.set $data (call $g2w (local.get $arg1)))))
    (global.set $eax
      (if (result i32) (call $gdi_metafile_valid_emf (local.get $data) (local.get $arg0))
        (then (call $gdi_metafile_create
          (i32.const 7) (local.get $data) (local.get $arg0)))
        (else (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_GetEnhMetaFileBits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_metafile_bits
      (local.get $arg0) (i32.const 7) (local.get $arg1)
      (if (result i32) (local.get $arg2)
        (then (call $g2w (local.get $arg2))) (else (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_CopyEnhMetaFileA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_metafile_copy (local.get $arg0) (i32.const 7)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_DeleteEnhMetaFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (if (result i32)
        (i32.ne (call $gdi_metafile_record (local.get $arg0) (i32.const 7)) (i32.const 0))
        (then (call $gdi_object_delete_full (local.get $arg0)))
        (else (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_GetEnhMetaFileHeader (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_enh_metafile_header
      (local.get $arg0) (local.get $arg1)
      (if (result i32) (local.get $arg2)
        (then (call $g2w (local.get $arg2))) (else (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_GetEnhMetaFilePaletteEntries (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (if (i32.eqz (call $gdi_metafile_record (local.get $arg0) (i32.const 7)))
      (then (global.set $eax (i32.const -1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_PlayEnhMetaFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_metafile_play_emf
      (local.get $arg0) (local.get $arg1)
      (if (result i32) (local.get $arg2)
        (then (call $g2w (local.get $arg2))) (else (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_GetWinMetaFileBits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $temporary i32)
    (if (i32.eqz (call $gdi_metafile_record (local.get $arg0) (i32.const 7)))
      (then (global.set $eax (i32.const 0)))
      (else
        (local.set $temporary (call $gdi_metafile_convert_emf_to_wmf (local.get $arg0)))
        (if (i32.eqz (local.get $temporary))
          (then (global.set $eax (i32.const 0)))
          (else
            (global.set $eax (call $gdi_metafile_bits
              (local.get $temporary) (i32.const 6) (local.get $arg1)
              (if (result i32) (local.get $arg2)
                (then (call $g2w (local.get $arg2))) (else (i32.const 0)))))
            (drop (call $gdi_object_delete_full (local.get $temporary)))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  (func $handle_SetWinMetaFileBits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $data i32)
    (if (local.get $arg1) (then (local.set $data (call $g2w (local.get $arg1)))))
    (global.set $eax
      (if (result i32) (call $gdi_metafile_valid_wmf (local.get $data) (local.get $arg0))
        (then (call $gdi_metafile_convert_wmf_to_emf
          (local.get $data) (local.get $arg0)))
        (else (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  (func $handle_GetICMProfileA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32)
    (if (i32.or
          (i32.eqz (call $gdi_dc_state_entry (local.get $arg0) (i32.const 0)))
          (i32.eqz (local.get $arg1)))
      (then (global.set $eax (i32.const 0)))
      (else
        (if (i32.or (i32.eqz (local.get $arg2))
              (i32.lt_u (call $gl32 (local.get $arg1)) (i32.const 29)))
          (then
            (call $gs32 (local.get $arg1) (i32.const 29))
            (global.set $eax (i32.const 0)))
          (else
            (local.set $dst (call $g2w (local.get $arg2)))
            (i32.store (local.get $dst) (i32.const 0x42475273))
            (i32.store offset=4 (local.get $dst) (i32.const 0x6C6F4320))
            (i32.store offset=8 (local.get $dst) (i32.const 0x5320726F))
            (i32.store offset=12 (local.get $dst) (i32.const 0x65636170))
            (i32.store offset=16 (local.get $dst) (i32.const 0x6F725020))
            (i32.store offset=20 (local.get $dst) (i32.const 0x656C6966))
            (i32.store offset=24 (local.get $dst) (i32.const 0x6D63692E))
            (i32.store8 offset=28 (local.get $dst) (i32.const 0))
            (call $gs32 (local.get $arg1) (i32.const 29))
            (global.set $eax (i32.const 1))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_ResetDCA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (select (local.get $arg0) (i32.const 0)
      (i32.ne (call $gdi_dc_state_entry (local.get $arg0) (i32.const 0)) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; ============================================================
  ;; GDI HANDLERS MOVED FROM 09a-handlers.wat
  ;; 116 more $handle_* GDI entry points — DC state, blits, shapes, text, fonts,
  ;; regions, paths, palettes, DIBs and metafiles. The catch-all file held more GDI
  ;; surface than this one did.
  ;; ============================================================

  ;; 86: GetDeviceCaps
  (func $handle_GetDeviceCaps (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $screen i32)
    ;; Letter printer: 8.5x11 inches at 300 DPI, printable 8x10.5 inches.
    (if (i32.and
          (i32.ne (global.get $printer_hdc) (i32.const 0))
          (i32.eq (local.get $arg0) (global.get $printer_hdc)))
      (then
        (global.set $eax (i32.const 0))
        (if (i32.eq (local.get $arg1) (i32.const 2)) (then (global.set $eax (i32.const 2))))    ;; DT_RASPRINTER
        (if (i32.eq (local.get $arg1) (i32.const 4)) (then (global.set $eax (i32.const 216))))  ;; HORZSIZE mm
        (if (i32.eq (local.get $arg1) (i32.const 6)) (then (global.set $eax (i32.const 279))))  ;; VERTSIZE mm
        (if (i32.eq (local.get $arg1) (i32.const 8)) (then (global.set $eax (i32.const 2400)))) ;; HORZRES
        (if (i32.eq (local.get $arg1) (i32.const 10)) (then (global.set $eax (i32.const 3150)))) ;; VERTRES
        (if (i32.eq (local.get $arg1) (i32.const 12)) (then (global.set $eax (i32.const 32))))   ;; BITSPIXEL
        (if (i32.eq (local.get $arg1) (i32.const 14)) (then (global.set $eax (i32.const 1))))    ;; PLANES
        (if (i32.eq (local.get $arg1) (i32.const 88)) (then (global.set $eax (i32.const 300))))  ;; LOGPIXELSX
        (if (i32.eq (local.get $arg1) (i32.const 90)) (then (global.set $eax (i32.const 300))))  ;; LOGPIXELSY
        (if (i32.eq (local.get $arg1) (i32.const 110)) (then (global.set $eax (i32.const 2550)))) ;; PHYSICALWIDTH
        (if (i32.eq (local.get $arg1) (i32.const 111)) (then (global.set $eax (i32.const 3300)))) ;; PHYSICALHEIGHT
        (if (i32.eq (local.get $arg1) (i32.const 112)) (then (global.set $eax (i32.const 75))))   ;; PHYSICALOFFSETX
        (if (i32.eq (local.get $arg1) (i32.const 113)) (then (global.set $eax (i32.const 75))))   ;; PHYSICALOFFSETY
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    ;; Return reasonable defaults for common caps
    ;; TECHNOLOGY=2, HORZSIZE=4, VERTSIZE=6, HORZRES=8, VERTRES=10,
    ;; RASTERCAPS=38, ASPECT*=40/42/44, LOGPIXELSX=88, LOGPIXELSY=90.
    ;; Unknown caps default to 0. Leaving EAX untouched here leaks unrelated
    ;; previous API return values into layout code (RichEdit queries several
    ;; display caps while positioning typed text).
    (global.set $eax (i32.const 0))
    (if (i32.eq (local.get $arg1) (i32.const 2))
    (then (global.set $eax (i32.const 1))))   ;; TECHNOLOGY: DT_RASDISPLAY
    (if (i32.eq (local.get $arg1) (i32.const 4))
    (then
      (local.set $screen (call $host_get_screen_size))
      (global.set $eax
        (i32.div_u
          (i32.mul (i32.and (local.get $screen) (i32.const 0xFFFF)) (i32.const 254))
          (i32.const 960)))))                ;; HORZSIZE in millimeters
    (if (i32.eq (local.get $arg1) (i32.const 6))
    (then
      (local.set $screen (call $host_get_screen_size))
      (global.set $eax
        (i32.div_u
          (i32.mul (i32.shr_u (local.get $screen) (i32.const 16)) (i32.const 254))
          (i32.const 960)))))                ;; VERTSIZE in millimeters
    (if (i32.or (i32.eq (local.get $arg1) (i32.const 8)) (i32.eq (local.get $arg1) (i32.const 10)))
    (then
    (local.set $screen (call $host_get_screen_size))
    (if (i32.eq (local.get $arg1) (i32.const 8))
    (then (global.set $eax (i32.and (local.get $screen) (i32.const 0xFFFF)))))  ;; HORZRES
    (if (i32.eq (local.get $arg1) (i32.const 10))
    (then (global.set $eax (i32.shr_u (local.get $screen) (i32.const 16)))))))
    (if (i32.eq (local.get $arg1) (i32.const 88))
    (then (global.set $eax (i32.const 96))))   ;; LOGPIXELSX
    (if (i32.eq (local.get $arg1) (i32.const 90))
    (then (global.set $eax (i32.const 96))))   ;; LOGPIXELSY
    (if (i32.eq (local.get $arg1) (i32.const 12))
    (then (global.set $eax (i32.const 32))))  ;; BITSPIXEL
    (if (i32.eq (local.get $arg1) (i32.const 14))
    (then (global.set $eax (i32.const 1))))   ;; PLANES
    (if (i32.eq (local.get $arg1) (i32.const 24))
    (then (global.set $eax (i32.const -1))))  ;; NUMCOLORS — -1 = >256 colors
    (if (i32.eq (local.get $arg1) (i32.const 36))
    (then (global.set $eax (i32.const 1))))   ;; CLIPCAPS: CP_RECTANGLE
    (if (i32.eq (local.get $arg1) (i32.const 38))
    (then (global.set $eax (i32.const 15033)))) ;; RASTERCAPS: common raster ops
    (if (i32.eq (local.get $arg1) (i32.const 40))
    (then (global.set $eax (i32.const 36))))  ;; ASPECTX
    (if (i32.eq (local.get $arg1) (i32.const 42))
    (then (global.set $eax (i32.const 36))))  ;; ASPECTY
    (if (i32.eq (local.get $arg1) (i32.const 44))
    (then (global.set $eax (i32.const 51))))  ;; ASPECTXY
    (if (i32.eq (local.get $arg1) (i32.const 104))
    (then (global.set $eax (i32.const 0))))   ;; SIZEPALETTE: no palette device
    (if (i32.eq (local.get $arg1) (i32.const 108))
    (then (global.set $eax (i32.const 24))))  ;; COLORRES — 24-bit color
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 131: TabbedTextOutA — WAT-owned tab parsing and glyph-mask composition.
  (func $handle_TabbedTextOutA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_tabbed_text
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4)
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 32)))
      (i32.const 0) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36)))
  )

  ;; 249: SetViewportExtEx(hdc, x, y, lpSize) → BOOL
  (func $handle_SetViewportExtEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg3)
      (then
        (call $gs32 (local.get $arg3)
          (call $gdi_dc_get_field (local.get $arg0) (i32.const 64) (i32.const 1)))
        (call $gs32 (i32.add (local.get $arg3) (i32.const 4))
          (call $gdi_dc_get_field (local.get $arg0) (i32.const 68) (i32.const 1)))))
    ;; Each extent is tested on its own — see $handle_SetWindowExtEx. A raw
    ;; `i32.and` here is a bit mask, and rejected (1, 2) as if it were zero.
    (if (i32.and (i32.ne (local.get $arg1) (i32.const 0))
                 (i32.ne (local.get $arg2) (i32.const 0)))
      (then
        (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 64) (local.get $arg1) (i32.const 1)))
        (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 68) (local.get $arg2) (i32.const 1)))
        (global.set $eax (i32.const 1)))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 254: GetTextExtentPoint32A — font-aware via host
  (func $handle_GetTextExtentPoint32A (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $packed i32)
    (local.set $packed (call $host_get_text_metrics (local.get $arg0)))
    (call $gs32 (local.get $arg3)
      (call $host_measure_text (local.get $arg0) (call $g2w (local.get $arg1))
        (local.get $arg2) (i32.const 0)))
    (call $gs32 (i32.add (local.get $arg3) (i32.const 4))
      (i32.and (local.get $packed) (i32.const 0xFFFF)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 312: SaveDC(hdc) → saved state index.
  (func $handle_SaveDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_save (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 313: RestoreDC(hdc, nSavedDC) → BOOL.
  (func $handle_RestoreDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_restore (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 314: GetTextMetricsW — zero-fill, return 1
  (func $handle_GetTextMetricsW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $packed i32) (local $h i32) (local $aveW i32)
    (local.set $packed (call $host_get_text_metrics (local.get $arg0)))
    (local.set $h (i32.and (local.get $packed) (i32.const 0xFFFF)))
    (local.set $aveW (i32.shr_u (local.get $packed) (i32.const 16)))
    (call $zero_memory (call $g2w (local.get $arg1)) (i32.const 60))
    (call $gs32 (local.get $arg1) (local.get $h))                                    ;; tmHeight
    (call $gs32 (i32.add (local.get $arg1) (i32.const 4))
      (i32.sub (local.get $h) (i32.const 3)))                                        ;; tmAscent
    (call $gs32 (i32.add (local.get $arg1) (i32.const 8)) (i32.const 3))             ;; tmDescent
    (call $gs32 (i32.add (local.get $arg1) (i32.const 20)) (local.get $aveW))        ;; tmAveCharWidth
    (call $gs32 (i32.add (local.get $arg1) (i32.const 24))
      (i32.mul (local.get $aveW) (i32.const 2)))                                     ;; tmMaxCharWidth
    (call $gs32 (i32.add (local.get $arg1) (i32.const 28)) (i32.const 400))          ;; tmWeight
    (call $gs32 (i32.add (local.get $arg1) (i32.const 36)) (i32.const 96))           ;; tmDigitizedAspectX
    (call $gs32 (i32.add (local.get $arg1) (i32.const 40)) (i32.const 96))           ;; tmDigitizedAspectY
    (call $gs16 (i32.add (local.get $arg1) (i32.const 44)) (i32.const 32))           ;; tmFirstChar
    (call $gs16 (i32.add (local.get $arg1) (i32.const 46)) (i32.const 255))          ;; tmLastChar
    (call $gs16 (i32.add (local.get $arg1) (i32.const 48)) (i32.const 31))           ;; tmDefaultChar
    (call $gs16 (i32.add (local.get $arg1) (i32.const 50)) (i32.const 32))           ;; tmBreakChar
    (i32.store8 (i32.add (call $g2w (local.get $arg1)) (i32.const 55)) (i32.const 0x26)) ;; tmPitchAndFamily
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 315: CreateFontIndirectW — LOGFONTW at arg0
  (func $handle_CreateFontIndirectW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $lf i32) (local $face i32) (local $handle i32)
    (local.set $lf (call $g2w (local.get $arg0)))
    (local.set $face (call $heap_alloc (i32.const 64)))
    (if (i32.eqz (local.get $face))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    ;; LOGFONTW: lfHeight(+0), lfWeight(+16), lfItalic(+20), lfFaceName(+28 wchar[32])
    (drop (call $wide_to_ansi (i32.add (local.get $arg0) (i32.const 28)) (local.get $face) (i32.const 64)))
    (local.set $handle (call $gdi_font_create
      (i32.load (local.get $lf))                              ;; height
      (i32.load (i32.add (local.get $lf) (i32.const 16)))    ;; weight
      (i32.load8_u (i32.add (local.get $lf) (i32.const 20))) ;; italic
      (call $g2w (local.get $face))                          ;; faceName WASM ptr
    ))
    (call $gdi_bitmap_font_bind (local.get $handle) (call $g2w (local.get $face)))
    (if (local.get $face) (then (call $heap_free (local.get $face))))
    (global.set $eax (local.get $handle))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 316: SetStretchBltMode(hdc, mode) → previous mode — 2 args stdcall
  (func $handle_SetStretchBltMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.and (i32.ge_u (local.get $arg1) (i32.const 1))
          (i32.le_u (local.get $arg1) (i32.const 4)))
      (then (global.set $eax (call $gdi_dc_set_field
        (local.get $arg0) (i32.const 80) (local.get $arg1) (i32.const 1))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 317: GetPixel(hdc, x, y) → COLORREF
  (func $handle_GetPixel (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $desc i32)
    (local.set $desc (global.get $GDI_BLIT_DST_DESC))
    (if (call $gdi_surface_descriptor (local.get $arg0) (local.get $desc))
      (then (global.set $eax (call $gdi_raster_get_pixel
        (local.get $desc)
        (call $gdi_line_map_x (local.get $desc) (local.get $arg1))
        (call $gdi_line_map_y (local.get $desc) (local.get $arg2)))))
      (else (global.set $eax (i32.const -1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; 318: SetPixel(hdc, x, y, color) → prev color
  (func $handle_SetPixel (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $desc i32) (local $x i32) (local $y i32) (local $result i32)
    (local.set $desc (global.get $GDI_BLIT_DST_DESC))
    (if (call $gdi_surface_descriptor (local.get $arg0) (local.get $desc))
      (then
        (local.set $x (call $gdi_line_map_x (local.get $desc) (local.get $arg1)))
        (local.set $y (call $gdi_line_map_y (local.get $desc) (local.get $arg2)))
        (local.set $result (call $gdi_raster_set_pixel
          (local.get $desc) (local.get $x) (local.get $y) (local.get $arg3)))
        (if (i32.ne (local.get $result) (i32.const -1))
          (then (call $gdi_geometry_present (local.get $arg0) (local.get $desc)
            (local.get $x) (local.get $y)
            (i32.add (local.get $x) (i32.const 1))
            (i32.add (local.get $y) (i32.const 1))))))
      (else (local.set $result (i32.const -1))))
    (global.set $eax (local.get $result))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; stdcall, 4 args
  )

  ;; 319: SetROP2(hdc, rop2) → previous ROP2 mode
  (func $handle_SetROP2 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_set_rop2 (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 972: GdiFlush() → BOOL — 0 args stdcall, no-op
  (func $handle_GdiFlush (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 357: CreatePatternBrush(hBitmap) — 1 arg stdcall
  (func $handle_CreatePatternBrush (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_bitmap_create_pattern_brush
      (local.get $arg0) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 358: GetPaletteEntries(hPalette, iStart, nEntries, lppe) — 4 args stdcall
  (func $handle_GetPaletteEntries (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_palette_get_entries
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (if (result i32) (local.get $arg3)
        (then (call $g2w (local.get $arg3))) (else (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; 4 args stdcall
  )

  ;; 359: SelectPalette(hdc, hPalette, bForceBackground) — 3 args stdcall
  ;; Store the logical palette in canonical per-DC WAT state.
  (func $handle_SelectPalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $prev i32)
    (local.set $prev (call $gdi_dc_select_palette (local.get $arg0) (local.get $arg1)))
    (global.set $eax (select (local.get $prev) (i32.const 0)
      (i32.ne (local.get $prev) (i32.const -1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; 3 args stdcall
  )

  ;; 360: RealizePalette(hdc) — 1 arg stdcall
  ;; In true-color mode this is mostly a no-op; return number of entries mapped
  (func $handle_RealizePalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_palette_count
      (call $gdi_dc_selected_palette (local.get $arg0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; 1 arg stdcall
  )

  ;; 361: CreateRectRgnIndirect(lprc) — allocate a WAT-owned rectangle region.
  (func $handle_CreateRectRgnIndirect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $r i32)
    (local.set $r (call $g2w (local.get $arg0)))
    (global.set $eax (call $gdi_rgn_alloc_rect
      (i32.load (local.get $r))
      (i32.load (i32.add (local.get $r) (i32.const 4)))
      (i32.load (i32.add (local.get $r) (i32.const 8)))
      (i32.load (i32.add (local.get $r) (i32.const 12)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 362: GetObjectW — same object layout as GetObjectA for bitmaps
  (func $handle_GetObjectW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eq (call $gdi_object_type (local.get $arg0)) (i32.const 4))
      (then
        (global.set $eax (call $gdi_font_write_logfont (local.get $arg0)
          (if (result i32) (local.get $arg2)
            (then (call $g2w (local.get $arg2))) (else (i32.const 0)))
          (local.get $arg1) (i32.const 1)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))))
      (else (call $handle_GetObjectA
        (local.get $arg0) (local.get $arg1) (local.get $arg2)
        (local.get $arg3) (local.get $arg4) (local.get $name_ptr))))
  )

  ;; SetTextAlign(hdc, fMode) — store alignment on the DC and return the previous value.
  (func $handle_SetTextAlign (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_set_text_align (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 364: ExtTextOutW(hdc, x, y, options, lprect, lpString, c, lpDx) — 8 args stdcall
  ;; Selected FNT strikes consume lpDx in WAT; the generic host path ignores it.
  (func $handle_ExtTextOutW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $lpString i32) (local $count i32) (local $rect_wa i32) (local $text_wa i32)
    (local $packed_ansi_len i32) (local $wide i32) (local $dx_wa i32) (local $lpDx i32)
    (local.set $lpString (call $gl32 (i32.add (global.get $esp) (i32.const 24)))) ;; arg5
    (local.set $count    (call $gl32 (i32.add (global.get $esp) (i32.const 28)))) ;; arg6 (wchar count)
    (if (local.get $arg4)
      (then (local.set $rect_wa (call $g2w (local.get $arg4)))))
    (if (local.get $lpString)
      (then (local.set $text_wa (call $g2w (local.get $lpString)))))
    (local.set $lpDx (call $gl32 (i32.add (global.get $esp) (i32.const 32))))
    (if (local.get $lpDx)
      (then (local.set $dx_wa (call $g2w (local.get $lpDx)))))
    (local.set $wide (i32.const 1))
    (local.set $packed_ansi_len
      (call $gdi_ext_text_out_w_packed_ansi_len (local.get $text_wa) (local.get $count)))
    (if (local.get $packed_ansi_len)
      (then
        (local.set $count (local.get $packed_ansi_len))
        (local.set $wide (i32.const 0))))
    (global.set $eax (call $host_gdi_ext_text_out
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $rect_wa)
      (local.get $text_wa) (local.get $count) (local.get $dx_wa) (local.get $wide)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36)))
  )

  ;; 365: PlayMetaFile(hdc, hmf) — parse and replay WAT-owned WMF records.
  (func $handle_PlayMetaFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_metafile_play_wmf
      (local.get $arg0) (local.get $arg1)
      (i32.const 0) (i32.const 0) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 366: CreatePalette(lpLogPalette) — 1 arg stdcall
  ;; LOGPALETTE: palVersion(u16, +0), palNumEntries(u16, +2), palPalEntry[](+4, each 4 bytes RGBX)
  (func $handle_CreatePalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $src_wa i32) (local $num_entries i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (local.set $src_wa (call $g2w (local.get $arg0)))
    (local.set $num_entries (i32.load16_u (i32.add (local.get $src_wa) (i32.const 2))))
    (global.set $eax (call $gdi_palette_alloc
      (i32.add (local.get $src_wa) (i32.const 4)) (local.get $num_entries)
      (i32.load16_u (local.get $src_wa))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; 1 arg stdcall
  )

  ;; 367: GetNearestColor — STUB: unimplemented
  (func $handle_GetNearestColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; On true-color display, return the same color
    (global.set $eax (local.get $arg1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 368: StretchDIBits(hdc, xDst, yDst, wDst, hDst, xSrc, ySrc, wSrc, hSrc, lpBits, lpBmi, usage, rop)
  ;; 13 args stdcall
  (func $handle_StretchDIBits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_stretch_dib_bits
      (local.get $arg0)                                              ;; hdc
      (local.get $arg1)                                              ;; xDst
      (local.get $arg2)                                              ;; yDst
      (local.get $arg3)                                              ;; wDst
      (local.get $arg4)                                              ;; hDst
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))       ;; xSrc
      (call $gl32 (i32.add (global.get $esp) (i32.const 28)))       ;; ySrc
      (call $gl32 (i32.add (global.get $esp) (i32.const 32)))       ;; wSrc
      (call $gl32 (i32.add (global.get $esp) (i32.const 36)))       ;; hSrc
      (call $g2w (call $gl32 (i32.add (global.get $esp) (i32.const 40))))  ;; lpBits → WASM addr
      (call $g2w (call $gl32 (i32.add (global.get $esp) (i32.const 44))))  ;; lpBmi → WASM addr
      (call $gl32 (i32.add (global.get $esp) (i32.const 48)))       ;; iUsage
      (call $gl32 (i32.add (global.get $esp) (i32.const 52)))       ;; dwRop
    ))
    (global.set $esp (i32.add (global.get $esp) (i32.const 56))))

  ;; 369: OffsetRgn(hrgn, nXOffset, nYOffset) → region complexity
  (func $handle_OffsetRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_rgn_offset
      (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 370: UnrealizeObject — no-op for our immediate-mode GDI object model.
  (func $handle_UnrealizeObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 372: CreateDCW — wide printer/display DC owns a canonical page surface.
  (func $handle_CreateDCW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $printer_hdc (call $gdi_printer_dc_alloc))
    (global.set $eax (global.get $printer_hdc))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 373: PtVisible(hdc, x, y) — query the WAT-owned explicit clip.
  (func $handle_PtVisible (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_clip_point_visible
      (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; 374: RectVisible(hdc, lprc) — query the WAT-owned explicit clip.
  (func $handle_RectVisible (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_clip_rect_visible
      (local.get $arg0) (call $g2w (local.get $arg1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 375: TextOutW(hdc, x, y, lpString, c) — 5 args stdcall, host reads UTF-16 LE.
  (func $handle_TextOutW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_text_out
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (call $g2w (local.get $arg3)) (local.get $arg4) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 376: Escape(hdc, nEscape, cbInput, lpInData, lpOutData).
  ;; Win9x MFC print preview still uses the legacy physical-page escapes even
  ;; when the printer DC otherwise exposes modern GetDeviceCaps metrics.
  (func $handle_Escape (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $query i32) (local $out i32)
    (local.set $out (local.get $arg4))
    ;; QUERYESCSUPPORT: lpInData contains the escape number being queried.
    (if (i32.eq (local.get $arg1) (i32.const 8))
      (then
        (if (local.get $arg3)
          (then (local.set $query (call $gl32 (local.get $arg3)))))
        (global.set $eax
          (i32.or
            (i32.or (i32.eq (local.get $query) (i32.const 12))
                    (i32.eq (local.get $query) (i32.const 13)))
            (i32.eq (local.get $query) (i32.const 14))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    ;; GETPHYSPAGESIZE: Letter at 300 DPI.
    (if (i32.eq (local.get $arg1) (i32.const 12))
      (then
        (if (local.get $out)
          (then
            (call $gs32 (local.get $out) (i32.const 2550))
            (call $gs32 (i32.add (local.get $out) (i32.const 4)) (i32.const 3300))))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    ;; GETPRINTINGOFFSET: 0.25-inch non-printable origin at 300 DPI.
    (if (i32.eq (local.get $arg1) (i32.const 13))
      (then
        (if (local.get $out)
          (then
            (call $gs32 (local.get $out) (i32.const 75))
            (call $gs32 (i32.add (local.get $out) (i32.const 4)) (i32.const 75))))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    ;; GETSCALINGFACTOR: no device-side scaling.
    (if (i32.eq (local.get $arg1) (i32.const 14))
      (then
        (if (local.get $out)
          (then
            (call $gs32 (local.get $out) (i32.const 0))
            (call $gs32 (i32.add (local.get $out) (i32.const 4)) (i32.const 0))))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; EnumFontFamiliesExA(hdc, lpLogfont, proc, lParam, flags) → INT.
  (func $handle_EnumFontFamiliesExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret i32) (local $charset i32)
    (local.set $ret (call $gl32 (global.get $esp)))
    (local.set $charset (i32.const 0xFF))
    (if (local.get $arg1)
      (then
        (local.set $charset (call $gl8 (i32.add (local.get $arg1) (i32.const 23))))
        (if (i32.eq (local.get $charset) (i32.const 1))
          (then (local.set $charset (i32.const 0xFF))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
    (call $gdi_font_enum_start (local.get $arg2) (local.get $arg3)
      (local.get $ret) (global.get $esp)
      (select (i32.add (local.get $arg1) (i32.const 28)) (i32.const 0)
        (i32.ne (local.get $arg1) (i32.const 0)))
      (i32.const 0) (local.get $charset))
  )

  ;; EnumFontFamiliesA(hdc, lpszFamily, proc, lParam) → INT.
  (func $handle_EnumFontFamiliesA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret i32)
    (local.set $ret (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
    (call $gdi_font_enum_start (local.get $arg2) (local.get $arg3)
      (local.get $ret) (global.get $esp) (local.get $arg1)
      (i32.const 0) (i32.const 0xFF))
  )

  ;; 377: EnumFontFamiliesExW(hdc, lpLogfont, proc, lParam, flags) → INT.
  (func $handle_EnumFontFamiliesExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret i32) (local $charset i32)
    (local.set $ret (call $gl32 (global.get $esp)))
    (local.set $charset (i32.const 0xFF))
    (if (local.get $arg1)
      (then
        (local.set $charset (call $gl8 (i32.add (local.get $arg1) (i32.const 23))))
        (if (i32.eq (local.get $charset) (i32.const 1))
          (then (local.set $charset (i32.const 0xFF))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
    (call $gdi_font_enum_start (local.get $arg2) (local.get $arg3)
      (local.get $ret) (global.get $esp)
      (select (i32.add (local.get $arg1) (i32.const 28)) (i32.const 0)
        (i32.ne (local.get $arg1) (i32.const 0)))
      (i32.const 1) (local.get $charset))
  )

  ;; 378: EnumFontFamiliesW(hdc, lpszFamily, proc, lParam) → INT.
  (func $handle_EnumFontFamiliesW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret i32)
    (local.set $ret (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
    (call $gdi_font_enum_start (local.get $arg2) (local.get $arg3)
      (local.get $ret) (global.get $esp) (local.get $arg1)
      (i32.const 1) (i32.const 0xFF))
  )

  ;; 438: FillRgn(hdc, hrgn, hbrush) → BOOL
  (func $handle_FillRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_fill_rgn
      (local.get $arg0) (call $gdi_rgn_host_handle (local.get $arg1)) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; PaintRgn(hdc, hrgn) → BOOL — paint with DC's current brush
  (func $handle_PaintRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_fill_rgn
      (local.get $arg0) (call $gdi_rgn_host_handle (local.get $arg1)) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; FrameRgn(hdc, hrgn, hbrush, nWidth, nHeight) -> BOOL
  (func $handle_FrameRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_frame_rgn
      (local.get $arg0) (call $gdi_rgn_host_handle (local.get $arg1))
      (local.get $arg2) (local.get $arg3) (local.get $arg4)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 439: GetDIBColorTable(hdc, startIndex, numEntries, pColors) → count
  (func $handle_GetDIBColorTable (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_get_dib_color_table
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; 440: SetDIBColorTable(hdc, startIndex, numEntries, pColors) → count
  (func $handle_SetDIBColorTable (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_set_dib_color_table
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (if (result i32) (local.get $arg3)
        (then (call $g2w (local.get $arg3))) (else (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; 441: ResizePalette(hPalette, nEntries) — 2 args stdcall
  (func $handle_ResizePalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_palette_resize (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; 2 args stdcall
  )

  ;; 442: GetNearestPaletteIndex(hPalette, crColor) — 2 args stdcall
  ;; Find the closest PALETTEENTRY in canonical WAT storage.
  (func $handle_GetNearestPaletteIndex (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_palette_nearest_index
      (local.get $arg0) (i32.and (local.get $arg1) (i32.const 0x00FFFFFF))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; 2 args stdcall
  )

  ;; 443: SetPaletteEntries(hPalette, iStart, nEntries, lppe) — 4 args stdcall
  (func $handle_SetPaletteEntries (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_palette_set_entries
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (if (result i32) (local.get $arg3)
        (then (call $g2w (local.get $arg3))) (else (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; 4 args stdcall
  )

  ;; 444: SetDIBits — STUB: unimplemented
  (func $handle_SetDIBits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetDIBits(hdc, hBitmap, uStartScan, cScanLines, lpBits, lpBMI, fuColorUse) → numScans
    ;; 7 args stdcall. arg0=hdc, arg1=hBitmap, arg2=uStartScan, arg3=cScanLines, arg4=lpBits
    ;; [esp+24]=lpBMI, [esp+28]=fuColorUse
    (local $wa_esp i32) (local $lpBMI i32) (local $fuColorUse i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $lpBMI (i32.load (i32.add (local.get $wa_esp) (i32.const 24))))
    (local.set $fuColorUse (i32.load (i32.add (local.get $wa_esp) (i32.const 28))))
    (global.set $eax (call $host_gdi_set_dib_bits
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)
      (call $g2w (local.get $arg4))
      (call $g2w (local.get $lpBMI))
      (local.get $fuColorUse)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))  ;; stdcall, 7 args
  )

  ;; 719: SetDIBitsToDevice(hdc, xDest, yDest, w, h, xSrc, ySrc, StartScan, cLines, lpBits, lpBMI, ColorUse)
  ;; 12 args stdcall. arg0-arg4 = hdc, xDest, yDest, w, h; rest on stack
  (func $handle_SetDIBitsToDevice (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa_esp i32) (local $xSrc i32) (local $ySrc i32) (local $startScan i32) (local $cLines i32)
    (local $lpBits i32) (local $lpBMI i32) (local $colorUse i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $xSrc (i32.load (i32.add (local.get $wa_esp) (i32.const 24))))
    (local.set $ySrc (i32.load (i32.add (local.get $wa_esp) (i32.const 28))))
    (local.set $startScan (i32.load (i32.add (local.get $wa_esp) (i32.const 32))))
    (local.set $cLines (i32.load (i32.add (local.get $wa_esp) (i32.const 36))))
    (local.set $lpBits (i32.load (i32.add (local.get $wa_esp) (i32.const 40))))
    (local.set $lpBMI (i32.load (i32.add (local.get $wa_esp) (i32.const 44))))
    (local.set $colorUse (i32.load (i32.add (local.get $wa_esp) (i32.const 48))))
    (global.set $eax (call $host_gdi_set_dib_to_device
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
      (local.get $xSrc) (local.get $ySrc) (local.get $startScan) (local.get $cLines)
      (call $g2w (local.get $lpBits)) (call $g2w (local.get $lpBMI)) (local.get $colorUse)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 52)))  ;; stdcall, 12 args
  )

  ;; 445: GetTextExtentPointW — font-aware wide text measurement
  (func $handle_GetTextExtentPointW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $packed i32)
    (local.set $packed (call $host_get_text_metrics (local.get $arg0)))
    (call $gs32 (local.get $arg3)
      (i32.mul (local.get $arg2) (i32.shr_u (local.get $packed) (i32.const 16))))
    (call $gs32 (i32.add (local.get $arg3) (i32.const 4))
      (i32.and (local.get $packed) (i32.const 0xFFFF)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 446: CreateICW — STUB: unimplemented
  (func $handle_CreateICW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CreateICW(lpszDriver, lpszDevice, lpszOutput, lpdvmInit) → HDC
    ;; 4 args stdcall. Returns an information context (IC) handle — use same as CreateCompatibleDC(0)
    (global.set $eax (call $host_gdi_create_compat_dc (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; stdcall, 4 args
  )

  ;; 718: CreateICA(lpszDriver, lpszDevice, lpszOutput, lpdvmInit) → HDC
  (func $handle_CreateICA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Same as CreateICW — returns an information context handle
    (global.set $eax (call $host_gdi_create_compat_dc (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; stdcall, 4 args
  )

  ;; 447: CreateDIBSection(hdc, pbmi, usage, ppvBits, hSection, offset)
  ;; Own the pixels and RGBQUAD color table in one canonical WAT allocation.
  (func $handle_CreateDIBSection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $handle i32) (local $record i32)
    (local.set $handle (call $gdi_bitmap_create_dib_section
      (local.get $arg0)
      (if (result i32) (local.get $arg1)
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (local.get $arg2)))
    (if (local.get $arg3)
      (then
        (local.set $record (call $gdi_object_record (local.get $handle)))
        (call $gs32 (local.get $arg3)
          (if (result i32) (local.get $record)
            (then (call $w2g (i32.load offset=24 (local.get $record))))
            (else (i32.const 0))))))
    (global.set $eax (local.get $handle))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  ;; 448: GetDIBits(hdc, hbmp, uStartScan, cScanLines, lpvBits, lpbmi, uUsage) — 7 args stdcall
  (func $handle_GetDIBits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa_esp i32) (local $lpbmi i32) (local $uUsage i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $lpbmi (i32.load (i32.add (local.get $wa_esp) (i32.const 24))))
    (local.set $uUsage (i32.load (i32.add (local.get $wa_esp) (i32.const 28))))
    (global.set $eax (call $host_gdi_get_di_bits
      (local.get $arg0)              ;; hdc
      (local.get $arg1)              ;; hbmp
      (local.get $arg2)              ;; uStartScan
      (local.get $arg3)              ;; cScanLines
      (local.get $arg4)              ;; lpvBits (guest address)
      (if (result i32) (local.get $lpbmi) (then (call $g2w (local.get $lpbmi))) (else (i32.const 0)))  ;; lpbmi (WASM ptr)
      (local.get $uUsage)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))  ;; 7 args + ret
  )

  ;; 449: CreateDIBitmap(hdc, lpbmih, fdwInit, lpbInit, lpbmi, fuUsage) — 6 args
  (func $handle_CreateDIBitmap (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CBM_INIT=4. lpbmi carries the RGBQUAD table; lpbmih is sufficient for
    ;; true-color callers that omit the duplicate BITMAPINFO pointer.
    (global.set $eax (call $gdi_bitmap_create_dibitmap
      (local.get $arg0)
      (call $g2w (select (local.get $arg4) (local.get $arg1)
        (i32.ne (local.get $arg4) (i32.const 0))))
      (if (result i32) (local.get $arg3)
        (then (call $g2w (local.get $arg3))) (else (i32.const 0)))
      (i32.ne (i32.and (local.get $arg2) (i32.const 4)) (i32.const 0))
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))) ;; 6 args + ret
  )

  ;; 450: StretchBlt(hdcDest, xDest, yDest, wDest, hDest, hdcSrc, xSrc, ySrc, wSrc, hSrc, dwRop)
  (func $handle_StretchBlt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32) (local $src i32) (local $src_hdc i32)
    (local $sx i32) (local $sy i32) (local $sw i32) (local $sh i32)
    (local $rop i32) (local $rop3 i32)
    (local $dx i32) (local $dy i32) (local $pattern i32) (local $ok i32)
    (local.set $dst (global.get $GDI_BLIT_DST_DESC))
    (local.set $src (global.get $GDI_BLIT_SRC_DESC))
    (local.set $src_hdc (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (local.set $sx (call $gl32 (i32.add (global.get $esp) (i32.const 28))))
    (local.set $sy (call $gl32 (i32.add (global.get $esp) (i32.const 32))))
    (local.set $sw (call $gl32 (i32.add (global.get $esp) (i32.const 36))))
    (local.set $sh (call $gl32 (i32.add (global.get $esp) (i32.const 40))))
    (local.set $rop (call $gl32 (i32.add (global.get $esp) (i32.const 44))))
    (local.set $rop3 (i32.and (i32.shr_u (local.get $rop) (i32.const 16)) (i32.const 0xFF)))
    (if (call $gdi_surface_descriptor (local.get $arg0) (local.get $dst))
      (then
        (local.set $dx (call $gdi_line_map_x (local.get $dst) (local.get $arg1)))
        (local.set $dy (call $gdi_line_map_y (local.get $dst) (local.get $arg2)))
        (if (local.get $src_hdc)
          (then
            (if (i32.eqz (call $gdi_surface_descriptor (local.get $src_hdc) (local.get $src)))
              (then (local.set $src (i32.const 0))))
            (if (local.get $src)
              (then
                (local.set $sx (call $gdi_line_map_x (local.get $src) (local.get $sx)))
                (local.set $sy (call $gdi_line_map_y (local.get $src) (local.get $sy))))))
          (else (local.set $src (i32.const 0))))
        (if (i32.and
              (i32.ne (i32.and
                (i32.xor (local.get $rop3) (i32.shr_u (local.get $rop3) (i32.const 2)))
                (i32.const 0x33)) (i32.const 0))
              (i32.eqz (local.get $src)))
          (then (local.set $ok (i32.const 0)))
          (else
            (local.set $ok (call $gdi_raster_stretch_blt
              (local.get $arg0) (local.get $src_hdc) (local.get $dst) (local.get $dx) (local.get $dy)
              (local.get $arg3) (local.get $arg4) (local.get $src)
              (local.get $sx) (local.get $sy) (local.get $sw) (local.get $sh)
              (local.get $pattern) (local.get $rop)))))
        (if (local.get $ok)
          (then (call $gdi_geometry_present (local.get $arg0) (local.get $dst)
            (local.get $dx) (local.get $dy)
            (i32.add (local.get $dx) (local.get $arg3))
            (i32.add (local.get $dy) (local.get $arg4))))))
      (else (local.set $ok (i32.const 0))))
    (global.set $eax (local.get $ok))
    (global.set $esp (i32.add (global.get $esp) (i32.const 48)))  ;; stdcall, 11 args
  )

  ;; 451: Polygon(hdc, lpPoints, nCount) — 3 args stdcall
  (func $handle_Polygon (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $desc i32)
    (if (call $gdi_dc_path_is_open (local.get $arg0))
      (then
        (global.set $eax (call $gdi_dc_path_record_polygon
          (local.get $arg0) (call $g2w (local.get $arg1)) (local.get $arg2)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (call $gdi_surface_descriptor (local.get $arg0) (local.get $desc))
      (then (global.set $eax (call $gdi_polygon_desc
        (local.get $arg0) (local.get $desc) (call $g2w (local.get $arg1)) (local.get $arg2)
        (call $gdi_dc_get_field (local.get $arg0) (i32.const 4) (i32.const 0x30017))
        (call $gdi_dc_get_field (local.get $arg0) (i32.const 8) (i32.const 0x30010))
        (call $gdi_dc_get_rop2 (local.get $arg0))
        (call $gdi_dc_get_field (local.get $arg0) (i32.const 76) (i32.const 1)))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args + ret
  )

  ;; 452: RoundRect(hdc, left, top, right, bottom, width, height) — 7 args stdcall
  (func $handle_RoundRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (call $gdi_dc_path_is_open (local.get $arg0))
      (then
        (global.set $eax (call $gdi_dc_path_record_round_rect
          (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
          (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
          (call $gl32 (i32.add (global.get $esp) (i32.const 28)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
        (return)))
    (global.set $eax (call $host_gdi_round_rect
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 28)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
  )

  ;; 454: CreatePolygonRgn(lpPoints, cPoints, fnPolyFillMode) → HRGN
  (func $handle_CreatePolygonRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_rgn_alloc_polygon
      (call $g2w (local.get $arg0)) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 455: PolyBezier(hdc, lppt, cPoints)
  (func $handle_PolyBezier (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (call $gdi_dc_path_is_open (local.get $arg0))
      (then (global.set $eax (call $gdi_dc_path_record_bezier
        (local.get $arg0) (call $g2w (local.get $arg1)) (local.get $arg2) (i32.const 0))))
      (else (global.set $eax (call $host_gdi_poly_bezier
        (local.get $arg0) (call $g2w (local.get $arg1)) (local.get $arg2) (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 456: Polyline(hdc, lppt, cPoints) — MoveTo first, LineTo rest
  (func $handle_Polyline (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p i32) (local $n i32) (local $ok i32)
    (local.set $n (local.get $arg2))
    (if (i32.lt_s (local.get $n) (i32.const 1))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (local.set $p (call $g2w (local.get $arg1)))
    (if (call $gdi_dc_path_is_open (local.get $arg0))
      (then (local.set $ok (call $gdi_dc_path_record_polyline
        (local.get $arg0) (local.get $p) (local.get $n) (i32.const 0))))
      (else (local.set $ok (call $gdi_polyline_try
        (local.get $arg0) (local.get $p) (local.get $n) (i32.const 0)))))
    (global.set $eax (local.get $ok))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 457: CreateHalftonePalette(hdc) — 1 arg stdcall
  ;; Return a palette handle for a standard 256-color halftone palette
  (func $handle_CreateHalftonePalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $handle i32) (local $record i32) (local $dst i32)
    (local $i i32) (local $r i32) (local $g i32) (local $b i32)
    (local.set $handle (call $gdi_palette_alloc
      (i32.const 0) (i32.const 256) (i32.const 0x300)))
    (if (i32.eqz (local.get $handle))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (local.set $record (call $gdi_palette_record (local.get $handle)))
    ;; Fill with 6x6x6 color cube + grays
    (local.set $dst (i32.load offset=24 (local.get $record)))
    (local.set $i (i32.const 0))
    (block $done (loop $fill
      (br_if $done (i32.ge_u (local.get $i) (i32.const 216)))
      (local.set $r (i32.mul (i32.rem_u (local.get $i) (i32.const 6)) (i32.const 51)))
      (local.set $g (i32.mul (i32.rem_u (i32.div_u (local.get $i) (i32.const 6)) (i32.const 6)) (i32.const 51)))
      (local.set $b (i32.mul (i32.div_u (local.get $i) (i32.const 36)) (i32.const 51)))
      (i32.store (i32.add (local.get $dst) (i32.mul (local.get $i) (i32.const 4)))
        (i32.or (i32.or (local.get $r) (i32.shl (local.get $g) (i32.const 8)))
          (i32.shl (local.get $b) (i32.const 16))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $fill)))
    ;; Fill remaining 40 with grays
    (block $done2 (loop $gray
      (br_if $done2 (i32.ge_u (local.get $i) (i32.const 256)))
      (local.set $r (i32.mul (i32.sub (local.get $i) (i32.const 216)) (i32.const 6)))
      (i32.store (i32.add (local.get $dst) (i32.mul (local.get $i) (i32.const 4)))
        (i32.or (i32.or (local.get $r) (i32.shl (local.get $r) (i32.const 8)))
          (i32.shl (local.get $r) (i32.const 16))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $gray)))
    (global.set $eax (local.get $handle))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; 1 arg stdcall
  )

  ;; Classic metafile recording uses a bounded canonical WAT surface. Closing
  ;; serializes it into an interoperable META_STRETCHDIB WMF stream.
  (func $handle_CreateMetaFileA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_metafile_recording_dc_create))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_CreateMetaFileW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_metafile_recording_dc_create))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; 554: DPtoLP(hdc, lpPoints, nCount) → BOOL.
  (func $handle_DPtoLP (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
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
    (if (i32.or (i32.eqz (local.get $vex)) (i32.eqz (local.get $vey)))
      (then (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (block $done (loop $points
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $p (i32.add (local.get $arg1) (i32.shl (local.get $i) (i32.const 3))))
      (call $gs32 (local.get $p)
        (call $gdi_map_coordinate (call $gl32 (local.get $p))
          (local.get $vx) (local.get $vex) (local.get $wx) (local.get $wex)))
      (call $gs32 (i32.add (local.get $p) (i32.const 4))
        (call $gdi_map_coordinate (call $gl32 (i32.add (local.get $p) (i32.const 4)))
          (local.get $vy) (local.get $vey) (local.get $wy) (local.get $wey)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $points)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 555: CombineRgn — WAT owns rectangle semantics; complex compatibility is mirrored.
  (func $handle_CombineRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CombineRgn(hrgnDest, hrgnSrc1, hrgnSrc2, fnCombineMode) — 4 args stdcall
    (global.set $eax (call $gdi_rgn_combine
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 556: SetRectRgn — update WAT-owned geometry and the presentation mirror.
  (func $handle_SetRectRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetRectRgn(hrgn, left, top, right, bottom) — 5 args stdcall.
    (global.set $eax (call $gdi_rgn_set_rect
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 557: GetMapMode(hdc) → MM_TEXT. The host renderer uses pixel/text
  ;; coordinates, so MM_TEXT is the stable default.
  (func $handle_GetMapMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 558: CreateDIBPatternBrushPt — copy packed DIB bytes into an owned WAT pattern.
  (func $handle_CreateDIBPatternBrushPt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_bitmap_create_dib_pattern_brush
      (if (result i32) (local.get $arg0)
        (then (call $g2w (local.get $arg0))) (else (i32.const 0)))
      (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 559: CreateHatchBrush(fnStyle, color) — preserve hatch style in WAT.
  (func $handle_CreateHatchBrush (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.gt_u (local.get $arg0) (i32.const 5))
      (then (global.set $eax (i32.const 0)))
      (else (global.set $eax (call $gdi_object_alloc (i32.const 2)
        (i32.const 2) (local.get $arg0) (local.get $arg1) (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 562: GetObjectType(h) → OBJ_* type. Host GDI owns the full object table,
  ;; but common handles have stable ranges/sentinels. Report enough type data
  ;; for code that distinguishes DC/metafile/font/brush/bitmap paths.
  (func $handle_GetObjectType (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wat_type i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (if (call $gdi_rgn_record (local.get $arg0))
      (then
        (global.set $eax (i32.const 8)) ;; OBJ_REGION
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (local.set $wat_type (call $gdi_object_type (local.get $arg0)))
    (if (i32.eq (local.get $wat_type) (i32.const 6))
      (then
        (global.set $eax (i32.const 9)) ;; OBJ_METAFILE
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (if (i32.eq (local.get $wat_type) (i32.const 7))
      (then
        (global.set $eax (i32.const 13)) ;; OBJ_ENHMETAFILE
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (if (local.get $wat_type)
      (then
        (global.set $eax
          (if (result i32) (i32.eq (local.get $wat_type) (i32.const 3))
            (then (i32.const 7))
            (else (if (result i32) (i32.eq (local.get $wat_type) (i32.const 4))
              (then (i32.const 6)) (else (local.get $wat_type))))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    ;; Explicit/surface DC handles.
    (if (i32.and
          (i32.ge_u (local.get $arg0) (i32.const 0x00200000))
          (i32.lt_u (local.get $arg0) (i32.const 0x00400000)))
      (then
        (global.set $eax (i32.const 3)) ;; OBJ_DC
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    ;; Legacy window DC encodings: hwnd + 0x40000 / hwnd + 0xC0000.
    (if (i32.and
          (i32.ge_u (local.get $arg0) (i32.const 0x00040000))
          (i32.lt_u (local.get $arg0) (i32.const 0x00100000)))
      (then
        (global.set $eax (i32.const 3)) ;; OBJ_DC
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    ;; Stock/default object sentinels.
    (if (i32.or
          (i32.eq (local.get $arg0) (i32.const 0x00030001))
          (i32.eq (local.get $arg0) (i32.const 0x00030007)))
      (then
        (global.set $eax (i32.const 7)) ;; OBJ_BITMAP
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (if (i32.or
          (i32.eq (local.get $arg0) (i32.const 0x00030002))
          (i32.and
            (i32.ge_u (local.get $arg0) (i32.const 0x00030010))
            (i32.le_u (local.get $arg0) (i32.const 0x00030015))))
      (then
        (global.set $eax (i32.const 2)) ;; OBJ_BRUSH
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (if (i32.and
          (i32.ge_u (local.get $arg0) (i32.const 0x00030016))
          (i32.le_u (local.get $arg0) (i32.const 0x00030018)))
      (then
        (global.set $eax (i32.const 1)) ;; OBJ_PEN
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (if (i32.and
          (i32.ge_u (local.get $arg0) (i32.const 0x0003001a))
          (i32.le_u (local.get $arg0) (i32.const 0x00030022)))
      (then
        (global.set $eax (i32.const 6)) ;; OBJ_FONT
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    ;; Every dynamic GDI object is represented in the canonical WAT table.
    ;; A handle which reached this point is invalid or has already been freed.
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 564: ExtSelectClipRgn(hdc, hrgn, fnMode) — 3 args stdcall
  (func $handle_ExtSelectClipRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_clip_ext_select
      (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 565: SelectClipPath(hdc, mode) — 2 args stdcall. The public BOOL hides
  ;; canonical region complexity.
  (func $handle_SelectClipPath (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_path_select_clip
      (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 566: CreateRectRgn — allocate a WAT-owned rectangle region.
  (func $handle_CreateRectRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CreateRectRgn(left, top, right, bottom) — 4 args stdcall
    (global.set $eax (call $gdi_rgn_alloc_rect
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 567: GetClipRgn(hdc, hrgn) — 2 args stdcall. Returns 1 if clip region set, 0 if none, -1 on error.
  (func $handle_GetClipRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_clip_get (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 568: PolyBezierTo(hdc, lppt, cPoints)
  (func $handle_PolyBezierTo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (call $gdi_dc_path_is_open (local.get $arg0))
      (then (global.set $eax (call $gdi_dc_path_record_bezier
        (local.get $arg0) (call $g2w (local.get $arg1)) (local.get $arg2) (i32.const 1))))
      (else (global.set $eax (call $host_gdi_poly_bezier
        (local.get $arg0) (call $g2w (local.get $arg1)) (local.get $arg2) (i32.const 1)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 570: PolylineTo(hdc, lppt, cPoints)
  (func $handle_PolylineTo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p i32) (local $ok i32) (local $last i32) (local $x i32) (local $y i32)
    (local.set $p (call $g2w (local.get $arg1)))
    (if (call $gdi_dc_path_is_open (local.get $arg0))
      (then (local.set $ok (call $gdi_dc_path_record_polyline
        (local.get $arg0) (local.get $p) (local.get $arg2) (i32.const 1))))
      (else (local.set $ok (call $gdi_polyline_try
        (local.get $arg0) (local.get $p) (local.get $arg2) (i32.const 1)))))
    (if (i32.and (local.get $ok) (i32.gt_s (local.get $arg2) (i32.const 0)))
      (then
        (local.set $last (i32.add (local.get $p)
          (i32.shl (i32.sub (local.get $arg2) (i32.const 1)) (i32.const 3))))
        (local.set $x (i32.load (local.get $last)))
        (local.set $y (i32.load offset=4 (local.get $last)))
        (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 12) (local.get $x) (i32.const 0)))
        (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 16) (local.get $y) (i32.const 0)))))
    (global.set $eax (local.get $ok))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 572: SetArcDirection(hdc, direction) -> previous direction.
  (func $handle_SetArcDirection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.or (i32.eq (local.get $arg1) (i32.const 1))
          (i32.eq (local.get $arg1) (i32.const 2)))
      (then (global.set $eax (call $gdi_dc_aux_set
        (local.get $arg0) (i32.const 4) (local.get $arg1) (i32.const 1))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 573: ArcTo — connect current position to the projected arc start and update it.
  (func $handle_ArcTo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (call $gdi_dc_path_is_open (local.get $arg0))
      (then
        (global.set $eax (call $gdi_dc_path_record_arc
          (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
          (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
          (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
          (call $gl32 (i32.add (global.get $esp) (i32.const 32)))
          (call $gl32 (i32.add (global.get $esp) (i32.const 36))) (i32.const 1)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 40)))
        (return)))
    (global.set $eax (call $gdi_arc
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 32)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 36))) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 40)))
  )

  ;; 575: SetTextCharacterExtra — per-DC spacing consumed by WAT text layout.
  (func $handle_SetTextCharacterExtra (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_aux_set
      (local.get $arg0) (i32.const 20) (local.get $arg1) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 576: SetTextJustification — distribute extra pixels across break characters.
  (func $handle_SetTextJustification (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (call $gdi_dc_aux_set
      (local.get $arg0) (i32.const 24) (local.get $arg1) (i32.const 0)))
    (drop (call $gdi_dc_aux_set
      (local.get $arg0) (i32.const 28) (local.get $arg2) (i32.const 0)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 577: OffsetClipRgn(hdc, dx, dy) — offset the WAT-owned explicit clip.
  (func $handle_OffsetClipRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_clip_offset
      (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 578: ExcludeClipRect(hdc, l, t, r, b) — 5 args stdcall.
  (func $handle_ExcludeClipRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_clip_exclude_rect
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 579: SelectClipRgn(hdc, hrgn) — 2 args stdcall
  (func $handle_SelectClipRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_clip_select (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 580: OffsetWindowOrgEx(hdc, dx, dy, lpPoint) → BOOL
  (func $handle_OffsetWindowOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $px i32) (local $py i32)
    (local.set $px (call $gdi_dc_get_field (local.get $arg0) (i32.const 40) (i32.const 0)))
    (local.set $py (call $gdi_dc_get_field (local.get $arg0) (i32.const 44) (i32.const 0)))
    (if (local.get $arg3) (then
      (call $gs32 (local.get $arg3) (local.get $px))
      (call $gs32 (i32.add (local.get $arg3) (i32.const 4)) (local.get $py))
    ))
    (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 40)
      (i32.add (local.get $px) (local.get $arg1)) (i32.const 0)))
    (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 44)
      (i32.add (local.get $py) (local.get $arg2)) (i32.const 0)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 581: SetPolyFillMode(hdc, mode) → previous mode.
  (func $handle_SetPolyFillMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.or (i32.eq (local.get $arg1) (i32.const 1))
          (i32.eq (local.get $arg1) (i32.const 2)))
      (then (global.set $eax (call $gdi_dc_set_field
        (local.get $arg0) (i32.const 76) (local.get $arg1) (i32.const 1))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; Finish recording, serialize the canonical surface and release the DC.
  (func $handle_CloseMetaFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_metafile_snapshot_wmf (local.get $arg0)))
    (if (call $gdi_metafile_recording_bitmap (local.get $arg0))
      (then (drop (call $gdi_dc_delete (local.get $arg0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_DeleteMetaFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (if (result i32)
        (i32.ne (call $gdi_metafile_record (local.get $arg0) (i32.const 6)) (i32.const 0))
        (then (call $gdi_object_delete_full (local.get $arg0)))
        (else (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; 585: IntersectClipRect(hdc, l, t, r, b) — 5 args stdcall.
  (func $handle_IntersectClipRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_clip_intersect_rect
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 586: GetWindowOrgEx(hdc, lpPoint) → BOOL
  (func $handle_GetWindowOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1) (then
      (call $gs32 (local.get $arg1)
        (call $gdi_dc_get_field (local.get $arg0) (i32.const 40) (i32.const 0)))
      (call $gs32 (i32.add (local.get $arg1) (i32.const 4))
        (call $gdi_dc_get_field (local.get $arg0) (i32.const 44) (i32.const 0)))
    ))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 587: SetWindowOrgEx(hdc, X, Y, lpPoint) → BOOL. Stores new logical origin; subsequent GDI
  ;; calls translate by (viewport_org - window_org). lpPoint receives the previous origin.
  (func $handle_SetWindowOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg3) (then
      (call $gs32 (local.get $arg3)
        (call $gdi_dc_get_field (local.get $arg0) (i32.const 40) (i32.const 0)))
      (call $gs32 (i32.add (local.get $arg3) (i32.const 4))
        (call $gdi_dc_get_field (local.get $arg0) (i32.const 44) (i32.const 0)))
    ))
    (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 40) (local.get $arg1) (i32.const 0)))
    (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 44) (local.get $arg2) (i32.const 0)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 588: GetCurrentPositionEx(hdc, lpPoint) -> BOOL
  (func $handle_GetCurrentPositionEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (local.get $arg1))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (call $gs32 (local.get $arg1)
      (call $gdi_dc_get_field (local.get $arg0) (i32.const 12) (i32.const 0)))
    (call $gs32 (i32.add (local.get $arg1) (i32.const 4))
      (call $gdi_dc_get_field (local.get $arg0) (i32.const 16) (i32.const 0)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 589: ScaleWindowExtEx(hdc, xNum, xDenom, yNum, yDenom, lpSize) → BOOL
  (func $handle_ScaleWindowExtEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $old_x i32) (local $old_y i32) (local $lp_size i32)
    (local $new_x i32) (local $new_y i32)
    (local.set $old_x (call $gdi_dc_get_field (local.get $arg0) (i32.const 48) (i32.const 1)))
    (local.set $old_y (call $gdi_dc_get_field (local.get $arg0) (i32.const 52) (i32.const 1)))
    (local.set $lp_size (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (if (local.get $lp_size)
      (then
        (call $gs32 (local.get $lp_size) (local.get $old_x))
        (call $gs32 (i32.add (local.get $lp_size) (i32.const 4)) (local.get $old_y))))
    ;; Each denominator is tested on its own: a raw `i32.and` of the two is a
    ;; bit mask, and would take (2, 4) for zero.
    (if (i32.and (i32.ne (local.get $arg2) (i32.const 0))
                 (i32.ne (local.get $arg4) (i32.const 0)))
      (then
        (local.set $new_x
          (i32.wrap_i64 (i64.div_s (i64.mul (i64.extend_i32_s (local.get $old_x))
            (i64.extend_i32_s (local.get $arg1))) (i64.extend_i32_s (local.get $arg2)))))
        (local.set $new_y
          (i32.wrap_i64 (i64.div_s (i64.mul (i64.extend_i32_s (local.get $old_y))
            (i64.extend_i32_s (local.get $arg3))) (i64.extend_i32_s (local.get $arg4)))))
        ;; A zero extent is not a legal DC state — SetWindowExtEx refuses one —
        ;; and this integer division is the only way to arrive at one by
        ;; accident: WordPad scales a 1x1 window extent by 96/300 when it builds
        ;; the CF_METAFILEPICT for Copy, which truncates to 0 and made every
        ;; later logical-to-device mapping divide by zero. Leave the extents
        ;; alone and fail, the way an out-of-range SetWindowExtEx does.
        (if (i32.and (i32.ne (local.get $new_x) (i32.const 0))
                     (i32.ne (local.get $new_y) (i32.const 0)))
          (then
            (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 48) (local.get $new_x) (i32.const 1)))
            (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 52) (local.get $new_y) (i32.const 1)))
            (global.set $eax (i32.const 1)))
          (else (global.set $eax (i32.const 0)))))
      (else
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 590: ScaleViewportExtEx(hdc, xNum, xDenom, yNum, yDenom, lpSize) → BOOL
  (func $handle_ScaleViewportExtEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $old_x i32) (local $old_y i32) (local $lp_size i32)
    (local $new_x i32) (local $new_y i32)
    (local.set $old_x (call $gdi_dc_get_field (local.get $arg0) (i32.const 64) (i32.const 1)))
    (local.set $old_y (call $gdi_dc_get_field (local.get $arg0) (i32.const 68) (i32.const 1)))
    (local.set $lp_size (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (if (local.get $lp_size)
      (then
        (call $gs32 (local.get $lp_size) (local.get $old_x))
        (call $gs32 (i32.add (local.get $lp_size) (i32.const 4)) (local.get $old_y))))
    ;; Same two rules as $handle_ScaleWindowExtEx: test each denominator on its
    ;; own, and refuse a scale that would truncate an extent to zero.
    (if (i32.and (i32.ne (local.get $arg2) (i32.const 0))
                 (i32.ne (local.get $arg4) (i32.const 0)))
      (then
        (local.set $new_x
          (i32.wrap_i64 (i64.div_s (i64.mul (i64.extend_i32_s (local.get $old_x))
            (i64.extend_i32_s (local.get $arg1))) (i64.extend_i32_s (local.get $arg2)))))
        (local.set $new_y
          (i32.wrap_i64 (i64.div_s (i64.mul (i64.extend_i32_s (local.get $old_y))
            (i64.extend_i32_s (local.get $arg3))) (i64.extend_i32_s (local.get $arg4)))))
        (if (i32.and (i32.ne (local.get $new_x) (i32.const 0))
                     (i32.ne (local.get $new_y) (i32.const 0)))
          (then
            (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 64) (local.get $new_x) (i32.const 1)))
            (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 68) (local.get $new_y) (i32.const 1)))
            (global.set $eax (i32.const 1)))
          (else (global.set $eax (i32.const 0)))))
      (else
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 591: OffsetViewportOrgEx(hdc, dx, dy, lpPoint) → BOOL
  (func $handle_OffsetViewportOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $px i32) (local $py i32)
    (local.set $px (call $gdi_dc_get_field (local.get $arg0) (i32.const 56) (i32.const 0)))
    (local.set $py (call $gdi_dc_get_field (local.get $arg0) (i32.const 60) (i32.const 0)))
    (if (local.get $arg3) (then
      (call $gs32 (local.get $arg3) (local.get $px))
      (call $gs32 (i32.add (local.get $arg3) (i32.const 4)) (local.get $py))
    ))
    (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 56)
      (i32.add (local.get $px) (local.get $arg1)) (i32.const 0)))
    (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 60)
      (i32.add (local.get $py) (local.get $arg2)) (i32.const 0)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 592: SetViewportOrgEx(hdc, x, y, lpPoint) → BOOL
  (func $handle_SetViewportOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg3) (then
      (call $gs32 (local.get $arg3)
        (call $gdi_dc_get_field (local.get $arg0) (i32.const 56) (i32.const 0)))
      (call $gs32 (i32.add (local.get $arg3) (i32.const 4))
        (call $gdi_dc_get_field (local.get $arg0) (i32.const 60) (i32.const 0)))
    ))
    (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 56) (local.get $arg1) (i32.const 0)))
    (drop (call $gdi_dc_set_field (local.get $arg0) (i32.const 60) (local.get $arg2) (i32.const 0)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 593: GetViewportExtEx(hdc, lpSize) → BOOL
  (func $handle_GetViewportExtEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1)
      (then
        (call $gs32 (local.get $arg1)
          (call $gdi_dc_get_field (local.get $arg0) (i32.const 64) (i32.const 1)))
        (call $gs32 (i32.add (local.get $arg1) (i32.const 4))
          (call $gdi_dc_get_field (local.get $arg0) (i32.const 68) (i32.const 1)))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 594: GetROP2(hdc) → current WAT-owned binary raster mode.
  (func $handle_GetROP2 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_get_rop2 (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 595: GetWindowExtEx(hdc, lpSize) → BOOL
  (func $handle_GetWindowExtEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1)
      (then
        (call $gs32 (local.get $arg1)
          (call $gdi_dc_get_field (local.get $arg0) (i32.const 48) (i32.const 1)))
        (call $gs32 (i32.add (local.get $arg1) (i32.const 4))
          (call $gdi_dc_get_field (local.get $arg0) (i32.const 52) (i32.const 1)))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; GetTextAlign(hdc) — return current alignment flags.
  (func $handle_GetTextAlign (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_get_text_align (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 597: GetPolyFillMode(hdc) → current polygon fill mode.
  (func $handle_GetPolyFillMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_get_field (local.get $arg0) (i32.const 76) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 598: GetBkMode(hdc) — current OPAQUE/TRANSPARENT setting
  (func $handle_GetBkMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_get_bk_mode (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 599: GetTextColor — STUB: unimplemented
  ;; GetTextColor(hdc) → COLORREF — 1 arg stdcall
  (func $handle_GetTextColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_get_text_color (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 600: GetStretchBltMode(hdc) — BLACKONWHITE default
  (func $handle_GetStretchBltMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_get_field (local.get $arg0) (i32.const 80) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 601: GetBkColor — STUB: unimplemented
  ;; GetBkColor(hdc) → COLORREF — 1 arg stdcall
  (func $handle_GetBkColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_get_bk_color (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 602: CreateFontW — convert the face name, then share the font-provider policy.
  (func $handle_CreateFontW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $face i32) (local $weight i32) (local $italic i32) (local $handle i32)
    ;; Fourteen arguments, so argument n is at esp+4n: fnWeight is the 5th,
    ;; fdwItalic the 6th, lpszFace the 14th. See $handle_CreateFontA.
    (local.set $weight (call $gl32 (i32.add (global.get $esp) (i32.const 20))))
    (local.set $italic (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (local.set $face (call $heap_alloc (i32.const 64)))
    (if (i32.eqz (local.get $face))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 60)))
        (return)))
    (drop (call $wide_to_ansi
      (call $gl32 (i32.add (global.get $esp) (i32.const 56)))
      (local.get $face) (i32.const 64)))
    (local.set $handle (call $gdi_font_create
      (local.get $arg0) (local.get $weight) (local.get $italic)
      (call $g2w (local.get $face))))
    (call $gdi_bitmap_font_bind (local.get $handle) (call $g2w (local.get $face)))
    (if (local.get $face) (then (call $heap_free (local.get $face))))
    (global.set $eax (local.get $handle))
    (global.set $esp (i32.add (global.get $esp) (i32.const 60)))
  )

  ;; 604: GetTextExtentPoint32W — font-aware wide text measurement
  (func $handle_GetTextExtentPoint32W (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $packed i32)
    (local.set $packed (call $host_get_text_metrics (local.get $arg0)))
    (call $gs32 (local.get $arg3)
      (i32.mul (local.get $arg2) (i32.shr_u (local.get $packed) (i32.const 16))))
    (call $gs32 (i32.add (local.get $arg3) (i32.const 4))
      (i32.and (local.get $packed) (i32.const 0xFFFF)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 605: GetClipBox(hdc, lpRect) → regionType — 2 args stdcall
  (func $handle_GetClipBox (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_clip_get_box
      (local.get $arg0) (call $g2w (local.get $arg1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  (func $handle_GetLayout (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) ;; stdcall 1 param + ret
  )

  ;; SetLayout(hdc, dwLayout) -> DWORD — return previous layout (0)
  (func $handle_SetLayout (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) ;; stdcall 2 params + ret
  )

  ;; 949: ExtTextOutA(hdc, x, y, options, lprect, lpString, c, lpDx) — 8 args stdcall
  ;; Selected FNT strikes consume lpDx in WAT; the generic host path ignores it.
  (func $handle_ExtTextOutA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $lpString i32) (local $count i32) (local $rect_wa i32) (local $text_wa i32)
    (local $lpDx i32) (local $dx_wa i32)
    (local.set $lpString (call $gl32 (i32.add (global.get $esp) (i32.const 24)))) ;; arg5
    (local.set $count (call $gl32 (i32.add (global.get $esp) (i32.const 28))))    ;; arg6
    (if (local.get $arg4)
      (then (local.set $rect_wa (call $g2w (local.get $arg4)))))
    (if (local.get $lpString)
      (then (local.set $text_wa (call $g2w (local.get $lpString)))))
    (local.set $lpDx (call $gl32 (i32.add (global.get $esp) (i32.const 32))))
    (if (local.get $lpDx)
      (then (local.set $dx_wa (call $g2w (local.get $lpDx)))))
    (global.set $eax (call $host_gdi_ext_text_out
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $rect_wa)
      (local.get $text_wa) (local.get $count) (local.get $dx_wa) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36))) ;; 8 args + ret
  )

  ;; 947: SetPixelV(hdc, x, y, color) — 4 args stdcall, like SetPixel but returns BOOL
  (func $handle_SetPixelV (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (call $host_gdi_set_pixel (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; CreateEllipticRgn(left, top, right, bottom) → HRGN
  (func $handle_CreateEllipticRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_rgn_alloc_ellipse
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; GetRgnBox(hrgn, lprc) → complexity. Writes bbox into lprc and returns
  ;; SIMPLEREGION/COMPLEXREGION/NULLREGION (1/2/3) like the real GDI.
  (func $handle_GetRgnBox (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $rect_wa i32)
    (local.set $rect_wa (if (result i32) (local.get $arg1)
      (then (call $g2w (local.get $arg1))) (else (i32.const 0))))
    (global.set $eax (call $gdi_rgn_get_box
      (local.get $arg0) (local.get $rect_wa)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; Additional GDI entry points used by the expanded application corpus.
  (func $handle_CreateDIBPatternBrush (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Global-memory handles are direct guest pointers in this Win32 model.
    (call $handle_CreateDIBPatternBrushPt
      (local.get $arg0) (local.get $arg1) (i32.const 0) (i32.const 0)
      (i32.const 0) (local.get $name_ptr)))

  (func $handle_CreateDiscardableBitmap (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_CreateCompatibleBitmap
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (i32.const 0)
      (i32.const 0) (local.get $name_ptr)))

  (func $handle_GetCharWidth32A (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_font_char_widths
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (if (result i32) (local.get $arg3)
        (then (call $g2w (local.get $arg3))) (else (i32.const 0)))
      (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  (func $handle_InvertRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_hdc_invert_rgn (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_PolyPolyline (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (call $gdi_dc_path_is_open (local.get $arg0))
      (then (global.set $eax (call $gdi_dc_path_record_poly_polyline
        (local.get $arg0)
        (if (result i32) (local.get $arg1)
          (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
        (if (result i32) (local.get $arg2)
          (then (call $g2w (local.get $arg2))) (else (i32.const 0)))
        (local.get $arg3))))
      (else (global.set $eax (call $gdi_poly_polyline_try
        (local.get $arg0)
        (if (result i32) (local.get $arg1)
          (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
        (if (result i32) (local.get $arg2)
          (then (call $g2w (local.get $arg2))) (else (i32.const 0)))
        (local.get $arg3)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))
