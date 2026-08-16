  ;; ============================================================
  ;; CONSOLE API HANDLERS
  ;; ============================================================

  ;; 823: GetConsoleScreenBufferInfo(hConsole, lpInfo) → BOOL
  (func $handle_GetConsoleScreenBufferInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p i32)
    (local.set $p (call $g2w (local.get $arg1)))
    ;; dwSize.X, dwSize.Y
    (i32.store16 (local.get $p) (global.get $console_width))
    (i32.store16 (i32.add (local.get $p) (i32.const 2)) (global.get $console_height))
    ;; dwCursorPosition.X, Y
    (i32.store16 (i32.add (local.get $p) (i32.const 4)) (global.get $console_cursor_x))
    (i32.store16 (i32.add (local.get $p) (i32.const 6)) (global.get $console_cursor_y))
    ;; wAttributes
    (i32.store16 (i32.add (local.get $p) (i32.const 8)) (global.get $console_attr))
    ;; srWindow: left=0, top=0, right=width-1, bottom=height-1
    (i32.store16 (i32.add (local.get $p) (i32.const 10)) (i32.const 0))
    (i32.store16 (i32.add (local.get $p) (i32.const 12)) (i32.const 0))
    (i32.store16 (i32.add (local.get $p) (i32.const 14)) (i32.sub (global.get $console_width) (i32.const 1)))
    (i32.store16 (i32.add (local.get $p) (i32.const 16)) (i32.sub (global.get $console_height) (i32.const 1)))
    ;; dwMaximumWindowSize
    (i32.store16 (i32.add (local.get $p) (i32.const 18)) (global.get $console_width))
    (i32.store16 (i32.add (local.get $p) (i32.const 20)) (global.get $console_height))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; --- Console API handlers ---

  ;; SetConsoleScreenBufferSize(hConsole, dwSize) → BOOL
  ;; dwSize is COORD packed as i32: loword=X, hiword=Y
  (func $handle_SetConsoleScreenBufferSize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $console_width (i32.and (local.get $arg1) (i32.const 0xFFFF)))
    (global.set $console_height (i32.shr_u (local.get $arg1) (i32.const 16)))
    ;; Refuse a buffer the CONSOLE_TEXT/ATTR region cannot hold rather than
    ;; letting later writes run past it.
    (if (i32.gt_u (i32.mul (global.get $console_width) (global.get $console_height))
                  (global.get $CONSOLE_MAX_CELLS))
      (then
        (global.set $console_width (i32.const 80))
        (global.set $console_height (i32.const 25))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; SetConsoleActiveScreenBuffer(hConsole) → BOOL
  (func $handle_SetConsoleActiveScreenBuffer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $console_handle (local.get $arg0))
    (global.set $eax (i32.const 1))
    (call $console_refresh)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; SetConsoleCursorPosition(hConsole, dwCursorPosition) → BOOL
  ;; dwCursorPosition is COORD packed: loword=X, hiword=Y
  (func $handle_SetConsoleCursorPosition (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $console_cursor_x (i32.and (local.get $arg1) (i32.const 0xFFFF)))
    (global.set $console_cursor_y (i32.shr_u (local.get $arg1) (i32.const 16)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; SetConsoleCursorInfo(hConsole, lpConsoleCursorInfo) → BOOL
  (func $handle_SetConsoleCursorInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p i32)
    (local.set $p (call $g2w (local.get $arg1)))
    (global.set $console_cursor_size (i32.load (local.get $p)))
    (global.set $console_cursor_visible (i32.load (i32.add (local.get $p) (i32.const 4))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; GetConsoleCursorInfo(hConsole, lpConsoleCursorInfo) → BOOL
  (func $handle_GetConsoleCursorInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p i32)
    (local.set $p (call $g2w (local.get $arg1)))
    (i32.store (local.get $p) (global.get $console_cursor_size))
    (i32.store (i32.add (local.get $p) (i32.const 4)) (global.get $console_cursor_visible))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; SetConsoleTitleW(lpConsoleTitle) → BOOL
  (func $handle_SetConsoleTitleW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; SetConsoleWindowInfo(hConsole, bAbsolute, lpConsoleWindow) → BOOL
  (func $handle_SetConsoleWindowInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
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
    (call $console_cells_ensure)
    (local.set $x (i32.and (local.get $arg3) (i32.const 0xFFFF)))
    (local.set $y (i32.shr_u (local.get $arg3) (i32.const 16)))
    (local.set $i (i32.const 0))
    (block $done (loop $fill
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $off (i32.add (i32.mul (local.get $y) (global.get $console_width)) (local.get $x)))
      (if (i32.lt_u (local.get $off) (i32.mul (global.get $console_width) (global.get $console_height)))
        (then (i32.store16 (i32.add (global.get $CONSOLE_TEXT) (i32.mul (local.get $off) (i32.const 2))) (local.get $arg1))))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (if (i32.ge_u (local.get $x) (global.get $console_width))
        (then (local.set $x (i32.const 0)) (local.set $y (i32.add (local.get $y) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $fill)))
    ;; Write count to lpNumberOfCharsWritten
    (if (local.get $arg4)
      (then (i32.store (call $g2w (local.get $arg4)) (local.get $arg2))))
    (global.set $eax (i32.const 1))
    (call $console_refresh)
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; FillConsoleOutputAttribute(hConsole, wAttribute, nLength, dwWriteCoord, lpNumberOfAttrsWritten) → BOOL
  (func $handle_FillConsoleOutputAttribute (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $x i32) (local $y i32) (local $i i32) (local $off i32)
    (call $console_cells_ensure)
    (local.set $x (i32.and (local.get $arg3) (i32.const 0xFFFF)))
    (local.set $y (i32.shr_u (local.get $arg3) (i32.const 16)))
    (local.set $i (i32.const 0))
    (block $done (loop $fill
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $off (i32.add (i32.mul (local.get $y) (global.get $console_width)) (local.get $x)))
      (if (i32.lt_u (local.get $off) (i32.mul (global.get $console_width) (global.get $console_height)))
        (then (i32.store16 (i32.add (global.get $CONSOLE_ATTR) (i32.mul (local.get $off) (i32.const 2))) (local.get $arg1))))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (if (i32.ge_u (local.get $x) (global.get $console_width))
        (then (local.set $x (i32.const 0)) (local.set $y (i32.add (local.get $y) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $fill)))
    (if (local.get $arg4)
      (then (i32.store (call $g2w (local.get $arg4)) (local.get $arg2))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; WriteConsoleW(hConsole, lpBuffer, nNumberOfCharsToWrite, lpNumberOfCharsWritten, lpReserved) → BOOL
  ;; Writes UTF-16 chars to console buffer at cursor position, advancing cursor
  (func $handle_WriteConsoleW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $i i32) (local $ch i32) (local $off i32) (local $src i32)
    (call $console_cells_ensure)
    (local.set $src (call $g2w (local.get $arg1)))
    (local.set $i (i32.const 0))
    (block $done (loop $write
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $ch (i32.load16_u (i32.add (local.get $src) (i32.mul (local.get $i) (i32.const 2)))))
      (if (i32.eq (local.get $ch) (i32.const 10)) ;; newline
        (then
          (global.set $console_cursor_x (i32.const 0))
          (global.set $console_cursor_y (i32.add (global.get $console_cursor_y) (i32.const 1))))
        (else (if (i32.eq (local.get $ch) (i32.const 13)) ;; carriage return
          (then (global.set $console_cursor_x (i32.const 0)))
          (else
            (local.set $off (i32.add (i32.mul (global.get $console_cursor_y) (global.get $console_width)) (global.get $console_cursor_x)))
            (if (i32.lt_u (local.get $off) (i32.mul (global.get $console_width) (global.get $console_height)))
              (then
                (i32.store16 (i32.add (global.get $CONSOLE_TEXT) (i32.mul (local.get $off) (i32.const 2))) (local.get $ch))
                (i32.store16 (i32.add (global.get $CONSOLE_ATTR) (i32.mul (local.get $off) (i32.const 2))) (global.get $console_attr))))
            (global.set $console_cursor_x (i32.add (global.get $console_cursor_x) (i32.const 1)))
            (if (i32.ge_u (global.get $console_cursor_x) (global.get $console_width))
              (then
                (global.set $console_cursor_x (i32.const 0))
                (global.set $console_cursor_y (i32.add (global.get $console_cursor_y) (i32.const 1)))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $write)))
    (if (local.get $arg3)
      (then (i32.store (call $g2w (local.get $arg3)) (local.get $arg2))))
    (global.set $eax (i32.const 1))
    (call $console_refresh)
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; WriteConsoleOutputW(hConsole, lpBuffer, dwBufferSize, dwBufferCoord, lpWriteRegion) → BOOL
  ;; Writes CHAR_INFO array (4 bytes each: wchar + attributes) to a rectangular region
  (func $handle_WriteConsoleOutputW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $src i32) (local $bw i32) (local $bh i32) (local $bx i32) (local $by i32)
    (local $rgn i32) (local $left i32) (local $top i32) (local $right i32) (local $bottom i32)
    (local $row i32) (local $col i32) (local $soff i32) (local $doff i32)
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
            (i32.store16 (i32.add (global.get $CONSOLE_TEXT) (i32.mul (local.get $doff) (i32.const 2)))
              (i32.load16_u (local.get $soff)))
            (i32.store16 (i32.add (global.get $CONSOLE_ATTR) (i32.mul (local.get $doff) (i32.const 2)))
              (i32.load16_u (i32.add (local.get $soff) (i32.const 2))))))
        (local.set $col (i32.add (local.get $col) (i32.const 1)))
        (br $cols)))
      (local.set $row (i32.add (local.get $row) (i32.const 1)))
      (br $rows)))
    (global.set $eax (i32.const 1))
    (call $console_refresh)
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; WriteConsoleOutputCharacterA(hConsole, lpCharacter, nLength, dwWriteCoord, lpNumberOfCharsWritten) → BOOL
  (func $handle_WriteConsoleOutputCharacterA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $x i32) (local $y i32) (local $i i32) (local $off i32) (local $src i32)
    (call $console_cells_ensure)
    (local.set $src (call $g2w (local.get $arg1)))
    (local.set $x (i32.and (local.get $arg3) (i32.const 0xFFFF)))
    (local.set $y (i32.shr_u (local.get $arg3) (i32.const 16)))
    (local.set $i (i32.const 0))
    (block $done (loop $fill
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $off (i32.add (i32.mul (local.get $y) (global.get $console_width)) (local.get $x)))
      (if (i32.lt_u (local.get $off) (i32.mul (global.get $console_width) (global.get $console_height)))
        (then (i32.store16 (i32.add (global.get $CONSOLE_TEXT) (i32.mul (local.get $off) (i32.const 2)))
          (i32.load8_u (i32.add (local.get $src) (local.get $i))))))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (if (i32.ge_u (local.get $x) (global.get $console_width))
        (then (local.set $x (i32.const 0)) (local.set $y (i32.add (local.get $y) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $fill)))
    (if (local.get $arg4)
      (then (i32.store (call $g2w (local.get $arg4)) (local.get $arg2))))
    (global.set $eax (i32.const 1))
    (call $console_refresh)
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; WriteConsoleOutputAttribute(hConsole, lpAttribute, nLength, dwWriteCoord, lpNumberOfAttrsWritten) → BOOL
  (func $handle_WriteConsoleOutputAttribute (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $x i32) (local $y i32) (local $i i32) (local $off i32) (local $src i32)
    (call $console_cells_ensure)
    (local.set $src (call $g2w (local.get $arg1)))
    (local.set $x (i32.and (local.get $arg3) (i32.const 0xFFFF)))
    (local.set $y (i32.shr_u (local.get $arg3) (i32.const 16)))
    (local.set $i (i32.const 0))
    (block $done (loop $fill
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $off (i32.add (i32.mul (local.get $y) (global.get $console_width)) (local.get $x)))
      (if (i32.lt_u (local.get $off) (i32.mul (global.get $console_width) (global.get $console_height)))
        (then (i32.store16 (i32.add (global.get $CONSOLE_ATTR) (i32.mul (local.get $off) (i32.const 2)))
          (i32.load16_u (i32.add (local.get $src) (i32.mul (local.get $i) (i32.const 2)))))))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (if (i32.ge_u (local.get $x) (global.get $console_width))
        (then (local.set $x (i32.const 0)) (local.set $y (i32.add (local.get $y) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $fill)))
    (if (local.get $arg4)
      (then (i32.store (call $g2w (local.get $arg4)) (local.get $arg2))))
    (global.set $eax (i32.const 1))
    (call $console_refresh)
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; ReadConsoleW(hConsole, lpBuffer, nNumberOfCharsToRead, lpNumberOfCharsRead, pInputControl) → BOOL
  ;; No input available — return 0 chars read
  (func $handle_ReadConsoleW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg3)
      (then (i32.store (call $g2w (local.get $arg3)) (i32.const 0))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; ReadConsoleInputW — same as A version
  (func $handle_ReadConsoleInputW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg3)
      (then (i32.store (call $g2w (local.get $arg3)) (i32.const 0))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; ReadConsoleOutputW(hConsole, lpBuffer, dwBufferSize, dwBufferCoord, lpReadRegion) → BOOL
  ;; Read CHAR_INFO from console buffer
  (func $handle_ReadConsoleOutputW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32) (local $bw i32) (local $bx i32) (local $by i32)
    (local $rgn i32) (local $left i32) (local $top i32) (local $right i32) (local $bottom i32)
    (local $row i32) (local $col i32) (local $doff i32) (local $soff i32)
    (local.set $dst (call $g2w (local.get $arg1)))
    (local.set $bw (i32.and (local.get $arg2) (i32.const 0xFFFF)))
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
        (local.set $soff (i32.add (i32.mul (local.get $row) (global.get $console_width)) (local.get $col)))
        (local.set $doff (i32.add (local.get $dst)
          (i32.mul (i32.const 4)
            (i32.add
              (i32.mul (i32.add (i32.sub (local.get $row) (local.get $top)) (local.get $by)) (local.get $bw))
              (i32.add (i32.sub (local.get $col) (local.get $left)) (local.get $bx))))))
        (if (i32.lt_u (local.get $soff) (i32.mul (global.get $console_width) (global.get $console_height)))
          (then
            (i32.store16 (local.get $doff)
              (i32.load16_u (i32.add (global.get $CONSOLE_TEXT) (i32.mul (local.get $soff) (i32.const 2)))))
            (i32.store16 (i32.add (local.get $doff) (i32.const 2))
              (i32.load16_u (i32.add (global.get $CONSOLE_ATTR) (i32.mul (local.get $soff) (i32.const 2))))))
          (else
            (i32.store (local.get $doff) (i32.const 0))))
        (local.set $col (i32.add (local.get $col) (i32.const 1)))
        (br $cols)))
      (local.set $row (i32.add (local.get $row) (i32.const 1)))
      (br $rows)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; ReadConsoleOutputAttribute(hConsole, lpAttribute, nLength, dwReadCoord, lpNumberOfAttrsRead) → BOOL
  (func $handle_ReadConsoleOutputAttribute (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $x i32) (local $y i32) (local $i i32) (local $off i32) (local $dst i32)
    (local.set $dst (call $g2w (local.get $arg1)))
    (local.set $x (i32.and (local.get $arg3) (i32.const 0xFFFF)))
    (local.set $y (i32.shr_u (local.get $arg3) (i32.const 16)))
    (local.set $i (i32.const 0))
    (block $done (loop $read
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $off (i32.add (i32.mul (local.get $y) (global.get $console_width)) (local.get $x)))
      (if (i32.lt_u (local.get $off) (i32.mul (global.get $console_width) (global.get $console_height)))
        (then (i32.store16 (i32.add (local.get $dst) (i32.mul (local.get $i) (i32.const 2)))
          (i32.load16_u (i32.add (global.get $CONSOLE_ATTR) (i32.mul (local.get $off) (i32.const 2))))))
        (else (i32.store16 (i32.add (local.get $dst) (i32.mul (local.get $i) (i32.const 2))) (i32.const 0))))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (if (i32.ge_u (local.get $x) (global.get $console_width))
        (then (local.set $x (i32.const 0)) (local.set $y (i32.add (local.get $y) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $read)))
    (if (local.get $arg4)
      (then (i32.store (call $g2w (local.get $arg4)) (local.get $arg2))))
    (global.set $eax (i32.const 1))
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
      (i32.store16 (i32.add (global.get $CONSOLE_TEXT)
        (i32.mul (local.get $i) (i32.const 2))) (i32.const 32))
      (i32.store16 (i32.add (global.get $CONSOLE_ATTR)
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
    (local $cell i32)
    (local.set $base (i32.mul (local.get $row) (global.get $console_width)))
    (local.set $col (i32.const 0))
    (local.set $start (i32.const 0))
    (local.set $attr (i32.load16_u (i32.add (global.get $CONSOLE_ATTR)
      (i32.mul (local.get $base) (i32.const 2)))))
    (block $done (loop $scan
      (if (i32.ge_u (local.get $col) (global.get $console_width))
        (then
          (call $console_draw_run (local.get $hdc) (local.get $row)
            (local.get $start) (i32.sub (local.get $col) (local.get $start))
            (local.get $attr))
          (br $done)))
      (local.set $cell (i32.load16_u (i32.add (global.get $CONSOLE_ATTR)
        (i32.mul (i32.add (local.get $base) (local.get $col)) (i32.const 2)))))
      (if (i32.ne (local.get $cell) (local.get $attr))
        (then
          (call $console_draw_run (local.get $hdc) (local.get $row)
            (local.get $start) (i32.sub (local.get $col) (local.get $start))
            (local.get $attr))
          (local.set $start (local.get $col))
          (local.set $attr (local.get $cell))))
      (local.set $col (i32.add (local.get $col) (i32.const 1)))
      (br $scan))))

  (func $console_draw_run (param $hdc i32) (param $row i32) (param $col i32)
                          (param $len i32) (param $attr i32)
    (if (i32.eqz (local.get $len)) (then (return)))
    (drop (call $host_gdi_set_text_color (local.get $hdc)
      (call $console_palette (local.get $attr))))
    (drop (call $host_gdi_set_bk_color (local.get $hdc)
      (call $console_palette (i32.shr_u (local.get $attr) (i32.const 4)))))
    (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 2)))  ;; OPAQUE
    (drop (call $host_gdi_text_out (local.get $hdc)
      (i32.mul (local.get $col) (global.get $CONSOLE_CELL_W))
      (i32.mul (local.get $row) (global.get $CONSOLE_CELL_H))
      (i32.add (global.get $CONSOLE_TEXT)
        (i32.mul (i32.add (i32.mul (local.get $row) (global.get $console_width))
                          (local.get $col)) (i32.const 2)))
      (local.get $len) (i32.const 1))))

  (func $console_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32)
                         (param $lParam i32) (result i32)
    (local $hdc i32) (local $row i32) (local $brush i32)
    ;; WM_PAINT
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
        ;; Ground the whole client in the current background attribute first,
        ;; so a buffer shorter than the window does not show through.
        (local.set $brush (call $host_gdi_create_solid_brush
          (call $console_palette (i32.shr_u (global.get $console_attr) (i32.const 4)))))
        (drop (call $host_gdi_fill_rect (local.get $hdc) (i32.const 0) (i32.const 0)
          (i32.mul (global.get $console_width) (global.get $CONSOLE_CELL_W))
          (i32.mul (global.get $console_height) (global.get $CONSOLE_CELL_H))
          (local.get $brush)))
        (drop (call $host_gdi_delete_object (local.get $brush)))
        ;; Field 88 is the DC's font (default SYSTEM_FONT 0x3001D); field 84
        ;; is its bitmap. OEM_FIXED_FONT is the 8x12 Terminal strike, which is
        ;; what makes the cell grid line up.
        (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 88)
          (global.get $CONSOLE_OEM_FONT) (i32.const 0x3001D)))
        (local.set $row (i32.const 0))
        (block $done (loop $rows
          (br_if $done (i32.ge_u (local.get $row) (global.get $console_height)))
          (call $console_paint_row (local.get $hdc) (local.get $row))
          (local.set $row (i32.add (local.get $row) (i32.const 1)))
          (br $rows)))
        (return (i32.const 0))))
    ;; WM_ERASEBKGND — WM_PAINT grounds the client itself.
    (if (i32.eq (local.get $msg) (i32.const 0x0014)) (then (return (i32.const 1))))
    (i32.const 0))

  ;; Create the console window on first output. Sized to the buffer, so an app
  ;; that resizes its screen buffer before printing gets the window it asked for.
  ;; Blank the buffer once, before anything is written into it. Doing this at
  ;; window-creation time instead would erase the very output that triggered
  ;; the window.
  (func $console_cells_ensure
    (if (i32.eqz (global.get $console_cells_ready)) (then (call $console_clear_cells))))

  (func $console_ensure_window
    (local $hwnd i32)
    (if (global.get $console_hwnd) (then (return)))
    (call $console_cells_ensure)
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    ;; Register before the host creates the window: $host_create_window
    ;; composites immediately and that pass binds the client DC to the HWND
    ;; only if the HWND is already in WND_RECORDS.
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_CONSOLE_NATIVE))
    (drop (call $wnd_set_style (local.get $hwnd) (i32.const 0x10CF0000)))
    (global.set $console_hwnd (local.get $hwnd))
    (drop (call $host_create_window
      (local.get $hwnd)
      (i32.const 0x10CF0000)   ;; WS_OVERLAPPEDWINDOW | WS_VISIBLE
      (i32.const 8) (i32.const 8)
      (i32.mul (global.get $console_width) (global.get $CONSOLE_CELL_W))
      (i32.mul (global.get $console_height) (global.get $CONSOLE_CELL_H))
      (global.get $CONSOLE_TITLE) (i32.const 0)))
    (call $title_table_set (local.get $hwnd) (global.get $CONSOLE_TITLE)
      (call $strlen (global.get $CONSOLE_TITLE)))
    (call $defwndproc_do_nccalcsize (local.get $hwnd))
    (call $defwndproc_do_ncpaint (local.get $hwnd))
    (drop (call $gdi_dc_set_field
      (i32.add (local.get $hwnd) (i32.const 0x40000))
      (i32.const 92) (local.get $hwnd) (i32.const 0)))
    (drop (call $console_wndproc (local.get $hwnd) (i32.const 0x000F)
      (i32.const 0) (i32.const 0))))

  ;; Called after anything changes the screen buffer.
  (func $console_refresh
    (call $console_ensure_window)
    (drop (call $console_wndproc (global.get $console_hwnd) (i32.const 0x000F)
      (i32.const 0) (i32.const 0))))
