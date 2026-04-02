  ;; ============================================================
  ;; WINDOW TABLE + HELP SYSTEM
  ;; ============================================================
  ;; Window table at WASM 0x2000: maps hwnd → wndproc (max 32 entries)
  ;; Each entry: [hwnd:i32, wndproc:i32] = 8 bytes, total 256 bytes
  ;; wndproc = guest VA for x86 wndproc, or 0xFFFFxxxx for WAT-native
  ;;
  ;; Class table at WASM 0x2100: maps class_name_hash → wndproc (max 16 entries)
  ;; Each entry: [name_hash:i32, wndproc:i32, extra_bytes:i32] = 12 bytes, total 192 bytes
  ;;
  ;; Parent table at WASM 0x2200: maps slot index → parent hwnd (max 32 entries)
  ;; Each entry: [parent_hwnd:i32] = 4 bytes, total 128 bytes

  ;; ---- Window table helpers ----

  ;; Add or update hwnd→wndproc mapping
  (func $wnd_table_set (param $hwnd i32) (param $wndproc i32)
    (local $i i32) (local $ptr i32) (local $empty i32)
    (local.set $empty (i32.const -1))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (i32.const 32)))
      (local.set $ptr (i32.add (i32.const 0x2000) (i32.mul (local.get $i) (i32.const 8))))
      ;; Update existing entry
      (if (i32.eq (i32.load (local.get $ptr)) (local.get $hwnd))
        (then (i32.store offset=4 (local.get $ptr) (local.get $wndproc)) (return)))
      ;; Track first empty slot
      (if (i32.and (i32.eqz (i32.load (local.get $ptr)))
                   (i32.eq (local.get $empty) (i32.const -1)))
        (then (local.set $empty (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    ;; Insert in empty slot
    (if (i32.ne (local.get $empty) (i32.const -1))
      (then
        (local.set $ptr (i32.add (i32.const 0x2000) (i32.mul (local.get $empty) (i32.const 8))))
        (i32.store (local.get $ptr) (local.get $hwnd))
        (i32.store offset=4 (local.get $ptr) (local.get $wndproc))))
  )

  ;; Look up wndproc for hwnd; returns 0 if not found
  (func $wnd_table_get (param $hwnd i32) (result i32)
    (local $i i32) (local $ptr i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (i32.const 32)))
      (local.set $ptr (i32.add (i32.const 0x2000) (i32.mul (local.get $i) (i32.const 8))))
      (if (i32.eq (i32.load (local.get $ptr)) (local.get $hwnd))
        (then (return (i32.load offset=4 (local.get $ptr)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0)
  )

  ;; Remove hwnd from window table
  (func $wnd_table_remove (param $hwnd i32)
    (local $i i32) (local $ptr i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (i32.const 32)))
      (local.set $ptr (i32.add (i32.const 0x2000) (i32.mul (local.get $i) (i32.const 8))))
      (if (i32.eq (i32.load (local.get $ptr)) (local.get $hwnd))
        (then
          (i32.store (local.get $ptr) (i32.const 0))
          (i32.store offset=4 (local.get $ptr) (i32.const 0))
          (return)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
  )

  ;; Find window table slot index for hwnd; returns -1 if not found
  (func $wnd_table_find (param $hwnd i32) (result i32)
    (local $i i32) (local $ptr i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (i32.const 32)))
      (local.set $ptr (i32.add (i32.const 0x2000) (i32.mul (local.get $i) (i32.const 8))))
      (if (i32.eq (i32.load (local.get $ptr)) (local.get $hwnd))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1)
  )

  ;; Get per-window userdata (GWL_USERDATA table at 0x2200)
  (func $wnd_get_userdata (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load (i32.add (i32.const 0x2200) (i32.shl (local.get $idx) (i32.const 2))))
  )

  ;; Set per-window userdata; returns old value
  (func $wnd_set_userdata (param $hwnd i32) (param $value i32) (result i32)
    (local $idx i32) (local $ptr i32) (local $old i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (local.set $ptr (i32.add (i32.const 0x2200) (i32.shl (local.get $idx) (i32.const 2))))
    (local.set $old (i32.load (local.get $ptr)))
    (i32.store (local.get $ptr) (local.get $value))
    (local.get $old)
  )

  ;; Get parent hwnd (parent table at 0x2280)
  (func $wnd_get_parent (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load (i32.add (i32.const 0x2280) (i32.shl (local.get $idx) (i32.const 2))))
  )

  ;; Set parent hwnd for a window
  (func $wnd_set_parent (param $hwnd i32) (param $parent i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.ne (local.get $idx) (i32.const -1))
      (then
        (i32.store (i32.add (i32.const 0x2280) (i32.shl (local.get $idx) (i32.const 2))) (local.get $parent))))
  )

  ;; ---- Class table helpers ----
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

  ;; Register class: store name_hash→wndproc; returns atom
  (func $class_table_register (param $name_wa i32) (param $wndproc i32) (result i32)
    (local $hash i32) (local $i i32) (local $ptr i32) (local $empty i32)
    (local.set $hash (call $class_name_hash (local.get $name_wa)))
    (local.set $empty (i32.const -1))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (i32.const 16)))
      (local.set $ptr (i32.add (i32.const 0x2100) (i32.mul (local.get $i) (i32.const 12))))
      ;; Update existing class
      (if (i32.eq (i32.load (local.get $ptr)) (local.get $hash))
        (then
          (i32.store offset=4 (local.get $ptr) (local.get $wndproc))
          (return (i32.load offset=8 (local.get $ptr)))))
      ;; Track first empty
      (if (i32.and (i32.eqz (i32.load (local.get $ptr)))
                   (i32.eq (local.get $empty) (i32.const -1)))
        (then (local.set $empty (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    ;; Insert new class
    (if (i32.ne (local.get $empty) (i32.const -1))
      (then
        (local.set $ptr (i32.add (i32.const 0x2100) (i32.mul (local.get $empty) (i32.const 12))))
        (i32.store (local.get $ptr) (local.get $hash))
        (i32.store offset=4 (local.get $ptr) (local.get $wndproc))
        (global.set $class_atom_counter (i32.add (global.get $class_atom_counter) (i32.const 1)))
        (i32.store offset=8 (local.get $ptr) (global.get $class_atom_counter))
        (return (global.get $class_atom_counter))))
    (i32.const 0)
  )

  ;; Look up wndproc by class name (WASM addr); returns 0 if not found
  (func $class_table_lookup (param $name_wa i32) (result i32)
    (local $hash i32) (local $i i32) (local $ptr i32)
    (local.set $hash (call $class_name_hash (local.get $name_wa)))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (i32.const 16)))
      (local.set $ptr (i32.add (i32.const 0x2100) (i32.mul (local.get $i) (i32.const 12))))
      (if (i32.eq (i32.load (local.get $ptr)) (local.get $hash))
        (then (return (i32.load offset=4 (local.get $ptr)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0)
  )

  ;; ---- WAT-native WndProc dispatch ----
  ;; Called from DispatchMessageA/SendMessageA for WAT-native windows (wndproc >= 0xFFFF0000)
  ;; Dispatches to the correct WAT wndproc based on the ID encoded in the low bits
  (func $wat_wndproc_dispatch (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    ;; Currently only ID 1 = help wndproc
    (call $help_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam))
  )

  ;; ---- Help system ----

  ;; Help window WndProc (WAT-native, called directly — not via x86)
  (func $help_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $hdc i32)
    ;; WM_PAINT (0x000F): draw help text using GDI (window-relative)
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        ;; hdc = hwnd + 0x40000 (same encoding as BeginPaint)
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        ;; Set white background
        (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))  ;; OPAQUE
        (drop (call $host_gdi_set_bk_color (local.get $hdc) (i32.const 0xFFFFFF)))  ;; white
        (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x000000))) ;; black
        ;; Fill client area white (stock WHITE_BRUSH = 0x30010)
        (drop (call $host_gdi_fill_rect (local.get $hdc)
          (i32.const 0) (i32.const 0) (i32.const 400) (i32.const 300)
          (i32.const 0x30010)))
        ;; Draw help text
        (if (global.get $help_topic_wa)
          (then
            (drop (call $host_gdi_text_out (local.get $hdc)
              (i32.const 8) (i32.const 8)
              (global.get $help_topic_wa)
              (global.get $help_topic_len))))
          (else
            ;; No topic: draw placeholder
            (drop (call $host_gdi_text_out (local.get $hdc)
              (i32.const 8) (i32.const 8)
              (i32.const 0x108)  ;; WASM addr of "Help" string
              (i32.const 4)))))
        (return (i32.const 0))))
    ;; WM_CLOSE (0x0010)
    (if (i32.eq (local.get $msg) (i32.const 0x0010))
      (then
        (call $help_destroy)
        (return (i32.const 0))))
    ;; Default: return 0
    (i32.const 0)
  )

  ;; Load HLP file into guest memory via host import
  (func $help_load_file (param $path_ga i32)
    (local $buf_ga i32) (local $bytes_read i32)
    ;; Allocate buffer in guest heap for HLP data (64KB max)
    (local.set $buf_ga (call $heap_alloc (i32.const 0x10000)))
    (local.set $bytes_read (call $host_read_file
      (call $g2w (local.get $path_ga))   ;; path (WASM addr of NUL-terminated string)
      (call $g2w (local.get $buf_ga))    ;; dest buffer (WASM addr)
      (i32.const 0x10000)))              ;; max bytes
    (if (i32.gt_s (local.get $bytes_read) (i32.const 0))
      (then
        (global.set $help_file_wa (call $g2w (local.get $buf_ga)))
        (global.set $help_file_len (local.get $bytes_read))
        ;; Try to parse HLP and extract first topic
        (call $hlp_parse)))
  )

  ;; Parse HLP file: extract title and first topic text
  (func $hlp_parse
    (local $magic i32) (local $dir_off i32) (local $dir_wa i32)
    (local $dir_magic i32) (local $page_size i32) (local $num_pages i32)
    (local $page_wa i32) (local $num_entries i32) (local $entry_wa i32)
    (local $i i32) (local $name_wa i32) (local $file_off i32)
    (local $topic_wa i32) (local $topic_len i32)
    (local $sys_wa i32) (local $sys_len i32)
    (local $ch i32)
    ;; Check magic
    (local.set $magic (i32.load (global.get $help_file_wa)))
    (if (i32.ne (local.get $magic) (i32.const 0x00035F3F))
      (then (return)))  ;; Not a valid HLP file
    ;; Get directory offset; skip 9-byte internal file header to reach B+tree
    (local.set $dir_off (i32.load offset=4 (global.get $help_file_wa)))
    (local.set $dir_wa (i32.add (global.get $help_file_wa) (i32.add (local.get $dir_off) (i32.const 9))))
    ;; B+tree header: magic(u16), flags(u16), pageSize(u16), format(NUL-term), ...
    (local.set $dir_magic (i32.load16_u (local.get $dir_wa)))
    (if (i32.ne (local.get $dir_magic) (i32.const 0x293B))
      (then (return)))
    (local.set $page_size (i32.load16_u offset=4 (local.get $dir_wa)))
    ;; Skip B+tree header: magic(2)+flags(2)+pageSize(2)+format(NUL-term)+14 bytes
    ;; Scan past format string starting at +6
    (local.set $entry_wa (i32.add (local.get $dir_wa) (i32.const 6)))
    (block $fmt_end (loop $fmt_scan
      (br_if $fmt_end (i32.eqz (i32.load8_u (local.get $entry_wa))))
      (local.set $entry_wa (i32.add (local.get $entry_wa) (i32.const 1)))
      (br $fmt_scan)))
    (local.set $entry_wa (i32.add (local.get $entry_wa) (i32.const 1))) ;; skip NUL
    ;; After format: first(2)+last(2)+unused(2)+totalPages(2)+nLevels(2)+totalEntries(4)=14
    (local.set $num_pages (i32.load16_u offset=6 (local.get $entry_wa))) ;; totalPages at +6
    (if (i32.eqz (local.get $num_pages)) (then (local.set $num_pages (i32.const 1))))
    (local.set $page_wa (i32.add (local.get $entry_wa) (i32.const 14))) ;; first page
    ;; Scan leaf pages for |SYSTEM and |TOPIC entries
    (local.set $i (i32.const 0))
    (block $pages_done (loop $page_loop
      (br_if $pages_done (i32.ge_u (local.get $i) (local.get $num_pages)))
      ;; Leaf page: unused(u16), nEntries(u16), prevPage(i16), nextPage(i16)
      (local.set $num_entries (i32.load16_u offset=2 (local.get $page_wa)))
      (local.set $entry_wa (i32.add (local.get $page_wa) (i32.const 8)))
      ;; Walk entries: each is NUL-terminated filename + u32 offset
      (block $entries_done
        (loop $entry_loop
          (br_if $entries_done (i32.le_s (local.get $num_entries) (i32.const 0)))
          (local.set $name_wa (local.get $entry_wa))
          ;; Skip past NUL-terminated name
          (block $name_end (loop $skip_name
            (br_if $name_end (i32.eqz (i32.load8_u (local.get $entry_wa))))
            (local.set $entry_wa (i32.add (local.get $entry_wa) (i32.const 1)))
            (br $skip_name)))
          (local.set $entry_wa (i32.add (local.get $entry_wa) (i32.const 1))) ;; skip NUL
          ;; Read file offset (u32)
          (local.set $file_off (i32.load (local.get $entry_wa)))
          (local.set $entry_wa (i32.add (local.get $entry_wa) (i32.const 4)))
          ;; Check for |SYSTEM (starts with '|S')
          (if (i32.and
                (i32.eq (i32.load8_u (local.get $name_wa)) (i32.const 0x7C))
                (i32.eq (i32.load8_u (i32.add (local.get $name_wa) (i32.const 1))) (i32.const 0x53)))
            (then
              (local.set $sys_wa (i32.add (global.get $help_file_wa) (local.get $file_off)))
              (call $hlp_parse_system (local.get $sys_wa))))
          ;; Check for |TOPIC (starts with '|T')
          (if (i32.and
                (i32.eq (i32.load8_u (local.get $name_wa)) (i32.const 0x7C))
                (i32.eq (i32.load8_u (i32.add (local.get $name_wa) (i32.const 1))) (i32.const 0x54)))
            (then
              (local.set $topic_wa (i32.add (global.get $help_file_wa) (local.get $file_off)))
              (call $hlp_parse_topic (local.get $topic_wa))))
          (local.set $num_entries (i32.sub (local.get $num_entries) (i32.const 1)))
          (br $entry_loop)))
      ;; Advance to next page
      (local.set $page_wa (i32.add (local.get $page_wa) (local.get $page_size)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $page_loop)))
  )

  ;; Parse |SYSTEM internal file to extract title
  (func $hlp_parse_system (param $wa i32)
    (local $magic i32) (local $rec_wa i32) (local $rec_type i32) (local $rec_size i32)
    (local $end_wa i32) (local $title_wa i32) (local $title_len i32)
    ;; Internal file header: 9 bytes (usedSpace:u32, allocSpace:u32, flags:u8)
    ;; Then |SYSTEM header: magic(u16=0x036C), minor(u16), flags(u16), GenDate(u32)
    ;; Then tagged records (type:u16, size:u16, data)
    (local.set $wa (i32.add (local.get $wa) (i32.const 9))) ;; skip internal file header
    (local.set $magic (i32.load16_u (local.get $wa)))
    (if (i32.ne (local.get $magic) (i32.const 0x036C))
      (then (return)))
    ;; Skip system header: magic(2) + minor(2) + flags(2) + GenDate(4) = 10 bytes
    (local.set $rec_wa (i32.add (local.get $wa) (i32.const 10)))
    ;; Scan tagged records (up to 256 bytes)
    (local.set $end_wa (i32.add (local.get $rec_wa) (i32.const 256)))
    (block $done (loop $rec_loop
      (br_if $done (i32.ge_u (local.get $rec_wa) (local.get $end_wa)))
      (local.set $rec_type (i32.load16_u (local.get $rec_wa)))
      (local.set $rec_size (i32.load16_u offset=2 (local.get $rec_wa)))
      (if (i32.eqz (local.get $rec_size)) (then (return)))
      ;; Type 1 = title string
      (if (i32.eq (local.get $rec_type) (i32.const 1))
        (then
          (global.set $help_title_wa (i32.add (local.get $rec_wa) (i32.const 4)))
          (global.set $help_title_len (i32.sub (local.get $rec_size) (i32.const 1))) ;; exclude NUL
          (return)))
      (local.set $rec_wa (i32.add (local.get $rec_wa) (i32.add (local.get $rec_size) (i32.const 4))))
      (br $rec_loop)))
  )

  ;; Parse |TOPIC internal file — extract first topic's text
  (func $hlp_parse_topic (param $wa i32)
    (local $block_wa i32) (local $data_wa i32) (local $scan_wa i32)
    (local $end_wa i32) (local $dst_wa i32) (local $ch i32) (local $len i32)
    ;; Internal file header: 9 bytes
    (local.set $block_wa (i32.add (local.get $wa) (i32.const 9)))
    ;; Topic block header: next(u32), prev(u32), topic_off(u32) = 12 bytes
    ;; After header comes topic data — paragraphs with formatting
    (local.set $data_wa (i32.add (local.get $block_wa) (i32.const 12)))
    ;; Allocate output buffer for clean text (4KB)
    (local.set $dst_wa (call $heap_alloc (i32.const 4096)))
    (global.set $help_topic_wa (call $g2w (local.get $dst_wa)))
    ;; Scan topic data, extracting printable ASCII text
    ;; Topic format is complex (formatting codes etc.), so we do a simple extraction:
    ;; skip bytes < 0x20 (control codes), keep 0x20-0x7E (printable ASCII)
    (local.set $scan_wa (local.get $data_wa))
    (local.set $end_wa (i32.add (local.get $scan_wa) (i32.const 2048))) ;; scan up to 2KB
    (local.set $len (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $scan_wa) (local.get $end_wa)))
      (br_if $done (i32.ge_u (local.get $len) (i32.const 4000))) ;; don't overflow buffer
      (local.set $ch (i32.load8_u (local.get $scan_wa)))
      ;; Keep printable ASCII (0x20-0x7E) and newlines (0x0A, 0x0D)
      (if (i32.or
            (i32.and (i32.ge_u (local.get $ch) (i32.const 0x20))
                     (i32.le_u (local.get $ch) (i32.const 0x7E)))
            (i32.or (i32.eq (local.get $ch) (i32.const 0x0A))
                    (i32.eq (local.get $ch) (i32.const 0x0D))))
        (then
          (i32.store8 (i32.add (global.get $help_topic_wa) (local.get $len)) (local.get $ch))
          (local.set $len (i32.add (local.get $len) (i32.const 1)))))
      (local.set $scan_wa (i32.add (local.get $scan_wa) (i32.const 1)))
      (br $scan)))
    ;; NUL-terminate
    (i32.store8 (i32.add (global.get $help_topic_wa) (local.get $len)) (i32.const 0))
    (global.set $help_topic_len (local.get $len))
  )

  ;; Create help window via host
  (func $help_create_window
    (local $title_wa i32) (local $hwnd i32)
    ;; Use parsed title or fallback
    (if (global.get $help_title_wa)
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
    (call $wnd_table_set (local.get $hwnd) (i32.const 0xFFFF0001))
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
        (global.set $help_file_wa (i32.const 0))
        (global.set $help_file_len (i32.const 0))
        (global.set $help_topic_wa (i32.const 0))
        (global.set $help_topic_len (i32.const 0))
        (global.set $help_title_wa (i32.const 0))
        (global.set $help_title_len (i32.const 0))))
  )
