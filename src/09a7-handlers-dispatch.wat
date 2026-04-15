  ;; ============================================================
  ;; SUB-DISPATCHERS & MISC LATE-ADDED HANDLERS
  ;; ============================================================

  ;; ============================================================
  ;; SUB-DISPATCHERS (Local*, Global*, lstr*, Reg*)
  ;; ============================================================
(func $dispatch_local (param $name i32) (param $a0 i32) (param $a1 i32) (param $a2 i32)
    (local $ch i32)
    (local.set $ch (i32.load8_u (i32.add (local.get $name) (i32.const 5))))
    (if (i32.eq (local.get $ch) (i32.const 0x41)) ;; LocalAlloc
      (then (global.set $eax (call $heap_alloc (local.get $a1)))
            (if (i32.and (local.get $a0) (i32.const 0x40)) ;; LMEM_ZEROINIT
              (then (if (global.get $eax) (then (call $zero_memory (call $g2w (global.get $eax)) (local.get $a1))))))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x46)) ;; LocalFree
      (then (call $heap_free (local.get $a0))
            (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x4C)) ;; LocalLock
      (then (global.set $eax (local.get $a0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x55)) ;; LocalUnlock
      (then (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x52)) ;; LocalReAlloc(hMem, uBytes, uFlags)
      (then
        (global.set $eax (call $heap_realloc (local.get $a0) (local.get $a1) (local.get $a2)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (call $crash_unimplemented (local.get $name)))

  (func $dispatch_global (param $name i32) (param $a0 i32) (param $a1 i32) (param $a2 i32)
    (local $ch i32)
    (local.set $ch (i32.load8_u (i32.add (local.get $name) (i32.const 6))))
    (if (i32.eq (local.get $ch) (i32.const 0x41)) ;; GlobalAlloc
      (then (global.set $eax (call $heap_alloc (local.get $a1)))
            (if (i32.and (local.get $a0) (i32.const 0x40)) ;; GMEM_ZEROINIT
              (then (if (global.get $eax) (then (call $zero_memory (call $g2w (global.get $eax)) (local.get $a1))))))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x46)) ;; GlobalFree
      (then (call $heap_free (local.get $a0))
            (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x4C)) ;; GlobalLock
      (then (global.set $eax (local.get $a0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x55)) ;; GlobalUnlock
      (then (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x53)) ;; GlobalSize
      (then (global.set $eax (i32.sub (call $gl32 (i32.sub (local.get $a0) (i32.const 4))) (i32.const 4)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x52)) ;; GlobalReAlloc(hMem, uBytes, uFlags)
      (then
        (global.set $eax (call $heap_realloc (local.get $a0) (local.get $a1) (local.get $a2)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x43)) ;; GlobalCompact
      (then (global.set $eax (i32.const 0x100000)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (call $crash_unimplemented (local.get $name)))

  (func $dispatch_lstr (param $name i32) (param $a0 i32) (param $a1 i32) (param $a2 i32)
    (local $ch i32) (local.set $ch (i32.load8_u (i32.add (local.get $name) (i32.const 4))))
    ;; lstrlenA(1) — 'l' at pos 4
    (if (i32.eq (local.get $ch) (i32.const 0x6C)) ;; lstrlenA
      (then
        (global.set $eax (call $guest_strlen (local.get $a0)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    ;; lstrcpyA(2) — 'c' at pos 4, 'p' at pos 5, 'y' at pos 6
    (if (i32.eq (local.get $ch) (i32.const 0x63)) ;; lstrc...
      (then
        ;; lstrcpyA vs lstrcpynA vs lstrcmpA vs lstrcmpiA vs lstrcatA
        (if (i32.eq (i32.load8_u (i32.add (local.get $name) (i32.const 5))) (i32.const 0x61)) ;; lstrcatA(2)
          (then
            ;; Append a1 to a0
            (call $guest_strcpy
              (i32.add (local.get $a0) (call $guest_strlen (local.get $a0)))
              (local.get $a1))
            (global.set $eax (local.get $a0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
        (if (i32.eq (i32.load8_u (i32.add (local.get $name) (i32.const 5))) (i32.const 0x70)) ;; lstrcpy/lstrcpyn
          (then
            (if (i32.eq (i32.load8_u (i32.add (local.get $name) (i32.const 7))) (i32.const 0x6E)) ;; lstrcpynA(3)
              (then
                ;; Copy up to a2-1 chars
                (call $guest_strncpy (local.get $a0) (local.get $a1) (local.get $a2))
                (global.set $eax (local.get $a0))
                (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
            ;; lstrcpyA(2)
            (call $guest_strcpy (local.get $a0) (local.get $a1))
            (global.set $eax (local.get $a0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
        ;; lstrcmpA(2) vs lstrcmpiA(2): name[7]='i' → case-insensitive
        (if (i32.eq (i32.load8_u (i32.add (local.get $name) (i32.const 7))) (i32.const 0x69)) ;; 'i'
          (then (global.set $eax (call $guest_stricmp (local.get $a0) (local.get $a1))))
          (else (global.set $eax (call $guest_strcmp (local.get $a0) (local.get $a1)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    ;; fallback
    (call $crash_unimplemented (local.get $name)))

  ;; 702: SetRectEmpty — zeroes out RECT
  (func $handle_SetRectEmpty (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Zero out RECT at arg0: left, top, right, bottom = 0
    (i32.store (call $g2w (local.get $arg0)) (i32.const 0))
    (i32.store (i32.add (call $g2w (local.get $arg0)) (i32.const 4)) (i32.const 0))
    (i32.store (i32.add (call $g2w (local.get $arg0)) (i32.const 8)) (i32.const 0))
    (i32.store (i32.add (call $g2w (local.get $arg0)) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) ;; stdcall 1 param
  )

  ;; 703: SetRect — stores left, top, right, bottom into RECT
  (func $handle_SetRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Store left, top, right, bottom into RECT at arg0
    (i32.store (call $g2w (local.get $arg0)) (local.get $arg1))
    (i32.store (i32.add (call $g2w (local.get $arg0)) (i32.const 4)) (local.get $arg2))
    (i32.store (i32.add (call $g2w (local.get $arg0)) (i32.const 8)) (local.get $arg3))
    (i32.store (i32.add (call $g2w (local.get $arg0)) (i32.const 12)) (local.get $arg4))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) ;; stdcall 5 params
  )

  ;; 704: RegisterClipboardFormatA — returns unique clipboard format ID
  (func $handle_RegisterClipboardFormatA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return unique clipboard format ID (starting from 0xC000)
    (global.set $clipboard_format_counter (i32.add (global.get $clipboard_format_counter) (i32.const 1)))
    (global.set $eax (global.get $clipboard_format_counter))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) ;; stdcall 1 param
  )

  (func $dispatch_reg (param $name i32)
    (local $ch i32) (local.set $ch (i32.load8_u (i32.add (local.get $name) (i32.const 3))))
    (if (i32.eq (local.get $ch) (i32.const 0x4F)) ;; RegOpenKeyA (3 args) / RegOpenKeyExA (5 args)
      (then (global.set $eax (i32.const 2))
            ;; Check for "Ex" variant by looking at char after "RegOpenKey"
            (if (i32.eq (i32.load8_u (i32.add (local.get $name) (i32.const 10))) (i32.const 0x45)) ;; RegOpenKeyExA
              (then (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x43)) ;; RegCloseKey(1) / RegCreateKeyA(3)
      (then
        (if (i32.eq (i32.load8_u (i32.add (local.get $name) (i32.const 4))) (i32.const 0x6C)) ;; RegCloseKey(1)
          (then (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
        ;; RegCreateKeyA(3)
        (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x51)) ;; RegQueryValueExA(6)
      (then (global.set $eax (i32.const 2)) (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x53)) ;; RegSetValueExA(6)
      (then (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))
    (call $crash_unimplemented (local.get $name)))

  ;; 707: AboutWEP(hwnd, hInstance, szCaption, nUnused)
  ;; Entertainment Pack about dialog — same shape as ShellAboutA but the
  ;; caption is in arg2 (no separate "other stuff" arg). Pass arg2 as the
  ;; appname slot, NULL for the second line.
  (func $handle_AboutWEP (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dlg i32)
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (drop (call $host_shell_about
      (local.get $dlg) (local.get $arg0) (call $g2w (local.get $arg2))))
    (call $create_about_dialog
      (local.get $dlg) (local.get $arg0)
      (local.get $arg2) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 711: LoadImageA(hInst, name, type, cx, cy, fuLoad) — delegate to LoadIcon/LoadCursor/LoadBitmap
  (func $handle_LoadImageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    ;; arg0=hInst, arg1=name, arg2=type, arg3=cx, arg4=cy, [esp+24]=fuLoad
    ;; IMAGE_BITMAP (0): load from PE resources via host
    (if (i32.eqz (local.get $arg2))
      (then
        (local.set $tmp (call $host_gdi_load_bitmap (local.get $arg0) (i32.and (local.get $arg1) (i32.const 0xFFFF))))
        (if (i32.eqz (local.get $tmp))
          (then (local.set $tmp (call $host_gdi_create_compat_bitmap (i32.const 0) (i32.const 32) (i32.const 32)))))
        (global.set $eax (local.get $tmp))
        (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))
    ;; IMAGE_ICON (1): return fake icon handle (same as LoadIconA)
    (if (i32.eq (local.get $arg2) (i32.const 1))
      (then
        (global.set $eax (i32.const 0x60001))
        (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))
    ;; IMAGE_CURSOR (2): return fake cursor handle (same as LoadCursorA)
    (if (i32.eq (local.get $arg2) (i32.const 2))
      (then
        (global.set $eax (i32.const 0x60002))
        (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))
    ;; Unknown type: return NULL
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; stdcall, 6 args
  )

  ;; 712: LineDDA(xStart, yStart, xEnd, yEnd, lpProc) — stub: just return, callback not invoked
  (func $handle_LineDDA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; LineDDA calls a callback for each pixel on a line. Cards.dll uses it
    ;; but we can stub it since card rendering happens in the DLL code that gets emulated.
    ;; Actually cards.dll code calls this API thunk — we need to implement the callback loop.
    ;; For now return non-zero (success) and skip the callback.
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; stdcall, 5 args + data param
  )

  ;; 713: OpenFile(lpFileName, lpReOpenBuff, uStyle) — delegate to host_fs_create_file
  ;; arg0=lpFileName, arg1=lpReOpenBuff (OFSTRUCT), arg2=uStyle
  (func $handle_OpenFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $handle i32) (local $buf_wa i32)
    (local.set $handle (call $host_fs_create_file
      (call $g2w (local.get $arg0))
      (i32.const 0x80000000)  ;; GENERIC_READ
      (i32.const 3)           ;; OPEN_EXISTING
      (i32.const 0x80)        ;; FILE_ATTRIBUTE_NORMAL
      (i32.const 0)))         ;; isWide=0
    ;; Fill OFSTRUCT if provided
    (if (local.get $arg1)
      (then
        (local.set $buf_wa (call $g2w (local.get $arg1)))
        (i32.store8 (local.get $buf_wa) (i32.const 136))  ;; cBytes
        (if (i32.eq (local.get $handle) (i32.const -1))
          (then (i32.store16 (i32.add (local.get $buf_wa) (i32.const 2)) (i32.const 2)))  ;; nErrCode=FILE_NOT_FOUND
          (else (i32.store16 (i32.add (local.get $buf_wa) (i32.const 2)) (i32.const 0))))))
    ;; OF_EXIST (0x4000): check existence only, close handle
    (if (i32.and (local.get $arg2) (i32.const 0x4000))
      (then
        (if (i32.ne (local.get $handle) (i32.const -1))
          (then
            (drop (call $host_fs_close_handle (local.get $handle)))
            (local.set $handle (i32.const 1))))))
    (global.set $eax (local.get $handle))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; 714: OutputDebugStringA(lpOutputString) — ignore
  (func $handle_OutputDebugStringA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 715: AdjustWindowRect(lpRect, dwStyle, bMenu) — adjust rect for window chrome
  (func $handle_AdjustWindowRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local $left i32) (local $top i32) (local $right i32) (local $bottom i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (local.set $left (i32.load (local.get $wa)))
    (local.set $top (i32.load (i32.add (local.get $wa) (i32.const 4))))
    (local.set $right (i32.load (i32.add (local.get $wa) (i32.const 8))))
    (local.set $bottom (i32.load (i32.add (local.get $wa) (i32.const 12))))
    ;; Add typical Win98 window chrome: caption=20, border=4, menu=19
    (i32.store (local.get $wa) (i32.sub (local.get $left) (i32.const 4)))
    (i32.store (i32.add (local.get $wa) (i32.const 4))
      (i32.sub (local.get $top) (i32.add (i32.const 24)
        (select (i32.const 19) (i32.const 0) (local.get $arg2)))))
    (i32.store (i32.add (local.get $wa) (i32.const 8)) (i32.add (local.get $right) (i32.const 4)))
    (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.add (local.get $bottom) (i32.const 4)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; 717: GetDCOrgEx(hdc, lppt) — return (0,0) as DC origin
  (func $handle_GetDCOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    (i32.store (local.get $wa) (i32.const 0))
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 741: QueryPerformanceCounter(lpPerformanceCount) — write monotonic counter
  (func $handle_QueryPerformanceCounter (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (i32.store (local.get $wa) (global.get $perf_counter_lo))
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0))
    (global.set $perf_counter_lo (i32.add (global.get $perf_counter_lo) (i32.const 1000)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 742: QueryPerformanceFrequency(lpFrequency) — 1MHz
  (func $handle_QueryPerformanceFrequency (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (i32.store (local.get $wa) (i32.const 1000000))
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 743: SetClassLongA(hWnd, nIndex, dwNewLong) — return old value (0)
  (func $handle_SetClassLongA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; 744: RtlZeroMemory(Destination, Length) — zero fill memory
  (func $handle_RtlZeroMemory (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $zero_memory (call $g2w (local.get $arg0)) (local.get $arg1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 745: time(timer) — return seconds since epoch
  (func $handle_time (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $t i32)
    (local.set $t (i32.add (i32.const 946684800) (i32.div_u (call $host_get_ticks) (i32.const 1000))))
    (global.set $eax (local.get $t))
    (if (local.get $arg0)
      (then (i32.store (call $g2w (local.get $arg0)) (local.get $t))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 746: atol(str) — convert ASCII string to long integer
  (func $handle_atol (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ptr i32) (local $val i32) (local $ch i32) (local $neg i32)
    (local.set $ptr (call $g2w (local.get $arg0)))
    ;; Skip whitespace
    (block $ws_done (loop $ws
      (local.set $ch (i32.load8_u (local.get $ptr)))
      (br_if $ws_done (i32.ne (local.get $ch) (i32.const 32)))
      (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
      (br $ws)))
    ;; Check sign
    (if (i32.eq (i32.load8_u (local.get $ptr)) (i32.const 45))  ;; '-'
      (then (local.set $neg (i32.const 1))
            (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))))
    (if (i32.eq (i32.load8_u (local.get $ptr)) (i32.const 43))  ;; '+'
      (then (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))))
    ;; Parse digits
    (block $done (loop $digits
      (local.set $ch (i32.load8_u (local.get $ptr)))
      (br_if $done (i32.lt_u (local.get $ch) (i32.const 48)))
      (br_if $done (i32.gt_u (local.get $ch) (i32.const 57)))
      (local.set $val (i32.add (i32.mul (local.get $val) (i32.const 10))
                                (i32.sub (local.get $ch) (i32.const 48))))
      (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
      (br $digits)))
    (if (local.get $neg)
      (then (local.set $val (i32.sub (i32.const 0) (local.get $val)))))
    (global.set $eax (local.get $val))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; cdecl
  )

  ;; __GetMainArgs(argc, argv, envp) — CRT init, 3-arg variant
  (func $handle___GetMainArgs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $i i32) (local $dst i32)
    (call $gs32 (local.get $arg0) (i32.const 1))
    (if (i32.eqz (global.get $msvcrt_acmdln_ptr))
    (then
    (global.set $msvcrt_acmdln_ptr (call $heap_alloc (i32.const 256)))
    ;; Copy exe name
    (local.set $dst (call $g2w (global.get $msvcrt_acmdln_ptr)))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (global.get $exe_name_len)))
      (i32.store8 (i32.add (local.get $dst) (local.get $i))
        (i32.load8_u (i32.add (global.get $exe_name_wa) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (i32.store8 (i32.add (local.get $dst) (global.get $exe_name_len)) (i32.const 0))
    ;; argv at +128, envp at +136
    (i32.store (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 128)) (global.get $msvcrt_acmdln_ptr))
    (i32.store (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 132)) (i32.const 0))
    (i32.store (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 136)) (i32.const 0))))
    (call $gs32 (local.get $arg1) (i32.add (global.get $msvcrt_acmdln_ptr) (i32.const 128)))
    (call $gs32 (local.get $arg2) (i32.add (global.get $msvcrt_acmdln_ptr) (i32.const 136)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; cdecl
  )

  ;; 752: SetWindowsHookW(idHook, lpfn) — old-style hook, return fake handle
  (func $handle_SetWindowsHookW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x00DEAD01))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 753: RegisterPenApp(style, fRegister) — no-op, pen input not supported
  (func $handle_RegisterPenApp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 754: FormatMessageA(dwFlags, lpSource, dwMessageId, dwLanguageId, lpBuffer, nSize, Arguments)
  (func $handle_FormatMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $buf_ga i32)
    ;; dwFlags=arg0, lpSource=arg1, dwMessageId=arg2, dwLangId=arg3, lpBuffer=arg4
    ;; If FORMAT_MESSAGE_ALLOCATE_BUFFER (0x100), allocate and store ptr
    ;; Otherwise write to lpBuffer directly
    (if (i32.and (local.get $arg0) (i32.const 0x100))
      (then
        ;; Allocate a small buffer and write its address to *lpBuffer
        (local.set $buf_ga (call $heap_alloc (i32.const 64)))
        (i32.store (call $g2w (local.get $arg4)) (local.get $buf_ga))
        (local.set $wa (call $g2w (local.get $buf_ga))))
      (else
        (local.set $wa (call $g2w (local.get $arg4)))))
    ;; Write a generic error message
    (i32.store (local.get $wa) (i32.const 0x6F727245))          ;; "Erro"
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0x00000072))  ;; "r\0"
    (global.set $eax (i32.const 5))  ;; length of "Error"
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))  ;; stdcall, 7 args
  )

  ;; 755: RegOpenKeyExW(hKey, lpSubKey, ulOptions, samDesired, phkResult) — wide string version
  (func $handle_RegOpenKeyExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Use host registry with isWide=1
    (local $result i32)
    (local.set $result (call $host_reg_open_key (local.get $arg0) (call $g2w (local.get $arg1)) (i32.const 1)))
    (if (local.get $result)
      (then
        ;; Store the opened key handle in *phkResult
        (i32.store (call $g2w (local.get $arg4)) (local.get $result))
        (global.set $eax (i32.const 0)))  ;; ERROR_SUCCESS
      (else
        (global.set $eax (i32.const 2))))  ;; ERROR_FILE_NOT_FOUND
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; stdcall, 5 args
  )

  ;; 756: GetShellWindow() — return NULL (no shell window)
  (func $handle_GetShellWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )



  ;; 758: SHGetSpecialFolderLocation(hwndOwner, nFolder, ppidl) — return E_FAIL
  (func $handle_SHGetSpecialFolderLocation (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Allocate a fake PIDL and store in *ppidl so caller doesn't crash on NULL
    (local $pidl i32)
    (local.set $pidl (call $heap_alloc (i32.const 16)))
    (call $zero_memory (call $g2w (local.get $pidl)) (i32.const 16))
    (i32.store (call $g2w (local.get $arg2)) (local.get $pidl))
    (global.set $eax (i32.const 0))  ;; S_OK
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; 759: CoInitialize(pvReserved) — return S_OK
  (func $handle_CoInitialize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))  ;; S_OK
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 760: CoUninitialize() — no-op
  (func $handle_CoUninitialize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; 761: OleUninitialize() — no-op
  (func $handle_OleUninitialize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; 762: GetWindowLongA(hWnd, nIndex)
  (func $handle_GetWindowLongA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eq (local.get $arg1) (i32.const -21))  ;; GWL_USERDATA
      (then
        (global.set $eax (call $wnd_get_userdata (local.get $arg0)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (if (i32.eq (local.get $arg1) (i32.const -4))   ;; GWL_WNDPROC
      (then
        (global.set $eax (call $wnd_table_get (local.get $arg0)))
        ;; If WNDPROC_BUILTIN sentinel, return 0 (no real wndproc)
        (if (i32.eq (global.get $eax) (global.get $WNDPROC_BUILTIN))
          (then (global.set $eax (i32.const 0))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (if (i32.eq (local.get $arg1) (i32.const -6))   ;; GWL_HINSTANCE
      (then
        (global.set $eax (global.get $image_base))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (if (i32.eq (local.get $arg1) (i32.const -16))  ;; GWL_STYLE
      (then
        (global.set $eax (call $wnd_get_style (local.get $arg0)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (if (i32.eq (local.get $arg1) (i32.const -20))  ;; GWL_EXSTYLE
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (if (i32.ge_s (local.get $arg1) (i32.const 0))  ;; positive = dialog extra bytes
      (then
        (global.set $eax (call $wnd_get_userdata (local.get $arg0)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 763: waveOutMessage(hwo, uMsg, dw1, dw2) — return MMSYSERR_NOERROR
  (func $handle_waveOutMessage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))  ;; MMSYSERR_NOERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; stdcall, 4 args
  )

  ;; 764: GetUserDefaultLCID — already implemented at ID 413, this is a duplicate entry
  ;; (handled by dispatch to same function)

  ;; 765: wcsrchr(str, ch) — find last occurrence of wide char
  (func $handle_wcsrchr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ptr i32) (local $last i32) (local $ch i32)
    (local.set $ptr (call $g2w (local.get $arg0)))
    (local.set $last (i32.const 0))
    (block $done (loop $scan
      (local.set $ch (i32.load16_u (local.get $ptr)))
      (if (i32.eq (local.get $ch) (i32.and (local.get $arg1) (i32.const 0xFFFF)))
        (then (local.set $last (local.get $ptr))))
      (br_if $done (i32.eqz (local.get $ch)))
      (local.set $ptr (i32.add (local.get $ptr) (i32.const 2)))
      (br $scan)))
    ;; Convert WASM addr back to guest addr: wa - GUEST_BASE + image_base
    (if (local.get $last)
      (then (global.set $eax (i32.add (i32.sub (local.get $last) (global.get $GUEST_BASE)) (global.get $image_base))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; cdecl
  )

  ;; 766: UnregisterClassA(lpClassName, hInstance) — return TRUE
  (func $handle_UnregisterClassA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 767: SHRegGetUSValueA — return ERROR_FILE_NOT_FOUND
  (func $handle_SHRegGetUSValueA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 2))  ;; ERROR_FILE_NOT_FOUND
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; stdcall, 6 args
  )

  ;; 768: SHGetPathFromIDListA(pidl, pszPath) — write "C:\WINDOWS" and return TRUE
  (func $handle_SHGetPathFromIDListA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    (i32.store (local.get $wa) (i32.const 0x575C3A43))          ;; "C:\W"
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0x4F444E49))  ;; "INDO"
    (i32.store16 (i32.add (local.get $wa) (i32.const 8)) (i32.const 0x5357))    ;; "WS"
    (i32.store8 (i32.add (local.get $wa) (i32.const 10)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 769: GetVersionExW(lpVersionInfo) — fill OSVERSIONINFOW for Windows 98
  (func $handle_GetVersionExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    ;; dwOSVersionInfoSize already set by caller at offset 0
    ;; dwMajorVersion = 4 (Win98)
    (i32.store offset=4 (local.get $wa) (i32.const 4))
    ;; dwMinorVersion = 10 (Win98)
    (i32.store offset=8 (local.get $wa) (i32.const 10))
    ;; dwBuildNumber = 0x040A0004 (Win98 SE)
    (i32.store offset=12 (local.get $wa) (i32.const 0x040A0004))
    ;; dwPlatformId = 1 (VER_PLATFORM_WIN32_WINDOWS)
    (i32.store offset=16 (local.get $wa) (i32.const 1))
    ;; szCSDVersion — leave as zeroes
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 769: CoCreateInstance(rclsid, pUnkOuter, dwClsContext, riid, ppv) — 5 args stdcall
  (func $handle_CoCreateInstance (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hr i32) (local $clsid_d1 i32) (local $obj_guest i32)
    ;; Short-circuit CLSID_DirectDrawFactory {4FD2A832-86C8-11D0-8FCA-00C04FD9189D}
    ;; from ddrawex.dll. Used by CORBIS/FASHION/HORROR/WOTRAVEL screensavers; we
    ;; manufacture an IDirectDrawFactory directly so the guest never needs the DLL.
    (local.set $clsid_d1 (call $gl32 (local.get $arg0)))
    (if (i32.eq (local.get $clsid_d1) (i32.const 0x4FD2A832))
      (then
        (local.set $obj_guest (call $dx_create_com_obj (i32.const 10) (global.get $DX_VTBL_DDFACTORY)))
        (if (i32.eqz (local.get $obj_guest))
          (then
            (call $gs32 (local.get $arg4) (i32.const 0))
            (global.set $eax (i32.const 0x80004005))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
            (return)))
        (call $gs32 (local.get $arg4) (local.get $obj_guest))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    (local.set $hr (call $host_com_create_instance
      (call $g2w (local.get $arg0))   ;; rclsid → WASM addr
      (local.get $arg1)               ;; pUnkOuter (guest addr, usually NULL)
      (local.get $arg2)               ;; dwClsContext
      (call $g2w (local.get $arg3))   ;; riid → WASM addr
      (local.get $arg4)))             ;; ppv (guest addr)
    ;; Check if we need async DLL load (host returns 0x800401F0 = CO_E_DLLNOTFOUND)
    (if (i32.eq (local.get $hr) (i32.const 0x800401F0))
      (then
        ;; Save COM state for resume after DLL fetch
        (global.set $com_clsid_ptr (local.get $arg0))
        (global.set $com_iid_ptr (local.get $arg3))
        (global.set $com_ppv_ptr (local.get $arg4))
        (global.set $com_unk_outer (local.get $arg1))
        (global.set $com_cls_ctx (local.get $arg2))
        (global.set $com_dll_name (call $host_com_get_pending_dll))
        ;; Yield to JS for async DLL fetch — DON'T advance ESP yet
        ;; JS will load DLL, then re-call com_create_instance
        (global.set $yield_reason (i32.const 3))
        (global.set $steps (i32.const 0))
        (return)))
    ;; Synchronous success or error — zero *ppv on failure per COM spec
    (if (local.get $hr)
      (then (call $gs32 (local.get $arg4) (i32.const 0))))
    (global.set $eax (local.get $hr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; stdcall, 5 args
  )

  ;; OLEAUT32 BSTR support. BSTR layout:
  ;;   [ptr-4..ptr-1] = byte length (not char count, not including null)
  ;;   [ptr..ptr+len-1] = UTF-16 LE data
  ;;   [ptr+len..ptr+len+1] = null terminator (always present)
  ;; We allocate (len+6) bytes via $heap_alloc; the 4-byte length prefix lives
  ;; at the start of the allocation, so BSTR = alloc+4 and SysFreeString can
  ;; free(alloc) = free(bstr-4).

  ;; SysAllocString(psz: PCOLESTR) → BSTR
  (func $handle_SysAllocString (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $nchars i32) (local $nbytes i32) (local $alloc i32) (local $bstr i32)
    (local $src_w i32) (local $dst_w i32)
    (if (i32.eqz (local.get $arg0))
      (then (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (local.set $nchars (call $guest_wcslen (local.get $arg0)))
    (local.set $nbytes (i32.shl (local.get $nchars) (i32.const 1)))
    (local.set $alloc (call $heap_alloc (i32.add (local.get $nbytes) (i32.const 6))))
    (if (i32.eqz (local.get $alloc))
      (then (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (local.set $bstr (i32.add (local.get $alloc) (i32.const 4)))
    ;; Write length prefix at alloc+0
    (call $gs32 (local.get $alloc) (local.get $nbytes))
    ;; Copy the UTF-16 payload + null terminator via WASM addrs
    (local.set $src_w (call $g2w (local.get $arg0)))
    (local.set $dst_w (call $g2w (local.get $bstr)))
    (memory.copy (local.get $dst_w) (local.get $src_w) (i32.add (local.get $nbytes) (i32.const 2)))
    (global.set $eax (local.get $bstr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; SysAllocStringLen(psz: PCOLESTR, cch: UINT) → BSTR. psz may be NULL (then uninit'd).
  (func $handle_SysAllocStringLen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $nbytes i32) (local $alloc i32) (local $bstr i32)
    (local.set $nbytes (i32.shl (local.get $arg1) (i32.const 1)))
    (local.set $alloc (call $heap_alloc (i32.add (local.get $nbytes) (i32.const 6))))
    (if (i32.eqz (local.get $alloc))
      (then (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (local.set $bstr (i32.add (local.get $alloc) (i32.const 4)))
    (call $gs32 (local.get $alloc) (local.get $nbytes))
    (if (local.get $arg0)
      (then (memory.copy
        (call $g2w (local.get $bstr))
        (call $g2w (local.get $arg0))
        (local.get $nbytes))))
    ;; Always null-terminate
    (call $gs16 (i32.add (local.get $bstr) (local.get $nbytes)) (i32.const 0))
    (global.set $eax (local.get $bstr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; SysFreeString(bstr: BSTR). No-op on NULL.
  (func $handle_SysFreeString (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg0)
      (then (call $heap_free (i32.sub (local.get $arg0) (i32.const 4)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; SysStringLen(bstr: BSTR) → UINT char count (length prefix / 2).
  (func $handle_SysStringLen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (local.get $arg0))
      (then (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (global.set $eax (i32.shr_u
      (call $gl32 (i32.sub (local.get $arg0) (i32.const 4)))
      (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; VariantClear(pvarg: VARIANTARG*) → HRESULT. Full impl would free BSTR/dispatch
  ;; fields based on vt, but Spider stores only simple VT_I4/VT_BOOL variants, and
  ;; any cached BSTR leaks are bounded. Zero the whole 16-byte VARIANT so callers
  ;; don't re-read stale tagged pointers.
  (func $handle_VariantClear (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg0)
      (then (call $zero_memory (call $g2w (local.get $arg0)) (i32.const 16))))
    (global.set $eax (i32.const 0))  ;; S_OK
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; LoadTypeLib(szFile: LPCOLESTR, pptlib: ITypeLib**) → HRESULT. We don't
  ;; implement type libraries; return TYPE_E_CANTLOADLIBRARY (0x80029C4A) so the
  ;; caller can take its "no typelib" fallback path. Zero out *pptlib.
  (func $handle_LoadTypeLib (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1)
      (then (call $gs32 (local.get $arg1) (i32.const 0))))
    (global.set $eax (i32.const 0x80029C4A))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 770: CoTaskMemAlloc(cb) — 1 arg stdcall, allocate from heap
  (func $handle_CoTaskMemAlloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $heap_alloc (local.get $arg0)))
    (if (global.get $eax)
      (then (call $zero_memory (call $g2w (global.get $eax)) (local.get $arg0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 771: StringFromGUID2(rguid, lpsz, cchMax) — 3 args stdcall
  ;; Formats GUID as "{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}" into wide buffer
  (func $handle_StringFromGUID2 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $src i32) (local $dst i32) (local $i i32)
    (local $d1 i32) (local $d2 i32) (local $d3 i32)
    ;; Need 39 chars: "{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}\0"
    (if (i32.lt_u (local.get $arg2) (i32.const 39))
      (then (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (local.set $src (call $g2w (local.get $arg0)))
    (local.set $dst (call $g2w (local.get $arg1)))
    ;; Read GUID fields: Data1(4) Data2(2) Data3(2) Data4(8)
    (local.set $d1 (i32.load (local.get $src)))
    (local.set $d2 (i32.load16_u (i32.add (local.get $src) (i32.const 4))))
    (local.set $d3 (i32.load16_u (i32.add (local.get $src) (i32.const 6))))
    ;; Write '{' as wide char
    (i32.store16 (local.get $dst) (i32.const 0x7B))
    ;; Format Data1 (8 hex digits)
    (call $guid_hex32 (i32.add (local.get $dst) (i32.const 2)) (local.get $d1) (i32.const 8))
    ;; '-'
    (i32.store16 (i32.add (local.get $dst) (i32.const 18)) (i32.const 0x2D))
    ;; Format Data2 (4 hex digits)
    (call $guid_hex32 (i32.add (local.get $dst) (i32.const 20)) (local.get $d2) (i32.const 4))
    ;; '-'
    (i32.store16 (i32.add (local.get $dst) (i32.const 28)) (i32.const 0x2D))
    ;; Format Data3 (4 hex digits)
    (call $guid_hex32 (i32.add (local.get $dst) (i32.const 30)) (local.get $d3) (i32.const 4))
    ;; '-'
    (i32.store16 (i32.add (local.get $dst) (i32.const 38)) (i32.const 0x2D))
    ;; Format Data4[0..1] (4 hex digits)
    (call $guid_hex8 (i32.add (local.get $dst) (i32.const 40)) (i32.load8_u (i32.add (local.get $src) (i32.const 8))))
    (call $guid_hex8 (i32.add (local.get $dst) (i32.const 44)) (i32.load8_u (i32.add (local.get $src) (i32.const 9))))
    ;; '-'
    (i32.store16 (i32.add (local.get $dst) (i32.const 48)) (i32.const 0x2D))
    ;; Format Data4[2..7] (12 hex digits)
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (i32.const 6)))
      (call $guid_hex8
        (i32.add (local.get $dst) (i32.add (i32.const 50) (i32.mul (local.get $i) (i32.const 4))))
        (i32.load8_u (i32.add (local.get $src) (i32.add (i32.const 10) (local.get $i)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    ;; '}'
    (i32.store16 (i32.add (local.get $dst) (i32.const 74)) (i32.const 0x7D))
    ;; null terminator
    (i32.store16 (i32.add (local.get $dst) (i32.const 76)) (i32.const 0))
    (global.set $eax (i32.const 39))  ;; chars written including NUL
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; Helper: write N hex digits (wide) for a 32-bit value, big-endian order
  (func $guid_hex32 (param $dst i32) (param $val i32) (param $ndigits i32)
    (local $i i32) (local $shift i32) (local $nibble i32)
    (local.set $shift (i32.mul (i32.sub (local.get $ndigits) (i32.const 1)) (i32.const 4)))
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $ndigits)))
      (local.set $nibble (i32.and (i32.shr_u (local.get $val) (local.get $shift)) (i32.const 0xF)))
      (i32.store16 (i32.add (local.get $dst) (i32.mul (local.get $i) (i32.const 2)))
        (if (result i32) (i32.le_u (local.get $nibble) (i32.const 9))
          (then (i32.add (local.get $nibble) (i32.const 0x30)))
          (else (i32.add (local.get $nibble) (i32.const 0x57)))))  ;; 'a' - 10
      (local.set $shift (i32.sub (local.get $shift) (i32.const 4)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp))))

  ;; Helper: write 2 hex digits (wide) for a byte
  (func $guid_hex8 (param $dst i32) (param $byte i32)
    (call $guid_hex32 (local.get $dst) (local.get $byte) (i32.const 2)))

  ;; 772: CLSIDFromString(lpsz, pclsid) — 2 args stdcall
  ;; Parse "{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}" from wide string into 16-byte GUID
  (func $handle_CLSIDFromString (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $src i32) (local $dst i32) (local $pos i32)
    (local $d1 i32) (local $d2 i32) (local $d3 i32) (local $i i32) (local $b i32)
    (if (i32.eqz (local.get $arg0))
      (then (global.set $eax (i32.const 0x80004003))  ;; E_POINTER
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (local.set $src (call $g2w (local.get $arg0)))
    (local.set $dst (call $g2w (local.get $arg1)))
    ;; Skip optional '{'
    (local.set $pos (local.get $src))
    (if (i32.eq (i32.load16_u (local.get $pos)) (i32.const 0x7B))
      (then (local.set $pos (i32.add (local.get $pos) (i32.const 2)))))
    ;; Parse Data1 (8 hex digits)
    (local.set $d1 (call $parse_hex_wide (local.get $pos) (i32.const 8)))
    (i32.store (local.get $dst) (local.get $d1))
    (local.set $pos (i32.add (local.get $pos) (i32.const 16)))  ;; 8 chars * 2 bytes
    ;; Skip '-'
    (if (i32.eq (i32.load16_u (local.get $pos)) (i32.const 0x2D))
      (then (local.set $pos (i32.add (local.get $pos) (i32.const 2)))))
    ;; Parse Data2 (4 hex digits)
    (local.set $d2 (call $parse_hex_wide (local.get $pos) (i32.const 4)))
    (i32.store16 (i32.add (local.get $dst) (i32.const 4)) (local.get $d2))
    (local.set $pos (i32.add (local.get $pos) (i32.const 8)))
    ;; Skip '-'
    (if (i32.eq (i32.load16_u (local.get $pos)) (i32.const 0x2D))
      (then (local.set $pos (i32.add (local.get $pos) (i32.const 2)))))
    ;; Parse Data3 (4 hex digits)
    (local.set $d3 (call $parse_hex_wide (local.get $pos) (i32.const 4)))
    (i32.store16 (i32.add (local.get $dst) (i32.const 6)) (local.get $d3))
    (local.set $pos (i32.add (local.get $pos) (i32.const 8)))
    ;; Skip '-'
    (if (i32.eq (i32.load16_u (local.get $pos)) (i32.const 0x2D))
      (then (local.set $pos (i32.add (local.get $pos) (i32.const 2)))))
    ;; Parse Data4[0..1] (4 hex digits = 2 bytes)
    (i32.store8 (i32.add (local.get $dst) (i32.const 8))
      (call $parse_hex_wide (local.get $pos) (i32.const 2)))
    (local.set $pos (i32.add (local.get $pos) (i32.const 4)))
    (i32.store8 (i32.add (local.get $dst) (i32.const 9))
      (call $parse_hex_wide (local.get $pos) (i32.const 2)))
    (local.set $pos (i32.add (local.get $pos) (i32.const 4)))
    ;; Skip '-'
    (if (i32.eq (i32.load16_u (local.get $pos)) (i32.const 0x2D))
      (then (local.set $pos (i32.add (local.get $pos) (i32.const 2)))))
    ;; Parse Data4[2..7] (12 hex digits = 6 bytes)
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (i32.const 6)))
      (i32.store8 (i32.add (local.get $dst) (i32.add (i32.const 10) (local.get $i)))
        (call $parse_hex_wide (local.get $pos) (i32.const 2)))
      (local.set $pos (i32.add (local.get $pos) (i32.const 4)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (global.set $eax (i32.const 0))  ;; S_OK
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; CLSIDFromProgID(lpszProgID, pclsid) — 2 args stdcall
  ;; Wide ProgID string → CLSID. We don't maintain a ProgID registry, so return
  ;; REGDB_E_CLASSNOTREG (0x80040154). Callers typically propagate the error
  ;; through their CoCreateInstance path and degrade gracefully (MFC image
  ;; loaders used by CORBIS/FASHION/HORROR/WOTRAVEL fall into a "no image"
  ;; state rather than crashing).
  (func $handle_CLSIDFromProgID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x80040154))  ;; REGDB_E_CLASSNOTREG
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; ret + 2 args
  )

  ;; Helper: parse N hex digits from wide string at WASM addr, return integer value
  (func $parse_hex_wide (param $src i32) (param $ndigits i32) (result i32)
    (local $result i32) (local $i i32) (local $ch i32) (local $digit i32)
    (local.set $result (i32.const 0))
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $ndigits)))
      (local.set $ch (i32.load16_u (i32.add (local.get $src) (i32.mul (local.get $i) (i32.const 2)))))
      (local.set $digit
        (if (result i32) (i32.and (i32.ge_u (local.get $ch) (i32.const 0x30)) (i32.le_u (local.get $ch) (i32.const 0x39)))
          (then (i32.sub (local.get $ch) (i32.const 0x30)))
          (else (if (result i32) (i32.and (i32.ge_u (local.get $ch) (i32.const 0x41)) (i32.le_u (local.get $ch) (i32.const 0x46)))
            (then (i32.sub (local.get $ch) (i32.const 0x37)))  ;; 'A'-10
            (else (i32.sub (local.get $ch) (i32.const 0x57)))))))  ;; 'a'-10
      (local.set $result (i32.or (i32.shl (local.get $result) (i32.const 4)) (local.get $digit)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (local.get $result))

  ;; 773: GetTempPathA(nBufferLength, lpBuffer) — 2 args stdcall
  (func $handle_GetTempPathA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_fs_get_temp_path
      (local.get $arg0) (local.get $arg1) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 774: CopyFileA(lpExistingFileName, lpNewFileName, bFailIfExists) — 3 args
  (func $handle_CopyFileA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_fs_copy_file
      (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (local.get $arg2) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 775: MoveFileExA(lpExistingFileName, lpNewFileName, dwFlags) — 3 args
  (func $handle_MoveFileExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1)
      (then (global.set $eax (call $host_fs_move_file
        (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (i32.const 0))))
      (else
        ;; lpNewFileName==NULL means delete on reboot — just delete now
        (global.set $eax (call $host_fs_delete_file (call $g2w (local.get $arg0)) (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 776: GetTempFileNameA(lpPathName, lpPrefixString, uUnique, lpTempFileName) — 4 args
  (func $handle_GetTempFileNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_fs_get_temp_file_name
      (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (local.get $arg2) (local.get $arg3) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 777: CreateFileMappingA(hFile, lpAttr, flProtect, dwMaxHi, dwMaxLo, lpName) — 6 args
  (func $handle_CreateFileMappingA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_fs_create_file_mapping
      (local.get $arg0) (local.get $arg2) (local.get $arg3) (local.get $arg4)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; 6 args
  )

  ;; 778: MapViewOfFile(hMapping, dwAccess, dwOffsetHi, dwOffsetLo, dwSize) — 5 args
  (func $handle_MapViewOfFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_fs_map_view_of_file
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; 5 args
  )

  ;; 779: UnmapViewOfFile(lpBaseAddress) — 1 arg
  (func $handle_UnmapViewOfFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_fs_unmap_view (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; 1 arg
  )

  ;; 782: MoveFileExW(lpExistingFileName, lpNewFileName, dwFlags) — 3 args
  (func $handle_MoveFileExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1)
      (then (global.set $eax (call $host_fs_move_file
        (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (i32.const 1))))
      (else (global.set $eax (call $host_fs_delete_file (call $g2w (local.get $arg0)) (i32.const 1)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 784: ThunkConnect32 — Win9x 16/32-bit thunking, no-op in pure 32-bit
  (func $handle_ThunkConnect32 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 785: MapVirtualKeyA — translate between vkeys, scan codes, and characters
  (func $handle_MapVirtualKeyA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $uCode i32)
    (local $uMapType i32)
    (local $result i32)
    ;; arg0=uCode, arg1=uMapType (stdcall, 2 args)
    (local.set $uCode (local.get $arg0))
    (local.set $uMapType (local.get $arg1))
    (local.set $result (i32.const 0))
    (block $done
      ;; Type 0: vkey -> scan code
      (if (i32.eqz (local.get $uMapType))
        (then
          (block $vk0_done
            ;; Letters A-Z: vkeys 0x41-0x5A -> scancodes 0x1E-0x39 (approximate)
            (if (i32.and (i32.ge_u (local.get $uCode) (i32.const 0x41)) (i32.le_u (local.get $uCode) (i32.const 0x5A)))
              (then
                ;; Simple mapping: A=0x1E, B=0x30, C=0x2E, etc. Use offset table concept
                ;; For simplicity, return scancode = uCode (non-zero signals "exists")
                (local.set $result (i32.sub (local.get $uCode) (i32.const 0x20)))
                (br $vk0_done)
              )
            )
            ;; Numbers 0-9: vkeys 0x30-0x39 -> scancodes 0x0B,0x02-0x0A
            (if (i32.and (i32.ge_u (local.get $uCode) (i32.const 0x30)) (i32.le_u (local.get $uCode) (i32.const 0x39)))
              (then
                (if (i32.eq (local.get $uCode) (i32.const 0x30))
                  (then (local.set $result (i32.const 0x0B)))
                  (else (local.set $result (i32.sub (local.get $uCode) (i32.const 0x2E))))
                )
                (br $vk0_done)
              )
            )
            ;; Space=0x39, Enter=0x1C, Escape=0x01, Tab=0x0F
            (if (i32.eq (local.get $uCode) (i32.const 0x20)) (then (local.set $result (i32.const 0x39)) (br $vk0_done)))
            (if (i32.eq (local.get $uCode) (i32.const 0x0D)) (then (local.set $result (i32.const 0x1C)) (br $vk0_done)))
            (if (i32.eq (local.get $uCode) (i32.const 0x1B)) (then (local.set $result (i32.const 0x01)) (br $vk0_done)))
            (if (i32.eq (local.get $uCode) (i32.const 0x09)) (then (local.set $result (i32.const 0x0F)) (br $vk0_done)))
            ;; Shift=0x2A, Ctrl=0x1D, Alt=0x38
            (if (i32.eq (local.get $uCode) (i32.const 0x10)) (then (local.set $result (i32.const 0x2A)) (br $vk0_done)))
            (if (i32.eq (local.get $uCode) (i32.const 0x11)) (then (local.set $result (i32.const 0x1D)) (br $vk0_done)))
            (if (i32.eq (local.get $uCode) (i32.const 0x12)) (then (local.set $result (i32.const 0x38)) (br $vk0_done)))
            ;; Arrow keys: Left=0x4B, Up=0x48, Right=0x4D, Down=0x50
            (if (i32.eq (local.get $uCode) (i32.const 0x25)) (then (local.set $result (i32.const 0x4B)) (br $vk0_done)))
            (if (i32.eq (local.get $uCode) (i32.const 0x26)) (then (local.set $result (i32.const 0x48)) (br $vk0_done)))
            (if (i32.eq (local.get $uCode) (i32.const 0x27)) (then (local.set $result (i32.const 0x4D)) (br $vk0_done)))
            (if (i32.eq (local.get $uCode) (i32.const 0x28)) (then (local.set $result (i32.const 0x50)) (br $vk0_done)))
            ;; F1-F12: vkeys 0x70-0x7B -> scancodes 0x3B-0x46,0x57,0x58
            (if (i32.and (i32.ge_u (local.get $uCode) (i32.const 0x70)) (i32.le_u (local.get $uCode) (i32.const 0x7B)))
              (then
                (if (i32.le_u (local.get $uCode) (i32.const 0x79))
                  (then (local.set $result (i32.add (i32.const 0x3B) (i32.sub (local.get $uCode) (i32.const 0x70)))))
                  (else (local.set $result (i32.add (i32.const 0x57) (i32.sub (local.get $uCode) (i32.const 0x7A)))))
                )
                (br $vk0_done)
              )
            )
          )
          (br $done)
        )
      )
      ;; Type 1: scan code -> vkey (reverse of type 0) — return 0 for simplicity
      ;; Type 2: vkey -> unshifted char
      (if (i32.eq (local.get $uMapType) (i32.const 2))
        (then
          ;; Letters: return lowercase ASCII
          (if (i32.and (i32.ge_u (local.get $uCode) (i32.const 0x41)) (i32.le_u (local.get $uCode) (i32.const 0x5A)))
            (then (local.set $result (i32.add (local.get $uCode) (i32.const 0x20))))
          )
          ;; Numbers: return ASCII digit
          (if (i32.and (i32.ge_u (local.get $uCode) (i32.const 0x30)) (i32.le_u (local.get $uCode) (i32.const 0x39)))
            (then (local.set $result (local.get $uCode)))
          )
          (if (i32.eq (local.get $uCode) (i32.const 0x20)) (then (local.set $result (i32.const 0x20))))
          (br $done)
        )
      )
      ;; Type 3: scan code -> vkey (with left/right) — return 0
    )
    (global.set $eax (local.get $result))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 786: DisableThreadLibraryCalls(hModule) — no-op, return TRUE
  (func $handle_DisableThreadLibraryCalls (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 787: ReinitializeCriticalSection(ptr) — no-op (single-threaded)
  (func $handle_ReinitializeCriticalSection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 788: GlobalAddAtomA(lpString) — return unique atom
  (func $handle_GlobalAddAtomA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $next_atom))
    (global.set $next_atom (i32.add (global.get $next_atom) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 790: GetKeyNameTextA(lParam, lpString, cchSize) — write key name from scan code
  (func $handle_GetKeyNameTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; arg0=lParam (scan code in bits 16-23), arg1=lpString, arg2=cchSize
    (local $scan i32) (local $buf i32) (local $len i32) (local $ch i32)
    (local.set $scan (i32.and (i32.shr_u (local.get $arg0) (i32.const 16)) (i32.const 0xFF)))
    (local.set $buf (call $g2w (local.get $arg1)))
    (local.set $len (i32.const 0))
    (block $done
      ;; Esc (0x01)
      (if (i32.eq (local.get $scan) (i32.const 0x01)) (then
        (i32.store (local.get $buf) (i32.const 0x00637345)) ;; "Esc\0"
        (local.set $len (i32.const 3)) (br $done)))
      ;; Number row: 0x02-0x0A = '1'-'9', 0x0B = '0'
      (if (i32.and (i32.ge_u (local.get $scan) (i32.const 0x02)) (i32.le_u (local.get $scan) (i32.const 0x0A)))
        (then (i32.store16 (local.get $buf) (i32.add (i32.const 0x30) (i32.sub (local.get $scan) (i32.const 1))))
              (local.set $len (i32.const 1)) (br $done)))
      (if (i32.eq (local.get $scan) (i32.const 0x0B)) (then
        (i32.store16 (local.get $buf) (i32.const 0x30)) (local.set $len (i32.const 1)) (br $done)))
      ;; Tab (0x0F)
      (if (i32.eq (local.get $scan) (i32.const 0x0F)) (then
        (i32.store (local.get $buf) (i32.const 0x00626154)) ;; "Tab\0"
        (local.set $len (i32.const 3)) (br $done)))
      ;; QWERTYUIOP: scancodes 0x10-0x19
      (local.set $ch (i32.const 0))
      (if (i32.eq (local.get $scan) (i32.const 0x10)) (then (local.set $ch (i32.const 0x51))))
      (if (i32.eq (local.get $scan) (i32.const 0x11)) (then (local.set $ch (i32.const 0x57))))
      (if (i32.eq (local.get $scan) (i32.const 0x12)) (then (local.set $ch (i32.const 0x45))))
      (if (i32.eq (local.get $scan) (i32.const 0x13)) (then (local.set $ch (i32.const 0x52))))
      (if (i32.eq (local.get $scan) (i32.const 0x14)) (then (local.set $ch (i32.const 0x54))))
      (if (i32.eq (local.get $scan) (i32.const 0x15)) (then (local.set $ch (i32.const 0x59))))
      (if (i32.eq (local.get $scan) (i32.const 0x16)) (then (local.set $ch (i32.const 0x55))))
      (if (i32.eq (local.get $scan) (i32.const 0x17)) (then (local.set $ch (i32.const 0x49))))
      (if (i32.eq (local.get $scan) (i32.const 0x18)) (then (local.set $ch (i32.const 0x4F))))
      (if (i32.eq (local.get $scan) (i32.const 0x19)) (then (local.set $ch (i32.const 0x50))))
      ;; Enter (0x1C)
      (if (i32.eq (local.get $scan) (i32.const 0x1C)) (then
        (i32.store (local.get $buf) (i32.const 0x65746E45)) ;; "Ente"
        (i32.store16 (i32.add (local.get $buf) (i32.const 4)) (i32.const 0x0072)) ;; "r\0"
        (local.set $len (i32.const 5)) (br $done)))
      ;; Ctrl (0x1D)
      (if (i32.eq (local.get $scan) (i32.const 0x1D)) (then
        (i32.store (local.get $buf) (i32.const 0x6C727443)) ;; "Ctrl"
        (i32.store8 (i32.add (local.get $buf) (i32.const 4)) (i32.const 0))
        (local.set $len (i32.const 4)) (br $done)))
      ;; ASDFGHJKL: scancodes 0x1E-0x26
      (if (i32.eq (local.get $scan) (i32.const 0x1E)) (then (local.set $ch (i32.const 0x41))))
      (if (i32.eq (local.get $scan) (i32.const 0x1F)) (then (local.set $ch (i32.const 0x53))))
      (if (i32.eq (local.get $scan) (i32.const 0x20)) (then (local.set $ch (i32.const 0x44))))
      (if (i32.eq (local.get $scan) (i32.const 0x21)) (then (local.set $ch (i32.const 0x46))))
      (if (i32.eq (local.get $scan) (i32.const 0x22)) (then (local.set $ch (i32.const 0x47))))
      (if (i32.eq (local.get $scan) (i32.const 0x23)) (then (local.set $ch (i32.const 0x48))))
      (if (i32.eq (local.get $scan) (i32.const 0x24)) (then (local.set $ch (i32.const 0x4A))))
      (if (i32.eq (local.get $scan) (i32.const 0x25)) (then (local.set $ch (i32.const 0x4B))))
      (if (i32.eq (local.get $scan) (i32.const 0x26)) (then (local.set $ch (i32.const 0x4C))))
      ;; Shift (0x2A, 0x36)
      (if (i32.or (i32.eq (local.get $scan) (i32.const 0x2A)) (i32.eq (local.get $scan) (i32.const 0x36))) (then
        (i32.store (local.get $buf) (i32.const 0x66696853)) ;; "Shif"
        (i32.store16 (i32.add (local.get $buf) (i32.const 4)) (i32.const 0x0074)) ;; "t\0"
        (local.set $len (i32.const 5)) (br $done)))
      ;; ZXCVBNM: scancodes 0x2C-0x32
      (if (i32.eq (local.get $scan) (i32.const 0x2C)) (then (local.set $ch (i32.const 0x5A))))
      (if (i32.eq (local.get $scan) (i32.const 0x2D)) (then (local.set $ch (i32.const 0x58))))
      (if (i32.eq (local.get $scan) (i32.const 0x2E)) (then (local.set $ch (i32.const 0x43))))
      (if (i32.eq (local.get $scan) (i32.const 0x2F)) (then (local.set $ch (i32.const 0x56))))
      (if (i32.eq (local.get $scan) (i32.const 0x30)) (then (local.set $ch (i32.const 0x42))))
      (if (i32.eq (local.get $scan) (i32.const 0x31)) (then (local.set $ch (i32.const 0x4E))))
      (if (i32.eq (local.get $scan) (i32.const 0x32)) (then (local.set $ch (i32.const 0x4D))))
      ;; If a letter was matched, write it
      (if (local.get $ch) (then
        (i32.store8 (local.get $buf) (local.get $ch))
        (i32.store8 (i32.add (local.get $buf) (i32.const 1)) (i32.const 0))
        (local.set $len (i32.const 1)) (br $done)))
      ;; Alt (0x38)
      (if (i32.eq (local.get $scan) (i32.const 0x38)) (then
        (i32.store (local.get $buf) (i32.const 0x00746C41)) ;; "Alt\0"
        (local.set $len (i32.const 3)) (br $done)))
      ;; Space (0x39)
      (if (i32.eq (local.get $scan) (i32.const 0x39)) (then
        (i32.store (local.get $buf) (i32.const 0x63617053)) ;; "Spac"
        (i32.store16 (i32.add (local.get $buf) (i32.const 4)) (i32.const 0x0065)) ;; "e\0"
        (local.set $len (i32.const 5)) (br $done)))
      ;; F1-F10: scan 0x3B-0x44
      (if (i32.and (i32.ge_u (local.get $scan) (i32.const 0x3B)) (i32.le_u (local.get $scan) (i32.const 0x44)))
        (then
          (i32.store8 (local.get $buf) (i32.const 0x46))  ;; 'F'
          (local.set $ch (i32.sub (local.get $scan) (i32.const 0x3A)))
          (if (i32.le_u (local.get $ch) (i32.const 9))
            (then (i32.store8 (i32.add (local.get $buf) (i32.const 1)) (i32.add (i32.const 0x30) (local.get $ch)))
                  (i32.store8 (i32.add (local.get $buf) (i32.const 2)) (i32.const 0))
                  (local.set $len (i32.const 2)))
            (else (i32.store8 (i32.add (local.get $buf) (i32.const 1)) (i32.const 0x31))
                  (i32.store8 (i32.add (local.get $buf) (i32.const 2)) (i32.const 0x30))
                  (i32.store8 (i32.add (local.get $buf) (i32.const 3)) (i32.const 0))
                  (local.set $len (i32.const 3))))
          (br $done)))
      ;; Arrow keys: Up=0x48, Left=0x4B, Right=0x4D, Down=0x50
      (if (i32.eq (local.get $scan) (i32.const 0x48)) (then
        (i32.store (local.get $buf) (i32.const 0x00007055)) ;; "Up\0"
        (local.set $len (i32.const 2)) (br $done)))
      (if (i32.eq (local.get $scan) (i32.const 0x4B)) (then
        (i32.store (local.get $buf) (i32.const 0x7466654C)) ;; "Left"
        (i32.store8 (i32.add (local.get $buf) (i32.const 4)) (i32.const 0))
        (local.set $len (i32.const 4)) (br $done)))
      (if (i32.eq (local.get $scan) (i32.const 0x4D)) (then
        (i32.store (local.get $buf) (i32.const 0x68676952)) ;; "Righ"
        (i32.store16 (i32.add (local.get $buf) (i32.const 4)) (i32.const 0x0074)) ;; "t\0"
        (local.set $len (i32.const 5)) (br $done)))
      (if (i32.eq (local.get $scan) (i32.const 0x50)) (then
        (i32.store (local.get $buf) (i32.const 0x6E776F44)) ;; "Down"
        (i32.store8 (i32.add (local.get $buf) (i32.const 4)) (i32.const 0))
        (local.set $len (i32.const 4)) (br $done)))
      ;; F11-F12
      (if (i32.eq (local.get $scan) (i32.const 0x57)) (then
        (i32.store (local.get $buf) (i32.const 0x00313146)) ;; "F11\0"
        (local.set $len (i32.const 3)) (br $done)))
      (if (i32.eq (local.get $scan) (i32.const 0x58)) (then
        (i32.store (local.get $buf) (i32.const 0x00323146)) ;; "F12\0"
        (local.set $len (i32.const 3)) (br $done)))
      ;; Unknown: write "?"
      (i32.store16 (local.get $buf) (i32.const 0x003F))
      (local.set $len (i32.const 1))
    )
    (global.set $eax (local.get $len))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 789: SetObjectOwner — obsolete GDI function, no-op
  (func $handle_SetObjectOwner (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 792: timeGetTime — same as GetTickCount, returns ms
  (func $handle_timeGetTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $tick_count (call $host_get_ticks))
    (global.set $eax (global.get $tick_count))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; timeBeginPeriod(uPeriod) — request timer resolution. No-op stub, returns
  ;; TIMERR_NOERROR (0). Symmetric timeEndPeriod does the same.
  (func $handle_timeBeginPeriod (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))
  (func $handle_timeEndPeriod (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; timeGetDevCaps(lptc, cbtc) — fills TIMECAPS { wPeriodMin, wPeriodMax }.
  ;; We claim 1 ms min resolution and ~1000 s max, matching what real NT returns.
  (func $handle_timeGetDevCaps (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ptr i32)
    (if (i32.and (i32.ne (local.get $arg0) (i32.const 0))
                 (i32.ge_u (local.get $arg1) (i32.const 8)))
      (then
        (local.set $ptr (call $g2w (local.get $arg0)))
        (i32.store (local.get $ptr) (i32.const 1))
        (i32.store offset=4 (local.get $ptr) (i32.const 1000000))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 814: PathFindFileNameA(lpszPath) → pointer to filename component
  ;; Walks backwards from end of path string, returns pointer after last '\' or '/'
  (func $handle_PathFindFileNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ptr i32) (local $last i32) (local $ch i32)
    (local.set $ptr (call $g2w (local.get $arg0)))
    (local.set $last (local.get $ptr))
    (block $done (loop $scan
      (local.set $ch (i32.load8_u (local.get $ptr)))
      (br_if $done (i32.eqz (local.get $ch)))
      (if (i32.or (i32.eq (local.get $ch) (i32.const 0x5C))    ;; backslash
                  (i32.eq (local.get $ch) (i32.const 0x2F)))    ;; forward slash
        (then (local.set $last (i32.add (local.get $ptr) (i32.const 1)))))
      (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
      (br $scan)))
    ;; Convert WASM pointer back to guest address
    (global.set $eax (i32.add (i32.sub (local.get $last) (call $g2w (local.get $arg0))) (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; 815: StrStrIA(lpFirst, lpSrch) → pointer to match or NULL
  ;; Case-insensitive substring search using byte-by-byte comparison
  (func $handle_StrStrIA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hay i32) (local $ndl i32) (local $hi i32) (local $ni i32)
    (local $hc i32) (local $nc i32) (local $ndl_len i32)
    ;; Get needle length
    (local.set $ndl (call $g2w (local.get $arg1)))
    (local.set $ndl_len (call $strlen (local.get $ndl)))
    (if (i32.eqz (local.get $ndl_len))
      (then (global.set $eax (local.get $arg0))
             (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (local.set $hay (call $g2w (local.get $arg0)))
    ;; Outer loop: try each position in haystack
    (block $not_found (loop $outer
      (br_if $not_found (i32.eqz (i32.load8_u (local.get $hay))))
      ;; Inner loop: compare needle at current position
      (local.set $hi (local.get $hay))
      (local.set $ni (local.get $ndl))
      (block $mismatch (loop $inner
        (local.set $nc (i32.load8_u (local.get $ni)))
        (if (i32.eqz (local.get $nc))
          (then ;; needle exhausted = match found
            (global.set $eax (i32.add (i32.sub (local.get $hay) (call $g2w (local.get $arg0))) (local.get $arg0)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
        (local.set $hc (i32.load8_u (local.get $hi)))
        (br_if $mismatch (i32.eqz (local.get $hc)))
        ;; Lowercase both chars for comparison (ASCII a-z/A-Z only)
        (if (i32.and (i32.ge_u (local.get $hc) (i32.const 0x41)) (i32.le_u (local.get $hc) (i32.const 0x5A)))
          (then (local.set $hc (i32.or (local.get $hc) (i32.const 0x20)))))
        (if (i32.and (i32.ge_u (local.get $nc) (i32.const 0x41)) (i32.le_u (local.get $nc) (i32.const 0x5A)))
          (then (local.set $nc (i32.or (local.get $nc) (i32.const 0x20)))))
        (br_if $mismatch (i32.ne (local.get $hc) (local.get $nc)))
        (local.set $hi (i32.add (local.get $hi) (i32.const 1)))
        (local.set $ni (i32.add (local.get $ni) (i32.const 1)))
        (br $inner)))
      (local.set $hay (i32.add (local.get $hay) (i32.const 1)))
      (br $outer)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 816: GetPropA(hwnd, lpString) → HANDLE
  ;; Returns property value for the window+key pair via host import
  (func $handle_GetPropA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_get_prop (local.get $arg0) (call $g2w (local.get $arg1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 817: SetPropA(hwnd, lpString, hData) → BOOL
  ;; Stores property value for the window+key pair via host import
  (func $handle_SetPropA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_set_prop (local.get $arg0) (call $g2w (local.get $arg1)) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 862: GlobalMemoryStatus(lpBuffer) — fill MEMORYSTATUS struct
  (func $handle_GlobalMemoryStatus (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (call $zero_memory (local.get $wa) (i32.const 32))
    (i32.store (local.get $wa) (i32.const 32))             ;; dwLength
    (i32.store offset=4 (local.get $wa) (i32.const 50))    ;; dwMemoryLoad = 50%
    (i32.store offset=8 (local.get $wa) (i32.const 0x04000000))  ;; dwTotalPhys = 64MB
    (i32.store offset=12 (local.get $wa) (i32.const 0x02000000)) ;; dwAvailPhys = 32MB
    (i32.store offset=16 (local.get $wa) (i32.const 0x10000000)) ;; dwTotalPageFile = 256MB
    (i32.store offset=20 (local.get $wa) (i32.const 0x08000000)) ;; dwAvailPageFile = 128MB
    (i32.store offset=24 (local.get $wa) (i32.const 0x7FFE0000)) ;; dwTotalVirtual
    (i32.store offset=28 (local.get $wa) (i32.const 0x7FFC0000)) ;; dwAvailVirtual
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; 852: RemovePropA(hwnd, lpString) → HANDLE (removed value)
  (func $handle_RemovePropA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_remove_prop (local.get $arg0) (call $g2w (local.get $arg1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 824: GetConsoleOutputCP() → UINT — returns output code page
  (func $handle_GetConsoleOutputCP (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 437))  ;; CP 437 (OEM United States)
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  ;; 825: mixerGetLineInfoW(hmxobj, pmxl, fdwInfo) → MMRESULT
  ;; Returns MMSYSERR_NODRIVER (6) — no audio mixer available
  (func $handle_mixerGetLineInfoW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 6))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 826: mixerGetNumDevs() → UINT — returns 0 (no mixer devices)
  (func $handle_mixerGetNumDevs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  ;; 827: CreateConsoleScreenBuffer(dwDesiredAccess, dwShareMode, lpSecurityAttributes, dwFlags, lpScreenBufferData) → HANDLE
  ;; Returns a fake console handle
  (func $handle_CreateConsoleScreenBuffer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x00030001))  ;; fake console handle
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; 821: mixerGetID(hmxobj, puMxId, fdwId) → MMRESULT
  ;; Returns MMSYSERR_NODRIVER (6) — no audio mixer device available
  (func $handle_mixerGetID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 6))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 822: CreateDialogParamW(hInstance, lpTemplateName, hWndParent, lpDialogFunc, dwInitParam)
  ;; Wide-char version — same template layout as A, different lpTemplateName
  ;; encoding when it's a string (UTF-16 vs ASCII). Our $find_resource only
  ;; understands integer IDs and ASCII guest string names, so UTF-16
  ;; template names still go through as-is and fall to the int branch.
  (func $handle_CreateDialogParamW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hwnd i32)
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (global.set $dlg_hwnd (local.get $hwnd))
    (call $wnd_table_set (local.get $hwnd) (local.get $arg3))
    (drop (call $dlg_load (local.get $hwnd) (local.get $arg1)))
    (call $host_dialog_loaded (local.get $hwnd) (local.get $arg2))
    (global.set $eax (local.get $hwnd))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))


  ;; 820: PathGetArgsA(pszPath) → pointer to args after first unquoted space
  (func $handle_PathGetArgsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ptr i32) (local $ch i32) (local $in_quote i32)
    (local.set $ptr (call $g2w (local.get $arg0)))
    (block $done (loop $scan
      (local.set $ch (i32.load8_u (local.get $ptr)))
      (br_if $done (i32.eqz (local.get $ch)))
      (if (i32.eq (local.get $ch) (i32.const 0x22))  ;; quote
        (then (local.set $in_quote (i32.xor (local.get $in_quote) (i32.const 1)))))
      (if (i32.and (i32.eq (local.get $ch) (i32.const 0x20)) (i32.eqz (local.get $in_quote)))
        (then
          ;; Skip spaces
          (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
          (block $end_sp (loop $sp
            (br_if $end_sp (i32.ne (i32.load8_u (local.get $ptr)) (i32.const 0x20)))
            (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
            (br $sp)))
          (global.set $eax (i32.add (i32.sub (local.get $ptr) (call $g2w (local.get $arg0))) (local.get $arg0)))
          (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
      (br $scan)))
    ;; No args found, return pointer to NUL terminator
    (global.set $eax (i32.add (i32.sub (local.get $ptr) (call $g2w (local.get $arg0))) (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; 818: FindResourceExA(hModule, lpType, lpName, wLanguage) → HRSRC
  ;; Same as FindResourceA but with explicit language (we use first lang match)
  (func $handle_FindResourceExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (global.get $rsrc_rva))
      (then (global.set $eax (i32.const 0))
             (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; FindResourceExA: arg1=type, arg2=name (reversed from FindResourceA)
    (global.set $eax (call $find_resource (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; 819: StrChrA(lpStart, wMatch) → pointer to first occurrence or NULL
  (func $handle_StrChrA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ptr i32) (local $ch i32)
    (local.set $ptr (call $g2w (local.get $arg0)))
    (block $not_found (loop $scan
      (local.set $ch (i32.load8_u (local.get $ptr)))
      (br_if $not_found (i32.eqz (local.get $ch)))
      (if (i32.eq (local.get $ch) (i32.and (local.get $arg1) (i32.const 0xFF)))
        (then
          (global.set $eax (i32.add (i32.sub (local.get $ptr) (call $g2w (local.get $arg0))) (local.get $arg0)))
          (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
      (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
      (br $scan)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; CommandLineToArgvW — already handled above as crash stub replacement
