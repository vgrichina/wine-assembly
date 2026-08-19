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
  ;; An argument of the Win16 call being dispatched, counted in words from the
  ;; top of the task's stack past the far return address.
  ;;
  ;; It is ESP-relative, and $win16_call32_begin points ESP at the 32-bit
  ;; scratch stack — so reading an argument once the bridge is open returns
  ;; whatever that frame holds at the same offset, which for index 0 is the
  ;; zero written there as a return address. That is a silent wrong answer, and
  ;; it was wrong in ten places: every Win16 GetDlgItem asked for control 0
  ;; whatever id it was given. Hoist arguments into locals before the bridge
  ;; call; this stops rather than lets the next one hide.
  (func $win16_arg16 (param $n i32) (result i32)
    (if (global.get $win16_in_call32)
      (then
        (call $host_log_i32 (i32.const 0xCA16A9FA))
        (call $host_log_i32 (local.get $n))
        (call $host_log_i32 (call $win16_api_key (global.get $win16_last_module)
                                                 (global.get $win16_last_ordinal)))
        (unreachable)))
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
      (i32.shl (global.get $WIN16_HANDLE_MAX) (i32.const 2)))
    ;; The interrupt vectors go with the task: a zero means nothing is hooked,
    ;; which is what a fresh task should see. So do the extra local heaps —
    ;; a selector one run laid a heap into is a different segment in the next.
    (call $zero_memory (call $win16_int_vectors) (i32.const 0x400))
    (call $zero_memory (call $win16_lheap_slot (i32.const 0))
      (i32.mul (global.get $WIN16_LHEAPS) (i32.const 8))))

  ;; 256 far pointers, in the same arena page as the handle table and the DLL
  ;; records. A program that hooks an interrupt saves the old vector and puts
  ;; it back on the way out; nothing here raises interrupts, so what these
  ;; hold only has to be what was last written.
  (func $win16_int_vectors (result i32)
    (i32.add (call $g2w (i32.add (global.get $WIN16_ARENA)
                                 (i32.mul (global.get $WIN16_SEG_MAX) (i32.const 0x10000))))
             (i32.const 0xE000)))

  ;; 16 -> 32. An index the table never handed out is a bug in the translation
  ;; layer, not something to paper over with a zero: it means an API returned a
  ;; raw 32-bit handle, or took one it should have widened.
  ;; Indices start well above the small integers Windows lets an app write
  ;; where a handle goes -- a class background may be COLOR_WINDOW+1 rather
  ;; than a brush, and Hearts does exactly that. Starting at 0x100 makes the
  ;; two unambiguous by construction instead of by guessing at magnitude, and
  ;; anything below the base passes through untouched for the 32-bit side to
  ;; read under the same convention.
  (func $win16_h32 (param $h16 i32) (result i32)
    (local.set $h16 (i32.and (local.get $h16) (i32.const 0xFFFF)))
    (if (i32.eqz (local.get $h16)) (then (return (i32.const 0))))
    ;; 0xFFFF is a sentinel in more places than it is a handle (HWND_BROADCAST,
    ;; and the -1 several APIs take), so it passes through sign-extended.
    (if (i32.eq (local.get $h16) (i32.const 0xFFFF)) (then (return (i32.const -1))))
    (if (i32.lt_u (local.get $h16) (global.get $WIN16_HANDLE_BASE))
      (then (return (local.get $h16))))
    (if (i32.gt_u (i32.sub (local.get $h16) (global.get $WIN16_HANDLE_BASE))
                  (global.get $win16_handle_next))
      (then
        (call $host_log_i32 (i32.const 0xCA16A9F3))
        (call $host_log_i32 (local.get $h16))
        (call $host_log_i32 (global.get $win16_handle_next))
        (unreachable)))
    (i32.load (i32.add (call $win16_handle_table)
                       (i32.shl (i32.sub (local.get $h16) (global.get $WIN16_HANDLE_BASE))
                                (i32.const 2)))))

  ;; 32 -> 16, allocating on first sight. The scan is linear because the table
  ;; holds tens of entries for these apps, not thousands, and a hash would be
  ;; more machinery than the problem has.
  (func $win16_h16 (param $h32 i32) (result i32)
    (local $t i32) (local $i i32)
    (if (i32.eqz (local.get $h32)) (then (return (i32.const 0))))
    ;; No range check on the way in. A 16-bit handle mapped a second time is a
    ;; real bug — it allocates a fresh entry for an object that already has one
    ;; — but it cannot be told from a small 32-bit handle by value: menus are
    ;; numbered from a few hundred and FreeCell's own menu is 0x190. The two
    ;; defences that do work are in $win16_msg_wparam16, which will not narrow
    ;; a DC that is already narrow, and $win16_h16_forget, which gives a slot
    ;; back when its object is destroyed.
    (if (i32.eq (local.get $h32) (i32.const -1)) (then (return (i32.const 0xFFFF))))
    (local.set $t (call $win16_handle_table))
    (local.set $i (i32.const 1))
    (block $done (loop $scan
      (br_if $done (i32.gt_u (local.get $i) (global.get $win16_handle_next)))
      (if (i32.eq (i32.load (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 2))))
                  (local.get $h32))
        (then (return (i32.add (local.get $i) (global.get $WIN16_HANDLE_BASE)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    ;; Reuse a slot whose 32-bit handle has been released before taking a new
    ;; one. A task in its message pump asks for a DC, draws and releases it
    ;; thousands of times; without this the map grows once per iteration and
    ;; runs out — Pipe Dream exhausted it in seven batches of idling.
    (local.set $i (i32.const 1))
    (block $reused (loop $free
      (br_if $reused (i32.gt_u (local.get $i) (global.get $win16_handle_next)))
      (if (i32.eqz (i32.load (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 2)))))
        (then
          (i32.store (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 2)))
                     (local.get $h32))
          (return (i32.add (local.get $i) (global.get $WIN16_HANDLE_BASE)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $free)))
    (if (i32.ge_u (global.get $win16_handle_next) (global.get $WIN16_HANDLE_MAX))
      (then
        (call $host_log_i32 (i32.const 0xCA16A9F4))
        (call $host_log_i32 (local.get $h32))
        ;; The last few entries name what filled it, which is the only thing
        ;; that tells a leak from a table that is simply too small.
        (call $host_log_i32 (global.get $win16_handle_next))
        (call $host_log_i32 (i32.load (i32.add (local.get $t)
          (i32.shl (i32.sub (global.get $win16_handle_next) (i32.const 1)) (i32.const 2)))))
        (call $host_log_i32 (i32.load (i32.add (local.get $t)
          (i32.shl (i32.sub (global.get $win16_handle_next) (i32.const 2)) (i32.const 2)))))
        (call $host_log_i32 (i32.load (i32.add (local.get $t)
          (i32.shl (i32.sub (global.get $win16_handle_next) (i32.const 3)) (i32.const 2)))))
        (unreachable)))
    (global.set $win16_handle_next (i32.add (global.get $win16_handle_next) (i32.const 1)))
    (i32.store (i32.add (local.get $t)
                        (i32.shl (global.get $win16_handle_next) (i32.const 2)))
               (local.get $h32))
    (i32.add (global.get $win16_handle_next) (global.get $WIN16_HANDLE_BASE)))

  ;; Drop a mapping. The 32-bit handle has been released and may be handed out
  ;; again for something else, so keeping the entry would make a stale 16-bit
  ;; handle silently name the new object.
  (func $win16_h16_forget (param $h32 i32)
    (local $t i32) (local $i i32)
    (if (i32.eqz (local.get $h32)) (then (return)))
    (local.set $t (call $win16_handle_table))
    (local.set $i (i32.const 1))
    (block $done (loop $scan
      (br_if $done (i32.gt_u (local.get $i) (global.get $win16_handle_next)))
      (if (i32.eq (i32.load (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 2))))
                  (local.get $h32))
        (then
          (i32.store (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 2)))
                     (i32.const 0))
          (return)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan))))

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
    (global.set $win16_in_call32 (i32.const 1))
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
    (global.set $win16_in_call32 (i32.const 0))
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
    (global.set $win16_in_call32 (i32.const 0))
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
        ;; The command-line block: a length byte at 0x80 and the text at 0x81.
        ;;
        ;; DOS closes that text with a carriage return and this used to as well,
        ;; which is wrong for a Windows task: ES:BX from here is the same
        ;; pointer WinMain is handed as lpCmdLine, and that is documented
        ;; null-terminated. Nothing in the startup converts it — Hearts hands
        ;; the pointer straight to MFC, which asked "is the command line empty?"
        ;; by comparing the first byte, saw 0x0D, and spent the rest of the run
        ;; behaving like it had been told to join somebody else's game.
        ;;
        ;; The carriage return still follows the terminator, so anything reading
        ;; this the DOS way finds the byte it expects one place further on.
        (call $gs8 (i32.add (local.get $base) (i32.const 0x80)) (i32.const 0))
        (call $gs8 (i32.add (local.get $base) (i32.const 0x81)) (i32.const 0))
        (call $gs8 (i32.add (local.get $base) (i32.const 0x82)) (i32.const 0x0D))))

    (global.set $eax (i32.const 1))
    (global.set $ecx (global.get $win16_stack_size))
    (global.set $edx (i32.const 1))   ;; SW_SHOWNORMAL
    (global.set $ebx (i32.const 0x81))
    (global.set $esi (i32.const 0))   ;; no previous instance
    (global.set $edi (global.get $sreg_ds))
    (call $win16_set_sreg (i32.const 0) (global.get $win16_psp_sel))
    (call $win16_api_return (i32.const 0)))

  ;; KERNEL.37 GetCurrentPDB() -> the selector of the task's PSP, which is the
  ;; same block InitTask builds the command line in. Visual Basic 1's runtime
  ;; asks for it before it will start: all five VB games in the pack stop here.
  (func $win16_GetCurrentPDB
    (if (i32.eqz (global.get $win16_psp_sel))
      (then (global.set $win16_psp_sel
              (call $win16_index_to_sel (call $win16_alloc_segment)))))
    (global.set $eax (global.get $win16_psp_sel))
    (global.set $edx (i32.const 0))
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

  ;; KERNEL.57 GetProfileInt / .58 GetProfileString / .59 WriteProfileString —
  ;; the same three calls as the private ones with WIN.INI as the file, which
  ;; is exactly how the 32-bit handlers below implement them too.
  (func $win16_GetProfileInt
    (local $app i32) (local $key i32) (local $def i32)
    (local.set $app (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 4)) (call $win16_arg16 (i32.const 3))))
    (local.set $key (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $def (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 3))
    (call $handle_GetProfileIntA (local.get $app) (local.get $key)
      (local.get $def) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 10)))

  (func $win16_GetProfileString
    (local $app i32) (local $key i32) (local $def i32) (local $buf i32) (local $size i32)
    (local.set $app (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 8)) (call $win16_arg16 (i32.const 7))))
    (local.set $key (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 6)) (call $win16_arg16 (i32.const 5))))
    (local.set $def (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 4)) (call $win16_arg16 (i32.const 3))))
    (local.set $buf (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $size (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 5))
    (call $win16_call32_arg (i32.const 3) (local.get $buf))
    (call $win16_call32_arg (i32.const 4) (local.get $size))
    (call $handle_GetProfileStringA (local.get $app) (local.get $key)
      (local.get $def) (local.get $buf) (local.get $size) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 18)))

  (func $win16_WriteProfileString
    (local $app i32) (local $key i32) (local $val i32)
    (local.set $app (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 5)) (call $win16_arg16 (i32.const 4))))
    (local.set $key (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 3)) (call $win16_arg16 (i32.const 2))))
    (local.set $val (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    ;; A NULL value deletes the key, and it arrives as a null selector.
    (if (i32.eqz (call $win16_arg16 (i32.const 1))) (then (local.set $val (i32.const 0))))
    (call $win16_call32_begin (i32.const 3))
    (call $handle_WriteProfileStringA (local.get $app) (local.get $key)
      (local.get $val) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 12)))

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

  ;; USER.430 lstrcmp / USER.471 lstrcmpi(lpString1, lpString2) -> <0, 0, >0.
  ;; Case folding is ASCII only, which is what the code pages these apps run
  ;; under amount to for the comparisons they make.
  (func $win16_lstrcmp (param $fold i32)
    (local $a i32) (local $b i32) (local $i i32) (local $ca i32) (local $cb i32)
    (local.set $a (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 3)) (call $win16_arg16 (i32.const 2))))
    (local.set $b (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (block $done (loop $cmp
      (local.set $ca (call $gl8 (i32.add (local.get $a) (local.get $i))))
      (local.set $cb (call $gl8 (i32.add (local.get $b) (local.get $i))))
      (if (local.get $fold)
        (then
          (if (i32.and (i32.ge_u (local.get $ca) (i32.const 0x61))
                       (i32.le_u (local.get $ca) (i32.const 0x7A)))
            (then (local.set $ca (i32.sub (local.get $ca) (i32.const 0x20)))))
          (if (i32.and (i32.ge_u (local.get $cb) (i32.const 0x61))
                       (i32.le_u (local.get $cb) (i32.const 0x7A)))
            (then (local.set $cb (i32.sub (local.get $cb) (i32.const 0x20)))))))
      (br_if $done (i32.ne (local.get $ca) (local.get $cb)))
      (br_if $done (i32.eqz (local.get $ca)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cmp)))
    (global.set $eax (i32.and
      (select (i32.const 1) (i32.const -1) (i32.gt_u (local.get $ca) (local.get $cb)))
      (i32.const 0xFFFF)))
    (if (i32.eq (local.get $ca) (local.get $cb)) (then (global.set $eax (i32.const 0))))
    (call $win16_api_return (i32.const 8)))

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
    ;; hInstance is the last argument pushed before the two names.
    (global.set $win16_res_module_id
      (call $win16_res_module (call $win16_arg16 (i32.const 4))))
    (global.set $eax (i32.const 0))
    (if (i32.and (i32.ne (local.get $type) (i32.const -1))
                 (i32.ne (local.get $id) (i32.const -1)))
      (then
        (if (call $win16_find_resource (local.get $type) (local.get $id))
          (then (global.set $eax (call $win16_h16
            (call $win16_res_key (local.get $type) (local.get $id))))))))
    (global.set $win16_res_module_id (i32.const 0))
    (call $win16_api_return (i32.const 10)))

  ;; KERNEL.61 LoadResource(hInstance, hResInfo) — nothing to load yet.
  (func $win16_LoadResource
    (global.set $eax (call $win16_arg16 (i32.const 0)))
    (call $win16_api_return (i32.const 4)))

  ;; KERNEL.64 AccessResource(hInstance, hResInfo) -> a file handle positioned
  ;; at the resource's first byte.
  ;;
  ;; This is the one resource call that hands back a file rather than memory,
  ;; and it means what it says: the module's own file, seeked to where the
  ;; resource starts. Visual Basic reads its forms this way rather than
  ;; through LockResource, so all five VB games stop here.
  ;;
  ;; The image the caller named is already staged, but the file is in the VFS
  ;; under the name GetModuleFileName reports — which is where the loader read
  ;; it from — so opening it again is honest rather than a second copy.
  (func $win16_AccessResource
    (local $key i32) (local $path i32) (local $h i32)
    (local.set $key (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (global.set $win16_res_module_id
      (call $win16_res_module (call $win16_arg16 (i32.const 1))))
    (global.set $eax (i32.const 0xFFFF))
    (if (call $win16_find_resource (i32.shr_u (local.get $key) (i32.const 16))
                                   (i32.and (local.get $key) (i32.const 0xFFFF)))
      (then
        (local.set $path (global.get $GUEST_STACK))
        (call $win16_call32_begin (i32.const 3))
        (call $handle_GetModuleFileNameA (i32.const 0) (local.get $path) (i32.const 260)
          (i32.const 0) (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (call $win16_call32_begin (i32.const 2))
        (call $handle__lopen (local.get $path) (i32.const 0)
          (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (local.set $h (global.get $eax))
        (if (i32.ne (local.get $h) (i32.const -1))
          (then
            (call $win16_call32_begin (i32.const 3))
            (call $handle__llseek (local.get $h) (global.get $win16_res_file_off)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
            (call $win16_call32_end)
            (global.set $eax (call $win16_fh16 (local.get $h)))))))
    (global.set $win16_res_module_id (i32.const 0))
    ;; Two words: an instance handle and a resource handle. Popping six left
    ;; two bytes of the caller's frame behind, and Visual Basic's runtime
    ;; returned through it into nothing a few calls later.
    (call $win16_api_return (i32.const 4)))

  ;; KERNEL.65 SizeofResource(hInstance, hResInfo) -> its length in bytes.
  (func $win16_SizeofResource
    (local $key i32)
    (local.set $key (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (global.set $win16_res_module_id
      (call $win16_res_module (call $win16_arg16 (i32.const 1))))
    (global.set $eax (i32.const 0))
    (if (call $win16_find_resource (i32.shr_u (local.get $key) (i32.const 16))
                                   (i32.and (local.get $key) (i32.const 0xFFFF)))
      (then (global.set $eax (global.get $win16_res_len))))
    (global.set $win16_res_module_id (i32.const 0))
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
  ;; KERNEL.49 GetModuleFileName(hModule, lpFileName, nSize).
  ;;
  ;; A module handle here is what LoadLibrary and GetModuleHandle hand out:
  ;; 0x00D1 over the module id. Answering with the task's own exe whatever was
  ;; asked is what made Visual Basic 1 refuse to start — VBRUN100 asks for its
  ;; own filename, reads that file's header to check it is the runtime it
  ;; thinks it is, found Rattler Race's header instead, and reported "a virus
  ;; has been detected during program initialization".
  (func $win16_GetModuleFileName
    (local $buf i32) (local $size i32) (local $mod i32) (local $id i32)
    (local $slot i32) (local $n i32) (local $i i32)
    (local.set $buf (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $size (call $win16_arg16 (i32.const 0)))
    (local.set $mod (call $win16_h32 (call $win16_arg16 (i32.const 3))))
    (if (i32.eq (i32.and (local.get $mod) (i32.const 0xFFFF0000)) (i32.const 0x00D10000))
      (then
        (local.set $id (i32.and (local.get $mod) (i32.const 0xFFFF)))
        (if (i32.ge_u (local.get $id) (global.get $WIN16_DYNAMIC_BASE))
          (then
            (local.set $slot (call $win16_dynamic_module_slot
              (i32.sub (local.get $id) (global.get $WIN16_DYNAMIC_BASE))))
            (local.set $n (i32.load8_u (local.get $slot)))
            (if (i32.and (i32.ne (local.get $n) (i32.const 0))
                         (i32.gt_u (local.get $size)
                                   (i32.add (local.get $n) (i32.const 7))))
              (then
                ;; "C:\" + the module name + ".DLL", which is where the host
                ;; staged it from and the only path a task can open it by.
                (call $gs8 (local.get $buf) (i32.const 0x43))          ;; C
                (call $gs8 (i32.add (local.get $buf) (i32.const 1)) (i32.const 0x3A))
                (call $gs8 (i32.add (local.get $buf) (i32.const 2)) (i32.const 0x5C))
                (block $named (loop $chars
                  (br_if $named (i32.ge_u (local.get $i) (local.get $n)))
                  (call $gs8 (i32.add (i32.add (local.get $buf) (i32.const 3))
                                      (local.get $i))
                    (i32.load8_u (i32.add (i32.add (local.get $slot) (i32.const 1))
                                          (local.get $i))))
                  (local.set $i (i32.add (local.get $i) (i32.const 1)))
                  (br $chars)))
                (local.set $i (i32.add (local.get $n) (i32.const 3)))
                (call $gs8 (i32.add (local.get $buf) (local.get $i)) (i32.const 0x2E))
                (call $gs8 (i32.add (local.get $buf) (i32.add (local.get $i) (i32.const 1)))
                  (i32.const 0x44))
                (call $gs8 (i32.add (local.get $buf) (i32.add (local.get $i) (i32.const 2)))
                  (i32.const 0x4C))
                (call $gs8 (i32.add (local.get $buf) (i32.add (local.get $i) (i32.const 3)))
                  (i32.const 0x4C))
                (call $gs8 (i32.add (local.get $buf) (i32.add (local.get $i) (i32.const 4)))
                  (i32.const 0))
                (global.set $eax (i32.add (local.get $i) (i32.const 4)))
                (call $win16_api_return (i32.const 8))
                (return)))))))
    (call $win16_call32_begin (i32.const 3))
    (call $handle_GetModuleFileNameA (i32.const 0) (local.get $buf) (local.get $size)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 8)))

  ;; KERNEL.55 Catch(lpCatchBuf) / KERNEL.56 Throw(lpCatchBuf, nErrLevel) —
  ;; Win16's setjmp and longjmp. Catch records where it was called from and
  ;; answers 0; Throw puts execution back there with AX set to its second
  ;; argument, so the same Catch appears to return twice.
  ;;
  ;; The SDK never documented what a CATCHBUF holds, and nothing but these two
  ;; functions ever reads one, so the layout here is ours: SP as it will be
  ;; once Catch has returned, then BP, SI, DI, DS, ES, and the return address
  ;; as IP and CS.
  (func $win16_Catch
    (local $buf i32) (local $ip i32) (local $cs i32)
    (local.set $buf (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $ip (call $gl16 (global.get $esp)))
    (local.set $cs (call $gl16 (i32.add (global.get $esp) (i32.const 2))))
    (call $gs16 (local.get $buf)
      (i32.and (i32.add (global.get $esp) (i32.const 8)) (i32.const 0xFFFF)))
    (call $gs16 (i32.add (local.get $buf) (i32.const 2))
      (i32.and (global.get $ebp) (i32.const 0xFFFF)))
    (call $gs16 (i32.add (local.get $buf) (i32.const 4))
      (i32.and (global.get $esi) (i32.const 0xFFFF)))
    (call $gs16 (i32.add (local.get $buf) (i32.const 6))
      (i32.and (global.get $edi) (i32.const 0xFFFF)))
    (call $gs16 (i32.add (local.get $buf) (i32.const 8)) (global.get $sreg_ds))
    (call $gs16 (i32.add (local.get $buf) (i32.const 10)) (global.get $sreg_es))
    (call $gs16 (i32.add (local.get $buf) (i32.const 12)) (local.get $ip))
    (call $gs16 (i32.add (local.get $buf) (i32.const 14)) (local.get $cs))
    (global.set $eax (i32.const 0))
    (call $win16_api_return (i32.const 4)))

  (func $win16_Throw
    (local $buf i32) (local $n i32)
    (local.set $buf (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $n (call $win16_arg16 (i32.const 0)))
    (call $set_reg16 (i32.const 5) (call $gl16 (i32.add (local.get $buf) (i32.const 2))))
    (call $set_reg16 (i32.const 6) (call $gl16 (i32.add (local.get $buf) (i32.const 4))))
    (call $set_reg16 (i32.const 7) (call $gl16 (i32.add (local.get $buf) (i32.const 6))))
    (call $win16_set_sreg (i32.const 3) (call $gl16 (i32.add (local.get $buf) (i32.const 8))))
    (call $win16_set_sreg (i32.const 0) (call $gl16 (i32.add (local.get $buf) (i32.const 10))))
    (call $win16_set_sreg (i32.const 1) (call $gl16 (i32.add (local.get $buf) (i32.const 14))))
    (global.set $esp (i32.add (global.get $seg_base_ss) (call $gl16 (local.get $buf))))
    (global.set $eip (i32.add (global.get $seg_base_cs)
      (call $gl16 (i32.add (local.get $buf) (i32.const 12)))))
    (global.set $eax (local.get $n))
    (global.set $steps (i32.const 0)))

  ;; ---- The registry ----
  ;;
  ;; The Win 3.1 registry API is the Win32 one at its smallest: HKEY is a
  ;; DWORD in both, and the two calls that exist here take far pointers where
  ;; Win32 takes flat ones.

  ;; KERNEL.218 RegCreateKey(hKey, lpSubKey, lphkResult).
  (func $win16_RegCreateKey
    (local $key i32) (local $sub i32) (local $out i32)
    (local.set $key (call $win16_arg32 (i32.const 4)))
    (local.set $sub (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 3)) (call $win16_arg16 (i32.const 2))))
    (local.set $out (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 3))
    (call $handle_RegCreateKeyA (local.get $key) (local.get $sub) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $edx (i32.shr_u (global.get $eax) (i32.const 16)))
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 12)))

  ;; KERNEL.220 RegCloseKey(hKey), KERNEL.227 RegFlushKey(hKey). Flushing is a
  ;; no-op because the store behind the registry is written through on every
  ;; set; saying so with success is the truthful answer.
  (func $win16_RegCloseKey
    (local $key i32)
    (local.set $key (call $win16_arg32 (i32.const 0)))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_RegCloseKey (local.get $key)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $edx (i32.const 0))
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 4)))

  ;; KERNEL.221 RegSetValue(hKey, lpSubKey, dwType, lpData, cbData).
  (func $win16_RegSetValue
    (local $key i32) (local $sub i32) (local $type i32) (local $data i32) (local $cb i32)
    (local.set $key (call $win16_arg32 (i32.const 7)))
    (local.set $sub (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 6)) (call $win16_arg16 (i32.const 5))))
    (local.set $type (call $win16_arg32 (i32.const 3)))
    (local.set $data (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $cb (call $win16_arg32 (i32.const 0)))
    (call $win16_call32_begin (i32.const 5))
    (call $win16_call32_arg (i32.const 4) (local.get $cb))
    (call $handle_RegSetValueA (local.get $key) (local.get $sub) (local.get $type)
      (local.get $data) (local.get $cb) (i32.const 0))
    (call $win16_call32_end)
    (global.set $edx (i32.const 0))
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 20)))

  ;; KERNEL.225 RegQueryValueEx(hKey, lpValueName, lpReserved, lpType, lpData,
  ;; lpcbData) and KERNEL.226 RegSetValueEx(hKey, lpValueName, dwReserved,
  ;; dwType, lpData, cbData). Six far-or-dword arguments each, 24 bytes.
  (func $win16_reg_value_ex (param $is_set i32)
    (local $key i32) (local $name i32) (local $type i32) (local $data i32)
    (local $cb i32) (local $reserved i32)
    (local.set $key (call $win16_arg32 (i32.const 10)))
    (local.set $name (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 9)) (call $win16_arg16 (i32.const 8))))
    (local.set $reserved (call $win16_arg32 (i32.const 6)))
    (local.set $type (if (result i32) (local.get $is_set)
      (then (call $win16_arg32 (i32.const 4)))
      (else (call $win16_far_to_guest
        (call $win16_arg16 (i32.const 5)) (call $win16_arg16 (i32.const 4))))))
    (local.set $data (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 3)) (call $win16_arg16 (i32.const 2))))
    (local.set $cb (if (result i32) (local.get $is_set)
      (then (call $win16_arg32 (i32.const 0)))
      (else (call $win16_far_to_guest
        (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))))
    (call $win16_call32_begin (i32.const 6))
    (call $win16_call32_arg (i32.const 4) (local.get $data))
    (call $win16_call32_arg (i32.const 5) (local.get $cb))
    (if (local.get $is_set)
      (then (call $handle_RegSetValueExA (local.get $key) (local.get $name)
              (local.get $reserved) (local.get $type) (local.get $data) (i32.const 0)))
      (else (call $handle_RegQueryValueExA (local.get $key) (local.get $name)
              (local.get $reserved) (local.get $type) (local.get $data) (i32.const 0))))
    (call $win16_call32_end)
    (global.set $edx (i32.const 0))
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 24)))

  ;; ---- The local heap ----
  ;;
  ;; A Win16 local handle is a near pointer: an offset within the task's own
  ;; data segment, which is why LocalAlloc can only ever hand out 64KB and why
  ;; LocalLock is free. The loader already grew DGROUP by the heap size the NE
  ;; header asked for, so the heap is that growth, and a handle is the offset
  ;; of the block. Each block carries its size in the two bytes before it, so
  ;; LocalSize and LocalReAlloc have something to read.
  ;;
  ;; Sizes are rounded up to even, so the low bit of a size word is spare and
  ;; carries "this block is free". That makes the heap a walkable chain of
  ;; {size, payload} runs with no separate bookkeeping, which is all a first-fit
  ;; allocator needs. Reuse matters: Solitaire allocates one 26-byte node per
  ;; card and frees all 28 of them on the next deal, so a bump allocator runs a
  ;; 4KB heap dry on the third hand and the game silently stops placing cards.
  (func $win16_lblock_size (param $p i32) (result i32)
    (i32.and (call $gl16 (i32.add (global.get $seg_base_ds) (local.get $p)))
             (i32.const 0xFFFE)))
  (func $win16_lblock_free (param $p i32) (result i32)
    (i32.and (call $gl16 (i32.add (global.get $seg_base_ds) (local.get $p)))
             (i32.const 1)))
  (func $win16_lblock_set (param $p i32) (param $size i32) (param $free i32)
    (call $gs16 (i32.add (global.get $seg_base_ds) (local.get $p))
      (i32.or (local.get $size) (local.get $free))))

  ;; ---- INT 21h ----
  ;;
  ;; A Windows 3.x program is still a DOS program underneath: its C runtime
  ;; opens and reads files through DOS, not through the Windows file API, and
  ;; the compiler emits INT 21h for it. Klotski reads its score file that way
  ;; and Chess its opening book; before this the instruction was decoded as a
  ;; block end and did nothing at all, so both saw a call that neither
  ;; succeeded nor failed and reported the file as unreadable.
  ;;
  ;; Handles are the same 16-bit map the _l* calls use, so a file opened
  ;; through DOS can be closed through KERNEL and the other way about.
  ;;
  ;; The carry flag is the DOS error convention, and $load_eflags is the way to
  ;; set it here: the lazy-flag system has no "just set CF" path, and raw mode
  ;; is exactly what a returning interrupt wants.
  (func $dos_cf (param $set i32)
    (call $load_eflags (select (i32.const 1) (i32.const 0) (local.get $set))))

  ;; The DTA starts where DOS puts it, at offset 0x80 of the PSP — the same
  ;; block InitTask builds the command line in, which is why a program that
  ;; wants both moves one of them first.
  (func $win16_dta_ensure
    (if (i32.eqz (global.get $win16_dta))
      (then
        (if (i32.eqz (global.get $win16_psp_sel))
          (then (global.set $win16_psp_sel
                  (call $win16_index_to_sel (call $win16_alloc_segment)))))
        (global.set $win16_dta (i32.or
          (i32.shl (global.get $win16_psp_sel) (i32.const 16)) (i32.const 0x80))))))

  (func $win16_dta_guest (result i32)
    (call $win16_far_to_guest (i32.shr_u (global.get $win16_dta) (i32.const 16))
                              (i32.and (global.get $win16_dta) (i32.const 0xFFFF))))

  ;; The 43-byte record a DOS directory search leaves behind: 21 bytes the
  ;; search owns, then the attribute, time, date, size and 8.3 name. Times are
  ;; the one fixed stamp this filesystem reports — see AH=57h.
  (func $win16_dos_find_record (param $dta i32) (param $fd i32)
    (local $i i32) (local $ch i32)
    (call $gs8 (i32.add (local.get $dta) (i32.const 21))
      (i32.and (call $gl32 (local.get $fd)) (i32.const 0x3F)))
    (call $gs16 (i32.add (local.get $dta) (i32.const 22)) (i32.const 0))
    (call $gs16 (i32.add (local.get $dta) (i32.const 24)) (i32.const 0x2421))
    (call $gs32 (i32.add (local.get $dta) (i32.const 26))
      (call $gl32 (i32.add (local.get $fd) (i32.const 32))))
    (block $named (loop $chars
      (br_if $named (i32.ge_u (local.get $i) (i32.const 12)))
      (local.set $ch (call $gl8 (i32.add (i32.add (local.get $fd) (i32.const 44))
                                         (local.get $i))))
      ;; DOS names are upper case, and a program that compares them expects it.
      (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x61))
                   (i32.le_u (local.get $ch) (i32.const 0x7A)))
        (then (local.set $ch (i32.sub (local.get $ch) (i32.const 0x20)))))
      (call $gs8 (i32.add (i32.add (local.get $dta) (i32.const 30)) (local.get $i))
        (local.get $ch))
      (br_if $named (i32.eqz (local.get $ch)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $chars)))
    (call $gs8 (i32.add (local.get $dta) (i32.const 42)) (i32.const 0)))

  (func $dos_ptr (result i32)
    (i32.add (global.get $seg_base_ds) (i32.and (global.get $edx) (i32.const 0xFFFF))))

  (func $dos_set_ax (param $v i32)
    (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000))
                             (i32.and (local.get $v) (i32.const 0xFFFF)))))

  (func $win16_dos_int21
    (local $ah i32) (local $h i32) (local $n i32) (local $tmp i32)
    (local.set $ah (i32.and (i32.shr_u (global.get $eax) (i32.const 8)) (i32.const 0xFF)))
    ;; --trace-win16 covers the DOS side too: AH, and the three registers that
    ;; carry a handle, a count and a pointer for the calls that have them.
    (if (global.get $win16_trace)
      (then
        (call $host_log_i32 (i32.const 0xCA16D021))
        (call $host_log_i32 (local.get $ah))
        (call $host_log_i32 (i32.and (global.get $ebx) (i32.const 0xFFFF)))
        (call $host_log_i32 (i32.and (global.get $ecx) (i32.const 0xFFFF)))
        (call $host_log_i32 (i32.and (global.get $edx) (i32.const 0xFFFF)))))

    ;; 3Dh open, AL = access mode, DS:DX = path.
    (if (i32.eq (local.get $ah) (i32.const 0x3D))
      (then
        (call $win16_call32_begin (i32.const 2))
        (call $handle__lopen (call $dos_ptr) (i32.and (global.get $eax) (i32.const 3))
          (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (if (i32.eq (global.get $eax) (i32.const -1))
          (then (call $dos_set_ax (i32.const 2)) (call $dos_cf (i32.const 1)))  ;; file not found
          (else
            (call $dos_set_ax (call $win16_fh16 (global.get $eax)))
            (call $dos_cf (i32.const 0))))
        (return)))

    ;; 3Ch create / 5Bh create new, CX = attributes, DS:DX = path.
    (if (i32.or (i32.eq (local.get $ah) (i32.const 0x3C))
                (i32.eq (local.get $ah) (i32.const 0x5B)))
      (then
        (call $win16_call32_begin (i32.const 2))
        (call $handle__lcreat (call $dos_ptr)
          (i32.and (global.get $ecx) (i32.const 0xFFFF))
          (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (if (i32.eq (global.get $eax) (i32.const -1))
          (then (call $dos_set_ax (i32.const 3)) (call $dos_cf (i32.const 1)))  ;; path not found
          (else
            (call $dos_set_ax (call $win16_fh16 (global.get $eax)))
            (call $dos_cf (i32.const 0))))
        (return)))

    ;; 3Eh close, BX = handle.
    (if (i32.eq (local.get $ah) (i32.const 0x3E))
      (then
        (local.set $h (call $win16_fh32 (i32.and (global.get $ebx) (i32.const 0xFFFF))))
        (call $win16_call32_begin (i32.const 1))
        (call $handle__lclose (local.get $h) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (call $win16_fh_forget (i32.and (global.get $ebx) (i32.const 0xFFFF)))
        (call $win16_h16_forget (local.get $h))
        (call $dos_cf (i32.const 0))
        (return)))

    ;; 3Fh read / 40h write, BX = handle, CX = bytes, DS:DX = buffer.
    (if (i32.or (i32.eq (local.get $ah) (i32.const 0x3F))
                (i32.eq (local.get $ah) (i32.const 0x40)))
      (then
        (local.set $h (call $win16_fh32 (i32.and (global.get $ebx) (i32.const 0xFFFF))))
        (local.set $n (i32.and (global.get $ecx) (i32.const 0xFFFF)))
        (call $win16_call32_begin (i32.const 3))
        (if (i32.eq (local.get $ah) (i32.const 0x3F))
          (then (call $handle__lread (local.get $h) (call $dos_ptr) (local.get $n)
                  (i32.const 0) (i32.const 0) (i32.const 0)))
          (else (call $handle__lwrite (local.get $h) (call $dos_ptr) (local.get $n)
                  (i32.const 0) (i32.const 0) (i32.const 0))))
        (call $win16_call32_end)
        (if (i32.eq (global.get $eax) (i32.const -1))
          (then (call $dos_set_ax (i32.const 5)) (call $dos_cf (i32.const 1)))  ;; access denied
          (else
            (call $dos_set_ax (global.get $eax))
            (call $dos_cf (i32.const 0))))
        (return)))

    ;; 42h lseek, BX = handle, CX:DX = offset, AL = origin. DX:AX = new position.
    (if (i32.eq (local.get $ah) (i32.const 0x42))
      (then
        (local.set $h (call $win16_fh32 (i32.and (global.get $ebx) (i32.const 0xFFFF))))
        (local.set $tmp (i32.or (i32.and (global.get $edx) (i32.const 0xFFFF))
          (i32.shl (i32.and (global.get $ecx) (i32.const 0xFFFF)) (i32.const 16))))
        (call $win16_call32_begin (i32.const 3))
        (call $handle__llseek (local.get $h) (local.get $tmp)
          (i32.and (global.get $eax) (i32.const 0xFF))
          (i32.const 0) (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (if (i32.eq (global.get $eax) (i32.const -1))
          (then (call $dos_set_ax (i32.const 6)) (call $dos_cf (i32.const 1)))  ;; bad handle
          (else
            (global.set $edx (i32.shr_u (global.get $eax) (i32.const 16)))
            (call $dos_set_ax (global.get $eax))
            (call $dos_cf (i32.const 0))))
        (return)))

    ;; 41h delete, DS:DX = path.
    (if (i32.eq (local.get $ah) (i32.const 0x41))
      (then
        (call $win16_call32_begin (i32.const 1))
        (call $handle_DeleteFileA (call $dos_ptr) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (call $dos_cf (i32.eqz (global.get $eax)))
        (if (i32.eqz (global.get $eax)) (then (call $dos_set_ax (i32.const 2))))
        (return)))

    ;; 43h get/set file attributes, DS:DX = path. AL=0 reads into CX.
    (if (i32.eq (local.get $ah) (i32.const 0x43))
      (then
        (if (i32.eqz (i32.and (global.get $eax) (i32.const 0xFF)))
          (then
            (call $win16_call32_begin (i32.const 1))
            (call $handle_GetFileAttributesA (call $dos_ptr) (i32.const 0) (i32.const 0)
              (i32.const 0) (i32.const 0) (i32.const 0))
            (call $win16_call32_end)
            (if (i32.eq (global.get $eax) (i32.const -1))
              (then (call $dos_set_ax (i32.const 2)) (call $dos_cf (i32.const 1)))
              (else
                (global.set $ecx (i32.and (global.get $eax) (i32.const 0x27)))
                (call $dos_cf (i32.const 0)))))
          ;; Setting attributes has nowhere to go — the VFS keeps none — and
          ;; saying so is better than reporting a change that did not happen.
          (else (call $dos_set_ax (i32.const 5)) (call $dos_cf (i32.const 1))))
        (return)))

    ;; 44h IOCTL, AL=0: what kind of handle is this? Everything opened here is
    ;; a file on drive C, never a character device.
    (if (i32.eq (local.get $ah) (i32.const 0x44))
      (then
        (if (i32.eqz (i32.and (global.get $eax) (i32.const 0xFF)))
          (then
            (global.set $edx (i32.const 2))
            (call $dos_set_ax (i32.const 2))
            (call $dos_cf (i32.const 0)))
          (else (call $dos_set_ax (i32.const 1)) (call $dos_cf (i32.const 1))))
        (return)))

    ;; 2Ah date and 2Ch time, from the same clock the Windows calls read.
    (if (i32.or (i32.eq (local.get $ah) (i32.const 0x2A))
                (i32.eq (local.get $ah) (i32.const 0x2C)))
      (then
        (local.set $tmp (global.get $GUEST_STACK))
        (call $win16_call32_begin (i32.const 1))
        (call $handle_GetLocalTime (local.get $tmp) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (if (i32.eq (local.get $ah) (i32.const 0x2A))
          (then
            (global.set $ecx (call $gl16 (local.get $tmp)))                    ;; year
            (global.set $edx (i32.or
              (i32.shl (call $gl16 (i32.add (local.get $tmp) (i32.const 2)))
                       (i32.const 8))                                          ;; month
              (call $gl16 (i32.add (local.get $tmp) (i32.const 6)))))           ;; day
            (call $dos_set_ax (call $gl16 (i32.add (local.get $tmp) (i32.const 4)))))
          (else
            (global.set $ecx (i32.or
              (i32.shl (call $gl16 (i32.add (local.get $tmp) (i32.const 8)))
                       (i32.const 8))                                          ;; hour
              (call $gl16 (i32.add (local.get $tmp) (i32.const 10)))))          ;; minute
            (global.set $edx (i32.or
              (i32.shl (call $gl16 (i32.add (local.get $tmp) (i32.const 12)))
                       (i32.const 8))                                          ;; second
              (i32.div_u (call $gl16 (i32.add (local.get $tmp) (i32.const 14)))
                         (i32.const 10))))                                     ;; hundredths
            (call $dos_set_ax (i32.const 0))))
        (call $dos_cf (i32.const 0))
        (return)))

    ;; 1Ah set / 2Fh get the disk transfer area, which is where a directory
    ;; search puts what it finds. DOS starts it at PSP:0080 and a program that
    ;; wants it elsewhere says so; IdleWild does, before listing its modules.
    (if (i32.eq (local.get $ah) (i32.const 0x1A))
      (then
        (global.set $win16_dta (i32.or
          (i32.shl (global.get $sreg_ds) (i32.const 16))
          (i32.and (global.get $edx) (i32.const 0xFFFF))))
        (call $dos_cf (i32.const 0))
        (return)))
    (if (i32.eq (local.get $ah) (i32.const 0x2F))
      (then
        (call $win16_dta_ensure)
        (global.set $ebx (i32.and (global.get $win16_dta) (i32.const 0xFFFF)))
        (call $win16_set_sreg (i32.const 0)
          (i32.shr_u (global.get $win16_dta) (i32.const 16)))
        (call $dos_cf (i32.const 0))
        (return)))

    ;; 4Eh find first (DS:DX = pattern, CX = attributes) and 4Fh find next.
    ;; Both fill the DTA with a DOS find record, whose first bytes are the
    ;; search's own state — which is where the handle the 32-bit side gave us
    ;; goes, exactly as DOS keeps its search state there.
    (if (i32.or (i32.eq (local.get $ah) (i32.const 0x4E))
                (i32.eq (local.get $ah) (i32.const 0x4F)))
      (then
        (call $win16_dta_ensure)
        (local.set $tmp (global.get $GUEST_STACK))
        (local.set $h (call $win16_dta_guest))
        (call $win16_call32_begin (i32.const 2))
        (if (i32.eq (local.get $ah) (i32.const 0x4E))
          (then (call $handle_FindFirstFileA (call $dos_ptr) (local.get $tmp)
                  (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
          (else (call $handle_FindNextFileA (call $gl32 (local.get $h)) (local.get $tmp)
                  (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
        (call $win16_call32_end)
        (if (i32.or (i32.eqz (global.get $eax))
                    (i32.eq (global.get $eax) (i32.const -1)))
          (then
            (call $dos_set_ax (i32.const 18))   ;; no more files
            (call $dos_cf (i32.const 1))
            (return)))
        (if (i32.eq (local.get $ah) (i32.const 0x4E))
          (then (call $gs32 (local.get $h) (global.get $eax))))
        (call $win16_dos_find_record (local.get $h) (local.get $tmp))
        (call $dos_set_ax (i32.const 0))
        (call $dos_cf (i32.const 0))
        (return)))

    ;; 47h get current directory, DL = drive, DS:SI = 64-byte buffer. The
    ;; answer has no leading backslash, so the root is the empty string.
    ;; IdleWild asks before it looks for its screen-saver modules.
    (if (i32.eq (local.get $ah) (i32.const 0x47))
      (then
        (call $gs8 (i32.add (global.get $seg_base_ds)
                            (i32.and (global.get $esi) (i32.const 0xFFFF)))
          (i32.const 0))
        (call $dos_set_ax (i32.const 0x0100))
        (call $dos_cf (i32.const 0))
        (return)))

    ;; 57h file date and time, BX = handle. The filesystem here keeps none —
    ;; what persists is the content — so a read answers with one fixed
    ;; timestamp rather than a different invented one each call, and a write is
    ;; accepted and forgotten. Klotski stamps its score file this way.
    (if (i32.eq (local.get $ah) (i32.const 0x57))
      (then
        (if (i32.eqz (i32.and (global.get $eax) (i32.const 0xFF)))
          (then
            (global.set $ecx (i32.const 0))            ;; 00:00:00
            (global.set $edx (i32.const 0x2421))))     ;; 1998-01-01
        (call $dos_set_ax (i32.const 0))
        (call $dos_cf (i32.const 0))
        (return)))

    ;; 30h version — 6.22, which is what Windows 3.x shipped on.
    (if (i32.eq (local.get $ah) (i32.const 0x30))
      (then
        (call $dos_set_ax (i32.const 0x1606))
        (global.set $ebx (i32.const 0))
        (global.set $ecx (i32.const 0))
        (call $dos_cf (i32.const 0))
        (return)))

    ;; 35h get vector (AL = number) -> ES:BX, and 25h set vector (DS:DX).
    ;; Klotski hooks one on the way in and restores it on the way out.
    (if (i32.eq (local.get $ah) (i32.const 0x35))
      (then
        (local.set $tmp (i32.load (i32.add (call $win16_int_vectors)
          (i32.shl (i32.and (global.get $eax) (i32.const 0xFF)) (i32.const 2)))))
        (global.set $ebx (i32.and (local.get $tmp) (i32.const 0xFFFF)))
        (call $win16_set_sreg (i32.const 0) (i32.shr_u (local.get $tmp) (i32.const 16)))
        (call $dos_cf (i32.const 0))
        (return)))
    (if (i32.eq (local.get $ah) (i32.const 0x25))
      (then
        (i32.store (i32.add (call $win16_int_vectors)
                            (i32.shl (i32.and (global.get $eax) (i32.const 0xFF))
                                     (i32.const 2)))
          (i32.or (i32.shl (global.get $sreg_ds) (i32.const 16))
                  (i32.and (global.get $edx) (i32.const 0xFFFF))))
        (call $dos_cf (i32.const 0))
        (return)))

    ;; 19h current drive: C, which is the only one mounted.
    (if (i32.eq (local.get $ah) (i32.const 0x19))
      (then (call $dos_set_ax (i32.const 2)) (call $dos_cf (i32.const 0)) (return)))

    ;; 4Ch terminate, AL = exit code.
    (if (i32.eq (local.get $ah) (i32.const 0x4C))
      (then
        (call $host_exit (i32.and (global.get $eax) (i32.const 0xFF)))
        (global.set $eip (i32.const 0))
        (global.set $steps (i32.const 0))
        (return)))

    ;; Anything else stops and says which call it was, on the same reasoning as
    ;; the unimplemented-API path: a DOS function that quietly returns nothing
    ;; is indistinguishable from one that worked and found nothing.
    (call $host_log_i32 (i32.const 0xCA16D05F))
    (call $host_log_i32 (local.get $ah))
    (call $host_log_i32 (global.get $eip))
    (unreachable))

  ;; KERNEL.4 LocalInit(hSegment, pStart, pEnd) — lay a local heap between two
  ;; offsets in a segment. The task's own heap is already built by the loader
  ;; from the header's request; this is a program asking for a different one,
  ;; which Visual Basic 1's runtime does before it allocates anything.
  ;;
  ;; There is one local heap here, described by offsets and reached through
  ;; whatever DS holds — so pointing it at the new range is the whole of it,
  ;; and a second LocalInit replaces the first rather than adding to it. That
  ;; matches every caller in this corpus; a task that wanted two would find
  ;; its first heap's blocks unreachable, which is why this says so.
  ;; ---- Local heaps other than the task's own ----
  ;;
  ;; A task's DGROUP heap is built by the loader from the header's request and
  ;; described by the three globals below. LocalInit is a program asking for
  ;; another one, and the segment it names is usually not DGROUP: Visual Basic
  ;; 1's runtime lays two heaps into blocks it has just allocated. Writing
  ;; those through DS zeroed two kilobytes of the task's own data segment.
  ;;
  ;; Each extra heap is remembered by its selector, and LocalAlloc picks the
  ;; one matching DS — which is how Windows resolves it too, since every local
  ;; call there is implicitly about the current data segment.
  (global $WIN16_LHEAPS i32 (i32.const 8))

  (func $win16_lheap_slot (param $i i32) (result i32)
    (i32.add (call $g2w (i32.add (global.get $WIN16_ARENA)
                                 (i32.mul (global.get $WIN16_SEG_MAX) (i32.const 0x10000))))
             (i32.add (i32.const 0xE400) (i32.mul (local.get $i) (i32.const 8)))))

  ;; The slot for the current DS, or -1 when this is the task's own heap.
  (func $win16_lheap_current (result i32)
    (local $i i32) (local $p i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $WIN16_LHEAPS)))
      (local.set $p (call $win16_lheap_slot (local.get $i)))
      (if (i32.eq (i32.load16_u (local.get $p)) (global.get $sreg_ds))
        (then (return (local.get $p))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  ;; base/ptr/end of whichever heap the current DS names.
  (func $win16_lheap_get (param $field i32) (result i32)
    (local $p i32)
    (local.set $p (call $win16_lheap_current))
    (if (i32.eq (local.get $p) (i32.const -1))
      (then
        (if (i32.eq (local.get $field) (i32.const 0))
          (then (return (global.get $win16_lheap_base))))
        (if (i32.eq (local.get $field) (i32.const 1))
          (then (return (global.get $win16_lheap_ptr))))
        (return (global.get $win16_lheap_end))))
    (i32.load16_u (i32.add (local.get $p)
                           (i32.mul (i32.add (local.get $field) (i32.const 1))
                                    (i32.const 2)))))

  (func $win16_lheap_set_ptr (param $v i32)
    (local $p i32)
    (local.set $p (call $win16_lheap_current))
    (if (i32.eq (local.get $p) (i32.const -1))
      (then (global.set $win16_lheap_ptr (local.get $v)) (return)))
    (i32.store16 (i32.add (local.get $p) (i32.const 4)) (local.get $v)))

  ;; The heap's ceiling. A local heap grows: Windows reallocates the segment
  ;; under it when a block will not fit, whether that segment is the task's
  ;; DGROUP or one a task laid a second heap into with LocalInit.
  (func $win16_lheap_set_end (param $v i32)
    (local $p i32)
    (local.set $p (call $win16_lheap_current))
    (if (i32.eq (local.get $p) (i32.const -1))
      (then (global.set $win16_lheap_end (local.get $v)) (return)))
    (i32.store16 (i32.add (local.get $p) (i32.const 6)) (local.get $v)))

  (func $win16_LocalInit
    (local $start i32) (local $end i32) (local $sel i32) (local $base i32)
    (local $i i32) (local $p i32) (local $slot i32)
    (local.set $end (call $win16_arg16 (i32.const 0)))
    (local.set $start (call $win16_arg16 (i32.const 1)))
    (local.set $sel (call $win16_arg16 (i32.const 2)))
    ;; A zero segment means the caller's own, which is what DS holds.
    (if (i32.eqz (local.get $sel)) (then (local.set $sel (global.get $sreg_ds))))
    (local.set $base (call $win16_seg_base (call $win16_sel_to_index (local.get $sel))))
    (if (i32.or (i32.ge_u (local.get $start) (local.get $end))
                (i32.eqz (local.get $base)))
      (then
        (global.set $eax (i32.const 0))
        (call $win16_api_return (i32.const 6))
        (return)))
    (call $zero_memory (call $g2w (i32.add (local.get $base) (local.get $start)))
      (i32.sub (local.get $end) (local.get $start)))
    ;; The task's own DGROUP keeps its heap in the globals; anything else takes
    ;; a slot, reusing the one that already describes this segment.
    (if (i32.eq (local.get $sel)
                (call $win16_index_to_sel (global.get $win16_auto_data)))
      (then
        (global.set $win16_lheap_base (local.get $start))
        (global.set $win16_lheap_ptr (local.get $start))
        (global.set $win16_lheap_end (local.get $end)))
      (else
        (local.set $slot (i32.const -1))
        (block $found (loop $scan
          (br_if $found (i32.ge_u (local.get $i) (global.get $WIN16_LHEAPS)))
          (local.set $p (call $win16_lheap_slot (local.get $i)))
          (if (i32.or (i32.eq (i32.load16_u (local.get $p)) (local.get $sel))
                      (i32.eqz (i32.load16_u (local.get $p))))
            (then (local.set $slot (local.get $p)) (br $found)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $scan)))
        (if (i32.eq (local.get $slot) (i32.const -1))
          (then
            (call $host_log_i32 (i32.const 0xCA16104F))   ;; no room for another heap
            (call $host_log_i32 (local.get $sel))
            (unreachable)))
        (i32.store16 (local.get $slot) (local.get $sel))
        (i32.store16 (i32.add (local.get $slot) (i32.const 2)) (local.get $start))
        (i32.store16 (i32.add (local.get $slot) (i32.const 4)) (local.get $start))
        (i32.store16 (i32.add (local.get $slot) (i32.const 6)) (local.get $end))))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 6)))

  ;; LocalAlloc(wFlags, wBytes). A moveable block answers with a *handle*, and
  ;; the difference is not cosmetic: the caller dereferences it to reach the
  ;; block. Visual Basic registers every control with
  ;; LocalAlloc(LMEM_MOVEABLE|LMEM_ZEROINIT, 0x1f), reads the word at the
  ;; handle to get the record, and writes the control's model pointer there —
  ;; so with a handle that was really the record itself it wrote the model
  ;; through a null pointer, and the control it had just registered could not
  ;; be found again. That is VB error 363, "custom control not found".
  ;;
  ;; The handle is the first word of the block and holds the address of the
  ;; two bytes after it, which is where the caller's data starts. Nothing here
  ;; moves a block, so that word never has to change; it is what makes the
  ;; handle dereferenceable, and what LocalLock recognises.
  (func $win16_LocalAlloc
    (local $bytes i32) (local $h i32) (local $p i32) (local $size i32) (local $limit i32)
    (local $moveable i32)
    (local.set $moveable (i32.and (call $win16_arg16 (i32.const 1)) (i32.const 2)))
    (local.set $bytes (i32.and (i32.add (call $win16_arg16 (i32.const 0)) (i32.const 1))
                               (i32.const 0xFFFE)))
    (if (local.get $moveable)
      (then (local.set $bytes (i32.add (local.get $bytes) (i32.const 2)))))
    ;; A zero-length block would make the walk below stand still.
    (if (i32.eqz (local.get $bytes)) (then (local.set $bytes (i32.const 2))))

    ;; First fit across the blocks already handed out. Which heap that is comes
    ;; from DS, so a task that has laid a second one into another segment and
    ;; pointed DS at it allocates from that one.
    (local.set $p (call $win16_lheap_get (i32.const 0)))
    (block $found
      (loop $walk
        (br_if $found (i32.ge_u (local.get $p) (call $win16_lheap_get (i32.const 1))))
        (local.set $size (call $win16_lblock_size (local.get $p)))
        (if (i32.and (call $win16_lblock_free (local.get $p))
                     (i32.ge_u (local.get $size) (local.get $bytes)))
          (then
            ;; Split only when the tail can hold a header and a payload of its
            ;; own; otherwise the block goes out whole and its slack is lost
            ;; until it is freed again.
            (if (i32.ge_u (i32.sub (local.get $size) (local.get $bytes)) (i32.const 4))
              (then
                (call $win16_lblock_set
                  (i32.add (i32.add (local.get $p) (i32.const 2)) (local.get $bytes))
                  (i32.sub (i32.sub (local.get $size) (local.get $bytes)) (i32.const 2))
                  (i32.const 1))
                (call $win16_lblock_set (local.get $p) (local.get $bytes) (i32.const 0)))
              (else
                (call $win16_lblock_set (local.get $p) (local.get $size) (i32.const 0))
                (local.set $bytes (local.get $size))))
            (local.set $h (i32.add (local.get $p) (i32.const 2)))
            (call $zero_memory
              (call $g2w (i32.add (global.get $seg_base_ds) (local.get $h)))
              (local.get $bytes))
            (call $win16_lmoveable (local.get $h) (local.get $moveable))
            (global.set $eax (local.get $h))
            (call $win16_api_return (i32.const 4))
            (return)))
        (local.set $p (i32.add (i32.add (local.get $p) (i32.const 2)) (local.get $size)))
        (br $walk)))

    (local.set $h (i32.add (call $win16_lheap_get (i32.const 1)) (i32.const 2)))
    (if (i32.gt_u (i32.add (local.get $h) (local.get $bytes))
                  (call $win16_lheap_get (i32.const 2)))
      (then
        ;; The heap the header asked for is a starting size, not a ceiling:
        ;; Windows grows the local heap upward into whatever DGROUP space the
        ;; stack has not reached. Life Genesis declares a 1KB heap, allocates
        ;; its cell grid out of it, and reported "out of memory" the moment
        ;; that ran out. Growing is only safe for the task's own DGROUP, where
        ;; SP says how far the stack has come down; a heap laid into some other
        ;; segment by LocalInit keeps the bounds it was given.
        (if (i32.and (i32.eq (call $win16_lheap_current) (i32.const -1))
                     (i32.eq (global.get $sreg_ss) (global.get $sreg_ds)))
          (then
            (local.set $limit (i32.sub
              (i32.and (i32.sub (global.get $esp) (global.get $seg_base_ss))
                       (i32.const 0xFFFF))
              (i32.const 512)))
            (if (i32.gt_u (local.get $limit) (global.get $win16_lheap_end))
              (then (global.set $win16_lheap_end (local.get $limit))))))
        ;; Still short, and the heap is the task's own: grow the segment under
        ;; it. That is what Windows does — LocalAlloc reallocates DGROUP when
        ;; its heap is full — and it is the only way up for a heap that sits
        ;; above the stack rather than below it, which is where a task that
        ;; laid out its own DGROUP put it. Visual Basic asks for an eight
        ;; kilobyte block out of a four kilobyte heap while loading its form.
        (if (i32.gt_u (i32.add (local.get $h) (local.get $bytes))
                      (call $win16_lheap_get (i32.const 2)))
          (then
            (local.set $limit (i32.add (local.get $h) (local.get $bytes)))
            (if (i32.le_u (local.get $limit) (i32.const 0x10000))
              (then
                (local.set $p (call $win16_sel_to_index (global.get $sreg_ds)))
                (if (i32.gt_u (local.get $limit) (call $win16_seg_limit (local.get $p)))
                  (then
                    (call $win16_gseg_store (local.get $p) (i32.const 4)
                      (local.get $limit))
                    (call $win16_gseg_store (local.get $p) (i32.const 12)
                      (local.get $limit))))
                (call $win16_lheap_set_end (local.get $limit))))))
        (if (i32.gt_u (i32.add (local.get $h) (local.get $bytes))
                      (call $win16_lheap_get (i32.const 2)))
          (then
            (global.set $eax (i32.const 0))
            (call $win16_api_return (i32.const 4))
            (return)))))
    (call $win16_lblock_set (call $win16_lheap_get (i32.const 1))
      (local.get $bytes) (i32.const 0))
    (call $win16_lheap_set_ptr (i32.add (local.get $h) (local.get $bytes)))
    ;; LMEM_ZEROINIT is the common flag and zeroing unconditionally is both
    ;; cheap and what every caller here expects of fresh memory.
    (call $zero_memory (call $g2w (i32.add (global.get $seg_base_ds) (local.get $h)))
      (local.get $bytes))
    (call $win16_lmoveable (local.get $h) (local.get $moveable))
    (global.set $eax (local.get $h))
    (call $win16_api_return (i32.const 4)))

  ;; Turn a freshly allocated block into a moveable one: its first word points
  ;; at the two bytes after it. LocalLock reads that word back.
  (func $win16_lmoveable (param $h i32) (param $moveable i32)
    (if (local.get $moveable)
      (then (call $gs16 (i32.add (global.get $seg_base_ds) (local.get $h))
              (i32.add (local.get $h) (i32.const 2))))))

  ;; LocalLock(hMem) -> the block. A fixed handle is already the block; a
  ;; moveable one holds the address of the block in its first word, and says
  ;; so by holding exactly the address two bytes along. Nothing else here
  ;; writes that pattern, and a caller that wrote it over its own data would
  ;; be pointing at its own second word either way.
  (func $win16_LocalLock
    (local $h i32) (local $w i32)
    (local.set $h (call $win16_arg16 (i32.const 0)))
    (local.set $w (call $gl16 (i32.add (global.get $seg_base_ds) (local.get $h))))
    (global.set $eax (select (local.get $w) (local.get $h)
      (i32.eq (local.get $w) (i32.add (local.get $h) (i32.const 2)))))
    (call $win16_api_return (i32.const 2)))

  ;; KERNEL.6 LocalReAlloc(hMem, wBytes, wFlags) -> the block, resized.
  ;;
  ;; Shrinking, or growing into slack the block already has, is free. Growing
  ;; the last block in the heap extends the bump pointer. Anything else takes
  ;; a fresh block, copies, and frees the old one — nothing here ever moves a
  ;; block behind the caller's back, so a moveable handle keeps pointing at
  ;; its own data either way. Visual Basic resizes its control list as a form
  ;; is built.
  (func $win16_LocalReAlloc
    (local $h i32) (local $bytes i32) (local $p i32) (local $size i32)
    (local $mov i32) (local $new i32) (local $i i32) (local $copy i32)
    (local.set $h (call $win16_arg16 (i32.const 2)))
    (local.set $bytes (i32.and (i32.add (call $win16_arg16 (i32.const 1)) (i32.const 1))
                               (i32.const 0xFFFE)))
    (if (i32.eqz (local.get $bytes)) (then (local.set $bytes (i32.const 2))))
    (if (i32.or (i32.eqz (local.get $h))
                (i32.lt_u (local.get $h) (i32.add (call $win16_lheap_get (i32.const 0))
                                                  (i32.const 2))))
      (then
        (global.set $eax (i32.const 0))
        (call $win16_api_return (i32.const 6))
        (return)))
    (local.set $p (i32.sub (local.get $h) (i32.const 2)))
    (local.set $size (call $win16_lblock_size (local.get $p)))
    (local.set $mov (i32.eq
      (call $gl16 (i32.add (global.get $seg_base_ds) (local.get $h)))
      (i32.add (local.get $h) (i32.const 2))))
    (if (local.get $mov) (then (local.set $bytes (i32.add (local.get $bytes) (i32.const 2)))))
    (if (i32.le_u (local.get $bytes) (local.get $size))
      (then
        (global.set $eax (local.get $h))
        (call $win16_api_return (i32.const 6))
        (return)))
    ;; The last block can simply take more of the heap.
    (if (i32.and (i32.eq (i32.add (local.get $h) (local.get $size))
                         (call $win16_lheap_get (i32.const 1)))
                 (i32.le_u (i32.add (local.get $h) (local.get $bytes))
                           (call $win16_lheap_get (i32.const 2))))
      (then
        (call $zero_memory
          (call $g2w (i32.add (global.get $seg_base_ds)
                              (i32.add (local.get $h) (local.get $size))))
          (i32.sub (local.get $bytes) (local.get $size)))
        (call $win16_lblock_set (local.get $p) (local.get $bytes) (i32.const 0))
        (call $win16_lheap_set_ptr (i32.add (local.get $h) (local.get $bytes)))
        (global.set $eax (local.get $h))
        (call $win16_api_return (i32.const 6))
        (return)))
    ;; Otherwise a fresh block at the top of the heap, and the old one back.
    (local.set $new (i32.add (call $win16_lheap_get (i32.const 1)) (i32.const 2)))
    (if (i32.gt_u (i32.add (local.get $new) (local.get $bytes))
                  (call $win16_lheap_get (i32.const 2)))
      (then
        (global.set $eax (i32.const 0))
        (call $win16_api_return (i32.const 6))
        (return)))
    (call $win16_lblock_set (call $win16_lheap_get (i32.const 1))
      (local.get $bytes) (i32.const 0))
    (call $win16_lheap_set_ptr (i32.add (local.get $new) (local.get $bytes)))
    (call $zero_memory (call $g2w (i32.add (global.get $seg_base_ds) (local.get $new)))
      (local.get $bytes))
    (local.set $copy (select (local.get $bytes) (local.get $size)
      (i32.lt_u (local.get $bytes) (local.get $size))))
    (block $copied (loop $byte
      (br_if $copied (i32.ge_u (local.get $i) (local.get $copy)))
      (call $gs8 (i32.add (i32.add (global.get $seg_base_ds) (local.get $new))
                          (local.get $i))
        (call $gl8 (i32.add (i32.add (global.get $seg_base_ds) (local.get $h))
                            (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $byte)))
    (call $win16_lmoveable (local.get $new) (local.get $mov))
    (call $win16_lblock_set (local.get $p) (local.get $size) (i32.const 1))
    (global.set $eax (local.get $new))
    (call $win16_api_return (i32.const 6)))

  ;; Mark the block free, absorb any free blocks that follow it, and give the
  ;; space straight back to the bump pointer when it turns out to be the last
  ;; one — without that the heap only ever grows by its high-water mark.
  (func $win16_LocalFree
    (local $p i32) (local $size i32) (local $next i32)
    (local.set $p (i32.sub (call $win16_arg16 (i32.const 0)) (i32.const 2)))
    (if (i32.or (i32.lt_u (local.get $p) (call $win16_lheap_get (i32.const 0)))
                (i32.ge_u (local.get $p) (call $win16_lheap_get (i32.const 1))))
      (then
        (global.set $eax (i32.const 0))
        (call $win16_api_return (i32.const 2))
        (return)))
    (local.set $size (call $win16_lblock_size (local.get $p)))
    (block $done
      (loop $merge
        (local.set $next (i32.add (i32.add (local.get $p) (i32.const 2)) (local.get $size)))
        (br_if $done (i32.ge_u (local.get $next) (call $win16_lheap_get (i32.const 1))))
        (br_if $done (i32.eqz (call $win16_lblock_free (local.get $next))))
        (local.set $size (i32.add (i32.add (local.get $size) (i32.const 2))
                                  (call $win16_lblock_size (local.get $next))))
        (br $merge)))
    (if (i32.ge_u (i32.add (i32.add (local.get $p) (i32.const 2)) (local.get $size))
                  (call $win16_lheap_get (i32.const 1)))
      (then (call $win16_lheap_set_ptr (local.get $p)))
      (else (call $win16_lblock_set (local.get $p) (local.get $size) (i32.const 1))))
    (global.set $eax (i32.const 0))
    (call $win16_api_return (i32.const 2)))

  (func $win16_LocalSize
    (global.set $eax (call $win16_lblock_size
      (i32.sub (call $win16_arg16 (i32.const 0)) (i32.const 2))))
    (call $win16_api_return (i32.const 2)))

  ;; LocalLock, LocalUnlock and LocalCompact on a fixed block: the handle is
  ;; already the pointer and nothing moves.
  (func $win16_local_identity (param $argbytes i32) (param $result i32)
    (global.set $eax (local.get $result))
    (call $win16_api_return (local.get $argbytes)))

  ;; ---- The global heap ----
  ;;
  ;; A global block is one or more whole arena slots, and its handle is the
  ;; selector of the first: that is what makes GlobalLock free — the far
  ;; pointer is handle:0000 — and it is also what real Windows does once a
  ;; block is fixed, which is the only state we have. Blocks larger than 64KB
  ;; get consecutive slots, so the selector of slot n+1 is the selector of slot
  ;; n plus 8, which is exactly the step huge-pointer arithmetic walks by.
  ;;
  ;; Per-block bookkeeping rides in the segment table entry of the head slot:
  ;; flags gets one of the two bits below and the ne_seg field, which means
  ;; nothing for a slot that came from no NE file, holds the requested size.
  ;; Freed blocks stay in the table and are reused by a later allocation of the
  ;; same size or smaller, so an app that cycles a scratch buffer does not walk
  ;; the arena to its end.
  (global $WIN16_SEG_GLOBAL i32 (i32.const 0x10000))  ;; head slot of a global block
  (global $WIN16_SEG_GFREE  i32 (i32.const 0x20000))  ;; ...and it has been freed

  (func $win16_gseg_field (param $index i32) (param $off i32) (result i32)
    (i32.load (i32.add (i32.add (global.get $WIN16_SEG_TABLE)
                                (i32.mul (local.get $index) (i32.const 16)))
                       (local.get $off))))

  (func $win16_gseg_store (param $index i32) (param $off i32) (param $v i32)
    (i32.store (i32.add (i32.add (global.get $WIN16_SEG_TABLE)
                                 (i32.mul (local.get $index) (i32.const 16)))
                        (local.get $off))
               (local.get $v)))

  ;; Slots a block of this many bytes occupies. Zero bytes still takes one:
  ;; GlobalAlloc(0) has to answer with a handle nothing else holds.
  (func $win16_gseg_count (param $bytes i32) (result i32)
    (if (i32.eqz (local.get $bytes)) (then (return (i32.const 1))))
    (i32.div_u (i32.add (local.get $bytes) (i32.const 0xFFFF)) (i32.const 0x10000)))

  ;; Allocate `bytes` and answer with the head selector, or 0 if the arena
  ;; cannot cover it.
  (func $win16_global_alloc (param $bytes i32) (result i32)
    (local $need i32) (local $i i32) (local $head i32) (local $n i32)
    (local.set $need (call $win16_gseg_count (local.get $bytes)))

    ;; Reuse pass: the first freed block big enough, taken whole.
    (local.set $i (i32.const 1))
    (block $scanned (loop $scan
      (br_if $scanned (i32.ge_u (local.get $i) (global.get $win16_next_seg)))
      (if (i32.eq (i32.and (call $win16_gseg_field (local.get $i) (i32.const 8))
                           (i32.or (global.get $WIN16_SEG_GLOBAL) (global.get $WIN16_SEG_GFREE)))
                  (i32.or (global.get $WIN16_SEG_GLOBAL) (global.get $WIN16_SEG_GFREE)))
        (then
          (if (i32.ge_u (call $win16_gseg_count
                          (call $win16_gseg_field (local.get $i) (i32.const 12)))
                        (local.get $need))
            (then
              (call $win16_gseg_store (local.get $i) (i32.const 8)
                (global.get $WIN16_SEG_GLOBAL))
              (call $win16_gseg_store (local.get $i) (i32.const 12) (local.get $bytes))
              (call $zero_memory (call $g2w (call $win16_seg_base (local.get $i)))
                (i32.mul (local.get $need) (i32.const 0x10000)))
              (return (call $win16_index_to_sel (local.get $i)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))

    ;; Fresh slots. $win16_alloc_segment traps when the arena runs out, and a
    ;; trap is the wrong answer here — an app that asks for more than fits is
    ;; entitled to a NULL and its own out-of-memory path.
    (if (i32.gt_u (i32.add (global.get $win16_next_seg) (local.get $need))
                  (global.get $WIN16_SEG_MAX))
      (then (return (i32.const 0))))
    (local.set $head (call $win16_alloc_segment))
    (local.set $n (i32.const 1))
    (block $done (loop $more
      (br_if $done (i32.ge_u (local.get $n) (local.get $need)))
      (drop (call $win16_alloc_segment))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br $more)))
    (call $win16_gseg_store (local.get $head) (i32.const 8) (global.get $WIN16_SEG_GLOBAL))
    (call $win16_gseg_store (local.get $head) (i32.const 12) (local.get $bytes))
    (call $win16_index_to_sel (local.get $head)))

  (func $win16_GlobalAlloc
    (local $bytes i32)
    (local.set $bytes (call $win16_arg32 (i32.const 0)))
    (global.set $eax (call $win16_global_alloc (local.get $bytes)))
    (call $win16_api_return (i32.const 6)))

  (func $win16_GlobalFree
    (local $index i32)
    (local.set $index (call $win16_sel_to_index (call $win16_arg16 (i32.const 0))))
    (if (i32.and (i32.ne (local.get $index) (i32.const 0))
                 (i32.lt_u (local.get $index) (global.get $WIN16_SEG_MAX)))
      (then
        (if (i32.and (call $win16_gseg_field (local.get $index) (i32.const 8))
                     (global.get $WIN16_SEG_GLOBAL))
          (then (call $win16_gseg_store (local.get $index) (i32.const 8)
                  (i32.or (global.get $WIN16_SEG_GLOBAL) (global.get $WIN16_SEG_GFREE)))))))
    ;; GlobalFree answers with NULL on success.
    (global.set $eax (i32.const 0))
    (call $win16_api_return (i32.const 2)))

  ;; GlobalLock(h) -> h:0000, the whole point of handles being selectors.
  (func $win16_GlobalLock
    (local $h i32)
    (local.set $h (call $win16_arg16 (i32.const 0)))
    (global.set $edx (local.get $h))
    (global.set $eax (i32.const 0))
    (if (i32.eqz (local.get $h)) (then (global.set $edx (i32.const 0))))
    (call $win16_api_return (i32.const 2)))

  (func $win16_GlobalSize
    (local $bytes i32)
    (local.set $bytes (call $win16_gseg_field
      (call $win16_sel_to_index (call $win16_arg16 (i32.const 0))) (i32.const 12)))
    (global.set $edx (i32.shr_u (local.get $bytes) (i32.const 16)))
    (global.set $eax (i32.and (local.get $bytes) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 2)))

  ;; GlobalHandle(sel) -> the handle in AX and the selector in DX; here they
  ;; are the same value.
  (func $win16_GlobalHandle
    (local $h i32)
    (local.set $h (call $win16_arg16 (i32.const 0)))
    (global.set $edx (local.get $h))
    (global.set $eax (local.get $h))
    (call $win16_api_return (i32.const 2)))

  ;; GlobalReAlloc(h, dwBytes, wFlags). Growing inside the slots the block
  ;; already owns is free; anything else moves it, which a caller that kept a
  ;; pointer instead of the handle would notice — as it would on real Windows.
  ;; Let a segment grow inside the arena slot it already owns, and move the
  ;; local heap with it when the segment is the task's own DGROUP.
  ;;
  ;; A task that grows DGROUP is making room for a layout of its own — Visual
  ;; Basic's is [its 0x3a44 bytes of runtime state][stack][heap], and it sets
  ;; SP to the top of the stack immediately afterwards. The heap belongs at the
  ;; top; leaving it where the loader guessed it had LocalAlloc handing out
  ;; offsets in the middle of the state VB had just copied in, so VB's own
  ;; tables were being overwritten by its own allocations.
  (func $win16_gseg_grow (param $index i32) (param $bytes i32)
    (if (i32.le_u (local.get $bytes) (call $win16_seg_limit (local.get $index)))
      (then (return)))
    (call $win16_gseg_store (local.get $index) (i32.const 4) (local.get $bytes))
    (if (i32.and (i32.eq (local.get $index) (global.get $win16_auto_data))
                 (i32.gt_u (local.get $bytes) (global.get $win16_heap_size)))
      (then
        (global.set $win16_lheap_base
          (i32.sub (local.get $bytes) (global.get $win16_heap_size)))
        (global.set $win16_lheap_ptr (global.get $win16_lheap_base))
        (global.set $win16_lheap_end (local.get $bytes)))))

  (func $win16_GlobalReAlloc
    (local $h i32) (local $bytes i32) (local $index i32) (local $new i32)
    (local $old i32) (local $i i32)
    (local.set $h (call $win16_arg16 (i32.const 3)))
    (local.set $bytes (call $win16_arg32 (i32.const 1)))
    (local.set $index (call $win16_sel_to_index (local.get $h)))
    (local.set $old (call $win16_gseg_field (local.get $index) (i32.const 12)))
    (if (i32.le_u (call $win16_gseg_count (local.get $bytes))
                  (call $win16_gseg_count (local.get $old)))
      (then
        (call $win16_gseg_store (local.get $index) (i32.const 12) (local.get $bytes))
        (call $win16_gseg_grow (local.get $index) (local.get $bytes))
        (global.set $eax (local.get $h))
        (call $win16_api_return (i32.const 8))
        (return)))
    ;; A block that already has a whole arena slot to itself grows inside it
    ;; rather than moving. Every slot here is 64KB, so anything that still
    ;; fits in one is free to grow, and growing in place is the answer that
    ;; keeps the caller's selector working — which matters most for the one
    ;; block a task cannot survive being moved: its own DGROUP, which is what
    ;; Visual Basic reallocates on its way in to make room for its runtime.
    (if (i32.and (i32.le_u (local.get $bytes) (i32.const 0x10000))
                 (i32.ne (call $win16_seg_base (local.get $index)) (i32.const 0)))
      (then
        (call $win16_gseg_store (local.get $index) (i32.const 12) (local.get $bytes))
        (call $win16_gseg_grow (local.get $index) (local.get $bytes))
        (global.set $eax (local.get $h))
        (call $win16_api_return (i32.const 8))
        (return)))
    (local.set $new (call $win16_global_alloc (local.get $bytes)))
    (if (local.get $new)
      (then
        (block $copied (loop $copy
          (br_if $copied (i32.ge_u (local.get $i) (local.get $old)))
          (call $gs8 (i32.add (call $win16_far_to_guest (local.get $new) (i32.const 0))
                              (local.get $i))
            (call $gl8 (i32.add (call $win16_far_to_guest (local.get $h) (i32.const 0))
                                (local.get $i))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $copy)))
        (call $win16_gseg_store (local.get $index) (i32.const 8)
          (i32.or (global.get $WIN16_SEG_GLOBAL) (global.get $WIN16_SEG_GFREE)))))
    (global.set $eax (local.get $new))
    (call $win16_api_return (i32.const 8)))

  ;; GlobalCompact(dwMinFree) -> the largest block that could still be had,
  ;; which is every arena slot nothing has taken yet.
  (func $win16_GlobalCompact
    (local $free i32)
    (local.set $free (i32.mul
      (i32.sub (global.get $WIN16_SEG_MAX) (global.get $win16_next_seg))
      (i32.const 0x10000)))
    (global.set $edx (i32.shr_u (local.get $free) (i32.const 16)))
    (global.set $eax (i32.and (local.get $free) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 4)))

  ;; KERNEL.137 FatalAppExit(wAction, lpszMessageText) — the task has decided
  ;; it cannot continue. The message is the whole value of the call, so it is
  ;; logged as a string before the process goes down; without it the exit looks
  ;; like an emulator fault instead of the app's own diagnosis.
  (func $win16_FatalAppExit
    (local $msg i32)
    (local.set $msg (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (call $host_log_i32 (i32.const 0xCA16FA7A))   ;; FatalAppExit, message follows
    (if (call $win16_arg16 (i32.const 1))
      (then (call $host_log (call $g2w (local.get $msg))
              (call $win16_lstr_len (local.get $msg)))))
    (call $host_exit (i32.const 1))
    (global.set $eip (i32.const 0))
    (global.set $steps (i32.const 0)))

  ;; ---- Selector aliases ----
  ;;
  ;; Real protected-mode Windows hands out one selector per view of a block:
  ;; a code selector cannot be written through, so a program that generates or
  ;; patches code asks for a data alias of it, and one that runs a block it
  ;; built asks for a code alias. Here every selector is a base and a limit
  ;; into the same flat arena and the descriptor has no code/data distinction
  ;; to honour, so an alias is a second selector over the same bytes — which is
  ;; what an alias is, minus the protection the hardware would apply.
  ;;
  ;; PrestoChangoSelector is the same idea without the allocation: it changes
  ;; the destination selector to be the other kind of view of the source.
  (func $win16_alias_of (param $src i32) (result i32)
    (local $si i32) (local $di i32)
    (local.set $si (call $win16_sel_to_index (local.get $src)))
    (if (i32.eqz (call $win16_seg_base (local.get $si))) (then (return (i32.const 0))))
    (if (i32.ge_u (global.get $win16_next_seg) (global.get $WIN16_SEG_MAX))
      (then (return (i32.const 0))))
    ;; The alias slot names the source's memory, so it must not be given the
    ;; arena page $win16_alloc_segment would zero. Take the index by hand.
    (local.set $di (global.get $win16_next_seg))
    (global.set $win16_next_seg (i32.add (local.get $di) (i32.const 1)))
    (call $win16_seg_set (local.get $di)
      (call $win16_seg_base (local.get $si)) (call $win16_seg_limit (local.get $si))
      (i32.const 0) (i32.const 0))
    (call $win16_index_to_sel (local.get $di)))

  (func $win16_AllocAlias
    (global.set $eax (call $win16_alias_of (call $win16_arg16 (i32.const 0))))
    (call $win16_api_return (i32.const 2)))

  (func $win16_PrestoChangoSelector
    (local $src i32) (local $dst i32) (local $si i32) (local $di i32)
    (local.set $dst (call $win16_arg16 (i32.const 0)))
    (local.set $src (call $win16_arg16 (i32.const 1)))
    (local.set $si (call $win16_sel_to_index (local.get $src)))
    (local.set $di (call $win16_sel_to_index (local.get $dst)))
    (if (i32.and (i32.ne (call $win16_seg_base (local.get $si)) (i32.const 0))
                 (i32.and (i32.ne (local.get $di) (i32.const 0))
                          (i32.lt_u (local.get $di) (global.get $WIN16_SEG_MAX))))
      (then (call $win16_seg_set (local.get $di)
              (call $win16_seg_base (local.get $si))
              (call $win16_seg_limit (local.get $si))
              (i32.const 0) (i32.const 0)))
      (else (local.set $dst (i32.const 0))))
    (global.set $eax (local.get $dst))
    (call $win16_api_return (i32.const 4)))

  ;; KERNEL.169 GetFreeSpace(wFlags) -> bytes still available, which for this
  ;; arena is every slot no selector has taken.
  (func $win16_GetFreeSpace
    (local $free i32)
    (local.set $free (i32.mul
      (i32.sub (global.get $WIN16_SEG_MAX) (global.get $win16_next_seg))
      (i32.const 0x10000)))
    (global.set $edx (i32.shr_u (local.get $free) (i32.const 16)))
    (global.set $eax (i32.and (local.get $free) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 2)))

  ;; ---- File handles ----
  ;;
  ;; Every other kind of handle goes through $win16_h16, which numbers from
  ;; 0x100 because a small number could be confused with a real 32-bit handle.
  ;; A file handle cannot afford that: DOS numbers files from zero, INT 21h
  ;; takes one in BX, and a C runtime keeps a per-handle array of its own
  ;; indexed by exactly that number. So files get their own map, small and
  ;; dense, and 0-4 are left alone for stdin/stdout/stderr/aux/prn.
  (func $win16_fh16 (param $h32 i32) (result i32)
    (local $t i32) (local $i i32)
    (if (i32.eq (local.get $h32) (i32.const -1)) (then (return (i32.const 0xFFFF))))
    (local.set $t (global.get $WIN16_FILE_TABLE))
    (local.set $i (i32.const 5))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $WIN16_FILE_MAX)))
      (if (i32.eq (i32.load (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 2))))
                  (local.get $h32))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.set $i (i32.const 5))
    (block $free (loop $look
      (br_if $free (i32.ge_u (local.get $i) (global.get $WIN16_FILE_MAX)))
      (if (i32.eqz (i32.load (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 2)))))
        (then
          (i32.store (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 2)))
                     (local.get $h32))
          (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $look)))
    ;; Out of handles is what DOS itself answers when FILES= is exhausted, and
    ;; a task that leaks them deserves to hear it rather than to be given one
    ;; that names another task's file.
    (i32.const 0xFFFF))

  ;; The way back. A handle at or above the general base never came from here,
  ;; so it goes through the general map — AccessResource used to hand those
  ;; out and a task may still be holding one.
  (func $win16_fh32 (param $h16 i32) (result i32)
    (local.set $h16 (i32.and (local.get $h16) (i32.const 0xFFFF)))
    (if (i32.eq (local.get $h16) (i32.const 0xFFFF)) (then (return (i32.const -1))))
    (if (i32.ge_u (local.get $h16) (global.get $WIN16_FILE_MAX))
      (then (return (call $win16_h32 (local.get $h16)))))
    (if (i32.lt_u (local.get $h16) (i32.const 5)) (then (return (local.get $h16))))
    (i32.load (i32.add (global.get $WIN16_FILE_TABLE)
                       (i32.shl (local.get $h16) (i32.const 2)))))

  (func $win16_fh_forget (param $h16 i32)
    (local.set $h16 (i32.and (local.get $h16) (i32.const 0xFFFF)))
    (if (i32.and (i32.ge_u (local.get $h16) (i32.const 5))
                 (i32.lt_u (local.get $h16) (global.get $WIN16_FILE_MAX)))
      (then (i32.store (i32.add (global.get $WIN16_FILE_TABLE)
                                (i32.shl (local.get $h16) (i32.const 2)))
              (i32.const 0)))))

  ;; ---- The file API ----
  ;;
  ;; _lopen and friends are the same calls as their Win32 spellings with
  ;; sixteen-bit handles, so each one narrows its far pointers and hands the
  ;; work to the 32-bit handler. HFILE_ERROR is 0xFFFF rather than -1 once the
  ;; result is a word, and that is the whole difference for the caller.
  (func $win16_lopen (param $create i32)
    (local $path i32) (local $mode i32)
    (local.set $mode (call $win16_arg16 (i32.const 0)))
    (local.set $path (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (call $win16_call32_begin (i32.const 2))
    (if (local.get $create)
      (then (call $handle__lcreat (local.get $path) (local.get $mode)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle__lopen (local.get $path) (local.get $mode)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (call $win16_call32_end)
    ;; Through the file map, not masked to sixteen bits. A file handle here
    ;; is 0xF0000001 and masking hands the task a 1, which is some other file's
    ;; handle — Rattler Race read its own image through it, found bytes that
    ;; were not its own, and put up "a virus has been detected".
    (global.set $eax (call $win16_fh16 (global.get $eax)))
    (call $win16_api_return (i32.const 6)))

  (func $win16_lclose
    (local $h i32) (local $h16 i32)
    (local.set $h16 (call $win16_arg16 (i32.const 0)))
    (local.set $h (call $win16_fh32 (local.get $h16)))
    (call $win16_call32_begin (i32.const 1))
    (call $handle__lclose (local.get $h) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    ;; The file is gone, so its place in the map is free.
    (call $win16_fh_forget (local.get $h16))
    (call $win16_h16_forget (local.get $h))
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 2)))

  (func $win16_lread (param $write i32)
    (local $h i32) (local $buf i32) (local $n i32)
    (local.set $n (call $win16_arg16 (i32.const 0)))
    (local.set $buf (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $h (call $win16_fh32 (call $win16_arg16 (i32.const 3))))
    (call $win16_call32_begin (i32.const 3))
    (if (local.get $write)
      (then (call $handle__lwrite (local.get $h) (local.get $buf) (local.get $n)
              (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle__lread (local.get $h) (local.get $buf) (local.get $n)
              (i32.const 0) (i32.const 0) (i32.const 0))))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 8)))

  ;; _llseek(hFile, lOffset, iOrigin) -> the new position, a LONG in DX:AX.
  (func $win16_llseek
    (local $h i32) (local $off i32) (local $origin i32)
    (local.set $origin (call $win16_arg16 (i32.const 0)))
    (local.set $off (call $win16_arg32 (i32.const 1)))
    (local.set $h (call $win16_fh32 (call $win16_arg16 (i32.const 3))))
    (call $win16_call32_begin (i32.const 3))
    (call $handle__llseek (local.get $h) (local.get $off) (local.get $origin)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $edx (i32.shr_u (global.get $eax) (i32.const 16)))
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 8)))

  ;; OpenFile(lpFileName, lpReOpenBuff, wStyle). The OFSTRUCT the second
  ;; argument points at is written by the 32-bit handler in the same layout.
  (func $win16_OpenFile
    (local $name i32) (local $ofs i32) (local $style i32)
    (local.set $style (call $win16_arg16 (i32.const 0)))
    (local.set $ofs (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (if (i32.eqz (call $win16_arg16 (i32.const 2))) (then (local.set $ofs (i32.const 0))))
    (local.set $name (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 4)) (call $win16_arg16 (i32.const 3))))
    (call $win16_call32_begin (i32.const 3))
    (call $handle_OpenFile (local.get $name) (local.get $ofs) (local.get $style)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    ;; OF_EXIST and the other styles that only report answer 1 or -1 rather
    ;; than opening anything, and neither belongs in the file map.
    (if (i32.gt_u (global.get $eax) (i32.const 1))
      (then (global.set $eax (call $win16_fh16 (global.get $eax))))
      (else (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))))
    (call $win16_api_return (i32.const 10)))

  ;; KERNEL.134 GetWindowsDirectory / KERNEL.135 GetSystemDirectory
  ;; (lpBuffer, uSize) -> length written, not counting the NUL.
  ;;
  ;; Every Entertainment Pack game asks for one of these on startup: they keep
  ;; their high scores in a private INI beside Windows itself, and the path is
  ;; built from the answer.
  (func $win16_dir_query (param $system i32)
    (local $buf i32) (local $max i32)
    (local.set $max (call $win16_arg16 (i32.const 0)))
    (local.set $buf (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (call $win16_call32_begin (i32.const 2))
    (if (local.get $system)
      (then (call $handle_GetSystemDirectoryA (local.get $buf) (local.get $max)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle_GetWindowsDirectoryA (local.get $buf) (local.get $max)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 6)))

  ;; KERNEL.131 GetDOSEnvironment -> far pointer to the task's environment.
  ;;
  ;; The block is a run of NAME=VALUE strings ending in a second NUL. Nothing
  ;; here sets any, so it is the empty block -- which is a real answer: a task
  ;; that walks it finds no variables and carries on, where a null pointer
  ;; would be dereferenced. TetraVex and Chip's Challenge both read it before
  ;; they open a window.
  (func $win16_GetDOSEnvironment
    (local $seg i32) (local $dst i32) (local $n i32) (local $i i32)
    (if (i32.eqz (global.get $win16_env_seg))
      (then
        (call $env_ensure)
        (local.set $n (call $env_size))
        (local.set $seg (call $win16_alloc_segment))
        (local.set $dst (call $win16_seg_base (local.get $seg)))
        (block $done (loop $copy
          (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
          (call $gs8 (i32.add (local.get $dst) (local.get $i))
            (call $gl8 (i32.add (global.get $env_block) (local.get $i))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $copy)))
        (global.set $win16_env_seg (local.get $seg))))
    (global.set $edx (call $win16_index_to_sel (global.get $win16_env_seg)))
    (global.set $eax (i32.const 0))
    (call $win16_api_return (i32.const 0)))

  (func $win16_kernel (param $ordinal i32) (result i32)
    (if (i32.eq (local.get $ordinal) (i32.const 131))
      (then (call $win16_GetDOSEnvironment) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 134))
      (then (call $win16_dir_query (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 135))
      (then (call $win16_dir_query (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 74))
      (then (call $win16_OpenFile) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 137))
      (then (call $win16_FatalAppExit) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 81))
      (then (call $win16_lclose) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 82))
      (then (call $win16_lread (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 83))
      (then (call $win16_lopen (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 84))
      (then (call $win16_llseek) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 85))
      (then (call $win16_lopen (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 86))
      (then (call $win16_lread (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 169))
      (then (call $win16_GetFreeSpace) (return (i32.const 1))))
    ;; AllocCStoDSAlias, AllocDStoCSAlias, AllocAlias and AllocSelector all
    ;; come to the same thing here: another selector over the same bytes.
    (if (i32.or (i32.eq (local.get $ordinal) (i32.const 170))
        (i32.or (i32.eq (local.get $ordinal) (i32.const 171))
        (i32.or (i32.eq (local.get $ordinal) (i32.const 172))
                (i32.eq (local.get $ordinal) (i32.const 175)))))
      (then (call $win16_AllocAlias) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 176))   ;; FreeSelector
      (then (call $win16_local_identity (i32.const 2) (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 177))
      (then (call $win16_PrestoChangoSelector) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 15))
      (then (call $win16_GlobalAlloc) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 16))
      (then (call $win16_GlobalReAlloc) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 17))
      (then (call $win16_GlobalFree) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 18))
      (then (call $win16_GlobalLock) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 19))   ;; GlobalUnlock
      (then (call $win16_local_identity (i32.const 2) (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 20))
      (then (call $win16_GlobalSize) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 21))
      (then (call $win16_GlobalHandle) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 22))   ;; GlobalFlags
      (then (call $win16_local_identity (i32.const 2) (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 25))
      (then (call $win16_GlobalCompact) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 4))
      (then (call $win16_LocalInit) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 5))
      (then (call $win16_LocalAlloc) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 6))
      (then (call $win16_LocalReAlloc) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 7))
      (then (call $win16_LocalFree) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 8))            ;; LocalLock
      (then (call $win16_LocalLock) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 23))           ;; LockSegment
      (then (call $win16_local_identity (i32.const 2)
              (call $win16_arg16 (i32.const 0))) (return (i32.const 1))))
    (if (i32.or (i32.eq (local.get $ordinal) (i32.const 9))    ;; LocalUnlock
                (i32.eq (local.get $ordinal) (i32.const 24)))  ;; UnlockSegment
      (then (call $win16_local_identity (i32.const 2) (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 10))
      (then (call $win16_LocalSize) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 13))   ;; LocalCompact
      (then (call $win16_local_identity (i32.const 2)
              (i32.sub (call $win16_lheap_get (i32.const 2))
                       (call $win16_lheap_get (i32.const 1))))
            (return (i32.const 1))))
    ;; GetWinFlags / __WinFlags: WF_PMODE | WF_CPU386 | WF_ENHANCED is what a
    ;; 386 in enhanced mode reports, which is what these apps are written for,
    ;; plus WF_80x87 (0x0400) because there is a real x87 here — see
    ;; src/06-fpu.wat. Saying otherwise sends every floating-point app down the
    ;; WIN87EM emulator path, whose entry point patches its caller's code and
    ;; then runs on state this emulator does not keep; Fuji Golf called it
    ;; three times and jumped into a segment nothing had filled.
    (if (i32.or (i32.eq (local.get $ordinal) (i32.const 132))
                (i32.eq (local.get $ordinal) (i32.const 178)))
      (then
        (global.set $eax (i32.const 0x0425))
        (global.set $edx (i32.const 0))
        (call $win16_api_return (i32.const 0))
        (return (i32.const 1))))
    ;; GetCurrentTask answers with the task's own DGROUP selector, which is
    ;; what an hTask is here; MakeProcInstance hands back the far pointer it
    ;; was given, because with one data segment there is no thunk to build.
    (if (i32.eq (local.get $ordinal) (i32.const 36))
      (then (call $win16_local_identity (i32.const 0) (global.get $sreg_ds))
            (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 37))
      (then (call $win16_GetCurrentPDB) (return (i32.const 1))))
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
    (if (i32.eq (local.get $ordinal) (i32.const 57))
      (then (call $win16_GetProfileInt) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 58))
      (then (call $win16_GetProfileString) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 59))
      (then (call $win16_WriteProfileString) (return (i32.const 1))))
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
    (if (i32.eq (local.get $ordinal) (i32.const 55))
      (then (call $win16_Catch) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 56))
      (then (call $win16_Throw) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 218))
      (then (call $win16_RegCreateKey) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 220))
      (then (call $win16_RegCloseKey) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 221))
      (then (call $win16_RegSetValue) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 225))
      (then (call $win16_reg_value_ex (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 226))
      (then (call $win16_reg_value_ex (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 227))   ;; RegFlushKey
      (then (global.set $edx (i32.const 0))
            (call $win16_local_identity (i32.const 4) (i32.const 0))
            (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 60))
      (then (call $win16_FindResource) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 61))
      (then (call $win16_LoadResource) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 62))
      (then (call $win16_LockResource) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 64))
      (then (call $win16_AccessResource) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 65))
      (then (call $win16_SizeofResource) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 63))   ;; FreeResource
      (then (call $win16_local_identity (i32.const 2) (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 49))
      (then (call $win16_GetModuleFileName) (return (i32.const 1))))
    ;; GetModuleHandle answers with the task's own module, which here is its
    ;; DGROUP selector; GetProcAddress and LoadLibrary are asked about modules
    ;; nothing has loaded, and zero is the answer Windows gives for those.
    (if (i32.eq (local.get $ordinal) (i32.const 47))
      (then (call $win16_GetModuleHandle) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 50))
      (then (call $win16_GetProcAddress) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 95))
      (then (call $win16_LoadLibrary) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 96))
      (then (call $win16_FreeLibrary) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 3))
      (then (call $win16_GetVersion) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 30))
      (then (call $win16_WaitEvent) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 91))
      (then (call $win16_InitTask) (return (i32.const 1))))
    (i32.const 0))

  ;; ---- Loading a library by name ----
  ;;
  ;; The names in an NE's tables are upper case Pascal strings, and everything
  ;; an app passes to LoadLibrary or GetProcAddress is a C string in whatever
  ;; case it was typed — "cards.dll", "CARDS.DLL". This puts both into the one
  ;; form the tables can be searched with. `stop_at_dot` is for module names,
  ;; where the extension is not part of the name.
  (func $win16_cstr_to_pstr (param $src i32) (param $dst i32) (param $stop_at_dot i32)
    (local $n i32) (local $c i32)
    ;; A module name is the base name: LoadLibrary is routinely given a path,
    ;; and Visual Basic hands it the full one for its custom controls. Skip to
    ;; after the last separator before copying, or "C:\FIELD100" is what gets
    ;; looked up and no such module is ever found.
    (block $scanned (loop $path
      (local.set $c (call $gl8 (i32.add (local.get $src) (local.get $n))))
      (br_if $scanned (i32.eqz (local.get $c)))
      (if (i32.or (i32.eq (local.get $c) (i32.const 0x5C))    ;; backslash
          (i32.or (i32.eq (local.get $c) (i32.const 0x2F))    ;; forward slash
                  (i32.eq (local.get $c) (i32.const 0x3A))))  ;; colon
        (then (local.set $src (i32.add (local.get $src)
                                       (i32.add (local.get $n) (i32.const 1))))
              (local.set $n (i32.const -1))))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br $path)))
    (local.set $n (i32.const 0))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $n) (i32.const 63)))
      (local.set $c (call $gl8 (i32.add (local.get $src) (local.get $n))))
      (br_if $done (i32.eqz (local.get $c)))
      (br_if $done (i32.and (local.get $stop_at_dot) (i32.eq (local.get $c) (i32.const 0x2E))))
      (if (i32.and (i32.ge_u (local.get $c) (i32.const 0x61))
                   (i32.le_u (local.get $c) (i32.const 0x7A)))
        (then (local.set $c (i32.sub (local.get $c) (i32.const 0x20)))))
      (i32.store8 (i32.add (i32.add (call $g2w (local.get $dst)) (i32.const 1)) (local.get $n))
                  (local.get $c))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br $copy)))
    (i32.store8 (call $g2w (local.get $dst)) (local.get $n)))

  ;; Is this module one the emulator implements itself, rather than a real NE
  ;; the host has to stage? Ids 1..8 are the system libraries; DDEML is written
  ;; out here too but had to take an id past them because the low ones were
  ;; already spoken for.
  (func $win16_module_emulated (param $id i32) (result i32)
    (i32.or (i32.le_u (local.get $id) (global.get $WIN16_SYSTEM_MODULES))
            (i32.or (i32.eq (local.get $id) (i32.const 10))
            (i32.or (i32.eq (local.get $id) (i32.const 11))
                    (i32.eq (local.get $id) (i32.const 12))))))

  ;; Scratch for the Pascal string above, at the unused bottom of the 32-bit
  ;; task's stack region, which a 16-bit task never touches.
  (func $win16_name_scratch (result i32)
    (i32.add (global.get $GUEST_STACK) (i32.const 0x200)))

  ;; KERNEL.95 LoadLibrary(lpszLibFile) -> HINSTANCE, or an error code below 32.
  ;;
  ;; A module this emulator implements is always present, whether or not any
  ;; file backs it. One that is a real NE — CARDS is the only one so far — is
  ;; loaded from the bytes the host staged for its module id; a task that asks
  ;; for a library nothing staged gets 2, which is what Windows returns for a
  ;; file it cannot find, and which every caller already tests for.
  (func $win16_LoadLibrary
    (local $name i32) (local $id i32)
    (local.set $name (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (call $win16_cstr_to_pstr (local.get $name) (call $win16_name_scratch) (i32.const 1))
    (local.set $id (call $win16_module_id (call $g2w (call $win16_name_scratch))))
    ;; Which module the name resolved to, and whether it was already loaded —
    ;; the two things that decide what this call does.
    (if (global.get $win16_trace)
      (then
        (call $host_log_i32 (i32.const 0xCA16110A))
        (call $host_log_i32 (local.get $id))
        (call $host_log_i32 (call $win16_dll_loaded (local.get $id)))))
    (if (i32.eqz (local.get $id))
      (then (call $win16_local_identity (i32.const 4) (i32.const 2)) (return)))
    (if (i32.eqz (call $win16_module_emulated (local.get $id)))
      (then
        (if (i32.eqz (call $win16_dll_loaded (local.get $id)))
          (then
            ;; An app-local module reached only through LoadLibrary has an id
            ;; but no bytes: the host stages the file now, at the moment its
            ;; name is known. A slot claimed for a module with no file has to
            ;; be given back, or the next LoadLibrary of a real one finds the
            ;; table full.
            (if (i32.ge_u (local.get $id) (global.get $WIN16_DYNAMIC_BASE))
              (then
                (if (i32.eqz (call $host_win16_stage_module
                               (call $g2w (call $win16_name_scratch)) (local.get $id)))
                  (then
                    (call $win16_dynamic_module_release (local.get $id))
                    (call $win16_local_identity (i32.const 4) (i32.const 2))
                    (return)))))
            (if (i32.eqz (call $load_ne_dll (local.get $id)))
              (then
                (if (i32.ge_u (local.get $id) (global.get $WIN16_DYNAMIC_BASE))
                  (then (call $win16_dynamic_module_release (local.get $id))))
                (call $win16_local_identity (i32.const 4) (i32.const 2))
                (return)))))))
    (call $win16_local_identity (i32.const 4)
      (call $win16_h16 (i32.or (i32.const 0x00D10000) (local.get $id)))))

  ;; KERNEL.96 FreeLibrary(hLibModule).
  ;;
  ;; It used to answer and do nothing, which costs an app-local module slot
  ;; every time — and there are four. Stones loads each of its five stone-style
  ;; DLLs, reads what it needs, and frees it again before the next; on the
  ;; fifth it got the fourth one's handle back and reported its styles
  ;; corrupted. Freeing marks the record unloaded and gives the name slot back,
  ;; so the next LoadLibrary of a different module has somewhere to go.
  ;;
  ;; The module's segments stay in the arena. Real Windows discards them and
  ;; reloads on demand; here they are simply no longer reachable by name, which
  ;; costs arena slots and nothing else — and a module the app frees and loads
  ;; again is staged and placed afresh.
  (func $win16_FreeLibrary
    (local $id i32)
    (local.set $id (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (if (i32.eq (i32.and (local.get $id) (i32.const 0xFFFF0000)) (i32.const 0x00D10000))
      (then
        (local.set $id (i32.and (local.get $id) (i32.const 0xFFFF)))
        (if (i32.ge_u (local.get $id) (global.get $WIN16_DYNAMIC_BASE))
          (then
            (call $win16_dll_unload (local.get $id))
            (call $win16_dynamic_module_release (local.get $id))))))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 2)))

  ;; KERNEL.47 GetModuleHandle(lpModuleName) -> the module's handle.
  ;;
  ;; A module this emulator has loaded gets the same 0x00D1-over-id handle
  ;; LoadLibrary hands out, so GetModuleFileName can tell afterwards which
  ;; module was meant. Anything else is the task itself, whose handle is its
  ;; own DGROUP selector — an hInstance and an hModule are the same thing for
  ;; the task, which is why RegisterClass accepts either.
  (func $win16_GetModuleHandle
    (local $name i32) (local $id i32)
    (local.set $name (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    ;; MAKEINTRESOURCE-style: a null selector means there is no name at all.
    (if (i32.eqz (call $win16_arg16 (i32.const 1)))
      (then (call $win16_local_identity (i32.const 4) (global.get $sreg_ds)) (return)))
    (call $win16_cstr_to_pstr (local.get $name) (call $win16_name_scratch) (i32.const 1))
    (local.set $id (call $win16_module_id (call $g2w (call $win16_name_scratch))))
    (if (i32.and (i32.ne (local.get $id) (i32.const 0))
                 (i32.ge_u (local.get $id) (global.get $WIN16_DYNAMIC_BASE)))
      (then
        (if (call $win16_dll_loaded (local.get $id))
          (then
            (call $win16_local_identity (i32.const 4)
              (call $win16_h16 (i32.or (i32.const 0x00D10000) (local.get $id))))
            (return)))))
    (call $win16_local_identity (i32.const 4) (global.get $sreg_ds)))

  ;; NDDEAPI.NDdeGetWindow() -> HWND of the agent that serves network DDE, or
  ;; NULL when there is none and the caller should start NETDDE.EXE.
  ;;
  ;; There is one, and it is us: DDEML is implemented in WAT rather than by a
  ;; separate agent process, so the honest answer is a window of ours rather
  ;; than a zero. It is a real entry in the window table — no host window, no
  ;; painting, nothing on screen — so the handle names something that can be
  ;; posted to and looked up, which is what a caller does with it.
  ;;
  ;; Hearts asks before it will let you choose how to play: a NULL here greys
  ;; out both "connect to another game" and "be dealer", which leaves it able
  ;; to do neither.
  (func $win16_ndde_window (result i32)
    (local $hwnd i32)
    (if (global.get $win16_ndde_hwnd)
      (then (return (global.get $win16_ndde_hwnd))))
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (local.get $hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_WAT_NATIVE))
    (drop (call $wnd_set_style (local.get $hwnd) (i32.const 0x80000000)))  ;; WS_POPUP, not visible
    (global.set $win16_ndde_hwnd (local.get $hwnd))
    (local.get $hwnd))

  (func $win16_NDdeGetWindow
    (global.set $eax (call $win16_h16 (call $win16_ndde_window)))
    (global.set $edx (i32.const 0))
    (call $win16_api_return (i32.const 0)))

  ;; KERNEL.50 GetProcAddress(hModule, lpszProcName) -> FARPROC in DX:AX.
  ;;
  ;; lpszProcName is a far pointer to a name, unless its selector half is zero —
  ;; then the whole thing is an ordinal, and Hearts asks for CARDS.1, .2 and .4
  ;; that way.
  ;;
  ;; A module this emulator implements itself has no export table to read, but
  ;; it does have import thunks, and a thunk's address is exactly what a
  ;; FARPROC is: the same far pointer a static import would have been fixed up
  ;; to. So a name this side knows gets one. Chip's Challenge loads MMSYSTEM
  ;; and asks for five entry points by name rather than importing them, and a
  ;; NULL sent it calling through a null selector.
  (func $win16_GetProcAddress
    (local $sel i32) (local $off i32) (local $id i32) (local $ord i32) (local $target i32)
    (local.set $off (call $win16_arg16 (i32.const 0)))
    (local.set $sel (call $win16_arg16 (i32.const 1)))
    (local.set $id (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (if (i32.eq (i32.and (local.get $id) (i32.const 0xFFFF0000)) (i32.const 0x00D10000))
      (then
        (local.set $id (i32.and (local.get $id) (i32.const 0xFFFF)))
        ;; MMSYSTEM: the name is looked up in the table this side keeps and
        ;; answered with the import thunk for that ordinal, which is the same
        ;; address a static import would have been fixed up to — so calling
        ;; through it arrives at $win16_dispatch exactly as an import does.
        (if (i32.and (i32.eq (local.get $id) (i32.const 7)) (local.get $sel))
          (then
            (call $win16_cstr_to_pstr
              (call $win16_far_to_guest (local.get $sel) (local.get $off))
              (call $win16_name_scratch) (i32.const 0))
            (local.set $ord (call $win16_mmsystem_ordinal
              (call $g2w (call $win16_name_scratch))))
            (if (local.get $ord)
              (then (local.set $target
                (i32.or (i32.shl (global.get $WIN16_THUNK_SEL) (i32.const 16))
                        (call $win16_thunk_for (local.get $id) (local.get $ord)
                                               (i32.const 0))))))))
        ;; NDDEAPI's one entry point, matched the same way.
        (if (i32.and (i32.eq (local.get $id) (i32.const 11)) (local.get $sel))
          (then
            (call $win16_cstr_to_pstr
              (call $win16_far_to_guest (local.get $sel) (local.get $off))
              (call $win16_name_scratch) (i32.const 0))
            (if (call $win16_pstr_eq (call $g2w (call $win16_name_scratch))
                                     (global.get $WIN16_NAME_NDDEGETWINDOW))
              (then (local.set $target
                (i32.or (i32.shl (global.get $WIN16_THUNK_SEL) (i32.const 16))
                        (global.get $WIN16_NDDE_GETWINDOW)))))))
        (if (call $win16_dll_loaded (local.get $id))
          (then
            (if (local.get $sel)
              (then
                (call $win16_cstr_to_pstr
                  (call $win16_far_to_guest (local.get $sel) (local.get $off))
                  (call $win16_name_scratch) (i32.const 0))
                (local.set $ord (call $win16_dll_ordinal (local.get $id)
                  (call $g2w (call $win16_name_scratch)))))
              (else (local.set $ord (local.get $off))))
            (local.set $target (call $win16_dll_entry (local.get $id) (local.get $ord)))))))
    (global.set $edx (i32.shr_u (local.get $target) (i32.const 16)))
    (call $win16_local_identity (i32.const 6)
      (i32.and (local.get $target) (i32.const 0xFFFF))))

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
  ;; USER.421 wvsprintf(lpOut, lpFmt, lpArglist).
  ;;
  ;; The formatter itself is shared with the 32-bit side, but the argument list
  ;; is not: Win16 pushes an int as two bytes and a string as a far pointer,
  ;; where $wsprintf_impl reads every argument as a dword and every string as a
  ;; flat guest address. Handing it the 16-bit list directly would make the
  ;; first %d read half of the second argument. So the format is walked once
  ;; here to learn what each argument is, and a widened copy is built for the
  ;; formatter to read — which is the same thing a real thunk had to do.
  (func $win16_va_widen (param $fmt i32) (param $args i32) (result i32)
    (local $p i32) (local $ch i32) (local $n i32) (local $long i32) (local $out i32)
    (if (i32.eqz (global.get $win16_va_scratch))
      (then (global.set $win16_va_scratch (call $heap_alloc (i32.const 128)))))
    (local.set $out (global.get $win16_va_scratch))
    (local.set $p (local.get $fmt))
    (block $done (loop $scan
      (local.set $ch (call $gl8 (local.get $p)))
      (br_if $done (i32.eqz (local.get $ch)))
      (local.set $p (i32.add (local.get $p) (i32.const 1)))
      (if (i32.ne (local.get $ch) (i32.const 37)) (then (br $scan)))   ;; '%'
      (local.set $long (i32.const 0))
      ;; Flags, width and precision. '*' takes its value from the list, so it
      ;; consumes an argument of its own before the conversion does.
      (block $spec (loop $chars
        (local.set $ch (call $gl8 (local.get $p)))
        (br_if $done (i32.eqz (local.get $ch)))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (if (i32.or (i32.eq (local.get $ch) (i32.const 108))    ;; 'l'
                    (i32.eq (local.get $ch) (i32.const 76)))    ;; 'L'
          (then (local.set $long (i32.const 1)) (br $chars)))
        (if (i32.or (i32.eq (local.get $ch) (i32.const 104))    ;; 'h'
                    (i32.eq (local.get $ch) (i32.const 119)))   ;; 'w'
          (then (br $chars)))
        (if (i32.eq (local.get $ch) (i32.const 42))             ;; '*'
          (then
            (if (i32.lt_u (local.get $n) (i32.const 32))
              (then
                (call $gs32 (i32.add (local.get $out) (i32.shl (local.get $n) (i32.const 2)))
                  (call $win16_coord (call $gl16 (local.get $args))))
                (local.set $n (i32.add (local.get $n) (i32.const 1)))))
            (local.set $args (i32.add (local.get $args) (i32.const 2)))
            (br $chars)))
        (if (i32.or (i32.eq (local.get $ch) (i32.const 45))     ;; '-'
            (i32.or (i32.eq (local.get $ch) (i32.const 43))     ;; '+'
            (i32.or (i32.eq (local.get $ch) (i32.const 32))     ;; ' '
            (i32.or (i32.eq (local.get $ch) (i32.const 35))     ;; '#'
            (i32.or (i32.eq (local.get $ch) (i32.const 46))     ;; '.'
                    (i32.and (i32.ge_u (local.get $ch) (i32.const 48))
                             (i32.le_u (local.get $ch) (i32.const 57))))))))
          (then (br $chars)))
        (br $spec)))
      ;; $ch is now the conversion character.
      (if (i32.eq (local.get $ch) (i32.const 37)) (then (br $scan)))   ;; '%%'
      (br_if $done (i32.ge_u (local.get $n) (i32.const 32)))
      (if (i32.or (i32.eq (local.get $ch) (i32.const 115))     ;; 's'
                  (i32.eq (local.get $ch) (i32.const 83)))     ;; 'S'
        (then
          (call $gs32 (i32.add (local.get $out) (i32.shl (local.get $n) (i32.const 2)))
            (call $win16_far_to_guest
              (call $gl16 (i32.add (local.get $args) (i32.const 2)))
              (call $gl16 (local.get $args))))
          (local.set $args (i32.add (local.get $args) (i32.const 4))))
        (else (if (local.get $long)
          (then
            (call $gs32 (i32.add (local.get $out) (i32.shl (local.get $n) (i32.const 2)))
              (call $gl32 (local.get $args)))
            (local.set $args (i32.add (local.get $args) (i32.const 4))))
          (else
            ;; A signed conversion has to sign-extend, an unsigned one must
            ;; not: %d of -1 is "-1" and %u of the same word is "65535".
            (if (i32.or (i32.eq (local.get $ch) (i32.const 100))    ;; 'd'
                        (i32.eq (local.get $ch) (i32.const 105)))   ;; 'i'
              (then (local.set $ch (call $win16_coord (call $gl16 (local.get $args)))))
              (else (local.set $ch (call $gl16 (local.get $args)))))
            (call $gs32 (i32.add (local.get $out) (i32.shl (local.get $n) (i32.const 2)))
              (local.get $ch))
            (local.set $args (i32.add (local.get $args) (i32.const 2)))))))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br $scan)))
    (local.get $out))

  (func $win16_wvsprintf
    (local $out i32) (local $fmt i32) (local $args i32)
    (local.set $args (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $fmt (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 3)) (call $win16_arg16 (i32.const 2))))
    (local.set $out (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 5)) (call $win16_arg16 (i32.const 4))))
    (global.set $eax (i32.and
      (call $wsprintf_impl (local.get $out) (local.get $fmt)
        (call $win16_va_widen (local.get $fmt) (local.get $args)))
      (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 12)))

  ;; USER.129 GetClassWord / USER.130 SetClassWord(hWnd, nIndex[, wNewWord]).
  ;;
  ;; The two indices apps actually use are the background brush and the cursor,
  ;; and both are already resolved per window when it is created — that per
  ;; window value is what the window paints and hit-tests with, so it is the
  ;; one that has to change. Anything else stops rather than answering zero:
  ;; a wrong class word is a silent wrong answer, and this is the only place
  ;; that would know it happened.
  (func $win16_class_word (param $is_set i32)
    (local $hwnd i32) (local $index i32) (local $val i32) (local $prev i32)
    (local $handled i32)
    (if (local.get $is_set)
      (then
        (local.set $val (call $win16_arg16 (i32.const 0)))
        (local.set $index (call $win16_coord (call $win16_arg16 (i32.const 1))))
        (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 2)))))
      (else
        (local.set $index (call $win16_coord (call $win16_arg16 (i32.const 0))))
        (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 1))))))
    ;; A non-negative index is a byte offset into the class's own extra bytes,
    ;; which every window of the class shares. IdleWild keeps its animation
    ;; state there.
    (if (i32.ge_s (local.get $index) (i32.const 0))
      (then
        (local.set $prev (call $class_extra_get_word
          (call $wnd_get_class_slot (local.get $hwnd)) (local.get $index)))
        (if (local.get $is_set)
          (then (call $class_extra_set_word
                  (call $wnd_get_class_slot (local.get $hwnd))
                  (local.get $index) (local.get $val))))
        (global.set $eax (local.get $prev))
        (call $win16_api_return (select (i32.const 6) (i32.const 4) (local.get $is_set)))
        (return)))
    ;; Flat rather than a chain of else-ifs on purpose: the nested form put the
    ;; function's own tail inside the innermost else, so every index that WAS
    ;; handled returned without calling $win16_api_return at all — leaving EIP
    ;; on the call instruction and the arguments on the stack. IdleWild then
    ;; re-ran its own pushes forever, ten bytes of stack at a time, until SS
    ;; went wild. Nothing about that looked like a paren mistake from the
    ;; outside, and the paren checker is no help: the totals balance either way.
    (local.set $handled (i32.const 1))
    (if (i32.eq (local.get $index) (i32.const -10))        ;; GCW_HBRBACKGROUND
      (then
        (local.set $prev (call $win16_h16 (call $wnd_get_bg_brush (local.get $hwnd))))
        (if (local.get $is_set)
          (then (call $wnd_set_bg_brush (local.get $hwnd)
                  (call $win16_h32 (local.get $val))))))
      (else (local.set $handled (i32.const 0))))
    (if (i32.eq (local.get $index) (i32.const -12))        ;; GCW_HCURSOR
      (then
        (local.set $handled (i32.const 1))
        (local.set $prev (call $win16_h16 (call $wnd_get_class_cursor (local.get $hwnd))))
        (if (local.get $is_set)
          (then (call $wnd_set_class_cursor (local.get $hwnd)
                  (call $win16_h32 (local.get $val)))))))
    (if (i32.eq (local.get $index) (i32.const -14))        ;; GCW_HICON
      (then
        (local.set $handled (i32.const 1))
        (local.set $prev (call $win16_h16 (call $wnd_get_class_icon (local.get $hwnd))))
        (if (local.get $is_set)
          (then (call $wnd_set_class_icon (local.get $hwnd)
                  (call $win16_h32 (local.get $val)))))))
    ;; The three sizes the class was registered with, which live in the class
    ;; record's own WNDCLASS. A window asks for cbWndExtra before it uses the
    ;; extra bytes — Rodent's Revenge does, for its form.
    (if (i32.or (i32.eq (local.get $index) (i32.const -16))   ;; GCW_HMODULE
            (i32.or (i32.eq (local.get $index) (i32.const -18))   ;; GCW_CBWNDEXTRA
                    (i32.eq (local.get $index) (i32.const -20)))) ;; GCW_CBCLSEXTRA
      (then
        (local.set $handled (i32.const 1))
        (local.set $val (call $class_wndclass_addr
          (call $wnd_get_class_slot (local.get $hwnd))))
        (if (i32.eq (local.get $index) (i32.const -16))
          (then (local.set $prev (i32.load offset=16 (local.get $val))))
          (else
            (local.set $prev (select
              (i32.load offset=8 (local.get $val))
              (i32.load offset=12 (local.get $val))
              (i32.eq (local.get $index) (i32.const -20))))))
        (local.set $prev (i32.and (local.get $prev) (i32.const 0xFFFF)))))
    (if (i32.eqz (local.get $handled))
      (then
        (call $host_log_i32 (i32.const 0xCA16C1A5))   ;; class word not implemented
        (call $host_log_i32 (local.get $index))
        (call $host_log_i32 (local.get $is_set))
        (unreachable)))
    (global.set $eax (local.get $prev))
    (call $win16_api_return (select (i32.const 6) (i32.const 4) (local.get $is_set))))

  ;; USER.131 GetClassLong / USER.132 SetClassLong(hWnd, nIndex[, dwNewLong]).
  ;;
  ;; The long-sized half of the same class record. A non-negative index is two
  ;; words of the class's extra bytes; GCL_WNDPROC is the window procedure the
  ;; class was registered with, which is a far pointer and so already a long.
  ;; Visual Basic reads it for every control it creates.
  (func $win16_class_long (param $is_set i32)
    (local $hwnd i32) (local $index i32) (local $val i32) (local $prev i32)
    (local $slot i32)
    (if (local.get $is_set)
      (then
        (local.set $val (call $win16_arg32 (i32.const 0)))
        (local.set $index (call $win16_coord (call $win16_arg16 (i32.const 2))))
        (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 3)))))
      (else
        (local.set $index (call $win16_coord (call $win16_arg16 (i32.const 0))))
        (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 1))))))
    (local.set $slot (call $wnd_get_class_slot (local.get $hwnd)))
    (if (i32.ge_s (local.get $index) (i32.const 0))
      (then
        (local.set $prev (i32.or
          (call $class_extra_get_word (local.get $slot) (local.get $index))
          (i32.shl (call $class_extra_get_word (local.get $slot)
                     (i32.add (local.get $index) (i32.const 2))) (i32.const 16))))
        (if (local.get $is_set)
          (then
            (call $class_extra_set_word (local.get $slot) (local.get $index)
              (i32.and (local.get $val) (i32.const 0xFFFF)))
            (call $class_extra_set_word (local.get $slot)
              (i32.add (local.get $index) (i32.const 2))
              (i32.shr_u (local.get $val) (i32.const 16))))))
      (else
        ;; GCL_WNDPROC. A procedure of ours has no address a task could call,
        ;; so it is reported as the thunk that stands for it — the same answer
        ;; GetWindowLong gives for the same reason.
        (if (i32.eq (local.get $index) (i32.const -24))
          (then
            (local.set $prev (call $wnd_table_get (local.get $hwnd)))
            (if (i32.eqz (call $win16_is_far_proc (local.get $prev)))
              (then (local.set $prev (call $win16_builtin_wndproc))))
            (if (local.get $is_set)
              (then (call $wnd_table_set (local.get $hwnd) (local.get $val)))))
          (else
            (if (i32.eq (local.get $index) (i32.const -26))   ;; GCL_STYLE
              (then
                (local.set $prev (i32.load (call $class_wndclass_addr (local.get $slot))))
                (if (local.get $is_set)
                  (then (i32.store (call $class_wndclass_addr (local.get $slot))
                          (local.get $val)))))
              (else
                (call $host_log_i32 (i32.const 0xCA16C1A6))  ;; class long not implemented
                (call $host_log_i32 (local.get $index))
                (call $host_log_i32 (local.get $is_set))
                (unreachable)))))))
    (global.set $edx (i32.shr_u (local.get $prev) (i32.const 16)))
    (global.set $eax (i32.and (local.get $prev) (i32.const 0xFFFF)))
    (call $win16_api_return (select (i32.const 8) (i32.const 4) (local.get $is_set))))

  ;; USER.222 GetKeyboardState(lpKeyState) — 256 bytes, one per virtual key,
  ;; same array in both worlds.
  (func $win16_GetKeyboardState
    (local $buf i32)
    (local.set $buf (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_GetKeyboardState (local.get $buf) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 4)))

  ;; USER.223 SetKeyboardState(lpKeyState) — the same 256-byte array on the way
  ;; back in. Only the high bit of each byte is the down state; the low bit is
  ;; the toggle, which nothing here models.
  (func $win16_SetKeyboardState
    (local $buf i32) (local $i i32)
    (local.set $buf (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (block $done (loop $keys
      (br_if $done (i32.ge_u (local.get $i) (i32.const 256)))
      (call $host_set_key_down_state (local.get $i)
        (i32.and (call $gl8 (i32.add (local.get $buf) (local.get $i)))
                 (i32.const 0x80)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $keys)))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 4)))

  ;; USER.243 GetDialogBaseUnits() -> the width in AX and the height in DX of
  ;; the system font's average character, which is what a dialog unit is
  ;; measured in.
  (func $win16_GetDialogBaseUnits
    (call $win16_call32_begin (i32.const 0))
    (call $handle_GetDialogBaseUnits (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $edx (i32.shr_u (global.get $eax) (i32.const 16)))
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 0)))

  ;; USER.17 GetCursorPos(lpPoint) / USER.70 SetCursorPos(X, Y). A POINT is two
  ;; words here and two longs there.
  (func $win16_GetCursorPos
    (local $pt i32) (local $tmp i32)
    (local.set $pt (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $tmp (global.get $GUEST_STACK))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_GetCursorPos (local.get $tmp) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (call $gs16 (local.get $pt) (call $gl32 (local.get $tmp)))
    (call $gs16 (i32.add (local.get $pt) (i32.const 2))
      (call $gl32 (i32.add (local.get $tmp) (i32.const 4))))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 4)))

  (func $win16_SetCursorPos
    (local $x i32) (local $y i32)
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_SetCursorPos (local.get $x) (local.get $y)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 4)))

  ;; USER.47 IsWindow(hWnd). A handle the task made up, or one it kept after
  ;; the window was destroyed, has no 32-bit counterpart and is not a window.
  (func $win16_IsWindow
    (local $hwnd i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (if (i32.eqz (local.get $hwnd))
      (then
        (global.set $eax (i32.const 0))
        (call $win16_api_return (i32.const 2))
        (return)))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_IsWindow (local.get $hwnd) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.ne (global.get $eax) (i32.const 0)))
    (call $win16_api_return (i32.const 2)))

  ;; USER.50 FindWindow(lpClassName, lpWindowName). Either argument may be a
  ;; NULL far pointer, which means "any", and a null selector is how that
  ;; arrives — it has to stay a zero pointer rather than become the base of
  ;; whatever segment zero is.
  (func $win16_FindWindow
    (local $cls i32) (local $title i32)
    (local.set $title (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (if (i32.eqz (call $win16_arg16 (i32.const 1))) (then (local.set $title (i32.const 0))))
    (local.set $cls (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 3)) (call $win16_arg16 (i32.const 2))))
    (if (i32.eqz (call $win16_arg16 (i32.const 3))) (then (local.set $cls (i32.const 0))))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_FindWindowA (local.get $cls) (local.get $title)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 8)))

  ;; USER.431 AnsiUpper / .432 AnsiLower(lpsz) and USER.437 AnsiUpperBuff /
  ;; .438 AnsiLowerBuff(lpsz, cchLength).
  ;;
  ;; The first pair takes either a string or, when the selector is zero, a
  ;; single character in the low byte — the same MAKEINTRESOURCE-shaped trick
  ;; the resource calls use, and callers rely on both spellings. The buffered
  ;; pair takes a length rather than a terminator, and a length of zero means
  ;; 65536 bytes.
  (func $win16_ansi_case (param $upper i32) (param $buffered i32)
    (local $p i32) (local $n i32) (local $i i32) (local $ch i32) (local $sel i32)
    (if (local.get $buffered)
      (then
        (local.set $n (call $win16_arg16 (i32.const 0)))
        (if (i32.eqz (local.get $n)) (then (local.set $n (i32.const 0x10000))))
        (local.set $sel (call $win16_arg16 (i32.const 2)))
        (local.set $p (call $win16_far_to_guest (local.get $sel)
                        (call $win16_arg16 (i32.const 1)))))
      (else
        (local.set $sel (call $win16_arg16 (i32.const 1)))
        (local.set $p (call $win16_far_to_guest (local.get $sel)
                        (call $win16_arg16 (i32.const 0))))
        ;; A null selector: the "string" is one character in the offset.
        (if (i32.eqz (local.get $sel))
          (then
            (local.set $ch (i32.and (call $win16_arg16 (i32.const 0)) (i32.const 0xFF)))
            (if (local.get $upper)
              (then (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x61))
                                 (i32.le_u (local.get $ch) (i32.const 0x7A)))
                      (then (local.set $ch (i32.sub (local.get $ch) (i32.const 0x20))))))
              (else (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x41))
                                 (i32.le_u (local.get $ch) (i32.const 0x5A)))
                      (then (local.set $ch (i32.add (local.get $ch) (i32.const 0x20)))))))
            (global.set $edx (i32.const 0))
            (global.set $eax (local.get $ch))
            (call $win16_api_return (i32.const 4))
            (return)))
        (local.set $n (i32.const 0x10000))))
    (block $done (loop $chars
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $ch (call $gl8 (i32.add (local.get $p) (local.get $i))))
      ;; An unbuffered call stops at the terminator; a buffered one does not.
      (if (i32.and (i32.eqz (local.get $buffered)) (i32.eqz (local.get $ch)))
        (then (br $done)))
      (if (local.get $upper)
        (then (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x61))
                           (i32.le_u (local.get $ch) (i32.const 0x7A)))
                (then (call $gs8 (i32.add (local.get $p) (local.get $i))
                        (i32.sub (local.get $ch) (i32.const 0x20))))))
        (else (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x41))
                           (i32.le_u (local.get $ch) (i32.const 0x5A)))
                (then (call $gs8 (i32.add (local.get $p) (local.get $i))
                        (i32.add (local.get $ch) (i32.const 0x20)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $chars)))
    (if (local.get $buffered)
      (then
        (global.set $eax (local.get $i))
        (call $win16_api_return (i32.const 6)))
      (else
        ;; Answers with the string it was given.
        (global.set $edx (local.get $sel))
        (global.set $eax (call $win16_arg16 (i32.const 0)))
        (call $win16_api_return (i32.const 4)))))

  ;; USER.472 AnsiNext(lpszCurrentChar) -> the next character. With a
  ;; single-byte character set that is the pointer plus one, except at the
  ;; terminating NUL, where AnsiNext stands still so a walk cannot run off the
  ;; end of the string.
  (func $win16_AnsiNext
    (local $sel i32) (local $off i32)
    (local.set $off (call $win16_arg16 (i32.const 0)))
    (local.set $sel (call $win16_arg16 (i32.const 1)))
    (if (call $gl8 (call $win16_far_to_guest (local.get $sel) (local.get $off)))
      (then (local.set $off (i32.and (i32.add (local.get $off) (i32.const 1))
                                     (i32.const 0xFFFF)))))
    (global.set $edx (local.get $sel))
    (global.set $eax (local.get $off))
    (call $win16_api_return (i32.const 4)))

  (func $win16_LoadString
    (local $id i32) (local $max i32) (local $dst i32)
    (local $p i32) (local $end i32) (local $i i32) (local $len i32) (local $n i32)
    (local.set $id  (call $win16_arg16 (i32.const 3)))
    (local.set $max (call $win16_arg16 (i32.const 0)))
    (local.set $dst (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    ;; Which module's strings — the instance handle decides, exactly as it does
    ;; for the Load* family. Stones keeps each stone style's name in that
    ;; style's own DLL and asks for it with that DLL's handle; answering out of
    ;; the task's own resources found nothing and it declared the styles
    ;; corrupted.
    (global.set $win16_res_module_id
      (call $win16_res_module (call $win16_arg16 (i32.const 4))))

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
    (global.set $win16_res_module_id (i32.const 0))
    (call $win16_api_return (i32.const 10)))

  ;; The scroll bar of a window, USER.62..65. The state lives in one place for
  ;; both worlds — the per-window scroll table the 32-bit handlers keep — so
  ;; these only narrow. SB_HORZ/SB_VERT/SB_CTL are the same three numbers in
  ;; both, and every position and limit is a signed word.
  ;;
  ;; USER.62 SetScrollPos(hWnd, nBar, nPos, bRedraw) -> the previous position.
  (func $win16_SetScrollPos
    (local $hwnd i32) (local $bar i32) (local $pos i32) (local $redraw i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 3))))
    (local.set $bar (call $win16_arg16 (i32.const 2)))
    (local.set $pos (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (local.set $redraw (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_SetScrollPos (local.get $hwnd) (local.get $bar)
      (local.get $pos) (local.get $redraw) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 8)))

  ;; USER.63 GetScrollPos(hWnd, nBar) -> the position.
  (func $win16_GetScrollPos
    (local $hwnd i32) (local $bar i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 1))))
    (local.set $bar (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_GetScrollPos (local.get $hwnd) (local.get $bar)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 4)))

  ;; USER.64 SetScrollRange(hWnd, nBar, nMinPos, nMaxPos, bRedraw).
  (func $win16_SetScrollRange
    (local $hwnd i32) (local $bar i32) (local $lo i32) (local $hi i32)
    (local $redraw i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 4))))
    (local.set $bar (call $win16_arg16 (i32.const 3)))
    (local.set $lo (call $win16_coord (call $win16_arg16 (i32.const 2))))
    (local.set $hi (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (local.set $redraw (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 5))
    (call $win16_call32_arg (i32.const 4) (local.get $redraw))
    (call $handle_SetScrollRange (local.get $hwnd) (local.get $bar)
      (local.get $lo) (local.get $hi) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 10)))

  ;; USER.65 GetScrollRange(hWnd, nBar, lpMinPos, lpMaxPos). The two answers
  ;; are ints, which are words here — the 32-bit handler writes dwords, so it
  ;; writes into scratch and the words are stored from there.
  (func $win16_GetScrollRange
    (local $hwnd i32) (local $tmp i32) (local $lo i32) (local $hi i32)
    (local $bar i32) (local $have_lo i32) (local $have_hi i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 5))))
    (local.set $lo (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 3)) (call $win16_arg16 (i32.const 2))))
    (local.set $hi (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $tmp (global.get $GUEST_STACK))
    (local.set $bar (call $win16_arg16 (i32.const 4)))
    (local.set $have_lo (call $win16_arg16 (i32.const 3)))
    (local.set $have_hi (call $win16_arg16 (i32.const 1)))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_GetScrollRange (local.get $hwnd) (local.get $bar)
      (local.get $tmp) (i32.add (local.get $tmp) (i32.const 4))
      (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (if (local.get $have_lo)
      (then (call $gs16 (local.get $lo) (call $gl32 (local.get $tmp)))))
    (if (local.get $have_hi)
      (then (call $gs16 (local.get $hi)
              (call $gl32 (i32.add (local.get $tmp) (i32.const 4))))))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 12)))

  ;; USER.61 ScrollWindow(hWnd, XAmount, YAmount, lpRect, lpClipRect). Either
  ;; rectangle may be NULL, meaning the whole client area, and must stay NULL
  ;; rather than becoming a pointer to a zero rectangle.
  (func $win16_ScrollWindow
    (local $hwnd i32) (local $rc i32) (local $clip i32)
    (local $dx i32) (local $dy i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 6))))
    (local.set $dx (call $win16_coord (call $win16_arg16 (i32.const 5))))
    (local.set $dy (call $win16_coord (call $win16_arg16 (i32.const 4))))
    (if (call $win16_arg16 (i32.const 3))
      (then
        (local.set $rc (global.get $GUEST_STACK))
        (call $win16_rect_widen (local.get $rc) (call $win16_far_to_guest
          (call $win16_arg16 (i32.const 3)) (call $win16_arg16 (i32.const 2))))))
    (if (call $win16_arg16 (i32.const 1))
      (then
        (local.set $clip (i32.add (global.get $GUEST_STACK) (i32.const 16)))
        (call $win16_rect_widen (local.get $clip) (call $win16_far_to_guest
          (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))))
    (call $win16_call32_begin (i32.const 5))
    (call $win16_call32_arg (i32.const 4) (local.get $clip))
    (call $handle_ScrollWindow (local.get $hwnd) (local.get $dx) (local.get $dy)
      (local.get $rc) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 14)))

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

  ;; USER.68 ReleaseDC(hWnd, hDC) -> nonzero if it released one.
  ;;
  ;; The handle is checked against the DC table before anything happens to it,
  ;; because a task may hand over something that is not a DC and Windows
  ;; answers zero rather than acting. Klotski pushes its two arguments the
  ;; other way round, so what arrives here is its window: releasing that did
  ;; nothing, but forgetting it took the window's place in the handle map away
  ;; and the next DC was given the same number. The task then showed and
  ;; painted its DC instead of its window, and drew nothing at all.
  (func $win16_ReleaseDC
    (local $hdc i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (if (i32.eqz (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
      (then
        (global.set $eax (i32.const 0))
        (call $win16_api_return (i32.const 4))
        (return)))
    (drop (call $host_release_dc (local.get $hdc)))
    ;; The DC is gone, so its place in the handle map is free. A pump that gets
    ;; and releases a DC every iteration would otherwise fill the map.
    (call $win16_h16_forget (local.get $hdc))
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

  ;; The same argument read the other way: a resource named by string rather
  ;; than by number arrives as a far pointer, and the selector is what tells
  ;; the two apart. Returns the WASM address of the name, or 0 when the
  ;; argument is an integer id after all.
  ;;
  ;; MAKEINTRESOURCE puts the id in the offset with a zero selector, which is
  ;; exactly the shape this rejects, so the two never disagree about an
  ;; argument.
  (func $win16_res_name_wa (param $n i32) (result i32)
    (if (i32.eqz (call $win16_arg16 (i32.add (local.get $n) (i32.const 1))))
      (then (return (i32.const 0))))
    (call $g2w (call $win16_far_to_guest
      (call $win16_arg16 (i32.add (local.get $n) (i32.const 1)))
      (call $win16_arg16 (local.get $n)))))

  ;; Find a resource from a Load*-style argument pair, by id or by name.
  ;; Every Load* call in this family is (hInstance, lpName), so the instance
  ;; handle is the word above the name's far pointer. It decides which module's
  ;; resources are searched — see $win16_res_module — and is cleared again so
  ;; nothing else inherits it.
  (func $win16_res_lookup (param $type i32) (param $n i32) (result i32)
    (local $id i32) (local $found i32)
    (global.set $win16_res_module_id
      (call $win16_res_module (call $win16_arg16 (i32.add (local.get $n) (i32.const 2)))))
    (local.set $id (call $win16_res_arg (local.get $n)))
    (if (i32.ne (local.get $id) (i32.const -1))
      (then (local.set $found (call $win16_find_resource (local.get $type) (local.get $id))))
      (else (local.set $found (call $win16_find_resource_ex (local.get $type) (i32.const 0)
              (call $win16_res_name_wa (local.get $n))))))
    (global.set $win16_res_module_id (i32.const 0))
    (local.get $found))

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
    (local $data i32)
    (global.set $eax (i32.const 0))
    (local.set $data (call $win16_res_lookup (i32.const 2) (i32.const 0)))
    (if (local.get $data)
      (then (global.set $eax (call $win16_h16 (call $gdi_bitmap_create_resource
              (local.get $data) (global.get $win16_res_len))))))
    (call $win16_api_return (i32.const 6)))

  ;; USER.174 LoadIcon(hInstance, lpIconName) -> HICON.
  ;;
  ;; The handle is opaque: it identifies the resource for a later DrawIcon, and
  ;; nothing decodes NE icon pixels yet. That is the same answer the Win32 path
  ;; gives for an icon it cannot intern, and it is enough for the overwhelmingly
  ;; common use — handing the icon straight to RegisterClass.
  ;;
  ;; An icon named by string used to fail outright here, which is not a rare
  ;; corner: Solitaire's is `RT_GROUP_ICON id="SOL"`, and both the standard
  ;; `IDI_APPLICATION`-style predefined names and a module's own named icon
  ;; arrive this way. Answer for a name we can actually find in the module, and
  ;; for the predefined ones, which belong to USER rather than to the task and
  ;; so will never be in its resource table.
  (func $win16_LoadIcon
    (local $id i32) (local $name i32)
    (local.set $id (call $win16_res_arg (i32.const 0)))
    (global.set $eax (i32.const 0))
    (if (i32.ne (local.get $id) (i32.const -1))
      (then
        (global.set $eax (call $win16_h16 (i32.const 0x60001)))
        (call $win16_api_return (i32.const 6))
        (return)))
    (local.set $name (call $win16_res_name_wa (i32.const 0)))
    (if (i32.or
          (i32.ne (call $win16_find_resource_ex
                    (i32.const 14) (i32.const 0) (local.get $name)) (i32.const 0))
          (i32.ne (call $win16_find_resource_ex
                    (i32.const 3) (i32.const 0) (local.get $name)) (i32.const 0)))
      (then (global.set $eax (call $win16_h16 (i32.const 0x60001)))))
    (call $win16_api_return (i32.const 6)))

  ;; USER.286 GetDesktopWindow(). The desktop is 0x10000 on the 32-bit side and
  ;; goes through the handle map like any other window.
  (func $win16_GetDesktopWindow
    (global.set $eax (call $win16_h16 (i32.const 0x10000)))
    (call $win16_api_return (i32.const 0)))

  ;; USER.1 MessageBox(hWnd, lpText, lpCaption, wType) -> the button pressed.
  ;;
  ;; A message box takes the task over until it is dismissed, so this cannot
  ;; return: it drops its own frame, remembers where it was going to return, and
  ;; parks EIP on the modal pump slot in the thunk segment. The run loop
  ;; re-enters that slot every pass, which drives the dialog's painting and
  ;; yields to the host for input; when a button is pressed the pump splices the
  ;; call back together with the result in AX.
  ;;
  ;; Not bridged to $handle_MessageBoxA, which parks EIP on the 32-bit pump
  ;; thunk — an address outside the selector arena, which a 16-bit task cannot
  ;; execute from. The dialog itself is the same one.
  (func $win16_MessageBox
    (local $hwnd i32) (local $text i32) (local $caption i32) (local $type i32)
    (local $dlg i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 5))))
    (local.set $text (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 4)) (call $win16_arg16 (i32.const 3))))
    (local.set $caption (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (if (i32.eqz (call $win16_arg16 (i32.const 2))) (then (local.set $caption (i32.const 0))))
    (local.set $type (call $win16_arg16 (i32.const 0)))
    (global.set $win16_modal_ret (call $win16_take_return (i32.const 12)))
    (drop (call $host_message_box (local.get $hwnd)
      (call $g2w (local.get $text)) (call $g2w (local.get $caption)) (local.get $type)))
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $create_msgbox_dialog (local.get $dlg) (local.get $hwnd)
      (select (call $g2w (local.get $caption)) (i32.const 0) (local.get $caption))
      (call $g2w (local.get $text)) (local.get $type))
    (global.set $modal_dlg_hwnd (local.get $dlg))
    (global.set $modal_result (i32.const 0))
    (call $win16_modal_park))

  (func $win16_modal_park
    (call $win16_set_sreg (i32.const 1) (global.get $WIN16_THUNK_SEL))
    (global.set $eip (i32.add (global.get $seg_base_cs) (global.get $WIN16_MODAL_PUMP)))
    (global.set $yield_flag (i32.const 1))
    (global.set $yield_reason (i32.const 6))
    (global.set $steps (i32.const 0)))

  (func $win16_user (param $ordinal i32) (result i32)
    (local $arg i32) (local $arg2 i32) (local $arg3 i32)
    ;; USER.13 GetTickCount and USER.15 GetCurrentTime are the same clock; the
    ;; second name is the Windows 2.x spelling that survived into 3.x headers.
    (if (i32.eq (local.get $ordinal) (i32.const 13))
      (then (call $win16_GetCurrentTime) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 47))
      (then (call $win16_IsWindow) (return (i32.const 1))))
    (if (i32.or (i32.eq (local.get $ordinal) (i32.const 412))
                (i32.eq (local.get $ordinal) (i32.const 413)))
      (then (call $win16_DeleteMenu) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 410))
      (then (call $win16_change_menu (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 411))
      (then (call $win16_change_menu (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 414))
      (then (call $win16_change_menu (i32.const 2)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 17))
      (then (call $win16_GetCursorPos) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 60))
      (then (call $win16_GetActiveWindow) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 70))
      (then (call $win16_SetCursorPos) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 36))
      (then (call $win16_GetWindowText) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 38))
      (then (call $win16_GetWindowTextLength) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 222))
      (then (call $win16_GetKeyboardState) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 223))
      (then (call $win16_SetKeyboardState) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 243))
      (then (call $win16_GetDialogBaseUnits) (return (i32.const 1))))
    ;; SetMessageQueue(cMsg) asks for a queue of a given size. This one is not
    ;; sized, so the request always succeeds — which is the answer Windows also
    ;; gives when the queue it already has is big enough.
    ;; GetWindowTask(hWnd) — which task owns the window. There is one task
    ;; here, and its hTask is its DGROUP selector, the same answer
    ;; GetCurrentTask gives.
    (if (i32.eq (local.get $ordinal) (i32.const 224))
      (then (call $win16_local_identity (i32.const 2) (global.get $sreg_ds))
            (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 266))
      (then (call $win16_local_identity (i32.const 2) (i32.const 1))
            (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 272))   ;; IsZoomed
      (then (call $win16_hwnd_query (i32.const 7)) (return (i32.const 1))))
    ;; USER.282/283 are the window-aware spellings of GDI.361/362.
    (if (i32.eq (local.get $ordinal) (i32.const 282))
      (then (call $win16_SelectPalette) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 283))
      (then (call $win16_RealizePalette) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 129))
      (then (call $win16_class_word (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 130))
      (then (call $win16_class_word (i32.const 1)) (return (i32.const 1))))
    ;; USER.112 WaitMessage — "sleep until something arrives". A task pumping
    ;; its own loop cannot be slept here: its stack is its own and the host
    ;; delivers input between batches, so the honest equivalent is to give the
    ;; host its turn and come straight back. The caller loops on GetMessage
    ;; either way, which is what it would do on Windows after waking.
    (if (i32.eq (local.get $ordinal) (i32.const 112))
      (then
        (global.set $yield_flag (i32.const 1))
        (call $win16_local_identity (i32.const 0) (i32.const 1))
        (return (i32.const 1))))
    ;; USER.156 GetSystemMenu(hWnd, bRevert) -> the window's system menu, which
    ;; is the same one for every window here. A task takes it to grey out
    ;; Close or to add a line of its own; both Visual Basic games ask for it
    ;; while building their form.
    (if (i32.eq (local.get $ordinal) (i32.const 156))
      (then
        (local.set $arg (call $win16_h32 (call $win16_arg16 (i32.const 1))))
        (local.set $arg2 (call $win16_arg16 (i32.const 0)))
        (call $win16_call32_begin (i32.const 2))
        (call $handle_GetSystemMenu (local.get $arg) (local.get $arg2)
          (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (global.set $eax (call $win16_h16 (global.get $eax)))
        (call $win16_api_return (i32.const 4))
        (return (i32.const 1))))
    ;; USER.58 GetClassName(hWnd, lpClassName, nMaxCount) -> its length. Tic
    ;; Tac Drop asks every window it made what class it is while wiring up its
    ;; form.
    (if (i32.eq (local.get $ordinal) (i32.const 58))
      (then
        (local.set $arg (call $win16_h32 (call $win16_arg16 (i32.const 3))))
        (local.set $arg2 (call $win16_far_to_guest
          (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
        (local.set $arg3 (call $win16_arg16 (i32.const 0)))
        (call $win16_call32_begin (i32.const 3))
        (call $handle_GetClassNameA (local.get $arg) (local.get $arg2)
          (local.get $arg3)
          (i32.const 0) (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (call $win16_api_return (i32.const 8))
        (return (i32.const 1))))
    ;; USER.151 CreateMenu / USER.152 CreatePopupMenu — an empty menu the task
    ;; then fills with AppendMenu. Rodent's Revenge builds its own.
    (if (i32.eq (local.get $ordinal) (i32.const 151))
      (then
        (call $win16_call32_begin (i32.const 0))
        (call $handle_CreateMenu (i32.const 0) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (global.set $eax (call $win16_h16 (global.get $eax)))
        (call $win16_api_return (i32.const 0))
        (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 152))
      (then
        (call $win16_call32_begin (i32.const 0))
        (call $handle_CreatePopupMenu (i32.const 0) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (global.set $eax (call $win16_h16 (global.get $eax)))
        (call $win16_api_return (i32.const 0))
        (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 407))
      (then (call $win16_CreateIcon) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 131))
      (then (call $win16_class_long (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 132))
      (then (call $win16_class_long (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 421))
      (then (call $win16_wvsprintf) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 50))
      (then (call $win16_FindWindow) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 431))
      (then (call $win16_ansi_case (i32.const 1) (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 432))
      (then (call $win16_ansi_case (i32.const 0) (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 437))
      (then (call $win16_ansi_case (i32.const 1) (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 438))
      (then (call $win16_ansi_case (i32.const 0) (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 472))
      (then (call $win16_AnsiNext) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 121))
      (then (call $win16_hook (i32.const 3)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 234))
      (then (call $win16_hook (i32.const 4)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 235))
      (then (call $win16_hook (i32.const 5)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 291))
      (then (call $win16_hook (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 292))
      (then (call $win16_hook (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 293))
      (then (call $win16_hook (i32.const 2)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 18))
      (then (call $win16_hwnd_query (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 19))
      (then (call $win16_ReleaseCapture) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 22))
      (then (call $win16_SetFocus) (return (i32.const 1))))
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
    (if (i32.eq (local.get $ordinal) (i32.const 28))
      (then (call $win16_map_point (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 30))
      (then (call $win16_window_from_point (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 191))
      (then (call $win16_window_from_point (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 29))
      (then (call $win16_map_point (i32.const 0)) (return (i32.const 1))))
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
    (if (i32.eq (local.get $ordinal) (i32.const 83))
      (then (call $win16_FrameRect) (return (i32.const 1))))
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
    (if (i32.eq (local.get $ordinal) (i32.const 73))
      (then (call $win16_SetRectEmpty) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 74))
      (then (call $win16_CopyRect) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 75))
      (then (call $win16_IsRectEmpty) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 77))
      (then (call $win16_OffsetRect) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 80))
      (then (call $win16_UnionRect) (return (i32.const 1))))
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
    (if (i32.eq (local.get $ordinal) (i32.const 259))
      (then (call $win16_BeginDeferWindowPos) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 260))
      (then (call $win16_DeferWindowPos) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 261))
      (then (call $win16_EndDeferWindowPos) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 232))
      (then (call $win16_SetWindowPos) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 229))
      (then (call $win16_GetTopWindow) (return (i32.const 1))))
    ;; GetNextWindow is GetWindow with the same two arguments; USER kept both
    ;; names and one implementation.
    (if (i32.or (i32.eq (local.get $ordinal) (i32.const 262))
                (i32.eq (local.get $ordinal) (i32.const 230)))
      (then (call $win16_GetWindow) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 277))
      (then (call $win16_GetDlgCtrlID) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 111))
      (then (call $win16_SendMessage) (return (i32.const 1))))
    ;; Dialogs — see 09e2.
    (if (i32.eq (local.get $ordinal) (i32.const 87))
      (then (call $win16_DialogBox (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 239))
      (then (call $win16_DialogBox (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 88))
      (then (call $win16_EndDialog) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 91))
      (then (call $win16_GetDlgItem) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 92))
      (then (call $win16_SetDlgItemText) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 93))
      (then (call $win16_GetDlgItemText) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 94))
      (then (call $win16_SetDlgItemInt) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 95))
      (then (call $win16_GetDlgItemInt) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 96))
      (then (call $win16_CheckRadioButton) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 97))
      (then (call $win16_CheckDlgButton) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 98))
      (then (call $win16_IsDlgButtonChecked) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 101))
      (then (call $win16_SendDlgItemMessage) (return (i32.const 1))))
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
    (if (i32.eq (local.get $ordinal) (i32.const 61))
      (then (call $win16_ScrollWindow) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 62))
      (then (call $win16_SetScrollPos) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 63))
      (then (call $win16_GetScrollPos) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 64))
      (then (call $win16_SetScrollRange) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 65))
      (then (call $win16_GetScrollRange) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 5))
      (then (call $win16_InitApp) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 15))
      (then (call $win16_GetCurrentTime) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 176))
      (then (call $win16_LoadString) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 404))
      (then (call $win16_GetClassInfo) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 122))
      (then (call $win16_CallWindowProc) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 430))
      (then (call $win16_lstrcmp (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 471))
      (then (call $win16_lstrcmp (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 133))
      (then (call $win16_window_long (i32.const 0) (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 134))
      (then (call $win16_window_long (i32.const 1) (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 135))
      (then (call $win16_window_long (i32.const 0) (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 136))
      (then (call $win16_window_long (i32.const 1) (i32.const 0)) (return (i32.const 1))))
    (i32.const 0))

  ;; ---- Windows ----

  (func $win16_push16 (param $v i32)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 2)))
    (call $gs16 (global.get $esp) (local.get $v)))

  ;; Narrowing lParam is not always a truncation either. When it points at a
  ;; struct, the struct itself is the 32-bit shape and a 16-bit procedure will
  ;; `les` the two words it is handed and then read every field at the wrong
  ;; offset — Solitaire's Deck dialog draws each card back from a
  ;; DRAWITEMSTRUCT and got ES = the top half of a 32-bit heap address, which
  ;; is no selector at all. So it is rebuilt in the task's own DGROUP, in the
  ;; 16-bit shape, and passed as a far pointer there.
  ;;
  ;; WM_DRAWITEM is the only one of this family the controls ever send. Its
  ;; struct is read-only to the procedure, so a copy out is all it needs;
  ;; WM_MEASUREITEM would want the width and height copied back and has no
  ;; sender here, so it is deliberately not translated rather than translated
  ;; wrongly.
  ;;
  ;; DRAWITEMSTRUCT is 48 bytes in Win32 and 26 in Win16: five UINTs, two
  ;; handles, a RECT of ints, and the itemData DWORD.
  (func $win16_msg_lparam16 (param $msg i32) (param $lparam i32) (result i32)
    (local $src i32) (local $dst i32)
    (if (i32.ne (local.get $msg) (i32.const 0x002B))
      (then (return (local.get $lparam))))
    (if (i32.eqz (global.get $win16_msg_scratch))
      (then (return (local.get $lparam))))
    (local.set $src (local.get $lparam))
    ;; DGROUP by segment index, not through $seg_base_ds: DS is whatever the
    ;; last 16-bit code to run left in it — a DLL's own data segment, as often
    ;; as not — and the far pointer handed out below names DGROUP.
    (local.set $dst (i32.add (call $win16_seg_base (global.get $win16_auto_data))
      (i32.add (global.get $win16_msg_scratch)
               (i32.shl (global.get $win16_msg_slot) (i32.const 5)))))
    (call $gs16 (local.get $dst) (call $gl32 (local.get $src)))
    (call $gs16 (i32.add (local.get $dst) (i32.const 2))
      (call $gl32 (i32.add (local.get $src) (i32.const 4))))
    (call $gs16 (i32.add (local.get $dst) (i32.const 4))
      (call $gl32 (i32.add (local.get $src) (i32.const 8))))
    (call $gs16 (i32.add (local.get $dst) (i32.const 6))
      (call $gl32 (i32.add (local.get $src) (i32.const 12))))
    (call $gs16 (i32.add (local.get $dst) (i32.const 8))
      (call $gl32 (i32.add (local.get $src) (i32.const 16))))
    (call $gs16 (i32.add (local.get $dst) (i32.const 10))
      (call $win16_h16 (call $gl32 (i32.add (local.get $src) (i32.const 20)))))
    (call $gs16 (i32.add (local.get $dst) (i32.const 12))
      (call $win16_h16 (call $gl32 (i32.add (local.get $src) (i32.const 24)))))
    (call $win16_rect_narrow (i32.add (local.get $dst) (i32.const 14))
      (i32.add (local.get $src) (i32.const 28)))
    (call $gs32 (i32.add (local.get $dst) (i32.const 22))
      (call $gl32 (i32.add (local.get $src) (i32.const 44))))
    (local.set $lparam
      (i32.or
        (i32.shl (call $win16_index_to_sel (global.get $win16_auto_data)) (i32.const 16))
        (i32.add (global.get $win16_msg_scratch)
                 (i32.shl (global.get $win16_msg_slot) (i32.const 5)))))
    (global.set $win16_msg_slot
      (i32.and (i32.add (global.get $win16_msg_slot) (i32.const 1)) (i32.const 3)))
    (local.get $lparam))

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
    ;; A 16-bit window procedure is a far pointer, so its selector is never
    ;; zero. Anything else is a procedure belonging to the 32-bit side or a
    ;; window with none at all, and entering it would set CS to the null
    ;; selector and run from offset zero of nothing.
    (if (i32.eqz (i32.shr_u (local.get $proc) (i32.const 16)))
      (then
        (call $host_log_i32 (i32.const 0xCA16A9F9))
        (call $host_log_i32 (local.get $proc))
        (call $host_log_i32 (local.get $hwnd))
        (call $host_log_i32 (local.get $msg))
        (unreachable)))
    ;; A window whose procedure belongs to this side — a built-in control, a
    ;; WAT-native window, the default procedure — has no 16-bit code to enter.
    ;; Its "far pointer" is a marker, and jumping to it loads CS with 0xFFFE
    ;; and runs from a selector that names no segment; Pipe Dream's first
    ;; CreateWindow died that way. Dispatch it here instead and hand the result
    ;; straight back to the caller, which is what entering it would have
    ;; produced anyway.
    (if (i32.ge_u (local.get $proc) (i32.const 0xFFFE0000))
      (then
        ;; Widen what was narrowed on the way out. WM_ERASEBKGND and
        ;; WM_PAINTICON carry a DC in wParam, and handing the 16-bit form to
        ;; the 32-bit side puts a 16-bit handle back into the message queue,
        ;; where the next GetMessage narrows it a second time and allocates a
        ;; fresh entry for it — a handle table that fills up once per pump
        ;; iteration.
        (if (i32.or (i32.eq (local.get $msg) (i32.const 0x0014))
                    (i32.eq (local.get $msg) (i32.const 0x0027)))
          (then (local.set $wparam (call $win16_h32 (local.get $wparam)))))
        (local.set $proc (call $wat_wndproc_dispatch (call $win16_h32 (local.get $hwnd))
          (local.get $msg) (local.get $wparam) (local.get $lparam)))
        (global.set $eax (i32.and (local.get $proc) (i32.const 0xFFFF)))
        (global.set $edx (i32.shr_u (local.get $proc) (i32.const 16)))
        (call $win16_set_sreg (i32.const 1) (local.get $ret_sel))
        (global.set $eip (i32.add (global.get $seg_base_cs) (local.get $ret_ip)))
        (return)))
    (local.set $lparam (call $win16_msg_lparam16 (local.get $msg) (local.get $lparam)))
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

  ;; ---- Continuation records ----
  ;;
  ;; An API that hands control to guest code has to remember two things across
  ;; the call: where it was going to return, and what it was going to return.
  ;; Those live on the task's own stack rather than in globals, under whatever
  ;; frame is being handed off, because these calls nest — Hearts creates its
  ;; status bar from inside its main window's WM_CREATE, so a second
  ;; CreateWindow is in flight before the first has finished. In globals the
  ;; inner one overwrites the outer's return address and the outer CreateWindow
  ;; comes back to the wrong place with the wrong handle.
  ;;
  ;; Three words: return selector, return offset, result. The guest procedure
  ;; RETFs its own arguments off and lands on the record.
  (func $win16_cont_push (param $ret i32) (param $result i32)
    (call $win16_push16 (i32.shr_u (local.get $ret) (i32.const 16)))
    (call $win16_push16 (local.get $ret))
    (call $win16_push16 (local.get $result)))

  (func $win16_cont_result (result i32)
    (call $gl16 (global.get $esp)))

  (func $win16_cont_resume
    (local $result i32) (local $ip i32) (local $sel i32)
    (local.set $result (call $gl16 (global.get $esp)))
    (local.set $ip     (call $gl16 (i32.add (global.get $esp) (i32.const 2))))
    (local.set $sel    (call $gl16 (i32.add (global.get $esp) (i32.const 4))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 6)))
    (global.set $eax (local.get $result))
    (global.set $edx (i32.const 0))
    (call $win16_set_sreg (i32.const 1) (local.get $sel))
    (global.set $eip (i32.add (global.get $seg_base_cs) (local.get $ip))))

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

  ;; USER.404 GetClassInfo(hInstance, lpszClassName, lpWndClass) -> BOOL.
  ;;
  ;; The narrowing half of $win16_RegisterClass: the class table holds one
  ;; 32-bit WNDCLASSA per class whichever world registered it, and this writes
  ;; it back out in the 16-bit shape. lpfnWndProc goes back as the two words it
  ;; arrived as, so a class registered by this task round-trips exactly.
  ;;
  ;; MFC asks this before registering each of its generated "Afx:..." classes,
  ;; and a truthful "no such class" is what makes it go on and register one.
  (func $win16_GetClassInfo
    (local $name i32) (local $dst i32) (local $tmp i32) (local $proc i32)
    (local $inst i32)
    (local.set $dst (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $name (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 3)) (call $win16_arg16 (i32.const 2))))
    (local.set $tmp (global.get $GUEST_STACK))
    (call $zero_memory (call $g2w (local.get $tmp)) (i32.const 40))
    (local.set $inst (call $win16_arg16 (i32.const 4)))
    (call $win16_call32_begin (i32.const 3))
    (call $handle_GetClassInfoA (local.get $inst)
      (local.get $name) (local.get $tmp) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (if (global.get $eax)
      (then
        (call $gs16 (local.get $dst) (call $gl32 (local.get $tmp)))
        (local.set $proc (call $gl32 (i32.add (local.get $tmp) (i32.const 4))))
        (call $gs16 (i32.add (local.get $dst) (i32.const 2)) (local.get $proc))
        (call $gs16 (i32.add (local.get $dst) (i32.const 4))
          (i32.shr_u (local.get $proc) (i32.const 16)))
        (call $gs16 (i32.add (local.get $dst) (i32.const 6))
          (call $gl32 (i32.add (local.get $tmp) (i32.const 8))))
        (call $gs16 (i32.add (local.get $dst) (i32.const 8))
          (call $gl32 (i32.add (local.get $tmp) (i32.const 12))))
        (call $gs16 (i32.add (local.get $dst) (i32.const 10))
          (call $gl32 (i32.add (local.get $tmp) (i32.const 16))))
        (call $gs16 (i32.add (local.get $dst) (i32.const 12))
          (call $win16_h16 (call $gl32 (i32.add (local.get $tmp) (i32.const 20)))))
        (call $gs16 (i32.add (local.get $dst) (i32.const 14))
          (call $win16_h16 (call $gl32 (i32.add (local.get $tmp) (i32.const 24)))))
        (call $gs16 (i32.add (local.get $dst) (i32.const 16))
          (call $win16_h16 (call $gl32 (i32.add (local.get $tmp) (i32.const 28)))))
        ;; The two names stay where the caller's own strings are: a far pointer
        ;; into the class record would name memory no selector covers.
        (call $gs32 (i32.add (local.get $dst) (i32.const 18)) (i32.const 0))
        (call $gs32 (i32.add (local.get $dst) (i32.const 22)) (i32.or
          (i32.shl (call $win16_arg16 (i32.const 3)) (i32.const 16))
          (call $win16_arg16 (i32.const 2))))))
    (global.set $eax (i32.ne (global.get $eax) (i32.const 0)))
    (call $win16_api_return (i32.const 10)))

  ;; A 16-bit window coordinate is a signed word, and CW_USEDEFAULT is 0x8000
  ;; rather than 0x80000000 — the same "leave it to the system" sentinel at a
  ;; different width, so it has to be translated rather than sign-extended.
  (func $win16_coord (param $v i32) (result i32)
    (if (i32.eq (local.get $v) (i32.const 0x8000))
      (then (return (i32.const 0x80000000))))
    (i32.shr_s (i32.shl (local.get $v) (i32.const 16)) (i32.const 16)))

  ;; USER.133-136 GetWindowWord/SetWindowWord/GetWindowLong/SetWindowLong.
  ;;
  ;; The negative indices mean the same things in both worlds — GWL_WNDPROC -4,
  ;; GWL_HINSTANCE -6, GWL_HWNDPARENT -8, GWL_ID -12, GWL_STYLE -16,
  ;; GWL_EXSTYLE -20 — so the index goes to the 32-bit handler unchanged and
  ;; only the width differs. GWL_WNDPROC is the one that matters here: its value
  ;; is a far pointer packed selector:offset, which is exactly what the window
  ;; table already holds for a 16-bit window, so subclassing works by storing
  ;; the dword as-is.
  (func $win16_window_long (param $set i32) (param $word i32)
    (local $hwnd i32) (local $index i32) (local $value i32) (local $argbytes i32)
    (local.set $argbytes (select
      (select (i32.const 8) (i32.const 6) (i32.eqz (local.get $word)))
      (i32.const 4)
      (local.get $set)))
    (if (local.get $set)
      (then
        (if (local.get $word)
          (then (local.set $value (call $win16_arg16 (i32.const 0))))
          (else (local.set $value (call $win16_arg32 (i32.const 0)))))
        (local.set $index (call $win16_arg16
          (select (i32.const 1) (i32.const 2) (local.get $word))))
        (local.set $hwnd (call $win16_h32 (call $win16_arg16
          (select (i32.const 2) (i32.const 3) (local.get $word))))))
      (else
        (local.set $index (call $win16_arg16 (i32.const 0)))
        (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 1))))))
    ;; The index is a signed word on the wire and a signed dword to the handler.
    (local.set $index (i32.shr_s (i32.shl (local.get $index) (i32.const 16)) (i32.const 16)))
    (call $win16_call32_begin (i32.const 3))
    (if (local.get $set)
      (then (call $handle_SetWindowLongA (local.get $hwnd) (local.get $index)
              (local.get $value) (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle_GetWindowLongA (local.get $hwnd) (local.get $index)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (call $win16_call32_end)
    ;; A window procedure this emulator supplies has no address a 16-bit task
    ;; could call, so it is reported as the thunk that stands for it.
    (if (i32.and (i32.eq (local.get $index) (i32.const -4))
                 (i32.eqz (call $win16_is_far_proc (global.get $eax))))
      (then (global.set $eax (call $win16_builtin_wndproc))))
    ;; A word answer is a word; a long one comes back in DX:AX like any other.
    (if (local.get $word)
      (then (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF))))
      (else (global.set $edx (i32.shr_u (global.get $eax) (i32.const 16)))
            (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))))
    (call $win16_api_return (local.get $argbytes)))

  (func $win16_builtin_wndproc (result i32)
    (i32.or (i32.shl (global.get $WIN16_THUNK_SEL) (i32.const 16))
            (global.get $WIN16_BUILTIN_WNDPROC)))

  ;; Is this window procedure one a 16-bit task can actually far-call? The
  ;; window table holds both kinds: a far pointer for a procedure the task
  ;; registered, and a sentinel like 0xFFFE0001 or 0xFFFF0002 for one the
  ;; emulator supplies. Testing the selector against the loaded segments tells
  ;; them apart for certain — a sentinel's high word names no segment, and
  ;; neither does a zero one.
  (func $win16_is_far_proc (param $proc i32) (result i32)
    (local $sel i32)
    (local.set $sel (i32.shr_u (local.get $proc) (i32.const 16)))
    (if (i32.eqz (local.get $sel)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $sel) (global.get $WIN16_THUNK_SEL))
      (then (return (i32.const 0))))
    (i32.ne (call $win16_seg_base (call $win16_sel_to_index (local.get $sel)))
            (i32.const 0)))

  ;; DefDlgProc's share of a dialog's messages, reached by the two routes a
  ;; task can take to the procedure it did not write: DefWindowProc, and
  ;; CallWindowProc with the procedure our own window handed back when it was
  ;; subclassed. A command from the OK or Cancel button ends the dialog with
  ;; that id; the pump acts on it at its next pass, which is where Windows ends
  ;; the loop too. Returns 1 when it took the message.
  (func $win16_defdlg_command (param $hwnd i32) (param $message i32)
        (param $wparam i32) (result i32)
    (local $id i32)
    (if (i32.ne (local.get $message) (i32.const 0x0111))
      (then (return (i32.const 0))))
    (if (i32.eqz (call $dialog_proc_get (local.get $hwnd)))
      (then (return (i32.const 0))))
    (local.set $id (i32.and (local.get $wparam) (i32.const 0xFFFF)))
    (if (i32.and (i32.ne (local.get $id) (i32.const 1))
                 (i32.ne (local.get $id) (i32.const 2)))
      (then (return (i32.const 0))))
    (global.set $win16_dlg_result (local.get $id))
    (global.set $win16_dlg_ended (i32.const 1))
    (i32.const 1))

  ;; USER.122 CallWindowProc(lpPrevWndFunc, hWnd, msg, wParam, lParam) -> LONG.
  ;;
  ;; This is the other half of subclassing: an app that replaced a window
  ;; procedure calls the one it replaced. A real 16-bit procedure is entered
  ;; with the Pascal frame and the caller's own far return, exactly as
  ;; DispatchMessage does it, so its RETF 10 lands where CallWindowProc was
  ;; going to return with the result already in DX:AX.
  (func $win16_CallWindowProc
    (local $proc i32) (local $hwnd i32) (local $message i32)
    (local $wparam i32) (local $lparam i32) (local $ret i32)
    (local.set $proc (call $win16_arg32 (i32.const 5)))
    (local.set $hwnd (call $win16_arg16 (i32.const 4)))
    (local.set $message (call $win16_arg16 (i32.const 3)))
    (local.set $wparam (call $win16_arg16 (i32.const 2)))
    (local.set $lparam (call $win16_arg32 (i32.const 0)))
    (if (i32.eqz (call $win16_is_far_proc (local.get $proc)))
      (then
        (if (call $win16_defdlg_command (call $win16_h32 (local.get $hwnd))
                  (local.get $message) (local.get $wparam))
          (then
            (global.set $eax (i32.const 0))
            (global.set $edx (i32.const 0))
            (call $win16_api_return (i32.const 14))
            (return)))
        (call $win16_call32_begin (i32.const 4))
        (call $handle_DefWindowProcA (call $win16_h32 (local.get $hwnd))
          (local.get $message) (local.get $wparam) (local.get $lparam)
          (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (global.set $edx (i32.shr_u (global.get $eax) (i32.const 16)))
        (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (call $win16_api_return (i32.const 14))
        (return)))
    (local.set $ret (call $win16_take_return (i32.const 14)))
    (call $win16_enter_wndproc (local.get $proc) (local.get $hwnd)
      (local.get $message) (local.get $wparam) (local.get $lparam)
      (i32.shr_u (local.get $ret) (i32.const 16))
      (i32.and (local.get $ret) (i32.const 0xFFFF))))

  ;; Call the WH_CALLWNDPROC filter for a message about to be sent to a window.
  ;;
  ;; The filter takes (nCode, wParam, lParam) with lParam pointing at a
  ;; CWPSTRUCT — lParam(4) wParam(2) message(2) hwnd(2) — and WM_NCCREATE's own
  ;; lParam points at a CREATESTRUCT. Both are built below SP in the task's own
  ;; stack segment, which is where real USER puts them and the only place a far
  ;; pointer can reach without allocating anything. `cs` is the far pointer to a
  ;; CREATESTRUCT already built by the caller, or zero.
  ;;
  ;; The filter RETFs 8, so it removes its own arguments and leaves SP just
  ;; above the two structures; the continuation drops those, and their combined
  ;; size is fixed at $WIN16_CWP_SCRATCH so it needs no bookkeeping.
  (func $win16_hook_cwp_fire (param $hwnd16 i32) (param $msg i32) (param $wparam i32)
        (param $lparam i32) (param $cont_off i32)
    (local $base i32) (local $sel i32)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 10)))
    (local.set $base (global.get $esp))
    (local.set $sel (global.get $sreg_ss))
    (call $gs32 (local.get $base) (local.get $lparam))
    (call $gs16 (i32.add (local.get $base) (i32.const 4)) (local.get $wparam))
    (call $gs16 (i32.add (local.get $base) (i32.const 6)) (local.get $msg))
    (call $gs16 (i32.add (local.get $base) (i32.const 8)) (local.get $hwnd16))
    ;; nCode = HC_ACTION, wParam = TRUE for "sent by the current task".
    (call $win16_push16 (i32.const 0))
    (call $win16_push16 (i32.const 1))
    (call $win16_push16 (local.get $sel))
    (call $win16_push16 (i32.and (local.get $base) (i32.const 0xFFFF)))
    (call $win16_push16 (global.get $WIN16_THUNK_SEL))
    (call $win16_push16 (local.get $cont_off))
    (call $win16_set_sreg (i32.const 1) (i32.shr_u (global.get $win16_hook_cwp) (i32.const 16)))
    (global.set $eip (i32.add (global.get $seg_base_cs)
                              (i32.and (global.get $win16_hook_cwp) (i32.const 0xFFFF))))
    (global.set $steps (i32.const 0)))

  ;; Build a 16-bit CREATESTRUCT below SP and return a far pointer to it.
  ;;   +0 lpCreateParams(far) +4 hInstance +6 hMenu +8 hwndParent
  ;;   +10 cy +12 cx +14 y +16 x +18 style(L) +22 lpszName(far)
  ;;   +26 lpszClass(far) +30 dwExStyle(L)
  ;; Every field is the raw 16-bit value the caller passed, not the widened one:
  ;; an app reading this back expects its own pointers to compare equal.
  (func $win16_createstruct (param $param i32) (param $inst i32) (param $menu i32)
        (param $parent i32) (param $h i32) (param $w i32) (param $y i32) (param $x i32)
        (param $style i32) (param $name i32) (param $class i32) (param $exstyle i32)
        (result i32)
    (local $base i32)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 34)))
    (local.set $base (global.get $esp))
    (call $gs32 (local.get $base) (local.get $param))
    (call $gs16 (i32.add (local.get $base) (i32.const 4)) (local.get $inst))
    (call $gs16 (i32.add (local.get $base) (i32.const 6)) (local.get $menu))
    (call $gs16 (i32.add (local.get $base) (i32.const 8)) (local.get $parent))
    (call $gs16 (i32.add (local.get $base) (i32.const 10)) (local.get $h))
    (call $gs16 (i32.add (local.get $base) (i32.const 12)) (local.get $w))
    (call $gs16 (i32.add (local.get $base) (i32.const 14)) (local.get $y))
    (call $gs16 (i32.add (local.get $base) (i32.const 16)) (local.get $x))
    (call $gs32 (i32.add (local.get $base) (i32.const 18)) (local.get $style))
    (call $gs32 (i32.add (local.get $base) (i32.const 22)) (local.get $name))
    (call $gs32 (i32.add (local.get $base) (i32.const 26)) (local.get $class))
    (call $gs32 (i32.add (local.get $base) (i32.const 30)) (local.get $exstyle))
    (i32.or (i32.shl (global.get $sreg_ss) (i32.const 16))
            (i32.and (local.get $base) (i32.const 0xFFFF))))

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
    (local $exstyle i32) (local $hwnd i32) (local $cs i32) (local $redirected i32)
    (local $raw_class i32) (local $raw_title i32) (local $raw_param i32)
    (local $raw_menu i32) (local $raw_parent i32)
    (local $raw_x i32) (local $raw_y i32) (local $raw_w i32) (local $raw_h i32)
    (if (local.get $ex) (then (local.set $exstyle (call $win16_arg32 (i32.const 15)))))
    ;; The CREATESTRUCT the hook is shown carries the caller's own values, so
    ;; every argument is kept in its 16-bit form as well as the widened one.
    ;; They have to be read before the frame is dropped, not after.
    (local.set $raw_class (call $win16_arg32 (i32.const 13)))
    (local.set $raw_title (call $win16_arg32 (i32.const 11)))
    (local.set $raw_param (call $win16_arg32 (i32.const 0)))
    (local.set $raw_menu (call $win16_arg16 (i32.const 3)))
    (local.set $raw_parent (call $win16_arg16 (i32.const 4)))
    (local.set $raw_x (call $win16_arg16 (i32.const 8)))
    (local.set $raw_y (call $win16_arg16 (i32.const 7)))
    (local.set $raw_w (call $win16_arg16 (i32.const 6)))
    (local.set $raw_h (call $win16_arg16 (i32.const 5)))
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
    ;; For a child window the hMenu argument is the control id, not a handle,
    ;; and putting an id through the handle map stops the task on a number it
    ;; was never given — Cruel's first child button is control 4000.
    (local.set $menu (call $win16_arg16 (i32.const 3)))
    (if (i32.eqz (i32.and (local.get $style) (i32.const 0x40000000)))
      (then (local.set $menu (call $win16_h32 (local.get $menu)))))
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
    ;; WM_CREATE's lParam is zero rather than a CREATESTRUCT; a 16-bit app
    ;; reading one would need the narrow layout, and none of these do. The
    ;; WM_NCCREATE shown to the hook below does carry a real one.
    (local.set $hwnd (global.get $eax))
    (local.set $redirected (call $win16_call32_end_redirected))
    ;; Which class the window ended up with, and the procedure that came with
    ;; it. A window that answers nothing and paints nothing is usually one
    ;; whose class was not found — the name arrives as a far pointer and the
    ;; class table is keyed on the bytes it points at, so the two can miss
    ;; each other with nothing else to show for it.
    (if (global.get $win16_trace)
      (then
        (call $host_log_i32 (i32.const 0xCA16A9E6))
        (call $host_log_i32 (local.get $hwnd))
        (call $host_log_i32 (local.get $class))
        (call $host_log_i32 (call $wnd_table_get (local.get $hwnd)))
        (call $host_log_i32 (call $class_table_lookup
          (call $class_name_key (local.get $class))))))
    ;; The API's own frame goes now, and everything still owed goes on the stack
    ;; in its place: the return address, the handle, and whether WM_CREATE is
    ;; still to be delivered. Anything CreateWindow does from here can create
    ;; another window without disturbing this one.
    (call $win16_cont_push
      (call $win16_take_return (select (i32.const 34) (i32.const 30) (local.get $ex)))
      (call $win16_h16 (local.get $hwnd)))
    (call $win16_push16 (local.get $redirected))

    ;; Before the window's own procedure hears anything, the WH_CALLWNDPROC
    ;; filter sees the WM_NCCREATE that creating it sends. An MFC task attaches
    ;; its window object and subclasses the window from inside that call, so it
    ;; has to happen here — after the window exists and before WM_CREATE, which
    ;; is the first message the object is expected to handle.
    (if (i32.and (i32.ne (global.get $win16_hook_cwp) (i32.const 0))
                 (i32.ne (local.get $hwnd) (i32.const 0)))
      (then
        (local.set $cs (call $win16_createstruct
          (local.get $raw_param) (local.get $inst) (local.get $raw_menu)
          (local.get $raw_parent) (local.get $raw_h) (local.get $raw_w)
          (local.get $raw_y) (local.get $raw_x) (local.get $style)
          (local.get $raw_title) (local.get $raw_class) (local.get $exstyle)))
        (call $win16_hook_cwp_fire (call $gl16 (i32.add (global.get $esp) (i32.const 36)))
          (i32.const 0x0081) (i32.const 0) (local.get $cs)
          (global.get $WIN16_CONT_CWP))
        (return)))
    (call $win16_create_finish))

  ;; Everything CreateWindow still owes after the hook has run: WM_CREATE if the
  ;; 32-bit handler asked for it, and otherwise just the handle. On entry the
  ;; top of the stack is the redirected flag over a continuation record.
  ;; Reached both directly and from the WH_CALLWNDPROC continuation, so the two
  ;; paths cannot drift apart.
  (func $win16_create_finish
    (local $redirected i32)
    (local.set $redirected (call $gl16 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 2)))
    (if (local.get $redirected)
      (then
        (call $win16_enter_wndproc
          (call $wnd_table_get (call $win16_h32 (call $win16_cont_result)))
          (call $win16_cont_result) (i32.const 0x0001) (i32.const 0) (i32.const 0)
          (global.get $WIN16_THUNK_SEL) (global.get $WIN16_CONT_OFFSET))
        (return)))
    (call $win16_cont_resume))

  ;; USER.42 ShowWindow(hWnd, nCmdShow).
  ;;
  ;; Deliberately not $handle_ShowWindow: that one hands WM_ACTIVATEAPP to the
  ;; window procedure by redirecting EIP into a 32-bit frame, which is the one
  ;; thing a 16-bit task cannot survive. A Win16 app pumps messages for those
  ;; anyway, so this does the state change and lets the queue deliver the rest.
  ;;
  ;; Note on ordering: Windows sends WM_SIZE from inside ShowWindow, so
  ;; anything WinMain posts afterwards arrives behind it, while here it waits
  ;; for GetMessage's pending-size phase, which runs *after* the post queue.
  ;; Queueing it here does reverse that back — and was tried — but it is not a
  ;; free correction: Minesweeper paints less of itself and Hearts traps in its
  ;; MFC frame two batches in. Whatever those two depend on has to be
  ;; understood before the order moves.
  (func $win16_ShowWindow
    (local $hwnd i32) (local $show i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 1))))
    (local.set $show (call $win16_arg16 (i32.const 0)))
    (drop (call $post_queue_push (local.get $hwnd) (i32.const 0x0018)
      (i32.ne (local.get $show) (i32.const 0)) (i32.const 0)))
    (if (i32.and (i32.ne (local.get $show) (i32.const 0))
          (i32.and (i32.eq (local.get $hwnd) (global.get $main_hwnd))
                   (i32.ne (global.get $pending_wm_size) (i32.const 0))))
      (then
        (drop (call $post_queue_push (local.get $hwnd) (i32.const 0x0005)
          (i32.const 0) (global.get $pending_wm_size)))
        (global.set $pending_wm_size (i32.const 0))
        ;; Becoming the active application, which the 32-bit side delivers
        ;; synchronously from CreateWindowExA through its CACA0007 continuation
        ;; chain — a 32-bit frame a 16-bit task cannot be resumed on, so these
        ;; never reached one. An app that pauses while it is not the active
        ;; window simply stayed paused: Solitaire deals its rows on this.
        (drop (call $post_queue_push (local.get $hwnd) (i32.const 0x001C)
          (i32.const 1) (i32.const 0)))                    ;; WM_ACTIVATEAPP
        (drop (call $post_queue_push (local.get $hwnd) (i32.const 0x0006)
          (i32.const 1) (i32.const 0)))                    ;; WM_ACTIVATE, WA_ACTIVE
        (drop (call $post_queue_push (local.get $hwnd) (i32.const 0x0007)
          (i32.const 0) (i32.const 0)))))                  ;; WM_SETFOCUS
    (drop (call $host_show_window (local.get $hwnd) (local.get $show)))
    (if (local.get $show)
      (then
        ;; CreateWindow defers the initial erase for a window that is not yet
        ;; visible, so showing one has to re-arm it. A class registered with a
        ;; NULL hbrBackground means "the window paints its own background", and
        ;; the only place it gets to is WM_ERASEBKGND — FreeCell's green baize
        ;; is a PATCOPY over GetClientRect there, and without the message the
        ;; client stays whatever the surface was cleared to.
        ;; Queued here rather than left to the non-client flag, because *when*
        ;; it arrives decides whether it helps or hurts. The flag is drained
        ;; after the post queue, so the erase landed behind whatever the app
        ;; had posted for itself — and Solitaire posts its deal, deals from the
        ;; command, and draws each card as it deals rather than from WM_PAINT.
        ;; The erase then painted the table green over a hand already laid out,
        ;; and nothing asked for it back: the cards only appeared once
        ;; something else invalidated the window, which is why opening a menu
        ;; brought them out. Posted from here it arrives with ShowWindow's own
        ;; messages, ahead of the app's, which is the order Windows gives it —
        ;; there the erase happens inside ShowWindow before the task's message
        ;; loop runs at all.
        (if (i32.eqz (i32.and (call $wnd_get_style (local.get $hwnd))
                              (i32.const 0x10000000)))
          (then (drop (call $post_queue_push (local.get $hwnd) (i32.const 0x0014)
                  (i32.add (local.get $hwnd) (i32.const 0x40000)) (i32.const 0)))))
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
    (local $dst i32) (local $tmp i32) (local $waited i32) (local $ask i32)
    (local.set $dst (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 4)) (call $win16_arg16 (i32.const 3))))
    ;; A DDEML server owes its application an XTYP_CONNECT before it agrees to
    ;; a conversation, and the message pump is where that can be asked: the
    ;; task is between things here and the stack is its own, which is not true
    ;; inside the wire drain. The callback is entered with a far return onto
    ;; $WIN16_DDE_CB, which acts on the answer and then finishes this very call
    ;; with an idle message so the task's loop never notices the detour.
    (local.set $ask (call $win16_dde_ask_next))
    (if (i32.ge_s (local.get $ask) (i32.const 0))
      (then
        (global.set $win16_dde_cb_msg (local.get $dst))
        (global.set $win16_dde_cb_ret
          (i32.or (i32.shl (call $gl16 (i32.add (global.get $esp) (i32.const 2)))
                           (i32.const 16))
                  (call $gl16 (global.get $esp))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 14)))
        (call $win16_dde_ask_enter (local.get $ask))
        (return)))
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
    ;; Same shape as the modal pump's line below, with a zero dialog to mean
    ;; "the task's own loop". Seeing both is what tells one delivery of a
    ;; message from two.
    (if (global.get $win16_trace)
      (then
        (call $host_log_i32 (i32.const 0xCA16A9EB))
        (call $host_log_i32 (call $gl32 (local.get $tmp)))
        (call $host_log_i32 (call $gl32 (i32.add (local.get $tmp) (i32.const 4))))
        (call $host_log_i32 (call $gl32 (i32.add (local.get $tmp) (i32.const 8))))
        (call $host_log_i32 (call $gl32 (i32.add (local.get $tmp) (i32.const 12))))
        (call $host_log_i32 (i32.const 0))
        (call $host_log_i32 (global.get $post_queue_count))))
    (call $gs16 (local.get $dst)
      (call $win16_h16 (call $gl32 (local.get $tmp))))
    (call $gs16 (i32.add (local.get $dst) (i32.const 2))
      (call $gl32 (i32.add (local.get $tmp) (i32.const 4))))
    (call $gs16 (i32.add (local.get $dst) (i32.const 4))
      (call $win16_msg_wparam16
        (call $gl32 (i32.add (local.get $tmp) (i32.const 4)))
        (call $gl32 (i32.add (local.get $tmp) (i32.const 8)))))
    (call $gs32 (i32.add (local.get $dst) (i32.const 6))
      (call $win16_msg_lparam16_cmd
        (call $gl32 (i32.add (local.get $tmp) (i32.const 4)))
        (call $gl32 (i32.add (local.get $tmp) (i32.const 8)))
        (call $gl32 (i32.add (local.get $tmp) (i32.const 12)))))
    (call $gs32 (i32.add (local.get $dst) (i32.const 10))
      (call $gl32 (i32.add (local.get $tmp) (i32.const 16))))
    (call $win16_msg_pt_narrow (local.get $dst) (local.get $tmp))
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 10)))

  ;; MSG.pt, which is not decoration. It is the cursor in *screen* space at the
  ;; moment the message was posted, and a tracking loop is what reads it:
  ;; Minesweeper's smiley captures the mouse, peeks for the button-up itself,
  ;; and asks PtInRect whether msg.pt is still inside the face — a rectangle it
  ;; put into screen space with ClientToScreen for exactly this comparison.
  ;; Written as a zero, that point is the top-left corner of the screen, which
  ;; is inside nothing: the button-up was read, the capture released, and the
  ;; game never reset. The 32-bit side already works the position out from the
  ;; message's own lParam and the window's origin, so this only has to stop
  ;; discarding it. Two words, x then y, where the 32-bit MSG has two longs.
  (func $win16_msg_pt_narrow (param $dst i32) (param $src i32)
    (call $gs16 (i32.add (local.get $dst) (i32.const 14))
      (call $gl32 (i32.add (local.get $src) (i32.const 20))))
    (call $gs16 (i32.add (local.get $dst) (i32.const 16))
      (call $gl32 (i32.add (local.get $src) (i32.const 24)))))

  ;; Narrowing a MSG is not always a truncation: when wParam carries a handle it
  ;; has to go through the handle map, because a 32-bit handle's low word means
  ;; nothing on its own. WM_ERASEBKGND is the one that matters here — its wParam
  ;; is the HDC to paint into, and truncating our window DC (hwnd | 0x40000) to
  ;; 0x0001 hands the app a DC that is not one. WM_ICONERASEBKGND is the same
  ;; message for the iconic case. (Win16's WM_CTLCOLOR also passes an HDC in
  ;; wParam, but it is sent rather than posted, so it never comes through here.)
  ;; The inverse: a 16-bit task handing a message back to this side — through
  ;; PostMessage, SendMessage, or a window procedure of ours — must hand back a
  ;; 32-bit DC, or the queue ends up holding a 16-bit handle that the next
  ;; GetMessage narrows a second time and allocates a fresh map entry for.
  (func $win16_msg_wparam32 (param $message i32) (param $wparam i32) (result i32)
    (if (i32.or (i32.eq (local.get $message) (i32.const 0x0014))
                (i32.eq (local.get $message) (i32.const 0x0027)))
      (then (return (call $win16_h32 (local.get $wparam)))))
    (local.get $wparam))

  (func $win16_msg_wparam16 (param $message i32) (param $wparam i32) (result i32)
    (if (i32.or (i32.eq (local.get $message) (i32.const 0x0014))
                (i32.eq (local.get $message) (i32.const 0x0027)))
      (then
        ;; The DC in one of these can have started life on this side of the
        ;; fence: a 16-bit task that erases its own background hands its DC to
        ;; a window procedure of ours, and the message comes back carrying it.
        ;; Narrowing an already-narrow handle would allocate a second map entry
        ;; for the same DC on every trip, which is a handle table that fills up
        ;; while an app sits in its message loop doing nothing — Pipe Dream did
        ;; it in seven batches.
        (if (i32.and (i32.ge_u (local.get $wparam) (global.get $WIN16_HANDLE_BASE))
                     (i32.lt_u (local.get $wparam)
                       (i32.add (global.get $WIN16_HANDLE_BASE)
                                (global.get $WIN16_HANDLE_MAX))))
          (then (return (local.get $wparam))))
        (return (call $win16_h16 (local.get $wparam)))))
    (local.get $wparam))

  ;; Control messages are numbered differently in the two worlds, and unlike
  ;; every other difference here it cannot be worked out from the message alone.
  ;;
  ;; Win16 gave each control class its own block starting at WM_USER, so BM_,
  ;; EM_, LB_, CB_, SBM_ and STM_ all begin at 0x400 and mean different things.
  ;; Win32 moved them into distinct ranges precisely so they could be told
  ;; apart. Translating therefore needs the class of the window being addressed,
  ;; which is why this takes an hwnd; each block is contiguous in both worlds,
  ;; so one offset per class covers it.
  ;;
  ;;   BUTTON     0x400 -> 0x00F0   EDIT     0x400 -> 0x00B0
  ;;   LISTBOX    0x401 -> 0x0180   COMBOBOX 0x400 -> 0x0140
  ;;   SCROLLBAR  0x400 -> 0x00E0   STATIC   0x400 -> 0x0170
  ;;
  ;; Hearts asks its radio buttons which one is set with BM_GETCHECK, and a
  ;; 0x400 that nothing understood answered zero for all of them — so choosing
  ;; "I want to be dealer" changed nothing and the game went looking for a
  ;; dealer on the network instead.
  (func $win16_ctrl_msg32 (param $hwnd i32) (param $msg i32) (result i32)
    (local $class i32)
    (if (i32.or (i32.lt_u (local.get $msg) (i32.const 0x0400))
                (i32.ge_u (local.get $msg) (i32.const 0x0500)))
      (then (return (local.get $msg))))
    (local.set $class (call $ctrl_table_get_class (local.get $hwnd)))
    ;; 1 BUTTON
    (if (i32.eq (local.get $class) (i32.const 1))
      (then (return (i32.sub (local.get $msg) (i32.const 0x0310)))))
    ;; 2 EDIT, and the two RichEdit classes answer the same numbers
    (if (i32.or (i32.eq (local.get $class) (i32.const 2))
          (i32.or (i32.eq (local.get $class) (i32.const 24))
                  (i32.eq (local.get $class) (i32.const 25))))
      (then (return (i32.sub (local.get $msg) (i32.const 0x0350)))))
    ;; 3 STATIC
    (if (i32.eq (local.get $class) (i32.const 3))
      (then (return (i32.sub (local.get $msg) (i32.const 0x0290)))))
    ;; 4 LISTBOX
    (if (i32.eq (local.get $class) (i32.const 4))
      (then (return (i32.sub (local.get $msg) (i32.const 0x0281)))))
    ;; 5 COMBOBOX
    (if (i32.eq (local.get $class) (i32.const 5))
      (then (return (i32.sub (local.get $msg) (i32.const 0x02C0)))))
    ;; 7 SCROLLBAR
    (if (i32.eq (local.get $class) (i32.const 7))
      (then (return (i32.sub (local.get $msg) (i32.const 0x0320)))))
    ;; Not one of ours, or a class with no WM_USER block of its own: the app is
    ;; talking to its own window and the number is its own business.
    (local.get $msg))

  ;; WM_COMMAND is packed differently in the two worlds, and this is the only
  ;; message where narrowing lParam needs to see wParam as well:
  ;;
  ;;   Win32   wParam = MAKEWPARAM(id, notifyCode)   lParam = hwndCtl
  ;;   Win16   wParam = id                           lParam = MAKELPARAM(hwndCtl, notifyCode)
  ;;
  ;; Passed straight through, the task gets the top half of a 32-bit HWND where
  ;; the notification code belongs — 0x0001000b reads as control 0x000b sending
  ;; notification 1. Hearts' OK button arrived that way: BN_CLICKED is 0, so
  ;; MFC found no ON_BN_CLICKED entry for it, handled nothing, and passed the
  ;; command down the subclass chain without ever running CDialog::OnOK. Its
  ;; radio buttons were read by that OnOK, so the game never learned which way
  ;; you had chosen to play.
  ;;
  ;; A command from a menu or an accelerator has no control and no notification
  ;; code, and lParam is zero in both worlds.
  (func $win16_msg_lparam16_cmd (param $message i32) (param $wparam i32)
        (param $lparam i32) (result i32)
    (if (i32.ne (local.get $message) (i32.const 0x0111))
      (then (return (local.get $lparam))))
    (if (i32.eqz (local.get $lparam)) (then (return (i32.const 0))))
    (i32.or (call $win16_h16 (local.get $lparam))
            (i32.shl (i32.shr_u (local.get $wparam) (i32.const 16)) (i32.const 16))))

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
    ;; A WM_TIMER whose timer was created with a TIMERPROC carries that
    ;; procedure in lParam, and dispatching it means calling that instead of
    ;; the window procedure — the window never sees the message. A TIMERPROC
    ;; takes the same four arguments in the same order as a window procedure
    ;; and RETFs the same 10 bytes, with the tick count where lParam would be,
    ;; so entering it needs nothing of its own.
    (if (i32.and (i32.eq (local.get $message) (i32.const 0x0113))
          (i32.ne (i32.shr_u (local.get $lparam) (i32.const 16)) (i32.const 0)))
      (then
        (local.set $proc (local.get $lparam))
        (local.set $lparam (call $host_get_ticks))))
    ;; WM_NULL is the idle message and has no window procedure to reach.
    (if (i32.or (i32.eqz (local.get $message)) (i32.eqz (local.get $proc)))
      (then
        (global.set $eax (i32.const 0))
        (global.set $edx (i32.const 0))
        (call $win16_api_return (i32.const 4))
        (return)))
    ;; The message need not be for a window of the task's own. A 16-bit app
    ;; whose About box this emulator put up (SHELL.ShellAbout) pumps that
    ;; dialog's messages through its own loop, and its procedure is one of
    ;; ours, not a far pointer — entering it as one loads 0xFFFF into CS.
    ;; SendMessage has always made this distinction; DispatchMessage did not,
    ;; because until ShellAbout no window of ours was ever posted to.
    (if (i32.eqz (call $win16_is_far_proc (local.get $proc)))
      (then
        (call $win16_call32_begin (i32.const 4))
        (global.set $eax (call $wnd_send_message
          (local.get $hwnd) (local.get $message) (local.get $wparam) (local.get $lparam)))
        (call $win16_call32_end)
        (global.set $edx (i32.shr_u (global.get $eax) (i32.const 16)))
        (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (call $win16_api_return (i32.const 4))
        (return)))
    (local.set $ret (call $win16_take_return (i32.const 4)))
    (call $win16_enter_wndproc (local.get $proc) (local.get $hwnd16)
      (local.get $message) (local.get $wparam) (local.get $lparam)
      (i32.shr_u (local.get $ret) (i32.const 16))
      (i32.and (local.get $ret) (i32.const 0xFFFF))))

  ;; USER.111 SendMessage(hWnd, wMsg, wParam, lParam) -> LONG.
  ;;
  ;; Synchronous, and it can be: a 16-bit window procedure returns exactly
  ;; where a Win16 API returns, so handing it the caller's own far return
  ;; address makes its RETF 10 land there with the result already in DX:AX.
  ;; That is the same trick DispatchMessage uses and it needs no continuation.
  ;;
  ;; A window whose procedure is not a far pointer belongs to the WAT side —
  ;; a control, or a window with none at all — and goes through
  ;; $wnd_send_message, which knows how to run those.
  (func $win16_SendMessage
    (local $hwnd16 i32) (local $hwnd i32) (local $msg i32)
    (local $wp i32) (local $lp i32) (local $proc i32) (local $ret i32)
    (local.set $hwnd16 (call $win16_arg16 (i32.const 4)))
    (local.set $msg (call $win16_arg16 (i32.const 3)))
    (local.set $wp (call $win16_arg16 (i32.const 2)))
    (local.set $lp (call $win16_arg32 (i32.const 0)))
    (local.set $hwnd (call $win16_h32 (local.get $hwnd16)))
    (local.set $proc (call $wnd_table_get (local.get $hwnd)))
    (if (i32.eqz (call $win16_is_far_proc (local.get $proc)))
      (then
        ;; One of ours, so the control-message numbering has to be translated —
        ;; but only here. A message going to the task's own window procedure
        ;; below keeps the number the task chose.
        (call $win16_call32_begin (i32.const 4))
        (global.set $eax (call $wnd_send_message
          (local.get $hwnd)
          (call $win16_ctrl_msg32 (local.get $hwnd) (local.get $msg))
          (call $win16_msg_wparam32 (local.get $msg) (local.get $wp))
          (local.get $lp)))
        (call $win16_call32_end)
        (global.set $edx (i32.shr_u (global.get $eax) (i32.const 16)))
        (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (call $win16_api_return (i32.const 10))
        (return)))
    (local.set $ret (call $win16_take_return (i32.const 10)))
    (call $win16_enter_wndproc (local.get $proc) (local.get $hwnd16)
      (local.get $msg) (local.get $wp) (local.get $lp)
      (i32.shr_u (local.get $ret) (i32.const 16))
      (i32.and (local.get $ret) (i32.const 0xFFFF))))

  ;; USER.107 DefWindowProc(hWnd, message, wParam, lParam) -> LONG.
  ;;
  ;; This is also the procedure a task gets back when it subclasses one of our
  ;; windows, so for a dialog it stands where DefDlgProc stands on Windows —
  ;; and DefDlgProc is what ends a dialog on IDOK or IDCANCEL when the dialog
  ;; procedure declines the command. MFC relies on exactly that: it subclasses
  ;; the dialog, finds no handler for IDOK in its message map, and passes the
  ;; command down the chain expecting the dialog to close. Hearts' OK button
  ;; did nothing at all until this was here.
  (func $win16_DefWindowProc
    (local $hwnd i32) (local $message i32) (local $wparam i32) (local $lparam i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 4))))
    (local.set $message (call $win16_arg16 (i32.const 3)))
    (local.set $wparam (call $win16_arg16 (i32.const 2)))
    (local.set $lparam (call $win16_arg32 (i32.const 0)))
    (if (call $win16_defdlg_command (local.get $hwnd)
              (local.get $message) (local.get $wparam))
      (then
        (global.set $eax (i32.const 0))
        (global.set $edx (i32.const 0))
        (call $win16_api_return (i32.const 10))
        (return)))
    ;; Widen what was narrowed on the way out: WM_ERASEBKGND carries a DC, and
    ;; the default procedure is on the 32-bit side, where a 16-bit handle names
    ;; nothing. The invariant is that the 16-bit side holds narrow handles and
    ;; this side holds wide ones, and every crossing converts.
    (call $win16_call32_begin (i32.const 4))
    (call $handle_DefWindowProcA (local.get $hwnd) (local.get $message)
      (call $win16_msg_wparam32 (local.get $message) (local.get $wparam))
      (local.get $lparam) (i32.const 0) (i32.const 0))
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

  ;; USER.30 WindowFromPoint(POINT pt) and USER.191 ChildWindowFromPoint(hWnd,
  ;; POINT pt).
  ;;
  ;; Both take their POINT BY VALUE, which is the trap: one doubleword is
  ;; pushed, so x sits at the LOWER address and comes back as word 0 — the
  ;; opposite order from every API in this file that takes a separate x and y.
  ;; Reading them the other way round asks "is (y, x) in this window", which is
  ;; false almost everywhere and shows up as a mouse that never finds anything.
  ;; PtInRect had exactly this bug and it cost 16-bit Solitaire its card drag.
  ;;
  ;; The screen-wide part of WindowFromPoint is as good as the 32-bit handler's
  ;; answer and no better: z-order over top-level windows is the renderer's,
  ;; not ours, so that handler names the main window. What WAT does own is the
  ;; HWND tree below it, so the answer is refined by descending — which is the
  ;; part a 16-bit app actually asks about, since it is looking for its own
  ;; child under the cursor.
  (func $win16_window_from_point (param $is_child i32)
    (local $parent i32) (local $x i32) (local $y i32) (local $hit i32)
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (if (local.get $is_child)
      (then
        ;; ChildWindowFromPoint's point is in the parent's CLIENT space.
        (local.set $parent (call $win16_h32 (call $win16_arg16 (i32.const 2))))
        (local.set $x (i32.add (local.get $x)
          (call $wnd_client_screen_x (local.get $parent))))
        (local.set $y (i32.add (local.get $y)
          (call $wnd_client_screen_y (local.get $parent)))))
      (else
        (call $win16_call32_begin (i32.const 2))
        (call $handle_WindowFromPoint (local.get $x) (local.get $y)
          (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (local.set $parent (global.get $eax))))
    (local.set $hit (call $wnd_child_from_point_deep
      (local.get $parent) (local.get $x) (local.get $y)))
    ;; Neither call reports "nothing here" by way of the parent: Win16
    ;; ChildWindowFromPoint answers with the parent when no child owns the
    ;; point, and WindowFromPoint with the window it was already given.
    (global.set $eax (call $win16_h16
      (select (local.get $hit) (local.get $parent) (local.get $hit))))
    (call $win16_api_return (select (i32.const 6) (i32.const 4)
                                    (local.get $is_child))))

  ;; USER.28 ClientToScreen / USER.29 ScreenToClient(hWnd, lpPoint).
  ;;
  ;; The POINT here is behind a far pointer, not passed by value the way
  ;; PtInRect and WindowFromPoint take theirs — so the arguments read in the
  ;; ordinary order and only the struct needs widening. Two ints in, two LONGs
  ;; through the 32-bit handler, two ints back; the coordinates are signed and
  ;; a client point above or left of its window is legitimately negative, so
  ;; the way in goes through $win16_coord to sign-extend.
  ;;
  ;; MFC centres every dialog with GetParent/GetClientRect/ClientToScreen, so
  ;; this is on the path of any 16-bit MFC dialog, not just Hearts' scoreboard.
  (func $win16_map_point (param $to_screen i32)
    (local $hwnd i32) (local $dst i32) (local $tmp i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (local.set $dst (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $tmp (global.get $GUEST_STACK))
    (call $gs32 (local.get $tmp)
      (call $win16_coord (call $gl16 (local.get $dst))))
    (call $gs32 (i32.add (local.get $tmp) (i32.const 4))
      (call $win16_coord (call $gl16 (i32.add (local.get $dst) (i32.const 2)))))
    (call $win16_call32_begin (i32.const 2))
    (if (local.get $to_screen)
      (then (call $handle_ClientToScreen (local.get $hwnd) (local.get $tmp)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle_ScreenToClient (local.get $hwnd) (local.get $tmp)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (call $win16_call32_end)
    (call $gs16 (local.get $dst) (call $gl32 (local.get $tmp)))
    (call $gs16 (i32.add (local.get $dst) (i32.const 2))
      (call $gl32 (i32.add (local.get $tmp) (i32.const 4))))
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

  ;; USER.83 FrameRect(hDC, lpRect, hBrush) — FillRect's outline. Solitaire's
  ;; Deck dialog draws the selection box around the chosen card back with it.
  (func $win16_FrameRect
    (local $hdc i32) (local $src i32) (local $brush i32) (local $tmp i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 3))))
    (local.set $src (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $brush (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (local.set $tmp (global.get $GUEST_STACK))
    (call $win16_rect_widen (local.get $tmp) (local.get $src))
    (call $win16_call32_begin (i32.const 3))
    (call $handle_FrameRect (local.get $hdc) (local.get $tmp) (local.get $brush)
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

  ;; USER.76 PtInRect(lprc, pt) — and the POINT is one argument passed *by
  ;; value*, not two. That makes its two words the other way round from
  ;; InflateRect's separate x and y below: a doubleword push puts the low half
  ;; (x) nearest the top of the stack. Read as InflateRect's are, the test asks
  ;; whether (y, x) is in the rectangle, which is false for every card on the
  ;; table — 16-bit Solitaire hit-tests the click that starts a drag with this,
  ;; found nothing under the cursor, and never picked a card up.
  (func $win16_PtInRect
    (local $r i32) (local $x i32) (local $y i32)
    (local.set $r (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 3)) (call $win16_arg16 (i32.const 2))))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (global.set $eax (i32.and
      (i32.and (i32.ge_s (local.get $x) (call $win16_rect_get (local.get $r) (i32.const 0)))
               (i32.lt_s (local.get $x) (call $win16_rect_get (local.get $r) (i32.const 2))))
      (i32.and (i32.ge_s (local.get $y) (call $win16_rect_get (local.get $r) (i32.const 1)))
               (i32.lt_s (local.get $y) (call $win16_rect_get (local.get $r) (i32.const 3))))))
    (call $win16_api_return (i32.const 8)))

  ;; GDI.103 PtVisible(hDC, X, Y) — is the point inside the DC's clip. Here the
  ;; coordinates are two separate arguments, so they read the ordinary way
  ;; round, unlike PtInRect's packed POINT above. Solitaire asks before drawing
  ;; each card of the stack it has picked up.
  (func $win16_PtVisible
    (local $hdc i32) (local $x i32) (local $y i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 3))
    (call $handle_PtVisible (local.get $hdc) (local.get $x) (local.get $y)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 6)))

  ;; GDI.104 RectVisible(hDC, lpRect) -> is any part of it inside the clip? The
  ;; rectangle is four words here and four longs there, so it is widened into
  ;; scratch on the way through.
  (func $win16_RectVisible
    (local $hdc i32) (local $r i32) (local $w i32) (local $i i32)
    (local.set $r (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (local.set $w (global.get $GUEST_STACK))
    (block $done (loop $edges
      (br_if $done (i32.ge_u (local.get $i) (i32.const 4)))
      (call $gs32 (i32.add (local.get $w) (i32.shl (local.get $i) (i32.const 2)))
        (call $win16_coord
          (call $gl16 (i32.add (local.get $r) (i32.shl (local.get $i) (i32.const 1))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $edges)))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_RectVisible (local.get $hdc) (local.get $w)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.ne (global.get $eax) (i32.const 0)))
    (call $win16_api_return (i32.const 6)))

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

  ;; USER.77 OffsetRect(lpRect, X, Y) — slides the rectangle, same shape as
  ;; InflateRect above but adding to both edges of each axis.
  (func $win16_OffsetRect
    (local $r i32) (local $x i32) (local $y i32)
    (local.set $r (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 3)) (call $win16_arg16 (i32.const 2))))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (call $win16_rect_set (local.get $r) (i32.const 0)
      (i32.add (call $win16_rect_get (local.get $r) (i32.const 0)) (local.get $x)))
    (call $win16_rect_set (local.get $r) (i32.const 1)
      (i32.add (call $win16_rect_get (local.get $r) (i32.const 1)) (local.get $y)))
    (call $win16_rect_set (local.get $r) (i32.const 2)
      (i32.add (call $win16_rect_get (local.get $r) (i32.const 2)) (local.get $x)))
    (call $win16_rect_set (local.get $r) (i32.const 3)
      (i32.add (call $win16_rect_get (local.get $r) (i32.const 3)) (local.get $y)))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 8)))

  ;; USER.73 SetRectEmpty(lpRect) and USER.75 IsRectEmpty(lpRect).
  (func $win16_SetRectEmpty
    (local $r i32) (local $i i32)
    (local.set $r (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (block $done (loop $edges
      (br_if $done (i32.ge_u (local.get $i) (i32.const 4)))
      (call $win16_rect_set (local.get $r) (local.get $i) (i32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $edges)))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 4)))

  (func $win16_IsRectEmpty
    (local $r i32)
    (local.set $r (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (global.set $eax (i32.or
      (i32.le_s (call $win16_rect_get (local.get $r) (i32.const 2))
                (call $win16_rect_get (local.get $r) (i32.const 0)))
      (i32.le_s (call $win16_rect_get (local.get $r) (i32.const 3))
                (call $win16_rect_get (local.get $r) (i32.const 1)))))
    (call $win16_api_return (i32.const 4)))

  ;; USER.80 UnionRect(lpDestRect, lpSrc1Rect, lpSrc2Rect) -> non-empty? An
  ;; empty source contributes nothing, which is what keeps the union of an
  ;; empty rectangle and a real one equal to the real one.
  (func $win16_UnionRect
    (local $dst i32) (local $a i32) (local $b i32) (local $ae i32) (local $be i32)
    (local $i i32)
    (local.set $dst (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 5)) (call $win16_arg16 (i32.const 4))))
    (local.set $a (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 3)) (call $win16_arg16 (i32.const 2))))
    (local.set $b (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $ae (i32.or
      (i32.le_s (call $win16_rect_get (local.get $a) (i32.const 2))
                (call $win16_rect_get (local.get $a) (i32.const 0)))
      (i32.le_s (call $win16_rect_get (local.get $a) (i32.const 3))
                (call $win16_rect_get (local.get $a) (i32.const 1)))))
    (local.set $be (i32.or
      (i32.le_s (call $win16_rect_get (local.get $b) (i32.const 2))
                (call $win16_rect_get (local.get $b) (i32.const 0)))
      (i32.le_s (call $win16_rect_get (local.get $b) (i32.const 3))
                (call $win16_rect_get (local.get $b) (i32.const 1)))))
    (if (i32.and (local.get $ae) (local.get $be))
      (then
        (block $done (loop $edges
          (br_if $done (i32.ge_u (local.get $i) (i32.const 4)))
          (call $win16_rect_set (local.get $dst) (local.get $i) (i32.const 0))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $edges)))
        (global.set $eax (i32.const 0))
        (call $win16_api_return (i32.const 12))
        (return)))
    (if (local.get $ae) (then (local.set $a (local.get $b))))
    (if (local.get $be) (then (local.set $b (local.get $a))))
    (local.set $i (i32.const 0))
    (block $done (loop $edges
      (br_if $done (i32.ge_u (local.get $i) (i32.const 4)))
      (local.set $ae (call $win16_rect_get (local.get $a) (local.get $i)))
      (local.set $be (call $win16_rect_get (local.get $b) (local.get $i)))
      ;; Left and top take the smaller edge, right and bottom the larger.
      (call $win16_rect_set (local.get $dst) (local.get $i)
        (select (local.get $ae) (local.get $be)
          (select (i32.lt_s (local.get $ae) (local.get $be))
                  (i32.gt_s (local.get $ae) (local.get $be))
                  (i32.lt_u (local.get $i) (i32.const 2)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $edges)))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 12)))

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
  ;;
  ;; lpTimerFunc is kept as the far pointer it is. A timer created with one
  ;; delivers WM_TIMER to that procedure and NOT to the window procedure, which
  ;; is why dropping it is not a harmless simplification: Solitaire drives its
  ;; whole deal off a TIMERPROC, and with the callback discarded its window
  ;; procedure passed every WM_TIMER to DefWindowProc and the table stayed
  ;; empty. The timer table already carries a callback field for the 32-bit
  ;; side; $win16_DispatchMessage is what calls it.
  (func $win16_SetTimer
    (local $hwnd i32) (local $id i32) (local $elapse i32) (local $proc i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 4))))
    (local.set $id (call $win16_arg16 (i32.const 3)))
    (local.set $elapse (call $win16_arg16 (i32.const 2)))
    (local.set $proc (call $win16_arg32 (i32.const 0)))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_SetTimer (local.get $hwnd) (local.get $id) (local.get $elapse)
      (local.get $proc) (i32.const 0) (i32.const 0))
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
    (local.set $wp (call $win16_msg_wparam32 (local.get $msg)
      (call $win16_arg16 (i32.const 2))))
    (local.set $lp (call $win16_arg32 (i32.const 0)))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_PostMessageA (local.get $hwnd) (local.get $msg)
      (local.get $wp) (local.get $lp) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 10)))

  ;; USER.259 BeginDeferWindowPos(nNumWindows) -> HDWP,
  ;; USER.260 DeferWindowPos(hdwp, hWnd, hWndInsertAfter, x, y, cx, cy, flags),
  ;; USER.261 EndDeferWindowPos(hdwp).
  ;;
  ;; Windows batches the moves so a multi-window relayout lands in one paint;
  ;; each one is applied as it arrives here instead, which every caller sees as
  ;; the same final geometry. MFC's CFrameWnd::RecalcLayout arranges a frame's
  ;; control bars this way, so a 16-bit MFC app reaches this on its first
  ;; WM_SIZE — Hearts does, positioning its status bar.
  (func $win16_BeginDeferWindowPos
    ;; The handle only has to be non-zero and survive to EndDeferWindowPos.
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 2)))

  (func $win16_DeferWindowPos
    (local $hwnd i32) (local $after i32) (local $x i32) (local $y i32)
    (local $cx i32) (local $cy i32) (local $flags i32) (local $hdwp i32)
    (local.set $hdwp (call $win16_arg16 (i32.const 7)))
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 6))))
    (local.set $after (call $win16_arg16 (i32.const 5)))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 4))))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 3))))
    (local.set $cx (call $win16_coord (call $win16_arg16 (i32.const 2))))
    (local.set $cy (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (local.set $flags (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 7))
    (call $win16_call32_arg (i32.const 5) (local.get $cy))
    (call $win16_call32_arg (i32.const 6) (local.get $flags))
    (call $handle_SetWindowPos (local.get $hwnd) (local.get $after)
      (local.get $x) (local.get $y) (local.get $cx) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (local.get $hdwp))
    (call $win16_api_return (i32.const 16)))

  (func $win16_EndDeferWindowPos
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 2)))

  ;; USER.232 SetWindowPos(hWnd, hWndInsertAfter, x, y, cx, cy, wFlags) — the
  ;; ungathered form of DeferWindowPos above, and the same call underneath.
  ;;
  ;; This is how a 16-bit app centres a dialog: GetWindowRect the dialog and its
  ;; owner, work out the offset, and SetWindowPos with SWP_NOSIZE|SWP_NOZORDER.
  ;; FreeCell has one such routine and every dialog it owns goes through it, so
  ;; four of its five menu commands stopped here.
  ;;
  ;; hWndInsertAfter stays raw: HWND_TOP and friends are small constants, not
  ;; handles, and mapping them would turn them into windows.
  (func $win16_SetWindowPos
    (local $hwnd i32) (local $after i32) (local $x i32) (local $y i32)
    (local $cx i32) (local $cy i32) (local $flags i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 6))))
    (local.set $after (call $win16_arg16 (i32.const 5)))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 4))))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 3))))
    (local.set $cx (call $win16_coord (call $win16_arg16 (i32.const 2))))
    (local.set $cy (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (local.set $flags (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 7))
    (call $win16_call32_arg (i32.const 5) (local.get $cy))
    (call $win16_call32_arg (i32.const 6) (local.get $flags))
    (call $handle_SetWindowPos (local.get $hwnd) (local.get $after)
      (local.get $x) (local.get $y) (local.get $cx) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 14)))

  ;; SHELL.ShellAbout(hWnd, lpszApp, lpszOtherStuff, hIcon) — the About box the
  ;; shell puts up on an app's behalf, which is what the entertainment-pack
  ;; games use instead of a dialog resource of their own.
  ;;
  ;; The 32-bit handler builds the dialog in WAT and returns without moving EIP,
  ;; so it bridges directly. It is not modal there and is not modal here: the
  ;; dialog is a window of ours and the task's own message loop keeps running,
  ;; which is what a 16-bit task needs anyway, having no other loop to run.
  (func $win16_ShellAbout
    (local $hwnd i32) (local $app i32) (local $other i32) (local $icon i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 5))))
    (local.set $app (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 4)) (call $win16_arg16 (i32.const 3))))
    (local.set $other (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $icon (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_ShellAboutA (local.get $hwnd) (local.get $app)
      (local.get $other) (local.get $icon) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 12)))

  ;; USER.229 GetTopWindow(hWnd) and USER.262 GetWindow(hWnd, wCmd) — the pair
  ;; a frame walks its children with, one after the other.
  (func $win16_GetTopWindow
    (local $hwnd i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_GetTopWindow (local.get $hwnd)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 2)))

  ;; USER.277 GetDlgCtrlID(hWnd) — the id a child was created with. A frame
  ;; walking its children reads it to tell one control bar from another.
  (func $win16_GetDlgCtrlID
    (local $hwnd i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_GetDlgCtrlID (local.get $hwnd)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 2)))

  (func $win16_GetWindow
    (local $hwnd i32) (local $cmd i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 1))))
    (local.set $cmd (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_GetWindow (local.get $hwnd) (local.get $cmd)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 4)))

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

  ;; A 16-bit accelerator table is not the 32-bit one with narrower fields, it
  ;; is a different record: BYTE fFlags, WORD key, WORD id -- five bytes, with
  ;; 0x80 in the flags of the last one. The 32-bit walker reads WORD fFlags,
  ;; WORD key, WORD id, WORD padding on an eight-byte stride, so handed a
  ;; 16-bit table it matches nothing at all and every accelerator in the app is
  ;; dead. Hearts is the whole game: F2 is "begin with current players", and
  ;; the dealer's only way to start a hand.
  ;;
  ;; Widening keeps the format knowledge on the 16-bit side, beside the MSG
  ;; widening TranslateAccelerator already does, rather than teaching the
  ;; 32-bit walker about a layout no PE ever has.
  (global $win16_accel_buf (mut i32) (i32.const 0))

  (func $win16_accel_widen (param $src i32) (param $size i32)
    (local $n i32) (local $off i32)
    (local $fv i32) (local $dst i32) (local $d i32) (local $i i32)
    (if (i32.or (i32.eqz (local.get $src))
                (i32.lt_u (local.get $size) (i32.const 5)))
      (then (return)))
    ;; Count by walking to the 0x80 entry rather than dividing: the resource is
    ;; padded out to its alignment, and those trailing zero bytes would read as
    ;; extra entries.
    (block $counted (loop $count
      (br_if $counted
        (i32.gt_u (i32.add (local.get $off) (i32.const 5)) (local.get $size)))
      (local.set $fv (i32.load8_u (i32.add (local.get $src) (local.get $off))))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (local.set $off (i32.add (local.get $off) (i32.const 5)))
      (br_if $counted (i32.and (local.get $fv) (i32.const 0x80)))
      (br $count)))
    (if (i32.eqz (local.get $n)) (then (return)))
    (if (global.get $win16_accel_buf)
      (then (call $heap_free (global.get $win16_accel_buf))))
    (global.set $win16_accel_buf
      (call $heap_alloc (i32.mul (local.get $n) (i32.const 8))))
    (if (i32.eqz (global.get $win16_accel_buf)) (then (return)))
    (local.set $dst (call $g2w (global.get $win16_accel_buf)))
    (block $done (loop $widen
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $off (i32.mul (local.get $i) (i32.const 5)))
      (local.set $d (i32.add (local.get $dst) (i32.mul (local.get $i) (i32.const 8))))
      (i32.store16 (local.get $d)
        (i32.load8_u (i32.add (local.get $src) (local.get $off))))
      (i32.store16 offset=2 (local.get $d)
        (i32.load16_u (i32.add (local.get $src)
          (i32.add (local.get $off) (i32.const 1)))))
      (i32.store16 offset=4 (local.get $d)
        (i32.load16_u (i32.add (local.get $src)
          (i32.add (local.get $off) (i32.const 3)))))
      (i32.store16 offset=6 (local.get $d) (i32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $widen)))
    (global.set $haccel_data (local.get $dst))
    (global.set $haccel_count (local.get $n)))

  ;; USER.177 LoadAccelerators(hInstance, lpTableName).
  ;;
  ;; Not a call into the 32-bit handler: that one walks a PE resource tree, and
  ;; there is none here. It also reports success unconditionally, so a table it
  ;; had not found was indistinguishable from one it had -- which is how this
  ;; looked like a matching bug for as long as it did.
  (func $win16_LoadAccelerators
    (local $data i32)
    (local.set $data (call $win16_res_lookup (i32.const 9) (i32.const 0)))
    (global.set $eax (i32.const 0))
    (if (local.get $data)
      (then
        (call $win16_accel_widen (local.get $data) (global.get $win16_res_len))
        (global.set $eax (call $win16_h16 (i32.const 0x60001)))))
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
    ;; An action that carries a structure this cannot narrow gets FALSE — the
    ;; documented failure, which every caller has to handle, rather than a
    ;; structure in the wrong layout. FreeCell asks for SPI_GETNONCLIENTMETRICS
    ;; to size its fonts and falls back to defaults when it is refused; filling
    ;; its 16-bit NONCLIENTMETRICS from the Win32 one means converting five
    ;; LOGFONTs, which is worth doing when something actually needs the answer.
    (if (call $win16_arg16 (i32.const 2))
      (then
        (call $host_log_i32 (i32.const 0xCA16A9F6))
        (call $host_log_i32 (local.get $action))
        (global.set $eax (i32.const 0))
        (call $win16_api_return (i32.const 10))
        (return)))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_SystemParametersInfoA (local.get $action) (local.get $param)
      (i32.const 0) (local.get $ini) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 10)))

  ;; USER.22 SetFocus(hWnd) -> the window that had it.
  ;;
  ;; Deliberately not the 32-bit handler. That one delivers WM_SETFOCUS by
  ;; redirecting EIP into the window procedure, and a handler that moves EIP
  ;; can never return across this bridge -- $win16_call32_end traps on exactly
  ;; that. Hearts renames its "Pass Left" button to "OK" and calls SetFocus on
  ;; it the instant you pass three cards, so the game died on the first move of
  ;; every hand.
  ;;
  ;; Posting both notifications is what the task's own pump does with them a
  ;; moment later anyway, and it keeps the focus bookkeeping identical.
  (func $win16_SetFocus
    (local $hwnd i32) (local $prev i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (local.set $prev (global.get $focus_hwnd))
    (if (i32.ne (local.get $prev) (local.get $hwnd))
      (then
        (if (local.get $prev)
          (then (drop (call $post_queue_push (local.get $prev)
                  (i32.const 0x0008) (local.get $hwnd) (i32.const 0)))))
        (global.set $focus_hwnd (local.get $hwnd))
        (if (local.get $hwnd)
          (then (drop (call $post_queue_push (local.get $hwnd)
                  (i32.const 0x0007) (local.get $prev) (i32.const 0)))))))
    (global.set $eax (call $win16_h16 (local.get $prev)))
    (call $win16_api_return (i32.const 2)))

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
    (if (i32.eq (local.get $which) (i32.const 7))
      (then (call $handle_IsZoomed (local.get $hwnd)
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

  ;; USER.60 GetActiveWindow() — the top-level window with the focus.
  (func $win16_GetActiveWindow
    (call $win16_call32_begin (i32.const 0))
    (call $handle_GetActiveWindow (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 0)))

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

  ;; USER.410 InsertMenu / .411 AppendMenu / .414 ModifyMenu. The last argument
  ;; is a far string only for a text item: with MF_BITMAP it is a bitmap handle
  ;; and with MF_OWNERDRAW it is the app's own data, and neither may be put
  ;; through a pointer translation. AppendMenu has one argument fewer, so its
  ;; words sit two lower and it returns the same BOOL.
  (func $win16_change_menu (param $which i32)
    (local $menu i32) (local $pos i32) (local $flags i32) (local $id i32)
    (local $item i32) (local $append i32)
    (local.set $append (i32.eq (local.get $which) (i32.const 1)))
    (local.set $item (call $win16_arg16 (i32.const 0)))
    (local.set $id (call $win16_arg16 (i32.const 2)))
    (local.set $flags (call $win16_arg16 (i32.const 3)))
    ;; AppendMenu has no position argument, so its menu handle is the word the
    ;; other two spend on one.
    (if (local.get $append)
      (then (local.set $menu (call $win16_h32 (call $win16_arg16 (i32.const 4)))))
      (else
        (local.set $pos (call $win16_arg16 (i32.const 4)))
        (local.set $menu (call $win16_h32 (call $win16_arg16 (i32.const 5))))))
    (if (i32.eqz (i32.and (local.get $flags) (i32.const 0x0104)))
      (then (local.set $item (call $win16_far_to_guest
              (call $win16_arg16 (i32.const 1)) (local.get $item))))
      (else (if (i32.and (local.get $flags) (i32.const 0x0004))
        (then (local.set $item (call $win16_h32 (local.get $item)))))))
    (call $win16_call32_begin (i32.const 5))
    (call $win16_call32_arg (i32.const 3) (local.get $id))
    (call $win16_call32_arg (i32.const 4) (local.get $item))
    (if (local.get $append)
      (then (call $handle_AppendMenuA (local.get $menu) (local.get $flags)
              (local.get $id) (local.get $item) (i32.const 0) (i32.const 0)))
      (else (if (i32.eq (local.get $which) (i32.const 0))
        (then (call $handle_InsertMenuA (local.get $menu) (local.get $pos)
                (local.get $flags) (local.get $id) (local.get $item) (i32.const 0)))
        (else (call $handle_ModifyMenuA (local.get $menu) (local.get $pos)
                (local.get $flags) (local.get $id) (local.get $item) (i32.const 0))))))
    (call $win16_call32_end)
    (global.set $eax (i32.ne (global.get $eax) (i32.const 0)))
    (call $win16_api_return (select (i32.const 10) (i32.const 12) (local.get $append))))

  ;; USER.413 DeleteMenu(hMenu, nPosition, wFlags) — and USER.412 RemoveMenu,
  ;; which differs only in that it leaves a popup submenu's own handle valid.
  ;; Nothing here owns a submenu separately from its parent, so both remove the
  ;; item and both are honest about it.
  (func $win16_DeleteMenu
    (local $menu i32) (local $pos i32) (local $flags i32)
    (local.set $flags (call $win16_arg16 (i32.const 0)))
    (local.set $pos (call $win16_arg16 (i32.const 1)))
    (local.set $menu (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (call $win16_call32_begin (i32.const 3))
    (call $handle_DeleteMenu (local.get $menu) (local.get $pos) (local.get $flags)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.ne (global.get $eax) (i32.const 0)))
    (call $win16_api_return (i32.const 6)))

  ;; USER.36 GetWindowText(hWnd, lpString, nMaxCount) -> characters copied, and
  ;; USER.38 GetWindowTextLength(hWnd).
  (func $win16_GetWindowText
    (local $hwnd i32) (local $buf i32) (local $max i32)
    (local.set $max (call $win16_arg16 (i32.const 0)))
    (local.set $buf (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 3))))
    (call $win16_call32_begin (i32.const 3))
    (call $handle_GetWindowTextA (local.get $hwnd) (local.get $buf) (local.get $max)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 8)))

  (func $win16_GetWindowTextLength
    (local $hwnd i32)
    (local.set $hwnd (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_GetWindowTextLengthA (local.get $hwnd) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 2)))

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
  ;;
  ;; The one handler that ends by *setting* EIP rather than returning: on an
  ;; empty peek it takes its own return address off the stack, moves EIP there
  ;; and raises the yield flag, so an idle loop spinning on PM_NOREMOVE gives
  ;; the host a turn instead of burning the whole slice. Across this bridge the
  ;; address it reads is the zero $win16_call32_begin wrote as the scratch
  ;; frame's return address, so it lands on EIP = 0 — which is exactly what
  ;; $win16_call32_end refuses. Ending the call the redirect-tolerant way puts
  ;; the task's own EIP back; the yield it asked for is still right here, since
  ;; MFC's Run loop peeks this way between every idle pass.
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
    (drop (call $win16_call32_end_redirected))
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
        (call $win16_msg_pt_narrow (local.get $dst) (local.get $tmp))))
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 12)))

  ;; ---- GDI ----

  ;; GDI.80 GetDeviceCaps(hDC, nIndex). Same indices as Win32.
  ;;
  ;; NUMCOLORS is the one answer that cannot come through unchanged. Win32
  ;; returns -1 on any device deeper than 8bpp, which is what this emulator
  ;; presents; a 16-bit caller gets that back in AX and compares it as a signed
  ;; 16-bit int, where it reads as fewer colours than a black-and-white screen
  ;; has. Minesweeper does exactly that -- `cmp ax,2 / jle` picks between its
  ;; colour and monochrome bitmap sets -- and drew its whole minefield in 1-bit
  ;; art. Report the largest palettized count instead, which is both what the
  ;; 256-colour displays these apps were built for reported and a truthful
  ;; "this is a colour screen".
  (func $win16_GetDeviceCaps
    (local $hdc i32) (local $index i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 1))))
    (local.set $index (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_GetDeviceCaps (local.get $hdc) (local.get $index)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (if (i32.and (i32.eq (local.get $index) (i32.const 24))
          (i32.eq (global.get $eax) (i32.const -1)))
      (then (global.set $eax (i32.const 256))))
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
    ;; A LOGFONT is the other shape asked for: 50 bytes in Win16 against 60 in
    ;; Win32, because its first five fields are shorts there and longs here.
    ;; Everything after them — the eight bytes of flags and the 32-byte face
    ;; name — is identical, so it is copied straight across.
    (if (i32.eq (local.get $count) (i32.const 50))
      (then
        (local.set $tmp (global.get $GUEST_STACK))
        (call $win16_call32_begin (i32.const 3))
        (call $handle_GetObjectA (local.get $h) (i32.const 60) (local.get $tmp)
          (i32.const 0) (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (if (global.get $eax)
          (then
            (local.set $count (i32.const 0))
            (block $narrowed (loop $five
              (br_if $narrowed (i32.ge_u (local.get $count) (i32.const 5)))
              (call $gs16 (i32.add (local.get $dst) (i32.shl (local.get $count) (i32.const 1)))
                (call $gl32 (i32.add (local.get $tmp)
                                     (i32.shl (local.get $count) (i32.const 2)))))
              (local.set $count (i32.add (local.get $count) (i32.const 1)))
              (br $five)))
            (local.set $count (i32.const 0))
            (block $copied (loop $rest
              (br_if $copied (i32.ge_u (local.get $count) (i32.const 40)))
              (call $gs8 (i32.add (i32.add (local.get $dst) (i32.const 10)) (local.get $count))
                (call $gl8 (i32.add (i32.add (local.get $tmp) (i32.const 20))
                                    (local.get $count))))
              (local.set $count (i32.add (local.get $count) (i32.const 1)))
              (br $rest)))
            (global.set $eax (i32.const 50))))
        (call $win16_api_return (i32.const 8))
        (return)))
    ;; A LOGBRUSH is eight bytes here — a word of style, a colour, and a word
    ;; of hatch — against twelve in Win32, where all three are longs. JigSawed
    ;; asks its board's brush what colour it is.
    (if (i32.eq (local.get $count) (i32.const 8))
      (then
        (local.set $tmp (global.get $GUEST_STACK))
        (call $win16_call32_begin (i32.const 3))
        (call $handle_GetObjectA (local.get $h) (i32.const 12) (local.get $tmp)
          (i32.const 0) (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (call $gs16 (local.get $dst) (call $gl32 (local.get $tmp)))
        (call $gs32 (i32.add (local.get $dst) (i32.const 2))
          (call $gl32 (i32.add (local.get $tmp) (i32.const 4))))
        (call $gs16 (i32.add (local.get $dst) (i32.const 6))
          (call $gl32 (i32.add (local.get $tmp) (i32.const 8))))
        (global.set $eax (i32.const 8))
        (call $win16_api_return (i32.const 8))
        (return)))
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

  ;; A plain signed word. Not $win16_coord: that one also translates
  ;; CW_USEDEFAULT, which is a window position sentinel and an ordinary
  ;; coordinate anywhere else.
  (func $win16_short (param $v i32) (result i32)
    (i32.shr_s (i32.shl (local.get $v) (i32.const 16)) (i32.const 16)))

  ;; GDI.64 CreateRectRgn(left, top, right, bottom) -> HRGN.
  (func $win16_CreateRectRgn
    (local $l i32) (local $t i32) (local $r i32) (local $b i32)
    (local.set $l (call $win16_short (call $win16_arg16 (i32.const 3))))
    (local.set $t (call $win16_short (call $win16_arg16 (i32.const 2))))
    (local.set $r (call $win16_short (call $win16_arg16 (i32.const 1))))
    (local.set $b (call $win16_short (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_CreateRectRgn (local.get $l) (local.get $t) (local.get $r)
      (local.get $b) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 8)))

  ;; GDI.172 SetRectRgn(hrgn, left, top, right, bottom).
  ;;
  ;; CARDS.DLL clips to the card it is about to draw, so the first card played
  ;; in a networked hand went straight through this and trapped -- both players
  ;; died on the opening lead.
  (func $win16_SetRectRgn
    (local $rgn i32) (local $l i32) (local $t i32) (local $r i32) (local $b i32)
    (local.set $rgn (call $win16_h32 (call $win16_arg16 (i32.const 4))))
    (local.set $l (call $win16_coord (call $win16_arg16 (i32.const 3))))
    (local.set $t (call $win16_coord (call $win16_arg16 (i32.const 2))))
    (local.set $r (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (local.set $b (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 5))
    (call $handle_SetRectRgn (local.get $rgn) (local.get $l) (local.get $t)
      (local.get $r) (local.get $b) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 10)))

  ;; GDI.47 CombineRgn(hrgnDest, hrgnSrc1, hrgnSrc2, fnCombineMode).
  ;; The other half of the same clip: Hearts builds the rectangle it is about to
  ;; redraw with SetRectRgn and folds it into the region it keeps.
  (func $win16_CombineRgn
    (local $dst i32) (local $a i32) (local $b i32) (local $mode i32)
    (local.set $dst  (call $win16_h32 (call $win16_arg16 (i32.const 3))))
    (local.set $a    (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (local.set $b    (call $win16_h32 (call $win16_arg16 (i32.const 1))))
    (local.set $mode (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_CombineRgn (local.get $dst) (local.get $a) (local.get $b)
      (local.get $mode) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
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
    (call $win16_h16_forget (local.get $h))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 2)))

  (func $win16_DeleteDC
    (local $h i32)
    (local.set $h (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_DeleteDC (local.get $h)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (call $win16_h16_forget (local.get $h))
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

  ;; GDI.56 CreateFont(nHeight, nWidth, nEscapement, nOrientation, nWeight,
  ;; bItalic, bUnderline, cStrikeOut, nCharSet, nOutPrecision, nClipPrecision,
  ;; nQuality, nPitchAndFamily, lpszFace) — fourteen arguments, thirteen of
  ;; them words and the last a far pointer, so thirty bytes come off the stack.
  ;;
  ;; Counting from the top: the face pointer was pushed last and occupies
  ;; words 0 and 1, then the arguments run backwards from there, which puts
  ;; nHeight at word 14. Height is signed and normally negative — it is a
  ;; character height rather than a cell height when it is — so it goes
  ;; through $win16_coord rather than being taken as a bare word.
  ;;
  ;; The 32-bit handler reads its later arguments straight off the stack at
  ;; esp+4n, so the frame is filled in the same shape rather than only through
  ;; the five declared parameters.
  ;; Every argument is hoisted into a local first. $win16_arg16 is ESP-relative
  ;; and $win16_call32_begin moves ESP onto the scratch stack, so a read after
  ;; it comes off the frame being built rather than the task's — the guard in
  ;; $win16_arg16 traps on exactly that mistake.
  ;; GDI.57 CreateFontIndirect(lpLogFont). A Win16 LOGFONT is 50 bytes where
  ;; Win32's is 60: its first five fields are shorts rather than longs, and
  ;; everything after them — eight flag bytes and a 32-byte face name — is
  ;; identical. So the structure is widened into scratch, which is the same
  ;; conversion GetObject does in the other direction. Visual Basic 1 builds
  ;; every one of its fonts this way.
  (func $win16_CreateFontIndirect
    (local $src i32) (local $dst i32) (local $i i32)
    (local.set $src (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $dst (global.get $GUEST_STACK))
    (block $wide (loop $five
      (br_if $wide (i32.ge_u (local.get $i) (i32.const 5)))
      (call $gs32 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 2)))
        (call $win16_coord
          (call $gl16 (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 1))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $five)))
    (local.set $i (i32.const 0))
    (block $rest (loop $bytes
      (br_if $rest (i32.ge_u (local.get $i) (i32.const 40)))
      (call $gs8 (i32.add (i32.add (local.get $dst) (i32.const 20)) (local.get $i))
        (call $gl8 (i32.add (i32.add (local.get $src) (i32.const 10)) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $bytes)))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_CreateFontIndirectA (local.get $dst) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 4)))

  (func $win16_CreateFont
    (local $face i32) (local $sel i32) (local $off i32) (local $h i32)
    (local $w i32) (local $esc i32) (local $ori i32) (local $weight i32)
    (local $italic i32) (local $under i32) (local $strike i32) (local $charset i32)
    (local $outp i32) (local $clip i32) (local $qual i32) (local $pitch i32)
    (local.set $off     (call $win16_arg16 (i32.const 0)))
    (local.set $sel     (call $win16_arg16 (i32.const 1)))
    (local.set $pitch   (call $win16_arg16 (i32.const 2)))
    (local.set $qual    (call $win16_arg16 (i32.const 3)))
    (local.set $clip    (call $win16_arg16 (i32.const 4)))
    (local.set $outp    (call $win16_arg16 (i32.const 5)))
    (local.set $charset (call $win16_arg16 (i32.const 6)))
    (local.set $strike  (call $win16_arg16 (i32.const 7)))
    (local.set $under   (call $win16_arg16 (i32.const 8)))
    (local.set $italic  (call $win16_arg16 (i32.const 9)))
    (local.set $weight  (call $win16_arg16 (i32.const 10)))
    (local.set $ori     (call $win16_coord (call $win16_arg16 (i32.const 11))))
    (local.set $esc     (call $win16_coord (call $win16_arg16 (i32.const 12))))
    (local.set $w       (call $win16_coord (call $win16_arg16 (i32.const 13))))
    (local.set $h       (call $win16_coord (call $win16_arg16 (i32.const 14))))
    ;; A NULL face name means "any face of this family", and it has to stay
    ;; NULL: $win16_far_to_guest would otherwise hand the handler the base of
    ;; the task's own data segment to read a name out of.
    (if (i32.or (local.get $sel) (local.get $off))
      (then (local.set $face
              (call $win16_far_to_guest (local.get $sel) (local.get $off)))))
    (call $win16_call32_begin (i32.const 14))
    (call $win16_call32_arg (i32.const 0)  (local.get $h))
    (call $win16_call32_arg (i32.const 1)  (local.get $w))
    (call $win16_call32_arg (i32.const 2)  (local.get $esc))
    (call $win16_call32_arg (i32.const 3)  (local.get $ori))
    (call $win16_call32_arg (i32.const 4)  (local.get $weight))
    (call $win16_call32_arg (i32.const 5)  (local.get $italic))
    (call $win16_call32_arg (i32.const 6)  (local.get $under))
    (call $win16_call32_arg (i32.const 7)  (local.get $strike))
    (call $win16_call32_arg (i32.const 8)  (local.get $charset))
    (call $win16_call32_arg (i32.const 9)  (local.get $outp))
    (call $win16_call32_arg (i32.const 10) (local.get $clip))
    (call $win16_call32_arg (i32.const 11) (local.get $qual))
    (call $win16_call32_arg (i32.const 12) (local.get $pitch))
    (call $win16_call32_arg (i32.const 13) (local.get $face))
    (call $handle_CreateFontA (local.get $h)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 30)))

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
    ;; ... and the nine trailing bytes carry over unchanged: tmFirstChar,
    ;; tmLastChar, tmDefaultChar, tmBreakChar, tmItalic, tmUnderlined,
    ;; tmStruckOut, tmPitchAndFamily, tmCharSet. Nine, not eleven — the
    ;; structure is 31 bytes and copying eleven wrote two past its end.
    ;; Pipe Dream asks for its metrics into a local, and those two bytes were
    ;; the DS its frame had saved: it came back holding a null data selector,
    ;; pushed that as half of the class name it handed CreateWindow, got a
    ;; window with no class and so no window procedure of its own, and never
    ;; drew a thing.
    (call $memcpy (call $g2w (i32.add (local.get $dst) (i32.const 22)))
                  (call $g2w (i32.add (local.get $tmp) (i32.const 44)))
                  (i32.const 9))
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

  ;; GDI.351 ExtTextOut(hDC, X, Y, wOptions, lpRect, lpString, nCount, lpDx).
  ;;
  ;; The RECT is four words in Win16 and four dwords in Win32, so it is widened
  ;; into scratch rather than passed through; the spacing array is words in
  ;; both, and $host_gdi_ext_text_out reads it as words, so that one goes
  ;; straight across.
  (func $win16_ExtTextOut
    (local $hdc i32) (local $x i32) (local $y i32) (local $opts i32)
    (local $rect i32) (local $str i32) (local $n i32) (local $dx i32) (local $r32 i32)
    (local.set $dx (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (if (i32.eqz (call $win16_arg16 (i32.const 1))) (then (local.set $dx (i32.const 0))))
    (local.set $n (call $win16_arg16 (i32.const 2)))
    (local.set $str (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 4)) (call $win16_arg16 (i32.const 3))))
    (if (i32.eqz (call $win16_arg16 (i32.const 4))) (then (local.set $str (i32.const 0))))
    (local.set $rect (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 6)) (call $win16_arg16 (i32.const 5))))
    (if (i32.eqz (call $win16_arg16 (i32.const 6))) (then (local.set $rect (i32.const 0))))
    (local.set $opts (call $win16_arg16 (i32.const 7)))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 8))))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 9))))
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 10))))
    (if (local.get $rect)
      (then
        (local.set $r32 (global.get $GUEST_STACK))
        (call $gs32 (local.get $r32)
          (call $win16_coord (call $gl16 (local.get $rect))))
        (call $gs32 (i32.add (local.get $r32) (i32.const 4))
          (call $win16_coord (call $gl16 (i32.add (local.get $rect) (i32.const 2)))))
        (call $gs32 (i32.add (local.get $r32) (i32.const 8))
          (call $win16_coord (call $gl16 (i32.add (local.get $rect) (i32.const 4)))))
        (call $gs32 (i32.add (local.get $r32) (i32.const 12))
          (call $win16_coord (call $gl16 (i32.add (local.get $rect) (i32.const 6)))))))
    (call $win16_call32_begin (i32.const 8))
    (call $win16_call32_arg (i32.const 4) (local.get $r32))
    (call $win16_call32_arg (i32.const 5) (local.get $str))
    (call $win16_call32_arg (i32.const 6) (local.get $n))
    (call $win16_call32_arg (i32.const 7) (local.get $dx))
    (call $handle_ExtTextOutA (local.get $hdc) (local.get $x) (local.get $y)
      (local.get $opts) (local.get $r32) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 22)))

  ;; GDI.50 CreateBrushIndirect(lpLogBrush). A Win16 LOGBRUSH is eight bytes —
  ;; a word style, a dword colour and a word hatch — where Win32 pairs three
  ;; dwords, so the structure is rebuilt rather than handed over as it stands.
  (func $win16_CreateBrushIndirect
    (local $lb i32) (local $out i32) (local $style i32) (local $hatch i32)
    (local.set $lb (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $style (call $gl16 (local.get $lb)))
    (local.set $hatch (call $win16_coord (call $gl16 (i32.add (local.get $lb) (i32.const 6)))))
    ;; lbHatch is only a hatch index for BS_HATCHED. For BS_PATTERN it is a
    ;; bitmap handle and has to cross the handle spaces, and for Win16's
    ;; BS_DIBPATTERN it is a global handle to the packed DIB — which here is a
    ;; selector, so it becomes the pointer form Win32 spells BS_DIBPATTERNPT.
    ;; TetraVex builds its tile brush this way and read a NULL back as the
    ;; machine being out of memory.
    (if (i32.eq (local.get $style) (i32.const 3))
      (then (local.set $hatch (call $win16_h32 (local.get $hatch)))))
    (if (i32.eq (local.get $style) (i32.const 5))
      (then
        (local.set $hatch (call $win16_far_to_guest (local.get $hatch) (i32.const 0)))
        (local.set $style (i32.const 6))))
    (local.set $out (global.get $GUEST_STACK))
    (call $gs32 (local.get $out) (local.get $style))
    (call $gs32 (i32.add (local.get $out) (i32.const 4))
      (call $gl32 (i32.add (local.get $lb) (i32.const 2))))
    (call $gs32 (i32.add (local.get $out) (i32.const 8)) (local.get $hatch))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_CreateBrushIndirect (local.get $out) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 4)))

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

  ;; USER.407 CreateIcon(hInstance, nWidth, nHeight, nPlanes, nBitsPixel,
  ;;   lpANDbits, lpXORbits) -> HICON.
  ;;
  ;; An icon built out of two bitmaps rather than loaded from a module. The
  ;; colour half becomes a real bitmap and the icon remembers it; drawing one
  ;; blits that bitmap (see $icon_draw_handle). The mask is not applied yet —
  ;; the picture is right, its transparency is not — which is a great deal
  ;; closer than the handle-shaped nothing this used to be.
  (func $win16_CreateIcon
    (local $w i32) (local $h i32) (local $planes i32) (local $bpp i32)
    (local $xor i32) (local $bmp i32)
    (local.set $w (call $win16_coord (call $win16_arg16 (i32.const 7))))
    (local.set $h (call $win16_coord (call $win16_arg16 (i32.const 6))))
    ;; nPlanes and nBitsPixel are BYTEs, and a byte pushed as a word arrives
    ;; with whatever was in the high half — and sometimes with nothing in the
    ;; low half either. Neither can be zero for a bitmap that exists, and one
    ;; plane of one bit is what a 32x32 icon mask is: the 128 bytes the caller
    ;; just read out with GetBitmapBits.
    (local.set $planes (i32.and (call $win16_arg16 (i32.const 5)) (i32.const 0xFF)))
    (local.set $bpp (i32.and (call $win16_arg16 (i32.const 4)) (i32.const 0xFF)))
    (if (i32.eqz (local.get $planes)) (then (local.set $planes (i32.const 1))))
    (if (i32.eqz (local.get $bpp)) (then (local.set $bpp (i32.const 1))))
    (local.set $xor (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 5))
    (call $win16_call32_arg (i32.const 4) (local.get $xor))
    (call $handle_CreateBitmap (local.get $w) (local.get $h) (local.get $planes)
      (local.get $bpp) (local.get $xor) (i32.const 0))
    (call $win16_call32_end)
    (local.set $bmp (global.get $eax))
    (global.set $eax (i32.const 0))
    (if (local.get $bmp)
      (then (global.set $eax (call $win16_h16
              (call $icon_intern (global.get $ICON_FROM_BITMAP) (local.get $bmp))))))
    (call $win16_api_return (i32.const 18)))

  ;; GDI.74 GetBitmapBits(hbm, cbBuffer, lpvBits) and GDI.76 SetBitmapBits —
  ;; the bitmap's own pixels, copied to or from the caller's memory. A Visual
  ;; Basic control reads its bitmap back this way while composing the board.
  (func $win16_bitmap_bits (param $is_set i32)
    (local $bmp i32) (local $count i32) (local $buf i32)
    (local.set $buf (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $count (call $win16_arg32 (i32.const 2)))
    (local.set $bmp (call $win16_h32 (call $win16_arg16 (i32.const 4))))
    (call $win16_call32_begin (i32.const 3))
    (if (local.get $is_set)
      (then (call $handle_SetBitmapBits (local.get $bmp) (local.get $count)
              (local.get $buf) (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle_GetBitmapBits (local.get $bmp) (local.get $count)
              (local.get $buf) (i32.const 0) (i32.const 0) (i32.const 0))))
    (call $win16_call32_end)
    (global.set $edx (i32.shr_u (global.get $eax) (i32.const 16)))
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 10)))

  ;; GDI.439 StretchDIBits(hdc, XDest, YDest, cxDest, cyDest, XSrc, YSrc,
  ;;   cxSrc, cySrc, lpBits, lpBitsInfo, wUsage, dwRop).
  ;;
  ;; Thirteen arguments and two far pointers, and the bits are a DIB in the
  ;; caller's own memory rather than a GDI object — the 32-bit handler already
  ;; decodes every format these games use, so this only widens. Both Visual
  ;; Basic games draw their board through it.
  (func $win16_StretchDIBits
    (local $dc i32) (local $x i32) (local $y i32) (local $w i32) (local $h i32)
    (local $sx i32) (local $sy i32) (local $sw i32) (local $sh i32)
    (local $bits i32) (local $info i32) (local $usage i32) (local $rop i32)
    (local.set $dc (call $win16_h32 (call $win16_arg16 (i32.const 15))))
    (local.set $x (call $win16_coord (call $win16_arg16 (i32.const 14))))
    (local.set $y (call $win16_coord (call $win16_arg16 (i32.const 13))))
    (local.set $w (call $win16_coord (call $win16_arg16 (i32.const 12))))
    (local.set $h (call $win16_coord (call $win16_arg16 (i32.const 11))))
    (local.set $sx (call $win16_coord (call $win16_arg16 (i32.const 10))))
    (local.set $sy (call $win16_coord (call $win16_arg16 (i32.const 9))))
    (local.set $sw (call $win16_coord (call $win16_arg16 (i32.const 8))))
    (local.set $sh (call $win16_coord (call $win16_arg16 (i32.const 7))))
    (local.set $bits (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 6)) (call $win16_arg16 (i32.const 5))))
    (local.set $info (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 4)) (call $win16_arg16 (i32.const 3))))
    (local.set $usage (call $win16_arg16 (i32.const 2)))
    (local.set $rop (call $win16_arg32 (i32.const 0)))
    (call $win16_call32_begin (i32.const 13))
    (call $win16_call32_arg (i32.const 5) (local.get $sx))
    (call $win16_call32_arg (i32.const 6) (local.get $sy))
    (call $win16_call32_arg (i32.const 7) (local.get $sw))
    (call $win16_call32_arg (i32.const 8) (local.get $sh))
    (call $win16_call32_arg (i32.const 9) (local.get $bits))
    (call $win16_call32_arg (i32.const 10) (local.get $info))
    (call $win16_call32_arg (i32.const 11) (local.get $usage))
    (call $win16_call32_arg (i32.const 12) (local.get $rop))
    (call $handle_StretchDIBits (local.get $dc) (local.get $x) (local.get $y)
      (local.get $w) (local.get $h) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 32)))

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
  ;;
  ;; $handle_PatBlt takes only hdc/x/y as parameters and reads the width,
  ;; height AND rop back off the stack frame, so all three have to be written
  ;; into it — passing the width and height as arguments 3 and 4 looks right
  ;; and leaves the handler reading whatever the scratch stack happened to
  ;; hold. FreeCell fills its empty-cell bitmap with one PATCOPY and blits the
  ;; result into all eight cells; with a garbage size the fill covered nothing
  ;; and the cells came out the black a fresh bitmap starts as.
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
    (call $win16_call32_arg (i32.const 3) (local.get $w))
    (call $win16_call32_arg (i32.const 4) (local.get $h))
    (call $win16_call32_arg (i32.const 5) (local.get $rop))
    (call $handle_PatBlt (local.get $hdc) (local.get $x) (local.get $y)
      (local.get $w) (local.get $h) (i32.const 0))
    (call $win16_call32_end)
    ;; Report what the fill actually did. Answering TRUE regardless hid a
    ;; PatBlt that drew nothing at all behind a call that looked like it had
    ;; worked, which is the hardest kind of paint bug to see from a trace.
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 14)))

  ;; GDI.24 Ellipse(hDC, X1, Y1, X2, Y2) — the bounding box, same as Win32.
  (func $win16_Ellipse
    (local $hdc i32) (local $x1 i32) (local $y1 i32) (local $x2 i32) (local $y2 i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 4))))
    (local.set $x1 (call $win16_coord (call $win16_arg16 (i32.const 3))))
    (local.set $y1 (call $win16_coord (call $win16_arg16 (i32.const 2))))
    (local.set $x2 (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (local.set $y2 (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 5))
    (call $win16_call32_arg (i32.const 3) (local.get $x2))
    (call $win16_call32_arg (i32.const 4) (local.get $y2))
    (call $handle_Ellipse (local.get $hdc) (local.get $x1) (local.get $y1)
      (local.get $x2) (local.get $y2) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 10)))

  ;; ---- Palettes ----
  ;;
  ;; LOGPALETTE and PALETTEENTRY have the same layout in both worlds, so only
  ;; the handles and the far pointers need translating. Win16 spells the two
  ;; DC-level calls twice — GDI.361/362 are what USER.282/283 forward to after
  ;; adding the window bookkeeping this host does not need — and both spellings
  ;; land here.
  (func $win16_CreatePalette
    (local $pal i32)
    (local.set $pal (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_CreatePalette (local.get $pal) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 4)))

  (func $win16_SelectPalette
    (local $hdc i32) (local $pal i32) (local $bg i32)
    (local.set $bg (call $win16_arg16 (i32.const 0)))
    (local.set $pal (call $win16_h32 (call $win16_arg16 (i32.const 1))))
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (call $win16_call32_begin (i32.const 3))
    (call $handle_SelectPalette (local.get $hdc) (local.get $pal) (local.get $bg)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 6)))

  (func $win16_RealizePalette
    (local $hdc i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_RealizePalette (local.get $hdc) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 2)))

  ;; GetPaletteEntries / SetPaletteEntries / AnimatePalette(hPal, wStart,
  ;; wEntries, lpPaletteEntries) — one shape, three destinations.
  (func $win16_palette_entries (param $which i32)
    (local $pal i32) (local $start i32) (local $count i32) (local $entries i32)
    (local.set $entries (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $count (call $win16_arg16 (i32.const 2)))
    (local.set $start (call $win16_arg16 (i32.const 3)))
    (local.set $pal (call $win16_h32 (call $win16_arg16 (i32.const 4))))
    (call $win16_call32_begin (i32.const 4))
    (call $win16_call32_arg (i32.const 3) (local.get $entries))
    (if (i32.eq (local.get $which) (i32.const 0))
      (then (call $handle_GetPaletteEntries (local.get $pal) (local.get $start)
              (local.get $count) (local.get $entries) (i32.const 0) (i32.const 0))))
    (if (i32.eq (local.get $which) (i32.const 1))
      (then (call $handle_SetPaletteEntries (local.get $pal) (local.get $start)
              (local.get $count) (local.get $entries) (i32.const 0) (i32.const 0))))
    (if (i32.eq (local.get $which) (i32.const 2))
      (then (call $handle_AnimatePalette (local.get $pal) (local.get $start)
              (local.get $count) (local.get $entries) (i32.const 0) (i32.const 0))))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 10)))

  (func $win16_ResizePalette
    (local $pal i32) (local $n i32)
    (local.set $n (call $win16_arg16 (i32.const 0)))
    (local.set $pal (call $win16_h32 (call $win16_arg16 (i32.const 1))))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_ResizePalette (local.get $pal) (local.get $n)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 4)))

  (func $win16_GetNearestPaletteIndex
    (local $pal i32) (local $color i32)
    (local.set $color (call $win16_arg32 (i32.const 0)))
    (local.set $pal (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_GetNearestPaletteIndex (local.get $pal) (local.get $color)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 6)))

  (func $win16_UpdateColors
    (local $hdc i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_UpdateColors (local.get $hdc) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 2)))

  ;; GDI.94 GetViewportExt / .95 GetViewportOrg / .96 GetWindowExt /
  ;; .97 GetWindowOrg(hDC) -> a POINT packed into a DWORD, X in AX and Y in DX.
  ;; The Win32 spellings all take a POINT to fill instead, so the answer is
  ;; written to scratch and read straight back out.
  (func $win16_dc_pair (param $which i32)
    (local $hdc i32) (local $pt i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (local.set $pt (global.get $GUEST_STACK))
    (call $win16_call32_begin (i32.const 2))
    (if (i32.eq (local.get $which) (i32.const 0))
      (then (call $handle_GetViewportExtEx (local.get $hdc) (local.get $pt)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (if (i32.eq (local.get $which) (i32.const 1))
      (then (call $handle_GetViewportOrgEx (local.get $hdc) (local.get $pt)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (if (i32.eq (local.get $which) (i32.const 2))
      (then (call $handle_GetWindowExtEx (local.get $hdc) (local.get $pt)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (if (i32.eq (local.get $which) (i32.const 3))
      (then (call $handle_GetWindowOrgEx (local.get $hdc) (local.get $pt)
              (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))))
    (call $win16_call32_end)
    (global.set $eax (i32.and (call $gl32 (local.get $pt)) (i32.const 0xFFFF)))
    (global.set $edx (i32.and (call $gl32 (i32.add (local.get $pt) (i32.const 4)))
                              (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 2)))

  ;; ---- Mapping mode ----
  ;;
  ;; GDI.3 SetMapMode(hDC, nMapMode) -> the previous mode, and the four
  ;; two-coordinate setters GDI.11..14 plus the offset/scale pairs, each of
  ;; which answers with the value it replaced packed into DX:AX. Win32 spells
  ;; them all with a trailing POINT or SIZE to fill instead of a return value,
  ;; so the old value is read back out of scratch.
  (func $win16_SetMapMode
    (local $hdc i32) (local $mode i32)
    (local.set $mode (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 1))))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_SetMapMode (local.get $hdc) (local.get $mode)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 4)))

  (func $win16_GetMapMode
    (local $hdc i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_GetMapMode (local.get $hdc) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 2)))

  ;; which: 0 SetWindowOrg, 1 SetWindowExt, 2 SetViewportOrg, 3 SetViewportExt,
  ;; 4 OffsetWindowOrg, 5 OffsetViewportOrg, 6 ScaleWindowExt, 7 ScaleViewportExt.
  ;; The scale pair takes four arguments rather than two.
  (func $win16_dc_set_pair (param $which i32)
    (local $hdc i32) (local $a i32) (local $b i32) (local $c i32) (local $d i32)
    (local $out i32) (local $scale i32)
    (local.set $scale (i32.ge_u (local.get $which) (i32.const 6)))
    (if (local.get $scale)
      (then
        (local.set $d (call $win16_coord (call $win16_arg16 (i32.const 0))))
        (local.set $c (call $win16_coord (call $win16_arg16 (i32.const 1))))
        (local.set $b (call $win16_coord (call $win16_arg16 (i32.const 2))))
        (local.set $a (call $win16_coord (call $win16_arg16 (i32.const 3))))
        (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 4)))))
      (else
        (local.set $b (call $win16_coord (call $win16_arg16 (i32.const 0))))
        (local.set $a (call $win16_coord (call $win16_arg16 (i32.const 1))))
        (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 2))))))
    (local.set $out (global.get $GUEST_STACK))
    (call $gs32 (local.get $out) (i32.const 0))
    (call $gs32 (i32.add (local.get $out) (i32.const 4)) (i32.const 0))
    (call $win16_call32_begin (i32.const 5))
    (call $win16_call32_arg (i32.const 3) (local.get $d))
    (call $win16_call32_arg (i32.const 4) (local.get $out))
    (if (i32.eq (local.get $which) (i32.const 0))
      (then (call $handle_SetWindowOrgEx (local.get $hdc) (local.get $a) (local.get $b)
              (local.get $out) (i32.const 0) (i32.const 0))))
    (if (i32.eq (local.get $which) (i32.const 1))
      (then (call $handle_SetWindowExtEx (local.get $hdc) (local.get $a) (local.get $b)
              (local.get $out) (i32.const 0) (i32.const 0))))
    (if (i32.eq (local.get $which) (i32.const 2))
      (then (call $handle_SetViewportOrgEx (local.get $hdc) (local.get $a) (local.get $b)
              (local.get $out) (i32.const 0) (i32.const 0))))
    (if (i32.eq (local.get $which) (i32.const 3))
      (then (call $handle_SetViewportExtEx (local.get $hdc) (local.get $a) (local.get $b)
              (local.get $out) (i32.const 0) (i32.const 0))))
    (if (i32.eq (local.get $which) (i32.const 4))
      (then (call $handle_OffsetWindowOrgEx (local.get $hdc) (local.get $a) (local.get $b)
              (local.get $out) (i32.const 0) (i32.const 0))))
    (if (i32.eq (local.get $which) (i32.const 5))
      (then (call $handle_OffsetViewportOrgEx (local.get $hdc) (local.get $a) (local.get $b)
              (local.get $out) (i32.const 0) (i32.const 0))))
    (if (i32.eq (local.get $which) (i32.const 6))
      (then (call $handle_ScaleWindowExtEx (local.get $hdc) (local.get $a) (local.get $b)
              (local.get $c) (local.get $d) (i32.const 0))))
    (if (i32.eq (local.get $which) (i32.const 7))
      (then (call $handle_ScaleViewportExtEx (local.get $hdc) (local.get $a) (local.get $b)
              (local.get $c) (local.get $d) (i32.const 0))))
    (call $win16_call32_end)
    (global.set $eax (i32.and (call $gl32 (local.get $out)) (i32.const 0xFFFF)))
    (global.set $edx (i32.and (call $gl32 (i32.add (local.get $out) (i32.const 4)))
                              (i32.const 0xFFFF)))
    (call $win16_api_return (select (i32.const 10) (i32.const 6) (local.get $scale))))

  ;; GDI.346 SetTextAlign(hDC, wFlags) -> the previous alignment.
  (func $win16_SetTextAlign
    (local $hdc i32) (local $flags i32)
    (local.set $flags (call $win16_arg16 (i32.const 0)))
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 1))))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_SetTextAlign (local.get $hdc) (local.get $flags)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 4)))

  ;; GDI.128 MulDiv(nNumber, nNumerator, nDenominator) -> (a*b)/c rounded, with
  ;; the multiply done wide so it does not overflow sixteen bits on the way —
  ;; which is the whole reason the call exists. -32768 signals a zero divisor.
  (func $win16_MulDiv
    (local $a i32) (local $b i32) (local $c i32) (local $r i32)
    (local.set $c (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (local.set $b (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (local.set $a (call $win16_coord (call $win16_arg16 (i32.const 2))))
    (if (i32.eqz (local.get $c))
      (then
        (global.set $eax (i32.const 0x8000))
        (call $win16_api_return (i32.const 6))
        (return)))
    (local.set $r (i32.mul (local.get $a) (local.get $b)))
    ;; Round to nearest, away from zero, the way GDI's own does.
    (if (i32.eq (i32.lt_s (local.get $r) (i32.const 0))
                (i32.lt_s (local.get $c) (i32.const 0)))
      (then (local.set $r (i32.add (local.get $r) (i32.div_s (local.get $c) (i32.const 2)))))
      (else (local.set $r (i32.sub (local.get $r) (i32.div_s (local.get $c) (i32.const 2))))))
    (global.set $eax (i32.and (i32.div_s (local.get $r) (local.get $c))
                              (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 6)))

  ;; GDI.99 LPtoDP / GDI.67 DPtoLP(hDC, lpPoints, nCount) — map an array of
  ;; points between logical and device space, in place. Points are two words
  ;; here and two longs there, so the array is widened into scratch, converted,
  ;; and narrowed back over the caller's own array.
  (func $win16_map_points (param $to_device i32)
    (local $hdc i32) (local $src i32) (local $n i32) (local $dst i32) (local $i i32)
    (local.set $n (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (local.set $src (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 3))))
    (if (i32.gt_u (local.get $n) (i32.const 512))
      (then
        (call $host_log_i32 (i32.const 0xCA16B01E))   ;; more points than scratch holds
        (call $host_log_i32 (local.get $n))
        (unreachable)))
    (local.set $dst (global.get $GUEST_STACK))
    (block $wide (loop $pts
      (br_if $wide (i32.ge_u (local.get $i) (i32.shl (local.get $n) (i32.const 1))))
      (call $gs32 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 2)))
        (call $win16_coord
          (call $gl16 (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 1))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $pts)))
    (call $win16_call32_begin (i32.const 3))
    (if (local.get $to_device)
      (then (call $handle_LPtoDP (local.get $hdc) (local.get $dst) (local.get $n)
              (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle_DPtoLP (local.get $hdc) (local.get $dst) (local.get $n)
              (i32.const 0) (i32.const 0) (i32.const 0))))
    (call $win16_call32_end)
    (local.set $i (i32.const 0))
    (block $narrow (loop $back
      (br_if $narrow (i32.ge_u (local.get $i) (i32.shl (local.get $n) (i32.const 1))))
      (call $gs16 (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 1)))
        (call $gl32 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 2)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $back)))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 8)))

  ;; GDI.36 Polygon / GDI.37 Polyline(hDC, lpPoints, nCount). A Win16 POINT is
  ;; two words and a Win32 one two longs, so the array is widened into scratch
  ;; on the way through. The cap is what the scratch holds, and a longer array
  ;; is refused rather than truncated into a shape the app did not ask for.
  (func $win16_poly (param $closed i32)
    (local $hdc i32) (local $src i32) (local $n i32) (local $dst i32) (local $i i32)
    (local.set $n (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (local.set $src (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 3))))
    (if (i32.gt_u (local.get $n) (i32.const 512))
      (then
        (call $host_log_i32 (i32.const 0xCA16B01F))   ;; polygon too long for scratch
        (call $host_log_i32 (local.get $n))
        (unreachable)))
    (local.set $dst (global.get $GUEST_STACK))
    (block $done (loop $pts
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (call $gs32 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 3)))
        (call $win16_coord (call $gl16
          (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 2))))))
      (call $gs32 (i32.add (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 3)))
                           (i32.const 4))
        (call $win16_coord (call $gl16
          (i32.add (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 2)))
                   (i32.const 2)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $pts)))
    (call $win16_call32_begin (i32.const 3))
    (if (local.get $closed)
      (then (call $handle_Polygon (local.get $hdc) (local.get $dst) (local.get $n)
              (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle_Polyline (local.get $hdc) (local.get $dst) (local.get $n)
              (i32.const 0) (i32.const 0) (i32.const 0))))
    (call $win16_call32_end)
    (global.set $eax (i32.ne (global.get $eax) (i32.const 0)))
    (call $win16_api_return (i32.const 8)))

  ;; GDI.21 ExcludeClipRect(hDC, X1, Y1, X2, Y2) -> the new clip region's type.
  (func $win16_ExcludeClipRect
    (local $hdc i32) (local $x1 i32) (local $y1 i32) (local $x2 i32) (local $y2 i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 4))))
    (local.set $x1 (call $win16_coord (call $win16_arg16 (i32.const 3))))
    (local.set $y1 (call $win16_coord (call $win16_arg16 (i32.const 2))))
    (local.set $x2 (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (local.set $y2 (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 5))
    (call $win16_call32_arg (i32.const 3) (local.get $x2))
    (call $win16_call32_arg (i32.const 4) (local.get $y2))
    (call $handle_ExcludeClipRect (local.get $hdc) (local.get $x1) (local.get $y1)
      (local.get $x2) (local.get $y2) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 10)))

  ;; GDI.27 Rectangle(hDC, X1, Y1, X2, Y2).
  (func $win16_Rectangle
    (local $hdc i32) (local $x1 i32) (local $y1 i32) (local $x2 i32) (local $y2 i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 4))))
    (local.set $x1 (call $win16_coord (call $win16_arg16 (i32.const 3))))
    (local.set $y1 (call $win16_coord (call $win16_arg16 (i32.const 2))))
    (local.set $x2 (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (local.set $y2 (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 5))
    (call $win16_call32_arg (i32.const 3) (local.get $x2))
    (call $win16_call32_arg (i32.const 4) (local.get $y2))
    (call $handle_Rectangle (local.get $hdc) (local.get $x1) (local.get $y1)
      (local.get $x2) (local.get $y2) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 10)))

  ;; GDI.23 Arc(hDC, X1, Y1, X2, Y2, X3, Y3, X4, Y4) — bounding box, then the
  ;; two radial points that cut the start and end of the arc out of it.
  (func $win16_Arc
    (local $hdc i32) (local $x1 i32) (local $y1 i32) (local $x2 i32) (local $y2 i32)
    (local $x3 i32) (local $y3 i32) (local $x4 i32) (local $y4 i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 8))))
    (local.set $x1 (call $win16_coord (call $win16_arg16 (i32.const 7))))
    (local.set $y1 (call $win16_coord (call $win16_arg16 (i32.const 6))))
    (local.set $x2 (call $win16_coord (call $win16_arg16 (i32.const 5))))
    (local.set $y2 (call $win16_coord (call $win16_arg16 (i32.const 4))))
    (local.set $x3 (call $win16_coord (call $win16_arg16 (i32.const 3))))
    (local.set $y3 (call $win16_coord (call $win16_arg16 (i32.const 2))))
    (local.set $x4 (call $win16_coord (call $win16_arg16 (i32.const 1))))
    (local.set $y4 (call $win16_coord (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 9))
    (call $win16_call32_arg (i32.const 3) (local.get $x2))
    (call $win16_call32_arg (i32.const 4) (local.get $y2))
    (call $win16_call32_arg (i32.const 5) (local.get $x3))
    (call $win16_call32_arg (i32.const 6) (local.get $y3))
    (call $win16_call32_arg (i32.const 7) (local.get $x4))
    (call $win16_call32_arg (i32.const 8) (local.get $y4))
    (call $handle_Arc (local.get $hdc) (local.get $x1) (local.get $y1)
      (local.get $x2) (local.get $y2) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 18)))

  ;; GDI.90 GetTextColor(hDC) -> COLORREF in DX:AX.
  (func $win16_GetTextColor
    (local $hdc i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 1))
    (call $handle_GetTextColor (local.get $hdc) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $edx (i32.shr_u (global.get $eax) (i32.const 16)))
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 2)))

  ;; GDI.154 GetNearestColor(hDC, crColor) -> the colour the device can
  ;; actually show. Answers in DX:AX like every DWORD-returning Win16 call.
  (func $win16_GetNearestColor
    (local $hdc i32) (local $color i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (local.set $color (call $win16_arg32 (i32.const 0)))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_GetNearestColor (local.get $hdc) (local.get $color)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $edx (i32.shr_u (global.get $eax) (i32.const 16)))
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 6)))

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
    ;; nPlanes and nBitCount are BYTE parameters, and a byte pushed as a word
    ;; carries whatever was in the high half — SkiFree's compiler leaves the
    ;; previous value there, so its 1-plane 1-bit bitmap arrived as 0x0101 by
    ;; 0x0101 and GDI refused it. "Whoa, like, can't load bitmaps! Yer outa
    ;; memory, duuude!" was the whole of the diagnosis.
    (local.set $planes (i32.and (call $win16_arg16 (i32.const 3)) (i32.const 0xFF)))
    (local.set $bpp (i32.and (call $win16_arg16 (i32.const 2)) (i32.const 0xFF)))
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
    (local $hdc i32)
    (local.set $hdc (call $win16_h32 (call $win16_arg16 (i32.const 0))))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_GetDCOrgEx (local.get $hdc)
      (global.get $GUEST_STACK) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (call $gl32 (global.get $GUEST_STACK)) (i32.const 0xFFFF)))
    (global.set $edx (i32.and (call $gl32 (i32.add (global.get $GUEST_STACK) (i32.const 4)))
                              (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 2)))

  ;; GDI.100 LineDDA(nXStart, nYStart, nXEnd, nYEnd, lpLineFunc, lpData).
  ;;
  ;; Windows walks the line and hands each point to the application; none of the
  ;; drawing is GDI's. Solitaire uses it for the card that flies to a foundation
  ;; on a double-click, so this is what a double-click reached — and, being
  ;; unimplemented, what it died on.
  ;;
  ;; The callback is guest code, so this cannot be a loop: every point has to
  ;; give the interpreter the task back and be picked up again on the far
  ;; return. The walk's state lives in globals between points and the Pascal
  ;; frame goes up front, the way the modal pump parks — the far return saved
  ;; here is what the last point resumes.
  (global $WIN16_DDA_CB i32 (i32.const 0xFF90))
  ;; The same shape for EnumFonts, whose callback also runs between one entry
  ;; and the next.
  (global $WIN16_ENUMFONT_CB i32 (i32.const 0xFF94))
  (global $win16_dda_ret  (mut i32) (i32.const 0))
  ;; ---- GDI.70 EnumFonts(hDC, lpFaceName, lpFontFunc, lpData) ----
  ;;
  ;; The faces this device has are the bitmap strikes src/10b-gdi-font.wat can
  ;; render; naming anything else would be inviting the caller to ask for a
  ;; font that would then come back as a substitute. Asking by face name
  ;; reports that one face if it is among them, which is what "enumerate the
  ;; sizes of this face" comes to on a device with one size of each.
  ;;
  ;; Like LineDDA, the callback is guest code, so this cannot be a loop: each
  ;; face gives the interpreter the task back and is picked up again on the far
  ;; return, and a callback that answers zero ends the enumeration.
  (global $WIN16_FONT_FACES i32 (i32.const 0x00003E00))
  (global $win16_ef_proc (mut i32) (i32.const 0))
  (global $win16_ef_data (mut i32) (i32.const 0))
  (global $win16_ef_ret  (mut i32) (i32.const 0))
  (global $win16_ef_face (mut i32) (i32.const 0))
  (global $win16_ef_one  (mut i32) (i32.const 0))
  (global $win16_ef_hdc  (mut i32) (i32.const 0))
  (global $win16_ef_count (mut i32) (i32.const 0))

  (func $win16_EnumFonts
    (local $want i32) (local $p i32)
    (global.set $win16_ef_hdc (call $win16_h32 (call $win16_arg16 (i32.const 6))))
    (global.set $win16_ef_proc (call $win16_arg32 (i32.const 2)))
    (global.set $win16_ef_data (call $win16_arg32 (i32.const 0)))
    (local.set $want (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 5)) (call $win16_arg16 (i32.const 4))))
    (if (i32.eqz (call $win16_arg16 (i32.const 5))) (then (local.set $want (i32.const 0))))
    (global.set $win16_ef_ret (i32.or
      (i32.shl (call $gl16 (i32.add (global.get $esp) (i32.const 2))) (i32.const 16))
      (call $gl16 (global.get $esp))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 18)))  ;; far return + 14
    (global.set $win16_ef_count (i32.const 0))
    (global.set $win16_ef_one (i32.const 0))
    (global.set $win16_ef_face (global.get $WIN16_FONT_FACES))
    ;; A named face: find it in the list, and report only that one.
    (if (local.get $want)
      (then
        (local.set $p (global.get $WIN16_FONT_FACES))
        (global.set $win16_ef_face (i32.const 0))
        (block $found (loop $faces
          (br_if $found (i32.eqz (i32.load8_u (local.get $p))))
          (if (call $win16_res_name_eq_z (local.get $p) (call $g2w (local.get $want)))
            (then
              (global.set $win16_ef_face (local.get $p))
              (global.set $win16_ef_one (i32.const 1))
              (br $found)))
          (local.set $p (i32.add (local.get $p)
            (i32.add (call $strlen_wa (local.get $p)) (i32.const 1))))
          (br $faces)))))
    (call $win16_ef_next))

  ;; Fill the LOGFONT and TEXTMETRIC the callback is shown, then enter it. The
  ;; metrics come from the DC, so they describe a real font this device has
  ;; rather than numbers invented here.
  (func $win16_ef_enter
    (local $lf i32) (local $tm i32) (local $wide i32) (local $i i32) (local $n i32)
    (local.set $lf (i32.add (call $win16_seg_base (global.get $win16_auto_data))
                            (global.get $win16_font_scratch)))
    (local.set $tm (i32.add (local.get $lf) (i32.const 52)))
    (call $zero_memory (call $g2w (local.get $lf)) (global.get $WIN16_FONT_SCRATCH_SIZE))
    ;; TEXTMETRICA is the same fields with longs where Win16 has words, so it
    ;; is measured into scratch and narrowed.
    (local.set $wide (global.get $GUEST_STACK))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_GetTextMetricsA (global.get $win16_ef_hdc) (local.get $wide)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (block $done (loop $narrow
      (br_if $done (i32.ge_u (local.get $i) (i32.const 11)))
      (call $gs16 (i32.add (local.get $tm) (i32.shl (local.get $i) (i32.const 1)))
        (call $gl32 (i32.add (local.get $wide) (i32.shl (local.get $i) (i32.const 2)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $narrow)))
    (local.set $i (i32.const 0))
    (block $copied (loop $bytes
      (br_if $copied (i32.ge_u (local.get $i) (i32.const 9)))
      (call $gs8 (i32.add (i32.add (local.get $tm) (i32.const 22)) (local.get $i))
        (call $gl8 (i32.add (i32.add (local.get $wide) (i32.const 44)) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $bytes)))
    ;; LOGFONT: the height and weight the DC reports, the rest defaulted, and
    ;; the face name this entry is about.
    (call $gs16 (local.get $lf) (call $gl16 (local.get $tm)))            ;; lfHeight
    (call $gs16 (i32.add (local.get $lf) (i32.const 8))
      (call $gl16 (i32.add (local.get $tm) (i32.const 14))))             ;; lfWeight
    (call $gs8 (i32.add (local.get $lf) (i32.const 13))
      (call $gl8 (i32.add (local.get $tm) (i32.const 30))))              ;; lfCharSet
    (call $gs8 (i32.add (local.get $lf) (i32.const 17))
      (call $gl8 (i32.add (local.get $tm) (i32.const 29))))              ;; lfPitchAndFamily
    (local.set $n (call $strlen_wa (global.get $win16_ef_face)))
    (if (i32.gt_u (local.get $n) (i32.const 31)) (then (local.set $n (i32.const 31))))
    (local.set $i (i32.const 0))
    (block $named (loop $chars
      (br_if $named (i32.ge_u (local.get $i) (local.get $n)))
      (call $gs8 (i32.add (i32.add (local.get $lf) (i32.const 18)) (local.get $i))
        (i32.load8_u (i32.add (global.get $win16_ef_face) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $chars)))
    (global.set $win16_ef_count (i32.add (global.get $win16_ef_count) (i32.const 1)))
    ;; The callback's Pascal frame: lpLogFont, lpTextMetric, nFontType, lpData,
    ;; and a far return onto the thunk that picks the walk up again. RASTER
    ;; (1) is what these strikes are.
    (call $win16_push16 (call $win16_index_to_sel (global.get $win16_auto_data)))
    (call $win16_push16 (global.get $win16_font_scratch))
    (call $win16_push16 (call $win16_index_to_sel (global.get $win16_auto_data)))
    (call $win16_push16 (i32.add (global.get $win16_font_scratch) (i32.const 52)))
    (call $win16_push16 (i32.const 1))
    (call $win16_push16 (i32.shr_u (global.get $win16_ef_data) (i32.const 16)))
    (call $win16_push16 (global.get $win16_ef_data))
    (call $win16_push16 (global.get $WIN16_THUNK_SEL))
    (call $win16_push16 (global.get $WIN16_ENUMFONT_CB))
    (call $win16_set_sreg (i32.const 1)
      (i32.shr_u (global.get $win16_ef_proc) (i32.const 16)))
    (global.set $eip (i32.add (global.get $seg_base_cs)
                              (i32.and (global.get $win16_ef_proc) (i32.const 0xFFFF))))
    (global.set $steps (i32.const 0)))

  ;; Next face, or give the caller its call back.
  (func $win16_ef_next
    (if (i32.or (i32.eqz (global.get $win16_ef_face))
                (i32.eqz (i32.load8_u (global.get $win16_ef_face))))
      (then (call $win16_ef_resume) (return)))
    (call $win16_ef_enter))

  ;; The callback has answered. Zero means stop; anything else means go on.
  (func $win16_ef_step
    (if (i32.eqz (i32.and (global.get $eax) (i32.const 0xFFFF)))
      (then (call $win16_ef_resume) (return)))
    (if (global.get $win16_ef_one)
      (then (call $win16_ef_resume) (return)))
    (global.set $win16_ef_face
      (i32.add (global.get $win16_ef_face)
               (i32.add (call $strlen_wa (global.get $win16_ef_face)) (i32.const 1))))
    (call $win16_ef_next))

  ;; EnumFonts answers with the last value the callback returned, or the number
  ;; of faces reported when it never asked to stop. Non-zero either way, which
  ;; is what a caller checks.
  (func $win16_ef_resume
    (global.set $eax (global.get $win16_ef_count))
    (call $win16_set_sreg (i32.const 1)
      (i32.shr_u (global.get $win16_ef_ret) (i32.const 16)))
    (global.set $eip (i32.add (global.get $seg_base_cs)
                              (i32.and (global.get $win16_ef_ret) (i32.const 0xFFFF))))
    (global.set $steps (i32.const 0)))

  (func $strlen_wa (param $p i32) (result i32)
    (local $n i32)
    (block $done (loop $scan
      (br_if $done (i32.eqz (i32.load8_u (i32.add (local.get $p) (local.get $n)))))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br $scan)))
    (local.get $n))

  (global $win16_dda_proc (mut i32) (i32.const 0))
  (global $win16_dda_data (mut i32) (i32.const 0))
  (global $win16_dda_x    (mut i32) (i32.const 0))
  (global $win16_dda_y    (mut i32) (i32.const 0))
  (global $win16_dda_dx   (mut i32) (i32.const 0))
  (global $win16_dda_dy   (mut i32) (i32.const 0))
  (global $win16_dda_sx   (mut i32) (i32.const 0))
  (global $win16_dda_sy   (mut i32) (i32.const 0))
  (global $win16_dda_err  (mut i32) (i32.const 0))
  (global $win16_dda_left (mut i32) (i32.const 0))

  (func $win16_LineDDA
    (local $x0 i32) (local $y0 i32) (local $x1 i32) (local $y1 i32)
    (local $dx i32) (local $dy i32)
    (local.set $x0 (call $win16_coord (call $win16_arg16 (i32.const 7))))
    (local.set $y0 (call $win16_coord (call $win16_arg16 (i32.const 6))))
    (local.set $x1 (call $win16_coord (call $win16_arg16 (i32.const 5))))
    (local.set $y1 (call $win16_coord (call $win16_arg16 (i32.const 4))))
    (global.set $win16_dda_proc (call $win16_arg32 (i32.const 2)))
    (global.set $win16_dda_data (call $win16_arg32 (i32.const 0)))
    (global.set $win16_dda_ret (i32.or
      (i32.shl (call $gl16 (i32.add (global.get $esp) (i32.const 2))) (i32.const 16))
      (call $gl16 (global.get $esp))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; far return + 16 argbytes
    (local.set $dx (i32.sub (local.get $x1) (local.get $x0)))
    (local.set $dy (i32.sub (local.get $y1) (local.get $y0)))
    (global.set $win16_dda_sx
      (select (i32.const 1) (i32.const -1) (i32.ge_s (local.get $dx) (i32.const 0))))
    (global.set $win16_dda_sy
      (select (i32.const 1) (i32.const -1) (i32.ge_s (local.get $dy) (i32.const 0))))
    (local.set $dx (select (local.get $dx) (i32.sub (i32.const 0) (local.get $dx))
                           (i32.ge_s (local.get $dx) (i32.const 0))))
    (local.set $dy (select (local.get $dy) (i32.sub (i32.const 0) (local.get $dy))
                           (i32.ge_s (local.get $dy) (i32.const 0))))
    (global.set $win16_dda_dx (local.get $dx))
    (global.set $win16_dda_dy (local.get $dy))
    (global.set $win16_dda_err (i32.sub (local.get $dx) (local.get $dy)))
    (global.set $win16_dda_x (local.get $x0))
    (global.set $win16_dda_y (local.get $y0))
    ;; The end point is not one of the points, so a line from a point to itself
    ;; calls back not at all.
    (global.set $win16_dda_left
      (select (local.get $dx) (local.get $dy) (i32.gt_s (local.get $dx) (local.get $dy))))
    (if (i32.eqz (global.get $win16_dda_left))
      (then (call $win16_dda_resume) (return)))
    (call $win16_dda_enter))

  ;; One point, handed over with the callback's own Pascal frame: x, y, the
  ;; application's DWORD, and a far return onto $WIN16_DDA_CB. The callback
  ;; removes its arguments itself, so the stack comes back as it went in.
  (func $win16_dda_enter
    (call $win16_push16 (global.get $win16_dda_x))
    (call $win16_push16 (global.get $win16_dda_y))
    (call $win16_push16 (i32.shr_u (global.get $win16_dda_data) (i32.const 16)))
    (call $win16_push16 (global.get $win16_dda_data))
    (call $win16_push16 (global.get $WIN16_THUNK_SEL))
    (call $win16_push16 (global.get $WIN16_DDA_CB))
    (call $win16_set_sreg (i32.const 1) (i32.shr_u (global.get $win16_dda_proc) (i32.const 16)))
    (global.set $eip (i32.add (global.get $seg_base_cs)
                              (i32.and (global.get $win16_dda_proc) (i32.const 0xFFFF))))
    (global.set $steps (i32.const 0)))

  ;; The callback has returned. Step the line on by one point — Bresenham, so
  ;; the points are the ones a drawn line would cover — and either hand over the
  ;; next or give the caller its call back.
  (func $win16_dda_step
    (local $e2 i32)
    (local.set $e2 (i32.shl (global.get $win16_dda_err) (i32.const 1)))
    (if (i32.gt_s (local.get $e2) (i32.sub (i32.const 0) (global.get $win16_dda_dy)))
      (then
        (global.set $win16_dda_err
          (i32.sub (global.get $win16_dda_err) (global.get $win16_dda_dy)))
        (global.set $win16_dda_x
          (i32.add (global.get $win16_dda_x) (global.get $win16_dda_sx)))))
    (if (i32.lt_s (local.get $e2) (global.get $win16_dda_dx))
      (then
        (global.set $win16_dda_err
          (i32.add (global.get $win16_dda_err) (global.get $win16_dda_dx)))
        (global.set $win16_dda_y
          (i32.add (global.get $win16_dda_y) (global.get $win16_dda_sy)))))
    (global.set $win16_dda_left (i32.sub (global.get $win16_dda_left) (i32.const 1)))
    (if (i32.gt_s (global.get $win16_dda_left) (i32.const 0))
      (then (call $win16_dda_enter) (return)))
    (call $win16_dda_resume))

  ;; LineDDA returns nothing, so AX carries nothing worth setting beyond a
  ;; defined zero. The frame went when the walk started; this is the splice back
  ;; to the instruction after the call.
  (func $win16_dda_resume
    (global.set $eax (i32.const 0))
    (call $win16_set_sreg (i32.const 1) (i32.shr_u (global.get $win16_dda_ret) (i32.const 16)))
    (global.set $eip (i32.add (global.get $seg_base_cs)
                              (i32.and (global.get $win16_dda_ret) (i32.const 0xFFFF))))
    (global.set $steps (i32.const 0)))

  (func $win16_gdi (param $ordinal i32) (result i32)
    (if (i32.eq (local.get $ordinal) (i32.const 3))
      (then (call $win16_SetMapMode) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 81))
      (then (call $win16_GetMapMode) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 128))
      (then (call $win16_MulDiv) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 11))
      (then (call $win16_dc_set_pair (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 12))
      (then (call $win16_dc_set_pair (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 13))
      (then (call $win16_dc_set_pair (i32.const 2)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 14))
      (then (call $win16_dc_set_pair (i32.const 3)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 15))
      (then (call $win16_dc_set_pair (i32.const 4)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 16))
      (then (call $win16_dc_set_pair (i32.const 6)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 17))
      (then (call $win16_dc_set_pair (i32.const 5)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 18))
      (then (call $win16_dc_set_pair (i32.const 7)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 21))
      (then (call $win16_ExcludeClipRect) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 23))
      (then (call $win16_Arc) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 24))
      (then (call $win16_Ellipse) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 27))
      (then (call $win16_Rectangle) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 67))
      (then (call $win16_map_points (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 99))
      (then (call $win16_map_points (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 70))
      (then (call $win16_EnumFonts) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 104))
      (then (call $win16_RectVisible) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 90))
      (then (call $win16_GetTextColor) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 36))
      (then (call $win16_poly (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 37))
      (then (call $win16_poly (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 50))
      (then (call $win16_CreateBrushIndirect) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 346))
      (then (call $win16_SetTextAlign) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 351))
      (then (call $win16_ExtTextOut) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 360))
      (then (call $win16_CreatePalette) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 361))
      (then (call $win16_SelectPalette) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 362))
      (then (call $win16_RealizePalette) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 363))
      (then (call $win16_palette_entries (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 364))
      (then (call $win16_palette_entries (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 366))
      (then (call $win16_UpdateColors) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 367))
      (then (call $win16_palette_entries (i32.const 2)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 368))
      (then (call $win16_ResizePalette) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 370))
      (then (call $win16_GetNearestPaletteIndex) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 94))
      (then (call $win16_dc_pair (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 95))
      (then (call $win16_dc_pair (i32.const 1)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 96))
      (then (call $win16_dc_pair (i32.const 2)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 97))
      (then (call $win16_dc_pair (i32.const 3)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 154))
      (then (call $win16_GetNearestColor) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 100))
      (then (call $win16_LineDDA) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 79))
      (then (call $win16_GetDCOrg) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 103))
      (then (call $win16_PtVisible) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 56))
      (then (call $win16_CreateFont) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 57))
      (then (call $win16_CreateFontIndirect) (return (i32.const 1))))
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
    (if (i32.eq (local.get $ordinal) (i32.const 439))
      (then (call $win16_StretchDIBits) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 74))
      (then (call $win16_bitmap_bits (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 76))
      (then (call $win16_bitmap_bits (i32.const 1)) (return (i32.const 1))))
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
    (if (i32.eq (local.get $ordinal) (i32.const 172))
      (then (call $win16_SetRectRgn) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 47))
      (then (call $win16_CombineRgn) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 51))
      (then (call $win16_CreateCompatibleBitmap) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 52))
      (then (call $win16_CreateCompatibleDC) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 61))
      (then (call $win16_CreatePen) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 64))
      (then (call $win16_CreateRectRgn) (return (i32.const 1))))
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
    ;; EIP zero is the exception: that is how a task that has been terminated
    ;; on purpose — FatalAppExit, or a fatal error the host reported — tells
    ;; the run loop it is done, and it must not read as a wild jump.
    (if (i32.and (i32.ne (global.get $eip) (i32.const 0))
        (i32.or
          (i32.lt_u (global.get $eip) (global.get $WIN16_ARENA))
          (i32.ge_u (global.get $eip)
            (i32.add (global.get $WIN16_ARENA)
              (i32.mul (global.get $WIN16_SEG_MAX) (i32.const 0x10000))))))
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
        (call $host_log_i32 (global.get $esp))
        ;; How much the call actually took off the stack, counting the far
        ;; return address: 4 + the Pascal argument bytes. Compare it against
        ;; the API's real signature — a wrong count here is a frame bug that
        ;; only shows up much later, as a return into nothing.
        (call $host_log_i32 (i32.sub (global.get $esp) (global.get $win16_entry_esp)))
        ;; And the data selector the task is left holding. An API that returns
        ;; with the wrong DS is invisible until the task pushes it as half of
        ;; a far pointer: Pipe Dream handed CreateWindow a class name whose
        ;; segment was zero and got a window with no class at all.
        (call $host_log_i32 (global.get $sreg_ds)))))

  ;; Hooks.
  ;;
  ;; Only WH_CALLWNDPROC is delivered, and only from CreateWindow. That is not
  ;; an arbitrary subset: it is how a 16-bit MFC application gets a C++ object
  ;; onto an HWND at all. AfxHookWindowCreate installs this filter, the filter
  ;; watches for the WM_NCCREATE or WM_GETMINMAXINFO that CreateWindow sends,
  ;; and on the first of those it puts the window in the handle map and
  ;; subclasses it to AfxWndProc. Never calling it left Hearts' own window
  ;; procedure looking its window up in an empty map, getting NULL, and calling
  ;; through the null object's vtable — `les bx,[bx]` with bx zero.
  ;;
  ;; Deliberately not routed to $handle_SetWindowsHookExA: that one remembers a
  ;; CBT procedure for CreateWindowEx to call as a flat address, and a Win16
  ;; hook procedure is a far pointer.
  ;;
  ;; The other filter types still install and unhook without ever being called.
  ;; They should be delivered from wherever their message actually originates,
  ;; and each one is its own piece of work; this says so by leaving them alone
  ;; rather than by pretending the hook does not exist.
  ;;
  ;; A Win16 HHOOK is a *far pointer*, not a word — SetWindowsHookEx answers in
  ;; DX:AX and every call that takes one back pops four bytes. Treating it as a
  ;; word left two bytes of the caller's frame behind on every unhook and gave
  ;; the app an uninitialised DX for the other half of the handle it stored;
  ;; MFC keeps it in two words and hands both back. The handle here is the
  ;; filter's own address, which is what makes it unambiguous to match on.
  (func $win16_hook (param $which i32)
    (local $prev i32)
    ;; SetWindowsHookEx(idHook, lpfn, hMod, hTask) -> HHOOK. The filter type is
    ;; the first parameter, so under Pascal it lies deepest.
    (if (i32.eq (local.get $which) (i32.const 0))
      (then
        (local.set $prev (call $win16_arg32 (i32.const 2)))
        (if (i32.eq (call $win16_arg16 (i32.const 4)) (global.get $WIN16_WH_CALLWNDPROC))
          (then (global.set $win16_hook_cwp (local.get $prev))))
        (global.set $edx (i32.shr_u (local.get $prev) (i32.const 16)))
        (call $win16_local_identity (i32.const 10)
          (i32.and (local.get $prev) (i32.const 0xFFFF)))
        (return)))
    (if (i32.eq (local.get $which) (i32.const 1))       ;; UnhookWindowsHookEx
      (then
        (if (i32.and (i32.ne (global.get $win16_hook_cwp) (i32.const 0))
                     (i32.eq (call $win16_arg32 (i32.const 0))
                             (global.get $win16_hook_cwp)))
          (then (global.set $win16_hook_cwp (i32.const 0))))
        (call $win16_local_identity (i32.const 4) (i32.const 1))
        (return)))
    (if (i32.eq (local.get $which) (i32.const 2))       ;; CallNextHookEx
      (then
        (global.set $edx (i32.const 0))
        (call $win16_local_identity (i32.const 12) (i32.const 0))
        (return)))
    ;; SetWindowsHook(idHook, lpfn) -> the previous filter, as a far pointer in
    ;; DX:AX. The 3.0 spelling of the call above, and the one MFC reaches for
    ;; when it decides the Ex form is unavailable.
    (if (i32.eq (local.get $which) (i32.const 3))
      (then
        (if (i32.eq (call $win16_arg16 (i32.const 2)) (global.get $WIN16_WH_CALLWNDPROC))
          (then
            (local.set $prev (global.get $win16_hook_cwp))
            (global.set $win16_hook_cwp (call $win16_arg32 (i32.const 0)))
            (global.set $edx (i32.shr_u (local.get $prev) (i32.const 16)))
            (call $win16_local_identity (i32.const 6)
              (i32.and (local.get $prev) (i32.const 0xFFFF)))
            (return)))
        (global.set $edx (i32.const 0))
        (call $win16_local_identity (i32.const 6) (i32.const 0))
        (return)))
    (if (i32.eq (local.get $which) (i32.const 4))       ;; UnhookWindowsHook
      (then
        (if (i32.eq (call $win16_arg16 (i32.const 2)) (global.get $WIN16_WH_CALLWNDPROC))
          (then (global.set $win16_hook_cwp (i32.const 0))))
        (call $win16_local_identity (i32.const 6) (i32.const 1))
        (return)))
    (global.set $edx (i32.const 0))                     ;; DefHookProc
    (call $win16_local_identity (i32.const 12) (i32.const 0)))

  ;; ---- COMMDLG ----

  ;; COMMDLG.27 GetFileTitle(lpszFile, lpszTitle, cbBuf). Both buffers hold
  ;; bytes in either world, so only the pointers need widening.
  (func $win16_GetFileTitle
    (local $file i32) (local $title i32) (local $cb i32)
    (local.set $file (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 4)) (call $win16_arg16 (i32.const 3))))
    (local.set $title (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (local.set $cb (call $win16_arg16 (i32.const 0)))
    (call $win16_call32_begin (i32.const 3))
    (call $handle_GetFileTitleA (local.get $file) (local.get $title) (local.get $cb)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 10)))

  ;; ---- MMSYSTEM ----

  ;; MMSYSTEM.401 waveOutGetNumDevs() -> UINT, and MMSYSTEM.2 sndPlaySound(
  ;; lpszSound, fuSound) -> BOOL. Hearts asks how many wave devices there are
  ;; before it will play anything, so answering it is what turns the sound on.
  (func $win16_mmsystem (param $ordinal i32) (result i32)
    (local $name i32) (local $flags i32) (local $dev i32) (local $msg i32)
    (local $p1 i32) (local $p2 i32)
    ;; 201 midiOutGetNumDevs() — how many MIDI output devices there are. Chip's
    ;; Challenge asks before it decides whether to play its music.
    (if (i32.eq (local.get $ordinal) (i32.const 201))
      (then
        (call $win16_call32_begin (i32.const 0))
        (call $handle_midiOutGetNumDevs (i32.const 0) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (call $win16_api_return (i32.const 0))
        (return (i32.const 1))))
    ;; 701 mciSendCommand(wDeviceID, wMessage, dwParam1, dwParam2). The two
    ;; dwParams are the same dwords on both sides, and dwParam2 is usually a
    ;; pointer to an MCI parameter block — a far pointer here, flat there.
    (if (i32.eq (local.get $ordinal) (i32.const 701))
      (then
        (local.set $p2 (call $win16_far_to_guest
          (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
        (if (i32.eqz (call $win16_arg16 (i32.const 1))) (then (local.set $p2 (i32.const 0))))
        (local.set $p1 (call $win16_arg32 (i32.const 2)))
        (local.set $msg (call $win16_arg16 (i32.const 4)))
        (local.set $dev (call $win16_arg16 (i32.const 5)))
        (call $win16_call32_begin (i32.const 4))
        (call $handle_mciSendCommandA (local.get $dev) (local.get $msg)
          (local.get $p1) (local.get $p2) (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (global.set $edx (i32.shr_u (global.get $eax) (i32.const 16)))
        (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (call $win16_api_return (i32.const 12))
        (return (i32.const 1))))
    ;; 706 mciGetErrorString(dwError, lpstrBuffer, wLength). Nothing here fails
    ;; an MCI command in a way that has a message, so the buffer comes back
    ;; empty and the call reports FALSE — which is what it reports for an error
    ;; code it does not recognise.
    (if (i32.eq (local.get $ordinal) (i32.const 706))
      (then
        (local.set $p2 (call $win16_far_to_guest
          (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
        (if (call $win16_arg16 (i32.const 2))
          (then (call $gs8 (local.get $p2) (i32.const 0))))
        (global.set $eax (i32.const 0))
        (call $win16_api_return (i32.const 10))
        (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 401))
      (then
        (call $win16_call32_begin (i32.const 0))
        (call $handle_waveOutGetNumDevs (i32.const 0) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (call $win16_api_return (i32.const 0))
        (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 2))
      (then
        (local.set $name (call $win16_far_to_guest
          (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
        (if (i32.eqz (call $win16_arg16 (i32.const 2))) (then (local.set $name (i32.const 0))))
        (local.set $flags (call $win16_arg16 (i32.const 0)))
        (call $win16_call32_begin (i32.const 2))
        (call $handle_sndPlaySoundA (local.get $name) (local.get $flags)
          (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
        (call $win16_call32_end)
        (global.set $eax (i32.ne (global.get $eax) (i32.const 0)))
        (call $win16_api_return (i32.const 6))
        (return (i32.const 1))))
    (i32.const 0))

  ;; KEYBOARD.5 AnsiToOem(lpAnsiStr, lpOemStr) and .6 OemToAnsi. One code page
  ;; here — the OEM and ANSI sets differ only above 0x7F, and nothing in this
  ;; corpus writes those — so both are a copy, which is what the conversion
  ;; comes to when the two encodings agree. AnsiToOem answers nothing;
  ;; OemToAnsi answers TRUE.
  (func $win16_oem_convert (param $to_ansi i32)
    (local $src i32) (local $dst i32) (local $ch i32)
    (local.set $dst (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))))
    (local.set $src (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 3)) (call $win16_arg16 (i32.const 2))))
    (block $done (loop $copy
      (local.set $ch (call $gl8 (local.get $src)))
      (call $gs8 (local.get $dst) (local.get $ch))
      (br_if $done (i32.eqz (local.get $ch)))
      (local.set $src (i32.add (local.get $src) (i32.const 1)))
      (local.set $dst (i32.add (local.get $dst) (i32.const 1)))
      (br $copy)))
    (global.set $eax (select (i32.const 1) (i32.const 0) (local.get $to_ansi)))
    (call $win16_api_return (i32.const 8)))

  (func $win16_keyboard (param $ordinal i32) (result i32)
    (if (i32.eq (local.get $ordinal) (i32.const 5))
      (then (call $win16_oem_convert (i32.const 0)) (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 6))
      (then (call $win16_oem_convert (i32.const 1)) (return (i32.const 1))))
    (i32.const 0))

  ;; SOUND is the Windows 3.0 tone generator — a voice queue driving the PC
  ;; speaker, replaced by MMSYSTEM in 3.1 and gone entirely by Win95. Nothing
  ;; here can play it, and OpenSound has a defined answer for exactly that
  ;; case: a negative result means the device is not available, and every app
  ;; that calls it is required to carry on without sound. That is a real
  ;; answer, not a stubbed success — the alternative is accepting voices and
  ;; then never sounding them, which looks like a broken emulator instead of a
  ;; machine with no speaker. CloseSound is a no-op for the same reason; a
  ;; program that never opened the device still balances its calls.
  (func $win16_sound (param $ordinal i32) (result i32)
    (if (i32.eq (local.get $ordinal) (i32.const 1))       ;; OpenSound
      (then (call $win16_local_identity (i32.const 0) (i32.const 0xFFFF))
            (return (i32.const 1))))
    (if (i32.eq (local.get $ordinal) (i32.const 2))       ;; CloseSound
      (then (call $win16_local_identity (i32.const 0) (i32.const 0)) (return (i32.const 1))))
    (i32.const 0))

  ;; WIN87EM is the 80x87 emulator every Windows 3.x compiler linked against.
  ;; Its job is to stand in for a coprocessor that is not there: its entry
  ;; points patch the caller's own code, and the state they work on is the
  ;; emulator's, not the machine's. There IS a coprocessor here — src/06-fpu.wat
  ;; — and GetWinFlags says so, which is the case the compilers' own code is
  ;; written for: the floating-point instructions in the image are real x87
  ;; instructions until something patches them into emulator calls. So the
  ;; honest answer is to answer for the module and change nothing, rather than
  ;; run its code, which reads a jump table through a selector no descriptor
  ;; here describes and lands in a segment nothing filled — Fuji Golf's third
  ;; call into it stopped that way.
  ;;
  ;; Ordinal 1 is the only entry any of these games imports.
  (func $win16_win87em (param $ordinal i32) (result i32)
    (if (i32.eq (local.get $ordinal) (i32.const 1))
      (then (call $win16_local_identity (i32.const 0) (i32.const 0))
            (return (i32.const 1))))
    (i32.const 0))

  (func $win16_commdlg (param $ordinal i32) (result i32)
    (if (i32.eq (local.get $ordinal) (i32.const 27))
      (then (call $win16_GetFileTitle) (return (i32.const 1))))
    (i32.const 0))

  ;; The dispatcher. $thunk_off is the offset within WIN16_THUNK_SEL that the
  ;; loader wrote into the fixup; $ret_lin is the linear return address, which
  ;; is already on the stack and is passed only so a trap can name it.
  ;; A by-name call into a loaded DLL, for --trace-win16. The name is the only
  ;; thing that identifies it, so it is logged instead of an ordinal.
  (func $win16_trace_call_name (param $module i32) (param $ret_lin i32) (param $name i32)
    (if (global.get $win16_trace)
      (then
        (call $host_log_i32 (i32.const 0xCA16A9EE))
        (call $host_log_i32 (i32.shl (local.get $module) (i32.const 16)))
        (call $host_log_i32 (local.get $ret_lin))
        (call $host_log_i32 (local.get $name)))))

  ;; SHELL, of which the games use exactly one entry — by ordinal here,
  ;; by name in $win16_builtin_by_name. Both spellings occur in the corpus:
  ;; Solitaire and Minesweeper import SHELL.22, FreeCell imports the name.
  (func $win16_shell (param $ordinal i32) (result i32)
    (if (i32.eq (local.get $ordinal) (i32.const 22))
      (then (call $win16_ShellAbout) (return (i32.const 1))))
    (i32.const 0))

  ;; A by-name import of a module this emulator implements. Returns 1 when the
  ;; call was made, 0 to leave it to the caller's trap.
  ;; Name to ordinal for a module this emulator answers for itself. A real DLL
  ;; has an export table GetProcAddress can read; an emulated one has only what
  ;; is written down here — see the MMSYSTEM list in src/01-header.wat.
  ;; Answers 0 for a name it does not know, which is what GetProcAddress
  ;; reports when a module does not export something.
  (global $WIN16_MMSYSTEM_NAMES i32 (i32.const 0x3E40))

  (func $win16_mmsystem_ordinal (param $name i32) (result i32)
    (local $p i32) (local $n i32) (local $i i32)
    (local.set $p (global.get $WIN16_MMSYSTEM_NAMES))
    (block $done (loop $entries
      (local.set $n (i32.load8_u (local.get $p)))
      (br_if $done (i32.eqz (local.get $n)))
      (if (i32.eq (local.get $n) (i32.load8_u (local.get $name)))
        (then
          (local.set $i (i32.const 0))
          ;; Two blocks, not one: running off the end of the name is the match,
          ;; and a differing byte is not, so they cannot share an exit — a
          ;; single block that both branches jump to lands past the answer and
          ;; every name reads as unknown.
          (block $mismatch
            (block $matched
              (loop $chars
                (br_if $matched (i32.ge_u (local.get $i) (local.get $n)))
                (br_if $mismatch (i32.ne
                  (i32.load8_u (i32.add (i32.add (local.get $p) (i32.const 1))
                                        (local.get $i)))
                  (i32.load8_u (i32.add (i32.add (local.get $name) (i32.const 1))
                                        (local.get $i)))))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (br $chars)))
            (return (i32.load16_u (i32.add (i32.add (local.get $p) (i32.const 1))
                                           (local.get $n)))))))
      (local.set $p (i32.add (i32.add (local.get $p) (i32.const 3)) (local.get $n)))
      (br $entries)))
    (i32.const 0))

  (func $win16_builtin_by_name (param $module i32) (param $name i32) (result i32)
    (if (i32.eq (local.get $module) (i32.const 6))
      (then
        (if (call $win16_pstr_eq (local.get $name) (global.get $WIN16_NAME_SHELLABOUT))
          (then (call $win16_ShellAbout) (return (i32.const 1))))))
    (i32.const 0))

  (func $win16_dispatch (export "win16_dispatch") (param $thunk_off i32) (param $ret_lin i32)
    (local $module i32) (local $ordinal i32) (local $target i32)
    (global.set $win16_api_calls (i32.add (global.get $win16_api_calls) (i32.const 1)))
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
      (then (call $win16_cont_resume) (return)))
    ;; The WH_CALLWNDPROC filter CreateWindow ran has returned. The filter took
    ;; its own arguments off the stack; the CWPSTRUCT and CREATESTRUCT built
    ;; underneath them are this side's to drop.
    (if (i32.eq (local.get $thunk_off) (global.get $WIN16_CONT_CWP))
      (then
        (global.set $esp (i32.add (global.get $esp) (global.get $WIN16_CWP_SCRATCH)))
        (call $win16_create_finish)
        (return)))
    ;; The window procedure this emulator supplies, called by an app that
    ;; subclassed one of its windows. It arrives with a window procedure's own
    ;; Pascal frame, which is DefWindowProc's frame.
    (if (i32.eq (local.get $thunk_off) (global.get $WIN16_BUILTIN_WNDPROC))
      (then (call $win16_DefWindowProc) (return)))
    ;; The dialog pump, parked in the same way as the modal one below but
    ;; driving the task's own DLGPROC. It owns its splice, so nothing here.
    (if (i32.eq (local.get $thunk_off) (global.get $WIN16_DLG_PUMP))
      (then (call $win16_dlg_pump) (return)))
    ;; The dialog's own WH_CALLWNDPROC filter has returned; WM_INITDIALOG is
    ;; what it was standing in front of.
    (if (i32.eq (local.get $thunk_off) (global.get $WIN16_DLG_CWP))
      (then (call $win16_dlg_cwp_resume) (return)))
    ;; A LineDDA callback has returned; the next point of the line is owed to it.
    (if (i32.eq (local.get $thunk_off) (global.get $WIN16_DDA_CB))
      (then (call $win16_dda_step) (return)))
    (if (i32.eq (local.get $thunk_off) (global.get $WIN16_ENUMFONT_CB))
      (then (call $win16_ef_step) (return)))
    ;; An NDDEAPI entry point the task took the address of and called.
    (if (i32.eq (local.get $thunk_off) (global.get $WIN16_NDDE_GETWINDOW))
      (then (call $win16_NDdeGetWindow) (return)))
    ;; The modal pump. EIP is parked here, not called here, so there is no
    ;; frame to unwind — the API's own frame went when it parked, and the far
    ;; return it saved is what the completed box goes back to.
    ;; The application has answered an XTYP_CONNECT. Act on it, then finish the
    ;; GetMessage this was taken out of: fill its MSG with the idle message and
    ;; return TRUE, so the task's loop dispatches a harmless WM_NULL and calls
    ;; the pump again. It never learns that its callback ran mid-call.
    (if (i32.eq (local.get $thunk_off) (global.get $WIN16_DDE_CB))
      (then
        (call $win16_dde_ask_finish
          (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (call $zero_memory (call $g2w (global.get $win16_dde_cb_msg)) (i32.const 16))
        (global.set $eax (i32.const 1))
        (call $win16_set_sreg (i32.const 1)
          (i32.shr_u (global.get $win16_dde_cb_ret) (i32.const 16)))
        (global.set $eip (i32.add (global.get $seg_base_cs)
          (i32.and (global.get $win16_dde_cb_ret) (i32.const 0xFFFF))))
        (global.set $steps (i32.const 0))
        (return)))

    ;; A DdeConnect waiting on the room. Each pass drains the wire; when the
    ;; room answers, or has been given enough chances not to, the result is
    ;; already in AX/DX and the far call it was taken out of is spliced back.
    (if (i32.eq (local.get $thunk_off) (global.get $WIN16_DDE_PUMP))
      (then
        (if (call $win16_dde_pump_step) (then (return)))
        (global.set $yield_reason (i32.const 0))
        (call $win16_set_sreg (i32.const 1)
          (i32.shr_u (global.get $win16_dde_ret) (i32.const 16)))
        (global.set $eip (i32.add (global.get $seg_base_cs)
          (i32.and (global.get $win16_dde_ret) (i32.const 0xFFFF))))
        (global.set $steps (i32.const 0))
        (return)))

    (if (i32.eq (local.get $thunk_off) (global.get $WIN16_MODAL_PUMP))
      (then
        (if (call $modal_pump_step
              (i32.add (global.get $seg_base_cs) (global.get $WIN16_MODAL_PUMP)))
          (then (return)))
        (global.set $eax (i32.and (global.get $modal_result) (i32.const 0xFFFF)))
        (global.set $edx (i32.const 0))
        (global.set $yield_reason (i32.const 0))
        (call $win16_set_sreg (i32.const 1)
          (i32.shr_u (global.get $win16_modal_ret) (i32.const 16)))
        (global.set $eip (i32.add (global.get $seg_base_cs)
          (i32.and (global.get $win16_modal_ret) (i32.const 0xFFFF))))
        (global.set $steps (i32.const 0))
        (return)))

    (global.set $win16_last_is_name (call $win16_thunk_is_name (local.get $thunk_off)))

    ;; --trace-win16 logs every call before it runs, with the six words nearest
    ;; the top of the stack. Which of those are arguments depends on the callee,
    ;; so they are printed raw: an unlabelled window into the Pascal frame beats
    ;; a guess at how to label it, and it is what tells LoadBitmap-returned-zero
    ;; apart from LoadBitmap-was-never-asked. Six words covers every API here
    ;; with a fixed argument list — LoadString's five, and one spare to show
    ;; where the frame ends.
    ;; ESP as the task left it, for the stack-delta check in $win16_trace_ret.
    ;; A Pascal callee must leave it exactly its own frame higher, and an API
    ;; that pops the wrong number of bytes is invisible until something returns
    ;; through the damage thousands of instructions later.
    (global.set $win16_entry_esp (global.get $esp))
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
        ;; Twelve words, not six: StretchBlt's Pascal frame is exactly twelve
        ;; and its destination DC is the deepest of them (BitBlt's is ten). A
        ;; trace that stops short shows every card blit without ever saying
        ;; where the card went.
        (call $host_log_i32 (call $win16_arg16 (i32.const 6)))
        (call $host_log_i32 (call $win16_arg16 (i32.const 7)))
        (call $host_log_i32 (call $win16_arg16 (i32.const 8)))
        (call $host_log_i32 (call $win16_arg16 (i32.const 9)))
        (call $host_log_i32 (call $win16_arg16 (i32.const 10)))
        (call $host_log_i32 (call $win16_arg16 (i32.const 11)))
        ;; A name import has a name-table offset where the ordinal would be, so
        ;; a reader of this stream has to be told not to look it up.
        (call $host_log_i32 (global.get $win16_last_is_name))))

    ;; A name import has a name-table offset where an ordinal would be. If the
    ;; exporting module is a DLL we loaded, its export tables answer the
    ;; question and control goes straight there: the far return address is
    ;; already on the stack, so the DLL's own RETF returns to the app and this
    ;; needs no continuation.
    (if (call $win16_thunk_is_name (local.get $thunk_off))
      (then
        (if (call $win16_dll_loaded (local.get $module))
          (then
            (local.set $target (call $win16_dll_entry (local.get $module)
              (call $win16_dll_ordinal (local.get $module)
                (call $win16_thunk_name_addr (local.get $thunk_off)))))
            (if (local.get $target)
              (then
                (call $win16_trace_call_name (local.get $module) (local.get $ret_lin)
                  (call $win16_thunk_name_addr (local.get $thunk_off)))
                (call $win16_set_sreg (i32.const 1)
                  (i32.shr_u (local.get $target) (i32.const 16)))
                (global.set $eip (i32.add (global.get $seg_base_cs)
                  (i32.and (local.get $target) (i32.const 0xFFFF))))
                (global.set $steps (i32.const 0))
                (return)))))
        ;; Not every by-name import names a DLL we loaded. A module this
        ;; emulator supplies itself has no export table to look a name up in,
        ;; so the name is the whole address: FreeCell, Hearts and Minesweeper
        ;; all import SHELL.ShellAbout that way, and nothing else in the corpus
        ;; imports a built-in by name at all. Matching on the name keeps that
        ;; honest — an unrecognised one still falls through to the trap below.
        (if (call $win16_builtin_by_name (local.get $module)
              (call $win16_thunk_name_addr (local.get $thunk_off)))
          (then (call $win16_trace_ret) (return)))
        ;; Say why it could not be resolved: whether the module was loaded at
        ;; all, what ordinal its name tables gave, and where the entry table
        ;; put that ordinal. Those three answer every version of this failure.
        (call $host_log_i32 (i32.const 0xCA16A9F2))
        (call $host_log_i32 (call $win16_api_key (local.get $module) (local.get $ordinal)))
        (call $host_log_i32 (local.get $ret_lin))
        (call $host_log_i32 (call $win16_thunk_name_addr (local.get $thunk_off)))
        (call $host_log_i32 (i32.const 0xCA16DBAD))
        (call $host_log_i32 (call $win16_dll_loaded (local.get $module)))
        (call $host_log_i32 (call $win16_dll_ordinal (local.get $module)
          (call $win16_thunk_name_addr (local.get $thunk_off))))
        (call $host_log_i32 (local.get $target))
        (unreachable)))

    ;; An ordinal import from a loaded DLL resolves the same way, without the
    ;; name lookup.
    (if (call $win16_dll_loaded (local.get $module))
      (then
        (local.set $target (call $win16_dll_entry (local.get $module) (local.get $ordinal)))
        (if (local.get $target)
          (then
            (call $win16_set_sreg (i32.const 1)
              (i32.shr_u (local.get $target) (i32.const 16)))
            (global.set $eip (i32.add (global.get $seg_base_cs)
              (i32.and (local.get $target) (i32.const 0xFFFF))))
            (global.set $steps (i32.const 0))
            (return)))))

    (if (i32.eq (local.get $module) (i32.const 1))
      (then (if (call $win16_kernel (local.get $ordinal))
              (then (call $win16_trace_ret) (return)))))
    (if (i32.eq (local.get $module) (i32.const 2))
      (then (if (call $win16_user (local.get $ordinal))
              (then (call $win16_trace_ret) (return)))))
    (if (i32.eq (local.get $module) (i32.const 3))
      (then (if (call $win16_gdi (local.get $ordinal))
              (then (call $win16_trace_ret) (return)))))
    (if (i32.eq (local.get $module) (i32.const 12))
      (then (if (call $win16_win87em (local.get $ordinal))
              (then (call $win16_trace_ret) (return)))))
    (if (i32.eq (local.get $module) (i32.const 4))
      (then (if (call $win16_keyboard (local.get $ordinal))
              (then (call $win16_trace_ret) (return)))))
    (if (i32.eq (local.get $module) (i32.const 5))
      (then (if (call $win16_sound (local.get $ordinal))
              (then (call $win16_trace_ret) (return)))))
    (if (i32.eq (local.get $module) (i32.const 6))
      (then (if (call $win16_shell (local.get $ordinal))
              (then (call $win16_trace_ret) (return)))))
    (if (i32.eq (local.get $module) (i32.const 7))
      (then (if (call $win16_mmsystem (local.get $ordinal))
              (then (call $win16_trace_ret) (return)))))
    (if (i32.eq (local.get $module) (i32.const 10))
      (then (if (call $win16_ddeml (local.get $ordinal))
              (then (call $win16_trace_ret) (return)))))
    (if (i32.eq (local.get $module) (i32.const 8))
      (then (if (call $win16_commdlg (local.get $ordinal))
              (then (call $win16_trace_ret) (return)))))

    ;; Anything not implemented reports itself and stops, on the same reasoning
    ;; as the 32-bit fail-fast stubs. The three logs are the marker, the packed
    ;; module/ordinal, and where the call came from — test/run.js turns them
    ;; into a name, so the next API to write is the one the crash prints.
    (call $host_log_i32 (i32.const 0xCA16A9F1))
    (call $host_log_i32 (call $win16_api_key (local.get $module) (local.get $ordinal)))
    (call $host_log_i32 (local.get $ret_lin))
    (unreachable))

  ;; Is the task parked on one of the continuation slots a modal pump waits at?
  ;;
  ;; A MessageBox or a modal dialog with nothing to do sits at its slot with
  ;; every register unchanged, which is indistinguishable from a hang by the
  ;; only test a harness can apply from outside — and test/run.js called it one,
  ;; so a perfectly healthy dialog left waiting for the next click reported
  ;; STUCK and exited non-zero. Waiting here is the defined behaviour of these
  ;; two addresses, so say so rather than have the harness guess from EIP.
  (func (export "win16_pump_parked") (result i32)
    (local $off i32)
    (if (i32.lt_u (global.get $eip) (global.get $seg_base_cs))
      (then (return (i32.const 0))))
    (local.set $off (i32.sub (global.get $eip) (global.get $seg_base_cs)))
    (i32.or (i32.eq (local.get $off) (global.get $WIN16_DDE_PUMP))
      (i32.or (i32.eq (local.get $off) (global.get $WIN16_MODAL_PUMP))
              (i32.eq (local.get $off) (global.get $WIN16_DLG_PUMP)))))

  ;; How many Win16 API calls this task has made. It is a liveness signal, not
  ;; a statistic: a harness watching a 16-bit task has only EIP and the
  ;; registers to judge progress by, and both can read identical at two batch
  ;; boundaries of a perfectly healthy message loop. test/run.js's own API
  ;; counter never moves for these tasks — it counts the 32-bit dispatch path,
  ;; which is why every Win16 run reports "0 API calls" — so an idle
  ;; Minesweeper was indistinguishable from a wedged one and got reported STUCK.
  (global $win16_api_calls (mut i32) (i32.const 0))
  (func (export "win16_api_count") (result i32) (global.get $win16_api_calls))

  (func (export "set_win16_trace") (param $on i32) (global.set $win16_trace (local.get $on)))
  ;; The DDE offers and answers on their own, without the API call/return and
  ;; message-pump lines around them. Those are hundreds of megabytes on a run
  ;; of any length, and they are also SLOW ENOUGH TO CHANGE THE ANSWER: two
  ;; emulators in one room race each other, and a race that only appears when
  ;; the trace is off cannot be read with the trace on.
  (func (export "set_win16_dde_trace") (param $on i32)
    (global.set $win16_dde_trace (local.get $on)))
  (func (export "win16_last_module") (result i32) (global.get $win16_last_module))
  (func (export "win16_last_ordinal") (result i32) (global.get $win16_last_ordinal))
  (func (export "win16_last_is_name") (result i32) (global.get $win16_last_is_name))
  (func (export "win16_res_len") (result i32) (global.get $win16_res_len))
