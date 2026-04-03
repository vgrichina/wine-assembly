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
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; SetConsoleActiveScreenBuffer(hConsole) → BOOL
  (func $handle_SetConsoleActiveScreenBuffer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $console_handle (local.get $arg0))
    (global.set $eax (i32.const 1))
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
    (local.set $x (i32.and (local.get $arg3) (i32.const 0xFFFF)))
    (local.set $y (i32.shr_u (local.get $arg3) (i32.const 16)))
    (local.set $i (i32.const 0))
    (block $done (loop $fill
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $off (i32.add (i32.mul (local.get $y) (global.get $console_width)) (local.get $x)))
      (if (i32.lt_u (local.get $off) (i32.mul (global.get $console_width) (global.get $console_height)))
        (then (i32.store16 (i32.add (i32.const 0x3000) (i32.mul (local.get $off) (i32.const 2))) (local.get $arg1))))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (if (i32.ge_u (local.get $x) (global.get $console_width))
        (then (local.set $x (i32.const 0)) (local.set $y (i32.add (local.get $y) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $fill)))
    ;; Write count to lpNumberOfCharsWritten
    (if (local.get $arg4)
      (then (i32.store (call $g2w (local.get $arg4)) (local.get $arg2))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; FillConsoleOutputAttribute(hConsole, wAttribute, nLength, dwWriteCoord, lpNumberOfAttrsWritten) → BOOL
  (func $handle_FillConsoleOutputAttribute (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $x i32) (local $y i32) (local $i i32) (local $off i32)
    (local.set $x (i32.and (local.get $arg3) (i32.const 0xFFFF)))
    (local.set $y (i32.shr_u (local.get $arg3) (i32.const 16)))
    (local.set $i (i32.const 0))
    (block $done (loop $fill
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $off (i32.add (i32.mul (local.get $y) (global.get $console_width)) (local.get $x)))
      (if (i32.lt_u (local.get $off) (i32.mul (global.get $console_width) (global.get $console_height)))
        (then (i32.store16 (i32.add (i32.const 0x3FA0) (i32.mul (local.get $off) (i32.const 2))) (local.get $arg1))))
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
                (i32.store16 (i32.add (i32.const 0x3000) (i32.mul (local.get $off) (i32.const 2))) (local.get $ch))
                (i32.store16 (i32.add (i32.const 0x3FA0) (i32.mul (local.get $off) (i32.const 2))) (global.get $console_attr))))
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
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; WriteConsoleOutputW(hConsole, lpBuffer, dwBufferSize, dwBufferCoord, lpWriteRegion) → BOOL
  ;; Writes CHAR_INFO array (4 bytes each: wchar + attributes) to a rectangular region
  (func $handle_WriteConsoleOutputW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $src i32) (local $bw i32) (local $bh i32) (local $bx i32) (local $by i32)
    (local $rgn i32) (local $left i32) (local $top i32) (local $right i32) (local $bottom i32)
    (local $row i32) (local $col i32) (local $soff i32) (local $doff i32)
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
            (i32.store16 (i32.add (i32.const 0x3000) (i32.mul (local.get $doff) (i32.const 2)))
              (i32.load16_u (local.get $soff)))
            (i32.store16 (i32.add (i32.const 0x3FA0) (i32.mul (local.get $doff) (i32.const 2)))
              (i32.load16_u (i32.add (local.get $soff) (i32.const 2))))))
        (local.set $col (i32.add (local.get $col) (i32.const 1)))
        (br $cols)))
      (local.set $row (i32.add (local.get $row) (i32.const 1)))
      (br $rows)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; WriteConsoleOutputCharacterA(hConsole, lpCharacter, nLength, dwWriteCoord, lpNumberOfCharsWritten) → BOOL
  (func $handle_WriteConsoleOutputCharacterA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $x i32) (local $y i32) (local $i i32) (local $off i32) (local $src i32)
    (local.set $src (call $g2w (local.get $arg1)))
    (local.set $x (i32.and (local.get $arg3) (i32.const 0xFFFF)))
    (local.set $y (i32.shr_u (local.get $arg3) (i32.const 16)))
    (local.set $i (i32.const 0))
    (block $done (loop $fill
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $off (i32.add (i32.mul (local.get $y) (global.get $console_width)) (local.get $x)))
      (if (i32.lt_u (local.get $off) (i32.mul (global.get $console_width) (global.get $console_height)))
        (then (i32.store16 (i32.add (i32.const 0x3000) (i32.mul (local.get $off) (i32.const 2)))
          (i32.load8_u (i32.add (local.get $src) (local.get $i))))))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (if (i32.ge_u (local.get $x) (global.get $console_width))
        (then (local.set $x (i32.const 0)) (local.set $y (i32.add (local.get $y) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $fill)))
    (if (local.get $arg4)
      (then (i32.store (call $g2w (local.get $arg4)) (local.get $arg2))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; WriteConsoleOutputAttribute(hConsole, lpAttribute, nLength, dwWriteCoord, lpNumberOfAttrsWritten) → BOOL
  (func $handle_WriteConsoleOutputAttribute (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $x i32) (local $y i32) (local $i i32) (local $off i32) (local $src i32)
    (local.set $src (call $g2w (local.get $arg1)))
    (local.set $x (i32.and (local.get $arg3) (i32.const 0xFFFF)))
    (local.set $y (i32.shr_u (local.get $arg3) (i32.const 16)))
    (local.set $i (i32.const 0))
    (block $done (loop $fill
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $off (i32.add (i32.mul (local.get $y) (global.get $console_width)) (local.get $x)))
      (if (i32.lt_u (local.get $off) (i32.mul (global.get $console_width) (global.get $console_height)))
        (then (i32.store16 (i32.add (i32.const 0x3FA0) (i32.mul (local.get $off) (i32.const 2)))
          (i32.load16_u (i32.add (local.get $src) (i32.mul (local.get $i) (i32.const 2)))))))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (if (i32.ge_u (local.get $x) (global.get $console_width))
        (then (local.set $x (i32.const 0)) (local.set $y (i32.add (local.get $y) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $fill)))
    (if (local.get $arg4)
      (then (i32.store (call $g2w (local.get $arg4)) (local.get $arg2))))
    (global.set $eax (i32.const 1))
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
              (i32.load16_u (i32.add (i32.const 0x3000) (i32.mul (local.get $soff) (i32.const 2)))))
            (i32.store16 (i32.add (local.get $doff) (i32.const 2))
              (i32.load16_u (i32.add (i32.const 0x3FA0) (i32.mul (local.get $soff) (i32.const 2))))))
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
          (i32.load16_u (i32.add (i32.const 0x3FA0) (i32.mul (local.get $off) (i32.const 2))))))
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
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; WriteConsoleInputW(hConsole, lpBuffer, nLength, lpNumberOfEventsWritten) → BOOL
  (func $handle_WriteConsoleInputW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg3)
      (then (i32.store (call $g2w (local.get $arg3)) (local.get $arg2))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))
