  ;; ============================================================
  ;; CONSOLE API HANDLERS
  ;; ============================================================

  ;; The PE loader owns low staging memory, so keep mutable console-title state
  ;; beside the shared console records rather than in the overwritten 0x11xxx
  ;; system-string area. This 128-byte run ends before the DIB page allocator.
  (global $CONSOLE_TITLE_STORAGE i32 (region.addr $CONSOLE_INPUT 0x00000A00))
  (data (region.addr $CONSOLE_INPUT 0xA00) "Console\00")

  (func $console_title_ensure
    ;; load_pe clears mutable high-memory tables after WebAssembly data
    ;; initialization. Restore the default title on first console use.
    (if (i32.eqz (i32.load8_u (global.get $CONSOLE_TITLE_STORAGE)))
      (then (i64.store (global.get $CONSOLE_TITLE_STORAGE)
        (i64.const 0x00656c6f736e6f43))))) ;; "Console\0", little-endian

  ;; DuplicateHandle must create a distinct process handle, not merely copy the
  ;; small GetStdHandle number. Standard-console aliases live in shared memory
  ;; so a handle created by one browser Worker is valid in every guest thread.
  ;; The complete token is stored in the slot: a closed generation therefore
  ;; stays invalid even after that slot is reused.
  (func $console_handle_resolve (param $handle i32) (result i32)
    (local $slot i32) (local $rec i32)
    (if (i32.ne (i32.and (local.get $handle) (i32.const 0xFFFF0000))
                (global.get $CONSOLE_HANDLE_TAG))
      (then (return (local.get $handle))))
    (local.set $slot (i32.and (local.get $handle) (i32.const 31)))
    (if (i32.ge_u (local.get $slot) (global.get $CONSOLE_HANDLE_COUNT))
      (then (return (i32.const 0))))
    (local.set $rec (i32.add (global.get $CONSOLE_HANDLE_TABLE)
      (i32.mul (local.get $slot) (global.get $CONSOLE_HANDLE_STRIDE))))
    (if (i32.ne (i32.atomic.load (local.get $rec)) (local.get $handle))
      (then (return (i32.const 0))))
    (i32.atomic.load offset=4 (local.get $rec)))

  (func $console_handle_duplicate (param $handle i32) (result i32)
    (local $canonical i32) (local $slot i32) (local $rec i32)
    (local $generation i32) (local $token i32)
    (local.set $canonical (call $console_handle_resolve (local.get $handle)))
    (if (i32.or (i32.lt_u (local.get $canonical) (i32.const 1))
                (i32.gt_u (local.get $canonical) (i32.const 3)))
      (then (return (i32.const 0))))
    (local.set $generation
      (i32.add
        (i32.atomic.rmw.add
          (i32.add (global.get $CONSOLE_HANDLE_TABLE) (i32.const 248))
          (i32.const 1))
        (i32.const 1)))
    (local.set $slot (i32.const 0))
    (block $full (loop $scan
      (br_if $full (i32.ge_u (local.get $slot) (global.get $CONSOLE_HANDLE_COUNT)))
      (local.set $rec (i32.add (global.get $CONSOLE_HANDLE_TABLE)
        (i32.mul (local.get $slot) (global.get $CONSOLE_HANDLE_STRIDE))))
      ;; -1 is an unpublished reservation. Store the canonical stream only
      ;; after winning the slot, then publish the complete token atomically.
      (if (i32.eqz
            (i32.atomic.rmw.cmpxchg (local.get $rec)
              (i32.const 0) (i32.const -1)))
        (then
          (i32.atomic.store offset=4 (local.get $rec) (local.get $canonical))
          (local.set $token
            (i32.or (global.get $CONSOLE_HANDLE_TAG)
              (i32.or
                (i32.shl (i32.and (local.get $generation) (i32.const 0x7ff))
                  (i32.const 5))
                (local.get $slot))))
          (i32.atomic.store (local.get $rec) (local.get $token))
          (return (local.get $token))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; -1 is not an alias, 0 is a stale alias, 1 closes this alias only.
  (func $console_handle_close (param $handle i32) (result i32)
    (local $slot i32) (local $rec i32)
    (if (i32.ne (i32.and (local.get $handle) (i32.const 0xFFFF0000))
                (global.get $CONSOLE_HANDLE_TAG))
      (then (return (i32.const -1))))
    (local.set $slot (i32.and (local.get $handle) (i32.const 31)))
    (if (i32.ge_u (local.get $slot) (global.get $CONSOLE_HANDLE_COUNT))
      (then (return (i32.const 0))))
    (local.set $rec (i32.add (global.get $CONSOLE_HANDLE_TABLE)
      (i32.mul (local.get $slot) (global.get $CONSOLE_HANDLE_STRIDE))))
    (if (i32.ne
          (i32.atomic.rmw.cmpxchg (local.get $rec)
            (local.get $handle) (i32.const -1))
          (local.get $handle))
      (then (return (i32.const 0))))
    (i32.atomic.store offset=4 (local.get $rec) (i32.const 0))
    (i32.atomic.store (local.get $rec) (i32.const 0))
    (i32.const 1))

  ;; Shared screen-buffer record:
  ;;   +0 magic, +4 backing guest allocation (0 for the original buffer),
  ;;   +8 text WA, +12 attributes WA, +16 width, +20 height,
  ;;   +24/+28 cursor x/y, +32 current attribute, +36 cursor size,
  ;;   +40 cursor visible, +44 cells initialized.
  ;; Eight corresponding 8-byte SMALL_RECT viewports occupy the exact 64-byte
  ;; gap immediately after this table and before $CONSOLE_TITLE_STORAGE. The
  ;; derived address remains inside CONSOLE_INPUT's audited owning region.
  (func $console_buffer_window_record (param $rec i32) (result i32)
    (i32.add
      (i32.add (global.get $CONSOLE_BUFFER_TABLE)
        (i32.mul (global.get $CONSOLE_BUFFER_STRIDE)
          (global.get $CONSOLE_BUFFER_COUNT)))
      (i32.mul
        (i32.div_u
          (i32.sub (local.get $rec) (global.get $CONSOLE_BUFFER_TABLE))
          (global.get $CONSOLE_BUFFER_STRIDE))
        (i32.const 8))))

  (func $console_loaded_window_record (result i32)
    (call $console_buffer_window_record
      (call $console_buffer_record (global.get $console_loaded_handle))))

  (func $console_window_width (result i32)
    (local $win i32)
    (local.set $win (call $console_loaded_window_record))
    (i32.add
      (i32.sub (i32.load16_s offset=4 (local.get $win))
               (i32.load16_s (local.get $win)))
      (i32.const 1)))

  (func $console_window_height (result i32)
    (local $win i32)
    (local.set $win (call $console_loaded_window_record))
    (i32.add
      (i32.sub (i32.load16_s offset=6 (local.get $win))
               (i32.load16_s offset=2 (local.get $win)))
      (i32.const 1)))

  (func $console_buffers_init
    (local $rec i32) (local $win i32)
    (local.set $rec (global.get $CONSOLE_BUFFER_TABLE))
    (if (i32.eq (i32.load (local.get $rec)) (global.get $CONSOLE_BUFFER_MAGIC))
      (then (return)))
    (memory.fill (global.get $CONSOLE_BUFFER_TABLE) (i32.const 0)
      (i32.mul (global.get $CONSOLE_BUFFER_STRIDE) (global.get $CONSOLE_BUFFER_COUNT)))
    (memory.fill
      (i32.add (global.get $CONSOLE_BUFFER_TABLE)
        (i32.mul (global.get $CONSOLE_BUFFER_STRIDE)
          (global.get $CONSOLE_BUFFER_COUNT)))
      (i32.const 0) (i32.mul (i32.const 8) (global.get $CONSOLE_BUFFER_COUNT)))
    (i32.store (local.get $rec) (global.get $CONSOLE_BUFFER_MAGIC))
    (i32.store offset=8 (local.get $rec) (global.get $CONSOLE_TEXT))
    (i32.store offset=12 (local.get $rec) (global.get $CONSOLE_ATTR))
    (i32.store offset=16 (local.get $rec) (i32.const 80))
    (i32.store offset=20 (local.get $rec) (i32.const 25))
    (i32.store offset=32 (local.get $rec) (i32.const 7))
    (i32.store offset=36 (local.get $rec) (i32.const 25))
    (i32.store offset=40 (local.get $rec) (i32.const 1))
    (local.set $win (call $console_buffer_window_record (local.get $rec)))
    (i32.store16 offset=4 (local.get $win) (i32.const 79))
    (i32.store16 offset=6 (local.get $win) (i32.const 24))
    (i32.store (global.get $CONSOLE_BUFFER_ACTIVE) (i32.const 0x00030001)))

  ;; Resolve stdout/stderr and the original screen-buffer handle to slot zero;
  ;; private CreateConsoleScreenBuffer handles encode slots 1..7.
  (func $console_buffer_record (param $handle i32) (result i32)
    (local $slot i32) (local $rec i32)
    (local.set $handle (call $console_handle_resolve (local.get $handle)))
    (call $console_buffers_init)
    (if (i32.or (i32.eq (local.get $handle) (i32.const 2))
          (i32.or (i32.eq (local.get $handle) (i32.const 3))
            (i32.eq (local.get $handle) (i32.const 0x00030001))))
      (then (return (global.get $CONSOLE_BUFFER_TABLE))))
    (if (i32.ne (i32.and (local.get $handle) (i32.const 0xFFFF0000))
                (global.get $CONSOLE_BUFFER_HANDLE_TAG))
      (then (return (i32.const 0))))
    (local.set $slot (i32.and (local.get $handle) (i32.const 0xFFFF)))
    (if (i32.or (i32.eqz (local.get $slot))
          (i32.ge_u (local.get $slot) (global.get $CONSOLE_BUFFER_COUNT)))
      (then (return (i32.const 0))))
    (local.set $rec (i32.add (global.get $CONSOLE_BUFFER_TABLE)
      (i32.mul (local.get $slot) (global.get $CONSOLE_BUFFER_STRIDE))))
    (if (i32.ne (i32.load (local.get $rec)) (global.get $CONSOLE_BUFFER_MAGIC))
      (then (return (i32.const 0))))
    (local.get $rec))

  (func $console_buffer_save_loaded
    (local $rec i32)
    (local.set $rec (call $console_buffer_record (global.get $console_loaded_handle)))
    (if (i32.eqz (local.get $rec)) (then (return)))
    (i32.store offset=8 (local.get $rec) (global.get $console_text_base))
    (i32.store offset=12 (local.get $rec) (global.get $console_attr_base))
    (i32.store offset=16 (local.get $rec) (global.get $console_width))
    (i32.store offset=20 (local.get $rec) (global.get $console_height))
    (i32.store offset=24 (local.get $rec) (global.get $console_cursor_x))
    (i32.store offset=28 (local.get $rec) (global.get $console_cursor_y))
    (i32.store offset=32 (local.get $rec) (global.get $console_attr))
    (i32.store offset=36 (local.get $rec) (global.get $console_cursor_size))
    (i32.store offset=40 (local.get $rec) (global.get $console_cursor_visible))
    (i32.store offset=44 (local.get $rec) (global.get $console_cells_ready)))

  (func $console_buffer_load (param $handle i32) (result i32)
    (local $rec i32)
    (local.set $rec (call $console_buffer_record (local.get $handle)))
    (if (i32.eqz (local.get $rec)) (then (return (i32.const 0))))
    (global.set $console_loaded_handle (local.get $handle))
    (global.set $console_text_base (i32.load offset=8 (local.get $rec)))
    (global.set $console_attr_base (i32.load offset=12 (local.get $rec)))
    (global.set $console_width (i32.load offset=16 (local.get $rec)))
    (global.set $console_height (i32.load offset=20 (local.get $rec)))
    (global.set $console_cursor_x (i32.load offset=24 (local.get $rec)))
    (global.set $console_cursor_y (i32.load offset=28 (local.get $rec)))
    (global.set $console_attr (i32.load offset=32 (local.get $rec)))
    (global.set $console_cursor_size (i32.load offset=36 (local.get $rec)))
    (global.set $console_cursor_visible (i32.load offset=40 (local.get $rec)))
    (global.set $console_cells_ready (i32.load offset=44 (local.get $rec)))
    (i32.const 1))

  ;; Enter a handle-taking output API. Outside these calls the active buffer is
  ;; always loaded, so the console wndproc can paint without a second lookup.
  (func $console_buffer_enter (param $handle i32) (result i32)
    (call $console_buffer_load (local.get $handle)))

  (func $console_buffer_finish (param $changed i32)
    (local $target i32) (local $active i32) (local $target_rec i32)
    (local.set $target (global.get $console_loaded_handle))
    (local.set $target_rec (call $console_buffer_record (local.get $target)))
    (call $console_buffer_save_loaded)
    (local.set $active (i32.load (global.get $CONSOLE_BUFFER_ACTIVE)))
    (if (i32.eqz (local.get $active))
      (then (local.set $active (i32.const 0x00030001))))
    (drop (call $console_buffer_load (local.get $active)))
    (global.set $console_handle (local.get $active))
    (if (i32.and (local.get $changed)
          (i32.eq (local.get $target_rec) (call $console_buffer_record (local.get $active))))
      (then (call $console_refresh))))

  (func $console_buffer_create (result i32)
    (local $slot i32) (local $rec i32) (local $backing_ga i32)
    (local $i i32) (local $handle i32) (local $active_rec i32)
    (local $win i32) (local $window_width i32) (local $window_height i32)
    (call $console_buffers_init)
    (local.set $active_rec (call $console_buffer_record
      (i32.load (global.get $CONSOLE_BUFFER_ACTIVE))))
    (if (i32.eqz (local.get $active_rec))
      (then (local.set $active_rec (global.get $CONSOLE_BUFFER_TABLE))))
    (local.set $slot (i32.const 1))
    (block $found (loop $scan
      (br_if $found (i32.ge_u (local.get $slot) (global.get $CONSOLE_BUFFER_COUNT)))
      (local.set $rec (i32.add (global.get $CONSOLE_BUFFER_TABLE)
        (i32.mul (local.get $slot) (global.get $CONSOLE_BUFFER_STRIDE))))
      (br_if $found (i32.eqz (i32.load (local.get $rec))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $scan)))
    (if (i32.ge_u (local.get $slot) (global.get $CONSOLE_BUFFER_COUNT))
      (then (return (i32.const 0xFFFFFFFF))))
    (local.set $backing_ga (call $heap_alloc
      (i32.shl (global.get $CONSOLE_MAX_CELLS) (i32.const 2))))
    (if (i32.eqz (local.get $backing_ga))
      (then (return (i32.const 0xFFFFFFFF))))
    (memory.fill (local.get $rec) (i32.const 0) (global.get $CONSOLE_BUFFER_STRIDE))
    (i32.store (local.get $rec) (global.get $CONSOLE_BUFFER_MAGIC))
    (i32.store offset=4 (local.get $rec) (local.get $backing_ga))
    (i32.store offset=8 (local.get $rec) (call $g2w (local.get $backing_ga)))
    (i32.store offset=12 (local.get $rec)
      (i32.add (call $g2w (local.get $backing_ga))
        (i32.shl (global.get $CONSOLE_MAX_CELLS) (i32.const 1))))
    ;; Win32 creates the new buffer at the active display-window dimensions,
    ;; not at the potentially larger backing-buffer dimensions. Its own
    ;; viewport therefore covers that complete new buffer from the origin.
    (local.set $win (call $console_buffer_window_record (local.get $active_rec)))
    (local.set $window_width
      (i32.add
        (i32.sub (i32.load16_s offset=4 (local.get $win))
                 (i32.load16_s (local.get $win)))
        (i32.const 1)))
    (local.set $window_height
      (i32.add
        (i32.sub (i32.load16_s offset=6 (local.get $win))
                 (i32.load16_s offset=2 (local.get $win)))
        (i32.const 1)))
    (i32.store offset=16 (local.get $rec) (local.get $window_width))
    (i32.store offset=20 (local.get $rec) (local.get $window_height))
    (i32.store offset=32 (local.get $rec) (i32.load offset=32 (local.get $active_rec)))
    (i32.store offset=36 (local.get $rec) (i32.load offset=36 (local.get $active_rec)))
    (i32.store offset=40 (local.get $rec) (i32.load offset=40 (local.get $active_rec)))
    (local.set $win (call $console_buffer_window_record (local.get $rec)))
    (i64.store (local.get $win) (i64.const 0))
    (i32.store16 offset=4 (local.get $win)
      (i32.sub (local.get $window_width) (i32.const 1)))
    (i32.store16 offset=6 (local.get $win)
      (i32.sub (local.get $window_height) (i32.const 1)))
    ;; Initialize all capacity, not merely 80x25, so a later resize exposes
    ;; Win32 blank cells rather than stale heap bytes.
    (block $done (loop $clear
      (br_if $done (i32.ge_u (local.get $i) (global.get $CONSOLE_MAX_CELLS)))
      (i32.store16 (i32.add (i32.load offset=8 (local.get $rec))
        (i32.shl (local.get $i) (i32.const 1))) (i32.const 32))
      (i32.store16 (i32.add (i32.load offset=12 (local.get $rec))
        (i32.shl (local.get $i) (i32.const 1))) (i32.const 7))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $clear)))
    (i32.store offset=44 (local.get $rec) (i32.const 1))
    (local.set $handle (i32.or (global.get $CONSOLE_BUFFER_HANDLE_TAG) (local.get $slot)))
    (local.get $handle))

  ;; -1 means "not a console screen-buffer handle" so CloseHandle can fall
  ;; through to the VFS; 0 is a stale/active console handle; 1 was destroyed.
  (func $console_buffer_close (param $handle i32) (result i32)
    (local $rec i32)
    (if (i32.ne (i32.and (local.get $handle) (i32.const 0xFFFF0000))
                (global.get $CONSOLE_BUFFER_HANDLE_TAG))
      (then (return (i32.const -1))))
    (local.set $rec (call $console_buffer_record (local.get $handle)))
    (if (i32.eqz (local.get $rec)) (then (return (i32.const 0))))
    (if (i32.eq (i32.load (global.get $CONSOLE_BUFFER_ACTIVE)) (local.get $handle))
      (then (return (i32.const 0))))
    (call $heap_free (i32.load offset=4 (local.get $rec)))
    (i64.store (call $console_buffer_window_record (local.get $rec)) (i64.const 0))
    (memory.fill (local.get $rec) (i32.const 0) (global.get $CONSOLE_BUFFER_STRIDE))
    (i32.const 1))

  ;; 823: GetConsoleScreenBufferInfo(hConsole, lpInfo) → BOOL
  (func $handle_GetConsoleScreenBufferInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p i32) (local $win i32)
    (if (i32.eqz (call $console_buffer_enter (local.get $arg0)))
      (then
        (global.set $last_error (i32.const 6))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (local.set $p (call $g2w (local.get $arg1)))
    ;; dwSize.X, dwSize.Y
    (i32.store16 (local.get $p) (global.get $console_width))
    (i32.store16 (i32.add (local.get $p) (i32.const 2)) (global.get $console_height))
    ;; dwCursorPosition.X, Y
    (i32.store16 (i32.add (local.get $p) (i32.const 4)) (global.get $console_cursor_x))
    (i32.store16 (i32.add (local.get $p) (i32.const 6)) (global.get $console_cursor_y))
    ;; wAttributes
    (i32.store16 (i32.add (local.get $p) (i32.const 8)) (global.get $console_attr))
    ;; srWindow is an inclusive SMALL_RECT and may be smaller than or offset
    ;; within the backing screen buffer.
    (local.set $win (call $console_loaded_window_record))
    (i64.store (i32.add (local.get $p) (i32.const 10)) (i64.load (local.get $win)))
    ;; dwMaximumWindowSize
    (i32.store16 (i32.add (local.get $p) (i32.const 18)) (global.get $console_width))
    (i32.store16 (i32.add (local.get $p) (i32.const 20)) (global.get $console_height))
    (global.set $eax (i32.const 1))
    (call $console_buffer_finish (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; --- Console API handlers ---

  ;; AllocConsole() → BOOL
  ;; Attach a console to a GUI process. Wine-Assembly's console is process-local
  ;; already, so attachment means ensuring its cell store and native window
  ;; exist. Repeated calls are harmless and report success.
  (func $handle_AllocConsole (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $console_ensure_window)
    (call $console_buffer_save_loaded)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  ;; SetConsoleScreenBufferSize(hConsole, dwSize) → BOOL
  ;; dwSize is COORD packed as i32: loword=X, hiword=Y
  (func $handle_SetConsoleScreenBufferSize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $old_width i32) (local $old_height i32) (local $win i32)
    (if (i32.eqz (call $console_buffer_enter (local.get $arg0)))
      (then
        (global.set $last_error (i32.const 6))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (local.set $old_width (global.get $console_width))
    (local.set $old_height (global.get $console_height))
    (local.set $win (call $console_loaded_window_record))
    (global.set $console_width (i32.and (local.get $arg1) (i32.const 0xFFFF)))
    (global.set $console_height (i32.shr_u (local.get $arg1) (i32.const 16)))
    ;; Refuse a buffer the CONSOLE_TEXT/ATTR region cannot hold rather than
    ;; letting later writes run past it.
    (if (i32.or
          (i32.or
            (i32.or (i32.eqz (global.get $console_width))
                    (i32.eqz (global.get $console_height)))
            (i32.or
              (i32.ge_s (i32.load16_s offset=4 (local.get $win))
                        (global.get $console_width))
              (i32.ge_s (i32.load16_s offset=6 (local.get $win))
                        (global.get $console_height))))
          (i32.gt_u (i32.mul (global.get $console_width) (global.get $console_height))
                    (global.get $CONSOLE_MAX_CELLS)))
      (then
        (global.set $console_width (local.get $old_width))
        (global.set $console_height (local.get $old_height))
        (global.set $last_error (i32.const 87)) ;; ERROR_INVALID_PARAMETER
        (global.set $eax (i32.const 0))
        (call $console_buffer_finish (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (global.set $eax (i32.const 1))
    (call $console_buffer_finish (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; SetConsoleActiveScreenBuffer(hConsole) → BOOL
  (func $handle_SetConsoleActiveScreenBuffer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (call $console_buffer_enter (local.get $arg0)))
      (then
        (global.set $last_error (i32.const 6))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (i32.store (global.get $CONSOLE_BUFFER_ACTIVE) (local.get $arg0))
    (global.set $eax (i32.const 1))
    (call $console_buffer_finish (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; SetConsoleCursorPosition(hConsole, dwCursorPosition) → BOOL
  ;; dwCursorPosition is COORD packed: loword=X, hiword=Y
  (func $handle_SetConsoleCursorPosition (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (call $console_buffer_enter (local.get $arg0)))
      (then
        (global.set $last_error (i32.const 6))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (global.set $console_cursor_x (i32.and (local.get $arg1) (i32.const 0xFFFF)))
    (global.set $console_cursor_y (i32.shr_u (local.get $arg1) (i32.const 16)))
    (global.set $eax (i32.const 1))
    (call $console_buffer_finish (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; SetConsoleCursorInfo(hConsole, lpConsoleCursorInfo) → BOOL
  (func $handle_SetConsoleCursorInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p i32)
    (if (i32.eqz (call $console_buffer_enter (local.get $arg0)))
      (then
        (global.set $last_error (i32.const 6))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (local.set $p (call $g2w (local.get $arg1)))
    (global.set $console_cursor_size (i32.load (local.get $p)))
    (global.set $console_cursor_visible (i32.load (i32.add (local.get $p) (i32.const 4))))
    (global.set $eax (i32.const 1))
    (call $console_buffer_finish (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; GetConsoleCursorInfo(hConsole, lpConsoleCursorInfo) → BOOL
  (func $handle_GetConsoleCursorInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p i32)
    (if (i32.eqz (call $console_buffer_enter (local.get $arg0)))
      (then
        (global.set $last_error (i32.const 6))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (local.set $p (call $g2w (local.get $arg1)))
    (i32.store (local.get $p) (global.get $console_cursor_size))
    (i32.store (i32.add (local.get $p) (i32.const 4)) (global.get $console_cursor_visible))
    (global.set $eax (i32.const 1))
    (call $console_buffer_finish (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $console_title_publish
    (local $hwnd i32) (local $len i32)
    (call $console_ensure_window)
    (local.set $hwnd (global.get $console_hwnd))
    (local.set $len (call $strlen (global.get $CONSOLE_TITLE_STORAGE)))
    (if (local.get $hwnd)
      (then
        (call $title_table_set (local.get $hwnd)
          (global.get $CONSOLE_TITLE_STORAGE) (local.get $len))
        (call $nc_flags_set (local.get $hwnd) (i32.const 1))
        (call $defwndproc_do_ncpaint (local.get $hwnd))
        (call $host_set_window_text (local.get $hwnd) (global.get $CONSOLE_TITLE_STORAGE)))))

  ;; SetConsoleTitleW(lpConsoleTitle) → BOOL. The renderer and WAT caption
  ;; tables use ANSI bytes, so retain the process title in its CP1252 form.
  (func $handle_SetConsoleTitleW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $src i32) (local $len i32) (local $ch i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $last_error (i32.const 87))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (local.set $src (call $g2w (local.get $arg0)))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $len)
        (i32.sub (global.get $CONSOLE_TITLE_MAX) (i32.const 1))))
      (local.set $ch (i32.load16_u (i32.add (local.get $src)
        (i32.shl (local.get $len) (i32.const 1)))))
      (br_if $done (i32.eqz (local.get $ch)))
      (i32.store8 (i32.add (global.get $CONSOLE_TITLE_STORAGE) (local.get $len))
        (select (local.get $ch) (i32.const 0x3f)
          (i32.le_u (local.get $ch) (i32.const 0xff))))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (br $copy)))
    (i32.store8 (i32.add (global.get $CONSOLE_TITLE_STORAGE) (local.get $len)) (i32.const 0))
    (call $console_title_publish)
    (global.set $last_error (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; SetConsoleTitleA(lpConsoleTitle) → BOOL
  (func $handle_SetConsoleTitleA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $src i32) (local $len i32) (local $ch i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $last_error (i32.const 87))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (local.set $src (call $g2w (local.get $arg0)))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $len)
        (i32.sub (global.get $CONSOLE_TITLE_MAX) (i32.const 1))))
      (local.set $ch (i32.load8_u (i32.add (local.get $src) (local.get $len))))
      (br_if $done (i32.eqz (local.get $ch)))
      (i32.store8 (i32.add (global.get $CONSOLE_TITLE_STORAGE) (local.get $len)) (local.get $ch))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (br $copy)))
    (i32.store8 (i32.add (global.get $CONSOLE_TITLE_STORAGE) (local.get $len)) (i32.const 0))
    (call $console_title_publish)
    (global.set $last_error (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; GetConsoleTitleA/W copy at most nSize-1 characters, always terminate a
  ;; non-empty destination, and return the count excluding that terminator.
  (func $handle_GetConsoleTitleA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32) (local $len i32) (local $copy i32)
    (call $console_title_ensure)
    (local.set $len (call $strlen (global.get $CONSOLE_TITLE_STORAGE)))
    (if (i32.and (i32.ne (local.get $arg0) (i32.const 0))
          (i32.ne (local.get $arg1) (i32.const 0)))
      (then
        (local.set $dst (call $g2w (local.get $arg0)))
        (local.set $copy (local.get $len))
        (if (i32.ge_u (local.get $copy) (local.get $arg1))
          (then (local.set $copy (i32.sub (local.get $arg1) (i32.const 1)))))
        (memory.copy (local.get $dst) (global.get $CONSOLE_TITLE_STORAGE) (local.get $copy))
        (i32.store8 (i32.add (local.get $dst) (local.get $copy)) (i32.const 0))))
    (global.set $eax (local.get $copy))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_GetConsoleTitleW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32) (local $len i32) (local $copy i32) (local $i i32)
    (call $console_title_ensure)
    (local.set $len (call $strlen (global.get $CONSOLE_TITLE_STORAGE)))
    (if (i32.and (i32.ne (local.get $arg0) (i32.const 0))
          (i32.ne (local.get $arg1) (i32.const 0)))
      (then
        (local.set $dst (call $g2w (local.get $arg0)))
        (local.set $copy (local.get $len))
        (if (i32.ge_u (local.get $copy) (local.get $arg1))
          (then (local.set $copy (i32.sub (local.get $arg1) (i32.const 1)))))
        (block $done (loop $widen
          (br_if $done (i32.ge_u (local.get $i) (local.get $copy)))
          (i32.store16 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 1)))
            (i32.load8_u (i32.add (global.get $CONSOLE_TITLE_STORAGE) (local.get $i))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $widen)))
        (i32.store16 (i32.add (local.get $dst) (i32.shl (local.get $copy) (i32.const 1)))
          (i32.const 0))))
    (global.set $eax (local.get $copy))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; SetConsoleWindowInfo(hConsole, bAbsolute, lpConsoleWindow) → BOOL
  (func $handle_SetConsoleWindowInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $src i32) (local $win i32)
    (local $left i32) (local $top i32) (local $right i32) (local $bottom i32)
    (if (i32.eqz (call $console_buffer_enter (local.get $arg0)))
      (then
        (global.set $last_error (i32.const 6)) ;; ERROR_INVALID_HANDLE
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (if (i32.eqz (local.get $arg2))
      (then
        (global.set $last_error (i32.const 87)) ;; ERROR_INVALID_PARAMETER
        (global.set $eax (i32.const 0))
        (call $console_buffer_finish (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $src (call $g2w (local.get $arg2)))
    (local.set $win (call $console_loaded_window_record))
    (local.set $left (i32.load16_s (local.get $src)))
    (local.set $top (i32.load16_s offset=2 (local.get $src)))
    (local.set $right (i32.load16_s offset=4 (local.get $src)))
    (local.set $bottom (i32.load16_s offset=6 (local.get $src)))
    ;; Relative coordinates offset each corresponding side of the current
    ;; viewport; this moves/resizes exactly as Win32 SMALL_RECT semantics do.
    (if (i32.eqz (local.get $arg1))
      (then
        (local.set $left
          (i32.add (local.get $left) (i32.load16_s (local.get $win))))
        (local.set $top
          (i32.add (local.get $top) (i32.load16_s offset=2 (local.get $win))))
        (local.set $right
          (i32.add (local.get $right) (i32.load16_s offset=4 (local.get $win))))
        (local.set $bottom
          (i32.add (local.get $bottom) (i32.load16_s offset=6 (local.get $win))))))
    ;; The inclusive viewport must be non-empty and wholly inside its backing
    ;; screen buffer. A failed call leaves the prior viewport untouched.
    (if (i32.or
          (i32.or
            (i32.or (i32.lt_s (local.get $left) (i32.const 0))
                    (i32.lt_s (local.get $top) (i32.const 0)))
            (i32.or (i32.lt_s (local.get $right) (local.get $left))
                    (i32.lt_s (local.get $bottom) (local.get $top))))
          (i32.or (i32.ge_s (local.get $right) (global.get $console_width))
                  (i32.ge_s (local.get $bottom) (global.get $console_height))))
      (then
        (global.set $last_error (i32.const 87)) ;; ERROR_INVALID_PARAMETER
        (global.set $eax (i32.const 0))
        (call $console_buffer_finish (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (i32.store16 (local.get $win) (local.get $left))
    (i32.store16 offset=2 (local.get $win) (local.get $top))
    (i32.store16 offset=4 (local.get $win) (local.get $right))
    (i32.store16 offset=6 (local.get $win) (local.get $bottom))
    (global.set $eax (i32.const 1))
    (call $console_buffer_finish (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; GetLargestConsoleWindowSize(hConsole) → COORD (packed in eax)
  (func $handle_GetLargestConsoleWindowSize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.or (global.get $console_width) (i32.shl (global.get $console_height) (i32.const 16))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; GetConsoleCP() → UINT
  (func $handle_GetConsoleCP (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $console_cp))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  ;; FillConsoleOutputCharacterW(hConsole, cCharacter, nLength, dwWriteCoord, lpNumberOfCharsWritten) → BOOL
  ;; Fills console buffer with a character starting at coord
  (func $handle_FillConsoleOutputCharacterW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $x i32) (local $y i32) (local $i i32) (local $off i32)
    (if (i32.eqz (call $console_buffer_enter (local.get $arg0)))
      (then
        (global.set $last_error (i32.const 6))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    (call $console_cells_ensure)
    (local.set $x (i32.and (local.get $arg3) (i32.const 0xFFFF)))
    (local.set $y (i32.shr_u (local.get $arg3) (i32.const 16)))
    (local.set $i (i32.const 0))
    (block $done (loop $fill
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $off (i32.add (i32.mul (local.get $y) (global.get $console_width)) (local.get $x)))
      (if (i32.lt_u (local.get $off) (i32.mul (global.get $console_width) (global.get $console_height)))
        (then (i32.store16 (i32.add (global.get $console_text_base) (i32.mul (local.get $off) (i32.const 2))) (local.get $arg1))))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (if (i32.ge_u (local.get $x) (global.get $console_width))
        (then (local.set $x (i32.const 0)) (local.set $y (i32.add (local.get $y) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $fill)))
    ;; Write count to lpNumberOfCharsWritten
    (if (local.get $arg4)
      (then (i32.store (call $g2w (local.get $arg4)) (local.get $arg2))))
    (global.set $eax (i32.const 1))
    (call $console_buffer_finish (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; FillConsoleOutputAttribute(hConsole, wAttribute, nLength, dwWriteCoord, lpNumberOfAttrsWritten) → BOOL
  (func $handle_FillConsoleOutputAttribute (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $x i32) (local $y i32) (local $i i32) (local $off i32)
    (if (i32.eqz (call $console_buffer_enter (local.get $arg0)))
      (then
        (global.set $last_error (i32.const 6))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    (call $console_cells_ensure)
    (local.set $x (i32.and (local.get $arg3) (i32.const 0xFFFF)))
    (local.set $y (i32.shr_u (local.get $arg3) (i32.const 16)))
    (local.set $i (i32.const 0))
    (block $done (loop $fill
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $off (i32.add (i32.mul (local.get $y) (global.get $console_width)) (local.get $x)))
      (if (i32.lt_u (local.get $off) (i32.mul (global.get $console_width) (global.get $console_height)))
        (then (i32.store16 (i32.add (global.get $console_attr_base) (i32.mul (local.get $off) (i32.const 2))) (local.get $arg1))))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (if (i32.ge_u (local.get $x) (global.get $console_width))
        (then (local.set $x (i32.const 0)) (local.set $y (i32.add (local.get $y) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $fill)))
    (if (local.get $arg4)
      (then (i32.store (call $g2w (local.get $arg4)) (local.get $arg2))))
    (global.set $eax (i32.const 1))
    (call $console_buffer_finish (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; The character-writing half of WriteConsole, shared by both spellings: the
  ;; cursor, wrap and control-character rules are identical, only the width of
  ;; the source characters differs. WriteConsoleA used to carry its own copy of
  ;; this loop in 09a-handlers.wat, and that copy had gone stale — it wrote to
  ;; the hard-coded addresses the console buffer used to live at instead of
  ;; $CONSOLE_TEXT/$CONSOLE_ATTR, never called $console_cells_ensure, and never
  ;; refreshed, so ANSI console output landed in unrelated memory and was
  ;; invisible.
  (func $console_put_char (param $ch i32)
    (local $off i32)
    (if (i32.eq (local.get $ch) (i32.const 10)) ;; newline
      (then
        (global.set $console_cursor_x (i32.const 0))
        (global.set $console_cursor_y (i32.add (global.get $console_cursor_y) (i32.const 1))))
      (else (if (i32.eq (local.get $ch) (i32.const 13)) ;; carriage return
        (then (global.set $console_cursor_x (i32.const 0)))
        (else (if (i32.eq (local.get $ch) (i32.const 9)) ;; tab: next 8-column stop
          (then
            (local.set $off (i32.sub (i32.const 8)
              (i32.rem_u (global.get $console_cursor_x) (i32.const 8))))
            (block $tab_done (loop $tab
              (br_if $tab_done (i32.eqz (local.get $off)))
              (call $console_put_char (i32.const 32))
              (local.set $off (i32.sub (local.get $off) (i32.const 1)))
              (br $tab))))
          (else
          (local.set $off (i32.add (i32.mul (global.get $console_cursor_y) (global.get $console_width)) (global.get $console_cursor_x)))
          (if (i32.lt_u (local.get $off) (i32.mul (global.get $console_width) (global.get $console_height)))
            (then
              (i32.store16 (i32.add (global.get $console_text_base) (i32.mul (local.get $off) (i32.const 2))) (local.get $ch))
              (i32.store16 (i32.add (global.get $console_attr_base) (i32.mul (local.get $off) (i32.const 2))) (global.get $console_attr))))
          (global.set $console_cursor_x (i32.add (global.get $console_cursor_x) (i32.const 1)))
          (if (i32.ge_u (global.get $console_cursor_x) (global.get $console_width))
            (then
              (global.set $console_cursor_x (i32.const 0))
              (global.set $console_cursor_y (i32.add (global.get $console_cursor_y) (i32.const 1))))))))))))

  (func $console_write (param $handle i32) (param $buf_g i32)
        (param $count i32) (param $wide i32) (result i32)
    (local $i i32) (local $src i32) (local $step i32)
    (if (i32.eqz (call $console_buffer_enter (local.get $handle)))
      (then (return (i32.const 0))))
    (call $console_cells_ensure)
    (local.set $step (select (i32.const 2) (i32.const 1) (local.get $wide)))
    (local.set $src (call $g2w (local.get $buf_g)))
    (local.set $i (i32.const 0))
    (block $done (loop $write
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (call $console_put_char (call $load_char
        (i32.add (local.get $src) (i32.mul (local.get $i) (local.get $step))) (local.get $wide)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $write)))
    (call $console_buffer_finish (i32.const 1))
    (i32.const 1))

  ;; ---- Console input queue -------------------------------------------------
  ;; The keyboard side of the console. Everything a console app can read comes
  ;; through here: the console window's wndproc pushes key events, and
  ;; ReadConsole / ReadConsoleInput / PeekConsoleInput / GetNumberOfConsoleInputEvents
  ;; drain them. See the $CONSOLE_INPUT comment in 01-header.wat for the layout.

  (func $console_input_count (result i32)
    (i32.load (global.get $CONSOLE_INPUT)))

  ;; The console window's hwnd, as every thread must see it. $console_hwnd is a
  ;; per-instance global, and the thread that first writes to the console (and
  ;; so creates the window) is usually not the thread that pumps messages — for
  ;; telnet the worker writes and the main thread pumps. Keyboard routing runs
  ;; on the pumping thread, so the hwnd has to come out of shared memory.
  (func $console_shared_hwnd (result i32)
    (i32.load (region.addr $CONSOLE_INPUT 16)))

  (func $console_shared_hwnd_set (param $hwnd i32)
    (i32.store (region.addr $CONSOLE_INPUT 16) (local.get $hwnd)))

  ;; Address of the ring slot holding the i-th oldest queued event.
  (func $console_input_slot (param $i i32) (result i32)
    (i32.add
      (region.addr $CONSOLE_INPUT 32)
      (i32.mul
        (i32.rem_u
          (i32.add (i32.load (region.addr $CONSOLE_INPUT 4)) (local.get $i))
          (global.get $CONSOLE_INPUT_MAX))
        (i32.const 20))))

  (func $console_input_type (param $i i32) (result i32)
    (i32.load (call $console_input_slot (local.get $i))))

  (func $console_input_char (param $i i32) (result i32)
    (i32.load offset=4 (call $console_input_slot (local.get $i))))

  (func $console_input_vk (param $i i32) (result i32)
    (i32.load offset=8 (call $console_input_slot (local.get $i))))

  (func $console_input_event_flags (param $i i32) (result i32)
    (i32.load offset=16 (call $console_input_slot (local.get $i))))

  (func $console_input_control_state (param $i i32) (result i32)
    (i32.load offset=12 (call $console_input_slot (local.get $i))))

  ;; The mode as the *reading* thread must see it. SetConsoleMode mirrors it
  ;; into shared memory because $console_mode is per-instance and the thread
  ;; that sets the mode is often not the thread that reads.
  (func $console_input_mode (result i32)
    (local $m i32)
    (local.set $m (i32.load (region.addr $CONSOLE_INPUT 12)))
    (if (result i32) (local.get $m)
      (then (i32.sub (local.get $m) (i32.const 1)))
      (else (global.get $console_mode))))

  (func $console_input_set_mode (param $mode i32)
    (i32.store (region.addr $CONSOLE_INPUT 12)
      (i32.add (local.get $mode) (i32.const 1))))

  ;; Lazily created wake event. A blocked ReadConsole parks on it so the host
  ;; scheduler has something to name, and a push signals it.
  (func $console_input_event (result i32)
    (local $h i32)
    (local.set $h (i32.load (region.addr $CONSOLE_INPUT 8)))
    (if (i32.eqz (local.get $h))
      (then
        (local.set $h (call $host_create_event
          (i32.const 1) (i32.const 0) (i32.const 0) (i32.const 0)))
        (i32.store (region.addr $CONSOLE_INPUT 8) (local.get $h))))
    (local.get $h))

  (func $console_input_echo (param $ch i32)
    ;; ENABLE_ECHO_INPUT only echoes key-down characters in line mode, as on
    ;; Windows. WM_CHAR may attach the character after the KEY_EVENT was
    ;; queued, so echoing belongs to the character attachment path rather than
    ;; to the ring write itself.
    (if (i32.and
          (i32.ne (local.get $ch) (i32.const 0))
          (i32.eq (i32.and (call $console_input_mode) (i32.const 6)) (i32.const 6)))
      (then
        (call $console_cells_ensure)
        (call $console_put_char (local.get $ch))
        (if (i32.eq (local.get $ch) (i32.const 13))
          (then (call $console_put_char (i32.const 10))))
        (call $console_buffer_save_loaded)
        (call $console_refresh))))

  ;; Internal KEY_EVENT representation:
  ;;   +4 char, +8 virtual key, +12 dwControlKeyState, +16 original key lParam.
  ;; Keeping lParam preserves its repeat count, scan code, enhanced bit,
  ;; previous-state bit and transition bit without widening the 20-byte ring.
  (func $console_input_push_key
      (param $ch i32) (param $vk i32) (param $lparam i32) (param $control i32)
    (local $count i32) (local $slot i32)
    (local.set $count (i32.load (global.get $CONSOLE_INPUT)))
    ;; A full queue drops the keystroke, which is what a real console does once
    ;; its input buffer fills.
    (if (i32.ge_u (local.get $count) (global.get $CONSOLE_INPUT_MAX)) (then (return)))
    (local.set $slot (call $console_input_slot (local.get $count)))
    (i32.store (local.get $slot) (i32.const 1)) ;; KEY_EVENT
    (i32.store offset=4 (local.get $slot) (local.get $ch))
    (i32.store offset=8 (local.get $slot) (local.get $vk))
    (i32.store offset=12 (local.get $slot) (local.get $control))
    (i32.store offset=16 (local.get $slot) (local.get $lparam))
    (i32.store (global.get $CONSOLE_INPUT) (i32.add (local.get $count) (i32.const 1)))
    (drop (call $host_set_event (call $console_input_event)))
    (if (i32.eqz (i32.and (local.get $lparam) (i32.const 0x80000000)))
      (then (call $console_input_echo (local.get $ch)))))

  ;; Test/direct callers enqueue an ordinary key-down. Runtime keyboard input
  ;; goes through $console_input_push_host_key so its real hardware metadata is
  ;; retained.
  (func $console_input_push (param $ch i32) (param $vk i32)
    (call $console_input_push_key
      (local.get $ch) (local.get $vk) (i32.const 1)
      (i32.load (region.addr $CONSOLE_INPUT 24))))

  ;; WM_CHAR follows WM_KEYDOWN in the browser queue. Merge it into the newest
  ;; matching down record instead of inventing a second KEY_EVENT. If input was
  ;; injected as a bare WM_CHAR, fall back to a synthetic down event.
  (func $console_input_attach_char (param $ch i32) (param $vk i32)
    (local $i i32) (local $slot i32)
    (local.set $i (call $console_input_count))
    (block $fallback
      (loop $scan
        (br_if $fallback (i32.eqz (local.get $i)))
        (local.set $i (i32.sub (local.get $i) (i32.const 1)))
        (local.set $slot (call $console_input_slot (local.get $i)))
        (if (i32.and
              (i32.and
                (i32.eq (i32.load (local.get $slot)) (i32.const 1))
                (i32.eq (i32.load offset=8 (local.get $slot)) (local.get $vk)))
              (i32.and
                (i32.eqz (i32.load offset=4 (local.get $slot)))
                (i32.eqz (i32.and
                  (i32.load offset=16 (local.get $slot)) (i32.const 0x80000000)))))
          (then
            (i32.store offset=4 (local.get $slot) (local.get $ch))
            (call $console_input_echo (local.get $ch))
            (return)))
        (br $scan)))
    (call $console_input_push (local.get $ch) (local.get $vk)))

  ;; Update the process-shared modifier/toggle state at CONSOLE_INPUT+24 and
  ;; return the dwControlKeyState snapshot for this key edge. Browser keyboard
  ;; events use generic VK_SHIFT/VK_CONTROL/VK_MENU, so lParam's enhanced bit
  ;; distinguishes right Ctrl/Alt from left just like USER does.
  (func $console_input_key_control_state
      (param $msg i32) (param $vk i32) (param $lparam i32) (result i32)
    (local $state i32) (local $mask i32) (local $down i32)
    (local.set $state
      (i32.load (region.addr $CONSOLE_INPUT 24)))
    (local.set $down
      (i32.or
        (i32.eq (local.get $msg) (i32.const 0x0100))
        (i32.eq (local.get $msg) (i32.const 0x0104))))
    ;; SHIFT_PRESSED
    (if (i32.or (i32.eq (local.get $vk) (i32.const 0x10))
                (i32.or (i32.eq (local.get $vk) (i32.const 0xA0))
                        (i32.eq (local.get $vk) (i32.const 0xA1))))
      (then (local.set $mask (i32.const 0x10))))
    ;; LEFT/RIGHT_CTRL_PRESSED
    (if (i32.or (i32.eq (local.get $vk) (i32.const 0x11))
                (i32.or (i32.eq (local.get $vk) (i32.const 0xA2))
                        (i32.eq (local.get $vk) (i32.const 0xA3))))
      (then
        (local.set $mask
          (select (i32.const 0x4) (i32.const 0x8)
            (i32.ne (i32.and (local.get $lparam) (i32.const 0x01000000))
                    (i32.const 0))))))
    ;; LEFT/RIGHT_ALT_PRESSED
    (if (i32.or (i32.eq (local.get $vk) (i32.const 0x12))
                (i32.or (i32.eq (local.get $vk) (i32.const 0xA4))
                        (i32.eq (local.get $vk) (i32.const 0xA5))))
      (then
        (local.set $mask
          (select (i32.const 0x1) (i32.const 0x2)
            (i32.ne (i32.and (local.get $lparam) (i32.const 0x01000000))
                    (i32.const 0))))))
    (if (local.get $mask)
      (then
        (if (local.get $down)
          (then (local.set $state (i32.or (local.get $state) (local.get $mask))))
          (else (local.set $state
            (i32.and (local.get $state) (i32.xor (local.get $mask) (i32.const -1))))))))
    ;; NUMLOCK/CAPSLOCK/SCROLLLOCK toggle only on a fresh key-down.
    (local.set $mask (i32.const 0))
    (if (i32.eq (local.get $vk) (i32.const 0x90))
      (then (local.set $mask (i32.const 0x20))))
    (if (i32.eq (local.get $vk) (i32.const 0x14))
      (then (local.set $mask (i32.const 0x80))))
    (if (i32.eq (local.get $vk) (i32.const 0x91))
      (then (local.set $mask (i32.const 0x40))))
    (if (i32.and
          (i32.and (local.get $down) (i32.ne (local.get $mask) (i32.const 0)))
          (i32.eqz (i32.and (local.get $lparam) (i32.const 0x40000000))))
      (then (local.set $state (i32.xor (local.get $state) (local.get $mask)))))
    (i32.store (region.addr $CONSOLE_INPUT 24)
      (local.get $state))
    ;; ENHANCED_KEY belongs only to this event, not to persistent state.
    (i32.or (local.get $state)
      (select (i32.const 0x100) (i32.const 0)
        (i32.ne (i32.and (local.get $lparam) (i32.const 0x01000000))
                (i32.const 0)))))

  (func $console_input_push_host_key
      (param $msg i32) (param $vk i32) (param $lparam i32) (result i32)
    (if (i32.eqz
          (i32.or
            (i32.or (i32.eq (local.get $msg) (i32.const 0x0100))
                    (i32.eq (local.get $msg) (i32.const 0x0101)))
            (i32.or (i32.eq (local.get $msg) (i32.const 0x0104))
                    (i32.eq (local.get $msg) (i32.const 0x0105)))))
      (then (return (i32.const 0))))
    (call $console_input_push_key
      (i32.const 0) (local.get $vk) (local.get $lparam)
      (call $console_input_key_control_state
        (local.get $msg) (local.get $vk) (local.get $lparam)))
    (i32.const 1))

  ;; Translate USER mouse state into the button bits used by
  ;; MOUSE_EVENT_RECORD. MK_MBUTTON is 0x10, while the console structure calls
  ;; that physical button FROM_LEFT_2ND_BUTTON_PRESSED (0x4).
  (func $console_mouse_buttons (param $wparam i32) (result i32)
    (i32.or
      (i32.and (local.get $wparam) (i32.const 0x3))
      (i32.or
        (i32.shr_u (i32.and (local.get $wparam) (i32.const 0x10)) (i32.const 2))
        (i32.shr_u (i32.and (local.get $wparam) (i32.const 0x60)) (i32.const 2)))))

  ;; Queue a MOUSE_EVENT_RECORD payload. lParam is in console-client pixels;
  ;; the console contract exposes screen-buffer character cells instead.
  (func $console_input_push_mouse (param $lparam i32) (param $wparam i32)
                                   (param $flags i32)
    (local $count i32) (local $slot i32) (local $x i32) (local $y i32)
    (local $win i32)
    (if (i32.eqz (i32.and (call $console_input_mode) (i32.const 0x10)))
      (then (return))) ;; ENABLE_MOUSE_INPUT
    (local.set $count (i32.load (global.get $CONSOLE_INPUT)))
    (if (i32.ge_u (local.get $count) (global.get $CONSOLE_INPUT_MAX)) (then (return)))
    (local.set $x (i32.div_u
      (i32.and (local.get $lparam) (i32.const 0xFFFF))
      (global.get $CONSOLE_CELL_W)))
    (local.set $y (i32.div_u
      (i32.shr_u (local.get $lparam) (i32.const 16))
      (global.get $CONSOLE_CELL_H)))
    ;; Browser coordinates are viewport-client cells; INPUT_RECORD exposes
    ;; backing-buffer coordinates, including a scrolled window's origin.
    (local.set $win (call $console_loaded_window_record))
    (local.set $x (i32.add (local.get $x) (i32.load16_s (local.get $win))))
    (local.set $y (i32.add (local.get $y) (i32.load16_s offset=2 (local.get $win))))
    (if (i32.ge_u (local.get $x) (global.get $console_width))
      (then (local.set $x (i32.sub (global.get $console_width) (i32.const 1)))))
    (if (i32.ge_u (local.get $y) (global.get $console_height))
      (then (local.set $y (i32.sub (global.get $console_height) (i32.const 1)))))
    (local.set $slot (call $console_input_slot (local.get $count)))
    (i32.store (local.get $slot) (i32.const 2)) ;; MOUSE_EVENT
    (i32.store offset=4 (local.get $slot)
      (i32.or (i32.and (local.get $x) (i32.const 0xFFFF))
        (i32.shl (local.get $y) (i32.const 16))))
    ;; Wheel delta lives in wParam's high word and becomes the high word of
    ;; dwButtonState; ordinary mouse messages contribute only button bits.
    (i32.store offset=8 (local.get $slot)
      (i32.or
        (i32.and (local.get $wparam) (i32.const 0xFFFF0000))
        (call $console_mouse_buttons (local.get $wparam))))
    ;; MK_CONTROL/MK_SHIFT map to LEFT_CTRL_PRESSED/SHIFT_PRESSED.
    (i32.store offset=12 (local.get $slot)
      (i32.or
        (i32.and (local.get $wparam) (i32.const 0x8))
        (i32.shl (i32.and (local.get $wparam) (i32.const 0x4)) (i32.const 2))))
    (i32.store offset=16 (local.get $slot) (local.get $flags))
    (i32.store (global.get $CONSOLE_INPUT) (i32.add (local.get $count) (i32.const 1)))
    (drop (call $host_set_event (call $console_input_event))))

  ;; Convert one USER mouse message. Return 1 when it belongs to the mouse
  ;; family even if mouse mode is disabled (the console host discards it
  ;; instead of leaking it into the application's USER queue).
  (func $console_input_mouse_message (param $msg i32) (param $wparam i32)
                                     (param $lparam i32) (result i32)
    (if (i32.eq (local.get $msg) (i32.const 0x0200)) ;; WM_MOUSEMOVE
      (then
        (call $console_input_push_mouse (local.get $lparam) (local.get $wparam)
          (i32.const 1)) ;; MOUSE_MOVED
        (return (i32.const 1))))
    (if (i32.or
          (i32.or (i32.eq (local.get $msg) (i32.const 0x0201))
                  (i32.eq (local.get $msg) (i32.const 0x0202)))
          (i32.or
            (i32.or (i32.eq (local.get $msg) (i32.const 0x0204))
                    (i32.eq (local.get $msg) (i32.const 0x0205)))
            (i32.or (i32.eq (local.get $msg) (i32.const 0x0207))
                    (i32.eq (local.get $msg) (i32.const 0x0208)))))
      (then
        (call $console_input_push_mouse (local.get $lparam) (local.get $wparam)
          (i32.const 0)) ;; button press/release
        (return (i32.const 1))))
    (if (i32.or
          (i32.or (i32.eq (local.get $msg) (i32.const 0x0203))
                  (i32.eq (local.get $msg) (i32.const 0x0206)))
          (i32.eq (local.get $msg) (i32.const 0x0209)))
      (then
        (call $console_input_push_mouse (local.get $lparam) (local.get $wparam)
          (i32.const 2)) ;; DOUBLE_CLICK
        (return (i32.const 1))))
    (if (i32.eq (local.get $msg) (i32.const 0x020A)) ;; WM_MOUSEWHEEL
      (then
        (call $console_input_push_mouse (local.get $lparam) (local.get $wparam)
          (i32.const 4)) ;; MOUSE_WHEELED
        (return (i32.const 1))))
    (i32.const 0))

  (func $console_input_drop (param $n i32)
    (local $count i32)
    (local.set $count (i32.load (global.get $CONSOLE_INPUT)))
    (if (i32.gt_u (local.get $n) (local.get $count)) (then (local.set $n (local.get $count))))
    (i32.store (region.addr $CONSOLE_INPUT 4)
      (i32.rem_u
        (i32.add (i32.load (region.addr $CONSOLE_INPUT 4)) (local.get $n))
        (global.get $CONSOLE_INPUT_MAX)))
    (i32.store (global.get $CONSOLE_INPUT) (i32.sub (local.get $count) (local.get $n)))
    (if (i32.eqz (i32.load (global.get $CONSOLE_INPUT)))
      (then (drop (call $host_reset_event (call $console_input_event))))))

  ;; FlushConsoleInputBuffer(hConsoleInput) → BOOL. Draining through the same
  ;; queue helper also resets the wake event seen by blocked browser Workers.
  (func $handle_FlushConsoleInputBuffer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.ne (call $console_handle_resolve (local.get $arg0)) (i32.const 1))
      (then
        (global.set $last_error (i32.const 6))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (call $console_input_drop (call $console_input_count))
    (global.set $last_error (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; Number of queued events up to and including the first Enter, or 0 when no
  ;; complete line is queued yet.
  (func $console_input_line_len (result i32)
    (local $i i32) (local $count i32)
    (local.set $count (call $console_input_count))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (if (i32.and
            (i32.eq (call $console_input_type (local.get $i)) (i32.const 1))
            (i32.eq (call $console_input_char (local.get $i)) (i32.const 13)))
        (then (return (i32.add (local.get $i) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; Keyboard routing for console apps. On Windows the console window belongs
  ;; to the console host, not to the process, so keystrokes typed into it never
  ;; reach the app's own message queue — they land in the console input buffer.
  ;; Telnet is the case that needs this: it owns a real but never-shown window,
  ;; which is where host input would otherwise be delivered and dropped. Only
  ;; claim the key when the app has no visible window of its own to type into.
  (func $console_input_target (param $hwnd i32) (param $msg i32) (result i32)
    (local $con i32)
    (local.set $con (call $console_shared_hwnd))
    (if (i32.eqz (local.get $con)) (then (return (local.get $hwnd))))
    (if (i32.eqz (i32.or
          (i32.or
            (i32.or (i32.eq (local.get $msg) (i32.const 0x0100))   ;; WM_KEYDOWN
                    (i32.eq (local.get $msg) (i32.const 0x0101)))  ;; WM_KEYUP
            (i32.or (i32.eq (local.get $msg) (i32.const 0x0102))   ;; WM_CHAR
                    (i32.eq (local.get $msg) (i32.const 0x0103)))) ;; WM_DEADCHAR
          (i32.or
            (i32.or (i32.eq (local.get $msg) (i32.const 0x0104))   ;; WM_SYSKEYDOWN
                    (i32.eq (local.get $msg) (i32.const 0x0105)))  ;; WM_SYSKEYUP
            (i32.eq (local.get $msg) (i32.const 0x0106)))))        ;; WM_SYSCHAR
      (then (return (local.get $hwnd))))
    (if (i32.and
          (i32.ne (local.get $hwnd) (i32.const 0))
          (i32.ne (local.get $hwnd) (local.get $con)))
      (then
        ;; WS_VISIBLE on the nominal target means the app really is showing a
        ;; window; leave its keyboard alone.
        (if (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0x10000000))
          (then (return (local.get $hwnd))))))
    (local.get $con))

  ;; Console applications do not run a USER message pump: the system console
  ;; host turns browser/native keyboard messages into INPUT_RECORDs outside the
  ;; process. Poll that same host queue from the console APIs themselves. A
  ;; non-console event is cached for GetMessage/PeekMessage instead of being
  ;; stolen from a GUI window owned by the process.
  (func $console_input_poll_host
    (local $packed i32) (local $msg i32) (local $wparam i32)
    (local $hwnd i32) (local $target i32)
    (call $console_ensure_window)
    ;; PM_NOREMOVE may already own the cached event.
    (if (global.get $pending_input_packed) (then (return)))
    (local.set $packed (call $host_check_input))
    (if (i32.eqz (local.get $packed)) (then (return)))
    (global.set $pending_input_hwnd (call $host_check_input_hwnd))
    (global.set $pending_input_lparam (call $host_check_input_lparam))
    (local.set $msg (i32.and (local.get $packed) (i32.const 0xFFFF)))
    (local.set $wparam (call $host_check_input_wparam))
    (local.set $hwnd (global.get $pending_input_hwnd))
    (if (i32.eqz (local.get $hwnd))
      (then (local.set $hwnd (global.get $main_hwnd))))
    (local.set $target (call $console_input_target (local.get $hwnd) (local.get $msg)))
    (if (i32.ne (local.get $target) (call $console_shared_hwnd))
      (then
        (global.set $pending_input_packed (local.get $packed))
        (return)))
    (if (call $console_input_mouse_message
          (local.get $msg) (local.get $wparam) (global.get $pending_input_lparam))
      (then (return)))
    ;; Match $console_wndproc: retain every hardware edge, then merge the
    ;; translated character into its preceding key-down record.
    (if (i32.or (i32.eq (local.get $msg) (i32.const 0x0102))
                (i32.eq (local.get $msg) (i32.const 0x0106)))
      (then
        (call $console_input_attach_char
          (local.get $wparam)
          (call $console_vk_for_char (local.get $wparam)))
        (return)))
    (drop (call $console_input_push_host_key
      (local.get $msg) (local.get $wparam) (global.get $pending_input_lparam))))

  ;; Park the calling thread on its import thunk without consuming the stdcall
  ;; frame — the $cs_block pattern, which is the only one that survives the
  ;; inline CALL/JMP dispatch path. Resuming at the caller's decoded block
  ;; instead would re-run its PUSH/CALL and walk ESP down a frame on every
  ;; retry. Yield reason 9 is "parked on an import thunk, retry next turn" to
  ;; the host scheduler; the handler must return without touching ESP.
  (func $console_input_block
    (drop (call $console_input_event))
    (if (global.get $current_thunk_eip)
      (then (global.set $eip (global.get $current_thunk_eip))))
    (global.set $handler_set_eip (i32.const 1))
    (global.set $yield_reason (i32.const 9))
    (global.set $yield_flag (i32.const 1))
    (global.set $steps (i32.const 0)))

  ;; The shared body of ReadConsoleA/W. Returns 1 when it parked (caller must
  ;; return immediately, leaving ESP alone) and 0 when it filled the buffer.
  (func $console_read (param $buf_g i32) (param $maxch i32) (param $pread i32)
                      (param $wide i32) (result i32)
    (local $avail i32) (local $i i32) (local $out i32) (local $ch i32) (local $dst i32)
    (call $console_input_poll_host)
    (if (i32.and (call $console_input_mode) (i32.const 2))
      (then (local.set $avail (call $console_input_line_len)))
      (else (local.set $avail (call $console_input_count))))
    (if (i32.eqz (local.get $avail))
      (then
        (call $console_input_block)
        (return (i32.const 1))))
    ;; A previous park left the auto-pop suppressed; this call completes its
    ;; own frame, so hand the flag back before returning.
    (global.set $handler_set_eip (i32.const 0))
    (local.set $dst (call $g2w (local.get $buf_g)))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $avail)))
      (br_if $done (i32.ge_u (local.get $out) (local.get $maxch)))
      (local.set $ch (call $console_input_char (local.get $i)))
      ;; High-level ReadConsole filters mouse/window records out of the input
      ;; stream even when those modes are enabled.
      (if (i32.and
            (i32.eq (call $console_input_type (local.get $i)) (i32.const 1))
            (i32.ne (local.get $ch) (i32.const 0)))
        (then
          (if (local.get $wide)
            (then (i32.store16 (i32.add (local.get $dst) (i32.mul (local.get $out) (i32.const 2))) (local.get $ch)))
            (else (i32.store8 (i32.add (local.get $dst) (local.get $out)) (local.get $ch))))
          (local.set $out (i32.add (local.get $out) (i32.const 1)))
          ;; Enter reads back as CRLF, the way a real line-mode read does.
          (if (i32.and (i32.eq (local.get $ch) (i32.const 13))
                       (i32.lt_u (local.get $out) (local.get $maxch)))
            (then
              (if (local.get $wide)
                (then (i32.store16 (i32.add (local.get $dst) (i32.mul (local.get $out) (i32.const 2))) (i32.const 10)))
                (else (i32.store8 (i32.add (local.get $dst) (local.get $out)) (i32.const 10))))
              (local.set $out (i32.add (local.get $out) (i32.const 1)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (call $console_input_drop (local.get $i))
    (if (i32.eqz (local.get $out))
      (then
        (call $console_input_block)
        (return (i32.const 1))))
    (if (local.get $pread)
      (then (i32.store (call $g2w (local.get $pread)) (local.get $out))))
    (i32.const 0))

  ;; Fill INPUT_RECORDs from the queue. Returns the number of records written.
  ;; KEY_EVENT layout: +0 EventType, +4 bKeyDown, +8 wRepeatCount,
  ;; +10 wVirtualKeyCode, +12 wVirtualScanCode, +14 uChar, +16 dwControlKeyState.
  (func $console_read_input (param $buf_g i32) (param $nrec i32) (param $wide i32)
                            (result i32)
    (local $i i32) (local $rec i32) (local $count i32) (local $type i32)
    (local.set $count (call $console_input_count))
    (if (i32.gt_u (local.get $nrec) (local.get $count)) (then (local.set $nrec (local.get $count))))
    (local.set $rec (call $g2w (local.get $buf_g)))
    (block $done (loop $fill
      (br_if $done (i32.ge_u (local.get $i) (local.get $nrec)))
      (local.set $type (call $console_input_type (local.get $i)))
      (i32.store16 (local.get $rec) (local.get $type))
      (if (i32.eq (local.get $type) (i32.const 2)) ;; MOUSE_EVENT
        (then
          (i32.store offset=4 (local.get $rec)
            (call $console_input_char (local.get $i))) ;; COORD
          (i32.store offset=8 (local.get $rec)
            (call $console_input_vk (local.get $i))) ;; dwButtonState
          (i32.store offset=12 (local.get $rec)
            (call $console_input_control_state (local.get $i)))
          (i32.store offset=16 (local.get $rec)
            (call $console_input_event_flags (local.get $i))))
        (else
          (i32.store offset=4 (local.get $rec)
            (i32.eqz (i32.and
              (call $console_input_event_flags (local.get $i))
              (i32.const 0x80000000))))                         ;; bKeyDown
          (i32.store16 offset=8 (local.get $rec)
            (i32.and (call $console_input_event_flags (local.get $i))
              (i32.const 0xFFFF)))                              ;; repeat
          (i32.store16 offset=10 (local.get $rec) (call $console_input_vk (local.get $i)))
          (i32.store16 offset=12 (local.get $rec)
            (i32.and
              (i32.shr_u (call $console_input_event_flags (local.get $i)) (i32.const 16))
              (i32.const 0xFF)))                                ;; scan code
          (i32.store16 offset=14 (local.get $rec)
            (select
              (call $console_input_char (local.get $i))
              (i32.and (call $console_input_char (local.get $i)) (i32.const 0xFF))
              (local.get $wide)))
          (i32.store offset=16 (local.get $rec)
            (call $console_input_control_state (local.get $i)))))
      (local.set $rec (i32.add (local.get $rec) (i32.const 20)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $fill)))
    (local.get $nrec))

  ;; WriteConsoleW(hConsole, lpBuffer, nNumberOfCharsToWrite, lpNumberOfCharsWritten, lpReserved) → BOOL
  (func $handle_WriteConsoleW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $console_write
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (i32.const 1)))
    (if (i32.and (global.get $eax) (i32.ne (local.get $arg3) (i32.const 0)))
      (then (i32.store (call $g2w (local.get $arg3)) (local.get $arg2))))
    (if (i32.eqz (global.get $eax))
      (then (global.set $last_error (i32.const 6))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; Shared WriteConsoleOutputA/W rectangle writer. CHAR_INFO is four bytes in
  ;; both forms; only the character union member changes width.
  (func $console_write_output (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32) (param $wide i32)
    (local $src i32) (local $bw i32) (local $bh i32) (local $bx i32) (local $by i32)
    (local $rgn i32) (local $left i32) (local $top i32) (local $right i32) (local $bottom i32)
    (local $row i32) (local $col i32) (local $soff i32) (local $doff i32)
    (if (i32.eqz (call $console_buffer_enter (local.get $arg0)))
      (then
        (global.set $last_error (i32.const 6))
        (global.set $eax (i32.const 0))
        (return)))
    (call $console_cells_ensure)
    (local.set $src (call $g2w (local.get $arg1)))
    (local.set $bw (i32.and (local.get $arg2) (i32.const 0xFFFF)))
    (local.set $bh (i32.shr_u (local.get $arg2) (i32.const 16)))
    (local.set $bx (i32.and (local.get $arg3) (i32.const 0xFFFF)))
    (local.set $by (i32.shr_u (local.get $arg3) (i32.const 16)))
    (local.set $rgn (call $g2w (local.get $arg4)))
    (local.set $left (i32.load16_s (local.get $rgn)))
    (local.set $top (i32.load16_s (i32.add (local.get $rgn) (i32.const 2))))
    (local.set $right (i32.load16_s (i32.add (local.get $rgn) (i32.const 4))))
    (local.set $bottom (i32.load16_s (i32.add (local.get $rgn) (i32.const 6))))
    (local.set $row (local.get $top))
    (block $rdone (loop $rows
      (br_if $rdone (i32.gt_s (local.get $row) (local.get $bottom)))
      (local.set $col (local.get $left))
      (block $cdone (loop $cols
        (br_if $cdone (i32.gt_s (local.get $col) (local.get $right)))
        ;; source offset in CHAR_INFO array
        (local.set $soff (i32.add (local.get $src)
          (i32.mul (i32.const 4)
            (i32.add
              (i32.mul (i32.add (i32.sub (local.get $row) (local.get $top)) (local.get $by)) (local.get $bw))
              (i32.add (i32.sub (local.get $col) (local.get $left)) (local.get $bx))))))
        ;; dest offset in console buffer
        (local.set $doff (i32.add (i32.mul (local.get $row) (global.get $console_width)) (local.get $col)))
        (if (i32.and (i32.ge_s (local.get $col) (i32.const 0))
              (i32.and (i32.ge_s (local.get $row) (i32.const 0))
                (i32.lt_u (local.get $doff) (i32.mul (global.get $console_width) (global.get $console_height)))))
          (then
            (i32.store16 (i32.add (global.get $console_text_base) (i32.mul (local.get $doff) (i32.const 2)))
              (select (i32.load16_u (local.get $soff))
                      (i32.load8_u (local.get $soff))
                      (local.get $wide)))
            (i32.store16 (i32.add (global.get $console_attr_base) (i32.mul (local.get $doff) (i32.const 2)))
              (i32.load16_u (i32.add (local.get $soff) (i32.const 2))))))
        (local.set $col (i32.add (local.get $col) (i32.const 1)))
        (br $cols)))
      (local.set $row (i32.add (local.get $row) (i32.const 1)))
      (br $rows)))
    (global.set $eax (i32.const 1))
    (call $console_buffer_finish (i32.const 1)))

  ;; WriteConsoleOutputW(hConsole, lpBuffer, dwBufferSize, dwBufferCoord, lpWriteRegion) → BOOL
  (func $handle_WriteConsoleOutputW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $console_write_output (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr) (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; WriteConsoleOutputA(hConsole, lpBuffer, dwBufferSize, dwBufferCoord, lpWriteRegion) → BOOL
  (func $handle_WriteConsoleOutputA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $console_write_output (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr) (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; WriteConsoleOutputCharacterA(hConsole, lpCharacter, nLength, dwWriteCoord, lpNumberOfCharsWritten) → BOOL
  (func $handle_WriteConsoleOutputCharacterA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $x i32) (local $y i32) (local $i i32) (local $off i32) (local $src i32)
    (if (i32.eqz (call $console_buffer_enter (local.get $arg0)))
      (then
        (global.set $last_error (i32.const 6))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    (call $console_cells_ensure)
    (local.set $src (call $g2w (local.get $arg1)))
    (local.set $x (i32.and (local.get $arg3) (i32.const 0xFFFF)))
    (local.set $y (i32.shr_u (local.get $arg3) (i32.const 16)))
    (local.set $i (i32.const 0))
    (block $done (loop $fill
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $off (i32.add (i32.mul (local.get $y) (global.get $console_width)) (local.get $x)))
      (if (i32.lt_u (local.get $off) (i32.mul (global.get $console_width) (global.get $console_height)))
        (then (i32.store16 (i32.add (global.get $console_text_base) (i32.mul (local.get $off) (i32.const 2)))
          (i32.load8_u (i32.add (local.get $src) (local.get $i))))))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (if (i32.ge_u (local.get $x) (global.get $console_width))
        (then (local.set $x (i32.const 0)) (local.set $y (i32.add (local.get $y) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $fill)))
    (if (local.get $arg4)
      (then (i32.store (call $g2w (local.get $arg4)) (local.get $arg2))))
    (global.set $eax (i32.const 1))
    (call $console_buffer_finish (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; WriteConsoleOutputAttribute(hConsole, lpAttribute, nLength, dwWriteCoord, lpNumberOfAttrsWritten) → BOOL
  (func $handle_WriteConsoleOutputAttribute (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $x i32) (local $y i32) (local $i i32) (local $off i32) (local $src i32)
    (if (i32.eqz (call $console_buffer_enter (local.get $arg0)))
      (then
        (global.set $last_error (i32.const 6))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    (call $console_cells_ensure)
    (local.set $src (call $g2w (local.get $arg1)))
    (local.set $x (i32.and (local.get $arg3) (i32.const 0xFFFF)))
    (local.set $y (i32.shr_u (local.get $arg3) (i32.const 16)))
    (local.set $i (i32.const 0))
    (block $done (loop $fill
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $off (i32.add (i32.mul (local.get $y) (global.get $console_width)) (local.get $x)))
      (if (i32.lt_u (local.get $off) (i32.mul (global.get $console_width) (global.get $console_height)))
        (then (i32.store16 (i32.add (global.get $console_attr_base) (i32.mul (local.get $off) (i32.const 2)))
          (i32.load16_u (i32.add (local.get $src) (i32.mul (local.get $i) (i32.const 2)))))))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (if (i32.ge_u (local.get $x) (global.get $console_width))
        (then (local.set $x (i32.const 0)) (local.set $y (i32.add (local.get $y) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $fill)))
    (if (local.get $arg4)
      (then (i32.store (call $g2w (local.get $arg4)) (local.get $arg2))))
    (global.set $eax (i32.const 1))
    (call $console_buffer_finish (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; ReadConsoleW(hConsole, lpBuffer, nNumberOfCharsToRead, lpNumberOfCharsRead, pInputControl) → BOOL
  ;; Blocks until the console input queue can satisfy the read. Returning
  ;; "success, 0 chars" instead is what used to hang Telnet: its reader thread
  ;; span on this call forever because the call never failed and never waited.
  (func $handle_ReadConsoleW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (call $console_read (local.get $arg1) (local.get $arg2) (local.get $arg3) (i32.const 1))
      (then (return)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; ReadConsoleInputW(hConsole, lpBuffer, nLength, lpNumberOfEventsRead) → BOOL
  (func $handle_ReadConsoleInputW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $n i32)
    (call $console_input_poll_host)
    (if (i32.eqz (call $console_input_count))
      (then
        (call $console_input_block)
        (return)))
    (global.set $handler_set_eip (i32.const 0))
    (local.set $n (call $console_read_input (local.get $arg1) (local.get $arg2) (i32.const 1)))
    (call $console_input_drop (local.get $n))
    (if (local.get $arg3)
      (then (i32.store (call $g2w (local.get $arg3)) (local.get $n))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; Shared ReadConsoleOutputA/W rectangle reader. CHAR_INFO is four bytes in
  ;; both forms; the A form exposes the low console-codepage byte of Char.
  (func $console_read_output (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $wide i32)
    (local $dst i32) (local $bw i32) (local $bh i32) (local $bx i32) (local $by i32)
    (local $rgn i32) (local $left i32) (local $top i32) (local $right i32) (local $bottom i32)
    (local $src_left i32) (local $src_top i32) (local $bound i32)
    (local $row i32) (local $col i32) (local $doff i32) (local $soff i32)
    (if (i32.eqz (call $console_buffer_enter (local.get $arg0)))
      (then
        (global.set $last_error (i32.const 6))
        (global.set $eax (i32.const 0))
        (return)))
    (call $console_cells_ensure)
    (local.set $dst (call $g2w (local.get $arg1)))
    ;; COORD members are signed SHORTs. The destination is a true 2-D array;
    ;; treating Y as absent (and X/Y as unsigned) lets a clipped read walk past
    ;; the caller's CHAR_INFO allocation.
    (local.set $bw (i32.extend16_s (local.get $arg2)))
    (local.set $bh (i32.shr_s (local.get $arg2) (i32.const 16)))
    (local.set $bx (i32.extend16_s (local.get $arg3)))
    (local.set $by (i32.shr_s (local.get $arg3) (i32.const 16)))
    (local.set $rgn (call $g2w (local.get $arg4)))
    (local.set $left (i32.load16_s (local.get $rgn)))
    (local.set $top (i32.load16_s (i32.add (local.get $rgn) (i32.const 2))))
    (local.set $right (i32.load16_s (i32.add (local.get $rgn) (i32.const 4))))
    (local.set $bottom (i32.load16_s (i32.add (local.get $rgn) (i32.const 6))))
    (local.set $src_left (local.get $left))
    (local.set $src_top (local.get $top))

    ;; Intersect the requested screen rectangle with both coordinate spaces.
    ;; A source x maps to destination x = bx + (x - src_left), hence the
    ;; destination bounds map back to [src_left-bx, src_left+bw-bx-1].
    (if (i32.lt_s (local.get $left) (i32.const 0))
      (then (local.set $left (i32.const 0))))
    (local.set $bound (i32.sub (local.get $src_left) (local.get $bx)))
    (if (i32.lt_s (local.get $left) (local.get $bound))
      (then (local.set $left (local.get $bound))))
    (if (i32.lt_s (local.get $top) (i32.const 0))
      (then (local.set $top (i32.const 0))))
    (local.set $bound (i32.sub (local.get $src_top) (local.get $by)))
    (if (i32.lt_s (local.get $top) (local.get $bound))
      (then (local.set $top (local.get $bound))))
    (local.set $bound (i32.sub (global.get $console_width) (i32.const 1)))
    (if (i32.gt_s (local.get $right) (local.get $bound))
      (then (local.set $right (local.get $bound))))
    (local.set $bound
      (i32.sub
        (i32.add (local.get $src_left) (local.get $bw))
        (i32.add (local.get $bx) (i32.const 1))))
    (if (i32.gt_s (local.get $right) (local.get $bound))
      (then (local.set $right (local.get $bound))))
    (local.set $bound (i32.sub (global.get $console_height) (i32.const 1)))
    (if (i32.gt_s (local.get $bottom) (local.get $bound))
      (then (local.set $bottom (local.get $bound))))
    (local.set $bound
      (i32.sub
        (i32.add (local.get $src_top) (local.get $bh))
        (i32.add (local.get $by) (i32.const 1))))
    (if (i32.gt_s (local.get $bottom) (local.get $bound))
      (then (local.set $bottom (local.get $bound))))

    ;; Win32 reports the actual screen-buffer rectangle copied. For a wholly
    ;; clipped operation it returns success with an empty rectangle.
    (if (i32.or
          (i32.or (i32.le_s (local.get $bw) (i32.const 0))
                  (i32.le_s (local.get $bh) (i32.const 0)))
          (i32.or (i32.gt_s (local.get $left) (local.get $right))
                  (i32.gt_s (local.get $top) (local.get $bottom))))
      (then
        (local.set $left (i32.const 0))
        (local.set $top (i32.const 0))
        (local.set $right (i32.const -1))
        (local.set $bottom (i32.const -1))))
    (i32.store16 (local.get $rgn) (local.get $left))
    (i32.store16 offset=2 (local.get $rgn) (local.get $top))
    (i32.store16 offset=4 (local.get $rgn) (local.get $right))
    (i32.store16 offset=6 (local.get $rgn) (local.get $bottom))
    (local.set $row (local.get $top))
    (block $rdone (loop $rows
      (br_if $rdone (i32.gt_s (local.get $row) (local.get $bottom)))
      (local.set $col (local.get $left))
      (block $cdone (loop $cols
        (br_if $cdone (i32.gt_s (local.get $col) (local.get $right)))
        (local.set $soff (i32.add (i32.mul (local.get $row) (global.get $console_width)) (local.get $col)))
        (local.set $doff (i32.add (local.get $dst)
          (i32.mul (i32.const 4)
            (i32.add
              (i32.mul (i32.add (i32.sub (local.get $row) (local.get $src_top)) (local.get $by)) (local.get $bw))
              (i32.add (i32.sub (local.get $col) (local.get $src_left)) (local.get $bx))))))
        (i32.store16 (local.get $doff)
          (select
            (i32.load16_u (i32.add (global.get $console_text_base)
              (i32.mul (local.get $soff) (i32.const 2))))
            (i32.and (i32.load16_u (i32.add (global.get $console_text_base)
              (i32.mul (local.get $soff) (i32.const 2)))) (i32.const 0xff))
            (local.get $wide)))
        (i32.store16 (i32.add (local.get $doff) (i32.const 2))
          (i32.load16_u (i32.add (global.get $console_attr_base)
            (i32.mul (local.get $soff) (i32.const 2)))))
        (local.set $col (i32.add (local.get $col) (i32.const 1)))
        (br $cols)))
      (local.set $row (i32.add (local.get $row) (i32.const 1)))
      (br $rows)))
    (global.set $eax (i32.const 1))
    (call $console_buffer_finish (i32.const 0)))

  ;; ReadConsoleOutputW(hConsole, lpBuffer, dwBufferSize, dwBufferCoord, lpReadRegion) → BOOL
  (func $handle_ReadConsoleOutputW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $console_read_output
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; ReadConsoleOutputA(hConsole, lpBuffer, dwBufferSize, dwBufferCoord, lpReadRegion) → BOOL
  (func $handle_ReadConsoleOutputA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $console_read_output
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; ReadConsoleOutputAttribute(hConsole, lpAttribute, nLength, dwReadCoord, lpNumberOfAttrsRead) → BOOL
  (func $handle_ReadConsoleOutputAttribute (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $x i32) (local $y i32) (local $i i32) (local $off i32) (local $dst i32)
    (if (i32.eqz (call $console_buffer_enter (local.get $arg0)))
      (then
        (global.set $last_error (i32.const 6))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    (local.set $dst (call $g2w (local.get $arg1)))
    (local.set $x (i32.and (local.get $arg3) (i32.const 0xFFFF)))
    (local.set $y (i32.shr_u (local.get $arg3) (i32.const 16)))
    (local.set $i (i32.const 0))
    (block $done (loop $read
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $off (i32.add (i32.mul (local.get $y) (global.get $console_width)) (local.get $x)))
      (if (i32.lt_u (local.get $off) (i32.mul (global.get $console_width) (global.get $console_height)))
        (then (i32.store16 (i32.add (local.get $dst) (i32.mul (local.get $i) (i32.const 2)))
          (i32.load16_u (i32.add (global.get $console_attr_base) (i32.mul (local.get $off) (i32.const 2))))))
        (else (i32.store16 (i32.add (local.get $dst) (i32.mul (local.get $i) (i32.const 2))) (i32.const 0))))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (if (i32.ge_u (local.get $x) (global.get $console_width))
        (then (local.set $x (i32.const 0)) (local.set $y (i32.add (local.get $y) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $read)))
    (if (local.get $arg4)
      (then (i32.store (call $g2w (local.get $arg4)) (local.get $arg2))))
    (global.set $eax (i32.const 1))
    (call $console_buffer_finish (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; ScrollConsoleScreenBufferW(hConsole, lpScrollRectangle, lpClipRectangle, dwDestinationOrigin, lpFill) → BOOL
  ;; Simplified: just return success (full scroll would need temp buffer)
  (func $handle_ScrollConsoleScreenBufferW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (call $console_refresh)
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; WriteConsoleInputW(hConsole, lpBuffer, nLength, lpNumberOfEventsWritten) → BOOL
  (func $handle_WriteConsoleInputW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg3)
      (then (i32.store (call $g2w (local.get $arg3)) (local.get $arg2))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; ============================================================
  ;; CONSOLE WINDOW
  ;; ============================================================
  ;; A console is a window like any other, so it gets a real one: a WAT-native
  ;; top-level whose WM_PAINT walks CONSOLE_TEXT/CONSOLE_ATTR and draws each
  ;; run of equal attribute with the OEM fixed 8x12 strike, which is the font a
  ;; Win98 console actually uses. Without this a console app runs correctly and
  ;; shows nothing, which is what telnet.exe did.

  (global $CONSOLE_CELL_W i32 (i32.const 8))
  (global $CONSOLE_CELL_H i32 (i32.const 12))
  (global $CONSOLE_OEM_FONT i32 (i32.const 0x3001A))  ;; OEM_FIXED_FONT stock handle

  ;; The 16 CGA attribute colours, as COLORREF (0x00BBGGRR).
  (func $console_palette (param $i i32) (result i32)
    (local.set $i (i32.and (local.get $i) (i32.const 15)))
    (if (i32.eq (local.get $i) (i32.const 0))  (then (return (i32.const 0x000000))))
    (if (i32.eq (local.get $i) (i32.const 1))  (then (return (i32.const 0x800000))))
    (if (i32.eq (local.get $i) (i32.const 2))  (then (return (i32.const 0x008000))))
    (if (i32.eq (local.get $i) (i32.const 3))  (then (return (i32.const 0x808000))))
    (if (i32.eq (local.get $i) (i32.const 4))  (then (return (i32.const 0x000080))))
    (if (i32.eq (local.get $i) (i32.const 5))  (then (return (i32.const 0x800080))))
    (if (i32.eq (local.get $i) (i32.const 6))  (then (return (i32.const 0x008080))))
    (if (i32.eq (local.get $i) (i32.const 7))  (then (return (i32.const 0xC0C0C0))))
    (if (i32.eq (local.get $i) (i32.const 8))  (then (return (i32.const 0x808080))))
    (if (i32.eq (local.get $i) (i32.const 9))  (then (return (i32.const 0xFF0000))))
    (if (i32.eq (local.get $i) (i32.const 10)) (then (return (i32.const 0x00FF00))))
    (if (i32.eq (local.get $i) (i32.const 11)) (then (return (i32.const 0xFFFF00))))
    (if (i32.eq (local.get $i) (i32.const 12)) (then (return (i32.const 0x0000FF))))
    (if (i32.eq (local.get $i) (i32.const 13)) (then (return (i32.const 0xFF00FF))))
    (if (i32.eq (local.get $i) (i32.const 14)) (then (return (i32.const 0x00FFFF))))
    (i32.const 0xFFFFFF))

  ;; Blank every cell to a space in the current attribute. A screen buffer
  ;; starts filled with spaces on Windows; leaving NULs there would make the
  ;; painter draw the NUL glyph across the whole window.
  (func $console_clear_cells
    (local $i i32) (local $cells i32)
    (local.set $cells (i32.mul (global.get $console_width) (global.get $console_height)))
    (if (i32.gt_u (local.get $cells) (global.get $CONSOLE_MAX_CELLS))
      (then (local.set $cells (global.get $CONSOLE_MAX_CELLS))))
    (block $done (loop $fill
      (br_if $done (i32.ge_u (local.get $i) (local.get $cells)))
      (i32.store16 (i32.add (global.get $console_text_base)
        (i32.mul (local.get $i) (i32.const 2))) (i32.const 32))
      (i32.store16 (i32.add (global.get $console_attr_base)
        (i32.mul (local.get $i) (i32.const 2))) (global.get $console_attr))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $fill)))
    (global.set $console_cells_ready (i32.const 1)))

  ;; Paint one row as runs of equal attribute. TextOut in OPAQUE mode paints
  ;; the run's background itself, so the cells come out right without a brush
  ;; per run. The row's characters are already contiguous UTF-16, which is
  ;; exactly what the wide text path wants.
  (func $console_paint_row (param $hdc i32) (param $row i32)
    (local $col i32) (local $start i32) (local $attr i32) (local $base i32)
    (local $cell i32) (local $win i32) (local $width i32)
    (local.set $win (call $console_loaded_window_record))
    (local.set $width (call $console_window_width))
    (local.set $base
      (i32.add
        (i32.mul
          (i32.add (local.get $row) (i32.load16_s offset=2 (local.get $win)))
          (global.get $console_width))
        (i32.load16_s (local.get $win))))
    (local.set $col (i32.const 0))
    (local.set $start (i32.const 0))
    (local.set $attr (i32.load16_u (i32.add (global.get $console_attr_base)
      (i32.mul (local.get $base) (i32.const 2)))))
    (block $done (loop $scan
      (if (i32.ge_u (local.get $col) (local.get $width))
        (then
          (call $console_draw_run (local.get $hdc) (local.get $row)
            (local.get $start) (i32.sub (local.get $col) (local.get $start))
            (local.get $attr) (local.get $base))
          (br $done)))
      (local.set $cell (i32.load16_u (i32.add (global.get $console_attr_base)
        (i32.mul (i32.add (local.get $base) (local.get $col)) (i32.const 2)))))
      (if (i32.ne (local.get $cell) (local.get $attr))
        (then
          (call $console_draw_run (local.get $hdc) (local.get $row)
            (local.get $start) (i32.sub (local.get $col) (local.get $start))
            (local.get $attr) (local.get $base))
          (local.set $start (local.get $col))
          (local.set $attr (local.get $cell))))
      (local.set $col (i32.add (local.get $col) (i32.const 1)))
      (br $scan))))

  (func $console_draw_run (param $hdc i32) (param $row i32) (param $col i32)
                          (param $len i32) (param $attr i32) (param $base i32)
    (if (i32.eqz (local.get $len)) (then (return)))
    (drop (call $host_gdi_set_text_color (local.get $hdc)
      (call $console_palette (local.get $attr))))
    (drop (call $host_gdi_set_bk_color (local.get $hdc)
      (call $console_palette (i32.shr_u (local.get $attr) (i32.const 4)))))
    (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 2)))  ;; OPAQUE
    (drop (call $host_gdi_text_out (local.get $hdc)
      (i32.mul (local.get $col) (global.get $CONSOLE_CELL_W))
      (i32.mul (local.get $row) (global.get $CONSOLE_CELL_H))
      (i32.add (global.get $console_text_base)
        (i32.mul (i32.add (local.get $base) (local.get $col)) (i32.const 2)))
      (local.get $len) (i32.const 1))))

  (func $console_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32)
                         (param $lParam i32) (result i32)
    (local $hdc i32) (local $row i32) (local $brush i32)
    (local $window_width i32) (local $window_height i32)
    ;; WM_PAINT
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        (drop (call $console_buffer_load
          (i32.load (global.get $CONSOLE_BUFFER_ACTIVE))))
        (local.set $window_width (call $console_window_width))
        (local.set $window_height (call $console_window_height))
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        ;; Ground the whole client in the current background attribute first,
        ;; so a buffer shorter than the window does not show through.
        (local.set $brush (call $host_gdi_create_solid_brush
          (call $console_palette (i32.shr_u (global.get $console_attr) (i32.const 4)))))
        (drop (call $host_gdi_fill_rect (local.get $hdc) (i32.const 0) (i32.const 0)
          (i32.mul (local.get $window_width) (global.get $CONSOLE_CELL_W))
          (i32.mul (local.get $window_height) (global.get $CONSOLE_CELL_H))
          (local.get $brush)))
        (drop (call $host_gdi_delete_object (local.get $brush)))
        ;; Field 88 is the DC's font (default SYSTEM_FONT 0x3001D); field 84
        ;; is its bitmap. OEM_FIXED_FONT is the 8x12 Terminal strike, which is
        ;; what makes the cell grid line up.
        (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 88)
          (global.get $CONSOLE_OEM_FONT) (i32.const 0x3001D)))
        (local.set $row (i32.const 0))
        (block $done (loop $rows
          (br_if $done (i32.ge_u (local.get $row) (local.get $window_height)))
          (call $console_paint_row (local.get $hdc) (local.get $row))
          (local.set $row (i32.add (local.get $row) (i32.const 1)))
          (br $rows)))
        (return (i32.const 0))))
    ;; WM_ERASEBKGND — WM_PAINT grounds the client itself.
    (if (i32.eq (local.get $msg) (i32.const 0x0014)) (then (return (i32.const 1))))
    (if (call $console_input_mouse_message
          (local.get $msg) (local.get $wParam) (local.get $lParam))
      (then (return (i32.const 0))))
    ;; WM_CHAR/WM_SYSCHAR supplies the translated character for the hardware
    ;; down record already queued by WM_KEYDOWN/WM_SYSKEYDOWN.
    (if (i32.or (i32.eq (local.get $msg) (i32.const 0x0102))
                (i32.eq (local.get $msg) (i32.const 0x0106)))
      (then
        (call $console_input_attach_char
          (local.get $wParam) (call $console_vk_for_char (local.get $wParam)))
        (return (i32.const 0))))
    ;; Preserve both hardware edges. Printable WM_CHAR is merged above rather
    ;; than becoming a duplicate record.
    (if (call $console_input_push_host_key
          (local.get $msg) (local.get $wParam) (local.get $lParam))
      (then
        (return (i32.const 0))))
    (i32.const 0))

  ;; Best-effort virtual key for an echoed character. Only ReadConsoleInput
  ;; callers see this field, and WM_CHAR has already discarded the real one.
  (func $console_vk_for_char (param $ch i32) (result i32)
    (if (i32.and (i32.ge_u (local.get $ch) (i32.const 97))
                 (i32.le_u (local.get $ch) (i32.const 122)))
      (then (return (i32.sub (local.get $ch) (i32.const 32)))))
    (if (i32.or
          (i32.and (i32.ge_u (local.get $ch) (i32.const 65)) (i32.le_u (local.get $ch) (i32.const 90)))
          (i32.and (i32.ge_u (local.get $ch) (i32.const 48)) (i32.le_u (local.get $ch) (i32.const 57))))
      (then (return (local.get $ch))))
    (if (i32.eq (local.get $ch) (i32.const 13)) (then (return (i32.const 0x0D))))
    (if (i32.eq (local.get $ch) (i32.const 8)) (then (return (i32.const 0x08))))
    (if (i32.eq (local.get $ch) (i32.const 9)) (then (return (i32.const 0x09))))
    (if (i32.eq (local.get $ch) (i32.const 27)) (then (return (i32.const 0x1B))))
    (if (i32.eq (local.get $ch) (i32.const 32)) (then (return (i32.const 0x20))))
    ;; Shifted number-row characters retain the physical digit VK.
    (if (i32.eq (local.get $ch) (i32.const 0x29)) (then (return (i32.const 0x30)))) ;; )
    (if (i32.eq (local.get $ch) (i32.const 0x21)) (then (return (i32.const 0x31)))) ;; !
    (if (i32.eq (local.get $ch) (i32.const 0x40)) (then (return (i32.const 0x32)))) ;; @
    (if (i32.eq (local.get $ch) (i32.const 0x23)) (then (return (i32.const 0x33)))) ;; #
    (if (i32.eq (local.get $ch) (i32.const 0x24)) (then (return (i32.const 0x34)))) ;; $
    (if (i32.eq (local.get $ch) (i32.const 0x25)) (then (return (i32.const 0x35)))) ;; %
    (if (i32.eq (local.get $ch) (i32.const 0x5E)) (then (return (i32.const 0x36)))) ;; ^
    (if (i32.eq (local.get $ch) (i32.const 0x26)) (then (return (i32.const 0x37)))) ;; &
    (if (i32.eq (local.get $ch) (i32.const 0x2A)) (then (return (i32.const 0x38)))) ;; *
    (if (i32.eq (local.get $ch) (i32.const 0x28)) (then (return (i32.const 0x39)))) ;; (
    ;; OEM punctuation keys, shifted or unshifted.
    (if (i32.or (i32.eq (local.get $ch) (i32.const 0x3B))
                (i32.eq (local.get $ch) (i32.const 0x3A)))
      (then (return (i32.const 0xBA)))) ;; ; :
    (if (i32.or (i32.eq (local.get $ch) (i32.const 0x3D))
                (i32.eq (local.get $ch) (i32.const 0x2B)))
      (then (return (i32.const 0xBB)))) ;; = +
    (if (i32.or (i32.eq (local.get $ch) (i32.const 0x2C))
                (i32.eq (local.get $ch) (i32.const 0x3C)))
      (then (return (i32.const 0xBC)))) ;; , <
    (if (i32.or (i32.eq (local.get $ch) (i32.const 0x2D))
                (i32.eq (local.get $ch) (i32.const 0x5F)))
      (then (return (i32.const 0xBD)))) ;; - _
    (if (i32.or (i32.eq (local.get $ch) (i32.const 0x2E))
                (i32.eq (local.get $ch) (i32.const 0x3E)))
      (then (return (i32.const 0xBE)))) ;; . >
    (if (i32.or (i32.eq (local.get $ch) (i32.const 0x2F))
                (i32.eq (local.get $ch) (i32.const 0x3F)))
      (then (return (i32.const 0xBF)))) ;; / ?
    (if (i32.or (i32.eq (local.get $ch) (i32.const 0x60))
                (i32.eq (local.get $ch) (i32.const 0x7E)))
      (then (return (i32.const 0xC0)))) ;; ` ~
    (if (i32.or (i32.eq (local.get $ch) (i32.const 0x5B))
                (i32.eq (local.get $ch) (i32.const 0x7B)))
      (then (return (i32.const 0xDB)))) ;; [ {
    (if (i32.or (i32.eq (local.get $ch) (i32.const 0x5C))
                (i32.eq (local.get $ch) (i32.const 0x7C)))
      (then (return (i32.const 0xDC)))) ;; \ |
    (if (i32.or (i32.eq (local.get $ch) (i32.const 0x5D))
                (i32.eq (local.get $ch) (i32.const 0x7D)))
      (then (return (i32.const 0xDD)))) ;; ] }
    (if (i32.or (i32.eq (local.get $ch) (i32.const 0x27))
                (i32.eq (local.get $ch) (i32.const 0x22)))
      (then (return (i32.const 0xDE)))) ;; ' "
    (i32.const 0))

  ;; Create the console window on first output. Console dimensions describe
  ;; the CLIENT in character cells, while CreateWindow receives an OUTER size.
  ;; WS_OVERLAPPEDWINDOW has a 4px Win98 sizing frame on each side, plus the
  ;; 19px caption and the extra 1px below it used by our DefWindowProc metrics:
  ;; add 8 horizontally and 28 vertically. Passing the bare cell dimensions
  ;; clipped the last two Far Manager rows behind the browser window chrome.
  ;;
  ;; Sized to the visible viewport, so a larger backing buffer scrolls without
  ;; turning the browser window into the full buffer.
  ;; Blank the buffer once, before anything is written into it. Doing this at
  ;; window-creation time instead would erase the very output that triggered
  ;; the window.
  (func $console_cells_ensure
    (if (i32.eqz (global.get $console_cells_ready)) (then (call $console_clear_cells))))

  (func $console_ensure_window
    (local $hwnd i32)
    (call $console_title_ensure)
    (if (global.get $console_hwnd) (then (return)))
    ;; Another thread may already have created it — WND_RECORDS is shared, so
    ;; adopt that window rather than opening a second one.
    (if (call $console_shared_hwnd)
      (then
        (global.set $console_hwnd (call $console_shared_hwnd))
        (return)))
    (call $console_cells_ensure)
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    ;; Register before the host creates the window: $host_create_window
    ;; composites immediately and that pass binds the client DC to the HWND
    ;; only if the HWND is already in WND_RECORDS.
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_CONSOLE_NATIVE))
    (drop (call $wnd_set_style (local.get $hwnd) (i32.const 0x10CF0000)))
    (global.set $console_hwnd (local.get $hwnd))
    (call $console_shared_hwnd_set (local.get $hwnd))
    (drop (call $host_create_window
      (local.get $hwnd)
      (i32.const 0x10CF0000)   ;; WS_OVERLAPPEDWINDOW | WS_VISIBLE
      ;; Start flush with the left desktop edge. An 80-column 8px client is
      ;; already screen-wide at 640px; cascading it would hide another full
      ;; character column in addition to the unavoidable outer frame.
      (i32.const 0) (i32.const 8)
      (i32.add
        (i32.mul (call $console_window_width) (global.get $CONSOLE_CELL_W))
        (i32.const 8))
      (i32.add
        (i32.mul (call $console_window_height) (global.get $CONSOLE_CELL_H))
        (i32.const 28))
      (global.get $CONSOLE_TITLE_STORAGE) (i32.const 0)))
    (call $title_table_set (local.get $hwnd) (global.get $CONSOLE_TITLE_STORAGE)
      (call $strlen (global.get $CONSOLE_TITLE_STORAGE)))
    (call $defwndproc_do_nccalcsize (local.get $hwnd))
    (call $defwndproc_do_ncpaint (local.get $hwnd))
    (drop (call $gdi_dc_set_field
      (i32.add (local.get $hwnd) (i32.const 0x40000))
      (i32.const 92) (local.get $hwnd) (i32.const 0)))
    (drop (call $console_wndproc (local.get $hwnd) (i32.const 0x000F)
      (i32.const 0) (i32.const 0))))

  ;; Apply the active viewport's client dimensions to an existing console
  ;; window. SWP_NOMOVE preserves its desktop position; the remaining flags
  ;; match Win32's no-z-order/no-activation resize.
  (func $console_resize_window
    (local $width i32) (local $height i32) (local $current i32)
    (if (i32.eqz (global.get $console_hwnd)) (then (return)))
    (local.set $width (i32.mul (call $console_window_width)
      (global.get $CONSOLE_CELL_W)))
    (local.set $height (i32.mul (call $console_window_height)
      (global.get $CONSOLE_CELL_H)))
    ;; Ordinary writes refresh often; do not turn them into redundant USER
    ;; geometry operations when only cell contents changed.
    (local.set $current (call $host_get_window_client_size
      (global.get $console_hwnd)))
    (if (i32.and
          (i32.eq (i32.and (local.get $current) (i32.const 0xFFFF))
                  (local.get $width))
          (i32.eq (i32.shr_u (local.get $current) (i32.const 16))
                  (local.get $height)))
      (then (return)))
    (call $host_move_window
      (global.get $console_hwnd) (i32.const 0) (i32.const 0)
      (i32.add (local.get $width) (i32.const 8))
      (i32.add (local.get $height) (i32.const 28))
      (i32.const 0x16)) ;; SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE
    (call $defwndproc_do_nccalcsize (global.get $console_hwnd))
    (call $host_sync_window_client
      (global.get $console_hwnd)
      (call $wnd_client_screen_x (global.get $console_hwnd))
      (call $wnd_client_screen_y (global.get $console_hwnd))
      (local.get $width) (local.get $height)))

  ;; Called after anything changes the screen buffer.
  (func $console_refresh
    (call $console_ensure_window)
    (call $console_resize_window)
    (drop (call $console_wndproc (global.get $console_hwnd) (i32.const 0x000F)
      (i32.const 0) (i32.const 0))))
