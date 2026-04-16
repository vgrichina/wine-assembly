  ;; ============================================================
  ;; WINDOW TABLE + HELP SYSTEM
  ;; ============================================================
  ;; WND_RECORDS at WASM 0x7000: 256 entries × 24 bytes (ends 0x8800).
  ;; Each record:
  ;;   +0   hwnd       (0 = empty slot)
  ;;   +4   wndproc    (guest VA, or 0xFFFFxxxx for WAT-native)
  ;;   +8   parent     (parent hwnd, 0 if top-level)
  ;;   +12  userdata   (GWL_USERDATA)
  ;;   +16  style
  ;;   +20  state_ptr  (heap ptr to per-class WndState, 0 if none)
  ;;
  ;; Class records at WASM 0xA000: 64 entries × 48 bytes (ends 0xAC00).
  ;; Each entry: [name_hash:i32, atom:i32, WNDCLASSA[40]]
  ;; lpfnWndProc lives at record+12 (offset 4 inside the embedded WNDCLASSA).
  ;; Both bases / counts are defined in 01-header.wat — see the memory map.

  ;; ---- Window record helpers ----

  ;; Address of window record N: WND_RECORDS + slot * 24
  (func $wnd_record_addr (param $slot i32) (result i32)
    (i32.add (global.get $WND_RECORDS) (i32.mul (local.get $slot) (i32.const 24))))

  ;; Add or update hwnd→wndproc mapping. Allocates a fresh slot for a new
  ;; hwnd, or updates the existing slot's wndproc field.
  (func $wnd_table_set (param $hwnd i32) (param $wndproc i32)
    (local $i i32) (local $ptr i32) (local $empty i32)
    (local.set $empty (i32.const -1))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      (if (i32.eq (i32.load (local.get $ptr)) (local.get $hwnd))
        (then (i32.store offset=4 (local.get $ptr) (local.get $wndproc)) (return)))
      (if (i32.and (i32.eqz (i32.load (local.get $ptr)))
                   (i32.eq (local.get $empty) (i32.const -1)))
        (then (local.set $empty (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.ne (local.get $empty) (i32.const -1))
      (then
        (local.set $ptr (call $wnd_record_addr (local.get $empty)))
        ;; Zero the entire 24-byte record so a recycled slot does not inherit
        ;; stale parent/userdata/style/state_ptr from a previous window.
        (i32.store         (local.get $ptr) (local.get $hwnd))
        (i32.store offset=4  (local.get $ptr) (local.get $wndproc))
        (i32.store offset=8  (local.get $ptr) (i32.const 0))
        (i32.store offset=12 (local.get $ptr) (i32.const 0))
        (i32.store offset=16 (local.get $ptr) (i32.const 0))
        (i32.store offset=20 (local.get $ptr) (i32.const 0))
        ;; Clear parallel-table state for the recycled slot.
        (call $nc_flags_reset_slot (local.get $empty))
        (call $title_table_reset_slot (local.get $empty))
        (call $client_rect_reset_slot (local.get $empty))))
  )

  ;; Look up wndproc for hwnd; returns 0 if not found
  (func $wnd_table_get (param $hwnd i32) (result i32)
    (local $i i32) (local $ptr i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      (if (i32.eq (i32.load (local.get $ptr)) (local.get $hwnd))
        (then (return (i32.load offset=4 (local.get $ptr)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0)
  )

  ;; Remove hwnd from window table — zeroes the whole record.
  (func $wnd_table_remove (param $hwnd i32)
    (local $i i32) (local $ptr i32) (local $state i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      (if (i32.eq (i32.load (local.get $ptr)) (local.get $hwnd))
        (then
          ;; Free control state if any
          (local.set $state (i32.load offset=20 (local.get $ptr)))
          (if (local.get $state) (then (call $heap_free (local.get $state))))
          ;; Drop parallel-table state tied to this slot.
          (call $nc_flags_reset_slot (local.get $i))
          (call $title_table_reset_slot (local.get $i))
          (call $client_rect_reset_slot (local.get $i))
          ;; Clear the whole 24-byte record
          (i32.store         (local.get $ptr) (i32.const 0))
          (i32.store offset=4  (local.get $ptr) (i32.const 0))
          (i32.store offset=8  (local.get $ptr) (i32.const 0))
          (i32.store offset=12 (local.get $ptr) (i32.const 0))
          (i32.store offset=16 (local.get $ptr) (i32.const 0))
          (i32.store offset=20 (local.get $ptr) (i32.const 0))
          (return)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
  )

  ;; Recursively remove window and all its children from the table.
  (func $wnd_destroy_recursive (param $hwnd i32)
    (local $i i32) (local $ptr i32) (local $other i32)
    (if (i32.eqz (local.get $hwnd)) (then (return)))
    ;; First, find all children and destroy them
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      (local.set $other (i32.load (local.get $ptr)))
      (if (i32.and (i32.ne (local.get $other) (i32.const 0))
                   (i32.eq (i32.load offset=8 (local.get $ptr)) (local.get $hwnd)))
        (then (call $wnd_destroy_recursive (local.get $other))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    ;; Notify host to remove from its table (for each child too)
    (call $host_destroy_window (local.get $hwnd))
    ;; Finally, remove the window itself from guest table
    (call $wnd_table_remove (local.get $hwnd))
  )

  ;; Find window table slot index for hwnd; returns -1 if not found
  (func $wnd_table_find (param $hwnd i32) (result i32)
    (local $i i32) (local $ptr i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $ptr (call $wnd_record_addr (local.get $i)))
      (if (i32.eq (i32.load (local.get $ptr)) (local.get $hwnd))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1)
  )

  ;; Get per-window userdata (record+12)
  (func $wnd_get_userdata (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load offset=12 (call $wnd_record_addr (local.get $idx)))
  )

  ;; Set per-window userdata; returns old value
  (func $wnd_set_userdata (param $hwnd i32) (param $value i32) (result i32)
    (local $idx i32) (local $ptr i32) (local $old i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (local.set $ptr (call $wnd_record_addr (local.get $idx)))
    (local.set $old (i32.load offset=12 (local.get $ptr)))
    (i32.store offset=12 (local.get $ptr) (local.get $value))
    (local.get $old)
  )

  ;; Get parent hwnd (record+8)
  (func $wnd_get_parent (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load offset=8 (call $wnd_record_addr (local.get $idx)))
  )

  ;; Set parent hwnd for a window
  (func $wnd_set_parent (param $hwnd i32) (param $parent i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.ne (local.get $idx) (i32.const -1))
      (then
        (i32.store offset=8 (call $wnd_record_addr (local.get $idx)) (local.get $parent))))
  )

  ;; Get window style (record+16)
  (func $wnd_get_style (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load offset=16 (call $wnd_record_addr (local.get $idx)))
  )

  ;; Set window style; returns old value
  (func $wnd_set_style (param $hwnd i32) (param $style i32) (result i32)
    (local $idx i32) (local $ptr i32) (local $old i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (local.set $ptr (call $wnd_record_addr (local.get $idx)))
    (local.set $old (i32.load offset=16 (local.get $ptr)))
    (i32.store offset=16 (local.get $ptr) (local.get $style))
    (local.get $old)
  )

  ;; Get per-window state pointer (record+20). Heap ptr to a class-specific
  ;; WndState struct (EditState, ButtonState, ...). 0 = no state.
  (func $wnd_get_state_ptr (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load offset=20 (call $wnd_record_addr (local.get $idx)))
  )

  ;; Set per-window state pointer
  (func $wnd_set_state_ptr (param $hwnd i32) (param $value i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.ne (local.get $idx) (i32.const -1))
      (then
        (i32.store offset=20 (call $wnd_record_addr (local.get $idx)) (local.get $value))))
  )

  ;; ---- Class table helpers ----
  ;; Convert a class-name guest pointer to the key used throughout the class
  ;; table. If the guest value is a MAKEINTATOM (low 16-bit integer), pass it
  ;; through unchanged — $g2w would otherwise map it to NULL_SENTINEL and
  ;; collapse all atom-named classes onto one slot. Otherwise translate the
  ;; guest string pointer to its WASM address as usual.
  (func $class_name_key (param $guest i32) (result i32)
    (if (i32.lt_u (local.get $guest) (i32.const 0x10000))
      (then (return (local.get $guest))))
    (call $g2w (local.get $guest)))

  ;; Simple FNV-1a hash of NUL-terminated string at WASM addr
  (func $class_name_hash (param $wa i32) (result i32)
    (local $h i32) (local $ch i32)
    ;; If class name is a small integer (ATOM), return it directly
    (if (i32.lt_u (local.get $wa) (i32.const 0x10000))
      (then (return (local.get $wa))))
    (local.set $h (i32.const 0x811c9dc5))
    (block $done (loop $next
      (local.set $ch (i32.load8_u (local.get $wa)))
      (br_if $done (i32.eqz (local.get $ch)))
      ;; Lowercase
      (if (i32.and (i32.ge_u (local.get $ch) (i32.const 65))
                   (i32.le_u (local.get $ch) (i32.const 90)))
        (then (local.set $ch (i32.add (local.get $ch) (i32.const 32)))))
      (local.set $h (i32.mul (i32.xor (local.get $h) (local.get $ch)) (i32.const 0x01000193)))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1)))
      (br $next)))
    (local.get $h)
  )

  ;; Address of class record N: CLASS_RECORDS + slot * 48
  (func $class_record_addr (param $slot i32) (result i32)
    (i32.add (global.get $CLASS_RECORDS) (i32.mul (local.get $slot) (i32.const 48))))

  ;; Address of the embedded WNDCLASSA inside record N (record + 8)
  (func $class_wndclass_addr (param $slot i32) (result i32)
    (i32.add (call $class_record_addr (local.get $slot)) (i32.const 8)))

  ;; Allocate or find a class slot for $name_wa. Returns the class atom.
  ;; The caller is responsible for memcpy'ing the WNDCLASSA into
  ;; $class_wndclass_addr(slot) immediately afterwards.
  (func $class_table_register (param $name_wa i32) (result i32)
    (local $hash i32) (local $i i32) (local $ptr i32) (local $empty i32)
    (local.set $hash (call $class_name_hash (local.get $name_wa)))
    (local.set $empty (i32.const -1))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_CLASSES)))
      (local.set $ptr (call $class_record_addr (local.get $i)))
      ;; Existing class — return its atom (caller will overwrite WNDCLASSA via memcpy)
      (if (i32.eq (i32.load (local.get $ptr)) (local.get $hash))
        (then (return (i32.load offset=4 (local.get $ptr)))))
      ;; Track first empty
      (if (i32.and (i32.eqz (i32.load (local.get $ptr)))
                   (i32.eq (local.get $empty) (i32.const -1)))
        (then (local.set $empty (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    ;; Insert new class
    (if (i32.ne (local.get $empty) (i32.const -1))
      (then
        (local.set $ptr (call $class_record_addr (local.get $empty)))
        (i32.store (local.get $ptr) (local.get $hash))
        (global.set $class_atom_counter (i32.add (global.get $class_atom_counter) (i32.const 1)))
        (i32.store offset=4 (local.get $ptr) (global.get $class_atom_counter))
        (return (global.get $class_atom_counter))))
    (i32.const 0)
  )

  ;; Find class slot index by name hash; returns slot or -1
  (func $class_find_slot (param $name_wa i32) (result i32)
    (local $hash i32) (local $i i32) (local $ptr i32)
    (local.set $hash (call $class_name_hash (local.get $name_wa)))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_CLASSES)))
      (local.set $ptr (call $class_record_addr (local.get $i)))
      (if (i32.eq (i32.load (local.get $ptr)) (local.get $hash))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  ;; Look up wndproc by class name (WASM addr); returns 0 if not found.
  ;; Reads WNDCLASSA.lpfnWndProc which lives at record + 12.
  (func $class_table_lookup (param $name_wa i32) (result i32)
    (local $slot i32)
    (local.set $slot (call $class_find_slot (local.get $name_wa)))
    (if (i32.lt_s (local.get $slot) (i32.const 0))
      (then (return (i32.const 0))))
    (i32.load offset=12 (call $class_record_addr (local.get $slot)))
  )

  ;; ---- WAT-native WndProc dispatch ----
  ;; Called from DispatchMessageA/SendMessageA for WAT-native windows (wndproc >= 0xFFFF0000)
  ;; Dispatches to the correct WAT wndproc based on the ID encoded in the low bits
  (func $wat_wndproc_dispatch (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $wp i32)
    (local.set $wp (call $wnd_table_get (local.get $hwnd)))
    ;; 0xFFFF0002 = built-in control wndproc
    (if (i32.eq (local.get $wp) (global.get $WNDPROC_CTRL_NATIVE))
      (then (return (call $control_wndproc_dispatch (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; WM_NCPAINT / WM_NCCALCSIZE default chrome for WAT-native top-levels.
    ;; Help wndproc never overrides these so we take the default directly.
    (if (i32.eq (local.get $msg) (i32.const 0x0085))
      (then (call $defwndproc_do_ncpaint (local.get $hwnd)) (return (i32.const 0))))
    (if (i32.eq (local.get $msg) (i32.const 0x0083))
      (then (call $defwndproc_do_nccalcsize (local.get $hwnd)) (return (i32.const 0))))
    ;; 0xFFFF0001 = help wndproc
    (call $help_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam))
  )

  ;; ---- Help system ----

  ;; Scroll help window by delta pixels (positive = down, negative = up), clamp to 0
  (func $help_scroll_by (param $hwnd i32) (param $delta i32)
    (global.set $help_scroll_y (i32.add (global.get $help_scroll_y) (local.get $delta)))
    (if (i32.lt_s (global.get $help_scroll_y) (i32.const 0))
      (then (global.set $help_scroll_y (i32.const 0))))
    (call $invalidate_hwnd (local.get $hwnd)))

  ;; Help window WndProc (WAT-native, called directly — not via x86)
  (func $help_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $hdc i32) (local $y i32) (local $line_start i32) (local $line_len i32)
    (local $scan i32) (local $end i32) (local $ch i32) (local $vis_y i32)
    (local $click_y i32) (local $click_line i32)
    ;; WM_PAINT (0x000F): draw help text using GDI (window-relative)
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        ;; hdc = hwnd + 0x40000 (same encoding as BeginPaint)
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        ;; Set white background
        (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))  ;; OPAQUE
        (drop (call $host_gdi_set_bk_color (local.get $hdc) (i32.const 0xFFFFFF)))
        (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x000000)))
        ;; Fill client area white
        (drop (call $host_gdi_fill_rect (local.get $hdc)
          (i32.const 0) (i32.const 0) (i32.const 400) (i32.const 300)
          (i32.const 0x30010)))
        ;; Draw topic text line by line
        (if (global.get $help_topic_wa)
          (then
            (local.set $scan (global.get $help_topic_wa))
            (local.set $end (i32.add (global.get $help_topic_wa) (global.get $help_topic_len)))
            (local.set $y (i32.const 0))
            (local.set $line_start (local.get $scan))
            (block $text_done (loop $text_loop
              (if (i32.ge_u (local.get $scan) (local.get $end))
                (then
                  ;; Emit final line
                  (local.set $line_len (i32.sub (local.get $scan) (local.get $line_start)))
                  (if (i32.gt_u (local.get $line_len) (i32.const 0))
                    (then
                      (local.set $vis_y (i32.sub (i32.add (i32.const 8) (i32.mul (local.get $y) (i32.const 16))) (global.get $help_scroll_y)))
                      (if (i32.and (i32.ge_s (local.get $vis_y) (i32.const -16))
                                   (i32.lt_s (local.get $vis_y) (i32.const 270)))
                        (then
                          ;; On Contents page, draw topic lines in blue
                          (if (i32.and (i32.eqz (global.get $help_cur_topic))
                                       (i32.gt_u (local.get $y) (i32.const 0)))
                            (then (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0xFF0000)))))
                          (drop (call $host_gdi_text_out (local.get $hdc)
                            (i32.const 8) (local.get $vis_y)
                            (local.get $line_start) (local.get $line_len) (i32.const 0)))
                          (if (i32.and (i32.eqz (global.get $help_cur_topic))
                                       (i32.gt_u (local.get $y) (i32.const 0)))
                            (then (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x000000)))))))))
                  (br $text_done)))
              (local.set $ch (i32.load8_u (local.get $scan)))
              (if (i32.eq (local.get $ch) (i32.const 0x0A))
                (then
                  ;; Newline — emit line
                  (local.set $line_len (i32.sub (local.get $scan) (local.get $line_start)))
                  (local.set $vis_y (i32.sub (i32.add (i32.const 8) (i32.mul (local.get $y) (i32.const 16))) (global.get $help_scroll_y)))
                  (if (i32.and (i32.ge_s (local.get $vis_y) (i32.const -16))
                               (i32.lt_s (local.get $vis_y) (i32.const 270)))
                    (then
                      (if (i32.gt_u (local.get $line_len) (i32.const 0))
                        (then
                          ;; On Contents page, draw topic lines in blue
                          (if (i32.and (i32.eqz (global.get $help_cur_topic))
                                       (i32.gt_u (local.get $y) (i32.const 0)))
                            (then (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0xFF0000)))))
                          (drop (call $host_gdi_text_out (local.get $hdc)
                            (i32.const 8) (local.get $vis_y)
                            (local.get $line_start) (local.get $line_len) (i32.const 0)))
                          (if (i32.and (i32.eqz (global.get $help_cur_topic))
                                       (i32.gt_u (local.get $y) (i32.const 0)))
                            (then (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x000000)))))))))
                  (local.set $y (i32.add (local.get $y) (i32.const 1)))
                  (local.set $line_start (i32.add (local.get $scan) (i32.const 1)))))
              (local.set $scan (i32.add (local.get $scan) (i32.const 1)))
              (br $text_loop))))
          (else
            ;; No topic: draw placeholder
            (drop (call $host_gdi_text_out (local.get $hdc)
              (i32.const 8) (i32.const 8)
              (i32.const 0x108)  ;; "Help"
              (i32.const 4) (i32.const 0)))))
        ;; Draw nav bar at bottom (y=276)
        ;; Draw separator line
        (drop (call $host_gdi_fill_rect (local.get $hdc)
          (i32.const 0) (i32.const 272) (i32.const 400) (i32.const 273)
          (i32.const 0x30014))) ;; BLACK_BRUSH
        ;; "[Contents]" at 0x10C (10 chars)
        (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0xFF0000))) ;; blue (BGR)
        (drop (call $host_gdi_text_out (local.get $hdc)
          (i32.const 8) (i32.const 278) (i32.const 0x10C) (i32.const 10) (i32.const 0)))
        ;; "[Back]" at 0x117 (6 chars)
        (drop (call $host_gdi_text_out (local.get $hdc)
          (i32.const 100) (i32.const 278) (i32.const 0x117) (i32.const 6) (i32.const 0)))
        (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x000000)))
        (return (i32.const 0))))

    ;; WM_LBUTTONDOWN (0x0201)
    (if (i32.eq (local.get $msg) (i32.const 0x0201))
      (then
        ;; lParam: low word = x, high word = y
        (local.set $click_y (i32.shr_u (local.get $lParam) (i32.const 16)))
        ;; Nav bar click (y >= 270)
        (if (i32.ge_u (local.get $click_y) (i32.const 270))
          (then
            ;; Check x position: [Contents] at 8..90, [Back] at 100..150
            (if (i32.lt_u (i32.and (local.get $lParam) (i32.const 0xFFFF)) (i32.const 90))
              (then (call $help_navigate (i32.const 0)))
              (else (call $help_go_back)))
            (return (i32.const 0))))
        ;; On Contents page: click a topic line
        (if (i32.eqz (global.get $help_cur_topic))
          (then
            ;; Calculate which line was clicked
            (local.set $click_line (i32.div_u
              (i32.add (local.get $click_y) (i32.sub (global.get $help_scroll_y) (i32.const 8)))
              (i32.const 16)))
            ;; Line 0 is header, lines 1+ are topics
            (if (i32.and (i32.gt_u (local.get $click_line) (i32.const 0))
                         (i32.le_u (local.get $click_line) (global.get $help_topic_count)))
              (then
                (call $help_navigate (local.get $click_line))
                (return (i32.const 0))))))
        (return (i32.const 0))))

    ;; WM_KEYDOWN (0x0100)
    (if (i32.eq (local.get $msg) (i32.const 0x0100))
      (then
        ;; VK_UP (0x26): scroll up 16px
        (if (i32.eq (local.get $wParam) (i32.const 0x26))
          (then (call $help_scroll_by (local.get $hwnd) (i32.const -16)) (return (i32.const 0))))
        ;; VK_DOWN (0x28): scroll down 16px
        (if (i32.eq (local.get $wParam) (i32.const 0x28))
          (then (call $help_scroll_by (local.get $hwnd) (i32.const 16)) (return (i32.const 0))))
        ;; VK_PRIOR / Page Up (0x21)
        (if (i32.eq (local.get $wParam) (i32.const 0x21))
          (then (call $help_scroll_by (local.get $hwnd) (i32.const -200)) (return (i32.const 0))))
        ;; VK_NEXT / Page Down (0x22)
        (if (i32.eq (local.get $wParam) (i32.const 0x22))
          (then (call $help_scroll_by (local.get $hwnd) (i32.const 200)) (return (i32.const 0))))
        (return (i32.const 0))))

    ;; WM_CLOSE (0x0010)
    (if (i32.eq (local.get $msg) (i32.const 0x0010))
      (then
        (call $help_destroy)
        (return (i32.const 0))))
    ;; Default: return 0
    (i32.const 0)
  )

  ;; Load HLP file via host imports (JS parses, WAT receives text)
  (func $help_load_file (param $path_ga i32)
    (local $count i32) (local $len i32)
    ;; Allocate buffers: title (256), topic text (16KB), back stack (64 = 16 entries * 4)
    (if (i32.eqz (global.get $help_title_wa))
      (then
        (global.set $help_title_wa (call $g2w (call $heap_alloc (i32.const 256))))
        (global.set $help_topic_wa (call $g2w (call $heap_alloc (i32.const 0x4000))))
        (global.set $help_back_stack (call $g2w (call $heap_alloc (i32.const 64))))))
    ;; Call host to open and parse HLP
    (local.set $count (call $host_help_open (call $g2w (local.get $path_ga))))
    ;; -1 = file not ready, yield for async fetch
    (if (i32.eq (local.get $count) (i32.const -1))
      (then
        (global.set $yield_reason (i32.const 4))
        (return)))
    (if (i32.le_s (local.get $count) (i32.const 0))
      (then (return)))
    (global.set $help_topic_count (local.get $count))
    ;; Get title
    (local.set $len (call $host_help_get_title (global.get $help_title_wa) (i32.const 255)))
    (global.set $help_title_len (local.get $len))
    ;; Load Contents page (index 0)
    (local.set $len (call $host_help_get_topic (i32.const 0) (global.get $help_topic_wa) (i32.const 0x3FFF)))
    (global.set $help_topic_len (local.get $len))
    (global.set $help_cur_topic (i32.const 0))
    (global.set $help_scroll_y (i32.const 0))
    (global.set $help_back_count (i32.const 0))
  )

  ;; Navigate to topic by index (0=Contents, 1..N=topics)
  (func $help_navigate (param $index i32)
    (local $len i32) (local $stack_ptr i32)
    ;; Push current topic to back stack (max 16)
    (if (i32.lt_u (global.get $help_back_count) (i32.const 16))
      (then
        (local.set $stack_ptr (i32.add (global.get $help_back_stack)
          (i32.shl (global.get $help_back_count) (i32.const 2))))
        (i32.store (local.get $stack_ptr) (global.get $help_cur_topic))
        (global.set $help_back_count (i32.add (global.get $help_back_count) (i32.const 1)))))
    ;; Load topic
    (local.set $len (call $host_help_get_topic (local.get $index) (global.get $help_topic_wa) (i32.const 0x3FFF)))
    (global.set $help_topic_len (local.get $len))
    (global.set $help_cur_topic (local.get $index))
    (global.set $help_scroll_y (i32.const 0))
    (call $invalidate_hwnd (global.get $help_hwnd))
  )

  ;; Go back in navigation history
  (func $help_go_back
    (local $len i32) (local $prev i32) (local $stack_ptr i32)
    (if (i32.eqz (global.get $help_back_count))
      (then (return)))
    ;; Pop from back stack
    (global.set $help_back_count (i32.sub (global.get $help_back_count) (i32.const 1)))
    (local.set $stack_ptr (i32.add (global.get $help_back_stack)
      (i32.shl (global.get $help_back_count) (i32.const 2))))
    (local.set $prev (i32.load (local.get $stack_ptr)))
    ;; Load that topic
    (local.set $len (call $host_help_get_topic (local.get $prev) (global.get $help_topic_wa) (i32.const 0x3FFF)))
    (global.set $help_topic_len (local.get $len))
    (global.set $help_cur_topic (local.get $prev))
    (global.set $help_scroll_y (i32.const 0))
    (call $invalidate_hwnd (global.get $help_hwnd))
  )

  ;; Create help window via host
  (func $help_create_window
    (local $title_wa i32) (local $hwnd i32)
    ;; Use parsed title or fallback
    (if (i32.and (i32.ne (global.get $help_title_wa) (i32.const 0)) (i32.ne (global.get $help_title_len) (i32.const 0)))
      (then (local.set $title_wa (global.get $help_title_wa)))
      (else (local.set $title_wa (i32.const 0x108)))) ;; "Help"
    ;; Allocate hwnd
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    ;; Create via host: style=WS_OVERLAPPEDWINDOW|WS_VISIBLE (0x10CF0000)
    (drop (call $host_create_window
      (local.get $hwnd)
      (i32.const 0x10CF0000)  ;; WS_OVERLAPPEDWINDOW | WS_VISIBLE
      (i32.const 100)         ;; x
      (i32.const 50)          ;; y
      (i32.const 400)         ;; cx
      (i32.const 300)         ;; cy
      (local.get $title_wa)   ;; title (WASM addr)
      (i32.const 0)))         ;; no menu
    ;; Register in window table as WAT-native (wndproc = 0xFFFF0001)
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_WAT_NATIVE))
    (global.set $help_hwnd (local.get $hwnd))
    ;; Trigger immediate paint so content shows right away
    (drop (call $help_wndproc (local.get $hwnd) (i32.const 0x000F) (i32.const 0) (i32.const 0)))
  )

  ;; Destroy help window and clean up
  (func $help_destroy
    (if (global.get $help_hwnd)
      (then
        (call $wnd_table_remove (global.get $help_hwnd))
        (global.set $help_hwnd (i32.const 0))
        (global.set $help_topic_wa (i32.const 0))
        (global.set $help_topic_len (i32.const 0))
        (global.set $help_title_wa (i32.const 0))
        (global.set $help_title_len (i32.const 0))
        (global.set $help_topic_count (i32.const 0))
        (global.set $help_cur_topic (i32.const 0))
        (global.set $help_scroll_y (i32.const 0))
        (global.set $help_back_count (i32.const 0))))
  )
