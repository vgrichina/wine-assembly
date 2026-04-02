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

  ;; 1: GetModuleHandleA(lpModuleName) — NULL→image_base, else search DLL table
  (func $handle_GetModuleHandleA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $result i32)
    (if (i32.eqz (local.get $arg0))
      (then (local.set $result (global.get $image_base)))
      (else (local.set $result (call $find_dll_by_name (call $g2w (local.get $arg0))))))
    (global.set $eax (local.get $result))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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
    ;; DEBUG: dump hash table entry 0 and entry 310 to verify integrity
    (call $host_log_i32 (i32.load (global.get $API_HASH_TABLE)))  ;; hash[0]
    (call $host_log_i32 (i32.load (i32.add (global.get $API_HASH_TABLE) (i32.const 2480))))  ;; hash[310] = OleInitialize
    (call $host_log_i32 (global.get $API_HASH_COUNT))  ;; count
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

  ;; 5: GetLastError — returns 0 (ERROR_SUCCESS)
  (func $handle_GetLastError (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; 6: GetLocalTime
  (func $handle_GetLocalTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $zero_memory (call $g2w (local.get $arg0)) (i32.const 16))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 7: GetTimeFormatA — STUB: unimplemented
  (func $handle_GetTimeFormatA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 8: GetDateFormatA — STUB: unimplemented
  (func $handle_GetDateFormatA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 9: GetProfileStringA(appName, keyName, default, retBuf, nSize) → chars copied
  (func $handle_GetProfileStringA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetProfileStringA(appName, keyName, default, retBuf, nSize) — 5 args stdcall
    ;; Same as GetPrivateProfileStringA with fileName="win.ini"
    (local $wa_esp i32) (local $nSize i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $nSize (i32.load (i32.add (local.get $wa_esp) (i32.const 20))))
    (global.set $eax (call $host_ini_get_string
      (if (result i32) (local.get $arg0) (then (call $g2w (local.get $arg0))) (else (i32.const 0)))
      (if (result i32) (local.get $arg1) (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (if (result i32) (local.get $arg2) (then (call $g2w (local.get $arg2))) (else (i32.const 0)))
      (local.get $arg3)
      (local.get $nSize)
      (global.get $win_ini_name_ptr)  ;; WASM ptr to "win.ini\0"
      (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 10: GetProfileIntA(appName, keyName, nDefault) — 3 args stdcall
  (func $handle_GetProfileIntA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_ini_get_int
      (call $g2w (local.get $arg0))
      (call $g2w (local.get $arg1))
      (local.get $arg2)
      (global.get $win_ini_name_ptr)
      (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 11: GetLocaleInfoA(Locale, LCType, lpLCData, cchData) — return 0 (not available)
  (func $handle_GetLocaleInfoA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
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

  ;; 13: DeleteFileA(lpFileName) — 1 arg stdcall
  (func $handle_DeleteFileA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_fs_delete_file (call $g2w (local.get $arg0)) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 14: CreateFileA(lpFileName, dwDesiredAccess, dwShareMode, lpSecAttr, dwCreation, dwFlags, hTemplate) — 7 args
  (func $handle_CreateFileA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa_esp i32) (local $creation i32) (local $flags i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $creation (local.get $arg4))
    (local.set $flags (i32.load (i32.add (local.get $wa_esp) (i32.const 24))))
    (global.set $eax (call $host_fs_create_file
      (call $g2w (local.get $arg0))  ;; pathWA
      (local.get $arg1)               ;; access
      (local.get $creation)            ;; creation disposition
      (local.get $flags)               ;; flags and attributes
      (i32.const 0)))                  ;; isWide=0
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))  ;; 7 args + ret
  )

  ;; 15: FindFirstFileA(lpFileName, lpFindFileData) — 2 args stdcall
  (func $handle_FindFirstFileA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_fs_find_first_file
      (call $g2w (local.get $arg0)) (local.get $arg1) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 16: FindClose(hFindFile) — 1 arg stdcall
  (func $handle_FindClose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_fs_find_close (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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

  ;; 19: _lcreat — STUB: unimplemented
  (func $handle__lcreat (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 20: _lopen — STUB: unimplemented
  (func $handle__lopen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 21: _lwrite — STUB: unimplemented
  (func $handle__lwrite (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 22: _llseek — STUB: unimplemented
  (func $handle__llseek (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 23: _lclose — STUB: unimplemented
  (func $handle__lclose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 24: _lread — STUB: unimplemented
  (func $handle__lread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 25: Sleep — STUB: unimplemented
  (func $handle_Sleep (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 26: CloseHandle(hObject) — 1 arg stdcall, return TRUE
  (func $handle_CloseHandle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (call $host_fs_close_handle (local.get $arg0)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 27: CreateEventA(lpAttr, bManualReset, bInitialState, lpName) — 4 args stdcall
  (func $handle_CreateEventA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_create_event (local.get $arg1) (local.get $arg2)))
    (call $host_log_i32 (global.get $eax))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 28: CreateThread(lpAttr, dwStackSize, lpStartAddr, lpParam, dwFlags, lpThreadId) — 6 args stdcall
  (func $handle_CreateThread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $lpThreadId i32)
    (local.set $lpThreadId (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (global.set $eax (call $host_create_thread (local.get $arg2) (local.get $arg3) (local.get $arg1)))
    (if (local.get $lpThreadId)
      (then (call $gs32 (local.get $lpThreadId) (global.get $eax))))
    (call $host_log_i32 (global.get $eax))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 29: WaitForSingleObject(hHandle, dwMilliseconds) — 2 args stdcall
  (func $handle_WaitForSingleObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $result i32)
    (local.set $result (call $host_wait_single (local.get $arg0) (local.get $arg1)))
    (if (i32.eq (local.get $result) (i32.const 0xFFFF))
      (then
        (global.set $yield_reason (i32.const 1))
        (global.set $wait_handle (local.get $arg0))
        (global.set $steps (i32.const 0))
        (return)))
    (global.set $eax (local.get $result))
    (call $host_log_i32 (global.get $eax))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 30: ResetEvent(hEvent) — 1 arg stdcall
  (func $handle_ResetEvent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_reset_event (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 31: SetEvent(hEvent) — 1 arg stdcall
  (func $handle_SetEvent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_set_event (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 32: WriteProfileStringA(appName, keyName, lpString) — stub, pretend success
  (func $handle_WriteProfileStringA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; WriteProfileStringA(appName, keyName, string) — 3 args stdcall, writes to win.ini
    (global.set $eax (call $host_ini_write_string
      (call $g2w (local.get $arg0))
      (if (result i32) (local.get $arg1) (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (if (result i32) (local.get $arg2) (then (call $g2w (local.get $arg2))) (else (i32.const 0)))
      (global.get $win_ini_name_ptr)
      (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 33: HeapCreate — STUB: unimplemented
  (func $handle_HeapCreate (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x00140000))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 34: HeapDestroy — STUB: unimplemented
  (func $handle_HeapDestroy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
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

  ;; 39: VirtualFree — STUB: unimplemented
  (func $handle_VirtualFree (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 40: GetACP — STUB: unimplemented
  (func $handle_GetACP (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1252))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 41: GetOEMCP — STUB: unimplemented
  (func $handle_GetOEMCP (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 437))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
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

  ;; 45: GetStringTypeA — STUB: unimplemented
  (func $handle_GetStringTypeA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 46: GetStringTypeW(dwInfoType, lpSrcStr, cchSrc, lpCharType) — classify chars
  ;; CT_CTYPE1=1: C1_UPPER=1 C1_LOWER=2 C1_DIGIT=4 C1_SPACE=8 C1_PUNCT=16 C1_CNTRL=32 C1_ALPHA=256
  (func $handle_GetStringTypeW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $i i32) (local $ch i32) (local $ct i32) (local $out i32) (local $src i32) (local $count i32)
    ;; arg0=dwInfoType, arg1=lpSrcStr, arg2=cchSrc, arg3=lpCharType
    (local.set $src (call $g2w (local.get $arg1)))
    (local.set $out (call $g2w (local.get $arg3)))
    (local.set $count (local.get $arg2))
    (local.set $i (i32.const 0))
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $ch (i32.load16_u (i32.add (local.get $src) (i32.mul (local.get $i) (i32.const 2)))))
      (local.set $ct (i32.const 0))
      ;; Control chars 0-31
      (if (i32.le_u (local.get $ch) (i32.const 31))
        (then (local.set $ct (i32.const 0x20))))
      ;; Space/tab/newline
      (if (i32.or (i32.eq (local.get $ch) (i32.const 32))
            (i32.or (i32.eq (local.get $ch) (i32.const 9))
              (i32.or (i32.eq (local.get $ch) (i32.const 10)) (i32.eq (local.get $ch) (i32.const 13)))))
        (then (local.set $ct (i32.or (local.get $ct) (i32.const 0x08)))))
      ;; Digits 0-9
      (if (i32.and (i32.ge_u (local.get $ch) (i32.const 48)) (i32.le_u (local.get $ch) (i32.const 57)))
        (then (local.set $ct (i32.or (local.get $ct) (i32.const 0x04)))))
      ;; Uppercase A-Z
      (if (i32.and (i32.ge_u (local.get $ch) (i32.const 65)) (i32.le_u (local.get $ch) (i32.const 90)))
        (then (local.set $ct (i32.or (local.get $ct) (i32.const 0x101)))))
      ;; Lowercase a-z
      (if (i32.and (i32.ge_u (local.get $ch) (i32.const 97)) (i32.le_u (local.get $ch) (i32.const 122)))
        (then (local.set $ct (i32.or (local.get $ct) (i32.const 0x102)))))
      ;; Punctuation 33-47, 58-64, 91-96, 123-126
      (if (i32.and (i32.ge_u (local.get $ch) (i32.const 33)) (i32.le_u (local.get $ch) (i32.const 47)))
        (then (local.set $ct (i32.or (local.get $ct) (i32.const 0x10)))))
      (if (i32.and (i32.ge_u (local.get $ch) (i32.const 58)) (i32.le_u (local.get $ch) (i32.const 64)))
        (then (local.set $ct (i32.or (local.get $ct) (i32.const 0x10)))))
      (i32.store16 (i32.add (local.get $out) (i32.mul (local.get $i) (i32.const 2))) (local.get $ct))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 47: LCMapStringA(Locale, dwMapFlags, lpSrcStr, cchSrc, lpDestStr, cchDest)
  ;; Identity mapping: if dest is NULL return required size, else copy src→dest
  (func $handle_LCMapStringA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $cchDest i32)
    (local.set $cchDest (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (if (i32.and (local.get $arg4) (local.get $cchDest))
    (then
      ;; Copy src to dest (identity)
      (call $memcpy (call $g2w (local.get $arg4)) (call $g2w (local.get $arg2)) (local.get $arg3))))
    ;; Return source length
    (global.set $eax (local.get $arg3))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 48: LCMapStringW — wide version, same identity mapping (2 bytes per char)
  (func $handle_LCMapStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $cchDest i32)
    (local.set $cchDest (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (if (i32.and (local.get $arg4) (local.get $cchDest))
    (then
      (call $memcpy (call $g2w (local.get $arg4)) (call $g2w (local.get $arg2))
        (i32.mul (local.get $arg3) (i32.const 2)))))
    (global.set $eax (local.get $arg3))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 49: GetStdHandle(nStdHandle) — return fake handles for stdin/stdout/stderr
  (func $handle_GetStdHandle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; STD_INPUT_HANDLE=-10 → 1, STD_OUTPUT_HANDLE=-11 → 2, STD_ERROR_HANDLE=-12 → 3
    ;; GUI apps don't use these but CRT init checks them
    (global.set $eax
      (if (result i32) (i32.eq (local.get $arg0) (i32.const 0xFFFFFFF6)) ;; -10
        (then (i32.const 1))
        (else (if (result i32) (i32.eq (local.get $arg0) (i32.const 0xFFFFFFF5)) ;; -11
          (then (i32.const 2))
          (else (if (result i32) (i32.eq (local.get $arg0) (i32.const 0xFFFFFFF4)) ;; -12
            (then (i32.const 3))
            (else (i32.const 0xFFFFFFFF))))))))  ;; INVALID_HANDLE_VALUE
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 50: GetFileType(hFile) — FILE_TYPE_CHAR=2 for console handles, FILE_TYPE_UNKNOWN=0 otherwise
  (func $handle_GetFileType (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (if (result i32) (i32.le_u (local.get $arg0) (i32.const 3))
        (then (i32.const 2))   ;; FILE_TYPE_CHAR (console)
        (else (i32.const 0)))) ;; FILE_TYPE_UNKNOWN
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 51: WriteFile(hFile, lpBuffer, nBytesToWrite, lpBytesWritten, lpOverlapped) — 5 args
  (func $handle_WriteFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Console handles (stdout=1,stderr=2) — just report bytes written
    (if (i32.le_u (local.get $arg0) (i32.const 3))
      (then
        (if (local.get $arg3) (then (call $gs32 (local.get $arg3) (local.get $arg2))))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
    ;; File handles — delegate to virtual FS
    (global.set $eax (call $host_fs_write_file
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 52: SetHandleCount(uNumber) — no-op on Win32, return the count
  (func $handle_SetHandleCount (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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

  ;; 55: UnhandledExceptionFilter — STUB: unimplemented
  (func $handle_UnhandledExceptionFilter (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 56: GetCurrentProcess — return pseudo-handle -1 (0xFFFFFFFF)
  (func $handle_GetCurrentProcess (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0xFFFFFFFF))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
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

  ;; 60: LoadResource(hModule, hResInfo) → HGLOBAL
  ;; On Win32, LoadResource just returns hResInfo — LockResource does the actual work
  (func $handle_LoadResource (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg1))  ;; return hResInfo as-is
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
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

  ;; 62: FreeResource — STUB: unimplemented
  (func $handle_FreeResource (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 63: RtlUnwind
  (func $handle_RtlUnwind (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Unlink SEH chain: set FS:[0] = TargetFrame->next
    (if (i32.ne (local.get $arg0) (i32.const 0))
    (then (call $gs32 (global.get $fs_base) (call $gl32 (local.get $arg0)))))
    (global.set $eax (local.get $arg3)) ;; ReturnValue
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 64: FreeLibrary — STUB: unimplemented
  (func $handle_FreeLibrary (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 65: sndPlaySoundA(pszSound, fuSound) — no-op (no audio support)
  (func $handle_sndPlaySoundA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 66: RegisterWindowMessageA(lpString) — return unique msg ID from 0xC000+ range
  (func $handle_RegisterWindowMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $clipboard_format_counter (i32.add (global.get $clipboard_format_counter) (i32.const 1)))
    (global.set $eax (global.get $clipboard_format_counter))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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
    ;; Register hwnd→wndproc in window table (look up from class table by className)
    (local.set $tmp (call $class_table_lookup (call $g2w (local.get $arg1))))
    (if (local.get $tmp)
      (then (call $wnd_table_set (global.get $next_hwnd) (local.get $tmp))))
    ;; Store parent hwnd (hWndParent = [esp+36])
    (call $wnd_set_parent (global.get $next_hwnd)
      (call $gl32 (i32.add (global.get $esp) (i32.const 36))))
    ;; Main window: send WM_CREATE synchronously (like real Win98)
    (if (i32.eq (global.get $next_hwnd) (global.get $main_hwnd))
    (then
    ;; Store window outer dimensions for WM_SIZE delivery later
    (global.set $main_win_cx (call $gl32 (i32.add (global.get $esp) (i32.const 28))))
    (global.set $main_win_cy (call $gl32 (i32.add (global.get $esp) (i32.const 32))))
    (global.set $main_nc_height (select (i32.const 45) (i32.const 25)
      (i32.ne (call $gl32 (i32.add (global.get $esp) (i32.const 40))) (i32.const 0))))
    (global.set $pending_wm_size (i32.or
      (i32.and (i32.sub (global.get $main_win_cx) (i32.const 6)) (i32.const 0xFFFF))
      (i32.shl (i32.sub (global.get $main_win_cy) (global.get $main_nc_height)) (i32.const 16))))
    ;; Save state for continuation thunk
    (global.set $createwnd_saved_hwnd (global.get $next_hwnd))
    (global.set $createwnd_saved_ret (call $gl32 (global.get $esp)))
    ;; Clean CreateWindowExA frame (ret + 12 args = 52 bytes stdcall)
    (global.set $esp (i32.add (global.get $esp) (i32.const 52)))
    ;; Build CREATESTRUCT at scratch address 0x400100
    (call $gs32 (i32.const 0x400100) (i32.const 0))                 ;; lpCreateParams
    (call $gs32 (i32.const 0x400110) (global.get $main_win_cy))     ;; cy (+16)
    (call $gs32 (i32.const 0x400114) (global.get $main_win_cx))     ;; cx (+20)
    ;; Push WndProc args right-to-left: lParam, wParam, uMsg, hwnd
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0x400100))             ;; lParam = &CREATESTRUCT
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0))                    ;; wParam = 0
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0x0001))               ;; WM_CREATE
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $next_hwnd))          ;; hwnd
    ;; Push continuation thunk as return address
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $createwnd_ret_thunk))
    ;; Jump to WndProc — interpreter will run it, then hit continuation thunk
    (global.set $eip (global.get $wndproc_addr))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (global.set $steps (i32.const 0))
    (return))
    (else
    ;; Child window: flag pending WM_CREATE + WM_SIZE (delivered before main WM_SIZE)
    (global.set $pending_child_create (global.get $next_hwnd))
    (global.set $pending_child_size (i32.or
      (i32.and (call $gl32 (i32.add (global.get $esp) (i32.const 28))) (i32.const 0xFFFF))
      (i32.shl (call $gl32 (i32.add (global.get $esp) (i32.const 32))) (i32.const 16))))
    (global.set $child_paint_hwnd (global.get $next_hwnd))
    ))
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

  ;; 70: MessageBeep(uType) — play system sound via host
  (func $handle_MessageBeep (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_message_beep (local.get $arg0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
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
    ;; Main WM_CREATE is now sent synchronously during CreateWindowExA (not deferred)
    ;; Deliver child WM_CREATE between main WM_CREATE and main WM_SIZE
    (if (global.get $pending_child_create)
    (then
    (local.set $tmp (global.get $pending_child_create))
    (global.set $pending_child_create (i32.const 0))
    (call $gs32 (local.get $msg_ptr) (local.get $tmp))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0001)) ;; WM_CREATE
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Deliver child WM_SIZE after child WM_CREATE
    (if (global.get $pending_child_size)
    (then
    (local.set $packed (global.get $pending_child_size))
    (global.set $pending_child_size (i32.const 0))
    (call $gs32 (local.get $msg_ptr) (global.get $child_paint_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0005)) ;; WM_SIZE
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (local.get $packed))
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
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.add (global.get $main_hwnd) (i32.const 0x40000))) ;; wParam = hdc
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
    ;; Deliver WM_PAINT to child window if pending
    (if (global.get $child_paint_hwnd)
    (then
    (call $gs32 (local.get $msg_ptr) (global.get $child_paint_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x000F)) ;; WM_PAINT
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
    (global.set $child_paint_hwnd (i32.const 0))
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

  ;; 74: PeekMessageA(lpMsg, hWnd, wMsgFilterMin, wMsgFilterMax, wRemoveMsg)
  ;; Returns 0 = no message available (non-blocking)
  (func $handle_PeekMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $packed i32) (local $msg i32) (local $tmp i32)
    ;; Deliver pending child WM_CREATE
    (if (global.get $pending_child_create)
    (then
    (local.set $tmp (global.get $pending_child_create))
    (if (i32.and (local.get $arg4) (i32.const 1)) ;; PM_REMOVE
      (then (global.set $pending_child_create (i32.const 0))))
    (call $gs32 (local.get $arg0) (local.get $tmp))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0x0001)) ;; WM_CREATE
    (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
    ;; Deliver pending child WM_SIZE
    (if (global.get $pending_child_size)
    (then
    (local.set $packed (global.get $pending_child_size))
    (if (i32.and (local.get $arg4) (i32.const 1))
      (then (global.set $pending_child_size (i32.const 0))))
    (call $gs32 (local.get $arg0) (global.get $child_paint_hwnd))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0x0005)) ;; WM_SIZE
    (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (local.get $packed))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
    ;; Deliver pending WM_SIZE for main window
    (if (global.get $pending_wm_size)
    (then
    (local.set $packed (global.get $pending_wm_size))
    (if (i32.and (local.get $arg4) (i32.const 1))
      (then (global.set $pending_wm_size (i32.const 0))))
    (call $gs32 (local.get $arg0) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0x0005)) ;; WM_SIZE
    (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (local.get $packed))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
    ;; Phase-based initial message delivery (same as GetMessageA)
    ;; Only deliver if main window exists
    ;; Phase 0: WM_ACTIVATE
    (if (i32.and (i32.eqz (global.get $msg_phase)) (global.get $main_hwnd))
    (then
    (if (i32.and (local.get $arg4) (i32.const 1)) (then (global.set $msg_phase (i32.const 1))))
    (call $gs32 (local.get $arg0) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0x0006)) ;; WM_ACTIVATE
    (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (i32.const 1))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (global.get $main_hwnd))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
    ;; Phase 1: WM_ERASEBKGND
    (if (i32.eq (global.get $msg_phase) (i32.const 1))
    (then
    (if (i32.and (local.get $arg4) (i32.const 1)) (then (global.set $msg_phase (i32.const 2))))
    (call $gs32 (local.get $arg0) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0x0014)) ;; WM_ERASEBKGND
    (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (i32.add (global.get $main_hwnd) (i32.const 0x40000)))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
    ;; Phase 2: WM_PAINT
    (if (i32.eq (global.get $msg_phase) (i32.const 2))
    (then
    (if (i32.and (local.get $arg4) (i32.const 1)) (then (global.set $msg_phase (i32.const 3))))
    (call $gs32 (local.get $arg0) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0x000F)) ;; WM_PAINT
    (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
    ;; Check posted message queue
    (if (i32.gt_u (global.get $post_queue_count) (i32.const 0))
      (then
        ;; Dequeue into lpMsg
        (call $gs32 (local.get $arg0) (i32.load (i32.const 0x400)))                        ;; hwnd
        (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.load (i32.const 0x404)))  ;; msg
        (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (i32.load (i32.const 0x408)))  ;; wParam
        (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (i32.load (i32.const 0x40C))) ;; lParam
        ;; If PM_REMOVE (arg4 & 1), shift queue
        (if (i32.and (local.get $arg4) (i32.const 1))
          (then
            (global.set $post_queue_count (i32.sub (global.get $post_queue_count) (i32.const 1)))
            (if (i32.gt_u (global.get $post_queue_count) (i32.const 0))
              (then (call $memcpy (i32.const 0x400) (i32.const 0x410)
                (i32.mul (global.get $post_queue_count) (i32.const 16)))))
          )
        )
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; stdcall, 5 args
        (return)
      )
    )
    ;; Poll host for input events
    (local.set $packed (call $host_check_input))
    (if (i32.ne (local.get $packed) (i32.const 0))
      (then
        (local.set $msg (i32.and (local.get $packed) (i32.const 0xFFFF)))
        ;; Check message filter range (0,0 = accept all)
        (if (i32.or (i32.and (i32.eqz (local.get $arg2)) (i32.eqz (local.get $arg3)))
              (i32.and (i32.ge_u (local.get $msg) (local.get $arg2))
                       (i32.le_u (local.get $msg) (local.get $arg3))))
          (then
            (local.set $tmp (call $host_check_input_hwnd))
            (if (i32.eqz (local.get $tmp))
              (then (local.set $tmp (global.get $main_hwnd))))
            (call $gs32 (local.get $arg0) (local.get $tmp))
            (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (local.get $msg))
            (call $gs32 (i32.add (local.get $arg0) (i32.const 8))
              (i32.shr_u (local.get $packed) (i32.const 16)))
            (call $gs32 (i32.add (local.get $arg0) (i32.const 12))
              (call $host_check_input_lparam))
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
            (return)
          )
        )
      )
    )
    ;; WM_PAINT if pending (lowest priority)
    (if (global.get $paint_pending)
    (then
    (if (i32.and (local.get $arg4) (i32.const 1))
      (then (global.set $paint_pending (i32.const 0))))
    (call $gs32 (local.get $arg0) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0x000F)) ;; WM_PAINT
    (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
    ;; Child paint pending
    (if (global.get $child_paint_hwnd)
    (then
    (local.set $tmp (global.get $child_paint_hwnd))
    (if (i32.and (local.get $arg4) (i32.const 1))
      (then (global.set $child_paint_hwnd (i32.const 0))))
    (call $gs32 (local.get $arg0) (local.get $tmp))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0x000F))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
    (global.set $eax (i32.const 0))  ;; no message
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; stdcall, 5 args
  )

  ;; 75: DispatchMessageA
  (func $handle_DispatchMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $wndproc i32)
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
    ;; Look up wndproc from window table
    (local.set $wndproc (call $wnd_table_get (call $gl32 (local.get $arg0))))
    ;; WAT-native WndProc dispatch (e.g. help window): wndproc >= 0xFFFF0000
    (if (i32.ge_u (local.get $wndproc) (i32.const 0xFFFF0000))
      (then
        (global.set $eax (call $wat_wndproc_dispatch
          (call $gl32 (local.get $arg0))
          (call $gl32 (i32.add (local.get $arg0) (i32.const 4)))
          (call $gl32 (i32.add (local.get $arg0) (i32.const 8)))
          (call $gl32 (i32.add (local.get $arg0) (i32.const 12)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    ;; x86 WndProc dispatch: use window table result, or fall back to globals
    (if (i32.eqz (local.get $wndproc))
      (then
        (if (i32.eq (call $gl32 (local.get $arg0)) (global.get $main_hwnd))
          (then (local.set $wndproc (global.get $wndproc_addr)))
          (else (if (global.get $wndproc_addr2)
            (then (local.set $wndproc (global.get $wndproc_addr2)))
            (else (local.set $wndproc (global.get $wndproc_addr))))))))
    ;; If no WndProc or null MSG ptr, return 0
    (if (i32.or (i32.eqz (local.get $wndproc)) (i32.eqz (local.get $arg0)))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
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
    ;; Jump to WndProc
    (global.set $eip (local.get $wndproc))
    (global.set $steps (i32.const 0))
  )

  ;; 76: TranslateAcceleratorA(hwnd, hAccel, lpMsg) — return 0 (no accel match)
  ;; TODO: implement real accelerator table lookup
  (func $handle_TranslateAcceleratorA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 77: TranslateMessage(lpMsg) — translates virtual-key messages to char messages
  ;; We handle keyboard input in the renderer, so this is a no-op that returns success
  (func $handle_TranslateMessage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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

  ;; 81: SendMessageA(hwnd, msg, wParam, lParam) — 4 args stdcall
  ;; Synchronous: call WndProc(hwnd, msg, wParam, lParam) directly
  (func $handle_SendMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret_addr i32) (local $wndproc i32)
    ;; Look up wndproc from window table first
    (local.set $wndproc (call $wnd_table_get (local.get $arg0)))
    ;; WAT-native WndProc dispatch (e.g. help window)
    (if (i32.ge_u (local.get $wndproc) (i32.const 0xFFFF0000))
      (then
        (global.set $eax (call $wat_wndproc_dispatch
          (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    ;; Fall back to global wndproc if not in table
    (if (i32.eqz (local.get $wndproc))
      (then
        (if (i32.eq (local.get $arg0) (global.get $main_hwnd))
          (then (local.set $wndproc (global.get $wndproc_addr)))
          (else (if (global.get $wndproc_addr2)
            (then (local.set $wndproc (global.get $wndproc_addr2)))
            (else (local.set $wndproc (global.get $wndproc_addr))))))))
    ;; If no WndProc, return 0
    (if (i32.eqz (local.get $wndproc))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    ;; Save caller's return address
    (local.set $ret_addr (call $gl32 (global.get $esp)))
    ;; Pop SendMessageA frame (ret + 4 args = 20 bytes)
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
    ;; Push WndProc args right-to-left: lParam, wParam, msg, hwnd
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
    (call $gs32 (global.get $esp) (local.get $ret_addr))
    ;; Jump to WndProc
    (global.set $eip (local.get $wndproc))
    (global.set $steps (i32.const 0))
  )

  ;; 82: SendDlgItemMessageA — STUB: unimplemented
  (func $handle_SendDlgItemMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
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

  ;; 84: DestroyMenu — STUB: unimplemented
  (func $handle_DestroyMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 85: GetDC
  (func $handle_GetDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetDC(hwnd) → hdc = hwnd + 0x40000; GetDC(NULL) → 0x40000
    (global.set $eax (i32.add (local.get $arg0) (i32.const 0x40000)))
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

  ;; 87: GetMenu(hwnd) — return fake menu handle (resource ID based)
  (func $handle_GetMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return non-zero handle if window has a menu (we use 0x80001 as fake hmenu)
    (global.set $eax (i32.const 0x80001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 88: GetSubMenu — STUB: unimplemented
  (func $handle_GetSubMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
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
    (local $cs i32)
    ;; Fill RECT with client area — query host for per-window client size
    (local.set $cs (call $host_get_window_client_size (local.get $arg0)))
    (call $gs32 (local.get $arg1) (i32.const 0))       ;; left
    (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))   ;; top
    (call $gs32 (i32.add (local.get $arg1) (i32.const 8))
      (i32.and (local.get $cs) (i32.const 0xFFFF)))     ;; right = clientW
    (call $gs32 (i32.add (local.get $arg1) (i32.const 12))
      (i32.shr_u (local.get $cs) (i32.const 16)))       ;; bottom = clientH
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

  ;; 94: GetDlgCtrlID — STUB: unimplemented
  (func $handle_GetDlgCtrlID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 95: GetDlgItemTextA
  (func $handle_GetDlgItemTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.gt_u (local.get $arg3) (i32.const 0))
    (then (call $gs8 (local.get $arg2) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 96: GetDlgItem — STUB: unimplemented
  ;; GetDlgItem(hDlg, nIDDlgItem) — 2 args stdcall, return NULL
  (func $handle_GetDlgItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 97: GetCursorPos
  (func $handle_GetCursorPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $gs32 (local.get $arg0) (i32.const 0))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 98: GetLastActivePopup — STUB: unimplemented
  (func $handle_GetLastActivePopup (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 99: GetFocus — STUB: unimplemented
  (func $handle_GetFocus (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 100: ReleaseDC(hwnd, hdc) — release window DC, return 1
  (func $handle_ReleaseDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 101: SetWindowLongA — STUB: unimplemented
  (func $handle_SetWindowLongA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetWindowLongA(hWnd, nIndex, dwNewLong) — nIndex is signed
    ;; GWL_WNDPROC=-4, GWL_USERDATA=-21, GWL_STYLE=-16, GWL_EXSTYLE=-20, GWL_ID=-12
    ;; Also positive indices for dialog extra bytes (DWLP_USER etc.)
    (if (i32.eq (local.get $arg1) (i32.const -21))  ;; GWL_USERDATA
      (then
        (global.set $eax (call $wnd_set_userdata (local.get $arg0) (local.get $arg2)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (if (i32.eq (local.get $arg1) (i32.const -4))   ;; GWL_WNDPROC — subclass
      (then
        (global.set $eax (call $wnd_table_get (local.get $arg0)))  ;; return old wndproc
        (call $wnd_table_set (local.get $arg0) (local.get $arg2)) ;; set new wndproc
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    ;; For other indices (style, exstyle, positive offsets), store in userdata for now
    (if (i32.ge_s (local.get $arg1) (i32.const 0))  ;; positive offset = dialog extra bytes
      (then
        (global.set $eax (call $wnd_set_userdata (local.get $arg0) (local.get $arg2)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    ;; Default: return 0 for unhandled indices
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
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

  ;; 104: SetDlgItemInt(hDlg, nIDDlgItem, uValue, bSigned) — stub, ignore
  (func $handle_SetDlgItemInt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; stdcall, 4 args
  )

  ;; 105: SetForegroundWindow — STUB: unimplemented
  (func $handle_SetForegroundWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 106: SetCursor(hCursor) — 1 arg stdcall, return previous cursor (fake)
  (func $handle_SetCursor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 107: SetFocus(hwnd) — 1 arg stdcall, return 0 (no previous focus)
  (func $handle_SetFocus (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 108: LoadCursorA(hInstance, lpCursorName) — return fake cursor handle
  (func $handle_LoadCursorA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x60002)) ;; fake HCURSOR
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 109: LoadIconA(hInstance, lpIconName) — return fake icon handle
  (func $handle_LoadIconA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x60001)) ;; fake HICON
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
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

  ;; 112: EnableWindow — STUB: unimplemented
  (func $handle_EnableWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 113: EnableMenuItem(hMenu, uIDEnableItem, uEnable) — stub, return previous state
  (func $handle_EnableMenuItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 114: EndDialog(hDlg, nResult) — stub, return 1
  (func $handle_EndDialog (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 115: InvalidateRect
  (func $handle_InvalidateRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Route paint to main or child window
    (if (i32.eq (local.get $arg0) (global.get $main_hwnd))
    (then (global.set $paint_pending (i32.const 1)))
    (else (if (i32.ne (local.get $arg0) (i32.const 0))
    (then (global.set $child_paint_hwnd (local.get $arg0))))))
    (call $host_invalidate (local.get $arg0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 116: FillRect(hdc, lprc, hbr) — delegate to host GDI
  (func $handle_FillRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; FillRect(hDC, lpRect, hBrush) — arg0=hDC, arg1=lpRect, arg2=hBrush
    (global.set $eax (call $host_gdi_fill_rect (local.get $arg0)
      (call $gl32 (local.get $arg1))           ;; left
      (call $gl32 (i32.add (local.get $arg1) (i32.const 4)))   ;; top
      (call $gl32 (i32.add (local.get $arg1) (i32.const 8)))   ;; right
      (call $gl32 (i32.add (local.get $arg1) (i32.const 12)))  ;; bottom
      (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 117: FrameRect(hdc, lprc, hbr) — draw 1px frame using brush
  (func $handle_FrameRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    (global.set $eax (call $host_gdi_frame_rect
      (local.get $arg0)
      (i32.load (local.get $wa))                          ;; left
      (i32.load (i32.add (local.get $wa) (i32.const 4)))  ;; top
      (i32.load (i32.add (local.get $wa) (i32.const 8)))  ;; right
      (i32.load (i32.add (local.get $wa) (i32.const 12))) ;; bottom
      (local.get $arg2)                                    ;; hbrush
      (global.get $main_hwnd)
    ))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; 118: LoadBitmapA
  (func $handle_LoadBitmapA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    ;; arg1 = resource ID (MAKEINTRESOURCE value, low 16 bits)
    (local.set $tmp (call $host_gdi_load_bitmap (local.get $arg0) (i32.and (local.get $arg1) (i32.const 0xFFFF))))
    ;; If host couldn't find it, return a fake 32x32 bitmap
    (if (i32.eqz (local.get $tmp))
    (then (local.set $tmp (call $host_gdi_create_compat_bitmap (i32.const 0) (i32.const 32) (i32.const 32)))))
    (global.set $eax (local.get $tmp))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 119: OpenIcon(hwnd) — restores a minimized window; return nonzero
  (func $handle_OpenIcon (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 120: MoveWindow — hwnd(arg0), x(arg1), y(arg2), w(arg3), h(arg4), bRepaint=[esp+24]
  (func $handle_MoveWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_move_window (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
  )

  ;; 121: CheckMenuRadioItem — STUB: unimplemented
  (func $handle_CheckMenuRadioItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 122: CheckMenuItem(hMenu, uIDCheckItem, uCheck) — return previous state
  ;; TODO: track menu check state in renderer
  (func $handle_CheckMenuItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))  ;; MF_UNCHECKED as previous state
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
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

  ;; 127: IsDialogMessageA — STUB: unimplemented
  (func $handle_IsDialogMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 128: IsIconic(hwnd) — 1 arg stdcall, return 0 (not minimized)
  (func $handle_IsIconic (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 129: ChildWindowFromPoint — STUB: unimplemented
  (func $handle_ChildWindowFromPoint (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 130: ScreenToClient — STUB: unimplemented
  (func $handle_ScreenToClient (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 131: TabbedTextOutA — STUB: unimplemented
  (func $handle_TabbedTextOutA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 132: WinHelpA(hwnd, lpszHelp, uCommand, dwData) — 4 args stdcall, return TRUE
  (func $handle_WinHelpA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; WinHelpA(hwndCaller, lpszHelp, uCommand, dwData)
    ;; arg0=hwndCaller, arg1=lpszHelp (guest ptr), arg2=uCommand, arg3=dwData
    ;; HELP_QUIT=2: close help window
    (if (i32.eq (local.get $arg2) (i32.const 2))
      (then
        (if (global.get $help_hwnd) (then (call $help_destroy)))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    ;; Load HLP file if not already loaded
    (if (i32.eqz (global.get $help_file_wa))
      (then
        (if (local.get $arg1)
          (then (call $help_load_file (local.get $arg1))))))
    ;; Create help window if not open
    (if (i32.eqz (global.get $help_hwnd))
      (then (call $help_create_window)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 133: IsChild
  (func $handle_IsChild (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (if (result i32) (i32.and
    (i32.ne (global.get $dlg_hwnd) (i32.const 0))
    (i32.eq (local.get $arg0) (global.get $dlg_hwnd)))
    (then (i32.const 1)) (else (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 134: GetSysColorBrush(nIndex) — 1 arg stdcall
  (func $handle_GetSysColorBrush (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $color i32)
    (if (i32.eq (local.get $arg0) (i32.const 5))
      (then (local.set $color (i32.const 0x00FFFFFF)))
      (else (if (i32.eq (local.get $arg0) (i32.const 15))
        (then (local.set $color (i32.const 0x00C0C0C0)))
        (else (local.set $color (i32.const 0x00C0C0C0))))))
    (global.set $eax (call $host_gdi_create_solid_brush (local.get $color)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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

  ;; 136: DialogBoxParamA(hInstance, lpTemplate, hWndParent, lpDialogFunc, dwInitParam)
  ;; Stub: return IDCANCEL (2) — pretend dialog was cancelled
  (func $handle_DialogBoxParamA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 2))  ;; IDCANCEL
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; stdcall, 5 args
  )

  ;; 137: LoadMenuA(hInstance, lpMenuName) — 2 args stdcall
  ;; Return menu resource ID as handle (host renderer resolves by ID)
  (func $handle_LoadMenuA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; If lpMenuName < 0x10000, it's MAKEINTRESOURCE (resource ID)
    (if (i32.lt_u (local.get $arg1) (i32.const 0x10000))
      (then (global.set $eax (i32.or (local.get $arg1) (i32.const 0x00BE0000))))
      (else (global.set $eax (i32.const 0x00BE0001))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 138: TrackPopupMenuEx — STUB: unimplemented
  (func $handle_TrackPopupMenuEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 139: OffsetRect — STUB: unimplemented
  (func $handle_OffsetRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; OffsetRect(lprc, dx, dy) → BOOL. Moves rect by (dx, dy)
    ;; RECT: left, top, right, bottom (4 DWORDs)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (i32.store (local.get $wa) (i32.add (i32.load (local.get $wa)) (local.get $arg1)))                        ;; left += dx
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.add (i32.load (i32.add (local.get $wa) (i32.const 4))) (local.get $arg2)))  ;; top += dy
    (i32.store (i32.add (local.get $wa) (i32.const 8)) (i32.add (i32.load (i32.add (local.get $wa) (i32.const 8))) (local.get $arg1)))  ;; right += dx
    (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.add (i32.load (i32.add (local.get $wa) (i32.const 12))) (local.get $arg2))) ;; bottom += dy
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; 140: MapWindowPoints — STUB: unimplemented
  (func $handle_MapWindowPoints (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 141: SetWindowPos — STUB: unimplemented
  (func $handle_SetWindowPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
  )

  ;; 142: DrawTextA(hdc, lpString, nCount, lpRect, uFormat)
  (func $handle_DrawTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_draw_text
      (local.get $arg0)
      (call $g2w (local.get $arg1))
      (local.get $arg2)
      (call $g2w (local.get $arg3))
      (local.get $arg4)
      (i32.const 0) ;; isWide = 0
    ))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; stdcall, 5 args
  )

  ;; 143: DrawEdge — STUB: unimplemented
  (func $handle_DrawEdge (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 144: GetClipboardData — STUB: unimplemented
  (func $handle_GetClipboardData (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 145: SelectObject(hdc, hObject) — delegate to host GDI
  (func $handle_SelectObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_select_object (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 146: DeleteObject(hObject) — delegate to host GDI
  (func $handle_DeleteObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_delete_object (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 147: DeleteDC(hdc) — delegate to host GDI
  (func $handle_DeleteDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_delete_dc (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 148: CreatePen(style, width, color) — delegate to host GDI
  (func $handle_CreatePen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_create_pen (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 149: CreateSolidBrush(color) — delegate to host GDI
  (func $handle_CreateSolidBrush (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_create_solid_brush (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 150: CreateCompatibleDC(hdc) — delegate to host GDI
  (func $handle_CreateCompatibleDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_create_compat_dc (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 151: CreateCompatibleBitmap(hdc, w, h) — delegate to host GDI
  (func $handle_CreateCompatibleBitmap (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_create_compat_bitmap (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
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
    (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 154: MoveToEx(hdc, x, y, lpPoint) — delegate to host GDI
  (func $handle_MoveToEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_move_to (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 155: LineTo(hdc, x, y) — delegate to host GDI
  (func $handle_LineTo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_line_to (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 156: Ellipse
  (func $handle_Ellipse (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_ellipse
    (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 157: Arc
  (func $handle_Arc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_arc
    (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
    (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 32)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 36)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 40))) (return)
  )

  ;; 158: BitBlt
  (func $handle_BitBlt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_bitblt
    (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
    (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 32)))
    (call $gl32 (i32.add (global.get $esp) (i32.const 36)))))
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
      (local.get $tmp)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
  )

  ;; 160: CreateBitmap — nWidth(arg0), nHeight(arg1), nPlanes(arg2), nBitCount(arg3), lpBits(arg4)
  (func $handle_CreateBitmap (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (local.get $arg4))
      (then
        ;; NULL lpBits — create blank bitmap, pass bpp so host can mark monochrome
        (global.set $eax (call $host_gdi_create_bitmap
          (local.get $arg0) (local.get $arg1) (local.get $arg3) (i32.const 0))))
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
      (call $g2w (local.get $arg3)) (local.get $arg4)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
  )

  ;; 162: GetStockObject(index) → stock object handle (0x30010 + index)
  (func $handle_GetStockObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.add (i32.const 0x30010) (i32.and (local.get $arg0) (i32.const 0x1F))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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

  ;; 164: GetTextMetricsA — queries host for font-aware metrics
  (func $handle_GetTextMetricsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $w i32) (local $packed i32) (local $h i32) (local $aveW i32)
    (local.set $w (call $g2w (local.get $arg1)))
    (local.set $packed (call $host_get_text_metrics (local.get $arg0))) ;; hdc
    (local.set $h (i32.and (local.get $packed) (i32.const 0xFFFF)))
    (local.set $aveW (i32.shr_u (local.get $packed) (i32.const 16)))
    (call $zero_memory (local.get $w) (i32.const 56))
    (call $gs32 (local.get $arg1) (local.get $h))                                    ;; tmHeight
    (call $gs32 (i32.add (local.get $arg1) (i32.const 4))
      (i32.sub (local.get $h) (i32.const 3)))                                        ;; tmAscent ~= h-3
    (call $gs32 (i32.add (local.get $arg1) (i32.const 8)) (i32.const 3))             ;; tmDescent = 3
    (call $gs32 (i32.add (local.get $arg1) (i32.const 20)) (local.get $aveW))        ;; tmAveCharWidth
    (call $gs32 (i32.add (local.get $arg1) (i32.const 24))
      (i32.mul (local.get $aveW) (i32.const 2)))                                     ;; tmMaxCharWidth ~= 2*ave
    (call $gs32 (i32.add (local.get $arg1) (i32.const 28)) (i32.const 400))          ;; tmWeight = FW_NORMAL
    (i32.store8 (i32.add (local.get $w) (i32.const 40)) (i32.const 32))              ;; tmFirstChar = 0x20
    (i32.store8 (i32.add (local.get $w) (i32.const 41)) (i32.const 255))             ;; tmLastChar = 0xFF
    (i32.store8 (i32.add (local.get $w) (i32.const 42)) (i32.const 31))              ;; tmDefaultChar
    (i32.store8 (i32.add (local.get $w) (i32.const 44)) (i32.const 0x26))            ;; tmPitchAndFamily
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 165: GetTextExtentPointA — font-aware text measurement via host
  (func $handle_GetTextExtentPointA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $packed i32)
    (local.set $packed (call $host_get_text_metrics (local.get $arg0))) ;; get height from hdc font
    (call $gs32 (local.get $arg3)
      (call $host_measure_text (local.get $arg0) (call $g2w (local.get $arg1)) (local.get $arg2))) ;; cx
    (call $gs32 (i32.add (local.get $arg3) (i32.const 4))
      (i32.and (local.get $packed) (i32.const 0xFFFF)))                                            ;; cy
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 166: GetTextCharset — STUB: unimplemented
  (func $handle_GetTextCharset (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 167: CreateFontIndirectA — LOGFONT at arg0
  (func $handle_CreateFontIndirectA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $lf i32)
    (local.set $lf (call $g2w (local.get $arg0)))
    ;; LOGFONT: lfHeight(+0), lfWeight(+16), lfItalic(+20), lfFaceName(+28)
    (global.set $eax (call $host_create_font
      (i32.load (local.get $lf))                              ;; height
      (i32.load (i32.add (local.get $lf) (i32.const 16)))    ;; weight
      (i32.load8_u (i32.add (local.get $lf) (i32.const 20))) ;; italic
      (i32.add (local.get $lf) (i32.const 28))               ;; faceName WASM ptr
    ))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 168: CreateFontA — 14 params on stack
  (func $handle_CreateFontA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; arg0=nHeight, esp+16=fnWeight, esp+20=bItalic, esp+52=lpszFace
    (global.set $eax (call $host_create_font
      (local.get $arg0)                                              ;; height
      (call $gl32 (i32.add (global.get $esp) (i32.const 16)))       ;; weight
      (call $gl32 (i32.add (global.get $esp) (i32.const 20)))       ;; italic
      (call $g2w (call $gl32 (i32.add (global.get $esp) (i32.const 52)))) ;; faceName
    ))
    (global.set $esp (i32.add (global.get $esp) (i32.const 60))) (return)
  )

  ;; 169: CreateDCA — STUB: unimplemented
  (func $handle_CreateDCA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 170: SetAbortProc — STUB: unimplemented
  (func $handle_SetAbortProc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 171: SetBkColor(hdc, color) → prev color
  (func $handle_SetBkColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_set_bk_color (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 172: SetBkMode(hdc, mode) → prev mode
  (func $handle_SetBkMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetBkMode(hdc, mode) → previous mode. mode: 1=TRANSPARENT, 2=OPAQUE
    (global.set $eax (call $host_gdi_set_bk_mode (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 173: SetTextColor(hdc, color) → prev color
  (func $handle_SetTextColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_set_text_color (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 174: SetMenu
  (func $handle_SetMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_set_menu
    (local.get $arg0)                                       ;; hWnd
    (i32.and (local.get $arg1) (i32.const 0xFFFF)))         ;; resource ID from HMENU
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 175: SetMapMode — STUB: unimplemented
  (func $handle_SetMapMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 176: SetWindowExtEx — STUB: unimplemented
  (func $handle_SetWindowExtEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 177: LPtoDP — STUB: unimplemented
  (func $handle_LPtoDP (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 178: StartDocA — STUB: unimplemented
  (func $handle_StartDocA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 179: StartPage — STUB: unimplemented
  (func $handle_StartPage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 180: EndPage — STUB: unimplemented
  (func $handle_EndPage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 181: EndPaint(hwnd, lpPaintStruct) — return TRUE
  (func $handle_EndPaint (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 182: EndDoc — STUB: unimplemented
  (func $handle_EndDoc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 183: AbortDoc — STUB: unimplemented
  (func $handle_AbortDoc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 184: SetCapture — STUB: unimplemented
  (func $handle_SetCapture (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetCapture(hwnd) → previous capture hwnd. 1 arg stdcall
    (global.set $eax (global.get $capture_hwnd))
    (global.set $capture_hwnd (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 185: ReleaseCapture() → BOOL. 0 args stdcall
  (func $handle_ReleaseCapture (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $capture_hwnd (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 186: ShowCursor — STUB: unimplemented
  (func $handle_ShowCursor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; ShowCursor(bShow) → display count. 1 arg stdcall
    ;; Track internal display count: show increments, hide decrements
    (if (local.get $arg0)
      (then (global.set $cursor_count (i32.add (global.get $cursor_count) (i32.const 1))))
      (else (global.set $cursor_count (i32.sub (global.get $cursor_count) (i32.const 1)))))
    (global.set $eax (global.get $cursor_count))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 187: KillTimer(hwnd, nIDEvent) — clear the timer
  (func $handle_KillTimer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $timer_id (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 188: SetTimer
  (func $handle_SetTimer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $timer_id (local.get $arg1))
    (global.set $timer_hwnd (local.get $arg0))
    (global.set $timer_callback (local.get $arg3))
    (global.set $eax (local.get $arg1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 189: FindWindowA(lpClassName, lpWindowName) — return NULL (no existing window found)
  (func $handle_FindWindowA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))  ;; NULL — no window found
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 190: BringWindowToTop — STUB: unimplemented
  (func $handle_BringWindowToTop (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 191: GetPrivateProfileIntA(lpAppName, lpKeyName, nDefault, lpFileName)
  ;; No INI file support — return nDefault (arg2)
  (func $handle_GetPrivateProfileIntA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetPrivateProfileIntA(appName, keyName, nDefault, fileName) — 4 args stdcall
    (global.set $eax (call $host_ini_get_int
      (call $g2w (local.get $arg0))
      (call $g2w (local.get $arg1))
      (local.get $arg2)
      (call $g2w (local.get $arg3))
      (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 192: WritePrivateProfileStringA(appName, keyName, string, fileName) — 4 args stdcall
  (func $handle_WritePrivateProfileStringA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_ini_write_string
      (call $g2w (local.get $arg0))
      (if (result i32) (local.get $arg1) (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (if (result i32) (local.get $arg2) (then (call $g2w (local.get $arg2))) (else (i32.const 0)))
      (call $g2w (local.get $arg3))
      (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 193: ShellExecuteA — STUB: unimplemented
  (func $handle_ShellExecuteA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; ShellExecuteA(hwnd, lpOperation, lpFile, lpParameters, lpDirectory, nShowCmd)
    ;; Return >32 for success (we can't actually launch anything)
    (global.set $eax (i32.const 33))  ;; SE_ERR_NOASSOC would be 31, 33 = success
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; stdcall, 6 args
  )

  ;; 194: ShellAboutA(hwnd, szApp, szOtherStuff, hIcon) — show About dialog
  (func $handle_ShellAboutA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_shell_about (local.get $arg0) (call $g2w (local.get $arg1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 195: SHGetSpecialFolderPathA(hwnd, pszPath, csidl, fCreate) — write fake path, return TRUE
  (func $handle_SHGetSpecialFolderPathA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    ;; Write "C:\WINDOWS" as the special folder path
    (i32.store (local.get $wa) (i32.const 0x575C3A43))          ;; "C:\W"
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0x4F444E49))  ;; "INDO"
    (i32.store16 (i32.add (local.get $wa) (i32.const 8)) (i32.const 0x5357))    ;; "WS"
    (i32.store8 (i32.add (local.get $wa) (i32.const 10)) (i32.const 0))         ;; null term
    (global.set $eax (i32.const 1))  ;; TRUE
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 196: DragAcceptFiles(hwnd, fAccept) — no-op (no drag-drop support)
  (func $handle_DragAcceptFiles (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 197: DragQueryFileA — STUB: unimplemented
  (func $handle_DragQueryFileA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 198: DragFinish — STUB: unimplemented
  (func $handle_DragFinish (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 199: GetOpenFileNameA — STUB: unimplemented
  (func $handle_GetOpenFileNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 200: GetFileTitleA — STUB: unimplemented
  (func $handle_GetFileTitleA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 201: ChooseFontA — STUB: unimplemented
  (func $handle_ChooseFontA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 202: FindTextA — STUB: unimplemented
  (func $handle_FindTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 203: PageSetupDlgA — STUB: unimplemented
  (func $handle_PageSetupDlgA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 204: CommDlgExtendedError — STUB: unimplemented
  (func $handle_CommDlgExtendedError (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
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

  ;; 210: _initterm(start, end) — CRT init table walker, skip for now
  (func $handle__initterm (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 211: _controlfp(new, mask) — return default FPU control word
  (func $handle__controlfp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x9001F))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
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

  ;; 217: _CxxThrowException — STUB: unimplemented
  (func $handle__CxxThrowException (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
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

  ;; 223: RegCloseKey(hKey) — 1 arg stdcall
  (func $handle_RegCloseKey (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_reg_close_key (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 224: RegCreateKeyA(hKey, lpSubKey, phkResult) — 3 args stdcall
  (func $handle_RegCreateKeyA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_reg_create_key
      (local.get $arg0) (call $g2w (local.get $arg1)) (local.get $arg2) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 225: RegQueryValueExA(hKey, lpValueName, lpReserved, lpType, lpData, lpcbData) — 6 args stdcall
  (func $handle_RegQueryValueExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa_esp i32) (local $lpData i32) (local $lpcbData i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $lpData (local.get $arg4))
    (local.set $lpcbData (i32.load (i32.add (local.get $wa_esp) (i32.const 24))))
    (global.set $eax (call $host_reg_query_value
      (local.get $arg0)                                          ;; hKey
      (if (result i32) (local.get $arg1)                         ;; lpValueName
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (local.get $arg3)                                          ;; lpType (guest addr)
      (local.get $lpData)                                        ;; lpData (guest addr)
      (local.get $lpcbData)                                      ;; lpcbData (guest addr)
      (i32.const 0)))                                            ;; isWide=0
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 226: RegSetValueExA(hKey, lpValueName, Reserved, dwType, lpData, cbData) — 6 args stdcall
  (func $handle_RegSetValueExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa_esp i32) (local $cbData i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $cbData (i32.load (i32.add (local.get $wa_esp) (i32.const 24))))
    (global.set $eax (call $host_reg_set_value
      (local.get $arg0)                                          ;; hKey
      (if (result i32) (local.get $arg1)                         ;; lpValueName
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (local.get $arg3)                                          ;; dwType
      (local.get $arg4)                                          ;; lpData (guest addr)
      (local.get $cbData)                                        ;; cbData
      (i32.const 0)))                                            ;; isWide=0
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
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

  ;; 238: GlobalCompact — STUB: unimplemented
  (func $handle_GlobalCompact (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 239: RegOpenKeyA
  (func $handle_RegOpenKeyA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; RegOpenKeyA(hKey, lpSubKey, phkResult) — 3 args stdcall
    (local $hResult i32)
    (local.set $hResult (call $host_reg_open_key
      (local.get $arg0) (call $g2w (local.get $arg1)) (i32.const 0)))
    (if (local.get $hResult)
      (then (call $gs32 (local.get $arg2) (local.get $hResult))
             (global.set $eax (i32.const 0)))  ;; ERROR_SUCCESS
      (else (global.set $eax (i32.const 2))))  ;; ERROR_FILE_NOT_FOUND
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 240: RegOpenKeyExA(hKey, lpSubKey, ulOptions, samDesired, phkResult) — 5 args stdcall
  (func $handle_RegOpenKeyExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hResult i32)
    (local.set $hResult (call $host_reg_open_key
      (local.get $arg0) (call $g2w (local.get $arg1)) (i32.const 0)))
    (if (local.get $hResult)
      (then (call $gs32 (local.get $arg4) (local.get $hResult))
             (global.set $eax (i32.const 0)))
      (else (global.set $eax (i32.const 2))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 241: RegisterClassExA
  (func $handle_RegisterClassExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $class_name_wa i32)
    ;; WNDCLASSEX: cbSize(+0) style(+4) lpfnWndProc(+8) ... hbrBackground(+32) lpszClassName(+40)
    (local.set $tmp (call $gl32 (i32.add (local.get $arg0) (i32.const 8)))) ;; lpfnWndProc
    (local.set $class_name_wa (call $g2w (call $gl32 (i32.add (local.get $arg0) (i32.const 40)))))
    ;; Register in class table (hwnd→wndproc lookup for multi-window dispatch)
    (global.set $eax (call $class_table_register (local.get $class_name_wa) (local.get $tmp)))
    ;; Store first wndproc as main for backward compat
    (if (i32.eqz (global.get $wndproc_addr))
    (then
      (global.set $wndproc_addr (local.get $tmp))
      (global.set $wndclass_style (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
      (global.set $wndclass_bg_brush (call $gl32 (i32.add (local.get $arg0) (i32.const 32))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 242: RegisterClassA
  (func $handle_RegisterClassA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $class_name_wa i32)
    ;; WNDCLASSA: style(+0) lpfnWndProc(+4) cbClsExtra(+8) cbWndExtra(+12)
    ;;   hInstance(+16) hIcon(+20) hCursor(+24) hbrBackground(+28)
    ;;   lpszMenuName(+32) lpszClassName(+36)
    (local.set $tmp (call $gl32 (i32.add (local.get $arg0) (i32.const 4)))) ;; lpfnWndProc
    (local.set $class_name_wa (call $g2w (call $gl32 (i32.add (local.get $arg0) (i32.const 36)))))
    ;; Register in class table
    (global.set $eax (call $class_table_register (local.get $class_name_wa) (local.get $tmp)))
    ;; Store first wndproc as main for backward compat
    (if (i32.eqz (global.get $wndproc_addr))
    (then
      (global.set $wndproc_addr (local.get $tmp))
      (global.set $wndclass_style (call $gl32 (local.get $arg0)))
      (global.set $wndclass_bg_brush (call $gl32 (i32.add (local.get $arg0) (i32.const 28))))))
    (global.set $eax (i32.const 0xC001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 243: BeginPaint
  (func $handle_BeginPaint (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $cs i32)
    ;; Fill PAINTSTRUCT: hdc(+0), fErase(+4), rcPaint(+8: left,top,right,bottom)
    (call $zero_memory (call $g2w (local.get $arg1)) (i32.const 64))
    (call $gs32 (local.get $arg1) (i32.add (local.get $arg0) (i32.const 0x40000))) ;; hdc = hwnd + 0x40000
    (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 1)) ;; fErase = TRUE
    ;; rcPaint = {0, 0, clientW, clientH} — query host for per-window client size
    ;; left(+8) and top(+12) already 0 from zero_memory
    (local.set $cs (call $host_get_window_client_size (local.get $arg0)))
    (call $gs32 (i32.add (local.get $arg1) (i32.const 16))
      (i32.and (local.get $cs) (i32.const 0xFFFF)))        ;; right = clientW
    (call $gs32 (i32.add (local.get $arg1) (i32.const 20))
      (i32.shr_u (local.get $cs) (i32.const 16)))          ;; bottom = clientH
    (global.set $eax (i32.add (local.get $arg0) (i32.const 0x40000)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 244: OpenClipboard — STUB: unimplemented
  (func $handle_OpenClipboard (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 245: CloseClipboard — STUB: unimplemented
  (func $handle_CloseClipboard (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 246: IsClipboardFormatAvailable — STUB: unimplemented
  (func $handle_IsClipboardFormatAvailable (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
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

  ;; 248: GetSaveFileNameA — STUB: unimplemented
  (func $handle_GetSaveFileNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 249: SetViewportExtEx — STUB: unimplemented
  (func $handle_SetViewportExtEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 250: lstrcmpiA
  (func $handle_lstrcmpiA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $dispatch_lstr (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
  )

  ;; 251: FreeEnvironmentStringsA — no-op (we don't really alloc env strings)
  (func $handle_FreeEnvironmentStringsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 252: FreeEnvironmentStringsW — no-op (we don't really alloc env strings)
  (func $handle_FreeEnvironmentStringsW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 253: GetVersion — return winver, 0 args
  (func $handle_GetVersion (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $winver))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 254: GetTextExtentPoint32A — font-aware via host
  (func $handle_GetTextExtentPoint32A (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $packed i32)
    (local.set $packed (call $host_get_text_metrics (local.get $arg0)))
    (call $gs32 (local.get $arg3)
      (call $host_measure_text (local.get $arg0) (call $g2w (local.get $arg1)) (local.get $arg2)))
    (call $gs32 (i32.add (local.get $arg3) (i32.const 4))
      (i32.and (local.get $packed) (i32.const 0xFFFF)))
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

  ;; 256: GetPrivateProfileStringA — STUB: unimplemented
  (func $handle_GetPrivateProfileStringA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetPrivateProfileStringA(appName, keyName, default, retBuf, nSize, fileName) — 6 args stdcall
    (local $wa_esp i32) (local $fileName i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $fileName (i32.load (i32.add (local.get $wa_esp) (i32.const 24))))
    (global.set $eax (call $host_ini_get_string
      (if (result i32) (local.get $arg0) (then (call $g2w (local.get $arg0))) (else (i32.const 0)))
      (if (result i32) (local.get $arg1) (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (if (result i32) (local.get $arg2) (then (call $g2w (local.get $arg2))) (else (i32.const 0)))
      (local.get $arg3)         ;; retBuf (guest addr — host will g2w)
      (local.get $arg4)         ;; nSize
      (call $g2w (local.get $fileName))
      (i32.const 0)))           ;; isWide=0
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

  ;; 260: __set_app_type(type) — sets GUI vs console, no-op for us
  (func $handle___set_app_type (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 261: __setusermatherr(handler) — set math error handler, no-op
  (func $handle___setusermatherr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 262: _adjust_fdiv
  (func $handle__adjust_fdiv (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return pointer to a 0 dword (no FDIV bug)
    (if (i32.eqz (global.get $msvcrt_fmode_ptr))
      (then (global.set $msvcrt_fmode_ptr (call $heap_alloc (i32.const 4)))))
    (global.set $eax (global.get $msvcrt_fmode_ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 263: free(ptr) — cdecl
  (func $handle_free (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $heap_free (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 264: malloc(size) — cdecl
  (func $handle_malloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $heap_alloc (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 265: calloc(num, size) — cdecl
  (func $handle_calloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    (local.set $tmp (i32.mul (local.get $arg0) (local.get $arg1)))
    (global.set $eax (call $heap_alloc (local.get $tmp)))
    (call $zero_memory (call $g2w (global.get $eax)) (local.get $tmp))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 266: rand
  (func $handle_rand (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $rand_seed (i32.add (i32.mul (global.get $rand_seed) (i32.const 1103515245)) (i32.const 12345)))
    (global.set $eax (i32.and (i32.shr_u (global.get $rand_seed) (i32.const 16)) (i32.const 0x7FFF)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 267: srand(seed) — cdecl
  (func $handle_srand (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $rand_seed (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 268: _purecall
  (func $handle__purecall (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_exit (i32.const 3))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 269: _onexit — STUB: unimplemented
  (func $handle__onexit (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 270: __dllonexit — STUB: unimplemented
  (func $handle___dllonexit (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 271: _splitpath — STUB: unimplemented
  (func $handle__splitpath (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 272: _wcsicmp — STUB: unimplemented
  (func $handle__wcsicmp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
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

  ;; 274: _itow — int to wide string (STUB: unimplemented: write "0")
  (func $handle__itow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 275: wcscmp — STUB: unimplemented
  (func $handle_wcscmp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
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
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 277: wcslen — STUB: unimplemented
  (func $handle_wcslen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 278: memset(dest, ch, count) — cdecl
  (func $handle_memset (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg2)
      (then (memory.fill (call $g2w (local.get $arg0)) (local.get $arg1) (local.get $arg2))))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 279: memcpy(dest, src, count) — cdecl
  (func $handle_memcpy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg2)
      (then (memory.copy (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (local.get $arg2))))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 280: __CxxFrameHandler — C++ exception frame handler (STUB: unimplemented, return 1=ExceptionContinueSearch)
  (func $handle___CxxFrameHandler (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 281: _global_unwind2 — STUB: unimplemented
  (func $handle__global_unwind2 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 282: _getdcwd — STUB: unimplemented: return empty string
  (func $handle__getdcwd (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 283: GetModuleHandleW(lpModuleName) — NULL→image_base (W version, DLL lookup TODO)
  (func $handle_GetModuleHandleW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (local.get $arg0))
      (then (global.set $eax (global.get $image_base)))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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
    ;; Store window outer dimensions
    (global.set $main_win_cx (call $gl32 (i32.add (global.get $esp) (i32.const 28))))
    (global.set $main_win_cy (call $gl32 (i32.add (global.get $esp) (i32.const 32))))
    ;; Non-client height: borders(3+3) + caption(19) = 25, plus menu(20) if present
    (global.set $main_nc_height (select (i32.const 45) (i32.const 25)
      (i32.ne (call $gl32 (i32.add (global.get $esp) (i32.const 40))) (i32.const 0))))
    ;; Client = outer - borders(6w) - nc_height
    (global.set $pending_wm_size (i32.or
    (i32.and (i32.sub (global.get $main_win_cx) (i32.const 6)) (i32.const 0xFFFF))
    (i32.shl (i32.sub (global.get $main_win_cy) (global.get $main_nc_height)) (i32.const 16)))))
    (else
    ;; Child window: flag pending WM_CREATE + WM_SIZE (delivered before main WM_SIZE)
    (global.set $pending_child_create (global.get $next_hwnd))
    (global.set $pending_child_size (i32.or
      (i32.and (call $gl32 (i32.add (global.get $esp) (i32.const 28))) (i32.const 0xFFFF))
      (i32.shl (call $gl32 (i32.add (global.get $esp) (i32.const 32))) (i32.const 16))))
    (global.set $child_paint_hwnd (global.get $next_hwnd))
    ))
    ;; Store parent hwnd (hWndParent = [esp+36])
    (call $wnd_set_parent (global.get $next_hwnd)
      (call $gl32 (i32.add (global.get $esp) (i32.const 36))))
    (global.set $eax (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 52))) (return)
  )

  ;; 287: RegisterClassW — STUB: unimplemented, return 1
  (func $handle_RegisterClassW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; RegisterClassW — same layout as RegisterClassA, just Unicode strings
    (local $tmp i32)
    (local.set $tmp (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (if (i32.eqz (global.get $wndproc_addr))
    (then
      (global.set $wndproc_addr (local.get $tmp))
      (global.set $wndclass_style (call $gl32 (local.get $arg0)))
      (global.set $wndclass_bg_brush (call $gl32 (i32.add (local.get $arg0) (i32.const 28)))))
    (else (global.set $wndproc_addr2 (local.get $tmp))))
    (global.set $eax (i32.const 0xC001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 288: RegisterClassExW — STUB: unimplemented, return 1
  (func $handle_RegisterClassExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 289: DefWindowProcW — same as DefWindowProcA
  (func $handle_DefWindowProcW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; WM_CLOSE (0x10): call DestroyWindow(hwnd)
    (if (i32.eq (local.get $arg1) (i32.const 0x0010))
    (then
    (global.set $quit_flag (i32.const 1))))
    ;; WM_ERASEBKGND (0x14): fill client area with background brush
    (if (i32.eq (local.get $arg1) (i32.const 0x0014))
    (then
    (global.set $eax (call $host_erase_background (local.get $arg0) (global.get $wndclass_bg_brush)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 290: LoadCursorW — return fake handle — STUB: unimplemented
  (func $handle_LoadCursorW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; LoadCursorW(hInstance, lpCursorName) → HCURSOR. Same as LoadCursorA
    (global.set $eax (i32.const 0x60002))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 291: LoadIconW — return fake handle — STUB: unimplemented
  (func $handle_LoadIconW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; LoadIconW(hInstance, lpIconName) → HICON. Same as LoadIconA
    (global.set $eax (i32.const 0x60001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 292: LoadMenuW — return fake handle — STUB: unimplemented
  (func $handle_LoadMenuW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; LoadMenuW — same as LoadMenuA
    (if (i32.lt_u (local.get $arg1) (i32.const 0x10000))
      (then (global.set $eax (i32.or (local.get $arg1) (i32.const 0x00BE0000))))
      (else (global.set $eax (i32.const 0x00BE0001))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 293: MessageBoxW — return IDOK (1), 4 args stdcall
  (func $handle_MessageBoxW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 294: SetWindowTextW — STUB: unimplemented
  (func $handle_SetWindowTextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 295: GetWindowTextW — STUB: unimplemented, return 0
  (func $handle_GetWindowTextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 296: SendMessageW — return 0, 4 args stdcall
  (func $handle_SendMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 297: PostMessageW — same as PostMessageA
  (func $handle_PostMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    ;; Queue if room (max 8 messages, 16 bytes each, at WASM addr 0x400)
    (if (i32.lt_u (global.get $post_queue_count) (i32.const 8))
    (then
    (local.set $tmp (i32.add (i32.const 0x400)
    (i32.mul (global.get $post_queue_count) (i32.const 16))))
    (i32.store (local.get $tmp) (local.get $arg0))
    (i32.store (i32.add (local.get $tmp) (i32.const 4)) (local.get $arg1))
    (i32.store (i32.add (local.get $tmp) (i32.const 8)) (local.get $arg2))
    (i32.store (i32.add (local.get $tmp) (i32.const 12)) (local.get $arg3))
    (global.set $post_queue_count (i32.add (global.get $post_queue_count) (i32.const 1)))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 298: SetErrorMode — return 0, 1 arg stdcall
  (func $handle_SetErrorMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 299: GetCurrentThreadId — single-threaded, always return 1
  (func $handle_GetCurrentThreadId (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 300: LoadLibraryW — STUB: unimplemented, return fake handle
  (func $handle_LoadLibraryW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 301: GetStartupInfoW — zero-fill the struct
  (func $handle_GetStartupInfoW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $zero_memory (call $g2w (local.get $arg0)) (i32.const 68))
    ;; Set cb = 68 (sizeof STARTUPINFOW)
    (call $gs32 (local.get $arg0) (i32.const 68))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 302: GetKeyState — STUB: unimplemented
  (func $handle_GetKeyState (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 303: GetParent — STUB: unimplemented
  ;; GetParent(hwnd) — 1 arg stdcall, return parent hwnd or 0
  (func $handle_GetParent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $wnd_get_parent (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 304: GetWindow — STUB: unimplemented
  (func $handle_GetWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 305: IsWindow — STUB: unimplemented
  (func $handle_IsWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; GetClassInfoA(hInstance, lpClassName, lpWndClass) — 3 args stdcall, return FALSE
  (func $handle_GetClassInfoA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 306: GetClassInfoW(hInstance, lpClassName, lpWndClass) — 3 args stdcall, return FALSE
  (func $handle_GetClassInfoW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 307: SetWindowLongW — STUB: unimplemented, return 0 (previous value)
  ;; SetWindowLongW — same as A for non-string indices
  (func $handle_SetWindowLongW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_SetWindowLongA (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
  )

  ;; 308: GetWindowLongW — STUB: unimplemented, return 0
  ;; GetWindowLongW — same as A for non-string indices
  (func $handle_GetWindowLongW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_GetWindowLongA (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
  )

  ;; 309: InitCommonControlsEx — return 1 (success) — STUB: unimplemented
  (func $handle_InitCommonControlsEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; InitCommonControlsEx(lpInitCtrls) → BOOL. 1 arg stdcall. Return TRUE
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 310: OleInitialize(pvReserved) — 1 arg stdcall, return S_OK
  (func $handle_OleInitialize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 311: CoTaskMemFree(pv) — 1 arg stdcall, free via heap_free
  (func $handle_CoTaskMemFree (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg0)
      (then (call $heap_free (local.get $arg0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 312: SaveDC — STUB: unimplemented
  (func $handle_SaveDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 313: RestoreDC — STUB: unimplemented
  (func $handle_RestoreDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
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

  ;; 315: CreateFontIndirectW — return fake font handle — STUB: unimplemented
  (func $handle_CreateFontIndirectW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 316: SetStretchBltMode — STUB: unimplemented
  (func $handle_SetStretchBltMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 317: GetPixel(hdc, x, y) → COLORREF
  (func $handle_GetPixel (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_get_pixel (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; 318: SetPixel(hdc, x, y, color) → prev color
  (func $handle_SetPixel (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_set_pixel (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; stdcall, 4 args
  )

  ;; 319: SetROP2(hdc, rop2) → previous ROP2 mode
  (func $handle_SetROP2 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 13))  ;; R2_COPYPEN (default)
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 320: lstrlenW — STUB: unimplemented
  (func $handle_lstrlenW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; lstrlenW(lpString) → length in WCHARs. 1 arg stdcall
    (local $ptr i32) (local $len i32)
    (if (i32.eqz (local.get $arg0))
      (then (global.set $eax (i32.const 0))
             (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (local.set $ptr (call $g2w (local.get $arg0)))
    (local.set $len (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.eqz (i32.load16_u (i32.add (local.get $ptr) (i32.shl (local.get $len) (i32.const 1))))))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (br_if $done (i32.gt_u (local.get $len) (i32.const 65535)))
      (br $scan)))
    (global.set $eax (local.get $len))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 321: lstrcpyW
  (func $handle_lstrcpyW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $guest_wcscpy (local.get $arg0) (local.get $arg1))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 322: lstrcmpW — STUB: unimplemented
  (func $handle_lstrcmpW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 323: lstrcmpiW — STUB: unimplemented
  (func $handle_lstrcmpiW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 324: CharNextW — advance by one wide char
  (func $handle_CharNextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.add (local.get $arg0) (i32.const 2)))
    (if (i32.eqz (call $gl16 (local.get $arg0)))
      (then (global.set $eax (local.get $arg0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 325: wsprintfW — wide sprintf, return 0 chars written (cdecl, caller cleans up)
  (func $handle_wsprintfW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
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

  ;; 329: TlsFree(index) — return TRUE
  (func $handle_TlsFree (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 330: InitializeCriticalSection(ptr) — no-op (single-threaded) — STUB: unimplemented
  (func $handle_InitializeCriticalSection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 331: EnterCriticalSection(ptr) — no-op — STUB: unimplemented
  (func $handle_EnterCriticalSection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 332: LeaveCriticalSection(ptr) — no-op — STUB: unimplemented
  (func $handle_LeaveCriticalSection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 333: DeleteCriticalSection(ptr) — no-op — STUB: unimplemented
  (func $handle_DeleteCriticalSection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 334: GetCurrentThread — 0 args, return pseudo-handle 0xFFFFFFFE (-2)
  (func $handle_GetCurrentThread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0xFFFFFFFE))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 335: GetProcessHeap — return fake heap handle — STUB: unimplemented
  (func $handle_GetProcessHeap (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x00BEEF00))  ;; fake heap handle (HeapAlloc ignores it)
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; 336: SetStdHandle(nStdHandle, hHandle) — no-op, return 1 — STUB: unimplemented
  (func $handle_SetStdHandle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 337: FlushFileBuffers — return 1 — STUB: unimplemented
  (func $handle_FlushFileBuffers (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; FlushFileBuffers(hFile) — 1 arg, return TRUE (no-op for virtual FS)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 338: IsValidCodePage — return 1 (valid) — STUB: unimplemented
  (func $handle_IsValidCodePage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
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

  ;; 343: IsBadReadPtr — return 0 (valid) — STUB: unimplemented
  (func $handle_IsBadReadPtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 344: IsBadWritePtr — return 0 (valid) — STUB: unimplemented
  ;; IsBadWritePtr(lp, ucb) — return 0 (memory is always valid in our flat address space)
  (func $handle_IsBadWritePtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))  ;; 0 = pointer is valid
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 345: SetUnhandledExceptionFilter(lpFilter) — store filter, return previous (0)
  (func $handle_SetUnhandledExceptionFilter (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 346: IsDebuggerPresent — return 0 — STUB: unimplemented
  (func $handle_IsDebuggerPresent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 347: lstrcpynW — copy up to n wide chars
  (func $handle_lstrcpynW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $guest_wcsncpy (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 348: FindFirstFileW — STUB: unimplemented
  (func $handle_FindFirstFileW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; FindFirstFileW(lpFileName, lpFindFileData) — 2 args
    (global.set $eax (call $host_fs_find_first_file
      (call $g2w (local.get $arg0)) (local.get $arg1) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 349: GetFileAttributesW — STUB: unimplemented
  (func $handle_GetFileAttributesW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetFileAttributesW(lpFileName) — 1 arg
    (global.set $eax (call $host_fs_get_file_attributes
      (call $g2w (local.get $arg0)) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 350: GetShortPathNameW — STUB: unimplemented
  (func $handle_GetShortPathNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetShortPathNameW(lpszLongPath, lpszShortPath, cchBuffer) — 3 args
    (global.set $eax (call $host_fs_get_short_path_name
      (call $g2w (local.get $arg0)) (local.get $arg1) (local.get $arg2) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 351: CreateDirectoryW — STUB: unimplemented
  (func $handle_CreateDirectoryW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CreateDirectoryW(lpPathName, lpSecurityAttributes) — 2 args
    (global.set $eax (call $host_fs_create_directory
      (call $g2w (local.get $arg0)) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 352: IsDBCSLeadByte(ch) — return FALSE (no DBCS in Western locale)
  (func $handle_IsDBCSLeadByte (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 353: GetTempPathW — STUB: unimplemented
  (func $handle_GetTempPathW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetTempPathW(nBufferLength, lpBuffer) — 2 args
    (global.set $eax (call $host_fs_get_temp_path
      (local.get $arg0) (local.get $arg1) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 354: GetTempFileNameW — STUB: unimplemented
  (func $handle_GetTempFileNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetTempFileNameW(lpPathName, lpPrefixString, uUnique, lpTempFileName) — 4 args
    (global.set $eax (call $host_fs_get_temp_file_name
      (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (local.get $arg2) (local.get $arg3) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 355: lstrcatW(dst, src) — concatenate wide strings, return dst
  (func $handle_lstrcatW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32) (local $src i32)
    ;; Find end of dst (wide NUL = 0x0000)
    (local.set $dst (local.get $arg0))
    (block $end (loop $scan
      (br_if $end (i32.eqz (call $gl16 (local.get $dst))))
      (local.set $dst (i32.add (local.get $dst) (i32.const 2)))
      (br $scan)))
    ;; Copy src to end of dst (including NUL)
    (local.set $src (local.get $arg1))
    (block $done (loop $copy
      (call $gs16 (local.get $dst) (call $gl16 (local.get $src)))
      (br_if $done (i32.eqz (call $gl16 (local.get $src))))
      (local.set $dst (i32.add (local.get $dst) (i32.const 2)))
      (local.set $src (i32.add (local.get $src) (i32.const 2)))
      (br $copy)))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 356: GlobalHandle — STUB: unimplemented
  (func $handle_GlobalHandle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 357: CreatePatternBrush(hBitmap) — 1 arg stdcall
  (func $handle_CreatePatternBrush (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_create_solid_brush (i32.const 0x00C0C0C0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 358: GetPaletteEntries — STUB: unimplemented
  (func $handle_GetPaletteEntries (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 359: SelectPalette — STUB: unimplemented
  (func $handle_SelectPalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 360: RealizePalette — STUB: unimplemented
  (func $handle_RealizePalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 361: CreateRectRgnIndirect — STUB: unimplemented
  (func $handle_CreateRectRgnIndirect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 362: GetObjectW — STUB: unimplemented
  (func $handle_GetObjectW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 363: SetTextAlign — STUB: unimplemented
  (func $handle_SetTextAlign (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 364: ExtTextOutW — STUB: unimplemented
  (func $handle_ExtTextOutW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 365: PlayMetaFile — STUB: unimplemented
  (func $handle_PlayMetaFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 366: CreatePalette — STUB: unimplemented
  (func $handle_CreatePalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 367: GetNearestColor — STUB: unimplemented
  (func $handle_GetNearestColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 368: StretchDIBits — STUB: unimplemented
  (func $handle_StretchDIBits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 369: OffsetRgn — STUB: unimplemented
  (func $handle_OffsetRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 370: UnrealizeObject — STUB: unimplemented
  (func $handle_UnrealizeObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 371: SetBrushOrgEx(hdc, x, y, lppt) — stub, set prev origin to (0,0)
  (func $handle_SetBrushOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    ;; If lppt is non-null, store previous origin (0,0)
    (if (local.get $arg3)
      (then
        (local.set $wa (call $g2w (local.get $arg3)))
        (i32.store (local.get $wa) (i32.const 0))
        (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0))
      )
    )
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; stdcall, 4 args
  )

  ;; 372: CreateDCW — STUB: unimplemented
  (func $handle_CreateDCW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 373: PtVisible(hdc, x, y) → TRUE (point is in clipping region)
  (func $handle_PtVisible (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))  ;; TRUE
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; 374: RectVisible — STUB: unimplemented
  (func $handle_RectVisible (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 375: TextOutW — STUB: unimplemented
  (func $handle_TextOutW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 376: Escape — STUB: unimplemented
  (func $handle_Escape (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 377: EnumFontFamiliesExW — STUB: unimplemented
  (func $handle_EnumFontFamiliesExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 378: EnumFontFamiliesW — STUB: unimplemented
  (func $handle_EnumFontFamiliesW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 379: CallNextHookEx — STUB: unimplemented
  (func $handle_CallNextHookEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 380: UnhookWindowsHookEx — STUB: unimplemented
  (func $handle_UnhookWindowsHookEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 381: SetWindowsHookExW — return fake handle, 4 args stdcall
  (func $handle_SetWindowsHookExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0xBEEF))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; SetWindowsHookExA — return fake handle, 4 args stdcall
  (func $handle_SetWindowsHookExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0xBEEF))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 382: RedrawWindow — STUB: unimplemented
  (func $handle_RedrawWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 383: ValidateRect — STUB: unimplemented
  (func $handle_ValidateRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 384: GetWindowDC — STUB: unimplemented
  (func $handle_GetWindowDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetWindowDC(hwnd) → HDC. Like GetDC but includes non-client area. 1 arg stdcall
    (global.set $eax (i32.add (local.get $arg0) (i32.const 0x40000)))  ;; hdc = hwnd + 0x40000
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 385: GrayStringW — STUB: unimplemented
  (func $handle_GrayStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 386: DrawTextW
  (func $handle_DrawTextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_draw_text
      (local.get $arg0)
      (call $g2w (local.get $arg1))
      (local.get $arg2)
      (call $g2w (local.get $arg3))
      (local.get $arg4)
      (i32.const 1) ;; isWide = 1
    ))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; stdcall, 5 args
  )

  ;; 387: TabbedTextOutW — STUB: unimplemented
  (func $handle_TabbedTextOutW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 388: DestroyIcon(hIcon) — 1 arg stdcall, return TRUE
  (func $handle_DestroyIcon (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 389: SystemParametersInfoW — return TRUE, 4 args stdcall
  (func $handle_SystemParametersInfoW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; SystemParametersInfoA — return TRUE, 4 args stdcall
  (func $handle_SystemParametersInfoA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 390: IsWindowVisible — STUB: unimplemented
  (func $handle_IsWindowVisible (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 391: InflateRect — STUB: unimplemented
  (func $handle_InflateRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 392: LoadBitmapW — STUB: unimplemented
  (func $handle_LoadBitmapW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 393: wvsprintfW — STUB: unimplemented
  (func $handle_wvsprintfW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 394: DrawFocusRect — STUB: unimplemented
  (func $handle_DrawFocusRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 395: PtInRect(lprc, pt.x, pt.y) -> BOOL — 3 args stdcall
  (func $handle_PtInRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $rect_w i32)
    (local.set $rect_w (call $g2w (local.get $arg0)))
    ;; Check: left <= x < right && top <= y < bottom
    (if (i32.and
      (i32.and
        (i32.le_s (i32.load (local.get $rect_w)) (local.get $arg1))                          ;; left <= x
        (i32.lt_s (local.get $arg1) (i32.load (i32.add (local.get $rect_w) (i32.const 8))))   ;; x < right
      )
      (i32.and
        (i32.le_s (i32.load (i32.add (local.get $rect_w) (i32.const 4))) (local.get $arg2))   ;; top <= y
        (i32.lt_s (local.get $arg2) (i32.load (i32.add (local.get $rect_w) (i32.const 12))))  ;; y < bottom
      )
    )
    (then (global.set $eax (i32.const 1)))
    (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) ;; stdcall 3 params + ret
  )

  ;; 396: WinHelpW — return 1, 4 args stdcall
  (func $handle_WinHelpW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 397: GetCapture — STUB: unimplemented
  (func $handle_GetCapture (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 398: RegisterClipboardFormatW — STUB: unimplemented
  (func $handle_RegisterClipboardFormatW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 399: CopyRect — STUB: unimplemented
  (func $handle_CopyRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 400: IntersectRect(lprcDst, lprcSrc1, lprcSrc2) → BOOL
  (func $handle_IntersectRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32) (local $s1 i32) (local $s2 i32)
    (local $left i32) (local $top i32) (local $right i32) (local $bottom i32)
    (local.set $dst (call $g2w (local.get $arg0)))
    (local.set $s1 (call $g2w (local.get $arg1)))
    (local.set $s2 (call $g2w (local.get $arg2)))
    ;; left = max(s1.left, s2.left)
    (local.set $left (select
      (i32.load (local.get $s1)) (i32.load (local.get $s2))
      (i32.gt_s (i32.load (local.get $s1)) (i32.load (local.get $s2)))))
    ;; top = max(s1.top, s2.top)
    (local.set $top (select
      (i32.load (i32.add (local.get $s1) (i32.const 4))) (i32.load (i32.add (local.get $s2) (i32.const 4)))
      (i32.gt_s (i32.load (i32.add (local.get $s1) (i32.const 4))) (i32.load (i32.add (local.get $s2) (i32.const 4))))))
    ;; right = min(s1.right, s2.right)
    (local.set $right (select
      (i32.load (i32.add (local.get $s1) (i32.const 8))) (i32.load (i32.add (local.get $s2) (i32.const 8)))
      (i32.lt_s (i32.load (i32.add (local.get $s1) (i32.const 8))) (i32.load (i32.add (local.get $s2) (i32.const 8))))))
    ;; bottom = min(s1.bottom, s2.bottom)
    (local.set $bottom (select
      (i32.load (i32.add (local.get $s1) (i32.const 12))) (i32.load (i32.add (local.get $s2) (i32.const 12)))
      (i32.lt_s (i32.load (i32.add (local.get $s1) (i32.const 12))) (i32.load (i32.add (local.get $s2) (i32.const 12))))))
    ;; Check if intersection is empty
    (if (i32.or (i32.ge_s (local.get $left) (local.get $right))
                (i32.ge_s (local.get $top) (local.get $bottom)))
      (then
        ;; Empty: zero out dst, return FALSE
        (i32.store (local.get $dst) (i32.const 0))
        (i32.store (i32.add (local.get $dst) (i32.const 4)) (i32.const 0))
        (i32.store (i32.add (local.get $dst) (i32.const 8)) (i32.const 0))
        (i32.store (i32.add (local.get $dst) (i32.const 12)) (i32.const 0))
        (global.set $eax (i32.const 0))
      )
      (else
        (i32.store (local.get $dst) (local.get $left))
        (i32.store (i32.add (local.get $dst) (i32.const 4)) (local.get $top))
        (i32.store (i32.add (local.get $dst) (i32.const 8)) (local.get $right))
        (i32.store (i32.add (local.get $dst) (i32.const 12)) (local.get $bottom))
        (global.set $eax (i32.const 1))
      )
    )
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; 401: UnionRect — STUB: unimplemented
  (func $handle_UnionRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 402: WindowFromPoint — STUB: unimplemented
  (func $handle_WindowFromPoint (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 403: IsRectEmpty — STUB: unimplemented
  (func $handle_IsRectEmpty (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 404: EqualRect — STUB: unimplemented
  (func $handle_EqualRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 405: ClientToScreen — STUB: unimplemented
  (func $handle_ClientToScreen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 406: SetActiveWindow — STUB: unimplemented
  (func $handle_SetActiveWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 407: RemoveMenu — STUB: unimplemented
  (func $handle_RemoveMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 408: SetFilePointer — STUB: unimplemented
  (func $handle_SetFilePointer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetFilePointer(hFile, lDistanceToMove, lpDistanceToMoveHigh, dwMoveMethod) — 4 args
    (global.set $eax (call $host_fs_set_file_pointer
      (local.get $arg0) (local.get $arg1) (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 409: ResumeThread — STUB: unimplemented
  (func $handle_ResumeThread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 410: SetLastError(dwErrCode) — ignore, just clean up stack
  (func $handle_SetLastError (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 411: FindNextFileW — STUB: unimplemented
  (func $handle_FindNextFileW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; FindNextFileW(hFindFile, lpFindFileData) — 2 args
    (global.set $eax (call $host_fs_find_next_file
      (local.get $arg0) (local.get $arg1) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 412: RaiseException — STUB: unimplemented
  (func $handle_RaiseException (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 413: GetUserDefaultLCID — STUB: unimplemented
  (func $handle_GetUserDefaultLCID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return 0x0409 = English (US)
    (global.set $eax (i32.const 0x0409))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; 414: FileTimeToSystemTime — STUB: unimplemented
  (func $handle_FileTimeToSystemTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 415: FileTimeToLocalFileTime — STUB: unimplemented
  (func $handle_FileTimeToLocalFileTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 416: GetCurrentDirectoryW — STUB: unimplemented
  (func $handle_GetCurrentDirectoryW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetCurrentDirectoryW(nBufferLength, lpBuffer) — 2 args
    (global.set $eax (call $host_fs_get_current_directory
      (local.get $arg0) (local.get $arg1) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 417: SetFileAttributesW — STUB: unimplemented
  (func $handle_SetFileAttributesW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetFileAttributesW(lpFileName, dwFileAttributes) — 2 args
    (global.set $eax (call $host_fs_set_file_attributes
      (call $g2w (local.get $arg0)) (local.get $arg1) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 418: GetFullPathNameW — STUB: unimplemented
  (func $handle_GetFullPathNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetFullPathNameW(lpFileName, nBufferLength, lpBuffer, lpFilePart) — 4 args
    (global.set $eax (call $host_fs_get_full_path_name
      (call $g2w (local.get $arg0)) (local.get $arg1) (local.get $arg2) (local.get $arg3) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 419: DeleteFileW — STUB: unimplemented
  (func $handle_DeleteFileW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; DeleteFileW(lpFileName) — 1 arg
    (global.set $eax (call $host_fs_delete_file
      (call $g2w (local.get $arg0)) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 420: MoveFileW — STUB: unimplemented
  (func $handle_MoveFileW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; MoveFileW(lpExistingFileName, lpNewFileName) — 2 args
    (global.set $eax (call $host_fs_move_file
      (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 421: SetEndOfFile — STUB: unimplemented
  (func $handle_SetEndOfFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetEndOfFile(hFile) — 1 arg, return TRUE
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 422: DuplicateHandle — STUB: unimplemented
  (func $handle_DuplicateHandle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 423: LockFile — STUB: unimplemented
  (func $handle_LockFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 424: UnlockFile — STUB: unimplemented
  (func $handle_UnlockFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 425: ReadFile — STUB: unimplemented
  (func $handle_ReadFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; ReadFile(hFile, lpBuffer, nToRead, lpBytesRead, lpOverlapped) — 5 args
    (global.set $eax (call $host_fs_read_file
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 426: CreateFileW — STUB: unimplemented
  (func $handle_CreateFileW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CreateFileW — 7 args, same as CreateFileA but wide
    (local $wa_esp_w i32) (local $creation_w i32) (local $flags_w i32)
    (local.set $wa_esp_w (call $g2w (global.get $esp)))
    (local.set $creation_w (local.get $arg4))
    (local.set $flags_w (i32.load (i32.add (local.get $wa_esp_w) (i32.const 24))))
    (global.set $eax (call $host_fs_create_file
      (call $g2w (local.get $arg0)) (local.get $arg1)
      (local.get $creation_w) (local.get $flags_w) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
  )

  ;; 427: SetFileTime — STUB: unimplemented
  (func $handle_SetFileTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 428: LocalFileTimeToFileTime — STUB: unimplemented
  (func $handle_LocalFileTimeToFileTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 429: SystemTimeToFileTime — STUB: unimplemented
  (func $handle_SystemTimeToFileTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 430: RegOpenKeyW — STUB: unimplemented
  (func $handle_RegOpenKeyW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; RegOpenKeyW(hKey, lpSubKey, phkResult) — 3 args stdcall
    (local $hResult i32)
    (local.set $hResult (call $host_reg_open_key
      (local.get $arg0) (call $g2w (local.get $arg1)) (i32.const 1)))
    (if (local.get $hResult)
      (then (call $gs32 (local.get $arg2) (local.get $hResult))
             (global.set $eax (i32.const 0)))
      (else (global.set $eax (i32.const 2))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 431: RegEnumKeyW — STUB: unimplemented
  (func $handle_RegEnumKeyW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 432: RegSetValueW — 5 args stdcall, return ERROR_SUCCESS (registry writes are no-op)
  (func $handle_RegSetValueW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; RegSetValueA — 5 args stdcall, return ERROR_SUCCESS (registry writes are no-op)
  (func $handle_RegSetValueA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; RegQueryValueA(hKey, lpSubKey, lpData, lpcbData) — 4 args stdcall
  (func $handle_RegQueryValueA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 2))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 433: RegCreateKeyW — STUB: unimplemented
  (func $handle_RegCreateKeyW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; RegCreateKeyW(hKey, lpSubKey, phkResult) — 3 args stdcall
    (global.set $eax (call $host_reg_create_key
      (local.get $arg0) (call $g2w (local.get $arg1)) (local.get $arg2) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 434: RegSetValueExW(hKey, lpValueName, Reserved, dwType, lpData, cbData) — 6 args stdcall
  (func $handle_RegSetValueExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa_esp i32) (local $cbData i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $cbData (i32.load (i32.add (local.get $wa_esp) (i32.const 24))))
    (global.set $eax (call $host_reg_set_value
      (local.get $arg0)
      (if (result i32) (local.get $arg1)
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (local.get $arg3)
      (local.get $arg4)
      (local.get $cbData)
      (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 435: RegCreateKeyExW — STUB: unimplemented
  (func $handle_RegCreateKeyExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; RegCreateKeyExW(hKey, lpSubKey, Reserved, lpClass, dwOptions, samDesired, lpSecurityAttrs, phkResult, lpdwDisposition)
    ;; 9 args stdcall
    (local $wa_esp i32) (local $phkResult i32) (local $lpdwDisposition i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $phkResult (i32.load (i32.add (local.get $wa_esp) (i32.const 32))))
    (local.set $lpdwDisposition (i32.load (i32.add (local.get $wa_esp) (i32.const 36))))
    (global.set $eax (call $host_reg_create_key
      (local.get $arg0) (call $g2w (local.get $arg1)) (local.get $phkResult) (i32.const 1)))
    ;; Set disposition = REG_CREATED_NEW_KEY (1) if requested
    (if (i32.ne (local.get $lpdwDisposition) (i32.const 0))
      (then (call $gs32 (local.get $lpdwDisposition) (i32.const 1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 40)))
  )

  ;; RegCreateKeyExA — same as ExW, 9 args stdcall
  (func $handle_RegCreateKeyExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa_esp i32) (local $phkResult i32) (local $lpdwDisposition i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $phkResult (i32.load (i32.add (local.get $wa_esp) (i32.const 32))))
    (local.set $lpdwDisposition (i32.load (i32.add (local.get $wa_esp) (i32.const 36))))
    (global.set $eax (call $host_reg_create_key
      (local.get $arg0) (call $g2w (local.get $arg1)) (local.get $phkResult) (i32.const 0)))
    (if (i32.ne (local.get $lpdwDisposition) (i32.const 0))
      (then (call $gs32 (local.get $lpdwDisposition) (i32.const 1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 40)))
  )

  ;; 436: RegQueryValueExW(hKey, lpValueName, lpReserved, lpType, lpData, lpcbData) — 6 args stdcall
  (func $handle_RegQueryValueExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa_esp i32) (local $lpData i32) (local $lpcbData i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $lpData (local.get $arg4))
    (local.set $lpcbData (i32.load (i32.add (local.get $wa_esp) (i32.const 24))))
    (global.set $eax (call $host_reg_query_value
      (local.get $arg0)
      (if (result i32) (local.get $arg1)
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (local.get $arg3)
      (local.get $lpData)
      (local.get $lpcbData)
      (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 437: GetShortPathNameA(lpszLong, lpszShort, cchBuffer) — 3 args stdcall
  ;; Copy long path to short path buffer, return length
  (func $handle_GetShortPathNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $len i32)
    (local.set $len (call $strlen (call $g2w (local.get $arg0))))
    (if (i32.and (local.get $arg1) (i32.gt_u (local.get $arg2) (local.get $len)))
      (then (call $memcpy (call $g2w (local.get $arg1)) (call $g2w (local.get $arg0)) (i32.add (local.get $len) (i32.const 1)))))
    (global.set $eax (local.get $len))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 438: FillRgn — STUB: unimplemented
  (func $handle_FillRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 439: GetDIBColorTable — STUB: unimplemented
  (func $handle_GetDIBColorTable (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 440: SetDIBColorTable — STUB: unimplemented
  (func $handle_SetDIBColorTable (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 441: ResizePalette — STUB: unimplemented
  (func $handle_ResizePalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 442: GetNearestPaletteIndex — STUB: unimplemented
  (func $handle_GetNearestPaletteIndex (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 443: SetPaletteEntries — STUB: unimplemented
  (func $handle_SetPaletteEntries (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 444: SetDIBits — STUB: unimplemented
  (func $handle_SetDIBits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetDIBits(hdc, hBitmap, uStartScan, cScanLines, lpBits, lpBMI, fuColorUse) → numScans
    ;; 7 args stdcall. arg0=hdc, arg1=hBitmap, arg2=uStartScan, arg3=cScanLines, arg4=lpBits
    ;; [esp+24]=lpBMI, [esp+28]=fuColorUse
    (local $wa_esp i32) (local $lpBMI i32) (local $fuColorUse i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $lpBMI (i32.load (i32.add (local.get $wa_esp) (i32.const 24))))
    (local.set $fuColorUse (i32.load (i32.add (local.get $wa_esp) (i32.const 28))))
    (global.set $eax (call $host_gdi_set_dib_bits
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)
      (call $g2w (local.get $arg4))
      (call $g2w (local.get $lpBMI))
      (local.get $fuColorUse)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))  ;; stdcall, 7 args
  )

  ;; 719: SetDIBitsToDevice(hdc, xDest, yDest, w, h, xSrc, ySrc, StartScan, cLines, lpBits, lpBMI, ColorUse)
  ;; 12 args stdcall. arg0-arg4 = hdc, xDest, yDest, w, h; rest on stack
  (func $handle_SetDIBitsToDevice (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa_esp i32) (local $xSrc i32) (local $ySrc i32) (local $startScan i32) (local $cLines i32)
    (local $lpBits i32) (local $lpBMI i32) (local $colorUse i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $xSrc (i32.load (i32.add (local.get $wa_esp) (i32.const 24))))
    (local.set $ySrc (i32.load (i32.add (local.get $wa_esp) (i32.const 28))))
    (local.set $startScan (i32.load (i32.add (local.get $wa_esp) (i32.const 32))))
    (local.set $cLines (i32.load (i32.add (local.get $wa_esp) (i32.const 36))))
    (local.set $lpBits (i32.load (i32.add (local.get $wa_esp) (i32.const 40))))
    (local.set $lpBMI (i32.load (i32.add (local.get $wa_esp) (i32.const 44))))
    (local.set $colorUse (i32.load (i32.add (local.get $wa_esp) (i32.const 48))))
    (global.set $eax (call $host_gdi_set_dib_to_device
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
      (local.get $xSrc) (local.get $ySrc) (local.get $startScan) (local.get $cLines)
      (call $g2w (local.get $lpBits)) (call $g2w (local.get $lpBMI)) (local.get $colorUse)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 52)))  ;; stdcall, 12 args
  )

  ;; 445: GetTextExtentPointW — STUB: unimplemented
  (func $handle_GetTextExtentPointW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 446: CreateICW — STUB: unimplemented
  (func $handle_CreateICW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CreateICW(lpszDriver, lpszDevice, lpszOutput, lpdvmInit) → HDC
    ;; 4 args stdcall. Returns an information context (IC) handle — use same as CreateCompatibleDC(0)
    (global.set $eax (call $host_gdi_create_compat_dc (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; stdcall, 4 args
  )

  ;; 718: CreateICA(lpszDriver, lpszDevice, lpszOutput, lpdvmInit) → HDC
  (func $handle_CreateICA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Same as CreateICW — returns an information context handle
    (global.set $eax (call $host_gdi_create_compat_dc (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; stdcall, 4 args
  )

  ;; 447: CreateDIBSection — STUB: unimplemented
  (func $handle_CreateDIBSection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 448: GetDIBits — STUB: unimplemented
  (func $handle_GetDIBits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 449: CreateDIBitmap — STUB: unimplemented
  (func $handle_CreateDIBitmap (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 450: StretchBlt(hdcDest, xDest, yDest, wDest, hDest, hdcSrc, xSrc, ySrc, wSrc, hSrc, dwRop)
  (func $handle_StretchBlt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_stretch_blt
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))   ;; hdcSrc
      (call $gl32 (i32.add (global.get $esp) (i32.const 28)))   ;; xSrc
      (call $gl32 (i32.add (global.get $esp) (i32.const 32)))   ;; ySrc
      (call $gl32 (i32.add (global.get $esp) (i32.const 36)))   ;; wSrc
      (call $gl32 (i32.add (global.get $esp) (i32.const 40)))   ;; hSrc
      (call $gl32 (i32.add (global.get $esp) (i32.const 44)))   ;; dwRop
    ))
    (global.set $esp (i32.add (global.get $esp) (i32.const 48)))  ;; stdcall, 11 args
  )

  ;; 451: Polygon — STUB: unimplemented
  (func $handle_Polygon (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 452: RoundRect — STUB: unimplemented
  (func $handle_RoundRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 453: ExtFloodFill — STUB: unimplemented
  (func $handle_ExtFloodFill (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 454: CreatePolygonRgn — STUB: unimplemented
  (func $handle_CreatePolygonRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 455: PolyBezier — STUB: unimplemented
  (func $handle_PolyBezier (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 456: Polyline — STUB: unimplemented
  (func $handle_Polyline (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 457: CreateHalftonePalette — STUB: unimplemented
  (func $handle_CreateHalftonePalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 458: EnableScrollBar — STUB: unimplemented
  (func $handle_EnableScrollBar (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 459: GetCaretPos — STUB: unimplemented
  (func $handle_GetCaretPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 460: GetUpdateRect — STUB: unimplemented
  (func $handle_GetUpdateRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 461: IsMenu — STUB: unimplemented
  (func $handle_IsMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 462: WriteClassStg — STUB: unimplemented
  (func $handle_WriteClassStg (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 463: WriteFmtUserTypeStg — STUB: unimplemented
  (func $handle_WriteFmtUserTypeStg (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 464: StringFromCLSID(rclsid, lplpsz) — 2 args stdcall
  ;; Allocate wide string "{00000000-0000-0000-0000-000000000000}" and write GUID
  (func $handle_StringFromCLSID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32) (local $dst i32) (local $src i32)
    (local $d1 i32) (local $d2 i32) (local $d3 i32) (local $i i32) (local $b i32) (local $nib i32)
    ;; Allocate 78 bytes (39 wchars) from heap
    (local.set $buf (call $heap_alloc (i32.const 78)))
    (local.set $dst (call $g2w (local.get $buf)))
    (local.set $src (call $g2w (local.get $arg0)))
    ;; Write '{' then hex digits with dashes then '}'
    ;; Simplified: write "{00000000-0000-0000-0000-000000000000}\0"
    ;; Read actual GUID bytes and format
    (i32.store16 (local.get $dst) (i32.const 0x7B)) ;; '{'
    (local.set $dst (i32.add (local.get $dst) (i32.const 2)))
    ;; Data1: 4 bytes, big-endian hex
    (local.set $d1 (i32.load (local.get $src)))
    (local.set $i (i32.const 28))
    (block $hd1 (loop $ld1
      (br_if $hd1 (i32.lt_s (local.get $i) (i32.const 0)))
      (local.set $nib (i32.and (i32.shr_u (local.get $d1) (local.get $i)) (i32.const 0xF)))
      (i32.store16 (local.get $dst) (i32.add (local.get $nib) (select (i32.const 48) (i32.const 55) (i32.lt_u (local.get $nib) (i32.const 10)))))
      (local.set $dst (i32.add (local.get $dst) (i32.const 2)))
      (local.set $i (i32.sub (local.get $i) (i32.const 4)))
      (br $ld1)))
    (i32.store16 (local.get $dst) (i32.const 0x2D)) ;; '-'
    (local.set $dst (i32.add (local.get $dst) (i32.const 2)))
    ;; Data2: 2 bytes
    (local.set $d2 (i32.load16_u (i32.add (local.get $src) (i32.const 4))))
    (local.set $i (i32.const 12))
    (block $hd2 (loop $ld2
      (br_if $hd2 (i32.lt_s (local.get $i) (i32.const 0)))
      (local.set $nib (i32.and (i32.shr_u (local.get $d2) (local.get $i)) (i32.const 0xF)))
      (i32.store16 (local.get $dst) (i32.add (local.get $nib) (select (i32.const 48) (i32.const 55) (i32.lt_u (local.get $nib) (i32.const 10)))))
      (local.set $dst (i32.add (local.get $dst) (i32.const 2)))
      (local.set $i (i32.sub (local.get $i) (i32.const 4)))
      (br $ld2)))
    (i32.store16 (local.get $dst) (i32.const 0x2D))
    (local.set $dst (i32.add (local.get $dst) (i32.const 2)))
    ;; Data3: 2 bytes
    (local.set $d3 (i32.load16_u (i32.add (local.get $src) (i32.const 6))))
    (local.set $i (i32.const 12))
    (block $hd3 (loop $ld3
      (br_if $hd3 (i32.lt_s (local.get $i) (i32.const 0)))
      (local.set $nib (i32.and (i32.shr_u (local.get $d3) (local.get $i)) (i32.const 0xF)))
      (i32.store16 (local.get $dst) (i32.add (local.get $nib) (select (i32.const 48) (i32.const 55) (i32.lt_u (local.get $nib) (i32.const 10)))))
      (local.set $dst (i32.add (local.get $dst) (i32.const 2)))
      (local.set $i (i32.sub (local.get $i) (i32.const 4)))
      (br $ld3)))
    (i32.store16 (local.get $dst) (i32.const 0x2D))
    (local.set $dst (i32.add (local.get $dst) (i32.const 2)))
    ;; Data4[0..1]: 2 bytes
    (local.set $i (i32.const 0))
    (block $hd4a (loop $ld4a
      (br_if $hd4a (i32.ge_u (local.get $i) (i32.const 2)))
      (local.set $b (i32.load8_u (i32.add (local.get $src) (i32.add (i32.const 8) (local.get $i)))))
      (local.set $nib (i32.shr_u (local.get $b) (i32.const 4)))
      (i32.store16 (local.get $dst) (i32.add (local.get $nib) (select (i32.const 48) (i32.const 55) (i32.lt_u (local.get $nib) (i32.const 10)))))
      (local.set $dst (i32.add (local.get $dst) (i32.const 2)))
      (local.set $nib (i32.and (local.get $b) (i32.const 0xF)))
      (i32.store16 (local.get $dst) (i32.add (local.get $nib) (select (i32.const 48) (i32.const 55) (i32.lt_u (local.get $nib) (i32.const 10)))))
      (local.set $dst (i32.add (local.get $dst) (i32.const 2)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $ld4a)))
    (i32.store16 (local.get $dst) (i32.const 0x2D))
    (local.set $dst (i32.add (local.get $dst) (i32.const 2)))
    ;; Data4[2..7]: 6 bytes
    (local.set $i (i32.const 2))
    (block $hd4b (loop $ld4b
      (br_if $hd4b (i32.ge_u (local.get $i) (i32.const 8)))
      (local.set $b (i32.load8_u (i32.add (local.get $src) (i32.add (i32.const 8) (local.get $i)))))
      (local.set $nib (i32.shr_u (local.get $b) (i32.const 4)))
      (i32.store16 (local.get $dst) (i32.add (local.get $nib) (select (i32.const 48) (i32.const 55) (i32.lt_u (local.get $nib) (i32.const 10)))))
      (local.set $dst (i32.add (local.get $dst) (i32.const 2)))
      (local.set $nib (i32.and (local.get $b) (i32.const 0xF)))
      (i32.store16 (local.get $dst) (i32.add (local.get $nib) (select (i32.const 48) (i32.const 55) (i32.lt_u (local.get $nib) (i32.const 10)))))
      (local.set $dst (i32.add (local.get $dst) (i32.const 2)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $ld4b)))
    (i32.store16 (local.get $dst) (i32.const 0x7D)) ;; '}'
    (i32.store16 (i32.add (local.get $dst) (i32.const 2)) (i32.const 0)) ;; null
    ;; Write pointer to *lplpsz
    (call $gs32 (local.get $arg1) (local.get $buf))
    (global.set $eax (i32.const 0)) ;; S_OK
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 465: ExtractIconW — 3 args stdcall, return fake icon handle
  (func $handle_ExtractIconW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x0000FACE))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; ExtractIconA — 3 args stdcall, return fake icon handle
  (func $handle_ExtractIconA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x0000FACE))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 466: ShellAboutW — return 1, 4 args stdcall
  (func $handle_ShellAboutW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 467: CommandLineToArgvW — STUB: unimplemented
  (func $handle_CommandLineToArgvW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CommandLineToArgvW(lpCmdLine, pNumArgs) — parse wide string command line
    ;; Allocate: argv array (1 pointer) + wide string "app\0" (8 bytes)
    (local $buf i32)
    (local.set $buf (call $heap_alloc (i32.const 32)))
    ;; argv[0] = pointer to wide string at buf+8
    (i32.store (call $g2w (local.get $buf)) (i32.add (local.get $buf) (i32.const 8)))
    ;; Write L"app\0" at buf+8 (wide: 'a'=0x0061, 'p'=0x0070, 'p'=0x0070, '\0'=0)
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 8))) (i32.const 0x00700061))   ;; "ap"
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 12))) (i32.const 0x00000070))  ;; "p\0"
    ;; *pNumArgs = 1
    (i32.store (call $g2w (local.get $arg1)) (i32.const 1))
    (global.set $eax (local.get $buf))  ;; return pointer to argv array
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 468: IsBadCodePtr — STUB: unimplemented
  (func $handle_IsBadCodePtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 469: ExitThread(dwExitCode) — 1 arg, no return
  (func $handle_ExitThread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_exit_thread (local.get $arg0))
    (global.set $yield_reason (i32.const 2))
    (global.set $eip (i32.const 0))
    (global.set $steps (i32.const 0))
  )

  ;; 470: FindNextFileA — STUB: unimplemented
  (func $handle_FindNextFileA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; FindNextFileA(hFindFile, lpFindFileData) — 2 args
    (global.set $eax (call $host_fs_find_next_file
      (local.get $arg0) (local.get $arg1) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 471: GetEnvironmentVariableA — return 0 (not found), 3 args stdcall
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

  ;; 473: SetConsoleCtrlHandler — no-op, return success — STUB: unimplemented
  (func $handle_SetConsoleCtrlHandler (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 474: SetEnvironmentVariableW — no-op, return success — STUB: unimplemented
  (func $handle_SetEnvironmentVariableW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 475: CompareStringA — return CSTR_EQUAL (2) — STUB: unimplemented
  (func $handle_CompareStringA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 476: CompareStringW — return CSTR_EQUAL (2) — STUB: unimplemented
  (func $handle_CompareStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 477: IsValidLocale — return TRUE — STUB: unimplemented
  (func $handle_IsValidLocale (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 478: EnumSystemLocalesA — no-op, return TRUE — STUB: unimplemented
  (func $handle_EnumSystemLocalesA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 479: GetLocaleInfoW — return 0 (failure) — STUB: unimplemented
  (func $handle_GetLocaleInfoW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 480: GetTimeZoneInformation(lpTZI) — zero-fill 172-byte struct, return TIME_ZONE_ID_UNKNOWN (0)
  (func $handle_GetTimeZoneInformation (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local $i i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    ;; Zero-fill 172 bytes (43 dwords)
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (i32.const 172)))
      (i32.store (i32.add (local.get $wa) (local.get $i)) (i32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 4)))
      (br $loop)
    ))
    (global.set $eax (i32.const 0))  ;; TIME_ZONE_ID_UNKNOWN
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 481: SetEnvironmentVariableA — no-op, return success — STUB: unimplemented
  (func $handle_SetEnvironmentVariableA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 482: Beep — STUB: unimplemented
  (func $handle_Beep (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 483: GetDiskFreeSpaceA — STUB: unimplemented
  (func $handle_GetDiskFreeSpaceA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 484: GetLogicalDrives() — return bitmask of drives (bit 2 = C:)
  (func $handle_GetLogicalDrives (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x04))  ;; C: drive only
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; 485: GetFileAttributesA — STUB: unimplemented
  (func $handle_GetFileAttributesA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetFileAttributesA(lpFileName) — 1 arg
    (global.set $eax (call $host_fs_get_file_attributes
      (call $g2w (local.get $arg0)) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 486: GetCurrentDirectoryA — STUB: unimplemented
  (func $handle_GetCurrentDirectoryA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetCurrentDirectoryA(nBufferLength, lpBuffer) — 2 args
    (global.set $eax (call $host_fs_get_current_directory
      (local.get $arg0) (local.get $arg1) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 487: SetCurrentDirectoryA — STUB: unimplemented
  (func $handle_SetCurrentDirectoryA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetCurrentDirectoryA(lpPathName) — 1 arg
    (global.set $eax (call $host_fs_set_current_directory
      (call $g2w (local.get $arg0)) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 488: SetFileAttributesA — STUB: unimplemented
  (func $handle_SetFileAttributesA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetFileAttributesA(lpFileName, dwFileAttributes) — 2 args
    (global.set $eax (call $host_fs_set_file_attributes
      (call $g2w (local.get $arg0)) (local.get $arg1) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 489: GetFullPathNameA — STUB: unimplemented
  (func $handle_GetFullPathNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetFullPathNameA(lpFileName, nBufferLength, lpBuffer, lpFilePart) — 4 args
    (global.set $eax (call $host_fs_get_full_path_name
      (call $g2w (local.get $arg0)) (local.get $arg1) (local.get $arg2) (local.get $arg3) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 490: GetDriveTypeA(lpRootPathName) — return DRIVE_FIXED (3)
  (func $handle_GetDriveTypeA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 3))  ;; DRIVE_FIXED
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 491: GetCurrentProcessId — return fake PID
  (func $handle_GetCurrentProcessId (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1000))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 492: CreateDirectoryA — STUB: unimplemented
  (func $handle_CreateDirectoryA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CreateDirectoryA(lpPathName, lpSecurityAttributes) — 2 args
    (global.set $eax (call $host_fs_create_directory
      (call $g2w (local.get $arg0)) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 493: RemoveDirectoryA — STUB: unimplemented
  (func $handle_RemoveDirectoryA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; RemoveDirectoryA(lpPathName) — 1 arg
    (global.set $eax (call $host_fs_remove_directory
      (call $g2w (local.get $arg0)) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 494: SetCurrentDirectoryW — STUB: unimplemented
  (func $handle_SetCurrentDirectoryW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetCurrentDirectoryW(lpPathName) — 1 arg
    (global.set $eax (call $host_fs_set_current_directory
      (call $g2w (local.get $arg0)) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 495: RemoveDirectoryW — STUB: unimplemented
  (func $handle_RemoveDirectoryW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; RemoveDirectoryW(lpPathName) — 1 arg
    (global.set $eax (call $host_fs_remove_directory
      (call $g2w (local.get $arg0)) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 496: GetDriveTypeW — STUB: unimplemented
  (func $handle_GetDriveTypeW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 497: MoveFileA — STUB: unimplemented
  (func $handle_MoveFileA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; MoveFileA(lpExistingFileName, lpNewFileName) — 2 args
    (global.set $eax (call $host_fs_move_file
      (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 498: GetExitCodeProcess — STUB: unimplemented
  (func $handle_GetExitCodeProcess (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 499: CreateProcessA — STUB: unimplemented
  (func $handle_CreateProcessA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 500: CreateProcessW — STUB: unimplemented
  (func $handle_CreateProcessW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 501: HeapValidate — STUB: unimplemented
  (func $handle_HeapValidate (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 502: HeapCompact — STUB: unimplemented
  (func $handle_HeapCompact (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 503: HeapWalk — STUB: unimplemented
  (func $handle_HeapWalk (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 504: ReadConsoleA — STUB: unimplemented
  (func $handle_ReadConsoleA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 505: SetConsoleMode — STUB: unimplemented
  (func $handle_SetConsoleMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 506: GetConsoleMode — STUB: unimplemented
  (func $handle_GetConsoleMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 507: WriteConsoleA — STUB: unimplemented
  (func $handle_WriteConsoleA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 508: GetFileInformationByHandle — STUB: unimplemented
  (func $handle_GetFileInformationByHandle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 509: PeekNamedPipe — STUB: unimplemented
  (func $handle_PeekNamedPipe (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 510: ReadConsoleInputA — STUB: unimplemented
  (func $handle_ReadConsoleInputA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 511: PeekConsoleInputA — STUB: unimplemented
  (func $handle_PeekConsoleInputA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 512: GetNumberOfConsoleInputEvents — STUB: unimplemented
  (func $handle_GetNumberOfConsoleInputEvents (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 513: CreatePipe — STUB: unimplemented
  (func $handle_CreatePipe (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 514: GetSystemTimeAsFileTime(lpFileTime) — writes 8-byte FILETIME
  ;; Returns a fixed timestamp (~2000-01-01) since we don't have real time
  (func $handle_GetSystemTimeAsFileTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    ;; FILETIME for ~2000-01-01 00:00:00 UTC = 0x01BF53EB256D4000
    (i32.store (local.get $wa) (i32.const 0x256D4000))       ;; dwLowDateTime
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0x01BF53EB))  ;; dwHighDateTime
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 515: SetLocalTime — STUB: unimplemented
  (func $handle_SetLocalTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 516: GetSystemTime(lpSystemTime) — fills SYSTEMTIME struct
  ;; Returns fixed time 2000-01-01 00:00:00.000 (Saturday)
  (func $handle_GetSystemTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (i32.store16 (local.get $wa) (i32.const 2000))                          ;; wYear
    (i32.store16 (i32.add (local.get $wa) (i32.const 2)) (i32.const 1))     ;; wMonth
    (i32.store16 (i32.add (local.get $wa) (i32.const 4)) (i32.const 6))     ;; wDayOfWeek (Saturday)
    (i32.store16 (i32.add (local.get $wa) (i32.const 6)) (i32.const 1))     ;; wDay
    (i32.store16 (i32.add (local.get $wa) (i32.const 8)) (i32.const 0))     ;; wHour
    (i32.store16 (i32.add (local.get $wa) (i32.const 10)) (i32.const 0))    ;; wMinute
    (i32.store16 (i32.add (local.get $wa) (i32.const 12)) (i32.const 0))    ;; wSecond
    (i32.store16 (i32.add (local.get $wa) (i32.const 14)) (i32.const 0))    ;; wMilliseconds
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 517: FormatMessageW — STUB: unimplemented
  (func $handle_FormatMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 518: GetFileSize — STUB: unimplemented
  (func $handle_GetFileSize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetFileSize(hFile, lpFileSizeHigh) — 2 args
    (if (local.get $arg1) (then (call $gs32 (local.get $arg1) (i32.const 0))))
    (global.set $eax (call $host_fs_get_file_size (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 519: GetFileTime — STUB: unimplemented
  (func $handle_GetFileTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 520: GetStringTypeExW — STUB: unimplemented
  (func $handle_GetStringTypeExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 521: GetThreadLocale — STUB: unimplemented
  (func $handle_GetThreadLocale (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 522: CreateSemaphoreW — STUB: unimplemented
  (func $handle_CreateSemaphoreW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 523: ReleaseSemaphore — STUB: unimplemented
  (func $handle_ReleaseSemaphore (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 524: CreateMutexW — STUB: unimplemented
  (func $handle_CreateMutexW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 525: ReleaseMutex — STUB: unimplemented
  (func $handle_ReleaseMutex (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 526: CreateEventW(lpAttr, bManualReset, bInitialState, lpName) — 4 args stdcall
  (func $handle_CreateEventW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_create_event (local.get $arg1) (local.get $arg2)))
    (call $host_log_i32 (global.get $eax))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 527: WaitForMultipleObjects — STUB: unimplemented
  (func $handle_WaitForMultipleObjects (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 528: GlobalAddAtomW — STUB: unimplemented
  (func $handle_GlobalAddAtomW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 529: FindResourceW — same as FindResourceA (resource IDs are integer MAKEINTRESOURCE values)
  (func $handle_FindResourceW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (global.get $rsrc_rva))
    (then (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (global.set $eax (call $find_resource (local.get $arg2) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 530: GlobalGetAtomNameW — STUB: unimplemented
  (func $handle_GlobalGetAtomNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 531: GetProfileIntW — STUB: unimplemented
  (func $handle_GetProfileIntW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 532: VirtualProtect — STUB: unimplemented
  (func $handle_VirtualProtect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 533: FindResourceExW — STUB: unimplemented
  (func $handle_FindResourceExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 534: SizeofResource — STUB: unimplemented
  (func $handle_SizeofResource (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 535: GetProcessVersion — 1 arg stdcall, return winver
  (func $handle_GetProcessVersion (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $winver))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 536: GlobalFlags — STUB: unimplemented
  (func $handle_GlobalFlags (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 537: GetDiskFreeSpaceW — STUB: unimplemented
  (func $handle_GetDiskFreeSpaceW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 538: SearchPathW — STUB: unimplemented
  (func $handle_SearchPathW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 539: SetThreadPriority — STUB: unimplemented
  (func $handle_SetThreadPriority (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 540: SuspendThread — STUB: unimplemented
  (func $handle_SuspendThread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 541: GetPrivateProfileIntW — STUB: unimplemented
  (func $handle_GetPrivateProfileIntW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetPrivateProfileIntW(appName, keyName, nDefault, fileName) — 4 args stdcall
    (global.set $eax (call $host_ini_get_int
      (call $g2w (local.get $arg0))
      (call $g2w (local.get $arg1))
      (local.get $arg2)
      (call $g2w (local.get $arg3))
      (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 542: GetPrivateProfileStringW — STUB: unimplemented
  (func $handle_GetPrivateProfileStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetPrivateProfileStringW(appName, keyName, default, retBuf, nSize, fileName) — 6 args stdcall
    (local $wa_esp i32) (local $fileName i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $fileName (i32.load (i32.add (local.get $wa_esp) (i32.const 24))))
    (global.set $eax (call $host_ini_get_string
      (if (result i32) (local.get $arg0) (then (call $g2w (local.get $arg0))) (else (i32.const 0)))
      (if (result i32) (local.get $arg1) (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (if (result i32) (local.get $arg2) (then (call $g2w (local.get $arg2))) (else (i32.const 0)))
      (local.get $arg3)
      (local.get $arg4)
      (call $g2w (local.get $fileName))
      (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 543: WritePrivateProfileStringW(appName, keyName, string, fileName) — 4 args stdcall
  (func $handle_WritePrivateProfileStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_ini_write_string
      (call $g2w (local.get $arg0))
      (if (result i32) (local.get $arg1) (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (if (result i32) (local.get $arg2) (then (call $g2w (local.get $arg2))) (else (i32.const 0)))
      (call $g2w (local.get $arg3))
      (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 544: CopyFileW — STUB: unimplemented
  (func $handle_CopyFileW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CopyFileW(lpExistingFileName, lpNewFileName, bFailIfExists) — 3 args
    (global.set $eax (call $host_fs_copy_file
      (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (local.get $arg2) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 545: GetSystemDirectoryA(lpBuffer, uSize) — 2 args stdcall
  (func $handle_GetSystemDirectoryA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32)
    (local.set $dst (call $g2w (local.get $arg0)))
    ;; Write "C:\WINDOWS\SYSTEM" (18 chars including null)
    (i32.store (local.get $dst) (i32.const 0x575c3a43))          ;; C:\W
    (i32.store (i32.add (local.get $dst) (i32.const 4)) (i32.const 0x4f444e49))   ;; INDO
    (i32.store (i32.add (local.get $dst) (i32.const 8)) (i32.const 0x535c5357))   ;; WS\S
    (i32.store (i32.add (local.get $dst) (i32.const 12)) (i32.const 0x45545359))  ;; YSTE
    (i32.store16 (i32.add (local.get $dst) (i32.const 16)) (i32.const 0x004d))    ;; M\0
    (global.set $eax (i32.const 17))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 546: GetVolumeInformationW — STUB: unimplemented
  (func $handle_GetVolumeInformationW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 547: OutputDebugStringW — STUB: unimplemented
  (func $handle_OutputDebugStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 548: IsBadStringPtrA — STUB: unimplemented
  (func $handle_IsBadStringPtrA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 549: IsBadStringPtrW — STUB: unimplemented
  (func $handle_IsBadStringPtrW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 550: GlobalDeleteAtom — STUB: unimplemented
  (func $handle_GlobalDeleteAtom (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 551: GlobalFindAtomW — STUB: unimplemented
  (func $handle_GlobalFindAtomW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 552: CreateMetaFileW — STUB: unimplemented
  (func $handle_CreateMetaFileW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 553: CopyMetaFileW — STUB: unimplemented
  (func $handle_CopyMetaFileW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 554: DPtoLP — STUB: unimplemented
  (func $handle_DPtoLP (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 555: CombineRgn — STUB: unimplemented
  (func $handle_CombineRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 556: SetRectRgn — STUB: unimplemented
  (func $handle_SetRectRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 557: GetMapMode — STUB: unimplemented
  (func $handle_GetMapMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 558: CreateDIBPatternBrushPt — STUB: unimplemented
  (func $handle_CreateDIBPatternBrushPt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 559: CreateHatchBrush — STUB: unimplemented
  (func $handle_CreateHatchBrush (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 560: ExtCreatePen — STUB: unimplemented
  (func $handle_ExtCreatePen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 561: EnumMetaFile — STUB: unimplemented
  (func $handle_EnumMetaFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 562: GetObjectType — STUB: unimplemented
  (func $handle_GetObjectType (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 563: PlayMetaFileRecord — STUB: unimplemented
  (func $handle_PlayMetaFileRecord (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 564: ExtSelectClipRgn — STUB: unimplemented
  (func $handle_ExtSelectClipRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 565: SelectClipPath — STUB: unimplemented
  (func $handle_SelectClipPath (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 566: CreateRectRgn — STUB: unimplemented
  (func $handle_CreateRectRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 567: GetClipRgn — STUB: unimplemented
  (func $handle_GetClipRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 568: PolyBezierTo — STUB: unimplemented
  (func $handle_PolyBezierTo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 569: SetColorAdjustment — STUB: unimplemented
  (func $handle_SetColorAdjustment (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 570: PolylineTo — STUB: unimplemented
  (func $handle_PolylineTo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 571: PolyDraw — STUB: unimplemented
  (func $handle_PolyDraw (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 572: SetArcDirection — STUB: unimplemented
  (func $handle_SetArcDirection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 573: ArcTo — STUB: unimplemented
  (func $handle_ArcTo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 574: SetMapperFlags — STUB: unimplemented
  (func $handle_SetMapperFlags (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 575: SetTextCharacterExtra — STUB: unimplemented
  (func $handle_SetTextCharacterExtra (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 576: SetTextJustification — STUB: unimplemented
  (func $handle_SetTextJustification (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 577: OffsetClipRgn — STUB: unimplemented
  (func $handle_OffsetClipRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 578: ExcludeClipRect — STUB: unimplemented
  (func $handle_ExcludeClipRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 579: SelectClipRgn — STUB: unimplemented
  (func $handle_SelectClipRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 580: OffsetWindowOrgEx — STUB: unimplemented
  (func $handle_OffsetWindowOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 581: SetPolyFillMode — STUB: unimplemented
  (func $handle_SetPolyFillMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 582: StartDocW — STUB: unimplemented
  (func $handle_StartDocW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 583: CloseMetaFile — STUB: unimplemented
  (func $handle_CloseMetaFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 584: DeleteMetaFile — STUB: unimplemented
  (func $handle_DeleteMetaFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 585: IntersectClipRect — STUB: unimplemented
  (func $handle_IntersectClipRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 586: GetWindowOrgEx — STUB: unimplemented
  (func $handle_GetWindowOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 587: SetWindowOrgEx — STUB: unimplemented
  (func $handle_SetWindowOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 588: GetCurrentPositionEx — STUB: unimplemented
  (func $handle_GetCurrentPositionEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 589: ScaleWindowExtEx — STUB: unimplemented
  (func $handle_ScaleWindowExtEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 590: ScaleViewportExtEx — STUB: unimplemented
  (func $handle_ScaleViewportExtEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 591: OffsetViewportOrgEx — STUB: unimplemented
  (func $handle_OffsetViewportOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 592: SetViewportOrgEx — STUB: unimplemented
  (func $handle_SetViewportOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 593: GetViewportExtEx — STUB: unimplemented
  (func $handle_GetViewportExtEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 594: GetROP2 — STUB: unimplemented
  (func $handle_GetROP2 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 595: GetWindowExtEx — STUB: unimplemented
  (func $handle_GetWindowExtEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 596: GetTextAlign — STUB: unimplemented
  (func $handle_GetTextAlign (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 597: GetPolyFillMode — STUB: unimplemented
  (func $handle_GetPolyFillMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 598: GetBkMode — STUB: unimplemented
  (func $handle_GetBkMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 599: GetTextColor — STUB: unimplemented
  (func $handle_GetTextColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 600: GetStretchBltMode — STUB: unimplemented
  (func $handle_GetStretchBltMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 601: GetBkColor — STUB: unimplemented
  (func $handle_GetBkColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 602: CreateFontW — STUB: unimplemented
  (func $handle_CreateFontW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 603: GetCharWidthW — STUB: unimplemented
  (func $handle_GetCharWidthW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 604: GetTextExtentPoint32W — STUB: unimplemented
  (func $handle_GetTextExtentPoint32W (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 605: GetClipBox — STUB: unimplemented
  (func $handle_GetClipBox (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 606: GetTextFaceW — STUB: unimplemented
  (func $handle_GetTextFaceW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 607: MsgWaitForMultipleObjects — STUB: unimplemented
  (func $handle_MsgWaitForMultipleObjects (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 608: GetWindowPlacement — STUB: unimplemented
  (func $handle_GetWindowPlacement (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 609: RegisterWindowMessageW — STUB: unimplemented
  (func $handle_RegisterWindowMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 610: GetForegroundWindow — STUB: unimplemented
  (func $handle_GetForegroundWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 611: GetMessagePos — STUB: unimplemented
  (func $handle_GetMessagePos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 612: GetMessageTime — STUB: unimplemented
  (func $handle_GetMessageTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 613: RemovePropW — STUB: unimplemented
  (func $handle_RemovePropW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 614: CallWindowProcW — STUB: unimplemented
  (func $handle_CallWindowProcW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 615: GetPropW — STUB: unimplemented
  (func $handle_GetPropW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 616: SetPropW — STUB: unimplemented
  (func $handle_SetPropW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 617: GetWindowTextLengthW — STUB: unimplemented
  (func $handle_GetWindowTextLengthW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 618: SetWindowPlacement — STUB: unimplemented
  (func $handle_SetWindowPlacement (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 619: TrackPopupMenu — STUB: unimplemented
  (func $handle_TrackPopupMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 620: GetMenuItemID — STUB: unimplemented
  (func $handle_GetMenuItemID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 621: GetMenuItemCount — STUB: unimplemented
  (func $handle_GetMenuItemCount (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 622: GetTopWindow(hWnd) — 1 arg stdcall, return NULL
  (func $handle_GetTopWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 623: SetScrollPos — STUB: unimplemented
  (func $handle_SetScrollPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 624: GetScrollPos — STUB: unimplemented
  (func $handle_GetScrollPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 625: SetScrollRange — STUB: unimplemented
  (func $handle_SetScrollRange (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 626: GetScrollRange — STUB: unimplemented
  (func $handle_GetScrollRange (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 627: ShowScrollBar — STUB: unimplemented
  (func $handle_ShowScrollBar (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 628: SetScrollInfo — STUB: unimplemented
  (func $handle_SetScrollInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 629: GetScrollInfo — STUB: unimplemented
  (func $handle_GetScrollInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 630: ScrollWindow(hWnd, XAmount, YAmount, lpRect, lpClipRect) — STUB: unimplemented
  (func $handle_ScrollWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 631: EndDeferWindowPos — STUB: unimplemented
  (func $handle_EndDeferWindowPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 632: BeginDeferWindowPos — STUB: unimplemented
  (func $handle_BeginDeferWindowPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 633: DeferWindowPos — STUB: unimplemented
  (func $handle_DeferWindowPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 634: AdjustWindowRectEx — STUB: unimplemented
  (func $handle_AdjustWindowRectEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 635: DispatchMessageW — same as DispatchMessageA (delegates to shared dispatch logic)
  (func $handle_DispatchMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $wndproc i32)
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
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $tick_count))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $gl32 (i32.add (local.get $arg0) (i32.const 8))))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0x0113))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $gl32 (local.get $arg0)))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $tmp))
    (global.set $eip (call $gl32 (i32.add (local.get $arg0) (i32.const 12))))
    (global.set $steps (i32.const 0))
    (return)))
    ;; Look up wndproc from window table
    (local.set $wndproc (call $wnd_table_get (call $gl32 (local.get $arg0))))
    ;; WAT-native WndProc dispatch
    (if (i32.ge_u (local.get $wndproc) (i32.const 0xFFFF0000))
      (then
        (global.set $eax (call $wat_wndproc_dispatch
          (call $gl32 (local.get $arg0))
          (call $gl32 (i32.add (local.get $arg0) (i32.const 4)))
          (call $gl32 (i32.add (local.get $arg0) (i32.const 8)))
          (call $gl32 (i32.add (local.get $arg0) (i32.const 12)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    ;; Fall back to global wndproc
    (if (i32.eqz (local.get $wndproc))
      (then
        (if (i32.eq (call $gl32 (local.get $arg0)) (global.get $main_hwnd))
          (then (local.set $wndproc (global.get $wndproc_addr)))
          (else (if (global.get $wndproc_addr2)
            (then (local.set $wndproc (global.get $wndproc_addr2)))
            (else (local.set $wndproc (global.get $wndproc_addr))))))))
    (if (i32.or (i32.eqz (local.get $wndproc)) (i32.eqz (local.get $arg0)))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (local.set $tmp (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $gl32 (i32.add (local.get $arg0) (i32.const 12))))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $gl32 (i32.add (local.get $arg0) (i32.const 8))))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $gl32 (local.get $arg0)))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $tmp))
    (global.set $eip (local.get $wndproc))
    (global.set $steps (i32.const 0))
    (return)
  )

  ;; 636: PeekMessageW — same as PeekMessageA
  (func $handle_PeekMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $packed i32) (local $msg i32) (local $tmp i32)
    ;; Check posted message queue
    (if (i32.gt_u (global.get $post_queue_count) (i32.const 0))
      (then
        ;; Dequeue into lpMsg
        (call $gs32 (local.get $arg0) (i32.load (i32.const 0x400)))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.load (i32.const 0x404)))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (i32.load (i32.const 0x408)))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (i32.load (i32.const 0x40C)))
        ;; If PM_REMOVE (arg4 & 1), shift queue
        (if (i32.and (local.get $arg4) (i32.const 1))
          (then
            (global.set $post_queue_count (i32.sub (global.get $post_queue_count) (i32.const 1)))
            (if (i32.gt_u (global.get $post_queue_count) (i32.const 0))
              (then (call $memcpy (i32.const 0x400) (i32.const 0x410)
                (i32.mul (global.get $post_queue_count) (i32.const 16)))))
          )
        )
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)
      )
    )
    ;; Poll host for input events
    (local.set $packed (call $host_check_input))
    (if (i32.ne (local.get $packed) (i32.const 0))
      (then
        (local.set $msg (i32.and (local.get $packed) (i32.const 0xFFFF)))
        ;; Check message filter range (0,0 = accept all)
        (if (i32.or (i32.and (i32.eqz (local.get $arg2)) (i32.eqz (local.get $arg3)))
              (i32.and (i32.ge_u (local.get $msg) (local.get $arg2))
                       (i32.le_u (local.get $msg) (local.get $arg3))))
          (then
            (local.set $tmp (call $host_check_input_hwnd))
            (if (i32.eqz (local.get $tmp))
              (then (local.set $tmp (global.get $main_hwnd))))
            (call $gs32 (local.get $arg0) (local.get $tmp))
            (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (local.get $msg))
            (call $gs32 (i32.add (local.get $arg0) (i32.const 8))
              (i32.shr_u (local.get $packed) (i32.const 16)))
            (call $gs32 (i32.add (local.get $arg0) (i32.const 12))
              (call $host_check_input_lparam))
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
            (return)
          )
        )
      )
    )
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 637: SendDlgItemMessageW — STUB: unimplemented
  (func $handle_SendDlgItemMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 638: LoadAcceleratorsW — same as A: set haccel and return fake handle
  (func $handle_LoadAcceleratorsW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $haccel (i32.const 0x60001))
    (global.set $eax (i32.const 0x60001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 639: TranslateAcceleratorW — return 0, 3 args stdcall
  (func $handle_TranslateAcceleratorW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 640: IsWindowEnabled — STUB: unimplemented
  (func $handle_IsWindowEnabled (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 641: GetDesktopWindow — STUB: unimplemented
  (func $handle_GetDesktopWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetDesktopWindow() → HWND of desktop window. No args (0 params on stack, but ret addr is there)
    (global.set $eax (i32.const 0x10000))  ;; return a fixed desktop HWND
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; 642: GetActiveWindow — return main window handle
  (func $handle_GetActiveWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $main_hwnd))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; 643: ReuseDDElParam — STUB: unimplemented
  (func $handle_ReuseDDElParam (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 644: UnpackDDElParam — STUB: unimplemented
  (func $handle_UnpackDDElParam (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 645: WaitMessage — STUB: unimplemented
  (func $handle_WaitMessage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 646: GetWindowThreadProcessId — STUB: unimplemented
  (func $handle_GetWindowThreadProcessId (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 647: GetMessageW — same as GetMessageA
  (func $handle_GetMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $msg_ptr i32) (local $packed i32)
    (local.set $msg_ptr (local.get $arg0))
    ;; If quit flag set, return 0 (WM_QUIT)
    (if (global.get $quit_flag)
    (then
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0012))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Deliver pending WM_CREATE before anything else
    (if (global.get $pending_wm_create)
    (then
    (global.set $pending_wm_create (i32.const 0))
    (call $gs32 (i32.const 0x400100) (i32.const 0))
    (call $gs32 (i32.const 0x400110) (global.get $main_win_cy))
    (call $gs32 (i32.const 0x400114) (global.get $main_win_cx))
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0001))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0x400100))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Deliver child WM_CREATE between main WM_CREATE and main WM_SIZE
    (if (global.get $pending_child_create)
    (then
    (local.set $tmp (global.get $pending_child_create))
    (global.set $pending_child_create (i32.const 0))
    (call $gs32 (local.get $msg_ptr) (local.get $tmp))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0001))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Deliver child WM_SIZE after child WM_CREATE
    (if (global.get $pending_child_size)
    (then
    (local.set $packed (global.get $pending_child_size))
    (global.set $pending_child_size (i32.const 0))
    (call $gs32 (local.get $msg_ptr) (global.get $child_paint_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0005))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (local.get $packed))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Deliver pending WM_SIZE after WM_CREATE
    (if (global.get $pending_wm_size)
    (then
    (local.set $packed (global.get $pending_wm_size))
    (global.set $pending_wm_size (i32.const 0))
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0005))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (local.get $packed))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Drain posted message queue first
    (if (i32.gt_u (global.get $post_queue_count) (i32.const 0))
    (then
    (local.set $tmp (i32.const 0x400))
    (call $gs32 (local.get $msg_ptr) (i32.load (local.get $tmp)))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.load (i32.add (local.get $tmp) (i32.const 4))))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.load (i32.add (local.get $tmp) (i32.const 8))))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.load (i32.add (local.get $tmp) (i32.const 12))))
    (global.set $post_queue_count (i32.sub (global.get $post_queue_count) (i32.const 1)))
    (if (i32.gt_u (global.get $post_queue_count) (i32.const 0))
    (then (call $memcpy (i32.const 0x400) (i32.const 0x410)
    (i32.mul (global.get $post_queue_count) (i32.const 16)))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Phase 0: send WM_ACTIVATE first
    (if (i32.eqz (global.get $msg_phase))
    (then
    (global.set $msg_phase (i32.const 1))
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0006))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 1))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (global.get $main_hwnd))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Phase 1: send WM_ERASEBKGND
    (if (i32.eq (global.get $msg_phase) (i32.const 1))
    (then
    (global.set $msg_phase (i32.const 2))
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0014))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.add (global.get $main_hwnd) (i32.const 0x40000)))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Phase 2: send WM_PAINT
    (if (i32.eq (global.get $msg_phase) (i32.const 2))
    (then
    (global.set $msg_phase (i32.const 3))
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x000F))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Poll for input events from the host
    (local.set $packed (call $host_check_input))
    (if (i32.ne (local.get $packed) (i32.const 0))
    (then
    (local.set $tmp (call $host_check_input_hwnd))
    (if (i32.eqz (local.get $tmp))
    (then (local.set $tmp (global.get $main_hwnd))))
    (call $gs32 (local.get $msg_ptr) (local.get $tmp))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4))
    (i32.and (local.get $packed) (i32.const 0xFFFF)))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8))
    (i32.shr_u (local.get $packed) (i32.const 16)))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12))
    (call $host_check_input_lparam))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; No input — deliver WM_PAINT if pending
    (if (global.get $paint_pending)
    (then
    (global.set $paint_pending (i32.const 0))
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x000F))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; No paint — deliver WM_TIMER if timer is active
    (if (global.get $timer_id)
    (then
    (call $gs32 (local.get $msg_ptr) (global.get $timer_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0113))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (global.get $timer_id))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (global.get $timer_callback))
    (global.set $yield_flag (i32.const 1))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; No timer — return WM_NULL
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 648: DefFrameProcW — STUB: unimplemented
  (func $handle_DefFrameProcW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 649: TranslateMDISysAccel — STUB: unimplemented
  (func $handle_TranslateMDISysAccel (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 650: DrawMenuBar — STUB: unimplemented
  (func $handle_DrawMenuBar (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; DrawMenuBar(hwnd) → BOOL. Redraws menu bar — host renderer handles menus, just return TRUE
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 651: DefMDIChildProcW — STUB: unimplemented
  (func $handle_DefMDIChildProcW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 652: InvertRect — STUB: unimplemented
  (func $handle_InvertRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 653: IsZoomed — STUB: unimplemented
  (func $handle_IsZoomed (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 654: SetParent — STUB: unimplemented
  (func $handle_SetParent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 655: AppendMenuW — STUB: unimplemented
  (func $handle_AppendMenuW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 656: DeleteMenu — STUB: unimplemented
  (func $handle_DeleteMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 657: GetDCEx — STUB: unimplemented
  (func $handle_GetDCEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 658: LockWindowUpdate — STUB: unimplemented
  (func $handle_LockWindowUpdate (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 659: GetTabbedTextExtentA — STUB: unimplemented
  (func $handle_GetTabbedTextExtentA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 660: CreateDialogIndirectParamW — STUB: unimplemented
  (func $handle_CreateDialogIndirectParamW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 661: GetNextDlgTabItem — STUB: unimplemented
  (func $handle_GetNextDlgTabItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 662: GetAsyncKeyState — STUB: unimplemented
  (func $handle_GetAsyncKeyState (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 663: MapDialogRect — STUB: unimplemented
  (func $handle_MapDialogRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 664: GetDialogBaseUnits — STUB: unimplemented
  (func $handle_GetDialogBaseUnits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 665: GetClassNameW — STUB: unimplemented
  (func $handle_GetClassNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 666: GetDlgItemInt(hDlg, nIDDlgItem, lpTranslated, bSigned) — stub, return 0
  (func $handle_GetDlgItemInt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Set lpTranslated to FALSE if non-null
    (if (local.get $arg2)
      (then (call $gs32 (local.get $arg2) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; stdcall, 4 args
  )

  ;; 667: GetDlgItemTextW — write null terminator (UTF-16) and return 0, 4 args stdcall
  (func $handle_GetDlgItemTextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.gt_u (local.get $arg3) (i32.const 0))
    (then (i32.store16 (call $g2w (local.get $arg2)) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 668: SetDlgItemTextW — return 1, 3 args stdcall
  (func $handle_SetDlgItemTextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 669: IsDlgButtonChecked — STUB: unimplemented
  (func $handle_IsDlgButtonChecked (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 670: ScrollWindowEx — STUB: unimplemented
  (func $handle_ScrollWindowEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 671: IsDialogMessageW — STUB: unimplemented
  (func $handle_IsDialogMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 672: SetMenuItemBitmaps — STUB: unimplemented
  (func $handle_SetMenuItemBitmaps (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 673: ModifyMenuW — STUB: unimplemented
  (func $handle_ModifyMenuW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 674: GetMenuState — STUB: unimplemented
  (func $handle_GetMenuState (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 735: GetMenuItemRect(hWnd, hMenu, uItem, lprcItem) -> BOOL
  (func $handle_GetMenuItemRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $rect_wasm i32)
    ;; arg0=hWnd, arg1=hMenu, arg2=uItem, arg3=lprcItem
    (local.set $rect_wasm (call $g2w (local.get $arg3)))
    ;; Fill RECT with reasonable defaults per menu item
    (i32.store (local.get $rect_wasm)
      (i32.mul (local.get $arg2) (i32.const 100))) ;; left
    (i32.store (i32.add (local.get $rect_wasm) (i32.const 4))
      (i32.const 0)) ;; top
    (i32.store (i32.add (local.get $rect_wasm) (i32.const 8))
      (i32.add (i32.mul (local.get $arg2) (i32.const 100)) (i32.const 100))) ;; right
    (i32.store (i32.add (local.get $rect_wasm) (i32.const 12))
      (i32.const 20)) ;; bottom
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) ;; stdcall 4 params + ret
  )

  ;; GetLayout(hdc) -> DWORD — return 0 (LTR layout)
  (func $handle_GetLayout (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) ;; stdcall 1 param + ret
  )

  ;; SetLayout(hdc, dwLayout) -> DWORD — return previous layout (0)
  (func $handle_SetLayout (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) ;; stdcall 2 params + ret
  )

  ;; 675: GetMenuCheckMarkDimensions — STUB: unimplemented
  (func $handle_GetMenuCheckMarkDimensions (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 676: SetCursorPos — STUB: unimplemented
  (func $handle_SetCursorPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 677: DestroyCursor — STUB: unimplemented
  (func $handle_DestroyCursor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 678: FindWindowW — STUB: unimplemented
  (func $handle_FindWindowW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 679: GetTabbedTextExtentW — STUB: unimplemented
  (func $handle_GetTabbedTextExtentW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 680: UnregisterClassW — STUB: unimplemented
  (func $handle_UnregisterClassW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 681: ShowOwnedPopups — STUB: unimplemented
  (func $handle_ShowOwnedPopups (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 682: InsertMenuW — STUB: unimplemented
  (func $handle_InsertMenuW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 683: GetMenuStringW — STUB: unimplemented
  (func $handle_GetMenuStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 684: CopyAcceleratorTableW — STUB: unimplemented
  (func $handle_CopyAcceleratorTableW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 685: InSendMessage — STUB: unimplemented
  (func $handle_InSendMessage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 686: PostThreadMessageW — STUB: unimplemented
  (func $handle_PostThreadMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 687: CreateMenu — STUB: unimplemented
  (func $handle_CreateMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 688: WindowFromDC — STUB: unimplemented
  (func $handle_WindowFromDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 689: CountClipboardFormats — STUB: unimplemented
  (func $handle_CountClipboardFormats (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 690: SetWindowContextHelpId — STUB: unimplemented
  (func $handle_SetWindowContextHelpId (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 691: GetNextDlgGroupItem — STUB: unimplemented
  (func $handle_GetNextDlgGroupItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 692: ClipCursor — STUB: unimplemented
  (func $handle_ClipCursor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 693: EnumChildWindows — STUB: unimplemented
  (func $handle_EnumChildWindows (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 694: InvalidateRgn — STUB: unimplemented
  (func $handle_InvalidateRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 695: LoadStringW — load string resource (same as A for now)
  (func $handle_LoadStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_load_string
      (local.get $arg1)                ;; string ID
      (call $g2w (local.get $arg2))    ;; buffer (WASM ptr)
      (local.get $arg3)))              ;; max chars
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 696: CharUpperW — STUB: unimplemented
  (func $handle_CharUpperW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 697: ??1type_info@@UAE@XZ — soft-stub — STUB: unimplemented
  (func $handle_??1type_info@@UAE@XZ (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 698: ?terminate@@YAXXZ — soft-stub — STUB: unimplemented
  (func $handle_?terminate@@YAXXZ (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
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

  ;; 700: IsProcessorFeaturePresent — return TRUE (1 arg stdcall) — STUB: unimplemented
  (func $handle_IsProcessorFeaturePresent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 701: CoRegisterMessageFilter(lpMsgFilter, lplpMsgFilter) — 2 args stdcall
  (func $handle_CoRegisterMessageFilter (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Write NULL to *lplpMsgFilter if non-null
    (if (local.get $arg1)
      (then (call $gs32 (local.get $arg1) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 716: _EH_prolog — MSVCRT SEH frame setup (special calling convention)
  ;; On entry: EAX = exception handler address, [ESP] = return address
  ;; Builds SEH frame: push -1 (trylevel), push handler (EAX), push old fs:[0],
  ;; set fs:[0] = ESP, save old EBP, set EBP to frame, return to caller.
  (func $handle__EH_prolog (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret_addr i32)
    (local $old_seh i32)
    ;; [ESP] = return address (from the call instruction)
    (local.set $ret_addr (call $gl32 (global.get $esp)))
    ;; Push -1 (initial trylevel)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0xFFFFFFFF))
    ;; Push EAX (exception handler)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $eax))
    ;; Push old fs:[0] (previous SEH head)
    (local.set $old_seh (call $gl32 (global.get $fs_base)))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $old_seh))
    ;; Set fs:[0] = ESP (install new SEH frame)
    (call $gs32 (global.get $fs_base) (global.get $esp))
    ;; Save EBP where the return address was: [ESP+12] = EBP
    (call $gs32 (i32.add (global.get $esp) (i32.const 12)) (global.get $ebp))
    ;; LEA EBP, [ESP+12] — EBP points to saved EBP
    (global.set $ebp (i32.add (global.get $esp) (i32.const 12)))
    ;; Set EIP to return address
    (global.set $eip (local.get $ret_addr))
  )

  ;; _mbschr(str, ch) — cdecl, find first occurrence of byte in string
  (func $handle__mbschr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $ch i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (local.set $ch (i32.and (local.get $arg1) (i32.const 0xFF)))
    (block $d (loop $l
      (if (i32.eq (i32.load8_u (local.get $wa)) (local.get $ch))
        (then
          (global.set $eax (i32.add (i32.sub (local.get $wa) (i32.const 0x12000)) (global.get $image_base)))
          (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
          (return)))
      (br_if $d (i32.eqz (i32.load8_u (local.get $wa))))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1)))
      (br $l)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 720: _mbsrchr(str, ch) — cdecl, find last occurrence of byte in string
  (func $handle__mbsrchr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $last i32) (local $ch i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (local.set $last (i32.const 0))
    (local.set $ch (i32.and (local.get $arg1) (i32.const 0xFF)))
    (block $d (loop $l
      (if (i32.eq (i32.load8_u (local.get $wa)) (local.get $ch))
        (then (local.set $last (local.get $wa))))
      (br_if $d (i32.eqz (i32.load8_u (local.get $wa))))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1)))
      (br $l)))
    ;; Convert WASM addr back to guest addr, or 0 if not found
    (if (local.get $last)
      (then (global.set $eax (i32.add (i32.sub (local.get $last) (i32.const 0x12000)) (global.get $image_base))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 781: _mbsnbcmp(s1, s2, n) — cdecl, compare n bytes (ASCII memcmp)
  (func $handle__mbsnbcmp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa1 i32) (local $wa2 i32) (local $n i32) (local $b1 i32) (local $b2 i32)
    (local.set $wa1 (call $g2w (local.get $arg0)))
    (local.set $wa2 (call $g2w (local.get $arg1)))
    (local.set $n (local.get $arg2))
    (block $done (loop $cmp
      (br_if $done (i32.eqz (local.get $n)))
      (local.set $b1 (i32.load8_u (local.get $wa1)))
      (local.set $b2 (i32.load8_u (local.get $wa2)))
      (if (i32.ne (local.get $b1) (local.get $b2))
        (then
          (global.set $eax (i32.sub (local.get $b1) (local.get $b2)))
          (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
          (return)))
      (local.set $wa1 (i32.add (local.get $wa1) (i32.const 1)))
      (local.set $wa2 (i32.add (local.get $wa2) (i32.const 1)))
      (local.set $n (i32.sub (local.get $n) (i32.const 1)))
      (br $cmp)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 782: GetVolumeInformationA — 8 args stdcall, return TRUE with fake data
  (func $handle_GetVolumeInformationA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa_esp i32)
    ;; lpVolumeNameBuffer = arg1, nVolumeNameSize = arg2
    ;; If lpVolumeNameBuffer non-null, write empty string
    (if (local.get $arg1)
      (then (i32.store8 (call $g2w (local.get $arg1)) (i32.const 0))))
    ;; lpVolumeSerialNumber = arg3 — write fake serial
    (if (local.get $arg3)
      (then (call $gs32 (local.get $arg3) (i32.const 0x12345678))))
    ;; lpMaximumComponentLength = arg4 — write 255
    (if (local.get $arg4)
      (then (call $gs32 (local.get $arg4) (i32.const 255))))
    ;; lpFileSystemFlags = [esp+24]
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (if (i32.load (i32.add (local.get $wa_esp) (i32.const 24)))
      (then (call $gs32 (i32.load (i32.add (local.get $wa_esp) (i32.const 24))) (i32.const 0x00000003)))) ;; FILE_CASE_PRESERVED_NAMES | FILE_CASE_SENSITIVE_SEARCH
    ;; lpFileSystemNameBuffer = [esp+28], nFileSystemNameSize = [esp+32]
    (if (i32.load (i32.add (local.get $wa_esp) (i32.const 28)))
      (then
        ;; Write "FAT" as filesystem name
        (i32.store (call $g2w (i32.load (i32.add (local.get $wa_esp) (i32.const 28)))) (i32.const 0x00544146))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36))) ;; stdcall 8 args
  )

  ;; 783: SHGetFileInfoA(pszPath, dwFileAttributes, psfi, cbFileInfo, uFlags) — 5 args stdcall
  ;; Return 0 (failure) — no shell file info available
  (func $handle_SHGetFileInfoA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 721: _mbsinc(ptr) — cdecl, advance to next MBCS character (ASCII: ptr+1)
  (func $handle__mbsinc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; For single-byte code pages (CP 1252), just return ptr+1
    ;; TODO: handle lead bytes for DBCS code pages
    (global.set $eax (i32.add (local.get $arg0) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 722: _strdup(str) — cdecl, allocate copy of string
  (func $handle__strdup (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $len i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    ;; strlen
    (local.set $len (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.eqz (i32.load8_u (i32.add (local.get $wa) (local.get $len)))))
      (local.set $len (i32.add (local.get $len) (i32.const 1))) (br $l)))
    (local.set $len (i32.add (local.get $len) (i32.const 1))) ;; include NUL
    (global.set $eax (call $heap_alloc (local.get $len)))
    (memory.copy (call $g2w (global.get $eax)) (local.get $wa) (local.get $len))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 723: _stricmp(s1, s2) — cdecl, case-insensitive compare
  (func $handle__stricmp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa1 i32) (local $wa2 i32) (local $c1 i32) (local $c2 i32)
    (local.set $wa1 (call $g2w (local.get $arg0)))
    (local.set $wa2 (call $g2w (local.get $arg1)))
    (block $d (loop $l
      (local.set $c1 (i32.load8_u (local.get $wa1)))
      (local.set $c2 (i32.load8_u (local.get $wa2)))
      ;; tolower
      (if (i32.and (i32.ge_u (local.get $c1) (i32.const 0x41)) (i32.le_u (local.get $c1) (i32.const 0x5A)))
        (then (local.set $c1 (i32.or (local.get $c1) (i32.const 0x20)))))
      (if (i32.and (i32.ge_u (local.get $c2) (i32.const 0x41)) (i32.le_u (local.get $c2) (i32.const 0x5A)))
        (then (local.set $c2 (i32.or (local.get $c2) (i32.const 0x20)))))
      (br_if $d (i32.ne (local.get $c1) (local.get $c2)))
      (br_if $d (i32.eqz (local.get $c1)))
      (local.set $wa1 (i32.add (local.get $wa1) (i32.const 1)))
      (local.set $wa2 (i32.add (local.get $wa2) (i32.const 1)))
      (br $l)))
    (global.set $eax (i32.sub (local.get $c1) (local.get $c2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 724: strlen(str) — cdecl
  (func $handle_strlen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $len i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (block $d (loop $l
      (br_if $d (i32.eqz (i32.load8_u (i32.add (local.get $wa) (local.get $len)))))
      (local.set $len (i32.add (local.get $len) (i32.const 1))) (br $l)))
    (global.set $eax (local.get $len))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 725: strrchr(str, ch) — cdecl
  (func $handle_strrchr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $last i32) (local $ch i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (local.set $ch (i32.and (local.get $arg1) (i32.const 0xFF)))
    (block $d (loop $l
      (if (i32.eq (i32.load8_u (local.get $wa)) (local.get $ch))
        (then (local.set $last (local.get $wa))))
      (br_if $d (i32.eqz (i32.load8_u (local.get $wa))))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1)))
      (br $l)))
    (if (local.get $last)
      (then (global.set $eax (i32.add (i32.sub (local.get $last) (i32.const 0x12000)) (global.get $image_base))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 726: strcmp(s1, s2) — cdecl
  (func $handle_strcmp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa1 i32) (local $wa2 i32) (local $c1 i32) (local $c2 i32)
    (local.set $wa1 (call $g2w (local.get $arg0)))
    (local.set $wa2 (call $g2w (local.get $arg1)))
    (block $d (loop $l
      (local.set $c1 (i32.load8_u (local.get $wa1)))
      (local.set $c2 (i32.load8_u (local.get $wa2)))
      (br_if $d (i32.ne (local.get $c1) (local.get $c2)))
      (br_if $d (i32.eqz (local.get $c1)))
      (local.set $wa1 (i32.add (local.get $wa1) (i32.const 1)))
      (local.set $wa2 (i32.add (local.get $wa2) (i32.const 1)))
      (br $l)))
    (global.set $eax (i32.sub (local.get $c1) (local.get $c2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 727: strcpy(dest, src) — cdecl
  (func $handle_strcpy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32) (local $src i32) (local $ch i32)
    (local.set $dst (call $g2w (local.get $arg0)))
    (local.set $src (call $g2w (local.get $arg1)))
    (block $d (loop $l
      (local.set $ch (i32.load8_u (local.get $src)))
      (i32.store8 (local.get $dst) (local.get $ch))
      (br_if $d (i32.eqz (local.get $ch)))
      (local.set $dst (i32.add (local.get $dst) (i32.const 1)))
      (local.set $src (i32.add (local.get $src) (i32.const 1)))
      (br $l)))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 728: strncpy(dest, src, count) — cdecl
  (func $handle_strncpy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32) (local $src i32) (local $i i32) (local $ch i32)
    (local.set $dst (call $g2w (local.get $arg0)))
    (local.set $src (call $g2w (local.get $arg1)))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $ch (i32.load8_u (i32.add (local.get $src) (local.get $i))))
      (i32.store8 (i32.add (local.get $dst) (local.get $i)) (local.get $ch))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $l (local.get $ch))
      ;; pad with zeros
      (block $d2 (loop $l2
        (br_if $d2 (i32.ge_u (local.get $i) (local.get $arg2)))
        (i32.store8 (i32.add (local.get $dst) (local.get $i)) (i32.const 0))
        (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l2)))))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 729: strcat(dest, src) — cdecl
  (func $handle_strcat (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32) (local $src i32) (local $ch i32)
    (local.set $dst (call $g2w (local.get $arg0)))
    ;; find end of dest
    (block $d (loop $l
      (br_if $d (i32.eqz (i32.load8_u (local.get $dst))))
      (local.set $dst (i32.add (local.get $dst) (i32.const 1))) (br $l)))
    ;; copy src
    (local.set $src (call $g2w (local.get $arg1)))
    (block $d2 (loop $l2
      (local.set $ch (i32.load8_u (local.get $src)))
      (i32.store8 (local.get $dst) (local.get $ch))
      (br_if $d2 (i32.eqz (local.get $ch)))
      (local.set $dst (i32.add (local.get $dst) (i32.const 1)))
      (local.set $src (i32.add (local.get $src) (i32.const 1)))
      (br $l2)))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 730: atoi(str) — cdecl
  (func $handle_atoi (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $val i32) (local $neg i32) (local $ch i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    ;; skip whitespace
    (block $d (loop $l
      (local.set $ch (i32.load8_u (local.get $wa)))
      (br_if $d (i32.gt_u (local.get $ch) (i32.const 0x20)))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1))) (br $l)))
    ;; sign
    (if (i32.eq (local.get $ch) (i32.const 0x2D)) ;; '-'
      (then (local.set $neg (i32.const 1))
            (local.set $wa (i32.add (local.get $wa) (i32.const 1))))
      (else (if (i32.eq (local.get $ch) (i32.const 0x2B))
        (then (local.set $wa (i32.add (local.get $wa) (i32.const 1)))))))
    ;; digits
    (block $d2 (loop $l2
      (local.set $ch (i32.load8_u (local.get $wa)))
      (br_if $d2 (i32.lt_u (local.get $ch) (i32.const 0x30)))
      (br_if $d2 (i32.gt_u (local.get $ch) (i32.const 0x39)))
      (local.set $val (i32.add (i32.mul (local.get $val) (i32.const 10)) (i32.sub (local.get $ch) (i32.const 0x30))))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1))) (br $l2)))
    (if (local.get $neg) (then (local.set $val (i32.sub (i32.const 0) (local.get $val)))))
    (global.set $eax (local.get $val))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 731: _ftol — cdecl, convert float on FPU stack to i32 (special: no stack args, reads ST(0))
  (func $handle__ftol (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Pop ST(0) and truncate to i32
    (global.set $eax (i32.trunc_f64_s (call $fpu_pop)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 732: sprintf — crash stub (use $wsprintf path for now)
  (func $handle_sprintf (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 733: realloc(ptr, size) — cdecl
  (func $handle_realloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $new_ptr i32) (local $old_size i32)
    ;; realloc(NULL, size) = malloc(size)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (call $heap_alloc (local.get $arg1)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    ;; realloc(ptr, 0) = free(ptr)
    (if (i32.eqz (local.get $arg1))
      (then
        (call $heap_free (local.get $arg0))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (return)))
    ;; Read old block size from header (ptr-4 in guest space)
    (local.set $old_size (call $gl32 (i32.sub (local.get $arg0) (i32.const 4))))
    (local.set $new_ptr (call $heap_alloc (local.get $arg1)))
    ;; Copy min(old_size, new_size) bytes
    (if (i32.gt_u (local.get $old_size) (local.get $arg1))
      (then (local.set $old_size (local.get $arg1))))
    (memory.copy (call $g2w (local.get $new_ptr)) (call $g2w (local.get $arg0)) (local.get $old_size))
    (call $heap_free (local.get $arg0))
    (global.set $eax (local.get $new_ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 734: _strlwr(str) — cdecl, lowercase string in-place
  (func $handle__strlwr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $ch i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (block $d (loop $l
      (local.set $ch (i32.load8_u (local.get $wa)))
      (br_if $d (i32.eqz (local.get $ch)))
      (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x41)) (i32.le_u (local.get $ch) (i32.const 0x5A)))
        (then (i32.store8 (local.get $wa) (i32.or (local.get $ch) (i32.const 0x20)))))
      (local.set $wa (i32.add (local.get $wa) (i32.const 1))) (br $l)))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; fallback: unknown API — crash with full details
  (func $handle_fallback (param $name_ptr i32) (param $api_id i32)
    (call $host_log_i32 (local.get $api_id))
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
    (call $crash_unimplemented (local.get $name)))

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
        ;; lstrcmpA(2) / lstrcmpiA(2) — byte-by-byte comparison
        (global.set $eax (call $guest_stricmp (local.get $a0) (local.get $a1)))
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
  ;; Entertainment Pack about dialog — delegate to ShellAboutA
  (func $handle_AboutWEP (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_shell_about (local.get $arg0) (call $g2w (local.get $arg2))))
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

  ;; 713: OpenFile(lpFileName, lpReOpenBuff, uStyle) — return HFILE_ERROR (-1), file not found
  (func $handle_OpenFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const -1))  ;; HFILE_ERROR
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

  ;; 745: time(timer) — return seconds since epoch (fake: 946684800 = 2000-01-01)
  (func $handle_time (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 946684800))
    (if (local.get $arg0)
      (then (i32.store (call $g2w (local.get $arg0)) (i32.const 946684800))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; cdecl, caller cleans
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

  ;; 747: cdtInit(lpWidth, lpHeight) — init cards, return dimensions 71x96
  (func $handle_cdtInit (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (i32.store (call $g2w (local.get $arg0)) (i32.const 71))
    (i32.store (call $g2w (local.get $arg1)) (i32.const 96))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 748: cdtDraw(hdc, x, y, card, mode, color) — draw a card rectangle
  (func $handle_cdtDraw (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (call $host_gdi_fill_rect (local.get $arg0)
      (local.get $arg1) (local.get $arg2)
      (i32.add (local.get $arg1) (i32.const 71))
      (i32.add (local.get $arg2) (i32.const 96))
      (i32.const 0x00FFFFFF)))
    (drop (call $host_gdi_rectangle (local.get $arg0)
      (local.get $arg1) (local.get $arg2)
      (i32.add (local.get $arg1) (i32.const 71))
      (i32.add (local.get $arg2) (i32.const 96))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; stdcall, 6 args
  )

  ;; 749: cdtDrawExt(hdc, x, y, dx, dy, card, mode, color) — draw card with custom size
  (func $handle_cdtDrawExt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (call $host_gdi_fill_rect (local.get $arg0)
      (local.get $arg1) (local.get $arg2)
      (i32.add (local.get $arg1) (local.get $arg3))
      (i32.add (local.get $arg2) (local.get $arg4))
      (i32.const 0x00FFFFFF)))
    (drop (call $host_gdi_rectangle (local.get $arg0)
      (local.get $arg1) (local.get $arg2)
      (i32.add (local.get $arg1) (local.get $arg3))
      (i32.add (local.get $arg2) (local.get $arg4))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36)))  ;; stdcall, 8 args
  )

  ;; 750: cdtTerm() — cleanup card drawing
  (func $handle_cdtTerm (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; 751: __GetMainArgs(argc, argv, envp) — CRT init, 3-arg variant
  (func $handle___GetMainArgs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $gs32 (local.get $arg0) (i32.const 1))
    (if (i32.eqz (global.get $msvcrt_acmdln_ptr))
    (then
    (global.set $msvcrt_acmdln_ptr (call $heap_alloc (i32.const 32)))
    (i32.store (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 0x00505041)) ;; "APP\0"
    (i32.store (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 8)) (global.get $msvcrt_acmdln_ptr))
    (i32.store (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 12)) (i32.const 0))
    (i32.store (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 16)) (i32.const 0))))
    (call $gs32 (local.get $arg1) (i32.add (global.get $msvcrt_acmdln_ptr) (i32.const 8)))
    (call $gs32 (local.get $arg2) (i32.add (global.get $msvcrt_acmdln_ptr) (i32.const 16)))
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

  ;; 757: waveOutGetNumDevs() — return 1 (one audio device available)
  (func $handle_waveOutGetNumDevs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))  ;; 1 device
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
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (if (i32.eq (local.get $arg1) (i32.const -6))   ;; GWL_HINSTANCE
      (then
        (global.set $eax (global.get $image_base))
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
    (local $hr i32)
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
    ;; Synchronous success or error
    (global.set $eax (local.get $hr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; stdcall, 5 args
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

  ;; CommandLineToArgvW — already handled above as crash stub replacement
