  ;; ============================================================
  ;; WIN32 API DISPATCH
  ;; ============================================================
  (func $win32_dispatch (param $thunk_idx i32)
    (local $name_rva i32) (local $name_ptr i32)
    (local $arg0 i32) (local $arg1 i32) (local $arg2 i32) (local $arg3 i32)
    (local $arg4 i32)
    (local $w0 i32) (local $w1 i32) (local $w2 i32)
    (local $msg_ptr i32) (local $tmp i32) (local $packed i32)
    (local $i i32) (local $j i32) (local $v i32)

    ;; Read name RVA from thunk data (stored at WASM addr THUNK_BASE + idx*8)
    (local.set $name_rva (i32.load (i32.add (global.get $THUNK_BASE) (i32.mul (local.get $thunk_idx) (i32.const 8)))))

    ;; Catch-return thunk: catch funclet returned, EAX = continuation address
    (if (i32.eq (local.get $name_rva) (i32.const 0xCACA0000))
      (then
        ;; Pop return address (already consumed by RET that brought us here)
        ;; ESP was already adjusted by the RET. EAX has the continuation addr.
        (global.set $eip (global.get $eax))
        (return)))

    (local.set $name_ptr (i32.add (global.get $GUEST_BASE) (i32.add (local.get $name_rva) (i32.const 2))))

    (local.set $arg0 (call $gl32 (i32.add (global.get $esp) (i32.const 4))))
    (local.set $arg1 (call $gl32 (i32.add (global.get $esp) (i32.const 8))))
    (local.set $arg2 (call $gl32 (i32.add (global.get $esp) (i32.const 12))))
    (local.set $arg3 (call $gl32 (i32.add (global.get $esp) (i32.const 16))))
    (local.set $arg4 (call $gl32 (i32.add (global.get $esp) (i32.const 20))))

    ;; Read first 12 bytes of name for matching
    (local.set $w0 (i32.load (local.get $name_ptr)))
    (local.set $w1 (i32.load (i32.add (local.get $name_ptr) (i32.const 4))))
    (local.set $w2 (i32.load (i32.add (local.get $name_ptr) (i32.const 8))))

    ;; Log API name for trace
    (call $host_log (local.get $name_ptr) (i32.const 32))

    ;; ================================================================
    ;; KERNEL32
    ;; ================================================================

    ;; ExitProcess(1) "Exit"=0x74697845
    (if (i32.eq (local.get $w0) (i32.const 0x74697845))
      (then (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
            (call $host_exit (local.get $arg0)) (global.set $eip (i32.const 0)) (global.set $steps (i32.const 0)) (return)))

    ;; GetModuleHandleA(1) "GetM"+"odul"+"eHan" — must NOT match GetModuleFileNameA
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x4D746547)) (i32.eq (local.get $w1) (i32.const 0x6C75646F)))
                 (i32.eq (local.get $w2) (i32.const 0x6E614865))) ;; "eHan"
      (then (global.set $eax (global.get $image_base))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetCommandLineA(0) "GetC"+"omma"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x43746547)) (i32.eq (local.get $w1) (i32.const 0x616D6D6F)))
      (then (call $store_fake_cmdline) (global.set $eax (global.get $fake_cmdline_addr))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; GetStartupInfoA(1) "GetS"+"tart"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x53746547)) (i32.eq (local.get $w1) (i32.const 0x74726174)))
      (then (call $zero_memory (call $g2w (local.get $arg0)) (i32.const 68))
            (call $gs32 (local.get $arg0) (i32.const 68))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetProcAddress(2) "GetP"+"rocA"
    ;; arg0=hModule, arg1=lpProcName → create a thunk for the requested function
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x50746547)) (i32.eq (local.get $w1) (i32.const 0x41636F72)))
      (then
        (block $gpa
          ;; If lpProcName is an ordinal (< 0x10000), return 0 (unsupported)
          (br_if $gpa (i32.lt_u (local.get $arg1) (i32.const 0x10000)))
          ;; Allocate hint(2) + name in guest heap
          (local.set $tmp (call $guest_strlen (local.get $arg1)))
          (local.set $v (call $heap_alloc (i32.add (local.get $tmp) (i32.const 3)))) ;; 2 hint + name + NUL
          ;; Write hint = 0
          (i32.store16 (call $g2w (local.get $v)) (i32.const 0))
          ;; Copy name string
          (call $memcpy (i32.add (call $g2w (local.get $v)) (i32.const 2))
                        (call $g2w (local.get $arg1)) (i32.add (local.get $tmp) (i32.const 1)))
          ;; Create thunk: store RVA (guest_ptr - image_base) at THUNK_BASE + num_thunks*8
          (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
            (i32.sub (local.get $v) (global.get $image_base)))
          ;; Compute guest address of this thunk
          (global.set $eax (i32.add
            (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
                     (global.get $GUEST_BASE))
            (global.get $image_base)))
          (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; GetLastError(0) "GetL"+"astE"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x4C746547)) (i32.eq (local.get $w1) (i32.const 0x45747361)))
      (then (global.set $eax (global.get $last_error))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; GetLocalTime(1) "GetL"+"ocal" + 'T' at pos 8
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x4C746547)) (i32.eq (local.get $w1) (i32.const 0x6C61636F)))
                 (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 8))) (i32.const 0x54))) ;; 'T'
      (then (call $zero_memory (call $g2w (local.get $arg0)) (i32.const 16))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetTimeFormatA(6) "GetT"+"imeF"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x54746547)) (i32.eq (local.get $w1) (i32.const 0x46656D69)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))

    ;; GetDateFormatA(6) "GetD"+"ateF"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x44746547)) (i32.eq (local.get $w1) (i32.const 0x46657461)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))

    ;; GetProfileStringA(5) "GetP"+"rofi" + char10='S'
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x50746547)) (i32.eq (local.get $w1) (i32.const 0x69666F72)))
                 (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 10))) (i32.const 0x53)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; GetProfileIntA(3) "GetP"+"rofi" + char10='I' — return 0
    ;; Return 0 so calc starts in standard mode (10 digits). Default=1 would mean scientific (32 digits).
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x50746547)) (i32.eq (local.get $w1) (i32.const 0x69666F72)))
                 (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 10))) (i32.const 0x49)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; GetLocaleInfoA(4) "GetL"+"ocal"+"eInf"
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x4C746547)) (i32.eq (local.get $w1) (i32.const 0x6C61636F)))
                 (i32.eq (local.get $w2) (i32.const 0x666E4965)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; LoadLibraryA(1) "Load"+"Libr"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x64616F4C)) (i32.eq (local.get $w1) (i32.const 0x7262694C)))
      (then (global.set $eax (i32.const 0x7FFE0000))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; DeleteFileA(1) "Dele"+"teFi"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x656C6544)) (i32.eq (local.get $w1) (i32.const 0x69466574)))
      (then (global.set $eax (i32.const 0)) (global.set $last_error (i32.const 2))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CreateFileA(7) "Crea"+"teFi"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x69466574)))
      (then (global.set $eax (i32.const 0xFFFFFFFF))
            (global.set $esp (i32.add (global.get $esp) (i32.const 32))) (return)))

    ;; FindFirstFileA(2) "Find"+"Firs"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x646E6946)) (i32.eq (local.get $w1) (i32.const 0x73726946)))
      (then (global.set $eax (i32.const 0xFFFFFFFF))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; FindClose(1) "Find"+"Clos"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x646E6946)) (i32.eq (local.get $w1) (i32.const 0x736F6C43)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; MulDiv(3) "MulD"
    (if (i32.eq (local.get $w0) (i32.const 0x446C754D))
      (then
        (if (i32.eqz (local.get $arg2))
          (then (global.set $eax (i32.const -1)))
          (else (global.set $eax (i32.wrap_i64 (i64.div_s
                  (i64.mul (i64.extend_i32_s (local.get $arg0)) (i64.extend_i32_s (local.get $arg1)))
                  (i64.extend_i32_s (local.get $arg2)))))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; RtlMoveMemory(3) "RtlM"
    (if (i32.eq (local.get $w0) (i32.const 0x4D6C7452))
      (then (call $memcpy (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (local.get $arg2))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; _lcreat(2) "_lcr"
    (if (i32.eq (local.get $w0) (i32.const 0x72636C5F))
      (then (global.set $eax (i32.const 0xFFFFFFFF))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    ;; _lopen(2) "_lop"
    (if (i32.eq (local.get $w0) (i32.const 0x706F6C5F))
      (then (global.set $eax (i32.const 0xFFFFFFFF))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    ;; _lwrite(3) "_lwr"
    (if (i32.eq (local.get $w0) (i32.const 0x72776C5F))
      (then (global.set $eax (i32.const 0xFFFFFFFF))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    ;; _llseek(3) "_lls"
    (if (i32.eq (local.get $w0) (i32.const 0x736C6C5F))
      (then (global.set $eax (i32.const 0xFFFFFFFF))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    ;; _lclose(1) "_lcl"
    (if (i32.eq (local.get $w0) (i32.const 0x6C636C5F))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    ;; _lread(3) "_lre"
    (if (i32.eq (local.get $w0) (i32.const 0x65726C5F))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; Sleep(1) "Slee"=0x65656C53
    (if (i32.eq (local.get $w0) (i32.const 0x65656C53))
      (then (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CloseHandle(1) "Clos"+"eHan"=0x6E614865
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x736F6C43)) (i32.eq (local.get $w1) (i32.const 0x6E614865)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CreateEventA(4) "Crea"+"teEv"=0x76456574
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x76456574)))
      (then (global.set $eax (i32.const 0x70001)) ;; fake event handle
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; CreateThread(6) "Crea"+"teTh"=0x68546574
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x68546574)))
      (then (global.set $eax (i32.const 0x70002)) ;; fake thread handle
            (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))

    ;; WaitForSingleObject(2) "Wait"=0x74696157
    (if (i32.eq (local.get $w0) (i32.const 0x74696157))
      (then (global.set $eax (i32.const 0)) ;; WAIT_OBJECT_0
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; ResetEvent(1) "Rese"=0x65736552
    (if (i32.eq (local.get $w0) (i32.const 0x65736552))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; SetEvent(1) "SetE"+"vent"=0x746E6576
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x45746553)) (i32.eq (local.get $w1) (i32.const 0x746E6576)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; WriteProfileStringA(3) "Writ"=0x74697257
    (if (i32.eq (local.get $w0) (i32.const 0x74697257))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; Local* / Global* — memory management
    (if (i32.eq (local.get $w0) (i32.const 0x61636F4C)) ;; "Loca"
      (then (call $dispatch_local (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2)) (return)))
    (if (i32.eq (local.get $w0) (i32.const 0x626F6C47)) ;; "Glob"
      (then (call $dispatch_global (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2)) (return)))

    ;; lstr* — string functions
    (if (i32.eq (local.get $w0) (i32.const 0x7274736C)) ;; "lstr"
      (then (call $dispatch_lstr (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2)) (return)))

    ;; HeapCreate(3) "Heap"+"Crea" — return fake heap handle (use existing allocator)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x70616548)) (i32.eq (local.get $w1) (i32.const 0x61657243)))
      (then (global.set $eax (i32.const 0x00080000)) ;; fake heap handle
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; HeapDestroy(1) "Heap"+"Dest"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x70616548)) (i32.eq (local.get $w1) (i32.const 0x74736544)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; HeapAlloc(3) "Heap"+"Allo" — allocate from bump allocator
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x70616548)) (i32.eq (local.get $w1) (i32.const 0x6F6C6C41)))
      (then (global.set $eax (call $heap_alloc (local.get $arg2)))
            ;; Zero memory if HEAP_ZERO_MEMORY (0x08)
            (if (i32.and (local.get $arg1) (i32.const 0x08))
              (then (call $zero_memory (call $g2w (global.get $eax)) (local.get $arg2))))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; HeapFree(3) "Heap"+"Free"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x70616548)) (i32.eq (local.get $w1) (i32.const 0x65657246)))
      (then (call $heap_free (local.get $arg2))
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; HeapReAlloc(4) "Heap"+"ReAl" — simple: alloc new, copy, free old
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x70616548)) (i32.eq (local.get $w1) (i32.const 0x6C416552)))
      (then
        (local.set $tmp (call $heap_alloc (local.get $arg3)))
        (if (local.get $tmp)
          (then
            (if (local.get $arg2) ;; old ptr
              (then (call $memcpy (call $g2w (local.get $tmp)) (call $g2w (local.get $arg2)) (local.get $arg3))
                    (call $heap_free (local.get $arg2))))))
        (global.set $eax (local.get $tmp))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; VirtualAlloc(4) "Virt"+"ualA"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x74726956)) (i32.eq (local.get $w1) (i32.const 0x416C6175)))
      (then
        (if (local.get $arg0)
          (then (global.set $eax (local.get $arg0))) ;; requested address, just return it
          (else (global.set $eax (call $heap_alloc (local.get $arg1)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; VirtualFree(3) "Virt"+"ualF"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x74726956)) (i32.eq (local.get $w1) (i32.const 0x466C6175)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; GetACP(0) "GetA"+"CP\0\0" — return 1252 (Windows-1252)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x41746547))
                 (i32.eq (i32.load16_u (i32.add (local.get $name_ptr) (i32.const 4))) (i32.const 0x5043))) ;; "CP"
      (then (global.set $eax (i32.const 1252))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; GetOEMCP(0) "GetO"+"EMCP"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x4F746547)) (i32.eq (local.get $w1) (i32.const 0x50434D45)))
      (then (global.set $eax (i32.const 437))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; GetCPInfo(2) "GetC"+"PInf"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x43746547)) (i32.eq (local.get $w1) (i32.const 0x666E4950)))
      (then
        ;; CPINFO struct: MaxCharSize(4), DefaultChar[2](2), LeadByte[12](12)
        (call $zero_memory (call $g2w (local.get $arg1)) (i32.const 18))
        (call $gs32 (local.get $arg1) (i32.const 1)) ;; MaxCharSize = 1 (single-byte)
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; MultiByteToWideChar(6) "Mult"+"iByt"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x746C754D)) (i32.eq (local.get $w1) (i32.const 0x74794269)))
      (then
        ;; Simple: copy each byte to 16-bit. arg2=src, arg3=srcLen, arg4=dst, [esp+24]=dstLen
        (local.set $v (call $gl32 (i32.add (global.get $esp) (i32.const 24)))) ;; arg5: dstLen
        (if (i32.eq (local.get $arg3) (i32.const -1)) ;; srcLen=-1 means NUL-terminated
          (then (local.set $arg3 (i32.add (call $strlen (call $g2w (local.get $arg2))) (i32.const 1)))))
        (if (i32.eqz (local.get $arg4)) ;; query required size
          (then (global.set $eax (local.get $arg3)))
          (else
            (local.set $i (i32.const 0))
            (block $done (loop $lp
              (br_if $done (i32.ge_u (local.get $i) (local.get $arg3)))
              (br_if $done (i32.ge_u (local.get $i) (local.get $v)))
              (i32.store16 (i32.add (call $g2w (local.get $arg4)) (i32.shl (local.get $i) (i32.const 1)))
                           (i32.load8_u (i32.add (call $g2w (local.get $arg2)) (local.get $i))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $lp)))
            (global.set $eax (local.get $i))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))

    ;; WideCharToMultiByte(8) "Wide"+"Char"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x65646957)) (i32.eq (local.get $w1) (i32.const 0x72616843)))
      (then
        ;; Simple: copy low byte of each 16-bit char. arg2=src, arg3=srcLen, arg4=dst, [esp+24]=dstLen
        (local.set $v (call $gl32 (i32.add (global.get $esp) (i32.const 24)))) ;; arg5: dstLen
        (if (i32.eq (local.get $arg3) (i32.const -1))
          (then
            ;; Count wide string length
            (local.set $arg3 (i32.const 0))
            (block $d2 (loop $l2
              (br_if $d2 (i32.eqz (i32.load16_u (i32.add (call $g2w (local.get $arg2)) (i32.shl (local.get $arg3) (i32.const 1))))))
              (local.set $arg3 (i32.add (local.get $arg3) (i32.const 1)))
              (br $l2)))
            (local.set $arg3 (i32.add (local.get $arg3) (i32.const 1)))))
        (if (i32.eqz (local.get $arg4))
          (then (global.set $eax (local.get $arg3)))
          (else
            (local.set $i (i32.const 0))
            (block $done (loop $lp
              (br_if $done (i32.ge_u (local.get $i) (local.get $arg3)))
              (br_if $done (i32.ge_u (local.get $i) (local.get $v)))
              (i32.store8 (i32.add (call $g2w (local.get $arg4)) (local.get $i))
                          (i32.load8_u (i32.add (call $g2w (local.get $arg2)) (i32.shl (local.get $i) (i32.const 1)))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $lp)))
            (global.set $eax (local.get $i))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 36))) (return)))

    ;; GetStringTypeA(5) "GetS"+"trin"+"gTyp" + byte13='A'
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x53746547)) (i32.eq (local.get $w1) (i32.const 0x6E697274)))
                 (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 13))) (i32.const 0x41)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; GetStringTypeW(4) "GetS"+"trin"+"gTyp" + byte13='W'
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x53746547)) (i32.eq (local.get $w1) (i32.const 0x6E697274)))
                 (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 13))) (i32.const 0x57)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; LCMapStringA(6) "LCMa"
    (if (i32.eq (local.get $w0) (i32.const 0x614D434C))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))
    ;; LCMapStringW(6) "LCMa" — same first 4 bytes, disambiguate by byte 10
    ;; Actually both have same w0, the above handles both since they share arg count

    ;; GetStdHandle(1) "GetS"+"tdHa"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x53746547)) (i32.eq (local.get $w1) (i32.const 0x61486474)))
      (then
        ;; STD_INPUT=0xFFFFFFF6(-10), STD_OUTPUT=0xFFFFFFF5(-11), STD_ERROR=0xFFFFFFF4(-12)
        (global.set $eax (i32.add (i32.const 0x40000) (i32.and (local.get $arg0) (i32.const 0xFF))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetFileType(1) "GetF"+"ileT"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x46746547)) (i32.eq (local.get $w1) (i32.const 0x54656C69)))
      (then (global.set $eax (i32.const 2)) ;; FILE_TYPE_CHAR
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; WriteFile(5) "Writ"+"eFil"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x74697257)) (i32.eq (local.get $w1) (i32.const 0x6C694665)))
      (then
        ;; Write number of bytes written to arg2 (lpNumberOfBytesWritten)
        (if (local.get $arg2)
          (then (call $gs32 (local.get $arg2) (local.get $arg1))))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; SetHandleCount(1) "SetH"+"andl" — legacy, return argument
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x48746553)) (i32.eq (local.get $w1) (i32.const 0x6C646E61)))
      (then (global.set $eax (local.get $arg0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetEnvironmentStrings(0) "GetE"+"nvir"+"onme" — return pointer to empty env block
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x45746547)) (i32.eq (local.get $w1) (i32.const 0x7269766E)))
      (then
        ;; Allocate a small block with double-NUL terminator
        (local.set $tmp (call $heap_alloc (i32.const 4)))
        (call $gs32 (local.get $tmp) (i32.const 0))
        (global.set $eax (local.get $tmp))
        ;; GetEnvironmentStrings(0) vs GetEnvironmentStringsW(0) — both pop 4
        (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; FreeEnvironmentStringsA/W(1) "Free"+"Envi"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x65657246)) (i32.eq (local.get $w1) (i32.const 0x69766E45)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetModuleFileNameA(3) "GetM"+"odul"+"eFil"
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x4D746547)) (i32.eq (local.get $w1) (i32.const 0x6C75646F)))
                 (i32.eq (local.get $w2) (i32.const 0x6C694665)))
      (then
        ;; Write "C:\\app.exe" to buffer
        (i32.store (call $g2w (local.get $arg1)) (i32.const 0x615C3A43)) ;; "C:\a"
        (i32.store (i32.add (call $g2w (local.get $arg1)) (i32.const 4)) (i32.const 0x652E7070)) ;; "pp.e"
        (i32.store16 (i32.add (call $g2w (local.get $arg1)) (i32.const 8)) (i32.const 0x6578)) ;; "xe"
        (i32.store8 (i32.add (call $g2w (local.get $arg1)) (i32.const 10)) (i32.const 0))
        (global.set $eax (i32.const 10))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; UnhandledExceptionFilter(1) "Unha"
    (if (i32.eq (local.get $w0) (i32.const 0x61686E55))
      (then (global.set $eax (i32.const 0)) ;; EXCEPTION_EXECUTE_HANDLER
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetCurrentProcess(0) "GetC"+"urre"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x43746547)) (i32.eq (local.get $w1) (i32.const 0x65727275)))
      (then (global.set $eax (i32.const 0xFFFFFFFF)) ;; pseudo-handle
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; TerminateProcess(2) "Term"
    (if (i32.eq (local.get $w0) (i32.const 0x6D726554))
      (then (call $host_exit (local.get $arg1)) (global.set $eip (i32.const 0)) (global.set $steps (i32.const 0)) (return)))

    ;; GetTickCount(0) "GetT"+"ickC"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x54746547)) (i32.eq (local.get $w1) (i32.const 0x436B6369)))
      (then (global.set $eax (i32.const 100000)) ;; fake tick count
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; FindResourceA(3) "Find"+"Reso"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x646E6946)) (i32.eq (local.get $w1) (i32.const 0x6F736552)))
      (then (global.set $eax (i32.const 0x90001)) ;; fake resource handle
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; LoadResource(2) "Load"+"Reso"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x64616F4C)) (i32.eq (local.get $w1) (i32.const 0x6F736552)))
      (then (global.set $eax (i32.const 0x90002)) ;; fake global handle
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; LockResource(1) "Lock"
    (if (i32.eq (local.get $w0) (i32.const 0x6B636F4C))
      (then (global.set $eax (local.get $arg0)) ;; return the handle as pointer
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; FreeResource(1) "Free"+"Reso"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x65657246)) (i32.eq (local.get $w1) (i32.const 0x6F736552)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; RtlUnwind(4) "RtlU"
    ;; args: TargetFrame, TargetIp, ExceptionRecord, ReturnValue
    ;; Unwind SEH chain to TargetFrame, set FS:[0] = frame->next, EAX = ReturnValue
    (if (i32.eq (local.get $w0) (i32.const 0x556C7452))
      (then
        ;; Unlink SEH chain: set FS:[0] = TargetFrame->next
        (if (i32.ne (local.get $arg0) (i32.const 0))
          (then (call $gs32 (global.get $fs_base) (call $gl32 (local.get $arg0)))))
        (global.set $eax (local.get $arg3)) ;; ReturnValue
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; FreeLibrary(1) "Free"+"Libr"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x65657246)) (i32.eq (local.get $w1) (i32.const 0x7262694C)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; sndPlaySoundA(2) "sndP"
    (if (i32.eq (local.get $w0) (i32.const 0x50646E73))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; ================================================================
    ;; USER32
    ;; ================================================================

    ;; RegisterClassA / RegisterClassExA(1) "Regi"+"ster"+"Clas"
    ;; Distinguish by byte 13: 'E' (0x45) = ExA (WNDCLASSEX, wndproc at +8), 'A' (0x41) = A (WNDCLASSA, wndproc at +4)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x69676552)) (i32.eq (local.get $w2) (i32.const 0x73616C43)))
      (then
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 13))) (i32.const 0x45)) ;; 'E' = ExA
          (then ;; WNDCLASSEX: lpfnWndProc at +8
            (local.set $tmp (call $gl32 (i32.add (local.get $arg0) (i32.const 8)))))
          (else ;; WNDCLASSA: lpfnWndProc at +4
            (local.set $tmp (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))))
        ;; Store first wndproc as main, subsequent as child
        (if (i32.eqz (global.get $wndproc_addr))
          (then (global.set $wndproc_addr (local.get $tmp)))
          (else (global.set $wndproc_addr2 (local.get $tmp))))
        (global.set $eax (i32.const 0xC001))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; RegisterWindowMessageA(1) "Regi"+"ster"+"Wind"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x69676552)) (i32.eq (local.get $w2) (i32.const 0x646E6957)))
      (then (global.set $eax (i32.const 0xC100))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CreateWindowExA(12) "Crea"+"teWi"
    ;; Args: exStyle(+4), className(+8), windowName(+12), style(+16), x(+20), y(+24), w(+28), h(+32), parent(+36), menu(+40)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x69576574)))
      (then
        ;; Auto-detect WndProc: scan code for WNDCLASSA setup referencing this className
        ;; Pattern: C7 44 24 XX [className] — the mov before it has the WndProc
        (if (i32.eqz (global.get $wndproc_addr))
          (then
            (local.set $i (global.get $GUEST_BASE))
            (local.set $v (i32.add (global.get $GUEST_BASE) (i32.const 0xA000)))
            (block $found (loop $scan
              (br_if $found (i32.ge_u (local.get $i) (local.get $v)))
              (if (i32.and
                    (i32.eq (i32.load8_u (local.get $i)) (i32.const 0xC7))
                    (i32.and
                      (i32.eq (i32.load8_u (i32.add (local.get $i) (i32.const 1))) (i32.const 0x44))
                      (i32.eq (i32.load8_u (i32.add (local.get $i) (i32.const 2))) (i32.const 0x24))))
                (then
                  (if (i32.eq (i32.load (i32.add (local.get $i) (i32.const 4))) (local.get $arg1))
                    (then
                      (if (i32.and
                            (i32.eq (i32.load8_u (i32.sub (local.get $i) (i32.const 8))) (i32.const 0xC7))
                            (i32.eq (i32.load8_u (i32.sub (local.get $i) (i32.const 7))) (i32.const 0x44)))
                        (then
                          (local.set $tmp (i32.load (i32.sub (local.get $i) (i32.const 4))))
                          (if (i32.and (i32.ge_u (local.get $tmp) (global.get $image_base))
                                       (i32.lt_u (local.get $tmp) (i32.add (global.get $image_base) (i32.const 0x80000))))
                            (then
                              (global.set $wndproc_addr (local.get $tmp))
                              (br $found)))))))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $scan)))))
        ;; Set second wndproc for subsequent windows
        (if (i32.and (global.get $wndproc_addr) (i32.eqz (global.get $wndproc_addr2)))
          (then
            (if (global.get $main_hwnd)  ;; not the first window
              (then
                ;; Scan for second WndProc using same pattern
                (local.set $i (global.get $GUEST_BASE))
                (local.set $v (i32.add (global.get $GUEST_BASE) (i32.const 0xA000)))
                (block $found2 (loop $scan2
                  (br_if $found2 (i32.ge_u (local.get $i) (local.get $v)))
                  (if (i32.and
                        (i32.eq (i32.load8_u (local.get $i)) (i32.const 0xC7))
                        (i32.and
                          (i32.eq (i32.load8_u (i32.add (local.get $i) (i32.const 1))) (i32.const 0x44))
                          (i32.eq (i32.load8_u (i32.add (local.get $i) (i32.const 2))) (i32.const 0x24))))
                    (then
                      (if (i32.eq (i32.load (i32.add (local.get $i) (i32.const 4))) (local.get $arg1))
                        (then
                          (if (i32.and
                                (i32.eq (i32.load8_u (i32.sub (local.get $i) (i32.const 8))) (i32.const 0xC7))
                                (i32.eq (i32.load8_u (i32.sub (local.get $i) (i32.const 7))) (i32.const 0x44)))
                            (then
                              (local.set $tmp (i32.load (i32.sub (local.get $i) (i32.const 4))))
                              (if (i32.and (i32.ge_u (local.get $tmp) (global.get $image_base))
                                           (i32.lt_u (local.get $tmp) (i32.add (global.get $image_base) (i32.const 0x80000))))
                                (then
                                  (global.set $wndproc_addr2 (local.get $tmp))
                                  (br $found2)))))))))
                  (local.set $i (i32.add (local.get $i) (i32.const 1)))
                  (br $scan2)))))))
        ;; Allocate HWND; first top-level window becomes main_hwnd
        (if (i32.eqz (global.get $main_hwnd))
          (then (global.set $main_hwnd (global.get $next_hwnd))))
        ;; Call host: create_window(hwnd, style, x, y, cx, cy, title_ptr, menu_id)
        (drop (call $host_create_window
          (global.get $next_hwnd)                                    ;; hwnd
          (local.get $arg3)                                           ;; style
          (local.get $arg4)                                           ;; x
          (call $gl32 (i32.add (global.get $esp) (i32.const 24)))    ;; y
          (call $gl32 (i32.add (global.get $esp) (i32.const 28)))    ;; cx
          (call $gl32 (i32.add (global.get $esp) (i32.const 32)))    ;; cy
          (call $g2w (local.get $arg2))                               ;; title_ptr (WASM ptr)
          (call $gl32 (i32.add (global.get $esp) (i32.const 40)))    ;; menu (resource ID or HMENU)
        ))
        ;; Pass className to host so it knows the window type (e.g. "Edit")
        (call $host_set_window_class (global.get $next_hwnd) (call $g2w (local.get $arg1)))
        ;; Flag to deliver WM_CREATE + WM_SIZE as first messages in GetMessageA
        (if (i32.eq (global.get $next_hwnd) (global.get $main_hwnd))
          (then
            (global.set $pending_wm_create (i32.const 1))
            ;; Store window outer dimensions; compute client area (subtract borders+titlebar+menu)
            (global.set $main_win_cx (call $gl32 (i32.add (global.get $esp) (i32.const 28))))
            (global.set $main_win_cy (call $gl32 (i32.add (global.get $esp) (i32.const 32))))
            ;; Client = outer - borders(6) - caption(19) - menu(20) approximately
            (global.set $pending_wm_size (i32.or
              (i32.and (i32.sub (global.get $main_win_cx) (i32.const 6)) (i32.const 0xFFFF))
              (i32.shl (i32.sub (global.get $main_win_cy) (i32.const 45)) (i32.const 16))))))
        (global.set $eax (global.get $next_hwnd))
        (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 52))) (return)))

    ;; CreateDialogParamA(5) "Crea"+"teDi"
    ;; Args: hInstance(+4), templateName(+8), hWndParent(+12), dlgProc(+16), initParam(+20)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x69446574)))
      (then
        ;; Save dialog hwnd for IsChild/SendMessage routing
        (global.set $dlg_hwnd (i32.const 0x10002))
        ;; Clear quit_flag — dialog recreation (e.g. calc mode switch) cancels pending quit
        (global.set $quit_flag (i32.const 0))
        ;; Call host: create_dialog(hwnd, dlg_resource_id)
        (global.set $eax (call $host_create_dialog
          (i32.const 0x10002)    ;; hwnd for dialog
          (local.get $arg1)))    ;; template name/ID
        (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; MessageBoxA(4) "Mess"
    (if (i32.eq (local.get $w0) (i32.const 0x7373654D))
      (then
        ;; Disambiguate MessageBoxA vs MessageBeep
        (if (i32.eq (local.get $w1) (i32.const 0x42656761)) ;; "ageB" — MessageB...
          (then
            (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 8))) (i32.const 0x65)) ;; "e" — MessageBe(ep)
              (then ;; MessageBeep(1)
                (global.set $eax (i32.const 1))
                (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))))
        ;; MessageBoxA(4)
        (global.set $eax (call $host_message_box (local.get $arg0)
          (call $g2w (local.get $arg1)) (call $g2w (local.get $arg2)) (local.get $arg3)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; ShowWindow(2) "Show"
    (if (i32.eq (local.get $w0) (i32.const 0x776F6853))
      (then (call $host_show_window (local.get $arg0) (local.get $arg1))
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; UpdateWindow(1) "Upda"
    (if (i32.eq (local.get $w0) (i32.const 0x61647055))
      (then (call $host_invalidate (local.get $arg0))
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetMessageA(4) "GetM"+"essa"
    ;; Returns 0 when WM_QUIT → exits message loop
    ;; We send a few synthetic messages then WM_QUIT
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x4D746547)) (i32.eq (local.get $w1) (i32.const 0x61737365)))
      (then
        (local.set $msg_ptr (local.get $arg0))
        ;; If quit flag set, return 0 (WM_QUIT)
        (if (global.get $quit_flag)
          (then
            ;; Fill MSG with WM_QUIT (0x0012)
            (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))          ;; hwnd
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0012)) ;; message=WM_QUIT
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))      ;; wParam
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))     ;; lParam
            (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
        ;; Deliver pending WM_CREATE before anything else
        (if (global.get $pending_wm_create)
          (then
            (global.set $pending_wm_create (i32.const 0))
            (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0001)) ;; WM_CREATE
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
        ;; Deliver pending WM_SIZE after WM_CREATE
        (if (global.get $pending_wm_size)
          (then
            (local.set $packed (global.get $pending_wm_size))
            (global.set $pending_wm_size (i32.const 0))
            (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0005)) ;; WM_SIZE
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))      ;; SIZE_RESTORED
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (local.get $packed)) ;; lParam=cx|(cy<<16)
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
        ;; Drain posted message queue first
        (if (i32.gt_u (global.get $post_queue_count) (i32.const 0))
          (then
            ;; Dequeue first message (shift queue down)
            (local.set $tmp (i32.const 0x400))
            (call $gs32 (local.get $msg_ptr) (i32.load (local.get $tmp)))                        ;; hwnd
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.load (i32.add (local.get $tmp) (i32.const 4))))  ;; msg
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.load (i32.add (local.get $tmp) (i32.const 8))))  ;; wParam
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.load (i32.add (local.get $tmp) (i32.const 12)))) ;; lParam
            ;; Shift remaining messages down
            (global.set $post_queue_count (i32.sub (global.get $post_queue_count) (i32.const 1)))
            (if (i32.gt_u (global.get $post_queue_count) (i32.const 0))
              (then (call $memcpy (i32.const 0x400) (i32.const 0x410)
                      (i32.mul (global.get $post_queue_count) (i32.const 16)))))
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
        ;; Phase 0: send WM_PAINT
        (if (i32.eqz (global.get $msg_phase))
          (then
            (global.set $msg_phase (i32.const 1))
            (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x000F)) ;; WM_PAINT
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
        ;; Phase 1: send WM_ACTIVATE to start game
        (if (i32.eq (global.get $msg_phase) (i32.const 1))
          (then
            (global.set $msg_phase (i32.const 2))
            (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0006)) ;; WM_ACTIVATE
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 1))      ;; WA_ACTIVE
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (global.get $main_hwnd)) ;; lParam (non-zero)
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
        ;; Poll for input events from the host
        (local.set $packed (call $host_check_input))
        (if (i32.ne (local.get $packed) (i32.const 0))
          (then
            ;; Unpack: msg = low 16 bits, wParam = high 16 bits
            ;; Use hwnd from event if provided, else main_hwnd
            (local.set $tmp (call $host_check_input_hwnd))
            (if (i32.eqz (local.get $tmp))
              (then (local.set $tmp (global.get $main_hwnd))))
            (call $gs32 (local.get $msg_ptr) (local.get $tmp))
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4))
              (i32.and (local.get $packed) (i32.const 0xFFFF)))            ;; msg
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8))
              (i32.shr_u (local.get $packed) (i32.const 16)))              ;; wParam
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12))
              (call $host_check_input_lparam))                              ;; lParam
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
        ;; No input available — deliver WM_TIMER if timer is active
        (if (global.get $timer_id)
          (then
            (call $gs32 (local.get $msg_ptr) (global.get $timer_hwnd))
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0113)) ;; WM_TIMER
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (global.get $timer_id)) ;; wParam=timerID
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (global.get $timer_callback)) ;; lParam=callback
            (global.set $yield_flag (i32.const 1)) ;; yield to host after each timer
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
        ;; No timer — return WM_NULL
        (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
        (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0))  ;; WM_NULL
        (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
        (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; PeekMessageA(5) "Peek"
    (if (i32.eq (local.get $w0) (i32.const 0x6B656550))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; DispatchMessageA(1) "Disp"
    (if (i32.eq (local.get $w0) (i32.const 0x70736944))
      (then
        ;; Skip WM_NULL — idle message, don't dispatch to WndProc
        (if (i32.eqz (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
          (then (global.set $eax (i32.const 0))
                (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
        ;; WM_TIMER with callback (lParam != 0): call callback(hwnd, WM_TIMER, timerID, tickcount)
        (if (i32.and (i32.eq (call $gl32 (i32.add (local.get $arg0) (i32.const 4))) (i32.const 0x0113))
                     (i32.ne (call $gl32 (i32.add (local.get $arg0) (i32.const 12))) (i32.const 0)))
          (then
            (local.set $tmp (call $gl32 (global.get $esp)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
            ;; Push callback args: GetTickCount, timerID, WM_TIMER, hwnd
            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
            (call $gs32 (global.get $esp) (i32.const 100000)) ;; dwTime (fake tick count)
            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
            (call $gs32 (global.get $esp) (call $gl32 (i32.add (local.get $arg0) (i32.const 8)))) ;; timerID
            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
            (call $gs32 (global.get $esp) (i32.const 0x0113)) ;; WM_TIMER
            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
            (call $gs32 (global.get $esp) (call $gl32 (local.get $arg0))) ;; hwnd
            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
            (call $gs32 (global.get $esp) (local.get $tmp))
            (global.set $eip (call $gl32 (i32.add (local.get $arg0) (i32.const 12)))) ;; callback addr
            (global.set $steps (i32.const 0))
            (return)))
        ;; If we have a WndProc, call it with the message
        (if (i32.and (i32.ne (global.get $wndproc_addr) (i32.const 0)) (i32.ne (local.get $arg0) (i32.const 0)))
          (then
            ;; Save the caller's return address before we modify the stack
            (local.set $tmp (call $gl32 (global.get $esp)))
            ;; Pop DispatchMessageA's own frame (ret + MSG* = 8 bytes)
            (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
            ;; Now push WndProc args: lParam, wParam, msg, hwnd (right to left)
            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
            (call $gs32 (global.get $esp) (call $gl32 (i32.add (local.get $arg0) (i32.const 12)))) ;; lParam
            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
            (call $gs32 (global.get $esp) (call $gl32 (i32.add (local.get $arg0) (i32.const 8))))  ;; wParam
            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
            (call $gs32 (global.get $esp) (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))  ;; msg
            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
            (call $gs32 (global.get $esp) (call $gl32 (local.get $arg0)))                          ;; hwnd
            ;; Push return address — when WndProc returns, go back to DispatchMessage's caller
            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
            (call $gs32 (global.get $esp) (local.get $tmp))
            ;; Jump to WndProc — select based on hwnd
            (if (i32.eq (call $gl32 (local.get $arg0)) (global.get $main_hwnd))
              (then (global.set $eip (global.get $wndproc_addr)))
              (else (if (global.get $wndproc_addr2)
                (then (global.set $eip (global.get $wndproc_addr2)))
                (else (global.set $eip (global.get $wndproc_addr))))))
            (global.set $steps (i32.const 0))
            (return)))
        ;; No WndProc: just return 0
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; TranslateAcceleratorA(3) "Tran"+"slat"+"eAcc" — MUST match before TranslateMessage
    ;; w2 = "eAcc" = 0x63634165
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x6E617254))
                          (i32.eq (local.get $w1) (i32.const 0x74616C73)))
                 (i32.eq (local.get $w2) (i32.const 0x63634165)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; TranslateMessage(1) "Tran"+"slat" (remaining match after AcceleratorA excluded)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x6E617254)) (i32.eq (local.get $w1) (i32.const 0x74616C73)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; DefWindowProcA(4) "DefW"
    ;; Args: hwnd(+4), msg(+8), wParam(+12), lParam(+16)
    (if (i32.eq (local.get $w0) (i32.const 0x57666544))
      (then
        ;; WM_CLOSE (0x10): call DestroyWindow(hwnd)
        (if (i32.eq (local.get $arg1) (i32.const 0x0010))
          (then
            ;; DestroyWindow sends WM_DESTROY to WndProc
            ;; For now, just set quit_flag directly since WM_DESTROY→PostQuitMessage
            (global.set $quit_flag (i32.const 1))))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; PostQuitMessage(1) "Post"+"Quit"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x74736F50)) (i32.eq (local.get $w1) (i32.const 0x74697551)))
      (then (global.set $quit_flag (i32.const 1))
            (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; PostMessageA(4) "Post"+"Mess" — queue message for delivery by GetMessageA
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x74736F50)) (i32.eq (local.get $w1) (i32.const 0x7373654D)))
      (then
        ;; Queue if room (max 8 messages, 16 bytes each, at WASM addr 0x400)
        (if (i32.lt_u (global.get $post_queue_count) (i32.const 8))
          (then
            (local.set $tmp (i32.add (i32.const 0x400)
              (i32.mul (global.get $post_queue_count) (i32.const 16))))
            (i32.store (local.get $tmp) (local.get $arg0))                         ;; hwnd
            (i32.store (i32.add (local.get $tmp) (i32.const 4)) (local.get $arg1)) ;; msg
            (i32.store (i32.add (local.get $tmp) (i32.const 8)) (local.get $arg2)) ;; wParam
            (i32.store (i32.add (local.get $tmp) (i32.const 12)) (local.get $arg3));; lParam
            (global.set $post_queue_count (i32.add (global.get $post_queue_count) (i32.const 1)))))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; SendMessageA(4) "Send"+"Mess"
    ;; Args: hwnd(+4), msg(+8), wParam(+12), lParam(+16)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x646E6553)) (i32.eq (local.get $w1) (i32.const 0x7373654D)))
      (then
        ;; Dispatch to WndProc for main window or dialog window
        (if (i32.and (i32.ne (global.get $wndproc_addr) (i32.const 0))
                     (i32.or (i32.eq (local.get $arg0) (global.get $main_hwnd))
                             (i32.eq (local.get $arg0) (global.get $dlg_hwnd))))
          (then
            ;; Save caller's return address
            (local.set $tmp (call $gl32 (global.get $esp)))
            ;; Pop SendMessageA frame (ret + 4 args = 20 bytes)
            (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
            ;; Push WndProc args: lParam, wParam, msg, hwnd (right to left)
            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
            (call $gs32 (global.get $esp) (local.get $arg3))  ;; lParam
            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
            (call $gs32 (global.get $esp) (local.get $arg2))  ;; wParam
            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
            (call $gs32 (global.get $esp) (local.get $arg1))  ;; msg
            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
            (call $gs32 (global.get $esp) (local.get $arg0))  ;; hwnd
            ;; Push return address
            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
            (call $gs32 (global.get $esp) (local.get $tmp))
            ;; Jump to WndProc — select based on hwnd
            (if (i32.eq (call $gl32 (local.get $arg0)) (global.get $main_hwnd))
              (then (global.set $eip (global.get $wndproc_addr)))
              (else (if (global.get $wndproc_addr2)
                (then (global.set $eip (global.get $wndproc_addr2)))
                (else (global.set $eip (global.get $wndproc_addr))))))
            (global.set $steps (i32.const 0))
            (return)))
        ;; Non-main window or no WndProc: stub — return 0
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; SendDlgItemMessageA(5) "Send"+"DlgI"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x646E6553)) (i32.eq (local.get $w1) (i32.const 0x49676C44)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; DestroyWindow(1) "Dest"+"royW"
    ;; If destroying the main window, set quit_flag (app is closing).
    ;; If destroying a dialog/child, just return success (e.g. switching calc modes).
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x74736544)) (i32.eq (local.get $w1) (i32.const 0x57796F72)))
      (then
        ;; Set quit_flag when destroying main or dialog window.
        ;; For mode switches (e.g. calc Scientific), CreateDialogParamA clears quit_flag.
        (if (i32.or (i32.eq (local.get $arg0) (global.get $main_hwnd))
                    (i32.eq (local.get $arg0) (global.get $dlg_hwnd)))
          (then (global.set $quit_flag (i32.const 1))))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; DestroyMenu(1) "Dest"+"royM"=0x4D796F72
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x74736544)) (i32.eq (local.get $w1) (i32.const 0x4D796F72)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetDC(1) "GetD"+"C\0" — match "GetD" then check 5th char = 'C'
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x44746547))
                 (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 4))) (i32.const 0x43)))
      (then (global.set $eax (i32.const 0x50001)) ;; fake HDC
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetDeviceCaps(2) "GetD"+"evic"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x44746547)) (i32.eq (local.get $w1) (i32.const 0x63697665)))
      (then
        ;; Return reasonable defaults for common caps
        ;; HORZRES=8, VERTRES=10, LOGPIXELSX=88, LOGPIXELSY=90
        (if (i32.eq (local.get $arg1) (i32.const 8))
          (then (global.set $eax (i32.const 800))))  ;; HORZRES
        (if (i32.eq (local.get $arg1) (i32.const 10))
          (then (global.set $eax (i32.const 600))))  ;; VERTRES
        (if (i32.eq (local.get $arg1) (i32.const 88))
          (then (global.set $eax (i32.const 96))))   ;; LOGPIXELSX
        (if (i32.eq (local.get $arg1) (i32.const 90))
          (then (global.set $eax (i32.const 96))))   ;; LOGPIXELSY
        (if (i32.eq (local.get $arg1) (i32.const 12))
          (then (global.set $eax (i32.const 32))))  ;; BITSPIXEL
        (if (i32.eq (local.get $arg1) (i32.const 14))
          (then (global.set $eax (i32.const 1))))   ;; PLANES
        (if (i32.eq (local.get $arg1) (i32.const 24))
          (then (global.set $eax (i32.const 256)))) ;; NUMCOLORS (0x18) — not exact but close
        (if (i32.eq (local.get $arg1) (i32.const 40))
          (then (global.set $eax (i32.const -1))))  ;; NUMCOLORS (0x28) — -1 = >256 colors
        (if (i32.eq (local.get $arg1) (i32.const 42))
          (then (global.set $eax (i32.const 24))))  ;; COLORRES (0x2A) — 24-bit color
        (if (i32.eq (local.get $arg1) (i32.const 104))
          (then (global.set $eax (i32.const 32))))  ;; SIZEPALETTE (0x68)
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; GetMenu(1) "GetM"+"enu\0"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x4D746547))
                 (i32.eq (i32.and (local.get $w1) (i32.const 0x00FFFFFF)) (i32.const 0x00756E65)))
      (then (global.set $eax (i32.const 0x40001)) ;; fake HMENU
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetSubMenu(2) "GetS"+"ubMe"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x53746547)) (i32.eq (local.get $w1) (i32.const 0x654D6275)))
      (then (global.set $eax (i32.const 0x40002))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; GetSystemMenu(2) "GetS"+"yste"+"mMen"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x53746547))
                 (i32.eq (local.get $w1) (i32.const 0x65747379)))
      (then
        ;; Could be GetSystemMenu or GetSystemMetrics — check w2
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 9))) (i32.const 0x65)) ;; "e" in Menu
          (then (global.set $eax (i32.const 0x40003))
                (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
        ;; GetSystemMetrics(1) — return reasonable Win98 values for 640x480
        ;; SM_CXSCREEN=0, SM_CYSCREEN=1, SM_CXFULLSCREEN=16, SM_CYFULLSCREEN=17
        ;; SM_CXMAXIMIZED=61(0x3D), SM_CYMAXIMIZED=62(0x3E)
        ;; SM_CXFRAME=32, SM_CYFRAME=33, SM_CYCAPTION=4, SM_CYMENU=15
        (if (i32.eq (local.get $arg0) (i32.const 0))  ;; SM_CXSCREEN
          (then (global.set $eax (i32.const 640))
                (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
        (if (i32.eq (local.get $arg0) (i32.const 1))  ;; SM_CYSCREEN
          (then (global.set $eax (i32.const 480))
                (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
        (if (i32.eq (local.get $arg0) (i32.const 4))  ;; SM_CYCAPTION
          (then (global.set $eax (i32.const 19))
                (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
        (if (i32.eq (local.get $arg0) (i32.const 5))  ;; SM_CXBORDER
          (then (global.set $eax (i32.const 1))
                (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
        (if (i32.eq (local.get $arg0) (i32.const 6))  ;; SM_CYBORDER
          (then (global.set $eax (i32.const 1))
                (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
        (if (i32.eq (local.get $arg0) (i32.const 7))  ;; SM_CXFIXEDFRAME (SM_CXDLGFRAME)
          (then (global.set $eax (i32.const 3))
                (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
        (if (i32.eq (local.get $arg0) (i32.const 8))  ;; SM_CYFIXEDFRAME
          (then (global.set $eax (i32.const 3))
                (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
        (if (i32.eq (local.get $arg0) (i32.const 15)) ;; SM_CYMENU
          (then (global.set $eax (i32.const 19))
                (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
        (if (i32.eq (local.get $arg0) (i32.const 16)) ;; SM_CXFULLSCREEN
          (then (global.set $eax (i32.const 640))
                (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
        (if (i32.eq (local.get $arg0) (i32.const 17)) ;; SM_CYFULLSCREEN
          (then (global.set $eax (i32.const 434))
                (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
        (if (i32.eq (local.get $arg0) (i32.const 32)) ;; SM_CXFRAME (SM_CXSIZEFRAME)
          (then (global.set $eax (i32.const 4))
                (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
        (if (i32.eq (local.get $arg0) (i32.const 33)) ;; SM_CYFRAME
          (then (global.set $eax (i32.const 4))
                (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
        (if (i32.eq (local.get $arg0) (i32.const 0x3D)) ;; SM_CXMAXIMIZED
          (then (global.set $eax (i32.const 648))
                (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
        (if (i32.eq (local.get $arg0) (i32.const 0x3E)) ;; SM_CYMAXIMIZED
          (then (global.set $eax (i32.const 488))
                (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetClientRect(2) "GetC"+"lien"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x43746547)) (i32.eq (local.get $w1) (i32.const 0x6E65696C)))
      (then
        ;; Fill RECT with 800x600
        (call $gs32 (local.get $arg1) (i32.const 0))       ;; left
        (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))   ;; top
        (call $gs32 (i32.add (local.get $arg1) (i32.const 8)) (i32.const 800)) ;; right
        (call $gs32 (i32.add (local.get $arg1) (i32.const 12)) (i32.const 600));; bottom
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; GetWindowTextA(3) "GetW"+"indo" + w2="wTex"=0x78655477
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x57746547)) (i32.eq (local.get $w1) (i32.const 0x6F646E69)))
                 (i32.eq (local.get $w2) (i32.const 0x78655477)))
      (then
        ;; Return empty string
        (if (i32.gt_u (local.get $arg2) (i32.const 0))
          (then (call $gs8 (local.get $arg1) (i32.const 0))))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; GetWindowRect(2) "GetW"+"indo" + w2="wRec"=0x63655277
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x57746547)) (i32.eq (local.get $w1) (i32.const 0x6F646E69)))
                 (i32.eq (local.get $w2) (i32.const 0x63655277)))
      (then
        (call $gs32 (local.get $arg1) (i32.const 0))
        (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))
        (call $gs32 (i32.add (local.get $arg1) (i32.const 8)) (i32.const 640))
        (call $gs32 (i32.add (local.get $arg1) (i32.const 12)) (i32.const 480))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; GetDlgCtrlID(1) "GetD"+"lgCt"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x44746547)) (i32.eq (local.get $w1) (i32.const 0x7443676C)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetDlgItemTextA(4) "GetD"+"lgIt" + w2="emTe"=0x65546D65
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x44746547)) (i32.eq (local.get $w1) (i32.const 0x7449676C)))
                 (i32.eq (local.get $w2) (i32.const 0x65546D65)))
      (then
        (if (i32.gt_u (local.get $arg3) (i32.const 0))
          (then (call $gs8 (local.get $arg2) (i32.const 0))))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; GetDlgItem(2) "GetD"+"lgIt" + w2 != "emTe" (shorter name)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x44746547)) (i32.eq (local.get $w1) (i32.const 0x7449676C)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; GetCursorPos(1) "GetC"+"urso"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x43746547)) (i32.eq (local.get $w1) (i32.const 0x6F737275)))
      (then
        (call $gs32 (local.get $arg0) (i32.const 0))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetLastActivePopup(1) "GetL"+"astA"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x4C746547)) (i32.eq (local.get $w1) (i32.const 0x41747361)))
      (then (global.set $eax (local.get $arg0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetFocus(0) "GetF"+"ocus"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x46746547)) (i32.eq (local.get $w1) (i32.const 0x7375636F)))
      (then (global.set $eax (global.get $main_hwnd))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; ReleaseDC(2) "Rele"
    (if (i32.eq (local.get $w0) (i32.const 0x656C6552))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; SetWindowLongA(3) "SetW"+"indo"+"wLon"
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x57746553)) (i32.eq (local.get $w1) (i32.const 0x6F646E69)))
                 (i32.eq (local.get $w2) (i32.const 0x6E6F4C77)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; SetWindowTextA(2) "SetW"+"indo"+"wTex" — args: hWnd, lpString
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x57746553)) (i32.eq (local.get $w1) (i32.const 0x6F646E69)))
                 (i32.eq (local.get $w2) (i32.const 0x78655477)))
      (then (call $host_set_window_text (local.get $arg0) (call $g2w (local.get $arg1)))
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; SetDlgItemTextA(3) "SetD"+"lgIt" + w2="emTe"=0x65546D65
    ;; Args: hDlg(+4), nIDDlgItem(+8), lpString(+12)
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x44746553)) (i32.eq (local.get $w1) (i32.const 0x7449676C)))
                 (i32.eq (local.get $w2) (i32.const 0x65546D65)))
      (then
        (call $host_set_dlg_item_text
          (local.get $arg0)                          ;; hDlg
          (local.get $arg1)                          ;; nIDDlgItem
          (call $g2w (local.get $arg2)))             ;; lpString → WASM ptr
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; SetDlgItemInt(4) "SetD"+"lgIt" + w2="emIn"=0x6E496D65
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x44746553)) (i32.eq (local.get $w1) (i32.const 0x7449676C)))
                 (i32.eq (local.get $w2) (i32.const 0x6E496D65)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; SetForegroundWindow(1) "SetF"+"oreg"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x46746553)) (i32.eq (local.get $w1) (i32.const 0x6765726F)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; SetCursor(1) "SetC"+"urso"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x43746553)) (i32.eq (local.get $w1) (i32.const 0x6F737275)))
      (then (global.set $eax (i32.const 0x20001))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; SetFocus(1) "SetF"+"ocus"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x46746553)) (i32.eq (local.get $w1) (i32.const 0x7375636F)))
      (then (global.set $eax (global.get $main_hwnd))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; LoadCursorA(2) "Load"+"Curs"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x64616F4C)) (i32.eq (local.get $w1) (i32.const 0x73727543)))
      (then (global.set $eax (i32.const 0x20001))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; LoadIconA(2) "Load"+"Icon"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x64616F4C)) (i32.eq (local.get $w1) (i32.const 0x6E6F6349)))
      (then (global.set $eax (i32.const 0x20002))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; LoadStringA(4) "Load"+"Stri" — args: hInst, uID, lpBuffer, cchMax
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x64616F4C)) (i32.eq (local.get $w1) (i32.const 0x69727453)))
      (then
        ;; Call host to write string from resource JSON into guest buffer
        (global.set $eax (call $host_load_string
          (local.get $arg1)                ;; string ID
          (call $g2w (local.get $arg2))    ;; buffer (WASM ptr)
          (local.get $arg3)))              ;; max chars
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; LoadAcceleratorsA(2) "Load"+"Acce"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x64616F4C)) (i32.eq (local.get $w1) (i32.const 0x65636341)))
      (then (global.set $haccel (i32.const 0x60001))
            (global.set $eax (i32.const 0x60001))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; EnableWindow(2) "Enab"+"leWi"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x62616E45)) (i32.eq (local.get $w1) (i32.const 0x6957656C)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; EnableMenuItem(3) "Enab"+"leMen"
    (if (i32.eq (local.get $w0) (i32.const 0x62616E45))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; EndDialog(2) "EndD"
    (if (i32.eq (local.get $w0) (i32.const 0x44646E45))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; InvalidateRect(3) "Inva"
    (if (i32.eq (local.get $w0) (i32.const 0x61766E49))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; FillRect(3) "Fill"+"Rect" — stub, return 1
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x6C6C6946)) (i32.eq (local.get $w1) (i32.const 0x74636552)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; FrameRect(3) "Fram"+"eRec"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x6D617246)) (i32.eq (local.get $w1) (i32.const 0x63655265)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; LoadBitmapA(2) "Load"+"Bitm" — load bitmap from PE resources
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x64616F4C)) (i32.eq (local.get $w1) (i32.const 0x6D746942)))
      (then
        ;; arg1 = resource ID (MAKEINTRESOURCE value, low 16 bits)
        (local.set $tmp (call $host_gdi_load_bitmap (i32.and (local.get $arg1) (i32.const 0xFFFF))))
        ;; If host couldn't find it, return a fake 32x32 bitmap
        (if (i32.eqz (local.get $tmp))
          (then (local.set $tmp (call $host_gdi_create_compat_bitmap (i32.const 0) (i32.const 32) (i32.const 32)))))
        (global.set $eax (local.get $tmp))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; OpenIcon(1) "Open"+"Icon" — restore minimized window, same as ShowWindow(SW_RESTORE)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x6E65704F)) (i32.eq (local.get $w1) (i32.const 0x6E6F6349)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; MoveWindow(6) "Move"
    (if (i32.eq (local.get $w0) (i32.const 0x65766F4D))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))

    ;; CheckMenuRadioItem(5) "Chec"+"kMen"+"uRad"=0x64615275
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x63656843)) (i32.eq (local.get $w1) (i32.const 0x6E654D6B)))
                 (i32.eq (local.get $w2) (i32.const 0x64615275)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; CheckMenuItem(3) "Chec"+"kMen" (catch-all for remaining CheckMenu*)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x63656843)) (i32.eq (local.get $w1) (i32.const 0x6E654D6B)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; CheckRadioButton(4) "Chec"+"kRad"=0x6461526B
    ;; Args: hwnd(+4), firstId(+8), lastId(+12), checkId(+16)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x63656843)) (i32.eq (local.get $w1) (i32.const 0x6461526B)))
      (then (call $host_check_radio_button (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3))
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; CheckDlgButton(3) "Chec"+"kDlg"=0x676C446B
    ;; Args: hwnd(+4), buttonId(+8), checkState(+12)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x63656843)) (i32.eq (local.get $w1) (i32.const 0x676C446B)))
      (then (call $host_check_dlg_button (local.get $arg0) (local.get $arg1) (local.get $arg2))
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; CharNextA(1) "Char"+"Next"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x72616843)) (i32.eq (local.get $w1) (i32.const 0x7478654E)))
      (then
        ;; Return ptr+1 (simple ANSI impl)
        (if (i32.eqz (call $gl8 (local.get $arg0)))
          (then (global.set $eax (local.get $arg0)))
          (else (global.set $eax (i32.add (local.get $arg0) (i32.const 1)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CharPrevA(2) "Char"+"Prev"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x72616843)) (i32.eq (local.get $w1) (i32.const 0x76657250)))
      (then
        ;; Return max(start, ptr-1)
        (if (i32.le_u (local.get $arg1) (local.get $arg0))
          (then (global.set $eax (local.get $arg0)))
          (else (global.set $eax (i32.sub (local.get $arg1) (i32.const 1)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; IsDialogMessageA(2) "IsDi"
    (if (i32.eq (local.get $w0) (i32.const 0x69447349))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; IsIconic(1) "IsIc"
    (if (i32.eq (local.get $w0) (i32.const 0x63497349))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; ChildWindowFromPoint(3) "Chil"
    (if (i32.eq (local.get $w0) (i32.const 0x6C696843))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; ScreenToClient(2) "Scre"
    (if (i32.eq (local.get $w0) (i32.const 0x65726353))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; TabbedTextOutA(8) "Tabb"
    (if (i32.eq (local.get $w0) (i32.const 0x62626154))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 36))) (return)))

    ;; WinHelpA(4) "WinH"
    (if (i32.eq (local.get $w0) (i32.const 0x486E6957))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; wsprintfA — CDECL! Caller cleans stack. Only pop ret addr.
    ;; Stack: [ret_addr, lpOut, lpFmt, varargs...]
    (if (i32.or (i32.eq (local.get $w0) (i32.const 0x69727077)) ;; "wpri"
                (i32.eq (local.get $w0) (i32.const 0x72707377))) ;; "wspr"
      (then (global.set $eax (call $wsprintf_impl
              (local.get $arg0)  ;; lpOut
              (local.get $arg1)  ;; lpFmt
              (i32.add (global.get $esp) (i32.const 12)))) ;; varargs start at esp+12
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; Clipboard
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x736F6C43)) (i32.eq (local.get $w1) (i32.const 0x696C4365))) ;; "Clos"+"eCli" CloseClipboard(0)
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))
    (if (i32.eq (local.get $w0) (i32.const 0x6E65704F)) ;; "Open" OpenClipboard(1)
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $w0) (i32.const 0x6C437349)) ;; "IsCl" IsClipboardFormatAvailable(1)
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; IsChild(2) "IsCh"=0x68437349
    ;; Args: hWndParent(+4), hWnd(+8)
    ;; Return TRUE if hWndParent is the dialog — all controls are children of it
    (if (i32.eq (local.get $w0) (i32.const 0x68437349))
      (then (global.set $eax (if (result i32) (i32.and
              (i32.ne (global.get $dlg_hwnd) (i32.const 0))
              (i32.eq (local.get $arg0) (global.get $dlg_hwnd)))
              (then (i32.const 1)) (else (i32.const 0))))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; GetSysColorBrush(1) "GetS"+"ysCo"=0x6F437379 + w2="lorB"=0x42726F6C
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x53746547)) (i32.eq (local.get $w1) (i32.const 0x6F437379)))
                 (i32.eq (local.get $w2) (i32.const 0x42726F6C)))
      (then (global.set $eax (i32.const 0x30010)) ;; fake HBRUSH
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetSysColor(1) "GetS"+"ysCo"=0x6F437379 (catch-all after Brush)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x53746547)) (i32.eq (local.get $w1) (i32.const 0x6F437379)))
      (then
        ;; Return reasonable defaults for common colors
        ;; COLOR_WINDOW=5 → white, COLOR_BTNFACE=15 → 0xC0C0C0
        (if (i32.eq (local.get $arg0) (i32.const 5))
          (then (global.set $eax (i32.const 0x00FFFFFF)))
          (else (if (i32.eq (local.get $arg0) (i32.const 15))
            (then (global.set $eax (i32.const 0x00C0C0C0)))
            (else (global.set $eax (i32.const 0x00C0C0C0))))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; DialogBoxParamA(5) "Dial"=0x6C616944
    (if (i32.eq (local.get $w0) (i32.const 0x6C616944))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; LoadMenuA(2) "Load"+"Menu"=0x756E654D — args: hInst, lpMenuName
    ;; Return HMENU = 0x40000 | resourceId so SetMenu can decode it
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x64616F4C)) (i32.eq (local.get $w1) (i32.const 0x756E654D)))
      (then (global.set $eax (i32.or (i32.const 0x40000) (local.get $arg1)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; TrackPopupMenuEx(6) "Trac"=0x63617254
    (if (i32.eq (local.get $w0) (i32.const 0x63617254))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))

    ;; OffsetRect(3) "Offs"=0x7366664F
    (if (i32.eq (local.get $w0) (i32.const 0x7366664F))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; MapWindowPoints(4) "MapW"=0x5770614D
    (if (i32.eq (local.get $w0) (i32.const 0x5770614D))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; SetWindowPos(7) "SetW"+"indo"+"wPos"=0x736F5077
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x57746553)) (i32.eq (local.get $w1) (i32.const 0x6F646E69)))
                 (i32.eq (local.get $w2) (i32.const 0x736F5077)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 32))) (return)))

    ;; DrawTextA(5) "Draw"+"Text"=0x74786554
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x77617244)) (i32.eq (local.get $w1) (i32.const 0x74786554)))
      (then (global.set $eax (i32.const 16)) ;; return text height
            (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; DrawEdge(4) "Draw"+"Edge"=0x65676445
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x77617244)) (i32.eq (local.get $w1) (i32.const 0x65676445)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; GetClipboardData(1) "GetC"+"lipb"=0x62706C69
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x43746547)) (i32.eq (local.get $w1) (i32.const 0x62706C69)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; ================================================================
    ;; GDI32
    ;; ================================================================

    ;; SelectObject(2) "Sele"
    (if (i32.eq (local.get $w0) (i32.const 0x656C6553))
      (then (global.set $eax (call $host_gdi_select_object (local.get $arg0) (local.get $arg1)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; DeleteObject(1) "Dele"+"teOb"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x656C6544)) (i32.eq (local.get $w1) (i32.const 0x624F6574)))
      (then (global.set $eax (call $host_gdi_delete_object (local.get $arg0)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; DeleteDC(1) "Dele"+"teDC"
    (if (i32.eq (local.get $w0) (i32.const 0x656C6544))
      (then (global.set $eax (call $host_gdi_delete_dc (local.get $arg0)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CreatePen(3) "Crea"+"tePe"=0x65506574
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x65506574)))
      (then (global.set $eax (call $host_gdi_create_pen (local.get $arg0) (local.get $arg1) (local.get $arg2)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; CreateSolidBrush(1) "Crea"+"teSo"=0x6F536574
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x6F536574)))
      (then (global.set $eax (call $host_gdi_create_solid_brush (local.get $arg0)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CreateCompatibleDC(1) "Crea"+"teCo"+"mpat"+"ible"+"DC\0" — must match before CreateCompatibleBitmap
    ;; "teCo" = 0x6F436574, "mpat" = 0x7461706D
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x6F436574)))
                 (i32.eq (local.get $w2) (i32.const 0x7461706D)))
      (then (global.set $eax (call $host_gdi_create_compat_dc (local.get $arg0)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CreateCompatibleBitmap(3) "Crea"+"teCo" — DC matched above, this catches Bitmap
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x6F436574)))
      (then (global.set $eax (call $host_gdi_create_compat_bitmap (local.get $arg0) (local.get $arg1) (local.get $arg2)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; GetViewportOrgEx(2) "GetV"+"iewp"=0x70776569
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x56746547)) (i32.eq (local.get $w1) (i32.const 0x70776569)))
      (then
        ;; Fill POINT with (0,0)
        (if (i32.ne (local.get $arg1) (i32.const 0))
          (then
            (call $gs32 (local.get $arg1) (i32.const 0))
            (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; Rectangle(5) "Rect"+"angl"=0x6C676E61
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x74636552)) (i32.eq (local.get $w1) (i32.const 0x6C676E61)))
      (then (global.set $eax (call $host_gdi_rectangle
              (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (global.get $main_hwnd)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; MoveToEx(4) "Move"+"ToEx"=0x78456F54
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x65766F4D)) (i32.eq (local.get $w1) (i32.const 0x78456F54)))
      (then
        ;; Save old position to lpPoint (arg3) if non-null
        (global.set $eax (call $host_gdi_move_to (local.get $arg0) (local.get $arg1) (local.get $arg2)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; LineTo(3) "Line"+"To\0\0"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x656E694C)) (i32.eq (i32.and (local.get $w1) (i32.const 0x0000FFFF)) (i32.const 0x00006F54)))
      (then (global.set $eax (call $host_gdi_line_to (local.get $arg0) (local.get $arg1) (local.get $arg2) (global.get $main_hwnd)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; Ellipse(5) "Elli"+"pse\0"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x696C6C45)) (i32.eq (i32.and (local.get $w1) (i32.const 0x00FFFFFF)) (i32.const 0x00657370)))
      (then (global.set $eax (call $host_gdi_ellipse
              (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (global.get $main_hwnd)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; Arc(9) "Arc\0" — need args 5-8 from deeper in the stack
    (if (i32.eq (i32.and (local.get $w0) (i32.const 0x00FFFFFF)) (i32.const 0x00637241))
      (then (global.set $eax (call $host_gdi_arc
              (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
              (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
              (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
              (call $gl32 (i32.add (global.get $esp) (i32.const 32)))
              (call $gl32 (i32.add (global.get $esp) (i32.const 36)))
              (global.get $main_hwnd)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 40))) (return)))

    ;; BitBlt(9) "BitB"+"lt\0\0"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x42746942)) (i32.eq (i32.and (local.get $w1) (i32.const 0x0000FFFF)) (i32.const 0x0000746C)))
      (then (global.set $eax (call $host_gdi_bitblt
              (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
              (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
              (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
              (call $gl32 (i32.add (global.get $esp) (i32.const 32)))
              (call $gl32 (i32.add (global.get $esp) (i32.const 36)))
              (global.get $main_hwnd)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 40))) (return)))

    ;; PatBlt(6) "PatB"+"lt\0\0" — pattern blit (stub)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x42746150)) (i32.eq (i32.and (local.get $w1) (i32.const 0x0000FFFF)) (i32.const 0x0000746C)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))

    ;; CreateBitmap(5) "Crea"+"teBi" — return fake bitmap handle
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x69426574)))
      (then (global.set $eax (call $host_gdi_create_compat_bitmap (i32.const 0) (local.get $arg0) (local.get $arg1)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; TextOutA(5) "Text"+"OutA"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x74786554)) (i32.eq (local.get $w1) (i32.const 0x4174754F)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; GetStockObject(1) "GetS"+"tock"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x53746547)) (i32.eq (local.get $w1) (i32.const 0x6B636F74)))
      (then (global.set $eax (i32.const 0x30002))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetObjectA(3) "GetO"+"bjec"
    ;; arg0=hObj, arg1=cbBuffer, arg2=lpvObject
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x4F746547)) (i32.eq (local.get $w1) (i32.const 0x63656A62)))
      (then
        (if (i32.gt_u (local.get $arg1) (i32.const 0))
          (then (call $zero_memory (call $g2w (local.get $arg2)) (local.get $arg1))))
        ;; Try to fill BITMAP struct if it's a bitmap object
        (local.set $tmp (call $host_gdi_get_object_w (local.get $arg0)))
        (if (i32.ne (local.get $tmp) (i32.const 0))
          (then
            ;; BITMAP: bmType(0), bmWidth(+4), bmHeight(+8), bmWidthBytes(+12), bmPlanes(+14 word), bmBitsPixel(+16 word)
            (if (i32.ge_u (local.get $arg1) (i32.const 24))
              (then
                (call $gs32 (i32.add (local.get $arg2) (i32.const 4)) (local.get $tmp))  ;; bmWidth
                (call $gs32 (i32.add (local.get $arg2) (i32.const 8)) (call $host_gdi_get_object_h (local.get $arg0))) ;; bmHeight
                (call $gs32 (i32.add (local.get $arg2) (i32.const 12))
                  (i32.mul (local.get $tmp) (i32.const 4))) ;; bmWidthBytes (assuming 32bpp)
                (call $gs16 (i32.add (local.get $arg2) (i32.const 14)) (i32.const 1))    ;; bmPlanes
                (call $gs16 (i32.add (local.get $arg2) (i32.const 16)) (i32.const 32))   ;; bmBitsPixel
              ))))
        (global.set $eax (local.get $arg1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; GetTextMetricsA(2) "GetT"+"extM"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x54746547)) (i32.eq (local.get $w1) (i32.const 0x4D747865)))
      (then
        ;; Fill TEXTMETRIC with reasonable defaults
        (call $zero_memory (call $g2w (local.get $arg1)) (i32.const 56))
        (call $gs32 (local.get $arg1) (i32.const 16))           ;; tmHeight
        (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))  ;; tmAscent (unused detail)
        (call $gs32 (i32.add (local.get $arg1) (i32.const 20)) (i32.const 8)) ;; tmAveCharWidth
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; GetTextExtentPointA(4) "GetT"+"extE"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x54746547)) (i32.eq (local.get $w1) (i32.const 0x45747865)))
      (then
        ;; Fill SIZE: cx = count*8, cy = 16
        (call $gs32 (local.get $arg3) (i32.mul (local.get $arg2) (i32.const 8)))  ;; cx
        (call $gs32 (i32.add (local.get $arg3) (i32.const 4)) (i32.const 16))     ;; cy
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; GetTextCharset(1) "GetT"+"extC"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x54746547)) (i32.eq (local.get $w1) (i32.const 0x43747865)))
      (then (global.set $eax (i32.const 0)) ;; ANSI_CHARSET
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CreateFontIndirectA(1) "Crea"+"teFo"+"ntIn" — must come before CreateFontA
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x6F466574)))
                 (i32.eq (local.get $w2) (i32.const 0x6E49746E)))
      (then (global.set $eax (i32.const 0x30003))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CreateFontA(14) "Crea"+"teFo"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x6F466574)))
      (then (global.set $eax (i32.const 0x30003))
            (global.set $esp (i32.add (global.get $esp) (i32.const 60))) (return)))

    ;; CreateDCA(4) "Crea"+"teDC"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x43446574)))
      (then (global.set $eax (i32.const 0x50002))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; SetAbortProc(2) "SetA"
    (if (i32.eq (local.get $w0) (i32.const 0x41746553))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; SetBkColor(2) "SetB"+"kCol"=0x6C6F436B
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x42746553)) (i32.eq (local.get $w1) (i32.const 0x6C6F436B)))
      (then (global.set $eax (i32.const 0x00FFFFFF)) ;; prev color
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; SetBkMode(2) "SetB"+"kMod"=0x646F4D6B (catch-all for remaining SetB*)
    (if (i32.eq (local.get $w0) (i32.const 0x42746553))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; SetTextColor(2) "SetT"+"extC"=0x43747865
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x54746553)) (i32.eq (local.get $w1) (i32.const 0x43747865)))
      (then (global.set $eax (i32.const 0x00000000)) ;; prev color (black)
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; SetMenu(2) "SetM"+"enu\0" — args: hWnd, hMenu
    ;; Decode HMENU: resource ID = hMenu & 0xFFFF
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x4D746553)) (i32.eq (local.get $w1) (i32.const 0x00756E65)))
      (then (call $host_set_menu
              (local.get $arg0)                                       ;; hWnd
              (i32.and (local.get $arg1) (i32.const 0xFFFF)))         ;; resource ID from HMENU
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; SetMapMode(2) "SetM"
    (if (i32.eq (local.get $w0) (i32.const 0x4D746553))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; SetWindowExtEx(4) / SetViewportExtEx(4) "SetW"/"SetV"
    (if (i32.or (i32.eq (local.get $w0) (i32.const 0x57746553))
                (i32.eq (local.get $w0) (i32.const 0x56746553)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; LPtoDP(3) "LPto"
    (if (i32.eq (local.get $w0) (i32.const 0x6F74504C))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; StartDocA(2) "Star"+"tDoc"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x72617453)) (i32.eq (local.get $w1) (i32.const 0x636F4474)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; StartPage(1) "Star"+"tPag"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x72617453)) (i32.eq (local.get $w1) (i32.const 0x67615074)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; EndPage(1) "EndP"+"age\0"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x50646E45))
                 (i32.eq (i32.and (local.get $w1) (i32.const 0x00FFFFFF)) (i32.const 0x00656761)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; EndPaint(2) "EndP"+"aint"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x50646E45)) (i32.eq (local.get $w1) (i32.const 0x746E6961)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; EndDoc(1) "EndD"+"oc\0" — careful, "EndD" also matches EndDialog
    ;; EndDialog already matched above. EndDoc would need w1 check.
    ;; Actually EndDialog w1 = "ialo", EndDoc w1 = "oc\0\0"
    ;; EndDialog already returned above, so EndDoc won't reach here. Good.

    ;; AbortDoc(1) "Abor"
    (if (i32.eq (local.get $w0) (i32.const 0x726F6241))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; BeginPaint / EndPaint — not in IAT but useful
    ;; "Begi" BeginPaint(2)
    (if (i32.eq (local.get $w0) (i32.const 0x69676542))
      (then
        ;; Fill PAINTSTRUCT minimally
        (call $zero_memory (call $g2w (local.get $arg1)) (i32.const 64))
        (call $gs32 (local.get $arg1) (i32.const 0x50001)) ;; hdc
        (global.set $eax (i32.const 0x50001))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    ;; "EndP"+"aint" EndPaint(2)
    ;; "EndP" already matches EndPage above. Need to disambiguate.
    ;; EndPage: "EndP"+"age\0", EndPaint: "EndP"+"aint"
    ;; EndPage already returned. If we reach here with "EndP", it's EndPaint.
    ;; But EndPage returns first, so EndPaint won't match. Let me fix:
    ;; Remove the EndPage match above and handle both here.

    ;; --- Additional USER32 APIs ---

    ;; SetCapture(1) "SetC"+"aptu"=0x75747061
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x43746553)) (i32.eq (local.get $w1) (i32.const 0x75747061)))
      (then (global.set $eax (i32.const 0)) ;; prev capture hwnd (none)
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; ReleaseCapture(0) "Rele"+"aseC"=0x43657361
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x656C6552)) (i32.eq (local.get $w1) (i32.const 0x43657361)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; ShowCursor(1) "Show"+"Curs"=0x73727543
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x776F6853)) (i32.eq (local.get $w1) (i32.const 0x73727543)))
      (then (global.set $eax (i32.const 1)) ;; display count
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; KillTimer(2) "Kill"+"Time"=0x656D6954
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x6C6C694B)) (i32.eq (local.get $w1) (i32.const 0x656D6954)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; SetTimer(4) "SetT"+"imer"=0x72656D69
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x54746553)) (i32.eq (local.get $w1) (i32.const 0x72656D69)))
      (then
        (global.set $timer_id (local.get $arg1))
        (global.set $timer_hwnd (local.get $arg0))
        (global.set $timer_callback (local.get $arg3))
        (global.set $eax (local.get $arg1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; FindWindowA(2) "Find"+"Wind"=0x646E6957
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x646E6946)) (i32.eq (local.get $w1) (i32.const 0x646E6957)))
      (then (global.set $eax (i32.const 0)) ;; not found
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; BringWindowToTop(1) "Brin"+"gWin"=0x6E695767
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x6E697242)) (i32.eq (local.get $w1) (i32.const 0x6E695767)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; WinHelpA(4) "WinH"+"elpA"=0x41706C65
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x486E6957)) (i32.eq (local.get $w1) (i32.const 0x41706C65)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; --- KERNEL32: Profile APIs ---

    ;; GetPrivateProfileIntA(4) "GetP"+"riva"=0x61766972
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x50746547)) (i32.eq (local.get $w1) (i32.const 0x61766972)))
      (then (global.set $eax (local.get $arg2)) ;; return nDefault
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; WritePrivateProfileStringA(4) "Writ"+"ePri"=0x69725065
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x74697257)) (i32.eq (local.get $w1) (i32.const 0x69725065)))
      (then (global.set $eax (i32.const 1)) ;; success
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; ================================================================
    ;; SHELL32
    ;; ================================================================

    ;; ShellExecuteA(6) "Shel"+"lExe"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x6C656853)) (i32.eq (local.get $w1) (i32.const 0x6578456C)))
      (then (global.set $eax (i32.const 33)) ;; > 32 means success
            (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))

    ;; ShellAboutA(4) "Shel"+"lAbo" — (hWnd, szApp, szOtherStuff, hIcon)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x6C656853)) (i32.eq (local.get $w1) (i32.const 0x6F62416C)))
      (then (global.set $eax (call $host_shell_about (local.get $arg0) (call $g2w (local.get $arg1))))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; SHGetSpecialFolderPathA(4) "SHGe"
    (if (i32.eq (local.get $w0) (i32.const 0x65474853))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; DragAcceptFiles(2) "Drag"+"Acce"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x67617244)) (i32.eq (local.get $w1) (i32.const 0x65636341)))
      (then (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; DragQueryFileA(4) "Drag"+"Quer"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x67617244)) (i32.eq (local.get $w1) (i32.const 0x72657551)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; DragFinish(1) "Drag"+"Fini"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x67617244)) (i32.eq (local.get $w1) (i32.const 0x696E6946)))
      (then (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; ================================================================
    ;; comdlg32
    ;; ================================================================

    ;; GetOpenFileNameA(1) / GetSaveFileNameA(1) "GetO"+"penF" / "GetS"+"aveF"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x4F746547)) (i32.eq (local.get $w1) (i32.const 0x466E6570)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x53746547)) (i32.eq (local.get $w1) (i32.const 0x46657661)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetFileTitleA(3) "GetF"+"ileT"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x46746547)) (i32.eq (local.get $w1) (i32.const 0x54656C69)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; ChooseFontA(1) "Choo"
    (if (i32.eq (local.get $w0) (i32.const 0x6F6F6843))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; FindTextA(1) — comdlg32 "Find"+"Text"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x646E6946)) (i32.eq (local.get $w1) (i32.const 0x74786554)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; PageSetupDlgA(1) "Page"
    (if (i32.eq (local.get $w0) (i32.const 0x65676150))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CommDlgExtendedError(0) "Comm"
    (if (i32.eq (local.get $w0) (i32.const 0x6D6D6F43))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; ================================================================
    ;; ADVAPI32 — Registry
    ;; ================================================================
    (if (i32.eq (i32.load16_u (local.get $name_ptr)) (i32.const 0x6552)) ;; "Re"
      (then (call $dispatch_reg (local.get $name_ptr)) (return)))

    ;; ================================================================
    ;; MSVCRT — All cdecl: only pop return address (4 bytes). Caller cleans args.
    ;; ================================================================

    ;; exit(1) "exit"=0x74697865
    (if (i32.eq (local.get $w0) (i32.const 0x74697865))
      (then (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
            (call $host_exit (local.get $arg0)) (global.set $steps (i32.const 0)) (return)))
    ;; _exit(1) "_exi"=0x6978655F
    (if (i32.eq (local.get $w0) (i32.const 0x6978655F))
      (then (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
            (call $host_exit (local.get $arg0)) (global.set $steps (i32.const 0)) (return)))

    ;; __getmainargs(4) "__ge"=0x65675F5F — fills argc/argv/envp
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x65675F5F)) (i32.eq (local.get $w1) (i32.const 0x69616D74)))
      (then
        ;; arg0=&argc, arg1=&argv, arg2=&envp
        (call $gs32 (local.get $arg0) (i32.const 1))     ;; argc = 1
        ;; Allocate a fake argv array: argv[0] = ptr to "CALC", argv[1] = 0
        (if (i32.eqz (global.get $msvcrt_acmdln_ptr))
          (then
            (global.set $msvcrt_acmdln_ptr (call $heap_alloc (i32.const 32)))
            ;; Write "CALC\0" at acmdln_ptr
            (i32.store (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 0x434C4143)) ;; "CALC"
            (i32.store8 (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 4)) (i32.const 0))
            ;; Write argv array at acmdln_ptr+8: [acmdln_ptr, 0]
            (i32.store (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 8)) (global.get $msvcrt_acmdln_ptr))
            (i32.store (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 12)) (i32.const 0))
            ;; envp at acmdln_ptr+16: [0]
            (i32.store (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 16)) (i32.const 0))))
        (call $gs32 (local.get $arg1) (i32.add (global.get $msvcrt_acmdln_ptr) (i32.const 8)))  ;; argv
        (call $gs32 (local.get $arg2) (i32.add (global.get $msvcrt_acmdln_ptr) (i32.const 16))) ;; envp
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; __p__fmode(0) "__p_"=0x705F5F  — returns pointer to _fmode global
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x5F705F5F)) (i32.eq (local.get $w1) (i32.const 0x6F6D665F)))
      (then
        (if (i32.eqz (global.get $msvcrt_fmode_ptr))
          (then (global.set $msvcrt_fmode_ptr (call $heap_alloc (i32.const 4)))
                (call $gs32 (global.get $msvcrt_fmode_ptr) (i32.const 0))))
        (global.set $eax (global.get $msvcrt_fmode_ptr))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; __p__commode(0) "__p_"+"_com"=0x6D6F635F
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x5F705F5F)) (i32.eq (local.get $w1) (i32.const 0x6D6F635F)))
      (then
        (if (i32.eqz (global.get $msvcrt_commode_ptr))
          (then (global.set $msvcrt_commode_ptr (call $heap_alloc (i32.const 4)))
                (call $gs32 (global.get $msvcrt_commode_ptr) (i32.const 0))))
        (global.set $eax (global.get $msvcrt_commode_ptr))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; _initterm(2) "_ini"=0x696E695F — calls function pointer table, stub as no-op
    (if (i32.eq (local.get $w0) (i32.const 0x696E695F))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; _controlfp(2) "_con"=0x6E6F635F
    (if (i32.eq (local.get $w0) (i32.const 0x6E6F635F))
      (then (global.set $eax (i32.const 0x0009001F)) ;; default FP control word
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; _acmdln — data import, returns pointer to command line string
    (if (i32.eq (local.get $w0) (i32.const 0x646D635F)) ;; "_cmd" — wait, _acmdln = "_acm"
      (then (nop))) ;; dead
    (if (i32.eq (local.get $w0) (i32.const 0x6D63615F)) ;; "_acm"
      (then
        (if (i32.eqz (global.get $msvcrt_acmdln_ptr))
          (then
            (global.set $msvcrt_acmdln_ptr (call $heap_alloc (i32.const 32)))
            (i32.store (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 0x434C4143))
            (i32.store8 (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 4)) (i32.const 0))))
        (global.set $eax (global.get $msvcrt_acmdln_ptr))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; _strrev(1) "_str"=0x7274735F + "ev\0"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x7274735F))
                 (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 4))) (i32.const 0x65))) ;; 'e' in _strrev
      (then
        ;; Implement _strrev: reverse string in-place
        (local.set $i (call $g2w (local.get $arg0)))  ;; start pointer (wasm addr)
        (local.set $j (local.get $i))
        ;; Find end of string
        (block $end (loop $find
          (br_if $end (i32.eqz (i32.load8_u (local.get $j))))
          (local.set $j (i32.add (local.get $j) (i32.const 1)))
          (br $find)))
        ;; j now points to null terminator; back up one
        (if (i32.gt_u (local.get $j) (local.get $i))
          (then (local.set $j (i32.sub (local.get $j) (i32.const 1)))))
        ;; Swap from both ends
        (block $done (loop $swap
          (br_if $done (i32.ge_u (local.get $i) (local.get $j)))
          (local.set $v (i32.load8_u (local.get $i)))
          (i32.store8 (local.get $i) (i32.load8_u (local.get $j)))
          (i32.store8 (local.get $j) (local.get $v))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (local.set $j (i32.sub (local.get $j) (i32.const 1)))
          (br $swap)))
        (global.set $eax (local.get $arg0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; toupper(1) "toup"=0x70756F74
    (if (i32.eq (local.get $w0) (i32.const 0x70756F74))
      (then
        ;; Simple ASCII toupper
        (if (i32.and (i32.ge_u (local.get $arg0) (i32.const 0x61)) (i32.le_u (local.get $arg0) (i32.const 0x7A)))
          (then (global.set $eax (i32.sub (local.get $arg0) (i32.const 0x20))))
          (else (global.set $eax (local.get $arg0))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; memmove(3) "memm"=0x6D6D656D
    (if (i32.eq (local.get $w0) (i32.const 0x6D6D656D))
      (then (call $memcpy (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (local.get $arg2))
            (global.set $eax (local.get $arg0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; strchr(2) "strc"=0x63727473
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x63727473))
                 (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 4))) (i32.const 0x68))) ;; 'h' in strchr
      (then
        ;; Implement strchr(str, char) — find char in string, return ptr or NULL
        (local.set $i (call $g2w (local.get $arg0)))
        (local.set $v (i32.and (local.get $arg1) (i32.const 0xFF)))
        (global.set $eax (i32.const 0)) ;; default: not found
        (block $done (loop $scan
          (local.set $j (i32.load8_u (local.get $i)))
          (if (i32.eq (local.get $j) (local.get $v))
            (then (global.set $eax (i32.add (i32.sub (local.get $i) (global.get $GUEST_BASE)) (global.get $image_base))) (br $done)))
          (br_if $done (i32.eqz (local.get $j)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $scan)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; _XcptFilter(2) "_Xcp"=0x70635F58... actually "_Xcp"
    (if (i32.eq (local.get $w0) (i32.const 0x70635858)) ;; wrong, let me recalc
      (then (nop))) ;; placeholder
    ;; "_Xcp" = 5F 58 63 70 = 0x7063585F
    (if (i32.eq (local.get $w0) (i32.const 0x7063585F))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; _CxxThrowException(2) "_Cxx"=0x7878435F  — cdecl, 2 args
    ;; arg0 = exception object ptr, arg1 = ThrowInfo ptr
    ;; Walk SEH chain, find matching C++ catch handler, unwind and dispatch.
    (if (i32.eq (local.get $w0) (i32.const 0x7878435F))
      (then
        (local.set $tmp (call $gl32 (global.get $fs_base))) ;; SEH chain head
        (block $found (loop $lp
          (br_if $found (i32.or (i32.eq (local.get $tmp) (i32.const 0xFFFFFFFF))
                                (i32.eqz (local.get $tmp))))
          ;; SEH record at $tmp: [+0]=next, [+4]=handler
          (local.set $msg_ptr (call $gl32 (i32.add (local.get $tmp) (i32.const 4)))) ;; handler addr
          (if (i32.and (i32.ge_u (local.get $msg_ptr) (global.get $image_base))
                       (i32.lt_u (local.get $msg_ptr) (i32.add (global.get $image_base) (i32.const 0x200000))))
            (then
              ;; Check for __ehhandler stub: B8 <FuncInfo addr> E9 <jmp>
              (if (i32.eq (i32.load8_u (call $g2w (local.get $msg_ptr))) (i32.const 0xB8))
                (then
                  ;; Extract FuncInfo address from MOV EAX, <addr>
                  (local.set $name_rva (i32.load (call $g2w (i32.add (local.get $msg_ptr) (i32.const 1)))))
                  ;; Verify FuncInfo magic (0x19930520-0x19930523)
                  (if (i32.eq (i32.and (i32.load (call $g2w (local.get $name_rva))) (i32.const 0xFFFFFFFC))
                              (i32.const 0x19930520))
                    (then
                      ;; FuncInfo: [+0]=magic, [+4]=nUnwind, [+8]=unwindMap,
                      ;;           [+12]=nTryBlocks, [+16]=tryBlockMap
                      ;; Derive frame EBP: _EH_prolog puts SEH record at EBP-C
                      (local.set $w0 (i32.add (local.get $tmp) (i32.const 12))) ;; frame EBP
                      ;; Read trylevel from [EBP-4]
                      (local.set $w1 (i32.load (call $g2w (i32.sub (local.get $w0) (i32.const 4)))))
                      ;; Walk try blocks to find one matching trylevel
                      (local.set $w2 (i32.load (call $g2w (i32.add (local.get $name_rva) (i32.const 12))))) ;; nTryBlocks
                      (local.set $msg_ptr (i32.load (call $g2w (i32.add (local.get $name_rva) (i32.const 16))))) ;; tryBlockMap
                      (block $tb_done (loop $tb_lp
                        (br_if $tb_done (i32.le_s (local.get $w2) (i32.const 0)))
                        ;; TryBlockMapEntry: [+0]=tryLow, [+4]=tryHigh, [+8]=catchHigh,
                        ;;                   [+12]=nCatches, [+16]=catchArray
                        (if (i32.and
                              (i32.le_s (i32.load (call $g2w (local.get $msg_ptr))) (local.get $w1)) ;; tryLow <= trylevel
                              (i32.ge_s (i32.load (call $g2w (i32.add (local.get $msg_ptr) (i32.const 4)))) (local.get $w1))) ;; tryHigh >= trylevel
                          (then
                            ;; Found matching try block! Get first catch handler.
                            ;; HandlerType: [+0]=flags, [+4]=typeInfo, [+8]=dispCatchObj, [+12]=handler
                            (local.set $arg2 (i32.load (call $g2w (i32.add (local.get $msg_ptr) (i32.const 16))))) ;; catchArray
                            (local.set $arg3 (i32.load (call $g2w (i32.add (local.get $arg2) (i32.const 8))))) ;; dispCatchObj
                            (local.set $arg4 (i32.load (call $g2w (i32.add (local.get $arg2) (i32.const 12))))) ;; handler addr
                            ;; Update trylevel to catchHigh (state after catch)
                            (call $gs32 (call $g2w (i32.sub (local.get $w0) (i32.const 4)))
                              (i32.load (call $g2w (i32.add (local.get $msg_ptr) (i32.const 8))))) ;; catchHigh
                            ;; Restore SEH chain: unwind to this frame's prev
                            (call $gs32 (global.get $fs_base) (call $gl32 (local.get $tmp)))
                            ;; Set up catch context
                            (global.set $ebp (local.get $w0))
                            (global.set $esp (local.get $tmp)) ;; ESP = SEH record = EBP-C
                            ;; Store exception object at [EBP+dispCatchObj] if nonzero
                            (if (local.get $arg3)
                              (then (call $gs32 (call $g2w (i32.add (local.get $w0) (local.get $arg3)))
                                                (local.get $arg0))))
                            ;; Push catch-return thunk as return address for funclet
                            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
                            (call $gs32 (global.get $esp) (global.get $catch_ret_thunk))
                            ;; Jump to catch funclet (returns continuation addr in EAX)
                            (global.set $eip (local.get $arg4))
                            (return)))
                        (local.set $msg_ptr (i32.add (local.get $msg_ptr) (i32.const 20))) ;; next try block
                        (local.set $w2 (i32.sub (local.get $w2) (i32.const 1)))
                        (br $tb_lp)))
                      ))))))
          ;; Move to next SEH record
          (local.set $tmp (call $gl32 (local.get $tmp)))
          (br $lp)))
        ;; No catch found — return from throw (skip exception as fallback)
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; _EH_prolog — stack frame setup for structured exception handling
    ;; "_EH_"=0x5F48455F
    ;; On entry: EAX = funcinfo/handler ptr, [ESP] = return addr
    ;; Stack layout after:
    ;;   [EBP+0]=old_ebp, [EBP-4]=-1 (trylevel), [EBP-8]=handler, [EBP-C]=prev_SEH
    ;;   SEH record at EBP-C: {next=old_fs:[0], handler=EAX}
    ;;   fs:[0] = EBP-C (new SEH chain head)
    (if (i32.eq (local.get $w0) (i32.const 0x5F48455F))
      (then
        (local.set $tmp (call $gl32 (global.get $esp))) ;; save return addr
        ;; Replace [ESP] with old EBP (this becomes [EBP+0] = saved EBP)
        (call $gs32 (global.get $esp) (global.get $ebp))
        ;; Set EBP = ESP (pointing to saved EBP)
        (global.set $ebp (global.get $esp))
        ;; Push -1 (trylevel)
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (i32.const -1))           ;; [EBP-4] = trylevel
        ;; Push handler (EAX) — this is also the SEH record's handler field
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $eax))        ;; [EBP-8] = handler
        ;; Push old SEH chain head (fs:[0]) — this is the SEH record's next field
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (call $gl32 (global.get $fs_base))) ;; [EBP-C] = prev SEH
        ;; Register new SEH frame: fs:[0] = &[EBP-C] = ESP
        (call $gs32 (global.get $fs_base) (global.get $esp))
        ;; EAX = EBP (matches real _EH_prolog behavior)
        (global.set $eax (global.get $ebp))
        ;; Return to caller
        (global.set $eip (local.get $tmp))
        (return)))

    ;; Generic _* CRT stubs — cdecl, only pop return address
    (if (i32.eq (i32.load8_u (local.get $name_ptr)) (i32.const 0x5F))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; C++ mangled names ??* — thiscall/cdecl, pop ret only
    (if (i32.eq (i32.load16_u (local.get $name_ptr)) (i32.const 0x3F3F))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; ================================================================
    ;; FALLBACK — log and return 0
    ;; ================================================================
    (call $host_log (local.get $name_ptr) (i32.const 48))
    ;; Stack hexdump: ret addr + 6 args
    (call $host_log_i32 (call $gl32 (global.get $esp)))
    (call $host_log_i32 (call $gl32 (i32.add (global.get $esp) (i32.const 4))))
    (call $host_log_i32 (call $gl32 (i32.add (global.get $esp) (i32.const 8))))
    (call $host_log_i32 (call $gl32 (i32.add (global.get $esp) (i32.const 12))))
    (call $host_log_i32 (call $gl32 (i32.add (global.get $esp) (i32.const 16))))
    (call $host_log_i32 (call $gl32 (i32.add (global.get $esp) (i32.const 20))))
    (call $host_log_i32 (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (global.set $eax (i32.const 0))
    ;; Conservative: pop ret + 4 args = 20. May be wrong but better than crashing.
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; Sub-dispatchers for grouped APIs
  (func $dispatch_local (param $name i32) (param $a0 i32) (param $a1 i32) (param $a2 i32)
    (local $ch i32) (local.set $ch (i32.load8_u (i32.add (local.get $name) (i32.const 5))))
    (if (i32.eq (local.get $ch) (i32.const 0x41)) ;; LocalAlloc
      (then (global.set $eax (call $heap_alloc (local.get $a1)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x46)) ;; LocalFree
      (then (call $heap_free (local.get $a0))
            (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x4C)) ;; LocalLock
      (then (global.set $eax (local.get $a0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x55)) ;; LocalUnlock
      (then (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x52)) ;; LocalReAlloc
      (then (global.set $eax (local.get $a0)) (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $dispatch_global (param $name i32) (param $a0 i32) (param $a1 i32) (param $a2 i32)
    (local $ch i32) (local.set $ch (i32.load8_u (i32.add (local.get $name) (i32.const 6))))
    (if (i32.eq (local.get $ch) (i32.const 0x41)) ;; GlobalAlloc
      (then (global.set $eax (call $heap_alloc (local.get $a1)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x46)) ;; GlobalFree
      (then (call $heap_free (local.get $a0))
            (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x4C)) ;; GlobalLock
      (then (global.set $eax (local.get $a0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x55)) ;; GlobalUnlock
      (then (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x53)) ;; GlobalSize
      (then (global.set $eax (i32.const 4096)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x52)) ;; GlobalReAlloc
      (then (global.set $eax (local.get $a0)) (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x43)) ;; GlobalCompact
      (then (global.set $eax (i32.const 0x100000)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

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
        ;; lstrcmpA(2) / lstrcmpiA(2) — byte-by-byte comparison
        (global.set $eax (call $guest_stricmp (local.get $a0) (local.get $a1)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    ;; fallback
    (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

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
    (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

