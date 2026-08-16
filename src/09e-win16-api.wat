  ;; ============================================================
  ;; WIN16 API DISPATCH — KERNEL/USER/GDI by module and ordinal
  ;; ============================================================
  ;;
  ;; A 16-bit import is a far call into WIN16_THUNK_SEL, so the thunk offset
  ;; alone names the callee: WIN16_THUNK_TABLE remembers which (module,
  ;; ordinal) pair the loader assigned to that slot. This is the 16-bit twin
  ;; of $win32_dispatch, and it is deliberately the only place a Win16 API is
  ;; recognised.
  ;;
  ;; Calling convention. Win16 is Pascal: arguments are pushed left to right,
  ;; the callee removes them, and the result comes back in AX (DX:AX for a
  ;; long or a far pointer). $th_call_far_imm has already pushed CS:IP, so the
  ;; stack at entry is
  ;;
  ;;     SP+0  IP      SP+2  CS      SP+4  last argument ... first argument
  ;;
  ;; and returning means restoring EIP from the saved CS:IP and dropping both
  ;; plus `argbytes` of arguments.
  ;;
  ;; Unimplemented ordinals trap rather than returning zero, on the same
  ;; reasoning as the 32-bit fail-fast stubs: the crash names the exact call
  ;; that has to be written next, and a silent zero turns that into a hunt.

  ;; Module ids come from $win16_module_id: 1=KERNEL 2=USER 3=GDI 4=KEYBOARD
  ;; 5=SOUND 6=SHELL 7=MMSYSTEM 8=COMMDLG 9=CARDS, 0=unresolved.
  (func $win16_api_key (param $module i32) (param $ordinal i32) (result i32)
    (i32.or (i32.shl (local.get $module) (i32.const 16))
            (i32.and (local.get $ordinal) (i32.const 0xFFFF))))

  ;; Finish a Win16 API call: drop the saved CS:IP and the caller's arguments,
  ;; then resume at the return address. `argbytes` is what the callee removes,
  ;; which under Pascal is every byte the caller pushed.
  (func $win16_api_return (param $argbytes i32)
    (local $ip i32) (local $sel i32)
    (local.set $ip  (call $gl16 (global.get $esp)))
    (local.set $sel (call $gl16 (i32.add (global.get $esp) (i32.const 2))))
    (global.set $esp (i32.add (global.get $esp) (i32.add (i32.const 4) (local.get $argbytes))))
    (call $win16_set_sreg (i32.const 1) (local.get $sel))
    (global.set $eip (i32.add (global.get $seg_base_cs) (local.get $ip)))
    (call $cs_pop))

  ;; Read argument `n` counting from the last one pushed, in words: word 0 is
  ;; the argument nearest the top of the stack, which under Pascal is the
  ;; rightmost parameter.
  (func $win16_arg16 (param $n i32) (result i32)
    (call $gl16 (i32.add (global.get $esp)
                         (i32.add (i32.const 4) (i32.shl (local.get $n) (i32.const 1))))))

  (func $win16_arg32 (param $n i32) (result i32)
    (i32.or (call $win16_arg16 (local.get $n))
            (i32.shl (call $win16_arg16 (i32.add (local.get $n) (i32.const 1))) (i32.const 16))))

  ;; ---- The 16-bit handle space ----
  ;;
  ;; A Win16 handle is sixteen bits. Ours are 32-bit values — 0x00010002 for a
  ;; window, 0x00310001 for a DC, 0x00410007 for a GDI object — and they do
  ;; not fit. Narrowing every allocator in the emulator would put Win16 in the
  ;; path of code that has nothing to do with it, so the two spaces are joined
  ;; here instead: the app is handed a small index, every handle argument is
  ;; widened on the way in, and every handle result is narrowed on the way
  ;; out. Nothing on the 32-bit side learns that Win16 exists.
  ;;
  ;; The index is 1-based so 0 is NULL in both spaces. Translation is a table
  ;; rather than arithmetic on purpose: handles reach the app from several
  ;; allocators with different high words (0x0001 windows, 0x0031 DCs, 0x0041
  ;; GDI objects, 0x0080 menus) plus BeginPaint's hwnd+0x40000 and the stock
  ;; objects, and no bit pattern covers all of them.
  ;;
  ;; The table lives in the one arena slot past the last usable selector, so
  ;; it costs nothing in the WAT-private tables and no far pointer can name it.
  (func $win16_handle_table (result i32)
    (call $g2w (i32.add (global.get $WIN16_ARENA)
                        (i32.mul (global.get $WIN16_SEG_MAX) (i32.const 0x10000)))))

  (func $win16_handle_reset
    (global.set $win16_handle_next (i32.const 0))
    (call $zero_memory (call $win16_handle_table)
      (i32.shl (global.get $WIN16_HANDLE_MAX) (i32.const 2))))

  ;; 16 -> 32. An index the table never handed out is a bug in the translation
  ;; layer, not something to paper over with a zero: it means an API returned a
  ;; raw 32-bit handle, or took one it should have widened.
  (func $win16_h32 (param $h16 i32) (result i32)
    (local.set $h16 (i32.and (local.get $h16) (i32.const 0xFFFF)))
    (if (i32.eqz (local.get $h16)) (then (return (i32.const 0))))
    ;; 0xFFFF is a sentinel in more places than it is a handle (HWND_BROADCAST,
    ;; and the -1 several APIs take), so it passes through sign-extended.
    (if (i32.eq (local.get $h16) (i32.const 0xFFFF)) (then (return (i32.const -1))))
    (if (i32.gt_u (local.get $h16) (global.get $win16_handle_next))
      (then
        (call $host_log_i32 (i32.const 0xCA16A9F3))
        (call $host_log_i32 (local.get $h16))
        (call $host_log_i32 (global.get $win16_handle_next))
        (unreachable)))
    (i32.load (i32.add (call $win16_handle_table)
                       (i32.shl (local.get $h16) (i32.const 2)))))

  ;; 32 -> 16, allocating on first sight. The scan is linear because the table
  ;; holds tens of entries for these apps, not thousands, and a hash would be
  ;; more machinery than the problem has.
  (func $win16_h16 (param $h32 i32) (result i32)
    (local $t i32) (local $i i32)
    (if (i32.eqz (local.get $h32)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $h32) (i32.const -1)) (then (return (i32.const 0xFFFF))))
    (local.set $t (call $win16_handle_table))
    (local.set $i (i32.const 1))
    (block $done (loop $scan
      (br_if $done (i32.gt_u (local.get $i) (global.get $win16_handle_next)))
      (if (i32.eq (i32.load (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 2))))
                  (local.get $h32))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.ge_u (global.get $win16_handle_next) (global.get $WIN16_HANDLE_MAX))
      (then
        (call $host_log_i32 (i32.const 0xCA16A9F4))
        (call $host_log_i32 (local.get $h32))
        (unreachable)))
    (global.set $win16_handle_next (i32.add (global.get $win16_handle_next) (i32.const 1)))
    (i32.store (i32.add (local.get $t)
                        (i32.shl (global.get $win16_handle_next) (i32.const 2)))
               (local.get $h32))
    (global.get $win16_handle_next))

  ;; ---- KERNEL ----

  ;; KERNEL.91 InitTask. The first call every one of these images makes, from
  ;; `xor bp,bp / push bp / call far KERNEL.INITTASK`. The pushed BP is the
  ;; null frame that terminates a stack walk, not an argument, so nothing is
  ;; removed from the stack on the way out.
  ;;
  ;; It answers entirely in registers:
  ;;   AX = 1 for success
  ;;   CX = stack limit in bytes
  ;;   DX = nCmdShow
  ;;   ES:BX = the command line, inside the PSP
  ;;   SI = previous instance, DI = this instance
  ;;
  ;; hInstance is the task's DGROUP selector — in Win16 an instance handle is
  ;; a real selector, not a cookie, and startup code stores this one and later
  ;; hands it back to RegisterClass and CreateWindow.
  (func $win16_InitTask
    (local $psp i32) (local $base i32)
    (if (i32.eqz (global.get $win16_psp_sel))
      (then
        (local.set $psp (call $win16_alloc_segment))
        (global.set $win16_psp_sel (call $win16_index_to_sel (local.get $psp)))
        (local.set $base (call $win16_seg_base (local.get $psp)))
        ;; DOS command-line block: a length byte at 0x80, the text at 0x81, and
        ;; a carriage return closing it. An empty command line is still a
        ;; well-formed one, and the startup code does parse this.
        (call $gs8 (i32.add (local.get $base) (i32.const 0x80)) (i32.const 0))
        (call $gs8 (i32.add (local.get $base) (i32.const 0x81)) (i32.const 0x0D))))

    (global.set $eax (i32.const 1))
    (global.set $ecx (global.get $win16_stack_size))
    (global.set $edx (i32.const 1))   ;; SW_SHOWNORMAL
    (global.set $ebx (i32.const 0x81))
    (global.set $esi (i32.const 0))   ;; no previous instance
    (global.set $edi (global.get $sreg_ds))
    (call $win16_set_sreg (i32.const 0) (global.get $win16_psp_sel))
    (call $win16_api_return (i32.const 0)))

  ;; KERNEL.3 GetVersion. AL:AH is the Windows version and DX the DOS one.
  ;; Reporting 3.10 rather than what Windows 98 reports is deliberate: these
  ;; are Windows 3.x images, and 3.10 is the version they were built against
  ;; and test for. Raising it is a change to make when an app asks for it.
  (func $win16_GetVersion
    (global.set $eax (i32.const 0x0A03))  ;; AL=3 major, AH=10 minor
    (global.set $edx (i32.const 0x070A))  ;; DH=7 major, DL=10 minor
    (call $win16_api_return (i32.const 0)))

  ;; KERNEL.30 WaitEvent(HTASK). Yields until the task has a message. With one
  ;; task and a message queue that is always ready to be asked, there is
  ;; nothing to wait for and returning immediately is the honest answer.
  (func $win16_WaitEvent
    (global.set $eax (i32.const 0))
    (call $win16_api_return (i32.const 2)))

  ;; Returns 1 if the ordinal was handled. Splitting per module keeps each
  ;; dispatcher a flat run of ordinals in numeric order.
  (func $win16_kernel (param $ordinal i32) (result i32)
    (if (i32.eq (local.get $ordinal) (i32.const 3))
      (then (call $win16_GetVersion) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 30))
      (then (call $win16_WaitEvent) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 91))
      (then (call $win16_InitTask) (return (i32.const 1))))
    (i32.const 0))

  ;; ---- USER ----

  ;; USER.5 InitApp(hInstance). Creates the task's message queue. Ours is
  ;; implicit — GetMessage answers from emulator state rather than from a
  ;; queue the app allocated — so there is nothing to build, and success is
  ;; the truthful answer rather than a placeholder.
  (func $win16_InitApp
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 2)))

  ;; USER.15 GetCurrentTime(). Milliseconds since Windows started — the same
  ;; clock GetTickCount reads, which is what it became in Win32. A DWORD comes
  ;; back in DX:AX, the Win16 convention for a 32-bit result.
  (func $win16_GetCurrentTime
    (global.set $tick_count (call $host_get_ticks))
    (global.set $eax (i32.and (global.get $tick_count) (i32.const 0xFFFF)))
    (global.set $edx (i32.shr_u (global.get $tick_count) (i32.const 16)))
    (call $win16_api_return (i32.const 0)))

  ;; USER.176 LoadString(hInstance, id, lpBuffer, nBufferMax) -> length.
  ;;
  ;; String resources come in blocks of sixteen. The resource holding string
  ;; `id` is RT_STRING number `(id >> 4) + 1`, and inside it the strings are
  ;; sixteen Pascal strings back to back, present or not — a zero length is a
  ;; string that was never defined, and the block still has to be walked past
  ;; it. That packing is why a Win16 app's string ids cluster.
  ;;
  ;;   arg 4 hInstance   3 id   2:1 lpBuffer (seg:off)   0 nBufferMax
  (func $win16_LoadString
    (local $id i32) (local $max i32) (local $dst i32)
    (local $p i32) (local $end i32) (local $i i32) (local $len i32) (local $n i32)
    (local.set $id  (call $win16_arg16 (i32.const 3)))
    (local.set $max (call $win16_arg16 (i32.const 0)))
    (local.set $dst (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))

    (global.set $eax (i32.const 0))
    (local.set $p (call $win16_find_resource (i32.const 6)
      (i32.add (i32.shr_u (local.get $id) (i32.const 4)) (i32.const 1))))
    (if (local.get $p)
      (then
        (local.set $end (i32.add (local.get $p) (global.get $win16_res_len)))
        (local.set $i (i32.const 0))
        (block $found (loop $walk
          (br_if $found (i32.ge_u (local.get $i) (i32.const 16)))
          (br_if $found (i32.ge_u (local.get $p) (local.get $end)))
          (local.set $len (i32.load8_u (local.get $p)))
          (if (i32.eq (local.get $i) (i32.and (local.get $id) (i32.const 15)))
            (then
              ;; Copy at most nBufferMax-1 bytes and always NUL-terminate, which
              ;; is what the caller's buffer is sized for.
              (local.set $n (local.get $len))
              (if (i32.ge_u (local.get $n) (local.get $max))
                (then (local.set $n (i32.sub (local.get $max) (i32.const 1)))))
              (if (i32.lt_s (local.get $n) (i32.const 0)) (then (local.set $n (i32.const 0))))
              (call $memcpy (call $g2w (local.get $dst))
                (i32.add (local.get $p) (i32.const 1)) (local.get $n))
              (call $gs8 (i32.add (local.get $dst) (local.get $n)) (i32.const 0))
              (global.set $eax (local.get $n))
              (br $found)))
          (local.set $p (i32.add (i32.add (local.get $p) (i32.const 1)) (local.get $len)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $walk)))))
    (call $win16_api_return (i32.const 10)))

  ;; USER.66 GetDC(hWnd) -> HDC, USER.68 ReleaseDC(hWnd, hDC).
  ;;
  ;; These go straight to the same host primitives $handle_GetDC uses. A Win16
  ;; app asking for a DC wants exactly what a Win32 one wants; all that differs
  ;; is the width of the handles either side, which is what $win16_h16/$win16_h32
  ;; are for. GetDC(NULL) is the screen DC in both worlds.
  (func $win16_GetDC
    (local $hwnd i32) (local $hdc i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (if (local.get $hwnd)
      (then
        (local.set $hdc (call $host_alloc_window_dc (local.get $hwnd) (i32.const 0)))
        (call $dc_apply_client_clip (local.get $hdc) (local.get $hwnd)))
      (else (local.set $hdc (call $host_alloc_screen_dc))))
    (global.set $eax (call $win16_h16 (local.get $hdc)))
    (call $win16_api_return (i32.const 2)))

  (func $win16_ReleaseDC
    (drop (call $host_release_dc (call $win16_h32 (call $win16_arg16 (i32.const 0)))))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 4)))

  ;; A Win16 resource argument is a far pointer. MAKEINTRESOURCE puts the id in
  ;; the offset and leaves the selector zero; a real name is a pointer to a
  ;; string. Returns the integer id, or -1 for a name — the NE resource walker
  ;; addresses types and ids by number, and a name is a gap worth seeing rather
  ;; than a failure to swallow.
  (func $win16_res_arg (param $n i32) (result i32)
    (if (call $win16_arg16 (i32.add (local.get $n) (i32.const 1)))
      (then (return (i32.const -1))))
    (call $win16_arg16 (local.get $n)))

  ;; USER.179 GetSystemMetrics(nIndex). Same indices, same answers as Win32 —
  ;; see $system_metric in 09a-handlers.wat.
  (func $win16_GetSystemMetrics
    (global.set $eax (call $system_metric (call $win16_arg16 (i32.const 0))))
    (call $win16_api_return (i32.const 2)))

  ;; USER.175 LoadBitmap(hInstance, lpBitmapName) -> HBITMAP.
  ;;
  ;; RT_BITMAP in an NE file is a DIB with no file header, which is exactly
  ;; what $gdi_bitmap_create_resource already parses for the Win32 side; only
  ;; the walk that finds the bytes differs.
  (func $win16_LoadBitmap
    (local $id i32) (local $data i32)
    (local.set $id (call $win16_res_arg (i32.const 0)))
    (global.set $eax (i32.const 0))
    (if (i32.ne (local.get $id) (i32.const -1))
      (then
        (local.set $data (call $win16_find_resource (i32.const 2) (local.get $id)))
        (if (local.get $data)
          (then (global.set $eax (call $win16_h16 (call $gdi_bitmap_create_resource
                  (local.get $data) (global.get $win16_res_len))))))))
    (call $win16_api_return (i32.const 6)))

  ;; USER.174 LoadIcon(hInstance, lpIconName) -> HICON.
  ;;
  ;; The handle is opaque: it identifies the resource for a later DrawIcon, and
  ;; nothing decodes NE icon pixels yet. That is the same answer the Win32 path
  ;; gives for an icon it cannot intern, and it is enough for the overwhelmingly
  ;; common use — handing the icon straight to RegisterClass.
  (func $win16_LoadIcon
    (local $id i32)
    (local.set $id (call $win16_res_arg (i32.const 0)))
    (global.set $eax (i32.const 0))
    (if (i32.ne (local.get $id) (i32.const -1))
      (then (global.set $eax (call $win16_h16 (i32.const 0x60001)))))
    (call $win16_api_return (i32.const 6)))

  (func $win16_user (param $ordinal i32) (result i32)
    (if (i32.eq (local.get $ordinal) (i32.const 174))
      (then (call $win16_LoadIcon) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 175))
      (then (call $win16_LoadBitmap) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 179))
      (then (call $win16_GetSystemMetrics) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 66))
      (then (call $win16_GetDC) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 68))
      (then (call $win16_ReleaseDC) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 5))
      (then (call $win16_InitApp) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 15))
      (then (call $win16_GetCurrentTime) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 176))
      (then (call $win16_LoadString) (return (i32.const 1))))
    (i32.const 0))

  ;; The result half of --trace-win16, emitted once the handler has run. DX:AX
  ;; is logged whole because a Win16 DWORD result arrives split across the two.
  (func $win16_trace_ret
    (if (global.get $win16_trace)
      (then
        (call $host_log_i32 (i32.const 0xCA16A9EF))
        (call $host_log_i32 (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (call $host_log_i32 (i32.and (global.get $edx) (i32.const 0xFFFF))))))

  ;; The dispatcher. $thunk_off is the offset within WIN16_THUNK_SEL that the
  ;; loader wrote into the fixup; $ret_lin is the linear return address, which
  ;; is already on the stack and is passed only so a trap can name it.
  (func $win16_dispatch (export "win16_dispatch") (param $thunk_off i32) (param $ret_lin i32)
    (local $module i32) (local $ordinal i32)
    (local.set $module  (call $win16_thunk_module  (local.get $thunk_off)))
    (local.set $ordinal (call $win16_thunk_ordinal (local.get $thunk_off)))
    (global.set $win16_last_module (local.get $module))
    (global.set $win16_last_ordinal (local.get $ordinal))
    (global.set $win16_last_is_name (call $win16_thunk_is_name (local.get $thunk_off)))

    ;; --trace-win16 logs every call before it runs, with the six words nearest
    ;; the top of the stack. Which of those are arguments depends on the callee,
    ;; so they are printed raw: an unlabelled window into the Pascal frame beats
    ;; a guess at how to label it, and it is what tells LoadBitmap-returned-zero
    ;; apart from LoadBitmap-was-never-asked. Six words covers every API here
    ;; with a fixed argument list — LoadString's five, and one spare to show
    ;; where the frame ends.
    (if (global.get $win16_trace)
      (then
        (call $host_log_i32 (i32.const 0xCA16A9F0))
        (call $host_log_i32 (call $win16_api_key (local.get $module) (local.get $ordinal)))
        (call $host_log_i32 (local.get $ret_lin))
        (call $host_log_i32 (call $win16_arg16 (i32.const 0)))
        (call $host_log_i32 (call $win16_arg16 (i32.const 1)))
        (call $host_log_i32 (call $win16_arg16 (i32.const 2)))
        (call $host_log_i32 (call $win16_arg16 (i32.const 3)))
        (call $host_log_i32 (call $win16_arg16 (i32.const 4)))
        (call $host_log_i32 (call $win16_arg16 (i32.const 5)))))

    ;; A name import has no ordinal to dispatch on. Resolving one means loading
    ;; the exporting module and reading its export table — CARDS.DLL is right
    ;; there in the test binaries and FREECELL wants three entry points from
    ;; it — but that is NE DLL loading, which does not exist yet. Report the
    ;; name so the trap says CARDS.CDTINIT rather than a number.
    (if (call $win16_thunk_is_name (local.get $thunk_off))
      (then
        (call $host_log_i32 (i32.const 0xCA16A9F2))
        (call $host_log_i32 (call $win16_api_key (local.get $module) (local.get $ordinal)))
        (call $host_log_i32 (local.get $ret_lin))
        (call $host_log_i32 (call $win16_thunk_name_addr (local.get $thunk_off)))
        (unreachable)))

    (if (i32.eq (local.get $module) (i32.const 1))
      (then (if (call $win16_kernel (local.get $ordinal))
              (then (call $win16_trace_ret) (return)))))
    (if (i32.eq (local.get $module) (i32.const 2))
      (then (if (call $win16_user (local.get $ordinal))
              (then (call $win16_trace_ret) (return)))))

    ;; Anything not implemented reports itself and stops, on the same reasoning
    ;; as the 32-bit fail-fast stubs. The three logs are the marker, the packed
    ;; module/ordinal, and where the call came from — test/run.js turns them
    ;; into a name, so the next API to write is the one the crash prints.
    (call $host_log_i32 (i32.const 0xCA16A9F1))
    (call $host_log_i32 (call $win16_api_key (local.get $module) (local.get $ordinal)))
    (call $host_log_i32 (local.get $ret_lin))
    (unreachable))

  (func (export "set_win16_trace") (param $on i32) (global.set $win16_trace (local.get $on)))
  (func (export "win16_last_module") (result i32) (global.get $win16_last_module))
  (func (export "win16_last_ordinal") (result i32) (global.get $win16_last_ordinal))
  (func (export "win16_last_is_name") (result i32) (global.get $win16_last_is_name))
  (func (export "win16_res_len") (result i32) (global.get $win16_res_len))
