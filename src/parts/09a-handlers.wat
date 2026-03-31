  ;; ============================================================
  ;; WIN32 API HANDLER FUNCTIONS
  ;; Hand-written implementations called from the generated dispatch.
  ;; Each handler receives (arg0..arg4, name_ptr) and must set $eax
  ;; and adjust $esp for stdcall cleanup before returning.
  ;; ============================================================

  ;; 0: ExitProcess
  (func $handle_ExitProcess (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (call $host_exit (local.get $arg0)) (global.set $eip (i32.const 0)) (global.set $steps (i32.const 0)) (return)
  )

  ;; 1: GetModuleHandleA
  (func $handle_GetModuleHandleA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $image_base))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 2: GetCommandLineA
  (func $handle_GetCommandLineA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $store_fake_cmdline) (global.set $eax (global.get $fake_cmdline_addr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 3: GetStartupInfoA
  (func $handle_GetStartupInfoA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $zero_memory (call $g2w (local.get $arg0)) (i32.const 68))
    (call $gs32 (local.get $arg0) (i32.const 68))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 4: GetProcAddress
  (func $handle_GetProcAddress (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $v i32)
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
    ;; Create thunk: store RVA and api_id at THUNK_BASE + num_thunks*8
    (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
    (i32.sub (local.get $v) (global.get $image_base)))
    ;; Store api_id via hash lookup
    (i32.store (i32.add (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8))) (i32.const 4))
    (call $lookup_api_id (i32.add (call $g2w (local.get $v)) (i32.const 2))))
    ;; Compute guest address of this thunk
    (global.set $eax (i32.add
    (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
    (global.get $GUEST_BASE))
    (global.get $image_base)))
    (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))
    (call $update_thunk_end))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 5: GetLastError
  (func $handle_GetLastError (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $last_error))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 6: GetLocalTime
  (func $handle_GetLocalTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $zero_memory (call $g2w (local.get $arg0)) (i32.const 16))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 7: GetTimeFormatA
  (func $handle_GetTimeFormatA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
  )

  ;; 8: GetDateFormatA
  (func $handle_GetDateFormatA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
  )

  ;; 9: GetProfileStringA
  (func $handle_GetProfileStringA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 10: GetProfileIntA
  (func $handle_GetProfileIntA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 11: GetLocaleInfoA
  (func $handle_GetLocaleInfoA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 12: LoadLibraryA
  (func $handle_LoadLibraryA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    (local.set $tmp (call $find_loaded_dll (local.get $arg0)))
    (if (i32.ge_s (local.get $tmp) (i32.const 0))
      (then (global.set $eax (i32.load (i32.add (global.get $DLL_TABLE) (i32.mul (local.get $tmp) (i32.const 32))))))
      (else (global.set $eax (global.get $image_base)))) ;; fallback: return EXE base
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 13: DeleteFileA
  (func $handle_DeleteFileA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0)) (global.set $last_error (i32.const 2))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 14: CreateFileA
  (func $handle_CreateFileA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0xFFFFFFFF))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32))) (return)
  )

  ;; 15: FindFirstFileA
  (func $handle_FindFirstFileA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0xFFFFFFFF))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 16: FindClose
  (func $handle_FindClose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 17: MulDiv
  (func $handle_MulDiv (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (local.get $arg2))
    (then (global.set $eax (i32.const -1)))
    (else (global.set $eax (i32.wrap_i64 (i64.div_s
    (i64.mul (i64.extend_i32_s (local.get $arg0)) (i64.extend_i32_s (local.get $arg1)))
    (i64.extend_i32_s (local.get $arg2)))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 18: RtlMoveMemory
  (func $handle_RtlMoveMemory (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $memcpy (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (local.get $arg2))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 19: _lcreat
  (func $handle__lcreat (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0xFFFFFFFF))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 20: _lopen
  (func $handle__lopen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0xFFFFFFFF))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 21: _lwrite
  (func $handle__lwrite (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0xFFFFFFFF))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 22: _llseek
  (func $handle__llseek (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0xFFFFFFFF))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 23: _lclose
  (func $handle__lclose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 24: _lread
  (func $handle__lread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 25: Sleep
  (func $handle_Sleep (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 26: CloseHandle
  (func $handle_CloseHandle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 27: CreateEventA
  (func $handle_CreateEventA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x70001)) ;; fake event handle
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 28: CreateThread
  (func $handle_CreateThread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x70002)) ;; fake thread handle
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
  )

  ;; 29: WaitForSingleObject
  (func $handle_WaitForSingleObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0)) ;; WAIT_OBJECT_0
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 30: ResetEvent
  (func $handle_ResetEvent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 31: SetEvent
  (func $handle_SetEvent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 32: WriteProfileStringA
  (func $handle_WriteProfileStringA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 33: HeapCreate
  (func $handle_HeapCreate (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x00080000)) ;; fake heap handle
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 34: HeapDestroy
  (func $handle_HeapDestroy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 35: HeapAlloc
  (func $handle_HeapAlloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $heap_alloc (local.get $arg2)))
    ;; Zero memory if HEAP_ZERO_MEMORY (0x08)
    (if (i32.and (local.get $arg1) (i32.const 0x08))
    (then (call $zero_memory (call $g2w (global.get $eax)) (local.get $arg2))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 36: HeapFree
  (func $handle_HeapFree (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $heap_free (local.get $arg2))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 37: HeapReAlloc
  (func $handle_HeapReAlloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    (local.set $tmp (call $heap_alloc (local.get $arg3)))
    (if (local.get $tmp)
    (then
    (if (local.get $arg2) ;; old ptr
    (then (call $memcpy (call $g2w (local.get $tmp)) (call $g2w (local.get $arg2)) (local.get $arg3))
    (call $heap_free (local.get $arg2))))))
    (global.set $eax (local.get $tmp))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 38: VirtualAlloc
  (func $handle_VirtualAlloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg0)
    (then (global.set $eax (local.get $arg0))) ;; requested address, just return it
    (else (global.set $eax (call $heap_alloc (local.get $arg1)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 39: VirtualFree
  (func $handle_VirtualFree (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 40: GetACP
  (func $handle_GetACP (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1252))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 41: GetOEMCP
  (func $handle_GetOEMCP (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 437))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 42: GetCPInfo
  (func $handle_GetCPInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CPINFO struct: MaxCharSize(4), DefaultChar[2](2), LeadByte[12](12)
    (call $zero_memory (call $g2w (local.get $arg1)) (i32.const 18))
    (call $gs32 (local.get $arg1) (i32.const 1)) ;; MaxCharSize = 1 (single-byte)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 43: MultiByteToWideChar
  (func $handle_MultiByteToWideChar (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $v i32) (local $i i32)
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
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
  )

  ;; 44: WideCharToMultiByte
  (func $handle_WideCharToMultiByte (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $v i32) (local $i i32)
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
    (global.set $esp (i32.add (global.get $esp) (i32.const 36))) (return)
  )

  ;; 45: GetStringTypeA
  (func $handle_GetStringTypeA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 46: GetStringTypeW
  (func $handle_GetStringTypeW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 47: LCMapStringA
  (func $handle_LCMapStringA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
  )

  ;; 48: LCMapStringW
  (func $handle_LCMapStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; STD_INPUT=0xFFFFFFF6(-10), STD_OUTPUT=0xFFFFFFF5(-11), STD_ERROR=0xFFFFFFF4(-12)
    (global.set $eax (i32.add (i32.const 0x40000) (i32.and (local.get $arg0) (i32.const 0xFF))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 49: GetStdHandle
  (func $handle_GetStdHandle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; STD_INPUT=0xFFFFFFF6(-10), STD_OUTPUT=0xFFFFFFF5(-11), STD_ERROR=0xFFFFFFF4(-12)
    (global.set $eax (i32.add (i32.const 0x40000) (i32.and (local.get $arg0) (i32.const 0xFF))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 50: GetFileType
  (func $handle_GetFileType (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 2)) ;; FILE_TYPE_CHAR
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 51: WriteFile
  (func $handle_WriteFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Write number of bytes written to arg2 (lpNumberOfBytesWritten)
    (if (local.get $arg2)
    (then (call $gs32 (local.get $arg2) (local.get $arg1))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 52: SetHandleCount
  (func $handle_SetHandleCount (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 53: GetEnvironmentStrings
  (func $handle_GetEnvironmentStrings (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    ;; Return "A=B\0\0" — must be non-empty so CRT sets _environ
    (local.set $tmp (call $heap_alloc (i32.const 8)))
    (call $gs32 (local.get $tmp) (i32.const 0x423D41))  ;; "A=B\0"
    (call $gs32 (i32.add (local.get $tmp) (i32.const 4)) (i32.const 0))
    (global.set $eax (local.get $tmp))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 54: GetModuleFileNameA
  (func $handle_GetModuleFileNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Write "C:\\app.exe" to buffer
    (i32.store (call $g2w (local.get $arg1)) (i32.const 0x615C3A43)) ;; "C:\a"
    (i32.store (i32.add (call $g2w (local.get $arg1)) (i32.const 4)) (i32.const 0x652E7070)) ;; "pp.e"
    (i32.store16 (i32.add (call $g2w (local.get $arg1)) (i32.const 8)) (i32.const 0x6578)) ;; "xe"
    (i32.store8 (i32.add (call $g2w (local.get $arg1)) (i32.const 10)) (i32.const 0))
    (global.set $eax (i32.const 10))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 55: UnhandledExceptionFilter
  (func $handle_UnhandledExceptionFilter (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0)) ;; EXCEPTION_EXECUTE_HANDLER
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 56: GetCurrentProcess
  (func $handle_GetCurrentProcess (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0xFFFFFFFF)) ;; pseudo-handle
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 57: TerminateProcess
  (func $handle_TerminateProcess (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_exit (local.get $arg1)) (global.set $eip (i32.const 0)) (global.set $steps (i32.const 0)) (return)
  )

  ;; 58: GetTickCount
  (func $handle_GetTickCount (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $tick_count (i32.add (global.get $tick_count) (i32.const 16)))
    (global.set $eax (global.get $tick_count))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 59: FindResourceA
  (func $handle_FindResourceA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; FindResourceA(hModule, lpName, lpType) → HRSRC (RVA of data entry)
    ;; arg0=hModule, arg1=lpName (MAKEINTRESOURCE or string), arg2=lpType
    ;; Walk resource directory: type(arg2) → name(arg1) → first lang → data entry RVA
    (if (i32.eqz (global.get $rsrc_rva))
    (then (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (global.set $eax (call $find_resource (local.get $arg2) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 60: LoadResource
  (func $handle_LoadResource (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; LoadResource(hModule, hrsrc) → returns hrsrc (data entry offset)
    (global.set $eax (local.get $arg1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 61: LockResource
  (func $handle_LockResource (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; LockResource(hGlobal) → pointer to resource data
    ;; hGlobal = offset of data entry in rsrc. Read RVA from it, return image_base + RVA
    (if (i32.eqz (local.get $arg0))
    (then (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (global.set $eax (i32.add (global.get $image_base)
      (call $gl32 (i32.add (global.get $image_base) (local.get $arg0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 62: FreeResource
  (func $handle_FreeResource (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 63: RtlUnwind
  (func $handle_RtlUnwind (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Unlink SEH chain: set FS:[0] = TargetFrame->next
    (if (i32.ne (local.get $arg0) (i32.const 0))
    (then (call $gs32 (global.get $fs_base) (call $gl32 (local.get $arg0)))))
    (global.set $eax (local.get $arg3)) ;; ReturnValue
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 64: FreeLibrary
  (func $handle_FreeLibrary (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 65: sndPlaySoundA
  (func $handle_sndPlaySoundA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 66: RegisterWindowMessageA
  (func $handle_RegisterWindowMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0xC100))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 67: CreateWindowExA
  (func $handle_CreateWindowExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $v i32) (local $i i32)
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
    (global.set $esp (i32.add (global.get $esp) (i32.const 52))) (return)
  )

  ;; 68: CreateDialogParamA
  (func $handle_CreateDialogParamA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Save dialog hwnd for IsChild/SendMessage routing
    (global.set $dlg_hwnd (i32.const 0x10002))
    ;; Clear quit_flag — dialog recreation (e.g. calc mode switch) cancels pending quit
    (global.set $quit_flag (i32.const 0))
    ;; Call host: create_dialog(hwnd, dlg_resource_id)
    (global.set $eax (call $host_create_dialog
    (i32.const 0x10002)    ;; hwnd for dialog
    (local.get $arg1)))    ;; template name/ID
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 69: MessageBoxA
  (func $handle_MessageBoxA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $w1 i32)
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
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 70: MessageBeep
  (func $handle_MessageBeep (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 71: ShowWindow
  (func $handle_ShowWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_show_window (local.get $arg0) (local.get $arg1))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 72: UpdateWindow
  (func $handle_UpdateWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_invalidate (local.get $arg0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 73: GetMessageA
  (func $handle_GetMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $msg_ptr i32) (local $packed i32)
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
    ;; Build CREATESTRUCT at guest address 0x40C800 (scratch area) for lParam
    ;; Layout: lpCreateParams(0), hInstance(4), hMenu(8), hwndParent(12),
    ;;         cy(16), cx(20), y(24), x(28), style(32), lpszName(36), lpszClass(40), dwExStyle(44)
    (if (global.get $pending_wm_create)
    (then
    (global.set $pending_wm_create (i32.const 0))
    (call $gs32 (i32.const 0x400100) (i32.const 0))                 ;; lpCreateParams
    (call $gs32 (i32.const 0x400110) (global.get $main_win_cy))    ;; cy (+16)
    (call $gs32 (i32.const 0x400114) (global.get $main_win_cx))    ;; cx (+20)
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0001)) ;; WM_CREATE
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0x400100)) ;; lParam = &CREATESTRUCT
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
    ;; Phase 0: send WM_ACTIVATE first (game needs activation before paint)
    (if (i32.eqz (global.get $msg_phase))
    (then
    (global.set $msg_phase (i32.const 1))
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0006)) ;; WM_ACTIVATE
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 1))      ;; WA_ACTIVE
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (global.get $main_hwnd)) ;; lParam (non-zero)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Phase 1: send WM_ERASEBKGND (wParam = hdc)
    (if (i32.eq (global.get $msg_phase) (i32.const 1))
    (then
    (global.set $msg_phase (i32.const 2))
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0014)) ;; WM_ERASEBKGND
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0x50001)) ;; wParam = hdc
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Phase 2: send WM_PAINT
    (if (i32.eq (global.get $msg_phase) (i32.const 2))
    (then
    (global.set $msg_phase (i32.const 3))
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x000F)) ;; WM_PAINT
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
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
    ;; No input — deliver WM_PAINT if pending (lowest priority per Win32 spec)
    (if (global.get $paint_pending)
    (then
    (global.set $paint_pending (i32.const 0))
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x000F)) ;; WM_PAINT
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; No paint — deliver WM_TIMER if timer is active
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
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 74: PeekMessageA
  (func $handle_PeekMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 75: DispatchMessageA
  (func $handle_DispatchMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
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
    (call $gs32 (global.get $esp) (global.get $tick_count)) ;; dwTime
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
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 76: TranslateAcceleratorA
  (func $handle_TranslateAcceleratorA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 77: TranslateMessage
  (func $handle_TranslateMessage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 78: DefWindowProcA
  (func $handle_DefWindowProcA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; WM_CLOSE (0x10): call DestroyWindow(hwnd)
    (if (i32.eq (local.get $arg1) (i32.const 0x0010))
    (then
    ;; DestroyWindow sends WM_DESTROY to WndProc
    ;; For now, just set quit_flag directly since WM_DESTROY→PostQuitMessage
    (global.set $quit_flag (i32.const 1))))
    ;; WM_ERASEBKGND (0x14): fill client area with background brush
    (if (i32.eq (local.get $arg1) (i32.const 0x0014))
    (then
    (global.set $eax (call $host_erase_background (local.get $arg0) (global.get $wndclass_bg_brush)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 79: PostQuitMessage
  (func $handle_PostQuitMessage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $quit_flag (i32.const 1))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 80: PostMessageA
  (func $handle_PostMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
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
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 81: SendMessageA
  (func $handle_SendMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
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
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 82: SendDlgItemMessageA
  (func $handle_SendDlgItemMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 83: DestroyWindow
  (func $handle_DestroyWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Set quit_flag when destroying main or dialog window.
    ;; For mode switches (e.g. calc Scientific), CreateDialogParamA clears quit_flag.
    (if (i32.or (i32.eq (local.get $arg0) (global.get $main_hwnd))
    (i32.eq (local.get $arg0) (global.get $dlg_hwnd)))
    (then (global.set $quit_flag (i32.const 1))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 84: DestroyMenu
  (func $handle_DestroyMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 85: GetDC
  (func $handle_GetDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $window_dc_hwnd (local.get $arg0)) ;; track which window owns the DC
    (global.set $eax (i32.const 0x50001)) ;; fake HDC
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 86: GetDeviceCaps
  (func $handle_GetDeviceCaps (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $screen i32)
    ;; Return reasonable defaults for common caps
    ;; HORZRES=8, VERTRES=10, LOGPIXELSX=88, LOGPIXELSY=90
    (if (i32.or (i32.eq (local.get $arg1) (i32.const 8)) (i32.eq (local.get $arg1) (i32.const 10)))
    (then
    (local.set $screen (call $host_get_screen_size))
    (if (i32.eq (local.get $arg1) (i32.const 8))
    (then (global.set $eax (i32.and (local.get $screen) (i32.const 0xFFFF)))))  ;; HORZRES
    (if (i32.eq (local.get $arg1) (i32.const 10))
    (then (global.set $eax (i32.shr_u (local.get $screen) (i32.const 16)))))))
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
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 87: GetMenu
  (func $handle_GetMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x40001)) ;; fake HMENU
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 88: GetSubMenu
  (func $handle_GetSubMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x40002))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 89: GetSystemMenu
  (func $handle_GetSystemMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
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
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 90: GetSystemMetrics (actual slot used by imports)
  (func $handle_GetSystemMetrics (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
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
    (if (i32.eq (local.get $arg0) (i32.const 7))  ;; SM_CXFIXEDFRAME
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
    (if (i32.eq (local.get $arg0) (i32.const 32)) ;; SM_CXFRAME
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
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 91: GetClientRect
  (func $handle_GetClientRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Fill RECT with client area (use window dims minus frame)
    (call $gs32 (local.get $arg1) (i32.const 0))       ;; left
    (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))   ;; top
    (call $gs32 (i32.add (local.get $arg1) (i32.const 8)) (i32.sub (global.get $main_win_cx) (i32.const 6))) ;; right = cx - frame
    (call $gs32 (i32.add (local.get $arg1) (i32.const 12)) (i32.sub (global.get $main_win_cy) (i32.const 45)));; bottom = cy - caption - frame
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 92: GetWindowTextA
  (func $handle_GetWindowTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return empty string
    (if (i32.gt_u (local.get $arg2) (i32.const 0))
    (then (call $gs8 (local.get $arg1) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 93: GetWindowRect
  (func $handle_GetWindowRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $gs32 (local.get $arg1) (i32.const 0))
    (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))
    (call $gs32 (i32.add (local.get $arg1) (i32.const 8)) (i32.const 640))
    (call $gs32 (i32.add (local.get $arg1) (i32.const 12)) (i32.const 480))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 94: GetDlgCtrlID
  (func $handle_GetDlgCtrlID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 95: GetDlgItemTextA
  (func $handle_GetDlgItemTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.gt_u (local.get $arg3) (i32.const 0))
    (then (call $gs8 (local.get $arg2) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 96: GetDlgItem
  (func $handle_GetDlgItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 97: GetCursorPos
  (func $handle_GetCursorPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $gs32 (local.get $arg0) (i32.const 0))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 98: GetLastActivePopup
  (func $handle_GetLastActivePopup (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 99: GetFocus
  (func $handle_GetFocus (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $main_hwnd))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 100: ReleaseDC
  (func $handle_ReleaseDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 101: SetWindowLongA
  (func $handle_SetWindowLongA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 102: SetWindowTextA
  (func $handle_SetWindowTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_set_window_text (local.get $arg0) (call $g2w (local.get $arg1)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 103: SetDlgItemTextA
  (func $handle_SetDlgItemTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_set_dlg_item_text
    (local.get $arg0)                          ;; hDlg
    (local.get $arg1)                          ;; nIDDlgItem
    (call $g2w (local.get $arg2)))             ;; lpString → WASM ptr
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 104: SetDlgItemInt
  (func $handle_SetDlgItemInt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 105: SetForegroundWindow
  (func $handle_SetForegroundWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 106: SetCursor
  (func $handle_SetCursor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x20001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 107: SetFocus
  (func $handle_SetFocus (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $main_hwnd))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 108: LoadCursorA
  (func $handle_LoadCursorA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x20001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 109: LoadIconA
  (func $handle_LoadIconA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x20002))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 110: LoadStringA
  (func $handle_LoadStringA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Call host to write string from resource JSON into guest buffer
    (global.set $eax (call $host_load_string
    (local.get $arg1)                ;; string ID
    (call $g2w (local.get $arg2))    ;; buffer (WASM ptr)
    (local.get $arg3)))              ;; max chars
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 111: LoadAcceleratorsA
  (func $handle_LoadAcceleratorsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $haccel (i32.const 0x60001))
    (global.set $eax (i32.const 0x60001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 112: EnableWindow
  (func $handle_EnableWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 113: EnableMenuItem
  (func $handle_EnableMenuItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 114: EndDialog
  (func $handle_EndDialog (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 115: InvalidateRect
  (func $handle_InvalidateRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $paint_pending (i32.const 1))
    (call $host_invalidate (local.get $arg0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 116: FillRect
  (func $handle_FillRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 117: FrameRect
  (func $handle_FrameRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 118: LoadBitmapA
  (func $handle_LoadBitmapA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    ;; arg1 = resource ID (MAKEINTRESOURCE value, low 16 bits)
    (local.set $tmp (call $host_gdi_load_bitmap (i32.and (local.get $arg1) (i32.const 0xFFFF))))
    ;; If host couldn't find it, return a fake 32x32 bitmap
    (if (i32.eqz (local.get $tmp))
    (then (local.set $tmp (call $host_gdi_create_compat_bitmap (i32.const 0) (i32.const 32) (i32.const 32)))))
    (global.set $eax (local.get $tmp))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 119: OpenIcon
  (func $handle_OpenIcon (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 120: MoveWindow — hwnd(arg0), x(arg1), y(arg2), w(arg3), h(arg4), bRepaint=[esp+24]
  (func $handle_MoveWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_move_window (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
  )

  ;; 121: CheckMenuRadioItem
  (func $handle_CheckMenuRadioItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 122: CheckMenuItem
  (func $handle_CheckMenuItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 123: CheckRadioButton
  (func $handle_CheckRadioButton (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_check_radio_button (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 124: CheckDlgButton
  (func $handle_CheckDlgButton (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_check_dlg_button (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 125: CharNextA
  (func $handle_CharNextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return ptr+1 (simple ANSI impl)
    (if (i32.eqz (call $gl8 (local.get $arg0)))
    (then (global.set $eax (local.get $arg0)))
    (else (global.set $eax (i32.add (local.get $arg0) (i32.const 1)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 126: CharPrevA
  (func $handle_CharPrevA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return max(start, ptr-1)
    (if (i32.le_u (local.get $arg1) (local.get $arg0))
    (then (global.set $eax (local.get $arg0)))
    (else (global.set $eax (i32.sub (local.get $arg1) (i32.const 1)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 127: IsDialogMessageA
  (func $handle_IsDialogMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 128: IsIconic
  (func $handle_IsIconic (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 129: ChildWindowFromPoint
  (func $handle_ChildWindowFromPoint (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 130: ScreenToClient
  (func $handle_ScreenToClient (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 131: TabbedTextOutA
  (func $handle_TabbedTextOutA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36))) (return)
  )

  ;; 132: WinHelpA
  (func $handle_WinHelpA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 133: IsChild
  (func $handle_IsChild (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (if (result i32) (i32.and
    (i32.ne (global.get $dlg_hwnd) (i32.const 0))
    (i32.eq (local.get $arg0) (global.get $dlg_hwnd)))
    (then (i32.const 1)) (else (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 134: GetSysColorBrush
  (func $handle_GetSysColorBrush (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x30010)) ;; fake HBRUSH
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 135: GetSysColor
  (func $handle_GetSysColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return reasonable defaults for common colors
    ;; COLOR_WINDOW=5 → white, COLOR_BTNFACE=15 → 0xC0C0C0
    (if (i32.eq (local.get $arg0) (i32.const 5))
    (then (global.set $eax (i32.const 0x00FFFFFF)))
    (else (if (i32.eq (local.get $arg0) (i32.const 15))
    (then (global.set $eax (i32.const 0x00C0C0C0)))
    (else (global.set $eax (i32.const 0x00C0C0C0))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 136: DialogBoxParamA
  (func $handle_DialogBoxParamA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 137: LoadMenuA
  (func $handle_LoadMenuA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.or (i32.const 0x40000) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 138: TrackPopupMenuEx
  (func $handle_TrackPopupMenuEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
  )

  ;; 139: OffsetRect
  (func $handle_OffsetRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 140: MapWindowPoints
  (func $handle_MapWindowPoints (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 141: SetWindowPos
  (func $handle_SetWindowPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32))) (return)
  )

  ;; 142: DrawTextA
  (func $handle_DrawTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 16)) ;; return text height
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 143: DrawEdge
  (func $handle_DrawEdge (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 144: GetClipboardData
  (func $handle_GetClipboardData (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 145: SelectObject
  (func $handle_SelectObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_select_object (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 146: DeleteObject
  (func $handle_DeleteObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_delete_object (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 147: DeleteDC
  (func $handle_DeleteDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_delete_dc (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 148: CreatePen
  (func $handle_CreatePen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_create_pen (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 149: CreateSolidBrush
  (func $handle_CreateSolidBrush (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_create_solid_brush (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 150: CreateCompatibleDC
  (func $handle_CreateCompatibleDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_create_compat_dc (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 151: CreateCompatibleBitmap
  (func $handle_CreateCompatibleBitmap (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_create_compat_bitmap (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 152: GetViewportOrgEx
  (func $handle_GetViewportOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Fill POINT with (0,0)
    (if (i32.ne (local.get $arg1) (i32.const 0))
    (then
    (call $gs32 (local.get $arg1) (i32.const 0))
    (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 153: Rectangle
  (func $handle_Rectangle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_rectangle
    (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (global.get $window_dc_hwnd)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 154: MoveToEx
  (func $handle_MoveToEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Save old position to lpPoint (arg3) if non-null
    (global.set $eax (call $host_gdi_move_to (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 155: LineTo
  (func $handle_LineTo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_line_to (local.get $arg0) (local.get $arg1) (local.get $arg2) (global.get $window_dc_hwnd)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 156: Ellipse
  (func $handle_Ellipse (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_ellipse
    (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (global.get $window_dc_hwnd)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 157: Arc
  (func $handle_Arc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_arc
    (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
    (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 32)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 36)))
    (global.get $window_dc_hwnd)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 40))) (return)
  )

  ;; 158: BitBlt
  (func $handle_BitBlt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_bitblt
    (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
    (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 32)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 36)))
    (global.get $window_dc_hwnd)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 40))) (return)
  )

  ;; 159: PatBlt — hdc(arg0), x(arg1), y(arg2), w=[esp+16], h=[esp+20], rop=[esp+24]
  (func $handle_PatBlt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    (local.set $tmp (call $gl32 (i32.add (global.get $esp) (i32.const 24)))) ;; rop
    ;; Use BitBlt with no source DC for WHITENESS/BLACKNESS/PATCOPY
    (drop (call $host_gdi_bitblt
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (call $gl32 (i32.add (global.get $esp) (i32.const 16)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 20)))
      (i32.const 0) (i32.const 0) (i32.const 0)  ;; no source DC
      (local.get $tmp) (global.get $window_dc_hwnd)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
  )

  ;; 160: CreateBitmap — nWidth(arg0), nHeight(arg1), nPlanes(arg2), nBitCount(arg3), lpBits(arg4)
  (func $handle_CreateBitmap (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (local.get $arg4))
      (then
        ;; NULL lpBits — just create blank bitmap
        (global.set $eax (call $host_gdi_create_compat_bitmap (i32.const 0) (local.get $arg0) (local.get $arg1))))
      (else
        ;; Has pixel data — convert via host
        (global.set $eax (call $host_gdi_create_bitmap
          (local.get $arg0) (local.get $arg1) (local.get $arg3)
          (call $g2w (local.get $arg4))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 161: TextOutA — hdc(arg0), x(arg1), y(arg2), lpString(arg3), nCount(arg4)
  (func $handle_TextOutA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_text_out
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (call $g2w (local.get $arg3)) (local.get $arg4)
      (global.get $window_dc_hwnd)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 162: GetStockObject — index(arg0) → handle 0x30010+index
  (func $handle_GetStockObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.add (i32.const 0x30010) (i32.and (local.get $arg0) (i32.const 0x1F))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 163: GetObjectA
  (func $handle_GetObjectA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    (if (i32.gt_u (local.get $arg1) (i32.const 0))
    (then (call $zero_memory (call $g2w (local.get $arg2)) (local.get $arg1))))
    ;; Try to fill BITMAP struct if it's a bitmap object
    (local.set $tmp (call $host_gdi_get_object_w (local.get $arg0)))
    (if (i32.ne (local.get $tmp) (i32.const 0))
    (then
    ;; BITMAP: bmType(0,4), bmWidth(+4,4), bmHeight(+8,4), bmWidthBytes(+12,4), bmPlanes(+16,2), bmBitsPixel(+18,2), bmBits(+20,4)
    (if (i32.ge_u (local.get $arg1) (i32.const 24))
    (then
    (call $gs32 (i32.add (local.get $arg2) (i32.const 4)) (local.get $tmp))  ;; bmWidth
    (call $gs32 (i32.add (local.get $arg2) (i32.const 8)) (call $host_gdi_get_object_h (local.get $arg0))) ;; bmHeight
    (call $gs32 (i32.add (local.get $arg2) (i32.const 12))
    (i32.mul (local.get $tmp) (i32.const 4))) ;; bmWidthBytes (assuming 32bpp)
    (call $gs16 (i32.add (local.get $arg2) (i32.const 16)) (i32.const 1))    ;; bmPlanes
    (call $gs16 (i32.add (local.get $arg2) (i32.const 18)) (i32.const 32))   ;; bmBitsPixel
    ))))
    (global.set $eax (local.get $arg1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 164: GetTextMetricsA
  (func $handle_GetTextMetricsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Fill TEXTMETRIC with reasonable defaults
    (call $zero_memory (call $g2w (local.get $arg1)) (i32.const 56))
    (call $gs32 (local.get $arg1) (i32.const 16))           ;; tmHeight
    (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))  ;; tmAscent (unused detail)
    (call $gs32 (i32.add (local.get $arg1) (i32.const 20)) (i32.const 8)) ;; tmAveCharWidth
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 165: GetTextExtentPointA
  (func $handle_GetTextExtentPointA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Fill SIZE: cx = count*8, cy = 16
    (call $gs32 (local.get $arg3) (i32.mul (local.get $arg2) (i32.const 8)))  ;; cx
    (call $gs32 (i32.add (local.get $arg3) (i32.const 4)) (i32.const 16))     ;; cy
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 166: GetTextCharset
  (func $handle_GetTextCharset (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0)) ;; ANSI_CHARSET
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 167: CreateFontIndirectA
  (func $handle_CreateFontIndirectA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x30003))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 168: CreateFontA
  (func $handle_CreateFontA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x30003))
    (global.set $esp (i32.add (global.get $esp) (i32.const 60))) (return)
  )

  ;; 169: CreateDCA
  (func $handle_CreateDCA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x50002))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 170: SetAbortProc
  (func $handle_SetAbortProc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 171: SetBkColor(hdc, color) → prev color
  (func $handle_SetBkColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_set_bk_color (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 172: SetBkMode(hdc, mode) → prev mode
  (func $handle_SetBkMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_set_bk_mode (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 173: SetTextColor(hdc, color) → prev color
  (func $handle_SetTextColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_set_text_color (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 174: SetMenu
  (func $handle_SetMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_set_menu
    (local.get $arg0)                                       ;; hWnd
    (i32.and (local.get $arg1) (i32.const 0xFFFF)))         ;; resource ID from HMENU
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 175: SetMapMode
  (func $handle_SetMapMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 176: SetWindowExtEx
  (func $handle_SetWindowExtEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 177: LPtoDP
  (func $handle_LPtoDP (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 178: StartDocA
  (func $handle_StartDocA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 179: StartPage
  (func $handle_StartPage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 180: EndPage
  (func $handle_EndPage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 181: EndPaint
  (func $handle_EndPaint (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 182: EndDoc
  (func $handle_EndDoc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 183: AbortDoc
  (func $handle_AbortDoc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 184: SetCapture
  (func $handle_SetCapture (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0)) ;; prev capture hwnd (none)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 185: ReleaseCapture
  (func $handle_ReleaseCapture (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 186: ShowCursor
  (func $handle_ShowCursor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1)) ;; display count
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 187: KillTimer
  (func $handle_KillTimer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 188: SetTimer
  (func $handle_SetTimer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $timer_id (local.get $arg1))
    (global.set $timer_hwnd (local.get $arg0))
    (global.set $timer_callback (local.get $arg3))
    (global.set $eax (local.get $arg1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 189: FindWindowA
  (func $handle_FindWindowA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0)) ;; not found
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 190: BringWindowToTop
  (func $handle_BringWindowToTop (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 191: GetPrivateProfileIntA
  (func $handle_GetPrivateProfileIntA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg2)) ;; return nDefault
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 192: WritePrivateProfileStringA
  (func $handle_WritePrivateProfileStringA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1)) ;; success
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 193: ShellExecuteA
  (func $handle_ShellExecuteA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 33)) ;; > 32 means success
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
  )

  ;; 194: ShellAboutA
  (func $handle_ShellAboutA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_shell_about (local.get $arg0) (call $g2w (local.get $arg1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 195: SHGetSpecialFolderPathA
  (func $handle_SHGetSpecialFolderPathA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 196: DragAcceptFiles
  (func $handle_DragAcceptFiles (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 197: DragQueryFileA
  (func $handle_DragQueryFileA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 198: DragFinish
  (func $handle_DragFinish (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 199: GetOpenFileNameA
  (func $handle_GetOpenFileNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 200: GetFileTitleA
  (func $handle_GetFileTitleA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 201: ChooseFontA
  (func $handle_ChooseFontA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 202: FindTextA
  (func $handle_FindTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 203: PageSetupDlgA
  (func $handle_PageSetupDlgA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 204: CommDlgExtendedError
  (func $handle_CommDlgExtendedError (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 205: exit
  (func $handle_exit (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
    (call $host_exit (local.get $arg0)) (global.set $steps (i32.const 0)) (return)
  )

  ;; 206: _exit
  (func $handle__exit (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
    (call $host_exit (local.get $arg0)) (global.set $steps (i32.const 0)) (return)
  )

  ;; 207: __getmainargs
  (func $handle___getmainargs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
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
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 208: __p__fmode
  (func $handle___p__fmode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (global.get $msvcrt_fmode_ptr))
    (then (global.set $msvcrt_fmode_ptr (call $heap_alloc (i32.const 4)))
    (call $gs32 (global.get $msvcrt_fmode_ptr) (i32.const 0))))
    (global.set $eax (global.get $msvcrt_fmode_ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 209: __p__commode
  (func $handle___p__commode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (global.get $msvcrt_commode_ptr))
    (then (global.set $msvcrt_commode_ptr (call $heap_alloc (i32.const 4)))
    (call $gs32 (global.get $msvcrt_commode_ptr) (i32.const 0))))
    (global.set $eax (global.get $msvcrt_commode_ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 210: _initterm
  (func $handle__initterm (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 211: _controlfp
  (func $handle__controlfp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x0009001F)) ;; default FP control word
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 212: _strrev
  (func $handle__strrev (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $v i32) (local $i i32) (local $j i32)
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
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 213: toupper
  (func $handle_toupper (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Simple ASCII toupper
    (if (i32.and (i32.ge_u (local.get $arg0) (i32.const 0x61)) (i32.le_u (local.get $arg0) (i32.const 0x7A)))
    (then (global.set $eax (i32.sub (local.get $arg0) (i32.const 0x20))))
    (else (global.set $eax (local.get $arg0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 214: memmove
  (func $handle_memmove (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $memcpy (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (local.get $arg2))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 215: strchr
  (func $handle_strchr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $v i32) (local $i i32) (local $j i32)
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
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 216: _XcptFilter
  (func $handle__XcptFilter (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (nop)
  )

  ;; 217: _CxxThrowException
  (func $handle__CxxThrowException (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $msg_ptr i32) (local $w0 i32) (local $w1 i32) (local $w2 i32) (local $name_rva i32)
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
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 218: lstrlenA
  (func $handle_lstrlenA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_lstr (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
  )

  ;; 219: lstrcpyA
  (func $handle_lstrcpyA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_lstr (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
  )

  ;; 220: lstrcatA
  (func $handle_lstrcatA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_lstr (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
  )

  ;; 221: lstrcpynA
  (func $handle_lstrcpynA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_lstr (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
  )

  ;; 222: lstrcmpA
  (func $handle_lstrcmpA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_lstr (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
  )

  ;; 223: RegCloseKey
  (func $handle_RegCloseKey (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_reg (local.get $name_ptr))
  )

  ;; 224: RegCreateKeyA
  (func $handle_RegCreateKeyA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_reg (local.get $name_ptr))
  )

  ;; 225: RegQueryValueExA
  (func $handle_RegQueryValueExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_reg (local.get $name_ptr))
  )

  ;; 226: RegSetValueExA
  (func $handle_RegSetValueExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_reg (local.get $name_ptr))
  )

  ;; 227: LocalAlloc
  (func $handle_LocalAlloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_local (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
  )

  ;; 228: LocalFree
  (func $handle_LocalFree (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_local (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
  )

  ;; 229: LocalLock
  (func $handle_LocalLock (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_local (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
  )

  ;; 230: LocalUnlock
  (func $handle_LocalUnlock (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_local (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
  )

  ;; 231: LocalReAlloc
  (func $handle_LocalReAlloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_local (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
  )

  ;; 232: GlobalAlloc
  (func $handle_GlobalAlloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_global (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
  )

  ;; 233: GlobalFree
  (func $handle_GlobalFree (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_global (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
  )

  ;; 234: GlobalLock
  (func $handle_GlobalLock (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_global (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
  )

  ;; 235: GlobalUnlock
  (func $handle_GlobalUnlock (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_global (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
  )

  ;; 236: GlobalReAlloc
  (func $handle_GlobalReAlloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_global (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
  )

  ;; 237: GlobalSize
  (func $handle_GlobalSize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_global (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
  )

  ;; 238: GlobalCompact
  (func $handle_GlobalCompact (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x100000))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 239: RegOpenKeyA
  (func $handle_RegOpenKeyA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_reg (local.get $name_ptr))
  )

  ;; 240: RegOpenKeyExA
  (func $handle_RegOpenKeyExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; stub
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 241: RegisterClassExA
  (func $handle_RegisterClassExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    ;; WNDCLASSEX: cbSize(+0) style(+4) lpfnWndProc(+8) ... hbrBackground(+32)
    (local.set $tmp (call $gl32 (i32.add (local.get $arg0) (i32.const 8)))) ;; lpfnWndProc
    ;; Store first wndproc as main, subsequent as child
    (if (i32.eqz (global.get $wndproc_addr))
    (then
      (global.set $wndproc_addr (local.get $tmp))
      (global.set $wndclass_style (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
      (global.set $wndclass_bg_brush (call $gl32 (i32.add (local.get $arg0) (i32.const 32)))))
    (else (global.set $wndproc_addr2 (local.get $tmp))))
    (global.set $eax (i32.const 0xC001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 242: RegisterClassA
  (func $handle_RegisterClassA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    ;; WNDCLASSA: style(+0) lpfnWndProc(+4) cbClsExtra(+8) cbWndExtra(+12)
    ;;   hInstance(+16) hIcon(+20) hCursor(+24) hbrBackground(+28)
    ;;   lpszMenuName(+32) lpszClassName(+36)
    (local.set $tmp (call $gl32 (i32.add (local.get $arg0) (i32.const 4)))) ;; lpfnWndProc
    ;; Store first wndproc as main, subsequent as child
    (if (i32.eqz (global.get $wndproc_addr))
    (then
      (global.set $wndproc_addr (local.get $tmp))
      (global.set $wndclass_style (call $gl32 (local.get $arg0)))
      (global.set $wndclass_bg_brush (call $gl32 (i32.add (local.get $arg0) (i32.const 28)))))
    (else (global.set $wndproc_addr2 (local.get $tmp))))
    (global.set $eax (i32.const 0xC001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 243: BeginPaint
  (func $handle_BeginPaint (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Fill PAINTSTRUCT minimally
    (call $zero_memory (call $g2w (local.get $arg1)) (i32.const 64))
    (call $gs32 (local.get $arg1) (i32.const 0x50001)) ;; hdc
    (global.set $window_dc_hwnd (local.get $arg0)) ;; track which window owns the DC
    (global.set $eax (i32.const 0x50001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 244: OpenClipboard
  (func $handle_OpenClipboard (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 245: CloseClipboard
  (func $handle_CloseClipboard (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 246: IsClipboardFormatAvailable
  (func $handle_IsClipboardFormatAvailable (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 247: GetEnvironmentStringsW
  (func $handle_GetEnvironmentStringsW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    ;; Return L"A=B\0\0" (UTF-16LE) — must be non-empty so CRT sets _wenviron
    (local.set $tmp (call $heap_alloc (i32.const 16)))
    (call $gs16 (local.get $tmp) (i32.const 0x41))
    (call $gs16 (i32.add (local.get $tmp) (i32.const 2)) (i32.const 0x3D))
    (call $gs16 (i32.add (local.get $tmp) (i32.const 4)) (i32.const 0x42))
    (call $gs16 (i32.add (local.get $tmp) (i32.const 6)) (i32.const 0))
    (call $gs16 (i32.add (local.get $tmp) (i32.const 8)) (i32.const 0))
    (global.set $eax (local.get $tmp))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 248: GetSaveFileNameA
  (func $handle_GetSaveFileNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 249: SetViewportExtEx
  (func $handle_SetViewportExtEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 250: lstrcmpiA
  (func $handle_lstrcmpiA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_lstr (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
  )

  ;; 251: FreeEnvironmentStringsA
  (func $handle_FreeEnvironmentStringsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; stub
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 252: FreeEnvironmentStringsW
  (func $handle_FreeEnvironmentStringsW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; stub
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 253: GetVersion
  (func $handle_GetVersion (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Format: low byte=major, next byte=minor, high word=build|platform
    ;; Configurable via set_winver: Win98=0xC0000A04, NT4=0x05650004, Win2K=0x05650005
    (global.set $eax (global.get $winver))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 254: GetTextExtentPoint32A
  (func $handle_GetTextExtentPoint32A (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Fill SIZE: cx = count*8, cy = 16
    (call $gs32 (local.get $arg3) (i32.mul (local.get $arg2) (i32.const 8)))  ;; cx
    (call $gs32 (i32.add (local.get $arg3) (i32.const 4)) (i32.const 16))     ;; cy
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 255: wsprintfA
  (func $handle_wsprintfA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; wsprintfA(buf, fmt, ...) — cdecl, caller cleans stack
    (global.set $eax (call $wsprintf_impl
      (local.get $arg0) (local.get $arg1) (i32.add (global.get $esp) (i32.const 12))))
    ;; cdecl: only pop return address
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 256: GetPrivateProfileStringA
  (func $handle_GetPrivateProfileStringA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; stub
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 257: __wgetmainargs
  (func $handle___wgetmainargs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; arg0=&argc, arg1=&argv, arg2=&envp (wide versions)
    (call $gs32 (local.get $arg0) (i32.const 1))     ;; argc = 1
    (if (i32.eqz (global.get $msvcrt_wcmdln_ptr))
    (then
      (global.set $msvcrt_wcmdln_ptr (call $heap_alloc (i32.const 64)))
      ;; Write L"PAINT\0" at wcmdln_ptr (UTF-16LE)
      (call $gs16 (global.get $msvcrt_wcmdln_ptr) (i32.const 0x50))        ;; P
      (call $gs16 (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 2)) (i32.const 0x41))  ;; A
      (call $gs16 (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 4)) (i32.const 0x49))  ;; I
      (call $gs16 (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 6)) (i32.const 0x4E))  ;; N
      (call $gs16 (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 8)) (i32.const 0x54))  ;; T
      (call $gs16 (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 10)) (i32.const 0))    ;; NUL
      ;; argv array at +16: [ptr_to_string, 0]
      (call $gs32 (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 16)) (global.get $msvcrt_wcmdln_ptr))
      (call $gs32 (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 20)) (i32.const 0))
      ;; envp at +24: [0]
      (call $gs32 (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 24)) (i32.const 0))))
    (call $gs32 (local.get $arg1) (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 16)))
    (call $gs32 (local.get $arg2) (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 24)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 258: __p__wcmdln
  (func $handle___p__wcmdln (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (global.get $msvcrt_wcmdln_ptr))
    (then
      (global.set $msvcrt_wcmdln_ptr (call $heap_alloc (i32.const 64)))
      (call $gs16 (global.get $msvcrt_wcmdln_ptr) (i32.const 0))))
    ;; Always ensure ptr-to-ptr at +32 (may have been set by __wgetmainargs without this)
    (call $gs32 (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 32)) (global.get $msvcrt_wcmdln_ptr))
    (global.set $eax (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 32)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 259: __p__acmdln
  (func $handle___p__acmdln (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (global.get $msvcrt_acmdln_ptr))
    (then
      (global.set $msvcrt_acmdln_ptr (call $heap_alloc (i32.const 32)))
      (i32.store (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 0x4E494150)) ;; "PAIN"
      (i32.store8 (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 4)) (i32.const 0x54)) ;; "T"
      (i32.store8 (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 5)) (i32.const 0))
      ;; ptr-to-ptr at +8
      (call $gs32 (i32.add (global.get $msvcrt_acmdln_ptr) (i32.const 8)) (global.get $msvcrt_acmdln_ptr))))
    (global.set $eax (i32.add (global.get $msvcrt_acmdln_ptr) (i32.const 8)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 260: __set_app_type
  (func $handle___set_app_type (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 261: __setusermatherr
  (func $handle___setusermatherr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 262: _adjust_fdiv
  (func $handle__adjust_fdiv (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return pointer to a 0 dword (no FDIV bug)
    (if (i32.eqz (global.get $msvcrt_fmode_ptr))
      (then (global.set $msvcrt_fmode_ptr (call $heap_alloc (i32.const 4)))))
    (global.set $eax (global.get $msvcrt_fmode_ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 263: free
  (func $handle_free (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $heap_free (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 264: malloc
  (func $handle_malloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $heap_alloc (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 265: calloc
  (func $handle_calloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    (local.set $tmp (i32.mul (local.get $arg0) (local.get $arg1)))
    (global.set $eax (call $heap_alloc (local.get $tmp)))
    (call $zero_memory (call $g2w (global.get $eax)) (local.get $tmp))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 266: rand
  (func $handle_rand (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $rand_seed (i32.add (i32.mul (global.get $rand_seed) (i32.const 1103515245)) (i32.const 12345)))
    (global.set $eax (i32.and (i32.shr_u (global.get $rand_seed) (i32.const 16)) (i32.const 0x7FFF)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 267: srand
  (func $handle_srand (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $rand_seed (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 268: _purecall
  (func $handle__purecall (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_exit (i32.const 3))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 269: _onexit
  (func $handle__onexit (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 270: __dllonexit
  (func $handle___dllonexit (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 271: _splitpath — soft-stub
  (func $handle__splitpath (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 272: _wcsicmp
  (func $handle__wcsicmp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $guest_wcsicmp (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 273: _wtoi — wide string to int
  (func $handle__wtoi (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $v i32) (local $i i32)
    (local.set $i (i32.const 0))
    (local.set $tmp (i32.const 0))
    (local.set $v (call $gl16 (local.get $arg0)))
    ;; Skip whitespace
    (block $ws_done (loop $ws
      (br_if $ws_done (i32.ne (local.get $v) (i32.const 0x20)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $v (call $gl16 (i32.add (local.get $arg0) (i32.shl (local.get $i) (i32.const 1)))))
      (br $ws)))
    ;; Parse digits
    (block $done (loop $parse
      (br_if $done (i32.lt_u (local.get $v) (i32.const 0x30)))
      (br_if $done (i32.gt_u (local.get $v) (i32.const 0x39)))
      (local.set $tmp (i32.add (i32.mul (local.get $tmp) (i32.const 10)) (i32.sub (local.get $v) (i32.const 0x30))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $v (call $gl16 (i32.add (local.get $arg0) (i32.shl (local.get $i) (i32.const 1)))))
      (br $parse)))
    (global.set $eax (local.get $tmp))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 274: _itow — int to wide string (stub: write "0")
  (func $handle__itow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $gs16 (local.get $arg1) (i32.const 0x30))
    (call $gs16 (i32.add (local.get $arg1) (i32.const 2)) (i32.const 0))
    (global.set $eax (local.get $arg1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 275: wcscmp
  (func $handle_wcscmp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $guest_wcsicmp (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 276: wcsncpy
  (func $handle_wcsncpy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $v i32) (local $i i32)
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $v (call $gl16 (i32.add (local.get $arg1) (i32.shl (local.get $i) (i32.const 1)))))
      (call $gs16 (i32.add (local.get $arg0) (i32.shl (local.get $i) (i32.const 1))) (local.get $v))
      (br_if $d (i32.eqz (local.get $v)))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 277: wcslen
  (func $handle_wcslen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $guest_wcslen (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 278: memset
  (func $handle_memset (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $zero_memory (call $g2w (local.get $arg0)) (local.get $arg2))
    ;; TODO: handle non-zero fill byte
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 279: memcpy
  (func $handle_memcpy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $memcpy (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (local.get $arg2))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 280: __CxxFrameHandler — C++ exception frame handler (stub, return 1=ExceptionContinueSearch)
  (func $handle___CxxFrameHandler (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 281: _global_unwind2
  (func $handle__global_unwind2 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 282: _getdcwd — stub: return empty string
  (func $handle__getdcwd (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1)
      (then (call $gs8 (local.get $arg1) (i32.const 0))))
    (global.set $eax (local.get $arg1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 283: GetModuleHandleW — same as A version, return image_base
  (func $handle_GetModuleHandleW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $image_base))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 284: GetModuleFileNameW — write L"C:\PAINT.EXE\0"
  (func $handle_GetModuleFileNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $gs16 (local.get $arg1) (i32.const 0x43))
    (call $gs16 (i32.add (local.get $arg1) (i32.const 2)) (i32.const 0x3A))
    (call $gs16 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0x5C))
    (call $gs16 (i32.add (local.get $arg1) (i32.const 6)) (i32.const 0x50))
    (call $gs16 (i32.add (local.get $arg1) (i32.const 8)) (i32.const 0x41))
    (call $gs16 (i32.add (local.get $arg1) (i32.const 10)) (i32.const 0x49))
    (call $gs16 (i32.add (local.get $arg1) (i32.const 12)) (i32.const 0x4E))
    (call $gs16 (i32.add (local.get $arg1) (i32.const 14)) (i32.const 0x54))
    (call $gs16 (i32.add (local.get $arg1) (i32.const 16)) (i32.const 0x2E))
    (call $gs16 (i32.add (local.get $arg1) (i32.const 18)) (i32.const 0x45))
    (call $gs16 (i32.add (local.get $arg1) (i32.const 20)) (i32.const 0x58))
    (call $gs16 (i32.add (local.get $arg1) (i32.const 22)) (i32.const 0x45))
    (call $gs16 (i32.add (local.get $arg1) (i32.const 24)) (i32.const 0))
    (global.set $eax (i32.const 12))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 285: GetCommandLineW
  (func $handle_GetCommandLineW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return pointer to wide command line string
    (if (i32.eqz (global.get $msvcrt_wcmdln_ptr))
    (then
      (global.set $msvcrt_wcmdln_ptr (call $heap_alloc (i32.const 64)))
      (call $gs16 (global.get $msvcrt_wcmdln_ptr) (i32.const 0))))
    (global.set $eax (global.get $msvcrt_wcmdln_ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 286: CreateWindowExW — delegate to existing CreateWindowEx logic
  (func $handle_CreateWindowExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; For now stub: return 0 (window creation needs more work for W variant)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 52))) (return)
  )

  ;; 287: RegisterClassW — stub, return 1
  (func $handle_RegisterClassW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 288: RegisterClassExW — stub, return 1
  (func $handle_RegisterClassExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 289: DefWindowProcW — delegate to existing DefWindowProc
  (func $handle_DefWindowProcW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 290: LoadCursorW — return fake handle
  (func $handle_LoadCursorW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x60001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 291: LoadIconW — return fake handle
  (func $handle_LoadIconW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x70001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 292: LoadMenuW — return fake handle
  (func $handle_LoadMenuW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 293: MessageBoxW — stub, return 1 (IDOK)
  (func $handle_MessageBoxW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 294: SetWindowTextW — soft-stub
  (func $handle_SetWindowTextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 295: GetWindowTextW — stub, return 0
  (func $handle_GetWindowTextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 296: SendMessageW — stub, return 0
  (func $handle_SendMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 297: PostMessageW — stub, return 1
  (func $handle_PostMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 298: SetErrorMode
  (func $handle_SetErrorMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 299: GetCurrentThreadId
  (func $handle_GetCurrentThreadId (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 300: LoadLibraryW — stub, return fake handle
  (func $handle_LoadLibraryW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x7FFE0000))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 301: GetStartupInfoW — zero-fill the struct
  (func $handle_GetStartupInfoW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $zero_memory (call $g2w (local.get $arg0)) (i32.const 68))
    ;; Set cb = 68 (sizeof STARTUPINFOW)
    (call $gs32 (local.get $arg0) (i32.const 68))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 302: GetKeyState
  (func $handle_GetKeyState (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 303: GetParent
  (func $handle_GetParent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 304: GetWindow
  (func $handle_GetWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 305: IsWindow
  (func $handle_IsWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 306: GetClassInfoW — stub, return 0
  (func $handle_GetClassInfoW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 307: SetWindowLongW — stub, return 0 (previous value)
  (func $handle_SetWindowLongW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 308: GetWindowLongW — stub, return 0
  (func $handle_GetWindowLongW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 309: InitCommonControlsEx — return 1 (success)
  (func $handle_InitCommonControlsEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 310: OleInitialize — return S_OK (0)
  (func $handle_OleInitialize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 311: CoTaskMemFree — no-op
  (func $handle_CoTaskMemFree (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 312: SaveDC
  (func $handle_SaveDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 313: RestoreDC
  (func $handle_RestoreDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 314: GetTextMetricsW — zero-fill, return 1
  (func $handle_GetTextMetricsW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $zero_memory (call $g2w (local.get $arg1)) (i32.const 60))
    ;; Set tmHeight=16, tmAveCharWidth=8
    (call $gs32 (local.get $arg1) (i32.const 16))
    (call $gs32 (i32.add (local.get $arg1) (i32.const 20)) (i32.const 8))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 315: CreateFontIndirectW — return fake font handle
  (func $handle_CreateFontIndirectW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x90001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 316: SetStretchBltMode
  (func $handle_SetStretchBltMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 317: GetPixel
  (func $handle_GetPixel (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0)) ;; black
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 318: SetPixel
  (func $handle_SetPixel (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg3)) ;; return color
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 319: SetROP2
  (func $handle_SetROP2 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 13)) ;; R2_COPYPEN
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 320: lstrlenW
  (func $handle_lstrlenW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $guest_wcslen (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 321: lstrcpyW
  (func $handle_lstrcpyW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $guest_wcscpy (local.get $arg0) (local.get $arg1))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 322: lstrcmpW
  (func $handle_lstrcmpW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $guest_wcsicmp (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 323: lstrcmpiW
  (func $handle_lstrcmpiW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $guest_wcsicmp (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 324: CharNextW — advance by one wide char
  (func $handle_CharNextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.add (local.get $arg0) (i32.const 2)))
    (if (i32.eqz (call $gl16 (local.get $arg0)))
      (then (global.set $eax (local.get $arg0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 325: wsprintfW — wide sprintf stub (return 0)
  (func $handle_wsprintfW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 326: TlsAlloc — return next TLS index
  (func $handle_TlsAlloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (global.get $tls_slots))
      (then
        (global.set $tls_slots (call $heap_alloc (i32.const 256)))
        (call $zero_memory (call $g2w (global.get $tls_slots)) (i32.const 256))))
    (global.set $eax (global.get $tls_next_index))
    (global.set $tls_next_index (i32.add (global.get $tls_next_index) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 327: TlsGetValue(index)
  (func $handle_TlsGetValue (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (global.get $tls_slots))
      (then (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (global.set $eax (call $gl32 (i32.add (global.get $tls_slots) (i32.shl (local.get $arg0) (i32.const 2)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 328: TlsSetValue(index, value)
  (func $handle_TlsSetValue (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (global.get $tls_slots))
      (then
        (global.set $tls_slots (call $heap_alloc (i32.const 256)))
        (call $zero_memory (call $g2w (global.get $tls_slots)) (i32.const 256))))
    (call $gs32 (i32.add (global.get $tls_slots) (i32.shl (local.get $arg0) (i32.const 2))) (local.get $arg1))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 329: TlsFree(index) — no-op, return 1
  (func $handle_TlsFree (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 330: InitializeCriticalSection(ptr) — no-op (single-threaded)
  (func $handle_InitializeCriticalSection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 331: EnterCriticalSection(ptr) — no-op
  (func $handle_EnterCriticalSection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 332: LeaveCriticalSection(ptr) — no-op
  (func $handle_LeaveCriticalSection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 333: DeleteCriticalSection(ptr) — no-op
  (func $handle_DeleteCriticalSection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 334: GetCurrentThread — return pseudo-handle -2
  (func $handle_GetCurrentThread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0xFFFFFFFE))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 335: GetProcessHeap — return fake heap handle
  (func $handle_GetProcessHeap (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x00140000))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 336: SetStdHandle(nStdHandle, hHandle) — no-op, return 1
  (func $handle_SetStdHandle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 337: FlushFileBuffers — return 1
  (func $handle_FlushFileBuffers (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 338: IsValidCodePage — return 1 (valid)
  (func $handle_IsValidCodePage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 339: GetEnvironmentStringsA — return ptr to empty env block
  (func $handle_GetEnvironmentStringsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (global.get $fake_cmdline_addr))
      (then (call $store_fake_cmdline)))
    (global.set $eax (global.get $fake_cmdline_addr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 340: InterlockedIncrement(ptr)
  (func $handle_InterlockedIncrement (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    (local.set $tmp (i32.add (call $gl32 (local.get $arg0)) (i32.const 1)))
    (call $gs32 (local.get $arg0) (local.get $tmp))
    (global.set $eax (local.get $tmp))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 341: InterlockedDecrement(ptr)
  (func $handle_InterlockedDecrement (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    (local.set $tmp (i32.sub (call $gl32 (local.get $arg0)) (i32.const 1)))
    (call $gs32 (local.get $arg0) (local.get $tmp))
    (global.set $eax (local.get $tmp))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 342: InterlockedExchange(ptr, value)
  (func $handle_InterlockedExchange (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gl32 (local.get $arg0)))
    (call $gs32 (local.get $arg0) (local.get $arg1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 343: IsBadReadPtr — return 0 (valid)
  (func $handle_IsBadReadPtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 344: IsBadWritePtr — return 0 (valid)
  (func $handle_IsBadWritePtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 345: SetUnhandledExceptionFilter — return 0 (no previous filter)
  (func $handle_SetUnhandledExceptionFilter (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 346: IsDebuggerPresent — return 0
  (func $handle_IsDebuggerPresent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 347: lstrcpynW — copy up to n wide chars
  (func $handle_lstrcpynW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $guest_wcsncpy (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 348: FindFirstFileW — soft-stub
  (func $handle_FindFirstFileW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 349: GetFileAttributesW — soft-stub
  (func $handle_GetFileAttributesW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 350: GetShortPathNameW — soft-stub
  (func $handle_GetShortPathNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 351: CreateDirectoryW — soft-stub
  (func $handle_CreateDirectoryW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 352: IsDBCSLeadByte — soft-stub
  (func $handle_IsDBCSLeadByte (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 353: GetTempPathW — soft-stub
  (func $handle_GetTempPathW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 354: GetTempFileNameW — soft-stub
  (func $handle_GetTempFileNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 355: lstrcatW — soft-stub
  (func $handle_lstrcatW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 356: GlobalHandle — soft-stub
  (func $handle_GlobalHandle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 357: CreatePatternBrush — soft-stub
  (func $handle_CreatePatternBrush (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 358: GetPaletteEntries — soft-stub
  (func $handle_GetPaletteEntries (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 359: SelectPalette — soft-stub
  (func $handle_SelectPalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 360: RealizePalette — soft-stub
  (func $handle_RealizePalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 361: CreateRectRgnIndirect — soft-stub
  (func $handle_CreateRectRgnIndirect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 362: GetObjectW — soft-stub
  (func $handle_GetObjectW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 363: SetTextAlign — soft-stub
  (func $handle_SetTextAlign (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 364: ExtTextOutW — soft-stub
  (func $handle_ExtTextOutW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36)))
  )

  ;; 365: PlayMetaFile — soft-stub
  (func $handle_PlayMetaFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 366: CreatePalette — soft-stub
  (func $handle_CreatePalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 367: GetNearestColor — soft-stub
  (func $handle_GetNearestColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 368: StretchDIBits — soft-stub
  (func $handle_StretchDIBits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 56)))
  )

  ;; 369: OffsetRgn — soft-stub
  (func $handle_OffsetRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 370: UnrealizeObject — soft-stub
  (func $handle_UnrealizeObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 371: SetBrushOrgEx — soft-stub
  (func $handle_SetBrushOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 372: CreateDCW — soft-stub
  (func $handle_CreateDCW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 373: PtVisible — soft-stub
  (func $handle_PtVisible (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 374: RectVisible — soft-stub
  (func $handle_RectVisible (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 375: TextOutW — soft-stub
  (func $handle_TextOutW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 376: Escape — soft-stub
  (func $handle_Escape (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 377: EnumFontFamiliesExW — soft-stub
  (func $handle_EnumFontFamiliesExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 378: EnumFontFamiliesW — soft-stub
  (func $handle_EnumFontFamiliesW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 379: CallNextHookEx — soft-stub
  (func $handle_CallNextHookEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 380: UnhookWindowsHookEx — soft-stub
  (func $handle_UnhookWindowsHookEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 381: SetWindowsHookExW — soft-stub
  (func $handle_SetWindowsHookExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 382: RedrawWindow — soft-stub
  (func $handle_RedrawWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 383: ValidateRect — soft-stub
  (func $handle_ValidateRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 384: GetWindowDC — soft-stub
  (func $handle_GetWindowDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 385: GrayStringW — soft-stub
  (func $handle_GrayStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 40)))
  )

  ;; 386: DrawTextW — soft-stub
  (func $handle_DrawTextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 387: TabbedTextOutW — soft-stub
  (func $handle_TabbedTextOutW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36)))
  )

  ;; 388: DestroyIcon — soft-stub
  (func $handle_DestroyIcon (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 389: SystemParametersInfoW — soft-stub
  (func $handle_SystemParametersInfoW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 390: IsWindowVisible — soft-stub
  (func $handle_IsWindowVisible (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 391: InflateRect — soft-stub
  (func $handle_InflateRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 392: LoadBitmapW — soft-stub
  (func $handle_LoadBitmapW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 393: wvsprintfW — soft-stub
  (func $handle_wvsprintfW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 394: DrawFocusRect — soft-stub
  (func $handle_DrawFocusRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 395: PtInRect — soft-stub
  (func $handle_PtInRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 396: WinHelpW — soft-stub
  (func $handle_WinHelpW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 397: GetCapture — soft-stub
  (func $handle_GetCapture (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 398: RegisterClipboardFormatW — soft-stub
  (func $handle_RegisterClipboardFormatW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 399: CopyRect — soft-stub
  (func $handle_CopyRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 400: IntersectRect — soft-stub
  (func $handle_IntersectRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 401: UnionRect — soft-stub
  (func $handle_UnionRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 402: WindowFromPoint — soft-stub
  (func $handle_WindowFromPoint (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 403: IsRectEmpty — soft-stub
  (func $handle_IsRectEmpty (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 404: EqualRect — soft-stub
  (func $handle_EqualRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 405: ClientToScreen — soft-stub
  (func $handle_ClientToScreen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 406: SetActiveWindow — soft-stub
  (func $handle_SetActiveWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 407: RemoveMenu — soft-stub
  (func $handle_RemoveMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 408: SetFilePointer — soft-stub
  (func $handle_SetFilePointer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 409: ResumeThread — soft-stub
  (func $handle_ResumeThread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 410: SetLastError — soft-stub
  (func $handle_SetLastError (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 411: FindNextFileW — soft-stub
  (func $handle_FindNextFileW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 412: RaiseException — soft-stub
  (func $handle_RaiseException (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 413: GetUserDefaultLCID — soft-stub
  (func $handle_GetUserDefaultLCID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 414: FileTimeToSystemTime — soft-stub
  (func $handle_FileTimeToSystemTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 415: FileTimeToLocalFileTime — soft-stub
  (func $handle_FileTimeToLocalFileTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 416: GetCurrentDirectoryW — soft-stub
  (func $handle_GetCurrentDirectoryW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 417: SetFileAttributesW — soft-stub
  (func $handle_SetFileAttributesW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 418: GetFullPathNameW — soft-stub
  (func $handle_GetFullPathNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 419: DeleteFileW — soft-stub
  (func $handle_DeleteFileW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 420: MoveFileW — soft-stub
  (func $handle_MoveFileW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 421: SetEndOfFile — soft-stub
  (func $handle_SetEndOfFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 422: DuplicateHandle — soft-stub
  (func $handle_DuplicateHandle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
  )

  ;; 423: LockFile — soft-stub
  (func $handle_LockFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 424: UnlockFile — soft-stub
  (func $handle_UnlockFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 425: ReadFile — soft-stub
  (func $handle_ReadFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 426: CreateFileW — soft-stub
  (func $handle_CreateFileW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
  )

  ;; 427: SetFileTime — soft-stub
  (func $handle_SetFileTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 428: LocalFileTimeToFileTime — soft-stub
  (func $handle_LocalFileTimeToFileTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 429: SystemTimeToFileTime — soft-stub
  (func $handle_SystemTimeToFileTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 430: RegOpenKeyW — soft-stub
  (func $handle_RegOpenKeyW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 431: RegEnumKeyW — soft-stub
  (func $handle_RegEnumKeyW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 432: RegSetValueW — soft-stub
  (func $handle_RegSetValueW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 433: RegCreateKeyW — soft-stub
  (func $handle_RegCreateKeyW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 434: RegSetValueExW — soft-stub
  (func $handle_RegSetValueExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 435: RegCreateKeyExW — soft-stub
  (func $handle_RegCreateKeyExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 40)))
  )

  ;; 436: RegQueryValueExW — soft-stub
  (func $handle_RegQueryValueExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 437: GetShortPathNameA — soft-stub
  (func $handle_GetShortPathNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 438: FillRgn — soft-stub
  (func $handle_FillRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 439: GetDIBColorTable — soft-stub
  (func $handle_GetDIBColorTable (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 440: SetDIBColorTable — soft-stub
  (func $handle_SetDIBColorTable (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 441: ResizePalette — soft-stub
  (func $handle_ResizePalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 442: GetNearestPaletteIndex — soft-stub
  (func $handle_GetNearestPaletteIndex (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 443: SetPaletteEntries — soft-stub
  (func $handle_SetPaletteEntries (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 444: SetDIBits — soft-stub
  (func $handle_SetDIBits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 445: GetTextExtentPointW — soft-stub
  (func $handle_GetTextExtentPointW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 446: CreateICW — soft-stub
  (func $handle_CreateICW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 447: CreateDIBSection — soft-stub
  (func $handle_CreateDIBSection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 448: GetDIBits — soft-stub
  (func $handle_GetDIBits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
  )

  ;; 449: CreateDIBitmap — soft-stub
  (func $handle_CreateDIBitmap (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 450: StretchBlt — soft-stub
  (func $handle_StretchBlt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 48)))
  )

  ;; 451: Polygon — soft-stub
  (func $handle_Polygon (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 452: RoundRect — soft-stub
  (func $handle_RoundRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
  )

  ;; 453: ExtFloodFill — soft-stub
  (func $handle_ExtFloodFill (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 454: CreatePolygonRgn — soft-stub
  (func $handle_CreatePolygonRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 455: PolyBezier — soft-stub
  (func $handle_PolyBezier (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 456: Polyline — soft-stub
  (func $handle_Polyline (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 457: CreateHalftonePalette — soft-stub
  (func $handle_CreateHalftonePalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 458: EnableScrollBar — soft-stub
  (func $handle_EnableScrollBar (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 459: GetCaretPos — soft-stub
  (func $handle_GetCaretPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 460: GetUpdateRect — soft-stub
  (func $handle_GetUpdateRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 461: IsMenu — soft-stub
  (func $handle_IsMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 462: WriteClassStg — soft-stub
  (func $handle_WriteClassStg (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 463: WriteFmtUserTypeStg — soft-stub
  (func $handle_WriteFmtUserTypeStg (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 464: StringFromCLSID — soft-stub
  (func $handle_StringFromCLSID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 465: ExtractIconW — soft-stub
  (func $handle_ExtractIconW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 466: ShellAboutW — soft-stub
  (func $handle_ShellAboutW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 467: CommandLineToArgvW — soft-stub
  (func $handle_CommandLineToArgvW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 468: IsBadCodePtr — soft-stub
  (func $handle_IsBadCodePtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 469: ExitThread — soft-stub
  (func $handle_ExitThread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 470: FindNextFileA — soft-stub
  (func $handle_FindNextFileA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 471: GetEnvironmentVariableA — soft-stub
  (func $handle_GetEnvironmentVariableA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 472: GetVersionExA — fill OSVERSIONINFOA from $winver
  (func $handle_GetVersionExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $w0 i32)
    ;; arg0 = ptr to OSVERSIONINFOA (148 bytes min)
    ;; winver uses GetVersion format: high word = build (bit 31: set=Win9x, clear=NT)
    ;; low word = (minor<<8)|major
    (local.set $w0 (call $g2w (local.get $arg0)))
    ;; dwMajorVersion at +4
    (i32.store (i32.add (local.get $w0) (i32.const 4))
      (i32.and (global.get $winver) (i32.const 0xFF)))
    ;; dwMinorVersion at +8
    (i32.store (i32.add (local.get $w0) (i32.const 8))
      (i32.and (i32.shr_u (global.get $winver) (i32.const 8)) (i32.const 0xFF)))
    ;; dwBuildNumber at +12 (bits 16-30, mask off platform bit)
    (i32.store (i32.add (local.get $w0) (i32.const 12))
      (i32.and (i32.shr_u (global.get $winver) (i32.const 16)) (i32.const 0x7FFF)))
    ;; dwPlatformId at +16: bit 31 set = Win9x (1), clear = NT (2)
    (i32.store (i32.add (local.get $w0) (i32.const 16))
      (if (result i32) (i32.and (global.get $winver) (i32.const 0x80000000))
        (then (i32.const 1))    ;; VER_PLATFORM_WIN32_WINDOWS
        (else (i32.const 2))))  ;; VER_PLATFORM_WIN32_NT
    ;; szCSDVersion at +20: empty string
    (i32.store8 (i32.add (local.get $w0) (i32.const 20)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 473: SetConsoleCtrlHandler — no-op, return success
  (func $handle_SetConsoleCtrlHandler (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 474: SetEnvironmentVariableW — no-op, return success
  (func $handle_SetEnvironmentVariableW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 475: CompareStringA — return CSTR_EQUAL (2)
  (func $handle_CompareStringA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 2))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 476: CompareStringW — return CSTR_EQUAL (2)
  (func $handle_CompareStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 2))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 477: IsValidLocale — return TRUE
  (func $handle_IsValidLocale (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 478: EnumSystemLocalesA — no-op, return TRUE
  (func $handle_EnumSystemLocalesA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 479: GetLocaleInfoW — return 0 (failure)
  (func $handle_GetLocaleInfoW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 480: GetTimeZoneInformation — return TIME_ZONE_ID_UNKNOWN (0), zero-fill struct
  (func $handle_GetTimeZoneInformation (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 481: SetEnvironmentVariableA — no-op, return success
  (func $handle_SetEnvironmentVariableA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 482: Beep — soft-stub
  (func $handle_Beep (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 483: GetDiskFreeSpaceA — soft-stub
  (func $handle_GetDiskFreeSpaceA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 484: GetLogicalDrives — soft-stub
  (func $handle_GetLogicalDrives (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 485: GetFileAttributesA — soft-stub
  (func $handle_GetFileAttributesA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 486: GetCurrentDirectoryA — soft-stub
  (func $handle_GetCurrentDirectoryA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 487: SetCurrentDirectoryA — soft-stub
  (func $handle_SetCurrentDirectoryA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 488: SetFileAttributesA — soft-stub
  (func $handle_SetFileAttributesA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 489: GetFullPathNameA — soft-stub
  (func $handle_GetFullPathNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 490: GetDriveTypeA — soft-stub
  (func $handle_GetDriveTypeA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 491: GetCurrentProcessId — soft-stub
  (func $handle_GetCurrentProcessId (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 492: CreateDirectoryA — soft-stub
  (func $handle_CreateDirectoryA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 493: RemoveDirectoryA — soft-stub
  (func $handle_RemoveDirectoryA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 494: SetCurrentDirectoryW — soft-stub
  (func $handle_SetCurrentDirectoryW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 495: RemoveDirectoryW — soft-stub
  (func $handle_RemoveDirectoryW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 496: GetDriveTypeW — soft-stub
  (func $handle_GetDriveTypeW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 497: MoveFileA — soft-stub
  (func $handle_MoveFileA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 498: GetExitCodeProcess — soft-stub
  (func $handle_GetExitCodeProcess (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 499: CreateProcessA — soft-stub
  (func $handle_CreateProcessA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 44)))
  )

  ;; 500: CreateProcessW — soft-stub
  (func $handle_CreateProcessW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 44)))
  )

  ;; 501: HeapValidate — soft-stub
  (func $handle_HeapValidate (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 502: HeapCompact — soft-stub
  (func $handle_HeapCompact (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 503: HeapWalk — soft-stub
  (func $handle_HeapWalk (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 504: ReadConsoleA — soft-stub
  (func $handle_ReadConsoleA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 505: SetConsoleMode — soft-stub
  (func $handle_SetConsoleMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 506: GetConsoleMode — soft-stub
  (func $handle_GetConsoleMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 507: WriteConsoleA — soft-stub
  (func $handle_WriteConsoleA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 508: GetFileInformationByHandle — soft-stub
  (func $handle_GetFileInformationByHandle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 509: PeekNamedPipe — soft-stub
  (func $handle_PeekNamedPipe (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 510: ReadConsoleInputA — soft-stub
  (func $handle_ReadConsoleInputA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 511: PeekConsoleInputA — soft-stub
  (func $handle_PeekConsoleInputA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 512: GetNumberOfConsoleInputEvents — soft-stub
  (func $handle_GetNumberOfConsoleInputEvents (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 513: CreatePipe — soft-stub
  (func $handle_CreatePipe (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 514: GetSystemTimeAsFileTime — soft-stub
  (func $handle_GetSystemTimeAsFileTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 515: SetLocalTime — soft-stub
  (func $handle_SetLocalTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 516: GetSystemTime — soft-stub
  (func $handle_GetSystemTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 517: FormatMessageW — soft-stub
  (func $handle_FormatMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
  )

  ;; 518: GetFileSize — soft-stub
  (func $handle_GetFileSize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 519: GetFileTime — soft-stub
  (func $handle_GetFileTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 520: GetStringTypeExW — soft-stub
  (func $handle_GetStringTypeExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 521: GetThreadLocale — soft-stub
  (func $handle_GetThreadLocale (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 522: CreateSemaphoreW — soft-stub
  (func $handle_CreateSemaphoreW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 523: ReleaseSemaphore — soft-stub
  (func $handle_ReleaseSemaphore (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 524: CreateMutexW — soft-stub
  (func $handle_CreateMutexW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 525: ReleaseMutex — soft-stub
  (func $handle_ReleaseMutex (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 526: CreateEventW — soft-stub
  (func $handle_CreateEventW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 527: WaitForMultipleObjects — soft-stub
  (func $handle_WaitForMultipleObjects (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 528: GlobalAddAtomW — soft-stub
  (func $handle_GlobalAddAtomW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 529: FindResourceW — soft-stub
  (func $handle_FindResourceW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 530: GlobalGetAtomNameW — soft-stub
  (func $handle_GlobalGetAtomNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 531: GetProfileIntW — soft-stub
  (func $handle_GetProfileIntW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 532: VirtualProtect — soft-stub
  (func $handle_VirtualProtect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 533: FindResourceExW — soft-stub
  (func $handle_FindResourceExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 534: SizeofResource — soft-stub
  (func $handle_SizeofResource (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 535: GetProcessVersion — soft-stub
  (func $handle_GetProcessVersion (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 536: GlobalFlags — soft-stub
  (func $handle_GlobalFlags (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 537: GetDiskFreeSpaceW — soft-stub
  (func $handle_GetDiskFreeSpaceW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 538: SearchPathW — soft-stub
  (func $handle_SearchPathW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 539: SetThreadPriority — soft-stub
  (func $handle_SetThreadPriority (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 540: SuspendThread — soft-stub
  (func $handle_SuspendThread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 541: GetPrivateProfileIntW — soft-stub
  (func $handle_GetPrivateProfileIntW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 542: GetPrivateProfileStringW — soft-stub
  (func $handle_GetPrivateProfileStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 543: WritePrivateProfileStringW — soft-stub
  (func $handle_WritePrivateProfileStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 544: CopyFileW — soft-stub
  (func $handle_CopyFileW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 545: GetSystemDirectoryA — soft-stub
  (func $handle_GetSystemDirectoryA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 546: GetVolumeInformationW — soft-stub
  (func $handle_GetVolumeInformationW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36)))
  )

  ;; 547: OutputDebugStringW — soft-stub
  (func $handle_OutputDebugStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 548: IsBadStringPtrA — soft-stub
  (func $handle_IsBadStringPtrA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 549: IsBadStringPtrW — soft-stub
  (func $handle_IsBadStringPtrW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 550: GlobalDeleteAtom — soft-stub
  (func $handle_GlobalDeleteAtom (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 551: GlobalFindAtomW — soft-stub
  (func $handle_GlobalFindAtomW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 552: CreateMetaFileW — soft-stub
  (func $handle_CreateMetaFileW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 553: CopyMetaFileW — soft-stub
  (func $handle_CopyMetaFileW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 554: DPtoLP — soft-stub
  (func $handle_DPtoLP (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 555: CombineRgn — soft-stub
  (func $handle_CombineRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 556: SetRectRgn — soft-stub
  (func $handle_SetRectRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 557: GetMapMode — soft-stub
  (func $handle_GetMapMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 558: CreateDIBPatternBrushPt — soft-stub
  (func $handle_CreateDIBPatternBrushPt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 559: CreateHatchBrush — soft-stub
  (func $handle_CreateHatchBrush (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 560: ExtCreatePen — soft-stub
  (func $handle_ExtCreatePen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 561: EnumMetaFile — soft-stub
  (func $handle_EnumMetaFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 562: GetObjectType — soft-stub
  (func $handle_GetObjectType (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 563: PlayMetaFileRecord — soft-stub
  (func $handle_PlayMetaFileRecord (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 564: ExtSelectClipRgn — soft-stub
  (func $handle_ExtSelectClipRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 565: SelectClipPath — soft-stub
  (func $handle_SelectClipPath (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 566: CreateRectRgn — soft-stub
  (func $handle_CreateRectRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 567: GetClipRgn — soft-stub
  (func $handle_GetClipRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 568: PolyBezierTo — soft-stub
  (func $handle_PolyBezierTo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 569: SetColorAdjustment — soft-stub
  (func $handle_SetColorAdjustment (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 570: PolylineTo — soft-stub
  (func $handle_PolylineTo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 571: PolyDraw — soft-stub
  (func $handle_PolyDraw (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 572: SetArcDirection — soft-stub
  (func $handle_SetArcDirection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 573: ArcTo — soft-stub
  (func $handle_ArcTo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 40)))
  )

  ;; 574: SetMapperFlags — soft-stub
  (func $handle_SetMapperFlags (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 575: SetTextCharacterExtra — soft-stub
  (func $handle_SetTextCharacterExtra (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 576: SetTextJustification — soft-stub
  (func $handle_SetTextJustification (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 577: OffsetClipRgn — soft-stub
  (func $handle_OffsetClipRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 578: ExcludeClipRect — soft-stub
  (func $handle_ExcludeClipRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 579: SelectClipRgn — soft-stub
  (func $handle_SelectClipRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 580: OffsetWindowOrgEx — soft-stub
  (func $handle_OffsetWindowOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 581: SetPolyFillMode — soft-stub
  (func $handle_SetPolyFillMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 582: StartDocW — soft-stub
  (func $handle_StartDocW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 583: CloseMetaFile — soft-stub
  (func $handle_CloseMetaFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 584: DeleteMetaFile — soft-stub
  (func $handle_DeleteMetaFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 585: IntersectClipRect — soft-stub
  (func $handle_IntersectClipRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 586: GetWindowOrgEx — soft-stub
  (func $handle_GetWindowOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 587: SetWindowOrgEx — soft-stub
  (func $handle_SetWindowOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 588: GetCurrentPositionEx — soft-stub
  (func $handle_GetCurrentPositionEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 589: ScaleWindowExtEx — soft-stub
  (func $handle_ScaleWindowExtEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 590: ScaleViewportExtEx — soft-stub
  (func $handle_ScaleViewportExtEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 591: OffsetViewportOrgEx — soft-stub
  (func $handle_OffsetViewportOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 592: SetViewportOrgEx — soft-stub
  (func $handle_SetViewportOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 593: GetViewportExtEx — soft-stub
  (func $handle_GetViewportExtEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 594: GetROP2 — soft-stub
  (func $handle_GetROP2 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 595: GetWindowExtEx — soft-stub
  (func $handle_GetWindowExtEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 596: GetTextAlign — soft-stub
  (func $handle_GetTextAlign (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 597: GetPolyFillMode — soft-stub
  (func $handle_GetPolyFillMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 598: GetBkMode — soft-stub
  (func $handle_GetBkMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 599: GetTextColor — soft-stub
  (func $handle_GetTextColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 600: GetStretchBltMode — soft-stub
  (func $handle_GetStretchBltMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 601: GetBkColor — soft-stub
  (func $handle_GetBkColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 602: CreateFontW — soft-stub
  (func $handle_CreateFontW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 60)))
  )

  ;; 603: GetCharWidthW — soft-stub
  (func $handle_GetCharWidthW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 604: GetTextExtentPoint32W — soft-stub
  (func $handle_GetTextExtentPoint32W (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 605: GetClipBox — soft-stub
  (func $handle_GetClipBox (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 606: GetTextFaceW — soft-stub
  (func $handle_GetTextFaceW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 607: MsgWaitForMultipleObjects — soft-stub
  (func $handle_MsgWaitForMultipleObjects (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 608: GetWindowPlacement — soft-stub
  (func $handle_GetWindowPlacement (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 609: RegisterWindowMessageW — soft-stub
  (func $handle_RegisterWindowMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 610: GetForegroundWindow — soft-stub
  (func $handle_GetForegroundWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 611: GetMessagePos — soft-stub
  (func $handle_GetMessagePos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 612: GetMessageTime — soft-stub
  (func $handle_GetMessageTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 613: RemovePropW — soft-stub
  (func $handle_RemovePropW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 614: CallWindowProcW — soft-stub
  (func $handle_CallWindowProcW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 615: GetPropW — soft-stub
  (func $handle_GetPropW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 616: SetPropW — soft-stub
  (func $handle_SetPropW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 617: GetWindowTextLengthW — soft-stub
  (func $handle_GetWindowTextLengthW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 618: SetWindowPlacement — soft-stub
  (func $handle_SetWindowPlacement (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 619: TrackPopupMenu — soft-stub
  (func $handle_TrackPopupMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
  )

  ;; 620: GetMenuItemID — soft-stub
  (func $handle_GetMenuItemID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 621: GetMenuItemCount — soft-stub
  (func $handle_GetMenuItemCount (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 622: GetTopWindow — soft-stub
  (func $handle_GetTopWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 623: SetScrollPos — soft-stub
  (func $handle_SetScrollPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 624: GetScrollPos — soft-stub
  (func $handle_GetScrollPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 625: SetScrollRange — soft-stub
  (func $handle_SetScrollRange (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 626: GetScrollRange — soft-stub
  (func $handle_GetScrollRange (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 627: ShowScrollBar — soft-stub
  (func $handle_ShowScrollBar (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 628: SetScrollInfo — soft-stub
  (func $handle_SetScrollInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 629: GetScrollInfo — soft-stub
  (func $handle_GetScrollInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 630: ScrollWindow(hWnd, XAmount, YAmount, lpRect, lpClipRect)
  (func $handle_ScrollWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_scroll_window (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 631: EndDeferWindowPos — soft-stub
  (func $handle_EndDeferWindowPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 632: BeginDeferWindowPos — soft-stub
  (func $handle_BeginDeferWindowPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 633: DeferWindowPos — soft-stub
  (func $handle_DeferWindowPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36)))
  )

  ;; 634: AdjustWindowRectEx — soft-stub
  (func $handle_AdjustWindowRectEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 635: DispatchMessageW — soft-stub
  (func $handle_DispatchMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 636: PeekMessageW — soft-stub
  (func $handle_PeekMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 637: SendDlgItemMessageW — soft-stub
  (func $handle_SendDlgItemMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 638: LoadAcceleratorsW — soft-stub
  (func $handle_LoadAcceleratorsW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 639: TranslateAcceleratorW — soft-stub
  (func $handle_TranslateAcceleratorW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 640: IsWindowEnabled — soft-stub
  (func $handle_IsWindowEnabled (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 641: GetDesktopWindow — soft-stub
  (func $handle_GetDesktopWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 642: GetActiveWindow — soft-stub
  (func $handle_GetActiveWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 643: ReuseDDElParam — soft-stub
  (func $handle_ReuseDDElParam (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 644: UnpackDDElParam — soft-stub
  (func $handle_UnpackDDElParam (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 645: WaitMessage — soft-stub
  (func $handle_WaitMessage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 646: GetWindowThreadProcessId — soft-stub
  (func $handle_GetWindowThreadProcessId (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 647: GetMessageW — soft-stub
  (func $handle_GetMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 648: DefFrameProcW — soft-stub
  (func $handle_DefFrameProcW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 649: TranslateMDISysAccel — soft-stub
  (func $handle_TranslateMDISysAccel (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 650: DrawMenuBar — soft-stub
  (func $handle_DrawMenuBar (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 651: DefMDIChildProcW — soft-stub
  (func $handle_DefMDIChildProcW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 652: InvertRect — soft-stub
  (func $handle_InvertRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 653: IsZoomed — soft-stub
  (func $handle_IsZoomed (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 654: SetParent — soft-stub
  (func $handle_SetParent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 655: AppendMenuW — soft-stub
  (func $handle_AppendMenuW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 656: DeleteMenu — soft-stub
  (func $handle_DeleteMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 657: GetDCEx — soft-stub
  (func $handle_GetDCEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 658: LockWindowUpdate — soft-stub
  (func $handle_LockWindowUpdate (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 659: GetTabbedTextExtentA — soft-stub
  (func $handle_GetTabbedTextExtentA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 660: CreateDialogIndirectParamW — soft-stub
  (func $handle_CreateDialogIndirectParamW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 661: GetNextDlgTabItem — soft-stub
  (func $handle_GetNextDlgTabItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 662: GetAsyncKeyState — soft-stub
  (func $handle_GetAsyncKeyState (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 663: MapDialogRect — soft-stub
  (func $handle_MapDialogRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 664: GetDialogBaseUnits — soft-stub
  (func $handle_GetDialogBaseUnits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 665: GetClassNameW — soft-stub
  (func $handle_GetClassNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 666: GetDlgItemInt — soft-stub
  (func $handle_GetDlgItemInt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 667: GetDlgItemTextW — soft-stub
  (func $handle_GetDlgItemTextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 668: SetDlgItemTextW — soft-stub
  (func $handle_SetDlgItemTextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 669: IsDlgButtonChecked — soft-stub
  (func $handle_IsDlgButtonChecked (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 670: ScrollWindowEx — soft-stub
  (func $handle_ScrollWindowEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36)))
  )

  ;; 671: IsDialogMessageW — soft-stub
  (func $handle_IsDialogMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 672: SetMenuItemBitmaps — soft-stub
  (func $handle_SetMenuItemBitmaps (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 673: ModifyMenuW — soft-stub
  (func $handle_ModifyMenuW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 674: GetMenuState — soft-stub
  (func $handle_GetMenuState (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 675: GetMenuCheckMarkDimensions — soft-stub
  (func $handle_GetMenuCheckMarkDimensions (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 676: SetCursorPos — soft-stub
  (func $handle_SetCursorPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 677: DestroyCursor — soft-stub
  (func $handle_DestroyCursor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 678: FindWindowW — soft-stub
  (func $handle_FindWindowW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 679: GetTabbedTextExtentW — soft-stub
  (func $handle_GetTabbedTextExtentW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 680: UnregisterClassW — soft-stub
  (func $handle_UnregisterClassW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 681: ShowOwnedPopups — soft-stub
  (func $handle_ShowOwnedPopups (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 682: InsertMenuW — soft-stub
  (func $handle_InsertMenuW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 683: GetMenuStringW — soft-stub
  (func $handle_GetMenuStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 684: CopyAcceleratorTableW — soft-stub
  (func $handle_CopyAcceleratorTableW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 685: InSendMessage — soft-stub
  (func $handle_InSendMessage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 686: PostThreadMessageW — soft-stub
  (func $handle_PostThreadMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 687: CreateMenu — soft-stub
  (func $handle_CreateMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 688: WindowFromDC — soft-stub
  (func $handle_WindowFromDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 689: CountClipboardFormats — soft-stub
  (func $handle_CountClipboardFormats (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 690: SetWindowContextHelpId — soft-stub
  (func $handle_SetWindowContextHelpId (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 691: GetNextDlgGroupItem — soft-stub
  (func $handle_GetNextDlgGroupItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 692: ClipCursor — soft-stub
  (func $handle_ClipCursor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 693: EnumChildWindows — soft-stub
  (func $handle_EnumChildWindows (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 694: InvalidateRgn — soft-stub
  (func $handle_InvalidateRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 695: LoadStringW — load string resource (same as A for now)
  (func $handle_LoadStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_load_string
      (local.get $arg1)                ;; string ID
      (call $g2w (local.get $arg2))    ;; buffer (WASM ptr)
      (local.get $arg3)))              ;; max chars
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 696: CharUpperW — soft-stub
  (func $handle_CharUpperW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 697: ??1type_info@@UAE@XZ — soft-stub
  (func $handle_??1type_info@@UAE@XZ (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 698: ?terminate@@YAXXZ — soft-stub
  (func $handle_?terminate@@YAXXZ (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 699: HeapSize — return allocation size from heap header
  (func $handle_HeapSize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; HeapSize(hHeap, dwFlags, lpMem) → size
    ;; Our heap stores block size (including 4-byte header) at [ptr-4]
    ;; Only valid for pointers in our heap range; return -1 for unknown pointers
    (if (i32.and
          (i32.ge_u (local.get $arg2) (i32.add (global.get $image_base) (global.get $exe_size_of_image)))
          (i32.lt_u (local.get $arg2) (global.get $heap_ptr)))
      (then
        (global.set $eax (i32.sub
          (call $gl32 (i32.sub (local.get $arg2) (i32.const 4)))
          (i32.const 4))))
      (else
        (global.set $eax (i32.const 0xFFFFFFFF))))  ;; not our allocation
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 700: IsProcessorFeaturePresent — return TRUE (1 arg stdcall)
  (func $handle_IsProcessorFeaturePresent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 701: CoRegisterMessageFilter — return S_OK (2 args stdcall)
  (func $handle_CoRegisterMessageFilter (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; fallback: unknown API — crash with full details
  (func $handle_fallback (param $name_ptr i32)
    (call $host_crash_unimplemented
      (local.get $name_ptr)
      (global.get $esp)
      (global.get $eip)
      (global.get $ebp))
    (unreachable)
  )

  ;; ============================================================
  ;; SUB-DISPATCHERS (Local*, Global*, lstr*, Reg*)
  ;; ============================================================
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
    (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 16))))
