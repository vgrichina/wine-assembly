  ;; ============================================================
  ;; SUB-DISPATCHERS & MISC LATE-ADDED HANDLERS
  ;; ============================================================

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

  ;; 704: RegisterClipboardFormatA — returns registered clipboard format ID
  (func $handle_RegisterClipboardFormatA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (local.get $arg1))
    (drop (local.get $arg2))
    (drop (local.get $arg3))
    (drop (local.get $arg4))
    (drop (local.get $name_ptr))
    (global.set $eax (call $clipboard_register_format_a (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) ;; stdcall 1 param
  )

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

  ;; LR_LOADFROMFILE: `name` is a path, not a resource id. Read the .bmp
  ;; through the VFS and build the bitmap from its BITMAPFILEHEADER + DIB, so
  ;; the caller gets the file's real pixels at the file's real size. Returns 0
  ;; when the file is missing or is not a BMP, leaving the resource path to
  ;; decide what to do next.
  (func $load_image_bitmap_file (param $path_wa i32) (result i32)
    (local $handle i32) (local $size i32) (local $buf_ga i32) (local $buf_wa i32)
    (local $read_ga i32) (local $off i32) (local $hdr i32) (local $bmp i32)
    (local.set $handle (call $host_fs_create_file
      (local.get $path_wa) (i32.const 0x80000000)
      (i32.const 3) (i32.const 0x80) (i32.const 0)))
    (if (i32.eq (local.get $handle) (i32.const -1)) (then (return (i32.const 0))))
    (local.set $size (call $host_fs_get_file_size (local.get $handle)))
    ;; 54 = BITMAPFILEHEADER + BITMAPINFOHEADER, the smallest legal BMP.
    (if (i32.or (i32.lt_u (local.get $size) (i32.const 54))
                (i32.gt_u (local.get $size) (i32.const 0x2000000)))
      (then
        (drop (call $host_fs_close_handle (local.get $handle)))
        (return (i32.const 0))))
    (local.set $buf_ga (call $heap_alloc (local.get $size)))
    (local.set $read_ga (call $heap_alloc (i32.const 4)))
    (if (i32.or (i32.eqz (local.get $buf_ga)) (i32.eqz (local.get $read_ga)))
      (then
        (drop (call $host_fs_close_handle (local.get $handle)))
        (if (local.get $buf_ga) (then (call $heap_free (local.get $buf_ga))))
        (if (local.get $read_ga) (then (call $heap_free (local.get $read_ga))))
        (return (i32.const 0))))
    (i32.store (call $g2w (local.get $read_ga)) (i32.const 0))
    (drop (call $host_fs_read_file
      (local.get $handle) (local.get $buf_ga) (local.get $size) (local.get $read_ga)))
    (drop (call $host_fs_close_handle (local.get $handle)))
    (local.set $size (i32.load (call $g2w (local.get $read_ga))))
    (call $heap_free (local.get $read_ga))
    (local.set $buf_wa (call $g2w (local.get $buf_ga)))
    ;; 0x4D42 = 'BM'
    (if (i32.or (i32.lt_u (local.get $size) (i32.const 54))
                (i32.ne (i32.load16_u (local.get $buf_wa)) (i32.const 0x4D42)))
      (then
        (call $heap_free (local.get $buf_ga))
        (return (i32.const 0))))
    (local.set $hdr (i32.add (local.get $buf_wa) (i32.const 14)))
    (local.set $off (i32.load offset=10 (local.get $buf_wa)))  ;; bfOffBits
    ;; A wrong bfOffBits is common in hand-built files; fall back to the header
    ;; size, which is what GDI itself uses when the offset is not plausible.
    (if (i32.or (i32.lt_u (local.get $off) (i32.const 54))
                (i32.ge_u (local.get $off) (local.get $size)))
      (then (local.set $off (i32.add (i32.const 14) (i32.load (local.get $hdr))))))
    (if (i32.ge_u (local.get $off) (local.get $size))
      (then
        (call $heap_free (local.get $buf_ga))
        (return (i32.const 0))))
    (local.set $bmp (call $gdi_bitmap_create_dibitmap
      (i32.const 0) (local.get $hdr)
      (i32.add (local.get $buf_wa) (local.get $off))
      (i32.const 1) (i32.const 0)))
    (call $heap_free (local.get $buf_ga))
    (local.get $bmp))

  ;; 711: LoadImageA(hInst, name, type, cx, cy, fuLoad) — delegate to LoadIcon/LoadCursor/LoadBitmap
  (func $handle_LoadImageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    ;; arg0=hInst, arg1=name, arg2=type, arg3=cx, arg4=cy, [esp+24]=fuLoad
    ;; IMAGE_BITMAP (0): load from PE resources via host.
    ;; arg1 may be MAKEINTRESOURCE (<=0xFFFF) or a string pointer (named resource).
    (if (i32.eqz (local.get $arg2))
      (then
        ;; LR_LOADFROMFILE (0x10) — name is a path; the resource walker has
        ;; nothing to find. Pawn loads its two board squares this way.
        (if (i32.and
              (i32.ne (i32.and (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
                               (i32.const 0x10)) (i32.const 0))
              (i32.gt_u (local.get $arg1) (i32.const 0xFFFF)))
          (then
            (local.set $tmp (call $load_image_bitmap_file (call $g2w (local.get $arg1))))
            (if (local.get $tmp)
              (then
                (global.set $eax (local.get $tmp))
                (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
                (return)))))
        (local.set $tmp (call $host_gdi_load_bitmap (local.get $arg0)
          (if (result i32) (i32.gt_u (local.get $arg1) (i32.const 0xFFFF))
            (then (local.get $arg1))
            (else (i32.and (local.get $arg1) (i32.const 0xFFFF))))))
        (if (i32.eqz (local.get $tmp))
          (then (local.set $tmp (call $host_gdi_create_compat_bitmap
            (i32.const 0) (i32.const 32) (i32.const 32) (i32.const 0)))))
        (global.set $eax (local.get $tmp))
        (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))
    ;; IMAGE_ICON (1): intern the resource so DrawIconEx can find its pixels
    ;; later — same handle space as LoadIconA. Named resources keep the old
    ;; opaque handle, since the RT_GROUP_ICON walker addresses by ordinal.
    (if (i32.eq (local.get $arg2) (i32.const 1))
      (then
        (if (i32.and (i32.ne (local.get $arg0) (i32.const 0))
                     (i32.le_u (local.get $arg1) (i32.const 0xFFFF)))
          (then (local.set $tmp (call $icon_intern (local.get $arg0) (local.get $arg1))))
          (else (local.set $tmp (i32.const 0))))
        (if (i32.eqz (local.get $tmp)) (then (local.set $tmp (i32.const 0x60001))))
        (global.set $eax (local.get $tmp))
        (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))
    ;; IMAGE_CURSOR (2): return cursor handle (same encoding as LoadCursorA)
    (if (i32.eq (local.get $arg2) (i32.const 2))
      (then
        (if (i32.and (i32.eqz (local.get $arg0))
                     (i32.lt_u (local.get $arg1) (i32.const 0x10000)))
          (then (global.set $eax (i32.or (i32.const 0x60000)
                                         (i32.and (local.get $arg1) (i32.const 0xFFFF)))))
          (else
            (if (i32.lt_u (local.get $arg1) (i32.const 0x10000))
              (then (global.set $eax (i32.or (i32.const 0x680000)
                                             (i32.and (local.get $arg1) (i32.const 0xFFFF)))))
              (else (global.set $eax (i32.const 0x67F00))))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))
    ;; Unknown type: return NULL
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; stdcall, 6 args
  )

  ;; LoadImageW has identical resource-id semantics for the integer resources
  ;; used by Win98 Media Player. Named bitmap resources are uncommon here; the
  ;; host resource lookup accepts the same guest pointer for either variant.
  (func $handle_LoadImageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_LoadImageA
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr)))

  ;; Invoke the current LineDDA point callback, or finish the original API.
  (func $line_dda_abs (param $value i32) (result i32)
    (select (i32.sub (i32.const 0) (local.get $value)) (local.get $value)
      (i32.lt_s (local.get $value) (i32.const 0))))

  (func $line_dda_continue
    (local $e2 i32)
    ;; Endpoint is excluded, matching GDI's line convention and LineDDA docs.
    (if (i32.and (i32.eq (global.get $line_dda_x) (global.get $line_dda_end_x))
          (i32.eq (global.get $line_dda_y) (global.get $line_dda_end_y)))
      (then
        (global.set $eip (global.get $line_dda_ret))
        (global.set $eax (i32.const 1))
        (return)))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $line_dda_data))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $line_dda_y))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $line_dda_x))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $line_dda_ret_thunk))
    (global.set $eip (global.get $line_dda_callback))
    (global.set $steps (i32.const 0)))

  (func $line_dda_advance
    (local $e2 i32)
    (local.set $e2 (i32.shl (global.get $line_dda_err) (i32.const 1)))
    (if (i32.ge_s (local.get $e2) (global.get $line_dda_dy))
      (then
        (global.set $line_dda_err
          (i32.add (global.get $line_dda_err) (global.get $line_dda_dy)))
        (global.set $line_dda_x
          (i32.add (global.get $line_dda_x) (global.get $line_dda_sx)))))
    (if (i32.le_s (local.get $e2) (global.get $line_dda_dx))
      (then
        (global.set $line_dda_err
          (i32.add (global.get $line_dda_err) (global.get $line_dda_dx)))
        (global.set $line_dda_y
          (i32.add (global.get $line_dda_y) (global.get $line_dda_sy)))))
    (call $line_dda_continue))

  ;; 712: LineDDA(xStart, yStart, xEnd, yEnd, lpProc, lParam).
  (func $handle_LineDDA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (local.get $arg4))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
        (return)))
    (global.set $line_dda_ret (call $gl32 (global.get $esp)))
    (global.set $line_dda_callback (local.get $arg4))
    (global.set $line_dda_data (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (global.set $line_dda_x (local.get $arg0))
    (global.set $line_dda_y (local.get $arg1))
    (global.set $line_dda_end_x (local.get $arg2))
    (global.set $line_dda_end_y (local.get $arg3))
    (global.set $line_dda_dx (call $line_dda_abs (i32.sub (local.get $arg2) (local.get $arg0))))
    (global.set $line_dda_dy (i32.sub (i32.const 0)
      (call $line_dda_abs (i32.sub (local.get $arg3) (local.get $arg1)))))
    (global.set $line_dda_sx (select (i32.const 1) (i32.const -1)
      (i32.lt_s (local.get $arg0) (local.get $arg2))))
    (global.set $line_dda_sy (select (i32.const 1) (i32.const -1)
      (i32.lt_s (local.get $arg1) (local.get $arg3))))
    (global.set $line_dda_err (i32.add (global.get $line_dda_dx) (global.get $line_dda_dy)))
    ;; Discard the original stdcall frame before entering the first callback.
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
    (call $line_dda_continue)
  )

  ;; 713: OpenFile(lpFileName, lpReOpenBuff, uStyle) — delegate to host_fs_create_file
  ;; arg0=lpFileName, arg1=lpReOpenBuff (OFSTRUCT), arg2=uStyle
  (func $handle_OpenFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $handle i32) (local $buf_wa i32) (local $i i32) (local $ch i32)
    (local $access i32) (local $creation i32)
    ;; OF_READ=0, OF_WRITE=1, OF_READWRITE=2. OF_CREATE=0x1000 creates or
    ;; truncates the destination; InstallShield combines it with READWRITE
    ;; while creating its temporary stage files.
    (local.set $access
      (if (result i32) (i32.eq (i32.and (local.get $arg2) (i32.const 3)) (i32.const 1))
        (then (i32.const 0x40000000)) ;; GENERIC_WRITE
        (else
          (if (result i32) (i32.eq (i32.and (local.get $arg2) (i32.const 3)) (i32.const 2))
            (then (i32.const 0xC0000000)) ;; GENERIC_READ | GENERIC_WRITE
            (else (i32.const 0x80000000)))))) ;; GENERIC_READ
    (local.set $creation
      (select (i32.const 2) (i32.const 3)
        (i32.ne (i32.and (local.get $arg2) (i32.const 0x1000)) (i32.const 0))))
    (local.set $handle (call $host_fs_create_file
      (call $g2w (local.get $arg0))
      (local.get $access)
      (local.get $creation)
      (i32.const 0x80)        ;; FILE_ATTRIBUTE_NORMAL
      (i32.const 0)))         ;; isWide=0
    ;; Fill OFSTRUCT if provided
    (if (local.get $arg1)
      (then
        (local.set $buf_wa (call $g2w (local.get $arg1)))
        (i32.store8 (local.get $buf_wa) (i32.const 136))  ;; cBytes
        ;; fFixedDisk, and the file's time and date where DOS puts them. There
        ;; is one drive here and it is not removable, and the timestamp is the
        ;; same fixed one INT 21h AH=57h reports — this filesystem keeps none,
        ;; and answering with a different invented value each call would be
        ;; worse than answering with one.
        (i32.store8 (i32.add (local.get $buf_wa) (i32.const 1)) (i32.const 1))
        (i32.store16 (i32.add (local.get $buf_wa) (i32.const 4)) (i32.const 0))
        (i32.store16 (i32.add (local.get $buf_wa) (i32.const 6)) (i32.const 0x2421))
        (if (i32.eq (local.get $handle) (i32.const -1))
          (then (i32.store16 (i32.add (local.get $buf_wa) (i32.const 2)) (i32.const 2)))  ;; nErrCode=FILE_NOT_FOUND
          (else (i32.store16 (i32.add (local.get $buf_wa) (i32.const 2)) (i32.const 0))))
        ;; szPathName at +8: the name the file was opened under. Callers read
        ;; the file back out of here rather than keeping their own copy —
        ;; Visual Basic opens a custom control with OpenFile and then hands
        ;; this field to LoadLibrary, which was being given 128 bytes of zero.
        (local.set $i (i32.const 0))
        (block $named (loop $chars
          (br_if $named (i32.ge_u (local.get $i) (i32.const 127)))
          (local.set $ch (i32.load8_u (i32.add (call $g2w (local.get $arg0)) (local.get $i))))
          ;; DOS reports the path in upper case and callers compare it.
          (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x61))
                       (i32.le_u (local.get $ch) (i32.const 0x7A)))
            (then (local.set $ch (i32.sub (local.get $ch) (i32.const 0x20)))))
          (i32.store8 (i32.add (i32.add (local.get $buf_wa) (i32.const 8)) (local.get $i))
            (local.get $ch))
          (br_if $named (i32.eqz (local.get $ch)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $chars)))
        (i32.store8 (i32.add (i32.add (local.get $buf_wa) (i32.const 8)) (i32.const 127))
          (i32.const 0))))
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
    (local $wa i32) (local $border i32) (local $caption i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (local.set $border (i32.ne (i32.and (local.get $arg1) (i32.const 0x00CC0000)) (i32.const 0)))
    (local.set $caption (i32.eq (i32.and (local.get $arg1) (i32.const 0x00C00000)) (i32.const 0x00C00000)))
    (if (i32.or (local.get $border) (local.get $caption)) (then
      (i32.store (local.get $wa) (i32.sub (i32.load (local.get $wa)) (i32.const 4)))
      (i32.store offset=4 (local.get $wa)
        (i32.sub (i32.load offset=4 (local.get $wa))
          (i32.add (i32.const 4)
            (i32.add (select (i32.const 20) (i32.const 0) (local.get $caption))
                     (select (i32.const 19) (i32.const 0) (local.get $arg2))))))
      (i32.store offset=8 (local.get $wa) (i32.add (i32.load offset=8 (local.get $wa)) (i32.const 4)))
      (i32.store offset=12 (local.get $wa) (i32.add (i32.load offset=12 (local.get $wa)) (i32.const 4)))
    ))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; 717: GetDCOrgEx(hdc, lppt) — final device origin in screen coordinates.
  ;; Memory, DirectDraw, printer, and screen DCs have no USER window binding
  ;; and therefore retain the device origin (0,0). Window DC bindings live in
  ;; the canonical DC record: positive hwnd for client DCs, sign-bit hwnd for
  ;; whole-window DCs.
  (func $handle_GetDCOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $dc i32) (local $binding i32) (local $hwnd i32)
    (local $x i32) (local $y i32)
    (local.set $dc (call $gdi_dc_state_entry (local.get $arg0) (i32.const 0)))
    (if (i32.or (i32.eqz (local.get $dc)) (i32.eqz (local.get $arg1)))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (local.set $binding (i32.load offset=92 (local.get $dc)))
    (if (local.get $binding)
      (then
        (local.set $hwnd (i32.and (local.get $binding) (i32.const 0x7FFFFFFF)))
        (if (i32.eq (call $wnd_table_find (local.get $hwnd)) (i32.const -1))
          (then
            (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
            (return)))
        (if (i32.lt_s (local.get $binding) (i32.const 0))
          (then
            (local.set $x (call $wnd_window_screen_x (local.get $hwnd)))
            (local.set $y (call $wnd_window_screen_y (local.get $hwnd))))
          (else
            (local.set $x (call $wnd_client_screen_x (local.get $hwnd)))
            (local.set $y (call $wnd_client_screen_y (local.get $hwnd)))))))
    (local.set $wa (call $g2w (local.get $arg1)))
    (i32.store (local.get $wa) (local.get $x))
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (local.get $y))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 741: QueryPerformanceCounter(lpPerformanceCount) — tie to wall clock.
  ;; Frequency is 1MHz (see below), so one tick = 1µs. host_get_ticks() is ms,
  ;; multiply by 1000. Also advance by $perf_counter_lo so consecutive calls
  ;; within the same ms still differ (some apps busy-wait on QPC). The global
  ;; increment keeps monotonicity even when the wall clock doesn't move.
  (func $handle_QueryPerformanceCounter (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $val i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (local.set $val
      (i32.add (i32.mul (call $host_get_ticks) (i32.const 1000))
               (global.get $perf_counter_lo)))
    (i32.store (local.get $wa) (local.get $val))
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0))
    (global.set $perf_counter_lo (i32.add (global.get $perf_counter_lo) (i32.const 1)))
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
    ;; SetClassLongA(hwnd, nIndex, dwNewLong) -> previous value. Writes the
    ;; hwnd's own class record, so the change is visible to every window of
    ;; that class -- which is the whole point of the call.
    (global.set $eax
      (call $class_long_set (local.get $arg0) (local.get $arg1) (local.get $arg2)))
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
    (if (i32.eqz (global.get $fake_cmdline_addr))
      (then (call $store_fake_cmdline)))
    (call $gs32 (local.get $arg0)
      (call $gl32 (i32.add (global.get $fake_cmdline_addr) (i32.const 508))))
    (call $gs32 (local.get $arg1)
      (i32.add (global.get $fake_cmdline_addr) (i32.const 1024)))
    (call $gs32 (local.get $arg2)
      (i32.add (global.get $fake_cmdline_addr) (i32.const 1532)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; cdecl
  )

  ;; 752: SetWindowsHookW(idHook, lpfn) — old-style hook, return fake handle
  (func $handle_SetWindowsHookW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_SetWindowsHookA
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
  )

  ;; SetWindowsHookA(idHook, lpfn) — old-style hook, return fake handle
  (func $handle_SetWindowsHookA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x00DEAD02))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 753: RegisterPenApp(style, fRegister) — no-op, pen input not supported
  (func $handle_RegisterPenApp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; Look up dwMessageId in the active module's RT_MESSAGETABLE (type 11) and
  ;; write it to $out_wa as ANSI. Returns the length written, or -1 when the
  ;; module has no message table or the id is not in it.
  ;;
  ;; MESSAGE_RESOURCE_DATA is a count followed by that many blocks of
  ;; {LowId, HighId, OffsetToEntries}; the entries a block points at are
  ;; variable-length {Length, Flags, text...} records walked in id order.
  ;; Flags bit 0 means the text is UTF-16, which is the common case.
  (func $message_table_lookup (param $id i32) (param $out_wa i32) (result i32)
    (local $data_entry i32) (local $table i32) (local $blocks i32) (local $i i32)
    (local $blk i32) (local $lo i32) (local $hi i32) (local $entry i32)
    (local $skip i32) (local $len i32) (local $flags i32) (local $n i32)
    (local $ch i32)
    (local.set $data_entry (call $find_resource (i32.const 11) (i32.const 1)))
    (if (i32.eqz (local.get $data_entry)) (then (return (i32.const -1))))
    (local.set $table (call $g2w (i32.add (call $r_base)
      (call $gl32 (i32.add (call $r_base) (local.get $data_entry))))))
    (local.set $blocks (i32.load (local.get $table)))
    (block $found (block $missing
      (loop $scan
        (br_if $missing (i32.ge_u (local.get $i) (local.get $blocks)))
        (local.set $blk (i32.add (local.get $table)
          (i32.add (i32.const 4) (i32.mul (local.get $i) (i32.const 12)))))
        (local.set $lo (i32.load (local.get $blk)))
        (local.set $hi (i32.load offset=4 (local.get $blk)))
        (if (i32.and (i32.ge_u (local.get $id) (local.get $lo))
                     (i32.le_u (local.get $id) (local.get $hi)))
          (then
            (local.set $entry (i32.add (local.get $table) (i32.load offset=8 (local.get $blk))))
            (local.set $skip (i32.sub (local.get $id) (local.get $lo)))
            (br $found)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $scan))
      )
      (return (i32.const -1)))
    ;; Walk to the requested entry — records are variable length.
    (block $at (loop $next
      (br_if $at (i32.eqz (local.get $skip)))
      (local.set $entry (i32.add (local.get $entry) (i32.load16_u (local.get $entry))))
      (local.set $skip (i32.sub (local.get $skip) (i32.const 1)))
      (br $next)))
    (local.set $len (i32.load16_u (local.get $entry)))
    (local.set $flags (i32.load16_u offset=2 (local.get $entry)))
    (local.set $entry (i32.add (local.get $entry) (i32.const 4)))
    (local.set $len (i32.sub (local.get $len) (i32.const 4)))
    (local.set $n (i32.const 0))
    (if (i32.and (local.get $flags) (i32.const 1))
      (then
        ;; UTF-16 text: keep the low byte of each unit, which is all a Win98
        ;; message table for an ANSI caller ever holds.
        (block $done (loop $w
          (br_if $done (i32.ge_u (i32.mul (local.get $n) (i32.const 2)) (local.get $len)))
          (local.set $ch (i32.load16_u
            (i32.add (local.get $entry) (i32.mul (local.get $n) (i32.const 2)))))
          (br_if $done (i32.eqz (local.get $ch)))
          (i32.store8 (i32.add (local.get $out_wa) (local.get $n))
            (i32.and (local.get $ch) (i32.const 0xFF)))
          (local.set $n (i32.add (local.get $n) (i32.const 1)))
          (br $w))))
      (else
        (block $done (loop $a
          (br_if $done (i32.ge_u (local.get $n) (local.get $len)))
          (local.set $ch (i32.load8_u (i32.add (local.get $entry) (local.get $n))))
          (br_if $done (i32.eqz (local.get $ch)))
          (i32.store8 (i32.add (local.get $out_wa) (local.get $n)) (local.get $ch))
          (local.set $n (i32.add (local.get $n) (i32.const 1)))
          (br $a)))))
    ;; "%0" ends the message text without a newline. winipcfg depends on it:
    ;; its adapter-type entries read "Ethernet %0\r\n" and the visible label is
    ;; the part before the %0, concatenated with text from the dialog template.
    (local.set $i (i32.const 0))
    (block $scanned (loop $pct
      (br_if $scanned (i32.ge_u (i32.add (local.get $i) (i32.const 1)) (local.get $n)))
      (if (i32.and
            (i32.eq (i32.load8_u (i32.add (local.get $out_wa) (local.get $i)))
                    (i32.const 37))
            (i32.eq (i32.load8_u
                      (i32.add (local.get $out_wa) (i32.add (local.get $i) (i32.const 1))))
                    (i32.const 48)))
        (then (local.set $n (local.get $i)) (br $scanned)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $pct)))
    ;; Message-table text is stored with its trailing CRLF; callers that place
    ;; it in a dialog label want the line, not the terminator.
    (block $trimmed (loop $trim
      (br_if $trimmed (i32.eqz (local.get $n)))
      (local.set $ch (i32.load8_u
        (i32.add (local.get $out_wa) (i32.sub (local.get $n) (i32.const 1)))))
      (br_if $trimmed (i32.and (i32.ne (local.get $ch) (i32.const 13))
                               (i32.ne (local.get $ch) (i32.const 10))))
      (local.set $n (i32.sub (local.get $n) (i32.const 1)))
      (br $trim)))
    (i32.store8 (i32.add (local.get $out_wa) (local.get $n)) (i32.const 0))
    (local.get $n))

  ;; One output byte of $format_message_expand. $dst == 0 means "measure only",
  ;; which is how the ALLOCATE_BUFFER path learns the size before it allocates.
  ;; $max counts the NUL, so the last writable index is $max - 2.
  (func $fmsg_put (param $dst i32) (param $o i32) (param $max i32) (param $ch i32) (result i32)
    (if (i32.and (i32.ne (local.get $dst) (i32.const 0))
                 (i32.or (i32.eqz (local.get $max))
                         (i32.lt_u (local.get $o) (i32.sub (local.get $max) (i32.const 1)))))
      (then (i32.store8 (i32.add (local.get $dst) (local.get $o)) (local.get $ch))))
    (i32.add (local.get $o) (i32.const 1)))

  ;; Write $val in base $base, no buffer of its own — the digits go straight
  ;; out through $fmsg_put, so this works in measure mode too.
  (func $fmsg_put_num (param $dst i32) (param $o i32) (param $max i32)
                      (param $val i32) (param $base i32) (param $signed i32) (result i32)
    (local $div i32) (local $d i32)
    (if (i32.and (local.get $signed) (i32.lt_s (local.get $val) (i32.const 0)))
      (then
        (local.set $o (call $fmsg_put (local.get $dst) (local.get $o) (local.get $max) (i32.const 45)))
        (local.set $val (i32.sub (i32.const 0) (local.get $val)))))
    (local.set $div (i32.const 1))
    (block $sized (loop $grow
      (br_if $sized (i32.lt_u (i32.div_u (local.get $val) (local.get $div)) (local.get $base)))
      ;; Stop before $div overflows: 10 digits is already the whole i32 range.
      (br_if $sized (i32.gt_u (local.get $div) (i32.const 0x19999999)))
      (local.set $div (i32.mul (local.get $div) (local.get $base)))
      (br $grow)))
    (block $done (loop $emit
      (local.set $d (i32.rem_u (i32.div_u (local.get $val) (local.get $div)) (local.get $base)))
      (local.set $o (call $fmsg_put (local.get $dst) (local.get $o) (local.get $max)
        (select (i32.add (local.get $d) (i32.const 87))     ;; 'a'..'f'
                (i32.add (local.get $d) (i32.const 48))     ;; '0'..'9'
                (i32.gt_u (local.get $d) (i32.const 9)))))
      (br_if $done (i32.eq (local.get $div) (i32.const 1)))
      (local.set $div (i32.div_u (local.get $div) (local.get $base)))
      (br $emit)))
    (local.get $o))

  ;; Expand a message template's inserts. Everything here is the documented
  ;; FormatMessage syntax, which is not printf: %1..%99 name the Arguments
  ;; entries positionally, and the escapes are their own small language.
  ;;
  ;;   %%      a literal percent          %.  a literal period
  ;;   %!      a literal exclamation      %b  a space
  ;;   %r      a carriage return          %n  a hard line break
  ;;   %0      ends the message here, with no trailing newline
  ;;   %N      Arguments[N-1] as a string (the default when no spec follows)
  ;;   %N!spec!  the same argument through a printf-style spec; a spec ending
  ;;             in s is a string, d/i/u/x/X are numbers, anything else is
  ;;             treated as a string because that is the safer guess.
  ;;
  ;; $src and $dst are WASM addresses; the Arguments array is a guest pointer
  ;; to DWORDs (a va_list on x86 is exactly that, so ARGUMENT_ARRAY needs no
  ;; separate path). Returns the length not counting the NUL, which is what
  ;; FormatMessage returns, and is the true length even when the output was
  ;; truncated to $max.
  (func $format_message_expand
      (param $src i32) (param $dst i32) (param $max i32) (param $args_g i32) (result i32)
    (local $i i32) (local $o i32) (local $ch i32) (local $nxt i32)
    (local $n i32) (local $base i32) (local $as_int i32) (local $spec i32)
    (local $argv i32) (local $p i32)
    (block $done (loop $scan
      (local.set $ch (i32.load8_u (i32.add (local.get $src) (local.get $i))))
      (br_if $done (i32.eqz (local.get $ch)))
      (if (i32.ne (local.get $ch) (i32.const 37))   ;; '%'
        (then
          (local.set $o (call $fmsg_put (local.get $dst) (local.get $o) (local.get $max) (local.get $ch)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $scan)))
      (local.set $nxt (i32.load8_u (i32.add (local.get $src) (i32.add (local.get $i) (i32.const 1)))))
      ;; A trailing '%' is just a '%'.
      (if (i32.eqz (local.get $nxt))
        (then
          (local.set $o (call $fmsg_put (local.get $dst) (local.get $o) (local.get $max) (i32.const 37)))
          (br $done)))
      (if (i32.or (i32.lt_u (local.get $nxt) (i32.const 48))
                  (i32.gt_u (local.get $nxt) (i32.const 57)))
        (then
          ;; Not a digit — one of the escapes, or an unknown sequence that is
          ;; safest passed through unchanged.
          (local.set $i (i32.add (local.get $i) (i32.const 2)))
          (if (i32.eq (local.get $nxt) (i32.const 98))        ;; 'b'
            (then (local.set $o (call $fmsg_put (local.get $dst) (local.get $o) (local.get $max) (i32.const 32))) (br $scan)))
          (if (i32.eq (local.get $nxt) (i32.const 114))       ;; 'r'
            (then (local.set $o (call $fmsg_put (local.get $dst) (local.get $o) (local.get $max) (i32.const 13))) (br $scan)))
          (if (i32.eq (local.get $nxt) (i32.const 110))       ;; 'n'
            (then
              (local.set $o (call $fmsg_put (local.get $dst) (local.get $o) (local.get $max) (i32.const 13)))
              (local.set $o (call $fmsg_put (local.get $dst) (local.get $o) (local.get $max) (i32.const 10)))
              (br $scan)))
          (if (i32.or (i32.eq (local.get $nxt) (i32.const 37))     ;; '%'
                (i32.or (i32.eq (local.get $nxt) (i32.const 46))   ;; '.'
                        (i32.eq (local.get $nxt) (i32.const 33)))) ;; '!'
            (then (local.set $o (call $fmsg_put (local.get $dst) (local.get $o) (local.get $max) (local.get $nxt))) (br $scan)))
          (local.set $o (call $fmsg_put (local.get $dst) (local.get $o) (local.get $max) (i32.const 37)))
          (local.set $o (call $fmsg_put (local.get $dst) (local.get $o) (local.get $max) (local.get $nxt)))
          (br $scan)))
      ;; %N — read the index, which is one or two digits.
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $n (i32.const 0))
      (block $num_done (loop $num
        (local.set $ch (i32.load8_u (i32.add (local.get $src) (local.get $i))))
        (br_if $num_done (i32.or (i32.lt_u (local.get $ch) (i32.const 48))
                                 (i32.gt_u (local.get $ch) (i32.const 57))))
        (local.set $n (i32.add (i32.mul (local.get $n) (i32.const 10))
                               (i32.sub (local.get $ch) (i32.const 48))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $num)))
      ;; %0 ends the message.
      (br_if $done (i32.eqz (local.get $n)))
      (local.set $as_int (i32.const 0))
      (local.set $base (i32.const 10))
      ;; An optional !printf-spec! follows the number. Only its last letter
      ;; decides how the argument is read; width and flags are dropped, which
      ;; costs padding and never costs the value itself.
      (if (i32.eq (i32.load8_u (i32.add (local.get $src) (local.get $i))) (i32.const 33))
        (then
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (local.set $spec (i32.const 0))
          (block $spec_done (loop $spec_scan
            (local.set $ch (i32.load8_u (i32.add (local.get $src) (local.get $i))))
            (br_if $spec_done (i32.eqz (local.get $ch)))
            (if (i32.eq (local.get $ch) (i32.const 33))
              (then (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $spec_done)))
            (local.set $spec (local.get $ch))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $spec_scan)))
          (if (i32.or (i32.eq (local.get $spec) (i32.const 100))     ;; 'd'
                (i32.or (i32.eq (local.get $spec) (i32.const 105))   ;; 'i'
                        (i32.eq (local.get $spec) (i32.const 117)))) ;; 'u'
            (then (local.set $as_int (i32.const 1))))
          (if (i32.or (i32.eq (local.get $spec) (i32.const 120))     ;; 'x'
                      (i32.eq (local.get $spec) (i32.const 88)))     ;; 'X'
            (then (local.set $as_int (i32.const 1)) (local.set $base (i32.const 16))))))
      ;; With no Arguments there is nothing to substitute; leaving the insert
      ;; visible beats inventing a value.
      (if (i32.eqz (local.get $args_g))
        (then
          (local.set $o (call $fmsg_put (local.get $dst) (local.get $o) (local.get $max) (i32.const 37)))
          (local.set $o (call $fmsg_put_num (local.get $dst) (local.get $o) (local.get $max)
            (local.get $n) (i32.const 10) (i32.const 0)))
          (br $scan)))
      (local.set $argv (i32.load (call $g2w
        (i32.add (local.get $args_g) (i32.shl (i32.sub (local.get $n) (i32.const 1)) (i32.const 2))))))
      (if (local.get $as_int)
        (then
          (local.set $o (call $fmsg_put_num (local.get $dst) (local.get $o) (local.get $max)
            (local.get $argv) (local.get $base)
            (i32.eq (local.get $spec) (i32.const 100))))
          (br $scan)))
      (if (i32.eqz (local.get $argv)) (then (br $scan)))
      (local.set $p (call $g2w (local.get $argv)))
      (block $str_done (loop $str
        (local.set $ch (i32.load8_u (local.get $p)))
        (br_if $str_done (i32.eqz (local.get $ch)))
        (local.set $o (call $fmsg_put (local.get $dst) (local.get $o) (local.get $max) (local.get $ch)))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (br $str)))
      (br $scan)))
    (if (i32.ne (local.get $dst) (i32.const 0))
      (then
        (if (i32.and (i32.ne (local.get $max) (i32.const 0))
                     (i32.ge_u (local.get $o) (local.get $max)))
          (then (i32.store8 (i32.add (local.get $dst) (i32.sub (local.get $max) (i32.const 1))) (i32.const 0)))
          (else (i32.store8 (i32.add (local.get $dst) (local.get $o)) (i32.const 0))))))
    (local.get $o))

  ;; Find the message this call names and expand it, as ANSI, into $dst — $max
  ;; bytes, or a measuring pass that writes nothing when $dst is 0. Every
  ;; decision FormatMessage makes is here, so both spellings make it the same
  ;; way; all that differs between them is the encoding on either side.
  ;;
  ;; $fmt_wa is the FORMAT_MESSAGE_FROM_STRING template as a WASM address,
  ;; already ANSI — FormatMessageW narrows the caller's UTF-16 copy before it
  ;; gets here. $source is lpSource as passed, which for FROM_HMODULE names
  ;; the module whose RT_MESSAGETABLE holds the text. Returns the length not
  ;; counting the NUL, which is the true length even when the output was
  ;; truncated to $max.
  (func $format_message_ansi
      (param $flags i32) (param $fmt_wa i32) (param $source i32) (param $msg_id i32)
      (param $args_g i32) (param $dst i32) (param $max i32) (result i32)
    (local $len i32) (local $o i32)
    ;; FORMAT_MESSAGE_FROM_STRING: the caller supplied the template.
    ;; RegEdit uses this for resource strings before CreateWindowEx.
    (if (i32.and (local.get $flags) (i32.const 0x400))
      (then
        (return (call $format_message_expand
          (local.get $fmt_wa) (local.get $dst) (local.get $max) (local.get $args_g)))))
    ;; FORMAT_MESSAGE_FROM_HMODULE: the text lives in the module's
    ;; RT_MESSAGETABLE. winipcfg keeps every label and caption there and asks
    ;; for them one id at a time, so without this its whole UI reads "Error".
    ;; A message-table entry carries inserts too, so it goes through the same
    ;; expansion.
    (if (i32.and (local.get $flags) (i32.const 0x800))
      (then
        (call $push_rsrc_ctx (local.get $source))
        (local.set $len (call $message_table_lookup
          (local.get $msg_id) (global.get $TEXT_SCRATCH)))
        (call $pop_rsrc_ctx)
        (if (i32.ne (local.get $len) (i32.const -1))
          (then
            (return (call $format_message_expand
              (global.get $TEXT_SCRATCH) (local.get $dst) (local.get $max)
              (local.get $args_g)))))))
    ;; Nothing named a message we have: a generic one, written through the same
    ;; bounds-checked put as everything else so a measuring pass stays a
    ;; measuring pass.
    (local.set $o (call $fmsg_put (local.get $dst) (i32.const 0) (local.get $max) (i32.const 69)))   ;; 'E'
    (local.set $o (call $fmsg_put (local.get $dst) (local.get $o) (local.get $max) (i32.const 114))) ;; 'r'
    (local.set $o (call $fmsg_put (local.get $dst) (local.get $o) (local.get $max) (i32.const 114))) ;; 'r'
    (local.set $o (call $fmsg_put (local.get $dst) (local.get $o) (local.get $max) (i32.const 111))) ;; 'o'
    (local.set $o (call $fmsg_put (local.get $dst) (local.get $o) (local.get $max) (i32.const 114))) ;; 'r'
    (if (local.get $dst)
      (then
        (if (i32.and (i32.ne (local.get $max) (i32.const 0))
                     (i32.ge_u (local.get $o) (local.get $max)))
          (then (i32.store8 (i32.add (local.get $dst) (i32.sub (local.get $max) (i32.const 1))) (i32.const 0)))
          (else (i32.store8 (i32.add (local.get $dst) (local.get $o)) (i32.const 0))))))
    (local.get $o))

  ;; 754: FormatMessageA(dwFlags, lpSource, dwMessageId, dwLanguageId, lpBuffer, nSize, Arguments)
  (func $handle_FormatMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $buf_ga i32) (local $len i32) (local $nSize i32)
    (local $args_g i32) (local $fmt_wa i32)
    ;; dwFlags=arg0, lpSource=arg1, dwMessageId=arg2, dwLangId=arg3, lpBuffer=arg4
    (local.set $nSize (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    ;; Arguments is the 7th parameter. FORMAT_MESSAGE_IGNORE_INSERTS (0x200)
    ;; says to leave %1 and the escapes exactly as they are, and is expressed
    ;; here as "there are no arguments" — which is also what a caller that
    ;; passes none gets, insert text and all. RegEdit's "Cannot create key:
    ;; Error while opening the key %1." used to reach the user with the %1
    ;; still in it, because nothing ever looked at this pointer.
    (local.set $args_g (call $gl32 (i32.add (global.get $esp) (i32.const 28))))
    (if (i32.and (local.get $arg0) (i32.const 0x200))
      (then (local.set $args_g (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))  ;; stdcall, 7 args
    (if (i32.and (local.get $arg0) (i32.const 0x400))
      (then
        ;; FROM_STRING with no string is the one call with nothing to say.
        (if (i32.eqz (local.get $arg1))
          (then (global.set $eax (i32.const 0)) (return)))
        (local.set $fmt_wa (call $g2w (local.get $arg1)))))
    ;; Measured first, since ALLOCATE_BUFFER has to size the buffer before it
    ;; writes into it.
    (local.set $len (call $format_message_ansi (local.get $arg0) (local.get $fmt_wa)
      (local.get $arg1) (local.get $arg2) (local.get $args_g) (i32.const 0) (i32.const 0)))
    (if (i32.and (local.get $arg0) (i32.const 0x100))
      (then
        (local.set $buf_ga (call $heap_alloc (i32.add (local.get $len) (i32.const 1))))
        (i32.store (call $g2w (local.get $arg4)) (local.get $buf_ga))
        (local.set $wa (call $g2w (local.get $buf_ga)))
        (local.set $nSize (i32.add (local.get $len) (i32.const 1))))
      (else
        (local.set $wa (call $g2w (local.get $arg4)))))
    (drop (call $format_message_ansi (local.get $arg0) (local.get $fmt_wa)
      (local.get $arg1) (local.get $arg2) (local.get $args_g)
      (local.get $wa) (local.get $nSize)))
    (global.set $eax (local.get $len))
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

  ;; 756: GetShellWindow() — USER's process-wide registered shell owner.
  (func $handle_GetShellWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $shell_hwnd))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; SetShellWindow(hwndShell) is the Win9x USER32 registration used by the
  ;; stock desktop browser after it creates Program Manager and its shell-view
  ;; children. USER permits the first registration (and an idempotent repeat),
  ;; but does not let an unrelated window silently replace the active shell.
  (func $handle_SetShellWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.or (i32.eqz (global.get $shell_hwnd))
                (i32.eq (global.get $shell_hwnd) (local.get $arg0)))
      (then
        (global.set $shell_hwnd (local.get $arg0))
        (global.set $eax (i32.const 1)))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; PaintDesktop(hdc) is USER's desktop-background painter. The stock Win98
  ;; shell calls it from Program Manager's WM_PAINT handler after registering
  ;; itself with SetShellWindow. A system-color brush is encoded as index+1;
  ;; COLOR_DESKTOP/COLOR_BACKGROUND is index 1, hence brush handle 2.
  (func $handle_PaintDesktop (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $screen i32)
    (local.set $screen (call $host_get_screen_size))
    (global.set $eax (call $host_gdi_fill_rect
      (local.get $arg0)
      (i32.const 0) (i32.const 0)
      (i32.and (local.get $screen) (i32.const 0xFFFF))
      (i32.shr_u (local.get $screen) (i32.const 16))
      (i32.const 2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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

  ;; SHGetDesktopFolder(ppshf) — installer-scoped desktop namespace shim.
  ;; It exposes an empty IShellFolder/IEnumIDList so path-edit controls remain
  ;; usable without pretending to implement Explorer's PIDL namespace.
  (func $handle_SHGetDesktopFolder (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $vtbl i32) (local $obj i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const 0x80004003)) ;; E_POINTER
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (local.set $vtbl (call $init_com_vtable (i32.const 2482) (i32.const 13)))
    (local.set $obj (call $dx_create_com_obj (i32.const 32) (local.get $vtbl)))
    (call $gs32 (local.get $arg0) (local.get $obj))
    (global.set $eax (select (i32.const 0) (i32.const 0x8007000E) (i32.ne (local.get $obj) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; SHChangeNotify(wEventId, uFlags, dwItem1, dwItem2) broadcasts a shell
  ;; namespace change and returns no value. WineAssembly has no Explorer
  ;; process or registered shell notification sinks in an app instance, so
  ;; delivery has no observers. SHCNF_FLUSH is therefore already satisfied
  ;; when this handler returns. In particular, SHCNE_MKDIR is only a notice:
  ;; the caller remains responsible for creating the directory itself.
  (func $handle_SHChangeNotify (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  (func $handle_IShellFolder_QueryInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg2) (then (call $gs32 (local.get $arg2) (local.get $arg0))))
    (global.set $eax (select (i32.const 0) (i32.const 0x80004003) (i32.ne (local.get $arg2) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))
  (func $handle_IShellFolder_AddRef (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 2))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))
  (func $handle_IShellFolder_Release (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))
  (func $handle_IShellFolder_ParseDisplayName (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x80004001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32))))
  (func $handle_IShellFolder_EnumObjects (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $vtbl i32) (local $obj i32)
    (if (i32.eqz (local.get $arg3))
      (then
        (global.set $eax (i32.const 0x80004003))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    (local.set $vtbl (call $init_com_vtable (i32.const 2495) (i32.const 7)))
    (local.set $obj (call $dx_create_com_obj (i32.const 33) (local.get $vtbl)))
    (call $gs32 (local.get $arg3) (local.get $obj))
    (global.set $eax (select (i32.const 0) (i32.const 0x8007000E) (i32.ne (local.get $obj) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))
  (func $handle_IShellFolder_BindToObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg4) (then (call $gs32 (local.get $arg4) (i32.const 0))))
    (global.set $eax (i32.const 0x80004001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))
  (func $handle_IShellFolder_BindToStorage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg4) (then (call $gs32 (local.get $arg4) (i32.const 0))))
    (global.set $eax (i32.const 0x80004001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))
  (func $handle_IShellFolder_CompareIDs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))
  (func $handle_IShellFolder_CreateViewObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg3) (then (call $gs32 (local.get $arg3) (i32.const 0))))
    (global.set $eax (i32.const 0x80004001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))
  (func $handle_IShellFolder_GetAttributesOf (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg3) (then (call $gs32 (local.get $arg3) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))
  (func $handle_IShellFolder_GetUIObjectOf (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x80004001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32))))
  (func $handle_IShellFolder_GetDisplayNameOf (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x80004001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))
  (func $handle_IShellFolder_SetNameOf (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x80004001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  (func $handle_IEnumIDList_QueryInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg2) (then (call $gs32 (local.get $arg2) (local.get $arg0))))
    (global.set $eax (select (i32.const 0) (i32.const 0x80004003) (i32.ne (local.get $arg2) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))
  (func $handle_IEnumIDList_AddRef (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 2))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))
  (func $handle_IEnumIDList_Release (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))
  (func $handle_IEnumIDList_Next (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg2) (then (call $gs32 (local.get $arg2) (i32.const 0))))
    (if (local.get $arg3) (then (call $gs32 (local.get $arg3) (i32.const 0))))
    (global.set $eax (i32.const 1)) ;; S_FALSE: empty namespace
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))
  (func $handle_IEnumIDList_Skip (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))
  (func $handle_IEnumIDList_Reset (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))
  (func $handle_IEnumIDList_Clone (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1) (then (call $gs32 (local.get $arg1) (i32.const 0))))
    (global.set $eax (i32.const 0x80004001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

;; 762: GetWindowLongA(hWnd, nIndex)
  (func $handle_GetWindowLongA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eq (local.get $arg1) (i32.const -12))  ;; GWL_ID
      (then
        (global.set $eax (call $ctrl_table_get_id (local.get $arg0)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
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
        (global.set $eax (call $wnd_get_hinstance (local.get $arg0)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    ;; GWL_HWNDPARENT: the parent for a child, the owner for a top-level. VCL's
    ;; TWinControl.UpdateBounds asks for this and only calls ScreenToClient when
    ;; it comes back non-zero -- returning 0 made it store the screen rect as the
    ;; control's parent-relative bounds, so every SetBounds round trip shifted
    ;; the control by the parent's client origin again (Tetravex's tiles walked
    ;; off the form: 0 -> 124 -> 248 -> ...).
    (if (i32.eq (local.get $arg1) (i32.const -8))   ;; GWL_HWNDPARENT
      (then
        (global.set $eax (call $wnd_get_parent (local.get $arg0)))
        (if (i32.eqz (global.get $eax))
          (then (global.set $eax (call $wnd_get_owner (local.get $arg0)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (if (i32.eq (local.get $arg1) (i32.const -16))  ;; GWL_STYLE
      (then
        (global.set $eax
          (if (result i32) (i32.ge_s (call $wnd_table_find (local.get $arg0)) (i32.const 0))
            (then (call $wnd_get_style (local.get $arg0)))
            (else (call $host_get_window_info (local.get $arg0) (i32.const 0)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    ;; GWL_EXSTYLE: CreateWindowExA and $dlg_load both record dwExStyle per
    ;; window, so answer from that rather than reporting 0 for every window.
    ;; Apps read this to decide whether they already own a style bit before
    ;; OR-ing another one in; a hardcoded 0 makes every such read-modify-write
    ;; drop the bits the window was created with.
    (if (i32.eq (local.get $arg1) (i32.const -20))  ;; GWL_EXSTYLE
      (then
        (global.set $eax (call $ctrl_get_ex_style (local.get $arg0)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (if (i32.ge_s (local.get $arg1) (i32.const 0))
      (then
        (if (call $dialog_proc_get (local.get $arg0))
          (then
            (global.set $eax (call $dialog_extra_get
              (local.get $arg0) (local.get $arg1))))
          (else
            (global.set $eax (call $wnd_extra_get
              (local.get $arg0) (local.get $arg1)))))
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

  ;; 769: GetVersionExW(lpVersionInfo) — the same OSVERSIONINFO the A spelling
  ;; fills, read from $winver rather than hardcoded to Windows 98.
  (func $handle_GetVersionExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $version_info (local.get $arg0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; Park a COM activation at its import thunk while JS loads an in-proc
  ;; server. Keeping the stdcall frame untouched lets the normal handler retry
  ;; once the DLL exists, without re-executing the guest PUSH/CALL block and
  ;; walking ESP downward inside the same run slice.
  (func $com_dll_block
    (if (global.get $current_thunk_eip)
      (then (global.set $eip (global.get $current_thunk_eip))))
    (global.set $handler_set_eip (i32.const 1))
    (global.set $yield_reason (i32.const 3))
    (global.set $yield_flag (i32.const 1))
    (global.set $steps (i32.const 0)))

  ;; Built-in class factory for the standard VB6 Common Dialog control. The
  ;; actual COMDLG32.OCX is not shipped in the corpus; its non-visual OLE host
  ;; surface can use the bounded static OLE object already used by OleLoad.
  ;; Factory layout: vtbl, refcount, CLSID[16].
  (func $common_dialog_factory_create (param $clsid i32) (result i32)
    (local $obj i32) (local $vtbl i32)
    (local.set $vtbl (call $init_com_vtable (i32.const 2512) (i32.const 5)))
    (if (i32.eqz (local.get $vtbl)) (then (return (i32.const 0))))
    (local.set $obj (call $heap_alloc (i32.const 24)))
    (if (i32.eqz (local.get $obj)) (then (return (i32.const 0))))
    (call $zero_memory (call $g2w (local.get $obj)) (i32.const 24))
    (call $gs32 (local.get $obj) (local.get $vtbl))
    (call $gs32 (i32.add (local.get $obj) (i32.const 4)) (i32.const 1))
    (memory.copy (call $g2w (i32.add (local.get $obj) (i32.const 8)))
      (call $g2w (local.get $clsid)) (i32.const 16))
    (local.get $obj))

  (func $handle_IClassFactory_QueryInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $iid_d1 i32)
    (if (i32.eqz (local.get $arg2))
      (then (global.set $eax (i32.const 0x80004003)))
      (else
        (local.set $iid_d1 (call $gl32 (local.get $arg1)))
        (if (i32.or (i32.eqz (local.get $iid_d1)) (i32.eq (local.get $iid_d1) (i32.const 1)))
          (then
            (call $gs32 (local.get $arg2) (local.get $arg0))
            (call $gs32 (i32.add (local.get $arg0) (i32.const 4))
              (i32.add (call $gl32 (i32.add (local.get $arg0) (i32.const 4))) (i32.const 1)))
            (global.set $eax (i32.const 0)))
          (else
            (call $gs32 (local.get $arg2) (i32.const 0))
            (global.set $eax (i32.const 0x80004002))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IClassFactory_AddRef (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.add (call $gl32 (i32.add (local.get $arg0) (i32.const 4))) (i32.const 1)))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (global.get $eax))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IClassFactory_Release (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $rc i32)
    (local.set $rc (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (if (local.get $rc) (then (local.set $rc (i32.sub (local.get $rc) (i32.const 1)))))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (local.get $rc))
    (global.set $eax (local.get $rc))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IClassFactory_CreateInstance (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $obj i32) (local $hr i32)
    (if (i32.eqz (local.get $arg3))
      (then (global.set $eax (i32.const 0x80004003)))
      (else
        (call $gs32 (local.get $arg3) (i32.const 0))
        (if (local.get $arg1)
          (then (global.set $eax (i32.const 0x80040110)))
          (else
            (local.set $obj (call $ole_create_static_handler (i32.add (local.get $arg0) (i32.const 8))))
            (if (i32.eqz (local.get $obj))
              (then (global.set $eax (i32.const 0x8007000E)))
              (else
                (local.set $hr (call $ole_static_query_interface
                  (local.get $obj) (local.get $arg2) (local.get $arg3)))
                (drop (call $ole_obj_release (local.get $obj)))
                (global.set $eax (local.get $hr))))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  (func $handle_IClassFactory_LockServer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; IDirectMusic root object. GTA2 and its InstallShield DxCheck helper only
  ;; use this interface as an availability/version probe: create it, accept
  ;; IUnknown/IDirectMusic QueryInterface, then release it.
  (func $handle_IDirectMusic_QueryInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (if (local.get $arg2) (then (call $gs32 (local.get $arg2) (local.get $arg0))))
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (if (local.get $entry)
      (then (i32.store (i32.add (local.get $entry) (i32.const 4))
              (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirectMusic_AddRef (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $rc i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $rc (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (i32.store (i32.add (local.get $entry) (i32.const 4)) (local.get $rc))
    (global.set $eax (local.get $rc))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IDirectMusic_Release (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $rc i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $rc (i32.sub (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (if (i32.le_s (local.get $rc) (i32.const 0))
      (then (call $dx_free (local.get $entry)) (global.set $eax (i32.const 0)))
      (else (i32.store (i32.add (local.get $entry) (i32.const 4)) (local.get $rc)) (global.set $eax (local.get $rc))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; IDirectDrawGammaControl is a view onto an existing surface slot. GTA2
  ;; snapshots the current ramp and installs its own during video startup.
  (func $handle_IDirectDrawGammaControl_QueryInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_IDirectMusic_QueryInterface
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr)))

  (func $handle_IDirectDrawGammaControl_AddRef (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_IDirectMusic_AddRef
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr)))

  (func $handle_IDirectDrawGammaControl_Release (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_IDirectMusic_Release
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr)))

  (func $handle_IDirectDrawGammaControl_GetGammaRamp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ramp i32) (local $i i32) (local $value i32)
    (if (i32.eqz (local.get $arg2))
      (then (global.set $eax (i32.const 0x80070057)))
      (else
        (local.set $ramp (call $g2w (local.get $arg2)))
        (local.set $i (i32.const 0))
        (block $done (loop $fill
          (br_if $done (i32.ge_u (local.get $i) (i32.const 256)))
          (local.set $value (i32.mul (local.get $i) (i32.const 257)))
          (i32.store16 (i32.add (local.get $ramp) (i32.shl (local.get $i) (i32.const 1))) (local.get $value))
          (i32.store16 (i32.add (i32.add (local.get $ramp) (i32.const 512)) (i32.shl (local.get $i) (i32.const 1))) (local.get $value))
          (i32.store16 (i32.add (i32.add (local.get $ramp) (i32.const 1024)) (i32.shl (local.get $i) (i32.const 1))) (local.get $value))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $fill)))
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirectDrawGammaControl_SetGammaRamp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (select (i32.const 0) (i32.const 0x80070057)
      (i32.ne (local.get $arg2) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 769: CoCreateInstance(rclsid, pUnkOuter, dwClsContext, riid, ppv) — 5 args stdcall
  (func $handle_CoCreateInstance (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hr i32) (local $clsid_d1 i32) (local $obj_guest i32)
    ;; Short-circuit CLSID_DirectDrawFactory {4FD2A832-86C8-11D0-8FCA-00C04FD9189D}
    ;; from ddrawex.dll. Used by CORBIS/FASHION/HORROR/WOTRAVEL screensavers; we
    ;; manufacture an IDirectDrawFactory directly so the guest never needs the DLL.
    (local.set $clsid_d1 (call $gl32 (local.get $arg0)))
    ;; CLSID_DirectX7 {E1211353-8E94-11D1-8808-00C04FC2C602}, the VB6
    ;; DX7VB automation bootstrap. Its first direct method manufactures the
    ;; existing IDirectDraw7-compatible wrapper.
    (if (i32.eq (local.get $clsid_d1) (i32.const 0xE1211353))
      (then
        (local.set $obj_guest (call $dx_create_com_obj
          (i32.const 32) (call $init_com_vtable (i32.const 2526) (i32.const 7))))
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
    ;; CLSID_DirectPlay {D1EB6D20-8923-11D0-9D97-00A0C90A43CB}. Bellhop
    ;; asks for IID_IDirectPlay3A and treats E_NOINTERFACE as fatal even
    ;; though it only needs local/no-network DirectPlay setup.
    (if (i32.eq (local.get $clsid_d1) (i32.const 0xD1EB6D20))
      (then
        (local.set $obj_guest (call $dx_create_com_obj (i32.const 26) (global.get $DX_VTBL_DPLAY3)))
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
    ;; CLSID_DirectMusic {636B9F10-0C7D-11D1-95B2-0020AFDC7421}.
    ;; The first three append-only API IDs form the minimal IUnknown vtable.
    (if (i32.eq (local.get $clsid_d1) (i32.const 0x636B9F10))
      (then
        (local.set $obj_guest (call $dx_create_com_obj
          (i32.const 35) (call $init_com_vtable (i32.const 3076) (i32.const 3))))
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
    ;; CLSID_DirectPlayLobby {2FE8F810-B2A5-11D0-A787-0000F803ABFC}.
    ;; Bellhop requests IID_IDirectPlayLobby2A and aborts startup if the
    ;; lobby object cannot be created.
    (if (i32.eq (local.get $clsid_d1) (i32.const 0x2FE8F810))
      (then
        (local.set $obj_guest (call $dx_create_com_obj (i32.const 27) (global.get $DX_VTBL_DPLAYLOBBY2)))
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
    ;; Minimal DirectAnimation Automation placeholders for the Plus!98 MFC
    ;; screensavers. CLSIDFromProgID below writes private sentinel CLSIDs for
    ;; DAView/DAStatics; these objects expose IDispatch enough for tracing and
    ;; graceful fallback without loading danim.dll.
    (if (i32.eq (local.get $clsid_d1) (i32.const 0xDA51DA01))
      (then
        (local.set $obj_guest (call $dx_create_com_obj (i32.const 28) (global.get $DX_VTBL_DA_VIEW)))
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
    (if (i32.eq (local.get $clsid_d1) (i32.const 0xDA57A71C))
      (then
        (local.set $obj_guest (call $dx_create_com_obj (i32.const 29) (global.get $DX_VTBL_DA_STATICS)))
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
        (call $com_dll_block)
        (return)))
    ;; Synchronous success or error — zero *ppv on failure per COM spec
    (if (local.get $hr)
      (then (call $gs32 (local.get $arg4) (i32.const 0))))
    (global.set $eax (local.get $hr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; stdcall, 5 args
  )

  ;; CoGetClassObject(rclsid, dwClsContext, pvReserved, riid, ppv) — 5 args.
  ;; The host COM bridge already performs registry lookup, async in-proc DLL
  ;; loading and DllGetClassObject reentry. Its private high CLSCTX bit asks it
  ;; to return the requested class-factory interface directly.
  (func $handle_CoGetClassObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hr i32) (local $host_ctx i32) (local $factory i32)
    ;; CLSID_CommonDialog {F9043C85-F6F2-101A-A3C9-08002B2F49FB}.
    (if (i32.eq (call $gl32 (local.get $arg0)) (i32.const 0xF9043C85))
      (then
        (if (i32.eqz (local.get $arg4))
          (then (global.set $eax (i32.const 0x80004003)))
          (else
            (local.set $factory (call $common_dialog_factory_create (local.get $arg0)))
            (call $gs32 (local.get $arg4) (local.get $factory))
            (global.set $eax
              (select (i32.const 0) (i32.const 0x8007000E)
                (i32.ne (local.get $factory) (i32.const 0))))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    (local.set $host_ctx (i32.or (local.get $arg1) (i32.const 0x80000000)))
    (local.set $hr (call $host_com_create_instance
      (call $g2w (local.get $arg0))
      (local.get $arg2)
      (local.get $host_ctx)
      (call $g2w (local.get $arg3))
      (local.get $arg4)))
    (if (i32.eq (local.get $hr) (i32.const 0x800401F0))
      (then
        (global.set $com_clsid_ptr (local.get $arg0))
        (global.set $com_iid_ptr (local.get $arg3))
        (global.set $com_ppv_ptr (local.get $arg4))
        (global.set $com_unk_outer (local.get $arg2))
        (global.set $com_cls_ctx (local.get $host_ctx))
        (global.set $com_dll_name (call $host_com_get_pending_dll))
        (call $com_dll_block)
        (return)))
    (if (local.get $hr)
      (then (call $gs32 (local.get $arg4) (i32.const 0))))
    (global.set $eax (local.get $hr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
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

  ;; VariantInit(pvarg) — mark the VARIANT as VT_EMPTY. Unlike VariantClear
  ;; this must NOT release anything: the struct is assumed to hold garbage.
  ;; Zeroing all 16 bytes both sets VT_EMPTY and leaves the union clean.
  (func $handle_VariantInit (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg0)
      (then (call $zero_memory (call $g2w (local.get $arg0)) (i32.const 16))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; VariantCopy(pvargDest, pvargSrc) → HRESULT. Release the destination, then
  ;; take a copy of the source. A BSTR has to be duplicated rather than
  ;; aliased, since both variants are independently owned and either may be
  ;; cleared first; every other type in a VARIANT is inline.
  (func $handle_VariantCopy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $vt i32) (local $src_bstr i32) (local $len i32) (local $copy i32)
    (if (i32.or (i32.eqz (local.get $arg0)) (i32.eqz (local.get $arg1)))
      (then
        (global.set $eax (i32.const 0x80070057))  ;; E_INVALIDARG
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (call $zero_memory (call $g2w (local.get $arg0)) (i32.const 16))
    (memory.copy (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (i32.const 16))
    (local.set $vt (call $gl16 (local.get $arg1)))
    (if (i32.eq (local.get $vt) (i32.const 8))    ;; VT_BSTR
      (then
        (local.set $src_bstr (call $gl32 (i32.add (local.get $arg1) (i32.const 8))))
        (if (local.get $src_bstr)
          (then
            ;; A BSTR stores its byte length in the dword before the data.
            (local.set $len (call $gl32 (i32.sub (local.get $src_bstr) (i32.const 4))))
            (local.set $copy (call $heap_alloc (i32.add (local.get $len) (i32.const 6))))
            (if (local.get $copy)
              (then
                (local.set $copy (i32.add (local.get $copy) (i32.const 4)))
                (call $gs32 (i32.sub (local.get $copy) (i32.const 4)) (local.get $len))
                (memory.copy (call $g2w (local.get $copy)) (call $g2w (local.get $src_bstr))
                  (i32.add (local.get $len) (i32.const 2)))))
            (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (local.get $copy))))))
    (global.set $eax (i32.const 0))  ;; S_OK
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
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
  ;; Wide ProgID string → CLSID. We only recognise the DirectAnimation ProgIDs
  ;; used by the Plus!98 MFC screensavers and return private sentinel CLSIDs
  ;; that $handle_CoCreateInstance consumes above. Everything else remains
  ;; class-not-registered.
  (func $handle_CLSIDFromProgID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $src i32) (local $dst i32)
    (if (i32.or (i32.eqz (local.get $arg0)) (i32.eqz (local.get $arg1)))
      (then
        (global.set $eax (i32.const 0x80004003))  ;; E_POINTER
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (local.set $src (call $g2w (local.get $arg0)))
    (local.set $dst (call $g2w (local.get $arg1)))
    (if (call $wide_ascii_eq (local.get $src) (i32.const 0x3180))
      (then
        (i32.store (local.get $dst) (i32.const 0xDA51DA01))
        (i64.store (i32.add (local.get $dst) (i32.const 4)) (i64.const 0))
        (i32.store (i32.add (local.get $dst) (i32.const 12)) (i32.const 0))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (if (call $wide_ascii_eq (local.get $src) (i32.const 0x31A0))
      (then
        (i32.store (local.get $dst) (i32.const 0xDA57A71C))
        (i64.store (i32.add (local.get $dst) (i32.const 4)) (i64.const 0))
        (i32.store (i32.add (local.get $dst) (i32.const 12)) (i32.const 0))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
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
    (local $section i32)
    ;; lpName is the sixth argument, past the five in registers.
    (local.set $section (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (global.set $eax (call $host_fs_create_file_mapping
      (local.get $arg0) (local.get $arg2) (local.get $arg3) (local.get $arg4)
      (if (result i32) (local.get $section)
        (then (call $g2w (local.get $section))) (else (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; 6 args
  )

  ;; OpenFileMappingA/W(dwDesiredAccess, bInheritHandle, lpName) — 3 args.
  ;; Returns 0 when nothing created that section, which is the honest answer
  ;; for a name another process would have published: Kodak Imaging opens
  ;; "EastManSoftwarePrvFile" purely to find out whether its Preview
  ;; counterpart is already live, and copes fine with being told it is not.
  (func $handle_OpenFileMappingA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (if (result i32) (local.get $arg2)
        (then (call $host_fs_open_file_mapping (call $g2w (local.get $arg2))))
        (else (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; The section namespace is shared between the A and W entry points, so
  ;; narrow the name and look it up in the same table. $atom_narrow_w is the
  ;; generic UTF-16-to-ANSI copy helper; it happens to live with the atoms.
  (func $handle_OpenFileMappingW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $narrow i32)
    (local.set $narrow (call $atom_narrow_w (local.get $arg2)))
    (global.set $eax
      (if (result i32) (local.get $narrow)
        (then (call $host_fs_open_file_mapping (call $g2w (local.get $narrow))))
        (else (i32.const 0))))
    (call $atom_narrow_free (local.get $arg2) (local.get $narrow))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 778: MapViewOfFile(hMapping, dwAccess, dwOffsetHi, dwOffsetLo, dwSize) — 5 args
  (func $handle_MapViewOfFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_fs_map_view_of_file
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; 5 args
  )

  ;; MapViewOfFileEx has the same mapping semantics plus a sixth preferred
  ;; base-address argument. NULL explicitly lets Windows choose the address,
  ;; which is the path used by stock Win98 OLE32. A fixed placement cannot be
  ;; represented by the current mapping allocator, so fail it honestly rather
  ;; than returning a view at a different address.
  (func $handle_MapViewOfFileEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $base i32)
    (local.set $base (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (global.set $eax
      (if (result i32) (local.get $base)
        (then (i32.const 0))
        (else (call $host_fs_map_view_of_file
          (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; 6 args
  )

  ;; 779: UnmapViewOfFile(lpBaseAddress) — 1 arg
  (func $handle_UnmapViewOfFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_fs_unmap_view (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; 1 arg
  )

  ;; FlushViewOfFile(lpBaseAddress, dwNumberOfBytesToFlush) — 2 args. Writes
  ;; the view's bytes back to whatever backs the section while the view stays
  ;; mapped. Kodak Imaging calls it right after MapViewOfFile on its thumbnail
  ;; cache and dies on the spot if the call is missing.
  (func $handle_FlushViewOfFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_fs_flush_view (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; 2 args
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

  ;; 1503: VkKeyScanW(WCHAR ch) → SHORT — low byte = vkey, high byte = shift state.
  ;; ASCII letters/digits map cleanly; uppercase letters set the SHIFT bit (0x100).
  ;; Anything else returns -1 (0xFFFF), the documented "no translation" sentinel.
  (func $handle_VkKeyScanW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $vk_key_scan (i32.and (local.get $arg0) (i32.const 0xFFFF))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))  ;; stdcall, 1 arg

  ;; VK->scancode lookup table for letters A..Z (vk 0x41..0x5A → table[vk-0x41]).
  ;; Real PS/2 set-1 scancodes; the previous (uCode-0x20) approximation produced
  ;; bogus values (e.g. Z=0x3A) that GetKeyNameTextA couldn't decode, so the
  ;; Pinball Player Controls dialog rendered "?" for the default flipper keys.
  (data (i32.const 0x380)
    "\1e\30\2e\20\12\21\22\23\17\24\25\26\32\31\18\19\10\13\1f\14\16\2f\11\2d\15\2c")

  ;; Reverse table: PS/2 set-1 scancode → VK (uMapType=1). Indexed by scancode
  ;; 0x00..0x58 (89 bytes). Pinball's Player Controls dialog walks scan 0..0xFF
  ;; calling MapVirtualKey(scan,1) to populate its key-binding combobox; without
  ;; this table every entry collapses to vk=0. Numpad scancodes (0x47..0x53)
  ;; map to VK_NUMPAD*/_DECIMAL/_ADD/_SUBTRACT/_MULTIPLY/_DIVIDE — the arrow
  ;; vkeys come from extended (0xE0-prefixed) scancodes, not the base table.
  (data (i32.const 0x3A0)
    "\00\1b\31\32\33\34\35\36\37\38"   ;; 0x00..0x09
    "\39\30\bd\bb\08\09\51\57\45\52"   ;; 0x0a..0x13
    "\54\59\55\49\4f\50\db\dd\0d\11"   ;; 0x14..0x1d
    "\41\53\44\46\47\48\4a\4b\4c\ba"   ;; 0x1e..0x27
    "\de\c0\10\dc\5a\58\43\56\42\4e"   ;; 0x28..0x31
    "\4d\bc\be\bf\10\6a\12\20\14\70"   ;; 0x32..0x3b
    "\71\72\73\74\75\76\77\78\79\90"   ;; 0x3c..0x45
    "\91\67\26\69\6d\25\65\27\6b\61"   ;; 0x46..0x4f (4B/4D/48 favor arrow VKs)
    "\28\63\60\6e\00\00\00\7a\7b")     ;; 0x50..0x58 (50 favors VK_DOWN over NP2)

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
            ;; Letters A-Z: vkeys 0x41-0x5A -> real PS/2 set-1 scancodes via table
            (if (i32.and (i32.ge_u (local.get $uCode) (i32.const 0x41)) (i32.le_u (local.get $uCode) (i32.const 0x5A)))
              (then
                (local.set $result (i32.load8_u (i32.add (i32.const 0x380) (i32.sub (local.get $uCode) (i32.const 0x41)))))
                (br $vk0_done)
              )
            )
            ;; OEM punctuation
            (if (i32.eq (local.get $uCode) (i32.const 0xBA)) (then (local.set $result (i32.const 0x27)) (br $vk0_done))) ;; ;:
            (if (i32.eq (local.get $uCode) (i32.const 0xBB)) (then (local.set $result (i32.const 0x0D)) (br $vk0_done))) ;; =+
            (if (i32.eq (local.get $uCode) (i32.const 0xBC)) (then (local.set $result (i32.const 0x33)) (br $vk0_done))) ;; ,<
            (if (i32.eq (local.get $uCode) (i32.const 0xBD)) (then (local.set $result (i32.const 0x0C)) (br $vk0_done))) ;; -_
            (if (i32.eq (local.get $uCode) (i32.const 0xBE)) (then (local.set $result (i32.const 0x34)) (br $vk0_done))) ;; .>
            (if (i32.eq (local.get $uCode) (i32.const 0xBF)) (then (local.set $result (i32.const 0x35)) (br $vk0_done))) ;; /?
            (if (i32.eq (local.get $uCode) (i32.const 0xC0)) (then (local.set $result (i32.const 0x29)) (br $vk0_done))) ;; `~
            (if (i32.eq (local.get $uCode) (i32.const 0xDB)) (then (local.set $result (i32.const 0x1A)) (br $vk0_done))) ;; [{
            (if (i32.eq (local.get $uCode) (i32.const 0xDC)) (then (local.set $result (i32.const 0x2B)) (br $vk0_done))) ;; \|
            (if (i32.eq (local.get $uCode) (i32.const 0xDD)) (then (local.set $result (i32.const 0x1B)) (br $vk0_done))) ;; ]}
            (if (i32.eq (local.get $uCode) (i32.const 0xDE)) (then (local.set $result (i32.const 0x28)) (br $vk0_done))) ;; '"
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
      ;; Type 1: scan code -> vkey (reverse table at 0x3A0, scan 0x00..0x58).
      ;; Pinball walks scan 0..0xFF at dialog init and pairs each with
      ;; GetKeyNameTextA to build the Player Controls combobox.
      (if (i32.eq (local.get $uMapType) (i32.const 1))
        (then
          (if (i32.le_u (local.get $uCode) (i32.const 0x58))
            (then (local.set $result (i32.load8_u (i32.add (i32.const 0x3A0) (local.get $uCode))))))
          (br $done)
        )
      )
      ;; Type 2: vkey -> unshifted char.
      ;; Pinball's combobox-populator at 0x1005c2d walks vk 0x80..0xFF asking
      ;; MapVirtualKey(vk,2) to find the OEM vkey that produces a target glyph
      ;; (e.g. '/' for the right flipper). Without OEM coverage here every
      ;; punctuation slot in the dialog would silently skip.
      (if (i32.eq (local.get $uMapType) (i32.const 2))
        (then
          ;; Letters: return uppercase ASCII (real Windows returns uppercase
          ;; for type 2; Pinball's compare uses the low byte either way).
          (if (i32.and (i32.ge_u (local.get $uCode) (i32.const 0x41)) (i32.le_u (local.get $uCode) (i32.const 0x5A)))
            (then (local.set $result (local.get $uCode)))
          )
          ;; Numbers: return ASCII digit
          (if (i32.and (i32.ge_u (local.get $uCode) (i32.const 0x30)) (i32.le_u (local.get $uCode) (i32.const 0x39)))
            (then (local.set $result (local.get $uCode)))
          )
          (if (i32.eq (local.get $uCode) (i32.const 0x20)) (then (local.set $result (i32.const 0x20))))
          ;; OEM punctuation (US layout, unshifted glyph)
          (if (i32.eq (local.get $uCode) (i32.const 0xBA)) (then (local.set $result (i32.const 0x3B)))) ;; ;
          (if (i32.eq (local.get $uCode) (i32.const 0xBB)) (then (local.set $result (i32.const 0x3D)))) ;; =
          (if (i32.eq (local.get $uCode) (i32.const 0xBC)) (then (local.set $result (i32.const 0x2C)))) ;; ,
          (if (i32.eq (local.get $uCode) (i32.const 0xBD)) (then (local.set $result (i32.const 0x2D)))) ;; -
          (if (i32.eq (local.get $uCode) (i32.const 0xBE)) (then (local.set $result (i32.const 0x2E)))) ;; .
          (if (i32.eq (local.get $uCode) (i32.const 0xBF)) (then (local.set $result (i32.const 0x2F)))) ;; /
          (if (i32.eq (local.get $uCode) (i32.const 0xC0)) (then (local.set $result (i32.const 0x60)))) ;; `
          (if (i32.eq (local.get $uCode) (i32.const 0xDB)) (then (local.set $result (i32.const 0x5B)))) ;; [
          (if (i32.eq (local.get $uCode) (i32.const 0xDC)) (then (local.set $result (i32.const 0x5C)))) ;; \
          (if (i32.eq (local.get $uCode) (i32.const 0xDD)) (then (local.set $result (i32.const 0x5D)))) ;; ]
          (if (i32.eq (local.get $uCode) (i32.const 0xDE)) (then (local.set $result (i32.const 0x27)))) ;; '
          (br $done)
        )
      )
      ;; Type 3: scan code -> vkey (with left/right) — return 0
    )
    (global.set $eax (local.get $result))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; MapVirtualKeyW(uCode, uMapType) → UINT — same semantics as MapVirtualKeyA
  ;; for the codepoints we care about, since both ASCII letters/digits and the
  ;; vkey/scancode tables fit in the BMP. Delegate to keep one implementation.
  (func $handle_MapVirtualKeyW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_MapVirtualKeyA (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr)))

  ;; MapVirtualKeyExA(uCode, uMapType, dwhkl) → UINT — ignore the locale handle
  ;; and delegate. MapVirtualKeyA pops 12 bytes (ret+2 args); we need 16 (ret+3),
  ;; so add the extra 4 after.
  (func $handle_MapVirtualKeyExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_MapVirtualKeyA (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  ;; 786: DisableThreadLibraryCalls(hModule) — no-op, return TRUE
  (func $handle_DisableThreadLibraryCalls (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 787: ReinitializeCriticalSection(ptr) — no-op. Deliberately still a no-op
  ;; now that sections really exclude: resetting the lock word here would release
  ;; a section its owner is inside, and nothing has been seen to need it.
  (func $handle_ReinitializeCriticalSection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; ============================================================
  ;; ATOM TABLES (AddAtom* / GlobalAddAtom* / FindAtom* / DeleteAtom / *GetAtomName*)
  ;; ============================================================
  ;; Atoms are a string-interning service: adding the same name twice must
  ;; return the *same* atom with a bumped reference count, and FindAtom must
  ;; return it. Apps use that identity, not just the number — Delphi's VCL
  ;; (Tetravex, Runenlegen) registers a per-window-class atom at startup and
  ;; calls GlobalFindAtomA on every window activation to recover it.

  ;; An integer atom is a MAKEINTATOM value: the "string" pointer is really a
  ;; 16-bit number, i.e. HIWORD(lpString) == 0. It is its own atom and never
  ;; consumes a table slot.
  (func $atom_is_int (param $s i32) (result i32)
    (i32.eqz (i32.shr_u (local.get $s) (i32.const 16))))

  ;; Slot index of $name in $table, or -1. Atom names are case-insensitive.
  (func $atom_slot_of_name (param $table i32) (param $name i32) (result i32)
    (local $i i32) (local $e i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $ATOM_TABLE_SLOTS)))
      (local.set $e (i32.add (local.get $table) (i32.mul (local.get $i) (i32.const 8))))
      (if (i32.and (i32.ne (i32.load (local.get $e)) (i32.const 0))
                   (i32.eqz (call $guest_stricmp (i32.load (local.get $e)) (local.get $name))))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  ;; Add $name to $table. Returns the atom, or 0 when the table is full.
  (func $atom_add (param $table i32) (param $name i32) (result i32)
    (local $i i32) (local $e i32) (local $copy i32)
    (if (call $atom_is_int (local.get $name))
      (then (return (local.get $name))))
    (if (i32.eqz (local.get $name)) (then (return (i32.const 0))))
    (local.set $i (call $atom_slot_of_name (local.get $table) (local.get $name)))
    (if (i32.ge_s (local.get $i) (i32.const 0))
      (then
        (local.set $e (i32.add (local.get $table) (i32.mul (local.get $i) (i32.const 8))))
        (i32.store offset=4 (local.get $e) (i32.add (i32.load offset=4 (local.get $e)) (i32.const 1)))
        (return (i32.add (global.get $ATOM_FIRST) (local.get $i)))))
    ;; Not present — claim the first free slot and take a private copy of the
    ;; name, since the caller's buffer is free to change after the call.
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $ATOM_TABLE_SLOTS)))
      (local.set $e (i32.add (local.get $table) (i32.mul (local.get $i) (i32.const 8))))
      (if (i32.eqz (i32.load (local.get $e)))
        (then
          (local.set $copy (call $heap_alloc
            (i32.add (call $guest_strlen (local.get $name)) (i32.const 1))))
          (if (i32.eqz (local.get $copy)) (then (return (i32.const 0))))
          (call $guest_strcpy (local.get $copy) (local.get $name))
          (i32.store (local.get $e) (local.get $copy))
          (i32.store offset=4 (local.get $e) (i32.const 1))
          (return (i32.add (global.get $ATOM_FIRST) (local.get $i)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; Look up $name in $table without adding it. Returns the atom, or 0.
  (func $atom_find (param $table i32) (param $name i32) (result i32)
    (local $i i32)
    (if (call $atom_is_int (local.get $name))
      (then (return (local.get $name))))
    (if (i32.eqz (local.get $name)) (then (return (i32.const 0))))
    (local.set $i (call $atom_slot_of_name (local.get $table) (local.get $name)))
    (if (i32.lt_s (local.get $i) (i32.const 0)) (then (return (i32.const 0))))
    (i32.add (global.get $ATOM_FIRST) (local.get $i)))

  ;; Entry address for a live string atom, or 0 when $atom is an integer atom,
  ;; out of range, or names a free slot.
  (func $atom_entry (param $table i32) (param $atom i32) (result i32)
    (local $i i32) (local $e i32)
    (if (i32.lt_u (local.get $atom) (global.get $ATOM_FIRST)) (then (return (i32.const 0))))
    (local.set $i (i32.sub (local.get $atom) (global.get $ATOM_FIRST)))
    (if (i32.ge_u (local.get $i) (global.get $ATOM_TABLE_SLOTS)) (then (return (i32.const 0))))
    (local.set $e (i32.add (local.get $table) (i32.mul (local.get $i) (i32.const 8))))
    (if (i32.eqz (i32.load (local.get $e))) (then (return (i32.const 0))))
    (local.get $e))

  ;; Drop one reference; free the slot when the last one goes. Returns 0 on
  ;; success (both Win32 delete entry points report success as zero).
  ;; Note: $atom_is_int must NOT be used here. It classifies a *name* argument
  ;; (HIWORD == 0 means MAKEINTATOM), and every string atom value is itself
  ;; below 0x10000, so applying it to an atom makes every delete a no-op.
  ;; $atom_entry's "below 0xC000" test is the correct integer-atom guard.
  (func $atom_delete (param $table i32) (param $atom i32) (result i32)
    (local $e i32)
    (local.set $e (call $atom_entry (local.get $table) (local.get $atom)))
    (if (i32.eqz (local.get $e)) (then (return (i32.const 0))))
    (i32.store offset=4 (local.get $e) (i32.sub (i32.load offset=4 (local.get $e)) (i32.const 1)))
    (if (i32.le_s (i32.load offset=4 (local.get $e)) (i32.const 0))
      (then
        (call $heap_free (i32.load (local.get $e)))
        (i32.store (local.get $e) (i32.const 0))
        (i32.store offset=4 (local.get $e) (i32.const 0))))
    (i32.const 0))

  ;; Copy the name of $atom into the guest buffer $buf, which holds $size
  ;; characters including the terminator. Returns characters copied (0 = no
  ;; such atom), matching GlobalGetAtomName. The table stores ANSI names, so
  ;; the only thing $wide changes is the stride of the write.
  (func $atom_get_name (param $table i32) (param $atom i32) (param $buf i32)
                       (param $size i32) (param $wide i32) (result i32)
    (local $e i32) (local $src i32) (local $n i32) (local $i i32) (local $step i32)
    (if (i32.or (i32.eqz (local.get $buf)) (i32.le_s (local.get $size) (i32.const 0)))
      (then (return (i32.const 0))))
    (local.set $e (call $atom_entry (local.get $table) (local.get $atom)))
    (if (i32.eqz (local.get $e)) (then (return (i32.const 0))))
    (local.set $src (i32.load (local.get $e)))
    (local.set $n (call $guest_strlen (local.get $src)))
    (if (i32.gt_u (local.get $n) (i32.sub (local.get $size) (i32.const 1)))
      (then (local.set $n (i32.sub (local.get $size) (i32.const 1)))))
    (local.set $step (select (i32.const 2) (i32.const 1) (local.get $wide)))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (call $store_char (i32.add (local.get $buf) (i32.mul (local.get $i) (local.get $step)))
                        (call $gl8 (i32.add (local.get $src) (local.get $i)))
                        (local.get $wide))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (call $store_char (i32.add (local.get $buf) (i32.mul (local.get $n) (local.get $step)))
                      (i32.const 0) (local.get $wide))
    (local.get $n))

  ;; Narrow a UTF-16 atom name into a temporary guest ANSI buffer so the W
  ;; entry points share one table with the A ones — an atom added as W must be
  ;; findable as A. Caller frees. Integer atoms pass through untouched.
  (func $atom_narrow_w (param $ws i32) (result i32)
    (local $len i32) (local $buf i32) (local $i i32) (local $ch i32)
    (if (call $atom_is_int (local.get $ws)) (then (return (local.get $ws))))
    (if (i32.eqz (local.get $ws)) (then (return (i32.const 0))))
    (block $d (loop $l
      (br_if $d (i32.eqz (call $gl16 (i32.add (local.get $ws) (i32.mul (local.get $len) (i32.const 2))))))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (br_if $d (i32.ge_u (local.get $len) (i32.const 512)))
      (br $l)))
    (local.set $buf (call $heap_alloc (i32.add (local.get $len) (i32.const 1))))
    (if (i32.eqz (local.get $buf)) (then (return (i32.const 0))))
    (block $d2 (loop $l2
      (br_if $d2 (i32.ge_u (local.get $i) (local.get $len)))
      (local.set $ch (call $gl16 (i32.add (local.get $ws) (i32.mul (local.get $i) (i32.const 2)))))
      (call $gs8 (i32.add (local.get $buf) (local.get $i))
        (select (i32.const 0x3F) (local.get $ch) (i32.gt_u (local.get $ch) (i32.const 0xFF))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2)))
    (call $gs8 (i32.add (local.get $buf) (local.get $len)) (i32.const 0))
    (local.get $buf))

  ;; Release a buffer handed back by $atom_narrow_w. Integer atoms were passed
  ;; through rather than allocated, so they must not be freed.
  (func $atom_narrow_free (param $ws i32) (param $buf i32)
    (if (i32.and (i32.ne (local.get $buf) (i32.const 0))
                 (i32.eqz (call $atom_is_int (local.get $ws))))
      (then (call $heap_free (local.get $buf)))))

  ;; 788: GlobalAddAtomA(lpString)
  (func $handle_GlobalAddAtomA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $atom_add (global.get $ATOM_GLOBAL_TABLE) (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; GlobalFindAtomA(lpString) — 0 when the name was never added.
  (func $handle_GlobalFindAtomA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $atom_find (global.get $ATOM_GLOBAL_TABLE) (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; GlobalGetAtomNameA(nAtom, lpBuffer, nSize)
  (func $handle_GlobalGetAtomNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $atom_get_name (global.get $ATOM_GLOBAL_TABLE)
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; AddAtomA(lpString) — process-local namespace, separate from the global one.
  (func $handle_AddAtomA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $atom_add (global.get $ATOM_LOCAL_TABLE) (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; AddAtomW(lpString)
  (func $handle_AddAtomW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $narrow i32)
    (local.set $narrow (call $atom_narrow_w (local.get $arg0)))
    (global.set $eax (call $atom_add (global.get $ATOM_LOCAL_TABLE) (local.get $narrow)))
    (call $atom_narrow_free (local.get $arg0) (local.get $narrow))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; GetAtomNameA(nAtom, lpBuffer, nSize)
  (func $handle_GetAtomNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $atom_get_name (global.get $ATOM_LOCAL_TABLE)
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; GetAtomNameW(nAtom, lpBuffer, nSize)
  (func $handle_GetAtomNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $atom_get_name (global.get $ATOM_LOCAL_TABLE)
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; DeleteAtom(nAtom) — release one process-local reference.
  (func $handle_DeleteAtom (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $atom_delete (global.get $ATOM_LOCAL_TABLE) (local.get $arg0)))
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
      ;; Backspace (0x0E)
      (if (i32.eq (local.get $scan) (i32.const 0x0E)) (then
        (i32.store (local.get $buf) (i32.const 0x6B636142)) ;; "Back"
        (i32.store (i32.add (local.get $buf) (i32.const 4)) (i32.const 0x63617073)) ;; "spac"
        (i32.store16 (i32.add (local.get $buf) (i32.const 8)) (i32.const 0x0065)) ;; "e\0"
        (local.set $len (i32.const 9)) (br $done)))
      ;; Caps Lock (0x3A)
      (if (i32.eq (local.get $scan) (i32.const 0x3A)) (then
        (i32.store (local.get $buf) (i32.const 0x73706143)) ;; "Caps"
        (i32.store (i32.add (local.get $buf) (i32.const 4)) (i32.const 0x636F4C20)) ;; " Loc"
        (i32.store16 (i32.add (local.get $buf) (i32.const 8)) (i32.const 0x006B)) ;; "k\0"
        (local.set $len (i32.const 9)) (br $done)))
      ;; Num Lock (0x45)
      (if (i32.eq (local.get $scan) (i32.const 0x45)) (then
        (i32.store (local.get $buf) (i32.const 0x206D754E)) ;; "Num "
        (i32.store (i32.add (local.get $buf) (i32.const 4)) (i32.const 0x6B636F4C)) ;; "Lock"
        (i32.store8 (i32.add (local.get $buf) (i32.const 8)) (i32.const 0))
        (local.set $len (i32.const 8)) (br $done)))
      ;; Scroll Lock (0x46)
      (if (i32.eq (local.get $scan) (i32.const 0x46)) (then
        (i32.store (local.get $buf) (i32.const 0x6F726353)) ;; "Scro"
        (i32.store (i32.add (local.get $buf) (i32.const 4)) (i32.const 0x4C206C6C)) ;; "ll L"
        (i32.store (i32.add (local.get $buf) (i32.const 8)) (i32.const 0x006B636F)) ;; "ock\0"
        (local.set $len (i32.const 11)) (br $done)))
      ;; Numpad scancodes 0x37 (*), 0x47..0x53. Render as "Num <glyph>".
      ;; 0x47-0x49=NP7-9, 0x4A=-, 0x4B-0x4D=NP4-6, 0x4E=+, 0x4F-0x51=NP1-3,
      ;; 0x52=NP0, 0x53=. — match Windows' "Num 7" / "Num *" naming.
      (local.set $ch (i32.const 0))
      (if (i32.eq (local.get $scan) (i32.const 0x37)) (then (local.set $ch (i32.const 0x2A)))) ;; *
      (if (i32.eq (local.get $scan) (i32.const 0x47)) (then (local.set $ch (i32.const 0x37)))) ;; 7
      (if (i32.eq (local.get $scan) (i32.const 0x48)) (then (local.set $ch (i32.const 0x38)))) ;; 8
      (if (i32.eq (local.get $scan) (i32.const 0x49)) (then (local.set $ch (i32.const 0x39)))) ;; 9
      (if (i32.eq (local.get $scan) (i32.const 0x4A)) (then (local.set $ch (i32.const 0x2D)))) ;; -
      (if (i32.eq (local.get $scan) (i32.const 0x4B)) (then (local.set $ch (i32.const 0x34)))) ;; 4
      (if (i32.eq (local.get $scan) (i32.const 0x4C)) (then (local.set $ch (i32.const 0x35)))) ;; 5
      (if (i32.eq (local.get $scan) (i32.const 0x4D)) (then (local.set $ch (i32.const 0x36)))) ;; 6
      (if (i32.eq (local.get $scan) (i32.const 0x4E)) (then (local.set $ch (i32.const 0x2B)))) ;; +
      (if (i32.eq (local.get $scan) (i32.const 0x4F)) (then (local.set $ch (i32.const 0x31)))) ;; 1
      (if (i32.eq (local.get $scan) (i32.const 0x50)) (then (local.set $ch (i32.const 0x32)))) ;; 2  (overrides arrow Down)
      (if (i32.eq (local.get $scan) (i32.const 0x51)) (then (local.set $ch (i32.const 0x33)))) ;; 3
      (if (i32.eq (local.get $scan) (i32.const 0x52)) (then (local.set $ch (i32.const 0x30)))) ;; 0
      (if (i32.eq (local.get $scan) (i32.const 0x53)) (then (local.set $ch (i32.const 0x2E)))) ;; .
      (if (local.get $ch) (then
        (i32.store (local.get $buf) (i32.const 0x206D754E)) ;; "Num "
        (i32.store8 (i32.add (local.get $buf) (i32.const 4)) (local.get $ch))
        (i32.store8 (i32.add (local.get $buf) (i32.const 5)) (i32.const 0))
        (local.set $len (i32.const 5)) (br $done)))
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
      ;; OEM punctuation — render the unshifted glyph as a 1-char name.
      (local.set $ch (i32.const 0))
      (if (i32.eq (local.get $scan) (i32.const 0x0C)) (then (local.set $ch (i32.const 0x2D)))) ;; -
      (if (i32.eq (local.get $scan) (i32.const 0x0D)) (then (local.set $ch (i32.const 0x3D)))) ;; =
      (if (i32.eq (local.get $scan) (i32.const 0x1A)) (then (local.set $ch (i32.const 0x5B)))) ;; [
      (if (i32.eq (local.get $scan) (i32.const 0x1B)) (then (local.set $ch (i32.const 0x5D)))) ;; ]
      (if (i32.eq (local.get $scan) (i32.const 0x27)) (then (local.set $ch (i32.const 0x3B)))) ;; ;
      (if (i32.eq (local.get $scan) (i32.const 0x28)) (then (local.set $ch (i32.const 0x27)))) ;; '
      (if (i32.eq (local.get $scan) (i32.const 0x29)) (then (local.set $ch (i32.const 0x60)))) ;; `
      (if (i32.eq (local.get $scan) (i32.const 0x2B)) (then (local.set $ch (i32.const 0x5C)))) ;; \
      (if (i32.eq (local.get $scan) (i32.const 0x33)) (then (local.set $ch (i32.const 0x2C)))) ;; ,
      (if (i32.eq (local.get $scan) (i32.const 0x34)) (then (local.set $ch (i32.const 0x2E)))) ;; .
      (if (i32.eq (local.get $scan) (i32.const 0x35)) (then (local.set $ch (i32.const 0x2F)))) ;; /
      (if (local.get $ch) (then
        (i32.store8 (local.get $buf) (local.get $ch))
        (i32.store8 (i32.add (local.get $buf) (i32.const 1)) (i32.const 0))
        (local.set $len (i32.const 1)) (br $done)))
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
    (call $midi_stream_service (global.get $tick_count))
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

  ;; ---- PROP_TABLE helpers ----
  ;; Linear scan is fine — most apps have a handful of live props. Name
  ;; normalisation happens in $prop_key: an ATOM passes through as itself, a
  ;; string is FNV-1a hashed.
  (func $prop_find (param $hwnd i32) (param $key i32) (result i32)
    (local $i i32) (local $p i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_PROPS)))
      (local.set $p (i32.add (global.get $PROP_TABLE)
                     (i32.mul (local.get $i) (i32.const 12))))
      (if (i32.and (i32.eq (i32.load (local.get $p)) (local.get $hwnd))
                   (i32.eq (i32.load offset=4 (local.get $p)) (local.get $key)))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  ;; Turn a prop name into a table key. The name is either a pointer to a
  ;; string or an ATOM -- a small integer smuggled through the same argument,
  ;; which is what MAKEINTATOM and every RegisterWindowMessage-style atom is.
  ;;
  ;; The test has to happen on the guest value, before g2w. An ATOM like
  ;; 0xC000 is far below the image base, so translating it first wraps it to
  ;; an address nowhere near the guest, $class_name_hash no longer recognises
  ;; it as an atom, and it hashes whatever bytes happen to live there. Those
  ;; bytes were zero, so every atom hashed to the FNV basis and collided:
  ;; comctl32 asking hwnd for its own 0xC000 prop was handed back the object
  ;; VCL had stored under 0xC001, and passed that straight to LocalReAlloc.
  (func $prop_key (param $ga i32) (result i32)
    (if (i32.lt_u (local.get $ga) (i32.const 0x10000))
      (then (return (local.get $ga))))
    (call $class_name_hash (call $g2w (local.get $ga))))

  (func $prop_empty_slot (result i32)
    (local $i i32) (local $p i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_PROPS)))
      (local.set $p (i32.add (global.get $PROP_TABLE)
                     (i32.mul (local.get $i) (i32.const 12))))
      (if (i32.eqz (i32.load (local.get $p))) (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  ;; 816: GetPropA(hwnd, lpString) → HANDLE
  (func $handle_GetPropA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $idx i32)
    (local.set $idx (call $prop_find (local.get $arg0)
                     (call $prop_key (local.get $arg1))))
    (if (i32.lt_s (local.get $idx) (i32.const 0))
      (then (global.set $eax (i32.const 0)))
      (else (global.set $eax
              (i32.load offset=8 (i32.add (global.get $PROP_TABLE)
                                  (i32.mul (local.get $idx) (i32.const 12)))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 817: SetPropA(hwnd, lpString, hData) → BOOL
  (func $handle_SetPropA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $key i32) (local $idx i32) (local $p i32)
    (local.set $key (call $prop_key (local.get $arg1)))
    (local.set $idx (call $prop_find (local.get $arg0) (local.get $key)))
    (if (i32.lt_s (local.get $idx) (i32.const 0))
      (then (local.set $idx (call $prop_empty_slot))))
    (if (i32.ge_s (local.get $idx) (i32.const 0))
      (then
        (local.set $p (i32.add (global.get $PROP_TABLE)
                       (i32.mul (local.get $idx) (i32.const 12))))
        (i32.store         (local.get $p) (local.get $arg0))
        (i32.store offset=4  (local.get $p) (local.get $key))
        (i32.store offset=8  (local.get $p) (local.get $arg2))
        (global.set $eax (i32.const 1)))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; GetSystemInfo(lpSystemInfo) — fill SYSTEM_INFO struct (36 bytes)
  (func $handle_GetSystemInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (call $zero_memory (local.get $wa) (i32.const 36))
    ;; wProcessorArchitecture=0 (x86), wReserved=0 → already zero
    (i32.store offset=4  (local.get $wa) (i32.const 4096))        ;; dwPageSize
    (i32.store offset=8  (local.get $wa) (i32.const 0x00010000))  ;; lpMinimumApplicationAddress
    (i32.store offset=12 (local.get $wa) (i32.const 0x7FFEFFFF))  ;; lpMaximumApplicationAddress
    (i32.store offset=16 (local.get $wa) (i32.const 1))           ;; dwActiveProcessorMask
    (i32.store offset=20 (local.get $wa) (i32.const 1))           ;; dwNumberOfProcessors
    (i32.store offset=24 (local.get $wa) (i32.const 586))         ;; dwProcessorType (PROCESSOR_INTEL_PENTIUM)
    (i32.store offset=28 (local.get $wa) (i32.const 0x10000))     ;; dwAllocationGranularity = 64K
    (i32.store16 offset=32 (local.get $wa) (i32.const 6))         ;; wProcessorLevel
    ;; wProcessorRevision=0 → already zero
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; GetUserNameA(lpBuffer, pcbBuffer) — write "user\0" then update *pcbBuffer = 5
  (func $handle_GetUserNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wbuf i32) (local $wlen i32)
    (if (i32.eqz (local.get $arg1))
      (then
        (global.set $last_error (i32.const 87)) ;; ERROR_INVALID_PARAMETER
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (local.set $wlen (call $g2w (local.get $arg1)))
    (if (i32.or (i32.eqz (local.get $arg0))
                (i32.lt_u (i32.load (local.get $wlen)) (i32.const 5)))
      (then
        (i32.store (local.get $wlen) (i32.const 5))
        (global.set $last_error (i32.const 122)) ;; ERROR_INSUFFICIENT_BUFFER
        (global.set $eax (i32.const 0)))
      (else
        (local.set $wbuf (call $g2w (local.get $arg0)))
        (i32.store8 offset=0 (local.get $wbuf) (i32.const 117)) ;; 'u'
        (i32.store8 offset=1 (local.get $wbuf) (i32.const 115)) ;; 's'
        (i32.store8 offset=2 (local.get $wbuf) (i32.const 101)) ;; 'e'
        (i32.store8 offset=3 (local.get $wbuf) (i32.const 114)) ;; 'r'
        (i32.store8 offset=4 (local.get $wbuf) (i32.const 0))
        (i32.store (local.get $wlen) (i32.const 5))
        (global.set $last_error (i32.const 0))
        (global.set $eax (i32.const 1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; GetUserNameW(lpBuffer, pcbBuffer) — UTF-16 counterpart.  Unlike
  ;; GetComputerName, this API reports the terminating NUL in *pcbBuffer on
  ;; both success and insufficient-buffer failure.
  (func $handle_GetUserNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wbuf i32) (local $wlen i32)
    (local.set $wlen (call $g2w (local.get $arg1)))
    (if (i32.or (i32.eqz (local.get $arg0))
                (i32.lt_u (i32.load (local.get $wlen)) (i32.const 5)))
      (then
        (i32.store (local.get $wlen) (i32.const 5))
        (global.set $last_error (i32.const 122)) ;; ERROR_INSUFFICIENT_BUFFER
        (global.set $eax (i32.const 0)))
      (else
        (local.set $wbuf (call $g2w (local.get $arg0)))
        (i32.store16 offset=0 (local.get $wbuf) (i32.const 117)) ;; 'u'
        (i32.store16 offset=2 (local.get $wbuf) (i32.const 115)) ;; 's'
        (i32.store16 offset=4 (local.get $wbuf) (i32.const 101)) ;; 'e'
        (i32.store16 offset=6 (local.get $wbuf) (i32.const 114)) ;; 'r'
        (i32.store16 offset=8 (local.get $wbuf) (i32.const 0))
        (i32.store (local.get $wlen) (i32.const 5))
        (global.set $last_error (i32.const 0))
        (global.set $eax (i32.const 1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; GetComputerNameA(lpBuffer, pcbBuffer) — write "PC\0" then update *pcbBuffer = 2
  (func $handle_GetComputerNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wbuf i32) (local $wlen i32)
    (if (i32.eqz (local.get $arg1))
      (then
        (global.set $last_error (i32.const 87)) ;; ERROR_INVALID_PARAMETER
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (local.set $wlen (call $g2w (local.get $arg1)))
    (if (i32.or (i32.eqz (local.get $arg0))
                (i32.lt_u (i32.load (local.get $wlen)) (i32.const 3)))
      (then
        (i32.store (local.get $wlen) (i32.const 3))
        (global.set $last_error (i32.const 111)) ;; ERROR_BUFFER_OVERFLOW
        (global.set $eax (i32.const 0)))
      (else
        (local.set $wbuf (call $g2w (local.get $arg0)))
        (i32.store8 offset=0 (local.get $wbuf) (i32.const 80))  ;; 'P'
        (i32.store8 offset=1 (local.get $wbuf) (i32.const 67))  ;; 'C'
        (i32.store8 offset=2 (local.get $wbuf) (i32.const 0))
        (i32.store (local.get $wlen) (i32.const 2))
        (global.set $last_error (i32.const 0))
        (global.set $eax (i32.const 1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; GetComputerNameW(lpBuffer, pcbBuffer) — the Unicode machine name uses
  ;; the same deterministic identity as GetComputerNameA.  pcbBuffer is an
  ;; in/out WCHAR count: failure reports the required count including NUL,
  ;; while success reports the two characters excluding it.
  (func $handle_GetComputerNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wbuf i32) (local $wlen i32)
    (local.set $wlen (call $g2w (local.get $arg1)))
    (if (i32.or (i32.eqz (local.get $arg0))
                (i32.lt_u (i32.load (local.get $wlen)) (i32.const 3)))
      (then
        (i32.store (local.get $wlen) (i32.const 3))
        (global.set $last_error (i32.const 111)) ;; ERROR_BUFFER_OVERFLOW
        (global.set $eax (i32.const 0)))
      (else
        (local.set $wbuf (call $g2w (local.get $arg0)))
        (i32.store16 offset=0 (local.get $wbuf) (i32.const 80)) ;; 'P'
        (i32.store16 offset=2 (local.get $wbuf) (i32.const 67)) ;; 'C'
        (i32.store16 offset=4 (local.get $wbuf) (i32.const 0))
        (i32.store (local.get $wlen) (i32.const 2))
        (global.set $last_error (i32.const 0))
        (global.set $eax (i32.const 1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; DirectPlayCreate(lpGUIDSP, lplpDP, pUnk) — the pre-COM entry point into
  ;; DirectPlay, which apps reach via LoadLibrary("DPlayX.dll") rather than
  ;; the import table. Hands back the same object CoCreateInstance(
  ;; CLSID_DirectPlay) builds: callers immediately QueryInterface it up to
  ;; IDirectPlay3/4, and our vtable answers to all of them.
  (func $handle_DirectPlayCreate (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $obj_guest i32)
    (local.set $obj_guest (call $dx_create_com_obj (i32.const 26) (global.get $DX_VTBL_DPLAY3)))
    (if (i32.eqz (local.get $obj_guest))
      (then
        (if (local.get $arg1) (then (call $gs32 (local.get $arg1) (i32.const 0))))
        (global.set $eax (i32.const 0x80004005))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (if (local.get $arg1) (then (call $gs32 (local.get $arg1) (local.get $obj_guest))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))
  ;; DirectPlayEnumerate[A](lpEnumCallback, lpContext) predates the COM
  ;; DirectPlay interfaces. Win98 applications use it to choose a registered
  ;; service provider before DirectPlayCreate, so failing here hides the TCP/IP
  ;; transport that the browser virtual LAN already implements.
  ;;
  ;; LPDPENUMDPCALLBACKA receives provider GUID, ANSI display name, provider
  ;; major/minor version, and caller context. Win98's providers report version
  ;; 6.0; expose the one transport this runtime can actually connect through.
  (global $dplay_enum_tcpip_guid (mut i32) (i32.const 0))
  (global $dplay_enum_tcpip_name (mut i32) (i32.const 0))

  (func $dplay_enum_provider_init (result i32)
    (if (i32.and
          (i32.ne (global.get $dplay_enum_tcpip_guid) (i32.const 0))
          (i32.ne (global.get $dplay_enum_tcpip_name) (i32.const 0)))
      (then (return (i32.const 1))))
    (global.set $dplay_enum_tcpip_guid (call $heap_alloc (i32.const 16)))
    (global.set $dplay_enum_tcpip_name (call $heap_alloc (i32.const 44)))
    (if (i32.or
          (i32.eqz (global.get $dplay_enum_tcpip_guid))
          (i32.eqz (global.get $dplay_enum_tcpip_name)))
      (then
        (if (global.get $dplay_enum_tcpip_name)
          (then (call $heap_free (global.get $dplay_enum_tcpip_name))))
        (if (global.get $dplay_enum_tcpip_guid)
          (then (call $heap_free (global.get $dplay_enum_tcpip_guid))))
        (global.set $dplay_enum_tcpip_guid (i32.const 0))
        (global.set $dplay_enum_tcpip_name (i32.const 0))
        (return (i32.const 0))))
    ;; DPSPGUID_TCPIP {36E95EE0-8577-11cf-960C-0080C7534E82}.
    (call $gs32 (global.get $dplay_enum_tcpip_guid) (i32.const 0x36E95EE0))
    (call $gs32 (i32.add (global.get $dplay_enum_tcpip_guid) (i32.const 4))
      (i32.const 0x11CF8577))
    (call $gs32 (i32.add (global.get $dplay_enum_tcpip_guid) (i32.const 8))
      (i32.const 0x80000C96))
    (call $gs32 (i32.add (global.get $dplay_enum_tcpip_guid) (i32.const 12))
      (i32.const 0x824E53C7))
    ;; "Internet TCP/IP Connection For DirectPlay\0"
    (call $gs32 (global.get $dplay_enum_tcpip_name) (i32.const 0x65746E49))
    (call $gs32 (i32.add (global.get $dplay_enum_tcpip_name) (i32.const 4))
      (i32.const 0x74656E72))
    (call $gs32 (i32.add (global.get $dplay_enum_tcpip_name) (i32.const 8))
      (i32.const 0x50435420))
    (call $gs32 (i32.add (global.get $dplay_enum_tcpip_name) (i32.const 12))
      (i32.const 0x2050492F))
    (call $gs32 (i32.add (global.get $dplay_enum_tcpip_name) (i32.const 16))
      (i32.const 0x6E6E6F43))
    (call $gs32 (i32.add (global.get $dplay_enum_tcpip_name) (i32.const 20))
      (i32.const 0x69746365))
    (call $gs32 (i32.add (global.get $dplay_enum_tcpip_name) (i32.const 24))
      (i32.const 0x46206E6F))
    (call $gs32 (i32.add (global.get $dplay_enum_tcpip_name) (i32.const 28))
      (i32.const 0x4420726F))
    (call $gs32 (i32.add (global.get $dplay_enum_tcpip_name) (i32.const 32))
      (i32.const 0x63657269))
    (call $gs32 (i32.add (global.get $dplay_enum_tcpip_name) (i32.const 36))
      (i32.const 0x616C5074))
    (call $gs32 (i32.add (global.get $dplay_enum_tcpip_name) (i32.const 40))
      (i32.const 0x00000079))
    (i32.const 1))

  (func $directplay_enumerate_ansi
      (param $callback i32) (param $context i32) (param $ret_addr i32)
    (if (i32.eqz (local.get $callback))
      (then
        (global.set $eax (i32.const 0x80070057)) ;; DPERR_INVALIDPARAMS
        (return)))
    (if (i32.eqz (call $dplay_enum_provider_init))
      (then
        (global.set $eax (i32.const 0x8007000E)) ;; DPERR_OUTOFMEMORY
        (return)))
    ;; Saved API return, then callback args right-to-left: context, minor,
    ;; major, provider name, provider GUID.
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $ret_addr))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $context))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 6))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $dplay_enum_tcpip_name))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $dplay_enum_tcpip_guid))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $ddenum_ret_thunk))
    (global.set $eip (local.get $callback))
    (global.set $steps (i32.const 0)))

  ;; The unsuffixed ordinal is the legacy ANSI export on Win98.
  (func $handle_DirectPlayEnumerate (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret_addr i32)
    (local.set $ret_addr (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
    (call $directplay_enumerate_ansi
      (local.get $arg0) (local.get $arg1) (local.get $ret_addr)))
  (func $handle_DirectPlayEnumerateA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret_addr i32)
    (local.set $ret_addr (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
    (call $directplay_enumerate_ansi
      (local.get $arg0) (local.get $arg1) (local.get $ret_addr)))
  (func $handle_DirectPlayLobbyCreateA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $obj_guest i32)
    (local.set $obj_guest (call $dx_create_com_obj (i32.const 27) (global.get $DX_VTBL_DPLAYLOBBY2)))
    (if (i32.eqz (local.get $obj_guest))
      (then
        (if (local.get $arg1) (then (call $gs32 (local.get $arg1) (i32.const 0))))
        (global.set $eax (i32.const 0x80004005))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    (if (local.get $arg1) (then (call $gs32 (local.get $arg1) (local.get $obj_guest))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))
  ;; DirectSoundEnumerateA(lpCallback, lpContext) → DS_OK
  ;; Fires the callback once for the primary sound driver, then returns DS_OK.
  ;; Callback: BOOL CALLBACK cb(LPGUID lpGuid, LPCSTR lpcstrDescription,
  ;;                            LPCSTR lpcstrModule, LPVOID lpContext)
  ;; A NULL GUID is what real DirectSound reports for the default device.
  ;;
  ;; Returning DS_OK without ever calling back is not the same as "no sound
  ;; hardware" to an app that builds its device list from the enumeration:
  ;; RollerCoaster Tycoon shows "(None)" in the Options sound dropdown and
  ;; never calls DirectSoundCreate at all, so it stays silent no matter what
  ;; the rest of the audio stack can do.
  ;;
  ;; DSEnumCallback has the same four-argument shape as DDEnumCallback and the
  ;; same DS_OK == DD_OK == 0 return, so this reuses the CACA0007
  ;; $ddenum_ret_thunk continuation rather than adding a second identical one.
  (func $handle_DirectSoundEnumerateA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $desc i32) (local $module i32) (local $ret_addr i32)
    ;; No callback means the app only wanted the HRESULT.
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    ;; Save the caller's return address, then drop it and the two stdcall args.
    (local.set $ret_addr (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
    ;; "Primary Sound Driver\0" and an empty module name (the default device
    ;; has no driver DLL of its own).
    (local.set $desc (call $heap_alloc (i32.const 24)))
    (local.set $module (call $heap_alloc (i32.const 4)))
    (i32.store (call $g2w (local.get $desc)) (i32.const 0x6d697250))                          ;; "Prim"
    (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 4))) (i32.const 0x20797261))  ;; "ary "
    (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 8))) (i32.const 0x6e756f53))  ;; "Soun"
    (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 12))) (i32.const 0x72442064)) ;; "d Dr"
    (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 16))) (i32.const 0x72657669)) ;; "iver"
    (i32.store8 (call $g2w (i32.add (local.get $desc) (i32.const 20))) (i32.const 0))
    (i32.store8 (call $g2w (local.get $module)) (i32.const 0))
    ;; Caller's return address first — the CACA0007 continuation pops it after
    ;; the callback returns.
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $ret_addr))
    ;; Callback args, right to left.
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $arg1))    ;; lpContext
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $module))  ;; lpcstrModule
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $desc))    ;; lpcstrDescription
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0))        ;; lpGuid = NULL (default device)
    ;; Continuation thunk as the callback's own return address.
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $ddenum_ret_thunk))
    (global.set $eip (local.get $arg0))
    (global.set $steps (i32.const 0)))
  ;; mciSendStringA(cmd, retbuf, retlen, hCallback) → MCIERR (0 = no error)
  (func $handle_mciSendStringA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Clear return buffer if provided, then let the host parse/execute the
    ;; command string. The host owns MCI aliases and MIDI sequencing.
    (if (i32.and (i32.ne (local.get $arg1) (i32.const 0)) (i32.ne (local.get $arg2) (i32.const 0)))
      (then (i32.store8 (call $g2w (local.get $arg1)) (i32.const 0))))
    (global.set $eax
      (call $host_mci_string
        (if (result i32) (local.get $arg0) (then (call $g2w (local.get $arg0))) (else (i32.const 0)))
        (if (result i32) (local.get $arg1) (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
        (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; mciSendStringW(cmd, retbuf, retlen, hCallback) — use the same host MCI
  ;; parser as A, converting its command and optional result at the boundary.
  (func $handle_mciSendStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $cmd_g i32) (local $ret_g i32) (local $cmd_len i32) (local $err i32)
    (if (local.get $arg0)
      (then
        (local.set $cmd_len (call $guest_wcslen (local.get $arg0)))
        (local.set $cmd_g (call $heap_alloc (i32.add (local.get $cmd_len) (i32.const 1))))
        (drop (call $wide_to_ansi (local.get $arg0) (local.get $cmd_g)
                (i32.add (local.get $cmd_len) (i32.const 1))))))
    (if (i32.and (i32.ne (local.get $arg1) (i32.const 0))
                 (i32.ne (local.get $arg2) (i32.const 0)))
      (then
        (local.set $ret_g (call $heap_alloc (local.get $arg2)))
        (call $zero_memory (call $g2w (local.get $ret_g)) (local.get $arg2))))
    (local.set $err
      (call $host_mci_string
        (if (result i32) (local.get $cmd_g)
          (then (call $g2w (local.get $cmd_g))) (else (i32.const 0)))
        (if (result i32) (local.get $ret_g)
          (then (call $g2w (local.get $ret_g))) (else (i32.const 0)))
        (local.get $arg2)))
    (if (local.get $ret_g)
      (then
        (drop (call $ansi_to_wide (local.get $ret_g) (local.get $arg1) (local.get $arg2)))
        (call $heap_free (local.get $ret_g))))
    (if (local.get $cmd_g) (then (call $heap_free (local.get $cmd_g))))
    (global.set $eax (local.get $err))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

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
    (local $idx i32) (local $p i32)
    (local.set $idx (call $prop_find (local.get $arg0)
                     (call $prop_key (local.get $arg1))))
    (if (i32.lt_s (local.get $idx) (i32.const 0))
      (then (global.set $eax (i32.const 0)))
      (else
        (local.set $p (i32.add (global.get $PROP_TABLE)
                       (i32.mul (local.get $idx) (i32.const 12))))
        (global.set $eax (i32.load offset=8 (local.get $p)))
        (i32.store         (local.get $p) (i32.const 0))
        (i32.store offset=4  (local.get $p) (i32.const 0))
        (i32.store offset=8  (local.get $p) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 824: GetConsoleOutputCP() → UINT — returns output code page
  (func $handle_GetConsoleOutputCP (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 437))  ;; CP 437 (OEM United States)
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

;; SetupAPI/device notifications are optional for sndvol32. Fail the device
  ;; registration/enumeration path cleanly so the mixer UI can continue.
  (func $handle_SetupDiCreateDeviceInfoList (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0xffffffff))  ;; INVALID_HANDLE_VALUE
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_SetupDiDestroyDeviceInfoList (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_SetupDiOpenDeviceInterfaceW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  (func $handle_SetupDiGetDeviceInterfaceDetailW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  (func $handle_SetupDiOpenDevRegKey (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0xffffffff))  ;; INVALID_HANDLE_VALUE
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  (func $handle_RegisterDeviceNotificationW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_UnregisterDeviceNotification (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; 826: mixerGetNumDevs() -> UINT
  (func $handle_mixerGetNumDevs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  ;; 827: CreateConsoleScreenBuffer(dwDesiredAccess, dwShareMode, lpSecurityAttributes, dwFlags, lpScreenBufferData) → HANDLE
  ;; Create a distinct text-mode output buffer. The record and its cells live
  ;; in shared linear memory, so browser Workers observe the same handle state.
  (func $handle_CreateConsoleScreenBuffer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.or (i32.ne (local.get $arg3) (i32.const 1)) ;; CONSOLE_TEXTMODE_BUFFER
          (i32.ne (local.get $arg4) (i32.const 0)))
      (then
        (global.set $last_error (i32.const 87)) ;; ERROR_INVALID_PARAMETER
        (global.set $eax (i32.const 0xFFFFFFFF)))
      (else
        (global.set $eax (call $console_buffer_create))
        (if (i32.eq (global.get $eax) (i32.const 0xFFFFFFFF))
          (then (global.set $last_error (i32.const 8))) ;; ERROR_NOT_ENOUGH_MEMORY
          (else (global.set $last_error (i32.const 0))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; 821: mixerGetID(hmxobj, puMxId, fdwId) -> MMRESULT
  (func $handle_mixerGetID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1)
      (then (i32.store (call $g2w (local.get $arg1)) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 822: CreateDialogParamW(hInstance, lpTemplateName, hWndParent, lpDialogFunc, dwInitParam)
  ;; RT_DIALOG templates have the same binary layout for A/W callers. Reuse
  ;; the A path so W dialogs get the same WAT-side registration, auto-show, and
  ;; seeded painting behavior. UTF-16 template-name strings remain limited by
  ;; the shared $find_resource implementation, which primarily handles int IDs.
  (func $handle_CreateDialogParamW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hwnd i32)
    (local.set $hwnd (global.get $next_hwnd))
    (call $handle_CreateDialogParamA
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
    (call $wnd_unicode_set (local.get $hwnd) (i32.const 1)))


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
    ;; FindResourceExA: arg1=type, arg2=name (reversed from FindResourceA)
    (call $push_rsrc_ctx (local.get $arg0))
    (global.set $eax (call $find_resource (local.get $arg1) (local.get $arg2)))
    (call $pop_rsrc_ctx)
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

  ;; GetNumberFormatA(Locale, dwFlags, lpValue, lpFormat, lpNumberStr,
  ;; cchNumber). The default-locale form accepts an invariant numeric string
  ;; and, for the en-US Win98 personality, preserves its existing decimal
  ;; spelling. This is also the form used by the Jazz Jackrabbit 2 installer.
  ;; Keep the size-query and bounded-copy behavior exact: successful return
  ;; values include the terminating NUL and a short destination is untouched.
  ;; A caller-supplied NUMBERFMTA requests locale-aware regrouping/rounding we
  ;; do not yet implement, so fail it explicitly instead of silently returning
  ;; a plausibly formatted but wrong number.
  (func $handle_GetNumberFormatA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $cch i32) (local $required i32)
    (local.set $cch (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (global.set $eax (i32.const 0))
    (if (i32.eqz (local.get $arg2))
      (then
        (global.set $last_error (i32.const 87)) ;; ERROR_INVALID_PARAMETER
        (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
        (return)))
    (if (local.get $arg3)
      (then
        (global.set $last_error (i32.const 120)) ;; ERROR_CALL_NOT_IMPLEMENTED
        (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
        (return)))
    (local.set $required
      (i32.add (call $strlen_a (call $g2w (local.get $arg2))) (i32.const 1)))
    (if (i32.eqz (local.get $cch))
      (then (global.set $eax (local.get $required)))
      (else
        (if (i32.or
              (i32.eqz (local.get $arg4))
              (i32.lt_u (local.get $cch) (local.get $required)))
          (then (global.set $last_error (i32.const 122))) ;; ERROR_INSUFFICIENT_BUFFER
          (else
            (call $memcpy
              (call $g2w (local.get $arg4))
              (call $g2w (local.get $arg2))
              (local.get $required))
            (global.set $eax (local.get $required))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  ;; GetFileSecurityA(lpFileName, RequestedInformation, pSecurityDescriptor,
  ;; nLength, lpnLengthNeeded) — 5 args stdcall.
  ;;
  ;; This is a Windows NT API. On the Windows 98 we emulate there is no
  ;; security descriptor on a file at all, and ADVAPI32 answers every call
  ;; with FALSE / ERROR_CALL_NOT_IMPLEMENTED — which is exactly what MFC's
  ;; CFile save-with-backup path expects to see before it skips the ACL copy.
  ;; The export still has to exist: MSPaint reaches it through GetProcAddress,
  ;; and a NULL there turned into RaiseException 0xC06D007F + ExitProcess in
  ;; the middle of File > Save (mfc42 6.00).
  (func $handle_GetFileSecurityA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg4)
      (then (call $gs32 (local.get $arg4) (i32.const 0))))
    (global.set $last_error (i32.const 120)) ;; ERROR_CALL_NOT_IMPLEMENTED
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; CommandLineToArgvW — already handled above as crash stub replacement

  ;; _MyGetFreeSystemResources32@4(dwResType) — 1 arg stdcall, RSRC32.DLL.
  ;;
  ;; The number behind Resource Meter (rsrcmtr.exe) and the Win98 System
  ;; Monitor "System Resources" readout: a percentage, 0..100, of the free
  ;; space in the 16-bit GDI and USER local heaps. dwResType selects which
  ;; heap: 0 = system (Windows reports the lower of the two), 1 = GDI,
  ;; 2 = USER.
  ;;
  ;; We have no 64KB local heaps, but we do have the two fixed-size tables
  ;; those heaps stood for, so report the free share of them. The value then
  ;; moves for the same reason the real one did — objects and windows being
  ;; created and destroyed — instead of being a frozen constant that makes
  ;; every bar in Resource Meter look identical.
  (func $handle__MyGetFreeSystemResources32@4 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $i i32) (local $used i32) (local $gdi i32) (local $user i32)
    ;; GDI: free share of the GDI object table.
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_OBJECT_COUNT)))
      (if (i32.load (i32.add (global.get $GDI_OBJECT_TABLE)
            (i32.mul (local.get $i) (global.get $GDI_OBJECT_STRIDE))))
        (then (local.set $used (i32.add (local.get $used) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.set $gdi (i32.div_u
      (i32.mul (i32.sub (global.get $GDI_OBJECT_COUNT) (local.get $used))
               (i32.const 100))
      (global.get $GDI_OBJECT_COUNT)))
    ;; USER: free share of the window table.
    (local.set $i (i32.const 0))
    (local.set $used (i32.const 0))
    (block $done2 (loop $scan2
      (br_if $done2 (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (if (call $wnd_slot_hwnd (local.get $i))
        (then (local.set $used (i32.add (local.get $used) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan2)))
    (local.set $user (i32.div_u
      (i32.mul (i32.sub (global.get $MAX_WINDOWS) (local.get $used))
               (i32.const 100))
      (global.get $MAX_WINDOWS)))
    (global.set $eax
      (if (result i32) (i32.eq (local.get $arg0) (i32.const 1))
        (then (local.get $gdi))
        (else (if (result i32) (i32.eq (local.get $arg0) (i32.const 2))
          (then (local.get $user))
          (else (select (local.get $gdi) (local.get $user)
                        (i32.lt_u (local.get $gdi) (local.get $user))))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))
