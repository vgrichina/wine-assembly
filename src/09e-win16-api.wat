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

  (func $win16_user (param $ordinal i32) (result i32)
    (if (i32.eq (local.get $ordinal) (i32.const 5))
      (then (call $win16_InitApp) (return (i32.const 1))))
    (i32.const 0))

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
      (then (if (call $win16_kernel (local.get $ordinal)) (then (return)))))
    (if (i32.eq (local.get $module) (i32.const 2))
      (then (if (call $win16_user (local.get $ordinal)) (then (return)))))

    ;; Anything not implemented reports itself and stops, on the same reasoning
    ;; as the 32-bit fail-fast stubs. The three logs are the marker, the packed
    ;; module/ordinal, and where the call came from — test/run.js turns them
    ;; into a name, so the next API to write is the one the crash prints.
    (call $host_log_i32 (i32.const 0xCA16A9F1))
    (call $host_log_i32 (call $win16_api_key (local.get $module) (local.get $ordinal)))
    (call $host_log_i32 (local.get $ret_lin))
    (unreachable))

  (func (export "win16_last_module") (result i32) (global.get $win16_last_module))
  (func (export "win16_last_ordinal") (result i32) (global.get $win16_last_ordinal))
  (func (export "win16_last_is_name") (result i32) (global.get $win16_last_is_name))
