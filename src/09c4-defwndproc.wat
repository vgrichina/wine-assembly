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
    (local $is_p i32)        ;; pressed flag for current sysbutton
    (local $edge i32)        ;; EDGE_RAISED (0x05) or EDGE_SUNKEN (0x0A)
    (local $off i32)         ;; glyph offset (0 or 1) when pressed
    (local $pr_close i32) (local $pr_max i32) (local $pr_min i32)

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

    ;; Pressed-state per sysbutton (only when this hwnd matches nc_pressed_hwnd).
    (if (i32.eq (global.get $nc_pressed_hwnd) (local.get $hwnd))
      (then
        (local.set $pr_close (i32.eq (global.get $nc_pressed_hit) (i32.const 20)))
        (local.set $pr_max   (i32.eq (global.get $nc_pressed_hit) (i32.const 9)))
        (local.set $pr_min   (i32.eq (global.get $nc_pressed_hit) (i32.const 8)))))

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
            (select (i32.const 0x0A) (i32.const 0x05) (local.get $pr_close))
            (i32.const 0x0F)))
    ;; X glyph: two diagonal strokes inside the button.
    ;; The original used lineWidth=1.5 strokes; we approximate with
    ;; two 1px BLACK_PEN passes (offset by 1px) to get a 2px-thick X.
    ;; When pressed, shift the glyph 1px down/right for the classic Win98
    ;; sunken-button feel.
    (local.set $off (select (i32.const 1) (i32.const 0) (local.get $pr_close)))
    (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30017)))
    (local.set $cx (i32.add (i32.add (local.get $close_x) (i32.const 4)) (local.get $off)))
    (local.set $cy (i32.add (i32.add (local.get $btn_y) (i32.const 3)) (local.get $off)))
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
            (select (i32.const 0x0A) (i32.const 0x05) (local.get $pr_max))
            (i32.const 0x0F)))
    (local.set $off (select (i32.const 1) (i32.const 0) (local.get $pr_max)))
    ;; Glyph base shifted by $off for the pressed-button feel.
    (local.set $cx (i32.add (local.get $max_x) (local.get $off)))
    (local.set $cy (i32.add (local.get $btn_y) (local.get $off)))
    (if (local.get $is_maxed)
      (then
        ;; Restore glyph: two overlapping 7x7 boxes.
        ;; Back box (top-right)
        (drop (call $host_gdi_fill_rect (local.get $hdc)
                (i32.add (local.get $cx) (i32.const 5))
                (i32.add (local.get $cy) (i32.const 2))
                (i32.add (local.get $cx) (i32.const 12))
                (i32.add (local.get $cy) (i32.const 4))
                (i32.const 0x30014)))
        (drop (call $host_gdi_draw_edge (local.get $hdc)
                (i32.add (local.get $cx) (i32.const 5))
                (i32.add (local.get $cy) (i32.const 2))
                (i32.add (local.get $cx) (i32.const 12))
                (i32.add (local.get $cy) (i32.const 9))
                (i32.const 0x06) (i32.const 0x0F)))
        ;; Front box (bottom-left), white interior
        (drop (call $host_gdi_fill_rect (local.get $hdc)
                (i32.add (local.get $cx) (i32.const 3))
                (i32.add (local.get $cy) (i32.const 4))
                (i32.add (local.get $cx) (i32.const 10))
                (i32.add (local.get $cy) (i32.const 11))
                (i32.const 0x30010)))
        (drop (call $host_gdi_draw_edge (local.get $hdc)
                (i32.add (local.get $cx) (i32.const 3))
                (i32.add (local.get $cy) (i32.const 4))
                (i32.add (local.get $cx) (i32.const 10))
                (i32.add (local.get $cy) (i32.const 11))
                (i32.const 0x05) (i32.const 0x0F))))
      (else
        ;; Maximize glyph: 9x8 box with thick top stroke.
        (drop (call $host_gdi_fill_rect (local.get $hdc)
                (i32.add (local.get $cx) (i32.const 3))
                (i32.add (local.get $cy) (i32.const 3))
                (i32.add (local.get $cx) (i32.const 12))
                (i32.add (local.get $cy) (i32.const 5))
                (i32.const 0x30014)))
        (drop (call $host_gdi_draw_edge (local.get $hdc)
                (i32.add (local.get $cx) (i32.const 3))
                (i32.add (local.get $cy) (i32.const 3))
                (i32.add (local.get $cx) (i32.const 12))
                (i32.add (local.get $cy) (i32.const 11))
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
            (select (i32.const 0x0A) (i32.const 0x05) (local.get $pr_min))
            (i32.const 0x0F)))
    (local.set $off (select (i32.const 1) (i32.const 0) (local.get $pr_min)))
    (drop (call $host_gdi_fill_rect (local.get $hdc)
            (i32.add (i32.add (local.get $min_x) (i32.const 4)) (local.get $off))
            (i32.add (i32.add (local.get $btn_y) (i32.sub (local.get $btn_h) (i32.const 5))) (local.get $off))
            (i32.add (i32.add (local.get $min_x) (i32.const 11)) (local.get $off))
            (i32.add (i32.add (local.get $btn_y) (i32.sub (local.get $btn_h) (i32.const 3))) (local.get $off))
            (i32.const 0x30014)))

    (local.get $cap_h))

  ;; ============================================================
  ;; Default WM_NCPAINT handler — invoked by DefWindowProcA.
  ;; Fetches window width/height from JS via $host_get_window_rect,
  ;; pulls title from TITLE_TABLE, derives flags from style + auxiliary
  ;; tables, then calls $defwndproc_ncpaint. No JS-side plumbing.
  ;; ============================================================
  (func $defwndproc_do_ncpaint (param $hwnd i32)
    (local $rect i32) (local $w i32) (local $h i32)
    (local $style i32) (local $flags i32)
    (local $title_wa i32) (local $title_len i32)
    (if (i32.eqz (local.get $hwnd)) (then (return)))
    ;; Reuse PAINT_SCRATCH for the rect — it's 16 bytes and not in use
    ;; between the GetWindowRect/DrawText overlap here.
    (local.set $rect (global.get $PAINT_SCRATCH))
    (call $host_get_window_rect (local.get $hwnd) (local.get $rect))
    (local.set $w (i32.sub (i32.load offset=8  (local.get $rect))
                            (i32.load         (local.get $rect))))
    (local.set $h (i32.sub (i32.load offset=12 (local.get $rect))
                            (i32.load offset=4  (local.get $rect))))
    (if (i32.or (i32.le_s (local.get $w) (i32.const 0))
                (i32.le_s (local.get $h) (i32.const 0)))
      (then (return)))
    ;; Flags
    (local.set $style (call $wnd_get_style (local.get $hwnd)))
    (local.set $flags (i32.const 1))                                ;; active (TODO: focus-aware)
    (if (call $get_flash_state_slot (local.get $hwnd))
      (then (local.set $flags (i32.xor (local.get $flags) (i32.const 1)))))
    (if (i32.and (local.get $style) (i32.const 0x00C00000))         ;; WS_CAPTION
      (then (local.set $flags (i32.or (local.get $flags) (i32.const 8)))))
    ;; Dialog style (WS_DLGFRAME 0x00400000 without WS_THICKFRAME 0x00040000
    ;; and without WS_MINIMIZEBOX/MAXIMIZEBOX 0x00010000/0x00020000).
    (if (i32.and
          (i32.and (i32.and (local.get $style) (i32.const 0x00400000))
                   (i32.eqz (i32.and (local.get $style) (i32.const 0x00040000))))
          (i32.eqz (i32.and (local.get $style) (i32.const 0x00030000))))
      (then (local.set $flags (i32.or (local.get $flags) (i32.const 2)))))
    ;; Title
    (local.set $title_wa (call $title_table_get_ptr (local.get $hwnd)))
    (local.set $title_len (call $title_table_get_len (local.get $hwnd)))
    (drop (call $defwndproc_ncpaint
      (local.get $hwnd) (local.get $w) (local.get $h)
      (local.get $title_wa) (local.get $title_len)
      (local.get $flags) (i32.const 0))))

  ;; Default WM_NCCALCSIZE: compute the client rect (window-local) from
  ;; window rect minus standard borders / caption / menu bar.  Writes the
  ;; result to CLIENT_RECT for JS (and later WAT) consumers.
  (func $defwndproc_do_nccalcsize (param $hwnd i32)
    (local $rect i32) (local $w i32) (local $h i32)
    (local $style i32)
    (local $has_cap i32) (local $has_border i32)
    (local $bw i32) (local $cy i32) (local $bot i32)
    (if (i32.eqz (local.get $hwnd)) (then (return)))
    (local.set $rect (global.get $PAINT_SCRATCH))
    (call $host_get_window_rect (local.get $hwnd) (local.get $rect))
    (local.set $w (i32.sub (i32.load offset=8  (local.get $rect))
                            (i32.load         (local.get $rect))))
    (local.set $h (i32.sub (i32.load offset=12 (local.get $rect))
                            (i32.load offset=4  (local.get $rect))))
    (if (i32.or (i32.le_s (local.get $w) (i32.const 0))
                (i32.le_s (local.get $h) (i32.const 0)))
      (then (return)))
    (local.set $style (call $wnd_get_style (local.get $hwnd)))
    (local.set $has_cap   (i32.and (local.get $style) (i32.const 0x00C00000)))
    (local.set $has_border (i32.or (local.get $has_cap)
                                    (i32.and (local.get $style) (i32.const 0x00800000))))
    (local.set $bw (select (i32.const 3) (i32.const 0) (local.get $has_border)))
    (local.set $cy (local.get $bw))
    (if (local.get $has_cap) (then (local.set $cy (i32.add (local.get $cy) (i32.const 19)))))
    (if (i32.gt_s (call $menu_bar_count (local.get $hwnd)) (i32.const 0))
      (then (local.set $cy (i32.add (local.get $cy) (i32.const 18)))))
    (if (local.get $has_border) (then (local.set $cy (i32.add (local.get $cy) (i32.const 1)))))
    (local.set $bot (select (i32.const 4) (i32.const 0) (local.get $has_border)))
    ;; Store window-local l/t/r/b.
    (call $client_rect_set (local.get $hwnd)
      (local.get $bw) (local.get $cy)
      (i32.sub (local.get $w) (local.get $bw))
      (i32.sub (local.get $h) (local.get $bot))))

  ;; Default WM_NCHITTEST: classify (screen_x, screen_y) against window
  ;; chrome. Returns a HT* code. Button geometry matches
  ;; $defwndproc_ncpaint exactly — single source of truth.
  ;;
  ;; HT codes: HTNOWHERE=0 HTCLIENT=1 HTCAPTION=2 HTSYSMENU=3 HTBORDER=18
  ;;           HTCLOSE=20 HTMINBUTTON=8 HTMAXBUTTON=9
  (func $defwndproc_do_nchittest
        (param $hwnd i32) (param $sx i32) (param $sy i32) (result i32)
    (local $rect i32) (local $wx i32) (local $wy i32)
    (local $w i32) (local $h i32) (local $lx i32) (local $ly i32)
    (local $style i32) (local $has_cap i32) (local $is_dialog i32)
    (local $cap_top i32) (local $cap_bot i32) (local $cap_l i32) (local $cap_r i32)
    (local $btn_y i32) (local $btn_bot i32)
    (local $close_x i32) (local $max_x i32) (local $min_x i32)
    (local $bw i32) (local $bh i32)
    (if (i32.eqz (local.get $hwnd)) (then (return (i32.const 0))))
    (local.set $rect (global.get $PAINT_SCRATCH))
    (call $host_get_window_rect (local.get $hwnd) (local.get $rect))
    (local.set $wx (i32.load         (local.get $rect)))
    (local.set $wy (i32.load offset=4 (local.get $rect)))
    (local.set $w  (i32.sub (i32.load offset=8  (local.get $rect)) (local.get $wx)))
    (local.set $h  (i32.sub (i32.load offset=12 (local.get $rect)) (local.get $wy)))
    (local.set $lx (i32.sub (local.get $sx) (local.get $wx)))
    (local.set $ly (i32.sub (local.get $sy) (local.get $wy)))
    ;; Outside window
    (if (i32.or (i32.or (i32.lt_s (local.get $lx) (i32.const 0))
                         (i32.lt_s (local.get $ly) (i32.const 0)))
                 (i32.or (i32.ge_s (local.get $lx) (local.get $w))
                         (i32.ge_s (local.get $ly) (local.get $h))))
      (then (return (i32.const 0))))
    (local.set $style (call $wnd_get_style (local.get $hwnd)))
    (local.set $has_cap (i32.and (local.get $style) (i32.const 0x00C00000)))
    ;; Title bar region: (3, 3)-(w-3, 3+18); button strip (3+2)..(3+16) high.
    (if (local.get $has_cap)
      (then
        (local.set $cap_l (i32.const 3))
        (local.set $cap_r (i32.sub (local.get $w) (i32.const 3)))
        (local.set $cap_top (i32.const 3))
        (local.set $cap_bot (i32.add (local.get $cap_top) (i32.const 18)))
        (if (i32.and (i32.and (i32.ge_s (local.get $lx) (local.get $cap_l))
                                (i32.lt_s (local.get $lx) (local.get $cap_r)))
                       (i32.and (i32.ge_s (local.get $ly) (local.get $cap_top))
                                (i32.lt_s (local.get $ly) (local.get $cap_bot))))
          (then
            (local.set $bw (i32.const 16))
            (local.set $bh (i32.const 14))
            (local.set $btn_y (i32.add (local.get $cap_top) (i32.const 2)))
            (local.set $btn_bot (i32.add (local.get $btn_y) (local.get $bh)))
            (local.set $close_x (i32.sub (local.get $cap_r)
                                   (i32.add (local.get $bw) (i32.const 2))))
            (local.set $max_x   (i32.sub (local.get $cap_r)
                                   (i32.add (i32.mul (local.get $bw) (i32.const 2)) (i32.const 4))))
            (local.set $min_x   (i32.sub (local.get $cap_r)
                                   (i32.add (i32.mul (local.get $bw) (i32.const 3)) (i32.const 4))))
            ;; Dialog style: close only (matches $defwndproc_ncpaint dialog branch).
            (local.set $is_dialog (i32.and
              (i32.and
                (i32.and (local.get $style) (i32.const 0x00400000))
                (i32.eqz (i32.and (local.get $style) (i32.const 0x00040000))))
              (i32.eqz (i32.and (local.get $style) (i32.const 0x00030000)))))
            (if (i32.and (i32.and (i32.ge_s (local.get $ly) (local.get $btn_y))
                                  (i32.lt_s (local.get $ly) (local.get $btn_bot)))
                          (i32.and (i32.ge_s (local.get $lx) (local.get $close_x))
                                   (i32.lt_s (local.get $lx) (i32.add (local.get $close_x) (local.get $bw)))))
              (then (return (i32.const 20)))) ;; HTCLOSE
            (if (i32.eqz (local.get $is_dialog))
              (then
                (if (i32.and (i32.and (i32.ge_s (local.get $ly) (local.get $btn_y))
                                      (i32.lt_s (local.get $ly) (local.get $btn_bot)))
                              (i32.and (i32.ge_s (local.get $lx) (local.get $max_x))
                                       (i32.lt_s (local.get $lx) (i32.add (local.get $max_x) (local.get $bw)))))
                  (then (return (i32.const 9)))) ;; HTMAXBUTTON
                (if (i32.and (i32.and (i32.ge_s (local.get $ly) (local.get $btn_y))
                                      (i32.lt_s (local.get $ly) (local.get $btn_bot)))
                              (i32.and (i32.ge_s (local.get $lx) (local.get $min_x))
                                       (i32.lt_s (local.get $lx) (i32.add (local.get $min_x) (local.get $bw)))))
                  (then (return (i32.const 8)))))) ;; HTMINBUTTON
            (return (i32.const 2)))))) ;; HTCAPTION
    ;; 3px border
    (if (i32.or (i32.or (i32.lt_s (local.get $lx) (i32.const 3))
                        (i32.lt_s (local.get $ly) (i32.const 3)))
                (i32.or (i32.ge_s (local.get $lx) (i32.sub (local.get $w) (i32.const 3)))
                        (i32.ge_s (local.get $ly) (i32.sub (local.get $h) (i32.const 3)))))
      (then (return (i32.const 18)))) ;; HTBORDER
    (i32.const 1))                    ;; HTCLIENT

  ;; Default WM_SETCURSOR handler.
  ;;
  ;; HTCLIENT (1): leave the cursor alone. Real Win32 would apply
  ;; WNDCLASS.hCursor here — class-cursor lookup is deferred. Leaving it
  ;; alone is better than forcing arrow: apps that call SetCursor(IDC_X)
  ;; from WM_MOUSEMOVE (e.g. Reversi's cross over valid moves) would
  ;; otherwise flicker back to arrow on every subsequent tick because
  ;; WM_SETCURSOR is dispatched ahead of the next WM_MOUSEMOVE.
  ;;
  ;; Chrome hits (HTCAPTION/HTBORDER/HTSYSMENU/HTCLOSE/HTMIN/HTMAX):
  ;; apply IDC_ARROW.
  (func $defwndproc_do_setcursor (param $hwnd i32) (param $hit i32) (result i32)
    (if (i32.eq (local.get $hit) (i32.const 1))
      (then (return (i32.const 1)))) ;; HTCLIENT — leave cursor alone
    (drop (call $set_cursor_internal (i32.const 0x67F00))) ;; IDC_ARROW
    (i32.const 1))

  ;; Tiny wrapper so $defwndproc_do_ncpaint can peek FLASH_TABLE without
  ;; reaching into the table address directly (keeps the layout private
  ;; to help.wat and avoids leaking the offset into two files).
  (func $get_flash_state_slot (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return (i32.const 0))))
    (i32.load8_u (i32.add (global.get $FLASH_TABLE) (local.get $idx))))

  ;; ---- Sysbutton press state (used by JS while user holds LMB on a
  ;; title-bar button). Setting to (hwnd, hit) makes the next ncpaint
  ;; render that button with EDGE_SUNKEN + 1px glyph offset. nc_clear
  ;; restores the raised look. JS calls these from handleMouseDown /
  ;; handleMouseMove / handleMouseUp around the press-and-release window.
  (func $nc_set_pressed (export "nc_set_pressed") (param $hwnd i32) (param $hit i32)
    (global.set $nc_pressed_hwnd (local.get $hwnd))
    (global.set $nc_pressed_hit  (local.get $hit)))
  (func $nc_clear_pressed (export "nc_clear_pressed")
    (global.set $nc_pressed_hwnd (i32.const 0))
    (global.set $nc_pressed_hit  (i32.const 0)))
  ;; Synchronous chrome repaint — JS invokes this right after toggling the
  ;; sysbutton press state so the back-canvas updates *now* instead of
  ;; waiting for the next message-pump tick to drain a posted WM_NCPAINT.
  (func (export "nc_repaint_now") (param $hwnd i32)
    (call $defwndproc_do_ncpaint (local.get $hwnd)))
