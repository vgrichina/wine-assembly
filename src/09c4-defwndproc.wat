  ;; ============================================================
  ;; DefWindowProc — top-level window non-client paint
  ;; ============================================================
  ;; Real Win32 calls DefWindowProc(WM_NCPAINT) from inside the
  ;; application wndproc to draw the standard window chrome (3D
  ;; outset frame, caption gradient + text, sysmenu buttons).
  ;;
  ;; Our equivalent: $defwndproc_ncpaint, exported as a callable
  ;; entry point. The renderer sets _activeChildDraw to (canvas,
  ;; screen-x, screen-y) of the window and calls this; the gdi_*
  ;; host primitives composite onto the screen at window-relative
  ;; coordinates. Same plumbing as the WAT-native control wndprocs
  ;; (button/edit/static/listbox/colorgrid) — see 09c3-controls.wat.
  ;;
  ;; Args:
  ;;   $hwnd      — top-level hwnd (used to encode hdc = hwnd+0x40000)
  ;;   $w, $h     — window width / height
  ;;   $title_wa  — WASM addr of title text bytes (0 = no title)
  ;;   $title_len — title length in bytes (0 ok)
  ;;   $flags     — bit0 active, bit1 dialog_style (no min/max),
  ;;                bit2 maximized, bit3 has_caption
  ;; Returns: caption_height (18 if has_caption, else 0)
  ;;
  ;; Layout (window-relative, origin at top-left of window):
  ;;   outset 3D border at (0,0,w,h)
  ;;   frame fill: btnFace strips on top/left/right/bottom (3px borders
  ;;     + caption strip)
  ;;   if has_caption:
  ;;     title bar at (3, 3, w-3, 21), gradient + text + sysbuttons
  ;;
  ;; Stock objects used:
  ;;   0x30010 WHITE_BRUSH    0x30011 LTGRAY_BRUSH (= btnFace)
  ;;   0x30014 BLACK_BRUSH    0x30017 BLACK_PEN
  ;;   0x30022 caption font (added — 11px MS Sans Serif Bold)

  (func $defwndproc_ncpaint (export "defwndproc_ncpaint")
        (param $hwnd i32) (param $w i32) (param $h i32)
        (param $title_wa i32) (param $title_len i32) (param $flags i32)
        (param $client_top i32)
        (result i32)
    (local $hdc i32)
    (local $has_caption i32)
    (local $is_active i32)
    (local $is_dialog i32)
    (local $is_maxed i32)
    (local $cap_h i32)
    (local $cap_top i32)   ;; y of title bar (window-relative)
    (local $cap_bot i32)
    (local $cap_l i32)     ;; x of title bar
    (local $cap_r i32)
    (local $btn_y i32)     ;; sysbutton top
    (local $btn_h i32)
    (local $btn_w i32)
    (local $close_x i32)
    (local $max_x i32)
    (local $min_x i32)
    (local $cx i32) (local $cy i32) (local $cs i32)

    ;; Use whole-window DC (0xC0000 offset) so _getDrawTarget returns
    ;; ox=0,oy=0 — ncpaint draws at window-local coords without needing
    ;; _activeChildDraw override from JS.
    (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0xC0000)))
    (local.set $has_caption (i32.and (local.get $flags) (i32.const 0x08)))
    (local.set $is_active   (i32.and (local.get $flags) (i32.const 0x01)))
    (local.set $is_dialog   (i32.and (local.get $flags) (i32.const 0x02)))
    (local.set $is_maxed    (i32.and (local.get $flags) (i32.const 0x04)))
    (local.set $cap_h (select (i32.const 18) (i32.const 0) (local.get $has_caption)))

    ;; -------------------------------------------------
    ;; Fill entire window rect with btnFace. The 3D edge,
    ;; caption gradient, and client-area WM_PAINT all draw
    ;; on top. One fill eliminates all gap rows between
    ;; caption/menu/client/border.
    ;; -------------------------------------------------
    (drop (call $host_gdi_fill_rect (local.get $hdc)
            (i32.const 0) (i32.const 0)
            (local.get $w) (local.get $h)
            (i32.const 0x30011)))

    ;; -------------------------------------------------
    ;; Outset 3D border around the whole window.
    ;; EDGE_RAISED = BDR_RAISEDOUTER(1) | BDR_RAISEDINNER(4) = 5
    ;; BF_RECT (all four sides) = 0x0F
    ;; -------------------------------------------------
    (drop (call $host_gdi_draw_edge (local.get $hdc)
            (i32.const 0) (i32.const 0)
            (local.get $w) (local.get $h)
            (i32.const 0x05) (i32.const 0x0F)))

    ;; If no caption, we're done.
    (if (i32.eqz (local.get $has_caption))
      (then (return (i32.const 0))))

    ;; -------------------------------------------------
    ;; Title bar gradient at (3, 3, w-3, 21).
    ;; Active:   0x000080 → 0x1084D0 (Win98 default caption gradient)
    ;; Inactive: 0x808080 → 0xC0C0C0
    ;; Colors are passed as 0xBBGGRR (Win32 COLORREF order); the
    ;; host primitive interprets the same way as gdi_fill_rect.
    ;; -------------------------------------------------
    (local.set $cap_l (i32.const 3))
    (local.set $cap_r (i32.sub (local.get $w) (i32.const 3)))
    (local.set $cap_top (i32.const 3))
    (local.set $cap_bot (i32.add (local.get $cap_top) (local.get $cap_h)))
    (if (local.get $is_active)
      (then
        (drop (call $host_gdi_gradient_fill_h (local.get $hdc)
                (local.get $cap_l) (local.get $cap_top)
                (local.get $cap_r) (local.get $cap_bot)
                (i32.const 0x800000)    ;; 0x000080 in BGR
                (i32.const 0xD08410)))) ;; 0x1084D0 in BGR
      (else
        (drop (call $host_gdi_gradient_fill_h (local.get $hdc)
                (local.get $cap_l) (local.get $cap_top)
                (local.get $cap_r) (local.get $cap_bot)
                (i32.const 0x808080)
                (i32.const 0xC0C0C0)))))

    ;; -------------------------------------------------
    ;; Title text. White, MS Sans Serif Bold, left-aligned with 4px
    ;; pad, vertically centred. Use TRANSPARENT bk so the gradient
    ;; shows through letter gaps.
    ;; -------------------------------------------------
    (if (local.get $title_len)
      (then
        (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30022)))
        (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))
        (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0xFFFFFF)))
        ;; PAINT_SCRATCH RECT: l, t, r, b
        (i32.store           (global.get $PAINT_SCRATCH) (i32.add (local.get $cap_l) (i32.const 4)))
        (i32.store offset=4  (global.get $PAINT_SCRATCH) (local.get $cap_top))
        (i32.store offset=8  (global.get $PAINT_SCRATCH) (local.get $cap_r))
        (i32.store offset=12 (global.get $PAINT_SCRATCH) (local.get $cap_bot))
        ;; DT_LEFT(0) | DT_VCENTER(4) | DT_SINGLELINE(0x20) | DT_NOPREFIX(0x800) = 0x824
        (drop (call $host_gdi_draw_text (local.get $hdc)
                (local.get $title_wa) (local.get $title_len)
                (global.get $PAINT_SCRATCH)
                (i32.const 0x824) (i32.const 0)))))

    ;; -------------------------------------------------
    ;; System buttons (close / max / min). Each is 16x14, top y =
    ;; cap_top + 2. Layout matches the original drawTitleBar.
    ;; -------------------------------------------------
    (local.set $btn_w (i32.const 16))
    (local.set $btn_h (i32.const 14))
    (local.set $btn_y (i32.add (local.get $cap_top) (i32.const 2)))
    (local.set $close_x (i32.sub (local.get $cap_r) (i32.add (local.get $btn_w) (i32.const 2))))
    (local.set $max_x   (i32.sub (local.get $cap_r) (i32.add (i32.mul (local.get $btn_w) (i32.const 2)) (i32.const 4))))
    (local.set $min_x   (i32.sub (local.get $cap_r) (i32.add (i32.mul (local.get $btn_w) (i32.const 3)) (i32.const 4))))

    ;; --- Close button frame ---
    (drop (call $host_gdi_fill_rect (local.get $hdc)
            (local.get $close_x) (local.get $btn_y)
            (i32.add (local.get $close_x) (local.get $btn_w))
            (i32.add (local.get $btn_y) (local.get $btn_h))
            (i32.const 0x30011)))
    (drop (call $host_gdi_draw_edge (local.get $hdc)
            (local.get $close_x) (local.get $btn_y)
            (i32.add (local.get $close_x) (local.get $btn_w))
            (i32.add (local.get $btn_y) (local.get $btn_h))
            (i32.const 0x05) (i32.const 0x0F)))
    ;; X glyph: two diagonal strokes inside the button.
    ;; The original used lineWidth=1.5 strokes; we approximate with
    ;; two 1px BLACK_PEN passes (offset by 1px) to get a 2px-thick X.
    (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30017)))
    (local.set $cx (i32.add (local.get $close_x) (i32.const 4)))
    (local.set $cy (i32.add (local.get $btn_y) (i32.const 3)))
    (local.set $cs (i32.const 7))
    (drop (call $host_gdi_move_to (local.get $hdc) (local.get $cx) (local.get $cy)))
    (drop (call $host_gdi_line_to (local.get $hdc)
            (i32.add (local.get $cx) (local.get $cs))
            (i32.add (local.get $cy) (local.get $cs))))
    (drop (call $host_gdi_move_to (local.get $hdc)
            (i32.add (local.get $cx) (local.get $cs)) (local.get $cy)))
    (drop (call $host_gdi_line_to (local.get $hdc)
            (local.get $cx) (i32.add (local.get $cy) (local.get $cs))))
    ;; Second pass for thickness (offset 1px)
    (drop (call $host_gdi_move_to (local.get $hdc)
            (i32.add (local.get $cx) (i32.const 1)) (local.get $cy)))
    (drop (call $host_gdi_line_to (local.get $hdc)
            (i32.add (local.get $cx) (i32.add (local.get $cs) (i32.const 1)))
            (i32.add (local.get $cy) (local.get $cs))))
    (drop (call $host_gdi_move_to (local.get $hdc)
            (i32.add (local.get $cx) (i32.add (local.get $cs) (i32.const 1))) (local.get $cy)))
    (drop (call $host_gdi_line_to (local.get $hdc)
            (i32.add (local.get $cx) (i32.const 1)) (i32.add (local.get $cy) (local.get $cs))))

    ;; Dialog style: only the close button.
    (if (local.get $is_dialog)
      (then (return (local.get $cap_h))))

    ;; --- Max / Restore button ---
    (drop (call $host_gdi_fill_rect (local.get $hdc)
            (local.get $max_x) (local.get $btn_y)
            (i32.add (local.get $max_x) (local.get $btn_w))
            (i32.add (local.get $btn_y) (local.get $btn_h))
            (i32.const 0x30011)))
    (drop (call $host_gdi_draw_edge (local.get $hdc)
            (local.get $max_x) (local.get $btn_y)
            (i32.add (local.get $max_x) (local.get $btn_w))
            (i32.add (local.get $btn_y) (local.get $btn_h))
            (i32.const 0x05) (i32.const 0x0F)))
    (if (local.get $is_maxed)
      (then
        ;; Restore glyph: two overlapping 7x7 boxes.
        ;; Back box (top-right)
        (drop (call $host_gdi_fill_rect (local.get $hdc)
                (i32.add (local.get $max_x) (i32.const 5))
                (i32.add (local.get $btn_y) (i32.const 2))
                (i32.add (local.get $max_x) (i32.const 12))
                (i32.add (local.get $btn_y) (i32.const 4))
                (i32.const 0x30014)))
        (drop (call $host_gdi_draw_edge (local.get $hdc)
                (i32.add (local.get $max_x) (i32.const 5))
                (i32.add (local.get $btn_y) (i32.const 2))
                (i32.add (local.get $max_x) (i32.const 12))
                (i32.add (local.get $btn_y) (i32.const 9))
                (i32.const 0x06) (i32.const 0x0F)))
        ;; Front box (bottom-left), white interior
        (drop (call $host_gdi_fill_rect (local.get $hdc)
                (i32.add (local.get $max_x) (i32.const 3))
                (i32.add (local.get $btn_y) (i32.const 4))
                (i32.add (local.get $max_x) (i32.const 10))
                (i32.add (local.get $btn_y) (i32.const 11))
                (i32.const 0x30010)))
        (drop (call $host_gdi_draw_edge (local.get $hdc)
                (i32.add (local.get $max_x) (i32.const 3))
                (i32.add (local.get $btn_y) (i32.const 4))
                (i32.add (local.get $max_x) (i32.const 10))
                (i32.add (local.get $btn_y) (i32.const 11))
                (i32.const 0x05) (i32.const 0x0F))))
      (else
        ;; Maximize glyph: 9x8 box with thick top stroke.
        (drop (call $host_gdi_fill_rect (local.get $hdc)
                (i32.add (local.get $max_x) (i32.const 3))
                (i32.add (local.get $btn_y) (i32.const 3))
                (i32.add (local.get $max_x) (i32.const 12))
                (i32.add (local.get $btn_y) (i32.const 5))
                (i32.const 0x30014)))
        (drop (call $host_gdi_draw_edge (local.get $hdc)
                (i32.add (local.get $max_x) (i32.const 3))
                (i32.add (local.get $btn_y) (i32.const 3))
                (i32.add (local.get $max_x) (i32.const 12))
                (i32.add (local.get $btn_y) (i32.const 11))
                (i32.const 0x05) (i32.const 0x0F)))))

    ;; --- Min button: 7x2 horizontal bar near the bottom ---
    (drop (call $host_gdi_fill_rect (local.get $hdc)
            (local.get $min_x) (local.get $btn_y)
            (i32.add (local.get $min_x) (local.get $btn_w))
            (i32.add (local.get $btn_y) (local.get $btn_h))
            (i32.const 0x30011)))
    (drop (call $host_gdi_draw_edge (local.get $hdc)
            (local.get $min_x) (local.get $btn_y)
            (i32.add (local.get $min_x) (local.get $btn_w))
            (i32.add (local.get $btn_y) (local.get $btn_h))
            (i32.const 0x05) (i32.const 0x0F)))
    (drop (call $host_gdi_fill_rect (local.get $hdc)
            (i32.add (local.get $min_x) (i32.const 4))
            (i32.add (local.get $btn_y) (i32.sub (local.get $btn_h) (i32.const 5)))
            (i32.add (local.get $min_x) (i32.const 11))
            (i32.add (local.get $btn_y) (i32.sub (local.get $btn_h) (i32.const 3)))
            (i32.const 0x30014)))

    (local.get $cap_h))
