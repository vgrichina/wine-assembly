  ;; ============================================================
  ;; Menu painting + hit-testing (WAT-side, was JS drawMenuBar /
  ;; _drawDropdown / _drawAccelText / renderer-input menu hit code)
  ;; ============================================================
  ;; Menu data is heap-resident, owned by WAT, and indexed per window
  ;; via MENU_DATA_TABLE (parallel to WND_RECORDS slots). JS encodes a
  ;; flat blob from its parsed PE menu tree once when the menu is set,
  ;; passes it through $menu_set; we copy into the heap and remember
  ;; the pointer. Paint and hit-test then re-walk the blob on demand,
  ;; matching the way real USER32 walks an HMENU instead of caching
  ;; rectangles.
  ;;
  ;; Blob layout (see also MENU_DATA_TABLE comment in 01-header.wat):
  ;;   +0       i32  bar_count
  ;;   +4       bar_items[bar_count] × 12:
  ;;              +0  i32 text_offset  (offset in blob)
  ;;              +4  i32 text_len
  ;;              +8  i32 child_offset (offset to child header, 0 = none)
  ;;   <child header> per submenu:
  ;;     +0  i32 child_count
  ;;     +4  child_items[child_count] × 24:
  ;;              +0  i32 label_offset
  ;;              +4  i32 label_len
  ;;              +8  i32 shortcut_offset
  ;;              +12 i32 shortcut_len
  ;;              +16 i32 flags  (bit0 = separator, bit1 = grayed)
  ;;              +20 i32 id
  ;;   string bytes appended at the tail (referenced by *_offset above)
  ;;
  ;; Geometry constants — must match the old JS code so the layout is
  ;; pixel-identical:
  ;;   bar item height       = 18
  ;;   bar item left pad     = 4 (first item starts at x+4)
  ;;   bar item text inset   = 6 (text drawn at item.x+6)
  ;;   bar item width        = measureText(label) + 12
  ;;   dropdown width        = 180
  ;;   dropdown item height  = 20
  ;;   dropdown left/right pad = 2
  ;;   dropdown label inset  = 20 (from dropdown left)
  ;;   dropdown shortcut inset = 20 (from dropdown right)

  ;; --------- MENU_DATA_TABLE accessors ---------

  (func $menu_data_table_addr (param $slot i32) (result i32)
    (i32.add (global.get $MENU_DATA_TABLE) (i32.mul (local.get $slot) (i32.const 4))))

  ;; Returns the WASM linear address of this hwnd's menu blob, or 0.
  (func $menu_blob_w (param $hwnd i32) (result i32)
    (local $slot i32) (local $g i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $slot) (i32.const -1)) (then (return (i32.const 0))))
    (local.set $g (i32.load (call $menu_data_table_addr (local.get $slot))))
    (if (i32.eqz (local.get $g)) (then (return (i32.const 0))))
    (call $g2w (local.get $g)))

  ;; Install (or replace) a menu blob for a window. Allocates heap
  ;; memory, memcpys the source bytes, stores the guest pointer in
  ;; MENU_DATA_TABLE[slot]. Frees any prior blob first.
  ;; Args: hwnd, src_wa (WASM addr), len (bytes).
  (func (export "menu_set")
        (param $hwnd i32) (param $src_wa i32) (param $len i32)
    (local $slot i32) (local $tbl i32) (local $old i32) (local $newg i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $slot) (i32.const -1)) (then (return)))
    (local.set $tbl (call $menu_data_table_addr (local.get $slot)))
    (local.set $old (i32.load (local.get $tbl)))
    (if (local.get $old) (then (call $heap_free (local.get $old))))
    (i32.store (local.get $tbl) (i32.const 0))
    (if (i32.eqz (local.get $len)) (then (return)))
    (local.set $newg (call $heap_alloc (local.get $len)))
    (call $memcpy (call $g2w (local.get $newg)) (local.get $src_wa) (local.get $len))
    (i32.store (local.get $tbl) (local.get $newg)))

  ;; Drop a window's menu (called from $host_destroy_window path).
  (func (export "menu_clear") (param $hwnd i32)
    (local $slot i32) (local $tbl i32) (local $old i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $slot) (i32.const -1)) (then (return)))
    (local.set $tbl (call $menu_data_table_addr (local.get $slot)))
    (local.set $old (i32.load (local.get $tbl)))
    (if (local.get $old) (then (call $heap_free (local.get $old))))
    (i32.store (local.get $tbl) (i32.const 0)))

  ;; Top-level item count (0 if no menu). Helper for keyboard nav.
  (func $menu_bar_count (export "menu_bar_count") (param $hwnd i32) (result i32)
    (local $b i32)
    (local.set $b (call $menu_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $b)) (then (return (i32.const 0))))
    (i32.load (local.get $b)))

  ;; ----- text-width measurement -----
  ;; gdi_draw_text with DT_CALCRECT(0x400)|DT_SINGLELINE(0x20)|DT_NOPREFIX(0x800)
  ;; = 0xC20 returns the natural width via the rect's right field.
  (func $measure_text (param $hdc i32) (param $text_wa i32) (param $len i32)
                       (result i32)
    (i32.store           (global.get $PAINT_SCRATCH) (i32.const 0))
    (i32.store offset=4  (global.get $PAINT_SCRATCH) (i32.const 0))
    (i32.store offset=8  (global.get $PAINT_SCRATCH) (i32.const 0))
    (i32.store offset=12 (global.get $PAINT_SCRATCH) (i32.const 0))
    (drop (call $host_gdi_draw_text (local.get $hdc)
            (local.get $text_wa) (local.get $len)
            (global.get $PAINT_SCRATCH)
            (i32.const 0xC20) (i32.const 0)))
    (i32.load offset=8 (global.get $PAINT_SCRATCH)))

  ;; ----- bar item geometry walker -----
  ;; Compute the width of bar item $idx (0-based). hdc must be set up
  ;; with the menu font already selected. Returns text-width + 12.
  (func $bar_item_width (param $blob_w i32) (param $hdc i32) (param $idx i32)
                          (result i32)
    (local $base i32) (local $text_w i32)
    (local.set $base (i32.add (local.get $blob_w)
                       (i32.add (i32.const 4) (i32.mul (local.get $idx) (i32.const 12)))))
    (local.set $text_w
      (call $measure_text (local.get $hdc)
        (i32.add (local.get $blob_w) (i32.load (local.get $base)))
        (i32.load offset=4 (local.get $base))))
    (i32.add (local.get $text_w) (i32.const 12)))

  ;; Compute the LEFT edge x-offset (relative to bar start) of bar item
  ;; $target. Walks items 0..target-1, summing widths.
  (func $bar_item_x (param $blob_w i32) (param $hdc i32) (param $target i32)
                      (result i32)
    (local $i i32) (local $x i32)
    (local.set $x (i32.const 4))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $target)))
      (local.set $x (i32.add (local.get $x)
                       (call $bar_item_width (local.get $blob_w) (local.get $hdc) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $x))

  ;; ============================================================
  ;; $menu_paint_bar — draw the menu bar at (x, y, w, 18). Mirrors
  ;; the old JS drawMenuBar layout exactly (item.x = running cursor,
  ;; item.w = textWidth + 12, label drawn at item.x + 6, highlight
  ;; covers full item rect when open). Called via _activeChildDraw
  ;; routing so gdi_* primitives composite at the screen position
  ;; the renderer chose.
  ;; ============================================================
  (func (export "menu_paint_bar")
        (param $hwnd i32) (param $x i32) (param $y i32) (param $w i32)
        (param $open_idx i32)
        (result i32)  ;; bar height drawn (0 if no menu)
    (local $blob i32) (local $count i32) (local $i i32)
    (local $hdc i32) (local $cur_x i32) (local $iw i32)
    (local $base i32) (local $text_wa i32) (local $text_len i32)

    (local.set $blob (call $menu_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $count (i32.load (local.get $blob)))
    (if (i32.eqz (local.get $count)) (then (return (i32.const 0))))

    (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
    ;; Background fill (menuBg = LTGRAY = 0xC0C0C0 = LTGRAY_BRUSH 0x30011).
    (drop (call $host_gdi_fill_rect (local.get $hdc)
            (local.get $x) (local.get $y)
            (i32.add (local.get $x) (local.get $w))
            (i32.add (local.get $y) (i32.const 18))
            (i32.const 0x30011)))
    ;; Font + transparent bk (so highlight or face shows through).
    (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))
    (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))

    (local.set $cur_x (i32.add (local.get $x) (i32.const 4)))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $base (i32.add (local.get $blob)
                         (i32.add (i32.const 4) (i32.mul (local.get $i) (i32.const 12)))))
      (local.set $text_wa (i32.add (local.get $blob) (i32.load (local.get $base))))
      (local.set $text_len (i32.load offset=4 (local.get $base)))
      (local.set $iw (i32.add (call $measure_text (local.get $hdc)
                                 (local.get $text_wa) (local.get $text_len))
                              (i32.const 12)))
      ;; Highlight rectangle if this is the open menu.
      (if (i32.eq (local.get $i) (local.get $open_idx))
        (then
          (drop (call $host_gdi_fill_rect (local.get $hdc)
                  (local.get $cur_x) (local.get $y)
                  (i32.add (local.get $cur_x) (local.get $iw))
                  (i32.add (local.get $y) (i32.const 18))
                  (i32.const 14))) ;; COLOR_HIGHLIGHT brush (navy)
          (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0xFFFFFF))))
        (else
          (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x000000)))))
      ;; Draw label (gdi_draw_text handles & accelerator underline now).
      (i32.store           (global.get $PAINT_SCRATCH)
                           (i32.add (local.get $cur_x) (i32.const 6)))
      (i32.store offset=4  (global.get $PAINT_SCRATCH) (local.get $y))
      (i32.store offset=8  (global.get $PAINT_SCRATCH) (i32.const 0x7FFF))
      (i32.store offset=12 (global.get $PAINT_SCRATCH)
                           (i32.add (local.get $y) (i32.const 18)))
      ;; DT_LEFT(0)|DT_VCENTER(4)|DT_SINGLELINE(0x20) = 0x24
      (drop (call $host_gdi_draw_text (local.get $hdc)
              (local.get $text_wa) (local.get $text_len)
              (global.get $PAINT_SCRATCH)
              (i32.const 0x24) (i32.const 0)))
      (local.set $cur_x (i32.add (local.get $cur_x) (local.get $iw)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    ;; Bottom 1px shadow line (btnShadow 0x808080).
    (drop (call $host_gdi_fill_rect (local.get $hdc)
            (local.get $x) (i32.add (local.get $y) (i32.const 17))
            (i32.add (local.get $x) (local.get $w))
            (i32.add (local.get $y) (i32.const 18))
            (i32.const 0x30012))) ;; GRAY_BRUSH
    (i32.const 18))

  ;; ============================================================
  ;; $menu_hittest_bar — given a screen-relative click point and the
  ;; bar's left/top, return the index of the hit bar item, or -1.
  ;; ============================================================
  (func (export "menu_hittest_bar")
        (param $hwnd i32) (param $bar_x i32) (param $bar_y i32)
        (param $click_x i32) (param $click_y i32)
        (result i32)
    (local $blob i32) (local $count i32) (local $i i32)
    (local $hdc i32) (local $cur_x i32) (local $iw i32)
    (local $base i32) (local $text_wa i32) (local $text_len i32)

    (local.set $blob (call $menu_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const -1))))
    (if (i32.lt_s (local.get $click_y) (local.get $bar_y))
      (then (return (i32.const -1))))
    (if (i32.ge_s (local.get $click_y) (i32.add (local.get $bar_y) (i32.const 18)))
      (then (return (i32.const -1))))
    (local.set $count (i32.load (local.get $blob)))
    (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
    (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))

    (local.set $cur_x (i32.add (local.get $bar_x) (i32.const 4)))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $base (i32.add (local.get $blob)
                         (i32.add (i32.const 4) (i32.mul (local.get $i) (i32.const 12)))))
      (local.set $text_wa (i32.add (local.get $blob) (i32.load (local.get $base))))
      (local.set $text_len (i32.load offset=4 (local.get $base)))
      (local.set $iw (i32.add (call $measure_text (local.get $hdc)
                                 (local.get $text_wa) (local.get $text_len))
                              (i32.const 12)))
      (if (i32.and (i32.ge_s (local.get $click_x) (local.get $cur_x))
                   (i32.lt_s (local.get $click_x)
                             (i32.add (local.get $cur_x) (local.get $iw))))
        (then (return (local.get $i))))
      (local.set $cur_x (i32.add (local.get $cur_x) (local.get $iw)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  ;; Returns x-offset (relative to bar_x) of bar item $idx — used by JS
  ;; to anchor the dropdown beneath the open menu.
  (func (export "menu_bar_item_x")
        (param $hwnd i32) (param $idx i32) (result i32)
    (local $blob i32) (local $hdc i32)
    (local.set $blob (call $menu_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
    (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))
    (call $bar_item_x (local.get $blob) (local.get $hdc) (local.get $idx)))

  ;; ----- child group (dropdown) helpers -----

  ;; Address (in blob_w) of the child header for top-level item $idx,
  ;; or 0 if there are no children.
  (func $child_hdr_w (param $blob_w i32) (param $idx i32) (result i32)
    (local $base i32) (local $cof i32)
    (local.set $base (i32.add (local.get $blob_w)
                       (i32.add (i32.const 4) (i32.mul (local.get $idx) (i32.const 12)))))
    (local.set $cof (i32.load offset=8 (local.get $base)))
    (if (i32.eqz (local.get $cof)) (then (return (i32.const 0))))
    (i32.add (local.get $blob_w) (local.get $cof)))

  ;; Number of children for bar item $idx (0 if none).
  (func $menu_child_count (export "menu_child_count")
        (param $hwnd i32) (param $idx i32) (result i32)
    (local $blob i32) (local $hdr i32)
    (local.set $blob (call $menu_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $hdr (call $child_hdr_w (local.get $blob) (local.get $idx)))
    (if (i32.eqz (local.get $hdr)) (then (return (i32.const 0))))
    (i32.load (local.get $hdr)))

  ;; Address (in blob_w) of child item $cidx within top item $tidx, or 0.
  (func $child_item_w (param $blob_w i32) (param $tidx i32) (param $cidx i32)
                        (result i32)
    (local $hdr i32)
    (local.set $hdr (call $child_hdr_w (local.get $blob_w) (local.get $tidx)))
    (if (i32.eqz (local.get $hdr)) (then (return (i32.const 0))))
    (i32.add (local.get $hdr)
             (i32.add (i32.const 4) (i32.mul (local.get $cidx) (i32.const 24)))))

  ;; Command id of child (top, child).
  (func $menu_child_id (export "menu_child_id")
        (param $hwnd i32) (param $tidx i32) (param $cidx i32) (result i32)
    (local $blob i32) (local $it i32)
    (local.set $blob (call $menu_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $it (call $child_item_w (local.get $blob) (local.get $tidx) (local.get $cidx)))
    (if (i32.eqz (local.get $it)) (then (return (i32.const 0))))
    (i32.load offset=20 (local.get $it)))

  ;; Flags of child (bit0 separator, bit1 grayed, bit2 checked).
  (func $menu_child_flags (export "menu_child_flags")
        (param $hwnd i32) (param $tidx i32) (param $cidx i32) (result i32)
    (local $blob i32) (local $it i32)
    (local.set $blob (call $menu_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $it (call $child_item_w (local.get $blob) (local.get $tidx) (local.get $cidx)))
    (if (i32.eqz (local.get $it)) (then (return (i32.const 0))))
    (i32.load offset=16 (local.get $it)))

  ;; Set/clear the "checked" flag bit (bit2, value 0x04) on every child
  ;; item in this blob whose command id matches $id. Returns the item's
  ;; previous checked state (MF_CHECKED=8 or MF_UNCHECKED=0) for the
  ;; first match, or -1 if nothing matched.
  (func $menu_blob_set_check
        (param $blob_w i32) (param $id i32) (param $check i32) (result i32)
    (local $bar_count i32) (local $i i32) (local $bar_item i32)
    (local $hdr_off i32) (local $hdr i32) (local $cc i32) (local $j i32)
    (local $it i32) (local $flags i32) (local $found i32) (local $prev i32)
    (local.set $found (i32.const 0))
    (local.set $prev  (i32.const 0))
    (local.set $bar_count (i32.load (local.get $blob_w)))
    (local.set $i (i32.const 0))
    (block $done (loop $bar
      (br_if $done (i32.ge_u (local.get $i) (local.get $bar_count)))
      (local.set $bar_item (i32.add (local.get $blob_w)
                             (i32.add (i32.const 4) (i32.mul (local.get $i) (i32.const 12)))))
      (local.set $hdr_off (i32.load offset=8 (local.get $bar_item)))
      (if (local.get $hdr_off)
        (then
          (local.set $hdr (i32.add (local.get $blob_w) (local.get $hdr_off)))
          (local.set $cc (i32.load (local.get $hdr)))
          (local.set $j (i32.const 0))
          (block $cdone (loop $c
            (br_if $cdone (i32.ge_u (local.get $j) (local.get $cc)))
            (local.set $it (i32.add (local.get $hdr)
                             (i32.add (i32.const 4) (i32.mul (local.get $j) (i32.const 24)))))
            (if (i32.eq (i32.load offset=20 (local.get $it)) (local.get $id))
              (then
                (local.set $flags (i32.load offset=16 (local.get $it)))
                (if (i32.eqz (local.get $found))
                  (then
                    (if (i32.and (local.get $flags) (i32.const 0x04))
                      (then (local.set $prev (i32.const 8))))
                    (local.set $found (i32.const 1))))
                (if (local.get $check)
                  (then (local.set $flags (i32.or (local.get $flags) (i32.const 0x04))))
                  (else (local.set $flags (i32.and (local.get $flags) (i32.const -5)))))
                (i32.store offset=16 (local.get $it) (local.get $flags))))
            (local.set $j (i32.add (local.get $j) (i32.const 1)))
            (br $c)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $bar)))
    (if (local.get $found)
      (then (return (local.get $prev))))
    (i32.const -1))

  ;; Walk every window that has a menu blob and toggle the check state
  ;; of the first matching id. Invalidates any hwnd whose menu changed
  ;; so the next dropdown paint reflects the new state. Returns the
  ;; original state (MF_UNCHECKED=0, MF_CHECKED=8) or -1 if no match.
  (func $menu_check_item_global (export "menu_check_item_global")
        (param $id i32) (param $check i32) (result i32)
    (local $i i32) (local $hwnd i32) (local $blob_w i32)
    (local $r i32) (local $prev i32)
    (local.set $prev (i32.const -1))
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $hwnd (i32.load (call $wnd_record_addr (local.get $i))))
      (if (local.get $hwnd)
        (then
          (local.set $blob_w (call $menu_blob_w (local.get $hwnd)))
          (if (local.get $blob_w)
            (then
              (local.set $r (call $menu_blob_set_check
                              (local.get $blob_w) (local.get $id) (local.get $check)))
              (if (i32.ne (local.get $r) (i32.const -1))
                (then
                  (if (i32.eq (local.get $prev) (i32.const -1))
                    (then (local.set $prev (local.get $r))))
                  (call $host_invalidate (local.get $hwnd))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (local.get $prev))

  ;; Accel-char (uppercase ASCII) for top-level item $idx, or 0 if none.
  ;; The accel char is the byte after the first un-doubled '&'.
  (func $menu_bar_accel (export "menu_bar_accel")
        (param $hwnd i32) (param $idx i32) (result i32)
    (local $blob i32) (local $base i32)
    (local $text_wa i32) (local $text_len i32) (local $i i32) (local $ch i32)
    (local.set $blob (call $menu_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $base (i32.add (local.get $blob)
                       (i32.add (i32.const 4) (i32.mul (local.get $idx) (i32.const 12)))))
    (local.set $text_wa (i32.add (local.get $blob) (i32.load (local.get $base))))
    (local.set $text_len (i32.load offset=4 (local.get $base)))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (i32.add (local.get $i) (i32.const 1))
                             (local.get $text_len)))
      (if (i32.eq (i32.load8_u (i32.add (local.get $text_wa) (local.get $i))) (i32.const 0x26))
        (then
          (local.set $ch (i32.load8_u (i32.add (local.get $text_wa)
                            (i32.add (local.get $i) (i32.const 1)))))
          (if (i32.ne (local.get $ch) (i32.const 0x26))
            (then
              ;; Uppercase ASCII a-z → A-Z
              (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x61))
                           (i32.le_u (local.get $ch) (i32.const 0x7A)))
                (then (local.set $ch (i32.sub (local.get $ch) (i32.const 0x20)))))
              (return (local.get $ch))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; Accel-char for child item (top, child) — same logic as bar_accel.
  (func $menu_child_accel (export "menu_child_accel")
        (param $hwnd i32) (param $tidx i32) (param $cidx i32) (result i32)
    (local $blob i32) (local $it i32)
    (local $text_wa i32) (local $text_len i32) (local $i i32) (local $ch i32)
    (local.set $blob (call $menu_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $it (call $child_item_w (local.get $blob) (local.get $tidx) (local.get $cidx)))
    (if (i32.eqz (local.get $it)) (then (return (i32.const 0))))
    (local.set $text_wa (i32.add (local.get $blob) (i32.load (local.get $it))))
    (local.set $text_len (i32.load offset=4 (local.get $it)))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (i32.add (local.get $i) (i32.const 1))
                             (local.get $text_len)))
      (if (i32.eq (i32.load8_u (i32.add (local.get $text_wa) (local.get $i))) (i32.const 0x26))
        (then
          (local.set $ch (i32.load8_u (i32.add (local.get $text_wa)
                            (i32.add (local.get $i) (i32.const 1)))))
          (if (i32.ne (local.get $ch) (i32.const 0x26))
            (then
              (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x61))
                           (i32.le_u (local.get $ch) (i32.const 0x7A)))
                (then (local.set $ch (i32.sub (local.get $ch) (i32.const 0x20)))))
              (return (local.get $ch))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; ============================================================
  ;; $menu_paint_dropdown — draw the dropdown for top-level item
  ;; $tidx at (dx, dy). Width is fixed at 180, height = count*20+4.
  ;; Items use itemH=20, label inset=20, hover highlight when
  ;; $hover_cidx == this child index.
  ;; ============================================================
  (func (export "menu_paint_dropdown")
        (param $hwnd i32) (param $tidx i32) (param $dx i32) (param $dy i32)
        (param $hover_cidx i32)
    (local $blob i32) (local $hdr i32) (local $count i32) (local $i i32)
    (local $hdc i32) (local $iy i32) (local $it i32) (local $flags i32)
    (local $label_wa i32) (local $label_len i32)
    (local $sc_wa i32) (local $sc_len i32) (local $dh i32)
    (local.set $blob (call $menu_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return)))
    (local.set $hdr (call $child_hdr_w (local.get $blob) (local.get $tidx)))
    (if (i32.eqz (local.get $hdr)) (then (return)))
    (local.set $count (i32.load (local.get $hdr)))
    (if (i32.eqz (local.get $count)) (then (return)))

    (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
    (local.set $dh (i32.add (i32.mul (local.get $count) (i32.const 20)) (i32.const 4)))
    ;; Background + outset border.
    (drop (call $host_gdi_fill_rect (local.get $hdc)
            (local.get $dx) (local.get $dy)
            (i32.add (local.get $dx) (i32.const 180))
            (i32.add (local.get $dy) (local.get $dh))
            (i32.const 0x30011)))
    (drop (call $host_gdi_draw_edge (local.get $hdc)
            (local.get $dx) (local.get $dy)
            (i32.add (local.get $dx) (i32.const 180))
            (i32.add (local.get $dy) (local.get $dh))
            (i32.const 0x05) (i32.const 0x0F)))

    (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))
    (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))

    (local.set $iy (i32.add (local.get $dy) (i32.const 2)))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $it (i32.add (local.get $hdr)
                       (i32.add (i32.const 4) (i32.mul (local.get $i) (i32.const 24)))))
      (local.set $flags (i32.load offset=16 (local.get $it)))
      (if (i32.and (local.get $flags) (i32.const 0x01))
        (then
          ;; Separator: 1px shadow line in the middle of the row.
          (drop (call $host_gdi_fill_rect (local.get $hdc)
                  (i32.add (local.get $dx) (i32.const 4))
                  (i32.add (local.get $iy) (i32.const 9))
                  (i32.add (local.get $dx) (i32.const 176))
                  (i32.add (local.get $iy) (i32.const 10))
                  (i32.const 0x30012))))
        (else
          ;; Hover highlight.
          (if (i32.eq (local.get $i) (local.get $hover_cidx))
            (then
              (drop (call $host_gdi_fill_rect (local.get $hdc)
                      (i32.add (local.get $dx) (i32.const 2)) (local.get $iy)
                      (i32.add (local.get $dx) (i32.const 178))
                      (i32.add (local.get $iy) (i32.const 20))
                      (i32.const 14))) ;; COLOR_HIGHLIGHT brush
              (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0xFFFFFF))))
            (else
              (if (i32.and (local.get $flags) (i32.const 0x02))
                (then (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x808080))))
                (else (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x000000)))))))
          ;; Check glyph — two-stroke V drawn with BLACK_PEN/WHITE_PEN in the
          ;; left margin when MF_CHECKED (bit2) is set. Second pass offset by
          ;; +1 row gives a 2-px thick check. Font is re-selected after so
          ;; DrawText below keeps working.
          (if (i32.and (local.get $flags) (i32.const 0x04))
            (then
              (drop (call $host_gdi_select_object (local.get $hdc)
                      (if (result i32) (i32.eq (local.get $i) (local.get $hover_cidx))
                        (then (i32.const 0x30016))   ;; WHITE_PEN on hover
                        (else (i32.const 0x30017))))) ;; BLACK_PEN otherwise
              (drop (call $host_gdi_move_to (local.get $hdc)
                      (i32.add (local.get $dx) (i32.const 5))
                      (i32.add (local.get $iy) (i32.const 10))))
              (drop (call $host_gdi_line_to (local.get $hdc)
                      (i32.add (local.get $dx) (i32.const 8))
                      (i32.add (local.get $iy) (i32.const 14))))
              (drop (call $host_gdi_line_to (local.get $hdc)
                      (i32.add (local.get $dx) (i32.const 14))
                      (i32.add (local.get $iy) (i32.const 6))))
              (drop (call $host_gdi_move_to (local.get $hdc)
                      (i32.add (local.get $dx) (i32.const 5))
                      (i32.add (local.get $iy) (i32.const 11))))
              (drop (call $host_gdi_line_to (local.get $hdc)
                      (i32.add (local.get $dx) (i32.const 8))
                      (i32.add (local.get $iy) (i32.const 15))))
              (drop (call $host_gdi_line_to (local.get $hdc)
                      (i32.add (local.get $dx) (i32.const 14))
                      (i32.add (local.get $iy) (i32.const 7))))
              (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))))
          ;; Label
          (local.set $label_wa (i32.add (local.get $blob) (i32.load (local.get $it))))
          (local.set $label_len (i32.load offset=4 (local.get $it)))
          (i32.store           (global.get $PAINT_SCRATCH)
                               (i32.add (local.get $dx) (i32.const 20)))
          (i32.store offset=4  (global.get $PAINT_SCRATCH) (local.get $iy))
          (i32.store offset=8  (global.get $PAINT_SCRATCH)
                               (i32.add (local.get $dx) (i32.const 160)))
          (i32.store offset=12 (global.get $PAINT_SCRATCH)
                               (i32.add (local.get $iy) (i32.const 20)))
          ;; DT_LEFT|DT_VCENTER|DT_SINGLELINE = 0x24
          (drop (call $host_gdi_draw_text (local.get $hdc)
                  (local.get $label_wa) (local.get $label_len)
                  (global.get $PAINT_SCRATCH)
                  (i32.const 0x24) (i32.const 0)))
          ;; Optional shortcut, right-aligned.
          (local.set $sc_len (i32.load offset=12 (local.get $it)))
          (if (local.get $sc_len)
            (then
              (local.set $sc_wa (i32.add (local.get $blob)
                                  (i32.load offset=8 (local.get $it))))
              (i32.store           (global.get $PAINT_SCRATCH)
                                   (i32.add (local.get $dx) (i32.const 20)))
              (i32.store offset=4  (global.get $PAINT_SCRATCH) (local.get $iy))
              (i32.store offset=8  (global.get $PAINT_SCRATCH)
                                   (i32.add (local.get $dx) (i32.const 160)))
              (i32.store offset=12 (global.get $PAINT_SCRATCH)
                                   (i32.add (local.get $iy) (i32.const 20)))
              ;; DT_RIGHT(2)|DT_VCENTER(4)|DT_SINGLELINE(0x20) = 0x26
              (drop (call $host_gdi_draw_text (local.get $hdc)
                      (local.get $sc_wa) (local.get $sc_len)
                      (global.get $PAINT_SCRATCH)
                      (i32.const 0x26) (i32.const 0)))))))
      (local.set $iy (i32.add (local.get $iy) (i32.const 20)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan))))

  ;; Dropdown box height for top item $tidx (0 if no children).
  ;; Used by JS to size the dropdown rect for hit-testing.
  (func (export "menu_dropdown_height")
        (param $hwnd i32) (param $tidx i32) (result i32)
    (local $blob i32) (local $hdr i32) (local $count i32)
    (local.set $blob (call $menu_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $hdr (call $child_hdr_w (local.get $blob) (local.get $tidx)))
    (if (i32.eqz (local.get $hdr)) (then (return (i32.const 0))))
    (local.set $count (i32.load (local.get $hdr)))
    (i32.add (i32.mul (local.get $count) (i32.const 20)) (i32.const 4)))

  ;; Hit-test a click against an open dropdown of $tidx anchored at
  ;; (dx, dy). Returns child index, or -1 if outside / on a separator.
  (func (export "menu_hittest_dropdown")
        (param $hwnd i32) (param $tidx i32) (param $dx i32) (param $dy i32)
        (param $click_x i32) (param $click_y i32) (result i32)
    (local $blob i32) (local $hdr i32) (local $count i32) (local $cidx i32)
    (local $iy0 i32) (local $it i32) (local $flags i32) (local $dh i32)
    (local.set $blob (call $menu_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const -1))))
    (local.set $hdr (call $child_hdr_w (local.get $blob) (local.get $tidx)))
    (if (i32.eqz (local.get $hdr)) (then (return (i32.const -1))))
    (local.set $count (i32.load (local.get $hdr)))
    (local.set $dh (i32.add (i32.mul (local.get $count) (i32.const 20)) (i32.const 4)))
    ;; Outside box?
    (if (i32.lt_s (local.get $click_x) (i32.add (local.get $dx) (i32.const 2)))
      (then (return (i32.const -1))))
    (if (i32.ge_s (local.get $click_x) (i32.add (local.get $dx) (i32.const 178)))
      (then (return (i32.const -1))))
    (if (i32.lt_s (local.get $click_y) (i32.add (local.get $dy) (i32.const 2)))
      (then (return (i32.const -1))))
    (if (i32.ge_s (local.get $click_y) (i32.add (local.get $dy) (local.get $dh)))
      (then (return (i32.const -1))))
    (local.set $iy0 (i32.add (local.get $dy) (i32.const 2)))
    (local.set $cidx (i32.div_s (i32.sub (local.get $click_y) (local.get $iy0))
                                 (i32.const 20)))
    (if (i32.lt_s (local.get $cidx) (i32.const 0)) (then (return (i32.const -1))))
    (if (i32.ge_s (local.get $cidx) (local.get $count)) (then (return (i32.const -1))))
    (local.set $it (i32.add (local.get $hdr)
                     (i32.add (i32.const 4) (i32.mul (local.get $cidx) (i32.const 24)))))
    (local.set $flags (i32.load offset=16 (local.get $it)))
    (if (i32.and (local.get $flags) (i32.const 0x01))
      (then (return (i32.const -1))))
    (local.get $cidx))

  ;; ============================================================
  ;; $menu_load — parse the PE MENU resource ($find_resource(4, id))
  ;; into the heap-resident blob layout above and store the guest
  ;; pointer in MENU_DATA_TABLE[slot]. Replaces the JS encoder that
  ;; used to call menu_set with a pre-built blob.
  ;;
  ;; PE MENUITEMTEMPLATE format (we accept the standard, not MENUEX):
  ;;   MENUHEADER:  WORD wVersion=0; WORD cbHeaderSize=0;
  ;;   per item:    WORD fItemFlags;
  ;;                if !(fItemFlags & MF_POPUP=0x10): WORD wMenuID;
  ;;                WCHAR szString[]   (UTF-16, NUL-terminated)
  ;;                if fItemFlags & MF_POPUP: nested items follow
  ;;   MF_END=0x80 marks the last sibling at any level.
  ;;   MF_GRAYED=0x01, MF_SEPARATOR=0x800 may be ORed in.
  ;;
  ;; Two-level model: top-level items become bar items; if a bar item
  ;; is a popup, its direct children become dropdown items. Cascading
  ;; sub-popups (popup-in-popup) are consumed but flattened away (none
  ;; of our test apps use them).
  ;;
  ;; Two passes over the PE bytes:
  ;;   pass 1 — count $ml_bar_count, $ml_struct_size, $ml_string_size
  ;;   pass 2 — write into a freshly allocated heap blob, sized exactly
  ;; ============================================================

  ;; Read a UTF-16 string starting at $ml_pos. Advances $ml_pos past
  ;; the trailing NUL, writes the char count to $ml_label_chars, and
  ;; returns the WASM addr of the first character.
  (func $ml_load_label (result i32)
    (local $start i32) (local $chars i32) (local $ch i32)
    (local.set $start (global.get $ml_pos))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (global.get $ml_pos) (global.get $ml_end)))
      (local.set $ch (i32.load16_u (global.get $ml_pos)))
      (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))
      (br_if $done (i32.eqz (local.get $ch)))
      (local.set $chars (i32.add (local.get $chars) (i32.const 1)))
      (br $scan)))
    (global.set $ml_label_chars (local.get $chars))
    (local.get $start))

  ;; Recursively consume one level of items WITHOUT counting them.
  ;; Used to skip cascading sub-popups in pass 1 / pass 2.
  (func $ml_skip_level
    (local $flags i32)
    (block $done (loop $items
      (br_if $done (i32.ge_u (global.get $ml_pos) (global.get $ml_end)))
      (local.set $flags (i32.load16_u (global.get $ml_pos)))
      (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))
      (if (i32.eqz (i32.and (local.get $flags) (i32.const 0x10)))
        (then (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))))
      (drop (call $ml_load_label))
      (if (i32.and (local.get $flags) (i32.const 0x10))
        (then (call $ml_skip_level)))
      (br_if $done (i32.and (local.get $flags) (i32.const 0x80)))
      (br $items))))

  ;; Pass 1 — children of one popup. Updates $ml_struct_size /
  ;; $ml_string_size. Counts children locally; if non-zero, adds the
  ;; child header (4 + 24*N) to struct_size.
  (func $ml_pass1_children
    (local $cc i32) (local $flags i32) (local $chars i32)
    (block $done (loop $items
      (br_if $done (i32.ge_u (global.get $ml_pos) (global.get $ml_end)))
      (local.set $flags (i32.load16_u (global.get $ml_pos)))
      (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))
      (if (i32.eqz (i32.and (local.get $flags) (i32.const 0x10)))
        (then (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))))
      (drop (call $ml_load_label))
      (local.set $cc (i32.add (local.get $cc) (i32.const 1)))
      (global.set $ml_string_size
        (i32.add (global.get $ml_string_size) (global.get $ml_label_chars)))
      (if (i32.and (local.get $flags) (i32.const 0x10))
        (then (call $ml_skip_level)))
      (br_if $done (i32.and (local.get $flags) (i32.const 0x80)))
      (br $items)))
    (if (local.get $cc)
      (then (global.set $ml_struct_size
              (i32.add (global.get $ml_struct_size)
                       (i32.add (i32.const 4) (i32.mul (local.get $cc) (i32.const 24))))))))

  ;; Pass 1 — top level. Walks each top item, counting bar slots and
  ;; recursing into children once for popups.
  (func $ml_pass1
    (local $flags i32) (local $chars i32)
    (block $done (loop $items
      (br_if $done (i32.ge_u (global.get $ml_pos) (global.get $ml_end)))
      (local.set $flags (i32.load16_u (global.get $ml_pos)))
      (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))
      (if (i32.eqz (i32.and (local.get $flags) (i32.const 0x10)))
        (then (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))))
      (drop (call $ml_load_label))
      (global.set $ml_bar_count (i32.add (global.get $ml_bar_count) (i32.const 1)))
      (global.set $ml_struct_size (i32.add (global.get $ml_struct_size) (i32.const 12)))
      (global.set $ml_string_size
        (i32.add (global.get $ml_string_size) (global.get $ml_label_chars)))
      (if (i32.and (local.get $flags) (i32.const 0x10))
        (then (call $ml_pass1_children)))
      (br_if $done (i32.and (local.get $flags) (i32.const 0x80)))
      (br $items))))

  ;; Find the first '\t' (UTF-16 0x09) in a label, or -1.
  (func $ml_find_tab (param $wa i32) (param $chars i32) (result i32)
    (local $i i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $chars)))
      (if (i32.eq (i32.load16_u (i32.add (local.get $wa) (i32.shl (local.get $i) (i32.const 1))))
                  (i32.const 0x09))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  ;; Copy $chars UTF-16 chars from $src_wa to $dst_wa as ASCII (low byte).
  (func $ml_copy_ascii (param $src_wa i32) (param $dst_wa i32) (param $chars i32)
    (local $i i32)
    (block $done (loop $cp
      (br_if $done (i32.ge_u (local.get $i) (local.get $chars)))
      (i32.store8 (i32.add (local.get $dst_wa) (local.get $i))
                  (i32.load16_u (i32.add (local.get $src_wa)
                                          (i32.shl (local.get $i) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cp))))

  ;; Pass 2 — children of one popup. Walks PE bytes the same way, fills
  ;; the child block at $ml_struct_cur (reserve count slot, write items,
  ;; back-patch count). Returns child count.
  (func $ml_pass2_children (result i32)
    (local $cc i32) (local $flags i32) (local $id i32)
    (local $str_w i32) (local $chars i32)
    (local $count_off i32) (local $hdr_off i32)
    (local $tab i32) (local $label_chars i32) (local $sc_chars i32)
    (local $label_off i32) (local $sc_off i32) (local $out_flags i32)
    (local $isPopup i32)
    (local.set $count_off (global.get $ml_struct_cur))
    (global.set $ml_struct_cur (i32.add (global.get $ml_struct_cur) (i32.const 4)))
    (block $done (loop $items
      (br_if $done (i32.ge_u (global.get $ml_pos) (global.get $ml_end)))
      (local.set $flags (i32.load16_u (global.get $ml_pos)))
      (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))
      (local.set $isPopup (i32.and (local.get $flags) (i32.const 0x10)))
      (local.set $id (i32.const 0))
      (if (i32.eqz (local.get $isPopup))
        (then
          (local.set $id (i32.load16_u (global.get $ml_pos)))
          (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))))
      (local.set $str_w (call $ml_load_label))
      (local.set $chars (global.get $ml_label_chars))
      (local.set $hdr_off (global.get $ml_struct_cur))
      (global.set $ml_struct_cur (i32.add (global.get $ml_struct_cur) (i32.const 24)))
      ;; Split label on '\t' for shortcut
      (local.set $tab (call $ml_find_tab (local.get $str_w) (local.get $chars)))
      (if (i32.ge_s (local.get $tab) (i32.const 0))
        (then
          (local.set $label_chars (local.get $tab))
          (local.set $sc_chars (i32.sub (i32.sub (local.get $chars) (local.get $tab)) (i32.const 1))))
        (else
          (local.set $label_chars (local.get $chars))
          (local.set $sc_chars (i32.const 0))))
      ;; Copy label to string region
      (local.set $label_off (global.get $ml_string_cur))
      (call $ml_copy_ascii (local.get $str_w)
            (i32.add (global.get $ml_blob_w) (global.get $ml_string_cur))
            (local.get $label_chars))
      (global.set $ml_string_cur (i32.add (global.get $ml_string_cur) (local.get $label_chars)))
      (local.set $sc_off (i32.const 0))
      (if (local.get $sc_chars)
        (then
          (local.set $sc_off (global.get $ml_string_cur))
          (call $ml_copy_ascii
            (i32.add (local.get $str_w) (i32.shl (i32.add (local.get $tab) (i32.const 1))
                                                  (i32.const 1)))
            (i32.add (global.get $ml_blob_w) (global.get $ml_string_cur))
            (local.get $sc_chars))
          (global.set $ml_string_cur (i32.add (global.get $ml_string_cur) (local.get $sc_chars)))))
      ;; Out flags: bit0 separator, bit1 grayed
      (local.set $out_flags (i32.const 0))
      (if (i32.or (i32.and (local.get $flags) (i32.const 0x800))
                  (i32.and (i32.eqz (local.get $chars))
                           (i32.eqz (i32.or (local.get $isPopup) (local.get $id)))))
        (then (local.set $out_flags (i32.or (local.get $out_flags) (i32.const 1)))))
      (if (i32.and (local.get $flags) (i32.const 0x01))
        (then (local.set $out_flags (i32.or (local.get $out_flags) (i32.const 2)))))
      ;; Write the child item record (24 bytes) at hdr_off.
      (i32.store           (i32.add (global.get $ml_blob_w) (local.get $hdr_off)) (local.get $label_off))
      (i32.store offset=4  (i32.add (global.get $ml_blob_w) (local.get $hdr_off)) (local.get $label_chars))
      (i32.store offset=8  (i32.add (global.get $ml_blob_w) (local.get $hdr_off)) (local.get $sc_off))
      (i32.store offset=12 (i32.add (global.get $ml_blob_w) (local.get $hdr_off)) (local.get $sc_chars))
      (i32.store offset=16 (i32.add (global.get $ml_blob_w) (local.get $hdr_off)) (local.get $out_flags))
      (i32.store offset=20 (i32.add (global.get $ml_blob_w) (local.get $hdr_off)) (local.get $id))
      (local.set $cc (i32.add (local.get $cc) (i32.const 1)))
      (if (local.get $isPopup) (then (call $ml_skip_level)))
      (br_if $done (i32.and (local.get $flags) (i32.const 0x80)))
      (br $items)))
    ;; Patch the count slot.
    (i32.store (i32.add (global.get $ml_blob_w) (local.get $count_off)) (local.get $cc))
    (if (i32.eqz (local.get $cc))
      (then
        ;; No children — release the reserved count slot so the layout
        ;; stays compact (no orphan child header).
        (global.set $ml_struct_cur (local.get $count_off))))
    (local.get $cc))

  ;; Pass 2 — top level. Writes bar items at fixed offsets and recurses
  ;; into children for each popup.
  (func $ml_pass2
    (local $bar_idx i32) (local $flags i32) (local $id i32)
    (local $isPopup i32) (local $str_w i32) (local $chars i32)
    (local $bar_addr i32) (local $label_off i32)
    (local $child_off i32) (local $cc i32)
    (block $done (loop $items
      (br_if $done (i32.ge_u (global.get $ml_pos) (global.get $ml_end)))
      (br_if $done (i32.ge_u (local.get $bar_idx) (global.get $ml_bar_count)))
      (local.set $flags (i32.load16_u (global.get $ml_pos)))
      (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))
      (local.set $isPopup (i32.and (local.get $flags) (i32.const 0x10)))
      (local.set $id (i32.const 0))
      (if (i32.eqz (local.get $isPopup))
        (then
          (local.set $id (i32.load16_u (global.get $ml_pos)))
          (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))))
      (local.set $str_w (call $ml_load_label))
      (local.set $chars (global.get $ml_label_chars))
      (local.set $bar_addr
        (i32.add (global.get $ml_blob_w)
                 (i32.add (i32.const 4) (i32.mul (local.get $bar_idx) (i32.const 12)))))
      ;; Copy bar label
      (local.set $label_off (global.get $ml_string_cur))
      (call $ml_copy_ascii (local.get $str_w)
            (i32.add (global.get $ml_blob_w) (global.get $ml_string_cur))
            (local.get $chars))
      (global.set $ml_string_cur (i32.add (global.get $ml_string_cur) (local.get $chars)))
      (i32.store          (local.get $bar_addr) (local.get $label_off))
      (i32.store offset=4 (local.get $bar_addr) (local.get $chars))
      (i32.store offset=8 (local.get $bar_addr) (i32.const 0))
      (if (local.get $isPopup)
        (then
          (local.set $child_off (global.get $ml_struct_cur))
          (local.set $cc (call $ml_pass2_children))
          (if (local.get $cc)
            (then (i32.store offset=8 (local.get $bar_addr) (local.get $child_off))))))
      (local.set $bar_idx (i32.add (local.get $bar_idx) (i32.const 1)))
      (br_if $done (i32.and (local.get $flags) (i32.const 0x80)))
      (br $items))))

  ;; Public entry: load the menu identified by $menu_id (RT_MENU=4) for
  ;; $hwnd. Pass menu_id=0 to clear. Skips the load entirely if this
  ;; slot already has a blob — callers may invoke this multiple times
  ;; (eager path in $handle_CreateWindowExA, lazy path from renderer
  ;; _ensureWatMenu) and the first load wins so mutable state such as
  ;; CheckMenuItem's bit2 flag survives subsequent calls.
  (func $menu_load (export "menu_load") (param $hwnd i32) (param $menu_id i32)
    (local $slot i32) (local $tbl i32) (local $old i32)
    (local $entry i32) (local $bytes_g i32) (local $bytes_w i32)
    (local $size i32) (local $total i32) (local $newg i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $slot) (i32.const -1)) (then (return)))
    (local.set $tbl (call $menu_data_table_addr (local.get $slot)))
    (local.set $old (i32.load (local.get $tbl)))
    (if (i32.eqz (local.get $menu_id))
      (then
        (if (local.get $old) (then (call $heap_free (local.get $old))))
        (i32.store (local.get $tbl) (i32.const 0))
        (return)))
    (if (local.get $old) (then (return)))
    ;; Resolve resource bytes.
    (local.set $entry (call $find_resource (i32.const 4) (local.get $menu_id)))
    (if (i32.eqz (local.get $entry)) (then (return)))
    ;; data entry: i32 RVA, i32 size
    (local.set $bytes_g (i32.add (global.get $image_base)
                          (i32.load (call $g2w (i32.add (global.get $image_base) (local.get $entry))))))
    (local.set $size (i32.load (call $g2w (i32.add (global.get $image_base)
                                                    (i32.add (local.get $entry) (i32.const 4))))))
    (if (i32.lt_u (local.get $size) (i32.const 8)) (then (return)))
    (local.set $bytes_w (call $g2w (local.get $bytes_g)))
    ;; --- Pass 1: count ---
    (global.set $ml_pos (i32.add (local.get $bytes_w) (i32.const 4))) ;; skip MENUHEADER
    (global.set $ml_end (i32.add (local.get $bytes_w) (local.get $size)))
    (global.set $ml_bar_count   (i32.const 0))
    (global.set $ml_struct_size (i32.const 4)) ;; bar_count header
    (global.set $ml_string_size (i32.const 0))
    (call $ml_pass1)
    (if (i32.eqz (global.get $ml_bar_count)) (then (return)))
    ;; --- Allocate blob and run pass 2 ---
    (local.set $total (i32.add (global.get $ml_struct_size) (global.get $ml_string_size)))
    (local.set $newg (call $heap_alloc (local.get $total)))
    (i32.store (local.get $tbl) (local.get $newg))
    (global.set $ml_blob_w (call $g2w (local.get $newg)))
    ;; bar_count header
    (i32.store (global.get $ml_blob_w) (global.get $ml_bar_count))
    ;; cursors: $ml_struct_cur runs forward through bar items + child
    ;; blocks; $ml_string_cur runs forward through the string region
    ;; that begins right after the struct region.
    (global.set $ml_string_cur (global.get $ml_struct_size))
    (global.set $ml_struct_cur
      (i32.add (i32.const 4) (i32.mul (global.get $ml_bar_count) (i32.const 12))))
    (global.set $ml_pos (i32.add (local.get $bytes_w) (i32.const 4)))
    (call $ml_pass2))

  ;; ============================================================
  ;; Menu tracking — JS shells out raw mouse / keyboard events to
  ;; the helpers below; all open/close/hover/activate logic lives
  ;; here. State is in $menu_open_hwnd / $menu_open_top /
  ;; $menu_open_hover (one menu open at a time, system-wide).
  ;;
  ;; Activations post WM_COMMAND (or WM_CLOSE for File→Exit, id=28)
  ;; into the existing post queue at WASM addr 0x400 (same one
  ;; PostMessageA writes to). The host pump dequeues and dispatches
  ;; on the next iteration.
  ;; ============================================================

  (func (export "menu_open_hwnd")  (result i32) (global.get $menu_open_hwnd))
  (func (export "menu_open_top")   (result i32) (global.get $menu_open_top))
  (func (export "menu_open_hover") (result i32) (global.get $menu_open_hover))

  ;; Number of items currently being tracked (0 if no menu open).
  (func $menu_track_child_count (result i32)
    (if (i32.eqz (global.get $menu_open_hwnd)) (then (return (i32.const 0))))
    (call $menu_child_count (global.get $menu_open_hwnd) (global.get $menu_open_top)))

  ;; Returns the first non-separator non-grayed child idx in the open
  ;; dropdown, or -1 (e.g. when nothing is selectable).
  (func $menu_first_selectable (result i32)
    (local $n i32) (local $i i32) (local $f i32)
    (local.set $n (call $menu_track_child_count))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $f (call $menu_child_flags
                     (global.get $menu_open_hwnd)
                     (global.get $menu_open_top)
                     (local.get $i)))
      (if (i32.eqz (i32.and (local.get $f) (i32.const 0x03)))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  (func $menu_open (export "menu_open") (param $hwnd i32) (param $top_idx i32)
    (global.set $menu_open_hwnd  (local.get $hwnd))
    (global.set $menu_open_top   (local.get $top_idx))
    (global.set $menu_open_hover (i32.const -1)))

  (func $menu_close (export "menu_close")
    (global.set $menu_open_hwnd  (i32.const 0))
    (global.set $menu_open_top   (i32.const -1))
    (global.set $menu_open_hover (i32.const -1)))

  (func (export "menu_set_hover") (param $cidx i32)
    (global.set $menu_open_hover (local.get $cidx)))

  ;; Down/Up arrow nav: walk to next selectable child, wrapping. $dir
  ;; is +1 (Down) or -1 (Up).
  (func (export "menu_advance") (param $dir i32)
    (local $n i32) (local $i i32) (local $k i32) (local $f i32)
    (local.set $n (call $menu_track_child_count))
    (if (i32.eqz (local.get $n)) (then (return)))
    (local.set $i (global.get $menu_open_hover))
    (if (i32.lt_s (local.get $i) (i32.const 0))
      (then (local.set $i (select (i32.const -1) (local.get $n)
                                  (i32.gt_s (local.get $dir) (i32.const 0))))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $k) (local.get $n)))
      (local.set $i (i32.add (local.get $i) (local.get $dir)))
      (if (i32.lt_s (local.get $i) (i32.const 0))
        (then (local.set $i (i32.sub (local.get $n) (i32.const 1)))))
      (if (i32.ge_s (local.get $i) (local.get $n))
        (then (local.set $i (i32.const 0))))
      (local.set $f (call $menu_child_flags
                     (global.get $menu_open_hwnd)
                     (global.get $menu_open_top)
                     (local.get $i)))
      (if (i32.eqz (i32.and (local.get $f) (i32.const 0x03)))
        (then
          (global.set $menu_open_hover (local.get $i))
          (return)))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $scan))))

  ;; Left/Right arrow nav: switch to neighbor bar item, wrapping.
  (func (export "menu_switch_top") (param $dir i32)
    (local $n i32) (local $i i32)
    (if (i32.eqz (global.get $menu_open_hwnd)) (then (return)))
    (local.set $n (call $menu_bar_count (global.get $menu_open_hwnd)))
    (if (i32.eqz (local.get $n)) (then (return)))
    (local.set $i (i32.add (global.get $menu_open_top) (local.get $dir)))
    (if (i32.lt_s (local.get $i) (i32.const 0))
      (then (local.set $i (i32.sub (local.get $n) (i32.const 1)))))
    (if (i32.ge_s (local.get $i) (local.get $n))
      (then (local.set $i (i32.const 0))))
    (global.set $menu_open_top (local.get $i))
    (global.set $menu_open_hover (i32.const -1)))

  ;; Internal: enqueue a posted message for hwnd. Mirrors the body of
  ;; $handle_PostMessageA. Used by $menu_post_command on activation.
  (func $menu_post (param $hwnd i32) (param $msg i32)
                    (param $wp i32) (param $lp i32)
    (local $tmp i32)
    (if (i32.ge_u (global.get $post_queue_count) (i32.const 8)) (then (return)))
    (local.set $tmp (i32.add (i32.const 0x400)
                      (i32.mul (global.get $post_queue_count) (i32.const 16))))
    (i32.store           (local.get $tmp) (local.get $hwnd))
    (i32.store offset=4  (local.get $tmp) (local.get $msg))
    (i32.store offset=8  (local.get $tmp) (local.get $wp))
    (i32.store offset=12 (local.get $tmp) (local.get $lp))
    (global.set $post_queue_count (i32.add (global.get $post_queue_count) (i32.const 1))))

  ;; Activate the currently-hovered child of the open menu. Posts a
  ;; WM_COMMAND (or WM_CLOSE for the File→Exit id=28 special case)
  ;; to the parent hwnd, then closes the menu. Returns the command
  ;; id that was posted (0 if nothing happened).
  (func $menu_activate (export "menu_activate") (result i32)
    (local $hwnd i32) (local $top i32) (local $hover i32)
    (local $f i32) (local $id i32)
    (local.set $hwnd (global.get $menu_open_hwnd))
    (if (i32.eqz (local.get $hwnd)) (then (return (i32.const 0))))
    (local.set $top  (global.get $menu_open_top))
    (local.set $hover (global.get $menu_open_hover))
    (if (i32.lt_s (local.get $hover) (i32.const 0)) (then (return (i32.const 0))))
    (local.set $f (call $menu_child_flags (local.get $hwnd) (local.get $top) (local.get $hover)))
    (if (i32.and (local.get $f) (i32.const 0x03))
      (then (return (i32.const 0))))   ;; separator or grayed
    (local.set $id (call $menu_child_id (local.get $hwnd) (local.get $top) (local.get $hover)))
    (if (i32.eq (local.get $id) (i32.const 28))
      (then (call $menu_post (local.get $hwnd) (i32.const 0x0010) (i32.const 0) (i32.const 0)))
      (else (call $menu_post (local.get $hwnd) (i32.const 0x0111) (local.get $id) (i32.const 0))))
    (call $menu_close)
    (local.get $id))

  ;; Find the bar item index whose accelerator char (uppercase ASCII)
  ;; matches $ch, or -1.
  (func (export "menu_find_bar_accel") (param $hwnd i32) (param $ch i32) (result i32)
    (local $n i32) (local $i i32)
    (local.set $n (call $menu_bar_count (local.get $hwnd)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (if (i32.eq (call $menu_bar_accel (local.get $hwnd) (local.get $i)) (local.get $ch))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  ;; Try to activate by child accelerator char while a menu is open.
  ;; Returns 1 if a matching item was found and activated, else 0.
  (func (export "menu_handle_letter") (param $ch i32) (result i32)
    (local $n i32) (local $i i32) (local $f i32)
    (if (i32.eqz (global.get $menu_open_hwnd)) (then (return (i32.const 0))))
    (local.set $n (call $menu_track_child_count))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $f (call $menu_child_flags
                     (global.get $menu_open_hwnd)
                     (global.get $menu_open_top)
                     (local.get $i)))
      (if (i32.eqz (i32.and (local.get $f) (i32.const 0x03)))
        (then
          (if (i32.eq (call $menu_child_accel
                       (global.get $menu_open_hwnd)
                       (global.get $menu_open_top)
                       (local.get $i))
                      (local.get $ch))
            (then
              (global.set $menu_open_hover (local.get $i))
              (drop (call $menu_activate))
              (return (i32.const 1))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))
