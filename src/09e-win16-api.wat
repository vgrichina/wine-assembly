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

  ;; ---- Calling the 32-bit handler for the same API ----
  ;;
  ;; Most of Win16 is Win32 with narrower arguments. GetDeviceCaps answers the
  ;; same forty-odd indices, GetObject fills the same structures, CreateWindow
  ;; builds the same window. Reimplementing each of those beside its Win32 twin
  ;; would double the number of places a behaviour lives, so instead the Win16
  ;; side widens its arguments and calls straight into $handle_*.
  ;;
  ;; Those handlers read their first five arguments as parameters and any
  ;; further ones from the guest stack, and each pops its own frame — so this
  ;; builds a stdcall frame on a scratch stack, calls in, and throws the
  ;; scratch pointer away afterwards rather than trying to track what the
  ;; handler did to it. The scratch stack is the 32-bit task's main guest
  ;; stack, which a 16-bit task never touches.
  ;;
  ;; This is only for handlers that return normally. One that redirects EIP to
  ;; guest code — SendMessage, DispatchMessage — would resume with a 32-bit
  ;; frame and a 16-bit task, so those get their own Win16 implementations.
  (func $win16_call32_begin (param $argc i32)
    (global.set $win16_esp_save (global.get $esp))
    (global.set $win16_eip_save (global.get $eip))
    (global.set $esp (i32.sub (i32.add (global.get $GUEST_STACK) (global.get $GUEST_STACK_SIZE))
                              (i32.shl (i32.add (local.get $argc) (i32.const 1)) (i32.const 2))))
    (call $gs32 (global.get $esp) (i32.const 0)))   ;; return address the handler will pop

  (func $win16_call32_arg (param $i i32) (param $val i32)
    (call $gs32 (i32.add (global.get $esp)
                         (i32.add (i32.const 4) (i32.shl (local.get $i) (i32.const 2))))
                (local.get $val)))

  ;; A handler that moved EIP has redirected into guest code with a 32-bit
  ;; frame — the one thing this bridge cannot carry into a 16-bit task, since
  ;; resuming there runs the wrong calling convention on a scratch stack that
  ;; is about to be thrown away. Say so here rather than let the task wander
  ;; into unmapped memory a few thousand instructions later; the fix is always
  ;; to write that API out for Win16, as ShowWindow already is.
  ;; Did the handler redirect into guest code? Restores the task's own EIP and
  ;; ESP either way, so the caller can decide what to do about it instead of
  ;; stopping. Only CreateWindow needs this: its redirect is WM_CREATE, which
  ;; a 16-bit task can be given through its own message queue.
  (func $win16_call32_end_redirected (result i32)
    (local $moved i32)
    (local.set $moved (i32.ne (global.get $eip) (global.get $win16_eip_save)))
    (global.set $eip (global.get $win16_eip_save))
    (global.set $esp (global.get $win16_esp_save))
    (local.get $moved))

  ;; A blocking handler yields instead of returning: it leaves its frame on the
  ;; stack, raises $yield_reason, and expects the host to re-enter it at the
  ;; same thunk when the wait is satisfied. That contract cannot survive this
  ;; bridge — the frame it left is on a scratch stack about to be discarded,
  ;; and the host's resume path pops a 32-bit stdcall frame and takes a linear
  ;; return address off the *task's* stack. Minesweeper idled in GetMessage,
  ;; the host resumed it that way, and it returned to two words of its own
  ;; WNDCLASS read as an address.
  ;;
  ;; So the wait is cancelled here and the caller decides what "nothing to
  ;; report" means for its API. $yield_flag stays raised: ending the batch is
  ;; still the right thing, it is only the blocking resume that is wrong.
  (func $win16_call32_waited (result i32)
    (local $waiting i32)
    (local.set $waiting (i32.or
      (i32.eq (global.get $yield_reason) (i32.const 1))
      (i32.or (i32.eq (global.get $yield_reason) (i32.const 5))
      (i32.or (i32.eq (global.get $yield_reason) (i32.const 7))
              (i32.eq (global.get $yield_reason) (i32.const 8))))))
    (if (local.get $waiting) (then (global.set $yield_reason (i32.const 0))))
    (local.get $waiting))

  (func $win16_call32_end
    (drop (call $win16_call32_waited))
    (if (i32.ne (global.get $eip) (global.get $win16_eip_save))
      (then
        (call $host_log_i32 (i32.const 0xCA16A9F7))
        (call $host_log_i32 (global.get $win16_last_module))
        (call $host_log_i32 (global.get $win16_last_ordinal))
        (call $host_log_i32 (global.get $eip))
        (unreachable)))
    (global.set $esp (global.get $win16_esp_save)))

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

  ;; KERNEL.127 GetPrivateProfileInt(lpAppName, lpKeyName, nDefault, lpFileName)
  ;; and its two siblings. Every argument is a far pointer or a word, and the
  ;; INI machinery underneath is shared with the 32-bit side.
  (func $win16_GetPrivateProfileInt
    (local $app i32) (local $key i32) (local $def i32) (local $file i32)
    (local.set $app (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 6)) (call $win16_arg16 (i32.const 5))))
    (local.set $key (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 4)) (call $win16_arg16 (i32.const 3))))
    (local.set $def (call $win16_coord (call $win16_arg16 (i32.const 2))))
    (local.set $file (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_GetPrivateProfileIntA (local.get $app) (local.get $key)
      (local.get $def) (local.get $file) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 14)))

  (func $win16_GetPrivateProfileString
    (local $app i32) (local $key i32) (local $def i32) (local $buf i32)
    (local $size i32) (local $file i32)
    (local.set $app (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 10)) (call $win16_arg16 (i32.const 9))))
    (local.set $key (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 8)) (call $win16_arg16 (i32.const 7))))
    (local.set $def (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 6)) (call $win16_arg16 (i32.const 5))))
    (local.set $buf (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 4)) (call $win16_arg16 (i32.const 3))))
    (local.set $size (call $win16_arg16 (i32.const 2)))
    (local.set $file (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 6))
    (call $win16_call32_arg (i32.const 5) (local.get $file))
    (call $handle_GetPrivateProfileStringA (local.get $app) (local.get $key)
      (local.get $def) (local.get $buf) (local.get $size) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 22)))

  (func $win16_WritePrivateProfileString
    (local $app i32) (local $key i32) (local $val i32) (local $file i32)
    (local.set $app (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 7)) (call $win16_arg16 (i32.const 6))))
    (local.set $key (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 5)) (call $win16_arg16 (i32.const 4))))
    (local.set $val (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 3)) (call $win16_arg16 (i32.const 2))))
    (local.set $file (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_WritePrivateProfileStringA (local.get $app) (local.get $key)
      (local.get $val) (local.get $file) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 16)))

  ;; KERNEL.88 lstrcpy / KERNEL.89 lstrcat(lpString1, lpString2) -> lpString1,
  ;; and KERNEL.90 lstrlen(lpString).
  ;;
  ;; Written out rather than bridged: $handle_lstrcpyA and friends all funnel
  ;; into $dispatch_lstr, which decides what to do by looking at the API *name*
  ;; it was dispatched under. The bridge has no name to give it, so it would
  ;; fall through — and these are three lines of pointer walking anyway.
  (func $win16_lstr_len (param $s i32) (result i32)
    (local $n i32)
    (block $done (loop $walk
      (br_if $done (i32.eqz (call $gl8 (i32.add (local.get $s) (local.get $n)))))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br $walk)))
    (local.get $n))

  (func $win16_lstr (param $is_cat i32)
    (local $dst i32) (local $src i32) (local $i i32) (local $ch i32)
    (local.set $dst (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 3)) (call $win16_arg16 (i32.const 2))))
    (local.set $src (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (if (local.get $is_cat)
      (then (local.set $dst (i32.add (local.get $dst)
              (call $win16_lstr_len (local.get $dst))))))
    (block $done (loop $copy
      (local.set $ch (call $gl8 (i32.add (local.get $src) (local.get $i))))
      (call $gs8 (i32.add (local.get $dst) (local.get $i)) (local.get $ch))
      (br_if $done (i32.eqz (local.get $ch)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (global.set $edx (call $win16_arg16 (i32.const 3)))
    (global.set $eax (call $win16_arg16 (i32.const 2)))
    (call $win16_api_return (i32.const 8)))

  (func $win16_lstrlen
    (global.set $eax (call $win16_lstr_len (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0)))))
    (call $win16_api_return (i32.const 4)))

  ;; ---- Resources ----
  ;;
  ;; The three calls are a pipeline: FindResource names one, LoadResource
  ;; brings it in, LockResource hands back a pointer to the bytes. Here the
  ;; first two are bookkeeping — the resource never leaves the staged file
  ;; until it is locked — so both answer with a handle that is just the packed
  ;; type and id, and the copy happens once, in LockResource.
  (func $win16_res_key (param $type i32) (param $id i32) (result i32)
    (i32.or (i32.shl (local.get $type) (i32.const 16)) (local.get $id)))

  ;; KERNEL.60 FindResource(hInstance, lpName, lpType).
  (func $win16_FindResource
    (local $type i32) (local $id i32)
    (local.set $type (call $win16_res_arg (i32.const 0)))
    (local.set $id (call $win16_res_arg (i32.const 2)))
    (global.set $eax (i32.const 0))
    (if (i32.and (i32.ne (local.get $type) (i32.const -1))
                 (i32.ne (local.get $id) (i32.const -1)))
      (then
        (if (call $win16_find_resource (local.get $type) (local.get $id))
          (then (global.set $eax (call $win16_h16
            (call $win16_res_key (local.get $type) (local.get $id))))))))
    (call $win16_api_return (i32.const 10)))

  ;; KERNEL.61 LoadResource(hInstance, hResInfo) — nothing to load yet.
  (func $win16_LoadResource
    (global.set $eax (call $win16_arg16 (i32.const 0)))
    (call $win16_api_return (i32.const 4)))

  ;; KERNEL.62 LockResource(hResData) -> far pointer.
  ;;
  ;; This is where the bytes finally have to become addressable by a 16-bit
  ;; pointer, so they are copied out of the staged file into a fresh selector.
  ;; A second lock of the same resource gets a second copy: these are read-only
  ;; and locked a handful of times per run, so a cache would be more machinery
  ;; than the saving is worth.
  (func $win16_LockResource
    (local $key i32) (local $data i32) (local $len i32) (local $seg i32)
    (local.set $key (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $edx (i32.const 0))
    (if (local.get $key)
      (then
        (local.set $data (call $win16_find_resource
          (i32.shr_u (local.get $key) (i32.const 16))
          (i32.and (local.get $key) (i32.const 0xFFFF))))
        (local.set $len (global.get $win16_res_len))
        (if (i32.and (i32.ne (local.get $data) (i32.const 0))
                     (i32.le_u (local.get $len) (i32.const 0x10000)))
          (then
            (local.set $seg (call $win16_alloc_segment))
            (call $memcpy (call $g2w (call $win16_seg_base (local.get $seg)))
              (local.get $data) (local.get $len))
            (global.set $edx (call $win16_index_to_sel (local.get $seg)))))))
    (call $win16_api_return (i32.const 2)))

  ;; ---- Modules ----

  ;; KERNEL.49 GetModuleFileName(hModule, lpFileName, nSize). The buffer holds
  ;; bytes in both worlds, so it is filled in place.
  (func $win16_GetModuleFileName
    (local $buf i32) (local $size i32)
    (local.set $buf (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $size (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 3))
    (call $handle_GetModuleFileNameA (i32.const 0) (local.get $buf) (local.get $size)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 8)))

  ;; ---- The local heap ----
  ;;
  ;; A Win16 local handle is a near pointer: an offset within the task's own
  ;; data segment, which is why LocalAlloc can only ever hand out 64KB and why
  ;; LocalLock is free. The loader already grew DGROUP by the heap size the NE
  ;; header asked for, so the heap is that growth, and a handle is the offset
  ;; of the block. Each block carries its size in the two bytes before it, so
  ;; LocalSize and LocalReAlloc have something to read.
  ;;
  ;; Freed blocks are not reused. These apps allocate a handful of structures
  ;; at startup and keep them, and a real free list is worth writing when
  ;; something actually churns.
  (func $win16_LocalAlloc
    (local $bytes i32) (local $h i32)
    (local.set $bytes (i32.and (i32.add (call $win16_arg16 (i32.const 0)) (i32.const 1))
                               (i32.const 0xFFFE)))
    (local.set $h (i32.add (global.get $win16_lheap_ptr) (i32.const 2)))
    (if (i32.gt_u (i32.add (local.get $h) (local.get $bytes)) (global.get $win16_lheap_end))
      (then
        (global.set $eax (i32.const 0))
        (call $win16_api_return (i32.const 4))
        (return)))
    (call $gs16 (i32.add (global.get $seg_base_ds) (global.get $win16_lheap_ptr))
      (local.get $bytes))
    (global.set $win16_lheap_ptr (i32.add (local.get $h) (local.get $bytes)))
    ;; LMEM_ZEROINIT is the common flag and zeroing unconditionally is both
    ;; cheap and what every caller here expects of fresh memory.
    (call $zero_memory (call $g2w (i32.add (global.get $seg_base_ds) (local.get $h)))
      (local.get $bytes))
    (global.set $eax (local.get $h))
    (call $win16_api_return (i32.const 4)))

  (func $win16_LocalSize
    (global.set $eax (call $gl16 (i32.sub
      (i32.add (global.get $seg_base_ds) (call $win16_arg16 (i32.const 0)))
      (i32.const 2))))
    (call $win16_api_return (i32.const 2)))

  ;; LocalLock, LocalUnlock, LocalFree and LocalCompact on a fixed block: the
  ;; handle is already the pointer, nothing moves, and freeing returns NULL to
  ;; say it succeeded.
  (func $win16_local_identity (param $argbytes i32) (param $result i32)
    (global.set $eax (local.get $result))
    (call $win16_api_return (local.get $argbytes)))

  (func $win16_kernel (param $ordinal i32) (result i32)
    (if (i32.eq (local.get $ordinal) (i32.const 5))
      (then (call $win16_LocalAlloc) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 7))    ;; LocalFree -> NULL
      (then (call $win16_local_identity (i32.const 2) (i32.const 0)) (return (i32.const 1))))
    (if (i32.or (i32.eq (local.get $ordinal) (i32.const 8))    ;; LocalLock
                (i32.eq (local.get $ordinal) (i32.const 23)))  ;; LockSegment
      (then (call $win16_local_identity (i32.const 2)
              (call $win16_arg16 (i32.const 0))) (return (i32.const 1))))
    (if (i32.or (i32.eq (local.get $ordinal) (i32.const 9))    ;; LocalUnlock
                (i32.eq (local.get $ordinal) (i32.const 24)))  ;; UnlockSegment
      (then (call $win16_local_identity (i32.const 2) (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 10))
      (then (call $win16_LocalSize) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 13))   ;; LocalCompact
      (then (call $win16_local_identity (i32.const 2)
              (i32.sub (global.get $win16_lheap_end) (global.get $win16_lheap_ptr)))
            (return (i32.const 1))))
    ;; GetWinFlags / __WinFlags: WF_STANDARD | WF_PMODE | WF_80x87 absent,
    ;; WF_ENHANCED (0x0020) and WF_CPU386 (0x0004) is what a 386 in enhanced
    ;; mode reports, which is what these apps are written for.
    (if (i32.or (i32.eq (local.get $ordinal) (i32.const 132))
                (i32.eq (local.get $ordinal) (i32.const 178)))
      (then
        (global.set $eax (i32.const 0x0025))
        (global.set $edx (i32.const 0))
        (call $win16_api_return (i32.const 0))
        (return (i32.const 1))))
    ;; GetCurrentTask answers with the task's own DGROUP selector, which is
    ;; what an hTask is here; MakeProcInstance hands back the far pointer it
    ;; was given, because with one data segment there is no thunk to build.
    (if (i32.eq (local.get $ordinal) (i32.const 36))
      (then (call $win16_local_identity (i32.const 0) (global.get $sreg_ds))
            (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 51))
      (then
        (global.set $edx (call $win16_arg16 (i32.const 2)))
        (global.set $eax (call $win16_arg16 (i32.const 1)))
        (call $win16_api_return (i32.const 6))
        (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 52))   ;; FreeProcInstance
      (then (call $win16_local_identity (i32.const 4) (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 107))  ;; SetErrorMode
      (then (call $win16_local_identity (i32.const 2) (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 127))
      (then (call $win16_GetPrivateProfileInt) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 128))
      (then (call $win16_GetPrivateProfileString) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 129))
      (then (call $win16_WritePrivateProfileString) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 88))
      (then (call $win16_lstr (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 89))
      (then (call $win16_lstr (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 90))
      (then (call $win16_lstrlen) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 60))
      (then (call $win16_FindResource) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 61))
      (then (call $win16_LoadResource) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 62))
      (then (call $win16_LockResource) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 63))   ;; FreeResource
      (then (call $win16_local_identity (i32.const 2) (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 49))
      (then (call $win16_GetModuleFileName) (return (i32.const 1))))
    ;; GetModuleHandle answers with the task's own module, which here is its
    ;; DGROUP selector; GetProcAddress and LoadLibrary are asked about modules
    ;; nothing has loaded, and zero is the answer Windows gives for those.
    (if (i32.eq (local.get $ordinal) (i32.const 47))
      (then (call $win16_local_identity (i32.const 4) (global.get $sreg_ds))
            (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 50))
      (then
        (global.set $edx (i32.const 0))
        (call $win16_local_identity (i32.const 6) (i32.const 0))
        (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 95))   ;; LoadLibrary
      (then (call $win16_local_identity (i32.const 4) (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 96))   ;; FreeLibrary
      (then (call $win16_local_identity (i32.const 2) (i32.const 0)) (return (i32.const 1))))
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

  ;; USER.67 GetWindowDC(hWnd) — the whole window, frame included, which is
  ;; what the `whole` flag on the host DC means.
  (func $win16_GetWindowDC
    (local $hwnd i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (global.set $eax (call $win16_h16
      (call $host_alloc_window_dc (local.get $hwnd) (i32.const 1))))
    (call $win16_api_return (i32.const 2)))

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

  ;; USER.286 GetDesktopWindow(). The desktop is 0x10000 on the 32-bit side and
  ;; goes through the handle map like any other window.
  (func $win16_GetDesktopWindow
    (global.set $eax (call $win16_h16 (i32.const 0x10000)))
    (call $win16_api_return (i32.const 0)))

  ;; USER.1 MessageBox(hWnd, lpText, lpCaption, wType).
  ;; Arguments are read into locals before $win16_call32_begin moves ESP —
  ;; $win16_arg16 addresses the task's own frame, which is exactly what the
  ;; scratch stack replaces.
  (func $win16_MessageBox
    (local $hwnd i32) (local $text i32) (local $caption i32) (local $type i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 5))))
    (local.set $text (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 4)) (call $win16_arg16 (i32.const 3))))
    (local.set $caption (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $type (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_MessageBoxA
      (local.get $hwnd) (local.get $text) (local.get $caption) (local.get $type)
      (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (call $win16_api_return (i32.const 12)))

  (func $win16_user (param $ordinal i32) (result i32)
    (if (i32.eq (local.get $ordinal) (i32.const 18))
      (then (call $win16_hwnd_query (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 19))
      (then (call $win16_ReleaseCapture) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 22))
      (then (call $win16_hwnd_query (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 23))
      (then (call $win16_GetFocus) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 31))
      (then (call $win16_hwnd_query (i32.const 3)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 34))
      (then (call $win16_EnableWindow) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 37))
      (then (call $win16_SetWindowText) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 46))
      (then (call $win16_hwnd_query (i32.const 2)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 49))
      (then (call $win16_hwnd_query (i32.const 4)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 56))
      (then (call $win16_MoveWindow) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 85))
      (then (call $win16_DrawText) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 102))
      (then (call $win16_adjust_window_rect (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 104))
      (then (call $win16_word_query (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 106))
      (then (call $win16_word_query (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 109))
      (then (call $win16_PeekMessage) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 145))
      (then (call $win16_RegisterClipboardFormat) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 154))
      (then (call $win16_menu_item (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 155))
      (then (call $win16_menu_item (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 157))
      (then (call $win16_hwnd_query (i32.const 5)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 160))
      (then (call $win16_hwnd_query (i32.const 6)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 177))
      (then (call $win16_LoadAccelerators) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 178))
      (then (call $win16_TranslateAccelerator) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 454))
      (then (call $win16_adjust_window_rect (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 420))
      (then (call $win16_wsprintf) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 483))
      (then (call $win16_SystemParametersInfo) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 10))
      (then (call $win16_SetTimer) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 12))
      (then (call $win16_KillTimer) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 32))
      (then (call $win16_get_rect (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 33))
      (then (call $win16_get_rect (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 39))
      (then (call $win16_BeginPaint) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 40))
      (then (call $win16_EndPaint) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 53))
      (then (call $win16_DestroyWindow) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 81))
      (then (call $win16_FillRect) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 110))
      (then (call $win16_PostMessage) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 118))
      (then (call $win16_RegisterWindowMessage) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 125))
      (then (call $win16_InvalidateRect) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 150))
      (then (call $win16_LoadMenu) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 158))
      (then (call $win16_SetMenu) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 180))
      (then (call $win16_GetSysColor) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 6))
      (then (call $win16_PostQuitMessage) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 67))
      (then (call $win16_GetWindowDC) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 72))
      (then (call $win16_SetRect) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 74))
      (then (call $win16_CopyRect) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 76))
      (then (call $win16_PtInRect) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 78))
      (then (call $win16_InflateRect) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 79))
      (then (call $win16_IntersectRect) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 84))
      (then (call $win16_DrawIcon) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 171))
      (then (call $win16_WinHelp) (return (i32.const 1))))
    ;; SetCursor answers with the cursor it replaced, and the renderer draws
    ;; the host cursor either way; ShowCursor keeps the display count Windows
    ;; keeps, which apps do read back.
    (if (i32.eq (local.get $ordinal) (i32.const 69))
      (then (call $win16_local_identity (i32.const 2)
              (call $win16_arg16 (i32.const 0))) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 71))
      (then
        (global.set $win16_cursor_count (i32.add (global.get $win16_cursor_count)
          (select (i32.const 1) (i32.const -1) (call $win16_arg16 (i32.const 0)))))
        (call $win16_local_identity (i32.const 2)
          (i32.and (global.get $win16_cursor_count) (i32.const 0xFFFF)))
        (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 452))
      (then (call $win16_CreateWindow (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 41))
      (then (call $win16_CreateWindow (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 42))
      (then (call $win16_ShowWindow) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 57))
      (then (call $win16_RegisterClass) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 107))
      (then (call $win16_DefWindowProc) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 108))
      (then (call $win16_GetMessage) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 113))
      (then (call $win16_TranslateMessage) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 114))
      (then (call $win16_DispatchMessage) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 124))
      (then (call $win16_UpdateWindow) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 173))
      (then (call $win16_LoadCursor) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 1))
      (then (call $win16_MessageBox) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 286))
      (then (call $win16_GetDesktopWindow) (return (i32.const 1))))
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

  ;; ---- Windows ----

  (func $win16_push16 (param $v i32)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 2)))
    (call $gs16 (global.get $esp) (local.get $v)))

  ;; Enter a 16-bit window procedure.
  ;;
  ;; The Pascal frame is hWnd, message, wParam, lParam, and the far return
  ;; address pushed under it is the *caller's own* — so when the procedure
  ;; RETFs 10 it lands wherever DispatchMessage was going to return anyway,
  ;; carrying its result in DX:AX. A Win16 window procedure returns exactly
  ;; where a Win16 API returns, which is why this needs none of the
  ;; continuation thunks the 32-bit side uses.
  (func $win16_enter_wndproc (param $proc i32) (param $hwnd i32) (param $msg i32)
        (param $wparam i32) (param $lparam i32) (param $ret_sel i32) (param $ret_ip i32)
    (call $win16_push16 (local.get $hwnd))
    (call $win16_push16 (local.get $msg))
    (call $win16_push16 (local.get $wparam))
    (call $win16_push16 (i32.shr_u (local.get $lparam) (i32.const 16)))
    (call $win16_push16 (local.get $lparam))
    (call $win16_push16 (local.get $ret_sel))
    (call $win16_push16 (local.get $ret_ip))
    (call $win16_set_sreg (i32.const 1) (i32.shr_u (local.get $proc) (i32.const 16)))
    (global.set $eip (i32.add (global.get $seg_base_cs)
                              (i32.and (local.get $proc) (i32.const 0xFFFF))))
    (global.set $steps (i32.const 0)))

  ;; Drop this API's own frame and report where it was going to return, packed
  ;; as selector:offset. Used by the calls that hand control to guest code
  ;; instead of returning to it.
  (func $win16_take_return (param $argbytes i32) (result i32)
    (local $packed i32)
    (local.set $packed (i32.or
      (call $gl16 (global.get $esp))
      (i32.shl (call $gl16 (i32.add (global.get $esp) (i32.const 2))) (i32.const 16))))
    (global.set $esp (i32.add (global.get $esp) (i32.add (i32.const 4) (local.get $argbytes))))
    (local.get $packed))

  ;; USER.173 LoadCursor(hInstance, lpCursorName). Opaque, like LoadIcon: it
  ;; identifies the cursor for a class registration, and the renderer draws the
  ;; host cursor regardless.
  (func $win16_LoadCursor
    (global.set $eax (call $win16_h16 (i32.const 0x70001)))
    (call $win16_api_return (i32.const 6)))

  ;; USER.57 RegisterClass(lpWndClass) -> ATOM.
  ;;
  ;; The 16-bit WNDCLASS is the 32-bit one with every field narrowed and its
  ;; two strings as far pointers:
  ;;   +0 style(W) +2 lpfnWndProc(far) +6 cbClsExtra(W) +8 cbWndExtra(W)
  ;;   +10 hInstance(W) +12 hIcon(W) +14 hCursor(W) +16 hbrBackground(W)
  ;;   +18 lpszMenuName(far) +22 lpszClassName(far)
  ;; Widening it into a WNDCLASSA and handing that to $handle_RegisterClassA
  ;; keeps one class table for both worlds. lpfnWndProc stays a far pointer
  ;; packed as selector:offset — in a 16-bit task every window procedure is
  ;; 16-bit, so no flag is needed to tell them apart.
  (func $win16_RegisterClass
    (local $src i32) (local $dst i32)
    (local.set $src (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $dst (global.get $GUEST_STACK))
    (call $gs32 (local.get $dst) (call $gl16 (local.get $src)))
    (call $gs32 (i32.add (local.get $dst) (i32.const 4)) (i32.or
      (call $gl16 (i32.add (local.get $src) (i32.const 2)))
      (i32.shl (call $gl16 (i32.add (local.get $src) (i32.const 4))) (i32.const 16))))
    (call $gs32 (i32.add (local.get $dst) (i32.const 8))
      (call $gl16 (i32.add (local.get $src) (i32.const 6))))
    (call $gs32 (i32.add (local.get $dst) (i32.const 12))
      (call $gl16 (i32.add (local.get $src) (i32.const 8))))
    (call $gs32 (i32.add (local.get $dst) (i32.const 16))
      (call $gl16 (i32.add (local.get $src) (i32.const 10))))
    (call $gs32 (i32.add (local.get $dst) (i32.const 20))
      (call $win16_h32 (call $gl16 (i32.add (local.get $src) (i32.const 12)))))
    (call $gs32 (i32.add (local.get $dst) (i32.const 24))
      (call $win16_h32 (call $gl16 (i32.add (local.get $src) (i32.const 14)))))
    (call $gs32 (i32.add (local.get $dst) (i32.const 28))
      (call $win16_h32 (call $gl16 (i32.add (local.get $src) (i32.const 16)))))
    (call $gs32 (i32.add (local.get $dst) (i32.const 32)) (call $win16_far_to_guest
      (call $gl16 (i32.add (local.get $src) (i32.const 20)))
      (call $gl16 (i32.add (local.get $src) (i32.const 18)))))
    (call $gs32 (i32.add (local.get $dst) (i32.const 36)) (call $win16_far_to_guest
      (call $gl16 (i32.add (local.get $src) (i32.const 24)))
      (call $gl16 (i32.add (local.get $src) (i32.const 22)))))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_RegisterClassA (local.get $dst)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 4)))

  ;; A 16-bit window coordinate is a signed word, and CW_USEDEFAULT is 0x8000
  ;; rather than 0x80000000 — the same "leave it to the system" sentinel at a
  ;; different width, so it has to be translated rather than sign-extended.
  (func $win16_coord (param $v i32) (result i32)
    (if (i32.eq (local.get $v) (i32.const 0x8000))
      (then (return (i32.const 0x80000000))))
    (i32.shr_s (i32.shl (local.get $v) (i32.const 16)) (i32.const 16)))

  ;; USER.41 CreateWindow(lpClassName, lpWindowName, dwStyle, x, y, nWidth,
  ;;   nHeight, hWndParent, hMenu, hInstance, lpParam) -> HWND.
  ;; Win16 has no extended style, so the Win32 handler gets zero for it.
  ;; USER.452 CreateWindowEx adds dwExStyle as the *first* parameter, and
  ;; Pascal pushes first parameters deepest — so it lands two words past the
  ;; end of CreateWindow's frame and every other index is unchanged. Reading
  ;; it as a leading argument instead shifts hMenu onto nHeight, which is how
  ;; Solitaire ended up handing a window height to the handle map.
  (func $win16_CreateWindow (param $ex i32)
    (local $class i32) (local $title i32) (local $style i32)
    (local $x i32) (local $y i32) (local $w i32) (local $h i32)
    (local $parent i32) (local $menu i32) (local $inst i32) (local $param i32)
    (local $exstyle i32) (local $hwnd i32)
    (if (local.get $ex) (then (local.set $exstyle (call $win16_arg32 (i32.const 15)))))
    (local.set $class (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 14)) (call $win16_arg16 (i32.const 13))))
    (local.set $title (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 12)) (call $win16_arg16 (i32.const 11))))
    (local.set $style (call $win16_arg32 (i32.const 9)))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 8))))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 7))))
    (local.set $w (call $win16_coord (call $win16_arg16 (i32.const 6))))
    (local.set $h (call $win16_coord (call $win16_arg16 (i32.const 5))))
    (local.set $parent (call $win16_h32 (call $win16_arg16 (i32.const 4))))
    (local.set $menu (call $win16_h32 (call $win16_arg16 (i32.const 3))))
    (local.set $inst (call $win16_arg16 (i32.const 2)))
    (local.set $param (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 12))
    (call $win16_call32_arg (i32.const 5) (local.get $y))
    (call $win16_call32_arg (i32.const 6) (local.get $w))
    (call $win16_call32_arg (i32.const 7) (local.get $h))
    (call $win16_call32_arg (i32.const 8) (local.get $parent))
    (call $win16_call32_arg (i32.const 9) (local.get $menu))
    (call $win16_call32_arg (i32.const 10) (local.get $inst))
    (call $win16_call32_arg (i32.const 11) (local.get $param))
    (call $handle_CreateWindowExA (local.get $exstyle)
      (local.get $class) (local.get $title) (local.get $style) (local.get $x)
      (i32.const 0))
    ;; The 32-bit handler delivers WM_CREATE by pointing EIP at the window
    ;; procedure with a 32-bit frame under it, which a 16-bit task cannot
    ;; survive — so the redirect is unwound and the message is delivered the
    ;; Win16 way instead, with a Pascal frame and a far return that comes back
    ;; here.
    ;;
    ;; It has to happen *before* CreateWindow returns, not through the message
    ;; queue: Solitaire never stores the handle CreateWindow gives it — the
    ;; next instruction clobbers AX — because its WM_CREATE handler sets the
    ;; global. Deferring the message left that global zero, and it called
    ;; ShowWindow(NULL).
    ;;
    ;; lParam is zero rather than a CREATESTRUCT; a 16-bit app reading one
    ;; would need the narrow layout, and none of these do.
    (local.set $hwnd (global.get $eax))
    (if (call $win16_call32_end_redirected)
      (then
        (global.set $win16_cont_result (call $win16_h16 (local.get $hwnd)))
        (global.set $win16_cont_ret (call $win16_take_return
          (select (i32.const 34) (i32.const 30) (local.get $ex))))
        (call $win16_enter_wndproc
          (call $wnd_table_get (local.get $hwnd))
          (global.get $win16_cont_result) (i32.const 0x0001) (i32.const 0) (i32.const 0)
          (global.get $WIN16_THUNK_SEL) (global.get $WIN16_CONT_OFFSET))
        (return)))
    (global.set $eax (call $win16_h16 (local.get $hwnd)))
    (call $win16_api_return (select (i32.const 34) (i32.const 30) (local.get $ex))))

  ;; USER.42 ShowWindow(hWnd, nCmdShow).
  ;;
  ;; Deliberately not $handle_ShowWindow: that one hands WM_ACTIVATEAPP to the
  ;; window procedure by redirecting EIP into a 32-bit frame, which is the one
  ;; thing a 16-bit task cannot survive. A Win16 app pumps messages for those
  ;; anyway, so this does the state change and lets the queue deliver the rest.
  (func $win16_ShowWindow
    (local $hwnd i32) (local $show i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 1))))
    (local.set $show (call $win16_arg16 (i32.const 0)))
    (drop (call $post_queue_push (local.get $hwnd) (i32.const 0x0018)
      (i32.ne (local.get $show) (i32.const 0)) (i32.const 0)))
    (drop (call $host_show_window (local.get $hwnd) (local.get $show)))
    (if (local.get $show)
      (then
        (drop (call $wnd_set_style (local.get $hwnd)
          (i32.or (call $wnd_get_style (local.get $hwnd)) (i32.const 0x10000000))))
        (global.set $paint_pending (i32.const 1))
        (call $invalidate_hwnd (local.get $hwnd)))
      (else
        (drop (call $wnd_set_style (local.get $hwnd)
          (i32.and (call $wnd_get_style (local.get $hwnd)) (i32.const 0xEFFFFFFF))))))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 4)))

  ;; USER.124 UpdateWindow(hWnd).
  (func $win16_UpdateWindow
    (call $invalidate_hwnd (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (global.set $paint_pending (i32.const 1))
    (global.set $eax (i32.const 0))
    (call $win16_api_return (i32.const 2)))

  ;; USER.108 GetMessage(lpMsg, hWnd, wMsgFilterMin, wMsgFilterMax).
  ;;
  ;; The 32-bit handler owns the whole delivery order — quit flag, pending
  ;; child creates, post queue, host input, paint, timers — so it fills a
  ;; 32-bit MSG in scratch and this narrows it into the 16-bit one:
  ;;   +0 hwnd(W) +2 message(W) +4 wParam(W) +6 lParam(D) +10 time(D) +14 pt(D)
  ;; When nothing is pending the 32-bit handler blocks, which this cannot use
  ;; (see $win16_call32_waited). A Win16 app pumps its own loop, so the honest
  ;; equivalent is the idle message: WM_NULL, a non-zero return so the loop
  ;; keeps going, and the yield flag left raised so the host still gets its
  ;; turn to deliver input between batches.
  (func $win16_GetMessage
    (local $dst i32) (local $tmp i32) (local $waited i32)
    (local.set $dst (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 4)) (call $win16_arg16 (i32.const 3))))
    (local.set $tmp (global.get $GUEST_STACK))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_GetMessageA (local.get $tmp) (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (local.set $waited (call $win16_call32_waited))
    (if (local.get $waited)
      (then
        (call $zero_memory (call $g2w (local.get $tmp)) (i32.const 28))
        (global.set $eax (i32.const 1))))
    (call $win16_call32_end)
    (call $gs16 (local.get $dst)
      (call $win16_h16 (call $gl32 (local.get $tmp))))
    (call $gs16 (i32.add (local.get $dst) (i32.const 2))
      (call $gl32 (i32.add (local.get $tmp) (i32.const 4))))
    (call $gs16 (i32.add (local.get $dst) (i32.const 4))
      (call $gl32 (i32.add (local.get $tmp) (i32.const 8))))
    (call $gs32 (i32.add (local.get $dst) (i32.const 6))
      (call $gl32 (i32.add (local.get $tmp) (i32.const 12))))
    (call $gs32 (i32.add (local.get $dst) (i32.const 10))
      (call $gl32 (i32.add (local.get $tmp) (i32.const 16))))
    (call $gs32 (i32.add (local.get $dst) (i32.const 14)) (i32.const 0))
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 10)))

  ;; USER.113 TranslateMessage(lpMsg). Key translation happens where the host
  ;; input is decoded, so there is nothing left to do here.
  (func $win16_TranslateMessage
    (global.set $eax (i32.const 0))
    (call $win16_api_return (i32.const 4)))

  ;; USER.114 DispatchMessage(lpMsg) -> LONG. This is where a 16-bit task
  ;; first runs its own window procedure.
  (func $win16_DispatchMessage
    (local $msg i32) (local $hwnd16 i32) (local $hwnd i32)
    (local $message i32) (local $wparam i32) (local $lparam i32)
    (local $proc i32) (local $ret i32)
    (local.set $msg (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $hwnd16 (call $gl16 (local.get $msg)))
    (local.set $message (call $gl16 (i32.add (local.get $msg) (i32.const 2))))
    (local.set $wparam (call $gl16 (i32.add (local.get $msg) (i32.const 4))))
    (local.set $lparam (call $gl32 (i32.add (local.get $msg) (i32.const 6))))
    (local.set $hwnd (call $win16_h32 (local.get $hwnd16)))
    (local.set $proc (call $wnd_table_get (local.get $hwnd)))
    ;; WM_NULL is the idle message and has no window procedure to reach.
    (if (i32.or (i32.eqz (local.get $message)) (i32.eqz (local.get $proc)))
      (then
        (global.set $eax (i32.const 0))
        (global.set $edx (i32.const 0))
        (call $win16_api_return (i32.const 4))
        (return)))
    (local.set $ret (call $win16_take_return (i32.const 4)))
    (call $win16_enter_wndproc (local.get $proc) (local.get $hwnd16)
      (local.get $message) (local.get $wparam) (local.get $lparam)
      (i32.shr_u (local.get $ret) (i32.const 16))
      (i32.and (local.get $ret) (i32.const 0xFFFF))))

  ;; USER.107 DefWindowProc(hWnd, message, wParam, lParam) -> LONG.
  (func $win16_DefWindowProc
    (local $hwnd i32) (local $message i32) (local $wparam i32) (local $lparam i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 4))))
    (local.set $message (call $win16_arg16 (i32.const 3)))
    (local.set $wparam (call $win16_arg16 (i32.const 2)))
    (local.set $lparam (call $win16_arg32 (i32.const 0)))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_DefWindowProcA (local.get $hwnd) (local.get $message)
      (local.get $wparam) (local.get $lparam) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $edx (i32.shr_u (global.get $eax) (i32.const 16)))
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 10)))

  ;; USER.6 PostQuitMessage(nExitCode).
  (func $win16_PostQuitMessage
    (global.set $quit_flag (i32.const 1))
    (global.set $eax (i32.const 0))
    (call $win16_api_return (i32.const 2)))

  ;; A RECT is four LONGs in Win32 and four ints in Win16, so it is copied
  ;; rather than pointed at. Coordinates are signed and can be negative, which
  ;; is why the narrow direction sign-extends on the way back out.
  (func $win16_rect_narrow (param $dst i32) (param $src i32)
    (local $i i32)
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (i32.const 4)))
      (call $gs16 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 1)))
        (call $gl32 (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 2)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy))))

  (func $win16_rect_widen (param $dst i32) (param $src i32)
    (local $i i32)
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (i32.const 4)))
      (call $gs32 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 2)))
        (call $win16_coord
          (call $gl16 (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 1))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy))))

  ;; USER.32 GetWindowRect / USER.33 GetClientRect(hWnd, lpRect).
  (func $win16_get_rect (param $is_window i32)
    (local $hwnd i32) (local $dst i32) (local $tmp i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (local.set $dst (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $tmp (global.get $GUEST_STACK))
    (call $win16_call32_begin (i32.const 2))
    (if (local.get $is_window)
      (then (call $handle_GetWindowRect (local.get $hwnd) (local.get $tmp)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle_GetClientRect (local.get $hwnd) (local.get $tmp)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (call $win16_call32_end)
    (call $win16_rect_narrow (local.get $dst) (local.get $tmp))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 6)))

  ;; USER.39 BeginPaint(hWnd, lpPaint) -> HDC, USER.40 EndPaint(hWnd, lpPaint).
  ;;
  ;; The 16-bit PAINTSTRUCT is hdc(W) fErase(W) rcPaint(4 ints) fRestore(W)
  ;; fIncUpdate(W) rgbReserved(16); the 32-bit one is the same fields at
  ;; double the width for the first six.
  (func $win16_BeginPaint
    (local $hwnd i32) (local $dst i32) (local $tmp i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (local.set $dst (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $tmp (global.get $GUEST_STACK))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_BeginPaint (local.get $hwnd) (local.get $tmp)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $gs16 (local.get $dst) (global.get $eax))
    (call $gs16 (i32.add (local.get $dst) (i32.const 2))
      (call $gl32 (i32.add (local.get $tmp) (i32.const 4))))
    (call $win16_rect_narrow (i32.add (local.get $dst) (i32.const 4))
                             (i32.add (local.get $tmp) (i32.const 8)))
    (call $gs16 (i32.add (local.get $dst) (i32.const 12)) (i32.const 0))
    (call $gs16 (i32.add (local.get $dst) (i32.const 14)) (i32.const 0))
    (call $win16_api_return (i32.const 6)))

  (func $win16_EndPaint
    (local $hwnd i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_EndPaint (local.get $hwnd) (global.get $GUEST_STACK)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 6)))

  ;; USER.125 InvalidateRect(hWnd, lpRect, bErase) — lpRect may be NULL, which
  ;; means the whole client area and must stay NULL rather than becoming a
  ;; pointer to a zero rectangle.
  (func $win16_InvalidateRect
    (local $hwnd i32) (local $src i32) (local $erase i32) (local $tmp i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 3))))
    (local.set $src (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $erase (call $win16_arg16 (i32.const 0)))
    (if (call $win16_arg16 (i32.const 2))
      (then
        (local.set $tmp (global.get $GUEST_STACK))
        (call $win16_rect_widen (local.get $tmp) (local.get $src))))
    (call $win16_call32_begin (i32.const 3))
    (call $handle_InvalidateRect (local.get $hwnd) (local.get $tmp) (local.get $erase)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 8)))

  ;; USER.81 FillRect(hDC, lpRect, hBrush).
  (func $win16_FillRect
    (local $hdc i32) (local $src i32) (local $brush i32) (local $tmp i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 3))))
    (local.set $src (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $brush (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (local.set $tmp (global.get $GUEST_STACK))
    (call $win16_rect_widen (local.get $tmp) (local.get $src))
    (call $win16_call32_begin (i32.const 3))
    (call $handle_FillRect (local.get $hdc) (local.get $tmp) (local.get $brush)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 8)))

  ;; USER.420 wsprintf(lpOut, lpFmt, ...) -> length.
  ;;
  ;; The one cdecl entry point in the set — the underscore on _WSPRINTF is the
  ;; export table saying so. Arguments are pushed right to left and the caller
  ;; removes them, so nothing comes off the stack on the way out, and lpOut is
  ;; on top rather than at the bottom.
  ;;
  ;; Widths differ from Win32 in a way no amount of pointer arithmetic hides:
  ;; %d and %u take a two-byte int, %ld takes four, and %s takes a far pointer
  ;; rather than a flat one. So the variable arguments are read here at their
  ;; Win16 widths and rewritten as an array of dwords, which is exactly the
  ;; shape $wsprintf_impl already walks — the formatting itself is shared.
  (func $win16_wsprintf
    (local $out i32) (local $fmt i32) (local $src i32) (local $dst i32)
    (local $i i32) (local $ch i32) (local $is_long i32) (local $n i32)
    (local.set $out (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $fmt (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 3)) (call $win16_arg16 (i32.const 2))))
    ;; Word 4 is the first variable argument.
    (local.set $src (i32.add (global.get $esp) (i32.const 12)))
    (local.set $dst (i32.add (global.get $GUEST_STACK) (i32.const 0x800)))

    (block $scanned (loop $scan
      (local.set $ch (call $gl8 (i32.add (local.get $fmt) (local.get $i))))
      (br_if $scanned (i32.eqz (local.get $ch)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $scan (i32.ne (local.get $ch) (i32.const 37)))     ;; '%'
      (if (i32.eq (call $gl8 (i32.add (local.get $fmt) (local.get $i))) (i32.const 37))
        (then (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $scan)))
      ;; Skip flags, width, precision and size modifiers, remembering whether a
      ;; long was asked for — that is the only thing that changes the width.
      (local.set $is_long (i32.const 0))
      (block $spec (loop $mods
        (local.set $ch (call $gl8 (i32.add (local.get $fmt) (local.get $i))))
        (if (i32.or (i32.eq (local.get $ch) (i32.const 108))      ;; 'l'
                    (i32.eq (local.get $ch) (i32.const 76)))      ;; 'L'
          (then (local.set $is_long (i32.const 1))
                (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $mods)))
        (br_if $spec (i32.eqz (i32.or
          (i32.and (i32.ge_u (local.get $ch) (i32.const 48))
                   (i32.le_u (local.get $ch) (i32.const 57)))     ;; '0'-'9'
          (i32.or (i32.eq (local.get $ch) (i32.const 45))         ;; '-'
          (i32.or (i32.eq (local.get $ch) (i32.const 43))         ;; '+'
          (i32.or (i32.eq (local.get $ch) (i32.const 32))         ;; ' '
          (i32.or (i32.eq (local.get $ch) (i32.const 35))         ;; '#'
          (i32.or (i32.eq (local.get $ch) (i32.const 46))         ;; '.'
          (i32.or (i32.eq (local.get $ch) (i32.const 42))         ;; '*'
                  (i32.eq (local.get $ch) (i32.const 104)))))))))));; 'h'
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $mods)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      ;; A string is a far pointer and becomes a guest address; a long is four
      ;; bytes as it stands; everything else is a two-byte int, signed for the
      ;; conversions that print a sign.
      (if (i32.or (i32.eq (local.get $ch) (i32.const 115))        ;; 's'
                  (i32.eq (local.get $ch) (i32.const 83)))        ;; 'S'
        (then
          (call $gs32 (local.get $dst) (call $win16_far_to_guest
            (call $gl16 (i32.add (local.get $src) (i32.const 2)))
            (call $gl16 (local.get $src))))
          (local.set $src (i32.add (local.get $src) (i32.const 4))))
        (else (if (local.get $is_long)
          (then
            (call $gs32 (local.get $dst) (i32.or (call $gl16 (local.get $src))
              (i32.shl (call $gl16 (i32.add (local.get $src) (i32.const 2)))
                       (i32.const 16))))
            (local.set $src (i32.add (local.get $src) (i32.const 4))))
          (else
            (local.set $n (call $gl16 (local.get $src)))
            (if (i32.or (i32.eq (local.get $ch) (i32.const 100))  ;; 'd'
                        (i32.eq (local.get $ch) (i32.const 105))) ;; 'i'
              (then (local.set $n (i32.shr_s (i32.shl (local.get $n) (i32.const 16))
                                             (i32.const 16)))))
            (call $gs32 (local.get $dst) (local.get $n))
            (local.set $src (i32.add (local.get $src) (i32.const 2)))))))
      (local.set $dst (i32.add (local.get $dst) (i32.const 4)))
      (br $scan)))

    (global.set $eax (call $wsprintf_impl (local.get $out) (local.get $fmt)
      (i32.add (global.get $GUEST_STACK) (i32.const 0x800))))
    (call $win16_api_return (i32.const 0)))

  ;; USER.84 DrawIcon(hDC, X, Y, hIcon).
  (func $win16_DrawIcon
    (local $hdc i32) (local $x i32) (local $y i32) (local $icon i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 3))))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 2))))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (local.set $icon (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_DrawIcon (local.get $hdc) (local.get $x) (local.get $y)
      (local.get $icon) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 8)))

  ;; USER.171 WinHelp(hWnd, lpszHelp, usCommand, ulData).
  (func $win16_WinHelp
    (local $hwnd i32) (local $file i32) (local $cmd i32) (local $data i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 5))))
    (local.set $file (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 4)) (call $win16_arg16 (i32.const 3))))
    (local.set $cmd (call $win16_arg16 (i32.const 2)))
    (local.set $data (call $win16_arg32 (i32.const 0)))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_WinHelpA (local.get $hwnd) (local.get $file) (local.get $cmd)
      (local.get $data) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 12)))

  ;; The RECT helpers. These are pure arithmetic on a caller-owned rectangle
  ;; with no device or window behind them, so they are written out at the
  ;; 16-bit width rather than widened, copied and narrowed back.
  ;;
  ;;   USER.72 SetRect(lpRect, xLeft, yTop, xRight, yBottom)
  ;;   USER.74 CopyRect(lpDestRect, lpSourceRect)
  ;;   USER.76 PtInRect(lpRect, Point)
  ;;   USER.78 InflateRect(lpRect, x, y)
  (func $win16_rect_get (param $r i32) (param $i i32) (result i32)
    (call $win16_coord (call $gl16 (i32.add (local.get $r)
      (i32.shl (local.get $i) (i32.const 1))))))

  (func $win16_rect_set (param $r i32) (param $i i32) (param $v i32)
    (call $gs16 (i32.add (local.get $r) (i32.shl (local.get $i) (i32.const 1)))
      (local.get $v)))

  (func $win16_SetRect
    (local $r i32) (local $i i32)
    (local.set $r (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 5)) (call $win16_arg16 (i32.const 4))))
    (block $done (loop $set
      (br_if $done (i32.ge_u (local.get $i) (i32.const 4)))
      (call $win16_rect_set (local.get $r) (local.get $i)
        (call $win16_arg16 (i32.sub (i32.const 3) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $set)))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 12)))

  (func $win16_CopyRect
    (local $dst i32) (local $src i32) (local $i i32)
    (local.set $dst (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 3)) (call $win16_arg16 (i32.const 2))))
    (local.set $src (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (i32.const 4)))
      (call $win16_rect_set (local.get $dst) (local.get $i)
        (call $win16_rect_get (local.get $src) (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 8)))

  ;; A POINT is one DWORD here, x in the low word.
  (func $win16_PtInRect
    (local $r i32) (local $x i32) (local $y i32)
    (local.set $r (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 3)) (call $win16_arg16 (i32.const 2))))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (global.set $eax (i32.and
      (i32.and (i32.ge_s (local.get $x) (call $win16_rect_get (local.get $r) (i32.const 0)))
               (i32.lt_s (local.get $x) (call $win16_rect_get (local.get $r) (i32.const 2))))
      (i32.and (i32.ge_s (local.get $y) (call $win16_rect_get (local.get $r) (i32.const 1)))
               (i32.lt_s (local.get $y) (call $win16_rect_get (local.get $r) (i32.const 3))))))
    (call $win16_api_return (i32.const 8)))

  (func $win16_InflateRect
    (local $r i32) (local $x i32) (local $y i32)
    (local.set $r (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 3)) (call $win16_arg16 (i32.const 2))))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (call $win16_rect_set (local.get $r) (i32.const 0)
      (i32.sub (call $win16_rect_get (local.get $r) (i32.const 0)) (local.get $x)))
    (call $win16_rect_set (local.get $r) (i32.const 1)
      (i32.sub (call $win16_rect_get (local.get $r) (i32.const 1)) (local.get $y)))
    (call $win16_rect_set (local.get $r) (i32.const 2)
      (i32.add (call $win16_rect_get (local.get $r) (i32.const 2)) (local.get $x)))
    (call $win16_rect_set (local.get $r) (i32.const 3)
      (i32.add (call $win16_rect_get (local.get $r) (i32.const 3)) (local.get $y)))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 8)))

  ;; USER.79 IntersectRect(lpDestRect, lpSrc1Rect, lpSrc2Rect) -> non-empty?
  ;; An empty intersection zeroes the destination, which callers rely on.
  (func $win16_IntersectRect
    (local $dst i32) (local $a i32) (local $b i32)
    (local $l i32) (local $t i32) (local $r i32) (local $bo i32)
    (local.set $dst (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 5)) (call $win16_arg16 (i32.const 4))))
    (local.set $a (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 3)) (call $win16_arg16 (i32.const 2))))
    (local.set $b (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $l (call $win16_rect_get (local.get $a) (i32.const 0)))
    (if (i32.lt_s (local.get $l) (call $win16_rect_get (local.get $b) (i32.const 0)))
      (then (local.set $l (call $win16_rect_get (local.get $b) (i32.const 0)))))
    (local.set $t (call $win16_rect_get (local.get $a) (i32.const 1)))
    (if (i32.lt_s (local.get $t) (call $win16_rect_get (local.get $b) (i32.const 1)))
      (then (local.set $t (call $win16_rect_get (local.get $b) (i32.const 1)))))
    (local.set $r (call $win16_rect_get (local.get $a) (i32.const 2)))
    (if (i32.gt_s (local.get $r) (call $win16_rect_get (local.get $b) (i32.const 2)))
      (then (local.set $r (call $win16_rect_get (local.get $b) (i32.const 2)))))
    (local.set $bo (call $win16_rect_get (local.get $a) (i32.const 3)))
    (if (i32.gt_s (local.get $bo) (call $win16_rect_get (local.get $b) (i32.const 3)))
      (then (local.set $bo (call $win16_rect_get (local.get $b) (i32.const 3)))))
    (if (i32.and (i32.lt_s (local.get $l) (local.get $r))
                 (i32.lt_s (local.get $t) (local.get $bo)))
      (then
        (call $win16_rect_set (local.get $dst) (i32.const 0) (local.get $l))
        (call $win16_rect_set (local.get $dst) (i32.const 1) (local.get $t))
        (call $win16_rect_set (local.get $dst) (i32.const 2) (local.get $r))
        (call $win16_rect_set (local.get $dst) (i32.const 3) (local.get $bo))
        (global.set $eax (i32.const 1)))
      (else
        (call $win16_rect_set (local.get $dst) (i32.const 0) (i32.const 0))
        (call $win16_rect_set (local.get $dst) (i32.const 1) (i32.const 0))
        (call $win16_rect_set (local.get $dst) (i32.const 2) (i32.const 0))
        (call $win16_rect_set (local.get $dst) (i32.const 3) (i32.const 0))
        (global.set $eax (i32.const 0))))
    (call $win16_api_return (i32.const 12)))

  ;; USER.180 GetSysColor(nIndex) -> COLORREF in DX:AX.
  (func $win16_GetSysColor
    (local $index i32)
    (local.set $index (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_GetSysColor (local.get $index)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $edx (i32.shr_u (global.get $eax) (i32.const 16)))
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 2)))

  ;; USER.118 RegisterWindowMessage(lpString).
  (func $win16_RegisterWindowMessage
    (local $s i32)
    (local.set $s (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_RegisterWindowMessageA (local.get $s)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 4)))

  ;; USER.150 LoadMenu(hInstance, lpMenuName) / USER.158 SetMenu(hWnd, hMenu).
  (func $win16_LoadMenu
    (local $id i32)
    (local.set $id (call $win16_res_arg (i32.const 0)))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_LoadMenuA (i32.const 0) (local.get $id)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 6)))

  (func $win16_SetMenu
    (local $hwnd i32) (local $menu i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 1))))
    (local.set $menu (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_SetMenu (local.get $hwnd) (local.get $menu)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 4)))

  ;; USER.10 SetTimer(hWnd, nIDEvent, uElapse, lpTimerFunc) /
  ;; USER.12 KillTimer(hWnd, nIDEvent).
  (func $win16_SetTimer
    (local $hwnd i32) (local $id i32) (local $elapse i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 4))))
    (local.set $id (call $win16_arg16 (i32.const 3)))
    (local.set $elapse (call $win16_arg16 (i32.const 2)))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_SetTimer (local.get $hwnd) (local.get $id) (local.get $elapse)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 10)))

  (func $win16_KillTimer
    (local $hwnd i32) (local $id i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 1))))
    (local.set $id (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_KillTimer (local.get $hwnd) (local.get $id)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 4)))

  ;; USER.110 PostMessage(hWnd, wMsg, wParam, lParam).
  (func $win16_PostMessage
    (local $hwnd i32) (local $msg i32) (local $wp i32) (local $lp i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 4))))
    (local.set $msg (call $win16_arg16 (i32.const 3)))
    (local.set $wp (call $win16_arg16 (i32.const 2)))
    (local.set $lp (call $win16_arg32 (i32.const 0)))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_PostMessageA (local.get $hwnd) (local.get $msg)
      (local.get $wp) (local.get $lp) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 10)))

  ;; USER.53 DestroyWindow(hWnd).
  (func $win16_DestroyWindow
    (local $hwnd i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_DestroyWindow (local.get $hwnd)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 2)))

  ;; USER.102 AdjustWindowRect(lpRect, dwStyle, bMenu) and USER.454
  ;; AdjustWindowRectEx(lpRect, dwStyle, bMenu, dwExStyle). The rectangle is
  ;; both input and output, so it is widened in and narrowed back out.
  (func $win16_adjust_window_rect (param $ex i32)
    (local $r i32) (local $style i32) (local $menu i32) (local $exstyle i32)
    (local $tmp i32) (local $base i32)
    ;; Here dwExStyle *is* the last parameter, so it is pushed last and sits on
    ;; top; everything else moves up by that pair. The opposite of
    ;; CreateWindowEx, where it is the first parameter and sits deepest.
    (local.set $base (select (i32.const 2) (i32.const 0) (local.get $ex)))
    (local.set $r (call $win16_far_to_guest
      (call $win16_arg16 (i32.add (local.get $base) (i32.const 4)))
      (call $win16_arg16 (i32.add (local.get $base) (i32.const 3)))))
    (local.set $style (call $win16_arg32 (i32.add (local.get $base) (i32.const 1))))
    (local.set $menu (call $win16_arg16 (local.get $base)))
    (if (local.get $ex) (then (local.set $exstyle (call $win16_arg32 (i32.const 0)))))
    (local.set $tmp (global.get $GUEST_STACK))
    (call $win16_rect_widen (local.get $tmp) (local.get $r))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_AdjustWindowRectEx (local.get $tmp) (local.get $style)
      (local.get $menu) (local.get $exstyle) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (call $win16_rect_narrow (local.get $r) (local.get $tmp))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (select (i32.const 14) (i32.const 10) (local.get $ex))))

  ;; USER.145 RegisterClipboardFormat(lpString).
  (func $win16_RegisterClipboardFormat
    (local $s i32)
    (local.set $s (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_RegisterClipboardFormatA (local.get $s)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 4)))

  ;; USER.177 LoadAccelerators(hInstance, lpTableName).
  (func $win16_LoadAccelerators
    (local $id i32)
    (local.set $id (call $win16_res_arg (i32.const 0)))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_LoadAcceleratorsA (i32.const 0) (local.get $id)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 6)))

  ;; USER.178 TranslateAccelerator(hWnd, hAccTable, lpMsg).
  ;;
  ;; The 32-bit handler reads the message out of a 32-bit MSG and posts a
  ;; WM_COMMAND when it matches, so the 16-bit one is widened into scratch
  ;; first. Nothing is copied back: a translated accelerator turns into a
  ;; posted message, and an untranslated one leaves the MSG alone.
  (func $win16_TranslateAccelerator
    (local $hwnd i32) (local $acc i32) (local $msg i32) (local $tmp i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 3))))
    (local.set $acc (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (local.set $msg (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $tmp (global.get $GUEST_STACK))
    (call $gs32 (local.get $tmp) (local.get $hwnd))
    (call $gs32 (i32.add (local.get $tmp) (i32.const 4))
      (call $gl16 (i32.add (local.get $msg) (i32.const 2))))
    (call $gs32 (i32.add (local.get $tmp) (i32.const 8))
      (call $gl16 (i32.add (local.get $msg) (i32.const 4))))
    (call $gs32 (i32.add (local.get $tmp) (i32.const 12))
      (call $gl32 (i32.add (local.get $msg) (i32.const 6))))
    (call $win16_call32_begin (i32.const 3))
    (call $handle_TranslateAcceleratorA (local.get $hwnd) (local.get $acc) (local.get $tmp)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 8)))

  ;; USER.483 SystemParametersInfo(uAction, uParam, lpvParam, fuWinIni).
  ;;
  ;; lpvParam points at a structure whose width depends on the action, and the
  ;; two worlds disagree about most of them. Handing the guest's pointer
  ;; straight to the 32-bit handler writes the wide form into a narrow buffer:
  ;; FreeCell asks for SPI_GETWORKAREA with an eight-byte RECT four bytes below
  ;; its own return address, and the sixteen bytes that came back overwrote it.
  ;;
  ;; So the actions that carry a structure are converted explicitly, and one
  ;; that is not known here stops rather than guessing at a width.
  (func $win16_SystemParametersInfo
    (local $action i32) (local $param i32) (local $ptr i32) (local $ini i32)
    (local $tmp i32)
    (local.set $action (call $win16_arg16 (i32.const 4)))
    (local.set $param (call $win16_arg16 (i32.const 3)))
    (local.set $ptr (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $ini (call $win16_arg16 (i32.const 0)))
    ;; SPI_GETWORKAREA / SPI_SETWORKAREA are the RECT pair.
    (if (i32.or (i32.eq (local.get $action) (i32.const 0x30))
                (i32.eq (local.get $action) (i32.const 0x2F)))
      (then
        (local.set $tmp (global.get $GUEST_STACK))
        (if (i32.eq (local.get $action) (i32.const 0x2F))
          (then (call $win16_rect_widen (local.get $tmp) (local.get $ptr))))
        (call $win16_call32_begin (i32.const 4))
        (call $handle_SystemParametersInfoA (local.get $action) (local.get $param)
          (local.get $tmp) (local.get $ini) (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (if (i32.eq (local.get $action) (i32.const 0x30))
          (then (call $win16_rect_narrow (local.get $ptr) (local.get $tmp))))
        (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (call $win16_api_return (i32.const 10))
        (return)))
    ;; Everything else must have no buffer at all, or the width is a guess.
    (if (call $win16_arg16 (i32.const 2))
      (then
        (call $host_log_i32 (i32.const 0xCA16A9F6))
        (call $host_log_i32 (local.get $action))
        (unreachable)))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_SystemParametersInfoA (local.get $action) (local.get $param)
      (i32.const 0) (local.get $ini) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 10)))

  ;; The window calls that take one handle and answer with a word, and the two
  ;; that take none. Grouping them keeps sixteen near-identical eight-line
  ;; functions from crowding out the ones with real conversions in them.
  (func $win16_hwnd_query (param $which i32)
    (local $hwnd i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 1))
    (if (i32.eq (local.get $which) (i32.const 0))
      (then (call $handle_SetFocus (local.get $hwnd)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (if (i32.eq (local.get $which) (i32.const 1))
      (then (call $handle_SetCapture (local.get $hwnd)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (if (i32.eq (local.get $which) (i32.const 2))
      (then (call $handle_GetParent (local.get $hwnd)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (if (i32.eq (local.get $which) (i32.const 3))
      (then (call $handle_IsIconic (local.get $hwnd)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (if (i32.eq (local.get $which) (i32.const 4))
      (then (call $handle_IsWindowVisible (local.get $hwnd)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (if (i32.eq (local.get $which) (i32.const 5))
      (then (call $handle_GetMenu (local.get $hwnd)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (if (i32.eq (local.get $which) (i32.const 6))
      (then (call $handle_DrawMenuBar (local.get $hwnd)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (call $win16_call32_end)
    ;; The two that answer with a handle go back through the map; the rest are
    ;; already booleans or small numbers.
    (if (i32.or (i32.eq (local.get $which) (i32.const 0))
                (i32.or (i32.eq (local.get $which) (i32.const 1))
                        (i32.or (i32.eq (local.get $which) (i32.const 2))
                                (i32.eq (local.get $which) (i32.const 5)))))
      (then (global.set $eax (call $win16_h16 (global.get $eax))))
      (else (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))))
    (call $win16_api_return (i32.const 2)))

  (func $win16_GetFocus
    (call $win16_call32_begin (i32.const 0))
    (call $handle_GetFocus (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 0)))

  (func $win16_ReleaseCapture
    (call $win16_call32_begin (i32.const 0))
    (call $handle_ReleaseCapture (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 0)))

  ;; USER.104 MessageBeep(wType), USER.106 GetKeyState(nVirtKey) — a word in,
  ;; a word out, no handles involved.
  (func $win16_word_query (param $is_key i32)
    (local $v i32)
    (local.set $v (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 1))
    (if (local.get $is_key)
      (then (call $handle_GetKeyState
              (i32.shr_s (i32.shl (local.get $v) (i32.const 16)) (i32.const 16))
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle_MessageBeep (local.get $v)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 2)))

  ;; USER.34 EnableWindow(hWnd, bEnable).
  (func $win16_EnableWindow
    (local $hwnd i32) (local $enable i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 1))))
    (local.set $enable (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_EnableWindow (local.get $hwnd) (local.get $enable)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 4)))

  ;; USER.154 CheckMenuItem / USER.155 EnableMenuItem(hMenu, wID, wFlags).
  (func $win16_menu_item (param $is_enable i32)
    (local $menu i32) (local $id i32) (local $flags i32)
    (local.set $menu (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (local.set $id (call $win16_arg16 (i32.const 1)))
    (local.set $flags (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 3))
    (if (local.get $is_enable)
      (then (call $handle_EnableMenuItem (local.get $menu) (local.get $id) (local.get $flags)
              (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle_CheckMenuItem (local.get $menu) (local.get $id) (local.get $flags)
              (i32.const 0) (i32.const 0) (i32.const 0))))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 6)))

  ;; USER.37 SetWindowText(hWnd, lpString).
  (func $win16_SetWindowText
    (local $hwnd i32) (local $s i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (local.set $s (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_SetWindowTextA (local.get $hwnd) (local.get $s)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 6)))

  ;; USER.56 MoveWindow(hWnd, x, y, nWidth, nHeight, bRepaint).
  (func $win16_MoveWindow
    (local $hwnd i32) (local $x i32) (local $y i32) (local $w i32)
    (local $h i32) (local $repaint i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 5))))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 4))))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 3))))
    (local.set $w (call $win16_coord (call $win16_arg16 (i32.const 2))))
    (local.set $h (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (local.set $repaint (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 6))
    (call $win16_call32_arg (i32.const 5) (local.get $repaint))
    (call $handle_MoveWindow (local.get $hwnd) (local.get $x) (local.get $y)
      (local.get $w) (local.get $h) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 12)))

  ;; USER.85 DrawText(hDC, lpString, nCount, lpRect, wFormat).
  (func $win16_DrawText
    (local $hdc i32) (local $s i32) (local $n i32) (local $r i32)
    (local $fmt i32) (local $tmp i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 6))))
    (local.set $s (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 5)) (call $win16_arg16 (i32.const 4))))
    (local.set $n (call $win16_coord (call $win16_arg16 (i32.const 3))))
    (local.set $r (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $fmt (call $win16_arg16 (i32.const 0)))
    (local.set $tmp (global.get $GUEST_STACK))
    (call $win16_rect_widen (local.get $tmp) (local.get $r))
    (call $win16_call32_begin (i32.const 5))
    (call $win16_call32_arg (i32.const 4) (local.get $fmt))
    (call $handle_DrawTextA (local.get $hdc) (local.get $s) (local.get $n)
      (local.get $tmp) (local.get $fmt) (i32.const 0))
    (call $win16_call32_end)
    ;; DT_CALCRECT asks for the rectangle back rather than for any drawing.
    (if (i32.and (local.get $fmt) (i32.const 0x0400))
      (then (call $win16_rect_narrow (local.get $r) (local.get $tmp))))
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 14)))

  ;; USER.109 PeekMessage(lpMsg, hWnd, wMsgFilterMin, wMsgFilterMax, wRemoveMsg).
  (func $win16_PeekMessage
    (local $dst i32) (local $remove i32) (local $tmp i32)
    (local.set $dst (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 5)) (call $win16_arg16 (i32.const 4))))
    (local.set $remove (call $win16_arg16 (i32.const 0)))
    (local.set $tmp (global.get $GUEST_STACK))
    (call $win16_call32_begin (i32.const 5))
    (call $win16_call32_arg (i32.const 4) (local.get $remove))
    (call $handle_PeekMessageA (local.get $tmp) (i32.const 0) (i32.const 0)
      (i32.const 0) (local.get $remove) (i32.const 0))
    (call $win16_call32_end)
    (if (global.get $eax)
      (then
        (call $gs16 (local.get $dst) (call $win16_h16 (call $gl32 (local.get $tmp))))
        (call $gs16 (i32.add (local.get $dst) (i32.const 2))
          (call $gl32 (i32.add (local.get $tmp) (i32.const 4))))
        (call $gs16 (i32.add (local.get $dst) (i32.const 4))
          (call $gl32 (i32.add (local.get $tmp) (i32.const 8))))
        (call $gs32 (i32.add (local.get $dst) (i32.const 6))
          (call $gl32 (i32.add (local.get $tmp) (i32.const 12))))
        (call $gs32 (i32.add (local.get $dst) (i32.const 10))
          (call $gl32 (i32.add (local.get $tmp) (i32.const 16))))
        (call $gs32 (i32.add (local.get $dst) (i32.const 14)) (i32.const 0))))
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 12)))

  ;; ---- GDI ----

  ;; GDI.80 GetDeviceCaps(hDC, nIndex). Same indices as Win32.
  (func $win16_GetDeviceCaps
    (local $hdc i32) (local $index i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 1))))
    (local.set $index (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_GetDeviceCaps (local.get $hdc) (local.get $index)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 4)))

  ;; GDI.82 GetObject(hObject, nCount, lpObject).
  ;;
  ;; The structures differ between the two worlds and this hands back the Win32
  ;; one, which is wrong for a 16-bit caller in general. It is right for the
  ;; only shape these apps ask for: BITMAP, whose first five fields are 16-bit
  ;; in Win16 and 32-bit in Win32 — so a caller asking for 14 bytes wants the
  ;; narrow form. Anything else stops rather than filling a buffer with a
  ;; structure the caller cannot read.
  (func $win16_GetObject
    (local $h i32) (local $count i32) (local $dst i32) (local $tmp i32)
    (local.set $h (call $win16_h32 (call $win16_arg16 (i32.const 3))))
    (local.set $count (call $win16_arg16 (i32.const 2)))
    (local.set $dst (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (if (i32.ne (local.get $count) (i32.const 14))
      (then
        (call $host_log_i32 (i32.const 0xCA16A9F5))
        (call $host_log_i32 (local.get $count))
        (unreachable)))
    ;; Fill the wide BITMAP into scratch, then narrow the five fields the
    ;; 16-bit structure keeps: bmType, bmWidth, bmHeight, bmWidthBytes as
    ;; words, then bmPlanes and bmBitsPixel as bytes, then a far bmBits.
    (local.set $tmp (global.get $GUEST_STACK))
    (call $win16_call32_begin (i32.const 3))
    (call $handle_GetObjectA (local.get $h) (i32.const 24) (local.get $tmp)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (if (global.get $eax)
      (then
        (call $gs16 (local.get $dst)
          (call $gl32 (local.get $tmp)))
        (call $gs16 (i32.add (local.get $dst) (i32.const 2))
          (call $gl32 (i32.add (local.get $tmp) (i32.const 4))))
        (call $gs16 (i32.add (local.get $dst) (i32.const 4))
          (call $gl32 (i32.add (local.get $tmp) (i32.const 8))))
        (call $gs16 (i32.add (local.get $dst) (i32.const 6))
          (call $gl32 (i32.add (local.get $tmp) (i32.const 12))))
        (call $gs8 (i32.add (local.get $dst) (i32.const 8))
          (call $gl32 (i32.add (local.get $tmp) (i32.const 16))))
        (call $gs8 (i32.add (local.get $dst) (i32.const 9))
          (call $gl32 (i32.add (local.get $tmp) (i32.const 20))))
        (call $gs32 (i32.add (local.get $dst) (i32.const 10)) (i32.const 0))
        (global.set $eax (i32.const 14))))
    (call $win16_api_return (i32.const 8)))

  ;; GDI.87 GetStockObject(nIndex).
  (func $win16_GetStockObject
    (local $index i32)
    (local.set $index (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_GetStockObject (local.get $index)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 2)))

  ;; GDI.91 GetTextExtent(hDC, lpString, nCount) -> DWORD packed cy:cx.
  ;; Win32 named this GetTextExtentPoint and made it write a SIZE; Win16
  ;; returns the same two numbers packed into DX:AX.
  (func $win16_GetTextExtent
    (local $hdc i32) (local $str i32) (local $count i32) (local $tmp i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 3))))
    (local.set $str (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $count (call $win16_arg16 (i32.const 0)))
    (local.set $tmp (global.get $GUEST_STACK))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_GetTextExtentPointA (local.get $hdc) (local.get $str)
      (local.get $count) (local.get $tmp) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (call $gl32 (local.get $tmp)) (i32.const 0xFFFF)))
    (global.set $edx (i32.and (call $gl32 (i32.add (local.get $tmp) (i32.const 4)))
                              (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 8)))

  ;; The GDI calls that are the Win32 one with narrower arguments and nothing
  ;; else: a handle or two in, a handle or a word out. Each reads its arguments
  ;; before $win16_call32_begin moves ESP, for the reason given there.

  ;; GDI.66 CreateSolidBrush(crColor) -> HBRUSH. COLORREF is a DWORD in both.
  (func $win16_CreateSolidBrush
    (local $c i32)
    (local.set $c (call $win16_arg32 (i32.const 0)))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_CreateSolidBrush (local.get $c)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 4)))

  ;; GDI.61 CreatePen(nPenStyle, nWidth, crColor) -> HPEN.
  (func $win16_CreatePen
    (local $style i32) (local $width i32) (local $c i32)
    (local.set $style (call $win16_arg16 (i32.const 3)))
    (local.set $width (call $win16_coord (call $win16_arg16 (i32.const 2))))
    (local.set $c (call $win16_arg32 (i32.const 0)))
    (call $win16_call32_begin (i32.const 3))
    (call $handle_CreatePen (local.get $style) (local.get $width) (local.get $c)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 8)))

  ;; GDI.45 SelectObject(hDC, hObject) -> the object it replaced.
  (func $win16_SelectObject
    (local $hdc i32) (local $obj i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 1))))
    (local.set $obj (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_SelectObject (local.get $hdc) (local.get $obj)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 4)))

  ;; GDI.69 DeleteObject(hObject), GDI.68 DeleteDC(hDC).
  (func $win16_DeleteObject
    (local $h i32)
    (local.set $h (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_DeleteObject (local.get $h)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 2)))

  (func $win16_DeleteDC
    (local $h i32)
    (local.set $h (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_DeleteDC (local.get $h)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 2)))

  ;; GDI.52 CreateCompatibleDC(hDC), GDI.153 CreateIC(driver, device, output,
  ;; initData). An information context answers device questions without being
  ;; drawable, and a compatible DC is the closest thing here that does.
  (func $win16_CreateCompatibleDC
    (local $h i32)
    (local.set $h (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_CreateCompatibleDC (local.get $h)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 2)))

  (func $win16_CreateIC
    (call $win16_call32_begin (i32.const 1))
    (call $handle_CreateCompatibleDC (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 16)))

  ;; GDI.51 CreateCompatibleBitmap(hDC, nWidth, nHeight).
  (func $win16_CreateCompatibleBitmap
    (local $hdc i32) (local $w i32) (local $h i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (local.set $w (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (local.set $h (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 3))
    (call $handle_CreateCompatibleBitmap (local.get $hdc) (local.get $w) (local.get $h)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 6)))

  ;; GDI.1 SetBkColor, GDI.9 SetTextColor — DWORD in, DWORD out.
  (func $win16_set_dc_color (param $is_text i32)
    (local $hdc i32) (local $c i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (local.set $c (call $win16_arg32 (i32.const 0)))
    (call $win16_call32_begin (i32.const 2))
    (if (local.get $is_text)
      (then (call $handle_SetTextColor (local.get $hdc) (local.get $c)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle_SetBkColor (local.get $hdc) (local.get $c)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (call $win16_call32_end)
    (global.set $edx (i32.shr_u (global.get $eax) (i32.const 16)))
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 6)))

  ;; GDI.2 SetBkMode, GDI.4 SetROP2 — word in, word out.
  (func $win16_set_dc_mode (param $is_rop i32)
    (local $hdc i32) (local $mode i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 1))))
    (local.set $mode (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 2))
    (if (local.get $is_rop)
      (then (call $handle_SetROP2 (local.get $hdc) (local.get $mode)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle_SetBkMode (local.get $hdc) (local.get $mode)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 4)))

  ;; GDI.93 GetTextMetrics(hDC, lpMetrics).
  ;;
  ;; The 16-bit TEXTMETRIC is the 32-bit one with the first eleven fields
  ;; narrowed from LONG to int and the rest already bytes, so the wide form is
  ;; filled into scratch and copied down field by field.
  (func $win16_GetTextMetrics
    (local $hdc i32) (local $dst i32) (local $tmp i32) (local $i i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (local.set $dst (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $tmp (global.get $GUEST_STACK))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_GetTextMetricsA (local.get $hdc) (local.get $tmp)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    ;; Eleven LONGs become eleven ints ...
    (local.set $i (i32.const 0))
    (block $done (loop $narrow
      (br_if $done (i32.ge_u (local.get $i) (i32.const 11)))
      (call $gs16 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 1)))
        (call $gl32 (i32.add (local.get $tmp) (i32.shl (local.get $i) (i32.const 2)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $narrow)))
    ;; ... and the eleven trailing bytes carry over unchanged.
    (call $memcpy (call $g2w (i32.add (local.get $dst) (i32.const 22)))
                  (call $g2w (i32.add (local.get $tmp) (i32.const 44)))
                  (i32.const 11))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 6)))

  ;; The drawing calls. Coordinates are signed words, ROP codes are DWORDs,
  ;; and everything else is a handle — so the conversions are the same three
  ;; every time and the only thing that varies is the argument order.

  ;; GDI.33 TextOut(hDC, X, Y, lpString, nCount).
  (func $win16_TextOut
    (local $hdc i32) (local $x i32) (local $y i32) (local $s i32) (local $n i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 5))))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 4))))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 3))))
    (local.set $s (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $n (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 5))
    (call $win16_call32_arg (i32.const 4) (local.get $n))
    (call $handle_TextOutA (local.get $hdc) (local.get $x) (local.get $y)
      (local.get $s) (local.get $n) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 12)))

  ;; GDI.34 BitBlt(hDest, X, Y, nWidth, nHeight, hSrc, XSrc, YSrc, dwRop).
  (func $win16_BitBlt
    (local $dst i32) (local $x i32) (local $y i32) (local $w i32) (local $h i32)
    (local $src i32) (local $sx i32) (local $sy i32) (local $rop i32)
    (local.set $dst (call $win16_h32 (call $win16_arg16 (i32.const 9))))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 8))))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 7))))
    (local.set $w (call $win16_coord (call $win16_arg16 (i32.const 6))))
    (local.set $h (call $win16_coord (call $win16_arg16 (i32.const 5))))
    (local.set $src (call $win16_h32 (call $win16_arg16 (i32.const 4))))
    (local.set $sx (call $win16_coord (call $win16_arg16 (i32.const 3))))
    (local.set $sy (call $win16_coord (call $win16_arg16 (i32.const 2))))
    (local.set $rop (call $win16_arg32 (i32.const 0)))
    (call $win16_call32_begin (i32.const 9))
    (call $win16_call32_arg (i32.const 5) (local.get $src))
    (call $win16_call32_arg (i32.const 6) (local.get $sx))
    (call $win16_call32_arg (i32.const 7) (local.get $sy))
    (call $win16_call32_arg (i32.const 8) (local.get $rop))
    (call $handle_BitBlt (local.get $dst) (local.get $x) (local.get $y)
      (local.get $w) (local.get $h) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 20)))

  ;; GDI.35 StretchBlt — BitBlt with a source size of its own.
  (func $win16_StretchBlt
    (local $dst i32) (local $x i32) (local $y i32) (local $w i32) (local $h i32)
    (local $src i32) (local $sx i32) (local $sy i32) (local $sw i32) (local $sh i32)
    (local $rop i32)
    (local.set $dst (call $win16_h32 (call $win16_arg16 (i32.const 11))))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 10))))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 9))))
    (local.set $w (call $win16_coord (call $win16_arg16 (i32.const 8))))
    (local.set $h (call $win16_coord (call $win16_arg16 (i32.const 7))))
    (local.set $src (call $win16_h32 (call $win16_arg16 (i32.const 6))))
    (local.set $sx (call $win16_coord (call $win16_arg16 (i32.const 5))))
    (local.set $sy (call $win16_coord (call $win16_arg16 (i32.const 4))))
    (local.set $sw (call $win16_coord (call $win16_arg16 (i32.const 3))))
    (local.set $sh (call $win16_coord (call $win16_arg16 (i32.const 2))))
    (local.set $rop (call $win16_arg32 (i32.const 0)))
    (call $win16_call32_begin (i32.const 11))
    (call $win16_call32_arg (i32.const 5) (local.get $src))
    (call $win16_call32_arg (i32.const 6) (local.get $sx))
    (call $win16_call32_arg (i32.const 7) (local.get $sy))
    (call $win16_call32_arg (i32.const 8) (local.get $sw))
    (call $win16_call32_arg (i32.const 9) (local.get $sh))
    (call $win16_call32_arg (i32.const 10) (local.get $rop))
    (call $handle_StretchBlt (local.get $dst) (local.get $x) (local.get $y)
      (local.get $w) (local.get $h) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 24)))

  ;; GDI.29 PatBlt(hDC, X, Y, nWidth, nHeight, dwRop).
  (func $win16_PatBlt
    (local $hdc i32) (local $x i32) (local $y i32) (local $w i32) (local $h i32)
    (local $rop i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 6))))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 5))))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 4))))
    (local.set $w (call $win16_coord (call $win16_arg16 (i32.const 3))))
    (local.set $h (call $win16_coord (call $win16_arg16 (i32.const 2))))
    (local.set $rop (call $win16_arg32 (i32.const 0)))
    (call $win16_call32_begin (i32.const 6))
    (call $win16_call32_arg (i32.const 5) (local.get $rop))
    (call $handle_PatBlt (local.get $hdc) (local.get $x) (local.get $y)
      (local.get $w) (local.get $h) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 14)))

  ;; GDI.20 MoveTo / GDI.19 LineTo / GDI.83 GetPixel(hDC, X, Y). MoveTo and
  ;; GetPixel answer with a DWORD in DX:AX — the previous position and the
  ;; colour respectively.
  (func $win16_dc_point (param $which i32)
    (local $hdc i32) (local $x i32) (local $y i32) (local $tmp i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (local.set $tmp (global.get $GUEST_STACK))
    (call $win16_call32_begin (i32.const 4))
    (if (i32.eq (local.get $which) (i32.const 0))
      (then (call $handle_MoveToEx (local.get $hdc) (local.get $x) (local.get $y)
              (local.get $tmp) (i32.const 0) (i32.const 0))))
    (if (i32.eq (local.get $which) (i32.const 1))
      (then (call $handle_LineTo (local.get $hdc) (local.get $x) (local.get $y)
              (i32.const 0) (i32.const 0) (i32.const 0))))
    (if (i32.eq (local.get $which) (i32.const 2))
      (then (call $handle_GetPixel (local.get $hdc) (local.get $x) (local.get $y)
              (i32.const 0) (i32.const 0) (i32.const 0))))
    (call $win16_call32_end)
    (if (i32.eq (local.get $which) (i32.const 0))
      (then
        (global.set $eax (i32.and (call $gl32 (local.get $tmp)) (i32.const 0xFFFF)))
        (global.set $edx (i32.and (call $gl32 (i32.add (local.get $tmp) (i32.const 4)))
                                  (i32.const 0xFFFF))))
      (else
        (global.set $edx (i32.shr_u (global.get $eax) (i32.const 16)))
        (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))))
    (call $win16_api_return (i32.const 6)))

  ;; GDI.31 SetPixel(hDC, X, Y, crColor).
  (func $win16_SetPixel
    (local $hdc i32) (local $x i32) (local $y i32) (local $c i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 4))))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 3))))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 2))))
    (local.set $c (call $win16_arg32 (i32.const 0)))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_SetPixel (local.get $hdc) (local.get $x) (local.get $y)
      (local.get $c) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $edx (i32.shr_u (global.get $eax) (i32.const 16)))
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 10)))

  ;; GDI.30 SaveDC(hDC) / GDI.39 RestoreDC(hDC, nSavedDC).
  (func $win16_save_restore_dc (param $is_restore i32)
    (local $hdc i32) (local $n i32)
    (local.set $hdc (call $win16_h32
      (call $win16_arg16 (local.get $is_restore))))
    (if (local.get $is_restore)
      (then (local.set $n (call $win16_coord (call $win16_arg16 (i32.const 0))))))
    (call $win16_call32_begin (i32.const 2))
    (if (local.get $is_restore)
      (then (call $handle_RestoreDC (local.get $hdc) (local.get $n)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle_SaveDC (local.get $hdc)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (select (i32.const 4) (i32.const 2) (local.get $is_restore))))

  ;; GDI.48 CreateBitmap(nWidth, nHeight, cPlanes, cBitsPixel, lpvBits).
  (func $win16_CreateBitmap
    (local $w i32) (local $h i32) (local $planes i32) (local $bpp i32) (local $bits i32)
    (local.set $w (call $win16_coord (call $win16_arg16 (i32.const 5))))
    (local.set $h (call $win16_coord (call $win16_arg16 (i32.const 4))))
    (local.set $planes (call $win16_arg16 (i32.const 3)))
    (local.set $bpp (call $win16_arg16 (i32.const 2)))
    (local.set $bits (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    ;; A null far pointer is a bitmap with undefined contents, not a pointer to
    ;; offset zero of the data segment.
    (if (i32.eqz (call $win16_arg16 (i32.const 1)))
      (then (local.set $bits (i32.const 0))))
    (call $win16_call32_begin (i32.const 5))
    (call $win16_call32_arg (i32.const 4) (local.get $bits))
    (call $handle_CreateBitmap (local.get $w) (local.get $h) (local.get $planes)
      (local.get $bpp) (local.get $bits) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 12)))

  ;; GDI.442 CreateDIBitmap(hDC, lpbmih, fdwInit, lpbInit, lpbmi, fuUsage).
  (func $win16_CreateDIBitmap
    (local $hdc i32) (local $bmih i32) (local $init i32) (local $bits i32)
    (local $bmi i32) (local $usage i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 9))))
    (local.set $bmih (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 8)) (call $win16_arg16 (i32.const 7))))
    (local.set $init (call $win16_arg32 (i32.const 5)))
    (local.set $bits (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 4)) (call $win16_arg16 (i32.const 3))))
    (local.set $bmi (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $usage (call $win16_arg16 (i32.const 0)))
    (if (i32.eqz (call $win16_arg16 (i32.const 4))) (then (local.set $bits (i32.const 0))))
    (if (i32.eqz (call $win16_arg16 (i32.const 2))) (then (local.set $bmi (i32.const 0))))
    (call $win16_call32_begin (i32.const 6))
    (call $win16_call32_arg (i32.const 5) (local.get $usage))
    (call $handle_CreateDIBitmap (local.get $hdc) (local.get $bmih) (local.get $init)
      (local.get $bits) (local.get $bmi) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 20)))

  ;; GDI.148 SetBrushOrg(hDC, nXOrg, nYOrg) -> previous origin in DX:AX.
  (func $win16_SetBrushOrg
    (local $hdc i32) (local $x i32) (local $y i32) (local $tmp i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (local.set $tmp (global.get $GUEST_STACK))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_SetBrushOrgEx (local.get $hdc) (local.get $x) (local.get $y)
      (local.get $tmp) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (call $gl32 (local.get $tmp)) (i32.const 0xFFFF)))
    (global.set $edx (i32.and (call $gl32 (i32.add (local.get $tmp) (i32.const 4)))
                              (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 6)))

  ;; GDI.443 SetDIBitsToDevice(hDC, X, Y, dX, dY, XSrc, YSrc, uStartScan,
  ;;   cScanLines, lpvBits, lpbmi, fuColorUse).
  (func $win16_SetDIBitsToDevice
    (local $hdc i32) (local $x i32) (local $y i32) (local $dx i32) (local $dy i32)
    (local $sx i32) (local $sy i32) (local $start i32) (local $lines i32)
    (local $bits i32) (local $bmi i32) (local $use i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 13))))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 12))))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 11))))
    (local.set $dx (call $win16_coord (call $win16_arg16 (i32.const 10))))
    (local.set $dy (call $win16_coord (call $win16_arg16 (i32.const 9))))
    (local.set $sx (call $win16_coord (call $win16_arg16 (i32.const 8))))
    (local.set $sy (call $win16_coord (call $win16_arg16 (i32.const 7))))
    (local.set $start (call $win16_arg16 (i32.const 6)))
    (local.set $lines (call $win16_arg16 (i32.const 5)))
    (local.set $bits (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 4)) (call $win16_arg16 (i32.const 3))))
    (local.set $bmi (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $use (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 12))
    (call $win16_call32_arg (i32.const 5) (local.get $sx))
    (call $win16_call32_arg (i32.const 6) (local.get $sy))
    (call $win16_call32_arg (i32.const 7) (local.get $start))
    (call $win16_call32_arg (i32.const 8) (local.get $lines))
    (call $win16_call32_arg (i32.const 9) (local.get $bits))
    (call $win16_call32_arg (i32.const 10) (local.get $bmi))
    (call $win16_call32_arg (i32.const 11) (local.get $use))
    (call $handle_SetDIBitsToDevice (local.get $hdc) (local.get $x) (local.get $y)
      (local.get $dx) (local.get $dy) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 28)))

  ;; GDI.79 GetDCOrg(hDC) -> the DC's origin in screen coordinates, packed in
  ;; DX:AX. Every DC here is already window-relative, so the origin is the
  ;; window's own client corner.
  (func $win16_GetDCOrg
    (call $win16_call32_begin (i32.const 2))
    (call $handle_GetDCOrgEx (call $win16_h32 (call $win16_arg16 (i32.const 0)))
      (global.get $GUEST_STACK) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (call $gl32 (global.get $GUEST_STACK)) (i32.const 0xFFFF)))
    (global.set $edx (i32.and (call $gl32 (i32.add (global.get $GUEST_STACK) (i32.const 4)))
                              (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 2)))

  (func $win16_gdi (param $ordinal i32) (result i32)
    (if (i32.eq (local.get $ordinal) (i32.const 79))
      (then (call $win16_GetDCOrg) (return (i32.const 1))))
    ;; UnrealizeObject asks a brush or palette to be re-mapped on next select.
    ;; With no palette realisation here there is nothing to invalidate, and
    ;; success is the truthful answer rather than a placeholder.
    (if (i32.eq (local.get $ordinal) (i32.const 150))
      (then (call $win16_local_identity (i32.const 2) (i32.const 1))
            (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 148))
      (then (call $win16_SetBrushOrg) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 443))
      (then (call $win16_SetDIBitsToDevice) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 442))
      (then (call $win16_CreateDIBitmap) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 19))
      (then (call $win16_dc_point (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 20))
      (then (call $win16_dc_point (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 29))
      (then (call $win16_PatBlt) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 30))
      (then (call $win16_save_restore_dc (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 31))
      (then (call $win16_SetPixel) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 33))
      (then (call $win16_TextOut) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 34))
      (then (call $win16_BitBlt) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 35))
      (then (call $win16_StretchBlt) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 39))
      (then (call $win16_save_restore_dc (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 48))
      (then (call $win16_CreateBitmap) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 83))
      (then (call $win16_dc_point (i32.const 2)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 1))
      (then (call $win16_set_dc_color (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 2))
      (then (call $win16_set_dc_mode (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 4))
      (then (call $win16_set_dc_mode (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 9))
      (then (call $win16_set_dc_color (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 45))
      (then (call $win16_SelectObject) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 51))
      (then (call $win16_CreateCompatibleBitmap) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 52))
      (then (call $win16_CreateCompatibleDC) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 61))
      (then (call $win16_CreatePen) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 66))
      (then (call $win16_CreateSolidBrush) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 68))
      (then (call $win16_DeleteDC) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 69))
      (then (call $win16_DeleteObject) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 93))
      (then (call $win16_GetTextMetrics) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 153))
      (then (call $win16_CreateIC) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 87))
      (then (call $win16_GetStockObject) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 91))
      (then (call $win16_GetTextExtent) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 80))
      (then (call $win16_GetDeviceCaps) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 82))
      (then (call $win16_GetObject) (return (i32.const 1))))
    (i32.const 0))

  ;; The result half of --trace-win16, emitted once the handler has run. DX:AX
  ;; is logged whole because a Win16 DWORD result arrives split across the two.
  (func $win16_trace_ret
    ;; Whatever the API did, it must leave EIP somewhere a 16-bit task can
    ;; execute. Checking here rather than waiting for the decoder to notice
    ;; names the API responsible, which is the whole difficulty: the wild jump
    ;; and the mistake that caused it are otherwise separated by a batch
    ;; boundary and any amount of unrelated code.
    (if (i32.or
          (i32.lt_u (global.get $eip) (global.get $WIN16_ARENA))
          (i32.ge_u (global.get $eip)
            (i32.add (global.get $WIN16_ARENA)
              (i32.mul (global.get $WIN16_SEG_MAX) (i32.const 0x10000)))))
      (then
        (call $host_log_i32 (i32.const 0xCA16A9F8))
        (call $host_log_i32 (global.get $win16_last_module))
        (call $host_log_i32 (global.get $win16_last_ordinal))
        (call $host_log_i32 (global.get $eip))
        (unreachable)))
    (if (global.get $win16_trace)
      (then
        (call $host_log_i32 (i32.const 0xCA16A9EF))
        (call $host_log_i32 (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (call $host_log_i32 (i32.and (global.get $edx) (i32.const 0xFFFF)))
        ;; Where the API is resuming and on what stack. Both are worth seeing:
        ;; a handler that left ESP somewhere unexpected, or an EIP that is not
        ;; the return address the call trace printed, is a frame bug, and those
        ;; are the bugs this layer actually has.
        (call $host_log_i32 (global.get $eip))
        (call $host_log_i32 (global.get $esp)))))

  ;; The dispatcher. $thunk_off is the offset within WIN16_THUNK_SEL that the
  ;; loader wrote into the fixup; $ret_lin is the linear return address, which
  ;; is already on the stack and is passed only so a trap can name it.
  (func $win16_dispatch (export "win16_dispatch") (param $thunk_off i32) (param $ret_lin i32)
    (local $module i32) (local $ordinal i32)
    (local.set $module  (call $win16_thunk_module  (local.get $thunk_off)))
    (local.set $ordinal (call $win16_thunk_ordinal (local.get $thunk_off)))
    (global.set $win16_last_module (local.get $module))
    (global.set $win16_last_ordinal (local.get $ordinal))
    ;; The continuation slot. An API that handed control to a window procedure
    ;; pushed this as the far return address, so arriving here means that
    ;; procedure has returned and the API can finish: put its own result back
    ;; in AX and resume the caller. The offset is past the end of the thunk
    ;; table, so no import can ever be assigned it.
    (if (i32.eq (local.get $thunk_off) (global.get $WIN16_CONT_OFFSET))
      (then
        (global.set $eax (global.get $win16_cont_result))
        (global.set $edx (i32.const 0))
        (call $win16_set_sreg (i32.const 1)
          (i32.shr_u (global.get $win16_cont_ret) (i32.const 16)))
        (global.set $eip (i32.add (global.get $seg_base_cs)
          (i32.and (global.get $win16_cont_ret) (i32.const 0xFFFF))))
        (return)))

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
        (call $host_log_i32 (call $win16_arg16 (i32.const 5)))
        ;; A name import has a name-table offset where the ordinal would be, so
        ;; a reader of this stream has to be told not to look it up.
        (call $host_log_i32 (global.get $win16_last_is_name))))

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
    (if (i32.eq (local.get $module) (i32.const 3))
      (then (if (call $win16_gdi (local.get $ordinal))
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
